// SPDX-License-Identifier: AGPL-3.0-only
// The S2b-HKD book on the household screen (#2517 slice 2c), rendered on the server with the API's answers seeded: shown only for a method that keeps S2b (the income method), the rows with their amount by
// business line, the total, the revenue and VAT per line and the VAT total, and no PIT column (the PIT of this method comes from income); the provisional label while a row behind the figures is unconfirmed
// (and none once confirmed), the VAT total held back while revenue has no business line yet (the Excel button stays on), and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdS1a, HouseholdS2b } from '@crove/kernel-contract';

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

const LABEL_EN = 'Provisional figures: the accountant has not confirmed the percentages yet';
const LABEL_VI = 'Số liệu tạm, kế toán chưa xác nhận tỷ lệ';
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';

const income = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods', 'services'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A', vatCutEligible: null },
  books: [{ book: 'S2b', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', status: 'commentary' }],
  commentary: true,
});
const group1 = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: null, vatCutEligible: null },
  books: [{ book: 'S1a', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S1a-HKD)', status: 'commentary' }],
  commentary: true,
});
const s1a: HouseholdS1a = {
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: null, openedOn: '2026-01-01' },
  form: { book: 'S1a', version: '2026.1', name: 'S1a', status: 'commentary' },
  rows: [],
  total: '0',
};
const book = (over: Partial<HouseholdS2b> = {}): HouseholdS2b => ({
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2b', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', status: 'commentary' },
  rows: [
    { entryId: E1, date: '2026-11-03', reference: '1C26TAA-00000042', description: 'Bán hàng và sửa chữa', amount: '1000000', reversal: false, parts: [{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }] },
    { entryId: E2, date: '2026-11-10', reference: null, description: 'Đảo bán lẻ', amount: '-100000', reversal: true, parts: [{ trade: 'goods', amount: '-100000' }] },
  ],
  total: '900000',
  lines: [
    { trade: 'goods', revenue: '500000', vatPercent: '1', vat: '5000' },
    { trade: 'services', revenue: '400000', vatPercent: '5', vat: '20000' },
  ],
  unassigned: '0',
  unassignedGross: '0',
  totals: { revenue: '900000', vat: '25000' },
  vatCut: { answer: 'no', percent: '20.0000', applied: false, lines: [], total: null, ifEligible: null },
  yearToDate: { year: 2026, revenueToDate: '1500000', revenueBefore: '0', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: false, deductionTrade: null, deductionNeeded: false, payable: { vatBefore: '0', vatCut: '0', vat: '0', pitBefore: '0', pitCut: '0', pit: '0' }, pitCut: null },
  unconfirmed: [
    { kind: 'form', key: 'S2b 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'services', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-s2b-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-s2b-download"/;
const count = (html: string, text: string) => html.split(text).length - 1;

function page(seed: { profile?: HouseholdProfileView; s2b?: HouseholdS2b } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? income());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2b'], seed.s2b ?? book());
  qc.setQueryData(['household', 'cnkd'], undefined);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the S2b-HKD book on the household screen (#2517 slice 2c)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the book for the income method: the entries by business line, the total, the revenue and VAT per line, and no PIT column', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2b"');
    expect(html).toContain('S2b-HKD: revenue book by business line');
    expect(html).toContain('1C26TAA-00000042');
    expect(html).toContain('data-testid="household-s2b-part-services"');
    expect(html).toContain('data-testid="household-s2b-total"');
    expect(html).toContain('data-testid="household-s2b-totals"');
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Goods: ₫600,000 Services: ₫400,000 ₫1,000,000');
    expect(text).toContain('reversal Goods: -₫100,000 -₫100,000');
    expect(text).toContain('Total ₫900,000');
    expect(text).toContain('₫500,000 1 ₫5,000');
    expect(text).toContain('₫400,000 5 ₫20,000');
    expect(text).toContain('VAT by percentage');
    expect(text).toContain('₫25,000');
    // The PIT of this method comes from income: no PIT column, percentage or total on this book.
    expect(html).not.toContain('Personal income tax %');
    expect(html).not.toContain('<th data-slot="table-head" class="h-10 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 px-4 text-xs font-medium text-subtle-foreground text-right">Personal income tax</th>');
    expect(html).not.toContain('household-s2a');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    expect(html).not.toContain('(not built yet)');
  });

  it('labels every figure that depends on a rule while a row behind it is unconfirmed: once under each line and the VAT total, the same words for a screen reader in the VAT cells', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2b-draft"');
    // Plus one under the period's VAT payable of the yearly section.
    expect(count(html, 'data-testid="household-s2b-provisional"')).toBe(4);
    expect(count(html, `<span class="sr-only">${LABEL_EN}</span>`)).toBe(2);
    expect(html).toContain('S2b 2026.1');
  });

  it('carries no label and no draft box once every row is confirmed', () => {
    const html = page({ s2b: book({ form: { book: 'S2b', version: '2026.2', name: 'S2b', status: 'confirmed' }, unconfirmed: [], commentary: false }) });
    expect(html).not.toContain(LABEL_EN);
    expect(html).not.toContain('data-testid="household-s2b-draft"');
    expect(html).not.toContain('data-testid="household-s2b-provisional"');
    expect(html).toContain('data-testid="household-s2b-totals"');
  });

  it('holds the VAT total back while revenue has no business line, says why, and still offers the Excel file', () => {
    const html = page({
      s2b: book({
        rows: [{ entryId: E1, date: '2026-11-03', reference: null, description: 'Đối soát sàn', amount: '300000', reversal: false, parts: [{ trade: 'unassigned', amount: '300000' }] }],
        total: '300000',
        lines: [
          { trade: 'goods', revenue: '0', vatPercent: '1', vat: '0' },
          { trade: 'services', revenue: '0', vatPercent: '5', vat: '0' },
        ],
        unassigned: '300000',
        unassignedGross: '300000',
        totals: null,
      }),
    });
    expect(html).toContain('data-testid="household-s2b-unassigned"');
    expect(html).toContain('data-testid="household-s2b-part-unassigned"');
    expect(html).toContain('No business line yet');
    expect(html).not.toContain('data-testid="household-s2b-totals"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
  });

  it('is not shown for a household that keeps S1a only', () => {
    const html = page({ profile: group1() });
    expect(html).toContain('data-testid="household-s1a"');
    expect(html).not.toContain('data-testid="household-s2b"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('S2b-HKD: sổ doanh thu theo ngành nghề');
    expect(html).toContain(LABEL_VI);
    expect(html).toContain('Thuế GTGT theo tỷ lệ');
    expect(html).toContain('Hàng hóa');
  });
});

describe('the yearly threshold on the S2b screen (#3710 slice 3)', () => {
  beforeEach(() => cache.current.clear());
  it('shows the VAT payable once the threshold is crossed, never a PIT figure or a deduction question', () => {
    const base = book().yearToDate;
    const html = page({ s2b: book({ yearToDate: { ...base, revenueToDate: '1200000000', crossed: true, payable: { vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '0', pitCut: '0', pit: '0' } } }) });
    const t = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(html).toContain('data-testid="household-s2b-ytd"');
    expect(t).toContain('VAT to pay for the period ₫9,600,000');
    expect(t).not.toContain('PIT to pay for the period');
    expect(html).not.toContain('household-s2b-ytd-deduction');
  });
});
