// SPDX-License-Identifier: AGPL-3.0-only
// Component, i18n, hash-scrubbing, OTP gate, and ceremony handoff tests for /-/sign/d (#3551).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { publicDirectSignApi, PublicSignError } from '../src/lib/sign-api.ts';
import {
  forgetSignToken,
  pendingDirectSignToken,
  pendingSignToken,
  rememberDirectSignToken,
  SIGN_DIRECT_PAGE_PATH,
  SIGN_PAGE_PATH,
} from '../src/lib/sign-hash.ts';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useNavigate: () => vi.fn(),
  };
});

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

const {
  extractInitialDirectToken,
  handoffDirectSigningToken,
  SignDirectOtpCard,
  SignDirectPage,
  SignDirectReadyView,
  validateDirectStartForm,
} = await import('../src/routes/sign-direct.tsx');

const DIRECT_TOKEN = 'A'.repeat(43);
const SIGNING_TOKEN = 'B'.repeat(43);

function setupMockWindow(initialHash = '') {
  const store = new Map<string, string>();
  const replaceState = vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
    if (typeof url === 'string') {
      const parsed = new URL(url, 'https://sign.ludy.vn');
      mockWin.location.pathname = parsed.pathname;
      mockWin.location.search = parsed.search;
      mockWin.location.hash = parsed.hash;
    }
  });
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const mockWin = {
    location: {
      origin: 'https://sign.ludy.vn',
      pathname: SIGN_DIRECT_PAGE_PATH,
      search: '',
      hash: initialHash,
      replace: vi.fn(),
    },
    history: {
      state: null,
      replaceState,
    },
    sessionStorage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', mockWin);
  return { mockWin, replaceState, store };
}

function renderWithLocale(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );
}

describe('public direct signing ceremony UI (/-/sign/d, #3551)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('extracts #<token> immediately, scrubs window.location.hash via replaceState, and isolates direct session storage', () => {
    const { mockWin, replaceState } = setupMockWindow(`#${DIRECT_TOKEN}`);
    const extracted = extractInitialDirectToken();

    expect(extracted).toBe(DIRECT_TOKEN);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, '', SIGN_DIRECT_PAGE_PATH);
    expect(mockWin.location.hash).toBe('');
    expect(pendingDirectSignToken()).toBe(DIRECT_TOKEN);
    expect(pendingSignToken()).toBeNull();

    // Reload without hash recovers from tab sessionStorage within 15-minute TTL.
    expect(extractInitialDirectToken()).toBe(DIRECT_TOKEN);

    // Malformed hash scrubs URL and clears cached direct token.
    mockWin.location.hash = '#not-a-valid-token';
    expect(extractInitialDirectToken()).toBeNull();
    expect(mockWin.location.hash).toBe('');
    expect(pendingDirectSignToken()).toBeNull();
  });

  it('renders invalid direct link card when opened without a valid fragment token', () => {
    setupMockWindow('');
    const viHtml = renderWithLocale(<SignDirectPage />, 'vi');
    expect(viHtml).toContain('data-testid="sign-direct-invalid"');
    expect(viHtml).toContain('Liên kết ký trực tiếp không khả dụng');

    const enHtml = renderWithLocale(<SignDirectPage />, 'en');
    expect(enHtml).toContain('Direct signing link unavailable');
  });

  it('renders OTP gate without PDF preview and disables input when locked after 5 failed attempts', () => {
    const otpHtml = renderWithLocale(
      <SignDirectOtpCard
        viewState={{
          state: 'otp_required',
          orgName: 'Công ty TNHH Sao Mai',
          title: 'Hợp đồng dịch vụ 2026',
          description: 'Mẫu ký trực tiếp',
          roleLabel: 'Khách hàng',
          signerRole: 'signer',
          requireEmailOtp: true,
        }}
        email="khach@example.com"
        otpCode="123456"
        otpSent={true}
        maskedEmail="kh***@example.com"
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

    expect(otpHtml).toContain('data-testid="sign-direct-otp"');
    expect(otpHtml).toContain('data-testid="direct-otp-email-input"');
    expect(otpHtml).toContain('data-testid="direct-otp-request-btn"');
    expect(otpHtml).toContain('data-testid="direct-otp-code-input"');
    expect(otpHtml).toContain('data-testid="direct-otp-verify-btn"');
    expect(otpHtml).toContain('kh***@example.com');
    expect(otpHtml).toContain('min-h-11');
    expect(otpHtml).not.toContain('data-testid="sign-direct-pdf-preview"');

    const lockedHtml = renderWithLocale(
      <SignDirectOtpCard
        viewState={{
          state: 'otp_required',
          orgName: 'Sao Mai Co.',
          title: 'NDA 2026',
          description: null,
          roleLabel: 'Counterparty',
          signerRole: 'signer',
          requireEmailOtp: true,
        }}
        email="guest@example.com"
        otpCode="000000"
        otpSent={true}
        maskedEmail="gu***@example.com"
        otpSending={false}
        otpVerifying={false}
        otpLocked={true}
        otpError="OTP code locked after 5 failed attempts. Request a new code."
        onEmailChange={() => {}}
        onOtpCodeChange={() => {}}
        onRequestOtp={() => {}}
        onVerifyOtp={() => {}}
      />,
      'en',
    );
    expect(lockedHtml).toContain('OTP code locked after 5 failed attempts');
    expect(lockedHtml).toMatch(/data-testid="direct-otp-code-input"[^>]*disabled|<input[^>]*disabled[^>]*data-testid="direct-otp-code-input"/);
  });

  it('renders ready state for Signer and OTP-verified Approver with locked verified email and mobile hit targets', () => {
    const signerHtml = renderWithLocale(
      <SignDirectReadyView
        viewState={{
          state: 'ready',
          orgName: 'Công ty TNHH Sao Mai',
          title: 'Thỏa thuận bảo mật NDA',
          description: 'Dành cho đối tác mới',
          message: 'Vui lòng điền họ tên để bắt đầu ký.',
          roleLabel: 'Đối tác',
          signerRole: 'signer',
          emailRequired: false,
          requireEmailOtp: false,
          otpVerified: false,
          verifiedEmail: null,
          pageCount: 2,
          fieldCount: 3,
        }}
        name="Trần Thị B"
        email=""
        starting={false}
        startError={null}
        pdfBytes={null}
        loadingPdf={true}
        pdfError={null}
        pageNumber={1}
        scale={0.95}
        onNameChange={() => {}}
        onEmailChange={() => {}}
        onPageChange={() => {}}
        onScaleChange={() => {}}
        onStart={() => {}}
      />,
      'vi',
    );

    expect(signerHtml).toContain('data-testid="sign-direct-ready"');
    expect(signerHtml).toContain('Tiếp tục tới bước ký (3 ô)');
    expect(signerHtml).toContain('Vui lòng điền họ tên để bắt đầu ký.');
    expect(signerHtml).toContain('data-testid="sign-direct-pdf-preview"');
    expect(signerHtml).toContain('min-h-11');

    const approverHtml = renderWithLocale(
      <SignDirectReadyView
        viewState={{
          state: 'ready',
          orgName: 'Sao Mai Co.',
          title: 'Purchase Approval',
          description: null,
          message: null,
          roleLabel: 'Department Head',
          signerRole: 'approver',
          emailRequired: true,
          requireEmailOtp: true,
          otpVerified: true,
          verifiedEmail: 'head@example.org',
          pageCount: 1,
          fieldCount: 0,
        }}
        name="Le Van C"
        email="head@example.org"
        starting={false}
        startError={null}
        pdfBytes={null}
        loadingPdf={true}
        pdfError={null}
        pageNumber={1}
        scale={0.95}
        onNameChange={() => {}}
        onEmailChange={() => {}}
        onPageChange={() => {}}
        onScaleChange={() => {}}
        onStart={() => {}}
      />,
      'en',
    );

    expect(approverHtml).toContain('data-testid="direct-verified-email-badge"');
    expect(approverHtml).toContain('Verified head@example.org');
    expect(approverHtml).toContain('Continue to approve');
    expect(approverHtml).toMatch(/readOnly=""|readonly=""/);
  });

  it('validates recipient name and email requirements cleanly', () => {
    expect(validateDirectStartForm({ name: '   ', email: 'a@example.com', emailRequired: false })).toEqual({
      ok: false,
      errorKey: 'nameRequiredError',
    });
    expect(validateDirectStartForm({ name: 'Nguyen Van A', email: '', emailRequired: true })).toEqual({
      ok: false,
      errorKey: 'emailRequiredError',
    });
    expect(validateDirectStartForm({ name: 'Nguyen Van A', email: 'not-an-email', emailRequired: false })).toEqual({
      ok: false,
      errorKey: 'emailInvalidError',
    });
    expect(validateDirectStartForm({ name: '  Nguyen Van A  ', email: '', emailRequired: false })).toEqual({
      ok: true,
      name: 'Nguyen Van A',
      email: null,
    });
    expect(validateDirectStartForm({ name: 'Nguyen Van A', email: '  GUEST@Example.COM ', emailRequired: true })).toEqual({
      ok: true,
      name: 'Nguyen Van A',
      email: 'guest@example.com',
    });
  });

  it('hands off single-use signingToken into ceremony sessionStorage and navigates to /-/sign without exposing hash', () => {
    setupMockWindow('');
    rememberDirectSignToken(DIRECT_TOKEN);
    const navigate = vi.fn();

    const mode = handoffDirectSigningToken(SIGNING_TOKEN, navigate);
    expect(mode).toBe('session');
    expect(pendingDirectSignToken()).toBeNull();
    expect(pendingSignToken()).toBe(SIGNING_TOKEN);
    expect(navigate).toHaveBeenCalledWith({ to: SIGN_PAGE_PATH, replace: true });

    // Fallback when sessionStorage is blocked in strict private browsing.
    forgetSignToken();
    vi.stubGlobal('window', {
      location: { origin: 'https://sign.ludy.vn', pathname: SIGN_DIRECT_PAGE_PATH, search: '', hash: '' },
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
      },
    });
    const replaceLocation = vi.fn();
    const fallbackMode = handoffDirectSigningToken(SIGNING_TOKEN, navigate, replaceLocation);
    expect(fallbackMode).toBe('hash_fallback');
    expect(replaceLocation).toHaveBeenCalledWith(`https://sign.ludy.vn${SIGN_PAGE_PATH}#${SIGNING_TOKEN}`);
  });

  it('posts publicDirectSignApi payloads strictly in JSON bodies with credentials omitted and no-referrer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          locked: true,
          attemptsRemaining: 0,
        }),
        { status: 423, headers: { 'content-type': 'application/json' } },
      ),
    );

    const locked = await publicDirectSignApi.verifyOtp(DIRECT_TOKEN, 'guest@example.vn', '000000');
    expect(locked).toEqual({ ok: false, locked: true, attemptsRemaining: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('/api/sign/direct/otp/verify');
    expect(calledUrl).not.toContain(DIRECT_TOKEN);
    expect(calledInit.credentials).toBe('omit');
    expect(calledInit.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(String(calledInit.body))).toEqual({
      token: DIRECT_TOKEN,
      email: 'guest@example.vn',
      code: '000000',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(publicDirectSignApi.view(DIRECT_TOKEN)).rejects.toBeInstanceOf(PublicSignError);
  });
});
