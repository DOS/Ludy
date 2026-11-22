// SPDX-License-Identifier: AGPL-3.0-only
// Tests for eSign Slice 4a (#3817) stamp tag detection and pdf_seal PNG stamp rendering (<= 256 KB, zero SVG/XSS).
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePdfSealInput, type PdfSealInput } from '@ludy/extract-contract';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parse, parseDeterministicTagToken } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';

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

function makeRedStampPng(width = 96, height = 72): string {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 4;
      const dist = Math.hypot(x - width / 2, y - height / 2);
      const ring = Math.abs(dist - Math.min(width, height) * 0.38) <= 2.5;
      raw[px] = ring ? 210 : 255;
      raw[px + 1] = ring ? 24 : 255;
      raw[px + 2] = ring ? 36 : 255;
      raw[px + 3] = ring ? 255 : 0;
    }
  }
  return Buffer.concat([
    magic,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

async function makeContractPdfWithStampTag(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('DAI DIEN BEN A (Ky ten va dong dau)', { x: 72, y: 240, size: 12, font });
  page.drawText('{{stamp, r1, required, Dau cong ty}}', { x: 72, y: 180, size: 10, font });
  return Buffer.from(await doc.save());
}

describe('eSign Slice 4a stamp tag detection and pdf_seal rendering (#3817)', () => {
  it('parses {{stamp, r1}} deterministic PDF text tags and sizes the stamp bounding box', async () => {
    expect(parseDeterministicTagToken('stamp, r1, required, Con dau cong ty')).toEqual({
      fieldType: 'stamp',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: 'Con dau cong ty',
    });

    const pdfBytes = await makeContractPdfWithStampTag();
    const inspected = await parse('pdf_inspect', pdfBytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || inspected.kind !== 'pdf_inspect') return;
    expect(inspected.detectedTags).toHaveLength(1);
    expect(inspected.detectedTags[0]).toMatchObject({
      fieldType: 'stamp',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: 'Dau cong ty',
    });
    expect(inspected.detectedTags[0]!.wNorm).toBeGreaterThanOrEqual(0.14);
    expect(inspected.detectedTags[0]!.hNorm).toBeGreaterThanOrEqual(0.07);
  });

  it('embeds a validated PNG stamp inside the field bounding box and rejects SVG/markup or >256 KB payloads', async () => {
    const pdfBytes = await makeContractPdfWithStampTag();
    const stampPngBase64 = makeRedStampPng();

    const sealInput: PdfSealInput = {
      pdfBase64: pdfBytes.toString('base64'),
      fields: [
        {
          type: 'stamp',
          page: 1,
          xNorm: 0.12,
          yNorm: 0.68,
          wNorm: 0.2,
          hNorm: 0.12,
          imagePngBase64: stampPngBase64,
        },
      ],
      certificate: {
        certificateCode: 'CS-3817-STMP-0001',
        envelopeTitle: 'Hop dong dich vu dong dau cong ty',
        sourceSha256: 'a1b2c3d4'.repeat(8),
        completedAtIso: '2026-11-21T10:00:00.000Z',
        eventChainTipHash: 'f0e1d2c3'.repeat(8),
        signers: [
          {
            name: 'Van thu Cong ty A',
            roleLabel: 'Dong dau to chuc',
            maskedEmail: 'v***u@example.com',
            deliveryMode: 'email',
            otpStatus: 'not_required',
            signedAtIso: '2026-11-21T09:59:00.000Z',
            ipHashPrefix: '1122334455667788',
          },
        ],
      },
    };

    const sealed = await runSandboxed('pdf_seal', encodePdfSealInput(sealInput));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok || sealed.kind !== 'pdf_seal') return;
    expect(sealed.pageCount).toBe(2);
    const outDoc = await PDFDocument.load(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    expect(outDoc.getPageCount()).toBe(2);

    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const badInput: PdfSealInput = {
      ...sealInput,
      fields: [
        {
          type: 'stamp',
          page: 1,
          xNorm: 0.12,
          yNorm: 0.68,
          wNorm: 0.2,
          hNorm: 0.12,
          imagePngBase64: svgBytes.toString('base64'),
        },
      ],
    };
    const rejected = await runSandboxed('pdf_seal', encodePdfSealInput(badInput));
    expect(rejected.ok).toBe(false);

    const oversizedPngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(262_200, 0x41),
    ]);
    const oversizedInput: PdfSealInput = {
      ...sealInput,
      fields: [
        {
          type: 'stamp',
          page: 1,
          xNorm: 0.12,
          yNorm: 0.68,
          wNorm: 0.2,
          hNorm: 0.12,
          imagePngBase64: oversizedPngBytes.toString('base64'),
        },
      ],
    };
    expect(() => encodePdfSealInput(oversizedInput)).toThrow(/Too big/);
    const rejectedOversized = await parse('pdf_seal', Buffer.from(JSON.stringify(oversizedInput), 'utf8'));
    expect(rejectedOversized.ok).toBe(false);
  });
});
