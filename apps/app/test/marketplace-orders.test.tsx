// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace orders card and Inbox staged card for lost parcels (#4265): a line flagged lostParcel shows "kiện hàng có thể đã thất lạc" (and English "parcel may be lost") while normal
// shipped lines stay clear, and a staged summary with lostParcels warns that stock stays out and bookkeeping handles any write-off (zero buyer PII or AI call).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceOrder, MarketplaceStaged } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC({ defaultOptions: { queries: { retry: false } } });
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

const { MarketplaceOrders } = await import('../src/components/marketplace-orders.tsx');
const { StagedMarketplace } = await import('../src/components/staged-marketplace.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const ENTITY = '00000000-0000-4000-8000-0000000000e1';
const ORDER_LOST = '00000000-0000-4000-8000-000000000101';
const ORDER_OK = '00000000-0000-4000-8000-000000000102';
const LINE_LOST = '00000000-0000-4000-8000-000000000201';
const LINE_OK = '00000000-0000-4000-8000-000000000202';
const FILE_ID = '00000000-0000-4000-8000-000000000301';

const ORDERS: MarketplaceOrder[] = [
  {
    id: ORDER_LOST,
    legalEntityId: ENTITY,
    platform: 'tiktok_shop',
    orderNo: 'TT-LOST-1',
    orderedAt: '2026-11-20',
    stage: 'shipped',
    lines: [
      {
        id: LINE_LOST,
        lineKey: '1001',
        sku: 'AO-01',
        itemName: 'Áo thun',
        quantity: '1',
        unitPrice: '150000',
        amount: '150000',
        stage: 'shipped',
        lostParcel: true,
        shippedAt: '2026-11-21',
        itemCode: 'AO-01',
      },
    ],
  },
  {
    id: ORDER_OK,
    legalEntityId: ENTITY,
    platform: 'lazada',
    orderNo: 'LZ-OK-2',
    orderedAt: '2026-11-20',
    stage: 'shipped',
    lines: [
      {
        id: LINE_OK,
        lineKey: '1002',
        sku: 'QUAN-02',
        itemName: 'Quần bò',
        quantity: '1',
        unitPrice: '200000',
        amount: '200000',
        stage: 'shipped',
        lostParcel: false,
        shippedAt: '2026-11-21',
        itemCode: 'QUAN-02',
      },
    ],
  },
];

const STAGED: MarketplaceStaged = {
  fileId: FILE_ID,
  filename: 'tiktok-lost.csv',
  createdAt: '2026-11-21T08:00:00.000Z',
  entity: { id: ENTITY, name: 'Công ty Thử' },
  summary: {
    state: 'staged',
    platform: 'tiktok_shop',
    profileVersion: 'v1',
    profileConfirmed: true,
    filename: 'tiktok-lost.csv',
    orders: 2,
    lines: 2,
    from: '2026-11-20',
    to: '2026-11-20',
    stages: { placed: 0, shipped: 2, completed: 0, cancelled: 0, returned: 0, unknown: 0 },
    unknownStatuses: [],
    ignoredRows: 0,
    lostParcels: 1,
  },
};

function renderOrders(locale: 'vi' | 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['marketplace', 'orders'], ORDERS);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceOrders legalEntityId={ENTITY} ready={true} canWrite={true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderStaged(locale: 'vi' | 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['marketplace', 'staged'], [STAGED]);
  cache.current.setQueryData(['marketplace', 'preview'], { newLines: 1, knownLines: 0, advancedLines: 1, matchedLines: 2, unmatchedLines: 0 });
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <StagedMarketplace canDecide={true} refetchMs={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('MarketplaceOrders lost parcel badge', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows "kiện hàng có thể đã thất lạc" in Vietnamese only on the lost-parcel line and localizes to English', () => {
    const vi = renderOrders('vi');
    expect(vi).toContain('TT-LOST-1');
    expect(vi).toContain('LZ-OK-2');
    expect(vi.match(/marketplace-line-lost-parcel/g)).toHaveLength(1);
    expect(vi).toContain('kiện hàng có thể đã thất lạc');

    const en = renderOrders('en');
    expect(en.match(/marketplace-line-lost-parcel/g)).toHaveLength(1);
    expect(en).toContain('parcel may be lost');
  });

  it('shows the lost-parcel warning on the Inbox staged card when lostParcels > 0', () => {
    const vi = renderStaged('vi');
    expect(vi).toContain('staged-marketplace-lost');
    expect(vi).toContain('kiện hàng có thể đã thất lạc');

    const en = renderStaged('en');
    expect(en).toContain('staged-marketplace-lost');
    expect(en).toContain('1 line is flagged as a possibly lost parcel');
  });
});
