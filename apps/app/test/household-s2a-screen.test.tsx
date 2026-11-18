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
  profile: { effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods', 'services'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A', vatCutEligible: null },
  books: [{ book: 'S2a', version: '2026.1', name: 'Sổ doanh thu theo ngành nghề (S2a-HKD)', status: 'commentary' }],
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
  vatCut: { answer: 'no', percent: '20.0000', applied: false, lines: [], total: null, ifEligible: null },
  yearToDate: { year: 2026, revenueToDate: '1500000', revenueBefore: '0', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: false, deductionTrade: null, deductionNeeded: false, payable: { vatBefore: '0', vatCut: '0', vat: '0', pitBefore: '0', pitCut: '0', pit: '0' }, pitCut: null },
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
    // The amounts themselves, not only the table structure: each entry's parts and amount (the reversal negative), the total, the revenue and tax per line and the tax total.
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Goods: ₫600,000 Services: ₫400,000 ₫1,000,000');
    expect(text).toContain('reversal Goods: -₫100,000 -₫100,000');
    expect(text).toContain('Total ₫900,000');
    expect(text).toContain('₫500,000 1 ₫5,000');
    expect(text).toContain('₫400,000 5 ₫20,000');
    expect(text).toContain('0.5 ₫2,500');
    expect(text).toContain('2 ₫8,000');
    expect(text).toContain('₫35,500');
    expect(html).toContain('data-testid="household-s2a-notice"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    // S2a is built, so it is no longer listed as "not built yet".
    expect(html).not.toContain('(not built yet)');
  });

  it('labels every figure that depends on a rule while a row behind it is unconfirmed: once under each line and the tax, the same words for a screen reader in the VAT and PIT cells', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2a-draft"');
    // Two lines and the total tax: three visible labels, and two more under the period's VAT and PIT payable of the yearly section.
    expect(count(html, 'data-testid="household-s2a-provisional"')).toBe(5);
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

describe('the Decree 174 VAT cut on the S2a screen (#3710 slice 2)', () => {
  beforeEach(() => cache.current.clear());
  const lines = [
    { trade: 'goods' as const, cut: '1000', vatPayable: '4000' },
    { trade: 'services' as const, cut: '4000', vatPayable: '16000' },
  ];

  it('shows the cut and the VAT to pay after it when the profile answered yes', () => {
    const html = page({ s2a: book({ vatCut: { answer: 'yes', percent: '20.0000', applied: true, lines, total: { cut: '5000', vatPayable: '20000' }, ifEligible: null } }) });
    expect(html).toContain('data-testid="household-s2a-vatcut"');
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('VAT cut 20.0000% (Decree 174) ₫5,000');
    expect(text).toContain('VAT to pay after the cut ₫20,000');
    expect(html).not.toContain('data-testid="household-s2a-vatcut-ask"');
  });

  it('says what the VAT would be if eligible when the profile has not answered, and shows no cut row', () => {
    const html = page({ s2a: book({ vatCut: { answer: null, percent: '20.0000', applied: false, lines: [], total: { cut: '0', vatPayable: '25000' }, ifEligible: { cut: '5000', vatPayable: '20000' } } }) });
    expect(html).toContain('data-testid="household-s2a-vatcut-ask"');
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('If the household is eligible, the VAT would be ₫20,000 (cut by ₫5,000)');
    expect(html).not.toContain('data-testid="household-s2a-vatcut"');
  });

  it('shows nothing about the cut when the answer is no', () => {
    const html = page();
    expect(html).not.toContain('household-s2a-vatcut');
  });

  it('lists the unconfirmed cut among the rows behind a provisional book', () => {
    const html = page({ s2a: book({ unconfirmed: [{ kind: 'reduction', key: 'vat', effectiveFrom: '2026-01-01' }] }) });
    expect(html.replace(/<[^>]*>/g, ' ')).toContain('The VAT cut of Decree 174, from');
  });

  it('marks the cut figures provisional while the book is, and not when it is confirmed', () => {
    const cut = { answer: 'yes' as const, percent: '20.0000', applied: true, lines, total: { cut: '5000', vatPayable: '20000' }, ifEligible: null };
    const provisional = page({ s2a: book({ vatCut: cut }) });
    const block = provisional.slice(provisional.indexOf('data-testid="household-s2a-vatcut"'), provisional.indexOf('data-testid="household-s2a-vatcut"') + 1500);
    expect(block).toContain('data-testid="household-s2a-provisional"');
    const confirmed = page({ s2a: book({ vatCut: cut, commentary: false, unconfirmed: [] }) });
    const confirmedBlock = confirmed.slice(confirmed.indexOf('data-testid="household-s2a-vatcut"'), confirmed.indexOf('data-testid="household-s2a-vatcut"') + 1500);
    expect(confirmedBlock).not.toContain('household-s2a-provisional');
  });
});

describe('the yearly threshold on the S2a screen (#3710 slice 3)', () => {
  beforeEach(() => cache.current.clear());
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const base = book().yearToDate;
  const crossed = (over: Partial<HouseholdS2a['yearToDate']> = {}): HouseholdS2a['yearToDate'] => ({
    ...base,
    revenueToDate: '1200000000',
    revenueBefore: '1100000000',
    crossed: true,
    deductionTrade: 'goods',
    payable: { vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '1000000', pitCut: '300000', pit: '700000' },
    pitCut: { percent: '30.0000', ceiling: '3000000000', applied: true },
    ...over,
  });

  it('says nothing is owed yet below the threshold', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2a-ytd"');
    expect(html).toContain('data-testid="household-s2a-ytd-threshold"');
    expect(text(html)).toContain('has not passed the threshold, so no tax is owed yet');
    expect(html).not.toContain('household-s2a-ytd-deduction');
  });

  it('shows the revenue, the VAT and PIT payable and the PIT cut once the threshold is crossed', () => {
    const html = page({ s2a: book({ yearToDate: crossed() }) });
    const t = text(html);
    expect(t).toContain('₫1,200,000,000');
    expect(t).toContain('has passed the threshold');
    expect(t).toContain('VAT to pay for the period ₫9,600,000');
    expect(t).toContain('PIT to pay for the period ₫700,000');
    expect(t).toContain('PIT cut 30.0000% ₫300,000');
    expect(html).not.toContain('household-s2a-ytd-deduction');
    const block = html.slice(html.indexOf('data-testid="household-s2a-ytd-payable"'));
    expect(block).toContain('data-testid="household-s2a-provisional"');
  });

  it('asks which trade takes the deduction and shows no PIT figure while it is held back', () => {
    const html = page({ s2a: book({ yearToDate: crossed({ deductionTrade: null, deductionNeeded: true, payable: null, pitCut: null }) }) });
    expect(html).toContain('data-testid="household-s2a-ytd-deduction"');
    expect(text(html)).toContain('Which trade takes the 1 billion dong deduction for PIT?');
    expect(html).toContain('value="goods"');
    expect(html).toContain('value="services"');
    expect(html).not.toContain('household-s2a-ytd-pit"');
    expect(html).not.toContain('household-s2a-ytd-payable');
  });

  it('lists the unconfirmed threshold and the PIT cut among the rows behind a provisional book', () => {
    const html = page({ s2a: book({ unconfirmed: [{ kind: 'threshold', key: 'no_tax_revenue', effectiveFrom: '2026-01-01' }, { kind: 'reduction', key: 'pit', effectiveFrom: '2026-01-01' }] }) });
    const t = text(html);
    expect(t).toContain('The yearly revenue threshold below which no tax is owed, from');
    expect(t).toContain('The personal income tax cut, from');
  });
});
