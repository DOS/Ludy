// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" on Home (#3257, Vy plan C5): how the business did in the last 7 days. The server computes the figures from the lines' own reads in the member's context, so a member sees only
// figures from what they can open; Vy's few sentences are checked against them (the template shows when none passes, with AI off, or when the meter refuses the call). It shows by itself Monday to Wednesday and on request
// any other day. It approves, sends and posts nothing and is stored nowhere. A figure the member cannot see is not shown; with the AI budget spent or AI off the template stands in, and says so.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { WeeklyFigures } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client } from '../lib/api.ts';
import { briefDay } from '../lib/today-brief.ts';
import { weeklyAutoShown, weeklyCacheKey } from '../lib/today-weekly.ts';

type Tile = { key: 'dealsWon' | 'dealsOpen' | 'cash' | 'receivables' | 'payables' | 'tasksLate'; value: string; kind: 'money' | 'number'; hint?: string };

// A decimal string that reads zero ("0", "0.00", "-0").
const zeroMoney = (amount: string) => /^-?0+(\.0+)?$/.test(amount);

// The figures the card shows as numbers, in order; a group the member cannot open adds none, and so does a group that reads zero throughout
// (no deal, an empty ledger, no late task): an org that does not use that app sees no zeros of it (#3591).
export function weeklyTiles(figures: WeeklyFigures): Tile[] {
  const tiles: Tile[] = [];
  const { deals, money, tasks } = figures;
  if (deals && (deals.won.count > 0 || (deals.open ?? 0) > 0)) {
    tiles.push({ key: 'dealsWon', value: String(deals.won.count), kind: 'number', hint: deals.won.amount });
    if (deals.open !== null) tiles.push({ key: 'dealsOpen', value: String(deals.open), kind: 'number' });
  }
  if (money && ![money.cash, money.receivables, money.payables].every((b) => zeroMoney(b.amount) && zeroMoney(b.previous))) {
    tiles.push({ key: 'cash', value: money.cash.amount, kind: 'money' });
    tiles.push({ key: 'receivables', value: money.receivables.amount, kind: 'money' });
    tiles.push({ key: 'payables', value: money.payables.amount, kind: 'money' });
  }
  if (tasks && tasks.late > 0) tiles.push({ key: 'tasksLate', value: String(tasks.late), kind: 'number' });
  return tiles;
}

export function TodayWeekly({ slug }: { slug: string }) {
  const t = useTranslations('today.weekly');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const language = locale === 'en' ? 'en' : 'vi';
  // Monday to Wednesday the card shows by itself; on the other days the member asks for it, and the model is not called until they do.
  const [asked, setAsked] = useState(false);
  const shown = weeklyAutoShown() || asked;
  const key = weeklyCacheKey(slug, briefDay(), language);
  const weekly = useQuery({
    queryKey: ['today', 'weekly', key],
    // The answer lives in the query cache of this session only (emptied on sign-out), so the same day and language ask the model once and no one else in this tab finds it.
    queryFn: () => client.today.weekly({ language }),
    placeholderData: keepPreviousData,
    gcTime: 60 * 60 * 1000,
    enabled: shown,
    // A final answer is good for the hour; a fallback is asked again soon.
    staleTime: (query) => (query.state.data?.final ? 60 * 60 * 1000 : 30 * 1000),
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!shown) {
    return (
      <section data-weekly-slot="" aria-labelledby="overview-weekly">
        <Card data-testid="today-weekly-ask" className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <h2 id="overview-weekly" className="text-sm font-semibold">{t('title')}</h2>
            <p className="text-xs text-subtle-foreground">{t('window')}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAsked(true)}>
            {t('ask')}
          </Button>
        </Card>
      </section>
    );
  }
  if (weekly.isError) return null;
  if (weekly.isPending) {
    return (
      <section data-weekly-slot="" aria-label={t('title')}>
        <div aria-busy="true" className="h-24 animate-pulse rounded-xl border bg-muted/40 motion-reduce:animate-none">
          <span className="sr-only">{t('loading')}</span>
        </div>
      </section>
    );
  }
  const { figures, writtenBy, sentences, budgetSpent } = weekly.data;
  const tiles = weeklyTiles(figures);
  // Nothing the member can open to count: no card.
  if (tiles.length === 0) return null;
  return (
    <section data-weekly-slot="" aria-labelledby="overview-weekly">
      <Card className="block p-4" data-testid="today-weekly">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="overview-weekly" className="text-sm font-semibold">{t('title')}</h2>
          <span className="text-xs text-subtle-foreground">{t('window')}</span>
          {writtenBy === 'vy' && <Badge variant="proposal">{t('aiBadge')}</Badge>}
        </div>
        {sentences.length > 0 && <p className="mt-2 text-sm text-foreground">{sentences.join(' ')}</p>}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm xl:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.key} data-testid={`weekly-${tile.key}`}>
              <dt className="text-xs text-subtle-foreground">{t(`tiles.${tile.key}`)}</dt>
              <dd className="font-mono tabular-nums">{tile.kind === 'money' ? f.money(tile.value) : f.number(tile.value)}</dd>
              {tile.hint !== undefined && <dd className="font-mono text-xs tabular-nums text-subtle-foreground">{f.money(tile.hint)}</dd>}
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-subtle-foreground">{writtenBy === 'vy' ? t('byVy') : budgetSpent ? t('budgetSpent') : t('byTemplate')}</p>
      </Card>
    </section>
  );
}
