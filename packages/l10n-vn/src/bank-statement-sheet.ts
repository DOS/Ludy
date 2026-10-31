// SPDX-License-Identifier: AGPL-3.0-only
// Bank statements (issues #326 and #2142): finding a bank's Excel or CSV export's columns by their headers, the lines
// under them and the account number above them, so any bank's file can be read without a preset. Pure functions over a
// grid of cells, shared by the browser import (apps/app) and the parsing sandbox that reads a statement forwarded by
// email or dropped in the Inbox (apps/extract), so both find the same columns. Cells are text; the finance module
// decides every rule about their content.

// A cell as the sheet readers give it: a number cell keeps the exact digits Excel stored, a date cell the serial day
// number (kind 'date', the sandbox's reader only), a text cell what was typed.
export interface StatementCell {
  kind: string;
  value: string;
}

// Rows by their 1-based number; cells by 0-based column (A = 0). Missing cells are absent.
export type StatementGrid = ReadonlyMap<number, ReadonlyMap<number, StatementCell>>;

export const STATEMENT_COLUMNS = ['date', 'description', 'moneyIn', 'moneyOut', 'amount', 'balance', 'reference'] as const;
export type StatementColumn = (typeof STATEMENT_COLUMNS)[number];

// The 0-based column of each field (null when the file has none) and the header's row number. amount is one signed
// column, used when the file has no separate money in and money out columns.
export interface StatementMapping {
  headerRow: number;
  columns: Record<StatementColumn, number | null>;
}

// Lower case, no Vietnamese marks, single spaces: "Số tiền ghi Nợ" -> "so tien ghi no".
export function headerKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Words of the headers Vietnamese banks and their English exports use, most specific first. A header matches a field
// when it contains one of the field's words (or equals one marked exact).
const WORDS: Record<StatementColumn, { contains: string[]; exact?: string[] }> = {
  date: { contains: ['ngay giao dich', 'ngay gd', 'ngay hieu luc', 'ngay hach toan', 'ngay ghi so', 'transaction date', 'value date', 'posting date', 'ngay', 'date'] },
  moneyOut: { contains: ['ghi no', 'phat sinh no', 'so tien no', 'tien ra', 'rut ra', 'debit', 'withdraw'], exact: ['no'] },
  moneyIn: { contains: ['ghi co', 'phat sinh co', 'so tien co', 'tien vao', 'gui vao', 'credit', 'deposit'], exact: ['co'] },
  balance: { contains: ['so du', 'balance'] },
  reference: { contains: ['so tham chieu', 'ma giao dich', 'so giao dich', 'so but toan', 'ma gd', 'so ct', 'transaction id', 'reference', 'ref no'], exact: ['ref'] },
  description: { contains: ['noi dung', 'dien giai', 'mo ta', 'chi tiet', 'description', 'remark', 'narrative', 'details'] },
  amount: { contains: ['so tien', 'amount'] },
};
// Fields claimed in this order, so "so tien ghi no" goes to money out before amount can take it.
const CLAIM_ORDER: StatementColumn[] = ['date', 'balance', 'moneyOut', 'moneyIn', 'reference', 'description', 'amount'];

const cellText = (cell: StatementCell | undefined) => (cell?.value ?? '').trim();

function claim(headers: Map<number, string>): Record<StatementColumn, number | null> {
  const columns = Object.fromEntries(STATEMENT_COLUMNS.map((c) => [c, null])) as Record<StatementColumn, number | null>;
  const taken = new Set<number>();
  for (const field of CLAIM_ORDER) {
    const words = WORDS[field];
    for (const word of words.contains) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && (key === word || key.includes(word)));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
        break;
      }
    }
    if (columns[field] === null && words.exact) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && words.exact?.includes(key));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
      }
    }
  }
  return columns;
}

// The header row: the first of the first 30 rows that names a date and an amount (money in or out, or a signed
// amount). Banks put a title, the account and the period above it.
export function findColumns(rows: StatementGrid): StatementMapping | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b).slice(0, 30);
  for (const n of numbers) {
    const headers = new Map<number, string>();
    for (const [col, cell] of rows.get(n) ?? []) {
      const key = headerKey(cellText(cell));
      if (key) headers.set(col, key);
    }
    const columns = claim(headers);
    if (columns.date !== null && (columns.moneyIn !== null || columns.moneyOut !== null || columns.amount !== null)) {
      // A file with both sides needs no signed amount column.
      if (columns.moneyIn !== null || columns.moneyOut !== null) columns.amount = null;
      return { headerRow: n, columns };
    }
  }
  return null;
}

// The header text of every column of the header row, for choosing a column by hand.
export function headerLabels(rows: StatementGrid, headerRow: number): Array<{ col: number; label: string }> {
  return [...(rows.get(headerRow) ?? [])]
    .map(([col, cell]) => ({ col, label: cellText(cell) }))
    .filter((h) => h.label !== '')
    .sort((a, b) => a.col - b.col);
}

// One line of the file as read: the text fields cut to the lengths the finance module takes, the amount fields as the
// cells they are (the caller turns a typed text into a plain number; a stored number is taken as it is). moneyIn holds
// the signed amount of a file with one amount column.
export interface StatementLine {
  rowNo: number;
  date: string;
  description: string;
  reference: string;
  moneyIn: StatementCell | undefined;
  moneyOut: StatementCell | undefined;
  balance: StatementCell | undefined;
}

// The lines under the header: every row whose date cell holds a digit (a title, a blank or a "Tổng cộng" row below the
// lines has none). At most maxRows; null when the file has more.
export function statementLines(rows: StatementGrid, mapping: StatementMapping, maxRows: number): StatementLine[] | null {
  const { headerRow, columns } = mapping;
  const out: StatementLine[] = [];
  const cell = (row: ReadonlyMap<number, StatementCell>, col: number | null) => (col === null ? undefined : row.get(col));
  for (const n of [...rows.keys()].sort((a, b) => a - b)) {
    if (n <= headerRow) continue;
    const row = rows.get(n) ?? new Map<number, StatementCell>();
    const date = cellText(cell(row, columns.date));
    if (!/\d/.test(date)) continue;
    if (out.length === maxRows) return null;
    const signed = columns.amount !== null && columns.moneyIn === null && columns.moneyOut === null;
    out.push({
      rowNo: n,
      date: date.slice(0, 40),
      description: cellText(cell(row, columns.description)).slice(0, 1000),
      reference: cellText(cell(row, columns.reference)).slice(0, 100),
      moneyIn: cell(row, signed ? columns.amount : columns.moneyIn),
      moneyOut: signed ? undefined : cell(row, columns.moneyOut),
      balance: cell(row, columns.balance),
    });
  }
  return out;
}

// What labels the account number in the rows above the lines: "Số tài khoản", "STK", "Account number" and the like.
const ACCOUNT_LABELS = ['so tai khoan', 'so tk', 'stk', 'tai khoan', 'account number', 'account no', 'a c no', 'a c number', 'acc no'];

// An account number as banks print it: 6 to 20 digits, with spaces, dots or dashes between groups. Anything else (a
// name, a currency, a date) is not one.
function accountDigits(text: string): string | null {
  const compact = text.replace(/[\s.-]/g, '');
  return /^\d{6,20}$/.test(compact) ? compact : null;
}

// The account number the statement is of, from the rows above the header: a cell that names it ("Số tài khoản: 0011
// 0000 0000"), with the number after the colon or in the next cell to its right. Null when none is found: "Tên tài
// khoản" (the account's name) and the like are skipped, as their value is no number. Only the digits are returned, so
// "0011 0000 0000", "0011.0000.0000" and "001100000000" are one account.
export function findAccountNumber(rows: StatementGrid, headerRow: number): string | null {
  for (const n of [...rows.keys()].sort((a, b) => a - b)) {
    if (n >= headerRow) break;
    const cells = [...(rows.get(n) ?? [])].sort((a, b) => a[0] - b[0]);
    for (const [index, [, cell]] of cells.entries()) {
      const text = cellText(cell);
      const colon = text.search(/[:：]/);
      const label = headerKey(colon >= 0 ? text.slice(0, colon) : text);
      if (!ACCOUNT_LABELS.some((word) => label === word || label.includes(word))) continue;
      const inline = colon >= 0 ? accountDigits(text.slice(colon + 1)) : null;
      if (inline) return inline;
      const next = cells[index + 1]?.[1];
      const beside = next ? accountDigits(cellText(next)) : null;
      if (beside) return beside;
    }
  }
  return null;
}

// How often `delimiter` appears in `text` outside double-quoted cells, by the quote rules parseCsv reads with: a quote
// opens a cell only at its start and "" inside one is a quote character, so a quoted cell full of commas does not make
// comma the file's delimiter.
function countOutsideQuotes(text: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') quoted = false;
      atStart = false;
    } else if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === delimiter) {
      count++;
      atStart = true;
    } else if (ch === '\n') {
      atStart = true;
    } else if (ch !== '\r') {
      atStart = false;
    }
  }
  return count;
}

// CSV as banks export it: comma, semicolon or tab separated (the one the first lines use most), double quotes around
// cells that hold one, "" for a quote inside. Every cell is text. Rows are numbered from 1, like a sheet.
export function parseCsv(text: string): Map<number, Map<number, { kind: 'text'; value: string }>> {
  const body = text.replace(/^﻿/, '');
  const sample = body.split(/\r?\n/).slice(0, 10).join('\n');
  const delimiter = [',', ';', '\t'].reduce((best, d) => (countOutsideQuotes(sample, d) > countOutsideQuotes(sample, best) ? d : best), ',');
  const rows = new Map<number, Map<number, { kind: 'text'; value: string }>>();
  let row = new Map<number, { kind: 'text'; value: string }>();
  let col = 0;
  let value = '';
  let quoted = false;
  let rowNo = 1;
  const endCell = () => {
    if (value.trim() !== '') row.set(col, { kind: 'text', value });
    col++;
    value = '';
  };
  const endRow = () => {
    endCell();
    if (row.size > 0) rows.set(rowNo, row);
    rowNo++;
    row = new Map();
    col = 0;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') value += ch;
  }
  if (value !== '' || row.size > 0) endRow();
  return rows;
}
