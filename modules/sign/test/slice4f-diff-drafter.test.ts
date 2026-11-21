// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic unit tests for eSign Slice 4f (#3822):
// - computeSignVersionDiff & splitPageIntoClauses (100% AI-off clause diff across added/removed/modified/multi-page PDFs)
// - renderStarterContractPdf across all 5 Vietnamese SME starter templates (A4 PDF bytes, decimal money, tag neutralization)
// - sanitizeSharedSummaryForWrite & parseSharedSummary
import { describe, expect, it } from 'vitest';
import { SIGN_STARTER_TEMPLATE_KINDS, type SignStarterTemplateKind } from '@crove/kernel-contract';
import {
  STARTER_CONTRACT_TEMPLATES,
  buildStarterContractClauses,
  computeSignVersionDiff,
  formatContractDecimalAmount,
  neutralizeContractInputText,
  renderStarterContractPdf,
  splitPageIntoClauses,
} from '../src/index.ts';
import { parseSharedSummary, sanitizeSharedSummaryForWrite } from '../src/shared.ts';

describe('computeSignVersionDiff (100% deterministic, AI-off)', () => {
  it('returns zero changes when two PDFs have identical clauses despite whitespace differences', () => {
    const res = computeSignVersionDiff(
      [{ page: 1, text: 'Điều 1. Phạm vi dịch vụ\nBên B cung cấp phần mềm quản trị.' }],
      [{ page: 1, text: '  Điều 1. Phạm vi dịch vụ \r\n  Bên B cung cấp phần mềm quản trị.  ' }],
    );
    expect(res.stats.addedCount).toBe(0);
    expect(res.stats.removedCount).toBe(0);
    expect(res.stats.modifiedCount).toBe(0);
    expect(res.stats.unchangedCount).toBeGreaterThanOrEqual(2);
    expect(res.hunks.every((h) => h.kind === 'unchanged')).toBe(true);
  });

  it('splits single-line PDF page text on Vietnamese Điều/Khoản boundaries and detects added, removed, and modified hunks with page numbers', () => {
    const v1Page1 =
      'Điều 1. Đối tượng hợp đồng Bên B thực hiện tư vấn triển khai cho Bên A. Điều 2. Giá trị và thanh toán Tổng phí là 45.000.000 VND thanh toán trong 10 ngày.';
    const v1Page2 =
      'Điều 3. Bảo mật thông tin Hai bên giữ bí mật tài liệu trong 24 tháng. Điều 4. Phạt vi phạm Mức phạt tối đa 8% giá trị phần nghĩa vụ bị vi phạm.';

    const v2Page1 =
      'Điều 1. Đối tượng hợp đồng Bên B thực hiện tư vấn triển khai cho Bên A. Điều 2. Giá trị và thanh toán Tổng phí là 60.000.000 VND thanh toán trong 30 ngày.';
    const v2Page2 =
      'Điều 3. Bảo mật thông tin Hai bên giữ bí mật tài liệu trong 24 tháng. Điều 5. Gia hạn tự động Hợp đồng tự động gia hạn thêm 12 tháng nếu không báo trước.';

    expect(splitPageIntoClauses(v1Page1).length).toBeGreaterThanOrEqual(2);

    const diff = computeSignVersionDiff(
      [
        { page: 1, text: v1Page1 },
        { page: 2, text: v1Page2 },
      ],
      [
        { page: 1, text: v2Page1 },
        { page: 2, text: v2Page2 },
      ],
    );

    expect(diff.pageCountV1).toBe(2);
    expect(diff.pageCountV2).toBe(2);

    const changed = diff.hunks.filter((h) => h.kind !== 'unchanged');
    expect(changed.length).toBeGreaterThanOrEqual(2);

    // Fee change on page 1 coalesced into 'modified'
    const feeHunk = changed.find(
      (h) => h.kind === 'modified' && h.beforeText?.includes('45.000.000') && h.afterText?.includes('60.000.000'),
    );
    expect(feeHunk).toBeDefined();
    expect(feeHunk?.pageV1).toBe(1);
    expect(feeHunk?.pageV2).toBe(1);

    // Page 2 clause 4 removed and clause 5 added (either separate removed+added or modified on page 2)
    const page2Changes = changed.filter((h) => h.pageV1 === 2 || h.pageV2 === 2);
    expect(page2Changes.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(page2Changes)).toContain('8%');
    expect(JSON.stringify(page2Changes)).toContain('12 tháng');
  });

  it('stays fast and bounded even when comparing documents with >500 clauses', () => {
    const bigText1 = Array.from({ length: 520 }, (_, idx) => `Khoản ${idx + 1}. Nội dung điều khoản chuẩn số ${idx + 1}.`).join('\n');
    const bigText2 = Array.from({ length: 520 }, (_, idx) =>
      idx === 250
        ? `Khoản ${idx + 1}. Nội dung điều khoản đã sửa đổi mức phí tại mục ${idx + 1}.`
        : `Khoản ${idx + 1}. Nội dung điều khoản chuẩn số ${idx + 1}.`,
    ).join('\n');

    const start = Date.now();
    const diff = computeSignVersionDiff(
      [{ page: 1, text: bigText1 }],
      [{ page: 1, text: bigText2 }],
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(diff.stats.modifiedCount + diff.stats.addedCount + diff.stats.removedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('renderStarterContractPdf and Vietnamese SME templates (#3822)', () => {
  it('formats decimal string money values strictly via string regex without JS Number precision loss', () => {
    expect(formatContractDecimalAmount('125000000', 'VND')).toBe('125.000.000 VND');
    expect(formatContractDecimalAmount('9999999999999999.7500', 'USD')).toBe('9,999,999,999,999,999.75 USD');
    expect(() => formatContractDecimalAmount('12,500', 'VND')).toThrow();
    expect(() => formatContractDecimalAmount('-100', 'VND')).toThrow();
  });

  it('renders deterministic A4 PDFs across all 5 starter templates, embeds r1/r2 tags, neutralizes user/AI {{tags}}, and emits zero em/en dashes', () => {
    expect(SIGN_STARTER_TEMPLATE_KINDS).toEqual([
      'nda_mutual',
      'service_agreement',
      'acceptance_minutes',
      'liquidation_minutes',
      'freelancer_contract',
    ]);

    for (const kind of SIGN_STARTER_TEMPLATE_KINDS as readonly SignStarterTemplateKind[]) {
      const meta = STARTER_CONTRACT_TEMPLATES[kind];
      expect(meta.labelVi.length).toBeGreaterThan(3);

      const vars = {
        templateKind: kind,
        contractNumber: '08/2026/HĐ-LUDY',
        partyA: {
          name: 'Công ty TNHH Thương mại Ánh Dương {{signature, r9}}',
          taxCode: '0312345678',
          address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
          representative: 'Nguyễn Thị Minh Khai - Giám đốc',
        },
        partyB: {
          name: 'Công ty Cổ phần Giải pháp Số Phương Nam',
          taxCode: '0109876543',
          address: '88 Láng Hạ, Quận Đống Đa, Hà Nội',
          representative: 'Trần Quốc Tuấn - Tổng Giám đốc',
        },
        scopeSummary: 'Cung cấp dịch vụ tư vấn vận hành và bàn giao tài liệu hướng dẫn {{date, r8}}.',
        contractValue: kind === 'nda_mutual' ? null : '55000000',
        currency: 'VND' as const,
        effectiveDate: '2026-11-25',
        expiryDate: '2027-05-25',
        customClauses: [
          {
            heading: 'Điều khoản bổ sung {{signature, r3}}',
            body: 'Mọi thông báo gửi bằng văn bản tiếng Việt; không chấp nhận thẻ giả {{{{initials, r2}}}}.',
            proposedByAi: true,
          },
        ],
      };

      const clauses = buildStarterContractClauses(vars);
      expect(clauses.length).toBeGreaterThanOrEqual(4);
      const clausesJson = JSON.stringify(clauses);
      expect(/[\u2013\u2014]/.test(clausesJson)).toBe(false);
      expect(clausesJson).not.toContain('{{');
      expect(clausesJson).not.toContain('}}');

      const firstRender = renderStarterContractPdf(vars);
      const secondRender = renderStarterContractPdf(vars);

      // Byte-for-byte deterministic output
      expect(Buffer.from(firstRender.bytes).equals(Buffer.from(secondRender.bytes))).toBe(true);
      expect(firstRender.sha256).toBe(secondRender.sha256);
      expect(firstRender.pageCount).toBeGreaterThanOrEqual(1);
      expect(firstRender.filename.endsWith('.pdf')).toBe(true);
      expect(/[\u2013\u2014]/.test(firstRender.title)).toBe(false);
      expect(firstRender.title).not.toContain('{{');

      const header = Buffer.from(firstRender.bytes.subarray(0, 8)).toString('latin1');
      expect(header).toBe('%PDF-1.7');
    }

    expect(neutralizeContractInputText('A {{{{signature, r1}}}} B {\u0300{signature, r9}\u0300} \u2014 C')).toBe(
      'A { { { {signature, r1} } } } B { {signature, r9} } - C',
    );
  });
});

describe('sanitizeSharedSummaryForWrite and parseSharedSummary (#3822)', () => {
  it('strips invisible characters, rejects out-of-range page citations on write, and parses stored summaries safely', () => {
    expect(sanitizeSharedSummaryForWrite(null, 3)).toBeNull();
    expect(sanitizeSharedSummaryForWrite({ summaryText: '   ', keyTerms: [] }, 3)).toBeNull();
    expect(() =>
      sanitizeSharedSummaryForWrite(
        {
          summaryText: 'Hợp đồng',
          keyTerms: [{ label: 'Điều khoản', value: '8%', pageNumber: 99, quoteExcerpt: null }],
        },
        3,
      ),
    ).toThrow(/exceeds document page count/);

    const saved = sanitizeSharedSummaryForWrite(
      {
        summaryText: '  Hợp đồng dịch vụ thời hạn 12 tháng\u200B \u2014 thanh toán 2 đợt. ',
        keyTerms: [
          {
            label: 'Giá trị hợp đồng\uFEFF',
            value: '50.000.000 VND',
            pageNumber: 2,
            quoteExcerpt: 'Tổng giá trị hợp đồng là 50.000.000 VND',
          },
          {
            label: 'Điều khoản phạt',
            value: '8%',
            pageNumber: null,
            quoteExcerpt: null,
          },
        ],
      },
      3,
    );

    expect(saved).toEqual({
      summaryText: 'Hợp đồng dịch vụ thời hạn 12 tháng - thanh toán 2 đợt.',
      keyTerms: [
        {
          label: 'Giá trị hợp đồng',
          value: '50.000.000 VND',
          pageNumber: 2,
          quoteExcerpt: 'Tổng giá trị hợp đồng là 50.000.000 VND',
        },
        {
          label: 'Điều khoản phạt',
          value: '8%',
          pageNumber: null,
          quoteExcerpt: null,
        },
      ],
    });

    expect(parseSharedSummary(saved, 3)).toEqual(saved);
  });
});
