// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible things to look at on the monthly review of unusual entries, on the API side (#5182), with a stand-in for the reader: every state of `ai` is an answer with no notes (the card then
// shows the same list without a sentence), never an error; the facts hold no figure, date, account code, voucher number, name or memo; an answer is kept by its facts so a second ask costs no call; a failure is
// logged by name only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type UnusualEntriesNoteFacts, type UnusualEntriesNotesResult } from '@ludy/agent';
import { UNUSUAL_NOTE_HITS, type FinanceUnusualEntries, type UnusualEntryHit } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { UNUSUAL_ENTRIES_KEEP_MS, explainUnusualEntries, unusualEntriesAi, unusualEntriesFacts, type UnusualEntriesAi } from '../src/finance-unusual-entries-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const hit = (over: Partial<UnusualEntryHit> = {}): UnusualEntryHit => ({
  rule: 'amount_outlier',
  entryId: 'e-1',
  entryDate: '2026-07-04',
  sourceKind: 'invoice',
  description: 'Tiền điện tháng 6',
  amount: '48000000',
  partyId: 'party-1',
  partyName: 'Công ty Sao Mai',
  accountCode: '642',
  accountName: 'Chi phí quản lý',
  groupAmount: '48000000',
  usual: '9000000',
  historyCount: 7,
  ratio: '5.3',
  direction: 'high',
  basis: null,
  day: null,
  control: null,
  invoiceNumber: null,
  otherEntryId: null,
  otherEntryDate: null,
  ...over,
});
const REVIEW: FinanceUnusualEntries = {
  month: '2026-07',
  legalEntityId: 'le-1',
  regime: 'tt133',
  chartVersion: '2026.1',
  thresholds: { amountFactor: 3, amountMinDiff: '5000000', madFactor: 5, historyMonths: 6, minHistory: 6, offDayMinAmount: '5000000' },
  historyFrom: '2026-01-01',
  empty: false,
  hits: [
    hit({ rule: 'duplicate_invoice', entryId: 'e-dup', direction: null, usual: null, historyCount: null, ratio: null, groupAmount: null, accountCode: null, accountName: null, invoiceNumber: '0001234', otherEntryId: 'e-0', otherEntryDate: '2026-05-02' }),
    hit({ rule: 'control_manual', entryId: 'e-ctl', sourceKind: 'manual', direction: null, usual: null, historyCount: null, ratio: null, groupAmount: null, accountCode: '331', accountName: 'Phải trả người bán', control: 'payable' }),
    hit({ rule: 'amount_outlier', entryId: 'e-out' }),
    hit({ rule: 'new_account', entryId: 'e-new', direction: null, usual: null, historyCount: null, ratio: null, groupAmount: null, basis: 'party' }),
    hit({ rule: 'off_day', entryId: 'e-off', sourceKind: 'cash_bank', direction: null, usual: null, historyCount: null, ratio: null, groupAmount: null, accountCode: null, accountName: null, day: 'holiday' }),
  ],
  moreHits: 0,
  reviewed: 0,
};

function setup(answer: ((facts: UnusualEntriesNoteFacts) => Promise<UnusualEntriesNotesResult>) | null, budget = new DraftBudget()) {
  const asked: UnusualEntriesNoteFacts[] = [];
  const ai: UnusualEntriesAi = unusualEntriesAi(
    answer
      ? {
          unusualEntriesNotes: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: UnusualEntriesNotesResult = { kind: 'notes', notes: [{ row: 1, text: 'Có thể hóa đơn này lặp lại một hóa đơn trước đó.' }, { row: 3, text: 'Có thể khoản mua này lớn hơn mức thường.' }] };

afterEach(() => vi.restoreAllMocks());

describe('unusualEntriesFacts', () => {
  it('carries the rule, the kind and one fixed detail of each hit, and no figure, date, code, id, name or memo', () => {
    const { facts, keys } = unusualEntriesFacts(REVIEW, 'vi');
    expect(keys).toEqual(['duplicate_invoice:e-dup', 'control_manual:e-ctl', 'amount_outlier:e-out', 'new_account:e-new', 'off_day:e-off']);
    expect(facts).toEqual({
      language: 'vi',
      hits: [
        { rule: 'duplicate_invoice', sourceKind: 'invoice' },
        { rule: 'control_manual', sourceKind: 'manual', control: 'payable' },
        { rule: 'amount_outlier', sourceKind: 'invoice', direction: 'high' },
        { rule: 'new_account', sourceKind: 'invoice', basis: 'party' },
        { rule: 'off_day', sourceKind: 'cash_bank', day: 'holiday' },
      ],
    });
    // No amount, ratio, date, count, account code, invoice number or entry id travels in the facts.
    const text = JSON.stringify(facts);
    for (const figure of ['48000000', '9000000', '5.3', '2026', '0001234', '642', '331', 'e-dup', 'e-out', 'e-0']) expect(text).not.toContain(figure);
    // No name of a supplier and no memo travels either.
    expect(text).not.toContain('Sao Mai');
    expect(text).not.toContain('Tiền điện');
  });

  it('gives at most the hits the coworker is given, the best ranked first', () => {
    const many = { ...REVIEW, hits: Array.from({ length: 20 }, (_, i) => hit({ entryId: `e-${i}` })) };
    const { facts, keys } = unusualEntriesFacts(many, 'en');
    expect(facts.hits).toHaveLength(UNUSUAL_NOTE_HITS);
    expect(keys).toHaveLength(UNUSUAL_NOTE_HITS);
    expect(keys[0]).toBe('amount_outlier:e-0');
  });
});

describe('explainUnusualEntries', () => {
  it('asks the model once and puts each note back on its hit by its key', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainUnusualEntries(ai, ORG, USER, REVIEW, 'vi')).toEqual({
      ai: 'used',
      notes: [
        { key: 'duplicate_invoice:e-dup', text: 'Có thể hóa đơn này lặp lại một hóa đơn trước đó.' },
        { key: 'amount_outlier:e-out', text: 'Có thể khoản mua này lớn hơn mức thường.' },
      ],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('drops a note for a row that has no hit', async () => {
    const { ai } = setup(async () => ({ kind: 'notes', notes: [{ row: 1, text: 'A' }, { row: 9, text: 'B' }] }));
    expect(await explainUnusualEntries(ai, ORG, USER, REVIEW, 'en')).toEqual({ ai: 'used', notes: [{ key: 'duplicate_invoice:e-dup', text: 'A' }] });
  });

  it('says off, with no notes and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainUnusualEntries(ai, ORG, USER, REVIEW, 'vi')).toEqual({ ai: 'off', notes: [] });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when there is no hit', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainUnusualEntries(ai, ORG, USER, { ...REVIEW, hits: [] }, 'vi')).toEqual({ ai: 'quiet', notes: [] });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by its facts: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainUnusualEntries(ai, ORG, USER, REVIEW, 'vi', () => at);
    at += UNUSUAL_ENTRIES_KEEP_MS - 1;
    expect((await explainUnusualEntries(ai, ORG, USER, REVIEW, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainUnusualEntries(ai, ORG, USER, REVIEW, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other hits are other answers.
    await explainUnusualEntries(ai, 'org-2', USER, REVIEW, 'vi', () => at);
    await explainUnusualEntries(ai, ORG, USER, REVIEW, 'en', () => at);
    await explainUnusualEntries(ai, ORG, USER, { ...REVIEW, hits: [hit({ entryId: 'e-other' })] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainUnusualEntries(first.ai, ORG, USER, REVIEW, 'vi')).ai).toBe('used');
    expect(await explainUnusualEntries(first.ai, ORG, USER, { ...REVIEW, hits: [hit({ entryId: 'e-other' })] }, 'vi')).toEqual({ ai: 'busy', notes: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainUnusualEntries(spent.ai, ORG, USER, REVIEW, 'vi')).toEqual({ ai: 'budget', notes: [] });
  });

  it('says failed, with no notes, when the call fails or every note was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    expect(await explainUnusualEntries(refused.ai, ORG, USER, REVIEW, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const broken = setup(async () => {
      throw new Error('boom: 48000000 Công ty Sao Mai');
    });
    expect(await explainUnusualEntries(broken.ai, ORG, USER, REVIEW, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('48000000');
    expect(logged).not.toContain('Sao Mai');
  });
});
