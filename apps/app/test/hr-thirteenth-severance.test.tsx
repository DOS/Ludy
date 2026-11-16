// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrEmployeeSeveranceResult, HrThirteenthMonthPreviewResult } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        payroll: {
          runs: { applyThirteenthMonth: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
  };
});

const { ThirteenthMonthPanel, defaultThirteenthMonthYear } = await import('../src/components/hr-thirteenth-month-panel.tsx');
const { SeveranceCalculatorPanel, buildSeveranceAsk } = await import('../src/components/hr-severance-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const RUN_ID = '00000000-0000-7000-8000-000000000010';
const EMP_ID = '00000000-0000-7000-8000-000000000020';

function renderThirteenth(month: string, preview: HrThirteenthMonthPreviewResult, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  const year = defaultThirteenthMonthYear(month);
  cache.current.setQueryData(['hr', 'payroll', 'runs', 'thirteenthMonthPreview', { runId: RUN_ID, year }], preview);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <ThirteenthMonthPanel runId={RUN_ID} month={month} onApplied={async () => {}} onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderSeverance(result: HrEmployeeSeveranceResult, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  cache.current.setQueryData(['hr', 'payroll', 'employees', 'severance', { employeeId: EMP_ID }], result);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <SeveranceCalculatorPanel employeeId={EMP_ID} employeeEndedOn={result.endedOn} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('13th-month and statutory severance UI panels (#3375)', () => {
  beforeEach(() => cache.current.clear());

  it('defaults January runs to previous year and renders ThirteenthMonthPanel rows, citations, and apply button', () => {
    expect(defaultThirteenthMonthYear('2027-01')).toBe(2026);
    expect(defaultThirteenthMonthYear('2026-12')).toBe(2026);

    const preview: HrThirteenthMonthPreviewResult = {
      runId: RUN_ID,
      year: 2026,
      minDaysForMonth: 15,
      rows: [
        {
          lineId: '00000000-0000-7000-8000-000000000001',
          employeeId: EMP_ID,
          employeeName: 'Nguyễn Thị Lan',
          baseWage: '12000000',
          hireDate: '2026-07-01',
          endedOn: null,
          workedMonths: '6',
          amount: '6000000',
          existingBonus: '500000',
        },
      ],
      totalAmount: '6000000',
      rulesUsed: [
        {
          id: 'thirteenth_month.proration@2026-01-01',
          planRow: 3,
          status: 'commentary',
          confidence: 'commentary',
          cite: 'Payroll plan section 5 rows 3 & 11',
        },
      ],
    };

    const htmlVi = renderThirteenth('2027-01', preview, 'vi');
    expect(htmlVi).toContain('data-testid="hr-13th-month-panel"');
    expect(htmlVi).toContain('value="2026"');
    expect(htmlVi).toContain('Nguyễn Thị Lan');
    expect(htmlVi).toContain('thirteenth_month.proration@2026-01-01');
    expect(htmlVi).toContain('Áp dụng (1 dòng)');
    expect(htmlVi).not.toMatch(/disabled=""[^>]*data-testid="hr-13th-month-apply"|data-testid="hr-13th-month-apply"[^>]*disabled=""/);

    const htmlEn = renderThirteenth('2026-12', preview, 'en');
    expect(htmlEn).toContain('Prorated 13th-month salary');
    expect(htmlEn).toContain('Apply (1 row)');
  });

  it('renders SeveranceCalculatorPanel for eligible and ineligible cases with read-only notice and citations', () => {
    const eligible: HrEmployeeSeveranceResult = {
      employeeId: EMP_ID,
      status: 'ended',
      hireDate: '2024-01-01',
      endedOn: '2026-11-30',
      terminationReason: 'contract_expired',
      totalWorkedMonths: 35,
      unemploymentInsuredMonths: 17,
      priorSettledMonths: 0,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '16000000', '16000000'],
      qualifyingMonths: 18,
      qualifyingYears: '1.5',
      averageWage: '12000000',
      eligible: true,
      reason: null,
      amount: '9000000',
      paidAmount: '11000000',
      pitExemptAmount: '9000000',
      taxableExcess: '2000000',
      rulesUsed: [
        {
          id: 'severance.labor_code_art46@2021-01-01',
          planRow: 17,
          status: 'commentary',
          confidence: 'primary',
          cite: 'Labor Code 2019 Art. 46',
        },
      ],
    };

    const htmlVi = renderSeverance(eligible, 'vi');
    expect(htmlVi).toContain('data-testid="hr-severance-panel"');
    expect(htmlVi).toContain('data-testid="hr-severance-readonly-note"');
    expect(htmlVi).toContain('severance.labor_code_art46@2021-01-01');
    expect(htmlVi).toContain('1.5');
    expect(htmlVi).toContain('Đủ điều kiện');
    expect(htmlVi).not.toContain('data-testid="hr-severance-ineligible"');

    const ineligible: HrEmployeeSeveranceResult = {
      ...eligible,
      status: 'active',
      totalWorkedMonths: 8,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000000'],
      qualifyingMonths: 8,
      qualifyingYears: '0',
      averageWage: '10000000',
      eligible: false,
      reason: 'worked_under_12_months',
      amount: '0',
      paidAmount: null,
      pitExemptAmount: '0',
      taxableExcess: '0',
    };

    const htmlEn = renderSeverance(ineligible, 'en');
    expect(htmlEn).toContain('data-testid="hr-severance-ineligible"');
    expect(htmlEn).toContain('fewer than 12 months');

    // Changing endedOn without a manual totalWorkedMonths override omits totalWorkedMonths so server re-derives tenure.
    const askDateOnly = buildSeveranceAsk(EMP_ID, { endedOn: '2026-12-31' }, ineligible);
    expect(askDateOnly.endedOn).toBe('2026-12-31');
    expect(askDateOnly.totalWorkedMonths).toBeUndefined();
    const askExplicitMonths = buildSeveranceAsk(EMP_ID, { endedOn: '2026-12-31', totalWorkedMonths: '14' }, ineligible);
    expect(askExplicitMonths.totalWorkedMonths).toBe(14);

    expect(viMessages.hrPayroll.flag.severance_check).toBeTruthy();
    expect(en.hrPayroll.flag.severance_check).toBeTruthy();
    expect(viMessages.commands.hr.payroll.run.apply_thirteenth_month).toBeTruthy();
    expect(en.commands.hr.payroll.run.apply_thirteenth_month).toBeTruthy();
    expect(viMessages.commands.hr.payroll.employee.severance).toBeTruthy();
    expect(en.commands.hr.payroll.employee.severance).toBeTruthy();
  });
});
