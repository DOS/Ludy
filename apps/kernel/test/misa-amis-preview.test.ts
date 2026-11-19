// SPDX-License-Identifier: AGPL-3.0-only
// The preview of a MISA AMIS push on the API side (#3901): for each of the seven kinds it asks for the same vouchers the MISA SME export of that kind asks for, writes them as the push would, and lists them with their
// blockers. A fake query stands in for the runtime, so this needs no database.
import { describe, expect, it } from 'vitest';
import { MISA_AMIS_KINDS, MISA_AMIS_PREVIEW_BLOCKERS, MISA_AMIS_PREVIEW_LIMIT, zMisaAmisPreview } from '@crove/kernel-contract';
import type { CashVoucher, PurchaseVoucher, SalesVoucher } from '@crove/mod-finance';
import { misaAmisPreview, type MisaAmisPreviewQuery } from '../src/misa-amis-preview.ts';

const CHART = [
  { code: '156', parentCode: null },
  { code: '1561', parentCode: '156' },
  { code: '6422', parentCode: null },
];
const SOURCE = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const ENTRY = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c';

function fake(answers: Record<string, unknown>) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const query: MisaAmisPreviewQuery = async <T,>(name: string, input: unknown) => {
    calls.push({ name, input });
    if (!(name in answers)) throw new Error(`unexpected query ${name}`);
    return answers[name] as T;
  };
  return { query, calls };
}

const purchase = (id = SOURCE, debitAccount = '6422'): PurchaseVoucher => ({
  sourceId: id,
  entryId: ENTRY,
  entryDate: '2026-09-30',
  description: 'Mua dịch vụ',
  invoice: { series: 'C26TAA', number: '123', date: '2026-09-29' },
  vendor: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: null },
  vatAmount: '100000',
  lines: [{ lineNo: 1, description: 'Phí', unit: null, quantity: null, unitPrice: null, amount: '1000000', vatRate: '10%', debitAccount }],
});
const sale = (): SalesVoucher => ({
  sourceId: SOURCE,
  entryId: ENTRY,
  entryDate: '2026-10-05',
  description: 'Bán hàng',
  invoice: { series: 'C26TBB', number: '45', date: '2026-10-05' },
  customer: { name: 'Công ty CP XYZ', taxCode: '0312345678', address: null },
  receivableAccount: '131',
  vatAccount: '3331',
  vatAmount: '80000',
  lines: [{ lineNo: 1, description: 'Tư vấn', unit: null, quantity: null, unitPrice: null, amount: '1000000', vatRate: '8%', revenueAccount: '511' }],
});
const cash = (): CashVoucher => ({
  sourceId: SOURCE,
  type: 'cash_payment',
  code: 'PC00012',
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: '1111',
  party: null,
  personName: null,
  description: 'Trả tiền',
  lines: [{ lineNo: 1, account: '331', amount: '500000', memo: null }],
});

const range = { from: '2026-10-01', to: '2026-10-31' } as const;
const all = { 'finance.accounts.list': CHART, 'finance.vouchers.purchases': [], 'finance.vouchers.sales': [], 'finance.vouchers.cash': [], 'finance.misa_goods_codes.list': [] };

describe('misaAmisPreview', () => {
  it('asks for the vouchers of the kind, with the range, the entity and one more than the list holds', async () => {
    const entity = '11111111-1111-4111-8111-111111111111';
    const expected: Record<string, string> = {
      purchase_services: 'finance.vouchers.purchases',
      purchase_goods: 'finance.vouchers.purchases',
      sales: 'finance.vouchers.sales',
      cash_receipt: 'finance.vouchers.cash',
      cash_payment: 'finance.vouchers.cash',
      bank_credit: 'finance.vouchers.cash',
      bank_debit: 'finance.vouchers.cash',
    };
    for (const kind of MISA_AMIS_KINDS) {
      const { query, calls } = fake(all);
      const result = await misaAmisPreview(query, { kind, ...range, legalEntityId: entity });
      expect(result).toEqual({ kind, vouchers: 0, ready: 0, blocked: 0, checkedAgainstAmis: false, purchasePurpose: '1', more: false, items: [] });
      expect(calls.find((c) => c.name === expected[kind])?.input, kind).toMatchObject({ ...range, limit: MISA_AMIS_PREVIEW_LIMIT + 1, legalEntityId: entity });
      expect(calls.some((c) => c.name === 'finance.misa_goods_codes.list'), kind).toBe(kind === 'purchase_goods');
    }
  });

  it('asks the cash query for the type of the kind', async () => {
    for (const type of ['cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit'] as const) {
      const { query, calls } = fake(all);
      await misaAmisPreview(query, { kind: type, ...range });
      expect(calls.find((c) => c.name === 'finance.vouchers.cash')?.input).toMatchObject({ type });
    }
  });

  it('lists a purchase service voucher as blocked until an AMIS service item is given, then as ready with its totals', async () => {
    const answers = { ...all, 'finance.vouchers.purchases': [purchase()] };
    const blocked = await misaAmisPreview(fake(answers).query, { kind: 'purchase_services', ...range });
    expect(blocked).toMatchObject({ vouchers: 1, ready: 0, blocked: 1, items: [{ sourceId: SOURCE, amisType: 17, parts: 1, total: '0', blockers: [{ code: 'item_code_unknown', lineNo: 1 }] }] });
    const ready = await misaAmisPreview(fake(answers).query, { kind: 'purchase_services', ...range, serviceItemCode: 'DV_CHUNG' });
    expect(ready).toMatchObject({ vouchers: 1, ready: 1, blocked: 0, items: [{ amisType: 17, reftype: 330, reasonTypeId: null, lines: 1, total: '1100000', blockers: [] }] });
    // Nothing in the answer names a party, an invoice or an amount of a line.
    expect(JSON.stringify(ready)).not.toMatch(/ABC|C26TAA|Phí/);
  });

  it('does not list a purchase under the kind whose lines it has none of', async () => {
    const stockOnly = { ...all, 'finance.vouchers.purchases': [purchase(SOURCE, '1561')] };
    expect((await misaAmisPreview(fake(stockOnly).query, { kind: 'purchase_services', ...range, serviceItemCode: 'X' })).items).toEqual([]);
    expect((await misaAmisPreview(fake(stockOnly).query, { kind: 'purchase_goods', ...range })).items).toHaveLength(1);
    const servicesOnly = { ...all, 'finance.vouchers.purchases': [purchase()] };
    expect((await misaAmisPreview(fake(servicesOnly).query, { kind: 'purchase_goods', ...range })).items).toEqual([]);
  });

  it('lists a sales and a cash voucher', async () => {
    const sales = await misaAmisPreview(fake({ ...all, 'finance.vouchers.sales': [sale()] }).query, { kind: 'sales', ...range, salesItemCode: 'BH' });
    expect(sales.items).toMatchObject([{ amisType: 13, total: '1080000' }]);
    const payment = await misaAmisPreview(fake({ ...all, 'finance.vouchers.cash': [cash()] }).query, { kind: 'cash_payment', ...range });
    expect(payment.items).toMatchObject([{ amisType: 4, reftype: 1020, reasonTypeId: 24, voucherNo: 'CRPC202600012', total: '500000', blockers: [] }]);
    expect(payment.purchasePurpose).toBe('1');
    const other = await misaAmisPreview(fake({ ...all, 'finance.vouchers.cash': [cash()] }).query, { kind: 'cash_payment', ...range, purchasePurpose: '3' });
    expect(other.purchasePurpose).toBe('3');
    // A blocked voucher still shows the choices it would be written with.
    const sales2 = await misaAmisPreview(fake({ ...all, 'finance.vouchers.sales': [sale()] }).query, { kind: 'sales', ...range });
    expect(sales2.items).toMatchObject([{ reftype: 3530, reasonTypeId: null, blockers: [{ code: 'item_code_unknown', lineNo: 1 }] }]);
  });

  it('says there are more when the loader was full, even if the kind keeps only a few of the documents', async () => {
    // 501 purchase documents loaded, none with a stock line: the goods preview lists nothing but must not claim the period is complete.
    const docs = Array.from({ length: MISA_AMIS_PREVIEW_LIMIT + 1 }, () => purchase());
    const result = await misaAmisPreview(fake({ ...all, 'finance.vouchers.purchases': docs }).query, { kind: 'purchase_goods', ...range });
    expect(result).toMatchObject({ items: [], vouchers: 0, more: true });
  });

  it('lists a cash voucher with a too long number instead of failing the preview', async () => {
    const long = { ...cash(), code: 'PC1234567890123' };
    const result = await misaAmisPreview(fake({ ...all, 'finance.vouchers.cash': [long, cash()] }).query, { kind: 'cash_payment', ...range });
    expect(result).toMatchObject({ vouchers: 2, ready: 1, blocked: 1 });
    expect(result.items[0]).toMatchObject({ voucherNo: 'PC1234567890123', blockers: [{ code: 'voucher_number_too_long', lineNo: null }] });
  });

  it('caps the blockers of one voucher, counts the rest, and the answer still passes the contract', async () => {
    // 1200 lines with no AMIS item chosen: 1200 blockers, one per line.
    const lines = Array.from({ length: 1200 }, (_, i) => ({ lineNo: i + 1, description: 'x', unit: null, quantity: null, unitPrice: null, amount: '1000', vatRate: '10%', debitAccount: '6422' }));
    const big = { ...purchase(), lines, vatAmount: '120000' };
    const result = await misaAmisPreview(fake({ ...all, 'finance.vouchers.purchases': [big] }).query, { kind: 'purchase_services', ...range });
    expect(result.items[0]?.blockers).toHaveLength(MISA_AMIS_PREVIEW_BLOCKERS);
    expect(result.items[0]?.blockersMore).toBe(1200 - MISA_AMIS_PREVIEW_BLOCKERS);
    expect(result).toMatchObject({ vouchers: 1, ready: 0, blocked: 1 });
    // The contract's own check of the output, as the route does it.
    expect(() => zMisaAmisPreview.parse(result)).not.toThrow();
  });

  it('keeps the first vouchers and says there are more when the period holds more than the list', async () => {
    const many = Array.from({ length: MISA_AMIS_PREVIEW_LIMIT + 1 }, () => cash());
    const result = await misaAmisPreview(fake({ ...all, 'finance.vouchers.cash': many }).query, { kind: 'cash_payment', ...range });
    expect(result.more).toBe(true);
    expect(result.items).toHaveLength(MISA_AMIS_PREVIEW_LIMIT);
    expect(result.vouchers).toBe(MISA_AMIS_PREVIEW_LIMIT);
  });
});
