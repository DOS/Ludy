// SPDX-License-Identifier: AGPL-3.0-only
// The three money tiles on Home (#4785), rendered on the server with the API's answer seeded in the cache: Chưa thu, Chưa trả and Tiền ngân hàng each a link to its list with
// the figure as the money formatter shows it, the bank accounts named under the bank figure, a negative balance said by its sign, and nothing drawn while the answer is on its way,
// for a member who may not see them, or while the Finance app is off.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceHomeMoney } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

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
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: { slug?: string }; children?: ReactNode } & Record<string, unknown>) => (
    <a href={to.replace('$slug', params?.slug ?? 'acme')} {...rest}>
      {children}
    </a>
  ),
}));

const { MoneyTiles, MoneyTilesView } = await import('../src/components/money-tiles.tsx');

type Available = Extract<FinanceHomeMoney, { available: true }>;
const DATA: Available = {
  available: true,
  asOf: '2026-11-25',
  receivables: '12500000',
  payables: '4200000.5',
  bank: '31000000',
  bankAccounts: [
    { code: '1122', name: 'ACB', balance: '20000000' },
    { code: '1121', name: 'Vietcombank', balance: '10000000' },
    { code: '1123', name: null, balance: '1000000' },
  ],
  bankAccountCount: 5,
};

function wrap(locale: 'vi' | 'en', client: QueryClient, node: ReactNode): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
const view = (data: Available, locale: 'vi' | 'en' = 'vi') => wrap(locale, new QueryClient(), <MoneyTilesView slug="acme" data={data} />);
const container = (answer: FinanceHomeMoney | undefined, financeOn = true, locale: 'vi' | 'en' = 'vi') => {
  const qc = new QueryClient();
  if (answer) qc.setQueryData(['financeHomeMoney', 'get'], answer);
  return wrap(locale, qc, <MoneyTiles slug="acme" financeOn={financeOn} />);
};

describe('MoneyTilesView', () => {
  it('shows the three tiles in Vietnamese, each a link to the list behind its figure', () => {
    const html = view(DATA);
    for (const label of ['Chưa thu', 'Chưa trả', 'Tiền ngân hàng']) expect(html).toContain(label);
    expect(html).toContain(viMessages.overview.money.receivables.label);
    expect(html).toMatch(/<a href="\/o\/acme\/customers"[^>]*data-testid="home-money-receivables"/);
    expect(html).toMatch(/<a href="\/o\/acme\/vendors"[^>]*data-testid="home-money-payables"/);
    expect(html).toMatch(/<a href="\/o\/acme\/bank"[^>]*data-testid="home-money-bank"/);
  });

  it('shows the figures through the money formatter, the decimal strings as sent', () => {
    const html = view(DATA);
    expect(html).toContain('12.500.000');
    expect(html).toContain('31.000.000');
    expect(html).toMatch(/4\.200\.000,5/);
  });

  it('names the three largest bank accounts under the bank figure and says how many more there are', () => {
    const html = view(DATA);
    expect(html).toContain('data-testid="home-money-bank-accounts"');
    expect(html).toContain('ACB: ');
    expect(html).toContain('Vietcombank: ');
    // An account the chart gives no name is shown by its code.
    expect(html).toContain('1123: ');
    expect(html).toContain('và 2 tài khoản khác');
    expect(html).toContain('5 tài khoản ngân hàng');
  });

  it('lists no accounts under the figure when the bank holds one account or none', () => {
    const one = view({ ...DATA, bankAccounts: [DATA.bankAccounts[0]!], bankAccountCount: 1 });
    expect(one).not.toContain('home-money-bank-accounts');
    expect(one).toContain('1 tài khoản ngân hàng');
    expect(view({ ...DATA, bank: '0', bankAccounts: [], bankAccountCount: 0 })).toContain('Chưa có số dư ngân hàng');
  });

  it('says a negative bank balance by its sign and marks it', () => {
    const html = view({ ...DATA, bank: '-1000000', bankAccounts: [], bankAccountCount: 1 });
    expect(html).toMatch(/text-destructive[^>]*>-1\.000\.000/);
    expect(view(DATA)).not.toMatch(/text-destructive[^>]*>31/);
  });

  it('is one section with a heading and a list of three tiles, each at least 44px high, readable in English too', () => {
    const html = view(DATA, 'en');
    expect(html).toContain('aria-labelledby="home-money-title"');
    expect(html).toContain(en.overview.money.title);
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html.match(/min-h-11/g)?.length).toBe(3);
    expect(html).toContain(en.overview.money.bank.label);
  });
});

describe('MoneyTiles', () => {
  it('draws the tiles once the books answered', () => {
    expect(container(DATA)).toContain('data-testid="home-money-tiles"');
  });

  it('draws nothing while the answer is on its way', () => {
    expect(container(undefined)).toBe('');
  });

  it('draws nothing for a member who may not see the org\'s money totals', () => {
    expect(container({ available: false })).toBe('');
  });

  it('draws nothing while the Finance app is off, even with an answer in the cache', () => {
    expect(container(DATA, false)).toBe('');
  });
});
