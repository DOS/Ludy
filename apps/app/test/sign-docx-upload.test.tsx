// SPDX-License-Identifier: AGPL-3.0-only
// Frontend .docx upload validation, 202 polling, and calm Vietnamese warning banner tests (#4721).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth.ts', () => ({
  accessToken: vi.fn(async () => 'test-token'),
  afterMfaRefusal: vi.fn(),
  auth: vi.fn(),
  getConfig: vi.fn(() => ({ uploads: 'local', modules: ['kernel', 'sign'] })),
  secondFactorStillOwed: vi.fn(async () => false),
}));

vi.mock('../src/lib/api-base.ts', () => ({
  apiUrl: (path: string) => `http://localhost${path}`,
  serverOrigin: () => 'http://localhost',
}));

vi.mock('@ludy/ui/components/dialog', async () => {
  const { createElement } = await import('react');
  const wrap =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Dialog: wrap('div'),
    DialogClose: wrap('button'),
    DialogContent: wrap('div'),
    DialogDescription: wrap('p'),
    DialogFooter: wrap('div'),
    DialogHeader: wrap('div'),
    DialogTitle: wrap('h2'),
  };
});

const envDetailId = '01900000-0000-7000-8000-0000000000ec';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ slug: 'acme', id: envDetailId }),
    useNavigate: () => vi.fn(),
  };
});

const {
  DocxConversionNotice,
  DocxWarningsAlert,
  clearAllCreatedDocxWarnings,
  clearCreatedDocxWarnings,
  inspectSelectedSignUploadFile,
  readCreatedDocxWarnings,
  saveCreatedDocxWarnings,
} = await import('../src/components/sign/docx-conversion-notice.tsx');
const { catalog } = await import('../src/i18n/runtime.ts');
const {
  SIGN_DOCX_MAX_BYTES,
  SIGN_DOCX_MIME,
  SIGN_UPLOAD_ACCEPT,
  SignSessionMismatchError,
  convertSignDocx,
  uploadSignPdf,
} = await import('../src/lib/sign-api.ts');
const { accessToken } = await import('../src/lib/auth.ts');
const { orpc, queryClient } = await import('../src/lib/api.ts');
const { ensureSignedOutListener } = await import('../src/lib/ceremony-boot.ts');
const {
  CreateEnvelopeDialog,
  applyPendingDocxNoticeUpdate,
  captureEnvelopeSubmitContext,
  handleEnvelopeCreatedWithWarnings,
  isCreatedDocxListNoticeVisible,
  openCreatedDocxNoticeEnvelope,
  submitCreateEnvelopeFromDialog,
} = await import('../src/routes/sign-envelopes.tsx');
const { SignEnvelopeDetailPage } = await import('../src/routes/sign-envelope-detail.tsx');
const { CreateTemplateForm } = await import('../src/routes/sign-templates.tsx');
const { ContractVaultBar } = await import('../src/components/sign/contract-vault-bar.tsx');

function makeTestFile(bytes: Uint8Array, name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('eSign .docx client upload and UI components (#4721)', () => {
  afterEach(() => {
    clearAllCreatedDocxWarnings();
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates .pdf vs .docx headers, OLE2 refusal, and 10 MB cap', async () => {
    const zipDocx = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'Hop dong.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(zipDocx)).toEqual({
      ok: true,
      kind: 'docx',
      fallbackTitle: 'Hop dong',
    });

    const pdfFile = makeTestFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), 'Contract.pdf', 'application/pdf');
    expect(await inspectSelectedSignUploadFile(pdfFile)).toEqual({
      ok: true,
      kind: 'pdf',
      fallbackTitle: 'Contract',
    });

    const ole2Docx = makeTestFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'encrypted.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(ole2Docx)).toEqual({
      ok: false,
      errorKey: 'docxOle2Unsupported',
    });

    const legacyDoc = makeTestFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.doc', 'application/msword');
    expect(await inspectSelectedSignUploadFile(legacyDoc)).toEqual({
      ok: false,
      errorKey: 'docxOle2Unsupported',
    });

    const emptyDocx = makeTestFile(new Uint8Array(0), 'empty.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(emptyDocx)).toEqual({
      ok: false,
      errorKey: 'docxEmpty',
    });

    const fakeOverSized = new File([new Uint8Array(SIGN_DOCX_MAX_BYTES + 1)], 'huge.docx', { type: SIGN_DOCX_MIME });
    expect(await inspectSelectedSignUploadFile(fakeOverSized)).toEqual({
      ok: false,
      errorKey: 'docxTooLarge',
    });
  });

  it('polls 202 pending responses on convertSignDocx until completed', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (calls.length === 1) {
        return new Response(JSON.stringify({ status: 'pending', jobId: 'job-docx-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          fileId: '01900000-0000-7000-8000-0000000000aa',
          filename: 'hop-dong.pdf',
          pageCount: 2,
          sourceDocxSha256: 'a'.repeat(64),
          warnings: ['images_skipped'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'hop-dong.docx', SIGN_DOCX_MIME);
    const result = await convertSignDocx(file, 'acme');
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('/api/sign/convert-docx');
    expect(calls[1]).toContain('/api/sign/convert-docx/job-docx-1');
    expect(result).toEqual({
      status: 'completed',
      fileId: '01900000-0000-7000-8000-0000000000aa',
      filename: 'hop-dong.pdf',
      pageCount: 2,
      sourceDocxSha256: 'a'.repeat(64),
      warnings: ['images_skipped'],
    });
  });

  it('renders .pdf/.docx accept attribute, converting indicator, and calm Vietnamese warning banner', () => {
    const tplHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <CreateTemplateForm
          title="Hop dong dich vu"
          description=""
          routingMode="parallel"
          subject=""
          message=""
          file={makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'hop-dong.docx', SIGN_DOCX_MIME)}
          error={null}
          pending={false}
          docxStatus="ready"
          docxResult={{
            status: 'completed',
            fileId: '01900000-0000-7000-8000-0000000000bb',
            filename: 'hop-dong.pdf',
            pageCount: 3,
            sourceDocxSha256: 'b'.repeat(64),
            warnings: ['floating_shapes_skipped', 'images_skipped'],
          }}
          onChangeTitle={() => {}}
          onChangeDescription={() => {}}
          onChangeRoutingMode={() => {}}
          onChangeSubject={() => {}}
          onChangeMessage={() => {}}
          onChangeFile={() => {}}
          onSubmit={() => {}}
        />
      </IntlProvider>,
    );
    expect(tplHtml).toContain(`accept="${SIGN_UPLOAD_ACCEPT}"`);
    expect(tplHtml).toContain('data-testid="sign-docx-warning-banner"');
    expect(tplHtml).toContain('Đã chuyển đổi từ .docx; vui lòng kiểm tra lại bố cục trang PDF trước khi gửi ký');

    const convertingHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <DocxConversionNotice status="converting" result={null} />
      </IntlProvider>,
    );
    expect(convertingHtml).toContain('data-testid="sign-docx-converting"');
    expect(convertingHtml).toContain('Đang chuyển đổi tệp Word (.docx) sang PDF A4...');

    const dismissibleAlert = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <DocxWarningsAlert warnings={['images_skipped', 'footnotes_skipped']} onDismiss={() => {}} />
      </IntlProvider>,
    );
    expect(dismissibleAlert).toContain('aria-label="Đóng"');
    expect(dismissibleAlert).toContain('min-h-11 min-w-11');
    expect(dismissibleAlert).toContain('aria-hidden="true"');
    expect(dismissibleAlert).toContain('footnote/endnote');

    const envHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <CreateEnvelopeDialog onClose={() => {}} onCreated={() => {}} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(envHtml).toContain(`accept="${SIGN_UPLOAD_ACCEPT}"`);

    const tplErrorHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <CreateTemplateForm
          title="Hop dong dich vu"
          description=""
          routingMode="parallel"
          subject=""
          message=""
          file={null}
          error="Tệp .docx được bảo vệ bằng mật khẩu hoặc là định dạng Word cũ (.doc)"
          pending={false}
          inspecting={true}
          docxStatus="error"
          docxResult={null}
          onChangeTitle={() => {}}
          onChangeDescription={() => {}}
          onChangeRoutingMode={() => {}}
          onChangeSubject={() => {}}
          onChangeMessage={() => {}}
          onChangeFile={() => {}}
          onSubmit={() => {}}
        />
      </IntlProvider>,
    );
    expect(tplErrorHtml).toContain('role="alert"');
    expect(tplErrorHtml).toContain('Tệp .docx được bảo vệ bằng mật khẩu hoặc là định dạng Word cũ (.doc)');
    expect(tplErrorHtml).toContain('disabled=""');
  });

  it('bounds poll fetches with a deadline AbortSignal and maps AbortError to timeout', async () => {
    vi.useFakeTimers();
    let seenPollSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/sign/convert-docx')) {
        return new Response(JSON.stringify({ status: 'pending', jobId: 'job-abort-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      seenPollSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'slow.docx', SIGN_DOCX_MIME);
    const caught = convertSignDocx(file, 'acme').then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await caught).toMatchObject({ name: 'ClientError', message: 'sign.docxTimedOut' });
    expect(seenPollSignal).toBeDefined();
    expect(seenPollSignal?.aborted).toBe(true);
  });

  it('persists dismissible DocxWarningsAlert across envelope creation navigation and clears on dismiss or sign-out (#4729)', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { pathname: '/o/acme/sign/envelopes', hash: '' },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });

    const orgId = '01900000-0000-7000-8000-0000000000a1';
    const otherOrgId = '01900000-0000-7000-8000-0000000000a2';
    const userAId = '01900000-0000-7000-8000-000000000088';
    const userBId = '01900000-0000-7000-8000-000000000099';
    const scopeUserA = { org: orgId, userId: userAId };
    const scopeUserB = { org: orgId, userId: userBId };
    const scopeOtherOrg = { org: otherOrgId, userId: userAId };

    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: userAId,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
    });

    const setCreateOpen = vi.fn();
    const setCreatedDocxNotice = vi.fn();
    const invalidateEnvelopes = vi.fn(async () => {});
    const navigateToEnvelope = vi.fn(async () => {});

    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped', 'footnotes_skipped'],
      slug: 'acme',
      orgId,
      userId: userAId,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope,
    });

    expect(setCreateOpen).toHaveBeenCalledWith(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId,
      userId: userAId,
      sessionId: null,
      warnings: ['images_skipped', 'footnotes_skipped'],
    });
    expect(invalidateEnvelopes).toHaveBeenCalledTimes(1);
    expect(navigateToEnvelope).toHaveBeenCalledWith('acme', envDetailId);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped', 'footnotes_skipped']);
    // Reading does not auto-consume so the banner persists across detail reloads until dismissed.
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped', 'footnotes_skipped']);
    // Warnings are strictly isolated per user and org; another user or org cannot see or dismiss User A's banner.
    expect(readCreatedDocxWarnings(envDetailId, scopeUserB)).toEqual([]);
    expect(readCreatedDocxWarnings(envDetailId, scopeOtherOrg)).toEqual([]);
    clearCreatedDocxWarnings(envDetailId, scopeUserB);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped', 'footnotes_skipped']);

    const envelopeFixture = {
      envelope: {
        id: envDetailId,
        title: 'Hợp đồng từ Word',
        subject: null,
        message: null,
        status: 'draft',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: '01900000-0000-7000-8000-0000000000f1',
        sourceSha256: 'c'.repeat(64),
        inspectStatus: 'pending',
        inspectError: null,
        pageCount: null,
        pageDimensions: null,
        detectedTags: [],
        shareSummaryWithSigners: false,
        sharedSummary: null,
        allowDelegation: true,
        sealedFileId: null,
        sealedSha256: null,
        sealStatus: null,
        certificateFileId: null,
        certificateSha256: null,
        certificateCode: null,
        expiresAt: null,
        autoRemindBeforeExpiry: true,
        sentAt: null,
        completedAt: null,
        declinedAt: null,
        declineAcknowledgedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        expiredAt: null,
        version: 1,
        createdBy: userAId,
        createdAt: '2026-11-25T00:00:00.000Z',
        updatedAt: '2026-11-25T00:00:00.000Z',
      },
      signers: [],
      fields: [],
    };
    queryClient.setQueryData(['sign', 'envelope', envDetailId], envelopeFixture);

    const detailHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(detailHtml).toContain('data-testid="sign-docx-warning-banner"');
    expect(detailHtml).toContain('aria-label="Đóng"');
    expect(detailHtml).toContain('min-h-11 min-w-11');
    expect(detailHtml).toContain('footnote/endnote');

    // Another signed-in user in the same org must not render User A's warning banner on SignEnvelopeDetailPage.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: userBId,
      email: 'b@example.com',
      displayName: 'User B',
      orgs: [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    const otherUserDetailHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(otherUserDetailHtml).not.toContain('data-testid="sign-docx-warning-banner"');

    // Restore User A, then verify SIGNED_OUT clears persisted sessionStorage notices across the tab.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: userAId,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    let authStateCb: ((event: string) => void) | null = null;
    ensureSignedOutListener({
      isIsolated: () => false,
      subscribeAuthState: (cb) => {
        authStateCb = cb;
      },
      navigateToLogin: () => undefined,
    });
    expect(authStateCb).not.toBeNull();
    authStateCb!('SIGNED_OUT');
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(store.has('ludy.sign.created_docx_warnings')).toBe(false);

    // Re-seed User A auth + envelope cache after SIGNED_OUT queryClient.clear(), then test dismiss & quota preservation.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: userAId,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    queryClient.setQueryData(['sign', 'envelope', envDetailId], envelopeFixture);

    // Re-seed and dismiss explicitly as User A.
    saveCreatedDocxWarnings(envDetailId, ['images_skipped', 'footnotes_skipped'], scopeUserA);
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    const afterDismissHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(afterDismissHtml).not.toContain('data-testid="sign-docx-warning-banner"');

    // Creating a clean envelope with zero warnings clears any prior stored notice.
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: [],
      slug: '',
      orgId,
      userId: userAId,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope,
    });
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(setCreatedDocxNotice).toHaveBeenLastCalledWith(null);

    // When sessionStorage.setItem throws QuotaExceededError on adding a second envelope, existing persisted notices stay intact in sessionStorage and fallback holds the new entry.
    const existingEnvelopeId = '01900000-0000-7000-8000-0000000000e1';
    const quotaStore = new Map<string, string>();
    let rejectQuotaWrites = false;
    vi.stubGlobal('window', {
      location: { pathname: '/o/acme/sign/envelopes', hash: '' },
      sessionStorage: {
        getItem: (k: string) => quotaStore.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (rejectQuotaWrites) {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          }
          quotaStore.set(k, v);
        },
        removeItem: (k: string) => void quotaStore.delete(k),
      },
    });
    saveCreatedDocxWarnings(existingEnvelopeId, ['headers_footers_simplified'], scopeUserA);
    const persistedSnapshotBeforeQuota = quotaStore.get('ludy.sign.created_docx_warnings');
    expect(persistedSnapshotBeforeQuota).toBeDefined();

    rejectQuotaWrites = true;
    saveCreatedDocxWarnings(envDetailId, ['images_skipped', 'complex_columns_simplified'], scopeUserA);
    // Pre-existing record in sessionStorage was not erased by QuotaExceededError on adding a second notice.
    expect(quotaStore.get('ludy.sign.created_docx_warnings')).toBe(persistedSnapshotBeforeQuota);
    expect(readCreatedDocxWarnings(existingEnvelopeId, scopeUserA)).toEqual(['headers_footers_simplified']);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped', 'complex_columns_simplified']);
    const quotaDetailHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(quotaDetailHtml).toContain('data-testid="sign-docx-warning-banner"');
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(readCreatedDocxWarnings(existingEnvelopeId, scopeUserA)).toEqual(['headers_footers_simplified']);
    rejectQuotaWrites = false;
    clearCreatedDocxWarnings(existingEnvelopeId, scopeUserA);
    expect(readCreatedDocxWarnings(existingEnvelopeId, scopeUserA)).toEqual([]);

    // When sessionStorage is unavailable (null/blocked), clearing clean PDFs never pollutes dismissed tracking or evicts real notices.
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' } });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    for (let i = 0; i < 30; i += 1) {
      clearCreatedDocxWarnings(`01900000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`, scopeUserA);
    }
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped']);
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);

    // If a persisted notice was dismissed while sessionStorage became temporarily inaccessible, re-enabling storage keeps it suppressed.
    const transientStore = new Map<string, string>();
    const workingStorage = {
      getItem: (k: string) => transientStore.get(k) ?? null,
      setItem: (k: string, v: string) => void transientStore.set(k, v),
      removeItem: (k: string) => void transientStore.delete(k),
    };
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: workingStorage });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' } });
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: workingStorage });
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);

    // If me.get was still pending when the envelope was created, verified sessionId lets resolveUserScope fetch user/org before persisting & navigating.
    const resolveOrder: string[] = [];
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['ole_objects_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-a',
      resolveUserScope: async () => {
        resolveOrder.push('resolve');
        return { orgId, userId: userAId };
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: async () => {
        resolveOrder.push(`nav:${readCreatedDocxWarnings(envDetailId, scopeUserA).join(',')}`);
      },
    });
    expect(resolveOrder).toEqual(['resolve', 'nav:ole_objects_skipped']);
    clearCreatedDocxWarnings(envDetailId, scopeUserA);

    // Anonymous submit missing both userId and sessionId cannot attribute warnings to a post-login user returned by resolveUserScope.
    setCreatedDocxNotice.mockClear();
    const unverifiedNav = vi.fn(async () => {});
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: null,
      resolveUserScope: async () => ({ orgId, userId: userBId, sessionId: 'sess-b' }),
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(unverifiedNav).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, scopeUserB)).toEqual([]);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: null,
      warnings: ['images_skipped'],
    });

    // When readCurrentSessionId transiently returns null after creation, still invalidate the list and keep the pending notice visible.
    setCreatedDocxNotice.mockClear();
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId,
      userId: userAId,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => null,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(invalidateEnvelopes).toHaveBeenCalledTimes(1);
    expect(unverifiedNav).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId,
      userId: userAId,
      sessionId: 'sess-a',
      warnings: ['images_skipped'],
    });

    // If me.get is unavailable AND resolveUserScope fails, keep the notice on the list page instead of auto-navigating away from warnings.
    setCreatedDocxNotice.mockClear();
    const unpersistedNav = vi.fn(async () => {});
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      resolveUserScope: async () => {
        throw new Error('offline');
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unpersistedNav,
    });
    expect(unpersistedNav).not.toHaveBeenCalled();
    expect(setCreatedDocxNotice).toHaveBeenCalledWith({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: null,
      warnings: ['images_skipped'],
    });

    // Knowing userId without orgId (me.get missing new orgId) ALSO holds on list page instead of saving under slug and losing the banner on Detail.
    setCreatedDocxNotice.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: userAId,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unpersistedNav,
    });
    expect(unpersistedNav).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, { org: 'acme', userId: userAId })).toEqual([]);

    // Clicking "Open envelope" while me.get is still down stays on list page; once me.get recovers, it persists before navigating.
    const unpersistedNotice = {
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: userAId,
      sessionId: 'sess-a',
      warnings: ['images_skipped'] as const,
    };
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: userAId,
        resolveUserScope: async () => {
          throw new Error('still offline');
        },
        setCreatedDocxNotice,
        navigateToEnvelope: unpersistedNav,
      }),
    ).toBe(false);
    expect(unpersistedNav).not.toHaveBeenCalled();

    // If account changed to User B after creation, Open refuses to persist or navigate under User B.
    setCreatedDocxNotice.mockClear();
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: userBId,
        setCreatedDocxNotice,
        navigateToEnvelope: unpersistedNav,
      }),
    ).toBe(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith(null);
    expect(unpersistedNav).not.toHaveBeenCalled();

    // Even when notice had userId: null (me.get failed on creation), sessionId mismatch blocks persisting for User B.
    setCreatedDocxNotice.mockClear();
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, userId: null },
        currentUserId: userBId,
        resolveCurrentSessionId: async () => 'sess-b',
        setCreatedDocxNotice,
        navigateToEnvelope: unpersistedNav,
      }),
    ).toBe(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith(null);
    expect(unpersistedNav).not.toHaveBeenCalled();

    const recoveredOrder: string[] = [];
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: userAId,
        resolveCurrentSessionId: async () => 'sess-a',
        resolveUserScope: async () => {
          recoveredOrder.push('resolve');
          return { orgId, userId: userAId };
        },
        setCreatedDocxNotice,
        navigateToEnvelope: async (navSlug, navId) => {
          recoveredOrder.push(`nav:${navSlug}:${navId}:${readCreatedDocxWarnings(envDetailId, scopeUserA).join(',')}`);
        },
      }),
    ).toBe(true);
    expect(recoveredOrder).toEqual(['resolve', `nav:acme:${envDetailId}:images_skipped`]);
    clearCreatedDocxWarnings(envDetailId, scopeUserA);

    // If org context changed while resolveUserScope was in flight, stale notice/navigation is suppressed.
    setCreatedDocxNotice.mockClear();
    const staleNav = vi.fn(async () => {});
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      resolveUserScope: async () => ({ orgId, userId: userAId }),
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    expect(staleNav).not.toHaveBeenCalled();
    clearCreatedDocxWarnings(envDetailId, scopeUserA);

    // Leaving the list page after createEnvelope succeeded skips UI updates (setCreateOpen, banner, navigate)
    // while still invalidating the list cache and persisting warnings for the verified creator session.
    setCreateOpen.mockClear();
    setCreatedDocxNotice.mockClear();
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId,
      userId: userAId,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-a',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(setCreateOpen).not.toHaveBeenCalled();
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    expect(staleNav).not.toHaveBeenCalled();
    expect(invalidateEnvelopes).toHaveBeenCalledTimes(1);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped']);
    clearCreatedDocxWarnings(envDetailId, scopeUserA);

    // If session changed or signed out while createEnvelope was in flight, never persist warnings into sessionStorage.
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId,
      userId: userAId,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-b',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);

    // Anonymous notice missing both creator userId and sessionId cannot be attributed to currentUserId on Open.
    setCreatedDocxNotice.mockClear();
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, orgId, userId: null, sessionId: null },
        currentUserId: userBId,
        setCreatedDocxNotice,
        navigateToEnvelope: staleNav,
      }),
    ).toBe(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith(null);
    expect(readCreatedDocxWarnings(envDetailId, { org: orgId, userId: userBId })).toEqual([]);
    expect(staleNav).not.toHaveBeenCalled();

    // Dismissing while openCreatedDocxNoticeEnvelope is awaiting resolveUserScope cancels BEFORE saveCreatedDocxWarnings runs.
    let dismissedMidFlight = false;
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: userAId,
        resolveCurrentSessionId: async () => 'sess-a',
        resolveUserScope: async () => {
          dismissedMidFlight = true;
          return { orgId, userId: userAId };
        },
        isCurrentContext: () => !dismissedMidFlight,
        setCreatedDocxNotice,
        navigateToEnvelope: staleNav,
      }),
    ).toBe(false);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(staleNav).not.toHaveBeenCalled();

    // Dismissing during the final resolveCurrentSessionId verification also aborts before saving or navigating.
    setCreatedDocxNotice.mockClear();
    let sessionCallCount = 0;
    let dismissedOnFinalSessionCheck = false;
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, orgId },
        currentUserId: userAId,
        resolveCurrentSessionId: async () => {
          sessionCallCount += 1;
          if (sessionCallCount === 2) {
            dismissedOnFinalSessionCheck = true;
          }
          return 'sess-a';
        },
        isCurrentContext: () => !dismissedOnFinalSessionCheck,
        setCreatedDocxNotice,
        navigateToEnvelope: staleNav,
      }),
    ).toBe(false);
    expect(sessionCallCount).toBe(2);
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(staleNav).not.toHaveBeenCalled();

    // If sessionId cannot be resolved (null), keep notice pending for retry instead of attributing to cached currentUserId.
    setCreatedDocxNotice.mockClear();
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, orgId, userId: null },
        currentUserId: userBId,
        resolveCurrentSessionId: async () => null,
        setCreatedDocxNotice,
        navigateToEnvelope: staleNav,
      }),
    ).toBe(false);
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, { org: orgId, userId: userBId })).toEqual([]);
    expect(staleNav).not.toHaveBeenCalled();

    // CreateEnvelopeDialog pins submitContext.slug to uploadPdf and createEnvelope, and aborts if org switches mid-flight.
    const uploadCalls: Array<{ name: string; orgSlug: string | null | undefined }> = [];
    const createCalls: Array<{ sourceFileId: string; orgSlug: string | null | undefined }> = [];
    const samplePdf = makeTestFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'hop-dong.pdf', 'application/pdf');
    let liveOrgSlug = 'org-a';
    const pinnedOutcome = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong A',
      file: samplePdf,
      converted: null,
      orgSlug: 'org-a',
      resolveSubmitContext: async () => ({
        slug: 'org-a',
        orgId,
        userId: userAId,
        sessionId: 'sess-a',
        reqId: 1,
      }),
      isMounted: () => true,
      isSubmitContextCurrent: (ctx) => ctx.slug === liveOrgSlug,
      getLiveOrgSlug: () => liveOrgSlug,
      docxRequiredMessage: 'PDF required',
      uploadPdf: async (file, slugArg) => {
        uploadCalls.push({ name: file.name, orgSlug: slugArg });
        return { fileId: 'file-org-a' };
      },
      createEnvelope: async (input, slugArg) => {
        createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
        return { envelopeId: 'env-org-a' };
      },
    });
    expect(pinnedOutcome).toMatchObject({ cancelled: false, created: { envelopeId: 'env-org-a' } });
    expect(uploadCalls).toEqual([{ name: 'hop-dong.pdf', orgSlug: 'org-a' }]);
    expect(createCalls).toEqual([{ sourceFileId: 'file-org-a', orgSlug: 'org-a' }]);

    // Switching org while resolveSubmitContext awaits aborts before any upload or create request runs.
    uploadCalls.length = 0;
    createCalls.length = 0;
    liveOrgSlug = 'org-a';
    const abortedBeforeUpload = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong stale',
      file: samplePdf,
      converted: null,
      orgSlug: 'org-a',
      resolveSubmitContext: async () => {
        liveOrgSlug = 'org-b';
        return {
          slug: 'org-a',
          orgId,
          userId: userAId,
          sessionId: 'sess-a',
          reqId: 1,
        };
      },
      isMounted: () => true,
      isSubmitContextCurrent: (ctx) => ctx.slug === liveOrgSlug,
      getLiveOrgSlug: () => liveOrgSlug,
      docxRequiredMessage: 'PDF required',
      uploadPdf: async (file, slugArg) => {
        uploadCalls.push({ name: file.name, orgSlug: slugArg });
        return { fileId: 'should-not-upload' };
      },
      createEnvelope: async (input, slugArg) => {
        createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
        return { envelopeId: 'should-not-create' };
      },
    });
    expect(abortedBeforeUpload).toEqual({ cancelled: true });
    expect(uploadCalls).toEqual([]);
    expect(createCalls).toEqual([]);

    // Switching org while uploadPdf is in flight aborts before createEnvelope executes.
    uploadCalls.length = 0;
    createCalls.length = 0;
    liveOrgSlug = 'org-a';
    const abortedBeforeCreate = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong stale post-upload',
      file: samplePdf,
      converted: null,
      orgSlug: 'org-a',
      resolveSubmitContext: async () => ({
        slug: 'org-a',
        orgId,
        userId: userAId,
        sessionId: 'sess-a',
        reqId: 1,
      }),
      isMounted: () => true,
      isSubmitContextCurrent: (ctx) => ctx.slug === liveOrgSlug,
      getLiveOrgSlug: () => liveOrgSlug,
      docxRequiredMessage: 'PDF required',
      uploadPdf: async (file, slugArg) => {
        uploadCalls.push({ name: file.name, orgSlug: slugArg });
        liveOrgSlug = 'org-b';
        return { fileId: 'uploaded-a-then-switched' };
      },
      createEnvelope: async (input, slugArg) => {
        createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
        return { envelopeId: 'should-not-create' };
      },
    });
    expect(abortedBeforeCreate).toEqual({ cancelled: true });
    expect(uploadCalls).toEqual([{ name: 'hop-dong.pdf', orgSlug: 'org-a' }]);
    expect(createCalls).toEqual([]);

    // resolveUserScope returning a different userId is treated as an account mismatch and never adopts fetched.orgId.
    setCreatedDocxNotice.mockClear();
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: userAId,
      resolveUserScope: async () => ({ orgId: '01900000-0000-7000-8000-0000000000b1', userId: userBId }),
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(setCreatedDocxNotice).toHaveBeenLastCalledWith(null);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(readCreatedDocxWarnings(envDetailId, { org: '01900000-0000-7000-8000-0000000000b1', userId: userAId })).toEqual([]);
    expect(readCreatedDocxWarnings(envDetailId, { org: '01900000-0000-7000-8000-0000000000b1', userId: userBId })).toEqual([]);

    setCreatedDocxNotice.mockClear();
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, orgId: null, userId: userAId, sessionId: null },
        currentUserId: userAId,
        resolveUserScope: async () => ({ orgId: '01900000-0000-7000-8000-0000000000b2', userId: userBId }),
        setCreatedDocxNotice,
        navigateToEnvelope: staleNav,
      }),
    ).toBe(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith(null);
    expect(readCreatedDocxWarnings(envDetailId, { org: '01900000-0000-7000-8000-0000000000b2', userId: userAId })).toEqual([]);

    // Notice banner details with missing userId stay hidden until sessionId verification matches live session.
    const anonSessionNotice = {
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      warnings: ['images_skipped'] as const,
    };
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', userBId, null)).toBe(false);
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', userBId, 'sess-b')).toBe(false);
    expect(isCreatedDocxListNoticeVisible({ ...anonSessionNotice, sessionId: null }, 'acme', userBId, 'sess-a')).toBe(false);
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', userAId, 'sess-a')).toBe(true);

    // If sessionStorage.removeItem fails or storage is unavailable during sign-out, recovery wipes stale notices before returning or writing.
    const signOutStore = new Map<string, string>();
    let allowSignOutRemove = true;
    const flakyStorage = {
      getItem: (k: string) => signOutStore.get(k) ?? null,
      setItem: (k: string, v: string) => void signOutStore.set(k, v),
      removeItem: (k: string) => {
        if (!allowSignOutRemove) {
          throw new DOMException('Blocked during signout', 'SecurityError');
        }
        signOutStore.delete(k);
      },
    };
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: flakyStorage });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    expect(signOutStore.has('ludy.sign.created_docx_warnings')).toBe(true);
    allowSignOutRemove = false;
    clearAllCreatedDocxWarnings();
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    allowSignOutRemove = true;
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(signOutStore.has('ludy.sign.created_docx_warnings')).toBe(false);

    // Recovery after temporary storage block syncs both fallback dismissals and fallback saves directly onto sessionStorage.
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' } });
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    const secondEnvId = '01900000-0000-7000-8000-0000000000ed';
    saveCreatedDocxWarnings(secondEnvId, ['footnotes_skipped'], scopeUserA);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: flakyStorage });
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(readCreatedDocxWarnings(secondEnvId, scopeUserA)).toEqual(['footnotes_skipped']);
    const syncedRaw = signOutStore.get('ludy.sign.created_docx_warnings') ?? '';
    expect(syncedRaw).not.toContain(envDetailId);
    expect(syncedRaw).toContain(secondEnvId);

    // captureEnvelopeSubmitContext binds userId/orgId directly from live session me.get instead of stale cached UI identity.
    const liveCaptured = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 3,
      readSessionId: async () => 'sess-b',
      resolveScope: async (_targetSlug, expectedSession) => ({
        orgId: '01900000-0000-7000-8000-0000000000b1',
        userId: userBId,
        sessionId: expectedSession ?? null,
      }),
    });
    expect(liveCaptured).toEqual({
      slug: 'acme',
      orgId: '01900000-0000-7000-8000-0000000000b1',
      userId: userBId,
      sessionId: 'sess-b',
      reqId: 3,
    });
    const offlineCaptured = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 4,
      readSessionId: async () => 'sess-b',
      resolveScope: async () => {
        throw new Error('me offline');
      },
    });
    expect(offlineCaptured).toEqual({
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-b',
      reqId: 4,
    });

    // Session switch during me.get in captureEnvelopeSubmitContext marks sessionChanged so upload/create aborts before sending.
    let sessionCall = 0;
    const swappedCapture = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 5,
      readSessionId: async () => (sessionCall++ === 0 ? 'sess-a' : 'sess-b'),
      resolveScope: async () => null,
    });
    expect(swappedCapture.sessionChanged).toBe(true);

    uploadCalls.length = 0;
    createCalls.length = 0;
    const abortedOnSessionSwap = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong session swapped',
      file: samplePdf,
      converted: null,
      orgSlug: 'acme',
      resolveSubmitContext: async () => swappedCapture,
      isMounted: () => true,
      getLiveOrgSlug: () => 'acme',
      docxRequiredMessage: 'PDF required',
      uploadPdf: async (file, slugArg) => {
        uploadCalls.push({ name: file.name, orgSlug: slugArg });
        return { fileId: 'should-not-upload' };
      },
      createEnvelope: async (input, slugArg) => {
        createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
        return { envelopeId: 'should-not-create' };
      },
    });
    expect(abortedOnSessionSwap).toEqual({ cancelled: true });
    expect(uploadCalls).toEqual([]);
    expect(createCalls).toEqual([]);

    // Submitting a converted .docx that has warnings fails before createEnvelope when neither userId nor sessionId can be proved.
    const docxWithWarningsFile = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'hd.docx', SIGN_DOCX_MIME);
    createCalls.length = 0;
    await expect(
      submitCreateEnvelopeFromDialog({
        title: 'Hop dong canh bao',
        file: docxWithWarningsFile,
        converted: {
          status: 'completed',
          fileId: 'file-docx-1',
          sourceDocxSha256: 'd'.repeat(64),
          filename: 'hd.pdf',
          pageCount: 1,
          warnings: ['images_skipped'],
        },
        orgSlug: 'acme',
        resolveSubmitContext: async () => ({
          slug: 'acme',
          orgId: null,
          userId: null,
          sessionId: null,
          reqId: 6,
        }),
        isMounted: () => true,
        getLiveOrgSlug: () => 'acme',
        docxRequiredMessage: 'PDF required',
        verifyIdentityErrorMessage: 'Retry identity verification',
        uploadPdf: async () => ({ fileId: 'unused' }),
        createEnvelope: async (input, slugArg) => {
          createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
          return { envelopeId: 'should-not-create' };
        },
      }),
    ).rejects.toThrow('Retry identity verification');
    expect(createCalls).toEqual([]);

    // Dismissing while sessionStorage getItem and setItem both throw SecurityError still remembers the dismissal across storage recovery.
    const throwingStoreMap = new Map<string, string>();
    let blockStorageAccess = false;
    const securityFlakyStorage = {
      getItem: (k: string) => {
        if (blockStorageAccess) throw new DOMException('Denied', 'SecurityError');
        return throwingStoreMap.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (blockStorageAccess) throw new DOMException('Denied', 'SecurityError');
        throwingStoreMap.set(k, v);
      },
      removeItem: (k: string) => {
        if (blockStorageAccess) throw new DOMException('Denied', 'SecurityError');
        throwingStoreMap.delete(k);
      },
    };
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: securityFlakyStorage });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    expect(throwingStoreMap.has('ludy.sign.created_docx_warnings')).toBe(true);
    blockStorageAccess = true;
    clearCreatedDocxWarnings(envDetailId, scopeUserA);
    blockStorageAccess = false;
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual([]);
    expect(throwingStoreMap.has('ludy.sign.created_docx_warnings')).toBe(false);

    // Capturing submit context flags null -> signed-in session changes, and org switch while reading session aborts writes.
    let loginMidCapture = 0;
    const loggedInMidCapture = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 7,
      readSessionId: async () => (loginMidCapture++ === 0 ? null : 'sess-new'),
      resolveScope: async () => ({ orgId, userId: userAId, sessionId: 'sess-new' }),
    });
    expect(loggedInMidCapture.sessionChanged).toBe(true);

    uploadCalls.length = 0;
    createCalls.length = 0;
    liveOrgSlug = 'org-a';
    const switchedDuringSessionRead = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong switched during session check',
      file: samplePdf,
      converted: null,
      orgSlug: 'org-a',
      resolveSubmitContext: async () => ({
        slug: 'org-a',
        orgId,
        userId: userAId,
        sessionId: 'sess-a',
        reqId: 8,
      }),
      readSessionId: async () => {
        liveOrgSlug = 'org-b';
        return 'sess-a';
      },
      isMounted: () => true,
      isSubmitContextCurrent: (ctx) => ctx.slug === liveOrgSlug,
      getLiveOrgSlug: () => liveOrgSlug,
      docxRequiredMessage: 'PDF required',
      uploadPdf: async (file, slugArg) => {
        uploadCalls.push({ name: file.name, orgSlug: slugArg });
        return { fileId: 'should-not-upload' };
      },
      createEnvelope: async (input, slugArg) => {
        createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
        return { envelopeId: 'should-not-create' };
      },
    });
    expect(switchedDuringSessionRead).toEqual({ cancelled: true });
    expect(uploadCalls).toEqual([]);
    expect(createCalls).toEqual([]);

    // ContractVaultBar switches pending unpersisted envelope links to buttons so warning persistence precedes navigation.
    const pendingVaultHtml = renderToStaticMarkup(
      <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
        <QueryClientProvider client={queryClient}>
          <ContractVaultBar
            slug="acme"
            canAskVy={true}
            initialQuestion="minh anh"
            pendingEnvelopeIds={new Set([envDetailId])}
            onOpenPendingEnvelope={() => {}}
            initialResult={{
              mode: 'ask',
              ai: 'used',
              items: [
                {
                  envelopeId: envDetailId,
                  title: 'Pending Docx Contract',
                  status: 'draft',
                  sourceKind: 'standalone',
                  pageCount: 1,
                  completedAt: null,
                  updatedAt: '2026-11-25T10:00:00.000Z',
                  counterpartyName: null,
                  effectiveDate: null,
                  expiryDate: null,
                  renewalNoticeDays: null,
                  autoRenew: false,
                  contractValue: null,
                  currency: 'VND',
                  score: 10,
                  snippets: [],
                },
              ],
              summary: {
                answer: 'See citation',
                proposedByAi: true,
                citations: [
                  {
                    envelopeId: envDetailId,
                    envelopeTitle: 'Pending Docx Contract',
                    pageNumber: 1,
                    quoteExcerpt: 'Excerpt',
                  },
                ],
              },
            }}
          />
        </QueryClientProvider>
      </IntlProvider>,
    );
    expect(pendingVaultHtml).not.toContain('<a ');
    expect(pendingVaultHtml).toContain(`data-testid="sign-vault-citation-link-${envDetailId}"`);
    expect(pendingVaultHtml).toContain(`data-testid="sign-vault-open-${envDetailId}"`);

    // saveCreatedDocxWarnings never overwrites existing sessionStorage notices when getItem fails transiently.
    const preserveMap = new Map<string, string>();
    let blockReadOnly = false;
    const readFailStorage = {
      getItem: (k: string) => {
        if (blockReadOnly) throw new DOMException('Transient read error', 'SecurityError');
        return preserveMap.get(k) ?? null;
      },
      setItem: (k: string, v: string) => void preserveMap.set(k, v),
      removeItem: (k: string) => void preserveMap.delete(k),
    };
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: readFailStorage });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA);
    blockReadOnly = true;
    saveCreatedDocxWarnings(secondEnvId, ['footnotes_skipped'], scopeUserA);
    blockReadOnly = false;
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped']);
    expect(readCreatedDocxWarnings(secondEnvId, scopeUserA)).toEqual(['footnotes_skipped']);

    // Corrupt JSON in readable sessionStorage is treated as empty so saveCreatedDocxWarnings can overwrite and repair it.
    preserveMap.set('ludy.sign.created_docx_warnings', '{corrupt-json');
    expect(saveCreatedDocxWarnings(envDetailId, ['images_skipped'], scopeUserA)).toBe(true);
    expect(preserveMap.get('ludy.sign.created_docx_warnings')).toContain(envDetailId);
    expect(readCreatedDocxWarnings(envDetailId, scopeUserA)).toEqual(['images_skipped']);

    // captureEnvelopeSubmitContext skips resolveScope (me.get) when includeUserScope=false for fast PDF submits.
    const resolveScopeSpy = vi.fn(async () => ({ orgId, userId: userAId, sessionId: 'sess-a' }));
    const fastPdfContext = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 9,
      includeUserScope: false,
      readSessionId: async () => 'sess-a',
      resolveScope: resolveScopeSpy,
    });
    expect(resolveScopeSpy).not.toHaveBeenCalled();
    expect(fastPdfContext).toEqual({
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      reqId: 9,
    });

    // Transient readSessionId error throws verifyIdentityErrorMessage in dialog instead of cancelling silently.
    await expect(
      submitCreateEnvelopeFromDialog({
        title: 'Hop dong transient session fail',
        file: samplePdf,
        converted: null,
        orgSlug: 'acme',
        resolveSubmitContext: async () => fastPdfContext,
        readSessionId: async () => {
          throw new Error('session storage offline');
        },
        isMounted: () => true,
        getLiveOrgSlug: () => 'acme',
        docxRequiredMessage: 'PDF required',
        verifyIdentityErrorMessage: 'Retry identity verification',
        uploadPdf: async () => ({ fileId: 'unused' }),
        createEnvelope: async () => ({ envelopeId: 'unused' }),
      }),
    ).rejects.toThrow('Retry identity verification');

    // Pending unpersisted warnings remain preserved across additional unpersisted .docx or clean PDF creations.
    let pendingList = applyPendingDocxNoticeUpdate([], {
      kind: 'upsert',
      notice: {
        envelopeId: envDetailId,
        slug: 'acme',
        orgId: null,
        userId: null,
        sessionId: 'sess-a',
        warnings: ['images_skipped'],
      },
    });
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: secondEnvId,
      warnings: ['footnotes_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => null,
      hasOtherPendingNotice: () => pendingList.some((n) => n.envelopeId !== secondEnvId),
      onPendingNoticeAction: (action) => {
        pendingList = applyPendingDocxNoticeUpdate(pendingList, action);
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(pendingList.map((n) => n.envelopeId)).toEqual([secondEnvId, envDetailId]);

    const pdfEnvId = '01900000-0000-7000-8000-0000000000ef';
    staleNav.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: pdfEnvId,
      warnings: [],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      hasOtherPendingNotice: () => pendingList.some((n) => n.envelopeId !== pdfEnvId),
      onPendingNoticeAction: (action) => {
        pendingList = applyPendingDocxNoticeUpdate(pendingList, action);
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: staleNav,
    });
    expect(pendingList.map((n) => n.envelopeId)).toEqual([secondEnvId, envDetailId]);
    expect(staleNav).not.toHaveBeenCalled();

    // uploadSignPdf aborts UPLOAD_BUSY retry before sending if live session token switched mid-backoff.
    const makeJwt = (sessionId: string) =>
      `hdr.${btoa(JSON.stringify({ session_id: sessionId })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;
    const jwtA = makeJwt('sess-a');
    const jwtB = makeJwt('sess-b');
    let activeJwt = jwtA;
    vi.mocked(accessToken).mockImplementation(async () => activeJwt);
    const seenAuthHeaders: string[] = [];
    const fetchBusyMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string> | undefined;
      seenAuthHeaders.push(hdrs?.authorization ?? '');
      activeJwt = jwtB;
      return new Response(JSON.stringify({ code: 'UPLOAD_BUSY', message: 'busy' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchBusyMock);
    vi.useFakeTimers();
    const uploadErrPromise = uploadSignPdf(samplePdf, 'acme', 'sess-a').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_100);
    const uploadErr = await uploadErrPromise;
    expect(uploadErr).toBeInstanceOf(SignSessionMismatchError);
    expect(fetchBusyMock).toHaveBeenCalledTimes(1);
    expect(seenAuthHeaders).toEqual([`Bearer ${jwtA}`]);
  });
});
