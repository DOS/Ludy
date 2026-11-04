// SPDX-License-Identifier: AGPL-3.0-only
// The deterministic part of a sales e-invoice draft (#2500, plan einvoice-issue.md section 8 step 2): the amounts of a draft from
// its lines (decimal arithmetic, never a typed total) and the checks Decree 254 Art. 10 and the provider's rules ask of it. Pure:
// no database, no provider. A failed check is a code on a field; nothing is sent either way.
import type { BuyerKind, DraftIssue, DraftIssueCode } from '@crove/kernel-contract';
import { money, parseTaxCode, parseVatRate, toMoney } from '@crove/l10n-vn';


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
}

export interface DraftInput {
  date: string;
  currency: string;
  seriesId: string | null;
  buyer: DraftBuyerInput;
  lines: readonly DraftLineInput[];
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

// The VAT rates a provider accepts on a line (plan section 8 step 2): 0, 5, 8 and 10 percent, not subject to tax (KCT), not
// declared (KKKNT), and another rate written KHAC:<ratio>.
const ALLOWED_PERCENTS = ['0', '5', '8', '10'] as const;

// The rate as it is written on the invoice, or null for one that is not allowed.
export function normalizeVatRate(raw: string): string | null {
  const parsed = parseVatRate(raw);
  if (parsed.kind === 'exempt') return parsed.code;
  if (parsed.kind === 'percent') {
    const percent = parsed.percent.toFixed();
    return (ALLOWED_PERCENTS as readonly string[]).includes(percent) ? `${percent}%` : null;
  }
  if (parsed.kind === 'other') return parsed.percent ? `KHAC:${parsed.percent.toFixed()}%` : null;
  return null;
}

function ratePercent(rate: string): ReturnType<typeof money> {
  const parsed = parseVatRate(rate);
  return parsed.kind === 'exempt' || parsed.kind === 'unknown' ? money(0) : (parsed.percent ?? money(0));
}

// Amounts of a draft to the whole dong: each line is the quantity times the unit price and its VAT the rate of that amount, each
// rounded half up; the totals are the sums of the rounded lines, so the invoice adds up as printed. A line that cannot be
// computed (a quantity or price that is not a decimal) is left to the checks.
export function computeDraft(lines: readonly DraftLineInput[]): ComputedDraft {
  const computed: ComputedLine[] = lines.map((line) => {
    const rate = normalizeVatRate(line.vatRate) ?? line.vatRate;
    let amount = money(0);
    try {
      amount = money(line.quantity).times(money(line.unitPrice)).toDecimalPlaces(0);
    } catch {
      // Reported by the checks.
    }
    const vat = amount.times(ratePercent(rate)).dividedBy(100).toDecimalPlaces(0);
    return { ...line, vatRate: rate, amount: toMoney(amount), vatAmount: toMoney(vat) };
  });
  const subtotal = computed.reduce((acc, line) => acc.plus(money(line.amount)), money(0));
  const vat = computed.reduce((acc, line) => acc.plus(money(line.vatAmount)), money(0));
  return { lines: computed, subtotal: toMoney(subtotal), vatAmount: toMoney(vat), total: toMoney(subtotal.plus(vat)) };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

  if (input.lines.length === 0) add('lines', 'LINES_REQUIRED');
  input.lines.forEach((line, index) => {
    const at = (key: string) => `lines.${index + 1}.${key}`;
    if (!line.description.trim()) add(at('description'), 'LINE_DESCRIPTION_REQUIRED');
    if (!DECIMAL.test(line.quantity) || money(line.quantity).lessThanOrEqualTo(0)) add(at('quantity'), 'LINE_QUANTITY_INVALID');
    if (!DECIMAL.test(line.unitPrice)) add(at('unitPrice'), 'LINE_PRICE_INVALID');
    if (normalizeVatRate(line.vatRate) === null) add(at('vatRate'), 'LINE_VAT_RATE_INVALID');
  });
  if (money(computed.total).abs().toFixed(0).length > MAX_TOTAL_DIGITS) add('total', 'TOTAL_TOO_LARGE');
  return issues;
}
