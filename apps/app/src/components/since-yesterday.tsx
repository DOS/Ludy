// SPDX-License-Identifier: AGPL-3.0-only
// "Since yesterday" on Home (Vy plan C1c, issue #3256): one line per AI coworker that prepared something over the last day, as
// "<name> prepared N things for you", linking to where a person approves it. The counts come from kernel.since_yesterday
// (the member's readable activity rows, no model), so the section is the same with AI off. It shows nothing while it loads, when
// it fails and when every count is zero: Home has a list of what needs the member, and a quiet day adds no empty box to it.
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { SinceYesterdayItem } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { orpc } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { todayPath } from '../lib/today.ts';

function SinceRow({ item, slug }: { item: SinceYesterdayItem; slug: string }) {
  const t = useTranslations('today.since');
  const router = useRouter();
  const path = todayPath(slug, item.href);
  // A plain click moves inside the app without a reload; a new tab, a copied link and the keyboard use the real href.
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(path);
  };
  return (
    <li>
      <a href={path} onClick={go} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50 focus-visible:bg-muted/50">
        <NavIcon name="inbox" className="text-muted-foreground" />
        <span className="min-w-0 flex-1 text-foreground">{t('line', { name: item.name, count: item.count })}</span>
        <span className="hidden shrink-0 text-xs text-link sm:inline">{t('open')}</span>
      </a>
    </li>
  );
}

export function SinceYesterday({ slug }: { slug: string }) {
  const t = useTranslations('today.since');
  const live = useStreamLive();
  const since = useQuery({ ...orpc.today.sinceYesterday.queryOptions(), refetchInterval: pollEvery(live, 5 * 60_000, SAFETY_POLL_MS) });
  const items = since.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby="overview-since">
      <h2 id="overview-since" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      <Card className="mt-3 block overflow-hidden p-0">
        <ul className="divide-y">
          {items.map((item) => (
            <SinceRow key={item.agentId} item={item} slug={slug} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
