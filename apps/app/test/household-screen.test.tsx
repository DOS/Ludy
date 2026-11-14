// SPDX-License-Identifier: AGPL-3.0-only
// The household books screen (#2517), rendered on the server with the API's answers seeded in the cache: the profile with its books and the notice that the rules wait for the accountant, the
// S1a table with its total only for a method that keeps S1a, the profile button for owners and admins only, the empty state with no household entity, and the quarterly worksheet 01/CNKD (#2518)
// only for the percentage method: its draft banner while a rule is unconfirmed, the totals held back while revenue has no trade, the split inputs of a household with several trades.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdCnkd, HouseholdProfileView, HouseholdS1a } from '@crove/kernel-contract';

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

const profile = (over: Partial<HouseholdProfileView> = {}): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A' },
  books: [{ book: 'S1a', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S1a-HKD)', status: 'commentary' }],
  commentary: true,
  ...over,
});
const s1a: HouseholdS1a = {
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S1a', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S1a-HKD)', status: 'commentary' },
  rows: [{ entryId: '00000000-0000-4000-8000-000000000001', date: '2026-11-03', reference: '1C26TAA-00000042', description: 'Bán có hóa đơn', amount: '100000', reversal: false }],
  total: '100000',
};
// The attribute, not the class text (the button's classes mention `disabled:`).
const DOWNLOAD_DISABLED = /<button[^>]*data-testid="household-cnkd-download"[^>]*\sdisabled=""|<button[^>]*\sdisabled=""[^>]*data-testid="household-cnkd-download"/;
const cnkd = (over: Partial<HouseholdCnkd> = {}): HouseholdCnkd => ({
  period: { year: 2026, quarter: 4, from: '2026-10-01', to: '2026-12-31' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A' },
  form: { form: '01/CNKD', version: '2026.1', name: 'Tờ khai 01/CNKD', status: 'commentary' },
  revenue: '1600000',
  lines: [{ trade: 'goods', revenue: '1600000', vatPercent: '1', pitPercent: '0.5', vat: '16000', pit: '8000' }],
  unassigned: '0',
  totals: { revenue: '1600000', vat: '16000', pit: '8000', tax: '24000' },
  withheld: { total: '4200', settlements: [{ id: '00000000-0000-4000-8000-0000000000a1', platform: 'shopee', periodStart: '2026-10-01', periodEnd: '2026-10-15', taxWithheld: '4200' }] },
  due: '19800',
  overpaid: '0',
  unconfirmed: [
    { kind: 'form', key: '01/CNKD 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});
const percentage = (trades: Array<'goods' | 'services'> = ['goods']): HouseholdProfileView =>
  profile({
    profile: { effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades, einvoiceRegistered: false, representativeName: 'Nguyễn Văn A' },
    books: [{ book: 'S2a', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2a-HKD)', status: 'commentary' }],
  });
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };

function page(role: 'owner' | 'admin' | 'member' | 'viewer', seed: { entities?: unknown[]; profile?: HouseholdProfileView; cnkd?: HouseholdCnkd } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role });
  qc.setQueryData(['bookEntities', 'list'], seed.entities ?? [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? profile());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 'cnkd'], seed.cnkd ?? cnkd());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the household books screen (#2517)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the profile, its books, the notice about the rules and the S1a table with its total', () => {
    const html = page('owner');
    expect(html).toContain('data-testid="household-profile"');
    expect(html).toContain('Group 1: no VAT, no personal income tax');
    expect(html).toContain('data-testid="household-books"');
    expect(html).toContain('S1a-HKD');
    expect(html).toContain('data-testid="household-commentary"');
    expect(html).toContain('data-testid="household-s1a"');
    expect(html).toContain('1C26TAA-00000042');
    expect(html).toContain('data-testid="household-s1a-total"');
    expect(html).toContain('data-testid="household-profile-edit"');
  });

  it('offers the profile button to owners and admins only', () => {
    expect(page('admin')).toContain('data-testid="household-profile-edit"');
    for (const role of ['member', 'viewer'] as const) {
      cache.current.clear();
      const html = page(role);
      expect(html).not.toContain('data-testid="household-profile-edit"');
      expect(html).toContain('data-testid="household-s1a"');
    }
  });

  it('shows no S1a for a method that keeps other books, and says the others are not built yet', () => {
    const html = page('owner', {
      profile: profile({
        profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods', 'services'], einvoiceRegistered: true, representativeName: null },
        books: [{ book: 'S2b', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', status: 'commentary' }],
      }),
    });
    expect(html).not.toContain('data-testid="household-s1a"');
    expect(html).toContain('S2b-HKD');
    expect(html).toContain('(not built yet)');
    expect(html).toContain('Goods, Services');
  });

  it('asks to set a profile when there is none, and shows the empty state with no household entity', () => {
    expect(page('owner', { profile: profile({ profile: null, books: [], commentary: false }) })).toContain('No profile yet');
    cache.current.clear();
    const html = page('owner', { entities: [{ ...entity, kind: 'company' }] });
    expect(html).toContain('No household business yet');
    expect(html).not.toContain('data-testid="household-profile"');
  });

  it('is in Vietnamese too', () => {
    const html = page('owner', {}, 'vi');
    expect(html).toContain('Sổ hộ kinh doanh');
    expect(html).toContain('Nhóm 1: không nộp thuế GTGT, thuế TNCN');
  });

  describe('the 01/CNKD quarterly worksheet (#2518)', () => {
    it('shows revenue by trade, the totals, the withheld tax and what is left to pay, as a draft while a rule is unconfirmed', () => {
      const html = page('owner', { profile: percentage() });
      expect(html).toContain('data-testid="household-cnkd"');
      expect(html).toContain('01/CNKD: quarterly return worksheet');
      // It says it files nothing, and the brand placeholder is filled.
      expect(html).toContain('data-testid="household-cnkd-notice"');
      expect(html).toContain('does not file the return');
      expect(html).not.toContain('{brand}');
      expect(html).toContain('data-testid="household-cnkd-draft"');
      expect(html).toContain('The form 01/CNKD 2026.1');
      expect(html).toContain('The percentages for Goods');
      expect(html).toContain('data-testid="household-cnkd-tax"');
      expect(html).toContain('data-testid="household-cnkd-due"');
      expect(html).toContain('shopee');
      // The Excel stays off while the rules are a draft.
      expect(html).toMatch(DOWNLOAD_DISABLED);
      // One trade has nothing to split.
      expect(html).not.toContain('data-testid="household-cnkd-split"');
    });

    it('offers the download once every row is confirmed and shows no draft banner', () => {
      const html = page('owner', { profile: percentage(), cnkd: cnkd({ commentary: false, unconfirmed: [], form: { form: '01/CNKD', version: '2026.2', name: 'Tờ khai 01/CNKD', status: 'confirmed' } }) });
      expect(html).not.toContain('data-testid="household-cnkd-draft"');
      expect(html).toContain('data-testid="household-cnkd-download"');
      expect(html).not.toMatch(DOWNLOAD_DISABLED);
    });

    it('asks a household with several trades for the split and holds the totals back while revenue has no trade', () => {
      const html = page('owner', {
        profile: percentage(['goods', 'services']),
        cnkd: cnkd({
          unassigned: '1600000',
          totals: null,
          due: null,
          lines: [
            { trade: 'goods', revenue: '0', vatPercent: '1', pitPercent: '0.5', vat: '0', pit: '0' },
            { trade: 'services', revenue: '0', vatPercent: '5', pitPercent: '2', vat: '0', pit: '0' },
          ],
        }),
      });
      expect(html).toContain('data-testid="household-cnkd-split"');
      expect(html).toContain('data-testid="household-cnkd-unassigned"');
      expect(html).not.toContain('data-testid="household-cnkd-totals"');
    });

    it('does not warn about the split before anything is typed', () => {
      const html = page('owner', { profile: percentage(['goods', 'services']) });
      expect(html).not.toContain('data-testid="household-cnkd-split-invalid"');
    });

    it('shows no worksheet for group 1 or the income method, and every role reads it', () => {
      expect(page('owner')).not.toContain('data-testid="household-cnkd"');
      cache.current.clear();
      const income = profile({ profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods'], einvoiceRegistered: false, representativeName: null }, books: [] });
      expect(page('owner', { profile: income })).not.toContain('data-testid="household-cnkd"');
      for (const role of ['admin', 'member', 'viewer'] as const) {
        cache.current.clear();
        expect(page(role, { profile: percentage() })).toContain('data-testid="household-cnkd"');
      }
    });

    it('is in Vietnamese too', () => {
      const html = page('owner', { profile: percentage() }, 'vi');
      expect(html).toContain('01/CNKD: bảng tính tờ khai theo quý');
      expect(html).toContain('không nộp tờ khai');
      expect(html).toContain('Còn phải nộp');
    });
  });
});
