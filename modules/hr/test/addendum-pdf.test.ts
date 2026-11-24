// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for deterministic Vietnamese Contract Addendum PDF generation (#4528 Stage 6C).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addendumPdfFilename,
  addendumPdfTitle,
  formatPayDeltaLabel,
  renderContractAddendumPdf,
} from '../src/addendum-pdf.ts';

describe('renderContractAddendumPdf (#4528 Stage 6C)', () => {
  const sampleDoc = {
    addendumNumber: 'PL-2026-01',
    effectiveOn: '2026-12-01',
    changeSummary: 'Điều chỉnh mức lương cơ bản và chức danh theo kết quả đánh giá định kỳ.',
    previousPayRate: '15000000',
    newPayRate: '18500000.50',
    previousTitle: 'Chuyên viên Nhân sự',
    newTitle: 'Trưởng nhóm Nhân sự',
    contractNumber: 'HDLD-20260115-0001',
    contractEffectiveFrom: '2026-01-15',
    legalEntityName: 'Công ty TNHH Công nghệ Ludy',
    legalEntityTaxCode: '0312345678',
    employeeName: 'Nguyễn Thị Minh Ánh',
    employeeBirthDate: '1996-08-20',
    employeeCode: 'NV-0001',
  };

  it('produces valid PDF 1.7 bytes and identical hashes for identical input', () => {
    const a = renderContractAddendumPdf(sampleDoc);
    const b = renderContractAddendumPdf(sampleDoc);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

    const hashA = createHash('sha256').update(a).digest('hex');
    const hashB = createHash('sha256').update(b).digest('hex');
    expect(hashA).toBe(hashB);

    const latin1 = new TextDecoder('latin1').decode(a);
    expect(latin1.startsWith('%PDF-1.7\n')).toBe(true);
    expect(latin1.endsWith('%%EOF\n')).toBe(true);
    expect(latin1).toContain('/Type /Pages');
    const xrefMatch = /startxref\n(\d+)\n%%EOF/.exec(latin1);
    expect(xrefMatch).not.toBeNull();
    expect(latin1.slice(Number(xrefMatch?.[1]), Number(xrefMatch?.[1]) + 5)).toBe('xref\n');
  });

  it('formats decimal pay deltas without float rounding and eliminates em/en dashes', () => {
    expect(formatPayDeltaLabel('15000000.25', '18500000.75')).toBe(
      'Từ 15.000.000,25 đồng/tháng thành 18.500.000,75 đồng/tháng (+3.500.000,5 đồng)',
    );
    expect(formatPayDeltaLabel('20000000', '18000000')).toBe(
      'Từ 20.000.000 đồng/tháng thành 18.000.000 đồng/tháng (-2.000.000 đồng)',
    );
    expect(formatPayDeltaLabel('10000000', '10000000')).toBe('10.000.000 đồng/tháng (giữ nguyên)');

    const title = addendumPdfTitle('Nguyễn Văn An \u2014 Phòng Kỹ thuật', 'PL\u201301');
    expect(title).not.toContain('\u2014');
    expect(title).not.toContain('\u2013');
    expect(addendumPdfFilename('Nguyễn Thị Minh Ánh', 'PL-2026/01')).toBe(
      'phu-luc-hdld-nguyen-thi-minh-anh-pl-2026-01.pdf',
    );
  });

  it('paginates cleanly on long summaries and switches PDF byte output deterministically when includeSignTags is enabled', () => {
    const longDoc = {
      ...sampleDoc,
      changeSummary: Array.from(
        { length: 30 },
        (_, i) => `Điều khoản bổ sung mục ${i + 1}: Điều chỉnh phạm vi công việc và KPI định kỳ quý ${i % 4 + 1}.`,
      ).join(' '),
      includeSignTags: false,
    };
    const withoutTags = renderContractAddendumPdf(longDoc);
    const withTags = renderContractAddendumPdf({ ...longDoc, includeSignTags: true });
    expect(Buffer.from(withoutTags).equals(Buffer.from(withTags))).toBe(false);

    const rawLatin1 = Buffer.from(withTags).toString('latin1');
    expect(rawLatin1).toContain('/Count 2');
    // Check UTF-16BE /Title /Author /Subject hex strings and PDF structure have zero em/en dashes (U+2013 / U+2014).
    const dashed = renderContractAddendumPdf({
      ...longDoc,
      addendumNumber: 'PL\u20132026\u201401',
      changeSummary: 'Noi dung \u2014 co gach \u2013 dai',
      includeSignTags: true,
    });
    const dashedAscii = Buffer.from(dashed).toString('latin1');
    expect(dashedAscii).not.toContain('2013');
    expect(dashedAscii).not.toContain('2014');

    const longNamesPdf = renderContractAddendumPdf({
      ...sampleDoc,
      legalEntityName: 'Công ty Cổ phần Phát triển Công nghệ Phần mềm Doanh nghiệp Vừa và Nhỏ Việt Nam',
      employeeName: 'Nguyễn Hoàng Bảo Châu Tôn Nữ Công Tằng',
      includeSignTags: true,
    });
    expect(new TextDecoder('latin1').decode(longNamesPdf).startsWith('%PDF-1.7\n')).toBe(true);
  });
});
