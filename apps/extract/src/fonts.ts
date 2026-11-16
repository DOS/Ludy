// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import * as fontkitModule from '@pdf-lib/fontkit';
import { degrees, type Color, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';

export type FontWeight = 'regular' | 'bold';
export type PageRotation = 0 | 90 | 180 | 270;

type FontSubset = 'latin' | 'vietnamese' | 'latin-ext';
type FontKey = `${FontWeight}:${FontSubset}`;
type FontkitInstance = Parameters<PDFDocument['registerFontkit']>[0];

interface FontSpec {
  readonly file: string;
  readonly sha256: string;
}

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/be-vietnam-pro', import.meta.url));
const SUBSET_ORDER: readonly FontSubset[] = ['latin', 'vietnamese', 'latin-ext'];

const FONT_FILES: Record<FontKey, FontSpec> = {
  'regular:latin': {
    file: 'be-vietnam-pro-latin-400-normal.woff',
    sha256: 'c0190200223755a3c52bb47b9cf6c3604f19288599cfbbe5026904d5d439f7d7',
  },
  'regular:latin-ext': {
    file: 'be-vietnam-pro-latin-ext-400-normal.woff',
    sha256: 'efff7513dcb30c597007e5d55f8fe5563d0023b276b120b711fad71e0845a9d5',
  },
  'regular:vietnamese': {
    file: 'be-vietnam-pro-vietnamese-400-normal.woff',
    sha256: '4d50c7991ca377aef28fb1fb24d4ce7ea64d69f6bd2661e7e74fb9d9fef11dc0',
  },
  'bold:latin': {
    file: 'be-vietnam-pro-latin-700-normal.woff',
    sha256: 'f44cc3417bd1fcbddaaec0c02d5383dfcf34a16ef1fc32f8cf179ea4a468861b',
  },
  'bold:latin-ext': {
    file: 'be-vietnam-pro-latin-ext-700-normal.woff',
    sha256: 'f3e8165ac1f16aa7967f7368ebc2b1189acc54abf540312ff97463ed9205af21',
  },
  'bold:vietnamese': {
    file: 'be-vietnam-pro-vietnamese-700-normal.woff',
    sha256: '4fa311d11645e588ac98d0e665920fd55eb0eb624c600d9e5dd007f4b9d5159c',
  },
};

const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'
const WOFF_HEADER_BYTES = 44;
const WOFF_TABLE_ENTRY_BYTES = 20;
const SFNT_HEADER_BYTES = 12;
const SFNT_TABLE_RECORD_BYTES = 16;
const MAX_SFNT_BYTES = 4 * 1024 * 1024;
const MAX_TABLES = 64;

const FALLBACK_CHAR_MAP: Record<string, string> = {
  '\u00a0': ' ',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': ',',
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2026': '...',
  '\u2022': '*',
  '\u2713': 'x',
  '\u2714': 'x',
  '\u2715': 'x',
  '\u2717': 'x',
};

const ROTATION_TRIG: Record<PageRotation, { readonly cos: number; readonly sin: number }> = {
  0: { cos: 1, sin: 0 },
  90: { cos: 0, sin: 1 },
  180: { cos: -1, sin: 0 },
  270: { cos: 0, sin: -1 },
};

// Cached decoded SFNT buffers and fontkit faces across requests; every source WOFF file is verified by SHA-256 on first load.
const cachedSfnt = new Map<FontKey, Uint8Array>();

interface FontkitGlyph {
  readonly bbox?: {
    readonly minY?: number;
    readonly maxY?: number;
  };
}

interface FontkitFace {
  readonly unitsPerEm?: number;
  readonly capHeight?: number;
  readonly ascent?: number;
  glyphForCodePoint?(codePoint: number): FontkitGlyph;
}

const cachedFontkitFaces = new Map<FontKey, FontkitFace>();

interface FontkitModuleShape {
  create?: FontkitInstance['create'];
  default?: FontkitInstance;
}

function resolveFontkit(): FontkitInstance {
  const mod = fontkitModule as FontkitModuleShape;
  if (typeof mod.create === 'function') {
    return { create: mod.create };
  }
  if (mod.default && typeof mod.default.create === 'function') {
    return mod.default;
  }
  throw new Error('Be Vietnam Pro fonts require @pdf-lib/fontkit');
}

interface WoffTable {
  readonly tagBytes: Uint8Array;
  readonly tagSortKey: number;
  readonly offset: number;
  readonly compLength: number;
  readonly origLength: number;
  readonly origChecksum: number;
}

function unwrapWoffToSfnt(woff: Uint8Array, fileName: string): Uint8Array {
  if (woff.byteLength < WOFF_HEADER_BYTES) {
    throw new Error(`Invalid WOFF font header: ${fileName}`);
  }
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  const signature = view.getUint32(0, false);
  const flavor = view.getUint32(4, false);
  const totalWoffLength = view.getUint32(8, false);
  const numTables = view.getUint16(12, false);
  const reserved = view.getUint16(14, false);
  const totalSfntSize = view.getUint32(16, false);

  if (
    signature !== WOFF_SIGNATURE ||
    reserved !== 0 ||
    totalWoffLength !== woff.byteLength ||
    numTables < 1 ||
    numTables > MAX_TABLES ||
    totalSfntSize < SFNT_HEADER_BYTES + numTables * SFNT_TABLE_RECORD_BYTES ||
    totalSfntSize > MAX_SFNT_BYTES
  ) {
    throw new Error(`Invalid WOFF structure: ${fileName}`);
  }

  const directoryEnd = WOFF_HEADER_BYTES + numTables * WOFF_TABLE_ENTRY_BYTES;
  if (directoryEnd > woff.byteLength) {
    throw new Error(`Truncated WOFF table directory: ${fileName}`);
  }

  const tables: WoffTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const entryOffset = WOFF_HEADER_BYTES + i * WOFF_TABLE_ENTRY_BYTES;
    const tagBytes = woff.subarray(entryOffset, entryOffset + 4);
    const tagSortKey = view.getUint32(entryOffset, false);
    const offset = view.getUint32(entryOffset + 4, false);
    const compLength = view.getUint32(entryOffset + 8, false);
    const origLength = view.getUint32(entryOffset + 12, false);
    const origChecksum = view.getUint32(entryOffset + 16, false);

    if (
      compLength > origLength ||
      offset < directoryEnd ||
      offset + compLength > woff.byteLength ||
      origLength > totalSfntSize
    ) {
      throw new Error(`Corrupt WOFF table entry: ${fileName}`);
    }
    tables.push({ tagBytes, tagSortKey, offset, compLength, origLength, origChecksum });
  }

  tables.sort((a, b) => a.tagSortKey - b.tagSortKey);

  const sfnt = new Uint8Array(totalSfntSize);
  const sfntView = new DataView(sfnt.buffer);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  sfntView.setUint32(0, flavor, false);
  sfntView.setUint16(4, numTables, false);
  sfntView.setUint16(6, searchRange, false);
  sfntView.setUint16(8, entrySelector, false);
  sfntView.setUint16(10, rangeShift, false);

  let recordOffset = SFNT_HEADER_BYTES;
  let dataOffset = SFNT_HEADER_BYTES + numTables * SFNT_TABLE_RECORD_BYTES;

  for (const table of tables) {
    const rawSlice = woff.subarray(table.offset, table.offset + table.compLength);
    const tableData =
      table.compLength < table.origLength ? inflateSync(rawSlice, { maxOutputLength: table.origLength }) : rawSlice;
    if (tableData.byteLength !== table.origLength) {
      throw new Error(`Unexpected SFNT table size in ${fileName}`);
    }
    const paddedLength = (table.origLength + 3) & ~3;
    if (dataOffset + paddedLength > sfnt.byteLength) {
      throw new Error(`SFNT table exceeds declared total size in ${fileName}`);
    }

    sfnt.set(table.tagBytes, recordOffset);
    sfntView.setUint32(recordOffset + 4, table.origChecksum, false);
    sfntView.setUint32(recordOffset + 8, dataOffset, false);
    sfntView.setUint32(recordOffset + 12, table.origLength, false);
    sfnt.set(tableData, dataOffset);

    recordOffset += SFNT_TABLE_RECORD_BYTES;
    dataOffset += paddedLength;
  }

  return sfnt;
}

function loadSfntBytes(key: FontKey): Uint8Array {
  const existing = cachedSfnt.get(key);
  if (existing) return existing;

  const spec = FONT_FILES[key];
  const filePath = join(FONT_DIR, spec.file);
  const woff = new Uint8Array(readFileSync(filePath));
  const digest = createHash('sha256').update(woff).digest('hex');
  if (digest !== spec.sha256) {
    throw new Error(`Font integrity check failed for ${spec.file}`);
  }
  const sfnt = unwrapWoffToSfnt(woff, spec.file);
  cachedSfnt.set(key, sfnt);
  return sfnt;
}

function loadFontkitFace(key: FontKey): FontkitFace {
  const existing = cachedFontkitFaces.get(key);
  if (existing) return existing;
  const sfnt = loadSfntBytes(key);
  const face = resolveFontkit().create(sfnt) as unknown as FontkitFace;
  cachedFontkitFaces.set(key, face);
  return face;
}

interface LoadedSubsetFont {
  readonly font: PDFFont;
  readonly face: FontkitFace;
  readonly codePoints: Set<number>;
}

export interface VerticalTextExtents {
  readonly ascentPt: number;
  readonly descentPt: number;
}

export interface FontRun {
  readonly text: string;
  readonly font: PDFFont;
}

export interface DrawTextOptions {
  readonly weight: FontWeight;
  readonly sizePt: number;
  readonly color: Color;
  readonly x: number;
  readonly y: number;
  readonly rotateDeg?: PageRotation | undefined;
}

export class PdfFontContext {
  private readonly pdfDoc: PDFDocument;
  private readonly fonts = new Map<FontKey, LoadedSubsetFont>();

  private constructor(pdfDoc: PDFDocument) {
    this.pdfDoc = pdfDoc;
  }

  static async create(pdfDoc: PDFDocument): Promise<PdfFontContext> {
    pdfDoc.registerFontkit(resolveFontkit());
    const ctx = new PdfFontContext(pdfDoc);
    // Warm the primary Latin and Vietnamese subsets upfront so font fallback never fails.
    await ctx.getSubset('regular', 'latin');
    await ctx.getSubset('regular', 'vietnamese');
    await ctx.getSubset('regular', 'latin-ext');
    return ctx;
  }

  private async getSubset(weight: FontWeight, subset: FontSubset): Promise<LoadedSubsetFont> {
    const key: FontKey = `${weight}:${subset}`;
    const existing = this.fonts.get(key);
    if (existing) return existing;

    const sfnt = loadSfntBytes(key);
    const font = await this.pdfDoc.embedFont(sfnt, { subset: true });
    const face = loadFontkitFace(key);
    const codePoints = new Set(font.getCharacterSet());
    const loaded: LoadedSubsetFont = { font, face, codePoints };
    this.fonts.set(key, loaded);
    return loaded;
  }

  async preloadWeight(weight: FontWeight): Promise<void> {
    for (const subset of SUBSET_ORDER) {
      await this.getSubset(weight, subset);
    }
  }

  private pickSubsetForCodePoint(weight: FontWeight, codePoint: number): LoadedSubsetFont | undefined {
    for (const subset of SUBSET_ORDER) {
      const loaded = this.fonts.get(`${weight}:${subset}`);
      if (loaded && loaded.codePoints.has(codePoint)) {
        return loaded;
      }
    }
    return undefined;
  }

  private pickFontForCodePoint(weight: FontWeight, codePoint: number): PDFFont | undefined {
    return this.pickSubsetForCodePoint(weight, codePoint)?.font;
  }

  private defaultSubset(weight: FontWeight): LoadedSubsetFont {
    const loaded = this.fonts.get(`${weight}:latin`);
    if (!loaded) {
      throw new Error(`Font weight not preloaded: ${weight}`);
    }
    return loaded;
  }

  private defaultFont(weight: FontWeight): PDFFont {
    return this.defaultSubset(weight).font;
  }

  private normalizeControlChars(raw: string, preserveNewlines: boolean): string {
    const unified = raw.normalize('NFC').replace(/\r\n?|[\u2028\u2029]/g, '\n');
    let out = '';
    for (const ch of unified) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (ch === '\n') {
        out += preserveNewlines ? '\n' : ' ';
        continue;
      }
      if (ch === '\t') {
        out += ' ';
        continue;
      }
      // Strip C0/C1 control characters and directional/zero-width formatting characters.
      if (
        cp <= 0x1f ||
        (cp >= 0x7f && cp <= 0x9f) ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2066 && cp <= 0x2069) ||
        cp === 0xfeff
      ) {
        continue;
      }
      out += ch;
    }
    return out;
  }

  async sanitize(raw: string, weight: FontWeight, preserveNewlines = false): Promise<string> {
    await this.preloadWeight(weight);
    const cleaned = this.normalizeControlChars(raw, preserveNewlines);
    let out = '';
    for (const ch of cleaned) {
      if (ch === '\n') {
        out += '\n';
        continue;
      }
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (this.pickFontForCodePoint(weight, cp)) {
        out += ch;
        continue;
      }
      const mapped = FALLBACK_CHAR_MAP[ch];
      if (mapped !== undefined) {
        out += mapped;
        continue;
      }
      out += '?';
    }
    return out;
  }

  async segment(raw: string, weight: FontWeight): Promise<FontRun[]> {
    const text = await this.sanitize(raw, weight, false);
    if (text.length === 0) return [];

    const fallback = this.defaultFont(weight);
    const runs: FontRun[] = [];
    let currentFont: PDFFont | undefined;
    let currentText = '';

    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0x3f;
      const font = this.pickFontForCodePoint(weight, cp) ?? fallback;
      if (font === currentFont) {
        currentText += ch;
      } else {
        if (currentFont && currentText.length > 0) {
          runs.push({ text: currentText, font: currentFont });
        }
        currentFont = font;
        currentText = ch;
      }
    }
    if (currentFont && currentText.length > 0) {
      runs.push({ text: currentText, font: currentFont });
    }
    return runs;
  }

  async measureWidth(raw: string, weight: FontWeight, sizePt: number): Promise<number> {
    const runs = await this.segment(raw, weight);
    let width = 0;
    for (const run of runs) {
      width += run.font.widthOfTextAtSize(run.text, sizePt);
    }
    return width;
  }

  async measureVerticalExtents(raw: string, weight: FontWeight, sizePt: number): Promise<VerticalTextExtents> {
    await this.preloadWeight(weight);
    const text = await this.sanitize(raw, weight, false);
    let maxYEm = Number.NEGATIVE_INFINITY;
    let minYEm = Number.POSITIVE_INFINITY;

    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0x3f;
      const subset = this.pickSubsetForCodePoint(weight, cp) ?? this.defaultSubset(weight);
      const upem = subset.face.unitsPerEm && subset.face.unitsPerEm > 0 ? subset.face.unitsPerEm : 1000;
      const bbox = subset.face.glyphForCodePoint?.(cp)?.bbox;
      if (
        bbox &&
        typeof bbox.maxY === 'number' &&
        Number.isFinite(bbox.maxY) &&
        typeof bbox.minY === 'number' &&
        Number.isFinite(bbox.minY) &&
        bbox.maxY >= bbox.minY
      ) {
        const topEm = bbox.maxY / upem;
        const botEm = bbox.minY / upem;
        if (topEm > maxYEm) maxYEm = topEm;
        if (botEm < minYEm) minYEm = botEm;
      }
    }

    if (!Number.isFinite(maxYEm) || !Number.isFinite(minYEm)) {
      const fallback = this.defaultSubset(weight).face;
      const upem = fallback.unitsPerEm && fallback.unitsPerEm > 0 ? fallback.unitsPerEm : 1000;
      const capEm = (fallback.capHeight && fallback.capHeight > 0 ? fallback.capHeight : (fallback.ascent ?? 740)) / upem;
      return { ascentPt: capEm * sizePt, descentPt: 0 };
    }

    return {
      ascentPt: Math.max(0, maxYEm) * sizePt,
      descentPt: Math.max(0, -minYEm) * sizePt,
    };
  }

  async wrapLines(raw: string, weight: FontWeight, sizePt: number, maxWidthPt: number): Promise<string[]> {
    const cleaned = await this.sanitize(raw, weight, true);
    const paragraphs = cleaned.split('\n');
    const lines: string[] = [];
    const safeMax = Math.max(sizePt * 0.75, maxWidthPt);

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (trimmed.length === 0) {
        lines.push('');
        continue;
      }
      const words = trimmed.split(/\s+/);
      let current = '';

      for (const word of words) {
        const candidate = current.length === 0 ? word : `${current} ${word}`;
        if ((await this.measureWidth(candidate, weight, sizePt)) <= safeMax) {
          current = candidate;
          continue;
        }
        if (current.length > 0) {
          lines.push(current);
          current = '';
        }
        if ((await this.measureWidth(word, weight, sizePt)) <= safeMax) {
          current = word;
          continue;
        }
        // Break an unbroken token (for example a SHA-256 hex digest) on codepoint boundaries.
        let chunk = '';
        for (const ch of word) {
          const next = chunk + ch;
          if (chunk.length > 0 && (await this.measureWidth(next, weight, sizePt)) > safeMax) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk = next;
          }
        }
        current = chunk;
      }

      if (current.length > 0) {
        lines.push(current);
      }
    }

    return lines.length > 0 ? lines : [''];
  }

  async drawText(page: PDFPage, raw: string, options: DrawTextOptions): Promise<number> {
    const runs = await this.segment(raw, options.weight);
    const rot = options.rotateDeg ?? 0;
    const trig = ROTATION_TRIG[rot];
    let x = options.x;
    let y = options.y;
    let totalWidth = 0;

    for (const run of runs) {
      const runWidth = run.font.widthOfTextAtSize(run.text, options.sizePt);
      page.drawText(run.text, {
        x,
        y,
        size: options.sizePt,
        font: run.font,
        color: options.color,
        rotate: degrees(rot),
      });
      x += runWidth * trig.cos;
      y += runWidth * trig.sin;
      totalWidth += runWidth;
    }
    return totalWidth;
  }
}
