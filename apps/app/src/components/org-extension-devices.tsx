// SPDX-License-Identifier: AGPL-3.0-only
// "Extension devices of the members" in Settings (issue #2868, ADR-0047 point 10): for owners and admins, the connected
// Ludy extension devices of the other members in this org, each with a one-click disconnect. The kernel lists and revokes
// with kernel.extension.token.list_org and revoke_member and never returns a hash; an admin cannot disconnect an owner's
// device (the screen offers nothing there and the server refuses it too); a disconnected device is refused on its next
// request and the revoke writes an audit row. Your own devices are the card above. No AI takes part.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText, RowsSkeleton } from './ui.tsx';

export interface DeviceMember {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
}

export function OrgExtensionDevices({ members, viewerRole, me }: { members: readonly DeviceMember[]; viewerRole: 'owner' | 'admin'; me: string }) {
  const t = useTranslations('orgExtensionDevices');
  const f = useFormat();
  const tokens = useQuery(orpc.extension.tokens.listOrg.queryOptions({ input: {} }));
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useMutation(
    orpc.extension.tokens.revokeMember.mutationOptions({
      onSuccess: () => {
        setConfirm(null);
        void queryClient.invalidateQueries({ queryKey: orpc.extension.key() });
      },
    }),
  );
  const now = Date.now();
  // The other members' devices: yours are in the card above.
  const rows = (tokens.data ?? []).filter((r) => r.userId !== me);
  const live = rows.filter((r) => r.revokedAt === null && new Date(r.expiresAt).getTime() > now);
  const ended = rows.filter((r) => !live.includes(r));
  const memberOf = (userId: string) => members.find((m) => m.userId === userId);
  const nameOf = (userId: string) => {
    const m = memberOf(userId);
    return m ? (m.displayName ?? m.email) : t('formerMember');
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="org-extension-devices">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {tokens.isPending && <RowsSkeleton rows={2} />}
      {tokens.error && <ErrorText>{errorMessage(tokens.error)}</ErrorText>}
      {tokens.data && live.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
      <ul className="divide-y">
        {live.map((r) => {
          const ownerDevice = memberOf(r.userId)?.role === 'owner';
          const mayDisconnect = viewerRole === 'owner' || !ownerDevice;
          const name = nameOf(r.userId);
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="org-extension-device">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-foreground">
                  <span className="truncate font-medium">{name}</span>
                  <span className="truncate text-muted-foreground">{r.deviceName}</span>
                  {r.scopes.map((s) => (
                    <Badge key={s}>{t(`scope.${s}`)}</Badge>
                  ))}
                </p>
                <p className="text-xs text-subtle-foreground">
                  {r.lastUsedAt ? t('lastUsed', { at: f.dateTime(r.lastUsedAt) }) : t('neverUsed')}
                  {` · ${t('connectedAt', { at: f.dateTime(r.createdAt) })} · ${t('expiresAt', { at: f.dateTime(r.expiresAt) })}`}
                </p>
              </div>
              {!mayDisconnect ? (
                <span className="shrink-0 text-xs text-subtle-foreground">{t('ownerOnly')}</span>
              ) : confirm === r.id ? (
                <div className="flex shrink-0 gap-2" role="alertdialog" aria-label={t('confirm', { name })}>
                  <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate({ tokenId: r.id })}>
                    {t('revoke')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirm(null)}>
                    {t('cancel')}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0" aria-label={t('disconnectOf', { name, device: r.deviceName })} onClick={() => setConfirm(r.id)}>
                  {t('disconnect')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-subtle-foreground">{t('ended', { count: ended.length })}</summary>
          <ul className="mt-1 divide-y">
            {ended.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-foreground">{`${nameOf(r.userId)} · ${r.deviceName}`}</span>
                <Badge variant="destructive">{r.revokedAt ? t('revoked') : t('expired')}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
