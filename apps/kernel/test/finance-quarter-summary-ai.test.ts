// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentences on the quarter card, on the API side (#5183), with a stand-in for the reader: code picks the rows (the most striking first, at most five, the card's order), the facts hold no
// figure, no date, no code and no name, every state of `ai` is an answer with no sentences (the card then shows the same figures without any), never an error; an answer is kept by its facts so a second ask
// costs no call; a failure is logged by name only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, quarterSummaryFactsText, type QuarterSummaryNoteFacts, type QuarterSummaryNotesResult } from '@ludy/agent';
import type { FinanceQuarterSummary, QuarterSummaryFigure, QuarterTrend } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { QUARTER_SUMMARY_KEEP_MS, explainQuarterSummary, quarterSummaryAi, quarterSummaryFacts, standoutScore, type QuarterSummaryAi } from '../src/finance-quarter-summary-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const figure = (key: QuarterSummaryFigure['key'], vsPrevious: QuarterTrend, vsLastYear: QuarterTrend, amount = '123456789'): QuarterSummaryFigure => ({ key, amount, previous: '111111111', lastYear: '99999999', vsPrevious, vsLastYear });
const SUMMARY: FinanceQuarterSummary = {
  quarter: '2026-Q3',
  from: '2026-07-01',
  to: '2026-09-30',
  legalEntityId: 'le-1',
  kind: 'company',
  regime: 'tt99',
  booksStart: '2025-08-10',
  partialBasis: false,
  previousQuarter: '2026-Q2',
  lastYearQuarter: '2025-Q3',
  steadyPercent: '5',
  empty: false,
  includesUnmapped: true,
  figures: [
    figure('revenue', 'rose', 'rose'),
    figure('other_income', 'none', 'none'),
    figure('costs', 'rose', 'steady'),
    figure('profit', 'fell', 'rose'),
    figure('cash', 'steady', 'none'),
    figure('receivables', 'rose', 'first_time'),
    figure('payables', 'steady', 'steady'),
  ],
  overdue: { oldestDueOn: '2026-08-09', amount: '987654321', count: 3, truncated: false },
  vat: { output: '1000', input: '500', difference: '500', filed: false },
  householdTax: null,
  stockProvisional: null,
  lock: { state: 'open', lockedThrough: null },
};

function setup(answer: ((facts: QuarterSummaryNoteFacts) => Promise<QuarterSummaryNotesResult>) | null, budget = new DraftBudget()) {
  const asked: QuarterSummaryNoteFacts[] = [];
  const ai: QuarterSummaryAi = quarterSummaryAi(
    answer
      ? {
          quarterSummaryNotes: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: QuarterSummaryNotesResult = { kind: 'notes', notes: [{ row: 1, text: 'Doanh thu tăng so với quý trước.' }, { row: 2, text: 'Chi phí tăng so với quý trước.' }, { row: 3, text: 'Lợi nhuận giảm so với quý trước.' }] };

afterEach(() => vi.restoreAllMocks());

describe('standoutScore', () => {
  it('ranks a move the same way against both bases above opposite moves above one move above steady above nothing', () => {
    expect(standoutScore({ vsPrevious: 'rose', vsLastYear: 'rose' })).toBe(5);
    expect(standoutScore({ vsPrevious: 'fell', vsLastYear: 'fell' })).toBe(5);
    expect(standoutScore({ vsPrevious: 'first_time', vsLastYear: 'rose' })).toBe(5);
    expect(standoutScore({ vsPrevious: 'rose', vsLastYear: 'fell' })).toBe(4);
    expect(standoutScore({ vsPrevious: 'rose', vsLastYear: 'steady' })).toBe(3);
    expect(standoutScore({ vsPrevious: 'none', vsLastYear: 'fell' })).toBe(3);
    expect(standoutScore({ vsPrevious: 'steady', vsLastYear: 'steady' })).toBe(1);
    expect(standoutScore({ vsPrevious: 'steady', vsLastYear: 'none' })).toBe(1);
    expect(standoutScore({ vsPrevious: 'none', vsLastYear: 'none' })).toBe(0);
  });
});

describe('quarterSummaryFacts', () => {
  it('picks the five most striking rows, in the card\'s order, and never a row with nothing to say', () => {
    const { facts, keys } = quarterSummaryFacts(SUMMARY, 'vi');
    // Scores: revenue 5, other_income 0, costs 3, profit 4, cash 1, receivables 5, payables 1: the five best are revenue, receivables, profit, costs and then cash (1, first in the card) over payables (1).
    expect(keys).toEqual(['revenue', 'costs', 'profit', 'cash', 'receivables']);
    expect(facts.language).toBe('vi');
    expect(facts.entity).toBe('company');
    expect(facts.rows).toEqual([
      { row: 'revenue', vsPrevious: 'rose', vsLastYear: 'rose', overdue: false },
      { row: 'costs', vsPrevious: 'rose', vsLastYear: 'steady', overdue: false },
      { row: 'profit', vsPrevious: 'fell', vsLastYear: 'rose', overdue: false },
      { row: 'cash', vsPrevious: 'steady', vsLastYear: 'none', overdue: false },
      { row: 'receivables', vsPrevious: 'rose', vsLastYear: 'first_time', overdue: true },
    ]);
  });

  it('carries no figure, no date, no code and no name', () => {
    const { facts } = quarterSummaryFacts(SUMMARY, 'en');
    const text = JSON.stringify(facts);
    for (const secret of ['123456789', '111111111', '99999999', '987654321', '2026', '2025', '2026-08-09', 'le-1', 'tt99', 'Q3', '1000', '500']) expect(text, secret).not.toContain(secret);
    expect(quarterSummaryFactsText(facts).replace(/^Row \d+:/gm, 'Row:')).not.toMatch(/\d/);
  });

  it('asks for no row when every label is none, and says overdue only when invoices were overdue', () => {
    const quiet = { ...SUMMARY, figures: SUMMARY.figures.map((f) => ({ ...f, vsPrevious: 'none' as const, vsLastYear: 'none' as const })) };
    expect(quarterSummaryFacts(quiet, 'en').facts.rows).toEqual([]);
    const settled = { ...SUMMARY, overdue: { ...SUMMARY.overdue, count: 0, oldestDueOn: null, amount: '0' } };
    expect(quarterSummaryFacts(settled, 'en').facts.rows.find((r) => r.row === 'receivables')?.overdue).toBe(false);
  });

  it('tells a household as one', () => {
    expect(quarterSummaryFacts({ ...SUMMARY, kind: 'household' }, 'en').facts.entity).toBe('household');
  });
});

describe('explainQuarterSummary', () => {
  it('asks the model once and puts each sentence back on its row by its key', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'vi')).toEqual({
      ai: 'used',
      notes: [
        { row: 'revenue', text: 'Doanh thu tăng so với quý trước.' },
        { row: 'costs', text: 'Chi phí tăng so với quý trước.' },
        { row: 'profit', text: 'Lợi nhuận giảm so với quý trước.' },
      ],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('drops a sentence for a row that was not asked', async () => {
    const { ai } = setup(async () => ({ kind: 'notes', notes: [{ row: 1, text: 'A' }, { row: 9, text: 'B' }] }));
    expect(await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'en')).toEqual({ ai: 'used', notes: [{ row: 'revenue', text: 'A' }] });
  });

  it('says off, with no sentences and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'vi')).toEqual({ ai: 'off', notes: [] });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when no row has anything to say', async () => {
    const { ai, asked } = setup(async () => SAID);
    const quiet = { ...SUMMARY, figures: SUMMARY.figures.map((f) => ({ ...f, vsPrevious: 'none' as const, vsLastYear: 'none' as const })) };
    expect(await explainQuarterSummary(ai, ORG, USER, quiet, 'vi')).toEqual({ ai: 'quiet', notes: [] });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by its facts: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'vi', () => at);
    at += QUARTER_SUMMARY_KEEP_MS - 1;
    expect((await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other labels are other answers.
    await explainQuarterSummary(ai, 'org-2', USER, SUMMARY, 'vi', () => at);
    await explainQuarterSummary(ai, ORG, USER, SUMMARY, 'en', () => at);
    await explainQuarterSummary(ai, ORG, USER, { ...SUMMARY, figures: [figure('revenue', 'fell', 'fell')] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainQuarterSummary(first.ai, ORG, USER, SUMMARY, 'vi')).ai).toBe('used');
    expect(await explainQuarterSummary(first.ai, ORG, USER, { ...SUMMARY, figures: [figure('revenue', 'fell', 'fell')] }, 'vi')).toEqual({ ai: 'busy', notes: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainQuarterSummary(spent.ai, ORG, USER, SUMMARY, 'vi')).toEqual({ ai: 'budget', notes: [] });
  });

  it('says failed, with no sentences, when the call fails or the set was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'TOO_FEW' }));
    expect(await explainQuarterSummary(refused.ai, ORG, USER, SUMMARY, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const broken = setup(async () => {
      throw new Error('boom: 123456789 Công ty Sao Mai');
    });
    expect(await explainQuarterSummary(broken.ai, ORG, USER, SUMMARY, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('123456789');
    expect(logged).not.toContain('Sao Mai');
  });
});
