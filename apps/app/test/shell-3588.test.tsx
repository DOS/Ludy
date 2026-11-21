// SPDX-License-Identifier: AGPL-3.0-only
// The app shell (#3588, SH-1 to SH-7): no stale app menu on the org's own screens, a phone drawer that scrolls as one column, a header that
// fits, 44px targets under the phone breakpoint, a title on the cut-off names, and "hoa don" finding Chứng từ in Ctrl K.
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MODULE_SCREENS } from '@crove/kernel-contract';
import { buttonVariants } from '@crove/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { ALL_NAV, NAV_KEYWORDS, appOfPath, installedApps } from '../src/lib/apps.ts';
import { filterPalette, type PaletteItem } from '../src/lib/palette.ts';
import { PHONE_TARGET } from '../src/lib/touch-target.ts';

const state = vi.hoisted(() => ({ client: null as unknown as QueryClient, pathname: '/o/acme/overview' }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: Object.keys(MODULE_SCREENS), mcpEnabled: true }),
}));

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

const { ShellNav } = await import('../src/components/app-nav.tsx');
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
const shell = (pathname: string, locale: 'vi' | 'en' = 'vi') => {
  state.pathname = pathname;
  return render(
    locale,
    <ShellNav
      slug="acme"
      apps={apps}
      app={appOfPath(pathname)}
      badges={{}}
      orgs={[{ orgId: '1', slug: 'acme', name: LONG_NAME }]}
      email="chu.cong.ty@example.com"
      onOpenPalette={() => undefined}
      paletteKeys="Ctrl K"
    />,
  );
};

describe('SH-1: the org\'s own screens show no app menu', () => {
  it.each(['/o/acme/overview', '/o/acme/notifications', '/o/acme/settings', '/o/acme/audit', '/o/acme/personal-data'])('%s belongs to no app', (path) => {
    expect(appOfPath(path)).toBeNull();
  });

  it.each(['/o/acme/overview', '/o/acme/notifications', '/o/acme/settings', '/o/acme/audit', '/o/acme/personal-data'])('draws the rail and no app menu on %s, in both languages', (path) => {
    for (const locale of ['vi', 'en'] as const) {
      const html = shell(path, locale);
      // The rail is there: every app of the switcher, the overview, the bell and Settings.
      expect(html).toContain('aria-label="' + (locale === 'vi' ? 'Ứng dụng' : 'Apps') + '"');
      // No app menu: not the Cộng tác one the shell used to start with, and not any other app's.
      expect(html).not.toContain('Việc nhóm');
      expect(html).not.toContain('Team tasks');
      expect(html).not.toContain('Cộng tác</p>');
      expect(html).not.toMatch(/<section[^>]*aria-label="[^"]*(Cộng tác|Tài chính|Engage)/);
      // And no app is marked as the one in use.
      const switcher = html.slice(html.indexOf('<ul'), html.indexOf('</ul>'));
      expect(switcher).not.toContain('aria-current="true"');
    }
  });

  it('marks the rail entry of the screen itself (the overview, Settings)', () => {
    expect(shell('/o/acme/overview')).toContain('aria-current="page"');
    expect(shell('/o/acme/settings')).toContain('aria-current="page"');
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

describe('SH-5: the cut-off names have a tooltip and the selects are named', () => {
  it('puts the full org name and e-mail address in a title', () => {
    const html = shell('/o/acme/overview');
    expect(html).toContain(`title="${LONG_NAME}"`);
    expect(html).toContain('title="chu.cong.ty@example.com"');
  });

  it('shows the name of the language and theme selects above them, in both languages', () => {
    const vi = shell('/o/acme/overview');
    expect(vi).toContain('>Ngôn ngữ</span>');
    expect(vi).toContain('>Giao diện</span>');
    const en = shell('/o/acme/overview', 'en');
    expect(en).toContain('>Language</span>');
    expect(en).toContain('>Theme</span>');
    // The select keeps its own accessible name, so the visible label is not read twice.
    expect(vi).toContain('aria-label="Ngôn ngữ"');
    expect(vi).toContain('aria-label="Giao diện"');
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
