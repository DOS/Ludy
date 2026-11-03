// SPDX-License-Identifier: AGPL-3.0-only
// The panels of the Reports screen (#2435), rendered on the server with each read answered from a seeded cache: the figures
// and where they link, and the states a fresh or partial org has (an empty board, no post, an ad account with no figures yet,
// a total the earlier period lacks), none of which may break the page.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { activeLocale, catalog } from '../src/i18n/runtime.ts';
import { adsRange } from '../src/lib/ads.ts';
import { formatMoney, formatNumber } from '../src/lib/format.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (o?: { input?: unknown }) => ({ queryKey: [...path, o?.input ?? null], queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return { Link: ({ to, children }: { to: string; children?: import('react').ReactNode }) => createElement('a', { href: to }, children) };
});

const { AdsPanel, ConversationsPanel, PostsPanel, SalesPanel } = await import('../src/components/report-panels.tsx');

function render(ui: import('react').ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="vi" messages={catalog('vi')}>
        {ui}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const stage = (id: string, name: string, kind: 'open' | 'won' | 'lost', position: number) => ({ id, name, kind, position });
const T = viMessages.reports;

describe('the report panels', () => {
  beforeEach(() => client.current.clear());

  it('shows the conversations by state and links to them', () => {
    client.current.setQueryData(['conversations', 'counts', {}], { new: 3, pending: 2, resolved: 10, unread: 1 });
    const html = render(<ConversationsPanel slug="acme" />);
    for (const label of [T.conversations.new, T.conversations.pending, T.conversations.resolved, T.conversations.unread]) expect(html, label).toContain(label);
    for (const n of ['3', '2', '10', '1']) expect(html, n).toContain(`>${n}<`);
    expect(html).toContain('href="/o/$slug/social/inbox"');
  });

  it('says there is no deal yet for a board with no stage or no card, instead of a table of zeros', () => {
    client.current.setQueryData(['crm', 'deals', 'board', {}], { columns: [] });
    expect(render(<SalesPanel slug="acme" />)).toContain(T.sales.empty);
    client.current.setQueryData(['crm', 'deals', 'board', {}], { columns: [{ stage: stage('s1', 'Mới', 'open', 1), count: 0, total: '0', cards: [], truncated: false }] });
    expect(render(<SalesPanel slug="acme" />)).toContain(T.sales.empty);
  });

  it('sums the open, won and lost stages as decimals and lists each stage with its numbers right-aligned', () => {
    client.current.setQueryData(['crm', 'deals', 'board', {}], {
      columns: [
        { stage: stage('s1', 'Mới', 'open', 1), count: 2, total: '1000000.10', cards: [], truncated: false },
        { stage: stage('s2', 'Báo giá', 'open', 2), count: 1, total: '500000.20', cards: [], truncated: false },
        { stage: stage('s3', 'Thắng', 'won', 3), count: 1, total: '250000', cards: [], truncated: false },
        { stage: stage('s4', 'Thua', 'lost', 4), count: 0, total: '0', cards: [], truncated: false },
      ],
    });
    const html = render(<SalesPanel slug="acme" />);
    expect(html).not.toContain(T.sales.empty);
    for (const name of ['Mới', 'Báo giá', 'Thắng', 'Thua']) expect(html, name).toContain(name);
    expect(html).toContain(formatMoney('1500000.3', activeLocale()));
    expect(html).toContain(formatMoney('250000', activeLocale()));
    expect(html).toContain('text-right');
    expect(html).toContain('href="/o/$slug/deals"');
  });

  it('shows the posts of the last 30 days, and a period before with no figure for a metric does not break it', () => {
    client.current.setQueryData(['social', 'metrics', 'totals', { days: 30 }], { posts: 0, metrics: {}, previous: { posts: 0, metrics: {} } });
    expect(render(<PostsPanel slug="acme" />)).toContain(T.posts.empty);
    client.current.setQueryData(['social', 'metrics', 'totals', { days: 30 }], { posts: 4, metrics: { reach: 1200 }, previous: { posts: 0, metrics: {} } });
    const html = render(<PostsPanel slug="acme" />);
    expect(html).not.toContain(T.posts.empty);
    expect(html).toContain(formatNumber(1200, activeLocale()));
    expect(html).toContain('href="/o/$slug/social"');
  });

  it('lists the ad accounts, one with no figures yet, one with its month, with no result kind chosen', () => {
    const base = { connectionId: 'c', connectionStatus: 'active', provider: 'sandbox', resultKind: null };
    const range = adsRange('thisMonth', 'Asia/Ho_Chi_Minh', new Date());
    client.current.setQueryData(['ads', 'accounts', null], [
      { ...base, id: 'a1', name: 'Tài khoản mới', currency: null, timeZone: null },
      { ...base, id: 'a2', name: 'Tài khoản chạy', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' },
    ]);
    client.current.setQueryData(['ads', 'summary', { adAccountId: 'a2', from: range.from, to: range.to }], {
      total: { spend: '120000', impressions: 5000, clicks: 40, results: null, costPerResult: null },
      resultKind: null,
    });
    const html = render(<AdsPanel slug="acme" />);
    expect(html).toContain('Tài khoản mới');
    expect(html).toContain(T.ads.noFigures);
    expect(html).toContain('Tài khoản chạy');
    expect(html).toContain(formatMoney('120000', activeLocale(), 'VND'));
    expect(html).toContain(formatNumber(5000, activeLocale()));
    expect(html).toContain('href="/o/$slug/ads"');
  });

  it('says no ad account is connected yet', () => {
    client.current.setQueryData(['ads', 'accounts', null], []);
    expect(render(<AdsPanel slug="acme" />)).toContain(T.ads.empty);
  });
});
