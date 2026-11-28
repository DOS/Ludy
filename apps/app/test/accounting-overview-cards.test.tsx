// SPDX-License-Identifier: AGPL-3.0-only
// The cards of Tổng quan (#3602): with no ledger data none is drawn (the first steps stand alone, which the Playwright spec checks), so the screen each card links to
// is checked here, on the card itself.
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceOverview } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { FigureCard, OverviewCards } = await import('../src/routes/accounting-overview.tsx');

const figure = { amount: '1500000', previous: '1000000', change: '500000', changePercent: '50.0' };
const overviewData: FinanceOverview = {
  range: 'this_month',
  from: '2026-05-01',
  to: '2026-05-31',
  previousFrom: '2026-04-01',
  previousTo: '2026-04-30',
  comparison: 'month',
  empty: false,
  cash: figure,
  profit: figure,
  receivables: figure,
  payables: figure,
  months: [
    { month: '2025-12', revenue: '0', costs: '0', profit: '0' },
    { month: '2026-01', revenue: '0', costs: '0', profit: '0' },
    { month: '2026-02', revenue: '0', costs: '0', profit: '0' },
    { month: '2026-03', revenue: '0', costs: '0', profit: '0' },
    { month: '2026-04', revenue: '0', costs: '0', profit: '0' },
    { month: '2026-05', revenue: '0', costs: '0', profit: '0' },
  ],
  expenses: [],
  unmapped: 0,
};

async function hrefOf(card: 'cash' | 'profit' | 'receivables' | 'payables'): Promise<string> {
  const root = createRootRoute({
    component: () => (
      <IntlProvider locale="vi" messages={catalog("vi")} timeZone="Asia/Ho_Chi_Minh">
        <FigureCard card={card} figure={figure} slug="demo" comparison="days" />
      </IntlProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  return /<a [^>]*href="([^"]*)"/.exec(html)?.[1] ?? '';
}

async function renderCards(locale: 'vi' | 'en', data: FinanceOverview): Promise<string> {
  const root = createRootRoute({
    component: () => (
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <OverviewCards data={data} slug="demo" />
      </IntlProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

describe('the cards of Tổng quan link to the screen behind their figure', () => {
  it.each([
    ['cash', '/o/demo/bank'],
    ['receivables', '/o/demo/customers'],
    ['payables', '/o/demo/vendors'],
  ] as const)('%s', async (card, path) => {
    expect(await hrefOf(card)).toBe(path);
  });
  it('profit opens the financial statements', async () => {
    expect(await hrefOf('profit')).toMatch(/^\/o\/demo\/ledger\?report=statements/);
  });
});

describe('mixedCharts note on the Tổng quan cards (#5214)', () => {
  it('shows a one-line note in Vietnamese and English when mixedCharts is true', async () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = await renderCards(locale, { ...overviewData, mixedCharts: true });
      expect(html).toContain('data-testid="overview-mixed-charts"');
      expect(html).toContain(catalog(locale).financeOverview.mixedCharts);
    }
  });

  it('hides the note when mixedCharts is false, absent, or the books are empty', async () => {
    for (const sample of [overviewData, { ...overviewData, mixedCharts: false }, { ...overviewData, empty: true, mixedCharts: true }]) {
      const html = await renderCards('vi', sample);
      expect(html).not.toContain('data-testid="overview-mixed-charts"');
    }
  });
});
