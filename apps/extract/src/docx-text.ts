// SPDX-License-Identifier: AGPL-3.0-only
// DOCX plain-text extractor for note attachment full-text search (#3561, docs/plan/notes-v2.md V2-5).
// Runs inside crove-extract's sandboxed parser process: opens the ZIP directory via readZipParts
// with strict entry/byte limits, refuses DOCTYPE/ENTITY declarations, and extracts WordprocessingML
// text runs in linear O(n) time without regex backtracking.
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import { readZipParts, type ZipLimits } from './zip.ts';

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

const DOCX_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
};

function isDigits(s: string): boolean {
  if (s.length === 0 || s.length > 4) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function isWantedWordXml(name: string): boolean {
  if (name === 'word/document.xml' || name === 'word/footnotes.xml' || name === 'word/endnotes.xml') return true;
  if (name.startsWith('word/header') && name.endsWith('.xml')) {
    return isDigits(name.slice('word/header'.length, -'.xml'.length));
  }
  if (name.startsWith('word/footer') && name.endsWith('.xml')) {
    return isDigits(name.slice('word/footer'.length, -'.xml'.length));
  }
  return false;
}

function partSortOrder(name: string): number {
  if (name === 'word/document.xml') return 0;
  if (name.startsWith('word/header')) return 1;
  if (name === 'word/footnotes.xml') return 2;
  if (name === 'word/endnotes.xml') return 3;
  return 4;
}

function decodeXmlEntity(entity: string): string {
  if (entity === 'amp') return '&';
  if (entity === 'lt') return '<';
  if (entity === 'gt') return '>';
  if (entity === 'quot') return '"';
  if (entity === 'apos') return "'";
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const hex = entity.slice(2);
    if (hex.length >= 1 && hex.length <= 6) {
      const cp = Number.parseInt(hex, 16);
      if (Number.isInteger(cp) && cp >= 0x20 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
        return String.fromCodePoint(cp);
      }
    }
    return '';
  }
  if (entity.startsWith('#')) {
    const dec = entity.slice(1);
    if (isDigits(dec) || (dec.length >= 1 && dec.length <= 7 && /^[0-9]+$/.test(dec))) {
      const cp = Number.parseInt(dec, 10);
      if (Number.isInteger(cp) && cp >= 0x20 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
        return String.fromCodePoint(cp);
      }
    }
    return '';
  }
  return `&${entity};`;
}

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  const parts: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      parts.push(raw.slice(i));
      break;
    }
    if (amp > i) parts.push(raw.slice(i, amp));
    const limit = Math.min(raw.length, amp + 16);
    let semi = -1;
    for (let j = amp + 1; j < limit; j++) {
      const ch = raw.charCodeAt(j);
      if (ch === 0x3b) {
        semi = j;
        break;
      }
      if (ch === 0x26 || ch === 0x3c || ch <= 0x20) break;
    }
    if (semi === -1) {
      parts.push('&');
      i = amp + 1;
    } else {
      parts.push(decodeXmlEntity(raw.slice(amp + 1, semi)));
      i = semi + 1;
    }
  }
  return parts.join('');
}

function localTagName(tagHeader: string): { closing: boolean; selfClosing: boolean; local: string } {
  let start = 0;
  let end = tagHeader.length;
  while (start < end && tagHeader.charCodeAt(start) <= 0x20) start++;
  let closing = false;
  if (start < end && tagHeader.charCodeAt(start) === 0x2f) {
    closing = true;
    start++;
  }
  let selfClosing = false;
  if (!closing && end > start && tagHeader.charCodeAt(end - 1) === 0x2f) {
    selfClosing = true;
    end--;
  }
  let nameEnd = start;
  while (nameEnd < end) {
    const c = tagHeader.charCodeAt(nameEnd);
    if (c <= 0x20 || c === 0x2f) break;
    nameEnd++;
  }
  const full = tagHeader.slice(start, nameEnd);
  const colon = full.indexOf(':');
  const local = colon === -1 ? full : full.slice(colon + 1);
  return { closing, selfClosing, local };
}

function extractWordXmlText(xml: string, maxChars: number): string {
  const upper = xml.toUpperCase();
  if (upper.includes('<!DOCTYPE') || upper.includes('<!ENTITY')) {
    throw new DocxError('Tệp DOCX chứa khai báo XML không an toàn');
  }
  const chunks: string[] = [];
  let totalLen = 0;
  let inText = false;
  let inDeleted = 0;
  let i = 0;

  while (i < xml.length && totalLen < maxChars + 4096) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (inText && inDeleted === 0 && i < xml.length) {
        const text = decodeEntities(xml.slice(i));
        chunks.push(text);
        totalLen += text.length;
      }
      break;
    }
    if (lt > i && inText && inDeleted === 0) {
      const text = decodeEntities(xml.slice(i, lt));
      chunks.push(text);
      totalLen += text.length;
    }

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      const content = close === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, close);
      if (inText && inDeleted === 0 && content.length > 0) {
        chunks.push(content);
        totalLen += content.length;
      }
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break;
    const { closing, selfClosing, local } = localTagName(xml.slice(lt + 1, gt));

    if (local === 'del' || local === 'instrText') {
      if (closing) {
        if (inDeleted > 0) inDeleted--;
      } else if (!selfClosing) {
        inDeleted++;
      }
    } else if (local === 't') {
      if (closing) inText = false;
      else if (!selfClosing) inText = true;
    } else if (inDeleted === 0) {
      if (!closing && local === 'tab') {
        chunks.push('\t');
        totalLen += 1;
      } else if (!closing && (local === 'br' || local === 'cr')) {
        chunks.push('\n');
        totalLen += 1;
      } else if (closing && (local === 'p' || local === 'tr')) {
        chunks.push('\n');
        totalLen += 1;
      } else if (closing && local === 'tc') {
        chunks.push('\t');
        totalLen += 1;
      }
    }
    i = gt + 1;
  }

  return chunks.join('');
}

function cleanAndCapText(raw: string, maxChars: number): string {
  const out: string[] = [];
  let prevNewline = true;
  let blankLine = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x0d) continue;
    if (code === 0x0a) {
      if (!prevNewline) {
        out.push('\n');
        prevNewline = true;
      } else if (!blankLine && out.length > 0) {
        out.push('\n');
        blankLine = true;
      }
      continue;
    }
    if (code < 0x20 && code !== 0x09) continue;
    if (code === 0x7f) continue;
    out.push(raw[i] as string);
    prevNewline = false;
    blankLine = false;
  }
  const joined = out.join('').trim();
  if (joined.length <= maxChars) return joined;
  const end =
    joined.charCodeAt(maxChars - 1) >= 0xd800 && joined.charCodeAt(maxChars - 1) <= 0xdbff
      ? maxChars - 1
      : maxChars;
  return joined.slice(0, end).trimEnd();
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function readDocxText(bytes: Uint8Array): string {
  const parts = readZipParts(bytes, isWantedWordXml, DOCX_LIMITS);
  if (!parts.has('word/document.xml')) {
    throw new DocxError('Không phải tệp Word (.docx) hợp lệ');
  }
  const names = [...parts.keys()].sort((a, b) => partSortOrder(a) - partSortOrder(b) || a.localeCompare(b));
  const max = EXTRACT_LIMITS.maxTextChars;
  const pieces: string[] = [];
  let total = 0;
  for (const name of names) {
    if (total >= max) break;
    const rawBytes = parts.get(name);
    if (!rawBytes) continue;
    const text = extractWordXmlText(decoder.decode(rawBytes), max - total);
    if (text.trim() !== '') {
      pieces.push(text);
      total += text.length;
    }
  }
  return cleanAndCapText(pieces.join('\n'), max);
}
