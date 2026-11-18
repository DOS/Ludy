// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS Kế toán card in Settings (#3875, S2 of #3854), with the finance module and only where the deployment offers the connector or the org already has a connection: owners and
// admins connect an entity by typing the access code they made in AMIS (it is sealed on the server and never shown back: the screen only says since when the connection exists) and
// disconnect it; every member reads the connections. The card sends nothing to AMIS: pushing vouchers is a later slice. The server enforces every rule; the screen offers only what can succeed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { LegalEntity, MisaAmisConnection } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { connectableEntities, misaAmisCardShown } from '../lib/misa-amis-connections.ts';
import type { Role } from '../lib/members.ts';

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.misaAmis.connections.list.key() });
};

const STATUS_KEYS = { active: 'status.active', expired: 'status.expired', revoked: 'status.revoked', error: 'status.error' } as const;

function ConnectionItem({ connection, entities, canManage }: { connection: MisaAmisConnection; entities: readonly LegalEntity[]; canManage: boolean }) {
  const t = useTranslations('misaAmisConnections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation(orpc.misaAmis.connections.disconnect.mutationOptions({ onSuccess: refresh }));
  const entity = entities.length > 1 ? entities.find((e) => e.id === connection.legalEntityId) : undefined;
  return (
    <li className="py-3" data-testid="misa-amis-connection">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={connection.status === 'active' ? 'secondary' : 'outline'}>{t(STATUS_KEYS[connection.status])}</Badge>
        {entity && <span className="text-xs text-muted-foreground">{entity.name}</span>}
        <span className="text-xs text-muted-foreground">{t('connectedSince', { when: f.dateTime(connection.connectedAt) })}</span>
      </div>
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-2">
          {confirming ? (
            <>
              <span className="self-center text-xs text-muted-foreground">{t('disconnectConfirm')}</span>
              <Button loading={disconnect.isPending} size="sm" variant="destructive" onClick={() => disconnect.mutate({ id: connection.id })}>
                {t('disconnectYes')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t('keep')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              {t('disconnect')}
            </Button>
          )}
        </div>
      )}
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
    </li>
  );
}

// Connect: the entity (when the org has several without a connection) and the access code. What is typed goes to the server once, sealed there, and is cleared here at once.
function ConnectForm({ entities }: { entities: readonly LegalEntity[] }) {
  const t = useTranslations('misaAmisConnections');
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [entityId, setEntityId] = useState(defaultEntity?.id ?? '');
  const [accessCode, setAccessCode] = useState('');
  const entityKey = useId();
  const entity = entities.find((e) => e.id === entityId) ?? defaultEntity;
  const connect = useMutation(
    orpc.misaAmis.connections.connect.mutationOptions({
      onSuccess: async () => {
        setAccessCode('');
        await refresh();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connect.mutate({ legalEntityId: entity?.id ?? null, accessCode });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('connectTitle')}</p>
      <div className="flex flex-wrap gap-2">
        {entities.length > 1 && (
          <NativeSelect id={entityKey} className="min-w-48" aria-label={t('entity')} value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Input className="min-w-48" maxLength={500} autoComplete="off" type="password" placeholder={t('accessCode')} aria-label={t('accessCode')} value={accessCode} onChange={(e) => setAccessCode(e.target.value)} />
        <Button loading={connect.isPending} disabled={accessCode.trim() === ''} type="submit" variant="outline" size="sm">
          {t('connect')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t('accessCodeNote')}</p>
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

export function MisaAmisConnectionsCard({ role }: { role: Role }) {
  const t = useTranslations('misaAmisConnections');
  const headingId = useId();
  const canManage = role === 'owner' || role === 'admin';
  const status = useQuery(orpc.misaAmis.status.queryOptions());
  const connections = useQuery(orpc.misaAmis.connections.list.queryOptions());
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const offered = status.data?.offered === true;
  const list = connections.data ?? [];
  const loading = status.isLoading || connections.isLoading || (canManage && entities.isLoading);
  const failure = status.error ?? connections.error ?? entities.error;
  // The connector is not offered and nothing is connected: nothing to show.
  if (!loading && !failure && !misaAmisCardShown(offered, list)) return null;
  const free = connectableEntities(entities.data ?? [], list);
  return (
    <Card role="group" aria-labelledby={headingId} className="block p-4">
      <p id={headingId} className="text-sm font-medium text-muted-foreground">
        {t('title')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {loading ? (
        <RowsSkeleton />
      ) : failure ? (
        <ErrorText>{errorMessage(failure)}</ErrorText>
      ) : (
        <>
          {!offered && <p className="mt-3 text-sm text-subtle-foreground">{t('off')}</p>}
          {list.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('noConnections')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {list.map((c) => (
                <ConnectionItem key={c.id} connection={c} entities={entities.data ?? []} canManage={canManage} />
              ))}
            </ul>
          )}
          {canManage && offered && free.length > 0 && <ConnectForm key={free.map((e) => e.id).join(',')} entities={free} />}
        </>
      )}
    </Card>
  );
}
