// SPDX-License-Identifier: AGPL-3.0-only
// The Reports screen of the Engage app (#2435): the last item of its menu, with a tab for each area whose module runs
// (conversations and posts: social, sales: crm, ads: ads), so a one-person company reads how it is doing in one place. Each tab
// shows what its own screen already reads (components/report-panels.tsx); nothing is written here. ?area= keeps the tab.
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { AdsPanel, ConversationsPanel, PostsPanel, QuotesPanel, SalesPanel } from '../components/report-panels.tsx';
import { Empty, PageHeader } from '../components/ui.tsx';
import { getConfig } from '../lib/auth.ts';
import { reportTabs, shownTab, type ReportsSearch, type ReportTab } from '../lib/reports.ts';

export function ReportsPage() {
  const t = useTranslations('reports');
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: ReportsSearch = useSearch({ strict: false });
  const tabs = reportTabs(getConfig().modules);
  const tab = shownTab(tabs, search.area);
  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {tab === null ? (
        <Empty title={t('none')} />
      ) : (
        <div className="space-y-6">
          <Tabs value={tab} onValueChange={(value) => void navigate({ to: '/o/$slug/reports', params: { slug }, search: { area: value as ReportTab }, replace: true })}>
            <TabsList aria-label={t('tabsLabel')} className="flex flex-wrap group-data-horizontal/tabs:h-auto">
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {t(`tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {tab === 'conversations' && <ConversationsPanel slug={slug} />}
          {tab === 'sales' && <SalesPanel slug={slug} />}
          {tab === 'quotes' && <QuotesPanel slug={slug} />}
          {tab === 'posts' && <PostsPanel slug={slug} />}
          {tab === 'ads' && <AdsPanel slug={slug} />}
        </div>
      )}
    </div>
  );
}
