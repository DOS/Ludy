// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order report with a header no profile knows (#3850, plan stock-and-marketplaces.md section 8.6 "Columns"): the sheet a model may see, and the check that decides whether
// a proposed column mapping reads the file. Pure functions over the grid the sheet readers give.
//
// The model never decides. It sees the header texts and a few MASKED sample values of the columns that are not buyer data, and proposes which standard field (ORDER_FIELDS) each column
// is; `checkColumnMapping` then reads the real file with that mapping, and a mapping that does not read it is refused. A person's own choice goes through the same check.
import { Decimal } from 'decimal.js';
import { headerKey, type StatementCell, type StatementGrid } from './bank-statement-sheet.ts';
import { MARKETPLACE_PROFILES, ORDER_FIELDS, orderLines, readDay, readDecimal, type MarketplacePlatform, type OrderField, type OrderMapping, type OrderRead } from './marketplace-orders.ts';

// A header whose text names the buyer or the recipient. Such a column is never shown to a model (neither its header nor a sample) and can never be mapped: the contract has no field for
// it. Matched on the header key (no marks, lower case), so "Tên người mua" and "Buyer Name" both fall here.
const BUYER_WORDS = [
  // Vietnamese: the buyer, the recipient, contact, address and its parts, tax code, free text a buyer writes.
  'nguoi mua',
  'nguoi nhan',
  'nguoi dat',
  'khach hang',
  'khach',
  'kh',
  'ho ten',
  'ho va ten',
  'ten dang nhap',
  'so dien thoai',
  'dien thoai',
  'so dt',
  'sdt',
  'lien he',
  'dia chi',
  'tinh thanh',
  'thanh pho',
  'quan huyen',
  'huyen',
  'phuong xa',
  'phuong',
  'quoc gia',
  'ma so thue',
  'ghi chu',
  'loi nhan',
  'nhan xet',
  // English and the export field names.
  'buyer',
  'customer',
  'recipient',
  'receiver',
  'consignee',
  'username',
  'user name',
  'nickname',
  'phone',
  'tel',
  'mobile',
  'e mail',
  'email',
  'contact',
  'ship to',
  'address',
  'ward',
  'district',
  'regency',
  'province',
  'city',
  'country',
  'village',
  'postal',
  'postcode',
  'post code',
  'zip',
  'zipcode',
  'tax code',
  'taxcode',
  'national',
  'cccd',
  'cmnd',
  'shipping name',
  'delivery name',
  'billing',
  'message',
  'note',
  'remark',
  'comment',
];

// A header is buyer-looking when one of the words is a word of the header (so "ward" is not found inside "reward" and "kh" not inside another word), or, for a word of five letters or more, when it
// is found in the header with its spaces and marks removed ("BUYERNAME", "shippingcity", "nguoimua").
const JOINED = BUYER_WORDS.map((word) => word.replace(/ /g, '')).filter((word) => word.length >= 5);
export function isBuyerHeader(text: string): boolean {
  // headerKey does not split camelCase ("buyerName" would stay one word), so the words are split first.
  const key = headerKey(text.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const padded = ` ${key} `;
  if (BUYER_WORDS.some((word) => padded.includes(` ${word} `) || padded.includes(` ${word}s `))) return true;
  const joined = headerKey(text).replace(/ /g, '');
  return JOINED.some((word) => joined.includes(word));
}

// What a model may see of a cell: its shape, never its content. Digits become 9, letters a, everything else stays (so a date reads 9999-99-99 and an amount 9.999.999); cut at 12
// characters and never more than the first line.
const SAMPLE_CHARS = 12;
// Digits of any script become 9, letters (and every mark not on the short list below) a; the list keeps the marks that give a date or an amount its shape.
const SHAPE_MARKS = new Set([' ', '-', '/', '.', ',', ':', ';', '@', '#', '(', ')', '+', '%', '_']);
export function maskSample(text: string): string {
  const line = (text.split(/\r?\n/, 1)[0] ?? '').trim();
  return Array.from(line)
    .slice(0, SAMPLE_CHARS)
    .map((ch) => (/\p{Nd}/u.test(ch) ? '9' : SHAPE_MARKS.has(ch) ? ch : 'a'))
    .join('');
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

// A cell that is a value, not a header word: a number, a day, a run of four digits or more (a phone, an id, a year) or an address with an at sign. A row with one is data, never the header, so a
// file with no header row, or a title row with a period in it, does not put a buyer's values in the sheet.
function looksLikeData(cell: StatementCell): boolean {
  const text = cellText(cell);
  const number = readDecimal(cell);
  return (number !== null && number !== 'bad') || readDay(cell) !== null || /\d{4,}/.test(text) || text.includes('@');
}

// The header row of a file no profile fits: among the first 30 rows, those with at least three non-empty cells, none of them a value, and a row of data under it; the one with the most cells
// (the first of equals), so a three-cell title above the real header is passed over. The columns are those of that row, buyer columns marked and blanked. null when the file has no such row or is
// wider than MAX_COLUMNS (not a report this path reads).
export function columnSheet(rows: StatementGrid): ColumnSheet | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  let best: { n: number; cells: Array<[number, StatementCell]> } | null = null;
  for (const n of numbers.slice(0, 30)) {
    const row = rows.get(n) ?? new Map<number, StatementCell>();
    const cells = [...row].filter(([, cell]) => cellText(cell) !== '');
    if (cells.length < 3 || cells.some(([, cell]) => looksLikeData(cell))) continue;
    if (!numbers.some((m) => m > n)) continue;
    if (!best || cells.length > best.cells.length) best = { n, cells };
  }
  if (!best || best.cells.length > MAX_COLUMNS) return null;
  const below = numbers.filter((m) => m > (best as { n: number }).n).slice(0, 200);
  const columns: SheetColumn[] = best.cells
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
  return { headerRow: best.n, columns };
}

// One column and the field it was proposed (or chosen) to be.
export interface ColumnAssignment {
  index: number;
  field: OrderField;
}

export const COLUMN_REFUSALS = ['no_header', 'bad_column', 'buyer_column', 'field_twice', 'column_twice', 'no_order_no', 'no_line', 'nothing_read', 'row_stops_file', 'too_many_rows', 'rows_without_order', 'return_without_status', 'quantity_exceeds_amount', 'dates_swapped'] as const;
export type ColumnRefusal = (typeof COLUMN_REFUSALS)[number];

export type ColumnCheck = { ok: true; read: OrderRead } | { ok: false; reason: ColumnRefusal };

const FIELD_SET: ReadonlySet<string> = new Set(ORDER_FIELDS);

// Whether the mapping reads the file. Refused unless: the file has a header row; every column is one of the header row's and not a buyer column; no field and no column is used twice; the
// order number and the quantity are mapped (the line key instead of the quantity for a platform whose file has a row per unit); at least one line is read; and no row stops the file (any
// skip reason but `no_order_no`, which is a totals or notice row); plus the checks for a mapping that reads without stopping and still misreads (see below). The statuses and the other platform rules are those of the platform's own profile.
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
  // A return status with no order status would read "completed" as a return (stage `returned` moves stock back).
  if (columns.returnStatus !== null && columns.status === null) return { ok: false, reason: 'return_without_status' };
  // An order column that is empty on a row that has a quantity, a SKU, a product or a line key (a notes column taken for the order number) drops real rows without a word; so does one that is empty
  // on more rows than it is filled on. A totals row has an amount and nothing else, and is the only row ignored.
  const noOrder = read.skipped.filter((s) => s.reason === 'no_order_no');
  const filled = (rowNo: number, field: OrderField): boolean => columns[field] !== null && cellText(rows.get(rowNo)?.get(columns[field] as number)) !== '';
  if (noOrder.length > read.lines.length || noOrder.some((s) => (['quantity', 'sku', 'itemName', 'lineKey'] as const).some((f) => filled(s.rowNo, f)))) return { ok: false, reason: 'rows_without_order' };
  // A quantity larger than the amount on most rows that have both is the two columns swapped.
  const both = read.lines.filter((l) => l.amount !== null && !new Decimal(l.amount).isZero());
  if (both.length > 0 && both.filter((l) => new Decimal(l.quantity).greaterThan(new Decimal(l.amount as string).abs())).length * 2 > both.length) return { ok: false, reason: 'quantity_exceeds_amount' };
  // Dates that run backwards on most rows that have both are two date columns swapped (revenue would move months).
  const backwards = (earlier: 'orderedAt' | 'shippedAt', later: 'shippedAt' | 'deliveredAt'): boolean => {
    const pairs = read.lines.filter((l) => l[earlier] !== null && l[later] !== null);
    return pairs.length > 0 && pairs.filter((l) => (l[earlier] as string) > (l[later] as string)).length * 2 > pairs.length;
  };
  if (backwards('orderedAt', 'shippedAt') || backwards('orderedAt', 'deliveredAt') || backwards('shippedAt', 'deliveredAt')) return { ok: false, reason: 'dates_swapped' };
  return { ok: true, read };
}
