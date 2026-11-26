// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';

/**
 * Playwright E2E coverage for eSign Slice 6a-6d (DOS/Ludy #5110).
 *
 * Test 1 covers Slice 6b + 6c: pure-JS .docx upload converted via ludy-extract
 * into a tagged A4 PDF (`{{signature, r1}}`), multi-document packet attach (1-2 PDFs),
 * inspect completion, document reorder & counters, tag auto-placement + doc-1 text field,
 * unauthenticated 375x812 mobile ceremony with fragment scrubbing and multi-doc consent
 * notice, and unified SHA-256 sealing.
 *
 * Test 2 covers Slice 6a + 6d: org VietQR deposit profile persistence in Settings,
 * draft envelope deposit config + immutable CK-* snapshot lock on send, QR handoff
 * modals (in-person SVG QR, Zalo link SVG QR, desktop ceremony QR -> isolated mobile
 * scan-to-sign with zero /o/<slug>/* tenant leak and auto-sync polling), and post-sign
 * VietQR deposit card rendering on 375x812 with exact amount, memo, and QR image.
 */

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function ieeeCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    c = (CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Pure-JS minimal ZIP builder (STORE method 0, IEEE 802.3 CRC-32, UTF-8 names)
 * matching apps/extract/src/zip.ts central directory, local header, and EOCD checks.
 */
function buildStoredZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = ieeeCrc32(data);
    const size = data.byteLength;
    const flags = 0x0800; // UTF-8 filename flag
    const method = 0; // STORE

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + size;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDir, eocd]);
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createMinimalDocxBytes(input: { title: string; paragraphs: readonly string[] }): Buffer {
  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('');

  const relsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('');

  const bodyParagraphs = [
    `<w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${escapeXml(input.title)}</w:t></w:r></w:p>`,
    ...input.paragraphs.map(
      (p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`,
    ),
  ].join('');

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${bodyParagraphs}</w:body>`,
    '</w:document>',
  ].join('');

  return buildStoredZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(relsXml, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

function escapePdfLiteral(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createTextPdfBytes(lines: readonly string[]): Buffer {
  const safeLines = lines.length > 0 ? lines : ['Ludy eSign E2E Document'];
  const commands = [
    'BT',
    '/F1 11 Tf',
    '50 780 Td',
    '14 TL',
    ...safeLines.map((line) => `(${escapePdfLiteral(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const streamLength = Buffer.byteLength(commands, 'latin1');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${commands}\nendstream\nendobj\n`,
  ];

  const header = '%PDF-1.4\n';
  const chunks: string[] = [header];
  let offset = Buffer.byteLength(header, 'latin1');
  const offsets: number[] = [];

  for (const obj of objects) {
    offsets.push(offset);
    chunks.push(obj);
    offset += Buffer.byteLength(obj, 'latin1');
  }

  const xrefOffset = offset;
  const xrefRows = offsets.map((pos) => `${String(pos).padStart(10, '0')} 00000 n \n`).join('');
  chunks.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefRows}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.from(chunks.join(''), 'latin1');
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function completeTypedSignature(page: Page, signerName: string): Promise<void> {
  await page.locator('[data-testid^="ceremony-sign-btn-"]', { hasText: 'Bấm để ký' }).first().click();
  await page
    .getByRole('tab', { name: 'Gõ tên' })
    .or(page.getByRole('button', { name: 'Gõ tên' }))
    .click();
  await page.locator('#typed-signature-input').fill(signerName);
  await page.getByTestId('signature-pad-apply').click();
}

async function waitForPdfViewerReady(page: Page): Promise<void> {
  const surface = page.getByTestId('pdf-page-surface');
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="pdf-page-surface"] > .z-20')).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => surface.evaluate((el) => Boolean((el as HTMLElement).style.width)), { timeout: 30_000 })
    .toBe(true);
  const canvas = page.getByTestId('pdf-canvas-viewer').locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () => canvas.evaluate((el) => (el as HTMLCanvasElement).width > 0 && (el as HTMLCanvasElement).height > 0),
      { timeout: 30_000 },
    )
    .toBe(true);
}

interface QrVersionMeta {
  version: number;
  size: number;
  totalCodewords: number;
  blocksGroup1: number;
  dataPerGroup1: number;
  blocksGroup2: number;
  dataPerGroup2: number;
  alignments: readonly number[];
}

const QR_VERSION_TABLE: readonly QrVersionMeta[] = [
  { version: 1, size: 21, totalCodewords: 26, blocksGroup1: 1, dataPerGroup1: 19, blocksGroup2: 0, dataPerGroup2: 0, alignments: [] },
  { version: 2, size: 25, totalCodewords: 44, blocksGroup1: 1, dataPerGroup1: 34, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, blocksGroup1: 1, dataPerGroup1: 55, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, blocksGroup1: 1, dataPerGroup1: 80, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, blocksGroup1: 1, dataPerGroup1: 108, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, blocksGroup1: 2, dataPerGroup1: 68, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 34] },
  { version: 7, size: 45, totalCodewords: 196, blocksGroup1: 2, dataPerGroup1: 78, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 22, 38] },
  { version: 8, size: 49, totalCodewords: 242, blocksGroup1: 2, dataPerGroup1: 97, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 24, 42] },
  { version: 9, size: 53, totalCodewords: 292, blocksGroup1: 2, dataPerGroup1: 116, blocksGroup2: 0, dataPerGroup2: 0, alignments: [6, 26, 46] },
  { version: 10, size: 57, totalCodewords: 346, blocksGroup1: 2, dataPerGroup1: 68, blocksGroup2: 2, dataPerGroup2: 69, alignments: [6, 28, 50] },
];

function computeQrFormatWordL(mask: number): number {
  const data = (0b01 << 3) | mask;
  let d = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((d >>> (i + 10)) & 1) d ^= 0x537 << i;
  }
  return ((data << 10) | d) ^ 0x5412;
}

function qrMaskAt(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/**
 * Decodes an ISO/IEC 18004 Level L Byte-mode QR SVG path (`M<x>,<y>h1v1h-1z`)
 * directly from the rendered DOM geometry without trusting sibling text inputs.
 */
function decodeQrSvgPath(d: string, viewBox: string, quietZone = 4): string {
  const vb = /^0 0 (\d+) (\d+)$/.exec(viewBox.trim());
  if (!vb || vb[1] !== vb[2]) throw new Error(`Invalid QR viewBox: ${viewBox}`);
  const fullSize = Number(vb[1]);
  const size = fullSize - quietZone * 2;
  const spec = QR_VERSION_TABLE.find((entry) => entry.size === size);
  if (!spec) throw new Error(`Unsupported QR dimension: ${size}`);
  if (!/^(?:M\d+,\d+h1v1h-1z)+$/.test(d)) throw new Error('Unexpected QR SVG path commands');

  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const m of d.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const col = Number(m[1]) - quietZone;
    const row = Number(m[2]) - quietZone;
    if (row < 0 || col < 0 || row >= size || col >= size) {
      throw new Error(`QR module (${row}, ${col}) outside ${size}x${size} grid`);
    }
    grid[row]![col] = true;
  }

  let fmtBits = 0;
  for (let k = 0; k < 15; k += 1) {
    const bit =
      k < 6
        ? grid[k]![8]!
        : k < 8
          ? grid[k + 1]![8]!
          : k === 8
            ? grid[8]![7]!
            : grid[8]![14 - k]!;
    if (bit) fmtBits |= 1 << k;
  }
  let mask = -1;
  for (let candidate = 0; candidate < 8; candidate += 1) {
    if (computeQrFormatWordL(candidate) === fmtBits) {
      mask = candidate;
      break;
    }
  }
  if (mask < 0) throw new Error('Invalid or unsupported QR format information');

  const reserved = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const markRect = (r0: number, c0: number, r1: number, c1: number) => {
    for (let r = Math.max(0, r0); r <= Math.min(size - 1, r1); r += 1) {
      for (let c = Math.max(0, c0); c <= Math.min(size - 1, c1); c += 1) {
        reserved[r]![c] = true;
      }
    }
  };
  markRect(0, 0, 7, 7);
  markRect(0, size - 8, 7, size - 1);
  markRect(size - 8, 0, size - 1, 7);
  for (const r of spec.alignments) {
    for (const c of spec.alignments) {
      if (reserved[r]![c]) continue;
      markRect(r - 2, c - 2, r + 2, c + 2);
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    reserved[6]![i] = true;
    reserved[i]![6] = true;
  }
  reserved[4 * spec.version + 9]![8] = true;
  for (let i = 0; i < 9; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  for (let i = size - 8; i < size; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  if (spec.version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      reserved[r]![c] = true;
      reserved[c]![r] = true;
    }
  }

  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const r = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!reserved[r]![c]) {
          bits.push(grid[r]![c]! !== qrMaskAt(mask, r, c) ? 1 : 0);
        }
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= spec.totalCodewords * 8; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b]!;
    codewords.push(byte);
  }

  const blockLens = [
    ...Array.from({ length: spec.blocksGroup1 }, () => spec.dataPerGroup1),
    ...Array.from({ length: spec.blocksGroup2 }, () => spec.dataPerGroup2),
  ];
  const blocks: number[][] = blockLens.map(() => []);
  const maxDataLen = Math.max(spec.dataPerGroup1, spec.dataPerGroup2);
  let cwIdx = 0;
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < blockLens.length; b += 1) {
      if (i < blockLens[b]!) {
        blocks[b]!.push(codewords[cwIdx]!);
        cwIdx += 1;
      }
    }
  }
  const dataCodewords = blocks.flat();
  const dataBits: number[] = [];
  for (const cw of dataCodewords) {
    for (let k = 7; k >= 0; k -= 1) dataBits.push((cw >>> k) & 1);
  }
  const readBits = (pos: number, len: number): number => {
    let val = 0;
    for (let i = 0; i < len; i += 1) val = (val << 1) | dataBits[pos + i]!;
    return val;
  };
  const mode = readBits(0, 4);
  if (mode !== 0b0100) throw new Error(`Expected Byte mode QR (4), got ${mode}`);
  const countBits = spec.version <= 9 ? 8 : 16;
  const byteLen = readBits(4, countBits);
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) out[i] = readBits(4 + countBits + i * 8, 8);
  return new TextDecoder('utf-8', { fatal: true }).decode(out);
}

async function decodeRenderedQrSvg(svg: Locator): Promise<string> {
  await expect(svg).toBeVisible();
  const viewBox = await svg.getAttribute('viewBox');
  expect(viewBox).toBeTruthy();
  const path = svg.locator('path');
  await expect(path).toBeVisible();
  const d = await path.getAttribute('d');
  expect(d).toBeTruthy();
  return decodeQrSvgPath(d!, viewBox!, 4);
}

interface SealedPdfInspection {
  pages: Array<{ dict: string; text: string }>;
  bookmarks: Array<{ title: string; pageIndex: number }>;
}

/**
 * Inspects a pdf-lib sealed packet binary (including FlateDecode /ObjStm and /Contents streams)
 * to verify physical page order, copied page content, A4 page sizing, and /Outlines bookmarks.
 */
function inspectSealedMultiDocPdf(pdfBytes: Buffer): SealedPdfInspection {
  const latin = pdfBytes.toString('latin1');
  const objects = new Map<number, { dict: string; stream?: Buffer }>();
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = objRe.exec(latin)) !== null) {
    const id = Number(match[1]);
    let pos = objRe.lastIndex;
    while (pos < latin.length && /\s/.test(latin[pos] ?? '')) pos += 1;
    const endObjPos = latin.indexOf('endobj', pos);
    const streamKwPos = latin.indexOf('stream', pos);

    if (streamKwPos !== -1 && (endObjPos === -1 || streamKwPos < endObjPos)) {
      const dict = latin.slice(pos, streamKwPos).trim();
      let sStart = streamKwPos + 6;
      if (latin[sStart] === '\r' && latin[sStart + 1] === '\n') sStart += 2;
      else if (latin[sStart] === '\n') sStart += 1;
      const directLen = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const endStreamPos = latin.indexOf('endstream', sStart);
      const streamLen = directLen
        ? Number(directLen[1])
        : Math.max(0, (endStreamPos === -1 ? sStart : endStreamPos) - sStart);
      const rawStream = pdfBytes.subarray(sStart, sStart + streamLen);
      let stream = rawStream;
      if (/\/FlateDecode\b/.test(dict)) {
        try {
          stream = zlib.inflateSync(rawStream);
        } catch {
          stream = rawStream;
        }
      }
      objects.set(id, { dict, stream });

      if (/\/Type\s*\/ObjStm\b/.test(dict)) {
        const firstMatch = /\/First\s+(\d+)/.exec(dict);
        if (firstMatch) {
          const first = Number(firstMatch[1]);
          const header = stream
            .subarray(0, first)
            .toString('latin1')
            .trim()
            .split(/\s+/)
            .map(Number);
          const body = stream.subarray(first).toString('latin1');
          for (let k = 0; k + 1 < header.length; k += 2) {
            const embId = header[k]!;
            const off = header[k + 1]!;
            const nextOff = k + 3 < header.length ? header[k + 3]! : body.length;
            objects.set(embId, { dict: body.slice(off, nextOff).trim() });
          }
        }
      }
    } else if (endObjPos !== -1) {
      objects.set(id, { dict: latin.slice(pos, endObjPos).trim() });
    }
  }

  const rootMatch = [...latin.matchAll(/\/Root\s+(\d+)\s+0\s+R/g)].pop();
  if (!rootMatch) throw new Error('Missing /Root catalog reference in sealed PDF');
  const catalog = objects.get(Number(rootMatch[1]))?.dict ?? '';
  const pagesRootMatch = /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog);
  if (!pagesRootMatch) throw new Error('Missing /Pages reference in sealed PDF catalog');

  const pageIds: number[] = [];
  const walkPages = (pid: number) => {
    const dict = objects.get(pid)?.dict ?? '';
    const kids = /\/Kids\s*\[([^\]]+)\]/.exec(dict);
    if (kids) {
      for (const rm of kids[1]!.matchAll(/(\d+)\s+0\s+R/g)) walkPages(Number(rm[1]));
    } else if (/\/Type\s*\/Page\b/.test(dict)) {
      pageIds.push(pid);
    }
  };
  walkPages(Number(pagesRootMatch[1]));

  const pages = pageIds.map((pid) => {
    const dict = objects.get(pid)?.dict ?? '';
    const refs: number[] = [];
    const cArr = /\/Contents\s*\[([^\]]+)\]/.exec(dict);
    if (cArr) {
      for (const rm of cArr[1]!.matchAll(/(\d+)\s+0\s+R/g)) refs.push(Number(rm[1]));
    } else {
      const cOne = /\/Contents\s+(\d+)\s+0\s+R/.exec(dict);
      if (cOne) refs.push(Number(cOne[1]));
    }
    const text = refs.map((cid) => objects.get(cid)?.stream?.toString('latin1') ?? '').join('\n');
    return { dict, text };
  });

  const bookmarks: Array<{ title: string; pageIndex: number }> = [];
  const outlinesRefM = /\/Outlines\s+(\d+)\s+0\s+R/.exec(catalog);
  if (outlinesRefM) {
    const outlinesDict = objects.get(Number(outlinesRefM[1]))?.dict ?? '';
    let cur = /\/First\s+(\d+)\s+0\s+R/.exec(outlinesDict)?.[1];
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const itemDict = objects.get(Number(cur))?.dict ?? '';
      const hexTitle = /\/Title\s*<([0-9A-Fa-f]+)>/.exec(itemDict);
      let title = '';
      if (hexTitle) {
        const hb = Buffer.from(hexTitle[1]!, 'hex');
        if (hb[0] === 0xfe && hb[1] === 0xff) {
          const codeUnits: number[] = [];
          for (let j = 2; j + 1 < hb.length; j += 2) {
            codeUnits.push((hb[j]! << 8) | hb[j + 1]!);
          }
          title = String.fromCharCode(...codeUnits);
        } else {
          title = hb.toString('latin1');
        }
      }
      const destRef = /\/Dest\s*\[\s*(\d+)\s+0\s+R/.exec(itemDict);
      bookmarks.push({
        title,
        pageIndex: destRef ? pageIds.indexOf(Number(destRef[1])) + 1 : -1,
      });
      cur = /\/Next\s+(\d+)\s+0\s+R/.exec(itemDict)?.[1];
    }
  }

  return { pages, bookmarks };
}

test.describe('eSign Slice 6a-6d E2E', () => {
  test('Slice 6b + 6c: .docx upload to tagged A4 PDF, multi-document packet 1-2 PDFs & reorder, and unified SHA-256 sealing', async ({
    page,
    browser,
  }) => {
    const email = newEmail('esign-s6bc');
    await signInNewUser(page, email);
    const slug = await createOrg(page, 'E2E eSign S6bc');

    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: 'eSign', exact: true }).click();
    await nav.getByRole('link', { name: 'Hồ sơ ký', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes$`));

    // 1. Upload a pure-JS synthetic .docx via FormDialog and wait for ludy-extract conversion.
    await page.getByTestId('sign-new-envelope-btn').click();
    await expect(page.getByTestId('sign-create-dialog')).toBeVisible();

    const docxFilename = 'hop-dong-dich-vu-s6b.docx';
    const convertedPdfFilename = 'hop-dong-dich-vu-s6b.pdf';
    const envelopeTitle = `Hop dong Word S6bc ${Date.now()}`;
    await page.getByTestId('sign-upload-pdf-input').setInputFiles({
      name: docxFilename,
      mimeType: DOCX_MIME,
      buffer: createMinimalDocxBytes({
        title: 'HỢP ĐỒNG CUNG CẤP DỊCH VỤ',
        paragraphs: [
          'Bên A: Công ty TNHH Thương Mại Ánh Dương (MST 0312345678).',
          'Bên B: Nguyễn Văn An.',
          'Điều khoản thanh toán bằng đồng Việt Nam theo tiến độ nghiệm thu.',
          'Đại diện ký tên: {{signature, r1}}',
        ],
      }),
    });

    await expect(page.getByTestId('sign-docx-converted-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('sign-docx-converted-ready')).toHaveText(
      `Đã chuyển đổi sang PDF A4 (1 trang): ${convertedPdfFilename}`,
    );
    await expect(page.getByTestId('sign-docx-warning-banner')).toHaveCount(0);

    await page.locator('#sign-new-title').fill(envelopeTitle);
    await page.getByTestId('sign-create-submit-btn').click();

    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes/[^/]+$`), { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: envelopeTitle })).toBeVisible();

    // React Query polls every 3s while inspect_status is pending.
    await expect(page.getByText('PDF đạt chuẩn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForPdfViewerReady(page);
    await expect(page.getByTestId('sign-packet-counters')).toContainText('1/5 tệp');
    await expect(page.getByTestId('sign-packet-counters')).toContainText('1/200 trang');

    // 2. Attach a 2nd PDF via SignPacketManager, wait for inspection, and test reorder.
    const secondPdfTitle = 'phu-luc-ban-giao-s6c';
    const addDocResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/envelope/document/add') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-packet-file-input').setInputFiles({
      name: `${secondPdfTitle}.pdf`,
      mimeType: 'application/pdf',
      buffer: createTextPdfBytes([
        'PHU LUC BAN GIAO DICH VU S6C',
        'Kem theo hop dong chinh da chuyen doi tu Word.',
        'Ben nhan xac nhan kiem tra va ky ket bo ho so.',
      ]),
    });
    expect((await addDocResp).status()).toBe(200);

    await expect(page.getByTestId('sign-packet-counters')).toContainText('2/5 tệp', { timeout: 20_000 });
    await expect(page.getByTestId('sign-packet-manager').getByText('Đang kiểm tra PDF')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('sign-packet-counters')).toContainText('2/200 trang');

    await expect(page.getByTestId('sign-packet-tabs')).toBeVisible();
    await expect(page.getByTestId('sign-packet-doc-row-1')).toContainText(envelopeTitle);
    await expect(page.getByTestId('sign-packet-doc-row-2')).toContainText(secondPdfTitle);

    const reorderResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/envelope/document/reorder') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-packet-move-up-2').click();
    expect((await reorderResp).status()).toBe(200);

    await expect(page.getByTestId('sign-packet-doc-row-1')).toContainText(secondPdfTitle, { timeout: 15_000 });
    await expect(page.getByTestId('sign-packet-doc-row-2')).toContainText(envelopeTitle);
    await expect(page.getByTestId('sign-packet-tab-1')).toContainText(secondPdfTitle);
    await expect(page.getByTestId('sign-packet-tab-2')).toContainText(envelopeTitle);

    // 3. Add link signer, place a text field on Doc 1 and apply the .docx {{signature, r1}} tag on Doc 2.
    const signerName = 'Nguyen Van An';
    const addSignerForm = page.getByTestId('add-signer-form');
    await addSignerForm.locator('#signer-name').fill(signerName);
    await addSignerForm.locator('#signer-delivery').selectOption('link');
    await addSignerForm.getByRole('button', { name: 'Thêm người nhận' }).click();
    await expect(page.getByTestId('signer-list')).toContainText(signerName, { timeout: 15_000 });

    await page.getByTestId('sign-packet-tab-1').click();
    await waitForPdfViewerReady(page);
    await page.getByTestId('palette-add-text').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(1);

    await page.getByTestId('sign-packet-tab-2').click();
    await waitForPdfViewerReady(page);
    await expect(page.getByTestId('sign-detected-tags-banner')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('sign-apply-detected-tags-btn').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(1);

    const saveFieldsBtn = page.getByTestId('sign-save-fields-btn');
    await expect(saveFieldsBtn).toBeEnabled();
    await saveFieldsBtn.click();
    await expect(saveFieldsBtn).toBeDisabled({ timeout: 15_000 });

    await page.getByTestId('sign-send-open-btn').click();
    const sendConfirmDialog = page.getByRole('dialog', { name: 'Xác nhận gửi yêu cầu ký' });
    await expect(sendConfirmDialog).toBeVisible();
    await sendConfirmDialog.getByRole('button', { name: 'Gửi yêu cầu ký' }).click();
    await expect(page.getByText('Đã gửi', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    const linkCard = page.getByTestId('minted-zalo-links-card');
    const urlInput = linkCard.locator('[data-testid^="zalo-link-input-"]').first();
    const prevUrl = (await urlInput.count()) > 0 ? await urlInput.inputValue() : '';
    const mintResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/signer/create_link') && res.request().method() === 'POST',
    );
    await page.locator('[data-testid^="signer-row-"]').first().getByRole('button', { name: 'Chép link Zalo' }).click();
    expect((await mintResp).status()).toBe(200);
    await expect(linkCard).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => urlInput.inputValue(), { timeout: 15_000 }).not.toBe(prevUrl);
    const mintedLink = await urlInput.inputValue();
    expect(mintedLink).toContain('/-/sign#');
    expect(mintedLink).not.toContain(`/o/${slug}`);

    // 4. Open /-/sign#<token> in a fresh unauthenticated mobile context (375x812).
    const mobileCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const mobilePage = await mobileCtx.newPage();

    try {
      await mobilePage.goto(mintedLink);
      await expect(mobilePage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => new URL(mobilePage.url()).hash).toBe('');
      expect(mobilePage.url()).not.toContain(`/o/${slug}`);
      await waitForPdfViewerReady(mobilePage);
      await assertNoHorizontalOverflow(mobilePage);

      await expect(mobilePage.getByTestId('sign-packet-tabs')).toBeVisible();
      await expect(mobilePage.getByTestId('sign-packet-tab-1')).toContainText(secondPdfTitle);
      await expect(mobilePage.getByTestId('sign-packet-tab-2')).toContainText(envelopeTitle);

      const multiDocConsent = mobilePage.getByTestId('ceremony-multi-doc-consent-note');
      await expect(multiDocConsent).toBeVisible();
      await expect(multiDocConsent).toContainText('2 tài liệu');

      // Inspect Doc 2 tab and verify zero overflow on mobile.
      await mobilePage.getByTestId('sign-packet-tab-2').click();
      await waitForPdfViewerReady(mobilePage);
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.getByPlaceholder('Nhập nội dung...').first().fill('Xac nhan du bo 2 tai lieu');
      await completeTypedSignature(mobilePage, signerName);

      const consentCheckbox = mobilePage.getByTestId('ceremony-consent-checkbox');
      await expect(consentCheckbox).toBeEnabled();
      await consentCheckbox.check();
      const submitBtn = mobilePage.getByTestId('ceremony-submit-btn');
      await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
      await submitBtn.click();

      await expect(mobilePage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 30_000 });
    } finally {
      await mobileCtx.close();
    }

    // 5. Verify unified SHA-256 sealing, sealed PDF digest, and certificate.json documents on host detail.
    await expect(page.getByText('Đã niêm phong SHA-256', { exact: true }).first()).toBeVisible({ timeout: 60_000 });

    const evidenceCard = page.getByTestId('sign-evidence-card');
    await expect(evidenceCard).toBeVisible();
    await expect(evidenceCard).toContainText('SHA-256 bản niêm phong', { timeout: 20_000 });
    await expect(evidenceCard).toContainText('Chuỗi băm toàn vẹn');
    const evidenceText = (await evidenceCard.textContent()) ?? '';
    const certCodeMatch = evidenceText.match(/CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(certCodeMatch?.[0]).toMatch(/^CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const certificateCode = certCodeMatch![0];

    const sealedDownloadPromise = page.waitForEvent('download');
    await evidenceCard.getByRole('button', { name: 'Tải bản đã niêm phong' }).click();
    const sealedDownload = await sealedDownloadPromise;
    const sealedPath = await sealedDownload.path();
    expect(sealedPath).toBeTruthy();
    const sealedPdfBytes = await fs.readFile(sealedPath!);
    expect(sealedPdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const sealedPdfSha256 = createHash('sha256').update(sealedPdfBytes).digest('hex');
    await expect(evidenceCard).toContainText(sealedPdfSha256);

    const certDownloadPromise = page.waitForEvent('download');
    await evidenceCard.getByRole('button', { name: 'Tải chứng chỉ JSON' }).click();
    const certDownload = await certDownloadPromise;
    const certPath = await certDownload.path();
    expect(certPath).toBeTruthy();
    const certJson = JSON.parse(await fs.readFile(certPath!, 'utf8')) as {
      certificateCode: string;
      envelopeTitle: string;
      sourceSha256: string;
      sealedSha256: string;
      documents?: Array<{
        index: number;
        title: string;
        startPage: number;
        endPage: number;
        pageCount: number;
        sourceSha256: string;
      }>;
    };
    expect(certJson.certificateCode).toBe(certificateCode);
    expect(certJson.envelopeTitle).toBe(envelopeTitle);
    expect(certJson.sealedSha256).toBe(sealedPdfSha256);
    expect(certJson.documents).toHaveLength(2);
    expect(certJson.documents![0]).toMatchObject({
      index: 1,
      title: secondPdfTitle,
      startPage: 1,
      endPage: 1,
      pageCount: 1,
    });
    expect(certJson.documents![1]).toMatchObject({
      index: 2,
      title: envelopeTitle,
      startPage: 2,
      endPage: 2,
      pageCount: 1,
    });
    expect(certJson.sourceSha256).toBe(certJson.documents![0]!.sourceSha256);

    const sealedInspection = inspectSealedMultiDocPdf(sealedPdfBytes);
    expect(sealedInspection.pages.length).toBeGreaterThanOrEqual(3);
    expect(sealedInspection.pages[0]!.text).toContain('PHU LUC BAN GIAO DICH VU S6C');
    expect(sealedInspection.pages[1]!.text).not.toContain('PHU LUC BAN GIAO DICH VU S6C');
    expect(sealedInspection.pages[1]!.dict).toContain('595.28');
    expect(sealedInspection.pages[1]!.dict).toContain('841.89');
    expect(sealedInspection.bookmarks).toEqual([
      { title: secondPdfTitle, pageIndex: 1 },
      { title: envelopeTitle, pageIndex: 2 },
    ]);
  });

  test('Slice 6a + 6d: QR scan-to-sign handoff, VietQR deposit profile + immutable envelope snapshot, and post-sign VietQR deposit card', async ({
    page,
    browser,
  }) => {
    const email = newEmail('esign-s6ad');
    await signInNewUser(page, email);
    const slug = await createOrg(page, 'E2E eSign S6ad');

    // 1. Configure & persist org VietQR deposit profile in /o/<slug>/sign/settings.
    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: 'eSign', exact: true }).click();
    await nav.getByRole('link', { name: 'Chữ ký số & con dấu', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/settings`));

    const depositProfileCard = page.getByTestId('sign-deposit-profile-card');
    await expect(depositProfileCard).toBeVisible({ timeout: 30_000 });
    const depositProfileForm = page.getByTestId('sign-deposit-profile-form');
    await expect(depositProfileForm).toBeVisible({ timeout: 30_000 });

    // Valid bank code from packages/l10n-vn/src/banks.ts ('VCB').
    await depositProfileForm.getByTestId('hr-bank-select').selectOption('VCB');
    await depositProfileForm.getByTestId('sign-deposit-account-number').fill('0123456789');
    await depositProfileForm.getByTestId('sign-deposit-account-holder').fill('CONG TY TNHH E2E VIETQR');
    await depositProfileForm.getByTestId('sign-deposit-finance-account').fill('1121.VCB');
    await depositProfileForm.getByTestId('sign-deposit-qr-file-input').setInputFiles({
      name: 'vietqr-static.png',
      mimeType: 'image/png',
      buffer: TINY_PNG_BYTES,
    });
    await expect(depositProfileForm.getByTestId('sign-deposit-qr-preview')).toBeVisible({ timeout: 15_000 });

    const saveProfileResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/depositProfile/upsert') && res.request().method() === 'POST',
    );
    await depositProfileForm.getByTestId('sign-deposit-profile-save-btn').click();
    expect((await saveProfileResp).status()).toBe(200);
    await expect(depositProfileForm.getByTestId('sign-deposit-profile-clear-btn')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    const reloadedForm = page.getByTestId('sign-deposit-profile-form');
    await expect(reloadedForm).toBeVisible({ timeout: 30_000 });
    await expect(reloadedForm.getByTestId('hr-bank-select')).toHaveValue('VCB');
    await expect(reloadedForm.getByTestId('sign-deposit-account-number')).toHaveValue('0123456789');
    await expect(reloadedForm.getByTestId('sign-deposit-account-holder')).toHaveValue('CONG TY TNHH E2E VIETQR');
    await expect(reloadedForm.getByTestId('sign-deposit-finance-account')).toHaveValue('1121.VCB');
    await expect(reloadedForm.getByTestId('sign-deposit-qr-preview')).toBeVisible({ timeout: 15_000 });
    await expect(reloadedForm.getByTestId('sign-deposit-profile-clear-btn')).toBeVisible();

    // 2. Create PDF envelope, add signer + signature field, enable VietQR deposit, and send.
    await nav.getByRole('link', { name: 'Hồ sơ ký', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes$`));

    await page.getByTestId('sign-new-envelope-btn').click();
    await expect(page.getByTestId('sign-create-dialog')).toBeVisible();

    const contractTitle = `Hop dong VietQR QR ${Date.now()}`;
    await page.getByTestId('sign-upload-pdf-input').setInputFiles({
      name: 'hop-dong-dat-coc.pdf',
      mimeType: 'application/pdf',
      buffer: createTextPdfBytes([
        'HOP DONG DICH VU VA DAT COC VIETQR',
        'Ben A: Cong ty TNHH E2E VietQR',
        'Ben B: Tran Thi Binh',
        'Gia tri dat coc: 1.500.000 VND sau khi ky.',
      ]),
    });
    await page.locator('#sign-new-title').fill(contractTitle);
    await page.getByTestId('sign-create-submit-btn').click();

    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes/[^/]+$`), { timeout: 30_000 });

    // React Query polls every 3s while inspect_status is pending.
    await expect(page.getByText('PDF đạt chuẩn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForPdfViewerReady(page);

    const signerName = 'Tran Thi Binh';
    const addSignerForm = page.getByTestId('add-signer-form');
    await addSignerForm.locator('#signer-name').fill(signerName);
    await addSignerForm.locator('#signer-delivery').selectOption('link');
    await addSignerForm.getByRole('button', { name: 'Thêm người nhận' }).click();
    await expect(page.getByTestId('signer-list')).toContainText(signerName, { timeout: 15_000 });

    await page.getByTestId('palette-add-signature').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(1);
    const saveFieldsBtn = page.getByTestId('sign-save-fields-btn');
    await expect(saveFieldsBtn).toBeEnabled();
    await saveFieldsBtn.click();
    await expect(saveFieldsBtn).toBeDisabled({ timeout: 15_000 });

    await page.getByTestId('sign-deposit-enable-btn').click();
    await expect(page.getByTestId('sign-envelope-deposit-form')).toBeVisible();
    await page.getByTestId('sign-deposit-amount-input').fill('1500000');
    await page.getByTestId('sign-deposit-due-days-input').fill('3');
    await page.getByTestId('sign-deposit-note-input').fill('Dat coc dot 1 hop dong dich vu');

    const saveDepositResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/deposit/set') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-deposit-save-btn').click();
    expect((await saveDepositResp).status()).toBe(200);
    const draftMemoInput = page.getByTestId('sign-deposit-memo-input');
    await expect(draftMemoInput).toHaveValue(/^CK-[A-Z0-9]{6,12}$/, {
      timeout: 15_000,
    });
    const draftMemo = await draftMemoInput.inputValue();
    expect(draftMemo).toMatch(/^CK-[A-Z0-9]{6,12}$/);
    await expect(page.getByTestId('sign-deposit-remove-btn')).toBeVisible();

    await page.getByTestId('sign-send-open-btn').click();
    const sendConfirmDialog = page.getByRole('dialog', { name: 'Xác nhận gửi yêu cầu ký' });
    await expect(sendConfirmDialog).toBeVisible();
    await sendConfirmDialog.getByRole('button', { name: 'Gửi yêu cầu ký' }).click();
    await expect(page.getByText('Đã gửi', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // Verify immutable deposit snapshot locks on send and stays untouched if org settings later change.
    const snapshotCard = page.getByTestId('sign-envelope-deposit-snapshot-card');
    await expect(snapshotCard).toBeVisible({ timeout: 20_000 });
    const snapshotMemoLocator = page.getByTestId('sign-deposit-snapshot-memo');
    await expect(snapshotMemoLocator).toHaveText(draftMemo);
    const depositMemo = (await snapshotMemoLocator.textContent())?.trim() ?? '';
    expect(depositMemo).toBe(draftMemo);
    await expect(snapshotCard.locator('dd', { hasText: /^1\.500\.000[\s\u00a0]₫$/ })).toBeVisible();
    await expect(snapshotCard).toContainText('0123456789');
    await expect(snapshotCard).toContainText('CONG TY TNHH E2E VIETQR');
    await expect(snapshotCard).toContainText('3 ngày sau khi ký');

    const session = await storedSession(page);
    const rotateProfileRes = await page.request.post('/api/rpc/sign/depositProfile/upsert', {
      headers: {
        authorization: `Bearer ${session?.access_token ?? ''}`,
        'x-ludy-org': slug,
      },
      data: {
        json: {
          bankCode: 'ACB',
          accountNumber: '9988776655',
          accountHolder: 'CONG TY THAY DOI SAU GUI',
        },
      },
    });
    expect(rotateProfileRes.status(), await rotateProfileRes.text()).toBe(200);
    await page.reload();
    await expect(snapshotCard).toBeVisible({ timeout: 20_000 });
    await expect(snapshotMemoLocator).toHaveText(depositMemo);
    await expect(snapshotCard).toContainText('0123456789');
    await expect(snapshotCard).toContainText('CONG TY TNHH E2E VIETQR');
    await expect(snapshotCard).not.toContainText('9988776655');

    // 3. Slice 6a QR verification: in-person counter QR modal, Zalo link QR modal, and desktop-to-mobile QR handoff.
    const origin = new URL(page.url()).origin;
    await page.locator('[data-testid^="signer-in-person-btn-"]').first().click();
    const inPersonDialog = page.getByTestId('in-person-handoff-dialog');
    await expect(inPersonDialog).toBeVisible();
    const startInPersonResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/signer/start_in_person') && res.request().method() === 'POST',
    );
    await page.getByTestId('in-person-mint-btn').click();
    expect((await startInPersonResp).status()).toBe(200);

    await page.getByTestId('in-person-qr-btn').click();
    const inPersonQrModal = page.getByTestId('in-person-qr-modal');
    await expect(inPersonQrModal).toBeVisible();
    await expect(page.getByTestId('in-person-qr-modal-in-person-note')).toBeVisible();
    const decodedInPersonUrl = await decodeRenderedQrSvg(page.getByTestId('in-person-qr-modal-svg'));
    const inPersonQrUrl = await page.getByTestId('in-person-qr-modal-url-input').inputValue();
    expect(decodedInPersonUrl).toBe(inPersonQrUrl);
    expect(decodedInPersonUrl).toContain(`${origin}/-/sign?in_person=1#`);
    expect(decodedInPersonUrl).not.toContain(`/o/${slug}`);
    await page.getByTestId('in-person-qr-modal-close-btn').click();
    await expect(inPersonQrModal).toHaveCount(0);
    await inPersonDialog.getByRole('button', { name: 'Đóng' }).click();
    await expect(inPersonDialog).toHaveCount(0);

    // Mint a fresh standard remote signing link (revoking the unused in-person token so post-sign deposit card is shown).
    const linkCard = page.getByTestId('minted-zalo-links-card');
    const urlInput = linkCard.locator('[data-testid^="zalo-link-input-"]').first();
    const prevUrl = (await urlInput.count()) > 0 ? await urlInput.inputValue() : '';
    const mintResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/signer/create_link') && res.request().method() === 'POST',
    );
    await page.locator('[data-testid^="signer-row-"]').first().getByRole('button', { name: 'Chép link Zalo' }).click();
    expect((await mintResp).status()).toBe(200);
    await expect(linkCard).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => urlInput.inputValue(), { timeout: 15_000 }).not.toBe(prevUrl);
    const mintedLink = await urlInput.inputValue();
    expect(mintedLink).toContain(`${origin}/-/sign#`);
    expect(mintedLink).not.toContain(`/o/${slug}`);

    await linkCard.locator('[data-testid^="zalo-link-qr-btn-"]').first().click();
    const zaloQrModal = page.getByTestId('zalo-link-qr-modal');
    await expect(zaloQrModal).toBeVisible();
    await expect(page.getByTestId('zalo-link-qr-modal-url-input')).toHaveValue(mintedLink);
    const decodedZaloQrUrl = await decodeRenderedQrSvg(page.getByTestId('zalo-link-qr-modal-svg'));
    expect(decodedZaloQrUrl).toBe(mintedLink);
    expect(decodedZaloQrUrl).not.toBe(decodedInPersonUrl);
    await page.getByTestId('zalo-link-qr-modal-close-btn').click();
    await expect(zaloQrModal).toHaveCount(0);

    // Desktop ceremony opens QR handoff modal; isolated mobile context scans & signs; desktop syncs.
    const desktopCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const desktopPage = await desktopCtx.newPage();

    try {
      await desktopPage.goto(mintedLink);
      await expect(desktopPage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => new URL(desktopPage.url()).hash).toBe('');
      expect(desktopPage.url()).not.toContain(`/o/${slug}`);

      await desktopPage.getByTestId('ceremony-qr-handoff-btn').click();
      const ceremonyQrModal = desktopPage.getByTestId('ceremony-qr-modal');
      await expect(ceremonyQrModal).toBeVisible();
      const decodedQrUrl = await decodeRenderedQrSvg(desktopPage.getByTestId('ceremony-qr-modal-svg'));
      await assertNoHorizontalOverflow(desktopPage);

      const handoffUrl = await desktopPage.getByTestId('ceremony-qr-modal-url-input').inputValue();
      expect(decodedQrUrl).toBe(handoffUrl);
      expect(decodedQrUrl).toContain(`${origin}/-/sign#`);
      expect(decodedQrUrl).not.toContain(`/o/${slug}`);

      const mobileCtx = await browser.newContext({
        viewport: { width: 375, height: 812 },
      });
      const mobilePage = await mobileCtx.newPage();

      try {
        await mobilePage.goto(decodedQrUrl);
        await expect(mobilePage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => new URL(mobilePage.url()).hash).toBe('');
        expect(mobilePage.url()).not.toContain(`/o/${slug}`);
        const storageKeys = await mobilePage.evaluate(() => Object.keys(window.localStorage));
        expect(storageKeys).not.toContain('ludy-auth');
        await waitForPdfViewerReady(mobilePage);
        await assertNoHorizontalOverflow(mobilePage);

        await completeTypedSignature(mobilePage, signerName);

        const consentCheckbox = mobilePage.getByTestId('ceremony-consent-checkbox');
        await expect(consentCheckbox).toBeEnabled();
        await consentCheckbox.check();
        const submitBtn = mobilePage.getByTestId('ceremony-submit-btn');
        await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
        const depositQrRespPromise = mobilePage.waitForResponse(
          (res) => res.url().includes('/api/sign/deposit-qr') && res.request().method() === 'POST',
        );
        await submitBtn.click();

        await expect(mobilePage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 30_000 });

        // 4. Verify Slice 6d post-sign VietQR deposit card on 375x812 mobile viewport with frozen snapshot data.
        const depositCard = mobilePage.getByTestId('sign-ceremony-deposit-card');
        await expect(depositCard).toBeVisible({ timeout: 15_000 });
        await expect(mobilePage.getByTestId('sign-ceremony-deposit-amount')).toHaveText(/^1\.500\.000[\s\u00a0]₫$/);
        await expect(mobilePage.getByTestId('sign-ceremony-deposit-memo')).toHaveText(depositMemo);
        await expect(mobilePage.getByTestId('sign-ceremony-deposit-account')).toHaveText('0123456789');
        await expect(depositCard).toContainText('CONG TY TNHH E2E VIETQR');
        await expect(depositCard).toContainText('Dat coc dot 1 hop dong dich vu');
        await expect(depositCard).toContainText('Trong vòng 3 ngày sau khi ký');
        await expect(depositCard).not.toContainText('9988776655');

        const depositQrResp = await depositQrRespPromise;
        expect(depositQrResp.status()).toBe(200);
        expect(depositQrResp.headers()['content-type']).toContain('image/png');
        expect(depositQrResp.headers()['content-length']).toBe(String(TINY_PNG_BYTES.byteLength));
        expect(depositQrResp.headers()['cache-control']).toBe('no-store');
        expect(depositQrResp.headers()['x-content-type-options']).toBe('nosniff');

        const qrImg = mobilePage.getByTestId('sign-ceremony-deposit-qr-img');
        await expect(qrImg).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(
            () =>
              qrImg.evaluate((el) => {
                const img = el as HTMLImageElement;
                return img.complete && img.naturalWidth === 1 && img.naturalHeight === 1 && img.src.startsWith('blob:');
              }),
            { timeout: 15_000 },
          )
          .toBe(true);

        // Verify exact PNG bytes directly via unauthenticated APIRequestContext (Chromium CDP does not retain no-store fetch().blob() bodies).
        const handoffToken = new URL(decodedQrUrl).hash.slice(1).trim();
        expect(handoffToken.length).toBeGreaterThan(0);
        const directDepositQrRes = await mobileCtx.request.post(`${origin}/api/sign/deposit-qr`, {
          data: { token: handoffToken },
        });
        expect(directDepositQrRes.status()).toBe(200);
        expect(directDepositQrRes.headers()['content-type']).toContain('image/png');
        expect(directDepositQrRes.headers()['content-length']).toBe(String(TINY_PNG_BYTES.byteLength));
        expect(directDepositQrRes.headers()['cache-control']).toBe('no-store');
        expect(directDepositQrRes.headers()['x-content-type-options']).toBe('nosniff');
        expect((await directDepositQrRes.body()).equals(TINY_PNG_BYTES)).toBe(true);
        await assertNoHorizontalOverflow(mobilePage);
      } finally {
        await mobileCtx.close();
      }

      // Desktop QR modal polling syncs cleanly to completed state + deposit card when brought back to foreground.
      await desktopPage.bringToFront();
      await expect(ceremonyQrModal).toHaveCount(0, { timeout: 30_000 });
      await expect(desktopPage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 30_000 });
      await expect(desktopPage.getByTestId('sign-ceremony-deposit-card')).toBeVisible({ timeout: 15_000 });
      await expect(desktopPage.getByTestId('sign-ceremony-deposit-memo')).toHaveText(depositMemo);
    } finally {
      await desktopCtx.close();
    }
  });
});
