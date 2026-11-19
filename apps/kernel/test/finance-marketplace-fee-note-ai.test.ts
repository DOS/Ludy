// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's notes under the Sàn table, on the API side (#3711 slice 7): code takes the platforms whose fees still wait on 331 and numbers them, nothing waiting asks no model, the model is asked once with
// the row facts and no platform, an answer is kept and mapped back to the platform of THIS balance, and every state with no notes (no model, a spent budget, too many calls, a failed call or every note dropped) is
// named and never quoted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type MarketplaceFeeNoteFacts, type MarketplaceFeeNotesResult } from '@ludy/agent';
import type { MarketplaceBalance } from '@ludy/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { MARKETPLACE_FEE_NOTE_KEEP_MS, MARKETPLACE_FEE_NOTE_REFUSED_KEEP_MS, explainMarketplaceFees, feeNoteRows, marketplaceFeeNoteAi } from '../src/finance-marketplace-fee-note-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';
const row = (platform: string, platformName: string, fees: string, age: number | null, overdue: boolean): MarketplaceBalance['rows'][number] => ({
  legalEntityId: ENTITY,
  platform,
  platformName,
  salesPosted: '5000000',
  paidOut: '4000000',
  awaitingPayout: '1000000',
  feesAwaitingInvoice: fees,
  oldestFeeDate: age === null ? null : '2026-09-01',
  feesAgeDays: age,
  feesOverdue: overdue,
});
const BALANCE: MarketplaceBalance = { rows: [row('shopee', 'Gian hàng Canary', '1200000', 51, true), row('lazada', 'Lazada của Canary', '0', null, false), row('tiktok', 'TikTok Shop', '350000', 12, false)] };
const QUIET: MarketplaceBalance = { rows: [row('shopee', 'Gian hàng Canary', '0', null, false)] };
const NOTES: MarketplaceFeeNotesResult = { kind: 'notes', notes: [{ row: 1, text: 'Phí 1.200.000 đồng chờ 51 ngày, quá chu kỳ 45 ngày: hãy xin hóa đơn phí từ sàn hoặc nhập hóa đơn.' }, { row: 2, text: 'Phí 350.000 đồng đang chờ hóa đơn phí: hãy nhập hóa đơn khi sàn gửi.' }] };

function setup(answer: ((facts: MarketplaceFeeNoteFacts) => Promise<MarketplaceFeeNotesResult>) | null, budget = new DraftBudget()) {
  const asked: MarketplaceFeeNoteFacts[] = [];
  const ai = marketplaceFeeNoteAi(answer ? { marketplaceFeeNotes: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('feeNoteRows', () => {
  it('takes the platforms with fees waiting and an age, in the order of the balance', () => {
    expect(feeNoteRows(BALANCE).map((r) => [r.platform, r.fees, r.ageDays, r.overdue])).toEqual([['shopee', '1200000', 51, true], ['tiktok', '350000', 12, false]]);
    expect(feeNoteRows(QUIET)).toEqual([]);
    expect(feeNoteRows({ rows: [row('shopee', 'x', '0.4', 3, false)] })).toEqual([]);
  });
});

describe('explainMarketplaceFees', () => {
  it('asks the model once with the row facts and no platform, and answers each note beside its platform', async () => {
    const { ai, asked } = setup(async () => NOTES);
    const out = await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi');
    expect(out).toEqual({ ai: 'used', notes: [{ legalEntityId: ENTITY, platform: 'shopee', text: NOTES.kind === 'notes' ? NOTES.notes[0]?.text : '' }, { legalEntityId: ENTITY, platform: 'tiktok', text: NOTES.kind === 'notes' ? NOTES.notes[1]?.text : '' }] });
    expect(asked).toEqual([{ language: 'vi', cycleDays: 45, rows: [{ fees: '1200000', ageDays: 51, overdue: true }, { fees: '350000', ageDays: 12, overdue: false }] }]);
    const sent = JSON.stringify(asked);
    for (const secret of ['Canary', 'shopee', 'tiktok', ENTITY]) expect(sent).not.toContain(secret);
  });

  it('makes no call when no fee waits, and says off with no call when the deployment has no model', async () => {
    const { ai, asked } = setup(async () => NOTES);
    expect(await explainMarketplaceFees(ai, ORG, USER, QUIET, 45, 'vi')).toEqual({ ai: 'none', notes: [] });
    expect(asked).toEqual([]);
    expect(await explainMarketplaceFees(setup(null).ai, ORG, USER, BALANCE, 45, 'vi')).toEqual({ ai: 'off', notes: [] });
  });

  it('keeps an answer by its facts for a while, and maps it to the platforms of the balance it is given', async () => {
    const { ai, asked } = setup(async () => NOTES);
    const now = 1_000;
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi', () => now);
    // The same facts for other platforms (another entity's rows in the same order) reuse the answer, mapped to THEIR platforms.
    const other: MarketplaceBalance = { rows: [{ ...row('lazada', 'L', '1200000', 51, true), legalEntityId: '44444444-4444-4444-8444-444444444444' }, row('sendo', 'S', '350000', 12, false)] };
    const again = await explainMarketplaceFees(ai, ORG, USER, other, 45, 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    expect(again.notes.map((n) => [n.legalEntityId, n.platform])).toEqual([['44444444-4444-4444-8444-444444444444', 'lazada'], [ENTITY, 'sendo']]);
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi', () => now + MARKETPLACE_FEE_NOTE_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Another language, another org, other facts or another cycle length are asked again.
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'en', () => now + MARKETPLACE_FEE_NOTE_KEEP_MS + 2);
    await explainMarketplaceFees(ai, '55555555-5555-4555-8555-555555555555', USER, BALANCE, 45, 'vi', () => now + MARKETPLACE_FEE_NOTE_KEEP_MS + 3);
    await explainMarketplaceFees(ai, ORG, USER, { rows: [row('shopee', 'x', '999000', 3, false)] }, 45, 'vi', () => now + MARKETPLACE_FEE_NOTE_KEEP_MS + 4);
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 30, 'vi', () => now + MARKETPLACE_FEE_NOTE_KEEP_MS + 5);
    expect(asked).toHaveLength(6);
  });

  it('keeps a refusal for a shorter while, and never keeps a transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    const now = 1_000;
    expect(await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi', () => now)).toEqual({ ai: 'failed', notes: [] });
    expect(await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi', () => now + 1000)).toEqual({ ai: 'failed', notes: [] });
    expect(asked).toHaveLength(1);
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi', () => now + MARKETPLACE_FEE_NOTE_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(MARKETPLACE_FEE_NOTE_REFUSED_KEEP_MS).toBeLessThan(MARKETPLACE_FEE_NOTE_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainMarketplaceFees(failing.ai, ORG, USER, BALANCE, 45, 'vi', () => now);
    await explainMarketplaceFees(failing.ai, ORG, USER, BALANCE, 45, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a failed call and a spent budget, with no notes and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = setup(async () => {
      throw new Error('upstream said: Gian hàng Canary 1200000 shopee');
    });
    expect(await explainMarketplaceFees(failed.ai, ORG, USER, BALANCE, 45, 'vi')).toEqual({ ai: 'failed', notes: [] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainMarketplaceFees(spent.ai, ORG, USER, BALANCE, 45, 'vi')).toEqual({ ai: 'budget', notes: [] });
    expect(JSON.stringify(error.mock.calls)).not.toContain('Canary');
    expect(JSON.stringify(error.mock.calls)).not.toContain('1200000');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => NOTES, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainMarketplaceFees(ai, ORG, USER, BALANCE, 45, 'vi');
    expect(await explainMarketplaceFees(ai, ORG, USER, { rows: [row('shopee', 'x', '777000', 5, false)] }, 45, 'vi')).toEqual({ ai: 'busy', notes: [] });
    expect(asked).toHaveLength(1);
  });
});
