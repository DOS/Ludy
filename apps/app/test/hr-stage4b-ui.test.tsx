// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_CONTRACT_ALERT_CODES,
  HR_LEAVE_ENTRY_KINDS,
  HR_LINE_FLAGS,
  HR_PAY_BASES,
  vietnamToday,
  type HrEmployee,
  type HrLeaveBalanceResult,
  type HrRunSheet,
} from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr'] }),
}));

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
        employee: { contractPdf: vi.fn() },
        payroll: {
          employees: { add: vi.fn(), edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
          employments: { add: vi.fn() },
          dependents: { add: vi.fn(), end: vi.fn() },
          leave: { set: vi.fn(), delete: vi.fn() },
          runs: { open: vi.fn(), recalculate: vi.fn(), approve: vi.fn(), syncLeave: vi.fn() },
          lines: { setInputs: vi.fn(), adjust: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  AddForm,
  Detail,
  EditForm,
  TermsFields,
  blankEditDraft,
  blankTerms,
  buildEditPayload,
  buildEmploymentPayload,
  hasEditEmployeeChanges,
  previewContractCheck,
  termsValid,
  workPermitNumberOk,
} = await import('../src/routes/hr-employees.tsx');
const { LeaveBalancePanel, isValidLeaveDaysInput } = await import('../src/components/hr-leave-panel.tsx');
const { Breakdown, InputsForm, Payslip, Sheet, formOk, inputsOf, normalizePayrollNumericInput, stateOf } = await import('../src/routes/hr-payroll.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000601';
const ENTITY_ID = '00000000-0000-7000-8000-000000000602';
const RUN_ID = '00000000-0000-7000-8000-000000000603';
const LINE_ID = '00000000-0000-7000-8000-000000000604';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('HR Stage 4B UI & i18n (#4301)', () => {
  beforeEach(() => cache.current.clear());

  it('ships full VI/EN Stage 4B translations and zero em/en dashes', () => {
    expect(HR_PAY_BASES).toEqual(['monthly', 'hourly', 'piece_rate']);
    expect(HR_LEAVE_ENTRY_KINDS).toContain('sickness_bhxh');
    expect(HR_LEAVE_ENTRY_KINDS).toContain('maternity_bhxh');
    expect(HR_CONTRACT_ALERT_CODES).toContain('work_permit_expired');
    expect(HR_CONTRACT_ALERT_CODES).toContain('work_permit_expiring_soon');
    expect(HR_LINE_FLAGS).toContain('work_permit_expiring');
    expect(HR_LINE_FLAGS).toContain('bhxh_suspended_regime');
    expect(HR_LINE_FLAGS).toContain('non_resident_flat_pit');

    for (const locale of [viMessages, en]) {
      for (const basis of HR_PAY_BASES) expect(locale.hrEmployees.payBases[basis]).toBeTruthy();
      expect(locale.hrEmployees.leave.kinds.sickness_bhxh).toBeTruthy();
      expect(locale.hrEmployees.leave.kinds.maternity_bhxh).toBeTruthy();
      expect(locale.hrEmployees.alerts.work_permit_expired).toBeTruthy();
      expect(locale.hrEmployees.alerts.work_permit_expiring_soon).toBeTruthy();
      expect(locale.hrPayroll.flag.work_permit_expiring).toBeTruthy();
      expect(locale.hrPayroll.flag.bhxh_suspended_regime).toBeTruthy();
      expect(locale.hrPayroll.flag.non_resident_flat_pit).toBeTruthy();
      expect(locale.hrPayroll.bd.sicknessBhxhReduction).toBeTruthy();
      expect(locale.hrPayroll.bd.maternityBhxhReduction).toBeTruthy();
      expect(locale.hrPayroll.in.workedHours).toBeTruthy();
      expect(locale.hrPayroll.in.pieceCount).toBeTruthy();
      expect(locale.hrPayroll.in.sicknessBhxhDays).toBeTruthy();
      expect(locale.hrPayroll.in.maternityBhxhDays).toBeTruthy();
      const serialized = JSON.stringify({ hrEmployees: locale.hrEmployees, hrPayroll: locale.hrPayroll });
      expect(serialized).not.toContain('\u2014');
      expect(serialized).not.toContain('\u2013');
    }
  });

  it('supports hourly/piece_rate terms validation, payloads, and foreign worker UI controls with 44px touch targets', () => {
    const hourly = { ...blankTerms(), effectiveFrom: '2026-08-01', payBasis: 'hourly' as const, hourlyRate: '50000', taxResident: false };
    expect(termsValid(hourly)).toBe(true);
    expect(termsValid({ ...hourly, baseWage: 'stale-or-invalid' })).toBe(true);
    expect(termsValid({ ...hourly, hourlyRate: '0' })).toBe(false);
    expect(buildEmploymentPayload({ ...hourly, baseWage: '25000000' })).toMatchObject({ payBasis: 'hourly', hourlyRate: '50000', baseWage: '0', taxResident: false });
    expect(previewContractCheck({ ...hourly, probationRoleTier: 'college_or_above', probationEndOn: '2026-08-30', probationWage: '42500' })).toEqual([]);
    expect(previewContractCheck({ ...hourly, probationRoleTier: 'college_or_above', probationEndOn: '2026-08-30', probationWage: '40000' }).map((f) => f.code)).toContain('probation_wage_below_85_percent');

    const piece = { ...blankTerms(), effectiveFrom: '2026-08-01', payBasis: 'piece_rate' as const, pieceRate: '25000' };
    expect(termsValid(piece)).toBe(true);
    expect(termsValid({ ...piece, pieceRate: '' })).toBe(false);
    expect(buildEmploymentPayload(piece)).toMatchObject({ payBasis: 'piece_rate', pieceRate: '25000', baseWage: '0', taxResident: true });
    expect(previewContractCheck({ ...piece, probationRoleTier: 'college_or_above', probationEndOn: '2026-08-30', probationWage: '21250' })).toEqual([]);

    expect(workPermitNumberOk('GP2026-1234')).toBe(true);
    expect(workPermitNumberOk('ab')).toBe(false);

    const hourlyHtml = wrap(<TermsFields id="hr-test" value={hourly} onChange={() => {}} />, 'vi');
    expect(hourlyHtml).toContain('data-testid="hr-terms-pay-basis"');
    expect(hourlyHtml).toContain('data-testid="hr-terms-hourly-rate"');
    expect(hourlyHtml).toContain('data-testid="hr-terms-tax-resident"');

    const pieceHtml = wrap(<TermsFields id="hr-test" value={piece} onChange={() => {}} />, 'en');
    expect(pieceHtml).toContain('data-testid="hr-terms-piece-rate"');

    const addHtml = wrap(<AddForm onClose={() => {}} />, 'vi');
    expect(addHtml).toContain('data-testid="hr-add-is-foreign"');
    expect(addHtml).toContain('max-md:min-h-11');

    const draft = { ...blankEditDraft(), isForeign: 'true' as const, workPermitNumber: 'GP2026-5555' };
    expect(hasEditEmployeeChanges(blankEditDraft())).toBe(false);
    expect(hasEditEmployeeChanges(draft)).toBe(true);
    expect(buildEditPayload(EMP_ID, draft)).toEqual({ employeeId: EMP_ID, isForeign: true, workPermitNumber: 'GP2026-5555' });
  });

  it('renders masked work permit detail, alerts, EditForm foreign fields, and LeaveBalancePanel BHXH kinds & counters', () => {
    const employee: HrEmployee = {
      id: EMP_ID,
      legalEntityId: ENTITY_ID,
      displayName: 'Alex Foreign Canary',
      departmentId: null,
      departmentName: null,
      jobTitle: null,
      linkedUserId: null,
      linkedMemberName: null,
      status: 'active',
      endedOn: null,
      isForeign: true,
      workPermitExempt: false,
      workPermitExpiresOn: '2026-12-01',
      hasWorkPermitNumber: true,
      current: {
        id: '00000000-0000-7000-8000-000000000605',
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '0',
        payFunction: 'admin',
        payBasis: 'hourly',
        hourlyRate: '75000.00',
        pieceRate: null,
        taxResident: false,
        contractForm: null,
        termMonths: null,
        contractEndOn: null,
        fixedTermSequence: null,
        probationRoleTier: null,
        probationEndOn: null,
        probationWage: null,
      },
      hasIdentityNumber: false,
      hasAccountNumber: false,
      contractAlerts: [
        {
          code: 'work_permit_expiring_soon',
          severity: 'warning',
          targetDate: '2026-12-01',
          daysRemaining: 10,
          message: 'Work permit expires in 10d',
          cite: 'Labor Code 2019 Art. 151',
        },
      ],
      address: null,
      identityNumber: null,
      accountNumber: null,
      workPermitNumber: '****9876',
      bankCode: null,
      birthDate: null,
      taxCode: null,
      insuranceNumber: null,
      finalizationAuthorizedYears: [],
      erased: false,
      employments: [],
      dependents: [],
    };
    employee.employments = [employee.current!];
    cache.current.setQueryData(['org', 'get', {}], { role: 'owner' });
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], employee);

    const detailHtml = wrap(<Detail employeeId={EMP_ID} owner onClose={() => {}} />, 'vi');
    expect(detailHtml).toContain('data-testid="hr-employee-work-permit"');
    expect(detailHtml).toContain('****9876');
    expect(detailHtml).toContain('data-testid="hr-contract-alert-work_permit_expiring_soon"');
    expect(detailHtml).toContain('Theo giờ');
    expect(detailHtml).toContain('không cư trú');

    const editHtml = wrap(
      <EditForm
        employee={employee}
        departments={[]}
        draft={blankEditDraft()}
        onChange={() => {}}
        pending={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
      'en',
    );
    expect(editHtml).toContain('data-testid="hr-edit-is-foreign"');
    expect(editHtml).toContain(en.hrEmployees.isForeignOptions.domestic);
    expect(editHtml).toContain(en.hrEmployees.workPermitExemptOptions.required);
    expect(editHtml).toContain('data-testid="hr-edit-work-permit-number"');
    expect(editHtml).toContain('data-testid="hr-edit-work-permit-expires"');

    const year = vietnamToday().slice(0, 4);
    const leaveData: HrLeaveBalanceResult = {
      employeeId: EMP_ID,
      year,
      category: 'standard',
      hireDate: `${year}-01-01`,
      endedOn: null,
      entries: [
        { id: '00000000-0000-7000-8000-000000000606', employeeId: EMP_ID, month: `${year}-09`, kind: 'sickness_bhxh', days: '5.50', approved: true },
        { id: '00000000-0000-7000-8000-000000000607', employeeId: EMP_ID, month: `${year}-10`, kind: 'maternity_bhxh', days: '15.00', approved: true },
      ],
      balance: {
        year,
        eligibleMonths: 12,
        entitlementDays: '12',
        seniorityYears: 0,
        seniorityDays: '0',
        totalEntitlementDays: '12',
        openingDays: '0',
        takenAnnualDays: '0',
        signedBalanceDays: '12',
        remainingAnnualDays: '12',
        exceededAnnualDays: '0',
        personalPaidDays: '0',
        unpaidDaysByMonth: {},
        sicknessBhxhDays: '5.5',
        maternityBhxhDays: '15',
        sicknessBhxhDaysByMonth: { [`${year}-09`]: '5.5' },
        maternityBhxhDaysByMonth: { [`${year}-10`]: '15' },
        rulesUsed: [],
      },
    };
    expect(isValidLeaveDaysInput('sickness_bhxh', '5.25')).toBe(true);
    expect(isValidLeaveDaysInput('maternity_bhxh', '15')).toBe(true);

    cache.current.setQueryData(['hr', 'payroll', 'leave', 'balance', { employeeId: EMP_ID, year, category: 'standard' }], leaveData);
    const leaveHtml = wrap(<LeaveBalancePanel employeeId={EMP_ID} />, 'vi');
    expect(leaveHtml).toContain('Nghỉ ốm đau hưởng BHXH');
    expect(leaveHtml).toContain('Nghỉ thai sản hưởng BHXH');
    expect(leaveHtml).toContain('data-testid="hr-leave-sickness-bhxh"');
    expect(leaveHtml).toContain('data-testid="hr-leave-maternity-bhxh"');
    expect(leaveHtml).toContain('5.5');
    expect(leaveHtml).toContain('15');
  });

  it('renders Stage 4B InputsForm, Breakdown, Payslip, and Sheet flag badges in vi and en', () => {
    const lineWithBreakdown = {
      id: LINE_ID,
      employeeId: EMP_ID,
      employeeName: 'Alex Canary',
      kind: 'pay' as const,
      status: 'calculated' as const,
      refusal: null,
      inputs: { workedHours: '160', pieceCount: '0', sicknessBhxhDays: '2', maternityBhxhDays: '15', unpaidLeaveDays: '0' },
      figures: {
        gross: '8000000',
        employeeInsurance: '0',
        employerInsurance: '0',
        unionFee: '0',
        taxableIncome: '8000000',
        pit: '1600000',
        net: '6400000',
        employerCost: '8000000',
      },
      breakdown: {
        pay: {
          baseWage: '8000000',
          allowances: [],
          otherRegularPay: '0',
          unpaidReduction: '0',
          sicknessBhxhReduction: '1000000',
          maternityBhxhReduction: '2000000',
          hourlyRate: '50000',
          overtime: [],
          nightWork: null,
          bonus: '0',
        },
        insurance: { insurablePay: '8000000', suspended: 'maternity_leave', bounds: [], funds: [], unionFee: '0' },
        tax: {
          mode: 'non_resident_flat',
          exemptMealCash: '0',
          exemptOvertime: '0',
          exemptNightWork: '0',
          taxableIncome: '8000000',
          incomeAfterInsurance: '8000000',
          personalDeduction: '0',
          dependentsCounted: 0,
          dependentDeduction: '0',
          pensionDeduction: '0',
          assessableIncome: '8000000',
          slices: [],
          flatPercent: '20',
        },
        deductions: { advance: '0', damage: '0', other: '0', total: '0' },
      },
      checks: [],
      flags: ['work_permit_expiring' as const, 'bhxh_suspended_regime' as const, 'non_resident_flat_pit' as const],
      note: null,
      adjustsMonth: null,
    };
    const sheet: HrRunSheet = {
      run: { id: RUN_ID, legalEntityId: ENTITY_ID, employerName: 'Cong ty Thu', month: '2026-09', status: 'draft', workingDays: '26', approvedAt: null },
      lines: [lineWithBreakdown],
      totals: {
        gross: '8000000',
        employeeInsurance: '0',
        employerInsurance: '0',
        unionFee: '0',
        taxableIncome: '8000000',
        pit: '1600000',
        net: '6400000',
        employerCost: '8000000',
      },
      rules: [],
      blocking: [],
      fingerprint: 'a'.repeat(64),
      approvable: true,
      obstacles: [],
    };
    cache.current.setQueryData(['org', 'get', {}], { role: 'owner' });
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'sheet', { runId: RUN_ID }], sheet);
    cache.current.setQueryData(['hr', 'payroll', 'lines', 'payslip', { lineId: LINE_ID }], {
      lineId: LINE_ID,
      runId: RUN_ID,
      month: '2026-09',
      status: 'draft',
      employerName: 'Cong ty Thu',
      employeeName: 'Alex Canary',
      figures: lineWithBreakdown.figures!,
      breakdown: lineWithBreakdown.breakdown,
      inputs: lineWithBreakdown.inputs,
    });

    const sheetHtml = wrap(<Sheet runId={RUN_ID} approvedRuns={[]} onBack={() => {}} />, 'vi');
    expect(sheetHtml).toContain(viMessages.hrPayroll.flag.work_permit_expiring);
    expect(sheetHtml).toContain(viMessages.hrPayroll.flag.bhxh_suspended_regime);
    expect(sheetHtml).toContain(viMessages.hrPayroll.flag.non_resident_flat_pit);

    const inputsHtml = wrap(<InputsForm line={lineWithBreakdown} onDone={() => {}} />, 'vi');
    expect(inputsHtml).toContain('data-testid="hr-input-workedHours"');
    expect(inputsHtml).toContain('data-testid="hr-input-pieceCount"');
    expect(inputsHtml).toContain('data-testid="hr-input-sicknessBhxhDays"');
    expect(inputsHtml).toContain('data-testid="hr-input-maternityBhxhDays"');
    expect(normalizePayrollNumericInput('0,5')).toBe('0.5');
    expect(normalizePayrollNumericInput('12,25abc')).toBe('12.25');

    const nullInputsHtml = wrap(
      <InputsForm
        line={{ ...lineWithBreakdown, inputs: { ...lineWithBreakdown.inputs, workedHours: null, pieceCount: null } }}
        onDone={() => {}}
      />,
      'vi',
    );
    expect(nullInputsHtml).toContain('data-testid="hr-input-workedHours"');
    expect(nullInputsHtml).not.toContain('value="null"');
    const blankState = stateOf({ workedHours: null, pieceCount: null });
    expect(blankState.workedHours).toBe('');
    expect(blankState.pieceCount).toBe('');
    expect(formOk(blankState)).toBe(true);
    expect(inputsOf(blankState)).toMatchObject({ workedHours: null, pieceCount: null });
    expect(inputsOf({ ...blankState, workedHours: '0', pieceCount: '160' })).toMatchObject({ workedHours: '0', pieceCount: '160' });
    expect(inputsOf({ ...blankState, workedHours: normalizePayrollNumericInput('0,5') })).toMatchObject({ workedHours: '0.5', pieceCount: null });

    const breakdownHtml = wrap(<Breakdown line={lineWithBreakdown} money={(v) => v ?? '0'} />, 'en');
    expect(breakdownHtml).toContain(en.hrPayroll.bd.sicknessBhxhReduction);
    expect(breakdownHtml).toContain(en.hrPayroll.bd.maternityBhxhReduction);
    expect(breakdownHtml).toContain(en.hrPayroll.bd.taxModeNonResident);
    expect(breakdownHtml).toContain(en.hrPayroll.bd.insuranceSuspendedMaternity);

    const payslipHtml = wrap(<Payslip lineId={LINE_ID} onClose={() => {}} />, 'vi');
    expect(payslipHtml).toContain(viMessages.hrPayroll.bd.sicknessBhxhReduction);
    expect(payslipHtml).toContain(viMessages.hrPayroll.bd.maternityBhxhReduction);
    expect(payslipHtml).toContain(viMessages.hrPayroll.bd.taxModeNonResident);
    expect(payslipHtml).toContain(viMessages.hrPayroll.bd.insuranceSuspendedMaternity);
  });
});
