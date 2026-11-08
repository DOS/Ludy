// SPDX-License-Identifier: AGPL-3.0-only
// The delivery panel of a sales order (#2697, docs/plan/crm-quotes.md step Q4b), rendered on the server from a seeded cache: only goods lines are listed (a note line has nothing to
// deliver), each says whether it was delivered, a person who may edit gets "Đã giao" for an undelivered line and "Hoàn giao" for a live delivery, a viewer only reads, a taken-back
// delivery offers neither (it is not delivered again in this slice). Where Kế toán runs (#2818) a person who may edit also sees the stock state of a delivery and a button to record it
// (no word of stock without that module, none for a viewer); nothing is requested until a button is pressed.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const config = vi.hoisted(() => ({ modules: [] as string[] }));

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: config.modules }) }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DealOrders, DeliveryPanel } = await import('../src/components/deal-orders.tsx');

const ORDER_ID = '00000000-0000-4000-8000-000000000020';
const goods = (lineNo: number, description: string) => ({
  lineNo,
  kind: 'item',
  description,
  unit: 'gói',
  quantity: '2',
  unitPrice: '1500000',
  discountPercent: '0',
  vatRate: '10%',
  amount: '3000000',
  vatAmount: '300000',
  stockItemId: null,
});
const order = (deliveries: Array<{ lineNo: number; deliveredOn: string; reversed: boolean }>) => ({
  id: ORDER_ID,
  number: 'DH-2026-0001',
  status: 'confirmed',
  lines: [goods(1, 'Gói kế toán năm'), goods(2, 'Gói hóa đơn'), { ...goods(3, 'Giao trong 3 ngày'), kind: 'text', unit: null, quantity: null, unitPrice: null, vatRate: null, amount: '0', vatAmount: '0' }],
  deliveries,
});

function render(canEdit: boolean, deliveries: Array<{ lineNo: number; deliveredOn: string; reversed: boolean }>, modules: string[] = []): string {
  setActiveLocale('vi');
  config.modules = modules;
  client.current.setQueryData(['crm', 'salesOrders', 'get'], order(deliveries));
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <DeliveryPanel orderId={ORDER_ID} canEdit={canEdit} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('the delivery panel of an order (#2697)', () => {
  beforeEach(() => client.current.clear());

  it('lists the goods lines only, and offers "Đã giao" for each line not delivered', () => {
    const html = render(true, []);
    expect(count(html, 'data-testid="order-delivery-line"')).toBe(2);
    expect(html).not.toContain('Giao trong 3 ngày');
    expect(count(html, 'data-testid="order-delivery-mark"')).toBe(2);
    expect(count(html, 'data-testid="order-delivery-undo"')).toBe(0);
    expect(count(html, 'Chưa giao')).toBe(2);
  });

  it('shows a live delivery with "Hoàn giao" and a taken-back one with neither button; without Kế toán there is no word of stock', () => {
    const html = render(true, [
      { lineNo: 1, deliveredOn: '2026-11-15', reversed: false },
      { lineNo: 2, deliveredOn: '2026-11-14', reversed: true },
    ]);
    expect(count(html, 'data-testid="order-delivery-mark"')).toBe(0);
    expect(count(html, 'data-testid="order-delivery-undo"')).toBe(1);
    expect(html).toContain('Đã hoàn giao');
    expect(count(html, 'data-testid="order-delivery-stock"')).toBe(0);
    expect(html).not.toContain('ghi kho');
  });

  it('with Kế toán, a person who may edit sees the stock state of each delivery and a button to record it, asked again safely', () => {
    const html = render(
      true,
      [
        { lineNo: 1, deliveredOn: '2026-11-15', reversed: false },
        { lineNo: 2, deliveredOn: '2026-11-14', reversed: true },
      ],
      ['finance'],
    );
    expect(count(html, 'data-testid="order-delivery-stock"')).toBe(2);
    expect(count(html, 'data-testid="order-delivery-stock-retry"')).toBe(2);
    expect(html).toContain('Ghi kho');
    expect(html).toContain('Ghi hoàn kho');
    expect(html).toContain('Chưa kiểm tra việc ghi kho');
    expect(count(html, 'data-testid="order-delivery-stock-teach"')).toBe(0);
  });

  it('a line not delivered has no stock state even with Kế toán', () => {
    const html = render(true, [], ['finance']);
    expect(count(html, 'data-testid="order-delivery-stock"')).toBe(0);
  });

  it('is read only for a viewer: the state of each line, no button', () => {
    const html = render(false, [{ lineNo: 1, deliveredOn: '2026-11-15', reversed: false }], ['finance']);
    expect(count(html, 'data-testid="order-delivery-line"')).toBe(2);
    expect(count(html, 'data-testid="order-delivery-stock"')).toBe(0);
    expect(count(html, 'data-testid="order-delivery-mark"')).toBe(0);
    expect(count(html, 'data-testid="order-delivery-undo"')).toBe(0);
    expect(html).toContain('Chưa giao');
  });
});

const summary = { id: ORDER_ID, number: 'DH-2026-0001', status: 'confirmed', version: 1, orderDate: '2026-11-08', lineCount: 3, total: '6600000', quoteNumber: null };
const hLine = (lineNo: number, discountPercent: string) => ({ lineNo, kind: 'item', discountPercent });
function renderOrders(canEdit: boolean, modules: string[], handoffLines: unknown[]): string {
  setActiveLocale('vi');
  config.modules = modules;
  client.current.setQueryData(['crm', 'salesOrders', 'byDeal'], [summary]);
  client.current.setQueryData(['crm', 'salesOrders', 'handoff'], { lines: handoffLines });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <DealOrders dealId="00000000-0000-4000-8000-000000000040" canEdit={canEdit} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('"Lập hóa đơn" on an order (#2818)', () => {
  beforeEach(() => client.current.clear());

  it('shows the button only where Kế toán runs and the person may edit', () => {
    expect(count(renderOrders(true, ['finance'], [hLine(1, '0')]), 'data-testid="order-invoice"')).toBe(1);
    expect(count(renderOrders(true, [], [hLine(1, '0')]), 'data-testid="order-invoice"')).toBe(0);
    expect(count(renderOrders(false, ['finance'], [hLine(1, '0')]), 'data-testid="order-invoice"')).toBe(0);
  });

  it('names a discounted line that is left out, and turns the button off when every goods line has a discount', () => {
    const some = renderOrders(true, ['finance'], [hLine(1, '0'), hLine(2, '10')]);
    expect(some).toContain('Dòng 2 có chiết khấu');
    expect(some).not.toContain('disabled=""');
    const all = renderOrders(true, ['finance'], [hLine(1, '5'), hLine(2, '10')]);
    expect(all).toContain('Mọi dòng hàng đều có chiết khấu');
    expect(all).toContain('disabled=""');
  });
});
