// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HR_LINE_FLAGS, zHrCheck, zHrPayrollInputs, zHrRunImportTimekeeping } from '@ludy/kernel-contract';
import { calculatePayroll, PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands } from '../src/index.ts';
import { runApprove, runImportTimekeeping } from '../src/payroll-run.ts';

describe('hr.payroll.run.import_timekeeping contract and command (#3371)', () => {
  it('registers the command in hrCommands with manager-only R1 access and table writes', () => {
    expect(runImportTimekeeping.name).toBe('hr.payroll.run.import_timekeeping');
    expect(runImportTimekeeping.risk).toBe('R1');
    expect(runImportTimekeeping.sideEffect).toBe('internal');
    expect(runImportTimekeeping.access).toEqual(['owner', 'admin']);
    expect(runImportTimekeeping.permission).toBe('hr.payroll.run');
    expect(hrCommands.some((c) => c.name === 'hr.payroll.run.import_timekeeping')).toBe(true);
    expect(HR_LINE_FLAGS).toContain('check_overtime_cap');
    expect(zHrCheck.parse({ id: 'overtime_cap', ok: false, actual: '45', limit: '40' })).toEqual({
      id: 'overtime_cap',
      ok: false,
      actual: '45',
      limit: '40',
    });
  });

  it('validates row bounds, decimal strings, and rejects duplicate lineIds', () => {
    const runId = randomUUID();
    const lineA = randomUUID();
    const lineB = randomUUID();

    const ok = zHrRunImportTimekeeping.parse({
      runId,
      rows: [
        {
          lineId: lineA,
          unpaidLeaveDays: '1.5',
          daysNotEmployed: '0',
          nightHours: '6.25',
          overtime: [{ dayKind: 'normal_day', night: false, hours: '12' }],
        },
        {
          lineId: lineB,
          unpaidLeaveDays: '0',
          daysNotEmployed: '2',
          nightHours: '0',
        },
      ],
    });
    expect(ok.rows[1]?.overtime).toEqual([]);

    expect(zHrRunImportTimekeeping.safeParse({ runId, rows: [] }).success).toBe(false);
    expect(
      zHrRunImportTimekeeping.safeParse({
        runId,
        rows: [
          { lineId: lineA, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0' },
          { lineId: lineA, unpaidLeaveDays: '1', daysNotEmployed: '0', nightHours: '0' },
        ],
      }).success,
    ).toBe(false);
    expect(
      zHrRunImportTimekeeping.safeParse({
        runId,
        rows: [{ lineId: lineA, unpaidLeaveDays: '1.25', daysNotEmployed: '0', nightHours: '0' }],
      }).success,
    ).toBe(false);
  });

  it('rejects approving a stale pre-existing draft line missing overtime_cap check or overtime_caps rule (#3371)', async () => {
    const savedStatuses = PAYROLL_RULES.map((r) => ({ row: r as { status: string }, status: r.status }));
    try {
      for (const r of PAYROLL_RULES) (r as { status: string }).status = r.kind === 'overtime_caps' ? 'commentary' : 'confirmed';
      const inputs = zHrPayrollInputs.parse({ overtime: [{ dayKind: 'normal_day', night: false, hours: '45' }] });
      const c = calculatePayroll(
        { region: 'I', contract: 'indefinite', contractTermMonths: null, resident: true, insured: true, baseWage: '15000000', allowances: [], otherRegularPay: '0', commitment: false },
        { month: '2026-11', standardWorkingDays: '26', unpaidLeaveDays: '0', daysNotEmployed: '0', overtime: inputs.overtime, nightHours: '0', bonus: '0', dependents: [], voluntaryPension: '0', deductions: [], withholdingRequested: false },
        PAYROLL_RULES,
      );
      const run = { id: 'run', legal_entity_id: 'entity', month: '2026-11', status: 'draft', working_days: '26', approved_at: null, approval: null };
      // Simulate a line saved before overtime_cap / overtime_caps were added (same money figures, missing check + rule ref).
      const line = {
        id: 'line',
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
        checks: c.checks,
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

      await expect(runApprove.handler(ctx, { runId: 'run', fingerprint: '0'.repeat(64), acceptFlags: false })).rejects.toMatchObject({
        code: 'HR_RUN_STALE',
      });
    } finally {
      for (const s of savedStatuses) s.row.status = s.status;
    }
  });
});
