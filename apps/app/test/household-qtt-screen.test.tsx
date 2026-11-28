// SPDX-License-Identifier: AGPL-3.0-only
// The annual PIT finalization worksheet 02/CNKD-TNCN-QTT on the household screen (#5285 PR 2a), rendered on the server with the API's answers seeded: shown only for the income method, the lines [09] to [20]
// with their codes and the rate band, the three amounts the household types (whole dong), the provisional label on the figures that depend on a rule while a row behind them is unconfirmed (and none once
// confirmed), what is held and why, the 30% cut before and after (and its note only when the memo is not shown), and the same in Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdProfileView, HouseholdQtt, HouseholdS1a, HouseholdS2c } from '@ludy/kernel-contract';

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
const count = (html: string, text: string) => html.split(text).length - 1;
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

const income = (): HouseholdProfileView => ({
  date: '2026-11-09',
  profile: { effectiveFrom: '2026-01-01', taxGroup: 3, pitMethod: 'income', trades: ['goods'], einvoiceRegistered: true, representativeName: 'Nguyễn Văn A', vatCutEligible: null },
  books: [{ book: 'S2c', version: '2026.1', name: 'Sổ chi tiết doanh thu, chi phí (S2c-HKD)', status: 'commentary' }],
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
const s2c: HouseholdS2c = {
  period: { period: '2026-11', from: '2026-11-01', to: '2026-11-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2c', version: '2026.1', name: 'S2c', status: 'commentary' },
  revenueRows: [{ entryId: E(1), date: '2026-11-03', reference: null, description: 'Bán hàng', amount: '5000000', reversal: false }],
  revenue: '5000000',
  expenseRows: [],
  groups: [],
  unmapped: '0',
  unmappedGross: '0',
  expenseTotal: '0',
  income: '5000000',
  unconfirmed: [],
  commentary: false,
};

const LABELS: Record<string, string> = {
  '09': 'Doanh thu',
  '09a': 'Doanh thu ngoài sàn',
  '09b': 'Doanh thu sàn đã khấu trừ',
  '09c': 'Doanh thu sàn không thanh toán',
  '10': 'Các khoản chi được trừ',
  '10a': 'Chi phí nguyên liệu',
  '10b': 'Chi phí tiền lương',
  '10c': 'Chi phí khấu hao',
  '10d': 'Chi phí dịch vụ mua ngoài',
  '10đ': 'Chi phí lãi vay',
  '10e': 'Chi khác',
  '11': 'Thu nhập tính thuế',
  '12': 'Thuế suất',
  '13': 'Số thuế phát sinh',
  '14': 'Thuế đã khấu trừ',
  '15': 'Thuế đã tạm nộp',
  '16': 'Thuế được giảm',
  '17': 'Tổng số thuế còn phải nộp',
  '18': 'Thuế được miễn',
  '19': 'Còn phải nộp sau miễn',
  '20': 'Nộp thừa',
};
const FULL: Record<string, string> = {
  '09': '1800000000',
  '09a': '1500000000',
  '09b': '300000000',
  '09c': '0',
  '10': '870000000',
  '10a': '700000000',
  '10b': '0',
  '10c': '0',
  '10d': '0',
  '10đ': '20000000',
  '10e': '150000000',
  '11': '930000000',
  '12': '15',
  '13': '139500000',
  '14': '10000000',
  '15': '50000000',
  '16': '0',
  '17': '79500000',
  '18': '0',
  '19': '79500000',
  '20': '0',
};
const linesOf = (amounts: Record<string, string | null>) => Object.keys(LABELS).map((code) => ({ code, label: LABELS[code] ?? code, amount: amounts[code] ?? null }));
const settledBefore = { tax: '139500000', payable: '79500000', exempt: '0', due: '79500000', overpaid: '0' };
const settledAfter = { tax: '97650000', payable: '37650000', exempt: '0', due: '37650000', overpaid: '0' };

const qtt = (over: Partial<HouseholdQtt> = {}): HouseholdQtt => ({
  period: { year: 2026, from: '2026-01-01', to: '2026-12-31', ended: false },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A' },
  form: { form: '02/CNKD-TNCN-QTT', version: '2026.1', name: 'Tờ khai quyết toán', status: 'commentary' },
  lines: linesOf(FULL),
  rate: { revenueOver: '0', percent: '15', effectiveFrom: '2026-01-01', status: 'commentary' },
  threshold: '1000000000',
  unmappedCosts: '0',
  holds: [],
  notes: ['costs_not_checked', 'reduction_not_in_form'],
  entered: { withheld: '10000000', prepaid: '50000000', noPaymentRevenue: '0' },
  reduction: { percent: '30', ceiling: '10000000000', applies: true, cut: '41850000', before: settledBefore, after: settledAfter, effectiveFrom: '2026-01-01', status: 'commentary' },
  unconfirmed: [
    { kind: 'form', key: '02/CNKD-TNCN-QTT 2026.1', effectiveFrom: '2026-07-01' },
    { kind: 'rate', key: '15%', effectiveFrom: '2026-01-01' },
    { kind: 'group', key: '632', effectiveFrom: '2026-01-01' },
    { kind: 'reduction', key: 'pit', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});
const entity = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hộ kinh doanh Nguyễn Văn A', kind: 'household', taxCode: null, isDefault: false };

function page(seed: { profile?: HouseholdProfileView; qtt?: HouseholdQtt } = {}, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['org', 'get'], { role: 'owner' });
  qc.setQueryData(['bookEntities', 'list'], [entity]);
  qc.setQueryData(['household', 'profile'], seed.profile ?? income());
  qc.setQueryData(['household', 's1a'], s1a);
  qc.setQueryData(['household', 's2c'], s2c);
  qc.setQueryData(['household', 'qtt'], seed.qtt ?? qtt());
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HouseholdPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the 02/CNKD-TNCN-QTT worksheet on the household screen (#5285)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the worksheet for the income method: every line with its code, the rate band, the notice, and the three amounts the household types', () => {
    const html = page();
    expect(html).toContain('data-testid="household-qtt"');
    expect(html).toContain('02/CNKD-TNCN-QTT: annual personal income tax finalization worksheet');
    expect(html).toContain('data-testid="household-qtt-notice"');
    for (const code of Object.keys(LABELS)) expect(html, code).toContain(`data-testid="household-qtt-line-${code}"`);
    const text = plain(html);
    expect(text).toContain('[09] Doanh thu ₫1,800,000,000');
    expect(text).toContain('[11] Thu nhập tính thuế ₫930,000,000');
    // The rate is a percentage, never money.
    expect(text).toContain('[12] Thuế suất 15%');
    expect(text).toContain('[13] Số thuế phát sinh ₫139,500,000');
    expect(text).toContain('[17] Tổng số thuế còn phải nộp ₫79,500,000');
    expect(text).toContain('The rate [12] is 15% (revenue band above ₫0)');
    expect(text).toContain('Year 2026, from');
    // The three amounts are typed for the ask only: three labelled fields, no error before anything is typed.
    expect(html).toContain('data-testid="household-qtt-entered"');
    expect(text).toContain('[14] Tax withheld by platforms (dong)');
    expect(text).toContain('[15] Tax prepaid in the year (dong)');
    expect(text).toContain('[09c] Revenue on platforms with no payment function (dong)');
    expect(html).not.toContain('data-testid="household-qtt-invalid"');
    // There is no file to download yet (the Excel file is the next step), and the percentage method's worksheet is not here.
    expect(html).not.toContain('household-qtt-download');
    expect(html).not.toContain('data-testid="household-cnkd"');
  });

  it('labels every figure that depends on a rule while a row behind it is unconfirmed, and lists the rows', () => {
    const html = page();
    expect(html).toContain('data-testid="household-qtt-draft"');
    // Fourteen lines depend on a rule: the costs, the income, the rate, the tax and what is left to pay.
    expect(count(html, 'data-testid="household-qtt-provisional"')).toBe(14);
    expect(html).toContain(LABEL_EN);
    const text = plain(html);
    expect(text).toContain('The tax rate 15% of the revenue band, from');
    expect(text).toContain('The expense group of account 632, from');
    expect(text).toContain('The personal income tax cut, from');
  });

  it('carries no label and no draft box once every row is confirmed', () => {
    const html = page({ qtt: qtt({ commentary: false, unconfirmed: [], form: { form: '02/CNKD-TNCN-QTT', version: '2026.2', name: 'Tờ khai quyết toán', status: 'confirmed' } }) });
    expect(html).not.toContain(LABEL_EN);
    expect(html).not.toContain('data-testid="household-qtt-draft"');
    expect(html).not.toContain('data-testid="household-qtt-provisional"');
    expect(plain(html)).toContain('[13] Số thuế phát sinh ₫139,500,000');
  });

  it('shows the 30% cut before and after, says the lines are before it, and leaves the note about it to the memo', () => {
    const html = page();
    expect(html).toContain('data-testid="household-qtt-cut"');
    const text = plain(html);
    expect(text).toContain('30% personal income tax cut: figures before and after');
    expect(text).toContain('so lines [13] to [20] above are the figures BEFORE it');
    expect(text).toContain('Tax due [13] ₫139,500,000 ₫97,650,000');
    expect(text).toContain('Amount cut ₫0 ₫41,850,000');
    expect(text).toContain('Left to pay [17] ₫79,500,000 ₫37,650,000');
    expect(text).toContain('Left to pay after exemption [19] ₫79,500,000 ₫37,650,000');
    // The note repeats what the memo already says, so it is not listed twice.
    expect(html).toContain('Ludy has not checked whether any cost is deductible');
    expect(html).not.toContain('The return has no line for the tax cut');
  });

  it('says there is no cut above the ceiling, and lists the note about the cut when there is no memo', () => {
    const above = page({ qtt: qtt({ reduction: { percent: '30', ceiling: '10000000000', applies: false, cut: '0', before: settledBefore, after: settledBefore, effectiveFrom: '2026-01-01', status: 'commentary' } }) });
    expect(plain(above)).toContain('The yearly revenue is above ₫10,000,000,000, so there is no cut.');
    const none = page({ qtt: qtt({ reduction: null }) });
    expect(none).not.toContain('data-testid="household-qtt-cut"');
    expect(none).toContain('The return has no line for the tax cut');
  });

  it('holds the tax back and says why: the lines that need the tax say "Held", and the reason is in a box', () => {
    const html = page({
      qtt: qtt({
        lines: linesOf({ '09': '900000000', '09a': '900000000', '09b': '0', '09c': '0', '10': '0', '10a': '0', '10b': '0', '10c': '0', '10d': '0', '10đ': '0', '10e': '0', '11': '900000000' }),
        holds: ['below_threshold'],
        rate: null,
        reduction: null,
      }),
    });
    expect(html).toContain('data-testid="household-qtt-hold-below_threshold"');
    const text = plain(html);
    expect(text).toContain('The yearly revenue does not exceed ₫1,000,000,000, so no personal income tax is due');
    expect(text).toContain('[13] Số thuế phát sinh Held');
    expect(text).toContain('[17] Tổng số thuế còn phải nộp Held');
    // A held line carries no label: there is no figure to label.
    expect(html).not.toMatch(/data-testid="household-qtt-line-13"[^>]*>(?:(?!<\/tr>).)*household-qtt-provisional/);
  });

  it('names the amount of costs without a group when that holds the income back', () => {
    const html = page({ qtt: qtt({ lines: linesOf({ '09': '1500000000', '10': '5000000', '10e': '5000000' }), holds: ['unmapped_costs'], unmappedCosts: '5000000', reduction: null, rate: null }) });
    expect(plain(html)).toContain('₫5,000,000 of costs have no group yet');
  });

  it('is not shown for a household that pays by a percentage of revenue', () => {
    const html = page({ profile: percentage() });
    expect(html).not.toContain('data-testid="household-qtt"');
  });

  it('is in Vietnamese too, with the label the owner asked for', () => {
    const html = page({}, 'vi');
    expect(html).toContain('02/CNKD-TNCN-QTT: bảng tính quyết toán thuế thu nhập cá nhân năm');
    expect(html).toContain(LABEL_VI);
    const text = plain(html);
    expect(text).toContain('[14] Thuế sàn đã khấu trừ (đồng)');
    expect(text).toContain('Giảm 30% thuế thu nhập cá nhân: số trước và sau khi giảm');
    expect(text).toContain('Thuế suất [12] là 15% (bậc doanh thu trên');
  });
});
