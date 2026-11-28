// SPDX-License-Identifier: AGPL-3.0-only
// The answer card of "Hỏi đáp sổ sách" (#5181, #5338), rendered on its own with the API's answers: the two agings show the five buckets, what no invoice dates and the other side as figures of their own, the largest overdue
// parties and what the card leaves out; the two rankings show the total, the largest parties and say they count invoiced documents; every card links to the screen it names, in both languages, with no message key left bare.
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AskBooksAnswer, AskBooksCard, AskBooksEntry } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: true }) }));

const { AskBooksAnswerView } = await import('../src/components/ask-books-card.tsx');

const PERIOD: AskBooksCard['period'] = { kind: 'month', value: '2026-10', from: '2026-10-01', to: '2026-10-31', partial: false };

const AGING_FIGURES: AskBooksCard['figures'] = [
  { key: 'overdue', amount: '9000000' },
  { key: 'not_due', amount: '8000000' },
  { key: 'overdue_1_30', amount: '5000000' },
  { key: 'overdue_31_60', amount: '3000000' },
  { key: 'overdue_61_90', amount: '0' },
  { key: 'overdue_over_90', amount: '1000000' },
  { key: 'undated', amount: '2000000' },
  { key: 'advances', amount: '500000' },
];

function answerOf(entry: AskBooksEntry, extra: Partial<AskBooksCard>): AskBooksAnswer {
  const card: AskBooksCard = { entry, period: PERIOD, figures: [], top: [], partyCount: 0, notes: [], ...extra };
  return { ai: 'picked', state: 'card', lead: null, card, pick: null };
}

async function render(answer: AskBooksAnswer, locale: 'vi' | 'en'): Promise<string> {
  const root = createRootRoute({
    component: () => (
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <AskBooksAnswerView slug="demo" answer={answer} onPickPeriod={() => undefined} />
      </IntlProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

const hrefOf = (html: string) => /data-testid="ask-books-card"[\s\S]*<a [^>]*href="([^"]*)"/.exec(html)?.[1] ?? '';

describe('the aging cards', () => {
  const receivables = answerOf('receivables_aging', {
    figures: AGING_FIGURES,
    top: [
      { name: 'Công ty A', amount: '4000000' },
      { name: null, amount: '3000000' },
      { name: 'Công ty B', amount: '2000000' },
    ],
    partyCount: 7,
  });

  it('shows the five buckets, the undated part and the other side as figures of their own, in Vietnamese', async () => {
    const html = await render(receivables, 'vi');
    expect(html).toContain(viMessages.financeAskBooks.entry.receivables_aging);
    for (const key of ['overdue', 'not_due', 'overdue_1_30', 'overdue_31_60', 'overdue_61_90', 'overdue_over_90', 'undated', 'advances']) expect(html, key).toContain(`data-testid="ask-books-figure-${key}"`);
    expect(html).toContain(viMessages.financeAskBooks.figure.overdue_over_90);
    expect(html).toContain(viMessages.financeAskBooks.figure.undated);
    expect(html).toContain(viMessages.financeAskBooks.advances.receivables_aging);
    expect(html).toContain(viMessages.financeAskBooks.top.receivables_aging);
    expect(html).toContain('Công ty A');
    expect(html).toContain(viMessages.financeAskBooks.top.unnamed);
    // Seven parties are overdue and three are listed: the card says how many more.
    expect(html).toContain('và 4 bên khác');
    expect(html).not.toMatch(/financeAskBooks\./);
  });

  it('links the receivables to the customers and the payables to the suppliers, and says when due dates are estimated or a bound was hit', async () => {
    expect(hrefOf(await render(receivables, 'en'))).toBe('/o/demo/customers');
    const payables = answerOf('payables_aging', { figures: AGING_FIGURES, top: [{ name: 'Nhà cung cấp X', amount: '1000000' }], partyCount: 1, notes: ['estimated_due_dates', 'truncated'] });
    const html = await render(payables, 'en');
    expect(hrefOf(html)).toBe('/o/demo/vendors');
    expect(html).toContain(en.financeAskBooks.open.payables_aging);
    expect(html).toContain(en.financeAskBooks.advances.payables_aging);
    expect(html).toContain('A purchase invoice with no payment due date');
    expect(html).toContain('the largest balances and the newest invoices');
    expect(html).not.toContain('and 0 more');
  });
});

describe('the ranking cards', () => {
  const sales = answerOf('customers_top_sales', {
    figures: [{ key: 'total', amount: '90000000' }],
    top: [
      { name: 'Công ty A', amount: '40000000' },
      { name: 'Công ty B', amount: '25000000' },
    ],
    partyCount: 8,
  });

  it('shows the total of the period and the largest parties, and says it counts invoiced documents, in both languages', async () => {
    const viHtml = await render(sales, 'vi');
    expect(viHtml).toContain(viMessages.financeAskBooks.total.customers_top_sales);
    expect(viHtml).toContain(viMessages.financeAskBooks.top.customers_top_sales);
    expect(viHtml).toContain('Công ty B');
    expect(viHtml).toContain('và 6 bên khác');
    expect(viHtml).toContain('Chỉ tính các hóa đơn đã ghi vào sổ');
    expect(viHtml).not.toMatch(/financeAskBooks\./);
    const english = await render(sales, 'en');
    expect(english).toContain(en.financeAskBooks.total.customers_top_sales);
    expect(english).toContain('Only invoices recorded in the books count');
    expect(english).toContain('and 6 more');
    expect(english).not.toMatch(/financeAskBooks\./);
  });

  it('links the sales ranking to the sales invoices and the purchases ranking to the suppliers, and a card that is no ranking does not carry the invoiced note', async () => {
    expect(hrefOf(await render(sales, 'vi'))).toBe('/o/demo/sales-invoices');
    const purchases = answerOf('suppliers_top_purchases', { figures: [{ key: 'total', amount: '5000000' }], top: [{ name: 'Nhà cung cấp X', amount: '5000000' }], partyCount: 1 });
    const html = await render(purchases, 'en');
    expect(hrefOf(html)).toBe('/o/demo/vendors');
    expect(html).toContain(en.financeAskBooks.total.suppliers_top_purchases);
    expect(html).toContain(en.financeAskBooks.top.suppliers_top_purchases);
    const balance = await render(answerOf('receivables_top', { figures: [{ key: 'total', amount: '1000000' }], top: [{ name: 'Công ty A', amount: '1000000' }], partyCount: 1 }), 'en');
    expect(balance).not.toContain('Only invoices recorded in the books count');
    expect(balance).toContain(en.financeAskBooks.top.receivables_top);
  });
});

describe('the list of what can be asked', () => {
  it('names the four new reports when nothing fits, in both languages', async () => {
    const none: AskBooksAnswer = { ai: 'used', state: 'none', lead: null, card: null, pick: null };
    const viHtml = await render(none, 'vi');
    const english = await render(none, 'en');
    for (const entry of ['receivables_aging', 'payables_aging', 'customers_top_sales', 'suppliers_top_purchases'] as const) {
      expect(viHtml).toContain(viMessages.financeAskBooks.entry[entry]);
      expect(english).toContain(en.financeAskBooks.entry[entry]);
    }
  });
});
