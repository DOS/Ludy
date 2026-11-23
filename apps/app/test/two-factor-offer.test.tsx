// SPDX-License-Identifier: AGPL-3.0-only
// The offer to turn on two-factor before the first approval needs it (#3599), rendered on the server from a seeded cache: one sentence on why and a button that opens the
// setup in a dialog, shown only to someone who may approve and has no verified factor yet; the step-up dialog stays closed (and out of the page) until it is asked for.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  orpc: {},
  client: {},
  queryClient: {},
  apiFetch: () => Promise.reject(new Error('not fetched')),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../src/lib/auth.ts', () => ({
  auth: () => ({ mfa: { listFactors: () => Promise.reject(new Error('not fetched')) } }),
  authErrorText: (e: unknown) => String(e),
  authFailure: (e: unknown) => e,
  verifySecondFactor: () => Promise.reject(new Error('not called')),
}));

const { StepUpDialog, TwoFactorOffer } = await import('../src/components/two-factor.tsx');

const FACTOR = { id: 'f1', factor_type: 'totp', status: 'verified' };
function offer(show: boolean, factors: unknown, locale: 'vi' | 'en' = 'vi'): string {
  const qc = new QueryClient();
  if (factors !== undefined) qc.setQueryData(['auth', 'factors'], factors);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <TwoFactorOffer show={show} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('TwoFactorOffer', () => {
  beforeEach(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      // The server render has no window.
    }
  });

  it('offers it, with the reason and a button to set it up, to someone with no verified factor who may approve', () => {
    const html = offer(true, { totp: [], all: [] });
    expect(html).toContain('data-testid="two-factor-offer"');
    expect(html).toContain('Bật xác thực hai lớp trước khi duyệt');
    expect(html).toContain('Duyệt và ghi sổ cần mã xác thực hai lớp');
    expect(html).toContain('>Thiết lập</button>');
    expect(html).toContain('>Để sau</button>');
    // The setup is in a dialog that is not open: no QR code, no code field in the page.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('autocomplete="one-time-code"');
  });

  it('says the same in English', () => {
    const html = offer(true, { totp: [], all: [] }, 'en');
    expect(html).toContain('Turn on two-factor before you approve');
    expect(html).toContain('>Set up</button>');
    expect(html).toContain('>Later</button>');
  });

  it('shows nothing to someone who may not approve, who has a verified factor, or while the factors are not read', () => {
    expect(offer(false, { totp: [], all: [] })).toBe('');
    expect(offer(true, { totp: [FACTOR], all: [FACTOR] })).toBe('');
    expect(offer(true, undefined)).toBe('');
  });
});

describe('StepUpDialog', () => {
  it('is not in the page until a step-up is asked for, so the proposal does not move', () => {
    const qc = new QueryClient();
    qc.setQueryData(['auth', 'factors'], { totp: [FACTOR], all: [FACTOR] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')}>
          <StepUpDialog open={false} action="duyệt và ghi sổ chứng từ này" onVerified={() => undefined} onCancel={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });
});
