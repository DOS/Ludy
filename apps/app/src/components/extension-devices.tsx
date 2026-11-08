// SPDX-License-Identifier: AGPL-3.0-only
// "Connected devices" of the Ludy extension (issue #2582, ADR-0047 point 10): the member's own extension tokens in this
// org, with a one-click revoke. The kernel lists and revokes only the member's own, and never returns a hash; a revoked
// token is refused on its next request.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText, RowsSkeleton } from './ui.tsx';

export function ExtensionDevices() {
  const t = useTranslations('extensionDevices');
  const f = useFormat();
  const tokens = useQuery(orpc.extension.tokens.list.queryOptions({ input: {} }));
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useMutation(
    orpc.extension.tokens.revoke.mutationOptions({
      onSuccess: () => {
        setConfirm(null);
        void queryClient.invalidateQueries({ queryKey: orpc.extension.key() });
      },
    }),
  );
  const now = Date.now();
  const rows = tokens.data ?? [];
  const live = rows.filter((r) => r.revokedAt === null && new Date(r.expiresAt).getTime() > now);
  const ended = rows.filter((r) => !live.includes(r));
  return (
    <Card className="block space-y-3 p-4" data-testid="extension-devices">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {tokens.isPending && <RowsSkeleton rows={2} />}
      {tokens.error && <ErrorText>{errorMessage(tokens.error)}</ErrorText>}
      {tokens.data && live.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
      <ul className="divide-y">
        {live.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="extension-device">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <span className="truncate">{r.deviceName}</span>
                {r.scopes.map((s) => (
                  <Badge key={s}>{t(`scope.${s}`)}</Badge>
                ))}
              </p>
              <p className="text-xs text-subtle-foreground">
                {r.lastUsedAt ? t('lastUsed', { at: f.dateTime(r.lastUsedAt) }) : t('neverUsed')}
                {` · ${t('connectedAt', { at: f.dateTime(r.createdAt) })} · ${t('expiresAt', { at: f.dateTime(r.expiresAt) })}`}
              </p>
            </div>
            {confirm === r.id ? (
              <div className="flex shrink-0 gap-2" role="alertdialog" aria-label={t('confirm')}>
                <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ tokenId: r.id })}>
                  {t('revoke')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirm(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setConfirm(r.id)}>
                {t('disconnect')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-subtle-foreground">{t('ended', { count: ended.length })}</summary>
          <ul className="mt-1 divide-y">
            {ended.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-foreground">{r.deviceName}</span>
                <Badge variant="destructive">{r.revokedAt ? t('revoked') : t('expired')}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
