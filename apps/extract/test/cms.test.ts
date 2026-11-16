// SPDX-License-Identifier: AGPL-3.0-only
// Tests for crove-extract pdf_embed_cms: exact /ByteRange math, /Contents hex extraction,
// incremental AcroForm + PAdES-LTV /DSS preservation on both classic and XRef-stream PDFs,
// active-content/encrypted PDF refusal, limit enforcement, and sandboxed/HTTP execution.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXTRACT_LIMITS,
  encodePdfEmbedCmsInput,
  encodePdfSealInput,
  zExtractResponse,
  type PdfEmbedCmsInput,
  type PdfSealInput,
} from '@crove/extract-contract';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { inspectPdf } from '../src/seal.ts';
import { createExtractApp } from '../src/server.ts';

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derSequence(payload: Uint8Array): Uint8Array {
  const len = encodeDerLength(payload.byteLength);
  const out = new Uint8Array(1 + len.byteLength + payload.byteLength);
  out[0] = 0x30;
  out.set(len, 1);
  out.set(payload, 1 + len.byteLength);
  return out;
}

function makeTestCmsDer(marker = 'test-cms-signature-payload'): Uint8Array {
  const inner = new TextEncoder().encode(marker);
  const octet = new Uint8Array(2 + inner.byteLength);
  octet[0] = 0x04;
  octet[1] = inner.byteLength;
  octet.set(inner, 2);
  return derSequence(octet);
}

function makeRawPdf(objects: string[], trailerExtra = ''): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
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

function makeCleanClassicPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 72 720 Td (Hop dong thu nghiem) Tj ET';
  return makeRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertByteRangeAndCms(
  outBytes: Uint8Array,
  byteRange: readonly [number, number, number, number],
  expectedCmsDer: Uint8Array,
  options: { readonly allowTrailingUpdate?: boolean } = {},
): void {
  const [start, offset1, offset2, len2] = byteRange;
  expect(start).toBe(0);
  expect(offset1).toBeGreaterThan(0);
  expect(offset2).toBeGreaterThan(offset1 + 2);
  if (options.allowTrailingUpdate) {
    expect(offset2 + len2).toBeLessThanOrEqual(outBytes.byteLength);
    expect(Buffer.from(outBytes.subarray(Math.max(0, offset2 + len2 - 12), offset2 + len2)).toString('ascii')).toContain(
      '%%EOF',
    );
  } else {
    expect(offset2 + len2).toBe(outBytes.byteLength);
  }

  // ByteRange slices wrap the exact `<...>` /Contents hex string.
  expect(outBytes[offset1]).toBe(0x3c); // '<'
  expect(outBytes[offset2 - 1]).toBe(0x3e); // '>'

  const slice1 = outBytes.subarray(0, offset1);
  const slice2 = outBytes.subarray(offset2, offset2 + len2);
  expect(slice1.byteLength).toBe(offset1);
  expect(slice2.byteLength).toBe(len2);
  expect(slice1.byteLength + (offset2 - offset1) + slice2.byteLength).toBe(offset2 + len2);

  const rawText = Buffer.from(outBytes.subarray(0, offset2 + len2)).toString('latin1');
  expect(rawText).toContain(`/ByteRange [0 ${offset1} ${offset2} ${len2}]`);

  const hexPayload = Buffer.from(outBytes.subarray(offset1 + 1, offset2 - 1)).toString('ascii');
  expect(hexPayload.length % 2).toBe(0);
  expect(hexPayload).toMatch(/^[0-9a-f]+$/);
  const expectedHex = Buffer.from(expectedCmsDer).toString('hex');
  expect(hexPayload.startsWith(expectedHex)).toBe(true);
  const padding = hexPayload.slice(expectedHex.length);
  expect(padding).toMatch(/^0*$/);
}

describe('crove-extract pdf_embed_cms', () => {
  it('embeds CMS signature incrementally into a classic PDF with exact ByteRange, Vietnamese metadata, and intact original prefix', async () => {
    const origPdf = makeCleanClassicPdf();
    const cmsDer = makeTestCmsDer('cms-classic-01');
    const input: PdfEmbedCmsInput = {
      pdfBase64: Buffer.from(origPdf).toString('base64'),
      cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
      signerName: 'Nguyễn Văn Ánh',
      reason: 'Phê duyệt hợp đồng dịch vụ',
      location: 'TP. Hồ Chí Minh',
      signedAtIso: '2026-11-16T08:30:00.000Z',
    };

    const res = await parse('pdf_embed_cms', encodePdfEmbedCmsInput(input));
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'pdf_embed_cms') throw new Error('expected pdf_embed_cms success');

    const outBytes = new Uint8Array(Buffer.from(res.pdfBase64, 'base64'));
    expect(res.signedSha256).toBe(sha256Hex(outBytes));
    expect(Buffer.compare(outBytes.subarray(0, origPdf.byteLength), origPdf)).toBe(0);
    assertByteRangeAndCms(outBytes, res.byteRange, cmsDer);

    // Reload via both pdf-lib and inspectPdf (runs full seal.ts xref & security verification).
    const doc = await PDFDocument.load(outBytes);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.lookup(PDFName.of('SigFlags'), PDFNumber).asNumber()).toBe(3);
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(1);
    const widget = doc.context.lookup(fields.get(0), PDFDict);
    expect(widget.lookup(PDFName.of('FT'), PDFName).decodeText()).toBe('Sig');
    const sig = widget.lookup(PDFName.of('V'), PDFDict);
    expect(sig.lookup(PDFName.of('Type'), PDFName).decodeText()).toBe('Sig');
    expect(sig.lookup(PDFName.of('Filter'), PDFName).decodeText()).toBe('Adobe.PPKLite');
    expect(sig.lookup(PDFName.of('SubFilter'), PDFName).decodeText()).toBe('ETSI.CAdES.detached');
    expect((sig.lookup(PDFName.of('Name')) as PDFHexString).decodeText()).toBe('Nguyễn Văn Ánh');
    expect((sig.lookup(PDFName.of('Reason')) as PDFHexString).decodeText()).toBe('Phê duyệt hợp đồng dịch vụ');
    expect((sig.lookup(PDFName.of('Location')) as PDFHexString).decodeText()).toBe('TP. Hồ Chí Minh');
    expect((sig.lookup(PDFName.of('M')) as PDFString).decodeText()).toBe('D:20261116083000Z');

    const inspected = await inspectPdf(outBytes);
    expect(inspected.pageCount).toBe(1);
    expect(inspected.pages[0]?.text).toContain('Hop dong thu nghiem');
  });

  it('embeds CMS cleanly into pdf_seal output (PDF 1.5+ object streams & XRef streams) and supports sequential multi-signing', async () => {
    const basePdf = makeCleanClassicPdf();
    const sealInput: PdfSealInput = {
      pdfBase64: Buffer.from(basePdf).toString('base64'),
      fields: [
        { type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.4, hNorm: 0.1, text: 'Đã đồng ý' },
      ],
      certificate: {
        certificateCode: 'CS-1111-2222-3333',
        envelopeTitle: 'Hợp đồng số 1',
        sourceSha256: sha256Hex(basePdf),
        completedAtIso: '2026-11-16T09:00:00.000Z',
        eventChainTipHash: 'c'.repeat(64),
        signers: [
          {
            name: 'Trần Thị Bình',
            roleLabel: 'Bên A',
            maskedEmail: 't***@example.vn',
            deliveryMode: 'link',
            otpStatus: 'not_required',
            signedAtIso: '2026-11-16T09:00:00.000Z',
            ipHashPrefix: 'abcd1234',
          },
        ],
      },
    };
    const sealed = await parse('pdf_seal', encodePdfSealInput(sealInput));
    if (!sealed.ok || sealed.kind !== 'pdf_seal') throw new Error('expected pdf_seal success');
    const sealedBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));

    // Sign #1
    const cms1 = makeTestCmsDer('ca-signature-1');
    const sign1 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: sealed.sealedPdfBase64,
        cmsDerBase64: Buffer.from(cms1).toString('base64'),
        signerName: 'Công ty Cổ phần A',
        signedAtIso: '2026-11-16T09:05:00.000Z',
      }),
    );
    if (!sign1.ok || sign1.kind !== 'pdf_embed_cms') throw new Error('expected sign1 success');
    const signed1Bytes = new Uint8Array(Buffer.from(sign1.pdfBase64, 'base64'));
    expect(Buffer.compare(signed1Bytes.subarray(0, sealedBytes.byteLength), sealedBytes)).toBe(0);
    assertByteRangeAndCms(signed1Bytes, sign1.byteRange, cms1);

    // Sign #2 sequentially on top of Sign #1
    const cms2 = makeTestCmsDer('ca-signature-2');
    const sign2 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: sign1.pdfBase64,
        cmsDerBase64: Buffer.from(cms2).toString('base64'),
        signerName: 'Công ty TNHH B',
        signedAtIso: '2026-11-16T09:10:00.000Z',
        subFilter: 'adbe.pkcs7.detached',
      }),
    );
    if (!sign2.ok || sign2.kind !== 'pdf_embed_cms') throw new Error('expected sign2 success');
    const signed2Bytes = new Uint8Array(Buffer.from(sign2.pdfBase64, 'base64'));
    expect(Buffer.compare(signed2Bytes.subarray(0, signed1Bytes.byteLength), signed1Bytes)).toBe(0);
    assertByteRangeAndCms(signed2Bytes, sign2.byteRange, cms2);

    const doc = await PDFDocument.load(signed2Bytes);
    const fields = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(2);
    const f1Name = doc.context.lookup(fields.get(0), PDFDict).lookup(PDFName.of('T'), PDFString).decodeText();
    const f2Name = doc.context.lookup(fields.get(1), PDFDict).lookup(PDFName.of('T'), PDFString).decodeText();
    expect(f1Name).toBe('Signature1');
    expect(f2Name).toBe('Signature2');

    const inspected = await inspectPdf(signed2Bytes);
    expect(inspected.pageCount).toBe(sealed.pageCount);
  });

  it('produces identical ByteRange digest in two-step prepare and embed flow', async () => {
    const basePdf = makeCleanClassicPdf();
    const baseInput = {
      pdfBase64: Buffer.from(basePdf).toString('base64'),
      signerName: 'Lê Hoàng Nam',
      reason: 'Ký số xác nhận',
      location: 'Hà Nội',
      signedAtIso: '2026-11-16T10:00:00.000Z',
      placeholderBytes: 8192,
    } as const;

    const prepared = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...baseInput,
        cmsDerBase64: Buffer.from(new Uint8Array([0x30, 0x00])).toString('base64'),
      }),
    );
    if (!prepared.ok || prepared.kind !== 'pdf_embed_cms') throw new Error('expected prepare success');
    const preparedBytes = new Uint8Array(Buffer.from(prepared.pdfBase64, 'base64'));
    const [b0, b1, b2, b3] = prepared.byteRange;
    const preDigest = sha256Hex(
      Buffer.concat([preparedBytes.subarray(b0, b1), preparedBytes.subarray(b2, b2 + b3)]),
    );

    const signedCms = makeTestCmsDer(`signed-digest:${preDigest}`);
    const embedded = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...baseInput,
        cmsDerBase64: Buffer.from(signedCms).toString('base64'),
      }),
    );
    if (!embedded.ok || embedded.kind !== 'pdf_embed_cms') throw new Error('expected embed success');
    expect(embedded.byteRange).toEqual(prepared.byteRange);

    const finalBytes = new Uint8Array(Buffer.from(embedded.pdfBase64, 'base64'));
    const postDigest = sha256Hex(
      Buffer.concat([finalBytes.subarray(b0, b1), finalBytes.subarray(b2, b2 + b3)]),
    );
    expect(postDigest).toBe(preDigest);
    assertByteRangeAndCms(finalBytes, embedded.byteRange, signedCms);
  });

  it('embeds optional PAdES-LTV DSS timestamp and OCSP in a post-signature revision without changing ByteRange digest and merges sequential DSS', async () => {
    const basePdf = makeCleanClassicPdf();
    const commonBase = {
      pdfBase64: Buffer.from(basePdf).toString('base64'),
      signerName: 'Phạm Minh Tuấn',
      signedAtIso: '2026-11-16T11:00:00.000Z',
      placeholderBytes: 4096,
    } as const;

    const prepared = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...commonBase,
        cmsDerBase64: Buffer.from(new Uint8Array([0x30, 0x00])).toString('base64'),
      }),
    );
    if (!prepared.ok || prepared.kind !== 'pdf_embed_cms') throw new Error('expected prepare success');
    const prepBytes = new Uint8Array(Buffer.from(prepared.pdfBase64, 'base64'));
    const [b0, b1, b2, b3] = prepared.byteRange;
    const preDigest = sha256Hex(Buffer.concat([prepBytes.subarray(b0, b1), prepBytes.subarray(b2, b2 + b3)]));

    const cmsDer = makeTestCmsDer('ltv-cms-1');
    const tsDer = derSequence(new Uint8Array([0x02, 0x01, 0x01]));
    const ocspDer = derSequence(new Uint8Array([0x0a, 0x01, 0x00]));

    const res = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...commonBase,
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        timestampTokenBase64: Buffer.from(tsDer).toString('base64'),
        ocspResponsesBase64: [Buffer.from(ocspDer).toString('base64')],
      }),
    );
    if (!res.ok || res.kind !== 'pdf_embed_cms') throw new Error('expected LTV embed success');
    expect(res.byteRange).toEqual(prepared.byteRange);

    const outBytes = new Uint8Array(Buffer.from(res.pdfBase64, 'base64'));
    expect(res.signedSha256).toBe(sha256Hex(outBytes));
    const postDigest = sha256Hex(Buffer.concat([outBytes.subarray(b0, b1), outBytes.subarray(b2, b2 + b3)]));
    expect(postDigest).toBe(preDigest);
    assertByteRangeAndCms(outBytes, res.byteRange, cmsDer, { allowTrailingUpdate: true });

    // Sequential second signature with LTV merges into existing /DSS rather than overwriting.
    const cmsDer2 = makeTestCmsDer('ltv-cms-2');
    const tsDer2 = derSequence(new Uint8Array([0x02, 0x01, 0x02]));
    const ocspDer2 = derSequence(new Uint8Array([0x0a, 0x01, 0x01]));
    const res2 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: res.pdfBase64,
        cmsDerBase64: Buffer.from(cmsDer2).toString('base64'),
        signerName: 'Nguyễn Thị Lan',
        signedAtIso: '2026-11-16T11:05:00.000Z',
        timestampTokenBase64: Buffer.from(tsDer2).toString('base64'),
        ocspResponsesBase64: [Buffer.from(ocspDer2).toString('base64')],
      }),
    );
    if (!res2.ok || res2.kind !== 'pdf_embed_cms') throw new Error('expected second LTV embed success');
    const outBytes2 = new Uint8Array(Buffer.from(res2.pdfBase64, 'base64'));
    assertByteRangeAndCms(outBytes2, res2.byteRange, cmsDer2, { allowTrailingUpdate: true });

    const doc = await PDFDocument.load(outBytes2);
    const dss = doc.catalog.lookup(PDFName.of('DSS'), PDFDict);
    expect(dss.lookup(PDFName.of('Type'), PDFName).decodeText()).toBe('DSS');
    expect(dss.lookup(PDFName.of('OCSPs'), PDFArray).size()).toBe(2);
    const vri = dss.lookup(PDFName.of('VRI'), PDFDict);
    const expectedVriKey1 = createHash('sha1').update(cmsDer).digest('hex').toUpperCase();
    const expectedVriKey2 = createHash('sha1').update(cmsDer2).digest('hex').toUpperCase();
    expect(vri.get(PDFName.of(expectedVriKey1))).toBeDefined();
    expect(vri.get(PDFName.of(expectedVriKey2))).toBeDefined();
    expect((await inspectPdf(outBytes2)).pageCount).toBe(1);
  });

  it('preserves indirect /Fields array when /AcroForm is a direct dictionary in Catalog', async () => {
    const stream = 'BT /F1 12 Tf 72 720 Td (Existing direct AcroForm) Tj ET';
    const pdfDirectAcro = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields 6 0 R >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '[7 0 R]',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (ExistingTextField) /Rect [0 0 100 20] >>',
    ]);
    const cmsDer = makeTestCmsDer('direct-acro-indirect-fields');
    const res = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: Buffer.from(pdfDirectAcro).toString('base64'),
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Hoàng Văn Đức',
        signedAtIso: '2026-11-16T11:30:00.000Z',
      }),
    );
    if (!res.ok || res.kind !== 'pdf_embed_cms') throw new Error('expected direct AcroForm embed success');
    const outBytes = new Uint8Array(Buffer.from(res.pdfBase64, 'base64'));
    assertByteRangeAndCms(outBytes, res.byteRange, cmsDer);

    const doc = await PDFDocument.load(outBytes);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.lookup(PDFName.of('SigFlags'), PDFNumber).asNumber()).toBe(3);
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(2);
    expect(doc.context.lookup(fields.get(0), PDFDict).lookup(PDFName.of('T'), PDFString).decodeText()).toBe(
      'ExistingTextField',
    );
    expect(doc.context.lookup(fields.get(1), PDFDict).lookup(PDFName.of('T'), PDFString).decodeText()).toBe(
      'Signature1',
    );
  });

  it('rejects non-PDF, encrypted PDFs, active JS/actions, duplicate fieldName, and invalid/oversized CMS', async () => {
    const validCmsB64 = Buffer.from(makeTestCmsDer()).toString('base64');
    const commonMeta = {
      cmsDerBase64: validCmsB64,
      signerName: 'Tester',
      signedAtIso: '2026-11-16T10:00:00.000Z',
    };

    // Non-PDF bytes
    const badMagic = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...commonMeta,
        pdfBase64: Buffer.from('NOT_A_PDF_FILE').toString('base64'),
      }),
    );
    expect(badMagic).toMatchObject({ ok: false, code: 'invalid' });

    // Encrypted trailer
    const encryptedPdf = makeRawPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
        '<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>',
      ],
      '/Encrypt 4 0 R ',
    );
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({ ...commonMeta, pdfBase64: Buffer.from(encryptedPdf).toString('base64') }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // Active JS / OpenAction / AA / Launch / RichMedia
    const activeCases = [
      '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>',
      '<< /Type /Catalog /Pages 2 0 R /AA << /WC << /S /JavaScript /JS (1) >> >> >>',
      '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Launch /F (cmd.exe) >> >>',
      '<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 4 0 R >> >>',
    ];
    for (const catalog of activeCases) {
      const hostilePdf = makeRawPdf([
        catalog,
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
        '<< /JS (app.alert(1)) >>',
      ]);
      expect(
        await parse(
          'pdf_embed_cms',
          encodePdfEmbedCmsInput({ ...commonMeta, pdfBase64: Buffer.from(hostilePdf).toString('base64') }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    }

    const richMediaPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>',
      '<< /Type /Annot /Subtype /RichMedia /Rect [0 0 100 100] >>',
    ]);
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({ ...commonMeta, pdfBase64: Buffer.from(richMediaPdf).toString('base64') }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    const cleanPdf = makeCleanClassicPdf();
    const cleanPdfB64 = Buffer.from(cleanPdf).toString('base64');

    // Non-DER / truncated / non-canonical DER CMS
    const nonCanonicalDer = new Uint8Array(3 + 0x80);
    nonCanonicalDer[0] = 0x30;
    nonCanonicalDer[1] = 0x82;
    nonCanonicalDer[2] = 0x00;
    nonCanonicalDer[3] = 0x80;
    for (const badCms of [Buffer.from('plain-text-not-der'), new Uint8Array([0x30, 0x10, 0x01]), nonCanonicalDer]) {
      expect(
        await parse(
          'pdf_embed_cms',
          encodePdfEmbedCmsInput({
            ...commonMeta,
            pdfBase64: cleanPdfB64,
            cmsDerBase64: Buffer.from(badCms).toString('base64'),
          }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    }

    // Duplicate fieldName refusal
    const firstNamed = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...commonMeta,
        pdfBase64: cleanPdfB64,
        fieldName: 'PrimarySig',
      }),
    );
    if (!firstNamed.ok || firstNamed.kind !== 'pdf_embed_cms') throw new Error('expected firstNamed ok');
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          ...commonMeta,
          pdfBase64: firstNamed.pdfBase64,
          fieldName: 'PrimarySig',
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // CMS exceeds placeholderBytes
    const bigCms = makeTestCmsDer('x'.repeat(120));
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          ...commonMeta,
          pdfBase64: cleanPdfB64,
          cmsDerBase64: Buffer.from(bigCms).toString('base64'),
          placeholderBytes: 64,
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    // Oversized request past maxPdfEmbedCmsRequestBytes
    expect(
      await parse('pdf_embed_cms', new Uint8Array(EXTRACT_LIMITS.maxPdfEmbedCmsRequestBytes + 1)),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('runs inside the isolated parser sandbox and via createExtractApp POST /extract?kind=pdf_embed_cms', async () => {
    const cleanPdf = makeCleanClassicPdf();
    const cmsDer = makeTestCmsDer('sandbox-http-cms');
    const body = encodePdfEmbedCmsInput({
      pdfBase64: Buffer.from(cleanPdf).toString('base64'),
      cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
      signerName: 'Nguyễn Thị Hương',
      signedAtIso: '2026-11-16T12:00:00.000Z',
    });

    const sandboxed = await runSandboxed('pdf_embed_cms', body);
    expect(sandboxed.ok).toBe(true);
    if (!sandboxed.ok || sandboxed.kind !== 'pdf_embed_cms') throw new Error('expected sandbox pdf_embed_cms ok');
    assertByteRangeAndCms(new Uint8Array(Buffer.from(sandboxed.pdfBase64, 'base64')), sandboxed.byteRange, cmsDer);

    const app = createExtractApp();
    const httpRes = await app.request('/extract?kind=pdf_embed_cms', {
      method: 'POST',
      body: Buffer.from(body),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(httpRes.status).toBe(200);
    const parsed = zExtractResponse.parse(await httpRes.json());
    expect(parsed).toEqual(sandboxed);
  }, 20_000);
});
