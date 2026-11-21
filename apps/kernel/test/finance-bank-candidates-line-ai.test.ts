// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's one sentence on an open bank line the matcher could not settle (#4219), on the API side: code reads the matcher's candidates, a line with nothing open to choice asks no model, the model is asked
// once with the direction, date, amount and the number of candidates (no name), an answer is kept, and every state with no text is named and never quoted. A stub model stands in for the real one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type BankCandidatesLineFacts, type BankCandidatesLineResult } from '@ludy/agent';
import type { BankLineCandidate, BankLineVoucher } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { BANK_CANDIDATES_LINE_KEEP_MS, BANK_CANDIDATES_LINE_REFUSED_KEEP_MS, bankCandidatesLineAi, bankCandidatesLineFacts, explainBankCandidatesLine } from '../src/finance-bank-candidates-line-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const candidate = (n: number): BankLineCandidate => ({ party: { id: id(n), name: `Customer ${n}`, taxCode: null }, reason: 'balance' });
const read = (over: Partial<BankLineVoucher> & { amount?: string; status?: 'open' | 'proposed' } = {}): BankLineVoucher => {
  const { amount, status, ...rest } = over;
  return {
    bankAccount: '1121',
    line: { id: id(1), date: '2026-11-05', description: 'CK tien hang', amount: amount ?? '4500000', balance: null, reference: null, ambiguous: false, importId: id(2), state: status === 'proposed' ? { status: 'proposed', proposalId: id(3) } : { status: 'open' } },
    voucher: null,
    suggested: null,
    candidates: [candidate(10), candidate(11), candidate(12)],
    ...rest,
  };
};
const SAID: BankCandidatesLineResult = { kind: 'sentence', text: 'Ngày 05/11/2026 có 3 ứng viên cho khoản 4.500.000 đồng, cần một người chọn.' };

function setup(answer: ((facts: BankCandidatesLineFacts) => Promise<BankCandidatesLineResult>) | null, budget = new DraftBudget()) {
  const asked: BankCandidatesLineFacts[] = [];
  const ai = bankCandidatesLineAi(answer ? { bankCandidatesLineSentence: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('bankCandidatesLineFacts', () => {
  it('tells the model only the direction, date, amount, count and language, never a name', () => {
    const facts = bankCandidatesLineFacts(read(), 'vi');
    expect(facts).toEqual({ language: 'vi', direction: 'in', date: '2026-11-05', amount: '4500000', candidates: 3 });
    expect(JSON.stringify(facts)).not.toContain('Customer');
    expect(bankCandidatesLineFacts(read({ amount: '-4500000' }), 'en')?.direction).toBe('out');
  });

  it('has none for a line that is not open, has no candidate, has one that stands out, or has fractions of a dong', () => {
    expect(bankCandidatesLineFacts(read({ status: 'proposed' }), 'vi')).toBeNull();
    expect(bankCandidatesLineFacts(read({ candidates: [] }), 'vi')).toBeNull();
    expect(bankCandidatesLineFacts(read({ candidates: [candidate(10)], suggested: candidate(10) }), 'vi')).toBeNull();
    expect(bankCandidatesLineFacts(read({ amount: '4500000.50' }), 'vi')).toBeNull();
    // One candidate and none chosen is open to choice.
    expect(bankCandidatesLineFacts(read({ candidates: [candidate(10)] }), 'vi')?.candidates).toBe(1);
  });
});

describe('explainBankCandidatesLine', () => {
  it('asks the model once and answers with its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainBankCandidatesLine(ai, ORG, USER, read(), 'vi')).toEqual({ ai: 'used', text: SAID.text });
    expect(asked).toEqual([{ language: 'vi', direction: 'in', date: '2026-11-05', amount: '4500000', candidates: 3 }]);
  });

  it('makes no call for a line with nothing to choose, and says off with no call when the deployment has no model', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainBankCandidatesLine(ai, ORG, USER, read({ candidates: [] }), 'vi')).toEqual({ ai: 'none', text: null });
    expect(asked).toEqual([]);
    expect(await explainBankCandidatesLine(setup(null).ai, ORG, USER, read(), 'vi')).toEqual({ ai: 'off', text: null });
  });

  it('keeps an answer by its facts for a while, and keeps a refusal for a shorter while', async () => {
    const { ai, asked } = setup(async () => SAID);
    await explainBankCandidatesLine(ai, ORG, USER, read(), 'vi', () => 1_000);
    await explainBankCandidatesLine(ai, ORG, USER, read(), 'vi', () => 2_000);
    expect(asked).toHaveLength(1);
    await explainBankCandidatesLine(ai, ORG, USER, read(), 'vi', () => 1_000 + BANK_CANDIDATES_LINE_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    const refused = setup(async () => ({ kind: 'none', code: 'PICK' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await explainBankCandidatesLine(refused.ai, ORG, USER, read(), 'vi', () => 0)).toEqual({ ai: 'failed', text: null });
    expect(await explainBankCandidatesLine(refused.ai, ORG, USER, read(), 'vi', () => 1)).toEqual({ ai: 'failed', text: null });
    expect(refused.asked).toHaveLength(1);
    await explainBankCandidatesLine(refused.ai, ORG, USER, read(), 'vi', () => BANK_CANDIDATES_LINE_REFUSED_KEEP_MS + 1);
    expect(refused.asked).toHaveLength(2);
  });

  it('names the state and never quotes: a spent budget, too many calls, a failed call', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await explainBankCandidatesLine(setup(async () => { throw new AiBudgetExhaustedError('org', null); }).ai, ORG, USER, read(), 'vi')).toEqual({ ai: 'budget', text: null });
    expect(await explainBankCandidatesLine(setup(async () => { throw new Error('boom Customer 10'); }).ai, ORG, USER, read(), 'vi')).toEqual({ ai: 'failed', text: null });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Customer');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainBankCandidatesLine(ai, ORG, USER, read(), 'vi');
    expect(await explainBankCandidatesLine(ai, ORG, USER, read({ amount: '5000000' }), 'vi')).toEqual({ ai: 'busy', text: null });
    expect(asked).toHaveLength(1);
  });
});
