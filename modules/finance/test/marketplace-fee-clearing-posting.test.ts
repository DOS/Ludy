// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import type { MarketplaceFeeClearingProposal } from '@crove/kernel-contract';
import { MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from '../src/marketplace-posting-map.ts';
import { feeClearingProposal, type FeeClearingInput } from '../src/marketplace-fee-clearing-posting.ts';
import { createMarketplaceFeeClearingCommands, feeClearingProposalMismatch } from '../src/marketplace-fee-clearing-record.ts';

const confirmed = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133!;
  const c = (r: MarketplacePostingMap['revenue']) => ({ ...r, status: 'confirmed' as const });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld) } };
};
const PARTY = '0192a000-0000-7000-8000-000000000003';
const DOC = '0192a000-0000-7000-8000-000000000001';
const ENTITY = '0192a000-0000-7000-8000-000000000002';
const input = (over: Partial<FeeClearingInput> = {}): FeeClearingInput => ({ regime: 'tt133', platform: 'Shopee', invoice: '1C26TPF00000001', partyId: PARTY, invoiceTotal: '30800', alreadyCleared: '0', waiting: '28000', ...over });
const err = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? { code: e.code, status: e.status, reason: (e.details as { reason?: string } | undefined)?.reason } : e; }
  return null;
};

describe('the entry of a fee clearing', () => {
  it('is refused until the accountant confirms the account map', () => {
    expect(err(() => feeClearingProposal(input()))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('moves what waits from 1388 to 331, the platform party on both lines, capped by the waiting fees', () => {
    const p = feeClearingProposal(input(), confirmed());
    expect(p).toMatchObject({ invoiceTotal: '30800', alreadyCleared: '0', waiting: '28000', amount: '28000', total: '28000' });
    expect(p.lines.map((l) => [l.account, l.debit, l.credit, l.partyId])).toEqual([['331', '28000', '0', PARTY], ['1388', '0', '28000', PARTY]]);
  });
  it('is capped by what the invoice still has to clear when that is smaller than what waits', () => {
    expect(feeClearingProposal(input({ invoiceTotal: '10000' }), confirmed()).amount).toBe('10000');
    expect(feeClearingProposal(input({ invoiceTotal: '30800', alreadyCleared: '20000' }), confirmed()).amount).toBe('10800');
  });
  it('refuses when the invoice has cleared its share, or nothing waits', () => {
    expect(err(() => feeClearingProposal(input({ alreadyCleared: '30800' }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', status: 409, reason: 'INVOICE_CLEARED' });
    expect(err(() => feeClearingProposal(input({ alreadyCleared: '31000' }), confirmed()))).toMatchObject({ reason: 'INVOICE_CLEARED' });
    expect(err(() => feeClearingProposal(input({ waiting: '0' }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', reason: 'NOTHING_WAITING' });
    // A negative balance on 1388 (more cleared than put there) is nothing waiting either.
    expect(err(() => feeClearingProposal(input({ waiting: '-5' }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_FEE_DOCUMENT' });
  });
  it('refuses amounts that are not decimals', () => {
    expect(err(() => feeClearingProposal(input({ invoiceTotal: '1e5' }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_FEE_DOCUMENT', status: 422 });
    expect(err(() => feeClearingProposal(input({ alreadyCleared: '' }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_FEE_DOCUMENT' });
  });
  it('lets the party stay unnamed here: the caller reads it from the link', () => {
    expect(err(() => feeClearingProposal(input({ partyId: null }), confirmed()))).toBeNull();
  });
});

const built = (party = PARTY): MarketplaceFeeClearingProposal => ({
  date: '2026-10-25',
  description: 'Cấn trừ phí Shopee theo hóa đơn 1C26TPF00000001',
  lines: [
    { account: '331', party: { id: party, name: 'Shopee', taxCode: null }, debit: '28000', credit: '0', memo: 'm' },
    { account: '1388', party: { id: party, name: 'Shopee', taxCode: null }, debit: '0', credit: '28000', memo: 'm' },
  ],
  total: '28000',
  legalEntityId: ENTITY,
  purchaseDocumentId: DOC,
  platform: 'shopee',
  invoiceTotal: '30800',
  alreadyCleared: '0',
  waiting: '28000',
  amount: '28000',
});

describe('the stored clearing proposal against the rebuilt one', () => {
  it('accepts an equal proposal, money-equal', () => {
    expect(feeClearingProposalMismatch(built(), built())).toBeNull();
    const stored = built();
    stored.amount = '28000.0000';
    expect(feeClearingProposalMismatch(stored, built())).toBeNull();
  });
  it('names the first difference', () => {
    const with_ = (f: (p: MarketplaceFeeClearingProposal) => void) => { const p = built(); f(p); return feeClearingProposalMismatch(p, built()); };
    expect(with_((p) => { p.purchaseDocumentId = '0192a000-0000-7000-8000-0000000000ff'; })).toBe('purchaseDocumentId');
    expect(with_((p) => { p.amount = '30000'; })).toBe('amount');
    expect(with_((p) => { p.waiting = '30000'; })).toBe('waiting');
    expect(with_((p) => { p.alreadyCleared = '1'; })).toBe('alreadyCleared');
    expect(with_((p) => { p.date = '2026-10-26'; })).toBe('date');
    expect(with_((p) => { p.lines[1]!.account = '1381'; })).toBe('lines');
    expect(with_((p) => { p.lines.pop(); })).toBe('lines');
    expect(with_((p) => { p.lines[0]!.party = null; })).toBe('party');
    expect(with_((p) => { p.lines[1]!.party = { id: '0192a000-0000-7000-8000-0000000000ff', name: 'x', taxCode: null }; })).toBe('party');
  });
});

describe('the fee clearing commands', () => {
  it('are a request and a proposal-only record', () => {
    const { prepare, record, commands } = createMarketplaceFeeClearingCommands();
    expect(commands.map((c) => c.name)).toEqual(['finance.marketplace_fee_clearing.prepare', 'finance.marketplace_fee_clearing.record']);
    expect(prepare.risk).toBe('R1');
    expect(record.risk).toBe('R3');
    expect(record.access).toBe('proposal');
  });
});
