// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's first mapping for the columns of an unrecognised order report, on the API side (#4036): the model is told the masked sheet the worker recorded and nothing else (a buyer column is
// an empty shell and is not given), fewer than three columns to show ask no model, an answer is kept by its facts, and every state with no proposal (no model, a spent budget, too many calls, a failed call
// or every answer dropped) is named and never quoted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type MarketplaceColumnFacts, type MarketplaceColumnsResult } from '@crove/agent';
import type { MarketplaceColumnSheet } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MARKETPLACE_COLUMNS_KEEP_MS, MARKETPLACE_COLUMNS_REFUSED_KEEP_MS, marketplaceColumnsAi, proposeMarketplaceColumns } from '../src/finance-marketplace-columns-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SHEET: MarketplaceColumnSheet = {
  headerRow: 2,
  columns: [
    { index: 0, header: 'Số hiệu đơn', samples: ['9999'], buyer: false },
    { index: 1, header: '', samples: [], buyer: true },
    { index: 2, header: 'Số lượng', samples: ['9'], buyer: false },
    { index: 3, header: 'Giá bán', samples: ['9999999'], buyer: false },
  ],
};
const TWO: MarketplaceColumnSheet = { headerRow: 1, columns: [{ index: 0, header: 'A', samples: [], buyer: false }, { index: 1, header: 'B', samples: [], buyer: false }] };
const PROPOSAL: MarketplaceColumnsResult = { kind: 'proposal', assignments: [{ index: 0, field: 'orderNo' }, { index: 2, field: 'quantity' }] };

function setup(answer: ((facts: MarketplaceColumnFacts) => Promise<MarketplaceColumnsResult>) | null, budget = new DraftBudget()) {
  const asked: MarketplaceColumnFacts[] = [];
  const ai = marketplaceColumnsAi(answer ? { marketplaceColumns: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('proposeMarketplaceColumns', () => {
  it('asks the model once with the masked sheet and answers the assignments that stood', async () => {
    const { ai, asked } = setup(async () => PROPOSAL);
    expect(await proposeMarketplaceColumns(ai, ORG, USER, SHEET, 'vi')).toEqual({ ai: 'used', assignments: PROPOSAL.kind === 'proposal' ? PROPOSAL.assignments : [] });
    expect(asked).toHaveLength(1);
    // What the model is given is the sheet's columns and the language: a buyer column is the empty shell the sheet holds.
    expect(asked[0]).toEqual({ language: 'vi', columns: SHEET.columns });
    expect(asked[0]?.columns.find((c) => c.buyer)).toEqual({ index: 1, header: '', samples: [], buyer: true });
  });

  it('asks no model when there is no sheet or fewer than three columns to show', async () => {
    const { ai, asked } = setup(async () => PROPOSAL);
    expect(await proposeMarketplaceColumns(ai, ORG, USER, null, 'vi')).toEqual({ ai: 'none', assignments: [] });
    expect(await proposeMarketplaceColumns(ai, ORG, USER, TWO, 'vi')).toEqual({ ai: 'none', assignments: [] });
    expect(asked).toEqual([]);
  });

  it('answers off with no model, busy when calls are too frequent, and budget when the AI budget is spent', async () => {
    expect(await proposeMarketplaceColumns(setup(null).ai, ORG, USER, SHEET, 'vi')).toEqual({ ai: 'off', assignments: [] });
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 });
    const { ai } = setup(async () => PROPOSAL, tight);
    const other = { ...SHEET, headerRow: 3, columns: SHEET.columns.map((c) => (c.index === 3 ? { ...c, header: 'Giá khác' } : c)) };
    expect((await proposeMarketplaceColumns(ai, ORG, USER, SHEET, 'vi')).ai).toBe('used');
    expect(await proposeMarketplaceColumns(ai, ORG, USER, other, 'vi')).toEqual({ ai: 'busy', assignments: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await proposeMarketplaceColumns(spent.ai, ORG, USER, SHEET, 'vi')).toEqual({ ai: 'budget', assignments: [] });
  });

  it('keeps an answer by its facts for a while, and a refusal for a shorter one, and logs a code never the words', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let at = 1_000_000;
    const now = () => at;
    const good = setup(async () => PROPOSAL);
    await proposeMarketplaceColumns(good.ai, ORG, USER, SHEET, 'vi', now);
    at += MARKETPLACE_COLUMNS_KEEP_MS - 1;
    expect((await proposeMarketplaceColumns(good.ai, ORG, USER, SHEET, 'vi', now)).ai).toBe('used');
    expect(good.asked).toHaveLength(1);
    at += 2;
    await proposeMarketplaceColumns(good.ai, ORG, USER, SHEET, 'vi', now);
    expect(good.asked).toHaveLength(2);
    const refused = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    expect(await proposeMarketplaceColumns(refused.ai, ORG, USER, SHEET, 'vi', now)).toEqual({ ai: 'failed', assignments: [] });
    at += MARKETPLACE_COLUMNS_REFUSED_KEEP_MS - 1;
    expect((await proposeMarketplaceColumns(refused.ai, ORG, USER, SHEET, 'vi', now)).ai).toBe('failed');
    expect(refused.asked).toHaveLength(1);
    const broken = setup(async () => {
      throw new Error('a planted model message');
    });
    expect(await proposeMarketplaceColumns(broken.ai, ORG, USER, SHEET, 'en')).toEqual({ ai: 'failed', assignments: [] });
    expect(JSON.stringify(error.mock.calls)).not.toContain('planted');
  });
});
