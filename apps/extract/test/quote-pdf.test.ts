// SPDX-License-Identifier: AGPL-3.0-only
// The quote PDF (#2695, docs/plan/crm-quotes.md step Q3) read back by an independent reader. crove-extract is where PDFs are read in this repository (gate
// T12), so the test of what the CRM module's writer wrote lives here and loads the writer by path: the writer itself imports nothing from this package
// and reads no PDF. Every Vietnamese letter must come back as the same letter, text with PDF syntax in it must stay text, the layout must stay inside
// the margins, and the same document must give the same bytes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractImages, extractText, getDocumentProxy } from 'unpdf';
import { quoteFonts } from '../../../modules/crm/src/pdf/fonts.ts';
import { readLogoImage } from '../../../modules/crm/src/pdf/image.ts';
import { gradient, jpeg, png } from '../../../modules/crm/test/png-fixture.ts';
import { renderQuotePdf, vnDate, vnNumber, wrap, type QuoteDocument } from '../../../modules/crm/src/pdf/quote-document.ts';
import { A4_HEIGHT, A4_WIDTH, PdfDocument } from '../../../modules/crm/src/pdf/writer.ts';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const bare = (text: string) => text.replace(/\s+/g, '');

async function read(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  return { pdf, totalPages, pages: text as string[] };
}

const LOWER = 'aàáảãạăằắẳẵặâầấẩẫậeèéẻẽẹêềếểễệiìíỉĩịoòóỏõọôồốổỗộơờớởỡợuùúủũụưừứửữựyỳýỷỹỵđ';
const LETTERS = LOWER + LOWER.toUpperCase();
const SIGNS = '0123456789 .,;:-+()/%&@#*_=<>?!"\'₫–—…•·×°';

function drawn(lines: string[], weight: 'regular' | 'bold' = 'regular') {
  const doc = new PdfDocument(quoteFonts(), { title: 'Thử' });
  const page = doc.addPage();
  lines.forEach((line, i) => page.text(40, 800 - i * 14, line, { weight, size: 10 }));
  return doc.toBytes();
}

describe('the font', () => {
  it('has every character the document writes, in both weights, so none becomes a question mark', () => {
    const fonts = quoteFonts();
    for (const weight of ['regular', 'bold'] as const) {
      for (const character of LETTERS + SIGNS) {
        if (character === ' ') continue;
        const runs = fonts.shape(character, weight);
        expect(runs.map((r) => r.codePoints).flat(), `${weight} ${character}`).toEqual([character.codePointAt(0)]);
      }
    }
  });

  it('is the committed files: the sha256 of each file is the one SOURCE.md lists', () => {
    const directory = new URL('../../../modules/crm/assets/fonts/be-vietnam-pro/', import.meta.url);
    const source = readFileSync(new URL('SOURCE.md', directory), 'utf8');
    const listed = [...source.matchAll(/\| `([^`]+\.woff)` \| `([0-9a-f]{64})` \|/g)];
    expect(listed.map((m) => m[1]).sort()).toEqual(
      ['latin', 'latin-ext', 'vietnamese'].flatMap((subset) => ['400', '700'].map((weight) => `be-vietnam-pro-${subset}-${weight}-normal.woff`)).sort(),
    );
    for (const [, file, sha] of listed) expect(createHash('sha256').update(readFileSync(new URL(file as string, directory))).digest('hex'), file).toBe(sha);
    expect(readFileSync(new URL('OFL.txt', directory), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});

describe('the writer, read back by unpdf', () => {
  it('brings every Vietnamese letter back as the same letter, in regular and in bold', async () => {
    const rows = LETTERS.match(/.{1,22}/gu) as string[];
    for (const weight of ['regular', 'bold'] as const) {
      const { pages, totalPages } = await read(drawn(rows, weight));
      expect(totalPages).toBe(1);
      expect(bare(pages[0] as string)).toBe(bare(rows.join('')));
    }
  });

  it('brings the digits, the punctuation and the dong sign back too', async () => {
    const { pages } = await read(drawn([`${SIGNS} 1.234.567 ₫ – 10% (VAT)`]));
    expect(squash(pages[0] as string)).toBe(squash(`${SIGNS} 1.234.567 ₫ – 10% (VAT)`));
  });

  it('keeps text that looks like PDF syntax as text: parentheses, backslash, percent, dictionary and stream words', async () => {
    const hostile = ['Giảm (10%) \\ tổng << /Type /Catalog >> [ ] ) ( \\) \\( %%EOF', 'endstream endobj xref trailer 0 obj /JS (app.alert(1)) /Launch'];
    const { pages, totalPages } = await read(drawn(hostile));
    expect(totalPages).toBe(1);
    expect(squash(pages[0] as string)).toBe(squash(hostile.join(' ')));
  });

  it('draws a character the font has not as a question mark, and drops control and direction characters', async () => {
    const { pages } = await read(drawn(['x \u{1f600}日本 y', 'a\u0000b‮c​d\te f']));
    expect(squash(pages[0] as string)).toBe('x ??? y a bcd e f');
  });

  it('gives the same bytes for the same document', () => {
    const lines = ['Báo giá', 'Đặng Thị Hằng 1.234.567 ₫'];
    expect(Buffer.from(drawn(lines)).equals(Buffer.from(drawn(lines)))).toBe(true);
    expect(Buffer.from(drawn(lines)).equals(Buffer.from(drawn([...lines, 'khác'])))).toBe(false);
  });

  it('writes a file a second reader takes: A4, a title, no date, a file id', async () => {
    const bytes = drawn(['Báo giá']);
    const { pdf } = await read(bytes);
    const head = Buffer.from(bytes).toString('latin1');
    expect(head.startsWith('%PDF-1.7\n')).toBe(true);
    expect(head.endsWith('%%EOF\n')).toBe(true);
    expect(head).not.toMatch(/CreationDate|ModDate/);
    expect(head).toMatch(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
    const page = await pdf.getPage(1);
    expect(page.view.map((n: number) => Math.round(n))).toEqual([0, 0, 595, 842]);
    const info = (await pdf.getMetadata()).info as { Title?: string };
    expect(info.Title).toBe('Thử');
  });
});

describe('the number, the date and the line breaking', () => {
  it('writes numbers with dots between thousands and a comma before decimals', () => {
    expect(vnNumber('1234567.8900')).toBe('1.234.567,89');
    expect(vnNumber('1500000')).toBe('1.500.000');
    expect(vnNumber('-1500')).toBe('-1.500');
    expect(vnNumber('0.5')).toBe('0,5');
    expect(vnNumber('2.50')).toBe('2,5');
    expect(vnNumber('100')).toBe('100');
    expect(vnNumber('000123')).toBe('123');
    expect(vnNumber('0')).toBe('0');
    expect(vnNumber('0.000')).toBe('0');
    expect(vnNumber('1000')).toBe('1.000');
    expect(vnNumber('123456')).toBe('123.456');
    expect(vnNumber('1234567890.100')).toBe('1.234.567.890,1');
    // Its cost does not grow with a long run of zeros (a regular expression that backtracks would).
    const started = Date.now();
    expect(vnNumber(`${'0'.repeat(200_000)}1.${'0'.repeat(200_000)}1`).endsWith(',' + '0'.repeat(200_000) + '1')).toBe(true);
    expect(vnNumber(`1.${'0'.repeat(300_000)}`)).toBe('1');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(vnNumber('')).toBe('');
    expect(vnNumber(null)).toBe('');
    expect(vnNumber('khác')).toBe('khác');
    expect(vnDate('2026-11-27')).toBe('27/11/2026');
    expect(vnDate(null)).toBe('');
  });

  it('breaks lines by measured width, keeps a line break and cuts a word longer than the line', () => {
    const fonts = quoteFonts();
    expect(wrap(fonts, 'một hai ba', 'regular', 9, 400)).toEqual(['một hai ba']);
    expect(wrap(fonts, 'a\n\nb', 'regular', 9, 400)).toEqual(['a', '', 'b']);
    const narrow = wrap(fonts, 'Dịch vụ kế toán trọn gói cho doanh nghiệp nhỏ', 'regular', 9, 80);
    expect(narrow.length).toBeGreaterThan(2);
    for (const line of narrow) expect(fonts.measure(line, 'regular', 9)).toBeLessThanOrEqual(80);
    expect(narrow.join(' ')).toBe('Dịch vụ kế toán trọn gói cho doanh nghiệp nhỏ');
    const long = 'x'.repeat(200);
    const cut = wrap(fonts, long, 'regular', 9, 80);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join('')).toBe(long);
    for (const line of cut) expect(fonts.measure(line, 'regular', 9)).toBeLessThanOrEqual(80);
  });
});

function sample(over: Partial<QuoteDocument['quote']> = {}, lineCount = 3): QuoteDocument {
  const lines: QuoteDocument['quote']['lines'] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push({
      lineNo: lines.length + 1,
      kind: 'item',
      description: `Dịch vụ kế toán số ${i}: lập báo cáo thuế, đối chiếu sổ sách và tư vấn cho doanh nghiệp`,
      unit: 'tháng',
      quantity: '2.5',
      unitPrice: '1500000',
      discountPercent: i === 2 ? '10' : '0',
      vatRate: '10%',
      amount: '3750000',
      vatAmount: '375000',
      stockItemId: null,
    });
  }
  if (lineCount > 0) lines.splice(1, 0, { lineNo: 99, kind: 'text', description: 'Gói dịch vụ gồm các hạng mục dưới đây', unit: null, quantity: null, unitPrice: null, discountPercent: '0', vatRate: null, amount: '0', vatAmount: '0', stockItemId: null });
  return {
    quote: {
      id: '00000000-0000-4000-8000-000000000001',
      dealId: '00000000-0000-4000-8000-000000000002',
      dealTitle: 'Gói kế toán năm',
      partyId: '00000000-0000-4000-8000-000000000003',
      partyName: 'Công ty TNHH Đặng Thị Hằng',
      number: 'BG-2026-0007',
      revision: 1,
      revisesId: null,
      status: 'sent',
      expired: false,
      validUntil: '2026-11-29',
      subtotal: '12345678',
      vatAmount: '1234568',
      total: '13580246',
      lineCount,
      version: 1,
      createdBy: 'u',
      createdAt: '2026-11-15T02:00:00.000Z',
      updatedAt: '2026-11-15T02:00:00.000Z',
      notes: 'Giá chưa gồm phí dịch vụ ngân hàng.\nThanh toán trong 7 ngày kể từ ngày nhận hóa đơn.',
      terms: 'Báo giá có hiệu lực trong 14 ngày.',
      // The send's facts (Q2, #2694): this fixture is a quote that was sent by link and not opened yet.
      sentAt: '2026-11-15T02:00:00.000Z',
      sentVia: 'link',
      firstViewedAt: null,
      buyer: null,
      links: [],
      lines,
      ...over,
    },
    seller: { name: 'Công ty Cổ phần Kế toán Ánh Dương', taxCode: '0100000000', address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', phone: '0901 234 567', email: 'ketoan@anhduong.test', bankNote: 'Số tài khoản 0123456789, Ngân hàng Á Châu, chi nhánh Sài Gòn' },
    buyer: { name: 'Công ty TNHH Đặng Thị Hằng', taxCode: null, address: '5 Lê Lợi, Đà Nẵng', phone: null, email: 'mua@hang.test' },
    issuedOn: '2026-11-15',
  };
}

describe('the quote document', () => {
  it('shows the letterhead, the number, the dates, the buyer, the lines with the same amounts, the totals, the notes and the terms', async () => {
    const { pages, totalPages } = await read(renderQuotePdf(sample()));
    expect(totalPages).toBe(1);
    const text = squash(pages[0] as string);
    for (const expected of [
      'Công ty Cổ phần Kế toán Ánh Dương',
      'Địa chỉ: 12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
      'Email: ketoan@anhduong.test',
      'BÁO GIÁ',
      'Số: BG-2026-0007',
      'Ngày lập: 15/11/2026',
      'Có hiệu lực đến: 29/11/2026',
      'Kính gửi:',
      'Công ty TNHH Đặng Thị Hằng',
      'Địa chỉ: 5 Lê Lợi, Đà Nẵng',
      'Gói dịch vụ gồm các hạng mục dưới đây',
      'Đơn giá',
      'Thành tiền',
      'Cộng tiền hàng',
      '12.345.678',
      'Thuế GTGT (10%)',
      '1.234.568',
      'Tổng cộng (VND)',
      '13.580.246',
      'Ghi chú',
      'Thanh toán trong 7 ngày kể từ ngày nhận hóa đơn.',
      'Điều khoản và điều kiện',
      'Báo giá có hiệu lực trong 14 ngày.',
      'Thông tin thanh toán',
      'Số tài khoản 0123456789',
      'Trang 1/1',
    ]) {
      expect(text, expected).toContain(expected);
    }
    // A line: the number, the quantity with a decimal comma, the price, the discount, the rate and the amount.
    expect(text).toContain('2,5 1.500.000');
    expect(text).toContain('3.750.000');
    // The tax code the seller has, and none for the buyer.
    expect(text).toContain('Mã số thuế: 0100000000');
    expect(text.split('Mã số thuế').length - 1).toBe(1);
  });

  it('labels a draft, an expired quote and a revision, and has no date or number when it has none', async () => {
    const draft = squash((await read(renderQuotePdf({ ...sample({ status: 'draft', number: null }), issuedOn: null }))).pages[0] as string);
    expect(draft).toContain('BẢN NHÁP, CHƯA GỬI');
    expect(draft).toContain('Số: (chưa có số)');
    expect(draft).not.toContain('Ngày lập');
    const expired = squash((await read(renderQuotePdf(sample({ expired: true })))).pages[0] as string);
    expect(expired).toContain('ĐÃ HẾT HẠN');
    const revision = squash((await read(renderQuotePdf(sample({ revision: 3 })))).pages[0] as string);
    expect(revision).toContain('Số: BG-2026-0007 (bản sửa đổi 3)');
  });

  it('goes on to more pages with the table header on each and the page number in every footer, and keeps the totals together', async () => {
    const { pages, totalPages } = await read(renderQuotePdf(sample({}, 60)));
    expect(totalPages).toBeGreaterThan(2);
    pages.forEach((page, i) => {
      const text = squash(page);
      expect(text, `page ${i + 1}`).toContain('Thành tiền');
      expect(text, `page ${i + 1}`).toContain(`Trang ${i + 1}/${totalPages}`);
      expect(text, `page ${i + 1}`).toContain('Công ty Cổ phần Kế toán Ánh Dương · Báo giá BG-2026-0007');
    });
    const last = squash(pages[totalPages - 1] as string);
    expect(last).toContain('Tổng cộng (VND)');
    expect(last).toContain('13.580.246');
    expect(last).toContain('Điều khoản và điều kiện');
    // Every line is somewhere: 60 items, each with its own description.
    const all = squash(pages.join(' '));
    expect(all.split('lập báo cáo thuế').length - 1).toBe(60);
  });

  it('keeps every word inside the margins, also a word longer than its column and a long number', async () => {
    const wide = 'Siêu'.repeat(80);
    const document = sample({ notes: `Ghi chú dài ${wide}`, terms: wide }, 2);
    const first = document.quote.lines[0];
    if (first) Object.assign(first, { description: wide, unit: 'rất dài tháng', quantity: '123456789012', unitPrice: '999999999999999', amount: '999999999999999' });
    const bytes = renderQuotePdf(document);
    const { pdf, pages } = await read(bytes);
    expect(bare(pages.join(''))).toContain(wide.slice(0, 40));
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      for (const item of content.items as Array<{ str: string; transform: number[]; width: number }>) {
        if (item.str.trim() === '') continue;
        expect(item.transform[4] as number, item.str).toBeGreaterThanOrEqual(39);
        expect((item.transform[4] as number) + item.width, item.str).toBeLessThanOrEqual(A4_WIDTH - 39);
      }
    }
  });

  it('does not let long figures or a long unit run into their neighbours: columns widen to the widest figure and a long unit is broken', async () => {
    const document = sample({ total: '99999999999999999', subtotal: '99999999999999999', vatAmount: '8888888888888888' }, 2);
    for (const line of document.quote.lines) {
      if (line.kind === 'item') Object.assign(line, { unit: 'thùng carton lớn', quantity: '1234567.123', unitPrice: '10000000000', amount: '999999999999999' });
    }
    const { pdf } = await read(renderQuotePdf(document));
    for (let n = 1; n <= pdf.numPages; n++) {
      const items = ((await (await pdf.getPage(n)).getTextContent()).items as Array<{ str: string; transform: number[]; width: number }>).filter((i) => i.str.trim() !== '');
      for (const item of items) {
        const same = items.filter((o) => o !== item && Math.abs((o.transform[5] as number) - (item.transform[5] as number)) < 0.5 && (o.transform[4] as number) > (item.transform[4] as number));
        for (const other of same) expect((item.transform[4] as number) + item.width, `${item.str} | ${other.str}`).toBeLessThanOrEqual((other.transform[4] as number) + 0.1);
      }
    }
    const text = squash((await read(renderQuotePdf(document))).pages.join(' '));
    for (const figure of ['1.234.567,123', '10.000.000.000', '999.999.999.999.999', '99.999.999.999.999.999', '8.888.888.888.888.888']) expect(text, figure).toContain(figure);
    // A short unit stays on one line.
    expect(wrap(quoteFonts(), 'tháng', 'regular', 9, 52)).toEqual(['tháng']);
  });

  it('writes a file that is well formed to the byte: every xref entry points at its object, startxref at the table, and each embedded font adds up', () => {
    const bytes = Buffer.from(renderQuotePdf(sample({}, 30)));
    const text = bytes.toString('latin1');
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(start, start + 5)).toBe('xref\n');
    const table = /^xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer/.exec(text.slice(start));
    const count = Number(table?.[1]);
    const entries = (table?.[2] ?? '').match(/[\s\S]{20}/g) ?? [];
    expect(entries).toHaveLength(count);
    expect(entries[0]).toBe('0000000000 65535 f \n');
    entries.slice(1).forEach((entry, i) => {
      const at = Number(entry.slice(0, 10));
      expect(text.slice(at, at + `${i + 1} 0 obj\n`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj\n`);
      expect(text.slice(at).indexOf('endobj\n')).toBeGreaterThan(0);
    });
    expect(text).toContain(`/Size ${count}`);
    // Each stream's /Length is the bytes between the keywords.
    for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const from = (m.index as number) + m[0].length;
      expect(text.slice(from + Number(m[1]), from + Number(m[1]) + '\nendstream'.length)).toBe('\nendstream');
    }
    // The fonts: a TrueType file whose directory checksums are right and whose whole sums to the magic number a reader checks.
    const sum = (data: Buffer) => {
      let total = 0;
      for (let i = 0; i < data.length; i += 4) total = (total + data.readUInt32BE(i)) >>> 0;
      return total;
    };
    const faces = new Set(['regular', 'bold'].flatMap((weight) => quoteFonts().shape('Aà ạ Đ ₫', weight as 'regular' | 'bold').map((run) => run.face)));
    expect(faces.size).toBeGreaterThanOrEqual(4);
    for (const face of faces) {
      const font = face.program;
      expect(font.readUInt32BE(0)).toBe(0x00010000);
      expect(sum(font), face.name).toBe(0xb1b0afba);
      const tables = font.readUInt16BE(4);
      for (let i = 0; i < tables; i++) {
        const at = 12 + i * 16;
        const tag = font.toString('latin1', at, at + 4);
        const offset = font.readUInt32BE(at + 8);
        const length = font.readUInt32BE(at + 12);
        expect(offset % 4, `${face.name} ${tag}`).toBe(0);
        const data = Buffer.from(font.subarray(offset, offset + ((length + 3) & ~3)));
        if (tag === 'head') data.writeUInt32BE(0, 8);
        expect(sum(data), `${face.name} ${tag}`).toBe(font.readUInt32BE(at + 4));
      }
    }
  });

  it('gives the same bytes for the same quote, and other bytes when the quote changes', () => {
    const a = renderQuotePdf(sample());
    expect(Buffer.from(renderQuotePdf(sample())).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(renderQuotePdf(sample({ total: '1' }))).equals(Buffer.from(a))).toBe(false);
  });

  it('keeps customer text from becoming PDF syntax: a description made of operators and string ends is text', async () => {
    const hostile = ') Tj ET /F1 40 Tf (x) Tj BT << /S /JavaScript /JS (app.alert(1)) >> endobj';
    const document = sample({ notes: hostile }, 1);
    Object.assign(document.quote.lines[0] ?? {}, { description: hostile });
    document.buyer.name = hostile;
    const { pages, totalPages } = await read(renderQuotePdf(document));
    expect(totalPages).toBe(1);
    const text = squash(pages[0] as string);
    expect(text.split(squash(hostile).slice(0, 30)).length - 1).toBeGreaterThanOrEqual(3);
    expect(Buffer.from(renderQuotePdf(document)).toString('latin1')).not.toContain('app.alert');
  });
});

// The logo of the letterhead (#2814): an image the document is handed already read; it goes on the first page at the top left inside the margins, as an image object with its own
// alpha plane when it has one, and a quote without one is the file it always was.
describe('the letterhead logo', () => {
  const rgba = gradient(40, 14, 4).map((v, i) => (i % 4 === 3 ? (v < 100 ? 0 : 255) : v));
  const logoPng = readLogoImage(png({ width: 40, height: 14, colorType: 6, samples: rgba, filters: [0, 1, 2, 3, 4] }), 'image/png');
  const jpegFile = jpeg({ width: 400, height: 100 });
  const logoJpeg = readLogoImage(jpegFile, 'image/jpeg');

  // Every xref entry points at its object and every stream's length is the bytes between the keywords.
  function wellFormed(bytes: Uint8Array): string {
    const text = Buffer.from(bytes).toString('latin1');
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    const table = /^xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer/.exec(text.slice(start));
    const entries = (table?.[2] ?? '').match(/[\s\S]{20}/g) ?? [];
    expect(entries).toHaveLength(Number(table?.[1]));
    entries.slice(1).forEach((entry, i) => {
      const at = Number(entry.slice(0, 10));
      expect(text.slice(at, at + `${i + 1} 0 obj\n`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj\n`);
    });
    for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const from = (m.index as number) + m[0].length;
      expect(text.slice(from + Number(m[1]), from + Number(m[1]) + '\nendstream'.length)).toBe('\nendstream');
    }
    return text;
  }

  // The drawing operator of the image: its box, read from the page's own content stream.
  function box(bytes: Uint8Array, name = 'Im1') {
    const text = Buffer.from(bytes).toString('latin1');
    for (const m of text.matchAll(/stream\n/g)) {
      const from = (m.index as number) + m[0].length;
      const end = text.indexOf('\nendstream', from);
      let content = '';
      try {
        content = inflateSync(Buffer.from(text.slice(from, end), 'latin1')).toString('latin1');
      } catch {
        continue;
      }
      const found = new RegExp(`q ([\\d.]+) 0 0 ([\\d.]+) ([\\d.]+) ([\\d.]+) cm /${name} Do Q`).exec(content);
      if (found) return { width: Number(found[1]), height: Number(found[2]), x: Number(found[3]), y: Number(found[4]) };
    }
    return null;
  }

  it('is read as the two files that the tests use', () => {
    expect(logoPng).toMatchObject({ width: 40, height: 14, space: 'DeviceRGB' });
    expect(logoPng?.alpha).not.toBeNull();
    expect(logoJpeg).toMatchObject({ width: 400, height: 100, colour: { kind: 'jpeg' } });
  });

  it('draws a PNG with its alpha as one image and its soft mask, at the top left of the first page, in its own proportions and inside the margins', async () => {
    const bytes = renderQuotePdf({ ...sample(), logo: logoPng });
    const text = wellFormed(bytes);
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(text).toContain('/SMask ');
    expect(text).toContain('/ColorSpace /DeviceGray');
    expect(text).toContain('/XObject << /Im1 ');
    const at = box(bytes);
    expect(at).not.toBeNull();
    expect(at?.x).toBe(40);
    expect(at?.width).toBeLessThanOrEqual(150);
    expect(at?.height).toBeLessThanOrEqual(54);
    expect((at?.width as number) / (at?.height as number)).toBeCloseTo(40 / 14, 1);
    expect((at?.y as number) + (at?.height as number)).toBeLessThanOrEqual(A4_HEIGHT - 40 + 0.01);
    const { pdf, totalPages } = await read(bytes);
    expect(totalPages).toBe(1);
    const images = await extractImages(pdf, 1);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 40, height: 14 });
  });

  it('embeds a JPEG file as it is', () => {
    const bytes = renderQuotePdf({ ...sample(), logo: logoJpeg });
    const text = wellFormed(bytes);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).not.toContain('/SMask');
    expect(Buffer.from(bytes).indexOf(jpegFile)).toBeGreaterThan(0);
    // 400 by 100 is wider than the box: the width limits it.
    expect(box(bytes)).toMatchObject({ width: 150, height: 37.5 });
  });

  it('puts the logo above the seller and moves nothing of the words: the text is the text of the quote without one', async () => {
    const without = await read(renderQuotePdf(sample()));
    const withLogo = await read(renderQuotePdf({ ...sample(), logo: logoPng }));
    expect(squash(withLogo.pages[0] as string)).toBe(squash(without.pages[0] as string));
    const seller = renderQuotePdf({ ...sample(), logo: logoJpeg });
    expect(box(seller)?.y).toBeGreaterThan(A4_HEIGHT - 40 - 54 - 0.01);
  });

  it('gives the same bytes for the same quote and logo, and the file it always was without one', () => {
    expect(Buffer.from(renderQuotePdf({ ...sample(), logo: logoPng })).equals(Buffer.from(renderQuotePdf({ ...sample(), logo: logoPng })))).toBe(true);
    const plain = Buffer.from(renderQuotePdf(sample()));
    expect(Buffer.from(renderQuotePdf({ ...sample(), logo: null })).equals(plain)).toBe(true);
    expect(plain.toString('latin1')).not.toContain('/XObject');
    expect(Buffer.from(renderQuotePdf({ ...sample(), logo: logoPng })).equals(plain)).toBe(false);
  });

  it('shows it on the first page only, also when the quote goes on to more pages', async () => {
    const bytes = renderQuotePdf({ ...sample({}, 30), logo: logoPng });
    wellFormed(bytes);
    const { pdf, totalPages } = await read(bytes);
    expect(totalPages).toBeGreaterThan(1);
    expect(await extractImages(pdf, 1)).toHaveLength(1);
    expect(await extractImages(pdf, 2)).toHaveLength(0);
  });
});
