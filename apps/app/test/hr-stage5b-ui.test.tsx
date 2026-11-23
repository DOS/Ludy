// SPDX-License-Identifier: AGPL-3.0-only
// SSR UI & i18n tests for HR Stage 5B: self-service onboarding, 2-level OT, and end-of-probation panel (#4448).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_ONBOARDING_STATUSES,
  HR_OVERTIME_COMMENTARY_RULES,
  HR_OVERTIME_DAY_TYPES,
  HR_OVERTIME_STATUSES,
  HR_PROBATION_DECISIONS,
  vietnamToday,
  type HrOnboardingSubmissionView,
  type HrOvertimeRequestView,
  type HrProbationPreviewResult,
  type HrProbationReviewView,
  type HrRunSheet,
  type HrSelfOnboardingState,
  type HrSelfOvertimeListResult,
} from '@ludy/kernel-contract';
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
          onboarding: { submit: vi.fn(), cancel: vi.fn() },
          overtime: { submit: vi.fn(), cancel: vi.fn() },
        },
        onboarding: { approve: vi.fn(), reject: vi.fn() },
        overtimeRequests: { approveL1: vi.fn(), approveFinal: vi.fn(), reject: vi.fn() },
        probation: { draftSummary: vi.fn(), decide: vi.fn() },
        payroll: {
          employees: { add: vi.fn(), edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
          employments: { add: vi.fn() },
          dependents: { add: vi.fn(), end: vi.fn() },
          leave: { set: vi.fn(), delete: vi.fn() },
          runs: { open: vi.fn(), recalculate: vi.fn(), approve: vi.fn(), syncLeave: vi.fn(), syncOvertime: vi.fn() },
          lines: { setInputs: vi.fn(), adjust: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const { HrSelfOnboardingCard, HrSelfOvertimeCard } = await import('../src/components/hr-onboarding-ot-card.tsx');
const {
  HrProbationPanel,
  canSubmitProbationDecision,
  previewMatchesProbationRange,
  probationScopeKey,
} = await import('../src/components/hr-probation-panel.tsx');
const { HrOnboardingReviewQueue, HrOvertimeReviewQueue } = await import('../src/components/hr-stage5b-queues.tsx');
const { Sheet, buildLineInputsUpdatePayload, stateOf } = await import('../src/routes/hr-payroll.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000801';
const LE_ID = '00000000-0000-7000-8000-000000000802';
const DEPT_ID = '00000000-0000-7000-8000-000000000803';
const RUN_ID = '00000000-0000-7000-8000-000000000804';
const TASK_ID = '00000000-0000-7000-8000-000000000805';
const PROJ_ID = '00000000-0000-7000-8000-000000000806';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('HR Stage 5B UI & i18n (#4448)', () => {
  beforeEach(() => cache.current.clear());

  it('ships complete VI/EN translations and Art. 98 commentary metadata with no em dashes', () => {
    expect(HR_OVERTIME_COMMENTARY_RULES.weekday).toMatchObject({ multiplierPercent: 150, status: 'commentary' });
    expect(HR_OVERTIME_COMMENTARY_RULES.weekend).toMatchObject({ multiplierPercent: 200, status: 'commentary' });
    expect(HR_OVERTIME_COMMENTARY_RULES.holiday).toMatchObject({ multiplierPercent: 300, status: 'commentary' });

    for (const locale of [viMessages, en]) {
      for (const s of HR_ONBOARDING_STATUSES) {
        expect(locale.hrMy.onboarding.statuses[s]).toBeTruthy();
        expect(locale.hrEmployees.onboardingQueue.statuses[s]).toBeTruthy();
      }
      for (const s of HR_OVERTIME_STATUSES) {
        expect(locale.hrMy.overtime.statuses[s]).toBeTruthy();
        expect(locale.hrEmployees.overtimeQueue.statuses[s]).toBeTruthy();
      }
      for (const d of HR_OVERTIME_DAY_TYPES) expect(locale.hrMy.overtime.dayTypes[d]).toBeTruthy();
      for (const dec of HR_PROBATION_DECISIONS) expect(locale.hrEmployees.probation.decisions[dec]).toBeTruthy();
      expect(locale.hrPayroll.syncOvertime).toBeTruthy();
      expect(locale.hrMy.overtime.commentaryNote).not.toContain('\u2014');
      expect(locale.hrEmployees.overtimeQueue.commentaryBadge).not.toContain('\u2014');
    }
  });

  it('renders self onboarding & OT cards with accessible table headers and 44px phone targets', () => {
    const obSubmission: HrOnboardingSubmissionView = {
      id: '00000000-0000-7000-8000-000000000810',
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      legalEntityId: LE_ID,
      departmentName: 'Kỹ thuật',
      status: 'pending',
      contactConfirmed: true,
      idConfirmed: false,
      bankConfirmed: false,
      handbookConfirmed: true,
      address: '12 Lê Lợi',
      birthDate: null,
      bankCode: 'VCB',
      hasIdentityNumber: true,
      hasBankAccount: true,
      hasTaxCode: false,
      hasInsuranceNumber: false,
      note: 'Nhờ HR cập nhật',
      decisionNote: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: '2026-11-10T03:00:00.000Z',
    };
    const obState: HrSelfOnboardingState = {
      employeeId: EMP_ID,
      checklist: {
        hasAddress: false,
        hasBirthDate: false,
        hasIdentityNumber: false,
        hasBankAccount: false,
        bankCode: null,
        hasTaxCode: false,
        hasInsuranceNumber: false,
        contactConfirmed: true,
        idConfirmed: false,
        bankConfirmed: false,
        handbookConfirmed: true,
      },
      submissions: [obSubmission],
    };
    cache.current.setQueryData(['hr', 'self', 'onboarding', 'get', {}], obState);

    const month = vietnamToday().slice(0, 7);
    const otSelf: HrOvertimeRequestView = {
      id: '00000000-0000-7000-8000-000000000811',
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      legalEntityId: LE_ID,
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      month,
      workDate: `${month}-10`,
      hours: '3.5',
      dayType: 'weekday',
      isNight: false,
      multiplierPercent: 150,
      ruleStatus: 'commentary',
      ruleId: 'overtime_multiples.normal_day',
      status: 'pending_l1',
      l1ApproverUserId: null,
      l1ActedAt: null,
      finalActedBy: null,
      finalActedAt: null,
      reason: 'Triển khai bản vá',
      decisionNote: null,
      createdAt: '2026-11-10T04:00:00.000Z',
    };
    const otTeam: HrOvertimeRequestView = {
      ...otSelf,
      id: '00000000-0000-7000-8000-000000000812',
      employeeName: 'Trần Thị B',
    };
    const otState: HrSelfOvertimeListResult = {
      requests: [otSelf],
      teamPending: [otTeam],
      monthApprovedHours: '4',
    };
    cache.current.setQueryData(['hr', 'self', 'overtime', 'list', { month, limit: 100 }], otState);

    const obHtml = wrap(<HrSelfOnboardingCard />, 'vi');
    expect(obHtml).toContain('data-testid="hr-my-onboarding"');
    expect(obHtml).toContain('<th scope="col"');
    expect(obHtml).toContain('min-h-[44px]');
    expect(obHtml).toContain('data-testid="hr-my-onboarding-cancel"');

    const otHtml = wrap(<HrSelfOvertimeCard />, 'vi');
    expect(otHtml).toContain('data-testid="hr-my-overtime"');
    expect(otHtml).toContain('<th scope="col"');
    expect(otHtml).toContain('150%');
    expect(otHtml).toContain('data-testid="hr-my-ot-team-queue"');
    expect(otHtml).toContain('data-testid="hr-my-ot-approve-l1"');
    expect(otHtml).toContain('max-md:min-h-11');

    // Unlinked manager sees team L1 OT approval queue without self submission card.
    const unlinkedManagerOt = wrap(<HrSelfOvertimeCard linked={false} />, 'en');
    expect(unlinkedManagerOt).not.toContain('data-testid="hr-my-overtime"');
    expect(unlinkedManagerOt).toContain('data-testid="hr-my-ot-team-queue"');
  });

  it('renders admin onboarding & OT queues and payroll syncOvertime button', () => {
    const obRow: HrOnboardingSubmissionView = {
      id: '00000000-0000-7000-8000-000000000820',
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      legalEntityId: LE_ID,
      departmentName: 'Kỹ thuật',
      status: 'pending',
      contactConfirmed: true,
      idConfirmed: true,
      bankConfirmed: false,
      handbookConfirmed: false,
      address: '12 Lê Lợi',
      birthDate: '1998-05-10',
      bankCode: 'VCB',
      hasIdentityNumber: true,
      hasBankAccount: true,
      hasTaxCode: false,
      hasInsuranceNumber: false,
      note: 'Cập nhật hồ sơ',
      decisionNote: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: '2026-11-10T03:00:00.000Z',
    };
    const otRow: HrOvertimeRequestView = {
      id: '00000000-0000-7000-8000-000000000821',
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      legalEntityId: LE_ID,
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      month: '2026-11',
      workDate: '2026-11-15',
      hours: '4',
      dayType: 'weekend',
      isNight: false,
      multiplierPercent: 200,
      ruleStatus: 'commentary',
      ruleId: 'overtime_multiples.weekly_rest_day',
      status: 'pending_final',
      l1ApproverUserId: null,
      l1ActedAt: null,
      finalActedBy: null,
      finalActedAt: null,
      reason: 'Bảo trì máy chủ',
      decisionNote: null,
      createdAt: '2026-11-15T10:00:00.000Z',
    };

    cache.current.setQueryData(['hr', 'onboarding', 'list', { limit: 100 }], [obRow]);
    cache.current.setQueryData(['hr', 'overtimeRequests', 'list', { limit: 100 }], [otRow]);

    const obQueue = wrap(<HrOnboardingReviewQueue />, 'en');
    expect(obQueue).toContain('data-testid="hr-onboarding-queue"');
    expect(obQueue).toContain('data-testid="hr-onboarding-queue-approve"');
    expect(obQueue).toContain('ID number (sealed)');
    expect(obQueue).toContain('max-md:min-h-11');

    const otQueue = wrap(<HrOvertimeReviewQueue />, 'en');
    expect(otQueue).toContain('data-testid="hr-overtime-queue"');
    expect(otQueue).toContain('data-testid="hr-overtime-commentary-badge"');
    expect(otQueue).toContain('200%');
    expect(otQueue).toContain('data-testid="hr-overtime-queue-approve-final"');
    expect(otQueue).toContain('max-md:min-h-11');

    const sheet: HrRunSheet = {
      run: {
        id: RUN_ID,
        month: '2026-11',
        status: 'draft',
        legalEntityId: LE_ID,
        employerName: 'Cty TNHH Crove',
        workingDays: '26',
        approvedAt: null,
      },
      lines: [
        {
          id: '00000000-0000-7000-8000-000000000830',
          kind: 'pay',
          employeeId: EMP_ID,
          employeeName: 'Nguyễn Văn A',
          status: 'calculated',
          refusal: null,
          flags: [],
          inputs: {},
          figures: {
            gross: '20000000',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '200000',
            taxableIncome: '17900000',
            pit: '400000',
            net: '17500000',
            employerCost: '24500000',
          },
          breakdown: {
            pay: {
              baseWage: '20000000',
              allowances: [],
              otherRegularPay: '0',
              unpaidReduction: '0',
              sicknessBhxhReduction: '0',
              maternityBhxhReduction: '0',
              hourlyRate: null,
              overtime: [],
              nightWork: null,
              bonus: '0',
            },
            insurance: { insurablePay: '20000000', suspended: null, bounds: [], funds: [], unionFee: '200000' },
            tax: {
              mode: 'progressive',
              exemptMealCash: '0',
              exemptOvertime: '0',
              exemptNightWork: '0',
              taxableIncome: '17900000',
              incomeAfterInsurance: '17900000',
              personalDeduction: '11000000',
              dependentsCounted: 0,
              dependentDeduction: '0',
              pensionDeduction: '0',
              assessableIncome: '6900000',
              slices: [],
              flatPercent: null,
            },
            deductions: { advance: '0', damage: '0', other: '0', total: '0' },
          },
          checks: [],
          note: null,
          adjustsMonth: null,
        },
      ],
      totals: {
        gross: '20000000',
        employeeInsurance: '2100000',
        employerInsurance: '4300000',
        unionFee: '200000',
        taxableIncome: '17900000',
        pit: '400000',
        net: '17500000',
        employerCost: '24500000',
      },
      rules: [],
      blocking: [],
      fingerprint: 'b'.repeat(64),
      approvable: true,
      obstacles: [],
    };
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'sheet', { runId: RUN_ID }], sheet);
    const sheetHtml = wrap(<Sheet runId={RUN_ID} approvedRuns={[]} onBack={() => {}} />, 'en');
    expect(sheetHtml).toContain('data-testid="hr-sync-overtime"');
    expect(sheetHtml).toContain(en.hrPayroll.syncOvertime);
  });

  it('renders probation panel with Projects badge, table headers, editable Ly draft, and human-only decisions', () => {
    const previewOn: HrProbationPreviewResult = {
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      linkedUserId: '00000000-0000-7000-8000-000000000840',
      departmentName: 'Kỹ thuật',
      jobTitle: 'Kỹ sư phần mềm',
      probationEndOn: '2026-11-30',
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
      projectsAvailable: true,
      completedTasksCount: 1,
      completedTasks: [
        {
          taskId: TASK_ID,
          title: 'Xây dựng API chấm công',
          projectId: PROJ_ID,
          projectName: 'Ludy HR',
          completedAt: '2026-11-10T09:00:00.000Z',
        },
      ],
      attendance: {
        monthCount: 2,
        annualLeaveDays: '0.5',
        personalPaidLeaveDays: '0',
        unpaidLeaveDays: '0',
        sicknessBhxhDays: '0',
        maternityBhxhDays: '0',
        overtimeHours: '3',
        overtimeRequestsCount: 1,
      },
    };
    const pastReview: HrProbationReviewView = {
      id: '00000000-0000-7000-8000-000000000850',
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn A',
      reviewerUserId: '00000000-0000-7000-8000-000000000841',
      probationEndOn: '2026-11-30',
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
      completedTasksCount: 1,
      completedTasks: previewOn.completedTasks,
      projectsAvailable: true,
      attendance: previewOn.attendance,
      decision: 'extend',
      extendedUntil: '2026-12-31',
      reviewNote: 'Cần thêm thời gian bàn giao.',
      aiDraftNote: null,
      decidedAt: '2026-11-30T10:00:00.000Z',
      createdAt: '2026-11-30T10:00:00.000Z',
    };

    cache.current.setQueryData(['hr', 'probation', 'preview', { employeeId: EMP_ID }], previewOn);
    cache.current.setQueryData(['hr', 'probation', 'list', { employeeId: EMP_ID, limit: 20 }], [pastReview]);

    const onHtml = wrap(<HrProbationPanel employeeId={EMP_ID} />, 'vi');
    expect(onHtml).toContain('data-testid="hr-probation-panel"');
    expect(onHtml).toContain(viMessages.hrEmployees.probation.projectsBadge);
    expect(onHtml).toContain('<th scope="col"');
    expect(onHtml).toContain('Xây dựng API chấm công');
    expect(onHtml).toContain('data-testid="hr-probation-draft-ai"');
    expect(onHtml).toContain('min-h-11');
    // No decision radio is pre-checked before human selection, regardless of attribute order.
    for (const decision of ['pass', 'extend', 'terminate'] as const) {
      const radioMatch = onHtml.match(
        new RegExp(`<input\\b[^>]*\\bdata-testid="hr-probation-decision-${decision}"[^>]*>`),
      );
      expect(radioMatch?.[0]).toBeTruthy();
      expect(radioMatch?.[0]).not.toMatch(/\bchecked(?:=|(?:\s|\/?>))/);
    }

    cache.current.clear();
    cache.current.setQueryData(
      ['hr', 'probation', 'preview', { employeeId: EMP_ID }],
      { ...previewOn, projectsAvailable: false, completedTasksCount: 0, completedTasks: [] },
    );
    cache.current.setQueryData(['hr', 'probation', 'list', { employeeId: EMP_ID, limit: 20 }], []);
    const offHtml = wrap(<HrProbationPanel employeeId={EMP_ID} />, 'en');
    expect(offHtml).toContain(en.hrEmployees.probation.projectsOffBadge);
    expect(offHtml).toContain('data-testid="hr-probation-tasks-empty"');

    // Scope & evidence mismatch protections: editing period dates blocks submission until facts are reloaded for the new range.
    expect(
      previewMatchesProbationRange({
        preview: previewOn,
        isFetching: false,
        isError: false,
        employeeId: EMP_ID,
        effectiveStart: '2026-10-01',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(true);
    expect(
      previewMatchesProbationRange({
        preview: previewOn,
        isFetching: false,
        isError: false,
        employeeId: EMP_ID,
        effectiveStart: '2026-10-05',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(false);
    expect(
      previewMatchesProbationRange({
        preview: previewOn,
        isFetching: true,
        isError: false,
        employeeId: EMP_ID,
        effectiveStart: '2026-10-01',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(false);
    expect(
      previewMatchesProbationRange({
        preview: previewOn,
        isFetching: false,
        isError: true,
        employeeId: EMP_ID,
        effectiveStart: '2026-10-01',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(false);
    expect(
      canSubmitProbationDecision({
        decision: 'pass',
        rangeValid: true,
        previewMatchesRange: false,
        extendedUntil: '',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(false);
    expect(
      canSubmitProbationDecision({
        decision: 'pass',
        rangeValid: true,
        previewMatchesRange: true,
        extendedUntil: '',
        effectiveEnd: '2026-11-30',
      }),
    ).toBe(true);
    expect(probationScopeKey(EMP_ID, '2026-10-01', '2026-11-30')).not.toBe(
      probationScopeKey(EMP_ID, '2026-10-05', '2026-11-30'),
    );

    // Editing only bonus omits untouched overtime from payload; modifying overtime includes it.
    const initialState = stateOf({
      overtime: [{ dayKind: 'normal_day', night: false, hours: '2' }],
      bonus: '0',
    });
    const bonusOnlyPayload = buildLineInputsUpdatePayload(
      { ...initialState, bonus: '500000' },
      initialState.overtime,
    );
    expect(bonusOnlyPayload.bonus).toBe('500000');
    expect('overtime' in bonusOnlyPayload).toBe(false);

    const editedOtPayload = buildLineInputsUpdatePayload(
      { ...initialState, overtime: [{ dayKind: 'normal_day', night: false, hours: '3' }] },
      initialState.overtime,
    );
    expect(editedOtPayload.overtime).toEqual([{ dayKind: 'normal_day', night: false, hours: '3' }]);
  });
});
