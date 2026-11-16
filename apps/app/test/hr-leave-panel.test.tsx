// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vietnamToday, type HrLeaveBalanceResult } from '@crove/kernel-contract';
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
          leave: { set: vi.fn(), delete: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
  };
});

const { LeaveBalancePanel, normalizeLeaveDaysInput } = await import('../src/components/hr-leave-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000020';

function renderLeavePanel(result: HrLeaveBalanceResult, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  const year = vietnamToday().slice(0, 4);
  cache.current.setQueryData(['hr', 'payroll', 'leave', 'balance', { employeeId: EMP_ID, year, category: 'standard' }], result);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <LeaveBalancePanel employeeId={EMP_ID} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Annual leave ledger panel and pay-run leave copy (#3394)', () => {
  beforeEach(() => cache.current.clear());

  it('renders balance summary, entry rows, exceeded days highlight, and rule citations in vi and en', () => {
    const year = vietnamToday().slice(0, 4);
    const sample: HrLeaveBalanceResult = {
      employeeId: EMP_ID,
      year,
      category: 'standard',
      hireDate: `${year}-01-01`,
      endedOn: null,
      entries: [
        { id: '00000000-0000-7000-8000-000000000101', employeeId: EMP_ID, month: `${year}-01`, kind: 'opening_balance', days: '2.00', approved: true },
        { id: '00000000-0000-7000-8000-000000000102', employeeId: EMP_ID, month: `${year}-05`, kind: 'annual_leave', days: '15.50', approved: true },
        { id: '00000000-0000-7000-8000-000000000103', employeeId: EMP_ID, month: `${year}-06`, kind: 'unpaid_leave', days: '1.00', approved: true },
      ],
      balance: {
        year,
        eligibleMonths: 12,
        entitlementDays: '12',
        seniorityYears: 5,
        seniorityDays: '1',
        totalEntitlementDays: '13',
        openingDays: '2',
        takenAnnualDays: '15.5',
        signedBalanceDays: '-0.5',
        remainingAnnualDays: '0',
        exceededAnnualDays: '0.5',
        personalPaidDays: '0',
        unpaidDaysByMonth: { [`${year}-06`]: '1' },
        rulesUsed: [
          {
            id: 'annual_leave.standard_entitlement@2021-02-01',
            kind: 'leave',
            key: 'standard_days',
            effectiveFrom: '2021-02-01',
            status: 'confirmed',
          },
        ],
      },
    };

    const htmlVi = renderLeavePanel(sample, 'vi');
    expect(htmlVi).toContain('data-testid="hr-leave-panel"');
    expect(htmlVi).toContain('data-testid="hr-leave-remaining"');
    expect(htmlVi).toContain('data-testid="hr-leave-exceeded"');
    expect(htmlVi).toContain('text-destructive');
    expect(htmlVi).toContain('15.50');
    expect(htmlVi).toContain('annual_leave.standard_entitlement@2021-02-01');
    expect(htmlVi).toContain('data-testid="hr-leave-delete"');

    const htmlEn = renderLeavePanel(sample, 'en');
    expect(htmlEn).toContain('Annual leave ledger');
    expect(htmlEn).toContain('Unpaid leave');
    expect(htmlEn).toContain('standard_days');
  });

  it('provides localized vi and en copy for leave sync and annual_leave_exceeded flag', () => {
    expect(viMessages.hrPayroll.flag.annual_leave_exceeded.length).toBeGreaterThan(0);
    expect(en.hrPayroll.flag.annual_leave_exceeded.length).toBeGreaterThan(0);
    expect(viMessages.hrPayroll.syncLeave.length).toBeGreaterThan(0);
    expect(en.hrPayroll.syncLeave.length).toBeGreaterThan(0);
    expect(viMessages.commands.hr.payroll.leave.balance.length).toBeGreaterThan(0);
    expect(en.commands.hr.payroll.leave.balance.length).toBeGreaterThan(0);
    expect(viMessages.commands.hr.payroll.run.sync_leave.length).toBeGreaterThan(0);
    expect(en.commands.hr.payroll.run.sync_leave.length).toBeGreaterThan(0);
  });

  it('normalizes comma decimals and keeps malformed multi-separator inputs invalid', () => {
    expect(normalizeLeaveDaysInput('1,5')).toBe('1.5');
    expect(normalizeLeaveDaysInput('1.25')).toBe('1.25');
    const multi = normalizeLeaveDaysInput('1,5,2');
    expect(multi).toBe('1.5.2');
    expect(/^\d{1,3}(\.\d{1,2})?$/.test(multi)).toBe(false);
  });
});
