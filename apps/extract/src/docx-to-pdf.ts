// SPDX-License-Identifier: AGPL-3.0-only
// Pure-JS WordprocessingML (.docx) to tagged A4 PDF converter (#4721).
// Runs inside the isolated crove-extract sandbox with zero external binaries or network egress.
import { PDFDocument, PageSizes, rgb, type PDFPage } from 'pdf-lib';
import {
  EXTRACT_LIMITS,
  type DocxToPdfResult,
  type DocxToPdfWarning,
} from '@ludy/extract-contract';
import { DocxError } from './docx-text.ts';
import { PdfFontContext, type FontWeight } from './fonts.ts';
import { ArchiveError, readZipParts, type ZipLimits } from './zip.ts';

const MiB = 1024 * 1024;

const DOCX_CONVERT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxTotalBytes: 32 * MiB,
  maxEntryBytes: 16 * MiB,
};

const MAX_XML_DEPTH = 128;
const MAX_XML_ELEMENTS = 1_000_000;
const MAX_STYLE_INHERITANCE_DEPTH = 16;
export const MAX_DOCX_PARAGRAPH_CHARS = 100_000;
export const MAX_DOCX_TOTAL_CHARS = 500_000;

const A4_WIDTH = PageSizes.A4[0];
const A4_HEIGHT = PageSizes.A4[1];
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;
const USABLE_PAGE_HEIGHT = A4_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
const MIN_PRINTABLE_TEXT_WIDTH_PT = 72;
const MAX_PARAGRAPH_INDENT_SUM_PT = Math.max(0, CONTENT_WIDTH - MIN_PRINTABLE_TEXT_WIDTH_PT);

const DEFAULT_FONT_SIZE_PT = 11;
const MIN_FONT_SIZE_PT = 8;
const MAX_FONT_SIZE_PT = 32;
const LINE_HEIGHT_RATIO = 1.38;
const TABLE_CELL_PAD_X = 6;
const TABLE_CELL_PAD_Y = 5;

const TEXT_COLOR = rgb(0.09, 0.11, 0.14);
const BORDER_COLOR = rgb(0.75, 0.78, 0.83);

const TRACK_CHANGE_TAGS = new Set([
  'w:ins',
  'w:del',
  'w:moveFrom',
  'w:moveTo',
  'w:delText',
  'w:moveFromRangeStart',
  'w:moveToRangeStart',
  'w:rPrChange',
  'w:pPrChange',
  'w:tblPrChange',
  'w:trPrChange',
  'w:tcPrChange',
  'w:sectPrChange',
  'w:tblGridChange',
  'w:numberingChange',
]);

const XML_NAMESPACE_TO_PREFIX: Readonly<Record<string, string>> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
};

const FLOATING_SHAPE_TAGS = new Set([
  'wp:anchor',
  'v:shape',
  'v:rect',
  'v:roundrect',
  'v:oval',
  'v:line',
  'v:polyline',
  'v:curve',
  'v:arc',
  'v:group',
  'w:pict',
  'wps:wsp',
  'w:txbxContent',
]);

const IMAGE_TAGS = new Set(['a:blip', 'pic:pic', 'v:imagedata']);
const OLE_TAGS = new Set(['w:object', 'o:OLEObject']);

const XML_NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | string>;
}

interface StyleProps {
  styleId: string;
  type: string;
  name: string;
  basedOn: string | undefined;
  outlineLvl: number | undefined;
  bold: boolean | undefined;
  fontSizePt: number | undefined;
  align: ParagraphAlign | undefined;
  spaceBeforePt: number | undefined;
  spaceAfterPt: number | undefined;
  indentLeftPt: number | undefined;
  indentRightPt: number | undefined;
  numId: string | undefined;
  ilvl: number | undefined;
  vanish: boolean | undefined;
}

interface ResolvedStyle {
  outlineLvl: number | undefined;
  headingLevel: number | undefined;
  bold: boolean;
  fontSizePt: number;
  align: ParagraphAlign;
  spaceBeforePt: number;
  spaceAfterPt: number;
  indentLeftPt: number;
  indentRightPt: number;
  numId: string | undefined;
  ilvl: number;
  vanish: boolean;
}

interface NumberingLevel {
  numFmt: string;
  lvlText: string;
  start: number;
}

interface AbstractNumDef {
  levels: Map<number, NumberingLevel>;
}

interface ConcreteNumDef {
  abstractNumId: string;
  startOverrides: Map<number, number>;
}

interface NumberingDefs {
  abstracts: Map<string, AbstractNumDef>;
  nums: Map<string, ConcreteNumDef>;
}

type ParagraphAlign = 'left' | 'center' | 'right' | 'justify';

interface RawRun {
  text: string;
  bold: boolean;
  fontSizePt: number;
}

interface DocParagraph {
  kind: 'paragraph';
  runs: RawRun[];
  align: ParagraphAlign;
  defaultFontSizePt: number;
  spaceBeforePt: number;
  spaceAfterPt: number;
  indentLeftPt: number;
  indentRightPt: number;
  headingLevel: number | undefined;
  pageBreakBefore: boolean;
}

interface TableCellEdgeBorders {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

interface DocTableCell {
  paragraphs: DocParagraph[];
  borders: TableCellEdgeBorders;
}

interface DocTable {
  kind: 'table';
  colFractions: number[];
  rows: DocTableCell[][];
}

interface DocPageBreak {
  kind: 'page_break';
}

type DocBlock = DocParagraph | DocTable | DocPageBreak;

interface RenderToken {
  text: string;
  weight: FontWeight;
  sizePt: number;
  whitespace: boolean;
  isTag: boolean;
}

interface RenderSpan {
  text: string;
  weight: FontWeight;
  sizePt: number;
}

interface WrappedLine {
  spans: RenderSpan[];
  widthPt: number;
  fontSizePt: number;
  hasTag: boolean;
}

interface ParagraphLayout {
  lines: WrappedLine[];
  spaceBeforePt: number;
  spaceAfterPt: number;
  indentLeftPt: number;
  indentRightPt: number;
  align: ParagraphAlign;
  isHeading: boolean;
}

function isSafeUnicodeCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  if (cp < 0x20) return false;
  return true;
}

function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const cp = Number.parseInt(ref.slice(2), 16);
      return isSafeUnicodeCodePoint(cp) ? String.fromCodePoint(cp) : '';
    }
    if (ref.startsWith('#')) {
      const cp = Number.parseInt(ref.slice(1), 10);
      return isSafeUnicodeCodePoint(cp) ? String.fromCodePoint(cp) : '';
    }
    return XML_NAMED_ENTITIES[ref] ?? full;
  });
}

function hasUnsafeXmlDecl(xml: string): boolean {
  const upper = xml.toUpperCase();
  return upper.includes('<!DOCTYPE') || upper.includes('<!ENTITY');
}

function decodeStrictUtf8(bytes: Uint8Array, partName: string): string {
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (hasUnsafeXmlDecl(text)) {
      throw new DocxError('Tệp DOCX chứa khai báo XML không an toàn');
    }
    return text;
  } catch (err) {
    if (err instanceof DocxError) throw err;
    throw new DocxError(`Phần ${partName} trong tệp Word không phải UTF-8 hợp lệ`);
  }
}

function isWhitespaceChar(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isTagNameChar(code: number): boolean {
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  if (code >= 0x30 && code <= 0x39) return true;
  return code === 0x3a || code === 0x5f || code === 0x2d || code === 0x2e;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && isWhitespaceChar(raw.charCodeAt(i))) i++;
    if (i >= len || raw[i] === '/' || raw[i] === '?') break;
    const keyStart = i;
    while (i < len && !isWhitespaceChar(raw.charCodeAt(i)) && raw[i] !== '=' && raw[i] !== '/') i++;
    const key = raw.slice(keyStart, i);
    while (i < len && isWhitespaceChar(raw.charCodeAt(i))) i++;
    if (!key) {
      i++;
      continue;
    }
    if (i >= len || raw[i] !== '=') {
      attrs[key] = '';
      continue;
    }
    i++;
    while (i < len && isWhitespaceChar(raw.charCodeAt(i))) i++;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      const closeIdx = raw.indexOf(quote, valStart);
      if (closeIdx === -1) break;
      attrs[key] = decodeXmlEntities(raw.slice(valStart, closeIdx));
      i = closeIdx + 1;
    } else {
      const valStart = i;
      while (i < len && !isWhitespaceChar(raw.charCodeAt(i))) i++;
      attrs[key] = decodeXmlEntities(raw.slice(valStart, i));
    }
  }
  return attrs;
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

interface NamespaceScope {
  defaultNs: string | undefined;
  prefixes: ReadonlyMap<string, string>;
}

interface XmlStackFrame {
  rawName: string;
  elem: XmlElement;
  scope: NamespaceScope;
}

function isValidTagName(name: string): boolean {
  if (!name) return false;
  for (let i = 0; i < name.length; i++) {
    if (!isTagNameChar(name.charCodeAt(i))) return false;
  }
  return true;
}

function extendNamespaceScope(parent: NamespaceScope, rawAttrs: Record<string, string>): NamespaceScope {
  let defaultNs = parent.defaultNs;
  let nextPrefixes: Map<string, string> | null = null;
  for (const [key, val] of Object.entries(rawAttrs)) {
    if (key === 'xmlns') {
      defaultNs = val || undefined;
    } else if (key.startsWith('xmlns:') && key.length > 6) {
      if (!nextPrefixes) nextPrefixes = new Map(parent.prefixes);
      if (val) {
        nextPrefixes.set(key.slice(6), val);
      } else {
        nextPrefixes.delete(key.slice(6));
      }
    }
  }
  if (defaultNs === parent.defaultNs && nextPrefixes === null) return parent;
  return {
    defaultNs,
    prefixes: nextPrefixes ?? parent.prefixes,
  };
}

function resolveXmlElementName(rawName: string, scope: NamespaceScope, partName: string): { name: string; usesDefaultWml: boolean } {
  const colonIdx = rawName.indexOf(':');
  if (colonIdx === -1) {
    const uri = scope.defaultNs;
    if (!uri) return { name: rawName, usesDefaultWml: false };
    const canonical = XML_NAMESPACE_TO_PREFIX[uri];
    if (!canonical) return { name: rawName, usesDefaultWml: false };
    return { name: `${canonical}:${rawName}`, usesDefaultWml: canonical === 'w' };
  }
  const prefix = rawName.slice(0, colonIdx);
  const local = rawName.slice(colonIdx + 1);
  if (!prefix || !local) {
    throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
  }
  const uri = scope.prefixes.get(prefix);
  if (uri === undefined) {
    return { name: rawName, usesDefaultWml: false };
  }
  const canonical = XML_NAMESPACE_TO_PREFIX[uri];
  return {
    name: canonical ? `${canonical}:${local}` : `{${uri}}:${local}`,
    usesDefaultWml: false,
  };
}

function resolveXmlAttributes(
  rawAttrs: Record<string, string>,
  scope: NamespaceScope,
  usesDefaultWml: boolean,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [rawKey, val] of Object.entries(rawAttrs)) {
    if (rawKey === 'xmlns' || rawKey.startsWith('xmlns:')) continue;
    const colonIdx = rawKey.indexOf(':');
    if (colonIdx === -1) {
      resolved[rawKey] = val;
      if (usesDefaultWml && !Object.hasOwn(resolved, `w:${rawKey}`)) {
        resolved[`w:${rawKey}`] = val;
      }
      continue;
    }
    const prefix = rawKey.slice(0, colonIdx);
    const local = rawKey.slice(colonIdx + 1);
    const uri = scope.prefixes.get(prefix);
    if (uri === undefined) {
      resolved[rawKey] = val;
      continue;
    }
    const canonical = XML_NAMESPACE_TO_PREFIX[uri];
    resolved[canonical ? `${canonical}:${local}` : `{${uri}}:${local}`] = val;
  }
  return resolved;
}

function parseXmlDocument(xml: string, partName: string): XmlElement {
  const root: XmlElement = { name: '__root__', attrs: {}, children: [] };
  const initialScope: NamespaceScope = { defaultNs: undefined, prefixes: new Map<string, string>() };
  const stack: XmlStackFrame[] = [{ rawName: '__root__', elem: root, scope: initialScope }];
  let elementCount = 0;
  let pos = 0;
  const len = xml.length;

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      const tail = xml.slice(pos);
      if (tail.length > 0 && stack.length > 1) {
        stack[stack.length - 1]!.elem.children.push(decodeXmlEntities(tail));
      }
      break;
    }

    if (lt > pos && stack.length > 1) {
      stack[stack.length - 1]!.elem.children.push(decodeXmlEntities(xml.slice(pos, lt)));
    }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
      pos = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
      if (stack.length > 1) {
        stack[stack.length - 1]!.elem.children.push(xml.slice(lt + 9, end));
      }
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      throw new DocxError('Tệp DOCX chứa khai báo XML không an toàn');
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);

    if (xml[lt + 1] === '/') {
      const closeName = xml.slice(lt + 2, gt).trim();
      const top = stack[stack.length - 1];
      if (!closeName || !isValidTagName(closeName) || stack.length <= 1 || !top || top.rawName !== closeName) {
        throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
      }
      stack.pop();
      pos = gt + 1;
      continue;
    }

    let nameStart = lt + 1;
    while (nameStart < gt && isWhitespaceChar(xml.charCodeAt(nameStart))) nameStart++;
    let nameEnd = nameStart;
    while (nameEnd < gt && isTagNameChar(xml.charCodeAt(nameEnd))) nameEnd++;
    const rawName = xml.slice(nameStart, nameEnd);
    if (!rawName) throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);

    let selfClosing = false;
    let attrEnd = gt;
    while (attrEnd > nameEnd && isWhitespaceChar(xml.charCodeAt(attrEnd - 1))) attrEnd--;
    if (attrEnd > nameEnd && xml[attrEnd - 1] === '/') {
      selfClosing = true;
      attrEnd--;
    }
    if (attrEnd > nameEnd && !isWhitespaceChar(xml.charCodeAt(nameEnd))) {
      throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng`);
    }

    elementCount++;
    if (elementCount > MAX_XML_ELEMENTS) {
      throw new DocxError('Tệp Word quá phức tạp để chuyển đổi sang PDF');
    }

    const parentFrame = stack[stack.length - 1]!;
    const rawAttrs = attrEnd > nameEnd ? parseAttributes(xml.slice(nameEnd, attrEnd)) : {};
    const scope = extendNamespaceScope(parentFrame.scope, rawAttrs);
    const { name, usesDefaultWml } = resolveXmlElementName(rawName, scope, partName);

    const elem: XmlElement = {
      name,
      attrs: resolveXmlAttributes(rawAttrs, scope, usesDefaultWml),
      children: [],
    };
    parentFrame.elem.children.push(elem);

    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new DocxError('Cấu trúc tệp Word lồng nhau quá sâu');
      }
      stack.push({ rawName, elem, scope });
    }
    pos = gt + 1;
  }

  if (stack.length !== 1 || childElements(root).length === 0) {
    throw new DocxError(`Cấu trúc XML trong ${partName} bị hỏng hoặc chưa đóng thẻ`);
  }

  return root;
}

function isXmlElement(node: XmlElement | string): node is XmlElement {
  return typeof node !== 'string';
}

function childElements(node: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const ch of node.children) {
    if (isXmlElement(ch)) out.push(ch);
  }
  return out;
}

function findChild(node: XmlElement, name: string): XmlElement | undefined {
  for (const ch of node.children) {
    if (isXmlElement(ch) && ch.name === name) return ch;
  }
  return undefined;
}

function elementText(node: XmlElement): string {
  let out = '';
  for (const ch of node.children) {
    if (typeof ch === 'string') out += ch;
  }
  return out;
}

function isOoxmlBoolTrue(val: string | undefined, defaultWhenPresent = true): boolean {
  if (val === undefined) return defaultWhenPresent;
  const norm = val.trim().toLowerCase();
  return norm !== '0' && norm !== 'false' && norm !== 'off';
}

function enforceNoTrackChangesOrHiddenText(root: XmlElement): void {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (TRACK_CHANGE_TAGS.has(node.name)) {
      throw new DocxError(
        'Tệp Word còn nội dung Theo dõi thay đổi (Track Changes) chưa được chấp nhận; vui lòng xử lý toàn bộ thay đổi trước khi tải lên',
      );
    }
    if ((node.name === 'w:vanish' || node.name === 'w:specVanish') && isOoxmlBoolTrue(node.attrs['w:val'], true)) {
      throw new DocxError(
        'Tệp Word có chứa văn bản ẩn (hidden text); vui lòng hiện hoặc xóa nội dung ẩn trước khi tải lên',
      );
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const ch = node.children[i]!;
      if (isXmlElement(ch)) stack.push(ch);
    }
  }
}

function parseIntAttr(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const trimmed = val.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function clampFontSizePt(pt: number): number {
  return Math.min(MAX_FONT_SIZE_PT, Math.max(MIN_FONT_SIZE_PT, pt));
}

function parseAlign(val: string | undefined): ParagraphAlign | undefined {
  switch (val) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'justify':
    case 'distribute':
      return 'justify';
    case 'left':
    case 'start':
      return 'left';
    default:
      return undefined;
  }
}

function twipsToPt(twips: number | undefined): number | undefined {
  if (twips === undefined || twips < 0) return undefined;
  return twips / 20;
}

function parseParagraphPropsMeta(pPr: XmlElement | undefined): {
  outlineLvl?: number | undefined;
  align?: ParagraphAlign | undefined;
  spaceBeforePt?: number | undefined;
  spaceAfterPt?: number | undefined;
  indentLeftPt?: number | undefined;
  indentRightPt?: number | undefined;
  numId?: string | undefined;
  ilvl?: number | undefined;
  pStyle?: string | undefined;
  pageBreakBefore?: boolean | undefined;
} {
  if (!pPr) return {};
  const pStyle = findChild(pPr, 'w:pStyle')?.attrs['w:val'];
  const outlineLvl = parseIntAttr(findChild(pPr, 'w:outlineLvl')?.attrs['w:val']);
  const align = parseAlign(findChild(pPr, 'w:jc')?.attrs['w:val']);
  const spacing = findChild(pPr, 'w:spacing');
  const spaceBeforePt = twipsToPt(parseIntAttr(spacing?.attrs['w:before']));
  const spaceAfterPt = twipsToPt(parseIntAttr(spacing?.attrs['w:after']));
  const ind = findChild(pPr, 'w:ind');
  const indentLeftPt = twipsToPt(parseIntAttr(ind?.attrs['w:left'] ?? ind?.attrs['w:start']));
  const indentRightPt = twipsToPt(parseIntAttr(ind?.attrs['w:right'] ?? ind?.attrs['w:end']));
  const numPr = findChild(pPr, 'w:numPr');
  const numId = findChild(numPr ?? pPr, 'w:numId')?.attrs['w:val'];
  const ilvl = numPr ? parseIntAttr(findChild(numPr, 'w:ilvl')?.attrs['w:val']) : undefined;
  const pageBreakBeforeNode = findChild(pPr, 'w:pageBreakBefore');
  const pageBreakBefore = pageBreakBeforeNode ? isOoxmlBoolTrue(pageBreakBeforeNode.attrs['w:val'], true) : false;
  return {
    outlineLvl,
    align,
    spaceBeforePt,
    spaceAfterPt,
    indentLeftPt,
    indentRightPt,
    numId: numPr ? numId : undefined,
    ilvl,
    pStyle,
    pageBreakBefore,
  };
}

function parseRunPropsMeta(rPr: XmlElement | undefined): {
  bold?: boolean | undefined;
  fontSizePt?: number | undefined;
  rStyle?: string | undefined;
  vanish?: boolean | undefined;
} {
  if (!rPr) return {};
  const rStyle = findChild(rPr, 'w:rStyle')?.attrs['w:val'];
  const boldNode = findChild(rPr, 'w:b');
  const bold = boldNode ? isOoxmlBoolTrue(boldNode.attrs['w:val'], true) : undefined;
  const szHalfPt = parseIntAttr(findChild(rPr, 'w:sz')?.attrs['w:val']);
  const fontSizePt = szHalfPt !== undefined && szHalfPt > 0 ? clampFontSizePt(szHalfPt / 2) : undefined;
  const vanishNode = findChild(rPr, 'w:vanish') ?? findChild(rPr, 'w:specVanish');
  const vanish = vanishNode ? isOoxmlBoolTrue(vanishNode.attrs['w:val'], true) : undefined;
  return { bold, fontSizePt, rStyle, vanish };
}

interface ParsedStyles {
  defaultFontSizePt: number;
  defaultSpaceAfterPt: number;
  defaultSpaceBeforePt: number;
  byId: Map<string, StyleProps>;
}

function parseStylesXml(root: XmlElement | null): ParsedStyles {
  const byId = new Map<string, StyleProps>();
  let defaultFontSizePt = DEFAULT_FONT_SIZE_PT;
  let defaultSpaceAfterPt = 6;
  let defaultSpaceBeforePt = 0;

  if (!root) {
    return { defaultFontSizePt, defaultSpaceAfterPt, defaultSpaceBeforePt, byId };
  }

  const stylesElem = findChild(root, 'w:styles');
  if (!stylesElem) {
    return { defaultFontSizePt, defaultSpaceAfterPt, defaultSpaceBeforePt, byId };
  }

  const docDefaults = findChild(stylesElem, 'w:docDefaults');
  if (docDefaults) {
    const rPrDefault = findChild(docDefaults, 'w:rPrDefault');
    const rPrDef = findChild(rPrDefault ?? docDefaults, 'w:rPr');
    const rMeta = parseRunPropsMeta(rPrDef);
    if (rMeta.vanish === true) {
      throw new DocxError('Tệp Word có chứa văn bản ẩn (hidden text); vui lòng hiện hoặc xóa nội dung ẩn trước khi tải lên');
    }
    if (rMeta.fontSizePt !== undefined) defaultFontSizePt = rMeta.fontSizePt;
    const pPrDef = findChild(findChild(docDefaults, 'w:pPrDefault') ?? docDefaults, 'w:pPr');
    const pMeta = parseParagraphPropsMeta(pPrDef);
    if (pMeta.spaceAfterPt !== undefined) defaultSpaceAfterPt = Math.min(24, pMeta.spaceAfterPt);
    if (pMeta.spaceBeforePt !== undefined) defaultSpaceBeforePt = Math.min(24, pMeta.spaceBeforePt);
  }

  for (const child of childElements(stylesElem)) {
    if (child.name !== 'w:style') continue;
    const styleId = child.attrs['w:styleId'];
    if (!styleId) continue;
    const pMeta = parseParagraphPropsMeta(findChild(child, 'w:pPr'));
    const rMeta = parseRunPropsMeta(findChild(child, 'w:rPr'));
    byId.set(styleId, {
      styleId,
      type: child.attrs['w:type'] ?? 'paragraph',
      name: findChild(child, 'w:name')?.attrs['w:val'] ?? '',
      basedOn: findChild(child, 'w:basedOn')?.attrs['w:val'],
      outlineLvl: pMeta.outlineLvl,
      bold: rMeta.bold,
      fontSizePt: rMeta.fontSizePt,
      align: pMeta.align,
      spaceBeforePt: pMeta.spaceBeforePt,
      spaceAfterPt: pMeta.spaceAfterPt,
      indentLeftPt: pMeta.indentLeftPt,
      indentRightPt: pMeta.indentRightPt,
      numId: pMeta.numId,
      ilvl: pMeta.ilvl,
      vanish: rMeta.vanish,
    });
  }

  return { defaultFontSizePt, defaultSpaceAfterPt, defaultSpaceBeforePt, byId };
}

function inferHeadingLevel(style: StyleProps | undefined, outlineLvl: number | undefined): number | undefined {
  if (outlineLvl !== undefined && outlineLvl >= 0 && outlineLvl <= 5) {
    return outlineLvl + 1;
  }
  const label = `${style?.name ?? ''} ${style?.styleId ?? ''}`.trim().toLowerCase();
  if (label.startsWith('title')) return 1;
  const match = /\bheading\s*([1-6])\b/.exec(label);
  if (match) return Number.parseInt(match[1]!, 10);
  return undefined;
}

function resolveStyle(styles: ParsedStyles, styleId: string | undefined): ResolvedStyle {
  const chain: StyleProps[] = [];
  const seen = new Set<string>();
  let cur = styleId;
  while (cur && !seen.has(cur) && chain.length < MAX_STYLE_INHERITANCE_DEPTH) {
    seen.add(cur);
    const s = styles.byId.get(cur);
    if (!s) break;
    chain.push(s);
    cur = s.basedOn;
  }

  let outlineLvl: number | undefined;
  let bold: boolean | undefined;
  let fontSizePt: number | undefined;
  let align: ParagraphAlign | undefined;
  let spaceBeforePt: number | undefined;
  let spaceAfterPt: number | undefined;
  let indentLeftPt: number | undefined;
  let indentRightPt: number | undefined;
  let numId: string | undefined;
  let ilvl: number | undefined;
  let vanish: boolean | undefined;

  // Apply from base style up to child style so child overrides base.
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i]!;
    if (s.outlineLvl !== undefined) outlineLvl = s.outlineLvl;
    if (s.bold !== undefined) bold = s.bold;
    if (s.fontSizePt !== undefined) fontSizePt = s.fontSizePt;
    if (s.align !== undefined) align = s.align;
    if (s.spaceBeforePt !== undefined) spaceBeforePt = s.spaceBeforePt;
    if (s.spaceAfterPt !== undefined) spaceAfterPt = s.spaceAfterPt;
    if (s.indentLeftPt !== undefined) indentLeftPt = s.indentLeftPt;
    if (s.indentRightPt !== undefined) indentRightPt = s.indentRightPt;
    if (s.numId !== undefined) numId = s.numId;
    if (s.ilvl !== undefined) ilvl = s.ilvl;
    if (s.vanish !== undefined) vanish = s.vanish;
  }

  const topStyle = chain[0];
  const headingLevel = inferHeadingLevel(topStyle, outlineLvl);
  let resolvedSize = fontSizePt ?? styles.defaultFontSizePt;
  let resolvedBold = bold ?? false;
  let resolvedBefore = spaceBeforePt ?? styles.defaultSpaceBeforePt;
  let resolvedAfter = spaceAfterPt ?? styles.defaultSpaceAfterPt;

  if (headingLevel === 1) {
    resolvedBold = bold ?? true;
    resolvedSize = Math.max(resolvedSize, 15);
    resolvedBefore = Math.max(resolvedBefore, 10);
    resolvedAfter = Math.max(resolvedAfter, 6);
  } else if (headingLevel === 2) {
    resolvedBold = bold ?? true;
    resolvedSize = Math.max(resolvedSize, 13);
    resolvedBefore = Math.max(resolvedBefore, 8);
    resolvedAfter = Math.max(resolvedAfter, 5);
  } else if (headingLevel !== undefined) {
    resolvedBold = bold ?? true;
    resolvedSize = Math.max(resolvedSize, 12);
    resolvedBefore = Math.max(resolvedBefore, 6);
    resolvedAfter = Math.max(resolvedAfter, 4);
  }

  return {
    outlineLvl,
    headingLevel,
    bold: resolvedBold,
    fontSizePt: clampFontSizePt(resolvedSize),
    align: align ?? 'left',
    spaceBeforePt: Math.min(36, resolvedBefore),
    spaceAfterPt: Math.min(36, resolvedAfter),
    indentLeftPt: Math.max(0, indentLeftPt ?? 0),
    indentRightPt: Math.max(0, indentRightPt ?? 0),
    numId,
    ilvl: Math.min(8, Math.max(0, ilvl ?? 0)),
    vanish: vanish ?? false,
  };
}

function parseNumberingXml(root: XmlElement | null): NumberingDefs {
  const abstracts = new Map<string, AbstractNumDef>();
  const nums = new Map<string, ConcreteNumDef>();
  if (!root) return { abstracts, nums };

  const numberingElem = findChild(root, 'w:numbering');
  if (!numberingElem) return { abstracts, nums };

  for (const child of childElements(numberingElem)) {
    if (child.name === 'w:abstractNum') {
      const abstractNumId = child.attrs['w:abstractNumId'];
      if (!abstractNumId) continue;
      const levels = new Map<number, NumberingLevel>();
      for (const lvl of childElements(child)) {
        if (lvl.name !== 'w:lvl') continue;
        const ilvl = parseIntAttr(lvl.attrs['w:ilvl']);
        if (ilvl === undefined || ilvl < 0) continue;
        const numFmt = findChild(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'decimal';
        const lvlText = findChild(lvl, 'w:lvlText')?.attrs['w:val'] ?? (numFmt === 'bullet' ? '•' : '%1.');
        const start = parseIntAttr(findChild(lvl, 'w:start')?.attrs['w:val']) ?? 1;
        levels.set(ilvl, { numFmt, lvlText, start });
      }
      abstracts.set(abstractNumId, { levels });
    } else if (child.name === 'w:num') {
      const numId = child.attrs['w:numId'];
      const abstractNumId = findChild(child, 'w:abstractNumId')?.attrs['w:val'];
      if (!numId || !abstractNumId) continue;
      const startOverrides = new Map<number, number>();
      for (const ov of childElements(child)) {
        if (ov.name !== 'w:lvlOverride') continue;
        const ilvl = parseIntAttr(ov.attrs['w:ilvl']);
        const start = parseIntAttr(findChild(ov, 'w:startOverride')?.attrs['w:val']);
        if (ilvl !== undefined && start !== undefined) startOverrides.set(ilvl, start);
      }
      nums.set(numId, { abstractNumId, startOverrides });
    }
  }

  return { abstracts, nums };
}

function toRoman(num: number): string {
  if (num <= 0 || num > 3999) return String(num);
  const pairs: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let rem = num;
  let out = '';
  for (const [val, sym] of pairs) {
    while (rem >= val) {
      out += sym;
      rem -= val;
    }
  }
  return out;
}

function toAlphabetic(num: number): string {
  if (num <= 0) return String(num);
  let n = num;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function formatListNumber(val: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter':
      return toAlphabetic(val);
    case 'upperLetter':
      return toAlphabetic(val).toUpperCase();
    case 'lowerRoman':
      return toRoman(val);
    case 'upperRoman':
      return toRoman(val).toUpperCase();
    default:
      return String(val);
  }
}

function nextListPrefix(
  numbering: NumberingDefs,
  counters: Map<string, number>,
  numId: string,
  ilvl: number,
): string {
  if (numId === '0') return '';
  const numDef = numbering.nums.get(numId);
  const absDef = numDef ? numbering.abstracts.get(numDef.abstractNumId) : undefined;
  const levelDef = absDef?.levels.get(ilvl);
  const numFmt = levelDef?.numFmt ?? 'bullet';
  if (numFmt === 'none') return '';
  if (numFmt === 'bullet') return '• ';

  const key = `${numId}:${ilvl}`;
  const start = numDef?.startOverrides.get(ilvl) ?? levelDef?.start ?? 1;
  const nextVal = (counters.get(key) ?? start - 1) + 1;
  counters.set(key, nextVal);

  // Reset deeper levels inside this numId when advancing a parent level.
  for (let sub = ilvl + 1; sub <= 8; sub++) {
    counters.delete(`${numId}:${sub}`);
  }

  const template = levelDef?.lvlText || '%1.';
  const formatted = template.replace(/%([1-9])/g, (_, rawLv: string) => {
    const refIdx = Number.parseInt(rawLv, 10) - 1;
    const refLevelDef = absDef?.levels.get(refIdx);
    const refFmt = refLevelDef?.numFmt ?? numFmt;
    const refVal =
      refIdx === ilvl
        ? nextVal
        : (counters.get(`${numId}:${refIdx}`) ?? numDef?.startOverrides.get(refIdx) ?? refLevelDef?.start ?? 1);
    return formatListNumber(refVal, refFmt);
  });
  return `${formatted.trimEnd()} `;
}

function scanNonBodyWarnings(node: XmlElement, warnings: Set<DocxToPdfWarning>): void {
  const stack: XmlElement[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (FLOATING_SHAPE_TAGS.has(cur.name)) warnings.add('floating_shapes_skipped');
    if (IMAGE_TAGS.has(cur.name)) warnings.add('images_skipped');
    if (OLE_TAGS.has(cur.name)) warnings.add('ole_objects_skipped');
    if (cur.name === 'w:footnoteReference' || cur.name === 'w:endnoteReference') {
      warnings.add('footnotes_skipped');
    }
    if (cur.name === 'w:cols') {
      const cols = parseIntAttr(cur.attrs['w:num']);
      if (cols !== undefined && cols > 1) warnings.add('complex_columns_simplified');
    }
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const ch = cur.children[i]!;
      if (isXmlElement(ch)) stack.push(ch);
    }
  }
}

function collectSectionWarnings(sectPr: XmlElement, hasHeaderOrFooterParts: boolean, hasNonEmptyHeaderFooterPart: boolean, warnings: Set<DocxToPdfWarning>): void {
  const cols = parseIntAttr(findChild(sectPr, 'w:cols')?.attrs['w:num']);
  if (cols !== undefined && cols > 1) {
    warnings.add('complex_columns_simplified');
  }
  const hasRef = childElements(sectPr).some((ch) => ch.name === 'w:headerReference' || ch.name === 'w:footerReference');
  if (hasRef && (hasNonEmptyHeaderFooterPart || !hasHeaderOrFooterParts)) {
    warnings.add('headers_footers_simplified');
  }
}

function isSectionPageBreak(sectPr: XmlElement): boolean {
  const type = findChild(sectPr, 'w:type')?.attrs['w:val'];
  return type !== 'continuous';
}

interface ExtractContext {
  styles: ParsedStyles;
  numbering: NumberingDefs;
  counters: Map<string, number>;
  warnings: Set<DocxToPdfWarning>;
  hasHeaderOrFooterParts: boolean;
  hasNonEmptyHeaderFooterPart: boolean;
  totalTextChars: number;
}

function extractParagraphBlocks(pNode: XmlElement, ctx: ExtractContext): DocBlock[] {
  const pPr = findChild(pNode, 'w:pPr');
  const pMeta = parseParagraphPropsMeta(pPr);
  const resolved = resolveStyle(ctx.styles, pMeta.pStyle);
  const pMarkRunMeta = parseRunPropsMeta(pPr ? findChild(pPr, 'w:rPr') : undefined);
  if (pMarkRunMeta.vanish === true || (resolved.vanish && pMarkRunMeta.vanish !== false)) {
    throw new DocxError('Tệp Word có chứa văn bản ẩn (hidden text); vui lòng hiện hoặc xóa nội dung ẩn trước khi tải lên');
  }

  const align = pMeta.align ?? resolved.align;
  const defaultFontSizePt = pMarkRunMeta.fontSizePt ?? resolved.fontSizePt;
  const defaultBold = pMarkRunMeta.bold ?? resolved.bold;
  const spaceBeforePt = pMeta.spaceBeforePt ?? resolved.spaceBeforePt;
  const spaceAfterPt = pMeta.spaceAfterPt ?? resolved.spaceAfterPt;
  const rawIndentLeftPt = Math.max(0, pMeta.indentLeftPt ?? resolved.indentLeftPt);
  const rawIndentRightPt = Math.max(0, pMeta.indentRightPt ?? resolved.indentRightPt);
  let indentLeftPt = Math.min(rawIndentLeftPt, MAX_PARAGRAPH_INDENT_SUM_PT);
  const indentRightPt = Math.min(rawIndentRightPt, Math.max(0, MAX_PARAGRAPH_INDENT_SUM_PT - indentLeftPt));
  if (indentLeftPt !== rawIndentLeftPt || indentRightPt !== rawIndentRightPt) {
    ctx.warnings.add('complex_columns_simplified');
  }
  const headingLevel = pMeta.outlineLvl !== undefined ? pMeta.outlineLvl + 1 : resolved.headingLevel;

  const numId = pMeta.numId ?? resolved.numId;
  const ilvl = Math.min(8, Math.max(0, pMeta.ilvl ?? resolved.ilvl));
  let listPrefix = '';
  if (numId !== undefined && numId !== '0') {
    listPrefix = nextListPrefix(ctx.numbering, ctx.counters, numId, ilvl);
    if (pMeta.indentLeftPt === undefined && indentLeftPt === 0) {
      indentLeftPt = Math.min((ilvl + 1) * 16, Math.max(0, MAX_PARAGRAPH_INDENT_SUM_PT - indentRightPt));
    }
  }

  const segments: Array<{ kind: 'runs'; runs: RawRun[] } | { kind: 'page_break' }> = [];
  let currentRuns: RawRun[] = [];
  let paragraphTextChars = 0;
  const trackTextBudget = (addedLength: number) => {
    paragraphTextChars += addedLength;
    if (paragraphTextChars > MAX_DOCX_PARAGRAPH_CHARS) {
      throw new DocxError('Đoạn văn bản trong tệp Word vượt quá giới hạn độ dài cho phép (100.000 ký tự)');
    }
    ctx.totalTextChars += addedLength;
    if (ctx.totalTextChars > MAX_DOCX_TOTAL_CHARS) {
      throw new DocxError('Tổng độ dài văn bản trong tệp Word vượt quá giới hạn cho phép (500.000 ký tự)');
    }
  };
  if (listPrefix.length > 0) {
    trackTextBudget(listPrefix.length);
    currentRuns.push({ text: listPrefix, bold: defaultBold, fontSizePt: defaultFontSizePt });
  }

  const flushRuns = () => {
    segments.push({ kind: 'runs', runs: currentRuns });
    currentRuns = [];
  };

  const appendRunText = (text: string, bold: boolean, fontSizePt: number) => {
    if (!text) return;
    trackTextBudget(text.length);
    const prev = currentRuns[currentRuns.length - 1];
    if (prev && prev.bold === bold && prev.fontSizePt === fontSizePt) {
      prev.text += text;
    } else {
      currentRuns.push({ text, bold, fontSizePt });
    }
  };

  const walkRun = (rNode: XmlElement) => {
    const rMeta = parseRunPropsMeta(findChild(rNode, 'w:rPr'));
    const charStyle = rMeta.rStyle ? resolveStyle(ctx.styles, rMeta.rStyle) : undefined;
    if (rMeta.vanish === true || (charStyle?.vanish && rMeta.vanish !== false)) {
      throw new DocxError('Tệp Word có chứa văn bản ẩn (hidden text); vui lòng hiện hoặc xóa nội dung ẩn trước khi tải lên');
    }
    const bold = rMeta.bold ?? charStyle?.bold ?? defaultBold;
    const fontSizePt = rMeta.fontSizePt ?? charStyle?.fontSizePt ?? defaultFontSizePt;

    const walkRunChild = (ch: XmlElement) => {
      if (ch.name === 'w:t') {
        appendRunText(elementText(ch), bold, fontSizePt);
      } else if (ch.name === 'w:tab') {
        appendRunText('    ', bold, fontSizePt);
      } else if (ch.name === 'w:noBreakHyphen') {
        appendRunText('-', bold, fontSizePt);
      } else if (ch.name === 'w:br' || ch.name === 'w:cr') {
        if (ch.name === 'w:br' && ch.attrs['w:type'] === 'page') {
          flushRuns();
          segments.push({ kind: 'page_break' });
        } else {
          appendRunText('\n', bold, fontSizePt);
        }
      } else if (ch.name === 'w:drawing' || ch.name === 'w:pict') {
        scanNonBodyWarnings(ch, ctx.warnings);
      } else if (ch.name === 'w:object') {
        ctx.warnings.add('ole_objects_skipped');
      } else if (ch.name === 'w:footnoteReference' || ch.name === 'w:endnoteReference') {
        ctx.warnings.add('footnotes_skipped');
      } else if (ch.name === 'mc:AlternateContent') {
        const choice = findChild(ch, 'mc:Choice') ?? findChild(ch, 'mc:Fallback');
        if (choice) {
          for (const inner of childElements(choice)) {
            walkRunChild(inner);
          }
        }
      }
    };

    for (const ch of childElements(rNode)) {
      walkRunChild(ch);
    }
  };

  const walkContainer = (container: XmlElement) => {
    for (const ch of childElements(container)) {
      if (ch.name === 'w:r') {
        walkRun(ch);
      } else if (ch.name === 'w:hyperlink' || ch.name === 'w:fldSimple' || ch.name === 'w:smartTag') {
        walkContainer(ch);
      } else if (ch.name === 'w:sdt') {
        const content = findChild(ch, 'w:sdtContent');
        if (content) walkContainer(content);
      } else if (ch.name === 'mc:AlternateContent') {
        const choice = findChild(ch, 'mc:Choice') ?? findChild(ch, 'mc:Fallback');
        if (choice) walkContainer(choice);
      } else if (ch.name === 'w:object') {
        ctx.warnings.add('ole_objects_skipped');
      } else if (ch.name === 'w:drawing' || ch.name === 'w:pict') {
        scanNonBodyWarnings(ch, ctx.warnings);
      }
    }
  };

  walkContainer(pNode);
  flushRuns();

  const blocks: DocBlock[] = [];
  let isFirstParagraphSegment = true;
  for (const seg of segments) {
    if (seg.kind === 'page_break') {
      blocks.push({ kind: 'page_break' });
      continue;
    }
    const pBlock: DocParagraph = {
      kind: 'paragraph',
      runs: seg.runs,
      align,
      defaultFontSizePt,
      spaceBeforePt: isFirstParagraphSegment ? spaceBeforePt : 0,
      spaceAfterPt,
      indentLeftPt,
      indentRightPt,
      headingLevel,
      pageBreakBefore: isFirstParagraphSegment && pMeta.pageBreakBefore === true,
    };
    blocks.push(pBlock);
    isFirstParagraphSegment = false;
  }

  // Section break inside paragraph properties ends the section after the paragraph.
  const pSectPr = pPr ? findChild(pPr, 'w:sectPr') : undefined;
  if (pSectPr) {
    collectSectionWarnings(pSectPr, ctx.hasHeaderOrFooterParts, ctx.hasNonEmptyHeaderFooterPart, ctx.warnings);
    if (isSectionPageBreak(pSectPr)) {
      blocks.push({ kind: 'page_break' });
    }
  }

  return blocks;
}

function borderEnabled(borderNode: XmlElement | undefined): boolean | undefined {
  if (!borderNode) return undefined;
  const val = borderNode.attrs['w:val']?.trim().toLowerCase();
  if (!val) return undefined;
  return val !== 'none' && val !== 'nil';
}

function parseBorderSet(node: XmlElement | undefined): {
  top?: boolean | undefined;
  bottom?: boolean | undefined;
  left?: boolean | undefined;
  right?: boolean | undefined;
  insideH?: boolean | undefined;
  insideV?: boolean | undefined;
} {
  if (!node) return {};
  return {
    top: borderEnabled(findChild(node, 'w:top')),
    bottom: borderEnabled(findChild(node, 'w:bottom')),
    left: borderEnabled(findChild(node, 'w:left') ?? findChild(node, 'w:start')),
    right: borderEnabled(findChild(node, 'w:right') ?? findChild(node, 'w:end')),
    insideH: borderEnabled(findChild(node, 'w:insideH')),
    insideV: borderEnabled(findChild(node, 'w:insideV')),
  };
}

function extractNestedCellParagraphs(container: XmlElement, ctx: ExtractContext): DocParagraph[] {
  const out: DocParagraph[] = [];
  for (const ch of childElements(container)) {
    if (ch.name === 'w:p') {
      for (const b of extractParagraphBlocks(ch, ctx)) {
        if (b.kind === 'paragraph') out.push(b);
      }
    } else if (ch.name === 'w:tbl') {
      ctx.warnings.add('complex_columns_simplified');
      for (const tr of childElements(ch)) {
        if (tr.name !== 'w:tr') continue;
        for (const tc of childElements(tr)) {
          if (tc.name !== 'w:tc') continue;
          out.push(...extractNestedCellParagraphs(tc, ctx));
        }
      }
    } else if (ch.name === 'w:sdt') {
      const content = findChild(ch, 'w:sdtContent');
      if (content) out.push(...extractNestedCellParagraphs(content, ctx));
    }
  }
  return out;
}

function extractTableBlock(tblNode: XmlElement, ctx: ExtractContext): DocTable | null {
  const tblPr = findChild(tblNode, 'w:tblPr');
  const tblBorders = parseBorderSet(tblPr ? findChild(tblPr, 'w:tblBorders') : undefined);
  const gridCols: number[] = [];
  const tblGrid = findChild(tblNode, 'w:tblGrid');
  if (tblGrid) {
    for (const col of childElements(tblGrid)) {
      if (col.name !== 'w:gridCol') continue;
      const w = parseIntAttr(col.attrs['w:w']);
      if (w !== undefined && w > 0) gridCols.push(w);
    }
  }

  const rowsRaw: XmlElement[] = [];
  for (const ch of childElements(tblNode)) {
    if (ch.name === 'w:tr') rowsRaw.push(ch);
  }
  if (rowsRaw.length === 0) return null;

  let maxCols = gridCols.length;
  for (const tr of rowsRaw) {
    let count = 0;
    for (const tc of childElements(tr)) {
      if (tc.name === 'w:tc') count++;
    }
    if (count > maxCols) maxCols = count;
  }
  if (maxCols === 0) return null;

  const colCount = Math.min(16, maxCols);
  if (maxCols > 16) ctx.warnings.add('complex_columns_simplified');

  const rawWidths = Array.from({ length: colCount }, () => 1);
  for (let i = 0; i < colCount; i++) {
    if (gridCols[i] !== undefined) rawWidths[i] = gridCols[i]!;
  }
  const widthSum = rawWidths.reduce((a, b) => a + b, 0);
  const colFractions = rawWidths.map((w) => w / widthSum);

  const defaultOuterTop = tblBorders.top ?? true;
  const defaultOuterBottom = tblBorders.bottom ?? true;
  const defaultOuterLeft = tblBorders.left ?? true;
  const defaultOuterRight = tblBorders.right ?? true;
  const defaultInsideH = tblBorders.insideH ?? true;
  const defaultInsideV = tblBorders.insideV ?? true;

  const rows: DocTableCell[][] = rowsRaw.map((tr, rIdx) => {
    const tcNodes = childElements(tr).filter((c) => c.name === 'w:tc').slice(0, colCount);
    const cells: DocTableCell[] = [];
    for (let cIdx = 0; cIdx < colCount; cIdx++) {
      const tc = tcNodes[cIdx];
      if (!tc) {
        cells.push({
          paragraphs: [],
          borders: {
            top: rIdx === 0 ? defaultOuterTop : defaultInsideH,
            bottom: rIdx === rowsRaw.length - 1 ? defaultOuterBottom : defaultInsideH,
            left: cIdx === 0 ? defaultOuterLeft : defaultInsideV,
            right: cIdx === colCount - 1 ? defaultOuterRight : defaultInsideV,
          },
        });
        continue;
      }
      const tcPr = findChild(tc, 'w:tcPr');
      if (tcPr) {
        const span = parseIntAttr(findChild(tcPr, 'w:gridSpan')?.attrs['w:val']);
        if ((span !== undefined && span > 1) || findChild(tcPr, 'w:vMerge')) {
          ctx.warnings.add('complex_columns_simplified');
        }
      }
      const tcBorders = parseBorderSet(tcPr ? findChild(tcPr, 'w:tcBorders') : undefined);
      const paragraphs = extractNestedCellParagraphs(tc, ctx);
      cells.push({
        paragraphs,
        borders: {
          top: tcBorders.top ?? (rIdx === 0 ? defaultOuterTop : defaultInsideH),
          bottom: tcBorders.bottom ?? (rIdx === rowsRaw.length - 1 ? defaultOuterBottom : defaultInsideH),
          left: tcBorders.left ?? (cIdx === 0 ? defaultOuterLeft : defaultInsideV),
          right: tcBorders.right ?? (cIdx === colCount - 1 ? defaultOuterRight : defaultInsideV),
        },
      });
    }
    return cells;
  });

  return { kind: 'table', colFractions, rows };
}

function hasHeaderFooterContent(root: XmlElement): boolean {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.name === 'w:t' && elementText(cur).trim().length > 0) return true;
    if (cur.name === 'w:drawing' || cur.name === 'w:pict' || cur.name === 'w:tbl') return true;
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const ch = cur.children[i]!;
      if (isXmlElement(ch)) stack.push(ch);
    }
  }
  return false;
}

function findTagIntervals(text: string): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  if (!text.includes('{{')) return intervals;
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('{{', pos);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    if (close === -1) break;
    const innerOpen = text.lastIndexOf('{{', close - 1);
    const actualOpen = innerOpen > open ? innerOpen : open;
    const end = close + 2;
    const span = text.slice(actualOpen, end);
    if (!span.includes('\n') && span.length <= 1250) {
      intervals.push([actualOpen, end]);
    }
    pos = end;
  }
  return intervals;
}

function buildLineTokens(paragraph: DocParagraph): RenderToken[][] {
  if (paragraph.runs.length === 0) return [[]];

  let totalChars = 0;
  for (const run of paragraph.runs) {
    totalChars += run.text.length;
  }
  if (totalChars > MAX_DOCX_PARAGRAPH_CHARS) {
    throw new DocxError('Đoạn văn bản trong tệp Word vượt quá giới hạn độ dài cho phép (100.000 ký tự)');
  }
  if (totalChars === 0) return [[]];

  let fullText = '';
  const charStyles: Array<{ weight: FontWeight; sizePt: number }> = [];
  for (const run of paragraph.runs) {
    const weight: FontWeight = run.bold ? 'bold' : 'regular';
    const sizePt = run.fontSizePt;
    for (let i = 0; i < run.text.length; i++) {
      fullText += run.text[i]!;
      charStyles.push({ weight, sizePt });
    }
  }

  // Unify styling inside each {{...}} tag so run splits inside placeholders never split a tag in PDF.
  const tagIntervals = findTagIntervals(fullText);
  const tagEndAt = new Map<number, number>();
  for (const [start, end] of tagIntervals) {
    const baseStyle = charStyles[start]!;
    for (let i = start; i < end; i++) charStyles[i] = baseStyle;
    tagEndAt.set(start, end);
  }

  const lines: RenderToken[][] = [];
  let curTokens: RenderToken[] = [];

  let i = 0;
  while (i < fullText.length) {
    if (fullText[i] === '\n') {
      lines.push(curTokens);
      curTokens = [];
      i++;
      continue;
    }

    const tagEnd = tagEndAt.get(i);
    if (tagEnd !== undefined) {
      const style = charStyles[i]!;
      curTokens.push({
        text: fullText.slice(i, tagEnd),
        weight: style.weight,
        sizePt: style.sizePt,
        whitespace: false,
        isTag: true,
      });
      i = tagEnd;
      continue;
    }

    if (fullText[i] === ' ' || fullText[i] === '\t') {
      const style = charStyles[i]!;
      let j = i;
      let text = '';
      while (j < fullText.length && (fullText[j] === ' ' || fullText[j] === '\t')) {
        text += fullText[j] === '\t' ? '    ' : ' ';
        j++;
      }
      curTokens.push({
        text,
        weight: style.weight,
        sizePt: style.sizePt,
        whitespace: true,
        isTag: false,
      });
      i = j;
      continue;
    }

    const style = charStyles[i]!;
    let j = i + 1;
    while (
      j < fullText.length &&
      fullText[j] !== '\n' &&
      fullText[j] !== ' ' &&
      fullText[j] !== '\t' &&
      !tagEndAt.has(j) &&
      charStyles[j]!.weight === style.weight &&
      charStyles[j]!.sizePt === style.sizePt
    ) {
      j++;
    }
    curTokens.push({
      text: fullText.slice(i, j),
      weight: style.weight,
      sizePt: style.sizePt,
      whitespace: false,
      isTag: false,
    });
    i = j;
  }

  lines.push(curTokens);
  return lines;
}

function mergeLineSpans(tokens: RenderToken[]): { spans: RenderSpan[]; hasTag: boolean } {
  const spans: RenderSpan[] = [];
  let hasTag = false;
  for (const tok of tokens) {
    if (tok.isTag) hasTag = true;
    const prev = spans[spans.length - 1];
    if (prev && prev.weight === tok.weight && prev.sizePt === tok.sizePt) {
      prev.text += tok.text;
    } else {
      spans.push({ text: tok.text, weight: tok.weight, sizePt: tok.sizePt });
    }
  }
  return { spans, hasTag };
}

async function fitTagFontSize(
  fonts: PdfFontContext,
  text: string,
  weight: FontWeight,
  sizePt: number,
  maxWidthPt: number,
): Promise<number> {
  let candidate = sizePt;
  while (candidate > 6 && (await fonts.measureWidth(text, weight, candidate)) > maxWidthPt) {
    candidate = Math.max(6, candidate - 1);
  }
  return candidate;
}

async function wrapParagraphLayout(
  fonts: PdfFontContext,
  paragraph: DocParagraph,
  maxWidthPt: number,
): Promise<ParagraphLayout> {
  const minFloor = Math.min(Math.max(1, maxWidthPt), 24);
  const safeMax = Math.max(minFloor, maxWidthPt - paragraph.indentLeftPt - paragraph.indentRightPt);
  const rawLines = buildLineTokens(paragraph);
  const wrappedLines: WrappedLine[] = [];

  for (const rawTokens of rawLines) {
    if (rawTokens.length === 0) {
      wrappedLines.push({
        spans: [],
        widthPt: 0,
        fontSizePt: paragraph.defaultFontSizePt,
        hasTag: false,
      });
      continue;
    }

    let lineTokens: RenderToken[] = [];
    let lineWidth = 0;

    const flushLine = () => {
      while (lineTokens.length > 0 && lineTokens[lineTokens.length - 1]!.whitespace) {
        lineTokens.pop();
      }
      const { spans, hasTag } = mergeLineSpans(lineTokens);
      let maxFont = paragraph.defaultFontSizePt;
      for (const s of spans) {
        if (s.sizePt > maxFont) maxFont = s.sizePt;
      }
      wrappedLines.push({
        spans,
        widthPt: spans.length === 0 ? 0 : lineWidth,
        fontSizePt: maxFont,
        hasTag,
      });
      lineTokens = [];
      lineWidth = 0;
    };

    for (const tok of rawTokens) {
      if (tok.whitespace && lineTokens.length === 0) {
        continue;
      }
      let tokSize = tok.sizePt;
      let tokWidth = await fonts.measureWidth(tok.text, tok.weight, tokSize);

      if (tok.isTag && tokWidth > safeMax) {
        tokSize = await fitTagFontSize(fonts, tok.text, tok.weight, tokSize, safeMax);
        tokWidth = await fonts.measureWidth(tok.text, tok.weight, tokSize);
      }

      if (lineTokens.length > 0 && lineWidth + tokWidth > safeMax) {
        // Trim width before flushing if trailing whitespace exists.
        while (lineTokens.length > 0 && lineTokens[lineTokens.length - 1]!.whitespace) {
          const popped = lineTokens.pop()!;
          lineWidth -= await fonts.measureWidth(popped.text, popped.weight, popped.sizePt);
        }
        if (lineTokens.length > 0) flushLine();
        if (tok.whitespace) continue;
      }

      if (!tok.isTag && !tok.whitespace && tokWidth > safeMax && lineTokens.length === 0) {
        const pieces = await fonts.wrapLines(tok.text, tok.weight, tokSize, safeMax);
        for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
          const piece = pieces[pIdx]!;
          const pieceWidth = await fonts.measureWidth(piece, tok.weight, tokSize);
          lineTokens = [{ text: piece, weight: tok.weight, sizePt: tokSize, whitespace: false, isTag: false }];
          lineWidth = pieceWidth;
          if (pIdx < pieces.length - 1) flushLine();
        }
        continue;
      }

      lineTokens.push(tokSize === tok.sizePt ? tok : { ...tok, sizePt: tokSize });
      lineWidth += tokWidth;
    }

    if (lineTokens.length > 0 || wrappedLines.length === 0) {
      flushLine();
    }
  }

  return {
    lines: wrappedLines,
    spaceBeforePt: paragraph.spaceBeforePt,
    spaceAfterPt: paragraph.spaceAfterPt,
    indentLeftPt: paragraph.indentLeftPt,
    indentRightPt: paragraph.indentRightPt,
    align: paragraph.align,
    isHeading: paragraph.headingLevel !== undefined,
  };
}

class PdfPaginator {
  readonly pdfDoc: PDFDocument;
  readonly fonts: PdfFontContext;
  private readonly warnings: Set<DocxToPdfWarning>;
  private page: PDFPage | null = null;
  private cursorY = A4_HEIGHT - MARGIN_TOP;
  private pendingBreak = false;

  constructor(pdfDoc: PDFDocument, fonts: PdfFontContext, warnings: Set<DocxToPdfWarning>) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts;
    this.warnings = warnings;
  }

  private allocatePage(): PDFPage {
    if (this.pdfDoc.getPageCount() >= EXTRACT_LIMITS.maxPdfSignPages) {
      throw new DocxError(`Tài liệu sau khi chuyển đổi vượt quá giới hạn ${EXTRACT_LIMITS.maxPdfSignPages} trang`);
    }
    this.page = this.pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
    this.cursorY = A4_HEIGHT - MARGIN_TOP;
    this.pendingBreak = false;
    return this.page;
  }

  ensurePage(): PDFPage {
    if (!this.page || this.pendingBreak) {
      return this.allocatePage();
    }
    return this.page;
  }

  requestPageBreak(): void {
    if (this.page) {
      this.pendingBreak = true;
    }
  }

  remainingHeight(): number {
    if (!this.page || this.pendingBreak) return USABLE_PAGE_HEIGHT;
    return Math.max(0, this.cursorY - MARGIN_BOTTOM);
  }

  currentY(): number {
    return this.cursorY;
  }

  advanceY(delta: number): void {
    this.cursorY -= delta;
  }

  ensureAtLeast1Page(): void {
    if (this.pdfDoc.getPageCount() === 0) {
      this.allocatePage();
    }
  }

  async drawParagraph(layout: ParagraphLayout): Promise<void> {
    this.ensurePage();
    const firstLine = layout.lines[0];
    const firstLineHeight = (firstLine?.fontSizePt ?? DEFAULT_FONT_SIZE_PT) * LINE_HEIGHT_RATIO;
    const minNeeded = (this.cursorY < A4_HEIGHT - MARGIN_TOP ? layout.spaceBeforePt : 0) + firstLineHeight * (layout.isHeading ? 2 : 1);

    if (this.remainingHeight() < minNeeded) {
      this.allocatePage();
    } else if (this.cursorY < A4_HEIGHT - MARGIN_TOP) {
      this.cursorY -= layout.spaceBeforePt;
    }

    const baseX = MARGIN_X + layout.indentLeftPt;
    const usableW = Math.max(24, CONTENT_WIDTH - layout.indentLeftPt - layout.indentRightPt);

    for (const line of layout.lines) {
      const lineHeight = line.fontSizePt * LINE_HEIGHT_RATIO;
      if (this.cursorY - lineHeight < MARGIN_BOTTOM) {
        this.allocatePage();
      }
      const baselineY = this.cursorY - line.fontSizePt;
      if (line.spans.length > 0) {
        let drawX = baseX;
        if (layout.align === 'center') {
          drawX = baseX + Math.max(0, (usableW - line.widthPt) / 2);
        } else if (layout.align === 'right') {
          drawX = baseX + Math.max(0, usableW - line.widthPt);
        }
        for (const span of line.spans) {
          const drawnW = await this.fonts.drawText(this.page!, span.text, {
            weight: span.weight,
            sizePt: span.sizePt,
            color: TEXT_COLOR,
            x: drawX,
            y: baselineY,
          });
          drawX += drawnW;
        }
      }
      this.cursorY -= lineHeight;
    }

    this.cursorY = Math.max(MARGIN_BOTTOM, this.cursorY - layout.spaceAfterPt);
  }

  async drawTable(table: DocTable): Promise<void> {
    this.ensurePage();
    if (this.cursorY < A4_HEIGHT - MARGIN_TOP) {
      this.cursorY = Math.max(MARGIN_BOTTOM, this.cursorY - 4);
    }

    const colWidths = table.colFractions.map((f) => f * CONTENT_WIDTH);
    const colOffsets: number[] = [];
    let accX = MARGIN_X;
    for (const w of colWidths) {
      colOffsets.push(accX);
      accX += w;
    }

    for (const row of table.rows) {
      const cellLayouts: ParagraphLayout[][] = [];
      let rowContentHeight = 0;

      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const cell = row[cIdx]!;
        const innerW = Math.max(1, colWidths[cIdx]! - TABLE_CELL_PAD_X * 2);
        const layouts: ParagraphLayout[] = [];
        let cellH = 0;
        for (let pIdx = 0; pIdx < cell.paragraphs.length; pIdx++) {
          const para = cell.paragraphs[pIdx]!;
          const cellIndentLeft = Math.min(para.indentLeftPt, Math.max(0, innerW - Math.min(innerW, 18)));
          const wrapped = await wrapParagraphLayout(
            this.fonts,
            {
              ...para,
              indentLeftPt: cellIndentLeft,
              indentRightPt: 0,
              spaceBeforePt: 0,
              spaceAfterPt: pIdx === cell.paragraphs.length - 1 ? 0 : 4,
            },
            innerW,
          );
          layouts.push(wrapped);
          for (const line of wrapped.lines) cellH += line.fontSizePt * LINE_HEIGHT_RATIO;
          cellH += wrapped.spaceAfterPt;
        }
        cellH = Math.max(DEFAULT_FONT_SIZE_PT * LINE_HEIGHT_RATIO, cellH);
        if (cellH > rowContentHeight) rowContentHeight = cellH;
        cellLayouts.push(layouts);
      }

      const rowHeight = rowContentHeight + TABLE_CELL_PAD_Y * 2;
      if (rowHeight <= USABLE_PAGE_HEIGHT && this.remainingHeight() < rowHeight) {
        this.allocatePage();
      }

      // If a single tall row exceeds page height, fall back to sequential cell rendering across pages.
      if (rowHeight > USABLE_PAGE_HEIGHT) {
        this.warnings.add('complex_columns_simplified');
        for (let cIdx = 0; cIdx < cellLayouts.length; cIdx++) {
          for (const layout of cellLayouts[cIdx]!) {
            await this.drawParagraph(layout);
          }
        }
        continue;
      }

      const rowTopY = this.cursorY;
      const rowBottomY = rowTopY - rowHeight;
      const page = this.page!;

      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const cell = row[cIdx]!;
        const cellX = colOffsets[cIdx]!;
        const cellW = colWidths[cIdx]!;
        const innerW = Math.max(1, cellW - TABLE_CELL_PAD_X * 2);
        let cellCursorY = rowTopY - TABLE_CELL_PAD_Y;

        for (const layout of cellLayouts[cIdx]!) {
          const baseX = cellX + TABLE_CELL_PAD_X + Math.min(layout.indentLeftPt, Math.max(0, innerW - Math.min(innerW, 18)));
          const cellAlignW = Math.max(1, cellX + cellW - TABLE_CELL_PAD_X - baseX);
          for (const line of layout.lines) {
            const lineHeight = line.fontSizePt * LINE_HEIGHT_RATIO;
            const baselineY = cellCursorY - line.fontSizePt;
            if (line.spans.length > 0) {
              let drawX = baseX;
              if (layout.align === 'center') {
                drawX = baseX + Math.max(0, (cellAlignW - line.widthPt) / 2);
              } else if (layout.align === 'right') {
                drawX = baseX + Math.max(0, cellAlignW - line.widthPt);
              }
              for (const span of line.spans) {
                const drawnW = await this.fonts.drawText(page, span.text, {
                  weight: span.weight,
                  sizePt: span.sizePt,
                  color: TEXT_COLOR,
                  x: drawX,
                  y: baselineY,
                });
                drawX += drawnW;
              }
            }
            cellCursorY -= lineHeight;
          }
          cellCursorY -= layout.spaceAfterPt;
        }

        const b = cell.borders;
        if (b.top) page.drawLine({ start: { x: cellX, y: rowTopY }, end: { x: cellX + cellW, y: rowTopY }, thickness: 0.5, color: BORDER_COLOR });
        if (b.bottom) page.drawLine({ start: { x: cellX, y: rowBottomY }, end: { x: cellX + cellW, y: rowBottomY }, thickness: 0.5, color: BORDER_COLOR });
        if (b.left) page.drawLine({ start: { x: cellX, y: rowTopY }, end: { x: cellX, y: rowBottomY }, thickness: 0.5, color: BORDER_COLOR });
        if (b.right) page.drawLine({ start: { x: cellX + cellW, y: rowTopY }, end: { x: cellX + cellW, y: rowBottomY }, thickness: 0.5, color: BORDER_COLOR });
      }

      this.cursorY = rowBottomY;
    }

    this.cursorY = Math.max(MARGIN_BOTTOM, this.cursorY - 6);
  }
}

function isWantedDocxEntry(
  name: string,
  state: { sawEncryptedEntry: boolean },
  warnings: Set<DocxToPdfWarning>,
): boolean {
  const lower = name.toLowerCase();
  if (
    lower === 'encryptioninfo' ||
    lower === 'encryptedpackage' ||
    lower.endsWith('/encryptioninfo') ||
    lower.endsWith('/encryptedpackage')
  ) {
    state.sawEncryptedEntry = true;
    return false;
  }
  if (lower.startsWith('word/media/')) {
    warnings.add('images_skipped');
    return false;
  }
  if (lower.startsWith('word/embeddings/')) {
    warnings.add('ole_objects_skipped');
    return false;
  }
  if (
    lower === 'word/document.xml' ||
    lower === 'word/styles.xml' ||
    lower === 'word/numbering.xml' ||
    lower === 'word/footnotes.xml' ||
    lower === 'word/endnotes.xml'
  ) {
    return true;
  }
  return (lower.startsWith('word/header') || lower.startsWith('word/footer')) && lower.endsWith('.xml');
}

export async function convertDocxToPdf(bytes: Uint8Array): Promise<DocxToPdfResult> {
  if (bytes.byteLength === 0) {
    throw new DocxError('Tệp Word (.docx) rỗng');
  }
  if (bytes.byteLength > EXTRACT_LIMITS.maxSignDocxBytes) {
    throw new DocxError('Tệp Word (.docx) vượt quá giới hạn 10 MB');
  }
  // Refuse OLE2 Compound Binary files (encrypted OOXML containers and legacy binary .doc files).
  if (bytes.byteLength >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocxError('Không hỗ trợ tệp được mã hóa hoặc định dạng .doc cũ; vui lòng lưu lại dưới dạng .docx không mật khẩu');
  }

  const warnings = new Set<DocxToPdfWarning>();
  const zipState = { sawEncryptedEntry: false };

  let parts: Map<string, Uint8Array>;
  try {
    parts = readZipParts(bytes, (name) => isWantedDocxEntry(name, zipState, warnings), DOCX_CONVERT_ZIP_LIMITS);
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new DocxError('Không phải tệp Word (.docx) hợp lệ');
  }

  if (zipState.sawEncryptedEntry) {
    throw new DocxError('Tệp Word được đặt mật khẩu hoặc mã hóa; vui lòng lưu lại không có mật khẩu');
  }

  const docBytes = parts.get('word/document.xml');
  if (!docBytes) {
    throw new DocxError('Không phải tệp Word (.docx) hợp lệ');
  }

  const docRoot = parseXmlDocument(decodeStrictUtf8(docBytes, 'word/document.xml'), 'word/document.xml');
  enforceNoTrackChangesOrHiddenText(docRoot);

  const stylesBytes = parts.get('word/styles.xml');
  const stylesRoot = stylesBytes
    ? parseXmlDocument(decodeStrictUtf8(stylesBytes, 'word/styles.xml'), 'word/styles.xml')
    : null;
  const styles = parseStylesXml(stylesRoot);

  const numberingBytes = parts.get('word/numbering.xml');
  const numberingRoot = numberingBytes
    ? parseXmlDocument(decodeStrictUtf8(numberingBytes, 'word/numbering.xml'), 'word/numbering.xml')
    : null;
  const numbering = parseNumberingXml(numberingRoot);

  let hasHeaderOrFooterParts = false;
  let hasNonEmptyHeaderFooterPart = false;
  for (const [partName, partBytes] of parts.entries()) {
    const lower = partName.toLowerCase();
    if (lower === 'word/footnotes.xml' || lower === 'word/endnotes.xml') {
      const noteRoot = parseXmlDocument(decodeStrictUtf8(partBytes, partName), partName);
      enforceNoTrackChangesOrHiddenText(noteRoot);
    } else if ((lower.startsWith('word/header') || lower.startsWith('word/footer')) && lower.endsWith('.xml')) {
      hasHeaderOrFooterParts = true;
      const hfRoot = parseXmlDocument(decodeStrictUtf8(partBytes, partName), partName);
      enforceNoTrackChangesOrHiddenText(hfRoot);
      if (hasHeaderFooterContent(hfRoot)) {
        hasNonEmptyHeaderFooterPart = true;
        warnings.add('headers_footers_simplified');
      }
    }
  }

  const docElem = findChild(docRoot, 'w:document');
  const bodyElem = docElem ? findChild(docElem, 'w:body') : undefined;
  if (!bodyElem) {
    throw new DocxError('Không tìm thấy nội dung tài liệu trong tệp Word (.docx)');
  }

  const ctx: ExtractContext = {
    styles,
    numbering,
    counters: new Map<string, number>(),
    warnings,
    hasHeaderOrFooterParts,
    hasNonEmptyHeaderFooterPart,
    totalTextChars: 0,
  };

  const blocks: DocBlock[] = [];
  const collectBodyBlocks = (container: XmlElement): void => {
    for (const ch of childElements(container)) {
      if (ch.name === 'w:p') {
        blocks.push(...extractParagraphBlocks(ch, ctx));
      } else if (ch.name === 'w:tbl') {
        const table = extractTableBlock(ch, ctx);
        if (table) blocks.push(table);
      } else if (ch.name === 'w:sdt') {
        const content = findChild(ch, 'w:sdtContent');
        if (content) collectBodyBlocks(content);
      } else if (ch.name === 'w:sectPr') {
        collectSectionWarnings(ch, hasHeaderOrFooterParts, hasNonEmptyHeaderFooterPart, warnings);
      }
    }
  };
  collectBodyBlocks(bodyElem);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('Converted Word Contract');
  pdfDoc.setProducer('Ludy crove-extract');
  const fonts = await PdfFontContext.create(pdfDoc);
  await fonts.preloadWeight('regular');
  await fonts.preloadWeight('bold');

  const paginator = new PdfPaginator(pdfDoc, fonts, warnings);

  for (const block of blocks) {
    if (block.kind === 'page_break') {
      paginator.requestPageBreak();
      continue;
    }
    if (block.kind === 'table') {
      await paginator.drawTable(block);
      continue;
    }
    if (block.pageBreakBefore) {
      paginator.requestPageBreak();
    }
    const layout = await wrapParagraphLayout(fonts, block, CONTENT_WIDTH);
    await paginator.drawParagraph(layout);
  }

  paginator.ensureAtLeast1Page();

  const pdfBytes = await pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
  if (pdfBytes.byteLength > EXTRACT_LIMITS.maxFileBytes) {
    throw new DocxError('Tệp PDF sau khi chuyển đổi vượt quá giới hạn 25 MB', 'output_too_large');
  }
  const pdfBase64 = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength).toString('base64');

  return {
    ok: true,
    kind: 'docx_to_pdf',
    pdfBase64,
    pageCount: pdfDoc.getPageCount(),
    warnings: [...warnings],
  };
}
