// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's one line on the Sàn screen, on the API side (#2516 slice E): nothing waiting asks no model, the model is asked once with the three numbers, an answer is kept, and every state with no
// text (no model, a spent budget, too many calls, a failed or refused call) is named and never quoted. The facts always come back, so the screen never shows less than the books hold.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type MarketplaceLineFacts, type MarketplaceLineResult } from '@crove/agent';
import type { MarketplaceFacts } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MARKETPLACE_LINE_KEEP_MS, MARKETPLACE_LINE_REFUSED_KEEP_MS, explainMarketplaceLine, marketplaceLineAi, marketplaceLineFacts } from '../src/finance-marketplace-line-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FACTS: MarketplaceFacts = { settlementsToPost: 2, awaitingPayout: '1600000', feesAwaitingInvoice: '120000' };
const NOTHING: MarketplaceFacts = { settlementsToPost: 0, awaitingPayout: '0', feesAwaitingInvoice: '0' };
const SAID: MarketplaceLineResult = { kind: 'sentence', text: 'Có 2 kỳ đối soát đang chờ ghi sổ.' };

function setup(answer: ((facts: MarketplaceLineFacts) => Promise<MarketplaceLineResult>) | null, budget = new DraftBudget()) {
  const asked: MarketplaceLineFacts[] = [];
  const ai = marketplaceLineAi(answer ? { marketplaceLineSentence: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('explainMarketplaceLine', () => {
  it('asks the model once with the three numbers and answers the facts with its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi')).toEqual({ facts: FACTS, ai: 'used', text: SAID.text });
    expect(asked).toEqual([{ language: 'vi', settlementsToPost: 2, awaitingPayout: '1600000', feesAwaitingInvoice: '120000' }]);
  });

  it('tells the model only the three numbers and the language', () => {
    expect(Object.keys(marketplaceLineFacts(FACTS, 'en')).sort()).toEqual(['awaitingPayout', 'feesAwaitingInvoice', 'language', 'settlementsToPost']);
  });

  it('makes no call when nothing is waiting, and says off with no call when the deployment has no model; the facts come back either way', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainMarketplaceLine(ai, ORG, USER, NOTHING, 'vi')).toEqual({ facts: NOTHING, ai: 'none', text: null });
    expect(asked).toEqual([]);
    const none = setup(null);
    expect(await explainMarketplaceLine(none.ai, ORG, USER, FACTS, 'vi')).toEqual({ facts: FACTS, ai: 'off', text: null });
  });

  it('keeps an answer by its facts for a while, so reopening the screen does not pay twice', async () => {
    const { ai, asked } = setup(async () => SAID);
    const now = 1_000;
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now);
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now + MARKETPLACE_LINE_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Other facts, another language or another org are asked again.
    await explainMarketplaceLine(ai, ORG, USER, { ...FACTS, settlementsToPost: 3 }, 'vi', () => now + MARKETPLACE_LINE_KEEP_MS + 2);
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'en', () => now + MARKETPLACE_LINE_KEEP_MS + 3);
    await explainMarketplaceLine(ai, '33333333-3333-4333-8333-333333333333', USER, FACTS, 'vi', () => now + MARKETPLACE_LINE_KEEP_MS + 4);
    expect(asked).toHaveLength(5);
  });

  it('keeps a refusal for a shorter while, so a fact set the check always refuses does not pay again on every open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'BINDING' }));
    const now = 1_000;
    expect(await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now)).toEqual({ facts: FACTS, ai: 'failed', text: null });
    expect(await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now + 1000)).toEqual({ facts: FACTS, ai: 'failed', text: null });
    expect(asked).toHaveLength(1);
    // After the shorter keep it is asked again, and a transport failure is never kept.
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi', () => now + MARKETPLACE_LINE_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(MARKETPLACE_LINE_REFUSED_KEEP_MS).toBeLessThan(MARKETPLACE_LINE_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainMarketplaceLine(failing.ai, ORG, USER, FACTS, 'vi', () => now);
    await explainMarketplaceLine(failing.ai, ORG, USER, FACTS, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a refused text, a failed call and a spent budget, with no text and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = setup(async () => ({ kind: 'none', code: 'CLAIM' }));
    expect(await explainMarketplaceLine(refused.ai, ORG, USER, FACTS, 'vi')).toEqual({ facts: FACTS, ai: 'failed', text: null });
    const failed = setup(async () => {
      throw new Error('upstream said: 1.600.000 for Shopee');
    });
    expect(await explainMarketplaceLine(failed.ai, ORG, USER, FACTS, 'vi')).toEqual({ facts: FACTS, ai: 'failed', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainMarketplaceLine(spent.ai, ORG, USER, FACTS, 'vi')).toEqual({ facts: FACTS, ai: 'budget', text: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('Shopee');
    expect(JSON.stringify(error.mock.calls)).not.toContain('1.600.000');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainMarketplaceLine(ai, ORG, USER, FACTS, 'vi');
    expect(await explainMarketplaceLine(ai, ORG, USER, { ...FACTS, settlementsToPost: 4 }, 'vi')).toEqual({ facts: { ...FACTS, settlementsToPost: 4 }, ai: 'busy', text: null });
    expect(asked).toHaveLength(1);
  });
});
