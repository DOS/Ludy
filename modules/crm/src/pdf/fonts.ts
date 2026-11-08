// SPDX-License-Identifier: AGPL-3.0-only
// The font the quote PDF embeds (issue #2695, plan docs/plan/crm-quotes.md step Q3): Be Vietnam Pro, regular and bold, under the SIL Open Font
// License, committed in `assets/fonts/be-vietnam-pro/` with its license and a SOURCE note (version, origin, sha256). Nothing is fetched at run time.
//
// Each weight comes as three subsets (latin, latin-ext, vietnamese); together they hold every Vietnamese letter, the digits, the punctuation a
// quote uses and the dong sign. A subset is a WOFF 1 file, which is a zlib wrapper around a TrueType font: `unwrap` undoes it with Node's `zlib`
// and rebuilds the plain font file a PDF embeds. The files are our own, pinned by sha256 and refused when they differ, and the only thing read from
// them is the table of characters and the widths. This module reads no file a customer or a member supplied.
//
// Self-contained on purpose (Node built-ins only): the tests of `apps/extract` load it to read the PDF back with an independent reader.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export type FontWeight = 'regular' | 'bold';

const DIRECTORY = new URL('../../assets/fonts/be-vietnam-pro/', import.meta.url);

// The subsets in the order a character is looked for, and the files' sha256 (SOURCE.md lists the same).
const FILES: Record<FontWeight, ReadonlyArray<{ subset: string; file: string; sha256: string }>> = {
  regular: [
    { subset: 'latin', file: 'be-vietnam-pro-latin-400-normal.woff', sha256: 'c0190200223755a3c52bb47b9cf6c3604f19288599cfbbe5026904d5d439f7d7' },
    { subset: 'latin-ext', file: 'be-vietnam-pro-latin-ext-400-normal.woff', sha256: 'efff7513dcb30c597007e5d55f8fe5563d0023b276b120b711fad71e0845a9d5' },
    { subset: 'vietnamese', file: 'be-vietnam-pro-vietnamese-400-normal.woff', sha256: '4d50c7991ca377aef28fb1fb24d4ce7ea64d69f6bd2661e7e74fb9d9fef11dc0' },
  ],
  bold: [
    { subset: 'latin', file: 'be-vietnam-pro-latin-700-normal.woff', sha256: 'f44cc3417bd1fcbddaaec0c02d5383dfcf34a16ef1fc32f8cf179ea4a468861b' },
    { subset: 'latin-ext', file: 'be-vietnam-pro-latin-ext-700-normal.woff', sha256: 'f3e8165ac1f16aa7967f7368ebc2b1189acc54abf540312ff97463ed9205af21' },
    { subset: 'vietnamese', file: 'be-vietnam-pro-vietnamese-700-normal.woff', sha256: '4fa311d11645e588ac98d0e665920fd55eb0eb624c600d9e5dd007f4b9d5159c' },
  ],
};

export interface FontFace {
  // The font's PostScript-style name in the PDF, one per weight and subset.
  readonly name: string;
  readonly weight: FontWeight;
  // The TrueType font file to embed (the tables a PDF needs, no more).
  readonly program: Buffer;
  readonly bbox: readonly [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  // The glyph of a code point, or 0 when this subset has none.
  glyph(codePoint: number): number;
  // A glyph's advance width in thousandths of an em.
  advance(glyph: number): number;
}

const u16 = (b: Buffer, o: number): number => b.readUInt16BE(o);
const i16 = (b: Buffer, o: number): number => b.readInt16BE(o);
const u32 = (b: Buffer, o: number): number => b.readUInt32BE(o);

// The tables a PDF needs of a TrueType font program embedded as a CID font addressed by glyph number.
const KEPT_TABLES = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep'] as const;

function unwrap(woff: Buffer): Map<string, Buffer> {
  if (woff.length < 44 || woff.toString('latin1', 0, 4) !== 'wOFF' || u32(woff, 4) !== 0x00010000) throw new Error('not a TrueType WOFF file');
  const count = u16(woff, 12);
  if (count === 0 || count > 64) throw new Error('bad WOFF table count');
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    if (at + 20 > woff.length) throw new Error('truncated WOFF directory');
    const tag = woff.toString('latin1', at, at + 4);
    const offset = u32(woff, at + 4);
    const stored = u32(woff, at + 8);
    const length = u32(woff, at + 12);
    if (offset + stored > woff.length) throw new Error('WOFF table out of bounds');
    const raw = woff.subarray(offset, offset + stored);
    const table = stored < length ? inflateSync(raw, { maxOutputLength: length }) : Buffer.from(raw);
    if (table.length !== length) throw new Error('WOFF table length mismatch');
    tables.set(tag, table);
  }
  return tables;
}

const sum32 = (data: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum = (sum + data.readUInt32BE(i)) >>> 0;
  return sum;
};

// A plain TrueType file of the given tables: directory sorted by tag, each table padded to four bytes, checksums right.
function sfnt(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  const padded = tags.map((tag) => {
    const table = tables.get(tag) as Buffer;
    const copy = Buffer.alloc((table.length + 3) & ~3);
    table.copy(copy);
    if (tag === 'head') copy.writeUInt32BE(0, 8);
    return copy;
  });
  const headerSize = 12 + 16 * n;
  const out = Buffer.alloc(headerSize + padded.reduce((total, p) => total + p.length, 0));
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(n * 16 - searchRange, 10);
  let offset = headerSize;
  tags.forEach((tag, i) => {
    const data = padded[i] as Buffer;
    out.write(tag, 12 + i * 16, 4, 'latin1');
    out.writeUInt32BE(sum32(data), 16 + i * 16);
    out.writeUInt32BE(offset, 20 + i * 16);
    out.writeUInt32BE((tables.get(tag) as Buffer).length, 24 + i * 16);
    data.copy(out, offset);
    offset += data.length;
  });
  const headAt = out.readUInt32BE(20 + tags.indexOf('head') * 16);
  out.writeUInt32BE((0xb1b0afba - sum32(out)) >>> 0, headAt + 8);
  return out;
}

// The character table of a font: code point to glyph, from the Unicode format 4 subtable.
function characters(cmap: Buffer): Map<number, number> {
  const map = new Map<number, number>();
  const count = u16(cmap, 2);
  for (let i = 0; i < count; i++) {
    const platform = u16(cmap, 4 + i * 8);
    const encoding = u16(cmap, 6 + i * 8);
    const offset = u32(cmap, 8 + i * 8);
    if (!(platform === 0 || (platform === 3 && encoding === 1)) || u16(cmap, offset) !== 4) continue;
    const segmentsX2 = u16(cmap, offset + 6);
    const ends = offset + 14;
    const starts = ends + segmentsX2 + 2;
    const deltas = starts + segmentsX2;
    const ranges = deltas + segmentsX2;
    for (let s = 0; s < segmentsX2 / 2; s++) {
      const end = u16(cmap, ends + s * 2);
      const start = u16(cmap, starts + s * 2);
      const delta = i16(cmap, deltas + s * 2);
      const range = u16(cmap, ranges + s * 2);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;
        if (range === 0) glyph = (code + delta) & 0xffff;
        else {
          glyph = u16(cmap, ranges + s * 2 + range + (code - start) * 2);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0 && !map.has(code)) map.set(code, glyph);
      }
    }
    break;
  }
  return map;
}

function load(weight: FontWeight, entry: { subset: string; file: string; sha256: string }): FontFace {
  const file = readFileSync(new URL(entry.file, DIRECTORY));
  if (createHash('sha256').update(file).digest('hex') !== entry.sha256) throw new Error(`the font file ${entry.file} is not the one committed (see SOURCE.md)`);
  const tables = unwrap(file);
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !cmap || !tables.has('glyf') || !tables.has('loca') || !tables.has('maxp')) throw new Error(`the font file ${entry.file} lacks a table`);
  const unitsPerEm = u16(head, 18);
  const scale = (value: number): number => Math.round((value * 1000) / unitsPerEm);
  const widths = u16(hhea, 34);
  const glyphs = characters(cmap);
  const program = sfnt(new Map(KEPT_TABLES.flatMap((tag) => (tables.has(tag) ? [[tag, tables.get(tag) as Buffer] as const] : []))));
  return {
    name: `BeVietnamPro-${weight === 'bold' ? 'Bold' : 'Regular'}-${entry.subset}`,
    weight,
    program,
    bbox: [scale(i16(head, 36)), scale(i16(head, 38)), scale(i16(head, 40)), scale(i16(head, 42))],
    ascent: scale(i16(hhea, 4)),
    descent: scale(i16(hhea, 6)),
    capHeight: scale(700),
    glyph: (codePoint) => glyphs.get(codePoint) ?? 0,
    advance: (glyph) => scale(u16(hmtx, Math.min(glyph, widths - 1) * 4)),
  };
}

// A run of text in one font face: the glyphs and the code point each one stands for (for the copyable text), and its width.
export interface Run {
  readonly face: FontFace;
  readonly glyphs: readonly number[];
  readonly codePoints: readonly number[];
  // Width in thousandths of an em.
  readonly width: number;
}

// One character of text as a run may carry it: a control character, a line or paragraph separator and a no-break space become a space; zero-width and
// direction marks go; anything else stays.
function cleanCharacter(character: string): string {
  const code = character.codePointAt(0) as number;
  if (code <= 0x1f || (code >= 0x7f && code <= 0xa0) || code === 0x2028 || code === 0x2029) return ' ';
  if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff) return '';
  return character;
}

// What a run may carry: well-formed, NFC, and no character a PDF viewer could show as something else.
export function clean(text: string): string {
  let out = '';
  for (const character of text.toWellFormed().normalize('NFC')) out += cleanCharacter(character);
  return out;
}

export class FontSet {
  private readonly faces: Record<FontWeight, readonly FontFace[]>;

  constructor(faces: Record<FontWeight, readonly FontFace[]>) {
    this.faces = faces;
  }

  // The text as runs of glyphs. A character no subset holds is drawn as a question mark.
  shape(text: string, weight: FontWeight): Run[] {
    const runs: Array<{ face: FontFace; glyphs: number[]; codePoints: number[]; width: number }> = [];
    for (const character of clean(text)) {
      let code = character.codePointAt(0) as number;
      let found = this.find(code, weight);
      if (!found) {
        code = 0x3f;
        found = this.find(code, weight);
      }
      if (!found) continue;
      let run = runs.at(-1);
      if (!run || run.face !== found.face) {
        run = { face: found.face, glyphs: [], codePoints: [], width: 0 };
        runs.push(run);
      }
      run.glyphs.push(found.glyph);
      run.codePoints.push(code);
      run.width += found.face.advance(found.glyph);
    }
    return runs;
  }

  // The width of the text in points at a size.
  measure(text: string, weight: FontWeight, size: number): number {
    return (this.shape(text, weight).reduce((total, run) => total + run.width, 0) * size) / 1000;
  }

  private find(codePoint: number, weight: FontWeight): { face: FontFace; glyph: number } | undefined {
    for (const face of this.faces[weight]) {
      const glyph = face.glyph(codePoint);
      if (glyph !== 0) return { face, glyph };
    }
    return undefined;
  }
}

let cached: FontSet | undefined;

// The committed font, read once.
export function quoteFonts(): FontSet {
  cached ??= new FontSet({
    regular: FILES.regular.map((entry) => load('regular', entry)),
    bold: FILES.bold.map((entry) => load('bold', entry)),
  });
  return cached;
}
