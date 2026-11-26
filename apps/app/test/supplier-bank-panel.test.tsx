// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts on the vendors screen (#3113 S1), rendered on the server with the account list seeded in the cache: each account is its bank and last four digits, never a full number or
// a holder; the history lists the kinds of change; "Xóa dữ liệu ngân hàng" shows for an owner only; the add form is there for a manager. No screen offers a way to read a number.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupplierBankAccountList } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return (opts?: object) => ({ mutationFn: () => Promise.reject(new Error('not run')), ...opts });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: cache.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});

const { SupplierBankPanel } = await import('../src/components/supplier-bank-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const PARTY = '00000000-0000-4000-8000-0000000000c1';
const list = (): SupplierBankAccountList => ({
  accounts: [
    { id: '00000000-0000-4000-8000-0000000000d2', partyId: PARTY, bankName: 'Vietcombank', last4: '8901', status: 'active', createdAt: '2026-11-18T01:00:00.000Z', retiredAt: null },
    { id: '00000000-0000-4000-8000-0000000000d1', partyId: PARTY, bankName: 'ACB', last4: '6655', status: 'retired', createdAt: '2026-10-01T01:00:00.000Z', retiredAt: '2026-11-18T01:00:00.000Z' },
  ],
  changes: [
    { id: '00000000-0000-4000-8000-0000000000e2', accountId: '00000000-0000-4000-8000-0000000000d2', kind: 'replaced', changedAt: '2026-11-18T01:00:00.000Z' },
    { id: '00000000-0000-4000-8000-0000000000e1', accountId: '00000000-0000-4000-8000-0000000000d1', kind: 'added', changedAt: '2026-10-01T01:00:00.000Z' },
  ],
});

function render(canErase: boolean, data: SupplierBankAccountList | null = list(), locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  cache.current.clear();
  if (data) cache.current.setQueryData(['supplierBank', 'list', { partyId: PARTY }], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <SupplierBankPanel partyId={PARTY} canErase={canErase} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the bank accounts panel of a supplier', () => {
  it('shows each account by its bank and last four digits, with Đổi and Ngừng dùng only on the active one, and never a long number', () => {
    const html = render(false);
    expect(html).toContain('Vietcombank');
    expect(html).toContain('••••8901');
    expect(html).toContain('••••6655');
    expect(html.match(/data-testid="supplier-bank-account"/g)).toHaveLength(2);
    expect(html.match(/data-testid="supplier-bank-change"/g)).toHaveLength(1);
    expect(html.match(/data-testid="supplier-bank-retire"/g)).toHaveLength(1);
    expect(html).not.toMatch(/[0-9]{7,}/);
  });

  it('lists the history of changes and offers the add form with its three fields', () => {
    const html = render(false);
    expect(html).toContain('data-testid="supplier-bank-history"');
    expect(html).toContain('đổi tài khoản');
    expect(html).toContain('thêm tài khoản');
    for (const id of ['supplier-bank-name', 'supplier-bank-holder', 'supplier-bank-number', 'supplier-bank-add']) expect(html).toContain(`data-testid="${id}"`);
  });

  it('offers the erasure to an owner only', () => {
    expect(render(true)).toContain('data-testid="supplier-bank-erase"');
    expect(render(false)).not.toContain('data-testid="supplier-bank-erase"');
  });

  it('says there is no account yet when the list is empty, and reads in English too', () => {
    expect(render(false, { accounts: [], changes: [] })).toContain('Chưa có tài khoản ngân hàng nào.');
    const en = render(true, list(), 'en');
    expect(en).toContain('In use since 2026-11-18');
    expect(en).toContain("Erase the supplier&#x27;s bank data");
    expect(en).not.toContain('Chưa có');
  });

  it('renders an erased last4 tombstone as dots without literal asterisks', () => {
    const html = render(true, {
      accounts: [
        { id: '00000000-0000-4000-8000-0000000000d3', partyId: PARTY, bankName: 'Vietcombank', last4: '****', status: 'retired', createdAt: '2026-10-01T01:00:00.000Z', retiredAt: '2026-11-18T01:00:00.000Z' },
      ],
      changes: [],
    });
    expect(html).toContain('••••');
    expect(html).not.toContain('****');
  });
});
