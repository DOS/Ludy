// SPDX-License-Identifier: AGPL-3.0-only
// The books strip of the Ads screen (plan docs/plan/ads.md section 6, risk R6): per month, what the ad platform says was
// spent beside what the ledger holds on the advertising expense account, and the difference. Shown only where the finance
// module runs and the account has an expense account code, and compared directly only for an account in dong, since the
// books are in dong and Ads does no conversion. It reads the ledger and never writes it; a difference is shown as it is,
// never explained away. The Ads query and the Finance query are two calls composed here (plan section 7.1): the ads
// module reads no finance table. Beside each month, a count of the recorded purchase documents (invoices, receipts) that
// name the platform as seller (slice D1, from finance.documents.list), and for a month with spend and none, the words
// "no document yet" with the way to the Inbox. Counts only, never an amount, a tax figure or a document written. Under it,
// the bank and card lines that paid the platform (slice D2, ads-bank-lines.tsx).
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import type { AdAccountView } from '@crove/kernel-contract';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AdsBankLines } from './ads-bank-lines.tsx';
import { DataTable, TableSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { DOCUMENTS_LIST_LIMIT, AD_PLATFORM_SELLER_NAMES, booksDifference, booksExpense, booksMonths, documentCounts, documentsRange, errorCode } from '../lib/ads.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { monthLabel } from '../lib/period-lock.ts';

interface MonthSpend {
  month: string;
  spend: string;
}

// One row per month with spend. A failed read of the ledger (the account is not in the entity's chart, or the books could
// not be read) is said once, quietly, in place of the table: the page around it still works.
function BooksTable({
  account,
  slug,
  code,
  rows,
  todayMonth,
}: {
  account: Pick<AdAccountView, 'legalEntityId' | 'provider'>;
  slug: string;
  code: string;
  rows: readonly MonthSpend[];
  todayMonth: string;
}) {
  const t = useTranslations('ads');
  const f = useFormat();
  // The documents column needs names to look for; a platform the app has none for keeps the strip as it was.
  const range = AD_PLATFORM_SELLER_NAMES[account.provider] ? documentsRange(rows) : null;
  const documents = useQuery({
    ...orpc.documents.list.queryOptions({ input: { legalEntityId: account.legalEntityId, from: range?.from ?? '', to: range?.to ?? '' } }),
    enabled: range !== null,
    staleTime: 60_000,
  });
  const counts = documents.data ? documentCounts(documents.data, account.provider) : null;
  // A full page may have left older documents out, so nothing is called missing from it.
  const complete = documents.data !== undefined && documents.data.length < DOCUMENTS_LIST_LIMIT;
  const results = useQueries({
    queries: rows.map((row) => ({
      ...orpc.ledger.account.queryOptions({ input: { period: row.month, accountCode: code, legalEntityId: account.legalEntityId } }),
      staleTime: 60_000,
    })),
  });
  const failed = results.find((r) => r.error);
  if (failed) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {errorCode(failed.error) === 'UNKNOWN_ACCOUNT' ? t('books.unknownAccount', { code }) : t('books.failed', { reason: errorMessage(failed.error) })}
      </p>
    );
  }
  if (results.some((r) => r.isPending)) return <TableSkeleton columns={4} rows={Math.min(rows.length, 4)} />;
  const accountName = results.find((r) => r.data)?.data?.account.name;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('books.caption', { account: accountName ? `${code} ${accountName}` : code })}</p>
      <DataTable
        head={[t('columns.month'), t('books.platform'), t('books.inBooks'), t('books.difference'), ...(range ? [t('books.documents')] : [])]}
        numeric={[1, 2, 3]}
      >
        {rows.map((row, i) => {
          const ledger = results[i]?.data;
          if (!ledger) return null;
          const books = booksExpense(ledger);
          const difference = booksDifference(row.spend, books);
          return (
            <TableRow key={row.month}>
              <TableCell className="px-4 py-3 text-foreground">
                {monthLabel(row.month)}
                {row.month === todayMonth && <span className="ml-2 text-xs text-subtle-foreground">{t('books.monthOpen')}</span>}
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(row.spend, 'VND')}</TableCell>
              <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(books, 'VND')}</TableCell>
              <TableCell className={`px-4 py-3 text-right tabular-nums ${isZeroAmount(difference) ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>{f.money(difference, 'VND')}</TableCell>
              {range && (
                <TableCell className="px-4 py-3 text-foreground">
                  {documents.isPending ? (
                    <span className="text-muted-foreground">{t('books.documentsChecking')}</span>
                  ) : counts === null || !complete ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (counts.get(row.month) ?? 0) > 0 ? (
                    t('books.documentCount', { count: counts.get(row.month) ?? 0 })
                  ) : (
                    <span className="space-x-2">
                      <span className="font-medium">{t('books.documentMissing')}</span>
                      <Link to="/o/$slug/inbox" params={{ slug }} className="text-link underline">
                        {t('books.documentUpload')}
                      </Link>
                    </span>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </DataTable>
      <p className="text-xs text-subtle-foreground">{t('books.differenceHint')}</p>
      {range && documents.error && (
        <p className="text-xs text-muted-foreground" role="status">
          {t('books.documentsFailed', { reason: errorMessage(documents.error) })}
        </p>
      )}
      {range && documents.data && !complete && (
        <p className="text-xs text-muted-foreground" role="status">
          {t('books.documentsTooMany')}
        </p>
      )}
      {range && complete && <p className="text-xs text-subtle-foreground">{t('books.documentsHint')}</p>}
    </div>
  );
}

export function AdsBooksStrip({
  account,
  slug,
  months,
  todayMonth,
  financeOn,
  shellEntityId,
}: {
  account: Pick<AdAccountView, 'currency' | 'expenseAccountCode' | 'legalEntityId' | 'provider'>;
  // The legal entity chosen in the shell (the bank screen opens on it).
  shellEntityId: string | undefined;
  // The org's address, for the way to the Inbox.
  slug: string;
  months: readonly MonthSpend[];
  // The month the account's own calendar is in, which is still open.
  todayMonth: string;
  financeOn: boolean;
}) {
  const t = useTranslations('ads');
  const headingId = useId();
  if (!financeOn) return null;
  const code = account.expenseAccountCode;
  const rows = booksMonths(months);
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        {t('books.title')}
      </h2>
      {code === null ? (
        <p className="text-sm text-muted-foreground">{t('books.noCode')}</p>
      ) : account.currency !== 'VND' ? (
        <p className="text-sm text-muted-foreground">{t('books.notVnd', { currency: account.currency ?? '' })}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('books.noMonths')}</p>
      ) : (
        <BooksTable account={account} slug={slug} code={code} rows={rows} todayMonth={todayMonth} />
      )}
      {code !== null && rows.length > 0 && <AdsBankLines account={account} slug={slug} rows={rows} shellEntityId={shellEntityId} />}
    </section>
  );
}
