// SPDX-License-Identifier: AGPL-3.0-only
// The 30/60/90-day cash forecast of the Kế toán app (#4391), a card on the Tổng quan: the booked cash of the chosen legal entity, the lowest balance the next 90 days are expected to reach and its day, the balance
// after 30, 60 and 90 days with what comes in and goes out, what the figures leave out, and the dates they are estimated from. Every figure comes from the books (finance.cash_forecast, decided by code); the coworker's
// note on the low point is read from the same figures by the model and hidden when there is no model, the AI budget is spent or its text was refused, so the figures, and the lowest balance among them, never wait for it.
// Nothing here is a promise or an advice: the card says it is a forecast.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { TAX_OBLIGATIONS, type CashForecast, type TaxObligation } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

const isNegative = (amount: string): boolean => amount.startsWith('-') && !/^-0(\.0+)?$/.test(amount);
const isObligation = (value: string): value is TaxObligation => (TAX_OBLIGATIONS as readonly string[]).includes(value);
const isZero = (amount: string): boolean => /^-?0(\.0+)?$/.test(amount);

// The coworker's note: nothing at all unless it came back used. `version` is when the figures on screen were read: the note is asked again whenever they are, so it never sits beside figures it was not written from
// (the server keeps a note by its facts, so asking again over unchanged figures costs no model call).
function Explanation({ legalEntityId, version }: { legalEntityId: string; version: number }) {
  const t = useTranslations('financeCashForecast');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeCashForecast.explain.queryOptions({ input: { legalEntityId, lang } });
  const explain = useQuery({ ...base, queryKey: [...base.queryKey, version], staleTime: Infinity, retry: false });
  if (explain.data?.ai !== 'used' || !explain.data.text) return null;
  return (
    <div className="mt-4 rounded-md bg-muted p-3" data-testid="cash-forecast-explanation">
      <p className="text-xs font-medium text-muted-foreground">{t('explain.title')}</p>
      <p className="mt-1 text-sm text-foreground">{explain.data.text}</p>
      <p className="mt-2 text-xs text-subtle-foreground">{t('explain.note')}</p>
    </div>
  );
}

export function CashForecastView({ data, version }: { data: CashForecast; version: number }) {
  const t = useTranslations('financeCashForecast');
  const obligations = useTranslations('taxCalendar.obligations');
  const f = useFormat();
  const negative = isNegative(data.low.balance);
  const left = data.notIncluded.map((key) => t(`notIncluded.${key}`)).join(', ');
  return (
    <section aria-labelledby="cash-forecast-title" className="mt-8" data-testid="cash-forecast">
      <h2 id="cash-forecast-title" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      <Card className="mt-3 p-4">
        <p className="text-sm text-muted-foreground">{t('opening', { date: f.date(data.asOf), amount: f.money(data.openingCash) })}</p>
        <p className={negative ? 'mt-1 text-base font-semibold text-destructive' : 'mt-1 text-base font-semibold text-foreground'} data-testid="cash-forecast-low">
          {t('low', { date: f.date(data.low.date), amount: f.money(data.low.balance) })}
        </p>
        {negative && (
          <p className="mt-1 text-xs text-destructive" role="status">
            {t('lowNegative')}
          </p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('table.after')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('table.balance')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('table.in')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('table.out')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.checkpoints.map((c) => (
                <tr key={c.days} className="border-t">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {t('table.days', { days: c.days })}
                    <span className="block text-xs text-subtle-foreground">{f.date(c.date)}</span>
                  </th>
                  <td className={isNegative(c.balance) ? 'py-1.5 pr-3 text-right font-medium tabular-nums text-destructive' : 'py-1.5 pr-3 text-right font-medium tabular-nums'}>{f.money(c.balance)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{f.money(c.receipts)}</td>
                  <td className="py-1.5 text-right tabular-nums">{f.money(c.payments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Explanation legalEntityId={data.legalEntityId} version={version} />
        <ul className="mt-4 space-y-1 text-xs text-subtle-foreground">
          <li>{t('estimates', { days: String(data.payableTermsDays) })}</li>
          {!isZero(data.overdueReceiptsNotCounted) && <li>{t('overdue', { amount: f.money(data.overdueReceiptsNotCounted) })}</li>}
          {!isZero(data.unlinkedReceivablesNotCounted) && <li>{t('unlinked', { amount: f.money(data.unlinkedReceivablesNotCounted) })}</li>}
          <li>{t('notIncluded.line', { items: left })}</li>
          {data.taxMarkers.length > 0 && (
            <li>
              {t('taxMarkers')}{' '}
              {data.taxMarkers.map((m) => `${f.date(m.dueDate)} ${isObligation(m.obligation) ? obligations(m.obligation) : m.obligation}`).join('; ')}
            </li>
          )}
          {data.truncated && (
            <li className="text-warning" role="status">
              {t('truncated')}
            </li>
          )}
        </ul>
      </Card>
    </section>
  );
}

// The card of the Tổng quan: the forecast of the chosen legal entity, read again with the screen.
export function CashForecastCard({ legalEntityId, ready }: { legalEntityId: string | undefined; ready: boolean }) {
  const t = useTranslations('financeCashForecast');
  const live = useStreamLive();
  const input = legalEntityId ? { legalEntityId } : {};
  const query = useQuery({ ...orpc.financeCashForecast.get.queryOptions({ input }), enabled: ready, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  if (query.isError) {
    return (
      <section className="mt-8">
        <ErrorText>
          {errorMessage(query.error)}{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            {t('retry')}
          </button>
        </ErrorText>
      </section>
    );
  }
  if (!query.data || query.data.empty) return null;
  return <CashForecastView data={query.data} version={query.dataUpdatedAt} />;
}
