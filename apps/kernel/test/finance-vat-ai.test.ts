// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence naming the late sales invoices of a VAT working, on the API side (#3540), with a stand-in for the reader: every state of `ai` is an answer with no text
// (the screen then shows the template sentence), never an error, the model is told invoice numbers and periods only, and an answer is kept by its facts so a second ask costs no call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, VAT_LATE_ASK_MAX, type VatLateFacts, type VatLateSentenceResult } from '@crove/agent';
import type { VatLateSource } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { VAT_LATE_KEEP_MS, VAT_LATE_REFUSED_KEEP_MS, explainVatLate, vatLateAgentFacts, vatLateAi, type VatLateAi } from '../src/finance-vat-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const REPORT: VatLateSource = {
  period: { period: '2026-10' },
  lateSales: [{ series: 'C26TAA', number: '0000123', originalPeriod: '2026-09', supplementary: true }],
  supplementary: { documents: [] },
};
const SAID: VatLateSentenceResult = { kind: 'sentence', text: 'Hóa đơn C26TAA-0000123 bán trong kỳ 2026-09 cần kê khai bổ sung.' };

function setup(answer: ((facts: VatLateFacts) => Promise<VatLateSentenceResult>) | null, budget = new DraftBudget()) {
  const asked: VatLateFacts[] = [];
  const ai: VatLateAi = vatLateAi(
    answer
      ? {
          vatLateSentence: async (facts) => {
            asked.push(facts);
            return answer(facts);
          },
        }
      : null,
    budget,
  );
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('vatLateAgentFacts', () => {
  it('carries the invoice numbers, periods and two yes/no facts, and nothing else', () => {
    expect(vatLateAgentFacts(REPORT, 'vi')).toEqual({ language: 'vi', items: [{ number: 'C26TAA-0000123', period: '2026-09', supplementary: true, issuedHere: true }] });
  });
});

describe('explainVatLate', () => {
  it('asks the model once with the lists and answers its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainVatLate(ai, ORG, USER, REPORT, 'vi')).toEqual({ ai: 'used', text: SAID.kind === 'sentence' ? SAID.text : null });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.items[0]?.number).toBe('C26TAA-0000123');
  });

  it('says off, with no text and no call, when the deployment has no model', async () => {
    const { ai, asked } = setup(null);
    expect(await explainVatLate(ai, ORG, USER, REPORT, 'vi')).toEqual({ ai: 'off', text: null });
    expect(asked).toEqual([]);
  });

  it('says quiet, with no call, when nothing is late or more is late than the model is asked about', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainVatLate(ai, ORG, USER, { ...REPORT, lateSales: [] }, 'vi')).toEqual({ ai: 'quiet', text: null });
    const many = Array.from({ length: VAT_LATE_ASK_MAX + 1 }, (_, i) => ({ series: 'A', number: String(i), originalPeriod: '2026-09', supplementary: false }));
    expect(await explainVatLate(ai, ORG, USER, { ...REPORT, lateSales: many }, 'vi')).toEqual({ ai: 'quiet', text: null });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by its lists: the same ask within the time costs no call, a later one does', async () => {
    let at = 1_000;
    const { ai, asked } = setup(async () => SAID);
    await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at);
    at += VAT_LATE_KEEP_MS - 1;
    expect((await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at)).ai).toBe('used');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at);
    expect(asked).toHaveLength(2);
    // Another org, another language and other lists are other answers.
    await explainVatLate(ai, 'org-2', USER, REPORT, 'vi', () => at);
    await explainVatLate(ai, ORG, USER, REPORT, 'en', () => at);
    await explainVatLate(ai, ORG, USER, { ...REPORT, lateSales: [{ series: 'C26TAA', number: '0000124', originalPeriod: '2026-09', supplementary: false }] }, 'vi', () => at);
    expect(asked).toHaveLength(5);
  });

  it("says busy when the member asks too often, and budget when the org's AI budget is spent", async () => {
    const tight = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup(async () => SAID, tight);
    expect((await explainVatLate(first.ai, ORG, USER, REPORT, 'vi')).ai).toBe('used');
    expect(await explainVatLate(first.ai, ORG, USER, { ...REPORT, lateSales: [{ series: 'C', number: '9', originalPeriod: '2026-08', supplementary: true }] }, 'vi')).toEqual({ ai: 'busy', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await explainVatLate(spent.ai, ORG, USER, REPORT, 'vi')).toEqual({ ai: 'budget', text: null });
  });

  it('keeps a refusal for a shorter time, so the same refused lists do not pay for the model on every refetch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let at = 1_000;
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'NAMES' }));
    expect((await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at)).ai).toBe('failed');
    at += VAT_LATE_REFUSED_KEEP_MS - 1;
    expect((await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at)).ai).toBe('failed');
    expect(asked).toHaveLength(1);
    at += 2;
    await explainVatLate(ai, ORG, USER, REPORT, 'vi', () => at);
    expect(asked).toHaveLength(2);
  });

  it('says failed, with no text, when the call fails or its text was refused, and logs only a name', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = setup(async () => ({ kind: 'none', code: 'NAMES' }));
    expect(await explainVatLate(refused.ai, ORG, USER, REPORT, 'vi')).toEqual({ ai: 'failed', text: null });
    const broken = setup(async () => {
      throw new Error('boom: C26TAA-0000123');
    });
    expect(await explainVatLate(broken.ai, ORG, USER, REPORT, 'vi')).toEqual({ ai: 'failed', text: null });
    expect(log.mock.calls.flat().join(' ')).not.toContain('C26TAA-0000123');
  });
});
