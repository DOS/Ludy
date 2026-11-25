// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import {
  EXTRACT_LIMITS,
  decodePdfSealInput,
  type PdfDetectedTag,
  type PdfInspectPage,
  type PdfInspectResult,
  type PdfSealCertificate,
  type PdfSealCertificateDocument,
  type PdfSealField,
  type PdfSealOtpStatus,
  type PdfSealResult,
} from '@ludy/extract-contract';
import {
  EncryptedPDFError,
  LineCapStyle,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFContentStream,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectParser,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  clip,
  cmyk,
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
  drawObject,
  endPath,
  grayscale,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type Color,
  type PDFField,
  type PDFForm,
  type PDFImage,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib';
import { PdfFontContext, type FontWeight, type PageRotation } from './fonts.ts';
import { extractPageDeterministicTags, type PdfRawTextItem } from './pdf-tags.ts';

const PDF_MAGIC = '%PDF-';
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MIN_CERT_PAGE_WIDTH_PT = 280;
const MIN_CERT_PAGE_HEIGHT_PT = 360;
const MAX_PDF_GRAPH_NODES = 250_000;
const MAX_PDF_BOX_PT = 20_000;
const MAX_PNG_DIM = 4096;
const MAX_PNG_PIXELS = 4_000_000;
const FIELD_EPSILON = 1e-6;

const RESOURCE_CONTAINER_KEYS = new Set(['Resources', 'DR']);

// ISO 32000-1 Table 33 resource sub-dictionaries map arbitrary producer-chosen resource names to resource objects.
const RESOURCE_MAP_KEYS = new Set([
  'ExtGState',
  'ColorSpace',
  'Pattern',
  'Shading',
  'XObject',
  'Font',
  'Properties',
]);

// ISO 32000-1 Table 168 /AP sub-dictionaries (/N, /R, /D when dicts) map arbitrary appearance state names to Form streams.
const AP_APPEARANCE_KEYS = new Set(['N', 'R', 'D']);

const FORBIDDEN_DICT_KEYS = new Set([
  'JS',
  'JavaScript',
  'Launch',
  'RichMedia',
  'RichMediaExecute',
  'AA',
  'OpenAction',
  'XFA',
  'SubmitForm',
  'ImportData',
  'ResetForm',
  'Encrypt',
  'EmbeddedFiles',
  'EF',
  'AF',
  'Collection',
  '3DD',
  '3DA',
  '3DV',
]);

const FORBIDDEN_ACTION_NAMES = new Set([
  'JavaScript',
  'Launch',
  'RichMedia',
  'RichMediaExecute',
  'SubmitForm',
  'ImportData',
  'ResetForm',
  'Sound',
  'Movie',
  'GoToR',
  'GoToE',
  'GoTo3DView',
  'Rendition',
  'Thread',
]);

const FORBIDDEN_SUBTYPES = new Set(['RichMedia', 'Screen', 'Movie', 'Sound', '3D', 'FileAttachment']);

const PNG_COLOR_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const COLOR_INK = rgb(0.08, 0.11, 0.16);
const COLOR_MUTED = rgb(0.36, 0.42, 0.5);
const COLOR_NAVY = rgb(0.06, 0.16, 0.28);
const COLOR_ACCENT = rgb(0.11, 0.44, 0.85);
const COLOR_BORDER = rgb(0.8, 0.85, 0.9);
const COLOR_CARD_BG = rgb(0.97, 0.98, 0.99);
const COLOR_WHITE = rgb(1, 1, 1);

export class PdfSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfSignError';
  }
}

interface VisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PdfPoint {
  readonly x: number;
  readonly y: number;
}

interface PngInfo {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

function normalizeRotation(angle: number): PageRotation {
  if (!Number.isFinite(angle) || angle % 90 !== 0) {
    throw new PdfSignError('Tệp PDF có góc xoay trang không hợp lệ');
  }
  const normalized = ((angle % 360) + 360) % 360;
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  throw new PdfSignError('Tệp PDF có góc xoay trang không hợp lệ');
}

function assertPdfMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < PDF_MAGIC.length) {
    throw new PdfSignError('Tệp không đúng định dạng PDF');
  }
  const header = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, 16));
  if (!header.startsWith(PDF_MAGIC)) {
    throw new PdfSignError('Tệp không bắt đầu bằng tiêu đề %PDF- hợp lệ');
  }
}

const MIN_RAW_DICT_SCAN_BUDGET_BYTES = 1_048_576;

interface RawPdfNameEscapes {
  readonly escapedTokens: ReadonlyMap<string, string>;
  readonly literalHashTokens: ReadonlySet<string>;
  readonly ambiguousTokens: ReadonlySet<string>;
  readonly sawObjStm: boolean;
  readonly hasUnresolvedIndirectLength: boolean;
}

function decodeRawPdfNameToken(rawToken: string): string {
  return rawToken.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodePdfLibNameToken(rawToken: string): string {
  // Mirrors pdf-lib's PDFName.of decoder, which only resolves uppercase/digit #XX escapes.
  return rawToken.replace(/#([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeLowercasePdfHexEscapes(text: string): string {
  // Only decode #xx escapes containing a lowercase [a-f] digit; #[0-9A-F]{2} in decodeText() came from #23.
  return text.replace(/#([0-9A-F][a-f]|[a-f][0-9A-F]|[a-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeUnnormalizedPdfName(name: PDFName, nameEscapes: RawPdfNameEscapes): string {
  const rawDecoded = name.decodeText();
  if (!rawDecoded.includes('#')) return rawDecoded;
  if (nameEscapes.ambiguousTokens.has(rawDecoded)) {
    throw new PdfSignError('Tệp PDF chứa tên đối tượng xung đột không thể chuẩn hóa an toàn');
  }
  const fallbackDecoded = decodeLowercasePdfHexEscapes(rawDecoded);
  if (nameEscapes.escapedTokens.has(rawDecoded)) {
    const resolved = nameEscapes.escapedTokens.get(rawDecoded) ?? rawDecoded;
    if (nameEscapes.sawObjStm && (fallbackDecoded !== resolved || fallbackDecoded !== rawDecoded)) {
      throw new PdfSignError('Tệp PDF chứa tên đối tượng xung đột không thể chuẩn hóa an toàn');
    }
    return resolved;
  }
  if (nameEscapes.literalHashTokens.has(rawDecoded)) {
    if (nameEscapes.sawObjStm && fallbackDecoded !== rawDecoded) {
      throw new PdfSignError('Tệp PDF chứa tên đối tượng xung đột không thể chuẩn hóa an toàn');
    }
    return rawDecoded;
  }
  if (fallbackDecoded !== rawDecoded) {
    throw new PdfSignError('Tệp PDF chứa tên đối tượng xung đột không thể chuẩn hóa an toàn');
  }
  return rawDecoded;
}

function decodePdfName(name: PDFName): string {
  return name.decodeText();
}

function isPdfWhitespaceCode(code: number): boolean {
  return code === 0x00 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function isPdfDelimiterCode(code: number): boolean {
  // ()<>[]{}/%
  return (
    code === 0x28 ||
    code === 0x29 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x2f ||
    code === 0x25
  );
}

function skipPdfWhitespaceAndComments(raw: string, start: number): number {
  let pos = start;
  while (pos < raw.length) {
    const code = raw.charCodeAt(pos);
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25) {
      // Skip PDF comment to end of line.
      pos += 1;
      while (pos < raw.length) {
        const ch = raw.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    break;
  }
  return pos;
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function skipPdfLiteralString(raw: string, startAfterOpenParen: number, limit = raw.length): number {
  let pos = startAfterOpenParen;
  let parenDepth = 1;
  while (pos < limit && parenDepth > 0) {
    const code = raw.charCodeAt(pos);
    pos += 1;
    if (code === 0x5c) {
      // Skip escaped character after backslash.
      if (pos < limit) pos += 1;
    } else if (code === 0x28) {
      parenDepth += 1;
    } else if (code === 0x29) {
      parenDepth -= 1;
    }
  }
  return pos;
}

function extractRawPdfDictAt(
  raw: string,
  openIdx: number,
  maxScanBytes: number,
): { readonly slice: string | null; readonly scannedBytes: number; readonly budgetHit: boolean } {
  if (raw.charCodeAt(openIdx) !== 0x3c || raw.charCodeAt(openIdx + 1) !== 0x3c) {
    return { slice: null, scannedBytes: 0, budgetHit: false };
  }
  const limit = Math.min(raw.length, openIdx + maxScanBytes);
  let pos = openIdx + 2;
  let depth = 1;
  while (pos < limit && depth > 0) {
    const code = raw.charCodeAt(pos);
    if (code === 0x28) {
      pos = skipPdfLiteralString(raw, pos + 1, limit);
      continue;
    }
    if (code === 0x25) {
      pos += 1;
      while (pos < limit) {
        const ch = raw.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    if (code === 0x3c && pos + 1 < limit && raw.charCodeAt(pos + 1) === 0x3c) {
      depth += 1;
      pos += 2;
      continue;
    }
    if (code === 0x3c) {
      // Single '<' starts a hex string; skip to '>'.
      pos += 1;
      while (pos < limit && raw.charCodeAt(pos) !== 0x3e) {
        pos += 1;
      }
      if (pos < limit) pos += 1;
      continue;
    }
    if (code === 0x3e && pos + 1 < limit && raw.charCodeAt(pos + 1) === 0x3e) {
      depth -= 1;
      pos += 2;
      continue;
    }
    pos += 1;
  }
  if (depth !== 0) {
    return {
      slice: null,
      scannedBytes: pos - openIdx,
      budgetHit: pos >= limit && limit < raw.length,
    };
  }
  return {
    slice: raw.slice(openIdx, pos),
    scannedBytes: pos - openIdx,
    budgetHit: false,
  };
}

function inspectRawDictTopLevelNames(
  dictSlice: string,
  onNameToken?: (rawToken: string) => void,
): {
  hasEncryptKey: boolean;
  isXRefType: boolean;
  isObjStmType: boolean;
  hasEscapedStructuralType: boolean;
  directLength: number | null;
  indirectLengthRef: string | null;
} {
  let hasEncryptKey = false;
  let isXRefType = false;
  let isObjStmType = false;
  let hasEscapedStructuralType = false;
  let directLength: number | null = null;
  let indirectLengthRef: string | null = null;
  let expectTypeValue = false;
  let expectLengthValue = false;
  let pos = 2;
  let depth = 1;
  const end = dictSlice.length - 2;

  while (pos < end && depth > 0) {
    const code = dictSlice.charCodeAt(pos);
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x28) {
      pos = skipPdfLiteralString(dictSlice, pos + 1);
      expectTypeValue = false;
      expectLengthValue = false;
      continue;
    }
    if (code === 0x25) {
      pos += 1;
      while (pos < end) {
        const ch = dictSlice.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    if (code === 0x3c && dictSlice.charCodeAt(pos + 1) === 0x3c) {
      depth += 1;
      pos += 2;
      expectTypeValue = false;
      expectLengthValue = false;
      continue;
    }
    if (code === 0x3c) {
      pos += 1;
      while (pos < end && dictSlice.charCodeAt(pos) !== 0x3e) {
        pos += 1;
      }
      if (pos < end) pos += 1;
      expectTypeValue = false;
      expectLengthValue = false;
      continue;
    }
    if (code === 0x3e && dictSlice.charCodeAt(pos + 1) === 0x3e) {
      depth -= 1;
      pos += 2;
      continue;
    }
    if (code === 0x2f) {
      const nameStart = pos + 1;
      let nameEnd = nameStart;
      while (nameEnd < end) {
        const nc = dictSlice.charCodeAt(nameEnd);
        if (isPdfWhitespaceCode(nc) || isPdfDelimiterCode(nc)) break;
        nameEnd += 1;
      }
      const rawToken = dictSlice.slice(nameStart, nameEnd);
      onNameToken?.(rawToken);
      const decoded = decodeRawPdfNameToken(rawToken);
      if (
        rawToken !== decoded &&
        ESCAPED_STRUCTURAL_PDF_NAMES.has(decoded) &&
        decodePdfLibNameToken(rawToken) !== decoded
      ) {
        hasEscapedStructuralType = true;
      }
      if (depth === 1) {
        if (decoded === 'Encrypt') {
          hasEncryptKey = true;
        }
        if (expectTypeValue) {
          if (decoded === 'XRef') {
            isXRefType = true;
          } else if (decoded === 'ObjStm') {
            isObjStmType = true;
          }
          expectTypeValue = false;
          expectLengthValue = false;
        } else if (decoded === 'Type') {
          expectTypeValue = true;
          expectLengthValue = false;
        } else {
          expectLengthValue = decoded === 'Length';
        }
      } else {
        expectTypeValue = false;
        expectLengthValue = false;
      }
      pos = nameEnd;
      continue;
    }
    if (depth === 1 && expectLengthValue && isAsciiDigitCode(code)) {
      const numStart = pos;
      let numEnd = pos + 1;
      while (numEnd < end && isAsciiDigitCode(dictSlice.charCodeAt(numEnd))) {
        numEnd += 1;
      }
      const afterNum = skipPdfWhitespaceAndComments(dictSlice, numEnd);
      const nextCode = afterNum < end ? dictSlice.charCodeAt(afterNum) : 0x3e;
      // Indirect /Length (<n> <gen> R) has another digit token after the first integer.
      if (!isAsciiDigitCode(nextCode)) {
        const parsed = Number.parseInt(dictSlice.slice(numStart, numEnd), 10);
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
          directLength = parsed;
        }
      } else {
        let genEnd = afterNum + 1;
        while (genEnd < end && isAsciiDigitCode(dictSlice.charCodeAt(genEnd))) {
          genEnd += 1;
        }
        const afterGen = skipPdfWhitespaceAndComments(dictSlice, genEnd);
        if (
          afterGen < end &&
          dictSlice.charCodeAt(afterGen) === 0x52 &&
          (afterGen + 1 >= end ||
            isPdfWhitespaceCode(dictSlice.charCodeAt(afterGen + 1)) ||
            isPdfDelimiterCode(dictSlice.charCodeAt(afterGen + 1)))
        ) {
          indirectLengthRef = `${dictSlice.slice(numStart, numEnd)} ${dictSlice.slice(afterNum, genEnd)} R`;
        }
      }
      expectLengthValue = false;
      pos = numEnd;
      continue;
    }
    expectTypeValue = false;
    expectLengthValue = false;
    pos += 1;
  }

  return {
    hasEncryptKey,
    isXRefType,
    isObjStmType,
    hasEscapedStructuralType,
    directLength,
    indirectLengthRef,
  };
}

type PdfLengthResolver = (refKey: string) => number | undefined;

interface RecentPdfToken {
  readonly text: string;
  readonly start: number;
  readonly isDigits: boolean;
}

function isAllAsciiDigits(token: string): boolean {
  if (token.length === 0) return false;
  for (let i = 0; i < token.length; i += 1) {
    if (!isAsciiDigitCode(token.charCodeAt(i))) return false;
  }
  return true;
}

function parseIndirectObjHeader(
  tok: string,
  recentTokens: readonly RecentPdfToken[],
): { readonly num: number; readonly gen: number; readonly startOffset: number } | null {
  if (tok === 'obj' && recentTokens.length >= 2) {
    const prevGen = recentTokens[recentTokens.length - 1];
    const prevNum = recentTokens[recentTokens.length - 2];
    if (prevGen && prevNum && prevGen.isDigits && prevNum.isDigits) {
      const objNum = Number.parseInt(prevNum.text, 10);
      const objGen = Number.parseInt(prevGen.text, 10);
      if (Number.isSafeInteger(objNum) && Number.isSafeInteger(objGen)) {
        return { num: objNum, gen: objGen, startOffset: prevNum.start };
      }
    }
    return null;
  }
  if (tok.length > 3 && tok.endsWith('obj') && recentTokens.length >= 1) {
    const prevNum = recentTokens[recentTokens.length - 1];
    const genPart = tok.slice(0, -3);
    if (prevNum && prevNum.isDigits && isAllAsciiDigits(genPart)) {
      const objNum = Number.parseInt(prevNum.text, 10);
      const objGen = Number.parseInt(genPart, 10);
      if (Number.isSafeInteger(objNum) && Number.isSafeInteger(objGen)) {
        return { num: objNum, gen: objGen, startOffset: prevNum.start };
      }
    }
  }
  return null;
}

function findPdfStreamDataStart(raw: string, afterDictPos: number): number {
  const sPos = skipPdfWhitespaceAndComments(raw, afterDictPos);
  if (raw.startsWith('stream \r\n', sPos)) {
    return sPos + 9;
  }
  if (raw.startsWith('stream\r\n', sPos) || raw.startsWith('stream\n\r', sPos)) {
    return sPos + 8;
  }
  if (raw.startsWith('stream\n', sPos) || raw.startsWith('stream\r', sPos)) {
    return sPos + 7;
  }
  if (
    raw.startsWith('stream', sPos) &&
    (sPos + 6 >= raw.length || isPdfWhitespaceCode(raw.charCodeAt(sPos + 6)))
  ) {
    return sPos + 6;
  }
  return -1;
}

function findStreamBodyEnd(
  raw: string,
  dataStart: number,
  declaredLength: number | undefined,
  allowUnresolvedEof = false,
): number {
  if (declaredLength !== undefined && declaredLength >= 0 && dataStart + declaredLength <= raw.length) {
    const afterData = skipPdfWhitespaceAndComments(raw, dataStart + declaredLength);
    if (
      raw.startsWith('endstream', afterData) &&
      (afterData + 9 >= raw.length ||
        isPdfWhitespaceCode(raw.charCodeAt(afterData + 9)) ||
        isPdfDelimiterCode(raw.charCodeAt(afterData + 9)))
    ) {
      return afterData + 9;
    }
  }

  let nesting = 1;
  let pos = dataStart;
  while (pos < raw.length) {
    const hasDelimiterBefore =
      pos === dataStart ||
      isPdfWhitespaceCode(raw.charCodeAt(pos - 1)) ||
      isPdfDelimiterCode(raw.charCodeAt(pos - 1));
    if (hasDelimiterBefore && (raw.startsWith('stream\r\n', pos) || raw.startsWith('stream\n\r', pos))) {
      nesting += 1;
      pos += 8;
      continue;
    }
    if (hasDelimiterBefore && (raw.startsWith('stream\n', pos) || raw.startsWith('stream\r', pos))) {
      nesting += 1;
      pos += 7;
      continue;
    }
    if (
      hasDelimiterBefore &&
      raw.startsWith('stream', pos) &&
      (pos + 6 >= raw.length || isPdfWhitespaceCode(raw.charCodeAt(pos + 6)))
    ) {
      nesting += 1;
      pos += 6;
      continue;
    }
    if (
      (raw.startsWith('\r\nendstream', pos) || raw.startsWith('\n\rendstream', pos)) &&
      (pos + 11 >= raw.length ||
        isPdfWhitespaceCode(raw.charCodeAt(pos + 11)) ||
        isPdfDelimiterCode(raw.charCodeAt(pos + 11)))
    ) {
      nesting -= 1;
      pos += 11;
      if (nesting === 0) return pos;
      continue;
    }
    if (
      (raw.startsWith('\nendstream', pos) || raw.startsWith('\rendstream', pos)) &&
      (pos + 10 >= raw.length ||
        isPdfWhitespaceCode(raw.charCodeAt(pos + 10)) ||
        isPdfDelimiterCode(raw.charCodeAt(pos + 10)))
    ) {
      nesting -= 1;
      pos += 10;
      if (nesting === 0) return pos;
      continue;
    }
    if (
      hasDelimiterBefore &&
      raw.startsWith('endstream', pos) &&
      (pos + 9 >= raw.length ||
        isPdfWhitespaceCode(raw.charCodeAt(pos + 9)) ||
        isPdfDelimiterCode(raw.charCodeAt(pos + 9)))
    ) {
      nesting -= 1;
      pos += 9;
      if (nesting === 0) return pos;
      continue;
    }
    pos += 1;
  }
  if (allowUnresolvedEof) {
    return raw.length;
  }
  throw new PdfSignError('Luồng dữ liệu PDF thiếu điểm kết thúc endstream');
}

function createPdfDocLengthResolver(pdfDoc: PDFDocument): PdfLengthResolver {
  return (refKey: string): number | undefined => {
    const match = /^(\d+) (\d+) R$/.exec(refKey);
    if (!match) return undefined;
    const num = Number.parseInt(match[1] ?? '', 10);
    const gen = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(gen) || num <= 0 || gen < 0) {
      return undefined;
    }
    const resolved = pdfDoc.context.lookup(PDFRef.of(num, gen));
    if (!(resolved instanceof PDFNumber)) return undefined;
    const val = resolved.asNumber();
    return Number.isSafeInteger(val) && val >= 0 ? val : undefined;
  };
}

function inspectRawPdfSyntax(bytes: Uint8Array, externalLengthLookup?: PdfLengthResolver): RawPdfNameEscapes {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let remainingBudget = Math.max(MIN_RAW_DICT_SCAN_BUDGET_BYTES, raw.length * 8);
  const escapedTokens = new Map<string, string>();
  const literalHashTokens = new Set<string>();
  const ambiguousTokens = new Set<string>();
  const parsedInts = new Map<string, number>();
  const recentTokens: RecentPdfToken[] = [];
  let currentObj: {
    readonly num: number;
    readonly gen: number;
    bodySingleInt: number | null;
    bodyTokenCount: number;
  } | null = null;
  let bracketDepth = 0;
  let sawObjStm = false;
  let hasUnresolvedIndirectLength = false;

  const recordRawNameToken = (rawToken: string): void => {
    if (rawToken === 'ObjStm') {
      sawObjStm = true;
      return;
    }
    if (!rawToken.includes('#')) return;
    const specDecoded = decodeRawPdfNameToken(rawToken);
    if (specDecoded === 'ObjStm') {
      sawObjStm = true;
    }
    const pdfLibDecoded = decodePdfLibNameToken(rawToken);
    if (specDecoded !== pdfLibDecoded) {
      const existing = escapedTokens.get(pdfLibDecoded);
      if (literalHashTokens.has(pdfLibDecoded) || (existing !== undefined && existing !== specDecoded)) {
        ambiguousTokens.add(pdfLibDecoded);
      } else {
        escapedTokens.set(pdfLibDecoded, specDecoded);
      }
    } else if (pdfLibDecoded.includes('#')) {
      if (escapedTokens.has(pdfLibDecoded)) {
        ambiguousTokens.add(pdfLibDecoded);
      } else {
        literalHashTokens.add(pdfLibDecoded);
      }
    }
  };

  const scanDictAt = (dictStart: number): string | null => {
    if (raw.charCodeAt(dictStart) !== 0x3c || raw.charCodeAt(dictStart + 1) !== 0x3c) {
      return null;
    }
    const { slice, scannedBytes, budgetHit } = extractRawPdfDictAt(raw, dictStart, remainingBudget);
    remainingBudget -= scannedBytes;
    if (budgetHit || remainingBudget <= 0) {
      throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
    }
    return slice;
  };

  const inspectTrailerDictAfter = (keywordEndPos: number): number | null => {
    const dictStart = skipPdfWhitespaceAndComments(raw, keywordEndPos);
    const dictSlice = scanDictAt(dictStart);
    if (!dictSlice) return null;
    if (dictSlice.includes('#') || dictSlice.includes('Encrypt') || dictSlice.includes('ObjStm')) {
      const { hasEncryptKey } = inspectRawDictTopLevelNames(dictSlice, recordRawNameToken);
      if (hasEncryptKey) {
        throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
      }
    }
    return dictStart + dictSlice.length;
  };

  const markNonIntToken = (): void => {
    if (currentObj) {
      currentObj.bodyTokenCount += 1;
      currentObj.bodySingleInt = null;
    }
    recentTokens.length = 0;
  };

  let pos = 0;
  while (pos < raw.length) {
    const code = raw.charCodeAt(pos);
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25) {
      // Skip PDF comment to end of line.
      pos += 1;
      while (pos < raw.length) {
        const ch = raw.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    if (code === 0x28) {
      // Skip PDF literal strings so text such as "(trailer << /Encrypt 5 0 R >>)" is ignored.
      pos = skipPdfLiteralString(raw, pos + 1);
      markNonIntToken();
      continue;
    }
    if (code === 0x5b) {
      bracketDepth += 1;
      markNonIntToken();
      pos += 1;
      continue;
    }
    if (code === 0x5d) {
      if (bracketDepth > 0) bracketDepth -= 1;
      markNonIntToken();
      pos += 1;
      continue;
    }
    if (code === 0x2f) {
      // Skip PDF Name tokens (e.g. /XRef), except glued names like endobj/trailer<<...>>.
      const nameStart = pos + 1;
      pos = nameStart;
      while (pos < raw.length) {
        const nc = raw.charCodeAt(pos);
        if (isPdfWhitespaceCode(nc) || isPdfDelimiterCode(nc)) break;
        pos += 1;
      }
      const rawToken = raw.slice(nameStart, pos);
      recordRawNameToken(rawToken);
      markNonIntToken();
      if (rawToken.endsWith('trailer')) {
        const dictEnd = inspectTrailerDictAfter(pos);
        if (dictEnd !== null) pos = dictEnd;
      }
      continue;
    }
    if (code === 0x3c) {
      if (raw.charCodeAt(pos + 1) === 0x3c) {
        pos += 2;
      } else {
        // Skip hex string '<...>'.
        pos += 1;
        while (pos < raw.length && raw.charCodeAt(pos) !== 0x3e) {
          pos += 1;
        }
        if (pos < raw.length) pos += 1;
      }
      markNonIntToken();
      continue;
    }
    if (isPdfDelimiterCode(code)) {
      pos += 1;
      recentTokens.length = 0;
      continue;
    }

    const tokenStart = pos;
    while (pos < raw.length) {
      const tc = raw.charCodeAt(pos);
      if (isPdfWhitespaceCode(tc) || isPdfDelimiterCode(tc)) break;
      pos += 1;
    }
    const token = raw.slice(tokenStart, pos);

    if (bracketDepth === 0) {
      const objHeader = parseIndirectObjHeader(token, recentTokens);
      const isTrailerToken = token === 'trailer' || token.endsWith('trailer');
      const isObjToken =
        objHeader !== null ||
        token === 'obj' ||
        (token.length > 3 && token.endsWith('obj') && isAllAsciiDigits(token.slice(0, -3)));

      if (isTrailerToken) {
        recentTokens.length = 0;
        const dictEnd = inspectTrailerDictAfter(pos);
        if (dictEnd !== null) pos = dictEnd;
        continue;
      }

      if (isObjToken) {
        if (objHeader && objHeader.num > 0) {
          currentObj = {
            num: objHeader.num,
            gen: objHeader.gen,
            bodySingleInt: null,
            bodyTokenCount: 0,
          };
        }
        recentTokens.length = 0;
        const dictStart = skipPdfWhitespaceAndComments(raw, pos);
        const dictSlice = scanDictAt(dictStart);
        if (!dictSlice) continue;

        markNonIntToken();
        const dictEnd = dictStart + dictSlice.length;
        let declaredLength: number | undefined;
        let indirectLengthRef: string | null = null;
        if (
          dictSlice.includes('#') ||
          dictSlice.includes('Encrypt') ||
          dictSlice.includes('Length') ||
          dictSlice.includes('ObjStm')
        ) {
          const inspected = inspectRawDictTopLevelNames(dictSlice, recordRawNameToken);
          if (inspected.isXRefType && inspected.hasEncryptKey) {
            throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
          }
          declaredLength = inspected.directLength ?? undefined;
          indirectLengthRef = inspected.indirectLengthRef;
        }
        const streamDataStart = findPdfStreamDataStart(raw, dictEnd);
        if (streamDataStart >= 0) {
          let allowUnresolvedEof = false;
          if (declaredLength === undefined && indirectLengthRef !== null) {
            declaredLength =
              parsedInts.get(indirectLengthRef) ?? externalLengthLookup?.(indirectLengthRef);
            if (declaredLength === undefined) {
              hasUnresolvedIndirectLength = true;
              allowUnresolvedEof = externalLengthLookup === undefined;
            }
          }
          pos = findStreamBodyEnd(raw, streamDataStart, declaredLength, allowUnresolvedEof);
        } else {
          pos = dictEnd;
        }
        continue;
      }

      if (token === 'endobj') {
        if (currentObj && currentObj.bodyTokenCount === 1 && currentObj.bodySingleInt !== null) {
          parsedInts.set(`${currentObj.num} ${currentObj.gen} R`, currentObj.bodySingleInt);
        }
        currentObj = null;
        recentTokens.length = 0;
        continue;
      }
    }

    const isDigits = isAllAsciiDigits(token);
    if (currentObj && bracketDepth === 0) {
      currentObj.bodyTokenCount += 1;
      if (currentObj.bodyTokenCount === 1 && isDigits) {
        const parsedVal = Number.parseInt(token, 10);
        currentObj.bodySingleInt = Number.isSafeInteger(parsedVal) ? parsedVal : null;
      } else {
        currentObj.bodySingleInt = null;
      }
    }
    recentTokens.push({ text: token, start: tokenStart, isDigits });
    if (recentTokens.length > 3) {
      recentTokens.shift();
    }
  }

  return {
    escapedTokens,
    literalHashTokens,
    ambiguousTokens,
    sawObjStm,
    hasUnresolvedIndirectLength,
  };
}

const FORBIDDEN_URI_PREFIXES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'smb:',
  'ms-msdt:',
  '\\\\',
] as const;

function assertSafePdfUri(rawUri: string): void {
  let normalizedUri = '';
  for (const ch of rawUri) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x20 && code !== 0x7f && code !== 0xfeff && code !== 0xfffe) {
      normalizedUri += ch;
    }
  }
  normalizedUri = normalizedUri.toLowerCase();
  for (const prefix of FORBIDDEN_URI_PREFIXES) {
    if (normalizedUri.startsWith(prefix)) {
      throw new PdfSignError('Tệp PDF chứa liên kết không an toàn');
    }
  }
}

type PdfScanMode = 'standard' | 'resources' | 'resource_map' | 'ap_container';

type TraversablePdfGraphNode = PDFRef | PDFStream | PDFArray | PDFDict | PDFInvalidObject;

function isTraversablePdfGraphNode(value: unknown): value is TraversablePdfGraphNode {
  return (
    value instanceof PDFRef ||
    value instanceof PDFStream ||
    value instanceof PDFArray ||
    value instanceof PDFDict ||
    value instanceof PDFInvalidObject
  );
}

function scanPdfObjectGraph(pdfDoc: PDFDocument, nameEscapes: RawPdfNameEscapes): void {
  if (pdfDoc.isEncrypted || pdfDoc.context.trailerInfo.Encrypt !== undefined) {
    throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
  }

  const visitedByMode: Record<PdfScanMode, Set<object>> = {
    standard: new Set<object>(),
    resources: new Set<object>(),
    resource_map: new Set<object>(),
    ap_container: new Set<object>(),
  };
  const stack: Array<{ readonly node: TraversablePdfGraphNode; readonly mode: PdfScanMode }> = [];

  const drainStack = (): void => {
    let visitedCount =
      visitedByMode.standard.size +
      visitedByMode.resources.size +
      visitedByMode.resource_map.size +
      visitedByMode.ap_container.size;
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      const { node: current, mode } = item;
      const visited = visitedByMode[mode];
      if (visited.has(current)) continue;
      visited.add(current);
      visitedCount++;
      if (visitedCount > MAX_PDF_GRAPH_NODES) {
        throw new PdfSignError('Tệp PDF quá phức tạp vượt quá giới hạn kiểm tra');
      }

      if (current instanceof PDFInvalidObject) {
        throw new PdfSignError('Tệp PDF chứa đối tượng cấu trúc không hợp lệ');
      }
      if (current instanceof PDFRef) {
        const target = pdfDoc.context.lookup(current);
        if (isTraversablePdfGraphNode(target)) stack.push({ node: target, mode });
        continue;
      }
      if (current instanceof PDFStream) {
        for (const [key] of current.dict.entries()) {
          const streamKey = decodeUnnormalizedPdfName(key, nameEscapes);
          if (streamKey === 'F' || streamKey === 'FFilter' || streamKey === 'FDecodeParms') {
            throw new PdfSignError(`Tệp PDF chứa luồng tham chiếu tệp bên ngoài không cho phép: /${streamKey}`);
          }
        }
        stack.push({ node: current.dict, mode: 'standard' });
        continue;
      }
      if (current instanceof PDFArray) {
        const size = current.size();
        for (let i = 0; i < size; i++) {
          const element = current.get(i);
          if (isTraversablePdfGraphNode(element)) {
            stack.push({ node: element, mode: 'standard' });
          }
        }
        continue;
      }
      if (current instanceof PDFDict) {
        if (mode === 'resource_map') {
          for (const [, value] of current.entries()) {
            if (isTraversablePdfGraphNode(value)) {
              stack.push({ node: value, mode: 'standard' });
            }
          }
          continue;
        }

        let filterName: string | undefined;
        let dictType: string | undefined;
        let dictSubtype: string | undefined;
        let hasCf = false;
        let hasStmOrStrF = false;
        const decodedEntries: Array<{ readonly keyName: string; readonly value: unknown }> = [];

        for (const [key, value] of current.entries()) {
          const keyName = decodeUnnormalizedPdfName(key, nameEscapes);
          if (FORBIDDEN_DICT_KEYS.has(keyName)) {
            throw new PdfSignError(`Tệp PDF chứa thành phần không an toàn: /${keyName}`);
          }
          if (keyName === 'CF') {
            hasCf = true;
          } else if (keyName === 'StmF' || keyName === 'StrF') {
            hasStmOrStrF = true;
          }
          if (keyName === 'Type' || keyName === 'S' || keyName === 'Subtype' || keyName === 'Filter') {
            const resolved = pdfDoc.context.lookup(value);
            if (resolved instanceof PDFName) {
              const resolvedName = decodeUnnormalizedPdfName(resolved, nameEscapes);
              if (keyName === 'S' && FORBIDDEN_ACTION_NAMES.has(resolvedName)) {
                throw new PdfSignError(`Tệp PDF chứa hành động không cho phép: /${resolvedName}`);
              }
              if (keyName === 'Subtype' && FORBIDDEN_SUBTYPES.has(resolvedName)) {
                throw new PdfSignError(`Tệp PDF chứa đối tượng nhúng không cho phép: /${resolvedName}`);
              }
              if (keyName === 'Type') {
                dictType = resolvedName;
              } else if (keyName === 'Subtype') {
                dictSubtype = resolvedName;
              } else if (keyName === 'Filter') {
                filterName = resolvedName;
              }
            }
          }
          if (keyName === 'URI') {
            const resolved = pdfDoc.context.lookup(value);
            if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
              assertSafePdfUri(resolved.decodeText());
            } else if (resolved instanceof PDFDict) {
              for (const [subKey, subVal] of resolved.entries()) {
                if (decodeUnnormalizedPdfName(subKey, nameEscapes) === 'Base') {
                  const subResolved = pdfDoc.context.lookup(subVal);
                  if (subResolved instanceof PDFString || subResolved instanceof PDFHexString) {
                    assertSafePdfUri(subResolved.decodeText());
                  }
                }
              }
            }
          }

          decodedEntries.push({ keyName, value });
        }

        if (filterName === 'Standard' || (hasCf && hasStmOrStrF)) {
          throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
        }

        for (const { keyName, value } of decodedEntries) {
          let childMode: PdfScanMode = 'standard';
          if (RESOURCE_CONTAINER_KEYS.has(keyName)) {
            childMode = 'resources';
          } else if (mode === 'resources' && RESOURCE_MAP_KEYS.has(keyName)) {
            childMode = 'resource_map';
          } else if (keyName === 'CharProcs' && dictSubtype === 'Type3') {
            childMode = 'resource_map';
          } else if (keyName === 'AP' && mode === 'standard') {
            childMode = 'ap_container';
          } else if (mode === 'ap_container' && AP_APPEARANCE_KEYS.has(keyName)) {
            childMode = 'resource_map';
          } else if ((keyName === 'RoleMap' || keyName === 'ClassMap') && dictType === 'StructTreeRoot') {
            childMode = 'resource_map';
          } else if (keyName === 'Dests' && current === pdfDoc.catalog) {
            childMode = 'resource_map';
          }
          if (isTraversablePdfGraphNode(value)) {
            stack.push({ node: value, mode: childMode });
          }
        }
      }
    }
  };

  if (isTraversablePdfGraphNode(pdfDoc.context.trailerInfo.Root)) {
    stack.push({ node: pdfDoc.context.trailerInfo.Root, mode: 'standard' });
  }
  stack.push({ node: pdfDoc.catalog, mode: 'standard' });
  if (isTraversablePdfGraphNode(pdfDoc.context.trailerInfo.Info)) {
    stack.push({ node: pdfDoc.context.trailerInfo.Info, mode: 'standard' });
  }
  drainStack();

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!isTraversablePdfGraphNode(obj)) continue;
    if (
      visitedByMode.standard.has(obj) ||
      visitedByMode.resources.has(obj) ||
      visitedByMode.resource_map.has(obj) ||
      visitedByMode.ap_container.has(obj)
    ) {
      continue;
    }
    stack.push({ node: obj, mode: 'standard' });
    drainStack();
  }
}

const MAX_PDF_USER_UNIT = 75_000;

function canonicalizePdfName(name: PDFName, nameEscapes: RawPdfNameEscapes): PDFName {
  const rawDecoded = name.decodeText();
  if (!rawDecoded.includes('#')) return name;
  if (nameEscapes.ambiguousTokens.has(rawDecoded)) {
    throw new PdfSignError('Tệp PDF chứa tên đối tượng xung đột không thể chuẩn hóa an toàn');
  }
  const canonical = decodeUnnormalizedPdfName(name, nameEscapes);
  if (canonical === rawDecoded) return name;
  // Escape literal '#' before calling PDFName.of so uppercase #XX isn't double-decoded.
  return PDFName.of(canonical.replace(/#/g, '#23'));
}

function normalizePdfDictAndEntries(dict: PDFDict, nameEscapes: RawPdfNameEscapes): void {
  const originalEntries = dict.entries();
  let changed = false;
  const normalizedEntries: Array<[PDFName, PDFObject]> = [];
  const seenKeys = new Set<PDFName>();
  for (const [key, value] of originalEntries) {
    const nextKey = canonicalizePdfName(key, nameEscapes);
    if (seenKeys.has(nextKey)) {
      throw new PdfSignError('Tệp PDF chứa khóa từ điển trùng lặp không hợp lệ');
    }
    seenKeys.add(nextKey);
    const nextValue = value instanceof PDFName ? canonicalizePdfName(value, nameEscapes) : value;
    if (nextKey !== key || nextValue !== value) {
      changed = true;
    }
    normalizedEntries.push([nextKey, nextValue]);
  }
  if (!changed) return;
  for (const [key] of originalEntries) {
    dict.delete(key);
  }
  for (const [nextKey, nextValue] of normalizedEntries) {
    dict.set(nextKey, nextValue);
  }
}

function normalizeAllPdfNames(pdfDoc: PDFDocument, nameEscapes: RawPdfNameEscapes): void {
  const visited = new Set<object>();
  const stack: TraversablePdfGraphNode[] = [];
  if (isTraversablePdfGraphNode(pdfDoc.context.trailerInfo.Root)) {
    stack.push(pdfDoc.context.trailerInfo.Root);
  }
  if (isTraversablePdfGraphNode(pdfDoc.context.trailerInfo.Info)) {
    stack.push(pdfDoc.context.trailerInfo.Info);
  }
  for (const [ref, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFName) {
      const canonical = canonicalizePdfName(obj, nameEscapes);
      if (canonical !== obj) {
        pdfDoc.context.assign(ref, canonical);
      }
      continue;
    }
    if (isTraversablePdfGraphNode(obj)) {
      stack.push(obj);
    }
  }

  let visitedCount = 0;
  while (stack.length > 0) {
    const raw = stack.pop();
    if (!raw) continue;
    if (raw instanceof PDFInvalidObject) {
      throw new PdfSignError('Tệp PDF chứa đối tượng cấu trúc không hợp lệ');
    }
    if (visited.has(raw)) continue;
    visited.add(raw);
    visitedCount += 1;
    if (visitedCount > MAX_PDF_GRAPH_NODES) {
      throw new PdfSignError('Tệp PDF quá phức tạp vượt quá giới hạn kiểm tra');
    }

    if (raw instanceof PDFRef) {
      const target = pdfDoc.context.lookup(raw);
      if (target instanceof PDFName) {
        const canonical = canonicalizePdfName(target, nameEscapes);
        if (canonical !== target) {
          pdfDoc.context.assign(raw, canonical);
        }
      } else if (isTraversablePdfGraphNode(target)) {
        stack.push(target);
      }
      continue;
    }
    if (raw instanceof PDFStream) {
      stack.push(raw.dict);
      continue;
    }
    if (raw instanceof PDFArray) {
      const size = raw.size();
      for (let i = 0; i < size; i++) {
        const item = raw.get(i);
        if (item instanceof PDFName) {
          const canonical = canonicalizePdfName(item, nameEscapes);
          if (canonical !== item) {
            raw.set(i, canonical);
          }
        } else if (isTraversablePdfGraphNode(item)) {
          stack.push(item);
        }
      }
      continue;
    }
    if (raw instanceof PDFDict) {
      normalizePdfDictAndEntries(raw, nameEscapes);
      for (const [, value] of raw.entries()) {
        if (!(value instanceof PDFName) && isTraversablePdfGraphNode(value)) {
          stack.push(value);
        }
      }
    }
  }
}

function getPageUserUnit(pdfDoc: PDFDocument, page: PDFPage): number {
  const entry = lookupDictEntryByDecodedName(pdfDoc, page.node, 'UserUnit');
  if (!entry) return 1;
  if (!(entry.resolved instanceof PDFNumber)) {
    throw new PdfSignError('Tỷ lệ đơn vị trang PDF (UserUnit) không hợp lệ');
  }
  const unit = entry.resolved.asNumber();
  if (!Number.isFinite(unit) || unit <= 0 || unit > MAX_PDF_USER_UNIT) {
    throw new PdfSignError('Tỷ lệ đơn vị trang PDF (UserUnit) không hợp lệ');
  }
  return unit;
}

function getVisualBox(page: PDFPage, userUnit = 1): VisualBox {
  let rawMedia: { x: number; y: number; width: number; height: number };
  let rawCrop: { x: number; y: number; width: number; height: number };
  try {
    rawMedia = page.getMediaBox();
    rawCrop = page.getCropBox();
  } catch {
    throw new PdfSignError('Kích thước trang PDF không hợp lệ');
  }
  const media = normalizePdfRect(rawMedia);
  const crop = normalizePdfRect(rawCrop);
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  const width = right - x;
  const height = top - y;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width * userUnit > MAX_PDF_BOX_PT ||
    height * userUnit > MAX_PDF_BOX_PT
  ) {
    throw new PdfSignError('Kích thước trang PDF không hợp lệ');
  }
  return { x, y, width, height };
}

function getPageMetrics(
  pdfDoc: PDFDocument,
  page: PDFPage,
): { readonly box: VisualBox; readonly rot: PageRotation; readonly userUnit: number } {
  const userUnit = getPageUserUnit(pdfDoc, page);
  const box = getVisualBox(page, userUnit);
  const rot = normalizeRotation(page.getRotation().angle);
  return { box, rot, userUnit };
}

const MAX_XREF_SECTIONS = 64;
const MAX_XREF_OBJECT_NUMBER = 10_000_000;
const MAX_XREF_STREAM_OBJECTS = 1_000_000;
const PDF_TAIL_SEARCH_BYTES = 2048;
const MAX_XREF_LEADING_WS = 16;
const MAX_STRUCTURAL_EQ_DEPTH = 128;

type ActiveXrefEntry =
  | { readonly kind: 'free'; readonly gen: number }
  | { readonly kind: 'offset'; readonly offset: number; readonly gen: number }
  | { readonly kind: 'objStm'; readonly objStmNum: number; readonly index: number; readonly gen: 0 };

type ObjectDefinitionLocation =
  | {
      readonly kind: 'toplevel';
      readonly num: number;
      readonly gen: number;
      readonly offset: number;
      readonly bodyStart: number;
    }
  | {
      readonly kind: 'objStm';
      readonly num: number;
      readonly gen: 0;
      readonly stmNum: number;
      readonly stmGen: number;
      readonly stmOffset: number;
      readonly index: number;
    };

interface XrefStreamSectionInfo {
  readonly objNum: number;
  readonly gen: number;
  readonly offset: number;
  readonly numStart: number;
}

interface DecodedObjStmInfo {
  readonly decodedBytes: Uint8Array;
  readonly members: ReadonlyMap<number, { readonly memberNum: number; readonly absOffset: number }>;
  readonly memberList: ReadonlyArray<{ readonly index: number; readonly memberNum: number; readonly absOffset: number }>;
}

function skipWsAndNonEofComments(raw: string, start: number): number {
  let pos = start;
  while (pos < raw.length) {
    const code = raw.charCodeAt(pos);
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25 && !raw.startsWith('%%EOF', pos)) {
      pos += 1;
      while (pos < raw.length) {
        const ch = raw.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    break;
  }
  return pos;
}

function skipAsciiPdfWhitespace(raw: string, start: number, maxSkip: number): number {
  let pos = start;
  const limit = Math.min(raw.length, start + maxSkip);
  while (pos < limit && isPdfWhitespaceCode(raw.charCodeAt(pos))) {
    pos += 1;
  }
  return pos;
}

function parseNonNegIntAt(raw: string, start: number): { readonly value: number; readonly nextPos: number } | null {
  let end = start;
  while (end < raw.length && isAsciiDigitCode(raw.charCodeAt(end))) {
    end += 1;
  }
  if (end === start) return null;
  const parsed = Number.parseInt(raw.slice(start, end), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return { value: parsed, nextPos: end };
}

function parseTailStartXref(raw: string): { readonly startXrefOffset: number; readonly eofOffset: number } {
  const tailStart = Math.max(0, raw.length - PDF_TAIL_SEARCH_BYTES);
  const eofOffset = raw.lastIndexOf('%%EOF');
  if (eofOffset < tailStart || eofOffset < 0) {
    throw new PdfSignError('Tệp PDF thiếu điểm kết thúc %%EOF hợp lệ');
  }
  for (let i = eofOffset + 5; i < raw.length; i += 1) {
    if (!isPdfWhitespaceCode(raw.charCodeAt(i))) {
      throw new PdfSignError('Tệp PDF chứa dữ liệu dư thừa sau điểm kết thúc %%EOF');
    }
  }

  const startXrefSearchFrom = Math.max(0, eofOffset - 1024);
  const startXrefPos = raw.lastIndexOf('startxref', eofOffset - 1);
  if (startXrefPos < startXrefSearchFrom || startXrefPos < 0) {
    throw new PdfSignError('Tệp PDF thiếu bảng chỉ mục startxref hợp lệ');
  }
  if (startXrefPos > 0) {
    const prevCode = raw.charCodeAt(startXrefPos - 1);
    if (!isPdfWhitespaceCode(prevCode) && !isPdfDelimiterCode(prevCode)) {
      throw new PdfSignError('Tệp PDF chứa thẻ startxref không hợp lệ');
    }
  }
  const afterKeywordCode = raw.charCodeAt(startXrefPos + 9);
  if (!isPdfWhitespaceCode(afterKeywordCode) && afterKeywordCode !== 0x25) {
    throw new PdfSignError('Tệp PDF chứa thẻ startxref không hợp lệ');
  }

  const numStart = skipWsAndNonEofComments(raw, startXrefPos + 9);
  const parsedOffset = parseNonNegIntAt(raw, numStart);
  if (!parsedOffset || parsedOffset.value >= eofOffset) {
    throw new PdfSignError('Chỉ mục startxref của tệp PDF không hợp lệ');
  }
  const afterOffset = skipWsAndNonEofComments(raw, parsedOffset.nextPos);
  if (afterOffset !== eofOffset) {
    throw new PdfSignError('Tệp PDF chứa dữ liệu dư thừa giữa startxref và %%EOF');
  }
  return { startXrefOffset: parsedOffset.value, eofOffset };
}

function parseIndirectObjHeaderAt(
  raw: string,
  offset: number,
  maxLeadingWs: number,
): {
  readonly num: number;
  readonly gen: number;
  readonly numStart: number;
  readonly bodyStart: number;
} | null {
  if (offset < 0 || offset >= raw.length) return null;
  const numStart = skipAsciiPdfWhitespace(raw, offset, maxLeadingWs);
  const numTok = parseNonNegIntAt(raw, numStart);
  if (!numTok) return null;
  const genStart = skipPdfWhitespaceAndComments(raw, numTok.nextPos);
  const genTok = parseNonNegIntAt(raw, genStart);
  if (!genTok) return null;
  const objKeywordStart = skipPdfWhitespaceAndComments(raw, genTok.nextPos);
  if (!raw.startsWith('obj', objKeywordStart)) return null;
  const bodyStart = objKeywordStart + 3;
  if (bodyStart < raw.length) {
    const afterObjCode = raw.charCodeAt(bodyStart);
    if (!isPdfWhitespaceCode(afterObjCode) && !isPdfDelimiterCode(afterObjCode)) {
      return null;
    }
  }
  return { num: numTok.value, gen: genTok.value, numStart, bodyStart };
}

const ESCAPED_STRUCTURAL_PDF_NAMES = new Set([
  'Type',
  'Catalog',
  'XRef',
  'ObjStm',
  'Length',
  'Filter',
  'DecodeParms',
  'XRefStm',
  'Encrypt',
  'Root',
  'Prev',
  'Size',
  'W',
  'Index',
  'N',
  'First',
  'Extends',
  'Predictor',
  'Colors',
  'BitsPerComponent',
  'Columns',
]);

const MAX_STREAM_FILTERS = 8;
const MAX_PREDICTOR_COLORS = 256;
const MAX_PREDICTOR_COLUMNS = 65_536;
const VALID_PREDICTOR_BPC = new Set([1, 2, 4, 8, 16]);

function getRawDictEntryByDecodedName(
  dict: PDFDict,
  targetName: string,
  nameEscapes: RawPdfNameEscapes | null,
): { readonly key: PDFName; readonly raw: PDFObject } | undefined {
  let match: { readonly key: PDFName; readonly raw: PDFObject } | undefined;
  let matchCount = 0;
  for (const [key, raw] of dict.entries()) {
    const decodedKey = nameEscapes ? decodeUnnormalizedPdfName(key, nameEscapes) : decodePdfName(key);
    if (decodedKey === targetName) {
      match = { key, raw };
      matchCount += 1;
    }
  }
  if (matchCount > 1) {
    throw new PdfSignError('Từ điển cấu trúc PDF chứa khóa trùng lặp không hợp lệ');
  }
  if (match && match.key !== PDFName.of(targetName.replace(/#/g, '#23'))) {
    throw new PdfSignError('Tệp PDF chứa khóa cấu trúc bị mã hóa hex không hợp lệ');
  }
  return match;
}

function assertPlainStructuralPdfName(
  obj: unknown,
  nameEscapes: RawPdfNameEscapes | null,
  expectedName?: string,
  errorMessage?: string,
): string {
  if (!(obj instanceof PDFName)) {
    throw new PdfSignError(errorMessage ?? 'Tên cấu trúc PDF không hợp lệ');
  }
  const decoded = nameEscapes ? decodeUnnormalizedPdfName(obj, nameEscapes) : decodePdfName(obj);
  if (obj !== PDFName.of(decoded.replace(/#/g, '#23'))) {
    throw new PdfSignError('Tệp PDF chứa giá trị tên cấu trúc bị mã hóa hex không hợp lệ');
  }
  if (expectedName !== undefined && decoded !== expectedName) {
    throw new PdfSignError(errorMessage ?? 'Giá trị tên cấu trúc PDF không khớp');
  }
  return decoded;
}

function resolveStructuralObject(raw: unknown, lookupContext: PDFContext | null = null): unknown {
  if (!lookupContext) return raw;
  let current = raw;
  for (let hop = 0; hop < 8 && current instanceof PDFRef; hop += 1) {
    current = lookupContext.lookup(current);
  }
  if (current instanceof PDFRef) {
    throw new PdfSignError('Chuỗi tham chiếu cấu trúc luồng PDF vượt quá giới hạn');
  }
  return current;
}

function readPredictorIntParam(
  dict: PDFDict,
  key: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  nameEscapes: RawPdfNameEscapes | null,
  lookupContext: PDFContext | null = null,
): number {
  const entry = getRawDictEntryByDecodedName(dict, key, nameEscapes);
  const resolved = entry ? resolveStructuralObject(entry.raw, lookupContext) : undefined;
  if (!entry || resolved === PDFNull) return defaultValue;
  if (!(resolved instanceof PDFNumber)) {
    throw new PdfSignError(`Tham số /DecodeParms /${key} không hợp lệ`);
  }
  const value = resolved.asNumber();
  if (!Number.isSafeInteger(value) || value < minValue || value > maxValue) {
    throw new PdfSignError(`Giá trị /DecodeParms /${key} vượt phạm vi cho phép`);
  }
  return value;
}

function parsePredictorParams(
  parmsDict: PDFDict,
  nameEscapes: RawPdfNameEscapes | null,
  lookupContext: PDFContext | null = null,
): {
  readonly predictor: number;
  readonly colors: number;
  readonly bitsPerComponent: number;
  readonly columns: number;
} {
  const predictor = readPredictorIntParam(parmsDict, 'Predictor', 1, 1, 15, nameEscapes, lookupContext);
  if (predictor !== 1 && predictor !== 2 && (predictor < 10 || predictor > 15)) {
    throw new PdfSignError('Giá trị /Predictor trong luồng PDF không được hỗ trợ');
  }
  const colors = readPredictorIntParam(parmsDict, 'Colors', 1, 1, MAX_PREDICTOR_COLORS, nameEscapes, lookupContext);
  const bpcEntry = getRawDictEntryByDecodedName(parmsDict, 'BitsPerComponent', nameEscapes);
  const bitsPerComponent = bpcEntry
    ? readPredictorIntParam(parmsDict, 'BitsPerComponent', 8, 1, 16, nameEscapes, lookupContext)
    : readPredictorIntParam(parmsDict, 'BPC', 8, 1, 16, nameEscapes, lookupContext);
  if (!VALID_PREDICTOR_BPC.has(bitsPerComponent)) {
    throw new PdfSignError('Giá trị /BitsPerComponent trong /DecodeParms không hợp lệ');
  }
  const columns = readPredictorIntParam(parmsDict, 'Columns', 1, 1, MAX_PREDICTOR_COLUMNS, nameEscapes, lookupContext);
  return { predictor, colors, bitsPerComponent, columns };
}

function reverseTiffPredictor(
  encoded: Uint8Array,
  rowBytes: number,
  rowCount: number,
  colors: number,
  bitsPerComponent: number,
  columns: number,
  out: Uint8Array,
): void {
  if (bitsPerComponent === 8) {
    for (let r = 0; r < rowCount; r += 1) {
      const base = r * rowBytes;
      const head = Math.min(colors, rowBytes);
      for (let i = 0; i < head; i += 1) {
        out[base + i] = encoded[base + i] ?? 0;
      }
      for (let i = head; i < rowBytes; i += 1) {
        out[base + i] = ((encoded[base + i] ?? 0) + (out[base + i - colors] ?? 0)) & 0xff;
      }
    }
    return;
  }

  if (bitsPerComponent === 16) {
    const stride = colors * 2;
    if (rowBytes < stride || (rowBytes & 1) !== 0) {
      throw new PdfSignError('Kích thước hàng TIFF Predictor 16-bit không hợp lệ');
    }
    for (let r = 0; r < rowCount; r += 1) {
      const base = r * rowBytes;
      for (let i = 0; i < stride; i += 1) {
        out[base + i] = encoded[base + i] ?? 0;
      }
      for (let i = stride; i < rowBytes; i += 2) {
        const prev = ((out[base + i - stride] ?? 0) << 8) | (out[base + i - stride + 1] ?? 0);
        const cur = ((encoded[base + i] ?? 0) << 8) | (encoded[base + i + 1] ?? 0);
        const sum = (prev + cur) & 0xffff;
        out[base + i] = (sum >> 8) & 0xff;
        out[base + i + 1] = sum & 0xff;
      }
    }
    return;
  }

  const mask = (1 << bitsPerComponent) - 1;
  const prev = new Uint8Array(colors);
  for (let r = 0; r < rowCount; r += 1) {
    const base = r * rowBytes;
    prev.fill(0);
    let inIdx = base;
    let outIdx = base;
    let inBuf = 0;
    let inBits = 0;
    let outBuf = 0;
    let outBits = 0;

    for (let col = 0; col < columns; col += 1) {
      for (let c = 0; c < colors; c += 1) {
        while (inBits < bitsPerComponent) {
          inBuf = (inBuf << 8) | (encoded[inIdx] ?? 0);
          inIdx += 1;
          inBits += 8;
        }
        inBits -= bitsPerComponent;
        const diff = (inBuf >> inBits) & mask;
        const val = ((prev[c] ?? 0) + diff) & mask;
        prev[c] = val;
        outBuf = (outBuf << bitsPerComponent) | val;
        outBits += bitsPerComponent;
        if (outBits >= 8) {
          outBits -= 8;
          out[outIdx] = (outBuf >> outBits) & 0xff;
          outIdx += 1;
        }
      }
    }
    if (outBits > 0) {
      out[outIdx] = (outBuf << (8 - outBits)) & 0xff;
    }
  }
}

function reversePngPredictor(
  encoded: Uint8Array,
  rowBytes: number,
  pixBytes: number,
  rowCount: number,
  out: Uint8Array,
): void {
  const stride = rowBytes + 1;
  let prevRow: Uint8Array = new Uint8Array(rowBytes);

  for (let r = 0; r < rowCount; r += 1) {
    const inBase = r * stride;
    const outBase = r * rowBytes;
    const filterTag = encoded[inBase] ?? 255;

    switch (filterTag) {
      case 0:
        out.set(encoded.subarray(inBase + 1, inBase + 1 + rowBytes), outBase);
        break;
      case 1:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= pixBytes ? (out[outBase + i - pixBytes] ?? 0) : 0;
          out[outBase + i] = ((encoded[inBase + 1 + i] ?? 0) + left) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < rowBytes; i += 1) {
          out[outBase + i] = ((encoded[inBase + 1 + i] ?? 0) + (prevRow[i] ?? 0)) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= pixBytes ? (out[outBase + i - pixBytes] ?? 0) : 0;
          const up = prevRow[i] ?? 0;
          out[outBase + i] = ((encoded[inBase + 1 + i] ?? 0) + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= pixBytes ? (out[outBase + i - pixBytes] ?? 0) : 0;
          const up = prevRow[i] ?? 0;
          const upLeft = i >= pixBytes ? (prevRow[i - pixBytes] ?? 0) : 0;
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          out[outBase + i] = ((encoded[inBase + 1 + i] ?? 0) + pr) & 0xff;
        }
        break;
      default:
        throw new PdfSignError('Bộ lọc PNG Predictor trong luồng PDF không hợp lệ');
    }

    prevRow = out.subarray(outBase, outBase + rowBytes);
  }
}

function reversePdfPredictor(
  encoded: Uint8Array,
  parmsDict: PDFDict,
  maxOutputBytes: number,
  nameEscapes: RawPdfNameEscapes | null,
  lookupContext: PDFContext | null = null,
): Uint8Array {
  const { predictor, colors, bitsPerComponent, columns } = parsePredictorParams(
    parmsDict,
    nameEscapes,
    lookupContext,
  );
  if (predictor === 1) return encoded;

  const bitsPerPixel = colors * bitsPerComponent;
  const pixBytes = Math.max(1, (bitsPerPixel + 7) >> 3);
  const rowBytes = Math.ceil((columns * bitsPerPixel) / 8);
  if (rowBytes <= 0 || rowBytes > maxOutputBytes) {
    throw new PdfSignError('Kích thước hàng Predictor trong luồng PDF vượt giới hạn');
  }
  if (encoded.byteLength === 0) {
    return new Uint8Array(0);
  }

  if (predictor === 2) {
    if (encoded.byteLength % rowBytes !== 0) {
      throw new PdfSignError('Độ dài luồng TIFF Predictor không khớp kích thước hàng');
    }
    const rowCount = encoded.byteLength / rowBytes;
    const out = new Uint8Array(encoded.byteLength);
    reverseTiffPredictor(encoded, rowBytes, rowCount, colors, bitsPerComponent, columns, out);
    return out;
  }

  const stride = rowBytes + 1;
  if (encoded.byteLength % stride !== 0) {
    throw new PdfSignError('Độ dài luồng PNG Predictor không khớp kích thước hàng');
  }
  const rowCount = encoded.byteLength / stride;
  const outLength = rowCount * rowBytes;
  if (outLength > maxOutputBytes) {
    throw new PdfSignError('Kích thước dữ liệu giải mã Predictor vượt giới hạn');
  }
  const out = new Uint8Array(outLength);
  reversePngPredictor(encoded, rowBytes, pixBytes, rowCount, out);
  return out;
}

function extractStreamFilterPipeline(
  dict: PDFDict,
  nameEscapes: RawPdfNameEscapes | null,
  lookupContext: PDFContext | null = null,
): {
  readonly filters: ReadonlyArray<{ readonly name: PDFName; readonly decodedName: string }>;
  readonly parms: ReadonlyArray<PDFDict | undefined>;
} {
  const filterEntry = getRawDictEntryByDecodedName(dict, 'Filter', nameEscapes);
  const resolvedFilterObj = filterEntry ? resolveStructuralObject(filterEntry.raw, lookupContext) : undefined;
  const filters: Array<{ readonly name: PDFName; readonly decodedName: string }> = [];
  if (filterEntry && resolvedFilterObj !== PDFNull) {
    if (resolvedFilterObj instanceof PDFName) {
      const decodedName = assertPlainStructuralPdfName(
        resolvedFilterObj,
        nameEscapes,
        undefined,
        'Bộ lọc luồng PDF không hợp lệ',
      );
      filters.push({ name: resolvedFilterObj, decodedName });
    } else if (resolvedFilterObj instanceof PDFArray) {
      if (resolvedFilterObj.size() > MAX_STREAM_FILTERS) {
        throw new PdfSignError('Chuỗi bộ lọc luồng PDF vượt quá giới hạn');
      }
      for (let i = 0; i < resolvedFilterObj.size(); i += 1) {
        const item = resolveStructuralObject(resolvedFilterObj.get(i), lookupContext);
        const decodedName = assertPlainStructuralPdfName(
          item,
          nameEscapes,
          undefined,
          'Bộ lọc luồng PDF không hợp lệ',
        );
        filters.push({ name: item as PDFName, decodedName });
      }
    } else {
      throw new PdfSignError('Trường /Filter của luồng PDF không hợp lệ');
    }
  }

  const parmsEntry = getRawDictEntryByDecodedName(dict, 'DecodeParms', nameEscapes);
  const resolvedParmsObj = parmsEntry ? resolveStructuralObject(parmsEntry.raw, lookupContext) : undefined;
  const parms: Array<PDFDict | undefined> = Array.from({ length: filters.length }, () => undefined);
  if (!parmsEntry || resolvedParmsObj === PDFNull) {
    return { filters, parms };
  }

  if (resolvedParmsObj instanceof PDFDict) {
    if (filters.length === 0) {
      if (parsePredictorParams(resolvedParmsObj, nameEscapes, lookupContext).predictor > 1) {
        throw new PdfSignError('Không thể dùng /Predictor khi luồng PDF không có /Filter');
      }
      return { filters, parms };
    }
    if (filters.length !== 1) {
      throw new PdfSignError('Trường /DecodeParms không khớp số lượng bộ lọc');
    }
    parms[0] = resolvedParmsObj;
    return { filters, parms };
  }

  if (resolvedParmsObj instanceof PDFArray) {
    if (filters.length === 0) {
      for (let i = 0; i < resolvedParmsObj.size(); i += 1) {
        const item = resolveStructuralObject(resolvedParmsObj.get(i), lookupContext);
        if (item instanceof PDFDict && parsePredictorParams(item, nameEscapes, lookupContext).predictor > 1) {
          throw new PdfSignError('Không thể dùng /Predictor khi luồng PDF không có /Filter');
        }
      }
      return { filters, parms };
    }
    if (resolvedParmsObj.size() > filters.length) {
      throw new PdfSignError('Số phần tử /DecodeParms vượt số bộ lọc');
    }
    for (let i = 0; i < resolvedParmsObj.size(); i += 1) {
      const item = resolveStructuralObject(resolvedParmsObj.get(i), lookupContext);
      if (item === PDFNull) continue;
      if (!(item instanceof PDFDict)) {
        throw new PdfSignError('Phần tử trong mảng /DecodeParms không hợp lệ');
      }
      parms[i] = item;
    }
    return { filters, parms };
  }

  throw new PdfSignError('Trường /DecodeParms của luồng PDF không hợp lệ');
}

function decodePdfStreamApplyingPredictor(
  rawStream: PDFRawStream,
  emptyContext: PDFContext,
  maxDecodedBytes: number,
  errorMessage: string,
  nameEscapes: RawPdfNameEscapes | null,
  lookupContext: PDFContext | null = null,
): Uint8Array {
  const { filters, parms } = extractStreamFilterPipeline(rawStream.dict, nameEscapes, lookupContext);
  if (filters.length === 0) {
    if (rawStream.contents.byteLength > maxDecodedBytes) {
      throw new PdfSignError('Kích thước luồng dữ liệu PDF vượt giới hạn');
    }
    return rawStream.contents;
  }

  let current = rawStream.contents;
  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i];
    if (!filter) continue;
    const stepParms = parms[i];
    const stepDict = PDFDict.withContext(emptyContext);
    stepDict.set(PDFName.of('Filter'), filter.name);
    if (stepParms && (filter.decodedName === 'LZWDecode' || filter.decodedName === 'LZW')) {
      const earlyEntry = getRawDictEntryByDecodedName(stepParms, 'EarlyChange', nameEscapes);
      const earlyObj = earlyEntry ? resolveStructuralObject(earlyEntry.raw, lookupContext) : undefined;
      if (earlyObj instanceof PDFNumber) {
        const directParms = PDFDict.withContext(emptyContext);
        directParms.set(PDFName.of('EarlyChange'), PDFNumber.of(earlyObj.asNumber()));
        stepDict.set(PDFName.of('DecodeParms'), directParms);
      }
    } else if (stepParms && !lookupContext) {
      stepDict.set(PDFName.of('DecodeParms'), stepParms);
    }
    try {
      current = decodePDFRawStream(PDFRawStream.of(stepDict, current)).decode();
    } catch {
      throw new PdfSignError(errorMessage);
    }
    if (current.byteLength > maxDecodedBytes) {
      throw new PdfSignError('Kích thước luồng giải nén PDF vượt giới hạn');
    }
    if ((filter.decodedName === 'FlateDecode' || filter.decodedName === 'LZWDecode') && stepParms) {
      current = reversePdfPredictor(current, stepParms, maxDecodedBytes, nameEscapes, lookupContext);
    }
  }
  return current;
}

function readBigEndianUint(bytes: Uint8Array, offset: number, width: number, defaultValue: number): number {
  if (width === 0) return defaultValue;
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    value = value * 256 + (bytes[offset + i] ?? 0);
  }
  return value;
}

function skipHorizontalSpacesAndTabs(raw: string, start: number): number {
  let pos = start;
  while (pos < raw.length) {
    const code = raw.charCodeAt(pos);
    if (code !== 0x20 && code !== 0x09) break;
    pos += 1;
  }
  return pos;
}

function parseClassicXrefSection(
  raw: string,
  bytes: Uint8Array,
  sectionStart: number,
  emptyContext: PDFContext,
): { readonly dict: PDFDict; readonly entries: Map<number, ActiveXrefEntry> } {
  const entries = new Map<number, ActiveXrefEntry>();
  let pos = skipPdfWhitespaceAndComments(raw, sectionStart + 4);
  let subsectionCount = 0;

  while (pos < raw.length) {
    if (
      raw.startsWith('trailer', pos) &&
      (pos + 7 >= raw.length ||
        isPdfWhitespaceCode(raw.charCodeAt(pos + 7)) ||
        raw.charCodeAt(pos + 7) === 0x3c)
    ) {
      break;
    }
    subsectionCount += 1;
    if (subsectionCount > 10_000) {
      throw new PdfSignError('Bảng tham chiếu PDF có quá nhiều phân đoạn');
    }
    const firstTok = parseNonNegIntAt(raw, pos);
    if (!firstTok) {
      throw new PdfSignError('Bảng tham chiếu PDF không hợp lệ');
    }
    pos = skipPdfWhitespaceAndComments(raw, firstTok.nextPos);
    const countTok = parseNonNegIntAt(raw, pos);
    if (!countTok) {
      throw new PdfSignError('Bảng tham chiếu PDF không hợp lệ');
    }
    pos = skipPdfWhitespaceAndComments(raw, countTok.nextPos);
    if (
      countTok.value > MAX_XREF_STREAM_OBJECTS ||
      firstTok.value > MAX_XREF_OBJECT_NUMBER ||
      firstTok.value + countTok.value > MAX_XREF_OBJECT_NUMBER
    ) {
      throw new PdfSignError('Bảng tham chiếu PDF vượt giới hạn đối tượng');
    }

    for (let i = 0; i < countTok.value; i += 1) {
      pos = skipPdfWhitespaceAndComments(raw, pos);
      const field1Tok = parseNonNegIntAt(raw, pos);
      if (!field1Tok) {
        throw new PdfSignError('Mục bảng tham chiếu PDF không hợp lệ');
      }
      pos = skipHorizontalSpacesAndTabs(raw, field1Tok.nextPos);
      const genTok = parseNonNegIntAt(raw, pos);
      if (!genTok || genTok.value > 65535) {
        throw new PdfSignError('Thế hệ đối tượng trong bảng tham chiếu PDF không hợp lệ');
      }
      pos = skipHorizontalSpacesAndTabs(raw, genTok.nextPos);
      const flagCode = raw.charCodeAt(pos);
      if (flagCode !== 0x6e && flagCode !== 0x66) {
        throw new PdfSignError('Cờ trạng thái bảng tham chiếu PDF không hợp lệ');
      }
      pos += 1;
      if (pos < raw.length && !isPdfWhitespaceCode(raw.charCodeAt(pos))) {
        throw new PdfSignError('Ký tự kết thúc mục bảng tham chiếu PDF không hợp lệ');
      }
      const objNum = firstTok.value + i;
      const isInUse = flagCode === 0x6e;
      if (objNum === 0 && isInUse) {
        throw new PdfSignError('Đối tượng số 0 không thể ở trạng thái đang dùng');
      }
      if (entries.has(objNum)) {
        throw new PdfSignError('Bảng tham chiếu PDF chứa đối tượng trùng lặp trong cùng phân đoạn');
      }
      entries.set(
        objNum,
        isInUse ? { kind: 'offset', offset: field1Tok.value, gen: genTok.value } : { kind: 'free', gen: genTok.value },
      );
    }
    pos = skipPdfWhitespaceAndComments(raw, pos);
  }

  if (!raw.startsWith('trailer', pos)) {
    throw new PdfSignError('Bảng tham chiếu PDF thiếu từ khóa trailer');
  }
  const trailerDictPos = skipPdfWhitespaceAndComments(raw, pos + 7);
  if (!raw.startsWith('<<', trailerDictPos)) {
    throw new PdfSignError('Trailer PDF không phải từ điển hợp lệ');
  }
  const trailerObj = PDFObjectParser.forBytes(bytes.subarray(trailerDictPos), emptyContext, false).parseObject();
  if (!(trailerObj instanceof PDFDict)) {
    throw new PdfSignError('Trailer PDF không phải từ điển hợp lệ');
  }
  return { dict: trailerObj, entries };
}

function parseXrefStreamSection(
  raw: string,
  bytes: Uint8Array,
  sectionOffset: number,
  emptyContext: PDFContext,
  nameEscapes: RawPdfNameEscapes,
): { readonly dict: PDFDict; readonly entries: Map<number, ActiveXrefEntry>; readonly info: XrefStreamSectionInfo } {
  const entries = new Map<number, ActiveXrefEntry>();
  const hdr = parseIndirectObjHeaderAt(raw, sectionOffset, MAX_XREF_LEADING_WS);
  if (!hdr) {
    throw new PdfSignError('Không tìm thấy phần tham chiếu PDF hợp lệ');
  }
  let parsed: PDFObject;
  try {
    parsed = PDFObjectParser.forBytes(bytes.subarray(hdr.bodyStart), emptyContext, false).parseObject();
  } catch {
    throw new PdfSignError('Không giải mã được luồng tham chiếu PDF');
  }
  if (!(parsed instanceof PDFRawStream)) {
    throw new PdfSignError('Đối tượng tham chiếu PDF phải là luồng dữ liệu');
  }
  const typeEntry = getRawDictEntryByDecodedName(parsed.dict, 'Type', nameEscapes);
  assertPlainStructuralPdfName(typeEntry?.raw, nameEscapes, 'XRef', 'Loại luồng tham chiếu PDF không hợp lệ');

  const sizeObj = getRawDictEntryByDecodedName(parsed.dict, 'Size', nameEscapes)?.raw;
  if (!(sizeObj instanceof PDFNumber) || !Number.isSafeInteger(sizeObj.asNumber()) || sizeObj.asNumber() <= 0) {
    throw new PdfSignError('Trường /Size của luồng tham chiếu PDF không hợp lệ');
  }
  const sizeVal = sizeObj.asNumber();
  if (sizeVal > MAX_XREF_OBJECT_NUMBER) {
    throw new PdfSignError('Trường /Size của luồng tham chiếu PDF vượt giới hạn');
  }

  const wObj = getRawDictEntryByDecodedName(parsed.dict, 'W', nameEscapes)?.raw;
  if (!(wObj instanceof PDFArray) || wObj.size() !== 3) {
    throw new PdfSignError('Trường /W của luồng tham chiếu PDF không hợp lệ');
  }
  const widths: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const item = wObj.get(i);
    if (
      !(item instanceof PDFNumber) ||
      !Number.isSafeInteger(item.asNumber()) ||
      item.asNumber() < 0 ||
      item.asNumber() > 6
    ) {
      throw new PdfSignError('Độ rộng trường /W trong luồng tham chiếu PDF không hợp lệ');
    }
    widths.push(item.asNumber());
  }
  const w0 = widths[0] ?? 0;
  const w1 = widths[1] ?? 0;
  const w2 = widths[2] ?? 0;
  const entryWidth = w0 + w1 + w2;
  if (entryWidth <= 0) {
    throw new PdfSignError('Tổng độ rộng trường /W trong luồng tham chiếu PDF không hợp lệ');
  }

  const pairs: Array<{ readonly first: number; readonly count: number }> = [];
  const indexObj = getRawDictEntryByDecodedName(parsed.dict, 'Index', nameEscapes)?.raw;
  if (indexObj === undefined) {
    pairs.push({ first: 0, count: sizeVal });
  } else {
    if (
      !(indexObj instanceof PDFArray) ||
      indexObj.size() < 2 ||
      indexObj.size() % 2 !== 0 ||
      indexObj.size() > 20_000
    ) {
      throw new PdfSignError('Trường /Index của luồng tham chiếu PDF không hợp lệ');
    }
    for (let i = 0; i < indexObj.size(); i += 2) {
      const fObj = indexObj.get(i);
      const cObj = indexObj.get(i + 1);
      if (
        !(fObj instanceof PDFNumber) ||
        !(cObj instanceof PDFNumber) ||
        !Number.isSafeInteger(fObj.asNumber()) ||
        !Number.isSafeInteger(cObj.asNumber()) ||
        fObj.asNumber() < 0 ||
        cObj.asNumber() < 0 ||
        fObj.asNumber() > MAX_XREF_OBJECT_NUMBER ||
        cObj.asNumber() > MAX_XREF_STREAM_OBJECTS ||
        fObj.asNumber() + cObj.asNumber() > MAX_XREF_OBJECT_NUMBER
      ) {
        throw new PdfSignError('Cặp chỉ mục /Index trong luồng tham chiếu PDF không hợp lệ');
      }
      pairs.push({ first: fObj.asNumber(), count: cObj.asNumber() });
    }
  }

  let totalEntries = 0;
  for (const pair of pairs) {
    totalEntries += pair.count;
    if (totalEntries > MAX_XREF_STREAM_OBJECTS) {
      throw new PdfSignError('Số lượng mục tham chiếu PDF vượt giới hạn');
    }
  }

  const maxXrefDecodedBytes = Math.max(1024 * 1024, totalEntries * (entryWidth + 1) + 4096);
  const decoded = decodePdfStreamApplyingPredictor(
    parsed,
    emptyContext,
    maxXrefDecodedBytes,
    'Không giải nén được luồng tham chiếu PDF',
    nameEscapes,
  );
  if (decoded.byteLength !== totalEntries * entryWidth) {
    throw new PdfSignError('Kích thước luồng tham chiếu PDF không khớp số mục');
  }

  let cursor = 0;
  for (const pair of pairs) {
    for (let i = 0; i < pair.count; i += 1) {
      const entryType = readBigEndianUint(decoded, cursor, w0, 1);
      const field1 = readBigEndianUint(decoded, cursor + w0, w1, 0);
      const field2 = readBigEndianUint(decoded, cursor + w0 + w1, w2, 0);
      cursor += entryWidth;

      const objNum = pair.first + i;
      let parsedEntry: ActiveXrefEntry;
      if (entryType === 0) {
        parsedEntry = { kind: 'free', gen: field2 };
      } else if (entryType === 1) {
        if (objNum === 0) {
          throw new PdfSignError('Đối tượng số 0 không thể ở trạng thái đang dùng');
        }
        if (field2 > 65535) {
          throw new PdfSignError('Thế hệ đối tượng trong luồng tham chiếu PDF không hợp lệ');
        }
        parsedEntry = { kind: 'offset', offset: field1, gen: field2 };
      } else if (entryType === 2) {
        if (objNum === 0) {
          throw new PdfSignError('Đối tượng số 0 không thể nằm trong luồng đối tượng');
        }
        parsedEntry = { kind: 'objStm', objStmNum: field1, index: field2, gen: 0 };
      } else {
        throw new PdfSignError('Loại mục trong luồng tham chiếu PDF không hợp lệ');
      }

      if (entries.has(objNum)) {
        throw new PdfSignError('Luồng tham chiếu PDF chứa đối tượng trùng lặp trong cùng phân đoạn');
      }
      entries.set(objNum, parsedEntry);
    }
  }

  return {
    dict: parsed.dict,
    entries,
    info: { objNum: hdr.num, gen: hdr.gen, offset: sectionOffset, numStart: hdr.numStart },
  };
}

function parseBoundedXrefOffset(rawObj: PDFObject | undefined, eofOffset: number, errorMessage: string): number {
  if (
    !(rawObj instanceof PDFNumber) ||
    !Number.isSafeInteger(rawObj.asNumber()) ||
    rawObj.asNumber() < 0 ||
    rawObj.asNumber() >= eofOffset
  ) {
    throw new PdfSignError(errorMessage);
  }
  return rawObj.asNumber();
}

function areActiveXrefEntriesEqual(a: ActiveXrefEntry, b: ActiveXrefEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'free' && b.kind === 'free') {
    return true;
  }
  if (a.kind === 'offset' && b.kind === 'offset') {
    return a.offset === b.offset && a.gen === b.gen;
  }
  if (a.kind === 'objStm' && b.kind === 'objStm') {
    return a.objStmNum === b.objStmNum && a.index === b.index && a.gen === b.gen;
  }
  return false;
}

/** Validates and merges a hybrid trailer's `/XRefStm` stream into `sectionEntries`. */
function parseAndMergeHybridXrefStream(params: {
  readonly raw: string;
  readonly bytes: Uint8Array;
  readonly eofOffset: number;
  readonly emptyContext: PDFContext;
  readonly nameEscapes: RawPdfNameEscapes;
  readonly trailerDict: PDFDict;
  readonly rootRef: PDFRef;
  readonly xrefStmRaw: PDFObject;
  readonly expectedPrevXrefStmOffset: number | null;
  readonly visitedOffsets: Set<number>;
  readonly sectionEntries: Map<number, ActiveXrefEntry>;
  readonly xrefSections: XrefStreamSectionInfo[];
}): { readonly nextExpectedPrevXrefStmOffset: number | null; readonly stmSize: number } {
  const {
    raw,
    bytes,
    eofOffset,
    emptyContext,
    nameEscapes,
    trailerDict,
    rootRef,
    xrefStmRaw,
    expectedPrevXrefStmOffset,
    visitedOffsets,
    sectionEntries,
    xrefSections,
  } = params;

  const xrefStmOffset = parseBoundedXrefOffset(
    xrefStmRaw,
    eofOffset,
    'Tham chiếu /XRefStm trong bảng tham chiếu PDF không hợp lệ',
  );
  if (expectedPrevXrefStmOffset !== null && xrefStmOffset !== expectedPrevXrefStmOffset) {
    throw new PdfSignError('Chuỗi tham chiếu lai /XRefStm không khớp với mục /Prev');
  }
  if (visitedOffsets.has(xrefStmOffset)) {
    throw new PdfSignError('Chuỗi tham chiếu PDF chứa vòng lặp /XRefStm');
  }
  visitedOffsets.add(xrefStmOffset);

  const stmResult = parseXrefStreamSection(raw, bytes, xrefStmOffset, emptyContext, nameEscapes);
  if (getRawDictEntryByDecodedName(stmResult.dict, 'Encrypt', nameEscapes)) {
    throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
  }
  if (getRawDictEntryByDecodedName(stmResult.dict, 'XRefStm', nameEscapes)) {
    throw new PdfSignError('Không hỗ trợ /XRefStm lồng nhau trong luồng tham chiếu PDF');
  }

  const stmRootEntry = getRawDictEntryByDecodedName(stmResult.dict, 'Root', nameEscapes);
  if (stmRootEntry !== undefined) {
    const trailerRootRaw = getRawDictEntryByDecodedName(trailerDict, 'Root', nameEscapes)?.raw;
    const expectedSectionRoot = trailerRootRaw ?? rootRef;
    if (
      !(stmRootEntry.raw instanceof PDFRef) ||
      !(expectedSectionRoot instanceof PDFRef) ||
      stmRootEntry.raw.objectNumber !== expectedSectionRoot.objectNumber ||
      stmRootEntry.raw.generationNumber !== expectedSectionRoot.generationNumber
    ) {
      throw new PdfSignError('Gốc /Root trong luồng /XRefStm không khớp với trailer tham chiếu');
    }
  }

  let nextExpectedPrevXrefStmOffset: number | null = null;
  const stmPrevEntry = getRawDictEntryByDecodedName(stmResult.dict, 'Prev', nameEscapes);
  if (stmPrevEntry !== undefined) {
    const stmPrevOffset = parseBoundedXrefOffset(
      stmPrevEntry.raw,
      eofOffset,
      'Tham chiếu /Prev trong luồng /XRefStm không hợp lệ',
    );
    if (visitedOffsets.has(stmPrevOffset)) {
      throw new PdfSignError('Luồng /XRefStm chứa vòng lặp /Prev');
    }
    nextExpectedPrevXrefStmOffset = stmPrevOffset;
  }

  const stmSizeRaw = getRawDictEntryByDecodedName(stmResult.dict, 'Size', nameEscapes)?.raw;
  const stmSize =
    stmSizeRaw instanceof PDFNumber && Number.isSafeInteger(stmSizeRaw.asNumber()) && stmSizeRaw.asNumber() > 0
      ? stmSizeRaw.asNumber()
      : 0;

  normalizePdfDictAndEntries(stmResult.dict, nameEscapes);
  xrefSections.push(stmResult.info);

  // Hybrid /XRefStm entries must not silently conflict with or resurrect classic entries in the same section.
  for (const [objNum, stmEntry] of stmResult.entries) {
    const existingInSection = sectionEntries.get(objNum);
    if (existingInSection !== undefined) {
      if (!areActiveXrefEntriesEqual(existingInSection, stmEntry)) {
        throw new PdfSignError('Bảng tham chiếu lai /XRefStm xung đột mục đối tượng với bảng xref');
      }
    } else {
      sectionEntries.set(objNum, stmEntry);
    }
  }

  return { nextExpectedPrevXrefStmOffset, stmSize };
}

function parseActiveXrefChain(
  bytes: Uint8Array,
  raw: string,
  startXrefOffset: number,
  eofOffset: number,
  nameEscapes: RawPdfNameEscapes,
): {
  readonly entries: Map<number, ActiveXrefEntry>;
  readonly rootRef: PDFRef;
  readonly xrefSections: ReadonlyArray<XrefStreamSectionInfo>;
  readonly tailSize: number;
} {
  const emptyContext = PDFContext.create();
  const entries = new Map<number, ActiveXrefEntry>();
  const visitedOffsets = new Set<number>();
  const xrefSections: XrefStreamSectionInfo[] = [];
  let rootRef: PDFRef | null = null;
  let tailSize = 0;
  let currentOffset: number | null = startXrefOffset;
  let expectedPrevXrefStmOffset: number | null = null;
  let sectionIdx = 0;
  let sectionCount = 0;

  while (currentOffset !== null) {
    if (sectionCount >= MAX_XREF_SECTIONS) {
      throw new PdfSignError('Chuỗi tham chiếu PDF có quá nhiều phiên bản');
    }
    if (visitedOffsets.has(currentOffset)) {
      throw new PdfSignError('Chuỗi tham chiếu PDF chứa vòng lặp /Prev');
    }
    visitedOffsets.add(currentOffset);
    sectionCount += 1;

    const sectionStart = skipAsciiPdfWhitespace(raw, currentOffset, MAX_XREF_LEADING_WS);
    const isClassicSection =
      raw.startsWith('xref', sectionStart) &&
      sectionStart + 4 < raw.length &&
      isPdfWhitespaceCode(raw.charCodeAt(sectionStart + 4));
    let trailerDict: PDFDict;
    let sectionEntries: Map<number, ActiveXrefEntry>;
    if (isClassicSection) {
      const classicResult = parseClassicXrefSection(raw, bytes, sectionStart, emptyContext);
      trailerDict = classicResult.dict;
      sectionEntries = classicResult.entries;
    } else {
      if (expectedPrevXrefStmOffset !== null) {
        throw new PdfSignError('Chuỗi tham chiếu lai /XRefStm không khớp với mục /Prev');
      }
      const stmResult = parseXrefStreamSection(raw, bytes, currentOffset, emptyContext, nameEscapes);
      trailerDict = stmResult.dict;
      sectionEntries = stmResult.entries;
      xrefSections.push(stmResult.info);
    }

    if (getRawDictEntryByDecodedName(trailerDict, 'Encrypt', nameEscapes)) {
      throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
    }
    const sizeRaw = getRawDictEntryByDecodedName(trailerDict, 'Size', nameEscapes)?.raw;

    if (sectionIdx === 0) {
      if (sizeRaw instanceof PDFNumber && Number.isSafeInteger(sizeRaw.asNumber()) && sizeRaw.asNumber() > 0) {
        tailSize = sizeRaw.asNumber();
      }
      const rootObj = getRawDictEntryByDecodedName(trailerDict, 'Root', nameEscapes)?.raw;
      if (!(rootObj instanceof PDFRef)) {
        throw new PdfSignError('Trailer PDF thiếu tham chiếu /Root hợp lệ');
      }
      rootRef = rootObj;
    }
    if (!rootRef) {
      throw new PdfSignError('Không xác định được gốc /Root của tài liệu PDF');
    }

    const xrefStmEntry = getRawDictEntryByDecodedName(trailerDict, 'XRefStm', nameEscapes);
    let nextExpectedPrevXrefStmOffset: number | null = null;
    if (xrefStmEntry !== undefined) {
      if (!isClassicSection) {
        throw new PdfSignError('Không hỗ trợ /XRefStm bên trong luồng tham chiếu PDF');
      }
      if (sectionCount >= MAX_XREF_SECTIONS) {
        throw new PdfSignError('Chuỗi tham chiếu PDF có quá nhiều phiên bản');
      }
      sectionCount += 1;
      const hybrid = parseAndMergeHybridXrefStream({
        raw,
        bytes,
        eofOffset,
        emptyContext,
        nameEscapes,
        trailerDict,
        rootRef,
        xrefStmRaw: xrefStmEntry.raw,
        expectedPrevXrefStmOffset,
        visitedOffsets,
        sectionEntries,
        xrefSections,
      });
      expectedPrevXrefStmOffset = null;
      nextExpectedPrevXrefStmOffset = hybrid.nextExpectedPrevXrefStmOffset;
      if (sectionIdx === 0 && hybrid.stmSize > 0) {
        tailSize = Math.max(tailSize, hybrid.stmSize);
      }
    } else if (expectedPrevXrefStmOffset !== null) {
      throw new PdfSignError('Chuỗi tham chiếu lai /XRefStm không khớp với mục /Prev');
    }

    // Newer sections (including free entries) take precedence over older /Prev sections.
    for (const [objNum, secEntry] of sectionEntries) {
      if (!entries.has(objNum)) {
        entries.set(objNum, secEntry);
      }
    }

    const prevObj = getRawDictEntryByDecodedName(trailerDict, 'Prev', nameEscapes)?.raw;
    if (prevObj !== undefined) {
      currentOffset = parseBoundedXrefOffset(
        prevObj,
        eofOffset,
        'Tham chiếu /Prev trong bảng tham chiếu PDF không hợp lệ',
      );
      if (nextExpectedPrevXrefStmOffset !== null && nextExpectedPrevXrefStmOffset === currentOffset) {
        throw new PdfSignError('Chuỗi tham chiếu PDF chứa vòng lặp /Prev và /XRefStm');
      }
    } else {
      if (nextExpectedPrevXrefStmOffset !== null) {
        throw new PdfSignError('Luồng /XRefStm khai báo /Prev nhưng trailer không có /Prev');
      }
      currentOffset = null;
    }
    expectedPrevXrefStmOffset = nextExpectedPrevXrefStmOffset;
    normalizePdfDictAndEntries(trailerDict, nameEscapes);
    sectionIdx += 1;
  }

  if (expectedPrevXrefStmOffset !== null) {
    throw new PdfSignError('Chuỗi tham chiếu lai /XRefStm không khớp với mục /Prev');
  }

  if (!rootRef) {
    throw new PdfSignError('Không xác định được gốc /Root của tài liệu PDF');
  }

  for (const sec of xrefSections) {
    const entry = entries.get(sec.objNum);
    if (
      !entry ||
      entry.kind !== 'offset' ||
      entry.gen !== sec.gen ||
      entry.offset < sec.offset ||
      entry.offset > sec.numStart
    ) {
      throw new PdfSignError('Vị trí luồng tham chiếu PDF không khớp với bảng tham chiếu');
    }
  }

  return { entries, rootRef, xrefSections, tailSize };
}

function decodeObjectStreamEntries(stm: PDFRawStream, nameEscapes: RawPdfNameEscapes): DecodedObjStmInfo {
  const stmTypeEntry = getRawDictEntryByDecodedName(stm.dict, 'Type', nameEscapes);
  assertPlainStructuralPdfName(stmTypeEntry?.raw, nameEscapes, 'ObjStm', 'Đối tượng /ObjStm không hợp lệ');
  if (getRawDictEntryByDecodedName(stm.dict, 'Extends', nameEscapes)) {
    throw new PdfSignError('Không hỗ trợ luồng đối tượng PDF có /Extends');
  }
  const nObj = getRawDictEntryByDecodedName(stm.dict, 'N', nameEscapes)?.raw;
  const firstObj = getRawDictEntryByDecodedName(stm.dict, 'First', nameEscapes)?.raw;
  if (
    !(nObj instanceof PDFNumber) ||
    !(firstObj instanceof PDFNumber) ||
    !Number.isSafeInteger(nObj.asNumber()) ||
    !Number.isSafeInteger(firstObj.asNumber()) ||
    nObj.asNumber() < 0 ||
    nObj.asNumber() > MAX_XREF_STREAM_OBJECTS ||
    firstObj.asNumber() < 0
  ) {
    throw new PdfSignError('Siêu dữ liệu /ObjStm của tệp PDF không hợp lệ');
  }

  const pipeline = extractStreamFilterPipeline(stm.dict, nameEscapes);
  for (const p of pipeline.parms) {
    if (p && parsePredictorParams(p, nameEscapes).predictor !== 1) {
      throw new PdfSignError('Không hỗ trợ /Predictor trong luồng đối tượng /ObjStm');
    }
  }

  const decodedBytes = decodePdfStreamApplyingPredictor(
    stm,
    PDFContext.create(),
    EXTRACT_LIMITS.maxFileBytes * 4,
    'Không giải nén được luồng đối tượng /ObjStm',
    nameEscapes,
  );
  const nCount = nObj.asNumber();
  const firstOffset = firstObj.asNumber();
  if (firstOffset > decodedBytes.byteLength) {
    throw new PdfSignError('Độ lệch /First của luồng /ObjStm vượt kích thước dữ liệu');
  }

  const headerStr = Buffer.from(decodedBytes.subarray(0, firstOffset)).toString('latin1');
  const members = new Map<number, { readonly memberNum: number; readonly absOffset: number }>();
  const memberList: Array<{ readonly index: number; readonly memberNum: number; readonly absOffset: number }> = [];
  const seenMemberNums = new Set<number>();
  let hPos = 0;

  for (let i = 0; i < nCount; i += 1) {
    hPos = skipPdfWhitespaceAndComments(headerStr, hPos);
    const memberTok = parseNonNegIntAt(headerStr, hPos);
    if (!memberTok || memberTok.value <= 0 || memberTok.value > MAX_XREF_OBJECT_NUMBER) {
      throw new PdfSignError('Số hiệu đối tượng trong /ObjStm không hợp lệ');
    }
    hPos = skipPdfWhitespaceAndComments(headerStr, memberTok.nextPos);
    const relTok = parseNonNegIntAt(headerStr, hPos);
    if (!relTok || firstOffset + relTok.value >= decodedBytes.byteLength) {
      throw new PdfSignError('Độ lệch đối tượng trong /ObjStm không hợp lệ');
    }
    hPos = relTok.nextPos;

    if (seenMemberNums.has(memberTok.value)) {
      throw new PdfSignError('Luồng /ObjStm chứa đối tượng trùng lặp');
    }
    seenMemberNums.add(memberTok.value);

    const absOffset = firstOffset + relTok.value;
    members.set(i, { memberNum: memberTok.value, absOffset });
    memberList.push({ index: i, memberNum: memberTok.value, absOffset });
  }

  return { decodedBytes, members, memberList };
}

function scanRawTopLevelDefinitions(
  bytes: Uint8Array,
  raw: string,
  nameEscapes: RawPdfNameEscapes,
  externalLengthLookup?: PdfLengthResolver,
): {
  readonly topLevelHeaders: Map<number, { readonly num: number; readonly gen: number; readonly bodyStart: number }>;
  readonly lastDef: Map<number, ObjectDefinitionLocation>;
} {
  const emptyContext = PDFContext.create();
  const topLevelHeaders = new Map<number, { readonly num: number; readonly gen: number; readonly bodyStart: number }>();
  const lastDef = new Map<number, ObjectDefinitionLocation>();
  const parsedInts = new Map<string, number>();
  const recentTokens: RecentPdfToken[] = [];
  let currentObj: {
    readonly num: number;
    readonly gen: number;
    readonly offset: number;
    readonly bodyStart: number;
    bodySingleInt: number | null;
    bodyTokenCount: number;
  } | null = null;
  let seenStreamInObj = false;
  let bracketDepth = 0;
  let pos = 0;

  while (pos < raw.length) {
    const code = raw.charCodeAt(pos);
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25) {
      pos += 1;
      while (pos < raw.length) {
        const ch = raw.charCodeAt(pos);
        pos += 1;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    if (code === 0x28) {
      pos = skipPdfLiteralString(raw, pos + 1);
      if (currentObj) currentObj.bodyTokenCount += 1;
      recentTokens.length = 0;
      continue;
    }
    if (code === 0x3c) {
      if (pos + 1 < raw.length && raw.charCodeAt(pos + 1) === 0x3c) {
        const dictInfo = extractRawPdfDictAt(raw, pos, raw.length - pos);
        if (dictInfo.slice === null) {
          throw new PdfSignError('Cấu trúc từ điển PDF không hợp lệ');
        }
        if (currentObj) currentObj.bodyTokenCount += 1;
        pos += dictInfo.scannedBytes;
        recentTokens.length = 0;

        if (bracketDepth === 0) {
          const dictMeta = inspectRawDictTopLevelNames(dictInfo.slice);
          if (dictMeta.hasEscapedStructuralType) {
            throw new PdfSignError('Tệp PDF chứa tên cấu trúc bị làm rối không hợp lệ');
          }
          const streamDataStart = findPdfStreamDataStart(raw, pos);
          if (streamDataStart >= 0) {
            const resolvedLength =
              dictMeta.directLength ??
              (dictMeta.indirectLengthRef
                ? (parsedInts.get(dictMeta.indirectLengthRef) ??
                  externalLengthLookup?.(dictMeta.indirectLengthRef))
                : undefined);
            pos = findStreamBodyEnd(raw, streamDataStart, resolvedLength);

            if (currentObj !== null && !seenStreamInObj) {
              seenStreamInObj = true;
              if (dictMeta.isObjStmType) {
                let parsedStm: PDFObject;
                try {
                  parsedStm = PDFObjectParser.forBytes(
                    bytes.subarray(currentObj.bodyStart),
                    emptyContext,
                    false,
                  ).parseObject();
                } catch {
                  throw new PdfSignError('Không đọc được luồng đối tượng /ObjStm');
                }
                if (!(parsedStm instanceof PDFRawStream)) {
                  throw new PdfSignError('Đối tượng /ObjStm phải là luồng dữ liệu hợp lệ');
                }
                const stmInfo = decodeObjectStreamEntries(parsedStm, nameEscapes);
                for (const member of stmInfo.memberList) {
                  lastDef.set(member.memberNum, {
                    kind: 'objStm',
                    num: member.memberNum,
                    gen: 0,
                    stmNum: currentObj.num,
                    stmGen: currentObj.gen,
                    stmOffset: currentObj.offset,
                    index: member.index,
                  });
                }
              }
            }
          }
        }
        continue;
      }

      pos += 1;
      while (pos < raw.length && raw.charCodeAt(pos) !== 0x3e) {
        pos += 1;
      }
      if (pos < raw.length) pos += 1;
      if (currentObj) currentObj.bodyTokenCount += 1;
      recentTokens.length = 0;
      continue;
    }
    if (code === 0x5b) {
      bracketDepth += 1;
      if (currentObj) currentObj.bodyTokenCount += 1;
      recentTokens.length = 0;
      pos += 1;
      continue;
    }
    if (code === 0x5d) {
      if (bracketDepth > 0) bracketDepth -= 1;
      if (currentObj) currentObj.bodyTokenCount += 1;
      recentTokens.length = 0;
      pos += 1;
      continue;
    }
    if (code === 0x2f) {
      pos += 1;
      while (pos < raw.length) {
        const ch = raw.charCodeAt(pos);
        if (isPdfWhitespaceCode(ch) || isPdfDelimiterCode(ch)) break;
        pos += 1;
      }
      if (currentObj) currentObj.bodyTokenCount += 1;
      recentTokens.length = 0;
      continue;
    }
    if (isPdfDelimiterCode(code)) {
      recentTokens.length = 0;
      pos += 1;
      continue;
    }

    const tokStart = pos;
    pos += 1;
    while (pos < raw.length) {
      const ch = raw.charCodeAt(pos);
      if (isPdfWhitespaceCode(ch) || isPdfDelimiterCode(ch)) break;
      pos += 1;
    }
    const tok = raw.slice(tokStart, pos);

    if (bracketDepth === 0) {
      const header = parseIndirectObjHeader(tok, recentTokens);
      if (header) {
        if (header.num === 0) {
          throw new PdfSignError('Tệp PDF chứa định nghĩa đối tượng số 0 không hợp lệ');
        }
        const hdr = { num: header.num, gen: header.gen, bodyStart: pos };
        topLevelHeaders.set(header.startOffset, hdr);
        lastDef.set(header.num, {
          kind: 'toplevel',
          num: header.num,
          gen: header.gen,
          offset: header.startOffset,
          bodyStart: pos,
        });
        currentObj = {
          num: header.num,
          gen: header.gen,
          offset: header.startOffset,
          bodyStart: pos,
          bodySingleInt: null,
          bodyTokenCount: 0,
        };
        seenStreamInObj = false;
        recentTokens.length = 0;
        continue;
      }

      if (tok === 'endobj') {
        if (currentObj && currentObj.bodyTokenCount === 1 && currentObj.bodySingleInt !== null) {
          parsedInts.set(`${currentObj.num} ${currentObj.gen} R`, currentObj.bodySingleInt);
        }
        currentObj = null;
        seenStreamInObj = false;
        recentTokens.length = 0;
        continue;
      }
    }

    const isDigits = isAllAsciiDigits(tok);
    if (currentObj) {
      currentObj.bodyTokenCount += 1;
      if (currentObj.bodyTokenCount === 1 && isDigits) {
        const parsedVal = Number.parseInt(tok, 10);
        if (Number.isSafeInteger(parsedVal)) {
          currentObj.bodySingleInt = parsedVal;
        }
      } else {
        currentObj.bodySingleInt = null;
      }
    }
    recentTokens.push({ text: tok, start: tokStart, isDigits });
    if (recentTokens.length > 3) {
      recentTokens.shift();
    }
  }

  return { topLevelHeaders, lastDef };
}

function arePdfObjectsStructurallyEqual(a: PDFObject | undefined, b: PDFObject | undefined, depth = 0): boolean {
  if (a === b) return true;
  if (!a || !b || depth > MAX_STRUCTURAL_EQ_DEPTH) return false;
  if (a === PDFNull || b === PDFNull) return a === b;
  if (a instanceof PDFBool && b instanceof PDFBool) return a.asBoolean() === b.asBoolean();
  if (a instanceof PDFNumber && b instanceof PDFNumber) return a.asNumber() === b.asNumber();
  if (a instanceof PDFName && b instanceof PDFName) return a.asString() === b.asString();
  if (a instanceof PDFString && b instanceof PDFString) return a.asString() === b.asString();
  if (a instanceof PDFHexString && b instanceof PDFHexString) return a.asString() === b.asString();
  if (a instanceof PDFRef && b instanceof PDFRef) {
    return a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
  }
  if (a instanceof PDFArray && b instanceof PDFArray) {
    if (a.size() !== b.size()) return false;
    for (let i = 0; i < a.size(); i += 1) {
      if (!arePdfObjectsStructurallyEqual(a.get(i), b.get(i), depth + 1)) return false;
    }
    return true;
  }
  if (a instanceof PDFRawStream && b instanceof PDFRawStream) {
    if (!arePdfObjectsStructurallyEqual(a.dict, b.dict, depth + 1)) return false;
    if (a.contents.byteLength !== b.contents.byteLength) return false;
    return Buffer.compare(a.contents, b.contents) === 0;
  }
  if (a instanceof PDFDict && b instanceof PDFDict && !(a instanceof PDFStream) && !(b instanceof PDFStream)) {
    const aEntries = a.entries();
    const bEntries = b.entries();
    if (aEntries.length !== bEntries.length) return false;
    for (const [key, val] of aEntries) {
      const bVal = b.get(key, true);
      if (bVal === undefined) return false;
      if (!arePdfObjectsStructurallyEqual(val, bVal, depth + 1)) return false;
    }
    return true;
  }
  return false;
}

export interface ValidatedPdfForUpdate {
  readonly pdfDoc: PDFDocument;
  readonly prevStartXrefOffset: number;
  readonly isXrefStream: boolean;
  readonly maxObjNum: number;
}

function verifyPdfCrossReferenceConsistency(
  bytes: Uint8Array,
  pdfDoc: PDFDocument,
  nameEscapes: RawPdfNameEscapes,
  externalLengthLookup?: PdfLengthResolver,
): { readonly prevStartXrefOffset: number; readonly isXrefStream: boolean; readonly maxObjNum: number } {
  const raw = Buffer.from(bytes).toString('latin1');
  const { startXrefOffset, eofOffset } = parseTailStartXref(raw);
  const { entries, rootRef, xrefSections, tailSize } = parseActiveXrefChain(bytes, raw, startXrefOffset, eofOffset, nameEscapes);

  const loadedRoot = pdfDoc.context.trailerInfo.Root;
  if (
    !(loadedRoot instanceof PDFRef) ||
    loadedRoot.objectNumber !== rootRef.objectNumber ||
    loadedRoot.generationNumber !== rootRef.generationNumber
  ) {
    throw new PdfSignError('Gốc /Root của tệp PDF không khớp với trailer tham chiếu');
  }
  const rootEntry = entries.get(rootRef.objectNumber);
  if (!rootEntry || rootEntry.kind === 'free' || rootEntry.gen !== rootRef.generationNumber) {
    throw new PdfSignError('Gốc /Root của tệp PDF không hoạt động trong bảng tham chiếu');
  }
  if (!(pdfDoc.context.lookup(rootRef) instanceof PDFDict)) {
    throw new PdfSignError('Đối tượng gốc /Root của tệp PDF không hợp lệ');
  }

  for (const [ref] of pdfDoc.context.enumerateIndirectObjects()) {
    const entry = entries.get(ref.objectNumber);
    if (!entry || entry.kind === 'free' || entry.gen !== ref.generationNumber) {
      throw new PdfSignError('Tệp PDF chứa đối tượng ẩn hoặc bị xóa không khớp bảng tham chiếu');
    }
  }

  const { topLevelHeaders, lastDef } = scanRawTopLevelDefinitions(
    bytes,
    raw,
    nameEscapes,
    externalLengthLookup,
  );
  for (const [objNum] of lastDef) {
    const entry = entries.get(objNum);
    if (!entry || entry.kind === 'free') {
      throw new PdfSignError('Tệp PDF chứa đối tượng ẩn hoặc bị xóa không khớp bảng tham chiếu');
    }
  }
  const decodedObjStmCache = new Map<number, DecodedObjStmInfo>();

  for (const [objNum, entry] of entries) {
    if (entry.kind === 'free') continue;
    const ref = PDFRef.of(objNum, entry.gen);
    const loadedObj = pdfDoc.context.lookup(ref);
    const latest = lastDef.get(objNum);
    if (!latest) {
      throw new PdfSignError('Thiếu định nghĩa đối tượng tương ứng trong tệp PDF');
    }

    if (entry.kind === 'offset') {
      const adjustedStart = skipAsciiPdfWhitespace(raw, entry.offset, MAX_XREF_LEADING_WS);
      const hdr = topLevelHeaders.get(adjustedStart);
      if (!hdr || hdr.num !== objNum || hdr.gen !== entry.gen) {
        throw new PdfSignError('Độ lệch trong bảng tham chiếu PDF không trỏ tới đối tượng hợp lệ');
      }
      if (latest.kind !== 'toplevel' || latest.gen !== entry.gen || latest.offset !== adjustedStart) {
        throw new PdfSignError('Tệp PDF chứa đối tượng trùng lặp gây xung đột với bảng tham chiếu');
      }

      let directParsed: PDFObject;
      try {
        directParsed = PDFObjectParser.forBytes(bytes.subarray(hdr.bodyStart), pdfDoc.context, false).parseObject();
      } catch {
        throw new PdfSignError('Không phân tích lại được đối tượng tại độ lệch tham chiếu');
      }

      const typeEntry =
        directParsed instanceof PDFRawStream
          ? getRawDictEntryByDecodedName(directParsed.dict, 'Type', nameEscapes)
          : undefined;
      const streamTypeName =
        typeEntry?.raw instanceof PDFName
          ? decodeUnnormalizedPdfName(typeEntry.raw, nameEscapes)
          : undefined;
      if (
        (streamTypeName === 'ObjStm' || streamTypeName === 'XRef') &&
        typeEntry?.raw !== PDFName.of(streamTypeName)
      ) {
        throw new PdfSignError('Tệp PDF chứa giá trị /Type cấu trúc bị mã hóa hex không hợp lệ');
      }
      const isStructuralStream = streamTypeName === 'ObjStm' || streamTypeName === 'XRef';
      if (
        streamTypeName === 'XRef' &&
        !xrefSections.some(
          (sec) =>
            sec.objNum === objNum &&
            sec.gen === entry.gen &&
            entry.offset >= sec.offset &&
            entry.offset <= sec.numStart,
        )
      ) {
        throw new PdfSignError('Tệp PDF chứa luồng /XRef không thuộc chuỗi tham chiếu hoạt động');
      }
      if (loadedObj === undefined) {
        if (!isStructuralStream) {
          throw new PdfSignError('Bảng tham chiếu PDF trỏ tới đối tượng không tồn tại');
        }
      } else if (!arePdfObjectsStructurallyEqual(directParsed, loadedObj)) {
        throw new PdfSignError('Đối tượng PDF bị ghi đè trái với bảng tham chiếu hoạt động');
      }

      if (directParsed instanceof PDFRawStream) {
        const lenObj = getRawDictEntryByDecodedName(directParsed.dict, 'Length', nameEscapes)?.raw;
        if (lenObj !== undefined) {
          const resolvedLen = pdfDoc.context.lookupMaybe(lenObj, PDFNumber);
          if (!resolvedLen || !Number.isSafeInteger(resolvedLen.asNumber()) || resolvedLen.asNumber() < 0) {
            throw new PdfSignError('Độ dài luồng dữ liệu PDF không hợp lệ');
          }
          const declared = resolvedLen.asNumber();
          const actual = directParsed.contents.byteLength;
          if (actual < declared || actual > declared + 2) {
            throw new PdfSignError('Độ dài luồng dữ liệu PDF không khớp với phần thân stream');
          }
          for (let k = declared; k < actual; k += 1) {
            const byte = directParsed.contents[k];
            if (byte !== 0x0a && byte !== 0x0d) {
              throw new PdfSignError('Độ dài luồng dữ liệu PDF không khớp với phần thân stream');
            }
          }
        }
        if (streamTypeName === 'ObjStm' && !decodedObjStmCache.has(objNum)) {
          decodedObjStmCache.set(objNum, decodeObjectStreamEntries(directParsed, nameEscapes));
        }
      }
    } else {
      if (loadedObj === undefined) {
        throw new PdfSignError('Bảng tham chiếu PDF trỏ tới đối tượng không tồn tại trong /ObjStm');
      }
      const stmEntry = entries.get(entry.objStmNum);
      if (!stmEntry || stmEntry.kind !== 'offset') {
        throw new PdfSignError('Luồng đối tượng /ObjStm tham chiếu không hợp lệ');
      }
      if (
        latest.kind !== 'objStm' ||
        latest.stmNum !== entry.objStmNum ||
        latest.index !== entry.index ||
        latest.gen !== 0
      ) {
        throw new PdfSignError('Tệp PDF chứa đối tượng ghi đè xung đột với luồng /ObjStm');
      }
      let stmInfo = decodedObjStmCache.get(entry.objStmNum);
      if (!stmInfo) {
        const stmAdjustedStart = skipAsciiPdfWhitespace(raw, stmEntry.offset, MAX_XREF_LEADING_WS);
        const stmHdr = topLevelHeaders.get(stmAdjustedStart);
        if (!stmHdr || stmHdr.num !== entry.objStmNum || stmHdr.gen !== stmEntry.gen) {
          throw new PdfSignError('Độ lệch luồng /ObjStm không khớp với bảng tham chiếu');
        }
        let stmParsed: PDFObject;
        try {
          stmParsed = PDFObjectParser.forBytes(bytes.subarray(stmHdr.bodyStart), pdfDoc.context, false).parseObject();
        } catch {
          throw new PdfSignError('Không đọc được luồng đối tượng /ObjStm');
        }
        if (!(stmParsed instanceof PDFRawStream)) {
          throw new PdfSignError('Đối tượng /ObjStm trong bảng tham chiếu không phải luồng đối tượng');
        }
        const stmTypeEntry = getRawDictEntryByDecodedName(stmParsed.dict, 'Type', nameEscapes);
        assertPlainStructuralPdfName(
          stmTypeEntry?.raw,
          nameEscapes,
          'ObjStm',
          'Đối tượng /ObjStm trong bảng tham chiếu không phải luồng đối tượng',
        );
        stmInfo = decodeObjectStreamEntries(stmParsed, nameEscapes);
        decodedObjStmCache.set(entry.objStmNum, stmInfo);
      }
      const member = stmInfo.members.get(entry.index);
      if (!member || member.memberNum !== objNum) {
        throw new PdfSignError('Chỉ mục đối tượng trong luồng /ObjStm không khớp bảng tham chiếu');
      }
      let memberParsed: PDFObject;
      try {
        memberParsed = PDFObjectParser.forBytes(
          stmInfo.decodedBytes.subarray(member.absOffset),
          pdfDoc.context,
          false,
        ).parseObject();
      } catch {
        throw new PdfSignError('Không phân tích được đối tượng bên trong luồng /ObjStm');
      }
      if (memberParsed instanceof PDFStream) {
        throw new PdfSignError('Luồng đối tượng /ObjStm không được chứa luồng con');
      }
      if (!arePdfObjectsStructurallyEqual(memberParsed, loadedObj)) {
        throw new PdfSignError('Nội dung đối tượng trong /ObjStm bị ghi đè trái bảng tham chiếu');
      }
    }
  }

  let maxObjNum = Math.max(pdfDoc.context.largestObjectNumber, tailSize > 0 ? tailSize - 1 : 0);
  for (const objNum of entries.keys()) {
    if (objNum > maxObjNum) maxObjNum = objNum;
  }
  return {
    prevStartXrefOffset: startXrefOffset,
    isXrefStream: xrefSections.some((sec) => sec.offset === startXrefOffset),
    maxObjNum,
  };
}

async function loadValidatedPdfInternal(
  bytes: Uint8Array,
  maxPages: number = EXTRACT_LIMITS.maxPdfSignPages,
): Promise<ValidatedPdfForUpdate> {
  if (bytes.byteLength > EXTRACT_LIMITS.maxFileBytes) {
    throw new PdfSignError('Tệp PDF vượt quá dung lượng cho phép');
  }
  assertPdfMagic(bytes);
  const nameEscapes = inspectRawPdfSyntax(bytes);

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new PdfSignError('Không hỗ trợ PDF có mật khẩu hoặc mã hóa');
    }
    throw new PdfSignError('Không đọc được cấu trúc tệp PDF');
  }

  const lengthResolver = createPdfDocLengthResolver(pdfDoc);
  const resolvedNameEscapes = nameEscapes.hasUnresolvedIndirectLength
    ? inspectRawPdfSyntax(bytes, lengthResolver)
    : nameEscapes;

  const xrefMeta = verifyPdfCrossReferenceConsistency(bytes, pdfDoc, resolvedNameEscapes, lengthResolver);
  scanPdfObjectGraph(pdfDoc, resolvedNameEscapes);
  normalizeAllPdfNames(pdfDoc, resolvedNameEscapes);
  validatePageContentsAndXObjectsGraphicsBalance(
    pdfDoc,
    createGraphicsBalanceVisitState(),
    { remainingBytes: EXTRACT_LIMITS.maxFileBytes * 4 },
    PDFContext.create(),
  );

  const pages = pdfDoc.getPages();
  if (pages.length < 1 || pages.length > maxPages) {
    throw new PdfSignError(`Số trang PDF phải từ 1 đến ${maxPages}`);
  }
  for (const page of pages) {
    getPageMetrics(pdfDoc, page);
  }
  return {
    pdfDoc,
    prevStartXrefOffset: xrefMeta.prevStartXrefOffset,
    isXrefStream: xrefMeta.isXrefStream,
    maxObjNum: xrefMeta.maxObjNum,
  };
}

async function loadValidatedPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const validated = await loadValidatedPdfInternal(bytes);
  return validated.pdfDoc;
}

export async function loadValidatedPdfForIncrementalUpdate(
  bytes: Uint8Array,
  options?: { readonly maxPages?: number },
): Promise<ValidatedPdfForUpdate> {
  return loadValidatedPdfInternal(bytes, options?.maxPages ?? EXTRACT_LIMITS.maxPdfSignPages);
}

function normalizeExtractedText(raw: string): string {
  const lines = raw
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .split('\n')
    .map((line) => {
      let cleaned = '';
      for (const ch of line) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
          if (cp === 0x09) cleaned += ' ';
          continue;
        }
        cleaned += ch;
      }
      return cleaned.replace(/ {2,}/g, ' ').trimEnd();
    });

  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === '' && (collapsed.length === 0 || collapsed[collapsed.length - 1] === '')) continue;
    collapsed.push(line);
  }
  return collapsed.join('\n').trim();
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let out = '';
  let used = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (used + chBytes > maxBytes) break;
    out += ch;
    used += chBytes;
  }
  return out;
}

function capPerPageTexts(texts: readonly string[], maxTotalBytes: number): string[] {
  const count = texts.length;
  if (count === 0) return [];
  const byteLengths = texts.map((text) => Buffer.byteLength(text, 'utf8'));
  const totalBytes = byteLengths.reduce((sum, n) => sum + n, 0);
  if (totalBytes <= maxTotalBytes) {
    return [...texts];
  }

  // Water-fill byte budgets across pages so dense early pages do not starve later pages.
  const order = texts.map((_, index) => index).sort((a, b) => (byteLengths[a] ?? 0) - (byteLengths[b] ?? 0));
  const budgets = Array.from({ length: count }, () => 0);
  let remainingBytes = maxTotalBytes;
  let remainingPages = count;

  for (let pos = 0; pos < order.length; pos++) {
    const idx = order[pos];
    if (idx === undefined) continue;
    const len = byteLengths[idx] ?? 0;
    const share = Math.floor(remainingBytes / remainingPages);
    if (len <= share) {
      budgets[idx] = len;
      remainingBytes -= len;
      remainingPages -= 1;
    } else {
      const base = Math.floor(remainingBytes / remainingPages);
      let extra = remainingBytes % remainingPages;
      for (let rest = pos; rest < order.length; rest++) {
        const restIdx = order[rest];
        if (restIdx === undefined) continue;
        budgets[restIdx] = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra -= 1;
      }
      break;
    }
  }

  return texts.map((text, index) => truncateUtf8Bytes(text, budgets[index] ?? 0));
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspectResult> {
  const pdfDoc = await loadValidatedPdf(bytes);
  await validatePdfSourceFlattenable(pdfDoc);
  const { getDocumentProxy } = await import('unpdf');

  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Copy into an isolated Uint8Array so pdf.js transfer/cleanup never detaches the caller's buffer.
    const pdfData = new Uint8Array(bytes);
    // Never let pdf.js evaluate code from the document; the worker process also sets --disallow-code-generation-from-strings.
    proxy = await getDocumentProxy(pdfData, { isEvalSupported: false } as Parameters<typeof getDocumentProxy>[1]);
  } catch {
    throw new PdfSignError('Không thể đọc nội dung tệp PDF');
  }

  try {
    const pageCount = pdfDoc.getPageCount();
    if (proxy.numPages !== pageCount) {
      throw new PdfSignError('Số trang PDF không nhất quán');
    }

    const rawPages: string[] = [];
    const pageGeometries: Array<{ readonly widthPt: number; readonly heightPt: number; readonly rotation: PageRotation }> = [];
    const detectedTags: PdfDetectedTag[] = [];

    for (let i = 0; i < pageCount; i++) {
      const pdfPage = pdfDoc.getPage(i);
      const { box, rot: rotation, userUnit } = getPageMetrics(pdfDoc, pdfPage);
      const widthPt = (rotation === 90 || rotation === 270 ? box.height : box.width) * userUnit;
      const heightPt = (rotation === 90 || rotation === 270 ? box.width : box.height) * userUnit;
      pageGeometries.push({
        widthPt: Number(widthPt.toFixed(4)),
        heightPt: Number(heightPt.toFixed(4)),
        rotation,
      });

      const pageProxy = await proxy.getPage(i + 1);
      const textContent = await pageProxy.getTextContent();
      const collectTags = detectedTags.length < EXTRACT_LIMITS.maxPdfDetectedTags;
      const rawItems: PdfRawTextItem[] = [];
      let rawPageText = '';
      for (const entry of textContent.items) {
        if ('str' in entry && typeof entry.str === 'string') {
          rawPageText += entry.str + (entry.hasEOL ? '\n' : '');
          if (collectTags) {
            rawItems.push({
              str: entry.str,
              ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
              ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
              ...(Array.isArray(entry.transform) ? { transform: entry.transform } : {}),
              ...(typeof entry.fontName === 'string' ? { fontName: entry.fontName } : {}),
              ...(typeof entry.hasEOL === 'boolean' ? { hasEOL: entry.hasEOL } : {}),
            });
          }
        }
      }
      rawPages.push(rawPageText);

      if (collectTags) {
        const pageTags = extractPageDeterministicTags({
          pageNumber: i + 1,
          box,
          rotation,
          userUnit,
          items: rawItems,
          styles: textContent.styles as Readonly<Record<string, { readonly fontFamily?: string }>> | undefined,
          maxTags: EXTRACT_LIMITS.maxPdfDetectedTags - detectedTags.length,
        });
        detectedTags.push(...pageTags);
      }
    }

    const normalizedTexts = Array.from({ length: pageCount }, (_, i) => normalizeExtractedText(rawPages[i] ?? ''));
    const cappedTexts = capPerPageTexts(normalizedTexts, EXTRACT_LIMITS.maxPdfInspectTextBytes);

    const pages: PdfInspectPage[] = pageGeometries.map((geom, i) => ({
      page: i + 1,
      widthPt: geom.widthPt,
      heightPt: geom.heightPt,
      rotation: geom.rotation,
      text: cappedTexts[i] ?? '',
    }));

    return {
      ok: true,
      kind: 'pdf_inspect',
      pageCount,
      pages,
      detectedTags,
    };
  } finally {
    if (typeof proxy.cleanup === 'function') {
      await Promise.resolve(proxy.cleanup()).catch(() => {});
    }
  }
}

export function decodeStrictBase64(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new PdfSignError(`${label} không đúng mã base64 hợp lệ`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function validatePng(base64: string): PngInfo {
  const bytes = decodeStrictBase64(base64, 'Ảnh chữ ký PNG');
  if (bytes.byteLength < 45) {
    throw new PdfSignError('Ảnh chữ ký PNG quá nhỏ hoặc bị hỏng');
  }
  if (bytes.byteLength > EXTRACT_LIMITS.maxSignatureImageBytes) {
    throw new PdfSignError(`Ảnh chữ ký PNG vượt quá ${EXTRACT_LIMITS.maxSignatureImageBytes} byte`);
  }

  const headText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 128)).trimStart().toLowerCase();
  if (
    headText.startsWith('<svg') ||
    headText.startsWith('<?xml') ||
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<script')
  ) {
    throw new PdfSignError('Không chấp nhận ảnh SVG, XML hoặc HTML cho chữ ký');
  }

  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) {
      throw new PdfSignError('Ảnh chữ ký phải đúng định dạng PNG hợp lệ');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_MAGIC.length;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new PdfSignError('Cấu trúc chunk PNG bị cắt cụt');
    }
    const chunkLen = view.getUint32(offset, false);
    if (chunkLen >= 0x80000000 || offset + 12 + chunkLen > bytes.byteLength) {
      throw new PdfSignError('Độ dài chunk PNG vượt quá kích thước tệp');
    }
    const chunkType = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (!/^[A-Za-z]{4}$/.test(chunkType)) {
      throw new PdfSignError('Tên chunk PNG không hợp lệ');
    }

    const dataStart = offset + 8;
    if (!sawIhdr) {
      if (chunkType !== 'IHDR' || chunkLen !== 13) {
        throw new PdfSignError('Ảnh PNG thiếu chunk IHDR hợp lệ');
      }
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      const bitDepth = bytes[dataStart + 8] ?? 0;
      const colorType = bytes[dataStart + 9] ?? 255;
      const compression = bytes[dataStart + 10] ?? 255;
      const filter = bytes[dataStart + 11] ?? 255;
      const interlace = bytes[dataStart + 12] ?? 255;

      const allowedDepths = PNG_COLOR_BIT_DEPTHS[colorType];
      if (!allowedDepths || !allowedDepths.includes(bitDepth) || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        throw new PdfSignError('Thông số màu hoặc nén của PNG không hợp lệ');
      }
      if (width < 1 || width > MAX_PNG_DIM || height < 1 || height > MAX_PNG_DIM || width * height > MAX_PNG_PIXELS) {
        throw new PdfSignError('Kích thước ảnh PNG vượt quá giới hạn an toàn');
      }
      sawIhdr = true;
    } else if (chunkType === 'IHDR') {
      throw new PdfSignError('Ảnh PNG chứa nhiều chunk IHDR');
    }

    if (chunkType === 'IDAT') {
      sawIdat = true;
    }

    offset += 12 + chunkLen;
    if (chunkType === 'IEND') {
      if (chunkLen !== 0 || offset !== bytes.byteLength) {
        throw new PdfSignError('Ảnh PNG chứa dữ liệu thừa sau IEND');
      }
      sawIend = true;
      break;
    }
  }

  if (!sawIhdr || !sawIdat || !sawIend) {
    throw new PdfSignError('Ảnh PNG thiếu dữ liệu hình ảnh hoặc kết thúc IEND');
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, width, height };
}

function visualPointToPdf(box: VisualBox, rot: PageRotation, vx: number, vy: number): PdfPoint {
  switch (rot) {
    case 0:
      return { x: box.x + vx, y: box.y + box.height - vy };
    case 90:
      return { x: box.x + vy, y: box.y + vx };
    case 180:
      return { x: box.x + box.width - vx, y: box.y + vy };
    case 270:
      return { x: box.x + box.width - vy, y: box.y + box.height - vx };
  }
}

async function embedSignaturePng(
  pdfDoc: PDFDocument,
  cache: Map<string, { readonly image: PDFImage; readonly info: PngInfo }>,
  base64: string,
): Promise<{ readonly image: PDFImage; readonly info: PngInfo }> {
  const info = validatePng(base64);
  const existing = cache.get(info.sha256);
  if (existing) return existing;
  try {
    const image = await pdfDoc.embedPng(info.bytes);
    const entry = { image, info };
    cache.set(info.sha256, entry);
    return entry;
  } catch {
    throw new PdfSignError('Không thể nhúng ảnh chữ ký PNG vào tài liệu PDF');
  }
}

function drawFittedImage(
  page: PDFPage,
  box: VisualBox,
  rot: PageRotation,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  image: PDFImage,
  info: PngInfo,
): void {
  const scale = Math.min(vw / info.width, vh / info.height);
  const drawW = info.width * scale;
  const drawH = info.height * scale;
  const imgVx = vx + (vw - drawW) / 2;
  const imgVy = vy + (vh - drawH) / 2;
  const origin = visualPointToPdf(box, rot, imgVx, imgVy + drawH);
  page.drawImage(image, {
    x: origin.x,
    y: origin.y,
    width: drawW,
    height: drawH,
    rotate: degrees(rot),
  });
}

const MIN_STAMP_FONT_PT = 4;

interface FittedTextLayout {
  readonly sizePt: number;
  readonly lines: readonly string[];
  readonly blockHeightPt: number;
  readonly baselineOffsetsPt: readonly number[];
}

async function measureFittedLinesLayout(
  fonts: PdfFontContext,
  lines: readonly string[],
  weight: FontWeight,
  sizePt: number,
): Promise<Omit<FittedTextLayout, 'sizePt' | 'lines'>> {
  const extents = await Promise.all(
    lines.map((line) => fonts.measureVerticalExtents(line, weight, sizePt)),
  );
  const baselineOffsetsPt: number[] = [];
  let blockHeightPt = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const ext = extents[i] ?? { ascentPt: sizePt * 0.74, descentPt: 0 };
    let baselinePt: number;
    if (i === 0) {
      baselinePt = ext.ascentPt;
    } else {
      const prevExt = extents[i - 1] ?? { ascentPt: sizePt * 0.74, descentPt: 0 };
      const minAdvance = prevExt.descentPt + ext.ascentPt + Math.max(0.5, sizePt * 0.08);
      baselinePt = (baselineOffsetsPt[i - 1] ?? 0) + Math.max(sizePt * 1.18, minAdvance);
    }
    baselineOffsetsPt.push(baselinePt);
    const bottomPt = baselinePt + ext.descentPt;
    if (bottomPt > blockHeightPt) {
      blockHeightPt = bottomPt;
    }
  }

  return { blockHeightPt, baselineOffsetsPt };
}

async function fitWrappedTextInBox(
  fonts: PdfFontContext,
  text: string,
  weight: FontWeight,
  availWidthPt: number,
  availHeightPt: number,
  startSizePt: number,
  errorMessage: string,
): Promise<FittedTextLayout> {
  if (availWidthPt <= 0.5 || availHeightPt <= 0.5) {
    throw new PdfSignError(errorMessage);
  }
  const measureMaxLineWidth = async (candidateLines: readonly string[], sz: number): Promise<number> => {
    let maxW = 0;
    for (const candidate of candidateLines) {
      if (candidate.length === 0) continue;
      const w = await fonts.measureWidth(candidate, weight, sz);
      if (w > maxW) maxW = w;
    }
    return maxW;
  };

  let sizePt = startSizePt;
  let lines = await fonts.wrapLines(text, weight, sizePt, availWidthPt);
  let maxLineW = await measureMaxLineWidth(lines, sizePt);
  let vertical = await measureFittedLinesLayout(fonts, lines, weight, sizePt);

  while (
    (vertical.blockHeightPt > availHeightPt + 0.01 || maxLineW > availWidthPt + 0.01) &&
    sizePt > MIN_STAMP_FONT_PT
  ) {
    let nextSizePt = sizePt * 0.88;
    if (maxLineW <= availWidthPt + 0.01 && vertical.blockHeightPt > availHeightPt + 0.01) {
      const heightFitSize = sizePt * (availHeightPt / Math.max(vertical.blockHeightPt, 0.01)) * 0.995;
      if (heightFitSize < sizePt * 0.995) {
        nextSizePt = Math.max(nextSizePt, heightFitSize);
      }
    }
    sizePt = Math.max(MIN_STAMP_FONT_PT, nextSizePt);
    lines = await fonts.wrapLines(text, weight, sizePt, availWidthPt);
    maxLineW = await measureMaxLineWidth(lines, sizePt);
    vertical = await measureFittedLinesLayout(fonts, lines, weight, sizePt);
  }

  if (vertical.blockHeightPt > availHeightPt + 0.01 || maxLineW > availWidthPt + 0.01) {
    throw new PdfSignError(errorMessage);
  }

  return {
    sizePt,
    lines,
    blockHeightPt: vertical.blockHeightPt,
    baselineOffsetsPt: vertical.baselineOffsetsPt,
  };
}

async function drawBoxedText(
  fonts: PdfFontContext,
  page: PDFPage,
  box: VisualBox,
  rot: PageRotation,
  userUnit: number,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  text: string,
  weight: FontWeight,
  preferredSizePt?: number,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;

  const vwPt = vw * userUnit;
  const vhPt = vh * userUnit;
  if (vwPt < MIN_STAMP_FONT_PT || vhPt < MIN_STAMP_FONT_PT) {
    throw new PdfSignError('Nội dung trường chữ vượt quá kích thước khung đặt trên trang');
  }
  const padXPt = Math.min(4, vwPt * 0.05);
  const availWPt = vwPt - 2 * padXPt;
  const startSizePt = preferredSizePt ?? Math.max(6, Math.min(14, vhPt * 0.58));
  const layout = await fitWrappedTextInBox(
    fonts,
    trimmed,
    weight,
    availWPt,
    vhPt,
    startSizePt,
    'Nội dung trường chữ vượt quá kích thước khung đặt trên trang',
  );

  const sizeUser = layout.sizePt / userUnit;
  const padXUser = padXPt / userUnit;
  const blockHeightUser = layout.blockHeightPt / userUnit;
  const topVy = vy + Math.max(0, (vh - blockHeightUser) / 2);

  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i] ?? '';
    if (line.length === 0) continue;
    const baselineVy = topVy + (layout.baselineOffsetsPt[i] ?? 0) / userUnit;
    const pt = visualPointToPdf(box, rot, vx + padXUser, baselineVy);
    await fonts.drawText(page, line, {
      weight,
      sizePt: sizeUser,
      color: COLOR_INK,
      x: pt.x,
      y: pt.y,
      rotateDeg: rot,
    });
  }
}

const MIN_CHECKBOX_BOX_PT = 4;

function drawVectorCheckbox(
  page: PDFPage,
  box: VisualBox,
  rot: PageRotation,
  userUnit: number,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  checked: boolean,
): void {
  if (vw * userUnit < MIN_CHECKBOX_BOX_PT || vh * userUnit < MIN_CHECKBOX_BOX_PT) {
    throw new PdfSignError('Kích thước ô đánh dấu quá nhỏ so với mức tối thiểu 4 pt');
  }
  const minDim = Math.min(vw, vh);
  const borderWidth = Math.min(Math.max(0.4 / userUnit, minDim * 0.07), minDim * 0.12);
  const side = Math.min(minDim - borderWidth, minDim * 0.84);
  const boxVx = vx + (vw - side) / 2;
  const boxVy = vy + (vh - side) / 2;
  const bl = visualPointToPdf(box, rot, boxVx, boxVy + side);

  page.drawRectangle({
    x: bl.x,
    y: bl.y,
    width: side,
    height: side,
    rotate: degrees(rot),
    borderWidth,
    borderColor: checked ? COLOR_ACCENT : COLOR_INK,
    color: checked ? COLOR_ACCENT : COLOR_WHITE,
  });

  if (checked) {
    const p1 = visualPointToPdf(box, rot, boxVx + side * 0.22, boxVy + side * 0.52);
    const p2 = visualPointToPdf(box, rot, boxVx + side * 0.43, boxVy + side * 0.74);
    const p3 = visualPointToPdf(box, rot, boxVx + side * 0.78, boxVy + side * 0.28);
    const thickness = Math.min(side * 0.16, Math.max(0.6 / userUnit, side * 0.12));
    page.drawLine({ start: p1, end: p2, thickness, color: COLOR_WHITE, lineCap: LineCapStyle.Round });
    page.drawLine({ start: p2, end: p3, thickness, color: COLOR_WHITE, lineCap: LineCapStyle.Round });
  }
}

function drawVectorRadio(
  page: PDFPage,
  box: VisualBox,
  rot: PageRotation,
  userUnit: number,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  checked: boolean,
): void {
  const minDim = Math.min(vw, vh);
  const borderWidth = Math.min(Math.max(0.4 / userUnit, minDim * 0.08), minDim * 0.14);
  const radius = Math.max(0.5 / userUnit, (minDim * 0.82 - borderWidth) / 2);
  const center = visualPointToPdf(box, rot, vx + vw / 2, vy + vh / 2);

  page.drawCircle({
    x: center.x,
    y: center.y,
    size: radius,
    borderWidth,
    borderColor: checked ? COLOR_ACCENT : COLOR_INK,
    color: COLOR_WHITE,
  });

  if (checked) {
    page.drawCircle({
      x: center.x,
      y: center.y,
      size: Math.max(0.25 / userUnit, radius * 0.52),
      borderWidth: 0,
      color: COLOR_ACCENT,
    });
  }
}

function clonePageSharedContainers(pdfDoc: PDFDocument, page: PDFPage): void {
  const contentsEntry = lookupDictEntryByDecodedName(pdfDoc, page.node, 'Contents');
  if (contentsEntry?.resolved instanceof PDFArray) {
    page.node.set(PDFName.of('Contents'), contentsEntry.resolved.clone(pdfDoc.context));
  }
  const resourcesRaw = page.node.getInheritableAttribute(PDFName.of('Resources'));
  const resources = resourcesRaw !== undefined ? pdfDoc.context.lookup(resourcesRaw) : undefined;
  if (resources instanceof PDFDict) {
    const clonedResources = resources.clone(pdfDoc.context);
    for (const subName of ['Font', 'XObject', 'ExtGState'] as const) {
      const subEntry = lookupDictEntryByDecodedName(pdfDoc, clonedResources, subName);
      if (subEntry?.resolved instanceof PDFDict) {
        clonedResources.set(PDFName.of(subName), subEntry.resolved.clone(pdfDoc.context));
      }
    }
    page.node.set(PDFName.of('Resources'), clonedResources);
  }
}

function isolateExistingContentState(pdfDoc: PDFDocument, page: PDFPage): void {
  const existingContents = page.node.Contents();
  if (!existingContents) return;
  const startRef = pdfDoc.context.register(PDFContentStream.of(pdfDoc.context.obj({}), [pushGraphicsState()]));
  // Wrap original streams BEFORE page.node.normalize() inserts pdf-lib's auto q/Q pair so a trailing
  // % comment cannot swallow pdf-lib's Q, and emit 'n' (endpath) to discard any dangling current path
  // (which q/Q does not save or restore) before stamped checkboxes/shapes paint.
  const endRef = pdfDoc.context.register(pdfDoc.context.flateStream('\nn\nQ\n'));
  if (existingContents instanceof PDFArray) {
    page.node.set(PDFName.of('Contents'), pdfDoc.context.obj([startRef, ...existingContents.asArray(), endRef]));
  } else {
    const rawContentsRef = page.node.get(PDFName.of('Contents'));
    const contentsRef = rawContentsRef instanceof PDFRef ? rawContentsRef : pdfDoc.context.register(existingContents);
    page.node.set(PDFName.of('Contents'), pdfDoc.context.obj([startRef, contentsRef, endRef]));
  }
  page.node.normalize();
}

function ensurePageStateIsolated(
  pdfDoc: PDFDocument,
  page: PDFPage,
  pageOneBased: number,
  isolatedPages: Set<number>,
): void {
  if (isolatedPages.has(pageOneBased)) return;
  isolateExistingContentState(pdfDoc, page);
  isolatedPages.add(pageOneBased);
}

async function stampFields(
  pdfDoc: PDFDocument,
  fonts: PdfFontContext,
  fields: readonly PdfSealField[],
  sourcePageCount: number,
  isolatedPages: Set<number>,
): Promise<void> {
  const pngCache = new Map<string, { readonly image: PDFImage; readonly info: PngInfo }>();

  for (const field of fields) {
    if (field.page < 1 || field.page > sourcePageCount) {
      throw new PdfSignError(`Trường ký trỏ tới trang ${field.page} ngoài phạm vi tài liệu (${sourcePageCount} trang)`);
    }
    if (field.xNorm + field.wNorm > 1 + FIELD_EPSILON || field.yNorm + field.hNorm > 1 + FIELD_EPSILON) {
      throw new PdfSignError('Tọa độ trường ký vượt ra ngoài phạm vi trang');
    }

    const page = pdfDoc.getPage(field.page - 1);
    ensurePageStateIsolated(pdfDoc, page, field.page, isolatedPages);
    const { box, rot, userUnit } = getPageMetrics(pdfDoc, page);
    const visW = rot === 90 || rot === 270 ? box.height : box.width;
    const visH = rot === 90 || rot === 270 ? box.width : box.height;

    const vx = field.xNorm * visW;
    const vy = field.yNorm * visH;
    const vw = (Math.min(1, field.xNorm + field.wNorm) - field.xNorm) * visW;
    const vh = (Math.min(1, field.yNorm + field.hNorm) - field.yNorm) * visH;
    if (vw <= 0 || vh <= 0) {
      throw new PdfSignError('Tọa độ trường ký vượt ra ngoài phạm vi trang');
    }

    switch (field.type) {
      case 'signature':
      case 'stamp': {
        const embedded = await embedSignaturePng(pdfDoc, pngCache, field.imagePngBase64);
        drawFittedImage(page, box, rot, vx, vy, vw, vh, embedded.image, embedded.info);
        break;
      }
      case 'initial': {
        if (field.imagePngBase64 !== undefined) {
          const embedded = await embedSignaturePng(pdfDoc, pngCache, field.imagePngBase64);
          drawFittedImage(page, box, rot, vx, vy, vw, vh, embedded.image, embedded.info);
        } else if (field.text !== undefined) {
          await drawBoxedText(fonts, page, box, rot, userUnit, vx, vy, vw, vh, field.text, 'bold', field.fontSizePt);
        }
        break;
      }
      case 'date':
      case 'text':
      case 'dropdown': {
        await drawBoxedText(fonts, page, box, rot, userUnit, vx, vy, vw, vh, field.text, 'regular', field.fontSizePt);
        break;
      }
      case 'checkbox': {
        drawVectorCheckbox(page, box, rot, userUnit, vx, vy, vw, vh, field.checked);
        break;
      }
      case 'radio': {
        if (field.text !== undefined && field.text.trim().length > 0) {
          if (vw >= vh * 1.8) {
            const indicatorSlot = Math.min(vh, vw * 0.35);
            const gap = Math.max(1 / userUnit, indicatorSlot * 0.16);
            drawVectorRadio(page, box, rot, userUnit, vx, vy, indicatorSlot, vh, field.checked ?? true);
            await drawBoxedText(
              fonts,
              page,
              box,
              rot,
              userUnit,
              vx + indicatorSlot + gap,
              vy,
              Math.max(1 / userUnit, vw - indicatorSlot - gap),
              vh,
              field.text,
              'regular',
              field.fontSizePt,
            );
          } else {
            await drawBoxedText(fonts, page, box, rot, userUnit, vx, vy, vw, vh, field.text, 'regular', field.fontSizePt);
          }
        } else {
          drawVectorRadio(page, box, rot, userUnit, vx, vy, vw, vh, Boolean(field.checked));
        }
        break;
      }
    }
  }
}

function lookupDictEntryByDecodedName(
  pdfDoc: PDFDocument,
  dict: PDFDict,
  targetName: string,
): { readonly key: PDFName; readonly raw: unknown; readonly resolved: unknown } | undefined {
  for (const [key, raw] of dict.entries()) {
    if (decodePdfName(key) === targetName) {
      return { key, raw, resolved: pdfDoc.context.lookup(raw) };
    }
  }
  return undefined;
}

function lookupInheritedDictEntry(
  pdfDoc: PDFDocument,
  startDict: PDFDict,
  targetName: string,
): { readonly key: PDFName; readonly raw: unknown; readonly resolved: unknown } | undefined {
  let current: PDFDict | undefined = startDict;
  const visited = new Set<PDFDict>();
  while (current && !visited.has(current) && visited.size < 32) {
    visited.add(current);
    const entry = lookupDictEntryByDecodedName(pdfDoc, current, targetName);
    if (entry && entry.resolved !== undefined && entry.resolved !== PDFNull) {
      return entry;
    }
    const parentObj: unknown = lookupDictEntryByDecodedName(pdfDoc, current, 'Parent')?.resolved;
    current = parentObj instanceof PDFDict ? parentObj : undefined;
  }
  return undefined;
}

function deleteDictKeysByDecodedName(dict: PDFDict, targetName: string): void {
  const toDelete: PDFName[] = [];
  for (const [key] of dict.entries()) {
    if (decodePdfName(key) === targetName) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    dict.delete(key);
  }
}

function findWidgetTargetPage(
  pdfDoc: PDFDocument,
  pages: readonly PDFPage[],
  widget: ReturnType<PDFField['acroField']['getWidgets']>[number],
): { readonly page: PDFPage; readonly pageOneBased: number } | undefined {
  const pageRef = widget.P();
  let page = pageRef ? pages.find((p) => p.ref === pageRef) : undefined;
  if (!page) {
    const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
    if (widgetRef) {
      page = pdfDoc.findPageForAnnotationRef(widgetRef);
    }
  }
  if (!page) return undefined;
  const idx = pages.indexOf(page);
  if (idx < 0) return undefined;
  return { page, pageOneBased: idx + 1 };
}

function safeRemoveField(pdfDoc: PDFDocument, form: PDFForm, field: PDFField, pages: readonly PDFPage[]): void {
  try {
    form.removeField(field);
    return;
  } catch {
    // Fall back to explicit cleanup when widgets are orphaned or lack /AP.
  }

  for (const widget of field.acroField.getWidgets()) {
    const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
    if (widgetRef) {
      for (const page of pages) {
        page.node.removeAnnot(widgetRef);
      }
      pdfDoc.context.delete(widgetRef);
    }
  }
  for (const page of pages) {
    page.node.removeAnnot(field.ref);
  }
  try {
    form.acroForm.removeField(field.acroField);
  } catch {
    // Ignore partial AcroForm field tree entries; stripInteractiveElements deletes AcroForm afterwards.
  }
  const kids = field.acroField.normalizedEntries().Kids;
  const kidsCount = kids.size();
  for (let i = 0; i < kidsCount; i++) {
    const child = kids.get(i);
    if (child instanceof PDFRef) {
      pdfDoc.context.delete(child);
    }
  }
  pdfDoc.context.delete(field.ref);
}

const PASSWORD_FIELD_FLAG = 1 << 13;
const MAX_PASSWORD_MASK_CHARS = 32;

function normalizePdfRect(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

function readNormalizedPdfRect(
  pdfDoc: PDFDocument,
  dict: PDFDict,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
  const rawRect = lookupDictEntryByDecodedName(pdfDoc, dict, 'Rect')?.resolved;
  const rectNums = readPdfNumberArray(pdfDoc, rawRect, 4);
  if (!rectNums) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rectNums;
  return normalizePdfRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
}

const ANNOTATION_FLAG_INVISIBLE = 1;
const ANNOTATION_FLAG_HIDDEN = 2;
const ANNOTATION_FLAG_NOROTATE = 16;
const ANNOTATION_FLAG_NOVIEW = 32;

// Standard annotation subtypes with built-in handlers in PDF.js (and PDF viewers):
// annotations outside this set with the Invisible flag (bit 1) are not rendered and must stay hidden on flatten.
const HANDLED_ANNOTATION_SUBTYPES: ReadonlySet<string> = new Set([
  'Text',
  'Link',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'Widget',
  'Screen',
  'RichMedia',
]);

function readAnnotationFlags(pdfDoc: PDFDocument, dict: PDFDict): number {
  const flagObj = lookupDictEntryByDecodedName(pdfDoc, dict, 'F')?.resolved;
  if (flagObj instanceof PDFNumber) {
    const raw = flagObj.asNumber();
    if (Number.isInteger(raw) && raw > 0) {
      return raw >>> 0;
    }
  }
  return 0;
}

function readWidgetRotation(pdfDoc: PDFDocument, widgetDict: PDFDict): PageRotation {
  const mkObj = lookupDictEntryByDecodedName(pdfDoc, widgetDict, 'MK')?.resolved;
  const rObj =
    mkObj instanceof PDFDict
      ? lookupDictEntryByDecodedName(pdfDoc, mkObj, 'R')?.resolved
      : lookupDictEntryByDecodedName(pdfDoc, widgetDict, 'Rotate')?.resolved;
  if (!(rObj instanceof PDFNumber)) return 0;
  const raw = rObj.asNumber();
  if (!Number.isInteger(raw) || raw % 90 !== 0) return 0;
  const normalized = ((raw % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

interface WidgetBoxStyle {
  readonly backgroundColor?: Color;
  readonly borderColor?: Color;
  readonly borderWidth: number;
  readonly borderDashArray?: readonly number[];
}

function makeColorFromComponents(comps: readonly number[]): Color | undefined {
  const clamp = (val: number): number => Math.max(0, Math.min(1, val));
  if (comps.length === 1) return grayscale(clamp(comps[0] ?? 0));
  if (comps.length === 3) return rgb(clamp(comps[0] ?? 0), clamp(comps[1] ?? 0), clamp(comps[2] ?? 0));
  if (comps.length === 4) {
    return cmyk(clamp(comps[0] ?? 0), clamp(comps[1] ?? 0), clamp(comps[2] ?? 0), clamp(comps[3] ?? 0));
  }
  return undefined;
}

function parsePdfColorArray(pdfDoc: PDFDocument, obj: unknown): Color | undefined {
  if (!(obj instanceof PDFArray)) return undefined;
  const len = obj.size();
  if (len !== 1 && len !== 3 && len !== 4) return undefined;
  const comps: number[] = [];
  for (let i = 0; i < len; i++) {
    const entry = pdfDoc.context.lookup(obj.get(i));
    if (!(entry instanceof PDFNumber)) return undefined;
    const val = entry.asNumber();
    if (!Number.isFinite(val)) return undefined;
    comps.push(val);
  }
  return makeColorFromComponents(comps);
}

function parseDefaultAppearanceColor(da: string): Color | undefined {
  type DaOperand = number | { readonly name: string } | null;
  const operands: DaOperand[] = [];
  let fillSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' | undefined;
  let color: Color | undefined;
  let i = 0;

  const takeTrailingNumbers = (count: number): number[] | null => {
    if (operands.length < count) return null;
    const slice = operands.slice(operands.length - count);
    if (!slice.every((item): item is number => typeof item === 'number')) return null;
    return slice;
  };

  while (i < da.length) {
    i = skipPdfWhitespaceAndComments(da, i);
    if (i >= da.length) break;
    const ch = da[i] ?? '';
    if (ch === '(') {
      i = skipPdfLiteralString(da, i + 1);
      operands.push(null);
      continue;
    }
    if (ch === '<') {
      if (da[i + 1] === '<') {
        i += 2;
      } else {
        i += 1;
        while (i < da.length && da[i] !== '>') i += 1;
        if (i < da.length) i += 1;
      }
      operands.push(null);
      continue;
    }
    if (ch === '>' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ')') {
      i += ch === '>' && da[i + 1] === '>' ? 2 : 1;
      operands.push(null);
      continue;
    }
    if (ch === '/') {
      const start = i + 1;
      i += 1;
      while (i < da.length) {
        const nc = da.charCodeAt(i);
        if (isPdfWhitespaceCode(nc) || isPdfDelimiterCode(nc)) break;
        i += 1;
      }
      operands.push({ name: da.slice(start, i) });
      continue;
    }

    const start = i;
    while (i < da.length) {
      const tc = da.charCodeAt(i);
      if (isPdfWhitespaceCode(tc) || isPdfDelimiterCode(tc)) break;
      i += 1;
    }
    const tok = da.slice(start, i);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      const num = Number(tok);
      operands.push(Number.isFinite(num) ? num : null);
      if (operands.length > 8) operands.shift();
      continue;
    }

    if (tok === 'g') {
      const nums = takeTrailingNumbers(1);
      if (nums) color = makeColorFromComponents(nums);
      fillSpace = 'DeviceGray';
    } else if (tok === 'rg') {
      const nums = takeTrailingNumbers(3);
      if (nums) color = makeColorFromComponents(nums);
      fillSpace = 'DeviceRGB';
    } else if (tok === 'k') {
      const nums = takeTrailingNumbers(4);
      if (nums) color = makeColorFromComponents(nums);
      fillSpace = 'DeviceCMYK';
    } else if (tok === 'cs') {
      const last = operands[operands.length - 1];
      const csName = last && typeof last === 'object' ? last.name : undefined;
      fillSpace =
        csName === 'DeviceGray' || csName === 'DeviceRGB' || csName === 'DeviceCMYK' ? csName : undefined;
    } else if ((tok === 'sc' || tok === 'scn') && fillSpace !== undefined) {
      const expected = fillSpace === 'DeviceGray' ? 1 : fillSpace === 'DeviceRGB' ? 3 : 4;
      const nums = takeTrailingNumbers(expected);
      if (nums) color = makeColorFromComponents(nums);
    }
    operands.length = 0;
  }

  return color;
}

type TextQuadding = 0 | 1 | 2;

function lookupAcroFieldEntry(
  pdfDoc: PDFDocument,
  widgetDict: PDFDict,
  fieldDict: PDFDict,
  acroDict: PDFDict | undefined,
  keyName: string,
): { readonly key: PDFName; readonly raw: unknown; readonly resolved: unknown } | undefined {
  return (
    lookupInheritedDictEntry(pdfDoc, widgetDict, keyName) ??
    lookupInheritedDictEntry(pdfDoc, fieldDict, keyName) ??
    (acroDict ? lookupDictEntryByDecodedName(pdfDoc, acroDict, keyName) : undefined)
  );
}

function readWidgetTextColor(
  pdfDoc: PDFDocument,
  widgetDict: PDFDict,
  fieldDict: PDFDict,
  acroDict?: PDFDict,
): Color | undefined {
  const entry = lookupAcroFieldEntry(pdfDoc, widgetDict, fieldDict, acroDict, 'DA');
  if (!entry) return undefined;
  if (!(entry.resolved instanceof PDFHexString || entry.resolved instanceof PDFString)) {
    return undefined;
  }
  return parseDefaultAppearanceColor(entry.resolved.decodeText());
}

function readWidgetTextAlignment(
  pdfDoc: PDFDocument,
  widgetDict: PDFDict,
  fieldDict: PDFDict,
  acroDict?: PDFDict,
): TextQuadding {
  const entry = lookupAcroFieldEntry(pdfDoc, widgetDict, fieldDict, acroDict, 'Q');
  if (!entry || !(entry.resolved instanceof PDFNumber)) return 0;
  const val = entry.resolved.asNumber();
  return val === 1 || val === 2 ? val : 0;
}

async function computeAlignedLocalX(
  fonts: PdfFontContext,
  text: string,
  sizeUser: number,
  padXUser: number,
  availWUser: number,
  textAlign: TextQuadding,
): Promise<number> {
  if (textAlign === 0 || text.length === 0) return padXUser;
  const lineWUser = await fonts.measureWidth(text, 'regular', sizeUser);
  const spareUser = Math.max(0, availWUser - lineWUser);
  return padXUser + (textAlign === 1 ? spareUser / 2 : spareUser);
}

function parsePdfDashArray(pdfDoc: PDFDocument, obj: unknown): readonly number[] | undefined {
  if (!(obj instanceof PDFArray)) return undefined;
  const len = obj.size();
  if (len === 0) return undefined;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const item = pdfDoc.context.lookup(obj.get(i));
    if (!(item instanceof PDFNumber)) return undefined;
    const val = item.asNumber();
    if (!Number.isFinite(val) || val < 0) return undefined;
    out.push(val);
  }
  return out.some((val) => val > 0) ? out : undefined;
}

function readWidgetBoxStyle(pdfDoc: PDFDocument, widgetDict: PDFDict): WidgetBoxStyle {
  const mkObj = lookupDictEntryByDecodedName(pdfDoc, widgetDict, 'MK')?.resolved;
  const backgroundColor =
    mkObj instanceof PDFDict ? parsePdfColorArray(pdfDoc, lookupDictEntryByDecodedName(pdfDoc, mkObj, 'BG')?.resolved) : undefined;
  const borderColor =
    mkObj instanceof PDFDict ? parsePdfColorArray(pdfDoc, lookupDictEntryByDecodedName(pdfDoc, mkObj, 'BC')?.resolved) : undefined;

  let borderWidth = 0;
  let borderDashArray: readonly number[] | undefined;
  const bsObj = lookupDictEntryByDecodedName(pdfDoc, widgetDict, 'BS')?.resolved;
  if (bsObj instanceof PDFDict) {
    const wObj = lookupDictEntryByDecodedName(pdfDoc, bsObj, 'W')?.resolved;
    borderWidth = wObj instanceof PDFNumber && Number.isFinite(wObj.asNumber()) ? Math.max(0, wObj.asNumber()) : 1;
    const sObj = lookupDictEntryByDecodedName(pdfDoc, bsObj, 'S')?.resolved;
    if (sObj instanceof PDFName && decodePdfName(sObj) === 'D') {
      borderDashArray = parsePdfDashArray(pdfDoc, lookupDictEntryByDecodedName(pdfDoc, bsObj, 'D')?.resolved) ?? [3];
    }
  } else {
    const borderArr = lookupDictEntryByDecodedName(pdfDoc, widgetDict, 'Border')?.resolved;
    if (borderArr instanceof PDFArray) {
      if (borderArr.size() >= 3) {
        const wObj = pdfDoc.context.lookup(borderArr.get(2));
        borderWidth = wObj instanceof PDFNumber && Number.isFinite(wObj.asNumber()) ? Math.max(0, wObj.asNumber()) : 1;
        if (borderArr.size() >= 4) {
          borderDashArray = parsePdfDashArray(pdfDoc, pdfDoc.context.lookup(borderArr.get(3)));
        }
      }
    } else if (borderColor !== undefined) {
      borderWidth = 1;
    }
  }

  return {
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
    ...(borderColor !== undefined ? { borderColor } : {}),
    borderWidth,
    ...(borderDashArray !== undefined ? { borderDashArray } : {}),
  };
}

interface AnnotationBasis {
  readonly ux: number;
  readonly uy: number;
  readonly vx: number;
  readonly vy: number;
  readonly blX: number;
  readonly blY: number;
  readonly clipRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

function getAnnotationBasis(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rot: PageRotation,
  noRotate: boolean,
): AnnotationBasis {
  const effectiveRot: PageRotation = noRotate ? rot : 0;
  const anchorX = rect.x;
  const anchorY = rect.y + rect.height;
  switch (effectiveRot) {
    case 0:
      return {
        ux: 1,
        uy: 0,
        vx: 0,
        vy: 1,
        blX: rect.x,
        blY: rect.y,
        clipRect: rect,
      };
    case 90:
      return {
        ux: 0,
        uy: 1,
        vx: -1,
        vy: 0,
        blX: anchorX + rect.height,
        blY: anchorY,
        clipRect: { x: anchorX, y: anchorY, width: rect.height, height: rect.width },
      };
    case 180:
      return {
        ux: -1,
        uy: 0,
        vx: 0,
        vy: -1,
        blX: anchorX,
        blY: anchorY + rect.height,
        clipRect: { x: anchorX - rect.width, y: anchorY, width: rect.width, height: rect.height },
      };
    case 270:
      return {
        ux: 0,
        uy: -1,
        vx: 1,
        vy: 0,
        blX: anchorX - rect.height,
        blY: anchorY,
        clipRect: { x: anchorX - rect.height, y: anchorY - rect.width, width: rect.height, height: rect.width },
      };
  }
}

function localRectPointToPdf(basis: AnnotationBasis, lx: number, ly: number): PdfPoint {
  return {
    x: basis.blX + lx * basis.ux + ly * basis.vx,
    y: basis.blY + lx * basis.uy + ly * basis.vy,
  };
}

function getWidgetFallbackFrame(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rot: PageRotation,
  noRotate: boolean,
  widgetRot: PageRotation,
): {
  readonly basis: AnnotationBasis;
  readonly width: number;
  readonly height: number;
  readonly rotateDeg: PageRotation;
} {
  const base = getAnnotationBasis(rect, rot, noRotate);
  const baseDeg: PageRotation = noRotate ? rot : 0;
  if (widgetRot === 0) {
    return { basis: base, width: rect.width, height: rect.height, rotateDeg: baseDeg };
  }

  let ox = 0;
  let oy = 0;
  let uLocalX = 1;
  let uLocalY = 0;
  let vLocalX = 0;
  let vLocalY = 1;
  let width = rect.width;
  let height = rect.height;

  switch (widgetRot) {
    case 90:
      ox = rect.width;
      uLocalX = 0;
      uLocalY = 1;
      vLocalX = -1;
      vLocalY = 0;
      width = rect.height;
      height = rect.width;
      break;
    case 180:
      ox = rect.width;
      oy = rect.height;
      uLocalX = -1;
      uLocalY = 0;
      vLocalX = 0;
      vLocalY = -1;
      break;
    case 270:
      oy = rect.height;
      uLocalX = 0;
      uLocalY = -1;
      vLocalX = 1;
      vLocalY = 0;
      width = rect.height;
      height = rect.width;
      break;
  }

  const bl = localRectPointToPdf(base, ox, oy);
  const rotateDeg = ((baseDeg + widgetRot) % 360) as PageRotation;
  return {
    basis: {
      ux: uLocalX * base.ux + uLocalY * base.vx,
      uy: uLocalX * base.uy + uLocalY * base.vy,
      vx: vLocalX * base.ux + vLocalY * base.vx,
      vy: vLocalX * base.uy + vLocalY * base.vy,
      blX: bl.x,
      blY: bl.y,
      clipRect: base.clipRect,
    },
    width,
    height,
    rotateDeg,
  };
}

function hasInheritedPasswordFlag(pdfDoc: PDFDocument, startDict: PDFDict): boolean {
  const ffObj = lookupInheritedDictEntry(pdfDoc, startDict, 'Ff')?.resolved;
  return ffObj instanceof PDFNumber && (ffObj.asNumber() & PASSWORD_FIELD_FLAG) !== 0;
}

function isPasswordTextField(pdfDoc: PDFDocument, field: PDFTextField): boolean {
  if (field.isPassword()) return true;
  return hasInheritedPasswordFlag(pdfDoc, field.acroField.dict);
}

function readInheritedFieldText(pdfDoc: PDFDocument, startDict: PDFDict): string {
  const vEntry = lookupInheritedDictEntry(pdfDoc, startDict, 'V');
  if (vEntry !== undefined) {
    return vEntry.resolved instanceof PDFString || vEntry.resolved instanceof PDFHexString
      ? vEntry.resolved.decodeText()
      : '';
  }
  const dvResolved = lookupInheritedDictEntry(pdfDoc, startDict, 'DV')?.resolved;
  if (dvResolved instanceof PDFString || dvResolved instanceof PDFHexString) {
    return dvResolved.decodeText();
  }
  return '';
}

function extractPdfChoiceEntryStrings(pdfDoc: PDFDocument, resolved: unknown): string[] {
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
    return [resolved.decodeText()];
  }
  if (resolved instanceof PDFArray) {
    const out: string[] = [];
    const len = resolved.size();
    for (let j = 0; j < len; j += 1) {
      const item = pdfDoc.context.lookup(resolved.get(j));
      if (item instanceof PDFString || item instanceof PDFHexString) {
        out.push(item.decodeText());
      }
    }
    return out;
  }
  return [];
}

function readInheritedChoiceSelectedValues(
  pdfDoc: PDFDocument,
  field: PDFDropdown | PDFOptionList,
): string[] {
  const vEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'V');
  if (vEntry !== undefined) {
    const direct = extractPdfChoiceEntryStrings(pdfDoc, vEntry.resolved);
    if (direct.length > 0) return direct;
    try {
      return field.getSelected();
    } catch {
      return [];
    }
  }
  const dvEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'DV');
  if (dvEntry !== undefined) {
    return extractPdfChoiceEntryStrings(pdfDoc, dvEntry.resolved);
  }
  try {
    return field.getSelected();
  } catch {
    return [];
  }
}

function readAcroFieldFallbackText(pdfDoc: PDFDocument, field: PDFField): string {
  if (field instanceof PDFTextField) {
    let rawText = '';
    try {
      rawText = field.getText() ?? readInheritedFieldText(pdfDoc, field.acroField.dict);
    } catch {
      rawText = readInheritedFieldText(pdfDoc, field.acroField.dict);
    }
    if (isPasswordTextField(pdfDoc, field)) {
      const charCount = Array.from(rawText).length;
      return charCount === 0 ? '' : '*'.repeat(Math.min(charCount, MAX_PASSWORD_MASK_CHARS));
    }
    return rawText;
  }
  if (field instanceof PDFDropdown) {
    try {
      const selected = readInheritedChoiceSelectedValues(pdfDoc, field);
      const optEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'Opt')?.resolved;
      const displayByExport = new Map<string, string>();
      if (optEntry instanceof PDFArray) {
        const optSize = optEntry.size();
        for (let i = 0; i < optSize; i++) {
          const item = pdfDoc.context.lookup(optEntry.get(i));
          if (item instanceof PDFArray && item.size() >= 2) {
            const exportObj = pdfDoc.context.lookup(item.get(0));
            const labelObj = pdfDoc.context.lookup(item.get(1));
            if (
              (exportObj instanceof PDFString || exportObj instanceof PDFHexString) &&
              (labelObj instanceof PDFString || labelObj instanceof PDFHexString)
            ) {
              displayByExport.set(exportObj.decodeText(), labelObj.decodeText());
            }
          }
        }
      }
      return selected.map((val) => displayByExport.get(val) ?? val).join(', ');
    } catch {
      return '';
    }
  }
  return '';
}

interface OptionListFallbackRow {
  readonly label: string;
  readonly selected: boolean;
}

const OPTION_LIST_SELECTED_BG = rgb(153 / 255, 193 / 255, 218 / 255);

function readOptionListFallbackRows(
  pdfDoc: PDFDocument,
  field: PDFOptionList,
): readonly OptionListFallbackRow[] {
  const optEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'Opt')?.resolved;
  const entries: Array<{ readonly exportValue: string; readonly displayValue: string; selected: boolean }> = [];
  if (optEntry instanceof PDFArray) {
    const optSize = optEntry.size();
    for (let i = 0; i < optSize; i += 1) {
      const item = pdfDoc.context.lookup(optEntry.get(i));
      if (item instanceof PDFString || item instanceof PDFHexString) {
        const text = item.decodeText();
        entries.push({ exportValue: text, displayValue: text, selected: false });
      } else if (item instanceof PDFArray && item.size() >= 1) {
        const exportObj = pdfDoc.context.lookup(item.get(0));
        const labelObj = item.size() >= 2 ? pdfDoc.context.lookup(item.get(1)) : exportObj;
        if (exportObj instanceof PDFString || exportObj instanceof PDFHexString) {
          const exportValue = exportObj.decodeText();
          const displayValue =
            labelObj instanceof PDFString || labelObj instanceof PDFHexString
              ? labelObj.decodeText()
              : exportValue;
          entries.push({ exportValue, displayValue, selected: false });
        }
      }
    }
  }

  const iEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'I')?.resolved;
  if (iEntry instanceof PDFArray && iEntry.size() > 0) {
    const idxCount = iEntry.size();
    for (let j = 0; j < idxCount; j += 1) {
      const idxObj = pdfDoc.context.lookup(iEntry.get(j));
      if (!(idxObj instanceof PDFNumber)) continue;
      const idx = idxObj.asNumber();
      if (Number.isInteger(idx) && idx >= 0 && idx < entries.length) {
        const target = entries[idx];
        if (target) target.selected = true;
      }
    }
  } else {
    const selectedValues = readInheritedChoiceSelectedValues(pdfDoc, field);

    if (entries.length === 0 && selectedValues.length > 0) {
      for (const value of selectedValues) {
        entries.push({ exportValue: value, displayValue: value, selected: true });
      }
    } else if (selectedValues.length > 0) {
      const selectedSet = new Set(selectedValues);
      for (const entry of entries) {
        if (selectedSet.has(entry.exportValue)) {
          entry.selected = true;
        }
      }
    }
  }

  let isSorted = false;
  try {
    isSorted = field.isSorted();
  } catch {
    isSorted = false;
  }
  if (isSorted) {
    entries.sort((a, b) =>
      a.displayValue < b.displayValue ? -1 : a.displayValue > b.displayValue ? 1 : 0,
    );
  }

  return entries.map(({ displayValue, selected }) => ({ label: displayValue, selected }));
}

interface FallbackWidgetBoxGeometry {
  readonly frame: ReturnType<typeof getWidgetFallbackFrame>;
  readonly borderWUser: number;
  readonly padXPt: number;
  readonly padYPt: number;
  readonly availWPt: number;
  readonly availHPt: number;
}

function buildFallbackWidgetBoxGeometry(
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rot: PageRotation,
  noRotate: boolean,
  widgetRot: PageRotation,
  boxStyle?: WidgetBoxStyle,
): FallbackWidgetBoxGeometry | undefined {
  const frame = getWidgetFallbackFrame(rect, rot, noRotate, widgetRot);
  const widthPt = frame.width * userUnit;
  const heightPt = frame.height * userUnit;
  if (widthPt <= 1 || heightPt <= 1) return undefined;

  const hasBorder = boxStyle?.borderColor !== undefined && (boxStyle?.borderWidth ?? 0) > 0;
  const borderWUser = hasBorder
    ? Math.min(boxStyle?.borderWidth ?? 0, frame.width * 0.25, frame.height * 0.25)
    : 0;
  const borderPt = borderWUser * userUnit;
  const padXPt = Math.min(widthPt * 0.25, borderPt + Math.min(4, widthPt * 0.05));
  const padYPt = Math.min(heightPt * 0.25, borderPt + Math.min(2, heightPt * 0.08));
  const availWPt = widthPt - 2 * padXPt;
  const availHPt = heightPt - 2 * padYPt;
  return { frame, borderWUser, padXPt, padYPt, availWPt, availHPt };
}

function drawFallbackWidgetBoxChrome(
  page: PDFPage,
  userUnit: number,
  frame: ReturnType<typeof getWidgetFallbackFrame>,
  borderWUser: number,
  boxStyle?: WidgetBoxStyle,
): void {
  const hasBg = boxStyle?.backgroundColor !== undefined;
  const hasBorder = boxStyle?.borderColor !== undefined && (boxStyle?.borderWidth ?? 0) > 0;
  if (!hasBg && !(hasBorder && borderWUser > 0)) return;

  const halfStroke = borderWUser / 2;
  const boxOrigin = localRectPointToPdf(frame.basis, halfStroke, halfStroke);
  page.drawRectangle({
    x: boxOrigin.x,
    y: boxOrigin.y,
    width: Math.max(0.1 / userUnit, frame.width - borderWUser),
    height: Math.max(0.1 / userUnit, frame.height - borderWUser),
    rotate: degrees(frame.rotateDeg),
    ...(boxStyle?.backgroundColor !== undefined ? { color: boxStyle.backgroundColor } : {}),
    ...(hasBorder && borderWUser > 0 && boxStyle?.borderColor !== undefined
      ? {
          borderColor: boxStyle.borderColor,
          borderWidth: borderWUser,
          ...(boxStyle.borderDashArray !== undefined ? { borderDashArray: [...boxStyle.borderDashArray] } : {}),
        }
      : { borderWidth: 0 }),
  });
}

interface FallbackTextBoxSpec {
  readonly trimmed: string;
  readonly frame: ReturnType<typeof getWidgetFallbackFrame>;
  readonly padXPt: number;
  readonly availWPt: number;
  readonly availHPt: number;
  readonly startSizePt: number;
}

function buildFallbackTextBoxSpec(
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  value: string,
  rot: PageRotation,
  noRotate: boolean,
  widgetRot: PageRotation,
  boxStyle?: WidgetBoxStyle,
): {
  readonly frame: ReturnType<typeof getWidgetFallbackFrame>;
  readonly borderWUser: number;
  readonly textSpec?: FallbackTextBoxSpec;
} | undefined {
  const box = buildFallbackWidgetBoxGeometry(userUnit, rect, rot, noRotate, widgetRot, boxStyle);
  if (!box) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { frame: box.frame, borderWUser: box.borderWUser };
  }

  const startSizePt = Math.max(MIN_STAMP_FONT_PT, Math.min(12, box.availHPt * 0.65));
  return {
    frame: box.frame,
    borderWUser: box.borderWUser,
    textSpec: {
      trimmed,
      frame: box.frame,
      padXPt: box.padXPt,
      availWPt: box.availWPt,
      availHPt: box.availHPt,
      startSizePt,
    },
  };
}

async function fitFallbackFieldText(fonts: PdfFontContext, textSpec: FallbackTextBoxSpec): Promise<FittedTextLayout> {
  return fitWrappedTextInBox(
    fonts,
    textSpec.trimmed,
    'regular',
    textSpec.availWPt,
    textSpec.availHPt,
    textSpec.startSizePt,
    'Nội dung ô biểu mẫu vượt quá kích thước khung đặt trên trang',
  );
}

async function drawFallbackFieldText(
  fonts: PdfFontContext,
  page: PDFPage,
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  value: string,
  rot: PageRotation = 0,
  noRotate = false,
  widgetRot: PageRotation = 0,
  boxStyle?: WidgetBoxStyle,
  textColor?: Color,
  textAlign: TextQuadding = 0,
): Promise<void> {
  const box = buildFallbackTextBoxSpec(userUnit, rect, value, rot, noRotate, widgetRot, boxStyle);
  if (!box) return;

  drawFallbackWidgetBoxChrome(page, userUnit, box.frame, box.borderWUser, boxStyle);
  if (!box.textSpec) return;

  const layout = await fitFallbackFieldText(fonts, box.textSpec);
  const padXPt = box.textSpec.padXPt;

  const sizeUser = layout.sizePt / userUnit;
  const padXUser = padXPt / userUnit;
  const availWUser = box.textSpec.availWPt / userUnit;
  const blockHeightUser = layout.blockHeightPt / userUnit;
  const blockTopLocalY = Math.min(box.frame.height, (box.frame.height + blockHeightUser) / 2);

  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i] ?? '';
    if (line.length === 0) continue;
    const localY = blockTopLocalY - (layout.baselineOffsetsPt[i] ?? 0) / userUnit;
    const localX = await computeAlignedLocalX(fonts, line, sizeUser, padXUser, availWUser, textAlign);
    const pt = localRectPointToPdf(box.frame.basis, localX, localY);
    await fonts.drawText(page, line, {
      weight: 'regular',
      sizePt: sizeUser,
      color: textColor ?? COLOR_INK,
      x: pt.x,
      y: pt.y,
      rotateDeg: box.frame.rotateDeg,
    });
  }
}

interface FittedOptionListLayout {
  readonly sizePt: number;
  readonly rowHeightPt: number;
  readonly baselineInRowOffsetPt: number;
  readonly rows: readonly OptionListFallbackRow[];
}

async function fitFallbackOptionList(
  fonts: PdfFontContext,
  box: FallbackWidgetBoxGeometry,
  rows: readonly OptionListFallbackRow[],
): Promise<FittedOptionListLayout | undefined> {
  if (rows.length === 0) return undefined;
  const errorMessage = 'Nội dung ô danh sách biểu mẫu vượt quá kích thước khung đặt trên trang';
  if (box.availWPt <= 0.5 || box.availHPt <= 0.5) {
    throw new PdfSignError(errorMessage);
  }

  const measureRows = async (
    sz: number,
  ): Promise<{ maxLineW: number; rowHeightPt: number; baselineOffsetPt: number }> => {
    let maxLineW = 0;
    let maxAscentPt = sz * 0.74;
    let maxDescentPt = sz * 0.22;
    for (const row of rows) {
      if (row.label.length > 0) {
        const w = await fonts.measureWidth(row.label, 'regular', sz);
        if (w > maxLineW) maxLineW = w;
      }
      const ext = await fonts.measureVerticalExtents(row.label.length > 0 ? row.label : ' ', 'regular', sz);
      if (ext.ascentPt > maxAscentPt) maxAscentPt = ext.ascentPt;
      if (ext.descentPt > maxDescentPt) maxDescentPt = ext.descentPt;
    }
    const rowHeightPt = Math.max(sz * 1.3, maxAscentPt + maxDescentPt + Math.max(1, sz * 0.16));
    const extraY = Math.max(0, rowHeightPt - (maxAscentPt + maxDescentPt));
    const baselineOffsetPt = maxDescentPt + extraY / 2;
    return { maxLineW, rowHeightPt, baselineOffsetPt };
  };

  let sizePt = Math.max(MIN_STAMP_FONT_PT, Math.min(12, (box.availHPt * 0.76) / rows.length));
  let metrics = await measureRows(sizePt);

  while (
    (metrics.rowHeightPt * rows.length > box.availHPt + 0.01 || metrics.maxLineW > box.availWPt + 0.01) &&
    sizePt > MIN_STAMP_FONT_PT
  ) {
    const totalH = metrics.rowHeightPt * rows.length;
    let nextSizePt = sizePt * 0.88;
    if (metrics.maxLineW <= box.availWPt + 0.01 && totalH > box.availHPt + 0.01) {
      const heightFit = sizePt * (box.availHPt / Math.max(totalH, 0.01)) * 0.995;
      if (heightFit < sizePt * 0.995) {
        nextSizePt = Math.max(nextSizePt, heightFit);
      }
    } else if (metrics.maxLineW > box.availWPt + 0.01) {
      const widthFit = sizePt * (box.availWPt / Math.max(metrics.maxLineW, 0.01)) * 0.995;
      if (widthFit < sizePt * 0.995) {
        nextSizePt = Math.max(nextSizePt, widthFit);
      }
    }
    sizePt = Math.max(MIN_STAMP_FONT_PT, nextSizePt);
    metrics = await measureRows(sizePt);
  }

  if (metrics.rowHeightPt * rows.length > box.availHPt + 0.01 || metrics.maxLineW > box.availWPt + 0.01) {
    throw new PdfSignError(errorMessage);
  }

  return {
    sizePt,
    rowHeightPt: metrics.rowHeightPt,
    baselineInRowOffsetPt: metrics.baselineOffsetPt,
    rows,
  };
}

async function drawFallbackOptionList(
  fonts: PdfFontContext,
  page: PDFPage,
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rows: readonly OptionListFallbackRow[],
  rot: PageRotation = 0,
  noRotate = false,
  widgetRot: PageRotation = 0,
  boxStyle?: WidgetBoxStyle,
  textColor?: Color,
  textAlign: TextQuadding = 0,
): Promise<void> {
  const box = buildFallbackWidgetBoxGeometry(userUnit, rect, rot, noRotate, widgetRot, boxStyle);
  if (!box) return;

  drawFallbackWidgetBoxChrome(page, userUnit, box.frame, box.borderWUser, boxStyle);
  const layout = await fitFallbackOptionList(fonts, box, rows);
  if (!layout) return;

  const rowHUser = layout.rowHeightPt / userUnit;
  const sizeUser = layout.sizePt / userUnit;
  const padXUser = box.padXPt / userUnit;
  const availWUser = box.availWPt / userUnit;
  const padYUser = box.padYPt / userUnit;
  const topLocalY = box.frame.height - padYUser;
  const highlightLeftX = box.borderWUser + Math.min(padXUser * 0.3, 1 / userUnit);
  const highlightW = Math.max(0.1 / userUnit, box.frame.width - 2 * highlightLeftX);

  for (let i = 0; i < layout.rows.length; i += 1) {
    const row = layout.rows[i];
    if (!row) continue;
    const rowBottomY = topLocalY - (i + 1) * rowHUser;
    if (row.selected) {
      const highlightOrigin = localRectPointToPdf(box.frame.basis, highlightLeftX, rowBottomY);
      page.drawRectangle({
        x: highlightOrigin.x,
        y: highlightOrigin.y,
        width: highlightW,
        height: rowHUser,
        rotate: degrees(box.frame.rotateDeg),
        color: OPTION_LIST_SELECTED_BG,
        borderWidth: 0,
      });
    }
    if (row.label.length > 0) {
      const localX = await computeAlignedLocalX(fonts, row.label, sizeUser, padXUser, availWUser, textAlign);
      const textOrigin = localRectPointToPdf(
        box.frame.basis,
        localX,
        rowBottomY + layout.baselineInRowOffsetPt / userUnit,
      );
      await fonts.drawText(page, row.label, {
        weight: 'regular',
        sizePt: sizeUser,
        color: textColor ?? COLOR_INK,
        x: textOrigin.x,
        y: textOrigin.y,
        rotateDeg: box.frame.rotateDeg,
      });
    }
  }
}

function drawFallbackRadioButton(
  page: PDFPage,
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  checked: boolean,
  rot: PageRotation,
  noRotate: boolean,
): void {
  const basis = getAnnotationBasis(rect, rot, noRotate);
  const center = localRectPointToPdf(basis, rect.width / 2, rect.height / 2);
  const borderW = 1 / userUnit;
  const outerR = Math.max(1 / userUnit, Math.min(rect.width, rect.height) / 2 - borderW / 2);
  page.drawEllipse({
    x: center.x,
    y: center.y,
    xScale: outerR,
    yScale: outerR,
    color: COLOR_WHITE,
    borderColor: checked ? COLOR_ACCENT : COLOR_INK,
    borderWidth: borderW,
  });
  if (checked) {
    const innerR = Math.max(0.5 / userUnit, outerR * 0.52);
    page.drawEllipse({
      x: center.x,
      y: center.y,
      xScale: innerR,
      yScale: innerR,
      color: COLOR_ACCENT,
    });
  }
}

function drawFallbackCheckBox(
  page: PDFPage,
  userUnit: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  checked: boolean,
  rot: PageRotation,
  noRotate: boolean,
  widgetRot: PageRotation = 0,
): void {
  const frame = getWidgetFallbackFrame(rect, rot, noRotate, widgetRot);
  const borderW = 1 / userUnit;
  const inset = Math.min(borderW, frame.width * 0.1, frame.height * 0.1);
  const bl = localRectPointToPdf(frame.basis, inset, inset);
  page.drawRectangle({
    x: bl.x,
    y: bl.y,
    width: Math.max(2 / userUnit, frame.width - 2 * inset),
    height: Math.max(2 / userUnit, frame.height - 2 * inset),
    rotate: degrees(frame.rotateDeg),
    color: checked ? COLOR_ACCENT : COLOR_WHITE,
    borderColor: checked ? COLOR_ACCENT : COLOR_INK,
    borderWidth: borderW,
  });
  if (checked) {
    const p1 = localRectPointToPdf(frame.basis, frame.width * 0.24, frame.height * 0.48);
    const p2 = localRectPointToPdf(frame.basis, frame.width * 0.43, frame.height * 0.28);
    const p3 = localRectPointToPdf(frame.basis, frame.width * 0.78, frame.height * 0.72);
    const thickness = Math.max(1.1 / userUnit, Math.min(frame.width, frame.height) * 0.12);
    page.drawLine({ start: p1, end: p2, thickness, color: COLOR_WHITE, lineCap: LineCapStyle.Round });
    page.drawLine({ start: p2, end: p3, thickness, color: COLOR_WHITE, lineCap: LineCapStyle.Round });
  }
}

interface OptionalContentContext {
  readonly hasValidOcgTable: boolean;
  readonly declaredTags: ReadonlySet<string>;
  readonly baseState: 'ON' | 'OFF' | 'Unchanged';
  readonly onTags: ReadonlySet<string>;
  readonly offTags: ReadonlySet<string>;
  readonly onDicts: ReadonlySet<PDFDict>;
  readonly offDicts: ReadonlySet<PDFDict>;
  readonly hasUsageRules: boolean;
}

const optionalContentContextCache = new WeakMap<PDFDocument, OptionalContentContext>();

function collectOcgTargets(
  pdfDoc: PDFDocument,
  dict: PDFDict,
  keyName: string,
): { readonly tags: Set<string>; readonly dicts: Set<PDFDict> } {
  const tags = new Set<string>();
  const dicts = new Set<PDFDict>();
  const arr = lookupDictEntryByDecodedName(pdfDoc, dict, keyName)?.resolved;
  if (!(arr instanceof PDFArray)) {
    return { tags, dicts };
  }
  const size = arr.size();
  for (let i = 0; i < size; i++) {
    const raw = arr.get(i);
    if (raw instanceof PDFRef) {
      tags.add(raw.tag);
    }
    const resolved = pdfDoc.context.lookup(raw);
    if (resolved instanceof PDFDict) {
      dicts.add(resolved);
    }
  }
  return { tags, dicts };
}

function getOptionalContentContext(pdfDoc: PDFDocument): OptionalContentContext {
  const cached = optionalContentContextCache.get(pdfDoc);
  if (cached) return cached;

  let hasValidOcgTable = false;
  const declaredTags = new Set<string>();
  let baseState: 'ON' | 'OFF' | 'Unchanged' = 'ON';
  let onTags = new Set<string>();
  let offTags = new Set<string>();
  let onDicts = new Set<PDFDict>();
  let offDicts = new Set<PDFDict>();
  let hasUsageRules = false;

  const ocProps = lookupDictEntryByDecodedName(pdfDoc, pdfDoc.catalog, 'OCProperties')?.resolved;
  if (ocProps instanceof PDFDict) {
    const ocgsEntry = lookupDictEntryByDecodedName(pdfDoc, ocProps, 'OCGs')?.resolved;
    const dEntry = lookupDictEntryByDecodedName(pdfDoc, ocProps, 'D')?.resolved;
    if (ocgsEntry instanceof PDFArray && dEntry instanceof PDFDict) {
      hasValidOcgTable = true;
      const ocgsLen = ocgsEntry.size();
      for (let i = 0; i < ocgsLen; i++) {
        const rawOcg = ocgsEntry.get(i);
        if (rawOcg instanceof PDFRef) {
          declaredTags.add(rawOcg.tag);
        }
      }
    }
    if (dEntry instanceof PDFDict) {
      const asEntry = lookupDictEntryByDecodedName(pdfDoc, dEntry, 'AS')?.resolved;
      hasUsageRules = asEntry instanceof PDFArray && asEntry.size() > 0;

      const baseEntry = lookupDictEntryByDecodedName(pdfDoc, dEntry, 'BaseState')?.resolved;
      if (baseEntry !== undefined) {
        if (!(baseEntry instanceof PDFName)) {
          throw new PdfSignError('Tệp PDF có cấu hình lớp hiển thị (/BaseState) không hợp lệ');
        }
        const decoded = decodePdfName(baseEntry);
        if (decoded !== 'ON' && decoded !== 'OFF' && decoded !== 'Unchanged') {
          throw new PdfSignError(`Tệp PDF có cấu hình lớp hiển thị không hợp lệ: /${decoded}`);
        }
        baseState = decoded;
      }

      const onSet = collectOcgTargets(pdfDoc, dEntry, 'ON');
      const offSet = collectOcgTargets(pdfDoc, dEntry, 'OFF');
      onTags = onSet.tags;
      onDicts = onSet.dicts;
      offTags = offSet.tags;
      offDicts = offSet.dicts;
    }
  }

  const ctx: OptionalContentContext = {
    hasValidOcgTable,
    declaredTags,
    baseState,
    onTags,
    offTags,
    onDicts,
    offDicts,
    hasUsageRules,
  };
  optionalContentContextCache.set(pdfDoc, ctx);
  return ctx;
}

function getOcgViewState(pdfDoc: PDFDocument, dict: PDFDict): 'ON' | 'OFF' | undefined {
  const usageEntry = lookupDictEntryByDecodedName(pdfDoc, dict, 'Usage')?.resolved;
  if (!(usageEntry instanceof PDFDict)) return undefined;
  const viewEntry = lookupDictEntryByDecodedName(pdfDoc, usageEntry, 'View')?.resolved;
  if (!(viewEntry instanceof PDFDict)) return undefined;
  const viewStateObj = lookupDictEntryByDecodedName(pdfDoc, viewEntry, 'ViewState')?.resolved;
  if (!(viewStateObj instanceof PDFName)) return undefined;
  const decoded = decodePdfName(viewStateObj);
  if (decoded === 'ON' || decoded === 'OFF') return decoded;
  return undefined;
}

function isSingleOcgVisible(
  pdfDoc: PDFDocument,
  ctx: OptionalContentContext,
  raw: unknown,
  dict: PDFDict,
): boolean {
  const inOff = (raw instanceof PDFRef && ctx.offTags.has(raw.tag)) || ctx.offDicts.has(dict);
  const inOn = (raw instanceof PDFRef && ctx.onTags.has(raw.tag)) || ctx.onDicts.has(dict);
  if (inOff && inOn) {
    throw new PdfSignError('Tệp PDF có cấu hình lớp hiển thị mâu thuẫn giữa ON và OFF');
  }
  const viewState = getOcgViewState(pdfDoc, dict);
  const isDeclared = ctx.hasValidOcgTable && raw instanceof PDFRef && ctx.declaredTags.has(raw.tag);

  let visible: boolean;
  if (inOff) {
    visible = false;
  } else if (inOn) {
    visible = viewState !== 'OFF';
  } else if (ctx.baseState === 'Unchanged') {
    throw new PdfSignError('Tệp PDF có trạng thái lớp hiển thị mặc định không xác định');
  } else {
    visible = ctx.baseState === 'ON' && viewState !== 'OFF';
  }

  if (!isDeclared && (!visible || viewState === 'OFF')) {
    throw new PdfSignError('Tệp PDF chứa lớp hiển thị (/OC) không được khai báo hợp lệ trong /OCProperties');
  }
  return visible;
}

function isOptionalContentVisible(pdfDoc: PDFDocument, dict: PDFDict): boolean {
  const ocEntry = lookupDictEntryByDecodedName(pdfDoc, dict, 'OC');
  if (!ocEntry) return true;

  const ctx = getOptionalContentContext(pdfDoc);
  if (ctx.hasUsageRules) {
    throw new PdfSignError('Tệp PDF dùng quy tắc hiển thị lớp động (/OCProperties /AS) nên không thể làm phẳng an toàn');
  }
  if (!(ocEntry.resolved instanceof PDFDict)) {
    throw new PdfSignError('Tệp PDF chứa tham chiếu lớp hiển thị (/OC) không hợp lệ');
  }

  const ocDict = ocEntry.resolved;
  const typeObj = lookupDictEntryByDecodedName(pdfDoc, ocDict, 'Type')?.resolved;
  const typeName = typeObj instanceof PDFName ? decodePdfName(typeObj) : undefined;
  const hasOcmdKeys =
    typeName === 'OCMD' ||
    lookupDictEntryByDecodedName(pdfDoc, ocDict, 'OCGs') !== undefined ||
    lookupDictEntryByDecodedName(pdfDoc, ocDict, 'VE') !== undefined;

  if (!hasOcmdKeys) {
    return isSingleOcgVisible(pdfDoc, ctx, ocEntry.raw, ocDict);
  }

  if (lookupDictEntryByDecodedName(pdfDoc, ocDict, 'VE') !== undefined) {
    throw new PdfSignError('Tệp PDF dùng biểu thức lớp hiển thị (/VE) nên không thể làm phẳng an toàn');
  }

  const ocgsEntry = lookupDictEntryByDecodedName(pdfDoc, ocDict, 'OCGs');
  const members: Array<readonly [unknown, PDFDict]> = [];
  if (ocgsEntry && ocgsEntry.resolved !== undefined) {
    if (ocgsEntry.resolved instanceof PDFArray) {
      const len = ocgsEntry.resolved.size();
      for (let i = 0; i < len; i++) {
        const itemRaw = ocgsEntry.resolved.get(i);
        const itemDict = pdfDoc.context.lookup(itemRaw);
        if (!(itemDict instanceof PDFDict)) {
          throw new PdfSignError('Tệp PDF chứa thành viên lớp hiển thị (/OCGs) không hợp lệ');
        }
        members.push([itemRaw, itemDict]);
      }
    } else if (ocgsEntry.resolved instanceof PDFDict) {
      members.push([ocgsEntry.raw, ocgsEntry.resolved]);
    } else {
      throw new PdfSignError('Tệp PDF chứa trường /OCGs không hợp lệ');
    }
  }

  const pObj = lookupDictEntryByDecodedName(pdfDoc, ocDict, 'P')?.resolved;
  const policy = pObj instanceof PDFName ? decodePdfName(pObj) : 'AnyOn';
  const states = members.map(([r, d]) => isSingleOcgVisible(pdfDoc, ctx, r, d));

  switch (policy) {
    case 'AnyOn':
      return states.length === 0 ? true : states.some(Boolean);
    case 'AllOn':
      return states.length === 0 ? true : states.every(Boolean);
    case 'AnyOff':
      return states.length === 0 ? false : states.some((visible) => !visible);
    case 'AllOff':
      return states.length === 0 ? false : states.every((visible) => !visible);
    default:
      throw new PdfSignError(`Tệp PDF chứa chính sách hiển thị lớp không hợp lệ: /${policy}`);
  }
}

function isAnnotationHidden(pdfDoc: PDFDocument, dict: PDFDict): boolean {
  const flags = readAnnotationFlags(pdfDoc, dict);
  // Skip Hidden (bit 2) and NoView (bit 6) annotations so clauses invisible to signers are never stamped.
  if ((flags & ANNOTATION_FLAG_HIDDEN) !== 0 || (flags & ANNOTATION_FLAG_NOVIEW) !== 0) {
    return true;
  }
  // Skip Invisible (bit 1) annotations when no standard handler exists for the annotation subtype.
  if ((flags & ANNOTATION_FLAG_INVISIBLE) !== 0) {
    const subtypeObj = lookupDictEntryByDecodedName(pdfDoc, dict, 'Subtype')?.resolved;
    const subtype = subtypeObj instanceof PDFName ? decodePdfName(subtypeObj) : undefined;
    if (!subtype || !HANDLED_ANNOTATION_SUBTYPES.has(subtype)) {
      return true;
    }
  }
  return !isOptionalContentVisible(pdfDoc, dict);
}

type FrozenAppearanceResult =
  | { readonly status: 'hidden' }
  | { readonly status: 'keep'; readonly ref: PDFRef }
  | { readonly status: 'replaced'; readonly ref: PDFRef };

const frozenAppearanceCache = new WeakMap<PDFDocument, Map<PDFRef, FrozenAppearanceResult>>();

function freezeFlattenedAppearanceStream(
  pdfDoc: PDFDocument,
  apRef: PDFRef,
  visiting: Set<PDFRef> = new Set(),
): FrozenAppearanceResult {
  let docCache = frozenAppearanceCache.get(pdfDoc);
  if (!docCache) {
    docCache = new Map<PDFRef, FrozenAppearanceResult>();
    frozenAppearanceCache.set(pdfDoc, docCache);
  }
  const cached = docCache.get(apRef);
  if (cached) return cached;
  if (visiting.has(apRef)) return { status: 'keep', ref: apRef };

  const apObj = pdfDoc.context.lookup(apRef);
  if (!(apObj instanceof PDFStream)) {
    return { status: 'keep', ref: apRef };
  }
  if (!isOptionalContentVisible(pdfDoc, apObj.dict)) {
    const hiddenResult: FrozenAppearanceResult = { status: 'hidden' };
    docCache.set(apRef, hiddenResult);
    return hiddenResult;
  }

  visiting.add(apRef);
  try {
    const ocEntry = lookupDictEntryByDecodedName(pdfDoc, apObj.dict, 'OC');
    const resourcesEntry = lookupDictEntryByDecodedName(pdfDoc, apObj.dict, 'Resources');
    const resourcesDict = resourcesEntry?.resolved instanceof PDFDict ? resourcesEntry.resolved : undefined;
    const xObjectEntry = resourcesDict ? lookupDictEntryByDecodedName(pdfDoc, resourcesDict, 'XObject') : undefined;
    const xObjectDict = xObjectEntry?.resolved instanceof PDFDict ? xObjectEntry.resolved : undefined;

    const childUpdates = new Map<PDFName, PDFRef>();
    if (xObjectDict) {
      let blankFormRef: PDFRef | undefined;
      for (const [childKey, childRaw] of xObjectDict.entries()) {
        if (!(childRaw instanceof PDFRef)) continue;
        const childResult = freezeFlattenedAppearanceStream(pdfDoc, childRaw, visiting);
        if (childResult.status === 'hidden') {
          if (!blankFormRef) {
            blankFormRef = pdfDoc.context.register(
              pdfDoc.context.formXObject([], { BBox: pdfDoc.context.obj([0, 0, 1, 1]) }),
            );
          }
          childUpdates.set(childKey, blankFormRef);
        } else if (childResult.status === 'replaced') {
          childUpdates.set(childKey, childResult.ref);
        }
      }
    }

    if (ocEntry === undefined && childUpdates.size === 0) {
      const keepResult: FrozenAppearanceResult = { status: 'keep', ref: apRef };
      docCache.set(apRef, keepResult);
      return keepResult;
    }

    const clonedStream = apObj.clone(pdfDoc.context);
    if (ocEntry !== undefined) {
      const clonedOc = lookupDictEntryByDecodedName(pdfDoc, clonedStream.dict, 'OC');
      if (clonedOc) {
        clonedStream.dict.delete(clonedOc.key);
      }
    }
    if (childUpdates.size > 0 && resourcesEntry && resourcesDict && xObjectEntry && xObjectDict) {
      const clonedResources = resourcesDict.clone(pdfDoc.context);
      const clonedXObjects = xObjectDict.clone(pdfDoc.context);
      for (const [childKey, nextRef] of childUpdates.entries()) {
        clonedXObjects.set(childKey, nextRef);
      }
      clonedResources.set(xObjectEntry.key, clonedXObjects);
      clonedStream.dict.set(resourcesEntry.key, clonedResources);
    }

    const frozenRef = pdfDoc.context.register(clonedStream);
    const replacedResult: FrozenAppearanceResult = { status: 'replaced', ref: frozenRef };
    docCache.set(apRef, replacedResult);
    return replacedResult;
  } finally {
    visiting.delete(apRef);
  }
}

const normalizedAppearanceFormCache = new WeakMap<PDFDocument, Map<PDFRef, PDFRef>>();

function isValidAppearanceFormSubtype(pdfDoc: PDFDocument, stream: PDFStream): boolean {
  const subtypeEntry = lookupDictEntryByDecodedName(pdfDoc, stream.dict, 'Subtype');
  if (subtypeEntry) {
    if (!(subtypeEntry.resolved instanceof PDFName) || decodePdfName(subtypeEntry.resolved) !== 'Form') {
      return false;
    }
  }
  const typeEntry = lookupDictEntryByDecodedName(pdfDoc, stream.dict, 'Type');
  if (typeEntry) {
    if (!(typeEntry.resolved instanceof PDFName) || decodePdfName(typeEntry.resolved) !== 'XObject') {
      return false;
    }
  }
  return true;
}

function ensureAppearanceFormSubtype(pdfDoc: PDFDocument, streamRef: PDFRef): PDFRef {
  const stream = pdfDoc.context.lookup(streamRef);
  if (!(stream instanceof PDFStream)) return streamRef;

  const subtypeEntry = lookupDictEntryByDecodedName(pdfDoc, stream.dict, 'Subtype');
  const typeEntry = lookupDictEntryByDecodedName(pdfDoc, stream.dict, 'Type');
  const hasExactSubtype =
    subtypeEntry !== undefined &&
    subtypeEntry.key.decodeText() === 'Subtype' &&
    subtypeEntry.resolved instanceof PDFName &&
    subtypeEntry.resolved.decodeText() === 'Form';
  const hasValidType =
    typeEntry === undefined ||
    (typeEntry.key.decodeText() === 'Type' &&
      typeEntry.resolved instanceof PDFName &&
      typeEntry.resolved.decodeText() === 'XObject');
  if (hasExactSubtype && hasValidType) {
    return streamRef;
  }

  let docCache = normalizedAppearanceFormCache.get(pdfDoc);
  if (!docCache) {
    docCache = new Map<PDFRef, PDFRef>();
    normalizedAppearanceFormCache.set(pdfDoc, docCache);
  }
  const cached = docCache.get(streamRef);
  if (cached) return cached;

  const cloned = stream.clone(pdfDoc.context);
  if (!hasExactSubtype) {
    deleteDictKeysByDecodedName(cloned.dict, 'Subtype');
    cloned.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  }
  if (!typeEntry || !hasValidType) {
    deleteDictKeysByDecodedName(cloned.dict, 'Type');
    cloned.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  }
  const normalizedRef = pdfDoc.context.register(cloned);
  docCache.set(streamRef, normalizedRef);
  return normalizedRef;
}

function validateOptionalContentVisibilityTree(
  pdfDoc: PDFDocument,
  apObj: PDFStream,
  visited: Set<object> = new Set(),
): void {
  if (visited.has(apObj)) return;
  visited.add(apObj);
  if (!isOptionalContentVisible(pdfDoc, apObj.dict)) {
    return;
  }
  const resourcesDict = lookupDictEntryByDecodedName(pdfDoc, apObj.dict, 'Resources')?.resolved;
  if (!(resourcesDict instanceof PDFDict)) return;
  const xObjectDict = lookupDictEntryByDecodedName(pdfDoc, resourcesDict, 'XObject')?.resolved;
  if (!(xObjectDict instanceof PDFDict)) return;
  for (const [, childRaw] of xObjectDict.entries()) {
    if (!(childRaw instanceof PDFRef)) continue;
    const childObj = pdfDoc.context.lookup(childRaw);
    if (childObj instanceof PDFStream) {
      validateOptionalContentVisibilityTree(pdfDoc, childObj, visited);
    }
  }
}

const MAX_CONTENT_STREAM_NESTING_DEPTH = 4096;
const MAX_PAGE_CONTENT_STREAMS = 4096;

interface ContentStreamDecodeBudget {
  remainingBytes: number;
}

function decodeAsciiPdfNameBytes(bytes: Uint8Array, startAfterSlash: number, end: number): string {
  let out = '';
  let pos = startAfterSlash;
  while (pos < end) {
    const ch = bytes[pos]!;
    if (ch === 0x23 && pos + 2 < end) {
      const hex = String.fromCharCode(bytes[pos + 1]!, bytes[pos + 2]!);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 3;
        continue;
      }
    }
    out += String.fromCharCode(ch);
    pos += 1;
  }
  return out;
}

function skipContentLiteralStringBytes(bytes: Uint8Array, startAfterOpenParen: number): number {
  let pos = startAfterOpenParen;
  let depth = 1;
  while (pos < bytes.length && depth > 0) {
    const ch = bytes[pos++]!;
    if (ch === 0x5c) {
      if (pos < bytes.length) pos += 1;
    } else if (ch === 0x28) {
      depth += 1;
    } else if (ch === 0x29) {
      depth -= 1;
    }
  }
  if (depth !== 0) {
    throw new PdfSignError('Chuỗi ký tự không đóng trong luồng nội dung PDF');
  }
  return pos;
}

function skipContentHexStringBytes(bytes: Uint8Array, startAfterLt: number): number {
  let pos = startAfterLt;
  while (pos < bytes.length) {
    if (bytes[pos++]! === 0x3e) return pos;
  }
  throw new PdfSignError('Chuỗi hex không đóng trong luồng nội dung PDF');
}

function skipInlineImageCommentAndWs(bytes: Uint8Array, start: number): number {
  let pos = start;
  while (pos < bytes.length) {
    const code = bytes[pos]!;
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25) {
      pos += 1;
      while (pos < bytes.length) {
        const ch = bytes[pos++]!;
        if (ch === 0x0a || ch === 0x0d) break;
      }
      continue;
    }
    break;
  }
  return pos;
}

interface PdfJsLexerToken {
  readonly kind: 'value' | 'cmd' | 'error';
  readonly nextPos: number;
  readonly cmd?: string;
}

function isPdfNumberStartCode(code: number): boolean {
  return code === 0x2b || code === 0x2d || code === 0x2e || (code >= 0x30 && code <= 0x39);
}

function isPdfJsNumberFollowCode(code: number): boolean {
  return (
    code === -1 ||
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0d ||
    code === 0x0a ||
    code === 0x28 ||
    code === 0x3c
  );
}

/** Match PDF.js Lexer.prototype.getNumber token consumption boundaries. */
function readPdfJsNumberToken(bytes: Uint8Array, start: number, end: number): PdfJsLexerToken {
  let pos = start;
  const first = bytes[pos]!;
  if (first === 0x2d) {
    pos += 1;
    if (pos < end && bytes[pos] === 0x2d) {
      pos += 1;
    }
  } else if (first === 0x2b) {
    pos += 1;
  }
  while (pos < end && (bytes[pos] === 0x0a || bytes[pos] === 0x0d)) {
    pos += 1;
  }
  let sawDot = false;
  if (pos < end && bytes[pos] === 0x2e) {
    sawDot = true;
    pos += 1;
  }
  const afterPrefix = pos < end ? bytes[pos]! : -1;
  if (afterPrefix < 0x30 || afterPrefix > 0x39) {
    if (isPdfJsNumberFollowCode(afterPrefix)) {
      return { kind: 'value', nextPos: pos };
    }
    return { kind: 'error', nextPos: pos };
  }
  pos += 1;
  while (pos < end) {
    const ch = bytes[pos]!;
    if (ch >= 0x30 && ch <= 0x39) {
      pos += 1;
    } else if (ch === 0x2e) {
      if (!sawDot) {
        sawDot = true;
        pos += 1;
      } else {
        break;
      }
    } else if (ch === 0x2d) {
      pos += 1;
    } else {
      break;
    }
  }
  return { kind: 'value', nextPos: pos };
}

function skipInlineImageValue(
  bytes: Uint8Array,
  start: number,
  depth: number,
  isFilterValue: boolean,
): { readonly nextPos: number; readonly filterName?: string | undefined } {
  if (depth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
    throw new PdfSignError('Độ sâu giá trị từ điển ảnh nội tuyến PDF vượt giới hạn');
  }
  let pos = skipInlineImageCommentAndWs(bytes, start);
  if (pos >= bytes.length) {
    throw new PdfSignError('Từ điển ảnh nội tuyến PDF không đầy đủ');
  }
  const code = bytes[pos]!;
  if (code === 0x2f) {
    const nameStart = pos + 1;
    pos += 1;
    while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
      pos += 1;
    }
    return {
      nextPos: pos,
      filterName: isFilterValue ? decodeAsciiPdfNameBytes(bytes, nameStart, pos) : undefined,
    };
  }
  if (code === 0x5b) {
    pos += 1;
    let firstFilter: string | undefined;
    let elemCount = 0;
    while (pos < bytes.length) {
      pos = skipInlineImageCommentAndWs(bytes, pos);
      if (pos >= bytes.length) {
        throw new PdfSignError('Mảng trong ảnh nội tuyến PDF không đóng');
      }
      if (bytes[pos] === 0x5d) {
        pos += 1;
        if (isFilterValue && elemCount === 0) {
          throw new PdfSignError('Mảng bộ lọc ảnh nội tuyến PDF không được rỗng');
        }
        return { nextPos: pos, filterName: firstFilter };
      }
      if (isFilterValue && bytes[pos] !== 0x2f) {
        throw new PdfSignError('Phần tử bộ lọc ảnh nội tuyến PDF phải là tên trực tiếp');
      }
      const elem = skipInlineImageValue(bytes, pos, depth + 1, isFilterValue && elemCount === 0);
      if (isFilterValue && elemCount === 0) {
        firstFilter = elem.filterName;
      }
      elemCount += 1;
      pos = elem.nextPos;
    }
    throw new PdfSignError('Mảng trong ảnh nội tuyến PDF không đóng');
  }
  if (isFilterValue) {
    throw new PdfSignError('Giá trị bộ lọc (/F hoặc /Filter) ảnh nội tuyến PDF không hợp lệ');
  }
  if (code === 0x28) {
    return { nextPos: skipContentLiteralStringBytes(bytes, pos + 1) };
  }
  if (code === 0x3c) {
    if (pos + 1 < bytes.length && bytes[pos + 1] === 0x3c) {
      pos += 2;
      while (pos < bytes.length) {
        pos = skipInlineImageCommentAndWs(bytes, pos);
        if (pos >= bytes.length) {
          throw new PdfSignError('Từ điển lồng trong ảnh nội tuyến PDF không đóng');
        }
        if (bytes[pos] === 0x3e && pos + 1 < bytes.length && bytes[pos + 1] === 0x3e) {
          return { nextPos: pos + 2 };
        }
        if (bytes[pos] !== 0x2f) {
          throw new PdfSignError('Khóa từ điển lồng trong ảnh nội tuyến PDF phải là tên');
        }
        pos += 1;
        while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
          pos += 1;
        }
        const val = skipInlineImageValue(bytes, pos, depth + 1, false);
        pos = val.nextPos;
      }
      throw new PdfSignError('Từ điển lồng trong ảnh nội tuyến PDF không đóng');
    }
    return { nextPos: skipContentHexStringBytes(bytes, pos + 1) };
  }
  if (isPdfDelimiterCode(code)) {
    throw new PdfSignError('Giá trị không hợp lệ trong từ điển ảnh nội tuyến PDF');
  }
  if (isPdfNumberStartCode(code)) {
    const numTok = readPdfJsNumberToken(bytes, pos, bytes.length);
    if (numTok.kind === 'error') {
      throw new PdfSignError('Giá trị số không hợp lệ trong từ điển ảnh nội tuyến PDF');
    }
    return { nextPos: numTok.nextPos };
  }
  const tokStart = pos;
  while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
    pos += 1;
  }
  if (pos - tokStart === 2 && bytes[tokStart] === 0x49 && bytes[tokStart + 1] === 0x44) {
    throw new PdfSignError('Thiếu giá trị trước từ khóa ID trong ảnh nội tuyến PDF');
  }
  return { nextPos: pos };
}

interface PdfJsInlineOpSpec {
  readonly numArgs: number;
  readonly variable: boolean;
}

const FIXED_0: PdfJsInlineOpSpec = { numArgs: 0, variable: false };
const FIXED_1: PdfJsInlineOpSpec = { numArgs: 1, variable: false };
const FIXED_2: PdfJsInlineOpSpec = { numArgs: 2, variable: false };
const FIXED_3: PdfJsInlineOpSpec = { numArgs: 3, variable: false };
const FIXED_4: PdfJsInlineOpSpec = { numArgs: 4, variable: false };
const FIXED_6: PdfJsInlineOpSpec = { numArgs: 6, variable: false };

const PDFJS_INLINE_KNOWN_COMMANDS = new Map<string, PdfJsInlineOpSpec | null>([
  ['w', FIXED_1],
  ['J', FIXED_1],
  ['j', FIXED_1],
  ['M', FIXED_1],
  ['d', FIXED_2],
  ['ri', FIXED_1],
  ['i', FIXED_1],
  ['gs', FIXED_1],
  ['q', FIXED_0],
  ['Q', FIXED_0],
  ['cm', FIXED_6],
  ['m', FIXED_2],
  ['l', FIXED_2],
  ['c', FIXED_6],
  ['v', FIXED_4],
  ['y', FIXED_4],
  ['h', FIXED_0],
  ['re', FIXED_4],
  ['S', FIXED_0],
  ['s', FIXED_0],
  ['f', FIXED_0],
  ['F', FIXED_0],
  ['f*', FIXED_0],
  ['B', FIXED_0],
  ['B*', FIXED_0],
  ['b', FIXED_0],
  ['b*', FIXED_0],
  ['n', FIXED_0],
  ['W', FIXED_0],
  ['W*', FIXED_0],
  ['BT', FIXED_0],
  ['ET', FIXED_0],
  ['Tc', FIXED_1],
  ['Tw', FIXED_1],
  ['Tz', FIXED_1],
  ['TL', FIXED_1],
  ['Tf', FIXED_2],
  ['Tr', FIXED_1],
  ['Ts', FIXED_1],
  ['Td', FIXED_2],
  ['TD', FIXED_2],
  ['Tm', FIXED_6],
  ['T*', FIXED_0],
  ['Tj', FIXED_1],
  ['TJ', FIXED_1],
  ["'", FIXED_1],
  ['"', FIXED_3],
  ['d0', FIXED_2],
  ['d1', FIXED_6],
  ['CS', FIXED_1],
  ['cs', FIXED_1],
  ['SC', { numArgs: 4, variable: true }],
  ['SCN', { numArgs: 33, variable: true }],
  ['sc', { numArgs: 4, variable: true }],
  ['scn', { numArgs: 33, variable: true }],
  ['G', FIXED_1],
  ['g', FIXED_1],
  ['RG', FIXED_3],
  ['rg', FIXED_3],
  ['K', FIXED_4],
  ['k', FIXED_4],
  ['sh', FIXED_1],
  ['BI', FIXED_0],
  ['ID', FIXED_0],
  ['EI', FIXED_1],
  ['Do', FIXED_1],
  ['MP', FIXED_1],
  ['DP', FIXED_2],
  ['BMC', FIXED_1],
  ['BDC', FIXED_2],
  ['EMC', FIXED_0],
  ['BX', FIXED_0],
  ['EX', FIXED_0],
  // PDF.js EvaluatorPreprocessor.opMap prefix sentinels so B/f/n do not split BMC/BDC/false/null/true.
  ['BM', null],
  ['BD', null],
  ['true', null],
  ['fa', null],
  ['fal', null],
  ['fals', null],
  ['false', null],
  ['nu', null],
  ['nul', null],
  ['null', null],
]);

/** Match PDF.js Lexer.prototype.getObj command prefix-splitting and boolean/null handling. */
function readPdfJsCommandToken(bytes: Uint8Array, start: number, end: number): PdfJsLexerToken {
  let pos = start;
  const first = bytes[pos]!;
  let cmd = String.fromCharCode(first);
  pos += 1;
  if (first < 0x20 || first > 0x7f) {
    const peek = pos < end ? bytes[pos]! : -1;
    if (peek >= 0x20 && peek <= 0x7f) {
      return { kind: 'cmd', cmd, nextPos: pos };
    }
  }
  let known = PDFJS_INLINE_KNOWN_COMMANDS.has(cmd);
  while (pos < end) {
    const ch = bytes[pos]!;
    if (isPdfWhitespaceCode(ch) || isPdfDelimiterCode(ch)) break;
    const extended = cmd + String.fromCharCode(ch);
    if (known && !PDFJS_INLINE_KNOWN_COMMANDS.has(extended)) {
      break;
    }
    if (cmd.length === 128) {
      return { kind: 'error', nextPos: pos };
    }
    cmd = extended;
    known = PDFJS_INLINE_KNOWN_COMMANDS.has(cmd);
    pos += 1;
  }
  if (cmd === 'true' || cmd === 'false' || cmd === 'null') {
    return { kind: 'value', nextPos: pos };
  }
  return { kind: 'cmd', cmd, nextPos: pos };
}

const JPEG_LENGTH_MARKERS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xc4, 0xcc, 0xda, 0xdb, 0xdc, 0xdd,
  0xde, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe,
]);

function isInlineImageEiDelimiter(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d;
}

function expectTrailingEiToken(bytes: Uint8Array, start: number): number {
  let pos = start;
  while (pos < bytes.length && isPdfWhitespaceCode(bytes[pos]!)) {
    pos += 1;
  }
  if (pos + 2 > bytes.length || bytes[pos] !== 0x45 || bytes[pos + 1] !== 0x49) {
    throw new PdfSignError('Luồng ảnh nội tuyến PDF thiếu từ khóa kết thúc EI');
  }
  const afterPos = pos + 2;
  if (afterPos < bytes.length && !isInlineImageEiDelimiter(bytes[afterPos]!)) {
    throw new PdfSignError('Từ khóa EI trong ảnh nội tuyến PDF không hợp lệ');
  }
  return afterPos;
}

function isAsciiHexByte(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function matchesPdfJsDefaultEiPreview(bytes: Uint8Array, afterDelim: number): boolean {
  const previewEnd = Math.min(bytes.length, afterDelim + 15);
  for (let idx = afterDelim; idx < previewEnd; idx += 1) {
    const ch = bytes[idx]!;
    const hasNonZeroAfter = ch === 0x00 && !(idx + 1 < previewEnd && bytes[idx + 1] === 0x00);
    if (!hasNonZeroAfter && ch !== 0x0a && ch !== 0x0d && (ch < 0x20 || ch > 0x7f)) {
      return false;
    }
  }
  return true;
}

function matchesPdfJsDefaultEiOperators(bytes: Uint8Array, afterDelim: number): boolean {
  const windowEnd = Math.min(bytes.length, afterDelim + 75);
  if (afterDelim >= windowEnd) return true;

  let pos = afterDelim;
  let argCount = 0;

  while (pos < windowEnd) {
    pos = skipInlineImageCommentAndWs(bytes, pos);
    if (pos >= windowEnd) return false;
    const code = bytes[pos]!;

    if (code === 0x28) {
      let depth = 1;
      pos += 1;
      while (pos < windowEnd && depth > 0) {
        const ch = bytes[pos++]!;
        if (ch === 0x5c) {
          if (pos < windowEnd) pos += 1;
        } else if (ch === 0x28) {
          depth += 1;
        } else if (ch === 0x29) {
          depth -= 1;
        }
      }
      argCount += 1;
      continue;
    }

    if (code === 0x3c) {
      if (pos + 1 < windowEnd && bytes[pos + 1] === 0x3c) {
        return false;
      }
      pos += 1;
      while (pos < windowEnd && bytes[pos++] !== 0x3e) {
        // Consume hex literal bytes until '>' or windowEnd.
      }
      argCount += 1;
      continue;
    }

    if (code === 0x2f) {
      pos += 1;
      while (pos < windowEnd && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
        pos += 1;
      }
      argCount += 1;
      continue;
    }

    if (code === 0x29) {
      throw new PdfSignError('Dấu ngoặc đóng chuỗi không khớp sau ảnh nội tuyến PDF');
    }

    if (isPdfDelimiterCode(code)) {
      return false;
    }

    if (isPdfNumberStartCode(code)) {
      const numTok = readPdfJsNumberToken(bytes, pos, windowEnd);
      if (numTok.kind === 'error') {
        throw new PdfSignError('Toán hạng số không hợp lệ sau ảnh nội tuyến PDF');
      }
      pos = numTok.nextPos;
      argCount += 1;
      continue;
    }

    const cmdTok = readPdfJsCommandToken(bytes, pos, windowEnd);
    if (cmdTok.kind === 'error') {
      throw new PdfSignError('Toán tử quá dài sau ảnh nội tuyến PDF');
    }
    pos = cmdTok.nextPos;
    if (cmdTok.kind === 'value') {
      argCount += 1;
      continue;
    }
    const spec = PDFJS_INLINE_KNOWN_COMMANDS.get(cmdTok.cmd ?? '');
    if (!spec) {
      return false;
    }
    if (spec.variable ? argCount <= spec.numArgs : argCount === spec.numArgs) {
      return true;
    }
    argCount = 0;
  }

  return false;
}

function skipDctDecodeInlineImagePayload(bytes: Uint8Array, dataStart: number): number {
  let pos = dataStart;
  let foundEoi = false;

  while (pos < bytes.length) {
    const byte = bytes[pos++]!;
    if (byte !== 0xff) continue;
    if (pos >= bytes.length) break;
    const marker = bytes[pos++]!;
    if (marker === 0x00) continue;
    if (marker === 0xff) {
      pos -= 1;
      continue;
    }
    if (marker === 0xd9) {
      foundEoi = true;
      break;
    }
    if (JPEG_LENGTH_MARKERS.has(marker)) {
      if (pos + 2 > bytes.length) {
        throw new PdfSignError('Dữ liệu JPEG ảnh nội tuyến PDF bị cắt cụt');
      }
      const segLen = (bytes[pos]! << 8) | bytes[pos + 1]!;
      if (segLen < 2 || pos + segLen > bytes.length) {
        throw new PdfSignError('Độ dài đoạn JPEG ảnh nội tuyến PDF không hợp lệ');
      }
      pos += segLen;
    }
  }

  if (!foundEoi) {
    throw new PdfSignError('Luồng DCTDecode ảnh nội tuyến PDF thiếu dấu kết thúc JPEG EOI');
  }
  return expectTrailingEiToken(bytes, pos);
}

function skipDefaultInlineImagePayload(bytes: Uint8Array, dataStart: number): number {
  let lastCandidateEnd: number | undefined;
  let eiState = 0;

  for (let idx = dataStart; idx < bytes.length; idx += 1) {
    const ch = bytes[idx]!;
    if (eiState === 0) {
      eiState = ch === 0x45 ? 1 : 0;
    } else if (eiState === 1) {
      eiState = ch === 0x49 ? 2 : 0;
    } else {
      const isDelim = isInlineImageEiDelimiter(ch);
      eiState = 0;
      if (!isDelim) continue;
      const afterDelim = idx + 1;
      lastCandidateEnd = afterDelim;
      if (matchesPdfJsDefaultEiPreview(bytes, afterDelim) && matchesPdfJsDefaultEiOperators(bytes, afterDelim)) {
        return afterDelim;
      }
    }
  }

  if (lastCandidateEnd !== undefined) {
    return lastCandidateEnd;
  }
  throw new PdfSignError('Luồng ảnh nội tuyến PDF thiếu từ khóa kết thúc EI hợp lệ');
}

function skipInlineImagePayload(bytes: Uint8Array, afterBiPos: number): number {
  let pos = afterBiPos;
  let filterName: string | undefined;
  let sawFilterKey = false;
  let foundId = false;

  while (pos < bytes.length) {
    pos = skipInlineImageCommentAndWs(bytes, pos);
    if (pos >= bytes.length) break;
    const code = bytes[pos]!;
    if (code === 0x2f) {
      const nameStart = pos + 1;
      pos += 1;
      while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
        pos += 1;
      }
      const keyName = decodeAsciiPdfNameBytes(bytes, nameStart, pos);
      const isFilterKey = keyName === 'F' || keyName === 'Filter';
      if (isFilterKey && sawFilterKey) {
        throw new PdfSignError('Từ điển ảnh nội tuyến PDF chứa nhiều khóa bộ lọc (/F hoặc /Filter)');
      }
      const val = skipInlineImageValue(bytes, pos, 0, isFilterKey);
      pos = val.nextPos;
      if (isFilterKey) {
        sawFilterKey = true;
        filterName = val.filterName;
      }
      continue;
    }
    if (isPdfDelimiterCode(code)) {
      throw new PdfSignError('Cú pháp từ điển ảnh nội tuyến PDF không hợp lệ');
    }
    const tokStart = pos;
    while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
      pos += 1;
    }
    if (pos - tokStart === 2 && bytes[tokStart] === 0x49 && bytes[tokStart + 1] === 0x44) {
      foundId = true;
      break;
    }
    throw new PdfSignError('Khóa không hợp lệ trong từ điển ảnh nội tuyến PDF');
  }

  if (!foundId || pos >= bytes.length) {
    throw new PdfSignError('Luồng ảnh nội tuyến PDF thiếu dấu phân tách ID');
  }
  if (!isPdfWhitespaceCode(bytes[pos]!)) {
    throw new PdfSignError('Từ khóa ID trong ảnh nội tuyến PDF phải theo sau bởi khoảng trắng');
  }
  pos += 1;

  if (filterName === 'AHx' || filterName === 'ASCIIHexDecode') {
    while (pos < bytes.length) {
      const ch = bytes[pos++]!;
      if (ch === 0x3e) {
        return expectTrailingEiToken(bytes, pos);
      }
      if (!isPdfWhitespaceCode(ch) && !isAsciiHexByte(ch)) {
        throw new PdfSignError('Dữ liệu ASCIIHexDecode trong ảnh nội tuyến PDF không hợp lệ');
      }
    }
    throw new PdfSignError('Luồng ASCIIHexDecode trong ảnh nội tuyến PDF thiếu ký tự kết thúc');
  }

  if (filterName === 'A85' || filterName === 'ASCII85Decode') {
    while (pos < bytes.length) {
      const ch = bytes[pos++]!;
      if (ch === 0x7e) {
        while (pos < bytes.length && isPdfWhitespaceCode(bytes[pos]!)) {
          pos += 1;
        }
        if (pos < bytes.length && bytes[pos] === 0x3e) {
          return expectTrailingEiToken(bytes, pos + 1);
        }
        throw new PdfSignError('Dữ liệu ASCII85Decode trong ảnh nội tuyến PDF không hợp lệ');
      }
      if (!isPdfWhitespaceCode(ch) && ch !== 0x7a && (ch < 0x21 || ch > 0x75)) {
        throw new PdfSignError('Dữ liệu ASCII85Decode trong ảnh nội tuyến PDF không hợp lệ');
      }
    }
    throw new PdfSignError('Luồng ASCII85Decode trong ảnh nội tuyến PDF thiếu dấu ~> kết thúc');
  }

  if (filterName === 'DCT' || filterName === 'DCTDecode') {
    return skipDctDecodeInlineImagePayload(bytes, pos);
  }

  return skipDefaultInlineImagePayload(bytes, pos);
}

interface ContentStreamBalanceResult {
  readonly minDepth: number;
  readonly finalDepth: number;
  readonly minMcDepth: number;
  readonly finalMcDepth: number;
  readonly minTextDepth: number;
  readonly maxTextDepth: number;
  readonly finalTextDepth: number;
  readonly minCompatDepth: number;
  readonly finalCompatDepth: number;
  readonly endedInComment: boolean;
  readonly ops: readonly string[];
}

function inspectContentStreamGraphicsBalance(bytes: Uint8Array): ContentStreamBalanceResult {
  let pos = 0;
  let depth = 0;
  let minDepth = 0;
  let markedContentDepth = 0;
  let minMcDepth = 0;
  let textDepth = 0;
  let minTextDepth = 0;
  let maxTextDepth = 0;
  let compatDepth = 0;
  let minCompatDepth = 0;
  let arrayDepth = 0;
  let dictDepth = 0;
  let endedInComment = false;
  const ops: string[] = [];

  while (pos < bytes.length) {
    const code = bytes[pos]!;
    if (isPdfWhitespaceCode(code)) {
      pos += 1;
      continue;
    }
    if (code === 0x25) {
      pos += 1;
      let closedLine = false;
      while (pos < bytes.length) {
        const ch = bytes[pos++]!;
        if (ch === 0x0a || ch === 0x0d) {
          closedLine = true;
          break;
        }
      }
      if (!closedLine) {
        endedInComment = true;
      }
      continue;
    }
    if (code === 0x28) {
      pos = skipContentLiteralStringBytes(bytes, pos + 1);
      continue;
    }
    if (code === 0x3c) {
      if (pos + 1 < bytes.length && bytes[pos + 1] === 0x3c) {
        dictDepth += 1;
        if (dictDepth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
          throw new PdfSignError('Độ sâu từ điển trong luồng nội dung PDF vượt giới hạn');
        }
        pos += 2;
        continue;
      }
      pos = skipContentHexStringBytes(bytes, pos + 1);
      continue;
    }
    if (code === 0x3e) {
      if (pos + 1 < bytes.length && bytes[pos + 1] === 0x3e) {
        dictDepth -= 1;
        if (dictDepth < 0) {
          throw new PdfSignError('Cấu trúc từ điển trong luồng nội dung PDF không hợp lệ');
        }
        pos += 2;
        continue;
      }
      throw new PdfSignError('Dấu đóng chuỗi hex không khớp trong luồng nội dung PDF');
    }
    if (code === 0x5b) {
      arrayDepth += 1;
      if (arrayDepth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
        throw new PdfSignError('Độ sâu mảng trong luồng nội dung PDF vượt giới hạn');
      }
      pos += 1;
      continue;
    }
    if (code === 0x5d) {
      arrayDepth -= 1;
      if (arrayDepth < 0) {
        throw new PdfSignError('Cấu trúc mảng trong luồng nội dung PDF không hợp lệ');
      }
      pos += 1;
      continue;
    }
    if (code === 0x2f) {
      pos += 1;
      while (pos < bytes.length && !isPdfWhitespaceCode(bytes[pos]!) && !isPdfDelimiterCode(bytes[pos]!)) {
        pos += 1;
      }
      continue;
    }
    if (isPdfDelimiterCode(code)) {
      if (code === 0x29) {
        throw new PdfSignError('Dấu ngoặc đóng chuỗi không khớp trong luồng nội dung PDF');
      }
      pos += 1;
      continue;
    }

    if (isPdfNumberStartCode(code)) {
      const numTok = readPdfJsNumberToken(bytes, pos, bytes.length);
      if (numTok.kind === 'error') {
        throw new PdfSignError('Toán hạng số không hợp lệ trong luồng nội dung PDF');
      }
      pos = numTok.nextPos;
      continue;
    }

    const cmdTok = readPdfJsCommandToken(bytes, pos, bytes.length);
    if (cmdTok.kind === 'error') {
      throw new PdfSignError('Toán tử quá dài trong luồng nội dung PDF');
    }
    pos = cmdTok.nextPos;
    if (cmdTok.kind === 'value' || arrayDepth !== 0 || dictDepth !== 0) {
      continue;
    }
    const cmd = cmdTok.cmd ?? '';
    if (cmd === 'q') {
      ops.push(cmd);
      depth += 1;
      if (depth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
        throw new PdfSignError('Ngăn xếp trạng thái đồ họa PDF vượt quá giới hạn');
      }
    } else if (cmd === 'Q') {
      ops.push(cmd);
      depth -= 1;
      if (depth < minDepth) minDepth = depth;
    } else if (cmd === 'BI') {
      pos = skipInlineImagePayload(bytes, pos);
    } else if (cmd === 'EI') {
      throw new PdfSignError('Từ khóa EI không khớp trong luồng nội dung PDF');
    } else if (cmd === 'BT') {
      ops.push(cmd);
      textDepth += 1;
      if (textDepth > maxTextDepth) maxTextDepth = textDepth;
    } else if (cmd === 'ET') {
      ops.push(cmd);
      textDepth -= 1;
      if (textDepth < minTextDepth) minTextDepth = textDepth;
    } else if (cmd === 'BX') {
      ops.push(cmd);
      compatDepth += 1;
      if (compatDepth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
        throw new PdfSignError('Khối tương thích BX/EX trong luồng nội dung PDF vượt quá giới hạn');
      }
    } else if (cmd === 'EX') {
      ops.push(cmd);
      compatDepth -= 1;
      if (compatDepth < minCompatDepth) minCompatDepth = compatDepth;
    } else if (cmd === 'BMC' || cmd === 'BDC') {
      ops.push(cmd);
      markedContentDepth += 1;
      if (markedContentDepth > MAX_CONTENT_STREAM_NESTING_DEPTH) {
        throw new PdfSignError('Ngăn xếp nội dung đánh dấu (BMC/BDC/EMC) PDF vượt quá giới hạn');
      }
    } else if (cmd === 'EMC') {
      ops.push(cmd);
      markedContentDepth -= 1;
      if (markedContentDepth < minMcDepth) minMcDepth = markedContentDepth;
    }
  }

  if (arrayDepth !== 0 || dictDepth !== 0) {
    throw new PdfSignError('Cấu trúc mảng hoặc từ điển không đóng trong luồng nội dung PDF');
  }
  return {
    minDepth,
    finalDepth: depth,
    minMcDepth,
    finalMcDepth: markedContentDepth,
    minTextDepth,
    maxTextDepth,
    finalTextDepth: textDepth,
    minCompatDepth,
    finalCompatDepth: compatDepth,
    endedInComment,
    ops,
  };
}

function decodeContentStreamBytes(
  pdfDoc: PDFDocument,
  stream: PDFStream,
  budget: ContentStreamDecodeBudget,
  emptyContext: PDFContext,
): Uint8Array {
  if (budget.remainingBytes <= 0) {
    throw new PdfSignError('Tổng kích thước luồng nội dung giải nén PDF vượt giới hạn');
  }
  let decoded: Uint8Array;
  if (stream instanceof PDFRawStream) {
    decoded = decodePdfStreamApplyingPredictor(
      stream,
      emptyContext,
      budget.remainingBytes,
      'Không giải nén được luồng nội dung PDF',
      null,
      pdfDoc.context,
    );
  } else {
    const maybeContent = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
    if (typeof maybeContent.getUnencodedContents !== 'function') {
      throw new PdfSignError('Luồng nội dung PDF không ở định dạng hợp lệ');
    }
    decoded = maybeContent.getUnencodedContents();
  }
  budget.remainingBytes -= decoded.byteLength;
  if (budget.remainingBytes < 0) {
    throw new PdfSignError('Tổng kích thước luồng nội dung giải nén PDF vượt giới hạn');
  }
  return decoded;
}

function assertBalancedContentBytes(bytes: Uint8Array): ContentStreamBalanceResult {
  const state = inspectContentStreamGraphicsBalance(bytes);
  if (state.minDepth < 0 || state.finalDepth !== 0) {
    throw new PdfSignError('Luồng nội dung PDF có ngăn xếp trạng thái đồ họa (q/Q) không cân bằng');
  }
  if (state.minMcDepth < 0 || state.finalMcDepth !== 0) {
    throw new PdfSignError('Luồng nội dung PDF có vùng nội dung đánh dấu (BMC/BDC/EMC) không cân bằng');
  }
  if (state.minTextDepth < 0 || state.maxTextDepth > 1 || state.finalTextDepth !== 0) {
    throw new PdfSignError('Luồng nội dung PDF có khối văn bản (BT/ET) không cân bằng hoặc lồng nhau');
  }
  if (state.minCompatDepth < 0 || state.finalCompatDepth !== 0) {
    throw new PdfSignError('Luồng nội dung PDF có khối tương thích (BX/EX) không cân bằng');
  }
  return state;
}

function assertBalancedContentSegments(segments: readonly Uint8Array[], totalLen: number): void {
  if (segments.length === 0) return;
  if (segments.length === 1) {
    assertBalancedContentBytes(segments[0]!);
    return;
  }

  let prevNonEmpty: Uint8Array | null = null;
  let prevEndedInComment = false;
  for (const seg of segments) {
    if (seg.byteLength === 0) continue;
    if (prevNonEmpty !== null) {
      const first = seg[0]!;
      if (prevEndedInComment && first !== 0x0a && first !== 0x0d) {
        throw new PdfSignError('Luồng nội dung PDF kết thúc trong chú thích trước đoạn tiếp theo');
      }
      const last = prevNonEmpty[prevNonEmpty.byteLength - 1]!;
      const prevLeavesTokenOpen =
        (!isPdfWhitespaceCode(last) && !isPdfDelimiterCode(last)) || last === 0x2f;
      const currStartsToken = !isPdfWhitespaceCode(first) && !isPdfDelimiterCode(first);
      if (prevLeavesTokenOpen && currStartsToken) {
        throw new PdfSignError('Các đoạn luồng nội dung /Contents ghép nối toán tử qua ranh giới không hợp lệ');
      }
    }
    const segState = inspectContentStreamGraphicsBalance(seg);
    prevNonEmpty = seg;
    prevEndedInComment = segState.endedInComment;
  }

  const rawState = assertBalancedContentBytes(joinContentSegments(segments, totalLen));
  const sepState = assertBalancedContentBytes(joinContentSegments(segments, totalLen, 0x0a));
  if (
    rawState.ops.length !== sepState.ops.length ||
    rawState.ops.some((op, idx) => op !== sepState.ops[idx])
  ) {
    throw new PdfSignError('Chuỗi toán tử đồ họa /Contents không đồng nhất qua ranh giới luồng');
  }
}

interface GraphicsBalanceVisitState {
  readonly streams: Set<PDFStream>;
  readonly resourceDicts: Set<PDFDict>;
  readonly type3Fonts: Set<PDFDict>;
  readonly extGStates: Set<PDFDict>;
}

interface GraphicsBalanceValidationContext {
  readonly visited: GraphicsBalanceVisitState;
  readonly budget: ContentStreamDecodeBudget;
  readonly emptyContext: PDFContext;
}

function createGraphicsBalanceVisitState(): GraphicsBalanceVisitState {
  return {
    streams: new Set<PDFStream>(),
    resourceDicts: new Set<PDFDict>(),
    type3Fonts: new Set<PDFDict>(),
    extGStates: new Set<PDFDict>(),
  };
}

function createGraphicsBalanceValidationContext(): GraphicsBalanceValidationContext {
  return {
    visited: createGraphicsBalanceVisitState(),
    budget: { remainingBytes: EXTRACT_LIMITS.maxFileBytes * 4 },
    emptyContext: PDFContext.create(),
  };
}

function assertGraphicsBalanceNodeBudget(visited: GraphicsBalanceVisitState): void {
  const total =
    visited.streams.size +
    visited.resourceDicts.size +
    visited.type3Fonts.size +
    visited.extGStates.size;
  if (total > MAX_PDF_GRAPH_NODES) {
    throw new PdfSignError('Số lượng đối tượng tài nguyên PDF vượt quá giới hạn kiểm tra');
  }
}

function validateType3FontGraphicsBalance(
  pdfDoc: PDFDocument,
  fontObj: PDFDict,
  visited: GraphicsBalanceVisitState,
  budget: ContentStreamDecodeBudget,
  emptyContext: PDFContext,
): void {
  if (visited.type3Fonts.has(fontObj)) return;
  const subtypeObj = lookupDictEntryByDecodedName(pdfDoc, fontObj, 'Subtype')?.resolved;
  const isType3 = subtypeObj instanceof PDFName && decodePdfName(subtypeObj) === 'Type3';
  const charProcsEntry = lookupDictEntryByDecodedName(pdfDoc, fontObj, 'CharProcs');
  if (!isType3 && charProcsEntry === undefined) return;

  visited.type3Fonts.add(fontObj);
  assertGraphicsBalanceNodeBudget(visited);
  if (charProcsEntry !== undefined && charProcsEntry.resolved !== PDFNull) {
    if (!(charProcsEntry.resolved instanceof PDFDict)) {
      throw new PdfSignError('Phông chữ Type3 trong PDF có /CharProcs không hợp lệ');
    }
    for (const [, charRaw] of charProcsEntry.resolved.entries()) {
      const charObj = pdfDoc.context.lookup(charRaw);
      if (charObj === undefined || charObj === PDFNull) continue;
      if (!(charObj instanceof PDFStream)) {
        throw new PdfSignError('Luồng ký tự /CharProcs của phông chữ Type3 không hợp lệ');
      }
      validateFormXObjectGraphicsTree(pdfDoc, charObj, visited, budget, emptyContext);
    }
  }
  const fontResources = lookupDictEntryByDecodedName(pdfDoc, fontObj, 'Resources')?.resolved;
  if (fontResources !== undefined) {
    validateResourcesFormXObjectsGraphicsBalance(
      pdfDoc,
      fontResources,
      visited,
      budget,
      emptyContext,
    );
  }
}

function validateResourcesFormXObjectsGraphicsBalance(
  pdfDoc: PDFDocument,
  resourcesObj: unknown,
  visited: GraphicsBalanceVisitState,
  budget: ContentStreamDecodeBudget,
  emptyContext: PDFContext,
): void {
  if (!(resourcesObj instanceof PDFDict)) return;
  if (visited.resourceDicts.has(resourcesObj)) return;
  visited.resourceDicts.add(resourcesObj);
  assertGraphicsBalanceNodeBudget(visited);

  const xObjectDict = lookupDictEntryByDecodedName(pdfDoc, resourcesObj, 'XObject')?.resolved;
  if (xObjectDict instanceof PDFDict) {
    for (const [, childRaw] of xObjectDict.entries()) {
      const childObj = pdfDoc.context.lookup(childRaw);
      if (!(childObj instanceof PDFStream)) continue;
      const subtypeObj = lookupDictEntryByDecodedName(pdfDoc, childObj.dict, 'Subtype')?.resolved;
      if (subtypeObj instanceof PDFName && decodePdfName(subtypeObj) === 'Form') {
        validateFormXObjectGraphicsTree(pdfDoc, childObj, visited, budget, emptyContext);
      }
    }
  }

  const fontDict = lookupDictEntryByDecodedName(pdfDoc, resourcesObj, 'Font')?.resolved;
  if (fontDict instanceof PDFDict) {
    for (const [, fontRaw] of fontDict.entries()) {
      const fontObj = pdfDoc.context.lookup(fontRaw);
      if (fontObj instanceof PDFDict) {
        validateType3FontGraphicsBalance(pdfDoc, fontObj, visited, budget, emptyContext);
      }
    }
  }

  const patternDict = lookupDictEntryByDecodedName(pdfDoc, resourcesObj, 'Pattern')?.resolved;
  if (patternDict instanceof PDFDict) {
    for (const [, patRaw] of patternDict.entries()) {
      const patObj = pdfDoc.context.lookup(patRaw);
      if (patObj instanceof PDFStream) {
        validateFormXObjectGraphicsTree(pdfDoc, patObj, visited, budget, emptyContext);
      }
    }
  }

  const extGStateDict = lookupDictEntryByDecodedName(pdfDoc, resourcesObj, 'ExtGState')?.resolved;
  if (extGStateDict instanceof PDFDict) {
    for (const [, gsRaw] of extGStateDict.entries()) {
      const gsObj = pdfDoc.context.lookup(gsRaw);
      if (!(gsObj instanceof PDFDict) || visited.extGStates.has(gsObj)) continue;
      visited.extGStates.add(gsObj);
      assertGraphicsBalanceNodeBudget(visited);

      const smaskObj = lookupDictEntryByDecodedName(pdfDoc, gsObj, 'SMask')?.resolved;
      if (smaskObj instanceof PDFDict) {
        const groupObj = lookupDictEntryByDecodedName(pdfDoc, smaskObj, 'G')?.resolved;
        if (groupObj instanceof PDFStream) {
          validateFormXObjectGraphicsTree(pdfDoc, groupObj, visited, budget, emptyContext);
        }
      }

      const gsFontObj = lookupDictEntryByDecodedName(pdfDoc, gsObj, 'Font')?.resolved;
      const gsFontDict =
        gsFontObj instanceof PDFArray && gsFontObj.size() >= 1
          ? pdfDoc.context.lookup(gsFontObj.get(0))
          : gsFontObj;
      if (gsFontDict instanceof PDFDict) {
        validateType3FontGraphicsBalance(pdfDoc, gsFontDict, visited, budget, emptyContext);
      }
    }
  }
}

function validateFormXObjectGraphicsTree(
  pdfDoc: PDFDocument,
  stream: PDFStream,
  visited: GraphicsBalanceVisitState,
  budget: ContentStreamDecodeBudget,
  emptyContext: PDFContext,
): void {
  if (visited.streams.has(stream)) return;
  visited.streams.add(stream);
  assertGraphicsBalanceNodeBudget(visited);
  const decoded = decodeContentStreamBytes(pdfDoc, stream, budget, emptyContext);
  assertBalancedContentBytes(decoded);
  const resourcesObj = lookupDictEntryByDecodedName(pdfDoc, stream.dict, 'Resources')?.resolved;
  if (resourcesObj !== undefined) {
    validateResourcesFormXObjectsGraphicsBalance(pdfDoc, resourcesObj, visited, budget, emptyContext);
  }
}

function joinContentSegments(
  segments: readonly Uint8Array[],
  totalLen: number,
  separatorByte?: number,
): Uint8Array {
  const sepCount = separatorByte !== undefined ? segments.length - 1 : 0;
  const combined = new Uint8Array(totalLen + sepCount);
  let offset = 0;
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0 && separatorByte !== undefined) {
      combined[offset] = separatorByte;
      offset += 1;
    }
    const seg = segments[i]!;
    combined.set(seg, offset);
    offset += seg.byteLength;
  }
  return combined;
}

function validatePageContentsAndXObjectsGraphicsBalance(
  pdfDoc: PDFDocument,
  visited: GraphicsBalanceVisitState,
  budget: ContentStreamDecodeBudget,
  emptyContext: PDFContext,
): void {
  for (const page of pdfDoc.getPages()) {
    const contentsEntry = lookupDictEntryByDecodedName(pdfDoc, page.node, 'Contents');
    if (contentsEntry && contentsEntry.resolved !== PDFNull) {
      if (contentsEntry.resolved instanceof PDFStream) {
        const decoded = decodeContentStreamBytes(pdfDoc, contentsEntry.resolved, budget, emptyContext);
        assertBalancedContentBytes(decoded);
      } else if (contentsEntry.resolved instanceof PDFArray) {
        if (contentsEntry.resolved.size() > MAX_PAGE_CONTENT_STREAMS) {
          throw new PdfSignError('Trang PDF chứa quá nhiều đoạn luồng nội dung /Contents');
        }
        const segments: Uint8Array[] = [];
        let totalLen = 0;
        for (let i = 0; i < contentsEntry.resolved.size(); i += 1) {
          const item = pdfDoc.context.lookup(contentsEntry.resolved.get(i));
          if (!(item instanceof PDFStream)) {
            throw new PdfSignError('Mảng /Contents của trang PDF chứa phần tử không hợp lệ');
          }
          const decoded = decodeContentStreamBytes(pdfDoc, item, budget, emptyContext);
          segments.push(decoded);
          totalLen += decoded.byteLength;
        }
        assertBalancedContentSegments(segments, totalLen);
      } else {
        throw new PdfSignError('Cấu trúc /Contents của trang PDF không hợp lệ');
      }
    }

    const resourcesObj = lookupInheritedDictEntry(pdfDoc, page.node, 'Resources')?.resolved;
    if (resourcesObj !== undefined) {
      validateResourcesFormXObjectsGraphicsBalance(
        pdfDoc,
        resourcesObj,
        visited,
        budget,
        emptyContext,
      );
    }
  }
}

function drawAppearanceStreamToPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  pageOneBased: number,
  isolatedPages: Set<number>,
  apRef: PDFRef,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  xObjectTag: string,
  rot: PageRotation = 0,
  noRotate = false,
  graphicsValidation?: GraphicsBalanceValidationContext,
): boolean {
  const apObj = pdfDoc.context.lookup(apRef);
  if (apObj instanceof PDFStream && !isOptionalContentVisible(pdfDoc, apObj.dict)) {
    return true;
  }
  if (apObj instanceof PDFStream) {
    if (!isValidAppearanceFormSubtype(pdfDoc, apObj)) {
      return false;
    }
    if (graphicsValidation) {
      validateFormXObjectGraphicsTree(
        pdfDoc,
        apObj,
        graphicsValidation.visited,
        graphicsValidation.budget,
        graphicsValidation.emptyContext,
      );
    } else {
      validateFormXObjectGraphicsTree(
        pdfDoc,
        apObj,
        createGraphicsBalanceVisitState(),
        { remainingBytes: EXTRACT_LIMITS.maxFileBytes * 4 },
        PDFContext.create(),
      );
    }
  }
  const transform = computeAppearanceTransform(pdfDoc, apRef, rect, rot, noRotate);
  if (!transform) return false;
  const frozen = freezeFlattenedAppearanceStream(pdfDoc, apRef);
  if (frozen.status === 'hidden') {
    return true;
  }
  const formRef = ensureAppearanceFormSubtype(pdfDoc, frozen.ref);
  ensurePageStateIsolated(pdfDoc, page, pageOneBased, isolatedPages);
  const xObjectKey = page.node.newXObject(xObjectTag, formRef);
  const { clipRect, cm } = transform;
  page.pushOperators(
    pushGraphicsState(),
    rectangle(clipRect.x, clipRect.y, clipRect.width, clipRect.height),
    clip(),
    endPath(),
    concatTransformationMatrix(cm[0], cm[1], cm[2], cm[3], cm[4], cm[5]),
    drawObject(xObjectKey),
    popGraphicsState(),
  );
  return true;
}

function readPdfNumberArray(pdfDoc: PDFDocument, obj: unknown, expectedLength: number): number[] | null {
  if (!(obj instanceof PDFArray) || obj.size() !== expectedLength) return null;
  const out: number[] = [];
  for (let i = 0; i < expectedLength; i++) {
    const item = pdfDoc.context.lookup(obj.get(i));
    if (!(item instanceof PDFNumber)) return null;
    const val = item.asNumber();
    if (!Number.isFinite(val)) return null;
    out.push(val);
  }
  return out;
}

function computeAppearanceTransformFromStream(
  pdfDoc: PDFDocument,
  apObj: PDFStream,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rot: PageRotation = 0,
  noRotate = false,
): {
  readonly cm: readonly [number, number, number, number, number, number];
  readonly clipRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
} | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  const bboxRaw = lookupDictEntryByDecodedName(pdfDoc, apObj.dict, 'BBox')?.resolved;
  const bbox = readPdfNumberArray(pdfDoc, bboxRaw, 4) ?? [0, 0, rect.width, rect.height];
  const [llx = 0, lly = 0, urx = rect.width, ury = rect.height] = bbox;

  const matrixRaw = lookupDictEntryByDecodedName(pdfDoc, apObj.dict, 'Matrix')?.resolved;
  const matrix = readPdfNumberArray(pdfDoc, matrixRaw, 6) ?? [1, 0, 0, 1, 0, 0];
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;

  const corners = [
    [llx, lly],
    [urx, lly],
    [llx, ury],
    [urx, ury],
  ] as const;

  let appMinX = Number.POSITIVE_INFINITY;
  let appMaxX = Number.NEGATIVE_INFINITY;
  let appMinY = Number.POSITIVE_INFINITY;
  let appMaxY = Number.NEGATIVE_INFINITY;
  for (const [bx, by] of corners) {
    const tx = a * bx + c * by + e;
    const ty = b * bx + d * by + f;
    if (tx < appMinX) appMinX = tx;
    if (tx > appMaxX) appMaxX = tx;
    if (ty < appMinY) appMinY = ty;
    if (ty > appMaxY) appMaxY = ty;
  }

  const appW = appMaxX - appMinX;
  const appH = appMaxY - appMinY;
  if (!Number.isFinite(appW) || !Number.isFinite(appH) || appW <= 0 || appH <= 0) {
    return null;
  }

  const sx = rect.width / appW;
  const sy = rect.height / appH;
  const basis = getAnnotationBasis(rect, rot, noRotate);
  const cmA = sx * basis.ux;
  const cmB = sx * basis.uy;
  const cmC = sy * basis.vx;
  const cmD = sy * basis.vy;
  const cmE = basis.blX - cmA * appMinX - cmC * appMinY;
  const cmF = basis.blY - cmB * appMinX - cmD * appMinY;
  if (![cmA, cmB, cmC, cmD, cmE, cmF].every(Number.isFinite)) {
    return null;
  }
  return {
    cm: [cmA, cmB, cmC, cmD, cmE, cmF],
    clipRect: basis.clipRect,
  };
}

function computeAppearanceTransform(
  pdfDoc: PDFDocument,
  apRef: PDFRef,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rot: PageRotation = 0,
  noRotate = false,
): {
  readonly cm: readonly [number, number, number, number, number, number];
  readonly clipRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
} | null {
  const apObj = pdfDoc.context.lookup(apRef);
  if (!(apObj instanceof PDFStream)) return null;
  return computeAppearanceTransformFromStream(pdfDoc, apObj, rect, rot, noRotate);
}

function scrubSecretKeysFromDict(dict: PDFDict): void {
  // Unlink secret keys on the password dict and let pruneUnreferencedIndirectObjects
  // drop any now-unreachable indirect objects so shared /AP streams used by surviving
  // flattened widgets or annotations never become dangling references.
  for (const secretKey of ['V', 'DV', 'RV', 'AP']) {
    deleteDictKeysByDecodedName(dict, secretKey);
  }
}

function collectPasswordParentAncestors(
  pdfDoc: PDFDocument,
  startDict: PDFDict,
  ancestorDicts: Set<PDFDict>,
  ancestorRefs: Set<PDFRef>,
): void {
  let current: PDFDict | undefined = startDict;
  const visited = new Set<PDFDict>();
  while (current && !visited.has(current) && visited.size < 32) {
    visited.add(current);
    const parentEntry = lookupDictEntryByDecodedName(pdfDoc, current, 'Parent');
    if (!parentEntry) break;
    if (parentEntry.raw instanceof PDFRef) {
      ancestorRefs.add(parentEntry.raw);
    }
    const parentObj: unknown = parentEntry.resolved;
    if (!(parentObj instanceof PDFDict)) break;
    ancestorDicts.add(parentObj);
    current = parentObj;
  }
}

function deletePasswordFieldSecretRefs(
  pdfDoc: PDFDocument,
  field: PDFTextField,
  widgets: ReturnType<PDFField['acroField']['getWidgets']>,
  ancestorDicts: Set<PDFDict>,
  ancestorRefs: Set<PDFRef>,
): void {
  collectPasswordParentAncestors(pdfDoc, field.acroField.dict, ancestorDicts, ancestorRefs);
  scrubSecretKeysFromDict(field.acroField.dict);
  for (const widget of widgets) {
    scrubSecretKeysFromDict(widget.dict);
  }
}

function scrubRemainingAcroFormPasswordNodes(pdfDoc: PDFDocument, acroDict: PDFDict | undefined): void {
  if (!acroDict) return;
  const fieldsEntry = lookupDictEntryByDecodedName(pdfDoc, acroDict, 'Fields');
  if (!fieldsEntry) return;

  const visited = new Set<object>();
  const stack: Array<{ readonly raw: unknown; readonly inheritedPassword: boolean }> = [
    { raw: fieldsEntry.raw, inheritedPassword: false },
  ];
  let steps = 0;

  while (stack.length > 0 && steps < MAX_PDF_GRAPH_NODES) {
    steps++;
    const item = stack.pop();
    if (!item) continue;
    const { raw, inheritedPassword } = item;
    const resolved: unknown = raw instanceof PDFRef ? pdfDoc.context.lookup(raw) : raw;
    if (!resolved || typeof resolved !== 'object' || visited.has(resolved)) continue;
    visited.add(resolved);

    if (resolved instanceof PDFArray) {
      const size = resolved.size();
      for (let i = 0; i < size; i++) {
        stack.push({ raw: resolved.get(i), inheritedPassword });
      }
      continue;
    }
    if (!(resolved instanceof PDFDict)) continue;

    const isPasswordNode = inheritedPassword || hasInheritedPasswordFlag(pdfDoc, resolved);
    const kidsEntry = lookupDictEntryByDecodedName(pdfDoc, resolved, 'Kids');
    if (kidsEntry?.raw !== undefined) {
      stack.push({ raw: kidsEntry.raw, inheritedPassword: isPasswordNode });
    }
    if (isPasswordNode) {
      scrubSecretKeysFromDict(resolved);
      if (raw instanceof PDFRef) {
        pdfDoc.context.delete(raw);
      }
    }
  }
}

function getWidgetNormalAppearance(
  pdfDoc: PDFDocument,
  widget: ReturnType<PDFField['acroField']['getWidgets']>[number],
): PDFRef | PDFDict | undefined {
  const apEntry = lookupDictEntryByDecodedName(pdfDoc, widget.dict, 'AP');
  if (!(apEntry?.resolved instanceof PDFDict)) return undefined;
  const normalEntry = lookupDictEntryByDecodedName(pdfDoc, apEntry.resolved, 'N');
  if (!normalEntry) return undefined;
  if (normalEntry.resolved instanceof PDFDict) return normalEntry.resolved;
  if (normalEntry.raw instanceof PDFRef) return normalEntry.raw;
  return undefined;
}

interface PreparedWidgetPlan {
  readonly fallbackPage: PDFPage;
  readonly fallbackPageOneBased: number;
  readonly render: (targetPage: PDFPage, pageOneBased: number) => Promise<void>;
}

interface PasswordFieldCleanupTarget {
  readonly field: PDFTextField;
  readonly widgets: ReturnType<PDFField['acroField']['getWidgets']>;
}

interface PreparedAcroFormWork {
  readonly acroDict: PDFDict | undefined;
  readonly form: PDFForm | undefined;
  readonly widgetRenderers: Map<PDFDict, PreparedWidgetPlan>;
  readonly fieldsToRemove: readonly PDFField[];
  readonly passwordFieldsToScrub: readonly PasswordFieldCleanupTarget[];
}

const ACRO_FLAG_RADIOS_IN_UNISON = 1 << 25;

interface CheckOrRadioPreState {
  readonly preAsName: string | undefined;
  readonly isCheckedBeforeRegen: boolean;
}

function readWidgetRect(
  pdfDoc: PDFDocument,
  widgetDict: PDFDict,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const rect = readNormalizedPdfRect(pdfDoc, widgetDict);
  if (!rect) {
    throw new PdfSignError('Tệp PDF chứa trường biểu mẫu thiếu khung tọa độ hợp lệ');
  }
  return rect;
}

function decodePdfNameValue(obj: unknown): string | undefined {
  return obj instanceof PDFName ? decodePdfName(obj) : undefined;
}

function resolveCheckOrRadioPreStates(
  pdfDoc: PDFDocument,
  field: PDFCheckBox | PDFRadioGroup,
  widgets: ReturnType<PDFField['acroField']['getWidgets']>,
  preFieldValName: string | undefined,
  hasExplicitFieldValue = preFieldValName !== undefined,
): readonly CheckOrRadioPreState[] {
  const optEntry = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'Opt')?.resolved;
  const optExportValues: Array<string | undefined> = [];
  if (optEntry instanceof PDFArray) {
    for (let i = 0; i < optEntry.size(); i++) {
      const resolved = pdfDoc.context.lookup(optEntry.get(i));
      optExportValues.push(
        resolved instanceof PDFString || resolved instanceof PDFHexString ? resolved.decodeText() : undefined,
      );
    }
  }
  const fieldFfResolved = lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'Ff')?.resolved;
  const fieldFlags = fieldFfResolved instanceof PDFNumber ? fieldFfResolved.asNumber() : 0;
  const radiosInUnison = field instanceof PDFRadioGroup && (fieldFlags & ACRO_FLAG_RADIOS_IN_UNISON) !== 0;

  const widgetMeta = widgets.map((w) => {
    const widgetHidden = isAnnotationHidden(pdfDoc, w.dict);
    const preAsName = decodePdfNameValue(lookupDictEntryByDecodedName(pdfDoc, w.dict, 'AS')?.resolved);
    const preAp = getWidgetNormalAppearance(pdfDoc, w);
    const preApOnNames = new Set<string>();
    let hadPreApDict = false;
    if (preAp instanceof PDFDict) {
      hadPreApDict = true;
      for (const [k] of preAp.entries()) {
        const decoded = decodePdfName(k);
        if (decoded !== 'Off') preApOnNames.add(decoded);
      }
    }
    return { widgetHidden, preAsName, hadPreApDict, preApOnNames };
  });

  const hasActiveFieldVal = preFieldValName !== undefined && preFieldValName !== 'Off';
  const selectedOptIdx = (() => {
    if (!hasActiveFieldVal || !(optEntry instanceof PDFArray) || !/^(?:0|[1-9]\d*)$/.test(preFieldValName)) {
      return undefined;
    }
    const selectedIdx = Number(preFieldValName);
    if (selectedIdx >= widgets.length) {
      if (field instanceof PDFRadioGroup) {
        throw new PdfSignError('Trường nút chọn radio trỏ tới chỉ mục ngoài phạm vi');
      }
      return undefined;
    }
    return selectedIdx < optEntry.size() ? selectedIdx : undefined;
  })();

  const isOptIndexSelected = (wi: number): boolean => {
    if (selectedOptIdx === undefined) return false;
    if (wi === selectedOptIdx) return true;
    return (
      radiosInUnison &&
      optExportValues[wi] !== undefined &&
      optExportValues[wi] === optExportValues[selectedOptIdx]
    );
  };

  const isWidgetActiveAsConsistent = (wi: number, meta: (typeof widgetMeta)[number]): boolean => {
    if (!hasActiveFieldVal || meta.preAsName === undefined || meta.preAsName === 'Off') {
      return false;
    }
    if (meta.preAsName === preFieldValName) {
      return selectedOptIdx === undefined || isOptIndexSelected(wi);
    }
    // With /Opt index /V (e.g. /1), allow the selected widget's custom ON state (e.g. /ChoiceB) if /1 is absent from /AP /N.
    return (
      selectedOptIdx !== undefined &&
      isOptIndexSelected(wi) &&
      !meta.preApOnNames.has(preFieldValName) &&
      !/^(?:0|[1-9]\d*)$/.test(meta.preAsName)
    );
  };

  const matchingAsCount = hasActiveFieldVal
    ? widgetMeta.filter((m) => m.preAsName === preFieldValName).length
    : 0;
  const consistentActiveAsCount = hasActiveFieldVal
    ? widgetMeta.filter((m, wi) => isWidgetActiveAsConsistent(wi, m)).length
    : 0;
  const matchingApCount = hasActiveFieldVal
    ? widgetMeta.filter((m) => m.hadPreApDict && m.preApOnNames.has(preFieldValName)).length
    : 0;
  const allVisibleHaveExplicitAs = widgetMeta.every((m) => m.widgetHidden || m.preAsName !== undefined);

  const preWidgetStates = widgetMeta.map((meta, wi) => {
    if (!meta.widgetHidden) {
      if (meta.preAsName !== undefined && meta.preAsName !== 'Off' && meta.hadPreApDict && !meta.preApOnNames.has(meta.preAsName)) {
        throw new PdfSignError(
          'Trường nút chọn chứa trạng thái hiển thị /AS không khớp bảng /AP nên không thể làm phẳng an toàn',
        );
      }
      if (hasExplicitFieldValue && preFieldValName !== undefined && meta.preAsName !== undefined) {
        if (field instanceof PDFRadioGroup) {
          const allWidgetsOffDespiteActiveV =
            preFieldValName !== 'Off' &&
            meta.preAsName === 'Off' &&
            consistentActiveAsCount === 0;
          const targetOptWidgetExplicitOff =
            preFieldValName !== 'Off' &&
            meta.preAsName === 'Off' &&
            selectedOptIdx !== undefined &&
            wi === selectedOptIdx;
          if (
            (preFieldValName === 'Off' && meta.preAsName !== 'Off') ||
            (preFieldValName !== 'Off' &&
              meta.preAsName !== 'Off' &&
              !isWidgetActiveAsConsistent(wi, meta)) ||
            allWidgetsOffDespiteActiveV ||
            targetOptWidgetExplicitOff
          ) {
            throw new PdfSignError(
              'Trường nút chọn radio chứa trạng thái /V và /AS mâu thuẫn nên không thể làm phẳng an toàn',
            );
          }
        } else {
          const polarityConflict =
            preFieldValName === 'Off'
              ? meta.preAsName !== 'Off'
              : meta.preAsName === 'Off' &&
                (widgets.length === 1 ||
                  !meta.hadPreApDict ||
                  meta.preApOnNames.has(preFieldValName) ||
                  isOptIndexSelected(wi) ||
                  (consistentActiveAsCount === 0 && allVisibleHaveExplicitAs));
          const namedStateConflict =
            preFieldValName !== 'Off' &&
            meta.preAsName !== 'Off' &&
            !isWidgetActiveAsConsistent(wi, meta);
          if (polarityConflict || namedStateConflict) {
            throw new PdfSignError(
              'Trường ô chọn chứa trạng thái /V và /AS mâu thuẫn nên không thể làm phẳng an toàn',
            );
          }
        }
      }
    }

    let isCheckedBeforeRegen: boolean;
    if (field instanceof PDFRadioGroup) {
      if (preFieldValName === undefined) {
        isCheckedBeforeRegen = meta.preAsName !== undefined && meta.preAsName !== 'Off';
      } else if (preFieldValName === 'Off') {
        isCheckedBeforeRegen = false;
      } else if (!radiosInUnison) {
        if (matchingAsCount > 0) {
          // Non-unison buttons can share an ON state name; honor per-widget /AS so unselected siblings stay Off.
          isCheckedBeforeRegen =
            meta.preAsName === preFieldValName && (!meta.hadPreApDict || meta.preApOnNames.has(preFieldValName));
        } else if (consistentActiveAsCount > 0) {
          isCheckedBeforeRegen = isWidgetActiveAsConsistent(wi, meta);
        } else if (meta.hadPreApDict) {
          isCheckedBeforeRegen = matchingApCount === 1 && meta.preApOnNames.has(preFieldValName);
        } else {
          if (selectedOptIdx !== undefined) {
            isCheckedBeforeRegen = isOptIndexSelected(wi);
          } else if (widgets.length === 1) {
            isCheckedBeforeRegen = true;
          } else if (meta.widgetHidden) {
            isCheckedBeforeRegen = false;
          } else {
            throw new PdfSignError(
              'Trường nút chọn radio thiếu trạng thái hiển thị hợp lệ nên không thể làm phẳng an toàn',
            );
          }
        }
      } else if (meta.hadPreApDict) {
        isCheckedBeforeRegen =
          meta.preApOnNames.has(preFieldValName) || isWidgetActiveAsConsistent(wi, meta);
      } else if (meta.preAsName !== undefined) {
        isCheckedBeforeRegen = isWidgetActiveAsConsistent(wi, meta);
      } else {
        if (selectedOptIdx !== undefined) {
          isCheckedBeforeRegen = isOptIndexSelected(wi);
        } else if (widgets.length === 1) {
          isCheckedBeforeRegen = true;
        } else if (meta.widgetHidden) {
          isCheckedBeforeRegen = false;
        } else {
          throw new PdfSignError(
            'Trường nút chọn radio thiếu trạng thái hiển thị hợp lệ nên không thể làm phẳng an toàn',
          );
        }
      }
    } else {
      isCheckedBeforeRegen =
        preFieldValName !== undefined
          ? preFieldValName !== 'Off' &&
            (meta.preAsName !== undefined
              ? isWidgetActiveAsConsistent(wi, meta)
              : meta.hadPreApDict
                ? meta.preApOnNames.has(preFieldValName) || isOptIndexSelected(wi)
                : selectedOptIdx !== undefined
                  ? isOptIndexSelected(wi)
                  : true)
          : meta.preAsName !== undefined && meta.preAsName !== 'Off';
    }
    return { preAsName: meta.preAsName, isCheckedBeforeRegen };
  });

  if (
    hasActiveFieldVal &&
    widgets.some((w) => !isAnnotationHidden(pdfDoc, w.dict)) &&
    !preWidgetStates.some((s) => s.isCheckedBeforeRegen)
  ) {
    throw new PdfSignError(
      'Trường nút chọn thiếu trạng thái hiển thị hợp lệ nên không thể làm phẳng an toàn',
    );
  }

  return preWidgetStates;
}

function resolveCheckOrRadioWidgetApRef(
  pdfDoc: PDFDocument,
  field: PDFCheckBox | PDFRadioGroup,
  apDict: PDFDict,
  preFieldValName: string | undefined,
  preState: CheckOrRadioPreState | undefined,
): PDFRef | undefined {
  if (field instanceof PDFRadioGroup) {
    if (!preState?.isCheckedBeforeRegen) {
      const offCandidate = lookupDictEntryByDecodedName(pdfDoc, apDict, 'Off')?.raw;
      return offCandidate instanceof PDFRef ? offCandidate : undefined;
    }
    const currentFieldValName =
      decodePdfNameValue(lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'V')?.resolved) ?? preFieldValName;
    const matchState =
      preState.preAsName !== undefined && preState.preAsName !== 'Off' ? preState.preAsName : currentFieldValName;
    let selectedCandidate =
      matchState !== undefined ? lookupDictEntryByDecodedName(pdfDoc, apDict, matchState)?.raw : undefined;
    if (!(selectedCandidate instanceof PDFRef) && currentFieldValName !== undefined) {
      selectedCandidate = lookupDictEntryByDecodedName(pdfDoc, apDict, currentFieldValName)?.raw;
    }
    return selectedCandidate instanceof PDFRef ? selectedCandidate : undefined;
  }

  if (preState && !preState.isCheckedBeforeRegen) {
    const offCandidate = lookupDictEntryByDecodedName(pdfDoc, apDict, 'Off')?.raw;
    return offCandidate instanceof PDFRef ? offCandidate : undefined;
  }

  const currentFieldValName =
    decodePdfNameValue(lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'V')?.resolved) ?? preFieldValName;
  const matchState =
    preState?.preAsName !== undefined && preState.preAsName !== 'Off' ? preState.preAsName : currentFieldValName;
  let selectedCandidate =
    matchState !== undefined ? lookupDictEntryByDecodedName(pdfDoc, apDict, matchState)?.raw : undefined;
  if (!(selectedCandidate instanceof PDFRef) && preState?.isCheckedBeforeRegen) {
    // pdf-lib defaultUpdateAppearances() writes /Yes even when the source checkbox used a custom ON name like /Approved.
    selectedCandidate = lookupDictEntryByDecodedName(pdfDoc, apDict, 'Yes')?.raw;
    if (!(selectedCandidate instanceof PDFRef)) {
      for (const [k, rawVal] of apDict.entries()) {
        if (decodePdfName(k) !== 'Off' && rawVal instanceof PDFRef) {
          selectedCandidate = rawVal;
          break;
        }
      }
    }
  }
  const offCandidate = lookupDictEntryByDecodedName(pdfDoc, apDict, 'Off')?.raw;
  const candidate = selectedCandidate ?? offCandidate;
  return candidate instanceof PDFRef ? candidate : undefined;
}

function resolveCheckOrRadioFieldContext(
  pdfDoc: PDFDocument,
  field: PDFCheckBox | PDFRadioGroup,
  widgets: ReturnType<PDFField['acroField']['getWidgets']>,
  needAppearances: boolean,
): {
  readonly willRegen: boolean;
  readonly preFieldValName: string | undefined;
  readonly preWidgetStates: readonly CheckOrRadioPreState[];
} {
  const explicitFieldValName = decodePdfNameValue(
    lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'V')?.resolved,
  );
  const defaultFieldValName = decodePdfNameValue(
    lookupInheritedDictEntry(pdfDoc, field.acroField.dict, 'DV')?.resolved,
  );
  const willRegen = needAppearances || field.needsAppearancesUpdate();
  const hasVisibleWidgetAs = widgets.some(
    (w) =>
      !isAnnotationHidden(pdfDoc, w.dict) &&
      decodePdfNameValue(lookupDictEntryByDecodedName(pdfDoc, w.dict, 'AS')?.resolved) !== undefined,
  );
  const preFieldValName =
    explicitFieldValName ?? (willRegen || !hasVisibleWidgetAs ? defaultFieldValName : undefined);
  const preWidgetStates = resolveCheckOrRadioPreStates(
    pdfDoc,
    field,
    widgets,
    preFieldValName,
    explicitFieldValName !== undefined,
  );
  return { willRegen, preFieldValName, preWidgetStates };
}

function readAcroFormFieldsOrThrow(pdfDoc: PDFDocument): {
  readonly acroDict: PDFDict | undefined;
  readonly needAppearances: boolean;
  readonly form: PDFForm | undefined;
  readonly fields: readonly PDFField[];
} {
  const acroEntry = lookupDictEntryByDecodedName(pdfDoc, pdfDoc.catalog, 'AcroForm');
  if (!acroEntry) {
    return { acroDict: undefined, needAppearances: false, form: undefined, fields: [] };
  }
  const acroDict = acroEntry.resolved instanceof PDFDict ? acroEntry.resolved : undefined;
  const needAppearancesEntry = acroDict ? lookupDictEntryByDecodedName(pdfDoc, acroDict, 'NeedAppearances') : undefined;
  const needAppearances =
    needAppearancesEntry?.resolved instanceof PDFBool && needAppearancesEntry.resolved.asBoolean();

  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    return { acroDict, needAppearances, form, fields };
  } catch {
    throw new PdfSignError('Tệp PDF chứa cấu trúc biểu mẫu AcroForm không hợp lệ nên không thể làm phẳng an toàn');
  }
}

function prepareAcroFormWidgets(
  pdfDoc: PDFDocument,
  fonts: PdfFontContext,
  pages: readonly PDFPage[],
  isolatedPages: Set<number>,
  graphicsValidation?: GraphicsBalanceValidationContext,
): PreparedAcroFormWork {
  const widgetRenderers = new Map<PDFDict, PreparedWidgetPlan>();
  const fieldsToRemove: PDFField[] = [];
  const passwordFieldsToScrub: PasswordFieldCleanupTarget[] = [];

  const { acroDict, needAppearances, form, fields } = readAcroFormFieldsOrThrow(pdfDoc);
  if (!form || fields.length === 0) {
    return { acroDict, form, widgetRenderers, fieldsToRemove, passwordFieldsToScrub };
  }

  for (const field of fields) {
    if (needAppearances) {
      form.markFieldAsDirty(field.ref);
    }
    const isTextOrChoice =
      field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList;
    const widgets = field.acroField.getWidgets();
    fieldsToRemove.push(field);

    if (isTextOrChoice) {
      const isPassword = field instanceof PDFTextField && isPasswordTextField(pdfDoc, field);
      if (isPassword) {
        passwordFieldsToScrub.push({ field, widgets });
      }
      const needsTextFallback =
        isPassword ||
        needAppearances ||
        field.needsAppearancesUpdate() ||
        widgets.some((w) => !isAnnotationHidden(pdfDoc, w.dict) && !(getWidgetNormalAppearance(pdfDoc, w) instanceof PDFRef));
      if (needsTextFallback) {
        const optionListRows = field instanceof PDFOptionList ? readOptionListFallbackRows(pdfDoc, field) : undefined;
        const value = optionListRows === undefined ? readAcroFieldFallbackText(pdfDoc, field) : '';
        for (const widget of widgets) {
          if (isAnnotationHidden(pdfDoc, widget.dict) || widgetRenderers.has(widget.dict)) continue;
          const target = findWidgetTargetPage(pdfDoc, pages, widget);
          if (!target) continue;
          const flags = readAnnotationFlags(pdfDoc, widget.dict);
          const noRotate = (flags & ANNOTATION_FLAG_NOROTATE) !== 0;
          const widgetRot = readWidgetRotation(pdfDoc, widget.dict);
          const boxStyle = readWidgetBoxStyle(pdfDoc, widget.dict);
          const textColor = readWidgetTextColor(pdfDoc, widget.dict, field.acroField.dict, acroDict);
          const textAlign = readWidgetTextAlignment(pdfDoc, widget.dict, field.acroField.dict, acroDict);
          const rect = readWidgetRect(pdfDoc, widget.dict);
          widgetRenderers.set(widget.dict, {
            fallbackPage: target.page,
            fallbackPageOneBased: target.pageOneBased,
            render: async (targetPage, pageOneBased) => {
              ensurePageStateIsolated(pdfDoc, targetPage, pageOneBased, isolatedPages);
              const userUnit = getPageUserUnit(pdfDoc, targetPage);
              const rot = normalizeRotation(targetPage.getRotation().angle);
              if (optionListRows !== undefined) {
                await drawFallbackOptionList(
                  fonts,
                  targetPage,
                  userUnit,
                  rect,
                  optionListRows,
                  rot,
                  noRotate,
                  widgetRot,
                  boxStyle,
                  textColor,
                  textAlign,
                );
              } else {
                await drawFallbackFieldText(
                  fonts,
                  targetPage,
                  userUnit,
                  rect,
                  value,
                  rot,
                  noRotate,
                  widgetRot,
                  boxStyle,
                  textColor,
                  textAlign,
                );
              }
            },
          });
        }
        continue;
      }
    }

    const isCheckOrRadio = field instanceof PDFCheckBox || field instanceof PDFRadioGroup;
    const checkOrRadioCtx = isCheckOrRadio
      ? resolveCheckOrRadioFieldContext(pdfDoc, field, widgets, needAppearances)
      : undefined;
    const preFieldValName = checkOrRadioCtx?.preFieldValName;
    const preWidgetStates = checkOrRadioCtx?.preWidgetStates ?? [];

    if (isCheckOrRadio) {
      try {
        if (checkOrRadioCtx?.willRegen) {
          field.defaultUpdateAppearances();
        }
      } catch {
        // Continue with existing or vector fallback if appearance generation fails.
      }
    }

    for (let wi = 0; wi < widgets.length; wi++) {
      const widget = widgets[wi];
      if (!widget || isAnnotationHidden(pdfDoc, widget.dict) || widgetRenderers.has(widget.dict)) continue;
      const target = findWidgetTargetPage(pdfDoc, pages, widget);
      if (!target) continue;

      const preState = preWidgetStates[wi];
      let apRef = getWidgetNormalAppearance(pdfDoc, widget);
      if (apRef instanceof PDFDict && isCheckOrRadio) {
        apRef =
          resolveCheckOrRadioWidgetApRef(pdfDoc, field, apRef, preFieldValName, preState) ??
          (field instanceof PDFRadioGroup ? undefined : apRef);
      }
      if (!isCheckOrRadio && !(apRef instanceof PDFRef)) {
        continue;
      }

      const flags = readAnnotationFlags(pdfDoc, widget.dict);
      const noRotate = (flags & ANNOTATION_FLAG_NOROTATE) !== 0;
      const widgetRot = readWidgetRotation(pdfDoc, widget.dict);
      const rect = readWidgetRect(pdfDoc, widget.dict);
      if (rect.width <= 1e-6 || rect.height <= 1e-6) {
        continue;
      }

      if (apRef instanceof PDFRef) {
        const resolvedApRef = apRef;
        widgetRenderers.set(widget.dict, {
          fallbackPage: target.page,
          fallbackPageOneBased: target.pageOneBased,
          render: async (targetPage, pageOneBased) => {
            const rot = normalizeRotation(targetPage.getRotation().angle);
            const drawn = drawAppearanceStreamToPage(
              pdfDoc,
              targetPage,
              pageOneBased,
              isolatedPages,
              resolvedApRef,
              rect,
              'FlatWidget',
              rot,
              noRotate,
              graphicsValidation,
            );
            if (!drawn) {
              throw new PdfSignError(
                'Tệp PDF chứa trường biểu mẫu có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn',
              );
            }
          },
        });
      } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
        let checked = preState?.isCheckedBeforeRegen ?? false;
        if (!checked && field instanceof PDFCheckBox && preFieldValName === undefined && preState?.preAsName === undefined) {
          try {
            checked = field.isChecked();
          } catch {
            checked = false;
          }
        }
        const isRadio = field instanceof PDFRadioGroup;
        widgetRenderers.set(widget.dict, {
          fallbackPage: target.page,
          fallbackPageOneBased: target.pageOneBased,
          render: async (targetPage, pageOneBased) => {
            const userUnit = getPageUserUnit(pdfDoc, targetPage);
            if (rect.width * userUnit <= 1 || rect.height * userUnit <= 1) return;
            ensurePageStateIsolated(pdfDoc, targetPage, pageOneBased, isolatedPages);
            const rot = normalizeRotation(targetPage.getRotation().angle);
            if (isRadio) {
              drawFallbackRadioButton(targetPage, userUnit, rect, checked, rot, noRotate);
            } else {
              drawFallbackCheckBox(targetPage, userUnit, rect, checked, rot, noRotate, widgetRot);
            }
          },
        });
      }
    }
  }

  return { acroDict, form, widgetRenderers, fieldsToRemove, passwordFieldsToScrub };
}

type ResolvedAnnotationAppearance =
  | { readonly status: 'none'; readonly explicitOff: boolean }
  | { readonly status: 'invalid' }
  | { readonly status: 'stream'; readonly stream: PDFStream; readonly rawRef: PDFRef | undefined };

function resolveAnnotationStreamEntry(raw: unknown, resolved: unknown): ResolvedAnnotationAppearance | null {
  if (resolved instanceof PDFStream) {
    return { status: 'stream', stream: resolved, rawRef: raw instanceof PDFRef ? raw : undefined };
  }
  return null;
}

function resolveAnnotationNormalAppearance(
  pdfDoc: PDFDocument,
  annotDict: PDFDict,
): ResolvedAnnotationAppearance {
  const apEntry = lookupDictEntryByDecodedName(pdfDoc, annotDict, 'AP');
  if (!apEntry || apEntry.resolved === undefined) {
    return { status: 'none', explicitOff: false };
  }
  if (!(apEntry.resolved instanceof PDFDict)) {
    return { status: 'invalid' };
  }

  const normalEntry = lookupDictEntryByDecodedName(pdfDoc, apEntry.resolved, 'N');
  if (!normalEntry) {
    return { status: 'none', explicitOff: false };
  }
  if (normalEntry.resolved === undefined) {
    return { status: 'invalid' };
  }

  const direct = resolveAnnotationStreamEntry(normalEntry.raw, normalEntry.resolved);
  if (direct) return direct;

  if (!(normalEntry.resolved instanceof PDFDict)) {
    return { status: 'invalid' };
  }

  const asEntry = lookupDictEntryByDecodedName(pdfDoc, annotDict, 'AS');
  const asName = asEntry?.resolved instanceof PDFName ? decodePdfName(asEntry.resolved) : undefined;
  if (asName === undefined) {
    return { status: 'invalid' };
  }
  const stateEntry = lookupDictEntryByDecodedName(pdfDoc, normalEntry.resolved, asName);
  if (!stateEntry) {
    return asName === 'Off' ? { status: 'none', explicitOff: true } : { status: 'invalid' };
  }
  return resolveAnnotationStreamEntry(stateEntry.raw, stateEntry.resolved) ?? { status: 'invalid' };
}

type NonWidgetAnnotationPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'password_widget' }
  | {
      readonly kind: 'draw';
      readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly stream: PDFStream;
      readonly rawRef: PDFRef | undefined;
      readonly noRotate: boolean;
    };

function inspectNonWidgetAnnotationPlan(
  pdfDoc: PDFDocument,
  rot: PageRotation,
  annotDict: PDFDict,
  graphicsValidation?: GraphicsBalanceValidationContext,
): NonWidgetAnnotationPlan {
  if (isAnnotationHidden(pdfDoc, annotDict)) return { kind: 'skip' };

  const subtypeEntry = lookupDictEntryByDecodedName(pdfDoc, annotDict, 'Subtype');
  const subtype = subtypeEntry?.resolved instanceof PDFName ? decodePdfName(subtypeEntry.resolved) : undefined;
  if (subtype === 'Popup') return { kind: 'skip' };

  if (subtype === 'Widget' && hasInheritedPasswordFlag(pdfDoc, annotDict)) {
    return { kind: 'password_widget' };
  }

  const rect = readNormalizedPdfRect(pdfDoc, annotDict);
  const apInfo = resolveAnnotationNormalAppearance(pdfDoc, annotDict);

  if (apInfo.status === 'invalid') {
    throw new PdfSignError('Tệp PDF chứa chú thích có luồng hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }
  if (apInfo.status === 'none') {
    if (
      subtype === 'Link' ||
      subtype === 'Widget' ||
      apInfo.explicitOff ||
      (rect !== null && (rect.width <= 1e-6 || rect.height <= 1e-6))
    ) {
      return { kind: 'skip' };
    }
    throw new PdfSignError('Tài liệu PDF chứa chú thích chưa có luồng hiển thị chuẩn nên không thể làm phẳng an toàn');
  }

  if (!isValidAppearanceFormSubtype(pdfDoc, apInfo.stream)) {
    throw new PdfSignError('Tệp PDF chứa chú thích có luồng hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }

  if (!rect) {
    throw new PdfSignError('Tệp PDF chứa chú thích thiếu khung tọa độ hợp lệ nên không thể làm phẳng an toàn');
  }
  if (rect.width <= 1e-6 || rect.height <= 1e-6) {
    return { kind: 'skip' };
  }

  const flags = readAnnotationFlags(pdfDoc, annotDict);
  const noRotate = (flags & ANNOTATION_FLAG_NOROTATE) !== 0;
  const transform = computeAppearanceTransformFromStream(pdfDoc, apInfo.stream, rect, rot, noRotate);
  if (!transform) {
    throw new PdfSignError('Tệp PDF chứa chú thích có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }
  validateOptionalContentVisibilityTree(pdfDoc, apInfo.stream);
  if (graphicsValidation) {
    validateFormXObjectGraphicsTree(
      pdfDoc,
      apInfo.stream,
      graphicsValidation.visited,
      graphicsValidation.budget,
      graphicsValidation.emptyContext,
    );
  } else {
    validateFormXObjectGraphicsTree(
      pdfDoc,
      apInfo.stream,
      createGraphicsBalanceVisitState(),
      { remainingBytes: EXTRACT_LIMITS.maxFileBytes * 4 },
      PDFContext.create(),
    );
  }

  return {
    kind: 'draw',
    rect,
    stream: apInfo.stream,
    rawRef: apInfo.rawRef,
    noRotate,
  };
}

function validateWidgetNormalAppearance(
  pdfDoc: PDFDocument,
  widgetDict: PDFDict,
  apRef: PDFRef,
  renderPage: PDFPage,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ocVisited: Set<object>,
  graphicsValidation: GraphicsBalanceValidationContext,
): void {
  const apObj = pdfDoc.context.lookup(apRef);
  if (apObj instanceof PDFStream) {
    if (!isValidAppearanceFormSubtype(pdfDoc, apObj)) {
      throw new PdfSignError('Tệp PDF chứa trường biểu mẫu có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn');
    }
    validateOptionalContentVisibilityTree(pdfDoc, apObj, ocVisited);
    validateFormXObjectGraphicsTree(
      pdfDoc,
      apObj,
      graphicsValidation.visited,
      graphicsValidation.budget,
      graphicsValidation.emptyContext,
    );
  }
  if (rect.width <= 1e-6 || rect.height <= 1e-6) {
    return;
  }
  if (!(apObj instanceof PDFStream)) {
    throw new PdfSignError('Tệp PDF chứa trường biểu mẫu có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }
  if (!isOptionalContentVisible(pdfDoc, apObj.dict)) {
    return;
  }
  const rot = normalizeRotation(renderPage.getRotation().angle);
  const noRotate = (readAnnotationFlags(pdfDoc, widgetDict) & ANNOTATION_FLAG_NOROTATE) !== 0;
  if (!computeAppearanceTransformFromStream(pdfDoc, apObj, rect, rot, noRotate)) {
    throw new PdfSignError('Tệp PDF chứa trường biểu mẫu có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }
}

async function validatePdfSourceFlattenable(pdfDoc: PDFDocument): Promise<void> {
  const graphicsValidation = createGraphicsBalanceValidationContext();
  const pages = pdfDoc.getPages();
  const acroWidgetDicts = new Set<PDFDict>();
  const ocVisited = new Set<object>();
  const annotsPageMap = new Map<PDFDict, PDFPage>();
  for (const page of pages) {
    for (const [key] of page.node.entries()) {
      if (decodePdfName(key) !== 'Annots') continue;
      const annots = pdfDoc.context.lookup(page.node.get(key));
      if (!(annots instanceof PDFArray)) continue;
      const count = annots.size();
      for (let i = 0; i < count; i += 1) {
        const annotDict = pdfDoc.context.lookup(annots.get(i));
        if (annotDict instanceof PDFDict && !annotsPageMap.has(annotDict)) {
          annotsPageMap.set(annotDict, page);
        }
      }
    }
  }
  let fontContextPromise: Promise<PdfFontContext> | undefined;

  const { needAppearances, form, fields } = readAcroFormFieldsOrThrow(pdfDoc);
  if (form && fields.length > 0) {
    for (const field of fields) {
      const widgets = field.acroField.getWidgets();

      const isTextOrChoice =
        field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList;
      if (isTextOrChoice) {
        const isPassword = field instanceof PDFTextField && isPasswordTextField(pdfDoc, field);
        const needsTextFallback =
          isPassword ||
          needAppearances ||
          field.needsAppearancesUpdate() ||
          widgets.some((w) => !isAnnotationHidden(pdfDoc, w.dict) && !(getWidgetNormalAppearance(pdfDoc, w) instanceof PDFRef));
        const optionListRows =
          needsTextFallback && field instanceof PDFOptionList ? readOptionListFallbackRows(pdfDoc, field) : undefined;
        const fallbackValue =
          needsTextFallback && optionListRows === undefined ? readAcroFieldFallbackText(pdfDoc, field) : '';
        const hasFallbackText = fallbackValue.trim().length > 0;
        for (const widget of widgets) {
          if (isAnnotationHidden(pdfDoc, widget.dict) || acroWidgetDicts.has(widget.dict)) continue;
          const target = findWidgetTargetPage(pdfDoc, pages, widget);
          if (!target) continue;
          acroWidgetDicts.add(widget.dict);
          const rect = readWidgetRect(pdfDoc, widget.dict);
          if (needsTextFallback) {
            const needsOptionListFit = optionListRows !== undefined && optionListRows.length > 0;
            if (needsOptionListFit || hasFallbackText) {
              const renderPage = annotsPageMap.get(widget.dict) ?? target.page;
              const userUnit = getPageUserUnit(pdfDoc, renderPage);
              const rot = normalizeRotation(renderPage.getRotation().angle);
              const flags = readAnnotationFlags(pdfDoc, widget.dict);
              const noRotate = (flags & ANNOTATION_FLAG_NOROTATE) !== 0;
              const widgetRot = readWidgetRotation(pdfDoc, widget.dict);
              const boxStyle = readWidgetBoxStyle(pdfDoc, widget.dict);
              if (needsOptionListFit) {
                const box = buildFallbackWidgetBoxGeometry(userUnit, rect, rot, noRotate, widgetRot, boxStyle);
                if (box) {
                  fontContextPromise ??= PdfFontContext.create(pdfDoc);
                  const fonts = await fontContextPromise;
                  await fitFallbackOptionList(fonts, box, optionListRows);
                }
              } else {
                const box = buildFallbackTextBoxSpec(
                  userUnit,
                  rect,
                  fallbackValue,
                  rot,
                  noRotate,
                  widgetRot,
                  boxStyle,
                );
                if (box?.textSpec) {
                  fontContextPromise ??= PdfFontContext.create(pdfDoc);
                  const fonts = await fontContextPromise;
                  await fitFallbackFieldText(fonts, box.textSpec);
                }
              }
            }
          } else {
            const apRef = getWidgetNormalAppearance(pdfDoc, widget);
            if (apRef instanceof PDFRef) {
              validateWidgetNormalAppearance(
                pdfDoc,
                widget.dict,
                apRef,
                annotsPageMap.get(widget.dict) ?? target.page,
                rect,
                ocVisited,
                graphicsValidation,
              );
            }
          }
        }
        continue;
      }

      const isCheckOrRadio = field instanceof PDFCheckBox || field instanceof PDFRadioGroup;
      const checkOrRadioCtx = isCheckOrRadio
        ? resolveCheckOrRadioFieldContext(pdfDoc, field, widgets, needAppearances)
        : undefined;
      const preFieldValName = checkOrRadioCtx?.preFieldValName;
      const preWidgetStates = checkOrRadioCtx?.preWidgetStates ?? [];
      const willRegenCheckOrRadio = checkOrRadioCtx?.willRegen ?? false;

      for (let wi = 0; wi < widgets.length; wi++) {
        const widget = widgets[wi];
        if (!widget || isAnnotationHidden(pdfDoc, widget.dict) || acroWidgetDicts.has(widget.dict)) continue;
        const target = findWidgetTargetPage(pdfDoc, pages, widget);
        if (!target) continue;
        let apRef = getWidgetNormalAppearance(pdfDoc, widget);
        if (apRef instanceof PDFDict && isCheckOrRadio) {
          apRef = resolveCheckOrRadioWidgetApRef(pdfDoc, field, apRef, preFieldValName, preWidgetStates[wi]);
        }
        const isTextOrChoiceField =
          field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList;
        if (!isTextOrChoiceField && !isCheckOrRadio && !(apRef instanceof PDFRef)) {
          continue;
        }
        acroWidgetDicts.add(widget.dict);
        const rect = readWidgetRect(pdfDoc, widget.dict);
        if (willRegenCheckOrRadio) continue;
        if (apRef instanceof PDFRef) {
          validateWidgetNormalAppearance(
            pdfDoc,
            widget.dict,
            apRef,
            annotsPageMap.get(widget.dict) ?? target.page,
            rect,
            ocVisited,
            graphicsValidation,
          );
        }
      }
    }
  }

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (!page) continue;
    const rot = normalizeRotation(page.getRotation().angle);
    for (const [key] of page.node.entries()) {
      if (decodePdfName(key) !== 'Annots') continue;
      const annots = pdfDoc.context.lookup(page.node.get(key));
      if (!(annots instanceof PDFArray)) continue;
      const count = annots.size();
      for (let i = 0; i < count; i++) {
        const annotDict = pdfDoc.context.lookup(annots.get(i));
        if (!(annotDict instanceof PDFDict) || acroWidgetDicts.has(annotDict)) continue;
        inspectNonWidgetAnnotationPlan(pdfDoc, rot, annotDict, graphicsValidation);
      }
    }
  }
}

function flattenNonWidgetAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  pageOneBased: number,
  rot: PageRotation,
  isolatedPages: Set<number>,
  annotDict: PDFDict,
  graphicsValidation?: GraphicsBalanceValidationContext,
): void {
  const plan = inspectNonWidgetAnnotationPlan(pdfDoc, rot, annotDict, graphicsValidation);
  if (plan.kind === 'skip') return;
  if (plan.kind === 'password_widget') {
    scrubSecretKeysFromDict(annotDict);
    return;
  }

  const apRef = plan.rawRef ?? pdfDoc.context.register(plan.stream);
  const drawn = drawAppearanceStreamToPage(
    pdfDoc,
    page,
    pageOneBased,
    isolatedPages,
    apRef,
    plan.rect,
    'FlatAnnot',
    rot,
    plan.noRotate,
    graphicsValidation,
  );
  if (!drawn) {
    throw new PdfSignError('Tệp PDF chứa chú thích có khung hiển thị không hợp lệ nên không thể làm phẳng an toàn');
  }
}

async function flattenAcroFormAndAnnotations(
  pdfDoc: PDFDocument,
  fonts: PdfFontContext,
  sourcePageCount: number,
  isolatedPages: Set<number>,
): Promise<void> {
  const pages = pdfDoc.getPages();
  const flattenGraphicsValidation = createGraphicsBalanceValidationContext();
  const prepared = prepareAcroFormWidgets(pdfDoc, fonts, pages, isolatedPages, flattenGraphicsValidation);
  const nonWidgetRefsToDelete = new Set<PDFRef>();
  const pageAnnotsKeysToDelete: Array<{ readonly page: PDFPage; readonly keys: readonly PDFName[] }> = [];
  const renderedWidgetDicts = new Set<PDFDict>();

  for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex++) {
    const page = pages[pageIndex];
    if (!page) continue;

    const annotsKeys: PDFName[] = [];
    for (const [key] of page.node.entries()) {
      if (decodePdfName(key) === 'Annots') {
        annotsKeys.push(key);
      }
    }
    if (annotsKeys.length === 0) continue;

    pageAnnotsKeysToDelete.push({ page, keys: annotsKeys });
    const pageOneBased = pageIndex + 1;
    const rot = normalizeRotation(page.getRotation().angle);

    for (const annotsKey of annotsKeys) {
      const annots = pdfDoc.context.lookup(page.node.get(annotsKey));
      if (!(annots instanceof PDFArray)) continue;

      const count = annots.size();
      for (let i = 0; i < count; i++) {
        const raw = annots.get(i);
        const annotDict = pdfDoc.context.lookup(raw);
        if (!(annotDict instanceof PDFDict)) continue;

        const widgetPlan = prepared.widgetRenderers.get(annotDict);
        if (widgetPlan) {
          if (!renderedWidgetDicts.has(annotDict)) {
            renderedWidgetDicts.add(annotDict);
            await widgetPlan.render(page, pageOneBased);
          }
          continue;
        }

        if (raw instanceof PDFRef) {
          nonWidgetRefsToDelete.add(raw);
        }
        flattenNonWidgetAnnotation(
          pdfDoc,
          page,
          pageOneBased,
          rot,
          isolatedPages,
          annotDict,
          flattenGraphicsValidation,
        );
      }
    }
  }

  for (const [widgetDict, widgetPlan] of prepared.widgetRenderers) {
    if (!renderedWidgetDicts.has(widgetDict)) {
      renderedWidgetDicts.add(widgetDict);
      await widgetPlan.render(widgetPlan.fallbackPage, widgetPlan.fallbackPageOneBased);
    }
  }

  const passwordAncestorDicts = new Set<PDFDict>();
  const passwordAncestorRefs = new Set<PDFRef>();
  for (const { field, widgets } of prepared.passwordFieldsToScrub) {
    deletePasswordFieldSecretRefs(pdfDoc, field, widgets, passwordAncestorDicts, passwordAncestorRefs);
  }
  if (prepared.form) {
    for (const field of prepared.fieldsToRemove) {
      safeRemoveField(pdfDoc, prepared.form, field, pages);
    }
  }
  for (const ancestorDict of passwordAncestorDicts) {
    scrubSecretKeysFromDict(ancestorDict);
  }
  for (const ancestorRef of passwordAncestorRefs) {
    pdfDoc.context.delete(ancestorRef);
  }
  scrubRemainingAcroFormPasswordNodes(pdfDoc, prepared.acroDict);
  for (const ref of nonWidgetRefsToDelete) {
    pdfDoc.context.delete(ref);
  }
  for (const { page, keys } of pageAnnotsKeysToDelete) {
    for (const annotsKey of keys) {
      page.node.delete(annotsKey);
    }
  }
  deleteDictKeysByDecodedName(pdfDoc.catalog, 'AcroForm');
}

const STRIPPED_CATALOG_KEYS = ['AcroForm', 'Outlines', 'Names', 'EmbeddedFiles', 'AF', 'Collection', 'URI'] as const;

function stripInteractiveElements(pdfDoc: PDFDocument): void {
  for (const keyName of STRIPPED_CATALOG_KEYS) {
    deleteDictKeysByDecodedName(pdfDoc.catalog, keyName);
  }

  for (const page of pdfDoc.getPages()) {
    deleteDictKeysByDecodedName(page.node, 'Annots');
    deleteDictKeysByDecodedName(page.node, 'AF');
  }
}

function pruneUnreferencedIndirectObjects(pdfDoc: PDFDocument): void {
  const reachableRefs = new Set<PDFRef>();
  const visitedObjects = new Set<object>();
  const stack: TraversablePdfGraphNode[] = [];

  const trailer = pdfDoc.context.trailerInfo;
  if (isTraversablePdfGraphNode(trailer.Root)) stack.push(trailer.Root);
  if (isTraversablePdfGraphNode(trailer.Info)) stack.push(trailer.Info);
  if (isTraversablePdfGraphNode(trailer.ID)) stack.push(trailer.ID);
  stack.push(pdfDoc.catalog);
  const catalogRef = pdfDoc.context.getObjectRef(pdfDoc.catalog);
  if (catalogRef !== undefined) stack.push(catalogRef);

  let visitedCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current instanceof PDFRef) {
      reachableRefs.add(current);
      if (visitedObjects.has(current)) continue;
      visitedObjects.add(current);
      const resolved: unknown = pdfDoc.context.lookup(current);
      if (isTraversablePdfGraphNode(resolved)) {
        stack.push(resolved);
      }
      continue;
    }
    if (visitedObjects.has(current)) continue;
    visitedObjects.add(current);
    visitedCount += 1;
    if (visitedCount > MAX_PDF_GRAPH_NODES) {
      throw new PdfSignError('Tệp PDF sau đóng dấu vượt quá giới hạn số lượng đối tượng cho phép');
    }

    if (current instanceof PDFStream) {
      stack.push(current.dict);
      continue;
    }
    if (current instanceof PDFArray) {
      const size = current.size();
      for (let i = 0; i < size; i++) {
        const element = current.get(i);
        if (isTraversablePdfGraphNode(element)) {
          stack.push(element);
        }
      }
      continue;
    }
    if (current instanceof PDFDict) {
      for (const [, value] of current.entries()) {
        if (isTraversablePdfGraphNode(value)) {
          stack.push(value);
        }
      }
    }
  }

  for (const [ref] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!reachableRefs.has(ref)) {
      pdfDoc.context.delete(ref);
    }
  }
}

function formatUtcPlus7(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const shifted = new Date(ms + 7 * 3_600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = pad(shifted.getUTCDate());
  const month = pad(shifted.getUTCMonth() + 1);
  const year = shifted.getUTCFullYear();
  const hour = pad(shifted.getUTCHours());
  const min = pad(shifted.getUTCMinutes());
  const sec = pad(shifted.getUTCSeconds());
  return `${day}/${month}/${year} ${hour}:${min}:${sec} (UTC+7)`;
}

function formatOtpStatus(status: PdfSealOtpStatus): string {
  switch (status) {
    case 'verified':
      return 'Đã xác thực OTP / Verified';
    case 'not_required':
      return 'Không yêu cầu / Not required';
    case 'unverified':
      return 'Chưa xác thực / Unverified';
  }
}

interface CertificatePageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

function resolveCertificatePageSize(pdfDoc: PDFDocument, sourcePageCount: number): CertificatePageSize {
  if (sourcePageCount < 1) {
    return { widthPt: A4_WIDTH_PT, heightPt: A4_HEIGHT_PT };
  }
  try {
    const lastPage = pdfDoc.getPage(sourcePageCount - 1);
    const { box, rot, userUnit } = getPageMetrics(pdfDoc, lastPage);
    const widthPt = Number(((rot === 90 || rot === 270 ? box.height : box.width) * userUnit).toFixed(4));
    const heightPt = Number(((rot === 90 || rot === 270 ? box.width : box.height) * userUnit).toFixed(4));
    if (
      !Number.isFinite(widthPt) ||
      !Number.isFinite(heightPt) ||
      widthPt < MIN_CERT_PAGE_WIDTH_PT ||
      heightPt < MIN_CERT_PAGE_HEIGHT_PT ||
      widthPt > MAX_PDF_BOX_PT ||
      heightPt > MAX_PDF_BOX_PT
    ) {
      return { widthPt: A4_WIDTH_PT, heightPt: A4_HEIGHT_PT };
    }
    return { widthPt, heightPt };
  } catch {
    return { widthPt: A4_WIDTH_PT, heightPt: A4_HEIGHT_PT };
  }
}

async function drawCertHeader(
  page: PDFPage,
  fonts: PdfFontContext,
  certificateCode: string,
  continued: boolean,
  pageSize: CertificatePageSize,
  marginX: number,
  vScale: number,
  tScale: number,
): Promise<number> {
  const { widthPt, heightPt } = pageSize;
  const headerH = continued ? Math.round(52 * vScale) : Math.round(68 * vScale);
  page.drawRectangle({
    x: 0,
    y: heightPt - headerH,
    width: widthPt,
    height: headerH,
    color: COLOR_NAVY,
  });
  page.drawRectangle({
    x: 0,
    y: heightPt - headerH - 3,
    width: widthPt,
    height: 3,
    color: COLOR_ACCENT,
  });

  const title = continued
    ? `CHỨNG NHẬN KÝ KẾT ĐIỆN TỬ / AUDIT CERTIFICATE (Tiếp theo - ${certificateCode})`
    : 'CHỨNG NHẬN KÝ KẾT ĐIỆN TỬ / AUDIT CERTIFICATE';
  const maxTitleW = widthPt - marginX * 2;
  const titleLayout = await fitWrappedTextInBox(
    fonts,
    title,
    'bold',
    maxTitleW,
    continued ? Math.max(24, headerH - 12) : Math.max(15, Math.round(22 * vScale)),
    Number(((continued ? 11.5 : 14) * tScale).toFixed(2)),
    'Mã chứng nhận điện tử vượt quá kích thước tiêu đề trang',
  );
  if (titleLayout.lines.length === 1) {
    await fonts.drawText(page, titleLayout.lines[0] ?? title, {
      weight: 'bold',
      sizePt: titleLayout.sizePt,
      color: COLOR_WHITE,
      x: marginX,
      y: heightPt - (continued ? Math.round(31 * vScale) : Math.round(30 * vScale)),
    });
  } else {
    const titleBandH = continued ? headerH : Math.max(24, Math.round(41 * vScale));
    const topPad = Math.max(5, (titleBandH - titleLayout.blockHeightPt) / 2);
    for (let i = 0; i < titleLayout.lines.length; i++) {
      const line = titleLayout.lines[i] ?? '';
      if (line.length === 0) continue;
      await fonts.drawText(page, line, {
        weight: 'bold',
        sizePt: titleLayout.sizePt,
        color: COLOR_WHITE,
        x: marginX,
        y: heightPt - topPad - (titleLayout.baselineOffsetsPt[i] ?? 0),
      });
    }
  }
  if (!continued) {
    const subtitle = 'Ludy eSign - Bằng chứng hoàn tất giao dịch ký số / Signing Completion Record';
    const subLayout = await fitWrappedTextInBox(
      fonts,
      subtitle,
      'regular',
      maxTitleW,
      Math.max(10, Math.round(14 * vScale)),
      Number((8.8 * tScale).toFixed(2)),
      'Phụ đề chứng nhận vượt quá kích thước tiêu đề trang',
    );
    await fonts.drawText(page, subLayout.lines[0] ?? subtitle, {
      weight: 'regular',
      sizePt: subLayout.sizePt,
      color: rgb(0.78, 0.86, 0.96),
      x: marginX,
      y: heightPt - Math.round(50 * vScale),
    });
  }
  return headerH;
}

function collapseSingleLineText(value: string): string {
  return value.replace(/[\r\n\u2028\u2029\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

async function appendAuditCertificatePages(
  pdfDoc: PDFDocument,
  fonts: PdfFontContext,
  certificate: PdfSealCertificate,
  pageSize: CertificatePageSize,
): Promise<void> {
  const { widthPt: pageW, heightPt: pageH } = pageSize;
  const vScale = Math.min(1, Math.max(0.66, pageH / 600));
  const tScale = Math.min(1, Math.max(0.75, Math.min(pageW / 540, pageH / 560)));
  const marginX = Math.max(22, Math.min(56, Math.round(pageW * 0.07)));
  const contentW = pageW - marginX * 2;
  const cardPadX = Math.max(8, Math.round(12 * tScale));
  const innerTextW = contentW - cardPadX * 2;
  const bottomLimit = Math.max(34, Math.round(52 * vScale));
  const certPages: PDFPage[] = [];
  const certificateCode = collapseSingleLineText(certificate.certificateCode);
  const envelopeTitle = collapseSingleLineText(certificate.envelopeTitle);
  const completedAtIso = collapseSingleLineText(certificate.completedAtIso);
  const sourceSha256 = collapseSingleLineText(certificate.sourceSha256);
  const eventChainTipHash = collapseSingleLineText(certificate.eventChainTipHash);

  const startPage = async (continued: boolean): Promise<{ page: PDFPage; cursorY: number }> => {
    if (certPages.length >= EXTRACT_LIMITS.maxPdfAuditCertPages) {
      throw new PdfSignError(
        `Trang chứng nhận điện tử vượt quá giới hạn tối đa ${EXTRACT_LIMITS.maxPdfAuditCertPages} trang`,
      );
    }
    const page = pdfDoc.addPage([pageW, pageH]);
    // Override any inherited MediaBox/CropBox/Rotate/UserUnit from the source /Pages tree.
    page.setMediaBox(0, 0, pageW, pageH);
    page.setCropBox(0, 0, pageW, pageH);
    page.setRotation(degrees(0));
    page.node.delete(PDFName.of('UserUnit'));
    certPages.push(page);
    const headerH = await drawCertHeader(page, fonts, certificateCode, continued, pageSize, marginX, vScale, tScale);
    return { page, cursorY: pageH - headerH - Math.round((continued ? 22 : 24) * vScale) };
  };

  let state = await startPage(false);

  // Envelope summary metadata card.
  const metaFields: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    { label: 'Mã chứng nhận / Certificate Code', value: certificateCode },
    { label: 'Tiêu đề tài liệu / Envelope Title', value: envelopeTitle },
    { label: 'Hoàn tất lúc / Completed At', value: `${formatUtcPlus7(completedAtIso)} | ${completedAtIso}` },
    { label: 'Mã băm tài liệu gốc / Source SHA-256', value: sourceSha256 },
    { label: 'Chuỗi sự kiện / Event Chain Tip', value: eventChainTipHash },
  ];

  const metaLabelSize = Number((8 * tScale).toFixed(2));
  const metaValSize = Number((8.8 * tScale).toFixed(2));
  const metaLabelStep = Number((12 * vScale).toFixed(2));
  const metaLineStep = Number((11.5 * vScale).toFixed(2));
  const metaRowGap = Number((5 * vScale).toFixed(2));

  const metaMeasured: Array<{ readonly label: string; readonly lines: string[] }> = [];
  let metaBoxH = Math.round(18 * vScale);
  for (const row of metaFields) {
    const lines = await fonts.wrapLines(row.value, 'regular', metaValSize, innerTextW);
    metaMeasured.push({ label: row.label, lines });
    metaBoxH += metaLabelStep + lines.length * metaLineStep + metaRowGap;
  }

  if (state.cursorY - metaBoxH < bottomLimit) {
    throw new PdfSignError('Thông tin chứng nhận điện tử vượt quá kích thước trang chứng nhận');
  }

  state.page.drawRectangle({
    x: marginX,
    y: state.cursorY - metaBoxH,
    width: contentW,
    height: metaBoxH,
    color: COLOR_CARD_BG,
    borderColor: COLOR_BORDER,
    borderWidth: 0.8,
  });

  let metaY = state.cursorY - Math.round(16 * vScale);
  for (const item of metaMeasured) {
    await fonts.drawText(state.page, item.label, {
      weight: 'bold',
      sizePt: metaLabelSize,
      color: COLOR_MUTED,
      x: marginX + cardPadX,
      y: metaY,
    });
    metaY -= metaLabelStep;
    for (const line of item.lines) {
      await fonts.drawText(state.page, line, {
        weight: 'regular',
        sizePt: metaValSize,
        color: COLOR_INK,
        x: marginX + cardPadX,
        y: metaY,
      });
      metaY -= metaLineStep;
    }
    metaY -= metaRowGap;
  }

  state.cursorY -= metaBoxH + Math.round(18 * vScale);

  const signerHeadingSize = Number((10 * tScale).toFixed(2));
  const signerHeadingGap = Math.round(12 * vScale);
  const signerTitleSize = Number((9.5 * tScale).toFixed(2));
  const signerDetailSize = Number((8.5 * tScale).toFixed(2));
  const signerTitleStep = Number((12 * vScale).toFixed(2));
  const signerDetailStep = Number((11.5 * vScale).toFixed(2));
  const cardTopPad = Math.round(15 * vScale);
  const cardGap = Math.round(8 * vScale);

  const measureSignerCardHeight = (titleCount: number, detailCount: number): number =>
    Math.round(16 * vScale) + titleCount * signerTitleStep + detailCount * signerDetailStep + Math.round(6 * vScale);

  const continuedHeaderH = Math.round(52 * vScale);
  const continuedPageStartY = pageH - continuedHeaderH - Math.round(22 * vScale);
  const freshPageAvailH = continuedPageStartY - bottomLimit;

  const certDocuments = certificate.documents ?? [];
  if (certDocuments.length > 0) {
    const docCardRows: Array<{ readonly titleLines: readonly string[]; readonly detailLines: readonly string[]; readonly cardH: number }> = [];
    for (const docMeta of certDocuments) {
      const titleText = `${docMeta.index}. ${collapseSingleLineText(docMeta.title)}`;
      const titleLines = await fonts.wrapLines(titleText, 'bold', signerTitleSize, innerTextW);
      const detailLines = await fonts.wrapLines(
        `Trang / Pages: ${docMeta.startPage}-${docMeta.endPage} (${docMeta.pageCount} trang) | SHA-256: ${collapseSingleLineText(docMeta.sourceSha256)}`,
        'regular',
        signerDetailSize,
        innerTextW,
      );
      docCardRows.push({
        titleLines,
        detailLines,
        cardH: measureSignerCardHeight(titleLines.length, detailLines.length),
      });
    }

    const firstDoc = docCardRows[0];
    if (firstDoc && state.cursorY - signerHeadingGap - firstDoc.cardH < bottomLimit) {
      state = await startPage(true);
    }

    await fonts.drawText(state.page, `TÀI LIỆU TRONG HỒ SƠ / PACKET DOCUMENTS (${certDocuments.length})`, {
      weight: 'bold',
      sizePt: signerHeadingSize,
      color: COLOR_NAVY,
      x: marginX,
      y: state.cursorY,
    });
    state.cursorY -= signerHeadingGap;

    for (const docCard of docCardRows) {
      if (state.cursorY - docCard.cardH < bottomLimit) {
        state = await startPage(true);
      }
      state.page.drawRectangle({
        x: marginX,
        y: state.cursorY - docCard.cardH,
        width: contentW,
        height: docCard.cardH,
        color: COLOR_CARD_BG,
        borderColor: COLOR_BORDER,
        borderWidth: 0.75,
      });
      let y = state.cursorY - cardTopPad;
      for (const line of docCard.titleLines) {
        await fonts.drawText(state.page, line, {
          weight: 'bold',
          sizePt: signerTitleSize,
          color: COLOR_INK,
          x: marginX + cardPadX,
          y,
        });
        y -= signerTitleStep;
      }
      y -= Math.max(1, Math.round(2 * vScale));
      for (const line of docCard.detailLines) {
        await fonts.drawText(state.page, line, {
          weight: 'regular',
          sizePt: signerDetailSize,
          color: COLOR_MUTED,
          x: marginX + cardPadX,
          y,
        });
        y -= signerDetailStep;
      }
      state.cursorY -= docCard.cardH + Math.max(4, Math.round(cardGap * 0.75));
    }

    state.cursorY -= Math.round(8 * vScale);
  }

  const signerCards: Array<{
    readonly titleLines: readonly string[];
    readonly continuedTitleLines: readonly string[];
    readonly detailLines: readonly string[];
    readonly cardH: number;
  }> = [];

  for (let i = 0; i < certificate.signers.length; i++) {
    const signer = certificate.signers[i];
    if (!signer) continue;

    const signerName = collapseSingleLineText(signer.name);
    const roleLabel = collapseSingleLineText(signer.roleLabel);
    const titleText = `${i + 1}. ${signerName} (${roleLabel})`;
    const titleLines = await fonts.wrapLines(titleText, 'bold', signerTitleSize, innerTextW);
    const continuedTitleLines = await fonts.wrapLines(
      `${titleText} (Tiếp theo / Continued)`,
      'bold',
      signerTitleSize,
      innerTextW,
    );
    const emailDisplay = signer.maskedEmail ? collapseSingleLineText(signer.maskedEmail) : 'N/A';
    const deliveryDisplay = signer.deliveryMode === 'email' ? 'Email' : 'Link';
    const sigKindSuffix = signer.signatureKind
      ? ` | Chữ ký / Method: ${collapseSingleLineText(signer.signatureKind)}`
      : '';
    const ipHashDisplay = signer.ipHashPrefix ? collapseSingleLineText(signer.ipHashPrefix) : 'N/A';
    const provenanceLines: string[] = [];
    if (signer.delegatedFromName) {
      const fromName = collapseSingleLineText(signer.delegatedFromName);
      const fromEmail = signer.delegatedFromMaskedEmail ? collapseSingleLineText(signer.delegatedFromMaskedEmail) : null;
      const viDelegated = fromEmail ? `Ủy quyền ký bởi ${fromName} (${fromEmail})` : `Ủy quyền ký bởi ${fromName}`;
      const enDelegated = fromEmail ? `Delegated by ${fromName} (${fromEmail})` : `Delegated by ${fromName}`;
      provenanceLines.push(
        ...(await fonts.wrapLines(`${viDelegated} | ${enDelegated}`, 'regular', signerDetailSize, innerTextW)),
      );
    }
    if (signer.recipientCorrected) {
      provenanceLines.push(
        ...(await fonts.wrapLines(
          'Hiệu chỉnh người nhận / Recipient corrected in-flight by sender',
          'regular',
          signerDetailSize,
          innerTextW,
        )),
      );
    }
    const detailLines = [
      ...(await fonts.wrapLines(`Email: ${emailDisplay} | Kênh gửi / Delivery: ${deliveryDisplay}`, 'regular', signerDetailSize, innerTextW)),
      ...provenanceLines,
      ...(await fonts.wrapLines(`Xác thực OTP / OTP: ${formatOtpStatus(signer.otpStatus)}${sigKindSuffix}`, 'regular', signerDetailSize, innerTextW)),
      ...(await fonts.wrapLines(
        `Thời điểm ký / Signed At: ${formatUtcPlus7(signer.signedAtIso)} | IP hash: ${ipHashDisplay}`,
        'regular',
        signerDetailSize,
        innerTextW,
      )),
    ];
    for (const att of signer.attachments ?? []) {
      const attLabel = collapseSingleLineText(att.label);
      const attFilename = collapseSingleLineText(att.filename);
      detailLines.push(
        ...(await fonts.wrapLines(
          `Tệp đính kèm / Attachment (${attLabel}): ${attFilename} | SHA-256: ${att.sha256}`,
          'regular',
          signerDetailSize,
          innerTextW,
        )),
      );
    }

    const cardH = measureSignerCardHeight(titleLines.length, detailLines.length);
    signerCards.push({ titleLines, continuedTitleLines, detailLines, cardH });
  }

  const firstCard = signerCards[0];
  if (firstCard) {
    const firstFitsSinglePage = firstCard.cardH <= freshPageAvailH;
    const minFirstSliceH = measureSignerCardHeight(
      firstCard.titleLines.length,
      Math.min(1, firstCard.detailLines.length),
    );
    const minNeededForHeading = firstFitsSinglePage ? firstCard.cardH : minFirstSliceH;
    if (state.cursorY - signerHeadingGap - minNeededForHeading < bottomLimit) {
      state = await startPage(true);
    }
  }

  await fonts.drawText(state.page, `DANH SÁCH NGƯỜI KÝ / SIGNERS (${certificate.signers.length})`, {
    weight: 'bold',
    sizePt: signerHeadingSize,
    color: COLOR_NAVY,
    x: marginX,
    y: state.cursorY,
  });
  state.cursorY -= signerHeadingGap;

  const drawSignerCardSlice = async (
    page: PDFPage,
    topY: number,
    titleLines: readonly string[],
    detailLines: readonly string[],
    sliceH: number,
  ): Promise<void> => {
    page.drawRectangle({
      x: marginX,
      y: topY - sliceH,
      width: contentW,
      height: sliceH,
      color: COLOR_WHITE,
      borderColor: COLOR_BORDER,
      borderWidth: 0.75,
    });
    page.drawRectangle({
      x: marginX,
      y: topY - sliceH,
      width: 3,
      height: sliceH,
      color: COLOR_ACCENT,
    });

    let y = topY - cardTopPad;
    for (const line of titleLines) {
      await fonts.drawText(page, line, {
        weight: 'bold',
        sizePt: signerTitleSize,
        color: COLOR_INK,
        x: marginX + cardPadX,
        y,
      });
      y -= signerTitleStep;
    }
    y -= Math.max(1, Math.round(2 * vScale));
    for (const line of detailLines) {
      await fonts.drawText(page, line, {
        weight: 'regular',
        sizePt: signerDetailSize,
        color: COLOR_MUTED,
        x: marginX + cardPadX,
        y,
      });
      y -= signerDetailStep;
    }
  };

  for (const card of signerCards) {
    let remainingDetails = card.detailLines;
    let isContinuation = false;

    while (remainingDetails.length > 0 || !isContinuation) {
      const activeTitleLines = isContinuation ? card.continuedTitleLines : card.titleLines;
      const fullSliceH = measureSignerCardHeight(activeTitleLines.length, remainingDetails.length);
      const availH = state.cursorY - bottomLimit;

      if (fullSliceH <= availH) {
        await drawSignerCardSlice(state.page, state.cursorY, activeTitleLines, remainingDetails, fullSliceH);
        state.cursorY -= fullSliceH + cardGap;
        break;
      }

      if (!isContinuation && fullSliceH <= freshPageAvailH) {
        state = await startPage(true);
        continue;
      }

      const baseOverheadH = measureSignerCardHeight(activeTitleLines.length, 0);
      const minDetailBudget = remainingDetails.length > 0 ? 1 : 0;
      let maxDetailsHere = Math.floor((availH - baseOverheadH) / signerDetailStep);

      if (maxDetailsHere < minDetailBudget) {
        state = await startPage(true);
        const freshAvailH = state.cursorY - bottomLimit;
        maxDetailsHere = Math.floor((freshAvailH - baseOverheadH) / signerDetailStep);
        if (maxDetailsHere < minDetailBudget) {
          throw new PdfSignError('Thông tin người ký vượt quá kích thước trang chứng nhận');
        }
      }

      const takeCount = Math.min(remainingDetails.length, maxDetailsHere);
      const sliceDetails = remainingDetails.slice(0, takeCount);
      const sliceH = measureSignerCardHeight(activeTitleLines.length, sliceDetails.length);
      await drawSignerCardSlice(state.page, state.cursorY, activeTitleLines, sliceDetails, sliceH);
      state.cursorY -= sliceH + cardGap;
      remainingDetails = remainingDetails.slice(takeCount);
      isContinuation = true;

      if (remainingDetails.length > 0) {
        state = await startPage(true);
      }
    }
  }

  const footerMaxH = Math.max(18, Math.round(28 * vScale));
  const footerTargetSize = Number((8 * tScale).toFixed(2));
  const footerBaseY = Math.max(16, Math.round(26 * vScale));

  for (let p = 0; p < certPages.length; p++) {
    const certPage = certPages[p];
    if (!certPage) continue;
    const footerText = `Ludy eSign | ${certificateCode} | Trang chứng nhận ${p + 1}/${certPages.length}`;
    const footerLayout = await fitWrappedTextInBox(
      fonts,
      footerText,
      'regular',
      contentW,
      footerMaxH,
      footerTargetSize,
      'Mã chứng nhận điện tử vượt quá kích thước chân trang',
    );
    const topY = footerBaseY + footerLayout.blockHeightPt * 0.5;
    for (let i = 0; i < footerLayout.lines.length; i++) {
      const line = footerLayout.lines[i] ?? '';
      if (line.length === 0) continue;
      await fonts.drawText(certPage, line, {
        weight: 'regular',
        sizePt: footerLayout.sizePt,
        color: COLOR_MUTED,
        x: marginX,
        y: footerLayout.lines.length === 1 ? footerBaseY : topY - (footerLayout.baselineOffsetsPt[i] ?? 0),
      });
    }
  }
}

function attachPacketOutlines(
  pdfDoc: PDFDocument,
  bookmarks: readonly { readonly title: string; readonly pageRef: PDFRef }[],
): void {
  if (bookmarks.length === 0) return;
  const outlinesRef = pdfDoc.context.nextRef();
  const itemRefs = bookmarks.map(() => pdfDoc.context.nextRef());
  for (let i = 0; i < bookmarks.length; i++) {
    const bm = bookmarks[i];
    const itemRef = itemRefs[i];
    if (!bm || !itemRef) continue;
    const itemDict = pdfDoc.context.obj({
      Title: PDFHexString.fromText(bm.title),
      Parent: outlinesRef,
      Dest: pdfDoc.context.obj([bm.pageRef, PDFName.of('Fit')]),
    });
    const prevRef = i > 0 ? itemRefs[i - 1] : undefined;
    const nextRef = i + 1 < bookmarks.length ? itemRefs[i + 1] : undefined;
    if (prevRef) itemDict.set(PDFName.of('Prev'), prevRef);
    if (nextRef) itemDict.set(PDFName.of('Next'), nextRef);
    pdfDoc.context.assign(itemRef, itemDict);
  }
  const firstRef = itemRefs[0];
  const lastRef = itemRefs[itemRefs.length - 1];
  if (!firstRef || !lastRef) return;
  pdfDoc.context.assign(
    outlinesRef,
    pdfDoc.context.obj({
      Type: PDFName.of('Outlines'),
      First: firstRef,
      Last: lastRef,
      Count: PDFNumber.of(bookmarks.length),
    }),
  );
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

export async function sealPdf(bytes: Uint8Array): Promise<PdfSealResult> {
  const input = decodePdfSealInput(bytes);
  let pdfDoc: PDFDocument;
  let sourcePageCount = 0;
  const isolatedPages = new Set<number>();
  let certificateForAudit: PdfSealCertificate = input.certificate;
  const outlineBookmarks: Array<{ readonly title: string; readonly pageRef: PDFRef }> = [];

  if (input.documents !== undefined) {
    const unifiedDoc = await PDFDocument.create();
    const measuredDocs: PdfSealCertificateDocument[] = [];
    let totalPartBytes = 0;

    for (let i = 0; i < input.documents.length; i++) {
      const partInput = input.documents[i];
      if (!partInput) continue;
      const partBytes = decodeStrictBase64(partInput.pdfBase64, `Tài liệu PDF #${i + 1}`);
      totalPartBytes += partBytes.byteLength;
      if (totalPartBytes > EXTRACT_LIMITS.maxFileBytes) {
        throw new PdfSignError('Tổng dung lượng tệp PDF gốc vượt quá giới hạn 25 MiB cho phép');
      }
      const partSha = createHash('sha256').update(partBytes).digest('hex');
      if (partSha !== partInput.sourceSha256) {
        throw new PdfSignError(`Mã băm SHA-256 của tài liệu #${i + 1} không khớp`);
      }

      const partDoc = await loadValidatedPdf(partBytes);
      const partPages = partDoc.getPageCount();
      if (sourcePageCount + partPages > EXTRACT_LIMITS.maxPdfSignPages) {
        throw new PdfSignError(`Tổng số trang của bộ tài liệu vượt quá giới hạn ${EXTRACT_LIMITS.maxPdfSignPages} trang`);
      }

      const partFonts = await PdfFontContext.create(partDoc);
      for (const partPage of partDoc.getPages()) {
        clonePageSharedContainers(partDoc, partPage);
      }
      const partIsolated = new Set<number>();
      // Flatten AcroForm and annotations per part before merging so widget names/refs never collide across PDFs.
      await flattenAcroFormAndAnnotations(partDoc, partFonts, partPages, partIsolated);
      stripInteractiveElements(partDoc);

      const copiedPages = await unifiedDoc.copyPages(partDoc, partDoc.getPageIndices());
      for (const partPageOneBased of partIsolated) {
        isolatedPages.add(sourcePageCount + partPageOneBased);
      }
      const startPage = sourcePageCount + 1;
      for (let p = 0; p < copiedPages.length; p++) {
        const copiedPage = copiedPages[p];
        if (!copiedPage) continue;
        unifiedDoc.addPage(copiedPage);
        if (p === 0) {
          outlineBookmarks.push({
            title: collapseSingleLineText(partInput.title) || `Tài liệu ${i + 1}`,
            pageRef: copiedPage.ref,
          });
        }
      }
      sourcePageCount += copiedPages.length;
      measuredDocs.push({
        index: i + 1,
        title: partInput.title,
        startPage,
        endPage: sourcePageCount,
        pageCount: copiedPages.length,
        sourceSha256: partInput.sourceSha256,
      });
    }

    if (input.certificate.documents !== undefined) {
      if (input.certificate.documents.length !== measuredDocs.length) {
        throw new PdfSignError('Danh sách tài liệu trong chứng nhận không khớp với số tệp đầu vào');
      }
      for (let i = 0; i < measuredDocs.length; i++) {
        const expected = measuredDocs[i];
        const actual = input.certificate.documents[i];
        if (
          !expected ||
          !actual ||
          actual.index !== expected.index ||
          actual.startPage !== expected.startPage ||
          actual.endPage !== expected.endPage ||
          actual.pageCount !== expected.pageCount ||
          actual.sourceSha256 !== expected.sourceSha256
        ) {
          throw new PdfSignError('Phạm vi trang hoặc mã băm tài liệu trong chứng nhận không khớp');
        }
      }
    } else {
      certificateForAudit = { ...input.certificate, documents: measuredDocs };
    }

    pdfDoc = unifiedDoc;
  } else {
    const pdfBytes = decodeStrictBase64(input.pdfBase64!, 'Tài liệu PDF');
    pdfDoc = await loadValidatedPdf(pdfBytes);
    sourcePageCount = pdfDoc.getPageCount();
    const singleFonts = await PdfFontContext.create(pdfDoc);
    for (const page of pdfDoc.getPages()) {
      clonePageSharedContainers(pdfDoc, page);
    }
    await flattenAcroFormAndAnnotations(pdfDoc, singleFonts, sourcePageCount, isolatedPages);
  }

  const certPageSize = resolveCertificatePageSize(pdfDoc, sourcePageCount);
  const fonts = await PdfFontContext.create(pdfDoc);
  await stampFields(pdfDoc, fonts, input.fields, sourcePageCount, isolatedPages);
  await appendAuditCertificatePages(pdfDoc, fonts, certificateForAudit, certPageSize);
  stripInteractiveElements(pdfDoc);
  if (outlineBookmarks.length > 0) {
    attachPacketOutlines(pdfDoc, outlineBookmarks);
  }
  await pdfDoc.flush();
  pruneUnreferencedIndirectObjects(pdfDoc);

  const pageCount = pdfDoc.getPageCount();
  if (pageCount > EXTRACT_LIMITS.maxPdfSignPages + EXTRACT_LIMITS.maxPdfAuditCertPages) {
    throw new PdfSignError('Tổng số trang PDF sau đóng dấu vượt quá giới hạn cho phép');
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
  if (outBytes.byteLength > EXTRACT_LIMITS.maxFileBytes) {
    throw new PdfSignError('Tệp PDF sau đóng dấu vượt quá giới hạn 25 MiB cho phép');
  }
  const sealedPdfBase64 = Buffer.from(outBytes).toString('base64');
  // Reserve headroom for JSON wrapper fields inside maxResponseBytes.
  if (sealedPdfBase64.length + 256 > EXTRACT_LIMITS.maxResponseBytes) {
    throw new PdfSignError('Tệp PDF sau đóng dấu vượt quá kích thước phản hồi cho phép');
  }

  return {
    ok: true,
    kind: 'pdf_seal',
    sealedPdfBase64,
    pageCount,
  };
}
