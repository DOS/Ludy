// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import {
  EXTRACT_LIMITS,
  encodePdfSealInput,
  zPdfSealInput,
} from '@ludy/extract-contract';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  inspectPdf,
  loadValidatedPdfForIncrementalUpdate,
  sealPdf,
} from '../src/seal.ts';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function makePdf(pages: number, labelPrefix: string, withAcroFieldName?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`${labelPrefix} page ${i + 1}`, { x: 48, y: 780, size: 12, font });
    if (withAcroFieldName && i === 0) {
      const form = doc.getForm();
      const tf = form.createTextField(withAcroFieldName);
      tf.setText(`val-${labelPrefix}`);
      tf.addToPage(page, { x: 50, y: 700, width: 120, height: 24 });
    }
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe('Multi-document PDF sealing (#4722 Slice 6c)', () => {
  it('enforces pdfBase64 XOR documents and document page range consistency in zPdfSealInput', () => {
    const dummySha = 'a'.repeat(64);
    const cert = {
      certificateCode: 'CS-1111-2222-3333',
      envelopeTitle: 'Bo ho so hop dong',
      sourceSha256: dummySha,
      completedAtIso: '2026-11-24T10:00:00.000Z',
      eventChainTipHash: 'b'.repeat(64),
      signers: [
        {
          name: 'Nguyen Van A',
          roleLabel: 'Ben A',
          maskedEmail: 'a***@example.com',
          deliveryMode: 'email' as const,
          otpStatus: 'verified' as const,
          signedAtIso: '2026-11-24T10:00:00.000Z',
          ipHashPrefix: 'abcd1234',
        },
      ],
    };

    const neither = zPdfSealInput.safeParse({ fields: [], certificate: cert });
    expect(neither.success).toBe(false);

    const both = zPdfSealInput.safeParse({
      pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
      documents: [{ title: 'Doc 1', pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'), sourceSha256: dummySha }],
      fields: [],
      certificate: cert,
    });
    expect(both.success).toBe(false);

    const badDocRange = zPdfSealInput.safeParse({
      documents: [{ title: 'Doc 1', pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'), sourceSha256: dummySha }],
      fields: [],
      certificate: {
        ...cert,
        documents: [{ index: 1, title: 'Doc 1', startPage: 2, endPage: 1, pageCount: 1, sourceSha256: dummySha }],
      },
    });
    expect(badDocRange.success).toBe(false);
  });

  it('merges 3 PDFs with colliding AcroForm field names, stamps fields, attaches packet outlines, and renders Packet Documents on Audit Certificate', async () => {
    const doc1 = await makePdf(2, 'Hop dong chinh', 'shared_name');
    const doc2 = await makePdf(1, 'Phu luc gia han', 'shared_name');
    const doc3 = await makePdf(1, 'Bien ban ban giao');

    const sha1 = sha256Hex(doc1);
    const sha2 = sha256Hex(doc2);
    const sha3 = sha256Hex(doc3);

    const payload = encodePdfSealInput({
      documents: [
        { title: 'Hợp đồng chính.pdf', pdfBase64: Buffer.from(doc1).toString('base64'), sourceSha256: sha1 },
        { title: 'Phụ lục gia hạn.pdf', pdfBase64: Buffer.from(doc2).toString('base64'), sourceSha256: sha2 },
        { title: 'Biên bản bàn giao.pdf', pdfBase64: Buffer.from(doc3).toString('base64'), sourceSha256: sha3 },
      ],
      fields: [
        { type: 'text', page: 2, xNorm: 0.1, yNorm: 0.2, wNorm: 0.3, hNorm: 0.05, text: 'Signed on Doc 1 Page 2' },
        { type: 'text', page: 3, xNorm: 0.1, yNorm: 0.25, wNorm: 0.3, hNorm: 0.05, text: 'Signed on Doc 2' },
        { type: 'text', page: 4, xNorm: 0.1, yNorm: 0.3, wNorm: 0.3, hNorm: 0.05, text: 'Signed on Doc 3' },
      ],
      certificate: {
        certificateCode: 'CS-ABCD-1234-EFGH',
        envelopeTitle: 'Hồ sơ hợp đồng nhiều tài liệu',
        sourceSha256: sha1,
        completedAtIso: '2026-11-24T10:15:00.000Z',
        eventChainTipHash: 'c'.repeat(64),
        documents: [
          { index: 1, title: 'Hợp đồng chính.pdf', startPage: 1, endPage: 2, pageCount: 2, sourceSha256: sha1 },
          { index: 2, title: 'Phụ lục gia hạn.pdf', startPage: 3, endPage: 3, pageCount: 1, sourceSha256: sha2 },
          { index: 3, title: 'Biên bản bàn giao.pdf', startPage: 4, endPage: 4, pageCount: 1, sourceSha256: sha3 },
        ],
        signers: [
          {
            name: 'Trần Thị Bích',
            roleLabel: 'Bên B',
            maskedEmail: 'b***@example.com',
            deliveryMode: 'email',
            otpStatus: 'verified',
            signedAtIso: '2026-11-24T10:14:00.000Z',
            ipHashPrefix: '0123456789abcdef',
          },
        ],
      },
    });

    const sealed = await sealPdf(payload);
    expect(sealed.ok).toBe(true);
    expect(sealed.pageCount).toBeGreaterThanOrEqual(5);

    const outBytes = new Uint8Array(Buffer.from(sealed.sealedPdfBase64, 'base64'));
    const reloadedForUpdate = await loadValidatedPdfForIncrementalUpdate(outBytes, {
      maxPages: EXTRACT_LIMITS.maxPdfSignPages + EXTRACT_LIMITS.maxPdfAuditCertPages,
    });
    expect(reloadedForUpdate.pdfDoc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    const outlines = reloadedForUpdate.pdfDoc.catalog.lookup(PDFName.of('Outlines'));
    expect(outlines).toBeInstanceOf(PDFDict);

    const inspected = await inspectPdf(outBytes);
    expect(inspected.pages[1]?.text).toContain('Signed on Doc 1 Page 2');
    expect(inspected.pages[2]?.text).toContain('Signed on Doc 2');
    expect(inspected.pages[3]?.text).toContain('Signed on Doc 3');

    const certText = inspected.pages.slice(4).map((p) => p.text).join(' ').replace(/\s+/g, ' ');
    expect(certText).toContain('PACKET DOCUMENTS (3)');
    expect(certText).toContain('1. Hợp đồng chính.pdf');
    expect(certText).toContain(sha1);
    expect(certText).toContain('2. Phụ lục gia hạn.pdf');
    expect(certText).toContain(sha2);
    expect(certText).toContain('3. Biên bản bàn giao.pdf');
    expect(certText).toContain(sha3);
    expect(certText).not.toContain('\u2014');
    expect(certText).not.toContain('\u2013');
  });

  it('rejects multi-document packet exceeding 200 total source pages or mismatched part SHA-256', async () => {
    const doc101a = await makePdf(101, 'Part A');
    const doc100b = await makePdf(100, 'Part B');
    const shaA = sha256Hex(doc101a);
    const shaB = sha256Hex(doc100b);

    const overPagesPayload = encodePdfSealInput({
      documents: [
        { title: 'Part A.pdf', pdfBase64: Buffer.from(doc101a).toString('base64'), sourceSha256: shaA },
        { title: 'Part B.pdf', pdfBase64: Buffer.from(doc100b).toString('base64'), sourceSha256: shaB },
      ],
      fields: [],
      certificate: {
        certificateCode: 'CS-0000-0000-0001',
        envelopeTitle: 'Too many pages',
        sourceSha256: shaA,
        completedAtIso: '2026-11-24T10:00:00.000Z',
        eventChainTipHash: 'd'.repeat(64),
        signers: [
          {
            name: 'Signer',
            roleLabel: 'Signer',
            maskedEmail: null,
            deliveryMode: 'link',
            otpStatus: 'not_required',
            signedAtIso: '2026-11-24T10:00:00.000Z',
            ipHashPrefix: null,
          },
        ],
      },
    });
    await expect(sealPdf(overPagesPayload)).rejects.toThrow(/200 trang/);

    const badShaPayload = encodePdfSealInput({
      documents: [
        { title: 'Part B.pdf', pdfBase64: Buffer.from(doc100b).toString('base64'), sourceSha256: 'e'.repeat(64) },
      ],
      fields: [],
      certificate: {
        certificateCode: 'CS-0000-0000-0002',
        envelopeTitle: 'Bad SHA',
        sourceSha256: shaB,
        completedAtIso: '2026-11-24T10:00:00.000Z',
        eventChainTipHash: 'd'.repeat(64),
        signers: [
          {
            name: 'Signer',
            roleLabel: 'Signer',
            maskedEmail: null,
            deliveryMode: 'link',
            otpStatus: 'not_required',
            signedAtIso: '2026-11-24T10:00:00.000Z',
            ipHashPrefix: null,
          },
        ],
      },
    });
    await expect(sealPdf(badShaPayload)).rejects.toThrow(/SHA-256/);
  });
});
