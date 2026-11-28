// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of the annual PIT finalization 02/CNKD-TNCN-QTT of a household on the income method (#5285), pure and in decimal.js, never JS numbers. The form is the layout of Circular 89/2026/TT-BTC
// Phụ lục I (Circular 89 Art. 99(5): the same code as Circular 18/2026, in a new layout, in force 2026-07-01), part A "Kê khai thông tin tính thuế", lines [09] to [20]; the formulas are the form's own:
//   [09] = [09a] + [09b] + [09c]            [10] = [10a] + [10b] + [10c] + [10d] + [10đ] + [10e]       [11] = [09] - [10]         [13] = [11] x [12]
//   [17] = [13] - [14] - [15] - [16] if >= 0                      [18] = [17] if [17] <= 50.000            [19] = [17] - [18]
//   [20] = [13] - [14] - [15] - [16] if < 0 (tax overpaid)
// The printed form repeats `[10d]` for the bought-in services (2.4) and for the loan interest (2.5); here the interest is `10đ` (the e-filing schema is checked before any XML is made). Lines [21] to [24]
// (the refund and the offset) and parts B to D are the person's at filing and are not worked out. The rate [12] is a row of the law (household_income_rate, by the band of the year's revenue), never a
// constant here. The 30% PIT cut of Decree 398/2026 (NQ 43/2026/QH16) has no line on this form, so [13] to [20] are BEFORE it and `reductionMemo` gives both sides.
// Every figure the form cannot give a safe answer for is held (`holds`), never guessed: the household's revenue at or under the tax-free threshold (no PIT, no return), a loss (no clause says how
// a loss is treated), a cost on an account no expense group covers, a platform revenue larger than the revenue, a year closed to 911 (the closing nets the year to nothing), a missing rate row.
import { HOUSEHOLD_EXPENSE_GROUPS } from '@ludy/kernel-contract';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { taxOn } from './household-tax.ts';

type Group = (typeof HOUSEHOLD_EXPENSE_GROUPS)[number];

// [18]: a household whose tax payable for the year is 50,000 VND or less is exempt (Circular 89/2026 Art. 65(1)(a)(5)).
export const QTT_EXEMPT_UP_TO = '50000';

export const QTT_HOLDS = ['below_threshold', 'loss', 'unmapped_costs', 'platform_split', 'rate_missing', 'closing_entries'] as const;
export type QttHold = (typeof QTT_HOLDS)[number];

// The line of the form each expense group of S2c is.
export const QTT_COST_LINES: Readonly<Record<Group, string>> = {
  materials_goods: '10a',
  wages_insurance: '10b',
  depreciation: '10c',
  outside_services: '10d',
  interest: '10đ',
  other: '10e',
};

// The labels as the form prints them (Circular 89/2026 Phụ lục I), shortened only where the form's own text is a long list.
export const QTT_LABELS: Readonly<Record<string, string>> = {
  '09': 'Doanh thu bán hàng hoá và cung cấp dịch vụ',
  '09a': 'Doanh thu từ hoạt động sản xuất kinh doanh không bao gồm các hoạt động kinh doanh trên nền tảng thương mại điện tử, nền tảng số',
  '09b': 'Doanh thu từ hoạt động kinh doanh trên nền tảng thương mại điện tử, nền tảng số đã được khấu trừ, nộp thay',
  '09c': 'Doanh thu từ hoạt động kinh doanh trên nền tảng thương mại điện tử, nền tảng số không có chức năng thanh toán trực tiếp',
  '10': 'Các khoản chi được trừ',
  '10a': 'Chi phí nguyên liệu, vật liệu, nhiên liệu, năng lượng, hàng hóa sử dụng vào sản xuất, kinh doanh',
  '10b': 'Chi phí tiền lương, tiền công, các khoản phụ cấp, bảo hiểm bắt buộc và các khoản chi trả cho người lao động',
  '10c': 'Chi phí khấu hao tài sản cố định phục vụ cho hoạt động sản xuất, kinh doanh',
  '10d': 'Chi phí dịch vụ mua ngoài như điện, nước, điện thoại, internet, vận chuyển, thuê tài sản, sửa chữa, bảo dưỡng',
  '10đ': 'Chi phí trả lãi tiền vay vốn sản xuất, kinh doanh',
  '10e': 'Các khoản chi khác phục vụ trực tiếp hoạt động sản xuất, kinh doanh',
  '11': 'Thu nhập tính thuế',
  '12': 'Thuế suất',
  '13': 'Số thuế TNCN phát sinh trong kỳ',
  '14': 'Số thuế TNCN đã khấu trừ',
  '15': 'Số thuế TNCN đã tạm nộp trong năm',
  '16': 'Số thuế TNCN được giảm do thiên tai, dịch bệnh, hỏa hoạn, tai nạn và bệnh hiểm nghèo theo Quyết định giảm thuế của cơ quan thuế',
  '17': 'Tổng số thuế TNCN còn phải nộp',
  '18': 'Số thuế TNCN được miễn từ 50.000 đồng trở xuống',
  '19': 'Số thuế TNCN còn phải nộp sau miễn số thuế từ 50.000 đồng trở xuống',
  '20': 'Tổng số thuế TNCN nộp thừa',
};

// The order the form prints them in.
export const QTT_CODES = ['09', '09a', '09b', '09c', '10', '10a', '10b', '10c', '10d', '10đ', '10e', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'] as const;

export interface QttBand {
  revenueOver: string;
  percent: string;
}

// The band of a year's revenue: the row with the highest `revenueOver` below the revenue (a band applies when the revenue is ABOVE its bound, so exactly 3 billion VND is still the 15% band). The rows are the
// ones in force on the year's last day; null when none is below the revenue.
export function bandFor<T extends QttBand>(revenue: string, rows: readonly T[]): T | null {
  const total = money(revenue);
  let best: T | null = null;
  for (const row of rows) {
    if (!total.gt(money(row.revenueOver))) continue;
    if (best === null || money(row.revenueOver).gt(money(best.revenueOver))) best = row;
  }
  return best;
}

export interface QttSettled {
  // [13] the tax of the year, [17] to pay, [18] exempt (50,000 VND or less), [19] to pay after the exemption, [20] overpaid.
  tax: string;
  payable: string;
  exempt: string;
  due: string;
  overpaid: string;
}

// [17] to [20] from the tax of the year and what has been withheld, prepaid and relieved: the form's own formulas. The exemption [18] is the whole [17] when it is 50,000 or less (and above zero).
export function settle(tax: string, withheld: string, prepaid: string, relieved = '0'): QttSettled {
  const left = money(tax).minus(money(withheld)).minus(money(prepaid)).minus(money(relieved));
  const payable = left.gt(0) ? left : money(0);
  const exempt = payable.gt(0) && payable.lte(money(QTT_EXEMPT_UP_TO)) ? payable : money(0);
  return {
    tax: toMoney(money(tax)),
    payable: toMoney(payable),
    exempt: toMoney(exempt),
    due: toMoney(payable.minus(exempt)),
    overpaid: toMoney(left.lt(0) ? left.negated() : money(0)),
  };
}

export interface QttInput {
  // [09]: the ledger's movement of account 511 over the year.
  revenue: string;
  // [09b]: platform revenue the platforms withheld tax on and paid over (settlements of the year); [09c]: entered by the household.
  platformRevenue: string;
  noPaymentRevenue: string;
  // The deductible costs by group of S2c, and the absolute amount of the cost lines no group covers.
  costs: Readonly<Record<Group, string>>;
  unmappedGross: string;
  // The yearly revenue up to which no PIT is due (household_threshold no_tax_revenue); '0' when no row is in force.
  threshold: string;
  // The band of the income-method rate for the revenue; null when no row covers it.
  band: QttBand | null;
  // Entered by the household: [14] and [15].
  withheld: string;
  prepaid: string;
  // A line on the closing account 911 exists in the year.
  closed: boolean;
}

export interface QttResult {
  lines: Array<{ code: string; label: string; amount: string | null }>;
  holds: QttHold[];
  // The tax of the year [13], or null when it could not be worked out.
  tax: string | null;
  // [17] to [20] when [13] was worked out.
  settled: QttSettled | null;
}

export function computeQtt(input: QttInput): QttResult {
  const holds: QttHold[] = [];
  const amounts = new Map<string, string | null>();
  const revenue = money(input.revenue);
  amounts.set('09', toMoney(revenue));
  amounts.set('09b', toMoney(money(input.platformRevenue)));
  amounts.set('09c', toMoney(money(input.noPaymentRevenue)));
  const platform = money(input.platformRevenue).plus(money(input.noPaymentRevenue));
  // The platform parts cannot be more than the whole: a platform revenue the ledger does not hold (a settlement not yet booked) is the accountant's.
  if (platform.gt(revenue.gt(0) ? revenue : money(0))) {
    holds.push('platform_split');
    amounts.set('09a', null);
  } else {
    amounts.set('09a', toMoney(revenue.minus(platform)));
  }

  for (const group of HOUSEHOLD_EXPENSE_GROUPS) amounts.set(QTT_COST_LINES[group], toMoney(money(input.costs[group])));
  const costs = sum(HOUSEHOLD_EXPENSE_GROUPS.map((group) => input.costs[group]));
  amounts.set('10', toMoney(costs));
  for (const code of ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20']) amounts.set(code, null);

  let tax: string | null = null;
  let settled: QttSettled | null = null;
  if (input.closed) holds.push('closing_entries');
  if (!money(input.unmappedGross).isZero()) holds.push('unmapped_costs');
  if (!holds.includes('closing_entries') && !holds.includes('unmapped_costs')) {
    const income = revenue.minus(costs);
    amounts.set('11', toMoney(income));
    if (revenue.lte(money(input.threshold))) holds.push('below_threshold');
    else if (income.lte(0)) holds.push('loss');
    else if (input.band === null) holds.push('rate_missing');
    else {
      tax = taxOn(toMoney(income), input.band.percent);
      settled = settle(tax, input.withheld, input.prepaid);
      amounts.set('12', toMoney(money(input.band.percent)));
      amounts.set('13', tax);
      amounts.set('14', toMoney(money(input.withheld)));
      amounts.set('15', toMoney(money(input.prepaid)));
      amounts.set('16', '0');
      amounts.set('17', settled.payable);
      amounts.set('18', settled.exempt);
      amounts.set('19', settled.due);
      amounts.set('20', settled.overpaid);
    }
  }
  return { lines: QTT_CODES.map((code) => ({ code, label: QTT_LABELS[code] ?? code, amount: amounts.get(code) ?? null })), holds, tax, settled };
}

// What the 30% cut of Decree 398/2026 (NQ 43/2026/QH16) would do to the tax of the year: the cut is a percentage of the PIT payable and holds while the year's revenue is at most the ceiling. The form has no line
// for it (it is claimed on the Decree 398 form filed with the return), so the figures are given on both sides and the form's lines [13] to [20] stay BEFORE it.
export function reductionMemo(args: { tax: string; revenue: string; percent: string; ceiling: string | null; withheld: string; prepaid: string }): { applies: boolean; cut: string; before: QttSettled; after: QttSettled } {
  const applies = money(args.percent).gt(0) && (args.ceiling === null || money(args.revenue).lte(money(args.ceiling)));
  const cut = applies ? taxOn(args.tax, args.percent) : '0';
  const before = settle(args.tax, args.withheld, args.prepaid);
  const after = settle(toMoney(money(args.tax).minus(money(cut))), args.withheld, args.prepaid);
  return { applies, cut, before, after };
}
