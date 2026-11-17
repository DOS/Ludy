// SPDX-License-Identifier: AGPL-3.0-only
// The cards of Tổng quan (#3602): with no ledger data none is drawn (the first steps stand alone, which the Playwright spec checks), so the screen each card links to
// is checked here, on the card itself.
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { FigureCard } = await import('../src/routes/accounting-overview.tsx');

const figure = { amount: '1500000', previous: '1000000', change: '500000', changePercent: '50.0' };

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
