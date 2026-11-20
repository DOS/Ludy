// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's explanation of a count's surplus, on the API side (#3712 slice 2b): the code's facts always come back untouched, the model is asked once with the facts only (no party id,
// no voucher, no proposal), a text is kept, and every state with no text (no model, a spent budget, too many calls, a failed or refused call) is named, never quoted, so the screen works with AI off.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type StockSurplusFacts, type StockSurplusResult } from '@crove/agent';
import type { StockSurplusSource } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { STOCK_SURPLUS_KEEP_MS, STOCK_SURPLUS_REFUSED_KEEP_MS, explainSurplus, stockSurplusAi, stockSurplusFacts } from '../src/stock-surplus-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SOURCE: StockSurplusSource = {
  countId: '33333333-3333-4333-8333-333333333333',
  countDate: '2026-09-30',
  total: '1500000',
  items: [{ name: 'Áo thun trắng', quantity: '3', unit: 'cái', value: '900000' }],
  moreItems: 0,
  supplier: { partyId: '44444444-4444-4444-8444-444444444444', name: 'Công ty Cung ứng Mẫu', lastReceived: '2026-09-12' },
  manualEntry: true,
  voucherId: null,
  proposalId: '55555555-5555-4555-8555-555555555555',
};
const SAID: StockSurplusResult = { kind: 'sentence', text: 'Hàng thừa trị giá 1.500.000 đồng đang chờ xử lý.' };

function setup(answer: ((facts: StockSurplusFacts) => Promise<StockSurplusResult>) | null, budget = new DraftBudget()) {
  const asked: StockSurplusFacts[] = [];
  const ai = stockSurplusAi(answer ? { stockSurplusNote: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('explainSurplus', () => {
  it('asks the model once with the facts and adds its sentence to the code\'s source, which is returned as it was', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainSurplus(ai, ORG, USER, SOURCE, 'vi')).toEqual({ ...SOURCE, ai: 'used', explanation: SAID.text });
    expect(asked).toEqual([stockSurplusFacts(SOURCE, 'vi')]);
  });

  it('tells the model no id, voucher, proposal or flag, and the supplier only by name and date', () => {
    const facts = stockSurplusFacts(SOURCE, 'en');
    expect(Object.keys(facts).sort()).toEqual(['countDate', 'items', 'language', 'moreItems', 'supplier', 'total']);
    expect(Object.keys(facts.items[0] ?? {}).sort()).toEqual(['name', 'quantity', 'unit']);
    expect(facts.supplier).toEqual({ name: 'Công ty Cung ứng Mẫu', lastReceived: '2026-09-12' });
    expect(JSON.stringify(facts)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('says off with no call and no words when the deployment has no model: the facts are all there', async () => {
    expect(await explainSurplus(setup(null).ai, ORG, USER, SOURCE, 'vi')).toEqual({ ...SOURCE, ai: 'off', explanation: null });
  });

  it('names a spent budget, too frequent calls, a failure and a refusal, and quotes none of them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainSurplus(spent.ai, ORG, USER, SOURCE, 'vi')).toMatchObject({ ai: 'budget', explanation: null, total: '1500000' });
    const broken = setup(async () => {
      throw new Error('secret model text 12345');
    });
    expect(await explainSurplus(broken.ai, ORG, USER, SOURCE, 'vi')).toMatchObject({ ai: 'failed', explanation: null });
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await explainSurplus(refused.ai, ORG, USER, SOURCE, 'vi')).toMatchObject({ ai: 'refused', explanation: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret model text');
    const second = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, now: () => 1000 }));
    await explainSurplus(second.ai, ORG, USER, SOURCE, 'vi', () => 0);
    expect(await explainSurplus(second.ai, ORG, USER, { ...SOURCE, total: '2000000' }, 'vi')).toMatchObject({ ai: 'busy', explanation: null });
  });

  it('keeps an answer by its facts and language for a while, a refusal for a shorter while', async () => {
    let now = 1_000_000;
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));
    await explainSurplus(ai, ORG, USER, SOURCE, 'vi', () => now);
    now += STOCK_SURPLUS_KEEP_MS - 1;
    expect(await explainSurplus(ai, ORG, USER, SOURCE, 'vi', () => now)).toMatchObject({ ai: 'used', explanation: SAID.text });
    expect(asked).toHaveLength(1);
    await explainSurplus(ai, ORG, USER, SOURCE, 'en', () => now);
    expect(asked).toHaveLength(2);
    now += 2;
    await explainSurplus(ai, ORG, USER, SOURCE, 'vi', () => now);
    expect(asked).toHaveLength(3);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = setup(async () => ({ kind: 'none', code: 'CLAIM' }), new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));
    now = 5_000_000;
    await explainSurplus(refused.ai, ORG, USER, SOURCE, 'vi', () => now);
    now += STOCK_SURPLUS_REFUSED_KEEP_MS - 1;
    expect(await explainSurplus(refused.ai, ORG, USER, SOURCE, 'vi', () => now)).toMatchObject({ ai: 'refused' });
    expect(refused.asked).toHaveLength(1);
    now += 2;
    await explainSurplus(refused.ai, ORG, USER, SOURCE, 'vi', () => now);
    expect(refused.asked).toHaveLength(2);
  });
});
