// SPDX-License-Identifier: AGPL-3.0-only
// Component and utility tests for multi-document signing packet UI, accessible tabs, readiness, and single-consent ceremony (#4722).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

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

import type { PublicSignViewState, SignEnvelopeDocumentSummary } from '../src/lib/sign-api.ts';

const { SignPacketTabs } = await import('../src/components/sign/sign-packet-tabs.tsx');
const { SignPacketManager } = await import('../src/components/sign/sign-packet-manager.tsx');
const { SignCeremonyReadyView } = await import('../src/routes/sign-ceremony.tsx');
const { checkSendReadiness } = await import('../src/lib/sign-fields.ts');
const { publicSignApi } = await import('../src/lib/sign-api.ts');

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

const DOC_1_ID = '01900000-0000-7000-8000-000000000201';
const DOC_2_ID = '01900000-0000-7000-8000-000000000202';

const SAMPLE_DOCS: SignEnvelopeDocumentSummary[] = [
  {
    id: DOC_1_ID,
    docIndex: 1,
    title: 'Hop dong lao dong',
    fileId: '01900000-0000-7000-8000-000000000301',
    sourceSha256: 'a'.repeat(64),
    inspectStatus: 'passed',
    inspectError: null,
    pageCount: 3,
    pageDimensions: [
      { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
      { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
      { page: 3, widthPt: 595, heightPt: 842, rotation: 0 },
    ],
    detectedTags: [],
    sizeBytes: 2 * 1024 * 1024,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
  },
  {
    id: DOC_2_ID,
    docIndex: 2,
    title: 'Phu luc bao mat NDA',
    fileId: '01900000-0000-7000-8000-000000000302',
    sourceSha256: 'b'.repeat(64),
    inspectStatus: 'passed',
    inspectError: null,
    pageCount: 2,
    pageDimensions: [
      { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
      { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
    ],
    detectedTags: [],
    sizeBytes: 1024 * 1024,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
  },
];

describe('Multi-document signing packet frontend (#4722)', () => {
  it('validates per-document inspection readiness inside checkSendReadiness', () => {
    const signers = [{ id: 's1', signerRole: 'signer' }];
    const fields = [{ signerId: 's1', fieldType: 'signature' }];

    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        documents: [
          { inspectStatus: 'passed', pageCount: 2 },
          { inspectStatus: 'pending', pageCount: null },
        ],
        signers,
        fields,
      }),
    ).toBe('NOT_INSPECTED');

    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        documents: [
          { inspectStatus: 'passed', pageCount: 2 },
          { inspectStatus: 'failed', pageCount: null },
        ],
        signers,
        fields,
      }),
    ).toBe('INSPECT_FAILED');

    expect(
      checkSendReadiness({
        inspectStatus: 'passed',
        documents: [
          { inspectStatus: 'passed', pageCount: 2 },
          { inspectStatus: 'passed', pageCount: 3 },
        ],
        signers,
        fields,
      }),
    ).toBeNull();
  });

  it('renders SignPacketTabs with role=tablist, aria-selected, 44px touch targets, and remaining badges', () => {
    const html = renderVi(
      <SignPacketTabs
        items={[
          {
            key: DOC_1_ID,
            documentId: DOC_1_ID,
            docIndex: 1,
            title: 'Hop dong chinh',
            pageCount: 3,
            remainingRequiredCount: 0,
            totalRequiredCount: 1,
          },
          {
            key: DOC_2_ID,
            documentId: DOC_2_ID,
            docIndex: 2,
            title: 'Phu luc 01',
            pageCount: 2,
            remainingRequiredCount: 2,
            totalRequiredCount: 2,
          },
        ]}
        activeKey={DOC_2_ID}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Các tài liệu trong bộ hồ sơ ký"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('min-h-11');
    expect(html).toContain('1. Hop dong chinh');
    expect(html).toContain('2. Phu luc 01');
    expect(html).toContain('Xong');
    expect(html).toContain('2 bắt buộc');
  });

  it('renders SignPacketManager counters, move/remove buttons, add control, and Vy consistency check trigger', () => {
    const html = renderVi(
      <SignPacketManager
        envelopeId="01900000-0000-7000-8000-000000000001"
        canEditDraft={true}
        documents={SAMPLE_DOCS}
        activeDocumentKey={DOC_1_ID}
        fields={[
          {
            localId: 'f1',
            documentId: DOC_1_ID,
            signerId: 's1',
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.2,
            hNorm: 0.08,
            label: null,
            required: true,
            proposedByAi: false,
          },
        ]}
        onSelectDocument={vi.fn()}
        onPacketChanged={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="sign-packet-manager"');
    expect(html).toContain('2/5 tệp · 5/200 trang · 3.00/25 MB');
    expect(html).toContain('data-testid="sign-packet-move-up-2"');
    expect(html).toContain('data-testid="sign-packet-remove-2"');
    expect(html).toContain('data-testid="sign-packet-add-btn"');
    expect(html).toContain('data-testid="sign-packet-consistency-btn"');

    const viewerHtml = renderVi(
      <SignPacketManager
        envelopeId="01900000-0000-7000-8000-000000000001"
        canEditDraft={false}
        canRunConsistency={false}
        documents={SAMPLE_DOCS}
        activeDocumentKey={DOC_1_ID}
        fields={[]}
        onSelectDocument={vi.fn()}
        onPacketChanged={vi.fn()}
      />,
    );
    expect(viewerHtml).not.toContain('data-testid="sign-packet-consistency-btn"');
  });

  it('renders SignCeremonyReadyView with multi-doc tabs, per-doc fields, and single unified consent notice', () => {
    const viewState: Extract<PublicSignViewState, { state: 'ready' }> = {
      state: 'ready',
      orgName: 'ACME',
      title: 'Bo ho so 2 tai lieu',
      message: null,
      signerName: 'Nguyen Van A',
      roleLabel: 'Ben B',
      signerRole: 'signer',
      expiresAt: '2026-12-30T00:00:00Z',
      pageCount: 5,
      documents: [
        {
          id: DOC_1_ID,
          docIndex: 1,
          title: 'Hop dong chinh',
          pageCount: 3,
          pageDimensions: [{ pageNumber: 1, widthPt: 595, heightPt: 842 }],
          sourceSha256: 'a'.repeat(64),
        },
        {
          id: DOC_2_ID,
          docIndex: 2,
          title: 'Phu luc 01',
          pageCount: 2,
          pageDimensions: [{ pageNumber: 1, widthPt: 595, heightPt: 842 }],
          sourceSha256: 'b'.repeat(64),
        },
      ],
      fields: [
        {
          id: 'field-doc-1',
          documentId: DOC_1_ID,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.7,
          wNorm: 0.2,
          hNorm: 0.08,
          label: 'Chu ky hop dong',
          required: true,
        },
        {
          id: 'field-doc-2',
          documentId: DOC_2_ID,
          fieldType: 'text',
          pageNumber: 2,
          xNorm: 0.2,
          yNorm: 0.4,
          wNorm: 0.3,
          hNorm: 0.05,
          label: 'Ma so thue',
          required: true,
        },
      ],
    };

    const props = {
      viewState,
      answers: {},
      activeDocumentKey: DOC_1_ID,
      pdfBytes: null,
      loadingPdf: false,
      pdfError: null,
      viewerRenderError: null,
      pageNumber: 1,
      scale: 1,
      consentChecked: false,
      canSubmit: false,
      submitting: false,
      submitError: null,
      declineOpen: false,
      declineReason: '',
      declining: false,
      declineError: null,
      padFieldId: null,
      onPageChange: vi.fn(),
      onScaleChange: vi.fn(),
      onRenderStatusChange: vi.fn(),
      onJumpToNext: vi.fn(),
      onOpenPad: vi.fn(),
      onUpdateAnswer: vi.fn(),
      onConsentChange: vi.fn(),
      onSubmit: vi.fn(),
      onDeclineOpenChange: vi.fn(),
      onDeclineReasonChange: vi.fn(),
      onDeclineSubmit: vi.fn(),
    };

    const viHtml = renderVi(<SignCeremonyReadyView {...props} />);
    expect(viHtml).toContain('data-testid="sign-packet-tabs"');
    expect(viHtml).toContain('data-testid="ceremony-multi-doc-consent-note"');
    expect(viHtml).toContain('2 tài liệu trong bộ hồ sơ này');
    expect(viHtml).toContain('Còn 2 ô cần hoàn tất');
    expect(viHtml).toContain('1. Hop dong chinh');
    expect(viHtml).toContain('2. Phu luc 01');

    const enHtml = renderEn(<SignCeremonyReadyView {...props} />);
    expect(enHtml).toContain('all 2 documents in this packet');
    expect(enHtml).toContain('2 required fields left');
  });

  it('preserves documentId across publicSignApi.view and forwards documentId to /api/sign/pdf', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/api/sign/view')) {
        return new Response(
          JSON.stringify({
            state: 'ready',
            orgName: 'ACME',
            title: 'Packet',
            message: null,
            signerName: 'Tester',
            roleLabel: 'Ben A',
            signerRole: 'signer',
            expiresAt: '2026-12-30T00:00:00Z',
            pageCount: 3,
            documents: [
              {
                id: DOC_1_ID,
                docIndex: 1,
                title: 'Doc 1',
                pageCount: 1,
                pageDimensions: [{ pageNumber: 1, widthPt: 595, heightPt: 842 }],
                sourceSha256: 'a'.repeat(64),
              },
              {
                id: DOC_2_ID,
                docIndex: 2,
                title: 'Doc 2',
                pageCount: 2,
                pageDimensions: [],
                sourceSha256: 'b'.repeat(64),
              },
            ],
            fields: [
              {
                id: 'f2',
                documentId: DOC_2_ID,
                fieldType: 'text',
                pageNumber: 2,
                xNorm: 0.1,
                yNorm: 0.2,
                wNorm: 0.2,
                hNorm: 0.05,
                label: 'Ghi chu',
                required: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { documentId?: string };
      expect(parsedBody.documentId).toBe(DOC_2_ID);
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = await publicSignApi.view('tok-123');
    expect(view.state).toBe('ready');
    if (view.state === 'ready') {
      expect(view.documents).toHaveLength(2);
      expect(view.documents?.[1]?.id).toBe(DOC_2_ID);
      expect(view.fields[0]?.documentId).toBe(DOC_2_ID);
    }

    const bytes = await publicSignApi.pdf('tok-123', DOC_2_ID);
    expect(bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });
});
