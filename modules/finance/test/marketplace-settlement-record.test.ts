// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { MarketplaceSettlementProposal } from '@crove/kernel-contract';
import { createMarketplaceSettlementCommands, platformPartyName, settlementProposalMismatch } from '../src/marketplace-settlement-record.ts';
import { zMarketplaceSettlementProposal, zMarketplaceSettlementRequest } from '@crove/kernel-contract';

const ID = '0192a000-0000-7000-8000-000000000001';
const ENTITY = '0192a000-0000-7000-8000-000000000002';
const PARTY = '0192a000-0000-7000-8000-000000000003';

const built = (party: string | null = null): MarketplaceSettlementProposal => ({
  date: '2026-10-15',
  description: 'Đối soát Shopee 2026-10-01 đến 2026-10-15',
  lines: [
    { account: '131', party: party ? { id: party, name: 'Shopee', taxCode: null } : null, debit: '335000', credit: '0', memo: 'm' },
    { account: '511', party: null, debit: '0', credit: '335000', memo: 'm' },
  ],
  total: '335000',
  legalEntityId: ENTITY,
  settlementId: ID,
  platform: 'shopee',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-15',
  sales: '350000',
  sellerDiscount: '15000',
  refund: '0',
});

describe('marketplace settlement proposal check', () => {
  it('accepts a stored proposal equal to the rebuilt one, money-equal', () => {
    expect(settlementProposalMismatch(built(), built())).toBeNull();
    const stored = built();
    stored.total = '335000.0000';
    expect(settlementProposalMismatch(stored, built())).toBeNull();
  });
  it('takes a proposal made before the platform had a party, and one that names the linked party', () => {
    expect(settlementProposalMismatch(built(null), built(PARTY))).toBeNull();
    expect(settlementProposalMismatch(built(PARTY), built(PARTY))).toBeNull();
  });
  it('refuses a party the link does not hold, or one on the wrong line', () => {
    expect(settlementProposalMismatch(built(PARTY), built(null))).toBe('party');
    expect(settlementProposalMismatch(built('0192a000-0000-7000-8000-000000000009'), built(PARTY))).toBe('party');
    const stored = built(PARTY);
    stored.lines[1] = { ...stored.lines[1]!, party: { id: PARTY, name: 'Shopee', taxCode: null } };
    expect(settlementProposalMismatch(stored, built(PARTY))).toBe('party');
  });
  it('refuses a changed amount, account, settlement, entity, platform or period', () => {
    const tamper = (fn: (p: MarketplaceSettlementProposal) => void) => {
      const p = built();
      fn(p);
      return settlementProposalMismatch(p, built());
    };
    expect(tamper((p) => (p.lines[0]!.debit = '335001'))).toBe('lines');
    expect(tamper((p) => (p.lines[0]!.account = '1311'))).toBe('lines');
    expect(tamper((p) => (p.total = '1'))).toBe('total');
    expect(tamper((p) => (p.refund = '1'))).toBe('refund');
    expect(tamper((p) => (p.settlementId = '0192a000-0000-7000-8000-000000000009'))).toBe('settlementId');
    expect(tamper((p) => (p.legalEntityId = '0192a000-0000-7000-8000-000000000009'))).toBe('legalEntityId');
    expect(tamper((p) => delete (p as { legalEntityId?: string }).legalEntityId)).toBe('legalEntityId');
    expect(tamper((p) => (p.platform = 'lazada'))).toBe('platform');
    expect(tamper((p) => (p.periodTo = '2026-10-16'))).toBe('period');
    expect(tamper((p) => p.lines.pop())).toBe('lines');
  });
});

describe('marketplace settlement commands', () => {
  it('names the platform parties', () => {
    expect(['shopee', 'tiktok_shop', 'lazada'].map(platformPartyName)).toEqual(['Shopee', 'TikTok Shop', 'Lazada']);
  });
  it('makes a preparer and a recorder with the names the proposal path expects, the recorder an R3 financial proposal command', () => {
    const { prepare, record, commands } = createMarketplaceSettlementCommands();
    expect(commands).toHaveLength(2);
    expect(prepare).toMatchObject({ name: 'finance.marketplace_settlement.prepare', risk: 'R1', sideEffect: 'internal' });
    expect(record).toMatchObject({ name: 'finance.marketplace_settlement.record', risk: 'R3', sideEffect: 'financial', access: 'proposal', proposalKind: 'finance.journal_voucher' });
  });
  it('takes the settlement alone in a request, and no extra field', () => {
    expect(zMarketplaceSettlementRequest.safeParse({ settlementId: ID }).success).toBe(true);
    expect(zMarketplaceSettlementRequest.safeParse({ settlementId: ID, lines: [] }).success).toBe(false);
    expect(zMarketplaceSettlementProposal.safeParse(built()).success).toBe(true);
    expect(zMarketplaceSettlementProposal.safeParse({ ...built(), sales: '1.5' }).success).toBe(false);
  });
});
