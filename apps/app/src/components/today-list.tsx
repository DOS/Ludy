// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs the member today across the apps, on top of Home. One list from
// kernel.today, grouped by kind with flags first; each row links to the screen where the item is acted on. Nothing is
// approved or sent from here: batch approval stays in the owning app's screen.
import { useQuery } from '@tanstack/react-query';
import { useState, type MouseEvent } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { todayCoworkerKey, todayCount, type TodayCoworkers, type TodayItem, type TodaySeverity } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { TodayBrief } from './today-brief.tsx';
import { Empty, ErrorText, ListSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { installedModules } from '../lib/org-modules.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { QUEUE_ROWS, TODAY_ICON, groupToday, limitGroups, proposalChips, queueRows, todayPath, todayTotal } from '../lib/today.ts';

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

// The coworker's name goes first in the row's small print: who raised it (Ly for finance, Dy for CRM and conversations, Uy for Social and Ads,
// Vy for the rest), by the name the org gave it now. A person still approves; the name only says who is asking (#3265).
function TodayRow({ item, slug, coworkers }: { item: TodayItem; slug: string; coworkers: TodayCoworkers }) {
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
            <span data-testid="today-coworker">{t('from', { name: coworkers[todayCoworkerKey(item.app)] })}</span>
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
  const [all, setAll] = useState(false);
  const items = today.data?.items ?? [];
  // One count per thing (#3591): a flag about proposals already listed is a chip on them, not a row, and the number beside the title is the
  // same one the summary says.
  const allGroups = groupToday(queueRows(items));
  const rows = allGroups.reduce((n, g) => n + g.items.length, 0);
  const groups = all ? allGroups : limitGroups(allGroups, QUEUE_ROWS);
  const chips = proposalChips(items);
  const total = todayCount(items);

  return (
    <section aria-labelledby="overview-today">
      <h2 id="overview-today" className="flex items-baseline gap-2 text-lg font-semibold">
        {t('title')}
        {total > 0 && (
          <span className="font-mono text-sm font-normal tabular-nums text-subtle-foreground" data-testid="today-total">
            {total}
          </span>
        )}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      <div className="mt-3">
        {today.isPending ? (
          <ListSkeleton rows={2} />
        ) : today.isError ? (
          <ErrorText>{errorMessage(today.error)}</ErrorText>
        ) : groups.length === 0 ? (
          // Nothing waits: a new owner is pointed to the quick guide (#3596), where the accounting app is on.
          <Empty
            title={t('empty')}
            hint={t('emptyHint')}
            action={
              installedModules().includes('finance') ? (
                <Link to="/o/$slug/guide" params={{ slug }} className="text-sm text-link hover:underline">
                  {t('guideLink')}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-5">
            <TodayBrief slug={slug} items={items} name={today.data.coworkers.gm} />
            {groups.map((group) => (
              <div key={group.kind}>
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <h3 className="flex items-baseline gap-2 text-sm font-semibold">
                    {t(`kinds.${group.kind}`)}
                    <span className="font-mono text-xs font-normal tabular-nums text-subtle-foreground">{todayTotal(allGroups.find((g) => g.kind === group.kind)?.items ?? group.items)}</span>
                  </h3>
                  {/* Beside the heading, not in it, so the heading's name stays the kind and its count. */}
                  {group.kind === 'proposal' &&
                    chips.map((chip) => (
                      <Badge key={chip.severity} variant={SEVERITY_VARIANT[chip.severity]} data-testid="today-chip">
                        {t(`chip.${chip.severity}`, { count: chip.count })}
                      </Badge>
                    ))}
                </div>
                <Card className="block overflow-hidden p-0">
                  <ul className="divide-y">
                    {group.items.map((item) => (
                      <TodayRow key={`${item.app}:${item.id}`} item={item} slug={slug} coworkers={today.data.coworkers} />
                    ))}
                  </ul>
                </Card>
              </div>
            ))}
            {rows > QUEUE_ROWS && (
              <Button type="button" variant="outline" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="today-toggle">
                {all ? t('showLess') : t('showAll', { count: rows })}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
