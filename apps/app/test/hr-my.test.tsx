// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HrLeaveRequestView,
  HrPayslip,
  HrSelfLeaveBalanceResult,
  HrSelfPayslipSummary,
  HrSelfProfile,
} from '@ludy/kernel-contract';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
    client: {},
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
  };
});

const { HrSelfServicePage, SelfPayslipDetail, buildDeterministicPayslipExplanation, isValidSelfLeaveDays } = await import(
  '../src/routes/hr-my.tsx'
);
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');
const { formatMoney } = await import('../src/lib/format.ts');

const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};

const EMP_ID = '00000000-0000-7000-8000-000000000501';
const OTHER_EMP_ID = '00000000-0000-7000-8000-000000000502';
const LE_ID = '00000000-0000-7000-8000-000000000503';
const DEPT_ID = '00000000-0000-7000-8000-000000000504';
const REQ_SELF_ID = '00000000-0000-7000-8000-000000000505';
const REQ_TEAM_ID = '00000000-0000-7000-8000-000000000506';
const LINE_ID = '00000000-0000-7000-8000-000000000507';
const RUN_ID = '00000000-0000-7000-8000-000000000508';

describe('HR self-service portal UI (#4300)', () => {
  beforeEach(() => cache.current.clear());

  it('validates self leave days and renders unlinked state cleanly', () => {
    expect(isValidSelfLeaveDays('annual_leave', '1.5')).toBe(true);
    expect(isValidSelfLeaveDays('annual_leave', '0')).toBe(false);
    expect(isValidSelfLeaveDays('unpaid_leave', '1.25')).toBe(false);
    expect(isValidSelfLeaveDays('unpaid_leave', '1.5')).toBe(true);

    const unlinked: HrSelfProfile = {
      linked: false,
      employeeId: null,
      displayName: null,
      legalEntityId: null,
      legalEntityName: null,
      departmentId: null,
      departmentName: null,
      departmentManagerName: null,
      jobTitle: null,
      status: null,
      hireDate: null,
      endedOn: null,
      managesDepartmentCount: 0,
      managedDepartments: [],
    };
    cache.current.setQueryData(['hr', 'self', 'profile', 'get', {}], unlinked);

    const html = wrap(<HrSelfServicePage />, 'vi');
    expect(html).toContain('data-testid="hr-my-unlinked"');
    expect(html).not.toContain('data-testid="hr-my-leave-form"');
    expect(html).not.toContain('data-testid="hr-my-payslips"');

    const htmlEn = wrap(<HrSelfServicePage />, 'en');
    expect(htmlEn).toContain(enMessages.hrMy.unlinkedTitle);
  });

  it('renders linked employee profile, balance, requests, L1 team queue, approved payslips, and deterministic explanation', () => {
    const profile: HrSelfProfile = {
      linked: true,
      employeeId: EMP_ID,
      displayName: 'Nguyễn Văn Tự Phục Vụ',
      legalEntityId: LE_ID,
      legalEntityName: 'Công ty TNHH Crove',
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      departmentManagerName: 'Trần Quản Lý',
      jobTitle: 'Kỹ sư phần mềm',
      status: 'active',
      hireDate: '2025-01-15',
      endedOn: null,
      managesDepartmentCount: 1,
      managedDepartments: [{ id: DEPT_ID, legalEntityId: LE_ID, name: 'Kỹ thuật', code: 'ENG' }],
    };
    const year = new Date().toISOString().slice(0, 4);
    const balance: HrSelfLeaveBalanceResult = {
      linked: true,
      employeeId: EMP_ID,
      year,
      category: 'standard',
      hireDate: '2025-01-15',
      endedOn: null,
      entries: [],
      balance: {
        year,
        eligibleMonths: 12,
        entitlementDays: '12',
        seniorityYears: 0,
        seniorityDays: '0',
        totalEntitlementDays: '12',
        openingDays: '0',
        takenAnnualDays: '2',
        signedBalanceDays: '10',
        remainingAnnualDays: '10',
        exceededAnnualDays: '0',
        personalPaidDays: '0',
        unpaidDaysByMonth: {},
        sicknessBhxhDays: '0',
        maternityBhxhDays: '0',
        sicknessBhxhDaysByMonth: {},
        maternityBhxhDaysByMonth: {},
        rulesUsed: [],
      },
    };
    const selfReq: HrLeaveRequestView = {
      id: REQ_SELF_ID,
      legalEntityId: LE_ID,
      employeeId: EMP_ID,
      employeeName: 'Nguyễn Văn Tự Phục Vụ',
      departmentId: DEPT_ID,
      departmentName: 'Kỹ thuật',
      month: '2026-11',
      startOn: '2026-11-18',
      endOn: '2026-11-19',
      kind: 'annual_leave',
      days: '2.00',
      status: 'pending_final',
      reason: 'Nghỉ phép gia đình',
      decisionNote: null,
      l1ApproverUserId: null,
      l1ApproverName: null,
      l1ActedAt: null,
      finalActedBy: null,
      finalActedByName: null,
      finalActedAt: null,
      payrollLeaveEntryId: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    const teamReq: HrLeaveRequestView = {
      ...selfReq,
      id: REQ_TEAM_ID,
      employeeId: OTHER_EMP_ID,
      employeeName: 'Lê Thị Nhân Viên',
      status: 'pending_l1',
      reason: 'Việc riêng',
    };
    const payslips: HrSelfPayslipSummary[] = [
      {
        lineId: LINE_ID,
        runId: RUN_ID,
        month: '2026-10',
        status: 'approved',
        gross: '20000000.00',
        net: '17500000.00',
        approvedAt: '2026-11-01T00:00:00.000Z',
      },
    ];

    cache.current.setQueryData(['hr', 'self', 'profile', 'get', {}], profile);
    cache.current.setQueryData(['hr', 'self', 'leave', 'balance', { year }], balance);
    cache.current.setQueryData(['hr', 'self', 'leave', 'requests', { scope: 'all' }], [selfReq, teamReq]);
    cache.current.setQueryData(['hr', 'self', 'payslips', 'list', { limit: 24 }], payslips);

    const html = wrap(<HrSelfServicePage />, 'vi');
    expect(html).toContain('Nguyễn Văn Tự Phục Vụ');
    expect(html).toContain('data-testid="hr-my-remaining-days"');
    expect(html).toContain('data-testid="hr-my-leave-form"');
    expect(html).toContain('data-testid="hr-my-request-row"');
    expect(html).toContain('data-testid="hr-my-cancel"');
    expect(html).toContain('data-testid="hr-my-team-queue"');
    expect(html).toContain('Lê Thị Nhân Viên');
    expect(html).toContain('data-testid="hr-my-l1-approve"');
    expect(html).toContain('data-testid="hr-my-payslip-row"');
    expect(html).toContain('2026-10');

    const payslip: HrPayslip = {
      lineId: LINE_ID,
      runId: RUN_ID,
      month: '2026-10',
      status: 'approved',
      employerName: 'Công ty TNHH Crove',
      employeeName: 'Nguyễn Văn Tự Phục Vụ',
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
          baseWage: '18000000',
          allowances: [{ code: 'meal', label: 'Phụ cấp ăn trưa', paid: '1000000', taxable: '0' }],
          overtime: [],
          nightWork: null,
          bonus: '1000000',
        },
        insurance: { base: '18000000', funds: [] },
        deductions: { advance: '0', damage: '0', other: '0' },
      },
      inputs: {},
    };
    const explanation = buildDeterministicPayslipExplanation(
      payslip,
      (v, c) => formatMoney(v, 'vi', c),
      ((key: string, params?: Record<string, unknown>) => {
        const parts = key.split('.');
        let cur: unknown = viMessages.hrMy;
        for (const p of parts) cur = (cur as Record<string, unknown>)[p];
        let text = String(cur);
        if (params) {
          for (const [k, val] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(val));
        }
        return text;
      }) as never,
    );
    expect(explanation).toContain('2026-10');
    expect(explanation).toContain('20.000.000');
    expect(explanation).toContain('17.500.000');

    cache.current.setQueryData(['hr', 'self', 'payslips', 'get', { lineId: LINE_ID }], payslip);
    const detailVi = wrap(<SelfPayslipDetail lineId={LINE_ID} onClose={() => {}} />, 'vi');
    expect(detailVi).toContain('data-testid="hr-my-payslip-detail"');
    expect(detailVi).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="hr-my-payslip-explain"/);
    expect(detailVi).toContain('<thead>');
    expect(detailVi).toContain(`<th scope="col" class="py-1.5 pr-6 text-left font-medium">${viMessages.hrMy.payslips.itemCol}</th>`);
    expect(detailVi).toContain(`<th scope="col" class="py-1.5 text-right font-medium">${viMessages.hrMy.payslips.amountCol}</th>`);
    expect(detailVi).not.toContain('data-testid="hr-my-payslip-explanation"');

    const detailEn = wrap(<SelfPayslipDetail lineId={LINE_ID} onClose={() => {}} initialExplained />, 'en');
    expect(detailEn).toMatch(/<button[^>]*aria-expanded="true"[^>]*data-testid="hr-my-payslip-explain"/);
    expect(detailEn).toContain('<thead>');
    expect(detailEn).toContain(`<th scope="col" class="py-1.5 pr-6 text-left font-medium">${enMessages.hrMy.payslips.itemCol}</th>`);
    expect(detailEn).toContain(`<th scope="col" class="py-1.5 text-right font-medium">${enMessages.hrMy.payslips.amountCol}</th>`);
    expect(detailEn).toContain('data-testid="hr-my-payslip-explanation"');
  });
});
