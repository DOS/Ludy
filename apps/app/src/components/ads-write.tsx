// SPDX-License-Identifier: AGPL-3.0-only
// The switches and the spend caps of running ads on the Ads screen (ADR-0043, issue #2294, W0a). Owners and admins only: the
// caller draws it. Nothing here calls an ad platform and nothing spends. It says whether running ads is on for the org, which
// accounts are allowed and which caps a launch must stay inside. What opens the way to spend (the org switch, an account's
// flag, a cap set or raised, launches opened again) is asked for here, by owners and admins, and is a proposal that someone
// approves in the Inbox (ADR-0043 point 1): no button on this card changes it. What only stops or reduces spend is direct:
// the owner switches running ads off, withdraws one account and lowers a cap; owners and admins stop everything at once.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ADS_CAP_PERIODS, ADS_CAP_SCOPES, type AdAccountView, type AdsCapView, type AdsWriteState } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { adsChangeLine } from '../lib/ads-change.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, Field } from './ui.tsx';

const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ads.writeState.key() }), queryClient.invalidateQueries({ queryKey: orpc.ads.accounts.key() })]);

// A decimal the server will accept as a cap: above zero, at most two decimals (the sandbox and Meta report in whole units and
// cents). The server checks again.
const AMOUNT = /^(?!0+(\.0+)?$)\d{1,15}(\.\d{1,2})?$/;
export const isCapAmount = (text: string): boolean => AMOUNT.test(text.trim());

const capKey = (cap: Pick<AdsCapView, 'scope' | 'adAccountId' | 'period'>) => `${cap.scope}:${cap.adAccountId ?? ''}:${cap.period}`;

type Pending = AdsWriteState['pending'][number];

export function AdsWriteCard({ role, accounts, slug }: { role: string | undefined; accounts: readonly AdAccountView[]; slug: string }) {
  const t = useTranslations('ads.write');
  const root = useTranslations();
  const f = useFormat();
  const owner = role === 'owner';
  const state = useQuery(orpc.ads.writeState.queryOptions());
  const requested = async () => (toast(t('requestedToast')), refresh());
  // Asking for a change is R1: it makes a proposal in the Inbox and changes nothing, so it needs no second factor.
  const enable = useMutation(orpc.ads.requestChange.mutationOptions({ onSuccess: requested }));
  const unblock = useMutation(orpc.ads.requestChange.mutationOptions({ onSuccess: requested }));
  const disable = useMutation(orpc.ads.writeDisable.mutationOptions({ onSuccess: async () => (toast(t('disabledToast')), refresh()) }));
  const pauseAll = useMutation(orpc.ads.pauseAll.mutationOptions({ onSuccess: async () => (toast(t('pausedToast')), refresh()) }));
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  if (!state.data) return null;
  const { writeEnabled, launchesBlocked, caps, pending } = state.data;
  const capOf = (scope: 'org' | 'account', adAccountId: string | null, period: 'daily' | 'monthly') => caps.find((c) => capKey(c) === capKey({ scope, adAccountId, period }));
  const orgCapCurrency = caps.find((c) => c.scope === 'org')?.currency ?? 'VND';
  // A request of the same kind that already waits for approval: the card says so instead of offering to ask again.
  const waiting = (kind: Pending['change']['change']) => pending.some((p) => p.change.change === kind);
  const waitingForAccount = (adAccountId: string) => pending.some((p) => p.change.change === 'account_enable' && p.change.adAccountId.toLowerCase() === adAccountId.toLowerCase());
  return (
    <Card className="block space-y-5 p-4">
      <section aria-labelledby="ads-write-title" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="ads-write-title" className="text-base font-semibold text-foreground">
            {t('title')}
          </h2>
          <Badge variant={writeEnabled ? 'warning' : 'secondary'}>{writeEnabled ? t('on') : t('off')}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{writeEnabled ? t('onHint') : t('offHint')}</p>
        {!writeEnabled &&
          (waiting('write_enable') ? (
            <Badge variant="proposal">{t('waitingBadge')}</Badge>
          ) : (
            <div>
              <Button loading={enable.isPending} variant="outline" size="lg" onClick={() => enable.mutate({ change: 'write_enable', idempotencyKey: crypto.randomUUID() })}>
                {t('request')}
              </Button>
              {enable.error && <ErrorText>{errorMessage(enable.error)}</ErrorText>}
            </div>
          ))}
        {owner && writeEnabled && (
          <div>
            <ConfirmDialog
              render={<Button loading={disable.isPending} variant="outline" size="lg" />}
              destructive
              title={t('disableTitle')}
              description={t('disableBody')}
              confirm={t('disable')}
              onConfirm={() => disable.mutate({ idempotencyKey: crypto.randomUUID() })}
            >
              {t('disable')}
            </ConfirmDialog>
            {disable.error && <ErrorText>{errorMessage(disable.error)}</ErrorText>}
          </div>
        )}
      </section>

      {launchesBlocked && (
        <section className="space-y-2" role="status">
          <p className="text-sm text-warning">{t('blocked')}</p>
          {waiting('launches_unblock') ? (
            <Badge variant="proposal">{t('waitingBadge')}</Badge>
          ) : (
            <div>
              <Button loading={unblock.isPending} variant="outline" size="lg" onClick={() => unblock.mutate({ change: 'launches_unblock', idempotencyKey: crypto.randomUUID() })}>
                {t('unblockRequest')}
              </Button>
              {unblock.error && <ErrorText>{errorMessage(unblock.error)}</ErrorText>}
            </div>
          )}
        </section>
      )}

      {writeEnabled && !launchesBlocked && (
        <section className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('pauseAllHint')}</p>
          <ConfirmDialog
            render={<Button loading={pauseAll.isPending} variant="destructive" size="lg" />}
            destructive
            title={t('pauseAllTitle')}
            description={t('pauseAllBody')}
            confirm={t('pauseAll')}
            onConfirm={() => pauseAll.mutate({ idempotencyKey: crypto.randomUUID() })}
          >
            {t('pauseAll')}
          </ConfirmDialog>
          {pauseAll.error && <ErrorText>{errorMessage(pauseAll.error)}</ErrorText>}
        </section>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="ads-write-pending" className="space-y-2">
          <h3 id="ads-write-pending" className="text-sm font-medium text-foreground">
            {t('pending')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('pendingHint')}</p>
          <ul className="divide-y text-sm">
            {pending.map((p) => (
              <li key={p.proposalId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 break-words text-foreground">{adsChangeLine(p.change, root, (amount, currency) => f.money(amount, currency))}</span>
                <span className="flex flex-wrap items-baseline gap-x-3 text-xs text-subtle-foreground">
                  <span>{t('pendingAsked', { when: f.dateTime(p.requestedAt) })}</span>
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id: p.proposalId }} className="text-link hover:underline">
                    {t('pendingOpen')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {writeEnabled && accounts.length > 0 && (
        <section aria-labelledby="ads-write-accounts" className="space-y-2">
          <h3 id="ads-write-accounts" className="text-sm font-medium text-foreground">
            {t('accounts')}
          </h3>
          <ul className="divide-y text-sm">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} owner={owner} waiting={waitingForAccount(a.id)} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="ads-write-caps" className="space-y-3">
        <h3 id="ads-write-caps" className="text-sm font-medium text-foreground">
          {t('caps')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('capsHint')}</p>
        <ul className="space-y-1 text-sm">
          <CapLine label={t('capOrg')} daily={capOf('org', null, 'daily')} monthly={capOf('org', null, 'monthly')} />
          {accounts.map((a) => (
            <CapLine key={a.id} label={a.name} daily={capOf('account', a.id, 'daily')} monthly={capOf('account', a.id, 'monthly')} />
          ))}
        </ul>
        {caps.length > 0 && <p className="text-xs text-subtle-foreground">{t('capsSet', { when: f.dateTime(caps.reduce((late, c) => (c.setAt > late ? c.setAt : late), caps[0]?.setAt ?? '')) })}</p>}
        <CapForm owner={owner} accounts={accounts} caps={caps} pending={pending} orgCurrency={orgCapCurrency} />
      </section>
    </Card>
  );
}

function CapLine({ label, daily, monthly }: { label: string; daily: AdsCapView | undefined; monthly: AdsCapView | undefined }) {
  const t = useTranslations('ads.write');
  const f = useFormat();
  const show = (cap: AdsCapView | undefined) => (cap ? f.money(cap.amount, cap.currency) : t('capNone'));
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="min-w-0 break-words text-foreground">{label}</span>
      <span className="text-muted-foreground">
        {t('capDaily')}: {show(daily)}; {t('capMonthly')}: {show(monthly)}
      </span>
    </li>
  );
}

// One account's flag: everyone who reads the card sees where it stands. An account that is not allowed yet can be asked for (a
// proposal, only while the org's switch is on, which is when the list is drawn); the owner can withdraw an allowed one at once.
function AccountRow({ account, owner, waiting }: { account: AdAccountView; owner: boolean; waiting: boolean }) {
  const t = useTranslations('ads.write');
  const off = useMutation(orpc.ads.disableAccountWrite.mutationOptions({ onSuccess: async () => (toast(t('accountOffToast')), refresh()) }));
  const ask = useMutation(orpc.ads.requestChange.mutationOptions({ onSuccess: async () => (toast(t('requestedToast')), refresh()) }));
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-foreground">{account.name}</span>
        <span className="flex items-center gap-2">
          <Badge variant={account.writeEnabled ? 'warning' : 'secondary'}>{account.writeEnabled ? t('accountOn') : t('accountOff')}</Badge>
          {account.writeEnabled
            ? owner && (
                <Button loading={off.isPending} variant="outline" onClick={() => off.mutate({ adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}>
                  {t('accountDisable')}
                </Button>
              )
            : waiting ? (
                <Badge variant="proposal">{t('waitingBadge')}</Badge>
              ) : (
                <Button loading={ask.isPending} variant="outline" onClick={() => ask.mutate({ change: 'account_enable', adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}>
                  {t('accountRequest')}
                </Button>
              )}
        </span>
      </div>
      {off.error && <ErrorText>{errorMessage(off.error)}</ErrorText>}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
    </li>
  );
}

type CapMode = 'raise' | 'lower';

// Owners and admins ask to set or raise a cap (the org's, in the currency typed, or one account's, in its own currency, known
// after its first update): a proposal for the Inbox. The owner can also lower one on the spot, which only reduces what may be
// spent: in the cap's own currency, below the cap in force. A change is a new row, so the history stays. `initial` is where the
// form starts (the screen never sets it; tests render the other states with it).
export function CapForm({
  owner,
  accounts,
  caps,
  pending,
  orgCurrency,
  initial = {},
}: {
  owner: boolean;
  accounts: readonly AdAccountView[];
  caps: readonly AdsCapView[];
  pending: readonly Pending[];
  orgCurrency: string;
  initial?: { mode?: CapMode; scope?: (typeof ADS_CAP_SCOPES)[number] };
}) {
  const t = useTranslations('ads.write');
  const f = useFormat();
  const [mode, setMode] = useState<CapMode>(initial.mode ?? 'raise');
  const [scope, setScope] = useState<(typeof ADS_CAP_SCOPES)[number]>(initial.scope ?? 'org');
  const [adAccountId, setAdAccountId] = useState('');
  const [period, setPeriod] = useState<(typeof ADS_CAP_PERIODS)[number]>('daily');
  const [amount, setAmount] = useState('');
  const [orgCurrencyInput, setOrgCurrencyInput] = useState(orgCurrency);
  const lowering = owner && mode === 'lower';
  // To raise, an account needs a known currency; to lower, any account (the cap in force has its own).
  const choosable = lowering ? accounts : accounts.filter((a) => a.currency !== null);
  const account = choosable.find((a) => a.id === adAccountId) ?? choosable[0];
  const target = scope === 'account' ? (account?.id ?? null) : null;
  const inForce = caps.find((c) => capKey(c) === capKey({ scope, adAccountId: target, period }));
  const requestOpen = pending.some(
    (p) => p.change.change === 'cap_set' && p.change.scope === scope && p.change.period === period && (p.change.adAccountId?.toLowerCase() ?? null) === (target?.toLowerCase() ?? null),
  );
  const currency = scope === 'org' ? orgCurrencyInput.trim().toUpperCase() : (account?.currency ?? '');
  const targetKnown = scope === 'org' || account !== undefined;
  const valid = isCapAmount(amount) && targetKnown && (lowering ? inForce !== undefined : /^[A-Z]{3}$/.test(currency) && !requestOpen);
  const request = useMutation(orpc.ads.requestChange.mutationOptions({ onSuccess: async () => (setAmount(''), toast(t('requestedToast')), refresh()) }));
  const lower = useMutation(orpc.ads.lowerCap.mutationOptions({ onSuccess: async () => (setAmount(''), toast(t('capLoweredToast')), refresh()) }));
  const busy = request.isPending || lower.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const named = scope === 'account' && account ? { adAccountId: account.id } : {};
    if (lowering) lower.mutate({ scope, ...named, period, amount: amount.trim(), idempotencyKey: crypto.randomUUID() });
    else request.mutate({ change: 'cap_set', scope, ...named, period, amount: amount.trim(), currency, idempotencyKey: crypto.randomUUID() });
  };
  const changeMode = (next: CapMode) => {
    setMode(next);
    request.reset();
    lower.reset();
  };
  return (
    <div>
      <form onSubmit={submit} className="space-y-3" aria-label={t('capForm')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {owner && (
            <Field label={t('capAction')}>
              {(control) => (
                <NativeSelect {...control} className="w-full" value={mode} disabled={busy} onChange={(e) => changeMode(e.target.value as CapMode)}>
                  {(['raise', 'lower'] as const).map((m) => (
                    <NativeSelectOption key={m} value={m}>
                      {t(`capActions.${m}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          <Field label={t('capScope')}>
            {(control) => (
              <NativeSelect {...control} className="w-full" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as typeof scope)}>
                {ADS_CAP_SCOPES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {t(`capScopes.${s}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          {scope === 'account' && (
            <Field label={t('capAccount')} hint={choosable.length === 0 ? t('capNoCurrency') : undefined}>
              {(control) => (
                <NativeSelect {...control} className="w-full" value={account?.id ?? ''} disabled={busy || choosable.length === 0} onChange={(e) => setAdAccountId(e.target.value)}>
                  {choosable.map((a) => (
                    <NativeSelectOption key={a.id} value={a.id}>
                      {a.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          <Field label={t('capPeriod')}>
            {(control) => (
              <NativeSelect {...control} className="w-full" value={period} disabled={busy} onChange={(e) => setPeriod(e.target.value as typeof period)}>
                {ADS_CAP_PERIODS.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(`capPeriods.${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={t('capAmount')} hint={amount !== '' && !isCapAmount(amount) ? t('capAmountInvalid') : undefined}>
            {(control) => <Input {...control} inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          {!lowering && scope === 'org' && (
            <Field label={t('capCurrency')} hint={t('capCurrencyHint')}>
              {(control) => <Input {...control} maxLength={3} value={orgCurrencyInput} disabled={busy} onChange={(e) => setOrgCurrencyInput(e.target.value)} />}
            </Field>
          )}
          {!lowering && scope === 'account' && account && <p className="self-end text-sm text-muted-foreground">{t('capAccountCurrency', { currency: account.currency ?? '' })}</p>}
        </div>
        <p className="text-sm text-muted-foreground">{inForce ? t('capInForce', { amount: f.money(inForce.amount, inForce.currency) }) : t('capNoneYet')}</p>
        {lowering && <p className="text-sm text-muted-foreground">{t('capLowerHint')}</p>}
        {!lowering && requestOpen && <p className="text-sm text-muted-foreground">{t('capRequestOpen')}</p>}
        <Button loading={busy} type="submit" size="lg" disabled={!valid}>
          {lowering ? t('capLower') : t('capRequest')}
        </Button>
      </form>
      {request.error && <ErrorText>{errorMessage(request.error)}</ErrorText>}
      {lower.error && <ErrorText>{errorMessage(lower.error)}</ErrorText>}
    </div>
  );
}
