// SPDX-License-Identifier: AGPL-3.0-only
// Gaps in the org's own sales e-invoice number series (#2140): the runs of missing numbers per template, series and
// year (domain/number-gaps.ts). The query that feeds it is covered on PostgreSQL in apps/kernel/test/finance-sales.db.test.ts.
import { describe, expect, it } from 'vitest';
import { GAP_RANGES_PER_GROUP, salesNumberGaps, type SalesNumberInvoice } from '../src/index.ts';

const sale = (series: string, number: string | number, issueDate: string): SalesNumberInvoice => ({ series, number: String(number), issueDate });

describe('salesNumberGaps', () => {
  it('lists number 3 when invoices 1, 2 and 4 of one series are recorded', () => {
    const result = salesNumberGaps([sale('C26TAA', 1, '2026-01-05'), sale('C26TAA', 2, '2026-01-06'), sale('C26TAA', 4, '2026-01-09')]);
    expect(result.missingCount).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ series: 'C26TAA', year: 2026, firstNumber: '1', lastNumber: '4', recorded: 3, missingCount: 1 });
    expect(result.groups[0]?.ranges).toEqual([{ from: '3', to: '3', count: 1, afterDate: '2026-01-06', beforeDate: '2026-01-09' }]);
  });

  it('shows nothing for a series with no gap', () => {
    expect(salesNumberGaps([sale('C26TAA', 1, '2026-01-05'), sale('C26TAA', 2, '2026-01-06'), sale('C26TAA', 3, '2026-02-01')])).toEqual({ groups: [], missingCount: 0 });
    expect(salesNumberGaps([sale('C26TAA', 7, '2026-01-05')])).toEqual({ groups: [], missingCount: 0 });
    expect(salesNumberGaps([])).toEqual({ groups: [], missingCount: 0 });
  });

  it('does not count numbers below the lowest or above the highest recorded', () => {
    // A series that began at 5 this year, or one recorded only up to 6, has no hole before or after.
    expect(salesNumberGaps([sale('C26TAA', 5, '2026-01-05'), sale('C26TAA', 6, '2026-01-06')]).groups).toEqual([]);
  });

  it('merges adjacent missing numbers into runs', () => {
    const result = salesNumberGaps([sale('C26TAA', 1, '2026-01-02'), sale('C26TAA', 5, '2026-01-10'), sale('C26TAA', 7, '2026-01-12'), sale('C26TAA', 12, '2026-01-20')]);
    expect(result.missingCount).toBe(3 + 1 + 4);
    expect(result.groups[0]?.ranges.map((r) => [r.from, r.to, r.count])).toEqual([
      ['2', '4', 3],
      ['6', '6', 1],
      ['8', '11', 4],
    ]);
  });

  it('starts over each January: the numbers of two years are checked apart', () => {
    // 2025 ran 1..3 with no gap; 2026 begins at 1 again. Neither year sees the other's numbers, and 2026's 1 and 3 leave 2.
    const result = salesNumberGaps([
      sale('C25TAA', 1, '2025-11-01'),
      sale('C25TAA', 2, '2025-12-15'),
      sale('C25TAA', 3, '2025-12-31'),
      sale('C26TAA', 1, '2026-01-02'),
      sale('C26TAA', 3, '2026-01-20'),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ series: 'C26TAA', year: 2026, missingCount: 1 });
    // The same series symbol kept across the new year: January's number 1 is not 'after' December's 3.
    const same = salesNumberGaps([sale('C26TAA', 1, '2025-12-20'), sale('C26TAA', 2, '2025-12-21'), sale('C26TAA', 1, '2026-01-02'), sale('C26TAA', 2, '2026-01-03')]);
    expect(same.groups).toEqual([]);
    // A series of one year with 1..3 and 6 shows the gap in that year only.
    const gap = salesNumberGaps([sale('C26TAA', 1, '2025-12-20'), sale('C26TAA', 2, '2025-12-21'), sale('C26TAA', 3, '2026-01-02'), sale('C26TAA', 6, '2026-01-03')]);
    expect(gap.groups.map((g) => [g.year, g.missingCount])).toEqual([[2026, 2]]);
  });

  it('checks two series side by side', () => {
    const result = salesNumberGaps([
      sale('C26TAA', 1, '2026-03-01'),
      sale('C26TAA', 2, '2026-03-02'),
      sale('C26TAA', 3, '2026-03-03'),
      sale('C26TAB', 1, '2026-03-01'),
      sale('C26TAB', 3, '2026-03-02'),
      sale('C26TAB', 4, '2026-03-04'),
    ]);
    expect(result.groups.map((g) => [g.series, g.ranges.map((r) => r.from)])).toEqual([['C26TAB', ['2']]]);
    // One series' number 2 does not fill the other's gap.
    const other = salesNumberGaps([sale('C26TAA', 2, '2026-03-02'), sale('C26TAA', 4, '2026-03-04'), sale('C26TAB', 3, '2026-03-03'), sale('C26TAB', 1, '2026-03-01')]);
    expect(other.groups.map((g) => [g.series, g.ranges[0]?.from])).toEqual([
      ['C26TAA', '3'],
      ['C26TAB', '2'],
    ]);
  });

  it('reads the template written in front of the series and joins both spellings of one series', () => {
    const result = salesNumberGaps([sale('1C26TAA', 1, '2026-04-01'), sale('C26TAA', 2, '2026-04-02'), sale('1C26TAA', 4, '2026-04-03')]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ template: '1', series: 'C26TAA', recorded: 3, missingCount: 1 });
  });

  it('keeps two templates of one series apart, and lets a document without a template fill a hole but not stretch a range', () => {
    const result = salesNumberGaps([
      sale('1C26TAA', 1, '2026-04-01'),
      sale('1C26TAA', 4, '2026-04-04'),
      sale('2C26TAA', 1, '2026-04-01'),
      sale('2C26TAA', 2, '2026-04-02'),
      // No template: counts as recorded in both, so number 2 and 3 of template 1 are covered only by what is there.
      sale('C26TAA', 3, '2026-04-03'),
      sale('C26TAA', 9, '2026-04-09'),
    ]);
    expect(result.groups.map((g) => [g.template, g.ranges.map((r) => `${r.from}-${r.to}`)])).toEqual([['1', ['2-2']]]);
  });

  it('keeps leading zeros the way the invoices write them, and leaves out numbers that are not digits', () => {
    const result = salesNumberGaps([sale('C26TAA', '00000001', '2026-05-01'), sale('C26TAA', '00000004', '2026-05-02'), sale('C26TAA', 'A9', '2026-05-03'), sale('C26TAA', '0', '2026-05-03')]);
    expect(result.groups[0]?.ranges.map((r) => [r.from, r.to])).toEqual([['00000002', '00000003']]);
    expect(result.groups[0]?.firstNumber).toBe('00000001');
  });

  it('counts a number recorded twice once', () => {
    const result = salesNumberGaps([sale('C26TAA', 1, '2026-05-01'), sale('C26TAA', 1, '2026-05-03'), sale('C26TAA', 3, '2026-05-04')]);
    expect(result.groups[0]).toMatchObject({ recorded: 2, missingCount: 1 });
    expect(result.groups[0]?.ranges[0]?.afterDate).toBe('2026-05-01');
  });

  it('shows in a period the runs that may fall in it, and drops the others', () => {
    const invoices = [
      sale('C26TAA', 1, '2026-01-10'),
      sale('C26TAA', 3, '2026-01-20'), // 2 is missing, between 10 and 20 January
      sale('C26TAA', 4, '2026-02-10'),
      sale('C26TAA', 7, '2026-04-10'), // 5 and 6 are missing, between 10 February and 10 April
    ];
    const january = salesNumberGaps(invoices, { period: { from: '2026-01-01', to: '2026-01-31' } });
    expect(january.groups[0]?.ranges.map((r) => r.from)).toEqual(['2']);
    expect(january.missingCount).toBe(1);
    const march = salesNumberGaps(invoices, { period: { from: '2026-03-01', to: '2026-03-31' } });
    expect(march.groups[0]?.ranges.map((r) => [r.from, r.to])).toEqual([['5', '6']]);
    expect(march.missingCount).toBe(2);
    const may = salesNumberGaps(invoices, { period: { from: '2026-05-01', to: '2026-05-31' } });
    expect(may).toEqual({ groups: [], missingCount: 0 });
    // The first quarter holds both.
    expect(salesNumberGaps(invoices, { period: { from: '2026-01-01', to: '2026-03-31' } }).missingCount).toBe(3);
  });

  it('reads only the years from fromYear on', () => {
    const invoices = [sale('C25TAA', 1, '2025-02-01'), sale('C25TAA', 3, '2025-02-02'), sale('C26TAA', 1, '2026-02-01'), sale('C26TAA', 3, '2026-02-02')];
    expect(salesNumberGaps(invoices).groups.map((g) => g.year)).toEqual([2025, 2026]);
    expect(salesNumberGaps(invoices, { fromYear: 2026 }).groups.map((g) => g.year)).toEqual([2026]);
  });

  it('lists every missing number as a run, so a huge hole costs one range, and cuts the runs of a series past the limit', () => {
    const huge = salesNumberGaps([sale('C26TAA', 1, '2026-01-01'), sale('C26TAA', 90_000_000, '2026-01-02')]);
    expect(huge.groups[0]?.ranges).toHaveLength(1);
    expect(huge.groups[0]?.missingCount).toBe(89_999_998);
    const many = Array.from({ length: GAP_RANGES_PER_GROUP + 20 }, (_, i) => sale('C26TAA', 1 + i * 2, '2026-01-01'));
    const cut = salesNumberGaps(many);
    expect(cut.groups[0]?.ranges).toHaveLength(GAP_RANGES_PER_GROUP);
    expect(cut.groups[0]?.truncated).toBe(true);
    expect(cut.groups[0]?.missingCount).toBe(GAP_RANGES_PER_GROUP + 19);
  });
});
