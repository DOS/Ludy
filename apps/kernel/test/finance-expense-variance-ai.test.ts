// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible reasons on the expense variance card, on the API side (#4392), with a stand-in for the reader: every state of `ai` is an answer with no notes (the card then shows the same
// table without a sentence), never an error; the facts hold no figure; an answer is kept by its facts so a second ask costs no call; a failure is logged by name only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type ExpenseVarianceNoteFacts, type ExpenseVarianceNotesResult } from '@ludy/agent';
import type { ExpenseVarianceContributor, ExpenseVarianceLine, FinanceExpenseVariance } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { EXPENSE_VARIANCE_KEEP_MS, expenseVarianceAi, expenseVarianceFacts, expenseVarianceGroup, explainExpenseVariance, type ExpenseVarianceAi } from '../src/finance-expense-variance-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const compare = (basis: string, change: string, percent: string | null) => ({ basis, change, percent, flagged: true });
const contributor = (over: Partial<ExpenseVarianceContributor> = {}): ExpenseVarianceContributor => ({
  kind: 'supplier',
  partyId: 'party-1',
  name: 'Công ty Sao Mai',
  partyKind: 'organization',
  entryId: null,
  entryDate: null,
  description: null,
  sourceKind: 'invoice',
  vouchers: 1,
  amount: '30000000',
  basis: '10000000',
  change: '20000000',
  ...over,
});
const line = (code: string, over: Partial<ExpenseVarianceLine> = {}): ExpenseVarianceLine => ({
  code,
  name: 'Chi phí',
  amount: '30000000',
  previous: compare('10000000', '20000000', '200.0'),
  average: compare('10000000', '20000000', '200.0'),
  direction: 'up',
  against: 'previous',
  isNew: false,
  vouchers: 2,
  contributors: [contributor()],
  ...over,
});
const VARIANCE: FinanceExpenseVariance = {
  month: '2026-07',
  legalEntityId: 'le-1',
  regime: 'tt133',
  chartVersion: '2026.1',
  thresholds: { amount: '5000000', percent: '30' },
  previousMonth: '2026-06',
  averageMonths: ['2026-04', '2026-05', '2026-06'],
  missing: { previous: false, average: false },
  empty: false,
  lines: [line('642'), line('632', { direction: 'down', against: 'average', contributors: [contributor({ kind: 'voucher', partyId: null, name: null, partyKind: null, entryId: 'e-1', entryDate: '2026-06-28', description: 'Giá vốn', vouchers: 0, sourceKind: 'manual' })] })],
  moreFlagged: 0,
};

function setup(answer: ((facts: ExpenseVarianceNoteFacts) => Promise<ExpenseVarianceNotesResult>) | null, budget = new DraftBudget()) {
  const asked: ExpenseVarianceNoteFacts[] = [];
  const ai: ExpenseVarianceAi = expenseVarianceAi(
    answer
      ? {
          expenseVarianceNotes: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: ExpenseVarianceNotesResult = { kind: 'notes', notes: [{ row: 1, text: 'Một hóa đơn có thể giải thích.' }, { row: 2, text: 'Có thể mua ít hơn.' }] };

afterEach(() => vi.restoreAllMocks());

describe('expenseVarianceFacts', () => {
  it('carries the kind, direction, basis and contributors of each line and no figure', () => {
    const { facts, codes } = expenseVarianceFacts(VARIANCE, 'vi');
    expect(codes).toEqual(['642', '632']);
    expect(facts).toEqual({
      language: 'vi',
      lines: [
        { group: '642', direction: 'up', against: 'previous', isNew: false, contributors: [{ kind: 'supplier', name: 'Công ty Sao Mai', partyKind: 'organization', sourceKind: 'invoice', vouchers: 'single' }] },
        { group: '632', direction: 'down', against: 'average', isNew: false, contributors: [{ kind: 'voucher', name: null, partyKind: null, sourceKind: 'manual', vouchers: 'none' }] },
      ],
    });
    // No amount, percent, date, voucher count or entry id travels in the facts.
    const text = JSON.stringify(facts);
    for (const figure of ['30000000', '10000000', '200.0', '2026', '28']) expect(text).not.toContain(figure);
    expect(text).not.toContain('e-1');
  });

  it('tells several vouchers only for a supplier with more than one, and gives at most the lines the coworker is given', () => {
    const many = { ...VARIANCE, lines: Array.from({ length: 10 }, (_, i) => line(`63${i}`, { contributors: [contributor({ vouchers: 3 })] })) };
    const { facts, codes } = expenseVarianceFacts(many, 'en');
    expect(facts.lines).toHaveLength(8);
    expect(codes).toHaveLength(8);
    expect(facts.lines[0]?.contributors[0]?.vouchers).toBe('several');
  });
});

describe('expenseVarianceGroup', () => {
  it('labels a TT133 line by what it is: 6421 is selling expenses, 6422 administration, never both as 642', () => {
    expect(expenseVarianceGroup('6421', 'tt133')).toBe('641');
    expect(expenseVarianceGroup('6422', 'tt133')).toBe('642');
    expect(expenseVarianceGroup('642', 'tt133')).toBe('642');
    expect(expenseVarianceGroup('632', 'tt133')).toBe('632');
    expect(expenseVarianceGroup('641', 'tt99')).toBe('641');
    expect(expenseVarianceGroup('642', 'tt99')).toBe('642');
  });

  it('tells a supplier or voucher that is only in the months it is compared with as none, not as a single voucher', () => {
    const lines = [line('632', { direction: 'down', contributors: [contributor({ vouchers: 0 }), contributor({ vouchers: 1 }), contributor({ vouchers: 4 })] })];
    const { facts } = expenseVarianceFacts({ ...VARIANCE, lines }, 'en');
    expect(facts.lines[0]?.contributors.map((c) => c.vouchers)).toEqual(['none', 'single', 'several']);
    const tt133 = expenseVarianceFacts({ ...VARIANCE, lines: [line('6421'), line('6422')] }, 'en');
    expect(tt133.facts.lines.map((l) => l.group)).toEqual(['641', '642']);
  });
});

describe('explainExpenseVariance', () => {
  it('asks the model once and puts each note back on its line by its code', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'vi')).toEqual({
      ai: 'used',
      notes: [
        { code: '642', text: 'Một hóa đơn có thể giải thích.' },
        { code: '632', text: 'Có thể mua ít hơn.' },
      ],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('drops a note for a row that has no line', async () => {
    const { ai } = setup(async () => ({ kind: 'notes', notes: [{ row: 1, text: 'A' }, { row: 7, text: 'B' }] }));
    expect(await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'en')).toEqual({ ai: 'used', notes: [{ code: '642', text: 'A' }] });
  });

  it('says off, with no notes and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'vi')).toEqual({ ai: 'off', notes: [] });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when no line is flagged', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainExpenseVariance(ai, ORG, USER, { ...VARIANCE, lines: [] }, 'vi')).toEqual({ ai: 'quiet', notes: [] });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by its facts: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'vi', () => at);
    at += EXPENSE_VARIANCE_KEEP_MS - 1;
    expect((await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other lines are other answers.
    await explainExpenseVariance(ai, 'org-2', USER, VARIANCE, 'vi', () => at);
    await explainExpenseVariance(ai, ORG, USER, VARIANCE, 'en', () => at);
    await explainExpenseVariance(ai, ORG, USER, { ...VARIANCE, lines: [line('6411')] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainExpenseVariance(first.ai, ORG, USER, VARIANCE, 'vi')).ai).toBe('used');
    expect(await explainExpenseVariance(first.ai, ORG, USER, { ...VARIANCE, lines: [line('6411')] }, 'vi')).toEqual({ ai: 'busy', notes: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainExpenseVariance(spent.ai, ORG, USER, VARIANCE, 'vi')).toEqual({ ai: 'budget', notes: [] });
  });

  it('says failed, with no notes, when the call fails or every note was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    expect(await explainExpenseVariance(refused.ai, ORG, USER, VARIANCE, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const broken = setup(async () => {
      throw new Error('boom: 30000000 Công ty Sao Mai');
    });
    expect(await explainExpenseVariance(broken.ai, ORG, USER, VARIANCE, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('30000000');
    expect(logged).not.toContain('Sao Mai');
  });
});
