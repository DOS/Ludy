// SPDX-License-Identifier: AGPL-3.0-only
// The app shell (#3588, SH-1 to SH-7): no stale app menu on the org's own screens, a phone drawer that scrolls as one column, a header that
// fits, 44px targets under the phone breakpoint, a title on the cut-off names, and "hoa don" finding Chứng từ in Ctrl K.
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MODULE_SCREENS } from '@ludy/kernel-contract';
import { buttonVariants } from '@ludy/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { ALL_NAV, NAV_KEYWORDS, SETTINGS_ITEMS, appOfPath, installedApps } from '../src/lib/apps.ts';
import { installedItems } from '../src/lib/modules.ts';
import { filterPalette, type PaletteItem } from '../src/lib/palette.ts';
import { PHONE_TARGET } from '../src/lib/touch-target.ts';

const state = vi.hoisted(() => ({ client: null as unknown as QueryClient, pathname: '/o/acme/overview', links: [] as Array<{ to: string; onClick?: unknown }> }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: Object.keys(MODULE_SCREENS), mcpEnabled: true, supportUrl: 'mailto:support@example.com', statusPage: true }),
}));

vi.mock('../src/lib/api-base.ts', () => ({
  serverOrigin: () => 'https://app.ludy.vn',
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode } & Record<string, unknown>) => {
    state.links.push({ to, onClick: rest.onClick });
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
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts && 'input' in opts ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched in SSR test')),
          });
        }
        if (prop === 'key') return (opts?: { input?: unknown }) => (opts && 'input' in opts ? [...path, opts.input] : path);
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), clientForOrg: () => node([]), queryClient: state.client, errorMessage: String };
});

const { AccountPanel, ShellNav } = await import('../src/components/app-nav.tsx');
const { PhoneHeader } = await import('../src/components/phone-header.tsx');

function render(locale: 'vi' | 'en', node: React.ReactNode): string {
  state.client.clear();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

const apps = installedApps(Object.keys(MODULE_SCREENS));
const LONG_NAME = 'Công ty TNHH Thương mại và Dịch vụ Vận tải Quốc tế Sao Mai';
const shell = (
  pathname: string,
  locale: 'vi' | 'en' = 'vi',
  modules?: readonly string[],
  onNavigate?: () => void,
  extra?: {
    mode?: 'sidebar' | 'drawer';
    secondaryCollapsed?: boolean;
    onToggleSecondary?: () => void;
    onOpenQuickCapture?: () => void;
  },
) => {
  state.pathname = pathname;
  state.links = [];
  return render(
    locale,
    <ShellNav
      slug="acme"
      apps={apps}
      app={appOfPath(pathname)}
      {...(modules ? { settingsItems: installedItems(modules, SETTINGS_ITEMS) } : {})}
      badges={{}}
      orgs={[{ orgId: '1', slug: 'acme', name: LONG_NAME }]}
      email="chu.cong.ty@example.com"
      onOpenPalette={() => undefined}
      paletteKeys="Ctrl K"
      {...(onNavigate ? { onNavigate } : {})}
      {...extra}
    />,
  );
};

describe('SH-1: the org\'s own screens show no app menu', () => {
  it.each(['/o/acme/overview', '/o/acme/notifications', '/o/acme/settings', '/o/acme/settings/members', '/o/acme/audit', '/o/acme/personal-data'])('%s belongs to no app', (path) => {
    expect(appOfPath(path)).toBeNull();
  });

  it.each(['/o/acme/overview', '/o/acme/notifications', '/o/acme/audit', '/o/acme/personal-data'])('draws the rail and no app or Settings menu on %s, in both languages', (path) => {
    for (const locale of ['vi', 'en'] as const) {
      const html = shell(path, locale);
      // The rail is there: every app of the switcher, the overview, the bell and Settings.
      expect(html).toContain('aria-label="' + (locale === 'vi' ? 'Ứng dụng' : 'Apps') + '"');
      // No app or Settings menu: not the Cộng tác one the shell used to start with, and not any other app's or Settings'.
      expect(html).not.toContain('Việc nhóm');
      expect(html).not.toContain('Team tasks');
      expect(html).not.toContain('Cộng tác</p>');
      expect(html).not.toContain('Thành viên và quyền');
      expect(html).not.toContain('Members and roles');
      expect(html).not.toMatch(/<section[^>]*aria-label="[^"]*(Cộng tác|Tài chính|Engage|Cài đặt|Settings)/);
      // And no app or Settings rail button is marked as active.
      expect(html).not.toContain('aria-current="true"');
    }
  });

  it('marks the rail entry of Overview and Notifications with aria-current="page"', () => {
    expect(shell('/o/acme/overview')).toContain('aria-current="page"');
    expect(shell('/o/acme/notifications')).toContain('aria-current="page"');
  });

  it('renders the installed Settings sub-pages in the secondary sidebar, highlights the Cài đặt rail button with aria-current="true", and marks only the active sub-page (#4499)', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = shell('/o/acme/settings', locale);
      const switcher = html.slice(html.indexOf('<ul'), html.indexOf('</ul>'));
      expect(switcher).not.toContain('aria-current="true"');
      const settingsLabel = locale === 'vi' ? 'Cài đặt' : 'Settings';
      const orgLabel = locale === 'vi' ? 'Tổ chức' : 'Organization';
      const membersLabel = locale === 'vi' ? 'Thành viên và quyền' : 'Members and roles';
      expect(html).toContain(`<p class="px-3 pb-1.5 text-sm font-semibold text-foreground">${settingsLabel}</p>`);
      expect(html).toContain(`aria-label="${settingsLabel}"`);
      expect(html).toMatch(new RegExp(`href="/o/acme/settings"[^>]*aria-current="true"[^>]*>.*?<span>${settingsLabel}</span>`, 's'));
      expect(html).toMatch(new RegExp(`href="/o/acme/settings"[^>]*aria-current="page"[^>]*>.*?<span[^>]*>${orgLabel}</span>`, 's'));
      expect(html).toContain(membersLabel);
      expect(html).not.toMatch(/href="\/o\/acme\/settings\/members"[^>]*aria-current="page"/);
    }

    const onNavigate = vi.fn();
    const membersHtml = shell('/o/acme/settings/members', 'vi', undefined, onNavigate);
    expect(membersHtml).toMatch(/href="\/o\/acme\/settings"[^>]*aria-current="true"[^>]*>.*?<span>Cài đặt<\/span>/s);
    expect(membersHtml).toMatch(/href="\/o\/acme\/settings\/members"[^>]*aria-current="page"[^>]*>.*?<span[^>]*>Thành viên và quyền<\/span>/s);
    expect(membersHtml).not.toMatch(/href="\/o\/acme\/settings"[^>]*aria-current="page"[^>]*>.*?<span[^>]*>Tổ chức<\/span>/s);
    expect(membersHtml).toContain('min-h-11');
    // Every Settings sub-page link calls onNavigate to close the mobile drawer, while the Cài đặt rail anchor stays outside <Link> and keeps it open.
    const settingsLinks = state.links.filter((l) => l.to.startsWith('/o/$slug/settings'));
    expect(settingsLinks).toHaveLength(11);
    for (const link of settingsLinks) expect(link.onClick).toBe(onNavigate);

    // Filtered by installed modules: without crm or finance, their Settings items are omitted.
    const kernelOnlyHtml = shell('/o/acme/settings', 'vi', ['kernel']);
    expect(kernelOnlyHtml).toContain('Tổ chức');
    expect(kernelOnlyHtml).toContain('Thành viên và quyền');
    expect(kernelOnlyHtml).not.toContain('Bán hàng');
    expect(kernelOnlyHtml).not.toContain('Báo giá');
    expect(kernelOnlyHtml).not.toContain('Kế toán và thuế');
    expect(kernelOnlyHtml).not.toContain('Kết nối');
  });

  it('still shows the menu of the app a screen belongs to, and marks that app', () => {
    const html = shell('/o/acme/my-work');
    expect(html).toContain('Việc của tôi');
    expect(html).toContain('Việc nhóm');
    expect(html).toMatch(/aria-current="true"[^>]*class="[^"]*"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span>Cộng tác<\/span>/s);
  });

  it('shows Tài chính\'s own menu, not the last app\'s, on a deep link into it', () => {
    const html = shell('/o/acme/journal');
    expect(html).toContain('Sổ sách');
    expect(html).not.toContain('Việc nhóm');
  });
});

describe('SH-2: the phone drawer scrolls as one column', () => {
  it('lets the nav scroll on a phone, keeps the menu from scrolling on its own there, and sizes the row inside to the drawer or its content', () => {
    const html = shell('/o/acme/journal');
    expect(html).toMatch(/<nav[^>]*class="[^"]*max-md:overflow-y-auto/);
    expect(html).toMatch(/<nav[^>]*class="[^"]*max-md:items-start/);
    // The menu's own scroll (a short laptop window) is switched off under md, so no group hides behind the account block.
    expect(html).toContain('overflow-y-auto max-md:overflow-y-visible');
    expect(html).toContain('flex min-w-0 flex-1 max-md:min-h-full md:contents');
  });

  it('lists every group of the Tài chính menu, the last one included', () => {
    const html = shell('/o/acme/journal');
    for (const group of ['Bán hàng', 'Mua hàng', 'Sổ sách &amp; Thuế']) expect(html).toContain(group);
    for (const item of ['Thuế', 'Tài sản', 'Sổ sách', 'Bút toán']) expect(html).toContain(`>${item}</span>`);
  });
});

describe('SH-3: the phone header fits', () => {
  const header = (name: string | undefined, locale: 'vi' | 'en' = 'vi') =>
    render(locale, <PhoneHeader orgName={name} attention={false} onOpenMenu={() => undefined} onOpenPalette={() => undefined} />);

  it('has the search as an icon with its name for a screen reader, and no words beside it', () => {
    const vi = header(LONG_NAME);
    expect(vi).toContain(`aria-label="${viMessages.palette.open}"`);
    expect(vi).toMatch(/<button[^>]*data-testid="phone-search"/);
    expect(vi).toContain('data-slot="nav-icon"');
    expect(vi).not.toMatch(/<button[^>]*data-testid="phone-search"[^>]*>[^<]*[A-Za-zÀ-ỹ]/);
    const en = header(LONG_NAME, 'en');
    expect(en).toContain(`aria-label="${enMessages.palette.open}"`);
  });

  it('gives the org name two lines and its full name as the tooltip, instead of cutting it off', () => {
    const html = header(LONG_NAME);
    expect(html).toMatch(/data-testid="phone-org-name"/);
    expect(html).toContain('line-clamp-2');
    expect(html).not.toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*data-testid="phone-org-name"/);
    expect(html).toContain(`title="${LONG_NAME}"`);
  });

  it('keeps the menu button and the search 44px', () => {
    const html = header(LONG_NAME);
    expect(html.match(/size-11/g)?.length).toBe(2);
  });
});

describe('SH-4: 44px targets under the phone breakpoint', () => {
  it('raises every button size to 44px high, and the icon sizes to 44px wide, by min-height only', () => {
    for (const size of ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const) {
      const classes = buttonVariants({ size }).split(/\s+/);
      expect(classes, size).toContain('max-md:min-h-11');
      if (size.startsWith('icon')) expect(classes, size).toContain('max-md:min-w-11');
      // Padding and height only: the font stays as the size sets it.
      expect(classes.some((c) => c.startsWith('max-md:text-')), size).toBe(false);
    }
  });

  it('applies to every variant, so the chips and the primary buttons of Inbox and the reorder buttons of My work are covered', () => {
    for (const variant of ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const) {
      expect(buttonVariants({ variant, size: 'sm' })).toContain('max-md:min-h-11');
      expect(buttonVariants({ variant, size: 'lg' })).toContain('max-md:min-h-11');
    }
  });

  it('raises a tab (the Inbox sub-tabs) to 44px and lets its row grow with it', () => {
    const html = render(
      'vi',
      <Tabs value="a">
        <TabsList variant="line">
          <TabsTrigger value="a">Chờ duyệt</TabsTrigger>
          <TabsTrigger value="b">Đã ghi sổ</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(html.match(/max-md:min-h-11/g)?.length).toBe(2);
    expect(html).toContain('group-data-horizontal/tabs:max-md:h-auto');
  });

  it('gives the Home links the same 44px, as a class one place defines', () => {
    expect(PHONE_TARGET.split(' ')).toEqual(expect.arrayContaining(['max-md:min-h-11', 'max-md:inline-flex', 'max-md:items-center']));
    const overview = readFileSync(new URL('../src/routes/overview.tsx', import.meta.url), 'utf8');
    expect(overview.match(/PHONE_TARGET/g)?.length).toBeGreaterThanOrEqual(3); // the import and the two kinds of link
  });

  it('keeps the screen tabs and the drawer controls, which had 44px already, at 44px', () => {
    const tabs = readFileSync(new URL('../src/components/screen-tabs.tsx', import.meta.url), 'utf8');
    expect(tabs).toContain('min-h-11');
    const html = shell('/o/acme/journal');
    expect(html).toContain('min-h-11');
  });
});

describe('SH-5: bottom AccountPopover keeps active org context and uses segmented chrome toggles (#4502)', () => {
  it('puts the full org name and e-mail address in titles on the bottom account trigger in expanded sidebars, and in compact rail aria-label/title on Overview (#4519)', () => {
    const expanded = shell('/o/acme/journal');
    expect(expanded).toContain('data-testid="account-menu-trigger"');
    expect(expanded).toContain(`title="${LONG_NAME}"`);
    expect(expanded).toContain('title="chu.cong.ty@example.com"');
    expect(expanded).not.toContain('data-testid="org-menu"');
    expect(expanded).not.toContain('<details');
    expect(expanded).not.toContain('<select');

    const railOverview = shell('/o/acme/overview');
    expect(railOverview).toContain('data-testid="account-menu-trigger"');
    expect(railOverview).toContain(`title="chu.cong.ty@example.com · ${LONG_NAME}"`);
    expect(railOverview).toContain(`aria-label="Tài khoản: chu.cong.ty@example.com · ${LONG_NAME}"`);
    expect(railOverview).not.toContain('data-testid="org-menu"');
    expect(railOverview).not.toContain('<details');
    expect(railOverview).not.toContain('<select');
  });

  it('houses org switcher, icon theme toggle, VI/EN locale toggle, support/status links, and sign-out inside AccountPanel', () => {
    const orgs = [
      { orgId: '1', slug: 'acme', name: LONG_NAME },
      { orgId: '2', slug: 'beta', name: 'Beta Co' },
    ];
    for (const [locale, langLabel, themeLabel, allClients, signOutLabel] of [
      ['vi', 'Ngôn ngữ', 'Giao diện', 'Tất cả doanh nghiệp', 'Đăng xuất'],
      ['en', 'Language', 'Theme', 'All companies', 'Sign out'],
    ] as const) {
      const panel = render(
        locale,
        <AccountPanel slug="acme" orgs={orgs} email="chu.cong.ty@example.com" onSignOut={() => undefined} />,
      );
      expect(panel).toContain('data-testid="org-menu"');
      expect(panel).toContain(allClients);
      expect(panel).toContain(`>${langLabel}</span>`);
      expect(panel).toContain(`>${themeLabel}</span>`);
      expect(panel).toContain(`aria-label="${langLabel}"`);
      expect(panel).toContain(`aria-label="${themeLabel}"`);
      expect(panel).toContain('role="radiogroup"');
      expect(panel).toContain('role="radio"');
      expect(panel).toContain('max-md:min-h-11');
      expect(panel).toContain('max-md:min-w-11');
      expect(panel).toContain(signOutLabel);
      expect(panel).toContain('mailto:support@example.com');
      expect(panel).toContain('/status');
      expect(panel).not.toContain('<select');
      expect(panel).not.toContain('<details');
    }

    const singleOrgPanel = render(
      'vi',
      <AccountPanel slug="acme" orgs={orgs.slice(0, 1)} email="chu.cong.ty@example.com" onSignOut={() => undefined} />,
    );
    expect(singleOrgPanel).not.toContain('Tất cả doanh nghiệp');
  });
});

describe('SH-7: "hoa don" finds Chứng từ in Ctrl K', () => {
  const entries = (t: (label: string) => string): PaletteItem[] =>
    ALL_NAV.map((item) => ({ id: `go:${item.to}`, group: 'go' as const, label: t(item.label), ...(NAV_KEYWORDS[item.label] ? { keywords: NAV_KEYWORDS[item.label] } : {}) }));
  const vi = entries((label) => ({ documents: 'Chứng từ', salesInvoices: 'Hóa đơn bán ra', tax: 'Thuế' })[label as string] ?? label);

  it('lists the screen that holds the purchase invoices beside "Hóa đơn bán ra"', () => {
    const labels = filterPalette(vi, 'hoa don').map((e) => e.label);
    expect(labels).toContain('Chứng từ');
    expect(labels).toContain('Hóa đơn bán ra');
  });

  it('finds it with the marks typed, and in English', () => {
    expect(filterPalette(vi, 'hóa đơn').map((e) => e.label)).toContain('Chứng từ');
    expect(filterPalette(vi, 'invoice').map((e) => e.label)).toContain('Chứng từ');
  });

  it('finds the tax screens by "thue"', () => {
    expect(filterPalette(vi, 'thue').map((e) => e.label)).toContain('Thuế');
  });

  it('leaves the rest as it was: a word no keyword holds finds nothing extra', () => {
    expect(filterPalette(vi, 'chung tu').map((e) => e.label)).toContain('Chứng từ');
    expect(Object.keys(NAV_KEYWORDS).sort()).toEqual(['documents', 'tax']);
  });
});

describe('SH-8: smart 64px no-app rail and user-toggleable secondary sidebar (#4519)', () => {
  it.each(['/o/acme/overview', '/o/acme/notifications', '/o/acme/audit', '/o/acme/personal-data'])(
    'collapses %s to the 64px rail with Cmd+K, optional +, and compact account trigger in the rail',
    (path) => {
      const withQuickAdd = shell(path, 'vi', undefined, undefined, {
        mode: 'sidebar',
        onToggleSecondary: () => undefined,
        onOpenQuickCapture: () => undefined,
      });
      // No secondary 224px column or collapse button on no-app org routes.
      expect(withQuickAdd).not.toContain(`>${viMessages.palette.open}</span>`);
      expect(withQuickAdd).not.toContain('overflow-y-auto max-md:overflow-y-visible');
      expect(withQuickAdd).not.toContain('data-testid="sidebar-toggle-btn"');
      // Rail search, quick-capture, and compact account trigger carry accessible labels, titles, and focus-visible rings.
      expect(withQuickAdd).toContain('data-testid="rail-search-btn"');
      expect(withQuickAdd).toContain(`aria-label="${viMessages.palette.open} (Ctrl K)"`);
      expect(withQuickAdd).toContain(`title="${viMessages.palette.open} (Ctrl K)"`);
      expect(withQuickAdd).toContain('data-testid="shell-quick-capture-btn"');
      expect(withQuickAdd).toContain(`aria-label="${viMessages.myWork.quickCaptureTrigger}"`);
      expect(withQuickAdd).toContain('data-testid="account-menu-trigger"');
      expect(withQuickAdd).toContain('focus-visible:ring-3');

      const withoutQuickAdd = shell(path, 'en', undefined, undefined, { mode: 'sidebar' });
      expect(withoutQuickAdd).not.toContain('data-testid="shell-quick-capture-btn"');
      expect(withoutQuickAdd).toContain(`aria-label="${enMessages.palette.open} (Ctrl K)"`);
      expect(withoutQuickAdd).toContain(`aria-label="Account: chu.cong.ty@example.com · ${LONG_NAME}"`);
    },
  );

  it('renders the collapse/expand toggle on App and Settings routes and hides the secondary column when collapsed', () => {
    for (const path of ['/o/acme/journal', '/o/acme/settings']) {
      const expanded = shell(path, 'vi', undefined, undefined, {
        mode: 'sidebar',
        secondaryCollapsed: false,
        onToggleSecondary: () => undefined,
      });
      expect(expanded).toContain('data-testid="sidebar-toggle-btn"');
      expect(expanded).toContain('aria-expanded="true"');
      expect(expanded).toContain(`aria-label="${viMessages.nav.collapseSidebar}"`);
      expect(expanded).toContain(`>${viMessages.palette.open}</span>`);
      expect(expanded).not.toContain('data-testid="rail-search-btn"');

      const collapsed = shell(path, 'vi', undefined, undefined, {
        mode: 'sidebar',
        secondaryCollapsed: true,
        onToggleSecondary: () => undefined,
        onOpenQuickCapture: () => undefined,
      });
      expect(collapsed).toContain('data-testid="sidebar-toggle-btn"');
      expect(collapsed).toContain('aria-expanded="false"');
      expect(collapsed).toContain(`aria-label="${viMessages.nav.expandSidebar}"`);
      expect(collapsed).not.toContain(`>${viMessages.palette.open}</span>`);
      expect(collapsed).not.toContain('overflow-y-auto max-md:overflow-y-visible');
      expect(collapsed).toContain('data-testid="rail-search-btn"');
      expect(collapsed).toContain('data-testid="shell-quick-capture-btn"');
      expect(collapsed).toContain(`title="chu.cong.ty@example.com · ${LONG_NAME}"`);
    }

    const enCollapsed = shell('/o/acme/settings', 'en', undefined, undefined, {
      mode: 'sidebar',
      secondaryCollapsed: true,
      onToggleSecondary: () => undefined,
    });
    expect(enCollapsed).toContain(`aria-label="${enMessages.nav.expandSidebar}"`);
  });

  it('keeps mobile NavDrawer expanded on Overview and even when desktop secondaryCollapsed is true', () => {
    for (const path of ['/o/acme/overview', '/o/acme/journal', '/o/acme/settings']) {
      const drawer = shell(path, 'vi', undefined, undefined, {
        mode: 'drawer',
        secondaryCollapsed: true,
        onToggleSecondary: () => undefined,
      });
      expect(drawer).toContain(viMessages.palette.open);
      expect(drawer).toContain(`title="${LONG_NAME}"`);
      expect(drawer).toContain('title="chu.cong.ty@example.com"');
      expect(drawer).not.toContain('data-testid="sidebar-toggle-btn"');
      expect(drawer).not.toContain('data-testid="rail-search-btn"');
      expect(drawer).toContain('min-h-11');
    }
  });
});
