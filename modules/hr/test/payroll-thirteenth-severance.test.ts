// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HR_JOB_LOSS_INELIGIBLE_REASONS,
  HR_JOB_LOSS_TERMINATION_REASONS,
  HR_LINE_FLAGS,
  HR_SEVERANCE_INELIGIBLE_REASONS,
  HR_SEVERANCE_TERMINATION_REASONS,
  zHrEmployeeJobLossAsk,
  zHrEmployeeSeveranceAsk,
  zHrPayrollInputs,
  zHrRunApplyThirteenthMonth,
  zHrRunThirteenthMonthPreview,
} from '@ludy/kernel-contract';
import { JOB_LOSS_TERMINATION_REASONS, PAYROLL_RULES, SEVERANCE_TERMINATION_REASONS, calculatePayroll } from '@ludy/l10n-vn';
import { hrCommands, hrQueries } from '../src/index.ts';
import { employeeJobLoss, employeeSeverance } from '../src/employees.ts';
import { runApplyThirteenthMonth, runApprove, runThirteenthMonthPreview } from '../src/payroll-run.ts';

describe('13th-month salary and statutory severance contracts & domain guards (#3375)', () => {
  it('registers commands and sensitive queries with manager-only access and matching enums', () => {
    expect(runThirteenthMonthPreview.name).toBe('hr.payroll.run.thirteenth_month_preview');
    expect(runThirteenthMonthPreview.access).toEqual(['owner', 'admin']);
    expect(runThirteenthMonthPreview.sensitive).toBe(true);
    expect(hrQueries.some((q) => q.name === 'hr.payroll.run.thirteenth_month_preview')).toBe(true);

    expect(runApplyThirteenthMonth.name).toBe('hr.payroll.run.apply_thirteenth_month');
    expect(runApplyThirteenthMonth.risk).toBe('R1');
    expect(runApplyThirteenthMonth.sideEffect).toBe('internal');
    expect(runApplyThirteenthMonth.access).toEqual(['owner', 'admin']);
    expect(runApplyThirteenthMonth.permission).toBe('hr.payroll.run');
    expect(hrCommands.some((c) => c.name === 'hr.payroll.run.apply_thirteenth_month')).toBe(true);

    expect(employeeSeverance.name).toBe('hr.payroll.employee.severance');
    expect(employeeSeverance.access).toEqual(['owner', 'admin']);
    expect(employeeSeverance.sensitive).toBe(true);
    expect(hrQueries.some((q) => q.name === 'hr.payroll.employee.severance')).toBe(true);

    expect(employeeJobLoss.name).toBe('hr.payroll.employee.job_loss');
    expect(employeeJobLoss.access).toEqual(['owner', 'admin']);
    expect(employeeJobLoss.sensitive).toBe(true);
    expect(hrQueries.some((q) => q.name === 'hr.payroll.employee.job_loss')).toBe(true);

    expect(HR_LINE_FLAGS).toContain('severance_check');
    expect(HR_SEVERANCE_TERMINATION_REASONS).toEqual(SEVERANCE_TERMINATION_REASONS);
    expect(HR_SEVERANCE_INELIGIBLE_REASONS).toContain('worked_under_12_months');
    expect(HR_JOB_LOSS_TERMINATION_REASONS).toEqual(JOB_LOSS_TERMINATION_REASONS);
    expect(HR_JOB_LOSS_INELIGIBLE_REASONS).toEqual(['worked_under_12_months', 'not_job_loss_reason']);
  });

  it('validates 13th-month preview/apply and severance query schemas strictly', () => {
    const runId = randomUUID();
    const lineA = randomUUID();
    const empA = randomUUID();

    expect(zHrRunThirteenthMonthPreview.parse({ runId })).toMatchObject({ runId, minDaysForMonth: 15 });
    expect(zHrRunThirteenthMonthPreview.safeParse({ runId, year: 2019 }).success).toBe(false);
    expect(zHrRunThirteenthMonthPreview.safeParse({ runId, minDaysForMonth: 32 }).success).toBe(false);

    const parsedApply = zHrRunApplyThirteenthMonth.parse({
      runId,
      year: 2026,
      rows: [{ lineId: lineA, workedMonths: '6.5' }],
    });
    expect(parsedApply.mode).toBe('replace');

    expect(zHrRunApplyThirteenthMonth.safeParse({ runId, year: 2026, mode: 'replace', rows: [] }).success).toBe(false);
    expect(
      zHrRunApplyThirteenthMonth.safeParse({
        runId,
        year: 2026,
        mode: 'replace',
        rows: [{ lineId: lineA, workedMonths: '13' }],
      }).success,
    ).toBe(false);
    expect(
      zHrRunApplyThirteenthMonth.safeParse({
        runId,
        year: 2026,
        mode: 'add',
        rows: [
          { lineId: lineA, workedMonths: 6 },
          { lineId: lineA, workedMonths: 6 },
        ],
      }).success,
    ).toBe(false);

    expect(
      zHrEmployeeSeveranceAsk.parse({
        employeeId: empA,
        endedOn: '2026-11-30',
        terminationReason: 'mutual_agreement',
        totalWorkedMonths: 24,
        unemploymentInsuredMonths: 6,
        priorSettledMonths: 0,
        paidAmount: '15000000',
      }),
    ).toMatchObject({ employeeId: empA, terminationReason: 'mutual_agreement' });

    expect(zHrEmployeeSeveranceAsk.safeParse({ employeeId: empA, endedOn: '2026-02-30' }).success).toBe(false);
    expect(zHrEmployeeSeveranceAsk.safeParse({ employeeId: empA, totalWorkedMonths: -1 }).success).toBe(false);

    expect(
      zHrEmployeeJobLossAsk.parse({
        employeeId: empA,
        endedOn: '2026-11-30',
        terminationReason: 'economic_reasons',
        totalWorkedMonths: 24,
        unemploymentInsuredMonths: 24,
        priorSettledMonths: 0,
        paidAmount: '25000000',
      }),
    ).toMatchObject({ employeeId: empA, terminationReason: 'economic_reasons' });
    expect(zHrEmployeeJobLossAsk.safeParse({ employeeId: empA, endedOn: '2026-02-30' }).success).toBe(false);
    expect(zHrEmployeeJobLossAsk.safeParse({ employeeId: empA, totalWorkedMonths: -1 }).success).toBe(false);
    expect(zHrEmployeeJobLossAsk.safeParse({ employeeId: empA, terminationReason: 'mutual_agreement' }).success).toBe(false);
  });

  it('keeps payroll_line.rules_used free of LaborRuleRef IDs after 13th-month bonus update so runApprove succeeds', async () => {
    const savedStatuses = PAYROLL_RULES.map((r) => ({ row: r as { status: string }, status: r.status }));
    try {
      for (const r of PAYROLL_RULES) (r as { status: string }).status = 'confirmed';
      const inputs = zHrPayrollInputs.parse({ bonus: '15000000' });
      const c = calculatePayroll(
        { region: 'I', contract: 'indefinite', contractTermMonths: null, resident: true, insured: true, baseWage: '15000000', allowances: [], otherRegularPay: '0', commitment: false },
        { month: '2026-12', standardWorkingDays: '26', unpaidLeaveDays: '0', daysNotEmployed: '0', overtime: [], nightHours: '0', bonus: inputs.bonus, dependents: [], voluntaryPension: '0', deductions: [], withholdingRequested: false },
        PAYROLL_RULES,
      );
      const run = { id: 'run-13th', legal_entity_id: 'entity', month: '2026-12', status: 'draft', working_days: '26', approved_at: null, approval: null };
      const line = {
        id: 'line-13th',
        employee_id: 'employee',
        employment_id: 'employment',
        kind: 'pay',
        status: 'calculated',
        inputs,
        gross: c.gross,
        employee_insurance: c.employeeInsurance,
        employer_insurance: c.employerInsurance,
        union_fee: c.unionFee,
        taxable_income: c.taxableIncome,
        pit: c.pit,
        net: c.net,
        employer_cost: c.employerCost,
        checks: [...c.checks, { id: 'overtime_cap', ok: true, actual: '0', limit: '40' }],
        rules_used: c.rulesUsed,
        refusal: null,
        breakdown: c.breakdown,
        note: null,
        adjusts_run_id: null,
      };
      const tables: Record<string, unknown[]> = {
        'ludy_hr.payroll_run': [run],
        'ludy_hr.payroll_line': [line],
        'ludy_hr.payroll_employee': [{ id: 'employee', display_name: 'Test Person', ended_on: null, erased_at: null }],
        'ludy_hr.payroll_employment': [{ id: 'employment', employee_id: 'employee', effective_from: '2026-01-01', contract_type: 'indefinite', region: 'I', base_wage: '15000000' }],
        'ludy_hr.payroll_dependent': [],
      };
      const query = (table: string): unknown => {
        const q: unknown = new Proxy(
          {},
          {
            get(_, p) {
              if (p === 'execute') return async () => tables[table] ?? [];
              if (p === 'executeTakeFirst') return async () => (tables[table] ?? [])[0];
              return () => q;
            },
          },
        );
        return q;
      };
      const ctx = {
        actor: { type: 'user', userId: 'owner', aal: 'aal2', sessionId: 's1', mfaAt: Math.floor(Date.now() / 1000) },
        orgId: 'org',
        now: new Date(),
        trx: { selectFrom: query, updateTable: query },
        audit: () => {},
      } as unknown as Parameters<typeof runApprove.handler>[0];

      // Expect fingerprint mismatch (not listRulesUsed crash or HR_RUN_STALE), confirming rules_used is valid.
      await expect(runApprove.handler(ctx, { runId: 'run-13th', fingerprint: '0'.repeat(64), acceptFlags: false })).rejects.toMatchObject({
        code: 'HR_RUN_CHANGED',
      });
    } finally {
      for (const s of savedStatuses) s.row.status = s.status;
    }
  });
});
