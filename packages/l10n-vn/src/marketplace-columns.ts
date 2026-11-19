// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order report with a header no profile knows (#3850, plan stock-and-marketplaces.md section 8.6 "Columns"): the sheet a model may see, and the check that decides whether
// a proposed column mapping reads the file. Pure functions over the grid the sheet readers give.
//
// The model never decides. It sees the header texts and a few MASKED sample values of the columns that are not buyer data, and proposes which standard field (ORDER_FIELDS) each column
// is; `checkColumnMapping` then reads the real file with that mapping, and a mapping that does not read it is refused. A person's own choice goes through the same check.
import { headerKey, type StatementCell, type StatementGrid } from './bank-statement-sheet.ts';
import { MARKETPLACE_PROFILES, ORDER_FIELDS, orderLines, type MarketplacePlatform, type OrderField, type OrderMapping, type OrderRead } from './marketplace-orders.ts';

// A header whose text names the buyer or the recipient. Such a column is never shown to a model (neither its header nor a sample) and can never be mapped: the contract has no field for
// it. Matched on the header key (no marks, lower case), so "Tên người mua" and "Buyer Name" both fall here.
const BUYER_WORDS = [
  'nguoi mua',
  'nguoi nhan',
  'khach hang',
  'khach',
  'ten dang nhap',
  'so dien thoai',
  'dien thoai',
  'sdt',
  'dia chi',
  'email',
  'buyer',
  'customer',
  'recipient',
  'receiver',
  'consignee',
  'username',
  'user name',
  'phone',
  'mobile',
  'address',
  'ward',
  'district',
  'province',
  'postal',
  'zip',
  'cccd',
  'cmnd',
  'shipping name',
  'delivery name',
  'billing',
];

// A header is buyer-looking when one of the words is a word of the header (so "ward" is not found inside "reward" and "sdt" not inside another word).
export function isBuyerHeader(text: string): boolean {
  // headerKey does not split camelCase ("buyerName" would stay one word), so the words are split first.
  const key = ` ${headerKey(text.replace(/([a-z])([A-Z])/g, '$1 $2'))} `;
  return BUYER_WORDS.some((word) => key.includes(` ${word} `) || key.includes(` ${word}s `));
}

// What a model may see of a cell: its shape, never its content. Digits become 9, letters a, everything else stays (so a date reads 9999-99-99 and an amount 9.999.999); cut at 12
// characters and never more than the first line.
const SAMPLE_CHARS = 12;
export function maskSample(text: string): string {
  const line = (text.split(/\r?\n/, 1)[0] ?? '').trim();
  return [...line.slice(0, SAMPLE_CHARS)].map((ch) => (/\d/.test(ch) ? '9' : /\p{L}/u.test(ch) ? 'a' : ch)).join('');
}

const MAX_HEADER_TEXT = 80;
const MAX_COLUMNS = 60;
const SAMPLE_ROWS = 3;

export interface SheetColumn {
  // 0-based column of the grid.
  index: number;
  // The header text as the file words it, cut. Empty for a buyer column (never shown).
  header: string;
  // At most SAMPLE_ROWS masked values; empty for a buyer column.
  samples: string[];
  buyer: boolean;
}

export interface ColumnSheet {
  headerRow: number;
  columns: SheetColumn[];
}

const cellText = (cell: StatementCell | undefined): string => (cell?.value ?? '').trim();

// The header row of a file no profile fits: the first of the first 30 rows with at least three non-empty cells, a row of data under it. The columns are those of that row, buyer columns
// marked and blanked. null when the file has no such row or is wider than MAX_COLUMNS (not a report this path reads).
export function columnSheet(rows: StatementGrid): ColumnSheet | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  for (const n of numbers.slice(0, 30)) {
    const row = rows.get(n) ?? new Map<number, StatementCell>();
    const cells = [...row].filter(([, cell]) => cellText(cell) !== '');
    if (cells.length < 3) continue;
    const below = numbers.filter((m) => m > n).slice(0, 200);
    if (below.length === 0) continue;
    if (cells.length > MAX_COLUMNS) return null;
    const columns: SheetColumn[] = cells
      .sort((a, b) => a[0] - b[0])
      .map(([index, cell]) => {
        const header = cellText(cell);
        if (isBuyerHeader(header)) return { index, header: '', samples: [], buyer: true };
        const samples: string[] = [];
        for (const m of below) {
          const text = cellText(rows.get(m)?.get(index));
          if (text !== '') samples.push(maskSample(text));
          if (samples.length >= SAMPLE_ROWS) break;
        }
        return { index, header: header.slice(0, MAX_HEADER_TEXT), samples, buyer: false };
      });
    return { headerRow: n, columns };
  }
  return null;
}

// One column and the field it was proposed (or chosen) to be.
export interface ColumnAssignment {
  index: number;
  field: OrderField;
}

export const COLUMN_REFUSALS = ['no_header', 'bad_column', 'buyer_column', 'field_twice', 'column_twice', 'no_order_no', 'no_line', 'nothing_read', 'row_stops_file', 'too_many_rows'] as const;
export type ColumnRefusal = (typeof COLUMN_REFUSALS)[number];

export type ColumnCheck = { ok: true; read: OrderRead } | { ok: false; reason: ColumnRefusal };

const FIELD_SET: ReadonlySet<string> = new Set(ORDER_FIELDS);

// Whether the mapping reads the file. Refused unless: the file has a header row; every column is one of the header row's and not a buyer column; no field and no column is used twice; the
// order number and the quantity are mapped (the line key instead of the quantity for a platform whose file has a row per unit); at least one line is read; and no row stops the file (any
// skip reason but `no_order_no`, which is a totals or notice row). The statuses and the other platform rules are those of the platform's own profile.
export function checkColumnMapping(rows: StatementGrid, platform: MarketplacePlatform, assignments: readonly ColumnAssignment[], maxRows: number): ColumnCheck {
  const sheet = columnSheet(rows);
  if (!sheet) return { ok: false, reason: 'no_header' };
  const byIndex = new Map(sheet.columns.map((c) => [c.index, c]));
  const columns = Object.fromEntries(ORDER_FIELDS.map((f) => [f, null])) as Record<OrderField, number | null>;
  const usedColumns = new Set<number>();
  for (const a of assignments) {
    if (!FIELD_SET.has(a.field)) return { ok: false, reason: 'bad_column' };
    const column = byIndex.get(a.index);
    if (!column) return { ok: false, reason: 'bad_column' };
    if (column.buyer) return { ok: false, reason: 'buyer_column' };
    if (columns[a.field] !== null) return { ok: false, reason: 'field_twice' };
    if (usedColumns.has(a.index)) return { ok: false, reason: 'column_twice' };
    columns[a.field] = a.index;
    usedColumns.add(a.index);
  }
  const profile = MARKETPLACE_PROFILES.find((p) => p.platform === platform);
  if (!profile) return { ok: false, reason: 'bad_column' };
  if (columns.orderNo === null) return { ok: false, reason: 'no_order_no' };
  if (profile.rowPerUnit ? columns.lineKey === null : columns.quantity === null) return { ok: false, reason: 'no_line' };
  const mapping: OrderMapping = {
    profile,
    headerRow: sheet.headerRow,
    columns,
    headers: ORDER_FIELDS.flatMap((field) => {
      const col = columns[field];
      return col === null ? [] : [{ field, header: byIndex.get(col)?.header ?? '' }];
    }),
  };
  const read = orderLines(rows, mapping, maxRows);
  if (read === null) return { ok: false, reason: 'too_many_rows' };
  if (read.skipped.some((s) => s.reason !== 'no_order_no')) return { ok: false, reason: 'row_stops_file' };
  if (read.lines.length === 0) return { ok: false, reason: 'nothing_read' };
  return { ok: true, read };
}
