// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631) as pure functions. The four cards read the lines the financial statements read (B01-DNN's 110 cash on 111 and 112,
// 131 receivables and 311 payables at the period's end; B02-DNN's 50 profit before tax for the period), so each card equals its statement line for the same
// entity and dates. The comparison is the period of the same length right before, and the balance cards the same balance at that period's last day.
// Money is decimal strings and decimal.js throughout.
import { money, type DecimalValue } from '@crove/l10n-vn';
import { OVERVIEW_EXPENSE_GROUPS, OVERVIEW_MONTHS, type FinanceOverview, type OverviewExpense, type OverviewFigure, type OverviewMonth, type OverviewRange } from '@crove/kernel-contract';
import { canonical } from './money.ts';
import { B01_LINES, B02_LINES, buildB01, buildB02, type Report, type ReportEntry } from './tt133-reports.ts';

export interface OverviewPeriods {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const format = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const addDays = (date: string, days: number): string => format(parse(date) + days * DAY_MS);
const daysBetween = (from: string, to: string): number => Math.round((parse(to) - parse(from)) / DAY_MS) + 1;
const lastDayOf = (year: number, month: number): string => format(Date.UTC(year, month, 0));

// The period a picker choice stands for on `today` (YYYY-MM-DD, Vietnam), both days included, and the period of the same length right before it. The last 30
// days end today; this month, this quarter and this year run from their first day to today; last month is the whole month before.
export function overviewPeriods(range: OverviewRange, today: string): OverviewPeriods {
  const [year, month] = today.split('-').map(Number) as [number, number];
  let from: string;
  let to = today;
  if (range === 'last_30_days') from = addDays(today, -29);
  else if (range === 'this_month') from = `${year}-${pad(month)}-01`;
  else if (range === 'last_month') {
    const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
    from = `${y}-${pad(m)}-01`;
    to = lastDayOf(y, m);
  } else if (range === 'this_quarter') from = `${year}-${pad(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
  else from = `${year}-01-01`;
  const length = daysBetween(from, to);
  const previousTo = addDays(from, -1);
  return { from, to, previousFrom: addDays(previousTo, -(length - 1)), previousTo };
}

// The months the results chart shows: the OVERVIEW_MONTHS ending with the month of `to`, oldest first, each with its first and last day.
export function overviewMonths(to: string): Array<{ month: string; from: string; to: string }> {
  const [year, month] = to.split('-').map(Number) as [number, number];
  const out: Array<{ month: string; from: string; to: string }> = [];
  for (let back = OVERVIEW_MONTHS - 1; back >= 0; back--) {
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    out.push({ month: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01`, to: lastDayOf(y, m) });
  }
  return out;
}

// A figure against the one before: the difference and, when the earlier figure is not 0, the difference in percent of its size, to one decimal.
export function overviewFigure(current: string, previous: string): OverviewFigure {
  const now = money(current);
  const before = money(previous);
  const change = now.minus(before);
  return {
    amount: canonical(now),
    previous: canonical(before),
    change: canonical(change),
    changePercent: before.isZero() ? null : change.dividedBy(before.abs()).times(100).toFixed(1),
  };
}

const line = (report: Report, code: string): DecimalValue => money(report.lines.find((l) => l.code === code)?.amount ?? '0');

// The cost of one account group in a period: its debits less its credits, over the entries the period holds. A reversal counts the same net, so a cancelled
// cost lowers it.
function groupCost(entries: ReadonlyArray<ReportEntry>, prefix: string): DecimalValue {
  let net = money(0);
  for (const entry of entries) {
    for (const l of entry.lines) if (l.accountCode.startsWith(prefix)) net = net.plus(money(l.debit)).minus(money(l.credit));
  }
  return net;
}

// The costs of the five groups in the period and the period before; a group with neither is left out, the rest largest first. The percent is the group's
// share of the period's positive costs.
export function expenseMix(now: ReadonlyArray<ReportEntry>, before: ReadonlyArray<ReportEntry>): OverviewExpense[] {
  const rows = OVERVIEW_EXPENSE_GROUPS.map((group) => ({ group, amount: groupCost(now, group), previous: groupCost(before, group) })).filter((r) => !r.amount.isZero() || !r.previous.isZero());
  const total = rows.reduce((sum, r) => (r.amount.greaterThan(0) ? sum.plus(r.amount) : sum), money(0));
  return rows
    .map((r) => ({
      group: r.group,
      amount: canonical(r.amount),
      previous: canonical(r.previous),
      percent: total.isZero() || !r.amount.greaterThan(0) ? '0.0' : r.amount.dividedBy(total).times(100).toFixed(1),
    }))
    .sort((a, b) => money(b.amount).comparedTo(money(a.amount)));
}

// A month's results from its B02: revenue is net sales, financial income and other income; the profit is B02's profit before tax, and the costs what is left
// of the revenue after it.
export function overviewMonth(month: string, report: Report): OverviewMonth {
  const revenue = line(report, '10').plus(line(report, '21')).plus(line(report, '31'));
  const profit = line(report, '50');
  return { month, revenue: canonical(revenue), costs: canonical(revenue.minus(profit)), profit: canonical(profit) };
}

export interface OverviewSource {
  range: OverviewRange;
  periods: OverviewPeriods;
  legalEntityId: string;
  // The entity's entries on cash, receivable and payable accounts up to the period's last day, and up to the earlier period's: B01 reads them.
  balancesNow: ReportEntry[];
  balancesBefore: ReportEntry[];
  // The entries of the revenue, income and expense accounts of the period and of the one before (B02 reads them; closing entries are left out by the caller).
  resultsNow: ReportEntry[];
  resultsBefore: ReportEntry[];
  // The same for each month of overviewMonths(periods.to).
  monthly: Array<{ month: string; from: string; to: string; entries: ReportEntry[] }>;
  empty: boolean;
}

// Only the lines the overview reads: if the statement mapping changes a code, this fails loudly rather than reading 0.
const NEEDED_B01 = ['110', '131', '311'];
const NEEDED_B02 = ['10', '21', '31', '50'];

export function buildOverview(source: OverviewSource): FinanceOverview {
  const { periods, legalEntityId } = source;
  for (const code of NEEDED_B01) if (!B01_LINES.some((d) => d.code === code)) throw new Error(`B01 has no line ${code}`);
  for (const code of NEEDED_B02) if (!B02_LINES.some((d) => d.code === code)) throw new Error(`B02 has no line ${code}`);
  const b01Now = buildB01(source.balancesNow, legalEntityId, periods.to);
  const b01Before = buildB01(source.balancesBefore, legalEntityId, periods.previousTo);
  const b02Now = buildB02(source.resultsNow, legalEntityId, periods.from, periods.to);
  const b02Before = buildB02(source.resultsBefore, legalEntityId, periods.previousFrom, periods.previousTo);
  const inPeriod = (entries: ReportEntry[], from: string, to: string) => entries.filter((e) => e.entryDate >= from && e.entryDate <= to);
  return {
    range: source.range,
    ...periods,
    empty: source.empty,
    cash: overviewFigure(line(b01Now, '110').toFixed(), line(b01Before, '110').toFixed()),
    profit: overviewFigure(line(b02Now, '50').toFixed(), line(b02Before, '50').toFixed()),
    receivables: overviewFigure(line(b01Now, '131').toFixed(), line(b01Before, '131').toFixed()),
    payables: overviewFigure(line(b01Now, '311').toFixed(), line(b01Before, '311').toFixed()),
    months: source.monthly.map((m) => overviewMonth(m.month, buildB02(inPeriod(m.entries, m.from, m.to), legalEntityId, m.from, m.to))),
    expenses: expenseMix(inPeriod(source.resultsNow, periods.from, periods.to), inPeriod(source.resultsBefore, periods.previousFrom, periods.previousTo)),
    unmapped: b02Now.unmapped.length,
  };
}
