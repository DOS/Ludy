// SPDX-License-Identifier: AGPL-3.0-only
// The amounts of a priced document line and the totals of its lines (docs/plan/crm-quotes.md section 4.4): the one rule a quote uses, and the one a sales
// e-invoice draft uses (`computeDraft`, which has no discount), so a quote's total equals the total of the invoice made from it. Everything is decimal.js
// through `money`, never a JavaScript number.
//
//   amount     = round(quantity x unit price x (1 - discount percent / 100)) to the whole dong, half up
//   vat amount = round(amount x rate / 100) to the whole dong, half up (0 for an exempt rate)
//   totals     = the sums of the rounded lines, so the document adds up as printed
import { money, toMoney } from './money.ts';
import { parseVatRate } from './vat-rate.ts';

// The VAT rates a line of an invoice or a quote may carry: 0, 5, 8 and 10 percent, not subject to tax (KCT) and not declared (KKKNT), written as the
// invoice writes them. The rate "other" (KHAC:<ratio>) is for the invoice's own checks, not for a quote.
export const LINE_VAT_RATES = ['0%', '5%', '8%', '10%', 'KCT', 'KKKNT'] as const;
export type LineVatRate = (typeof LINE_VAT_RATES)[number];

// The rate as written on a line, or null for one that is not allowed ("10", "10%" and " 10 % " are one rate; 7% is none).
export function normalizeLineVatRate(raw: string): LineVatRate | null {
  const parsed = parseVatRate(raw);
  if (parsed.kind === 'exempt') return parsed.code;
  if (parsed.kind === 'percent') {
    const written = `${parsed.percent.toFixed()}%`;
    return (LINE_VAT_RATES as readonly string[]).includes(written) ? (written as LineVatRate) : null;
  }
  return null;
}

export interface PricedLine {
  // Decimal strings.
  quantity: string;
  unitPrice: string;
  // 0 to 100, at most two decimals; absent is none.
  discountPercent?: string | undefined;
  vatRate: string;
}

export interface LineAmounts {
  vatRate: LineVatRate;
  amount: string;
  vatAmount: string;
}

// The amount and the VAT of one line, each to the whole dong, as the money columns store them (four decimals, all zero). A rate that is not allowed throws:
// the caller checks it first.
export function lineAmounts(line: PricedLine): LineAmounts {
  const vatRate = normalizeLineVatRate(line.vatRate);
  if (vatRate === null) throw new Error(`not an allowed VAT rate: ${line.vatRate}`);
  const factor = money(100).minus(money(line.discountPercent ?? '0')).dividedBy(100);
  const amount = money(line.quantity).times(money(line.unitPrice)).times(factor).toDecimalPlaces(0);
  const percent = vatRate === 'KCT' || vatRate === 'KKKNT' ? money(0) : money(vatRate.slice(0, -1));
  const vat = amount.times(percent).dividedBy(100).toDecimalPlaces(0);
  return { vatRate, amount: toMoney(amount), vatAmount: toMoney(vat) };
}

export interface LineTotals<L extends PricedLine> {
  lines: Array<L & LineAmounts>;
  subtotal: string;
  vatAmount: string;
  total: string;
}

// The lines with their amounts, and the sums of those amounts.
export function totalLines<L extends PricedLine>(lines: readonly L[]): LineTotals<L> {
  const computed = lines.map((line) => ({ ...line, ...lineAmounts(line) }));
  const subtotal = computed.reduce((acc, line) => acc.plus(money(line.amount)), money(0));
  const vat = computed.reduce((acc, line) => acc.plus(money(line.vatAmount)), money(0));
  return { lines: computed, subtotal: toMoney(subtotal), vatAmount: toMoney(vat), total: toMoney(subtotal.plus(vat)) };
}
