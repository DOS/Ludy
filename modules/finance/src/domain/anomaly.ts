// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly flags on a purchase invoice before a person approves it (#2380): the vendor's bank account is not one it used
// before, the amount is far from what this vendor usually bills, or a unit price jumped against its earlier invoices for
// the same item. Pure and deterministic, each rule with a simple threshold anyone can explain; a flag is a warning check
// (never blocking) whose sentence says why, and it never decides anything: the person looking at the proposal does.
//
// What each rule compares with is the vendor's own history, read by finance.extraction.lookup from the books: the totals
// of its last invoices, the unit prices of their lines, and the bank accounts its earlier proposals carried. A vendor
// with too little history raises nothing: the first account, the first few invoices and the first price are never odd.
import { Decimal, descriptionRuleText, type DecimalValue, type InvoiceCheck } from '@crove/l10n-vn';

// What the books remember of a vendor.
export interface VendorHistory {
  // The VND totals of the vendor's last invoices in force, newest first.
  totals: readonly string[];
  // The unit prices of their lines, newest invoice first (VND, as booked).
  prices: ReadonlyArray<{ description: string; unitPrice: string }>;
  // The bank accounts its earlier invoices named, newest first, as the invoice wrote them.
  bankAccounts: readonly string[];
}

// The rules' thresholds: at least this many earlier invoices before an amount is judged, how many times the usual amount
// (the median) counts as unusual, and the share a unit price may rise before it is flagged.
export const AMOUNT_MIN_HISTORY = 5;
export const AMOUNT_FACTOR = 3;
export const PRICE_RISE_PERCENT = 25;
// The earlier prices of an item that make its usual price: the latest few.
export const PRICE_BASELINE_PRICES = 3;
// The longest item name a check carries.
const ITEM_MAX = 60;


// An account number as compared: letters and digits only, upper case, so spaces, dots and dashes do not make one account
// two.
export const normalizeBankAccount = (account: string): string => account.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

// An account number for a sentence: all but its last four characters hidden.
export function maskBankAccount(account: string): string {
  const plain = normalizeBankAccount(account);
  return plain.length <= 4 ? plain : `${'*'.repeat(Math.min(plain.length - 4, 8))}${plain.slice(-4)}`;
}

function median(values: readonly DecimalValue[]): DecimalValue {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as DecimalValue) : (sorted[mid - 1] as DecimalValue).plus(sorted[mid] as DecimalValue).dividedBy(2);
}

const positive = (value: string): DecimalValue | null => {
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.greaterThan(0) ? d : null;
  } catch {
    return null;
  }
};

// The invoice names a bank account the vendor's earlier invoices did not: the classic payment fraud. Nothing without an
// account on this invoice or without earlier ones to compare with.
export function bankAccountCheck(account: string | null | undefined, earlier: readonly string[]): InvoiceCheck | null {
  const now = account ? normalizeBankAccount(account) : '';
  const before = earlier.map(normalizeBankAccount).filter((a) => a.length > 0);
  if (now === '' || before.length === 0 || before.includes(now)) return null;
  const last = before[0] as string;
  return {
    id: 'anomaly_bank',
    status: 'warn',
    code: 'anomaly_bank.changed',
    message: `Ly cảnh báo: tài khoản nhận tiền khác lần trước (lần trước ${maskBankAccount(last)}, lần này ${maskBankAccount(now)}); hãy xác nhận với nhà cung cấp trước khi thanh toán`,
    params: { previous: maskBankAccount(last), current: maskBankAccount(now) },
  };
}

// The invoice's total is at least AMOUNT_FACTOR times, or at most a third of, the median of the vendor's last invoices; judged
// only with AMOUNT_MIN_HISTORY of them. Both are in VND as booked.
export function amountCheck(total: string, earlier: readonly string[]): InvoiceCheck | null {
  const now = positive(total);
  const history = earlier.map(positive).filter((d): d is DecimalValue => d !== null);
  if (now === null || history.length < AMOUNT_MIN_HISTORY) return null;
  const usual = median(history);
  const high = now.greaterThanOrEqualTo(usual.times(AMOUNT_FACTOR));
  const low = now.lessThanOrEqualTo(usual.dividedBy(AMOUNT_FACTOR));
  if (!high && !low) return null;
  // How far from the usual: how many times it, and the share of it, as the sentence says them.
  const ratio = now.dividedBy(usual).toFixed(1);
  const percent = now.dividedBy(usual).times(100).toFixed(0);
  return {
    id: 'anomaly_amount',
    status: 'warn',
    code: 'anomaly_amount.unusual',
    message: high
      ? `Ly cảnh báo: số tiền ${now.toFixed(0)} đ cao gấp ${ratio} lần mức thường của nhà cung cấp này (${usual.toFixed(0)} đ, trung vị của ${history.length} hóa đơn gần nhất; cảnh báo từ ${AMOUNT_FACTOR} lần)`
      : `Ly cảnh báo: số tiền ${now.toFixed(0)} đ chỉ bằng ${percent}% mức thường của nhà cung cấp này (${usual.toFixed(0)} đ, trung vị của ${history.length} hóa đơn gần nhất; cảnh báo khi dưới một phần ${AMOUNT_FACTOR})`,
    params: { total: now.toFixed(0), usual: usual.toFixed(0), count: String(history.length), direction: high ? 'high' : 'low', ratio, percent },
  };
}

// A line's unit price is at least PRICE_RISE_PERCENT above the median of the last PRICE_BASELINE_PRICES earlier prices of
// the same item (the description with its numbers dropped, the key the learned rules use). The largest rise is named; a
// price that fell is no flag.
export function priceCheck(lines: ReadonlyArray<{ description: string; unitPrice: string | null }>, earlier: ReadonlyArray<{ description: string; unitPrice: string }>): InvoiceCheck | null {
  const byItem = new Map<string, DecimalValue[]>();
  for (const e of earlier) {
    const key = descriptionRuleText(e.description);
    const price = positive(e.unitPrice);
    if (key === null || price === null) continue;
    const list = byItem.get(key) ?? [];
    if (list.length < PRICE_BASELINE_PRICES) list.push(price);
    byItem.set(key, list);
  }
  let worst: { item: string; usual: DecimalValue; now: DecimalValue; percent: DecimalValue } | null = null;
  for (const line of lines) {
    const key = descriptionRuleText(line.description);
    const now = line.unitPrice === null ? null : positive(line.unitPrice);
    const before = key === null ? undefined : byItem.get(key);
    if (key === null || now === null || before === undefined || before.length === 0) continue;
    const usual = median(before);
    const percent = now.minus(usual).dividedBy(usual).times(100);
    if (percent.lessThan(PRICE_RISE_PERCENT)) continue;
    if (worst === null || percent.greaterThan(worst.percent)) worst = { item: line.description.trim().replace(/\s+/g, ' ').slice(0, ITEM_MAX), usual, now, percent };
  }
  if (worst === null) return null;
  const percent = worst.percent.toFixed(0);
  return {
    id: 'anomaly_price',
    status: 'warn',
    code: 'anomaly_price.jump',
    message: `Ly cảnh báo: đơn giá "${worst.item}" tăng ${percent}% so với mức thường (${worst.usual.toFixed(0)} đ, trung vị tối đa ${PRICE_BASELINE_PRICES} hóa đơn trước) lên ${worst.now.toFixed(0)} đ; cảnh báo từ ${PRICE_RISE_PERCENT}%`,
    params: { item: worst.item, usual: worst.usual.toFixed(0), current: worst.now.toFixed(0), percent },
  };
}

// The flags of a purchase invoice, in a fixed order. `history` is null for a vendor the books do not know yet.
export function anomalyChecks(
  invoice: { sellerBankAccount: string | null | undefined; total: string; lines: ReadonlyArray<{ description: string; unitPrice: string | null }> },
  history: VendorHistory | null,
): InvoiceCheck[] {
  if (history === null) return [];
  return [bankAccountCheck(invoice.sellerBankAccount, history.bankAccounts), amountCheck(invoice.total, history.totals), priceCheck(invoice.lines, history.prices)].filter(
    (c): c is InvoiceCheck => c !== null,
  );
}
