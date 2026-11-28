// SPDX-License-Identifier: AGPL-3.0-only
// DRAFT TT99 B02-DN map and the regime a statement is read under (#5187), on synthetic entries worked out by hand. The map was checked against the official text (domain/tt99-reports.ts, #5269) but
// the accountant has not confirmed it, so these tests pin what the code does with it.
import { describe, expect, it } from 'vitest';
import { B02_LINES, B02_LINES_TT99, B02_ROLES, b02LinesFor, buildB02, type ReportEntry } from '../src/index.ts';
import { statementsBooksOf } from '../src/statements-regime.ts';

const LE = 'le-tt99';
type Leg = [account: string, debit: number, credit: number];

function entry(date: string, legs: Leg[], reversal = false): ReportEntry {
  return {
    legalEntityId: LE,
    entryDate: date,
    currency: 'VND',
    reversal,
    lines: legs.map(([accountCode, debit, credit]) => ({ accountCode, partyId: null, debit: String(debit), credit: String(credit) })),
  };
}

const amounts = (lines: readonly { code: string; amount: string }[]) => Object.fromEntries(lines.map((l) => [l.code, l.amount]));

// A TT99 year: sales 500M on 511 with a 20M discount on 521 and a 10M return booked straight on 511, cost of goods 200M on 632, financial income 3M on 515, financial expense 5M on 635 (1M of it
// borrowing cost on 6351), selling 40M on 641, administration 60M on 642, other income 2M on 711, other expense 1M on 811, current tax 12M on 8211 and deferred tax 2M on 8212.
// 10 = 500 - 20 - 10 = 470M. 20 = 470 - 200 = 270M. 30 = 270 + 0 + 3 - 5 - 40 - 60 = 168M. 40 = 2 - 1 = 1M. 50 = 169M. 51 = 12M, 52 = 2M, 60 = 169 - 12 - 2 = 155M.
const YEAR: ReportEntry[] = [
  entry('2026-02-10', [['131', 500_000_000, 0], ['511', 0, 500_000_000]]),
  entry('2026-02-20', [['521', 20_000_000, 0], ['131', 0, 20_000_000]]),
  entry('2026-03-05', [['511', 10_000_000, 0], ['131', 0, 10_000_000]]),
  entry('2026-04-01', [['632', 200_000_000, 0], ['156', 0, 200_000_000]]),
  entry('2026-05-01', [['112', 3_000_000, 0], ['515', 0, 3_000_000]]),
  entry('2026-05-02', [['635', 4_000_000, 0], ['6351', 1_000_000, 0], ['112', 0, 5_000_000]]),
  entry('2026-06-01', [['641', 40_000_000, 0], ['112', 0, 40_000_000]]),
  entry('2026-06-02', [['642', 60_000_000, 0], ['112', 0, 60_000_000]]),
  entry('2026-07-01', [['112', 2_000_000, 0], ['711', 0, 2_000_000]]),
  entry('2026-07-02', [['811', 1_000_000, 0], ['112', 0, 1_000_000]]),
  entry('2026-12-31', [['8211', 12_000_000, 0], ['3334', 0, 12_000_000]]),
  entry('2026-12-31', [['8212', 2_000_000, 0], ['347', 0, 2_000_000]]),
];

describe('TT99 B02-DN map (draft)', () => {
  it('matches the hand calculation for the year', () => {
    const report = buildB02(YEAR, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99);
    expect(amounts(report.lines)).toEqual({
      '01': '500000000', '02': '30000000', '10': '470000000', '11': '200000000', '20': '270000000', '21': '0', '22': '3000000', '23': '5000000', '24': '1000000',
      '25': '40000000', '26': '60000000', '30': '168000000', '31': '2000000', '32': '1000000', '40': '1000000', '50': '169000000', '51': '12000000', '52': '2000000', '60': '155000000',
    });
    expect(report.unmapped).toEqual([]);
  });

  it('reads the expense and income accounts the TT133 map would leave unmapped', () => {
    const tt133 = buildB02(YEAR, LE, '2026-01-01', '2026-12-31');
    // The TT133 map has no rule for 521 (deduction) or 641 (selling expense), so under TT133 they stay in unmapped and profit is overstated (the bug of #5187).
    expect(tt133.unmapped.map((u) => u.accountCode)).toEqual(expect.arrayContaining(['521', '641']));
    expect(amounts(tt133.lines)['50']).not.toBe('169000000');
  });

  it('keeps TT133 for a caller that names no map', () => {
    expect(buildB02(YEAR, LE, '2026-01-01', '2026-12-31')).toEqual(buildB02(YEAR, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES));
  });

  it('reads a reversed sale as a smaller revenue, not as a deduction', () => {
    const entries = [entry('2026-02-10', [['131', 100, 0], ['511', 0, 100]]), entry('2026-02-11', [['131', 0, 100], ['511', 100, 0]], true)];
    const a = amounts(buildB02(entries, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
    expect(a['01']).toBe('0');
    expect(a['02']).toBe('0');
  });

  it('keeps current tax (821, 8211, 82111) apart from deferred tax (8212) and its sub-accounts', () => {
    const entries = [
      entry('2026-12-31', [['821', 1, 0], ['3334', 0, 1]]),
      entry('2026-12-31', [['82111', 2, 0], ['3334', 0, 2]]),
      entry('2026-12-31', [['82112', 4, 0], ['3334', 0, 4]]),
      entry('2026-12-31', [['8212', 8, 0], ['347', 0, 8]]),
    ];
    const a = amounts(buildB02(entries, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
    expect(a['51']).toBe('7');
    expect(a['52']).toBe('8');
    expect(a['60']).toBe('-15');
  });

  it('leaves the year-end closing entries out and reports production-cost accounts no line reads', () => {
    const entries = [
      ...YEAR,
      entry('2026-12-31', [['511', 460_000_000, 0], ['911', 0, 460_000_000]]),
      entry('2026-06-30', [['622', 7, 0], ['334', 0, 7]]),
    ];
    const report = buildB02(entries, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99);
    expect(amounts(report.lines)['01']).toBe('500000000');
    expect(report.unmapped).toEqual([{ accountCode: '622', partyId: null, amount: '7' }]);
  });

  it('counts a revenue deduction once after the period-end entry Dr 511 / Cr 521 (official line 02: the 511 debit that pairs with a 521 credit)', () => {
    // The circular closes 521 into 511 at period end (Dr 511 / Cr 521, no 911 in it); the 20M discount of YEAR is closed that way, and 511 is then closed to 911. Line 02 stays 20M (521) + 10M (the direct return) = 30M.
    const closed = [
      ...YEAR,
      entry('2026-12-31', [['511', 20_000_000, 0], ['521', 0, 20_000_000]]),
      entry('2026-12-31', [['511', 460_000_000, 0], ['911', 0, 460_000_000]]),
    ];
    const a = amounts(buildB02(closed, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
    expect(a['01']).toBe('500000000');
    expect(a['02']).toBe('30000000');
    expect(a['10']).toBe('470000000');
    expect(a['60']).toBe('155000000');
    expect(buildB02(closed, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).unmapped).toEqual([]);
    // Before and after the closing entry, the same statement.
    expect(buildB02(YEAR, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines).toEqual(buildB02(closed, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
  });

  it('still reads a return booked straight on 511 (no 521 in the entry) as a deduction', () => {
    const entries = [entry('2026-02-10', [['131', 100, 0], ['511', 0, 100]]), entry('2026-03-05', [['511', 30, 0], ['131', 0, 30]])];
    const a = amounts(buildB02(entries, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
    expect(a['01']).toBe('100');
    expect(a['02']).toBe('30');
    expect(a['10']).toBe('70');
  });

  it('reads a deduction on 521 only, with no closing entry yet', () => {
    const entries = [entry('2026-02-10', [['131', 100, 0], ['511', 0, 100]]), entry('2026-02-20', [['521', 15, 0], ['131', 0, 15]])];
    const a = amounts(buildB02(entries, LE, '2026-01-01', '2026-12-31', 'VND', B02_LINES_TT99).lines);
    expect(a['02']).toBe('15');
    expect(a['10']).toBe('85');
  });

  it('defines every formula part before the line that uses it, and no code twice', () => {
    const seen = new Set<string>();
    for (const def of B02_LINES_TT99) {
      expect(seen.has(def.code)).toBe(false);
      for (const [, code] of def.formula ?? []) expect(seen.has(code)).toBe(true);
      seen.add(def.code);
    }
  });

  it('picks the map by regime and names the lines the overview reads', () => {
    expect(b02LinesFor('tt99')).toBe(B02_LINES_TT99);
    expect(b02LinesFor('tt133')).toBe(B02_LINES);
    expect(B02_ROLES.tt133.financeRevenue).toEqual(['21']);
    expect(B02_ROLES.tt99.financeRevenue).toEqual(['21', '22']);
    for (const regime of ['tt133', 'tt99'] as const) {
      const codes = new Set(b02LinesFor(regime).map((l) => l.code));
      const roles = B02_ROLES[regime];
      for (const code of [roles.netRevenue, roles.otherIncome, roles.profit, ...roles.financeRevenue]) expect(codes.has(code)).toBe(true);
    }
  });
});

describe('the regime a statement is read under', () => {
  const tt99From2026 = [{ regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-01-01' }];
  const year = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });

  it('is TT133 without a books row', () => {
    expect(statementsBooksOf([], '2026-12-31', [year(2026)])).toEqual({ regime: 'tt133', mixedCharts: false });
  });

  it('is the regime of the period end, and mixes nothing inside one chart', () => {
    expect(statementsBooksOf(tt99From2026, '2026-09-30', [{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-08-01', to: '2026-08-31' }])).toEqual({ regime: 'tt99', mixedCharts: false });
  });

  it('flags a comparison column booked under the other chart', () => {
    expect(statementsBooksOf(tt99From2026, '2026-12-31', [year(2026), year(2025)])).toEqual({ regime: 'tt99', mixedCharts: true });
  });

  it('a later books row never reaches back: a TT99 year read against its TT133 year before is flagged, the TT133 year itself is not', () => {
    const rows = [{ regime: 'tt99', chartVersion: '2027.1', effectiveFrom: '2027-01-01' }];
    expect(statementsBooksOf(rows, '2026-12-31', [year(2026), year(2025)])).toEqual({ regime: 'tt133', mixedCharts: false });
    expect(statementsBooksOf(rows, '2027-12-31', [year(2027), year(2026)])).toEqual({ regime: 'tt99', mixedCharts: true });
  });
});
