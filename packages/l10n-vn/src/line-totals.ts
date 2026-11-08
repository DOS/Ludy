// SPDX-License-Identifier: AGPL-3.0-only
// The one line-totals rule (docs/plan/crm-quotes.md 4.4, #2693): a quote line and an e-invoice draft line are computed by the
// same function, so a quote total equals the total of the invoice made from it. Decimal strings in, decimal strings out, never
// a JS number. Each line is quantity x unit price x (1 - discount / 100) rounded half up to the whole dong, its VAT the rate of
// that amount rounded half up; the totals are the sums of the rounded lines, so a document adds up as printed.
import { money, toMoney } from './money.ts';
import { parseVatRate } from './vat-rate.ts';

type Decimal = ReturnType<typeof money>;

// The VAT rates a line may carry: 0, 5, 8 and 10 percent, not subject to tax (KCT), not declared (KKKNT), and another rate
// written KHAC:<ratio>. Which rate is valid on which date is the e-invoice checks' rule, not this list's.
export const LINE_VAT_PERCENTS = ['0', '5', '8', '10'] as const;

// The rate as it is written on the invoice ('10%', 'KCT'), or null for one that is not allowed.
export function normalizeVatRate(raw: string): string | null {
  const parsed = parseVatRate(raw);
  if (parsed.kind === 'exempt') return parsed.code;
  if (parsed.kind === 'percent') {
    const percent = parsed.percent.toFixed();
    return (LINE_VAT_PERCENTS as readonly string[]).includes(percent) ? `${percent}%` : null;
  }
  if (parsed.kind === 'other') return parsed.percent ? `KHAC:${parsed.percent.toFixed()}%` : null;
  return null;
}

export function ratePercent(rate: string): Decimal {
  const parsed = parseVatRate(rate);
  return parsed.kind === 'exempt' || parsed.kind === 'unknown' ? money(0) : (parsed.percent ?? money(0));
}

export interface LineTotalsInput {
  quantity: string;
  unitPrice: string;
  // Percent off the line, 0 to 100; omitted means none.
  discountPercent?: string | undefined;
  vatRate: string;
}

export interface LineTotals {
  vatRate: string;
  amount: string;
  vatAmount: string;
}

// A line that cannot be computed (a quantity or price that is not a decimal) comes out as zero and is left to the caller's checks.
export function computeLineTotals(line: LineTotalsInput): LineTotals {
  const rate = normalizeVatRate(line.vatRate) ?? line.vatRate;
  let amount = money(0);
  try {
    const gross = money(line.quantity).times(money(line.unitPrice));
    const discount = money(line.discountPercent ?? '0');
    amount = gross.times(money(100).minus(discount)).dividedBy(100).toDecimalPlaces(0);
  } catch {
    // Reported by the checks.
  }
  const vat = amount.times(ratePercent(rate)).dividedBy(100).toDecimalPlaces(0);
  return { vatRate: rate, amount: toMoney(amount), vatAmount: toMoney(vat) };
}

export interface DocumentTotals {
  subtotal: string;
  vatAmount: string;
  total: string;
}

// The document's totals from lines already computed (the sum of the rounded lines).
export function sumLineTotals(lines: readonly { amount: string; vatAmount: string }[]): DocumentTotals {
  const subtotal = lines.reduce((acc, l) => acc.plus(money(l.amount)), money(0));
  const vat = lines.reduce((acc, l) => acc.plus(money(l.vatAmount)), money(0));
  return { subtotal: toMoney(subtotal), vatAmount: toMoney(vat), total: toMoney(subtotal.plus(vat)) };
}
