// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in, sign-up and reset screens (#3593, AU-1 and AU-3): one line for the whole suite, the password rule shown from the start, and a Show / Hide toggle
// on every password field. Rendered on the server; the network message (AU-2) is in network-error.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', async (importActual) => ({ ...(await importActual<typeof import('@tanstack/react-router')>()), useNavigate: () => vi.fn() }));
vi.mock('../src/i18n/provider.tsx', async (importActual) => ({ ...(await importActual<typeof import('../src/i18n/provider.tsx')>()), LocaleSwitcher: () => null }));
vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));
vi.mock('../src/lib/auth.ts', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/auth.ts')>()),
  getConfig: () => ({ authUrl: 'http://localhost', authAnonKey: null, supportUrl: null, authProviders: [], hostedLogin: null }),
}));

const { AuthPage, initialModeFromSearch } = await import('../src/routes/auth.tsx');
const { PasswordInput } = await import('../src/components/password-input.tsx');

const render = (node: React.ReactNode, locale: 'en' | 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );

describe('the line under the sign-in and sign-up titles (AU-1)', () => {
  it.each([
    ['vi', 'Ludy: sổ sách, công việc và khách hàng, có đồng nghiệp AI cùng làm.'],
    ['en', 'Ludy: books, tasks and customers, with an AI coworker.'],
  ] as const)('speaks for the suite in %s, with no accounting screen and no coworker the visitor has not met', (locale, line) => {
    for (const mode of ['login', 'signup', 'reset'] as const) {
      const html = render(<AuthPage initialMode={mode} />, locale);
      expect(html, `${locale} ${mode}`).toContain(line);
      expect(html, `${locale} ${mode}`).not.toMatch(/Document inbox|Chứng từ chờ duyệt|forward invoices|hóa đơn/i);
    }
  });
});

describe('the password field of the sign-up screen (AU-3)', () => {
  it.each([
    ['vi', 'Ít nhất 8 ký tự.', 'Hiện'],
    ['en', 'At least 8 characters.', 'Show'],
  ] as const)('states the rule from the start and has a toggle, in %s', (locale, hint, toggle) => {
    const html = render(<AuthPage initialMode="signup" />, locale);
    expect(html).toContain(hint);
    // The input describes itself by the hint, and starts hidden (the toggle's text says what a press does).
    const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('autoComplete="new-password"');
    const id = /id="([^"]+)"/.exec(input)?.[1];
    expect(id).toBeTruthy();
    expect(input).toContain(`aria-describedby="${id}-hint"`);
    const button = /<button[^>]*aria-controls[^>]*>([^<]*)<\/button>/.exec(html);
    expect(button?.[1]).toBe(toggle);
    expect(button?.[0]).toContain(`aria-controls="${id}"`);
    expect(button?.[0]).toContain('type="button"');
  });

  it('does not show the rule on the sign-in screen, where the person types the password they already have', () => {
    expect(render(<AuthPage initialMode="login" />, 'en')).not.toContain('At least 8 characters.');
  });

  it('keeps the field named by its label alone: the toggle has no word "password", so a label lookup finds one control', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = render(<PasswordInput id="p" />, locale);
      const button = /<button[^>]*>([^<]*)<\/button>/.exec(html);
      expect(button?.[0]).not.toContain('aria-label');
      expect(button?.[1]).not.toMatch(/password|mật khẩu/i);
    }
  });
});

describe('the catalogs of the screens, with diacritics', () => {
  it('words the rule, the toggle and the network failure in Vietnamese', () => {
    const vi = catalog('vi');
    expect(vi.auth.passwordHint).toBe('Ít nhất 8 ký tự.');
    expect(vi.resetPassword.passwordHint).toBe('Ít nhất 8 ký tự.');
    expect(vi.common.passwordShow).toBe('Hiện');
    expect(vi.common.passwordHide).toBe('Ẩn');
    expect(vi.common.networkError).toBe('Không kết nối được máy chủ. Thử lại sau ít phút.');
  });
});

describe('initialModeFromSearch (?mode=signup | reset)', () => {
  it('opens the sign-up or password-reset tab when requested by query parameter and falls back to login', () => {
    expect(initialModeFromSearch('?mode=signup')).toBe('signup');
    expect(initialModeFromSearch('?utm_source=landing&mode=signup')).toBe('signup');
    expect(initialModeFromSearch('?mode=reset')).toBe('reset');
    expect(initialModeFromSearch('?mode=login')).toBe('login');
    expect(initialModeFromSearch('?mode=unknown')).toBe('login');
    expect(initialModeFromSearch('')).toBe('login');
  });
});
