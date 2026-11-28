// SPDX-License-Identifier: AGPL-3.0-only
// The 30/60/90-day cash-flow forecast (#4391) as pure functions: nothing here reads the database or calls a model. The reads (cash-forecast.ts) hand over what the books hold; this file
// decides every figure. Money is decimal strings and decimal.js throughout, never a JS number.
//
// The rules (the design and the PO's decisions are on #4391):
// - Day 0 is the as-of day. The opening cash is the booked 111 + 112 on it, so the balance of day 0 is that cash plus the items dated day 0.
// - A receipt is an open sales invoice on its due date (invoice date + terms). A receipt already overdue is NOT counted (its money has not come): it is returned apart. The part of 131 no
//   invoice covers is also not counted.
// - A payable is an open purchase invoice dated on its due_date when present (#4395), else its invoice date + PAYABLE_TERMS_DAYS
//   (flagged as an estimate), and an overdue one on day 0: a debt owed is expected to be paid, a receivable that is late is not expected.
//   The part of 331 no purchase invoice covers is counted on day 0.
// - An approved supplier payment is dated on the first day its bank file may go. Its amount is still inside the party's 331 until a bank line is matched, so it is taken out of that
//   party's pool first (and its invoice out of the allocation): nothing is counted twice. What it counts for is capped by the party's 331 balance, so a payment already booked by hand does not
//   leave twice.
// - An item the owner entered (#5326) falls on each of its dates in the window (domain/cash-forecast-items.ts) as entered_in or entered_out. Entering one takes its category off the left-out line (loan: loans;
//   other: recurring costs, only when it repeats); the books' own figures are unchanged. Nothing else is derived from its label, which never gets here.
// - Items past day 90 are left out. The lowest balance is the earliest day on a tie.
import { Decimal, type DecimalValue } from '@ludy/l10n-vn';
import {
  CASH_FORECAST_CHECKPOINTS,
  CASH_FORECAST_DAYS,
  CASH_FORECAST_NOT_INCLUDED,
  CASH_FORECAST_TOP_ITEMS,
  PAYABLE_TERMS_DAYS,
  type CashForecast,
  type CashForecastCheckpoint,
  type CashForecastEnteredCategory,
  type CashForecastEnteredDirection,
  type CashForecastEnteredRecurrence,
  type CashForecastItem,
  type CashForecastNotIncluded,
  type CashForecastTaxMarker,
} from '@ludy/kernel-contract';
import { occurrencesOf } from './cash-forecast-items.ts';
import { canonical } from './money.ts';
import { addDays, allocateReceivable, daysBetween, type OpenInvoice, type SaleInvoice } from './payment-reminder.ts';

export interface ApprovedPayment {
  // The purchase invoice it pays (one payment per invoice) and what it pays, a decimal string above zero.
  documentId: string;
  amount: string;
  // The first day its bank file may go: its 24-hour hold's day, else the as-of day (never earlier than that).
  payableOn: string;
}

export interface PayableDocument extends SaleInvoice {
  dueDate?: string | null | undefined;
}

export interface OpenPayable extends OpenInvoice {
  dueDateEstimated: boolean;
}

export interface PayablePool {
  open: OpenPayable[];
  // The 331 balance no purchase invoice covers (positive), counted on day 0.
  unlinked: string;
  // The approved payments that count, each capped so that together they never exceed the party's 331 balance.
  approved: ApprovedPayment[];
}

// Lays one supplier's 331 balance (credit minus debit, a decimal string) over its purchase invoices, after taking its approved payments out: the payments count first, in the order of their day, up to the
// balance, and what each counts for comes off its own invoice (the whole invoice leaves the allocation only when the payment covers all of it; a partial payment leaves the rest of the invoice to be laid
// over). A balance at or below zero (nothing owed, or overpaid) counts nothing, and neither does an approved payment of a supplier with no positive balance. Open invoices use their explicit dueDate when
// present, else invoice date + PAYABLE_TERMS_DAYS (flagged dueDateEstimated).
export function allocatePayable(documents: readonly PayableDocument[], balance: string, approved: readonly ApprovedPayment[], today: string): PayablePool {
  let left = Decimal.max(new Decimal(balance), 0);
  const counted: ApprovedPayment[] = [];
  const paidOn = new Map<string, DecimalValue>();
  for (const payment of [...approved].sort((a, b) => a.payableOn.localeCompare(b.payableOn) || a.documentId.localeCompare(b.documentId))) {
    if (left.lessThanOrEqualTo(0)) break;
    const amount = Decimal.min(new Decimal(payment.amount), left);
    if (amount.lessThanOrEqualTo(0)) continue;
    left = left.minus(amount);
    counted.push({ ...payment, amount: amount.toFixed() });
    paidOn.set(payment.documentId, (paidOn.get(payment.documentId) ?? new Decimal(0)).plus(amount));
  }
  const remaining = documents.flatMap((d) => {
    const paid = paidOn.get(d.id);
    if (!paid) return [d];
    const rest = new Decimal(d.total).minus(paid);
    return rest.greaterThan(0) ? [{ ...d, total: rest.toFixed() }] : [];
  });
  const byId = new Map(remaining.map((d) => [d.id, d]));
  const rest = allocateReceivable(remaining, left.toFixed(), today, PAYABLE_TERMS_DAYS);
  const open: OpenPayable[] = rest.open.map((inv) => {
    const docDue = byId.get(inv.id)?.dueDate ?? null;
    const dueDate = docDue ?? inv.dueDate;
    return {
      ...inv,
      dueDate,
      daysOverdue: daysBetween(dueDate, today),
      dueDateEstimated: docDue === null,
    };
  });
  return { open, unlinked: rest.other, approved: counted };
}

// An item the owner entered, as the forecast needs it: no label (the owner's words never reach the figures, the audit or the model).
export interface EnteredForecastItem {
  category: CashForecastEnteredCategory;
  direction: CashForecastEnteredDirection;
  // Whole dong above zero, a decimal string.
  amount: string;
  firstDate: string;
  recurrence: CashForecastEnteredRecurrence;
  endDate: string | null;
}

// What an entered item brings into the forecast, so the left-out line stops naming it. A one-off "other" is no recurring cost, so it leaves that line alone.
const COVERS: Readonly<Record<CashForecastEnteredCategory, CashForecastNotIncluded>> = { payroll: 'payroll', insurance: 'insurance', tax: 'tax', rent: 'rent', loan: 'loans', other: 'recurring' };

export function notIncludedAfter(entered: readonly Pick<EnteredForecastItem, 'category' | 'recurrence'>[]): CashForecastNotIncluded[] {
  const covered = new Set<CashForecastNotIncluded>();
  for (const item of entered) {
    if (item.category === 'other' && item.recurrence === 'once') continue;
    covered.add(COVERS[item.category]);
  }
  return CASH_FORECAST_NOT_INCLUDED.filter((key) => !covered.has(key));
}

export interface CashForecastInput {
  legalEntityId: string;
  // Day 0, YYYY-MM-DD.
  today: string;
  // The booked 111 + 112 on day 0, a decimal string (it may be negative: an overdraft).
  openingCash: string;
  empty: boolean;
  // Open sales invoices (any date) and the 131 no invoice covers.
  receivables: readonly { dueDate: string; amountDue: string }[];
  unlinkedReceivables: string;
  // The open purchase invoices of every supplier, from allocatePayable, the 331 no invoice covers and the approved payments that count.
  payables: readonly { dueDate: string; amountDue: string; estimated?: boolean | undefined }[];
  unlinkedPayables: string;
  approvedPayments: readonly ApprovedPayment[];
  taxMarkers: readonly CashForecastTaxMarker[];
  // The items the owner entered for this entity (at most CASH_FORECAST_ITEMS_MAX), empty when there are none.
  entered: readonly EnteredForecastItem[];
  truncated: boolean;
}

const ZERO = new Decimal(0);
const sumOf = (values: readonly DecimalValue[]): DecimalValue => values.reduce((total, v) => total.plus(v), ZERO);

// The day index of a date from day 0: below 0 is before today, above CASH_FORECAST_DAYS is past the horizon.
const indexOf = (today: string, date: string): number => daysBetween(today, date);

export function buildCashForecast(input: CashForecastInput): CashForecast {
  const { today } = input;
  const items: CashForecastItem[] = [];
  let overdueReceipts = ZERO;
  for (const r of input.receivables) {
    const amount = new Decimal(r.amountDue);
    if (amount.lessThanOrEqualTo(0)) continue;
    const at = indexOf(today, r.dueDate);
    if (at < 0) overdueReceipts = overdueReceipts.plus(amount);
    else if (at <= CASH_FORECAST_DAYS) items.push({ kind: 'receipt', date: r.dueDate, amount: canonical(amount) });
  }
  let estimatedPayables = false;
  for (const p of input.payables) {
    const amount = new Decimal(p.amountDue);
    if (amount.lessThanOrEqualTo(0)) continue;
    const at = indexOf(today, p.dueDate);
    // An overdue payable is expected to be paid at once: day 0.
    if (at <= CASH_FORECAST_DAYS) {
      const estimated = p.estimated ?? true;
      if (estimated) estimatedPayables = true;
      items.push({ kind: 'payable', date: at < 0 ? today : p.dueDate, amount: canonical(amount), estimated });
    }
  }
  const unlinkedPayables = new Decimal(input.unlinkedPayables);
  if (unlinkedPayables.greaterThan(0)) items.push({ kind: 'unlinked_payable', date: today, amount: canonical(unlinkedPayables) });
  for (const a of input.approvedPayments) {
    const amount = new Decimal(a.amount);
    if (amount.lessThanOrEqualTo(0)) continue;
    const at = indexOf(today, a.payableOn);
    if (at <= CASH_FORECAST_DAYS) items.push({ kind: 'approved_payment', date: at < 0 ? today : a.payableOn, amount: canonical(amount) });
  }
  for (const e of input.entered) {
    const amount = new Decimal(e.amount);
    if (amount.lessThanOrEqualTo(0)) continue;
    for (const date of occurrencesOf(e, today)) items.push({ kind: e.direction === 'in' ? 'entered_in' : 'entered_out', date, amount: canonical(amount) });
  }

  const opening = new Decimal(input.openingCash);
  const inOf: DecimalValue[] = Array.from({ length: CASH_FORECAST_DAYS + 1 }, () => ZERO);
  const outOf: DecimalValue[] = Array.from({ length: CASH_FORECAST_DAYS + 1 }, () => ZERO);
  for (const item of items) {
    const at = indexOf(today, item.date);
    if (item.kind === 'receipt' || item.kind === 'entered_in') inOf[at] = (inOf[at] ?? ZERO).plus(item.amount);
    else outOf[at] = (outOf[at] ?? ZERO).plus(item.amount);
  }
  const series: { date: string; balance: string }[] = [];
  const balances: DecimalValue[] = [];
  let running = opening;
  let low = 0;
  for (let day = 0; day <= CASH_FORECAST_DAYS; day++) {
    running = running.plus(inOf[day] ?? ZERO).minus(outOf[day] ?? ZERO);
    balances.push(running);
    series.push({ date: addDays(today, day), balance: canonical(running) });
    if (running.lessThan(balances[low] ?? running)) low = day;
  }
  const checkpoints: CashForecastCheckpoint[] = CASH_FORECAST_CHECKPOINTS.map((days) => ({
    days,
    date: addDays(today, days),
    balance: canonical(balances[days] ?? opening),
    receipts: canonical(sumOf(inOf.slice(0, days + 1))),
    payments: canonical(sumOf(outOf.slice(0, days + 1))),
  }));
  const topItems = items
    .filter((item) => indexOf(today, item.date) <= low)
    .sort((a, b) => new Decimal(b.amount).comparedTo(a.amount) || a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
    .slice(0, CASH_FORECAST_TOP_ITEMS);
  const unlinkedReceivables = Decimal.max(new Decimal(input.unlinkedReceivables), 0);
  return {
    legalEntityId: input.legalEntityId,
    asOf: today,
    openingCash: canonical(opening),
    empty: input.empty,
    series,
    checkpoints,
    low: series[low] ?? { date: today, balance: canonical(opening) },
    topItems,
    overdueReceiptsNotCounted: canonical(overdueReceipts),
    unlinkedReceivablesNotCounted: canonical(unlinkedReceivables),
    payableTermsDays: PAYABLE_TERMS_DAYS,
    estimatedPayables,
    notIncluded: notIncludedAfter(input.entered),
    taxMarkers: [...input.taxMarkers].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligation.localeCompare(b.obligation)),
    truncated: input.truncated,
  };
}
