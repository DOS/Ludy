// SPDX-License-Identifier: AGPL-3.0-only
// The three money tiles on Home (#4785): Chưa thu (what customers owe), Chưa trả (what the org owes suppliers) and Tiền ngân hàng (the bank accounts), each a link to
// the list behind its figure. Every figure comes from the books (finance.home_money, decided by code, no model); the finance module also decides who sees them, so a member
// who may not gets `available: false` and the tiles are not drawn at all. Hidden too while the Finance app is off. Amounts are decimal strings shown by the money formatter.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { FinanceHomeMoney } from '@ludy/kernel-contract';
import { cn } from '@ludy/ui/lib/utils';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

type Available = Extract<FinanceHomeMoney, { available: true }>;

const TILE = 'flex min-h-11 flex-col gap-1 rounded-xl border bg-card p-4 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const AMOUNT = 'font-mono text-2xl font-semibold tabular-nums';
// A minus sign is the cue for a negative balance; the colour only repeats it.
const isNegative = (amount: string): boolean => amount.startsWith('-') && !/^-0(\.0+)?$/.test(amount);
// How many bank accounts the tile names under its figure; the figure itself counts all of them.
const NAMED_ACCOUNTS = 3;

// The tiles of one reading of the books.
export function MoneyTilesView({ slug, data }: { slug: string; data: Available }) {
  const t = useTranslations('overview.money');
  const f = useFormat();
  const named = data.bankAccounts.slice(0, NAMED_ACCOUNTS);
  const unnamed = data.bankAccountCount - named.length;
  return (
    <section aria-labelledby="home-money-title" className="mt-4" data-testid="home-money-tiles">
      <h2 id="home-money-title" className="sr-only">
        {t('title')}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        <li className="flex">
          <Link to="/o/$slug/customers" params={{ slug }} className={cn(TILE, 'w-full')} data-testid="home-money-receivables" title={t('receivables.open')}>
            <span className="text-sm font-medium text-muted-foreground">{t('receivables.label')}</span>
            <span className={cn(AMOUNT, 'text-foreground')}>{f.money(data.receivables)}</span>
            <span className="text-xs text-subtle-foreground">{t('receivables.hint')}</span>
          </Link>
        </li>
        <li className="flex">
          <Link to="/o/$slug/vendors" params={{ slug }} className={cn(TILE, 'w-full')} data-testid="home-money-payables" title={t('payables.open')}>
            <span className="text-sm font-medium text-muted-foreground">{t('payables.label')}</span>
            <span className={cn(AMOUNT, 'text-foreground')}>{f.money(data.payables)}</span>
            <span className="text-xs text-subtle-foreground">{t('payables.hint')}</span>
          </Link>
        </li>
        <li className="flex">
          <Link to="/o/$slug/bank" params={{ slug }} className={cn(TILE, 'w-full')} data-testid="home-money-bank" title={t('bank.open')}>
            <span className="text-sm font-medium text-muted-foreground">{t('bank.label')}</span>
            <span className={cn(AMOUNT, isNegative(data.bank) ? 'text-destructive' : 'text-foreground')}>{f.money(data.bank)}</span>
            <span className="text-xs text-subtle-foreground">{t('bank.hint', { count: data.bankAccountCount })}</span>
            {data.bankAccountCount > 1 && (
              <span className="mt-1 block space-y-0.5 text-xs text-muted-foreground" data-testid="home-money-bank-accounts">
                {named.map((a) => (
                  <span key={a.code} className="block truncate tabular-nums">
                    {t('bank.account', { name: a.name ?? a.code, amount: f.money(a.balance) })}
                  </span>
                ))}
                {unnamed > 0 && <span className="block">{t('bank.more', { count: unnamed })}</span>}
              </span>
            )}
          </Link>
        </li>
      </ul>
    </section>
  );
}

// The tiles of Home, read again with the books. Nothing is drawn while the answer is on its way (the tiles are one quiet row, so nothing jumps much), when the member may
// not see them, or when the Finance app is off; a failed read says so once, with a retry.
export function MoneyTiles({ slug, financeOn }: { slug: string; financeOn: boolean }) {
  const t = useTranslations('overview.money');
  const live = useStreamLive();
  const query = useQuery({ ...orpc.financeHomeMoney.get.queryOptions({ input: {} }), enabled: financeOn, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS), retry: false });
  if (!financeOn) return null;
  if (query.isError) {
    return (
      <section className="mt-4" aria-label={t('title')}>
        <ErrorText>
          {errorMessage(query.error)}{' '}
          <button type="button" className="min-h-11 underline" onClick={() => void query.refetch()}>
            {t('retry')}
          </button>
        </ErrorText>
      </section>
    );
  }
  if (!query.data || !query.data.available) return null;
  return <MoneyTilesView slug={slug} data={query.data} />;
}
