// SPDX-License-Identifier: AGPL-3.0-only
// The switches and the spend caps of running ads on the Ads screen (ADR-0043, issue #2294, W0a). Owners and admins only: the
// caller draws it. Nothing here calls an ad platform and nothing spends; it says whether running ads is on for the org, lets
// the owner turn it on or off, enable an account, set the caps a launch must stay inside, and lets owners and admins stop it
// all at once. The commands that can start or raise spend are R3, so they wait for a second factor verified in the last five
// minutes: on STEP_UP_REQUIRED the prompt asks for one and sends the refused request again, as the other R3 screens do.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ADS_CAP_PERIODS, ADS_CAP_SCOPES, type AdAccountView, type AdsCapView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText, Field } from './ui.tsx';

const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ads.writeState.key() }), queryClient.invalidateQueries({ queryKey: orpc.ads.accounts.key() })]);

// A decimal the server will accept as a cap: above zero, at most two decimals (the sandbox and Meta report in whole units and
// cents). The server checks again.
const AMOUNT = /^(?!0+(\.0+)?$)\d{1,15}(\.\d{1,2})?$/;
export const isCapAmount = (text: string): boolean => AMOUNT.test(text.trim());

// The refusal of an R3 request this card sent: a second factor is asked for and the same request sent again; any other
// refusal shows as text.
function Refusal<V>({ error, variables, retry, reset, action }: { error: unknown; variables: V | undefined; retry: (variables: V) => void; reset: () => void; action: string }) {
  if (!error) return null;
  if (isStepUpRequired(error)) {
    return (
      <div className="mt-2">
        <StepUpPrompt action={action} onVerified={() => variables !== undefined && retry(variables)} onCancel={reset} />
      </div>
    );
  }
  return <ErrorText>{errorMessage(error)}</ErrorText>;
}

const capKey = (cap: Pick<AdsCapView, 'scope' | 'adAccountId' | 'period'>) => `${cap.scope}:${cap.adAccountId ?? ''}:${cap.period}`;

export function AdsWriteCard({ role, accounts }: { role: string | undefined; accounts: readonly AdAccountView[] }) {
  const t = useTranslations('ads.write');
  const f = useFormat();
  const owner = role === 'owner';
  const state = useQuery(orpc.ads.writeState.queryOptions());
  const enable = useMutation(orpc.ads.writeEnable.mutationOptions({ onSuccess: async () => (toast(t('enabledToast')), refresh()) }));
  const disable = useMutation(orpc.ads.writeDisable.mutationOptions({ onSuccess: async () => (toast(t('disabledToast')), refresh()) }));
  const unblock = useMutation(orpc.ads.unblockLaunches.mutationOptions({ onSuccess: async () => (toast(t('unblockedToast')), refresh()) }));
  const pauseAll = useMutation(orpc.ads.pauseAll.mutationOptions({ onSuccess: async () => (toast(t('pausedToast')), refresh()) }));
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  if (!state.data) return null;
  const { writeEnabled, launchesBlocked, caps } = state.data;
  const capOf = (scope: 'org' | 'account', adAccountId: string | null, period: 'daily' | 'monthly') => caps.find((c) => capKey(c) === capKey({ scope, adAccountId, period }));
  const orgCapCurrency = caps.find((c) => c.scope === 'org')?.currency ?? 'VND';
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
        {owner && !writeEnabled && (
          <div>
            <Button loading={enable.isPending} variant="outline" size="lg" onClick={() => enable.mutate({ idempotencyKey: crypto.randomUUID() })}>
              {t('enable')}
            </Button>
            <Refusal error={enable.error} variables={enable.variables} retry={(v) => enable.mutate(v)} reset={enable.reset} action={t('stepUpEnable')} />
          </div>
        )}
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
          {owner && (
            <div>
              <Button loading={unblock.isPending} variant="outline" size="lg" onClick={() => unblock.mutate({ idempotencyKey: crypto.randomUUID() })}>
                {t('unblock')}
              </Button>
              <Refusal error={unblock.error} variables={unblock.variables} retry={(v) => unblock.mutate(v)} reset={unblock.reset} action={t('stepUpUnblock')} />
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

      {writeEnabled && accounts.length > 0 && (
        <section aria-labelledby="ads-write-accounts" className="space-y-2">
          <h3 id="ads-write-accounts" className="text-sm font-medium text-foreground">
            {t('accounts')}
          </h3>
          <ul className="divide-y text-sm">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} owner={owner} />
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
        {owner && <CapForm accounts={accounts} orgCurrency={orgCapCurrency} />}
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

// One account's flag: the owner enables it (R3) or disables it, and everyone who reads the card sees where it stands.
function AccountRow({ account, owner }: { account: AdAccountView; owner: boolean }) {
  const t = useTranslations('ads.write');
  const on = useMutation(orpc.ads.enableAccountWrite.mutationOptions({ onSuccess: async () => (toast(t('accountOnToast')), refresh()) }));
  const off = useMutation(orpc.ads.disableAccountWrite.mutationOptions({ onSuccess: async () => (toast(t('accountOffToast')), refresh()) }));
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-foreground">{account.name}</span>
        <span className="flex items-center gap-2">
          <Badge variant={account.writeEnabled ? 'warning' : 'secondary'}>{account.writeEnabled ? t('accountOn') : t('accountOff')}</Badge>
          {owner &&
            (account.writeEnabled ? (
              <Button loading={off.isPending} variant="outline" onClick={() => off.mutate({ adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}>
                {t('accountDisable')}
              </Button>
            ) : (
              <Button loading={on.isPending} variant="outline" onClick={() => on.mutate({ adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}>
                {t('accountEnable')}
              </Button>
            ))}
        </span>
      </div>
      <Refusal error={on.error} variables={on.variables} retry={(v) => on.mutate(v)} reset={on.reset} action={t('stepUpAccount', { name: account.name })} />
      {off.error && <ErrorText>{errorMessage(off.error)}</ErrorText>}
    </li>
  );
}

// The owner sets a cap: the org's (in the org's currency, one currency for all of its caps) or one account's (in its currency,
// known after its first update). A change is a new row, so the history stays.
function CapForm({ accounts, orgCurrency }: { accounts: readonly AdAccountView[]; orgCurrency: string }) {
  const t = useTranslations('ads.write');
  const [scope, setScope] = useState<(typeof ADS_CAP_SCOPES)[number]>('org');
  const [adAccountId, setAdAccountId] = useState('');
  const [period, setPeriod] = useState<(typeof ADS_CAP_PERIODS)[number]>('daily');
  const [amount, setAmount] = useState('');
  const [orgCurrencyInput, setOrgCurrencyInput] = useState(orgCurrency);
  const settable = accounts.filter((a) => a.currency !== null);
  const account = settable.find((a) => a.id === (adAccountId || settable[0]?.id));
  const currency = scope === 'org' ? orgCurrencyInput.trim().toUpperCase() : (account?.currency ?? '');
  const valid = isCapAmount(amount) && /^[A-Z]{3}$/.test(currency) && (scope === 'org' || account !== undefined);
  const set = useMutation(orpc.ads.setCap.mutationOptions({ onSuccess: async () => (setAmount(''), toast(t('capSavedToast')), refresh()) }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    set.mutate({ scope, ...(scope === 'account' && account ? { adAccountId: account.id } : {}), period, amount: amount.trim(), currency, idempotencyKey: crypto.randomUUID() });
  };
  return (
    <div>
      <form onSubmit={submit} className="space-y-3" aria-label={t('capForm')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('capScope')}>
            {(control) => (
              <NativeSelect {...control} className="w-full" value={scope} disabled={set.isPending} onChange={(e) => setScope(e.target.value as typeof scope)}>
                {ADS_CAP_SCOPES.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {t(`capScopes.${s}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          {scope === 'account' && (
            <Field label={t('capAccount')} hint={settable.length === 0 ? t('capNoCurrency') : undefined}>
              {(control) => (
                <NativeSelect {...control} className="w-full" value={account?.id ?? ''} disabled={set.isPending || settable.length === 0} onChange={(e) => setAdAccountId(e.target.value)}>
                  {settable.map((a) => (
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
              <NativeSelect {...control} className="w-full" value={period} disabled={set.isPending} onChange={(e) => setPeriod(e.target.value as typeof period)}>
                {ADS_CAP_PERIODS.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(`capPeriods.${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={t('capAmount')} hint={amount !== '' && !isCapAmount(amount) ? t('capAmountInvalid') : undefined}>
            {(control) => <Input {...control} inputMode="decimal" value={amount} disabled={set.isPending} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          {scope === 'org' && (
            <Field label={t('capCurrency')} hint={t('capCurrencyHint')}>
              {(control) => <Input {...control} maxLength={3} value={orgCurrencyInput} disabled={set.isPending} onChange={(e) => setOrgCurrencyInput(e.target.value)} />}
            </Field>
          )}
          {scope === 'account' && account && <p className="self-end text-sm text-muted-foreground">{t('capAccountCurrency', { currency: account.currency ?? '' })}</p>}
        </div>
        <Button loading={set.isPending} type="submit" size="lg" disabled={!valid}>
          {t('capSave')}
        </Button>
      </form>
      <Refusal error={set.error} variables={set.variables} retry={(v) => set.mutate(v)} reset={set.reset} action={t('stepUpCap')} />
    </div>
  );
}
