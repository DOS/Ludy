// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of approved supplier payments (./supplier-payment-bank-file.ts) as an xlsx file (#3113 S3b-2): one sheet, a header row and one row per payment.
//
// The holder, the account number, the bank and the remark are string cells with the Text format (setTextCell), so a name such as `=HYPERLINK(...)` or `+84...` stays inert and an account number
// keeps its leading zeros; the amount is a money cell (setMoneyCell: a number with its format, or the exact decimal as text when Excel cannot hold it). No cell is ever a formula. The file is built
// whole after the caller has its audit row and markers, from a list bounded by SUPPLIER_PAYMENT_BANK_FILE_MAX, and nothing of it is stored.
import type { SupplierPaymentBankFile } from '@ludy/kernel-contract';
import { setMoneyCell, setTextCell } from './export.ts';
import { streamWorkbook, type StreamedWorkbook } from './xlsx-stream.ts';

const HEADERS = ['STT', 'Tên người thụ hưởng', 'Số tài khoản', 'Ngân hàng', 'Số tiền', 'Nội dung chuyển khoản'] as const;

async function write(workbook: StreamedWorkbook, file: SupplierPaymentBankFile, brand: string): Promise<void> {
  workbook.creator = brand;
  workbook.lastModifiedBy = brand;
  const sheet = workbook.addWorksheet('Chuyen khoan NCC', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [{ width: 6 }, { width: 36 }, { width: 22 }, { width: 24 }, { width: 20 }, { width: 40 }];
  const head = sheet.addRow([]);
  HEADERS.forEach((header, i) => setTextCell(head.getCell(i + 1), header));
  head.font = { bold: true };
  head.commit();
  for (const r of file.rows) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell(1), r.seq);
    setTextCell(row.getCell(2), r.holder);
    setTextCell(row.getCell(3), r.account);
    setTextCell(row.getCell(4), r.bank);
    setMoneyCell(row.getCell(5), r.amount);
    setTextCell(row.getCell(6), r.content);
    row.commit();
  }
  sheet.commit();
}

export function buildSupplierPaymentBankFileWorkbook(file: SupplierPaymentBankFile, brand = 'Ludy'): Promise<Uint8Array> {
  return streamWorkbook((workbook) => write(workbook, file, brand));
}
