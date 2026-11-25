// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import {
  EXTRACT_LIMITS,
  createExtractClient,
  encodePdfSealInput,
  type PdfSealInput,
} from '@ludy/extract-contract';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  type PDFObject,
} from 'pdf-lib';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { inspectPdf, loadValidatedPdfForIncrementalUpdate } from '../src/seal.ts';
import { createExtractApp } from '../src/server.ts';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makeTestPng(width: number, height: number, rgba = true): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = rgba ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const channels = rgba ? 4 : 3;
  const stride = 1 + width * channels;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * channels;
      const stroke = Math.abs(x - y) <= 1;
      if (rgba) {
        raw[px] = stroke ? 15 : 255;
        raw[px + 1] = stroke ? 40 : 255;
        raw[px + 2] = stroke ? 120 : 255;
        raw[px + 3] = stroke ? 255 : 0;
      } else {
        raw[px] = stroke ? 15 : 255;
        raw[px + 1] = stroke ? 40 : 255;
        raw[px + 2] = stroke ? 120 : 255;
      }
    }
  }
  const idat = deflateSync(raw);
  return new Uint8Array(
    Buffer.concat([signature, makePngChunk('IHDR', ihdr), makePngChunk('IDAT', idat), makePngChunk('IEND', Buffer.alloc(0))]),
  );
}

function makeRawPdf(objects: string[], trailerExtra = ''): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function rebuildAsciiXref(rawPdf: string): Uint8Array {
  const xrefMatch = /(?:^|\r?\n)xref\r?\n/.exec(rawPdf);
  if (!xrefMatch || xrefMatch.index === undefined) {
    throw new Error('Missing xref table in synthetic test PDF');
  }
  const bodyEnd = xrefMatch[0].startsWith('\n') || xrefMatch[0].startsWith('\r')
    ? xrefMatch.index + (xrefMatch[0].startsWith('\r\n') ? 2 : 1)
    : xrefMatch.index;
  const trailerMatch = /\btrailer\s*(<<[\s\S]*?>>)\s*startxref\b/.exec(rawPdf.slice(bodyEnd));
  if (!trailerMatch || !trailerMatch[1]) {
    throw new Error('Missing trailer dict in synthetic test PDF');
  }
  const body = rawPdf.slice(0, bodyEnd);
  const offsets = new Map<number, { offset: number; gen: number }>();
  let maxNum = 0;
  const objRegex = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  for (const m of body.matchAll(objRegex)) {
    const rawNum = m[1];
    const rawGen = m[2];
    if (!rawNum || !rawGen || m.index === undefined) continue;
    const prefixLen = m[0].startsWith('\r\n') ? 2 : m[0].startsWith('\n') || m[0].startsWith('\r') ? 1 : 0;
    const num = Number.parseInt(rawNum, 10);
    const gen = Number.parseInt(rawGen, 10);
    offsets.set(num, { offset: m.index + prefixLen, gen });
    if (num > maxNum) maxNum = num;
  }
  const newXrefOffset = body.length;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxNum; i += 1) {
    const item = offsets.get(i);
    xref += item
      ? `${String(item.offset).padStart(10, '0')} ${String(item.gen).padStart(5, '0')} n \n`
      : '0000000000 65535 f \n';
  }
  const rebuilt = `${body}${xref}trailer\n${trailerMatch[1]}\nstartxref\n${newXrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(rebuilt, 'latin1'));
}

function makeRawXrefStreamPdf(
  normalObjects: Array<{ readonly num: number; readonly body: string }>,
  compressedObjects: Array<{ readonly num: number; readonly body: string }>,
  objStmNum: number,
  xrefNum: number,
): Uint8Array {
  let headerPairs = '';
  let bodyChunk = '';
  for (const item of compressedObjects) {
    const relOffset = bodyChunk.length;
    headerPairs += `${item.num} ${relOffset} `;
    bodyChunk += `${item.body}\n`;
  }
  const firstOffset = headerPairs.length;
  const objStmData = `${headerPairs}${bodyChunk}`;
  const objStmDictBody = `<< /Type /ObjStm /N ${compressedObjects.length} /First ${firstOffset} /Length ${objStmData.length} >>\nstream\n${objStmData}\nendstream`;

  let out = '%PDF-1.5\n';
  const entryMap = new Map<number, { kind: 1; offset: number } | { kind: 2; stmNum: number; idx: number }>();
  for (const item of normalObjects) {
    entryMap.set(item.num, { kind: 1, offset: out.length });
    out += `${item.num} 0 obj\n${item.body}\nendobj\n`;
  }
  entryMap.set(objStmNum, { kind: 1, offset: out.length });
  out += `${objStmNum} 0 obj\n${objStmDictBody}\nendobj\n`;

  const xrefOffset = out.length;
  entryMap.set(xrefNum, { kind: 1, offset: xrefOffset });
  for (let i = 0; i < compressedObjects.length; i += 1) {
    const item = compressedObjects[i];
    if (item) {
      entryMap.set(item.num, { kind: 2, stmNum: objStmNum, idx: i });
    }
  }

  let maxNum = xrefNum;
  for (const k of entryMap.keys()) {
    if (k > maxNum) maxNum = k;
  }
  const size = maxNum + 1;
  const tableBuf = Buffer.alloc(size * 7);
  for (let i = 0; i < size; i += 1) {
    const pos = i * 7;
    const entry = entryMap.get(i);
    if (!entry) {
      tableBuf[pos] = 0;
      tableBuf.writeUInt32BE(0, pos + 1);
      tableBuf.writeUInt16BE(i === 0 ? 65535 : 0, pos + 5);
    } else if (entry.kind === 1) {
      tableBuf[pos] = 1;
      tableBuf.writeUInt32BE(entry.offset, pos + 1);
      tableBuf.writeUInt16BE(0, pos + 5);
    } else {
      tableBuf[pos] = 2;
      tableBuf.writeUInt32BE(entry.stmNum, pos + 1);
      tableBuf.writeUInt16BE(entry.idx, pos + 5);
    }
  }

  const head = Buffer.from(
    `${out}${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /Root 1 0 R /W [1 4 2] /Length ${tableBuf.byteLength} >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return new Uint8Array(Buffer.concat([head, tableBuf, tail]));
}

function makeCertificate(overrides: Partial<PdfSealInput['certificate']> = {}): PdfSealInput['certificate'] {
  return {
    certificateCode: 'LUDY-ESIGN-2026-0001',
    envelopeTitle: 'Hợp đồng dịch vụ kế toán Công ty Đặng Gia',
    sourceSha256: 'a'.repeat(64),
    completedAtIso: '2026-11-15T10:30:00.000Z',
    eventChainTipHash: 'b'.repeat(64),
    signers: [
      {
        name: 'Nguyễn Văn Ánh',
        roleLabel: 'Giám đốc Bên A',
        maskedEmail: 'n***@danggia.vn',
        deliveryMode: 'email',
        otpStatus: 'verified',
        signedAtIso: '2026-11-15T10:25:00.000Z',
        ipHashPrefix: 'deadbeef1234',
        signatureKind: 'draw',
      },
      {
        name: 'Trần Thị Quỳnh Như',
        roleLabel: 'Đại diện Bên B',
        maskedEmail: null,
        deliveryMode: 'link',
        otpStatus: 'not_required',
        signedAtIso: '2026-11-15T10:30:00.000Z',
        ipHashPrefix: null,
        signatureKind: 'type',
      },
    ],
    ...overrides,
  };
}

async function readPdfBack(bytes: Uint8Array): Promise<{
  pageCount: number;
  pageTexts: string[];
  firstPageImageCount: number;
}> {
  const { extractImages, extractText, getDocumentProxy } = await import('unpdf');
  const proxy = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
  } as Parameters<typeof getDocumentProxy>[1]);
  const extracted = await extractText(proxy, { mergePages: false });
  const images = await extractImages(proxy, 1);
  return {
    pageCount: extracted.totalPages,
    pageTexts: Array.isArray(extracted.text) ? extracted.text : [extracted.text],
    firstPageImageCount: images.length,
  };
}

function decodePdfHexEscapesForTest(raw: string): string {
  return raw.replace(/<([0-9A-Fa-f\s]+)>/g, (match, hex: string) => {
    const compact = hex.replace(/\s+/g, '');
    if (compact.length === 0 || compact.length % 2 !== 0) return match;
    return Buffer.from(compact, 'hex').toString('latin1');
  });
}

async function assertNoSecretInSealedPdf(sealedBytes: Uint8Array, secrets: readonly string[]): Promise<void> {
  const sealedDoc = await PDFDocument.load(sealedBytes);
  const rawSealed = Buffer.from(sealedBytes).toString('latin1');
  const rawSealedLower = rawSealed.toLowerCase();
  const uncompressed = Buffer.from(await sealedDoc.save({ useObjectStreams: false })).toString('latin1');
  const uncompressedLower = uncompressed.toLowerCase();

  for (const secret of secrets) {
    const hexLower = Buffer.from(secret, 'utf8').toString('hex').toLowerCase();
    expect(rawSealed).not.toContain(secret);
    expect(rawSealedLower).not.toContain(hexLower);
    expect(uncompressed).not.toContain(secret);
    expect(uncompressedLower).not.toContain(hexLower);
  }

  for (const [, obj] of sealedDoc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const decoded = Buffer.from(decodePDFRawStream(obj as never).decode()).toString('latin1');
      const decodedLower = decoded.toLowerCase();
      const decodedHexEscapes = decodePdfHexEscapesForTest(decoded);
      for (const secret of secrets) {
        const hexLower = Buffer.from(secret, 'utf8').toString('hex').toLowerCase();
        expect(decoded).not.toContain(secret);
        expect(decodedLower).not.toContain(hexLower);
        expect(decodedHexEscapes).not.toContain(secret);
      }
    } else {
      const serialized = obj.toString();
      const serializedLower = serialized.toLowerCase();
      const decodedHexEscapes = decodePdfHexEscapesForTest(serialized);
      for (const secret of secrets) {
        const hexLower = Buffer.from(secret, 'utf8').toString('hex').toLowerCase();
        expect(serialized).not.toContain(secret);
        expect(serializedLower).not.toContain(hexLower);
        expect(decodedHexEscapes).not.toContain(secret);
      }
    }
  }
}

async function startHttpServer(): Promise<string> {
  const runner = (kind: Parameters<typeof runSandboxed>[0], bytes: Parameters<typeof runSandboxed>[1], signal: AbortSignal) =>
    runSandboxed(kind, bytes, undefined, signal);
  const app = createExtractApp({ run: runner, concurrency: 1, maxQueue: 4 });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve({ server: s, port: info.port }),
    );
  });
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}`;
}

describe('pdf_inspect', () => {
  it('inspects multi-page PDFs including rotation and CropBox dimensions', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('Page One Contract', { x: 48, y: 760, size: 12, font });

    const p2 = doc.addPage([600, 800]);
    p2.setRotation(degrees(90));
    p2.drawText('Page Two Rotated 90', { x: 48, y: 720, size: 12, font });

    const p3 = doc.addPage([612, 792]);
    p3.setCropBox(12, 20, 500, 700);
    p3.setRotation(degrees(270));
    p3.drawText('Page Three Cropped Rotated 270', { x: 48, y: 650, size: 12, font });

    const bytes = await doc.save();
    const res = await parse('pdf_inspect', bytes);
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect result');

    expect(res.pageCount).toBe(3);
    expect(res.pages[0]).toMatchObject({ page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0 });
    expect(res.pages[0]?.text).toContain('Page One Contract');

    // Visual dimensions swap width/height when rotated 90 or 270 degrees.
    expect(res.pages[1]).toMatchObject({ page: 2, widthPt: 800, heightPt: 600, rotation: 90 });
    expect(res.pages[1]?.text).toContain('Page Two Rotated 90');

    expect(res.pages[2]).toMatchObject({ page: 3, widthPt: 700, heightPt: 500, rotation: 270 });
    expect(res.pages[2]?.text).toContain('Page Three Cropped Rotated 270');
  });

  it('allows literal /JS or /OpenAction strings in document text and bounds total text to 64 KiB fairly', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const p1 = doc.addPage([595, 842]);
    p1.drawText('Document mentions /JS and /OpenAction in literal text', { x: 40, y: 780, size: 11, font });
    for (let row = 0; row < 40; row++) {
      p1.drawText(`Dense contract clause row ${row} `.repeat(25), { x: 20, y: 740 - row * 15, size: 6, font });
    }

    const p2 = doc.addPage([595, 842]);
    p2.drawText('PAGE_TWO_TAIL_MARKER', { x: 40, y: 780, size: 11, font });

    const bytes = await doc.save();
    const res = await parse('pdf_inspect', bytes);
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect result');

    const totalUtf8 = res.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text, 'utf8'), 0);
    expect(totalUtf8).toBeLessThanOrEqual(EXTRACT_LIMITS.maxPdfInspectTextBytes);
    expect(res.pages[0]?.text).toContain('/JS');
    expect(res.pages[1]?.text).toContain('PAGE_TWO_TAIL_MARKER');
  });

  it('rejects non-PDF bytes, encrypted PDFs, active JS/actions, and >200-page PDFs', async () => {
    const empty = await parse('pdf_inspect', new Uint8Array(0));
    expect(empty).toMatchObject({ ok: false, code: 'invalid' });

    const html = await parse('pdf_inspect', new TextEncoder().encode('<html><body>Not PDF</body></html>'));
    expect(html).toMatchObject({ ok: false, code: 'invalid' });

    const encrypted = makeRawPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
        '<< /Filter /Standard /V 1 /R 2 /O (abc) /U (def) /P -4 >>',
      ],
      '/Encrypt 4 0 R',
    );
    expect(await parse('pdf_inspect', encrypted)).toMatchObject({ ok: false, code: 'invalid' });

    const openActionHexEscaped = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Open#41ction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    ]);
    expect(await parse('pdf_inspect', openActionHexEscaped)).toMatchObject({ ok: false, code: 'invalid' });

    const jsNames = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 4 0 R >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '<< /Names [] >>',
    ]);
    expect(await parse('pdf_inspect', jsNames)).toMatchObject({ ok: false, code: 'invalid' });

    const launchAction = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] /A << /S /Launch /F (cmd.exe) >> >>] >>',
    ]);
    expect(await parse('pdf_inspect', launchAction)).toMatchObject({ ok: false, code: 'invalid' });

    const richMedia = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [<< /Type /Annot /Subtype /RichMedia /Rect [0 0 100 20] >>] >>',
    ]);
    expect(await parse('pdf_inspect', richMedia)).toMatchObject({ ok: false, code: 'invalid' });

    const additionalActions = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /AA << /O << /S /GoTo /D [3 0 R /Fit] >> >> >>',
    ]);
    expect(await parse('pdf_inspect', additionalActions)).toMatchObject({ ok: false, code: 'invalid' });

    const javascriptUri = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>] >>',
    ]);
    expect(await parse('pdf_inspect', javascriptUri)).toMatchObject({ ok: false, code: 'invalid' });

    const doc201 = await PDFDocument.create();
    for (let i = 0; i < 201; i++) doc201.addPage([200, 200]);
    expect(await parse('pdf_inspect', await doc201.save())).toMatchObject({ ok: false, code: 'invalid' });
  }, 15_000);
});

describe('pdf_seal', () => {
  it('stamps PNG signatures, Vietnamese Be Vietnam Pro text across rotations, flattens AcroForms, and appends an Audit Certificate', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();

    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('Contract Page 1', { x: 40, y: 780, size: 12, font });
    const textField = form.createTextField('partyA');
    textField.setText('PREFILLED_FORM_VALUE');
    textField.addToPage(p1, { x: 40, y: 700, width: 220, height: 22 });

    const p2 = doc.addPage([595.28, 841.89]);
    p2.setRotation(degrees(90));
    p2.drawText('Contract Page 2 Rotated 90', { x: 40, y: 500, size: 12, font });

    const p3 = doc.addPage([595.28, 841.89]);
    p3.setRotation(degrees(180));
    p3.drawText('Contract Page 3 Rotated 180', { x: 40, y: 700, size: 12, font });

    const p4 = doc.addPage([595.28, 841.89]);
    p4.setRotation(degrees(270));
    p4.drawText('Contract Page 4 Rotated 270', { x: 40, y: 500, size: 12, font });

    const sourceBytes = await doc.save();
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const sigPng = makeTestPng(80, 32, true);
    const sigPngB64 = Buffer.from(sigPng).toString('base64');
    const vnText = 'Nguyễn Văn Ánh - Giám đốc Công ty TNHH Một Thành Viên Đặng Gia, 1.234.567 ₫';

    const input: PdfSealInput = {
      pdfBase64: Buffer.from(sourceBytes).toString('base64'),
      fields: [
        { type: 'signature', page: 1, xNorm: 0.1, yNorm: 0.72, wNorm: 0.3, hNorm: 0.08, imagePngBase64: sigPngB64 },
        { type: 'text', page: 1, xNorm: 0.08, yNorm: 0.55, wNorm: 0.8, hNorm: 0.12, text: vnText, fontSizePt: 11 },
        { type: 'date', page: 2, xNorm: 0.1, yNorm: 0.2, wNorm: 0.35, hNorm: 0.08, text: '15/11/2026 - Ký trang xoay 90' },
        { type: 'initial', page: 3, xNorm: 0.7, yNorm: 0.8, wNorm: 0.15, hNorm: 0.08, text: 'ĐG' },
        { type: 'checkbox', page: 4, xNorm: 0.12, yNorm: 0.15, wNorm: 0.05, hNorm: 0.05, checked: true },
        { type: 'checkbox', page: 4, xNorm: 0.2, yNorm: 0.15, wNorm: 0.05, hNorm: 0.05, checked: false },
      ],
      certificate: makeCertificate({ sourceSha256 }),
    };

    const res = await parse('pdf_seal', encodePdfSealInput(input));
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal result');

    expect(res.pageCount).toBe(5);
    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));

    // Verify interactive AcroForm and Widget annotations were flattened and stripped cleanly.
    const reloaded = await PDFDocument.load(sealedBytes);
    expect(reloaded.catalog.lookup(PDFName.of('AcroForm'))).toBeUndefined();
    for (const page of reloaded.getPages()) {
      const annots = page.node.Annots();
      expect(annots).toBeUndefined();
    }

    // Read sealed PDF back with unpdf to check embedded image, Vietnamese text, and Audit Certificate.
    const back = await readPdfBack(sealedBytes);
    expect(back.pageCount).toBe(5);
    expect(back.firstPageImageCount).toBeGreaterThanOrEqual(1);

    const p1Text = back.pageTexts[0] ?? '';
    expect(p1Text).toContain('PREFILLED_FORM_VALUE');
    expect(p1Text).toContain('Nguyễn Văn Ánh');
    expect(p1Text).toContain('Công ty TNHH Một Thành Viên Đặng Gia');
    expect(p1Text).toContain('1.234.567 ₫');

    expect(back.pageTexts[1] ?? '').toContain('Ký trang xoay 90');
    expect(back.pageTexts[2] ?? '').toContain('ĐG');

    const certText = back.pageTexts[4] ?? '';
    expect(certText).toContain('CHỨNG NHẬN KÝ KẾT ĐIỆN TỬ');
    expect(certText).toContain('AUDIT CERTIFICATE');
    expect(certText).toContain('LUDY-ESIGN-2026-0001');
    expect(certText).toContain('Hợp đồng dịch vụ kế toán Công ty Đặng Gia');
    expect(certText).toContain(sourceSha256);
    expect(certText).toContain('b'.repeat(64));
    expect(certText).toContain('Nguyễn Văn Ánh');
    expect(certText).toContain('Giám đốc Bên A');
    expect(certText).toContain('n***@danggia.vn');
    expect(certText).toContain('Đã xác thực OTP');
    expect(certText).toContain('15/11/2026 17:30:00 (UTC+7)');
    expect(certText).toContain('deadbeef1234');
    expect(certText).toContain('Trần Thị Quỳnh Như');
    expect(certText).toContain('Không yêu cầu');
  });

  it('aligns stamped text visually inside rotated 90-degree page coordinates', async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([400, 600]);
    p.setRotation(degrees(90));
    const sourceBytes = await doc.save();

    // Target top-left visual quadrant: visual page is 600x400; x in [30..210], y in [40..120].
    const input: PdfSealInput = {
      pdfBase64: Buffer.from(sourceBytes).toString('base64'),
      fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.15, wNorm: 0.3, hNorm: 0.1, text: 'TOP_LEFT_ROT90' }],
      certificate: makeCertificate(),
    };
    const res = await parse('pdf_seal', encodePdfSealInput(input));
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal result');

    const { getDocumentProxy } = await import('unpdf');
    const proxy = await getDocumentProxy(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')), {
      isEvalSupported: false,
    } as Parameters<typeof getDocumentProxy>[1]);
    const page1 = await proxy.getPage(1);
    const viewport = page1.getViewport({ scale: 1 });
    const content = await page1.getTextContent();
    const item = content.items.find((entry) => 'str' in entry && entry.str.includes('TOP_LEFT_ROT90'));
    expect(item).toBeDefined();
    if (!item || !('transform' in item)) throw new Error('missing text item');

    const [vx, vy] = viewport.convertToViewportPoint(item.transform[4] ?? 0, item.transform[5] ?? 0);
    // Visual page is 600 wide x 400 tall; xNorm 0.1 -> ~60 pt, yNorm 0.15..0.25 -> ~60..100 pt.
    expect(vx).toBeGreaterThanOrEqual(55);
    expect(vx).toBeLessThanOrEqual(240);
    expect(vy).toBeGreaterThanOrEqual(55);
    expect(vy).toBeLessThanOrEqual(115);
  });

  it('paginates Audit Certificate cleanly across multiple pages for many signers', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const sourceBytes = await doc.save();

    const signers: PdfSealInput['certificate']['signers'] = Array.from({ length: 16 }, (_, index) => ({
      name: `Người ký thứ ${index + 1} - Trần Văn Đạt`,
      roleLabel: `Bên tham gia ${index + 1}`,
      maskedEmail: `signer${index + 1}@example.vn`,
      deliveryMode: index % 2 === 0 ? 'email' : 'link',
      otpStatus: index % 3 === 0 ? 'verified' : 'not_required',
      signedAtIso: '2026-11-15T10:30:00.000Z',
      ipHashPrefix: 'abcd1234ef',
    }));

    const input: PdfSealInput = {
      pdfBase64: Buffer.from(sourceBytes).toString('base64'),
      fields: [],
      certificate: makeCertificate({ signers }),
    };

    const res = await parse('pdf_seal', encodePdfSealInput(input));
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal result');
    expect(res.pageCount).toBeGreaterThanOrEqual(3);

    const back = await readPdfBack(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')));
    expect(back.pageTexts[1] ?? '').toContain('Người ký thứ 1');
    expect(back.pageTexts.slice(1).join('\n')).toContain('Người ký thứ 16');
    expect(back.pageTexts[1] ?? '').toContain('Trang chứng nhận 1/');
    expect(back.pageTexts[back.pageCount - 1] ?? '').toContain(`Trang chứng nhận ${back.pageCount - 1}/${back.pageCount - 1}`);
  });

  it('rejects SVG/non-PNG signatures, PNG bombs, trailing data after IEND, and out-of-range pages', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const pdfB64 = Buffer.from(await doc.save()).toString('base64');

    const badPayload = (imagePngBase64: string, page = 1): Uint8Array =>
      encodePdfSealInput({
        pdfBase64: pdfB64,
        fields: [{ type: 'signature', page, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.1, imagePngBase64 }],
        certificate: makeCertificate(),
      });

    // Disguised SVG payload
    const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect(await parse('pdf_seal', badPayload(svgB64))).toMatchObject({ ok: false, code: 'invalid' });

    // Oversized PNG > 256 KiB: rejected by encodePdfSealInput and also by decodePdfSealInput/validatePng in the sandbox.
    const validSmallPng = makeTestPng(16, 16, true);
    const oversizedPng = Buffer.concat([
      validSmallPng.subarray(0, validSmallPng.byteLength - 12),
      makePngChunk('tEXt', Buffer.alloc(EXTRACT_LIMITS.maxSignatureImageBytes)),
      validSmallPng.subarray(validSmallPng.byteLength - 12),
    ]);
    const oversizedJsonBytes = new TextEncoder().encode(
      JSON.stringify({
        pdfBase64: pdfB64,
        fields: [{ type: 'signature', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.1, imagePngBase64: oversizedPng.toString('base64') }],
        certificate: makeCertificate(),
      }),
    );
    expect(await parse('pdf_seal', oversizedJsonBytes)).toMatchObject({ ok: false, code: 'invalid' });

    // PNG dimension bomb (IHDR 10000 x 10000)
    const bombBytes = Buffer.from(validSmallPng);
    bombBytes.writeUInt32BE(10_000, 16);
    bombBytes.writeUInt32BE(10_000, 20);
    expect(await parse('pdf_seal', badPayload(bombBytes.toString('base64')))).toMatchObject({ ok: false, code: 'invalid' });

    // Trailing payload after IEND
    const trailingBytes = Buffer.concat([validSmallPng, Buffer.from('TRAILING_DATA')]);
    expect(await parse('pdf_seal', badPayload(trailingBytes.toString('base64')))).toMatchObject({ ok: false, code: 'invalid' });

    // Out-of-bounds page number
    expect(await parse('pdf_seal', badPayload(Buffer.from(validSmallPng).toString('base64'), 2))).toMatchObject({
      ok: false,
      code: 'invalid',
    });

    // Overflowing stamped text inside a small field box must reject instead of spilling off-box.
    const overflowInput = encodePdfSealInput({
      pdfBase64: pdfB64,
      fields: [
        {
          type: 'text',
          page: 1,
          xNorm: 0.1,
          yNorm: 0.9,
          wNorm: 0.25,
          hNorm: 0.02,
          text: Array.from({ length: 12 }, (_, idx) => `Dòng văn bản dài vượt khung số ${idx + 1}`).join('\n'),
        },
      ],
      certificate: makeCertificate(),
    });
    expect(await parse('pdf_seal', overflowInput)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('regenerates NeedAppearances AcroForm values and normalizes NFD Vietnamese text before stamping', async () => {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();
    const field = form.createTextField('party');
    field.setText('OLD PARTY NAME');
    field.addToPage(p1, { x: 40, y: 720, width: 260, height: 24 });
    // Persist the initial OLD PARTY NAME appearance stream, then mutate /V and set NeedAppearances=true.
    const initialBytes = await doc.save();
    const mutated = await PDFDocument.load(initialBytes);
    const mutatedField = mutated.getForm().getTextField('party');
    mutatedField.setText('NEW PARTY NAME');
    const acro = mutated.catalog.lookup(PDFName.of('AcroForm'));
    if (acro instanceof PDFDict) {
      acro.set(PDFName.of('NeedAppearances'), PDFBool.True);
    }
    const mutatedBytes = await mutated.save({ updateFieldAppearances: false });

    const nfdSigner = 'Nguyễn Văn Ánh'.normalize('NFD');
    const nfdText = 'Nguyễn Văn Ánh - Công ty Đặng Gia 1.000.000 ₫'.normalize('NFD');
    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(mutatedBytes).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.08, yNorm: 0.6, wNorm: 0.8, hNorm: 0.08, text: nfdText }],
        certificate: makeCertificate({
          envelopeTitle: 'Hợp đồng Đặng Gia'.normalize('NFD'),
          signers: [
            {
              name: nfdSigner,
              roleLabel: 'Giám đốc'.normalize('NFD'),
              maskedEmail: 'n***@danggia.vn',
              deliveryMode: 'email',
              otpStatus: 'verified',
              signedAtIso: '2026-11-15T10:30:00.000Z',
              ipHashPrefix: 'deadbeef1234',
            },
          ],
        }),
      }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal result');
    const back = await readPdfBack(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')));
    expect(back.pageTexts[0]).toContain('NEW PARTY NAME');
    expect(back.pageTexts[0]).not.toContain('OLD PARTY NAME');
    expect(back.pageTexts[0]).toContain('Nguyễn Văn Ánh');
    expect(back.pageTexts[0]).toContain('Công ty Đặng Gia');
    expect(back.pageTexts[0]).not.toContain('?');
    expect(back.pageTexts[1]).toContain('Nguyễn Văn Ánh');
    expect(back.pageTexts[1]).toContain('Hợp đồng Đặng Gia');
    expect(back.pageTexts[1]).not.toContain('?');
  });

  it('executes pdf_inspect and pdf_seal inside the isolated sandbox child process and via HTTP client', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('Sandbox roundtrip contract', { x: 48, y: 760, size: 12, font });
    const pdfBytes = await doc.save();

    const inspected = await runSandboxed('pdf_inspect', pdfBytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || inspected.kind !== 'pdf_inspect') throw new Error('expected sandboxed pdf_inspect');
    expect(inspected.pageCount).toBe(1);
    expect(inspected.pages[0]?.text).toContain('Sandbox roundtrip contract');

    const sigPngB64 = Buffer.from(makeTestPng(40, 20, true)).toString('base64');
    const url = await startHttpServer();
    const client = createExtractClient({ url, concurrency: 1 });
    const sealed = await client.extract(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfBytes).toString('base64'),
        fields: [
          { type: 'signature', page: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, imagePngBase64: sigPngB64 },
          { type: 'text', page: 1, xNorm: 0.1, yNorm: 0.6, wNorm: 0.6, hNorm: 0.06, text: 'Ký qua HTTP sandbox - Đặng Gia 500.000 ₫' },
        ],
        certificate: makeCertificate(),
      }),
    );
    expect(sealed.ok).toBe(true);
    if (!sealed.ok || sealed.kind !== 'pdf_seal') throw new Error('expected HTTP pdf_seal');
    expect(sealed.pageCount).toBe(2);

    const back = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    expect(back.pageTexts[0]).toContain('Ký qua HTTP sandbox');
    expect(back.pageTexts[0]).toContain('500.000 ₫');
    expect(back.pageTexts[1]).toContain('CHỨNG NHẬN KÝ KẾT ĐIỆN TỬ');
  }, 20_000);

  it('rejects lowercase #xx hex-escaped names, raw trailer /Encrypt, and accepts Node Buffer in inspectPdf', async () => {
    const baseDoc = await PDFDocument.create();
    const font = await baseDoc.embedFont(StandardFonts.Helvetica);
    const p = baseDoc.addPage([595.28, 841.89]);
    p.drawText('Buffer inspect test', { x: 40, y: 760, size: 12, font });
    const cleanBytes = await baseDoc.save({ useObjectStreams: false });

    // Direct Node Buffer passed to inspectPdf must not fail unpdf's Uint8Array check.
    const directRes = await inspectPdf(Buffer.from(cleanBytes));
    expect(directRes.pageCount).toBe(1);
    expect(directRes.pages[0]?.text).toContain('Buffer inspect test');

    const rawBase = Buffer.from(cleanBytes).toString('latin1');
    const catalogMarker = '<<\n/Type /Catalog';
    expect(rawBase).toContain(catalogMarker);

    // Lowercase hex-escaped /#4fpenAction + /#4aavaScript + /#4aS
    const hexOpenActionPdf = Buffer.from(
      rawBase.replace(
        catalogMarker,
        '<<\n/Type /Catalog\n/#4fpenAction << /S /#4aavaScript /#4aS (app.alert(1)) >>',
      ),
      'latin1',
    );
    expect(await parse('pdf_inspect', hexOpenActionPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // Lowercase hex-escaped /E#6ecrypt in trailer dictionary
    const trailerHexEncryptPdf = Buffer.from(
      rawBase.replace('trailer\n<<', 'trailer\n<<\n/E#6ecrypt << /Filter /#53tandard /V 1 /R 2 >>'),
      'latin1',
    );
    expect(await parse('pdf_inspect', trailerHexEncryptPdf)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('handles Vietnamese PDFDropdown, orphan widgets, unsigned signature widgets, and \\u2028 separators when sealing', async () => {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();
    const dropdown = form.createDropdown('province');
    dropdown.addOptions(['Thanh pho Ho Chi Minh', 'Ha Noi']);
    dropdown.select('Ha Noi');
    dropdown.addToPage(p1, { x: 40, y: 720, width: 220, height: 24 });

    const orphan = form.createTextField('orphan_field');
    orphan.setText('Orphan value');

    // Unsigned PDFSignature widget without /AP must be stripped without crashing flatten().
    const sigFieldDict = doc.context.obj({
      FT: PDFName.of('Sig'),
      T: 'unsigned_sig',
      F: 4,
      Rect: [40, 620, 200, 660],
      P: p1.ref,
      Subtype: PDFName.of('Widget'),
      Type: PDFName.of('Annot'),
    });
    const sigFieldRef = doc.context.register(sigFieldDict);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acro instanceof PDFDict) {
      const fieldsArr = acro.lookup(PDFName.of('Fields'));
      if (fieldsArr instanceof PDFArray) {
        fieldsArr.push(sigFieldRef);
      }
      acro.set(PDFName.of('NeedAppearances'), PDFBool.True);
    }
    p1.node.addAnnot(sigFieldRef);

    // Update dropdown /V to full Vietnamese after initial save so WinAnsi Helvetica fails during flatten.
    const saved = await doc.save({ updateFieldAppearances: false });
    const loaded = await PDFDocument.load(saved);
    const loadedAcro = loaded.catalog.lookup(PDFName.of('AcroForm'));
    if (loadedAcro instanceof PDFDict) {
      loadedAcro.set(PDFName.of('NeedAppearances'), PDFBool.True);
    }
    const loadedForm = loaded.getForm();
    const loadedDropdown = loadedForm.getDropdown('province');
    const vnOption = 'Thành phố Hồ Chí Minh';
    loadedDropdown.setOptions([vnOption]);
    loadedDropdown.select(vnOption);
    const inputBytes = await loaded.save({ updateFieldAppearances: false });

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(inputBytes).toString('base64'),
        fields: [
          {
            type: 'text',
            page: 1,
            xNorm: 0.1,
            yNorm: 0.4,
            wNorm: 0.7,
            hNorm: 0.12,
            text: 'Dòng 1\u2028Dòng 2\u2029Dòng 3',
          },
        ],
        certificate: makeCertificate(),
      }),
    );

    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result, got: ${JSON.stringify(sealed)}`);
    }
    expect(sealed.ok).toBe(true);
    const back = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    expect(back.pageTexts[0]).toContain('Thành phố Hồ Chí Minh');
    expect(back.pageTexts[0]).toContain('Dòng 1');
    expect(back.pageTexts[0]).toContain('Dòng 2');
    expect(back.pageTexts[0]).toContain('Dòng 3');
  });

  it('paginates 50 max-length signers cleanly within 25 certificate pages without orphaning headings', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBytes = await doc.save();

    const longName = 'Nguyễn Thị Quỳnh Phương Anh Công Ty Cổ Phần Thương Mại Dịch Vụ Đặng Gia Việt Nam'.padEnd(115, ' A');
    const longTitle = 'Hợp đồng khung dịch vụ tư vấn triển khai chuyển đổi số doanh nghiệp vừa và nhỏ'.padEnd(230, ' B');
    const signers: PdfSealInput['certificate']['signers'] = Array.from(
      { length: EXTRACT_LIMITS.maxPdfSealSigners },
      (_, idx) => ({
        name: `${idx + 1} ${longName}`.slice(0, 120),
        roleLabel: `Bên ký kết số ${idx + 1} - Đại diện pháp luật`.slice(0, 60),
        maskedEmail: `signer${idx + 1}@enterprise-example.vn`,
        deliveryMode: 'email' as const,
        otpStatus: 'verified' as const,
        signatureKind: 'draw' as const,
        signedAtIso: '2026-11-15T10:30:00.000Z',
        ipHashPrefix: 'deadbeef1234cafe',
      }),
    );

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({
          envelopeTitle: longTitle.slice(0, 240),
          signers,
        }),
      }),
    );

    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result, got: ${JSON.stringify(sealed)}`);
    }
    expect(sealed.ok).toBe(true);
    const certPageCount = sealed.pageCount - 1;
    expect(certPageCount).toBeGreaterThan(1);
    expect(certPageCount).toBeLessThanOrEqual(EXTRACT_LIMITS.maxPdfAuditCertPages);

    const back = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    const firstCertText = back.pageTexts[1] ?? '';
    if (firstCertText.includes('DANH SÁCH NGƯỜI KÝ')) {
      expect(firstCertText).toContain('1. 1 Nguyễn Thị Quỳnh');
    } else {
      expect(back.pageTexts[2] ?? '').toContain('DANH SÁCH NGƯỜI KÝ');
      expect(back.pageTexts[2] ?? '').toContain('1. 1 Nguyễn Thị Quỳnh');
    }
    expect(back.pageTexts[back.pageTexts.length - 1]).toContain('50. 50 Nguyễn Thị Quỳnh');
  }, 20_000);

  it('skips Hidden/NoView widgets, normalizes /Fie#6cds keys, scales BBox to Rect, and rejects horizontal text overflow', async () => {
    // 1. Hidden (/F 2) widget must never be flattened onto sealed PDF pages.
    const hiddenDoc = await PDFDocument.create();
    const hp = hiddenDoc.addPage([595.28, 841.89]);
    const hForm = hiddenDoc.getForm();
    const hField = hForm.createTextField('secret_hidden');
    hField.setText('HIDDEN CONTRACT CLAUSE');
    hField.addToPage(hp, { x: 30, y: 700, width: 250, height: 30 });
    const hBytes0 = await hiddenDoc.save();
    const hiddenLoaded = await PDFDocument.load(hBytes0);
    const hiddenWidget = hiddenLoaded.getForm().getTextField('secret_hidden').acroField.getWidgets()[0];
    if (!hiddenWidget) throw new Error('missing hidden widget');
    hiddenWidget.setFlags(2);
    const hiddenBytes = await hiddenLoaded.save();

    const sealedHidden = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(hiddenBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedHidden.ok || sealedHidden.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result for hidden test, got: ${JSON.stringify(sealedHidden)}`);
    }
    const hiddenBack = await readPdfBack(new Uint8Array(Buffer.from(sealedHidden.sealedPdfBase64, 'base64')));
    expect(hiddenBack.pageTexts[0]).not.toContain('HIDDEN CONTRACT CLAUSE');

    // 2. Lowercase hex-escaped /Fie#6cds inside AcroForm must still preserve field text.
    const escapedDoc = await PDFDocument.create();
    const ep = escapedDoc.addPage([595.28, 841.89]);
    const eForm = escapedDoc.getForm();
    const eField = eForm.createTextField('visible_party');
    eField.setText('IMPORTANT CONTRACT VALUE');
    eField.addToPage(ep, { x: 30, y: 700, width: 250, height: 30 });
    const eRaw = Buffer.from(await escapedDoc.save({ useObjectStreams: false })).toString('latin1');
    expect(eRaw).toContain('/Fields');
    const escapedBytes = rebuildAsciiXref(eRaw.replace('/Fields', '/Fie#6cds'));

    const sealedEscaped = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(escapedBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedEscaped.ok || sealedEscaped.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result for escaped Fields test, got: ${JSON.stringify(sealedEscaped)}`);
    }
    const escapedBack = await readPdfBack(new Uint8Array(Buffer.from(sealedEscaped.sealedPdfBase64, 'base64')));
    expect(escapedBack.pageTexts[0]).toContain('IMPORTANT CONTRACT VALUE');

    // 3. Appearance XObject whose /BBox differs from Widget /Rect must scale to Rect cleanly.
    const bboxDoc = await PDFDocument.create();
    const bp = bboxDoc.addPage([595.28, 841.89]);
    const bForm = bboxDoc.getForm();
    const bField = bForm.createTextField('scaled_box');
    bField.setText('Scaled text');
    bField.addToPage(bp, { x: 40, y: 700, width: 100, height: 20, borderWidth: 0 });
    const bSaved = await bboxDoc.save();
    const bLoaded = await PDFDocument.load(bSaved);
    const bWidget = bLoaded.getForm().getTextField('scaled_box').acroField.getWidgets()[0];
    if (!bWidget) throw new Error('missing bbox widget');
    bWidget.setRectangle({ x: 40, y: 700, width: 200, height: 40 });
    const bScaledBytes = await bLoaded.save({ updateFieldAppearances: false });

    const sealedBbox = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bScaledBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedBbox.ok || sealedBbox.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result for BBox test, got: ${JSON.stringify(sealedBbox)}`);
    }
    const checkDoc = await PDFDocument.load(Buffer.from(sealedBbox.sealedPdfBase64, 'base64'));
    const contentsRef = checkDoc.getPage(0).node.get(PDFName.of('Contents'));
    const streamTexts: string[] = [];
    const pushContentStream = (refOrStream: unknown): void => {
      const resolved = refOrStream instanceof PDFRef ? checkDoc.context.lookup(refOrStream) : refOrStream;
      if (resolved instanceof PDFStream) {
        const decodedBytes = decodePDFRawStream(resolved as never).decode();
        streamTexts.push(Buffer.from(decodedBytes).toString('latin1'));
      }
    };
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) pushContentStream(contentsRef.get(i));
    } else {
      pushContentStream(contentsRef);
    }
    expect(streamTexts.join('\n')).toContain('2 0 0 2 40 700 cm');

    // 4. Narrow box width must shrink or reject overflowing glyph width instead of spilling horizontally.
    const narrowDoc = await PDFDocument.create();
    narrowDoc.addPage([595.28, 841.89]);
    const narrowB64 = Buffer.from(await narrowDoc.save()).toString('base64');

    const shrunkFit = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: narrowB64,
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.01, hNorm: 0.1, text: 'W', fontSizePt: 36 }],
        certificate: makeCertificate(),
      }),
    );
    expect(shrunkFit.ok).toBe(true);

    const impossibleWidth = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: narrowB64,
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.004, hNorm: 0.1, text: 'W', fontSizePt: 36 }],
        certificate: makeCertificate(),
      }),
    );
    expect(impossibleWidth).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects >131 KiB padded trailer /Encrypt and comment/NUL/zero-space /XRef headers', async () => {
    const baseObjects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ];

    const paddedTrailerPdf = makeRawPdf(baseObjects, `%${'x'.repeat(150_000)}\n/Encrypt 99 0 R `);
    const paddedRes = await parse('pdf_inspect', paddedTrailerPdf);
    expect(paddedRes).toMatchObject({ ok: false, code: 'invalid' });

    const headerVariants = [
      '9 0%c\nobj\n<< /Type /XRef /E#6ecrypt 99 0 R /Length 0 >>\nstream\nendstream\nendobj\n',
      '9\x000\x00obj\n<< /Type /#58Ref /Encrypt 99 0 R /Length 0 >>\nstream\nendstream\nendobj\n',
      '9 0obj<< /Type /XRef /E#6ecrypt 99 0 R /Length 0 >>\nstream\nendstream\nendobj\n',
    ];
    const cleanRaw = Buffer.from(makeRawPdf(baseObjects)).toString('latin1');
    const xrefIdx = cleanRaw.indexOf('xref\n');
    for (const variant of headerVariants) {
      const injected = Buffer.from(`${cleanRaw.slice(0, xrefIdx)}${variant}${cleanRaw.slice(xrefIdx)}`, 'latin1');
      const res = await parse('pdf_inspect', new Uint8Array(injected));
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('preserves full AcroForm fallback text by shrinking font size and rejects un-fittable AcroForm overflow', async () => {
    const acroDoc = await PDFDocument.create();
    const page = acroDoc.addPage([595.28, 841.89]);
    const form = acroDoc.getForm();
    const field = form.createTextField('long_clause');
    field.addToPage(page, { x: 40, y: 700, width: 200, height: 20 });
    field.setText('COMPANY NAME WITH IMPORTANT FINAL WORDS');
    const widget = field.acroField.getWidgets()[0];
    if (!widget) throw new Error('missing long_clause widget');
    widget.dict.delete(PDFName.of('AP'));
    // Also exercise reversed [x2, y2, x1, y1] Rect normalization.
    widget.dict.set(PDFName.of('Rect'), acroDoc.context.obj([240, 720, 40, 700]));
    const acroBytes = await acroDoc.save({ updateFieldAppearances: false });

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(acroBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected AcroForm shrink fit to succeed, got: ${JSON.stringify(sealed)}`);
    }
    const readBack = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    const flatText = (readBack.pageTexts[0] ?? '').replace(/\s+/g, ' ');
    expect(flatText).toContain('COMPANY NAME WITH IMPORTANT FINAL WORDS');

    const tinyDoc = await PDFDocument.create();
    const tinyPage = tinyDoc.addPage([595.28, 841.89]);
    const tinyForm = tinyDoc.getForm();
    const tinyField = tinyForm.createTextField('overflow_clause');
    tinyField.addToPage(tinyPage, { x: 40, y: 700, width: 30, height: 10 });
    tinyField.setText('WORD '.repeat(35));
    const tinyWidget = tinyField.acroField.getWidgets()[0];
    if (!tinyWidget) throw new Error('missing overflow_clause widget');
    tinyWidget.dict.delete(PDFName.of('AP'));
    const tinyBytes = await tinyDoc.save({ updateFieldAppearances: false });

    const overflowRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(tinyBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(overflowRes).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('scales page UserUnit in pdf_inspect and pdf_seal and rejects invalid UserUnit', async () => {
    const unitDoc = await PDFDocument.create();
    const page = unitDoc.addPage([300, 400]);
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const unitBytes = await unitDoc.save();

    const inspected = await parse('pdf_inspect', unitBytes);
    expect(inspected).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
      pages: [{ page: 1, widthPt: 600, heightPt: 800, rotation: 0 }],
    });

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(unitBytes).toString('base64'),
        fields: [
          {
            type: 'text',
            page: 1,
            xNorm: 0.1,
            yNorm: 0.1,
            wNorm: 0.4,
            hNorm: 0.08,
            text: 'UserUnit 2x',
            fontSizePt: 12,
          },
          { type: 'checkbox', page: 1, xNorm: 0.1, yNorm: 0.25, wNorm: 0.04, hNorm: 0.04, checked: true },
        ],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected UserUnit pdf_seal to succeed, got: ${JSON.stringify(sealed)}`);
    }
    const sealedBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).toContain('UserUnit 2x');

    const checkDoc = await PDFDocument.load(sealedBytes);
    const contentsRef = checkDoc.getPage(0).node.get(PDFName.of('Contents'));
    const streamTexts: string[] = [];
    const pushContentStream = (refOrStream: unknown): void => {
      const resolved = refOrStream instanceof PDFRef ? checkDoc.context.lookup(refOrStream) : refOrStream;
      if (resolved instanceof PDFStream) {
        const decodedBytes = decodePDFRawStream(resolved as never).decode();
        streamTexts.push(Buffer.from(decodedBytes).toString('latin1'));
      }
    };
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) pushContentStream(contentsRef.get(i));
    } else {
      pushContentStream(contentsRef);
    }
    expect(streamTexts.join('\n')).toMatch(/\b6 Tf\b/);

    for (const invalidUnit of [0, -1, 1000]) {
      const badDoc = await PDFDocument.create();
      const badPage = badDoc.addPage([300, 400]);
      badPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(invalidUnit));
      const badRes = await parse('pdf_inspect', await badDoc.save());
      expect(badRes).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('collapses newlines in single-line audit certificate fields so cards stay inside A4 page bounds', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const baseB64 = Buffer.from(await doc.save()).toString('base64');

    const baseCert = makeCertificate();
    const firstSigner = baseCert.signers[0];
    if (!firstSigner) throw new Error('missing first signer');
    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: baseB64,
        fields: [],
        certificate: {
          ...baseCert,
          certificateCode: 'LUDY\nESIGN\r\n001',
          envelopeTitle: 'A\n'.repeat(100),
          signers: [
            {
              ...firstSigner,
              name: 'Nguyễn\nVăn\u2028Ánh',
              roleLabel: 'Giám\r\nđốc',
            },
          ],
        },
      }),
    );
    if (!res.ok || res.kind !== 'pdf_seal') {
      throw new Error(`expected collapsed audit cert to succeed, got: ${JSON.stringify(res)}`);
    }
    expect(res.pageCount).toBe(2);
    const readBack = await readPdfBack(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')));
    expect(readBack.pageTexts[1]).toContain('LUDY ESIGN 001');
    expect(readBack.pageTexts[1]).toContain('Nguyễn Văn Ánh');
    expect(readBack.pageTexts[1]).toContain('DANH SÁCH NGƯỜI KÝ / SIGNERS (1)');
  });

  it('rejects glued endobjtrailer /Encrypt while allowing trailer-like text inside strings and streams', async () => {
    const baseObjects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ];
    const cleanRaw = Buffer.from(makeRawPdf(baseObjects)).toString('latin1');
    const glued = cleanRaw.replace(
      'trailer\n',
      'endobjtrailer<<\n/Size 4 /Root 1 0 R /E#6ecrypt << /Filter /Standard /V 1 /R 2 >> >>\n% ',
    );
    const gluedInspect = await parse('pdf_inspect', new Uint8Array(Buffer.from(glued, 'latin1')));
    expect(gluedInspect).toMatchObject({ ok: false, code: 'invalid' });

    const gluedSeal = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(glued, 'latin1').toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(gluedSeal).toMatchObject({ ok: false, code: 'invalid' });

    const slashGlued = cleanRaw.replace(
      'trailer\n',
      'endobj/trailer<<\n/Size 4 /Root 1 0 R /E#6ecrypt << /Filter /Standard /V 1 /R 2 >> >>\n% ',
    );
    expect(await parse('pdf_inspect', new Uint8Array(Buffer.from(slashGlued, 'latin1')))).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(slashGlued, 'latin1').toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    const streamBody = 'BT\n(trailer << /Encrypt 5 0 R >>) Tj\nET\n';
    const rawBenign = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
      `<< /Length ${streamBody.length} >>\nstream\n${streamBody}endstream`,
      '<< /Subject (The trailer << /Encrypt 5 0 R >> syntax) >>',
    ]);
    const docWithSubject = await PDFDocument.load(rawBenign);
    docWithSubject.setSubject('The trailer << /Encrypt 5 0 R >> syntax');
    const benignBytes = await docWithSubject.save({ useObjectStreams: false });

    const inspectBenign = await parse('pdf_inspect', benignBytes);
    expect(inspectBenign).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });

    const sealBenign = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(benignBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(sealBenign).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });
  });

  it('overrides inherited /CropBox and /Rotate on cert pages and fits 64-char certificateCode in continuation headers/footers', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const pagesRef = doc.catalog.get(PDFName.of('Pages'));
    const pagesDict = doc.context.lookup(pagesRef);
    if (!(pagesDict instanceof PDFDict)) throw new Error('missing root Pages dict');
    pagesDict.set(PDFName.of('CropBox'), doc.context.obj([0, 400, 600, 800]));
    pagesDict.set(PDFName.of('Rotate'), PDFNumber.of(90));
    const srcBytes = await doc.save();

    const longCode = 'W'.repeat(64);
    const baseCert = makeCertificate();
    const firstSigner = baseCert.signers[0];
    if (!firstSigner) throw new Error('missing first signer');
    const manySigners = Array.from({ length: 12 }, (_, idx) => ({
      ...firstSigner,
      name: `Người ký số ${idx + 1}`,
    }));

    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(srcBytes).toString('base64'),
        fields: [],
        certificate: {
          ...baseCert,
          certificateCode: longCode,
          signers: manySigners,
        },
      }),
    );
    if (!res.ok || res.kind !== 'pdf_seal') {
      throw new Error(`expected inherited-Pages seal with 64-char code to succeed, got: ${JSON.stringify(res)}`);
    }
    expect(res.pageCount).toBeGreaterThanOrEqual(3);

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const checkDoc = await PDFDocument.load(sealedBytes);
    for (let i = 1; i < checkDoc.getPageCount(); i++) {
      const certPage = checkDoc.getPage(i);
      const crop = certPage.getCropBox();
      // Source page has CropBox [0, 400, 600, 800] (600x400) rotated 90 degrees -> effective visual size 400x600.
      expect(crop.x).toBeCloseTo(0, 1);
      expect(crop.y).toBeCloseTo(0, 1);
      expect(crop.width).toBeCloseTo(400, 1);
      expect(crop.height).toBeCloseTo(600, 1);
      expect(certPage.getRotation().angle).toBe(0);
    }

    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[2]?.replace(/\s+/g, '')).toContain(longCode);
  });

  it('normalizes lowercase #xx keys on /Pages ancestors, preserves paired /Opt dropdown labels, and preserves custom /V /Approved checkbox state', async () => {
    // 1. /R#6ftate 90 on ancestor /Pages node must match PDF.js rotation & dimensions and survive sealing.
    const rotDoc = await PDFDocument.create();
    rotDoc.addPage([600, 800]);
    const pagesRef = rotDoc.catalog.get(PDFName.of('Pages'));
    const pagesDict = rotDoc.context.lookup(pagesRef);
    if (!(pagesDict instanceof PDFDict)) throw new Error('missing root Pages dict');
    pagesDict.set(PDFName.of('Rotate'), PDFNumber.of(90));
    const rotRaw = Buffer.from(await rotDoc.save({ useObjectStreams: false })).toString('latin1');
    const rotBytes = rebuildAsciiXref(rotRaw.replace('/Rotate', '/R#6ftate'));
    expect(Buffer.from(rotBytes).toString('latin1')).toContain('/R#6ftate');

    const inspectedRot = await parse('pdf_inspect', rotBytes);
    expect(inspectedRot).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pages: [{ page: 1, widthPt: 800, heightPt: 600, rotation: 90 }],
    });

    const sealedRot = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(rotBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedRot.ok || sealedRot.kind !== 'pdf_seal') {
      throw new Error(`expected inherited #xx /Pages seal to succeed, got: ${JSON.stringify(sealedRot)}`);
    }
    const sealedRotDoc = await PDFDocument.load(Buffer.from(sealedRot.sealedPdfBase64, 'base64'));
    expect(sealedRotDoc.getPage(0).getRotation().angle).toBe(90);
    expect(sealedRotDoc.getPage(1).getRotation().angle).toBe(0);

    // 2. Paired /Opt [[export, display]] dropdown + custom /V /Approved checkbox without /AP.
    const formDoc = await PDFDocument.create();
    const formPage = formDoc.addPage([595.28, 841.89]);
    const form = formDoc.getForm();

    const dd = form.createDropdown('payment_method');
    dd.addOptions(['CASH', 'BANK']);
    dd.select('CASH');
    dd.addToPage(formPage, { x: 40, y: 700, width: 220, height: 24 });
    dd.acroField.dict.set(
      PDFName.of('Opt'),
      formDoc.context.obj([
        [PDFString.of('CASH'), PDFHexString.fromText('Thanh toán tiền mặt')],
        [PDFString.of('BANK'), PDFHexString.fromText('Chuyển khoản ngân hàng')],
      ]),
    );
    const ddWidget = dd.acroField.getWidgets()[0];
    if (!ddWidget) throw new Error('missing dropdown widget');
    ddWidget.dict.delete(PDFName.of('AP'));

    const cbChecked = form.createCheckBox('agree_custom');
    cbChecked.addToPage(formPage, { x: 40, y: 650, width: 18, height: 18 });
    const cbCheckedWidget = cbChecked.acroField.getWidgets()[0];
    if (!cbCheckedWidget) throw new Error('missing agree_custom widget');
    cbCheckedWidget.dict.delete(PDFName.of('AP'));
    cbChecked.acroField.dict.set(PDFName.of('V'), PDFName.of('Approved'));
    cbCheckedWidget.dict.set(PDFName.of('AS'), PDFName.of('Approved'));

    const cbUnchecked = form.createCheckBox('disagree_custom');
    cbUnchecked.addToPage(formPage, { x: 40, y: 610, width: 18, height: 18 });
    const cbUncheckedWidget = cbUnchecked.acroField.getWidgets()[0];
    if (!cbUncheckedWidget) throw new Error('missing disagree_custom widget');
    cbUncheckedWidget.dict.delete(PDFName.of('AP'));
    cbUnchecked.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
    cbUncheckedWidget.dict.set(PDFName.of('AS'), PDFName.of('Off'));

    const formBytes = await formDoc.save({ updateFieldAppearances: false });
    const sealedForm = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(formBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedForm.ok || sealedForm.kind !== 'pdf_seal') {
      throw new Error(`expected paired /Opt + custom checkbox seal to succeed, got: ${JSON.stringify(sealedForm)}`);
    }
    const sealedFormBytes = new Uint8Array(Buffer.from(sealedForm.sealedPdfBase64, 'base64'));
    const readBackForm = await readPdfBack(sealedFormBytes);
    expect(readBackForm.pageTexts[0]).toContain('Thanh toán tiền mặt');
    expect(readBackForm.pageTexts[0]).not.toContain('CASH');

    const checkFormDoc = await PDFDocument.load(sealedFormBytes);
    const xObjectDict = checkFormDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(xObjectDict instanceof PDFDict)) throw new Error('missing flattened checkbox XObjects');
    const xObjTexts: string[] = [];
    for (const [, val] of xObjectDict.entries()) {
      const resolved = checkFormDoc.context.lookup(val);
      if (resolved instanceof PDFStream) {
        xObjTexts.push(Buffer.from(decodePDFRawStream(resolved as never).decode()).toString('latin1'));
      }
    }
    expect(xObjTexts.length).toBe(2);
    // Checked /Yes appearance contains checkmark line/fill operators beyond the plain unchecked box border.
    expect(xObjTexts[0]).not.toBe(xObjTexts[1]);
  });

  it('masks password text fields instead of exposing plaintext across missing and prebuilt appearances', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();

    const pwNoAp = form.createTextField('pw_missing_ap');
    pwNoAp.enablePassword();
    pwNoAp.setText('PRIVATE-PASSWORD-123');
    pwNoAp.addToPage(page, { x: 40, y: 720, width: 220, height: 24 });
    const pwNoApWidget = pwNoAp.acroField.getWidgets()[0];
    if (!pwNoApWidget) throw new Error('missing pwNoAp widget');
    pwNoApWidget.dict.delete(PDFName.of('AP'));

    const pwWithAp = form.createTextField('pw_with_ap');
    pwWithAp.enablePassword();
    pwWithAp.setText('SECRET-SECOND-456');
    pwWithAp.addToPage(page, { x: 40, y: 670, width: 220, height: 24 });

    doc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    const bytes = await doc.save({ updateFieldAppearances: false });

    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!res.ok || res.kind !== 'pdf_seal') {
      throw new Error(`expected password form seal to succeed, got: ${JSON.stringify(res)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).not.toContain('PRIVATE-PASSWORD-123');
    expect(readBack.pageTexts[0]).not.toContain('SECRET-SECOND-456');
    expect(readBack.pageTexts[0]).toContain('*'.repeat(20));
    expect(readBack.pageTexts[0]).toContain('*'.repeat(17));

    const sealedDoc = await PDFDocument.load(sealedBytes);
    expect(sealedDoc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(sealedDoc.getForm().getFields()).toHaveLength(0);
    await assertNoSecretInSealedPdf(sealedBytes, ['PRIVATE-PASSWORD-123', 'SECRET-SECOND-456']);
  });

  it('flattens /AP annotations before stampFields, strips links/hidden annots, and rejects unflattened visible annotations', async () => {
    // 1. White /Square with /AP /N + normal /Link + hidden /Square over signature area: stamped text stays on top.
    const docWithAp = await PDFDocument.create();
    const page = docWithAp.addPage([595.28, 841.89]);
    const apStream = docWithAp.context.stream('q 1 1 1 rg 0 0 280 140 re f Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 280, 140],
    });
    const apRef = docWithAp.context.register(apStream);
    const squareAnnotRef = docWithAp.context.register(
      docWithAp.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 620, 320, 760],
        AP: { N: apRef },
      }),
    );
    const linkAnnotRef = docWithAp.context.register(
      docWithAp.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 500, 180, 520],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://ludy.example') },
      }),
    );
    const hiddenSquareRef = docWithAp.context.register(
      docWithAp.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 620, 320, 760],
        F: 2,
      }),
    );
    page.node.set(PDFName.of('Annots'), docWithAp.context.obj([squareAnnotRef, linkAnnotRef, hiddenSquareRef]));

    const bytesWithAp = await docWithAp.save();
    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytesWithAp).toString('base64'),
        fields: [
          {
            type: 'text',
            page: 1,
            xNorm: 0.1,
            yNorm: 0.12,
            wNorm: 0.4,
            hNorm: 0.08,
            text: 'Người ký: Nguyễn Văn Bình',
          },
        ],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected /AP annotation flatten seal to succeed, got: ${JSON.stringify(sealed)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    const sealedDoc = await PDFDocument.load(sealedBytes);
    const sealedPage = sealedDoc.getPage(0);
    expect(sealedPage.node.get(PDFName.of('Annots'))).toBeUndefined();

    // Verify flattened annotation XObject is painted BEFORE the stamped text stream operators.
    const contents = sealedPage.node.Contents();
    if (!(contents instanceof PDFArray)) {
      throw new Error('expected page contents array');
    }
    const decodedStreams: string[] = [];
    for (let i = 0; i < contents.size(); i++) {
      const streamObj = sealedDoc.context.lookup(contents.get(i));
      if (streamObj instanceof PDFStream) {
        decodedStreams.push(Buffer.from(decodePDFRawStream(streamObj as never).decode()).toString('latin1'));
      }
    }
    const combinedContent = decodedStreams.join('\n');
    const flatIdx = combinedContent.indexOf('/FlatAnnot');
    const textIdx = combinedContent.indexOf('BT');
    expect(flatIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(flatIdx);

    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).toContain('Người ký: Nguyễn Văn Bình');

    // 2. Visible /Square annotation lacking /AP stream must be rejected rather than left on top of stamped fields.
    const docWithoutAp = await PDFDocument.create();
    const page2 = docWithoutAp.addPage([595.28, 841.89]);
    const bareSquareRef = docWithoutAp.context.register(
      docWithoutAp.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 620, 320, 760],
        IC: [1, 1, 1],
        C: [0, 0, 0],
      }),
    );
    page2.node.set(PDFName.of('Annots'), docWithoutAp.context.obj([bareSquareRef]));
    const bytesWithoutAp = await docWithoutAp.save();

    const rejected = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytesWithoutAp).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(rejected).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('respects /OC optional content layer OFF state, scrubs inherited parent password /V, and renders radio fallback without /AP', async () => {
    // 1. Turned-off OCG layers (/OCProperties /D /OFF) must stay hidden on annotations and form widgets.
    const ocDoc = await PDFDocument.create();
    const ocPage = ocDoc.addPage([595.28, 841.89]);
    const layerOnRef = ocDoc.context.register(
      ocDoc.context.obj({ Type: 'OCG', Name: PDFString.of('VisibleLayer') }),
    );
    const layerOffRef = ocDoc.context.register(
      ocDoc.context.obj({ Type: 'OCG', Name: PDFString.of('HiddenLayer') }),
    );
    ocDoc.catalog.set(
      PDFName.of('OCProperties'),
      ocDoc.context.obj({
        OCGs: [layerOnRef, layerOffRef],
        D: { BaseState: 'ON', ON: [layerOnRef], OFF: [layerOffRef] },
      }),
    );

    const onApRef = ocDoc.context.register(
      ocDoc.context.stream('q 0 0.6 0 rg 0 0 120 40 re f Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 120, 40],
      }),
    );
    const offApRef = ocDoc.context.register(
      ocDoc.context.stream('q 0.9 0 0 rg 0 0 120 40 re f Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 120, 40],
      }),
    );
    const onAnnotRef = ocDoc.context.register(
      ocDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 700, 160, 740],
        AP: { N: onApRef },
        OC: layerOnRef,
      }),
    );
    const offAnnotRef = ocDoc.context.register(
      ocDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [200, 700, 320, 740],
        AP: { N: offApRef },
        OC: layerOffRef,
      }),
    );
    ocPage.node.set(PDFName.of('Annots'), ocDoc.context.obj([onAnnotRef, offAnnotRef]));

    const ocForm = ocDoc.getForm();
    const hiddenLayerField = ocForm.createTextField('oc_hidden_text');
    hiddenLayerField.setText('HIDDEN LAYER CLAUSE');
    hiddenLayerField.addToPage(ocPage, { x: 40, y: 620, width: 220, height: 24 });
    const hiddenLayerWidget = hiddenLayerField.acroField.getWidgets()[0];
    if (!hiddenLayerWidget) throw new Error('missing oc widget');
    hiddenLayerWidget.dict.set(PDFName.of('OC'), layerOffRef);

    const ocBytes = await ocDoc.save();
    const ocSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(ocBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!ocSealed.ok || ocSealed.kind !== 'pdf_seal') {
      throw new Error(`expected OCG seal to succeed, got: ${JSON.stringify(ocSealed)}`);
    }
    const ocSealedBytes = new Uint8Array(Buffer.from(ocSealed.sealedPdfBase64, 'base64'));
    const ocBack = await readPdfBack(ocSealedBytes);
    expect(ocBack.pageTexts[0]).not.toContain('HIDDEN LAYER CLAUSE');

    const ocVerifyDoc = await PDFDocument.load(ocSealedBytes);
    const ocXObjs = ocVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(ocXObjs instanceof PDFDict)) throw new Error('expected FlatAnnot XObject on OCG page');
    const xObjContents: string[] = [];
    for (const [, val] of ocXObjs.entries()) {
      const resolved = ocVerifyDoc.context.lookup(val);
      if (resolved instanceof PDFStream) {
        xObjContents.push(Buffer.from(decodePDFRawStream(resolved as never).decode()).toString('latin1'));
      }
    }
    expect(xObjContents.some((s) => s.includes('0 0.6 0 rg'))).toBe(true);
    expect(xObjContents.some((s) => s.includes('0.9 0 0 rg'))).toBe(false);

    // Ambiguous OCMD /VE expression must fail closed.
    const veDoc = await PDFDocument.create();
    const vePage = veDoc.addPage([595.28, 841.89]);
    const veOcgRef = veDoc.context.register(veDoc.context.obj({ Type: 'OCG', Name: PDFString.of('L1') }));
    const veOcmdRef = veDoc.context.register(
      veDoc.context.obj({ Type: 'OCMD', VE: ['And', veOcgRef] }),
    );
    const veApRef = veDoc.context.register(
      veDoc.context.stream('q 0 0 0 rg 0 0 100 30 re f Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 30],
      }),
    );
    const veAnnotRef = veDoc.context.register(
      veDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 700, 140, 730],
        AP: { N: veApRef },
        OC: veOcmdRef,
      }),
    );
    vePage.node.set(PDFName.of('Annots'), veDoc.context.obj([veAnnotRef]));
    const veRejected = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await veDoc.save()).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(veRejected).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Inherited /V and /Ff password flag on non-terminal Parent field must be masked and scrubbed from parent object.
    const parentPwDoc = await PDFDocument.create();
    const pwPage = parentPwDoc.addPage([595.28, 841.89]);
    const parentFieldDict = parentPwDoc.context.obj({
      FT: PDFName.of('Tx'),
      Ff: 1 << 13,
      T: PDFString.of('auth_parent'),
      V: PDFString.of('INHERITED-SECRET-789'),
      Kids: [],
    });
    const parentFieldRef = parentPwDoc.context.register(parentFieldDict);
    const childWidgetRef = parentPwDoc.context.register(
      parentPwDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: parentFieldRef,
        T: PDFString.of('pin_child'),
        Rect: [40, 700, 240, 726],
        P: pwPage.ref,
      }),
    );
    parentFieldDict.set(PDFName.of('Kids'), parentPwDoc.context.obj([childWidgetRef]));
    pwPage.node.set(PDFName.of('Annots'), parentPwDoc.context.obj([childWidgetRef]));
    parentPwDoc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('Fields'), parentPwDoc.context.obj([parentFieldRef]));

    const sealedParentPw = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await parentPwDoc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedParentPw.ok || sealedParentPw.kind !== 'pdf_seal') {
      throw new Error(`expected inherited parent password seal to succeed, got: ${JSON.stringify(sealedParentPw)}`);
    }
    const sealedParentPwBytes = new Uint8Array(Buffer.from(sealedParentPw.sealedPdfBase64, 'base64'));
    const parentPwBack = await readPdfBack(sealedParentPwBytes);
    expect(parentPwBack.pageTexts[0]).toContain('*'.repeat(20));
    expect(parentPwBack.pageTexts[0]).not.toContain('INHERITED-SECRET-789');
    await assertNoSecretInSealedPdf(sealedParentPwBytes, ['INHERITED-SECRET-789']);

    // 3. PDFRadioGroup with NeedAppearances=true and missing /AP draws vector circles instead of silently dropping group.
    const radioDoc = await PDFDocument.create();
    const radioPage = radioDoc.addPage([595.28, 841.89]);
    const radioForm = radioDoc.getForm();
    const rg = radioForm.createRadioGroup('plan_choice');
    rg.addOptionToPage('OPT_A', radioPage, { x: 40, y: 700, width: 18, height: 18 });
    rg.addOptionToPage('OPT_B', radioPage, { x: 40, y: 660, width: 18, height: 18 });
    rg.select('OPT_B');
    const rgWidgets = rg.acroField.getWidgets();
    for (const w of rgWidgets) {
      w.dict.delete(PDFName.of('AP'));
    }
    radioDoc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

    const sealedRadio = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await radioDoc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedRadio.ok || sealedRadio.kind !== 'pdf_seal') {
      throw new Error(`expected radio fallback seal to succeed, got: ${JSON.stringify(sealedRadio)}`);
    }
    const radioVerifyDoc = await PDFDocument.load(Buffer.from(sealedRadio.sealedPdfBase64, 'base64'));
    expect(radioVerifyDoc.getPage(0).node.get(PDFName.of('Annots'))).toBeUndefined();
    const radioContents = radioVerifyDoc.getPage(0).node.Contents();
    if (!(radioContents instanceof PDFArray)) {
      throw new Error('expected radio page content streams');
    }
    const radioOps: string[] = [];
    for (let i = 0; i < radioContents.size(); i++) {
      const st = radioVerifyDoc.context.lookup(radioContents.get(i));
      if (st instanceof PDFStream) {
        radioOps.push(Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1'));
      }
    }
    // 2 outer radio rings (4 Bezier 'c' segments each = 8) + 1 filled inner selected dot (4 'c' segments) = 12 curves.
    const bezierCount = (radioOps.join('\n').match(/\sc\n/g) ?? []).length;
    expect(bezierCount).toBe(12);

    // Multi-widget radio group with active /V and neither /AP, /AS, nor /Opt index must fail closed rather than dropping.
    for (const w of rgWidgets) {
      w.dict.delete(PDFName.of('AS'));
    }
    rg.acroField.dict.delete(PDFName.of('Opt'));
    rg.acroField.dict.set(PDFName.of('V'), PDFName.of('OPT_B'));
    const ambiguousRadio = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await radioDoc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(ambiguousRadio).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('preserves /Annots z-order across annotations and widgets, compensates /F 16 NoRotate on rotated pages, and scrubs untyped /Kids password nodes', async () => {
    // 1. Z-order: /Annots = [backgroundSquare, textWidget, foregroundSquare] must paint in original order.
    const zDoc = await PDFDocument.create();
    const zPage = zDoc.addPage([595.28, 841.89]);
    const zForm = zDoc.getForm();
    const zField = zForm.createTextField('z_label');
    zField.setText('Z_ORDER_TEXT');
    zField.addToPage(zPage, { x: 80, y: 650, width: 180, height: 30, borderWidth: 0 });
    zForm.updateFieldAppearances();

    const makeSquareAp = (marker: string) =>
      zDoc.context.register(
        zDoc.context.flateStream(
          Buffer.from(`% ${marker}\n0.9 0.9 0.9 rg\n0 0 220 60 re f\n`, 'latin1'),
          {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: [0, 0, 220, 60],
          },
        ),
      );
    const bgApRef = makeSquareAp('BG_FIRST');
    const fgApRef = makeSquareAp('FG_LAST');
    const bgAnnotRef = zDoc.context.register(
      zDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [60, 640, 280, 700],
        AP: { N: bgApRef },
      }),
    );
    const fgAnnotRef = zDoc.context.register(
      zDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [60, 640, 280, 700],
        AP: { N: fgApRef },
      }),
    );

    const zWidget = zField.acroField.getWidgets()[0];
    if (!zWidget) throw new Error('missing z-order widget');
    const zWidgetRef = zDoc.context.getObjectRef(zWidget.dict);
    if (!zWidgetRef) throw new Error('missing z-order widget ref');
    zPage.node.set(PDFName.of('Annots'), zDoc.context.obj([bgAnnotRef, zWidgetRef, fgAnnotRef]));

    const zSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await zDoc.save()).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!zSealed.ok || zSealed.kind !== 'pdf_seal') {
      throw new Error(`expected z-order seal to succeed, got: ${JSON.stringify(zSealed)}`);
    }
    const zVerifyDoc = await PDFDocument.load(Buffer.from(zSealed.sealedPdfBase64, 'base64'));
    const zVerifyPage = zVerifyDoc.getPage(0);
    const zContents = zVerifyPage.node.Contents();
    if (!(zContents instanceof PDFArray)) throw new Error('expected z-order Contents array');
    const zOps = Array.from({ length: zContents.size() }, (_, idx) => {
      const s = zVerifyDoc.context.lookup(zContents.get(idx));
      return s instanceof PDFStream ? Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1') : '';
    }).join('\n');

    const xObjects = zVerifyPage.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(xObjects instanceof PDFDict)) throw new Error('expected page XObject dict');
    let bgKey = '';
    let widgetKey = '';
    let fgKey = '';
    for (const [k, rawVal] of xObjects.entries()) {
      const st = zVerifyDoc.context.lookup(rawVal);
      if (!(st instanceof PDFStream)) continue;
      const decoded = Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1');
      if (decoded.includes('BG_FIRST')) bgKey = `/${k.decodeText()} Do`;
      else if (decoded.includes('FG_LAST')) fgKey = `/${k.decodeText()} Do`;
      else if (k.decodeText().startsWith('FlatWidget')) widgetKey = `/${k.decodeText()} Do`;
    }
    expect(bgKey).not.toBe('');
    expect(widgetKey).not.toBe('');
    expect(fgKey).not.toBe('');
    const bgPos = zOps.indexOf(bgKey);
    const widgetPos = zOps.indexOf(widgetKey);
    const fgPos = zOps.indexOf(fgKey);
    expect(bgPos).toBeGreaterThanOrEqual(0);
    expect(widgetPos).toBeGreaterThan(bgPos);
    expect(fgPos).toBeGreaterThan(widgetPos);

    // 2. /F 16 (NoRotate) annotations & fallback text widgets counter-rotate to stay upright on 90/270-deg pages.
    const nrDoc = await PDFDocument.create();
    const nrPage = nrDoc.addPage([595.28, 841.89]);
    nrPage.setRotation(degrees(90));
    const nrFont = await nrDoc.embedFont(StandardFonts.Helvetica);
    const nrApRef = nrDoc.context.register(
      nrDoc.context.flateStream(
        Buffer.from('BT\n/F1 12 Tf\n4 14 Td\n(NoRotate Stamp) Tj\nET\n', 'latin1'),
        {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, 200, 40],
          Resources: { Font: { F1: nrFont.ref } },
        },
      ),
    );
    const nrAnnotRef = nrDoc.context.register(
      nrDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [100, 500, 300, 540],
        F: 16,
        AP: { N: nrApRef },
      }),
    );
    nrPage.node.set(PDFName.of('Annots'), nrDoc.context.obj([nrAnnotRef]));

    const nrPage2 = nrDoc.addPage([595.28, 841.89]);
    nrPage2.setRotation(degrees(270));
    const nrForm = nrDoc.getForm();
    const nrField = nrForm.createTextField('norotate_fallback');
    nrField.setText('NoRotate 270 Text');
    nrField.addToPage(nrPage2, { x: 200, y: 400, width: 180, height: 32, borderWidth: 0 });
    const nrWidget = nrField.acroField.getWidgets()[0];
    if (!nrWidget) throw new Error('missing NoRotate fallback widget');
    nrWidget.setFlags(16);
    nrDoc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

    const nrSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await nrDoc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!nrSealed.ok || nrSealed.kind !== 'pdf_seal') {
      throw new Error(`expected NoRotate seal to succeed, got: ${JSON.stringify(nrSealed)}`);
    }
    const nrVerifyBytes = new Uint8Array(Buffer.from(nrSealed.sealedPdfBase64, 'base64'));
    const nrVerifyDoc = await PDFDocument.load(nrVerifyBytes);
    const nrC1 = nrVerifyDoc.getPage(0).node.Contents();
    if (!(nrC1 instanceof PDFArray)) throw new Error('expected page 1 Contents array');
    const nrOps1 = Array.from({ length: nrC1.size() }, (_, idx) => {
      const s = nrVerifyDoc.context.lookup(nrC1.get(idx));
      return s instanceof PDFStream ? Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1') : '';
    }).join('\n');
    // For 90-deg page with NoRotate at Rect [100, 500, 300, 540], anchor is (100, 540), clip is [100, 540, 40, 200], cm is [0 1 -1 0 140 540].
    expect(nrOps1).toContain('100 540 40 200 re');
    expect(nrOps1).toContain('0 1 -1 0 140 540 cm');

    const nrC2 = nrVerifyDoc.getPage(1).node.Contents();
    if (!(nrC2 instanceof PDFArray)) throw new Error('expected page 2 Contents array');
    const nrOps2 = Array.from({ length: nrC2.size() }, (_, idx) => {
      const s = nrVerifyDoc.context.lookup(nrC2.get(idx));
      return s instanceof PDFStream ? Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1') : '';
    }).join('\n');
    // Fallback text with NoRotate on 270-deg page rotates glyphs 270 deg (~[0, -1, 1, 0] Tm) so text displays horizontally.
    const tmMatch = /([0-9eE.+-]+)\s+([0-9eE.+-]+)\s+([0-9eE.+-]+)\s+([0-9eE.+-]+)\s+([0-9eE.+-]+)\s+([0-9eE.+-]+)\s+Tm/.exec(
      nrOps2,
    );
    expect(tmMatch).not.toBeNull();
    expect(Number(tmMatch?.[1])).toBeCloseTo(0, 5);
    expect(Number(tmMatch?.[2])).toBeCloseTo(-1, 5);
    expect(Number(tmMatch?.[3])).toBeCloseTo(1, 5);
    expect(Number(tmMatch?.[4])).toBeCloseTo(0, 5);
    const nrReadBack = await readPdfBack(nrVerifyBytes);
    expect(nrReadBack.pageTexts[0]).toContain('NoRotate Stamp');
    expect(nrReadBack.pageTexts[1]).toContain('NoRotate 270 Text');

    // 3. Unknown-FT parent node with Ff password bit (1 << 13) and no /Parent on child must still scrub child /V.
    const untypedDoc = await PDFDocument.create();
    untypedDoc.addPage([595.28, 841.89]);
    const untypedSecret = 'UNTYPED_KIDS_SECRET_999';
    const childSecretRef = untypedDoc.context.register(
      untypedDoc.context.obj({
        FT: PDFName.of('Custom'),
        T: PDFString.of('kid_secret'),
        V: PDFString.of(untypedSecret),
      }),
    );
    const parentSecretRef = untypedDoc.context.register(
      untypedDoc.context.obj({
        FT: PDFName.of('Custom'),
        T: PDFString.of('parent_secret'),
        Ff: 1 << 13,
        Kids: [childSecretRef],
      }),
    );
    untypedDoc.catalog.set(
      PDFName.of('AcroForm'),
      untypedDoc.context.obj({ Fields: [parentSecretRef] }),
    );
    const untypedSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await untypedDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!untypedSealed.ok || untypedSealed.kind !== 'pdf_seal') {
      throw new Error(`expected custom-FT password scrub seal to succeed, got: ${JSON.stringify(untypedSealed)}`);
    }
    const untypedRawOut = Buffer.from(untypedSealed.sealedPdfBase64, 'base64');
    const reLoaded = await PDFDocument.load(untypedRawOut);
    const uncompressedOut = Buffer.from(await reLoaded.save({ useObjectStreams: false })).toString('latin1');
    expect(uncompressedOut).not.toContain(untypedSecret);

    // Malformed AcroForm field missing /FT must fail closed with a clean invalid result.
    const brokenAcroDoc = await PDFDocument.create();
    brokenAcroDoc.addPage([595.28, 841.89]);
    const brokenFieldRef = brokenAcroDoc.context.register(
      brokenAcroDoc.context.obj({ T: PDFString.of('missing_ft'), V: PDFString.of('val') }),
    );
    brokenAcroDoc.catalog.set(PDFName.of('AcroForm'), brokenAcroDoc.context.obj({ Fields: [brokenFieldRef] }));
    const brokenRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await brokenAcroDoc.save()).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(brokenRes).toMatchObject({ ok: false, code: 'invalid' });
    if (!brokenRes.ok) {
      expect(brokenRes.message).toContain('AcroForm');
    }
  });

  it('canonicalizes lowercase #xx PDFName escapes in resources and preserves inherited checkbox /V state', async () => {
    // 1. Lowercase #xx hex escapes inside /Resources, Form /Subtype, and /Filter array must survive pdf_seal intact.
    const hexDoc = await PDFDocument.create();
    const hexPage = hexDoc.addPage([595.28, 841.89]);
    const hexFont = await hexDoc.embedFont(StandardFonts.Helvetica);
    const formStream = hexDoc.context.flateStream(
      Buffer.from('BT\n/F1 14 Tf\n40 700 Td\n(RESOURCE_HEX_OK) Tj\nET\n', 'latin1'),
      {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 595.28, 841.89],
        Resources: { Font: { F1: hexFont.ref } },
      },
    );
    const formRef = hexDoc.context.register(formStream);
    hexPage.node.set(
      PDFName.of('Resources'),
      hexDoc.context.obj({
        XObject: {
          Ima: formRef,
        },
      }),
    );
    const pageStreamRef = hexDoc.context.register(
      hexDoc.context.flateStream(Buffer.from('q\n/Im#61 Do\nQ\n', 'latin1')),
    );
    hexPage.node.set(PDFName.of('Contents'), pageStreamRef);
    const hexBaseBytes = Buffer.from(await hexDoc.save({ useObjectStreams: false })).toString('latin1');
    const escapedHexPdf = rebuildAsciiXref(
      hexBaseBytes
        .replace(/\/XObject\s*<<\s*\/Ima\b/, '/XOb#6aect\n<<\n/Im#61')
        .replace(/\/Subtype\s+\/Form\b/, '/Subtype /Fo#72m')
        .replace(/\/Filter\s+\/FlateDecode\b/, '/Filter [ /F#6cateDecode ]'),
    );
    const escapedHexRaw = Buffer.from(escapedHexPdf).toString('latin1');
    expect(escapedHexRaw).toContain('/XOb#6aect');
    expect(escapedHexRaw).toContain('/Im#61');
    expect(escapedHexRaw).toContain('/Fo#72m');
    expect(escapedHexRaw).toContain('/F#6cateDecode');

    const hexSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(escapedHexPdf).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!hexSealed.ok || hexSealed.kind !== 'pdf_seal') {
      throw new Error(`expected resource #xx seal to succeed, got: ${JSON.stringify(hexSealed)}`);
    }
    const hexOutBytes = new Uint8Array(Buffer.from(hexSealed.sealedPdfBase64, 'base64'));
    const hexOutDoc = await PDFDocument.load(hexOutBytes);
    const hexOutRaw = Buffer.from(await hexOutDoc.save({ useObjectStreams: false })).toString('latin1');
    expect(hexOutRaw).not.toContain('#236a');
    expect(hexOutRaw).not.toContain('#2361');
    expect(hexOutRaw).not.toContain('#2372');
    expect(hexOutRaw).not.toContain('#236c');

    const { extractText, getDocumentProxy } = await import('unpdf');
    const proxy = await getDocumentProxy(new Uint8Array(hexOutBytes), { isEvalSupported: false } as never);
    const extracted = await extractText(proxy, { mergePages: false });
    const pageTexts = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    expect(pageTexts[0]).toContain('RESOURCE_HEX_OK');
    await Promise.resolve(proxy.cleanup?.()).catch(() => {});

    // 2. Checkbox inheriting /V /Yes from /Parent with NeedAppearances=true and no /AP or /AS stays checked.
    const inhDoc = await PDFDocument.create();
    const inhPage = inhDoc.addPage([595.28, 841.89]);

    const checkedWidgetRef = inhDoc.context.nextRef();
    const checkedParentRef = inhDoc.context.register(
      inhDoc.context.obj({
        FT: PDFName.of('Btn'),
        T: PDFString.of('grp_yes'),
        V: PDFName.of('Yes'),
        Kids: [checkedWidgetRef],
      }),
    );
    inhDoc.context.assign(
      checkedWidgetRef,
      inhDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: checkedParentRef,
        T: PDFString.of('chk_yes'),
        Rect: [72, 700, 92, 720],
        P: inhPage.ref,
      }),
    );

    const uncheckedWidgetRef = inhDoc.context.nextRef();
    const uncheckedParentRef = inhDoc.context.register(
      inhDoc.context.obj({
        FT: PDFName.of('Btn'),
        T: PDFString.of('grp_off'),
        V: PDFName.of('Off'),
        Kids: [uncheckedWidgetRef],
      }),
    );
    inhDoc.context.assign(
      uncheckedWidgetRef,
      inhDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: uncheckedParentRef,
        T: PDFString.of('chk_off'),
        Rect: [72, 660, 92, 680],
        P: inhPage.ref,
      }),
    );

    inhPage.node.set(PDFName.of('Annots'), inhDoc.context.obj([checkedWidgetRef, uncheckedWidgetRef]));
    inhDoc.catalog.set(
      PDFName.of('AcroForm'),
      inhDoc.context.obj({
        Fields: [checkedParentRef, uncheckedParentRef],
        NeedAppearances: true,
      }),
    );

    const inhSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await inhDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!inhSealed.ok || inhSealed.kind !== 'pdf_seal') {
      throw new Error(`expected inherited checkbox seal to succeed, got: ${JSON.stringify(inhSealed)}`);
    }

    const inhVerifyDoc = await PDFDocument.load(Buffer.from(inhSealed.sealedPdfBase64, 'base64'));
    const inhVerifyPage = inhVerifyDoc.getPage(0);
    const inhXObjects = inhVerifyPage.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(inhXObjects instanceof PDFDict)) throw new Error('expected flattened checkbox XObjects');
    const widgetStreams: string[] = [];
    for (const [k, rawVal] of inhXObjects.entries()) {
      if (!k.decodeText().startsWith('FlatWidget')) continue;
      const st = inhVerifyDoc.context.lookup(rawVal);
      if (st instanceof PDFStream) {
        widgetStreams.push(Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1'));
      }
    }
    expect(widgetStreams).toHaveLength(2);
    // Checked box draws checkmark lines inside its appearance XObject; unchecked draws only the box border.
    const checkedStreams = widgetStreams.filter((s) => s.includes('-2.5 -4.9 l'));
    const uncheckedStreams = widgetStreams.filter((s) => !s.includes('-2.5 -4.9 l'));
    expect(checkedStreams).toHaveLength(1);
    expect(uncheckedStreams).toHaveLength(1);
  });

  it('isolates shared indirect /Contents, preserves literal # PDFNames, and terminates on cyclic PDFRef + 2-hop /V', async () => {
    // 1. Two pages sharing the exact same indirect /Contents array: stamping page 1 must not leak to page 2.
    const sharedDoc = await PDFDocument.create();
    const sPage1 = sharedDoc.addPage([595.28, 841.89]);
    const sPage2 = sharedDoc.addPage([595.28, 841.89]);
    const sharedStream = sharedDoc.context.register(sharedDoc.context.flateStream(''));
    const sharedContents = sharedDoc.context.register(sharedDoc.context.obj([sharedStream]));
    sPage1.node.set(PDFName.of('Contents'), sharedContents);
    sPage2.node.set(PDFName.of('Contents'), sharedContents);

    const sharedSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await sharedDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [{ type: 'checkbox', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.08, hNorm: 0.08, checked: true }],
        certificate: makeCertificate(),
      }),
    );
    if (!sharedSealed.ok || sharedSealed.kind !== 'pdf_seal') {
      throw new Error(`expected shared Contents seal to succeed, got: ${JSON.stringify(sharedSealed)}`);
    }
    const sharedOutBytes = new Uint8Array(Buffer.from(sharedSealed.sealedPdfBase64, 'base64'));
    const sharedVerifyDoc = await PDFDocument.load(sharedOutBytes);
    expect(sharedVerifyDoc.getPage(0).node.Contents()).not.toBe(sharedVerifyDoc.getPage(1).node.Contents());
    const { extractText, getDocumentProxy } = await import('unpdf');
    const sharedProxy = await getDocumentProxy(sharedOutBytes, { isEvalSupported: false } as never);
    const p1Ops = await (await sharedProxy.getPage(1)).getOperatorList();
    const p2Ops = await (await sharedProxy.getPage(2)).getOperatorList();
    expect(p1Ops.fnArray.length).toBeGreaterThan(0);
    expect(p2Ops.fnArray.length).toBe(0);
    await Promise.resolve(sharedProxy.cleanup?.()).catch(() => {});

    // 2. Literal '#' in PDFNames (/Im#2361 and /Im#236a) must NOT be double-decoded before pdfDoc.save().
    const litDoc = await PDFDocument.create();
    const litPage = litDoc.addPage([595.28, 841.89]);
    const litFont = await litDoc.embedFont(StandardFonts.Helvetica);
    const form61 = litDoc.context.register(
      litDoc.context.flateStream(Buffer.from('BT\n/F1 12 Tf\n40 720 Td\n(LITERAL_HASH_61_OK) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 595.28, 841.89],
        Resources: { Font: { F1: litFont.ref } },
      }),
    );
    const form6a = litDoc.context.register(
      litDoc.context.flateStream(Buffer.from('BT\n/F1 12 Tf\n40 680 Td\n(LITERAL_HASH_6A_OK) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 595.28, 841.89],
        Resources: { Font: { F1: litFont.ref } },
      }),
    );
    litPage.node.set(
      PDFName.of('Resources'),
      litDoc.context.obj({
        XObject: {
          'Im#2361': form61,
          'Im#236a': form6a,
        },
      }),
    );
    litPage.node.set(
      PDFName.of('Contents'),
      litDoc.context.register(litDoc.context.flateStream('q\n/Im#2361 Do\n/Im#236a Do\nQ\n')),
    );
    const litRawBytes = await litDoc.save({ useObjectStreams: false });
    const litText = Buffer.from(litRawBytes).toString('latin1');
    expect(litText).toContain('/Im#2361');
    expect(litText).toContain('/Im#236a');

    const litSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(litRawBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!litSealed.ok || litSealed.kind !== 'pdf_seal') {
      throw new Error(`expected literal # seal to succeed, got: ${JSON.stringify(litSealed)}`);
    }
    const litOutBytes = new Uint8Array(Buffer.from(litSealed.sealedPdfBase64, 'base64'));
    const litProxy = await getDocumentProxy(litOutBytes, { isEvalSupported: false } as never);
    const litExtracted = await extractText(litProxy, { mergePages: false });
    const litTexts = Array.isArray(litExtracted.text) ? litExtracted.text : [litExtracted.text];
    expect(litTexts[0]).toContain('LITERAL_HASH_61_OK');
    expect(litTexts[0]).toContain('LITERAL_HASH_6A_OK');
    await Promise.resolve(litProxy.cleanup?.()).catch(() => {});

    // Conflicting /Im#236a (literal) + /Im#6a (lowercase escaped) collapsing inside pdf-lib must fail closed.
    const conflictPdf = litText.replace('/Im#2361', '/Im#6a');
    const conflictRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(conflictPdf, 'latin1').toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(conflictRes).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Cyclic indirect PDFRefs (self-cycle + 2-node cycle) must terminate immediately without DoS.
    const cycDoc = await PDFDocument.create();
    const cycPage = cycDoc.addPage([595.28, 841.89]);
    const selfRef = cycDoc.context.nextRef();
    const cycleA = cycDoc.context.nextRef();
    const cycleB = cycDoc.context.nextRef();
    cycDoc.context.assign(selfRef, selfRef);
    cycDoc.context.assign(cycleA, cycleB);
    cycDoc.context.assign(cycleB, cycleA);
    cycPage.node.set(PDFName.of('CycleSelf'), selfRef);
    cycPage.node.set(PDFName.of('CyclePair'), cycleA);
    const cycBytes = await cycDoc.save({ useObjectStreams: false });

    const cycInspect = await inspectPdf(cycBytes);
    expect(cycInspect.ok).toBe(true);
    const cycSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(cycBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(cycSealed.ok).toBe(true);

    // 4. Multi-hop (grandparent -> mid-parent -> leaf widget) inherited /V /Yes keeps checkbox checked.
    const mhDoc = await PDFDocument.create();
    const mhPage = mhDoc.addPage([595.28, 841.89]);
    const leafRef = mhDoc.context.nextRef();
    const midRef = mhDoc.context.nextRef();
    const grandRef = mhDoc.context.register(
      mhDoc.context.obj({
        T: PDFString.of('root_grp'),
        V: PDFName.of('Yes'),
        Kids: [midRef],
      }),
    );
    mhDoc.context.assign(
      midRef,
      mhDoc.context.obj({
        T: PDFString.of('mid_grp'),
        Parent: grandRef,
        Kids: [leafRef],
      }),
    );
    mhDoc.context.assign(
      leafRef,
      mhDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: PDFString.of('leaf_chk'),
        Parent: midRef,
        Rect: [72, 700, 92, 720],
        P: mhPage.ref,
      }),
    );
    mhPage.node.set(PDFName.of('Annots'), mhDoc.context.obj([leafRef]));
    mhDoc.catalog.set(
      PDFName.of('AcroForm'),
      mhDoc.context.obj({ Fields: [grandRef], NeedAppearances: true }),
    );
    const mhSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await mhDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!mhSealed.ok || mhSealed.kind !== 'pdf_seal') {
      throw new Error(`expected multi-hop checkbox seal to succeed, got: ${JSON.stringify(mhSealed)}`);
    }
    const mhVerifyDoc = await PDFDocument.load(Buffer.from(mhSealed.sealedPdfBase64, 'base64'));
    const mhXObjects = mhVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(mhXObjects instanceof PDFDict)) throw new Error('expected multi-hop flattened XObjects');
    const mhStreams: string[] = [];
    for (const [k, rawVal] of mhXObjects.entries()) {
      if (!k.decodeText().startsWith('FlatWidget')) continue;
      const st = mhVerifyDoc.context.lookup(rawVal);
      if (st instanceof PDFStream) {
        mhStreams.push(Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1'));
      }
    }
    expect(mhStreams).toHaveLength(1);
    expect(mhStreams[0]).toContain('-2.5 -4.9 l');
  });

  it('rejects multi-escape PDFName collisions and preserves /AP /N opacity plus widget /MK /R rotation', async () => {
    // 1. Two distinct escaped PDFNames collapsing inside pdf-lib (/Ope#6eActi#6fn vs /Ope#6eActi#236fn) must fail closed in either order.
    const multiDoc = await PDFDocument.create();
    const multiPage = multiDoc.addPage([595.28, 841.89]);
    multiPage.node.set(PDFName.of('TagA'), PDFName.of('PlaceholderOne'));
    multiPage.node.set(PDFName.of('TagB'), PDFName.of('PlaceholderTwo'));
    const multiRaw = Buffer.from(await multiDoc.save({ useObjectStreams: false })).toString('latin1');
    const collideForward = multiRaw
      .replace('/PlaceholderOne', '/Ope#6eActi#6fn')
      .replace('/PlaceholderTwo', '/Ope#6eActi#236fn');
    const collideReverse = multiRaw
      .replace('/PlaceholderOne', '/Ope#6eActi#236fn')
      .replace('/PlaceholderTwo', '/Ope#6eActi#6fn');

    for (const mutated of [collideForward, collideReverse]) {
      const inspectRes = await parse('pdf_inspect', new Uint8Array(Buffer.from(mutated, 'latin1')));
      expect(inspectRes).toMatchObject({ ok: false, code: 'invalid' });
      if (!inspectRes.ok) {
        expect(inspectRes.message).toContain('xung đột');
      }
    }

    // Decoy literal #xx outside an ObjStm while an ObjStm exists must also fail closed cleanly.
    const decoyWithObjStm = makeRawXrefStreamPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /DummyTag /Ope#236eAction >>' },
      ],
      [{ num: 5, body: '<<>>' }],
      4,
      6,
    );
    const decoyInspect = await parse('pdf_inspect', decoyWithObjStm);
    expect(decoyInspect).toMatchObject({ ok: false, code: 'invalid' });
    if (!decoyInspect.ok) {
      expect(decoyInspect.message).toContain('xung đột');
    }

    // 2. Non-widget /Square with an explicit /AP /N stream and /CA 0 still paints /AP /N per ISO 32000-1 & PDF.js.
    const sqDoc = await PDFDocument.create();
    const sqPage = sqDoc.addPage([595.28, 841.89]);
    const sqFont = await sqDoc.embedFont(StandardFonts.Helvetica);
    const sqApRef = sqDoc.context.register(
      sqDoc.context.flateStream(Buffer.from('0 0 0 rg\n0 0 80 40 re f\nBT\n/F1 10 Tf\n1 1 1 rg\n4 15 Td\n(CA_ZERO_AP_OK) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 80, 40],
        Resources: { Font: { F1: sqFont.ref } },
      }),
    );
    const sqAnnotRef = sqDoc.context.register(
      sqDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [50, 650, 130, 690],
        CA: 0,
        F: 4,
        AP: { N: sqApRef },
      }),
    );
    sqPage.node.set(PDFName.of('Annots'), sqDoc.context.obj([sqAnnotRef]));

    const sqSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await sqDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sqSealed.ok || sqSealed.kind !== 'pdf_seal') {
      throw new Error(`expected /Square AP with CA=0 seal to succeed, got: ${JSON.stringify(sqSealed)}`);
    }
    const sqOutBytes = new Uint8Array(Buffer.from(sqSealed.sealedPdfBase64, 'base64'));
    const { extractText, getDocumentProxy } = await import('unpdf');
    const sqProxy = await getDocumentProxy(sqOutBytes, { isEvalSupported: false } as never);
    const sqText = await extractText(sqProxy, { mergePages: false });
    const sqPageTexts = Array.isArray(sqText.text) ? sqText.text : [sqText.text];
    expect(sqPageTexts[0]).toContain('CA_ZERO_AP_OK');
    await Promise.resolve(sqProxy.cleanup?.()).catch(() => {});

    // 3. Form text field with NeedAppearances=true and /MK << /R 90 >> lays out text in the rotated frame on one rotated line.
    const rotDoc = await PDFDocument.create();
    const rotPage = rotDoc.addPage([595.28, 841.89]);
    const rotWidgetRef = rotDoc.context.nextRef();
    const rotFieldRef = rotDoc.context.register(
      rotDoc.context.obj({
        FT: PDFName.of('Tx'),
        T: PDFString.of('rot_field'),
        V: PDFString.of('ROTATED VALUE'),
        Kids: [rotWidgetRef],
      }),
    );
    rotDoc.context.assign(
      rotWidgetRef,
      rotDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: rotFieldRef,
        Rect: [100, 100, 130, 300],
        MK: { R: 90 },
        P: rotPage.ref,
      }),
    );
    rotPage.node.set(PDFName.of('Annots'), rotDoc.context.obj([rotWidgetRef]));
    rotDoc.catalog.set(
      PDFName.of('AcroForm'),
      rotDoc.context.obj({ Fields: [rotFieldRef], NeedAppearances: true }),
    );

    const rotSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await rotDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!rotSealed.ok || rotSealed.kind !== 'pdf_seal') {
      throw new Error(`expected rotated widget seal to succeed, got: ${JSON.stringify(rotSealed)}`);
    }
    const rotOutBytes = new Uint8Array(Buffer.from(rotSealed.sealedPdfBase64, 'base64'));
    const rotProxy = await getDocumentProxy(rotOutBytes, { isEvalSupported: false } as never);
    const rotPageObj = await rotProxy.getPage(1);
    const rotTextContent = await rotPageObj.getTextContent();
    const rotItems = rotTextContent.items.flatMap((item) =>
      'str' in item && 'transform' in item && Array.isArray(item.transform) && item.str.trim().length > 0
        ? [{ str: item.str, transform: item.transform.map(Number) }]
        : [],
    );
    expect(rotItems.map((item) => item.str).join('')).toBe('ROTATED VALUE');
    expect(rotItems).toHaveLength(1);
    const [rotItem] = rotItems;
    expect(Math.abs(rotItem?.transform[0] ?? 1)).toBeLessThan(0.01);
    expect(rotItem?.transform[1]).toBeGreaterThan(0);
    expect(rotItem?.transform[2]).toBeLessThan(0);
    expect(rotItem?.transform[4]).toBeGreaterThanOrEqual(100);
    expect(rotItem?.transform[4]).toBeLessThanOrEqual(130);
    expect(rotItem?.transform[5]).toBeGreaterThanOrEqual(100);
    expect(rotItem?.transform[5]).toBeLessThanOrEqual(300);
    await Promise.resolve(rotProxy.cleanup?.()).catch(() => {});
  });

  it('preserves NeedAppearances widget /MK /BG background and /BC border and strips /OC from flattened appearances', async () => {
    // 1. NeedAppearances=true widget with /MK /BG [1 1 1] and /BC [0 0 0] must emit fill/stroke rect before text.
    const boxDoc = await PDFDocument.create();
    const boxPage = boxDoc.addPage([595.28, 841.89]);
    const bgFont = await boxDoc.embedFont(StandardFonts.Helvetica);
    boxPage.drawText('UNDERLYING', { x: 80, y: 710, size: 12, font: bgFont });

    const coveredRef = boxDoc.context.nextRef();
    const coveredFieldRef = boxDoc.context.register(
      boxDoc.context.obj({
        FT: PDFName.of('Tx'),
        T: PDFString.of('masked_box'),
        V: PDFString.of('COVER_VALUE'),
        Kids: [coveredRef],
      }),
    );
    boxDoc.context.assign(
      coveredRef,
      boxDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: coveredFieldRef,
        Rect: [70, 700, 250, 735],
        MK: { BG: [1, 1, 1], BC: [0, 0, 0] },
        BS: { W: 1.5 },
        P: boxPage.ref,
      }),
    );

    const emptyStyledRef = boxDoc.context.nextRef();
    const emptyFieldRef = boxDoc.context.register(
      boxDoc.context.obj({
        FT: PDFName.of('Tx'),
        T: PDFString.of('empty_bg_box'),
        Kids: [emptyStyledRef],
      }),
    );
    boxDoc.context.assign(
      emptyStyledRef,
      boxDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: emptyFieldRef,
        Rect: [70, 640, 200, 670],
        MK: { BG: [0.95] },
        P: boxPage.ref,
      }),
    );

    boxPage.node.set(PDFName.of('Annots'), boxDoc.context.obj([coveredRef, emptyStyledRef]));
    boxDoc.catalog.set(
      PDFName.of('AcroForm'),
      boxDoc.context.obj({ Fields: [coveredFieldRef, emptyFieldRef], NeedAppearances: true }),
    );

    const boxSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await boxDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!boxSealed.ok || boxSealed.kind !== 'pdf_seal') {
      throw new Error(`expected widget /MK BG+BC seal to succeed, got: ${JSON.stringify(boxSealed)}`);
    }
    const boxOutBytes = new Uint8Array(Buffer.from(boxSealed.sealedPdfBase64, 'base64'));
    const boxVerifyDoc = await PDFDocument.load(boxOutBytes);
    const readStreamsText = (rawContents: PDFObject | undefined): string => {
      let buf = '';
      const visit = (item: PDFObject | undefined): void => {
        if (!item) return;
        const resolved = boxVerifyDoc.context.lookup(item);
        if (resolved instanceof PDFStream) {
          buf += Buffer.from(decodePDFRawStream(resolved as never).decode()).toString('latin1') + '\n';
        } else if (resolved instanceof PDFArray) {
          for (let i = 0; i < resolved.size(); i++) visit(resolved.get(i));
        }
      };
      visit(rawContents);
      return buf;
    };
    const boxStreamText = readStreamsText(boxVerifyDoc.getPage(0).node.Contents());
    const fillAndStrokeIdx = boxStreamText.indexOf('1 1 1 rg');
    const borderStrokeIdx = boxStreamText.indexOf('0 0 0 RG');
    const grayFillIdx = boxStreamText.indexOf('0.95 g');
    const tjIdx = boxStreamText.indexOf('Tj', Math.max(fillAndStrokeIdx, 0));
    expect(fillAndStrokeIdx).toBeGreaterThan(-1);
    expect(borderStrokeIdx).toBeGreaterThan(-1);
    expect(grayFillIdx).toBeGreaterThan(-1);
    expect(boxStreamText).toContain('\nB\n');
    expect(tjIdx).toBeGreaterThan(fillAndStrokeIdx);

    // 2. Active /OC on flattened /AP /N (and nested /Resources /XObject) must be stripped on cloned flattened streams,
    //    while OFF nested child XObjects remain suppressed.
    const ocDoc = await PDFDocument.create();
    const ocPage = ocDoc.addPage([595.28, 841.89]);
    const ocFont = await ocDoc.embedFont(StandardFonts.Helvetica);
    const onOcg = ocDoc.context.register(ocDoc.context.obj({ Type: PDFName.of('OCG'), Name: PDFString.of('VisibleLayer') }));
    const offOcg = ocDoc.context.register(ocDoc.context.obj({ Type: PDFName.of('OCG'), Name: PDFString.of('HiddenLayer') }));
    ocDoc.catalog.set(
      PDFName.of('OCProperties'),
      ocDoc.context.obj({
        OCGs: [onOcg, offOcg],
        D: { BaseState: PDFName.of('ON'), OFF: [offOcg] },
      }),
    );

    const visChildRef = ocDoc.context.register(
      ocDoc.context.flateStream(Buffer.from('BT\n/F1 10 Tf\n4 22 Td\n(VISIBLE_LAYER_MARK) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 140, 40],
        OC: onOcg,
        Resources: { Font: { F1: ocFont.ref } },
      }),
    );
    const hidChildRef = ocDoc.context.register(
      ocDoc.context.flateStream(Buffer.from('BT\n/F1 10 Tf\n4 8 Td\n(HIDDEN_LAYER_MARK) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 140, 40],
        OC: offOcg,
        Resources: { Font: { F1: ocFont.ref } },
      }),
    );
    const sqOcApRef = ocDoc.context.register(
      ocDoc.context.flateStream(Buffer.from('/Vis Do\n/Hid Do\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 140, 40],
        OC: onOcg,
        Resources: { XObject: { Vis: visChildRef, Hid: hidChildRef } },
      }),
    );
    const ocAnnotRef = ocDoc.context.register(
      ocDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [60, 600, 200, 640],
        F: 4,
        AP: { N: sqOcApRef },
      }),
    );
    ocPage.node.set(PDFName.of('Annots'), ocDoc.context.obj([ocAnnotRef]));

    const ocSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await ocDoc.save({ useObjectStreams: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!ocSealed.ok || ocSealed.kind !== 'pdf_seal') {
      throw new Error(`expected /OC frozen appearance seal to succeed, got: ${JSON.stringify(ocSealed)}`);
    }
    const ocOutBytes = new Uint8Array(Buffer.from(ocSealed.sealedPdfBase64, 'base64'));
    const ocVerifyDoc = await PDFDocument.load(ocOutBytes);
    const ocXObjects = ocVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(ocXObjects instanceof PDFDict)) throw new Error('expected flattened XObjects dict');
    let checkedFlatAnnot = false;
    for (const [k, rawVal] of ocXObjects.entries()) {
      if (!k.decodeText().startsWith('FlatAnnot')) continue;
      checkedFlatAnnot = true;
      const flatStream = ocVerifyDoc.context.lookup(rawVal);
      if (!(flatStream instanceof PDFStream)) throw new Error('expected FlatAnnot PDFStream');
      expect(flatStream.dict.get(PDFName.of('OC'))).toBeUndefined();
      const childRes = flatStream.dict.lookup(PDFName.of('Resources'));
      if (!(childRes instanceof PDFDict)) throw new Error('expected FlatAnnot Resources');
      const nestedXObjs = childRes.lookup(PDFName.of('XObject'));
      if (!(nestedXObjs instanceof PDFDict)) throw new Error('expected nested XObject dict');
      const nestedVis = nestedXObjs.lookup(PDFName.of('Vis'));
      if (!(nestedVis instanceof PDFStream)) throw new Error('expected Vis PDFStream');
      expect(nestedVis.dict.get(PDFName.of('OC'))).toBeUndefined();
    }
    expect(checkedFlatAnnot).toBe(true);

    const { extractText, getDocumentProxy } = await import('unpdf');
    const ocProxy = await getDocumentProxy(ocOutBytes, { isEvalSupported: false } as never);
    const ocExtracted = await extractText(ocProxy, { mergePages: false });
    const ocTexts = Array.isArray(ocExtracted.text) ? ocExtracted.text : [ocExtracted.text];
    expect(ocTexts[0]).toContain('VISIBLE_LAYER_MARK');
    expect(ocTexts[0]).not.toContain('HIDDEN_LAYER_MARK');
    await Promise.resolve(ocProxy.cleanup?.()).catch(() => {});
  });

  it('prunes unreferenced prior password /AP streams, orphaned hex streams, and orphan password widgets before saving', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const sharedHelv = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('SHARED_PAGE_FONT_OK', { x: 40, y: 790, size: 12, font: sharedHelv });

    const form = doc.getForm();
    const pw = form.createTextField('updated_password');
    pw.addToPage(page, { x: 40, y: 730, width: 220, height: 24 });
    // First appearance write generates a compressed /AP stream containing PASSWORD_OLD_123 (hex-encoded).
    pw.setText('PASSWORD_OLD_123');
    pw.updateAppearances(sharedHelv);
    // Subsequent update overwrites /AP on the widget while leaving the prior /AP stream orphaned in pdfDoc.context.
    pw.enablePassword();
    pw.setText('PASSWORD_NEW_456');
    pw.updateAppearances(sharedHelv);

    // Additional unreferenced compressed stream holding a hex-encoded secret string.
    const orphanHexPayload = Buffer.from('HEX_ORPHAN_SECRET', 'utf8').toString('hex');
    doc.context.register(
      doc.context.flateStream(Buffer.from(`BT\n/F1 10 Tf\n4 4 Td\n<${orphanHexPayload}> Tj\nET\n`, 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 120, 24],
        Resources: { Font: { F1: sharedHelv.ref } },
      }),
    );

    // Orphan password widget in /Annots without an /AcroForm /Fields entry sharing sharedHelv in its /AP.
    const orphanPwApRef = doc.context.register(
      doc.context.flateStream(
        Buffer.from(`BT\n/F1 10 Tf\n4 6 Td\n<${Buffer.from('ORPHAN_WIDGET_SECRET', 'utf8').toString('hex')}> Tj\nET\n`, 'latin1'),
        {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          FormType: 1,
          BBox: [0, 0, 180, 24],
          Resources: { Font: { F1: sharedHelv.ref } },
        },
      ),
    );
    const orphanPwWidgetRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        Ff: 1 << 13,
        Rect: [40, 680, 220, 704],
        V: PDFString.of('ORPHAN_WIDGET_SECRET'),
        AP: { N: orphanPwApRef },
      }),
    );
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) throw new Error('expected page Annots array');
    annots.push(orphanPwWidgetRef);

    const bytes = await doc.save({ useObjectStreams: false });
    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!res.ok || res.kind !== 'pdf_seal') {
      throw new Error(`expected password pruning seal to succeed, got: ${JSON.stringify(res)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).toContain('SHARED_PAGE_FONT_OK');
    expect(readBack.pageTexts[0]).toContain('*'.repeat(16));
    expect(readBack.pageTexts[0]).not.toContain('PASSWORD_OLD_123');
    expect(readBack.pageTexts[0]).not.toContain('PASSWORD_NEW_456');
    expect(readBack.pageTexts[0]).not.toContain('HEX_ORPHAN_SECRET');
    expect(readBack.pageTexts[0]).not.toContain('ORPHAN_WIDGET_SECRET');

    await assertNoSecretInSealedPdf(sealedBytes, [
      'PASSWORD_OLD_123',
      'PASSWORD_NEW_456',
      'HEX_ORPHAN_SECRET',
      'ORPHAN_WIDGET_SECRET',
    ]);
  });

  it('preserves /DA text colors on regenerated AcroForm fields and normalizes inverted MediaBox/CropBox', async () => {
    // 1. Dark /MK /BG with white /DA (1 g), AcroForm-inherited RGB /DA (0 0.5 1 rg), and CMYK with /rg font name.
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const form = doc.getForm();
    const acroDict = doc.catalog.getOrCreateAcroForm().dict;
    acroDict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    acroDict.set(PDFName.of('DA'), PDFString.of('/Helv 11 Tf 0 0.5 1 rg'));

    const whiteOnBlack = form.createTextField('white_on_black');
    whiteOnBlack.setText('WHITE_TEXT_OK');
    whiteOnBlack.addToPage(page, { x: 40, y: 740, width: 220, height: 28 });
    const wobWidget = whiteOnBlack.acroField.getWidgets()[0];
    if (!wobWidget) throw new Error('missing white_on_black widget');
    wobWidget.dict.set(PDFName.of('MK'), doc.context.obj({ BG: [0] }));
    wobWidget.dict.set(PDFName.of('DA'), PDFString.of('/Helv 12 Tf 1 g'));

    const inheritedRgb = form.createTextField('inherited_rgb');
    inheritedRgb.setText('RGB_INHERITED_OK');
    inheritedRgb.addToPage(page, { x: 40, y: 690, width: 220, height: 28 });
    inheritedRgb.acroField.dict.delete(PDFName.of('DA'));
    const rgbWidget = inheritedRgb.acroField.getWidgets()[0];
    if (!rgbWidget) throw new Error('missing inherited_rgb widget');
    rgbWidget.dict.delete(PDFName.of('DA'));

    const cmykField = form.createTextField('cmyk_named_rg_font');
    cmykField.setText('CMYK_TOKENIZER_OK');
    cmykField.addToPage(page, { x: 40, y: 640, width: 220, height: 28 });
    const cmykWidget = cmykField.acroField.getWidgets()[0];
    if (!cmykWidget) throw new Error('missing cmyk_named_rg_font widget');
    cmykWidget.dict.set(
      PDFName.of('DA'),
      PDFHexString.fromText('% literal (ignored 1 1 1 rg) comment\n/rg 10 Tf 0 1 1 0 k'),
    );

    const daSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await doc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!daSealed.ok || daSealed.kind !== 'pdf_seal') {
      throw new Error(`expected /DA color preservation seal to succeed, got: ${JSON.stringify(daSealed)}`);
    }

    const daOutBytes = new Uint8Array(Buffer.from(daSealed.sealedPdfBase64, 'base64'));
    const daVerifyDoc = await PDFDocument.load(daOutBytes);
    const daContents = daVerifyDoc.getPage(0).node.Contents();
    if (!(daContents instanceof PDFArray)) throw new Error('expected page Contents array');
    let combinedOps = '';
    for (let i = 0; i < daContents.size(); i++) {
      const stream = daVerifyDoc.context.lookup(daContents.get(i));
      if (stream instanceof PDFStream) {
        combinedOps += `${Buffer.from(decodePDFRawStream(stream as never).decode()).toString('latin1')}\n`;
      }
    }
    expect(combinedOps).toContain('1 g\n');
    expect(combinedOps).toContain('0 0.5 1 rg\n');
    expect(combinedOps).toContain('0 1 1 0 k\n');

    const daReadBack = await readPdfBack(daOutBytes);
    expect(daReadBack.pageTexts[0]).toContain('WHITE_TEXT_OK');
    expect(daReadBack.pageTexts[0]).toContain('RGB_INHERITED_OK');
    expect(daReadBack.pageTexts[0]).toContain('CMYK_TOKENIZER_OK');

    // 2. Inverted MediaBox [595, 842, 0, 0] and inverted CropBox [520, 760, 20, 40] must inspect & seal cleanly.
    const invDoc = await PDFDocument.create();
    const invPage1 = invDoc.addPage([595, 842]);
    invPage1.node.set(PDFName.of('MediaBox'), invDoc.context.obj([595, 842, 0, 0]));
    const invPage2 = invDoc.addPage([595, 842]);
    invPage2.node.set(PDFName.of('MediaBox'), invDoc.context.obj([595, 842, 0, 0]));
    invPage2.node.set(PDFName.of('CropBox'), invDoc.context.obj([520, 760, 20, 40]));

    const invBytes = await invDoc.save({ useObjectStreams: false });
    const invInspected = await parse('pdf_inspect', invBytes);
    expect(invInspected.ok).toBe(true);
    if (!invInspected.ok || invInspected.kind !== 'pdf_inspect') {
      throw new Error(`expected inverted box inspect to succeed, got: ${JSON.stringify(invInspected)}`);
    }
    expect(invInspected.pages[0]).toMatchObject({ page: 1, widthPt: 595, heightPt: 842, rotation: 0 });
    expect(invInspected.pages[1]).toMatchObject({ page: 2, widthPt: 500, heightPt: 720, rotation: 0 });

    const invSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(invBytes).toString('base64'),
        fields: [
          {
            type: 'text',
            page: 1,
            xNorm: 0.1,
            yNorm: 0.15,
            wNorm: 0.5,
            hNorm: 0.08,
            text: 'INVERTED_BOX_STAMP_OK',
          },
        ],
        certificate: makeCertificate(),
      }),
    );
    if (!invSealed.ok || invSealed.kind !== 'pdf_seal') {
      throw new Error(`expected inverted box seal to succeed, got: ${JSON.stringify(invSealed)}`);
    }
    const invOutBytes = new Uint8Array(Buffer.from(invSealed.sealedPdfBase64, 'base64'));
    const invReadBack = await readPdfBack(invOutBytes);
    expect(invReadBack.pageTexts[0]).toContain('INVERTED_BOX_STAMP_OK');
  });

  it('preserves non-unison radio /AS selection with shared ON names, allows /JS font resource aliases, and detects non-flattenable annotations during pdf_inspect', async () => {
    // 1. Non-unison radio group with two widgets sharing ON name /Yes must keep selected widget ON and sibling Off.
    const nonUnisonDoc = await PDFDocument.create();
    const nuPage = nonUnisonDoc.addPage([595.28, 841.89]);
    const mkRadioAp = (marker: string) =>
      nonUnisonDoc.context.register(
        nonUnisonDoc.context.stream(`q 0 0 0 rg (% ${marker}) pop 0 0 18 18 re f Q`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 18, 18],
        }),
      );
    const apOn0 = mkRadioAp('RADIO_0_ON_STATE');
    const apOff0 = mkRadioAp('RADIO_0_OFF_STATE');
    const apOn1 = mkRadioAp('RADIO_1_ON_STATE');
    const apOff1 = mkRadioAp('RADIO_1_OFF_STATE');

    const radioGroupDict = nonUnisonDoc.context.obj({
      FT: PDFName.of('Btn'),
      Ff: 1 << 15, // Radio flag set, RadiosInUnison (bit 26) cleared
      T: PDFString.of('contract_tier'),
      V: PDFName.of('Yes'),
      Kids: [],
    });
    const radioGroupRef = nonUnisonDoc.context.register(radioGroupDict);
    const radioW0Ref = nonUnisonDoc.context.register(
      nonUnisonDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: radioGroupRef,
        Rect: [50, 700, 68, 718],
        P: nuPage.ref,
        AS: PDFName.of('Yes'),
        AP: { N: { Yes: apOn0, Off: apOff0 } },
      }),
    );
    const radioW1Ref = nonUnisonDoc.context.register(
      nonUnisonDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: radioGroupRef,
        Rect: [90, 700, 108, 718],
        P: nuPage.ref,
        AS: PDFName.of('Off'),
        AP: { N: { Yes: apOn1, Off: apOff1 } },
      }),
    );
    radioGroupDict.set(PDFName.of('Kids'), nonUnisonDoc.context.obj([radioW0Ref, radioW1Ref]));
    nuPage.node.set(PDFName.of('Annots'), nonUnisonDoc.context.obj([radioW0Ref, radioW1Ref]));
    nonUnisonDoc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('Fields'), nonUnisonDoc.context.obj([radioGroupRef]));

    const nuBytes = await nonUnisonDoc.save({ updateFieldAppearances: false });
    const nuInspected = await parse('pdf_inspect', nuBytes);
    expect(nuInspected.ok).toBe(true);

    const nuSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(nuBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!nuSealed.ok || nuSealed.kind !== 'pdf_seal') {
      throw new Error(`expected non-unison radio seal to succeed, got: ${JSON.stringify(nuSealed)}`);
    }
    const nuVerifyDoc = await PDFDocument.load(Buffer.from(nuSealed.sealedPdfBase64, 'base64'));
    const nuXObjs = nuVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(nuXObjs instanceof PDFDict)) {
      throw new Error('expected FlatWidget XObject dict on sealed radio page');
    }
    const nuStreams = Array.from(nuXObjs.entries())
      .map(([, ref]) => nuVerifyDoc.context.lookup(ref))
      .filter((obj): obj is PDFStream => obj instanceof PDFStream)
      .map((st) => Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1'));
    expect(nuStreams.some((s) => s.includes('RADIO_0_ON_STATE'))).toBe(true);
    expect(nuStreams.some((s) => s.includes('RADIO_0_OFF_STATE'))).toBe(false);
    expect(nuStreams.some((s) => s.includes('RADIO_1_OFF_STATE'))).toBe(true);
    expect(nuStreams.some((s) => s.includes('RADIO_1_ON_STATE'))).toBe(false);

    // RadiosInUnison (1 << 25) ON must select both widgets sharing /Yes, whereas shared /Yes without RadiosInUnison and without /AS fails closed.
    radioGroupDict.set(PDFName.of('Ff'), nonUnisonDoc.context.obj((1 << 15) | (1 << 25)));
    const unisonSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(await nonUnisonDoc.save({ updateFieldAppearances: false })).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!unisonSealed.ok || unisonSealed.kind !== 'pdf_seal') {
      throw new Error(`expected unison radio seal to succeed, got: ${JSON.stringify(unisonSealed)}`);
    }
    const unisonVerifyDoc = await PDFDocument.load(Buffer.from(unisonSealed.sealedPdfBase64, 'base64'));
    const unisonXObjs = unisonVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(unisonXObjs instanceof PDFDict)) {
      throw new Error('expected FlatWidget XObject dict on sealed unison radio page');
    }
    const unisonStreams = Array.from(unisonXObjs.entries())
      .map(([, ref]) => unisonVerifyDoc.context.lookup(ref))
      .filter((obj): obj is PDFStream => obj instanceof PDFStream)
      .map((st) => Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1'));
    expect(unisonStreams.some((s) => s.includes('RADIO_0_ON_STATE'))).toBe(true);
    expect(unisonStreams.some((s) => s.includes('RADIO_1_ON_STATE'))).toBe(true);

    // Non-unison radio group with shared /Yes and no distinguishing /AS must fail closed upfront in pdf_inspect too.
    radioGroupDict.set(PDFName.of('Ff'), nonUnisonDoc.context.obj(1 << 15));
    (nonUnisonDoc.context.lookup(radioW0Ref) as PDFDict).set(PDFName.of('AS'), PDFName.of('Off'));
    (nonUnisonDoc.context.lookup(radioW1Ref) as PDFDict).set(PDFName.of('AS'), PDFName.of('Off'));
    const ambiguousInspect = await parse(
      'pdf_inspect',
      await nonUnisonDoc.save({ updateFieldAppearances: false }),
    );
    expect(ambiguousInspect).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Resource name /JS in /Resources /Font must be allowed, while dual-referenced /A dict containing /JS must still be rejected.
    const resDoc = await PDFDocument.create();
    const resPage = resDoc.addPage([595.28, 841.89]);
    const helvFont = resDoc.context.register(
      resDoc.context.obj({
        Type: PDFName.of('Font'),
        Subtype: PDFName.of('Type1'),
        BaseFont: PDFName.of('Helvetica'),
      }),
    );
    const indirectFontMapRef = resDoc.context.register(resDoc.context.obj({ JS: helvFont }));
    resPage.node.set(
      PDFName.of('Resources'),
      resDoc.context.obj({ Font: indirectFontMapRef }),
    );
    const resStreamRef = resDoc.context.register(
      resDoc.context.stream('BT /JS 12 Tf 72 720 Td (FONT_ALIAS_JS_OK) Tj ET', {}),
    );
    resPage.node.set(PDFName.of('Contents'), resStreamRef);
    const resBytes = await resDoc.save();
    const resInspected = await parse('pdf_inspect', resBytes);
    expect(resInspected).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    if (resInspected.ok && resInspected.kind === 'pdf_inspect') {
      expect(resInspected.pages[0]?.text).toContain('FONT_ALIAS_JS_OK');
    }
    const resSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(resBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(resSealed).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // Dual-referenced /Resources /Font dict (same indirect dict attached to /A on a /Link annot) must still be blocked.
    const dualDoc = await PDFDocument.create();
    const dualPage = dualDoc.addPage([595.28, 841.89]);
    const safeFont = dualDoc.context.register(
      dualDoc.context.obj({
        Type: PDFName.of('Font'),
        Subtype: PDFName.of('Type1'),
        BaseFont: PDFName.of('Helvetica'),
      }),
    );
    const dualFontMapRef = dualDoc.context.register(dualDoc.context.obj({ JS: safeFont }));
    dualPage.node.set(PDFName.of('Resources'), dualDoc.context.obj({ Font: dualFontMapRef }));
    dualPage.node.set(
      PDFName.of('Annots'),
      dualDoc.context.obj([
        dualDoc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Link'),
          Rect: [0, 0, 100, 20],
          A: dualFontMapRef,
        }),
      ]),
    );
    const dualRejected = await parse('pdf_inspect', await dualDoc.save());
    expect(dualRejected).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Non-flattenable /Subtype /Text sticky note without /AP must be rejected upfront during pdf_inspect,
    // whereas /Subtype /Text with /AP inspects and seals cleanly.
    const noteDoc = await PDFDocument.create();
    const notePage = noteDoc.addPage([595.28, 841.89]);
    notePage.node.set(
      PDFName.of('Annots'),
      noteDoc.context.obj([
        noteDoc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Text'),
          Rect: [40, 700, 64, 724],
          Contents: PDFString.of('Sticky note without AP'),
        }),
      ]),
    );
    const bareNoteBytes = await noteDoc.save();
    const noteInspectRejected = await parse('pdf_inspect', bareNoteBytes);
    expect(noteInspectRejected).toMatchObject({ ok: false, code: 'invalid' });
    const noteSealRejected = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bareNoteBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(noteSealRejected).toMatchObject({ ok: false, code: 'invalid' });

    // Hidden /Text without /AP (F: 2) or /Text with /AP stream must both inspect & seal cleanly.
    const noteApRef = noteDoc.context.register(
      noteDoc.context.stream('q 1 0.85 0 rg 0 0 24 24 re f Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 24, 24],
      }),
    );
    notePage.node.set(
      PDFName.of('Annots'),
      noteDoc.context.obj([
        noteDoc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Text'),
          Rect: [40, 700, 64, 724],
          AP: { N: noteApRef },
        }),
      ]),
    );
    const validNoteBytes = await noteDoc.save();
    expect(await parse('pdf_inspect', validNoteBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(validNoteBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });
  });

  it('rejects differential-parser xref shadows, post-EOF/free/ObjStm conflicts, and accepts valid incremental and linearized updates', async () => {
    const buildContentPdf = (text1: string, extraRawAfterBody = ''): Uint8Array => {
      const s1 = `BT\n/F1 12 Tf\n40 750 Td\n(${text1}) Tj\nET\n`;
      const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      let out = '%PDF-1.4\n';
      const offsets: number[] = [];
      for (let i = 0; i < objs.length; i += 1) {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
      }
      out += extraRawAfterBody;
      const xrefOffset = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      for (const offset of offsets) {
        out += `${String(offset).padStart(10, '0')} 00000 n \n`;
      }
      out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      return new TextEncoder().encode(out);
    };

    // 1. Codex shadow-object repro: xref points 4 0 to (PAY 100), duplicate 4 0 obj has (PAY 900000).
    const shadowStream = 'BT\n/F1 12 Tf\n40 750 Td\n(PAY 900000) Tj\nET\n';
    const shadowPdf = buildContentPdf(
      'PAY 100',
      `4 0 obj\n<< /Length ${shadowStream.length} >>\nstream\n${shadowStream}\nendstream\nendobj\n`,
    );
    expect(await parse('pdf_inspect', shadowPdf)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(shadowPdf).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Identical duplicate 4 0 obj not active in xref must still fail closed.
    const sameStream = 'BT\n/F1 12 Tf\n40 750 Td\n(PAY 100) Tj\nET\n';
    const dupIdenticalPdf = buildContentPdf(
      'PAY 100',
      `4 0 obj\n<< /Length ${sameStream.length} >>\nstream\n${sameStream}\nendstream\nendobj\n`,
    );
    expect(await parse('pdf_inspect', dupIdenticalPdf)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(dupIdenticalPdf).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Post-%%EOF object injection must fail closed.
    const baseCleanRaw = Buffer.from(buildContentPdf('PAY 100')).toString('latin1');
    const postEofPdf = new TextEncoder().encode(
      `${baseCleanRaw}4 0 obj\n<< /Length ${shadowStream.length} >>\nstream\n${shadowStream}\nendstream\nendobj\n`,
    );
    expect(await parse('pdf_inspect', postEofPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 4. Object marked free (f) in xref but present in file body must fail closed.
    const freeResurrectRaw = Buffer.from(
      makeRawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
        '(DELETED_PAY_900000)',
      ]),
    ).toString('latin1');
    const freeMarkedPdf = new TextEncoder().encode(
      freeResurrectRaw.replace(/(\d{10}) 00000 n (\r?\ntrailer)/, '0000000000 00001 f $2'),
    );
    expect(await parse('pdf_inspect', freeMarkedPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 5. Unindexed object present in body must fail closed.
    const unindexedPdf = buildContentPdf('PAY 100', '6 0 obj\n(UNINDEXED)\nendobj\n');
    expect(await parse('pdf_inspect', unindexedPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 6. Generation mismatch (4 1 obj vs 4 0 active in xref) must fail closed.
    const genMismatchPdf = buildContentPdf(
      'PAY 100',
      `4 1 obj\n<< /Length ${shadowStream.length} >>\nstream\n${shadowStream}\nendstream\nendobj\n`,
    );
    expect(await parse('pdf_inspect', genMismatchPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 7. Broken /Root triggering pdf-lib maybeRecoverRoot hijack must fail closed.
    const recoverRootBase = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      '<< /Type /Catalog /Pages 2 0 R >>',
    ]);
    const recoverRootPdf = new TextEncoder().encode(
      Buffer.from(recoverRootBase).toString('latin1').replace('/Root 1 0 R', '/Root 99 0 R'),
    );
    expect(await parse('pdf_inspect', recoverRootPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 8. Malformed or dangling /XRefStm pointer must fail closed.
    const hybridPdf = makeRawPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      ],
      '/XRefStm 10 ',
    );
    expect(await parse('pdf_inspect', hybridPdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 8b. Stream with bogus indirect /Length smuggling an inner endstream + shadow 4 0 obj must fail closed.
    const innerSmuggle = `BT /F1 12 Tf 40 750 Td (PAY 100) Tj ET\nendstream\nendobj\n4 0 obj\n(PAY 900000)\nendobj\n`;
    const fullOuterBody = `${innerSmuggle}BT ET`;
    const smugglePdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R >>',
      '(PAY 100)',
      `<< /Length 6 0 R >>\nstream\n${fullOuterBody}\nendstream`,
      `${fullOuterBody.length}`,
    ]);
    expect(await parse('pdf_inspect', smugglePdf)).toMatchObject({ ok: false, code: 'invalid' });

    // 9. Compressed /Type /XRef + /ObjStm shadow / /Extends / lowercase-#xx obfuscation must fail closed.
    const validObjStmPdf = makeRawXrefStreamPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
      ],
      [{ num: 5, body: '<< /Title (OBJSTM_OK) >>' }],
      4,
      6,
    );
    expect(await parse('pdf_inspect', validObjStmPdf)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(validObjStmPdf).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 9a. Rogue top-level 5 0 obj overriding active /ObjStm entry 5 without xref update fails.
    const validObjStmStr = Buffer.from(validObjStmPdf).toString('latin1');
    const objStmShadowRaw = validObjStmStr.replace(
      '\nstartxref\n',
      '\n5 0 obj\n<< /Title (ROGUE_OVERRIDE) >>\nendobj\nstartxref\n',
    );
    expect(await parse('pdf_inspect', new Uint8Array(Buffer.from(objStmShadowRaw, 'latin1')))).toMatchObject({
      ok: false,
      code: 'invalid',
    });

    // 9b. Obfuscated lowercase #xx /Type /#4fbjStm (/Type /#6fbjStm) fails closed.
    const obfObjStmRaw = Buffer.from(
      makeRawXrefStreamPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
        ],
        [{ num: 5, body: '<<>>' }],
        4,
        6,
      ),
    )
      .toString('latin1')
      .replace('/Type /ObjStm', '/Type /#6fbjStm');
    expect(await parse('pdf_inspect', new Uint8Array(Buffer.from(obfObjStmRaw, 'latin1')))).toMatchObject({
      ok: false,
      code: 'invalid',
    });

    // 9c. /ObjStm carrying /Extends fails closed.
    const extendsObjStmRaw = Buffer.from(
      makeRawXrefStreamPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
        ],
        [{ num: 5, body: '<<>>' }],
        4,
        6,
      ),
    )
      .toString('latin1')
      .replace('/Type /ObjStm', '/Type /ObjStm /Extends 5 0 R');
    expect(await parse('pdf_inspect', new Uint8Array(Buffer.from(extendsObjStmRaw, 'latin1')))).toMatchObject({
      ok: false,
      code: 'invalid',
    });

    // 10. Legitimate incremental update: revision 2 updates object 4 AND xref + /Prev points to revision 2.
    const rev1Str = Buffer.from(buildContentPdf('ORIGINAL 100')).toString('latin1');
    const rev1StartXrefMatch = /startxref\n(\d+)\n%%EOF\n$/.exec(rev1Str);
    if (!rev1StartXrefMatch?.[1]) throw new Error('missing rev1 startxref');
    const rev1XrefOffset = Number.parseInt(rev1StartXrefMatch[1], 10);
    const updatedStream = 'BT\n/F1 12 Tf\n40 750 Td\n(AMENDED 200) Tj\nET\n';
    const obj4Rev2Offset = rev1Str.length;
    const rev2Obj = `4 0 obj\n<< /Length ${updatedStream.length} >>\nstream\n${updatedStream}\nendstream\nendobj\n`;
    const xref2Offset = obj4Rev2Offset + rev2Obj.length;
    const incrementalPdf = new TextEncoder().encode(
      `${rev1Str}${rev2Obj}xref\n4 1\n${String(obj4Rev2Offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${rev1XrefOffset} >>\nstartxref\n${xref2Offset}\n%%EOF\n`,
    );
    const incInspect = await parse('pdf_inspect', incrementalPdf);
    expect(incInspect).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    if (incInspect.ok && incInspect.kind === 'pdf_inspect') {
      expect(incInspect.pages[0]?.text).toContain('AMENDED 200');
      expect(incInspect.pages[0]?.text).not.toContain('ORIGINAL 100');
    }
    const incSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(incrementalPdf).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!incSealed.ok || incSealed.kind !== 'pdf_seal') {
      throw new Error(`expected incremental update seal to succeed, got: ${JSON.stringify(incSealed)}`);
    }
    const incReadBack = await readPdfBack(new Uint8Array(Buffer.from(incSealed.sealedPdfBase64, 'base64')));
    expect(incReadBack.pageTexts[0]).toContain('AMENDED 200');
    expect(incReadBack.pageTexts[0]).not.toContain('ORIGINAL 100');

    // 11. Linearized-layout /Prev pointing forward (Section 0 near top -> /Prev -> Section 1 near EOF).
    let linOut = '%PDF-1.4\n';
    const linOff1 = linOut.length;
    linOut += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    const linXref0Offset = linOut.length;
    const linSec0Placeholder =
      'xref\n0 2\n0000000000 65535 f \n' +
      `${String(linOff1).padStart(10, '0')} 00000 n \n` +
      'trailer\n<< /Size 5 /Root 1 0 R /Prev 0000000000 >>\nstartxref\n0\n%%EOF\n';
    linOut += linSec0Placeholder;
    const linOff2 = linOut.length;
    linOut += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
    const linOff3 = linOut.length;
    linOut += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n';
    const linOff4 = linOut.length;
    linOut += '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
    const linXref1Offset = linOut.length;
    linOut +=
      'xref\n2 3\n' +
      `${String(linOff2).padStart(10, '0')} 00000 n \n` +
      `${String(linOff3).padStart(10, '0')} 00000 n \n` +
      `${String(linOff4).padStart(10, '0')} 00000 n \n` +
      'trailer\n<< /Size 5 /Root 1 0 R >>\n' +
      `startxref\n${linXref0Offset}\n%%EOF\n`;
    const linFinal = linOut.replace('/Prev 0000000000', `/Prev ${String(linXref1Offset).padStart(10, '0')}`);
    const linBytes = new TextEncoder().encode(linFinal);
    expect(await parse('pdf_inspect', linBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(linBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });
  });

  it('enforces inspect/seal parity for PDFButton and unsigned /FT /Sig widgets and validates CheckBox OC streams', async () => {
    // 1. PDFButton with a non-PDFRef /AP /N sub-dictionary and invalid /OC fails BOTH inspectPdf and sealPdf consistently.
    const btnDictApDoc = await PDFDocument.create();
    const btnDictApPage = btnDictApDoc.addPage([595.28, 841.89]);
    const btnDictApForm = btnDictApDoc.getForm();
    const btnDictAp = btnDictApForm.createButton('submit_action');
    btnDictAp.addToPage('Submit', btnDictApPage, {
      font: await btnDictApDoc.embedFont(StandardFonts.Helvetica),
      x: 40,
      y: 620,
      width: 100,
      height: 30,
    });
    const subApRef = btnDictApDoc.context.register(
      btnDictApDoc.context.flateStream(Buffer.from('q Q', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: [0, 0, 100, 30],
      }),
    );
    const badOcDict = btnDictApDoc.context.obj({
      Type: PDFName.of('OCMD'),
      P: PDFName.of('AnyOn'),
      VE: 'invalid_not_array',
    });
    for (const widget of btnDictAp.acroField.getWidgets()) {
      widget.dict.set(PDFName.of('AS'), PDFName.of('Up'));
      widget.dict.set(PDFName.of('AP'), btnDictApDoc.context.obj({ N: { Up: subApRef } }));
      widget.dict.set(PDFName.of('OC'), badOcDict);
    }
    const btnDictApBytes = await btnDictApDoc.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', btnDictApBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(btnDictApBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Visible unsigned /FT /Sig widget without /AP /N agrees between inspectPdf and sealPdf (stripped cleanly).
    const sigNoApDoc = await PDFDocument.create();
    const sigNoApPage = sigNoApDoc.addPage([595.28, 841.89]);
    const sigWidgetRef = sigNoApDoc.context.register(
      sigNoApDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('sig_placeholder'),
        Rect: [40, 520, 180, 560],
        P: sigNoApPage.ref,
      }),
    );
    sigNoApPage.node.set(PDFName.of('Annots'), sigNoApDoc.context.obj([sigWidgetRef]));
    sigNoApDoc.catalog.set(PDFName.of('AcroForm'), sigNoApDoc.context.obj({ Fields: [sigWidgetRef] }));
    const sigNoApBytes = await sigNoApDoc.save();
    expect(await parse('pdf_inspect', sigNoApBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(sigNoApBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 2b. Unsigned /FT /Sig widget with a non-PDFRef /AP /N dict and invalid /OC also fails BOTH inspectPdf and sealPdf.
    const sigDictApBytes = await (async () => {
      const d = await PDFDocument.create();
      const p = d.addPage([595.28, 841.89]);
      const apR = d.context.register(
        d.context.flateStream(Buffer.from('q Q', 'latin1'), {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: [0, 0, 140, 40],
        }),
      );
      const wR = d.context.register(
        d.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Sig',
          T: PDFString.of('sig_bad_ap'),
          Rect: [40, 520, 180, 560],
          P: p.ref,
          AS: 'StateA',
          AP: { N: { StateA: apR } },
          OC: { Type: 'OCMD', P: 'AnyOn', VE: 'invalid_not_array' },
        }),
      );
      p.node.set(PDFName.of('Annots'), d.context.obj([wR]));
      d.catalog.set(PDFName.of('AcroForm'), d.context.obj({ Fields: [wR] }));
      return d.save({ updateFieldAppearances: false });
    })();
    expect(await parse('pdf_inspect', sigDictApBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(sigDictApBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Visible PDFButton with valid PDFRef /AP /N PDFStream succeeds in both inspectPdf and sealPdf.
    const btnOkDoc = await PDFDocument.create();
    const btnOkPage = btnOkDoc.addPage([595.28, 841.89]);
    const btnOkFont = await btnOkDoc.embedFont(StandardFonts.Helvetica);
    const btnOkForm = btnOkDoc.getForm();
    const btnOk = btnOkForm.createButton('btn_valid');
    btnOk.addToPage('SIGNED_BUTTON_AP', btnOkPage, {
      font: btnOkFont,
      x: 40,
      y: 620,
      width: 140,
      height: 30,
    });
    const btnOkBytes = await btnOkDoc.save();
    expect(await parse('pdf_inspect', btnOkBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const btnOkSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(btnOkBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(btnOkSealed).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 4a. CheckBox with NeedAppearances=true regenerates appearance, so unused /AP /N is not drawn by inspect or seal.
    const cbRegenDoc = await PDFDocument.create();
    const cbRegenPage = cbRegenDoc.addPage([595.28, 841.89]);
    const cbRegen = cbRegenDoc.getForm().createCheckBox('agree_regen');
    cbRegen.addToPage(cbRegenPage, { x: 40, y: 450, width: 16, height: 16 });
    cbRegen.check();
    const cbRegenWidget = cbRegen.acroField.getWidgets()[0];
    if (cbRegenWidget) {
      cbRegenWidget.dict.set(PDFName.of('AP'), cbRegenDoc.context.obj({ N: { Yes: cbOcDocStream(cbRegenDoc) } }));
    }
    cbRegenDoc.catalog.set(
      PDFName.of('AcroForm'),
      cbRegenDoc.context.obj({
        Fields: cbRegenDoc.getForm().acroForm.dict.get(PDFName.of('Fields')),
        NeedAppearances: true,
      }),
    );
    const cbRegenBytes = await cbRegenDoc.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', cbRegenBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(cbRegenBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 4b. CheckBox without NeedAppearances uses /AP /N directly, so broken /OC on /AP /N fails BOTH inspect and seal.
    const cbOcDoc = await PDFDocument.create();
    const cbOcPage = cbOcDoc.addPage([595.28, 841.89]);
    const cbOc = cbOcDoc.getForm().createCheckBox('agree_direct');
    cbOc.addToPage(cbOcPage, { x: 40, y: 450, width: 16, height: 16 });
    cbOc.check();
    const cbWidget = cbOc.acroField.getWidgets()[0];
    if (cbWidget) {
      cbWidget.dict.set(PDFName.of('AP'), cbOcDoc.context.obj({ N: { Yes: cbOcDocStream(cbOcDoc) } }));
    }
    const cbOcBytes = await cbOcDoc.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', cbOcBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(cbOcBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('decodes /Predictor XRef streams and rejects unsupported /ObjStm or invalid /Predictor parameters', async () => {
    const buildPredictedXrefPdf = (opts: {
      readonly w: readonly [number, number, number];
      readonly predictor: number;
      readonly mode: 'png-up' | 'png-mixed' | 'tiff' | 'raw-bytes';
      readonly rawOverride?: Buffer;
      readonly arrayPipeline?: boolean;
      readonly bodyText?: string;
    }): Uint8Array => {
      const chunks: Buffer[] = [Buffer.from('%PDF-1.5\n%\x80\x81\x82\x83\n', 'latin1')];
      const offsets: number[] = [];
      let cursor = chunks[0]?.length ?? 0;
      const pushStr = (s: string) => {
        const b = Buffer.from(s, 'latin1');
        chunks.push(b);
        cursor += b.length;
      };
      const pushBuf = (b: Buffer) => {
        chunks.push(b);
        cursor += b.length;
      };

      const objs = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
        `5 0 obj\n<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 40 720 Td (${opts.bodyText ?? 'PREDICTOR_OK'}) Tj ET`, 'latin1')} >>\nstream\nBT /F1 12 Tf 40 720 Td (${opts.bodyText ?? 'PREDICTOR_OK'}) Tj ET\nendstream\nendobj\n`,
      ];
      for (const objStr of objs) {
        offsets.push(cursor);
        pushStr(objStr);
      }
      const xrefOffset = cursor;
      const [w0, w1, w2] = opts.w;
      const entryWidth = w0 + w1 + w2;
      const writeUintBe = (buf: Buffer, off: number, width: number, val: number) => {
        let v = BigInt(val);
        for (let k = width - 1; k >= 0; k -= 1) {
          buf[off + k] = Number(v & 0xffn);
          v >>= 8n;
        }
      };

      const rows: Buffer[] = [];
      const makeRow = (type: number, f1: number, f2: number): Buffer => {
        const r = Buffer.alloc(entryWidth);
        writeUintBe(r, 0, w0, type);
        writeUintBe(r, w0, w1, f1);
        writeUintBe(r, w0 + w1, w2, f2);
        return r;
      };
      rows.push(makeRow(0, 0, 65535));
      for (const off of offsets) {
        rows.push(makeRow(1, off, 0));
      }
      rows.push(makeRow(1, xrefOffset, 0));

      let encodedPayload: Buffer;
      if (opts.rawOverride) {
        encodedPayload = opts.rawOverride;
      } else if (opts.mode === 'png-up') {
        const outRows: Buffer[] = [];
        let prev: Buffer = Buffer.alloc(entryWidth);
        for (const row of rows) {
          const enc = Buffer.alloc(1 + entryWidth);
          enc[0] = 2;
          for (let i = 0; i < entryWidth; i += 1) {
            enc[1 + i] = ((row[i] ?? 0) - (prev[i] ?? 0)) & 0xff;
          }
          outRows.push(enc);
          prev = row;
        }
        encodedPayload = Buffer.concat(outRows);
      } else if (opts.mode === 'png-mixed') {
        const outRows: Buffer[] = [];
        let prev: Buffer = Buffer.alloc(entryWidth);
        rows.forEach((row, idx) => {
          const tag = idx % 5;
          const enc = Buffer.alloc(1 + entryWidth);
          enc[0] = tag;
          for (let i = 0; i < entryWidth; i += 1) {
            const left = i >= 1 ? (row[i - 1] ?? 0) : 0;
            const up = prev[i] ?? 0;
            const upLeft = i >= 1 ? (prev[i - 1] ?? 0) : 0;
            let pred = 0;
            if (tag === 1) pred = left;
            else if (tag === 2) pred = up;
            else if (tag === 3) pred = (left + up) >> 1;
            else if (tag === 4) {
              const p = left + up - upLeft;
              const pa = Math.abs(p - left);
              const pb = Math.abs(p - up);
              const pc = Math.abs(p - upLeft);
              pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            enc[1 + i] = ((row[i] ?? 0) - pred) & 0xff;
          }
          outRows.push(enc);
          prev = row;
        });
        encodedPayload = Buffer.concat(outRows);
      } else {
        const outRows: Buffer[] = [];
        for (const row of rows) {
          const enc = Buffer.alloc(entryWidth);
          for (let i = 0; i < entryWidth; i += 1) {
            const prevByte = i >= 1 ? (row[i - 1] ?? 0) : 0;
            enc[i] = ((row[i] ?? 0) - prevByte) & 0xff;
          }
          outRows.push(enc);
        }
        encodedPayload = Buffer.concat(outRows);
      }

      const compressed = deflateSync(encodedPayload);
      const filterStr = opts.arrayPipeline ? '/Filter [/FlateDecode]' : '/Filter /FlateDecode';
      const parmsStr = opts.arrayPipeline
        ? `/DecodeParms [<< /Predictor ${opts.predictor} /Columns ${entryWidth} >>]`
        : `/DecodeParms << /Predictor ${opts.predictor} /Columns ${entryWidth} >>`;
      pushStr(
        `6 0 obj\n<< /Type /XRef /Size 7 /W [${w0} ${w1} ${w2}] /Root 1 0 R ${filterStr} ${parmsStr} /Length ${compressed.length} >>\nstream\n`,
      );
      pushBuf(compressed);
      pushStr(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
      return Buffer.concat(chunks);
    };

    // 1. PNG Up predictor (/Predictor 12 /Columns 7) passes inspect and seal cleanly.
    const pngUpBytes = buildPredictedXrefPdf({
      w: [1, 4, 2],
      predictor: 12,
      mode: 'png-up',
      bodyText: 'PNG12_OK',
    });
    expect(await parse('pdf_inspect', pngUpBytes)).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
      pages: [{ page: 1, text: expect.stringContaining('PNG12_OK') }],
    });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(pngUpBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 2. PNG Optimum (/Predictor 15 /Columns 7) exercising filter tags 0..4 and array /Filter + /DecodeParms.
    const pngMixedBytes = buildPredictedXrefPdf({
      w: [1, 4, 2],
      predictor: 15,
      mode: 'png-mixed',
      arrayPipeline: true,
      bodyText: 'PNG15_OK',
    });
    expect(await parse('pdf_inspect', pngMixedBytes)).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pages: [{ page: 1, text: expect.stringContaining('PNG15_OK') }],
    });

    // 3. TIFF Predictor 2 (/Predictor 2 /Columns 5) passes inspect cleanly.
    const tiffBytes = buildPredictedXrefPdf({
      w: [1, 2, 2],
      predictor: 2,
      mode: 'tiff',
      bodyText: 'TIFF2_OK',
    });
    expect(await parse('pdf_inspect', tiffBytes)).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pages: [{ page: 1, text: expect.stringContaining('TIFF2_OK') }],
    });

    // 4. Rejects unsupported Predictor value, invalid PNG row filter tag, and /Predictor on /ObjStm.
    const badPredBytes = buildPredictedXrefPdf({
      w: [1, 2, 2],
      predictor: 9,
      mode: 'tiff',
    });
    expect(await parse('pdf_inspect', badPredBytes)).toMatchObject({ ok: false, code: 'invalid' });

    const badPngTagBytes = buildPredictedXrefPdf({
      w: [1, 2, 2],
      predictor: 12,
      mode: 'raw-bytes',
      rawOverride: Buffer.from([9, 0, 0, 0, 0, 0]),
    });
    expect(await parse('pdf_inspect', badPngTagBytes)).toMatchObject({ ok: false, code: 'invalid' });

    const objStmPayload = deflateSync(Buffer.from('5 0\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'));
    const objStmBadPredBytes = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 8 >> /Length ${objStmPayload.length} >>\nstream\n${objStmPayload.toString('latin1')}\nendstream`,
    ]);
    expect(await parse('pdf_inspect', objStmBadPredBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(objStmBadPredBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects lowercase #xx hex escapes on structural trailer, xref, ObjStm, and stream /Length keys', async () => {
    const checkRejected = async (pdfBytes: Uint8Array) => {
      expect(await parse('pdf_inspect', pdfBytes)).toMatchObject({ ok: false, code: 'invalid' });
      expect(
        await parse(
          'pdf_seal',
          encodePdfSealInput({
            pdfBase64: Buffer.from(pdfBytes).toString('base64'),
            fields: [],
            certificate: makeCertificate(),
          }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    };

    // 1. /Le#6egth stream smuggling skipping past a hidden object (pdf-lib fails lowercase #6e, PDF.js decodes it).
    const smuggledStream =
      'BT /F1 12 Tf 40 720 Td (SAFE) Tj ET\nendstream\nendobj\n6 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\nstream\n';
    const escapedLenPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Le#6egth ${smuggledStream.length} >>\nstream\n${smuggledStream}endstream`,
    ]);
    await checkRejected(escapedLenPdf);

    // 2. Hybrid /XRefSt#6d trailer (lowercase #6d fails pdf-lib, PDF.js decodes it) with /Type /XRef.
    const hybridBase = Buffer.from(
      makeRawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      ]),
    ).toString('latin1');
    const escapedXrefStmPdf = Buffer.from(
      makeRawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
        `<< /Type /XRef /Size 5 /W [1 2 1] /Length 20 >>\nstream\n${'\x00'.repeat(20)}\nendstream`,
      ]),
    ).toString('latin1');
    const xrefObjStart = escapedXrefStmPdf.indexOf('4 0 obj');
    await checkRejected(
      Buffer.from(escapedXrefStmPdf.replace('trailer\n<<', `trailer\n<< /XRefSt#6d ${xrefObjStart}`), 'latin1'),
    );

    // 3. Lowercase escaped /R#6fot, /E#6ecrypt, and /Type /Cata#6cog.
    await checkRejected(Buffer.from(hybridBase.replace('/Root 1 0 R', '/R#6fot 1 0 R'), 'latin1'));
    await checkRejected(Buffer.from(hybridBase.replace('/Root 1 0 R', '/Root 1 0 R /E#6ecrypt 99 0 R'), 'latin1'));

    const escapedCatalogTypePdf = makeRawPdf([
      '<< /Type /Cata#6cog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ]);
    await checkRejected(escapedCatalogTypePdf);

    // 4. Escaped /I#6edex and nested /C#6flumns in XRef stream, plus /Type /Ob#6aStm in ObjStm.
    const xrefStreamRaw = Buffer.from(
      makeRawXrefStreamPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
        ],
        [{ num: 5, body: '<< /Title (OK) >>' }],
        4,
        6,
      ),
    ).toString('latin1');
    const escapedIndexPdf = Buffer.from(xrefStreamRaw.replace('/W [', '/I#6edex [0 7] /W ['), 'latin1');
    await checkRejected(escapedIndexPdf);
    const escapedNestedColumnsPdf = Buffer.from(
      xrefStreamRaw.replace('/W [', '/DecodeParms << /Predictor 1 /C#6flumns 5 >> /W ['),
      'latin1',
    );
    await checkRejected(escapedNestedColumnsPdf);

    const escapedObjStmPayload = deflateSync(Buffer.from('4 0\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'));
    const escapedObjStmPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      `<< /Type /Ob#6aStm /N 1 /First 4 /Filter /FlateDecode /Length ${escapedObjStmPayload.length} >>\nstream\n${escapedObjStmPayload.toString('latin1')}\nendstream`,
    ]);
    await checkRejected(escapedObjStmPdf);
  });

  it('enforces inspect/seal parity for AcroForm fallback text layout and widgets without /AP or /Rect', async () => {
    // 1. Oversized text inside a small AcroForm widget lacking /AP fails BOTH inspectPdf and sealPdf.
    const overflowFormDoc = await PDFDocument.create();
    const overflowPage = overflowFormDoc.addPage([595.28, 841.89]);
    const overflowField = overflowFormDoc.getForm().createTextField('overflow_text');
    overflowField.setText('WORD '.repeat(35));
    overflowField.addToPage(overflowPage, { x: 40, y: 700, width: 30, height: 10 });
    overflowField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));
    const overflowBytes = await overflowFormDoc.save({ updateFieldAppearances: false });

    expect(await parse('pdf_inspect', overflowBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(overflowBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Fallback AcroForm text field whose Vietnamese text fits passes BOTH inspectPdf and sealPdf.
    const fitFormDoc = await PDFDocument.create();
    const fitPage = fitFormDoc.addPage([595.28, 841.89]);
    const fitField = fitFormDoc.getForm().createTextField('fit_text');
    fitField.addToPage(fitPage, { x: 40, y: 700, width: 280, height: 32 });
    fitField.setText('Nguyễn Văn Ánh - Công ty TNHH');
    fitField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));
    const fitBytes = await fitFormDoc.save({ updateFieldAppearances: false });

    expect(await parse('pdf_inspect', fitBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    const fitSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(fitBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(fitSealed).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });
    if (fitSealed.ok && fitSealed.kind === 'pdf_seal') {
      const sealedBuf = Buffer.from(fitSealed.sealedPdfBase64, 'base64');
      const { extractText, getDocumentProxy } = await import('unpdf');
      const proxy = await getDocumentProxy(new Uint8Array(sealedBuf));
      const { text } = await extractText(proxy, { mergePages: false });
      expect(text[0]).toContain('Nguyễn Văn Ánh');
    }

    // 3. Unsigned /FT /Sig and /FT /Btn widgets lacking both /AP and /Rect pass BOTH inspectPdf and sealPdf.
    const noRectDoc = await PDFDocument.create();
    const noRectPage = noRectDoc.addPage([595.28, 841.89]);
    const sigNoRectRef = noRectDoc.context.register(
      noRectDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('sig_no_rect'),
        P: noRectPage.ref,
      }),
    );
    const btnNoRectRef = noRectDoc.context.register(
      noRectDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        Ff: 65536,
        T: PDFString.of('btn_no_rect'),
        P: noRectPage.ref,
      }),
    );
    noRectPage.node.set(PDFName.of('Annots'), noRectDoc.context.obj([sigNoRectRef, btnNoRectRef]));
    noRectDoc.catalog.set(PDFName.of('AcroForm'), noRectDoc.context.obj({ Fields: [sigNoRectRef, btnNoRectRef] }));
    const noRectAnnotsBytes = await noRectDoc.save();
    expect(await parse('pdf_inspect', noRectAnnotsBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(noRectAnnotsBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // Also when orphaned from page /Annots (linked only via /P).
    noRectPage.node.delete(PDFName.of('Annots'));
    const noRectOrphanBytes = await noRectDoc.save();
    expect(await parse('pdf_inspect', noRectOrphanBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(noRectOrphanBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal' });
  });

  it('keeps OCG /Usage /ViewState /OFF layers and /F 1 Invisible custom annotations hidden when flattening', async () => {
    // 1. OCG with /BaseState /ON (even listed in /D /ON) and /Usage << /View << /ViewState /OFF >> >> must stay hidden
    //    both on annotations and nested Form XObjects, without leaking unhidden text when /OC is stripped.
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const viewOffOcgRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('OCG'),
        Name: PDFString.of('ViewOffLayer'),
        Usage: { View: { ViewState: PDFName.of('OFF') } },
      }),
    );
    const viewOnOcgRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('OCG'),
        Name: PDFString.of('ViewOnLayer'),
        Usage: { View: { ViewState: PDFName.of('ON') } },
      }),
    );
    doc.catalog.set(
      PDFName.of('OCProperties'),
      doc.context.obj({
        OCGs: [viewOffOcgRef, viewOnOcgRef],
        D: { BaseState: PDFName.of('ON'), ON: [viewOffOcgRef, viewOnOcgRef] },
      }),
    );

    const makeFormAp = (label: string, ocRef?: PDFRef): PDFRef =>
      doc.context.register(
        doc.context.flateStream(Buffer.from(`BT\n/F1 10 Tf\n4 12 Td\n(${label}) Tj\nET\n`, 'latin1'), {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          FormType: 1,
          BBox: [0, 0, 220, 30],
          ...(ocRef ? { OC: ocRef } : {}),
          Resources: { Font: { F1: font.ref } },
        }),
      );

    const hiddenLayerAnnotRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [40, 720, 260, 750],
        F: 4,
        OC: viewOffOcgRef,
        AP: { N: makeFormAp('HIDDEN_VIEWSTATE_ANNOT') },
      }),
    );
    const hiddenChildXObjRef = makeFormAp('HIDDEN_VIEWSTATE_CHILD', viewOffOcgRef);
    const visibleChildXObjRef = makeFormAp('VISIBLE_VIEWSTATE_CHILD', viewOnOcgRef);
    const compositeApRef = doc.context.register(
      doc.context.flateStream(Buffer.from('/Vis Do\n/Hid Do\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 220, 30],
        OC: viewOnOcgRef,
        Resources: { XObject: { Vis: visibleChildXObjRef, Hid: hiddenChildXObjRef } },
      }),
    );
    const compositeAnnotRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [40, 670, 260, 700],
        F: 4,
        AP: { N: compositeApRef },
      }),
    );

    // 2. Custom annotation subtype (/Subtype /CustomMark) with /F 1 (Invisible) stays hidden on flatten,
    //    whereas standard subtype (/Subtype /Stamp) with /F 1 or custom subtype with /F 0 still renders.
    const invisibleCustomRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('CustomMark'),
        Rect: [40, 620, 260, 650],
        F: 1,
        AP: { N: makeFormAp('HIDDEN_CUSTOM_INVISIBLE') },
      }),
    );
    const visibleCustomRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('CustomMark'),
        Rect: [40, 570, 260, 600],
        F: 0,
        AP: { N: makeFormAp('VISIBLE_CUSTOM_CLEAR') },
      }),
    );
    const standardStampInvisibleFlagRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: [40, 520, 260, 550],
        F: 1,
        AP: { N: makeFormAp('VISIBLE_STAMP_STANDARD') },
      }),
    );

    page.node.set(
      PDFName.of('Annots'),
      doc.context.obj([
        hiddenLayerAnnotRef,
        compositeAnnotRef,
        invisibleCustomRef,
        visibleCustomRef,
        standardStampInvisibleFlagRef,
      ]),
    );

    const bytes = await doc.save({ useObjectStreams: false });
    expect(await parse('pdf_inspect', bytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected seal to succeed, got: ${JSON.stringify(sealed)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    const sealedVerifyDoc = await PDFDocument.load(sealedBytes);
    const flattenedXObjects = sealedVerifyDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(flattenedXObjects instanceof PDFDict)) {
      throw new Error('expected flattened XObjects dict on sealed page');
    }
    const decodedStrings: string[] = [];
    for (const [, rawRef] of flattenedXObjects.entries()) {
      const streamObj = sealedVerifyDoc.context.lookup(rawRef);
      if (!(streamObj instanceof PDFStream)) continue;
      const buf = decodePDFRawStream(streamObj as never).decode();
      decodedStrings.push(Buffer.from(buf).toString('latin1'));
      const res = streamObj.dict.lookup(PDFName.of('Resources'));
      if (res instanceof PDFDict) {
        const subXObjs = res.lookup(PDFName.of('XObject'));
        if (subXObjs instanceof PDFDict) {
          for (const [, subRaw] of subXObjs.entries()) {
            const subStream = sealedVerifyDoc.context.lookup(subRaw);
            if (subStream instanceof PDFStream) {
              decodedStrings.push(Buffer.from(decodePDFRawStream(subStream as never).decode()).toString('latin1'));
            }
          }
        }
      }
    }
    const allFlattenedText = decodedStrings.join('\n');
    expect(allFlattenedText).toContain('VISIBLE_VIEWSTATE_CHILD');
    expect(allFlattenedText).toContain('VISIBLE_CUSTOM_CLEAR');
    expect(allFlattenedText).toContain('VISIBLE_STAMP_STANDARD');
    expect(allFlattenedText).not.toContain('HIDDEN_VIEWSTATE_ANNOT');
    expect(allFlattenedText).not.toContain('HIDDEN_VIEWSTATE_CHILD');
    expect(allFlattenedText).not.toContain('HIDDEN_CUSTOM_INVISIBLE');

    const back = await readPdfBack(sealedBytes);
    expect(back.pageTexts[0]).toContain('VISIBLE_VIEWSTATE_CHILD');
    expect(back.pageTexts[0]).toContain('VISIBLE_CUSTOM_CLEAR');
    expect(back.pageTexts[0]).toContain('VISIBLE_STAMP_STANDARD');
    expect(back.pageTexts[0]).not.toContain('HIDDEN_VIEWSTATE_ANNOT');
    expect(back.pageTexts[0]).not.toContain('HIDDEN_VIEWSTATE_CHILD');
    expect(back.pageTexts[0]).not.toContain('HIDDEN_CUSTOM_INVISIBLE');

    // 3. Undeclared OCG with /Usage /ViewState /OFF (omitted from /OCProperties /OCGs) fails closed cleanly.
    const undeclaredDoc = await PDFDocument.create();
    const undeclaredPage = undeclaredDoc.addPage([595.28, 841.89]);
    const undeclaredFont = await undeclaredDoc.embedFont(StandardFonts.Helvetica);
    const undeclaredOcgRef = undeclaredDoc.context.register(
      undeclaredDoc.context.obj({
        Type: PDFName.of('OCG'),
        Name: PDFString.of('UndeclaredOff'),
        Usage: { View: { ViewState: PDFName.of('OFF') } },
      }),
    );
    const undeclaredApRef = undeclaredDoc.context.register(
      undeclaredDoc.context.flateStream(Buffer.from('BT\n/F1 10 Tf\n4 12 Td\n(AMBIGUOUS) Tj\nET\n', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        FormType: 1,
        BBox: [0, 0, 120, 30],
        Resources: { Font: { F1: undeclaredFont.ref } },
      }),
    );
    const undeclaredAnnotRef = undeclaredDoc.context.register(
      undeclaredDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [40, 700, 160, 730],
        F: 4,
        OC: undeclaredOcgRef,
        AP: { N: undeclaredApRef },
      }),
    );
    undeclaredPage.node.set(PDFName.of('Annots'), undeclaredDoc.context.obj([undeclaredAnnotRef]));
    const undeclaredBytes = await undeclaredDoc.save({ useObjectStreams: false });
    expect(await parse('pdf_inspect', undeclaredBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(undeclaredBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('keeps checkbox and text field stamps bounded within their requested box and rejects sub-4pt boxes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBase64 = Buffer.from(await doc.save()).toString('base64');

    // 1. Sub-4pt checkbox at page edge (0.999, 0.999, 0.001, 0.001) rejects instead of overflowing outside page bounds.
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64,
          fields: [{ type: 'checkbox', page: 1, xNorm: 0.999, yNorm: 0.999, wNorm: 0.001, hNorm: 0.001, checked: true }],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 2. Sub-4pt text box also rejects cleanly.
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64,
          fields: [{ type: 'text', page: 1, xNorm: 0.995, yNorm: 0.995, wNorm: 0.004, hNorm: 0.004, text: 'A' }],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Valid >= 4pt edge checkbox stays strictly within the requested [vx, vy, vw, vh] and page [0, 595.28] x [0, 841.89].
    const edgeRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64,
        fields: [{ type: 'checkbox', page: 1, xNorm: 0.99, yNorm: 0.99, wNorm: 0.01, hNorm: 0.01, checked: true }],
        certificate: makeCertificate(),
      }),
    );
    expect(edgeRes).toMatchObject({ ok: true, kind: 'pdf_seal' });
    if (edgeRes.ok && edgeRes.kind === 'pdf_seal') {
      const verifyDoc = await PDFDocument.load(new Uint8Array(Buffer.from(edgeRes.sealedPdfBase64, 'base64')));
      const contents = verifyDoc.getPage(0).node.Contents();
      if (!(contents instanceof PDFArray)) {
        throw new Error('expected page contents array');
      }
      const opsText = contents
        .asArray()
        .map((ref) => verifyDoc.context.lookup(ref))
        .filter((obj): obj is PDFStream => obj instanceof PDFStream)
        .map((stream) => Buffer.from(decodePDFRawStream(stream as never).decode()).toString('latin1'))
        .join('\n');
      const cmMatch = opsText.match(
        /([-\d.]+) w\s+\[\] 0 d\s+1 0 0 1 ([-\d.]+) ([-\d.]+) cm(?:\s+1 0 0 1 0 0 cm){2}\s+0 0 m\s+0 ([-\d.]+) l/,
      );
      expect(cmMatch).not.toBeNull();
      const borderW = Number(cmMatch?.[1]);
      const tx = Number(cmMatch?.[2]);
      const ty = Number(cmMatch?.[3]);
      const side = Number(cmMatch?.[4]);
      // Edge frame begins at x >= 0.99 * 595.28 = 589.3272 and bottom y >= 0, top <= 0.01 * 841.89 = 8.4189.
      expect(side).toBeGreaterThan(3);
      expect(tx - borderW / 2).toBeGreaterThanOrEqual(0.99 * 595.28);
      expect(tx + side + borderW / 2).toBeLessThanOrEqual(595.28);
      expect(ty - borderW / 2).toBeGreaterThanOrEqual(0);
      expect(ty + side + borderW / 2).toBeLessThanOrEqual(0.01 * 841.89);
    }
  });

  it('preserves literal /A#236a appearance selection without post-normalization double-decoding and rejects /ObjStm lowercase-#xx ambiguity', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);

    const makeApForm = (label: string) =>
      doc.context.register(
        doc.context.flateStream(`BT /F1 12 Tf 4 4 Td (${label}) Tj ET`, {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: doc.context.obj([0, 0, 140, 30]),
          Resources: doc.context.obj({ Font: { F1: helv.ref } }),
        }),
      );

    const evilApRef = makeApForm('PAY 999999');
    const goodApRef = makeApForm('PAY 100');
    const nStatesDict = doc.context.obj({});
    nStatesDict.set(PDFName.of('Aj'), evilApRef);
    nStatesDict.set(PDFName.of('A#236a'), goodApRef);

    const apDict = doc.context.obj({});
    apDict.set(PDFName.of('N'), nStatesDict);

    const annotDict = doc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Stamp'),
      Rect: doc.context.obj([50, 700, 190, 730]),
      F: PDFNumber.of(4),
      AP: apDict,
    });
    annotDict.set(PDFName.of('AS'), PDFName.of('A#236a'));
    const annotRef = doc.context.register(annotDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));

    const srcBytes = await doc.save({ useObjectStreams: false });
    const rawStr = Buffer.from(srcBytes).toString('latin1');
    expect(rawStr).toContain('/A#236a');

    const inspRes = await parse('pdf_inspect', srcBytes);
    expect(inspRes.ok).toBe(true);

    const sealInput: PdfSealInput = {
      pdfBase64: Buffer.from(srcBytes).toString('base64'),
      fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.4, hNorm: 0.08, text: 'SEAL_OK' }],
      certificate: makeCertificate(),
    };
    const sealRes = await parse('pdf_seal', encodePdfSealInput(sealInput));
    expect(sealRes.ok).toBe(true);
    if (!sealRes.ok || sealRes.kind !== 'pdf_seal') {
      throw new Error(`expected pdf_seal result, got: ${JSON.stringify(sealRes)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(sealRes.sealedPdfBase64, 'base64'));
    const back = await readPdfBack(sealedBytes);
    expect(back.pageTexts[0]).toContain('PAY 100');
    expect(back.pageTexts[0]).toContain('SEAL_OK');
    expect(back.pageTexts[0]).not.toContain('PAY 999999');

    // Compressed /ObjStm carrying a literal #23xx ambiguous with lowercase #xx must fail closed.
    const objStmAmbiguousPdf = makeRawXrefStreamPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /P 5 0 R >> >> >>' },
      ],
      [{ num: 5, body: '<< /Marker /A#236a >>' }],
      6,
      7,
    );
    expect(await parse('pdf_inspect', objStmAmbiguousPdf)).toMatchObject({ ok: false, code: 'invalid' });
    const objStmSeal = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(objStmAmbiguousPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.5, wNorm: 0.3, hNorm: 0.08, text: 'X' }],
        certificate: makeCertificate(),
      }),
    );
    expect(objStmSeal).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects unbalanced q/Q graphics state in page contents or Form XObjects and isolates valid no-newline or inline-image streams', async () => {
    const makeContentPdf = async (segments: readonly (string | Uint8Array)[]): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      const refs = segments.map((seg) => doc.context.register(doc.context.flateStream(seg)));
      page.node.set(PDFName.of('Contents'), refs.length === 1 ? refs[0]! : doc.context.obj(refs));
      return doc.save({ useObjectStreams: false });
    };

    const makeFormResourcePdf = async (formOps: string): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      const fmRef = doc.context.register(
        doc.context.flateStream(formOps, {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: doc.context.obj([0, 0, 100, 100]),
        }),
      );
      page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm1: fmRef } }));
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream('q /Fm1 Do Q\n')),
      );
      return doc.save({ useObjectStreams: false });
    };

    const makeAnnotApPdf = async (apOps: string): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      const apRef = doc.context.register(
        doc.context.flateStream(apOps, {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: doc.context.obj([0, 0, 80, 40]),
        }),
      );
      const annotRef = doc.context.register(
        doc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Stamp'),
          Rect: doc.context.obj([40, 700, 120, 740]),
          F: PDFNumber.of(4),
          AP: doc.context.obj({ N: apRef }),
        }),
      );
      page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
      return doc.save({ useObjectStreams: false });
    };

    const expectBothRejected = async (pdfBytes: Uint8Array): Promise<void> => {
      expect(await parse('pdf_inspect', pdfBytes)).toMatchObject({ ok: false, code: 'invalid' });
      const sealAttempt = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(pdfBytes).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.5, wNorm: 0.4, hNorm: 0.1, text: 'SHOULD_FAIL' }],
          certificate: makeCertificate(),
        }),
      );
      expect(sealAttempt).toMatchObject({ ok: false, code: 'invalid' });
    };

    await expectBothRejected(await makeContentPdf(['0 0 1 1 re W n q q q']));
    await expectBothRejected(await makeContentPdf(['Q 0 0 1 1 re W n']));
    await expectBothRejected(await makeContentPdf(['Q q']));
    await expectBothRejected(await makeContentPdf(['q 0 0 10 10 re ', 'q']));
    await expectBothRejected(await makeContentPdf(['Q ', 'q']));
    await expectBothRejected(await makeContentPdf(['q EI Q']));
    await expectBothRejected(await makeContentPdf(['BI /W 1 /H 1 /BPC 1 /CS /G ID Q']));
    await expectBothRejected(await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID EI\tQ']));
    await expectBothRejected(
      await makeContentPdf([
        'q BI /W 1 /H 1 /BPC 8 /CS /G /F /DCTDecode ID EI\tq (aaaaaaaaaaaaaa\xff\xd9\nEI) Q Q 0 0 1 1 re W n q Q',
      ]),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 8 /CS /G /F /DCTDecode ID \xff\xd8\xff\xe0\x00\x04\x00\x00\xff\xd9\nEI Q Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID EI Q (\x7f) Tj Q 0 0 1 1 re W n q q 0 EI Q']),
    );
    await expectBothRejected(await makeContentPdf(['q /OC /OffLayer BDC Q']));
    await expectBothRejected(await makeContentPdf(['/Tag BMC q Q']));
    await expectBothRejected(await makeContentPdf(['/Tag BMC EMC EMC']));
    await expectBothRejected(await makeContentPdf(['q BT 0 0 Td Q']));
    await expectBothRejected(await makeContentPdf(['BT BT ET ET']));
    await expectBothRejected(await makeContentPdf(['ET']));
    await expectBothRejected(await makeContentPdf(['q BX Q']));
    await expectBothRejected(await makeContentPdf(['EX']));
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI Q0 Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI qBT 0 0 m Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI - g Q Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI false0 0 Td Q Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf([Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EEI Q 0 0 m S q Q % EI Q Q', 'latin1')]),
    );
    await expectBothRejected(await makeContentPdf(['q Q0 Q']));
    await expectBothRejected(await makeContentPdf(['q 0Q Q']));
    await expectBothRejected(await makeContentPdf([Buffer.from('q \x80Q Q', 'latin1')]));
    await expectBothRejected(
      await makeContentPdf([
        Buffer.from(
          'q BI /W 1 /H 1 /BPC 8 /CS /G /F /G /F /DCTDecode ID \xff\xd8\xff\xe0\x00\x20EI (AAAAAAAAAAAAAAA) Tj Q % \xff\xd9 EI Q Q 0 0 0 0 re W n q',
          'latin1',
        ),
      ]),
    );
    await expectBothRejected(
      await makeContentPdf([
        Buffer.from(
          'q BI /W 1 /H 1 /BPC 8 /CS /G /Filter /G /F /DCTDecode ID \xff\xd8\xff\xe0\x00\x20EI (AAAAAAAAAAAAAAA) Tj Q % \xff\xd9 EI Q Q 0 0 0 0 re W n q',
          'latin1',
        ),
      ]),
    );
    await expectBothRejected(
      await makeContentPdf([
        Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G /F [ << /DCTDecode 1 >> ] ID \x00 EI Q Q 0 0 0 0 re W n q \xff\xd9\nEI Q', 'latin1'),
      ]),
    );
    await expectBothRejected(await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G /F [ 123 /DCTDecode ] ID \x00 EI Q']));
    await expectBothRejected(await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G /F false ID \x00 EI Q']));
    await expectBothRejected(await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G /F [] ID \x00 EI Q']));
    await expectBothRejected(
      await makeContentPdf(['BT /F1 12 Tf 72 700 Td (ORIGINAL_PAGE_TEXT) Tj ET q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI ) % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI +X Q Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI .Q Q Q 0 0 0 0 re W n q % EI Q']),
    );
    await expectBothRejected(
      await makeContentPdf([
        Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI -\x00 g Q Q 0 0 0 0 re W n q % EI Q', 'latin1'),
      ]),
    );
    await expectBothRejected(
      await makeContentPdf(['q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI 1 1 1 1 1 1 1 1 -X Q % EI Q']),
    );
    await expectBothRejected(await makeFormResourcePdf('Q 0 0 1 1 re W n'));
    await expectBothRejected(await makeFormResourcePdf('/OC /OffLayer BDC'));
    await expectBothRejected(await makeAnnotApPdf('q q'));
    await expectBothRejected(await makeAnnotApPdf('/OC /OffLayer BDC'));

    const complexValidCases: readonly (readonly Uint8Array[])[] = [
      [
        Buffer.from(
          'q /q /Q % q Q comment line\n(q Q \\(Q\\) \\\\ q) Tj <7151> Tj BI /W 1 /H 1 /BPC 1 /CS /G ID Q EI\nQ',
          'latin1',
        ),
      ],
      [Buffer.from('/Layer << /MCID 0 >> BDC q 0 0 10 10 re f Q EMC /P BMC BT ET EMC BX EX', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI false Q unknownOp EI\nQ', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI - g Q', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G /F [ /A85 ] ID z~> EI Q', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G /F /AHx /DecodeParms << /Bits 1 >> ID 00> EI Q', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EEI Q 0 0 m S % EI Q', 'latin1')],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI (Tiếng) Tj Q', 'utf8')],
      [
        Buffer.from(
          'q BI /W 1 /H 1 /BPC 8 /CS /G /F /DCTDecode ID \xff\xd8\xff\xfe\x00\x05abc\xff\xd9\nEI Q',
          'latin1',
        ),
      ],
      [Buffer.from('q BI /W 1 /H 1 /BPC 1 /CS /G ID \x00 EI unknownOp Q 0 0 m S EI\nQ', 'latin1')],
      [Buffer.from('q 0 0 1 1 re W n Q', 'latin1')],
      [Buffer.from('q 0 0 1 1 re W n Q % trailing comment without newline', 'latin1')],
      [Buffer.from('q 1 0 0 1 0 0 cm\n', 'latin1'), Buffer.from('0 0 50 50 re f\nQ\n', 'latin1')],
    ];

    for (const segments of complexValidCases) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      const refs = segments.map((seg) => doc.context.register(doc.context.flateStream(seg)));
      page.node.set(PDFName.of('Contents'), refs.length === 1 ? refs[0]! : doc.context.obj(refs));
      const validBytes = await doc.save({ useObjectStreams: false });
      expect(await parse('pdf_inspect', validBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
      const sealed = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(validBytes).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.6, hNorm: 0.1, text: 'STAMPED_OK_ĐẶNG_GIA' }],
          certificate: makeCertificate(),
        }),
      );
      expect(sealed.ok).toBe(true);
      if (!sealed.ok || sealed.kind !== 'pdf_seal') {
        throw new Error(`expected valid pdf_seal result, got: ${JSON.stringify(sealed)}`);
      }
      const sealedBack = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
      expect(sealedBack.pageTexts[0]).toContain('STAMPED_OK_ĐẶNG_GIA');
    }
  });

  it('dereferences indirect /Filter and /DecodeParms on content streams and Form XObjects while rejecting unbalanced or /XRef indirect filters', async () => {
    const buildWithIndirectContentFilter = async (opsText: string, usePredictor: boolean): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      const flateNameRef = doc.context.register(PDFName.of('FlateDecode'));
      const rawUtf8 = Buffer.from(opsText, 'latin1');

      let encodedBytes: Uint8Array;
      const streamDictEntries: Record<string, PDFRef> = {
        Filter: flateNameRef,
      };
      if (usePredictor) {
        // 1-byte columns with PNG Up (type 2): prepend filter byte 0 per row.
        const predicted = Buffer.alloc(rawUtf8.length * 2);
        for (let i = 0; i < rawUtf8.length; i += 1) {
          predicted[i * 2] = 0;
          predicted[i * 2 + 1] = rawUtf8[i]!;
        }
        encodedBytes = deflateSync(predicted);
        const colsRef = doc.context.register(PDFNumber.of(1));
        const parmsRef = doc.context.register(
          doc.context.obj({
            Predictor: PDFNumber.of(12),
            Columns: colsRef,
          }),
        );
        streamDictEntries.DecodeParms = parmsRef;
      } else {
        encodedBytes = deflateSync(rawUtf8);
      }

      const contentStream = PDFRawStream.of(doc.context.obj(streamDictEntries), encodedBytes);
      const formStream = PDFRawStream.of(
        doc.context.obj({
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: doc.context.obj([0, 0, 50, 50]),
          Filter: doc.context.obj([flateNameRef]),
        }),
        deflateSync(Buffer.from('q 0 0 10 10 re f Q\n', 'latin1')),
      );
      const fmRef = doc.context.register(formStream);
      page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm1: fmRef } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(contentStream));
      return doc.save({ useObjectStreams: false });
    };

    const validIndirectBytes = await buildWithIndirectContentFilter('q /Fm1 Do Q\n', true);
    expect(await parse('pdf_inspect', validIndirectBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(validIndirectBytes).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.4, wNorm: 0.5, hNorm: 0.08, text: 'INDIRECT_FILTER_OK' }],
        certificate: makeCertificate(),
      }),
    );
    expect(sealed.ok).toBe(true);
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected indirect filter pdf_seal success, got ${JSON.stringify(sealed)}`);
    }
    const sealedBack = await readPdfBack(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    expect(sealedBack.pageTexts[0]).toContain('INDIRECT_FILTER_OK');

    const unbalancedIndirect = await buildWithIndirectContentFilter('q /Fm1 Do\n', false);
    expect(await parse('pdf_inspect', unbalancedIndirect)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(unbalancedIndirect).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.4, wNorm: 0.5, hNorm: 0.08, text: 'FAIL' }],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // /XRef streams must keep forbidding indirect /Filter objects even when the referenced object is /FlateDecode.
    const buildXrefWithFilter = (directFilter: boolean): Uint8Array => {
      const header = Buffer.from('%PDF-1.5\n%\x80\x81\x82\x83\n', 'latin1');
      const baseObjs = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
        '4 0 obj\n/FlateDecode\nendobj\n',
      ];
      const offsets: number[] = [];
      const chunks: Buffer[] = [header];
      let cursor = header.length;
      for (const objStr of baseObjs) {
        offsets.push(cursor);
        const buf = Buffer.from(objStr, 'latin1');
        chunks.push(buf);
        cursor += buf.length;
      }
      const xrefOffset = cursor;
      const rows: Buffer[] = [];
      const rowFor = (type: number, off: number): Buffer => {
        const row = Buffer.alloc(5);
        row[0] = type;
        row.writeUIntBE(off, 1, 4);
        return row;
      };
      rows.push(rowFor(0, 0));
      for (const off of offsets) rows.push(rowFor(1, off));
      rows.push(rowFor(1, xrefOffset));
      const encodedXref = deflateSync(Buffer.concat(rows));
      const filterClause = directFilter ? '/Filter /FlateDecode' : '/Filter 4 0 R';
      chunks.push(
        Buffer.from(
          `5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 0] /Root 1 0 R ${filterClause} /Length ${encodedXref.length} >>\nstream\n`,
          'latin1',
        ),
        encodedXref,
        Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'),
      );
      return Buffer.concat(chunks);
    };
    expect(await parse('pdf_inspect', buildXrefWithFilter(true))).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    expect(await parse('pdf_inspect', buildXrefWithFilter(false))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('fits Vietnamese stacked diacritics inside tight edge boxes using embedded font glyph extents', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBase64 = Buffer.from(await doc.save({ useObjectStreams: false })).toString('base64');
    const hNorm = 12 / 841.89;

    const topEdgeSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64,
        fields: [
          { type: 'text', page: 1, xNorm: 0.05, yNorm: 0, wNorm: 0.3, hNorm, text: 'Ắ', fontSizePt: 12 },
          {
            type: 'text',
            page: 1,
            xNorm: 0.05,
            yNorm: (841.89 - 12) / 841.89,
            wNorm: 0.3,
            hNorm,
            text: 'Ặ',
            fontSizePt: 12,
          },
        ],
        certificate: makeCertificate(),
      }),
    );
    expect(topEdgeSealed.ok).toBe(true);
    if (!topEdgeSealed.ok || topEdgeSealed.kind !== 'pdf_seal') {
      throw new Error(`expected edge text seal success, got ${JSON.stringify(topEdgeSealed)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(topEdgeSealed.sealedPdfBase64, 'base64'));
    const verifyDoc = await PDFDocument.load(sealedBytes);
    const contents = verifyDoc.getPage(0).node.Contents();
    if (!(contents instanceof PDFArray)) {
      throw new Error('expected page contents array');
    }
    const opsText = contents
      .asArray()
      .map((ref) => verifyDoc.context.lookup(ref))
      .filter((obj): obj is PDFStream => obj instanceof PDFStream)
      .map((stream) => Buffer.from(decodePDFRawStream(stream as never).decode()).toString('latin1'))
      .join('\n');
    const matches = [...opsText.matchAll(/\/[\w-]+\s+([\d.]+)\s+Tf[\s\S]*?1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/g)];
    expect(matches).toHaveLength(2);

    // Top-edge field ('Ắ', maxY = 1166/1000 em): size shrinks below 12pt so top ink <= 841.89pt.
    const topFontSize = Number(matches[0]?.[1]);
    const topBaselineY = Number(matches[0]?.[3]);
    expect(topFontSize).toBeLessThan(12);
    expect(topBaselineY + (1166 / 1000) * topFontSize).toBeLessThanOrEqual(841.89 + 0.02);
    expect(topBaselineY).toBeGreaterThanOrEqual(841.89 - 12 - 0.02);

    // Bottom-edge field ('Ặ', maxY = 957/1000 em, minY = -227/1000 em): dot-below stays >= 0pt and top <= 12pt.
    const botFontSize = Number(matches[1]?.[1]);
    const botBaselineY = Number(matches[1]?.[3]);
    expect(botFontSize).toBeLessThan(12);
    expect(botBaselineY - (227 / 1000) * botFontSize).toBeGreaterThanOrEqual(-0.02);
    expect(botBaselineY + (957 / 1000) * botFontSize).toBeLessThanOrEqual(12 + 0.02);

    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).toContain('Ắ');
    expect(readBack.pageTexts[0]).toContain('Ặ');
  });

  it('isolates dangling paths and trailing comments without newline and accepts valid PDFNull dictionary entries', async () => {
    for (const trailingOps of [
      '0 0 595 842 re % trailing comment without newline',
      '0 0 595 842 re W % clip path without newline',
    ]) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream(Buffer.from(trailingOps, 'latin1'))),
      );
      page.node.set(PDFName.of('Metadata'), PDFNull);
      const srcBytes = await doc.save({ useObjectStreams: false });
      expect(await parse('pdf_inspect', srcBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });

      const sealedRes = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(srcBytes).toString('base64'),
          fields: [
            { type: 'checkbox', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.04, hNorm: 0.04, checked: true },
            { type: 'text', page: 1, xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.06, text: 'ISOLATED_OK' },
          ],
          certificate: makeCertificate(),
        }),
      );
      expect(sealedRes.ok).toBe(true);
      if (!sealedRes.ok || sealedRes.kind !== 'pdf_seal') {
        throw new Error(`expected pdf_seal success, got ${JSON.stringify(sealedRes)}`);
      }

      const sealedBytes = new Uint8Array(Buffer.from(sealedRes.sealedPdfBase64, 'base64'));
      const roundTripInspect = await parse('pdf_inspect', sealedBytes);
      expect(roundTripInspect).toMatchObject({ ok: true, kind: 'pdf_inspect' });
      if (!roundTripInspect.ok || roundTripInspect.kind !== 'pdf_inspect') {
        throw new Error(`expected inspect success, got ${JSON.stringify(roundTripInspect)}`);
      }
      expect(roundTripInspect.pages[0]?.text).toContain('ISOLATED_OK');

      const verifyDoc = await PDFDocument.load(sealedBytes);
      const contents = verifyDoc.getPage(0).node.Contents();
      if (!(contents instanceof PDFArray)) {
        throw new Error('expected page contents array after isolation');
      }
      const streamTexts = contents
        .asArray()
        .map((ref) => verifyDoc.context.lookup(ref))
        .filter((obj): obj is PDFStream => obj instanceof PDFStream)
        .map((stream) => Buffer.from(decodePDFRawStream(stream as never).decode()).toString('latin1'));
      const endPathIdx = streamTexts.findIndex((text) => text === '\nn\nQ\n');
      const danglingIdx = streamTexts.findIndex((text) => text.includes('0 0 595 842 re'));
      expect(danglingIdx).toBeGreaterThanOrEqual(0);
      expect(endPathIdx).toBeGreaterThan(danglingIdx);
      expect(streamTexts.slice(0, endPathIdx + 1).join('')).not.toContain('ISOLATED_OK');
    }

    // Compressed /ObjStm dictionary containing PDFNull entry (/Metadata null) must also succeed.
    const objStmDoc = await PDFDocument.create();
    const objStmPage = objStmDoc.addPage([595.28, 841.89]);
    objStmPage.node.set(PDFName.of('Metadata'), PDFNull);
    const objStmBytes = await objStmDoc.save({ useObjectStreams: true });
    expect(await parse('pdf_inspect', objStmBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const objStmSealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(objStmBytes).toString('base64'),
        fields: [{ type: 'checkbox', page: 1, xNorm: 0.1, yNorm: 0.5, wNorm: 0.04, hNorm: 0.04, checked: true }],
        certificate: makeCertificate(),
      }),
    );
    expect(objStmSealed.ok).toBe(true);
  });

  it('rejects dictionaries with duplicate keys after name normalization and preserves inspected content after sealing', async () => {
    const agreedStream = 'BT /F1 12 Tf 40 700 Td (AGREED_AMOUNT_100) Tj ET';
    const changedStream = 'BT /F1 12 Tf 40 700 Td (CHANGED_AMOUNT_900) Tj ET';
    const makeStreamObj = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;

    const collidingCases: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }> = [
      {
        name: 'page /Contents + /C#6fntents + /Contents',
        bytes: makeRawPdf([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /C#6fntents 6 0 R /Contents 5 0 R >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          makeStreamObj(agreedStream),
          makeStreamObj(changedStream),
        ]),
      },
      {
        name: 'page /Contents + /C#6fntents',
        bytes: makeRawPdf([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /C#6fntents 6 0 R >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          makeStreamObj(agreedStream),
          makeStreamObj(changedStream),
        ]),
      },
      {
        name: 'page /C#6fntents + /Co#6etents',
        bytes: makeRawPdf([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /C#6fntents 5 0 R /Co#6etents 6 0 R >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          makeStreamObj(agreedStream),
          makeStreamObj(changedStream),
        ]),
      },
      {
        name: 'resource font /Fj + /F#6a + /Fj',
        bytes: makeRawPdf([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /Fj 4 0 R /F#6a 4 0 R /Fj 4 0 R >> >> /Contents 5 0 R >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          makeStreamObj('BT /Fj 12 Tf 40 700 Td (AGREED_AMOUNT_100) Tj ET'),
        ]),
      },
      {
        name: 'trailer /Info + /I#6efo + /Info',
        bytes: makeRawPdf(
          [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            makeStreamObj(agreedStream),
            '<< /Producer (Ludy) >>',
          ],
          '/Info 6 0 R /I#6efo 6 0 R /Info 6 0 R',
        ),
      },
    ];

    for (const testCase of collidingCases) {
      const inspectRes = await parse('pdf_inspect', testCase.bytes);
      expect(inspectRes.ok, `expected pdf_inspect rejection for ${testCase.name}`).toBe(false);

      const sealRes = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(testCase.bytes).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.4, hNorm: 0.06, text: 'SEALED' }],
          certificate: makeCertificate(),
        }),
      );
      expect(sealRes.ok, `expected pdf_seal rejection for ${testCase.name}`).toBe(false);
    }

    // Valid source PDF content must remain intact before and after sealing.
    const cleanPdfBytes = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      makeStreamObj(agreedStream),
    ]);
    const beforeInspect = await parse('pdf_inspect', cleanPdfBytes);
    expect(beforeInspect.ok).toBe(true);
    if (!beforeInspect.ok || beforeInspect.kind !== 'pdf_inspect') {
      throw new Error('expected clean PDF inspection to pass');
    }
    expect(beforeInspect.pages[0]?.text).toContain('AGREED_AMOUNT_100');

    const sealedClean = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(cleanPdfBytes).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.5, wNorm: 0.5, hNorm: 0.06, text: 'SIGNED_BY_PARTY_A' }],
        certificate: makeCertificate(),
      }),
    );
    expect(sealedClean.ok).toBe(true);
    if (!sealedClean.ok || sealedClean.kind !== 'pdf_seal') {
      throw new Error('expected clean PDF sealing to pass');
    }
    const afterInspect = await parse('pdf_inspect', new Uint8Array(Buffer.from(sealedClean.sealedPdfBase64, 'base64')));
    expect(afterInspect.ok).toBe(true);
    if (!afterInspect.ok || afterInspect.kind !== 'pdf_inspect') {
      throw new Error('expected sealed PDF re-inspection to pass');
    }
    expect(afterInspect.pages[0]?.text).toContain(beforeInspect.pages[0]?.text ?? '');
    expect(afterInspect.pages[0]?.text).toContain('SIGNED_BY_PARTY_A');
    expect(afterInspect.pages[0]?.text).not.toContain('CHANGED_AMOUNT_900');
  });

  it('rejects conflicting checkbox/radio /V vs /AS states and subdict annotations missing /AS', async () => {
    const makeApTextForm = async (doc: PDFDocument, label: string): Promise<PDFRef> => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      return doc.context.register(
        doc.context.flateStream(Buffer.from(`BT /F1 10 Tf 2 4 Td (${label}) Tj ET`, 'latin1'), {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          FormType: 1,
          BBox: [0, 0, 80, 20],
          Resources: { Font: { F1: font.ref } },
        }),
      );
    };

    const expectInspectAndSealReject = async (label: string, bytes: Uint8Array): Promise<void> => {
      const inspectRes = await parse('pdf_inspect', bytes);
      expect(inspectRes.ok, `expected pdf_inspect rejection for ${label}`).toBe(false);
      const sealRes = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(bytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      );
      expect(sealRes.ok, `expected pdf_seal rejection for ${label}`).toBe(false);
    };

    // 1. CheckBox with /AS /Yes, /V /Off and valid /AP /N streams (must reject instead of silently flipping to Off).
    const cbConflictDoc1 = await PDFDocument.create();
    const cbConflictPage1 = cbConflictDoc1.addPage([595.28, 841.89]);
    const cbYesAp = await makeApTextForm(cbConflictDoc1, 'CB_ON_YES');
    const cbOffAp = await makeApTextForm(cbConflictDoc1, 'CB_OFF');
    const cbWidget1Ref = cbConflictDoc1.context.register(
      cbConflictDoc1.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: PDFString.of('agree_box'),
        Rect: [50, 700, 130, 720],
        P: cbConflictPage1.ref,
        V: PDFName.of('Off'),
        AS: PDFName.of('Yes'),
        AP: { N: { Yes: cbYesAp, Off: cbOffAp } },
      }),
    );
    cbConflictPage1.node.set(PDFName.of('Annots'), cbConflictDoc1.context.obj([cbWidget1Ref]));
    cbConflictDoc1.catalog.set(
      PDFName.of('AcroForm'),
      cbConflictDoc1.context.obj({ Fields: [cbWidget1Ref] }),
    );
    await expectInspectAndSealReject(
      'checkbox /AS /Yes with /V /Off',
      await cbConflictDoc1.save({ updateFieldAppearances: false }),
    );

    // 2. CheckBox with /V /Yes and /AS /Off (reverse conflict) must also fail both inspect and seal.
    const cbConflictDoc2 = await PDFDocument.create();
    const cbConflictPage2 = cbConflictDoc2.addPage([595.28, 841.89]);
    const cbYesAp2 = await makeApTextForm(cbConflictDoc2, 'CB_ON_YES');
    const cbOffAp2 = await makeApTextForm(cbConflictDoc2, 'CB_OFF');
    const cbWidget2Ref = cbConflictDoc2.context.register(
      cbConflictDoc2.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: PDFString.of('agree_box_rev'),
        Rect: [50, 700, 130, 720],
        P: cbConflictPage2.ref,
        V: PDFName.of('Yes'),
        AS: PDFName.of('Off'),
        AP: { N: { Yes: cbYesAp2, Off: cbOffAp2 } },
      }),
    );
    cbConflictPage2.node.set(PDFName.of('Annots'), cbConflictDoc2.context.obj([cbWidget2Ref]));
    cbConflictDoc2.catalog.set(
      PDFName.of('AcroForm'),
      cbConflictDoc2.context.obj({ Fields: [cbWidget2Ref] }),
    );
    await expectInspectAndSealReject(
      'checkbox /V /Yes with /AS /Off',
      await cbConflictDoc2.save({ updateFieldAppearances: false }),
    );

    // 3. Non-widget Stamp annotation with /AP /N subdict << /State1 stream >> and missing /AS must be rejected.
    const stampDoc = await PDFDocument.create();
    const stampPage = stampDoc.addPage([595.28, 841.89]);
    const stampStateAp = await makeApTextForm(stampDoc, 'HIDDEN_STAMP_STATE1');
    const stampRef = stampDoc.context.register(
      stampDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: [50, 620, 180, 660],
        AP: { N: { State1: stampStateAp } },
      }),
    );
    stampPage.node.set(PDFName.of('Annots'), stampDoc.context.obj([stampRef]));
    await expectInspectAndSealReject(
      'stamp /AP /N subdict missing /AS',
      await stampDoc.save({ useObjectStreams: false }),
    );

    // 4. RadioGroup with /V /OptA while all widgets report /AS /Off (and reverse /V /Off with /AS /OptA) must reject.
    const radioConflictDoc = await PDFDocument.create();
    const radioPage = radioConflictDoc.addPage([595.28, 841.89]);
    const rOn = await makeApTextForm(radioConflictDoc, 'R_ON');
    const rOff = await makeApTextForm(radioConflictDoc, 'R_OFF');
    const rgDict = radioConflictDoc.context.obj({
      FT: PDFName.of('Btn'),
      Ff: 1 << 15,
      T: PDFString.of('choice_group'),
      V: PDFName.of('OptA'),
      Kids: [],
    });
    const rgRef = radioConflictDoc.context.register(rgDict);
    const rwRef = radioConflictDoc.context.register(
      radioConflictDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: rgRef,
        Rect: [50, 560, 70, 580],
        P: radioPage.ref,
        AS: PDFName.of('Off'),
        AP: { N: { OptA: rOn, Off: rOff } },
      }),
    );
    rgDict.set(PDFName.of('Kids'), radioConflictDoc.context.obj([rwRef]));
    radioPage.node.set(PDFName.of('Annots'), radioConflictDoc.context.obj([rwRef]));
    radioConflictDoc.catalog.set(
      PDFName.of('AcroForm'),
      radioConflictDoc.context.obj({ Fields: [rgRef] }),
    );
    await expectInspectAndSealReject(
      'radio /V /OptA with all widgets /AS /Off',
      await radioConflictDoc.save({ updateFieldAppearances: false }),
    );

    // 5. Consistent checkbox without /V (only /AS /Yes + NeedAppearances) preserves original /AS /Yes appearance cleanly.
    const cbAsOnlyDoc = await PDFDocument.create();
    const cbAsOnlyPage = cbAsOnlyDoc.addPage([595.28, 841.89]);
    const asOnlyYes = await makeApTextForm(cbAsOnlyDoc, 'CB_AS_ONLY_YES');
    const asOnlyOff = await makeApTextForm(cbAsOnlyDoc, 'CB_AS_ONLY_OFF');
    const cbAsOnlyRef = cbAsOnlyDoc.context.register(
      cbAsOnlyDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: PDFString.of('as_only_box'),
        Rect: [50, 500, 130, 520],
        P: cbAsOnlyPage.ref,
        AS: PDFName.of('Yes'),
        AP: { N: { Yes: asOnlyYes, Off: asOnlyOff } },
      }),
    );
    cbAsOnlyPage.node.set(PDFName.of('Annots'), cbAsOnlyDoc.context.obj([cbAsOnlyRef]));
    cbAsOnlyDoc.catalog.set(
      PDFName.of('AcroForm'),
      cbAsOnlyDoc.context.obj({ Fields: [cbAsOnlyRef] }),
    );
    const cbAsOnlyBytes = await cbAsOnlyDoc.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', cbAsOnlyBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealedAsOnly = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(cbAsOnlyBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(sealedAsOnly.ok).toBe(true);
    if (!sealedAsOnly.ok || sealedAsOnly.kind !== 'pdf_seal') {
      throw new Error('expected consistent /AS /Yes checkbox seal to pass');
    }
    const afterAsOnly = await readPdfBack(new Uint8Array(Buffer.from(sealedAsOnly.sealedPdfBase64, 'base64')));
    expect(afterAsOnly.pageTexts[0]).toContain('CB_AS_ONLY_YES');
    expect(afterAsOnly.pageTexts[0]).not.toContain('CB_AS_ONLY_OFF');

    // 6. /Opt RadioGroup state flip (/Opt [(Safe) (Trap)], /V /1, W0 /AS /0, W1 /AS /Off) must reject.
    const optRadioDoc = await PDFDocument.create();
    const optRadioPage = optRadioDoc.addPage([595.28, 841.89]);
    const r0SafeOn = await makeApTextForm(optRadioDoc, 'R0_SAFE_ON');
    const r0Off = await makeApTextForm(optRadioDoc, 'R0_OFF');
    const r1TrapOn = await makeApTextForm(optRadioDoc, 'R1_TRAP_ON');
    const r1Off = await makeApTextForm(optRadioDoc, 'R1_OFF');
    const optRadioParentRef = optRadioDoc.context.nextRef();
    const optW0Ref = optRadioDoc.context.register(
      optRadioDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: optRadioParentRef,
        Rect: [50, 440, 140, 460],
        P: optRadioPage.ref,
        AS: PDFName.of('0'),
        AP: { N: { '0': r0SafeOn, Off: r0Off } },
      }),
    );
    const optW1Ref = optRadioDoc.context.register(
      optRadioDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: optRadioParentRef,
        Rect: [160, 440, 250, 460],
        P: optRadioPage.ref,
        AS: PDFName.of('Off'),
        AP: { N: { '1': r1TrapOn, Off: r1Off } },
      }),
    );
    const optRadioParentDict = optRadioDoc.context.obj({
      FT: PDFName.of('Btn'),
      Ff: 1 << 15,
      T: PDFString.of('opt_radio_trap'),
      Opt: [PDFString.of('Safe'), PDFString.of('Trap')],
      V: PDFName.of('1'),
      Kids: [optW0Ref, optW1Ref],
    });
    optRadioDoc.context.assign(optRadioParentRef, optRadioParentDict);
    optRadioPage.node.set(PDFName.of('Annots'), optRadioDoc.context.obj([optW0Ref, optW1Ref]));
    optRadioDoc.catalog.set(
      PDFName.of('AcroForm'),
      optRadioDoc.context.obj({ Fields: [optRadioParentRef] }),
    );
    await expectInspectAndSealReject(
      'opt radio /V /1 with W0 /AS /0 and W1 /AS /Off',
      await optRadioDoc.save({ updateFieldAppearances: false }),
    );

    // 7. Same /Opt RadioGroup with /V /0 while all widgets report /AS /Off must reject.
    optRadioParentDict.set(PDFName.of('V'), PDFName.of('0'));
    (optRadioDoc.context.lookup(optW0Ref) as PDFDict).set(PDFName.of('AS'), PDFName.of('Off'));
    await expectInspectAndSealReject(
      'opt radio /V /0 with all widgets /AS /Off',
      await optRadioDoc.save({ updateFieldAppearances: false }),
    );

    // 8. Swapped-index /Opt RadioGroup (/V /0, W0 /AS /Off, W1 /AS /0) must reject.
    (optRadioDoc.context.lookup(optW1Ref) as PDFDict).set(
      PDFName.of('AP'),
      optRadioDoc.context.obj({ N: { '0': r1TrapOn, Off: r1Off } }),
    );
    (optRadioDoc.context.lookup(optW1Ref) as PDFDict).set(PDFName.of('AS'), PDFName.of('0'));
    await expectInspectAndSealReject(
      'opt radio /V /0 with swapped widget 1 /AS /0',
      await optRadioDoc.save({ updateFieldAppearances: false }),
    );

    // 9. CheckBox with /Opt [(Agree)], /V /Yes, and conflicting /AS /AltOn must reject.
    const optCbDoc = await PDFDocument.create();
    const optCbPage = optCbDoc.addPage([595.28, 841.89]);
    const cbAltOn = await makeApTextForm(optCbDoc, 'CB_ALT_ON');
    const cbAltOff = await makeApTextForm(optCbDoc, 'CB_ALT_OFF');
    const optCbRef = optCbDoc.context.register(
      optCbDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: PDFString.of('opt_cb_conflict'),
        Opt: [PDFString.of('Agree')],
        V: PDFName.of('Yes'),
        Rect: [50, 400, 140, 420],
        P: optCbPage.ref,
        AS: PDFName.of('AltOn'),
        AP: { N: { AltOn: cbAltOn, Off: cbAltOff } },
      }),
    );
    optCbPage.node.set(PDFName.of('Annots'), optCbDoc.context.obj([optCbRef]));
    optCbDoc.catalog.set(
      PDFName.of('AcroForm'),
      optCbDoc.context.obj({ Fields: [optCbRef] }),
    );
    await expectInspectAndSealReject(
      'opt checkbox /V /Yes with /AS /AltOn',
      await optCbDoc.save({ updateFieldAppearances: false }),
    );

    // 10. Consistent /Opt RadioGroup (/V /1, W0 /AS /Off, W1 /AS /ChoiceB) preserves W1 ON cleanly.
    const optValidDoc = await PDFDocument.create();
    const optValidPage = optValidDoc.addPage([595.28, 841.89]);
    const vr0On = await makeApTextForm(optValidDoc, 'VR0_ON');
    const vr0Off = await makeApTextForm(optValidDoc, 'VR0_OFF');
    const vr1On = await makeApTextForm(optValidDoc, 'VR1_ON');
    const vr1Off = await makeApTextForm(optValidDoc, 'VR1_OFF');
    const optValidParentRef = optValidDoc.context.nextRef();
    const optValidW0Ref = optValidDoc.context.register(
      optValidDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: optValidParentRef,
        Rect: [50, 360, 140, 380],
        P: optValidPage.ref,
        AS: PDFName.of('Off'),
        AP: { N: { ChoiceA: vr0On, Off: vr0Off } },
      }),
    );
    const optValidW1Ref = optValidDoc.context.register(
      optValidDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        Parent: optValidParentRef,
        Rect: [160, 360, 250, 380],
        P: optValidPage.ref,
        AS: PDFName.of('ChoiceB'),
        AP: { N: { ChoiceB: vr1On, Off: vr1Off } },
      }),
    );
    const optValidParentDict = optValidDoc.context.obj({
      FT: PDFName.of('Btn'),
      Ff: 1 << 15,
      T: PDFString.of('opt_radio_valid'),
      Opt: [PDFString.of('Safe'), PDFString.of('Trap')],
      V: PDFName.of('1'),
      Kids: [optValidW0Ref, optValidW1Ref],
    });
    optValidDoc.context.assign(optValidParentRef, optValidParentDict);
    optValidPage.node.set(PDFName.of('Annots'), optValidDoc.context.obj([optValidW0Ref, optValidW1Ref]));
    optValidDoc.catalog.set(
      PDFName.of('AcroForm'),
      optValidDoc.context.obj({ Fields: [optValidParentRef] }),
    );
    const optValidBytes = await optValidDoc.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', optValidBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealedOptValid = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(optValidBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealedOptValid.ok || sealedOptValid.kind !== 'pdf_seal') {
      throw new Error(`expected consistent /Opt radio seal to pass, got: ${JSON.stringify(sealedOptValid)}`);
    }
    const afterOptValid = await readPdfBack(new Uint8Array(Buffer.from(sealedOptValid.sealedPdfBase64, 'base64')));
    expect(afterOptValid.pageTexts[0]).toContain('VR0_OFF');
    expect(afterOptValid.pageTexts[0]).not.toContain('VR0_ON');
    expect(afterOptValid.pageTexts[0]).toContain('VR1_ON');
    expect(afterOptValid.pageTexts[0]).not.toContain('VR1_OFF');
  });

  it('preserves all visible options and selection highlights when flattening PDFOptionList without /AP and fails closed on overflowing listboxes', async () => {
    // 1. Selected listbox missing /AP (NeedAppearances=true) must keep both Monthly Plan and Annual Plan + highlight rect.
    const doc1 = await PDFDocument.create();
    const page1 = doc1.addPage([595.28, 841.89]);
    const form1 = doc1.getForm();
    const list1 = form1.createOptionList('plan_list');
    list1.addOptions(['Monthly Plan', 'Annual Plan']);
    list1.select('Monthly Plan');
    list1.addToPage(page1, { x: 40, y: 650, width: 200, height: 64 });
    const list1Widget = list1.acroField.getWidgets()[0];
    if (!list1Widget) throw new Error('missing list1 widget');
    list1Widget.dict.delete(PDFName.of('AP'));
    doc1.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

    const bytes1 = await doc1.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', bytes1)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealed1 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes1).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed1.ok || sealed1.kind !== 'pdf_seal') {
      throw new Error(`expected option list seal to pass, got: ${JSON.stringify(sealed1)}`);
    }
    const sealedBytes1 = new Uint8Array(Buffer.from(sealed1.sealedPdfBase64, 'base64'));
    const readBack1 = await readPdfBack(sealedBytes1);
    expect(readBack1.pageTexts[0]).toContain('Monthly Plan');
    expect(readBack1.pageTexts[0]).toContain('Annual Plan');

    // Confirm a selected-row highlight fill was emitted alongside the box border/background.
    const checkDoc1 = await PDFDocument.load(sealedBytes1);
    const contents1 = checkDoc1.getPage(0).node.Contents();
    if (!(contents1 instanceof PDFArray)) throw new Error('expected page contents array');
    let ops1 = '';
    for (let i = 0; i < contents1.size(); i += 1) {
      const st = checkDoc1.context.lookup(contents1.get(i));
      if (st instanceof PDFStream) {
        ops1 += Buffer.from(decodePDFRawStream(st as never).decode()).toString('latin1');
      }
    }
    expect(ops1).toMatch(/0\.6\s+0\.756\d*\s+0\.854\d*\s+rg/);

    // 2. Unselected paired [export, display] listbox with missing /AP preserves all Vietnamese display rows with zero highlight.
    const doc2 = await PDFDocument.create();
    const page2 = doc2.addPage([595.28, 841.89]);
    const form2 = doc2.getForm();
    const list2 = form2.createOptionList('tier_list');
    list2.addOptions(['BASIC', 'PRO']);
    list2.addToPage(page2, { x: 40, y: 600, width: 240, height: 64 });
    list2.acroField.dict.set(
      PDFName.of('Opt'),
      doc2.context.obj([
        [PDFString.of('BASIC'), PDFHexString.fromText('Gói cơ bản')],
        [PDFString.of('PRO'), PDFHexString.fromText('Gói chuyên nghiệp')],
      ]),
    );
    const list2Widget = list2.acroField.getWidgets()[0];
    if (!list2Widget) throw new Error('missing list2 widget');
    list2Widget.dict.delete(PDFName.of('AP'));

    const bytes2 = await doc2.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', bytes2)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealed2 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes2).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed2.ok || sealed2.kind !== 'pdf_seal') {
      throw new Error(`expected unselected option list seal to pass, got: ${JSON.stringify(sealed2)}`);
    }
    const sealedBytes2 = new Uint8Array(Buffer.from(sealed2.sealedPdfBase64, 'base64'));
    const readBack2 = await readPdfBack(sealedBytes2);
    expect(readBack2.pageTexts[0]).toContain('Gói cơ bản');
    expect(readBack2.pageTexts[0]).toContain('Gói chuyên nghiệp');

    // 3. Overflowing scrollable listbox missing /AP (20 options in 24pt height) fails closed in both inspect and seal.
    const doc3 = await PDFDocument.create();
    const page3 = doc3.addPage([595.28, 841.89]);
    const form3 = doc3.getForm();
    const list3 = form3.createOptionList('overflow_list');
    list3.addOptions(Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`));
    list3.select('Option 1');
    list3.addToPage(page3, { x: 40, y: 600, width: 180, height: 24 });
    const list3Widget = list3.acroField.getWidgets()[0];
    if (!list3Widget) throw new Error('missing list3 widget');
    list3Widget.dict.delete(PDFName.of('AP'));

    const bytes3 = await doc3.save({ updateFieldAppearances: false });
    expect(await parse('pdf_inspect', bytes3)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(bytes3).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('keeps shared /AP streams alive when scrubbing password fields while pruning unshared secrets', async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();

    const sharedApRef = doc.context.register(
      doc.context.flateStream(
        Buffer.from('BT /F1 11 Tf 4 7 Td (SHARED_NORMAL_VALUE) Tj ET', 'latin1'),
        {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, 200, 24],
          Resources: { Font: { F1: helv.ref } },
        },
      ),
    );
    const sharedApDictRef = doc.context.register(doc.context.obj({ N: sharedApRef }));

    const normalField = form.createTextField('normal_shared_ap');
    normalField.setText('IGNORED_DEFAULT_VALUE');
    normalField.addToPage(page, { x: 40, y: 740, width: 200, height: 24 });
    const normalWidget = normalField.acroField.getWidgets()[0];
    if (!normalWidget) throw new Error('missing normal widget');
    normalWidget.dict.set(PDFName.of('AP'), doc.context.obj({ N: sharedApRef }));

    const pwShared = form.createTextField('pw_shared_ap');
    pwShared.enablePassword();
    pwShared.addToPage(page, { x: 40, y: 700, width: 200, height: 24 });
    const pwSharedWidget = pwShared.acroField.getWidgets()[0];
    if (!pwSharedWidget) throw new Error('missing pwShared widget');
    const pwSharedSecret = 'INDIRECT-PW-SECRET-111';
    pwShared.acroField.dict.set(PDFName.of('V'), doc.context.register(PDFString.of(pwSharedSecret)));
    pwShared.acroField.dict.set(PDFName.of('DV'), doc.context.register(PDFString.of('INDIRECT-PW-DEFAULT-222')));
    pwShared.acroField.dict.set(PDFName.of('RV'), doc.context.register(PDFString.of('<p>INDIRECT-PW-RICH-333</p>')));
    pwSharedWidget.dict.set(PDFName.of('AP'), doc.context.obj({ N: sharedApRef }));

    const pwUnshared = form.createTextField('pw_unshared_ap');
    pwUnshared.enablePassword();
    pwUnshared.addToPage(page, { x: 40, y: 660, width: 200, height: 24 });
    const pwUnsharedWidget = pwUnshared.acroField.getWidgets()[0];
    if (!pwUnsharedWidget) throw new Error('missing pwUnshared widget');
    const pwUnsharedSecret = 'UNSHARED-PW-SECRET-444';
    pwUnshared.acroField.dict.set(PDFName.of('V'), doc.context.register(PDFString.of(pwUnsharedSecret)));
    const unsharedApRef = doc.context.register(
      doc.context.flateStream(
        Buffer.from('BT /F1 11 Tf 4 7 Td (UNSHARED_PW_STREAM_SECRET_555) Tj ET', 'latin1'),
        {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, 200, 24],
          Resources: { Font: { F1: helv.ref } },
        },
      ),
    );
    pwUnsharedWidget.dict.set(PDFName.of('AP'), doc.context.obj({ N: unsharedApRef }));

    // Orphaned non-AcroForm password widget + normal annotation sharing an indirect /AP dict ref.
    const orphanPwAnnotRef = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: PDFString.of('orphan_pw'),
        Ff: 1 << 13,
        Rect: [40, 620, 240, 644],
        V: doc.context.register(PDFString.of('ORPHAN-PW-SECRET-666')),
        AP: sharedApDictRef,
      }),
    );
    const squareSharedAnnotRef = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [300, 620, 500, 644],
        AP: sharedApDictRef,
      }),
    );
    page.node.addAnnot(orphanPwAnnotRef);
    page.node.addAnnot(squareSharedAnnotRef);

    const inputBytes = await doc.save({ updateFieldAppearances: false });
    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(inputBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!res.ok || res.kind !== 'pdf_seal') {
      throw new Error(`expected shared /AP password seal to succeed, got: ${JSON.stringify(res)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const readBack = await readPdfBack(sealedBytes);
    const pageText = readBack.pageTexts[0] ?? '';
    expect(pageText).toContain('SHARED_NORMAL_VALUE');
    expect(pageText).toContain('*'.repeat(pwSharedSecret.length));
    expect(pageText).toContain('*'.repeat(pwUnsharedSecret.length));

    const sealedDoc = await PDFDocument.load(sealedBytes);
    const xObjectDict = sealedDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    expect(xObjectDict).toBeDefined();
    let flatWidgetCount = 0;
    let flatAnnotCount = 0;
    for (const [key, rawRef] of xObjectDict?.entries() ?? []) {
      const resolved = sealedDoc.context.lookup(rawRef);
      expect(resolved).toBeInstanceOf(PDFStream);
      const name = key.decodeText();
      if (name.startsWith('FlatWidget')) flatWidgetCount += 1;
      if (name.startsWith('FlatAnnot')) flatAnnotCount += 1;
    }
    expect(flatWidgetCount).toBeGreaterThanOrEqual(1);
    expect(flatAnnotCount).toBeGreaterThanOrEqual(1);

    await assertNoSecretInSealedPdf(sealedBytes, [
      pwSharedSecret,
      'INDIRECT-PW-DEFAULT-222',
      'INDIRECT-PW-RICH-333',
      pwUnsharedSecret,
      'UNSHARED_PW_STREAM_SECRET_555',
      'ORPHAN-PW-SECRET-666',
    ]);
  });

  it('rejects indirect /Length + nested stream/endstream desync hiding lowercase #xx active names, while allowing safe literal # names', async () => {
    // Variant A: backward indirect /Length (5 0 obj before 6 0 obj) + nested stream endstream + % )
    const streamBodyBack = 'stream endstream\n(aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(Buffer.byteLength(streamBodyBack, 'latin1')).toBe(46);
    const pdfBackward = rebuildAsciiXref(
      [
        '%PDF-1.4',
        '2 0 obj',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        'endobj',
        '3 0 obj',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>',
        'endobj',
        '5 0 obj',
        '46',
        'endobj',
        '6 0 obj',
        `<< /Length 5 0 R >>\nstream\n${streamBodyBack}\nendstream`,
        'endobj',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R /Open#61ction << /S /Java#73cript /JS (app.alert(1)) >> /XRefHook 4 0 R >>',
        'endobj',
        '4 0 obj',
        '% )',
        '<< /Note (close comment trap) >>',
        'endobj',
        '7 0 obj',
        '<< /Length 0 >>\nstream\n\nendstream',
        'endobj',
        'xref',
        '0 1',
        '0000000000 65535 f ',
        'trailer',
        '<< /Size 8 /Root 1 0 R >>',
        'startxref',
        '0',
        '%%EOF',
      ].join('\n'),
    );

    const inspectBack = await parse('pdf_inspect', pdfBackward);
    expect(inspectBack.ok).toBe(false);
    if (!inspectBack.ok) {
      expect(inspectBack.code).toBe('invalid');
    }

    const sealBack = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfBackward).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(pdfBackward).digest('hex') }),
      }),
    );
    expect(sealBack.ok).toBe(false);
    if (!sealBack.ok) {
      expect(sealBack.code).toBe('invalid');
    }

    // Variant B: forward indirect /Length (5 0 obj AFTER 6 0 obj) with nested stream endstream + % )
    const streamBodyForward = 'stream endstream\n(bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(Buffer.byteLength(streamBodyForward, 'latin1')).toBe(46);
    const pdfForward = rebuildAsciiXref(
      [
        '%PDF-1.4',
        '2 0 obj',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        'endobj',
        '3 0 obj',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>',
        'endobj',
        '6 0 obj',
        `<< /Length 5 0 R >>\nstream\n${streamBodyForward}\nendstream`,
        'endobj',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R /Open#61ction << /S /Java#53cript /JS (app.alert(2)) >> >>',
        'endobj',
        '4 0 obj',
        '% )',
        '<< /Note (close comment trap) >>',
        'endobj',
        '5 0 obj',
        '46',
        'endobj',
        '7 0 obj',
        '<< /Length 4 >>\nstream\nq\nQ\n\nendstream',
        'endobj',
        'xref',
        '0 1',
        '0000000000 65535 f ',
        'trailer',
        '<< /Size 8 /Root 1 0 R >>',
        'startxref',
        '0',
        '%%EOF',
      ].join('\n'),
    );

    const inspectForward = await parse('pdf_inspect', pdfForward);
    expect(inspectForward.ok).toBe(false);
    if (!inspectForward.ok) {
      expect(inspectForward.code).toBe('invalid');
    }

    const sealForward = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfForward).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(pdfForward).digest('hex') }),
      }),
    );
    expect(sealForward.ok).toBe(false);
    if (!sealForward.ok) {
      expect(sealForward.code).toBe('invalid');
    }

    // Safe control: a literal '#23' name outside /ObjStm (/Im#2361) and a forward-indirect-/Length
    // Form XObject stream pass both inspect and seal cleanly via pass-2 length resolution.
    const safeContent = 'q /Im#2361 Do Q\n';
    const upstreamForm = 'q\n% forward length form note\nQ\n';
    const safeLiteralHashPdf = rebuildAsciiXref(
      [
        '%PDF-1.4',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R >>',
        'endobj',
        '2 0 obj',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        'endobj',
        '3 0 obj',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im#2361 4 0 R >> >> /Contents 5 0 R >>',
        'endobj',
        '4 0 obj',
        `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 6 0 R >>\nstream\n${upstreamForm}\nendstream`,
        'endobj',
        '5 0 obj',
        `<< /Length ${Buffer.byteLength(safeContent, 'latin1')} >>\nstream\n${safeContent}\nendstream`,
        'endobj',
        '6 0 obj',
        `${Buffer.byteLength(upstreamForm, 'latin1')}`,
        'endobj',
        'xref',
        '0 1',
        '0000000000 65535 f ',
        'trailer',
        '<< /Size 7 /Root 1 0 R >>',
        'startxref',
        '0',
        '%%EOF',
      ].join('\n'),
    );
    const inspectSafe = await parse('pdf_inspect', safeLiteralHashPdf);
    expect(inspectSafe.ok).toBe(true);
    const sealSafe = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(safeLiteralHashPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'OK' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(safeLiteralHashPdf).digest('hex') }),
      }),
    );
    expect(sealSafe.ok).toBe(true);
  });

  it('rejects GoToR/GoToE/3D/EmbeddedFiles/AF/Collection/FileAttachment and unsafe URI schemes while stripping Outlines/Names/safe Catalog URI', async () => {
    const forbiddenCases: Array<{ label: string; build: () => Uint8Array }> = [
      {
        label: 'GoToR action',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /GoToR /F (remote.pdf) /D [0 /Fit] >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'GoToE action',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /GoToE /T << /R /C /N (child) >> >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'GoTo3DView action',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /GoTo3DView /TA 4 0 R >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
            '<< /Note (placeholder) >>',
          ]),
      },
      {
        label: 'Rendition action',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Rendition /OP 0 >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'Thread action',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Thread /F (doc.pdf) >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'EmbeddedFiles dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [] >> >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'AF dict key on page',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /AF [] >>',
          ]),
      },
      {
        label: 'Collection dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Collection << /View /D >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'EF Filespec dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Dests << /FileSpec << /Type /Filespec /F (a.txt) /EF << /F 4 0 R >> >> >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
            '<< /Type /EmbeddedFile /Length 3 >>\nstream\nabc\nendstream',
          ]),
      },
      {
        label: '3DD dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Extra << /3DD 4 0 R >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
            '<< /Length 0 >>\nstream\n\nendstream',
          ]),
      },
      {
        label: '3DA dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Extra << /3DA << /AIS /L >> >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: '3DV dict key',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /Extra << /3DV << /IN (Default) >> >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: '3D annotation subtype',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /3D /Rect [0 0 100 100] >>',
          ]),
      },
      {
        label: 'Invisible FileAttachment annotation subtype',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /FileAttachment /F 1 /Rect [0 0 100 100] /Contents (payload) >>',
          ]),
      },
      {
        label: 'file: URI scheme',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (file:///etc/passwd) >> >>',
          ]),
      },
      {
        label: 'smb: URI scheme',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (smb://attacker/share) >> >>',
          ]),
      },
      {
        label: 'ms-msdt: URI scheme',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (ms-msdt:/id PCWDiagnostic) >> >>',
          ]),
      },
      {
        label: 'UNC path URI',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (\\\\\\\\attacker\\\\share\\\\doc) >> >>',
          ]),
      },
      {
        label: 'Catalog URI /Base file: scheme',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R /URI << /Base (file:///etc/passwd) >> >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          ]),
      },
      {
        label: 'UTF-16BE BOM hidden file: URI',
        build: () =>
          makeRawPdf([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI <FEFF00660069006C0065003A002F002F002F006500740063> >> >>',
          ]),
      },
    ];

    for (const tc of forbiddenCases) {
      const pdfBytes = tc.build();
      const inspectRes = await parse('pdf_inspect', pdfBytes);
      expect(inspectRes.ok, `pdf_inspect should reject ${tc.label}`).toBe(false);
      if (!inspectRes.ok) {
        expect(inspectRes.code, `pdf_inspect invalid code for ${tc.label}`).toBe('invalid');
      }

      const sealRes = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(pdfBytes).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(pdfBytes).digest('hex') }),
        }),
      );
      expect(sealRes.ok, `pdf_seal should reject ${tc.label}`).toBe(false);
      if (!sealRes.ok) {
        expect(sealRes.code, `pdf_seal invalid code for ${tc.label}`).toBe('invalid');
      }
    }

    // Benign Outlines + Catalog /Names /Dests + Catalog /URI (https) + https Link annotation:
    // accepted on inspect, and cleanly stripped + pruned on seal.
    const benignOutlineMarker = 'STRIPPED_OUTLINE_MARKER_991';
    const benignLinkMarker = 'STRIPPED_HTTPS_LINK_MARKER_992';
    const benignPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /Names << /Dests << >> >> /URI << /Base (https://ludy.example/) >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [5 0 R] >>',
      `<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >>`,
      `<< /Type /Annot /Subtype /Link /Rect [10 10 120 40] /A << /S /URI /URI (https://ludy.example/docs?ref=${benignLinkMarker}) >> >>`,
      `<< /Title (${benignOutlineMarker}) /Parent 4 0 R /Dest [3 0 R /Fit] >>`,
    ]);

    const inspectBenign = await parse('pdf_inspect', benignPdf);
    expect(inspectBenign.ok).toBe(true);

    const sealBenign = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(benignPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.4, hNorm: 0.08, text: 'Signed OK' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(benignPdf).digest('hex') }),
      }),
    );
    expect(sealBenign.ok).toBe(true);
    if (!sealBenign.ok || sealBenign.kind !== 'pdf_seal') throw new Error('expected pdf_seal result');

    const sealedBytes = new Uint8Array(Buffer.from(sealBenign.sealedPdfBase64, 'base64'));
    const sealedDoc = await PDFDocument.load(sealedBytes);
    for (const key of ['Outlines', 'Names', 'EmbeddedFiles', 'AF', 'Collection', 'URI', 'AcroForm']) {
      expect(sealedDoc.catalog.get(PDFName.of(key)), `Catalog /${key} should be stripped`).toBeUndefined();
    }
    expect(sealedDoc.getPage(0).node.get(PDFName.of('Annots'))).toBeUndefined();
    expect(sealedDoc.getPage(0).node.get(PDFName.of('AF'))).toBeUndefined();
    await assertNoSecretInSealedPdf(sealedBytes, [benignOutlineMarker, benignLinkMarker]);
  });

  it('rejects /Contents segments that desync under either raw byte concatenation (PDF.js) or newline stream boundaries', async () => {
    // Variant A: per-stream/newline boundary pops Q out of q wrapper when s1 ends in a %comment without newline.
    const badSeg1 = '%comment';
    const badSeg2 = 'Q\n2 0 0 2 0 0 cm\nq';
    const badSeg3 = '\nQ';
    const badPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R 6 0 R] >>',
      `<< /Length ${Buffer.byteLength(badSeg1, 'latin1')} >>\nstream\n${badSeg1}\nendstream`,
      `<< /Length ${Buffer.byteLength(badSeg2, 'latin1')} >>\nstream\n${badSeg2}\nendstream`,
      `<< /Length ${Buffer.byteLength(badSeg3, 'latin1')} >>\nstream\n${badSeg3}\nendstream`,
    ]);

    // Variant B: raw byte concatenation (PDF.js StreamsSequenceStream) swallows EMC into s1's %comment, leaving /OC BDC open.
    const ocSeg1 = '/OC /Hidden BDC\n%comment';
    const ocSeg2 = 'EMC';
    const ocSwallowPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Hidden << /Type /OCG /Name (Hidden) >> >> >> /Contents [4 0 R 5 0 R] >>',
      `<< /Length ${Buffer.byteLength(ocSeg1, 'latin1')} >>\nstream\n${ocSeg1}\nendstream`,
      `<< /Length ${Buffer.byteLength(ocSeg2, 'latin1')} >>\nstream\n${ocSeg2}\nendstream`,
    ]);

    // Variant C: cross-segment token merging (/A + Q -> /AQ) leaves 0-size clip open over sealed fields in PDF.js.
    const mergeClipSeg1 = 'q\n0 0 0 0 re W n\nq\nq\nq\n/A';
    const mergeClipSeg2 = 'Q\n/B';
    const mergeClipSeg3 = 'Q\n/C';
    const mergeClipSeg4 = 'Q\nQ';
    const mergeClipPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R 6 0 R 7 0 R] >>',
      `<< /Length ${Buffer.byteLength(mergeClipSeg1, 'latin1')} >>\nstream\n${mergeClipSeg1}\nendstream`,
      `<< /Length ${Buffer.byteLength(mergeClipSeg2, 'latin1')} >>\nstream\n${mergeClipSeg2}\nendstream`,
      `<< /Length ${Buffer.byteLength(mergeClipSeg3, 'latin1')} >>\nstream\n${mergeClipSeg3}\nendstream`,
      `<< /Length ${Buffer.byteLength(mergeClipSeg4, 'latin1')} >>\nstream\n${mergeClipSeg4}\nendstream`,
    ]);

    // Variant D: equal final depth (0) under both raw and newline joins, yet middle BT..ET executes inside clip in PDF.js.
    const diffDepthZero1 = 'q\n0 0 0 0 re W n\n/A';
    const diffDepthZero2 = 'Q\nBT\n/F1 12 Tf\n(CLAUSE) Tj\nET\n/B';
    const diffDepthZero3 = 'q\nQ';
    const diffDepthZeroPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R 6 0 R] >>',
      `<< /Length ${Buffer.byteLength(diffDepthZero1, 'latin1')} >>\nstream\n${diffDepthZero1}\nendstream`,
      `<< /Length ${Buffer.byteLength(diffDepthZero2, 'latin1')} >>\nstream\n${diffDepthZero2}\nendstream`,
      `<< /Length ${Buffer.byteLength(diffDepthZero3, 'latin1')} >>\nstream\n${diffDepthZero3}\nendstream`,
    ]);

    // Variant E: empty middle stream bridging token merge (/A + "" + Q) and CTM comment swallow (1 0 0 1 0 0\n%x + cm).
    const emptyBridgePdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R 6 0 R] >>',
      '<< /Length 4 >>\nstream\nq\n/A\nendstream',
      '<< /Length 0 >>\nstream\n\nendstream',
      '<< /Length 1 >>\nstream\nQ\nendstream',
    ]);
    const commentCtmPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R] >>',
      '<< /Length 16 >>\nstream\nq\n1 0 0 1 0 0\n%x\nendstream',
      '<< /Length 4 >>\nstream\ncm\nQ\nendstream',
    ]);

    for (const maliciousPdf of [badPdf, ocSwallowPdf, mergeClipPdf, diffDepthZeroPdf, emptyBridgePdf, commentCtmPdf]) {
      const inspectBad = await parse('pdf_inspect', maliciousPdf);
      expect(inspectBad.ok).toBe(false);
      if (!inspectBad.ok) {
        expect(inspectBad.code).toBe('invalid');
      }

      const sealBad = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(maliciousPdf).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(maliciousPdf).digest('hex') }),
        }),
      );
      expect(sealBad.ok).toBe(false);
      if (!sealBad.ok) {
        expect(sealBad.code).toBe('invalid');
      }
    }

    // Valid multi-segment /Contents where comments end with a newline before the next stream.
    const okSeg1 = '%leading-segment-comment\n';
    const okSeg2 = 'q\n1 0 0 1 0 0 cm\nQ\n';
    const okPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R] >>',
      `<< /Length ${Buffer.byteLength(okSeg1, 'latin1')} >>\nstream\n${okSeg1}\nendstream`,
      `<< /Length ${Buffer.byteLength(okSeg2, 'latin1')} >>\nstream\n${okSeg2}\nendstream`,
    ]);

    const inspectOk = await parse('pdf_inspect', okPdf);
    expect(inspectOk.ok).toBe(true);
    const sealOk = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(okPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'OK' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(okPdf).digest('hex') }),
      }),
    );
    expect(sealOk.ok).toBe(true);
  });

  it('validates graphics and /OC balance inside Type3 /CharProcs, Type3 /Resources, /Pattern streams, and /ExtGState /SMask /G', async () => {
    const type3BadGlyph = '600 0 d0 /OC /Hide BDC\n';
    const type3PageStream = 'BT /T3 12 Tf 72 700 Td (a) Tj ET\n';
    const type3BadGlyphPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << /BaseState /ON /OFF [7 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Hide 7 0 R >> /Font << /T3 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(type3PageStream, 'latin1')} >>\nstream\n${type3PageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3BadGlyph, 'latin1')} >>\nstream\n${type3BadGlyph}\nendstream`,
      '<< /Type /OCG /Name (Hide) >>',
    ]);

    const type3NestedFormStream = 'q 0 0 10 10 re f\n';
    const type3GoodGlyph = '600 0 d0 /Fm1 Do\n';
    const type3NestedFormPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /T3 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Resources << /XObject << /Fm1 7 0 R >> >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(type3PageStream, 'latin1')} >>\nstream\n${type3PageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3GoodGlyph, 'latin1')} >>\nstream\n${type3GoodGlyph}\nendstream`,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${Buffer.byteLength(type3NestedFormStream, 'latin1')} >>\nstream\n${type3NestedFormStream}\nendstream`,
    ]);

    const badPatternStream = 'q /OC /Hide BDC 0 0 10 10 re f Q\n';
    const patternPageStream = '/Pattern cs /P1 scn 0 0 20 20 re f\n';
    const badPatternPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /BaseState /ON /OFF [6 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Hide 6 0 R >> /Pattern << /P1 4 0 R >> >> /Contents 5 0 R >>',
      `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Length ${Buffer.byteLength(badPatternStream, 'latin1')} >>\nstream\n${badPatternStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(patternPageStream, 'latin1')} >>\nstream\n${patternPageStream}\nendstream`,
      '<< /Type /OCG /Name (Hide) >>',
    ]);

    const badSmaskGroupStream = 'q 1 g 0 0 10 10 re f\n';
    const smaskPageStream = '/GS1 gs 0 0 20 20 re f\n';
    const badSmaskPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /ExtGState << /GS1 << /Type /ExtGState /SMask << /Type /Mask /S /Alpha /G 4 0 R >> >> >> >> /Contents 5 0 R >>',
      `<< /Type /XObject /Subtype /Form /Group << /Type /Group /S /Transparency >> /BBox [0 0 10 10] /Length ${Buffer.byteLength(badSmaskGroupStream, 'latin1')} >>\nstream\n${badSmaskGroupStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(smaskPageStream, 'latin1')} >>\nstream\n${smaskPageStream}\nendstream`,
    ]);

    for (const badResourcePdf of [type3BadGlyphPdf, type3NestedFormPdf, badPatternPdf, badSmaskPdf]) {
      const inspectBad = await parse('pdf_inspect', badResourcePdf);
      expect(inspectBad.ok).toBe(false);
      if (!inspectBad.ok) {
        expect(inspectBad.code).toBe('invalid');
      }

      const sealBad = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(badResourcePdf).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(badResourcePdf).digest('hex') }),
        }),
      );
      expect(sealBad.ok).toBe(false);
      if (!sealBad.ok) {
        expect(sealBad.code).toBe('invalid');
      }
    }

    // Benign control: balanced Type3 glyph (with cyclic /Resources back-reference), balanced Pattern, and balanced ExtGState /SMask /G.
    const okType3Glyph = '600 0 d0 0 0 400 700 re f\n';
    const okPatternBody = 'q 0 0 10 10 re f Q\n';
    const okSmaskBody = 'q 1 g 0 0 10 10 re f Q\n';
    const okComboPage = 'q BT /T3 12 Tf 72 700 Td (a) Tj ET /GS1 gs /Pattern cs /P1 scn 0 0 20 20 re f Q\n';
    const okResourcesPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 8 0 R >>',
      '<< /Font << /T3 5 0 R >> /Pattern << /P1 6 0 R >> /ExtGState << /GS1 << /Type /ExtGState /SMask << /Type /Mask /S /Alpha /G 7 0 R >> >> >> >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 9 0 R >> /Resources 4 0 R /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Length ${Buffer.byteLength(okPatternBody, 'latin1')} >>\nstream\n${okPatternBody}\nendstream`,
      `<< /Type /XObject /Subtype /Form /Group << /Type /Group /S /Transparency >> /BBox [0 0 10 10] /Length ${Buffer.byteLength(okSmaskBody, 'latin1')} >>\nstream\n${okSmaskBody}\nendstream`,
      `<< /Length ${Buffer.byteLength(okComboPage, 'latin1')} >>\nstream\n${okComboPage}\nendstream`,
      `<< /Length ${Buffer.byteLength(okType3Glyph, 'latin1')} >>\nstream\n${okType3Glyph}\nendstream`,
    ]);

    const inspectOkRes = await parse('pdf_inspect', okResourcesPdf);
    expect(inspectOkRes.ok).toBe(true);
    const sealOkRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(okResourcesPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'OK' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(okResourcesPdf).digest('hex') }),
      }),
    );
    expect(sealOkRes.ok).toBe(true);
  });

  it('prevents visitedDicts role aliasing on shared dicts and checks /ExtGState /Font Type3 references', async () => {
    const type3BadGlyph = '600 0 d0 q 0 0 0 0 re W n /OC /Hide BDC\n';
    const type3PageStream = 'BT /T3 12 Tf 72 700 Td (a) Tj ET\n';
    const gsPageStream = 'BT /GS1 gs 72 700 Td (a) Tj ET\n';

    // Variant A: Page /Resources and Type3 /Font share the exact same indirect dict (4 0 obj).
    const polyPageResAndFont = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << /BaseState /ON /OFF [7 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /Properties << /Hide 7 0 R >> /Font << /T3 4 0 R >> /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(type3PageStream, 'latin1')} >>\nstream\n${type3PageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3BadGlyph, 'latin1')} >>\nstream\n${type3BadGlyph}\nendstream`,
      '<< /Type /OCG /Name (Hide) >>',
    ]);

    // Variant B: Type3 /Font self-references itself as /Resources 4 0 R with an unbalanced /XObject /Fm1.
    const type3OkGlyph = '600 0 d0 /Fm1 Do\n';
    const badNestedForm = 'q 0 0 10 10 re W n\n';
    const polyFontSelfResources = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /T3 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Resources 4 0 R /XObject << /Fm1 7 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(type3PageStream, 'latin1')} >>\nstream\n${type3PageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3OkGlyph, 'latin1')} >>\nstream\n${type3OkGlyph}\nendstream`,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${Buffer.byteLength(badNestedForm, 'latin1')} >>\nstream\n${badNestedForm}\nendstream`,
    ]);

    // Variant C: /ExtGState /Font [4 0 R 12] selects an unlisted Type3 font (with and without /SMask).
    const gsFontOnlyPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << /BaseState /ON /OFF [7 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Hide 7 0 R >> /ExtGState << /GS1 << /Type /ExtGState /Font [4 0 R 12] >> >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(gsPageStream, 'latin1')} >>\nstream\n${gsPageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3BadGlyph, 'latin1')} >>\nstream\n${type3BadGlyph}\nendstream`,
      '<< /Type /OCG /Name (Hide) >>',
    ]);

    const okSmaskStream = 'q 1 g 0 0 10 10 re f Q\n';
    const gsSmaskAndFontPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << /BaseState /ON /OFF [7 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Hide 7 0 R >> /ExtGState << /GS1 << /Type /ExtGState /SMask << /Type /Mask /S /Alpha /G 8 0 R >> /Font [4 0 R 12] >> >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(gsPageStream, 'latin1')} >>\nstream\n${gsPageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(type3BadGlyph, 'latin1')} >>\nstream\n${type3BadGlyph}\nendstream`,
      '<< /Type /OCG /Name (Hide) >>',
      `<< /Type /XObject /Subtype /Form /Group << /Type /Group /S /Transparency >> /BBox [0 0 10 10] /Length ${Buffer.byteLength(okSmaskStream, 'latin1')} >>\nstream\n${okSmaskStream}\nendstream`,
    ]);

    for (const bypassPdf of [polyPageResAndFont, polyFontSelfResources, gsFontOnlyPdf, gsSmaskAndFontPdf]) {
      const inspectBad = await parse('pdf_inspect', bypassPdf);
      expect(inspectBad.ok).toBe(false);
      if (!inspectBad.ok) {
        expect(inspectBad.code).toBe('invalid');
      }

      const sealBad = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(bypassPdf).toString('base64'),
          fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'test' }],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(bypassPdf).digest('hex') }),
        }),
      );
      expect(sealBad.ok).toBe(false);
      if (!sealBad.ok) {
        expect(sealBad.code).toBe('invalid');
      }
    }

    // Benign control: polymorphic shared /Resources + Type3 /Font dict + /ExtGState /Font with balanced glyph.
    const okPolyGlyph = '600 0 d0 0 0 400 700 re f\n';
    const okPolyPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /Font << /T3 4 0 R >> /ExtGState << /GS1 << /Type /ExtGState /Font [4 0 R 12] >> >> /CharProcs << /a 6 0 R >> /Resources 4 0 R /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [600] >>',
      `<< /Length ${Buffer.byteLength(gsPageStream, 'latin1')} >>\nstream\n${gsPageStream}\nendstream`,
      `<< /Length ${Buffer.byteLength(okPolyGlyph, 'latin1')} >>\nstream\n${okPolyGlyph}\nendstream`,
    ]);
    const inspectPolyOk = await parse('pdf_inspect', okPolyPdf);
    expect(inspectPolyOk.ok).toBe(true);
    const sealPolyOk = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(okPolyPdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.08, text: 'OK' }],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(okPolyPdf).digest('hex') }),
      }),
    );
    expect(sealPolyOk.ok).toBe(true);
  });

  it('preserves AcroForm /DV default values when /V and /AP are absent while honoring explicit empty /V', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();

    const textDv = form.createTextField('note_dv');
    textDv.addToPage(page, { x: 40, y: 740, width: 260, height: 24 });
    textDv.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Default VN value'));
    textDv.acroField.dict.delete(PDFName.of('V'));
    textDv.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const textEmptyV = form.createTextField('note_empty_v');
    textEmptyV.addToPage(page, { x: 40, y: 700, width: 260, height: 24 });
    textEmptyV.acroField.dict.set(PDFName.of('V'), PDFString.of(''));
    textEmptyV.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Stale default text'));
    textEmptyV.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const dropdownDv = form.createDropdown('choice_dv');
    dropdownDv.addOptions(['Opt A', 'Opt B']);
    dropdownDv.addToPage(page, { x: 40, y: 660, width: 180, height: 24 });
    dropdownDv.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Opt B'));
    dropdownDv.acroField.dict.delete(PDFName.of('V'));
    dropdownDv.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const listDv = form.createOptionList('list_dv');
    listDv.addOptions(['Row 1', 'Row 2']);
    listDv.addToPage(page, { x: 40, y: 580, width: 180, height: 60 });
    listDv.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Row 2'));
    listDv.acroField.dict.delete(PDFName.of('V'));
    listDv.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const pdfBytes = await doc.save({ updateFieldAppearances: false });
    const inspected = await parse('pdf_inspect', pdfBytes);
    expect(inspected.ok).toBe(true);

    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(pdfBytes).digest('hex') }),
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected /DV form seal to succeed, got: ${JSON.stringify(sealed)}`);
    }

    const sealedBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    const readBack = await readPdfBack(sealedBytes);
    expect(readBack.pageTexts[0]).toContain('Default VN value');
    expect(readBack.pageTexts[0]).toContain('Opt B');
    expect(readBack.pageTexts[0]).not.toContain('Opt A');
    expect(readBack.pageTexts[0]).toContain('Row 1');
    expect(readBack.pageTexts[0]).toContain('Row 2');
    expect(readBack.pageTexts[0]).not.toContain('Stale default text');

    const sealedDoc = await PDFDocument.load(sealedBytes);
    expect(sealedDoc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    const contentsRaw = sealedDoc.context.lookup(sealedDoc.getPages()[0]!.node.Contents());
    const contentStreams =
      contentsRaw instanceof PDFRawStream
        ? [contentsRaw]
        : contentsRaw instanceof PDFArray
          ? Array.from({ length: contentsRaw.size() }, (_, idx) =>
              sealedDoc.context.lookup(contentsRaw.get(idx)),
            ).filter((entry): entry is PDFRawStream => entry instanceof PDFRawStream)
          : [];
    const decodedOps = contentStreams
      .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
      .join('\n');
    expect(decodedOps).toContain('0.6 0.756');
  });

  it('rejects external /F stream references and handles tiny vs degenerate widget /AP transforms safely', async () => {
    const extStreamDoc = await PDFDocument.create();
    const extPage = extStreamDoc.addPage([595.28, 841.89]);
    const extStream = extStreamDoc.context.flateStream(Buffer.from('q Q', 'latin1'), {
      F: PDFString.of('https://example.com/content.dat'),
    });
    const extStreamRef = extStreamDoc.context.register(extStream);
    extPage.node.set(PDFName.of('Contents'), extStreamRef);
    const extStreamBytes = await extStreamDoc.save();

    const extFfilterPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
      '<< /FFilter /FlateDecode /Length 3 >>\nstream\nq Q\nendstream',
    ]);

    for (const badStreamPdf of [extStreamBytes, extFfilterPdf]) {
      expect(await parse('pdf_inspect', badStreamPdf)).toMatchObject({ ok: false, code: 'invalid' });
      expect(
        await parse(
          'pdf_seal',
          encodePdfSealInput({
            pdfBase64: Buffer.from(badStreamPdf).toString('base64'),
            fields: [],
            certificate: makeCertificate({ sourceSha256: createHash('sha256').update(badStreamPdf).digest('hex') }),
          }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    }

    // Tiny valid Matrix [1e-9 0 0 1e-9 0 0] with BBox [0 0 200 40] must render and preserve text.
    const tinyDoc = await PDFDocument.create();
    const tinyPage = tinyDoc.addPage([595.28, 841.89]);
    const tinyField = tinyDoc.getForm().createTextField('tiny_matrix_field');
    tinyField.setText('Tiny Matrix Text');
    tinyField.addToPage(tinyPage, { x: 40, y: 700, width: 200, height: 40 });
    tinyDoc.getForm().updateFieldAppearances();
    const tinyApStream = tinyField.acroField
      .getWidgets()[0]
      ?.dict.lookup(PDFName.of('AP'), PDFDict)
      ?.lookup(PDFName.of('N'), PDFStream);
    if (!tinyApStream) throw new Error('expected widget /AP /N stream');
    tinyApStream.dict.set(PDFName.of('BBox'), tinyDoc.context.obj([0, 0, 200, 40]));
    tinyApStream.dict.set(
      PDFName.of('Matrix'),
      tinyDoc.context.obj([1e-9, 0, 0, 1e-9, 0, 0]),
    );
    const tinyBytes = await tinyDoc.save({ updateFieldAppearances: false });

    expect(await parse('pdf_inspect', tinyBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const tinySealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(tinyBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(tinyBytes).digest('hex') }),
      }),
    );
    if (!tinySealed.ok || tinySealed.kind !== 'pdf_seal') {
      throw new Error(`expected tiny Matrix seal to succeed, got: ${JSON.stringify(tinySealed)}`);
    }
    const tinyReadBack = await readPdfBack(new Uint8Array(Buffer.from(tinySealed.sealedPdfBase64, 'base64')));
    expect(tinyReadBack.pageTexts[0]).toContain('Tiny Matrix Text');

    // Degenerate zero-scale Matrix [0 0 0 0 0 0] must fail closed in both inspect and seal instead of dropping the field.
    const degenDoc = await PDFDocument.create();
    const degenPage = degenDoc.addPage([595.28, 841.89]);
    const degenField = degenDoc.getForm().createTextField('degenerate_matrix_field');
    degenField.setText('Should Not Drop');
    degenField.addToPage(degenPage, { x: 40, y: 700, width: 200, height: 40 });
    degenDoc.getForm().updateFieldAppearances();
    const degenApStream = degenField.acroField
      .getWidgets()[0]
      ?.dict.lookup(PDFName.of('AP'), PDFDict)
      ?.lookup(PDFName.of('N'), PDFStream);
    if (!degenApStream) throw new Error('expected widget /AP /N stream');
    degenApStream.dict.set(PDFName.of('Matrix'), degenDoc.context.obj([0, 0, 0, 0, 0, 0]));
    const degenBytes = await degenDoc.save({ updateFieldAppearances: false });

    expect(await parse('pdf_inspect', degenBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(degenBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(degenBytes).digest('hex') }),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('preserves AcroForm /Q text alignment (left, center, right, inherited /Parent and /AcroForm /Q, and UserUnit scaling) during fallback flattening', async () => {
    const extractTextMatrixPositions = (sealedBytes: Uint8Array): Promise<readonly { x: number; y: number }[]> =>
      PDFDocument.load(sealedBytes).then((checkDoc) => {
        const contents = checkDoc.getPage(0).node.Contents();
        if (!(contents instanceof PDFArray)) throw new Error('expected page contents array');
        let ops = '';
        for (let i = 0; i < contents.size(); i += 1) {
          const st = checkDoc.context.lookup(contents.get(i));
          if (st instanceof PDFRawStream) {
            ops += `${Buffer.from(decodePDFRawStream(st).decode()).toString('latin1')}\n`;
          }
        }
        const matches = [...ops.matchAll(
          /(?:^|\s)-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b/gm,
        )];
        return matches.map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      });

    // 1. Document with /AcroForm /Q = 2 (right default), NeedAppearances = true, and missing /AP:
    //    - widget override Q=0 (left)
    //    - inherited non-terminal /Parent Q=1 (center)
    //    - inherited /AcroForm /Q=2 (right)
    //    - right-aligned PDFOptionList inheriting /AcroForm /Q=2
    const doc1 = await PDFDocument.create();
    const page1 = doc1.addPage([595.28, 841.89]);
    const form1 = doc1.getForm();
    const acro1 = doc1.catalog.getOrCreateAcroForm();
    acro1.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    acro1.dict.set(PDFName.of('Q'), PDFNumber.of(2));

    const leftField = form1.createTextField('left_override');
    leftField.setText('100');
    leftField.addToPage(page1, { x: 50, y: 700, width: 220, height: 28 });
    leftField.acroField.getWidgets()[0]?.dict.set(PDFName.of('Q'), PDFNumber.of(0));
    leftField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const centerField = form1.createTextField('center_parent');
    centerField.setText('100');
    centerField.addToPage(page1, { x: 50, y: 620, width: 220, height: 28 });
    centerField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));
    const centerParentRef = doc1.context.register(
      doc1.context.obj({
        T: PDFString.of('aligned_group'),
        Q: PDFNumber.of(1),
        Kids: [centerField.ref],
      }),
    );
    centerField.acroField.dict.set(PDFName.of('Parent'), centerParentRef);
    const fields1 = acro1.dict.lookup(PDFName.of('Fields'), PDFArray);
    for (let i = 0; i < fields1.size(); i += 1) {
      if (fields1.get(i) === centerField.ref) {
        fields1.set(i, centerParentRef);
      }
    }

    const rightField = form1.createTextField('right_default');
    rightField.setText('100');
    rightField.addToPage(page1, { x: 50, y: 540, width: 220, height: 28 });
    rightField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const listField = form1.createOptionList('right_list');
    listField.addOptions(['100', '200']);
    listField.select('100');
    listField.addToPage(page1, { x: 50, y: 420, width: 220, height: 64 });
    listField.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const bytes1 = await doc1.save({ updateFieldAppearances: false });
    const sealed1 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes1).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed1.ok || sealed1.kind !== 'pdf_seal') {
      throw new Error(`expected aligned pdf_seal to succeed, got: ${JSON.stringify(sealed1)}`);
    }
    const sealedBytes1 = new Uint8Array(Buffer.from(sealed1.sealedPdfBase64, 'base64'));
    const readBack1 = await readPdfBack(sealedBytes1);
    expect(readBack1.pageTexts[0]).toContain('100');
    expect(readBack1.pageTexts[0]).toContain('200');

    const tm1 = await extractTextMatrixPositions(sealedBytes1);
    const inBand = (minY: number, maxY: number) => tm1.filter((pos) => pos.y >= minY && pos.y <= maxY);
    const leftPos = inBand(700, 728);
    const centerPos = inBand(620, 648);
    const rightPos = inBand(540, 568);
    const listPos = inBand(420, 484);

    expect(leftPos.length).toBe(1);
    expect(centerPos.length).toBe(1);
    expect(rightPos.length).toBe(1);
    expect(listPos.length).toBe(2);

    const xLeft = leftPos[0]!.x;
    const xCenter = centerPos[0]!.x;
    const xRight = rightPos[0]!.x;
    expect(xLeft).toBeGreaterThan(50);
    expect(xLeft).toBeLessThan(62);
    expect(xRight).toBeGreaterThan(xLeft + 120);
    expect(xRight).toBeLessThan(270);
    expect(Math.abs((xCenter - xLeft) * 2 - (xRight - xLeft))).toBeLessThan(0.05);
    for (const item of listPos) {
      expect(item.x).toBeGreaterThan(xLeft + 120);
      expect(item.x).toBeLessThan(270);
    }

    // 2. Non-unit /UserUnit (2x) must convert aligned X offsets in page user units without double scaling.
    const doc2 = await PDFDocument.create();
    const page2 = doc2.addPage([300, 420]);
    page2.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const form2 = doc2.getForm();
    doc2.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

    const uuLeft = form2.createTextField('uu_left');
    uuLeft.setText('99');
    uuLeft.addToPage(page2, { x: 40, y: 300, width: 120, height: 20 });
    uuLeft.acroField.dict.set(PDFName.of('Q'), PDFNumber.of(0));
    uuLeft.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const uuRight = form2.createTextField('uu_right');
    uuRight.setText('99');
    uuRight.addToPage(page2, { x: 40, y: 240, width: 120, height: 20 });
    uuRight.acroField.dict.set(PDFName.of('Q'), PDFNumber.of(2));
    uuRight.acroField.getWidgets()[0]?.dict.delete(PDFName.of('AP'));

    const bytes2 = await doc2.save({ updateFieldAppearances: false });
    const sealed2 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes2).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed2.ok || sealed2.kind !== 'pdf_seal') {
      throw new Error(`expected UserUnit aligned pdf_seal to succeed, got: ${JSON.stringify(sealed2)}`);
    }
    const sealedBytes2 = new Uint8Array(Buffer.from(sealed2.sealedPdfBase64, 'base64'));
    const tm2 = await extractTextMatrixPositions(sealedBytes2);
    const uuLeftPos = tm2.filter((pos) => pos.y >= 300 && pos.y <= 320);
    const uuRightPos = tm2.filter((pos) => pos.y >= 240 && pos.y <= 260);
    expect(uuLeftPos.length).toBe(1);
    expect(uuRightPos.length).toBe(1);
    expect(uuLeftPos[0]!.x).toBeGreaterThan(40);
    expect(uuLeftPos[0]!.x).toBeLessThan(50);
    expect(uuRightPos[0]!.x).toBeGreaterThan(uuLeftPos[0]!.x + 80);
    expect(uuRightPos[0]!.x).toBeLessThan(160);
  });

  it('normalizes missing /Subtype on /AP /N streams to /Subtype /Form and rejects non-Form /AP /N subtypes', async () => {
    // 1. Valid Stamp annotation and Widget whose /AP /N streams omit /Subtype (and /Type): PDF.js renders them
    //    originally, so flattening must preserve their content and emit /Subtype /Form XObjects.
    const doc1 = await PDFDocument.create();
    const page1 = doc1.addPage([595.28, 841.89]);
    const helvetica = await doc1.embedFont(StandardFonts.Helvetica);

    const stampApRef = doc1.context.register(
      doc1.context.flateStream(Buffer.from('BT /F1 10 Tf 10 14 Td (STAMP_OK) Tj ET', 'latin1'), {
        BBox: [0, 0, 120, 40],
        Resources: doc1.context.obj({ Font: { F1: helvetica.ref } }),
      }),
    );
    const stampAnnotRef = doc1.context.register(
      doc1.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: [50, 700, 170, 740],
        AP: { N: stampApRef },
      }),
    );

    const widgetApRef = doc1.context.register(
      doc1.context.flateStream(Buffer.from('BT /F1 10 Tf 8 10 Td (WIDGET_OK) Tj ET', 'latin1'), {
        BBox: [0, 0, 140, 28],
        Resources: doc1.context.obj({ Font: { F1: helvetica.ref } }),
      }),
    );
    const textField = doc1.getForm().createTextField('no_subtype_ap');
    textField.addToPage(page1, { x: 50, y: 640, width: 140, height: 28 });
    const widget = textField.acroField.getWidgets()[0];
    if (!widget) throw new Error('missing text widget');
    widget.dict.set(PDFName.of('AP'), doc1.context.obj({ N: widgetApRef }));
    page1.node.set(PDFName.of('Annots'), doc1.context.obj([stampAnnotRef, widget.dict]));

    const bytes1 = await doc1.save({ updateFieldAppearances: false, useObjectStreams: false });
    expect(await parse('pdf_inspect', bytes1)).toMatchObject({ ok: true, kind: 'pdf_inspect' });

    const sealed1 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes1).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    if (!sealed1.ok || sealed1.kind !== 'pdf_seal') {
      throw new Error(`expected missing /Subtype /AP /N seal to pass, got: ${JSON.stringify(sealed1)}`);
    }
    const sealedBytes1 = new Uint8Array(Buffer.from(sealed1.sealedPdfBase64, 'base64'));
    const readBack1 = await readPdfBack(sealedBytes1);
    expect(readBack1.pageTexts[0]).toContain('STAMP_OK');
    expect(readBack1.pageTexts[0]).toContain('WIDGET_OK');

    const checkDoc1 = await PDFDocument.load(sealedBytes1);
    const xObjectDict = checkDoc1.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    if (!xObjectDict) throw new Error('expected flattened page XObjects');
    let formCount = 0;
    for (const [, ref] of xObjectDict.entries()) {
      const resolved = checkDoc1.context.lookup(ref);
      if (resolved instanceof PDFRawStream) {
        const sub = resolved.dict.lookup(PDFName.of('Subtype'));
        if (sub instanceof PDFName && sub.decodeText() === 'Form') {
          formCount += 1;
        }
      }
    }
    expect(formCount).toBeGreaterThanOrEqual(2);

    // 2. Non-Form /Subtype (/Image) on Stamp /AP /N fails closed in both inspect and seal.
    const docBadAnnot = await PDFDocument.create();
    const pageBadAnnot = docBadAnnot.addPage([400, 400]);
    const imgStreamRef = docBadAnnot.context.register(
      docBadAnnot.context.flateStream(Buffer.from('q Q', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Image'),
        BBox: [0, 0, 80, 30],
      }),
    );
    const badStampRef = docBadAnnot.context.register(
      docBadAnnot.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: [20, 300, 100, 330],
        AP: { N: imgStreamRef },
      }),
    );
    pageBadAnnot.node.set(PDFName.of('Annots'), docBadAnnot.context.obj([badStampRef]));
    const badAnnotBytes = await docBadAnnot.save({ useObjectStreams: false });
    expect(await parse('pdf_inspect', badAnnotBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(badAnnotBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(badAnnotBytes).digest('hex') }),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Non-Form /Subtype (/Image) on Widget /AP /N fails closed in both inspect and seal.
    const docBadWidget = await PDFDocument.create();
    const pageBadWidget = docBadWidget.addPage([400, 400]);
    const badWidgetStreamRef = docBadWidget.context.register(
      docBadWidget.context.flateStream(Buffer.from('q Q', 'latin1'), {
        Subtype: PDFName.of('Image'),
        BBox: [0, 0, 80, 30],
      }),
    );
    const badField = docBadWidget.getForm().createTextField('bad_sub_widget');
    badField.addToPage(pageBadWidget, { x: 20, y: 200, width: 80, height: 30 });
    badField.acroField.getWidgets()[0]?.dict.set(PDFName.of('AP'), docBadWidget.context.obj({ N: badWidgetStreamRef }));
    const badWidgetBytes = await docBadWidget.save({ updateFieldAppearances: false, useObjectStreams: false });
    expect(await parse('pdf_inspect', badWidgetBytes)).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(badWidgetBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate({ sourceSha256: createHash('sha256').update(badWidgetBytes).digest('hex') }),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('allows producer-chosen names like /AF inside Type3 /CharProcs and /AP /N state dicts while blocking unsafe keys elsewhere', async () => {
    // 1. Checkbox with /AP /N state named /AF plus Type3 font with /CharProcs << /AF ... >>.
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const cb = doc.getForm().createCheckBox('af_choice');
    cb.addToPage(page, { x: 40, y: 700, width: 20, height: 20 });
    cb.check();
    const widget = cb.acroField.getWidgets()[0];
    const normalDict = widget?.getAppearances()?.normal;
    if (!widget || !(normalDict instanceof PDFDict)) throw new Error('missing checkbox normal dict');
    const onRef = normalDict.get(PDFName.of('Yes'));
    if (!onRef) throw new Error('missing Yes stream ref');
    normalDict.delete(PDFName.of('Yes'));
    normalDict.set(PDFName.of('AF'), onRef);
    widget.dict.set(PDFName.of('AS'), PDFName.of('AF'));
    cb.acroField.dict.set(PDFName.of('V'), PDFName.of('AF'));

    const afGlyphRef = doc.context.register(
      doc.context.flateStream(Buffer.from('100 0 d0 q 0 0 50 50 re f Q', 'latin1')),
    );
    const type3FontRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Font'),
        Subtype: PDFName.of('Type3'),
        FontBBox: [0, 0, 100, 100],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: doc.context.obj({ AF: afGlyphRef }),
        Encoding: doc.context.obj({
          Type: PDFName.of('Encoding'),
          Differences: [65, PDFName.of('AF')],
        }),
        FirstChar: 65,
        LastChar: 65,
        Widths: [100],
      }),
    );
    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({ Font: doc.context.obj({ T3F: type3FontRef }) }),
    );
    const t3ContentRef = doc.context.register(
      doc.context.flateStream(Buffer.from('BT /T3F 12 Tf 40 600 Td (A) Tj ET', 'latin1')),
    );
    page.node.set(PDFName.of('Contents'), t3ContentRef);

    const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    expect(await parse('pdf_inspect', bytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(sealed).toMatchObject({ ok: true, kind: 'pdf_seal' });

    // 2. Spoofed /CharProcs on a non-Type3 dict (Catalog) with /AF must still be rejected.
    const docBadCharProcs = await PDFDocument.create();
    docBadCharProcs.addPage([400, 400]);
    const dummyStreamRef = docBadCharProcs.context.register(
      docBadCharProcs.context.flateStream(Buffer.from('q Q', 'latin1')),
    );
    docBadCharProcs.catalog.set(
      PDFName.of('CharProcs'),
      docBadCharProcs.context.obj({ AF: dummyStreamRef }),
    );
    const badCharProcsBytes = await docBadCharProcs.save({ useObjectStreams: false });
    expect(await parse('pdf_inspect', badCharProcsBytes)).toMatchObject({ ok: false, code: 'invalid' });

    // 3. Malicious /AA inside /AP /N /AF stream value must still be rejected.
    const docBadApVal = await PDFDocument.create();
    const pageBadApVal = docBadApVal.addPage([400, 400]);
    const badCb = docBadApVal.getForm().createCheckBox('bad_ap_val');
    badCb.addToPage(pageBadApVal, { x: 40, y: 300, width: 20, height: 20 });
    const badApStreamRef = docBadApVal.context.register(
      docBadApVal.context.flateStream(Buffer.from('q Q', 'latin1'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: [0, 0, 20, 20],
        AA: { E: { S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert(1)') } },
      }),
    );
    const badW = badCb.acroField.getWidgets()[0];
    if (!badW) throw new Error('missing widget');
    badW.dict.set(
      PDFName.of('AP'),
      docBadApVal.context.obj({ N: { AF: badApStreamRef, Off: badApStreamRef } }),
    );
    badW.dict.set(PDFName.of('AS'), PDFName.of('AF'));
    badCb.acroField.dict.set(PDFName.of('V'), PDFName.of('AF'));
    const badApValBytes = await docBadApVal.save({ useObjectStreams: false, updateFieldAppearances: false });
    expect(await parse('pdf_inspect', badApValBytes)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('preserves CheckBox and RadioGroup /DV default state when /V and /AS are absent while honoring explicit /V /Off and /AS /Off', async () => {
    const readFlattenedXObjectStreams = async (sealedBytes: Uint8Array): Promise<readonly string[]> => {
      const checkDoc = await PDFDocument.load(sealedBytes);
      const xObjDict = checkDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      if (!xObjDict) return [];
      const streams: string[] = [];
      for (const [, ref] of xObjDict.entries()) {
        const resolved = checkDoc.context.lookup(ref);
        if (resolved instanceof PDFRawStream) {
          streams.push(Buffer.from(decodePDFRawStream(resolved).decode()).toString('latin1'));
        }
      }
      return streams;
    };

    // Baseline explicit checked vs unchecked checkbox XObject streams.
    const buildSingleCheckboxBytes = async (mode: 'explicit_yes' | 'explicit_off' | 'dv_yes' | 'dv_overridden_off') => {
      const d = await PDFDocument.create();
      const page = d.addPage([400, 400]);
      const cb = d.getForm().createCheckBox('agree');
      cb.addToPage(page, { x: 40, y: 300, width: 20, height: 20 });
      const w = cb.acroField.getWidgets()[0];
      if (!w) throw new Error('missing checkbox widget');
      w.dict.delete(PDFName.of('AP'));
      w.dict.delete(PDFName.of('AS'));
      d.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
      if (mode === 'explicit_yes') {
        cb.acroField.dict.set(PDFName.of('V'), PDFName.of('Yes'));
      } else if (mode === 'explicit_off') {
        cb.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
      } else if (mode === 'dv_yes') {
        cb.acroField.dict.delete(PDFName.of('V'));
        cb.acroField.dict.set(PDFName.of('DV'), PDFName.of('Yes'));
      } else {
        cb.acroField.dict.set(PDFName.of('DV'), PDFName.of('Yes'));
        cb.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
      }
      return d.save({ updateFieldAppearances: false, useObjectStreams: false });
    };

    const sealAndReadXObjects = async (pdfBytes: Uint8Array) => {
      expect(await parse('pdf_inspect', pdfBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect' });
      const res = await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(pdfBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      );
      if (!res.ok || res.kind !== 'pdf_seal') {
        throw new Error(`expected pdf_seal to succeed, got: ${JSON.stringify(res)}`);
      }
      return readFlattenedXObjectStreams(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')));
    };

    const checkedBaseline = await sealAndReadXObjects(await buildSingleCheckboxBytes('explicit_yes'));
    const uncheckedBaseline = await sealAndReadXObjects(await buildSingleCheckboxBytes('explicit_off'));
    const dvChecked = await sealAndReadXObjects(await buildSingleCheckboxBytes('dv_yes'));
    const dvOverriddenOff = await sealAndReadXObjects(await buildSingleCheckboxBytes('dv_overridden_off'));

    expect(checkedBaseline.length).toBe(1);
    expect(uncheckedBaseline.length).toBe(1);
    expect(checkedBaseline[0]).not.toBe(uncheckedBaseline[0]);
    expect(dvChecked).toEqual(checkedBaseline);
    expect(dvOverriddenOff).toEqual(uncheckedBaseline);

    // CheckBox with /DV /Yes, no /V, explicit /AS /Off, NeedAppearances=false must NOT error as conflicting and stays Off.
    const docAsOff = await PDFDocument.create();
    const pageAsOff = docAsOff.addPage([400, 400]);
    const cbAsOff = docAsOff.getForm().createCheckBox('dv_as_off');
    cbAsOff.addToPage(pageAsOff, { x: 40, y: 260, width: 20, height: 20 });
    cbAsOff.acroField.dict.delete(PDFName.of('V'));
    cbAsOff.acroField.dict.set(PDFName.of('DV'), PDFName.of('Yes'));
    cbAsOff.acroField.getWidgets()[0]?.dict.set(PDFName.of('AS'), PDFName.of('Off'));
    const asOffBytes = await docAsOff.save({ updateFieldAppearances: false, useObjectStreams: false });
    expect(await sealAndReadXObjects(asOffBytes)).toEqual(uncheckedBaseline);

    // RadioGroup with /DV /1 (index into /Opt ['OptA', 'OptB']), no /V, no /AS, NeedAppearances=true must seal OptB ON and OptA Off.
    const docRadio = await PDFDocument.create();
    const pageRadio = docRadio.addPage([400, 400]);
    const radio = docRadio.getForm().createRadioGroup('plan_radio');
    radio.addOptionToPage('OptA', pageRadio, { x: 40, y: 200, width: 20, height: 20 });
    radio.addOptionToPage('OptB', pageRadio, { x: 80, y: 200, width: 20, height: 20 });
    radio.select('OptB');
    const selectedV = radio.acroField.dict.get(PDFName.of('V'));
    if (!selectedV) throw new Error('missing selected radio V');
    radio.acroField.dict.set(PDFName.of('DV'), selectedV);
    radio.acroField.dict.delete(PDFName.of('V'));
    for (const w of radio.acroField.getWidgets()) {
      w.dict.delete(PDFName.of('AS'));
    }
    docRadio.catalog.getOrCreateAcroForm().dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    const radioBytes = await docRadio.save({ updateFieldAppearances: false, useObjectStreams: false });
    const radioStreams = await sealAndReadXObjects(radioBytes);
    expect(radioStreams.length).toBe(2);
    // Checked radio button stream contains the inner dot fill operators and is strictly longer than the empty circle Off stream.
    expect(radioStreams[1]!.length).toBeGreaterThan(radioStreams[0]!.length);
  });

  it('excludes primitive scalars from MAX_PDF_GRAPH_NODES while enforcing the container cap', async () => {
    // 260,000 primitive PDFNumber / PDFBool / PDFNull values exceed MAX_PDF_GRAPH_NODES (250,000)
    // and must succeed across pdf_inspect, normalizeAllPdfNames, and pruneUnreferencedIndirectObjects.
    const denseDoc = await PDFDocument.create();
    const densePage = denseDoc.addPage([400, 400]);
    const denseArray = PDFArray.withContext(denseDoc.context);
    for (let i = 0; i < 260_000; i++) {
      if (i % 10 === 0) {
        denseArray.push(PDFBool.True);
      } else if (i % 10 === 1) {
        denseArray.push(PDFBool.False);
      } else if (i % 10 === 2) {
        denseArray.push(PDFNull);
      } else {
        denseArray.push(PDFNumber.of(i % 1000));
      }
    }
    const denseArrayRef = denseDoc.context.register(denseArray);
    densePage.node.set(
      PDFName.of('PieceInfo'),
      denseDoc.context.obj({
        DenseApp: {
          LastModified: PDFString.of('D:20261116000000Z'),
          Private: denseArrayRef,
        },
      }),
    );
    const denseBytes = await denseDoc.save({ useObjectStreams: false });

    expect(await parse('pdf_inspect', denseBytes)).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
    });
    const denseSealRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(denseBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(denseSealRes).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });

    // Over 250,000 distinct container nodes must still trigger MAX_PDF_GRAPH_NODES fail-closed.
    const bombDoc = await PDFDocument.create();
    const bombPage = bombDoc.addPage([400, 400]);
    const bombOuter = PDFArray.withContext(bombDoc.context);
    for (let i = 0; i < 250_050; i++) {
      bombOuter.push(PDFArray.withContext(bombDoc.context));
    }
    bombPage.node.set(PDFName.of('PieceInfo'), bombDoc.context.obj({ BombApp: { Private: bombOuter } }));
    const bombBytes = await bombDoc.save({ useObjectStreams: false });

    const bombInspectRes = await parse('pdf_inspect', bombBytes);
    expect(bombInspectRes).toMatchObject({ ok: false, code: 'invalid' });
    if (!bombInspectRes.ok) {
      expect(bombInspectRes.message).toContain('quá phức tạp');
    }
  });

  it('supports safe hybrid /XRefStm office-style PDFs while enforcing free precedence and failing closed on shadowing or corruption', async () => {
    const encodePngUp = (rawRows: Uint8Array, columns: number): Buffer => {
      const rowCount = rawRows.byteLength / columns;
      const out = Buffer.alloc(rowCount * (columns + 1));
      for (let r = 0; r < rowCount; r += 1) {
        out[r * (columns + 1)] = 2;
        for (let c = 0; c < columns; c += 1) {
          const cur = rawRows[r * columns + c] ?? 0;
          const up = r > 0 ? (rawRows[(r - 1) * columns + c] ?? 0) : 0;
          out[r * (columns + 1) + 1 + c] = (cur - up) & 0xff;
        }
      }
      return out;
    };

    const encodeXrefRows = (
      rows: ReadonlyArray<
        | { readonly kind: 0; readonly nextFree: number; readonly gen: number }
        | { readonly kind: 1; readonly offset: number; readonly gen: number }
        | { readonly kind: 2; readonly objStmNum: number; readonly index: number }
      >,
    ): Uint8Array => {
      const buf = Buffer.alloc(rows.length * 7);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const base = i * 7;
        buf[base] = row.kind;
        if (row.kind === 0) {
          buf.writeUInt32BE(row.nextFree, base + 1);
          buf.writeUInt16BE(row.gen, base + 5);
        } else if (row.kind === 1) {
          buf.writeUInt32BE(row.offset, base + 1);
          buf.writeUInt16BE(row.gen, base + 5);
        } else {
          buf.writeUInt32BE(row.objStmNum, base + 1);
          buf.writeUInt16BE(row.index, base + 5);
        }
      }
      return buf;
    };

    const makeObjStm = (items: ReadonlyArray<{ readonly num: number; readonly body: string }>, compress = true): string => {
      let header = '';
      let bodies = '';
      for (const item of items) {
        header += `${item.num} ${bodies.length} `;
        bodies += `${item.body}\n`;
      }
      const rawData = Buffer.from(`${header}${bodies}`, 'latin1');
      if (!compress) {
        return `<< /Type /ObjStm /N ${items.length} /First ${header.length} /Length ${rawData.byteLength} >>\nstream\n${rawData.toString('latin1')}\nendstream`;
      }
      const compressed = deflateSync(rawData);
      return `<< /Type /ObjStm /N ${items.length} /First ${header.length} /Filter /FlateDecode /Length ${compressed.byteLength} >>\nstream\n${compressed.toString('latin1')}\nendstream`;
    };

    const fmtEntry = (offset: number, gen = 0, flag: 'n' | 'f' = 'n'): string =>
      `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} ${flag} \n`;

    const buildWordStyleHybridPdf = (opts: {
      readonly includeXrefRoot?: boolean;
      readonly omitIndexAndRepeatClassic?: boolean;
      readonly compressFontInObjStm?: boolean;
      readonly text?: string;
      readonly extraClassicSubsections?: string;
      readonly overrideClassicFreeNums?: ReadonlySet<number>;
      readonly overrideXrefStmEntries?: ReadonlyMap<
        number,
        | { readonly kind: 0; readonly nextFree: number; readonly gen: number }
        | { readonly kind: 1; readonly offset: number; readonly gen: number }
        | { readonly kind: 2; readonly objStmNum: number; readonly index: number }
      >;
      readonly extraBodyAfterObjects?: string;
      readonly xrefStmDictExtra?: string;
      readonly trailerExtra?: string;
    } = {}): {
      readonly bytes: Uint8Array;
      readonly classicXrefOffset: number;
      readonly xrefStmOffset: number;
      readonly offsets: ReadonlyMap<number, number>;
    } => {
      const pageText = opts.text ?? 'HYBRID_OFFICE_CONTRACT {{sig, r1}}';
      const contentRaw = deflateSync(
        Buffer.from(`BT\n/F1 12 Tf\n40 750 Td\n(${pageText}) Tj\nET\n`, 'latin1'),
      );
      const offsets = new Map<number, number>();
      let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
      const pushObj = (num: number, body: string): number => {
        const off = out.length;
        offsets.set(num, off);
        out += `${num} 0 obj\n${body}\nendobj\n`;
        return off;
      };

      pushObj(1, '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 7 0 R >>');
      pushObj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      pushObj(
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      );
      pushObj(
        4,
        `<< /Filter /FlateDecode /Length ${contentRaw.byteLength} >>\nstream\n${contentRaw.toString('latin1')}\nendstream`,
      );
      if (!opts.compressFontInObjStm) {
        pushObj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
      }

      const compressedItems: Array<{ readonly num: number; readonly body: string }> = [];
      if (opts.compressFontInObjStm) {
        compressedItems.push({ num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
      }
      compressedItems.push(
        { num: 7, body: '<< /Type /StructTreeRoot /ParentTree 8 0 R >>' },
        { num: 8, body: '<< /Nums [] >>' },
        { num: 9, body: '<< /Producer (Microsoft Word for Microsoft 365) /Title (Hybrid Office PDF) >>' },
      );
      const off6 = pushObj(6, makeObjStm(compressedItems, true));

      if (opts.extraBodyAfterObjects) {
        out += opts.extraBodyAfterObjects;
      }

      const xrefStmOffset = out.length;
      offsets.set(10, xrefStmOffset);

      const defaultRowFor = (
        objNum: number,
      ):
        | { readonly kind: 0; readonly nextFree: number; readonly gen: number }
        | { readonly kind: 1; readonly offset: number; readonly gen: number }
        | { readonly kind: 2; readonly objStmNum: number; readonly index: number } => {
        const overridden = opts.overrideXrefStmEntries?.get(objNum);
        if (overridden) return overridden;
        if (objNum === 0) return { kind: 0, nextFree: 0, gen: 65535 };
        if (objNum >= 1 && objNum <= 4) return { kind: 1, offset: offsets.get(objNum)!, gen: 0 };
        if (objNum === 5) {
          return opts.compressFontInObjStm
            ? { kind: 2, objStmNum: 6, index: 0 }
            : { kind: 1, offset: offsets.get(5)!, gen: 0 };
        }
        if (objNum === 6) return { kind: 1, offset: off6, gen: 0 };
        if (objNum >= 7 && objNum <= 9) {
          const idx = compressedItems.findIndex((item) => item.num === objNum);
          return { kind: 2, objStmNum: 6, index: idx };
        }
        return { kind: 1, offset: xrefStmOffset, gen: 0 };
      };

      const startIndex = opts.omitIndexAndRepeatClassic ? 0 : opts.compressFontInObjStm ? 5 : 6;
      const rows: Array<ReturnType<typeof defaultRowFor>> = [];
      for (let n = startIndex; n <= 10; n += 1) {
        rows.push(defaultRowFor(n));
      }
      const rawRows = encodeXrefRows(rows);
      const predictedRows = encodePngUp(rawRows, 7);
      const compressedXref = deflateSync(predictedRows);
      const indexClause = opts.omitIndexAndRepeatClassic ? '' : `/Index [${startIndex} ${11 - startIndex}] `;
      const rootClause = opts.includeXrefRoot === false ? '' : '/Root 1 0 R /Info 9 0 R ';
      const xrefDictExtra = opts.xrefStmDictExtra ?? '';
      out +=
        `10 0 obj\n<< /Type /XRef /Size 11 ${indexClause}/W [1 4 2] ${rootClause}/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> ${xrefDictExtra}/Length ${compressedXref.byteLength} >>\n` +
        `stream\n${compressedXref.toString('latin1')}\nendstream\nendobj\n`;

      const classicXrefOffset = out.length;
      const classicLimit = opts.compressFontInObjStm ? 4 : 5;
      let classicTable = `xref\n0 ${classicLimit + 1}\n${fmtEntry(0, 65535, 'f')}`;
      for (let n = 1; n <= classicLimit; n += 1) {
        classicTable += opts.overrideClassicFreeNums?.has(n)
          ? fmtEntry(0, 65535, 'f')
          : fmtEntry(offsets.get(n)!, 0, 'n');
      }
      if (opts.extraClassicSubsections) {
        classicTable += opts.extraClassicSubsections;
      }
      const trailerExtra = opts.trailerExtra ?? '';
      out += `${classicTable}trailer\n<< /Size 11 /Root 1 0 R /Info 9 0 R /XRefStm ${xrefStmOffset} ${trailerExtra}>>\nstartxref\n${classicXrefOffset}\n%%EOF\n`;

      return {
        bytes: new Uint8Array(Buffer.from(out, 'latin1')),
        classicXrefOffset,
        xrefStmOffset,
        offsets,
      };
    };

    const assertRejectedBoth = async (pdfBytes: Uint8Array) => {
      expect(await parse('pdf_inspect', pdfBytes)).toMatchObject({ ok: false, code: 'invalid' });
      expect(
        await parse(
          'pdf_seal',
          encodePdfSealInput({
            pdfBase64: Buffer.from(pdfBytes).toString('base64'),
            fields: [],
            certificate: makeCertificate(),
          }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    };

    // 1. Realistic Word/Excel-style hybrid /XRefStm PDF (compressed Font + StructTreeRoot + Info in /ObjStm, Predictor 12 /XRefStm).
    const validWordHybrid = buildWordStyleHybridPdf({
      compressFontInObjStm: true,
      includeXrefRoot: true,
    });
    const inspectWordRes = await parse('pdf_inspect', validWordHybrid.bytes);
    expect(inspectWordRes).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
    });
    if (inspectWordRes.ok && inspectWordRes.kind === 'pdf_inspect') {
      expect(inspectWordRes.pages[0]?.text).toContain('HYBRID_OFFICE_CONTRACT');
      expect(inspectWordRes.detectedTags).toHaveLength(1);
      expect(inspectWordRes.detectedTags[0]?.roleKey).toBe('r1');
    }
    const sealWordRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(validWordHybrid.bytes).toString('base64'),
        fields: [],
        certificate: makeCertificate(),
      }),
    );
    expect(sealWordRes).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });
    if (sealWordRes.ok && sealWordRes.kind === 'pdf_seal') {
      const sealedBack = await readPdfBack(new Uint8Array(Buffer.from(sealWordRes.sealedPdfBase64, 'base64')));
      expect(sealedBack.pageCount).toBe(2);
      expect(sealedBack.pageTexts[0]).toContain('HYBRID_OFFICE_CONTRACT');
    }
    const incMeta = await loadValidatedPdfForIncrementalUpdate(validWordHybrid.bytes);
    expect(incMeta.isXrefStream).toBe(false);
    expect(incMeta.prevStartXrefOffset).toBe(validWordHybrid.classicXrefOffset);
    expect(incMeta.maxObjNum).toBeGreaterThanOrEqual(10);

    // 2. Hybrid /XRefStm omitting /Root and /Index (default [0 Size], repeating identical classic offsets + free obj 0).
    const validNoIndexHybrid = buildWordStyleHybridPdf({
      includeXrefRoot: false,
      omitIndexAndRepeatClassic: true,
      compressFontInObjStm: false,
    });
    expect(await parse('pdf_inspect', validNoIndexHybrid.bytes)).toMatchObject({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
    });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(validNoIndexHybrid.bytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });

    // 3. Incremental classic update on top of a hybrid /XRefStm PDF (valid /Prev -> hybrid section).
    const baseStr = Buffer.from(validWordHybrid.bytes).toString('latin1');
    const updatedContentStream = deflateSync(
      Buffer.from('BT\n/F1 12 Tf\n40 750 Td\n(AMENDED_HYBRID_200) Tj\nET\n', 'latin1'),
    );
    const rev2Obj4Offset = baseStr.length;
    const rev2Obj4 = `4 0 obj\n<< /Filter /FlateDecode /Length ${updatedContentStream.byteLength} >>\nstream\n${updatedContentStream.toString('latin1')}\nendstream\nendobj\n`;
    const rev2XrefOffset = rev2Obj4Offset + rev2Obj4.length;
    const incrementalOnHybridBytes = new Uint8Array(
      Buffer.from(
        `${baseStr}${rev2Obj4}xref\n4 1\n${fmtEntry(rev2Obj4Offset, 0, 'n')}trailer\n<< /Size 11 /Root 1 0 R /Info 9 0 R /Prev ${validWordHybrid.classicXrefOffset} >>\nstartxref\n${rev2XrefOffset}\n%%EOF\n`,
        'latin1',
      ),
    );
    const incHybridInspect = await parse('pdf_inspect', incrementalOnHybridBytes);
    expect(incHybridInspect).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    if (incHybridInspect.ok && incHybridInspect.kind === 'pdf_inspect') {
      expect(incHybridInspect.pages[0]?.text).toContain('AMENDED_HYBRID_200');
      expect(incHybridInspect.pages[0]?.text).not.toContain('HYBRID_OFFICE_CONTRACT');
    }

    // 4. Multi-revision hybrid /Prev chain where newer hybrid /XRefStm carries /Prev pointing to older /XRefStm.
    const rev2ObjStm = makeObjStm([
      { num: 9, body: '<< /Producer (Microsoft Excel) /Title (Rev2 Hybrid) >>' },
    ]);
    const rev2ObjStmOffset = baseStr.length + rev2Obj4.length;
    const rev2Obj11 = `11 0 obj\n${rev2ObjStm}\nendobj\n`;
    const rev2XrefStmOffset = rev2ObjStmOffset + rev2Obj11.length;
    const rev2XrefRows = encodeXrefRows([
      { kind: 2, objStmNum: 11, index: 0 },
      { kind: 1, offset: rev2ObjStmOffset, gen: 0 },
      { kind: 1, offset: rev2XrefStmOffset, gen: 0 },
    ]);
    const rev2XrefPayload = deflateSync(encodePngUp(rev2XrefRows, 7));
    const rev2XrefStmObj =
      `12 0 obj\n<< /Type /XRef /Size 13 /Index [9 1 11 2] /W [1 4 2] /Root 1 0 R /Prev ${validWordHybrid.xrefStmOffset} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${rev2XrefPayload.byteLength} >>\n` +
      `stream\n${rev2XrefPayload.toString('latin1')}\nendstream\nendobj\n`;
    const rev2HybridClassicOffset = rev2XrefStmOffset + rev2XrefStmObj.length;
    const dualHybridBytes = new Uint8Array(
      Buffer.from(
        `${baseStr}${rev2Obj4}${rev2Obj11}${rev2XrefStmObj}xref\n4 1\n${fmtEntry(rev2Obj4Offset, 0, 'n')}trailer\n<< /Size 13 /Root 1 0 R /Info 9 0 R /Prev ${validWordHybrid.classicXrefOffset} /XRefStm ${rev2XrefStmOffset} >>\nstartxref\n${rev2HybridClassicOffset}\n%%EOF\n`,
        'latin1',
      ),
    );
    expect(await parse('pdf_inspect', dualHybridBytes)).toMatchObject({ ok: true, kind: 'pdf_inspect', pageCount: 1 });
    expect(
      await parse(
        'pdf_seal',
        encodePdfSealInput({
          pdfBase64: Buffer.from(dualHybridBytes).toString('base64'),
          fields: [],
          certificate: makeCertificate(),
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 2 });

    // 5a. Free-entry precedence: newer classic revision marks compressed obj 9 as free (f); older /XRefStm cannot resurrect it.
    const freeNewerClassicBytes = new Uint8Array(
      Buffer.from(
        `${baseStr}xref\n9 1\n${fmtEntry(0, 1, 'f')}trailer\n<< /Size 11 /Root 1 0 R /Prev ${validWordHybrid.classicXrefOffset} >>\nstartxref\n${baseStr.length}\n%%EOF\n`,
        'latin1',
      ),
    );
    await assertRejectedBoth(freeNewerClassicBytes);

    // 5b. Free-entry precedence (vice versa): newer hybrid /XRefStm marks active obj 4 as type-0 free; older classic xref cannot resurrect it.
    const classicBaseBytes = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      '<< /Length 26 >>\nstream\nBT /F1 12 Tf (BASE) Tj ET\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
    const classicBaseStr = Buffer.from(classicBaseBytes).toString('latin1');
    const classicBaseStart = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(classicBaseStr)?.[1]);
    const rev2FreeXrefStmOff = classicBaseStr.length;
    const rev2FreeXrefData = encodeXrefRows([
      { kind: 0, nextFree: 0, gen: 1 },
      { kind: 1, offset: rev2FreeXrefStmOff, gen: 0 },
    ]);
    const rev2FreeXrefObj = `6 0 obj\n<< /Type /XRef /Size 7 /Index [4 1 6 1] /W [1 4 2] /Root 1 0 R /Length ${rev2FreeXrefData.byteLength} >>\nstream\n${Buffer.from(rev2FreeXrefData).toString('latin1')}\nendstream\nendobj\n`;
    const rev2FreeClassicOff = rev2FreeXrefStmOff + rev2FreeXrefObj.length;
    const freeInNewerXrefStmBytes = new Uint8Array(
      Buffer.from(
        `${classicBaseStr}${rev2FreeXrefObj}xref\n0 1\n${fmtEntry(0, 65535, 'f')}trailer\n<< /Size 7 /Root 1 0 R /Prev ${classicBaseStart} /XRefStm ${rev2FreeXrefStmOff} >>\nstartxref\n${rev2FreeClassicOff}\n%%EOF\n`,
        'latin1',
      ),
    );
    await assertRejectedBoth(freeInNewerXrefStmBytes);

    // 5c. Intra-section free conflict: classic xref marks compressed obj 5 as free (f) while /XRefStm marks obj 5 active in /ObjStm.
    const sameSectionFreeConflict = buildWordStyleHybridPdf({
      compressFontInObjStm: true,
      extraClassicSubsections: `5 1\n${fmtEntry(0, 65535, 'f')}`,
    });
    await assertRejectedBoth(sameSectionFreeConflict.bytes);

    // 5d. Classic xref marks /XRefStm stream object 10 itself as free (f) while /XRefStm indexes 10 at its offset.
    const classicFreesXrefStm = buildWordStyleHybridPdf({
      compressFontInObjStm: true,
      extraClassicSubsections: `10 1\n${fmtEntry(0, 65535, 'f')}`,
    });
    await assertRejectedBoth(classicFreesXrefStm.bytes);

    // 6. Dual-parser object-shadowing & conflict attacks must fail closed:
    // 6a. Conflicting offset in classic xref vs /XRefStm for obj 4.
    const conflictingOffset = buildWordStyleHybridPdf({
      omitIndexAndRepeatClassic: true,
      overrideXrefStmEntries: new Map([[4, { kind: 1, offset: validWordHybrid.offsets.get(3)!, gen: 0 }]]),
    });
    await assertRejectedBoth(conflictingOffset.bytes);

    // 6b. Conflicting in-use classic obj 4 vs type-2 objStm in /XRefStm.
    const conflictingObjStm = buildWordStyleHybridPdf({
      omitIndexAndRepeatClassic: true,
      overrideXrefStmEntries: new Map([[4, { kind: 2, objStmNum: 6, index: 0 }]]),
    });
    await assertRejectedBoth(conflictingObjStm.bytes);

    // 6c. Conflicting in-use classic obj 4 vs type-0 free in /XRefStm.
    const conflictingFreeInStm = buildWordStyleHybridPdf({
      omitIndexAndRepeatClassic: true,
      overrideXrefStmEntries: new Map([[4, { kind: 0, nextFree: 0, gen: 0 }]]),
    });
    await assertRejectedBoth(conflictingFreeInStm.bytes);

    // 6d. Rogue top-level 5 0 obj overriding compressed Font 5 inside /ObjStm.
    const rogueTopLevelShadow = buildWordStyleHybridPdf({
      compressFontInObjStm: true,
      extraBodyAfterObjects: '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    });
    await assertRejectedBoth(rogueTopLevelShadow.bytes);

    // 6e. Rogue unindexed decoy /Type /XRef stream object 11 injecting /Root or /Info into pdf-lib.
    const decoyXrefData = encodeXrefRows([{ kind: 1, offset: 0, gen: 0 }]);
    const decoyXrefObjStr = `11 0 obj\n<< /Type /XRef /Size 1 /W [1 4 2] /Root 2 0 R /Length ${decoyXrefData.byteLength} >>\nstream\n${Buffer.from(decoyXrefData).toString('latin1')}\nendstream\nendobj\n`;
    const decoyXrefHybrid = buildWordStyleHybridPdf({
      compressFontInObjStm: true,
      extraBodyAfterObjects: decoyXrefObjStr,
    });
    await assertRejectedBoth(decoyXrefHybrid.bytes);

    // 6f. Indexed decoy /Type /XRef stream object 11 not referenced by startxref, /Prev, or /XRefStm.
    const indexedDecoyOffset = baseStr.indexOf('10 0 obj');
    const indexedDecoyBeforeXrefStm = `${baseStr.slice(0, indexedDecoyOffset)}${decoyXrefObjStr}`;
    const indexedDecoyXrefStmOff = indexedDecoyBeforeXrefStm.length;
    const indexedDecoyStreamRows = encodeXrefRows([
      { kind: 2, objStmNum: 6, index: 0 },
      { kind: 1, offset: validWordHybrid.offsets.get(6)!, gen: 0 },
      { kind: 2, objStmNum: 6, index: 1 },
      { kind: 2, objStmNum: 6, index: 2 },
      { kind: 2, objStmNum: 6, index: 3 },
      { kind: 1, offset: indexedDecoyXrefStmOff, gen: 0 },
    ]);
    const indexedDecoyStreamCompressed = deflateSync(encodePngUp(indexedDecoyStreamRows, 7));
    const indexedDecoyXrefStmObj =
      `10 0 obj\n<< /Type /XRef /Size 12 /Index [5 6] /W [1 4 2] /Root 1 0 R /Info 9 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${indexedDecoyStreamCompressed.byteLength} >>\n` +
      `stream\n${indexedDecoyStreamCompressed.toString('latin1')}\nendstream\nendobj\n`;
    const indexedDecoyClassicOff = indexedDecoyXrefStmOff + indexedDecoyXrefStmObj.length;
    const indexedDecoyBytes = new Uint8Array(
      Buffer.from(
        `${indexedDecoyBeforeXrefStm}${indexedDecoyXrefStmObj}xref\n0 5\n${fmtEntry(0, 65535, 'f')}${fmtEntry(validWordHybrid.offsets.get(1)!, 0, 'n')}${fmtEntry(validWordHybrid.offsets.get(2)!, 0, 'n')}${fmtEntry(validWordHybrid.offsets.get(3)!, 0, 'n')}${fmtEntry(validWordHybrid.offsets.get(4)!, 0, 'n')}11 1\n${fmtEntry(indexedDecoyOffset, 0, 'n')}trailer\n<< /Size 12 /Root 1 0 R /Info 9 0 R /XRefStm ${indexedDecoyXrefStmOff} >>\nstartxref\n${indexedDecoyClassicOff}\n%%EOF\n`,
        'latin1',
      ),
    );
    await assertRejectedBoth(indexedDecoyBytes);

    // 7. Corrupted /XRefStm offset, bounds, cycles, duplicate /Index, nested /XRefStm, /Encrypt, mismatched /Root, /Prev:
    // 7a. /XRefStm pointing to /ObjStm (wrong /Type) fails closed.
    const badTypeXrefStm = new Uint8Array(
      Buffer.from(
        baseStr.replace(`/XRefStm ${validWordHybrid.xrefStmOffset}`, `/XRefStm ${validWordHybrid.offsets.get(6)!}`),
        'latin1',
      ),
    );
    await assertRejectedBoth(badTypeXrefStm);

    // 7b. /XRefStm out of bounds (>= eofOffset), negative, or PDFRef fails closed.
    await assertRejectedBoth(
      new Uint8Array(
        Buffer.from(
          baseStr.replace(`/XRefStm ${validWordHybrid.xrefStmOffset}`, `/XRefStm ${baseStr.length}`),
          'latin1',
        ),
      ),
    );
    await assertRejectedBoth(
      new Uint8Array(
        Buffer.from(
          baseStr.replace(`/XRefStm ${validWordHybrid.xrefStmOffset}`, '/XRefStm -1'),
          'latin1',
        ),
      ),
    );
    await assertRejectedBoth(
      new Uint8Array(
        Buffer.from(
          baseStr.replace(`/XRefStm ${validWordHybrid.xrefStmOffset}`, '/XRefStm 10 0 R'),
          'latin1',
        ),
      ),
    );

    // 7c. /XRefStm cycle (pointing to startxrefOffset, or /Prev pointing to /XRefStm, or /XRefStm /Prev cycle).
    await assertRejectedBoth(
      new Uint8Array(
        Buffer.from(
          baseStr.replace(
            `/XRefStm ${validWordHybrid.xrefStmOffset}`,
            `/XRefStm ${validWordHybrid.classicXrefOffset}`,
          ),
          'latin1',
        ),
      ),
    );
    await assertRejectedBoth(
      new Uint8Array(
        Buffer.from(
          baseStr.replace(
            `/XRefStm ${validWordHybrid.xrefStmOffset}`,
            `/Prev ${validWordHybrid.xrefStmOffset} /XRefStm ${validWordHybrid.xrefStmOffset}`,
          ),
          'latin1',
        ),
      ),
    );

    // 7d. Duplicate object numbers inside /XRefStm /Index [9 1 9 1].
    const dupIdxRows = encodeXrefRows([
      { kind: 2, objStmNum: 6, index: 2 },
      { kind: 2, objStmNum: 6, index: 2 },
    ]);
    const dupIdxStreamOff = baseStr.length;
    const dupIdxStream = `11 0 obj\n<< /Type /XRef /Size 12 /Index [9 1 9 1] /W [1 4 2] /Root 1 0 R /Length ${dupIdxRows.byteLength} >>\nstream\n${Buffer.from(dupIdxRows).toString('latin1')}\nendstream\nendobj\n`;
    const dupIdxBytes = new Uint8Array(
      Buffer.from(
        `${baseStr}${dupIdxStream}xref\n11 1\n${fmtEntry(dupIdxStreamOff, 0, 'n')}trailer\n<< /Size 12 /Root 1 0 R /Prev ${validWordHybrid.classicXrefOffset} /XRefStm ${dupIdxStreamOff} >>\nstartxref\n${dupIdxStreamOff + dupIdxStream.length}\n%%EOF\n`,
        'latin1',
      ),
    );
    await assertRejectedBoth(dupIdxBytes);

    // 7e. Nested /XRefStm inside /XRefStm dict, /XRefStm inside pure /XRef stream, mismatched /Root, and /Encrypt in /XRefStm.
    await assertRejectedBoth(
      buildWordStyleHybridPdf({
        compressFontInObjStm: true,
        xrefStmDictExtra: '/XRefStm 10 ',
      }).bytes,
    );
    await assertRejectedBoth(
      buildWordStyleHybridPdf({
        compressFontInObjStm: true,
        includeXrefRoot: false,
        xrefStmDictExtra: '/Root 2 0 R ',
      }).bytes,
    );
    await assertRejectedBoth(
      buildWordStyleHybridPdf({
        compressFontInObjStm: true,
        xrefStmDictExtra: '/Encrypt 99 0 R ',
      }).bytes,
    );
    await assertRejectedBoth(
      buildWordStyleHybridPdf({
        compressFontInObjStm: true,
        xrefStmDictExtra: '/Prev 10 ',
      }).bytes,
    );
    const pureXrefStr = Buffer.from(
      makeRawXrefStreamPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
        ],
        [{ num: 5, body: '<< /Title (PURE) >>' }],
        4,
        6,
      ),
    ).toString('latin1');
    await assertRejectedBoth(
      new Uint8Array(Buffer.from(pureXrefStr.replace('/Root 1 0 R', '/Root 1 0 R /XRefStm 10'), 'latin1')),
    );

    // 7f. Lowercase #xx hex-escaped /XRefSt#6d or /Type /XRe#66 on a realistic hybrid PDF fails closed.
    await assertRejectedBoth(
      new Uint8Array(Buffer.from(baseStr.replace('/XRefStm ', '/XRefSt#6d '), 'latin1')),
    );
    await assertRejectedBoth(
      new Uint8Array(Buffer.from(baseStr.replace('/Type /XRef', '/Type /XRe#66'), 'latin1')),
    );
  });

  it('maps per-part partIsolated pages into isolatedPages before stampFields in multi-doc packets', async () => {
    const { createHash } = await import('node:crypto');

    const doc1 = await PDFDocument.create();
    doc1.addPage([595.28, 841.89]);
    const doc1Bytes = await doc1.save();

    const doc2 = await PDFDocument.create();
    const doc2Page = doc2.addPage([595.28, 841.89]);
    doc2Page.drawText('Existing doc2 body', { x: 40, y: 780, size: 12 });
    const apStream = doc2.context.stream('q 0.9 0.9 0.9 rg 0 0 100 40 re f Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 40],
    });
    const apRef = doc2.context.register(apStream);
    const annotRef = doc2.context.register(
      doc2.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [40, 620, 140, 660],
        AP: { N: apRef },
      }),
    );
    doc2Page.node.set(PDFName.of('Annots'), doc2.context.obj([annotRef]));
    const doc2Bytes = await doc2.save();

    const doc1Sha = createHash('sha256').update(doc1Bytes).digest('hex');
    const doc2Sha = createHash('sha256').update(doc2Bytes).digest('hex');
    const baseCert = makeCertificate();
    const sealed = await parse(
      'pdf_seal',
      Buffer.from(
        JSON.stringify({
          documents: [
            { title: 'Doc 1', pdfBase64: Buffer.from(doc1Bytes).toString('base64'), sourceSha256: doc1Sha },
            { title: 'Doc 2', pdfBase64: Buffer.from(doc2Bytes).toString('base64'), sourceSha256: doc2Sha },
          ],
          fields: [
            {
              type: 'text',
              page: 2,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.4,
              hNorm: 0.08,
              text: 'Doc 2 field',
            },
          ],
          certificate: { ...baseCert, sourceSha256: doc1Sha },
        }),
        'utf8',
      ),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') {
      throw new Error(`expected multi-doc seal to succeed, got: ${JSON.stringify(sealed)}`);
    }

    const sealedDoc = await PDFDocument.load(new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64')));
    const page2 = sealedDoc.getPage(1);
    const contents = page2.node.Contents();
    if (!(contents instanceof PDFArray)) {
      throw new Error('expected page 2 contents array');
    }
    const isolationEndMarkers: number[] = [];
    for (let i = 0; i < contents.size(); i++) {
      const streamObj = sealedDoc.context.lookup(contents.get(i));
      if (streamObj instanceof PDFStream) {
        const decoded = Buffer.from(decodePDFRawStream(streamObj as never).decode()).toString('latin1');
        if (decoded === '\nn\nQ\n') {
          isolationEndMarkers.push(i);
        }
      }
    }
    // Flattening isolated doc2 page 1 (packet page 2) once; stampFields must NOT wrap it a second time.
    expect(isolationEndMarkers).toHaveLength(1);
  });
});

function cbOcDocStream(doc: PDFDocument): PDFRef {
  return doc.context.register(
    doc.context.flateStream(Buffer.from('q Q', 'latin1'), {
      Type: PDFName.of('XObject'),
      Subtype: PDFName.of('Form'),
      BBox: [0, 0, 16, 16],
      OC: doc.context.obj({ Type: PDFName.of('OCMD'), P: PDFName.of('AnyOn'), VE: 'invalid_not_array' }),
    }),
  );
}
