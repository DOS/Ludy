// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's notes on the AMIS preview, on the API side (#3904, S5 of #3854): code takes the set of blocker kinds on the list, nothing blocked asks no model, the model is asked once with the kinds
// and nothing else (no count, voucher or item), an answer is kept, and every state with no notes (no model, a spent budget, too many calls, a failed call or every note dropped) is named and never quoted. The
// kinds the agent names are the kinds the preview can name, and the notes never touch the preview itself.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, MISA_AMIS_BLOCKER_KINDS, type MisaAmisBlockerNotesFacts, type MisaAmisBlockerNotesResult } from '@crove/agent';
import { MISA_AMIS_BLOCKERS, type MisaAmisPreview, type MisaAmisPreviewItem } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MISA_AMIS_BLOCKER_NOTES_KEEP_MS, MISA_AMIS_BLOCKER_NOTES_REFUSED_KEEP_MS, explainMisaAmisBlockers, misaAmisBlockerKinds, misaAmisBlockerNotesAi } from '../src/finance-misa-amis-blocker-notes-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const item = (voucherNo: string, blockers: Array<MisaAmisPreviewItem['blockers'][number]>): MisaAmisPreviewItem => ({
  sourceId: '33333333-3333-4333-8333-333333333333',
  voucherNo,
  amisType: 17,
  reftype: 330,
  reasonTypeId: null,
  parts: 1,
  lines: 2,
  total: blockers.length === 0 ? '1000000' : '0',
  blockers,
  blockersMore: 0,
});
const preview = (items: MisaAmisPreviewItem[]): MisaAmisPreview => ({ kind: 'purchase_services', vouchers: items.length, ready: items.filter((i) => i.blockers.length === 0).length, blocked: items.filter((i) => i.blockers.length > 0).length, checkedAgainstAmis: false, matchCheck: { state: 'none', failure: null, requestedAt: null, checkedAt: null }, purchasePurpose: '1', more: false, digest: 'd'.repeat(64), items });
const BLOCKED = preview([item('CRMDV000000001', [{ code: 'vat_rate_unmapped', lineNo: 2 }, { code: 'item_code_unknown', lineNo: 1 }, { code: 'item_code_unknown', lineNo: 2 }]), item('CRMDV000000002', [{ code: 'vat_rate_unmapped', lineNo: 1 }])]);
const CLEAN = preview([item('CRMDV000000003', [])]);
const NOTES: MisaAmisBlockerNotesResult = { kind: 'notes', notes: [{ kind: 'item_code_unknown', text: 'Dòng chưa có mã hàng AMIS: hãy nhập mã hàng AMIS trong Ludy.' }, { kind: 'vat_rate_unmapped', text: 'Thuế suất của dòng không nằm trong số AMIS nhận: hãy sửa thuế suất trong Ludy.' }] };
const WRITTEN = [{ code: 'item_code_unknown', text: NOTES.kind === 'notes' ? (NOTES.notes[0]?.text ?? '') : '' }, { code: 'vat_rate_unmapped', text: NOTES.kind === 'notes' ? (NOTES.notes[1]?.text ?? '') : '' }];

function setup(answer: ((facts: MisaAmisBlockerNotesFacts) => Promise<MisaAmisBlockerNotesResult>) | null, budget = new DraftBudget()) {
  const asked: MisaAmisBlockerNotesFacts[] = [];
  const ai = misaAmisBlockerNotesAi(answer ? { misaAmisBlockerNotes: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('the kinds', () => {
  it('are the kinds of blocker the preview can name, in one list', () => {
    expect([...MISA_AMIS_BLOCKER_KINDS]).toEqual([...MISA_AMIS_BLOCKERS]);
  });

  it('are the set on the list, each once and in the agent order, and tell the model nothing but the language and them', () => {
    expect(misaAmisBlockerKinds(BLOCKED)).toEqual(['item_code_unknown', 'vat_rate_unmapped']);
    expect(misaAmisBlockerKinds(CLEAN)).toEqual([]);
  });
});

describe('explainMisaAmisBlockers', () => {
  it('asks the model once with the kinds only and answers the notes', async () => {
    const { ai, asked } = setup(async () => NOTES);
    expect(await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi')).toEqual({ ai: 'used', notes: WRITTEN });
    expect(asked).toEqual([{ language: 'vi', kinds: ['item_code_unknown', 'vat_rate_unmapped'] }]);
    expect(JSON.stringify(asked)).not.toContain('CRMDV');
  });

  it('makes no call when nothing is blocked, and says off with no call when the deployment has no model', async () => {
    const { ai, asked } = setup(async () => NOTES);
    expect(await explainMisaAmisBlockers(ai, ORG, USER, CLEAN, 'vi')).toEqual({ ai: 'none', notes: [] });
    expect(asked).toEqual([]);
    expect(await explainMisaAmisBlockers(setup(null).ai, ORG, USER, BLOCKED, 'vi')).toEqual({ ai: 'off', notes: [] });
  });

  it('never changes the preview it is given', async () => {
    const before = JSON.stringify(BLOCKED);
    await explainMisaAmisBlockers(setup(async () => NOTES).ai, ORG, USER, BLOCKED, 'vi');
    expect(JSON.stringify(BLOCKED)).toBe(before);
  });

  it('keeps an answer by its kinds for a while, so reopening the preview does not pay twice', async () => {
    const { ai, asked } = setup(async () => NOTES);
    const now = 1_000;
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now);
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now + MISA_AMIS_BLOCKER_NOTES_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Other kinds, another language or another org are asked again; the same kinds with other counts are not (the model is told no count).
    await explainMisaAmisBlockers(ai, ORG, USER, preview([item('CRMDV000000009', [{ code: 'no_lines', lineNo: null }])]), 'vi', () => now + MISA_AMIS_BLOCKER_NOTES_KEEP_MS + 2);
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'en', () => now + MISA_AMIS_BLOCKER_NOTES_KEEP_MS + 3);
    await explainMisaAmisBlockers(ai, '44444444-4444-4444-8444-444444444444', USER, BLOCKED, 'vi', () => now + MISA_AMIS_BLOCKER_NOTES_KEEP_MS + 4);
    expect(asked).toHaveLength(5);
    const more = preview([item('CRMDV000000010', [{ code: 'vat_rate_unmapped', lineNo: 1 }, { code: 'item_code_unknown', lineNo: 1 }, { code: 'item_code_unknown', lineNo: 2 }, { code: 'item_code_unknown', lineNo: 3 }])]);
    await explainMisaAmisBlockers(ai, ORG, USER, more, 'en', () => now + MISA_AMIS_BLOCKER_NOTES_KEEP_MS + 5);
    expect(asked).toHaveLength(5);
  });

  it('keeps a refusal for a shorter while, and never keeps a transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    const now = 1_000;
    expect(await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now)).toEqual({ ai: 'failed', notes: [] });
    expect(await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now + 1000)).toEqual({ ai: 'failed', notes: [] });
    expect(asked).toHaveLength(1);
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi', () => now + MISA_AMIS_BLOCKER_NOTES_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(MISA_AMIS_BLOCKER_NOTES_REFUSED_KEEP_MS).toBeLessThan(MISA_AMIS_BLOCKER_NOTES_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainMisaAmisBlockers(failing.ai, ORG, USER, BLOCKED, 'vi', () => now);
    await explainMisaAmisBlockers(failing.ai, ORG, USER, BLOCKED, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a failed call and a spent budget, with no notes and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = setup(async () => {
      throw new Error('upstream said: CRMDV000000001 vat_rate_unmapped');
    });
    expect(await explainMisaAmisBlockers(failed.ai, ORG, USER, BLOCKED, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainMisaAmisBlockers(spent.ai, ORG, USER, BLOCKED, 'vi')).toEqual({ ai: 'budget', notes: [] });
    expect(JSON.stringify(error.mock.calls)).not.toContain('CRMDV');
    expect(JSON.stringify(error.mock.calls)).not.toContain('vat_rate_unmapped');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => NOTES, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainMisaAmisBlockers(ai, ORG, USER, BLOCKED, 'vi');
    expect(await explainMisaAmisBlockers(ai, ORG, USER, preview([item('CRMDV000000011', [{ code: 'no_lines', lineNo: null }])]), 'vi')).toEqual({ ai: 'busy', notes: [] });
    expect(asked).toHaveLength(1);
  });
});
