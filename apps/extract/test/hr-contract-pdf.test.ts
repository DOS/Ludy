// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { encodePdfSealInput } from '@crove/extract-contract';
import { describe, expect, it } from 'vitest';
import { renderLaborContractPdf } from '../../../modules/hr/src/contract-pdf.ts';
import { inspectPdf, sealPdf } from '../src/seal.ts';

describe('HR labor contract PDF compatibility with crove-extract pdf_inspect & pdf_seal (#3548)', () => {
  it('passes inspectPdf with valid A4 dimensions, Vietnamese diacritics, and seals cleanly for Ludy eSign', async () => {
    const bytes = renderLaborContractPdf({
      employer: {
        name: 'Công ty Cổ phần Đầu tư Thương mại và Dịch vụ Ánh Dương Việt Nam',
        taxCode: '0100000000',
        address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
      },
      employee: {
        id: '01950000-0000-7000-8000-00000000a1b2',
        displayName: 'Đặng Thị Hằng',
        birthDate: '1997-05-14',
        jobTitle: 'Kỹ sư Phần mềm',
        departmentName: 'Phòng Kỹ thuật',
        workplace: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
      },
      terms: {
        id: '01950000-0000-7000-8000-00000000c3d4',
        contractType: 'fixed_term',
        contractForm: 'electronic',
        termMonths: 24,
        effectiveFrom: '2026-03-01',
        contractEndOn: '2028-02-29',
        fixedTermSequence: 1,
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-04-29',
        probationWage: '22000000',
        baseWage: '25000000',
        region: 'I',
        payFunction: 'production',
      },
    });

    const inspected = await inspectPdf(bytes);
    expect(inspected.ok).toBe(true);
    expect(inspected.kind).toBe('pdf_inspect');
    expect(inspected.pageCount).toBeGreaterThanOrEqual(1);
    expect(inspected.pages[0]).toMatchObject({
      page: 1,
      widthPt: 595.28,
      heightPt: 841.89,
      rotation: 0,
    });

    const allText = inspected.pages.map((p) => p.text).join(' ').replace(/\s+/g, ' ');
    expect(allText).not.toContain('\u2014');
    expect(allText).toContain('HỢP ĐỒNG LAO ĐỘNG');
    expect(allText).toContain('Ánh Dương Việt Nam');
    expect(allText).toContain('Đặng Thị Hằng');
    expect(allText).toContain('25.000.000 VND/tháng');
    expect(allText).toContain('ĐẠI DIỆN NGƯỜI SỬ DỤNG LAO ĐỘNG (BÊN A)');
    expect(allText).toContain('NGƯỜI LAO ĐỘNG (BÊN B)');

    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const lastPage = inspected.pageCount;
    const sealPayload = encodePdfSealInput({
      pdfBase64: Buffer.from(bytes).toString('base64'),
      fields: [
        { type: 'date', page: lastPage, xNorm: 0.1, yNorm: 0.78, wNorm: 0.25, hNorm: 0.04, text: '01/03/2026' },
        { type: 'date', page: lastPage, xNorm: 0.56, yNorm: 0.78, wNorm: 0.25, hNorm: 0.04, text: '01/03/2026' },
      ],
      certificate: {
        certificateCode: 'CS-ABCD-1234-EFGH',
        envelopeTitle: 'Hợp đồng lao động - Đặng Thị Hằng (2026-03-01)',
        sourceSha256,
        completedAtIso: '2026-03-01T09:00:00.000Z',
        eventChainTipHash: 'a'.repeat(64),
        signers: [
          {
            name: 'Đặng Thị Hằng',
            roleLabel: 'Người lao động (Bên B)',
            maskedEmail: 'h***g@example.com',
            deliveryMode: 'email',
            otpStatus: 'verified',
            signedAtIso: '2026-03-01T09:00:00.000Z',
            ipHashPrefix: '0123456789abcdef',
            signatureKind: 'type',
          },
        ],
      },
    });
    const sealed = await sealPdf(sealPayload);
    expect(sealed.ok).toBe(true);
    expect(sealed.pageCount).toBe(inspected.pageCount + 1);
  }, 20_000);
});
