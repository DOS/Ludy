// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in screen of a deployment that signs in only through the identity provider's OAuth App (AUTH_SIGN_IN=oauth, issue #4704):
// one button, reachable by keyboard and at least 44 px tall, and no password form, sign-up or reset. With the setting off the
// screen is the form with its links, as before.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', async (importActual) => ({ ...(await importActual<typeof import('@tanstack/react-router')>()), useNavigate: () => vi.fn() }));
vi.mock('../src/i18n/provider.tsx', async (importActual) => ({ ...(await importActual<typeof import('../src/i18n/provider.tsx')>()), LocaleSwitcher: () => null }));
vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));
vi.mock('../src/lib/auth.ts', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/auth.ts')>()),
  getConfig: () => ({ authUrl: 'http://localhost', authAnonKey: null, supportUrl: null, authProviders: [], hostedLogin: null, ...config.current }),
}));

const { AuthPage } = await import('../src/routes/auth.tsx');

const OAUTH = { clientId: '3f2b8a9e-6c1d-4e7a-9b5f-0d1c2e3f4a5b', authorizeUrl: 'https://id.example.test/auth/v1/oauth/authorize', tokenUrl: 'https://id.example.test/auth/v1/oauth/token', name: 'Example ID' };

const render = (mode: 'login' | 'signup' | 'reset', locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <AuthPage initialMode={mode} />
    </IntlProvider>,
  );

describe('hosted-only sign-in (AUTH_SIGN_IN=oauth)', () => {
  it.each(['login', 'signup', 'reset'] as const)('shows one button and no form, field, sign-up or reset in %s mode', (mode) => {
    config.current = { signIn: 'oauth', oauthSignIn: OAUTH };
    const html = render(mode);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('Continue with Example ID');
    expect(html).not.toMatch(/<form|<input|type="password"|type="email"/);
    expect(html).not.toMatch(/Forgot password|Already have an account|Create account|Sign up|Reset/i);
  });

  it('makes the button a real, enabled button: in the tab order, at least 44 px tall, with a visible label', () => {
    config.current = { signIn: 'oauth', oauthSignIn: OAUTH };
    const button = /<button[^>]*>/.exec(render('login'))?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(button).not.toContain('tabindex="-1"');
    expect(button).toMatch(/\bmin-h-11\b/);
  });

  it('words the button in Vietnamese, and without a name falls back to the generic label', () => {
    config.current = { signIn: 'oauth', oauthSignIn: OAUTH };
    expect(render('login', 'vi')).toContain('Tiếp tục với Example ID');
    config.current = { signIn: 'oauth', oauthSignIn: { ...OAUTH, name: null } };
    expect(render('login')).toContain('Continue with your sign-in provider');
  });

  it('is off by default: the form, its fields and its links stay', () => {
    for (const current of [{}, { signIn: 'form' }, { signIn: 'form', oauthSignIn: null }, { signIn: 'oauth', oauthSignIn: null }]) {
      config.current = current;
      const html = render('login');
      expect(html, JSON.stringify(current)).toContain('<form');
      expect(html).toContain('type="password"');
      expect(html).not.toContain('Example ID');
    }
  });
});
