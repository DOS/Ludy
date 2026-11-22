// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  vietnamMonth,
  type HrAttendanceListResult,
  type HrEmployeeSummary,
  type HrRunSummary,
  type HrSelfAttendanceListResult,
} from '@ludy/kernel-contract';
import { HrAttendanceCheckinCard } from '../src/components/hr-attendance-checkin-card.tsx';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { HrAttendancePage } from '../src/routes/hr-attendance.tsx';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'demo-org' }),
  Link: ({ children, ...rest }: Record<string, unknown>) => <a {...rest}>{children as never}</a>,
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
        if (prop === 'mutationOptions') {
          return () => ({ mutationFn: vi.fn() });
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
    isStepUpRequired: () => false,
  };
});

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectLeafKeys(v as Record<string, unknown>, next));
    } else {
      out.push(next);
    }
  }
  return out.sort();
}

describe('HR Stage 5C Attendance UI (#4447)', () => {
  const month = vietnamMonth(new Date());

  beforeEach(() => {
    cache.current.clear();
  });

  it('keeps bilingual vi/en keys in lockstep across hrMy.attendance and hrAttendance without em dashes', () => {
    expect(collectLeafKeys(viMessages.hrMy.attendance)).toEqual(collectLeafKeys(enMessages.hrMy.attendance));
    expect(collectLeafKeys(viMessages.hrAttendance)).toEqual(collectLeafKeys(enMessages.hrAttendance));
    const dump = JSON.stringify({
      viSelf: viMessages.hrMy.attendance,
      enSelf: enMessages.hrMy.attendance,
      viAdmin: viMessages.hrAttendance,
      enAdmin: enMessages.hrAttendance,
    });
    expect(dump).not.toContain('\u2014');
  });

  it('renders self-service check-in state, open check-out state, and completed shift summary', () => {
    const notCheckedIn: HrSelfAttendanceListResult = {
      employeeId: '00000000-0000-7000-8000-000000000010',
      legalEntityId: '00000000-0000-7000-8000-000000000001',
      month,
      today: `${month}-18`,
      todayLog: null,
      logs: [],
      summary: { presentDays: 0, halfDays: 0, missingCheckoutDays: 0, adjustedDays: 0, totalWorkedMinutes: 0 },
    };
    cache.current.setQueryData(['hr', 'self', 'attendance', 'list', { month }], notCheckedIn);

    const html1 = wrap(<HrAttendanceCheckinCard enabled />, 'vi');
    expect(html1).toContain('data-testid="hr-my-checkin-btn"');
    expect(html1).toContain('data-testid="hr-my-checkin-qr-toggle"');
    expect(html1).toContain('data-testid="hr-my-attendance-empty"');

    const checkedInOpen: HrSelfAttendanceListResult = {
      ...notCheckedIn,
      todayLog: {
        id: '00000000-0000-7000-8000-000000000020',
        legalEntityId: notCheckedIn.legalEntityId,
        employeeId: notCheckedIn.employeeId,
        workDate: `${month}-18`,
        checkedInAt: `${month}-18T01:30:00.000Z`,
        checkedOutAt: null,
        checkInMethod: 'qr',
        workedMinutes: null,
        status: 'missing_checkout',
        note: null,
        anomalies: [],
        updatedAt: `${month}-18T01:30:00.000Z`,
      },
      logs: [],
    };
    cache.current.setQueryData(['hr', 'self', 'attendance', 'list', { month }], checkedInOpen);
    const html2 = wrap(<HrAttendanceCheckinCard enabled />, 'vi');
    expect(html2).toContain('data-testid="hr-my-checkout-btn"');
    expect(html2).toContain('08:30');
    expect(html2).toContain(viMessages.hrMy.attendance.methods.qr);

    const completed: HrSelfAttendanceListResult = {
      ...notCheckedIn,
      todayLog: {
        ...checkedInOpen.todayLog!,
        checkedOutAt: `${month}-18T10:30:00.000Z`,
        workedMinutes: 540,
        status: 'present',
      },
      logs: [
        {
          ...checkedInOpen.todayLog!,
          checkedOutAt: `${month}-18T10:30:00.000Z`,
          workedMinutes: 540,
          status: 'present',
        },
        {
          id: '00000000-0000-7000-8000-000000000021',
          legalEntityId: notCheckedIn.legalEntityId,
          employeeId: notCheckedIn.employeeId,
          workDate: `${month}-17`,
          checkedInAt: `${month}-17T01:30:00.000Z`,
          checkedOutAt: null,
          checkInMethod: 'web',
          workedMinutes: null,
          status: 'missing_checkout',
          note: null,
          anomalies: ['missing_checkout'],
          updatedAt: `${month}-17T01:30:00.000Z`,
        },
      ],
      summary: { presentDays: 1, halfDays: 0, missingCheckoutDays: 1, adjustedDays: 0, totalWorkedMinutes: 540 },
    };
    cache.current.setQueryData(['hr', 'self', 'attendance', 'list', { month }], completed);
    const html3 = wrap(<HrAttendanceCheckinCard enabled />, 'en');
    expect(html3).toContain('9h');
    expect(html3).toContain('08:30');
    expect(html3).toContain('17:30');
    expect(html3).toContain(enMessages.hrMy.attendance.anomalies.missing_checkout);
  });

  it('renders admin attendance management sheet, anomalies, QR card, and payroll rollup trigger', () => {
    const empId = '00000000-0000-7000-8000-000000000010';
    const leId = '00000000-0000-7000-8000-000000000001';
    const logId = '00000000-0000-7000-8000-000000000030';
    const runId = '00000000-0000-7000-8000-000000000040';

    const adminList: HrAttendanceListResult = {
      month,
      today: `${month}-18`,
      legalEntityId: leId,
      logs: [
        {
          id: logId,
          legalEntityId: leId,
          employeeId: empId,
          employeeName: 'Nguyễn Thị Lan',
          payBasis: 'monthly',
          workDate: `${month}-16`,
          checkedInAt: `${month}-16T01:30:00.000Z`,
          checkedOutAt: `${month}-16T13:30:00.000Z`,
          checkInMethod: 'qr',
          workedMinutes: 720,
          status: 'present',
          note: 'Làm thêm dự án',
          anomalies: ['long_day'],
          updatedAt: `${month}-16T13:30:00.000Z`,
        },
      ],
      anomalies: [
        {
          logId,
          employeeId: empId,
          employeeName: 'Nguyễn Thị Lan',
          workDate: `${month}-16`,
          kind: 'long_day',
          workedMinutes: 720,
          status: 'present',
        },
      ],
      qrConfig: {
        configured: true,
        activeConfigId: '00000000-0000-7000-8000-000000000050',
        legalEntityId: leId,
        rotatedAt: '2026-11-01T00:00:00.000Z',
      },
    };

    const employees: HrEmployeeSummary[] = [
      {
        id: empId,
        legalEntityId: leId,
        displayName: 'Nguyễn Thị Lan',
        departmentId: null,
        departmentName: null,
        jobTitle: 'Kế toán',
        linkedUserId: null,
        linkedMemberName: null,
        status: 'active',
        endedOn: null,
        isForeign: false,
        workPermitExempt: true,
        workPermitExpiresOn: null,
        hasWorkPermitNumber: false,
        current: null,
        hasIdentityNumber: false,
        hasAccountNumber: false,
        contractAlerts: [],
      },
    ];

    const runs: HrRunSummary[] = [
      {
        id: runId,
        legalEntityId: leId,
        month,
        status: 'draft',
        workingDays: '26',
        lines: 1,
        refused: 0,
        totals: {
          gross: '15000000',
          employeeInsurance: '1575000',
          employerInsurance: '3225000',
          unionFee: '300000',
          taxableIncome: '15000000',
          pit: '0',
          net: '13425000',
          employerCost: '18525000',
        },
        approvedAt: null,
      },
    ];

    cache.current.setQueryData(['hr', 'attendance', 'list', { month, anomaliesOnly: false }], adminList);
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'list', {}], employees);
    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 60 }], runs);

    const html = wrap(<HrAttendancePage />, 'vi');
    expect(html).toContain('data-testid="hr-attendance-qr-card"');
    expect(html).toContain('data-testid="hr-attendance-qr-rotate"');
    expect(html).toContain('data-testid="hr-attendance-anomalies-ask"');
    expect(html).toContain('data-testid="hr-attendance-rollup-btn"');
    expect(html).toContain('Nguyễn Thị Lan');
    expect(html).toContain('12h');
    expect(html).toContain('Ca dài (&gt; 10h)');
  });
});
