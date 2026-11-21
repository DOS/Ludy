// SPDX-License-Identifier: AGPL-3.0-only
// The bank and card lines that paid the ad platform, under the books strip of the Ads screen (plan docs/plan/ads.md section 6,
// slice D2): per month with spend, the statement lines of the legal entity's accounts whose description names the platform
// (the same names as the seller of its invoices, AD_PLATFORM_SELLER_NAMES), each with its date, account and amount and a link to
// the bank screen, and their total beside what the platform reports. Composed in the app from the Ads query and the Finance
// query finance.bank.platform_lines (plan section 7.1): the ads module reads no finance table. A foreign-currency account lists the
// lines and their total in dong without putting the two figures side by side, since the rate and the card's fee make them
// differ. It only reads: nothing is categorized, matched or posted from here, and no document is matched to a line.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import type { AdAccountView } from '@ludy/kernel-contract';
import { BANK_PLATFORM_LINES_LIMIT } from '@ludy/kernel-contract';
import { Skeleton } from '@ludy/ui/components/skeleton';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { AD_PLATFORM_SELLER_NAMES, bankLineSearch, bankLinesByMonth, documentsRange } from '../lib/ads.ts';
import { monthLabel } from '../lib/period-lock.ts';

interface MonthSpend {
  month: string;
  spend: string;
}

export function AdsBankLines({
  account,
  slug,
  rows,
  shellEntityId,
}: {
  account: Pick<AdAccountView, 'currency' | 'legalEntityId' | 'provider'>;
  slug: string;
  rows: readonly MonthSpend[];
  // The legal entity the shell has chosen: the bank screen opens on it, so a line is a link only when it is the account's own.
  shellEntityId: string | undefined;
}) {
  const t = useTranslations('ads');
  const f = useFormat();
  const headingId = useId();
  const terms = AD_PLATFORM_SELLER_NAMES[account.provider];
  const range = terms ? documentsRange(rows) : null;
  const lines = useQuery({
    ...orpc.bank.platformLines.queryOptions({ input: { legalEntityId: account.legalEntityId, from: range?.from ?? '', to: range?.to ?? '', terms: [...(terms ?? [])] } }),
    enabled: range !== null,
    staleTime: 60_000,
  });
  if (!range) return null;
  const inDong = account.currency === 'VND';
  const canOpen = shellEntityId === account.legalEntityId;
  // A full page may have left lines out, so no month is called empty from it.
  const truncated = lines.data !== undefined && lines.data.truncated;
  const months = lines.data ? new Map(bankLinesByMonth(lines.data.lines, account.provider).map((m) => [m.month, m])) : null;
  return (
    <div role="group" aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-medium text-foreground">
        {t('bankLines.title')}
      </h3>
      {lines.error ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('bankLines.failed', { reason: errorMessage(lines.error) })}
        </p>
      ) : !months ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t('bankLines.checking')}</span>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{inDong ? t('bankLines.caption') : t('bankLines.captionForeign', { currency: account.currency ?? '' })}</p>
          <ul className="space-y-2">
            {rows.map((row) => {
              const month = months.get(row.month);
              return (
                <li key={row.month} className="text-sm text-foreground">
                  {!month ? (
                    <p>
                      <span className="font-medium">{monthLabel(row.month)}</span>
                      <span className="ml-2 text-muted-foreground">{truncated ? '-' : t('bankLines.none')}</span>
                    </p>
                  ) : (
                    <details>
                      <summary className="cursor-pointer">
                        <span className="font-medium">{monthLabel(row.month)}</span>
                        <span className="ml-2 text-muted-foreground">
                          {truncated
                            ? t('bankLines.summaryPartial', { count: month.lines.length, paid: f.money(month.paid, 'VND') })
                            : t('bankLines.summary', { count: month.lines.length, paid: f.money(month.paid, 'VND') })}
                          {inDong && !truncated && ` ${t('bankLines.platform', { spend: f.money(row.spend, 'VND') })}`}
                        </span>
                      </summary>
                      <ul className="mt-2 space-y-1 border-l pl-4">
                        {month.lines.map((line) => (
                          <li key={line.id} className="flex flex-wrap items-baseline gap-x-3">
                            <span className="tabular-nums text-muted-foreground">{f.date(line.date)}</span>
                            <span className="text-muted-foreground">{line.bankAccount}</span>
                            {canOpen ? (
                              <Link to="/o/$slug/bank" params={{ slug }} search={bankLineSearch(line)} className="text-link underline">
                                {line.description}
                              </Link>
                            ) : (
                              <span>{line.description}</span>
                            )}
                            <span className="ml-auto tabular-nums">{f.money(line.amount, 'VND')}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
          {!inDong && <p className="text-xs text-muted-foreground">{t('bankLines.foreignNote', { currency: account.currency ?? '' })}</p>}
          {!canOpen && months.size > 0 && <p className="text-xs text-muted-foreground">{t('bankLines.otherEntity')}</p>}
          {truncated && (
            <p className="text-xs text-muted-foreground" role="status">
              {t('bankLines.tooMany', { count: BANK_PLATFORM_LINES_LIMIT })}
            </p>
          )}
          {!truncated && <p className="text-xs text-subtle-foreground">{t('bankLines.hint')}</p>}
        </>
      )}
    </div>
  );
}
