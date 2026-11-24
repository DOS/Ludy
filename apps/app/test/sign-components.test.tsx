// SPDX-License-Identifier: AGPL-3.0-only
// Component and screen rendering tests for eSign Slice 1c (#3325): Vy proposal overlays, AI-off parity,
// signer roster, envelope list filters, hash-fragment ceremony security, and offline SHA-256 certificate verification.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement } = await import('react');
  return {
    Sheet: ({ open = true, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({ closeLabel, children, ...rest }: { closeLabel: string; children?: ReactNode; [k: string]: unknown }) =>
      createElement('div', { role: 'dialog', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-header' }, children),
    SheetBody: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-body' }, children),
    SheetFooter: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-footer' }, children),
    SheetTitle: ({ children }: { children?: ReactNode }) => createElement('h2', { 'data-slot': 'sheet-title' }, children),
    SheetDescription: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-slot': 'sheet-description' }, children),
  };
});
import {
  publicSignApi,
  type SignAiAnalysis,
  type SignEnvelopeSummary,
  type SignProposedField,
  type SignSignerRecord,
} from '../src/lib/sign-api.ts';

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
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { FieldOptionsAndAttachmentEditor } = await import('../src/components/sign/field-options-editor.tsx');
const { FieldOverlayLayer } = await import('../src/components/sign/field-placer.tsx');
const { isCurrentPdfTargetRendered } = await import('../src/components/sign/pdf-canvas-viewer.tsx');
const { SignerPanel } = await import('../src/components/sign/signer-panel.tsx');
const { VyClausePanel, VyClauseSheet, VyClauseTrigger } = await import('../src/components/sign/vy-clause-panel.tsx');
const { fetchEnvelopesForTab, filterEnvelopesByTab, SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');
const {
  canManageEnvelopeLinksAndVoid,
  filterPendingProposalsForSigners,
  fromDatetimeLocalValue,
  SignEnvelopeDetailPage,
  toDatetimeLocalValue,
} = await import('../src/routes/sign-envelope-detail.tsx');
const {
  buildSignSubmitPayload,
  canSubmitCeremony,
  isApproverCeremonyMode,
  isFieldComplete,
  isFieldFilled,
  SignCeremonyPage,
  SignCeremonyReadyView,
} = await import('../src/routes/sign-ceremony.tsx');
const { extractCertificateJsonFields, SignVerifyPage } = await import('../src/routes/sign-verify.tsx');
const { normalizeAiAnalysis, signApi } = await import('../src/lib/sign-api.ts');
const {
  budgetPdfPagesForAi,
  hasUnresolvedImageOperators,
  hasUnsupportedPdfImageFilter,
  loadPdfDocument,
  PDF_UNSUPPORTED_IMAGE_DECODER_ERROR,
  SIGN_AI_MAX_PAGES_JSON_BYTES,
} = await import('../src/lib/sign-pdf.ts');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const SIGNER_1: SignSignerRecord = {
  id: 'signer-1',
  routingOrder: 1,
  signerRole: 'signer',
  roleLabel: 'Bên A',
  name: 'Nguyễn Văn A',
  email: 'a@example.com',
  phone: null,
  deliveryMode: 'link',
  requireEmailOtp: false,
  status: 'pending',
  tokenLastRemindedAt: null,
  viewedAt: null,
  signedAt: null,
  declinedAt: null,
  declineReason: null,
  otpVerifiedAt: null,
  signatureKind: null,
  consentAcceptedAt: null,
  createdAt: '2026-11-15T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
};

describe('Vy proposal overlay and clause summary (#3325)', () => {
  it('renders dashed semantic proposal overlays with apply/dismiss buttons and AI badges', () => {
    const proposal: SignProposedField = {
      proposalId: 'prop-1',
      signerId: 'signer-1',
      signerRoleKey: 'signer:1:ben-a',
      fieldType: 'signature',
      pageNumber: 1,
      xNorm: 0.6,
      yNorm: 0.72,
      wNorm: 0.24,
      hNorm: 0.08,
      label: 'Đại diện Bên A',
      required: true,
      confidence: 0.92,
      proposedByAi: true,
    };

    const html = renderVi(
      <FieldOverlayLayer
        pageNumber={1}
        fields={[
          {
            localId: 'f-1',
            signerId: 'signer-1',
            fieldType: 'date',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.72,
            wNorm: 0.18,
            hNorm: 0.05,
            label: null,
            required: true,
            proposedByAi: true,
          },
        ]}
        proposals={[proposal]}
        signers={[SIGNER_1]}
        selectedFieldId="f-1"
        editable={true}
        onSelectField={vi.fn()}
        onUpdateFieldBox={vi.fn()}
        onDeleteField={vi.fn()}
        onApplyProposal={vi.fn()}
        onDismissProposal={vi.fn()}
      />,
    );

    expect(html).toContain('border-dashed border-proposal bg-proposal/10');
    expect(html).toContain('Đề xuất - Kéo hoặc bấm Áp dụng');
    expect(html).toContain('Áp dụng');
    expect(html).toContain('Bỏ qua');
    expect(html).toContain('Từ Vy');
    expect(html).toContain('border-label-blue');
    expect(html.match(/\btouch-none\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    const readOnlyHtml = renderVi(
      <FieldOverlayLayer
        pageNumber={1}
        fields={[
          {
            localId: 'f-1',
            signerId: 'signer-1',
            fieldType: 'date',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.72,
            wNorm: 0.18,
            hNorm: 0.05,
            label: null,
            required: true,
            proposedByAi: true,
          },
        ]}
        proposals={[proposal]}
        signers={[SIGNER_1]}
        selectedFieldId="f-1"
        editable={false}
        onSelectField={vi.fn()}
        onUpdateFieldBox={vi.fn()}
        onDeleteField={vi.fn()}
        onApplyProposal={vi.fn()}
        onDismissProposal={vi.fn()}
      />,
    );
    expect(readOnlyHtml).not.toContain('touch-none');
  });

  it('normalizes #3351 SignAiAnalysisRecord shape cleanly and renders risk clauses', () => {
    const normalized = normalizeAiAnalysis({
      id: 'ai-1',
      orgId: 'org-1',
      envelopeId: 'env-1',
      sourceSha256: 'a'.repeat(64),
      status: 'completed',
      summaryText: 'Hợp đồng dịch vụ 12 tháng, thanh toán 30 ngày.',
      proposedFields: [
        {
          signerId: 'signer-1',
          signerRoleKey: 'signer:1:ben-a',
          fieldType: 'signature',
          pageNumber: 2,
          xNorm: 0.5,
          yNorm: 0.8,
          wNorm: 0.24,
          hNorm: 0.08,
          label: null,
          confidence: 0.9,
          proposedByAi: true,
        },
      ],
      riskClauses: [
        {
          title: 'Phạt chậm thanh toán',
          severity: 'high',
          pageNumber: 2,
          quote: 'Phạt 0,5%/ngày nếu chậm thanh toán.',
          explanation: 'Mức phạt cao hơn lãi suất thương mại thông thường.',
        },
      ],
      errorMessage: null,
      promptVersion: 'v1',
      completedAt: '2026-11-15T01:00:00Z',
      createdAt: '2026-11-15T00:59:00Z',
    });

    expect(normalized?.riskLevel).toBe('high');
    expect(normalized?.proposedFields[0]?.proposalId).toBeTruthy();

    const html = renderVi(
      <VyClausePanel
        aiAnalysis={normalized}
        pendingProposals={normalized?.proposedFields ?? []}
        editable={true}
        analyzing={false}
        onAnalyze={vi.fn()}
        onJumpToPage={vi.fn()}
        onApplyAllProposals={vi.fn()}
      />,
    );

    expect(html).toContain('Hợp đồng dịch vụ 12 tháng, thanh toán 30 ngày.');
    expect(html).toContain('Phạt chậm thanh toán');
    expect(html).toContain('Trang 2');
    expect(html).toContain('Áp dụng tất cả (1)');
    expect(html).toContain('Đề xuất từ Vy chỉ mang tính tham khảo');
  });

  it('degrades gracefully when AI is disabled or budget exhausted without hiding manual controls', () => {
    const disabledAnalysis: SignAiAnalysis = {
      status: 'disabled',
      summaryText: null,
      riskLevel: null,
      proposedFields: [],
      riskClauses: [],
    };
    const html = renderVi(
      <VyClausePanel
        aiAnalysis={disabledAnalysis}
        pendingProposals={[]}
        editable={true}
        analyzing={false}
        onAnalyze={vi.fn()}
        onJumpToPage={vi.fn()}
        onApplyAllProposals={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="vy-ai-off-notice"');
    expect(html).not.toContain('Phân tích cùng Vy');

    expect(normalizeAiAnalysis({ ai: 'busy', status: 'busy', analysis: null })).toMatchObject({
      status: 'running',
      errorMessage: 'SIGN_AI_BUSY',
    });
    expect(normalizeAiAnalysis({ ai: 'no_text', status: 'no_text', analysis: null })).toMatchObject({
      status: 'failed',
      errorMessage: 'no_text',
    });

    const partialOff = normalizeAiAnalysis({
      ai: 'off',
      analysis: {
        status: 'completed',
        summaryText: 'Saved summary before AI pause.',
        riskClauses: [{ clauseId: 'c1', title: 'Phạt trễ hạn', severity: 'medium', pageNumber: 1, quote: '5%', explanation: 'Lưu ý' }],
        proposedFields: [],
      },
    });
    expect(partialOff).toMatchObject({
      status: 'disabled',
      summaryText: 'Saved summary before AI pause.',
      riskLevel: 'medium',
    });
    expect(partialOff?.riskClauses).toHaveLength(1);

    const offWithSavedHtml = renderVi(
      <VyClausePanel
        aiAnalysis={partialOff}
        pendingProposals={[]}
        editable={true}
        analyzing={false}
        onAnalyze={vi.fn()}
        onJumpToPage={vi.fn()}
        onApplyAllProposals={vi.fn()}
      />,
    );
    expect(offWithSavedHtml).toContain('data-testid="vy-ai-off-notice"');
    expect(offWithSavedHtml).toContain('Saved summary before AI pause.');
    expect(offWithSavedHtml).toContain('Phạt trễ hạn');

    const noTextHtml = renderVi(
      <VyClausePanel
        aiAnalysis={{
          status: 'failed',
          summaryText: null,
          riskLevel: null,
          proposedFields: [],
          riskClauses: [],
          errorMessage: 'no_text',
        }}
        pendingProposals={[]}
        editable={true}
        analyzing={false}
        onAnalyze={vi.fn()}
        onJumpToPage={vi.fn()}
        onApplyAllProposals={vi.fn()}
      />,
    );
    expect(noTextHtml).toContain('data-testid="vy-ai-failed-notice"');
    expect(noTextHtml).toContain('chưa có văn bản trích xuất');
  });
});

describe('SignerPanel and Envelope list filters (#3325)', () => {
  it('renders routing mode, active signers, add form in draft, and Zalo/remind controls when sent', () => {
    const ccSigner: SignSignerRecord = {
      ...SIGNER_1,
      id: 'signer-cc',
      routingOrder: 2,
      signerRole: 'cc',
      roleLabel: 'Nhận bản sao',
      name: 'Kế toán CC',
    };
    const draftHtml = renderVi(
      <SignerPanel
        envelopeStatus="draft"
        routingMode="sequential"
        signers={[SIGNER_1, ccSigner]}
        activeSignerId="signer-1"
        onSelectSigner={vi.fn()}
        onChangeRoutingMode={vi.fn()}
        onAddSigner={vi.fn(async () => {})}
        onRemoveSigner={vi.fn(async () => {})}
        onMoveSigner={vi.fn(async () => {})}
      />,
    );

    expect(draftHtml).toContain('Theo thứ tự');
    expect(draftHtml).toContain('Song song');
    expect(draftHtml).toContain('Nguyễn Văn A');
    expect(draftHtml).toContain('Thêm người nhận');
    expect(draftHtml).toMatch(/disabled=""[^>]*data-testid="signer-select-signer-cc"|data-testid="signer-select-signer-cc"[^>]*disabled=""/);

    const linkOnlyHtml = renderVi(
      <SignerPanel
        envelopeStatus="sent"
        routingMode="sequential"
        signers={[SIGNER_1]}
        activeSignerId="signer-1"
        onSelectSigner={vi.fn()}
        onChangeRoutingMode={vi.fn()}
        onAddSigner={vi.fn(async () => {})}
        onRemoveSigner={vi.fn(async () => {})}
        onMoveSigner={vi.fn(async () => {})}
        onCopyZaloLink={vi.fn(async () => {})}
        onRemindSigner={vi.fn(async () => {})}
      />,
    );

    expect(linkOnlyHtml).toContain('Chép link Zalo');
    expect(linkOnlyHtml).not.toContain('Nhắc ký');

    const emailSigner: SignSignerRecord = {
      ...SIGNER_1,
      id: 'signer-email',
      routingOrder: 2,
      name: 'Trần Thị Email',
      deliveryMode: 'email',
      email: 'email@example.com',
    };
    const emailNoAddrSigner: SignSignerRecord = {
      ...emailSigner,
      id: 'signer-email-missing',
      routingOrder: 3,
      email: null,
    };
    const sentEmailHtml = renderVi(
      <SignerPanel
        envelopeStatus="sent"
        routingMode="sequential"
        signers={[emailSigner]}
        activeSignerId="signer-email"
        onSelectSigner={vi.fn()}
        onChangeRoutingMode={vi.fn()}
        onAddSigner={vi.fn(async () => {})}
        onRemoveSigner={vi.fn(async () => {})}
        onMoveSigner={vi.fn(async () => {})}
        onCopyZaloLink={vi.fn(async () => {})}
        onRemindSigner={vi.fn(async () => {})}
      />,
    );
    expect(sentEmailHtml).toContain('Chép link Zalo');
    expect(sentEmailHtml).toContain('Nhắc ký');

    const sentMissingEmailHtml = renderVi(
      <SignerPanel
        envelopeStatus="sent"
        routingMode="sequential"
        signers={[emailNoAddrSigner]}
        activeSignerId="signer-email-missing"
        onSelectSigner={vi.fn()}
        onChangeRoutingMode={vi.fn()}
        onAddSigner={vi.fn(async () => {})}
        onRemoveSigner={vi.fn(async () => {})}
        onMoveSigner={vi.fn(async () => {})}
        onCopyZaloLink={vi.fn(async () => {})}
        onRemindSigner={vi.fn(async () => {})}
      />,
    );
    expect(sentMissingEmailHtml).not.toContain('Nhắc ký');
  });

  it('caps extracted PDF page text under SIGN_AI_MAX_PAGES_JSON_BYTES without splitting surrogates', () => {
    const chunk = 'Hợp đồng dịch vụ 💼 '.repeat(300);
    const largePages = Array.from({ length: 200 }, (_, i) => ({
      page: i + 1,
      text: chunk,
    }));
    const budgeted = budgetPdfPagesForAi(largePages);
    expect(budgeted.length).toBeGreaterThan(0);
    expect(budgeted.length).toBeLessThan(200);
    const encodedBytes = new TextEncoder().encode(JSON.stringify(budgeted)).byteLength;
    expect(encodedBytes).toBeLessThanOrEqual(SIGN_AI_MAX_PAGES_JSON_BYTES);

    const surrogateBudget = 160;
    const surrogatePages = [{ page: 1, text: '𝄞'.repeat(80) }];
    const clipped = budgetPdfPagesForAi(surrogatePages, surrogateBudget);
    expect(clipped).toHaveLength(1);
    const lastCode = clipped[0]!.text.charCodeAt(clipped[0]!.text.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(clipped)).byteLength).toBeLessThanOrEqual(
      surrogateBudget,
    );
  });

  it('filters envelopes across status tabs accurately', () => {
    const base: SignEnvelopeSummary = {
      id: '1',
      title: 'Tài liệu',
      status: 'draft',
      routingMode: 'parallel',
      sourceKind: 'standalone',
      sourceId: null,
      sourceFileId: 'f1',
      inspectStatus: 'passed',
      sealStatus: null,
      certificateCode: null,
      pageCount: 2,
      expiresAt: null,
      sentAt: null,
      completedAt: null,
      voidedAt: null,
      expiredAt: null,
      version: 1,
      signerSummary: { total: 2, signed: 0, waitingForMe: false },
      createdBy: null,
      createdAt: '2026-11-15T00:00:00Z',
      updatedAt: '2026-11-15T00:00:00Z',
    };
    const items: SignEnvelopeSummary[] = [
      { ...base, id: 'd', status: 'draft' },
      { ...base, id: 'w', status: 'in_progress' },
      { ...base, id: 'c', status: 'completed', sealStatus: 'sealed' },
      { ...base, id: 'v', status: 'voided' },
    ];
    const waitingForMeItem: SignEnvelopeSummary = {
      ...base,
      id: 'me',
      status: 'in_progress',
      signerSummary: { total: 2, signed: 1, waitingForMe: true },
    };

    expect(filterEnvelopesByTab(items, 'all')).toHaveLength(4);
    expect(filterEnvelopesByTab(items, 'actionNeeded').map((i) => i.id)).toEqual(['d']);
    expect(filterEnvelopesByTab([...items, waitingForMeItem], 'actionNeeded').map((i) => i.id)).toEqual([
      'd',
      'me',
    ]);
    expect(filterEnvelopesByTab(items, 'waiting').map((i) => i.id)).toEqual(['w']);
    expect(filterEnvelopesByTab(items, 'completed').map((i) => i.id)).toEqual(['c']);
    expect(filterEnvelopesByTab(items, 'closed').map((i) => i.id)).toEqual(['v']);

    const listHtml = renderVi(<SignEnvelopesPage />);
    expect(listHtml).toContain('Ký kết tài liệu');
    expect(listHtml).toContain('Tạo hồ sơ ký');
  });

  it('pushes server status filters before limit=100 for status tabs', async () => {
    const spy = vi.spyOn(signApi, 'listEnvelopes').mockImplementation(async (input) => ({
      items: input?.status
        ? [
            {
              id: `id-${input.status}`,
              title: `Tài liệu ${input.status}`,
              status: input.status,
              routingMode: 'sequential',
              sourceKind: 'standalone',
              sourceId: null,
              sourceFileId: 'f1',
              inspectStatus: 'passed',
              sealStatus: input.status === 'completed' ? 'sealed' : null,
              certificateCode: null,
              pageCount: 1,
              expiresAt: null,
              sentAt: null,
              completedAt: null,
              voidedAt: null,
              expiredAt: null,
              version: 1,
              signerSummary: { total: 2, signed: 0, waitingForMe: false },
              createdBy: '01900000-0000-7000-8000-000000000009',
              createdAt: input.status === 'in_progress' ? '2026-11-16T02:00:00Z' : '2026-11-16T01:00:00Z',
              updatedAt: '2026-11-16T02:00:00Z',
            },
          ]
        : [],
    }));

    const completed = await fetchEnvelopesForTab('completed');
    expect(spy).toHaveBeenCalledWith({ status: 'completed', limit: 100 });
    expect(completed.items.map((item) => item.id)).toEqual(['id-completed']);

    spy.mockClear();
    const waiting = await fetchEnvelopesForTab('waiting');
    expect(spy).toHaveBeenCalledWith({ status: 'sent', limit: 100 });
    expect(spy).toHaveBeenCalledWith({ status: 'in_progress', limit: 100 });
    expect(waiting.items.map((item) => item.id)).toEqual(['id-in_progress', 'id-sent']);
  });
});

describe('Public signing ceremony and offline SHA-256 verifier (#3325)', () => {
  it('shows invalid link error when URL hash is missing (ignores query string ?token=)', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/-/sign', search: `?token=${'A'.repeat(43)}`, hash: '' },
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const html = renderVi(<SignCeremonyPage />);
    expect(html).toContain('data-testid="sign-ceremony-invalid"');
    expect(html).toContain('Liên kết ký không hợp lệ');
    expect(html).not.toContain('<nav');
  });

  it('rejects a malformed URL fragment even when sessionStorage holds an older token', () => {
    const store = new Map<string, string>([
      [
        'ludy.sign.ceremony.token',
        JSON.stringify({ token: 'A'.repeat(43), savedAt: Date.now() }),
      ],
      [
        'crove.sign.ceremony.token',
        JSON.stringify({ token: 'B'.repeat(43), savedAt: Date.now() }),
      ],
    ]);
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/-/sign', search: '', hash: '#short-bad' },
      history: { state: null, replaceState },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const html = renderVi(<SignCeremonyPage />);
    expect(html).toContain('data-testid="sign-ceremony-invalid"');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/-/sign');
    expect(store.has('ludy.sign.ceremony.token')).toBe(false);
    expect(store.has('crove.sign.ceremony.token')).toBe(false);
  });

  it('blocks signing submission until the PDF has downloaded and rendered without error', () => {
    const validBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const readyBase = {
      viewReady: true,
      incompleteRequiredCount: 0,
      consentChecked: true,
      pdfBytes: validBytes,
      loadingPdf: false,
      pdfError: null,
      viewerRenderError: null,
      pdfRendered: true,
    };

    expect(canSubmitCeremony(readyBase)).toBe(true);
    expect(canSubmitCeremony({ ...readyBase, pdfBytes: null, pdfRendered: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, loadingPdf: true, pdfRendered: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, pdfRendered: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, pdfError: 'network failed', pdfBytes: null, pdfRendered: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, viewerRenderError: 'corrupt PDF', pdfRendered: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, consentChecked: false })).toBe(false);
    expect(canSubmitCeremony({ ...readyBase, incompleteRequiredCount: 1 })).toBe(false);
  });

  it('invalidates rendered readiness whenever page or scale changes or a re-render fails', () => {
    const validBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const doc = {
      pageCount: 2,
      getPageSize: vi.fn(),
      renderPage: vi.fn(),
      destroy: vi.fn(),
    };
    const otherDoc = { ...doc };
    const renderedBase = {
      pdfBytes: validBytes,
      doc,
      pageSize: { width: 595, height: 842 },
      loadingDoc: false,
      renderingPage: false,
      renderError: null,
      renderedTarget: { doc, page: 1, scale: 1 },
      safePage: 1,
      scale: 1,
    };

    expect(isCurrentPdfTargetRendered(renderedBase)).toBe(true);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, renderingPage: true })).toBe(false);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, safePage: 2 })).toBe(false);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, scale: 1.5 })).toBe(false);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, doc: otherDoc })).toBe(false);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, renderedTarget: null })).toBe(false);
    expect(isCurrentPdfTargetRendered({ ...renderedBase, renderError: 'page failed' })).toBe(false);
  });

  it('extracts certificate SHA-256 JSON fields offline and renders verify controls cleanly', () => {
    const parsed = extractCertificateJsonFields(
      JSON.stringify({
        envelope: { title: 'HĐLĐ Nguyễn Văn B', certificateCode: 'CS-ABCD-1234-EFGH' },
        files: { sealedSha256: 'b'.repeat(64) },
      }),
    );
    expect(parsed).toEqual({
      certificateCode: 'CS-ABCD-1234-EFGH',
      envelopeTitle: 'HĐLĐ Nguyễn Văn B',
      sealedSha256: 'b'.repeat(64),
    });
    expect(extractCertificateJsonFields('{not json')).toBeNull();

    const html = renderVi(<SignVerifyPage />);
    expect(html).toContain('for="verify-pdf-file"');
    expect(html).toContain('id="verify-pdf-file"');
    expect(html).toContain('data-testid="verify-pdf-input"');
    expect(html).toContain('data-testid="verify-cert-code-input"');
    expect(html).toContain('Tệp PDF của bạn không bao giờ rời thiết bị.');
  });

  it('sends credential-free public verify requests and maps opaque 404 mismatches cleanly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'SIGN_NOT_FOUND' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await publicSignApi.verifyPublic({
      certificateCode: 'CS-1111-2222-3333',
      fileSha256: 'a'.repeat(64),
    });

    expect(res).toEqual({ matched: false, certificateCode: 'CS-1111-2222-3333' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.method).toBe('POST');
  });

  it('drops stale Vy proposals whose target signer was deleted instead of reassigning them', () => {
    const proposals: SignProposedField[] = [
      {
        proposalId: 'prop-keep',
        signerId: 'signer-1',
        signerRoleKey: 'signer:1:ben-a',
        fieldType: 'signature',
        pageNumber: 1,
        xNorm: 0.5,
        yNorm: 0.7,
        wNorm: 0.24,
        hNorm: 0.08,
        label: null,
        required: true,
        confidence: 0.95,
        proposedByAi: true,
      },
      {
        proposalId: 'prop-deleted',
        signerId: 'signer-removed',
        signerRoleKey: 'signer:2:ben-b',
        fieldType: 'signature',
        pageNumber: 1,
        xNorm: 0.2,
        yNorm: 0.7,
        wNorm: 0.24,
        hNorm: 0.08,
        label: null,
        required: true,
        confidence: 0.9,
        proposedByAi: true,
      },
      {
        proposalId: 'prop-cc',
        signerId: 'signer-cc',
        signerRoleKey: 'cc:3',
        fieldType: 'date',
        pageNumber: 1,
        xNorm: 0.2,
        yNorm: 0.85,
        wNorm: 0.16,
        hNorm: 0.04,
        label: null,
        required: true,
        confidence: 0.8,
        proposedByAi: true,
      },
    ];
    const ccSigner: SignSignerRecord = {
      ...SIGNER_1,
      id: 'signer-cc',
      routingOrder: 3,
      signerRole: 'cc',
    };

    const filtered = filterPendingProposalsForSigners(proposals, [SIGNER_1, ccSigner], []);
    expect(filtered.map((p) => p.proposalId)).toEqual(['prop-keep']);
  });

  it('rejects PDFs requiring WASM image decoders while loading and rendering valid FlateDecode PDFs', async () => {
    const buildSyntheticPdf = (imageDict: string, streamBytes: Uint8Array): Uint8Array => {
      const enc = new TextEncoder();
      const chunks: Uint8Array[] = [];
      const offsets: number[] = [];
      let byteOffset = 0;
      const push = (part: string | Uint8Array) => {
        const bytes = typeof part === 'string' ? enc.encode(part) : part;
        chunks.push(bytes);
        byteOffset += bytes.byteLength;
      };

      push('%PDF-1.4\n');
      const objs: Array<[string, Uint8Array | null, string]> = [
        ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', null, ''],
        ['2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', null, ''],
        [
          '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
          null,
          '',
        ],
        [`4 0 obj\n${imageDict}\nstream\n`, streamBytes, '\nendstream\nendobj\n'],
        ['5 0 obj\n<< /Length 26 >>\nstream\nq 100 0 0 100 10 10 cm /Im0 Do Q\nendstream\nendobj\n', null, ''],
      ];
      for (const [head, body, tail] of objs) {
        offsets.push(byteOffset);
        push(head);
        if (body) {
          push(body);
          push(tail);
        }
      }
      const xrefOffset = byteOffset;
      push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
      for (const offset of offsets) {
        push(`${String(offset).padStart(10, '0')} 00000 n \n`);
      }
      push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

      const out = new Uint8Array(byteOffset);
      let cursor = 0;
      for (const chunk of chunks) {
        out.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return out;
    };

    const dummyStream = new Uint8Array([0x00, 0x00]);
    const unsupportedDicts = [
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 1 /ImageMask false /Filter /CCITTFaxDecode /Length 2 >>',
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 1 /ImageMask true /Filter /CCITTFaxDecode /Length 2 >>',
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 1 /Filter /JBIG2Decode /Length 2 >>',
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /JPXDecode /Length 2 >>',
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 1 /Filter [/FlateDecode /CCITTFaxDecode] /Length 2 >>',
    ];

    for (const dict of unsupportedDicts) {
      const pdfBytes = buildSyntheticPdf(dict, dummyStream);
      expect(hasUnsupportedPdfImageFilter(pdfBytes)).toBe(true);
      await expect(loadPdfDocument(pdfBytes)).rejects.toThrow(PDF_UNSUPPORTED_IMAGE_DECODER_ERROR);
    }

    // Valid zlib-stored 1x1 grayscale image ([0xff]) with FlateDecode (Adler32 of [0xff] is 0x01010100).
    const flateStream = new Uint8Array([0x78, 0x9c, 0x01, 0x01, 0x00, 0xfe, 0xff, 0xff, 0x01, 0x01, 0x01, 0x00]);
    const validFlatePdf = buildSyntheticPdf(
      `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${flateStream.byteLength} >>`,
      flateStream,
    );
    expect(hasUnsupportedPdfImageFilter(validFlatePdf)).toBe(false);
    const flateHandle = await loadPdfDocument(validFlatePdf);
    try {
      expect(flateHandle.pageCount).toBe(1);
      await expect(flateHandle.getPageSize(1)).resolves.toEqual({ width: 200, height: 200 });
    } finally {
      await flateHandle.destroy();
    }

    // Valid vector PDF exercises full page.render + getOperatorList() without requiring node canvas image factory.
    const vectorPdf = new TextEncoder().encode(
      [
        '%PDF-1.4',
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj',
        '4 0 obj\n<< /Length 27 >>\nstream\n0 0 0 rg 10 10 100 100 re f\nendstream\nendobj',
        'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000192 00000 n \n',
        'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n268\n%%EOF\n',
      ].join('\n'),
    );
    const vectorHandle = await loadPdfDocument(vectorPdf);
    try {
      vi.stubGlobal(
        'Path2D',
        class {
          addPath() {}
          moveTo() {}
          lineTo() {}
          bezierCurveTo() {}
          closePath() {}
          rect() {}
        },
      );
      const ctx2d = new Proxy(
        {
          getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
          createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
        } as Record<string, unknown>,
        {
          get(target, prop: string) {
            return prop in target ? target[prop] : () => undefined;
          },
        },
      );
      const mockCanvas = {
        width: 0,
        height: 0,
        style: {},
        getContext: () => ctx2d,
      } as unknown as HTMLCanvasElement;
      await expect(vectorHandle.renderPage(1, mockCanvas, 1)).resolves.toEqual({ width: 200, height: 200 });
    } finally {
      await vectorHandle.destroy();
    }

    const imageOps = new Set([83, 85]);
    const emptyStore = { has: () => false, get: () => null };
    const decodedStore = {
      has: (id: string) => id === 'img_ok' || id === 'g_mask_null',
      get: (id: string) => (id === 'img_ok' ? { width: 1, height: 1 } : null),
    };
    expect(
      hasUnresolvedImageOperators(
        { fnArray: [85], argsArray: [['img_ok', 1, 1]] },
        imageOps,
        { objs: decodedStore, commonObjs: emptyStore },
      ),
    ).toBe(false);
    expect(
      hasUnresolvedImageOperators(
        { fnArray: [83], argsArray: [[{ data: 'g_mask_null' }]] },
        imageOps,
        { objs: emptyStore, commonObjs: decodedStore },
      ),
    ).toBe(true);
    expect(
      hasUnresolvedImageOperators(
        { fnArray: [85], argsArray: [['img_missing', 1, 1]] },
        imageOps,
        { objs: emptyStore, commonObjs: emptyStore },
      ),
    ).toBe(true);
  });

  it('renders dedicated Approver ceremony UI without signature pad while keeping Signer ceremony intact (#3528)', async () => {
    const noop = () => {};
    const approverView = {
      state: 'ready' as const,
      orgName: 'Công ty ABC',
      title: 'Hợp đồng cung cấp dịch vụ 2026',
      message: 'Nhờ anh/chị xem xét phê duyệt.',
      signerName: 'Trần Thị Bình',
      roleLabel: 'Kế toán trưởng',
      signerRole: 'approver' as const,
      expiresAt: '2027-02-01T00:00:00.000Z',
      pageCount: 1,
      fields: [],
    };
    const commonProps = {
      answers: {},
      pdfBytes: new Uint8Array([1, 2, 3]),
      loadingPdf: false,
      pdfError: null,
      viewerRenderError: null,
      pageNumber: 1,
      scale: 1,
      consentChecked: true,
      canSubmit: true,
      submitting: false,
      submitError: null,
      declineOpen: false,
      declineReason: '',
      declining: false,
      declineError: null,
      padFieldId: null,
      onPageChange: noop,
      onScaleChange: noop,
      onRenderStatusChange: noop,
      onJumpToNext: noop,
      onOpenPad: noop,
      onUpdateAnswer: noop,
      onConsentChange: noop,
      onSubmit: noop,
      onDeclineOpenChange: noop,
      onDeclineReasonChange: noop,
      onDeclineSubmit: noop,
    };

    expect(isApproverCeremonyMode(approverView)).toBe(true);
    const viApproverHtml = renderVi(<SignCeremonyReadyView viewState={approverView} {...commonProps} />);
    expect(viApproverHtml).toContain('data-testid="ceremony-role-badge"');
    expect(viApproverHtml).toContain('Người duyệt');
    expect(viApproverHtml).toContain('data-testid="ceremony-approver-card"');
    expect(viApproverHtml).toContain('Không cần vẽ chữ ký');
    expect(viApproverHtml).toContain('Tôi xác nhận đã xem xét và phê duyệt tài liệu này bằng phương thức điện tử.');
    expect(viApproverHtml).toContain('Phê duyệt tài liệu');
    expect(viApproverHtml).toContain('Từ chối phê duyệt');
    expect(viApproverHtml).not.toContain('Bấm để ký');
    expect(viApproverHtml).not.toContain('Hoàn tất ký');

    const enApproverHtml = renderEn(<SignCeremonyReadyView viewState={approverView} {...commonProps} />);
    expect(enApproverHtml).toContain('Approver');
    expect(enApproverHtml).toContain('Approve document');
    expect(enApproverHtml).toContain('Decline approval');

    // Optional text/date/checkbox fields for approver keep paired labels and accurate optional/filled badges.
    const approverWithOptionalFields = {
      ...approverView,
      fields: [
        {
          id: 'field-note-1',
          fieldType: 'text' as const,
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.2,
          wNorm: 0.3,
          hNorm: 0.05,
          label: 'Ghi chú duyệt',
          required: false,
        },
        {
          id: 'field-chk-1',
          fieldType: 'checkbox' as const,
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.3,
          wNorm: 0.05,
          hNorm: 0.05,
          label: 'Đã kiểm tra ngân sách',
          required: false,
        },
      ],
    };
    expect(isApproverCeremonyMode(approverWithOptionalFields)).toBe(true);
    expect(isFieldFilled(approverWithOptionalFields.fields[0]!, undefined)).toBe(false);
    expect(isFieldComplete(approverWithOptionalFields.fields[0]!, undefined)).toBe(true);

    const optionalFieldsHtml = renderVi(
      <SignCeremonyReadyView
        viewState={approverWithOptionalFields}
        {...commonProps}
        answers={{ 'field-chk-1': { valueChecked: true } }}
      />,
    );
    expect(optionalFieldsHtml).toContain('for="ceremony-field-input-field-note-1"');
    expect(optionalFieldsHtml).toContain('id="ceremony-field-input-field-note-1"');
    expect(optionalFieldsHtml).toContain('for="ceremony-field-checkbox-field-chk-1"');
    expect(optionalFieldsHtml).toContain('id="ceremony-field-checkbox-field-chk-1"');
    expect(optionalFieldsHtml).toContain('Không bắt buộc');
    expect(optionalFieldsHtml).toContain('Đã điền');
    expect(optionalFieldsHtml).not.toContain('Bấm để ký');

    const approverPayload = buildSignSubmitPayload({
      token: 'T'.repeat(43),
      fields: approverWithOptionalFields.fields,
      answers: {
        'field-note-1': { valueText: 'Đồng ý chi' },
        'field-chk-1': { valueChecked: true },
      },
    });
    expect(approverPayload.signatureKind).toBeUndefined();
    expect(approverPayload.fields).toEqual([
      { fieldId: 'field-note-1', valueText: 'Đồng ý chi' },
      { fieldId: 'field-chk-1', valueChecked: true },
    ]);

    // Standard signer ceremony keeps signature pad CTA and signer consent/buttons.
    const signerView = {
      ...approverView,
      signerRole: 'signer' as const,
      roleLabel: 'Bên A',
      fields: [
        {
          id: 'field-sig-1',
          fieldType: 'signature' as const,
          pageNumber: 1,
          xNorm: 0.5,
          yNorm: 0.7,
          wNorm: 0.25,
          hNorm: 0.08,
          label: null,
          required: true,
        },
      ],
    };
    expect(isApproverCeremonyMode(signerView)).toBe(false);
    const signerHtml = renderVi(<SignCeremonyReadyView viewState={signerView} {...commonProps} />);
    expect(signerHtml).not.toContain('data-testid="ceremony-role-badge"');
    expect(signerHtml).toContain('data-testid="ceremony-sign-btn-field-sig-1"');
    expect(signerHtml).toContain('Bấm để ký');
    expect(signerHtml).toContain('Hoàn tất ký');
    expect(signerHtml).toContain('Từ chối ký');

    const signerPayload = buildSignSubmitPayload({
      token: 'T'.repeat(43),
      fields: signerView.fields,
      answers: {
        'field-sig-1': {
          signaturePngDataUrl: 'data:image/png;base64,AAAA',
          signatureKind: 'drawn',
        },
      },
    });
    expect(signerPayload.signatureKind).toBe('draw');

    // Guardrail: an approver row unexpectedly assigned a signature field still sees signature controls.
    expect(isApproverCeremonyMode({ ...signerView, signerRole: 'approver' })).toBe(false);

    // Public view normalizes signerRole strictly from server JSON.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            state: 'ready',
            orgName: 'Công ty ABC',
            title: 'HD',
            message: null,
            signerName: 'Bình',
            roleLabel: 'Người duyệt',
            signerRole: 'approver',
            expiresAt: '2027-02-01T00:00:00Z',
            pageCount: 1,
            fields: [],
          }),
          { status: 200 },
        ),
      ),
    );
    const normalizedApprover = await publicSignApi.view('T'.repeat(43));
    expect(normalizedApprover.state).toBe('ready');
    if (normalizedApprover.state === 'ready') {
      expect(normalizedApprover.signerRole).toBe('approver');
    }

    // Missing or unrecognized signerRole defaults safely to 'signer'; required date field and pdfError render cleanly for approvers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            state: 'ready',
            orgName: 'Công ty ABC',
            title: 'HD',
            message: null,
            signerName: 'An',
            roleLabel: 'Bên A',
            signerRole: 'unexpected',
            expiresAt: '2027-02-01T00:00:00Z',
            pageCount: 1,
            fields: [],
          }),
          { status: 200 },
        ),
      ),
    );
    const normalizedDefault = await publicSignApi.view('T'.repeat(43));
    expect(normalizedDefault.state).toBe('ready');
    if (normalizedDefault.state === 'ready') {
      expect(normalizedDefault.signerRole).toBe('signer');
    }

    const approverRequiredDateHtml = renderVi(
      <SignCeremonyReadyView
        viewState={{
          ...approverView,
          fields: [
            {
              id: 'field-date-1',
              fieldType: 'date',
              pageNumber: 1,
              xNorm: 0.2,
              yNorm: 0.3,
              wNorm: 0.2,
              hNorm: 0.05,
              label: 'Ngày duyệt',
              required: true,
            },
          ],
        }}
        {...commonProps}
        canSubmit={false}
        pdfError="Không tải được tệp"
      />,
    );
    expect(approverRequiredDateHtml).toContain('Bắt buộc');
    expect(approverRequiredDateHtml).toContain('data-testid="ceremony-remaining-badge"');
    expect(approverRequiredDateHtml).toContain('Vui lòng đợi tài liệu tải xong trước khi phê duyệt.');
  });

  it('surfaces deterministic PDF text tags in Prepare screen with 100% AI-off parity (#3552)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const envId = routerState.id;

    qc.setQueryData(['sign', 'envelope', envId], {
      envelope: {
        id: envId,
        title: 'Hợp đồng xuất từ Google Docs',
        subject: null,
        message: null,
        status: 'draft',
        routingMode: 'sequential',
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: '01900000-0000-7000-8000-000000000099',
        sourceSha256: 'a'.repeat(64),
        inspectStatus: 'passed',
        inspectError: null,
        pageCount: 2,
        pageDimensions: [
          { page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0 },
          { page: 2, widthPt: 595.28, heightPt: 841.89, rotation: 0 },
        ],
        detectedTags: [
          {
            pageNumber: 1,
            fieldType: 'signature',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: null,
            xNorm: 0.15,
            yNorm: 0.72,
            wNorm: 0.22,
            hNorm: 0.06,
          },
          {
            pageNumber: 1,
            fieldType: 'date',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: null,
            xNorm: 0.45,
            yNorm: 0.73,
            wNorm: 0.16,
            hNorm: 0.03,
          },
          {
            pageNumber: 2,
            fieldType: 'text',
            roleOrder: 2,
            roleKey: 'r2',
            required: true,
            label: 'Chức danh',
            xNorm: 0.2,
            yNorm: 0.5,
            wNorm: 0.24,
            hNorm: 0.03,
          },
        ],
        sealedFileId: null,
        sealedSha256: null,
        sealStatus: null,
        certificateFileId: null,
        certificateSha256: null,
        certificateCode: null,
        expiresAt: null,
        sentAt: null,
        completedAt: null,
        declinedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        expiredAt: null,
        version: 2,
        createdBy: '01900000-0000-7000-8000-000000000088',
        createdAt: '2026-11-17T00:00:00Z',
        updatedAt: '2026-11-17T00:00:00Z',
      },
      signers: [
        SIGNER_1,
        {
          ...SIGNER_1,
          id: 'signer-2',
          routingOrder: 2,
          roleLabel: 'Bên B',
          name: 'Trần Thị B',
          email: 'b@example.com',
        },
      ],
      fields: [],
    });

    // AI completely turned off (AI_ENABLED=false / org AI off).
    qc.setQueryData(['sign', 'ai', envId], {
      status: 'disabled',
      summaryText: null,
      riskLevel: null,
      proposedFields: [],
      riskClauses: [],
    } satisfies SignAiAnalysis);

    const viHtml = renderVi(<SignEnvelopeDetailPage />, qc);
    expect(viHtml).toContain('data-testid="sign-detected-tags-banner"');
    expect(viHtml).toContain('data-testid="sign-apply-detected-tags-btn"');
    expect(viHtml).toContain('Áp dụng 3 ô từ thẻ tài liệu');
    expect(viHtml).toContain('data-testid="vy-clause-trigger"');
    expect(viHtml).toContain('Vy đọc hợp đồng');

    const triggerRef = createRef<HTMLButtonElement>();
    const vyTriggerHtml = renderVi(
      <VyClauseTrigger open={false} onToggle={vi.fn()} buttonRef={triggerRef} proposalCount={0} />,
    );
    expect(vyTriggerHtml).toContain('max-md:min-h-11');

    const vySheetOffHtml = renderVi(
      <VyClauseSheet
        open
        onClose={vi.fn()}
        triggerRef={triggerRef}
        aiAnalysis={{
          status: 'disabled',
          summaryText: null,
          riskLevel: null,
          proposedFields: [],
          riskClauses: [],
        }}
        pendingProposals={[]}
        editable={true}
        analyzing={false}
        onAnalyze={vi.fn()}
        onJumpToPage={vi.fn()}
        onApplyAllProposals={vi.fn()}
      />,
    );
    expect(vySheetOffHtml).toContain('data-testid="vy-clause-sheet"');
    expect(vySheetOffHtml).toContain('Tính năng AI đang tắt hoặc hết ngân sách tháng.');

    const enHtml = renderEn(<SignEnvelopeDetailPage />, qc);
    expect(enHtml).toContain('Apply 3 tag fields');
    expect(enHtml).toContain('Vy contract review');
  });

  it('renders 24h pre-expiry auto-remind toggle on draft envelopes and declined reason + pre-expiry badge on signers (#3813)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const envId = routerState.id;

    expect(toDatetimeLocalValue(null)).toBe('');
    expect(fromDatetimeLocalValue('')).toBeNull();
    const roundTripIso = fromDatetimeLocalValue(toDatetimeLocalValue('2026-11-20T09:30:00Z'));
    expect(roundTripIso).toBe('2026-11-20T09:30:00.000Z');

    qc.setQueryData(['sign', 'envelope', envId], {
      envelope: {
        id: envId,
        title: 'Hợp đồng dịch vụ cần nhắc hạn',
        subject: null,
        message: null,
        status: 'draft' as const,
        routingMode: 'sequential' as const,
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: '01900000-0000-7000-8000-000000000077',
        sourceSha256: 'a'.repeat(64),
        inspectStatus: 'passed' as const,
        inspectError: null,
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
        sealedFileId: null,
        sealedSha256: null,
        sealStatus: null,
        certificateFileId: null,
        certificateSha256: null,
        certificateCode: null,
        expiresAt: '2026-11-20T08:00:00Z',
        autoRemindBeforeExpiry: true,
        sentAt: null,
        completedAt: null,
        declinedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        expiredAt: null,
        version: 1,
        createdBy: '01900000-0000-7000-8000-000000000088',
        createdAt: '2026-11-19T00:00:00Z',
        updatedAt: '2026-11-19T00:00:00Z',
      },
      signers: [SIGNER_1],
      fields: [],
    });
    qc.setQueryData(['sign', 'ai', envId], {
      status: 'disabled',
      summaryText: null,
      riskLevel: null,
      proposedFields: [],
      riskClauses: [],
    } satisfies SignAiAnalysis);

    const draftVi = renderVi(<SignEnvelopeDetailPage />, qc);
    expect(draftVi).toContain('data-testid="env-auto-remind-checkbox"');
    expect(draftVi).toContain('Tự động nhắc qua email trước 24 giờ khi sắp hết hạn');
    expect(draftVi).toContain('id="env-expires-at-input"');
    expect(draftVi).toContain('max-md:min-h-11');

    const draftEn = renderEn(<SignEnvelopeDetailPage />, qc);
    expect(draftEn).toContain('Send automatic 24-hour pre-expiry email reminder');
    expect(draftEn).toContain('Signing deadline (optional)');

    // Declined unacknowledged envelope shows Acknowledge decline action in PageHeader.
    const declinedQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    declinedQc.setQueryData(['sign', 'envelope', envId], {
      envelope: {
        id: envId,
        title: 'Hợp đồng bị từ chối',
        subject: null,
        message: null,
        status: 'declined' as const,
        routingMode: 'parallel' as const,
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: '01900000-0000-7000-8000-000000000077',
        sourceSha256: 'a'.repeat(64),
        inspectStatus: 'passed' as const,
        inspectError: null,
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
        sealedFileId: null,
        sealedSha256: null,
        sealStatus: null,
        certificateFileId: null,
        certificateSha256: null,
        certificateCode: null,
        expiresAt: null,
        autoRemindBeforeExpiry: true,
        sentAt: '2026-11-19T01:00:00Z',
        completedAt: null,
        declinedAt: '2026-11-19T02:00:00Z',
        declineAcknowledgedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        expiredAt: null,
        version: 2,
        createdBy: '01900000-0000-7000-8000-000000000088',
        createdAt: '2026-11-19T00:00:00Z',
        updatedAt: '2026-11-19T02:00:00Z',
      },
      signers: [SIGNER_1],
      fields: [],
    });
    const declinedVi = renderVi(<SignEnvelopeDetailPage />, declinedQc);
    expect(declinedVi).toContain('data-testid="sign-ack-decline-btn"');
    expect(declinedVi).toContain('Đã nắm / Ẩn khỏi Hôm nay');

    const activePanelVi = renderVi(
      <SignerPanel
        envelopeStatus="declined"
        routingMode="sequential"
        signers={[
          {
            ...SIGNER_1,
            id: 'signer-reminded',
            status: 'viewed',
            deliveryMode: 'email',
            preExpiryRemindedAt: '2026-11-19T12:00:00Z',
            preExpiryRemindStatus: 'sent',
          },
          {
            ...SIGNER_1,
            id: 'signer-queued',
            status: 'pending',
            deliveryMode: 'email',
            preExpiryRemindedAt: '2026-11-19T12:00:00Z',
            preExpiryRemindStatus: 'queued',
          },
          {
            ...SIGNER_1,
            id: 'signer-failed',
            status: 'pending',
            deliveryMode: 'email',
            preExpiryRemindedAt: '2026-11-19T12:00:00Z',
            preExpiryRemindStatus: 'failed',
          },
          {
            ...SIGNER_1,
            id: 'signer-suppressed',
            status: 'pending',
            deliveryMode: 'email',
            preExpiryRemindedAt: '2026-11-19T12:00:00Z',
            preExpiryRemindStatus: 'suppressed',
          },
          {
            ...SIGNER_1,
            id: 'signer-declined',
            name: 'Lê Văn C',
            status: 'declined',
            declinedAt: '2026-11-19T13:00:00Z',
            declineReason: 'Cần điều chỉnh điều khoản thanh toán đợt 2',
          },
        ]}
        activeSignerId="signer-reminded"
        onSelectSigner={vi.fn()}
        onChangeRoutingMode={vi.fn()}
        onAddSigner={vi.fn()}
        onRemoveSigner={vi.fn()}
        onMoveSigner={vi.fn()}
      />,
    );
    expect(activePanelVi).toContain('data-testid="signer-pre-expiry-reminded-signer-reminded"');
    expect(activePanelVi).toContain('Đã gửi nhắc trước hạn');
    expect(activePanelVi).toContain('data-testid="signer-pre-expiry-queued-signer-queued"');
    expect(activePanelVi).toContain('Đang chờ gửi nhắc trước hạn');
    expect(activePanelVi).toContain('data-testid="signer-pre-expiry-failed-signer-failed"');
    expect(activePanelVi).toContain('Gửi nhắc trước hạn thất bại');
    expect(activePanelVi).toContain('data-testid="signer-pre-expiry-suppressed-signer-suppressed"');
    expect(activePanelVi).toContain('Email nhắc hạn bị chặn');
    expect(activePanelVi).toContain('data-testid="signer-decline-reason-signer-declined"');
    expect(activePanelVi).toContain('Lý do từ chối: Cần điều chỉnh điều khoản thanh toán đợt 2');
  });

  it('renders recipient correction gate, delegation provenance, allowDelegation toggle, and ceremony delegation controls (#3819)', async () => {
    const noop = () => undefined;

    // 1. SignerPanel shows "Sửa người nhận" only on unsigned signers of active envelopes when onCorrectSigner is passed,
    //    and renders "Ủy quyền ký bởi ..." provenance when delegatedFromName is present.
    const signedSigner: SignSignerRecord = {
      ...SIGNER_1,
      id: 'signer-signed',
      name: 'Phạm Văn Đã Ký',
      email: 'signed@example.com',
      status: 'signed',
      signedAt: '2026-11-21T08:00:00Z',
    };
    const delegatedPendingSigner: SignSignerRecord = {
      ...SIGNER_1,
      id: 'signer-delegated-pending',
      routingOrder: 2,
      name: 'Lê Thị Đại Diện',
      email: 'delegate@example.com',
      status: 'pending',
      delegatedFromName: 'Trần Văn Ủy Quyền',
      delegatedFromEmail: 'u***n@example.com',
      delegationCount: 1,
    };

    const panelVi = renderVi(
      <SignerPanel
        envelopeStatus="in_progress"
        routingMode="sequential"
        signers={[signedSigner, delegatedPendingSigner]}
        activeSignerId={null}
        onSelectSigner={noop}
        onChangeRoutingMode={noop}
        onAddSigner={async () => undefined}
        onRemoveSigner={async () => undefined}
        onMoveSigner={async () => undefined}
        onCorrectSigner={noop}
      />,
    );
    expect(panelVi).not.toContain('data-testid="signer-correct-signer-signed"');
    expect(panelVi).toContain('data-testid="signer-correct-signer-delegated-pending"');
    expect(panelVi).toContain('Sửa người nhận');
    expect(panelVi).toContain('data-testid="signer-delegated-signer-delegated-pending"');
    expect(panelVi).toContain('Ủy quyền ký bởi Trần Văn Ủy Quyền (u***n@example.com)');

    const panelEn = renderEn(
      <SignerPanel
        envelopeStatus="sent"
        routingMode="parallel"
        signers={[delegatedPendingSigner]}
        activeSignerId={null}
        onSelectSigner={noop}
        onChangeRoutingMode={noop}
        onAddSigner={async () => undefined}
        onRemoveSigner={async () => undefined}
        onMoveSigner={async () => undefined}
        onCorrectSigner={noop}
      />,
    );
    expect(panelEn).toContain('Correct recipient');
    expect(panelEn).toContain('Delegated by Trần Văn Ủy Quyền (u***n@example.com)');

    // 2. SignEnvelopeDetailPage enforces creator/owner/admin gate for recipient correction and renders allowDelegation checkbox.
    const envId = routerState.id;
    const creatorUserId = '01900000-0000-7000-8000-000000000088';
    const otherMemberUserId = '01900000-0000-7000-8000-000000000099';

    const baseEnvelope = {
      id: envId,
      title: 'Hợp đồng dịch vụ 2026',
      subject: null,
      message: null,
      status: 'sent' as const,
      routingMode: 'sequential' as const,
      allowDelegation: true,
      sourceKind: 'standalone',
      sourceId: null,
      sourceFileId: '01900000-0000-7000-8000-000000000077',
      sourceSha256: 'b'.repeat(64),
      inspectStatus: 'passed' as const,
      inspectError: null,
      pageCount: 1,
      pageDimensions: [{ page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0 }],
      detectedTags: [],
      sealedFileId: null,
      sealedSha256: null,
      sealStatus: null,
      certificateFileId: null,
      certificateSha256: null,
      certificateCode: null,
      expiresAt: '2027-02-01T00:00:00Z',
      sentAt: '2026-11-21T00:00:00Z',
      completedAt: null,
      declinedAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      expiredAt: null,
      version: 2,
      createdBy: creatorUserId,
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z',
    };

    const nonCreatorQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    nonCreatorQc.setQueryData(['me', 'get'], {
      userId: otherMemberUserId,
      email: 'member@example.com',
      displayName: 'Member',
      orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }],
    });
    nonCreatorQc.setQueryData(['sign', 'envelope', envId], {
      envelope: baseEnvelope,
      signers: [delegatedPendingSigner],
      fields: [],
    });
    const nonCreatorHtml = renderVi(<SignEnvelopeDetailPage />, nonCreatorQc);
    expect(nonCreatorHtml).not.toContain('data-testid="signer-correct-signer-delegated-pending"');

    const creatorQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    creatorQc.setQueryData(['me', 'get'], {
      userId: creatorUserId,
      email: 'creator@example.com',
      displayName: 'Creator',
      orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }],
    });
    creatorQc.setQueryData(['sign', 'envelope', envId], {
      envelope: baseEnvelope,
      signers: [delegatedPendingSigner],
      fields: [],
    });
    const creatorHtml = renderVi(<SignEnvelopeDetailPage />, creatorQc);
    expect(creatorHtml).toContain('data-testid="signer-correct-signer-delegated-pending"');

    const draftQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    draftQc.setQueryData(['sign', 'envelope', envId], {
      envelope: { ...baseEnvelope, status: 'draft' as const },
      signers: [SIGNER_1],
      fields: [],
    });
    const draftHtml = renderVi(<SignEnvelopeDetailPage />, draftQc);
    expect(draftHtml).toContain('data-testid="env-allow-delegation-checkbox"');
    expect(draftHtml).toContain('Cho phép người ký ủy quyền cho người khác (tối đa 2 lần)');

    // 3. SignCeremonyReadyView shows "Ủy quyền người khác ký" when allowDelegation=true and delegationCount < 2,
    //    hides it when allowDelegation=false or delegationCount >= 2, and renders delegatedFromName notice.
    const ceremonyCommon = {
      answers: {},
      pdfBytes: new Uint8Array([1, 2, 3]),
      loadingPdf: false,
      pdfError: null,
      viewerRenderError: null,
      pageNumber: 1,
      scale: 1,
      consentChecked: true,
      canSubmit: true,
      submitting: false,
      submitError: null,
      declineOpen: false,
      declineReason: '',
      declining: false,
      declineError: null,
      delegateOpen: false,
      delegateName: '',
      delegateEmail: '',
      delegateReason: '',
      delegating: false,
      delegateError: null,
      padFieldId: null,
      onPageChange: noop,
      onScaleChange: noop,
      onRenderStatusChange: noop,
      onJumpToNext: noop,
      onOpenPad: noop,
      onUpdateAnswer: noop,
      onConsentChange: noop,
      onSubmit: noop,
      onDeclineOpenChange: noop,
      onDeclineReasonChange: noop,
      onDeclineSubmit: noop,
      onDelegateOpenChange: noop,
      onDelegateNameChange: noop,
      onDelegateEmailChange: noop,
      onDelegateReasonChange: noop,
      onDelegateSubmit: noop,
    };

    const readyDelegatable = {
      state: 'ready' as const,
      orgName: 'Công ty ABC',
      title: 'Hợp đồng mua bán',
      message: null,
      signerName: 'Lê Thị Đại Diện',
      roleLabel: 'Bên B',
      signerRole: 'signer' as const,
      expiresAt: '2027-02-01T00:00:00.000Z',
      pageCount: 1,
      allowDelegation: true,
      delegationCount: 1,
      delegatedFromName: 'Trần Văn Ủy Quyền',
      fields: [],
    };
    const ceremonyAllowedHtml = renderVi(<SignCeremonyReadyView viewState={readyDelegatable} {...ceremonyCommon} />);
    expect(ceremonyAllowedHtml).toContain('data-testid="ceremony-delegate-btn"');
    expect(ceremonyAllowedHtml).toContain('Ủy quyền người khác ký');
    expect(ceremonyAllowedHtml).toContain('data-testid="ceremony-delegated-from"');
    expect(ceremonyAllowedHtml).toContain('Được ủy quyền bởi Trần Văn Ủy Quyền');

    const ceremonyMaxedHtml = renderVi(
      <SignCeremonyReadyView viewState={{ ...readyDelegatable, delegationCount: 2 }} {...ceremonyCommon} />,
    );
    expect(ceremonyMaxedHtml).not.toContain('data-testid="ceremony-delegate-btn"');

    const ceremonyDisabledHtml = renderVi(
      <SignCeremonyReadyView viewState={{ ...readyDelegatable, allowDelegation: false }} {...ceremonyCommon} />,
    );
    expect(ceremonyDisabledHtml).not.toContain('data-testid="ceremony-delegate-btn"');

    // 4. publicSignApi.view normalizes 'delegated' state cleanly.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            state: 'delegated',
            title: 'Hợp đồng mua bán',
            delegateName: 'Nguyễn Minh Quân',
            maskedDelegateEmail: 'q***n@example.com',
          }),
          { status: 200 },
        ),
      ),
    );
    const delegatedView = await publicSignApi.view('T'.repeat(43));
    expect(delegatedView).toEqual({
      state: 'delegated',
      title: 'Hợp đồng mua bán',
      delegateName: 'Nguyễn Minh Quân',
      maskedDelegateEmail: 'q***n@example.com',
    });
  });
});

describe('Slice 4b choice fields (dropdown/radio) and verified signer supporting attachments (#3818)', () => {
  it('validates dropdown, radio, and attachment completion and builds clean submit payloads', () => {
    const dropdownField = {
      id: 'fld-dd',
      fieldType: 'dropdown' as const,
      pageNumber: 1,
      xNorm: 0.1,
      yNorm: 0.2,
      wNorm: 0.24,
      hNorm: 0.05,
      label: 'Phương thức thanh toán',
      required: true,
      options: ['Chuyển khoản', 'Tiền mặt'],
    };
    const radioField = {
      id: 'fld-radio',
      fieldType: 'radio' as const,
      pageNumber: 1,
      xNorm: 0.1,
      yNorm: 0.3,
      wNorm: 0.2,
      hNorm: 0.04,
      label: 'Loại hợp đồng',
      required: true,
      options: ['Trọn gói', 'Theo tháng'],
    };
    const attachmentField = {
      id: 'fld-att',
      fieldType: 'attachment' as const,
      pageNumber: 1,
      xNorm: 0.1,
      yNorm: 0.4,
      wNorm: 0.26,
      hNorm: 0.06,
      label: 'Giấy ĐKKD',
      required: true,
      attachment: null,
    };

    expect(isFieldFilled(dropdownField, undefined)).toBe(false);
    expect(isFieldFilled(dropdownField, { valueText: 'Unlisted' })).toBe(false);
    expect(isFieldFilled(dropdownField, { valueText: 'Chuyển khoản' })).toBe(true);

    expect(isFieldFilled(radioField, { valueText: 'Trọn gói' })).toBe(true);
    expect(isFieldComplete(attachmentField, undefined)).toBe(false);
    expect(
      isFieldComplete(attachmentField, {
        attachment: {
          fileId: 'file-1',
          filename: 'giay-dkkd.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4096,
          sha256: 'e'.repeat(64),
          uploadedAt: '2026-11-21T10:00:00Z',
        },
      }),
    ).toBe(true);

    const payload = buildSignSubmitPayload({
      token: 'T'.repeat(43),
      fields: [dropdownField, radioField, attachmentField],
      answers: {
        'fld-dd': { valueText: 'Chuyển khoản' },
        'fld-radio': { valueText: 'Trọn gói' },
        'fld-att': {
          valueText: 'ignored',
          attachment: {
            fileId: 'file-1',
            filename: 'giay-dkkd.pdf',
            contentType: 'application/pdf',
            sizeBytes: 4096,
            sha256: 'e'.repeat(64),
            uploadedAt: '2026-11-21T10:00:00Z',
          },
        },
      },
    });
    expect(payload.fields).toEqual([
      { fieldId: 'fld-dd', valueText: 'Chuyển khoản' },
      { fieldId: 'fld-radio', valueText: 'Trọn gói' },
      { fieldId: 'fld-att' },
    ]);
  });

  it('renders mobile-accessible ceremony controls, inspector editors, and uploaded attachment evidence', () => {
    const ceremonyHtml = renderVi(
      <SignCeremonyReadyView
        viewState={{
          state: 'ready',
          orgName: 'Công ty TNHH Mẫu',
          title: 'Hợp đồng đại lý 2026',
          message: null,
          signerName: 'Trần Thị B',
          roleLabel: 'Bên B',
          signerRole: 'signer',
          expiresAt: '2026-12-01T00:00:00Z',
          pageCount: 1,
          fields: [
            {
              id: 'f-dd',
              fieldType: 'dropdown',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.24,
              hNorm: 0.05,
              label: 'Kỳ thanh toán',
              required: true,
              options: ['30 ngày', '60 ngày'],
            },
            {
              id: 'f-rad',
              fieldType: 'radio',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.3,
              wNorm: 0.2,
              hNorm: 0.04,
              label: 'Phương thức nhận hóa đơn',
              required: true,
              options: ['Qua email', 'Qua cổng điện tử'],
            },
            {
              id: 'f-att',
              fieldType: 'attachment',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.4,
              wNorm: 0.26,
              hNorm: 0.06,
              label: 'Giấy ĐKKD',
              required: true,
              attachment: null,
            },
          ],
        }}
        answers={{
          'f-dd': { valueText: '30 ngày' },
          'f-rad': { valueText: 'Qua email' },
          'f-att': {
            attachment: {
              fileId: 'file-att-1',
              filename: 'giay-dkkd-2026.pdf',
              contentType: 'application/pdf',
              sizeBytes: 8192,
              sha256: 'ab'.repeat(32),
              uploadedAt: '2026-11-21T10:00:00Z',
            },
          },
        }}
        pdfBytes={null}
        loadingPdf={false}
        pdfError={null}
        viewerRenderError={null}
        pageNumber={1}
        scale={1}
        consentChecked={true}
        canSubmit={false}
        submitting={false}
        submitError={null}
        declineOpen={false}
        declineReason=""
        declining={false}
        declineError={null}
        padFieldId={null}
        onPageChange={vi.fn()}
        onScaleChange={vi.fn()}
        onRenderStatusChange={vi.fn()}
        onJumpToNext={vi.fn()}
        onOpenPad={vi.fn()}
        onUpdateAnswer={vi.fn()}
        onConsentChange={vi.fn()}
        onSubmit={vi.fn()}
        onDeclineOpenChange={vi.fn()}
        onDeclineReasonChange={vi.fn()}
        onDeclineSubmit={vi.fn()}
      />,
    );
    expect(ceremonyHtml).toContain('data-testid="ceremony-dropdown-f-dd"');
    expect(ceremonyHtml).toContain('data-testid="ceremony-radiogroup-f-rad"');
    expect(ceremonyHtml).toContain('role="radiogroup"');
    expect(ceremonyHtml).toContain('id="ceremony-file-picker-f-att"');
    expect(ceremonyHtml).toContain('id="ceremony-field-input-f-att"');
    expect(ceremonyHtml).toContain('data-testid="ceremony-attachment-summary-f-att"');
    expect(ceremonyHtml).toContain('giay-dkkd-2026.pdf');
    expect(ceremonyHtml).toContain('SHA-256: abababababababab...');

    const optionsEditorHtml = renderVi(
      <FieldOptionsAndAttachmentEditor
        field={{
          localId: 'local-dd',
          signerId: 'signer-1',
          fieldType: 'dropdown',
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.2,
          wNorm: 0.24,
          hNorm: 0.05,
          label: 'Kỳ hạn',
          required: true,
          proposedByAi: false,
          options: ['12 tháng', '24 tháng'],
        }}
        onChangeOptions={vi.fn()}
        onChangeLabel={vi.fn()}
      />,
    );
    expect(optionsEditorHtml).toContain('data-testid="field-options-editor"');
    expect(optionsEditorHtml).toContain('12 tháng');
    expect(optionsEditorHtml).toContain('24 tháng');

    const attachmentPresetsHtml = renderVi(
      <FieldOptionsAndAttachmentEditor
        field={{
          localId: 'local-att',
          signerId: 'signer-1',
          fieldType: 'attachment',
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.2,
          wNorm: 0.26,
          hNorm: 0.06,
          label: null,
          required: true,
          proposedByAi: false,
        }}
        onChangeOptions={vi.fn()}
        onChangeLabel={vi.fn()}
      />,
    );
    expect(attachmentPresetsHtml).toContain('data-testid="field-attachment-preset-idCard"');
    expect(attachmentPresetsHtml).toContain('CCCD / CMND');
    expect(attachmentPresetsHtml).toContain('Giấy ĐKKD');
  });
});

describe('Envelope link rotation and void RBAC (#3428 L3)', () => {
  it('restricts envelope link rotation and void controls to creator, owner, or admin (#3428 L3)', () => {
    const creatorId = '01900000-0000-7000-8000-000000000088';
    const otherMemberId = '01900000-0000-7000-8000-000000000077';

    expect(canManageEnvelopeLinksAndVoid({ role: 'owner', userId: otherMemberId, createdBy: creatorId })).toBe(true);
    expect(canManageEnvelopeLinksAndVoid({ role: 'admin', userId: otherMemberId, createdBy: creatorId })).toBe(true);
    expect(canManageEnvelopeLinksAndVoid({ role: 'member', userId: creatorId, createdBy: creatorId })).toBe(true);
    expect(canManageEnvelopeLinksAndVoid({ role: 'member', userId: otherMemberId, createdBy: creatorId })).toBe(false);
    expect(
      canManageEnvelopeLinksAndVoid({
        role: 'member',
        userId: otherMemberId,
        createdBy: creatorId,
        sourceKind: 'meeting_minutes',
      }),
    ).toBe(true);
    expect(
      canManageEnvelopeLinksAndVoid({
        role: 'viewer',
        userId: creatorId,
        createdBy: creatorId,
        sourceKind: 'meeting_minutes',
      }),
    ).toBe(false);
    expect(canManageEnvelopeLinksAndVoid({ role: 'viewer', userId: creatorId, createdBy: creatorId })).toBe(false);
    expect(canManageEnvelopeLinksAndVoid({ role: null, userId: creatorId, createdBy: creatorId })).toBe(false);

    const makeSentClient = (role: 'owner' | 'admin' | 'member' | 'viewer', userId: string) => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const envId = routerState.id;
      qc.setQueryData(['me', 'get'], {
        userId,
        email: 'user@example.com',
        displayName: 'User',
        orgs: [{ orgId: '01900000-0000-7000-8000-000000000055', slug: routerState.slug, name: 'Acme', role }],
      });
      qc.setQueryData(['sign', 'envelope', envId], {
        envelope: {
          id: envId,
          title: 'Hợp đồng dịch vụ đã gửi',
          subject: null,
          message: null,
          status: 'sent',
          routingMode: 'parallel',
          sourceKind: 'standalone',
          sourceId: null,
          sourceFileId: '01900000-0000-7000-8000-000000000099',
          sourceSha256: 'a'.repeat(64),
          inspectStatus: 'passed',
          inspectError: null,
          pageCount: 1,
          pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
          detectedTags: [],
          sealedFileId: null,
          sealedSha256: null,
          sealStatus: null,
          certificateFileId: null,
          certificateSha256: null,
          certificateCode: null,
          expiresAt: null,
          sentAt: '2026-11-17T01:00:00Z',
          completedAt: null,
          declinedAt: null,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
          expiredAt: null,
          version: 2,
          createdBy: creatorId,
          createdAt: '2026-11-17T00:00:00Z',
          updatedAt: '2026-11-17T01:00:00Z',
        },
        signers: [
          {
            ...SIGNER_1,
            deliveryMode: 'email',
            email: 'signer@example.com',
          },
        ],
        fields: [],
      });
      return qc;
    };

    const creatorHtml = renderVi(<SignEnvelopeDetailPage />, makeSentClient('member', creatorId));
    expect(creatorHtml).toContain('Hủy hồ sơ');
    expect(creatorHtml).toContain('Chép link Zalo');
    expect(creatorHtml).toContain('Nhắc ký');

    const otherMemberHtml = renderVi(<SignEnvelopeDetailPage />, makeSentClient('member', otherMemberId));
    expect(otherMemberHtml).not.toContain('Hủy hồ sơ');
    expect(otherMemberHtml).not.toContain('Chép link Zalo');
    expect(otherMemberHtml).toContain('Nhắc ký');

    const viewerHtml = renderVi(<SignEnvelopeDetailPage />, makeSentClient('viewer', creatorId));
    expect(viewerHtml).not.toContain('Hủy hồ sơ');
    expect(viewerHtml).not.toContain('Chép link Zalo');
    expect(viewerHtml).not.toContain('Nhắc ký');
  });
});
