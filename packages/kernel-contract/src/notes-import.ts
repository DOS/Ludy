// SPDX-License-Identifier: AGPL-3.0-only
// Evernote (.enex) and Todoist (.csv) strict importers (#3564, docs/plan/notes-v2.md V2-9 / E5a).
// Pure, zero-dependency, isomorphic parsers and sanitizers used by both the browser dry-run preview
// and the server HTTP / Runtime execution path (zero network egress, fail-closed XXE/DTD/bounds guards).
import { z } from 'zod';
import { DEFAULT_TIME_ZONE, zTimeZone, zonedDate } from './calendar.ts';
import {
  NOTE_ATTACHMENT_EXTRACT_STATUSES,
  NOTE_ATTACHMENT_FILENAME_MAX,
  NOTE_ATTACHMENT_MAX_BYTES,
  NOTE_ATTACHMENTS_PER_NOTE_MAX,
  NOTE_BODY_MAX,
  NOTE_TAGS_MAX,
  NOTE_TAG_MAX,
  NOTE_TITLE_MAX,
  NOTEBOOK_NAME_MAX,
  TODO_DETAILS_MAX,
  TODO_LIST_NAME_MAX,
  TODO_LIST_SECTIONS_MAX,
  TODO_LIST_SECTION_NAME_MAX,
  TODO_STEPS_MAX,
  TODO_STEP_MAX,
  TODO_TITLE_MAX,
  sanitizeClipSourceUrl,
  zTodoPriority,
  zTodoStep,
  type TodoPriority,
  type TodoStep,
} from './notes.ts';
import { zId } from './schemas.ts';

export const ENEX_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ENEX_MAX_NOTES = 500;
export const ENEX_MAX_XML_DEPTH = 64;
export const ENEX_MAX_XML_NODES = 200_000;
export const ENEX_MAX_XML_ATTRS = 32;
export const ENEX_MAX_ENTITY_REFS = 200_000;
export const ENEX_MAX_NOTE_CONTENT_CHARS = 2_000_000;
export const ENEX_MAX_RESOURCES_TOTAL = 2000;
export const ENEX_MAX_RESOURCE_BASE64_CHARS = Math.ceil(NOTE_ATTACHMENT_MAX_BYTES / 3) * 4 + 4;

export const ENML_MAX_DEPTH = 64;
export const ENML_MAX_NODES = 50_000;

export const TODOIST_CSV_MAX_BYTES = 5 * 1024 * 1024;
export const TODOIST_MAX_ROWS = 2000;
export const TODOIST_MAX_TASKS = 500;
export const TODOIST_MAX_LISTS = 50;

export type NoteImportErrorCode = 'NOTE_IMPORT_INVALID' | 'NOTE_IMPORT_UNSAFE_XML' | 'NOTE_IMPORT_EMPTY' | 'TOO_LARGE' | 'NOTE_TOO_LONG' | 'NOTE_ATTACHMENT_LIMIT';
export type NoteImportErrorStatus = 400 | 413 | 422;

export interface NoteImportFailure {
  ok: false;
  code: NoteImportErrorCode;
  status: NoteImportErrorStatus;
  detail: string;
}

export interface ParsedEnexResource {
  bytes: Uint8Array;
  filename: string;
  declaredMime: string | null;
  md5Hex: string;
}

export interface ParsedEnexNote {
  title: string;
  body: string;
  tags: string[];
  notebookName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceUrl: string | null;
  resources: ParsedEnexResource[];
  strippedRemoteImages: number;
}

export interface EnexParseSuccess {
  ok: true;
  notes: ParsedEnexNote[];
  strippedRemoteImages: number;
  warnings: string[];
}

export type EnexParseResult = EnexParseSuccess | NoteImportFailure;

// ---------------------------------------------------------------------------
// Shared string, timestamp, and base64 helpers
// ---------------------------------------------------------------------------

function stripControlChars(value: string, keepNewlines = false): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (keepNewlines && (code === 0x09 || code === 0x0a)) {
      out += value[i] as string;
      continue;
    }
    if (code <= 0x1f || code === 0x7f) continue;
    out += value[i] as string;
  }
  return out;
}

function cleanSingleLine(value: string, maxLen: number): string {
  return stripControlChars(value.replace(/\s+/g, ' ').trim(), false).slice(0, maxLen).trim();
}

function normalizeImportTags(rawTags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTags) {
    const cleaned = cleanSingleLine(raw.replace(/^#+/, ''), NOTE_TAG_MAX).toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= NOTE_TAGS_MAX) break;
  }
  return out;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function parseEnexTimestamp(raw: string | null | undefined, nowMs = Date.now()): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let ms = Number.NaN;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(trimmed);
  if (compact) {
    const y = Number(compact[1]);
    const mo = Number(compact[2]);
    const d = Number(compact[3]);
    const h = Number(compact[4]);
    const mi = Number(compact[5]);
    const s = Number(compact[6]);
    if (isValidCalendarDate(y, mo, d) && h <= 23 && mi <= 59 && s <= 59) {
      ms = Date.UTC(y, mo - 1, d, h, mi, s);
    }
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  const minMs = Date.UTC(1970, 0, 1);
  const maxMs = nowMs + 86_400_000;
  if (!Number.isFinite(ms) || ms < minMs || ms > maxMs) return null;
  return new Date(ms).toISOString();
}

const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHA.length; i += 1) {
    table[B64_ALPHA.charCodeAt(i)] = i;
  }
  return table;
})();

export function decodeStrictBase64(raw: string, maxBytes = NOTE_ATTACHMENT_MAX_BYTES): Uint8Array | null {
  const maxChars = Math.ceil(maxBytes / 3) * 4 + 4;
  let clean = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    clean += raw[i] as string;
    if (clean.length > maxChars) return null;
  }
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) return null;

  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;

  const byteLength = (clean.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > maxBytes) return null;

  const out = new Uint8Array(byteLength);
  let outIdx = 0;
  const groups = clean.length / 4;
  for (let g = 0; g < groups; g += 1) {
    const idx = g * 4;
    const isLast = g === groups - 1;
    const c0 = clean.charCodeAt(idx);
    const c1 = clean.charCodeAt(idx + 1);
    const c2 = clean.charCodeAt(idx + 2);
    const c3 = clean.charCodeAt(idx + 3);
    if (c0 >= 128 || c1 >= 128 || c2 >= 128 || c3 >= 128) return null;
    const v0 = B64_LOOKUP[c0] ?? -1;
    const v1 = B64_LOOKUP[c1] ?? -1;
    if (v0 < 0 || v1 < 0) return null;
    const v2 = c2 === 0x3d && isLast ? 0 : (B64_LOOKUP[c2] ?? -1);
    const v3 = c3 === 0x3d && isLast && padding >= 1 ? 0 : (B64_LOOKUP[c3] ?? -1);
    if (c2 === 0x3d && (!isLast || padding < 2)) return null;
    if (c3 === 0x3d && !isLast) return null;
    if (v2 < 0 || v3 < 0) return null;

    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[outIdx++] = (triple >> 16) & 0xff;
    if (outIdx < byteLength) out[outIdx++] = (triple >> 8) & 0xff;
    if (outIdx < byteLength) out[outIdx++] = triple & 0xff;
  }
  return out;
}

// Non-cryptographic MD5 used strictly to correlate Evernote <en-media hash="..."> tags
// to their embedded <resource> filenames in browser preview and Markdown output.
// Storage integrity uses SHA-256 on the server.
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

export function md5Hex(bytes: Uint8Array): string {
  const bitLen = bytes.byteLength * 8;
  const paddedLen = (((bytes.byteLength + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const m = view.getUint32(offset + g * 4, true);
      const sum = (a + f + (MD5_K[i] ?? 0) + m) >>> 0;
      const shift = MD5_S[i] ?? 0;
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += (out[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Strict bounded ENEX XML parser (zero DTD / zero XXE / zero network egress)
// ---------------------------------------------------------------------------

function failImport(code: NoteImportErrorCode, status: NoteImportErrorStatus, detail: string): NoteImportFailure {
  return { ok: false, code, status, detail };
}

function isXmlWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isXmlNameChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2d ||
    code === 0x3a ||
    code === 0x2e
  );
}

function isValidXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const PREDEFINED_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string, counter: { refs: number }): string | NoteImportFailure {
  if (!text.includes('&')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf('&', i);
    if (amp === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const semi = text.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 32) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Malformed or unsafe XML entity reference');
    }
    counter.refs += 1;
    if (counter.refs > ENEX_MAX_ENTITY_REFS) {
      return failImport('TOO_LARGE', 413, 'XML entity reference limit exceeded');
    }
    const entity = text.slice(amp + 1, semi);
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const hex = entity.slice(2);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Invalid hexadecimal XML character reference');
      }
      const cp = Number.parseInt(hex, 16);
      if (!isValidXmlCodePoint(cp)) {
        return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Disallowed XML character code point');
      }
      out += String.fromCodePoint(cp);
    } else if (entity.startsWith('#')) {
      const dec = entity.slice(1);
      if (!/^[0-9]{1,7}$/.test(dec)) {
        return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Invalid numeric XML character reference');
      }
      const cp = Number.parseInt(dec, 10);
      if (!isValidXmlCodePoint(cp)) {
        return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Disallowed XML character code point');
      }
      out += String.fromCodePoint(cp);
    } else {
      const resolved = Object.hasOwn(PREDEFINED_XML_ENTITIES, entity) ? PREDEFINED_XML_ENTITIES[entity] : undefined;
      if (resolved === undefined) {
        return failImport('NOTE_IMPORT_UNSAFE_XML', 400, `Disallowed XML entity reference: &${entity};`);
      }
      out += resolved;
    }
    i = semi + 1;
  }
  return out;
}

interface ResourceBuilder {
  base64: string;
  encoding: string | null;
  mime: string;
  filename: string;
  recognitionObjId: string | null;
}

interface NoteBuilder {
  title: string;
  createdRaw: string;
  updatedRaw: string;
  tags: string[];
  notebookName: string;
  sourceUrlRaw: string;
  content: string;
  resources: ResourceBuilder[];
}

function extractRecognitionObjId(recognitionXml: string): string | null {
  const match = /\bobjID\s*=\s*["']([0-9a-fA-F]{32})["']/i.exec(recognitionXml);
  return match?.[1]?.toLowerCase() ?? null;
}

// ---------------------------------------------------------------------------
// Safe ENML / HTML to Markdown sanitizer
// ---------------------------------------------------------------------------

const HTML_VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'en-todo',
  'en-media',
  'meta',
  'link',
  'base',
  'area',
  'col',
  'embed',
  'param',
  'source',
  'track',
  'wbr',
]);

const HTML_DROP_SUBTREE_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'form',
  'textarea',
  'select',
  'button',
  'meta',
  'link',
  'base',
  'head',
  'title',
  'audio',
  'video',
  'canvas',
  'template',
]);

const SAFE_HTML_ENTITIES: Readonly<Record<string, string>> = {
  ...PREDEFINED_XML_ENTITIES,
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  bull: '*',
  middot: '*',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
  times: 'x',
  divide: '/',
  plusmn: '+/-',
  deg: ' deg',
  euro: 'EUR',
  pound: 'GBP',
  yen: 'JPY',
};

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf('&', i);
    if (amp === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const semi = text.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 16) {
      out += '&';
      i = amp + 1;
      continue;
    }
    const entity = text.slice(amp + 1, semi);
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const hex = entity.slice(2);
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        const cp = Number.parseInt(hex, 16);
        if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          out += String.fromCodePoint(cp);
          i = semi + 1;
          continue;
        }
      }
    } else if (entity.startsWith('#')) {
      const dec = entity.slice(1);
      if (/^[0-9]{1,7}$/.test(dec)) {
        const cp = Number.parseInt(dec, 10);
        if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          out += String.fromCodePoint(cp);
          i = semi + 1;
          continue;
        }
      }
    } else if (Object.hasOwn(SAFE_HTML_ENTITIES, lower)) {
      out += SAFE_HTML_ENTITIES[lower] as string;
      i = semi + 1;
      continue;
    }
    out += '&';
    i = amp + 1;
  }
  return out;
}

export function sanitizeSafeLinkUrl(raw: string): string | null {
  const decoded = decodeHtmlEntities(raw);
  const cleaned = stripControlChars(decoded, false).trim();
  if (!cleaned || cleaned.length > 2048) return null;
  // Strip any ASCII whitespace inside scheme prefix before checking protocol (defeats "java\tscript:").
  const compact = stripControlChars(cleaned, false).replace(/\s+/g, '');
  let parsed: URL;
  try {
    parsed = new URL(compact);
  } catch {
    return null;
  }
  if (parsed.protocol === 'mailto:') {
    return parsed.pathname.includes('@') && parsed.username === '' && parsed.password === '' ? parsed.toString() : null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.username !== '' || parsed.password !== '') return null;
  return parsed.toString();
}

const BENIGN_ENML_DOCTYPE =
  /^<!DOCTYPE\s+en-note\s+SYSTEM\s+(?:"https?:\/\/xml\.evernote\.com\/pub\/enml2\.dtd"|'https?:\/\/xml\.evernote\.com\/pub\/enml2\.dtd')\s*>/i;

function preprocessEnmlContent(rawContent: string): { html: string } | NoteImportFailure {
  let body = rawContent.replace(/^\uFEFF/, '');
  if (body.includes('\u0000')) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Note content contains disallowed NUL bytes');
  }
  body = body.trimStart();
  if (body.startsWith('<?')) {
    const end = body.indexOf('?>');
    if (end === -1 || !/^<\?xml\b/i.test(body.slice(0, 10))) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Unsafe XML declaration inside note content');
    }
    const decl = body.slice(0, end + 2);
    if (/<!(?:DOCTYPE|ENTITY)/i.test(decl)) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Unsafe declaration inside note content');
    }
    body = body.slice(end + 2).trimStart();
  }
  if (/^<!DOCTYPE\b/i.test(body)) {
    const match = BENIGN_ENML_DOCTYPE.exec(body);
    if (!match) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Disallowed DOCTYPE declaration inside note content');
    }
    body = body.slice(match[0].length);
  }
  // Reject any remaining DOCTYPE, ENTITY, ELEMENT, ATTLIST, NOTATION declarations anywhere in content.
  if (/<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i.test(body)) {
    return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Disallowed DTD or ENTITY declaration inside note content');
  }
  return { html: body };
}

interface HtmlListFrame {
  ordered: boolean;
  index: number;
  inItem: boolean;
  itemHasContent: boolean;
}

interface EnmlConversionResult {
  markdown: string;
  strippedRemoteImages: number;
}

function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  let count = 0;
  while (i < raw.length && count < ENEX_MAX_XML_ATTRS) {
    while (i < raw.length && isXmlWhitespace(raw[i] as string)) i += 1;
    if (i >= raw.length) break;
    const nameStart = i;
    while (i < raw.length && isXmlNameChar(raw.charCodeAt(i))) i += 1;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < raw.length && isXmlWhitespace(raw[i] as string)) i += 1;
    if (raw[i] !== '=') {
      attrs[name] = '';
      count += 1;
      continue;
    }
    i += 1;
    while (i < raw.length && isXmlWhitespace(raw[i] as string)) i += 1;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      const valStart = i;
      while (i < raw.length && raw[i] !== quote) i += 1;
      attrs[name] = decodeHtmlEntities(raw.slice(valStart, i));
      if (raw[i] === quote) i += 1;
    } else {
      const valStart = i;
      while (i < raw.length && !isXmlWhitespace(raw[i] as string)) i += 1;
      attrs[name] = decodeHtmlEntities(raw.slice(valStart, i));
    }
    count += 1;
  }
  return attrs;
}

export function convertEnmlToSafeMarkdown(
  rawContent: string,
  resourceNamesByMd5: ReadonlyMap<string, string> = new Map(),
): EnmlConversionResult | NoteImportFailure {
  if (rawContent.length > ENEX_MAX_NOTE_CONTENT_CHARS) {
    return failImport('TOO_LARGE', 413, 'Note content exceeds maximum allowed size');
  }
  const pre = preprocessEnmlContent(rawContent);
  if ('ok' in pre) return pre;
  const src = pre.html;

  const out: string[] = [];
  const tagStack: string[] = [];
  const listStack: HtmlListFrame[] = [];
  const anchorStack: Array<{ href: string | null; buf: string[] }> = [];
  let skipSubtreeTag: string | null = null;
  let skipDepth = 0;
  let preDepth = 0;
  let blockquoteDepth = 0;
  let nodeCount = 0;
  let strippedRemoteImages = 0;
  let tableRowCols: string[] | null = null;
  let tableCellBuf: string[] | null = null;

  const write = (chunk: string) => {
    if (!chunk) return;
    if (tableCellBuf !== null) {
      tableCellBuf.push(chunk);
      return;
    }
    const topAnchor = anchorStack.at(-1);
    if (topAnchor) {
      topAnchor.buf.push(chunk);
      return;
    }
    out.push(chunk);
  };

  const ensureNewline = (count = 1) => {
    if (tableCellBuf !== null || anchorStack.length > 0) return;
    const joined = out.slice(-4).join('');
    let trailing = 0;
    for (let i = joined.length - 1; i >= 0 && joined[i] === '\n'; i -= 1) trailing += 1;
    for (let n = trailing; n < count; n += 1) out.push('\n');
  };

  const emitLinePrefix = () => {
    if (blockquoteDepth > 0 && tableCellBuf === null && anchorStack.length === 0) {
      const joined = out.slice(-2).join('');
      if (joined.length === 0 || joined.endsWith('\n')) {
        out.push('> '.repeat(Math.min(blockquoteDepth, 4)));
      }
    }
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textSlice = lt === -1 ? src.slice(i) : src.slice(i, lt);
    if (textSlice && skipSubtreeTag === null) {
      const decoded = stripControlChars(decodeHtmlEntities(textSlice), true);
      if (preDepth > 0) {
        write(decoded);
      } else {
        const collapsed = decoded.replace(/\r\n?/g, '\n').replace(/[ \t\n]+/g, ' ');
        if (collapsed !== ' ' || out.length > 0 || tableCellBuf !== null || anchorStack.length > 0) {
          emitLinePrefix();
          write(collapsed);
        }
      }
    }
    if (lt === -1) break;

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }

    const gt = src.indexOf('>', lt + 1);
    if (gt === -1) break;
    const inside = src.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inside || inside.startsWith('!') || inside.startsWith('?')) continue;

    nodeCount += 1;
    if (nodeCount > ENML_MAX_NODES) {
      return failImport('TOO_LARGE', 413, 'Note HTML node count exceeds limit');
    }

    const isClose = inside.startsWith('/');
    const selfClose = !isClose && inside.endsWith('/');
    const bodyText = isClose ? inside.slice(1).trim() : selfClose ? inside.slice(0, -1).trim() : inside;
    let spaceIdx = -1;
    for (let k = 0; k < bodyText.length; k += 1) {
      if (isXmlWhitespace(bodyText[k] as string)) {
        spaceIdx = k;
        break;
      }
    }
    const tag = (spaceIdx === -1 ? bodyText : bodyText.slice(0, spaceIdx)).toLowerCase();
    if (!tag) continue;

    if (skipSubtreeTag !== null) {
      if (!isClose && !selfClose && tag === skipSubtreeTag) {
        skipDepth += 1;
      } else if (isClose && tag === skipSubtreeTag) {
        skipDepth -= 1;
        if (skipDepth <= 0) {
          skipSubtreeTag = null;
          skipDepth = 0;
        }
      }
      continue;
    }

    if (!isClose) {
      if (tagStack.length >= ENML_MAX_DEPTH) {
        return failImport('TOO_LARGE', 413, 'Note HTML nesting depth exceeds limit');
      }
      if (HTML_DROP_SUBTREE_TAGS.has(tag)) {
        if (!selfClose && !HTML_VOID_TAGS.has(tag)) {
          skipSubtreeTag = tag;
          skipDepth = 1;
        }
        continue;
      }
      const rawAttrs = spaceIdx === -1 ? '' : bodyText.slice(spaceIdx + 1);
      const attrs = rawAttrs ? parseTagAttributes(rawAttrs) : {};

      if (tag === 'img') {
        if (attrs['src'] !== undefined || attrs['data-src'] !== undefined) {
          strippedRemoteImages += 1;
        }
        const width = Number(attrs['width'] ?? '');
        const height = Number(attrs['height'] ?? '');
        const isPixel = width === 1 || height === 1 || width === 0 || height === 0;
        const alt = cleanSingleLine(attrs['alt'] ?? '', 120);
        if (!isPixel && alt && !/^https?:\/\//i.test(alt)) {
          write(`[Image: ${alt.replace(/[[\]]/g, '')}]`);
        }
        continue;
      }

      if (tag === 'en-media') {
        const hash = (attrs['hash'] ?? '').trim().toLowerCase();
        const matchedName = hash ? resourceNamesByMd5.get(hash) : undefined;
        if (matchedName) {
          write(`[Attachment: ${matchedName.replace(/[[\]]/g, '')}]`);
        } else {
          write('[Attachment]');
        }
        continue;
      }

      if (tag === 'en-todo' || (tag === 'input' && (attrs['type'] ?? '').toLowerCase() === 'checkbox')) {
        const checkedRaw = attrs['checked'];
        const checkedNorm = checkedRaw === undefined ? null : checkedRaw.trim().toLowerCase();
        const checked = checkedNorm === 'true' || checkedNorm === '1' || checkedNorm === 'checked' || checkedNorm === '';
        const topList = listStack.at(-1);
        if (topList && topList.inItem && !topList.itemHasContent) {
          while (out.length > 0 && (out.at(-1) ?? '').trim() === '') out.pop();
          const last = out.at(-1);
          if (last && (last.endsWith('- ') || /^\s*\d+\. $/.test(last))) {
            out[out.length - 1] = `${'  '.repeat(Math.max(0, listStack.length - 1))}- [${checked ? 'x' : ' '}] `;
            topList.itemHasContent = true;
            continue;
          }
        }
        ensureNewline(1);
        write(`- [${checked ? 'x' : ' '}] `);
        continue;
      }

      if (tag === 'input') continue;

      if (tag === 'br') {
        write('\n');
        continue;
      }
      if (tag === 'hr') {
        ensureNewline(2);
        write('---\n\n');
        continue;
      }

      if (!selfClose && !HTML_VOID_TAGS.has(tag)) {
        tagStack.push(tag);
      }

      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        ensureNewline(2);
        const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
        write(`${'#'.repeat(level)} `);
      } else if (tag === 'p' || tag === 'div') {
        if (listStack.length === 0) ensureNewline(2);
        else ensureNewline(1);
      } else if (tag === 'blockquote') {
        ensureNewline(2);
        blockquoteDepth += 1;
      } else if (tag === 'pre') {
        ensureNewline(2);
        preDepth += 1;
        write('```\n');
      } else if (tag === 'code' && preDepth === 0) {
        write('`');
      } else if (tag === 'b' || tag === 'strong') {
        write('**');
      } else if (tag === 'i' || tag === 'em') {
        write('*');
      } else if (tag === 's' || tag === 'del' || tag === 'strike') {
        write('~~');
      } else if (tag === 'ul' || tag === 'ol') {
        ensureNewline(listStack.length === 0 ? 2 : 1);
        listStack.push({ ordered: tag === 'ol', index: 0, inItem: false, itemHasContent: false });
      } else if (tag === 'li') {
        ensureNewline(1);
        const topList = listStack.at(-1);
        const indent = '  '.repeat(Math.max(0, listStack.length - 1));
        if (topList) {
          topList.index += 1;
          topList.inItem = true;
          topList.itemHasContent = false;
          write(topList.ordered ? `${indent}${topList.index}. ` : `${indent}- `);
        } else {
          write('- ');
        }
      } else if (tag === 'a') {
        anchorStack.push({ href: sanitizeSafeLinkUrl(attrs['href'] ?? ''), buf: [] });
      } else if (tag === 'en-crypt') {
        write('[Encrypted content omitted]');
      } else if (tag === 'tr') {
        tableRowCols = [];
      } else if (tag === 'td' || tag === 'th') {
        tableCellBuf = [];
      }
      continue;
    }

    // Closing tag
    const lastIdx = tagStack.lastIndexOf(tag);
    if (lastIdx !== -1) {
      tagStack.splice(lastIdx);
    }

    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      ensureNewline(2);
    } else if (tag === 'p' || tag === 'div') {
      ensureNewline(listStack.length === 0 ? 2 : 1);
    } else if (tag === 'blockquote') {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1);
      ensureNewline(2);
    } else if (tag === 'pre') {
      if (preDepth > 0) {
        preDepth -= 1;
        ensureNewline(1);
        write('```\n\n');
      }
    } else if (tag === 'code' && preDepth === 0) {
      write('`');
    } else if (tag === 'b' || tag === 'strong') {
      write('**');
    } else if (tag === 'i' || tag === 'em') {
      write('*');
    } else if (tag === 's' || tag === 'del' || tag === 'strike') {
      write('~~');
    } else if (tag === 'ul' || tag === 'ol') {
      listStack.pop();
      ensureNewline(listStack.length === 0 ? 2 : 1);
    } else if (tag === 'li') {
      const topList = listStack.at(-1);
      if (topList) topList.inItem = false;
      ensureNewline(1);
    } else if (tag === 'a') {
      const frame = anchorStack.pop();
      if (frame) {
        const label = frame.buf.join('').replace(/\s+/g, ' ').trim();
        if (frame.href) {
          const safeLabel = (label || frame.href).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
          const safeHref = frame.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
          write(`[${safeLabel}](${safeHref})`);
        } else if (label && !/^\s*javascript:/i.test(label)) {
          write(label);
        }
      }
    } else if (tag === 'td' || tag === 'th') {
      if (tableCellBuf !== null) {
        const cell = tableCellBuf.join('').replace(/\s+/g, ' ').trim();
        tableCellBuf = null;
        if (tableRowCols !== null) tableRowCols.push(cell);
        else write(`${cell} `);
      }
    } else if (tag === 'tr') {
      if (tableRowCols !== null) {
        const line = tableRowCols.filter((c) => c !== '').join(' | ');
        tableRowCols = null;
        if (line) {
          ensureNewline(1);
          write(`${line}\n`);
        }
      }
    }
  }

  // Flush any unclosed anchors safely.
  while (anchorStack.length > 0) {
    const frame = anchorStack.pop();
    if (frame) write(frame.buf.join(''));
  }
  while (preDepth > 0) {
    preDepth -= 1;
    out.push('\n```');
  }

  const normalized = out
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length > NOTE_BODY_MAX) {
    return failImport('NOTE_TOO_LONG', 422, 'Converted note body exceeds 100,000 characters');
  }

  return { markdown: normalized, strippedRemoteImages };
}

// ---------------------------------------------------------------------------
// Strict ENEX Parser
// ---------------------------------------------------------------------------

export function parseEnexImport(rawXml: string, options: { maxNotes?: number; nowMs?: number } = {}): EnexParseResult {
  if (typeof rawXml !== 'string') {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Expected text ENEX XML');
  }
  const maxNotes = options.maxNotes ?? ENEX_MAX_NOTES;
  const nowMs = options.nowMs ?? Date.now();
  const xml = rawXml.replace(/^\uFEFF/, '');
  if (xml.includes('\u0000')) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'ENEX contains disallowed NUL bytes');
  }
  if (new TextEncoder().encode(xml).byteLength > ENEX_MAX_FILE_BYTES) {
    return failImport('TOO_LARGE', 413, 'ENEX file exceeds 50 MB limit');
  }

  const stack: string[] = [];
  const entityCounter = { refs: 0 };
  let nodeCount = 0;
  let sawRoot = false;
  let rootClosed = false;
  let totalResources = 0;

  let exportNotebookName = '';
  let currentNote: NoteBuilder | null = null;
  let currentResource: ResourceBuilder | null = null;
  let textTarget: 'export-notebook' | 'title' | 'created' | 'updated' | 'tag' | 'notebook' | 'source-url' | 'content' | 'data' | 'mime' | 'file-name' | 'recognition' | null = null;
  let textBuf: string[] = [];

  const notes: ParsedEnexNote[] = [];
  const warnings: string[] = [];
  let totalStrippedRemoteImages = 0;

  const finalizeTextTarget = (): NoteImportFailure | null => {
    if (textTarget === 'export-notebook') {
      const value = textBuf.join('');
      textTarget = null;
      textBuf = [];
      if (!exportNotebookName) exportNotebookName = value;
      return null;
    }
    if (!textTarget || !currentNote) {
      textTarget = null;
      textBuf = [];
      return null;
    }
    const value = textBuf.join('');
    textBuf = [];
    const target = textTarget;
    textTarget = null;

    if (target === 'title') currentNote.title += value;
    else if (target === 'created') currentNote.createdRaw += value;
    else if (target === 'updated') currentNote.updatedRaw += value;
    else if (target === 'tag') currentNote.tags.push(value);
    else if (target === 'notebook') currentNote.notebookName += value;
    else if (target === 'source-url') currentNote.sourceUrlRaw += value;
    else if (target === 'content') {
      if (currentNote.content.length + value.length > ENEX_MAX_NOTE_CONTENT_CHARS) {
        return failImport('TOO_LARGE', 413, 'Note content exceeds maximum allowed size');
      }
      currentNote.content += value;
    } else if (currentResource) {
      if (target === 'data') {
        if (currentResource.base64.length + value.length > ENEX_MAX_RESOURCE_BASE64_CHARS + 65_536) {
          return failImport('TOO_LARGE', 413, 'Embedded attachment exceeds 25 MB limit');
        }
        currentResource.base64 += value;
      } else if (target === 'mime') currentResource.mime += value;
      else if (target === 'file-name') currentResource.filename += value;
      else if (target === 'recognition') {
        const objId = extractRecognitionObjId(value);
        if (objId) currentResource.recognitionObjId = objId;
      }
    }
    return null;
  };

  let pos = 0;
  const len = xml.length;
  while (pos < len && isXmlWhitespace(xml[pos] as string)) pos += 1;

  if (xml.startsWith('<?', pos)) {
    const end = xml.indexOf('?>', pos + 2);
    if (end === -1) return failImport('NOTE_IMPORT_INVALID', 400, 'Unterminated XML declaration');
    const decl = xml.slice(pos, end + 2);
    if (!/^<\?xml\b/i.test(decl) || /<!(?:DOCTYPE|ENTITY)/i.test(decl)) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'Disallowed XML processing instruction');
    }
    pos = end + 2;
  }

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    const textChunk = lt === -1 ? xml.slice(pos) : xml.slice(pos, lt);
    if (textChunk) {
      if (!sawRoot || rootClosed) {
        if (textChunk.trim() !== '') {
          return failImport('NOTE_IMPORT_INVALID', 400, 'Unexpected character data outside XML root element');
        }
      } else if (textTarget !== null) {
        const decoded = decodeXmlEntities(textChunk, entityCounter);
        if (typeof decoded !== 'string') return decoded;
        textBuf.push(decoded);
      } else {
        const decoded = decodeXmlEntities(textChunk, entityCounter);
        if (typeof decoded !== 'string') return decoded;
      }
    }
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return failImport('NOTE_IMPORT_INVALID', 400, 'Unterminated XML comment');
      pos = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', lt)) {
      if (!sawRoot || rootClosed || stack.length === 0) {
        return failImport('NOTE_IMPORT_INVALID', 400, 'CDATA section outside element');
      }
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return failImport('NOTE_IMPORT_INVALID', 400, 'Unterminated CDATA section');
      const cdata = xml.slice(lt + 9, end);
      if (textTarget !== null) {
        textBuf.push(cdata);
      }
      pos = end + 3;
      continue;
    }

    if (xml.startsWith('<!', lt) || xml.startsWith('<?', lt)) {
      return failImport('NOTE_IMPORT_UNSAFE_XML', 400, 'DOCTYPE, ENTITY, and arbitrary processing instructions are disallowed');
    }

    // Parse opening or closing XML tag safely, honoring quoted attribute values.
    const isClose = xml[lt + 1] === '/';
    let cursor = lt + (isClose ? 2 : 1);
    const nameStart = cursor;
    while (cursor < len && isXmlNameChar(xml.charCodeAt(cursor))) cursor += 1;
    const tagName = xml.slice(nameStart, cursor);
    if (!tagName) return failImport('NOTE_IMPORT_INVALID', 400, 'Malformed XML tag name');

    if (isClose) {
      while (cursor < len && isXmlWhitespace(xml[cursor] as string)) cursor += 1;
      if (xml[cursor] !== '>') {
        return failImport('NOTE_IMPORT_INVALID', 400, `Malformed closing tag </${tagName}>`);
      }
      pos = cursor + 1;
      const finErr = finalizeTextTarget();
      if (finErr) return finErr;
      const expected = stack.pop();
      if (expected !== tagName) {
        return failImport('NOTE_IMPORT_INVALID', 400, `Mismatched XML closing tag </${tagName}>`);
      }
      if (stack.length === 0) {
        rootClosed = true;
      } else if (tagName === 'resource' && currentNote && currentResource && stack.length === 2 && stack[1] === 'note') {
        currentNote.resources.push(currentResource);
        currentResource = null;
      } else if (tagName === 'note' && currentNote && stack.length === 1 && stack[0] === 'en-export') {
        const resByMd5 = new Map<string, string>();
        const builtResources: ParsedEnexResource[] = [];
        for (const res of currentNote.resources) {
          if (res.encoding !== null && res.encoding !== 'base64') {
            return failImport('NOTE_IMPORT_INVALID', 400, `Unsupported resource encoding: ${res.encoding}`);
          }
          if (res.base64.trim() === '') {
            warnings.push('skipped_empty_resource');
            continue;
          }
          if (res.base64.replace(/\s+/g, '').length > ENEX_MAX_RESOURCE_BASE64_CHARS) {
            return failImport('TOO_LARGE', 413, 'Embedded attachment exceeds 25 MB limit');
          }
          const bytes = decodeStrictBase64(res.base64, NOTE_ATTACHMENT_MAX_BYTES);
          if (bytes === null) {
            return failImport('NOTE_IMPORT_INVALID', 400, 'Malformed or oversized base64 attachment in ENEX');
          }
          if (bytes.byteLength === 0) {
            warnings.push('skipped_empty_resource');
            continue;
          }
          if (builtResources.length >= NOTE_ATTACHMENTS_PER_NOTE_MAX) {
            return failImport('NOTE_ATTACHMENT_LIMIT', 422, `Note exceeds ${NOTE_ATTACHMENTS_PER_NOTE_MAX} attachments limit`);
          }
          const md5HexValue = md5Hex(bytes);
          const cleanFile = cleanSingleLine(res.filename, NOTE_ATTACHMENT_FILENAME_MAX) || 'attachment';
          const cleanMime = cleanSingleLine(res.mime, 128).toLowerCase() || null;
          resByMd5.set(md5HexValue, cleanFile);
          if (res.recognitionObjId) resByMd5.set(res.recognitionObjId, cleanFile);
          builtResources.push({ bytes, filename: cleanFile, declaredMime: cleanMime, md5Hex: md5HexValue });
        }

        const converted = convertEnmlToSafeMarkdown(currentNote.content, resByMd5);
        if ('ok' in converted) return converted;
        totalStrippedRemoteImages += converted.strippedRemoteImages;

        const cleanTitle = cleanSingleLine(currentNote.title, NOTE_TITLE_MAX) || 'Untitled note';
        const sourceUrl = sanitizeClipSourceUrl(currentNote.sourceUrlRaw);
        let finalBody = converted.markdown;
        if (sourceUrl) {
          const safeLabel = sourceUrl.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
          const safeHref = sourceUrl.replace(/\(/g, '%28').replace(/\)/g, '%29');
          const prefix = `[${safeLabel}](${safeHref})`;
          finalBody = finalBody ? `${prefix}\n\n${finalBody}` : prefix;
          if (finalBody.length > NOTE_BODY_MAX) {
            return failImport('NOTE_TOO_LONG', 422, 'Converted note body exceeds 100,000 characters');
          }
        }
        const createdAt = parseEnexTimestamp(currentNote.createdRaw, nowMs);
        const rawUpdatedAt = parseEnexTimestamp(currentNote.updatedRaw, nowMs) ?? createdAt;
        const updatedAt = rawUpdatedAt && createdAt && rawUpdatedAt < createdAt ? createdAt : rawUpdatedAt;
        const cleanNotebook = cleanSingleLine(currentNote.notebookName || exportNotebookName, NOTEBOOK_NAME_MAX) || null;
        notes.push({
          title: cleanTitle,
          body: finalBody,
          tags: normalizeImportTags(currentNote.tags),
          notebookName: cleanNotebook,
          createdAt,
          updatedAt,
          sourceUrl,
          resources: builtResources,
          strippedRemoteImages: converted.strippedRemoteImages,
        });
        currentNote = null;
      }
      continue;
    }

    // Parse attributes on opening tag.
    if (rootClosed) return failImport('NOTE_IMPORT_INVALID', 400, 'Unexpected XML element after root close');
    nodeCount += 1;
    if (nodeCount > ENEX_MAX_XML_NODES) return failImport('TOO_LARGE', 413, 'ENEX XML node count limit exceeded');
    if (stack.length >= ENEX_MAX_XML_DEPTH) return failImport('TOO_LARGE', 413, 'ENEX XML nesting depth limit exceeded');

    const attrs: Record<string, string> = {};
    let attrCount = 0;
    let selfClose = false;
    for (;;) {
      while (cursor < len && isXmlWhitespace(xml[cursor] as string)) cursor += 1;
      if (cursor >= len) return failImport('NOTE_IMPORT_INVALID', 400, `Unterminated XML tag <${tagName}>`);
      if (xml[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (xml[cursor] === '/' && xml[cursor + 1] === '>') {
        selfClose = true;
        cursor += 2;
        break;
      }
      attrCount += 1;
      if (attrCount > ENEX_MAX_XML_ATTRS) return failImport('TOO_LARGE', 413, 'XML attribute count limit exceeded');
      const aStart = cursor;
      while (cursor < len && isXmlNameChar(xml.charCodeAt(cursor))) cursor += 1;
      const aName = xml.slice(aStart, cursor);
      if (!aName) return failImport('NOTE_IMPORT_INVALID', 400, 'Malformed XML attribute name');
      while (cursor < len && isXmlWhitespace(xml[cursor] as string)) cursor += 1;
      if (xml[cursor] !== '=') return failImport('NOTE_IMPORT_INVALID', 400, `Missing '=' for XML attribute ${aName}`);
      cursor += 1;
      while (cursor < len && isXmlWhitespace(xml[cursor] as string)) cursor += 1;
      const quote = xml[cursor];
      if (quote !== '"' && quote !== "'") return failImport('NOTE_IMPORT_INVALID', 400, `Missing quote for XML attribute ${aName}`);
      cursor += 1;
      const vStart = cursor;
      while (cursor < len && xml[cursor] !== quote) {
        if (xml[cursor] === '<') return failImport('NOTE_IMPORT_INVALID', 400, 'Unescaped < in XML attribute');
        cursor += 1;
      }
      if (cursor >= len) return failImport('NOTE_IMPORT_INVALID', 400, 'Unterminated XML attribute value');
      const decodedVal = decodeXmlEntities(xml.slice(vStart, cursor), entityCounter);
      if (typeof decodedVal !== 'string') return decodedVal;
      attrs[aName] = decodedVal;
      cursor += 1;
    }
    pos = cursor;

    if (!sawRoot) {
      if (tagName !== 'en-export') {
        return failImport('NOTE_IMPORT_INVALID', 400, `Expected root <en-export> element, got <${tagName}>`);
      }
      sawRoot = true;
      if (attrs['notebook']) exportNotebookName = attrs['notebook'];
      if (selfClose) {
        rootClosed = true;
      } else {
        stack.push('en-export');
      }
      continue;
    }

    if (selfClose) continue;
    stack.push(tagName);

    const depth = stack.length;
    if (depth === 2 && stack[0] === 'en-export' && tagName === 'notebook') {
      textTarget = 'export-notebook';
      textBuf = [];
    } else if (depth === 2 && stack[0] === 'en-export' && tagName === 'note') {
      if (notes.length >= maxNotes) {
        return failImport('TOO_LARGE', 413, `ENEX export exceeds ${maxNotes} notes limit`);
      }
      currentNote = {
        title: '',
        createdRaw: '',
        updatedRaw: '',
        tags: [],
        notebookName: '',
        sourceUrlRaw: '',
        content: '',
        resources: [],
      };
      textTarget = null;
      textBuf = [];
    } else if (depth === 3 && currentNote && stack[1] === 'note') {
      if (tagName === 'resource') {
        totalResources += 1;
        if (totalResources > ENEX_MAX_RESOURCES_TOTAL) {
          return failImport('TOO_LARGE', 413, 'Total embedded resources exceed limit');
        }
        currentResource = { base64: '', encoding: null, mime: '', filename: '', recognitionObjId: null };
        textTarget = null;
      } else if (
        tagName === 'title' ||
        tagName === 'created' ||
        tagName === 'updated' ||
        tagName === 'tag' ||
        tagName === 'notebook' ||
        tagName === 'content'
      ) {
        textTarget = tagName;
        textBuf = [];
      }
    } else if (depth === 4 && currentNote && stack[2] === 'note-attributes' && tagName === 'source-url') {
      textTarget = 'source-url';
      textBuf = [];
    } else if (depth === 4 && currentResource && stack[2] === 'resource') {
      if (tagName === 'data') {
        currentResource.encoding = attrs['encoding'] !== undefined ? attrs['encoding'].trim().toLowerCase() : null;
        textTarget = 'data';
        textBuf = [];
      } else if (tagName === 'mime') {
        textTarget = 'mime';
        textBuf = [];
      } else if (tagName === 'recognition') {
        textTarget = 'recognition';
        textBuf = [];
      }
    } else if (depth === 5 && currentResource && stack[3] === 'resource-attributes' && tagName === 'file-name') {
      textTarget = 'file-name';
      textBuf = [];
    }
  }

  if (!sawRoot || !rootClosed || stack.length > 0) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Truncated or malformed ENEX XML document');
  }
  if (notes.length === 0) {
    return failImport('NOTE_IMPORT_EMPTY', 400, 'No notes found in ENEX file');
  }

  return {
    ok: true,
    notes,
    strippedRemoteImages: totalStrippedRemoteImages,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Todoist CSV parser (UTF-8 / BOM, multiline quotes, inverted P1-P4 priority)
// ---------------------------------------------------------------------------

export interface ParsedTodoistTask {
  title: string;
  details: string;
  checklist: TodoStep[];
  priority: TodoPriority;
  tags: string[];
  sectionName: string | null;
  dueOn: string | null;
  dueTime: string | null;
  timeZone: string;
}

export interface ParsedTodoistList {
  name: string | null;
  fromExplicitList: boolean;
  sections: string[];
  tasks: ParsedTodoistTask[];
}

export interface TodoistWarning {
  row: number;
  kind: 'invalid_priority' | 'unparsed_date' | 'unsupported_type' | 'empty_task' | 'orphan_subtask' | 'checklist_overflow' | 'unparsed_indent';
  detail?: string;
}

export interface TodoistParseSuccess {
  ok: true;
  lists: ParsedTodoistList[];
  totalTasks: number;
  totalChecklistSteps: number;
  totalSections: number;
  skippedRows: number;
  warnings: TodoistWarning[];
}

export type TodoistParseResult = TodoistParseSuccess | NoteImportFailure;

/** Inverts Todoist CSV PRIORITY (`4->P1, 3->P2, 2->P3, 1->P4`), defaulting safely on empty/unknown values. */
export function invertTodoistPriority(raw: string | null | undefined): { priority: TodoPriority; valid: boolean } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { priority: 4, valid: true };
  if (trimmed === '4') return { priority: 1, valid: true };
  if (trimmed === '3') return { priority: 2, valid: true };
  if (trimmed === '2') return { priority: 3, valid: true };
  if (trimmed === '1') return { priority: 4, valid: true };
  return { priority: 4, valid: false };
}

function isValidTimeZoneName(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const MONTHS_EN: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseHourMinute(rawHour: string | undefined, rawMin: string | undefined, rawAmPm: string | undefined): { dueTime: string | null; valid: boolean } {
  if (rawHour === undefined || rawMin === undefined) return { dueTime: null, valid: true };
  let h = Number(rawHour);
  const mi = Number(rawMin);
  if (mi > 59) return { dueTime: null, valid: false };
  if (rawAmPm) {
    if (h < 1 || h > 12) return { dueTime: null, valid: false };
    const ap = rawAmPm.toLowerCase();
    if (ap === 'am') {
      if (h === 12) h = 0;
    } else if (ap === 'pm') {
      if (h < 12) h += 12;
    }
  } else if (h > 23) {
    return { dueTime: null, valid: false };
  }
  return { dueTime: `${pad2(h)}:${pad2(mi)}`, valid: true };
}

export function parseTodoistDate(
  raw: string | null | undefined,
  timeZone: string,
  fallbackYear = new Date().getUTCFullYear(),
): { dueOn: string | null; dueTime: string | null; valid: boolean } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { dueOn: null, dueTime: null, valid: true };

  // ISO with explicit UTC/offset: convert instant into the target timeZone's local calendar day + HH:mm.
  const isoOffset = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(trimmed);
  if (isoOffset) {
    const y = Number(isoOffset[1]);
    const mo = Number(isoOffset[2]);
    const d = Number(isoOffset[3]);
    const h = Number(isoOffset[4]);
    const mi = Number(isoOffset[5]);
    const s = Number(isoOffset[6] ?? '0');
    if (!isValidCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) {
      return { dueOn: null, dueTime: null, valid: false };
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return { dueOn: null, dueTime: null, valid: false };
    const localDay = zonedDate(timeZone, ms);
    const localParts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
    const timeStr = /^\d{2}:\d{2}$/.test(localParts) ? (localParts.startsWith('24:') ? `00:${localParts.slice(3)}` : localParts) : null;
    return { dueOn: localDay, dueTime: timeStr, valid: true };
  }

  // Naive ISO date or date + HH:mm(:ss)
  const isoLocal = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (isoLocal) {
    const y = Number(isoLocal[1]);
    const mo = Number(isoLocal[2]);
    const d = Number(isoLocal[3]);
    if (!isValidCalendarDate(y, mo, d)) return { dueOn: null, dueTime: null, valid: false };
    const dueOn = `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
    if (isoLocal[4] !== undefined && isoLocal[5] !== undefined) {
      const h = Number(isoLocal[4]);
      const mi = Number(isoLocal[5]);
      const s = Number(isoLocal[6] ?? '0');
      if (h > 23 || mi > 59 || s > 59) return { dueOn: null, dueTime: null, valid: false };
      return { dueOn, dueTime: `${pad2(h)}:${pad2(mi)}`, valid: true };
    }
    return { dueOn, dueTime: null, valid: true };
  }

  // Common Todoist English date strings: "Nov 25 2026", "Mar 5 2026 6:45pm", "25 Nov 2026", "25 Nov"
  const mdy = /^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i.exec(trimmed);
  if (mdy) {
    const mo = MONTHS_EN[(mdy[1] as string).toLowerCase()];
    const d = Number(mdy[2]);
    const y = mdy[3] ? Number(mdy[3]) : fallbackYear;
    if (mo && isValidCalendarDate(y, mo, d)) {
      const dueOn = `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
      const tm = parseHourMinute(mdy[4], mdy[5], mdy[6]);
      if (!tm.valid) return { dueOn: null, dueTime: null, valid: false };
      return { dueOn, dueTime: tm.dueTime, valid: true };
    }
  }

  const dmy = /^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i.exec(trimmed);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = MONTHS_EN[(dmy[2] as string).toLowerCase()];
    const y = dmy[3] ? Number(dmy[3]) : fallbackYear;
    if (mo && isValidCalendarDate(y, mo, d)) {
      const dueOn = `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
      const tm = parseHourMinute(dmy[4], dmy[5], dmy[6]);
      if (!tm.valid) return { dueOn: null, dueTime: null, valid: false };
      return { dueOn, dueTime: tm.dueTime, valid: true };
    }
  }

  return { dueOn: null, dueTime: null, valid: false };
}

function extractInlineTodoistLabels(rawContent: string, rawLabelsCol: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  // Extract @label tokens only when preceded by start-of-string or whitespace (keeps email addresses intact).
  const stripped = rawContent.replace(/(^|\s)@([\p{L}\p{N}_-]{1,40})(?=$|\s|[,.;!?])/gu, (_m, lead: string, tag: string) => {
    tags.push(tag);
    return lead;
  });
  const trimmedCol = rawLabelsCol.trim();
  if (trimmedCol) {
    const parts = /[,;]/.test(trimmedCol)
      ? trimmedCol.split(/[,;]+/)
      : /(?:^|\s)@/.test(trimmedCol)
        ? trimmedCol.split(/\s+/)
        : [trimmedCol];
    for (const part of parts) {
      const clean = part.replace(/^@+/, '').trim();
      if (clean) tags.push(clean);
    }
  }
  const cleanTitle = cleanSingleLine(stripped, TODO_TITLE_MAX) || cleanSingleLine(rawContent, TODO_TITLE_MAX);
  return { title: cleanTitle, tags: normalizeImportTags(tags) };
}

function detectCsvDelimiter(firstLine: string): ',' | ';' | '\t' {
  const candidates: Array<',' | ';' | '\t'> = [',', ';', '\t'];
  const counts = candidates.map((delim) => {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === delim) count += 1;
    }
    return { delim, count };
  });
  counts.sort((a, b) => b.count - a.count);
  return counts[0] && counts[0].count > 0 ? counts[0].delim : ',';
}

export function parseCsvRecords(rawText: string): { rows: string[][]; unterminated: boolean } {
  const text = rawText.replace(/^\uFEFF/, '');
  const firstNl = text.indexOf('\n');
  const firstLine = (firstNl === -1 ? text : text.slice(0, firstNl)).replace(/\r$/, '');
  const delimiter = detectCsvDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellStarted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && !cellStarted) {
      inQuotes = true;
      cellStarted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      cellStarted = false;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
    } else {
      cell += ch;
      cellStarted = true;
    }
  }

  if (cellStarted || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return { rows, unterminated: inQuotes };
}

export function deriveTodoistListNameFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const trimmed = filename.trim();
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  let base = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  if (base.toLowerCase().endsWith('.csv')) {
    base = base.slice(0, -4);
  }
  base = base.trim();
  if (base.endsWith(']')) {
    const open = base.lastIndexOf('[');
    if (open !== -1 && open + 1 < base.length - 1) {
      let allDigits = true;
      for (let i = open + 1; i < base.length - 1; i += 1) {
        const c = base.charCodeAt(i);
        if (c < 0x30 || c > 0x39) {
          allDigits = false;
          break;
        }
      }
      if (allDigits) {
        base = base.slice(0, open).trim();
      }
    }
  }
  const clean = cleanSingleLine(base, TODO_LIST_NAME_MAX);
  if (!clean || clean.toLowerCase() === 'blob' || clean.toLowerCase() === 'file') return null;
  return clean;
}

export function parseTodoistCsv(
  rawCsv: string,
  options: { defaultListName?: string | null; fallbackTimeZone?: string; useInboxWhenNoList?: boolean; fallbackYear?: number } = {},
): TodoistParseResult {
  if (typeof rawCsv !== 'string') {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Expected UTF-8 CSV text');
  }
  const text = rawCsv.replace(/^\uFEFF/, '');
  if (text.includes('\u0000')) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'CSV contains disallowed NUL bytes');
  }
  if (new TextEncoder().encode(text).byteLength > TODOIST_CSV_MAX_BYTES) {
    return failImport('TOO_LARGE', 413, 'Todoist CSV file exceeds 5 MB limit');
  }

  const { rows: rawRows, unterminated } = parseCsvRecords(text);
  if (unterminated) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Unterminated quoted string in CSV');
  }
  const nonEmptyRows = rawRows
    .map((cells, idx) => ({ rowNum: idx + 1, cells }))
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''));
  if (nonEmptyRows.length === 0) {
    return failImport('NOTE_IMPORT_EMPTY', 400, 'Todoist CSV is empty');
  }
  if (nonEmptyRows.length > TODOIST_MAX_ROWS + 1) {
    return failImport('TOO_LARGE', 413, `Todoist CSV exceeds ${TODOIST_MAX_ROWS} rows limit`);
  }

  const headerRow = nonEmptyRows[0]!;
  const colIndex = new Map<string, number>();
  for (let i = 0; i < headerRow.cells.length; i += 1) {
    const key = cleanSingleLine(headerRow.cells[i] ?? '', 64).toUpperCase();
    if (key && !colIndex.has(key)) colIndex.set(key, i);
  }
  if (!colIndex.has('TYPE') || !colIndex.has('CONTENT')) {
    return failImport('NOTE_IMPORT_INVALID', 400, 'Missing required Todoist CSV columns: TYPE, CONTENT');
  }

  const fallbackTz = options.fallbackTimeZone && isValidTimeZoneName(options.fallbackTimeZone) ? options.fallbackTimeZone : DEFAULT_TIME_ZONE;
  const fallbackListName = options.defaultListName ? cleanSingleLine(options.defaultListName, TODO_LIST_NAME_MAX) || null : null;

  const listsByKey = new Map<string, ParsedTodoistList>();
  const ensureList = (name: string | null, fromExplicitList: boolean): ParsedTodoistList | NoteImportFailure => {
    const key = name === null ? '__inbox__' : `list:${name.toLowerCase()}`;
    const existing = listsByKey.get(key);
    if (existing) return existing;
    if (listsByKey.size >= TODOIST_MAX_LISTS) {
      return failImport('TOO_LARGE', 413, `Todoist import exceeds ${TODOIST_MAX_LISTS} lists limit`);
    }
    const created: ParsedTodoistList = { name, fromExplicitList, sections: [], tasks: [] };
    listsByKey.set(key, created);
    return created;
  };

  let activeListName: string | null = options.useInboxWhenNoList ? null : (fallbackListName ?? 'Todoist');
  let activeListExplicit = false;
  let activeSection: string | null = null;
  let lastParentTask: ParsedTodoistTask | null = null;

  let totalTasks = 0;
  let totalChecklistSteps = 0;
  let totalSections = 0;
  let skippedRows = 0;
  let hasExplicitList = false;
  const warnings: TodoistWarning[] = [];

  const getCell = (cells: readonly string[], name: string): string => {
    const idx = colIndex.get(name);
    return idx === undefined ? '' : (cells[idx] ?? '');
  };

  for (let r = 1; r < nonEmptyRows.length; r += 1) {
    const { rowNum, cells } = nonEmptyRows[r]!;
    const rowType = cleanSingleLine(getCell(cells, 'TYPE'), 32).toLowerCase();
    const rawContent = getCell(cells, 'CONTENT');

    const rowListCol = cleanSingleLine(getCell(cells, 'LIST') || getCell(cells, 'PROJECT'), TODO_LIST_NAME_MAX);
    if (rowListCol && rowListCol.toLowerCase() !== (activeListName ?? '').toLowerCase()) {
      activeListName = rowListCol;
      activeListExplicit = true;
      activeSection = null;
      lastParentTask = null;
    }

    if (rowType === 'list' || rowType === 'project') {
      const listName = cleanSingleLine(rawContent, TODO_LIST_NAME_MAX);
      if (!listName) {
        skippedRows += 1;
        warnings.push({ row: rowNum, kind: 'empty_task' });
        continue;
      }
      activeListName = listName;
      activeListExplicit = true;
      activeSection = null;
      lastParentTask = null;
      const ensured = ensureList(activeListName, true);
      if ('ok' in ensured) return ensured;
      hasExplicitList = true;
      continue;
    }

    if (rowType === 'section') {
      const secName = cleanSingleLine(rawContent, TODO_LIST_SECTION_NAME_MAX);
      if (!secName) {
        skippedRows += 1;
        warnings.push({ row: rowNum, kind: 'empty_task' });
        continue;
      }
      if (activeListName === null) {
        // In Inbox mode without an explicit list, flatten sections cleanly so tasks stay in Inbox.
        activeSection = null;
        lastParentTask = null;
        continue;
      }
      const list = ensureList(activeListName, activeListExplicit);
      if ('ok' in list) return list;
      if (!list.sections.some((s) => s.toLowerCase() === secName.toLowerCase())) {
        if (list.sections.length >= TODO_LIST_SECTIONS_MAX) {
          return failImport('TOO_LARGE', 413, `List "${list.name ?? ''}" exceeds ${TODO_LIST_SECTIONS_MAX} sections limit`);
        }
        list.sections.push(secName);
        totalSections += 1;
      }
      activeSection = secName;
      lastParentTask = null;
      continue;
    }

    if (rowType === 'note') {
      const comment = stripControlChars(rawContent.replace(/\r\n?/g, '\n'), true).trim();
      if (comment && lastParentTask) {
        const nextDetails = lastParentTask.details ? `${lastParentTask.details}\n\n${comment}` : comment;
        lastParentTask.details = nextDetails.slice(0, TODO_DETAILS_MAX);
      } else {
        skippedRows += 1;
      }
      continue;
    }

    if (rowType !== 'task') {
      skippedRows += 1;
      warnings.push({ row: rowNum, kind: 'unsupported_type', detail: rowType || 'empty' });
      continue;
    }

    const rowSectionCol = cleanSingleLine(getCell(cells, 'SECTION'), TODO_LIST_SECTION_NAME_MAX);
    let taskSection = activeSection;
    if (rowSectionCol && activeListName !== null) {
      const secList = ensureList(activeListName, activeListExplicit);
      if ('ok' in secList) return secList;
      if (!secList.sections.some((s) => s.toLowerCase() === rowSectionCol.toLowerCase())) {
        if (secList.sections.length < TODO_LIST_SECTIONS_MAX) {
          secList.sections.push(rowSectionCol);
          totalSections += 1;
        }
      }
      taskSection = rowSectionCol;
    }

    const rawIndent = getCell(cells, 'INDENT').trim();
    let indent = 1;
    if (rawIndent !== '') {
      const parsedIndent = Number(rawIndent);
      if (Number.isInteger(parsedIndent) && parsedIndent >= 1 && parsedIndent <= 20) {
        indent = parsedIndent;
      } else {
        warnings.push({ row: rowNum, kind: 'unparsed_indent', detail: rawIndent });
      }
    }

    const rawLabels = getCell(cells, 'LABELS');
    const { title, tags } = extractInlineTodoistLabels(rawContent, rawLabels);
    if (!title) {
      skippedRows += 1;
      warnings.push({ row: rowNum, kind: 'empty_task' });
      continue;
    }

    const rawDesc = stripControlChars(getCell(cells, 'DESCRIPTION').replace(/\r\n?/g, '\n'), true).trim();
    const details = rawDesc.slice(0, TODO_DETAILS_MAX);

    if (indent >= 2) {
      if (lastParentTask !== null) {
        if (lastParentTask.checklist.length < TODO_STEPS_MAX) {
          const stepText = cleanSingleLine(title, TODO_STEP_MAX);
          if (stepText) {
            lastParentTask.checklist.push({ text: stepText, done: false });
            totalChecklistSteps += 1;
          }
          if (tags.length > 0) {
            lastParentTask.tags = normalizeImportTags([...lastParentTask.tags, ...tags]);
          }
          if (details) {
            const combined = lastParentTask.details ? `${lastParentTask.details}\n${details}` : details;
            lastParentTask.details = combined.slice(0, TODO_DETAILS_MAX);
          }
          continue;
        }
        warnings.push({ row: rowNum, kind: 'checklist_overflow', detail: title });
      } else {
        warnings.push({ row: rowNum, kind: 'orphan_subtask', detail: title });
      }
    }

    if (totalTasks >= TODOIST_MAX_TASKS) {
      return failImport('TOO_LARGE', 413, `Todoist import exceeds ${TODOIST_MAX_TASKS} tasks limit`);
    }

    const rawPriority = getCell(cells, 'PRIORITY');
    const pri = invertTodoistPriority(rawPriority);
    if (!pri.valid) {
      warnings.push({ row: rowNum, kind: 'invalid_priority', detail: rawPriority.trim() });
    }

    const rawTz = cleanSingleLine(getCell(cells, 'TIMEZONE'), 80);
    const taskTz = rawTz && isValidTimeZoneName(rawTz) ? rawTz : fallbackTz;
    const rawDate = getCell(cells, 'DATE');
    const parsedDate = parseTodoistDate(rawDate, taskTz, options.fallbackYear);
    if (!parsedDate.valid) {
      warnings.push({ row: rowNum, kind: 'unparsed_date', detail: rawDate.trim() });
    }

    const list = ensureList(activeListName, activeListExplicit);
    if ('ok' in list) return list;

    const task: ParsedTodoistTask = {
      title,
      details,
      checklist: [],
      priority: pri.priority,
      tags,
      sectionName: taskSection,
      dueOn: parsedDate.dueOn,
      dueTime: parsedDate.dueTime,
      timeZone: taskTz,
    };
    list.tasks.push(task);
    lastParentTask = task;
    totalTasks += 1;
  }

  const lists = [...listsByKey.values()];
  if (totalTasks === 0 && !hasExplicitList) {
    return failImport('NOTE_IMPORT_EMPTY', 400, 'No importable tasks or lists found in Todoist CSV');
  }

  return {
    ok: true,
    lists,
    totalTasks,
    totalChecklistSteps,
    totalSections,
    skippedRows,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dry-run preview helpers & Zod command contracts
// ---------------------------------------------------------------------------

export interface EnexDryRunPreview {
  notesCount: number;
  attachmentsCount: number;
  notebooksNew: string[];
  notebooksExisting: string[];
  duplicateTitles: number;
  strippedRemoteImages: number;
  tagsCount: number;
  warningsCount: number;
}

export function buildEnexDryRunPreview(
  parsed: EnexParseSuccess,
  existingPrivateNotebooks: ReadonlyArray<{ name: string }>,
  existingNoteTitles: readonly string[],
  options: { overrideNotebookName?: string | null; unfiled?: boolean } = {},
): EnexDryRunPreview {
  const existingNbSet = new Set(existingPrivateNotebooks.map((b) => b.name.trim().toLowerCase()));
  const seenNoteSet = new Set(existingNoteTitles.map((t) => t.trim().toLowerCase()));
  const notebooksNewSet = new Set<string>();
  const notebooksExistingSet = new Set<string>();
  const uniqueTags = new Set<string>();

  let attachmentsCount = 0;
  let duplicateTitles = 0;

  for (const note of parsed.notes) {
    attachmentsCount += note.resources.length;
    for (const tag of note.tags) uniqueTags.add(tag);
    const key = note.title.trim().toLowerCase();
    if (seenNoteSet.has(key)) duplicateTitles += 1;
    seenNoteSet.add(key);

    if (!options.unfiled && !options.overrideNotebookName && note.notebookName) {
      const nbKey = note.notebookName.trim().toLowerCase();
      if (existingNbSet.has(nbKey)) notebooksExistingSet.add(note.notebookName);
      else notebooksNewSet.add(note.notebookName);
    }
  }

  return {
    notesCount: parsed.notes.length,
    attachmentsCount,
    notebooksNew: [...notebooksNewSet],
    notebooksExisting: [...notebooksExistingSet],
    duplicateTitles,
    strippedRemoteImages: parsed.strippedRemoteImages,
    tagsCount: uniqueTags.size,
    warningsCount: parsed.warnings.length,
  };
}

export interface TodoistDryRunPreview {
  tasksCount: number;
  checklistStepsCount: number;
  sectionsCount: number;
  listsNew: string[];
  listsExisting: string[];
  priorityCounts: { p1: number; p2: number; p3: number; p4: number };
  tagsCount: number;
  duplicateTitles: number;
  skippedRows: number;
  warnings: TodoistWarning[];
}

export function buildTodoistDryRunPreview(
  parsed: TodoistParseSuccess,
  existingLists: ReadonlyArray<{ id: string; name: string }>,
  existingTodoTitles: readonly string[],
  options: { targetListId?: string | null; useInbox?: boolean } = {},
): TodoistDryRunPreview {
  const existingListMap = new Map(existingLists.map((l) => [l.name.trim().toLowerCase(), l.name]));
  const seenTitles = new Set(existingTodoTitles.map((t) => t.trim().toLowerCase()));
  const listsNewSet = new Set<string>();
  const listsExistingSet = new Set<string>();
  const uniqueTags = new Set<string>();
  const priorityCounts = { p1: 0, p2: 0, p3: 0, p4: 0 };
  let duplicateTitles = 0;

  for (const list of parsed.lists) {
    if ((list.fromExplicitList || (!options.useInbox && !options.targetListId)) && list.name) {
      const key = list.name.trim().toLowerCase();
      const matched = existingListMap.get(key);
      if (matched) listsExistingSet.add(matched);
      else listsNewSet.add(list.name);
    }
    for (const task of list.tasks) {
      if (task.priority === 1) priorityCounts.p1 += 1;
      else if (task.priority === 2) priorityCounts.p2 += 1;
      else if (task.priority === 3) priorityCounts.p3 += 1;
      else priorityCounts.p4 += 1;
      for (const tag of task.tags) uniqueTags.add(tag);
      const tKey = task.title.trim().toLowerCase();
      if (seenTitles.has(tKey)) duplicateTitles += 1;
      seenTitles.add(tKey);
    }
  }

  return {
    tasksCount: parsed.totalTasks,
    checklistStepsCount: parsed.totalChecklistSteps,
    sectionsCount: parsed.totalSections,
    listsNew: [...listsNewSet],
    listsExisting: [...listsExistingSet],
    priorityCounts,
    tagsCount: uniqueTags.size,
    duplicateTitles,
    skippedRows: parsed.skippedRows,
    warnings: parsed.warnings,
  };
}

export const zEnexImportAttachmentInput = z.strictObject({
  attachmentId: zId,
  filename: z.string().trim().min(1).max(NOTE_ATTACHMENT_FILENAME_MAX),
  contentType: z.string().trim().min(1).max(128),
  sizeBytes: z.number().int().min(1).max(NOTE_ATTACHMENT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1).max(128),
  extractStatus: z.enum(['pending', 'skipped']),
});
export type EnexImportAttachmentInput = z.infer<typeof zEnexImportAttachmentInput>;

export const zEnexImportNoteInput = z.strictObject({
  title: z.string().trim().min(1).max(NOTE_TITLE_MAX),
  body: z.string().max(NOTE_BODY_MAX),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(NOTE_TAG_MAX)).max(NOTE_TAGS_MAX),
  notebookName: z.string().trim().min(1).max(NOTEBOOK_NAME_MAX).nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }).nullable().optional(),
  updatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  attachments: z.array(zEnexImportAttachmentInput).max(NOTE_ATTACHMENTS_PER_NOTE_MAX),
});
export type EnexImportNoteInput = z.infer<typeof zEnexImportNoteInput>;

export const zEnexImportCommand = z.strictObject({
  targetNotebookId: zId.nullable().optional(),
  ignoreFileNotebooks: z.boolean().default(false),
  skipDuplicates: z.boolean().default(false),
  notes: z.array(zEnexImportNoteInput).min(1).max(ENEX_MAX_NOTES),
});
export type EnexImportCommandInput = z.input<typeof zEnexImportCommand>;

export const zEnexImportResult = z.object({
  importedNotes: z.number().int().nonnegative(),
  createdNotebooks: z.number().int().nonnegative(),
  reusedNotebooks: z.number().int().nonnegative(),
  attachmentsCount: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  strippedRemoteImages: z.number().int().nonnegative().optional(),
  noteIds: z.array(z.string()),
  notebookIds: z.array(z.string()),
  unusedStorageKeys: z.array(z.string()),
});
export type EnexImportResult = z.infer<typeof zEnexImportResult>;

export const zTodoistImportCommand = z.strictObject({
  csv: z.string().min(1).max(TODOIST_CSV_MAX_BYTES),
  defaultListName: z.string().trim().min(1).max(TODO_LIST_NAME_MAX).nullable().optional(),
  targetListId: zId.nullable().optional(),
  useInboxWhenNoList: z.boolean().default(false),
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  skipDuplicates: z.boolean().default(false),
});
export type TodoistImportCommandInput = z.input<typeof zTodoistImportCommand>;

export const zTodoistImportResult = z.object({
  importedTodos: z.number().int().nonnegative(),
  createdLists: z.number().int().nonnegative(),
  updatedLists: z.number().int().nonnegative(),
  createdSections: z.number().int().nonnegative(),
  checklistSteps: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  skippedRows: z.number().int().nonnegative(),
  todoIds: z.array(z.string()),
  listIds: z.array(z.string()),
});
export type TodoistImportResult = z.infer<typeof zTodoistImportResult>;

// Re-export checked Todo shapes for convenience in callers.
export { NOTE_ATTACHMENT_EXTRACT_STATUSES, zTodoPriority, zTodoStep };
