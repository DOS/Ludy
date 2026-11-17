// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  EXTRACT_LIMITS,
  encodePdfSealInput,
  type PdfSealInput,
} from '@crove/extract-contract';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  extractPageDeterministicTags,
  parse,
  parseDeterministicTagToken,
} from '../src/parse.ts';
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

function makeSignaturePng(width = 64, height = 24): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
      const ink = Math.abs(x - y * 2) <= 2;
      raw[px] = ink ? 12 : 255;
      raw[px + 1] = ink ? 42 : 255;
      raw[px + 2] = ink ? 118 : 255;
      raw[px + 3] = ink ? 255 : 0;
    }
  }
  const pngBytes = Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
  return pngBytes.toString('base64');
}

function makeCertificate(overrides: Partial<PdfSealInput['certificate']> = {}): PdfSealInput['certificate'] {
  return {
    certificateCode: 'CS-3552-ABCD-EF01',
    envelopeTitle: 'Hợp đồng cung cấp dịch vụ phần mềm Ludy eSign',
    sourceSha256: '1a2b3c4d'.repeat(8),
    completedAtIso: '2026-11-17T08:15:00.000Z',
    eventChainTipHash: '9f8e7d6c'.repeat(8),
    signers: [
      {
        name: 'Nguyễn Minh Quân',
        roleLabel: 'Đại diện Bên A',
        maskedEmail: 'q***n@example.com',
        deliveryMode: 'email',
        otpStatus: 'verified',
        signedAtIso: '2026-11-17T08:10:00.000Z',
        ipHashPrefix: 'aabbccdd11223344',
        signatureKind: 'draw',
      },
      {
        name: 'Lê Hoàng Thảo Vy',
        roleLabel: 'Giám đốc Bên B',
        maskedEmail: 'v***y@example.com',
        deliveryMode: 'link',
        otpStatus: 'not_required',
        signedAtIso: '2026-11-17T08:15:00.000Z',
        ipHashPrefix: '5566778899aabbcc',
        signatureKind: 'type',
      },
    ],
    ...overrides,
  };
}

async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const proxy = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
  } as Parameters<typeof getDocumentProxy>[1]);
  try {
    const out = await extractText(proxy, { mergePages: false });
    return Array.isArray(out.text) ? out.text : [out.text];
  } finally {
    if (typeof proxy.cleanup === 'function') {
      await Promise.resolve(proxy.cleanup()).catch(() => {});
    }
  }
}

describe('deterministic PDF text tags (pdf_inspect, #3552)', () => {
  it('parses valid tag variants and rejects malformed tag bodies', () => {
    expect(parseDeterministicTagToken('signature, r1')).toEqual({
      fieldType: 'signature',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
    });
    expect(parseDeterministicTagToken('SIG, R50')).toEqual({
      fieldType: 'signature',
      roleOrder: 50,
      roleKey: 'r50',
      required: true,
      label: null,
    });
    expect(parseDeterministicTagToken('initial, r2:optional')).toEqual({
      fieldType: 'initials',
      roleOrder: 2,
      roleKey: 'r2',
      required: false,
      label: null,
    });
    expect(parseDeterministicTagToken('initials, r3:Ký nháy trang')).toEqual({
      fieldType: 'initials',
      roleOrder: 3,
      roleKey: 'r3',
      required: true,
      label: 'Ký nháy trang',
    });
    expect(parseDeterministicTagToken('text, r4:optional:Chức danh, phòng ban')).toEqual({
      fieldType: 'text',
      roleOrder: 4,
      roleKey: 'r4',
      required: false,
      label: 'Chức danh, phòng ban',
    });
    expect(parseDeterministicTagToken('check, r5, optional')).toEqual({
      fieldType: 'checkbox',
      roleOrder: 5,
      roleKey: 'r5',
      required: false,
      label: null,
    });

    for (const invalid of [
      '',
      'signature',
      'signature, r0',
      'signature, r01',
      'signature, r51',
      'signature, role1',
      'unknown, r1',
      'text, r1:',
      'text, r1::optional',
      'text, r1:optional:required',
      'text, r1:Label1:Label2',
      'text, {r1}',
      'text, r1\n',
    ]) {
      expect(parseDeterministicTagToken(invalid), invalid).toBeNull();
    }
  });

  it(
    'extracts all 5 field types across multiple pages, handles split inline runs, ignores malformed tags, and runs in sandbox',
    async () => {
      const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const p1 = doc.addPage([600, 800]);
    p1.drawText('Party A: {{signature, r1}}   Signed date: {{date, r1}}', {
      x: 50,
      y: 680,
      size: 12,
      font,
    });
    p1.drawText('Ignore bad: {{unknown, r1}} {{signature, r0}} {{signature, r51}} {{unclosed and {{Initials, R1:optional}}', {
      x: 50,
      y: 620,
      size: 11,
      font,
    });
    // Simulate Word/Google Docs spellcheck splitting a tag across three contiguous Tj runs on the same baseline.
    p1.drawText('{{', { x: 80, y: 540, size: 12, font });
    p1.drawText('checkbox, r1', { x: 80 + font.widthOfTextAtSize('{{', 12), y: 540, size: 12, font });
    p1.drawText('}}', {
      x: 80 + font.widthOfTextAtSize('{{checkbox, r1', 12),
      y: 540,
      size: 12,
      font,
    });

    const p2 = doc.addPage([600, 800]);
    p2.drawText('Party B Title: {{text, r2:optional:Representative Title}}', {
      x: 60,
      y: 500,
      size: 12,
      font,
    });
    p2.drawText('Party B Sign: {{sig, r2}}', {
      x: 340,
      y: 220,
      size: 12,
      font,
    });

    const pdfBytes = await doc.save();
    const res = await runSandboxed('pdf_inspect', pdfBytes);
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect success');

    expect(res.detectedTags).toHaveLength(6);
    const [sig1, date1, init1, check1, text2, sig2] = res.detectedTags;

    expect(sig1).toMatchObject({
      pageNumber: 1,
      fieldType: 'signature',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
    });
    expect(date1).toMatchObject({
      pageNumber: 1,
      fieldType: 'date',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
    });
    // Date tag sits to the right of Signature tag on the same line.
    expect(sig1!.xNorm).toBeGreaterThan(0.08);
    expect(date1!.xNorm).toBeGreaterThan(sig1!.xNorm + 0.15);

    expect(init1).toMatchObject({
      pageNumber: 1,
      fieldType: 'initials',
      roleOrder: 1,
      roleKey: 'r1',
      required: false,
      label: null,
    });
    expect(check1).toMatchObject({
      pageNumber: 1,
      fieldType: 'checkbox',
      roleOrder: 1,
      roleKey: 'r1',
      required: true,
      label: null,
    });
    expect(text2).toMatchObject({
      pageNumber: 2,
      fieldType: 'text',
      roleOrder: 2,
      roleKey: 'r2',
      required: false,
      label: 'Representative Title',
    });
    expect(sig2).toMatchObject({
      pageNumber: 2,
      fieldType: 'signature',
      roleOrder: 2,
      roleKey: 'r2',
      required: true,
      label: null,
    });

    for (const tag of res.detectedTags) {
      expect(tag.xNorm).toBeGreaterThanOrEqual(0);
      expect(tag.yNorm).toBeGreaterThanOrEqual(0);
      expect(tag.xNorm + tag.wNorm).toBeLessThanOrEqual(1);
      expect(tag.yNorm + tag.hNorm).toBeLessThanOrEqual(1);
    }

    // Verify extracted coordinates seal cleanly back through pdf_seal without bounds errors.
    const pngBase64 = makeSignaturePng();
    const sealRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(pdfBytes).toString('base64'),
        fields: res.detectedTags.map((tag) => {
          if (tag.fieldType === 'signature') {
            return {
              type: 'signature' as const,
              page: tag.pageNumber,
              xNorm: tag.xNorm,
              yNorm: tag.yNorm,
              wNorm: tag.wNorm,
              hNorm: tag.hNorm,
              imagePngBase64: pngBase64,
            };
          }
          if (tag.fieldType === 'initials') {
            return {
              type: 'initial' as const,
              page: tag.pageNumber,
              xNorm: tag.xNorm,
              yNorm: tag.yNorm,
              wNorm: tag.wNorm,
              hNorm: tag.hNorm,
              text: 'NMQ',
            };
          }
          if (tag.fieldType === 'checkbox') {
            return {
              type: 'checkbox' as const,
              page: tag.pageNumber,
              xNorm: tag.xNorm,
              yNorm: tag.yNorm,
              wNorm: tag.wNorm,
              hNorm: tag.hNorm,
              checked: true,
            };
          }
          return {
            type: tag.fieldType,
            page: tag.pageNumber,
            xNorm: tag.xNorm,
            yNorm: tag.yNorm,
            wNorm: tag.wNorm,
            hNorm: tag.hNorm,
            text: tag.fieldType === 'date' ? '17/11/2026' : 'Giám đốc điều hành',
          };
        }),
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(pdfBytes).digest('hex') }),
      }),
    );
    expect(sealRes).toMatchObject({ ok: true, kind: 'pdf_seal', pageCount: 3 });
  }, 20_000);

  it('computes accurate top-left visual coordinates across 0, 90, 180, and 270 degree page rotations and clamps edge boxes', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    // Page 1: rotation 0, near right and bottom edges so target signature box (128x36 pt) exceeds [600, 800] without clamping.
    const p0 = doc.addPage([600, 800]);
    p0.drawText('{{signature, r1}}', { x: 490, y: 8, size: 10, font });

    // Page 2: media [400, 600] rotated 90 deg -> visual 600 wide x 400 tall.
    // Top-left visual quadrant corresponds to small px (near 0 -> small vy) and small py (near 0 -> small vx).
    const p90 = doc.addPage([400, 600]);
    p90.setRotation(degrees(90));
    p90.drawText('{{date, r2}}', { x: 80, y: 60, size: 12, font, rotate: degrees(90) });

    // Page 3: media [600, 800] rotated 180 deg -> visual top-left corresponds to high px, low py.
    const p180 = doc.addPage([600, 800]);
    p180.setRotation(degrees(180));
    p180.drawText('{{text, r3}}', { x: 520, y: 100, size: 12, font, rotate: degrees(180) });

    // Page 4: media [400, 600] rotated 270 deg -> visual 600 wide x 400 tall; top-left corresponds to high px, high py.
    const p270 = doc.addPage([400, 600]);
    p270.setRotation(degrees(270));
    p270.drawText('{{check, r4}}', { x: 320, y: 520, size: 12, font, rotate: degrees(270) });

    const res = await parse('pdf_inspect', await doc.save());
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect');

    expect(res.detectedTags).toHaveLength(4);
    const [t0, t90, t180, t270] = res.detectedTags;

    // Clamped strictly inside [0, 1] at right/bottom corner.
    expect(t0!.xNorm + t0!.wNorm).toBeLessThanOrEqual(1);
    expect(t0!.yNorm + t0!.hNorm).toBeLessThanOrEqual(1);
    expect(t0!.xNorm).toBeGreaterThan(0.5);
    expect(t0!.yNorm).toBeGreaterThan(0.8);

    // Rotated 90, 180, 270 tags all sit in the upper-left visual quadrant (xNorm < 0.35, yNorm < 0.35).
    for (const rotatedTag of [t90, t180, t270]) {
      expect(rotatedTag).toBeDefined();
      expect(rotatedTag!.xNorm).toBeGreaterThanOrEqual(0);
      expect(rotatedTag!.xNorm).toBeLessThan(0.35);
      expect(rotatedTag!.yNorm).toBeGreaterThanOrEqual(0);
      expect(rotatedTag!.yNorm).toBeLessThan(0.35);
      expect(rotatedTag!.xNorm + rotatedTag!.wNorm).toBeLessThanOrEqual(1);
      expect(rotatedTag!.yNorm + rotatedTag!.hNorm).toBeLessThanOrEqual(1);
    }
  });

  it('caps detected tags at 200 per document without failing pdf_inspect', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    let emitted = 0;
    for (let p = 0; p < 5; p++) {
      const page = doc.addPage([600, 800]);
      for (let row = 0; row < 47; row++) {
        emitted += 1;
        const roleOrder = ((emitted - 1) % 50) + 1;
        page.drawText(`Item ${emitted}: {{text, r${roleOrder}}}`, {
          x: 40,
          y: 760 - row * 15,
          size: 9,
          font,
        });
      }
    }
    expect(emitted).toBe(235);

    const res = await parse('pdf_inspect', await doc.save());
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect');

    expect(res.pageCount).toBe(5);
    expect(res.detectedTags).toHaveLength(EXTRACT_LIMITS.maxPdfDetectedTags);
    expect(res.detectedTags).toHaveLength(200);
    expect(res.detectedTags[0]?.pageNumber).toBe(1);
    expect(res.detectedTags[199]?.pageNumber).toBe(5);
  });

  it('clamps extreme synthetic coordinates in extractPageDeterministicTags', () => {
    const tags = extractPageDeterministicTags({
      pageNumber: 1,
      box: { x: 0, y: 0, width: 500, height: 500 },
      rotation: 0,
      userUnit: 1,
      items: [
        { str: '{{signature, r1}}', width: 80, height: 12, transform: [12, 0, 0, 12, -50, 520] },
        { str: '{{date, r2}}', width: 80, height: 12, transform: [12, 0, 0, 12, 495, -20] },
      ],
    });
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag.xNorm).toBeGreaterThanOrEqual(0);
      expect(tag.xNorm).toBeLessThan(1);
      expect(tag.yNorm).toBeGreaterThanOrEqual(0);
      expect(tag.yNorm).toBeLessThan(1);
      expect(tag.xNorm + tag.wNorm).toBeLessThanOrEqual(1);
      expect(tag.yNorm + tag.hNorm).toBeLessThanOrEqual(1);
    }
  });
});

describe('Audit Certificate summary page size matching (pdf_seal, #3552)', () => {
  it.each([
    { name: 'A4 portrait', width: 595.28, height: 841.89 },
    { name: '16:9 landscape slide deck', width: 960, height: 540 },
    { name: 'US Letter portrait', width: 612, height: 792 },
    { name: 'US Legal portrait', width: 612, height: 1008 },
    { name: 'A5 portrait', width: 419.53, height: 595.28 },
    { name: 'A5 landscape', width: 595.28, height: 419.53 },
  ])('matches appended certificate page size to $name ($width x $height pt) without clipping digests', async ({ width, height }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([width, height]);
    page.drawText('Contract body', { x: 40, y: height - 60, size: 12, font });
    const srcBytes = await doc.save();
    const sourceSha256 = createHash('sha256').update(srcBytes).digest('hex');
    const tipHash = 'c3d4e5f6'.repeat(8);

    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(srcBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({ sourceSha256, eventChainTipHash: tipHash }),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal');

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const checkDoc = await PDFDocument.load(sealedBytes);
    expect(checkDoc.getPageCount()).toBe(2);

    const certPage = checkDoc.getPage(1);
    const media = certPage.getMediaBox();
    const crop = certPage.getCropBox();
    expect(media.width).toBeCloseTo(width, 2);
    expect(media.height).toBeCloseTo(height, 2);
    expect(crop.width).toBeCloseTo(width, 2);
    expect(crop.height).toBeCloseTo(height, 2);
    expect(certPage.getRotation().angle).toBe(0);

    const pageTexts = await extractPageTexts(sealedBytes);
    const certText = (pageTexts[1] ?? '').replace(/\s+/g, '');
    expect(certText).toContain('CS-3552-ABCD-EF01');
    expect(certText).toContain(sourceSha256);
    expect(certText).toContain(tipHash);
    expect(pageTexts[1]).toContain('Nguyễn Minh Quân');
    expect(pageTexts[1]).toContain('Lê Hoàng Thảo Vy');
  });

  it('matches effective visual dimensions when the last page is rotated 90 degrees and paginates multi-signer overflow at the same size', async () => {
    const doc = await PDFDocument.create();
    // Page 1 is A4 portrait; Page 2 (last page) is Letter [612, 792] rotated 90 -> effective 792 x 612 landscape.
    doc.addPage([595.28, 841.89]);
    const lastPage = doc.addPage([612, 792]);
    lastPage.setRotation(degrees(90));
    const srcBytes = await doc.save();

    const baseCert = makeCertificate({
      sourceSha256: createHash('sha256').update(srcBytes).digest('hex'),
    });
    const templateSigner = baseCert.signers[0]!;
    const manySigners = Array.from({ length: 14 }, (_, idx) => ({
      ...templateSigner,
      name: `Người ký xác thực số ${idx + 1}`,
      roleLabel: `Bên tham gia ${idx + 1}`,
    }));

    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(srcBytes).toString('base64'),
        fields: [],
        certificate: { ...baseCert, signers: manySigners },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal');
    expect(res.pageCount).toBeGreaterThanOrEqual(4);

    const sealedBytes = new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64'));
    const checkDoc = await PDFDocument.load(sealedBytes);
    for (let p = 2; p < checkDoc.getPageCount(); p++) {
      const certPage = checkDoc.getPage(p);
      const media = certPage.getMediaBox();
      expect(media.width).toBeCloseTo(792, 2);
      expect(media.height).toBeCloseTo(612, 2);
      expect(certPage.getRotation().angle).toBe(0);
    }

    const pageTexts = await extractPageTexts(sealedBytes);
    const combinedCertText = pageTexts.slice(2).join('\n');
    expect(combinedCertText).toContain('Người ký xác thực số 1');
    expect(combinedCertText).toContain('Người ký xác thực số 14');
  });

  it('falls back cleanly to A4 when the source last page has tiny degenerate dimensions', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([120, 90]);
    const srcBytes = await doc.save();

    const res = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(srcBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({ sourceSha256: createHash('sha256').update(srcBytes).digest('hex') }),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_seal') throw new Error('expected pdf_seal');

    const checkDoc = await PDFDocument.load(new Uint8Array(Buffer.from(res.sealedPdfBase64, 'base64')));
    const certMedia = checkDoc.getPage(1).getMediaBox();
    expect(certMedia.width).toBeCloseTo(595.28, 2);
    expect(certMedia.height).toBeCloseTo(841.89, 2);
  });

  it('positions inline tags accurately inside proportional Helvetica, Courier, and NFD text runs, and seals 280x360 narrow pages', async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const courier = await doc.embedFont(StandardFonts.Courier);
    const page = doc.addPage([600, 800]);

    // Line 1: wide 'W' prefix + tag + many narrow ' i' characters in proportional Helvetica.
    const prefix1 = 'WWWWWWWWWW ';
    const tag1 = '{{signature, r1}}';
    const suffix1 = ' i'.repeat(60);
    page.drawText(prefix1 + tag1 + suffix1, { x: 40, y: 700, size: 12, font: helv });
    const expectedX1Norm = (40 + helv.widthOfTextAtSize(prefix1, 12)) / 600;

    // Line 2: Courier monospace inline run.
    const prefix2 = 'WWWWWWWWWW ';
    const tag2 = '{{date, r2}}';
    const suffix2 = ' i'.repeat(30);
    page.drawText(prefix2 + tag2 + suffix2, { x: 40, y: 600, size: 10, font: courier });
    const expectedX2Norm = (40 + courier.widthOfTextAtSize(prefix2, 10)) / 600;

    const inspectBytes = await doc.save();
    const inspectRes = await parse('pdf_inspect', inspectBytes);
    expect(inspectRes.ok).toBe(true);
    if (!inspectRes.ok || inspectRes.kind !== 'pdf_inspect') throw new Error('expected pdf_inspect');
    expect(inspectRes.detectedTags).toHaveLength(2);
    expect(inspectRes.detectedTags[0]!.xNorm).toBeCloseTo(expectedX1Norm, 2);
    expect(inspectRes.detectedTags[1]!.xNorm).toBeCloseTo(expectedX2Norm, 2);

    // Also verify NFD combining marks do not inflate prefix advance in direct unit extraction.
    const nfdPrefix = 'Nguye\u0302\u0303n Va\u0306n A: ';
    const nfdTags = extractPageDeterministicTags({
      pageNumber: 1,
      box: { x: 0, y: 0, width: 600, height: 800 },
      rotation: 0,
      userUnit: 1,
      items: [
        {
          str: `${nfdPrefix}{{text, r1}}` + ' i'.repeat(40),
          width: 280,
          height: 12,
          transform: [12, 0, 0, 12, 50, 500],
        },
      ],
    });
    expect(nfdTags).toHaveLength(1);
    expect(nfdTags[0]!.xNorm).toBeGreaterThan(50 / 600);
    expect(nfdTags[0]!.xNorm).toBeLessThan(0.32);

    // Minimum supported non-fallback certificate size (280 x 360 pt) wraps header and subtitle cleanly.
    const narrowDoc = await PDFDocument.create();
    narrowDoc.addPage([280, 360]);
    const narrowBytes = await narrowDoc.save();
    const sealRes = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(narrowBytes).toString('base64'),
        fields: [],
        certificate: makeCertificate({
          sourceSha256: createHash('sha256').update(narrowBytes).digest('hex'),
        }),
      }),
    );
    expect(sealRes.ok).toBe(true);
    if (!sealRes.ok || sealRes.kind !== 'pdf_seal') throw new Error('expected pdf_seal');
    const sealedDoc = await PDFDocument.load(new Uint8Array(Buffer.from(sealRes.sealedPdfBase64, 'base64')));
    expect(sealedDoc.getPage(1).getMediaBox().width).toBeCloseTo(280, 2);
    expect(sealedDoc.getPage(1).getMediaBox().height).toBeCloseTo(360, 2);
  });
});
