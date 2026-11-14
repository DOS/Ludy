// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace card in Settings (ADR-0045 point 7, issue #2519), with the finance module and only where the deployment offers an adapter or the org already has a connection:
// owners and admins connect the org's own seller account (what they type is sealed on the server and never shown back), test the connection, pull the orders now and disconnect; every
// member reads the connections, when the orders were last pulled and how that ended. A pull only puts the orders in the Inbox for a member to confirm, exactly as a report file does:
// the card writes no order and moves no stock. A platform no adapter serves stays on the report file ("nhập file báo cáo"), with no connect button.
// The server enforces every rule; the screen offers only what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { LegalEntity, MarketplaceAdapterInfo, MarketplaceConnection, MarketplacePlatformInfo } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { canPollNow, connectablePlatforms, fieldIsSecret, fieldLabelKey, marketplaceCardShown, PLATFORM_KEYS, POLL_STATE_KEYS, TEST_STATE_KEYS } from '../lib/marketplace-connections.ts';
import type { Role } from '../lib/members.ts';

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.marketplace.connections.list.key() });
};

const STATUS_KEYS = { active: 'status.active', expired: 'status.expired', revoked: 'status.revoked', error: 'status.error' } as const;

function ConnectionItem({ connection, adapters, entities, canManage }: { connection: MarketplaceConnection; adapters: readonly MarketplaceAdapterInfo[]; entities: readonly LegalEntity[]; canManage: boolean }) {
  const t = useTranslations('marketplaceConnections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const test = useMutation(orpc.marketplace.connections.test.mutationOptions({ onSuccess: refresh }));
  const pull = useMutation(orpc.marketplace.connections.pollNow.mutationOptions({ onSuccess: refresh }));
  const disconnect = useMutation(orpc.marketplace.connections.disconnect.mutationOptions({ onSuccess: refresh }));
  const entity = entities.length > 1 ? entities.find((e) => e.id === connection.legalEntityId) : undefined;
  const live = connection.status === 'active';
  return (
    <li className="py-3" data-testid="marketplace-connection">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{t(PLATFORM_KEYS[connection.platform])}</span>
        <Badge variant={live ? 'secondary' : 'outline'}>{t(STATUS_KEYS[connection.status])}</Badge>
        {entity && <span className="text-xs text-muted-foreground">{entity.name}</span>}
        <span className="text-xs text-muted-foreground">{connection.displayName}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {connection.lastTestState ? `${t(TEST_STATE_KEYS[connection.lastTestState])}${connection.lastTestedAt ? ` · ${t('testedAt', { when: f.dateTime(connection.lastTestedAt) })}` : ''}` : t('neverTested')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {connection.lastPolledAt ? `${t('polledAt', { when: f.dateTime(connection.lastPolledAt) })}${connection.lastPollState ? ` · ${t(POLL_STATE_KEYS[connection.lastPollState])}` : ''}` : t('neverPolled')}
      </p>
      {connection.ordersWaiting > 0 && <p className="mt-1 text-sm text-muted-foreground">{t('ordersWaiting', { count: connection.ordersWaiting })}</p>}
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-2">
          {live && (
            <Button loading={test.isPending} size="sm" variant="outline" onClick={() => test.mutate({ id: connection.id })}>
              {t('test')}
            </Button>
          )}
          {canPollNow(connection, adapters) && (
            <Button loading={pull.isPending} size="sm" variant="outline" onClick={() => pull.mutate({ id: connection.id })}>
              {t('pollNow')}
            </Button>
          )}
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
      {pull.isSuccess && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t('pollQueued')}
        </p>
      )}
      {test.error && <ErrorText>{errorMessage(test.error)}</ErrorText>}
      {pull.error && <ErrorText>{errorMessage(pull.error)}</ErrorText>}
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
    </li>
  );
}

// Connect: the adapter (when the deployment offers more than one), the platform (an adapter serves), the entity it imports for (when the org has several) and the fields the adapter
// names. What is typed goes to the server once, sealed there, and is cleared here at once.
function ConnectForm({ adapters, platforms, entities }: { adapters: readonly MarketplaceAdapterInfo[]; platforms: readonly MarketplacePlatformInfo[]; entities: readonly LegalEntity[] }) {
  const t = useTranslations('marketplaceConnections');
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? '');
  const adapter = adapters.find((a) => a.id === adapterId) ?? adapters[0];
  const served = connectablePlatforms(platforms).filter((p) => adapter?.platforms.includes(p.platform));
  const [platform, setPlatform] = useState(served[0]?.platform ?? 'shopee');
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [entityId, setEntityId] = useState(defaultEntity?.id ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const fieldLabel = (name: string): string => {
    const key = fieldLabelKey(name, (candidate) => t.has(candidate as never));
    return key === null ? name : t(key as never);
  };
  const adapterKey = useId();
  const platformKey = useId();
  const entityKey = useId();
  const entity = entities.find((e) => e.id === entityId) ?? defaultEntity;
  const chosen = served.find((p) => p.platform === platform)?.platform ?? served[0]?.platform;
  const connect = useMutation(
    orpc.marketplace.connections.connect.mutationOptions({
      onSuccess: async () => {
        setFields({});
        await refresh();
      },
    }),
  );
  if (!adapter || !chosen) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connect.mutate({
      adapter: adapter.id,
      platform: chosen,
      legalEntityId: entity?.id ?? null,
      fields: Object.fromEntries(adapter.connectFields.map((name) => [name, fields[name] ?? ''])),
    });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('connectTitle')}</p>
      {adapter.offline && <p className="text-xs text-subtle-foreground">{t('offlineNote')}</p>}
      <div className="flex flex-wrap gap-2">
        {adapters.length > 1 && (
          <NativeSelect id={adapterKey} className="min-w-48" aria-label={t('adapter')} value={adapter.id} onChange={(e) => setAdapterId(e.target.value)}>
            {adapters.map((a) => (
              <NativeSelectOption key={a.id} value={a.id}>
                {a.offline ? t('adapterOffline') : a.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <NativeSelect id={platformKey} className="min-w-48" aria-label={t('platform')} value={chosen} onChange={(e) => setPlatform(e.target.value as typeof chosen)}>
          {served.map((p) => (
            <NativeSelectOption key={p.platform} value={p.platform}>
              {t(PLATFORM_KEYS[p.platform])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {entities.length > 1 && (
          <NativeSelect id={entityKey} className="min-w-48" aria-label={t('entity')} value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {adapter.connectFields.map((name) => (
          <Input
            key={name}
            className="min-w-48"
            maxLength={500}
            autoComplete="off"
            type={fieldIsSecret(name) ? 'password' : 'text'}
            placeholder={fieldLabel(name)}
            aria-label={fieldLabel(name)}
            value={fields[name] ?? ''}
            onChange={(e) => setFields((previous) => ({ ...previous, [name]: e.target.value }))}
          />
        ))}
        <Button loading={connect.isPending} type="submit" variant="outline" size="sm">
          {t('connect')}
        </Button>
      </div>
      {adapter.connectFields.length > 0 && <p className="text-xs text-subtle-foreground">{t('fieldsNote')}</p>}
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

export function MarketplaceConnectionsCard({ role }: { role: Role }) {
  const t = useTranslations('marketplaceConnections');
  const headingId = useId();
  const canManage = role === 'owner' || role === 'admin';
  const providers = useQuery(orpc.marketplace.providers.queryOptions());
  const connections = useQuery(orpc.marketplace.connections.list.queryOptions());
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const adapters = providers.data?.adapters ?? [];
  const platforms = providers.data?.platforms ?? [];
  const list = connections.data ?? [];
  const loading = providers.isLoading || connections.isLoading || (canManage && entities.isLoading);
  const failure = providers.error ?? connections.error ?? entities.error;
  // No adapter on and nothing connected: nothing to show, so a deployment that offers none draws no card.
  if (!loading && !failure && !marketplaceCardShown(adapters, list)) return null;
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
          <ul className="mt-3 divide-y" aria-label={t('platformsTitle')}>
            {platforms.map((p) => (
              <li key={p.platform} data-testid="marketplace-platform" data-adapter={p.adapter ? 'true' : 'false'} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className={p.adapter ? 'font-medium' : 'font-medium text-muted-foreground'}>{t(PLATFORM_KEYS[p.platform])}</span>
                {p.adapter ? <span className="text-muted-foreground">{t('adapterOn')}</span> : <span className="text-subtle-foreground">{t('fileOnly')}</span>}
              </li>
            ))}
          </ul>
          {list.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('noConnections')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {list.map((c) => (
                <ConnectionItem key={c.id} connection={c} adapters={adapters} entities={entities.data ?? []} canManage={canManage} />
              ))}
            </ul>
          )}
          {canManage && <ConnectForm adapters={adapters} platforms={platforms} entities={entities.data ?? []} />}
        </>
      )}
    </Card>
  );
}
