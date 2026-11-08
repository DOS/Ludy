// SPDX-License-Identifier: AGPL-3.0-only
// The quote as a Vietnamese A4 document (issue #2695, plan docs/plan/crm-quotes.md step Q3): the seller's letterhead, the title, the number, the dates, the
// buyer, the table of lines with the same amounts the screen shows, the totals, the notes and the terms, and a footer with the page number on every
// page. A long table goes on to further pages with its header row repeated.
//
// It draws what it is given and works out nothing about money: every amount is a string the quote already holds (the shared line-totals rule of
// @crove/l10n-vn made them), written with dots between thousands and a comma for decimals. The words come from the quote and the seller's and buyer's
// own records, never from a customer's message. The logo is not drawn: placing an image would mean reading the file's header, and this writer reads
// no file (the printable page of the link shows it).
import type { Quote, QuoteLine } from '@crove/kernel-contract';
import { writtenVatRate } from '@crove/l10n-vn';
import { quoteFonts, type FontSet, type FontWeight } from './fonts.ts';
import { A4_HEIGHT, A4_WIDTH, PdfDocument, type PdfPage, type Rgb } from './writer.ts';

export interface QuoteParty {
  name: string;
  taxCode: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

// What the document needs besides the quote. `issuedOn` is a day (YYYY-MM-DD), the quote's own and not today's, so the file does not change when it is
// made again; the seller and the buyer are whatever the caller resolved (the live records now, the buyer snapshot of a sent quote later).
export interface QuoteDocument {
  quote: Quote;
  seller: QuoteParty & { bankNote: string | null };
  buyer: QuoteParty;
  issuedOn: string | null;
}

const MARGIN = 40;
const WIDTH = A4_WIDTH - MARGIN * 2;
const TOP = A4_HEIGHT - MARGIN;
// Room kept at the foot of every page for the footer.
const BOTTOM = MARGIN + 28;
const INK: Rgb = [0.1, 0.1, 0.12];
const MUTED: Rgb = [0.4, 0.4, 0.45];
const RULE: Rgb = [0.78, 0.78, 0.82];
const HEADER_FILL: Rgb = [0.93, 0.93, 0.96];
const SIZE = 9;
const LEADING = 12;
const PADDING = 4;

// A number as Vietnamese writes it: a dot between thousands, a comma before the decimals, no trailing zeros.
export function vnNumber(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  // By hand, not with regular expressions that backtrack: a figure is short in practice, but the cost of this must not depend on what it is given.
  const digits = match[2] as string;
  let start = 0;
  while (start < digits.length - 1 && digits[start] === '0') start++;
  let whole = '';
  for (let end = digits.length; end > start; end -= 3) whole = `${digits.slice(Math.max(start, end - 3), end)}${whole === '' ? '' : `.${whole}`}`;
  const decimals = match[3] ?? '';
  let last = decimals.length;
  while (last > 0 && decimals[last - 1] === '0') last--;
  return `${match[1]}${whole}${last > 0 ? `,${decimals.slice(0, last)}` : ''}`;
}

// A day as dd/mm/yyyy.
export function vnDate(day: string | null | undefined): string {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

const STATUS_LABELS: Record<Quote['status'], string> = {
  draft: 'BẢN NHÁP, CHƯA GỬI',
  sent: '',
  accepted: 'KHÁCH ĐÃ CHẤP NHẬN',
  declined: 'KHÁCH ĐÃ TỪ CHỐI',
  superseded: 'ĐÃ CÓ BẢN SỬA ĐỔI MỚI HƠN',
};

// Greedy line breaking by measured width; a word longer than the line is cut where it must be. A line break in the text is kept.
export function wrap(fonts: FontSet, text: string, weight: FontWeight, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let current = '';
    const flush = () => {
      if (current !== '') lines.push(current);
      current = '';
    };
    for (const word of paragraph.split(/[ \t]+/).filter((w) => w !== '')) {
      const joined = current === '' ? word : `${current} ${word}`;
      if (fonts.measure(joined, weight, size) <= width) {
        current = joined;
        continue;
      }
      flush();
      if (fonts.measure(word, weight, size) <= width) {
        current = word;
        continue;
      }
      for (const character of word) {
        if (current !== '' && fonts.measure(current + character, weight, size) > width) flush();
        current += character;
      }
    }
    if (current !== '') lines.push(current);
    else if (paragraph.trim() === '') lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

interface Column {
  key: 'no' | 'description' | 'unit' | 'quantity' | 'price' | 'discount' | 'vat' | 'amount';
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
}

const FIXED: Omit<Column, 'width'>[] = [
  { key: 'no', label: 'STT', align: 'center' },
  { key: 'description', label: 'Mô tả', align: 'left' },
  { key: 'unit', label: 'ĐVT', align: 'center' },
  { key: 'quantity', label: 'SL', align: 'right' },
  { key: 'price', label: 'Đơn giá', align: 'right' },
  { key: 'discount', label: 'CK %', align: 'right' },
  { key: 'vat', label: 'VAT', align: 'right' },
  { key: 'amount', label: 'Thành tiền', align: 'right' },
];
// The narrowest each column but the description may be; a figure wider than that widens its column.
const NARROW: Record<string, number> = { no: 24, unit: 36, quantity: 44, price: 72, discount: 32, vat: 36, amount: 80 };
// The widest a unit column grows: a longer unit is broken over lines. The description keeps at least MIN_DESCRIPTION.
const UNIT_MAX = 56;
const MIN_DESCRIPTION = 120;
const MIN_SIZE = 6;

// What a line puts in each column but the description (an item line only).
function values(line: QuoteLine): Record<Exclude<Column['key'], 'no' | 'description'>, string> {
  return {
    unit: line.unit ?? '',
    quantity: vnNumber(line.quantity),
    price: vnNumber(line.unitPrice),
    discount: line.discountPercent !== '0' ? vnNumber(line.discountPercent) : '',
    vat: writtenVatRate(line.vatRate) ?? line.vatRate ?? '',
    amount: vnNumber(line.amount),
  };
}

interface Layout {
  columns: Column[];
  // The size of the figures: the body size, smaller only when the figures of this quote would not fit otherwise.
  size: number;
}

// The columns for this quote: each figure column as wide as its widest figure (never narrower than NARROW), the unit column too up to UNIT_MAX, the
// description the rest. When the description would be left under MIN_DESCRIPTION the figures are written smaller, down to MIN_SIZE.
function layoutFor(fonts: FontSet, lines: readonly QuoteLine[]): Layout {
  const items = lines.filter((l) => l.kind === 'item').map(values);
  for (let size = SIZE; ; size -= 0.5) {
    const widths: Record<string, number> = { ...NARROW };
    for (const column of FIXED) {
      if (column.key === 'description' || column.key === 'no') continue;
      const key = column.key;
      const head = fonts.measure(column.label, 'bold', SIZE) + PADDING * 2;
      const body = items.map((v) => fonts.measure(v[key], 'regular', size) + PADDING * 2);
      widths[key] = Math.max(widths[key] as number, head, ...body);
    }
    widths.unit = Math.min(widths.unit as number, UNIT_MAX);
    const others = Object.values(widths).reduce((a, b) => a + b, 0);
    if (WIDTH - others >= MIN_DESCRIPTION || size <= MIN_SIZE) {
      return { columns: FIXED.map((c) => ({ ...c, width: c.key === 'description' ? WIDTH - others : (widths[c.key] as number) })), size };
    }
  }
}

class Writer {
  readonly fonts: FontSet;
  readonly doc: PdfDocument;
  page!: PdfPage;
  y = TOP;

  constructor(fonts: FontSet, title: string, author: string) {
    this.fonts = fonts;
    this.doc = new PdfDocument(fonts, { title, author });
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage();
    this.y = TOP;
  }

  // Start a new page when fewer than `height` points are left.
  room(height: number, onBreak?: () => void): void {
    if (this.y - height >= BOTTOM) return;
    this.newPage();
    onBreak?.();
  }

  text(x: number, text: string, weight: FontWeight = 'regular', size = SIZE, color: Rgb = INK): void {
    this.page.text(x, this.y - size, text, { weight, size, color });
  }

  right(xRight: number, y: number, text: string, weight: FontWeight, size: number, color: Rgb = INK): void {
    this.page.text(xRight - this.fonts.measure(text, weight, size), y, text, { weight, size, color });
  }

  // Wrapped lines from the current y, one leading each; breaks the page between lines.
  paragraph(text: string, options: { x?: number; width?: number; weight?: FontWeight; size?: number; color?: Rgb } = {}): void {
    const size = options.size ?? SIZE;
    const lines = wrap(this.fonts, text, options.weight ?? 'regular', size, options.width ?? WIDTH);
    for (const line of lines) {
      this.room(LEADING);
      if (line !== '') this.text(options.x ?? MARGIN, line, options.weight ?? 'regular', size, options.color ?? INK);
      this.y -= LEADING;
    }
  }
}

function partyLines(party: QuoteParty): string[] {
  return [
    party.taxCode ? `Mã số thuế: ${party.taxCode}` : '',
    party.address ? `Địa chỉ: ${party.address}` : '',
    party.phone ? `Điện thoại: ${party.phone}` : '',
    party.email ? `Email: ${party.email}` : '',
  ].filter((line) => line !== '');
}

function header(w: Writer, doc: QuoteDocument): void {
  const { quote, seller } = doc;
  const leftWidth = 300;
  const rightEdge = MARGIN + WIDTH;
  const start = w.y;
  // The seller on the left.
  for (const line of wrap(w.fonts, seller.name, 'bold', 12, leftWidth)) {
    w.text(MARGIN, line, 'bold', 12);
    w.y -= 15;
  }
  for (const line of partyLines(seller)) {
    for (const part of wrap(w.fonts, line, 'regular', SIZE, leftWidth)) {
      w.text(MARGIN, part, 'regular', SIZE, MUTED);
      w.y -= LEADING;
    }
  }
  const leftEnd = w.y;
  // The title on the right.
  let y = start - 20;
  w.right(rightEdge, y, 'BÁO GIÁ', 'bold', 20);
  y -= 18;
  const number = quote.number ? `Số: ${quote.number}${quote.revision > 1 ? ` (bản sửa đổi ${quote.revision})` : ''}` : 'Số: (chưa có số)';
  w.right(rightEdge, y, number, 'bold', SIZE);
  y -= LEADING;
  if (doc.issuedOn) {
    w.right(rightEdge, y, `Ngày lập: ${vnDate(doc.issuedOn)}`, 'regular', SIZE);
    y -= LEADING;
  }
  w.right(rightEdge, y, `Có hiệu lực đến: ${vnDate(quote.validUntil)}`, 'regular', SIZE);
  y -= LEADING;
  const status = quote.expired ? 'ĐÃ HẾT HẠN' : STATUS_LABELS[quote.status];
  if (status) {
    w.right(rightEdge, y, status, 'bold', SIZE, MUTED);
    y -= LEADING;
  }
  w.y = Math.min(leftEnd, y) - 6;
  w.page.line(MARGIN, w.y, MARGIN + WIDTH, w.y, { color: RULE });
  w.y -= 14;
}

function buyer(w: Writer, doc: QuoteDocument): void {
  w.text(MARGIN, 'Kính gửi:', 'regular', SIZE, MUTED);
  w.y -= LEADING;
  for (const line of wrap(w.fonts, doc.buyer.name, 'bold', 11, WIDTH)) {
    w.text(MARGIN, line, 'bold', 11);
    w.y -= 14;
  }
  for (const line of partyLines(doc.buyer)) w.paragraph(line);
  w.y -= 8;
}

function tableHeader(w: Writer, layout: Layout): void {
  const height = LEADING + PADDING * 2;
  w.page.rect(MARGIN, w.y - height, WIDTH, height, { fill: HEADER_FILL });
  let x = MARGIN;
  for (const c of layout.columns) {
    cell(w, c, x, w.y - PADDING - SIZE, c.label, 'bold', SIZE);
    x += c.width;
  }
  w.y -= height;
}

function cell(w: Writer, column: Column, x: number, baseline: number, text: string, weight: FontWeight, size: number): void {
  const inner = column.width - PADDING * 2;
  const width = w.fonts.measure(text, weight, size);
  const at = column.align === 'right' ? x + column.width - PADDING - width : column.align === 'center' ? x + PADDING + (inner - width) / 2 : x + PADDING;
  w.page.text(at, baseline, text, { weight, size, color: INK });
}

function row(w: Writer, layout: Layout, line: QuoteLine, number: number | null): void {
  const [numberColumn, description, unitColumn] = layout.columns as [Column, Column, Column];
  const isText = line.kind === 'text';
  // A line of free text uses the whole width after the number; an item's description keeps its column, and a unit too long for its column is broken.
  const textWidth = isText ? WIDTH - numberColumn.width - PADDING * 2 : description.width - PADDING * 2;
  const wrapped = wrap(w.fonts, line.description, 'regular', SIZE, textWidth);
  const cells = isText ? undefined : values(line);
  const unitLines = cells ? wrap(w.fonts, cells.unit, 'regular', layout.size, unitColumn.width - PADDING * 2) : [];
  const height = Math.max(wrapped.length, unitLines.length) * LEADING + PADDING * 2;
  w.room(height, () => tableHeader(w, layout));
  const baseline = w.y - PADDING - SIZE;
  let x = MARGIN;
  for (const c of layout.columns) {
    if (c.key === 'no') {
      if (number !== null) cell(w, c, x, baseline, String(number), 'regular', SIZE);
    } else if (c.key === 'description') {
      const left = isText ? MARGIN + numberColumn.width + PADDING : x + PADDING;
      wrapped.forEach((part, i) => part !== '' && w.page.text(left, baseline - i * LEADING, part, { weight: 'regular', size: SIZE, color: INK }));
    } else if (cells && c.key === 'unit') {
      unitLines.forEach((part, i) => part !== '' && cell(w, c, x, baseline - i * LEADING, part, 'regular', layout.size));
    } else if (cells) {
      cell(w, c, x, baseline, cells[c.key], 'regular', layout.size);
    }
    x += c.width;
  }
  w.y -= height;
  w.page.line(MARGIN, w.y, MARGIN + WIDTH, w.y, { color: RULE, width: 0.3 });
}

function totals(w: Writer, quote: Quote): void {
  const rates = new Set(quote.lines.filter((l) => l.kind === 'item' && l.vatRate !== null && l.vatAmount !== '0').map((l) => writtenVatRate(l.vatRate) ?? l.vatRate));
  const vatLabel = rates.size === 1 ? `Thuế GTGT (${[...rates][0]})` : 'Thuế GTGT';
  const rows: Array<[string, string, FontWeight]> = [
    ['Cộng tiền hàng', vnNumber(quote.subtotal), 'regular'],
    [vatLabel, vnNumber(quote.vatAmount), 'regular'],
    ['Tổng cộng (VND)', vnNumber(quote.total), 'bold'],
  ];
  const edge = MARGIN + WIDTH - PADDING;
  // The labels end where the widest figure begins, so a long total never runs into its label.
  const widest = Math.max(...rows.map(([, value, weight]) => w.fonts.measure(value, weight, SIZE)));
  const labelEdge = edge - Math.max(100, widest + 14);
  w.room(rows.length * (LEADING + 2) + 16);
  w.y -= 8;
  for (const [label, value, weight] of rows) {
    if (weight === 'bold') w.page.line(labelEdge - 110, w.y + 2, MARGIN + WIDTH, w.y + 2, { color: RULE });
    const baseline = w.y - SIZE - 2;
    w.right(labelEdge, baseline, label, weight, SIZE);
    w.right(edge, baseline, value, weight, SIZE);
    w.y -= LEADING + 2;
  }
  w.y -= 10;
}

function section(w: Writer, title: string, text: string | null): void {
  if (text === null || text.trim() === '') return;
  w.room(LEADING * 3);
  w.text(MARGIN, title, 'bold', SIZE);
  w.y -= LEADING + 2;
  w.paragraph(text);
  w.y -= 8;
}

function footers(w: Writer, doc: QuoteDocument): void {
  const total = w.doc.pages.length;
  const label = `${doc.seller.name} · Báo giá${doc.quote.number ? ` ${doc.quote.number}` : ''}`;
  w.doc.pages.forEach((page, i) => {
    page.line(MARGIN, MARGIN + 14, MARGIN + WIDTH, MARGIN + 14, { color: RULE, width: 0.3 });
    const fit = wrap(w.fonts, label, 'regular', 8, WIDTH - 80)[0] ?? '';
    page.text(MARGIN, MARGIN, fit, { weight: 'regular', size: 8, color: MUTED });
    const text = `Trang ${i + 1}/${total}`;
    page.text(MARGIN + WIDTH - w.fonts.measure(text, 'regular', 8), MARGIN, text, { weight: 'regular', size: 8, color: MUTED });
  });
}

// The document's bytes. The same input gives the same bytes.
export function renderQuotePdf(doc: QuoteDocument, fonts: FontSet = quoteFonts()): Uint8Array {
  const w = new Writer(fonts, `Báo giá${doc.quote.number ? ` ${doc.quote.number}` : ''}`, doc.seller.name);
  header(w, doc);
  buyer(w, doc);
  w.text(MARGIN, 'Đơn vị tiền tệ: đồng Việt Nam (VND)', 'regular', 8, MUTED);
  w.y -= 14;
  const layout = layoutFor(fonts, doc.quote.lines);
  tableHeader(w, layout);
  let number = 0;
  for (const line of doc.quote.lines) {
    if (line.kind === 'item') number += 1;
    row(w, layout, line, line.kind === 'item' ? number : null);
  }
  totals(w, doc.quote);
  section(w, 'Ghi chú', doc.quote.notes);
  section(w, 'Điều khoản và điều kiện', doc.quote.terms);
  section(w, 'Thông tin thanh toán', doc.seller.bankNote);
  footers(w, doc);
  return w.doc.toBytes();
}
