// SPDX-License-Identifier: AGPL-3.0-only
// The "Thêm" group at the foot of an app menu (lean navigation F1, #4790). The real manifests flag no item yet (the per-app trims are F2 to F9), so a fixture flags two:
// Thuế in Tài chính and Tuyển dụng in Nhân sự. Everything else here is the real shell code: the menus, the current-item marker, the palette's list, the role filter.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ client: null as unknown as QueryClient, pathname: '/o/acme/overview' }));

vi.mock('@ludy/kernel-contract', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/kernel-contract')>();
  const flag = (module: 'finance' | 'hr', path: string) => ({
    ...real.MODULE_SCREENS[module],
    nav: real.MODULE_SCREENS[module].nav.map((nav) => (nav.path === path ? { ...nav, more: true as const } : nav)),
  });
  return { ...real, MODULE_SCREENS: { ...real.MODULE_SCREENS, finance: flag('finance', 'vat'), hr: flag('hr', 'hr/recruiting') } };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'finance', 'hr', 'social', 'crm', 'ads', 'notes', 'meetings', 'projects', 'sign'], mcpEnabled: true, supportUrl: 'mailto:support@example.com', statusPage: true }),
}));
vi.mock('../src/lib/api-base.ts', () => ({ serverOrigin: () => 'https://app.ludy.vn' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode } & Record<string, unknown>) => {
    const { activeOptions: _a, ...anchor } = rest;
    return (
      <a href={to.replace('$slug', params?.slug ?? '')} {...anchor}>
        {children}
      </a>
    );
  },
  useParams: () => ({ slug: 'acme' }),
  useLocation: () => ({ pathname: state.pathname }),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC({ defaultOptions: { queries: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: opts && 'input' in opts ? [...path, opts.input] : path, queryFn: () => Promise.reject(new Error('not fetched in SSR test')) });
        if (prop === 'key') return (opts?: { input?: unknown }) => (opts && 'input' in opts ? [...path, opts.input] : path);
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), clientForOrg: () => node([]), queryClient: state.client, errorMessage: String };
});

const { ALL_NAV, APPS, NAV_KEYWORDS, appOfPath, currentMenuItem, installedApps, visibleApps } = await import('../src/lib/apps.ts');
const { ShellNav } = await import('../src/components/app-nav.tsx');
const { filterPalette } = await import('../src/lib/palette.ts');

const ALL_MODULES = ['kernel', 'finance', 'hr', 'social', 'crm', 'ads', 'notes', 'meetings', 'projects', 'sign'];
const apps = installedApps(ALL_MODULES);
const owner = { manager: true, hrMember: true, showAiConnections: true };

function shell(pathname: string, locale: 'vi' | 'en' = 'vi', mode: 'sidebar' | 'drawer' = 'sidebar', shown = apps): string {
  state.pathname = pathname;
  state.client.clear();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <I18nProvider>
          <ShellNav
            slug="acme"
            apps={shown}
            app={appOfPath(pathname)}
            badges={{}}
            orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
            email="chu@example.com"
            onOpenPalette={() => undefined}
            paletteKeys="Ctrl K"
            mode={mode}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

// The "Thêm" button and its list, as the markup holds them.
const moreButton = (html: string) => html.match(/<button[^>]*aria-controls="[^"]*-more-list"[^>]*>/)?.[0] ?? '';
const moreList = (html: string) => html.match(/<ul id="[^"]*-more-list"[^>]*>/)?.[0] ?? '';

describe('the data: a flagged item moves to the foot group, an app with none gets none', () => {
  it('ends an app with a flagged item with a `more` group that holds it, and takes it out of its own group', () => {
    const finance = APPS.find((a) => a.id === 'finance');
    expect(finance?.groups.map((g) => g.id)).toEqual(['books', 'sell', 'buy', 'ledger', 'more']);
    expect(finance?.groups.at(-1)?.items.map((i) => [i.to, i.label, i.more])).toEqual([['/o/$slug/vat', 'tax', true]]);
    expect(finance?.groups.find((g) => g.id === 'ledger')?.items.map((i) => i.label)).toEqual(['journal', 'ledger', 'fixedAssets']);
    expect(APPS.find((a) => a.id === 'hr')?.groups.at(-1)).toMatchObject({ id: 'more', items: [{ label: 'recruiting' }] });
  });

  it('draws no `more` group in an app with no flagged item', () => {
    for (const app of APPS.filter((a) => a.id !== 'finance' && a.id !== 'hr')) expect(app.groups.map((g) => g.id), app.id).not.toContain('more');
  });

  it('keeps the address, the app and the current-item marker of a flagged item', () => {
    expect(appOfPath('/o/acme/vat')).toBe('finance');
    expect(appOfPath('/o/acme/hr/recruiting')).toBe('hr');
    expect(currentMenuItem('/o/acme/vat')).toBe('/o/$slug/vat');
    expect(currentMenuItem('/o/acme/vat/')).toBe('/o/$slug/vat');
    expect(currentMenuItem('/o/acme/portal-invoices')).toBe('/o/$slug/vat'); // its tab keeps its menu item
    expect(currentMenuItem('/o/acme/hr/recruiting')).toBe('/o/$slug/hr/recruiting');
  });

  it('keeps a flagged item in Ctrl K, found by its name and its keywords', () => {
    expect(ALL_NAV.map((i) => i.to)).toContain('/o/$slug/vat');
    expect(ALL_NAV.map((i) => i.to)).toContain('/o/$slug/hr/recruiting');
    const entries = ALL_NAV.map((item) => ({ id: `go:${item.to}`, group: 'go' as const, label: viMessages.nav[item.label as 'tax'], ...(NAV_KEYWORDS[item.label] ? { keywords: NAV_KEYWORDS[item.label] } : {}) }));
    expect(filterPalette(entries, 'thuế').map((e) => e.id)).toContain('go:/o/$slug/vat');
    expect(filterPalette(entries, 'gtgt').map((e) => e.id)).toContain('go:/o/$slug/vat');
    expect(filterPalette(entries, 'tuyển dụng').map((e) => e.id)).toContain('go:/o/$slug/hr/recruiting');
  });

  it('still lets the role and the installed modules decide what shows (`isShellItemHidden`, the module filter)', () => {
    // A member who is no manager: Nhân sự is only the staff portal, so the flagged Tuyển dụng is gone with its `more` group.
    const member = visibleApps(apps, { manager: false, hrMember: true, showAiConnections: false });
    expect(member.find((a) => a.id === 'hr')?.groups.map((g) => g.id)).toEqual(['people']);
    expect(member.find((a) => a.id === 'hr')?.groups[0]?.items.map((i) => i.label)).toEqual(['hrMy']);
    // The manager keeps it, last.
    expect(visibleApps(apps, owner).find((a) => a.id === 'hr')?.groups.at(-1)?.id).toBe('more');
    // Finance off: no Tài chính, so no flagged Thuế; Nhân sự off: no Tuyển dụng.
    expect(installedApps(['kernel', 'hr']).some((a) => a.id === 'finance')).toBe(false);
    expect(installedApps(['kernel', 'finance']).find((a) => a.id === 'finance')?.groups.at(-1)?.id).toBe('more');
    // An app opens on its first screen, never on a flagged one.
    expect(apps.find((a) => a.id === 'finance')?.home).toBe('/o/$slug/accounting');
    expect(visibleApps(apps, owner).find((a) => a.id === 'hr')?.home).toBe('/o/$slug/hr/employees');
  });
});

describe('the menu: a collapsed "Thêm" group at the foot, open on one of its screens', () => {
  it('draws the group last in the Tài chính menu, closed, its list out of the tab order', () => {
    const html = shell('/o/acme/accounting');
    const button = moreButton(html);
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('type="button"');
    expect(html).toContain('<span>Thêm</span>');
    expect(moreList(html)).toContain('hidden');
    // The flagged item is in the document (the list is hidden, not removed) and is the last link of the menu.
    expect(html.lastIndexOf('href="/o/acme/vat"')).toBeGreaterThan(html.indexOf('href="/o/acme/ledger"'));
    expect(html.indexOf('<span>Thêm</span>')).toBeGreaterThan(html.indexOf('href="/o/acme/fixed-assets"'));
    expect(html.indexOf('<span>Thêm</span>')).toBeLessThan(html.indexOf('href="/o/acme/vat"'));
  });

  it('opens the group on one of its screens, with that item marked current', () => {
    for (const path of ['/o/acme/vat', '/o/acme/portal-invoices']) {
      const html = shell(path);
      expect(moreButton(html), path).toContain('aria-expanded="true"');
      expect(moreList(html), path).not.toContain('hidden');
      expect(html, path).toMatch(/<a href="\/o\/acme\/vat"[^>]*aria-current="page"/);
    }
  });

  it('names the button as the group and links the list to it', () => {
    const html = shell('/o/acme/accounting');
    const labelId = /<section[^>]*aria-labelledby="([^"]*-more)"/.exec(html)?.[1];
    expect(labelId).toBeDefined();
    expect(moreButton(html)).toContain(`id="${labelId}"`);
    expect(moreButton(html)).toContain(`aria-controls="${labelId}-list"`);
    expect(moreList(html)).toContain(`id="${labelId}-list"`);
  });

  it('has 44px targets on a phone: the button and the rows, in the drawer too', () => {
    for (const mode of ['sidebar', 'drawer'] as const) {
      const html = shell('/o/acme/vat', 'vi', mode);
      expect(moreButton(html), mode).toMatch(/class="[^"]*\bmin-h-11\b[^"]*\bmd:min-h-0\b/);
      expect(html, mode).toMatch(/<a href="\/o\/acme\/vat"[^>]*class="[^"]*\bmin-h-11\b/);
      expect(moreButton(html), mode).toContain('focus-visible:ring-3');
    }
  });

  it('draws one icon for the toggle, none extra on the flagged item beyond its own', () => {
    const html = shell('/o/acme/vat');
    const section = html.slice(html.indexOf('-more"'), html.indexOf('</section>', html.indexOf('-more"')));
    expect(section.match(/<svg/g)?.length).toBe(2); // the chevron and the item's icon
  });

  it('draws no group in an app with no flagged item, and none on the rail', () => {
    const html = shell('/o/acme/tasks');
    expect(html).not.toContain('<span>Thêm</span>');
    expect(html).not.toContain('-more-list');
    // On the rail (an org screen with no app menu) there is no group either: the rail lists apps only.
    const railOnly = shell('/o/acme/overview');
    expect(railOnly).not.toContain('<span>Thêm</span>');
    expect(railOnly).not.toContain('href="/o/acme/vat"');
  });

  it('says "More" in English', () => {
    const html = shell('/o/acme/accounting', 'en');
    expect(html).toContain('<span>More</span>');
    expect(enMessages.nav.groups.more).toBe('More');
    expect(viMessages.nav.groups.more).toBe('Thêm');
  });

  it('shows the items of an app whose only group is "Thêm" plain, with no toggle', () => {
    const onlyMore = [{ id: 'hr' as const, home: '/o/$slug/hr/recruiting' as const, groups: [{ id: 'more' as const, items: apps.find((a) => a.id === 'hr')!.groups.at(-1)!.items }] }];
    const html = shell('/o/acme/hr/recruiting', 'vi', 'sidebar', onlyMore);
    expect(html).toContain('href="/o/acme/hr/recruiting"');
    expect(html).not.toContain('-more-list');
    expect(html).not.toContain('hidden=""');
  });
});
