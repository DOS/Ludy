// SPDX-License-Identifier: AGPL-3.0-only
// What the AMIS voucher mapper writes, against the voucher structures of the MISA ASP document (#4103, S1). ASP's structures are a subset of AMIS's and the mapper was written from AMIS's tables, so this pins, per
// kind, two lists that must be read by whoever builds the ASP push: the keys the mapper writes that ASP's structure does not list (probably ignored; unconfirmed until the sandbox check), and the fields ASP marks
// required that the mapper does not write (ids of catalogue entries, which only the read-only catalogue of S3 can give). A change either way fails here and has to be decided, not slip through. The field lists are
// names only, read from the first-party document V1.0.0 on 2026-11-19 (fixtures/asp-voucher-fields.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AMIS_VOUCHER_TYPES, toJsonText } from '@ludy/misa-amis';
import { accountParents } from '@ludy/kernel-contract';
import { cashAmisVouchers, purchaseGoodsAmisVouchers, purchaseServiceAmisVouchers, salesAmisVouchers, type AmisContext, type AmisMapping } from '../src/misa-amis-vouchers.ts';
import type { CashVoucher, PurchaseVoucher, SalesVoucher } from '../src/misa.ts';

interface Structure {
  header: { all: string[]; required: string[] };
  detail: { all: string[]; required: string[] };
}
const ASP = (JSON.parse(readFileSync(new URL('./fixtures/asp-voucher-fields.json', import.meta.url), 'utf8')) as { voucherTypes: Record<string, Structure> }).voucherTypes;

const SOURCE_ID = '0192F0A1-2B3C-7D4E-8F50-6172839A4B5D';
const ENTRY_ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c';
const ctx: AmisContext = { branchId: 'b8868580-c5d7-49c2-993d-15824b3083f6', purchasePurpose: '1', serviceItemCode: 'DV_CHUNG', salesItemCode: 'BH_CHUNG', defaultUnitName: 'Lần', partyCodes: null };

const cash = (type: CashVoucher['type']): CashVoucher => ({
  sourceId: SOURCE_ID,
  type,
  code: 'PC00012',
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: type.startsWith('bank') ? '1121' : '1111',
  party: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  personName: 'Nguyễn Văn An',
  description: 'Trả tiền hóa đơn tháng 9',
  lines: [{ lineNo: 1, account: '331', amount: '100', memo: null }],
});
const purchase: PurchaseVoucher = {
  sourceId: SOURCE_ID,
  entryId: ENTRY_ID,
  entryDate: '2026-09-30',
  description: 'Mua dịch vụ Công ty TNHH ABC HĐ C26TAA/123',
  invoice: { series: 'C26TAA', number: '123', date: '2026-09-29' },
  vendor: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  vatAmount: '10',
  lines: [{ lineNo: 1, description: 'Phí dịch vụ', unit: 'Tháng', quantity: '1', unitPrice: '100', amount: '100', vatRate: '10%', debitAccount: '6422' }],
};
const goods: PurchaseVoucher = { ...purchase, vatAmount: '60000', lines: [{ lineNo: 1, description: 'Giấy A4', unit: 'Ram', quantity: '10', unitPrice: '60000', amount: '600000', vatRate: '10%', debitAccount: '1561' }] };
const sale: SalesVoucher = {
  sourceId: SOURCE_ID,
  entryId: ENTRY_ID,
  entryDate: '2026-10-05',
  description: 'Bán hàng Công ty CP XYZ HĐ C26TBB/45',
  invoice: { series: 'C26TBB', number: '45', date: '2026-10-05' },
  customer: { name: 'Công ty CP XYZ', taxCode: '0312345678', address: '2 Lê Lợi, TP.HCM' },
  receivableAccount: '131',
  vatAccount: '3331',
  vatAmount: '8',
  lines: [{ lineNo: 1, description: 'Tư vấn kế toán', unit: 'Tháng', quantity: '1', unitPrice: '100', amount: '100', vatRate: '8%', revenueAccount: '511' }],
};
const parents = accountParents([
  { code: '156', parentCode: null },
  { code: '1561', parentCode: '156' },
]);

const KINDS: Array<{ kind: string; voucherType: number; mapping: AmisMapping; extraHeader: string[]; extraDetail: string[]; unwrittenRequired: string[] }> = [
  {
    kind: 'bank_credit',
    voucherType: AMIS_VOUCHER_TYPES.bankCredit,
    mapping: cashAmisVouchers(cash('bank_credit'), ctx),
    extraHeader: ['account_object_contact_name', 'account_object_tax_code'],
    extraDetail: ['account_object_address', 'account_object_name', 'account_object_tax_code'],
    unwrittenRequired: [],
  },
  {
    kind: 'bank_debit',
    voucherType: AMIS_VOUCHER_TYPES.bankDebit,
    mapping: cashAmisVouchers(cash('bank_debit'), ctx),
    extraHeader: ['account_object_contact_name', 'account_object_tax_code'],
    extraDetail: ['account_object_address', 'account_object_name', 'account_object_tax_code'],
    unwrittenRequired: [],
  },
  {
    kind: 'cash_payment',
    voucherType: AMIS_VOUCHER_TYPES.cashPayment,
    mapping: cashAmisVouchers(cash('cash_payment'), ctx),
    extraHeader: ['account_object_tax_code'],
    extraDetail: ['account_object_address', 'account_object_tax_code'],
    unwrittenRequired: [],
  },
  {
    kind: 'cash_receipt',
    voucherType: AMIS_VOUCHER_TYPES.cashReceipt,
    mapping: cashAmisVouchers(cash('cash_receipt'), ctx),
    extraHeader: ['account_object_tax_code'],
    extraDetail: ['account_object_address', 'account_object_name', 'account_object_tax_code'],
    unwrittenRequired: [],
  },
  {
    kind: 'sales',
    voucherType: AMIS_VOUCHER_TYPES.sales,
    mapping: salesAmisVouchers(sale, ctx),
    extraHeader: [],
    extraDetail: ['exchange_rate_operator'],
    unwrittenRequired: ['inventory_item_id', 'main_unit_id', 'stock_code', 'stock_id', 'stock_name', 'unit_id'],
  },
  {
    kind: 'purchase_services',
    voucherType: AMIS_VOUCHER_TYPES.purchaseServices,
    mapping: purchaseServiceAmisVouchers(purchase, ctx),
    extraHeader: ['account_object_tax_code', 'refdate'],
    extraDetail: ['account_object_address', 'account_object_tax_code', 'purchase_purpose_code', 'tax_account_object_address', 'tax_account_object_name', 'tax_account_object_tax_code'],
    unwrittenRequired: ['inventory_item_id', 'unit_id'],
  },
  {
    kind: 'purchase_goods',
    voucherType: AMIS_VOUCHER_TYPES.purchaseGoods,
    mapping: purchaseGoodsAmisVouchers(goods, [{ accountCode: '156', itemCode: 'HH_VPP', warehouseCode: 'KHO1' }], parents, ctx),
    extraHeader: ['account_object_name', 'account_object_tax_code', 'include_invoice'],
    extraDetail: ['account_object_address', 'account_object_name', 'account_object_tax_code', 'inv_date', 'inv_no', 'inv_series', 'purchase_purpose_code', 'tax_account_object_address', 'tax_account_object_name', 'tax_account_object_tax_code'],
    unwrittenRequired: ['inventory_item_id', 'main_unit_id', 'stock_id', 'unit_id'],
  },
];

describe('the AMIS mapper against ASP voucher structures', () => {
  it('has the seven kinds Ludy pushes, each with the voucher_type AMIS gives it', () => {
    expect(Object.keys(ASP).sort((a, b) => Number(a) - Number(b))).toEqual(['1', '3', '4', '5', '13', '17', '18']);
    expect(KINDS.map((k) => k.voucherType).sort((a, b) => a - b)).toEqual(Object.values(AMIS_VOUCHER_TYPES).sort((a, b) => a - b));
  });

  it.each(KINDS)('$kind: the keys written that ASP does not list, and the fields ASP requires that are not written, are exactly the pinned lists', ({ kind, voucherType, mapping, extraHeader, extraDetail, unwrittenRequired }) => {
    expect(mapping.blockers, kind).toEqual([]);
    const [written] = mapping.vouchers.map((v) => JSON.parse(toJsonText({ voucher: v })).voucher as Record<string, unknown> & { detail: Array<Record<string, unknown>> });
    const structure = ASP[String(voucherType)];
    if (!written || !structure) throw new Error(`no voucher or structure for ${kind}`);
    const header = new Set(Object.keys(written).filter((k) => k !== 'detail'));
    const detail = new Set(written.detail.flatMap((line) => Object.keys(line)));
    // The mapper writes only flat keys: an object or a list in a header or a line would be a shape ASP's structure does not describe here.
    for (const value of Object.values(written)) if (value !== null && typeof value === 'object') expect(Array.isArray(value), kind).toBe(true);
    expect([...header].filter((k) => !structure.header.all.includes(k)).sort(), `${kind} header keys ASP does not list`).toEqual(extraHeader);
    expect([...detail].filter((k) => !structure.detail.all.includes(k)).sort(), `${kind} line keys ASP does not list`).toEqual(extraDetail);
    // ASP's required header fields are all written; the lines miss only what the catalogue has to give.
    expect(structure.header.required.filter((k) => !header.has(k)), `${kind} required header fields not written`).toEqual([]);
    expect(structure.detail.required.filter((k) => !detail.has(k)).sort(), `${kind} required line fields not written`).toEqual(unwrittenRequired);
  });
});
