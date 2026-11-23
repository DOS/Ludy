// SPDX-License-Identifier: AGPL-3.0-only
// The S2e-HKD book on the household screen (#2517 slice 2e), rendered on the server with the API's answers seeded: shown only for a method that keeps S2e (the income method), one section per cash and bank account
// with its opening, rows and closing, the total of all accounts; the provisional label while the layout row is unconfirmed (and none once confirmed), a negative balance flagged, the Excel button on, and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdS1a, HouseholdS2e } from '@ludy/kernel-contract';

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
  books: [{ book: 'S2e', version: '2026.1', name: 'Sổ chi tiết tiền (S2e-HKD)', status: 'commentary' }],
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
const book = (over: Partial<HouseholdS2e> = {}): HouseholdS2e => ({
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2e', version: '2026.1', name: 'Sổ chi tiết tiền (S2e-HKD)', status: 'commentary' },
  accounts: [
    {
      accountCode: '111',
      accountName: 'Tiền mặt',
      opening: '500000',
      rows: [
        { entryId: E(1), lineNo: 1, date: '2026-11-03', reference: 'AA-0001', description: 'Bán hàng thu tiền mặt', counterAccounts: ['511'], cashIn: '1000000', cashOut: '0', balance: '1500000', reversal: false },
        { entryId: E(2), lineNo: 2, date: '2026-11-12', reference: null, description: 'Đảo một khoản thu', counterAccounts: ['511'], cashIn: '0', cashOut: '300000', balance: '1200000', reversal: true },
      ],
      totalIn: '1000000',
      totalOut: '300000',
      closing: '1200000',
      negative: false,
    },
  ],
  totals: { opening: '500000', in: '1000000', out: '300000', closing: '1200000' },
  unconfirmed: [{ kind: 'form', key: 'S2e 2026.1', effectiveFrom: '2026-01-01' }],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-s2e-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-s2e-download"/;
const count = (html: string, text: string) => html.split(text).length - 1;
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function page(seed: { profile?: HouseholdProfileView; s2e?: HouseholdS2e } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? income());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2e'], seed.s2e ?? book());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the S2e-HKD book on the household screen (#2517 slice 2e)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the book for the income method: a section per account with opening, rows, closing and the total of all accounts', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2e"');
    expect(html).toContain('S2e-HKD: cash and bank book');
    expect(html).toContain('data-testid="household-s2e-account-111"');
    expect(html).toContain('AA-0001');
    expect(html).toContain('data-testid="household-s2e-notice"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    expect(html).not.toContain('(not built yet)');
    expect(html).not.toContain('data-testid="household-s2a"');
    const text = plain(html);
    expect(text).toContain('Account 111 - Tiền mặt');
    expect(text).toContain('Opening balance ₫500,000');
    expect(text).toContain('Bán hàng thu tiền mặt 511 ₫1,000,000 ₫0 ₫1,500,000');
    expect(text).toContain('reversal 511 ₫0 ₫300,000 ₫1,200,000');
    expect(text).toContain('Closing balance ₫1,200,000');
    expect(text).toContain('All cash accounts: Closing balance ₫1,200,000');
  });

  it('labels the closing figures while the layout is unconfirmed, lists the row, and carries nothing once it is confirmed', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2e-draft"');
    expect(html).toContain(LABEL_EN);
    // One closing per account and the total of all accounts.
    expect(count(html, 'data-testid="household-s2e-provisional"')).toBe(2);
    const confirmed = page({ s2e: book({ form: { book: 'S2e', version: '2026.2', name: 'S2e', status: 'confirmed' }, unconfirmed: [], commentary: false }) });
    expect(confirmed).not.toContain(LABEL_EN);
    expect(confirmed).not.toContain('data-testid="household-s2e-draft"');
    expect(confirmed).not.toContain('data-testid="household-s2e-provisional"');
    expect(plain(confirmed)).toContain('Closing balance ₫1,200,000');
  });

  it('flags a negative balance and says so when there are no accounts', () => {
    const negative = page({ s2e: book({ accounts: [{ accountCode: '1121', accountName: 'Ngân hàng A', opening: '0', rows: [], totalIn: '0', totalOut: '0', closing: '-50000', negative: true }], totals: { opening: '0', in: '0', out: '0', closing: '-50000' } }) });
    expect(negative).toContain('data-testid="household-s2e-negative-1121"');
    expect(plain(negative)).toContain('Negative balance');
    const empty = page({ s2e: book({ accounts: [], totals: { opening: '0', in: '0', out: '0', closing: '0' } }) });
    expect(plain(empty)).toContain('No cash or bank balance or movement in this period.');
  });

  it('is not shown for a household that pays by a percentage of revenue', () => {
    const html = page({ profile: percentage() });
    expect(html).not.toContain('data-testid="household-s2e"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('S2e-HKD: sổ chi tiết tiền');
    expect(html).toContain(LABEL_VI);
    expect(plain(html)).toContain('Số dư cuối kỳ');
  });
});
