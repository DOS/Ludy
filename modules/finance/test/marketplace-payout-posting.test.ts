// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DomainError } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import type { MarketplacePayoutAdjustment, MarketplacePayoutProposal } from '@ludy/kernel-contract';
import { MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from '../src/marketplace-posting-map.ts';
import { isFeeWaitingSource } from '../src/marketplace-fee-clearing-record.ts';
import { WITHHELD_IN_ERROR_MEMO_SUFFIX, payoutPaths, payoutProposal, type PayoutPostingLine, type PayoutProposalInput } from '../src/marketplace-payout-posting.ts';
import { createMarketplacePayoutCommands, payoutProposalMismatch } from '../src/marketplace-payout-record.ts';

const confirmed = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133!;
  const c = (r: MarketplacePostingMap['revenue']) => ({ ...r, status: 'confirmed' as const });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld), vatPayable: c(base.vatPayable), pitPayable: c(base.pitPayable), pitOwnerEquity: c(base.pitOwnerEquity), feeExpense: c(base.feeExpense), accruedExpense: c(base.accruedExpense), outputVat: c(base.outputVat) } };
};
const PARTY = '0192a000-0000-7000-8000-000000000003';
const ID = '0192a000-0000-7000-8000-000000000001';
const LINE_ID = '0192a000-0000-7000-8000-000000000004';
const ENTITY = '0192a000-0000-7000-8000-000000000002';
let lineSeq = 0;
const lineId = (n: number) => `0192a000-0000-7000-8000-${String(100000 + n).padStart(12, '0')}`;
const line = (over: Partial<PayoutPostingLine> = {}): PayoutPostingLine => ({ id: lineId(++lineSeq), sales: '100000', sellerDiscount: '0', commission: '0', serviceFee: '0', paymentFee: '0', shipping: '0', taxWithheld: '0', refund: '0', other: '0', net: '100000', ...over });
const input = (lines: PayoutPostingLine[], over: Partial<PayoutProposalInput> = {}): PayoutProposalInput => ({ regime: 'tt133', platform: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', partyId: PARTY, cashAccount: '1121', lines, taxSplit: null, household: false, ...over });
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? { code: e.code, status: e.status, reason: (e.details as { reason?: string } | undefined)?.reason } : e; }
  return null;
};

describe('the entry of a platform payout', () => {
  it('is refused until the accountant confirms the account map', () => {
    expect(code(() => payoutProposal(input([line()])))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('clears the receivable: Dr bank for the money received, Dr 331 for the fees, Dr 3331 and 3335 for the withheld tax as the settlement credited it, Cr 131 for the sales net of discounts and refunds', () => {
    // 100 000 + 50 000 sales, 10 000 discount, 5 000 refund: the settlement posted Dr 131 135 000. Fees 9 000 (commission 6 000, service 2 000, payment 1 000), shipping 1 000, tax 2 000.
    const lines = [line({ sales: '100000', sellerDiscount: '10000', commission: '6000', serviceFee: '2000', paymentFee: '1000', shipping: '1000', taxWithheld: '2000', refund: '5000', net: '73000' }), line({ sales: '50000', net: '50000' })];
    const p = payoutProposal(input(lines, { taxSplit: { vat: '1334', pit: '666' } }), confirmed());
    expect(p).toMatchObject({ receivable: '135000', received: '123000', fees: '10000', taxWithheld: '2000', total: '135000' });
    expect(p.lines.map((l) => [l.account, l.debit, l.credit, l.partyId])).toEqual([
      ['1121', '123000', '0', null],
      ['331', '10000', '0', PARTY],
      ['3331', '1334', '0', null],
      ['3335', '666', '0', null],
      ['131', '0', '135000', PARTY],
    ]);
  });
  it('debits the tax exactly as the settlement credited it, and refuses a withheld tax that does not match, or one with no credit to match (a seller that is no household)', () => {
    const taxed = [line({ sales: '100000', taxWithheld: '2000', net: '98000' })];
    expect(code(() => payoutProposal(input(taxed), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', reason: 'TAX_SPLIT' });
    expect(code(() => payoutProposal(input(taxed, { taxSplit: { vat: '1333', pit: '666' } }), confirmed()))).toMatchObject({ reason: 'TAX_SPLIT' });
    expect(code(() => payoutProposal(input([line()], { taxSplit: { vat: '10', pit: '0' } }), confirmed()))).toMatchObject({ reason: 'TAX_SPLIT' });
    expect(code(() => payoutProposal(input(taxed, { taxSplit: { vat: '-1', pit: '2001' } }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE' });
    // A pit part of zero posts only the VAT line.
    const only = payoutProposal(input(taxed, { taxSplit: { vat: '2000', pit: '0' } }), confirmed());
    expect(only.lines.map((l) => l.account)).toEqual(['1121', '3331', '131']);
  });
  it('gates per path (#3711 slice 1): a payout without household tax needs no owner\'s equity row, one that clears withheld tax does', () => {
    const maps = confirmed();
    const open = { ...maps.tt133!, vatPayable: { ...maps.tt133!.vatPayable, status: 'commentary' as const }, pitPayable: { ...maps.tt133!.pitPayable, status: 'commentary' as const }, pitOwnerEquity: { ...maps.tt133!.pitOwnerEquity, status: 'commentary' as const } };
    const withoutHouseholdTax = { tt133: open };
    expect(payoutProposal(input([line()]), withoutHouseholdTax).lines.map((l) => l.account)).toEqual(['1121', '131']);
    const taxed = [line({ sales: '100000', taxWithheld: '2000', net: '98000' })];
    expect(code(() => payoutProposal(input(taxed, { taxSplit: { vat: '1334', pit: '666' } }), withoutHouseholdTax))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(payoutProposal(input(taxed, { taxSplit: { vat: '1334', pit: '666' } }), maps).taxWithheld).toBe('2000');
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

describe('a payout with the lines a person classified (#4303 S4)', () => {
  const ids = (n: number) => lineId(900 + n);
  const incentive = (n: number, amount: string): MarketplacePayoutAdjustment => ({ kind: 'incentive', lineId: ids(n), amount });
  const compensation = (n: number, amount: string, costAmount: string): MarketplacePayoutAdjustment => ({ kind: 'carrier_compensation', lineId: ids(n), amount, costAmount });
  const lost = (n: number, amount: string, tax = '0'): PayoutPostingLine => line({ id: ids(n), other: amount, net: toMoney(money('100000').plus(amount).minus(tax)), taxWithheld: tax });
  const accounts = (p: ReturnType<typeof payoutProposal>) => p.lines.map((l) => [l.account, l.debit, l.credit, l.partyId]);
  const withAdj = (lines: PayoutPostingLine[], adjustments: MarketplacePayoutAdjustment[], over: Partial<PayoutProposalInput> = {}) => input(lines, { adjustments, ...over });

  it('credits 711 for a seller incentive, nothing else changes, and the entry balances', () => {
    const p = payoutProposal(withAdj([lost(1, '5000')], [incentive(1, '5000')]), confirmed());
    expect(accounts(p)).toEqual([['1121', '105000', '0', null], ['131', '0', '100000', PARTY], ['711', '0', '5000', null]]);
    expect(p).toMatchObject({ received: '105000', receivable: '100000', total: '105000', incentive: '5000', compensation: '0', compensationCost: '0', taxInError: '0' });
  });
  it('credits 632 with the smaller of the compensation and the stated cost, and 711 with the rest', () => {
    // Cost below the compensation: 6 000 to 632, the excess 4 000 to 711.
    expect(accounts(payoutProposal(withAdj([lost(1, '10000')], [compensation(1, '10000', '6000')]), confirmed()))).toEqual([['1121', '110000', '0', null], ['131', '0', '100000', PARTY], ['632', '0', '6000', null], ['711', '0', '4000', null]]);
    // Cost above the compensation: all of it reduces 632, the shortfall stays a loss in 632 with no extra line.
    expect(accounts(payoutProposal(withAdj([lost(1, '10000')], [compensation(1, '10000', '15000')]), confirmed()))).toEqual([['1121', '110000', '0', null], ['131', '0', '100000', PARTY], ['632', '0', '10000', null]]);
    // Cost equal to the compensation: no 711 line. Cost zero: all of it is 711, no 632 line.
    expect(payoutProposal(withAdj([lost(1, '10000')], [compensation(1, '10000', '10000')]), confirmed()).lines.map((l) => l.account)).toEqual(['1121', '131', '632']);
    expect(payoutProposal(withAdj([lost(1, '10000')], [compensation(1, '10000', '0')]), confirmed()).lines.map((l) => l.account)).toEqual(['1121', '131', '711']);
  });
  it('adds several lines up per kind and keeps incentive and excess on their own 711 lines', () => {
    const lines = [lost(1, '1000'), lost(2, '2000'), lost(3, '3000'), line({ id: ids(4) })];
    const p = payoutProposal(withAdj(lines, [incentive(1, '1000'), compensation(2, '2000', '500'), compensation(3, '3000', '9000')]), confirmed());
    expect(p.lines.filter((l) => l.credit !== '0' && l.account !== '131').map((l) => [l.account, l.credit, l.memo.split(', ')[1]])).toEqual([['711', '1000', 'khoản thưởng của sàn'], ['632', '3500', 'bồi thường mất hàng'], ['711', '1500', 'bồi thường vượt giá vốn']]);
    expect(p).toMatchObject({ incentive: '1000', compensation: '5000', compensationCost: '3500' });
    // The debits equal the credits and the total says so.
    expect(toMoney(sum(p.lines.map((l) => l.debit)))).toBe(p.total);
    expect(toMoney(sum(p.lines.map((l) => l.credit)))).toBe(p.total);
  });
  it('debits 1388 under the platform for tax withheld from a seller that is no household, in place of 3331 and 3335', () => {
    const lines = [lost(1, '0', '2000')];
    const adjustments: MarketplacePayoutAdjustment[] = [{ kind: 'withheld_in_error', lineId: ids(1), amount: '2000' }];
    const p = payoutProposal(withAdj(lines, adjustments, { household: false }), confirmed());
    expect(accounts(p)).toEqual([['1121', '98000', '0', null], ['1388', '2000', '0', PARTY], ['131', '0', '100000', PARTY]]);
    expect(p).toMatchObject({ taxWithheld: '2000', taxInError: '2000', total: '100000' });
    // A household's tax goes through 3331 and 3335 as the settlement credited it: classifying it as a mistake is refused, and so is classifying a tax the settlement already credited.
    expect(code(() => payoutProposal(withAdj(lines, adjustments, { household: true }), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', reason: 'ADJUSTMENT_HOUSEHOLD' });
    expect(code(() => payoutProposal(withAdj(lines, adjustments, { taxSplit: { vat: '1334', pit: '666' } }), confirmed()))).toMatchObject({ reason: 'TAX_SPLIT' });
    // Not classified: refused as before. A line with no tax cannot be classified as withheld.
    expect(code(() => payoutProposal(input(lines), confirmed()))).toMatchObject({ reason: 'TAX_SPLIT' });
    expect(code(() => payoutProposal(withAdj([line({ id: ids(1) })], adjustments), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_NOTHING' });
  });
  it('keeps the fee debit and the withheld_in_error debit distinct even when both land on 1388 (#4336)', () => {
    const maps = confirmed();
    const with1388Fees = { tt133: { ...maps.tt133!, feePayable: { ...maps.tt133!.feePayable, code: '1388' } } };
    const lines = [line({ id: ids(1), sales: '100000', commission: '10000', taxWithheld: '2000', net: '88000' })];
    const p = payoutProposal(withAdj(lines, [{ kind: 'withheld_in_error', lineId: ids(1), amount: '2000' }], { household: false }), with1388Fees);
    const lines1388 = p.lines.filter((l) => l.account === '1388');
    expect(lines1388.map((l) => [l.debit, l.memo.endsWith(WITHHELD_IN_ERROR_MEMO_SUFFIX)])).toEqual([
      ['10000', false],
      ['2000', true],
    ]);
    expect(lines1388.filter((l) => isFeeWaitingSource({ feeDocumentId: null, payoutSettlementId: ID, proposalId: ID, payoutFees: p.fees, memo: l.memo })).map((l) => l.debit)).toEqual(['10000']);
  });
  it('posts a household\'s incentive beside the tax it credited to 3331 and 3335: the two are cleared separately and the entry balances', () => {
    const lines = [lost(1, '5000', '2000')];
    const p = payoutProposal(withAdj(lines, [incentive(1, '5000')], { household: true, taxSplit: { vat: '1334', pit: '666' } }), confirmed());
    expect(accounts(p)).toEqual([['1121', '103000', '0', null], ['3331', '1334', '0', null], ['3335', '666', '0', null], ['131', '0', '100000', PARTY], ['711', '0', '5000', null]]);
    expect(p.total).toBe('105000');
  });
  it('posts incentive, compensation and tax withheld by mistake in one entry', () => {
    const lines = [lost(1, '1000'), lost(2, '2000', '2000')];
    const p = payoutProposal(withAdj(lines, [incentive(1, '1000'), compensation(2, '2000', '0'), { kind: 'withheld_in_error', lineId: ids(2), amount: '2000' }]), confirmed());
    expect(accounts(p)).toEqual([['1121', '201000', '0', null], ['1388', '2000', '0', PARTY], ['131', '0', '200000', PARTY], ['711', '0', '1000', null], ['711', '0', '2000', null]]);
    expect(p.total).toBe('203000');
  });
  it('refuses a line nobody classified, a negative one, an amount that is not the line\'s to the dong, a repeat, an unknown line and a line with nothing on it', () => {
    const two = [lost(1, '1000'), lost(2, '2000')];
    expect(code(() => payoutProposal(withAdj(two, [incentive(1, '1000')]), confirmed()))).toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', reason: 'OTHER' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000'), line({ id: ids(2), other: '-200', net: '99800' })], [incentive(1, '1000')]), confirmed()))).toMatchObject({ reason: 'OTHER_NEGATIVE' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000')], [incentive(1, '999')]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_AMOUNT' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000')], [incentive(1, '1001')]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_AMOUNT' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000')], [incentive(1, '1000'), compensation(1, '1000', '0')]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_DUPLICATE' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000')], [incentive(1, '1000'), incentive(7, '5')]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_LINE' });
    expect(code(() => payoutProposal(withAdj([lost(1, '1000'), line({ id: ids(2) })], [incentive(1, '1000'), incentive(2, '5')]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_NOTHING' });
    // Without any classification the rule of before stands: money the report does not explain is refused, however small.
    expect(code(() => payoutProposal(input([lost(1, '500')]), confirmed()))).toMatchObject({ reason: 'OTHER' });
  });
  it('keeps an offsetting pair as no adjustment, also beside a classified tax, but checks every line once something is classified on `other`', () => {
    const pair = [lost(1, '500'), line({ id: ids(2), sales: '0', other: '-500', net: '-500' })];
    expect(code(() => payoutProposal(withAdj(pair, [{ kind: 'withheld_in_error', lineId: ids(3), amount: '1' }]), confirmed()))).toMatchObject({ reason: 'ADJUSTMENT_LINE' });
    const taxed = [...pair, lost(3, '0', '2000')];
    expect(code(() => payoutProposal(withAdj(taxed, [{ kind: 'withheld_in_error', lineId: ids(3), amount: '2000' }]), confirmed()))).toBeNull();
    expect(code(() => payoutProposal(withAdj(pair, [incentive(1, '500')]), confirmed()))).toMatchObject({ reason: 'OTHER_NEGATIVE' });
  });
  it('asks for the adjustment rows only when something is classified, and never opens while the payout path or the map is not confirmed', () => {
    expect(payoutPaths(false, false)).toEqual(['payout']);
    expect(payoutPaths(true, true)).toEqual(['payout', 'household_tax', 'payout_adjustments']);
    const open = confirmed();
    const rows = ['otherReceivable', 'costOfGoods', 'otherIncome'] as const;
    const closed = { tt133: { ...open.tt133!, ...Object.fromEntries(rows.map((r) => [r, { ...open.tt133![r], status: 'commentary' as const }])) } };
    const adj = withAdj([lost(1, '1000')], [incentive(1, '1000')]);
    // The adjustment rows still `commentary`: a request with adjustments is refused, one without them is not.
    expect(code(() => payoutProposal(adj, closed))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(code(() => payoutProposal(input([line()]), closed))).toBeNull();
    // The payout path still `commentary`, the adjustment rows confirmed: refused as well.
    const payoutClosed = { tt133: { ...open.tt133!, cash: { ...open.tt133!.cash, status: 'commentary' as const } } };
    expect(code(() => payoutProposal(adj, payoutClosed))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    // Both open: posted.
    expect(code(() => payoutProposal(adj, open))).toBeNull();
  });
  it('is closed in the shipped maps: the sales path (S3b) and the three adjustment rows (S4) are confirmed, the payout rows are not, so a payout with adjustments is refused', () => {
    for (const regime of ['tt133', 'tt99'] as const) {
      const map = MARKETPLACE_POSTING_MAPS[regime]!;
      // The map's own flag is confirmed with the sales path (#4303 S3b); the payout path still needs its own rows.
      expect(map.status).toBe('confirmed');
      const confirmedRows = (Object.entries(map) as [string, { status?: string }][]).filter(([, v]) => typeof v === 'object' && v?.status === 'confirmed').map(([k]) => k).sort();
      expect(confirmedRows).toEqual(['costOfGoods', 'otherIncome', 'otherReceivable', 'outputVat', 'receivable', 'revenue', 'salesReturn']);
      for (const r of ['cash', 'feePayable'] as const) expect(map[r].status).toBe('commentary');
      for (const r of [map.otherReceivable, map.costOfGoods, map.otherIncome]) expect(r.comment).toContain('Uncertain (#2520)');
    }
    const shipped = { regime: 'tt133', platform: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', partyId: PARTY, cashAccount: '1121', taxSplit: null, household: false };
    expect(code(() => payoutProposal({ ...shipped, lines: [lost(1, '1000')], adjustments: [incentive(1, '1000')] }))).toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
});

const built = (party = PARTY): MarketplacePayoutProposal => ({
  date: '2026-10-20',
  description: 'Sàn trả Shopee 2026-10-01 đến 2026-10-15',
  lines: [
    { account: '1121', party: null, debit: '90000', credit: '0', memo: 'm' },
    { account: '331', party: { id: party, name: 'Shopee', taxCode: null }, debit: '10000', credit: '0', memo: 'm' },
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
  adjustments: [],
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
