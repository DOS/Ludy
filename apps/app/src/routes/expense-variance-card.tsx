// SPDX-License-Identifier: AGPL-3.0-only
// The expense variance card on the Kế toán Tổng quan (#4392): for one ended month of the chosen legal entity, the expense lines that moved against the month before and against the average of the three months before
// it, with the suppliers or vouchers behind each. Every figure and every flag comes from the books (finance.expense_variance); the finance coworker's possible reason per line is read from the same read by the model
// and shown only when it came back, labelled as a possibility, so with AI off the table is the same and there is no gap and no notice. A person decides: nothing here writes.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { vietnamToday, type ExpenseVarianceCompare, type ExpenseVarianceContributor, type ExpenseVarianceLine, type FinanceExpenseVariance } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { changeKind, defaultMonth, monthText, pickerMonths, sizeOf } from '../lib/expense-variance.ts';
import { ErrorText } from '../components/ui.tsx';

const ARROW = { up: '▲', down: '▼', flat: '■' } as const;

// One comparison as text: its direction and size (the percent when there is one), or that it could not be made. A flagged one is marked in words as well as in weight.
function Change({ compare, label }: { compare: ExpenseVarianceCompare; label: string }) {
  const t = useTranslations('financeOverview.variance');
  const f = useFormat();
  const kind = changeKind(compare);
  if (kind === 'none') return <span className="text-xs text-subtle-foreground">{t('change.none')}</span>;
  if (kind === 'flat' || compare.change === null) return <span className="text-xs text-muted-foreground">{t('change.flat')}</span>;
  const amount = f.money(sizeOf(compare.change));
  const text = compare.percent === null ? t(`change.${kind}New`, { amount }) : t(`change.${kind}`, { amount, percent: f.decimal(compare.percent, 1) });
  return (
    <span className={cn('text-xs tabular-nums', compare.flagged ? 'font-semibold text-foreground' : 'text-muted-foreground')} data-flagged={compare.flagged}>
      <span aria-hidden="true">{ARROW[kind]} </span>
      <span className="sr-only">{label}: </span>
      {text}
      {compare.flagged && <span className="ml-1 text-warning">{t('change.over')}</span>}
    </span>
  );
}

function Contributor({ contributor }: { contributor: ExpenseVarianceContributor }) {
  const t = useTranslations('financeOverview.variance');
  const f = useFormat();
  const who =
    contributor.kind === 'supplier'
      ? contributor.name !== null
        ? t('contributors.supplier', { name: contributor.name })
        : t('contributors.supplierUnknown')
      : contributor.description
        ? t('contributors.voucher', { date: f.date(contributor.entryDate), description: contributor.description })
        : t('contributors.voucherNoText', { date: f.date(contributor.entryDate) });
  const kind = changeKind({ change: contributor.change });
  return (
    <li className="text-xs">
      <span className="text-foreground">{who}</span>
      <span className="text-subtle-foreground"> · {t(`sourceKind.${contributor.sourceKind}`)}</span>
      <span className="block tabular-nums text-muted-foreground">
        {t('contributors.figures', { amount: f.money(contributor.amount), basis: f.money(contributor.basis), count: contributor.vouchers })}
        {kind === 'up' || kind === 'down' ? ` · ${t(`contributors.${kind}`, { amount: f.money(sizeOf(contributor.change)) })}` : ''}
      </span>
    </li>
  );
}

function LineRow({ line, note }: { line: ExpenseVarianceLine; note: string | undefined }) {
  const t = useTranslations('financeOverview.variance');
  const f = useFormat();
  const kind = line.isNew ? 'new' : line.direction;
  return (
    <>
      <tr className="border-b align-top" data-testid={`variance-line-${line.code}`}>
        <th scope="row" className="py-3 pr-3 text-left text-sm font-medium">
          <span className="block text-foreground">{line.name ? `${line.code} ${line.name}` : line.code}</span>
          <span className={cn('mt-0.5 block text-xs font-normal', line.direction === 'up' ? 'text-destructive' : 'text-success')}>
            <span aria-hidden="true">{ARROW[line.direction]} </span>
            {t(`direction.${kind}`)}
          </span>
          {line.contributors.length > 0 && (
            <details className="mt-1 font-normal">
              <summary className="flex min-h-11 cursor-pointer items-center text-xs text-link md:min-h-8">{t('contributors.title')}</summary>
              <ul className="space-y-2 pb-2">
                {line.contributors.map((c) => (
                  <Contributor key={`${c.partyId ?? ''}${c.entryId ?? ''}`} contributor={c} />
                ))}
              </ul>
            </details>
          )}
        </th>
        <td className="px-2 py-3 text-right font-mono text-sm tabular-nums">{f.money(line.amount)}</td>
        <td className="px-2 py-3 text-right text-sm tabular-nums">
          {line.previous.basis === null ? (
            <span className="text-xs text-subtle-foreground">{t('change.none')}</span>
          ) : (
            <>
              {f.money(line.previous.basis)}
              <div>
                <Change compare={line.previous} label={t('columns.vsPrevious')} />
              </div>
            </>
          )}
        </td>
        <td className="px-2 py-3 text-right text-sm tabular-nums">
          {line.average.basis === null ? (
            <span className="text-xs text-subtle-foreground">{t('change.none')}</span>
          ) : (
            <>
              {f.money(line.average.basis)}
              <div>
                <Change compare={line.average} label={t('columns.vsAverage')} />
              </div>
            </>
          )}
        </td>
      </tr>
      {note && (
        <tr className="border-b" data-testid={`variance-note-${line.code}`}>
          <td colSpan={4} className="pb-3 pt-1 text-sm">
            <p className="text-xs font-medium text-muted-foreground">{t('note.by')}</p>
            <p className="mt-0.5 text-foreground">{note}</p>
            <p className="mt-0.5 text-xs text-subtle-foreground">{t('note.caution')}</p>
          </td>
        </tr>
      )}
    </>
  );
}

// The flagged lines of a read, with the coworker's notes by line code (none with AI off).
export function VarianceTable({ data, notes }: { data: FinanceExpenseVariance; notes: ReadonlyArray<{ code: string; text: string }> }) {
  const t = useTranslations('financeOverview.variance');
  const f = useFormat();
  const noteOf = (code: string) => notes.find((n) => n.code === code)?.text;
  return (
    <>
      <p className="mb-2 text-xs text-subtle-foreground">{t('books', { regime: t(`regimes.${data.regime}`) })}</p>
      {data.missing.previous && <p className="mb-2 text-xs text-warning">{t('missing.previous')}</p>}
      {data.missing.average && <p className="mb-2 text-xs text-warning">{t('missing.average')}</p>}
      {data.empty ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : data.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  {t('columns.line')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t('columns.amount')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t('columns.previous')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t('columns.average')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <LineRow key={line.code} line={line} note={noteOf(line.code)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.moreFlagged > 0 && <p className="mt-2 text-xs text-subtle-foreground">{t('more', { count: data.moreFlagged })}</p>}
      <p className="mt-3 text-xs text-subtle-foreground">{t('threshold', { amount: f.money(data.thresholds.amount), percent: f.decimal(data.thresholds.percent, 0) })}</p>
    </>
  );
}

// The coworker's notes: none at all unless they came back used, so with AI off the card has no gap and no notice. `version` is when the figures on screen were read: the notes are asked again whenever they are,
// so they never sit beside figures they were not written from (the server keeps them by their facts, so asking again over the same lines costs no model call).
function useNotes(input: { month: string; legalEntityId?: string }, enabled: boolean, version: number) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeExpenseVariance.explain.queryOptions({ input: { ...input, lang } });
  const explain = useQuery({ ...base, queryKey: [...base.queryKey, version], enabled, staleTime: Infinity, retry: false });
  return explain.data?.ai === 'used' ? explain.data.notes : [];
}

export function ExpenseVarianceCard({ legalEntityId, ready }: { legalEntityId?: string | undefined; ready: boolean }) {
  const t = useTranslations('financeOverview.variance');
  const today = vietnamToday();
  const [month, setMonth] = useState(() => defaultMonth(today));
  const input = { month, ...(legalEntityId ? { legalEntityId } : {}) };
  const read = useQuery({ ...orpc.financeExpenseVariance.get.queryOptions({ input }), enabled: ready });
  const data = read.data;
  const notes = useNotes(input, ready && data !== undefined && data.lines.length > 0, read.dataUpdatedAt);
  return (
    <section aria-labelledby="overview-variance" className="mt-8" data-testid="expense-variance">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="overview-variance" className="text-sm font-semibold">
            {t('title')}
          </h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-subtle-foreground">
          <span className="whitespace-nowrap">{t('month.label')}</span>
          <NativeSelect className="min-h-11 w-40 md:min-h-8" value={month} onChange={(e) => setMonth(e.target.value)}>
            {pickerMonths(today).map((m) => (
              <NativeSelectOption key={m} value={m}>
                {t('month.option', { month: m.slice(5), year: m.slice(0, 4) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <Card className="mt-3 p-4">
        {read.isError ? (
          <ErrorText>
            {errorMessage(read.error)}{' '}
            <button type="button" className="min-h-11 underline md:min-h-8" onClick={() => void read.refetch()}>
              {t('retry')}
            </button>
          </ErrorText>
        ) : !data ? (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            {t('loading')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-subtle-foreground">
              {t('compared', { month: monthText(data.month), previous: monthText(data.previousMonth), from: monthText(data.averageMonths[0] ?? data.previousMonth), to: monthText(data.averageMonths[2] ?? data.previousMonth) })}
            </p>
            <VarianceTable data={data} notes={notes} />
          </>
        )}
      </Card>
    </section>
  );
}
