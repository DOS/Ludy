// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AMIS_MAX_VOUCHER_LINES, AMIS_VOUCHER_TYPES, checkVoucher, toJsonText, type AmisVoucher } from '@crove/misa-amis';
import { accountParents } from '@crove/kernel-contract';
import {
  AMIS_PURCHASE_PURPOSES,
  cashAmisVouchers,
  derivedRefId,
  purchaseGoodsAmisVouchers,
  purchaseServiceAmisVouchers,
  salesAmisVouchers,
  type AmisContext,
  type AmisMapping,
} from '../src/misa-amis-vouchers.ts';
import type { CashVoucher, PurchaseVoucher, SalesVoucher } from '../src/misa.ts';

const SOURCE_ID = '0192F0A1-2B3C-7D4E-8F50-6172839A4B5D';
const ENTRY_ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c';
const BRANCH = 'b8868580-c5d7-49c2-993d-15824b3083f6';

const ctx = (overrides: Partial<AmisContext> = {}): AmisContext => ({
  branchId: BRANCH,
  purchasePurpose: '1',
  serviceItemCode: 'DV_CHUNG',
  salesItemCode: 'BH_CHUNG',
  defaultUnitName: 'Lần',
  partyCodes: null,
  itemCodes: null,
  ...overrides,
});

const cash = (overrides: Partial<CashVoucher> = {}): CashVoucher => ({
  sourceId: SOURCE_ID,
  type: 'cash_payment',
  code: 'PC00012',
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: '1111',
  party: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  personName: 'Nguyễn Văn An',
  description: 'Trả tiền hóa đơn tháng 9',
  lines: [
    { lineNo: 1, account: '331', amount: '1650000', memo: 'HĐ C26TAA/123' },
    { lineNo: 2, account: '6422', amount: '35000.5', memo: null },
  ],
  ...overrides,
});

const purchase = (overrides: Partial<PurchaseVoucher> = {}): PurchaseVoucher => ({
  sourceId: SOURCE_ID,
  entryId: ENTRY_ID,
  entryDate: '2026-09-30',
  description: 'Mua dịch vụ Công ty TNHH ABC HĐ C26TAA/123',
  invoice: { series: 'C26TAA', number: '123', date: '2026-09-29' },
  vendor: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  vatAmount: '180000',
  lines: [
    { lineNo: 1, description: 'Phí dịch vụ tháng 9', unit: 'Tháng', quantity: '1', unitPrice: '1000000', amount: '1000000', vatRate: '10%', debitAccount: '6422' },
    { lineNo: 2, description: 'Gói lưu trữ', unit: 'Gói', quantity: '2', unitPrice: '500000', amount: '1000000', vatRate: '10%', debitAccount: '6422' },
    { lineNo: 3, description: 'Chiết khấu thương mại', unit: null, quantity: null, unitPrice: null, amount: '-200000', vatRate: '10%', debitAccount: '6422' },
  ],
  ...overrides,
});

const sale = (overrides: Partial<SalesVoucher> = {}): SalesVoucher => ({
  sourceId: SOURCE_ID,
  entryId: ENTRY_ID,
  entryDate: '2026-10-05',
  description: 'Bán hàng Công ty CP XYZ HĐ C26TBB/45',
  invoice: { series: 'C26TBB', number: '45', date: '2026-10-05' },
  customer: { name: 'Công ty CP XYZ', taxCode: '0312345678', address: '2 Lê Lợi, TP.HCM' },
  receivableAccount: '131',
  vatAccount: '3331',
  vatAmount: '130000',
  lines: [
    { lineNo: 1, description: 'Tư vấn kế toán', unit: 'Tháng', quantity: '1', unitPrice: '1000000', amount: '1000000', vatRate: '8%', revenueAccount: '511' },
    { lineNo: 2, description: 'Phần mềm', unit: 'Bộ', quantity: '1', unitPrice: '500000', amount: '500000', vatRate: '10%', revenueAccount: '511' },
  ],
  ...overrides,
});

// What is sent, as the text MISA would receive, read back as data for the comparison.
const sent = (mapping: Pick<AmisMapping, 'vouchers'>): Array<Record<string, unknown>> => mapping.vouchers.map((v) => JSON.parse(toJsonText({ org_company_code: 'ludy-x', voucher: v })).voucher as Record<string, unknown>);
const only = (mapping: AmisMapping): AmisVoucher => {
  expect(mapping.blockers).toEqual([]);
  expect(mapping.vouchers).toHaveLength(1);
  const [v] = mapping.vouchers;
  if (!v) throw new Error('no voucher');
  return v;
};

describe('cash and bank vouchers', () => {
  it('writes a phiếu chi (voucher_type 4): Dr the line, Cr the cash account, reason "pay a supplier"', () => {
    const v = only(cashAmisVouchers(cash(), ctx()));
    checkVoucher(v);
    expect(sent({ vouchers: [v] })[0]).toEqual({
      voucher_type: 4,
      org_refid: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d',
      org_refno: 'CRPC202600012',
      branch_id: BRANCH,
      refdate: '2026-10-07',
      posted_date: '2026-10-07',
      reftype: 1020,
      reason_type_id: 24,
      currency_id: 'VND',
      exchange_rate: 1,
      total_amount_oc: 1685000.5,
      total_amount: 1685000.5,
      journal_memo: 'Trả tiền hóa đơn tháng 9',
      account_object_name: 'Công ty TNHH ABC',
      account_object_address: '1 Láng Hạ, Hà Nội',
      account_object_tax_code: '0101234564',
      account_object_contact_name: 'Nguyễn Văn An',
      detail: [
        {
          sort_order: 1,
          amount_oc: 1650000,
          amount: 1650000,
          description: 'HĐ C26TAA/123',
          debit_account: '331',
          credit_account: '1111',
          account_object_name: 'Công ty TNHH ABC',
          account_object_address: '1 Láng Hạ, Hà Nội',
          account_object_tax_code: '0101234564',
          purchase_purpose_id: AMIS_PURCHASE_PURPOSES['1'],
          purchase_purpose_code: '1',
        },
        {
          sort_order: 2,
          amount_oc: 35000.5,
          amount: 35000.5,
          description: 'Trả tiền hóa đơn tháng 9',
          debit_account: '6422',
          credit_account: '1111',
          account_object_name: 'Công ty TNHH ABC',
          account_object_address: '1 Láng Hạ, Hà Nội',
          account_object_tax_code: '0101234564',
          purchase_purpose_id: AMIS_PURCHASE_PURPOSES['1'],
          purchase_purpose_code: '1',
        },
      ],
    });
  });

  // type, voucher_type, reftype, reason_type_id, debit account, credit account, carries a purchase purpose
  it.each([
    ['cash_receipt', AMIS_VOUCHER_TYPES.cashReceipt, 1010, undefined, '1111', '131', false],
    ['cash_payment', AMIS_VOUCHER_TYPES.cashPayment, 1020, 23, '6422', '1111', true],
    ['bank_credit', AMIS_VOUCHER_TYPES.bankCredit, 1500, 34, '1121', '711', false],
    ['bank_debit', AMIS_VOUCHER_TYPES.bankDebit, 1510, 43, '6422', '1121', true],
  ] as const)('%s: voucher_type %i, reftype %i, reason %s, Dr %s, Cr %s, purchase purpose %s', (type, voucherType, reftype, reason, debit, credit, purpose) => {
    const cashAccount = type.startsWith('cash') ? '1111' : '1121';
    // The line's own account is the one that is not the cash or bank account.
    const account = debit === cashAccount ? credit : debit;
    const [v] = sent(cashAmisVouchers(cash({ type, cashAccount, party: null, personName: null, lines: [{ lineNo: 1, account, amount: '100000', memo: null }] }), ctx()));
    expect(v).toMatchObject({ voucher_type: voucherType, reftype });
    expect(v?.reason_type_id).toBe(reason);
    const [line] = (v?.detail ?? []) as Array<Record<string, unknown>>;
    expect(line).toMatchObject({ debit_account: debit, credit_account: credit });
    expect('purchase_purpose_id' in (line ?? {})).toBe(purpose);
  });

  it('picks the reason from the accounts: 331 is a supplier (cash 24, bank 44), 131 a customer (bank 29)', () => {
    const bank = (type: 'bank_debit' | 'bank_credit', account: string) => sent(cashAmisVouchers(cash({ type, cashAccount: '1121', party: null, lines: [{ lineNo: 1, account, amount: '1', memo: null }] }), ctx()))[0]?.reason_type_id;
    expect(bank('bank_debit', '331')).toBe(44);
    expect(bank('bank_credit', '131')).toBe(29);
  });

  it('keeps an id in lower case and the same on every call', () => {
    expect(only(cashAmisVouchers(cash(), ctx())).org_refid).toBe(SOURCE_ID.toLowerCase());
    expect(only(cashAmisVouchers(cash(), ctx())).org_refid).toBe(only(cashAmisVouchers(cash(), ctx())).org_refid);
  });

  it('refuses a source id that is not a UUID instead of sending it', () => {
    expect(() => cashAmisVouchers(cash({ sourceId: 'not-a-uuid' }), ctx())).toThrow();
  });
});

describe('purchase vouchers', () => {
  it('writes the services voucher (17): reftype 330 for an unpaid purchase, Cr 331, VAT spread over the lines, a line with no quantity as one at its amount', () => {
    const v = only(purchaseServiceAmisVouchers(purchase(), ctx()));
    checkVoucher(v);
    const [data] = sent({ vouchers: [v] });
    expect(data).toMatchObject({
      voucher_type: 17,
      org_refid: SOURCE_ID.toLowerCase(),
      reftype: 330,
      include_invoice: 1,
      refdate: '2026-09-29',
      posted_date: '2026-09-30',
      total_sale_amount: 1800000,
      total_vat_amount: 180000,
      total_amount: 1980000,
      total_discount_amount: 0,
    });
    const detail = data?.detail as Array<Record<string, unknown>>;
    expect(detail).toHaveLength(3);
    expect(detail[0]).toMatchObject({
      sort_order: 1,
      inventory_item_code: 'DV_CHUNG',
      inventory_item_type: 2,
      debit_account: '6422',
      credit_account: '331',
      unit_name: 'Tháng',
      quantity: 1,
      unit_price: 1000000,
      amount: 1000000,
      vat_rate: 10,
      vat_account: '1331',
      inv_no: '123',
      inv_series: 'C26TAA',
      inv_date: '2026-09-29',
      purchase_purpose_id: AMIS_PURCHASE_PURPOSES['1'],
    });
    expect(detail[2]).toMatchObject({ unit_name: 'Lần', quantity: 1, unit_price: -200000, amount: -200000 });
    // The VAT of the lines adds up to the voucher's exactly.
    expect(detail.map((d) => d.vat_amount)).toEqual([100000, 100000, -20000]);
  });

  it('writes a goods voucher (18) of the lines on a stock account, under its own id, with the org\'s item and warehouse codes', () => {
    const goods = purchase({
      lines: [
        { lineNo: 1, description: 'Giấy A4', unit: 'Ram', quantity: '10', unitPrice: '60000', amount: '600000', vatRate: '10%', debitAccount: '1561' },
        { lineNo: 2, description: 'Phí vận chuyển', unit: null, quantity: null, unitPrice: null, amount: '50000', vatRate: '10%', debitAccount: '6422' },
      ],
      vatAmount: '65000',
    });
    const parents = accountParents([
      { code: '156', parentCode: null },
      { code: '1561', parentCode: '156' },
    ]);
    const saved = [{ accountCode: '156', itemCode: 'HH_VPP', warehouseCode: 'KHO1' }];
    const mapping = purchaseGoodsAmisVouchers(goods, saved, parents, ctx());
    const v = only(mapping);
    checkVoucher(v);
    // Only the stock line; the other goes to the services voucher, which keeps the document's id.
    expect(v.org_refid).toBe(derivedRefId(SOURCE_ID, 'purchase_goods'));
    expect(v.org_refid).not.toBe(only(purchaseServiceAmisVouchers(goods, ctx())).org_refid);
    const [data] = sent(mapping);
    expect(data).toMatchObject({ voucher_type: 18, reftype: 302, total_sale_amount: 600000 });
    const [line] = (data?.detail ?? []) as Array<Record<string, unknown>>;
    expect(line).toMatchObject({ inventory_item_code: 'HH_VPP', stock_code: 'KHO1', inventory_item_type: 0, quantity: 10, unit_price: 60000, debit_account: '1561', credit_account: '331' });
  });
});

describe('sales vouchers', () => {
  it('writes the sales voucher (13): reftype 3530, Dr 131, Cr revenue, output VAT on 3331', () => {
    const v = only(salesAmisVouchers(sale(), ctx()));
    checkVoucher(v);
    const [data] = sent({ vouchers: [v] });
    expect(data).toMatchObject({ voucher_type: 13, reftype: 3530, total_sale_amount: 1500000, total_vat_amount: 130000, total_amount: 1630000, is_sale_with_outward: false });
    const detail = data?.detail as Array<Record<string, unknown>>;
    expect(detail[0]).toMatchObject({
      inventory_item_code: 'BH_CHUNG',
      debit_account: '131',
      credit_account: '511',
      vat_rate: 8,
      vat_amount: 80000,
      vat_account: '3331',
      exchange_rate_operator: '*',
      main_convert_rate: 1,
    });
    expect(detail[1]).toMatchObject({ vat_rate: 10, vat_amount: 50000 });
  });
});

describe('blockers: what AMIS needs that was not given', () => {
  it('names a missing branch for every kind, and writes nothing', () => {
    const noBranch = ctx({ branchId: null });
    for (const mapping of [cashAmisVouchers(cash(), noBranch), purchaseServiceAmisVouchers(purchase(), noBranch), salesAmisVouchers(sale(), noBranch)]) {
      expect(mapping.vouchers).toEqual([]);
      expect(mapping.blockers).toContainEqual({ code: 'branch_missing', sourceId: SOURCE_ID, lineNo: null });
    }
  });

  it('names a party that several active catalogue entries carry apart from one the catalogue does not have (#4114): different fixes, both block, and a check that has none ambiguous changes nothing', () => {
    // 0101234564 is the party of the purchase and the cash voucher, 0312345678 the customer of the sale: the check found two active entries with each (ambiguous), and 9999999999 is matched.
    const ambiguous = ctx({ partyCodes: new Map([['9999999999', 'KH_KHAC']]), partyAmbiguous: new Set(['0101234564', '0312345678']) });
    const blocker = [{ code: 'party_code_ambiguous', sourceId: SOURCE_ID, lineNo: null }];
    expect(purchaseServiceAmisVouchers(purchase(), ambiguous).blockers).toEqual(blocker);
    expect(salesAmisVouchers(sale(), ambiguous).blockers).toEqual(blocker);
    expect(cashAmisVouchers(cash(), ambiguous).blockers).toEqual(blocker);
    // A party the check found none for (unknown), or whose tax code is not the ambiguous one, stays `party_code_unknown`.
    const elsewhere = ctx({ partyCodes: new Map([['9999999999', 'KH_KHAC']]), partyAmbiguous: new Set(['0555555555']) });
    expect(purchaseServiceAmisVouchers(purchase(), elsewhere).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ partyCodes: new Map([['9999999999', 'KH_KHAC']]), partyAmbiguous: null })).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    // A matched party is not blocked, ambiguous set or not; with no check read nothing is blocked either.
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ partyCodes: new Map([['0101234564', 'NCC_ABC']]), partyAmbiguous: new Set(['0101234564']) })).blockers).toEqual([]);
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ partyCodes: null, partyAmbiguous: new Set(['0101234564']) })).blockers).toEqual([]);
  });

  it('names a party the dictionary does not have, but does not block when the dictionary was not read', () => {
    const known = ctx({ partyCodes: new Map([['9999999999', 'KH_KHAC']]) });
    expect(purchaseServiceAmisVouchers(purchase(), known).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    expect(salesAmisVouchers(sale(), known).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    expect(cashAmisVouchers(cash(), known).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ partyCodes: null })).blockers).toEqual([]);
    const match = ctx({ partyCodes: new Map([['0101234564', 'NCC_ABC']]) });
    const [data] = sent(purchaseServiceAmisVouchers(purchase(), match));
    expect(data).toMatchObject({ account_object_code: 'NCC_ABC' });
  });

  it('looks a party up by the digits of its tax code: a formatted one on the voucher is found, one that is not 10 or 13 digits is as unknown as one the catalogue lacks', () => {
    const matched = ctx({ partyCodes: new Map([['0101234564', 'NCC_ABC']]) });
    const formatted = purchase({ vendor: { name: 'Công ty TNHH ABC', taxCode: '0101.234.564', address: null } });
    expect(purchaseServiceAmisVouchers(formatted, matched).blockers).toEqual([]);
    const broken = purchase({ vendor: { name: 'Công ty TNHH ABC', taxCode: '12345', address: null } });
    expect(purchaseServiceAmisVouchers(broken, matched).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    // Without a check nothing is judged, so the same broken code is no blocker.
    expect(purchaseServiceAmisVouchers(broken, ctx({ partyCodes: null })).blockers).toEqual([]);
  });

  it('blocks a party with no tax code once a check is done (nothing to match it on until S3b), and sends it by name as before while no check is done', () => {
    const person = purchase({ vendor: { name: 'Nguyễn Văn A', taxCode: null, address: null } });
    const checked = ctx({ partyCodes: new Map([['0101234564', 'NCC_ABC']]) });
    expect(purchaseServiceAmisVouchers(person, checked).blockers).toEqual([{ code: 'party_code_unknown', sourceId: SOURCE_ID, lineNo: null }]);
    expect(purchaseServiceAmisVouchers(person, ctx({ partyCodes: null })).blockers).toEqual([]);
  });

  it('names an item code the catalogue does not have, by line, once a check is done; with no check it judges nothing', () => {
    const checked = ctx({ itemCodes: new Set(['KHAC']) });
    expect(purchaseServiceAmisVouchers(purchase(), checked).blockers.map((b) => [b.code, b.lineNo])).toEqual([
      ['item_code_unknown', 1],
      ['item_code_unknown', 2],
      ['item_code_unknown', 3],
    ]);
    expect(salesAmisVouchers(sale(), checked).blockers.map((b) => b.code)).toEqual(['item_code_unknown', 'item_code_unknown']);
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ itemCodes: new Set(['DV_CHUNG']) })).blockers).toEqual([]);
    expect(salesAmisVouchers(sale(), ctx({ itemCodes: new Set(['BH_CHUNG']) })).blockers).toEqual([]);
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ itemCodes: null })).blockers).toEqual([]);
  });

  it('names a saved goods item code the catalogue does not have', () => {
    const goods = purchaseGoodsAmisVouchers(
      {
        ...purchase(),
        vatAmount: '60000',
        lines: [{ lineNo: 1, description: 'Giấy A4', unit: 'Ram', quantity: '10', unitPrice: '60000', amount: '600000', vatRate: '10%', debitAccount: '1561' }],
      },
      [{ accountCode: '156', itemCode: 'HH_VPP', warehouseCode: 'KHO1' }],
      accountParents([
        { code: '156', parentCode: null },
        { code: '1561', parentCode: '156' },
      ]),
      ctx({ itemCodes: new Set(['DV_CHUNG']) }),
    );
    expect(goods.blockers).toEqual([{ code: 'item_code_unknown', sourceId: SOURCE_ID, lineNo: 1 }]);
  });

  it('names a VAT rate AMIS cannot take, by line', () => {
    const mapping = purchaseServiceAmisVouchers(purchase({ lines: [{ lineNo: 7, description: 'x', unit: null, quantity: null, unitPrice: null, amount: '100', vatRate: null, debitAccount: '6422' }], vatAmount: '0' }), ctx());
    expect(mapping.blockers).toEqual([{ code: 'vat_rate_unmapped', sourceId: SOURCE_ID, lineNo: 7 }]);
  });

  it('names a missing item code, by line', () => {
    expect(purchaseServiceAmisVouchers(purchase(), ctx({ serviceItemCode: null })).blockers.map((b) => [b.code, b.lineNo])).toEqual([
      ['item_code_unknown', 1],
      ['item_code_unknown', 2],
      ['item_code_unknown', 3],
    ]);
    expect(salesAmisVouchers(sale(), ctx({ salesItemCode: null })).blockers).toHaveLength(2);
  });

  it('names a voucher with no line', () => {
    expect(cashAmisVouchers(cash({ lines: [] }), ctx()).blockers).toContainEqual({ code: 'no_lines', sourceId: SOURCE_ID, lineNo: null });
  });
});

describe('size and exactness', () => {
  const many = (n: number): CashVoucher => cash({ lines: Array.from({ length: n }, (_, i) => ({ lineNo: i + 1, account: '6422', amount: '1000.1234', memo: null })) });

  it('splits a voucher of more than 500 lines into parts of at most 500, each with its own stable id, the first keeping the voucher\'s', () => {
    const mapping = cashAmisVouchers(many(AMIS_MAX_VOUCHER_LINES * 2 + 1), ctx());
    expect(mapping.vouchers.map((v) => v.detail.length)).toEqual([500, 500, 1]);
    const ids = mapping.vouchers.map((v) => v.org_refid);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe(SOURCE_ID.toLowerCase());
    expect(cashAmisVouchers(many(AMIS_MAX_VOUCHER_LINES * 2 + 1), ctx()).vouchers.map((v) => v.org_refid)).toEqual(ids);
    expect(mapping.vouchers.map((v) => v.org_refno)).toEqual(['CRPC202600012', 'CRPC202600012/2', 'CRPC202600012/3']);
    // The parts' totals add up to the voucher's.
    const totals = sent(mapping).map((v) => v.total_amount);
    expect(totals).toEqual([500061.7, 500061.7, 1000.1234]);
    for (const v of mapping.vouchers) checkVoucher(v);
  });

  it('writes an amount a JS number would round exactly as it is', () => {
    const v = only(cashAmisVouchers(cash({ lines: [{ lineNo: 1, account: '6422', amount: '9007199254740993.1234', memo: null }] }), ctx()));
    const text = toJsonText({ org_company_code: 'x', voucher: v });
    expect(text).toContain('"amount":9007199254740993.1234');
    expect(text).toContain('"total_amount":9007199254740993.1234');
  });

  it('is deterministic: a derived id is a UUID and the same for the same input', () => {
    expect(derivedRefId(SOURCE_ID, 'a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedRefId(SOURCE_ID, 'a')).toBe(derivedRefId(SOURCE_ID.toLowerCase(), 'a'));
    expect(derivedRefId(SOURCE_ID, 'a')).not.toBe(derivedRefId(SOURCE_ID, 'b'));
  });
});

// The fields AMISKT marks required (x) in the voucher structure tables, for those Ludy writes itself. The fields that are an alternative to a code (an id next to a code, a name
// next to an id) and the warehouse of a sales line are left out; the warehouse is listed as unconfirmed in docs/integrations/misa-amis-api.md.
const REQUIRED: Record<string, { header: string[]; detail: string[] }> = {
  cash_payment: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'branch_id', 'reason_type_id', 'refdate', 'reftype', 'posted_date', 'exchange_rate', 'total_amount_oc', 'total_amount'],
    detail: ['sort_order', 'amount_oc', 'amount', 'debit_account', 'credit_account', 'purchase_purpose_id'],
  },
  cash_receipt: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'branch_id', 'refdate', 'reftype', 'posted_date'],
    detail: ['sort_order', 'amount_oc', 'amount', 'debit_account', 'credit_account'],
  },
  bank_debit: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'branch_id', 'posted_date', 'reason_type_id', 'refdate', 'reftype', 'exchange_rate', 'total_amount_oc', 'total_amount'],
    detail: ['sort_order', 'amount_oc', 'amount', 'debit_account', 'credit_account', 'purchase_purpose_id'],
  },
  bank_credit: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'branch_id', 'posted_date', 'reason_type_id', 'refdate', 'reftype', 'exchange_rate', 'total_amount', 'total_amount_oc'],
    detail: ['amount', 'amount_oc', 'credit_account', 'debit_account', 'description', 'sort_order'],
  },
  purchase_services: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'reftype', 'branch_id', 'include_invoice', 'total_sale_amount_oc', 'total_sale_amount', 'total_amount_oc', 'total_amount', 'total_discount_amount_oc', 'total_discount_amount', 'total_vat_amount_oc', 'total_vat_amount'],
    detail: ['amount', 'amount_oc', 'credit_account', 'debit_account', 'description', 'inventory_item_code', 'inventory_item_name', 'inventory_item_type', 'purchase_purpose_id', 'quantity', 'sort_order', 'unit_name', 'unit_price'],
  },
  purchase_goods: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'reftype', 'posted_date', 'refdate', 'branch_id', 'currency_id', 'exchange_rate', 'total_sale_amount_oc', 'total_sale_amount', 'total_amount_oc', 'total_amount', 'total_discount_amount_oc', 'total_discount_amount', 'total_vat_amount_oc', 'total_vat_amount'],
    detail: ['inventory_item_code', 'inventory_item_name', 'inventory_item_type', 'purchase_purpose_id', 'sort_order', 'quantity', 'unit_price', 'amount_oc', 'amount', 'description', 'stock_code', 'debit_account', 'credit_account', 'main_convert_rate', 'main_quantity', 'main_unit_name', 'unit_name', 'inventory_resale_type_id'],
  },
  sales: {
    header: ['voucher_type', 'org_refid', 'org_refno', 'branch_id', 'is_sale_with_outward', 'posted_date', 'refdate', 'reftype', 'total_sale_amount_oc', 'total_sale_amount', 'total_amount_oc', 'total_amount', 'total_discount_amount_oc', 'total_discount_amount', 'total_vat_amount_oc', 'total_vat_amount'],
    detail: ['credit_account', 'exchange_rate_operator', 'inventory_item_code', 'inventory_item_name', 'description', 'inventory_item_type', 'debit_account', 'unit_name', 'main_unit_name', 'main_unit_price', 'main_quantity', 'quantity', 'unit_price', 'amount_oc', 'amount', 'discount_rate', 'discount_amount_oc', 'discount_amount', 'vat_amount_oc', 'vat_amount', 'main_convert_rate', 'sort_order'],
  },
};

const GOODS_PARENTS = accountParents([
  { code: '156', parentCode: null },
  { code: '1561', parentCode: '156' },
]);
const goodsPurchase = (): PurchaseVoucher =>
  purchase({
    lines: [{ lineNo: 1, description: 'Giấy A4', unit: 'Ram', quantity: '10', unitPrice: '60000', amount: '600000', vatRate: '10%', debitAccount: '1561' }],
    vatAmount: '60000',
  });

describe('every field AMISKT marks required is written', () => {
  const mappings: Array<[string, AmisMapping]> = [
    ['cash_payment', cashAmisVouchers(cash(), ctx())],
    ['cash_receipt', cashAmisVouchers(cash({ type: 'cash_receipt', cashAccount: '1111', lines: [{ lineNo: 1, account: '131', amount: '1', memo: null }] }), ctx())],
    ['bank_debit', cashAmisVouchers(cash({ type: 'bank_debit', cashAccount: '1121' }), ctx())],
    ['bank_credit', cashAmisVouchers(cash({ type: 'bank_credit', cashAccount: '1121', lines: [{ lineNo: 1, account: '131', amount: '1', memo: null }] }), ctx())],
    ['purchase_services', purchaseServiceAmisVouchers(purchase(), ctx())],
    ['purchase_goods', purchaseGoodsAmisVouchers(goodsPurchase(), [{ accountCode: '156', itemCode: 'HH_VPP', warehouseCode: 'KHO1' }], GOODS_PARENTS, ctx())],
    ['sales', salesAmisVouchers(sale(), ctx())],
  ];
  it.each(mappings)('%s', (kind, mapping) => {
    const [v] = sent(mapping);
    const need = REQUIRED[kind];
    if (!need || !v) throw new Error(`no voucher or no list for ${kind}`);
    // A required field is present and not null.
    for (const field of need.header) expect(v[field], `${kind} header ${field}`).not.toBeUndefined();
    for (const field of need.header) expect(v[field], `${kind} header ${field}`).not.toBeNull();
    for (const line of v.detail as Array<Record<string, unknown>>) {
      for (const field of need.detail) {
        expect(line[field], `${kind} detail ${field}`).not.toBeUndefined();
        expect(line[field], `${kind} detail ${field}`).not.toBeNull();
      }
    }
  });
});

describe('what the reviewer found', () => {
  it('writes the invoice on a sales voucher and the item name on a purchase line', () => {
    const [sales] = sent(salesAmisVouchers(sale(), ctx()));
    expect(sales).toMatchObject({ inv_no: '45', inv_series: 'C26TBB', inv_date: '2026-10-05' });
    const [services] = sent(purchaseServiceAmisVouchers(purchase(), ctx()));
    expect(((services?.detail ?? []) as Array<Record<string, unknown>>)[0]).toMatchObject({ inventory_item_name: 'Phí dịch vụ tháng 9' });
  });

  it('blocks a goods line whose saved row has no warehouse, instead of writing a null stock_code', () => {
    const mapping = purchaseGoodsAmisVouchers(goodsPurchase(), [{ accountCode: '156', itemCode: 'HH_VPP', warehouseCode: null }], GOODS_PARENTS, ctx());
    expect(mapping.vouchers).toEqual([]);
    expect(mapping.blockers).toEqual([{ code: 'stock_missing', sourceId: SOURCE_ID, lineNo: 1 }]);
  });

  // F3 of the S3a review (#3902): "/N" is added to a split voucher's number after cashVoucherNo checked its 20 characters, so the FINAL number of every part is checked.
  describe('the final number of a split voucher (20 characters at most)', () => {
    const manyLines = (code: string, n: number): CashVoucher =>
      cash({ code, lines: Array.from({ length: n }, (_, i) => ({ lineNo: i + 1, account: '6422', amount: '1000', memo: null })) });
    it('blocks a 19 character number that a split would take to 21', () => {
      const mapping = cashAmisVouchers(manyLines('PC12345678901', AMIS_MAX_VOUCHER_LINES + 1), ctx());
      expect(mapping.voucherNo).toHaveLength(19);
      expect(mapping.vouchers).toEqual([]);
      expect(mapping.blockers).toEqual([{ code: 'voucher_number_too_long', sourceId: SOURCE_ID, lineNo: null }]);
    });
    it('blocks a 20 character number that a split would take to 22', () => {
      const mapping = cashAmisVouchers(manyLines('PC123456789012', AMIS_MAX_VOUCHER_LINES + 1), ctx());
      expect(mapping.voucherNo).toHaveLength(20);
      expect(mapping.vouchers).toEqual([]);
      expect(mapping.blockers).toEqual([{ code: 'voucher_number_too_long', sourceId: SOURCE_ID, lineNo: null }]);
    });
    it('keeps a 19 and a 20 character number that is not split, and an 18 character one whose "/2" reaches 20', () => {
      expect(cashAmisVouchers(manyLines('PC12345678901', 1), ctx()).vouchers.map((v) => v.org_refno)).toEqual(['CRPC' + '2026' + '12345678901']);
      const twenty = cashAmisVouchers(manyLines('PC123456789012', 1), ctx());
      expect(twenty.blockers).toEqual([]);
      expect(String(twenty.vouchers[0]?.org_refno)).toHaveLength(20);
      const split = cashAmisVouchers(manyLines('PC1234567890', AMIS_MAX_VOUCHER_LINES + 1), ctx());
      expect(split.blockers).toEqual([]);
      expect(split.vouchers.map((v) => String(v.org_refno).length)).toEqual([18, 20]);
    });
  });

  it('lists a cash voucher whose number is too long with a blocker instead of throwing', () => {
    const mapping = cashAmisVouchers(cash({ code: 'PC1234567890123' }), ctx());
    expect(mapping.vouchers).toEqual([]);
    expect(mapping.blockers).toEqual([{ code: 'voucher_number_too_long', sourceId: SOURCE_ID, lineNo: null }]);
    expect(mapping).toMatchObject({ voucherNo: 'PC1234567890123', amisType: 4, reftype: 1020 });
  });

  it('writes the VAT codes KCT, KKKNT and KHAC as -1, -2 and -3 with the other rate', () => {
    const line = (lineNo: number, vatRate: string) => ({ lineNo, description: 'x', unit: null, quantity: null, unitPrice: null, amount: '1000000', vatRate, revenueAccount: '511' });
    const mapping = salesAmisVouchers(sale({ lines: [line(1, 'KCT'), line(2, 'KKKNT'), line(3, 'KHAC:5.26%')], vatAmount: '52600' }), ctx());
    const detail = (sent(mapping)[0]?.detail ?? []) as Array<Record<string, unknown>>;
    expect(detail.map((d) => d.vat_rate)).toEqual([-1, -2, -3]);
    expect(detail[2]?.other_vat_rate).toBe(5.26);
    expect(detail.map((d) => d.vat_amount)).toEqual([0, 0, 52600]);
  });

  it('splits a purchase and a sale of more than 500 lines with the VAT adding up across the parts', () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({ lineNo: i + 1, description: 'x', unit: null, quantity: null, unitPrice: null, amount: '1000', vatRate: '10%', debitAccount: '6422' }));
    const bought = purchaseServiceAmisVouchers(purchase({ lines, vatAmount: '50100' }), ctx());
    expect(bought.vouchers.map((v) => v.detail.length)).toEqual([500, 1]);
    expect(sent(bought).map((v) => [v.total_vat_amount, v.total_amount])).toEqual([[50000, 550000], [100, 1100]]);
    expect(new Set(bought.vouchers.map((v) => v.org_refid)).size).toBe(2);
    const salesLines = lines.map((l) => ({ lineNo: l.lineNo, description: l.description, unit: null, quantity: null, unitPrice: null, amount: l.amount, vatRate: '10%', revenueAccount: '511' }));
    const sold = salesAmisVouchers(sale({ lines: salesLines, vatAmount: '50100' }), ctx());
    expect(sent(sold).map((v) => v.total_vat_amount)).toEqual([50000, 100]);
  });
});
