// SPDX-License-Identifier: AGPL-3.0-only
// The received invoices that can be asked for payment (#3113 S4b), rendered on the server with the answer of supplierPayment.payable seeded in the cache: a ready supplier's invoice shows the supplier,
// the invoice and one button; an account changed this month is flagged on the row; a supplier with no account or several shows what to do first and no button; nothing listed shows nothing; rendering
// makes no call. The press, the confirmation and the request are covered where the stack allows (the kernel tests of finance.supplier_payment.record and the payable read).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupplierPayable, SupplierPayableList } from '@crove/kernel-contract';

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

const { SupplierPayablePanel } = await import('../src/components/supplier-payable-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const base: SupplierPayable = {
  purchaseDocumentId: '00000000-0000-4000-8000-0000000000d1',
  partyId: '00000000-0000-4000-8000-0000000000e1',
  partyName: 'Cong ty Anh Duong',
  invoiceNumber: 'HD-0042',
  invoiceDate: '2026-11-01',
  amount: '110000',
  currency: 'VND',
  account: 'ready',
  accountChangedOn: null,
};

function render(answer: SupplierPayableList, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['supplierPayment', 'payable'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <SupplierPayablePanel slug="acme" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the invoices to pay on the vendors page (#3113 S4b)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows a ready supplier\'s invoice with the supplier, the invoice and one button, and calls nothing', () => {
    const html = render({ items: [base], more: false });
    expect(html).toContain('data-testid="supplier-payable-row"');
    expect(html).toContain('Cong ty Anh Duong');
    expect(html).toContain('HD-0042');
    expect(html).toContain('data-testid="supplier-payable-open"');
    // The confirmation and the request come only after the button; nothing flagged without a change.
    expect(html).not.toContain('supplier-payable-form');
    expect(html).not.toContain('supplier-payable-changed');
    expect(cache.calls).toEqual([]);
  });

  it('flags an account changed this month on the row, and still offers the request', () => {
    const html = render({ items: [{ ...base, accountChangedOn: '2026-11-10' }], more: false });
    expect(html).toContain('data-testid="supplier-payable-changed"');
    expect(html).toContain('data-testid="supplier-payable-open"');
  });

  it('says what to do first for a supplier with no account or several, and shows no button', () => {
    const none = render({ items: [{ ...base, account: 'none' }], more: false });
    expect(none).toContain('Add the supplier&#x27;s bank account first');
    expect(none).not.toContain('supplier-payable-open');
    cache.current.clear();
    const many = render({ items: [{ ...base, account: 'many' }], more: false });
    expect(many).toContain('several active accounts');
    expect(many).not.toContain('supplier-payable-open');
  });

  it('shows nothing when no invoice waits, says when older ones are cut, and speaks Vietnamese', () => {
    expect(render({ items: [], more: false })).toBe('');
    cache.current.clear();
    expect(render({ items: [base], more: true })).toContain('Showing the oldest 1');
    cache.current.clear();
    const vi = render({ items: [base], more: false }, 'vi');
    expect(vi).toContain('Hóa đơn cần chi');
    expect(vi).toContain('Xin chi');
  });
});
