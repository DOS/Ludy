// SPDX-License-Identifier: AGPL-3.0-only
// Reading a CSV of contacts in the browser (CRM plan 5, step K5, #2229): the delimiter a spreadsheet used, the cells with
// their quotes, the columns a header names (with or without Vietnamese marks), and the file of rows that were not
// imported. Nothing here talks to the server; the rows go to crm.import.stage once the person has mapped the columns.
import type { ImportRowInput } from '@crove/kernel-contract';

export const IMPORT_FIELDS = ['name', 'kind', 'taxCode', 'email', 'phone', 'address'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
// Most bytes of a file the screen reads (the server takes 2,000 rows).
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

// Comma, semicolon or tab: the one the first lines use most outside quotes.
function delimiterOf(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  const count = (d: string) => {
    let n = 0;
    let quoted = false;
    for (const ch of sample) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    return n;
  };
  return [',', ';', '\t'].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n)[0]?.d ?? ',';
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
  return { header: header.map((h) => h.trim()), rows };
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
export function mappedRows(rows: readonly string[][], mapping: readonly (ImportField | null)[]): ImportRowInput[] {
  return rows.map((cells) => {
    const pick = (field: ImportField): string => {
      const at = mapping.indexOf(field);
      return at < 0 ? '' : (cells[at] ?? '').trim();
    };
    return { kind: pick('kind') || null, name: pick('name'), taxCode: pick('taxCode') || null, email: pick('email') || null, phone: pick('phone') || null, address: pick('address') || null };
  });
}

// A cell that a spreadsheet would run as a formula is written as text.
const safe = (cell: string): string => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell);
const quote = (cell: string): string => `"${safe(cell).replace(/"/g, '""')}"`;

// The rows that were not imported, as a CSV with the file's own columns and a last column saying why.
export function rejectsCsv(header: readonly string[], rows: readonly string[][], extra: readonly string[], reasonHeader: string): string {
  const lines = [[...header, reasonHeader].map(quote).join(',')];
  rows.forEach((cells, i) => lines.push([...header.map((_, c) => cells[c] ?? ''), extra[i] ?? ''].map(quote).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}
