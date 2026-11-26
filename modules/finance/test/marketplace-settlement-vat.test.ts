// SPDX-License-Identifier: AGPL-3.0-only
// Batch VAT rate resolution (#4341): one entity read per request (`memo`), in-memory lookup with the same effective-date precedence rule as marketplaceVatRateAt.
import { describe, expect, it } from 'vitest';
import type { MarketplaceVatRateRow } from '@ludy/kernel-contract';
import type { QueryContext } from '@ludy/kernel-runtime';
import type { SettlementMonth } from '../src/marketplace-settlement-months.ts';
import type { SettlementVatRate } from '../src/marketplace-settlement-posting.ts';
import { offeredMonths, resolveVatRates } from '../src/marketplace-settlement-vat.ts';
import { pickMarketplaceVatRate } from '../src/marketplace-vat-rate.ts';

type StoredRow = { entity: string; effective_from: string; method: 'deduction' | 'none'; vat_percent: string | null };

function fakeCtx(rows: readonly StoredRow[]) {
  let queries = 0;
  const trx = {
    selectFrom() {
      let entity = '';
      const chain = {
        select() {
          return chain;
        },
        distinctOn() {
          return chain;
        },
        where(col: string, _op: string, val: string) {
          if (col === 'legal_entity_id') entity = val;
          return chain;
        },
        orderBy() {
          return chain;
        },
        async execute() {
          queries += 1;
          return rows
            .filter((r) => r.entity === entity)
            .map((r) => ({ effective_from: r.effective_from, method: r.method, vat_percent: r.vat_percent }));
        },
      };
      return chain;
    },
  } as unknown as QueryContext['trx'];
  return { ctx: { trx, orgId: 'org-1' }, queryCount: () => queries };
}

describe('pickMarketplaceVatRate', () => {
  const entries: MarketplaceVatRateRow[] = [
    { effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10.00' },
    // Two entries for 2026-03-01, newest entered first as marketplaceVatRateEntries returns them.
    { effectiveFrom: '2026-03-01', method: 'deduction', vatPercent: '8.00' },
    { effectiveFrom: '2026-03-01', method: 'deduction', vatPercent: '80.00' },
    { effectiveFrom: '2026-01-01', method: 'none', vatPercent: null },
  ];

  it('returns null when no entry exists or every entry starts after the date', () => {
    expect(pickMarketplaceVatRate([], '2026-05-01')).toBeNull();
    expect(pickMarketplaceVatRate(entries, '2025-12-31')).toBeNull();
  });

  it('returns the greatest effectiveFrom on or before the date, taking the latest entry on ties', () => {
    expect(pickMarketplaceVatRate(entries, '2026-01-01')).toEqual({ effectiveFrom: '2026-01-01', method: 'none', vatPercent: null });
    expect(pickMarketplaceVatRate(entries, '2026-02-28')).toEqual({ effectiveFrom: '2026-01-01', method: 'none', vatPercent: null });
    expect(pickMarketplaceVatRate(entries, '2026-03-01')).toEqual({ effectiveFrom: '2026-03-01', method: 'deduction', vatPercent: '8.00' });
    expect(pickMarketplaceVatRate(entries, '2026-12-31')).toEqual({ effectiveFrom: '2026-03-01', method: 'deduction', vatPercent: '8.00' });
    expect(pickMarketplaceVatRate(entries, '2027-01-01')).toEqual({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10.00' });
    expect(pickMarketplaceVatRate(entries, '2028-06-15')).toEqual({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10.00' });
  });
});

describe('resolveVatRates and offeredMonths batching', () => {
  const ROWS: StoredRow[] = [
    { entity: 'e1', effective_from: '2027-01-01', method: 'deduction', vat_percent: '10.00' },
    { entity: 'e1', effective_from: '2026-06-01', method: 'deduction', vat_percent: '8.00' },
    { entity: 'e2', effective_from: '2026-01-01', method: 'none', vat_percent: null },
  ];

  it('reads each entity once per request memo across many days and months, and reads nothing for empty days', async () => {
    const { ctx, queryCount } = fakeCtx(ROWS);
    const memo = new Map<string, SettlementVatRate | null>();

    expect(await resolveVatRates(ctx, 'e1', [], memo)).toEqual({});
    expect(queryCount()).toBe(0);

    const first = await resolveVatRates(ctx, 'e1', ['2026-05-01', '2026-06-15', '2027-02-01'], memo);
    expect(first).toEqual({
      '2026-05-01': null,
      '2026-06-15': { method: 'deduction', vatPercent: '8.00' },
      '2027-02-01': { method: 'deduction', vatPercent: '10.00' },
    });
    expect(queryCount()).toBe(1);

    // Later calls for other days of the same entity in the same request use the cached entries without querying again.
    const second = await resolveVatRates(ctx, 'e1', ['2026-07-01', '2026-12-31', '2027-05-01', '2026-06-15'], memo);
    expect(second).toEqual({
      '2026-07-01': { method: 'deduction', vatPercent: '8.00' },
      '2026-12-31': { method: 'deduction', vatPercent: '8.00' },
      '2027-05-01': { method: 'deduction', vatPercent: '10.00' },
      '2026-06-15': { method: 'deduction', vatPercent: '8.00' },
    });
    expect(queryCount()).toBe(1);

    // A second entity in the same memo triggers one read for that entity.
    expect(await resolveVatRates(ctx, 'e2', ['2026-05-01', '2027-02-01'], memo)).toEqual({
      '2026-05-01': { method: 'none' },
      '2027-02-01': { method: 'none' },
    });
    expect(queryCount()).toBe(2);
  });

  it('shares a single read across all months of offeredMonths and reports rate gaps accurately', async () => {
    const { ctx, queryCount } = fakeCtx(ROWS);
    const memo = new Map<string, SettlementVatRate | null>();
    const months: SettlementMonth[] = [
      { month: '2026-05', date: '2026-05-31', net: '100000', lines: [{ sales: '100000', sellerDiscount: '0', refund: '0', rateDate: '2026-05-10' }] },
      { month: '2026-06', date: '2026-06-30', net: '108000', lines: [{ sales: '108000', sellerDiscount: '0', refund: '0', rateDate: '2026-06-10' }] },
      // Zero net with different rates (8% vs 10%) is non-empty; zero net at the same rate is empty and skipped.
      {
        month: '2027-01',
        date: '2027-01-31',
        net: '0',
        lines: [
          { sales: '108000', sellerDiscount: '0', refund: '0', rateDate: '2027-01-05' },
          { sales: '0', sellerDiscount: '0', refund: '108000', rateDate: '2026-12-20' },
        ],
      },
      {
        month: '2027-02',
        date: '2027-02-28',
        net: '0',
        lines: [
          { sales: '110000', sellerDiscount: '0', refund: '0', rateDate: '2027-02-01' },
          { sales: '0', sellerDiscount: '0', refund: '110000', rateDate: '2027-02-02' },
        ],
      },
    ];

    const offered = await offeredMonths(ctx, 'e1', months, false, memo);
    expect(offered.gaps).toEqual(['2026-05']);
    expect(offered.months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2027-01']);
    expect(queryCount()).toBe(1);
  });
});
