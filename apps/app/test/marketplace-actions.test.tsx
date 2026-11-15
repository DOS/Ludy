// SPDX-License-Identifier: AGPL-3.0-only
// What a person can act on at the Sàn screen (#2516 slice F), rendered on the server with the answer of marketplace.worklist seeded in the cache: nothing is shown when nothing waits; while the account map
// is not confirmed the gate line is shown and the three actions are disabled; once it is, each action is a button (the payout one beside a choice of bank lines by date, amount and reference, never a
// free-text id); a settlement with no matching bank line says so and its button stays disabled; and reading the screen asks the server for nothing but the read.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceWorklist } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

const { MarketplaceActions } = await import('../src/components/marketplace-actions.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';
const settlementId = '00000000-0000-4000-8000-0000000000a1';
const lineA = '00000000-0000-4000-8000-0000000000b1';
const lineB = '00000000-0000-4000-8000-0000000000b2';
const documentId = '00000000-0000-4000-8000-0000000000c1';

const EMPTY: MarketplaceWorklist = { postingConfirmed: true, settlements: [], payouts: [], invoices: [] };
const FULL = (over: Partial<MarketplaceWorklist> = {}): MarketplaceWorklist => ({
  postingConfirmed: true,
  settlements: [{ id: settlementId, legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', periodFrom: '2026-10-01', periodTo: '2026-10-15', month: '2026-10', net: '335000', waitingLines: 0, proposalId: null }],
  payouts: [
    {
      settlementId,
      legalEntityId: entity,
      platform: 'shopee',
      platformName: 'Shopee',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-15',
      received: '304000',
      proposalId: null,
      candidates: [
        { id: lineA, date: '2026-10-20', amount: '304000', reference: 'FT2610200001' },
        { id: lineB, date: '2026-10-22', amount: '304000', reference: null },
      ],
    },
  ],
  invoices: [{ documentId, legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', invoice: '1C26TPF00000007', date: '2026-10-25', clearable: '28000', proposalId: null }],
  ...over,
});

function render(answer: MarketplaceWorklist | null, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  if (answer) cache.current.setQueryData(['marketplace', 'worklist'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceActions legalEntityId={undefined} ready />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// Whether the first element with this test id carries the disabled attribute (not a class that merely styles one).
const disabled = (html: string, testId: string): boolean => /\sdisabled=""/.test(html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '');

describe('the Sàn screen actions (#2516 slice F)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows nothing before the answer is in, and nothing when nothing waits', () => {
    expect(render(null)).toBe('');
    expect(render(EMPTY)).toBe('');
    expect(cache.calls).toEqual([]);
  });

  it('while the account map is not confirmed shows the gate line and the three actions disabled', () => {
    const html = render(FULL({ postingConfirmed: false }));
    expect(html).toContain('data-testid="marketplace-gate"');
    expect(html).toContain('Waiting for the accountant to confirm the marketplace account map (#2520)');
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) expect(disabled(html, id)).toBe(true);
    expect(cache.calls).toEqual([]);
  });

  it('once the map is confirmed shows no gate line and the three actions enabled', () => {
    const html = render(FULL());
    expect(html).not.toContain('marketplace-gate');
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) expect(disabled(html, id)).toBe(false);
    expect(html).toContain('Post');
    expect(html).toContain('Record the money');
    expect(html).toContain('Clear the fees');
    // Nothing was asked of the server by reading the screen: the buttons only ask when pressed.
    expect(cache.calls).toEqual([]);
  });

  it('lists the settlement with its period and net, and the invoice with what it can clear', () => {
    const html = render(FULL());
    expect(html).toContain('Shopee');
    expect(html).toContain('2026-10-01 - 2026-10-15');
    expect(html).toContain('1C26TPF00000007');
    expect(html).toContain('2026-10-25');
    expect(html.match(/data-testid="marketplace-action-settlement"/g)).toHaveLength(1);
    expect(html.match(/data-testid="marketplace-action-invoice"/g)).toHaveLength(1);
  });

  it('shows the month of delivery of a settlement, one row for each, and a settlement that waits for a delivery day with no button', () => {
    const base = FULL();
    const one = base.settlements[0]!;
    const html = render({
      ...base,
      settlements: [
        { ...one, month: '2026-09', net: '100000' },
        { ...one, month: '2026-10', net: '235000' },
        { ...one, id: '00000000-0000-4000-8000-0000000000a9', month: null, net: '0', waitingLines: 3 },
      ],
    });
    expect(html.match(/data-testid="marketplace-action-settlement"/g)).toHaveLength(3);
    expect(html).toContain('2026-09');
    expect(html).toContain('3 lines have no delivery day yet');
    // Two buttons (one for each month with a net), and the waiting row has the note instead.
    expect(html.match(/data-testid="marketplace-post"/g)).toHaveLength(2);
    expect(html).toContain('marketplace-post-waiting');
    expect(html).toContain('Waiting for the delivery day');
  });

  it('offers the bank lines by date, amount and reference, never a free-text id', () => {
    const html = render(FULL());
    expect(html).toContain('data-testid="marketplace-line-select"');
    expect(html).toContain('2026-10-20');
    expect(html).toContain('FT2610200001');
    expect(html).toContain('2026-10-22');
    expect(html.match(/<option/g)).toHaveLength(2);
    expect(html).not.toContain('<input');
  });

  it('says there is no matching bank line yet, and keeps the payout button disabled', () => {
    const html = render(FULL({ payouts: [{ ...FULL().payouts[0]!, candidates: [] }] }));
    expect(html).toContain('data-testid="marketplace-no-candidates"');
    expect(html).toContain('No matching bank line yet');
    expect(disabled(html, 'marketplace-record')).toBe(true);
    expect(html).not.toContain('<select');
  });

  it('shows only the lists that have something in them', () => {
    const html = render(FULL({ payouts: [], invoices: [] }));
    expect(html).toContain('marketplace-actions-settlements');
    expect(html).not.toContain('marketplace-actions-payouts');
    expect(html).not.toContain('marketplace-actions-invoices');
  });

  it('links to the proposal already waiting in the Inbox instead of offering a second request', () => {
    const waiting = '00000000-0000-4000-8000-0000000000d1';
    const base = FULL();
    const html = render({ ...base, settlements: [{ ...base.settlements[0]!, proposalId: waiting }], payouts: [{ ...base.payouts[0]!, proposalId: waiting }], invoices: [{ ...base.invoices[0]!, proposalId: waiting }] });
    for (const id of ['marketplace-post', 'marketplace-record', 'marketplace-clear']) {
      expect(html).toContain(`data-testid="${id}-pending"`);
      expect(html).not.toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('Waiting for approval.');
    expect(html).toContain(`href="/o/acme/inbox/${waiting}"`);
    // The payout row offers no choice of bank line while its proposal waits.
    expect(html).not.toContain('marketplace-line-select');
  });

  it('reads in Vietnamese', () => {
    const html = render(FULL({ postingConfirmed: false }), 'vi');
    expect(html).toContain('Chờ kế toán xác nhận bảng tài khoản sàn (#2520)');
    expect(html).toContain('Ghi sổ');
    expect(html).toContain('Ghi nhận tiền về');
    expect(html).toContain('Cấn trừ phí');
    expect(html).toContain('Kỳ đối soát chờ ghi sổ');
  });
});
