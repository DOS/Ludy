// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" on Home (#3257, Vy plan C5): how the business did in the last 7 days. The server computes the figures from the lines' own reads in the member's context, so a member sees only
// figures from what they can open; Vy's few sentences are checked against them (the template shows when none passes, with AI off, or when the meter refuses the call). It shows by itself Monday to Wednesday and on request
// any other day. It approves, sends and posts nothing and is stored nowhere. A figure the member cannot see is not shown; with the AI budget spent or AI off the template stands in, and says so.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { WeeklyFigures } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client } from '../lib/api.ts';
import { briefDay } from '../lib/today-brief.ts';
import { readStoredWeekly, storeWeekly, weeklyAutoShown, weeklyStorageKey } from '../lib/today-weekly.ts';

type Tile = { key: 'dealsWon' | 'dealsOpen' | 'cash' | 'receivables' | 'payables' | 'tasksLate'; value: string; kind: 'money' | 'number'; hint?: string };

// The figures the card shows as numbers, in order; a group the member cannot open adds none.
export function weeklyTiles(figures: WeeklyFigures): Tile[] {
  const tiles: Tile[] = [];
  if (figures.deals) {
    tiles.push({ key: 'dealsWon', value: String(figures.deals.won.count), kind: 'number', hint: figures.deals.won.amount });
    if (figures.deals.open !== null) tiles.push({ key: 'dealsOpen', value: String(figures.deals.open), kind: 'number' });
  }
  if (figures.money) {
    tiles.push({ key: 'cash', value: figures.money.cash.amount, kind: 'money' });
    tiles.push({ key: 'receivables', value: figures.money.receivables.amount, kind: 'money' });
    tiles.push({ key: 'payables', value: figures.money.payables.amount, kind: 'money' });
  }
  if (figures.tasks) tiles.push({ key: 'tasksLate', value: String(figures.tasks.late), kind: 'number' });
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
  const key = weeklyStorageKey(slug, briefDay(), language);
  const weekly = useQuery({
    queryKey: ['today', 'weekly', key],
    // An answer kept in this tab for the same day asks the model once; the card never waits for it.
    initialData: () => readStoredWeekly(key),
    queryFn: async () => {
      const fresh = await client.today.weekly({ language });
      storeWeekly(key, fresh);
      return fresh;
    },
    placeholderData: keepPreviousData,
    enabled: shown,
    // A final answer is good for the hour; a fallback is asked again soon.
    staleTime: (query) => (query.state.data?.final ? 60 * 60 * 1000 : 30 * 1000),
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!shown) {
    return (
      <div className="flex justify-end" data-testid="today-weekly-ask">
        <Button type="button" variant="outline" size="sm" onClick={() => setAsked(true)}>
          {t('ask')}
        </Button>
      </div>
    );
  }
  if (weekly.isError) return null;
  if (weekly.isPending) {
    return (
      <div aria-busy="true" className="h-24 animate-pulse rounded-xl border bg-muted/40 motion-reduce:animate-none">
        <span className="sr-only">{t('loading')}</span>
      </div>
    );
  }
  const { figures, writtenBy, sentences, budgetSpent } = weekly.data;
  const tiles = weeklyTiles(figures);
  // Nothing the member can open to count: no card.
  if (tiles.length === 0) return null;
  return (
    <Card className="block p-4" data-testid="today-weekly">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <span className="text-xs text-subtle-foreground">{t('window')}</span>
        {writtenBy === 'vy' && <Badge variant="proposal">{t('aiBadge')}</Badge>}
      </div>
      {sentences.length > 0 && <p className="mt-2 text-sm text-foreground">{sentences.join(' ')}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
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
  );
}
