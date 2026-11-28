// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the year-end checklist on the API side, with a stand-in for the reader: every state of `ai` is an answer with no text (the screen then shows the checklist in
// its fixed order), never an error, an item that waits for the year to end is never given to the model, and a note is kept by the open items so a second ask costs no call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, YEAR_END_KEYS, type YearEndFacts, type YearEndNoteResult } from '@ludy/agent';
import { YEAR_END_ITEMS, type YearEnd, type YearEndItem, type YearEndKey } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { YEAR_END_KEEP_MS, explainYearEnd, yearEndAi, yearEndFacts, type YearEndAi } from '../src/finance-year-end-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const item = (key: YearEndKey, state: YearEndItem['state'], waiting = false, count = state === 'open' ? 1 : 0): YearEndItem => ({ key, state, waiting, count, due: null });
const CHECKLIST: YearEnd = {
  year: 2026,
  legalEntityId: '0190a000-0000-7000-8000-000000000001',
  over: false,
  items: [item('balances', 'open', false, 4), item('depreciation', 'open', false, 17), item('closing_entry', 'open', true), item('months_locked', 'open', true), item('statements', 'na'), item('einvoice_series', 'done')],
};

function setup(answer: ((facts: YearEndFacts) => Promise<YearEndNoteResult>) | null, budget = new DraftBudget()) {
  const asked: YearEndFacts[] = [];
  const ai: YearEndAi = yearEndAi(
    answer
      ? {
          yearEndNote: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: YearEndNoteResult = { kind: 'note', text: 'Start with the balances.', order: ['balances', 'depreciation'] };

afterEach(() => vi.restoreAllMocks());

describe('the keys', () => {
  it("are the contract's items, in the same order, so the agent package and the screen never disagree", () => {
    expect([...YEAR_END_KEYS]).toEqual([...YEAR_END_ITEMS]);
  });
});

describe('yearEndFacts', () => {
  it('carries the keys of the open items that can be done now, in the fixed order, and no count or date', () => {
    const facts = yearEndFacts(CHECKLIST, 'en');
    expect(facts).toEqual({ language: 'en', open: ['balances', 'depreciation'] });
    expect(JSON.stringify(facts)).not.toMatch(/\p{Nd}/u);
  });

  it('leaves out an item that waits for the year to end, a done one and one that does not apply', () => {
    const facts = yearEndFacts(CHECKLIST, 'vi');
    for (const key of ['closing_entry', 'months_locked', 'statements', 'einvoice_series']) expect(facts.open).not.toContain(key);
  });

  it('keeps the fixed order whatever the order of the items it is given', () => {
    const shuffled: YearEnd = { ...CHECKLIST, items: [...CHECKLIST.items].reverse() };
    expect(yearEndFacts(shuffled, 'vi').open).toEqual(YEAR_END_ITEMS.filter((key) => ['balances', 'depreciation'].includes(key)));
  });
});

describe('explainYearEnd', () => {
  it('asks the model once with the open items and answers its note and order', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainYearEnd(ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'used', text: 'Start with the balances.', order: ['balances', 'depreciation'] });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('says off, with no text, no order and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainYearEnd(ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'off', text: null, order: [] });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when nothing is open and ready (every open item waits for the year to end)', async () => {
    const { ai, asked } = setup(async () => SAID);
    const waiting: YearEnd = { ...CHECKLIST, items: [item('closing_entry', 'open', true), item('statements', 'open', true), item('balances', 'done')] };
    expect(await explainYearEnd(ai, ORG, USER, waiting, 'vi')).toEqual({ ai: 'quiet', text: null, order: [] });
    expect(asked).toEqual([]);
  });

  it('keeps a note by the open items: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainYearEnd(ai, ORG, USER, CHECKLIST, 'vi', () => at);
    at += YEAR_END_KEEP_MS - 1;
    // Another year or other counts over the same open items is the same note.
    const other: YearEnd = { ...CHECKLIST, year: 2025, items: [item('balances', 'open', false, 9), item('depreciation', 'open', false, 2)] };
    expect((await explainYearEnd(ai, ORG, USER, other, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainYearEnd(ai, ORG, USER, CHECKLIST, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other open items are other notes.
    await explainYearEnd(ai, 'org-2', USER, CHECKLIST, 'vi', () => at);
    await explainYearEnd(ai, ORG, USER, CHECKLIST, 'en', () => at);
    await explainYearEnd(ai, ORG, USER, { ...CHECKLIST, items: [item('balances', 'open')] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it("says busy when the member asks too often, and budget when the org's AI budget is spent", async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainYearEnd(first.ai, ORG, USER, CHECKLIST, 'vi')).ai).toBe('used');
    expect(await explainYearEnd(first.ai, ORG, USER, { ...CHECKLIST, items: [item('stock_count', 'open')] }, 'vi')).toEqual({ ai: 'busy', text: null, order: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainYearEnd(spent.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'budget', text: null, order: [] });
  });

  it('says failed, with no text, when the call fails or its answer was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'ADVICE' }));
    expect(await explainYearEnd(refused.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'failed', text: null, order: [] });
    const broken = setup(async () => {
      throw new Error('boom: 17 lines');
    });
    expect(await explainYearEnd(broken.ai, ORG, USER, CHECKLIST, 'vi')).toEqual({ ai: 'failed', text: null, order: [] });
    expect(log.mock.calls.flat().join(' ')).not.toContain('17');
  });
});
