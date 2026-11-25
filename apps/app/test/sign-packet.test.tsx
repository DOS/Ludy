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
const { SignPacketManager, executePacketConsistencyCheck } = await import('../src/components/sign/sign-packet-manager.tsx');
const {
  jumpToCounterpartySummaryPage,
  planCachedDocumentSelect,
  runCeremonyDocumentSelect,
  SignCeremonyReadyView,
} = await import('../src/routes/sign-ceremony.tsx');
const { resolvePrimaryEnvelopeSource } = await import('../src/routes/sign-envelope-detail.tsx');
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

  it('keeps pdfRendered intact when selecting the already-active rendered document tab', () => {
    const doc1Bytes = new Uint8Array([1, 2, 3]);
    const doc2Bytes = new Uint8Array([4, 5, 6]);

    // Clicking the already-active tab while already rendered on page 1 must no-op so Submit stays enabled.
    expect(
      planCachedDocumentSelect({
        currentPageNumber: 1,
        nextPage: 1,
        currentPdfBytes: doc1Bytes,
        cachedPdfBytes: doc1Bytes,
        pdfRendered: true,
      }),
    ).toEqual({ action: 'noop' });

    // Switching pages on the same cached document still resets render state while PdfCanvasViewer draws the target page.
    expect(
      planCachedDocumentSelect({
        currentPageNumber: 2,
        nextPage: 1,
        currentPdfBytes: doc1Bytes,
        cachedPdfBytes: doc1Bytes,
        pdfRendered: true,
      }),
    ).toEqual({
      action: 'apply_cache',
      targetPage: 1,
      resetRendered: true,
      cached: doc1Bytes,
    });

    // Switching to another cached document resets render state for the new document.
    expect(
      planCachedDocumentSelect({
        currentPageNumber: 1,
        nextPage: 1,
        currentPdfBytes: doc1Bytes,
        cachedPdfBytes: doc2Bytes,
        pdfRendered: true,
      }),
    ).toEqual({
      action: 'apply_cache',
      targetPage: 1,
      resetRendered: true,
      cached: doc2Bytes,
    });

    // Uncached documents trigger a fresh fetch.
    expect(
      planCachedDocumentSelect({
        currentPageNumber: 1,
        nextPage: 2,
        currentPdfBytes: doc1Bytes,
        cachedPdfBytes: undefined,
        pdfRendered: true,
      }),
    ).toEqual({ action: 'fetch', targetPage: 2 });
  });

  it('links SignPacketTabs aria-controls with PdfCanvasViewer role=tabpanel aria-labelledby and scopes summary pageCount to Doc 1 (#4837 items 4, 5)', () => {
    const viewState: Extract<PublicSignViewState, { state: 'ready' }> = {
      state: 'ready',
      orgName: 'Cong ty TNHH ABC',
      title: 'Bo hop dong hai tai lieu',
      message: null,
      signerName: 'Nguyen Van A',
      roleLabel: 'Ben A',
      signerRole: 'signer',
      expiresAt: '2026-12-30T00:00:00Z',
      pageCount: 4,
      pageDimensions: [{ pageNumber: 1, widthPt: 595, heightPt: 842 }],
      otpVerified: true,
      sharedSummary: {
        summaryText: 'Tom tat dieu khoan tren Doc 1 trang 3.',
        keyTerms: [{ label: 'Gia tri', value: '100tr', pageNumber: 3, quoteExcerpt: null }],
      },
      documents: [
        {
          id: DOC_1_ID,
          docIndex: 1,
          title: 'Hop dong chinh',
          pageCount: 3,
          pageDimensions: [],
          sourceSha256: 'a'.repeat(64),
        },
        {
          id: DOC_2_ID,
          docIndex: 2,
          title: 'Phu luc 01',
          pageCount: 1,
          pageDimensions: [],
          sourceSha256: 'b'.repeat(64),
        },
      ],
      fields: [],
    };

    // Viewing Doc 2 (pageCount = 1), Doc 1 summary still keeps page 3 link active and switches to Doc 1.
    const htmlOnDoc2 = renderVi(
      <SignCeremonyReadyView
        viewState={viewState}
        answers={{}}
        activeDocumentKey={DOC_2_ID}
        pdfBytes={null}
        loadingPdf={false}
        pdfError={null}
        viewerRenderError={null}
        pageNumber={1}
        scale={1}
        consentChecked={false}
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

    expect(htmlOnDoc2).toContain('role="tabpanel"');
    const controlsMatch = htmlOnDoc2.match(/aria-controls="([^"]+)"/);
    expect(controlsMatch?.[1]).toBeTruthy();
    const panelId = controlsMatch![1]!;
    expect(htmlOnDoc2).toContain(`id="${panelId}"`);
    const doc2TabId = panelId.replace(/-packet-panel$/, `-packet-panel-tab-${DOC_2_ID}`);
    expect(htmlOnDoc2).toContain(`id="${doc2TabId}"`);
    expect(htmlOnDoc2).toContain(`aria-labelledby="${doc2TabId}"`);
    // Doc 1 has 3 pages even though active Doc 2 has 1 page -> "Trang 3" remains rendered as a jump link.
    expect(htmlOnDoc2).toContain('Trang 3');

    const jumped: Array<[string, number | undefined]> = [];
    jumpToCounterpartySummaryPage((docKey, page) => {
      jumped.push([docKey, page]);
    }, DOC_1_ID, 3);
    expect(jumped).toEqual([[DOC_1_ID, 3]]);
  });

  it('flushes onBeforeMutatePacket before running Vy cross-doc consistency check (#4837 item 3)', async () => {
    const order: string[] = [];
    let checkedDocs = 0;
    const result = await executePacketConsistencyCheck({
      envelopeId: '01900000-0000-7000-8000-000000000099',
      documents: [{ id: DOC_1_ID, fileId: '01900000-0000-7000-8000-000000000010', inspectStatus: 'passed' }],
      onBeforeCheck: async () => {
        await Promise.resolve();
        order.push('flush');
      },
      downloadBytes: async () => {
        order.push('download');
        return new Uint8Array([1, 2, 3]);
      },
      extractPages: async () => [{ page: 1, text: 'Noi dung' }],
      checkConsistency: async (input) => {
        order.push('check');
        checkedDocs = input.documents?.length ?? 0;
        return {
          envelopeId: input.envelopeId,
          ai: 'used',
          summaryText: 'Checked',
          findings: [],
        };
      },
    });
    expect(order).toEqual(['flush', 'download', 'check']);
    expect(checkedDocs).toBe(1);
    expect(result.summaryText).toBe('Checked');
  });

  it('clears loadingPdf and invalidates stale in-flight fetch when switching back to cached tab (#4837 item 6)', async () => {
    const doc1Bytes = new Uint8Array([1, 2, 3]);
    const doc2Bytes = new Uint8Array([4, 5, 6]);
    let gen = 1;
    let loadingPdf = false;
    let activeDocKey = DOC_1_ID;
    let currentBytes: Uint8Array | null = doc1Bytes;
    let pdfRendered = true;
    let pageNumber = 1;

    let resolveDoc2!: (bytes: Uint8Array) => void;
    const doc2Promise = new Promise<Uint8Array>((resolve) => {
      resolveDoc2 = resolve;
    });

    // 1. Start fetching uncached Doc 2.
    const inFlightDoc2 = runCeremonyDocumentSelect({
      docKey: DOC_2_ID,
      nextPage: 1,
      currentPageNumber: pageNumber,
      pdfBytes: currentBytes,
      cachedPdfBytes: undefined,
      pdfRendered,
      bumpGen: () => (gen += 1),
      getGen: () => gen,
      setLoadingPdf: (v) => {
        loadingPdf = v;
      },
      setActiveDocKey: (k) => {
        activeDocKey = k;
      },
      setPageNumber: (p) => {
        pageNumber = p;
      },
      clearErrors: () => {},
      setPdfRendered: (r) => {
        pdfRendered = r;
      },
      setPdfBytes: (b) => {
        currentBytes = b;
      },
      fetchPdfBytes: () => doc2Promise,
      onFetched: () => {},
      onFetchError: () => {},
    });
    expect(loadingPdf).toBe(true);
    expect(activeDocKey).toBe(DOC_2_ID);

    // 2. User immediately switches back to cached Doc 1 while Doc 2 fetch is still pending.
    await runCeremonyDocumentSelect({
      docKey: DOC_1_ID,
      nextPage: 1,
      currentPageNumber: pageNumber,
      pdfBytes: currentBytes,
      cachedPdfBytes: doc1Bytes,
      pdfRendered,
      bumpGen: () => (gen += 1),
      getGen: () => gen,
      setLoadingPdf: (v) => {
        loadingPdf = v;
      },
      setActiveDocKey: (k) => {
        activeDocKey = k;
      },
      setPageNumber: (p) => {
        pageNumber = p;
      },
      clearErrors: () => {},
      setPdfRendered: (r) => {
        pdfRendered = r;
      },
      setPdfBytes: (b) => {
        currentBytes = b;
      },
      fetchPdfBytes: async () => doc1Bytes,
      onFetched: () => {},
      onFetchError: () => {},
    });
    expect(loadingPdf).toBe(false);
    expect(activeDocKey).toBe(DOC_1_ID);
    expect(currentBytes).toBe(doc1Bytes);

    // 3. Stale Doc 2 response arrives later and must NOT overwrite Doc 1 bytes or toggle loadingPdf.
    resolveDoc2(doc2Bytes);
    await inFlightDoc2;
    expect(loadingPdf).toBe(false);
    expect(activeDocKey).toBe(DOC_1_ID);
    expect(currentBytes).toBe(doc1Bytes);
  });

  it('resolves live Doc 1 source file and bytes safely for obligations/playbook/evidence after draft Doc 1 removal (#4837 item 2)', () => {
    const doc1Bytes = new Uint8Array([9, 8, 7]);
    const doc2Bytes = new Uint8Array([4, 5, 6]);
    const staleOriginEnvelope = {
      sourceFileId: '01900000-0000-7000-8000-000000000090',
      sourceSha256: 'a'.repeat(64),
      sealedFileId: null as string | null,
    };
    const docsAfterRemoval = [
      { fileId: '01900000-0000-7000-8000-000000000091', sourceSha256: 'b'.repeat(64), docIndex: 1 },
      { fileId: '01900000-0000-7000-8000-000000000092', sourceSha256: 'c'.repeat(64), docIndex: 2 },
    ];

    const onDoc1 = resolvePrimaryEnvelopeSource(staleOriginEnvelope, docsAfterRemoval, { docIndex: 1 }, doc1Bytes);
    expect(onDoc1.sourceFileId).toBe('01900000-0000-7000-8000-000000000091');
    expect(onDoc1.sourceSha256).toBe('b'.repeat(64));
    expect(onDoc1.reusableDoc1Bytes).toBe(doc1Bytes);

    // Viewing Doc 2 must never pass Doc 2 PDF bytes to Doc 1 obligations/playbook fallback.
    const onDoc2 = resolvePrimaryEnvelopeSource(staleOriginEnvelope, docsAfterRemoval, { docIndex: 2 }, doc2Bytes);
    expect(onDoc2.sourceFileId).toBe('01900000-0000-7000-8000-000000000091');
    expect(onDoc2.reusableDoc1Bytes).toBeNull();

    // Sealed unified packet must not pass the merged+certificate PDF as Doc 1 original bytes.
    const sealed = resolvePrimaryEnvelopeSource(
      { ...staleOriginEnvelope, sealedFileId: '01900000-0000-7000-8000-000000000099' },
      docsAfterRemoval,
      { docIndex: 1 },
      doc1Bytes,
    );
    expect(sealed.sourceFileId).toBe('01900000-0000-7000-8000-000000000091');
    expect(sealed.reusableDoc1Bytes).toBeNull();
  });
});
