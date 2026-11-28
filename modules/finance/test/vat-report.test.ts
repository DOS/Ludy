// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the single-statement VAT working loader (#613): verifies loadVatReport issues exactly one SQL
// statement with limit gating before child aggregation, preserves RLS-scoped tables, maps all fields and edge cases
// (tax table vs line estimate, payment checks, carry-forward, supplementary sales, late sales), and fails closed on limits.
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { DomainError, type QueryContext } from '@ludy/kernel-runtime';
import { VAT_PERIOD_LIMIT, loadVatReport } from '../src/vat.ts';

const ORG = '0192a000-0000-7000-8000-0000000000aa';
const ENTITY = '0192a000-0000-7000-8000-0000000000bb';

interface VatRowOverrides {
  entity_allowed?: boolean;
  tax_code?: string | null;
  purchase_over?: boolean;
  sale_over?: boolean;
  late_sale_over?: boolean;
  purchases?: unknown[];
  purchase_lines?: unknown[];
  purchase_rates?: unknown[];
  purchase_marks?: unknown[];
  sales?: unknown[];
  sale_lines?: unknown[];
  sale_rates?: unknown[];
  late_sales?: unknown[];
  filed_returns?: unknown[];
  locked_through?: string | null;
  lock_updated_at?: Date | string | null;
  lock_events?: unknown[];
}

function emptyVatRow(overrides: VatRowOverrides = {}) {
  return {
    entity_allowed: true,
    tax_code: '0309876546',
    purchase_over: false,
    sale_over: false,
    late_sale_over: false,
    purchases: [],
    purchase_lines: [],
    purchase_rates: [],
    purchase_marks: [],
    sales: [],
    sale_lines: [],
    sale_rates: [],
    late_sales: [],
    filed_returns: [],
    locked_through: null,
    lock_updated_at: null,
    lock_events: [],
    ...overrides,
  };
}

function captureVatQuery(overrides: VatRowOverrides = {}) {
  const queries: CompiledQuery[] = [];
  const baseDriver = new DummyDriver();
  const row = emptyVatRow(overrides);
  const trx = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: () => baseDriver.init(),
        acquireConnection: async () => ({
          executeQuery: async <R>(compiledQuery: CompiledQuery) => {
            queries.push(compiledQuery);
            return { rows: [row as unknown as R] };
          },
          streamQuery: async function* <R>(): AsyncIterableIterator<{ rows: R[] }> {
            yield { rows: [] };
          },
        }),
        beginTransaction: () => baseDriver.beginTransaction(),
        commitTransaction: () => baseDriver.commitTransaction(),
        rollbackTransaction: () => baseDriver.rollbackTransaction(),
        releaseConnection: () => baseDriver.releaseConnection(),
        destroy: () => baseDriver.destroy(),
      }),
    },
  });
  const ctx = { orgId: ORG, trx } as unknown as QueryContext;
  return { queries, run: (period: string, legalEntityId = ENTITY) => loadVatReport(ctx, period, legalEntityId) };
}

describe('loadVatReport single-statement SQL (#613)', () => {
  it('reads every VAT working table in exactly one SQL statement for months and quarters', async () => {
    for (const period of ['2026-09', '2026-Q3']) {
      const { queries, run } = captureVatQuery();
      const report = await run(period);
      expect(report.period.period).toBe(period);
      expect(queries).toHaveLength(1);

      const query = queries[0]!;
      const sqlLower = query.sql.toLowerCase();
      expect(sqlLower).toContain('purchase_docs as materialized');
      expect(sqlLower).toContain('sale_docs as materialized');
      expect(sqlLower).toContain('late_sale_docs as materialized');
      expect(sqlLower).toContain('within_limits as materialized');
      expect(sqlLower).toContain('late_sale_periods as materialized');
      expect(sqlLower).toContain('lock_row as materialized');
      expect(sqlLower).toContain('lock_targets as materialized');

      const normalizedSql = query.sql.replace(/"/g, '');
      for (const table of [
        'ludy_kernel.legal_entity',
        'ludy_kernel.tenant',
        'ludy_finance.purchase_document',
        'ludy_finance.purchase_line',
        'ludy_finance.purchase_tax_rate',
        'ludy_finance.input_vat_check',
        'ludy_finance.vat_return_filed',
        'ludy_finance.period_lock',
        'ludy_kernel.audit_event',
        'ludy_finance.einvoice_draft',
        'ludy_finance.einvoice_series',
        'ludy_finance.journal_entry',
        'ludy_kernel.party',
        'ludy_finance.purchase_document_void',
      ]) {
        expect(normalizedSql).toContain(table);
      }

      // Limit gating runs before child aggregation using set-based CTE JOINs, never per-row child SubPlans or unhashed ANY(ARRAY(...)) scans.
      expect(query.parameters).toContain(VAT_PERIOD_LIMIT + 1);
      expect(query.parameters).toContain(VAT_PERIOD_LIMIT);
      expect(normalizedSql).toContain('FROM purchase_docs pd');
      expect(normalizedSql).toContain('FROM sale_docs pd');
      expect(normalizedSql).not.toContain('ANY (ARRAY(');
      expect(query.sql).toContain('d.subtotal::text');
      expect(query.sql).toContain('d.invoice_date::text');
      expect(query.sql).not.toContain('SECURITY DEFINER');
    }
  });

  it('refuses an entity outside caller scope with LEGAL_ENTITY_NOT_ALLOWED', async () => {
    const { run } = captureVatQuery({ entity_allowed: false });
    await expect(run('2026-09')).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
  });

  it('fails closed with PERIOD_TOO_LARGE when purchases, sales, or late sales exceed VAT_PERIOD_LIMIT', async () => {
    for (const flag of ['purchase_over', 'sale_over', 'late_sale_over'] as const) {
      const { run } = captureVatQuery({ [flag]: true });
      const err = await run('2026-09').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toMatchObject({
        code: 'PERIOD_TOO_LARGE',
        status: 422,
        message: `Kỳ này có hơn ${VAT_PERIOD_LIMIT} hóa đơn; hệ thống chưa lập được bảng kê lớn như vậy`,
      });
    }
  });
});

describe('loadVatReport mapping parity (#613)', () => {
  it('maps purchases, tax-table vs line-estimated rates, payment checks, carry-forward, supplementary, and late sales', async () => {
    const { run } = captureVatQuery({
      tax_code: null,
      purchases: [
        {
          id: 'doc-p1',
          invoice_date: '2026-08-25',
          entry_date: '2026-09-05',
          invoice_series: 'K26TAA',
          invoice_number: '101',
          subtotal: '9000000.0000',
          vat_amount: '900000.0000',
          total: '9900000.0000',
          payment_method: 'TM',
          created_at: '2026-09-05T02:00:00.000Z',
          name: 'Nhà cung cấp A',
          tax_code: '0101234564',
          correction_kind: 'adjustment',
          corrected_series: 'K26TAA',
          corrected_number: '100',
        },
        {
          id: 'doc-p2',
          invoice_date: '2026-09-10',
          entry_date: '2026-09-10',
          invoice_series: 'K26TAB',
          invoice_number: '102',
          subtotal: '10000000.0000',
          vat_amount: '1000000.0000',
          total: '11000000.0000',
          payment_method: 'TM/CK',
          created_at: '2026-09-10T02:00:00.000Z',
          name: 'Nhà cung cấp B',
          tax_code: null,
          correction_kind: null,
          corrected_series: null,
          corrected_number: null,
        },
      ],
      purchase_lines: [
        ['doc-p1', '9000000.0000', '10%'],
        ['doc-p2', '10000000.0000', '10%'],
      ],
      purchase_rates: [['doc-p1', '10%', '9000000.0000', '900000.0000']],
      purchase_marks: [
        {
          document_id: 'doc-p1',
          outcome: 'not_deductible',
          voucher_id: null,
          note: 'Trả tiền mặt',
          created_at: '2026-09-06T03:00:00.000Z',
        },
        {
          // A cleared mark counts as unchecked.
          document_id: 'doc-p2',
          outcome: 'cleared',
          voucher_id: null,
          note: null,
          created_at: '2026-09-11T03:00:00.000Z',
        },
      ],
      sales: [
        {
          id: 'doc-s1',
          invoice_date: '2026-09-15',
          sale_date: null,
          entry_date: '2026-09-15',
          invoice_series: 'C26TAA',
          invoice_number: '1',
          subtotal: '2000000.0000',
          vat_amount: '200000.0000',
          total: '2200000.0000',
          payment_method: 'CK',
          created_at: '2026-09-15T04:00:00.000Z',
          name: 'Khách hàng 1',
          tax_code: '0109999999',
          correction_kind: null,
          corrected_series: null,
          corrected_number: null,
        },
        {
          // Sale of 2026-09 issued in October and recorded AFTER period lock fallback timestamp -> supplementary.
          id: 'doc-s2',
          invoice_date: '2026-10-05',
          sale_date: '2026-09-20',
          entry_date: '2026-10-05',
          invoice_series: 'C26TAA',
          invoice_number: '2',
          subtotal: '1000000.0000',
          vat_amount: '100000.0000',
          total: '1100000.0000',
          payment_method: 'CK',
          created_at: '2026-10-05T05:00:00.000Z',
          name: 'Khách hàng 2',
          tax_code: null,
          correction_kind: null,
          corrected_series: null,
          corrected_number: null,
        },
      ],
      sale_lines: [
        ['doc-s1', '2000000.0000', '10%'],
        ['doc-s2', '1000000.0000', '10%'],
      ],
      sale_rates: [],
      late_sales: [
        {
          id: 'doc-ls1',
          invoice_series: 'C26TAA',
          invoice_number: '3',
          name: 'Khách hàng 3',
          invoice_date: '2026-09-18',
          sale_date: '2026-08-12',
          total: '550000.0000',
          vat_amount: '50000.0000',
          created_at: '2026-09-18T02:00:00.000Z',
        },
        {
          id: 'doc-ls2',
          invoice_series: 'C26TAA',
          invoice_number: '4',
          name: 'Khách hàng 4',
          invoice_date: '2026-09-19',
          sale_date: '2026-07-10',
          total: '550000.0000',
          vat_amount: '50000.0000',
          created_at: '2026-09-19T02:00:00.000Z',
        },
      ],
      filed_returns: [
        {
          period: '2026-08',
          status: 'filed',
          source: 'entered',
          carried_in_amount: '0.0000',
          deductible_amount: '100000.0000',
          carried_out_amount: '500000.0000',
          created_at: '2026-09-19T00:00:00.000Z',
        },
        {
          period: '2026-09',
          status: 'withdrawn',
          source: null,
          carried_in_amount: null,
          deductible_amount: null,
          carried_out_amount: null,
          created_at: '2026-09-20T00:00:00.000Z',
        },
      ],
      locked_through: '2026-09-30',
      // No audit event for 2026-09 lock -> uses lock_updated_at fallback; 2026-08 uses audit event.
      lock_updated_at: new Date('2026-10-02T00:00:00.000Z'),
      lock_events: [{ period: '2026-08', at: '2026-09-05T00:00:00.000Z' }],
    });

    const report = await run('2026-09');
    expect(report.input.totals).toMatchObject({ taxable: '19000000', vat: '1900000', documents: 2 });
    expect(report.input.documents[0]).toMatchObject({
      id: 'doc-p1',
      warnings: ['declared_late'],
      correction: { kind: 'adjustment', series: 'K26TAA', number: '100', basis: 'posting_date' },
    });
    expect(report.input.documents[1]?.warnings).toEqual(['check_payment']);
    expect(report.paymentChecks).toMatchObject({
      vatAtRisk: '1900000',
      notDeductibleVat: '900000',
      unchecked: 1,
      suggested25: '1000000',
    });

    // Even when tax_code is null, recorded sales make output.available true; doc-s2 moves to supplementary.
    expect(report.output.available).toBe(true);
    expect(report.output.documents.map((d) => d.id)).toEqual(['doc-s1']);
    expect(report.output.totals).toMatchObject({ taxable: '2000000', vat: '200000', documents: 1 });
    expect(report.supplementary.documents.map((d) => d.id)).toEqual(['doc-s2']);
    expect(report.supplementary.documents[0]?.warnings).toEqual(['late_sale']);
    expect(report.supplementary.totals).toMatchObject({ taxable: '1000000', vat: '100000', documents: 1 });

    // Withdrawn 2026-09 return counts as null; carryForward comes from 2026-08.
    expect(report.filed).toBeNull();
    expect(report.carryForward).toMatchObject({ amount: '500000', lookedFor: ['2026-08'], previous: { period: '2026-08' } });

    // 2026-08 was locked at 2026-09-05 (filed at 2026-09-19, earlier wins) -> doc-ls1 (2026-09-18) is supplementary.
    // 2026-07 has no filing and no audit lock event -> lock_updated_at (2026-10-02) applies -> doc-ls2 (2026-09-19) is NOT supplementary.
    expect(report.lateSales).toEqual([
      expect.objectContaining({ documentId: 'doc-ls1', originalPeriod: '2026-08', supplementary: true }),
      expect.objectContaining({ documentId: 'doc-ls2', originalPeriod: '2026-07', supplementary: false }),
    ]);
  });

  it('marks output unavailable when tax_code is null and no sales exist', async () => {
    const { run } = captureVatQuery({ tax_code: null, sales: [] });
    const report = await run('2026-09');
    expect(report.output).toMatchObject({ available: false, documents: [], totals: { taxable: '0', vat: '0', documents: 0 } });
  });
});
