// SPDX-License-Identifier: AGPL-3.0-only
// The panels of the Reports screen (#2435), one for each area whose module runs. Each reads what its own screen reads (the
// inbox's counts, the deal board, the posts' totals, the ad accounts' summaries), with no read of its own, and links to that
// screen for the detail. Nothing is written here. Amounts are decimal strings, shown as the reader's language groups them.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { AdAccountView } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { adsRange, hasFigures } from '../lib/ads.ts';
import { errorMessage, orpc } from '../lib/api.ts';
import { pipelineTotals } from '../lib/reports.ts';
import { ChangeChip } from './social-growth.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, TableSkeleton } from './ui.tsx';

// The posts' window: the last 30 days, set against the 30 days before.
const POSTS_DAYS = 30;
const POST_METRICS = ['reach', 'reactions', 'comments', 'shares'] as const;

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
                <TableCell className="px-4 text-sm">{column.stage.name}</TableCell>
                <TableCell className="px-4 text-sm">{f.number(column.count)}</TableCell>
                <TableCell className="px-4 text-sm">{f.money(column.total)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <p className="text-xs text-subtle-foreground">{t('closedNote')}</p>
        </div>
      )}
    </section>
  );
}

// How the posts that went out did: the last 30 days, each total against the 30 days before.
export function PostsPanel({ slug }: { slug: string }) {
  const t = useTranslations('reports.posts');
  const ts = useTranslations('social');
  const f = useFormat();
  const totals = useQuery(orpc.social.metrics.totals.queryOptions({ input: { days: POSTS_DAYS } }));
  const against = ts('growth.change.days', { days: String(POSTS_DAYS) });
  const data = totals.data;
  const title = t('title', { days: POSTS_DAYS });
  return (
    <section aria-label={title}>
      <Heading
        title={title}
        hint={t('hint')}
        link={
          <Link to="/o/$slug/social" params={{ slug }} className={linkClass}>
            {t('open')}
          </Link>
        }
      />
      {totals.error ? (
        <ErrorText>{errorMessage(totals.error)}</ErrorText>
      ) : !data ? (
        <CardSkeleton />
      ) : data.posts === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <Card className="block p-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label={ts('growth.posts')}>
              {f.number(data.posts)}
              <ChangeChip current={data.posts} previous={data.previous.posts} against={against} className="mt-1 flex" />
            </Stat>
            {POST_METRICS.map((metric) => (
              <Stat key={metric} label={ts(`metric.${metric}`)}>
                {f.number(data.metrics[metric] ?? 0)}
                <ChangeChip current={data.metrics[metric] ?? 0} previous={data.previous.metrics[metric]} against={against} className="mt-1 flex" />
              </Stat>
            ))}
          </dl>
        </Card>
      )}
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
  const cell = (value: ReactNode) => <TableCell className="px-4 text-sm">{value}</TableCell>;
  return (
    <TableRow>
      <TableCell className="px-4 text-sm font-medium text-foreground">{account.name}</TableCell>
      {!ready ? (
        <TableCell colSpan={4} className="px-4 text-sm text-muted-foreground">
          {t('noFigures')}
        </TableCell>
      ) : summary.error ? (
        <TableCell colSpan={4} className="px-4 text-sm text-destructive">
          {errorMessage(summary.error)}
        </TableCell>
      ) : !total ? (
        <TableCell colSpan={4} className="px-4 text-sm text-muted-foreground">
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
