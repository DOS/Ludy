// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, requireConfirmedMarketplaceMap, type MarketplacePostingMap } from '../src/marketplace-posting-map.ts';
import { money } from '@crove/l10n-vn';
import { settlementProposal, type SettlementProposalInput } from '../src/marketplace-settlement-posting.ts';

const confirmed = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133!;
  const c = (r: MarketplacePostingMap['revenue']) => ({ ...r, status: 'confirmed' as const });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld), vatPayable: c(base.vatPayable), pitPayable: c(base.pitPayable), pitOwnerEquity: c(base.pitOwnerEquity), feeExpense: c(base.feeExpense), accruedExpense: c(base.accruedExpense) } };
};
const input = (lines: SettlementProposalInput['lines'], over: Partial<SettlementProposalInput> = {}): SettlementProposalInput => ({
  regime: 'tt133', platform: 'shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', month: '2026-10', date: '2026-10-15', partyId: null, lines, ...over,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? { code: e.code, status: e.status } : e; }
  return null;
};

describe('marketplace posting map and gate', () => {
  it('ships as commentary and refuses until confirmed', () => {
    const map = MARKETPLACE_POSTING_MAPS.tt133!;
    expect(map.status).toBe('commentary');
    for (const r of [map.receivable, map.revenue, map.cash, map.feePayable, map.feeAwaitingInvoice, map.taxWithheld, map.vatPayable, map.pitPayable, map.pitOwnerEquity]) expect(r.status).toBe('commentary');
    expect([map.vatPayable.code, map.pitPayable.code, map.pitOwnerEquity.code]).toEqual(['3331', '3335', '4212']);
    expect([map.receivable.code, map.revenue.code, map.cash.code, map.feePayable.code, map.feeAwaitingInvoice.code, map.taxWithheld.code]).toEqual(['131', '511', '112', '331', '1388', '333']);
    expect(code(() => requireConfirmedMarketplaceMap('tt133'))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(code(() => settlementProposal(input([{ sales: '100', sellerDiscount: '0', refund: '0' }])))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('refuses a regime with no map, including inherited names', () => {
    expect(code(() => requireConfirmedMarketplaceMap('tt200'))).toEqual({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
    expect(code(() => requireConfirmedMarketplaceMap('toString'))).toEqual({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
  });
  it('passes a map the test confirmed for itself, leaving the shipped one alone', () => {
    expect(requireConfirmedMarketplaceMap('tt133', confirmed()).status).toBe('confirmed');
    expect(MARKETPLACE_POSTING_MAPS.tt133!.status).toBe('commentary');
  });
});

describe('settlement proposal', () => {
  const maps = confirmed();
  const two = [{ sales: '100000', sellerDiscount: '5000', refund: '0' }, { sales: '250000', sellerDiscount: '10000', refund: '0' }];

  it('builds Dr 131 / Cr 511 for sales net of seller discounts, two lines, only 131 and 511', () => {
    const p = settlementProposal(input(two, { partyId: 'party-1' }), maps);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ account: '131', debit: '335000', credit: '0', partyId: 'party-1' });
    expect(p.lines[1]).toMatchObject({ account: '511', debit: '0', credit: '335000', partyId: null });
    expect(p.lines.map((l) => l.account)).toEqual(['131', '511']);
    expect(p.total).toBe('335000');
  });
  it('keeps decimals exact without JS numbers', () => {
    const p = settlementProposal(input([{ sales: '0.1', sellerDiscount: '0', refund: '0' }, { sales: '0.2', sellerDiscount: '0.0001', refund: '0' }]), maps);
    expect(p.lines[0]!.debit).toBe('0.2999');
    expect(p.lines[1]!.credit).toBe('0.2999');
  });
  it('allows a null party for the later slice to fill', () => {
    expect(settlementProposal(input(two), maps).lines[0]!.partyId).toBeNull();
  });
  it('reduces 511 and 131 by a refunded order and keeps the refund visible', () => {
    const lines = [...two, { sales: '80000', sellerDiscount: '0', refund: '80000' }, { sales: '0', sellerDiscount: '0', refund: '15000' }];
    const p = settlementProposal(input(lines), maps);
    expect(p.lines[0]).toMatchObject({ account: '131', debit: '320000', credit: '0' });
    expect(p.lines[1]).toMatchObject({ account: '511', debit: '0', credit: '320000' });
    expect(p.sales).toBe('430000');
    expect(p.sellerDiscount).toBe('15000');
    expect(p.refund).toBe('95000');
    expect(p.total).toBe('320000');
  });
  it('marks the refund rule commentary beside the map', () => {
    expect(MARKETPLACE_POSTING_MAPS.tt133!.salesReturn).toMatchObject({ code: '511', status: 'commentary' });
  });
  it('posts the other way when refunds and discounts exceed the sales', () => {
    const p = settlementProposal(input([{ sales: '1000', sellerDiscount: '500', refund: '8500' }], { partyId: 'party-1' }), maps);
    expect(p.lines[0]).toMatchObject({ account: '511', debit: '8000', credit: '0', partyId: null });
    expect(p.lines[1]).toMatchObject({ account: '131', debit: '0', credit: '8000', partyId: 'party-1' });
    expect(p.total).toBe('8000');
    expect(p.refund).toBe('8500');
  });
  it('refuses a zero or empty net', () => {
    for (const lines of [[{ sales: '5000', sellerDiscount: '5000', refund: '0' }], [{ sales: '5000', sellerDiscount: '0', refund: '5000' }], [{ sales: '0.00004', sellerDiscount: '0', refund: '0' }], []]) {
      expect(code(() => settlementProposal(input(lines), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    }
  });
  it('balances by construction', () => {
    const p = settlementProposal(input(two), maps);
    const debit = p.lines.reduce((a, l) => a.plus(money(l.debit)), money('0'));
    const credit = p.lines.reduce((a, l) => a.plus(money(l.credit)), money('0'));
    expect(debit.equals(credit)).toBe(true);
  });
  it('refuses negative, malformed or over-precise amounts and a net that rounds to zero', () => {
    for (const l of [{ sales: '100', sellerDiscount: '-50', refund: '0' }, { sales: '-5', sellerDiscount: '0', refund: '0' }, { sales: 'abc', sellerDiscount: '0', refund: '0' }, { sales: '1e3', sellerDiscount: '0', refund: '0' }, { sales: '1.00001', sellerDiscount: '0', refund: '0' }]) {
      expect(code(() => settlementProposal(input([l]), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    }
  });
});

describe('gate strictness', () => {
  it('needs every row confirmed, not just the top flag', () => {
    const base = MARKETPLACE_POSTING_MAPS.tt133!;
    expect(code(() => requireConfirmedMarketplaceMap('tt133', { tt133: { ...base, status: 'confirmed' } }))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('cannot be flipped in place at runtime', () => {
    expect(() => { (MARKETPLACE_POSTING_MAPS.tt133 as { status: string }).status = 'confirmed'; }).toThrow();
    expect(Object.isFrozen(MARKETPLACE_POSTING_MAPS.tt133!.revenue)).toBe(true);
  });
});

describe('the gate is per path (#3711 slice 1)', () => {
  // Every row confirmed but the three of the household tax path: the accountant has not named the owner's equity account yet.
  const withoutHouseholdTax = () => {
    const m = confirmed();
    for (const row of ['vatPayable', 'pitPayable', 'pitOwnerEquity'] as const) m.tt133 = { ...m.tt133!, [row]: { ...m.tt133![row], status: 'commentary' as const } };
    return m;
  };
  const household = (tax: string) => input([{ sales: '10000000', sellerDiscount: '0', refund: '0', taxWithheld: tax }], { tax: { vatPercent: '1', pitPercent: '0.5' } });
  it('opens the sales, payout and fee accrual paths while the household tax rows are commentary', () => {
    const maps = withoutHouseholdTax();
    for (const path of ['sales', 'payout', 'fee_accrual'] as const) expect(requireConfirmedMarketplaceMap('tt133', maps, [path]).status).toBe('confirmed');
    expect(code(() => requireConfirmedMarketplaceMap('tt133', maps, ['household_tax']))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    // Asking for every row, as before, still refuses.
    expect(code(() => requireConfirmedMarketplaceMap('tt133', maps))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('posts a company settlement but refuses a settlement that carries household tax, until the owner\'s equity row is confirmed', () => {
    const maps = withoutHouseholdTax();
    expect(settlementProposal(input([{ sales: '100', sellerDiscount: '0', refund: '0' }]), maps).lines.length).toBe(2);
    // A household seller with nothing withheld posts like a company; with tax withheld it waits.
    expect(settlementProposal(household('0'), maps).lines.length).toBe(2);
    expect(code(() => settlementProposal(household('150000'), maps))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(settlementProposal(household('150000'), confirmed()).taxWithheld).toBe('150000');
  });
  it('a path asks only for its own rows: one commentary row of another path does not close it', () => {
    for (const [row, closed] of [['cash', ['payout']], ['feeExpense', ['fee_accrual']], ['revenue', ['sales']]] as const) {
      const m = confirmed();
      m.tt133 = { ...m.tt133!, [row]: { ...m.tt133![row], status: 'commentary' as const } };
      for (const path of ['sales', 'payout', 'fee_accrual', 'household_tax'] as const) {
        const refused = closed.includes(path as never);
        expect(code(() => requireConfirmedMarketplaceMap('tt133', m, [path])), `${row} ${path}`).toEqual(refused ? { code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 } : null);
      }
    }
  });
  it('books the household PIT against owner\'s equity, never an expense account (research A4, D2)', () => {
    const account = MARKETPLACE_POSTING_MAPS.tt133!.pitOwnerEquity;
    expect(account.code).toMatch(/^4/);
    expect(account.status).toBe('commentary');
  });
});

describe('the TT99 map (#3711 slice 4)', () => {
  const tt99 = MARKETPLACE_POSTING_MAPS.tt99!;
  // The TT99 map confirmed for the test, leaving the shipped one alone.
  const confirmedTt99 = (): Record<string, MarketplacePostingMap> => {
    const c = (r: MarketplacePostingMap['revenue']) => ({ ...r, status: 'confirmed' as const });
    return { tt99: { ...tt99, status: 'confirmed', receivable: c(tt99.receivable), revenue: c(tt99.revenue), salesReturn: c(tt99.salesReturn), cash: c(tt99.cash), feePayable: c(tt99.feePayable), feeAwaitingInvoice: c(tt99.feeAwaitingInvoice), taxWithheld: c(tt99.taxWithheld), vatPayable: c(tt99.vatPayable), pitPayable: c(tt99.pitPayable), pitOwnerEquity: c(tt99.pitOwnerEquity), feeExpense: c(tt99.feeExpense), accruedExpense: c(tt99.accruedExpense) } };
  };
  it('ships as commentary, so no path opens from it until the accountant confirms', () => {
    expect(tt99.regime).toBe('tt99');
    expect(tt99.status).toBe('commentary');
    for (const r of [tt99.receivable, tt99.revenue, tt99.salesReturn, tt99.cash, tt99.feePayable, tt99.feeAwaitingInvoice, tt99.taxWithheld, tt99.vatPayable, tt99.pitPayable, tt99.pitOwnerEquity, tt99.feeExpense, tt99.accruedExpense]) expect(r.status).toBe('commentary');
    for (const path of ['sales', 'payout', 'fee_accrual', 'household_tax'] as const) expect(code(() => requireConfirmedMarketplaceMap('tt99', undefined, [path])), path).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
  });
  it('books the fees on 641 (sub-account 6417, not the staff cost 6421), the accrual on 335 and a refund on 521', () => {
    expect([tt99.feePayable.code, tt99.feeExpense.code, tt99.accruedExpense.code, tt99.salesReturn.code]).toEqual(['331', '6417', '335', '521']);
    // The rows tt133 and tt99 share are the same accounts.
    const tt133 = MARKETPLACE_POSTING_MAPS.tt133!;
    for (const key of ['receivable', 'revenue', 'cash', 'feePayable', 'vatPayable', 'pitPayable', 'pitOwnerEquity', 'accruedExpense'] as const) expect(tt99[key].code, key).toBe(tt133[key].code);
    expect(tt133.feeExpense.code).toBe('6421');
  });
  it('posts a TT99 settlement without a refund as 131 against 511', () => {
    const p = settlementProposal(input([{ sales: '200000', sellerDiscount: '0', refund: '0' }], { regime: 'tt99' }), confirmedTt99());
    expect(p.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['131', '200000', '0'], ['511', '0', '200000']]);
  });
  const rows = (p: ReturnType<typeof settlementProposal>) => p.lines.map((l) => [l.account, l.debit, l.credit]);
  const balanced = (p: ReturnType<typeof settlementProposal>) => p.lines.reduce((a, l) => a.plus(l.debit), money('0')).equals(p.lines.reduce((a, l) => a.plus(l.credit), money('0')));
  it('books a refund of a TT99 settlement as its own debit on 521, and TT133 still nets it into 511 (#4017)', () => {
    const refunded = input([{ sales: '200000', sellerDiscount: '0', refund: '30000' }], { regime: 'tt99' });
    const p = settlementProposal(refunded, confirmedTt99());
    expect(rows(p)).toEqual([['131', '170000', '0'], ['521', '30000', '0'], ['511', '0', '200000']]);
    expect(p.refund).toBe('30000');
    expect(p.total).toBe('200000');
    expect(balanced(p)).toBe(true);
    expect(rows(settlementProposal({ ...refunded, regime: 'tt133' }, confirmed()))).toEqual([['131', '170000', '0'], ['511', '0', '170000']]);
  });
  it('credits 511 with the sales less the seller discounts and debits 131 with what the platform owes after the discounts and the refund', () => {
    const p = settlementProposal(input([{ sales: '200000', sellerDiscount: '20000', refund: '30000' }], { regime: 'tt99' }), confirmedTt99());
    expect(rows(p)).toEqual([['131', '150000', '0'], ['521', '30000', '0'], ['511', '0', '180000']]);
    expect(balanced(p)).toBe(true);
  });
  it('runs 131 the other way for a month whose refunds exceed its sales, with the refund still on 521', () => {
    const p = settlementProposal(input([{ sales: '40000', sellerDiscount: '0', refund: '0' }, { sales: '0', sellerDiscount: '0', refund: '70000' }], { regime: 'tt99' }), confirmedTt99());
    expect(rows(p)).toEqual([['521', '70000', '0'], ['131', '0', '30000'], ['511', '0', '40000']]);
    expect(balanced(p)).toBe(true);
  });
  it('posts only the 521 / 511 pair when the refund equals the sales (no 131 line), and refuses a month with nothing at all', () => {
    const p = settlementProposal(input([{ sales: '50000', sellerDiscount: '0', refund: '50000' }], { regime: 'tt99' }), confirmedTt99());
    expect(rows(p)).toEqual([['521', '50000', '0'], ['511', '0', '50000']]);
    expect(code(() => settlementProposal(input([{ sales: '0', sellerDiscount: '0', refund: '0' }], { regime: 'tt99' }), confirmedTt99()))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
  });
  it('runs 131 and 511 the other way when the seller discounts exceed the sales, and keeps a refund on 521 beside them', () => {
    const discounts = settlementProposal(input([{ sales: '10000', sellerDiscount: '25000', refund: '0' }], { regime: 'tt99' }), confirmedTt99());
    expect(rows(discounts)).toEqual([['511', '15000', '0'], ['131', '0', '15000']]);
    const both = settlementProposal(input([{ sales: '10000', sellerDiscount: '25000', refund: '5000' }], { regime: 'tt99' }), confirmedTt99());
    expect(rows(both)).toEqual([['521', '5000', '0'], ['511', '15000', '0'], ['131', '0', '20000']]);
    expect(balanced(discounts) && balanced(both)).toBe(true);
  });
  it('adds the household tax lines after the refund lines of a TT99 settlement', () => {
    const p = settlementProposal(input([{ sales: '10000000', sellerDiscount: '0', refund: '1000000', taxWithheld: '135000' }], { regime: 'tt99', tax: { vatPercent: '1', pitPercent: '0.5' } }), confirmedTt99());
    expect(rows(p)).toEqual([['131', '9000000', '0'], ['521', '1000000', '0'], ['511', '0', '10000000'], ['511', '90000', '0'], ['3331', '0', '90000'], ['4212', '45000', '0'], ['3335', '0', '45000']]);
    expect(balanced(p)).toBe(true);
  });
  it('leaves the party on the 131 line and posts the same 131 amount the payout clears (sales - discounts - refunds)', () => {
    const p = settlementProposal({ ...input([{ sales: '200000', sellerDiscount: '20000', refund: '30000' }], { regime: 'tt99' }), partyId: 'party-1' }, confirmedTt99());
    expect(p.lines.filter((l) => l.partyId === 'party-1').map((l) => [l.account, l.debit])).toEqual([['131', '150000']]);
  });
});

describe('the tax a platform withheld from a household seller (slice C2)', () => {
  const taxed = (tax: string, over: Partial<SettlementProposalInput> = {}) =>
    input([{ sales: '10000000', sellerDiscount: '0', refund: '0', taxWithheld: tax }], { tax: { vatPercent: '1', pitPercent: '0.5' }, ...over });
  const maps = confirmed();
  it('splits the tax by the rate pair, VAT against 511 and PIT against the owner\'s equity row, and balances', () => {
    const p = settlementProposal(taxed('150000'), maps);
    expect(p.taxWithheld).toBe('150000');
    expect(p.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['131', '10000000', '0'], ['511', '0', '10000000'], ['511', '100000', '0'], ['3331', '0', '100000'], ['4212', '50000', '0'], ['3335', '0', '50000'],
    ]);
    expect(p.total).toBe('10150000');
    expect(p.lines.reduce((a, l) => a.plus(l.debit), money('0')).equals(p.lines.reduce((a, l) => a.plus(l.credit), money('0')))).toBe(true);
  });
  it('rounds the VAT part to whole dong and leaves the remainder to the PIT, so the two add up to the tax withheld', () => {
    const p = settlementProposal(taxed('100001'), maps);
    const credit = (account: string) => p.lines.filter((l) => l.account === account).reduce((a, l) => a.plus(l.credit), money('0'));
    expect(credit('3331').toFixed(0)).toBe('66667');
    expect(credit('3335').toFixed(0)).toBe('33334');
    expect(credit('3331').plus(credit('3335')).toFixed(0)).toBe('100001');
  });
  it('posts no tax line for a seller that is no household, or when nothing was withheld', () => {
    expect(settlementProposal(taxed('150000', { tax: null }), maps).lines).toHaveLength(2);
    expect(settlementProposal(taxed('0'), maps).lines).toHaveLength(2);
    expect(settlementProposal(taxed('150000', { tax: null }), maps).taxWithheld).toBe('0');
  });
  it('posts only the tax lines for a month whose net is zero but whose lines carry withheld tax, and still refuses a zero net with no tax', () => {
    const zero = input([{ sales: '40000', sellerDiscount: '0', refund: '0', taxWithheld: '600' }, { sales: '0', sellerDiscount: '0', refund: '40000', taxWithheld: '0' }], { tax: { vatPercent: '1', pitPercent: '0.5' } });
    const p = settlementProposal(zero, maps);
    expect(p.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['511', '400', '0'], ['3331', '0', '400'], ['4212', '200', '0'], ['3335', '0', '200']]);
    expect(p.total).toBe('600');
    expect(code(() => settlementProposal({ ...zero, tax: null }, maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
  });
  it('marks the split as an estimate in the memo of the tax lines and carries the difference to what the rate pair would withhold (research D1)', () => {
    const exact = settlementProposal(taxed('150000'), maps);
    expect(exact.taxEstimate).toEqual({ withheld: '150000', expected: '150000', difference: '0' });
    for (const l of exact.lines.filter((x) => ['3331', '3335', '4212'].includes(x.account) || (x.account === '511' && x.debit !== '0' && x.debit !== exact.sales))) expect(l.memo).toContain('ước tính');
    expect(exact.lines.filter((l) => l.account === '131').every((l) => !l.memo.includes('ước tính'))).toBe(true);
    // The platform withheld less than the pair would: a negative difference. More: a positive one.
    expect(settlementProposal(taxed('140000'), maps).taxEstimate).toEqual({ withheld: '140000', expected: '150000', difference: '-10000' });
    expect(settlementProposal(taxed('165000'), maps).taxEstimate).toEqual({ withheld: '165000', expected: '150000', difference: '15000' });
  });
  it('takes the rate pair of the revenue net of the seller discounts and the refunds, and has no estimate without withheld tax or for a non-household', () => {
    const lines = [{ sales: '10000000', sellerDiscount: '1000000', refund: '1000000', taxWithheld: '120000' }];
    const p = settlementProposal(input(lines, { tax: { vatPercent: '1', pitPercent: '0.5' } }), maps);
    expect(p.taxEstimate).toEqual({ withheld: '120000', expected: '120000', difference: '0' });
    expect(settlementProposal(taxed('0'), maps).taxEstimate).toBeNull();
    expect(settlementProposal(taxed('150000', { tax: null }), maps).taxEstimate).toBeNull();
  });
  it('refuses a rate pair that cannot split the tax', () => {
    expect(code(() => settlementProposal(taxed('150000', { tax: { vatPercent: '0', pitPercent: '0' } }), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
  });
  it('refuses a withheld total that is not whole dong, with a rate pair that would round it away', () => {
    for (const tax of ['100.5', '100.4', '0.5']) {
      expect(code(() => settlementProposal(taxed(tax, { tax: { vatPercent: '1', pitPercent: '0' } }), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
      expect(code(() => settlementProposal(taxed(tax), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
    }
  });
  it('refuses a malformed or negative tax amount', () => {
    expect(code(() => settlementProposal(taxed('-5'), maps))).toEqual({ code: 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE', status: 422 });
  });
  it('is not confirmed while any of the three new rows is commentary', () => {
    for (const row of ['vatPayable', 'pitPayable', 'pitOwnerEquity'] as const) {
      const one = confirmed();
      one.tt133 = { ...one.tt133!, [row]: { ...one.tt133![row], status: 'commentary' as const } };
      expect(code(() => requireConfirmedMarketplaceMap('tt133', one))).toEqual({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    }
  });
});
