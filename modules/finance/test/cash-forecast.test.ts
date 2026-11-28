// SPDX-License-Identifier: AGPL-3.0-only
// The 30/60/90-day cash-flow forecast (#4391): every figure is decided by pure functions, so each rule is a test here (the reads and the database are in apps/kernel/test/finance-cash-forecast.db.test.ts).
import { describe, expect, it } from 'vitest';
import { allocatePayable, buildCashForecast, type ApprovedPayment, type CashForecastInput } from '../src/domain/cash-forecast.ts';
import { addDays, type SaleInvoice } from '../src/domain/payment-reminder.ts';

const TODAY = '2026-12-01';
const ENTITY = '0192f0aa-1111-7222-8333-944445555777';

function input(over: Partial<CashForecastInput> = {}): CashForecastInput {
  return {
    legalEntityId: ENTITY,
    today: TODAY,
    openingCash: '0',
    empty: false,
    receivables: [],
    unlinkedReceivables: '0',
    payables: [],
    unlinkedPayables: '0',
    approvedPayments: [],
    taxMarkers: [],
    truncated: false,
    ...over,
  };
}
const invoice = (id: string, date: string, total: string): SaleInvoice => ({ id, series: 'C26TAA', number: id, date, total, currency: 'VND' });
const day = (n: number) => addDays(TODAY, n);
const receipt = (n: number, amountDue: string) => ({ dueDate: day(n), amountDue });

describe('buildCashForecast', () => {
  it('is flat at the opening cash with nothing in the books, and the low point is today', () => {
    const f = buildCashForecast(input({ openingCash: '0', empty: true }));
    expect(f.series).toHaveLength(91);
    expect(f.series[0]).toEqual({ date: TODAY, balance: '0' });
    expect(f.series[90]).toEqual({ date: day(90), balance: '0' });
    expect(f.low).toEqual({ date: TODAY, balance: '0' });
    expect(f.checkpoints.map((c) => [c.days, c.date, c.balance, c.receipts, c.payments])).toEqual([
      [30, day(30), '0', '0', '0'],
      [60, day(60), '0', '0', '0'],
      [90, day(90), '0', '0', '0'],
    ]);
    expect(f.topItems).toEqual([]);
    expect(f.empty).toBe(true);
    expect(f.notIncluded).toEqual(['payroll', 'insurance', 'tax', 'rent', 'loans', 'recurring']);
    expect(f.overdueReceiptsNotCounted).toBe('0');
  });

  it('counts a receipt on its due day, today included, and leaves out one past day 90', () => {
    const f = buildCashForecast(input({ openingCash: '1000', receivables: [receipt(0, '100'), receipt(10, '200'), receipt(90, '300'), receipt(91, '999')] }));
    expect(f.series[0]?.balance).toBe('1100');
    expect(f.series[9]?.balance).toBe('1100');
    expect(f.series[10]?.balance).toBe('1300');
    expect(f.series[89]?.balance).toBe('1300');
    expect(f.series[90]?.balance).toBe('1600');
    expect(f.checkpoints[2]).toMatchObject({ balance: '1600', receipts: '600', payments: '0' });
  });

  it('does not count an overdue receipt: it is returned apart, with the part of 131 no invoice covers', () => {
    const f = buildCashForecast(input({ openingCash: '1000', receivables: [receipt(-1, '400'), receipt(-30, '50'), receipt(5, '10')], unlinkedReceivables: '70' }));
    expect(f.overdueReceiptsNotCounted).toBe('450');
    expect(f.unlinkedReceivablesNotCounted).toBe('70');
    expect(f.series[90]?.balance).toBe('1010');
  });

  it('puts an overdue payable on day 0 and a later one on its date, and leaves out one past day 90', () => {
    const f = buildCashForecast(input({ openingCash: '1000', payables: [{ dueDate: day(-20), amountDue: '300' }, { dueDate: day(5), amountDue: '200' }, { dueDate: day(91), amountDue: '999' }] }));
    expect(f.series[0]?.balance).toBe('700');
    expect(f.series[4]?.balance).toBe('700');
    expect(f.series[5]?.balance).toBe('500');
    expect(f.series[90]?.balance).toBe('500');
    expect(f.low).toEqual({ date: day(5), balance: '500' });
  });

  it('counts the 331 no invoice covers on day 0', () => {
    const f = buildCashForecast(input({ openingCash: '1000', unlinkedPayables: '250' }));
    expect(f.series[0]?.balance).toBe('750');
    expect(f.topItems).toEqual([{ kind: 'unlinked_payable', date: TODAY, amount: '250' }]);
  });

  it('puts an approved supplier payment on its day, today at the earliest', () => {
    const f = buildCashForecast(input({ openingCash: '1000', approvedPayments: [{ documentId: 'a', amount: '400', payableOn: day(-3) }, { documentId: 'b', amount: '100', payableOn: day(7) }] }));
    expect(f.series[0]?.balance).toBe('600');
    expect(f.series[6]?.balance).toBe('600');
    expect(f.series[7]?.balance).toBe('500');
  });

  it('takes the earliest day on a tie for the low point, and the low point can be the opening cash', () => {
    const tie = buildCashForecast(input({ openingCash: '1000', payables: [{ dueDate: day(5), amountDue: '300' }], receivables: [receipt(10, '300'), receipt(20, '0.5')] }));
    expect(tie.low).toEqual({ date: day(5), balance: '700' });
    const rising = buildCashForecast(input({ openingCash: '1000', receivables: [receipt(3, '5')] }));
    expect(rising.low).toEqual({ date: TODAY, balance: '1000' });
  });

  it('puts an item of day 30 in the 30-day checkpoint and one of day 31 in the next', () => {
    const f = buildCashForecast(input({ openingCash: '1000', receivables: [receipt(30, '100'), receipt(31, '10')], payables: [{ dueDate: day(30), amountDue: '40' }, { dueDate: day(60), amountDue: '5' }] }));
    const [c30, c60, c90] = f.checkpoints;
    expect(c30).toMatchObject({ balance: '1060', receipts: '100', payments: '40' });
    expect(c60).toMatchObject({ balance: '1065', receipts: '110', payments: '45' });
    expect(c90).toMatchObject({ balance: '1065', receipts: '110', payments: '45' });
  });

  it('adds decimals exactly and keeps large amounts whole', () => {
    const f = buildCashForecast(input({ openingCash: '0.1', receivables: [receipt(1, '0.2')] }));
    expect(f.series[1]?.balance).toBe('0.3');
    const big = buildCashForecast(input({ openingCash: '9007199254740993', receivables: [receipt(1, '1')], payables: [{ dueDate: day(2), amountDue: '9007199254740995' }] }));
    expect(big.series[1]?.balance).toBe('9007199254740994');
    expect(big.series[2]?.balance).toBe('-1');
    expect(big.low).toEqual({ date: day(2), balance: '-1' });
  });

  it('starts below zero with an overdraft and keeps its sign', () => {
    const f = buildCashForecast(input({ openingCash: '-500', receivables: [receipt(4, '200')] }));
    expect(f.openingCash).toBe('-500');
    expect(f.low).toEqual({ date: TODAY, balance: '-500' });
    expect(f.series[4]?.balance).toBe('-300');
  });

  it('lists the five largest items on or before the low day, largest first, and none after it', () => {
    const payables = [10, 20, 30, 40, 50, 60].map((amount, i) => ({ dueDate: day(i + 1), amountDue: String(amount) }));
    const f = buildCashForecast(input({ openingCash: '1000', payables, receivables: [receipt(40, '5')] }));
    expect(f.low.date).toBe(day(6));
    expect(f.topItems.map((i) => [i.kind, i.amount])).toEqual([['payable', '60'], ['payable', '50'], ['payable', '40'], ['payable', '30'], ['payable', '20']]);
    const after = buildCashForecast(input({ openingCash: '1000', payables: [{ dueDate: day(2), amountDue: '100' }], receivables: [receipt(10, '500')] }));
    expect(after.topItems.map((i) => i.amount)).toEqual(['100']);
  });

  it('carries the tax due dates as markers with no amount, in date order, and the partial flag', () => {
    const f = buildCashForecast(input({ taxMarkers: [{ obligation: 'vat_return', period: '2026-12', dueDate: day(20) }, { obligation: 'pit_withholding', period: '2026-11', dueDate: day(9) }], truncated: true }));
    expect(f.taxMarkers.map((m) => m.dueDate)).toEqual([day(9), day(20)]);
    expect(f.truncated).toBe(true);
    expect(f.series.every((d) => d.balance === '0')).toBe(true);
  });

  it('ignores amounts of zero or below, and two entities never share a forecast', () => {
    const f = buildCashForecast(input({ openingCash: '100', receivables: [receipt(1, '0'), receipt(2, '-5')], payables: [{ dueDate: day(1), amountDue: '0' }] }));
    expect(f.series[90]?.balance).toBe('100');
    const a = buildCashForecast(input({ legalEntityId: ENTITY, openingCash: '100' }));
    const b = buildCashForecast(input({ legalEntityId: '0192f0aa-2222-7222-8333-944445555777', openingCash: '900', unlinkedPayables: '50' }));
    expect(a.series[0]?.balance).toBe('100');
    expect(b.series[0]?.balance).toBe('850');
  });
});

describe('allocatePayable', () => {
  const docs = [invoice('1', '2026-10-01', '500'), invoice('2', '2026-11-01', '500')];

  it('lays the 331 balance over the invoices newest first and dates each at invoice date + 30 days', () => {
    const pool = allocatePayable(docs, '700', [], TODAY);
    expect(pool.open.map((o) => [o.id, o.amountDue, o.dueDate])).toEqual([['1', '200', '2026-10-31'], ['2', '500', '2026-12-01']]);
    expect(pool.unlinked).toBe('0');
    expect(pool.approved).toEqual([]);
  });

  it('returns the part of the balance no invoice covers', () => {
    const pool = allocatePayable(docs, '1250', [], TODAY);
    expect(pool.open).toHaveLength(2);
    expect(pool.unlinked).toBe('250');
  });

  it('counts nothing for a balance at or below zero (overpaid)', () => {
    expect(allocatePayable(docs, '0', [], TODAY)).toEqual({ open: [], unlinked: '0', approved: [] });
    expect(allocatePayable(docs, '-100', [], TODAY)).toEqual({ open: [], unlinked: '0', approved: [] });
  });

  it('does not count an approved payment twice: it leaves the pool and its invoice leaves the allocation', () => {
    const approved: ApprovedPayment[] = [{ documentId: '2', amount: '500', payableOn: day(3) }];
    const pool = allocatePayable(docs, '1000', approved, TODAY);
    expect(pool.approved).toEqual(approved);
    expect(pool.open.map((o) => [o.id, o.amountDue])).toEqual([['1', '500']]);
    const forecast = buildCashForecast(input({ openingCash: '2000', payables: pool.open, unlinkedPayables: pool.unlinked, approvedPayments: pool.approved }));
    // 500 for the older invoice (overdue, so on day 0) and 500 on day 3: 1000 in all, the whole balance, never 1500.
    expect(forecast.series[90]?.balance).toBe('1000');
  });

  it('takes only what a partial approved payment pays off its invoice, and lays the rest of the invoice over the balance', () => {
    const approved: ApprovedPayment[] = [{ documentId: '2', amount: '200', payableOn: day(3) }];
    const pool = allocatePayable(docs, '1000', approved, TODAY);
    expect(pool.approved).toEqual(approved);
    // 800 of the balance is left for the invoices: invoice 2 (500, less the 200 paid) is open for 300 and invoice 1 for 500.
    expect(pool.open.map((o) => [o.id, o.amountDue])).toEqual([['1', 500], ['2', 300]].map(([id, a]) => [id, String(a)]));
    expect(pool.unlinked).toBe('0');
    const forecast = buildCashForecast(input({ openingCash: '2000', payables: pool.open, unlinkedPayables: pool.unlinked, approvedPayments: pool.approved }));
    expect(forecast.checkpoints[2]?.payments).toBe('1000');
  });

  it('counts an approved payment of a supplier with no positive balance for nothing', () => {
    const approved: ApprovedPayment[] = [{ documentId: '2', amount: '500', payableOn: day(3) }];
    expect(allocatePayable(docs, '0', approved, TODAY).approved).toEqual([]);
    expect(allocatePayable(docs, '-50', approved, TODAY).approved).toEqual([]);
  });

  it('caps what approved payments count for at the balance, so a payment already booked by hand leaves once', () => {
    const approved: ApprovedPayment[] = [{ documentId: '2', amount: '500', payableOn: day(3) }, { documentId: '1', amount: '500', payableOn: day(1) }];
    const pool = allocatePayable(docs, '600', approved, TODAY);
    expect(pool.approved.map((a) => [a.documentId, a.amount])).toEqual([['1', '500'], ['2', '100']]);
    expect(pool.open).toEqual([]);
    expect(pool.unlinked).toBe('0');
    expect(allocatePayable(docs, '0', approved, TODAY).approved).toEqual([]);
  });

  it('uses an explicit purchase dueDate when present and falls back to +30 days only when absent (#4395)', () => {
    const withTerms = [
      { ...invoice('1', '2026-11-01', '400'), dueDate: '2026-12-20' },
      { ...invoice('2', '2026-11-15', '600'), dueDate: null },
    ];
    const pool = allocatePayable(withTerms, '1000', [], TODAY);
    expect(pool.open.map((o) => [o.id, o.dueDate, o.dueDateEstimated])).toEqual([
      ['2', '2026-12-15', true],
      ['1', '2026-12-20', false],
    ]);
    // Concrete dueDate is already past TODAY (2026-12-01), so daysOverdue reflects the real dueDate.
    const overdueConcrete = allocatePayable([{ ...invoice('3', '2026-11-20', '300'), dueDate: '2026-11-25' }], '300', [], TODAY);
    expect(overdueConcrete.open[0]).toMatchObject({ dueDate: '2026-11-25', daysOverdue: 6, dueDateEstimated: false });

    const allConcrete = buildCashForecast(
      input({
        openingCash: '1000',
        payables: [
          { dueDate: day(15), amountDue: '300', estimated: false },
          { dueDate: day(-2), amountDue: '100', estimated: false },
        ],
      }),
    );
    expect(allConcrete.estimatedPayables).toBe(false);
    expect(allConcrete.topItems).toEqual([
      { kind: 'payable', date: day(15), amount: '300', estimated: false },
      { kind: 'payable', date: TODAY, amount: '100', estimated: false },
    ]);

    const mixed = buildCashForecast(
      input({
        openingCash: '1000',
        payables: [
          { dueDate: day(15), amountDue: '300', estimated: false },
          { dueDate: day(20), amountDue: '400', estimated: true },
        ],
      }),
    );
    expect(mixed.estimatedPayables).toBe(true);
    expect(mixed.topItems).toEqual([
      { kind: 'payable', date: day(20), amount: '400', estimated: true },
      { kind: 'payable', date: day(15), amount: '300', estimated: false },
    ]);
  });
});
