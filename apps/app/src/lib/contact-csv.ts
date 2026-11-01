// SPDX-License-Identifier: AGPL-3.0-only
// Reading a CSV of contacts in the browser (CRM plan 5, step K5, #2229): the delimiter a spreadsheet used, the cells with
// their quotes, the columns a header names (with or without Vietnamese marks), and the file of rows that were not
// imported. Nothing here talks to the server; the rows go to crm.import.stage once the person has mapped the columns.
import type { ImportRowInput } from '@crove/kernel-contract';
import type { SheetRows } from './xlsx.ts';

export const IMPORT_FIELDS = ['name', 'kind', 'taxCode', 'email', 'phone', 'address'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
// Most bytes of a file the screen reads (the server takes 2,000 rows).
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  // The file ended inside a quoted cell: the rest of it became that one cell, so it is not read as contacts.
  unterminated?: true;
  // Which cells a spreadsheet stored as numbers (an .xlsx only): a phone or tax code typed without a text format lost its
  // leading zero there, and mappedRows puts it back.
  numeric?: boolean[][];
}

// Comma, semicolon or tab: the one that splits the header and the lines under it into the same number of cells (outside
// quotes), the more the better; failing that, the one the header has most. A comma inside an address does not decide it.
function delimiterOf(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  const counts = (d: string) =>
    lines.map((line) => {
      let n = 0;
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      return n;
    });
  const scored = [',', ';', '\t'].map((d) => {
    const n = counts(d);
    const head = n[0] ?? 0;
    return { d, head, consistent: head > 0 && n.every((x) => x === head) };
  });
  scored.sort((a, b) => Number(b.consistent) - Number(a.consistent) || b.head - a.head);
  return scored[0]?.d ?? ',';
}

// Every cell is text; empty cells stay empty; blank lines are dropped. The first line is the header.
export function parseContactCsv(raw: string): ParsedCsv {
  const text = raw.replace(/^﻿/, '');
  const delimiter = delimiterOf(text);
  const lines: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  const endCell = () => {
    row.push(value);
    value = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) lines.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') value += ch;
  }
  if (value !== '' || row.length > 0) endRow();
  const [header = [], ...rows] = lines;
  return { header: header.map((h) => h.trim()), rows, ...(quoted ? { unterminated: true as const } : {}) };
}

// The first sheet of an .xlsx as the same table a CSV gives: its first row is the header, the rows under it follow in order
// (a row with no cell is skipped, as a blank line of a CSV is). A number cell keeps the exact text it was stored with.
export function sheetToTable(sheet: SheetRows): ParsedCsv {
  const numbers = [...sheet.keys()].sort((a, b) => a - b);
  const width = Math.max(0, ...numbers.map((n) => Math.max(-1, ...(sheet.get(n)?.keys() ?? [])) + 1));
  const line = (n: number) => {
    const cells = sheet.get(n) ?? new Map();
    return {
      text: Array.from({ length: width }, (_, c) => (cells.get(c)?.value ?? '').trim()),
      numeric: Array.from({ length: width }, (_, c) => cells.get(c)?.kind === 'number'),
    };
  };
  const lines = numbers.map(line).filter((l) => l.text.some((c) => c !== ''));
  const [first, ...rest] = lines;
  return { header: first?.text ?? [], rows: rest.map((l) => l.text), numeric: rest.map((l) => l.numeric) };
}

// A header without marks, case or punctuation: "Số điện thoại" and "so dien thoai" are one.
export function foldHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ALIASES: Record<ImportField, readonly string[]> = {
  name: ['ten', 'ho ten', 'ho va ten', 'name', 'full name', 'ten khach hang', 'khach hang', 'ten cong ty', 'cong ty', 'company', 'company name', 'customer', 'contact'],
  kind: ['loai', 'loai khach hang', 'phan loai', 'kind', 'type'],
  taxCode: ['mst', 'ma so thue', 'ma so thue mst', 'tax code', 'tax id', 'tax', 'vat', 'vat id'],
  email: ['email', 'e mail', 'mail', 'thu dien tu', 'dia chi email'],
  phone: ['dien thoai', 'so dien thoai', 'sdt', 'phone', 'mobile', 'tel', 'di dong', 'phone number'],
  address: ['dia chi', 'address', 'dia chi cong ty'],
};

// The field each header names, by index, or null: a field is taken by the first header that names it.
export function guessMapping(header: readonly string[]): (ImportField | null)[] {
  const taken = new Set<ImportField>();
  return header.map((h) => {
    const folded = foldHeader(h);
    const field = IMPORT_FIELDS.find((f) => !taken.has(f) && ALIASES[f].includes(folded));
    if (field) taken.add(field);
    return field ?? null;
  });
}

// The rows as crm.import.stage takes them: the mapped cells, the rest empty, one per row of the file in the same order, so
// the row number the server reports is the position in the file (the first row under the header is 1).
export function mappedRows(rows: readonly string[][], mapping: readonly (ImportField | null)[], numeric?: readonly (readonly boolean[])[]): ImportRowInput[] {
  return rows.map((cells, r) => {
    const pick = (field: ImportField): string => {
      const at = mapping.indexOf(field);
      const text = at < 0 ? '' : (cells[at] ?? '').trim();
      // A number cell of 9 digits is a Vietnamese mobile number or a tax code that lost its leading zero.
      return at >= 0 && numeric?.[r]?.[at] === true && (field === 'phone' || field === 'taxCode') && /^\d{9}$/.test(text) ? `0${text}` : text;
    };
    return { kind: pick('kind') || null, name: pick('name'), taxCode: pick('taxCode') || null, email: pick('email') || null, phone: pick('phone') || null, address: pick('address') || null };
  });
}

// A cell that a spreadsheet would run as a formula is written as text.
// A phone number such as +84 912 345 678 and a plain number are written as they are: they are no formula, and the file is
// meant to be imported again.
const safe = (cell: string): string => (/^[=+\-@\t\r]/.test(cell) && !/^[+-]?\d[\d ().,-]*$/.test(cell) ? `'${cell}` : cell);
const quote = (cell: string): string => `"${safe(cell).replace(/"/g, '""')}"`;

// The rows that were not imported, as a CSV with the file's own columns and a last column saying why.
export function rejectsCsv(header: readonly string[], rows: readonly string[][], extra: readonly string[], reasonHeader: string): string {
  const lines = [[...header, reasonHeader].map(quote).join(',')];
  rows.forEach((cells, i) => lines.push([...header.map((_, c) => cells[c] ?? ''), extra[i] ?? ''].map(quote).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}
