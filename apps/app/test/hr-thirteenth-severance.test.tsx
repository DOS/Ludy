// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HrEmployeeJobLossResult,
  HrEmployeeSeveranceResult,
  HrThirteenthMonthPreviewResult,
} from '@crove/kernel-contract';
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
const {
  SeveranceCalculatorPanel,
  buildJobLossAsk,
  buildSeveranceAsk,
  buildSwitchedAllowanceAsk,
} = await import('../src/components/hr-severance-panel.tsx');
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

function renderJobLoss(result: HrEmployeeJobLossResult, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  cache.current.setQueryData(['hr', 'payroll', 'employees', 'job_loss', { employeeId: EMP_ID }], result);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <SeveranceCalculatorPanel employeeId={EMP_ID} employeeEndedOn={result.endedOn} initialMode="job_loss" />
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
    expect(viMessages.commands.hr.payroll.employee.job_loss).toBeTruthy();
    expect(en.commands.hr.payroll.employee.job_loss).toBeTruthy();
  });

  it('renders Art. 46 / Art. 47 accessible tablist, 1-click redundancy switch, 2-month floor badge, and Ly note (#4296)', () => {
    const redundancyCase: HrEmployeeSeveranceResult = {
      employeeId: EMP_ID,
      status: 'ended',
      hireDate: '2024-01-01',
      endedOn: '2026-11-30',
      terminationReason: 'job_loss_redundancy',
      totalWorkedMonths: 35,
      unemploymentInsuredMonths: 35,
      priorSettledMonths: 0,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000000'],
      qualifyingMonths: 0,
      qualifyingYears: '0',
      averageWage: '10000000',
      eligible: false,
      reason: 'job_loss_redundancy',
      amount: '0',
      paidAmount: null,
      pitExemptAmount: '0',
      taxableExcess: '0',
      rulesUsed: [],
    };

    const htmlArt46 = renderSeverance(redundancyCase, 'vi');
    expect(htmlArt46).toContain('role="tablist"');
    expect(htmlArt46).toContain('data-testid="hr-severance-tab-art46"');
    expect(htmlArt46).toContain('data-testid="hr-severance-tab-art47"');
    expect(htmlArt46).toContain('Trợ cấp thôi việc (Điều 46)');
    expect(htmlArt46).toContain('Trợ cấp mất việc làm (Điều 47)');
    expect(htmlArt46).toContain('min-h-11');
    expect(htmlArt46).toContain('data-testid="hr-severance-switch-job-loss"');

    // Switching from Art. 46 (job_loss_redundancy) to Art. 47 preserves entered dates, months, and paidAmount.
    const switchedToJobLoss = buildSwitchedAllowanceAsk(
      'job_loss',
      EMP_ID,
      {
        endedOn: '2026-12-15',
        totalWorkedMonths: '36',
        unemploymentInsuredMonths: '12',
        priorSettledMonths: '2',
        paidAmount: '28000000',
      },
      undefined,
      redundancyCase,
    );
    expect(switchedToJobLoss).toEqual({
      employeeId: EMP_ID,
      endedOn: '2026-12-15',
      terminationReason: 'organizational_restructuring',
      totalWorkedMonths: 36,
      unemploymentInsuredMonths: 12,
      priorSettledMonths: 2,
      paidAmount: '28000000',
    });

    const floorResult: HrEmployeeJobLossResult = {
      employeeId: EMP_ID,
      status: 'ended',
      hireDate: '2024-01-01',
      endedOn: '2026-11-30',
      terminationReason: 'organizational_restructuring',
      totalWorkedMonths: 24,
      unemploymentInsuredMonths: 24,
      priorSettledMonths: 0,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000000'],
      qualifyingMonths: 0,
      qualifyingYears: '0',
      averageWage: '10000000',
      eligible: true,
      reason: null,
      amount: '20000000',
      minimumFloorApplied: true,
      paidAmount: '25000000',
      pitExemptAmount: '20000000',
      taxableExcess: '5000000',
      rulesUsed: [
        {
          id: 'job_loss.labor_code_art47@2021-01-01',
          planRow: 17,
          status: 'commentary',
          confidence: 'primary',
          cite: 'Labor Code 2019 Arts. 42, 43, 47',
        },
        {
          id: 'job_loss.decree145_art8@2021-02-01',
          planRow: 17,
          status: 'commentary',
          confidence: 'commentary',
          cite: 'Decree 145/2020/ND-CP Art. 8',
        },
      ],
    };

    const jobLossAskDateOnly = buildJobLossAsk(EMP_ID, { endedOn: '2026-12-31' }, floorResult);
    expect(jobLossAskDateOnly.endedOn).toBe('2026-12-31');
    expect(jobLossAskDateOnly.totalWorkedMonths).toBeUndefined();
    expect(jobLossAskDateOnly.unemploymentInsuredMonths).toBe(24);

    const htmlFloorVi = renderJobLoss(floorResult, 'vi');
    expect(htmlFloorVi).toContain('data-testid="hr-job-loss-floor-badge"');
    expect(htmlFloorVi).toContain('Sàn tối thiểu 2 tháng lương theo Điều 47');
    expect(htmlFloorVi).toContain('data-testid="hr-job-loss-ly-note"');
    expect(htmlFloorVi).toContain('24 tháng đóng BHTN');
    expect(htmlFloorVi).toContain('vượt mức miễn thuế TNCN');
    expect(htmlFloorVi).toContain('job_loss.labor_code_art47@2021-01-01');
    expect(htmlFloorVi).toContain('chờ kế toán xác nhận');

    const overFloorEn: HrEmployeeJobLossResult = {
      ...floorResult,
      terminationReason: 'economic_reasons',
      totalWorkedMonths: 40,
      unemploymentInsuredMonths: 10,
      qualifyingMonths: 30,
      qualifyingYears: '2.5',
      amount: '25000000',
      minimumFloorApplied: false,
      paidAmount: '25000000',
      pitExemptAmount: '25000000',
      taxableExcess: '0',
    };
    const htmlOverFloorEn = renderJobLoss(overFloorEn, 'en');
    expect(htmlOverFloorEn).toContain('at or above 2-month floor');
    expect(htmlOverFloorEn).toContain('within the statutory PIT-exempt cap');

    const ineligibleEn: HrEmployeeJobLossResult = {
      ...floorResult,
      terminationReason: 'other_non_art42_art43',
      eligible: false,
      reason: 'not_job_loss_reason',
      amount: '0',
      minimumFloorApplied: false,
      paidAmount: null,
      pitExemptAmount: '0',
      taxableExcess: '0',
    };
    const htmlIneligibleEn = renderJobLoss(ineligibleEn, 'en');
    expect(htmlIneligibleEn).toContain('data-testid="hr-severance-ineligible"');
    expect(htmlIneligibleEn).toContain('outside Arts. 42/43');
    expect(htmlIneligibleEn).not.toContain('data-testid="hr-job-loss-floor-badge"');
  });
});
