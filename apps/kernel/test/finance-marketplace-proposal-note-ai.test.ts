// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's note on a pending marketplace proposal, on the API side (#4389): the model is asked once with whole-dong figures and no platform, an answer is kept by org, language and facts, and every
// state with no model text (no model, a spent budget, too many calls, a failed call or a refused text) is named, never quoted, and shows the fixed template with the same figures. The Uncertain (#2520)
// points are the same whatever the model does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, marketplaceProposalNoteTemplate, type MarketplaceProposalNoteFacts, type MarketplaceProposalNoteResult } from '@ludy/agent';
import type { MarketplaceProposalFacts } from '@ludy/mod-finance';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import {
  MARKETPLACE_PROPOSAL_NOTE_KEEP_MS,
  MARKETPLACE_PROPOSAL_NOTE_REFUSED_KEEP_MS,
  explainMarketplaceProposal,
  marketplaceProposalNoteAi,
} from '../src/finance-marketplace-proposal-note-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PAYOUT: MarketplaceProposalFacts = {
  kind: 'payout',
  figures: { received: '304000', fees: '28000', taxWithheld: '3000' },
  lineKinds: [],
  accounts: ['1121', '331', '3331', '3335', '131'],
  uncertain: [
    { key: 'receivable', vi: 'Phải thu ghi vào 131.', en: 'Receivable on 131.' },
    { key: 'fee_netting', vi: 'Phí bù trừ khi nhận tiền.', en: 'Fees netted on receipt.' },
  ],
};
const TEXT = 'Sàn giữ lại phí 28.000 đồng (331) và thuế 3.000 đồng; bút toán ghi 304.000 đồng tiền nhận về.';
const OK: MarketplaceProposalNoteResult = { kind: 'note', text: TEXT };

function setup(answer: ((facts: MarketplaceProposalNoteFacts) => Promise<MarketplaceProposalNoteResult>) | null, budget = new DraftBudget()) {
  const asked: MarketplaceProposalNoteFacts[] = [];
  const ai = marketplaceProposalNoteAi(answer ? { marketplaceProposalNote: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}
const template = (language: 'vi' | 'en') => marketplaceProposalNoteTemplate({ language, kind: 'payout', figures: PAYOUT.figures, lineKinds: [], accounts: PAYOUT.accounts });

afterEach(() => vi.restoreAllMocks());

describe('explainMarketplaceProposal', () => {
  it('asks the model once with the figures and nothing else, and answers with its text and the Uncertain points chosen by code', async () => {
    const { ai, asked } = setup(async () => OK);
    const out = await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi');
    expect(out).toEqual({ ai: 'used', kind: 'payout', note: TEXT, uncertain: [{ key: 'receivable', text: 'Phải thu ghi vào 131.' }, { key: 'fee_netting', text: 'Phí bù trừ khi nhận tiền.' }] });
    expect(asked).toEqual([{ language: 'vi', kind: 'payout', figures: PAYOUT.figures, lineKinds: [], accounts: PAYOUT.accounts }]);
    const sent = JSON.stringify(asked);
    for (const secret of ['Phải thu', 'Phí bù trừ', 'uncertain', 'shopee']) expect(sent).not.toContain(secret);
  });

  it('shows the template and the same Uncertain list with no model, and makes no call', async () => {
    const out = await explainMarketplaceProposal(setup(null).ai, ORG, USER, PAYOUT, 'en');
    expect(out).toEqual({ ai: 'off', kind: 'payout', note: template('en'), uncertain: [{ key: 'receivable', text: 'Receivable on 131.' }, { key: 'fee_netting', text: 'Fees netted on receipt.' }] });
    expect(out.note).toContain('304,000 dong');
  });

  it('says nothing and asks no model when no figure is above zero', async () => {
    const { ai, asked } = setup(async () => OK);
    expect(await explainMarketplaceProposal(ai, ORG, USER, { ...PAYOUT, figures: {} }, 'vi')).toMatchObject({ ai: 'off', note: '' });
    expect(asked).toEqual([]);
  });

  it('keeps an answer by org, language and facts, and asks again after the time or for other facts', async () => {
    const { ai, asked } = setup(async () => OK);
    const now = 1_000;
    await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now);
    expect((await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now + 1000)).note).toBe(TEXT);
    expect(asked).toHaveLength(1);
    await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now + MARKETPLACE_PROPOSAL_NOTE_KEEP_MS + 1);
    await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'en', () => now + MARKETPLACE_PROPOSAL_NOTE_KEEP_MS + 2);
    await explainMarketplaceProposal(ai, '55555555-5555-4555-8555-555555555555', USER, PAYOUT, 'vi', () => now + MARKETPLACE_PROPOSAL_NOTE_KEEP_MS + 3);
    await explainMarketplaceProposal(ai, ORG, USER, { ...PAYOUT, figures: { ...PAYOUT.figures, fees: '29000' } }, 'vi', () => now + MARKETPLACE_PROPOSAL_NOTE_KEEP_MS + 4);
    expect(asked).toHaveLength(5);
  });

  it('keeps a refusal for a shorter while, shows the template, and never keeps a transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'REFUSED' }));
    const now = 1_000;
    expect(await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now)).toMatchObject({ ai: 'failed', note: template('vi') });
    expect(await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now + 1000)).toMatchObject({ ai: 'failed' });
    expect(asked).toHaveLength(1);
    await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi', () => now + MARKETPLACE_PROPOSAL_NOTE_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(MARKETPLACE_PROPOSAL_NOTE_REFUSED_KEEP_MS).toBeLessThan(MARKETPLACE_PROPOSAL_NOTE_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainMarketplaceProposal(failing.ai, ORG, USER, PAYOUT, 'vi', () => now);
    await explainMarketplaceProposal(failing.ai, ORG, USER, PAYOUT, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a failed call and a spent budget, shows the template with the Uncertain list, and quotes neither', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = setup(async () => {
      throw new Error('upstream said: 304000 shopee');
    });
    expect(await explainMarketplaceProposal(failed.ai, ORG, USER, PAYOUT, 'vi')).toMatchObject({ ai: 'failed', note: template('vi'), uncertain: [{ key: 'receivable' }, { key: 'fee_netting' }] });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainMarketplaceProposal(spent.ai, ORG, USER, PAYOUT, 'vi')).toMatchObject({ ai: 'budget', note: template('vi') });
    expect(JSON.stringify(error.mock.calls)).not.toContain('304000');
    expect(JSON.stringify(error.mock.calls)).not.toContain('shopee');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => OK, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainMarketplaceProposal(ai, ORG, USER, PAYOUT, 'vi');
    expect(await explainMarketplaceProposal(ai, ORG, USER, { ...PAYOUT, figures: { ...PAYOUT.figures, fees: '777000' } }, 'vi')).toMatchObject({ ai: 'busy', note: expect.stringContaining('777.000') });
    expect(asked).toHaveLength(1);
  });
});
