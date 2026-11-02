// SPDX-License-Identifier: AGPL-3.0-only
// Vy's daily brief on Home (issue #2383): a few sentences above the "Hôm nay cần bạn" list, written from that list's counts,
// amounts and due dates. The server checks every number of a sentence against them and falls back to a plain sentence built
// from the same figures; with the month's AI budget spent there is no brief and the list stands alone. It approves and
// sends nothing. A brief that fails to load is simply not shown: the list is what matters.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { TodayItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { client } from '../lib/api.ts';
import { briefStorageKey, listFingerprint, readStoredBrief, storeBrief } from '../lib/today-brief.ts';

export function TodayBrief({ items }: { items: readonly TodayItem[] }) {
  const t = useTranslations('today.brief');
  const { locale } = useLocaleSetting();
  const language = locale === 'en' ? 'en' : 'vi';
  const day = new Date().toLocaleDateString('en-CA');
  const key = briefStorageKey(day, language, listFingerprint(items));
  const brief = useQuery({
    // The same list on the same day asks the model once.
    queryKey: ['today', 'brief', key],
    queryFn: async () => {
      const stored = readStoredBrief(key);
      if (stored) return stored;
      const fresh = await client.today.brief({ language });
      storeBrief(key, fresh);
      return fresh;
    },
    enabled: items.length > 0,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (items.length === 0 || brief.isError) return null;
  if (brief.isPending) {
    return (
      <div aria-busy="true" className="h-16 animate-pulse rounded-xl border bg-muted/40 motion-reduce:animate-none">
        <span className="sr-only">{t('loading')}</span>
      </div>
    );
  }
  const { writtenBy, sentences } = brief.data;
  if (writtenBy === null || sentences.length === 0) return null;
  return (
    <Card className="block p-4" data-testid="today-brief">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        {writtenBy === 'vy' && <Badge variant="proposal">{t('aiBadge')}</Badge>}
      </div>
      <p className="mt-2 text-sm text-foreground">{sentences.join(' ')}</p>
      <p className="mt-2 text-xs text-subtle-foreground">{writtenBy === 'vy' ? t('byVy') : t('byTemplate')}</p>
    </Card>
  );
}
