// SPDX-License-Identifier: AGPL-3.0-only
// The e-invoice provider card in Settings (ADR-0044 point 2, issue #2501), with the finance module and only where the deployment offers a provider: owners and
// admins connect the org's own account at a provider (what they type is sealed on the server and never shown back), test the connection, pick the entity's
// default series and disconnect; every member reads the connections, their last test and the series. The card issues nothing and sends no invoice.
// The server enforces every rule; the screen offers only what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { EInvoiceConnection, EInvoiceProviderInfo, EInvoiceSeries, LegalEntity } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { decodeSymbol, einvoiceCardShown, fieldIsSecret, seriesOf, STATE_KEYS, templateWord } from '../lib/einvoice-connections.ts';
import type { Role } from '../lib/members.ts';

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.einvoice.connections.list.key() });
  await queryClient.invalidateQueries({ queryKey: orpc.einvoice.series.list.key() });
};

const STATUS_KEYS = { active: 'status.active', expired: 'status.expired', revoked: 'status.revoked', error: 'status.error' } as const;

// One series: its template and symbol, read in words, and whether it is the entity's default.
function SeriesRow({ series, canManage }: { series: EInvoiceSeries; canManage: boolean }) {
  const t = useTranslations('einvoiceConnections');
  const parts = decodeSymbol(series.symbol);
  const word = templateWord(series.templateNo);
  const setDefault = useMutation(orpc.einvoice.series.setDefault.mutationOptions({ onSuccess: refresh }));
  return (
    <li data-testid="einvoice-series" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="font-medium tabular-nums">{t('seriesLine', { template: series.templateNo, symbol: series.symbol })}</span>
      <span className="text-muted-foreground">
        {word ? t(word) : t('templateOther', { template: series.templateNo })}
        {parts && ` · ${parts.coded ? t('symbolCoded') : t('symbolUncoded')} · ${t('symbolYear', { year: parts.year })} · ${t('symbolType', { letter: parts.typeLetter })}`}
      </span>
      {series.isDefault ? (
        <Badge variant="secondary">{t('defaultSeries')}</Badge>
      ) : (
        canManage && (
          <Button loading={setDefault.isPending} size="sm" variant="ghost" onClick={() => setDefault.mutate({ seriesId: series.id })}>
            {t('makeDefault')}
          </Button>
        )
      )}
      {setDefault.error && <ErrorText>{errorMessage(setDefault.error)}</ErrorText>}
    </li>
  );
}

function ConnectionItem({ connection, series, entities, canManage }: { connection: EInvoiceConnection; series: readonly EInvoiceSeries[]; entities: readonly LegalEntity[]; canManage: boolean }) {
  const t = useTranslations('einvoiceConnections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const test = useMutation(orpc.einvoice.connections.test.mutationOptions({ onSuccess: refresh }));
  const disconnect = useMutation(orpc.einvoice.connections.disconnect.mutationOptions({ onSuccess: refresh }));
  const entity = entities.length > 1 ? entities.find((e) => e.id === connection.legalEntityId) : undefined;
  const rows = seriesOf(series, connection);
  const live = connection.status === 'active';
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{connection.displayName}</span>
        <Badge variant={live ? 'secondary' : 'outline'}>{t(STATUS_KEYS[connection.status])}</Badge>
        {entity && <span className="text-xs text-muted-foreground">{entity.name}</span>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {connection.lastTestState ? `${t(STATE_KEYS[connection.lastTestState])}${connection.lastTestedAt ? ` · ${t('testedAt', { when: f.dateTime(connection.lastTestedAt) })}` : ''}` : t('neverTested')}
      </p>
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-2">
          {live && (
            <Button loading={test.isPending} size="sm" variant="outline" onClick={() => test.mutate({ id: connection.id })}>
              {t('test')}
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
      {test.error && <ErrorText>{errorMessage(test.error)}</ErrorText>}
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
      <p className="mt-3 text-xs font-medium text-muted-foreground">{t('seriesTitle')}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-subtle-foreground">{t('noSeries')}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((s) => (
            <SeriesRow key={s.id} series={s} canManage={canManage && live} />
          ))}
        </ul>
      )}
    </li>
  );
}

// Connect: the provider (when the deployment offers more than one), the entity it issues for (when the org has several), the seller's tax code (only when the entity
// has none), and the fields the provider names. What is typed goes to the server once, sealed there, and is cleared here at once.
function ConnectForm({ providers, entities }: { providers: readonly EInvoiceProviderInfo[]; entities: readonly LegalEntity[] }) {
  const t = useTranslations('einvoiceConnections');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [entityId, setEntityId] = useState(defaultEntity?.id ?? '');
  const [taxCode, setTaxCode] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const providerKey = useId();
  const entityKey = useId();
  const taxKey = useId();
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const entity = entities.find((e) => e.id === entityId) ?? defaultEntity;
  const connect = useMutation(
    orpc.einvoice.connections.connect.mutationOptions({
      onSuccess: async () => {
        setFields({});
        setTaxCode('');
        await refresh();
      },
    }),
  );
  if (!provider) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connect.mutate({
      provider: provider.id,
      legalEntityId: entity?.id ?? null,
      sellerTaxCode: entity?.taxCode ? null : taxCode.trim() || null,
      fields: Object.fromEntries(provider.connectFields.map((name) => [name, fields[name] ?? ''])),
    });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('connectTitle')}</p>
      {provider.offline && <p className="text-xs text-subtle-foreground">{t('offlineNote')}</p>}
      <div className="flex flex-wrap gap-2">
        {providers.length > 1 && (
          <NativeSelect id={providerKey} className="min-w-48" aria-label={t('provider')} value={provider.id} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.offline ? t('providerOffline') : p.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {entities.length > 1 && (
          <NativeSelect id={entityKey} className="min-w-48" aria-label={t('entity')} value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {entity && !entity.taxCode && (
          <Input id={taxKey} className="min-w-48" maxLength={20} inputMode="numeric" placeholder={t('taxCodePlaceholder')} aria-label={t('taxCode')} value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
        )}
        {provider.connectFields.map((name) => (
          <Input
            key={name}
            className="min-w-48"
            maxLength={500}
            autoComplete="off"
            type={fieldIsSecret(name) ? 'password' : 'text'}
            placeholder={name}
            aria-label={name}
            value={fields[name] ?? ''}
            onChange={(e) => setFields((previous) => ({ ...previous, [name]: e.target.value }))}
          />
        ))}
        <Button loading={connect.isPending} type="submit" variant="outline" size="sm">
          {t('connect')}
        </Button>
      </div>
      {provider.connectFields.length > 0 && <p className="text-xs text-subtle-foreground">{t('fieldsNote')}</p>}
      {entity && !entity.taxCode && <p className="text-xs text-subtle-foreground">{t('taxCodeHint')}</p>}
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

export function EInvoiceConnectionsCard({ role }: { role: Role }) {
  const t = useTranslations('einvoiceConnections');
  const canManage = role === 'owner' || role === 'admin';
  const providers = useQuery(orpc.einvoice.providers.queryOptions());
  const connections = useQuery(orpc.einvoice.connections.list.queryOptions());
  const series = useQuery(orpc.einvoice.series.list.queryOptions());
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const offered = providers.data ?? [];
  const list = connections.data ?? [];
  const loading = providers.isLoading || connections.isLoading || series.isLoading || (canManage && entities.isLoading);
  const failure = providers.error ?? connections.error ?? series.error ?? entities.error;
  // No provider on and nothing connected: nothing to show, so a deployment that offers none draws no card.
  if (!loading && !failure && !einvoiceCardShown(offered, list)) return null;
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {loading ? (
        <RowsSkeleton />
      ) : failure ? (
        <ErrorText>{errorMessage(failure)}</ErrorText>
      ) : (
        <>
          {list.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('noConnections')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {list.map((c) => (
                <ConnectionItem key={c.id} connection={c} series={series.data ?? []} entities={entities.data ?? []} canManage={canManage} />
              ))}
            </ul>
          )}
          {canManage && <ConnectForm providers={offered} entities={entities.data ?? []} />}
        </>
      )}
    </Card>
  );
}
