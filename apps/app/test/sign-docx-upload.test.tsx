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
  SignSessionUnverifiedError,
  convertSignDocx,
  fetchUserScopeForSession,
  readVerifiedSession,
  uploadSignPdf,
} = await import('../src/lib/sign-api.ts');
const {
  clearPendingDocxListNotices,
  listPendingDocxListNotices,
  readPendingDocxListNotice,
  removePendingDocxListNotice,
  upsertPendingDocxListNotice,
} = await import('../src/lib/sign-docx-notices.ts');
const { accessToken, auth } = await import('../src/lib/auth.ts');
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
const { SignEnvelopeDetailPage, resolveDetailPendingDocxWarnings } = await import(
  '../src/routes/sign-envelope-detail.tsx'
);
const { CreateTemplateForm } = await import('../src/routes/sign-templates.tsx');
const { ContractVaultBar } = await import('../src/components/sign/contract-vault-bar.tsx');

const ORG_A_ID = '01900000-0000-7000-8000-0000000000a1';
const ORG_B_ID = '01900000-0000-7000-8000-0000000000a2';
const USER_A_ID = '01900000-0000-7000-8000-000000000088';
const USER_B_ID = '01900000-0000-7000-8000-000000000099';
const SECOND_ENV_ID = '01900000-0000-7000-8000-0000000000ed';
const SCOPE_USER_A = { org: ORG_A_ID, userId: USER_A_ID };
const SCOPE_USER_B = { org: ORG_A_ID, userId: USER_B_ID };
const SCOPE_OTHER_ORG = { org: ORG_B_ID, userId: USER_A_ID };

function makeTestFile(bytes: Uint8Array, name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function makeTestJwt(sessionId: string): string {
  const payload = btoa(JSON.stringify({ session_id: sessionId }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `hdr.${payload}.sig`;
}

function installMemorySessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    location: { pathname: '/o/acme/sign/envelopes', hash: '' },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

function makeEnvelopeDetailFixture(envelopeId = envDetailId, createdBy = USER_A_ID) {
  return {
    envelope: {
      id: envelopeId,
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
      createdBy,
      createdAt: '2026-11-25T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
    },
    signers: [],
    fields: [],
  };
}

describe('eSign .docx client upload and UI components (#4721)', () => {
  afterEach(() => {
    clearAllCreatedDocxWarnings();
    queryClient.clear();
    vi.mocked(accessToken).mockImplementation(async () => 'test-token');
    vi.mocked(auth).mockReset();
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

  it('persists scoped DocxWarningsAlert across creation/detail navigation and clears on dismiss or sign-out (#4729)', async () => {
    const store = installMemorySessionStorage();
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: USER_A_ID,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    });

    const setCreateOpen = vi.fn();
    const setCreatedDocxNotice = vi.fn();
    const invalidateEnvelopes = vi.fn(async () => {});
    const navigateToEnvelope = vi.fn(async () => {});

    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      envelopeTitle: 'Hợp đồng từ Word',
      warnings: ['images_skipped', 'footnotes_skipped'],
      slug: 'acme',
      orgId: ORG_A_ID,
      userId: USER_A_ID,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope,
    });

    expect(setCreateOpen).toHaveBeenCalledWith(false);
    expect(setCreatedDocxNotice).toHaveBeenCalledWith({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: ORG_A_ID,
      userId: USER_A_ID,
      sessionId: null,
      envelopeTitle: 'Hợp đồng từ Word',
      warnings: ['images_skipped', 'footnotes_skipped'],
    });
    expect(invalidateEnvelopes).toHaveBeenCalledTimes(1);
    expect(navigateToEnvelope).toHaveBeenCalledWith('acme', envDetailId);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped', 'footnotes_skipped']);
    // Reading does not auto-consume so the banner persists across detail reloads until dismissed.
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped', 'footnotes_skipped']);
    // Warnings are strictly isolated per user and org; another user or org cannot see or dismiss User A's banner.
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_B)).toEqual([]);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_OTHER_ORG)).toEqual([]);
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_B);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped', 'footnotes_skipped']);

    const envelopeFixture = makeEnvelopeDetailFixture();
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

    // Titled DocxWarningsAlert exposes distinct envelope title + accessible dismiss label.
    const titledBannerHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <DocxWarningsAlert
          title="Hợp đồng từ Word"
          warnings={['images_skipped']}
          onDismiss={() => {}}
        />
      </IntlProvider>,
    );
    expect(titledBannerHtml).toContain('Hợp đồng từ Word');
    expect(titledBannerHtml).toContain('aria-label="Đóng: Hợp đồng từ Word"');

    // Another signed-in user in the same org must not render User A's warning banner on SignEnvelopeDetailPage.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: USER_B_ID,
      email: 'b@example.com',
      displayName: 'User B',
      orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    const otherUserDetailHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(otherUserDetailHtml).not.toContain('data-testid="sign-docx-warning-banner"');

    // SIGNED_OUT clears persisted sessionStorage notices across the tab.
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
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(store.has('ludy.sign.created_docx_warnings')).toBe(false);

    // Re-seed User A auth + envelope cache after SIGNED_OUT queryClient.clear(), then test explicit dismiss & clean PDF clear.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: USER_A_ID,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    queryClient.setQueryData(['sign', 'envelope', envDetailId], envelopeFixture);
    saveCreatedDocxWarnings(envDetailId, ['images_skipped', 'footnotes_skipped'], SCOPE_USER_A);
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    const afterDismissHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(afterDismissHtml).not.toContain('data-testid="sign-docx-warning-banner"');

    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: [],
      slug: '',
      orgId: ORG_A_ID,
      userId: USER_A_ID,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope,
    });
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(setCreatedDocxNotice).toHaveBeenLastCalledWith(null);
  });

  it('keeps storage intact across QuotaExceededError/SecurityError, corrupt JSON, and pending sign-out recovery (#4729)', () => {
    const existingEnvelopeId = '01900000-0000-7000-8000-0000000000e1';
    const quotaStore = new Map<string, string>();
    let rejectQuotaWrites = false;
    vi.stubGlobal('window', {
      location: { pathname: '/o/acme/sign/envelopes', hash: '' },
      sessionStorage: {
        getItem: (k: string) => quotaStore.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (rejectQuotaWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          quotaStore.set(k, v);
        },
        removeItem: (k: string) => void quotaStore.delete(k),
      },
    });
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: USER_A_ID,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    queryClient.setQueryData(['sign', 'envelope', envDetailId], makeEnvelopeDetailFixture());

    saveCreatedDocxWarnings(existingEnvelopeId, ['headers_footers_simplified'], SCOPE_USER_A);
    const persistedSnapshotBeforeQuota = quotaStore.get('ludy.sign.created_docx_warnings');
    expect(persistedSnapshotBeforeQuota).toBeDefined();

    rejectQuotaWrites = true;
    saveCreatedDocxWarnings(envDetailId, ['images_skipped', 'complex_columns_simplified'], SCOPE_USER_A);
    expect(quotaStore.get('ludy.sign.created_docx_warnings')).toBe(persistedSnapshotBeforeQuota);
    expect(readCreatedDocxWarnings(existingEnvelopeId, SCOPE_USER_A)).toEqual(['headers_footers_simplified']);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped', 'complex_columns_simplified']);
    const quotaDetailHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <SignEnvelopeDetailPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(quotaDetailHtml).toContain('data-testid="sign-docx-warning-banner"');
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(readCreatedDocxWarnings(existingEnvelopeId, SCOPE_USER_A)).toEqual(['headers_footers_simplified']);
    rejectQuotaWrites = false;
    clearCreatedDocxWarnings(existingEnvelopeId, SCOPE_USER_A);
    expect(readCreatedDocxWarnings(existingEnvelopeId, SCOPE_USER_A)).toEqual([]);

    // Clearing clean PDFs when sessionStorage is absent never evicts fallback warnings.
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' } });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    for (let i = 0; i < 30; i += 1) {
      clearCreatedDocxWarnings(`01900000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`, SCOPE_USER_A);
    }
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped']);
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);

    // Sign-out wipes stale storage on recovery even if removeItem initially threw SecurityError.
    const flakyStore = new Map<string, string>();
    let allowSignOutRemove = true;
    let blockStorageAccess = false;
    let blockReadOnly = false;
    const flakyStorage = {
      getItem: (k: string) => {
        if (blockStorageAccess || blockReadOnly) throw new DOMException('Denied', 'SecurityError');
        return flakyStore.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (blockStorageAccess) throw new DOMException('Denied', 'SecurityError');
        flakyStore.set(k, v);
      },
      removeItem: (k: string) => {
        if (blockStorageAccess || !allowSignOutRemove) throw new DOMException('Blocked', 'SecurityError');
        flakyStore.delete(k);
      },
    };
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: flakyStorage });
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    allowSignOutRemove = false;
    clearAllCreatedDocxWarnings();
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    allowSignOutRemove = true;
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(flakyStore.has('ludy.sign.created_docx_warnings')).toBe(false);

    // Recovery after temporary storage block syncs both fallback dismissals and fallback saves directly onto sessionStorage.
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' } });
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);
    saveCreatedDocxWarnings(SECOND_ENV_ID, ['footnotes_skipped'], SCOPE_USER_A);
    vi.stubGlobal('window', { location: { pathname: '/o/acme/sign/envelopes', hash: '' }, sessionStorage: flakyStorage });
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(readCreatedDocxWarnings(SECOND_ENV_ID, SCOPE_USER_A)).toEqual(['footnotes_skipped']);
    const syncedRaw = flakyStore.get('ludy.sign.created_docx_warnings') ?? '';
    expect(syncedRaw).not.toContain(envDetailId);
    expect(syncedRaw).toContain(SECOND_ENV_ID);

    // Dismissing while getItem and setItem both throw SecurityError preserves suppression across recovery.
    clearAllCreatedDocxWarnings();
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    blockStorageAccess = true;
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);
    blockStorageAccess = false;
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(flakyStore.has('ludy.sign.created_docx_warnings')).toBe(false);

    // saveCreatedDocxWarnings never overwrites existing sessionStorage notices on transient getItem failure, but repairs corrupt JSON.
    saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A);
    blockReadOnly = true;
    saveCreatedDocxWarnings(SECOND_ENV_ID, ['footnotes_skipped'], SCOPE_USER_A);
    blockReadOnly = false;
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped']);
    expect(readCreatedDocxWarnings(SECOND_ENV_ID, SCOPE_USER_A)).toEqual(['footnotes_skipped']);

    flakyStore.set('ludy.sign.created_docx_warnings', '{corrupt-json');
    expect(saveCreatedDocxWarnings(envDetailId, ['images_skipped'], SCOPE_USER_A)).toBe(true);
    expect(flakyStore.get('ludy.sign.created_docx_warnings')).toContain(envDetailId);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped']);
  });

  it('isolates list notice visibility, scope attribution, and Open navigation by live userId and sessionId (#4729)', async () => {
    installMemorySessionStorage();
    const setCreateOpen = vi.fn();
    const setCreatedDocxNotice = vi.fn();
    const invalidateEnvelopes = vi.fn(async () => {});
    const navCalls: string[] = [];

    // Verified sessionId lets resolveUserScope fetch user/org before persisting and navigating.
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
        return { orgId: ORG_A_ID, userId: USER_A_ID };
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: async () => {
        resolveOrder.push(`nav:${readCreatedDocxWarnings(envDetailId, SCOPE_USER_A).join(',')}`);
      },
    });
    expect(resolveOrder).toEqual(['resolve', 'nav:ole_objects_skipped']);
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);

    // Anonymous submit missing both userId and sessionId cannot attribute warnings to a post-login resolveUserScope result.
    setCreatedDocxNotice.mockClear();
    const unverifiedNav = vi.fn(async () => {});
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: null,
      resolveUserScope: async () => ({ orgId: ORG_A_ID, userId: USER_B_ID, sessionId: 'sess-b' }),
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(unverifiedNav).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_B)).toEqual([]);

    // Leaving list page after createEnvelope still invalidates and persists for the verified session, while suppressing stale UI updates.
    setCreateOpen.mockClear();
    setCreatedDocxNotice.mockClear();
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: ORG_A_ID,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-a',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(setCreateOpen).not.toHaveBeenCalled();
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    expect(unverifiedNav).not.toHaveBeenCalled();
    expect(invalidateEnvelopes).toHaveBeenCalledTimes(1);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped']);
    clearCreatedDocxWarnings(envDetailId, SCOPE_USER_A);

    // Session mismatch in flight while page was left never persists warnings into sessionStorage.
    invalidateEnvelopes.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: ORG_A_ID,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-b',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);

    // Mismatched userId from resolveUserScope never adopts fetched orgId or persists warnings.
    setCreatedDocxNotice.mockClear();
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      resolveUserScope: async () => ({ orgId: '01900000-0000-7000-8000-0000000000b1', userId: USER_B_ID }),
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(setCreatedDocxNotice).toHaveBeenLastCalledWith(null);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);
    expect(readCreatedDocxWarnings(envDetailId, { org: '01900000-0000-7000-8000-0000000000b1', userId: USER_B_ID })).toEqual([]);

    // Knowing userId without orgId holds on list page instead of writing under slug.
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: unverifiedNav,
    });
    expect(unverifiedNav).not.toHaveBeenCalled();
    expect(readCreatedDocxWarnings(envDetailId, { org: 'acme', userId: USER_A_ID })).toEqual([]);

    // Open verifies account/session before persisting, aborts cleanly on mid-flight dismissal, and rejects session mismatch.
    const unpersistedNotice = {
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      warnings: ['images_skipped'] as const,
    };
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: USER_B_ID,
        setCreatedDocxNotice,
        navigateToEnvelope: unverifiedNav,
      }),
    ).toBe(false);
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, userId: null },
        currentUserId: USER_B_ID,
        resolveCurrentSessionId: async () => 'sess-b',
        setCreatedDocxNotice,
        navigateToEnvelope: unverifiedNav,
      }),
    ).toBe(false);
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, userId: null, sessionId: null },
        currentUserId: USER_B_ID,
        setCreatedDocxNotice,
        navigateToEnvelope: unverifiedNav,
      }),
    ).toBe(false);

    let dismissedMidFlight = false;
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: USER_A_ID,
        resolveCurrentSessionId: async () => 'sess-a',
        resolveUserScope: async () => {
          dismissedMidFlight = true;
          return { orgId: ORG_A_ID, userId: USER_A_ID };
        },
        isCurrentContext: () => !dismissedMidFlight,
        setCreatedDocxNotice,
        navigateToEnvelope: unverifiedNav,
      }),
    ).toBe(false);
    let sessionCallCount = 0;
    let dismissedOnFinal = false;
    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: { ...unpersistedNotice, orgId: ORG_A_ID },
        currentUserId: USER_A_ID,
        resolveCurrentSessionId: async () => {
          if (++sessionCallCount === 2) dismissedOnFinal = true;
          return 'sess-a';
        },
        isCurrentContext: () => !dismissedOnFinal,
        setCreatedDocxNotice,
        navigateToEnvelope: unverifiedNav,
      }),
    ).toBe(false);
    expect(sessionCallCount).toBe(2);
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual([]);

    expect(
      await openCreatedDocxNoticeEnvelope({
        notice: unpersistedNotice,
        currentUserId: USER_A_ID,
        resolveCurrentSessionId: async () => 'sess-a',
        resolveUserScope: async () => ({ orgId: ORG_A_ID, userId: USER_A_ID }),
        setCreatedDocxNotice,
        navigateToEnvelope: async (navSlug, navId) => {
          navCalls.push(`${navSlug}:${navId}:${readCreatedDocxWarnings(envDetailId, SCOPE_USER_A).join(',')}`);
        },
      }),
    ).toBe(true);
    expect(navCalls).toEqual([`acme:${envDetailId}:images_skipped`]);

    const anonSessionNotice = {
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      warnings: ['images_skipped'] as const,
    };
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', USER_B_ID, null)).toBe(false);
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', USER_B_ID, 'sess-b')).toBe(false);
    expect(isCreatedDocxListNoticeVisible({ ...anonSessionNotice, sessionId: null }, 'acme', USER_B_ID, 'sess-a')).toBe(false);
    expect(isCreatedDocxListNoticeVisible(anonSessionNotice, 'acme', USER_A_ID, 'sess-a')).toBe(true);
    const userScopedSessionNotice = {
      ...anonSessionNotice,
      userId: USER_A_ID,
      envelopeTitle: 'Secret Hợp đồng A',
    };
    expect(isCreatedDocxListNoticeVisible(userScopedSessionNotice, 'acme', USER_A_ID, null)).toBe(false);
    expect(isCreatedDocxListNoticeVisible(userScopedSessionNotice, 'acme', USER_A_ID, 'sess-b')).toBe(false);
    expect(isCreatedDocxListNoticeVisible(userScopedSessionNotice, 'acme', USER_A_ID, 'sess-a')).toBe(true);

    // fetchUserScopeForSession bypasses stale TanStack Query me.get cache and verifies token identity directly.
    queryClient.setQueryData(orpc.me.get.queryKey(), {
      userId: USER_A_ID,
      email: 'a@example.com',
      displayName: 'User A',
      orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    const jwtB = makeTestJwt('sess-b');
    vi.mocked(accessToken).mockImplementation(async () => jwtB);
    const seenRpcHeaders: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const hdrs = new Headers(input instanceof Request ? input.headers : init?.headers);
        seenRpcHeaders.push(hdrs.get('authorization') ?? '');
        return new Response(
          JSON.stringify({
            json: { userId: USER_B_ID, orgs: [{ orgId: ORG_A_ID, slug: 'acme', name: 'Acme', role: 'member' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const isolatedScope = await fetchUserScopeForSession('acme', 'sess-b');
    expect(isolatedScope).toEqual({ orgId: ORG_A_ID, userId: USER_B_ID, sessionId: 'sess-b' });
    expect(seenRpcHeaders[0]).toBe(`Bearer ${jwtB}`);
  });

  it('pins orgSlug and verifies session consistency across capture, upload, and envelope creation (#4729)', async () => {
    const samplePdf = makeTestFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'hop-dong.pdf', 'application/pdf');
    const uploadCalls: Array<{ name: string; orgSlug: string | null | undefined }> = [];
    const createCalls: Array<{ sourceFileId: string; orgSlug: string | null | undefined }> = [];
    let liveOrgSlug = 'org-a';

    const pinnedOutcome = await submitCreateEnvelopeFromDialog({
      title: 'Hop dong A',
      file: samplePdf,
      converted: null,
      orgSlug: 'org-a',
      resolveSubmitContext: async () => ({
        slug: 'org-a',
        orgId: ORG_A_ID,
        userId: USER_A_ID,
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

    // Switching org mid-flight aborts before upload and before create.
    uploadCalls.length = 0;
    createCalls.length = 0;
    liveOrgSlug = 'org-a';
    expect(
      await submitCreateEnvelopeFromDialog({
        title: 'Stale org',
        file: samplePdf,
        converted: null,
        orgSlug: 'org-a',
        resolveSubmitContext: async () => {
          liveOrgSlug = 'org-b';
          return { slug: 'org-a', orgId: ORG_A_ID, userId: USER_A_ID, sessionId: 'sess-a', reqId: 1 };
        },
        isMounted: () => true,
        isSubmitContextCurrent: (ctx) => ctx.slug === liveOrgSlug,
        getLiveOrgSlug: () => liveOrgSlug,
        docxRequiredMessage: 'PDF required',
        uploadPdf: async () => ({ fileId: 'unused' }),
        createEnvelope: async () => ({ envelopeId: 'unused' }),
      }),
    ).toEqual({ cancelled: true });

    liveOrgSlug = 'org-a';
    expect(
      await submitCreateEnvelopeFromDialog({
        title: 'Switched during upload',
        file: samplePdf,
        converted: null,
        orgSlug: 'org-a',
        resolveSubmitContext: async () => ({
          slug: 'org-a',
          orgId: ORG_A_ID,
          userId: USER_A_ID,
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
          return { fileId: 'file-switched' };
        },
        createEnvelope: async (input, slugArg) => {
          createCalls.push({ sourceFileId: input.sourceFileId, orgSlug: slugArg });
          return { envelopeId: 'should-not-create' };
        },
      }),
    ).toEqual({ cancelled: true });
    expect(createCalls).toEqual([]);

    // Swapping session (sess-a -> sess-b OR null -> sess-new) during capture marks sessionChanged and aborts.
    let swapCall = 0;
    const swapped = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 5,
      readSessionId: async () => (swapCall++ === 0 ? 'sess-a' : 'sess-b'),
      resolveScope: async () => null,
    });
    expect(swapped.sessionChanged).toBe(true);

    let loginCall = 0;
    const loggedInMid = await captureEnvelopeSubmitContext({
      slug: 'acme',
      reqId: 7,
      readSessionId: async () => (loginCall++ === 0 ? null : 'sess-new'),
      resolveScope: async () => ({ orgId: ORG_A_ID, userId: USER_A_ID, sessionId: 'sess-new' }),
    });
    expect(loggedInMid.sessionChanged).toBe(true);

    // Org switch while readSessionId awaits is re-checked synchronously before uploadPdf runs.
    liveOrgSlug = 'org-a';
    uploadCalls.length = 0;
    expect(
      await submitCreateEnvelopeFromDialog({
        title: 'Org switched during readSessionId',
        file: samplePdf,
        converted: null,
        orgSlug: 'org-a',
        resolveSubmitContext: async () => ({
          slug: 'org-a',
          orgId: ORG_A_ID,
          userId: USER_A_ID,
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
          return { fileId: 'unused' };
        },
        createEnvelope: async () => ({ envelopeId: 'unused' }),
      }),
    ).toEqual({ cancelled: true });
    expect(uploadCalls).toEqual([]);

    // Converted .docx with warnings rejects before createEnvelope when neither userId nor sessionId can be proved.
    const docxFile = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'hd.docx', SIGN_DOCX_MIME);
    await expect(
      submitCreateEnvelopeFromDialog({
        title: 'Unverified docx warnings',
        file: docxFile,
        converted: {
          status: 'completed',
          fileId: 'file-docx-1',
          sourceDocxSha256: 'd'.repeat(64),
          filename: 'hd.pdf',
          pageCount: 1,
          warnings: ['images_skipped'],
        },
        orgSlug: 'acme',
        resolveSubmitContext: async () => ({ slug: 'acme', orgId: null, userId: null, sessionId: null, reqId: 6 }),
        isMounted: () => true,
        getLiveOrgSlug: () => 'acme',
        docxRequiredMessage: 'PDF required',
        verifyIdentityErrorMessage: 'Retry identity verification',
        uploadPdf: async () => ({ fileId: 'unused' }),
        createEnvelope: async () => ({ envelopeId: 'should-not-create' }),
      }),
    ).rejects.toThrow('Retry identity verification');
  });

  it('preserves pending notices across navigations, routes ContractVaultBar pending links cleanly, and skips me.get on PDF submits (#4729)', async () => {
    const resolveScopeSpy = vi.fn(async () => ({ orgId: ORG_A_ID, userId: USER_A_ID, sessionId: 'sess-a' }));
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

    // Cross-navigation pending list notice store keeps remaining notices after opening another envelope and clears on sign-out/user change.
    upsertPendingDocxListNotice({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      envelopeTitle: 'Hợp đồng A',
      warnings: ['images_skipped'],
    });
    upsertPendingDocxListNotice({
      envelopeId: SECOND_ENV_ID,
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      envelopeTitle: 'Hợp đồng B',
      warnings: ['footnotes_skipped'],
    });
    removePendingDocxListNotice(envDetailId);
    expect(listPendingDocxListNotices('acme', USER_A_ID).map((n) => n.envelopeId)).toEqual([SECOND_ENV_ID]);
    expect(listPendingDocxListNotices('acme', USER_B_ID)).toEqual([]);
    clearPendingDocxListNotices({ mismatchSessionId: 'sess-b' });
    expect(listPendingDocxListNotices('acme', USER_A_ID)).toEqual([]);

    // Handle creation preserves unpersisted A alongside unpersisted B and clean PDF C without navigating away.
    const setCreateOpen = vi.fn();
    const setCreatedDocxNotice = vi.fn();
    const invalidateEnvelopes = vi.fn(async () => {});
    const navSpy = vi.fn(async () => {});
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
      envelopeId: SECOND_ENV_ID,
      warnings: ['footnotes_skipped'],
      slug: 'acme',
      orgId: null,
      userId: null,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => null,
      hasOtherPendingNotice: () => pendingList.some((n) => n.envelopeId !== SECOND_ENV_ID),
      onPendingNoticeAction: (action) => {
        pendingList = applyPendingDocxNoticeUpdate(pendingList, action);
      },
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: navSpy,
    });
    const pdfEnvId = '01900000-0000-7000-8000-0000000000ef';
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
      navigateToEnvelope: navSpy,
    });
    expect(pendingList.map((n) => n.envelopeId)).toEqual([SECOND_ENV_ID, envDetailId]);
    expect(navSpy).not.toHaveBeenCalled();

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
  });

  it('aborts UPLOAD_BUSY uploadSignPdf retries on verified session switch and surfaces retry error on auth read failures (#4729)', async () => {
    const samplePdf = makeTestFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'hop-dong.pdf', 'application/pdf');
    const jwtA = makeTestJwt('sess-a');
    const jwtB = makeTestJwt('sess-b');

    // Auth refresh failure returning { session: null, error } throws SignSessionUnverifiedError without sending an HTTP request.
    vi.mocked(auth).mockImplementation(
      () =>
        ({
          getSession: async () => ({ data: { session: null }, error: new Error('refresh timeout') }),
        }) as unknown as ReturnType<typeof auth>,
    );
    const noSendFetch = vi.fn();
    vi.stubGlobal('fetch', noSendFetch);
    await expect(readVerifiedSession()).rejects.toBeInstanceOf(SignSessionUnverifiedError);
    await expect(uploadSignPdf(samplePdf, 'acme', null)).rejects.toBeInstanceOf(SignSessionUnverifiedError);
    expect(noSendFetch).not.toHaveBeenCalled();

    // Transient readSessionId error during dialog submit surfaces verifyIdentityErrorMessage instead of cancelling silently.
    await expect(
      submitCreateEnvelopeFromDialog({
        title: 'Transient readSessionId fail',
        file: samplePdf,
        converted: null,
        orgSlug: 'acme',
        resolveSubmitContext: async () => ({
          slug: 'acme',
          orgId: null,
          userId: null,
          sessionId: 'sess-a',
          reqId: 9,
        }),
        readSessionId: async () => {
          throw new Error('session unavailable');
        },
        isMounted: () => true,
        getLiveOrgSlug: () => 'acme',
        docxRequiredMessage: 'PDF required',
        verifyIdentityErrorMessage: 'Retry identity verification',
        uploadPdf: async () => ({ fileId: 'unused' }),
        createEnvelope: async () => ({ envelopeId: 'unused' }),
      }),
    ).rejects.toThrow('Retry identity verification');

    // uploadSignPdf aborts UPLOAD_BUSY retry before sending attempt #2 if live session token switched from sess-a to sess-b.
    vi.mocked(auth).mockReset();
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

  it('persists unpersisted pending warnings on unmount and promotes them cleanly on detail navigation (#4729)', async () => {
    installMemorySessionStorage();
    clearPendingDocxListNotices();
    const setCreateOpen = vi.fn();
    const setCreatedDocxNotice = vi.fn();
    const invalidateEnvelopes = vi.fn(async () => {});
    const navSpy = vi.fn(async () => {});

    // Leaving list page mid-invalidation before orgId resolves still saves pending notice in module store.
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: envDetailId,
      envelopeTitle: 'Hợp đồng pending',
      warnings: ['images_skipped'],
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-a',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: navSpy,
    });
    expect(setCreatedDocxNotice).not.toHaveBeenCalled();
    const savedPending = readPendingDocxListNotice(envDetailId, 'acme');
    expect(savedPending).toEqual({
      envelopeId: envDetailId,
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      envelopeTitle: 'Hợp đồng pending',
      warnings: ['images_skipped'],
    });

    // Session mismatch on direct detail open drops A's pending warning without promoting to B.
    expect(
      await resolveDetailPendingDocxWarnings({
        envelopeId: envDetailId,
        slug: 'acme',
        noticeOrg: ORG_A_ID,
        currentUserId: USER_B_ID,
        pendingNotice: savedPending,
        resolveCurrentSessionId: async () => 'sess-b',
      }),
    ).toBeNull();
    expect(readPendingDocxListNotice(envDetailId, 'acme')).toBeNull();
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_B)).toEqual([]);

    // Valid matching session on direct detail open resolves scope even if cached currentUserId is stale and promotes cleanly.
    upsertPendingDocxListNotice(savedPending!);
    const promoted = await resolveDetailPendingDocxWarnings({
      envelopeId: envDetailId,
      slug: 'acme',
      noticeOrg: null,
      currentUserId: USER_B_ID,
      pendingNotice: readPendingDocxListNotice(envDetailId, 'acme'),
      resolveCurrentSessionId: async () => 'sess-a',
      resolveUserScope: async (expectedSessionId) => {
        expect(expectedSessionId).toBe('sess-a');
        return { orgId: ORG_A_ID, userId: USER_A_ID, sessionId: 'sess-a' };
      },
    });
    expect(promoted).toEqual({
      warnings: ['images_skipped'],
      org: ORG_A_ID,
      userId: USER_A_ID,
    });
    expect(readPendingDocxListNotice(envDetailId, 'acme')).toBeNull();
    expect(readCreatedDocxWarnings(envDetailId, SCOPE_USER_A)).toEqual(['images_skipped']);

    // Session mismatch during mid-flight unmount also purges prior pending notices from module store.
    upsertPendingDocxListNotice(savedPending!);
    await handleEnvelopeCreatedWithWarnings({
      envelopeId: SECOND_ENV_ID,
      warnings: ['footnotes_skipped'],
      slug: 'acme',
      orgId: null,
      userId: USER_A_ID,
      sessionId: 'sess-a',
      resolveCurrentSessionId: async () => 'sess-b',
      isCurrentContext: () => false,
      setCreateOpen,
      setCreatedDocxNotice,
      invalidateEnvelopes,
      navigateToEnvelope: navSpy,
    });
    expect(readPendingDocxListNotice(envDetailId, 'acme')).toBeNull();
    expect(readPendingDocxListNotice(SECOND_ENV_ID, 'acme')).toBeNull();
  });
});
