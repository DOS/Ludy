// SPDX-License-Identifier: AGPL-3.0-only
// The panels of the Reports screen (#2435), one for each area whose module runs. Each reads what its own screen reads (the
// inbox's counts, the deal board, the posts' totals, the ad accounts' summaries), with no read of its own, and links to that
// screen for the detail. Nothing is written here. Amounts are decimal strings, shown as the reader's language groups them.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { AdAccountView } from '@ludy/kernel-contract';
import { buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { adsRange, hasFigures } from '../lib/ads.ts';
import { errorMessage, orpc } from '../lib/api.ts';
import { pipelineTotals } from '../lib/reports.ts';
import { SocialMetrics } from './social-metrics.tsx';
import { GoalsCard } from './social-goals.tsx';
import { TeamReport } from './social-team-report.tsx';
import { ReportLinks } from './social-report-links.tsx';
import { ReportSchedules } from './social-report-schedules.tsx';
import { useLabels } from './social-labels.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, TableSkeleton } from './ui.tsx';

function Stat({ label, note, children }: { label: string; note?: string | undefined; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]">{children}</dd>
      {note && <dd className="mt-0.5 text-xs text-subtle-foreground">{note}</dd>}
    </div>
  );
}

function Heading({ title, hint, link }: { title: string; hint: string; link: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-subtle-foreground">{hint}</p>
      </div>
      <div className="text-sm">{link}</div>
    </div>
  );
}

const linkClass = 'text-link hover:underline';

// The conversations of the org now, by state: what the inbox's tabs count.
export function ConversationsPanel({ slug }: { slug: string }) {
  const t = useTranslations('reports.conversations');
  const f = useFormat();
  const counts = useQuery(orpc.conversations.counts.queryOptions({ input: {} }));
  return (
    <section aria-label={t('title')}>
      <Heading
        title={t('title')}
        hint={t('hint')}
        link={
          <Link to="/o/$slug/social/inbox" params={{ slug }} className={linkClass}>
            {t('open')}
          </Link>
        }
      />
      {counts.error ? (
        <ErrorText>{errorMessage(counts.error)}</ErrorText>
      ) : !counts.data ? (
        <CardSkeleton />
      ) : (
        <Card className="block p-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={t('new')}>{f.number(counts.data.new)}</Stat>
            <Stat label={t('pending')}>{f.number(counts.data.pending)}</Stat>
            <Stat label={t('resolved')}>{f.number(counts.data.resolved)}</Stat>
            <Stat label={t('unread')}>{f.number(counts.data.unread)}</Stat>
          </dl>
        </Card>
      )}
    </section>
  );
}

// The pipeline as the deal board holds it: the open deals, and what was won and lost in the last 30 days, then each stage.
export function SalesPanel({ slug }: { slug: string }) {
  const t = useTranslations('reports.sales');
  const f = useFormat();
  const board = useQuery(orpc.crm.deals.board.queryOptions({ input: {} }));
  const link = (
    <Link to="/o/$slug/deals" params={{ slug }} className={linkClass}>
      {t('open')}
    </Link>
  );
  const columns = board.data?.columns ?? [];
  const totals = pipelineTotals(columns);
  const dealCount = totals.open.deals + totals.won.deals + totals.lost.deals;
  return (
    <section aria-label={t('title')}>
      <Heading title={t('title')} hint={t('hint')} link={link} />
      {board.error ? (
        <ErrorText>{errorMessage(board.error)}</ErrorText>
      ) : !board.data ? (
        <div className="space-y-4">
          <CardSkeleton />
          <TableSkeleton columns={3} />
        </div>
      ) : dealCount === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-4">
          <Card className="block p-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Stat label={t('openDeals')} note={t('dealCount', { count: totals.open.deals })}>
                {f.money(totals.open.amount)}
              </Stat>
              <Stat label={t('won')} note={t('dealCount', { count: totals.won.deals })}>
                {f.money(totals.won.amount)}
              </Stat>
              <Stat label={t('lost')} note={t('dealCount', { count: totals.lost.deals })}>
                {f.money(totals.lost.amount)}
              </Stat>
            </dl>
          </Card>
          <DataTable head={[t('stage'), t('deals'), t('amount')]} numeric={[1, 2]}>
            {columns.map((column) => (
              <TableRow key={column.stage.id}>
                <TableCell className="text-sm">{column.stage.name}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{f.number(column.count)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{f.money(column.total)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <p className="text-xs text-subtle-foreground">{t('closedNote')}</p>
        </div>
      )}
    </section>
  );
}

// The quotes by status (#2699): how many were sent, accepted and declined, what each is worth, and how many still wait for an answer, over a period the person picks.
// The server summed every amount as a decimal string; nothing is added here.
const QUOTE_PERIODS = ['30', '90', '365', 'all'] as const;
export function QuotesPanel({ slug }: { slug: string }) {
  const t = useTranslations('reports.quotes');
  const f = useFormat();
  const [period, setPeriod] = useState<(typeof QUOTE_PERIODS)[number]>('90');
  const days = period === 'all' ? null : (Number(period) as 30 | 90 | 365);
  const report = useQuery(orpc.crm.quotes.report.queryOptions({ input: { days } }));
  const link = (
    <Link to="/o/$slug/deals" params={{ slug }} className={linkClass}>
      {t('open')}
    </Link>
  );
  const of = (status: string) => report.data?.byStatus.find((s) => s.status === status);
  const total = report.data ? report.data.byStatus.reduce((n, s) => n + s.count, 0) : 0;
  return (
    <section aria-label={t('title')}>
      <Heading title={t('title')} hint={t('hint')} link={link} />
      <div className="mb-3 max-w-xs">
        <label htmlFor="quote-report-period" className="mb-1 block text-xs text-subtle-foreground">
          {t('period')}
        </label>
        <NativeSelect id="quote-report-period" className="w-full" value={period} onChange={(e) => setPeriod(e.target.value as (typeof QUOTE_PERIODS)[number])}>
          {QUOTE_PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`periods.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {report.error ? (
        <ErrorText>{errorMessage(report.error)}</ErrorText>
      ) : !report.data ? (
        <div className="space-y-4">
          <CardSkeleton />
          <TableSkeleton columns={3} />
        </div>
      ) : total === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-4">
          <Card className="block p-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label={t('sent')} note={t('count', { count: report.data.sent.count })}>
                {f.money(report.data.sent.total)}
              </Stat>
              <Stat label={t('waiting')} note={t('count', { count: of('sent')?.count ?? 0 })}>
                {f.money(of('sent')?.total ?? '0')}
              </Stat>
              <Stat label={t('accepted')} note={t('count', { count: of('accepted')?.count ?? 0 })}>
                {f.money(of('accepted')?.total ?? '0')}
              </Stat>
              <Stat label={t('declined')} note={t('count', { count: of('declined')?.count ?? 0 })}>
                {f.money(of('declined')?.total ?? '0')}
              </Stat>
            </dl>
          </Card>
          <DataTable head={[t('status'), t('quotes'), t('amount')]} numeric={[1, 2]}>
            {report.data.byStatus.map((s) => (
              <TableRow key={s.status}>
                <TableCell className="text-sm">{t(`statuses.${s.status}`)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{f.number(s.count)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{f.money(s.total)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <p className="text-xs text-subtle-foreground">{t('note')}</p>
        </div>
      )}
    </section>
  );
}

// How the posts that went out did, and what goes with the figures (#3658): the one place for them. The window (7, 30 or 90 days),
// the totals against the period before, the channels, the best posts and the CSV export; the monthly goals, the team report,
// the links for clients and the e-mail schedules under them. The Posts screen keeps a line and a link here.
// labelId and onLabel: the label the report is limited to, kept in the address by the screen.
export function PostsPanel({ slug, labelId = '', onLabel = () => undefined }: { slug: string; labelId?: string | undefined; onLabel?: (label: string) => void }) {
  const t = useTranslations('reports.posts');
  const ts = useTranslations('social');
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const labels = useLabels();
  // The empty report's one action is for whoever can use it (#3654): writing needs a role that writes and a channel; a viewer gets none.
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const canConnect = role === 'owner' || role === 'admin';
  const noChannels = channels.isSuccess && channels.data.length === 0;
  const names = new Map((channels.data ?? []).map((c) => [c.id, c.displayName]));
  const labelList = labels.data ?? [];
  const title = t('title');
  const action = !canWrite ? undefined : noChannels ? (
    canConnect ? (
      <Link to="/o/$slug/social/channels" params={{ slug }} className={buttonVariants({ size: 'lg' })}>
        {ts('connectFirst')}
      </Link>
    ) : undefined
  ) : (
    <Link to="/o/$slug/social/new" params={{ slug }} className={buttonVariants({ size: 'lg' })}>
      {ts('compose')}
    </Link>
  );
  return (
    <section aria-label={title} data-testid="reports-posts" className="space-y-4">
      <Heading
        title={title}
        hint={t('hint')}
        link={
          <Link to="/o/$slug/social" params={{ slug }} className={linkClass}>
            {t('open')}
          </Link>
        }
      />
      {(labelList.length > 0 || labelId !== '') && (
        <label className="block text-xs">
          <span className="text-subtle-foreground">{ts('filters.label')}</span>
          <NativeSelect className="mt-1 w-48" value={labelId} onChange={(e) => onLabel(e.target.value)}>
            <option value="">{ts('filters.allLabels')}</option>
            {labelList.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      <SocialMetrics slug={slug} names={names} labelId={labelId || undefined} action={action} />
      <GoalsCard channels={channels.data ?? []} />
      <TeamReport key={slug} />
      <ReportLinks channels={channels.data ?? []} />
      <ReportSchedules channels={channels.data ?? []} />
    </section>
  );
}

// One ad account's figures for this month, in the account's own currency: no figure is converted between accounts.
function AdsRow({ account }: { account: AdAccountView }) {
  const t = useTranslations('reports.ads');
  const f = useFormat();
  const ready = hasFigures(account);
  const days = adsRange('thisMonth', account.timeZone, new Date());
  const summary = useQuery({ ...orpc.ads.summary.queryOptions({ input: { adAccountId: account.id, from: days.from, to: days.to } }), enabled: ready });
  const currency = account.currency ?? '';
  const total = summary.data?.total;
  const cell = (value: ReactNode) => <TableCell className="text-right text-sm tabular-nums">{value}</TableCell>;
  return (
    <TableRow>
      <TableCell className="text-sm font-medium text-foreground">{account.name}</TableCell>
      {!ready ? (
        <TableCell colSpan={4} className="text-sm text-muted-foreground">
          {t('noFigures')}
        </TableCell>
      ) : summary.error ? (
        <TableCell colSpan={4} className="text-sm text-destructive">
          {errorMessage(summary.error)}
        </TableCell>
      ) : !total ? (
        <TableCell colSpan={4} className="text-sm text-muted-foreground">
          …
        </TableCell>
      ) : (
        <>
          {cell(f.money(total.spend, currency))}
          {cell(f.number(total.impressions))}
          {cell(f.number(total.clicks))}
          {cell(summary.data?.resultKind && total.results !== null ? f.number(total.results) : '-')}
        </>
      )}
    </TableRow>
  );
}

// The org's ad accounts and what they spent and got this month, one row each.
export function AdsPanel({ slug }: { slug: string }) {
  const t = useTranslations('reports.ads');
  const ta = useTranslations('ads');
  const accounts = useQuery(orpc.ads.accounts.queryOptions());
  return (
    <section aria-label={t('title')}>
      <Heading
        title={t('title')}
        hint={t('hint')}
        link={
          <Link to="/o/$slug/ads" params={{ slug }} className={linkClass}>
            {t('open')}
          </Link>
        }
      />
      {accounts.error ? (
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      ) : !accounts.data ? (
        <TableSkeleton columns={5} />
      ) : accounts.data.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('account'), ta('totals.spend'), ta('totals.impressions'), ta('totals.clicks'), ta('totals.results')]} numeric={[1, 2, 3, 4]}>
          {accounts.data.map((account) => (
            <AdsRow key={account.id} account={account} />
          ))}
        </DataTable>
      )}
    </section>
  );
}
