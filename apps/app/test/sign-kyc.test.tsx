// SPDX-License-Identifier: AGPL-3.0-only
// UI rendering, i18n parity, tainted Vy proposal badge, and mobile 44px / Label htmlFor accessibility tests for Slice 5e (#4443).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignKycListResultContract } from '../src/lib/sign-api.ts';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { EnvelopeKycCard, SIGN_KYC_POLL_INTERVAL_MS, kycRefetchIntervalMs } = await import(
  '../src/components/sign/envelope-kyc-card.tsx'
);

function renderVi(node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderEn(node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={catalog('en')} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const ENV_ID = '01900000-0000-7000-8000-000000000001';
const FIELD_ID = '01900000-0000-7000-8000-000000000002';
const SIGNER_ID = '01900000-0000-7000-8000-000000000003';
const FILE_ID = '01900000-0000-7000-8000-000000000004';
const FILE_SHA = 'a'.repeat(64);

function makeKycData(canWrite: boolean): SignKycListResultContract {
  return {
    envelopeId: ENV_ID,
    canWrite,
    items: [
      {
        fieldId: FIELD_ID,
        fieldLabel: 'Giấy chứng nhận ĐKKD',
        signerId: SIGNER_ID,
        signerName: 'Trần Thị B',
        signerEmail: 'tran@example.com',
        signerRoleLabel: 'Bên B',
        fileId: FILE_ID,
        filename: 'dkkd-minh-anh.pdf',
        contentType: 'application/pdf',
        sizeBytes: 24_576,
        fileSha256: FILE_SHA,
        filledAt: '2026-11-22T10:00:00Z',
        obligationCounterpartyName: 'Công ty TNHH Minh Anh',
        check: {
          id: '01900000-0000-7000-8000-000000000005',
          envelopeId: ENV_ID,
          fieldId: FIELD_ID,
          fileId: FILE_ID,
          fileSha256: FILE_SHA,
          status: 'needs_review',
          mode: 'ai',
          checkedBy: null,
          checkedAt: null,
          createdAt: '2026-11-22T10:01:00Z',
          updatedAt: '2026-11-22T10:02:00Z',
          findings: {
            documentKind: 'dkkd',
            mimeType: 'application/pdf',
            sizeBytes: 24_576,
            sha256Verified: true,
            pageCount: 1,
            inspectState: 'inspected',
            inspectError: null,
            expectedSignerName: 'Trần Thị B',
            expectedEntityName: 'Công ty TNHH Minh Anh',
            expectedTaxCode: '0101234567',
            extractedTaxCodes: ['0101234567'],
            extractedNationalIds: ['001099123456'],
            extractedTextPreview: 'GIẤY CHỨNG NHẬN ĐĂNG KÝ DOANH NGHIỆP - MST: 0101234567',
            deterministicChecks: [
              {
                category: 'file_integrity',
                status: 'matched',
                extractedValue: 'application/pdf (24576 B)',
                expectedValue: FILE_SHA.slice(0, 16),
                detail: 'Verified MIME type, size bounds, and SHA-256 digest match stored evidence.',
              },
              {
                category: 'tax_code',
                status: 'matched',
                extractedValue: '0101234567',
                expectedValue: '0101234567',
                detail: 'Extracted MST matches expected tax code.',
              },
            ],
            aiProposal: {
              suggestedStatus: 'needs_review',
              summaryNote: 'MST 0101234567 khớp, cần kiểm tra phạm vi đại diện trên trang 1.',
              promptVersion: 'v1',
              proposedByAi: true,
              findings: [
                {
                  category: 'authority_scope',
                  assessment: 'unclear',
                  extractedValue: null,
                  expectedValue: 'Trần Thị B',
                  pageNumber: 1,
                  quoteExcerpt: 'Người đại diện theo pháp luật: Trần Thị B',
                  explanation: 'Kiểm tra chức danh người ký trên hợp đồng.',
                  proposedByAi: true,
                },
              ],
            },
            manualNote: null,
          },
        },
      },
    ],
  };
}

describe('EnvelopeKycCard i18n, accessibility, and tainted Vy proposal UI (#4443)', () => {
  it('defines matching sign.kyc keys in vi and en with zero em/en dashes and aiMeter.features.sign_kyc_check', () => {
    expect(Object.keys(viCatalog.sign.kyc).sort()).toEqual(Object.keys(en.sign.kyc).sort());
    expect(viCatalog.aiMeter.features.sign_kyc_check).toBeTruthy();
    expect(en.aiMeter.features.sign_kyc_check).toBeTruthy();

    const walkStrings = (obj: unknown): string[] => {
      if (typeof obj === 'string') return [obj];
      if (obj && typeof obj === 'object') return Object.values(obj).flatMap(walkStrings);
      return [];
    };
    for (const str of [...walkStrings(viCatalog.sign.kyc), ...walkStrings(en.sign.kyc)]) {
      expect(str).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('renders deterministic findings, tainted Vy proposal badge, paired Label htmlFor attributes, and mobile min-h-11 controls for writers', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sign', 'kyc', ENV_ID], makeKycData(true));

    const htmlVi = renderVi(
      <EnvelopeKycCard envelopeId={ENV_ID} hasUploadedAttachments={true} onDownloadAttachment={() => {}} />,
      qc,
    );

    expect(htmlVi).toContain('sign-kyc-card');
    expect(htmlVi).toContain('Đối chiếu chứng từ định danh người ký (KYC)');
    expect(htmlVi).toContain('Kiểm tra tự động');
    expect(htmlVi).toContain('Đối chiếu bằng Vy');
    expect(htmlVi).toContain('Đề xuất');
    expect(htmlVi).toContain('Đề xuất từ Vy');
    expect(htmlVi).toContain('Đánh dấu đã khớp');
    expect(htmlVi).toContain('Cần kiểm tra lại');
    expect(htmlVi).toContain('MST phát hiện: 0101234567');
    expect(htmlVi).toContain('CCCD phát hiện: 001099123456');
    expect(htmlVi).toContain('max-md:min-h-11');

    for (const prefix of ['kyc-expected-entity-', 'kyc-expected-mst-', 'kyc-manual-note-']) {
      const id = `${prefix}${FIELD_ID}`;
      expect(htmlVi, `for=${id}`).toContain(`for="${id}"`);
      expect(htmlVi, `id=${id}`).toContain(`id="${id}"`);
    }

    const htmlEn = renderEn(
      <EnvelopeKycCard envelopeId={ENV_ID} hasUploadedAttachments={true} onDownloadAttachment={() => {}} />,
      qc,
    );
    expect(htmlEn).toContain('Signer KYC attachment verification');
    expect(htmlEn).toContain('Check with Vy');
    expect(htmlEn).toContain('Proposal');
    expect(htmlEn).toContain('Mark as matched');
  });

  it('hides write and AI trigger buttons for read-only viewers while showing findings and preview controls', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sign', 'kyc', ENV_ID], makeKycData(false));

    const htmlVi = renderVi(
      <EnvelopeKycCard envelopeId={ENV_ID} hasUploadedAttachments={true} onDownloadAttachment={() => {}} />,
      qc,
    );

    expect(htmlVi).toContain('sign-kyc-card');
    expect(htmlVi).toContain('Chỉ thành viên có quyền chỉnh sửa mới chạy đối chiếu hoặc xác nhận chứng từ.');
    expect(htmlVi).not.toContain(`sign-kyc-run-deterministic-${FIELD_ID}`);
    expect(htmlVi).not.toContain(`sign-kyc-analyze-vy-${FIELD_ID}`);
    expect(htmlVi).not.toContain(`sign-kyc-confirm-matched-${FIELD_ID}`);
    expect(htmlVi).toContain(`sign-kyc-toggle-preview-${FIELD_ID}`);
    expect(htmlVi).toContain(`sign-kyc-download-${FIELD_ID}`);
  });

  it('polls while any signer KYC check remains pending and stops once settled (#4510)', () => {
    const settled = makeKycData(true);
    expect(kycRefetchIntervalMs(undefined)).toBe(false);
    expect(kycRefetchIntervalMs(settled)).toBe(false);

    const pendingData: SignKycListResultContract = {
      ...settled,
      items: [
        {
          ...settled.items[0]!,
          check: {
            ...settled.items[0]!.check!,
            status: 'pending',
            mode: 'deterministic',
          },
        },
      ],
    };
    expect(kycRefetchIntervalMs(pendingData)).toBe(SIGN_KYC_POLL_INTERVAL_MS);

    const qc = new QueryClient();
    qc.setQueryData(['sign', 'kyc', ENV_ID], pendingData);
    const htmlPending = renderEn(
      <EnvelopeKycCard envelopeId={ENV_ID} hasUploadedAttachments={true} onDownloadAttachment={() => {}} />,
      qc,
    );
    expect(htmlPending).toContain('sign-kyc-card');
  });
});
