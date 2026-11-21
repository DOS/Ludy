// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (ADR-0039 point 3, issue #2099), with the finance module and only where the deployment
// offers a bank feed: owners and admins connect a feed, map each account it lists to a bank account (112) of the books,
// remap or unmap it, and see when each was last synced. Members and viewers only read which accounts are mapped.
// Read-only throughout: a feed brings in bank lines that a person reviews as before, nothing is paid or posted here.
// The server enforces every rule; the screen offers only what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { BankFeedAccountView, LegalEntity } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, FieldError, fieldControl, focusFirstInvalid, RowsSkeleton, useFieldErrors } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { serverOrigin } from '../lib/api-base.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { accountLabel, type ChartAccount } from '../lib/accounts.ts';
import { bankAccountChoices, feedAccountRows, feedFromMin, hookAddress, latestSync, mappedOf, type FeedAccountRow } from '../lib/bank-feeds.ts';
import type { Role } from '../lib/members.ts';

const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: orpc.bankFeeds.accounts.key() });
const refreshConnections = () => queryClient.invalidateQueries({ queryKey: orpc.bankFeeds.connections.key() });

type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';
interface Connection {
  id: string;
  provider: string;
  displayName: string;
  status: ConnectionStatus;
}

// What this deployment offers to connect (`/api/config` bankFeeds): the test feed, Tingee (each business registers its own
// Tingee account, #2045), or both.
export interface FeedOffers {
  sandbox: boolean;
  tingee: boolean;
}

// Tingee: the business's own read credential. The guidance comes first because the permission groups are chosen in
// Tingee's portal, not here: only the account and transaction groups, never payouts, direct debit or refunds. The secret
// is sent once, sealed by the server, and never shown again; the field is cleared as soon as it has been sent.
function ConnectTingeeForm() {
  const t = useTranslations('bankFeeds');
  const [clientId, setClientId] = useState('');
  const [secretToken, setSecretToken] = useState('');
  const [name, setName] = useState('');
  const clientIdId = useId();
  const secretId = useId();
  const fields = useFieldErrors<'clientId' | 'secretToken'>((field) => {
    if (field === 'clientId') return clientId.trim() ? null : t('tingee.clientIdNeeded');
    return secretToken.trim() ? null : t('tingee.secretNeeded');
  });
  const connect = useMutation({
    ...orpc.bankFeeds.connectTingee.mutationOptions({
      onSuccess: async () => {
        setClientId('');
        setName('');
        fields.reset();
        await refreshConnections();
      },
      // Whatever the answer, the secret leaves the field: a refused one is typed again, never kept on screen.
      onSettled: () => setSecretToken(''),
    }),
    // The mutation holds the variables it was given: with no cache time it is dropped as soon as nothing watches it, so the secret does not linger in the client's memory.
    gcTime: 0,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['clientId', 'secretToken'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    connect.mutate({ clientId: clientId.trim(), secretToken: secretToken.trim(), ...(name.trim() ? { displayName: name.trim() } : {}) });
  };
  return (
    <form className="mt-4 space-y-3" onSubmit={submit} aria-label={t('tingee.title')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('tingee.title')}</p>
      <p className="text-xs text-subtle-foreground">{t('tingee.intro')}</p>
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t('tingee.guideTitle')}</p>
        <ol className="mt-1 list-decimal space-y-1 pl-4">
          <li>{t('tingee.guideCreate')}</li>
          <li>{t('tingee.guideGroups')}</li>
          <li>{t('tingee.guideNever')}</li>
          <li>{t('tingee.guideSecret')}</li>
        </ol>
      </div>
      <div className="space-y-2">
        <Input
          {...fieldControl(clientIdId, { error: Boolean(fields.of('clientId')) })}
          className="min-h-11"
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('tingee.clientIdLabel')}
          placeholder={t('tingee.clientIdLabel')}
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            fields.edit('clientId');
          }}
          onBlur={(e) => fields.blur('clientId', e.target.value)}
        />
        <FieldError id={clientIdId}>{fields.of('clientId')}</FieldError>
        <Input
          {...fieldControl(secretId, { error: Boolean(fields.of('secretToken')) })}
          className="min-h-11"
          type="password"
          maxLength={200}
          autoComplete="new-password"
          spellCheck={false}
          aria-label={t('tingee.secretLabel')}
          placeholder={t('tingee.secretLabel')}
          value={secretToken}
          onChange={(e) => {
            setSecretToken(e.target.value);
            fields.edit('secretToken');
          }}
          onBlur={(e) => fields.blur('secretToken', e.target.value)}
        />
        <FieldError id={secretId}>{fields.of('secretToken')}</FieldError>
        <Input className="min-h-11" maxLength={200} aria-label={t('tingee.nameLabel')} placeholder={t('tingee.nameLabel')} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button loading={connect.isPending} type="submit" variant="outline" className="min-h-11">
        {t('tingee.connect')}
      </Button>
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

function ConnectForm() {
  const t = useTranslations('bankFeeds');
  const [name, setName] = useState('');
  const nameId = useId();
  const fields = useFieldErrors<'name'>(() => (name.trim() ? null : t('nameNeeded')));
  const connect = useMutation(
    orpc.bankFeeds.connectSandbox.mutationOptions({
      onSuccess: async () => {
        setName('');
        fields.reset();
        await refreshConnections();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['name'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    connect.mutate({ displayName: name.trim() });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('connectTitle')} noValidate>
      <p className="text-xs font-medium text-muted-foreground">{t('connectTitle')}</p>
      <p className="text-xs text-subtle-foreground">{t('testNote')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          {...fieldControl(nameId, { error: Boolean(fields.of('name')) })}
          className="min-w-48 flex-1"
          maxLength={200}
          placeholder={t('namePlaceholder')}
          aria-label={t('nameLabel')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            fields.edit('name');
          }}
          onBlur={(e) => fields.blur('name', e.target.value)}
        />
        <Button loading={connect.isPending} type="submit" variant="outline" size="sm">
          {t('connect')}
        </Button>
      </div>
      <FieldError id={nameId}>{fields.of('name')}</FieldError>
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

function LastSynced({ account }: { account: BankFeedAccountView }) {
  const t = useTranslations('bankFeeds');
  const f = useFormat();
  return <>{account.lastSyncedAt ? t('syncedAt', { when: f.dateTime(account.lastSyncedAt) }) : t('neverSynced')}</>;
}

// One account the connection lists (or a mapped one it no longer lists): where its lines go, and the form to choose
// that. The legal entity is chosen only by an org with more than one, and stays with a mapping once made: another one
// takes an unmap first (the server refuses otherwise).
function AccountRow({
  connection,
  row,
  bankAccounts,
  entities,
}: {
  connection: Connection;
  row: FeedAccountRow;
  bankAccounts: readonly ChartAccount[];
  entities: readonly LegalEntity[];
}) {
  const t = useTranslations('bankFeeds');
  const f = useFormat();
  const mapped = row.mapped;
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [bankAccount, setBankAccount] = useState(mapped?.bankAccount ?? '');
  const [legalEntityId, setLegalEntityId] = useState(mapped?.legalEntityId ?? defaultEntity?.id ?? '');
  const [feedFrom, setFeedFrom] = useState(mapped?.feedFrom ?? '');
  const bankId = useId();
  const feedFromId = useId();
  const fields = useFieldErrors<'bankAccount'>(() => (bankAccount ? null : t('bankAccountNeeded')));
  const several = entities.length > 1;
  const choices = bankAccountChoices(bankAccounts, mapped?.bankAccount);
  const map = useMutation(orpc.bankFeeds.map.mutationOptions({ onSuccess: () => refreshAccounts() }));
  const unmap = useMutation(
    orpc.bankFeeds.unmap.mutationOptions({
      onSuccess: async () => {
        setBankAccount('');
        await refreshAccounts();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['bankAccount'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    map.mutate({
      connectionId: connection.id,
      externalAccountId: row.externalAccountId,
      bankAccount,
      feedFrom: feedFrom || null,
      ...(several && legalEntityId ? { legalEntityId } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  };
  const active = connection.status === 'active';
  return (
    <li className="py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2 text-foreground">
        <span className="truncate">{row.displayName}</span>
        {row.displayName !== row.externalAccountId && <span className="font-mono text-xs text-subtle-foreground">{row.externalAccountId}</span>}
      </p>
      {mapped && (
        <p className="text-xs text-subtle-foreground">
          {t('mappedTo', { account: mapped.bankAccount })} · <LastSynced account={mapped} />
          {mapped.feedFrom && ` · ${t('feedFromOn', { date: f.date(mapped.feedFrom) })}`}
        </p>
      )}
      {row.gone && (
        <p className="text-xs text-warning" role="status">
          {t('gone')}
        </p>
      )}
      {!row.gone && (
        <form className="mt-2 space-y-2" onSubmit={submit} aria-label={t('mapForm', { name: row.displayName })} noValidate>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={feedFromId} className="text-xs text-muted-foreground">
              {t('feedFromLabel')}
            </label>
            <Input id={feedFromId} type="date" min={feedFromMin(connection.provider, mapped)} className="min-h-11 w-auto" aria-describedby={`${feedFromId}-hint`} value={feedFrom} disabled={!active || mapped?.feedFromEarliest === null} onChange={(e) => setFeedFrom(e.target.value)} />
          </div>
          <p id={`${feedFromId}-hint`} className="text-xs text-subtle-foreground">
            {t('feedFromHint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <NativeSelect
              {...fieldControl(bankId, { error: Boolean(fields.of('bankAccount')) })}
              className="min-w-48 flex-1"
              aria-label={t('bankAccount')}
              value={bankAccount}
              disabled={!active}
              onChange={(e) => {
                setBankAccount(e.target.value);
                fields.edit('bankAccount');
              }}
            >
              <NativeSelectOption value="">{t('chooseBankAccount')}</NativeSelectOption>
              {choices.map((a) => (
                <NativeSelectOption key={a.code} value={a.code}>
                  {accountLabel(a)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {several && (
              <NativeSelect className="min-w-40" aria-label={t('legalEntity')} value={legalEntityId} disabled={!active || Boolean(mapped)} title={mapped ? t('entityLocked') : undefined} onChange={(e) => setLegalEntityId(e.target.value)}>
                {entities.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Button loading={map.isPending} type="submit" variant="outline" size="sm" disabled={!active || map.isPending}>
              {mapped ? t('remap') : t('map')}
            </Button>
          </div>
          <FieldError id={bankId}>{fields.of('bankAccount')}</FieldError>
          {choices.length === 0 && <p className="text-xs text-subtle-foreground">{t('noBankAccounts')}</p>}
        </form>
      )}
      {mapped && (
        <Button
          loading={unmap.isPending}
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          onClick={() => unmap.mutate({ feedAccountId: mapped.id, idempotencyKey: crypto.randomUUID() })}
          aria-label={t('unmapOf', { name: row.displayName })}
        >
          {t('unmap')}
        </Button>
      )}
      {(map.error || unmap.error) && <ErrorText>{errorMessage(map.error ?? unmap.error)}</ErrorText>}
    </li>
  );
}

// The Tingee webhook (#4204): the address to paste in the business's Tingee portal, made by the server and shown once. The key
// lives only in this component's state: it is not in a query key, a URL or storage, the mutation is dropped as soon as nothing
// watches it (gcTime 0), and hiding the address (or leaving the card) discards it. Replacing the address stops the old one at
// once, so it takes a second click. The status read never carries the key.
function HookBlock({ connection, mapped }: { connection: Connection; mapped: readonly BankFeedAccountView[] }) {
  const t = useTranslations('bankFeeds.hook');
  const f = useFormat();
  const [address, setAddress] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const status = useQuery(orpc.bankFeeds.hook.queryOptions({ input: { connectionId: connection.id } }));
  const make = useMutation({
    ...orpc.bankFeeds.hookSet.mutationOptions({
      onSuccess: async (made) => {
        setAddress(hookAddress(serverOrigin(), made.provider, made.key));
        setCopied(null);
        setConfirming(false);
        await queryClient.invalidateQueries({ queryKey: orpc.bankFeeds.hook.key() });
      },
    }),
    // The mutation holds its answer, the key included: with no cache time it is dropped as soon as nothing watches it.
    gcTime: 0,
  });
  const copy = async () => {
    if (address === null) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };
  const run = () => {
    setAddress(null);
    make.mutate({ connectionId: connection.id });
  };
  const hook = status.data;
  const lastPull = latestSync(mapped);
  return (
    <section className="mt-3 space-y-2 rounded-md border p-3" aria-label={t('title')}>
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>
      <p className="text-xs text-subtle-foreground">{t('intro')}</p>
      {status.error && <ErrorText>{errorMessage(status.error)}</ErrorText>}
      {hook && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {hook.exists ? (
            <>
              {hook.createdAt && <li>{t('createdAt', { when: f.dateTime(hook.createdAt) })}</li>}
              {hook.rotatedAt && <li>{t('rotatedAt', { when: f.dateTime(hook.rotatedAt) })}</li>}
              <li>{hook.lastSeenAt ? t('lastSeen', { when: f.dateTime(hook.lastSeenAt) }) : t('noNotice')}</li>
              <li>{t('rejected', { count: String(hook.rejectedCount) })}</li>
            </>
          ) : (
            <li>{t('none')}</li>
          )}
          <li>{lastPull ? t('lastPull', { when: f.dateTime(lastPull) }) : t('noPull')}</li>
        </ul>
      )}
      {hook?.stopped && (
        <p className="text-xs text-warning" role="alert">
          {t('stopped')}
        </p>
      )}
      {address !== null && (
        <div className="space-y-2 rounded-md bg-muted p-2">
          <p className="text-xs text-foreground">{t('shownOnce')}</p>
          <Input className="min-h-11 font-mono text-xs" readOnly aria-label={t('addressLabel')} value={address} onFocus={(e) => e.currentTarget.select()} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy()}>
              {t('copy')}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setAddress(null)}>
              {t('close')}
            </Button>
          </div>
          {copied && (
            <p className="text-xs text-subtle-foreground" role="status">
              {copied === 'yes' ? t('copied') : t('copyFailed')}
            </p>
          )}
        </div>
      )}
      {confirming ? (
        <div className="space-y-2">
          <p className="text-xs text-warning" role="alert">
            {t('warnRotate')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button loading={make.isPending} type="button" variant="outline" className="min-h-11" onClick={run}>
              {t('confirmRotate')}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        hook && (
          <Button loading={make.isPending} type="button" variant="outline" className="min-h-11" onClick={() => (hook.exists ? setConfirming(true) : run())}>
            {hook.exists ? t('rotate') : t('create')}
          </Button>
        )
      )}
      {make.error && <ErrorText>{errorMessage(make.error)}</ErrorText>}
    </section>
  );
}

function ConnectionItem({
  connection,
  mapped,
  bankAccounts,
  entities,
}: {
  connection: Connection;
  mapped: readonly BankFeedAccountView[];
  bankAccounts: readonly ChartAccount[];
  entities: readonly LegalEntity[];
}) {
  const t = useTranslations('bankFeeds');
  // The accounts the worker listed: none right after connecting, until the first sync, so ask again while it is empty.
  const listed = useQuery({
    ...orpc.bankFeeds.listed.queryOptions({ input: { connectionId: connection.id } }),
    // Every 5 seconds for two minutes: a listing that stays empty is the provider's answer, not a sync still to come.
    refetchInterval: (query) => (connection.status === 'active' && query.state.data?.length === 0 && query.state.dataUpdateCount + query.state.errorUpdateCount < 24 ? 5000 : false),
  });
  const rows = feedAccountRows(listed.data ?? null, mapped);
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">{connection.displayName}</span>
        <Badge variant={connection.status === 'active' ? 'brand' : 'secondary'}>{t(`status.${connection.status}`)}</Badge>
      </div>
      {connection.status === 'expired' && (
        <p className="mt-1 text-xs text-warning" role="status">
          {t('expiredHint')}
        </p>
      )}
      {connection.status === 'error' && (
        <p className="mt-1 text-xs text-warning" role="status">
          {t('errorHint')}
        </p>
      )}
      {connection.provider === 'bank_tingee' && connection.status === 'active' && <HookBlock connection={connection} mapped={mapped} />}
      {listed.error && <ErrorText>{errorMessage(listed.error)}</ErrorText>}
      {listed.isLoading ? (
        <RowsSkeleton />
      ) : rows.length === 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xs text-subtle-foreground">{t('waiting')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void listed.refetch()}>
            {t('refresh')}
          </Button>
        </div>
      ) : (
        <ul className="mt-1 divide-y">
          {rows.map((row) => (
            // Keyed by the mapping too, so the form starts from a mapping made or removed since.
            <AccountRow key={`${row.externalAccountId}:${row.mapped?.id ?? ''}:${row.mapped?.bankAccount ?? ''}:${row.mapped?.feedFrom ?? ''}`} connection={connection} row={row} bankAccounts={bankAccounts} entities={entities} />
          ))}
        </ul>
      )}
    </li>
  );
}

// What a member or viewer sees: which accounts bring in transactions, and when each was last synced.
function ReadOnlyList({ accounts }: { accounts: readonly BankFeedAccountView[] }) {
  const t = useTranslations('bankFeeds');
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('readOnlyIntro')}</p>
      <ul className="mt-3 divide-y">
        {accounts.map((a) => (
          <li key={a.id} className="py-2 text-sm">
            <p className="text-foreground">
              {a.connectionName}
            </p>
            <p className="text-xs text-subtle-foreground">
              {t('mappedTo', { account: a.bankAccount })} · <LastSynced account={a} />
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The caller draws it only when the deployment offers a bank feed (lib/bank-feeds.ts bankFeedOffered).
export function BankFeedsCard({ role, offers = { sandbox: true, tingee: false } }: { role: Role; offers?: FeedOffers }) {
  const t = useTranslations('bankFeeds');
  const canManage = role === 'owner' || role === 'admin';
  // A mapped account is pulled by the worker a moment after it is mapped, so ask again for two minutes while one has not
  // been synced yet; later changes show on the next visit or when the window is focused again.
  const accounts = useQuery({
    ...orpc.bankFeeds.accounts.queryOptions(),
    refetchInterval: (query) => (query.state.data?.some((a) => a.lastSyncedAt === null && a.connectionStatus === 'active') && query.state.dataUpdateCount + query.state.errorUpdateCount < 24
        ? 5000
        : false),
  });
  const connections = useQuery({ ...orpc.bankFeeds.connections.queryOptions(), enabled: canManage });
  const chart = useQuery({ ...orpc.accounts.list.queryOptions(), enabled: canManage });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  if (!canManage) {
    // Nothing to change and nothing mapped: nothing to show. A read that failed is not "nothing mapped": say so.
    if (accounts.data) return accounts.data.length > 0 ? <ReadOnlyList accounts={accounts.data} /> : null;
    return accounts.error ? (
      <Card className="block p-4" aria-label={t('title')}>
        <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      </Card>
    ) : null;
  }
  // The rows start their forms from the chart and the entities, so wait for both.
  const loading = connections.isLoading || accounts.isLoading || chart.isLoading || entities.isLoading;
  const failure = connections.error ?? accounts.error ?? chart.error ?? entities.error;
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
          {(connections.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('noConnections')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(connections.data ?? []).map((c) => (
                <ConnectionItem key={c.id} connection={c} mapped={mappedOf(accounts.data ?? [], c.id)} bankAccounts={chart.data ?? []} entities={entities.data ?? []} />
              ))}
            </ul>
          )}
        </>
      )}
      {/* It needs only the connect call, so it stays when a read above failed. */}
      {!loading && offers.tingee && <ConnectTingeeForm />}
      {!loading && offers.sandbox && <ConnectForm />}
    </Card>
  );
}
