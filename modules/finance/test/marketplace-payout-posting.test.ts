// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import type { MarketplacePayoutProposal } from '@crove/kernel-contract';
import { MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from '../src/marketplace-posting-map.ts';
import { payoutProposal, type PayoutPostingLine, type PayoutProposalInput } from '../src/marketplace-payout-posting.ts';
import { createMarketplacePayoutCommands, payoutProposalMismatch } from '../src/marketplace-payout-record.ts';

const confirmed = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133!;
  const c = (r: MarketplacePostingMap['revenue']) => ({ ...r, status: 'confirmed' as const });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld) } };
};
const PARTY = '0192a000-0000-7000-8000-000000000003';
const ID = '0192a000-0000-7000-8000-000000000001';
const LINE_ID = '0192a000-0000-7000-8000-000000000004';
const ENTITY = '0192a000-0000-7000-8000-000000000002';
const line = (over: Partial<PayoutPostingLine> = {}): PayoutPostingLine => ({ sales: '100000', sellerDiscount: '0', commission: '0', serviceFee: '0', paymentFee: '0', shipping: '0', taxWithheld: '0', refund: '0', other: '0', net: '100000', ...over });
const input = (lines: PayoutPostingLine[], over: Partial<PayoutProposalInput> = {}): PayoutProposalInput => ({ regime: 'tt133', platform: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', partyId: PARTY, cashAccount: '1121', lines, ...over });
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? { code: e.code, status: e.status, reason: (e.details as { reason?: string } | undefined)?.reason } : e; }
  return null;
};

describe('the entry of a platform payout', () => {
  it('is refused until the accountant confirms the account map', () => {
    expect(code(() => payoutProposal(input([line()])))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('clears the receivable: Dr bank for the money received, Dr 1388 for the fees, Dr 333 for the withheld tax, Cr 131 for the sales net of discounts and refunds', () => {
    // 100 000 + 50 000 sales, 10 000 discount, 5 000 refund: the settlement posted Dr 131 135 000. Fees 9 000 (commission 6 000, service 2 000, payment 1 000), shipping 1 000, tax 2 000.
    const lines = [line({ sales: '100000', sellerDiscount: '10000', commission: '6000', serviceFee: '2000', paymentFee: '1000', shipping: '1000', taxWithheld: '2000', refund: '5000', net: '73000' }), line({ sales: '50000', net: '50000' })];
    const p = payoutProposal(input(lines), confirmed());
    expect(p).toMatchObject({ receivable: '135000', received: '123000', fees: '10000', taxWithheld: '2000', total: '135000' });
    expect(p.lines.map((l) => [l.account, l.debit, l.credit, l.partyId])).toEqual([
      ['1121', '123000', '0', null],
      ['1388', '10000', '0', PARTY],
      ['333', '2000', '0', null],
      ['131', '0', '135000', PARTY],
    ]);
  });
  it('omits a line with nothing on it and keeps the entry balanced', () => {
    const p = payoutProposal(input([line()]), confirmed());
    expect(p.lines.map((l) => l.account)).toEqual(['1121', '131']);
    expect(p).toMatchObject({ received: '100000', fees: '0', taxWithheld: '0', total: '100000' });
  });
  it('refuses a settlement that carries another adjustment, however small, rather than balancing it with a guess', () => {
    expect(code(() => payoutProposal(input([line({ other: '500', net: '100500' })]), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', reason: 'OTHER' });
    // Adjustments that cancel are no adjustment.
    expect(code(() => payoutProposal(input([line({ other: '500', net: '100500' }), line({ sales: '0', other: '-500', net: '-500' })]), confirmed()))).toBeNull();
  });
  it('refuses when the settlement left no receivable, or when no money came to the bank', () => {
    expect(code(() => payoutProposal(input([line({ sales: '100', refund: '100', net: '0' })]), confirmed()))).toMatchObject({ reason: 'NO_RECEIVABLE' });
    expect(code(() => payoutProposal(input([line({ commission: '100000', net: '0' })]), confirmed()))).toMatchObject({ reason: 'NO_CASH' });
  });
  it('refuses a net that is not what its columns say, and amounts that are not decimals', () => {
    expect(code(() => payoutProposal(input([line({ net: '99000' })]), confirmed()))).toMatchObject({ reason: 'SPLIT' });
    expect(code(() => payoutProposal(input([line({ commission: '-1000', net: '101000' })]), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE' });
    expect(code(() => payoutProposal(input([line({ sales: '1e5' })]), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE' });
  });
  it('lets the party stay unnamed here: the caller reads it from the link, and the record checks the voucher lines', () => {
    expect(code(() => payoutProposal(input([line()], { partyId: null }), confirmed()))).toBeNull();
  });
});

const built = (party = PARTY): MarketplacePayoutProposal => ({
  date: '2026-10-20',
  description: 'Sàn trả Shopee 2026-10-01 đến 2026-10-15',
  lines: [
    { account: '1121', party: null, debit: '90000', credit: '0', memo: 'm' },
    { account: '1388', party: { id: party, name: 'Shopee', taxCode: null }, debit: '10000', credit: '0', memo: 'm' },
    { account: '131', party: { id: party, name: 'Shopee', taxCode: null }, debit: '0', credit: '100000', memo: 'm' },
  ],
  total: '100000',
  legalEntityId: ENTITY,
  settlementId: ID,
  bankLineId: LINE_ID,
  platform: 'shopee',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-15',
  received: '90000',
  fees: '10000',
  taxWithheld: '0',
});

describe('the stored payout proposal against the rebuilt one', () => {
  it('accepts an equal proposal, money-equal', () => {
    expect(payoutProposalMismatch(built(), built())).toBeNull();
    const stored = built();
    stored.received = '90000.0000';
    expect(payoutProposalMismatch(stored, built())).toBeNull();
  });
  it('names the first difference: the bank line, the settlement, the amounts, a line, a party', () => {
    const with_ = (f: (p: MarketplacePayoutProposal) => void) => { const p = built(); f(p); return payoutProposalMismatch(p, built()); };
    expect(with_((p) => { p.bankLineId = '0192a000-0000-7000-8000-0000000000ff'; })).toBe('bankLineId');
    expect(with_((p) => { p.settlementId = '0192a000-0000-7000-8000-0000000000ff'; })).toBe('settlementId');
    expect(with_((p) => { p.received = '95000'; })).toBe('received');
    expect(with_((p) => { p.fees = '9000'; })).toBe('fees');
    expect(with_((p) => { p.date = '2026-10-21'; })).toBe('period');
    expect(with_((p) => { p.lines[0]!.account = '1111'; })).toBe('lines');
    expect(with_((p) => { p.lines.pop(); })).toBe('lines');
    expect(with_((p) => { p.lines[2]!.party = { id: '0192a000-0000-7000-8000-0000000000ff', name: 'x', taxCode: null }; })).toBe('party');
    // A line that must name the party and does not, or one that must not and does.
    expect(with_((p) => { p.lines[2]!.party = null; })).toBe('party');
    expect(with_((p) => { p.lines[0]!.party = { id: PARTY, name: 'Shopee', taxCode: null }; })).toBe('party');
  });
});

describe('the payout commands', () => {
  it('are a request and a proposal-only record', () => {
    const { prepare, record, commands } = createMarketplacePayoutCommands();
    expect(commands.map((c) => c.name)).toEqual(['finance.marketplace_payout.prepare', 'finance.marketplace_payout.record']);
    expect(prepare.risk).toBe('R1');
    expect(record.risk).toBe('R3');
    expect(record.access).toBe('proposal');
  });
});
