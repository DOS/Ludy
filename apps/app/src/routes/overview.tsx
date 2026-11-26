// The org's overview (issue #1249, compressed action-first layout #4644, Role x Enabled-App modular Home #4923 Phase 4 / #4928):
// - Anchored top zone: plain PageHeader with Tùy chỉnh toggle (create actions live in Global Top Bar `+`),
//   "Hôm nay cần bạn" hero queue + compact inline Vy prompt bar, Day-1 start card until first approved invoice or dismissal,
//   and compact operational strip (waiting counts + SinceYesterday, hidden when empty).
// - Role x Enabled-App modular summary blocks in persisted order (collapsed to one quiet line when empty),
//   inline Tùy chỉnh reorder/visibility editor synced to PostgreSQL via Runtime.execute(),
// - Quiet clickable app status links and OrgNotesPanel below.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { COWORKER_ROSTER, type HomeBlockId, type HomeLayoutSaveInput, type TaxDueView } from '@ludy/kernel-contract';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { NavIcon, type NavIconName } from '@ludy/ui/components/nav-icon';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { cn } from '@ludy/ui/lib/utils';
import { Day1QuickStart } from '../components/day1-quickstart.tsx';
import {
  CollapsedHomeBlock,
  EngagePipelineBlock,
  EsignPendingBlock,
  FinanceApprovalsBlock,
  HrPendingBlock,
  TeamworkMyWorkBlock,
} from '../components/home-blocks.tsx';
import { HomeCreateBar } from '../components/home-create-bar.tsx';
import { HomeCustomizePanel } from '../components/home-customize-panel.tsx';
import { HomeVyBar } from '../components/home-vy-bar.tsx';
import { OrgNotesPanel } from '../components/notes-panel.tsx';
import { SalesNumberGaps } from '../components/sales-number-gaps.tsx';
import { SinceYesterday, useSinceYesterday } from '../components/since-yesterday.tsx';
import { TodayList } from '../components/today-list.tsx';
import { weeklyTiles } from '../components/today-weekly.tsx';
import { DueWhen, TONE_CLASS, usePeriodLabel } from '../components/tax-due.tsx';
import { useChosenEntity, useLegalEntity } from '../components/entity-switcher.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, clientForOrg, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { OPEN_TASK_STATUSES, agentPermissions } from '../lib/agents.ts';
import { installedApps, type AppId } from '../lib/apps.ts';
import { deadlineTone } from '../lib/clients.ts';
import { buildQuickCreateItems } from '../lib/quick-create.ts';
import { readStartCardState, showStartCard, writeStartCardState, type StartCardState } from '../lib/home-actions.ts';
import {
  buildFallbackHomeLayout,
  eligibleHomeBlocks,
  toHomeLayoutDraft,
  visibleHomeBlocks,
} from '../lib/home-layout.ts';
import { useOrgPermissions } from '../lib/permissions.ts';
import {
  WAITING_LINKS,
  allCounted,
  gapsFromYear,
  isDay1Empty,
  quickStartSteps,
  tasksNotListed,
  unreadNotices,
  waitingItems,
  type WaitingKey,
} from '../lib/overview.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { briefDay } from '../lib/today-brief.ts';
import { weeklyAutoShown, weeklyCacheKey } from '../lib/today-weekly.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { entityToMark, markableEntities } from '../lib/tax-calendar.ts';
import { queueRows } from '../lib/today.ts';
import { useWorkNotifications } from './notifications.tsx';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';

// The icon of each waiting item; where it opens is WAITING_LINKS (lib/overview.ts).
const TARGET = {
  failedFiles: { icon: 'documents' },
  notifications: { icon: 'alerts' },
  tasks: { icon: 'tasks' },
} as const satisfies Record<WaitingKey, { icon: NavIconName }>;

// The apps that open a fixed screen; the others (Cộng tác, Ludy eSign, Ludy AI) open where their switcher entry goes.
const APP_CARD = {
  // Tài chính opens on its Tổng quan (#2631).
  finance: { to: '/o/$slug/accounting', icon: 'appAccounting' },
  // Engage holds the CRM's screens too (#2435), so its status link shows posts and bookings figures.
  engage: { to: '/o/$slug/social', icon: 'appSocial' },
  // The HR app opens on its staff list (#2530); its status link has no figure, since a count of employees is a payroll read.
  hr: { to: '/o/$slug/hr/employees', icon: 'appHr' },
} as const satisfies Partial<Record<AppId, { to: string; icon: NavIconName }>>;
const OTHER_CARD_ICON = { teamwork: 'appTeamwork', sign: 'signEnvelopes', ai: 'appAi' } as const satisfies Partial<Record<AppId, NavIconName>>;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// The lists counted here return at most this many rows; a full page reads as "200+", not as an exact figure.
const LIST_CAP = 200;
const counted = (n: number, page: number) => (page >= LIST_CAP ? `${n}+` : String(n));

// Quiet horizontal status links for installed apps (#1528, #3225, compressed in #4644).
function AppCards({
  slug,
  vat,
  vatLoaded,
  manager,
  hrMember,
  canReadBookings,
  weekWindow,
}: {
  slug: string;
  vat: { period: string; daysLeft: number } | null;
  vatLoaded: boolean;
  manager: boolean;
  hrMember: boolean;
  canReadBookings: boolean;
  weekWindow: { from: string; to: string };
}) {
  const t = useTranslations('overview.apps');
  const tc = useTranslations('overview.apps.compact');
  const tn = useTranslations('nav');
  const periodLabel = usePeriodLabel();
  useModulesVersion(); // the apps of the org can change while this screen is open
  const modules = installedModules();
  // The Engage app also holds Ads, so it can be installed with neither the social nor the crm module: its figures count posts and
  // bookings, which need them, so it shows only where one of the two runs.
  const apps = installedApps(modules).filter((a) => (a.id !== 'engage' || modules.includes('social') || modules.includes('crm')) && (a.id !== 'hr' || hrMember));
  const has = (module: string) => modules.includes(module);
  const posts = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...weekWindow, limit: LIST_CAP } }), enabled: has('social') });
  const bookings = useQuery({
    ...orpc.crm.bookings.list.queryOptions({ input: { scope: 'mine', period: 'upcoming' } }),
    enabled: has('crm') && canReadBookings,
  });
  if (apps.length === 0) return null;

  type StatusChip = { key: string; label: string; pending?: boolean; retry?: () => void };
  const statuses = (id: AppId): StatusChip[] => {
    if (id === 'teamwork' || id === 'ai' || id === 'hr' || id === 'sign') return [];
    if (id === 'finance') {
      if (!vatLoaded) return [{ key: 'vat', label: '', pending: true }];
      if (!vat) return [];
      return [
        {
          key: 'vat',
          label:
            vat.daysLeft >= 0
              ? tc('vatDue', { days: vat.daysLeft, period: periodLabel(vat.period) })
              : tc('vatOverdue', { days: -vat.daysLeft, period: periodLabel(vat.period) }),
        },
      ];
    }
    const out: StatusChip[] = [];
    if (has('social')) {
      if (posts.isError) out.push({ key: 'posts', label: t('failed'), retry: () => void posts.refetch() });
      else if (!posts.data) out.push({ key: 'posts', label: '', pending: true });
      else {
        const scheduled = posts.data.filter((p) => p.status === 'scheduled').length;
        if (scheduled > 0) out.push({ key: 'posts', label: tc('posts', { count: scheduled }).replace(/\b\d+\b/, counted(scheduled, posts.data.length)) });
      }
    }
    if (has('crm') && canReadBookings) {
      if (bookings.isError) out.push({ key: 'bookings', label: t('failed'), retry: () => void bookings.refetch() });
      else if (!bookings.data) out.push({ key: 'bookings', label: '', pending: true });
      else {
        const upcoming = bookings.data.filter((b) => b.status === 'pending' || b.status === 'confirmed').length;
        if (upcoming > 0) out.push({ key: 'bookings', label: tc('bookings', { count: upcoming }).replace(/\b\d+\b/, counted(upcoming, bookings.data.length)) });
      }
    }
    return out;
  };

  const target = (id: AppId, app: { home: string }) => {
    if (id === 'hr' && !manager) return '/o/$slug/hr/my';
    const card = id in APP_CARD ? APP_CARD[id as keyof typeof APP_CARD] : null;
    // Engage opens on its posts; with the social module off its status link shows the bookings, so that is where it opens.
    return id === 'engage' && !has('social') ? '/o/$slug/bookings' : (card?.to ?? app.home);
  };

  return (
    <section className="mt-6" aria-labelledby="overview-apps">
      <h2 id="overview-apps" className="text-sm font-semibold text-foreground">
        {t('title')}
      </h2>
      <ul className="mt-2 flex flex-wrap items-center gap-2" data-testid="overview-apps-row">
        {apps.map((app) => {
          const id = app.id;
          const card = id in APP_CARD ? APP_CARD[id as keyof typeof APP_CARD] : null;
          const icon: NavIconName = card?.icon ?? OTHER_CARD_ICON[id as keyof typeof OTHER_CARD_ICON];
          const appStatuses = statuses(id);
          const pending = appStatuses.some((s) => s.pending);
          const retryActions = appStatuses.flatMap((s) => (s.retry ? [s.retry] : []));
          const readyLabels = appStatuses.filter((s) => !s.pending && !s.retry && s.label).map((s) => s.label);
          const linkClass = cn(
            'inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            PHONE_TARGET,
          );
          if (retryActions.length > 0) {
            return (
              <li key={id} data-app-status={id} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-xs">
                <Link to={target(id, app)} params={{ slug }} className={cn('inline-flex items-center gap-2 font-medium text-foreground hover:text-link hover:underline', PHONE_TARGET)}>
                  <NavIcon name={icon} className="text-muted-foreground" />
                  <span>{tn(`appNames.${id}`)}</span>
                </Link>
                <span className="text-subtle-foreground">{t('failed')}</span>
                <button
                  type="button"
                  className={cn('text-link hover:underline', PHONE_TARGET)}
                  onClick={() => {
                    for (const retry of retryActions) retry();
                  }}
                >
                  {t('retry')}
                </button>
              </li>
            );
          }
          return (
            <li key={id} data-app-status={id}>
              <Link to={target(id, app)} params={{ slug }} className={linkClass}>
                <NavIcon name={icon} className="text-muted-foreground" />
                <span className="font-medium text-foreground">{tn(`appNames.${id}`)}</span>
                {pending && (
                  <span aria-hidden="true" className="inline-flex">
                    <Spinner />
                  </span>
                )}
                {!pending && readyLabels.length > 0 && (
                  <span className="text-subtle-foreground tabular-nums">{readyLabels.join(' · ')}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A due of the org, marked done by each legal entity on its own (#1553): with several entities the row names the ones
// still open and marks the entity chosen in the shell, when the server says the reader may mark it there (#1917).
function DueRow({ due, severalEntities, chosen }: { due: TaxDueView; severalEntities: boolean; chosen: string | null }) {
  const tt = useTranslations('taxCalendar');
  const periodLabel = usePeriodLabel();
  const open = entityToMark(due.openEntities, chosen);
  const markFor = markableEntities(due).some((e) => e.id === open) ? open : null;
  const markName = due.openEntities.find((e) => e.id === markFor)?.name ?? '';
  const done = useMutation({
    mutationFn: () => client.org.markTaxObligation({ obligation: due.obligation, period: due.period, done: true, ...(markFor ? { legalEntityId: markFor } : {}) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.org.overview.key() });
    },
  });
  return (
    <TableRow>
      <TableCell data-label={tt('columns.due')}>
        <DueWhen due={due} />
      </TableCell>
      <TableCell data-label={tt('columns.obligation')} title={due.legalBasis}>
        {tt(`obligations.${due.obligation}`)}
      </TableCell>
      <TableCell data-label={tt('columns.period')} className="text-muted-foreground">
        {periodLabel(due.period)}
        {severalEntities && due.openEntities.length > 0 && (
          <span className="block text-xs text-subtle-foreground">{tt('openEntities', { names: due.openEntities.map((e) => e.name).join(', ') })}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {markFor && (
          <Button loading={done.isPending} size="sm" variant="outline" onClick={() => done.mutate()}>
            {severalEntities ? tt('markDoneFor', { entity: markName }) : tt('markDone')}
          </Button>
        )}
        {done.error && <ErrorText>{errorMessage(done.error)}</ErrorText>}
      </TableCell>
    </TableRow>
  );
}

export function OverviewPage() {
  const t = useTranslations('overview');
  const tt = useTranslations('taxCalendar');
  const tcl = useTranslations('clients');
  const tg = useTranslations('salesGaps');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const periodLabel = usePeriodLabel();
  const { slug } = useParams({ strict: false }) as { slug: string };
  useModulesVersion(); // the apps of the org can change while this screen is open
  const modules = installedModules();
  const financeOn = modules.includes('finance');
  const notesOn = modules.includes('notes');
  const crmOn = modules.includes('crm');
  const socialOn = modules.includes('social');
  const live = useStreamLive();
  const every = pollEvery(live, 60_000, SAFETY_POLL_MS);

  const me = useQuery(orpc.me.get.queryOptions());
  const meOrg = me.data?.orgs.find((o) => o.slug === slug);
  const hasOrgMembership = Boolean(meOrg);
  const orgPermissions = useOrgPermissions(hasOrgMembership);
  const role = meOrg?.role ?? orgPermissions.role;
  const canViewAiBudgets = agentPermissions(role).budgets;
  // The phone's thumb row of create jobs (#4784): the member's own quick-create links, so an app that is off or a viewer shows none.
  const createItems = buildQuickCreateItems({ modules, role, canCreateTeamTask: agentPermissions(role).tasks, canQuickCapture: false });

  const aiMeter = useQuery({
    ...orpc.ai.meter.queryOptions({ input: {} }),
    enabled: hasOrgMembership,
    refetchInterval: every,
    staleTime: 15_000,
  });
  const homeLayout = useQuery({
    ...orpc.overview.homeLayout.get.queryOptions(),
    enabled: hasOrgMembership,
    refetchInterval: every,
  });

  const overview = useQuery({ ...orpc.org.overview.queryOptions(), refetchInterval: every });
  const work = useWorkNotifications();
  const tasks = useQuery({ ...orpc.tasks.list.queryOptions({ input: { mine: true, status: [...OPEN_TASK_STATUSES] } }), refetchInterval: every });
  // The list the "Hôm nay cần bạn" section shows (the same query, so one read): what it already counts is not counted again below.
  const today = useQuery({ ...orpc.today.list.queryOptions(), refetchInterval: every });
  const since = useSinceYesterday();
  // Each entity marks its own tax dues (#1553); with several, the rows say which are still open.
  const entity = useChosenEntity();
  const books = useLegalEntity(slug);

  const [customizing, setCustomizing] = useState(false);
  const [customizeSessionKey, setCustomizeSessionKey] = useState(0);
  const [layoutAnnouncement, setLayoutAnnouncement] = useState('');
  const customizeBtnRef = useRef<HTMLButtonElement>(null);
  const activeSlugRef = useRef(slug);

  const homeLayoutQueryKey = orpc.overview.homeLayout.get.queryOptions().queryKey;
  const saveLayout = useMutation({
    mutationFn: ({ slug: requestSlug, input }: { slug: string; input: HomeLayoutSaveInput }) =>
      clientForOrg(requestSlug).overview.homeLayout.save(input),
    onSuccess: (saved, variables) => {
      const current = getCurrentOrg();
      if (activeSlugRef.current !== variables.slug || (current !== null && current !== variables.slug)) return;
      queryClient.setQueryData(homeLayoutQueryKey, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.overview.homeLayout.get.key() });
      setCustomizing(false);
      setLayoutAnnouncement(
        'reset' in variables.input && variables.input.reset
          ? t('customize.resetAnnouncement')
          : t('customize.savedAnnouncement'),
      );
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => customizeBtnRef.current?.focus({ preventScroll: true }));
      }
    },
  });

  const { reset: resetSaveLayout } = saveLayout;
  useEffect(() => {
    activeSlugRef.current = slug;
    setCustomizing(false);
    setLayoutAnnouncement('');
    resetSaveLayout();
  }, [slug, resetSaveLayout]);

  useEffect(() => {
    if (customizing && (!hasOrgMembership || homeLayout.isError)) {
      setCustomizing(false);
    }
  }, [customizing, hasOrgMembership, homeLayout.isError]);

  // One count per thing (#3591): the proposals, the posts to review and the statement lines are in "Hôm nay cần bạn"; this list keeps the rest,
  // and the notices and tasks it counts are the ones that list does not.
  const counts = {
    failedFiles: overview.data?.failedFiles,
    notifications: unreadNotices(work.data),
    tasks: tasksNotListed(tasks.data, today.data?.items),
  };
  const waiting = waitingItems(counts);
  const sinceItems = !since.isError ? (since.data?.items ?? []) : [];
  const failed = [overview, work, tasks].find((q) => q.isError);

  const vat = overview.data?.vatDeadline ?? null;
  const dues = overview.data?.taxDues ?? [];
  // The VAT return in the tax calendar already says when it is due; otherwise the next one is named on its own.
  const vatListed = vat !== null && dues.some((d) => d.obligation === 'vat_return' && d.period === vat.period);
  const canChooseVat = financeOn && (role === 'owner' || role === 'admin');
  const noFilingPeriod = financeOn && overview.data !== undefined && overview.data.vatFilingPeriod === null;

  const quickStart = quickStartSteps({ modules, role, vatChosen: overview.data?.vatFilingPeriod != null });
  const waitingLoaded = allCounted(counts, ['failedFiles', 'notifications', 'tasks']);
  const day1Settled = me.isSuccess && today.isSuccess && overview.isSuccess && waitingLoaded && !since.isPending;
  const day1Error = Boolean(failed) || today.isError || me.isError;
  const day1Empty =
    quickStart.length > 0 &&
    isDay1Empty({
      todayLoaded: today.isSuccess,
      todayCount: queueRows(today.data?.items ?? []).length,
      overviewLoaded: overview.isSuccess,
      lastActivityAt: overview.data?.lastActivityAt,
      taxDuesCount: dues.length,
      pendingProposals: overview.data?.pendingProposals ?? 0,
      failedFiles: overview.data?.failedFiles ?? 0,
      waitingLoaded,
      waitingCount: waiting.length,
      sinceResolved: !since.isPending,
      sinceCount: sinceItems.length,
      hasError: day1Error,
    });
  // Wait for Day-1 detection to settle before mounting TodayWeekly (avoids premature AI calls and Day-1 layout shift).
  const showWeekly = !day1Empty && (day1Settled || day1Error);

  // The day-1 "Bắt đầu" card (#4783): gone by itself once the org has an approved invoice, or when the member closes it. The read is bounded:
  // it runs only while neither has happened on this device, and its answer is kept so it is not asked again.
  // Kept with the slug it was read for: the screen stays mounted when the member switches org, so another org's state is read afresh.
  const [storedFor, setStoredFor] = useState<{ slug: string; value: StartCardState | null }>(() => ({ slug, value: readStartCardState(slug) }));
  const stored = storedFor.slug === slug ? storedFor.value : readStartCardState(slug);
  const setStored = (value: StartCardState) => setStoredFor({ slug, value });
  const documents = useQuery({
    ...orpc.documents.list.queryOptions({ input: {} }),
    enabled: financeOn && role !== undefined && role !== 'viewer' && stored === null,
    staleTime: 5 * 60_000,
  });
  const firstInvoiceApproved = documents.isSuccess ? documents.data.some((d) => d.voided === null) : undefined;
  useEffect(() => {
    if (firstInvoiceApproved !== true || stored !== null) return;
    writeStartCardState(slug, 'done');
    setStored('done');
  }, [firstInvoiceApproved, stored, slug]);
  const startCard = showStartCard({ steps: quickStart.length, stored, financeOn, firstInvoiceApproved, orgEmpty: day1Empty });
  const dismissStart = () => {
    writeStartCardState(slug, 'dismissed');
    setStored('dismissed');
  };

  // The choice is a button where the gap is (#3591), not a link in a sentence.
  const chooseVat = canChooseVat ? (
    <Link to="/o/$slug/settings" params={{ slug }} hash="tax-profile" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {tcl('chooseFilingPeriod')}
    </Link>
  ) : undefined;

  const hasOperationalStrip = waiting.length > 0 || Boolean(failed) || sinceItems.length > 0;
  const gmName = today.data?.coworkers.gm ?? COWORKER_ROSTER.gm;
  const todayItems = today.data?.items ?? [];
  const financeProposalsForCaller = today.isSuccess
    ? todayItems
        .filter((item) => item.app === 'finance' && item.kind === 'proposal')
        .reduce((sum, item) => sum + (item.count ?? 1), 0)
    : undefined;
  const hrPendingLeaveCount = today.isSuccess
    ? todayItems
        .filter((item) => item.app === 'hr' && item.id === 'leave-approvals')
        .reduce((sum, item) => sum + (item.count ?? 0), 0)
    : 0;

  // Next 7 days from the start of this hour, shared between EngagePipelineBlock and AppCards so an hour roll avoids duplicate queries.
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const weekWindow = { from: new Date(hour).toISOString(), to: new Date(hour + WEEK_MS).toISOString() };

  const isAdmin = role === 'owner' || role === 'admin';
  const isMemberOrAbove = isAdmin || role === 'member';
  const canCustomize = hasOrgMembership && homeLayout.isSuccess;
  // Server `homeLayout.get` is authoritative for `roleKeys` (`external_accountant`, `finance.viewer`) and non-proposal finance permissions.
  const awaitingServerLayout = hasOrgMembership && !homeLayout.data && !homeLayout.isError && !isAdmin;
  const fallbackLayout = buildFallbackHomeLayout({ modules, role, permissions: orgPermissions.permissions });
  const activeLayout = homeLayout.data ?? (homeLayout.isError && !isAdmin ? { customized: false, blocks: [], defaults: [] } : fallbackLayout);
  const eligibleBlocks = eligibleHomeBlocks(activeLayout, modules, role);
  const visibleBlocks = visibleHomeBlocks(eligibleBlocks);
  const teamworkBlockActive = visibleBlocks.some((b) => b.id === 'teamwork_my_work');

  const canShowWeekly = role !== undefined && role !== 'viewer';
  const weeklyLanguage = locale === 'en' ? 'en' : 'vi';
  const weeklyKey = weeklyCacheKey(slug, briefDay(), weeklyLanguage);
  const weeklyProbe = useQuery({
    queryKey: ['today', 'weekly', weeklyKey],
    queryFn: () => client.today.weekly({ language: weeklyLanguage }),
    enabled: canShowWeekly && showWeekly && weeklyAutoShown() && teamworkBlockActive && !awaitingServerLayout,
    staleTime: (query) => (query.state.data?.final ? 60 * 60 * 1000 : 30 * 1000),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const hasWeeklySummary =
    canShowWeekly &&
    showWeekly &&
    (!weeklyAutoShown() ||
      (!weeklyProbe.isError &&
        (weeklyProbe.isPending || (weeklyProbe.data ? weeklyTiles(weeklyProbe.data.figures).length > 0 : false))));

  const openCustomize = () => {
    if (!canCustomize) return;
    setLayoutAnnouncement('');
    saveLayout.reset();
    setCustomizeSessionKey((n) => n + 1);
    setCustomizing(true);
  };
  const closeCustomize = () => {
    saveLayout.reset();
    setCustomizing(false);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => customizeBtnRef.current?.focus({ preventScroll: true }));
    }
  };
  const toggleCustomize = () => {
    if (customizing) closeCustomize();
    else openCustomize();
  };

  const renderFinanceTaxBlock = () => {
    const canCollapseEmpty = Boolean(overview.data) && dues.length === 0 && (!noFilingPeriod || !canChooseVat);
    if (canCollapseEmpty) {
      return (
        <div key="finance_tax_deadlines" className="space-y-4">
          <CollapsedHomeBlock
            blockId="finance_tax_deadlines"
            slug={slug}
            to="/o/$slug/vat"
            icon="vat"
            emptyLine={t('blocks.finance_tax_deadlines.emptyLine')}
            openLink={t('blocks.finance_tax_deadlines.openLink')}
            headingId="overview-tax"
            headingTitle={tt('title')}
          />
          {financeOn && (
            <SalesNumberGaps
              quiet
              compact
              detailsLabel={t('showDetails')}
              hideDetailsLabel={t('hideDetails')}
              fromYear={gapsFromYear(new Date())}
              legalEntityId={entity.legalEntityId}
              enabled={entity.ready}
              action={
                <Link to="/o/$slug/vat" params={{ slug }} className={cn('text-xs text-link underline', PHONE_TARGET)}>
                  {tg('open')}
                </Link>
              }
            />
          )}
        </div>
      );
    }

    return (
      <section key="finance_tax_deadlines" className="min-w-0 space-y-4" aria-labelledby="overview-tax" data-testid="home-block-finance_tax_deadlines">
        <div>
          <h2 id="overview-tax" className="text-sm font-semibold">
            {tt('title')}
          </h2>
          <p className="mt-1 mb-3 text-xs text-subtle-foreground">{t('taxSubtitle')}</p>
          {vat && !vatListed && (
            <p className="mb-3 text-sm">
              {t('vatNext', { period: periodLabel(vat.period) })}{' '}
              <span className={cn('font-medium tabular-nums', TONE_CLASS[deadlineTone(vat.daysLeft)])}>{f.date(vat.dueDate)}</span>{' '}
              <span className="text-subtle-foreground">({tt('daysLeft', { days: vat.daysLeft })})</span>
            </p>
          )}
          {noFilingPeriod && dues.length > 0 && (
            <p className="mb-3 flex flex-wrap items-center gap-3 text-sm text-subtle-foreground">
              {tcl('noFilingPeriod')}
              {chooseVat}
            </p>
          )}
          {overview.isPending ? (
            <CardSkeleton />
          ) : (
            overview.data &&
            (dues.length === 0 ? (
              <Empty compact title={tt('empty')} hint={noFilingPeriod ? tcl('noFilingPeriod') : tt('emptyHint')} action={noFilingPeriod ? chooseVat : undefined} />
            ) : (
              <DataTable stacked fit head={[tt('columns.due'), tt('columns.obligation'), tt('columns.period'), '']}>
                {dues.map((d) => (
                  <DueRow key={`${d.obligation}:${d.period}`} due={d} severalEntities={books.entities.length > 1} chosen={books.entityId} />
                ))}
              </DataTable>
            ))
          )}
          <p className="mt-2 text-xs text-subtle-foreground">{tt('unconfirmed')}</p>
        </div>

        {financeOn && (
          <SalesNumberGaps
            quiet
            compact
            detailsLabel={t('showDetails')}
            hideDetailsLabel={t('hideDetails')}
            fromYear={gapsFromYear(new Date())}
            legalEntityId={entity.legalEntityId}
            enabled={entity.ready}
            action={
              <Link to="/o/$slug/vat" params={{ slug }} className={cn('text-xs text-link underline', PHONE_TARGET)}>
                {tg('open')}
              </Link>
            }
          />
        )}
      </section>
    );
  };

  const renderBlock = (id: HomeBlockId) => {
    switch (id) {
      case 'finance_tax_deadlines':
        return renderFinanceTaxBlock();
      case 'finance_approvals':
        return (
          <FinanceApprovalsBlock
            key={id}
            slug={slug}
            isPending={today.isPending || overview.isPending}
            error={today.error ?? overview.error}
            pendingProposals={financeProposalsForCaller}
            failedFiles={overview.data?.failedFiles}
          />
        );
      case 'teamwork_my_work':
        return (
          <TeamworkMyWorkBlock
            key={id}
            slug={slug}
            role={role}
            notesOn={notesOn}
            tasksPending={tasks.isPending}
            tasksError={tasks.error}
            openTaskCount={tasks.data?.length ?? 0}
            showWeekly={showWeekly}
            hasWeeklySummary={hasWeeklySummary}
          />
        );
      case 'engage_pipeline':
        return <EngagePipelineBlock key={id} slug={slug} crmOn={crmOn} socialOn={socialOn} weekWindow={weekWindow} enabled={isMemberOrAbove} />;
      case 'hr_pending':
        return (
          <HrPendingBlock
            key={id}
            slug={slug}
            role={role}
            enabled
            isPending={today.isPending}
            error={today.error}
            pendingLeaveCount={hrPendingLeaveCount}
          />
        );
      case 'esign_pending':
        return <EsignPendingBlock key={id} slug={slug} enabled />;
    }
  };

  return (
    <div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="home-customize-status">
        {layoutAnnouncement}
      </div>

      <PageHeader
        title={t('title')}
        subtitle={overview.data?.lastActivityAt ? t('lastActivity', { when: f.dateTime(overview.data.lastActivityAt) }) : t('subtitle')}
        actions={
          <Button
            ref={customizeBtnRef}
            type="button"
            variant={customizing ? 'secondary' : 'outline'}
            size="sm"
            disabled={!canCustomize}
            aria-expanded={customizing}
            data-testid="home-customize-btn"
            onClick={toggleCustomize}
          >
            {t('customize.button')}
          </Button>
        }
      />

      {/* Row 1: Anchored "Hôm nay cần bạn" queue + compact inline Vy prompt bar (#2383, #4644, #4928), then Day-1 start card (#4783). */}
      <TodayList slug={slug} />
      <HomeVyBar
        key={slug}
        slug={slug}
        gmName={gmName}
        canUseVy={orgPermissions.canUseVy}
        permissionsLoaded={orgPermissions.permissionsLoaded}
        canApproveFinance={orgPermissions.canApproveFinance}
        canViewAiBudgets={canViewAiBudgets}
        aiMeter={aiMeter.data}
        role={role}
        modules={modules}
      />
      {startCard && <Day1QuickStart slug={slug} steps={quickStart} financeOn={financeOn} onDismiss={dismissStart} />}

      {/* Row 2: Compact operational strip combining Waiting counts + SinceYesterday coworker updates; hidden when empty (#4644). */}
      {hasOperationalStrip && (
        <section className="mt-4 space-y-2" aria-label={t('operationalStrip')}>
          {failed && <ErrorText>{errorMessage(failed.error)}</ErrorText>}
          {(waiting.length > 0 || sinceItems.length > 0) && (
            <div data-testid="overview-operational-strip" className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2">
              {waiting.length > 0 && (
                <ul className="flex flex-wrap items-center gap-2" aria-label={t('waiting.title')}>
                  {waiting.map(({ key, count }) => (
                    <li key={key}>
                      <Link
                        to={WAITING_LINKS[key].to}
                        params={{ slug }}
                        title={t(`waiting.${key}.hint`)}
                        data-testid={`waiting-${key}`}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-1.5 text-sm text-secondary-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          PHONE_TARGET,
                        )}
                      >
                        <NavIcon name={TARGET[key].icon} className={key === 'failedFiles' ? 'text-destructive' : 'text-muted-foreground'} />
                        <span className="font-mono font-semibold tabular-nums text-foreground">{count}</span>
                        <span>{t(`waiting.${key}.label`, { count })}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {waiting.length > 0 && sinceItems.length > 0 && <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:inline-block" />}
              {sinceItems.length > 0 && <SinceYesterday slug={slug} variant="strip" />}
            </div>
          )}
        </section>
      )}

      {hasOrgMembership && homeLayout.isError && (
        <div
          role="alert"
          data-testid="home-layout-error"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3 text-sm"
        >
          <ErrorText>{`${t('customize.loadError')} ${errorMessage(homeLayout.error)}`}</ErrorText>
          <Button type="button" variant="outline" size="sm" onClick={() => void homeLayout.refetch()}>
            {t('customize.retry')}
          </Button>
        </div>
      )}

      {/* Inline Tùy chỉnh mode (#4928): reorder & visibility toggle persisted in PostgreSQL. */}
      {customizing && canCustomize && (
        <HomeCustomizePanel
          key={customizeSessionKey}
          initialBlocks={toHomeLayoutDraft(eligibleBlocks)}
          isPending={saveLayout.isPending}
          error={saveLayout.error}
          onSave={(blocks) => saveLayout.mutate({ slug, input: { blocks } })}
          onReset={() => saveLayout.mutate({ slug, input: { reset: true } })}
          onCancel={closeCustomize}
        />
      )}

      {/* Row 3: Role x Enabled-App modular summary blocks in persisted order (#4928). */}
      {awaitingServerLayout ? (
        <div data-testid="overview-modular-blocks-loading" className="mt-6">
          <CardSkeleton />
        </div>
      ) : visibleBlocks.length > 0 ? (
        <div data-testid="overview-modular-blocks" className="mt-6 space-y-6">
          {visibleBlocks.map((block) => renderBlock(block.id))}
        </div>
      ) : eligibleBlocks.length > 0 ? (
        <div
          data-testid="home-all-blocks-hidden"
          className="mt-6 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          <span>{t('layout.allHidden')}</span>
          <Button type="button" variant="outline" size="sm" disabled={!canCustomize} onClick={openCustomize}>
            {t('customize.button')}
          </Button>
        </div>
      ) : null}

      {/* Row 4: Quiet compact app status links (#4644). */}
      <AppCards
        slug={slug}
        vat={vat}
        vatLoaded={overview.isSuccess}
        manager={isAdmin}
        hrMember={isMemberOrAbove}
        canReadBookings={isMemberOrAbove}
        weekWindow={weekWindow}
      />

      {/* The org's notes (#1671): in a client company's org, notes about the client. */}
      {notesOn && <OrgNotesPanel slug={slug} />}

      <HomeCreateBar slug={slug} items={createItems} />
    </div>
  );
}
