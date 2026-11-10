// SPDX-License-Identifier: AGPL-3.0-only
// "Connected AI apps" in Settings (ADR-0051 decision 2, issue #2975): for owners and admins, the MCP clients that were given read access to this org, each with
// a one-click disconnect. The kernel lists and revokes with kernel.mcp.grant.list and revoke and never returns a token; a disconnected client is refused on its next
// request (its tokens stop at once) and the revoke writes an audit row. The name a client shows is the one it gave itself. No AI takes part on this screen.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText, RowsSkeleton } from './ui.tsx';

export interface GrantMember {
  userId: string;
  displayName: string | null;
  email: string;
}

export function OrgMcpGrants({ members }: { members: readonly GrantMember[] }) {
  const t = useTranslations('orgMcpGrants');
  const f = useFormat();
  const grants = useQuery(orpc.mcp.grant.list.queryOptions({ input: {} }));
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useMutation(
    orpc.mcp.grant.revoke.mutationOptions({
      onSuccess: () => {
        setConfirm(null);
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
      },
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.key() });
      },
    }),
  );
  const ask = (id: string | null) => {
    revoke.reset();
    setConfirm(id);
  };
  const now = Date.now();
  const rows = grants.data ?? [];
  const live = rows.filter((r) => r.revokedAt === null && new Date(r.expiresAt).getTime() > now);
  const ended = rows.filter((r) => !live.includes(r));
  const nameOf = (userId: string) => {
    const m = members.find((x) => x.userId === userId);
    return m ? (m.displayName ?? m.email) : t('formerMember');
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="org-mcp-grants">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {grants.isPending && <RowsSkeleton rows={2} />}
      {grants.error && <ErrorText>{errorMessage(grants.error)}</ErrorText>}
      {grants.data && live.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
      <ul className="divide-y">
        {live.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="org-mcp-grant">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <span className="truncate font-medium">{r.clientName}</span>
                <span className="truncate text-muted-foreground">{r.clientHost}</span>
                {r.scopes.map((s) => (
                  <Badge key={s}>{t(`scope.${s}`)}</Badge>
                ))}
              </p>
              <p className="text-xs text-subtle-foreground">
                {t('givenBy', { name: nameOf(r.userId) })}
                {` · ${r.lastUsedAt ? t('lastUsed', { at: f.dateTime(r.lastUsedAt) }) : t('neverUsed')} · ${t('expiresAt', { at: f.dateTime(r.expiresAt) })}`}
              </p>
              {revoke.error && revoke.variables?.grantId === r.id && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
            </div>
            {confirm === r.id ? (
              <div className="flex shrink-0 gap-2" role="alertdialog" aria-label={t('confirm', { name: r.clientName })}>
                <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ grantId: r.id })}>
                  {t('revoke')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => ask(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="shrink-0" aria-label={t('disconnectOf', { name: r.clientName })} onClick={() => ask(r.id)}>
                {t('disconnect')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-subtle-foreground">{t('ended', { count: ended.length })}</summary>
          <ul className="mt-1 divide-y">
            {ended.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-foreground">{`${r.clientName} · ${nameOf(r.userId)}`}</span>
                <Badge variant="destructive">{r.revokedAt ? t('revoked') : t('expired')}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
