// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the 511 SQL aggregate path used by 01/CNKD (#3216): canonical decimal normalization, single-query tenant/entity SQL generation without LEDGER_LINE_LIMIT, and parity with accountLedger(..., '511').
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { QueryContext } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { accountLedger, type ChartAccount, type PeriodLine } from '../src/domain/ledger-reports.ts';
import { normalizeSalesTotal, salesTotalsOf } from '../src/household-year-sales.ts';

const ORG = '0192a000-0000-7000-8000-0000000000aa';
const ENTITY = '0192a000-0000-7000-8000-0000000000bb';

function captureSalesTotalsQuery(range: { yearStart: string; from: string; to: string }) {
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const trx = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push({ sql: event.query.sql, parameters: [...event.query.parameters] });
    },
  });
  return { queries, run: () => salesTotalsOf({ orgId: ORG, trx } as unknown as Pick<QueryContext, 'trx' | 'orgId'>, ENTITY, range) };
}

describe('normalizeSalesTotal (#3216)', () => {
  it('formats SQL numeric text into canonical decimal strings without JS float math', () => {
    expect(normalizeSalesTotal(null)).toBe('0');
    expect(normalizeSalesTotal(undefined)).toBe('0');
    expect(normalizeSalesTotal('0')).toBe('0');
    expect(normalizeSalesTotal('0.0000')).toBe('0');
    expect(normalizeSalesTotal('-0.0000')).toBe('0');
    expect(normalizeSalesTotal('1600000.0000')).toBe('1600000');
    expect(normalizeSalesTotal('-50000.0000')).toBe('-50000');
    expect(normalizeSalesTotal('1234.5000')).toBe('1234.5');
    expect(normalizeSalesTotal('9999999999999999.1234')).toBe('9999999999999999.1234');
  });
});

describe('salesTotalsOf (#3216)', () => {
  it('runs one uncapped SQL aggregate scoped to org, legal entity, date window, and account 511', async () => {
    const { queries, run } = captureSalesTotalsQuery({ yearStart: '2026-01-01', from: '2026-08-15', to: '2026-09-30' });
    expect(await run()).toEqual({ quarter: '0', before: '0' });
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.sql).toContain('SUM(l.credit - l.debit) FILTER');
    expect(q.sql).toContain('ludy_finance.journal_line');
    expect(q.sql).toContain('ludy_finance.journal_entry');
    expect(q.sql).toContain('ludy_finance.org_account');
    expect(q.sql).toContain('"l"."org_id" =');
    expect(q.sql).toContain('"l"."legal_entity_id" =');
    expect(q.sql).toContain('"j"."legal_entity_id" =');
    expect(q.sql).toContain('"l"."account_code" like');
    expect(q.sql).not.toContain('limit');
    expect(q.sql).not.toContain('911');
    expect(q.sql).not.toContain('521');
    expect(q.parameters).toContain(ORG);
    expect(q.parameters).toContain(ENTITY);
    expect(q.parameters).toContain('511%');
    expect(q.parameters).toContain('511');
    expect(q.parameters).toContain('2026-01-01');
    expect(q.parameters).toContain('2026-08-15');
    expect(q.parameters).toContain('2026-09-30');
  });

  it('clamps scan start when yearStart is after from without dropping quarter filters', async () => {
    const { queries, run } = captureSalesTotalsQuery({ yearStart: '2026-01-01', from: '2025-12-15', to: '2026-03-31' });
    await run();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.parameters).toContain('2025-12-15');
  });
});

describe('01/CNKD 511 aggregate accounting parity (#3216)', () => {
  const chart: ChartAccount[] = [
    { code: '111', name: 'Tiền mặt', parentCode: null },
    { code: '112', name: 'Tiền gửi ngân hàng', parentCode: null },
    { code: '131', name: 'Phải thu của khách hàng', parentCode: null },
    { code: '511', name: 'Doanh thu bán hàng', parentCode: null },
    { code: '5111', name: 'Doanh thu bán hàng hóa', parentCode: '511' },
    { code: '5113', name: 'Doanh thu cung cấp dịch vụ', parentCode: '511' },
    { code: '511.SHOPEE', name: 'Doanh thu Shopee', parentCode: '511' },
    { code: '515', name: 'Doanh thu hoạt động tài chính', parentCode: null },
    { code: '521', name: 'Các khoản giảm trừ doanh thu', parentCode: null },
    { code: '642', name: 'Chi phí quản lý kinh doanh', parentCode: null },
    { code: '711', name: 'Thu nhập khác', parentCode: null },
    { code: '911', name: 'Xác định kết quả kinh doanh', parentCode: null },
  ];

  const line = (entryId: string, entryDate: string, lineNo: number, accountCode: string, debit: string, credit: string, reversal = false): PeriodLine => ({
    entryId,
    entryDate,
    reference: null,
    description: entryId,
    reversal,
    lineNo,
    accountCode,
    partyId: null,
    debit,
    credit,
  });

  it('matches accountLedger(..., "511") across sub-accounts, reversals, non-511 accounts, 521, 911 closing, and date boundaries', () => {
    const periodLines: PeriodLine[] = [
      // Inside quarter before mid-quarter opening date (excluded from [from, to], included in before)
      line('e1', '2026-07-10', 1, '111', '300000', '0'),
      line('e1', '2026-07-10', 2, '511', '0', '300000'),
      // Boundary day: on `from` (included)
      line('e2', '2026-08-15', 1, '112', '1000000', '0'),
      line('e2', '2026-08-15', 2, '5111', '0', '600000'),
      line('e2', '2026-08-15', 3, '511.SHOPEE', '0', '400000'),
      // Reversal entry on 5113
      line('e3', '2026-08-20', 1, '111', '250000', '0'),
      line('e3', '2026-08-20', 2, '5113', '0', '250000'),
      line('e4', '2026-08-21', 1, '5113', '250000', '0', true),
      line('e4', '2026-08-21', 2, '111', '0', '250000', true),
      // Non-511 revenue and deduction accounts (must not affect 511 total)
      line('e5', '2026-09-01', 1, '521', '50000', '0'),
      line('e5', '2026-09-01', 2, '131', '0', '50000'),
      line('e6', '2026-09-02', 1, '112', '80000', '0'),
      line('e6', '2026-09-02', 2, '515', '0', '80000'),
      line('e7', '2026-09-03', 1, '111', '40000', '0'),
      line('e7', '2026-09-03', 2, '711', '0', '40000'),
      line('e8', '2026-09-04', 1, '642', '90000', '0'),
      line('e8', '2026-09-04', 2, '112', '0', '90000'),
      // Return + closing entry touching 911 on `to` (accountLedger counts every posted 511 movement)
      line('e9', '2026-09-30', 1, '5111', '120000', '0'),
      line('e9', '2026-09-30', 2, '911', '0', '120000'),
    ];
    const from = '2026-08-15';
    const ledger = accountLedger(chart, [], periodLines, '511');
    const ledgerFiltered = ledger.lines.filter((l) => l.entryDate >= from);
    const ledgerRevenue = toMoney(sum(ledgerFiltered.map((l) => l.credit)).minus(sum(ledgerFiltered.map((l) => l.debit))));

    const is511 = (code: string) => code.startsWith('511');
    const sqlAggregateRevenue = normalizeSalesTotal(
      toMoney(
        periodLines
          .filter((l) => l.entryDate >= from && l.entryDate <= '2026-09-30' && is511(l.accountCode))
          .reduce((acc, l) => acc.plus(money(l.credit).minus(money(l.debit))), money(0)),
      ),
    );
    expect(sqlAggregateRevenue).toBe(ledgerRevenue);
    expect(sqlAggregateRevenue).toBe('880000');
  });
});
