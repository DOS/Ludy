// SPDX-License-Identifier: AGPL-3.0-only
// How published posts did (S8), shown in Reports > Bài đăng (#3658): the one place for the post figures. It moved here from the
// Posts screen's Số liệu tab, which now keeps a one-line summary and a link to the report.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { bestTimes, engagementRateOfBases, type PublishedSample } from '@ludy/mod-social/contract';
import { Empty, ErrorText, Spinner } from './ui.tsx';
import { AccountGrowth, ChangeChip, ChannelTotals, EngagementRateCard, TopPosts } from './social-growth.tsx';
import { FollowerAudiences } from './social-audience.tsx';
import { ProfilePerformance } from './social-performance.tsx';
import { WhatWorks } from './social-insights.tsx';
import { OutsidePostCell, OutsideSwitch } from './social-external-posts.tsx';
import { StoryLine, StoryTotals } from './social-story-metrics.tsx';
import { MetricsSummary, useCanSummarize, useMetricsSummary } from './social-summary.tsx';
import { mergePublished } from '../lib/social-external.ts';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';

// The counts the analytics table shows, in order; a platform that does not report one shows a dash.
const METRIC_COLUMNS = ['reach', 'reactions', 'comments', 'shares'] as const;

// How published posts did (S8): totals over the window, then each published channel with its latest capture; with a
// label chosen (#639), only the posts that carry it, on the screen and in the export. With the outside switch on
// (#1054), the posts the channels published outside Crove count in the totals and show in the table with their chip;
// they carry no label, so a label filter turns the switch off.
export function SocialMetrics({ slug, names, labelId, action }: { slug: string; names: Map<string, string>; labelId: string | undefined; action?: ReactNode }) {
  const t = useTranslations('social');
  const f = useFormat();
  const [days, setDays] = useState(30);
  const [outside, setOutside] = useState(false);
  const counting = outside && !labelId;
  const label = labelId ? { labelId } : {};
  const rows = useQuery(orpc.social.metrics.summary.queryOptions({ input: { days, ...label } }));
  // The totals over every published channel of the window, summed by the server (#397); the list below stops at 500.
  const totals = useQuery(orpc.social.metrics.totals.queryOptions({ input: { days, ...label, ...(counting ? { includeExternal: true } : {}) } }));
  const outsideRows = useQuery({ ...orpc.social.metrics.external.queryOptions({ input: { days } }), enabled: counting });
  // An AI summary of the window shown (#1237), for members and above on a server with AI; never saved.
  const canSummarize = useCanSummarize();
  const summary = useMetricsSummary();
  // The window as a CSV file, built and audited by the server, saved by the browser.
  const exportCsv = useMutation({
    mutationFn: () => client.social.metrics.export({ days, ...label }),
    onSuccess: (file) => {
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      // Some browsers still read the link a moment after the click.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  if (rows.isLoading) return <Spinner />;
  if (rows.error) return <ErrorText>{errorMessage(rows.error)}</ErrorText>;
  const data = rows.data ?? [];
  const extra = counting ? (outsideRows.data ?? []) : [];
  const total = (name: string) => totals.data?.metrics[name] ?? [...data, ...extra].reduce((sum, r) => sum + (r.metrics[name] ?? 0), 0);
  // Clicks on Crove's short links (#706), where a channel sends its links through them.
  const clicks = totals.data ? totals.data.clicks : data.some((r) => r.clicks !== null) ? data.reduce((sum, r) => sum + (r.clicks ?? 0), 0) : null;
  const hasClicks = clicks !== null;
  // The same totals of the window just before (#947), for the change next to each.
  const previous = totals.data?.previous;
  const against = t('growth.change.days', { days: String(days) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} variant={d === days ? 'secondary' : 'ghost'} size="sm" aria-pressed={d === days} onClick={() => setDays(d)}>
            {t('metricsDays', { days: String(d) })}
          </Button>
        ))}
        {(data.length > 0 || extra.length > 0) && canSummarize && (
          <Button variant="outline" size="sm" className="ml-auto" disabled={summary.write.isPending} onClick={() => summary.start({ days, labelId, includeExternal: counting })}>
            {t('summary.open')}
          </Button>
        )}
        {data.length > 0 && (
          <Button variant="outline" size="sm" className={canSummarize ? undefined : 'ml-auto'} disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
            {t('metricsExport')}
          </Button>
        )}
      </div>
      <MetricsSummary summary={summary} />
      <OutsideSwitch checked={outside} onChange={setOutside} disabled={Boolean(labelId)} />
      {exportCsv.error && <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>}
      {/* Without the server's totals the cards sum the listed rows only. */}
      {totals.error && <ErrorText>{errorMessage(totals.error)}</ErrorText>}
      {counting && outsideRows.error && <ErrorText>{errorMessage(outsideRows.error)}</ErrorText>}
      {exportCsv.data?.truncated && <p className="text-xs text-warning">{t('metricsExportCut')}</p>}
      <AccountGrowth days={days} names={names} />
      <FollowerAudiences days={days} names={names} />
      <ProfilePerformance days={days} names={names} />
      {data.length === 0 && extra.length === 0 ? (
        <Empty title={t('empty.metrics')} hint={t('metricsHint')} action={action} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {totals.data && (
              <Card className="block p-4">
                <p className="text-xs text-subtle-foreground">{t('growth.posts')}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{f.number(totals.data.posts)}</p>
                <ChangeChip current={totals.data.posts} previous={previous?.posts} against={against} withPrevious className="mt-1" />
              </Card>
            )}
            {METRIC_COLUMNS.map((m) => (
              <Card key={m} className="block p-4">
                <p className="text-xs text-subtle-foreground">{t(`metric.${m}`)}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{totals.isLoading ? '…' : f.number(total(m))}</p>
                {previous && <ChangeChip current={total(m)} previous={previous.metrics[m]} against={against} withPrevious className="mt-1" />}
              </Card>
            ))}
            {/* The engagement rate over the posts that report reach (else impressions, #1164), never a mean of rates (#1157). */}
            {totals.data && <EngagementRateCard current={engagementRateOfBases([totals.data.rateBases])} previous={previous ? engagementRateOfBases([previous.rateBases]) : null} against={against} />}
            {hasClicks && (
              <Card className="block p-4">
                <p className="text-xs text-subtle-foreground">{t('metricsClicks')}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{totals.isLoading ? '…' : f.number(clicks ?? 0)}</p>
                {previous && <ChangeChip current={clicks} previous={previous.clicks} against={against} withPrevious className="mt-1" />}
              </Card>
            )}
          </div>
          {totals.data && <StoryTotals metrics={totals.data.metrics} />}
          {totals.data && totals.data.channels.length > 0 && <ChannelTotals current={totals.data.channels} previous={previous?.channels ?? []} days={days} names={names} />}
          {data.length >= 500 && <p className="text-xs text-subtle-foreground">{t(totals.data ? 'metricsCapped' : 'metricsCappedPartial')}</p>}
          <BestTimes rows={data} names={names} />
          <WhatWorks slug={slug} days={days} labelId={labelId} names={names} />
          <TopPosts rows={data} names={names} slug={slug} />
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs text-subtle-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('metricsPost')}</th>
                  {METRIC_COLUMNS.map((m) => (
                    <th key={m} className="px-3 py-2 text-right font-medium">
                      {t(`metric.${m}`)}
                    </th>
                  ))}
                  {hasClicks && <th className="px-3 py-2 text-right font-medium">{t('metricsClicks')}</th>}
                </tr>
              </thead>
              <tbody>
                {mergePublished(data, extra).map((item) => {
                  const r = item.row;
                  const meta = [providerName(r.provider), names.get(r.connectionId), r.publishedAt ? f.dateTime(r.publishedAt) : null, r.capturedAt ? t('metricsAsOf', { when: f.dateTime(r.capturedAt) }) : t('metricsPending')]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr key={item.kind === 'ludy' ? item.row.variantId : `outside-${item.row.id}`} className="border-t">
                      <td className="max-w-md px-3 py-2">
                        {item.kind === 'ludy' ? (
                          <>
                            <Link to="/o/$slug/social/$id" params={{ slug, id: item.row.postId }} className="line-clamp-1 text-foreground hover:underline">
                              {item.row.excerpt || t('emptyText')}
                            </Link>
                            <p className="text-xs text-subtle-foreground">{meta}</p>
                            <StoryLine metrics={r.metrics} />
                          </>
                        ) : (
                          <OutsidePostCell excerpt={item.row.excerpt} url={item.row.url} meta={meta} />
                        )}
                      </td>
                      {METRIC_COLUMNS.map((m) => (
                        <td key={m} className="px-3 py-2 text-right text-foreground tabular-nums">
                          {r.metrics[m] === undefined ? '-' : f.number(r.metrics[m])}
                        </td>
                      ))}
                      {hasClicks && <td className="px-3 py-2 text-right text-foreground tabular-nums">{item.kind === 'ludy' && item.row.clicks !== null ? f.number(item.row.clicks) : '-'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// When each channel's posts drew the most engagement, in the viewer's time zone, from the posts in the window.
function BestTimes({ rows, names }: { rows: readonly PublishedSample[]; names: Map<string, string> }) {
  const t = useTranslations('social');
  const f = useFormat();
  const best = useMemo(() => bestTimes(rows, Intl.DateTimeFormat().resolvedOptions().timeZone), [rows]);
  if (best.size === 0) return null;
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('bestTimesTitle')}</p>
        <p className="text-xs text-subtle-foreground">{t('bestTimesHint')}</p>
      </div>
      <ul className="space-y-2">
        {[...best.entries()].map(([connectionId, slots]) => (
          <li key={connectionId} className="text-sm">
            <span className="text-foreground">{names.get(connectionId) ?? connectionId.slice(0, 8)}</span>
            <span className="text-subtle-foreground">
              {': '}
              {slots
                .map((s) => t('bestTimesSlot', { day: t(`weekday.${DAY_KEYS[s.weekday - 1] ?? 'mon'}`), hour: String(s.hour).padStart(2, '0'), engagement: f.number(Math.round(s.engagement)), posts: String(s.posts) }))
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

