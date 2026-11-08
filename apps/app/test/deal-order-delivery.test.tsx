// SPDX-License-Identifier: AGPL-3.0-only
// The delivery panel of a sales order (#2697, docs/plan/crm-quotes.md step Q4b), rendered on the server from a seeded cache: only goods lines are listed (a note line has nothing to
// deliver), each says whether it was delivered, a person who may edit gets "Đã giao" for an undelivered line and "Hoàn giao" for a live delivery, a viewer only reads, a taken-back
// delivery offers neither (it is not delivered again in this slice), and a live delivery says its stock is not recorded yet; nothing is requested until a button is pressed.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DeliveryPanel } = await import('../src/components/deal-orders.tsx');

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

function render(canEdit: boolean, deliveries: Array<{ lineNo: number; deliveredOn: string; reversed: boolean }>): string {
  setActiveLocale('vi');
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

  it('shows a live delivery with "Hoàn giao" and says its stock is not recorded; a taken-back one offers neither button', () => {
    const html = render(true, [
      { lineNo: 1, deliveredOn: '2026-11-15', reversed: false },
      { lineNo: 2, deliveredOn: '2026-11-14', reversed: true },
    ]);
    expect(count(html, 'data-testid="order-delivery-mark"')).toBe(0);
    expect(count(html, 'data-testid="order-delivery-undo"')).toBe(1);
    expect(count(html, 'data-testid="order-delivery-stock"')).toBe(1);
    expect(html).toContain('Chưa ghi kho');
    expect(html).toContain('Đã hoàn giao');
  });

  it('is read only for a viewer: the state of each line, no button', () => {
    const html = render(false, [{ lineNo: 1, deliveredOn: '2026-11-15', reversed: false }]);
    expect(count(html, 'data-testid="order-delivery-line"')).toBe(2);
    expect(count(html, 'data-testid="order-delivery-mark"')).toBe(0);
    expect(count(html, 'data-testid="order-delivery-undo"')).toBe(0);
    expect(html).toContain('Chưa giao');
  });
});
