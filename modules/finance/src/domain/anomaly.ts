// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly flags on a purchase invoice before a person approves it (#2380): the vendor's bank account is not one it used
// before, the amount is far from what this vendor usually bills, or a unit price jumped against its earlier invoices for
// the same item. Pure and deterministic, each rule with a simple threshold anyone can explain; a flag is a warning check
// (never blocking) whose sentence says why, and it never decides anything: the person looking at the proposal does.
//
// What each rule compares with is the vendor's own history, read by finance.extraction.lookup from the books: the totals
// of its last invoices, the unit prices of their lines, and the bank accounts its earlier proposals carried. A vendor
// with too little history raises nothing: the first account, the first few invoices and the first price are never odd.
import { bankAccountRuns, Decimal, descriptionRuleText, type DecimalValue, type InvoiceCheck } from '@ludy/l10n-vn';

// What the books remember of a vendor.
export interface VendorHistory {
  // The VND totals of the vendor's last non-correction invoices in force, newest first.
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
// How many earlier invoices or payments make a party's history: the last few.
export const HISTORY_WINDOW = 12;
// The longest item name a check carries.
const ITEM_MAX = 60;

// An account number as compared: letters and digits only, upper case, so spaces, dots and dashes do not make one account
// two.
export const normalizeBankAccount = (account: string): string => account.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

// An account number for a sentence: all but its last four characters hidden (of its longest digit run when it has one).
export function maskBankAccount(account: string): string {
  const longest = bankAccountRuns(account).reduce((best, run) => (run.length > best.length ? run : best), '');
  const plain = longest === '' ? normalizeBankAccount(account) : longest;
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
  const now = account ? bankAccountRuns(account) : [];
  const before = earlier.map(bankAccountRuns).filter((runs) => runs.length > 0);
  if (now.length === 0 || before.length === 0) return null;
  // Every account this invoice names must be one the vendor used before: a single new one is the change (an old account printed beside it does not hide it).
  const seen = new Set(before.flat());
  const fresh = now.find((run) => !seen.has(run));
  if (fresh === undefined) return null;
  const last = maskBankAccount((earlier.find((a) => bankAccountRuns(a).length > 0) as string));
  const current = maskBankAccount(fresh);
  return {
    id: 'anomaly_bank',
    status: 'warn',
    code: 'anomaly_bank.changed',
    message: `Cảnh báo: tài khoản nhận tiền khác lần trước (lần trước ${last}, lần này ${current}); hãy xác nhận với nhà cung cấp trước khi thanh toán`,
    params: { previous: last, current },
  };
}

// What an amount is the amount of: an invoice of a vendor, or a payment voucher to a party (#2419), which share the rule.
export type AmountSubject = 'invoice' | 'payment';

// The invoice's total is at least AMOUNT_FACTOR times, or at most a third of, the median of the vendor's last invoices; judged
// only with AMOUNT_MIN_HISTORY of them. Both are in VND as booked; a null total (a foreign-currency invoice still waiting for
// its rate) is judged by nothing, since its amount is not in dong.
export function amountCheck(total: string | null, earlier: readonly string[], subject: AmountSubject = 'invoice'): InvoiceCheck | null {
  const now = total === null ? null : positive(total);
  const history = earlier.map(positive).filter((d): d is DecimalValue => d !== null);
  if (now === null || history.length < AMOUNT_MIN_HISTORY) return null;
  const usual = median(history);
  const high = now.greaterThanOrEqualTo(usual.times(AMOUNT_FACTOR));
  const low = now.lessThanOrEqualTo(usual.dividedBy(AMOUNT_FACTOR));
  if (!high && !low) return null;
  // How far from the usual: how many times it, and the share of it, as the sentence says them.
  const ratio = now.dividedBy(usual).toFixed(1);
  const percent = now.dividedBy(usual).times(100).toFixed(0);
  const payment = subject === 'payment';
  return {
    id: 'anomaly_amount',
    status: 'warn',
    code: 'anomaly_amount.unusual',
    message: payment
      ? high
        ? `Cảnh báo: số tiền chi ${now.toFixed(0)} đ cao gấp ${ratio} lần mức thường chi cho đối tượng này (${usual.toFixed(0)} đ, trung vị của ${history.length} lần chi gần nhất; cảnh báo từ ${AMOUNT_FACTOR} lần)`
        : `Cảnh báo: số tiền chi ${now.toFixed(0)} đ chỉ bằng ${percent}% mức thường chi cho đối tượng này (${usual.toFixed(0)} đ, trung vị của ${history.length} lần chi gần nhất; cảnh báo khi dưới một phần ${AMOUNT_FACTOR})`
      : high
        ? `Cảnh báo: số tiền ${now.toFixed(0)} đ cao gấp ${ratio} lần mức thường của nhà cung cấp này (${usual.toFixed(0)} đ, trung vị của ${history.length} hóa đơn gần nhất; cảnh báo từ ${AMOUNT_FACTOR} lần)`
        : `Cảnh báo: số tiền ${now.toFixed(0)} đ chỉ bằng ${percent}% mức thường của nhà cung cấp này (${usual.toFixed(0)} đ, trung vị của ${history.length} hóa đơn gần nhất; cảnh báo khi dưới một phần ${AMOUNT_FACTOR})`,
    params: { total: now.toFixed(0), usual: usual.toFixed(0), count: String(history.length), direction: high ? 'high' : 'low', ratio, percent, ...(payment ? { subject: 'payment' } : {}) },
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
    message: `Cảnh báo: đơn giá "${worst.item}" tăng ${percent}% so với mức thường (${worst.usual.toFixed(0)} đ, trung vị tối đa ${PRICE_BASELINE_PRICES} hóa đơn trước) lên ${worst.now.toFixed(0)} đ; cảnh báo từ ${PRICE_RISE_PERCENT}%`,
    params: { item: worst.item, usual: worst.usual.toFixed(0), current: worst.now.toFixed(0), percent },
  };
}

// The flags of a purchase invoice, in a fixed order. `history` is null for a vendor the books do not know yet.
// An adjustment or replacement invoice (`related` set) carries a delta or reissued total against an earlier invoice, so
// the amount rule skips it while bank account and unit price checks still run (#2425).
export function anomalyChecks(
  invoice: {
    sellerBankAccount: string | null | undefined;
    total: string | null;
    lines: ReadonlyArray<{ description: string; unitPrice: string | null }>;
    related?: boolean | { kind: 'replacement' | 'adjustment' } | null | undefined;
  },
  history: VendorHistory | null,
): InvoiceCheck[] {
  if (history === null) return [];
  return [
    bankAccountCheck(invoice.sellerBankAccount, history.bankAccounts),
    invoice.related ? null : amountCheck(invoice.total, history.totals),
    priceCheck(invoice.lines, history.prices),
  ].filter((c): c is InvoiceCheck => c !== null);
}

// The net pay of a pay run paid in cash while some net pay is 5 million or more (#2532, docs/plan/payroll.md row 19: a payment of 5 million or more in one go must be non-cash for the pay to be
// deductible; commentary until the accountant confirms it, #2535). `count` is how many people's net pay reaches the limit, a number and never a name or a figure; none raises nothing. A warning that
// never blocks, in the same family as the flags above, so the proposal that carries it is approved one by one.
export function payrollCashCheck(count: number): InvoiceCheck | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  return {
    id: 'anomaly_cash',
    status: 'warn',
    code: 'anomaly_cash.payroll_limit',
    message: `Cảnh báo: ${count} người có lương thực lĩnh từ 5.000.000 đồng trở lên mà chi bằng tiền mặt; khoản chi từ 5 triệu đồng một lần cần thanh toán không dùng tiền mặt mới được tính chi phí được trừ. Hãy chuyển khoản hoặc hỏi kế toán`,
    params: { count: String(count) },
  };
}

// An ordinary payment voucher (finance.voucher.record) debits a payroll payable account while the same legal entity has a
// pending or recorded pay-run payment voucher for that liability (#2793). Only the voucher's own account codes are named
// (never a person, run id or payroll figure), and the check id starts with `anomaly` so the reviewer checks it one by one.
export function payrollLiabilityCheck(accounts: readonly string[]): InvoiceCheck | null {
  const unique = [...new Set(accounts.map((a) => a.trim()).filter((a) => a.length > 0))].sort();
  if (unique.length === 0) return null;
  const joined = unique.join(', ').slice(0, 180);
  return {
    id: 'anomaly_payroll',
    status: 'warn',
    code: 'anomaly_payroll.active_payment',
    message: `Cảnh báo: chứng từ chi thẳng vào tài khoản công nợ lương (${joined}) trong khi pháp nhân đang có chứng từ chi lương theo bảng lương chờ duyệt hoặc đã ghi sổ; hãy kiểm tra để tránh chi trùng nghĩa vụ của bảng lương`,
    params: { accounts: joined },
  };
}
