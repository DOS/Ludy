// SPDX-License-Identifier: AGPL-3.0-only
// Test helper: a made-up bank statement as .xlsx or CSV (#2142), the way a Vietnamese bank's export lays it out: a title,
// the account number and the period above a header row, the lines under it and a totals row below. The account number
// and every amount are invented. Node built-ins only (through xlsx-fixture), so the kernel tests import it too.
import { buildXlsx, type XlsxCell } from './xlsx-fixture.ts';

// A made-up account number (11 digits, none of a person's identity card or a real bank's), as the bank feed mappings name
// an account.
export const STATEMENT_ACCOUNT = '19880001234';

export interface StatementLineSpec {
  // dd/mm/yyyy, as a bank prints it.
  date: string;
  description: string;
  // Money in or out, in dong; the other side is empty.
  moneyIn?: number;
  moneyOut?: number;
  balance?: number;
  reference?: string;
}

export const STATEMENT_HEADER = ['Ngày giao dịch', 'Diễn giải', 'Ghi nợ', 'Ghi có', 'Số dư', 'Số tham chiếu'];

// The lines of the made-up statement: three lines of September 2026, with the bank's reference on each.
export const STATEMENT_LINES: StatementLineSpec[] = [
  { date: '01/09/2026', description: 'Thu tien hang HD 0001', moneyIn: 2_000_000, balance: 12_000_000, reference: 'FT26244000001' },
  { date: '02/09/2026', description: 'Phi quan ly tai khoan', moneyOut: 11_000, balance: 11_989_000, reference: 'FT26245000002' },
  { date: '03/09/2026', description: 'Tra tien dien', moneyOut: 850_000, balance: 11_139_000, reference: 'FT26246000003' },
];

function lineCells(line: StatementLineSpec): XlsxCell[] {
  return [line.date, line.description, line.moneyOut ?? null, line.moneyIn ?? null, line.balance ?? null, line.reference ?? null];
}

export interface StatementOptions {
  account?: string | null;
  lines?: StatementLineSpec[];
}

// The cells of the whole sheet, above and below the lines included.
export function statementRows({ account = STATEMENT_ACCOUNT, lines = STATEMENT_LINES }: StatementOptions = {}): XlsxCell[][] {
  return [
    ['SAO KÊ TÀI KHOẢN'],
    ['Tên tài khoản: CÔNG TY TNHH MẪU'],
    ...(account === null ? [] : [[`Số tài khoản: ${account}`]]),
    ['Từ ngày 01/09/2026 đến ngày 30/09/2026'],
    [],
    STATEMENT_HEADER,
    ...lines.map(lineCells),
    ['Tổng cộng', null, lines.reduce((sum, l) => sum + (l.moneyOut ?? 0), 0), lines.reduce((sum, l) => sum + (l.moneyIn ?? 0), 0)],
  ];
}

export function statementXlsx(options: StatementOptions = {}): Uint8Array<ArrayBuffer> {
  return buildXlsx(statementRows(options));
}

const csvCell = (cell: XlsxCell): string => {
  if (cell === null) return '';
  const text = typeof cell === 'string' ? cell : typeof cell === 'number' ? String(cell) : 'date' in cell ? String(cell.date) : cell.cached;
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// The same statement as CSV text (UTF-8 with a byte order mark, comma separated, amounts as plain digits).
export function statementCsv(options: StatementOptions = {}): Uint8Array<ArrayBuffer> {
  const text = statementRows(options)
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
  const bytes = new TextEncoder().encode(`﻿${text}\r\n`);
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}
