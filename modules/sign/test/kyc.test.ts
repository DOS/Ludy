// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for deterministic Vietnamese KYC attachment checks (MST 10/13 digits, CCCD 12 digits, folded names, SHA-256) (#4443).
import { describe, expect, it } from 'vitest';
import {
  detectKycDocumentKind,
  evaluateDeterministicKycAttachment,
  extractVietnamNationalIds,
  extractVietnamTaxCodes,
  normalizeFoldedVi,
} from '../src/kyc.ts';

const VALID_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

describe('Vietnamese KYC document helpers (#4443)', () => {
  it('folds Vietnamese diacritics including d/D with stroke and strips format-control chars', () => {
    expect(normalizeFoldedVi('Công ty TNHH Đầu tư Đông Á\u200B')).toBe('cong ty tnhh dau tu dong a');
    expect(normalizeFoldedVi('Đặng Thị Minh Ánh')).toBe('dang thi minh anh');
  });

  it('classifies CCCD, DKKD, and POA attachments from labels, filenames, and text', () => {
    expect(detectKycDocumentKind('Căn cước công dân', 'scan.png', null)).toBe('cccd');
    expect(detectKycDocumentKind(null, 'giay-dkkd-minh-anh.pdf', null)).toBe('dkkd');
    expect(detectKycDocumentKind('Giấy ủy quyền ký hợp đồng', 'attachment.pdf', null)).toBe('poa');
    expect(detectKycDocumentKind('Tài liệu bổ sung', 'appendix.pdf', 'Nội dung phụ lục')).toBe('other');
  });

  it('extracts 10-digit and 13-digit Vietnamese enterprise tax codes (MST) and 12-digit CCCD numbers', () => {
    const text = [
      'GIẤY CHỨNG NHẬN ĐĂNG KÝ DOANH NGHIỆP',
      'Mã số doanh nghiệp: 0101234567',
      'Chi nhánh tại Đà Nẵng - MST: 0101234567-001',
      'Người đại diện theo pháp luật: Đặng Thị Minh Ánh',
      'Số định danh cá nhân (CCCD): 001099123456',
      'Người nhận ủy quyền mang CCCD 079099001122',
    ].join('\n');

    expect(extractVietnamTaxCodes(text)).toEqual(['0101234567', '0101234567-001']);
    expect(extractVietnamNationalIds(text)).toEqual(['001099123456', '079099001122']);
  });
});

describe('evaluateDeterministicKycAttachment (#4443)', () => {
  it('returns matched when PDF attachment passes integrity and matches expected MST, entity name, and signer name', () => {
    const result = evaluateDeterministicKycAttachment({
      fieldLabel: 'Giấy chứng nhận ĐKKD',
      filename: 'dkkd-minh-anh.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 18_400,
      attachmentSha256: VALID_SHA,
      storedFileSha256: VALID_SHA,
      signerName: 'Đặng Thị Minh Ánh',
      obligationCounterpartyName: 'Công ty TNHH Thương mại Minh Anh',
      expectedTaxCode: '0101234567',
      inspectState: 'inspected',
      pages: [
        {
          page: 1,
          text: [
            'GIẤY CHỨNG NHẬN ĐĂNG KÝ DOANH NGHIỆP',
            'Tên công ty viết bằng tiếng Việt: CÔNG TY TNHH THƯƠNG MẠI MINH ANH',
            'Mã số doanh nghiệp: 0101234567',
            'Người đại diện theo pháp luật: ĐẶNG THỊ MINH ÁNH',
            'Số CCCD: 001099123456',
          ].join('\n'),
        },
      ],
    });

    expect(result.status).toBe('matched');
    expect(result.findings.documentKind).toBe('dkkd');
    expect(result.findings.sha256Verified).toBe(true);
    expect(result.findings.extractedTaxCodes).toEqual(['0101234567']);
    expect(result.findings.extractedNationalIds).toEqual(['001099123456']);
    expect(result.findings.deterministicChecks.map((c) => `${c.category}:${c.status}`)).toEqual([
      'file_integrity:matched',
      'tax_code:matched',
      'entity_name:matched',
      'authorized_signer:matched',
      'national_id:needs_review',
    ]);
  });

  it('flags mismatch when extracted MST or explicit legal representative differs, or SHA-256 digest mismatches', () => {
    const mstMismatch = evaluateDeterministicKycAttachment({
      fieldLabel: 'Giấy ĐKKD',
      filename: 'dkkd.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12_000,
      attachmentSha256: VALID_SHA,
      storedFileSha256: VALID_SHA,
      signerName: 'Trần Thị B',
      obligationCounterpartyName: 'Công ty TNHH Minh Anh',
      expectedTaxCode: '0109876543',
      inspectState: 'inspected',
      pages: [
        {
          page: 1,
          text: [
            'Tên doanh nghiệp: Công ty TNHH Khác Biệt Hoàn Toàn',
            'MST: 0101234567',
            'Người đại diện theo pháp luật: Lê Văn Khác',
          ].join('\n'),
        },
      ],
    });

    expect(mstMismatch.status).toBe('mismatch');
    expect(mstMismatch.findings.deterministicChecks.map((c) => `${c.category}:${c.status}`)).toEqual([
      'file_integrity:matched',
      'tax_code:mismatch',
      'entity_name:mismatch',
      'authorized_signer:mismatch',
    ]);

    const shaMismatch = evaluateDeterministicKycAttachment({
      fieldLabel: 'Ảnh CCCD',
      filename: 'cccd.png',
      mimeType: 'image/png',
      sizeBytes: 42_000,
      attachmentSha256: VALID_SHA,
      storedFileSha256: OTHER_SHA,
      signerName: 'Trần Thị B',
      obligationCounterpartyName: null,
      inspectState: 'image_metadata_only',
    });

    expect(shaMismatch.status).toBe('mismatch');
    expect(shaMismatch.findings.sha256Verified).toBe(false);
    expect(shaMismatch.findings.deterministicChecks[0]).toMatchObject({
      category: 'file_integrity',
      status: 'mismatch',
    });
  });

  it('marks branch-root MST (10-digit prefix match on 13-digit branch MST) and PNG/JPEG attachments as needs_review for human confirmation', () => {
    const branchCheck = evaluateDeterministicKycAttachment({
      fieldLabel: 'Giấy ĐKKD chi nhánh',
      filename: 'dkkd-cn.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 9_500,
      attachmentSha256: VALID_SHA,
      storedFileSha256: VALID_SHA,
      signerName: 'Trần Thị B',
      obligationCounterpartyName: null,
      expectedTaxCode: '0101234567',
      inspectState: 'inspected',
      pages: [
        {
          page: 1,
          text: 'Mã số thuế chi nhánh: 0101234567-002\nNgười đại diện: Trần Thị B',
        },
      ],
    });

    expect(branchCheck.status).toBe('needs_review');
    expect(branchCheck.findings.deterministicChecks.find((c) => c.category === 'tax_code')?.status).toBe('needs_review');

    const imageCheck = evaluateDeterministicKycAttachment({
      fieldLabel: 'Mặt trước CCCD',
      filename: 'cccd-front.png',
      mimeType: 'image/png',
      sizeBytes: 85_000,
      attachmentSha256: VALID_SHA,
      storedFileSha256: VALID_SHA,
      signerName: 'Trần Thị B',
      obligationCounterpartyName: null,
      inspectState: 'image_metadata_only',
    });

    expect(imageCheck.status).toBe('needs_review');
    expect(imageCheck.findings.documentKind).toBe('cccd');
    expect(imageCheck.findings.inspectState).toBe('image_metadata_only');
    expect(imageCheck.findings.deterministicChecks).toHaveLength(2);
    expect(imageCheck.findings.deterministicChecks[0]?.status).toBe('matched');
    expect(imageCheck.findings.deterministicChecks[1]?.status).toBe('needs_review');
  });
});
