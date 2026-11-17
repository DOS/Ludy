// SPDX-License-Identifier: AGPL-3.0-only
// The deterministic part of a sales e-invoice draft (#2500, plan einvoice-issue.md section 8 step 2): the amounts of a draft from
// its lines (decimal arithmetic, never a typed total) and the checks Decree 254 Art. 10 and the provider's rules ask of it. Pure:
// no database, no provider. A failed check is a code on a field; nothing is sent either way.
import type { BuyerIdentityKind, BuyerKind, DraftIssue, DraftIssueCode } from '@crove/kernel-contract';
import { computeLineTotals, money, normalizeVatRate, parseTaxCode, reducedRateApplies, sumLineTotals } from '@crove/l10n-vn';

export { normalizeVatRate };


export interface DraftLineInput {
  description: string;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

export interface DraftBuyerInput {
  kind: BuyerKind;
  taxCode: string | null;
  name: string | null;
  address: string | null;
  email: string | null;
  // An individual's CCCD, passport or budget code (one); null for any other buyer.
  identity: { kind: BuyerIdentityKind; value: string } | null;
}

export interface DraftInput {
  // The date the invoice is issued and printed.
  date: string;
  // The moment of the sale when it is not the invoice's day (#3535), and the person's reason when the invoice is late.
  saleDate: string | null;
  lateReason: string | null;
  currency: string;
  seriesId: string | null;
  buyer: DraftBuyerInput;
  lines: readonly DraftLineInput[];
  // The day the VAT rate of the lines is judged on when it is not the draft's own: an adjusting or replacing invoice keeps the rate and the date of the invoice it corrects (plan
  // einvoice-issue.md, "VAT 8% ends on 2026-12-31"). Left out, it is the sale date, or the invoice date when there is no sale date.
  rateDate?: string | null;
}

export interface ComputedLine extends DraftLineInput {
  amount: string;
  vatAmount: string;
}

export interface ComputedDraft {
  lines: ComputedLine[];
  subtotal: string;
  vatAmount: string;
  total: string;
}

// The VAT rates and the rounding come from the one shared line-totals rule (@crove/l10n-vn), which a quote uses too. Amounts of a
// draft to the whole dong: each line is the quantity times the unit price and its VAT the rate of that amount, each rounded half
// up; the totals are the sums of the rounded lines, so the invoice adds up as printed. A line that cannot be computed (a quantity
// or price that is not a decimal) is left to the checks.
export function computeDraft(lines: readonly DraftLineInput[]): ComputedDraft {
  const computed: ComputedLine[] = lines.map((line) => ({ ...line, ...computeLineTotals({ quantity: line.quantity, unitPrice: line.unitPrice, vatRate: line.vatRate }) }));
  return { lines: computed, ...sumLineTotals(computed) };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// The day after `date` that is a working day (YYYY-MM-DD): Monday to Friday. Public holidays are not in this rule: the repository holds no calendar of them (the government
// decides some each year), so a holiday counts as a working day here and the warning can be a day late, never a day early.
export function nextWorkingDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next.toISOString().slice(0, 10);
}

// A sale invoiced after its next working day (Decree 254 Art. 9, as read by the accountant of #2506: signed and sent for the code by the next working day) is a late invoice:
// the fine is heavy, and the sale still belongs to the VAT period of its own date (#3535).
export function isLateSale(saleDate: string | null, invoiceDate: string): boolean {
  if (!saleDate || !isDay(saleDate) || !isDay(invoiceDate) || saleDate >= invoiceDate) return false;
  return invoiceDate > nextWorkingDay(saleDate);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The shapes of what an individual buyer gives instead of a tax code: CCCD 12 digits, a passport 6 to 9 letters and digits, a budget-relation unit code 7 digits.
const IDENTITY_SHAPE: Record<BuyerIdentityKind, RegExp> = { cccd: /^\d{12}$/, passport: /^[A-Z0-9]{6,9}$/, budget_code: /^\d{7}$/ };
export function isBuyerIdentity(kind: BuyerIdentityKind, value: string): boolean {
  return IDENTITY_SHAPE[kind].test(value);
}

// The kind and the last three characters, the rest hidden: what a list shows of an identity (never the whole value, never in an audit fact).
export function maskBuyerIdentity(value: string): string {
  return value.length <= 3 ? '•'.repeat(value.length) : `${'•'.repeat(value.length - 3)}${value.slice(-3)}`;
}
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;
const MAX_TOTAL_DIGITS = 15;

// The checks. `today` is the date of the day (YYYY-MM-DD) in the org's calendar. A draft that fails any is saved all the same and
// shown with its issues; only issuing (a later step) needs none.
export function checkDraft(input: DraftInput, computed: ComputedDraft, today: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (field: string, code: DraftIssueCode) => issues.push({ field, code });

  if (!input.date) add('date', 'DATE_REQUIRED');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`)) || new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date) add('date', 'DATE_INVALID');
  else if (input.date > today) add('date', 'DATE_FUTURE');

  if (input.saleDate !== null) {
    if (!isDay(input.saleDate)) add('saleDate', 'SALE_DATE_INVALID');
    else if (isDay(input.date) && input.saleDate > input.date) add('saleDate', 'SALE_DATE_AFTER_INVOICE');
    else if (isLateSale(input.saleDate, input.date) && !input.lateReason?.trim()) add('lateReason', 'LATE_REASON_REQUIRED');
  }

  if (input.currency !== 'VND') add('currency', 'CURRENCY_UNSUPPORTED');
  if (!input.seriesId) add('series', 'SERIES_REQUIRED');

  const buyer = input.buyer;
  if (buyer.kind === 'business') {
    if (!buyer.taxCode) add('buyer.taxCode', 'BUYER_TAX_CODE_REQUIRED');
    else {
      const info = parseTaxCode(buyer.taxCode);
      if (!info) add('buyer.taxCode', 'BUYER_TAX_CODE_INVALID');
      else if (info.checksumValid === false) add('buyer.taxCode', 'BUYER_TAX_CODE_CHECKSUM');
    }
    if (!buyer.name?.trim()) add('buyer.name', 'BUYER_NAME_REQUIRED');
    if (!buyer.address?.trim()) add('buyer.address', 'BUYER_ADDRESS_REQUIRED');
  } else if (buyer.kind === 'individual') {
    if (!buyer.name?.trim()) add('buyer.name', 'BUYER_NAME_REQUIRED');
    // An individual's tax code is optional (12 digits, the national ID) but must be one when given.
    if (buyer.taxCode && !parseTaxCode(buyer.taxCode)) add('buyer.taxCode', 'BUYER_TAX_CODE_INVALID');
  } else if (buyer.taxCode && !parseTaxCode(buyer.taxCode)) {
    add('buyer.taxCode', 'BUYER_TAX_CODE_INVALID');
  }
  if (buyer.email && !EMAIL.test(buyer.email)) add('buyer.email', 'BUYER_EMAIL_INVALID');
  if (buyer.identity && (buyer.kind !== 'individual' || !isBuyerIdentity(buyer.identity.kind, buyer.identity.value))) add('buyer.identity', 'BUYER_IDENTITY_INVALID');

  // 8% only inside a period the reduced rate applied, by the sale date (the invoice date when there is none); an adjustment or a replacement is judged on its original's. With no valid
  // day there is nothing to judge on: the date check says so.
  const rateDay = input.rateDate ?? input.saleDate ?? input.date;
  const rateDayKnown = isDay(rateDay);
  if (input.lines.length === 0) add('lines', 'LINES_REQUIRED');
  input.lines.forEach((line, index) => {
    const at = (key: string) => `lines.${index + 1}.${key}`;
    if (!line.description.trim()) add(at('description'), 'LINE_DESCRIPTION_REQUIRED');
    if (!DECIMAL.test(line.quantity) || money(line.quantity).lessThanOrEqualTo(0)) add(at('quantity'), 'LINE_QUANTITY_INVALID');
    if (!DECIMAL.test(line.unitPrice)) add(at('unitPrice'), 'LINE_PRICE_INVALID');
    const rate = normalizeVatRate(line.vatRate);
    if (rate === null) add(at('vatRate'), 'LINE_VAT_RATE_INVALID');
    else if (rate === '8%' && rateDayKnown && !reducedRateApplies(rateDay)) add(at('vatRate'), 'LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD');
  });
  if (money(computed.total).abs().toFixed(0).length > MAX_TOTAL_DIGITS) add('total', 'TOTAL_TOO_LARGE');
  return issues;
}
