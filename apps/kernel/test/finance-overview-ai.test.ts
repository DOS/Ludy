// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence on the Kế toán overview on the API side (#2631) with a stand-in for the reader: every state of `ai` is an answer with no
// text (the screen then shows the figures alone), never an error, and an answer is kept by its figures so a second ask costs no call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type OverviewFacts, type OverviewSentenceResult } from '@crove/agent';
import type { FinanceOverview, OverviewFigure } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { OVERVIEW_KEEP_MS, explainOverview, overviewAi, overviewFacts, type OverviewAi } from '../src/finance-overview-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const figure = (amount: string, previous: string): OverviewFigure => ({ amount, previous, change: '0', changePercent: null });
const OVERVIEW: FinanceOverview = {
  range: 'last_30_days',
  from: '2026-10-06',
  to: '2026-11-04',
  previousFrom: '2026-09-06',
  previousTo: '2026-10-05',
  empty: false,
  cash: figure('11800000', '10000000'),
  profit: figure('1500000', '2500000'),
  receivables: figure('0', '0'),
  payables: figure('0', '0'),
  months: [],
  expenses: [{ group: '641', amount: '1400000', previous: '1000000', percent: '100.0' }],
  unmapped: 0,
};

function setup(answer: ((facts: OverviewFacts) => Promise<OverviewSentenceResult>) | null, budget = new DraftBudget()) {
  const asked: OverviewFacts[] = [];
  const ai: OverviewAi = overviewAi(
    answer
      ? {
          overviewSentence: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}
const SAID: OverviewSentenceResult = { kind: 'sentence', text: 'Lợi nhuận giảm.' };

afterEach(() => vi.restoreAllMocks());

describe('overviewFacts', () => {
  it('carries the four cards and the costs by group, now and before, and nothing else', () => {
    expect(overviewFacts(OVERVIEW, 'vi')).toEqual({
      language: 'vi',
      figures: [
        { key: 'cash', amount: '11800000', previous: '10000000' },
        { key: 'profit', amount: '1500000', previous: '2500000' },
        { key: 'receivables', amount: '0', previous: '0' },
        { key: 'payables', amount: '0', previous: '0' },
      ],
      expenses: [{ code: '641', amount: '1400000', previous: '1000000' }],
    });
  });
});

describe('explainOverview', () => {
  it('asks the model once with the figures and answers its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainOverview(ai, ORG, USER, OVERVIEW, 'vi')).toEqual({ ai: 'used', text: 'Lợi nhuận giảm.' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.language).toBe('vi');
  });

  it('says off, with no text and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainOverview(ai, ORG, USER, OVERVIEW, 'vi')).toEqual({ ai: 'off', text: null });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, for an empty book and for periods that did not move', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainOverview(ai, ORG, USER, { ...OVERVIEW, empty: true }, 'vi')).toEqual({ ai: 'quiet', text: null });
    const still: FinanceOverview = { ...OVERVIEW, cash: figure('1', '1'), profit: figure('1', '1'), expenses: [] };
    expect(await explainOverview(ai, ORG, USER, still, 'vi')).toEqual({ ai: 'quiet', text: null });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by its figures: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainOverview(ai, ORG, USER, OVERVIEW, 'vi', () => at);
    at += OVERVIEW_KEEP_MS - 1;
    expect((await explainOverview(ai, ORG, USER, OVERVIEW, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainOverview(ai, ORG, USER, OVERVIEW, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other figures are other answers.
    await explainOverview(ai, 'org-2', USER, OVERVIEW, 'vi', () => at);
    await explainOverview(ai, ORG, USER, OVERVIEW, 'en', () => at);
    await explainOverview(ai, ORG, USER, { ...OVERVIEW, cash: figure('1', '2') }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainOverview(first.ai, ORG, USER, OVERVIEW, 'vi')).ai).toBe('used');
    expect(await explainOverview(first.ai, ORG, USER, { ...OVERVIEW, cash: figure('3', '4') }, 'vi')).toEqual({ ai: 'busy', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainOverview(spent.ai, ORG, USER, OVERVIEW, 'vi')).toEqual({ ai: 'budget', text: null });
  });

  it('says failed, with no text, when the call fails or its text was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await explainOverview(refused.ai, ORG, USER, OVERVIEW, 'vi')).toEqual({ ai: 'failed', text: null });
    const broken = setup(async () => {
      throw new Error('boom: 11800000');
    });
    expect(await explainOverview(broken.ai, ORG, USER, OVERVIEW, 'vi')).toEqual({ ai: 'failed', text: null });
    expect(log.mock.calls.flat().join(' ')).not.toContain('11800000');
  });
});
