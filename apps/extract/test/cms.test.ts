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

function derTag(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const len = encodeDerLength(total);
  const out = new Uint8Array(1 + len.byteLength + total);
  out[0] = tag;
  out.set(len, 1);
  let pos = 1 + len.byteLength;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

function makeContentInfoSignedDataDer(
  mode: 'none' | 'plain_pkcs7' | 'cades',
  marker = 'test-cms',
): Uint8Array {
  const oidSignedData = derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]));
  const oidData = derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]));
  const oidSha256 = derTag(0x06, new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]));
  const oidContentType = derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03]));
  const oidMessageDigest = derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]));
  const oidSigningCertV2 = derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x2f]));
  const algSha256 = derTag(0x30, oidSha256, derTag(0x05));
  const sid = derTag(0x30, derTag(0x30), derTag(0x02, new Uint8Array([0x01])));
  const markerDigest = new Uint8Array(createHash('sha256').update(marker).digest());
  const contentTypeAttr = derTag(0x30, oidContentType, derTag(0x31, oidData));
  const messageDigestAttr = derTag(0x30, oidMessageDigest, derTag(0x31, derTag(0x04, markerDigest)));
  const essCertIdV2 = derTag(0x30, derTag(0x04, markerDigest));
  const signingCertV2Attr = derTag(0x30, oidSigningCertV2, derTag(0x31, derTag(0x30, derTag(0x30, essCertIdV2))));
  const attrs =
    mode === 'none'
      ? []
      : [
          derTag(
            0xa0,
            ...[contentTypeAttr, messageDigestAttr, ...(mode === 'cades' ? [signingCertV2Attr] : [])].sort((a, b) =>
              Buffer.compare(a, b),
            ),
          ),
        ];
  const siFields = [
    derTag(0x02, new Uint8Array([0x01])),
    sid,
    algSha256,
    ...attrs,
    algSha256,
    derTag(0x04, new Uint8Array(64).fill(0xab)),
  ];
  const signedData = derTag(
    0x30,
    derTag(0x02, new Uint8Array([0x01])),
    derTag(0x31, algSha256),
    derTag(0x30, oidData),
    derTag(0x31, derTag(0x30, ...siFields)),
  );
  return derTag(0x30, oidSignedData, derTag(0xa0, signedData));
}

function makeTestCmsDer(marker = 'test-cms-signature-payload'): Uint8Array {
  return makeContentInfoSignedDataDer('cades', marker);
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

  it('produces identical ByteRange digest in two-step prepare and embed flow for both CAdES and non-signedAttrs PKCS#7', async () => {
    const basePdf = makeCleanClassicPdf();
    const baseInput = {
      pdfBase64: Buffer.from(basePdf).toString('base64'),
      signerName: 'Lê Hoàng Nam',
      reason: 'Ký số xác nhận',
      location: 'Hà Nội',
      signedAtIso: '2026-11-16T10:00:00.000Z',
      subFilter: 'ETSI.CAdES.detached',
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

    // Non-signedAttrs CMS flow: subFilter is fixed upfront to adbe.pkcs7.detached so prepare and embed digests match.
    const pkcs7Input = {
      ...baseInput,
      subFilter: 'adbe.pkcs7.detached',
    } as const;
    const prepPkcs7 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...pkcs7Input,
        cmsDerBase64: Buffer.from(new Uint8Array([0x30, 0x00])).toString('base64'),
      }),
    );
    if (!prepPkcs7.ok || prepPkcs7.kind !== 'pdf_embed_cms') throw new Error('expected pkcs7 prepare ok');
    const prepPkcs7Bytes = new Uint8Array(Buffer.from(prepPkcs7.pdfBase64, 'base64'));
    const [pb0, pb1, pb2, pb3] = prepPkcs7.byteRange;
    const prePkcs7Digest = sha256Hex(
      Buffer.concat([prepPkcs7Bytes.subarray(pb0, pb1), prepPkcs7Bytes.subarray(pb2, pb2 + pb3)]),
    );
    const noAttrsCms = makeContentInfoSignedDataDer('none', `pkcs7:${prePkcs7Digest}`);
    const embedPkcs7 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...pkcs7Input,
        cmsDerBase64: Buffer.from(noAttrsCms).toString('base64'),
      }),
    );
    if (!embedPkcs7.ok || embedPkcs7.kind !== 'pdf_embed_cms') throw new Error('expected pkcs7 embed ok');
    expect(embedPkcs7.byteRange).toEqual(prepPkcs7.byteRange);
    const finalPkcs7Bytes = new Uint8Array(Buffer.from(embedPkcs7.pdfBase64, 'base64'));
    const postPkcs7Digest = sha256Hex(
      Buffer.concat([finalPkcs7Bytes.subarray(pb0, pb1), finalPkcs7Bytes.subarray(pb2, pb2 + pb3)]),
    );
    expect(postPkcs7Digest).toBe(prePkcs7Digest);
    assertByteRangeAndCms(finalPkcs7Bytes, embedPkcs7.byteRange, noAttrsCms);
  });

  it('embeds optional PAdES-LTV DSS timestamp and OCSP in a post-signature revision without changing ByteRange digest and merges sequential DSS', async () => {
    const basePdf = makeCleanClassicPdf();
    const commonBase = {
      pdfBase64: Buffer.from(basePdf).toString('base64'),
      signerName: 'Phạm Minh Tuấn',
      signedAtIso: '2026-11-16T11:00:00.000Z',
      subFilter: 'ETSI.CAdES.detached',
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
    // RFC 3161 timestamp token is embedded into SignerInfo.unsignedAttrs (id-aa-signatureTimeStampToken) inside /Contents.
    const contentsHex1 = Buffer.from(outBytes.subarray(b1 + 1, b2 - 1)).toString('ascii');
    expect(contentsHex1).toContain('060b2a864886f70d010910020e');
    expect(contentsHex1).toContain(Buffer.from(tsDer).toString('hex'));

    // Standalone timestampTokenBase64 without OCSP adds signature-time-stamp without creating a /DSS update.
    const tsOnly = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        ...commonBase,
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        timestampTokenBase64: Buffer.from(tsDer).toString('base64'),
      }),
    );
    if (!tsOnly.ok || tsOnly.kind !== 'pdf_embed_cms') throw new Error('expected tsOnly ok');
    const tsOnlyBytes = new Uint8Array(Buffer.from(tsOnly.pdfBase64, 'base64'));
    expect(tsOnly.byteRange[2] + tsOnly.byteRange[3]).toBe(tsOnlyBytes.byteLength);
    expect((await PDFDocument.load(tsOnlyBytes)).catalog.get(PDFName.of('DSS'))).toBeUndefined();

    // Sequential second signature with OCSP LTV merges into existing /DSS and records /VRI/<sha1(paddedContents)>.
    const cmsDer2 = makeTestCmsDer('ltv-cms-2');
    const ocspDer2 = derSequence(new Uint8Array([0x0a, 0x01, 0x01]));
    const res2 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: res.pdfBase64,
        cmsDerBase64: Buffer.from(cmsDer2).toString('base64'),
        signerName: 'Nguyễn Thị Lan',
        signedAtIso: '2026-11-16T11:05:00.000Z',
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
    const paddedBytes1 = Buffer.from(contentsHex1, 'hex');
    const paddedBytes2 = Buffer.from(
      Buffer.from(outBytes2.subarray(res2.byteRange[1] + 1, res2.byteRange[2] - 1)).toString('ascii'),
      'hex',
    );
    const expectedVriKey1 = createHash('sha1').update(paddedBytes1).digest('hex').toUpperCase();
    const expectedVriKey2 = createHash('sha1').update(paddedBytes2).digest('hex').toUpperCase();
    expect(expectedVriKey1).not.toBe(createHash('sha1').update(cmsDer).digest('hex').toUpperCase());
    const vriEntry1 = vri.lookup(PDFName.of(expectedVriKey1), PDFDict);
    expect(vriEntry1.get(PDFName.of('OCSP'))).toBeDefined();
    expect(vriEntry1.get(PDFName.of('TU'))).toBeDefined();
    expect(vriEntry1.get(PDFName.of('TS'))).toBeUndefined();
    const vriEntry2 = vri.lookup(PDFName.of(expectedVriKey2), PDFDict);
    expect(vriEntry2.get(PDFName.of('OCSP'))).toBeDefined();
    expect(vriEntry2.get(PDFName.of('TU'))).toBeDefined();
    expect(vriEntry2.get(PDFName.of('TS'))).toBeUndefined();
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

  it('deduplicates updates when /Annots and /AcroForm /Fields share the same indirect array ref and supports LTV on XRef-stream PDFs', async () => {
    const stream = 'BT /F1 12 Tf 72 720 Td (Shared Annots Fields array) Tj ET';
    const sharedArrayPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields 6 0 R >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots 6 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '[7 0 R]',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (SharedWidget) /Rect [0 0 100 20] >>',
    ]);
    const cmsDer = makeTestCmsDer('shared-array-cms');
    const sharedRes = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: Buffer.from(sharedArrayPdf).toString('base64'),
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Ngô Minh Khoa',
        signedAtIso: '2026-11-16T11:45:00.000Z',
      }),
    );
    if (!sharedRes.ok || sharedRes.kind !== 'pdf_embed_cms') throw new Error('expected shared array embed ok');
    const sharedBytes = new Uint8Array(Buffer.from(sharedRes.pdfBase64, 'base64'));
    assertByteRangeAndCms(sharedBytes, sharedRes.byteRange, cmsDer);
    expect((await inspectPdf(sharedBytes)).pageCount).toBe(1);
    const sharedDoc = await PDFDocument.load(sharedBytes);
    const sharedFields = sharedDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
    expect(sharedFields.size()).toBe(2);

    // LTV /DSS post-signature incremental update on XRef-stream pdf_seal output.
    const basePdf = makeCleanClassicPdf();
    const sealed = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(basePdf).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.4, hNorm: 0.1, text: 'Ok' }],
        certificate: {
          certificateCode: 'CS-4444-5555-6666',
          envelopeTitle: 'XRef Stream LTV',
          sourceSha256: sha256Hex(basePdf),
          completedAtIso: '2026-11-16T09:00:00.000Z',
          eventChainTipHash: 'd'.repeat(64),
          signers: [
            {
              name: 'Lê Minh',
              roleLabel: 'Bên A',
              maskedEmail: 'l***@example.com',
              deliveryMode: 'link',
              otpStatus: 'not_required',
              signedAtIso: '2026-11-16T09:00:00.000Z',
              ipHashPrefix: '11223344',
            },
          ],
        },
      }),
    );
    if (!sealed.ok || sealed.kind !== 'pdf_seal') throw new Error('expected seal ok');
    const tsDer = derSequence(new Uint8Array([0x02, 0x01, 0x09]));
    const ocspDer = derSequence(new Uint8Array([0x0a, 0x01, 0x02]));
    const ltvXrefRes = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: sealed.sealedPdfBase64,
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Lê Minh',
        signedAtIso: '2026-11-16T11:50:00.000Z',
        timestampTokenBase64: Buffer.from(tsDer).toString('base64'),
        ocspResponsesBase64: [Buffer.from(ocspDer).toString('base64')],
      }),
    );
    if (!ltvXrefRes.ok || ltvXrefRes.kind !== 'pdf_embed_cms') throw new Error('expected xref ltv ok');
    const ltvXrefBytes = new Uint8Array(Buffer.from(ltvXrefRes.pdfBase64, 'base64'));
    const xrefContentsHex = Buffer.from(
      ltvXrefBytes.subarray(ltvXrefRes.byteRange[1] + 1, ltvXrefRes.byteRange[2] - 1),
    ).toString('ascii');
    expect(xrefContentsHex).toContain('060b2a864886f70d010910020e');
    expect(xrefContentsHex).toContain(Buffer.from(tsDer).toString('hex'));
    expect((await PDFDocument.load(ltvXrefBytes)).catalog.lookup(PDFName.of('DSS'), PDFDict)).toBeDefined();
    expect((await inspectPdf(ltvXrefBytes)).pageCount).toBe(sealed.pageCount);
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

  it('requires explicit subFilter for placeholders, rejects non-CAdES SignedData as ETSI.CAdES.detached, and rejects broken SignedData', async () => {
    const cleanPdfB64 = Buffer.from(makeCleanClassicPdf()).toString('base64');
    const cmsNoAttrs = makeContentInfoSignedDataDer('none');
    const cmsPlainPkcs7 = makeContentInfoSignedDataDer('plain_pkcs7');
    const cmsCades = makeContentInfoSignedDataDer('cades');

    // Placeholder 30 00 without subFilter is refused so two-step flows cannot silently switch SubFilter.
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          pdfBase64: cleanPdfB64,
          cmsDerBase64: Buffer.from(new Uint8Array([0x30, 0x00])).toString('base64'),
          signerName: 'Placeholder check',
          signedAtIso: '2026-11-16T12:55:00.000Z',
          placeholderBytes: 4096,
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    for (const nonCadesCms of [cmsNoAttrs, cmsPlainPkcs7]) {
      const autoRes = await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          pdfBase64: cleanPdfB64,
          cmsDerBase64: Buffer.from(nonCadesCms).toString('base64'),
          signerName: 'Ký số trực tiếp',
          signedAtIso: '2026-11-16T13:00:00.000Z',
        }),
      );
      expect(autoRes.ok).toBe(true);
      if (!autoRes.ok || autoRes.kind !== 'pdf_embed_cms') throw new Error('expected pkcs7 auto ok');
      const doc = await PDFDocument.load(Buffer.from(autoRes.pdfBase64, 'base64'));
      const fields = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
      const sig = doc.context.lookup(fields.get(0), PDFDict).lookup(PDFName.of('V'), PDFDict);
      expect(sig.lookup(PDFName.of('SubFilter'), PDFName).decodeText()).toBe('adbe.pkcs7.detached');

      // Explicit ETSI.CAdES.detached must fail when SignedData lacks mandatory CAdES signingCertificate/V2.
      expect(
        await parse(
          'pdf_embed_cms',
          encodePdfEmbedCmsInput({
            pdfBase64: cleanPdfB64,
            cmsDerBase64: Buffer.from(nonCadesCms).toString('base64'),
            signerName: 'Ký số trực tiếp',
            signedAtIso: '2026-11-16T13:00:00.000Z',
            subFilter: 'ETSI.CAdES.detached',
          }),
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    }

    // Real CAdES SignedData (contentType + messageDigest + signingCertificateV2) defaults to ETSI.CAdES.detached.
    const withAttrsRes = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: cleanPdfB64,
        cmsDerBase64: Buffer.from(cmsCades).toString('base64'),
        signerName: 'Ký số CAdES',
        signedAtIso: '2026-11-16T13:05:00.000Z',
      }),
    );
    expect(withAttrsRes.ok).toBe(true);
    if (!withAttrsRes.ok || withAttrsRes.kind !== 'pdf_embed_cms') throw new Error('expected cades ok');
    const cadesDoc = await PDFDocument.load(Buffer.from(withAttrsRes.pdfBase64, 'base64'));
    const cadesFields = cadesDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
    const cadesSig = cadesDoc.context.lookup(cadesFields.get(0), PDFDict).lookup(PDFName.of('V'), PDFDict);
    expect(cadesSig.lookup(PDFName.of('SubFilter'), PDFName).decodeText()).toBe('ETSI.CAdES.detached');

    // ContentInfo(id-signedData) with truncated/malformed SignedData inner structure is refused.
    const brokenSignedData = derTag(
      0x30,
      derTag(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02])),
      derTag(0xa0, derTag(0x30, derTag(0x02, new Uint8Array([0x01])))),
    );
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          pdfBase64: cleanPdfB64,
          cmsDerBase64: Buffer.from(brokenSignedData).toString('base64'),
          signerName: 'Broken CMS',
          signedAtIso: '2026-11-16T13:10:00.000Z',
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('checks nested AcroForm /Kids collisions, rejects dotted partial fieldName, and accepts 200-page pdf_seal output (201+ pages) up to limit', async () => {
    const nestedPdf = makeRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      '<< /Length 0 >>\nstream\n\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Kids [7 0 R] >>',
      '<< /Type /Annot /Subtype /Widget /FT /Sig /T (PrimarySig) /Rect [0 0 0 0] >>',
    ]);
    const cmsDer = makeTestCmsDer('nested-kids-cms');
    expect(() =>
      encodePdfEmbedCmsInput({
        pdfBase64: Buffer.from(nestedPdf).toString('base64'),
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Dotted Check',
        signedAtIso: '2026-11-16T13:14:00.000Z',
        fieldName: 'Group.Signature2',
      }),
    ).toThrow();
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          pdfBase64: Buffer.from(nestedPdf).toString('base64'),
          cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
          signerName: 'Nested Check',
          signedAtIso: '2026-11-16T13:15:00.000Z',
          fieldName: 'PrimarySig',
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });

    const distinctNested = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: Buffer.from(nestedPdf).toString('base64'),
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Nested Distinct',
        signedAtIso: '2026-11-16T13:16:00.000Z',
        fieldName: 'SecondarySig',
      }),
    );
    expect(distinctNested.ok).toBe(true);

    // A 200-page PDF sealed into 201 pages embeds cleanly, while > maxPdfSignPages + maxPdfAuditCertPages is refused.
    const doc200 = await PDFDocument.create();
    for (let i = 0; i < EXTRACT_LIMITS.maxPdfSignPages; i += 1) {
      doc200.addPage([595, 842]);
    }
    const bytes200 = new Uint8Array(await doc200.save({ useObjectStreams: false }));
    const sealed201 = await parse(
      'pdf_seal',
      encodePdfSealInput({
        pdfBase64: Buffer.from(bytes200).toString('base64'),
        fields: [{ type: 'text', page: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.3, hNorm: 0.1, text: 'Page 1' }],
        certificate: {
          certificateCode: 'CS-2001-2002-2003',
          envelopeTitle: '200 Page Contract',
          sourceSha256: sha256Hex(bytes200),
          completedAtIso: '2026-11-16T13:20:00.000Z',
          eventChainTipHash: 'd'.repeat(64),
          signers: [
            {
              name: 'Nguyễn Văn Hai',
              roleLabel: 'Bên A',
              maskedEmail: 'n***@example.vn',
              deliveryMode: 'link',
              otpStatus: 'not_required',
              signedAtIso: '2026-11-16T13:20:00.000Z',
              ipHashPrefix: 'abcd1234',
            },
          ],
        },
      }),
    );
    if (!sealed201.ok || sealed201.kind !== 'pdf_seal') throw new Error('expected 200-page seal ok');
    expect(sealed201.pageCount).toBe(EXTRACT_LIMITS.maxPdfSignPages + 1);

    const embedded201 = await parse(
      'pdf_embed_cms',
      encodePdfEmbedCmsInput({
        pdfBase64: sealed201.sealedPdfBase64,
        cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
        signerName: 'Nguyễn Văn Hai',
        signedAtIso: '2026-11-16T13:21:00.000Z',
      }),
    );
    expect(embedded201.ok).toBe(true);
    if (!embedded201.ok || embedded201.kind !== 'pdf_embed_cms') throw new Error('expected 201-page cms embed ok');
    assertByteRangeAndCms(new Uint8Array(Buffer.from(embedded201.pdfBase64, 'base64')), embedded201.byteRange, cmsDer);

    const docOverLimit = await PDFDocument.create();
    const overLimitCount = EXTRACT_LIMITS.maxPdfSignPages + EXTRACT_LIMITS.maxPdfAuditCertPages + 1;
    for (let i = 0; i < overLimitCount; i += 1) {
      docOverLimit.addPage([595, 842]);
    }
    const bytesOver = new Uint8Array(await docOverLimit.save({ useObjectStreams: false }));
    expect(
      await parse(
        'pdf_embed_cms',
        encodePdfEmbedCmsInput({
          pdfBase64: Buffer.from(bytesOver).toString('base64'),
          cmsDerBase64: Buffer.from(cmsDer).toString('base64'),
          signerName: 'Over Limit',
          signedAtIso: '2026-11-16T13:22:00.000Z',
        }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });
});
