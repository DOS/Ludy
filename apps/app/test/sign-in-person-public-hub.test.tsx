// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR component tests for eSign Slice 4d (#3820):
//   - Isolated in-person ceremony URL helpers and post-sign handoff lock card (zero workspace links)
//   - SignerPanel in-person trigger button on active due signers/approvers (never CC or waiting)
//   - DirectLinkCard listedOnPublicHub toggle and copyable organization public hub URL with paired labels
//   - SignPublicHubDirectory and SignPublicHubPage bilingual vi/en rendering with >= 44px (min-h-11) mobile targets
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignMemberSignatureItem, SignOrgStampItem, SignSignerRecord, SignTemplateDetail } from '../src/lib/sign-api.ts';
import {
  buildInPersonSigningUrl,
  buildPublicHubUrl,
  hasInPersonQueryFlag,
  SIGN_PAGE_PATH,
  SIGN_PUBLIC_HUB_PAGE_PREFIX,
} from '../src/lib/sign-hash.ts';

const routerState = vi.hoisted(() => ({
  orgSlug: 'cong-ty-sao-mai',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ orgSlug: routerState.orgSlug }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    getCurrentOrg: () => 'cong-ty-sao-mai',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { SignInPersonHandoffCard, SignCeremonyPage, SignCeremonyReadyView, bindCeremonyWorkspaceProfileSync } = await import(
  '../src/routes/sign-ceremony.tsx'
);
const { ensureCeremonyStorageSignedOutListener, subscribeCeremonySignedOut } = await import('../src/lib/ceremony-boot.ts');
const { AUTH_STORAGE_KEY } = await import('../src/lib/auth.ts');
const { SignerPanel } = await import('../src/components/sign/signer-panel.tsx');
const { DirectLinkCard } = await import('../src/routes/sign-templates.tsx');
const { SignPublicHubDirectory, SignPublicHubPage } = await import('../src/routes/sign-public-hub.tsx');

function renderWithLocale(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );
}

function assertPairedLabels(html: string): void {
  const inputIdRegex = /<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g;
  for (const match of html.matchAll(inputIdRegex)) {
    const id = match[1]!;
    expect(html, `missing <label for="${id}">`).toContain(`for="${id}"`);
  }
}

describe('eSign Slice 4d in-person ceremony and public template hub UI (#3820)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds isolated in-person URLs with hash-only tokens and public hub URLs cleanly', () => {
    const rawToken = 'C'.repeat(43);
    const inPersonUrl = buildInPersonSigningUrl(rawToken, 'https://app.ludy.vn');
    expect(inPersonUrl).toBe(`https://app.ludy.vn${SIGN_PAGE_PATH}?in_person=1#${rawToken}`);
    expect(inPersonUrl.split('#')[0]).not.toContain(rawToken);

    expect(hasInPersonQueryFlag('?in_person=1')).toBe(true);
    expect(hasInPersonQueryFlag('?in_person=true')).toBe(true);
    expect(hasInPersonQueryFlag('?in_person=0')).toBe(false);
    expect(hasInPersonQueryFlag('')).toBe(false);

    const hubUrl = buildPublicHubUrl('Cong-Ty-Sao-Mai', 'https://app.ludy.vn');
    expect(hubUrl).toBe(`https://app.ludy.vn${SIGN_PUBLIC_HUB_PAGE_PREFIX}/cong-ty-sao-mai`);
  });

  it('renders SignInPersonHandoffCard in vi and en with zero links back to /o/$slug or /', () => {
    for (const locale of ['vi', 'en'] as const) {
      const completedHtml = renderWithLocale(
        <SignInPersonHandoffCard
          title="Hợp đồng dịch vụ tại quầy 2026"
          outcome="completed"
          signerRole="signer"
        />,
        locale,
      );
      expect(completedHtml).toContain('data-testid="sign-ceremony-in-person-handoff"');
      expect(completedHtml).toContain('data-testid="ceremony-in-person-badge"');
      expect(completedHtml).toContain('Hợp đồng dịch vụ tại quầy 2026');
      expect(completedHtml).not.toContain('<a ');
      expect(completedHtml).not.toContain('/o/');

      const approverHtml = renderWithLocale(
        <SignInPersonHandoffCard
          title="Phiếu duyệt bàn giao thiết bị"
          outcome="completed"
          signerRole="approver"
        />,
        locale,
      );
      expect(approverHtml).toContain('data-testid="sign-ceremony-in-person-handoff"');
      expect(approverHtml).not.toContain('<a ');
    }

    const viCompleted = renderWithLocale(
      <SignInPersonHandoffCard title="Hợp đồng mẫu" outcome="completed" signerRole="signer" />,
      'vi',
    );
    expect(viCompleted).toContain('Đã hoàn tất ký trực tiếp tại quầy');

    // In-person header badge renders when ?in_person=1 is present on window.location.search.
    vi.stubGlobal('window', {
      location: {
        origin: 'https://app.ludy.vn',
        pathname: SIGN_PAGE_PATH,
        search: '?in_person=1',
        hash: '',
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const headerHtml = renderWithLocale(<SignCeremonyPage />, 'vi');
    expect(headerHtml).toContain('data-testid="ceremony-header-in-person-badge"');
    expect(headerHtml).not.toContain('/o/');

    // SignCeremonyReadyView hides ceremony-delegate-btn during in-person signing even if allowDelegation is true.
    const baseReadyProps = {
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
      onDelegateOpenChange: () => {},
    };
    const baseView = {
      state: 'ready' as const,
      orgName: 'Cong ty Sao Mai',
      title: 'Hop dong tai quay',
      message: null,
      signerName: 'Nguyen Van Khach',
      roleLabel: 'Khach hang',
      signerRole: 'signer' as const,
      expiresAt: '2027-02-04T00:00:00.000Z',
      pageCount: 1,
      pageDimensions: [],
      requireEmailOtp: false,
      otpVerified: false,
      allowDelegation: true,
      delegationCount: 0,
      delegatedFromName: null,
      fields: [],
      sharedSummary: null,
    };
    const remoteReadyHtml = renderWithLocale(
      <SignCeremonyReadyView {...baseReadyProps} viewState={{ ...baseView, inPerson: false }} />,
      'vi',
    );
    expect(remoteReadyHtml).toContain('data-testid="ceremony-delegate-btn"');

    const inPersonReadyHtml = renderWithLocale(
      <SignCeremonyReadyView {...baseReadyProps} viewState={{ ...baseView, inPerson: true }} inPerson />,
      'vi',
    );
    expect(inPersonReadyHtml).not.toContain('data-testid="ceremony-delegate-btn"');
  });

  it('renders startInPerson action only on active pending/viewed signers and approvers, never waiting or CC', () => {
    const signers: SignSignerRecord[] = [
      {
        id: '01900000-0000-7000-8000-000000000101',
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Khách hàng',
        name: 'Nguyễn Văn A',
        email: 'khach@example.com',
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
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
      {
        id: '01900000-0000-7000-8000-000000000102',
        routingOrder: 2,
        signerRole: 'approver',
        roleLabel: 'Quản lý',
        name: 'Trần Thị B',
        email: 'quanly@example.com',
        phone: null,
        deliveryMode: 'email',
        requireEmailOtp: false,
        status: 'waiting',
        tokenLastRemindedAt: null,
        viewedAt: null,
        signedAt: null,
        declinedAt: null,
        declineReason: null,
        otpVerifiedAt: null,
        signatureKind: null,
        consentAcceptedAt: null,
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
      {
        id: '01900000-0000-7000-8000-000000000103',
        routingOrder: 3,
        signerRole: 'cc',
        roleLabel: 'Kế toán CC',
        name: 'Lê Văn C',
        email: 'ketoan@example.com',
        phone: null,
        deliveryMode: 'email',
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
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
    ];

    const html = renderWithLocale(
      <SignerPanel
        envelopeStatus="sent"
        routingMode="sequential"
        signers={signers}
        activeSignerId={signers[0]!.id}
        onSelectSigner={() => {}}
        onChangeRoutingMode={() => {}}
        onAddSigner={async () => {}}
        onRemoveSigner={async () => {}}
        onMoveSigner={async () => {}}
        onStartInPerson={() => {}}
      />,
      'vi',
    );

    expect(html).toContain(`data-testid="signer-in-person-btn-${signers[0]!.id}"`);
    expect(html).toContain('Ký trực tiếp tại quầy');
    expect(html).not.toContain(`data-testid="signer-in-person-btn-${signers[1]!.id}"`);
    expect(html).not.toContain(`data-testid="signer-in-person-btn-${signers[2]!.id}"`);
  });

  it('renders DirectLinkCard public hub opt-in checkbox and copyable hub URL with paired labels', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://app.ludy.vn', pathname: '/', search: '', hash: '' },
    });

    const detail: SignTemplateDetail = {
      template: {
        id: '01900000-0000-7000-8000-000000000201',
        title: 'Biểu mẫu đăng ký thành viên',
        description: 'Biểu mẫu tự phục vụ trên cổng công khai',
        routingMode: 'parallel',
        subject: null,
        message: null,
        expiresInHours: null,
        status: 'active',
        inspectStatus: 'passed',
        inspectError: null,
        sourceFileId: '01900000-0000-7000-8000-000000000202',
        sourceSha256: 'a'.repeat(64),
        pageCount: 2,
        pageDimensions: null,
        version: 1,
        archivedAt: null,
        createdBy: '01900000-0000-7000-8000-000000000203',
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
      roles: [
        {
          id: '01900000-0000-7000-8000-000000000204',
          roleKey: 'r1',
          signerRole: 'signer',
          roleLabel: 'Người đăng ký',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      fields: [],
      directLink: {
        id: '01900000-0000-7000-8000-000000000205',
        enabled: true,
        requireEmailOtp: true,
        listedOnPublicHub: true,
        lastRotatedAt: '2026-11-20T00:00:00Z',
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
    };

    for (const locale of ['vi', 'en'] as const) {
      const html = renderWithLocale(
        <DirectLinkCard
          detail={detail}
          freshDirectUrl={null}
          orgSlug="cong-ty-sao-mai"
          pending={false}
          onToggleEnabled={() => {}}
          onToggleOtp={() => {}}
          onTogglePublicHub={() => {}}
          onRotate={() => {}}
          onCopyUrl={() => {}}
        />,
        locale,
      );
      assertPairedLabels(html);
      expect(html).toContain('data-testid="sign-tpl-direct-public-hub-checkbox"');
      expect(html).toContain('data-testid="sign-tpl-public-hub-url-input"');
      expect(html).toContain('https://app.ludy.vn/-/sign/p/cong-ty-sao-mai');
      expect(html).not.toContain('token_sha256');
    }
  });

  it('renders SignPublicHubDirectory with >= 44px (min-h-11) buttons and zero CAPTCHA or workspace links', () => {
    const items = [
      {
        templateId: '01900000-0000-7000-8000-000000000301',
        title: 'Thỏa thuận bảo mật NDA khách tham quan',
        description: 'Dành cho đối tác đến làm việc tại văn phòng',
        roleLabel: 'Khách tham quan',
        signerRole: 'signer' as const,
        requireEmailOtp: true,
        pageCount: 2,
      },
      {
        templateId: '01900000-0000-7000-8000-000000000302',
        title: 'Phiếu xác nhận nghiệm thu dịch vụ',
        description: null,
        roleLabel: 'Người xác nhận',
        signerRole: 'approver' as const,
        requireEmailOtp: false,
        pageCount: 1,
      },
    ];

    const viHtml = renderWithLocale(
      <SignPublicHubDirectory orgName="Công ty TNHH Sao Mai" items={items} onSelectTemplate={() => {}} />,
      'vi',
    );
    expect(viHtml).toContain('data-testid="sign-public-hub-directory"');
    expect(viHtml).toContain('Cổng biểu mẫu điện tử Công ty TNHH Sao Mai');
    expect(viHtml).toContain(`data-testid="sign-public-hub-open-${items[0]!.templateId}"`);
    expect(viHtml).toContain('Mở biểu mẫu để ký');
    expect(viHtml).toContain('Mở biểu mẫu để duyệt');
    expect(viHtml).toContain('Cần xác thực OTP email');
    expect(viHtml).toContain('min-h-11');
    expect(viHtml).not.toContain('turnstile');
    expect(viHtml).not.toContain('/o/');

    const enHtml = renderWithLocale(
      <SignPublicHubDirectory orgName="Sao Mai Co." items={items} onSelectTemplate={() => {}} />,
      'en',
    );
    expect(enHtml).toContain('Sao Mai Co. Public Form Hub');
    expect(enHtml).toContain('Open form to sign');
    expect(enHtml).toContain('Open form to approve');
    expect(enHtml).toContain('Email OTP required');

    // Empty slug renders unavailable state once hydrated or loading skeleton on SSR.
    const loadingHtml = renderWithLocale(<SignPublicHubPage orgSlug="cong-ty-sao-mai" />, 'vi');
    expect(loadingHtml).not.toContain('/o/');
  });

  it('clears savedSignatures/workspaceOrgSlug and ignores in-flight profile loads on cross-tab sign-out (#4682)', async () => {
    const fieldId = '01900000-0000-7000-8000-000000000401';
    const sigPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const loadedProfile = {
      orgSlug: 'cong-ty-sao-mai',
      signatures: [
        {
          id: '01900000-0000-7000-8000-000000000402',
          kind: 'signature' as const,
          signatureKind: 'draw' as const,
          signatureTypedText: null,
          signaturePngBase64: sigPngBase64,
          imageSha256: '0'.repeat(64),
          widthPx: 1,
          heightPx: 1,
          createdAt: '2026-11-20T00:00:00Z',
          updatedAt: '2026-11-20T00:00:00Z',
        },
      ],
      stamps: [],
    };

    let state: {
      workspaceOrgSlug: string | null;
      savedSignatures: SignMemberSignatureItem[];
      savedStamps: SignOrgStampItem[];
    } = {
      workspaceOrgSlug: loadedProfile.orgSlug,
      savedSignatures: loadedProfile.signatures,
      savedStamps: [],
    };

    let resolveInFlight!: (v: typeof loadedProfile | null) => void;
    const storageListeners = new Set<(event: StorageEvent) => void>();
    const syncer = bindCeremonyWorkspaceProfileSync({
      subscribeSignedOut: subscribeCeremonySignedOut,
      loadProfiles: () =>
        new Promise((resolve) => {
          resolveInFlight = resolve;
        }),
      onState: (next) => {
        state = next;
      },
    });

    ensureCeremonyStorageSignedOutListener({
      isIsolated: () => false,
      addStorageListener: (cb) => {
        storageListeners.add(cb);
      },
      onSignedOutCleanup: () => {},
    });

    const readyProps = {
      viewState: {
        state: 'ready' as const,
        orgName: 'Cong ty Sao Mai',
        title: 'Hop dong',
        message: null,
        signerName: 'Nguyen Van A',
        roleLabel: 'Nguoi ky',
        signerRole: 'signer' as const,
        inPerson: false,
        expiresAt: '2027-02-04T00:00:00.000Z',
        pageCount: 1,
        pageDimensions: [],
        requireEmailOtp: false,
        otpVerified: false,
        allowDelegation: false,
        delegationCount: 0,
        delegatedFromName: null,
        fields: [
          {
            id: fieldId,
            signerId: '01900000-0000-7000-8000-000000000403',
            fieldType: 'signature' as const,
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            label: 'Chu ky',
            required: true,
            options: null,
            textValue: null,
            dateValue: null,
            attachmentFilename: null,
            attachmentContentType: null,
            attachmentSizeBytes: null,
            attachmentSha256: null,
            filledAt: null,
          },
        ],
        sharedSummary: null,
      },
      inPerson: false,
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
      onDelegateOpenChange: () => {},
    };

    try {
      // Before sign-out, quick saved signature button is rendered.
      const beforeHtml = renderWithLocale(
        <SignCeremonyReadyView
          {...readyProps}
          savedSignatures={state.savedSignatures}
          savedStamps={state.savedStamps}
          canSaveSignatureProfile={Boolean(state.workspaceOrgSlug)}
        />,
        'vi',
      );
      expect(beforeHtml).toContain(`data-testid="ceremony-quick-saved-btn-${fieldId}"`);

      // Simulate React <StrictMode> double mount: mount1 disposes -> mount2 recreates fresh syncer and loads cleanly.
      const firstMount = bindCeremonyWorkspaceProfileSync({
        subscribeSignedOut: subscribeCeremonySignedOut,
        loadProfiles: async () => loadedProfile,
        onState: (next) => {
          state = next;
        },
      });
      const stopFirst = firstMount.sync({ readyOrgName: 'Cong ty Sao Mai', isInPersonReady: false });
      stopFirst();
      firstMount.dispose();
      const secondMount = bindCeremonyWorkspaceProfileSync({
        subscribeSignedOut: subscribeCeremonySignedOut,
        loadProfiles: async () => loadedProfile,
        onState: (next) => {
          state = next;
        },
      });
      secondMount.sync({ readyOrgName: 'Cong ty Sao Mai', isInPersonReady: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(state.workspaceOrgSlug).toBe('cong-ty-sao-mai');
      expect(state.savedSignatures).toHaveLength(1);

      // Trigger an in-flight reload, then simulate cross-tab sign-out via AUTH_STORAGE_KEY removal.
      syncer.sync({ readyOrgName: 'Cong ty Sao Mai', isInPersonReady: false });
      for (const cb of storageListeners) {
        cb({ key: AUTH_STORAGE_KEY, newValue: null } as unknown as StorageEvent);
      }
      expect(state.workspaceOrgSlug).toBeNull();
      expect(state.savedSignatures).toEqual([]);
      expect(state.savedStamps).toEqual([]);

      // Even if the in-flight loadCeremonyWorkspaceProfiles promise resolves late, state stays empty.
      resolveInFlight(loadedProfile);
      await Promise.resolve();
      expect(state.workspaceOrgSlug).toBeNull();
      expect(state.savedSignatures).toEqual([]);

      const afterHtml = renderWithLocale(
        <SignCeremonyReadyView
          {...readyProps}
          savedSignatures={state.savedSignatures}
          savedStamps={state.savedStamps}
          canSaveSignatureProfile={Boolean(state.workspaceOrgSlug)}
        />,
        'vi',
      );
      expect(afterHtml).not.toContain(`data-testid="ceremony-quick-saved-btn-${fieldId}"`);
      const staleReloaded: unknown[] = [];
      secondMount.dispose();
      await secondMount.reloadIfStillCurrent('Cong ty Sao Mai', (sigs) => {
        staleReloaded.push(...sigs);
      });
      expect(staleReloaded).toEqual([]);
    } finally {
      syncer.dispose();
    }
  });
});
