// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's proposal of a correction's reason code, on the API side (#3690): the list and the note are checked before any call, the model is asked once with the facts, the code the answer
// names is looked up in the list again, and every state with no code (no list, no note, no model, a spent budget, too many calls, a failed or refused call) is named and never quoted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type EInvoiceReasonFacts, type EInvoiceReasonResult } from '@crove/agent';
import type { EInvoiceReasonInput, EInvoiceReasonSource } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { einvoiceReasonAi, suggestCorrectionReason } from '../src/einvoice-reason-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORIGINAL = '33333333-3333-4333-8333-333333333333';
const SOURCE: EInvoiceReasonSource = {
  codes: [
    { code: 'T-1', label: 'Sai thông tin người mua' },
    { code: 'T-2', label: 'Sai số lượng hoặc đơn giá' },
  ],
  buyerKind: 'business',
  originalDate: '2026-11-20',
  lines: [{ description: 'Hàng A', unit: 'cái', quantity: '10', vatRate: '8%' }],
};
const INPUT: EInvoiceReasonInput = { originalDraftId: ORIGINAL, kind: 'adjustment', note: 'Ghi sai số lượng, đúng là 12' };
const PROPOSAL: EInvoiceReasonResult = { kind: 'proposal', index: 1, why: 'Mô tả nói sai số lượng.' };

function setup(answer: ((facts: EInvoiceReasonFacts) => Promise<EInvoiceReasonResult>) | null, budget = new DraftBudget()) {
  const asked: EInvoiceReasonFacts[] = [];
  const ai = einvoiceReasonAi(answer ? { einvoiceReasonSuggestion: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('suggestCorrectionReason', () => {
  it('asks the model once with the list, the buyer kind, the lines and the note, and answers the code of the list by its number', async () => {
    const { ai, asked } = setup(async () => PROPOSAL);
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'used', code: 'T-2', label: 'Sai số lượng hoặc đơn giá', why: 'Mô tả nói sai số lượng.' });
    expect(asked).toEqual([{ codes: SOURCE.codes, adjustment: true, buyerKind: 'business', originalDate: '2026-11-20', lines: SOURCE.lines, note: INPUT.note }]);
    // The facts carry nothing of the buyer but the kind.
    expect(Object.keys(asked[0] as object).sort()).toEqual(['adjustment', 'buyerKind', 'codes', 'lines', 'note', 'originalDate']);
  });

  it('says a replacement is not an adjustment', async () => {
    const { ai, asked } = setup(async () => PROPOSAL);
    await suggestCorrectionReason(ai, ORG, USER, SOURCE, { ...INPUT, kind: 'replacement' });
    expect(asked[0]?.adjustment).toBe(false);
  });

  it('makes no call with no list or no note, whatever the deployment has', async () => {
    const { ai, asked } = setup(async () => PROPOSAL);
    expect(await suggestCorrectionReason(ai, ORG, USER, { ...SOURCE, codes: [] }, INPUT)).toEqual({ ai: 'no_list', code: null, label: null, why: null });
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, { ...INPUT, note: '   ' })).toEqual({ ai: 'no_note', code: null, label: null, why: null });
    const none = setup(null);
    expect(await suggestCorrectionReason(none.ai, ORG, USER, { ...SOURCE, codes: [] }, INPUT)).toMatchObject({ ai: 'no_list' });
    expect(asked).toEqual([]);
  });

  it('says off when the deployment has no model', async () => {
    const { ai } = setup(null);
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'off', code: null, label: null, why: null });
  });

  it('drops a proposal whose number is not in the list, even if the model layer let it through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai } = setup(async () => ({ kind: 'proposal', index: 5, why: 'x' }));
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'refused', code: null, label: null, why: null });
  });

  it('names a spent budget, a failure and a refusal, and quotes none of them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await suggestCorrectionReason(spent.ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'budget', code: null });
    const broken = setup(async () => {
      throw new Error('secret note text 12345');
    });
    expect(await suggestCorrectionReason(broken.ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'failed', code: null });
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await suggestCorrectionReason(refused.ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'refused', code: null });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('secret note text');
    expect(logged).not.toContain(INPUT.note);
  });

  it('says busy when the member asks too often, and gives the ticket back after each call', async () => {
    const { ai } = setup(async () => PROPOSAL, new DraftBudget({ perUserPerMinute: 1, now: () => 1000 }));
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'used' });
    expect(await suggestCorrectionReason(ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'busy', code: null });
    // Another member is not held back, and a call that failed does not keep its member waiting.
    expect(await suggestCorrectionReason(ai, ORG, 'another-user-id', SOURCE, INPUT)).toMatchObject({ ai: 'used' });
  });
});
