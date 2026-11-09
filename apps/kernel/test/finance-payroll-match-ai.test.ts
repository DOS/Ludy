// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's one line on why a bank statement line may be a payroll payment, on the API side (#2532): the model is asked once with four facts, an answer is kept, and every state with no text
// (no model, a spent budget, too many calls, a failed or refused call) is named and never quoted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type PayrollMatchFacts, type PayrollMatchResult } from '@crove/agent';
import type { BankPayrollCandidate } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { PAYROLL_MATCH_KEEP_MS, explainPayrollMatch, payrollMatchAi, payrollMatchFacts } from '../src/finance-payroll-match-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CANDIDATE: BankPayrollCandidate = { runId: '33333333-3333-4333-8333-333333333333', month: '2026-03', kind: 'tax', amount: '4200000', reason: 'amount_note' };
const SAID: PayrollMatchResult = { kind: 'sentence', text: 'Số tiền khớp khoản nộp thuế.' };

function setup(answer: ((facts: PayrollMatchFacts) => Promise<PayrollMatchResult>) | null, budget = new DraftBudget()) {
  const asked: PayrollMatchFacts[] = [];
  const ai = payrollMatchAi(answer ? { payrollMatchSentence: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('explainPayrollMatch', () => {
  it('asks the model once with the facts of the candidate and the line, and answers its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi')).toEqual({ ai: 'used', text: SAID.text });
    expect(asked).toEqual([{ language: 'vi', kind: 'tax', month: '2026-03', amount: '4200000', date: '2026-04-05', described: true }]);
  });

  it('tells the model only whether the description names the payment, never the description', () => {
    expect(payrollMatchFacts({ ...CANDIDATE, reason: 'amount' }, '2026-04-05', 'en')).toEqual({ language: 'en', kind: 'tax', month: '2026-03', amount: '4200000', date: '2026-04-05', described: false });
    expect(Object.keys(payrollMatchFacts(CANDIDATE, '2026-04-05', 'vi')).sort()).toEqual(['amount', 'date', 'described', 'kind', 'language', 'month']);
  });

  it('says none for a candidate that is no longer offered, and off with no call when the deployment has no model', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainPayrollMatch(ai, ORG, USER, null, '2026-04-05', 'vi')).toEqual({ ai: 'none', text: null });
    expect(asked).toEqual([]);
    const none = setup(null);
    expect(await explainPayrollMatch(none.ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi')).toEqual({ ai: 'off', text: null });
  });

  it('keeps an answer by its facts for a while, so reopening the screen does not pay twice', async () => {
    const { ai, asked } = setup(async () => SAID);
    let now = 1_000;
    await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi', () => now);
    await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi', () => now + PAYROLL_MATCH_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Another line date is another fact: it is asked again.
    now += 2 * PAYROLL_MATCH_KEEP_MS;
    await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-06', 'vi', () => now);
    expect(asked).toHaveLength(3);
  });

  it('names a refused text, a failed call and a spent budget, with no text and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = setup(async () => ({ kind: 'none', code: 'FIGURES' }));
    expect(await explainPayrollMatch(refused.ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi')).toEqual({ ai: 'failed', text: null });
    const failed = setup(async () => {
      throw new Error('upstream said: 4.200.000 for Nguyen Van A');
    });
    expect(await explainPayrollMatch(failed.ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi')).toEqual({ ai: 'failed', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainPayrollMatch(spent.ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi')).toEqual({ ai: 'budget', text: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('Nguyen');
    expect(JSON.stringify(error.mock.calls)).not.toContain('4.200.000');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainPayrollMatch(ai, ORG, USER, CANDIDATE, '2026-04-05', 'vi');
    expect(await explainPayrollMatch(ai, ORG, USER, { ...CANDIDATE, kind: 'union' }, '2026-04-05', 'vi')).toEqual({ ai: 'busy', text: null });
    expect(asked).toHaveLength(1);
  });
});
