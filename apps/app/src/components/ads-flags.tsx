// SPDX-License-Identifier: AGPL-3.0-only
// The spend flags of the Ads screen (issue #2378), for owners and admins: where the month's spend is heading against a cap, a day that
// spent far more than its share of a cap, and a campaign whose cost per result jumped, each with the numbers it is based on. They are worked
// out from the stored figures with fixed rules and no model, and a flag changes nothing. Nothing is drawn when there is none; a pending read
// shows a skeleton and a failed one says so, with a retry.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { flagKey, flagText } from '../lib/ads-flags.ts';
import { orpc } from '../lib/api.ts';
import { CardSkeleton } from './ui.tsx';

export function AdsFlagsCard() {
  const t = useTranslations('ads.flags');
  const root = useTranslations();
  const f = useFormat();
  const flags = useQuery(orpc.ads.flags.queryOptions());
  if (flags.isPending) return <CardSkeleton />;
  if (flags.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3" role="status">
        <p className="text-sm text-muted-foreground">{t('error')}</p>
        <Button type="button" variant="outline" size="sm" loading={flags.isRefetching} onClick={() => void flags.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  const list = flags.data;
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="ads-flags-title" className="space-y-2">
      <h2 id="ads-flags-title" className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <ul className="space-y-1 text-sm text-foreground">
        {list.map((flag) => (
          <li key={flagKey(flag)} className="break-words">
            {flagText(root, f, flag)}
          </li>
        ))}
      </ul>
    </section>
  );
}
