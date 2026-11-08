// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, requireConfirmedMarketplaceMap, type MarketplacePostingMap } from '../src/marketplace-posting-map.ts';
import { settlementProposal, settlementProposalLines, type SettlementProposalInput } from '../src/marketplace-settlement-posting.ts';

const confirmed = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133!;
  return { tt133: { ...base, status: 'confirmed' } };
};
const input = (lines: SettlementProposalInput['lines'], over: Partial<SettlementProposalInput> = {}): SettlementProposalInput => ({
  regime: 'tt133', platform: 'shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', partyId: null, lines, ...over,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? { code: e.code, status: e.status } : e; }
  return null;
};

describe('marketplace posting map and gate', () => {
  it('ships as commentary and refuses until confirmed', () => {
    const map = MARKETPLACE_POSTING_MAPS.tt133!;
    expect(map.status).toBe('commentary');
    for (const r of [map.receivable, map.revenue, map.cash, map.feePayable, map.feeAwaitingInvoice, map.taxWithheld]) expect(r.status).toBe('commentary');
    expect([map.receivable.code, map.revenue.code, map.cash.code, map.feePayable.code, map.feeAwaitingInvoice.code, map.taxWithheld.code]).toEqual(['131', '511', '112', '331', '1388', '333']);
    expect(code(() => requireConfirmedMarketplaceMap('tt133'))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(code(() => settlementProposal(input([{ sales: '100', sellerDiscount: '0' }])))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('refuses a regime with no map, including inherited names', () => {
    expect(code(() => requireConfirmedMarketplaceMap('tt99'))).toEqual({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
    expect(code(() => requireConfirmedMarketplaceMap('toString'))).toEqual({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
  });
  it('passes a map the test confirmed for itself, leaving the shipped one alone', () => {
    expect(requireConfirmedMarketplaceMap('tt133', confirmed()).status).toBe('confirmed');
    expect(MARKETPLACE_POSTING_MAPS.tt133!.status).toBe('commentary');
  });
});

describe('settlement proposal', () => {
  const maps = confirmed();
  const two = [{ sales: '100000', sellerDiscount: '5000' }, { sales: '250000', sellerDiscount: '10000' }];

  it('builds Dr 131 / Cr 511 for sales net of seller discounts, two lines, only 131 and 511', () => {
    const p = settlementProposal(input(two, { partyId: 'party-1' }), maps);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ account: '131', debit: '335000', credit: '0', partyId: 'party-1' });
    expect(p.lines[1]).toMatchObject({ account: '511', debit: '0', credit: '335000', partyId: null });
    expect(p.lines.map((l) => l.account)).toEqual(['131', '511']);
    expect(p.total).toBe('335000');
  });
  it('keeps decimals exact without JS numbers', () => {
    const lines = settlementProposalLines(input([{ sales: '0.1', sellerDiscount: '0' }, { sales: '0.2', sellerDiscount: '0.0001' }]), maps.tt133!);
    expect(lines[0]!.debit).toBe('0.2999');
    expect(lines[1]!.credit).toBe('0.2999');
  });
  it('allows a null party for the later slice to fill', () => {
    expect(settlementProposal(input(two), maps).lines[0]!.partyId).toBeNull();
  });
  it('does not post refunds: the input has no refund column and the entry ignores other columns', () => {
    const withExtra = two.map((l) => ({ ...l, refund: '99999', commission: '1' }));
    expect(settlementProposal(input(withExtra), maps).total).toBe('335000');
  });
  it('refuses a zero, negative or empty net', () => {
    for (const lines of [[{ sales: '5000', sellerDiscount: '5000' }], [{ sales: '1000', sellerDiscount: '5000' }], []]) {
      expect(code(() => settlementProposal(input(lines), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    }
  });
  it('balances by construction', () => {
    const p = settlementProposal(input(two), maps);
    const debit = p.lines.reduce((a, l) => a + BigInt(l.debit), 0n);
    const credit = p.lines.reduce((a, l) => a + BigInt(l.credit), 0n);
    expect(debit).toBe(credit);
  });
});
