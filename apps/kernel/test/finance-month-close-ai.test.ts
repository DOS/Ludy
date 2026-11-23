// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the month-close checklist on the API side, with a stand-in for the reader: every state of `ai` is an answer with no text (the screen then shows the
// checklist in its fixed order), never an error, and a note is kept by the open items so a second ask costs no call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, MONTH_CLOSE_KEYS, type MonthCloseFacts, type MonthCloseNoteResult } from '@ludy/agent';
import { MONTH_CLOSE_ITEMS, type MonthClose, type MonthCloseItem, type MonthCloseKey } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MONTH_CLOSE_KEEP_MS, explainMonthClose, monthCloseAi, monthCloseFacts, type MonthCloseAi } from '../src/finance-month-close-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const item = (key: MonthCloseKey, count: number): MonthCloseItem => ({ key, count, period: null });
const CHECKLIST: MonthClose = {
  month: '2026-10',
  legalEntityId: '0190a000-0000-7000-8000-000000000001',
  items: [item('proposals', 4), item('bank', 17), item('stock', 0), item('lock', 1)],
};

function setup(answer: ((facts: MonthCloseFacts) => Promise<MonthCloseNoteResult>) | null, budget = new DraftBudget()) {
  const asked: MonthCloseFacts[] = [];
  const ai: MonthCloseAi = monthCloseAi(
    answer
      ? {
          monthCloseNote: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: MonthCloseNoteResult = { kind: 'note', text: 'Start with the proposals.', order: ['proposals', 'bank', 'lock'] };

afterEach(() => vi.restoreAllMocks());

describe('the keys', () => {
  it('are the contract\'s items, in the same order, so the agent package and the screen never disagree', () => {
    expect([...MONTH_CLOSE_KEYS]).toEqual([...MONTH_CLOSE_ITEMS]);
  });
});

describe('monthCloseFacts', () => {
  it('carries the keys of the open items in the fixed order and no count', () => {
    const facts = monthCloseFacts(CHECKLIST, 'en');
    expect(facts).toEqual({ language: 'en', open: ['proposals', 'bank', 'lock'] });
    expect(JSON.stringify(facts)).not.toMatch(/\p{Nd}/u);
  });

  it('keeps the fixed order whatever the order of the items it is given', () => {
    const shuffled: MonthClose = { ...CHECKLIST, items: [...CHECKLIST.items].reverse() };
    expect(monthCloseFacts(shuffled, 'vi').open).toEqual(MONTH_CLOSE_ITEMS.filter((key) => ['proposals', 'bank', 'lock'].includes(key)));
  });
});

describe('explainMonthClose', () => {
  it('asks the model once with the open items and answers its note and order', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainMonthClose(ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'used', text: 'Start with the proposals.', order: ['proposals', 'bank', 'lock'] });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('says off, with no text, no order and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainMonthClose(ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'off', text: null, order: [] });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when every item is done', async () => {
    const { ai, asked } = setup(async () => SAID);
    const done: MonthClose = { ...CHECKLIST, items: CHECKLIST.items.map((i) => ({ ...i, count: 0 })) };
    expect(await explainMonthClose(ai, ORG, USER, done, 'vi')).toEqual({ ai: 'quiet', text: null, order: [] });
    expect(asked).toEqual([]);
  });

  it('keeps a note by the open items: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainMonthClose(ai, ORG, USER, CHECKLIST, 'vi', () => at);
    at += MONTH_CLOSE_KEEP_MS - 1;
    // A different month or other counts over the same open items is the same note.
    const other: MonthClose = { ...CHECKLIST, month: '2026-09', items: [item('proposals', 9), item('bank', 2), item('stock', 0), item('lock', 1)] };
    expect((await explainMonthClose(ai, ORG, USER, other, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainMonthClose(ai, ORG, USER, CHECKLIST, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other open items are other notes.
    await explainMonthClose(ai, 'org-2', USER, CHECKLIST, 'vi', () => at);
    await explainMonthClose(ai, ORG, USER, CHECKLIST, 'en', () => at);
    await explainMonthClose(ai, ORG, USER, { ...CHECKLIST, items: [item('proposals', 1)] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainMonthClose(first.ai, ORG, USER, CHECKLIST, 'vi')).ai).toBe('used');
    expect(await explainMonthClose(first.ai, ORG, USER, { ...CHECKLIST, items: [item('lock', 1)] }, 'vi')).toEqual({ ai: 'busy', text: null, order: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainMonthClose(spent.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'budget', text: null, order: [] });
  });

  it('says failed, with no text, when the call fails or its answer was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await explainMonthClose(refused.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'failed', text: null, order: [] });
    const broken = setup(async () => {
      throw new Error('boom: 17 lines');
    });
    expect(await explainMonthClose(broken.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'failed', text: null, order: [] });
    expect(log.mock.calls.flat().join(' ')).not.toContain('17');
  });
});
