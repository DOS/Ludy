// SPDX-License-Identifier: AGPL-3.0-only
// The cash forecast card of the Tổng quan (#4391), rendered on the server with the API's answers seeded in the cache: the lowest balance is on the card with or without the coworker's note, the three checkpoints
// are a table with row headers, what the figures leave out and estimate is always said, a negative low point is said in words as well as colour, and the note shows only when it came back used.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { CashForecast, CashForecastExplanation } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => {
  // orpc.<a>.<b>.queryOptions() gives the path as its key; nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), errorMessage: (e: unknown) => String(e) };
});

const { CashForecastView } = await import('../src/components/cash-forecast-card.tsx');

const day = (n: number) => new Date(Date.UTC(2026, 11, 1 + n)).toISOString().slice(0, 10);
const FORECAST: CashForecast = {
  legalEntityId: '0192f0aa-1111-7222-8333-944445555777',
  asOf: '2026-12-01',
  openingCash: '10000000',
  empty: false,
  series: Array.from({ length: 91 }, (_, i) => ({ date: day(i), balance: '10000000' })),
  checkpoints: [
    { days: 30, date: day(30), balance: '4000000', receipts: '9000000', payments: '15000000' },
    { days: 60, date: day(60), balance: '6000000', receipts: '14000000', payments: '18000000' },
    { days: 90, date: day(90), balance: '7000000', receipts: '20000000', payments: '23000000' },
  ],
  low: { date: '2026-12-18', balance: '2500000' },
  topItems: [],
  overdueReceiptsNotCounted: '4000000',
  unlinkedReceivablesNotCounted: '0',
  payableTermsDays: 30,
  notIncluded: ['payroll', 'insurance', 'tax', 'rent', 'loans', 'recurring'],
  taxMarkers: [{ obligation: 'vat_return', period: '2026-11', dueDate: '2026-12-20' }],
  truncated: false,
};

function card(data: CashForecast, note: CashForecastExplanation | null = null, locale: 'vi' | 'en' = 'en'): string {
  const qc = new QueryClient();
  if (note) qc.setQueryData(['financeCashForecast', 'explain', 7], note);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <CashForecastView data={data} version={7} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('CashForecastView', () => {
  it('shows the lowest balance and its day, the opening cash and a table of the three checkpoints with row headers', () => {
    const html = card(FORECAST);
    expect(html).toContain(en.financeCashForecast.title);
    expect(html).toContain('data-testid="cash-forecast-low"');
    expect(html).toMatch(/Lowest expected balance: .*2,500,000.* on /);
    expect(html).toMatch(/Cash in the books on .*10,000,000/);
    expect(html.match(/<th scope="row"/g)).toHaveLength(3);
    expect(html).toContain('<th scope="col"');
    expect(html).toContain('<caption class="sr-only">');
    for (const days of ['30 days', '60 days', '90 days']) expect(html).toContain(days);
  });

  it('shows no note when none came back, and the note once it came back used (the low point is there either way)', () => {
    expect(card(FORECAST)).not.toContain('cash-forecast-explanation');
    expect(card(FORECAST, { ai: 'off', text: null })).not.toContain('cash-forecast-explanation');
    expect(card(FORECAST, { ai: 'failed', text: null })).not.toContain('cash-forecast-explanation');
    expect(card(FORECAST, { ai: 'budget', text: null })).toContain('cash-forecast-low');
    const used = card(FORECAST, { ai: 'used', text: 'The lowest balance is expected on 2026-12-18.' });
    expect(used).toContain('data-testid="cash-forecast-explanation"');
    expect(used).toContain('The lowest balance is expected on 2026-12-18.');
  });

  it('always says what it leaves out and what it estimates, and lists the tax dates without an amount', () => {
    const html = card(FORECAST);
    expect(html).toContain('Not in these figures: payroll, social insurance, tax payments, rent, loans, other recurring costs.');
    expect(html).toContain('30 days after the invoice date');
    expect(html).toContain('These dates are estimates.');
    expect(html).toMatch(/Tax due dates in this period \(no amount is counted\):.*VAT return/);
    expect(html).toMatch(/4,000,000.* of sales invoices are already past their due date/);
  });

  it('says a low point below zero in words as well as colour, and a partial forecast', () => {
    const html = card({ ...FORECAST, low: { date: day(5), balance: '-300000' }, truncated: true });
    expect(html).toContain('The balance is expected to go below zero.');
    expect(html).toContain('role="status"');
    expect(html).toContain('text-destructive');
    expect(html).toContain('The books hold more customers or invoices than one forecast reads');
    expect(card(FORECAST)).not.toContain('go below zero');
    expect(card(FORECAST)).not.toContain('more customers or invoices');
  });

  it('draws no line for an overdue or unlinked amount of zero, and no tax list without a marker', () => {
    const html = card({ ...FORECAST, overdueReceiptsNotCounted: '0', taxMarkers: [] });
    expect(html).not.toContain('already past their due date');
    expect(html).not.toContain('Tax due dates in this period');
  });

  it('keeps the Vietnamese and English texts in step and writes the Vietnamese card', () => {
    expect(Object.keys(viMessages.financeCashForecast).sort()).toEqual(Object.keys(en.financeCashForecast).sort());
    expect(Object.keys(viMessages.financeCashForecast.notIncluded).sort()).toEqual(Object.keys(en.financeCashForecast.notIncluded).sort());
    const html = card(FORECAST, null, 'vi');
    expect(html).toContain(viMessages.financeCashForecast.title);
    expect(html).toContain('Chưa có trong các con số này: lương, bảo hiểm xã hội, thuế phải nộp, tiền thuê, khoản vay, chi phí định kỳ khác.');
    expect(html).toContain('Số dư thấp nhất dự kiến');
  });
});
