// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR checks for Global Top Bar (#4926): fixed cluster order, module/role quick-create gating,
// Vy permission & AI budget meter degradation, and accessible landmarks.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { buildQuickCreateItems } from '../src/lib/quick-create.ts';
import { canUseVy, resolveVyDrawerStatus, showTopBarAiPill } from '../src/lib/vy.ts';

const apiState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'finance', 'notes', 'projects', 'crm', 'sign'], supportUrl: 'mailto:support@example.com' }),
}));

vi.mock('../src/lib/api-base.ts', () => ({
  serverOrigin: () => 'https://app.ludy.vn',
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode } & Record<string, unknown>) => {
    const { activeOptions: _a, search: _s, ...anchor } = rest;
    return (
      <a href={to.replace('$slug', params?.slug ?? '')} {...anchor}>
        {children}
      </a>
    );
  },
  useParams: () => ({ slug: 'acme' }),
  useLocation: () => ({ pathname: '/o/acme/overview' }),
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  apiState.current = new QC({ defaultOptions: { queries: { retry: false } } });
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
  return { orpc: node([]), client: node([]), clientForOrg: () => node([]), queryClient: apiState.current, errorMessage: String };
});

const { GlobalTopBar } = await import('../src/components/global-top-bar.tsx');
const { PhoneHeader } = await import('../src/components/phone-header.tsx');
const { VyDrawerBody } = await import('../src/components/vy-drawer.tsx');

function render(locale: 'vi' | 'en', node: React.ReactNode): string {
  apiState.current.clear();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={apiState.current}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

const meterOk: AiMeter = { aiOn: true, percent: 42, state: 'ok', scope: 'org', resetAt: '2026-12-01T00:00:00Z' };
const meterStop: AiMeter = { aiOn: true, percent: 100, state: 'stop', scope: 'org', resetAt: '2026-12-01T00:00:00Z' };
const meterOff: AiMeter = { aiOn: false, percent: null, state: 'none', scope: null, resetAt: '2026-12-01T00:00:00Z' };

describe('buildQuickCreateItems', () => {
  it('returns empty for viewer regardless of enabled modules', () => {
    expect(
      buildQuickCreateItems({
        modules: ['kernel', 'finance', 'notes', 'projects', 'crm', 'sign'],
        role: 'viewer',
        canCreateTeamTask: true,
        canQuickCapture: true,
      }),
    ).toEqual([]);
  });

  it('includes module-gated write items for member/admin/owner and omits disabled modules', () => {
    const all = buildQuickCreateItems({
      modules: ['kernel', 'finance', 'notes', 'projects', 'crm', 'sign'],
      role: 'owner',
      canCreateTeamTask: true,
      canQuickCapture: true,
    });
    expect(all.map((i) => i.id)).toEqual([
      'uploadDocument',
      'quickCapture',
      'newTeamTask',
      'newNote',
      'newContact',
      'newDeal',
      'newSignEnvelope',
    ]);

    const minimalMember = buildQuickCreateItems({
      modules: ['kernel', 'finance'],
      role: 'member',
      canCreateTeamTask: false,
      canQuickCapture: false,
    });
    expect(minimalMember.map((i) => i.id)).toEqual(['uploadDocument']);
  });
});

describe('vy helpers', () => {
  it('checks vy.use permission explicitly', () => {
    expect(canUseVy(['vy.use', 'finance.proposal.approve'])).toBe(true);
    expect(canUseVy(['finance.proposal.approve'])).toBe(false);
    expect(canUseVy(undefined)).toBe(false);
  });

  it('resolves drawer states for missing permission, AI off, budget stop, and ready', () => {
    expect(resolveVyDrawerStatus({ canUseVy: false, permissionsLoaded: true, meter: meterOk })).toBe('noPermission');
    expect(resolveVyDrawerStatus({ canUseVy: false, permissionsLoaded: false, meter: undefined })).toBe('ready');
    expect(resolveVyDrawerStatus({ canUseVy: true, permissionsLoaded: true, meter: meterOff })).toBe('aiOff');
    expect(resolveVyDrawerStatus({ canUseVy: true, permissionsLoaded: true, meter: meterStop })).toBe('budgetStop');
    expect(resolveVyDrawerStatus({ canUseVy: true, permissionsLoaded: true, meter: meterOk })).toBe('ready');
  });

  it('controls compact AI budget pill visibility', () => {
    expect(showTopBarAiPill(undefined)).toBe(false);
    expect(showTopBarAiPill(meterOff)).toBe(false);
    expect(showTopBarAiPill({ aiOn: true, state: 'ok', percent: null })).toBe(false);
    expect(showTopBarAiPill(meterOk)).toBe(true);
    expect(showTopBarAiPill(meterStop)).toBe(true);
  });
});

describe('GlobalTopBar and VyDrawerBody SSR', () => {
  it('maintains fixed right cluster order across Home, Notifications, Apps, and Settings', () => {
    const items = buildQuickCreateItems({
      modules: ['kernel', 'finance', 'notes', 'projects'],
      role: 'owner',
      canCreateTeamTask: true,
      canQuickCapture: true,
    });
    for (const [pathname, hasSecondary] of [
      ['/o/acme/overview', false],
      ['/o/acme/notifications', false],
      ['/o/acme/journal', true],
      ['/o/acme/settings', true],
    ] as const) {
      const html = render(
        'vi',
        <GlobalTopBar
          slug="acme"
          pathname={pathname}
          hasSecondary={hasSecondary}
          secondaryCollapsed={false}
          onToggleSecondary={hasSecondary ? () => undefined : undefined}
          onOpenPalette={() => undefined}
          paletteKeys="Ctrl K"
          quickCreateItems={items}
          onOpenQuickCapture={() => undefined}
          vyOpen={false}
          onOpenVy={() => undefined}
          canUseVy
          gmName="Vy"
          unreadNotices="3"
          aiMeter={meterOk}
          canViewAiBudgets
          orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
          email="owner@example.com"
        />,
      );
      expect(html).toContain('<header');
      expect(html).not.toContain('<nav');
      const idxVy = html.indexOf('data-testid="topbar-vy-btn"');
      const idxPlus = html.indexOf('data-testid="shell-quick-capture-btn"');
      const idxBell = html.indexOf('data-testid="topbar-notifications-link"');
      const idxSettings = html.indexOf('data-testid="topbar-settings-link"');
      const idxAi = html.indexOf('data-testid="topbar-ai-meter"');
      const idxAccount = html.indexOf('data-testid="account-menu-trigger"');
      expect(idxVy).toBeGreaterThan(-1);
      expect(idxPlus).toBeGreaterThan(idxVy);
      expect(idxBell).toBeGreaterThan(idxPlus);
      expect(idxSettings).toBeGreaterThan(idxBell);
      expect(idxAi).toBeGreaterThan(idxSettings);
      expect(idxAccount).toBeGreaterThan(idxAi);
      expect(html).toContain('data-testid="topbar-notifications-badge"');
      expect(html).toContain('href="/o/acme/ai-usage"');
      expect(html).toContain('Ngân sách AI tháng này: 42%');
      // Controls with visible text avoid mismatched aria-label overrides (WCAG 2.5.3).
      expect(html).not.toMatch(/data-testid="topbar-search-btn"[^>]*aria-label=/);
      expect(html).not.toMatch(/data-testid="topbar-vy-btn"[^>]*aria-label=/);
      expect(html).not.toMatch(/data-testid="topbar-ai-meter"[^>]*aria-label=/);
      expect(html).toContain('<span class="sr-only">Hỏi Vy</span>');
    }
  });

  it('renders non-link AI pill for members, hides AI pill when AI is off, and flags missing vy.use cleanly', () => {
    const memberHtml = render(
      'en',
      <GlobalTopBar
        slug="acme"
        pathname="/o/acme/overview"
        hasSecondary={false}
        secondaryCollapsed={false}
        onOpenPalette={() => undefined}
        paletteKeys="Ctrl K"
        quickCreateItems={[]}
        vyOpen={false}
        onOpenVy={() => undefined}
        canUseVy={false}
        gmName="Vy"
        unreadNotices={null}
        aiMeter={meterOk}
        canViewAiBudgets={false}
        orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
        email="member@example.com"
      />,
    );
    expect(memberHtml).toContain('data-vy-allowed="false"');
    expect(memberHtml).not.toContain('data-testid="shell-quick-capture-btn"');
    expect(memberHtml).toContain('data-testid="topbar-ai-meter"');
    expect(memberHtml).not.toContain('href="/o/acme/ai-usage"');
    const meterSpan = memberHtml.match(/<span[^>]*data-testid="topbar-ai-meter"[^>]*>.*?<\/span><\/span>/s)?.[0]
      ?? memberHtml.slice(memberHtml.indexOf('<span title="Monthly AI budget: 42%"'));
    expect(meterSpan).toContain('data-testid="topbar-ai-meter"');
    expect(meterSpan).not.toMatch(/<span[^>]*data-testid="topbar-ai-meter"[^>]*aria-label=/);
    expect(meterSpan).toContain('title="Monthly AI budget: 42%"');
    expect(meterSpan).toContain('<span aria-hidden="true">AI 42%</span>');
    expect(meterSpan).toContain('<span class="sr-only">Monthly AI budget: 42%</span>');

    const aiOffHtml = render(
      'vi',
      <GlobalTopBar
        slug="acme"
        pathname="/o/acme/overview"
        hasSecondary={false}
        secondaryCollapsed={false}
        onOpenPalette={() => undefined}
        paletteKeys="Ctrl K"
        quickCreateItems={[]}
        vyOpen={false}
        onOpenVy={() => undefined}
        canUseVy
        gmName="Vy"
        unreadNotices={null}
        aiMeter={meterOff}
        canViewAiBudgets
        orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
        email="owner@example.com"
      />,
    );
    expect(aiOffHtml).toContain('data-ai-state="off"');
    expect(aiOffHtml).not.toContain('data-testid="topbar-ai-meter"');
  });

  it('renders VyDrawerBody states and role/module-aware shortcuts', () => {
    const noPerm = render(
      'vi',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy={false}
        permissionsLoaded
        canViewAiBudgets={false}
        aiMeter={meterOk}
        todayItems={[]}
        role="member"
        modules={['kernel', 'notes', 'finance']}
      />,
    );
    expect(noPerm).toContain('data-testid="vy-drawer-no-permission"');
    expect(noPerm).not.toContain('href="/o/acme/ai-usage"');
    expect(noPerm).not.toContain('href="/o/acme/my-work"');

    const aiOff = render(
      'en',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets
        aiMeter={meterOff}
        todayItems={[]}
        role="owner"
        modules={['kernel', 'notes', 'finance']}
      />,
    );
    expect(aiOff).toContain('data-testid="vy-drawer-ai-off"');
    expect(aiOff).toContain('href="/o/acme/my-work"');
    expect(aiOff).toContain('href="/o/acme/inbox"');
    expect(aiOff).toContain('href="/o/acme/ai-usage"');

    const budgetStop = render(
      'vi',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets
        aiMeter={meterStop}
        todayItems={[]}
        role="owner"
        modules={['kernel']}
      />,
    );
    expect(budgetStop).toContain('data-testid="vy-drawer-budget-stop"');
    expect(budgetStop).toContain('href="/o/acme/ai-usage"');

    const ready = render(
      'vi',
      <VyDrawerBody
        slug="acme"
        open={false}
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets
        aiMeter={meterOk}
        todayItems={[]}
        role="owner"
        modules={['kernel']}
      />,
    );
    expect(ready).toContain('data-testid="vy-drawer-ready"');
    expect(ready).toContain('data-testid="vy-drawer-today-summary"');

    const loading = render(
      'vi',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets={false}
        aiMeter={meterOk}
        todayItems={[]}
        todayLoading
        role="member"
        modules={['kernel']}
      />,
    );
    expect(loading).toContain('data-testid="vy-drawer-today-loading"');
    expect(loading).not.toContain('data-testid="vy-drawer-today-summary"');

    const errored = render(
      'en',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets={false}
        aiMeter={meterOk}
        todayItems={[]}
        todayError="Network unavailable"
        role="member"
        modules={['kernel']}
      />,
    );
    expect(errored).toContain('data-testid="vy-drawer-today-error"');
    expect(errored).toContain('Network unavailable');
    expect(errored).not.toContain('data-testid="vy-drawer-today-summary"');
  });

  it('avoids duplicate Ludy SVG mark in PhoneHeader while orgName is still undefined', () => {
    const html = render(
      'vi',
      <PhoneHeader
        slug="acme"
        orgName={undefined}
        attention={false}
        onOpenMenu={() => undefined}
        onOpenPalette={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="phone-home-link"');
    expect(html).toContain('min-w-11');
    // Only the phone-home-link renders the brand keycap mark SVG (menu + search use nav-icon SVGs).
    expect(html.match(/viewBox="0 0 92 92"/g)?.length).toBe(1);
  });
});
