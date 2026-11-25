import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate, useParams, useRouter, useRouterState } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { COWORKER_ROSTER } from '@ludy/kernel-contract';
import { cn } from '@ludy/ui/lib/utils';
import { NavDrawer, ShellNav } from '../components/app-nav.tsx';
import { GlobalTopBar } from '../components/global-top-bar.tsx';
import { PhoneHeader } from '../components/phone-header.tsx';
import { CommandPalette, type PaletteEntry } from '../components/command-palette.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { ScreenTabs } from '../components/screen-tabs.tsx';
import { QuickCaptureDialog } from '../components/todo-quick-add.tsx';
import { OrgLeftNotice } from '../components/ui.tsx';
import { VyDrawer } from '../components/vy-drawer.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { agentPermissions, aiConnectionsVisible } from '../lib/agents.ts';
import { orpc, errorMessage } from '../lib/api.ts';
import { ALL_NAV, NAV_KEYWORDS, SETTINGS_ITEMS, appOfPath, installedApps, isShellItemHidden, visibleApps } from '../lib/apps.ts';
import { getConfig } from '../lib/auth.ts';
import { effectiveModules, installedItems } from '../lib/modules.ts';
import { installedModules, setOrgModules, useModulesVersion } from '../lib/org-modules.ts';
import { shellBadges, unreadNotices } from '../lib/overview.ts';
import { isPaletteShortcut, searchTerm } from '../lib/palette.ts';
import { buildQuickActionEntries, buildRecentPaletteEntries } from '../lib/palette-entries.ts';
import {
  detailSectionKeyForPath,
  isRecentItemVisible,
  normalizeOrgRelativePath,
  recordRecentItem,
  stripSearchAndHash,
  useRecentItems,
} from '../lib/palette-recents.ts';
import { hasOpenModalDialog, isQuickCaptureShortcut } from '../lib/quick-add.ts';
import { buildQuickCreateItems } from '../lib/quick-create.ts';
import { currentScreenName, subscribeScreenName } from '../lib/screen-title.ts';
import { documentNumber } from '../lib/search.ts';
import { proposalName } from '../lib/review.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';
import { signOut } from '../lib/session-actions.ts';
import { hasSecondaryNav, isSidebarToggleShortcut, useSidebarCollapsed } from '../lib/sidebar-rail.ts';
import { useRouteFocus } from '../lib/route-focus.ts';
import { useScrollRoom } from '../lib/scroll-room.ts';
import { SAFETY_POLL_MS, pollEvery, useInvalidationStream, useStreamLive } from '../lib/stream-hook.ts';
import { unreadLabel } from '../lib/social-notifications.ts';
import { canUseVyAssistant } from '../lib/vy.ts';
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
  const settingsItems = useMemo(() => installedItems(installedModules(), SETTINGS_ITEMS), [modulesVersion]); // oxlint-disable-line react-hooks/exhaustive-deps
  // The app of the screen (#1528), from the URL so a deep link opens in its app. Overview, Notifications, Audit and Personal data
  // belong to no app: the shell shows the rail and no secondary menu there (#3588). Settings shows its own sub-page menu (#4499).
  const { pathname } = useLocation();
  const resolvedPathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const screenApp = appOfPath(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  // The active top header sticks to the top: a control the keyboard focuses stops below it, never under it (#1575, #4926).
  const topChrome = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const screenName = useRouteFocus(main);
  useScrollRoom(topChrome, 'top');
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
  // HR payroll/admin screens stay restricted to owners and admins, while Cổng nhân viên (`hrMy`) is open to org members too (viewers still see none).
  const managerHere = roleHere === 'owner' || roleHere === 'admin';
  const hrMemberHere = managerHere || roleHere === 'member';
  const showAiConnections = aiConnectionsVisible(getConfig().mcpEnabled);
  const visibility = { manager: managerHere, hrMember: hrMemberHere, showAiConnections };
  // Items left out of the menu and the palette for a member/viewer who cannot use them (#3225): the AI budgets are for owners and admins, and the AI connections
  // exist only where this system runs MCP. Their screens still answer anyone who types the address.
  const NAV = useMemo(() => allNav.filter((n) => !isShellItemHidden(n, visibility)), [allNav, managerHere, hrMemberHere, showAiConnections]); // oxlint-disable-line react-hooks/exhaustive-deps
  const apps = useMemo(() => visibleApps(allApps, visibility), [allApps, managerHere, hrMemberHere, showAiConnections]); // oxlint-disable-line react-hooks/exhaustive-deps
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
  const [vyDrawerOpen, setVyDrawerOpen] = useState(false);
  const [userCollapsed, setUserCollapsed] = useSidebarCollapsed();
  const secondarySidebarRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const hasSecondary = hasSecondaryNav(screenApp, apps, pathname);
  const sidebarCollapsed = !hasSecondary || userCollapsed;
  useEffect(() => {
    setVyDrawerOpen(false);
  }, [slug]);
  // The org's search (#673): parties, documents and journal entries for what is typed in the palette, where finance runs;
  // and the notes the member may read, where notes runs (#1675).
  const financeOn = NAV.some((n) => n.module === 'finance');
  const notesOn = installedModules().includes('notes');
  const canQuickCapture = notesOn && me.isSuccess && Boolean(org) && roleHere !== 'viewer';
  const canCreateTeamTask = me.isSuccess && Boolean(org) && agentPermissions(roleHere).tasks;
  const orgDetail = useQuery({ ...orpc.org.get.queryOptions(), enabled: Boolean(org) });
  const aiMeter = useQuery({
    ...orpc.ai.meter.queryOptions({ input: {} }),
    enabled: Boolean(org),
    refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS),
    staleTime: 15_000,
  });
  const vyToday = useQuery({ ...orpc.today.list.queryOptions(), enabled: vyDrawerOpen && Boolean(org) });
  const canUseVy = canUseVyAssistant(orgDetail.data?.permissions);
  const canViewAiBudgets = agentPermissions(roleHere).budgets;
  const gmName = vyToday.data?.coworkers.gm ?? COWORKER_ROSTER.gm;
  const quickCreateItems = useMemo(
    () => buildQuickCreateItems({ modules: installedModules(), role: roleHere, canCreateTeamTask, canQuickCapture }),
    [modulesVersion, roleHere, canCreateTeamTask, canQuickCapture], // oxlint-disable-line react-hooks/exhaustive-deps
  );
  const orgIdHere = org?.orgId;
  const userIdHere = me.data?.userId;
  const recentScope = useMemo(
    () => ({ orgId: orgIdHere, userId: userIdHere }),
    [orgIdHere, userIdHere],
  );
  const recentItems = useRecentItems(me.isSuccess && orgIdHere ? slug : '', recentScope);
  const suppressedPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    const suppressed = suppressedPathnameRef.current;
    suppressedPathnameRef.current = null;
    if (!me.isSuccess || !orgIdHere) return;
    const relativePath = normalizeOrgRelativePath(resolvedPathname, slug);
    if (!relativePath) return;
    if (!isRecentItemVisible({ path: relativePath }, { modules: installedModules(), visibility: { manager: managerHere, hrMember: hrMemberHere, showAiConnections } })) {
      return;
    }
    if (suppressed === relativePath.toLowerCase()) return;
    let recordedLabel: string | null = null;
    const tryRecord = () => {
      const name = currentScreenName()?.trim();
      if (!name || name === recordedLabel) return;
      recordedLabel = name;
      const isDetailRecord = detailSectionKeyForPath(relativePath) !== null;
      recordRecentItem(
        slug,
        {
          id: relativePath,
          path: relativePath,
          label: name,
          kind: isDetailRecord ? 'record' : 'screen',
        },
        { orgId: orgIdHere, userId: userIdHere },
      );
    };
    tryRecord();
    return subscribeScreenName(tryRecord);
  }, [slug, orgIdHere, userIdHere, me.isSuccess, resolvedPathname, modulesVersion, managerHere, hrMemberHere, showAiConnections]);

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
  // `[` toggles the desktop secondary sidebar menu when the route owns one and focus is not in an editable field.
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
        return;
      }
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      if (
        isSidebarToggleShortcut(event, {
          hasSecondary,
          modalOpen: paletteOpen || quickCaptureOpen || menuOpen || vyDrawerOpen || hasOpenModalDialog(typeof document !== 'undefined' ? document : null),
          isDesktop: typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(min-width: 768px)').matches,
          activeElement,
        })
      ) {
        event.preventDefault();
        const collapsingFromSecondary =
          !sidebarCollapsed &&
          Boolean(activeElement) &&
          Boolean(secondarySidebarRef.current?.contains(activeElement));
        setUserCollapsed((prev) => !prev);
        if (collapsingFromSecondary) {
          requestAnimationFrame(() => sidebarToggleRef.current?.focus());
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesOn, me.isSuccess, org, roleHere, hasSecondary, paletteOpen, quickCaptureOpen, menuOpen, vyDrawerOpen, setUserCollapsed]);

  const recentEntries = useMemo<PaletteEntry[]>(
    () =>
      buildRecentPaletteEntries({
        items: recentItems,
        modules: installedModules(),
        visibility: { manager: managerHere, hrMember: hrMemberHere, showAiConnections },
        tNav: t,
        onVisit: (item) => {
          const targetPathname = stripSearchAndHash(item.path).toLowerCase();
          const currentRelative = normalizeOrgRelativePath(resolvedPathname, slug)?.toLowerCase();
          if (item.path.toLowerCase() !== targetPathname && currentRelative !== targetPathname) {
            suppressedPathnameRef.current = targetPathname;
          }
          recordRecentItem(
            slug,
            {
              id: item.id,
              path: item.path,
              label: item.label,
              ...(item.detail ? { detail: item.detail } : {}),
              kind: item.kind,
            },
            { orgId: orgIdHere, userId: userIdHere },
          );
          void navigate({ href: `/o/${encodeURIComponent(slug)}${item.path}` });
        },
      }),
    [recentItems, modulesVersion, managerHere, hrMemberHere, showAiConnections, t, resolvedPathname, slug, orgIdHere, userIdHere, navigate], // oxlint-disable-line react-hooks/exhaustive-deps
  );

  const paletteEntries = useMemo<PaletteEntry[]>(
    () => [
      ...recentEntries,
      ...NAV.map((item) => ({
        id: `go:${item.to}`,
        group: 'go' as const,
        label: t(item.label),
        ...(NAV_KEYWORDS[item.label] ? { keywords: NAV_KEYWORDS[item.label] } : {}),
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
      ...buildQuickActionEntries({
        slug,
        orgs: me.data?.orgs ?? [],
        currentOrgName: org?.name,
        locale,
        theme,
        canQuickCapture,
        canCreateTeamTask,
        strings: {
          newTask: tp('newTask'),
          quickCapturePalette: tmw('quickCapturePalette'),
          tasksLabel: t('tasks'),
          switchThemeAction: tp('switchThemeAction'),
          switchOrgAction: tp('switchOrgAction'),
          currentChoice: tp('currentChoice'),
          switchOrg: (name) => tp('switchOrg', { name }),
          switchLocale: (name) => tp('switchLocale', { name }),
          allClients: t('allClients'),
          addOrg: t('addOrg'),
          themeName: (th) => tc(`themes.${th}`),
          signOut: tc('signOut'),
        },
        onQuickCapture: () => setQuickCaptureOpen(true),
        onNewTeamTask: () => void navigate({ to: '/o/$slug/tasks', params: { slug }, search: { new: '1' } }),
        onSwitchOrg: (orgSlug) => void navigate({ to: '/o/$slug/overview', params: { slug: orgSlug } }),
        onOpenClients: () => void navigate({ to: '/clients' }),
        onAddOrg: () => void navigate({ to: '/onboarding' }),
        onSetLocale: setLocale,
        onSetTheme: setTheme,
        onSignOut: () => void signOut(),
      }),
    ],
    [recentEntries, NAV, pending.data, reviews.data, socialOn, me.data?.orgs, org?.name, slug, locale, theme, canQuickCapture, canCreateTeamTask, t, tp, tmw, tc, f, navigate, setLocale, setTheme],
  );
  const foundEntries = useMemo<PaletteEntry[]>(() => {
    const settled = typed !== null && term === typed;
    const notes = (settled && notesOn ? notesFound.data : undefined) ?? [];
    const rememberSearchRecord = (path: string, label: string, detail?: string) => {
      const targetPathname = stripSearchAndHash(path).toLowerCase();
      const currentRelative = normalizeOrgRelativePath(resolvedPathname, slug)?.toLowerCase();
      if (path.toLowerCase() !== targetPathname && currentRelative !== targetPathname) {
        suppressedPathnameRef.current = targetPathname;
      }
      recordRecentItem(
        slug,
        { id: path, path, label, ...(detail ? { detail } : {}), kind: 'record' },
        { orgId: orgIdHere, userId: userIdHere },
      );
    };
    const noteEntries = notes.map((n) => {
      const detail = tp(n.visibility === 'private' ? 'notePrivate' : 'noteShared');
      return {
        id: `note:${n.id}`,
        group: 'notes' as const,
        label: n.title,
        detail,
        run: () => {
          rememberSearchRecord(`/notes?note=${encodeURIComponent(n.id)}`, n.title, detail);
          void navigate({ to: '/o/$slug/notes', params: { slug }, search: { note: n.id } });
        },
      };
    });
    const data = settled && financeOn ? found.data : undefined;
    if (!data) return noteEntries;
    return [
      ...data.parties.map((p) => {
        const detail = p.taxCode ? tp('taxCode', { code: p.taxCode }) : undefined;
        return {
          id: `party:${p.id}`,
          group: 'parties' as const,
          label: p.name,
          ...(detail ? { detail } : {}),
          // A customer that never sold to the org is not among the vendors: its invoices are with the documents.
          run: () => {
            if (p.customerOnly) {
              rememberSearchRecord(`/documents?q=${encodeURIComponent(p.name)}`, p.name, detail);
              void navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: p.name } });
            } else {
              const queryValue = p.taxCode ?? p.name;
              rememberSearchRecord(`/vendors?q=${encodeURIComponent(queryValue)}`, p.name, detail);
              void navigate({ to: '/o/$slug/vendors', params: { slug }, search: { q: queryValue } });
            }
          },
        };
      }),
      ...data.documents.map((d) => {
        const label = documentNumber(d);
        const detail = [
          d.direction === 'sale' ? tp('saleDocument') : null,
          d.voided ? tp('voidedDocument') : null,
          tp('documentDetail', { party: d.partyName, date: f.date(d.issueDate), total: f.money(d.total) }),
        ]
          .filter(Boolean)
          .join(', ');
        return {
          id: `document:${d.id}`,
          group: 'documents' as const,
          label,
          detail,
          // The approved proposal shows the invoice with its file; a document without one opens in the list.
          run: () => {
            if (d.proposalId) {
              void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: d.proposalId } });
            } else {
              rememberSearchRecord(`/documents?q=${encodeURIComponent(d.number)}`, label, detail);
              void navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: d.number } });
            }
          },
        };
      }),
      ...data.entries.map((e) => {
        const detail = tp('entryDetail', { date: f.date(e.entryDate), amount: f.money(e.amount) });
        return {
          id: `entry:${e.id}`,
          group: 'entries' as const,
          label: e.description,
          detail,
          run: () => {
            rememberSearchRecord(
              `/journal?from=${encodeURIComponent(e.entryDate)}&to=${encodeURIComponent(e.entryDate)}#entry-${encodeURIComponent(e.id)}`,
              e.description,
              detail,
            );
            void navigate({ to: '/o/$slug/journal', params: { slug }, search: { from: e.entryDate, to: e.entryDate }, hash: `entry-${e.id}` });
          },
        };
      }),
      ...noteEntries,
    ];
  }, [found.data, notesFound.data, financeOn, notesOn, typed, term, slug, resolvedPathname, orgIdHere, userIdHere, tp, f, navigate]);

  // The count on a tab: the pending proposals on Chứng từ's first tab.
  const tabBadges = { inbox: menuBadges.inbox };

  const shellNav = ({ mode, onNavigate }: { mode: 'sidebar' | 'drawer'; onNavigate?: () => void }) => (
    <ShellNav
      slug={slug}
      apps={apps}
      app={screenApp}
      settingsItems={settingsItems}
      // The pending count sits on the Documents item, whose first tab is "Chờ duyệt" (#3225).
      badges={{ documents: menuBadges.inbox, social: menuBadges.social, alerts: workUnread, socialNotifications: unread }}
      orgs={me.data?.orgs ?? []}
      email={me.data?.email}
      mode={mode}
      {...(mode === 'sidebar' ? { secondaryCollapsed: sidebarCollapsed, secondaryRef: secondarySidebarRef } : {})}
      onOpenPalette={() => {
        onNavigate?.();
        setPaletteOpen(true);
      }}
      paletteKeys={paletteKeys}
      quickCreateItems={quickCreateItems}
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
    <div className="flex min-h-full flex-col bg-background">
      {/* The first stop of the keyboard (WCAG 2.4.1, #2115): fixed, so the sticky top bar / phone header never covers it. */}
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
      <div ref={topChrome} className="sticky top-0 z-30 print:hidden">
        <GlobalTopBar
          slug={slug}
          pathname={pathname}
          hasSecondary={hasSecondary}
          secondaryCollapsed={sidebarCollapsed}
          onToggleSecondary={hasSecondary ? () => setUserCollapsed((prev) => !prev) : undefined}
          toggleRef={sidebarToggleRef}
          onOpenPalette={() => setPaletteOpen(true)}
          paletteKeys={paletteKeys}
          quickCreateItems={quickCreateItems}
          onOpenQuickCapture={canQuickCapture ? () => setQuickCaptureOpen(true) : undefined}
          vyOpen={vyDrawerOpen}
          onOpenVy={() => setVyDrawerOpen(true)}
          canUseVy={canUseVy}
          gmName={gmName}
          unreadNotices={workUnread}
          aiMeter={aiMeter.data}
          canViewAiBudgets={canViewAiBudgets}
          orgs={me.data?.orgs ?? []}
          email={me.data?.email}
        />
        <PhoneHeader
          slug={slug}
          orgName={org?.name}
          attention={menuBadges.inbox !== null}
          onOpenMenu={() => setMenuOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          quickCreateItems={quickCreateItems}
          onOpenQuickCapture={canQuickCapture ? () => setQuickCaptureOpen(true) : undefined}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          data-testid="desktop-sidebar"
          data-collapsed={sidebarCollapsed ? 'true' : 'false'}
          className={cn(
            'sticky top-12 hidden h-[calc(100dvh-3rem)] shrink-0 border-r bg-sidebar md:flex print:hidden',
            sidebarCollapsed ? 'w-16' : 'w-72',
          )}
        >
          {shellNav({ mode: 'sidebar' })}
        </aside>
        <div className="min-w-0 flex-1">
          <NavDrawer open={menuOpen} onOpenChange={setMenuOpen}>
            {shellNav({ mode: 'drawer', onNavigate: () => setMenuOpen(false) })}
          </NavDrawer>
          {/* Focusable from code only: where the focus goes when the toast that held it leaves (#2026). */}
          <main ref={main} id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none md:px-8 md:py-8 print:max-w-none print:p-0">
            <OrgLeftNotice />
            <ScreenTabs slug={slug} installed={NAV} badges={tabBadges} />
            {me.isSuccess && !org ? <p className="text-sm text-destructive">{t('notMember')}</p> : <Outlet />}
          </main>
          <CommandPalette
            entries={paletteEntries}
            found={foundEntries}
            search={searchState}
            onQueryChange={setPaletteQuery}
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
          />
          {canQuickCapture && <QuickCaptureDialog slug={slug} open={quickCaptureOpen} onOpenChange={setQuickCaptureOpen} />}
          <VyDrawer
            slug={slug}
            open={vyDrawerOpen}
            onOpenChange={setVyDrawerOpen}
            gmName={gmName}
            canUseVy={canUseVy}
            permissionsLoaded={orgDetail.isSuccess}
            canViewAiBudgets={canViewAiBudgets}
            aiMeter={aiMeter.data}
            todayItems={vyToday.data?.items ?? []}
            todayLoading={vyToday.isPending}
            todayError={vyToday.isError ? errorMessage(vyToday.error) : null}
            role={roleHere}
            modules={installedModules()}
          />
        </div>
      </div>
    </div>
  );
}
