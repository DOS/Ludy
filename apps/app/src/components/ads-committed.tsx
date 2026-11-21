// SPDX-License-Identifier: AGPL-3.0-only
// The committed spend of the month on the Ads screen (issue #3297, plan docs/plan/ads-write.md section 8), for owners and admins: next to the actual
// spend, what the approved launches that still commit can spend this month, the monthly cap and the room left, so the person sees what is about to
// reach the books. A read of the launch ledger and the caps, worked out on the server in decimal with the lock's own sum: no model is called and
// nothing is changed or posted. Hidden while running ads is off for the org, and says so plainly when no cap is set (every launch is refused then).
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import type { AdAccountView } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { committedView, type CommittedRow } from '../lib/ads-committed.ts';
import { orpc } from '../lib/api.ts';
import { monthLabel } from '../lib/period-lock.ts';
import { useWriteState } from './ads-write.tsx';
import { CardSkeleton } from './ui.tsx';

function Row({ row, currency }: { row: CommittedRow; currency: string }) {
  const t = useTranslations('ads.committed');
  const f = useFormat();
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium text-subtle-foreground">{t(row.scope === 'org' ? 'scopeOrg' : 'scopeAccount')}</h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-subtle-foreground">{t('committed')}</dt>
          <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]">{f.money(row.committed, currency)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-subtle-foreground">{t('cap')}</dt>
          <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]">
            {row.cap === null ? <span className="text-sm font-normal text-muted-foreground">{t('noMonthlyCap')}</span> : f.money(row.cap, currency)}
          </dd>
        </div>
        {row.cap !== null && (
          <div className="min-w-0">
            <dt className="text-xs text-subtle-foreground">{row.over === null ? t('left') : t('over')}</dt>
            <dd className={`mt-1 text-lg font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere] ${row.over === null ? 'text-foreground' : 'text-warning'}`}>
              {f.money(row.over ?? row.left ?? '0', currency)}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function CommittedBody({ account, month }: { account: Pick<AdAccountView, 'id' | 'currency'>; month: string }) {
  const t = useTranslations('ads.committed');
  // Read again every minute: a stop's pause at the platform finishes in the background, and only then does the commitment drop.
  const committed = useQuery({ ...orpc.ads.committed.queryOptions({ input: { adAccountId: account.id, month } }), refetchInterval: 60_000 });
  if (committed.isPending) return <CardSkeleton />;
  if (committed.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3" role="status">
        <p className="text-sm text-muted-foreground">{t('error')}</p>
        <Button type="button" variant="outline" size="sm" loading={committed.isRefetching} onClick={() => void committed.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  const view = committedView(committed.data);
  const currency = committed.data.currency;
  return (
    <Card className="block space-y-4 p-4" data-testid="ads-committed">
      {view.kind === 'noCap' || view.kind === 'capCurrency' ? (
        <p className="text-sm text-foreground" role="status" data-testid={view.kind === 'noCap' ? 'ads-committed-no-cap' : 'ads-committed-cap-currency'}>
          {t(view.kind === 'noCap' ? 'noCap' : 'capCurrency', { currency })}
        </p>
      ) : (
        view.rows.map((row) => <Row key={row.scope} row={row} currency={currency} />)
      )}
    </Card>
  );
}

// `month` is the one the account's own calendar is in ('YYYY-MM'); an account that has not read its currency yet has nothing to compare a cap with.
export function AdsCommittedStrip({ account, month }: { account: Pick<AdAccountView, 'id' | 'currency'>; month: string }) {
  const t = useTranslations('ads.committed');
  const headingId = useId();
  const state = useWriteState();
  // Off, or not read yet (or failed: the card of running ads says so): the line is not drawn.
  if (!state.data?.writeEnabled || !account.currency) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        {t('title', { month: monthLabel(month) })}
      </h2>
      <CommittedBody account={account} month={month} />
      <p className="text-xs text-subtle-foreground">{t('hint', { month: monthLabel(month) })}</p>
    </section>
  );
}
