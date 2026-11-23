// SPDX-License-Identifier: AGPL-3.0-only
// Component, accessibility, i18n, and offline PDF helper tests for eSign Slice 4f (#3822):
// - CounterpartySummaryBanner on /-/sign and /-/sign/d ('ready' only, zero on OTP screen, clickable Trang <n> buttons)
// - SenderSharedSummaryEditor paired <Label htmlFor> controls, min-h-11 targets, and viewer/member read-only gating
// - SignEnvelopesPage & SignTemplatesPage 'So sánh bản sửa đổi' and 'Soạn hợp đồng mẫu' entry buttons
// - Offline starter PDF helper buildOfflineStarterContractPdfBytes & normalizeStarterDecimalValue
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import {
  buildOfflineStarterContractPdfBytes,
  formatStarterAmountDisplay,
  neutralizeClientContractText,
  normalizeStarterDecimalValue,
} from '../src/lib/sign-starter-pdf.ts';
import type { SignSharedSummary } from '../src/lib/sign-api.ts';

const routerState = vi.hoisted(() => ({
  slug: 'acme',
  id: '01900000-0000-7000-8000-000000000001',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '') }, children),
    useParams: () => ({ slug: routerState.slug, id: routerState.id }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: new QC(),
    client: {},
    getCurrentOrg: () => 'acme',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { CounterpartySummaryBanner, SenderSharedSummaryEditor } = await import(
  '../src/components/sign/shared-summary-card.tsx'
);
const { SignCeremonyReadyView } = await import('../src/routes/sign-ceremony.tsx');
const { SignDirectOtpCard, SignDirectReadyView } = await import('../src/routes/sign-direct.tsx');
const { SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');
const { SignEnvelopeDetailPage } = await import('../src/routes/sign-envelope-detail.tsx');
const { SignTemplatesPage } = await import('../src/routes/sign-templates.tsx');

function renderLocale(node: ReactNode, locale: 'vi' | 'en' = 'vi', client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function assertPairedLabels(html: string): void {
  const labelForMatches = new Set(Array.from(html.matchAll(/<label[^>]+for="([^"]+)"/g), (m) => m[1]!));
  for (const tagMatch of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = tagMatch[0];
    if (/type="hidden"/.test(tag)) continue;
    const idMatch = /\bid="([^"]+)"/.exec(tag);
    const ariaLabelMatch = /\baria-label="([^"]+)"/.exec(tag);
    expect(Boolean((idMatch && labelForMatches.has(idMatch[1]!)) || ariaLabelMatch), `Unlabelled control: ${tag}`).toBe(
      true,
    );
  }
}

const SAMPLE_SUMMARY: SignSharedSummary = {
  summaryText: 'Hợp đồng cung cấp dịch vụ phần mềm thời hạn 12 tháng.',
  keyTerms: [
    {
      label: 'Giá trị hợp đồng',
      value: '60.000.000 VND',
      pageNumber: 2,
      quoteExcerpt: 'Tổng phí dịch vụ là 60.000.000 VND.',
    },
    {
      label: 'Thời hạn thanh toán',
      value: '15 ngày làm việc',
      pageNumber: 1,
      quoteExcerpt: null,
    },
  ],
};

describe('Slice 4f public counterparty summary & sender editor UI (#3822)', () => {
  it('renders the exact Vietnamese reference disclaimer and clickable Trang <n> buttons on /-/sign and /-/sign/d ready views, and never on OTP views', () => {
    const ceremonyWithSummary = renderLocale(
      <SignCeremonyReadyView
        viewState={{
          state: 'ready',
          orgName: 'Công ty Sao Mai',
          title: 'Hợp đồng dịch vụ #2026',
          message: 'Nhờ anh/chị xem và ký giúp.',
          signerName: 'Trần Văn B',
          roleLabel: 'Bên B',
          signerRole: 'signer',
          expiresAt: '2026-12-10T00:00:00.000Z',
          pageCount: 3,
          fields: [],
          sharedSummary: SAMPLE_SUMMARY,
        }}
        pdfBytes={null}
        loadingPdf={false}
        pdfError={null}
        viewerRenderError={null}
        pageNumber={1}
        scale={1}
        answers={{}}
        consentChecked={false}
        canSubmit={false}
        submitting={false}
        submitError={null}
        declineOpen={false}
        declineReason=""
        declining={false}
        declineError={null}
        padFieldId={null}
        onPageChange={() => {}}
        onScaleChange={() => {}}
        onRenderStatusChange={() => {}}
        onJumpToNext={() => {}}
        onOpenPad={() => {}}
        onUpdateAnswer={() => {}}
        onConsentChange={() => {}}
        onSubmit={() => {}}
        onDeclineOpenChange={() => {}}
        onDeclineReasonChange={() => {}}
        onDeclineSubmit={() => {}}
      />,
      'vi',
    );

    expect(ceremonyWithSummary).toContain(
      'Tóm tắt điểm chính (do người gửi cung cấp - chỉ mang tính tham khảo, vui lòng đọc toàn văn PDF trước khi ký)',
    );
    expect(ceremonyWithSummary).toContain('60.000.000 VND');
    expect(ceremonyWithSummary).toContain('Trang 2');
    expect(ceremonyWithSummary).toContain('Trang 1');
    expect(ceremonyWithSummary).toContain('data-testid="counterparty-summary-jump-page-2"');

    // English locale check + out-of-range page button suppression
    const ceremonyEnSummary = renderLocale(
      <CounterpartySummaryBanner sharedSummary={SAMPLE_SUMMARY} pageCount={1} onJumpToPage={() => {}} />,
      'en',
    );
    expect(ceremonyEnSummary).toContain('Key terms summary (provided by sender');
    // Page 2 exceeds pageCount=1 so out-of-range page button is hidden
    expect(ceremonyEnSummary).not.toContain('counterparty-summary-jump-page-2');
    expect(ceremonyEnSummary).toContain('counterparty-summary-jump-page-1');

    // Direct link ready view renders CounterpartySummaryBanner; OTP gate card NEVER renders it
    const directReadyHtml = renderLocale(
      <SignDirectReadyView
        viewState={{
          state: 'ready',
          orgName: 'Công ty Sao Mai',
          title: 'NDA hai chiều',
          description: null,
          message: null,
          roleLabel: 'Đối tác',
          signerRole: 'signer',
          emailRequired: false,
          requireEmailOtp: false,
          otpVerified: false,
          verifiedEmail: null,
          pageCount: 2,
          fieldCount: 2,
          sharedSummary: SAMPLE_SUMMARY,
        }}
        name=""
        email=""
        starting={false}
        startError={null}
        pdfBytes={null}
        loadingPdf={false}
        pdfError={null}
        pageNumber={1}
        scale={1}
        onNameChange={() => {}}
        onEmailChange={() => {}}
        onPageChange={() => {}}
        onScaleChange={() => {}}
        onStart={() => {}}
      />,
      'vi',
    );
    expect(directReadyHtml).toContain('counterparty-shared-summary-card');

    const directOtpHtml = renderLocale(
      <SignDirectOtpCard
        viewState={{
          state: 'otp_required',
          orgName: 'Công ty Sao Mai',
          title: 'NDA hai chiều',
          description: null,
          roleLabel: 'Đối tác',
          signerRole: 'signer',
          requireEmailOtp: true,
        }}
        email=""
        otpCode=""
        otpSent={false}
        maskedEmail={null}
        otpSending={false}
        otpVerifying={false}
        otpLocked={false}
        otpError={null}
        onEmailChange={() => {}}
        onOtpCodeChange={() => {}}
        onRequestOtp={() => {}}
        onVerifyOtp={() => {}}
      />,
      'vi',
    );
    expect(directOtpHtml).not.toContain('counterparty-shared-summary-card');
    expect(directOtpHtml).not.toContain('60.000.000 VND');
  });

  it('pairs every input/textarea/checkbox label in SenderSharedSummaryEditor and respects read-only viewer/non-creator permissions on SignEnvelopeDetailPage', () => {
    const editorHtml = renderLocale(
      <SenderSharedSummaryEditor
        recordKey="env-1"
        initialShare={true}
        initialSummary={SAMPLE_SUMMARY}
        pageCount={3}
        aiAnalysis={{
          status: 'completed',
          summaryText: 'Tóm tắt từ Vy',
          riskLevel: 'medium',
          proposedFields: [],
          riskClauses: [
            {
              clauseId: 'c1',
              title: 'Phạt chậm thanh toán',
              severity: 'medium',
              pageNumber: 2,
              quote: 'Phạt 8%',
              explanation: 'Mức phạt tối đa theo Luật Thương mại.',
            },
          ],
        }}
        editable={true}
        saving={false}
        onSave={() => {}}
      />,
      'vi',
    );

    assertPairedLabels(editorHtml);
    expect(editorHtml).toContain('Chia sẻ bản tóm tắt tham khảo cho người ký');
    expect(editorHtml).toContain('prefill-shared-summary-from-vy-btn');
    expect(editorHtml).toContain('save-shared-summary-btn');
    expect(editorHtml).toContain('min-h-11');

    // Seed SignEnvelopeDetailPage as a non-creator member -> editor renders read-only (no save button)
    const qc = new QueryClient();
    qc.setQueryData(['me', 'get'], {
      userId: '01900000-0000-7000-8000-000000000099',
      email: 'other@example.com',
      displayName: 'Other Member',
      orgs: [{ orgId: '01900000-0000-7000-8000-000000000050', slug: 'acme', name: 'Acme VN', role: 'member' }],
    });
    qc.setQueryData(['sign', 'envelope', routerState.id], {
      envelope: {
        id: routerState.id,
        title: 'Hợp đồng dịch vụ',
        subject: null,
        message: null,
        status: 'sent',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: '01900000-0000-7000-8000-000000000011',
        sourceSha256: 'a'.repeat(64),
        inspectStatus: 'passed',
        inspectError: null,
        pageCount: 2,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
        shareSummaryWithSigners: true,
        sharedSummary: SAMPLE_SUMMARY,
        sealedFileId: null,
        sealedSha256: null,
        certificateFileId: null,
        certificateSha256: null,
        certificateCode: null,
        sealStatus: null,
        sealError: null,
        expiresAt: null,
        sentAt: '2026-11-20T00:00:00.000Z',
        completedAt: null,
        voidedAt: null,
        voidReason: null,
        expiredAt: null,
        version: 2,
        createdBy: '01900000-0000-7000-8000-000000000010',
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
      signers: [],
      fields: [],
    });

    const nonCreatorHtml = renderLocale(<SignEnvelopeDetailPage />, 'vi', qc);
    expect(nonCreatorHtml).toContain('sender-shared-summary-editor');
    expect(nonCreatorHtml).not.toContain('save-shared-summary-btn');
  });

  it('exposes min-h-11 Version Diff and Contract Drafter entry buttons on /sign/envelopes and /sign/templates', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sign', 'envelopes', 'acme', 'all'], { items: [] });
    qc.setQueryData(['sign', 'templates', 'list', 'all', ''], { items: [] });

    const envelopesHtml = renderLocale(<SignEnvelopesPage />, 'vi', qc);
    expect(envelopesHtml).toContain('So sánh bản sửa đổi');
    expect(envelopesHtml).toContain('Soạn hợp đồng mẫu');
    expect(envelopesHtml).toContain('sign-open-version-diff-btn');
    expect(envelopesHtml).toContain('sign-open-drafter-btn');

    const templatesHtml = renderLocale(<SignTemplatesPage />, 'vi', qc);
    expect(templatesHtml).toContain('Soạn hợp đồng mẫu');
    expect(templatesHtml).toContain('sign-tpl-open-drafter-btn');
  });
});

describe('Offline starter contract PDF fallback helper (#3822)', () => {
  it('validates decimal money via @ludy/l10n-vn money() and generates offline %PDF-1.4 A4 PDFs with r1/r2 tags and neutralized inputs', () => {
    expect(normalizeStarterDecimalValue('  45000000 ')).toBe('45000000');
    expect(normalizeStarterDecimalValue('1250.50')).toBe('1250.5');
    expect(normalizeStarterDecimalValue('not-a-number')).toBeNull();
    expect(normalizeStarterDecimalValue('-500')).toBeNull();
    expect(formatStarterAmountDisplay('45000000', 'VND')).toBe('45.000.000 VND');
    expect(neutralizeClientContractText('Test {\u0300{signature, r9}\u0300} \u2014 ok')).toBe('Test { {signature, r9} } - ok');

    const built = buildOfflineStarterContractPdfBytes({
      templateKind: 'freelancer_contract',
      contractNumber: 'CTV-01',
      partyA: {
        name: 'Công ty TNHH Sao Khuê {\u0300{signature, r9}\u0300}',
        taxCode: '0311112222',
        address: 'TP.HCM',
        representative: 'Lê Văn An',
      },
      partyB: {
        name: 'Phạm Minh Tuấn',
        taxCode: null,
        address: 'Đà Nẵng',
        representative: null,
      },
      scopeSummary: 'Thiết kế giao diện ứng dụng di động.',
      contractValue: '18000000',
      currency: 'VND',
      effectiveDate: '2026-12-01',
      expiryDate: '2027-01-31',
      customClauses: [
        {
          heading: 'Bàn giao file nguồn',
          body: 'Bàn giao đầy đủ hệ thống component {{date, r5}}.',
          proposedByAi: false,
        },
      ],
    });

    const pdfText = new TextDecoder('latin1').decode(built);
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText).toContain('{{signature, r1}}');
    expect(pdfText).toContain('{{date, r1}}');
    expect(pdfText).toContain('{{signature, r2}}');
    expect(pdfText).toContain('{{date, r2}}');
    expect(pdfText).not.toContain('{{signature, r9}}');
    expect(pdfText).not.toContain('{{date, r5}}');
  });
});
