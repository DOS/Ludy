// SPDX-License-Identifier: AGPL-3.0-only
// The deterministic 7-day comparison note on the Ads screen (#2220): side-by-side platform breakdown (Meta, Google, sandbox),
// spend change, cost per result change, and the campaign that moved the most across connected platforms, per currency. Worked
// out from the stored figures with fixed rules and no model.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { weeklyPlatformLine, weeklySkippedLine, weeklyTopMoverLine, weeklyWindowLine } from '../lib/ads-weekly-note.ts';
import { orpc } from '../lib/api.ts';
import { CardSkeleton } from './ui.tsx';

export function AdsWeeklyNoteCard() {
  const t = useTranslations('ads.weeklyNote');
  const root = useTranslations();
  const f = useFormat();
  const notes = useQuery(orpc.ads.weeklyNote.queryOptions());
  if (notes.isPending) return <CardSkeleton />;
  if (notes.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3" role="status">
        <p className="text-sm text-muted-foreground">{t('error')}</p>
        <Button type="button" variant="outline" size="sm" loading={notes.isRefetching} onClick={() => void notes.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  const list = notes.data;
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="ads-weekly-note-title" className="space-y-3">
      <h2 id="ads-weekly-note-title" className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <div className="space-y-3 text-sm text-foreground">
        {list.map((note) => {
          const skipped = weeklySkippedLine(root, note);
          return (
            <div key={note.currency} className="space-y-1">
              <p className="font-medium break-words">{weeklyWindowLine(root, f, note)}</p>
              <ul className="space-y-1 pl-4 list-disc">
                {note.platforms.map((platform) => (
                  <li key={platform.provider} className="break-words">
                    {weeklyPlatformLine(root, f, note.currency, platform)}
                  </li>
                ))}
                {note.topMover && <li className="break-words">{weeklyTopMoverLine(root, f, note.currency, note.topMover)}</li>}
              </ul>
              {skipped && <p className="text-xs text-muted-foreground">{skipped}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
