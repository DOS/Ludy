// SPDX-License-Identifier: AGPL-3.0-only
// Ludy AI > AI use and budgets (#3225): this month's AI use by feature and by agent, and the budgets that stop it. The two sections the org chart screen used to end with, now a screen of the
// Ludy AI app beside the team's chart and the connections of other AI tools. Owners and admins read them; the budgets are set by owners (the same permissions as before).
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { agentPermissions } from '../lib/agents.ts';
import { errorMessage, orpc } from '../lib/api.ts';
import { AiUse, Budgets } from './agents.tsx';

export function AiUsagePage() {
  const t = useTranslations('aiUsagePage');
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const perms = agentPermissions(org.data?.role);
  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {org.isPending || chart.isPending ? (
        <ListSkeleton />
      ) : chart.error ? (
        <ErrorText>{errorMessage(chart.error)}</ErrorText>
      ) : !perms.budgets ? (
        <Empty title={t('noAccess')} hint={t('noAccessHint')} />
      ) : (
        <>
          <AiUse agents={chart.data.agents} />
          <Budgets agents={chart.data.agents} perms={perms} />
        </>
      )}
    </div>
  );
}
