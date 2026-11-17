// SPDX-License-Identifier: AGPL-3.0-only
// Ludy AI > AI connections (#3225): the AI apps connected to this org over MCP (#2975), when the deployment runs the endpoint. An owner or admin sees the org's, a member only their own. It was a card on
// Settings; the grants and their wake-ups are the same component, now a screen of the Ludy AI app.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { OrgMcpGrants } from '../components/org-mcp-grants.tsx';
import { Empty, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

export function AiConnectionsPage() {
  const t = useTranslations('aiConnectionsPage');
  const org = useQuery(orpc.org.get.queryOptions());
  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {getConfig().mcpEnabled !== true ? (
        <Empty title={t('off')} hint={t('offHint')} />
      ) : org.isPending || !org.data ? (
        <ListSkeleton />
      ) : (
        <OrgMcpGrants key={`org-mcp-grants:${org.data.slug}`} members={org.data.members} viewerRole={org.data.role} />
      )}
    </div>
  );
}
