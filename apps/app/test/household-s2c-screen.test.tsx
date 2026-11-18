// SPDX-License-Identifier: AGPL-3.0-only
// The S2c-HKD book on the household screen (#2517 slice 2b), rendered on the server with the API's answers seeded: shown only for a method that keeps S2c (the income method), the revenue rows, the expense
// rows with account and group, the total per group, the expense total and the income; the provisional label on every figure that depends on a rule while a row behind it is unconfirmed (and none once
// confirmed), the income held back while an expense account has no group (the Excel button stays on), and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdS1a, HouseholdS2c } from '@crove/kernel-contract';

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
const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const GROUPS = ['materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other'] as const;
const groups = (amounts: Partial<Record<(typeof GROUPS)[number], string>>) => GROUPS.map((group) => ({ group, amount: amounts[group] ?? '0' }));

const income = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods'], einvoiceRegistered: true, representativeName: 'Nguyễn Văn A' },
  books: [{ book: 'S2c', version: '2026.1', name: 'Sổ chi tiết doanh thu, chi phí (S2c-HKD)', status: 'commentary' }],
  commentary: true,
});
const percentage = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods'], einvoiceRegistered: false, representativeName: null },
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
const book = (over: Partial<HouseholdS2c> = {}): HouseholdS2c => ({
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2c', version: '2026.1', name: 'Sổ chi tiết doanh thu, chi phí (S2c-HKD)', status: 'commentary' },
  revenueRows: [{ entryId: E(1), date: '2026-11-03', reference: '1C26TAA-00000042', description: 'Bán hàng', amount: '5000000', reversal: false }],
  revenue: '5000000',
  expenseRows: [
    { entryId: E(2), lineNo: 1, date: '2026-11-04', reference: 'AA-0001', description: 'Mua hàng về bán', accountCode: '632', group: 'materials_goods', amount: '3000000', reversal: false },
    { entryId: E(3), lineNo: 2, date: '2026-11-12', reference: null, description: 'Đảo một khoản chi', accountCode: '642', group: 'other', amount: '-100000', reversal: true },
  ],
  groups: groups({ materials_goods: '3000000', other: '-100000' }),
  unmapped: '0',
  unmappedGross: '0',
  expenseTotal: '2900000',
  income: '2100000',
  unconfirmed: [
    { kind: 'form', key: 'S2c 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'group', key: '632', effectiveFrom: '2026-01-01' },
    { kind: 'group', key: '642', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-s2c-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-s2c-download"/;
const count = (html: string, text: string) => html.split(text).length - 1;
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function page(seed: { profile?: HouseholdProfileView; s2c?: HouseholdS2c } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? income());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2c'], seed.s2c ?? book());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the S2c-HKD book on the household screen (#2517 slice 2b)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the book for the income method: the revenue, the expense rows with account and group, the totals and the income', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2c"');
    expect(html).toContain('S2c-HKD: revenue and expense detail');
    expect(html).toContain('1C26TAA-00000042');
    expect(html).toContain('AA-0001');
    expect(html).toContain('data-testid="household-s2c-group-materials_goods"');
    expect(html).toContain('data-testid="household-s2c-notice"');
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
    // S2c is built, so it is no longer listed as "not built yet", and the percentage method's book is not shown.
    expect(html).not.toContain('(not built yet)');
    expect(html).not.toContain('data-testid="household-s2a"');
    const text = plain(html);
    expect(text).toContain('Total ₫5,000,000');
    expect(text).toContain('Mua hàng về bán 632 Materials and goods ₫3,000,000');
    expect(text).toContain('reversal 642 Other expenses -₫100,000');
    expect(text).toContain('Total expenses ₫2,900,000');
    expect(text).toContain('Income (revenue less expenses) ₫2,100,000');
  });

  it('labels every figure that depends on a rule while a row behind it is unconfirmed: each group, the expense total and the income, the same words for a screen reader in the group amounts', () => {
    const html = page();
    expect(html).toContain('data-testid="household-s2c-draft"');
    // Six groups, the expense total and the income: eight visible labels.
    expect(count(html, 'data-testid="household-s2c-provisional"')).toBe(8);
    expect(count(html, `<span class="sr-only">${LABEL_EN}</span>`)).toBe(6);
    expect(html).toContain('The expense group of account 632');
  });

  it('carries no label and no draft box once every row is confirmed', () => {
    const html = page({ s2c: book({ form: { book: 'S2c', version: '2026.2', name: 'S2c', status: 'confirmed' }, unconfirmed: [], commentary: false }) });
    expect(html).not.toContain(LABEL_EN);
    expect(html).not.toContain('data-testid="household-s2c-draft"');
    expect(html).not.toContain('data-testid="household-s2c-provisional"');
    expect(plain(html)).toContain('Income (revenue less expenses) ₫2,100,000');
  });

  it('holds the income back while an expense account has no group, says why, and still offers the Excel file', () => {
    const html = page({
      s2c: book({
        expenseRows: [{ entryId: E(2), lineNo: 1, date: '2026-11-04', reference: null, description: 'Thuê nhà', accountCode: '641', group: null, amount: '700000', reversal: false }],
        groups: groups({}),
        unmapped: '700000',
        unmappedGross: '700000',
        expenseTotal: '700000',
        income: null,
      }),
    });
    expect(html).toContain('data-testid="household-s2c-unmapped"');
    expect(html).toContain('data-testid="household-s2c-group-unmapped"');
    expect(html).toContain('No group yet');
    const text = plain(html);
    expect(text).toContain('₫700,000 of expenses have no group yet');
    // The income is blank, never a figure built on a guess.
    expect(html).toMatch(/data-testid="household-s2c-income"[^>]*><span/);
    expect(html).not.toMatch(DOWNLOAD_DISABLED);
  });

  it('is not shown for a household that pays by a percentage of revenue', () => {
    const html = page({ profile: percentage() });
    expect(html).not.toContain('data-testid="household-s2c"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('S2c-HKD: sổ chi tiết doanh thu, chi phí');
    expect(html).toContain(LABEL_VI);
    expect(html).toContain('Nguyên liệu, vật liệu, hàng hóa');
    expect(html).toContain('Thu nhập (doanh thu trừ chi phí)');
  });
});
