import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { NavDrawer, ShellNav } from '../components/app-nav.tsx';
import { CommandPalette, type PaletteEntry } from '../components/command-palette.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { ScreenTabs } from '../components/screen-tabs.tsx';
import { Toaster } from '../components/toaster.tsx';
import { QuickCaptureDialog } from '../components/todo-quick-add.tsx';
import { Logo, OrgLeftNotice } from '../components/ui.tsx';
import { LOCALE_NAMES, LOCALES } from '../i18n/locale.ts';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { ALL_NAV, appOfPath, installedApps, type AppId, type NavItem } from '../lib/apps.ts';
import { getConfig } from '../lib/auth.ts';
import { effectiveModules, installedItems } from '../lib/modules.ts';
import { installedModules, setOrgModules, useModulesVersion } from '../lib/org-modules.ts';
import { shellBadges, unreadNotices } from '../lib/overview.ts';
import { isPaletteShortcut, searchTerm } from '../lib/palette.ts';
import { hasOpenModalDialog, isQuickCaptureShortcut } from '../lib/quick-add.ts';
import { documentNumber } from '../lib/search.ts';
import { proposalName } from '../lib/review.ts';
import { THEMES } from '../lib/theme.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';
import { signOut } from '../lib/session-actions.ts';
import { useRouteFocus } from '../lib/route-focus.ts';
import { useScrollRoom } from '../lib/scroll-room.ts';
import { SAFETY_POLL_MS, pollEvery, useInvalidationStream, useStreamLive } from '../lib/stream-hook.ts';
import { unreadLabel } from '../lib/social-notifications.ts';
import { useNotifications } from './social-notifications.tsx';
import { useWorkNotifications } from './notifications.tsx';

// The value, once it has stayed the same for `ms`: the palette's search (#673) waits for a pause in the typing.
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function OrgLayout() {
  // The org's own apps (ADR-0053, slice d): the router read them before this screen opened; the stream's org_apps hint, or this tab's own switch, makes this read them again, and a change
  // rebuilds the menus and remounts the screen so every "is this app installed" question below it answers again. A failed read leaves the deployment's list.
  const appsLive = useStreamLive();
  const orgApps = useQuery({ ...orpc.org.apps.queryOptions(), refetchInterval: pollEvery(appsLive, 60_000, SAFETY_POLL_MS) });
  useEffect(() => {
    if (orgApps.data) setOrgModules(effectiveModules(getConfig().modules, orgApps.data.apps));
  }, [orgApps.data]);
  const modulesVersion = useModulesVersion();
  const allNav = useMemo(() => installedItems(installedModules(), ALL_NAV), [modulesVersion]); // oxlint-disable-line react-hooks/exhaustive-deps
  const allApps = useMemo(() => installedApps(installedModules()), [modulesVersion]); // oxlint-disable-line react-hooks/exhaustive-deps
  // The app of the screen (#1528), from the URL so a deep link opens in its app; on the org's own screens (Settings,
  // the chart) the menu keeps the app last used.
  const { pathname } = useLocation();
  const screenApp = appOfPath(pathname);
  // State set during render (not a ref), so a render React discards cannot leave a menu whose route never committed.
  const [lastApp, setLastApp] = useState<AppId>('teamwork');
  if (screenApp && screenApp !== lastApp) setLastApp(screenApp);
  const [menuOpen, setMenuOpen] = useState(false);
  // The phone's header sticks to the top: a control the keyboard focuses stops below it, never under it (#1575).
  const phoneHeader = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const screenName = useRouteFocus(main);
  useScrollRoom(phoneHeader, 'top');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  // A change of the apps runs the router's guards and renders the screen again (router.invalidate): a screen of an app that was just switched off goes to the overview, as one opened
  // by address does (ADR-0053 section 3), and every other screen is rendered again with the new list, keeping what its user has typed. Not on the first render.
  const router = useRouter();
  const seenVersion = useRef(modulesVersion);
  useEffect(() => {
    if (seenVersion.current === modulesVersion) return;
    seenVersion.current = modulesVersion;
    void router.invalidate();
  }, [modulesVersion, router]);
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const me = useQuery(orpc.me.get.queryOptions());
  // Hints of this org's changes (issue #69); the counts below poll only while the stream is down.
  useInvalidationStream(slug);
  const live = useStreamLive();
  const pending = useQuery({
    ...orpc.inbox.list.queryOptions({ input: { status: 'pending' } }),
    refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS),
  });
  // Social posts waiting for the viewer's review (#749) count on Social's menu item (#2234), not on the inbox. Asked of the modules, not of the
  // menu: the reports item (#2435) is the social module's but shows where crm or ads runs alone, and Social's reads answer not installed there.
  const socialOn = installedModules().includes('social');
  const reviews = useQuery({ ...orpc.social.reviewInbox.queryOptions({ input: {} }), enabled: socialOn, refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  // And what needs a person there (#771): channels to reconnect, posts that did not go out.
  const attention = useQuery({ ...orpc.social.attentionInbox.queryOptions({ input: {} }), enabled: socialOn, refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  // And background work that failed (#1720), which only owners and admins see.
  const roleHere = me.data?.orgs.find((o) => o.slug === slug)?.role;
  // HR holds the people payroll is run for: owners and admins only (the queries and the database refuse everyone else too), so nobody else is offered its app or its palette entry.
  const managerHere = roleHere === 'owner' || roleHere === 'admin';
  // Items left out of the menu and the palette for a viewer who cannot use them (#3225): the AI budgets are for owners and admins, and the AI connections
  // exist only where this system runs MCP. Their screens still answer anyone who types the address.
  const hidden = (item: NavItem) => (item.module === 'hr' && !managerHere) || (item.label === 'aiUsage' && !managerHere) || (item.label === 'aiConnections' && !getConfig().mcpEnabled);
  const NAV = useMemo(() => allNav.filter((n) => !hidden(n)), [allNav, managerHere]); // oxlint-disable-line react-hooks/exhaustive-deps
  const apps = useMemo(
    () =>
      allApps
        .filter((a) => managerHere || a.id !== 'hr')
        .map((a) => ({ ...a, groups: a.groups.map((g) => ({ ...g, items: g.items.filter((i) => !hidden(i)) })).filter((g) => g.items.length > 0) })),
    [allApps, managerHere], // oxlint-disable-line react-hooks/exhaustive-deps
  );
  const failedJobs = useQuery({
    ...orpc.inbox.raised.queryOptions({ input: {} }),
    enabled: roleHere === 'owner' || roleHere === 'admin',
    refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS),
  });
  const menuBadges = shellBadges({
    pending: pending.data?.length ?? 0,
    attention: socialOn ? (attention.data?.total ?? 0) : 0,
    failedJobs: failedJobs.data?.total ?? 0,
    reviews: socialOn ? (reviews.data?.total ?? 0) : 0,
  });
  // The member's unread notifications (#637), where Social runs.
  const notifications = useNotifications(socialOn);
  const unread = unreadLabel(notifications.data?.unread ?? 0);
  // The kernel's and finance's (#671).
  const work = useWorkNotifications();
  // The bell counts what Home counts (#3591): a notice that a proposal waits is that proposal, already on the Inbox badge and in Home's list.
  const workUnread = unreadLabel(unreadNotices(work.data) ?? 0);
  const org = me.data?.orgs.find((o) => o.slug === slug);
  const tp = useTranslations('palette');
  const tmw = useTranslations('myWork');
  const f = useFormat();
  const { locale, setLocale } = useLocaleSetting();
  const [theme, setTheme] = useThemeSetting();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  // The org's search (#673): parties, documents and journal entries for what is typed in the palette, where finance runs;
  // and the notes the member may read, where notes runs (#1675).
  const financeOn = NAV.some((n) => n.module === 'finance');
  const notesOn = installedModules().includes('notes');
  const canQuickCapture = notesOn && me.isSuccess && Boolean(org) && roleHere !== 'viewer';
  const [paletteQuery, setPaletteQuery] = useState('');
  const typed = (financeOn || notesOn) && paletteOpen ? searchTerm(paletteQuery) : null;
  const term = useSettled(typed, 250);
  // Documents and journal entries of the entity chosen in the shell (#1280), where the results link to.
  const entity = useChosenEntity();
  const found = useQuery({
    ...orpc.search.query.queryOptions({ input: { q: term ?? '', legalEntityId: entity.legalEntityId } }),
    enabled: financeOn && entity.ready && term !== null && term === typed,
    staleTime: 30_000,
  });
  // Words typed without marks find them ("hoa don" finds "hóa đơn"); the server's row policies keep other members'
  // private notes out.
  const notesFound = useQuery({
    ...orpc.notes.search.queryOptions({ input: { q: term ?? '', limit: 8 } }),
    enabled: notesOn && term !== null && term === typed,
    staleTime: 30_000,
  });
  const searchState =
    typed === null
      ? 'idle'
      : (financeOn && found.isError) || (notesOn && notesFound.isError)
        ? 'failed'
        : term !== typed || (financeOn && (!entity.ready || found.isFetching)) || (notesOn && notesFound.isFetching)
          ? 'searching'
          : 'idle';
  const paletteKeys = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K';

  // Ctrl K (Cmd K on a Mac) opens or closes the command palette from any screen of the org.
  // Alt+Q opens the quick capture modal when the notes module is active and focus is not in an editable field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (
        isQuickCaptureShortcut(event, {
          notesEnabled: notesOn,
          authenticated: me.isSuccess && Boolean(org),
          canWrite: roleHere !== 'viewer',
          modalOpen: hasOpenModalDialog(typeof document !== 'undefined' ? document : null),
          activeElement: typeof document !== 'undefined' ? document.activeElement : null,
        })
      ) {
        event.preventDefault();
        setMenuOpen(false);
        setPaletteOpen(false);
        setQuickCaptureOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesOn, me.isSuccess, org, roleHere]);

  const paletteEntries = useMemo<PaletteEntry[]>(
    () => [
      ...NAV.map((item) => ({
        id: `go:${item.to}`,
        group: 'go' as const,
        label: t(item.label),
        run: () => void navigate({ to: item.to, params: { slug } }),
      })),
      ...((socialOn ? reviews.data?.items : undefined) ?? []).map((item) => ({
        id: `social-review:${item.postId}`,
        group: 'proposals' as const,
        label: item.title || item.excerpt,
        detail: item.channels.map((c) => c.displayName).join(', '),
        run: () => void navigate({ to: '/o/$slug/social/$id', params: { slug, id: item.postId } }),
      })),
      ...(pending.data ?? []).map((item) => ({
        id: `proposal:${item.id}`,
        group: 'proposals' as const,
        label: proposalName(item),
        detail: `${item.title}, ${f.money(item.total)}`,
        run: () => void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: item.id } }),
      })),
      ...(me.data?.orgs ?? [])
        .filter((o) => o.slug !== slug)
        .map((o) => ({
          id: `org:${o.slug}`,
          group: 'orgs' as const,
          label: tp('switchOrg', { name: o.name }),
          run: () => void navigate({ to: '/o/$slug/overview', params: { slug: o.slug } }),
        })),
      ...LOCALES.filter((l) => l !== locale).map((l) => ({
        id: `locale:${l}`,
        group: 'actions' as const,
        label: tp('switchLocale', { name: LOCALE_NAMES[l] }),
        keywords: 'language ngon ngu',
        run: () => setLocale(l),
      })),
      ...THEMES.filter((th) => th !== theme).map((th) => ({
        id: `theme:${th}`,
        group: 'actions' as const,
        label: tp('switchTheme', { name: tc(`themes.${th}`) }),
        keywords: 'theme giao dien sang toi dark light',
        run: () => setTheme(th),
      })),
      ...(canQuickCapture
        ? [
            {
              id: 'quick-capture',
              group: 'actions' as const,
              label: tmw('quickCapturePalette'),
              keywords: 'todo viec nhanh quick capture alt q',
              run: () => setQuickCaptureOpen(true),
            },
          ]
        : []),
      { id: 'sign-out', group: 'actions' as const, label: tc('signOut'), run: () => void signOut() },
    ],
    [NAV, pending.data, reviews.data, socialOn, me.data, slug, locale, theme, canQuickCapture, t, tp, tmw, tc, f, navigate, setLocale, setTheme],
  );
  const foundEntries = useMemo<PaletteEntry[]>(() => {
    const settled = typed !== null && term === typed;
    const notes = (settled && notesOn ? notesFound.data : undefined) ?? [];
    const noteEntries = notes.map((n) => ({
      id: `note:${n.id}`,
      group: 'notes' as const,
      label: n.title,
      detail: tp(n.visibility === 'private' ? 'notePrivate' : 'noteShared'),
      run: () => void navigate({ to: '/o/$slug/notes', params: { slug }, search: { note: n.id } }),
    }));
    const data = settled && financeOn ? found.data : undefined;
    if (!data) return noteEntries;
    return [
      ...data.parties.map((p) => ({
        id: `party:${p.id}`,
        group: 'parties' as const,
        label: p.name,
        ...(p.taxCode ? { detail: tp('taxCode', { code: p.taxCode }) } : {}),
        // A customer that never sold to the org is not among the vendors: its invoices are with the documents.
        run: () =>
          void (p.customerOnly
            ? navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: p.name } })
            : navigate({ to: '/o/$slug/vendors', params: { slug }, search: { q: p.taxCode ?? p.name } })),
      })),
      ...data.documents.map((d) => ({
        id: `document:${d.id}`,
        group: 'documents' as const,
        label: documentNumber(d),
        detail: [
          d.direction === 'sale' ? tp('saleDocument') : null,
          d.voided ? tp('voidedDocument') : null,
          tp('documentDetail', { party: d.partyName, date: f.date(d.issueDate), total: f.money(d.total) }),
        ]
          .filter(Boolean)
          .join(', '),
        // The approved proposal shows the invoice with its file; a document without one opens in the list.
        run: () =>
          void (d.proposalId
            ? navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: d.proposalId } })
            : navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: d.number } })),
      })),
      ...data.entries.map((e) => ({
        id: `entry:${e.id}`,
        group: 'entries' as const,
        label: e.description,
        detail: tp('entryDetail', { date: f.date(e.entryDate), amount: f.money(e.amount) }),
        run: () => void navigate({ to: '/o/$slug/journal', params: { slug }, search: { from: e.entryDate, to: e.entryDate }, hash: `entry-${e.id}` }),
      })),
      ...noteEntries,
    ];
  }, [found.data, notesFound.data, financeOn, notesOn, typed, term, slug, tp, f, navigate]);

  // The count on a tab: the pending proposals on Chứng từ's first tab.
  const tabBadges = { inbox: menuBadges.inbox };

  const shellNav = (onNavigate?: () => void) => (
    <ShellNav
      slug={slug}
      apps={apps}
      app={screenApp ?? lastApp}
      inApp={screenApp !== null}
      // The pending count sits on the Documents item, whose first tab is "Chờ duyệt" (#3225).
      badges={{ documents: menuBadges.inbox, social: menuBadges.social, alerts: workUnread, socialNotifications: unread }}
      orgs={me.data?.orgs ?? []}
      email={me.data?.email}
      onOpenPalette={() => {
        onNavigate?.();
        setPaletteOpen(true);
      }}
      paletteKeys={paletteKeys}
      onOpenQuickCapture={
        canQuickCapture
          ? () => {
              onNavigate?.();
              setQuickCaptureOpen(true);
            }
          : undefined
      }
      {...(onNavigate ? { onNavigate } : {})}
    />
  );

  return (
    <div className="flex min-h-full bg-background">
      {/* The first stop of the keyboard (WCAG 2.4.1, #2115): fixed, so the sticky phone header never covers it. */}
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-lg focus-visible:border focus-visible:border-ring focus-visible:bg-background focus-visible:px-4 focus-visible:py-3 focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {t('skipToContent')}
      </a>
      {/* Names the new screen to a screen reader after a navigation (#2115). */}
      <div role="status" aria-live="polite" data-route-announcer className="sr-only">
        <span key={screenName.seq}>{screenName.name}</span>
      </div>
      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r bg-sidebar md:flex">{shellNav()}</aside>
      <div className="min-w-0 flex-1">
        {/* The phone's header (issue #1245): the menu button, the org's name and the palette; the rest is in the drawer. */}
        <header ref={phoneHeader} className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label={t('openMenu')}
            className="relative grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <NavIcon name="menu" className="size-5" />
            {menuBadges.inbox !== null && <span className="absolute top-2 right-2 size-2 rounded-full bg-primary" aria-hidden="true" />}
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{org?.name ?? <Logo />}</span>
          <button type="button" onClick={() => setPaletteOpen(true)} className="min-h-11 rounded-lg border px-2 text-xs text-subtle-foreground">
            {tp('open')}
          </button>
        </header>
        <NavDrawer open={menuOpen} onOpenChange={setMenuOpen}>
          {shellNav(() => setMenuOpen(false))}
        </NavDrawer>
        {/* Focusable from code only: where the focus goes when the toast that held it leaves (#2026). */}
        <main ref={main} id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none md:px-8 md:py-8">
          <OrgLeftNotice />
          <ScreenTabs slug={slug} installed={NAV} badges={tabBadges} />
          {me.isSuccess && !org ? <p className="text-sm text-destructive">{t('notMember')}</p> : <Outlet />}
        </main>
        <Toaster />
        <CommandPalette
          entries={paletteEntries}
          found={foundEntries}
          search={searchState}
          onQueryChange={setPaletteQuery}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
        />
        {canQuickCapture && <QuickCaptureDialog slug={slug} open={quickCaptureOpen} onOpenChange={setQuickCaptureOpen} />}
      </div>
    </div>
  );
}
