// SPDX-License-Identifier: AGPL-3.0-only
// "Quy trình bán hàng" in Settings (#3647): the stages of the deal board and the reminder for forgotten deals, which sat above the
// board behind a "Giai đoạn" button. Owners and admins edit them; the Deals screen links here with a small "Sửa giai đoạn".
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { Card } from '@ludy/ui/components/card';
import { DealStaleSetting } from './deal-stale-setting.tsx';
import { refreshDeals } from './deal-form.tsx';
import { PipelineSettings } from './pipeline-settings.tsx';
import { orpc, queryClient } from '../lib/api.ts';

// The card's address (`#sales-process`), as the booking cards have theirs.
export const SALES_PROCESS_ID = 'sales-process';

export function SalesProcessCard() {
  const t = useTranslations('deals.process');
  // An org that has not opened Deals yet has no stages: the first look here gives it the default ones, as the Deals screen does.
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  const setup = useMutation(
    orpc.crm.pipeline.setup.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(orpc.crm.pipeline.stages.queryKey({ input: {} }), data);
        refreshDeals();
      },
    }),
  );
  const { mutate: setupStages } = setup;
  const needsSetup = stages.data?.length === 0;
  useEffect(() => {
    if (needsSetup) setupStages({});
  }, [needsSetup, setupStages]);
  return (
    <Card id={SALES_PROCESS_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      <div className="mt-4 space-y-6">
        <PipelineSettings />
        <DealStaleSetting />
      </div>
    </Card>
  );
}
