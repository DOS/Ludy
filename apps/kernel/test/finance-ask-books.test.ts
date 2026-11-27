// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181) on the API side, with a fake model and a fake read: the eval set end to end (the question is blanked out before the model reads it, the period is resolved by code, the one read
// of the catalogue is run for it, a poisoned answer shows no card), what is kept between two asks (the coworker's choice and nothing else), every state of `ai`, the resolver of the periods, and that the kernel's
// copy of the catalogue is the agent's. Nothing here needs a database; the permission test on PostgreSQL is finance-ask-books.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiBudgetExhaustedError,
  ASK_BOOKS_CHOICES as AGENT_CHOICES,
  ASK_BOOKS_ENTRIES as AGENT_ENTRIES,
  ASK_BOOKS_PERIODS as AGENT_PERIODS,
  ASK_BOOKS_QUESTION_MAX as AGENT_QUESTION_MAX,
  AskBooksCoworker,
  type AiConfig,
  type AskBooksResult,
} from '@ludy/agent';
import {
  ASK_BOOKS_ALLOWED_KINDS,
  ASK_BOOKS_ENTRIES,
  ASK_BOOKS_QUESTION_MAX,
  ASK_BOOKS_RELATIVE_TOKENS,
  ASK_BOOKS_TOP,
  askBooksPickOptions,
  resolvePickedPeriod,
  resolveRelativePeriod,
  zAskBooksAnswer,
  zFinanceAskBooksInput,
  type AskBooksEntry,
} from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { ASK_BOOKS_FAILED_KEEP_MS, ASK_BOOKS_KEEP_MS, askBooks, askBooksAi, runAskBooksEntry, type AskBooksAi, type AskBooksQuery } from '../src/finance-ask-books.ts';
import { ASK_BOOKS_EVAL_CASES, EVAL_TODAY } from './finance-ask-books-eval-cases.ts';

const STUB_CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'stub-eval-model', maxRetries: 0 };
const ENTITY = '0192f0aa-1111-7222-8333-944445555777';
const ORG = 'org-1';
const OWNER = 'user-owner';
const VIEWER = 'user-viewer';
const today = () => EVAL_TODAY;
const LEAD = 'Đây là báo cáo kết quả kinh doanh của kỳ được chọn.';

// What each entry's read is called, and the key its period goes under.
const READ_OF: Record<AskBooksEntry, string> = {
  profit_loss: 'finance.statements.period',
  cash_balance: 'finance.statements.period',
  receivables_top: 'finance.ledger.period',
  payables_top: 'finance.ledger.period',
  vat_position: 'finance.vat.period',
  stock_value: 'finance.stock.report',
};

// The reads as the screens' own give them, cut to what the card reads.
const READS: Record<string, unknown> = {
  'finance.statements.period': {
    b01: { asOf: '2026-10-31', lines: [{ code: '110', label: 'Cash', amount: '5000000', total: false }], unmapped: [], balanced: true },
    b02: {
      from: '2026-10-01',
      to: '2026-10-31',
      lines: [
        { code: '10', label: 'Net revenue', amount: '100000000', total: false },
        { code: '11', label: 'Cost of goods sold', amount: '60000000', total: false },
        { code: '50', label: 'Profit before tax', amount: '30000000', total: true },
        { code: '60', label: 'Profit after tax', amount: '24000000', total: true },
      ],
      unmapped: [],
    },
  },
  'finance.ledger.period': {
    receivables: {
      accountCode: '131',
      rows: [
        { partyId: 'p1', partyName: 'Công ty A', closing: '30000000' },
        { partyId: 'p2', partyName: 'Công ty B', closing: '10000000' },
        { partyId: null, partyName: null, closing: '5000000' },
        { partyId: 'p4', partyName: 'Khách trả trước', closing: '-2000000' },
        { partyId: 'p5', partyName: 'Công ty Z', closing: '0' },
        { partyId: 'p6', partyName: 'Công ty C', closing: '4000000' },
        { partyId: 'p7', partyName: 'Công ty D', closing: '3000000' },
        { partyId: 'p8', partyName: 'Công ty E', closing: '2000000' },
      ],
      totals: { opening: '0', increase: '0', decrease: '0', closing: '52000000' },
    },
    payables: {
      accountCode: '331',
      rows: [
        { partyId: 'q1', partyName: 'Nhà cung cấp X', closing: '9000000' },
        { partyId: 'q2', partyName: 'Nhà cung cấp Y', closing: '20000000' },
        { partyId: 'q3', partyName: 'Nhà cung cấp Z', closing: '-3000000' },
      ],
      totals: { opening: '0', increase: '0', decrease: '0', closing: '26000000' },
    },
  },
  'finance.vat.period': {
    output: { available: true, totals: { vat: '12000000' } },
    input: { available: true, totals: { vat: '8000000' } },
    carryForward: { amount: '1000000' },
  },
  'finance.stock.report': [
    { closingValue: '1000000.5', closed: true },
    { closingValue: '2500000', closed: false },
  ],
};

type Call = { name: string; input: Record<string, unknown> };
function fakeQuery(calls: Call[], reads: Record<string, unknown> = READS): AskBooksQuery {
  return async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    calls.push({ name, input });
    return reads[name] as T;
  };
}

type ChoiceResult = Extract<AskBooksResult, { kind: 'choice' }>;
const choice = (entry: ChoiceResult['entry'], period: ChoiceResult['period'], lead: string | null = null): AskBooksResult => ({ kind: 'choice', entry, period, lead, leadCode: null });

function readerOf(answer: (redacted: string) => Promise<AskBooksResult>): { reader: NonNullable<AskBooksAi['reader']>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      askBooksPick: async (redacted: string) => {
        asked.push(redacted);
        return answer(redacted);
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('the catalogue of the kernel is the agent\'s', () => {
  it('has the same entries, the same period words and the same question limit', () => {
    expect([...ASK_BOOKS_ENTRIES]).toEqual([...AGENT_ENTRIES]);
    expect([...AGENT_CHOICES]).toEqual([...ASK_BOOKS_ENTRIES, 'none']);
    expect([...AGENT_PERIODS].sort()).toEqual([...ASK_BOOKS_RELATIVE_TOKENS, 'named', 'none'].sort());
    expect(AGENT_QUESTION_MAX).toBe(ASK_BOOKS_QUESTION_MAX);
  });

  it('gives every entry the kinds of period its read takes, and a read to run', () => {
    for (const entry of ASK_BOOKS_ENTRIES) {
      expect(ASK_BOOKS_ALLOWED_KINDS[entry].length).toBeGreaterThan(0);
      expect(READ_OF[entry]).toMatch(/^finance\./);
    }
    expect(ASK_BOOKS_ALLOWED_KINDS.vat_position).toEqual(['month', 'quarter']);
    expect(ASK_BOOKS_ALLOWED_KINDS.stock_value).toEqual(['month']);
  });
});

describe('the input', () => {
  it('is a question or a pick, never both and never neither, and a question is at most the limit', () => {
    expect(zFinanceAskBooksInput.safeParse({ question: 'Tháng 10 lãi bao nhiêu?' }).success).toBe(true);
    expect(zFinanceAskBooksInput.safeParse({ pick: { entry: 'profit_loss', period: { kind: 'relative', token: 'last_month' } } }).success).toBe(true);
    expect(zFinanceAskBooksInput.safeParse({ question: 'x', pick: { entry: 'profit_loss', period: { kind: 'relative', token: 'last_month' } } }).success).toBe(false);
    expect(zFinanceAskBooksInput.safeParse({}).success).toBe(false);
    expect(zFinanceAskBooksInput.safeParse({ question: 'x'.repeat(ASK_BOOKS_QUESTION_MAX + 1) }).success).toBe(false);
    expect(zFinanceAskBooksInput.safeParse({ pick: { entry: 'payroll', period: { kind: 'relative', token: 'last_month' } } }).success).toBe(false);
    expect(zFinanceAskBooksInput.safeParse({ pick: { entry: 'profit_loss', period: { kind: 'period', value: '2026-13' } } }).success).toBe(false);
  });
});

describe('the eval set', () => {
  it('holds at least 40 questions in both languages, and covers every entry, every period word, the questions out of the catalogue and the injections', () => {
    expect(ASK_BOOKS_EVAL_CASES.length).toBeGreaterThanOrEqual(40);
    expect(ASK_BOOKS_EVAL_CASES.filter((c) => c.language === 'vi').length).toBeGreaterThanOrEqual(15);
    expect(ASK_BOOKS_EVAL_CASES.filter((c) => c.language === 'en').length).toBeGreaterThanOrEqual(15);
    for (const entry of ASK_BOOKS_ENTRIES) expect(ASK_BOOKS_EVAL_CASES.filter((c) => c.entry === entry).length, entry).toBeGreaterThanOrEqual(3);
    for (const period of AGENT_PERIODS) expect(ASK_BOOKS_EVAL_CASES.some((c) => c.period === period), period).toBe(true);
    expect(ASK_BOOKS_EVAL_CASES.filter((c) => c.expect.state === 'none' && c.expect.ai === 'used').length).toBeGreaterThanOrEqual(8);
    expect(ASK_BOOKS_EVAL_CASES.filter((c) => c.poisoned !== undefined).length).toBeGreaterThanOrEqual(6);
    expect(new Set(ASK_BOOKS_EVAL_CASES.map((c) => c.id)).size).toBe(ASK_BOOKS_EVAL_CASES.length);
  });

  it.each(ASK_BOOKS_EVAL_CASES.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prompts: string[] = [];
    const coworker = new AskBooksCoworker(STUB_CONFIG, async ({ prompt }) => {
      prompts.push(prompt);
      return { output: c.poisoned ?? { entry: c.entry, period: c.period, lead: c.modelLead ?? '' }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const ai = askBooksAi({ askBooksPick: (redacted, language, onUsage) => coworker.pick(redacted, language, onUsage) }, new DraftBudget());
    const calls: Call[] = [];
    const answer = await askBooks(ai, fakeQuery(calls), ORG, OWNER, { question: c.question, lang: c.language }, () => 1_000, today);

    // Always an answer the contract accepts, whatever the model said.
    expect(zAskBooksAnswer.safeParse(answer).success).toBe(true);
    expect(answer.state).toBe(c.expect.state);
    expect(answer.ai).toBe(c.expect.ai);
    // The model read the question with every number and period blanked out, and nothing from the books.
    expect(prompts).toHaveLength(1);
    expect(/\p{N}/u.test(prompts[0] ?? '')).toBe(false);

    if (c.expect.state === 'card') {
      const entry = c.entry as AskBooksEntry;
      expect(answer.card?.entry).toBe(entry);
      expect(answer.card?.period.value).toBe(c.expect.period);
      expect(answer.card?.period.partial).toBe(c.expect.partial ?? false);
      // The one read of the catalogue, for the period code resolved, and nothing else.
      expect(calls).toEqual([{ name: READ_OF[entry], input: entry === 'stock_value' ? { month: c.expect.period } : { period: c.expect.period } }]);
      expect(answer.pick).toBeNull();
    } else {
      expect(calls).toEqual([]);
      expect(answer.card).toBeNull();
    }
    if (c.expect.state === 'pick_period') {
      expect(answer.pick?.entry).toBe(c.entry);
      expect(answer.pick?.options.length).toBeGreaterThan(0);
    }
    if (c.expect.lead === 'shown') expect(answer.lead).toBe(c.modelLead);
    else expect(answer.lead).toBeNull();
  });
});

describe('the card of each entry', () => {
  const relative = () => resolveRelativePeriod('last_month', today());

  it('profit_loss reads the same four line codes from a statement under the TT99 map, where they keep their meaning (#5187)', async () => {
    // TT99's B02 renumbers financial revenue (22), financial expense (23) and administration (26), but not 10, 11, 50 and 60, the only codes the card reads.
    const tt99 = {
      ...READS,
      'finance.statements.period': {
        ...(READS['finance.statements.period'] as object),
        regime: 'tt99',
        b02: {
          from: '2026-10-01',
          to: '2026-10-31',
          lines: [
            { code: '10', label: 'Net revenue', amount: '90000000', total: false },
            { code: '11', label: 'Cost of goods sold', amount: '50000000', total: false },
            { code: '22', label: 'Financial revenue', amount: '1000000', total: false },
            { code: '50', label: 'Profit before tax', amount: '26000000', total: true },
            { code: '60', label: 'Profit after tax', amount: '20800000', total: true },
          ],
          unmapped: [],
        },
      },
    };
    const card = await runAskBooksEntry(fakeQuery([], tt99), 'profit_loss', relative(), undefined);
    expect(card.figures).toEqual([
      { key: 'revenue', amount: '90000000' },
      { key: 'cost_of_goods', amount: '50000000' },
      { key: 'profit_before_tax', amount: '26000000' },
      { key: 'profit_after_tax', amount: '20800000' },
    ]);
  });

  it('profit_loss shows the four lines of the statement and cash_balance the cash line, as decimal strings', async () => {
    const calls: Call[] = [];
    const profit = await runAskBooksEntry(fakeQuery(calls), 'profit_loss', relative(), undefined);
    expect(profit.figures).toEqual([
      { key: 'revenue', amount: '100000000' },
      { key: 'cost_of_goods', amount: '60000000' },
      { key: 'profit_before_tax', amount: '30000000' },
      { key: 'profit_after_tax', amount: '24000000' },
    ]);
    const cash = await runAskBooksEntry(fakeQuery(calls), 'cash_balance', relative(), undefined);
    expect(cash.figures).toEqual([{ key: 'cash', amount: '5000000' }]);
  });

  it('receivables_top lists the largest debit balances first, leaves out a nil balance, and shows what customers paid ahead as its own figure, never netted into the total', async () => {
    const card = await runAskBooksEntry(fakeQuery([]), 'receivables_top', relative(), undefined);
    // The total is what is owed (54,000,000), not the net of the 2,000,000 a customer paid ahead.
    expect(card.figures).toEqual([
      { key: 'total', amount: '54000000' },
      { key: 'advances', amount: '2000000' },
    ]);
    expect(card.top).toHaveLength(ASK_BOOKS_TOP);
    expect(card.top.map((row) => row.amount)).toEqual(['30000000', '10000000', '5000000', '4000000', '3000000']);
    expect(card.top[0]?.name).toBe('Công ty A');
    // A balance no party is named on is listed, with no name.
    expect(card.top[2]?.name).toBeNull();
    // Six balances are owed (A, B, the unnamed one, C, D and E); the advance and the nil balance are not.
    expect(card.partyCount).toBe(6);
  });

  it('payables_top reads the 331 side and shows an advance to a supplier as its own figure, never netted', async () => {
    const card = await runAskBooksEntry(fakeQuery([]), 'payables_top', relative(), undefined);
    expect(card.figures).toEqual([
      { key: 'total', amount: '29000000' },
      { key: 'advances', amount: '3000000' },
    ]);
    expect(card.top.map((row) => row.name)).toEqual(['Nhà cung cấp Y', 'Nhà cung cấp X']);
    expect(card.partyCount).toBe(2);
  });

  it('vat_position shows the output, the input, their difference and the carry-forward, and says when the sales side is missing', async () => {
    const card = await runAskBooksEntry(fakeQuery([]), 'vat_position', relative(), undefined);
    expect(card.figures).toEqual([
      { key: 'vat_output', amount: '12000000' },
      { key: 'vat_input', amount: '8000000' },
      { key: 'vat_difference', amount: '4000000' },
      { key: 'vat_carry_forward', amount: '1000000' },
    ]);
    expect(card.notes).toEqual([]);
    const noSales = { ...READS, 'finance.vat.period': { ...(READS['finance.vat.period'] as object), output: { available: false, totals: { vat: '0' } } } };
    expect((await runAskBooksEntry(fakeQuery([], noSales), 'vat_position', relative(), undefined)).notes).toEqual(['sales_side_unavailable']);
  });

  it('stock_value sums the closing values with decimals and says it is provisional while a month is open for an item', async () => {
    const card = await runAskBooksEntry(fakeQuery([]), 'stock_value', relative(), undefined);
    expect(card.figures).toEqual([{ key: 'stock_value', amount: '3500000.5' }]);
    expect(card.notes).toEqual(['provisional']);
    const closed = { ...READS, 'finance.stock.report': [{ closingValue: '1000000', closed: true }] };
    expect((await runAskBooksEntry(fakeQuery([], closed), 'stock_value', relative(), undefined)).notes).toEqual([]);
  });

  it('passes the screen\'s legal entity to the read, and only when there is one', async () => {
    const withEntity: Call[] = [];
    await runAskBooksEntry(fakeQuery(withEntity), 'profit_loss', relative(), ENTITY);
    expect(withEntity[0]?.input).toEqual({ period: '2026-10', legalEntityId: ENTITY });
    const without: Call[] = [];
    await runAskBooksEntry(fakeQuery(without), 'profit_loss', relative(), undefined);
    expect(without[0]?.input).toEqual({ period: '2026-10' });
  });
});

describe('askBooks: what is kept and who is asked', () => {
  const QUESTION = 'Ai còn nợ mình nhiều nhất?';

  it('keeps the coworker\'s choice and nothing else, so the read runs again for whoever asks and a viewer is never given an owner\'s answer', async () => {
    const { reader, asked } = readerOf(async () => choice('receivables_top', 'as_of_today', LEAD));
    const ai = askBooksAi(reader, new DraftBudget());
    const ownerCalls: Call[] = [];
    const owner = await askBooks(ai, fakeQuery(ownerCalls), ORG, OWNER, { question: QUESTION }, () => 1_000, today);
    expect(owner.state).toBe('card');
    expect(owner.lead).toBe(LEAD);
    expect(owner.card?.top[0]?.name).toBe('Công ty A');

    // The viewer asks the same words: the read is run as the viewer, and its refusal is the answer.
    const refusal = new Error('FORBIDDEN');
    const viewerCalls: string[] = [];
    const viewerQuery: AskBooksQuery = async (name) => {
      viewerCalls.push(name);
      throw refusal;
    };
    await expect(askBooks(ai, viewerQuery, ORG, VIEWER, { question: QUESTION }, () => 2_000, today)).rejects.toBe(refusal);
    expect(viewerCalls).toEqual(['finance.ledger.period']);
    // The coworker was asked once: the choice was kept; the figures, the party names and the sentence were not.
    expect(asked).toHaveLength(1);
    const kept = [...ai.kept.values()];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.choice).toEqual({ entry: 'receivables_top', period: 'as_of_today' });
    const serialized = JSON.stringify([...ai.kept.entries()]);
    for (const secret of ['Công ty A', '30000000', LEAD]) expect(serialized).not.toContain(secret);

    // A kept choice has no sentence, and the owner's own read runs again.
    const ownerAgain: Call[] = [];
    const again = await askBooks(ai, fakeQuery(ownerAgain), ORG, OWNER, { question: QUESTION }, () => 3_000, today);
    expect(again.state).toBe('card');
    expect(again.lead).toBeNull();
    expect(ownerAgain).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it('keeps a choice for another month of the same words but resolves that month for itself, and never shares one between orgs or languages', async () => {
    const { reader, asked } = readerOf(async () => choice('profit_loss', 'named'));
    const ai = askBooksAi(reader, new DraftBudget());
    const october = await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Tháng 10 lãi bao nhiêu?' }, () => 1_000, today);
    const september = await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Tháng 9 lãi bao nhiêu?' }, () => 1_000, today);
    expect(october.card?.period.value).toBe('2026-10');
    expect(september.card?.period.value).toBe('2026-09');
    expect(asked).toHaveLength(1);
    await askBooks(ai, fakeQuery([]), 'org-2', OWNER, { question: 'Tháng 10 lãi bao nhiêu?' }, () => 1_000, today);
    await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Tháng 10 lãi bao nhiêu?', lang: 'en' }, () => 1_000, today);
    expect(asked).toHaveLength(3);
  });

  it('keeps a question the catalogue does not answer as such, not as a failure', async () => {
    const { reader, asked } = readerOf(async () => ({ kind: 'choice', entry: 'none', period: 'none', lead: null, leadCode: null }));
    const ai = askBooksAi(reader, new DraftBudget());
    expect((await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Lương tháng này bao nhiêu?' }, () => 1_000, today)).ai).toBe('used');
    expect((await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Lương tháng này bao nhiêu?' }, () => 2_000, today)).ai).toBe('used');
    expect(asked).toHaveLength(1);
  });

  it('takes the month the question names over a relative word of the model, and a list when the question names two', async () => {
    const { reader } = readerOf(async () => choice('profit_loss', 'this_month'));
    const ai = askBooksAi(reader, new DraftBudget());
    const named = await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Tháng 10 lãi bao nhiêu?' }, () => 1_000, today);
    expect(named.card?.period.value).toBe('2026-10');
    const two = await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Lãi tháng 9 và tháng 10 bao nhiêu?' }, () => 1_000, today);
    expect(two.state).toBe('pick_period');
  });

  it('keeps the choice for the set time and asks again after it', async () => {
    const { reader, asked } = readerOf(async () => choice('cash_balance', 'as_of_today'));
    const ai = askBooksAi(reader, new DraftBudget());
    let at = 1_000;
    await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Còn bao nhiêu tiền?' }, () => at, today);
    at += ASK_BOOKS_KEEP_MS - 1;
    await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Còn bao nhiêu tiền?' }, () => at, today);
    expect(asked).toHaveLength(1);
    at += 2;
    await askBooks(ai, fakeQuery([]), ORG, OWNER, { question: 'Còn bao nhiêu tiền?' }, () => at, today);
    expect(asked).toHaveLength(2);
  });
});

describe('askBooks: every state of ai', () => {
  const ask = (ai: AskBooksAi, calls: Call[] = [], question = 'Tháng 10 lãi bao nhiêu?', now: () => number = () => 1_000) => askBooks(ai, fakeQuery(calls), ORG, OWNER, { question }, now, today);

  it('says off with no call and no read when the deployment has no model', async () => {
    const calls: Call[] = [];
    expect(await ask(askBooksAi(null, new DraftBudget()), calls)).toEqual({ ai: 'off', state: 'none', lead: null, card: null, pick: null });
    expect(calls).toEqual([]);
  });

  it('says budget when the org\'s AI budget is spent, and failed when the call fails, trying again sooner than after a refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spent = readerOf(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect((await ask(askBooksAi(spent.reader, new DraftBudget()))).ai).toBe('budget');

    let calls = 0;
    const broken = readerOf(async () => {
      calls += 1;
      throw new Error('down');
    });
    const ai = askBooksAi(broken.reader, new DraftBudget());
    let now = 5_000;
    expect((await ask(ai, [], 'Tháng 10 lãi bao nhiêu?', () => now)).ai).toBe('failed');
    now += ASK_BOOKS_FAILED_KEEP_MS - 1;
    await ask(ai, [], 'Tháng 10 lãi bao nhiêu?', () => now);
    expect(calls).toBe(1);
    now += 2;
    await ask(ai, [], 'Tháng 10 lãi bao nhiêu?', () => now);
    expect(calls).toBe(2);
  });

  it('says busy to a second ask of the same member while the first is still being read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = readerOf(async () => {
      await gate;
      return choice('profit_loss', 'last_month');
    });
    const ai = askBooksAi(slow.reader, new DraftBudget());
    const first = ask(ai, [], 'Tháng trước lãi bao nhiêu?');
    const second = await ask(ai, [], 'Cuối quý còn bao nhiêu tiền?');
    expect(second.ai).toBe('busy');
    release();
    expect((await first).state).toBe('card');
  });

  it('does not log the question or the answer of the model', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = readerOf(async () => {
      throw new Error('boom: Tháng 10 lãi bao nhiêu');
    });
    await ask(askBooksAi(broken.reader, new DraftBudget()));
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Tháng 10');
  });
});

describe('askBooks: a report picked on the card', () => {
  const pickAsk = (input: Parameters<typeof askBooks>[4], calls: Call[] = []) => askBooks(askBooksAi(null, new DraftBudget()), fakeQuery(calls), ORG, OWNER, input, () => 1_000, today);

  it('asks no model and reads the report for the word or period picked', async () => {
    const calls: Call[] = [];
    const answer = await pickAsk({ pick: { entry: 'profit_loss', period: { kind: 'relative', token: 'last_month' } } }, calls);
    expect(answer).toMatchObject({ ai: 'picked', state: 'card', lead: null });
    expect(answer.card?.period.value).toBe('2026-10');
    const picked = await pickAsk({ pick: { entry: 'vat_position', period: { kind: 'period', value: '2026-Q3' } } }, calls);
    expect(picked.card?.period.value).toBe('2026-Q3');
    expect(calls.map((c) => c.name)).toEqual(['finance.statements.period', 'finance.vat.period']);
  });

  it('shows the list of periods again for a period the read does not take or that has not begun', async () => {
    const calls: Call[] = [];
    expect((await pickAsk({ pick: { entry: 'vat_position', period: { kind: 'period', value: '2026' } } }, calls)).state).toBe('pick_period');
    expect((await pickAsk({ pick: { entry: 'stock_value', period: { kind: 'period', value: '2026-Q3' } } }, calls)).state).toBe('pick_period');
    expect((await pickAsk({ pick: { entry: 'profit_loss', period: { kind: 'period', value: '2027-01' } } }, calls)).state).toBe('pick_period');
    expect(calls).toEqual([]);
  });

  it('lets the read\'s refusal through, as the report itself would answer', async () => {
    const refusal = new Error('LEGAL_ENTITY_NOT_ALLOWED');
    await expect(
      askBooks(askBooksAi(null, new DraftBudget()), async () => Promise.reject(refusal), ORG, VIEWER, { pick: { entry: 'cash_balance', period: { kind: 'relative', token: 'as_of_today' } } }, () => 1_000, today),
    ).rejects.toBe(refusal);
  });
});

describe('the periods, resolved by code', () => {
  it('resolves every word of the model from the day, and marks a period that has not ended as partial', () => {
    expect(resolveRelativePeriod('this_month', '2026-11-27')).toEqual({ kind: 'month', value: '2026-11', from: '2026-11-01', to: '2026-11-30', partial: true });
    expect(resolveRelativePeriod('as_of_today', '2026-11-27').value).toBe('2026-11');
    expect(resolveRelativePeriod('last_month', '2026-11-27')).toEqual({ kind: 'month', value: '2026-10', from: '2026-10-01', to: '2026-10-31', partial: false });
    expect(resolveRelativePeriod('last_month', '2026-01-05').value).toBe('2025-12');
    expect(resolveRelativePeriod('this_quarter', '2026-11-27')).toEqual({ kind: 'quarter', value: '2026-Q4', from: '2026-10-01', to: '2026-12-31', partial: true });
    expect(resolveRelativePeriod('last_quarter', '2026-02-10').value).toBe('2025-Q4');
    expect(resolveRelativePeriod('this_year', '2026-11-27')).toEqual({ kind: 'year', value: '2026', from: '2026-01-01', to: '2026-12-31', partial: true });
    expect(resolveRelativePeriod('last_year', '2026-11-27')).toEqual({ kind: 'year', value: '2025', from: '2025-01-01', to: '2025-12-31', partial: false });
    // A leap year's February has its 29th.
    expect(resolveRelativePeriod('last_month', '2028-03-10').to).toBe('2028-02-29');
  });

  it('resolves a picked value and refuses what is not a period or has not begun', () => {
    expect(resolvePickedPeriod('2026-10', '2026-11-27')?.partial).toBe(false);
    expect(resolvePickedPeriod('2026-11', '2026-11-27')?.partial).toBe(true);
    expect(resolvePickedPeriod('2026-Q4', '2026-11-27')?.kind).toBe('quarter');
    expect(resolvePickedPeriod('2025', '2026-11-27')?.kind).toBe('year');
    expect(resolvePickedPeriod('2026-12', '2026-11-27')).toBeNull();
    expect(resolvePickedPeriod('2027', '2026-11-27')).toBeNull();
    expect(resolvePickedPeriod('2026-13', '2026-11-27')).toBeNull();
    expect(resolvePickedPeriod('tháng 10', '2026-11-27')).toBeNull();
  });

  it('lists for each entry only the periods its read takes, newest first', () => {
    const stock = askBooksPickOptions('stock_value', '2026-11-27');
    expect(stock.every((o) => o.kind === 'month')).toBe(true);
    expect(stock[0]).toEqual({ kind: 'month', value: '2026-11' });
    expect(stock[11]).toEqual({ kind: 'month', value: '2025-12' });
    const vat = askBooksPickOptions('vat_position', '2026-11-27');
    expect(new Set(vat.map((o) => o.kind))).toEqual(new Set(['month', 'quarter']));
    expect(vat.find((o) => o.kind === 'quarter')).toEqual({ kind: 'quarter', value: '2026-Q4' });
    const profit = askBooksPickOptions('profit_loss', '2026-11-27');
    expect(new Set(profit.map((o) => o.kind))).toEqual(new Set(['month', 'quarter', 'year']));
    expect(profit.filter((o) => o.kind === 'year').map((o) => o.value)).toEqual(['2026', '2025', '2024']);
    // Every option is itself a period that has begun.
    for (const o of profit) expect(resolvePickedPeriod(o.value, '2026-11-27')).not.toBeNull();
  });
});
