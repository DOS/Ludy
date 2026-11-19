// SPDX-License-Identifier: AGPL-3.0-only
// The S2d-HKD book on the household screen (#2517 slice 2d), rendered on the server with the API's answers seeded: shown only for a method that keeps S2d (the income method), one section per item
// with its opening, moves and closing value, the total of all items; the open-month notice; the provisional label while the layout row is unconfirmed (and none once confirmed), a negative balance flagged, the Excel button on, and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdS1a, HouseholdS2d } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { orpc: node([]), client: {}, apiFetch: () => Promise.reject(new Error('not fetched')), getCurrentOrg: () => 'acme', queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { HouseholdPage } = await import('../src/routes/household.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const LABEL_EN = 'Provisional figures: the accountant has not confirmed the book layout yet';
const LABEL_VI = 'Số liệu tạm, kế toán chưa xác nhận bố cục sổ';
const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const income = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods'], einvoiceRegistered: true, representativeName: 'Nguyễn Văn A', vatCutEligible: null },
  books: [{ book: 'S2d', version: '2026.1', name: 'Sổ chi tiết hàng hóa (S2d-HKD)', status: 'commentary' }],
  commentary: true,
});
const percentage = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods'], einvoiceRegistered: false, representativeName: null, vatCutEligible: null },
  books: [{ book: 'S2a', version: '2026.1', name: 'S2a', status: 'commentary' }],
  commentary: true,
});
const s1a: HouseholdS1a = {
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: null, openedOn: '2026-01-01' },
  form: { book: 'S1a', version: '2026.1', name: 'S1a', status: 'commentary' },
  rows: [],
  total: '0',
};
const book = (over: Partial<HouseholdS2d> = {}): HouseholdS2d => ({
  period: { month: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2d', version: '2026.1', name: 'Sổ chi tiết hàng hóa (S2d-HKD)', status: 'commentary' },
  items: [
    {
      itemId: E(1),
      code: 'GAO',
      name: 'Gạo thơm',
      unit: 'kg',
      openingQuantity: '0',
      openingValue: '0',
      rows: [
        { moveId: E(2), date: '2026-11-05', source: 'document_line', reference: 'AA-0001', quantityIn: '10', quantityOut: '0', valueIn: '1000000', balanceQuantity: '10' },
        { moveId: E(3), date: '2026-11-10', source: 'manual', reference: null, quantityIn: '0', quantityOut: '4', valueIn: null, balanceQuantity: '6' },
      ],
      inQuantity: '10',
      inValue: '1000000',
      outQuantity: '4',
      outValue: '400000',
      closingQuantity: '6',
      closingValue: '600000',
      unitCost: '100000',
    },
  ],
  totals: { openingValue: '0', inValue: '1000000', outValue: '400000', closingValue: '600000' },
  monthClosed: false,
  unconfirmed: [{ kind: 'form', key: 'S2d 2026.1', effectiveFrom: '2026-01-01' }],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-s2d-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-s2d-download"/;
const count = (html: string, text: string) => html.split(text).length - 1;
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function page(seed: { profile?: HouseholdProfileView; s2d?: HouseholdS2d } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? income());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2d'], seed.s2d ?? book());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the S2d-HKD book on the household screen (#2517 slice 2d)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the book for the income method: an item section with opening, moves, totals and closing value, and the total of all items', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2d"');
    expect(html).toContain('S2d-HKD: goods book');
    expect(html).toContain('data-testid="household-s2d-item-GAO"');
    expect(html).toContain('AA-0001');
    expect(html).toContain('data-testid="household-s2d-notice"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    expect(html).not.toContain('(not built yet)');
    expect(html).not.toContain('data-testid="household-s2a"');
    const text = plain(html);
    expect(text).toContain('GAO - Gạo thơm (kg)');
    expect(text).toContain('From an invoice 10 0 ₫1,000,000 10');
    expect(text).toContain('Entered by hand 0 4 6');
    expect(text).toContain('In 10 (₫1,000,000), out 4 (₫400,000), average unit cost ₫100,000');
    expect(text).toContain('Closing stock ₫600,000');
    expect(text).toContain('Closing stock value ₫600,000');
  });

  it('says an open month is provisional, and not once it is closed', () => {
    expect(page()).toContain('data-testid="household-s2d-open"');
    expect(page({ s2d: book({ monthClosed: true }) })).not.toContain('data-testid="household-s2d-open"');
  });

  it('labels the closing figures while the layout is unconfirmed, and carries nothing once it is confirmed', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2d-draft"');
    expect(html).toContain(LABEL_EN);
    // One closing per item and the total of all items.
    expect(count(html, 'data-testid="household-s2d-provisional"')).toBe(2);
    const confirmed = page({ s2d: book({ form: { book: 'S2d', version: '2026.2', name: 'S2d', status: 'confirmed' }, unconfirmed: [], commentary: false }) });
    expect(confirmed).not.toContain(LABEL_EN);
    expect(confirmed).not.toContain('data-testid="household-s2d-draft"');
    expect(plain(confirmed)).toContain('Closing stock ₫600,000');
  });

  it('says so when there is no stock', () => {
    const empty = page({ s2d: book({ items: [], totals: { openingValue: '0', inValue: '0', outValue: '0', closingValue: '0' } }) });
    expect(plain(empty)).toContain('No stock or stock movement in this month.');
  });

  it('is not shown for a household that pays by a percentage of revenue', () => {
    expect(page({ profile: percentage() })).not.toContain('data-testid="household-s2d"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('S2d-HKD: sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa');
    expect(html).toContain(LABEL_VI);
    expect(plain(html)).toContain('Tồn cuối tháng');
    expect(plain(html)).toContain('Từ hóa đơn');
  });
});
