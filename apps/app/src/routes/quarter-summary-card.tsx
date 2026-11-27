// SPDX-License-Identifier: AGPL-3.0-only
// The quarter in plain words, on the Kế toán Tổng quan (#5183): for one quarter that has ended of the chosen legal entity, the figures a small business owner asks for (revenue, costs and profit, cash, receivables and
// payables, VAT or the household's tax, stock) against the previous quarter and the same quarter last year. Every figure and every label comes from the books (finance.quarter_summary); the finance coworker's three
// to five sentences are read from the same figures and shown only when they came back, each beside the name of its row, so with AI off the card is the same without them, with no gap and no notice. A person
// decides: nothing here writes.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { vietnamToday, type FinanceQuarterSummary, type QuarterSummaryFigure, type QuarterSummaryRow, type QuarterTrend } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { TREND_ARROW, defaultQuarter, hasComparison, pickerQuarters, quarterParts } from '../lib/quarter-summary.ts';
import { ErrorText } from '../components/ui.tsx';

// How a figure moved against one basis, in words as well as a mark (never colour alone).
function Trend({ label, basis }: { label: QuarterTrend; basis: string }) {
  const t = useTranslations('financeOverview.quarter');
  if (label === 'none') return <span className="text-xs text-subtle-foreground">{t('trend.none')}</span>;
  return (
    <span className={cn('text-xs', label === 'steady' ? 'text-muted-foreground' : 'font-semibold text-foreground')} data-trend={label}>
      <span aria-hidden="true">{TREND_ARROW[label]} </span>
      <span className="sr-only">{basis}: </span>
      {t(`trend.${label}`)}
    </span>
  );
}

function FigureRow({ figure, data, noted }: { figure: QuarterSummaryFigure; data: FinanceQuarterSummary; noted: boolean }) {
  const t = useTranslations('financeOverview.quarter');
  const f = useFormat();
  const row = figure.key;
  const cell = (value: string | null, label: QuarterTrend, basis: string) =>
    value === null ? (
      <span className="text-xs text-subtle-foreground">{t('trend.none')}</span>
    ) : (
      <>
        {f.money(value)}
        <div>
          <Trend label={label} basis={basis} />
        </div>
      </>
    );
  return (
    <tr className="border-b align-top" data-testid={`quarter-row-${row}`} data-has-note={noted} aria-describedby={noted ? `quarter-note-${row}` : undefined}>
      <th scope="row" className="py-3 pr-3 text-left text-sm font-medium">
        <span className="block text-foreground">
          {noted && <span aria-hidden="true">◆ </span>}
          {t(`rows.${row}`)}
        </span>
        {row === 'cash' && figure.previous !== null && <span className="mt-0.5 block text-xs font-normal text-subtle-foreground">{t('cashStart', { amount: f.money(figure.previous) })}</span>}
        {row === 'stock' && data.stockProvisional === true && <span className="mt-0.5 block text-xs font-normal text-warning">{t('stockProvisional')}</span>}
      </th>
      <td className="px-2 py-3 text-right font-mono text-sm tabular-nums">{f.money(figure.amount)}</td>
      <td className="px-2 py-3 text-right text-sm tabular-nums">{cell(figure.previous, figure.vsPrevious, t('columns.previous'))}</td>
      <td className="px-2 py-3 text-right text-sm tabular-nums">{row === 'stock' ? <span className="text-xs text-subtle-foreground">{t('stockNoLastYear')}</span> : cell(figure.lastYear, figure.vsLastYear, t('columns.lastYear'))}</td>
    </tr>
  );
}

// The state lines: the period lock and, for a company, the VAT return, shown whatever they are.
function StateLines({ data }: { data: FinanceQuarterSummary }) {
  const t = useTranslations('financeOverview.quarter');
  const f = useFormat();
  return (
    <ul className="mb-3 space-y-0.5 text-xs text-subtle-foreground" data-testid="quarter-state">
      <li>{data.lock.state === 'open' ? t('lock.open') : data.lock.state === 'partly' ? t('lock.partly', { date: f.date(data.lock.lockedThrough ?? data.to) }) : t('lock.locked')}</li>
      {data.vat && <li>{data.vat.filed ? t('vat.filed') : t('vat.notFiled')}</li>}
    </ul>
  );
}

// Whether a decimal string is exactly zero, read without turning it into a JS number.
const money0 = (value: string): boolean => /^-?0+(\.0+)?$/.test(value);

// The oldest overdue sales invoice, the VAT working and the household's tax: facts of the books, in fixed words.
function Facts({ data }: { data: FinanceQuarterSummary }) {
  const t = useTranslations('financeOverview.quarter');
  const f = useFormat();
  const tax = data.householdTax;
  return (
    <dl className="mt-3 space-y-2 text-sm" data-testid="quarter-facts">
      <div>
        <dt className="text-xs font-medium text-muted-foreground">{t('overdue.title')}</dt>
        <dd className="text-foreground">
          {data.overdue.count === 0 || data.overdue.oldestDueOn === null ? t('overdue.none') : t('overdue.some', { date: f.date(data.overdue.oldestDueOn), count: data.overdue.count, amount: f.money(data.overdue.amount) })}
          {data.overdue.truncated && <span className="block text-xs text-subtle-foreground">{t('overdue.truncated')}</span>}
        </dd>
      </div>
      {data.vat && (
        <div>
          <dt className="text-xs font-medium text-muted-foreground">{t('vat.title')}</dt>
          <dd className="text-foreground">
            {t('vat.figures', { output: f.money(data.vat.output), input: f.money(data.vat.input), difference: f.money(data.vat.difference) })}
            <span className="block text-xs text-subtle-foreground">{t('vat.caution')}</span>
          </dd>
        </div>
      )}
      {tax && (
        <div>
          <dt className="text-xs font-medium text-muted-foreground">{t('tax.title')}</dt>
          <dd className="text-foreground">
            {tax.state === 'ready' && tax.tax !== null ? t('tax.ready', { tax: f.money(tax.tax) }) : tax.state === 'held' ? t('tax.held') : t('tax.notRequired')}
            {tax.state === 'ready' && tax.due !== null && tax.overpaid !== null && (
              <span className="block text-xs text-subtle-foreground">{!money0(tax.due) ? t('tax.due', { amount: f.money(tax.due) }) : !money0(tax.overpaid) ? t('tax.overpaid', { amount: f.money(tax.overpaid) }) : t('tax.settled')}</span>
            )}
            {tax.commentary && <span className="block text-xs text-warning">{t('tax.commentary')}</span>}
          </dd>
        </div>
      )}
    </dl>
  );
}

// The figures of a read, with the coworker's sentences by row (none with AI off).
export function QuarterSummaryTable({ data, notes }: { data: FinanceQuarterSummary; notes: ReadonlyArray<{ row: QuarterSummaryRow; text: string }> }) {
  const t = useTranslations('financeOverview.quarter');
  const f = useFormat();
  const noted = new Set(notes.map((n) => n.row));
  const named = (key: 'previous' | 'lastYear', quarter: string | null) => (quarter === null ? t(`columns.${key}`) : t(`columns.${key}Named`, { quarter: t('quarterName', quarterParts(quarter)) }));
  return (
    <>
      <p className="mb-2 text-xs text-subtle-foreground">{t('books', { regime: t(`regimes.${data.regime}`), kind: t(`kinds.${data.kind}`) })}</p>
      <StateLines data={data} />
      {notes.length > 0 && (
        <div className="mb-4 rounded-md border bg-muted/40 p-3" data-testid="quarter-notes">
          <p className="text-xs font-medium text-muted-foreground">{t('notes.by')}</p>
          <ul className="mt-1 space-y-1.5">
            {notes.map((n) => (
              <li key={n.row} id={`quarter-note-${n.row}`} className="text-sm" data-testid={`quarter-note-${n.row}`}>
                <span className="font-medium text-foreground">{`${t(`rows.${n.row}`)}: `}</span>
                {n.text}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-subtle-foreground">{t('notes.caution')}</p>
        </div>
      )}
      {data.empty ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        // The table scrolls sideways on a phone and holds nothing a keyboard can focus, so the scroller itself is focusable and named (axe: scrollable-region-focusable).
        <div role="region" tabIndex={0} aria-label={t('title')} className="w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  {t('columns.figure')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t('columns.amount')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {named('previous', data.previousQuarter)}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {named('lastYear', data.lastYearQuarter)}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.figures.map((figure) => (
                <FigureRow key={figure.key} figure={figure} data={data} noted={noted.has(figure.key)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.partialBasis && !data.empty && (
        <p className="mt-2 text-xs text-warning" data-testid="quarter-partial">
          {t('partial', { date: f.date(data.booksStart ?? data.from) })}
        </p>
      )}
      {data.includesUnmapped && (
        <p className="mt-2 text-xs text-warning" data-testid="quarter-unmapped">
          {t('unmapped')}
        </p>
      )}
      {!data.empty && data.figures.some((x) => x.key === 'stock') && <p className="mt-2 text-xs text-subtle-foreground">{t('stockBasis')}</p>}
      {!data.empty && <Facts data={data} />}
      <p className="mt-3 text-xs text-subtle-foreground">{t('steady', { percent: f.decimal(data.steadyPercent, 0) })}</p>
    </>
  );
}

// The coworker's sentences: none at all unless they came back used, so with AI off the card has no gap and no notice. `version` is when the figures on screen were read: the sentences are asked again whenever they
// are, so they never sit beside figures they were not written from (the server keeps them by their labels, so asking again over the same labels costs no model call).
function useNotes(input: { quarter: string; legalEntityId?: string }, enabled: boolean, version: number) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeQuarterSummary.explain.queryOptions({ input: { ...input, lang } });
  const explain = useQuery({ ...base, queryKey: [...base.queryKey, version], enabled, staleTime: Infinity, retry: false });
  return explain.data?.ai === 'used' ? explain.data.notes : [];
}

export function QuarterSummaryCard({ legalEntityId, ready }: { legalEntityId?: string | undefined; ready: boolean }) {
  const t = useTranslations('financeOverview.quarter');
  const today = vietnamToday();
  const [quarter, setQuarter] = useState(() => defaultQuarter(today));
  const input = { quarter, ...(legalEntityId ? { legalEntityId } : {}) };
  const read = useQuery({ ...orpc.financeQuarterSummary.get.queryOptions({ input }), enabled: ready });
  const data = read.data;
  const notes = useNotes(input, ready && data !== undefined && !data.empty && data.figures.some(hasComparison), read.dataUpdatedAt);
  return (
    <section aria-labelledby="overview-quarter" className="mt-8" data-testid="quarter-summary">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="overview-quarter" className="text-sm font-semibold">
            {t('title')}
          </h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-subtle-foreground">
          <span className="whitespace-nowrap">{t('quarter.label')}</span>
          <NativeSelect className="min-h-11 w-44 md:min-h-8" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
            {pickerQuarters(today).map((value) => (
              <NativeSelectOption key={value} value={value}>
                {t('quarterName', quarterParts(value))}
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
          <QuarterSummaryTable data={data} notes={notes} />
        )}
      </Card>
    </section>
  );
}
