// SPDX-License-Identifier: AGPL-3.0-only
// The S2a-HKD book on the household screen (#2517 slice 2a), rendered on the server with the API's answers seeded: shown only for a method that keeps S2a (the percentage method), the rows with their
// amount by business line, the total, the revenue and tax per line; the provisional label on every figure that depends on a rule while a row behind it is unconfirmed (and none once confirmed), the
// totals held back while revenue has no business line yet (the Excel button stays on), and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdS1a, HouseholdS2a } from '@crove/kernel-contract';

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

const percentage = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods', 'services'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A' },
  books: [{ book: 'S2a', version: '2026.1', name: 'Sổ doanh thu theo ngành nghề (S2a-HKD)', status: 'commentary' }],
  commentary: true,
});
const group1 = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: null },
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
const book = (over: Partial<HouseholdS2a> = {}): HouseholdS2a => ({
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2a', version: '2026.1', name: 'Sổ doanh thu theo ngành nghề (S2a-HKD)', status: 'commentary' },
  rows: [
    { entryId: E1, date: '2026-11-03', reference: '1C26TAA-00000042', description: 'Bán hàng và sửa chữa', amount: '1000000', reversal: false, parts: [{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }] },
    { entryId: E2, date: '2026-11-10', reference: null, description: 'Đảo bán lẻ', amount: '-100000', reversal: true, parts: [{ trade: 'goods', amount: '-100000' }] },
  ],
  total: '900000',
  lines: [
    { trade: 'goods', revenue: '500000', vatPercent: '1', pitPercent: '0.5', vat: '5000', pit: '2500' },
    { trade: 'services', revenue: '400000', vatPercent: '5', pitPercent: '2', vat: '20000', pit: '8000' },
  ],
  unassigned: '0',
  unassignedGross: '0',
  totals: { revenue: '900000', vat: '25000', pit: '10500', tax: '35500' },
  unconfirmed: [
    { kind: 'form', key: 'S2a 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'services', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-s2a-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-s2a-download"/;
const count = (html: string, text: string) => html.split(text).length - 1;

function page(seed: { profile?: HouseholdProfileView; s2a?: HouseholdS2a } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? percentage());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2a'], seed.s2a ?? book());
  qc.setQueryData(['household', 'cnkd'], undefined);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the S2a-HKD book on the household screen (#2517 slice 2a)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the book for the percentage method: the entries by business line, the total, the revenue and tax per line', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2a"');
    expect(html).toContain('S2a-HKD: revenue book by business line');
    expect(html).toContain('1C26TAA-00000042');
    expect(html).toContain('data-testid="household-s2a-part-services"');
    expect(html).toContain('data-testid="household-s2a-total"');
    expect(html).toContain('data-testid="household-s2a-totals"');
    expect(html).toContain('data-testid="household-s2a-notice"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    // S2a is built, so it is no longer listed as "not built yet".
    expect(html).not.toContain('(not built yet)');
  });

  it('labels every figure that depends on a rule while a row behind it is unconfirmed: once under each line and the tax, the same words for a screen reader in the VAT and PIT cells', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2a-draft"');
    // Two lines and the total tax: three visible labels.
    expect(count(html, 'data-testid="household-s2a-provisional"')).toBe(3);
    // Two lines, two cells each: four labels for a screen reader (the draft box and the visible labels carry the words too).
    expect(count(html, `<span class="sr-only">${LABEL_EN}</span>`)).toBe(4);
    expect(html).toContain('S2a 2026.1');
  });

  it('carries no label and no draft box once every row is confirmed', () => {
    const html = page({ s2a: book({ form: { book: 'S2a', version: '2026.2', name: 'S2a', status: 'confirmed' }, unconfirmed: [], commentary: false }) });
    expect(html).not.toContain(LABEL_EN);
    expect(html).not.toContain('data-testid="household-s2a-draft"');
    expect(html).not.toContain('data-testid="household-s2a-provisional"');
    expect(html).toContain('data-testid="household-s2a-totals"');
  });

  it('holds the tax total back while revenue has no business line, says why, and still offers the Excel file', () => {
    const html = page({
      s2a: book({
        rows: [{ entryId: E1, date: '2026-11-03', reference: null, description: 'Đối soát sàn', amount: '300000', reversal: false, parts: [{ trade: 'unassigned', amount: '300000' }] }],
        total: '300000',
        lines: [
          { trade: 'goods', revenue: '0', vatPercent: '1', pitPercent: '0.5', vat: '0', pit: '0' },
          { trade: 'services', revenue: '0', vatPercent: '5', pitPercent: '2', vat: '0', pit: '0' },
        ],
        unassigned: '300000',
        unassignedGross: '300000',
        totals: null,
      }),
    });
    expect(html).toContain('data-testid="household-s2a-unassigned"');
    expect(html).toContain('data-testid="household-s2a-part-unassigned"');
    expect(html).toContain('No business line yet');
    expect(html).not.toContain('data-testid="household-s2a-totals"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
  });

  it('is not shown for a household that keeps S1a only', () => {
    const html = page({ profile: group1() });
    expect(html).toContain('data-testid="household-s1a"');
    expect(html).not.toContain('data-testid="household-s2a"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('S2a-HKD: sổ doanh thu theo ngành nghề');
    expect(html).toContain(LABEL_VI);
    expect(html).toContain('Theo ngành nghề');
    expect(html).toContain('Hàng hóa');
  });
});
