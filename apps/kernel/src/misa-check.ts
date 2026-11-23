// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA SME voucher export, on the API side (#3848). It loads the vouchers the export route of the same format loads (finance.vouchers.purchases, .sales or .cash, the same range and limit), builds the
// same rows with the same functions and templates, and hands them to the pure check (modules/finance misa-check.ts) with the org's chart. A read: it writes nothing, and the export routes are unchanged and
// never wait for it. The file is too large to export (EXPORT_TOO_LARGE, 422) exactly when it is too large to check.
import {
  JOURNAL_EXPORT_LIMIT,
  MISA_SME_BANK_CREDIT,
  MISA_SME_BANK_DEBIT,
  MISA_SME_CASH_PAYMENT,
  MISA_SME_CASH_RECEIPT,
  MISA_SME_PURCHASE_GOODS,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  cashRows,
  checkMisaRows,
  goodsPurchaseRows,
  salesRows,
  servicePurchaseRows,
  type CashVoucher,
  type PurchaseVoucher,
  type SalesVoucher,
} from '@ludy/mod-finance';
import { accountParents, type MisaCheck, type MisaCheckAsk, type MisaGoodsCode } from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';

export type MisaCheckQuery = <T>(name: string, input: unknown) => Promise<T>;

const CASH_TYPES = {
  misa_sme_cash_receipts: { type: 'cash_receipt', template: MISA_SME_CASH_RECEIPT },
  misa_sme_cash_payments: { type: 'cash_payment', template: MISA_SME_CASH_PAYMENT },
  misa_sme_bank_credits: { type: 'bank_credit', template: MISA_SME_BANK_CREDIT },
  misa_sme_bank_debits: { type: 'bank_debit', template: MISA_SME_BANK_DEBIT },
} as const;

const tooLarge = () => new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');

export async function misaCheck(query: MisaCheckQuery, ask: MisaCheckAsk): Promise<MisaCheck> {
  const range = { from: ask.from, to: ask.to, limit: JOURNAL_EXPORT_LIMIT, ...(ask.legalEntityId === undefined ? {} : { legalEntityId: ask.legalEntityId }) };
  const chart = await query<Array<{ code: string; parentCode: string | null }>>('finance.accounts.list', {});
  const codes = new Set(chart.map((a) => a.code));
  if (ask.format === 'misa_sme_purchases' || ask.format === 'misa_sme_goods_purchases') {
    const vouchers = await query<PurchaseVoucher[]>('finance.vouchers.purchases', range);
    if (vouchers.length >= JOURNAL_EXPORT_LIMIT) throw tooLarge();
    if (ask.format === 'misa_sme_purchases') {
      const rows = vouchers.flatMap(servicePurchaseRows);
      return checkMisaRows({ format: ask.format, template: MISA_SME_PURCHASE_SERVICE, rows, chart: codes, rowId: (r) => ({ voucherNo: r.voucherNo, lineNo: r.line.lineNo }) });
    }
    const goodsCodes = await query<MisaGoodsCode[]>('finance.misa_goods_codes.list', {});
    const parents = accountParents(chart);
    const rows = vouchers.flatMap((v) => goodsPurchaseRows(v, goodsCodes, parents));
    return checkMisaRows({ format: ask.format, template: MISA_SME_PURCHASE_GOODS, rows, chart: codes, rowId: (r) => ({ voucherNo: r.voucherNo, lineNo: r.line.lineNo }) });
  }
  if (ask.format === 'misa_sme_sales') {
    const vouchers = await query<SalesVoucher[]>('finance.vouchers.sales', range);
    if (vouchers.length >= JOURNAL_EXPORT_LIMIT) throw tooLarge();
    const rows = vouchers.flatMap(salesRows);
    return checkMisaRows({ format: ask.format, template: MISA_SME_SALES, rows, chart: codes, rowId: (r) => ({ voucherNo: r.voucherNo, lineNo: r.line.lineNo }) });
  }
  const cash = CASH_TYPES[ask.format];
  const vouchers = await query<CashVoucher[]>('finance.vouchers.cash', { ...range, type: cash.type });
  if (vouchers.length >= JOURNAL_EXPORT_LIMIT) throw tooLarge();
  const rows = vouchers.flatMap(cashRows);
  return checkMisaRows({ format: ask.format, template: cash.template, rows, chart: codes, rowId: (r) => ({ voucherNo: r.voucherNo, lineNo: r.line.lineNo }) });
}
