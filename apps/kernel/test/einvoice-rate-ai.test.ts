// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's explanation of a correction's VAT rate, on the API side (#3709): the code's proposal always comes back untouched, the model is asked once with the facts, a text is kept, and
// every state with no text (no model, a spent budget, too many calls, a failed or refused call) is named, never quoted, so the screen works with AI off.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type EInvoiceRateFacts, type EInvoiceRateResult } from '@ludy/agent';
import type { EInvoiceCorrectionRate } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { EINVOICE_RATE_KEEP_MS, EINVOICE_RATE_REFUSED_KEEP_MS, einvoiceRateAi, einvoiceRateFacts, explainCorrectionRate } from '../src/einvoice-rate-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const RATE: EInvoiceCorrectionRate = {
  nature: 'amount_change',
  basis: 'correction_date',
  originalDate: '2026-11-20',
  correctionDate: '2027-01-10',
  reasonCode: 'amount_change_standard',
  changes: [{ from: '8%', to: '10%' }],
  kept: ['5%'],
  reducedUntil: '2026-12-31',
  reason: 'Lý do do mã viết.',
  precedentNote: 'Ghi chú tiền lệ.',
};
const SAID: EInvoiceRateResult = { kind: 'sentence', text: 'Dòng 8% chuyển sang 10% vì ngày lập sau 31/12/2026.' };

function setup(answer: ((facts: EInvoiceRateFacts) => Promise<EInvoiceRateResult>) | null, budget = new DraftBudget()) {
  const asked: EInvoiceRateFacts[] = [];
  const ai = einvoiceRateAi(answer ? { einvoiceRateExplanation: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('explainCorrectionRate', () => {
  it('asks the model once with the facts and adds its sentence to the code\'s proposal, which is returned as it was', async () => {
    const { ai, asked } = setup(async () => SAID);
    const out = await explainCorrectionRate(ai, ORG, USER, RATE);
    expect(out).toEqual({ ...RATE, ai: 'used', explanation: SAID.text });
    expect(asked).toEqual([einvoiceRateFacts(RATE)]);
  });

  it('tells the model only the nature, the dates and the rates', () => {
    expect(Object.keys(einvoiceRateFacts(RATE)).sort()).toEqual(['basis', 'changes', 'correctionDate', 'kept', 'nature', 'originalDate', 'reducedUntil']);
  });

  it('says off with no call and no words when the deployment has no model: the proposal, its reason and the note are all there', async () => {
    const { ai } = setup(null);
    expect(await explainCorrectionRate(ai, ORG, USER, RATE)).toEqual({ ...RATE, ai: 'off', explanation: null });
  });

  it('names a spent budget, too frequent calls, a failure and a refusal, and quotes none of them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainCorrectionRate(spent.ai, ORG, USER, RATE)).toMatchObject({ ai: 'budget', explanation: null, basis: 'correction_date' });
    const broken = setup(async () => {
      throw new Error('secret model text 12345');
    });
    expect(await explainCorrectionRate(broken.ai, ORG, USER, RATE)).toMatchObject({ ai: 'failed', explanation: null });
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await explainCorrectionRate(refused.ai, ORG, USER, RATE)).toMatchObject({ ai: 'refused', explanation: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret model text');
    const second = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, now: () => 1000 }));
    await explainCorrectionRate(second.ai, ORG, USER, RATE, () => 0);
    expect(await explainCorrectionRate(second.ai, ORG, USER, { ...RATE, correctionDate: '2027-02-01' })).toMatchObject({ ai: 'busy', explanation: null });
  });

  it('keeps an answer by its facts for a while, a refusal for a shorter while, so choosing the same nature again does not pay twice', async () => {
    let now = 1_000_000;
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));
    await explainCorrectionRate(ai, ORG, USER, RATE, () => now);
    now += EINVOICE_RATE_KEEP_MS - 1;
    expect(await explainCorrectionRate(ai, ORG, USER, RATE, () => now)).toMatchObject({ ai: 'used', explanation: SAID.text });
    expect(asked).toHaveLength(1);
    now += 2;
    await explainCorrectionRate(ai, ORG, USER, RATE, () => now);
    expect(asked).toHaveLength(2);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = setup(async () => ({ kind: 'none', code: 'RATE' }), new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));
    now = 5_000_000;
    await explainCorrectionRate(refused.ai, ORG, USER, RATE, () => now);
    now += EINVOICE_RATE_REFUSED_KEEP_MS - 1;
    expect(await explainCorrectionRate(refused.ai, ORG, USER, RATE, () => now)).toMatchObject({ ai: 'refused' });
    expect(refused.asked).toHaveLength(1);
    now += 2;
    await explainCorrectionRate(refused.ai, ORG, USER, RATE, () => now);
    expect(refused.asked).toHaveLength(2);
  });
});
