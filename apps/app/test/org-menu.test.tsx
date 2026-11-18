// SPDX-License-Identifier: AGPL-3.0-only
// The org menu at the top of the sidebar (#3579), rendered on the server: the trigger is a labelled button with the
// current org's name (no native select, no separate "add" link under it), picking an org closes the phone drawer and then
// opens the org's overview, and "Thêm tổ chức" reads the same in the menu and in the firm guide. The open menu itself
// (its items, the keyboard, the phone drawer) is a client-side popup: e2e/tests/org-menu.spec.ts drives it.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => Promise.resolve(),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/session-actions.ts', () => ({ signOut: () => Promise.resolve() }));
// The nav's other parts (the entity switcher) import the API client, which reads the page's origin; nothing is fetched.
vi.mock('../src/lib/api.ts', () => {
  const node = (): unknown => new Proxy(() => undefined, { get: () => node() });
  return { orpc: node(), client: node(), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { OrgMenu, switchOrg } = await import('../src/components/app-nav.tsx');
const { firmGuide } = await import('../src/lib/firm-guide.ts');

const ORGS = [
  { orgId: '00000000-0000-4000-8000-000000000001', slug: 'dos', name: 'DOS' },
  { orgId: '00000000-0000-4000-8000-000000000002', slug: 'hoa-sen', name: 'Công ty TNHH Thương mại và Dịch vụ Hoa Sen Miền Bắc' },
];

const render = (slug: string, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <OrgMenu slug={slug} orgs={ORGS} />
    </IntlProvider>,
  );

describe('OrgMenu', () => {
  it('is a menu button named by the current org, in place of a native select', () => {
    const html = render('hoa-sen');
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    expect(html).toContain(`<span class="sr-only">${viMessages.nav.org}: </span>`);
    expect(html).toContain('Công ty TNHH Thương mại và Dịch vụ Hoa Sen Miền Bắc');
    // A long name is cut off with an ellipsis, not wrapped under the chevron.
    expect(html).toMatch(/<span class="[^"]*truncate[^"]*"[^>]*>Công ty TNHH/);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('DOS');
  });

  it('keeps "add organization" inside the menu, not as a link under the button', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = render('dos', locale);
      expect(html).not.toContain('/onboarding');
      expect(html).not.toContain((locale === 'vi' ? viMessages : en).nav.addOrg);
    }
  });

  it('names the button in English too', () => {
    expect(render('dos', 'en')).toContain(`<span class="sr-only">${en.nav.org}: </span>`);
  });
});

describe('switchOrg', () => {
  it('closes the phone drawer, then opens the picked org\'s overview', () => {
    const calls: string[] = [];
    const navigate = vi.fn((to: unknown) => {
      calls.push(`navigate ${JSON.stringify(to)}`);
    });
    switchOrg(navigate, () => calls.push('onNavigate'), 'hoa-sen');
    expect(calls).toEqual(['onNavigate', `navigate ${JSON.stringify({ to: '/o/$slug/overview', params: { slug: 'hoa-sen' } })}`]);
  });

  it('navigates without a drawer to close', () => {
    const navigate = vi.fn();
    switchOrg(navigate, undefined, 'dos');
    expect(navigate).toHaveBeenCalledWith({ to: '/o/$slug/overview', params: { slug: 'dos' } });
  });
});

describe('the add item\'s label', () => {
  it('has no leading "+" now that it is a menu item with an icon', () => {
    expect(viMessages.nav.addOrg).toBe('Thêm tổ chức');
    expect(en.nav.addOrg).toBe('Add organization');
  });

  it('is where the firm guide sends a firm to add its next client', () => {
    const step = firmGuide().find((s) => s.id === 'client');
    const text = step?.items[0] ?? '';
    expect(text).toContain(`"${viMessages.nav.addOrg}"`);
    expect(text).toContain('danh sách tổ chức');
    expect(text).not.toContain('dưới ô chọn tổ chức');
  });
});
