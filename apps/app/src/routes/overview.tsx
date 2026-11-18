// The org's overview (issue #1249): what waits for the user in this org today, each with its count and a link to the
// screen that clears it, then one card per installed app with its key figure (#1528; this screen opens the Home app),
// then the tax obligations due in the next 30 days or overdue, which a member marks done here as on the multi-client
// home screen (#921). The org's figures are the ones /clients reads for it (org.overview).
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TaxDueView } from '@crove/kernel-contract';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NavIcon, type NavIconName } from '@crove/ui/components/nav-icon';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { OrgNotesPanel } from '../components/notes-panel.tsx';
import { SalesNumberGaps } from '../components/sales-number-gaps.tsx';
import { SinceYesterday } from '../components/since-yesterday.tsx';
import { TodayList } from '../components/today-list.tsx';
import { TodayWeekly } from '../components/today-weekly.tsx';
import { DueWhen, TONE_CLASS, usePeriodLabel } from '../components/tax-due.tsx';
import { useChosenEntity, useLegalEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { OPEN_TASK_STATUSES } from '../lib/agents.ts';
import { installedApps, type AppId } from '../lib/apps.ts';
import { deadlineTone } from '../lib/clients.ts';
import { WAITING_LINKS, appsLayout, gapsFromYear, tasksNotListed, unreadNotices, waitingItems, type WaitingKey } from '../lib/overview.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { entityToMark, markableEntities } from '../lib/tax-calendar.ts';
import { useWorkNotifications } from './notifications.tsx';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';


// The icon of each card; where it opens is WAITING_LINKS (lib/overview.ts).
const TARGET = {
  failedFiles: { icon: 'documents' },
  notifications: { icon: 'alerts' },
  tasks: { icon: 'tasks' },
} as const satisfies Record<WaitingKey, { icon: NavIconName }>;

// The apps that open a fixed screen; the others (Cộng tác, Ludy eSign, Ludy AI) open where their switcher entry goes.
const APP_CARD = {
  // Tài chính opens on its Tổng quan (#2631).
  finance: { to: '/o/$slug/accounting', icon: 'appAccounting' },
  // Engage holds the CRM's screens too (#2435), so its card shows the posts' figure and the bookings' one.
  engage: { to: '/o/$slug/social', icon: 'appSocial' },
  // The HR app opens on its staff list (#2530); its card has no figure, since a count of employees is a payroll read.
  hr: { to: '/o/$slug/hr/employees', icon: 'appHr' },
} as const satisfies Partial<Record<AppId, { to: string; icon: NavIconName }>>;
const OTHER_CARD_ICON = { teamwork: 'appTeamwork', sign: 'journal', ai: 'appAi' } as const satisfies Partial<Record<AppId, NavIconName>>;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// The lists the cards count return at most this many rows; a full page reads as "200+", not as an exact figure.
const LIST_CAP = 200;
const counted = (n: number, page: number) => (page >= LIST_CAP ? `${n}+` : String(n));

// One card per installed app (#1528, #3225): its key figure and a way in.
function AppCards({ slug, vat, vatLoaded, manager }: { slug: string; vat: { period: string; daysLeft: number } | null; vatLoaded: boolean; manager: boolean }) {
  const t = useTranslations('overview.apps');
  const tn = useTranslations('nav');
  const periodLabel = usePeriodLabel();
  useModulesVersion(); // the apps of the org can change while this screen is open
  const modules = installedModules();
  // The Engage app also holds Ads, so it can be installed with neither the social nor the crm module: its card counts posts and
  // bookings, which need them, so it shows only where one of the two runs.
  const apps = installedApps(modules).filter((a) => (a.id !== 'engage' || modules.includes('social') || modules.includes('crm')) && (a.id !== 'hr' || manager));
  const has = (module: string) => modules.includes(module);
  // The next 7 days from the start of this hour: the query key holds within the hour and moves on with the clock, so a
  // tab left open does not count last week's posts.
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const week = { from: new Date(hour).toISOString(), to: new Date(hour + WEEK_MS).toISOString() };
  const posts = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...week, limit: LIST_CAP } }), enabled: has('social') });
  const bookings = useQuery({ ...orpc.crm.bookings.list.queryOptions({ input: { scope: 'mine', period: 'upcoming' } }), enabled: has('crm') });
  if (apps.length === 0) return null;

  // zero: a figure that reads 0 is not shown, so a card is only for an app with something to read (#3591).
  type Figure = { key: string; value: string | null; label: string; retry?: () => void; zero?: boolean };
  const failed = (key: string, q: { refetch: () => unknown }): Figure => ({ key, value: '-', label: t('failed'), retry: () => void q.refetch() });
  const postsFigure = (): Figure => {
    if (posts.isError) return failed('posts', posts);
    if (!posts.data) return { key: 'posts', value: null, label: '' };
    // The range holds every post with a time in it; only the scheduled ones are waiting to go out.
    const scheduled = posts.data.filter((p) => p.status === 'scheduled').length;
    return { key: 'posts', value: counted(scheduled, posts.data.length), label: t('social.scheduled', { count: scheduled }), zero: scheduled === 0 };
  };
  const bookingsFigure = (): Figure => {
    if (bookings.isError) return failed('bookings', bookings);
    if (!bookings.data) return { key: 'bookings', value: null, label: '' };
    const upcoming = bookings.data.filter((b) => b.status === 'pending' || b.status === 'confirmed').length;
    return { key: 'bookings', value: counted(upcoming, bookings.data.length), label: t('crm.upcoming', { count: upcoming }), zero: upcoming === 0 };
  };
  // The key figures of an app's card: one for the accounting, and for Engage one for each of its modules that runs.
  const figures = (id: AppId): Figure[] => {
    if (id === 'teamwork' || id === 'ai' || id === 'hr' || id === 'sign') return [];
    if (id === 'finance') {
      if (!vatLoaded) return [{ key: 'vat', value: null, label: '' }];
      // No filing period chosen: nothing to count yet, and the tax box below offers the choice.
      if (!vat) return [{ key: 'vat', value: '-', label: '', zero: true }];
      return [
        vat.daysLeft >= 0
          ? { key: 'vat', value: String(vat.daysLeft), label: t('accounting.vatDue', { days: vat.daysLeft, period: periodLabel(vat.period) }) }
          : { key: 'vat', value: String(-vat.daysLeft), label: t('accounting.vatOverdue', { days: -vat.daysLeft, period: periodLabel(vat.period) }) },
      ];
    }
    return [...(has('social') ? [postsFigure()] : []), ...(has('crm') ? [bookingsFigure()] : [])];
  };
  const target = (id: AppId, app: { home: string }) => {
    const card = id in APP_CARD ? APP_CARD[id as keyof typeof APP_CARD] : null;
    // Engage opens on its posts; with the social module off its card shows the bookings, so that is where it opens.
    return id === 'engage' && !has('social') ? '/o/$slug/bookings' : (card?.to ?? app.home);
  };
  const layout = appsLayout(apps.map((app) => ({ id: app.id, figures: figures(app.id).map((f) => ({ zero: f.zero === true, pending: f.value === null, failed: f.retry !== undefined })) })));
  if (layout.cards.length === 0 && layout.line.length === 0) return null;

  return (
    <section className="mt-8" aria-labelledby="overview-apps">
      <h2 id="overview-apps" className="text-sm font-semibold">
        {t('title')}
      </h2>
      {layout.cards.length > 0 && (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps
            .filter((app) => layout.cards.includes(app.id))
            .map((app) => {
              const id = app.id;
              const card = id in APP_CARD ? APP_CARD[id as keyof typeof APP_CARD] : null;
              const icon: NavIconName = card?.icon ?? OTHER_CARD_ICON[id as keyof typeof OTHER_CARD_ICON];
              return (
                <li key={id} data-app-card={id}>
                  <Card className="flex h-full flex-col gap-2 p-4">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <NavIcon name={icon} className="text-muted-foreground" />
                      {tn(`appNames.${id}`)}
                    </span>
                    {figures(id)
                      .filter((fig) => fig.zero !== true)
                      .map(({ key, value, label, retry }) =>
                        value === null ? (
                          <div key={key}>
                            <Spinner />
                          </div>
                        ) : (
                          <p key={key} className="text-sm text-muted-foreground">
                            <span className="mr-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
                            {label}
                            {retry && (
                              <button type="button" className="ml-2 text-xs text-link hover:underline" onClick={retry}>
                                {t('retry')}
                              </button>
                            )}
                          </p>
                        ),
                      )}
                    <Link to={target(id, app)} params={{ slug }} className="mt-auto text-xs text-link hover:underline">
                      {t('open', { app: tn(`appNames.${id}`) })}
                    </Link>
                  </Card>
                </li>
              );
            })}
        </ul>
      )}
      {/* The apps with no figure to show: one line of links instead of a card each (#3591). */}
      {layout.line.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="overview-apps-line">
          {t('others')}:{' '}
          {apps
            .filter((app) => layout.line.includes(app.id))
            .map((app, i) => (
              <span key={app.id}>
                {i > 0 && ' · '}
                <Link to={target(app.id, app)} params={{ slug }} className="text-link hover:underline">
                  {tn(`appNames.${app.id}`)}
                </Link>
              </span>
            ))}
        </p>
      )}
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
      <TableCell className="px-4 py-3">
        <DueWhen due={due} />
      </TableCell>
      <TableCell className="px-4 py-3" title={due.legalBasis}>
        {tt(`obligations.${due.obligation}`)}
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">
        {periodLabel(due.period)}
        {severalEntities && due.openEntities.length > 0 && (
          <span className="block text-xs text-subtle-foreground">{tt('openEntities', { names: due.openEntities.map((e) => e.name).join(', ') })}</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
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
  const periodLabel = usePeriodLabel();
  const { slug } = useParams({ strict: false }) as { slug: string };
  useModulesVersion(); // the apps of the org can change while this screen is open
  const modules = installedModules();
  const financeOn = modules.includes('finance');
  const notesOn = modules.includes('notes');
  const live = useStreamLive();
  const every = pollEvery(live, 60_000, SAFETY_POLL_MS);

  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const overview = useQuery({ ...orpc.org.overview.queryOptions(), refetchInterval: every });
  const work = useWorkNotifications();
  const tasks = useQuery({ ...orpc.tasks.list.queryOptions({ input: { mine: true, status: [...OPEN_TASK_STATUSES] } }), refetchInterval: every });
  // The list the "Hôm nay cần bạn" section shows (the same query, so one read): what it already counts is not counted again below.
  const today = useQuery({ ...orpc.today.list.queryOptions(), refetchInterval: every });
  // Each entity marks its own tax dues (#1553); with several, the rows say which are still open.
  const entity = useChosenEntity();
  const books = useLegalEntity(slug);

  // One count per thing (#3591): the proposals, the posts to review and the statement lines are in "Hôm nay cần bạn"; this list keeps the rest,
  // and the notices and tasks it counts are the ones that list does not.
  const counts = {
    failedFiles: overview.data?.failedFiles,
    notifications: unreadNotices(work.data),
    tasks: tasksNotListed(tasks.data, today.data?.items),
  };
  const waiting = waitingItems(counts);
  const failed = [overview, work, tasks].find((q) => q.isError);

  const vat = overview.data?.vatDeadline ?? null;
  const dues = overview.data?.taxDues ?? [];
  // The VAT return in the tax calendar already says when it is due; otherwise the next one is named on its own.
  const vatListed = vat !== null && dues.some((d) => d.obligation === 'vat_return' && d.period === vat.period);
  const canChooseVat = role === 'owner' || role === 'admin';
  const noFilingPeriod = overview.data !== undefined && overview.data.vatFilingPeriod === null;
  // The choice is a button where the gap is (#3591), not a link in a sentence.
  const chooseVat = canChooseVat ? (
    <Link to="/o/$slug/settings" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {tcl('chooseFilingPeriod')}
    </Link>
  ) : undefined;
  const uploadAction = (
    <Link to="/o/$slug/inbox" params={{ slug }} className={buttonVariants()}>
      {t('upload')}
    </Link>
  );

  // The order is what the owner needs: what needs them today, the tax deadlines, the week, then the apps (#3591).
  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={overview.data?.lastActivityAt ? t('lastActivity', { when: f.dateTime(overview.data.lastActivityAt) }) : t('subtitle')}
        actions={uploadAction}
      />

      {/* What needs the member today across the apps (#2383), from each line's own read. */}
      <TodayList slug={slug} />

      {(waiting.length > 0 || failed) && (
        <section className="mt-8" aria-labelledby="overview-waiting">
          <h2 id="overview-waiting" className="text-sm font-semibold">
            {t('waiting.title')}
          </h2>
          {failed && <ErrorText>{errorMessage(failed.error)}</ErrorText>}
          {waiting.length > 0 && (
            <Card className="mt-3 block overflow-hidden p-0">
              <ul className="divide-y">
                {waiting.map(({ key, count }) => (
                  <li key={key}>
                    <Link to={WAITING_LINKS[key].to} params={{ slug }} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50 focus-visible:bg-muted/50">
                      <NavIcon name={TARGET[key].icon} className="text-muted-foreground" />
                      <span className="w-8 shrink-0 text-right font-mono text-base font-semibold tabular-nums text-foreground">{count}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-foreground">{t(`waiting.${key}.label`, { count })}</span>
                        <span className="block text-xs text-subtle-foreground">{t(`waiting.${key}.hint`)}</span>
                      </span>
                      {/* The whole row is the link; on a phone the words would only squeeze what it counts. */}
                      <span className="hidden shrink-0 text-xs text-link sm:inline">{t(`waiting.${key}.open`)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      <section className="mt-8" aria-labelledby="overview-tax">
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
        {overview.data &&
          (dues.length === 0 ? (
            <Empty title={tt('empty')} hint={noFilingPeriod ? tcl('noFilingPeriod') : tt('emptyHint')} action={noFilingPeriod ? chooseVat : undefined} />
          ) : (
            <div className="overflow-x-auto">
              <DataTable head={[tt('columns.due'), tt('columns.obligation'), tt('columns.period'), '']}>
                {dues.map((d) => (
                  <DueRow key={`${d.obligation}:${d.period}`} due={d} severalEntities={books.entities.length > 1} chosen={books.entityId} />
                ))}
              </DataTable>
            </div>
          ))}
        <p className="mt-3 text-xs text-subtle-foreground">{tt('unconfirmed')}</p>
      </section>

      {/* "Tuần này" (#3257): the last 7 days in figures computed by code, with Vy's checked sentences; Monday to Wednesday by itself, any day on request. */}
      <div className="mt-8">
        <TodayWeekly slug={slug} />
      </div>

      {/* What each AI coworker prepared over the last day (#3256): counts only, nothing when there is none. */}
      <SinceYesterday slug={slug} />

      {/* Numbers missing in the org's own sales invoice series (#2140): this year's series, and last year's while its returns are filed. */}
      {financeOn && (
        <SalesNumberGaps
          className="mt-8"
          quiet
          fromYear={gapsFromYear(new Date())}
          legalEntityId={entity.legalEntityId}
          enabled={entity.ready}
          action={
            <Link to="/o/$slug/vat" params={{ slug }} className="text-link underline">
              {tg('open')}
            </Link>
          }
        />
      )}

      <AppCards slug={slug} vat={vat} vatLoaded={overview.isSuccess} manager={role === 'owner' || role === 'admin'} />

      {/* The org's notes (#1671): in a client company's org, notes about the client. */}
      {notesOn && <OrgNotesPanel slug={slug} />}
    </div>
  );
}
