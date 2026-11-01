// SPDX-License-Identifier: AGPL-3.0-only
// The switches and the spend caps of running ads on the Ads screen (ADR-0043, issue #2294, W0a-1). Owners and admins only: the
// caller draws it. Nothing here calls an ad platform and nothing spends. It says whether running ads is on for the org, which
// accounts are enabled and which caps a launch must stay inside, and it holds the controls that only stop or reduce spend: the
// owner switches running ads off or one account off, and owners and admins stop everything at once. Turning it on, enabling an
// account, setting or raising a cap and opening launches again are proposals (ADR-0043 point 1) and come with the next PR.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { AdAccountView, AdsCapView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';

const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ads.writeState.key() }), queryClient.invalidateQueries({ queryKey: orpc.ads.accounts.key() })]);

const capKey = (cap: Pick<AdsCapView, 'scope' | 'adAccountId' | 'period'>) => `${cap.scope}:${cap.adAccountId ?? ''}:${cap.period}`;

export function AdsWriteCard({ role, accounts }: { role: string | undefined; accounts: readonly AdAccountView[] }) {
  const t = useTranslations('ads.write');
  const f = useFormat();
  const owner = role === 'owner';
  const state = useQuery(orpc.ads.writeState.queryOptions());
  const disable = useMutation(orpc.ads.writeDisable.mutationOptions({ onSuccess: async () => (toast(t('disabledToast')), refresh()) }));
  const pauseAll = useMutation(orpc.ads.pauseAll.mutationOptions({ onSuccess: async () => (toast(t('pausedToast')), refresh()) }));
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  if (!state.data) return null;
  const { writeEnabled, launchesBlocked, caps } = state.data;
  const capOf = (scope: 'org' | 'account', adAccountId: string | null, period: 'daily' | 'monthly') => caps.find((c) => capKey(c) === capKey({ scope, adAccountId, period }));
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

// One account's flag: everyone who reads the card sees where it stands, and the owner can switch an enabled account off.
function AccountRow({ account, owner }: { account: AdAccountView; owner: boolean }) {
  const t = useTranslations('ads.write');
  const off = useMutation(orpc.ads.disableAccountWrite.mutationOptions({ onSuccess: async () => (toast(t('accountOffToast')), refresh()) }));
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-foreground">{account.name}</span>
        <span className="flex items-center gap-2">
          <Badge variant={account.writeEnabled ? 'warning' : 'secondary'}>{account.writeEnabled ? t('accountOn') : t('accountOff')}</Badge>
          {owner && account.writeEnabled && (
            <Button loading={off.isPending} variant="outline" onClick={() => off.mutate({ adAccountId: account.id, idempotencyKey: crypto.randomUUID() })}>
              {t('accountDisable')}
            </Button>
          )}
        </span>
      </div>
      {off.error && <ErrorText>{errorMessage(off.error)}</ErrorText>}
    </li>
  );
}
