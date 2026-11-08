// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs the member today across the apps, on top of Home. One list from
// kernel.today, grouped by kind with flags first; each row links to the screen where the item is acted on. Nothing is
// approved or sent from here: batch approval stays in the owning app's screen.
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { TodayItem, TodaySeverity } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { TodayBrief } from './today-brief.tsx';
import { Empty, ErrorText, ListSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { TODAY_ICON, groupToday, todayPath, todayTotal } from '../lib/today.ts';

const SEVERITY_VARIANT: Record<TodaySeverity, 'destructive' | 'warning' | 'outline'> = { block: 'destructive', warn: 'warning', info: 'outline' };

// An item's title is a message key of the catalog (`today.items.<key>`) with its parameters, which each line adds with
// its read. A key this app does not know shows the kind's general sentence, so a new read never leaves a blank row.
function useTitle() {
  const t = useTranslations('today');
  const items = useTranslations('today.items');
  return (item: TodayItem): string => {
    const params = item.title.params ?? {};
    // The keys are runtime strings from the lines, so they are looked up in the catalog directly, not through its types.
    // A key that is not a message (missing, or a group of messages) or a message the parameters do not fit gets the
    // kind's sentence, so one line's mistake never blanks Home.
    const translate = items as unknown as { raw: (key: string) => unknown; (key: string, values: Record<string, string | number>): string };
    try {
      if (typeof translate.raw(item.title.key) === 'string') {
        const text = translate(item.title.key, params);
        if (!text.endsWith(item.title.key)) return text;
      }
    } catch {
      // Not a message of the catalog.
    }
    return t(`fallback.${item.kind}`);
  };
}

function TodayRow({ item, slug }: { item: TodayItem; slug: string }) {
  const t = useTranslations('today');
  const f = useFormat();
  const router = useRouter();
  const title = useTitle();
  const path = todayPath(slug, item.href);
  // A plain click moves inside the app without a reload; a new tab, a copied link and the keyboard use the real href.
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(path);
  };
  return (
    <li>
      <a
        href={path}
        onClick={go}
        className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50 focus-visible:bg-muted/50"
      >
        <NavIcon name={TODAY_ICON[item.kind]} className="text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-foreground">{title(item)}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
            {item.severity && <Badge variant={SEVERITY_VARIANT[item.severity]}>{t(`severity.${item.severity}`)}</Badge>}
            {item.count !== undefined && <span className="tabular-nums">{t('count', { count: item.count })}</span>}
            {item.amount !== undefined && <span className="font-mono tabular-nums">{f.money(item.amount, item.currency)}</span>}
            {item.dueAt !== undefined && <span className="tabular-nums">{t('due', { when: item.kind === 'message' ? f.dateTime(item.dueAt) : f.date(item.dueAt) })}</span>}
          </span>
        </span>
        {/* The whole row is the link; on a phone the word would only squeeze the title. */}
        <span className="hidden shrink-0 text-xs text-link sm:inline">{t('open')}</span>
      </a>
    </li>
  );
}

export function TodayList({ slug }: { slug: string }) {
  const t = useTranslations('today');
  const live = useStreamLive();
  const today = useQuery({ ...orpc.today.list.queryOptions(), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const groups = groupToday(today.data?.items ?? []);

  return (
    <section aria-labelledby="overview-today">
      <h2 id="overview-today" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      <div className="mt-3">
        {today.isPending ? (
          <ListSkeleton rows={2} />
        ) : today.isError ? (
          <ErrorText>{errorMessage(today.error)}</ErrorText>
        ) : groups.length === 0 ? (
          <Empty title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <div className="space-y-5">
            <TodayBrief slug={slug} items={today.data?.items ?? []} />
            {groups.map((group) => (
              <div key={group.kind}>
                <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
                  {t(`kinds.${group.kind}`)}
                  <span className="font-mono text-xs font-normal tabular-nums text-subtle-foreground">{todayTotal(group.items)}</span>
                </h3>
                <Card className="block overflow-hidden p-0">
                  <ul className="divide-y">
                    {group.items.map((item) => (
                      <TodayRow key={`${item.app}:${item.id}`} item={item} slug={slug} />
                    ))}
                  </ul>
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
