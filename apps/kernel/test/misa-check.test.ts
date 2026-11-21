// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA export, on the API side (#3848): for each of the seven formats it asks for the same vouchers the export route of that format asks for (the same query, range and limit), reads the org's
// chart, and refuses a range too large to export with the export's own error. A fake query stands in for the runtime, so this needs no database.
import { describe, expect, it } from 'vitest';
import { MISA_CHECK_FORMATS, type MisaCheckAsk } from '@ludy/kernel-contract';
import { JOURNAL_EXPORT_LIMIT } from '@ludy/mod-finance';
import { misaCheck, type MisaCheckQuery } from '../src/misa-check.ts';

const CHART = [
  { code: '331', parentCode: null },
  { code: '6422', parentCode: null },
];

function fake(answers: Record<string, unknown>) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const query: MisaCheckQuery = async <T,>(name: string, input: unknown) => {
    calls.push({ name, input });
    if (!(name in answers)) throw new Error(`unexpected query ${name}`);
    return answers[name] as T;
  };
  return { query, calls };
}

const range = { from: '2026-10-01', to: '2026-10-31' } as const;

describe('misaCheck', () => {
  it('asks for the purchase, sales or cash vouchers of the format, with the export range, the entity and the export limit', async () => {
    const entity = '11111111-1111-4111-8111-111111111111';
    const expected: Record<string, string> = {
      misa_sme_purchases: 'finance.vouchers.purchases',
      misa_sme_goods_purchases: 'finance.vouchers.purchases',
      misa_sme_sales: 'finance.vouchers.sales',
      misa_sme_cash_receipts: 'finance.vouchers.cash',
      misa_sme_cash_payments: 'finance.vouchers.cash',
      misa_sme_bank_credits: 'finance.vouchers.cash',
      misa_sme_bank_debits: 'finance.vouchers.cash',
    };
    for (const format of MISA_CHECK_FORMATS) {
      const { query, calls } = fake({ 'finance.accounts.list': CHART, 'finance.vouchers.purchases': [], 'finance.vouchers.sales': [], 'finance.vouchers.cash': [], 'finance.misa_goods_codes.list': [] });
      const result = await misaCheck(query, { format, ...range, legalEntityId: entity });
      expect(result).toEqual({ format, rows: 0, findings: 0, groups: [] });
      const vouchers = calls.find((c) => c.name === expected[format]);
      expect(vouchers, format).toBeDefined();
      expect(vouchers?.input).toMatchObject({ ...range, limit: JOURNAL_EXPORT_LIMIT, legalEntityId: entity });
      // Goods codes are read only for the goods file.
      expect(calls.some((c) => c.name === 'finance.misa_goods_codes.list'), format).toBe(format === 'misa_sme_goods_purchases');
    }
  });

  it('asks the cash query for the type of the format', async () => {
    const types: Record<string, string> = { misa_sme_cash_receipts: 'cash_receipt', misa_sme_cash_payments: 'cash_payment', misa_sme_bank_credits: 'bank_credit', misa_sme_bank_debits: 'bank_debit' };
    for (const [format, type] of Object.entries(types)) {
      const { query, calls } = fake({ 'finance.accounts.list': CHART, 'finance.vouchers.cash': [] });
      await misaCheck(query, { format, ...range } as MisaCheckAsk);
      expect(calls.find((c) => c.name === 'finance.vouchers.cash')?.input).toMatchObject({ type });
    }
  });

  it('reports a finding from the rows the file is built from, with the chart read from the org', async () => {
    const voucher = {
      entryId: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c',
      entryDate: '2026-10-05',
      description: 'Mua',
      invoice: { series: 'C', number: '1', date: '2026-10-05' },
      vendor: { name: 'Công ty ABC', taxCode: null, address: null },
      vatAmount: '0',
      lines: [{ lineNo: 1, description: 'd', unit: null, quantity: null, unitPrice: null, amount: '1000', vatRate: '0%', debitAccount: '6422' }],
    };
    const { query } = fake({ 'finance.accounts.list': [{ code: '331', parentCode: null }], 'finance.vouchers.purchases': [voucher] });
    const result = await misaCheck(query, { format: 'misa_sme_purchases', ...range });
    expect(result.rows).toBe(1);
    // 6422 is not in the chart this org returned.
    expect(result.groups.find((g) => g.kind === 'ACCOUNT_NOT_IN_CHART' && g.column === 'TK chi phí/TK kho')?.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain('ABC');
  });

  it('refuses a range too large to export, with the export\'s own error', async () => {
    const full = Array.from({ length: JOURNAL_EXPORT_LIMIT }, () => ({}));
    for (const [format, name] of [
      ['misa_sme_purchases', 'finance.vouchers.purchases'],
      ['misa_sme_sales', 'finance.vouchers.sales'],
      ['misa_sme_cash_payments', 'finance.vouchers.cash'],
    ] as const) {
      const { query } = fake({ 'finance.accounts.list': CHART, [name]: full });
      await expect(misaCheck(query, { format, ...range }), format).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', status: 422 });
    }
  });
});
