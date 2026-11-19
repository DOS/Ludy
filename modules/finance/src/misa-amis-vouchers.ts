// SPDX-License-Identifier: AGPL-3.0-only
// Ludy's vouchers as the "đề nghị sinh chứng từ" MISA AMIS Kế toán takes (#3901, S3a of #3854). It reads the same voucher models and
// rows as the MISA SME export (misa.ts) and writes `AmisVoucher`s of @crove/misa-amis; nothing here sends anything, and nothing here
// calls MISA. Field names, required fields and enums are from the AMISKT v1.0.0 voucher structure tables (docs/integrations/misa-amis-api.md);
// none of it has run against a MISA sandbox yet.
//
// What Ludy cannot know goes in through `AmisContext` (the AMIS branch, the AMIS party codes read from get_dictionary). A voucher that
// needs one it was not given is NOT written: the result lists a blocker (a code, never a sentence), the preview shows it and the
// accounting coworker (S5) may explain it; the deterministic list decides.
//
// UNCONFIRMED (docs/integrations/misa-amis-api.md, "Unconfirmed, to check in the sandbox", under "How Ludy's vouchers map to AMIS"): three choices here are Ludy's own and
// have not run against a MISA sandbox: the purchase purpose defaults to 1, a bank payment is written as reftype 1510 (ủy nhiệm chi), and the reason_type_id of a cash or bank voucher
// is derived from its accounts (331 a supplier, 131 a customer). They are shown in the preview, nothing is pushed without a person approving it, and they are confirmed in the sandbox
// check before the push (S3b, #3902) is enabled for any org.
//
// Amounts are decimal strings, written as exact JSON numbers (`amisNumber`); arithmetic goes through decimal.js (@crove/l10n-vn).
import { createHash } from 'node:crypto';
import { PAYABLE_ACCOUNT, money, sum } from '@crove/l10n-vn';
import { AMIS_MAX_VOUCHER_LINES, AMIS_VOUCHER_TYPES, AmisNumber, amisNumber, type AmisVoucher } from '@crove/misa-amis';
import { isInflow, type AccountParents, type MisaGoodsCode } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import { canonical } from './domain/money.ts';
import {
  cashVoucherNo,
  goodsPurchaseRows,
  misaVoucherNo,
  salesRows,
  servicePurchaseRows,
  GOODS_PURCHASE_VOUCHER_PREFIX,
  PURCHASE_VOUCHER_PREFIX,
  SALES_VOUCHER_PREFIX,
  type CashVoucher,
  type MisaVatRate,
  type PurchaseRow,
  type PurchaseVoucher,
  type SalesVoucher,
  type VoucherParty,
} from './misa.ts';

// The five "mục đích mua vào" AMIS defines, with the GUIDs its documentation fixes for them (the same in every database).
export type AmisPurchasePurposeCode = '1' | '2' | '3' | '4' | '5';
// UNCONFIRMED default: 1 (see the top of this file). A person can pick another per batch.
export const AMIS_PURCHASE_PURPOSES: Readonly<Record<AmisPurchasePurposeCode, string>> = {
  '1': 'ed4bd91d-83ac-4a26-b4c1-4bce85faecb8',
  '2': 'd1609311-93aa-41c3-9d24-020bb6d47af5',
  '3': 'dcf4c47b-dd5b-4e2b-a524-4dbf6f815339',
  '4': '1145d797-1304-446a-8fe9-d8b94f4568e2',
  '5': 'c1c27910-be49-470e-a9de-f32321b9d12e',
};

// What a person or the dictionary supplies; Ludy never invents it.
export interface AmisContext {
  /** The AMIS branch (get_dictionary data_type 6). Every voucher kind needs one. */
  branchId: string | null;
  /** Default 1: dùng riêng cho SXKD chịu thuế GTGT. A person can pick another per batch. */
  purchasePurpose: AmisPurchasePurposeCode;
  /** The AMIS service item the purchase service lines go under, and the item the sales lines go under. */
  serviceItemCode: string | null;
  salesItemCode: string | null;
  /** A line with no unit of its own; AMIS requires one (a service is counted by occasion). */
  defaultUnitName: string;
  /** Party tax code -> the party's code in AMIS; null when the dictionary has not been read, which is not the same as "no match". */
  partyCodes: ReadonlyMap<string, string> | null;
}

export type AmisBlockerCode =
  | 'branch_missing'
  | 'party_code_unknown'
  | 'item_code_unknown'
  | 'stock_missing'
  | 'vat_rate_unmapped'
  | 'voucher_number_too_long'
  | 'no_lines';

export interface AmisBlocker {
  code: AmisBlockerCode;
  /** The purchase document's, sales document's or cash voucher's id. */
  sourceId: string;
  /** The voucher line it concerns; null for the voucher itself. */
  lineNo: number | null;
}

/** `vouchers` is empty when there is a blocker: nothing is half written. More than one voucher when the lines exceed AMIS's 500. */
export interface AmisMapping {
  /** Ludy's number of the voucher (the `org_refno` of its first part), the AMIS voucher_type, reftype and reason_type_id: known whether or not it can be written. */
  voucherNo: string;
  amisType: number;
  reftype: number;
  reasonTypeId: number | null;
  vouchers: AmisVoucher[];
  blockers: AmisBlocker[];
}

// ---------------------------------------------------------------------------------------------------------------
// Ids and splitting

const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable UUID derived from a source id and a tag (SHA-256 of both, formatted as a version 5 UUID): the same inputs always give the same id. */
export function derivedRefId(sourceId: string, tag: string): string {
  const h = createHash('sha256').update(`${sourceId.toLowerCase()}:${tag}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function refId(sourceId: string, tag: string | null): string {
  if (!UUID_V.test(sourceId)) throw new Error('A voucher source id must be a UUID');
  return tag === null ? sourceId.toLowerCase() : derivedRefId(sourceId, tag);
}

// The first part keeps the voucher's own id; a later part gets a derived one, and "/2" on its number.
function split<D>(
  detail: readonly D[],
  header: (part: number, lines: readonly D[]) => Record<string, unknown> & { voucher_type: number },
  baseRefId: string,
  sourceId: string,
  baseTag: string,
): AmisVoucher[] {
  const parts: AmisVoucher[] = [];
  for (let at = 0, part = 1; at < detail.length; at += AMIS_MAX_VOUCHER_LINES, part++) {
    const lines = detail.slice(at, at + AMIS_MAX_VOUCHER_LINES);
    const head = header(part, lines);
    parts.push({
      ...head,
      org_refid: part === 1 ? baseRefId : derivedRefId(sourceId, `${baseTag}:part${part}`),
      detail: lines,
    });
  }
  return parts;
}

const partNo = (no: string, part: number): string => (part === 1 ? no : `${no}/${part}`);

// ---------------------------------------------------------------------------------------------------------------
// Pieces

const num = (value: string) => amisNumber(canonical(money(value)));
const total = (values: readonly string[]) => canonical(sum(values.map((v) => money(v))));

// AMIS's vat_rate: 0, 5, 8, 10 as the rate itself, KCT -1, KKKNT -2, KHAC -3 (with other_vat_rate).
function vatFields(vat: MisaVatRate): Record<string, unknown> | null {
  switch (vat.code) {
    case '0':
    case '5':
    case '8':
    case '10':
      return { vat_rate: Number(vat.code) };
    case 'KCT':
      return { vat_rate: -1 };
    case 'KKKNT':
      return { vat_rate: -2 };
    case 'KHAC':
      return vat.otherRate === null ? null : { vat_rate: -3, other_vat_rate: amisNumber(vat.otherRate) };
    default:
      return null;
  }
}

/**
 * The AMIS party code of a party, by tax code; undefined when the dictionary says there is none; null when it was not read.
 * A party with no tax code (a private person) is also null: there is nothing to match on, so it is sent by name and address
 * without a code and is no blocker. Whether AMIS accepts that is UNCONFIRMED (see the top of this file).
 */
function partyCode(party: VoucherParty, ctx: AmisContext): string | null | undefined {
  if (ctx.partyCodes === null || party.taxCode === null) return null;
  return ctx.partyCodes.get(party.taxCode);
}

function partyFields(prefix: 'account_object' | 'tax_account_object', party: VoucherParty, code: string | null | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [`${prefix}_name`]: party.name,
    [`${prefix}_address`]: party.address,
    [`${prefix}_tax_code`]: party.taxCode,
  };
  if (typeof code === 'string') fields[`${prefix}_code`] = code;
  return fields;
}

/** The lines and the total payable (VAT included) of the vouchers a mapping wrote: what a preview shows without opening them. */
export function amisTotals(vouchers: readonly AmisVoucher[]): { lines: number; total: string } {
  const amounts = vouchers.map((v) => (v.total_amount instanceof AmisNumber ? v.total_amount.text : '0'));
  return { lines: vouchers.reduce((n, v) => n + v.detail.length, 0), total: total(amounts) };
}

interface Meta {
  voucherNo: string;
  amisType: number;
  /** AMIS's reftype and reason_type_id of the voucher: what a preview shows, because they are Ludy's choices (see UNCONFIRMED below). */
  reftype: number;
  reasonTypeId: number | null;
}
const blocked = (meta: Meta, blockers: AmisBlocker[]): AmisMapping => ({ ...meta, vouchers: [], blockers });
// MISA takes at most 20 characters in a voucher number (org_refno). The number of a split voucher gets "/N" after the number was checked (partNo), so the FINAL number of every part is checked here (#3902,
// F3 of the S3a review): a part over the limit makes the voucher blocked as a whole, and the number is never cut.
export const AMIS_REFNO_MAX = 20;
const done = (meta: Meta, vouchers: AmisVoucher[], sourceId: string): AmisMapping =>
  vouchers.some((v) => typeof v.org_refno !== 'string' || v.org_refno.length > AMIS_REFNO_MAX)
    ? blocked(meta, [{ code: 'voucher_number_too_long', sourceId, lineNo: null }])
    : { ...meta, vouchers, blockers: [] };

// ---------------------------------------------------------------------------------------------------------------
// Cash and bank vouchers: 5 Phiếu thu, 4 Phiếu chi, 1 Thu tiền gửi (báo Có), 3 Chi tiền gửi (báo Nợ)

// reason_type_id (AMIS enums): a payment to a supplier (331) or a deposit that collects a customer (131), else "other".
const CASH_PAYMENT_REASON = { supplier: 24, other: 23 } as const;
const BANK_WITHDRAW_REASON = { supplierNoInvoice: 44, other: 43 } as const;
const BANK_DEPOSIT_REASON = { customer: 29, other: 34 } as const;

const startsWith = (account: string, root: string): boolean => account === root || account.startsWith(root);

export function cashAmisVouchers(voucher: CashVoucher, ctx: AmisContext): AmisMapping {
  const inflow = isInflow(voucher.type);
  const fromSupplier = voucher.lines.some((l) => startsWith(l.account, PAYABLE_ACCOUNT));
  const fromCustomer = voucher.lines.some((l) => startsWith(l.account, '131'));
  const kind = {
    cash_receipt: { type: AMIS_VOUCHER_TYPES.cashReceipt, reftype: 1010, reason: null },
    cash_payment: { type: AMIS_VOUCHER_TYPES.cashPayment, reftype: 1020, reason: fromSupplier ? CASH_PAYMENT_REASON.supplier : CASH_PAYMENT_REASON.other },
    bank_credit: { type: AMIS_VOUCHER_TYPES.bankCredit, reftype: 1500, reason: fromCustomer ? BANK_DEPOSIT_REASON.customer : BANK_DEPOSIT_REASON.other },
    // 1510 Ủy nhiệm chi: Ludy has no cheque kind (UNCONFIRMED, see the top of this file).
    bank_debit: { type: AMIS_VOUCHER_TYPES.bankDebit, reftype: 1510, reason: fromSupplier ? BANK_WITHDRAW_REASON.supplierNoInvoice : BANK_WITHDRAW_REASON.other },
  }[voucher.type];
  let no: string;
  try {
    no = cashVoucherNo(voucher);
  } catch (error) {
    // The number is over MISA's 20 characters and is never cut (cashVoucherNo): a blocker on the voucher, not a failed preview.
    if (!(error instanceof DomainError)) throw error;
    const long = { voucherNo: voucher.code, amisType: kind.type, reftype: kind.reftype, reasonTypeId: kind.reason };
    return blocked(long, [{ code: 'voucher_number_too_long', sourceId: voucher.sourceId, lineNo: null }]);
  }
  const meta = { voucherNo: no, amisType: kind.type, reftype: kind.reftype, reasonTypeId: kind.reason };
  const blockers: AmisBlocker[] = [];
  if (ctx.branchId === null) blockers.push({ code: 'branch_missing', sourceId: voucher.sourceId, lineNo: null });
  if (voucher.lines.length === 0) blockers.push({ code: 'no_lines', sourceId: voucher.sourceId, lineNo: null });
  const code = voucher.party ? partyCode(voucher.party, ctx) : null;
  if (voucher.party && code === undefined) blockers.push({ code: 'party_code_unknown', sourceId: voucher.sourceId, lineNo: null });
  if (blockers.length > 0) return blocked(meta, blockers);

  const needsPurpose = voucher.type === 'cash_payment' || voucher.type === 'bank_debit';
  const detail = voucher.lines.map((line, i) => ({
    sort_order: i + 1,
    amount_oc: num(line.amount),
    amount: num(line.amount),
    description: line.memo ?? voucher.description,
    debit_account: inflow ? voucher.cashAccount : line.account,
    credit_account: inflow ? line.account : voucher.cashAccount,
    ...(voucher.party ? partyFields('account_object', voucher.party, code) : {}),
    ...(needsPurpose ? { purchase_purpose_id: AMIS_PURCHASE_PURPOSES[ctx.purchasePurpose], purchase_purpose_code: ctx.purchasePurpose } : {}),
  }));
  const vouchers = split(
    detail,
    (part, lines) => ({
      voucher_type: kind.type,
      org_refno: partNo(no, part),
      branch_id: ctx.branchId,
      refdate: voucher.date,
      posted_date: voucher.date,
      reftype: kind.reftype,
      ...(kind.reason === null ? {} : { reason_type_id: kind.reason }),
      currency_id: 'VND',
      exchange_rate: 1,
      total_amount_oc: amisNumber(total(lines.map((l) => l.amount.text))),
      total_amount: amisNumber(total(lines.map((l) => l.amount.text))),
      journal_memo: voucher.description,
      ...(voucher.party ? partyFields('account_object', voucher.party, code) : {}),
      account_object_contact_name: voucher.personName,
    }),
    refId(voucher.sourceId, null),
    voucher.sourceId,
    'cash',
  );
  return done(meta, vouchers, voucher.sourceId);
}

// ---------------------------------------------------------------------------------------------------------------
// Purchases: 17 Mua dịch vụ (the lines off a stock account), 18 Mua hàng nhập kho (the lines on one). Ludy books a purchase on 331
// (unpaid): AMIS reftype 330 for services, 302 for goods.

function purchaseBlockers<R extends PurchaseRow>(voucher: PurchaseVoucher, rows: readonly R[], ctx: AmisContext, itemCode: (row: R) => string | null): AmisBlocker[] {
  const blockers: AmisBlocker[] = [];
  const at = (code: AmisBlockerCode, lineNo: number | null) => blockers.push({ code, sourceId: voucher.sourceId, lineNo });
  if (ctx.branchId === null) at('branch_missing', null);
  if (rows.length === 0) at('no_lines', null);
  if (partyCode(voucher.vendor, ctx) === undefined) at('party_code_unknown', null);
  for (const row of rows) {
    if (vatFields(row.vat) === null) at('vat_rate_unmapped', row.line.lineNo);
    if (itemCode(row) === null) at('item_code_unknown', row.line.lineNo);
  }
  return blockers;
}

function purchaseDetail<R extends PurchaseRow>(
  rows: readonly R[],
  ctx: AmisContext,
  code: string | null | undefined,
  itemCode: (row: R) => string,
  extra: (row: R) => Record<string, unknown>,
) {
  return rows.map((row, i) => {
    const { line, voucher } = row;
    // A line without a quantity or a unit price is one occasion at the line's amount (AMIS requires both).
    const quantity = line.quantity ?? '1';
    const unitPrice = line.unitPrice ?? line.amount;
    return {
      sort_order: i + 1,
      inventory_item_code: itemCode(row),
      inventory_item_name: line.description,
      description: line.description,
      debit_account: line.debitAccount,
      credit_account: PAYABLE_ACCOUNT,
      unit_name: line.unit ?? ctx.defaultUnitName,
      quantity: num(quantity),
      unit_price: num(unitPrice),
      amount_oc: num(line.amount),
      amount: num(line.amount),
      ...vatFields(row.vat),
      vat_amount_oc: num(row.vatAmount),
      vat_amount: num(row.vatAmount),
      vat_account: row.vatAccount,
      inv_no: voucher.invoice.number,
      inv_series: voucher.invoice.series,
      inv_date: voucher.invoice.date,
      purchase_purpose_id: AMIS_PURCHASE_PURPOSES[ctx.purchasePurpose],
      purchase_purpose_code: ctx.purchasePurpose,
      ...partyFields('account_object', voucher.vendor, code),
      ...partyFields('tax_account_object', voucher.vendor, code),
      ...extra(row),
    };
  });
}

function purchaseHeader(lines: ReadonlyArray<{ amount: { text: string }; vat_amount: { text: string } }>) {
  const sale = total(lines.map((l) => l.amount.text));
  const vat = total(lines.map((l) => l.vat_amount.text));
  const all = canonical(money(sale).plus(money(vat)));
  return {
    total_sale_amount_oc: amisNumber(sale),
    total_sale_amount: amisNumber(sale),
    total_discount_amount_oc: 0,
    total_discount_amount: 0,
    total_vat_amount_oc: amisNumber(vat),
    total_vat_amount: amisNumber(vat),
    total_amount_oc: amisNumber(all),
    total_amount: amisNumber(all),
  };
}

export function purchaseServiceAmisVouchers(voucher: PurchaseVoucher, ctx: AmisContext): AmisMapping {
  const no = misaVoucherNo(PURCHASE_VOUCHER_PREFIX, voucher.entryId);
  const meta = { voucherNo: no, amisType: AMIS_VOUCHER_TYPES.purchaseServices, reftype: 330, reasonTypeId: null };
  const rows = servicePurchaseRows(voucher);
  const blockers = purchaseBlockers(voucher, rows, ctx, () => ctx.serviceItemCode);
  if (blockers.length > 0) return blocked(meta, blockers);
  const code = partyCode(voucher.vendor, ctx);
  const itemCode = ctx.serviceItemCode ?? '';
  const detail = purchaseDetail(rows, ctx, code, () => itemCode, () => ({ inventory_item_type: 2 }));
  return done(
    meta,
    split(
      detail,
      (part, lines) => ({
        voucher_type: AMIS_VOUCHER_TYPES.purchaseServices,
        org_refno: partNo(no, part),
        reftype: 330,
        branch_id: ctx.branchId,
        include_invoice: 1,
        refdate: voucher.invoice.date,
        posted_date: voucher.entryDate,
        currency_id: 'VND',
        exchange_rate: 1,
        journal_memo: voucher.description,
        ...purchaseHeader(lines),
        ...partyFields('account_object', voucher.vendor, code),
      }),
      refId(voucher.sourceId, null),
      voucher.sourceId,
      'purchase_services',
    ),
    voucher.sourceId,
  );
}

export function purchaseGoodsAmisVouchers(
  voucher: PurchaseVoucher,
  saved: ReadonlyArray<Pick<MisaGoodsCode, 'accountCode' | 'itemCode' | 'warehouseCode'>>,
  parents: AccountParents,
  ctx: AmisContext,
): AmisMapping {
  const no = misaVoucherNo(GOODS_PURCHASE_VOUCHER_PREFIX, voucher.entryId);
  const meta = { voucherNo: no, amisType: AMIS_VOUCHER_TYPES.purchaseGoods, reftype: 302, reasonTypeId: null };
  const rows = goodsPurchaseRows(voucher, saved, parents);
  const blockers = purchaseBlockers(voucher, rows, ctx, (row) => row.goods.itemCode);
  // stock_code is required on a goods line, and a saved row may have no warehouse.
  for (const row of rows) if (row.goods.warehouseCode === null) blockers.push({ code: 'stock_missing', sourceId: voucher.sourceId, lineNo: row.line.lineNo });
  if (blockers.length > 0) return blocked(meta, blockers);
  const code = partyCode(voucher.vendor, ctx);
  const detail = purchaseDetail(
    rows,
    ctx,
    code,
    (row) => row.goods.itemCode,
    (row) => ({
      inventory_item_type: 0,
      stock_code: row.goods.warehouseCode,
      main_unit_name: row.line.unit ?? ctx.defaultUnitName,
      main_quantity: num(row.line.quantity ?? '1'),
      main_convert_rate: 1,
      inventory_resale_type_id: 0,
    }),
  );
  return done(
    meta,
    split(
      detail,
      (part, lines) => ({
        voucher_type: AMIS_VOUCHER_TYPES.purchaseGoods,
        org_refno: partNo(no, part),
        reftype: 302,
        branch_id: ctx.branchId,
        include_invoice: 1,
        refdate: voucher.invoice.date,
        posted_date: voucher.entryDate,
        currency_id: 'VND',
        exchange_rate: 1,
        journal_memo: voucher.description,
        ...purchaseHeader(lines),
        ...partyFields('account_object', voucher.vendor, code),
      }),
      // The goods voucher of an invoice that also has services needs an id of its own.
      refId(voucher.sourceId, 'purchase_goods'),
      voucher.sourceId,
      'purchase_goods',
    ),
    voucher.sourceId,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sales: 13 Chứng từ bán hàng, reftype 3530 (domestic, not yet collected: Ludy debits 131).

export function salesAmisVouchers(voucher: SalesVoucher, ctx: AmisContext): AmisMapping {
  const no = misaVoucherNo(SALES_VOUCHER_PREFIX, voucher.entryId);
  const meta = { voucherNo: no, amisType: AMIS_VOUCHER_TYPES.sales, reftype: 3530, reasonTypeId: null };
  const rows = salesRows(voucher);
  const blockers: AmisBlocker[] = [];
  const at = (code: AmisBlockerCode, lineNo: number | null) => blockers.push({ code, sourceId: voucher.sourceId, lineNo });
  if (ctx.branchId === null) at('branch_missing', null);
  if (rows.length === 0) at('no_lines', null);
  const code = partyCode(voucher.customer, ctx);
  if (code === undefined) at('party_code_unknown', null);
  if (ctx.salesItemCode === null) for (const row of rows) at('item_code_unknown', row.line.lineNo);
  for (const row of rows) if (vatFields(row.vat) === null) at('vat_rate_unmapped', row.line.lineNo);
  if (blockers.length > 0) return blocked(meta, blockers);

  const detail = rows.map((row, i) => {
    const { line } = row;
    const quantity = line.quantity ?? '1';
    const unitPrice = line.unitPrice ?? line.amount;
    const unit = line.unit ?? ctx.defaultUnitName;
    return {
      sort_order: i + 1,
      inventory_item_code: ctx.salesItemCode,
      inventory_item_name: line.description,
      inventory_item_type: 2,
      description: line.description,
      debit_account: voucher.receivableAccount,
      credit_account: line.revenueAccount,
      unit_name: unit,
      quantity: num(quantity),
      unit_price: num(unitPrice),
      main_unit_name: unit,
      main_quantity: num(quantity),
      main_unit_price: num(unitPrice),
      main_convert_rate: 1,
      exchange_rate_operator: '*',
      amount_oc: num(line.amount),
      amount: num(line.amount),
      // A discount is a negative line in Ludy (no discount field), so these are 0.
      discount_rate: 0,
      discount_amount_oc: 0,
      discount_amount: 0,
      ...vatFields(row.vat),
      vat_amount_oc: num(row.vatAmount),
      vat_amount: num(row.vatAmount),
      vat_account: row.vatAccount,
    };
  });
  return done(
    meta,
    split(
      detail,
      (part, lines) => {
        const sale = total(lines.map((l) => l.amount.text));
        const vat = total(lines.map((l) => l.vat_amount.text));
        const all = canonical(money(sale).plus(money(vat)));
        return {
          voucher_type: AMIS_VOUCHER_TYPES.sales,
          org_refno: partNo(no, part),
          reftype: 3530,
          branch_id: ctx.branchId,
          is_sale_with_outward: false,
          include_invoice: 1,
          inv_no: voucher.invoice.number,
          inv_series: voucher.invoice.series,
          inv_date: voucher.invoice.date,
          refdate: voucher.invoice.date,
          posted_date: voucher.entryDate,
          currency_id: 'VND',
          exchange_rate: 1,
          journal_memo: voucher.description,
          total_sale_amount_oc: amisNumber(sale),
          total_sale_amount: amisNumber(sale),
          total_discount_amount_oc: 0,
          total_discount_amount: 0,
          total_vat_amount_oc: amisNumber(vat),
          total_vat_amount: amisNumber(vat),
          total_amount_oc: amisNumber(all),
          total_amount: amisNumber(all),
          ...partyFields('account_object', voucher.customer, code),
        };
      },
      refId(voucher.sourceId, null),
      voucher.sourceId,
      'sales',
    ),
    voucher.sourceId,
  );
}
