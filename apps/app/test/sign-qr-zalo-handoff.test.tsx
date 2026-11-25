// SPDX-License-Identifier: AGPL-3.0-only
// Component, accessibility, security, and polling tests for eSign Slice 6a (#4720):
//   - safeQrSvgPath & SignQrModal (SVG QR + quiet zone, >271-byte fallback, zero query tokens, 44px targets, close/focus wiring)
//   - SignZaloHandoffPanel (social flag, strict hr_contract/meeting_minutes exclusion, 48h window check, CRM thread merge, zero ZNS)
//   - SignEnvelopeDetailPage (QR triggers on minted-zalo-links-card and in-person modal ?in_person=1#<token>, Zalo handoff gating)
//   - SignCeremonyPage & startCeremonyQrPolling (ready && !isInPerson gating, hidden on otp_required/terminal/inPerson, 4s polling)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode, type RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { QR_MAX_UTF8_BYTES, safeQrSvgPath } from '../src/lib/qr-svg.ts';
import { putReplyHandoff, takeReplyHandoff } from '../src/lib/reply-handoff.ts';
import { PublicSignError, type PublicSignViewState, type SignSignerRecord } from '../src/lib/sign-api.ts';
import { buildInPersonSigningUrl, buildSigningUrl } from '../src/lib/sign-hash.ts';

const envId = '01900000-0000-7000-8000-000000000401';
const creatorId = '01900000-0000-7000-8000-000000000402';

const runtimeState = vi.hoisted(() => ({
  modules: ['kernel', 'sign', 'social', 'crm'] as string[],
  dialogHandlers: [] as Array<{
    onOpenChange?: ((open: boolean) => void) | undefined;
    finalFocus?: RefObject<HTMLElement | null> | undefined;
  }>,
  qc: null as unknown as QueryClient,
  navigate: vi.fn(),
}));

vi.mock('@ludy/ui/components/dialog', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      if (!open) return null;
      runtimeState.dialogHandlers.push({ onOpenChange });
      return createElement('div', { 'data-slot': 'dialog', 'data-open': 'true' }, children);
    },
    DialogTrigger: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-slot': 'dialog-trigger' }, children),
    DialogClose: ({ children }: { children?: ReactNode }) => createElement('button', { type: 'button', 'data-slot': 'dialog-close' }, children),
    DialogOverlay: () => null,
    DialogPortal: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'dialog-portal' }, children),
    DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'dialog-header' }, children),
    DialogFooter: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'dialog-footer' }, children),
    DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h2', { 'data-slot': 'dialog-title' }, children),
    DialogDescription: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-slot': 'dialog-description' }, children),
    DialogContent: ({
      closeLabel,
      finalFocus,
      children,
      ...rest
    }: {
      closeLabel: string;
      finalFocus?: RefObject<HTMLElement | null>;
      children?: ReactNode;
      [k: string]: unknown;
    }) => {
      const last = runtimeState.dialogHandlers[runtimeState.dialogHandlers.length - 1];
      if (last) last.finalFocus = finalFocus;
      return createElement(
        'div',
        { role: 'dialog', 'aria-modal': 'true', 'data-close-label': closeLabel, ...rest },
        children,
        createElement('button', { type: 'button', 'aria-label': closeLabel, className: 'min-h-11' }, 'x'),
      );
    },
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '') }, children),
    useParams: () => ({ slug: 'acme', id: envId }),
    useNavigate: () => runtimeState.navigate,
  };
});

vi.mock('../src/lib/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: () => ({ modules: runtimeState.modules }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  runtimeState.qc = new QC({ defaultOptions: { queries: { retry: false } } });
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
    queryClient: runtimeState.qc,
    client: {},
    getCurrentOrg: () => 'acme',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { SignQrModal } = await import('../src/components/sign/sign-qr-modal.tsx');
const { SignZaloHandoffPanel } = await import('../src/components/sign/sign-zalo-handoff-panel.tsx');
const { InPersonSessionBody, MintedZaloLinksCard, SignEnvelopeDetailPage } = await import(
  '../src/routes/sign-envelope-detail.tsx'
);
const {
  CEREMONY_QR_POLL_INTERVAL_MS,
  CEREMONY_QR_POLL_MAX_MS,
  SignCeremonyPage,
  SignCeremonyQrEndedCard,
  SignCeremonyReadyView,
  canShowCeremonyQrHandoff,
  startCeremonyQrPolling,
} = await import('../src/routes/sign-ceremony.tsx');

function renderLocale(node: ReactNode, locale: 'vi' | 'en' = 'vi', qc = runtimeState.qc): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
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

const SAMPLE_TOKEN = 'Z'.repeat(43);

const SAMPLE_SIGNER: SignSignerRecord = {
  id: '01900000-0000-7000-8000-000000000411',
  routingOrder: 1,
  signerRole: 'signer',
  roleLabel: 'Bên B',
  name: 'Nguyễn Thị Lan',
  email: 'lan@example.vn',
  phone: '0901234567',
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
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T00:00:00.000Z',
};

const BASE_ENVELOPE = {
  id: envId,
  title: 'Hợp đồng cung cấp phần mềm 2026',
  subject: null,
  message: null,
  status: 'sent' as const,
  routingMode: 'parallel' as const,
  sourceKind: 'standalone' as const,
  sourceId: null,
  sourceFileId: '01900000-0000-7000-8000-000000000499',
  sourceSha256: 'a'.repeat(64),
  inspectStatus: 'passed' as const,
  inspectError: null,
  pageCount: 1,
  pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
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
  expiresAt: '2027-12-31T00:00:00.000Z',
  autoRemindBeforeExpiry: true,
  sentAt: '2026-11-24T01:00:00.000Z',
  completedAt: null,
  declinedAt: null,
  declineAcknowledgedAt: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  expiredAt: null,
  version: 2,
  createdBy: creatorId,
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T01:00:00.000Z',
};

describe('QR Scan-to-Sign & Zalo OA Engage Handoff (Slice 6a, #4720)', () => {
  beforeEach(() => {
    runtimeState.modules = ['kernel', 'sign', 'social', 'crm'];
    runtimeState.dialogHandlers = [];
    runtimeState.qc.clear();
    runtimeState.navigate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('handles URLs <= 271 and > 271 UTF-8 bytes cleanly in safeQrSvgPath without throwing', () => {
    const normalUrl = buildSigningUrl(SAMPLE_TOKEN, 'https://app.ludy.vn');
    const okRes = safeQrSvgPath(normalUrl, 4);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.d.startsWith('M')).toBe(true);
      expect(okRes.viewBox).toBe(`0 0 ${okRes.size} ${okRes.size}`);
      expect(okRes.byteLength).toBeLessThanOrEqual(QR_MAX_UTF8_BYTES);
    }

    const tooLongUrl = `https://very-long-tenant-domain.example.vn/-/sign?in_person=1&extra=${'x'.repeat(230)}#${SAMPLE_TOKEN}`;
    const tooLongRes = safeQrSvgPath(tooLongUrl, 4);
    expect(tooLongRes.ok).toBe(false);
    if (!tooLongRes.ok) {
      expect(tooLongRes.reason).toBe('too_long');
      expect(tooLongRes.byteLength).toBeGreaterThan(QR_MAX_UTF8_BYTES);
    }

    const emptyRes = safeQrSvgPath('', 4);
    expect(emptyRes).toEqual({ ok: false, reason: 'empty', byteLength: 0, maxBytes: QR_MAX_UTF8_BYTES });
  });

  it('renders SignQrModal with offline SVG QR, quiet zone, >= 44px controls, ESC/focus-return wiring, and >271 byte fallback', () => {
    const signingUrl = buildSigningUrl(SAMPLE_TOKEN, 'https://app.ludy.vn');
    const focusSpy = vi.fn();
    const triggerRef = { current: { isConnected: true, focus: focusSpy } as unknown as HTMLButtonElement };
    const onOpenChange = vi.fn();
    const html = renderLocale(
      <SignQrModal
        open
        onOpenChange={onOpenChange}
        title={viMessages.sign.qrHandoff.ceremonyModalTitle}
        description={viMessages.sign.qrHandoff.ceremonyModalDescription}
        url={signingUrl}
        statusNotice={viMessages.sign.qrHandoff.ceremonyPollingNotice}
        triggerRef={triggerRef}
      />,
      'vi',
    );

    expect(html).toContain('data-testid="sign-qr-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="sign-qr-modal-svg"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).not.toContain('<img');
    expect(html).toContain('min-h-11');
    expect(html).toContain(signingUrl);
    expect(signingUrl.split('#')[0]).not.toContain(SAMPLE_TOKEN);
    assertPairedLabels(html);
    expect(runtimeState.dialogHandlers[0]?.finalFocus).toBe(triggerRef);

    // Invoking dialog close (e.g. Escape key) calls onOpenChange(false) and restores focus to triggerRef
    vi.useFakeTimers();
    const setTimeoutSpy = vi.fn((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.stubGlobal('window', { setTimeout: setTimeoutSpy });
    runtimeState.dialogHandlers[0]?.onOpenChange?.(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    // >271 UTF-8 byte fallback renders gracefully instead of throwing
    const oversizedUrl = `https://${'a'.repeat(240)}.example.vn/-/sign#${SAMPLE_TOKEN}`;
    const fallbackHtml = renderLocale(
      <SignQrModal
        open
        onOpenChange={() => {}}
        title={en.sign.qrHandoff.ceremonyModalTitle}
        url={oversizedUrl}
      />,
      'en',
    );
    expect(fallbackHtml).toContain('data-testid="sign-qr-modal-fallback"');
    expect(fallbackHtml).not.toContain('data-testid="sign-qr-modal-svg"');
    expect(fallbackHtml).toContain('data-testid="sign-qr-modal-copy-btn"');
  });

  it('renders SignZaloHandoffPanel with direct zalo_oa threads, 48h window guard, and hides for !social or hr_contract/meeting_minutes', () => {
    const seedConversationData = (allowed: boolean, reason: string | null = null, replyWindowUntil: string | null = null) => {
      runtimeState.qc.setQueryData(['conversations', 'list', { kind: 'direct', limit: 100 }], {
        conversations: [
          {
            id: 'thread-zalo-1',
            kind: 'direct',
            status: 'new',
            channel: { connectionId: 'ch-1', provider: 'zalo_oa', displayName: 'Zalo OA Công ty' },
            postId: null,
            contact: { identityId: null, displayName: 'Chị Lan Zalo', idTail: '9988', partyId: null, partyName: 'Nguyễn Thị Lan' },
            assigneeUserId: null,
            lastSeq: 3,
            lastMessageAt: '2026-11-24T10:00:00.000Z',
            lastInboundAt: '2026-11-24T10:00:00.000Z',
            replyWindowUntil,
            preview: 'Gửi giúp em hợp đồng nhé',
            unread: true,
            composing: [],
            intent: null,
          },
        ],
        more: false,
      });
      runtimeState.qc.setQueryData(['conversations', 'get', { conversationId: 'thread-zalo-1' }], {
        conversation: {
          id: 'thread-zalo-1',
          kind: 'direct',
          status: 'new',
          channel: { connectionId: 'ch-1', provider: 'zalo_oa', displayName: 'Zalo OA Công ty' },
          postId: null,
          contact: { identityId: null, displayName: 'Chị Lan Zalo', idTail: '9988', partyId: null, partyName: 'Nguyễn Thị Lan' },
          assigneeUserId: null,
          lastSeq: 3,
          lastMessageAt: '2026-11-24T10:00:00.000Z',
          lastInboundAt: '2026-11-24T10:00:00.000Z',
          replyWindowUntil,
          preview: 'Gửi giúp em hợp đồng nhé',
          unread: true,
          composing: [],
          intent: null,
        },
        messages: [],
        notes: [],
        parentId: null,
        reply: { allowed, reason },
        gap: null,
        draft: null,
        suggestions: [],
        others: [],
      });
    };

    // Open 48h window -> enabled button & deterministic Vietnamese draft preview
    seedConversationData(true, null, '2099-01-01T00:00:00.000Z');
    const openHtml = renderLocale(
      <SignZaloHandoffPanel
        envelope={BASE_ENVELOPE}
        signers={[SAMPLE_SIGNER]}
        canManageLinks
        mintedLinks={[{ signerId: SAMPLE_SIGNER.id, url: buildSigningUrl(SAMPLE_TOKEN, 'https://app.ludy.vn') }]}
      />,
      'vi',
    );
    expect(openHtml).toContain('data-testid="sign-zalo-handoff"');
    expect(openHtml).toContain('Nguyễn Thị Lan (Zalo OA Công ty)');
    expect(openHtml).toContain(`https://app.ludy.vn/-/sign#${SAMPLE_TOKEN}`);
    expect(openHtml).toContain('data-testid="sign-zalo-open"');
    expect(openHtml).not.toMatch(/data-testid="sign-zalo-open"[^>]*disabled=""|disabled=""[^>]*data-testid="sign-zalo-open"/);
    assertPairedLabels(openHtml);

    // Closed 48h window -> disabled button + reason
    seedConversationData(false, 'window_closed', '2020-01-01T00:00:00.000Z');
    const closedHtml = renderLocale(
      <SignZaloHandoffPanel
        envelope={BASE_ENVELOPE}
        signers={[SAMPLE_SIGNER]}
        canManageLinks
        mintedLinks={[]}
      />,
      'vi',
    );
    expect(closedHtml).toContain('data-testid="sign-zalo-closed"');
    expect(closedHtml).toContain(viMessages.conversations.replyBlocked.window_closed);
    expect(closedHtml).toMatch(/disabled=""[^>]*data-testid="sign-zalo-open"|data-testid="sign-zalo-open"[^>]*disabled=""/);

    // Worst-case signing URL length budget guard disables Open and surfaces tooLong when origin + fragment > 2000
    seedConversationData(true, null, '2099-01-01T00:00:00.000Z');
    vi.stubGlobal('window', {
      location: { origin: `https://${'a'.repeat(1800)}.example.vn` },
    });
    const overBudgetHtml = renderLocale(
      <SignZaloHandoffPanel
        envelope={BASE_ENVELOPE}
        signers={[SAMPLE_SIGNER]}
        canManageLinks
        mintedLinks={[]}
      />,
      'vi',
    );
    expect(overBudgetHtml).toContain(viMessages.sign.zaloHandoff.urlPlaceholder);
    expect(overBudgetHtml).toContain(viMessages.sign.zaloHandoff.tooLong);
    expect(overBudgetHtml).toContain('text-destructive');
    expect(overBudgetHtml).toMatch(/disabled=""[^>]*data-testid="sign-zalo-open"|data-testid="sign-zalo-open"[^>]*disabled=""/);
    vi.unstubAllGlobals();

    // Confidential sourceKinds & missing social module strictly return null
    expect(
      renderLocale(
        <SignZaloHandoffPanel
          envelope={{ ...BASE_ENVELOPE, sourceKind: 'hr_contract' }}
          signers={[SAMPLE_SIGNER]}
          canManageLinks
          mintedLinks={[]}
        />,
        'vi',
      ),
    ).toBe('');
    expect(
      renderLocale(
        <SignZaloHandoffPanel
          envelope={{ ...BASE_ENVELOPE, sourceKind: 'meeting_minutes' }}
          signers={[SAMPLE_SIGNER]}
          canManageLinks
          mintedLinks={[]}
        />,
        'vi',
      ),
    ).toBe('');

    runtimeState.modules = ['kernel', 'sign'];
    expect(
      renderLocale(
        <SignZaloHandoffPanel
          envelope={BASE_ENVELOPE}
          signers={[SAMPLE_SIGNER]}
          canManageLinks
          mintedLinks={[]}
        />,
        'vi',
      ),
    ).toBe('');
  });

  it('stores Zalo draft in sessionStorage via putReplyHandoff (never in URL address) and integrates on SignEnvelopeDetailPage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });

    const draftText = `Mời Anh/Chị ký tại: https://app.ludy.vn/-/sign#${SAMPLE_TOKEN}`;
    expect(putReplyHandoff('thread-zalo-1', draftText, 1000)).toBe(true);
    expect(takeReplyHandoff('thread-zalo-1', 2000)).toBe(draftText);
    expect(takeReplyHandoff('thread-zalo-1', 2000)).toBeNull();

    // SignEnvelopeDetailPage shows SignZaloHandoffPanel for standalone sent envelope when social is installed,
    // and hides it for hr_contract / meeting_minutes envelopes.
    runtimeState.qc.setQueryData(['me', 'get'], {
      userId: creatorId,
      email: 'creator@example.vn',
      displayName: 'Creator',
      orgs: [{ orgId: '01900000-0000-7000-8000-000000000455', slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    runtimeState.qc.setQueryData(['sign', 'envelope', envId], {
      envelope: BASE_ENVELOPE,
      signers: [SAMPLE_SIGNER],
      fields: [],
    });
    const detailHtml = renderLocale(<SignEnvelopeDetailPage />, 'vi');
    expect(detailHtml).toContain('data-testid="sign-zalo-handoff"');

    runtimeState.qc.setQueryData(['sign', 'envelope', envId], {
      envelope: { ...BASE_ENVELOPE, sourceKind: 'hr_contract' as const },
      signers: [SAMPLE_SIGNER],
      fields: [],
    });
    expect(renderLocale(<SignEnvelopeDetailPage />, 'vi')).not.toContain('data-testid="sign-zalo-handoff"');

    // MintedZaloLinksCard renders QR trigger button per minted link
    const mintedUrl = buildSigningUrl(SAMPLE_TOKEN, 'https://app.ludy.vn');
    const mintedHtml = renderLocale(
      <MintedZaloLinksCard
        mintedLinks={[{ signerId: SAMPLE_SIGNER.id, url: mintedUrl }]}
        signers={[SAMPLE_SIGNER]}
        onOpenQr={() => {}}
      />,
      'vi',
    );
    expect(mintedHtml).toContain('data-testid="minted-zalo-links-card"');
    expect(mintedHtml).toContain(`data-testid="zalo-link-qr-btn-${SAMPLE_SIGNER.id}"`);
    expect(mintedHtml).toContain('min-h-11');
    assertPairedLabels(mintedHtml);

    // In-person session modal includes QR trigger and isolated ?in_person=1#<token> QR modal
    const inPersonUrl = buildInPersonSigningUrl(SAMPLE_TOKEN, 'https://app.ludy.vn');
    expect(inPersonUrl).toBe(`https://app.ludy.vn/-/sign?in_person=1#${SAMPLE_TOKEN}`);
    expect(inPersonUrl.split('#')[0]).not.toContain(SAMPLE_TOKEN);
    const inPersonRef = createRef<HTMLButtonElement>();
    const inPersonHtml = renderLocale(
      <InPersonSessionBody
        session={{
          signerId: SAMPLE_SIGNER.id,
          signerName: SAMPLE_SIGNER.name,
          url: inPersonUrl,
          expiresAt: '2026-11-24T12:30:00.000Z',
        }}
        qrOpen
        onQrOpenChange={() => {}}
        qrTriggerRef={inPersonRef}
      />,
      'vi',
    );
    expect(inPersonHtml).toContain('data-testid="in-person-qr-btn"');
    expect(inPersonHtml).toContain('data-testid="in-person-qr-modal"');
    expect(inPersonHtml).toContain('data-testid="in-person-qr-modal-svg"');
    expect(inPersonHtml).toContain('data-testid="in-person-qr-modal-in-person-note"');
    expect(inPersonHtml).toContain(inPersonUrl);
    assertPairedLabels(inPersonHtml);
  });

  it('gates ceremony QR button strictly to ready && !isInPerson (hidden on otp_required, terminal states, error, and in-person)', () => {
    const readyView: PublicSignViewState = {
      state: 'ready',
      orgName: 'Công ty Sao Mai',
      title: 'Hợp đồng dịch vụ 2026',
      message: null,
      signerName: 'Nguyễn Thị Lan',
      roleLabel: 'Bên B',
      signerRole: 'signer',
      expiresAt: '2027-01-01T00:00:00.000Z',
      pageCount: 1,
      fields: [],
    };

    expect(canShowCeremonyQrHandoff({ viewState: readyView, isInPerson: false, hasToken: true, viewError: null })).toBe(true);
    expect(canShowCeremonyQrHandoff({ viewState: readyView, isInPerson: true, hasToken: true, viewError: null })).toBe(false);
    expect(canShowCeremonyQrHandoff({ viewState: readyView, isInPerson: false, hasToken: false, viewError: null })).toBe(false);
    expect(canShowCeremonyQrHandoff({ viewState: readyView, isInPerson: false, hasToken: true, viewError: 'error' })).toBe(false);

    for (const blockedState of [
      { state: 'otp_required', orgName: 'Sao Mai', title: 'HD', maskedEmail: 'l***@example.vn' },
      { state: 'waiting_turn', title: 'HD', order: 2 },
      { state: 'already_completed', title: 'HD', status: 'completed' },
      { state: 'declined', title: 'HD', status: 'declined' },
      { state: 'delegated', title: 'HD', delegateName: 'B', maskedDelegateEmail: null },
      { state: 'voided', title: 'HD', status: 'voided' },
      { state: 'expired', title: 'HD', status: 'expired' },
    ] satisfies PublicSignViewState[]) {
      expect(
        canShowCeremonyQrHandoff({ viewState: blockedState, isInPerson: false, hasToken: true, viewError: null }),
      ).toBe(false);
    }

    const commonProps = {
      answers: {},
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
      onPageChange: () => {},
      onScaleChange: () => {},
      onRenderStatusChange: () => {},
      onJumpToNext: () => {},
      onOpenPad: () => {},
      onUpdateAnswer: () => {},
      onConsentChange: () => {},
      onSubmit: () => {},
      onDeclineOpenChange: () => {},
      onDeclineReasonChange: () => {},
      onDeclineSubmit: () => {},
      onOpenQr: () => {},
    };

    const remoteReadyHtml = renderLocale(<SignCeremonyReadyView {...commonProps} viewState={readyView} />, 'vi');
    expect(remoteReadyHtml).toContain('data-testid="ceremony-qr-handoff-btn"');
    expect(remoteReadyHtml).toContain('Ký dễ hơn bằng điện thoại (QR)');
    expect(remoteReadyHtml).toContain('min-h-11');

    const inPersonReadyHtml = renderLocale(
      <SignCeremonyReadyView {...commonProps} viewState={{ ...readyView, inPerson: true }} inPerson />,
      'vi',
    );
    expect(inPersonReadyHtml).not.toContain('ceremony-qr-handoff-btn');

    // Missing/error ceremony screen never exposes QR button
    vi.stubGlobal('window', {
      location: { pathname: '/-/sign', search: '', hash: '' },
      history: { state: null, replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const invalidPageHtml = renderLocale(<SignCeremonyPage />, 'vi');
    expect(invalidPageHtml).not.toContain('ceremony-qr-handoff-btn');
    expect(invalidPageHtml).not.toContain('ceremony-qr-modal');

    // Neutral post-handoff card renders cleanly in vi & en without misleading invalid/expired error copy
    const endedViHtml = renderLocale(<SignCeremonyQrEndedCard title="Hợp đồng dịch vụ 2026" />, 'vi');
    expect(endedViHtml).toContain('data-testid="sign-ceremony-qr-ended"');
    expect(endedViHtml).toContain(viMessages.sign.qrHandoff.qrEndedTitle);
    expect(endedViHtml).toContain('Hợp đồng dịch vụ 2026');
    const endedEnHtml = renderLocale(<SignCeremonyQrEndedCard title="Service Agreement 2026" />, 'en');
    expect(endedEnHtml).toContain('data-testid="sign-ceremony-qr-ended"');
    expect(endedEnHtml).toContain(en.sign.qrHandoff.qrEndedTitle);
  });

  it('polls public view every 4_000 ms while open, pauses when document.hidden, stops on completion or 15 min cap', async () => {
    vi.useFakeTimers();
    let hidden = false;
    const visibilityListeners = new Set<() => void>();
    let callCount = 0;

    const pollView = vi.fn(async () => {
      callCount += 1;
      if (callCount >= 3) {
        return {
          state: 'already_completed',
          title: 'Hợp đồng',
          status: 'completed',
          signerRole: 'signer',
        } satisfies PublicSignViewState;
      }
      return {
        state: 'ready',
        orgName: 'Sao Mai',
        title: 'Hợp đồng',
        message: null,
        signerName: 'Lan',
        roleLabel: 'Bên B',
        signerRole: 'signer',
        expiresAt: '2027-01-01T00:00:00.000Z',
        pageCount: 1,
        fields: [],
      } satisfies PublicSignViewState;
    });

    const onNonReadyState = vi.fn();
    const onNotFound = vi.fn();

    const stop = startCeremonyQrPolling({
      token: SAMPLE_TOKEN,
      pollView,
      onNonReadyState,
      onNotFound,
      isHidden: () => hidden,
      subscribeVisibility: (fn) => {
        visibilityListeners.add(fn);
        return () => {
          visibilityListeners.delete(fn);
        };
      },
    });

    // Tick 1 at 4_000 ms -> ready
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS);
    expect(pollView).toHaveBeenCalledTimes(1);
    expect(onNonReadyState).not.toHaveBeenCalled();

    // Pause while document.hidden === true
    hidden = true;
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS * 2);
    expect(pollView).toHaveBeenCalledTimes(1);

    // Resume on visibilitychange -> immediate check (call #2, still ready)
    hidden = false;
    for (const fn of visibilityListeners) fn();
    await Promise.resolve();
    expect(pollView).toHaveBeenCalledTimes(2);
    expect(onNonReadyState).not.toHaveBeenCalled();

    // Next 4_000 ms tick -> completed (call #3) -> transitions and stops polling
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS);
    expect(pollView).toHaveBeenCalledTimes(3);
    expect(onNonReadyState).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'already_completed', status: 'completed' }),
    );

    // Further ticks do nothing after terminal state
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS * 3);
    expect(pollView).toHaveBeenCalledTimes(3);
    stop();

    // Verify 15-minute cap stops polling even if always ready
    const capPoll = vi.fn(async () => ({
      state: 'ready',
      orgName: 'Sao Mai',
      title: 'Hợp đồng',
      message: null,
      signerName: 'Lan',
      roleLabel: 'Bên B',
      signerRole: 'signer',
      expiresAt: '2027-01-01T00:00:00.000Z',
      pageCount: 1,
      fields: [],
    }) satisfies PublicSignViewState);
    const onTimeout = vi.fn();
    const stopCap = startCeremonyQrPolling({
      token: SAMPLE_TOKEN,
      pollView: capPoll,
      onNonReadyState: vi.fn(),
      onNotFound: vi.fn(),
      onTimeout,
      isHidden: () => false,
      subscribeVisibility: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_MAX_MS - CEREMONY_QR_POLL_INTERVAL_MS);
    const countBeforeCap = capPoll.mock.calls.length;
    expect(countBeforeCap).toBeGreaterThan(200);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS * 5);
    expect(capPoll).toHaveBeenCalledTimes(countBeforeCap);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    stopCap();

    // Verify 404 stops polling cleanly via onNotFound
    const errPoll = vi.fn(async () => {
      throw new PublicSignError(404, 'SIGN_LINK_INVALID');
    });
    const onNotFound404 = vi.fn();
    startCeremonyQrPolling({
      token: SAMPLE_TOKEN,
      pollView: errPoll,
      onNonReadyState: vi.fn(),
      onNotFound: onNotFound404,
      isHidden: () => false,
      subscribeVisibility: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS);
    expect(onNotFound404).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CEREMONY_QR_POLL_INTERVAL_MS * 2);
    expect(errPoll).toHaveBeenCalledTimes(1);
  });

  it('has matching i18n keys in vi and en without em/en dashes', () => {
    expect(Object.keys(viMessages.sign.qrHandoff).sort()).toEqual(Object.keys(en.sign.qrHandoff).sort());
    expect(Object.keys(viMessages.sign.zaloHandoff).sort()).toEqual(Object.keys(en.sign.zaloHandoff).sort());
  });
});
