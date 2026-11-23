// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's line above the MISA export check, on the API side (#3848 slice B): code counts the findings per kind, nothing flagged asks no model, the model is asked once with the counts, an answer is kept,
// and every state with no text (no model, a spent budget, too many calls, a failed or refused call) is named and never quoted. The counts always come back, so the screen can tell which list the line belongs to.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type MisaCheckLineFacts, type MisaCheckLineResult } from '@ludy/agent';
import type { MisaCheck } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MISA_CHECK_LINE_KEEP_MS, MISA_CHECK_LINE_REFUSED_KEEP_MS, explainMisaCheckLine, misaCheckCounts, misaCheckLineAi, misaCheckLineFacts } from '../src/finance-misa-check-line-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const group = (kind: MisaCheck['groups'][number]['kind'], column: string, count: number): MisaCheck['groups'][number] => ({ kind, column, limit: null, count, examples: [{ voucherNo: 'CRMDV000000001', lineNo: 1 }] });
const CHECK: MisaCheck = {
  format: 'misa_sme_purchases',
  rows: 40,
  findings: 22,
  groups: [group('MISSING_CODE', 'Mã dịch vụ (*)', 10), group('MISSING_CODE', 'Mã nhà cung cấp', 2), group('VAT_CODE', '% thuế GTGT', 3), group('ACCOUNT_NOT_IN_CHART', 'TK chi phí/TK kho', 2), group('TOO_LONG', 'Tên nhà cung cấp', 5)],
};
const CLEAN: MisaCheck = { format: 'misa_sme_sales', rows: 7, findings: 0, groups: [] };
const SAID: MisaCheckLineResult = { kind: 'sentence', text: 'Có 12 ô mã cần điền trong file: hãy điền mã trước khi nhập.' };

function setup(answer: ((facts: MisaCheckLineFacts) => Promise<MisaCheckLineResult>) | null, budget = new DraftBudget()) {
  const asked: MisaCheckLineFacts[] = [];
  const ai = misaCheckLineAi(answer ? { misaCheckLineSentence: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('misaCheckCounts', () => {
  it('sums the findings of each kind over the groups, and keeps the rows', () => {
    expect(misaCheckCounts(CHECK)).toEqual({ rows: 40, codes: 12, required: 0, vat: 3, accounts: 2, tooLong: 5 });
    expect(misaCheckCounts(CLEAN)).toEqual({ rows: 7, codes: 0, required: 0, vat: 0, accounts: 0, tooLong: 0 });
  });

  it('tells the model only the six counts and the language', () => {
    expect(Object.keys(misaCheckLineFacts(misaCheckCounts(CHECK), 'en')).sort()).toEqual(['accounts', 'codes', 'language', 'required', 'rows', 'tooLong', 'vat']);
  });
});

describe('explainMisaCheckLine', () => {
  it('asks the model once with the counts and answers the counts with its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi')).toEqual({ counts: misaCheckCounts(CHECK), ai: 'used', text: SAID.text });
    expect(asked).toEqual([{ language: 'vi', rows: 40, codes: 12, required: 0, vat: 3, accounts: 2, tooLong: 5 }]);
  });

  it('makes no call when nothing is flagged, and says off with no call when the deployment has no model', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainMisaCheckLine(ai, ORG, USER, CLEAN, 'vi')).toEqual({ counts: misaCheckCounts(CLEAN), ai: 'none', text: null });
    expect(asked).toEqual([]);
    expect(await explainMisaCheckLine(setup(null).ai, ORG, USER, CHECK, 'vi')).toEqual({ counts: misaCheckCounts(CHECK), ai: 'off', text: null });
  });

  it('keeps an answer by its counts for a while, so reopening the check does not pay twice', async () => {
    const { ai, asked } = setup(async () => SAID);
    const now = 1_000;
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now);
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now + MISA_CHECK_LINE_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Other counts, another language or another org are asked again.
    await explainMisaCheckLine(ai, ORG, USER, { ...CHECK, groups: [group('VAT_CODE', '% thuế GTGT', 4)] }, 'vi', () => now + MISA_CHECK_LINE_KEEP_MS + 2);
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'en', () => now + MISA_CHECK_LINE_KEEP_MS + 3);
    await explainMisaCheckLine(ai, '33333333-3333-4333-8333-333333333333', USER, CHECK, 'vi', () => now + MISA_CHECK_LINE_KEEP_MS + 4);
    expect(asked).toHaveLength(5);
  });

  it('keeps a refusal for a shorter while, and never keeps a transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'BINDING' }));
    const now = 1_000;
    expect(await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now)).toMatchObject({ ai: 'failed', text: null });
    expect(await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now + 1000)).toMatchObject({ ai: 'failed', text: null });
    expect(asked).toHaveLength(1);
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi', () => now + MISA_CHECK_LINE_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(MISA_CHECK_LINE_REFUSED_KEEP_MS).toBeLessThan(MISA_CHECK_LINE_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainMisaCheckLine(failing.ai, ORG, USER, CHECK, 'vi', () => now);
    await explainMisaCheckLine(failing.ai, ORG, USER, CHECK, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a refused text, a failed call and a spent budget, with no text and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await explainMisaCheckLine(setup(async () => ({ kind: 'none', code: 'CLAIM' })).ai, ORG, USER, CHECK, 'vi')).toMatchObject({ ai: 'failed', text: null });
    const failed = setup(async () => {
      throw new Error('upstream said: Mã dịch vụ (*) 12 for CRMDV000000001');
    });
    expect(await explainMisaCheckLine(failed.ai, ORG, USER, CHECK, 'vi')).toMatchObject({ ai: 'failed', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainMisaCheckLine(spent.ai, ORG, USER, CHECK, 'vi')).toMatchObject({ ai: 'budget', text: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('CRMDV');
    expect(JSON.stringify(error.mock.calls)).not.toContain('Mã dịch vụ');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainMisaCheckLine(ai, ORG, USER, CHECK, 'vi');
    expect(await explainMisaCheckLine(ai, ORG, USER, { ...CHECK, groups: [group('VAT_CODE', '% thuế GTGT', 4)] }, 'vi')).toMatchObject({ ai: 'busy', text: null });
    expect(asked).toHaveLength(1);
  });
});
