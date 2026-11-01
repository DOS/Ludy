// SPDX-License-Identifier: AGPL-3.0-only
// The Ads screen (ADR-0040, issue #2217, plan docs/plan/ads.md sections 2, 3, 6 and 7.3), a group of the Social app on the
// rail, with the ads module. It reads what the org's ad platforms report: per ad account the spend, impressions, clicks and
// results of each day, by month and by campaign, and the cost per result worked out from the action the owner chose to
// count as a result. Read only: nothing here creates, edits or pauses a campaign, and no figure is converted from the
// account's own currency. Owners and admins connect (the offline sandbox platform, and Meta through its sign-in dialog,
// #2218) and set an account up; owners,
// admins and members ask for a refresh; every role reads. Next to the books, where finance runs, the platform's monthly
// spend sits beside the ledger's advertising expense (components/ads-books-strip.tsx). The server and the row policies
// decide each rule; the screen only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { ADS_SANDBOX_CURRENCIES, type AdAccountView, type AdsSummary, type LegalEntity } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AdsBooksStrip } from '../components/ads-books-strip.tsx';
import { AdsWriteCard } from '../components/ads-write.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, Field, focusFirstInvalid, PageHeader, TableSkeleton, useFieldErrors } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  ADS_RANGES,
  DEFAULT_ADS_RANGE,
  FIRST_SYNC_POLL_LIMIT,
  FIRST_SYNC_POLL_MS,
  REFRESH_POLL_MS,
  REFRESH_WATCH_MS,
  adOAuthProviders,
  adProviderName,
  adsRange,
  awaitsFirstSync,
  configureChanges,
  expenseCodeProblem,
  hasFigures,
  isAdOAuthProvider,
  isCalmRefusal,
  isNamedResultKind,
  isSandboxProvider,
  keyFor,
  recentlyRan,
  resultKindChoices,
  syncHeld,
  todayIn,
  type AdsRangeKind,
  type AdsSearch,
  type KeyHolder,
} from '../lib/ads.ts';
import { getConfig } from '../lib/auth.ts';
import { rememberOAuthAttempt } from '../lib/oauth.ts';
import { monthLabel } from '../lib/period-lock.ts';
import { toast } from '../lib/toast.ts';

type SandboxCurrency = (typeof ADS_SANDBOX_CURRENCIES)[number];

// The id of the result kind select, so the prompt in the totals can send the focus to it.
const RESULT_KIND_FIELD = 'ads-result-kind';

const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: orpc.ads.accounts.key() });
const refreshFigures = () =>
  Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ads.summary.key() }), queryClient.invalidateQueries({ queryKey: orpc.ads.syncRuns.key() })]);

// The name of a result kind: our own words for the kinds the sandbox offers, the platform's key for any other.
function useKindName(): (kind: string) => string {
  const t = useTranslations('ads');
  return (kind) => (isNamedResultKind(kind) ? t(`resultKinds.${kind}`) : kind);
}

const H2 = 'text-base font-semibold text-foreground';

// ---------------------------------------------------------------------------------------------------------------------
// Connecting a test ad account

// Owners and admins only; the caller draws it where the deployment offers the sandbox ad platform (/api/config ads).
export function ConnectSandboxForm({ entities, onConnected, onCancel }: { entities: readonly LegalEntity[]; onConnected: (adAccountId: string) => void; onCancel?: () => void }) {
  const t = useTranslations('ads');
  const common = useTranslations('common');
  const headingId = useId();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<SandboxCurrency>('VND');
  const [entityId, setEntityId] = useState('');
  const fields = useFieldErrors<'name'>(() => (name.trim() ? null : t('nameNeeded')));
  const attempt = useRef<KeyHolder | null>(null);
  const several = entities.length > 1;
  const chosenEntity = entityId || (entities.find((e) => e.isDefault) ?? entities[0])?.id || '';
  const connect = useMutation(
    orpc.ads.connectSandbox.mutationOptions({
      onSuccess: async (done) => {
        attempt.current = null;
        setName('');
        fields.reset();
        await refreshAccounts();
        toast(t('connectedToast'));
        onConnected(done.adAccountId);
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['name'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    const input = { displayName: name.trim(), currency, ...(several && chosenEntity ? { legalEntityId: chosenEntity } : {}) };
    // A retry of the same form after a lost answer is the same request; a changed form is another.
    attempt.current = keyFor(attempt.current, JSON.stringify(input));
    connect.mutate({ ...input, idempotencyKey: attempt.current.key });
  };
  return (
    <form className="space-y-3" onSubmit={submit} aria-labelledby={headingId} noValidate>
      <h2 id={headingId} className={H2}>
        {t('connectTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('testNote')}</p>
      <div className="flex flex-wrap items-start gap-3">
        <Field label={t('connectName')} error={fields.of('name')} className="min-w-56 flex-1">
          {(control) => (
            <Input
              {...control}
              maxLength={200}
              placeholder={t('connectNamePlaceholder')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                fields.edit('name');
              }}
              onBlur={(e) => fields.blur('name', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('connectCurrency')} className="w-52">
          {(control) => (
            <NativeSelect {...control} className="w-full" value={currency} onChange={(e) => setCurrency(e.target.value as SandboxCurrency)}>
              {ADS_SANDBOX_CURRENCIES.map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {t(`currencies.${c}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        {several && (
          <Field label={t('connectEntity')} className="w-52">
            {(control) => (
              <NativeSelect {...control} className="w-full" value={chosenEntity} onChange={(e) => setEntityId(e.target.value)}>
                {entities.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button loading={connect.isPending} type="submit" size="lg">
          {t('connect')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={connect.isPending}>
            {common('cancel')}
          </Button>
        )}
      </div>
      {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
    </form>
  );
}

// Connecting a Meta ad account (#2218): Meta's own sign-in dialog runs in this tab and comes back to the callback screen,
// which finishes the attempt for the org it was started in. Owners and admins only; the caller draws it where the
// deployment has its Meta ads app (`meta_ads` among /api/config's channels.oauth). It says in plain words what Ludy asks
// Meta for: only to read reports. `another` is the short form for an org that already has an ad account.
export function ConnectMeta({ slug, another = false, reconnect = false }: { slug: string; another?: boolean; reconnect?: boolean }) {
  const t = useTranslations('ads');
  const headingId = useId();
  const start = useMutation({
    mutationFn: () => client.channels.oauthStart({ provider: 'meta_ads' }),
    onSuccess: (attempt) => {
      rememberOAuthAttempt(attempt.state, slug);
      window.location.assign(attempt.authorizeUrl);
    },
  });
  return (
    <div className="space-y-3" role="group" aria-labelledby={another ? undefined : headingId}>
      {!another && (
        <h2 id={headingId} className={H2}>
          {t('connectMeta.title')}
        </h2>
      )}
      <p className="text-sm text-muted-foreground">{t('connectMeta.note')}</p>
      <p className="text-xs text-subtle-foreground">{t('connectMeta.expiry')}</p>
      <div>
        <Button loading={start.isPending} type="button" variant={another ? 'outline' : 'default'} size="lg" onClick={() => start.mutate()}>
          {reconnect ? t('connectMeta.reconnect') : another ? t('connectMeta.another') : t('connectMeta.action')}
        </Button>
      </div>
      {start.error && <ErrorText>{errorMessage(start.error)}</ErrorText>}
    </div>
  );
}

// No ad account yet: what Ads shows, and, for owners and admins, how to connect one: a test account where the sandbox
// platform is on, a Meta ad account where the deployment has its Meta ads app (`meta` names the org the dialog is started
// for). Members and viewers read the explanation only; with no ad platform on the deployment, everyone is told so.
export function AdsEmpty({
  canManage,
  sandbox,
  meta,
  entities,
  onConnected,
}: {
  canManage: boolean;
  sandbox: boolean;
  meta?: { slug: string } | undefined;
  entities: readonly LegalEntity[];
  onConnected: (adAccountId: string) => void;
}) {
  const t = useTranslations('ads');
  return (
    <div className="space-y-6">
      <Empty title={t('emptyTitle')} hint={t('emptyHint')} />
      {!sandbox && !meta ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('noPlatform')}
        </p>
      ) : canManage ? (
        <div className="space-y-4">
          {meta && (
            <Card className="block p-4">
              <ConnectMeta slug={meta.slug} />
            </Card>
          )}
          {sandbox && (
            <Card className="block p-4">
              <ConnectSandboxForm entities={entities} onConnected={onConnected} />
            </Card>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('emptyMembers')}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The account: its header, how its last update went, and a way to ask for another

// How the last update of the account went: when the figures run to, what failed and why in plain words, and when the next
// try is. Everything comes from the account's own row; the history of runs is below. An account whose connection is not
// active (expired, disconnected, in trouble) claims nothing live: its figures are "stored", it will not retry, and a
// line says why and who can fix it. A disconnect the owner chose is said quietly; the other two are a warning.
function SyncStatus({ account }: { account: AdAccountView }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const active = account.connectionStatus === 'active';
  return (
    <div className="mt-3 space-y-1 text-sm">
      {account.syncedThrough && <p className="text-muted-foreground">{active ? t('syncedThrough', { day: f.date(account.syncedThrough) }) : t('storedThrough', { day: f.date(account.syncedThrough) })}</p>}
      {account.lastRunAt && <p className="text-xs text-subtle-foreground">{t('lastRun', { when: f.dateTime(account.lastRunAt) })}</p>}
      {account.extraScopes.length > 0 && (
        // The token can do more than read reports (the app was shared with another use that the person granted): say what.
        <p className="text-warning" role="status">
          {t('extraScopes', { list: account.extraScopes.join(', ') })}
        </p>
      )}
      {account.connectionStatus !== 'active' && (
        <p className={account.connectionStatus === 'revoked' ? 'text-muted-foreground' : 'text-warning'} role="status">
          {account.pausedReason && account.pausedReason !== 'disconnected' && account.pausedSince ? t(`paused.${account.pausedReason}`, { since: f.date(account.pausedSince) }) : t(`connectionHint.${account.connectionStatus}`)}
        </p>
      )}
      {active && account.lastErrorKind && (
        <div role="status" className="space-y-1">
          <p className="text-warning">{t(`errors.${account.lastErrorKind}`)}</p>
          {account.currency !== null && <p className="text-xs text-subtle-foreground">{t('errors.keptFigures')}</p>}
        </div>
      )}
      {active && account.nextRunAt && <p className="text-xs text-subtle-foreground">{t('nextRun', { when: f.dateTime(account.nextRunAt) })}</p>}
    </div>
  );
}

// The time now, read again when `until` (a time in ms, 0 for none) has passed, so what depends on a hold ending changes
// by itself.
function useNowUntil(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const wait = until - Date.now();
    if (wait <= 0) return undefined;
    // A timer holds at most about 24 days; a hold is minutes.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 100, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [until]);
  return now;
}

export function AccountHeader({ account, canRefresh, onRequested }: { account: AdAccountView; canRefresh: boolean; onRequested: () => void }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const headingId = useId();
  const holdId = useId();
  const refresh = useMutation(
    orpc.ads.requestSync.mutationOptions({
      onSuccess: async () => {
        toast(t('refreshToast'));
        onRequested();
        await refreshAccounts();
      },
    }),
  );
  // Asking twice within a minute, or while the platform holds the account back, is not a fault: the server says so, and
  // the screen says it calmly.
  const calm = isCalmRefusal(refresh.error);
  const active = account.connectionStatus === 'active';
  // While the platform holds the account back (a rate limit, until its next try) the server refuses a refresh, so the
  // button waits with it and the time is shown beside it.
  const now = useNowUntil(account.nextRunAt === null ? 0 : Date.parse(account.nextRunAt));
  const held = active && syncHeld(account, now);
  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold break-words text-foreground">
            {account.name}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
            {isSandboxProvider(account.provider) && <Badge variant="outline">{t('sandboxBadge')}</Badge>}
            {isAdOAuthProvider(account.provider) && <Badge variant="outline">{adProviderName(account.provider)}</Badge>}
            {account.connectionStatus !== 'active' && (
              // A disconnect the owner chose is a quiet state; an expired connection or one in trouble is a warning.
              <Badge variant={account.connectionStatus === 'revoked' ? 'secondary' : 'warning'}>{t(`connection.${account.connectionStatus}`)}</Badge>
            )}
            {account.currency !== null && account.timeZone !== null && <span>{t('currencyAndZone', { currency: account.currency, zone: account.timeZone })}</span>}
          </p>
        </div>
        {canRefresh && (
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button
              loading={refresh.isPending}
              variant="outline"
              size="lg"
              disabled={!active || held}
              aria-describedby={held ? holdId : undefined}
              onClick={() => refresh.mutate({ adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}
            >
              {t('refresh')}
            </Button>
            {held && account.nextRunAt && (
              <p id={holdId} className="text-xs text-subtle-foreground">
                {t('refreshHold', { when: f.dateTime(account.nextRunAt) })}
              </p>
            )}
          </div>
        )}
      </div>
      <SyncStatus account={account} />
      {refresh.error &&
        (calm ? (
          <p className="mt-2 text-sm text-muted-foreground" role="status">
            {errorMessage(refresh.error)}
          </p>
        ) : (
          <ErrorText>{errorMessage(refresh.error)}</ErrorText>
        ))}
    </section>
  );
}

// The account's last updates (ads.syncRuns), read only when the list is opened.
function SyncRuns({ account }: { account: AdAccountView }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const runs = useQuery({ ...orpc.ads.syncRuns.queryOptions({ input: { adAccountId: account.id } }), enabled: open });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)} className="text-sm">
      <summary className="flex min-h-11 cursor-pointer items-center text-link md:min-h-8">{t('runs.title')}</summary>
      {open &&
        (runs.error ? (
          <ErrorText>{errorMessage(runs.error)}</ErrorText>
        ) : !runs.data ? (
          <TableSkeleton columns={3} rows={3} />
        ) : runs.data.length === 0 ? (
          <p className="text-muted-foreground">{t('runs.empty')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {runs.data.slice(0, 10).map((run) => (
              <li key={run.id} className="space-y-1 px-3 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground">{f.dateTime(run.startedAt)}</span>
                  <Badge variant={run.status === 'ok' ? 'success' : 'warning'}>{t(`runs.${run.status}`)}</Badge>
                  {run.windowFrom && run.windowTo && <span className="text-xs text-subtle-foreground">{t('runs.window', { from: f.date(run.windowFrom), to: f.date(run.windowTo) })}</span>}
                  <span className="text-xs text-subtle-foreground">{t('runs.rows', { count: run.rowsWritten })}</span>
                </p>
                {run.errorKind && <p className="text-xs text-muted-foreground">{t(`errors.${run.errorKind}`)}</p>}
              </li>
            ))}
          </ul>
        ))}
    </details>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The figures

function RangeControl({ value, range, onChange }: { value: AdsRangeKind; range: { from: string; to: string }; onChange: (kind: AdsRangeKind) => void }) {
  const t = useTranslations('ads');
  const f = useFormat();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('periodLabel')} className="w-56">
        {(control) => (
          <NativeSelect {...control} className="w-full" value={value} onChange={(e) => onChange(e.target.value as AdsRangeKind)}>
            {ADS_RANGES.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {t(`ranges.${kind}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </Field>
      <p className="pb-1.5 text-xs text-subtle-foreground">{t('rangeDays', { from: f.date(range.from), to: f.date(range.to) })}</p>
    </div>
  );
}

function Stat({ label, note, children }: { label: string; note?: string | undefined; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]">{children}</dd>
      {note && <dd className="mt-0.5 text-xs text-subtle-foreground">{note}</dd>}
    </div>
  );
}

// The period's totals. With no result kind chosen there is nothing to call a result, so the two figures that depend on it
// give way to a prompt: owners and admins are taken to the setting, the others are told who chooses.
export function Totals({ summary, currency, canManage }: { summary: AdsSummary; currency: string; canManage: boolean }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const kindName = useKindName();
  const headingId = useId();
  const { total } = summary;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className={H2}>
        {t('totalsTitle')}
      </h2>
      <Card className="block p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={t('totals.spend')}>{f.money(total.spend, currency)}</Stat>
          <Stat label={t('totals.impressions')}>{f.number(total.impressions)}</Stat>
          <Stat label={t('totals.clicks')}>{f.number(total.clicks)}</Stat>
          {summary.resultKind === null ? (
            <div className="col-span-2 min-w-0 space-y-2 sm:col-span-3 lg:col-span-2">
              <dt className="text-xs text-subtle-foreground">{t('totals.results')}</dt>
              <dd className="space-y-2 text-sm text-muted-foreground">
                <span className="block">{canManage ? t('chooseResultKind') : t('chooseResultKindOther')}</span>
                {canManage && (
                  <Button type="button" variant="outline" size="lg" onClick={() => document.getElementById(RESULT_KIND_FIELD)?.focus()}>
                    {t('chooseResultKindAction')}
                  </Button>
                )}
              </dd>
            </div>
          ) : (
            <>
              <Stat label={t('totals.results')} note={kindName(summary.resultKind)}>
                {total.results === null ? '-' : f.number(total.results)}
              </Stat>
              <Stat label={t('totals.costPerResult')} note={total.costPerResult === null ? t('noResultsYet') : undefined}>
                {total.costPerResult === null ? '-' : f.money(total.costPerResult, currency)}
              </Stat>
            </>
          )}
        </dl>
      </Card>
      <p className="text-xs text-subtle-foreground">{t('howToRead')}</p>
    </section>
  );
}

// The cells of one row of a table of metrics: its first column, then spend, impressions and clicks, and results with
// their cost where a result kind is chosen.
function MetricRow({ cells, metric, currency, withResults }: { cells: ReactNode; metric: AdsSummary['total']; currency: string; withResults: boolean }) {
  const f = useFormat();
  return (
    <>
      <TableCell className="px-4 py-3 text-foreground">{cells}</TableCell>
      <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(metric.spend, currency)}</TableCell>
      <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.number(metric.impressions)}</TableCell>
      <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.number(metric.clicks)}</TableCell>
      {withResults && <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{metric.results === null ? '-' : f.number(metric.results)}</TableCell>}
      {withResults && <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{metric.costPerResult === null ? '-' : f.money(metric.costPerResult, currency)}</TableCell>}
    </>
  );
}

export function Breakdowns({ summary, currency }: { summary: AdsSummary; currency: string }) {
  const t = useTranslations('ads');
  const f = useFormat();
  const monthsId = useId();
  const campaignsId = useId();
  const daysId = useId();
  const withResults = summary.resultKind !== null;
  const results = withResults ? [t('columns.results'), t('columns.costPerResult')] : [];
  // After the name, spend, impressions and clicks are right-aligned numbers, and so are the results columns where there are any.
  const numeric = withResults ? [1, 2, 3, 4, 5] : [1, 2, 3];
  return (
    <>
      <section aria-labelledby={monthsId} className="space-y-3">
        <h2 id={monthsId} className={H2}>
          {t('monthsTitle')}
        </h2>
        <DataTable head={[t('columns.month'), t('columns.spend'), t('columns.impressions'), t('columns.clicks'), ...results]} numeric={numeric}>
          {[...summary.months].reverse().map((m) => (
            <TableRow key={m.month}>
              <MetricRow cells={monthLabel(m.month)} metric={m} currency={currency} withResults={withResults} />
            </TableRow>
          ))}
        </DataTable>
      </section>
      <section aria-labelledby={campaignsId} className="space-y-3">
        <h2 id={campaignsId} className={H2}>
          {t('campaignsTitle')}
        </h2>
        {summary.campaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('campaignsEmpty')}</p>
        ) : (
          <DataTable head={[t('columns.campaign'), t('columns.spend'), t('columns.impressions'), t('columns.clicks'), ...results]} numeric={numeric}>
            {summary.campaigns.map((c) => (
              <TableRow key={c.externalObjectId}>
                <MetricRow cells={c.name || c.externalObjectId} metric={c} currency={currency} withResults={withResults} />
              </TableRow>
            ))}
          </DataTable>
        )}
      </section>
      <section aria-labelledby={daysId} className="space-y-3">
        <h2 id={daysId} className={H2}>
          {t('daysTitle')}
        </h2>
        <DataTable
          head={[t('columns.day'), t('columns.spend'), t('columns.impressions'), t('columns.clicks'), t('columns.reach'), ...results]}
          numeric={[1, 2, 3, 4, ...(withResults ? [5, 6] : [])]}
        >
          {[...summary.days].reverse().map((d) => (
            <TableRow key={d.day}>
              <TableCell className="px-4 py-3 text-foreground">
                {f.date(d.day)}
                {!d.settled && <span className="ml-2 text-xs text-subtle-foreground">{t('notFinal')}</span>}
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(d.spend, currency)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.number(d.impressions)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.number(d.clicks)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{d.reach === null ? '-' : f.number(d.reach)}</TableCell>
              {withResults && <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{d.results === null ? '-' : f.number(d.results)}</TableCell>}
              {withResults && <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{d.costPerResult === null ? '-' : f.money(d.costPerResult, currency)}</TableCell>}
            </TableRow>
          ))}
        </DataTable>
        <p className="text-xs text-subtle-foreground">{t('notFinalHint')}</p>
        <p className="text-xs text-subtle-foreground">{t('reachHint')}</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings (owners and admins)

// Disconnecting the account's connection (kernel.channel.disconnect, owners and admins), asked first in a dialog: Ads is the
// only place to do it, since the channels screen does not list ad accounts. The stored figures stay and the account stays
// in the picker as "disconnected", read only; nothing is shown for one that already is.
function DisconnectAction({ account }: { account: AdAccountView }) {
  const t = useTranslations('ads');
  const attempt = useRef<KeyHolder | null>(null);
  const disconnect = useMutation(
    orpc.channels.disconnect.mutationOptions({
      onSuccess: async () => {
        attempt.current = null;
        toast(t('settings.disconnected'));
        await Promise.all([refreshAccounts(), refreshFigures()]);
      },
    }),
  );
  if (account.connectionStatus === 'revoked') return null;
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm text-muted-foreground">{t('settings.disconnectHint')}</p>
      <ConfirmDialog
        render={<Button loading={disconnect.isPending} variant="outline" size="lg" />}
        destructive
        title={t('settings.disconnectTitle')}
        description={t('settings.disconnectBody', { name: account.name })}
        confirm={t('settings.disconnect')}
        onConfirm={() => {
          // A retry after a lost answer is the same request.
          attempt.current = keyFor(attempt.current, account.connectionId);
          disconnect.mutate({ connectionId: account.connectionId, idempotencyKey: attempt.current.key });
        }}
      >
        {t('settings.disconnect')}
      </ConfirmDialog>
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
    </div>
  );
}

// Deleting what Ads stored for the account (ads.deleteHistory, owners and admins; owner answer Q4 of #2214: the figures stay
// after a disconnect, with this explicit action to delete them), asked first in a dialog. A connected account reads its 13
// months again at the next update; one whose connection is closed also loses its row, so nothing of it is left.
function DeleteHistoryAction({ account }: { account: AdAccountView }) {
  const t = useTranslations('ads');
  const attempt = useRef<KeyHolder | null>(null);
  const closed = account.connectionStatus === 'revoked';
  const remove = useMutation(
    orpc.ads.deleteHistory.mutationOptions({
      onSuccess: async (done) => {
        attempt.current = null;
        toast(done.removed ? t('settings.accountDeleted') : t('settings.historyDeleted', { days: String(done.days) }));
        await Promise.all([refreshAccounts(), refreshFigures()]);
      },
    }),
  );
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm text-muted-foreground">{t('settings.deleteHistoryHint')}</p>
      <ConfirmDialog
        render={<Button loading={remove.isPending} variant="outline" size="lg" />}
        destructive
        title={t('settings.deleteHistoryTitle')}
        description={t(closed ? 'settings.deleteHistoryBodyClosed' : 'settings.deleteHistoryBody', { name: account.name })}
        confirm={t('settings.deleteHistory')}
        onConfirm={() => {
          // A retry after a lost answer is the same request.
          attempt.current = keyFor(attempt.current, account.id);
          remove.mutate({ adAccountId: account.id, idempotencyKey: attempt.current.key });
        }}
      >
        {t('settings.deleteHistory')}
      </ConfirmDialog>
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </div>
  );
}

// The action that counts as a result, the expense account of the books to compare with, and the legal entity whose books
// those are. Only what changed is sent. The card starts from the account as the server has it: the caller keys it by the
// account's settings, so a change made elsewhere shows here.
export function AdsSettingsCard({ account, entities }: { account: AdAccountView; entities: readonly LegalEntity[] }) {
  const t = useTranslations('ads');
  const kindName = useKindName();
  const headingId = useId();
  const several = entities.length > 1;
  const [form, setForm] = useState({
    resultKind: account.resultKind ?? '',
    expenseAccountCode: account.expenseAccountCode ?? '',
    legalEntityId: account.legalEntityId,
  });
  const fields = useFieldErrors<'expenseAccountCode'>(() => (expenseCodeProblem(form.expenseAccountCode) ? t('settings.expenseCodeFormat') : null));
  const attempt = useRef<KeyHolder | null>(null);
  const changes = configureChanges(account, form, several);
  const kinds = resultKindChoices(account.resultKinds, account.resultKind);
  const save = useMutation(
    orpc.ads.configure.mutationOptions({
      onSuccess: async () => {
        attempt.current = null;
        toast(t('settings.saved'));
        await Promise.all([refreshAccounts(), refreshFigures()]);
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['expenseAccountCode'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    const next = configureChanges(account, form, several);
    if (!next) return;
    attempt.current = keyFor(attempt.current, JSON.stringify(next));
    save.mutate({ adAccountId: account.id, ...next, idempotencyKey: attempt.current.key });
  };
  return (
    <Card className="block space-y-4 p-4">
      <form className="space-y-4" onSubmit={submit} aria-labelledby={headingId} noValidate>
        <h2 id={headingId} className={H2}>
          {t('settings.title')}
        </h2>
        <Field id={RESULT_KIND_FIELD} label={t('settings.resultKind')} hint={kinds.length === 0 ? t('settings.noResultKinds') : t('settings.resultKindHint')}>
          {(control) => (
            <NativeSelect {...control} className="w-full max-w-sm" value={form.resultKind} disabled={kinds.length === 0} onChange={(e) => setForm({ ...form, resultKind: e.target.value })}>
              <NativeSelectOption value="">{t('settings.noResultKind')}</NativeSelectOption>
              {kinds.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {kindName(kind)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('settings.expenseCode')} hint={t('settings.expenseCodeHint')} error={fields.of('expenseAccountCode')}>
          {(control) => (
            <Input
              {...control}
              className="max-w-sm font-mono"
              maxLength={32}
              autoComplete="off"
              placeholder="6421"
              value={form.expenseAccountCode}
              onChange={(e) => {
                setForm({ ...form, expenseAccountCode: e.target.value });
                fields.edit('expenseAccountCode');
              }}
              onBlur={(e) => fields.blur('expenseAccountCode', e.target.value)}
            />
          )}
        </Field>
        {several && (
          <Field label={t('settings.legalEntity')} hint={t('settings.legalEntityHint')}>
            {(control) => (
              <NativeSelect {...control} className="w-full max-w-sm" value={form.legalEntityId} onChange={(e) => setForm({ ...form, legalEntityId: e.target.value })}>
                {entities.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Button loading={save.isPending} type="submit" size="lg" disabled={!changes}>
          {t('settings.save')}
        </Button>
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </form>
      {/* Outside the form: opening the dialog is not part of saving the settings. */}
      <DisconnectAction account={account} />
      <DeleteHistoryAction account={account} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The page

// Reads the account's figures again when a run finishes (its row says so), so a refresh shows without a reload.
function useRefetchOnRun(account: AdAccountView) {
  const stamp = `${account.lastRunAt ?? ''}|${account.syncedThrough ?? ''}|${account.settledThrough ?? ''}`;
  const seen = useRef(stamp);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    void refreshFigures();
  }, [stamp]);
}

function AccountPanel({
  account,
  range,
  onRange,
  role,
  entities,
  financeOn,
  reconnect,
  onRequested,
}: {
  account: AdAccountView;
  range: AdsRangeKind;
  onRange: (kind: AdsRangeKind) => void;
  role: string | undefined;
  entities: readonly LegalEntity[];
  financeOn: boolean;
  // Where a paused Meta account is connected again: the org's address, when the deployment has its Meta ads app (#2219).
  reconnect: { slug: string } | undefined;
  onRequested: () => void;
}) {
  const t = useTranslations('ads');
  const canManage = role === 'owner' || role === 'admin';
  const canRefresh = canManage || role === 'member';
  useRefetchOnRun(account);
  const ready = hasFigures(account);
  // The window moves on with the clock, an hour at a time, so a tab left open does not read yesterday's month.
  const hour = Math.floor(Date.now() / 3_600_000);
  const now = new Date(hour * 3_600_000);
  const days = adsRange(range, account.timeZone, now);
  const summary = useQuery({ ...orpc.ads.summary.queryOptions({ input: { adAccountId: account.id, from: days.from, to: days.to } }), enabled: ready });
  const currency = account.currency ?? '';
  return (
    <div className="space-y-8">
      <AccountHeader account={account} canRefresh={canRefresh} onRequested={onRequested} />
      {reconnect && canManage && account.provider === 'meta_ads' && account.connectionStatus !== 'active' && account.pausedReason !== 'platform_deletion' && (
        <Card className="block p-4">
          <ConnectMeta slug={reconnect.slug} another reconnect />
        </Card>
      )}
      {account.connectionStatus !== 'active' && !canManage && account.pausedReason !== 'platform_deletion' && (
        <p className="text-sm text-muted-foreground" role="status">
          {t('paused.noReconnect')}
        </p>
      )}
      {!ready ? (
        account.lastErrorKind === null && (
          <p className="text-sm text-muted-foreground" role="status">
            {awaitsFirstSync(account) ? t('firstSync') : t('noFiguresYet')}
          </p>
        )
      ) : (
        <>
          <RangeControl value={range} range={days} onChange={onRange} />
          {summary.error ? (
            <ErrorText>{errorMessage(summary.error)}</ErrorText>
          ) : !summary.data ? (
            <div className="space-y-4">
              <CardSkeleton />
              <TableSkeleton columns={4} />
            </div>
          ) : (
            <>
              <Totals summary={summary.data} currency={currency} canManage={canManage} />
              {summary.data.days.length === 0 ? (
                <Empty title={t('noSpend')} hint={t('noSpendHint')} />
              ) : (
                <>
                  <Breakdowns summary={summary.data} currency={currency} />
                  <AdsBooksStrip account={account} months={summary.data.months} todayMonth={todayIn(account.timeZone, now).slice(0, 7)} financeOn={financeOn} />
                </>
              )}
            </>
          )}
        </>
      )}
      {canManage && (
        <AdsSettingsCard key={`${account.id}:${account.resultKind}:${account.expenseAccountCode}:${account.legalEntityId}`} account={account} entities={entities} />
      )}
      <SyncRuns account={account} />
    </div>
  );
}

export function AdsPage() {
  const t = useTranslations('ads');
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: AdsSearch = useSearch({ strict: false });
  const config = getConfig();
  const sandbox = Boolean(config.ads?.sandbox);
  const metaOffered = adOAuthProviders(config).includes('meta_ads');
  const financeOn = config.modules.includes('finance');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const [adding, setAdding] = useState(false);
  // After "Refresh now" the account is asked for again every few seconds for a while, so the finished run shows up.
  const [watchUntil, setWatchUntil] = useState(0);
  const accounts = useQuery({
    ...orpc.ads.accounts.queryOptions(),
    refetchInterval: (query) => {
      if (Date.now() < watchUntil) return REFRESH_POLL_MS;
      // A first sync lands within seconds of connecting, slice by slice: ask again while it is awaited and for a minute after
      // each run seen, a couple of minutes at the most, then leave it to the next visit.
      const now = Date.now();
      const waiting = query.state.data?.some((a) => awaitsFirstSync(a) || recentlyRan(a, now)) && query.state.dataUpdateCount + query.state.errorUpdateCount < FIRST_SYNC_POLL_LIMIT;
      return waiting ? FIRST_SYNC_POLL_MS : false;
    },
  });
  // Owners and admins choose among the org's legal entities when it has several.
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const list = accounts.data ?? [];
  const account = list.find((a) => a.id === search.account) ?? list[0];
  const go = (next: AdsSearch) => void navigate({ to: '/o/$slug/ads', params: { slug }, search: next });
  const range = search.range ?? DEFAULT_ADS_RANGE;
  const connected = (adAccountId: string) => {
    setAdding(false);
    go({ account: adAccountId, ...(search.range ? { range: search.range } : {}) });
  };
  const connectAnother = canManage && sandbox && list.length > 0 && !adding;
  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          connectAnother ? (
            <Button variant="outline" size="lg" onClick={() => setAdding(true)}>
              {t('addAnother')}
            </Button>
          ) : undefined
        }
      />
      {accounts.error ? (
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      ) : !accounts.data || me.isPending ? (
        // The role decides what the screen offers, so it waits for it: an owner is never shown "an owner connects it".
        <div className="space-y-4">
          <CardSkeleton />
          <TableSkeleton columns={4} />
        </div>
      ) : list.length === 0 || !account ? (
        <AdsEmpty canManage={canManage} sandbox={sandbox} meta={metaOffered ? { slug } : undefined} entities={entities.data ?? []} onConnected={connected} />
      ) : (
        <div className="space-y-8">
          {adding && (
            <Card className="block p-4">
              <ConnectSandboxForm entities={entities.data ?? []} onConnected={connected} onCancel={() => setAdding(false)} />
            </Card>
          )}
          {canManage && metaOffered && <ConnectMeta slug={slug} another />}
          {canManage && <AdsWriteCard role={role} accounts={list} />}
          {list.length > 1 && (
            <Field label={t('accountLabel')} className="max-w-sm">
              {(control) => (
                <NativeSelect {...control} className="w-full" value={account.id} onChange={(e) => go({ account: e.target.value, ...(search.range ? { range: search.range } : {}) })}>
                  {list.map((a) => (
                    <NativeSelectOption key={a.id} value={a.id}>
                      {a.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          <AccountPanel
            key={account.id}
            account={account}
            range={range}
            onRange={(kind) => go({ ...(search.account ? { account: search.account } : {}), range: kind })}
            role={role}
            entities={entities.data ?? []}
            financeOn={financeOn}
            reconnect={metaOffered ? { slug } : undefined}
            onRequested={() => setWatchUntil(Date.now() + REFRESH_WATCH_MS)}
          />
        </div>
      )}
    </div>
  );
}
