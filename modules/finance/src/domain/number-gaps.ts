// SPDX-License-Identifier: AGPL-3.0-only
// Gaps in the org's own sales e-invoice number series (issue #2140). An e-invoice number runs consecutively per
// template (mẫu số) and series (ký hiệu) and starts over each year (ADR-0021; Decree 123/2020/ND-CP, Article 4), so a
// number missing between the lowest and the highest recorded of one template, series and year is an invoice the org
// issued that is not in the books, or one that was cancelled. Pure functions; the query is in vat.ts.
//
// The year is the invoice date's. A recorded document keeps no template of its own: it shows only when the seller wrote
// it in front of the series ("1C26TAA", see invoiceSymbol in portal-reconcile.ts). Documents of one series and year are
// therefore one group, split by template only when two different templates are seen; a document with no template then
// counts as recorded in each of them but never stretches their range, so it can hide a gap, never invent one. A number
// that is not made of digits cannot be ordered and is left out.
import { normalizeNumber } from '@crove/l10n-vn';
import { invoiceSymbol } from './portal-reconcile.ts';

export interface SalesNumberInvoice {
  series: string;
  number: string;
  issueDate: string;
}

// A run of consecutive missing numbers. The dates are those of the recorded invoices on either side of it: the missing
// invoice was most likely issued between them, so the VAT working of a period shows the runs whose dates reach it.
export interface NumberGapRange {
  from: string;
  to: string;
  count: number;
  afterDate: string;
  beforeDate: string;
}

export interface NumberGapGroup {
  template: string | null;
  series: string;
  year: number;
  firstNumber: string;
  lastNumber: string;
  recorded: number;
  missingCount: number;
  ranges: NumberGapRange[];
  // More runs than GAP_RANGES_PER_GROUP: ranges holds the first ones, missingCount counts them all.
  truncated: boolean;
}

export interface SalesNumberGaps {
  groups: NumberGapGroup[];
  missingCount: number;
}

export interface GapFilter {
  // Only the runs that may fall in this date range (both ends inclusive).
  period?: { from: string; to: string };
  // Only series of this year on, for the Overview.
  fromYear?: number;
}

export const GAP_RANGES_PER_GROUP = 100;
// Longer than this cannot be a sequence number of an e-invoice (8 digits by Decree 123/2020), and stays an exact integer.
const MAX_DIGITS = 12;

interface Entry {
  template: string | null;
  value: number;
  padded: boolean;
  width: number;
  date: string;
}

const pad = (value: number, width: number, padded: boolean) => (padded ? String(value).padStart(width, '0') : String(value));

function parse(invoice: SalesNumberInvoice, template: string | null): Entry | null {
  const text = invoice.number.trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(text)) return null;
  const normalized = normalizeNumber(text);
  if (normalized.length > MAX_DIGITS) return null;
  const value = Number(normalized);
  // 0 is no invoice number: the first number is 1.
  if (value < 1) return null;
  return { template, value, padded: text.length > normalized.length, width: text.length, date: invoice.issueDate };
}

// The runs of integers inside (low, high) that are in none of `taken` (sorted, distinct).
function freeRuns(low: number, high: number, taken: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = low + 1;
  for (const n of taken) {
    if (n <= low || n >= high) continue;
    if (n > start) runs.push([start, n - 1]);
    start = n + 1;
  }
  if (start <= high - 1) runs.push([start, high - 1]);
  return runs;
}

function groupGaps(template: string | null, series: string, year: number, own: Entry[], untemplated: Entry[]): NumberGapGroup | null {
  const first = new Map<number, Entry>();
  for (const e of own) {
    const seen = first.get(e.value);
    if (!seen || e.date < seen.date) first.set(e.value, e);
  }
  const values = [...first.keys()].sort((a, b) => a - b);
  const lowest = values[0];
  const highest = values.at(-1);
  if (lowest === undefined || highest === undefined) return null;
  const extra = [...new Set(untemplated.map((e) => e.value))].sort((a, b) => a - b);
  const padded = own.some((e) => e.padded) || untemplated.some((e) => e.padded);
  const width = Math.max(...own.map((e) => e.width), ...untemplated.map((e) => e.width));
  const ranges: NumberGapRange[] = [];
  let missing = 0;
  for (let i = 1; i < values.length; i += 1) {
    const low = values[i - 1] as number;
    const high = values[i] as number;
    if (high - low < 2) continue;
    const lowDate = (first.get(low) as Entry).date;
    const highDate = (first.get(high) as Entry).date;
    for (const [from, to] of freeRuns(low, high, extra)) {
      missing += to - from + 1;
      ranges.push({ from: pad(from, width, padded), to: pad(to, width, padded), count: to - from + 1, afterDate: lowDate, beforeDate: highDate });
    }
  }
  if (ranges.length === 0) return null;
  return {
    template,
    series,
    year,
    firstNumber: pad(lowest, width, padded),
    lastNumber: pad(highest, width, padded),
    recorded: first.size,
    missingCount: missing,
    ranges,
    truncated: false,
  };
}

const overlaps = (range: NumberGapRange, period: { from: string; to: string }) => {
  const [early, late] = range.afterDate <= range.beforeDate ? [range.afterDate, range.beforeDate] : [range.beforeDate, range.afterDate];
  return early <= period.to && late >= period.from;
};

// The gaps of the recorded sales (not voided), per template, series and year, ordered by year, series and template.
// invoices must hold every recorded sale of the years the filter looks at: a gap is found between two recorded numbers.
export function salesNumberGaps(invoices: readonly SalesNumberInvoice[], filter: GapFilter = {}): SalesNumberGaps {
  const bySeriesYear = new Map<string, { series: string; year: number; entries: Entry[] }>();
  for (const invoice of invoices) {
    const year = Number(invoice.issueDate.slice(0, 4));
    if (!Number.isInteger(year) || (filter.fromYear !== undefined && year < filter.fromYear)) continue;
    const symbol = invoiceSymbol(null, invoice.series);
    const entry = parse(invoice, symbol.template);
    if (!entry) continue;
    const key = `${year}|${symbol.series}`;
    const group = bySeriesYear.get(key) ?? { series: symbol.series, year, entries: [] };
    group.entries.push(entry);
    bySeriesYear.set(key, group);
  }
  const groups: NumberGapGroup[] = [];
  for (const { series, year, entries } of bySeriesYear.values()) {
    const templates = [...new Set(entries.flatMap((e) => (e.template === null ? [] : [e.template])))].sort();
    if (templates.length <= 1) {
      const group = groupGaps(templates[0] ?? null, series, year, entries, []);
      if (group) groups.push(group);
      continue;
    }
    const untemplated = entries.filter((e) => e.template === null);
    for (const template of templates) {
      const group = groupGaps(template, series, year, entries.filter((e) => e.template === template), untemplated);
      if (group) groups.push(group);
    }
  }
  groups.sort((a, b) => a.year - b.year || a.series.localeCompare(b.series) || (a.template ?? '').localeCompare(b.template ?? ''));
  const shown: NumberGapGroup[] = [];
  let missingCount = 0;
  for (const group of groups) {
    const ranges = filter.period ? group.ranges.filter((r) => overlaps(r, filter.period as { from: string; to: string })) : group.ranges;
    if (ranges.length === 0) continue;
    const count = ranges.reduce((sum, r) => sum + r.count, 0);
    missingCount += count;
    shown.push({ ...group, missingCount: count, ranges: ranges.slice(0, GAP_RANGES_PER_GROUP), truncated: ranges.length > GAP_RANGES_PER_GROUP });
  }
  return { groups: shown, missingCount };
}
