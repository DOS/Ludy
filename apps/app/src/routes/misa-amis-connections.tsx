// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS Kế toán card in Settings (#3875, S2 of #3854), with the finance module and only where the deployment offers the connector or the org already has a connection: owners and
// admins connect an entity by typing the access code they made in AMIS (it is sealed on the server and never shown back: the screen only says since when the connection exists) and
// disconnect it; every member reads the connections. The card sends nothing to AMIS: pushing vouchers is a later slice. The server enforces every rule; the screen offers only what can succeed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MISA_AMIS_PRODUCTS, type LegalEntity, type MisaAmisConnection, type MisaAmisProduct } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { MisaAmisPreviewPanel } from '../components/misa-amis-preview-panel.tsx';
import { MisaAmisPushList } from '../components/misa-amis-push-panel.tsx';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { connectableEntities, misaAmisCardShown } from '../lib/misa-amis-connections.ts';
import { pushOffer } from '../lib/misa-amis-push.ts';
import type { Role } from '../lib/members.ts';

const refresh = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.misaAmis.connections.list.key() });
};

const STATUS_KEYS = { active: 'status.active', expired: 'status.expired', revoked: 'status.revoked', error: 'status.error' } as const;
const TEST_STATE_KEYS = { works: 'testState.works', wrong_credentials: 'testState.wrong_credentials', unreachable: 'testState.unreachable' } as const;
// MISA ASP's connection (#4111, S2 of #4103) has its own words for a refused or unreachable test: they name ASP, not AMIS.
const TEST_STATE_KEYS_ASP = { works: 'testState.works', wrong_credentials: 'testStateAsp.wrong_credentials', unreachable: 'testStateAsp.unreachable' } as const;
// The test runs in the worker: after it is queued the list is read again every two seconds until the time of the last test changes, for half a minute at most.
const TEST_POLL_MS = 2000;
const TEST_WAIT_MS = 30_000;

function ConnectionItem({ connection, entities, canManage, pushOffered }: { connection: MisaAmisConnection; entities: readonly LegalEntity[]; canManage: boolean; pushOffered: boolean }) {
  const t = useTranslations('misaAmisConnections');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation(orpc.misaAmis.connections.disconnect.mutationOptions({ onSuccess: refresh }));
  // What the time of the last test was when the test was asked for: the answer has landed once it changes.
  const [waiting, setWaiting] = useState<{ from: string | null; until: number } | null>(null);
  const [slow, setSlow] = useState(false);
  const test = useMutation(
    orpc.misaAmis.connections.test.mutationOptions({
      onMutate: () => setSlow(false),
      onSuccess: () => setWaiting({ from: connection.lastTestedAt, until: Date.now() + TEST_WAIT_MS }),
    }),
  );
  // A result that lands late (a refetch on focus, say) takes the "no result yet" note away.
  useEffect(() => setSlow(false), [connection.lastTestedAt]);
  useEffect(() => {
    if (waiting === null) return;
    if (connection.lastTestedAt !== waiting.from) {
      setWaiting(null);
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() > waiting.until) {
        setWaiting(null);
        setSlow(true);
        return;
      }
      void refresh();
    }, TEST_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, connection.lastTestedAt]);
  const entity = entities.length > 1 ? entities.find((e) => e.id === connection.legalEntityId) : undefined;
  return (
    <li className="py-3" data-testid="misa-amis-connection">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant="outline" data-testid="misa-amis-product">
          {t(`product.${connection.product}`)}
        </Badge>
        <Badge variant={connection.status === 'active' ? 'secondary' : 'outline'}>{t(STATUS_KEYS[connection.status])}</Badge>
        {entity && <span className="text-xs text-muted-foreground">{entity.name}</span>}
        <span className="text-xs text-muted-foreground">{t('connectedSince', { when: f.dateTime(connection.connectedAt) })}</span>
      </div>
      {/* A status region that exists before its text changes, so a screen reader announces the result (and the slow note) without moving focus. */}
      <div role="status">
        <p className="mt-1 text-sm text-muted-foreground" data-testid="misa-amis-test-state">
          {connection.lastTestState ? `${t((connection.product === 'asp' ? TEST_STATE_KEYS_ASP : TEST_STATE_KEYS)[connection.lastTestState])}${connection.lastTestedAt ? ` · ${t('testedAt', { when: f.dateTime(connection.lastTestedAt) })}` : ''}` : t('neverTested')}
        </p>
        {slow && <p className="mt-1 text-xs text-muted-foreground">{t('testSlow')}</p>}
      </div>
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-2">
          {connection.status === 'active' && !confirming && (
            <Button loading={test.isPending || waiting !== null} size="sm" variant="outline" onClick={() => test.mutate({ id: connection.id })}>
              {waiting !== null ? t('testing') : t('test')}
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
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
      {test.error && <ErrorText>{errorMessage(test.error)}</ErrorText>}
      {/* The preview and the push list belong to an AMIS connection always, and to an ASP connection only where this deployment switched the push to ASP on (MISA_ASP_PUSH, #4113): `pushOffered` here is the
          switch of the connection's own product. Without it an ASP connection is connected and tested here and nothing more. */}
      {connection.status === 'active' && (connection.product === 'amis' || pushOffered) && (
        <MisaAmisPreviewPanel legalEntityId={connection.legalEntityId} push={{ connectionId: connection.id, offer: pushOffer({ canManage, pushOffered, testState: connection.lastTestState }) }} />
      )}
      {connection.status === 'active' && (connection.product === 'amis' || pushOffered) && <MisaAmisPushList connectionId={connection.id} canManage={canManage} />}
      {connection.status === 'active' && connection.product === 'asp' && !pushOffered && (
        <p className="mt-2 text-xs text-subtle-foreground" data-testid="misa-asp-later">
          {t('aspLater')}
        </p>
      )}
    </li>
  );
}

// Connect: the entity (when the org has several without a connection) and the access code. What is typed goes to the server once, sealed there, and is cleared here at once.
function ConnectForm({ entities, namesEntity, products }: { entities: readonly LegalEntity[]; namesEntity: boolean; products: readonly MisaAmisProduct[] }) {
  const t = useTranslations('misaAmisConnections');
  // The product is chosen only where the deployment offers both; with one, it is that one. A legal entity is on one product, never both (the server enforces it).
  const [chosen, setChosen] = useState<MisaAmisProduct>(products[0] ?? 'amis');
  const product = products.includes(chosen) ? chosen : (products[0] ?? 'amis');
  const productKey = useId();
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [entityId, setEntityId] = useState(defaultEntity?.id ?? '');
  const [accessCode, setAccessCode] = useState('');
  const entityKey = useId();
  const codeKey = useId();
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
    connect.mutate({ legalEntityId: entity?.id ?? null, product, accessCode });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t(product === 'asp' ? 'connectTitleAsp' : 'connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t(product === 'asp' ? 'connectTitleAsp' : 'connectTitle')}</p>
      <div className="flex flex-wrap items-end gap-2">
        {products.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={productKey} className="text-xs text-muted-foreground">
              {t('productLabel')}
            </label>
            <NativeSelect id={productKey} className="min-w-48" value={product} onChange={(e) => setChosen(e.target.value as MisaAmisProduct)}>
              {products.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {t(`product.${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        {entities.length > 1 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={entityKey} className="text-xs text-muted-foreground">
              {t('entity')}
            </label>
            <NativeSelect id={entityKey} className="min-w-48" value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
              {entities.map((e) => (
                <NativeSelectOption key={e.id} value={e.id}>
                  {e.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : (
          // One entity left to connect: no choice to make, but when the org has several, the one that is connected is named.
          namesEntity &&
          entity && (
            <p className="self-center text-xs text-muted-foreground" data-testid="misa-amis-target">
              {t('entity')}: {entity.name}
            </p>
          )
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={codeKey} className="text-xs text-muted-foreground">
            {t(product === 'asp' ? 'accessCodeAsp' : 'accessCode')}
          </label>
          <Input id={codeKey} className="min-w-48" maxLength={500} autoComplete="off" type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} />
        </div>
        <Button loading={connect.isPending} disabled={accessCode.trim() === ''} type="submit" variant="outline" size="sm">
          {t('connect')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t(product === 'asp' ? 'accessCodeNoteAsp' : 'accessCodeNote')}</p>
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
  const list = connections.data ?? [];
  // Each product is offered only with its own ClientID on the deployment (#4111); the card draws when either is, or when the org already has a connection of either.
  const products = MISA_AMIS_PRODUCTS.filter((p) => (p === 'asp' ? status.data?.aspOffered === true : status.data?.offered === true));
  const offered = products.length > 0;
  // ASP in play (offered, or a connection of it exists): the card speaks of MISA, not of AMIS alone.
  const both = products.includes('asp') || list.some((c) => c.product === 'asp');
  const loading = status.isLoading || connections.isLoading || (canManage && entities.isLoading);
  const failure = status.error ?? connections.error ?? entities.error;
  // The connector is not offered and nothing is connected: nothing to show.
  if (!loading && !failure && !misaAmisCardShown(offered, list)) return null;
  const free = connectableEntities(entities.data ?? [], list);
  return (
    <Card role="group" aria-labelledby={headingId} className="block p-4">
      <p id={headingId} className="text-sm font-medium text-muted-foreground">
        {both ? t('titleBoth') : t('title')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{both ? t('introBoth') : t('intro')}</p>
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
                <ConnectionItem key={c.id} connection={c} entities={entities.data ?? []} canManage={canManage} pushOffered={c.product === 'asp' ? status.data?.aspPushOffered === true : status.data?.pushOffered === true} />
              ))}
            </ul>
          )}
          {canManage && offered && free.length > 0 && <ConnectForm key={`${products.join('+')}:${free.map((e) => e.id).join(',')}`} entities={free} namesEntity={(entities.data ?? []).length > 1} products={products} />}
        </>
      )}
    </Card>
  );
}
