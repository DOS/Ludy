// SPDX-License-Identifier: AGPL-3.0-only
// The order screen's invoice state per line (#3477, docs/plan/crm-quotes.md 6.2), rendered on the server from a seeded cache: "Chưa lập hóa đơn", "Đã lập nháp" or "Đã phát hành" on each
// goods line, read from Kế toán's `einvoice.drafts.orderLines`; "Lập hóa đơn" names the lines still open and is hidden when none is; "Hủy đơn hàng" is off with its reason while any line
// is on a draft or issued. With Kế toán off the order is as before; a read that failed or has not answered says nothing. The screen is a hint, not the rule.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, asked: [] as unknown[] }));
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
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            if (path.join('.') === 'einvoice.drafts.orderLines') client.asked.push(args?.input);
            return { queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) };
          };
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DealOrders } = await import('../src/components/deal-orders.tsx');

const ORDER_ID = '00000000-0000-4000-8000-000000000020';
const CANCELLED_ID = '00000000-0000-4000-8000-000000000021';
const goods = (lineNo: number, description: string, discountPercent = '0') => ({
  lineNo,
  kind: 'item',
  description,
  unit: 'gói',
  quantity: '1',
  unitPrice: '1500000',
  discountPercent,
  discountAmount: '0',
  vatRate: '10%',
  amount: '1500000',
  vatAmount: '150000',
  stockItemId: null,
});
const LINES = [goods(1, 'Gói kế toán năm'), goods(2, 'Gói hóa đơn'), goods(3, 'Gói kho'), { ...goods(4, 'Giao trong 3 ngày'), kind: 'text', unit: null, quantity: null, unitPrice: null, vatRate: null, amount: '0', vatAmount: '0' }];
const summary = (id: string, status: string) => ({ id, number: 'DH-2026-0001', status, orderDate: '2026-11-08', lineCount: 4, total: '4950000', quoteNumber: 'BG-2026-0007', version: 1 });

type Held = Array<{ lineNo: number; state: 'draft' | 'issued' }>;

function render(options: { held?: Held | null; canEdit?: boolean; modules?: string[]; lines?: typeof LINES; orders?: ReturnType<typeof summary>[] } = {}): string {
  setActiveLocale('vi');
  config.modules = options.modules ?? ['finance'];
  client.asked.length = 0;
  const qc = client.current;
  qc.clear();
  const orders = options.orders ?? [summary(ORDER_ID, 'confirmed')];
  qc.setQueryData(['crm', 'salesOrders', 'byDeal'], orders);
  qc.setQueryData(['crm', 'salesOrders', 'get'], { id: ORDER_ID, number: 'DH-2026-0001', status: 'confirmed', lines: options.lines ?? LINES, deliveries: [] });
  qc.setQueryData(['crm', 'salesOrders', 'handoff'], { orderId: ORDER_ID, lines: options.lines ?? LINES });
  if (options.held !== null) qc.setQueryData(['einvoice', 'drafts', 'orderLines'], { orders: options.held && options.held.length > 0 ? [{ orderId: ORDER_ID, lines: options.held }] : [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <DealOrders dealId="00000000-0000-4000-8000-000000000010" canEdit={options.canEdit ?? true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
const cancelButton = (html: string) => html.slice(html.indexOf('data-testid="order-cancel-open"') - 400, html.indexOf('data-testid="order-cancel-open"') + 40);

describe('the order screen: the invoice state of each line (#3477)', () => {
  beforeEach(() => client.current.clear());

  it('says "Chưa lập hóa đơn" on every goods line of an order with no draft, and offers the button and cancel', () => {
    const html = render({ held: [] });
    expect(count(html, 'data-testid="order-invoice-line"')).toBe(3);
    expect(count(html, 'Chưa lập hóa đơn')).toBe(3);
    expect(html).not.toContain('Đã lập nháp');
    expect(html).not.toContain('Giao trong 3 ngày');
    expect(html).toContain('data-testid="order-invoice"');
    expect(html).not.toContain('order-invoice-open-lines');
    expect(cancelButton(html)).not.toContain('disabled');
    expect(html).not.toContain('order-cancel-blocked');
  });

  it('after two of three lines are drafted: "Đã lập nháp" on those two, the button names the third, and cancel is off with its reason', () => {
    const html = render({ held: [{ lineNo: 1, state: 'draft' }, { lineNo: 2, state: 'draft' }] });
    expect(count(html, 'Đã lập nháp')).toBe(2);
    expect(count(html, 'Chưa lập hóa đơn')).toBe(1);
    expect(html).toContain('data-testid="order-invoice"');
    expect(html).toMatch(/data-testid="order-invoice-open-lines">[^<]*dòng 3/);
    expect(cancelButton(html)).toContain('disabled');
    expect(html).toContain('data-testid="order-cancel-blocked"');
    expect(html).toContain('nút hủy đang tắt');
  });

  it('reads "Đã phát hành" once the draft is issued, hides the invoice button when no line is open, and keeps cancel off', () => {
    const html = render({ held: [{ lineNo: 1, state: 'issued' }, { lineNo: 2, state: 'issued' }, { lineNo: 3, state: 'issued' }] });
    expect(count(html, 'Đã phát hành')).toBe(3);
    expect(html).not.toContain('data-testid="order-invoice"');
    expect(cancelButton(html)).toContain('disabled');
  });

  it('keeps a discounted line out of the button: with the others held, no button is offered and the note says why', () => {
    const lines = [goods(1, 'Gói kế toán năm'), goods(2, 'Gói hóa đơn', '10')];
    const html = render({ held: [{ lineNo: 1, state: 'issued' }], lines });
    expect(html).not.toContain('data-testid="order-invoice"');
    expect(html).toContain('chiết khấu');
  });

  it('asks Kế toán once for all the confirmed orders of the deal, and leaves a cancelled order out', () => {
    render({ held: [], orders: [summary(ORDER_ID, 'confirmed'), summary(CANCELLED_ID, 'cancelled')] });
    expect(client.asked).toEqual([{ orderIds: [ORDER_ID] }]);
  });

  it('lets a viewer read the states but offers no button and no cancel', () => {
    const html = render({ held: [{ lineNo: 1, state: 'draft' }], canEdit: false });
    expect(count(html, 'data-testid="order-invoice-line"')).toBe(3);
    expect(html).toContain('Đã lập nháp');
    expect(html).not.toContain('data-testid="order-invoice"');
    expect(html).not.toContain('data-testid="order-cancel-open"');
    expect(html).not.toContain('order-cancel-blocked');
  });

  it('is as before without Kế toán: no state, no word of invoices, cancel on', () => {
    const html = render({ held: [{ lineNo: 1, state: 'draft' }], modules: [] });
    expect(html).not.toContain('order-invoice-line');
    expect(html).not.toContain('Đã lập nháp');
    expect(html).not.toContain('data-testid="order-invoice"');
    expect(cancelButton(html)).not.toContain('disabled');
    expect(html).not.toContain('order-cancel-blocked');
  });

  it('says nothing about a line while the answer is not known, and does not turn cancel off on a guess', () => {
    const html = render({ held: null });
    expect(html).not.toContain('order-invoice-line');
    expect(html).not.toContain('Chưa lập hóa đơn');
    expect(cancelButton(html)).not.toContain('disabled');
    expect(html).toContain('data-testid="order-invoice"');
  });
});
