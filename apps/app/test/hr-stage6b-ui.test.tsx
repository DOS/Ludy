// SPDX-License-Identifier: AGPL-3.0-only
// SSR UI & i18n tests for HR Stage 6B (#4527): self-service salary advances & business trips (/hr/my),
// 2-level approval queues (/hr/employees), retro/offset payroll panel & sync (/hr/payroll), and >=44px mobile targets.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  vietnamToday,
  type HrAdvanceRequestView,
  type HrAdjustmentItemView,
  type HrPayslip,
  type HrRunSheet,
  type HrSelfAdvanceListResult,
  type HrSelfTripListResult,
  type HrTripRequestView,
} from '@ludy/kernel-contract';
import type { PayrollBreakdown } from '@ludy/l10n-vn';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr', 'projects'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: [...path, opts?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        self: {
          salaryAdvance: { submit: vi.fn(), cancel: vi.fn() },
          businessTrips: { submit: vi.fn(), cancel: vi.fn() },
        },
        salaryAdvances: { approveL1: vi.fn(), approveFinal: vi.fn(), reject: vi.fn() },
        businessTrips: { approveL1: vi.fn(), approveFinal: vi.fn(), reject: vi.fn() },
        payroll: {
          runs: { recalculate: vi.fn(), approve: vi.fn(), syncLeave: vi.fn(), syncOvertime: vi.fn(), syncStage6b: vi.fn() },
          adjustments: { create: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
          lines: { setInputs: vi.fn(), adjust: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    getCurrentOrg: () => 'acme',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  HrPayrollAdjustmentsPanel,
  HrSelfAdvanceTripCards,
  HrStage6bApprovalQueues,
} = await import('../src/components/hr-stage6b-cards.tsx');
const { Breakdown, InputsForm, Payslip, Sheet, buildLineInputsUpdatePayload, splitBonusAndRetroPay, stateOf } = await import('../src/routes/hr-payroll.tsx');
const { SelfPayslipDetail } = await import('../src/routes/hr-my.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000901';
const LE_ID = '00000000-0000-7000-8000-000000000902';
const DEPT_ID = '00000000-0000-7000-8000-000000000903';
const RUN_ID = '00000000-0000-7000-8000-000000000904';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('HR Stage 6B UI & i18n (#4527)', () => {
  beforeEach(() => {
    cache.current.clear();
  });

  it('renders self-service advance & business trip cards on /hr/my in vi & en with >=44px mobile targets', () => {
    const ownAdv: HrAdvanceRequestView = {
      id: '00000000-0000-7000-8000-000000000911',
      legalEntityId: LE_ID,
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      month: '2026-11',
      amount: '2000000',
      reason: 'Chi phí khám bệnh',
      status: 'pending_l1',
      l1ApproverUserId: null,
      l1ActedAt: null,
      finalActedBy: null,
      finalActedAt: null,
      decisionNote: null,
      payrollRunId: null,
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
      canApproveL1: false,
      canApproveFinal: false,
      canCancel: true,
    };
    const l1Adv: HrAdvanceRequestView = {
      ...ownAdv,
      id: '00000000-0000-7000-8000-000000000912',
      employeeId: '00000000-0000-7000-8000-000000000999',
      employeeName: 'Lê Văn Hùng',
      canApproveL1: true,
      canCancel: false,
    };
    const advState: HrSelfAdvanceListResult = {
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      items: [ownAdv],
      l1Queue: [l1Adv],
    };

    const ownTrip: HrTripRequestView = {
      id: '00000000-0000-7000-8000-000000000913',
      legalEntityId: LE_ID,
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      destination: 'Đà Nẵng',
      purpose: 'Gặp khách hàng',
      startOn: '2026-11-18',
      endOn: '2026-11-20',
      estimatedAllowance: '1500000',
      status: 'pending_final',
      l1ApproverUserId: '00000000-0000-7000-8000-000000000950',
      l1ActedAt: '2026-11-11T08:00:00.000Z',
      finalActedBy: null,
      finalActedAt: null,
      decisionNote: null,
      createdAt: '2026-11-10T09:00:00.000Z',
      updatedAt: '2026-11-11T08:00:00.000Z',
      canApproveL1: false,
      canApproveFinal: false,
      canCancel: true,
    };
    const tripState: HrSelfTripListResult = {
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      items: [ownTrip],
      l1Queue: [],
    };

    cache.current.setQueryData(['hr', 'self', 'salaryAdvance', 'list', { limit: 100 }], advState);
    cache.current.setQueryData(['hr', 'self', 'businessTrips', 'list', { limit: 100 }], tripState);

    for (const locale of ['vi', 'en'] as const) {
      const html = wrap(<HrSelfAdvanceTripCards linked={true} />, locale);
      expect(html).toContain('hr-self-advance-card');
      expect(html).toContain('hr-self-trip-card');
      expect(html).toContain('hr-self-advance-l1-item');
      expect(html).toContain('max-md:min-h-11');
      expect(html).toContain('Đà Nẵng');
      expect(html).toContain('Lê Văn Hùng');
    }
  });

  it('renders Stage 6B approval queues on /hr/employees cleanly', () => {
    cache.current.setQueryData(
      ['hr', 'salaryAdvances', 'list', { limit: 100 }],
      [
        {
          id: '00000000-0000-7000-8000-000000000921',
          legalEntityId: LE_ID,
          employeeId: EMP_ID,
          employeeName: 'Phạm Minh Tuấn',
          departmentId: DEPT_ID,
          departmentName: 'Kinh doanh',
          month: '2026-11',
          amount: '3000000',
          reason: 'Ứng lương tháng 11',
          status: 'pending_final',
          l1ApproverUserId: '00000000-0000-7000-8000-000000000950',
          l1ActedAt: '2026-11-10T09:00:00.000Z',
          finalActedBy: null,
          finalActedAt: null,
          decisionNote: null,
          payrollRunId: null,
          createdAt: '2026-11-10T08:00:00.000Z',
          updatedAt: '2026-11-10T09:00:00.000Z',
          canApproveL1: false,
          canApproveFinal: true,
          canCancel: true,
        },
      ],
    );
    cache.current.setQueryData(
      ['hr', 'businessTrips', 'list', { limit: 100 }],
      [
        {
          id: '00000000-0000-7000-8000-000000000922',
          legalEntityId: LE_ID,
          employeeId: EMP_ID,
          employeeName: 'Phạm Minh Tuấn',
          departmentId: DEPT_ID,
          departmentName: 'Kinh doanh',
          destination: 'Cần Thơ',
          purpose: 'Hội thảo đối tác',
          startOn: '2026-11-22',
          endOn: '2026-11-23',
          estimatedAllowance: '1200000',
          status: 'pending_l1',
          l1ApproverUserId: null,
          l1ActedAt: null,
          finalActedBy: null,
          finalActedAt: null,
          decisionNote: null,
          createdAt: '2026-11-10T08:00:00.000Z',
          updatedAt: '2026-11-10T08:00:00.000Z',
          canApproveL1: true,
          canApproveFinal: false,
          canCancel: true,
        },
      ],
    );

    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 120 }], []);

    const html = wrap(<HrStage6bApprovalQueues />, 'vi');
    expect(html).toContain('hr-advance-queue');
    expect(html).toContain('hr-trip-queue');
    expect(html).toContain('Phạm Minh Tuấn');
    expect(html).toContain('Cần Thơ');
    expect(html).toContain('hr-advance-queue-row-final');
    expect(html).toContain('hr-trip-queue-row-l1');

    // Finalized payroll run for the same entity/month disables advance approval and surfaces notice.
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 120 }], [
      {
        id: RUN_ID,
        legalEntityId: LE_ID,
        month: '2026-11',
        status: 'approved',
        workingDays: '26',
        approvedAt: '2026-11-30T10:00:00.000Z',
        netTotal: '8550000',
        lineCount: 1,
      },
    ]);
    const lockedHtml = wrap(
      <HrStage6bApprovalQueues
        entities={[
          { id: LE_ID, name: 'Trụ sở chính' },
          { id: '00000000-0000-7000-8000-000000000102', name: 'Chi nhánh' },
        ]}
      />,
      'vi',
    );
    expect(lockedHtml).toContain('hr-stage6b-queue-entity-filter');
    expect(lockedHtml).toContain('hr-advance-queue-row-locked');
    expect(lockedHtml).not.toContain('hr-advance-queue-row-final');
  });

  it('renders payroll adjustments panel, syncStage6b button, and retroPay/offsetDeduction line inputs on /hr/payroll', () => {
    const adjItem: HrAdjustmentItemView = {
      id: '00000000-0000-7000-8000-000000000931',
      legalEntityId: LE_ID,
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      month: '2026-11',
      kind: 'retro_pay',
      amount: '800000',
      reason: 'Truy lĩnh phụ cấp tháng trước',
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      decisionNote: null,
      payrollRunId: null,
      createdBy: '00000000-0000-7000-8000-000000000951',
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
      canApprove: true,
      canCancel: true,
    };
    const sheet: HrRunSheet = {
      run: {
        id: RUN_ID,
        legalEntityId: LE_ID,
        employerName: 'Công ty Ludy',
        month: '2026-11',
        status: 'draft',
        workingDays: '26',
        approvedAt: null,
      },
      lines: [
        {
          id: '00000000-0000-7000-8000-000000000941',
          employeeId: EMP_ID,
          employeeName: 'Nguyễn Văn A',
          kind: 'pay',
          status: 'calculated',
          refusal: null,
          inputs: {
            unpaidLeaveDays: '0',
            sicknessBhxhDays: '0',
            maternityBhxhDays: '0',
            daysNotEmployed: '0',
            bonus: '0',
            retroPay: '800000',
            advance: '1000000',
            offsetDeduction: '200000',
            nightHours: '0',
            overtime: [],
            allowances: [],
            deductions: [],
          },
          figures: {
            gross: '10800000',
            employeeInsurance: '1050000',
            employerInsurance: '2150000',
            unionFee: '200000',
            taxableIncome: '10800000',
            pit: '0',
            net: '8550000',
            employerCost: '13150000',
          },
          breakdown: null,
          checks: [],
          flags: [],
          note: null,
          adjustsMonth: null,
        },
      ],
      totals: {
        gross: '10800000',
        employeeInsurance: '1050000',
        employerInsurance: '2150000',
        unionFee: '200000',
        taxableIncome: '10800000',
        pit: '0',
        net: '8550000',
        employerCost: '13150000',
      },
      rules: [],
      blocking: [],
      approvable: false,
      fingerprint: '0'.repeat(64),
      obstacles: [],
    };

    cache.current.setQueryData(['hr', 'payroll', 'runs', 'sheet', { runId: RUN_ID }], sheet);
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 100 }], []);
    cache.current.setQueryData(['hr', 'payroll', 'adjustments', 'list', { legalEntityId: LE_ID, month: '2026-11', limit: 100 }], [adjItem]);

    const sheetHtml = wrap(<Sheet runId={RUN_ID} approvedRuns={[]} onBack={() => undefined} />, 'vi');
    expect(sheetHtml).toContain('hr-sync-stage6b');
    expect(sheetHtml).toContain('hr-adjustments-panel');
    expect(sheetHtml).toContain('Truy lĩnh phụ cấp tháng trước');

    const line = sheet.lines[0]!;
    const formHtml = wrap(<InputsForm line={line} onDone={() => undefined} />, 'en');
    expect(formHtml).toContain('hr-input-retroPay');
    expect(formHtml).toContain('hr-input-offsetDeduction');
    expect(formHtml).toContain('hr-input-advance');

    const parsed = stateOf(line.inputs);
    expect(parsed.retroPay).toBe('800000');
    expect(parsed.offsetDeduction).toBe('200000');
    const payload = buildLineInputsUpdatePayload(parsed, []);
    expect(payload.retroPay).toBe('800000');
    expect(payload.offsetDeduction).toBe('200000');

    const adjPanelHtml = wrap(
      <HrPayrollAdjustmentsPanel
        legalEntityId={LE_ID}
        month="2026-11"
        draft={true}
        employees={[{ id: EMP_ID, name: 'Nguyễn Văn A' }]}
        onChanged={async () => undefined}
      />,
      'en',
    );
    expect(adjPanelHtml).toContain('hr-adj-approve');
    expect(adjPanelHtml).toContain('max-md:min-h-11');

    const nonDraftPanelHtml = wrap(
      <HrPayrollAdjustmentsPanel
        legalEntityId={LE_ID}
        month="2026-11"
        draft={false}
        employees={[{ id: EMP_ID, name: 'Nguyễn Văn A' }]}
        onChanged={async () => undefined}
      />,
      'en',
    );
    expect(nonDraftPanelHtml).not.toContain('hr-adj-approve');
    expect(nonDraftPanelHtml).toContain('hr-adj-nondraft-notice');
  });

  it('surfaces proactive locked-month hints in self-submit form and L1 queue (#4597)', () => {
    const currentMonth = vietnamToday().slice(0, 7);
    const ownLockedAdv: HrAdvanceRequestView = {
      id: '00000000-0000-7000-8000-000000000961',
      legalEntityId: LE_ID,
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      month: currentMonth,
      amount: '1000000',
      reason: 'Ứng lương tháng đã chốt',
      status: 'pending_l1',
      l1ApproverUserId: null,
      l1ActedAt: null,
      finalActedBy: null,
      finalActedAt: null,
      decisionNote: null,
      payrollRunId: null,
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
      canApproveL1: false,
      canApproveFinal: false,
      canCancel: true,
      payrollRunLocked: true,
    };
    const l1LockedAdv: HrAdvanceRequestView = {
      ...ownLockedAdv,
      id: '00000000-0000-7000-8000-000000000962',
      employeeId: '00000000-0000-7000-8000-000000000999',
      employeeName: 'Lê Văn Hùng',
      canApproveL1: true,
      canCancel: false,
      payrollRunLocked: true,
    };
    cache.current.setQueryData(['hr', 'self', 'salaryAdvance', 'list', { limit: 100 }], {
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      lockedMonths: [currentMonth],
      items: [ownLockedAdv],
      l1Queue: [l1LockedAdv],
    } satisfies HrSelfAdvanceListResult);
    cache.current.setQueryData(['hr', 'self', 'businessTrips', 'list', { limit: 100 }], {
      employeeId: EMP_ID,
      employeeName: 'Trần Thị Mai',
      departmentId: DEPT_ID,
      items: [],
      l1Queue: [],
    } satisfies HrSelfTripListResult);

    for (const locale of ['vi', 'en'] as const) {
      const html = wrap(<HrSelfAdvanceTripCards linked={true} />, locale);
      expect(html).toContain('data-testid="hr-self-advance-month-locked"');
      expect(html).toContain('aria-describedby="adv-month-locked-notice"');
      expect(html).toContain('data-testid="hr-self-advance-item-locked"');
      expect(html).toContain('data-testid="hr-self-advance-l1-item-locked"');
      // L1 approve button hidden when locked, while reject button remains available.
      expect(html).not.toContain('data-testid="hr-self-advance-l1-item-l1"');
      expect(html).toContain('data-testid="hr-self-advance-l1-item-reject"');
      // Semantic tokens only, zero raw Tailwind color utilities.
      expect(html).not.toContain('bg-amber-');
      expect(html).not.toContain('bg-red-');
    }
  });

  it('renders stage6b_manual_override flag badge and dedicated retroPay breakdown/payslip lines (#4597)', () => {
    const newBreakdown: PayrollBreakdown = {
      pay: {
        baseWage: '10000000',
        allowances: [],
        otherRegularPay: '0',
        unpaidReduction: '0',
        sicknessBhxhReduction: '0',
        maternityBhxhReduction: '0',
        hourlyRate: null,
        overtime: [],
        nightWork: null,
        bonus: '500000',
        retroPay: '800000',
      },
      insurance: {
        insurablePay: '10000000',
        suspended: null,
        bounds: [],
        funds: [],
        unionFee: '200000',
      },
      tax: {
        mode: 'progressive',
        exemptMealCash: '0',
        exemptOvertime: '0',
        exemptNightWork: '0',
        taxableIncome: '11300000',
        incomeAfterInsurance: '10250000',
        personalDeduction: '11000000',
        dependentsCounted: 0,
        dependentDeduction: '0',
        pensionDeduction: '0',
        assessableIncome: '0',
        slices: [],
        flatPercent: null,
      },
      deductions: { advance: '1000000', damage: '0', other: '200000', total: '1200000' },
    };

    // New breakdown keeps bonus and retroPay separated directly.
    expect(splitBonusAndRetroPay(newBreakdown, { bonus: '500000', retroPay: '800000' })).toEqual({
      bonus: '500000',
      retroPay: '800000',
    });
    // Legacy breakdown (pre-#4597, retroPay folded into pay.bonus) reconstructs separate bonus & retroPay.
    const { retroPay: _omitted, ...legacyPayBase } = newBreakdown.pay;
    const legacyBreakdown: PayrollBreakdown = {
      ...newBreakdown,
      pay: { ...legacyPayBase, bonus: '1300000' },
    };
    expect(splitBonusAndRetroPay(legacyBreakdown, { bonus: '500000', retroPay: '800000' })).toEqual({
      bonus: '500000',
      retroPay: '800000',
    });
    // Fractional legacy bonus must round to integer VND so zero/tiny retroPay never creates phantom or negative amounts.
    expect(
      splitBonusAndRetroPay(
        { ...newBreakdown, pay: { ...legacyPayBase, bonus: '500001' } },
        { bonus: '500000.6', retroPay: '0' },
      ),
    ).toEqual({ bonus: '500001', retroPay: '0' });
    expect(
      splitBonusAndRetroPay(
        { ...newBreakdown, pay: { ...legacyPayBase, bonus: '500000' } },
        { bonus: '500000.3', retroPay: '0.1' },
      ),
    ).toEqual({ bonus: '500000', retroPay: '0' });
    expect(
      splitBonusAndRetroPay(
        { ...newBreakdown, pay: { ...legacyPayBase, bonus: '1300001' } },
        { bonus: '500000.3', retroPay: '800000.5' },
      ),
    ).toEqual({ bonus: '500000', retroPay: '800001' });

    const lineId = '00000000-0000-7000-8000-000000000971';
    const sheet: HrRunSheet = {
      run: {
        id: RUN_ID,
        legalEntityId: LE_ID,
        employerName: 'Công ty Ludy',
        month: '2026-11',
        status: 'draft',
        workingDays: '26',
        approvedAt: null,
      },
      lines: [
        {
          id: lineId,
          employeeId: EMP_ID,
          employeeName: 'Nguyễn Văn A',
          kind: 'pay',
          status: 'calculated',
          refusal: null,
          inputs: {
            unpaidLeaveDays: '0',
            sicknessBhxhDays: '0',
            maternityBhxhDays: '0',
            daysNotEmployed: '0',
            bonus: '500000',
            retroPay: '800000',
            advance: '1000000',
            advanceFromRequests: false,
            offsetDeduction: '200000',
            nightHours: '0',
            overtime: [],
            allowances: [],
            deductions: [],
          },
          figures: {
            gross: '11300000',
            employeeInsurance: '1050000',
            employerInsurance: '2150000',
            unionFee: '200000',
            taxableIncome: '11300000',
            pit: '0',
            net: '9050000',
            employerCost: '13650000',
          },
          breakdown: newBreakdown as unknown as Record<string, unknown>,
          checks: [],
          flags: ['stage6b_manual_override'],
          stage6bManualOverrides: [{ field: 'advance', lineAmount: '1000000', approvedAmount: '1500000' }],
          note: null,
          adjustsMonth: null,
        },
      ],
      totals: {
        gross: '11300000',
        employeeInsurance: '1050000',
        employerInsurance: '2150000',
        unionFee: '200000',
        taxableIncome: '11300000',
        pit: '0',
        net: '9050000',
        employerCost: '13650000',
      },
      rules: [],
      blocking: [],
      approvable: false,
      fingerprint: '0'.repeat(64),
      obstacles: [],
    };
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'sheet', { runId: RUN_ID }], sheet);
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 100 }], []);
    cache.current.setQueryData(['hr', 'payroll', 'adjustments', 'list', { legalEntityId: LE_ID, month: '2026-11', limit: 100 }], []);

    const sheetHtml = wrap(<Sheet runId={RUN_ID} approvedRuns={[]} onBack={() => undefined} />, 'vi');
    expect(sheetHtml).toContain(viMessages.hrPayroll.flag.stage6b_manual_override);

    const breakdownHtml = wrap(<Breakdown line={sheet.lines[0]!} money={(v) => `${v ?? '0'} ₫`} />, 'vi');
    expect(breakdownHtml).toContain('data-testid="hr-breakdown-retro-pay"');
    expect(breakdownHtml).toContain(viMessages.hrPayroll.bd.retroPay);
    expect(breakdownHtml).toContain('800000 ₫');

    const payslipData: HrPayslip = {
      lineId,
      runId: RUN_ID,
      month: '2026-11',
      status: 'approved',
      employerName: 'Công ty Ludy',
      employeeName: 'Nguyễn Văn A',
      inputs: sheet.lines[0]!.inputs,
      figures: sheet.lines[0]!.figures!,
      breakdown: newBreakdown as unknown as Record<string, unknown>,
    };
    cache.current.setQueryData(['hr', 'payroll', 'lines', 'payslip', { lineId }], payslipData);
    cache.current.setQueryData(['hr', 'self', 'payslips', 'get', { lineId }], payslipData);

    const payslipEnHtml = wrap(<Payslip lineId={lineId} onClose={() => undefined} />, 'en');
    expect(payslipEnHtml).toContain('data-testid="hr-payslip-retro-pay"');
    expect(payslipEnHtml).toContain(en.hrPayroll.bd.retroPay);

    const selfPayslipViHtml = wrap(<SelfPayslipDetail lineId={lineId} onClose={() => undefined} initialExplained={true} />, 'vi');
    expect(selfPayslipViHtml).toContain('data-testid="hr-my-payslip-retro-pay"');
    expect(selfPayslipViHtml).toContain(viMessages.hrPayroll.bd.retroPay);
    expect(selfPayslipViHtml).toContain('1.300.000');
  });

  it('contains Stage 6B translation namespaces in both vi and en without em/en dashes', () => {
    for (const bundle of [viMessages, en]) {
      const stage6b = JSON.stringify({
        today: bundle.today.items.hr,
        payroll: bundle.hrPayroll.stage6b,
        flags: bundle.hrPayroll.flag.stage6b_manual_override,
        retroPay: bundle.hrPayroll.bd.retroPay,
        diffReasons: bundle.hrPayroll.diff.reasons,
        queues: bundle.hrEmployees.stage6bQueues,
        my: bundle.hrMy.stage6b,
      });
      expect(stage6b).not.toContain('\u2014');
      expect(stage6b).not.toContain('\u2013');
    }
  });
});
