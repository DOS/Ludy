// SPDX-License-Identifier: AGPL-3.0-only
// Vy's daily brief on Home (issue #2383): a few sentences above the "Hôm nay cần bạn" list, written from that list's counts,
// amounts and due dates. The server checks every number of a sentence against them and falls back to a plain sentence built
// from the same figures; with the month's AI budget spent there is no brief and the list stands alone. It approves and
// sends nothing. A brief that fails to load is simply not shown: the list is what matters.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { TodayItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Card } from '@crove/ui/components/card';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { client } from '../lib/api.ts';
import { briefDay, briefStorageKey, listFingerprint, readStoredBrief, storeBrief } from '../lib/today-brief.ts';

export function TodayBrief({ slug, items }: { slug: string; items: readonly TodayItem[] }) {
  const t = useTranslations('today.brief');
  const { locale } = useLocaleSetting();
  const language = locale === 'en' ? 'en' : 'vi';
  const key = briefStorageKey(slug, briefDay(), language, listFingerprint(items));
  const brief = useQuery({
    // The same list on the same day asks the model once.
    queryKey: ['today', 'brief', key],
    // A brief kept in this tab for the same list is the answer; the card never waits for it.
    initialData: () => readStoredBrief(key),
    queryFn: async () => {
      const fresh = await client.today.brief({ language });
      storeBrief(key, fresh);
      return fresh;
    },
    // While the list changes (it is refreshed every minute) the card keeps the previous brief instead of flashing a placeholder.
    placeholderData: keepPreviousData,
    enabled: items.length > 0,
    // A final brief is good for the hour; a fallback is asked again soon.
    staleTime: (query) => (query.state.data?.final ? 60 * 60 * 1000 : 30 * 1000),
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
