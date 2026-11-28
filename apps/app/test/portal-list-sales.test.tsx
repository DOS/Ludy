// SPDX-License-Identifier: AGPL-3.0-only
// Tax portal sales reconciliation UI (#2151), rendered on the server: missing sales without a buyer tax code show
// the buyer's name read from 'Tên người mua', rows with null/empty buyerName fall back cleanly to buyerTaxCode, and
// matched/Ludy-only rows keep reading buyerName across portal and Ludy sides.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalReconciliation } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const searchState = vi.hoisted(() => ({ current: { direction: 'sale', period: '2026-09' } as Record<string, unknown> }));

const ENTITY_ID = '00000000-0000-4000-8000-0000000000e1';
const LIST_ID = '00000000-0000-4000-8000-0000000000a1';
const FILE_ID = '00000000-0000-4000-8000-0000000000f1';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    uploadFiles: async () => ({ files: [] }),
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => ({ slug: 'acme' }),
  useSearch: () => searchState.current,
  useNavigate: () => () => undefined,
  Link: ({ to, children }: { to: string; children: unknown }) => <a href={to}>{children as never}</a>,
}));

vi.mock('../src/components/entity-switcher.tsx', () => ({
  useChosenEntity: () => ({ ready: true, legalEntityId: ENTITY_ID }),
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ taxPortalSync: false }),
}));

const { PortalListPage } = await import('../src/routes/portal-list.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

type ReconcileItem = PortalReconciliation['items'][number];
type PortalRow = NonNullable<ReconcileItem['portal']>;
type LudyInvoice = NonNullable<ReconcileItem['ludy']>;

const portalRow = (rowNo: number, over: Partial<PortalRow> = {}): PortalRow => ({
  listId: LIST_ID,
  rowNo,
  sellerTaxCode: '0309876546',
  sellerName: 'Công ty Mẫu',
  buyerTaxCode: null,
  buyerName: null,
  template: '1',
  series: 'C26TAA',
  number: String(rowNo),
  issueDate: '2026-09-10',
  currency: 'VND',
  subtotal: '1000000',
  vatAmount: '100000',
  total: '1100000',
  status: 'original',
  statusLabel: 'Hóa đơn mới',
  ...over,
});

const ludyInvoice = (id: string, over: Partial<LudyInvoice> = {}): LudyInvoice => ({
  kind: 'document',
  id,
  sellerTaxCode: null,
  sellerName: '',
  buyerTaxCode: '0101234564',
  buyerName: 'Công ty Khách Hàng Sổ',
  template: '1',
  series: 'C26TAA',
  number: '100',
  issueDate: '2026-09-10',
  currency: 'VND',
  vatAmount: '100000',
  total: '1100000',
  sourceFileId: null,
  postingDate: '2026-09-10',
  ...over,
});

const item = (outcome: ReconcileItem['outcome'], portal: PortalRow | null, ludy: LudyInvoice | null = null): ReconcileItem => ({
  outcome,
  portal,
  ludy,
  differences: [],
  withoutTaxCode: false,
  outsidePeriod: false,
  duplicateRows: 0,
  duplicateInLudy: false,
  declaredInLaterPeriod: false,
});

const sampleData = (): PortalReconciliation => ({
  direction: 'sale',
  period: { period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' },
  lists: [
    {
      id: LIST_ID,
      period: '2026-09',
      direction: 'sale',
      fileId: FILE_ID,
      filename: 'ban-ra-09.xlsx',
      status: 'done',
      error: null,
      rowCount: 4,
      listFrom: '2026-09-01',
      listTo: '2026-09-30',
      skippedCount: 0,
      skipped: [],
      ownSalesCount: 0,
      otherBuyerCount: 0,
      createdAt: '2026-09-30T10:00:00.000Z',
    },
  ],
  summary: {
    portalInvoices: 4,
    matched: 1,
    inInbox: 0,
    amountMismatch: 0,
    missing: 3,
    voidInLudy: 0,
    void: 0,
    notOnPortal: 1,
    declaredLate: 0,
    duplicateRows: 0,
  },
  items: [
    item('missing', portalRow(1, { number: '101', buyerTaxCode: null, buyerName: 'Nguyễn Văn An' })),
    item('missing', portalRow(2, { number: '102', buyerTaxCode: '0101234564', buyerName: 'Công ty TNHH Thử Nghiệm' })),
    item('missing', portalRow(3, { number: '103', buyerTaxCode: '0100109107', buyerName: null })),
    item('not_on_portal', null, ludyInvoice('00000000-0000-4000-8000-000000000201', { number: '104', buyerTaxCode: '0302712572', buyerName: 'Khách hàng Chưa Lên Cổng' })),
    item('matched', portalRow(4, { number: '105', buyerTaxCode: '0101234564', buyerName: null }), ludyInvoice('00000000-0000-4000-8000-000000000202', { number: '105', buyerName: 'Khách hàng Khớp Sổ' })),
  ],
  truncated: false,
});

function render(locale: 'vi' | 'en', data: PortalReconciliation): string {
  setActiveLocale(locale);
  searchState.current = { direction: data.direction, period: data.period.period };
  cache.current.setQueryData(['org', 'get', undefined], { role: 'owner' });
  cache.current.setQueryData(['portalList', 'reconcile', { period: data.period.period, legalEntityId: ENTITY_ID, direction: data.direction }], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <PortalListPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('PortalListPage sales customer name display (#2151)', () => {
  beforeEach(() => cache.current.clear());

  it('shows portal buyerName for missing sales without tax code, both when present, and falls back to buyerTaxCode when buyerName is null', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = render(locale, sampleData());
      expect(html).toContain('Nguyễn Văn An');
      expect(html).toContain('Công ty TNHH Thử Nghiệm');
      expect(html).toContain('0101234564');
      expect(html).toContain('0100109107');
      expect(html).toContain('Khách hàng Chưa Lên Cổng');
      expect(html).toContain('Khách hàng Khớp Sổ');
    }
  });

  it('shows a dash only when a sale row has neither buyerName nor buyerTaxCode', () => {
    const data = sampleData();
    data.items = [item('missing', portalRow(1, { number: '201', buyerTaxCode: null, buyerName: '   ' }))];
    const html = render('vi', data);
    expect(html).toContain('1C26TAA-201');
    expect(html).toContain('>-<');
  });
});
