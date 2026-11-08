// SPDX-License-Identifier: AGPL-3.0-only
// A minimal PDF writer (issue #2695, plan docs/plan/crm-quotes.md step Q3, no new package): A4 pages with text, rules and rectangles, and the
// committed Vietnamese font embedded as a CID font (Identity-H, one glyph number per character) with its widths and a ToUnicode map, so the text
// shows right and copies and searches as the words it is.
//
// It only writes. Nothing here reads a PDF or any input a customer or a member supplied as a file: the things it takes are text and a logo image
// already read and checked by ./image.ts (plain samples or the JPEG file as it is, with its size). Text goes into the page as glyph numbers in
// hexadecimal strings, never as a PDF string, so no character can close one or start an operator; the document's title is hexadecimal UTF-16 for
// the same reason. A character the font has not is drawn as a question mark. An image is an XObject whose dictionary holds only numbers and fixed names.
//
// The output is deterministic: no date, no random id (the file id is a hash of the file's own bytes), objects in a fixed order, the same zlib level.
// The same document gives the same bytes, so a mail sent again carries the same file.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { clean, type FontFace, type FontSet, type FontWeight } from './fonts.ts';
import type { PdfImage } from './image.ts';

export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

// Red, green, blue, each 0 to 1.
export type Rgb = readonly [number, number, number];

export interface TextStyle {
  weight: FontWeight;
  size: number;
  color?: Rgb;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
}

// A number as the content stream writes it: two decimals at most, no exponent, no trailing zeros.
function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error('not a finite number');
  const text = value.toFixed(2);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
const colour = (c: Rgb): string => c.map(num).join(' ');

// A text string as hexadecimal UTF-16 with its byte-order mark.
function textString(value: string): string {
  const units: string[] = [];
  for (let i = 0; i < value.length; i++) units.push(hex4(value.charCodeAt(i)));
  return `<FEFF${units.join('')}>`;
}

export class PdfPage {
  readonly width = A4_WIDTH;
  readonly height = A4_HEIGHT;
  readonly ops: string[] = [];
  private readonly fonts: FontSet;
  private readonly use: (face: FontFace, glyph: number, codePoint: number) => number;
  private readonly useImage: (image: PdfImage) => string;

  constructor(fonts: FontSet, use: (face: FontFace, glyph: number, codePoint: number) => number, useImage: (image: PdfImage) => string = () => '') {
    this.fonts = fonts;
    this.use = use;
    this.useImage = useImage;
  }

  // An image with its lower left corner at (x, y), drawn width by height points.
  image(image: PdfImage, x: number, y: number, width: number, height: number): void {
    const name = this.useImage(image);
    if (name === '') return;
    this.ops.push(`q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(y)} cm /${name} Do Q`);
  }

  // Text with its baseline starting at (x, y), y counted from the bottom of the page.
  text(x: number, y: number, text: string, style: TextStyle): void {
    const runs = this.fonts.shape(text, style.weight);
    if (runs.length === 0) return;
    const at = style.color ? colour(style.color) : '0 0 0';
    let cursor = x;
    for (const run of runs) {
      const index = this.use(run.face, 0, 0);
      const codes = run.glyphs.map((glyph, i) => {
        this.use(run.face, glyph, run.codePoints[i] as number);
        return hex4(glyph);
      });
      this.ops.push(`q ${at} rg BT /F${index} ${num(style.size)} Tf ${num(cursor)} ${num(y)} Td <${codes.join('')}> Tj ET Q`);
      cursor += (run.width * style.size) / 1000;
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { width?: number; color?: Rgb } = {}): void {
    this.ops.push(`q ${colour(options.color ?? [0, 0, 0])} RG ${num(options.width ?? 0.5)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q`);
  }

  rect(x: number, y: number, width: number, height: number, options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {}): void {
    const parts = ['q'];
    if (options.fill) parts.push(`${colour(options.fill)} rg`);
    if (options.stroke) parts.push(`${colour(options.stroke)} RG ${num(options.lineWidth ?? 0.5)} w`);
    parts.push(`${num(x)} ${num(y)} ${num(width)} ${num(height)} re ${options.fill && options.stroke ? 'B' : options.fill ? 'f' : 'S'} Q`);
    this.ops.push(parts.join(' '));
  }
}

interface Used {
  face: FontFace;
  index: number;
  glyphs: Map<number, number>;
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  private readonly fonts: FontSet;
  private readonly info: PdfInfo;
  private readonly used = new Map<FontFace, Used>();
  private readonly images: PdfImage[] = [];

  constructor(fonts: FontSet, info: PdfInfo = {}) {
    this.fonts = fonts;
    this.info = info;
  }

  addPage(): PdfPage {
    const page = new PdfPage(this.fonts, (face, glyph, codePoint) => {
      let entry = this.used.get(face);
      if (!entry) {
        entry = { face, index: this.used.size + 1, glyphs: new Map() };
        this.used.set(face, entry);
      }
      if (glyph !== 0 && !entry.glyphs.has(glyph)) entry.glyphs.set(glyph, codePoint);
      return entry.index;
    }, (image) => {
      let index = this.images.indexOf(image);
      if (index === -1) index = this.images.push(image) - 1;
      return `Im${index + 1}`;
    });
    this.pages.push(page);
    return page;
  }

  toBytes(): Uint8Array {
    if (this.pages.length === 0) throw new Error('a PDF needs a page');
    const objects: Buffer[] = [];
    const add = (body: string | Buffer): number => objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    const stream = (dictionary: string, data: Buffer, extra = ''): Buffer => {
      const packed = deflateSync(data, { level: 9 });
      return Buffer.concat([Buffer.from(`<< ${dictionary}${extra} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream', 'latin1')]);
    };

    // Object numbers are fixed up front: 1 the catalog, 2 the page tree, 3 the information, then five objects per font, then two per page.
    const fonts = [...this.used.values()].sort((a, b) => a.index - b.index);
    const fontBase = 4;
    const pageBase = fontBase + fonts.length * 5;
    const resources = fonts.map((f, i) => `/F${f.index} ${fontBase + i * 5} 0 R`).join(' ');
    // Each image is one object, or two when it has an alpha plane (the soft mask first), after the pages.
    let next = pageBase + this.pages.length * 2;
    const imageObjects = this.images.map((image) => {
      const mask = image.alpha ? next++ : null;
      return { image, mask, object: next++ };
    });
    const xobjects = imageObjects.length > 0 ? ` /XObject << ${imageObjects.map((o, i) => `/Im${i + 1} ${o.object} 0 R`).join(' ')} >>` : '';

    add(`<< /Type /Catalog /Pages 2 0 R /Lang (vi-VN) >>`);
    add(`<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ')}] /Resources << /Font << ${resources} >>${xobjects} >> /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] >>`);
    const info = [`/Producer ${textString('Ludy')}`];
    if (this.info.title) info.push(`/Title ${textString(clean(this.info.title))}`);
    if (this.info.author) info.push(`/Author ${textString(clean(this.info.author))}`);
    if (this.info.subject) info.push(`/Subject ${textString(clean(this.info.subject))}`);
    add(`<< ${info.join(' ')} >>`);

    for (const [i, f] of fonts.entries()) {
      const first = fontBase + i * 5;
      const glyphs = [...f.glyphs.entries()].sort((a, b) => a[0] - b[0]);
      const widths = glyphs.map(([glyph]) => `${glyph} [${f.face.advance(glyph)}]`).join(' ');
      add(`<< /Type /Font /Subtype /Type0 /BaseFont /${f.face.name} /Encoding /Identity-H /DescendantFonts [${first + 1} 0 R] /ToUnicode ${first + 4} 0 R >>`);
      add(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.face.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${first + 2} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths}] >>`,
      );
      add(
        `<< /Type /FontDescriptor /FontName /${f.face.name} /Flags 4 /FontBBox [${f.face.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${f.face.ascent} /Descent ${f.face.descent} /CapHeight ${f.face.capHeight} /StemV ${f.face.weight === 'bold' ? 140 : 80} /FontFile2 ${first + 3} 0 R >>`,
      );
      add(stream(`/Length1 ${f.face.program.length}`, f.face.program));
      add(stream('', Buffer.from(toUnicode(glyphs), 'latin1')));
    }

    for (const [i, page] of this.pages.entries()) {
      const contents = pageBase + i * 2 + 1;
      add(`<< /Type /Page /Parent 2 0 R /Contents ${contents} 0 R >>`);
      add(stream('', Buffer.from(page.ops.join('\n'), 'latin1')));
    }

    for (const { image, mask, object } of imageObjects) {
      const dictionary = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /BitsPerComponent 8`;
      if (image.alpha && mask !== null) add(stream(`${dictionary} /ColorSpace /DeviceGray`, Buffer.from(image.alpha)));
      const link = mask === null ? '' : ` /SMask ${mask} 0 R`;
      if (image.colour.kind === 'jpeg') {
        const data = Buffer.from(image.colour.data);
        add(Buffer.concat([Buffer.from(`<< ${dictionary} /ColorSpace /${image.space}${link} /Filter /DCTDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
      } else {
        add(stream(`${dictionary} /ColorSpace /${image.space}${link}`, Buffer.from(image.colour.data)));
      }
      if (objects.length !== object) throw new Error('image object numbers out of order');
    }

    // The four bytes above 127 after the version line tell a transfer program the file is binary.
    const head = Buffer.concat([Buffer.from('%PDF-1.7\n%', 'latin1'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n', 'latin1')]);
    const parts: Buffer[] = [head];
    const offsets: number[] = [];
    let at = head.length;
    objects.forEach((body, i) => {
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      offsets.push(at);
      at += chunk.length;
      parts.push(chunk);
    });
    const id = createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 32);
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
    return new Uint8Array(Buffer.concat(parts));
  }
}

// A character code is a glyph number, so the map from glyph number to the text it stands for is what makes the words copyable and searchable.
function toUnicode(glyphs: ReadonlyArray<readonly [number, number]>): string {
  const blocks: string[] = [];
  for (let i = 0; i < glyphs.length; i += 100) {
    const chunk = glyphs.slice(i, i + 100);
    const rows = chunk.map(([glyph, code]) => {
      const text = String.fromCodePoint(code);
      let units = '';
      for (let u = 0; u < text.length; u++) units += hex4(text.charCodeAt(u));
      return `<${hex4(glyph)}> <${units}>`;
    });
    blocks.push(`${chunk.length} beginbfchar\n${rows.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}
