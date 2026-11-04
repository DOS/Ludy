// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631), the first screen of the app: four cards (cash, profit before tax, receivables, payables) against the period before,
// a period picker, the last six months' results, the period's costs by account group, and one or two sentences from the finance coworker on what changed
// most. Every figure comes from the books (finance.overview); the sentence is read from the same figures by the model and hidden when there is no model, the
// AI budget is spent or its text was refused, so the cards and charts never wait for it.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import { OVERVIEW_RANGES, type FinanceOverview, type OverviewFigure, type OverviewRange } from '@crove/kernel-contract';
import { buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { cn } from '@crove/ui/lib/utils';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { CardSkeleton, Empty, ErrorText, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { OVERVIEW_CARDS, chartBars, chartHasData, directionOf, monthNumber, percentSize, toneOf, type Direction, type OverviewCard } from '../lib/finance-overview.ts';

const TONE_CLASS = { good: 'text-success', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;
const ARROW: Record<Direction, string> = { up: '▲', down: '▼', flat: '■' };

// What a card links to: the screen behind its figure.
function CardLink({ card, slug, label }: { card: OverviewCard; slug: string; label: string }) {
  const className = 'mt-auto text-xs text-link hover:underline';
  if (card === 'cash') return <Link to="/o/$slug/bank" params={{ slug }} className={className}>{label}</Link>;
  if (card === 'profit') return <Link to="/o/$slug/ledger" params={{ slug }} search={{ report: 'statements' }} className={className}>{label}</Link>;
  if (card === 'receivables') return <Link to="/o/$slug/customers" params={{ slug }} className={className}>{label}</Link>;
  return <Link to="/o/$slug/vendors" params={{ slug }} className={className}>{label}</Link>;
}

function FigureCard({ card, figure, slug }: { card: OverviewCard; figure: OverviewFigure; slug: string }) {
  const t = useTranslations('financeOverview');
  const f = useFormat();
  const direction = directionOf(figure);
  const percent = percentSize(figure);
  const tone = TONE_CLASS[toneOf(card, direction)];
  // The change in words: the size in percent of the period before, or the amount when the period before was 0.
  const change =
    direction === 'flat'
      ? t('change.flat')
      : percent !== null
        ? t(`change.${direction}`, { percent: f.decimal(percent, 1) })
        : t(`change.${direction}New`, { amount: f.money(figure.change.replace(/^-/, '')) });
  return (
    <Card className="flex h-full flex-col gap-1.5 p-4" data-testid={`overview-card-${card}`}>
      <span className="text-sm font-medium text-muted-foreground">{t(`cards.${card}.label`)}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">{f.money(figure.amount)}</span>
      <span className={cn('text-xs tabular-nums', tone)}>
        <span aria-hidden="true">{ARROW[direction]} </span>
        {change}
      </span>
      <span className="text-xs text-subtle-foreground">{t('before', { amount: f.money(figure.previous) })}</span>
      <CardLink card={card} slug={slug} label={t(`cards.${card}.open`)} />
    </Card>
  );
}

// A new org: every card is 0, so the screen points at the first steps instead of empty charts.
function FirstSteps({ slug }: { slug: string }) {
  const t = useTranslations('financeOverview');
  return (
    <Empty
      title={t('empty.title')}
      hint={t('empty.hint')}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Link to="/o/$slug/inbox" params={{ slug }} className={buttonVariants()}>
            {t('empty.upload')}
          </Link>
          <Link to="/o/$slug/bank" params={{ slug }} className={buttonVariants({ variant: 'outline' })}>
            {t('empty.statement')}
          </Link>
        </div>
      }
    />
  );
}

// Revenue and costs as two bars a month; the profit under each month. The figures are also in a table for a screen reader.
function ResultsChart({ months }: { months: FinanceOverview['months'] }) {
  const t = useTranslations('financeOverview');
  const f = useFormat();
  const bars = chartBars(months);
  return (
    <section aria-labelledby="overview-results" className="mt-8">
      <h2 id="overview-results" className="text-sm font-semibold">
        {t('results.title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('results.subtitle')}</p>
      <Card className="mt-3 p-4">
        {chartHasData(months) ? (
          <>
            <div className="mb-3 flex gap-4 text-xs text-muted-foreground" aria-hidden="true">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-primary" />
                {t('results.revenue')}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-muted-foreground/40" />
                {t('results.costs')}
              </span>
            </div>
            <div className="grid grid-cols-6 gap-2" aria-hidden="true">
              {bars.map((bar, i) => (
                <div key={bar.month} className="flex flex-col items-center gap-1.5">
                  <div className="flex h-32 w-full items-end justify-center gap-1">
                    <div className="w-1/3 rounded-t-sm bg-primary" style={{ height: `${bar.revenue}%` }} />
                    <div className="w-1/3 rounded-t-sm bg-muted-foreground/40" style={{ height: `${bar.costs}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground">{t('results.month', { month: String(monthNumber(bar.month)) })}</span>
                  <span className={cn('text-xs tabular-nums', bar.profitNegative ? 'text-destructive' : 'text-foreground')}>{f.money(months[i]?.profit ?? '0')}</span>
                </div>
              ))}
            </div>
            <table className="sr-only">
              <caption>{t('results.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('results.monthHead')}</th>
                  <th scope="col">{t('results.revenue')}</th>
                  <th scope="col">{t('results.costs')}</th>
                  <th scope="col">{t('results.profit')}</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">{t('results.month', { month: String(monthNumber(m.month)) })}</th>
                    <td>{f.money(m.revenue)}</td>
                    <td>{f.money(m.costs)}</td>
                    <td>{f.money(m.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('results.none')}</p>
        )}
      </Card>
    </section>
  );
}

function ExpenseMix({ expenses }: { expenses: FinanceOverview['expenses'] }) {
  const t = useTranslations('financeOverview');
  const f = useFormat();
  const shown = expenses.filter((e) => !/^-?0(\.0*)?$/.test(e.amount) && !e.amount.startsWith('-'));
  return (
    <section aria-labelledby="overview-expenses" className="mt-8">
      <h2 id="overview-expenses" className="text-sm font-semibold">
        {t('expenses.title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('expenses.subtitle')}</p>
      <Card className="mt-3 p-4">
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('expenses.none')}</p>
        ) : (
          <ul className="space-y-3">
            {shown.map((e) => (
              <li key={e.group}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-foreground">{t(`expenses.groups.${e.group}`)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {f.money(e.amount)} <span className="text-xs">({f.decimal(e.percent, 1)}%)</span>
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-muted" aria-hidden="true">
                  <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Number(e.percent))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

// The coworker's sentence: nothing at all unless it came back used, so with AI off the screen has no gap and no notice.
function Explanation({ input, ready }: { input: { range: OverviewRange; legalEntityId?: string }; ready: boolean }) {
  const t = useTranslations('financeOverview');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const explain = useQuery({
    ...orpc.financeOverview.explain.queryOptions({ input: { ...input, lang } }),
    enabled: ready,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (explain.data?.ai !== 'used' || !explain.data.text) return null;
  return (
    <Card className="mt-6 p-4" data-testid="overview-explanation">
      <p className="text-xs font-medium text-muted-foreground">{t('explain.title')}</p>
      <p className="mt-1 text-sm text-foreground">{explain.data.text}</p>
      <p className="mt-2 text-xs text-subtle-foreground">{t('explain.note')}</p>
    </Card>
  );
}

export function AccountingOverviewPage() {
  const t = useTranslations('financeOverview');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const entity = useChosenEntity();
  const [range, setRange] = useState<OverviewRange>('last_30_days');
  const input = { range, ...(entity.legalEntityId ? { legalEntityId: entity.legalEntityId } : {}) };
  const overview = useQuery({ ...orpc.financeOverview.get.queryOptions({ input }), enabled: entity.ready });
  const data = overview.data;

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <label className="flex items-center gap-2 text-xs text-subtle-foreground">
            <span className="whitespace-nowrap">{t('range.label')}</span>
            <NativeSelect className="w-44" value={range} onChange={(e) => setRange(e.target.value as OverviewRange)}>
              {OVERVIEW_RANGES.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {t(`range.${r}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        }
      />
      {overview.isError && (
        <ErrorText>
          {errorMessage(overview.error)}{' '}
          <button type="button" className="underline" onClick={() => void overview.refetch()}>
            {t('retry')}
          </button>
        </ErrorText>
      )}
      {!data && !overview.isError && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          {OVERVIEW_CARDS.map((card) => (
            <CardSkeleton key={card} />
          ))}
        </div>
      )}
      {data && (
        <>
          <p className="mb-3 text-xs text-subtle-foreground">{t('period', { from: f.date(data.from), to: f.date(data.to), previousFrom: f.date(data.previousFrom), previousTo: f.date(data.previousTo) })}</p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {OVERVIEW_CARDS.map((card) => (
              <li key={card}>
                <FigureCard card={card} figure={data[card]} slug={slug} />
              </li>
            ))}
          </ul>
          {data.unmapped > 0 && <p className="mt-3 text-xs text-warning">{t('unmapped', { count: data.unmapped })}</p>}
          {data.empty ? (
            <div className="mt-8">
              <FirstSteps slug={slug} />
            </div>
          ) : (
            <>
              <Explanation input={input} ready={entity.ready} />
              <ResultsChart months={data.months} />
              <ExpenseMix expenses={data.expenses} />
            </>
          )}
        </>
      )}
    </div>
  );
}
