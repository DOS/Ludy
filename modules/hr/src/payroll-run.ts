// SPDX-License-Identifier: AGPL-3.0-only
// The monthly pay run (issue #2531; payroll plan docs/plan/payroll.md §6.2 and §6.3, ADR-0046). A run is one month of one legal entity; a line is one person's month. Opening a month copies
// the employments in force and last month's recurring inputs, the calculator of @crove/l10n-vn computes every line from stored terms, inputs and dated rules, and the figures and the
// breakdown are stored as facts: the payslip is a view of them, never a recomputation. A draft changes; approving is R3 (a fresh second factor, a person, never an agent), is refused
// while a rule a line used is still `commentary`, and freezes the run and its lines (the database's guard, not only this code). A correction of an approved month is an adjustment line
// in a later run. Owners and admins only, in the commands and in the database's policies. Every read is a sensitive query, and the pay run reads the people tables in the user's context,
// never as the system actor or the worker; the sealed columns (identity number, account number) are never selected here.
//
// No model call is made in this build: the flags are deterministic checks over stored facts, and the sheet works with AI off (the coworker is #2534).
//
// Audit facts carry ids, counts and field names, never an amount, a name or the fingerprint: audit rows reach the WORM archive, and a plain hash over a small run's inputs and figures
// could be confirmed by guessing after the person is erased. The fingerprint lives in the run's own approval record, which the org purge deletes.
import { createHash } from 'node:crypto';
import { money, toMoney, calculatePayroll, listRulesUsed, PAYROLL_RULES, PayrollRefusedError, type PayrollCalculation, type PayrollEmployment, type PayrollMonthInputs, type RuleRef } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import {
  HR_DEFAULT_WORKING_DAYS,
  HR_RECURRING_INPUTS,
  auditValue,
  tableWrite,
  zHrLineAdjust,
  zHrLineInputsSet,
  zHrPayrollInputs,
  zHrPayslipRef,
  zHrRunApprove,
  zHrRunList,
  zHrRunOpen,
  zHrRunRecalculate,
  zHrRunRef,
  type HrCheck,
  type HrLineFlag,
  type HrLineView,
  type HrPayrollInputs,
  type HrPayslip,
  type HrRuleView,
  type HrRunFigures,
  type HrRunSheet,
  type HrRunSummary,
  type HrRunWritten,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { hrManifest } from './manifest.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const RUN = hrManifest.tables.crove_hr.payroll_run;
const LINE = hrManifest.tables.crove_hr.payroll_line;

type Ctx = CommandContext;
type ReadCtx = QueryContext;
type Decimal = ReturnType<typeof money>;

const userOf = (actor: QueryContext['actor']): string => {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
};

const iso = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));
const runTarget = (input: { runId: string }) => ({ type: 'hr.payroll_run', id: input.runId });
const runNotFound = () => new DomainError('HR_RUN_NOT_FOUND', 404, 'Không tìm thấy bảng lương này');
const lineNotFound = () => new DomainError('HR_LINE_NOT_FOUND', 404, 'Không tìm thấy dòng lương này');
const notDraft = () => new DomainError('HR_RUN_NOT_DRAFT', 409, 'Bảng lương đã được duyệt, không sửa được nữa; sửa sai bằng dòng điều chỉnh ở kỳ lương sau');

const monthStart = (month: string): string => `${month}-01`;
const monthEnd = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};
const previousMonth = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The calculation of one line
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface Terms {
  id: string;
  effectiveFrom: string;
  contractType: 'indefinite' | 'fixed_term' | 'none';
  region: 'I' | 'II' | 'III' | 'IV';
  baseWage: string;
}

interface Person {
  employeeId: string;
  endedOn: string | null;
  terms: Terms;
  /** The person's first terms start inside the month: a new hire, whose days before the start the person types. */
  dependents: number;
}

interface LineFigures {
  status: 'calculated' | 'refused';
  gross: string | null;
  employee_insurance: string | null;
  employer_insurance: string | null;
  union_fee: string | null;
  taxable_income: string | null;
  pit: string | null;
  net: string | null;
  employer_cost: string | null;
  breakdown: string | null;
  checks: string;
  rules_used: string;
  refusal: string | null;
}

// The month's inputs as the calculator takes them, with the person's terms: a pure mapping, so the same stored facts give the same figures.
function calculationOf(person: Person, inputs: HrPayrollInputs, month: string, workingDays: string): PayrollCalculation {
  const employment: PayrollEmployment = {
    region: person.terms.region,
    contract: person.terms.contractType,
    contractTermMonths: inputs.contractTermMonths,
    resident: true,
    // Insurance follows the contract unless the person says otherwise: no contract in writing (a short job) is not insured.
    insured: inputs.insured ?? person.terms.contractType !== 'none',
    baseWage: person.terms.baseWage,
    allowances: inputs.allowances.map((a) => ({ label: a.label, amount: a.amount, type: a.type, namedInContract: a.namedInContract })),
    otherRegularPay: inputs.otherRegularPay,
    commitment: inputs.commitment,
  };
  const deductions: { label: string; kind: 'advance' | 'damage' | 'other'; amount: string }[] = inputs.deductions.map((d) => ({ label: d.label, kind: d.kind, amount: d.amount }));
  if (money(inputs.advance).greaterThan(0)) deductions.push({ label: 'advance', kind: 'advance', amount: inputs.advance });
  const month_: PayrollMonthInputs = {
    month,
    standardWorkingDays: workingDays,
    unpaidLeaveDays: inputs.unpaidLeaveDays,
    daysNotEmployed: inputs.daysNotEmployed,
    overtime: inputs.overtime,
    nightHours: inputs.nightHours,
    bonus: inputs.bonus,
    dependents: Array.from({ length: person.dependents }, () => ({ ownMonthlyIncome: '0' })),
    voluntaryPension: inputs.voluntaryPension,
    deductions,
    withholdingRequested: inputs.withholdingRequested,
  };
  return calculatePayroll(employment, month_, PAYROLL_RULES);
}

// The calculator's answer as the columns of a line, or its refusal in words. Only a refusal the calculator names is caught: any other error is a bug and surfaces.
function figuresOf(person: Person, inputs: HrPayrollInputs, month: string, workingDays: string): LineFigures {
  try {
    const c = calculationOf(person, inputs, month, workingDays);
    return {
      status: 'calculated',
      gross: c.gross,
      employee_insurance: c.employeeInsurance,
      employer_insurance: c.employerInsurance,
      union_fee: c.unionFee,
      taxable_income: c.taxableIncome,
      pit: c.pit,
      net: c.net,
      employer_cost: c.employerCost,
      breakdown: JSON.stringify(c.breakdown),
      checks: JSON.stringify(c.checks),
      rules_used: JSON.stringify(c.rulesUsed),
      refusal: null,
    };
  } catch (error) {
    if (!(error instanceof PayrollRefusedError)) throw error;
    return {
      status: 'refused',
      gross: null,
      employee_insurance: null,
      employer_insurance: null,
      union_fee: null,
      taxable_income: null,
      pit: null,
      net: null,
      employer_cost: null,
      breakdown: null,
      checks: '[]',
      rules_used: '[]',
      refusal: error.message.slice(0, 500),
    };
  }
}

// The people a month pays and the terms and dependents each has on it, read in the user's context (the people tables are owner and admin only in the database).
async function peopleOf(ctx: Ctx, legalEntityId: string, month: string): Promise<Person[]> {
  const start = monthStart(month);
  const end = monthEnd(month);
  const employees = await ctx.trx
    .selectFrom('crove_hr.payroll_employee')
    .select(['id', 'ended_on', 'erased_at'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .orderBy('id')
    .execute();
  const paid = employees.filter((e) => e.erased_at === null && (e.ended_on === null || iso(e.ended_on) >= start));
  if (paid.length === 0) return [];
  const ids = paid.map((e) => e.id);
  const terms = await ctx.trx
    .selectFrom('crove_hr.payroll_employment')
    .select(['id', 'employee_id', 'effective_from', 'contract_type', 'region', 'base_wage'])
    .where('org_id', '=', ctx.orgId)
    .where('employee_id', 'in', ids)
    .orderBy('effective_from', 'asc')
    .execute();
  const dependents = await ctx.trx
    .selectFrom('crove_hr.payroll_dependent')
    .select(['employee_id', 'registered_on', 'ended_on'])
    .where('org_id', '=', ctx.orgId)
    .where('employee_id', 'in', ids)
    .execute();
  const people: Person[] = [];
  for (const e of paid) {
    const rows = terms.filter((t) => t.employee_id === e.id);
    // The terms in force on the first day; a person hired during the month has only the first row, which starts inside it.
    const inForce = [...rows].reverse().find((t) => iso(t.effective_from) <= start) ?? rows.find((t) => iso(t.effective_from) <= end);
    if (!inForce) continue;
    const count = dependents.filter((d) => d.employee_id === e.id && iso(d.registered_on) <= end && (d.ended_on === null || iso(d.ended_on) >= start)).length;
    people.push({
      employeeId: e.id,
      endedOn: e.ended_on === null ? null : iso(e.ended_on),
      terms: { id: inForce.id, effectiveFrom: iso(inForce.effective_from), contractType: inForce.contract_type, region: inForce.region, baseWage: inForce.base_wage },
      dependents: count,
    });
  }
  return people;
}

const parseInputs = (value: unknown): HrPayrollInputs => zHrPayrollInputs.parse(value ?? {});

// What recurs from last month's line, and nothing else (the plan's 6.3): the allowances, other regular pay, the voluntary pension, the commitment form, whether insured, the term of a
// fixed-term contract and the withholding request. The rest of a month's inputs starts empty.
function recurringOf(previous: unknown): HrPayrollInputs {
  const old = parseInputs(previous) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of HR_RECURRING_INPUTS) kept[key] = old[key];
  return zHrPayrollInputs.parse(kept);
}

async function loadRun(ctx: Ctx, runId: string) {
  const run = await ctx.trx
    .selectFrom('crove_hr.payroll_run')
    .select(['id', 'legal_entity_id', 'month', 'status', 'working_days'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', runId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw runNotFound();
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const runOpen = defineCommand({
  name: 'hr.payroll.run.open',
  input: zHrRunOpen,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_run', ['id', 'legal_entity_id', 'month', 'status', 'working_days', 'created_by', 'created_at', 'updated_at']),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [
      'legal_entity_id', 'run_id', 'employee_id', 'employment_id', 'kind', 'status', 'inputs', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'net',
      'employer_cost', 'breakdown', 'checks', 'rules_used', 'refusal', 'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrRunWritten> => {
    const userId = userOf(ctx.actor);
    const entity = input.legalEntityId
      ? await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.legalEntityId).executeTakeFirst()
      : await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
    if (!entity) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân của bảng lương');
    const exists = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity.id)
      .where('month', '=', input.month)
      .executeTakeFirst();
    if (exists) throw new DomainError('HR_RUN_EXISTS', 409, `Đã có bảng lương tháng ${input.month}`, { runId: exists.id });
    const workingDays = input.workingDays ?? HR_DEFAULT_WORKING_DAYS;
    const run = await ctx.trx
      .insertInto('crove_hr.payroll_run')
      .values({ org_id: ctx.orgId, legal_entity_id: entity.id, month: input.month, working_days: workingDays, created_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    const people = await peopleOf(ctx, entity.id, input.month);
    // Last month's pay lines of the same entity, for what recurs.
    const before = await ctx.trx
      .selectFrom('crove_hr.payroll_line as l')
      .innerJoin('crove_hr.payroll_run as r', (join) => join.onRef('r.org_id', '=', 'l.org_id').onRef('r.id', '=', 'l.run_id'))
      .select(['l.employee_id', 'l.inputs'])
      .where('l.org_id', '=', ctx.orgId)
      .where('r.legal_entity_id', '=', entity.id)
      .where('r.month', '=', previousMonth(input.month))
      .where('l.kind', '=', 'pay')
      .execute();
    const lastInputs = new Map(before.map((b) => [b.employee_id, b.inputs]));
    for (const person of people) {
      const inputs = lastInputs.has(person.employeeId) ? recurringOf(lastInputs.get(person.employeeId)) : parseInputs({});
      const f = figuresOf(person, inputs, input.month, workingDays);
      await ctx.trx
        .insertInto('crove_hr.payroll_line')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: entity.id,
          run_id: run.id,
          employee_id: person.employeeId,
          employment_id: person.terms.id,
          kind: 'pay',
          inputs: JSON.stringify(inputs),
          ...f,
          created_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
    }
    ctx.audit({ runId: run.id, month: input.month, lines: people.length, copiedFromLastMonth: people.filter((p) => lastInputs.has(p.employeeId)).length });
    return { runId: run.id, lines: people.length };
  },
});

export const runRecalculate = defineCommand({
  name: 'hr.payroll.run.recalculate',
  input: zHrRunRecalculate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: runTarget,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_run', ['working_days', 'updated_at']),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [
      'legal_entity_id', 'run_id', 'employee_id', 'employment_id', 'kind', 'status', 'inputs', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'net',
      'employer_cost', 'breakdown', 'checks', 'rules_used', 'refusal', 'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrRunWritten> => {
    const userId = userOf(ctx.actor);
    const run = await loadRun(ctx, input.runId);
    if (run.status !== 'draft') throw notDraft();
    const workingDays = input.workingDays ?? run.working_days;
    if (workingDays !== run.working_days) {
      await ctx.trx.updateTable('crove_hr.payroll_run').set({ working_days: workingDays, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', run.id).execute();
    }
    const people = await peopleOf(ctx, run.legal_entity_id, run.month);
    const lines = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['id', 'employee_id', 'inputs'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', run.id)
      .where('kind', '=', 'pay')
      .execute();
    const byEmployee = new Map(lines.map((l) => [l.employee_id, l]));
    let added = 0;
    for (const person of people) {
      const existing = byEmployee.get(person.employeeId);
      if (existing) {
        const f = figuresOf(person, parseInputs(existing.inputs), run.month, workingDays);
        await ctx.trx.updateTable('crove_hr.payroll_line').set({ employment_id: person.terms.id, ...f, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      } else {
        // A person hired (or whose first terms were added) since the month was opened.
        const f = figuresOf(person, parseInputs({}), run.month, workingDays);
        await ctx.trx
          .insertInto('crove_hr.payroll_line')
          .values({ org_id: ctx.orgId, legal_entity_id: run.legal_entity_id, run_id: run.id, employee_id: person.employeeId, employment_id: person.terms.id, kind: 'pay', inputs: JSON.stringify(parseInputs({})), ...f, created_by: userId, created_at: ctx.now, updated_at: ctx.now })
          .execute();
        added += 1;
      }
    }
    // A person no longer paid in this month (ended before it, erased, or left with no terms in force since it was opened) leaves the sheet: their pay line is removed from the draft.
    // Only a draft run's lines can be deleted (the frozen_row guard), so an approved month never loses one.
    const paidNow = new Set(people.map((p) => p.employeeId));
    const gone = lines.filter((l) => !paidNow.has(l.employee_id));
    if (gone.length > 0) {
      await ctx.trx
        .deleteFrom('crove_hr.payroll_line')
        .where('org_id', '=', ctx.orgId)
        .where('run_id', '=', run.id)
        .where('kind', '=', 'pay')
        .where(
          'id',
          'in',
          gone.map((l) => l.id),
        )
        .execute();
    }
    ctx.audit({ runId: run.id, recalculated: people.length - added, added, removed: gone.length, workingDaysChanged: workingDays !== run.working_days });
    return { runId: run.id, lines: people.length };
  },
});

export const lineInputsSet = defineCommand({
  name: 'hr.payroll.line.inputs.set',
  input: zHrLineInputsSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { lineId: string }) => ({ type: 'hr.payroll_line', id: input.lineId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [
      'employment_id', 'status', 'inputs', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'net', 'employer_cost', 'breakdown', 'checks', 'rules_used', 'refusal', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrRunWritten> => {
    userOf(ctx.actor);
    // The run is locked before the line, as every other command does, so two requests cannot wait on each other.
    const found = await ctx.trx.selectFrom('crove_hr.payroll_line').select(['run_id']).where('org_id', '=', ctx.orgId).where('id', '=', input.lineId).executeTakeFirst();
    if (!found) throw lineNotFound();
    const run = await loadRun(ctx, found.run_id);
    const line = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['id', 'run_id', 'employee_id', 'kind'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.lineId)
      .forUpdate()
      .executeTakeFirst();
    if (!line) throw lineNotFound();
    if (line.kind !== 'pay') throw new DomainError('HR_LINE_NOT_PAY', 422, 'Dòng điều chỉnh không có số liệu nhập');
    if (run.status !== 'draft') throw notDraft();
    const person = (await peopleOf(ctx, run.legal_entity_id, run.month)).find((p) => p.employeeId === line.employee_id);
    if (!person) throw new DomainError('HR_EMPLOYEE_NOT_PAID', 409, 'Nhân viên này không có lương trong tháng này');
    const f = figuresOf(person, input.inputs, run.month, run.working_days);
    await ctx.trx
      .updateTable('crove_hr.payroll_line')
      .set({ employment_id: person.terms.id, inputs: JSON.stringify(input.inputs), ...f, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', line.id)
      .execute();
    ctx.audit({ runId: run.id, lineId: line.id, inputKeys: auditValue(LINE, 'inputs', Object.keys(input.inputs).length), refused: f.status === 'refused' });
    return { runId: run.id, lineId: line.id };
  },
});

// A signed correction of an approved month, carried in a draft run of a later month. The differences are typed; net and the employer's cost follow from them. A correction is never
// an edit of the approved line.
export const lineAdjust = defineCommand({
  name: 'hr.payroll.line.adjust',
  input: zHrLineAdjust,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: runTarget,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [
      'legal_entity_id', 'run_id', 'employee_id', 'employment_id', 'kind', 'status', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'net', 'employer_cost', 'breakdown', 'adjusts_run_id', 'note',
      'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrRunWritten> => {
    const userId = userOf(ctx.actor);
    const run = await loadRun(ctx, input.runId);
    if (run.status !== 'draft') throw notDraft();
    const target = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.adjustsRunId)
      .executeTakeFirst();
    if (!target) throw runNotFound();
    if (target.status === 'draft') throw new DomainError('HR_ADJUST_NOT_APPROVED', 409, 'Chỉ điều chỉnh được tháng đã duyệt; tháng chưa duyệt thì sửa thẳng');
    if (target.legal_entity_id !== run.legal_entity_id || target.month >= run.month) {
      throw new DomainError('HR_ADJUST_NOT_EARLIER', 422, 'Dòng điều chỉnh nằm ở bảng lương của một tháng sau tháng được sửa, cùng pháp nhân');
    }
    const employee = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', run.legal_entity_id)
      .where('id', '=', input.employeeId)
      .executeTakeFirst();
    if (!employee) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
    const paid = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select(['id', 'employment_id'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', target.id)
      .where('employee_id', '=', input.employeeId)
      .where('kind', '=', 'pay')
      .executeTakeFirst();
    if (!paid) throw new DomainError('HR_ADJUST_NOT_PAID', 422, 'Nhân viên này không có dòng lương trong tháng được sửa');
    // The correction is booked to the cost department of the line it corrects: that line's terms are copied, and a line without them is refused rather than guessed at.
    if (!paid.employment_id) throw new DomainError('HR_ADJUST_NO_TERMS', 422, 'Dòng lương được sửa không có hợp đồng nên không biết bộ phận hạch toán; không lập được dòng điều chỉnh');
    // The split of the insurance across the funds is typed, signed, and adds up to the insurance totals: the entry is built from it, never from a guess.
    const seen = new Set<string>();
    let employeeSplit = money(0);
    let employerSplit = money(0);
    for (const f of input.funds) {
      if (seen.has(f.fund)) throw new DomainError('HR_ADJUST_FUNDS', 422, 'Mỗi quỹ bảo hiểm chỉ nhập một lần trong dòng điều chỉnh');
      seen.add(f.fund);
      employeeSplit = employeeSplit.plus(money(f.employee));
      employerSplit = employerSplit.plus(money(f.employer));
    }
    if (!employeeSplit.equals(money(input.employeeInsurance)) || !employerSplit.equals(money(input.employerInsurance))) {
      throw new DomainError('HR_ADJUST_FUNDS', 422, 'Số bảo hiểm chia theo từng quỹ phải bằng tổng bảo hiểm đã nhập (phần người lao động và phần doanh nghiệp)');
    }
    const gross = money(input.gross);
    const net = gross.minus(money(input.employeeInsurance)).minus(money(input.pit));
    const employerCost = gross.plus(money(input.employerInsurance)).plus(money(input.unionFee));
    const line = await ctx.trx
      .insertInto('crove_hr.payroll_line')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: run.legal_entity_id,
        run_id: run.id,
        employee_id: input.employeeId,
        employment_id: paid.employment_id,
        kind: 'adjustment',
        status: 'calculated',
        gross: toMoney(gross),
        employee_insurance: toMoney(money(input.employeeInsurance)),
        employer_insurance: toMoney(money(input.employerInsurance)),
        union_fee: toMoney(money(input.unionFee)),
        taxable_income: toMoney(money(input.taxableIncome)),
        pit: toMoney(money(input.pit)),
        net: toMoney(net),
        employer_cost: toMoney(employerCost),
        // The same shape a pay line's breakdown holds, so the posting reads both alike: the split across the funds, and no deductions of the person's own (the net is gross less insurance and tax).
        breakdown: JSON.stringify({
          insurance: { funds: input.funds.map((f) => ({ fund: f.fund, employee: toMoney(money(f.employee)), employer: toMoney(money(f.employer)) })) },
          deductions: { advance: '0', damage: '0', other: '0' },
        }),
        adjusts_run_id: target.id,
        note: input.note,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ runId: run.id, lineId: line.id, adjustsRunId: target.id, employeeId: input.employeeId, gross: auditValue(LINE, 'gross', input.gross) });
    return { runId: run.id, lineId: line.id };
  },
});

interface StoredLine {
  id: string;
  employee_id: string;
  // The terms the figures were computed from (a `pay` line): what the posting reads the function of the person's work through.
  employment_id: string | null;
  kind: 'pay' | 'adjustment';
  status: 'calculated' | 'refused';
  inputs: unknown;
  gross: string | null;
  employee_insurance: string | null;
  employer_insurance: string | null;
  union_fee: string | null;
  taxable_income: string | null;
  pit: string | null;
  net: string | null;
  employer_cost: string | null;
  checks: unknown;
  rules_used: unknown;
  refusal: string | null;
}

const LINE_COLUMNS = ['id', 'employee_id', 'employment_id', 'kind', 'status', 'inputs', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'net', 'employer_cost', 'checks', 'rules_used', 'refusal'] as const;

const figuresOfLine = (l: StoredLine): HrRunFigures | null =>
  l.status === 'refused' || l.gross === null
    ? null
    : {
        gross: l.gross,
        employeeInsurance: l.employee_insurance ?? '0',
        employerInsurance: l.employer_insurance ?? '0',
        unionFee: l.union_fee ?? '0',
        taxableIncome: l.taxable_income ?? '0',
        pit: l.pit ?? '0',
        net: l.net ?? '0',
        employerCost: l.employer_cost ?? '0',
      };

const zeroFigures = (): Record<keyof HrRunFigures, Decimal> => ({ gross: money(0), employeeInsurance: money(0), employerInsurance: money(0), unionFee: money(0), taxableIncome: money(0), pit: money(0), net: money(0), employerCost: money(0) });

function totalsOf(lines: readonly StoredLine[]): HrRunFigures {
  const t = zeroFigures();
  for (const l of lines) {
    const f = figuresOfLine(l);
    if (!f) continue;
    for (const key of Object.keys(t) as (keyof HrRunFigures)[]) t[key] = t[key].plus(money(f[key]));
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, toMoney(v)])) as unknown as HrRunFigures;
}

const refsOf = (value: unknown): RuleRef[] => (Array.isArray(value) ? (value as RuleRef[]) : []);
const checksOf = (value: unknown): HrCheck[] => (Array.isArray(value) ? (value as HrCheck[]) : []);

// The fingerprint of the figures a person looks at: the run's month and working days, and every line's identity, inputs, figures and rules. If any of it changes after the sheet was
// shown, an approval that names the old fingerprint is refused and the person looks again.
function fingerprintOf(run: { id: string; month: string; working_days: string }, lines: readonly StoredLine[]): string {
  const rows = [...lines]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((l) => [l.id, l.employee_id, l.employment_id, l.kind, l.status, JSON.stringify(l.inputs), l.gross, l.employee_insurance, l.employer_insurance, l.union_fee, l.taxable_income, l.pit, l.net, l.employer_cost, l.refusal, refsOf(l.rules_used).map((r) => r.id)]);
  return createHash('sha256').update(JSON.stringify({ run: [run.id, run.month, run.working_days], rows })).digest('hex');
}

const ruleView = (row: (typeof PAYROLL_RULES)[number]): HrRuleView => ({
  id: row.id,
  kind: row.kind,
  key: row.key,
  effectiveFrom: row.effectiveFrom,
  status: row.status,
  cite: row.source.cite,
  confidence: row.source.confidence,
});

// The rules the lines used, from the rule set as it is now (a row the accountant has since confirmed no longer blocks), and the ones still `commentary`.
function rulesOfLines(lines: readonly StoredLine[]): { used: HrRuleView[]; blocking: HrRuleView[] } {
  const calculations = lines.filter((l) => l.kind === 'pay' && l.status === 'calculated').map((l) => ({ rulesUsed: refsOf(l.rules_used) }));
  const result = listRulesUsed(calculations, PAYROLL_RULES);
  return { used: result.used.map(ruleView), blocking: result.commentary.map(ruleView) };
}

const failedChecks = (lines: readonly StoredLine[]): number => lines.filter((l) => checksOf(l.checks).some((c) => !c.ok)).length;

export const runApprove = defineCommand({
  name: 'hr.payroll.run.approve',
  input: zHrRunApprove,
  // Approving freezes the month and is the gate to the posting: R3, a fresh second factor of a person (the runtime refuses an agent), owners and admins.
  risk: 'R3',
  sideEffect: 'irreversible',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: runTarget,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_run', ['status', 'approved_by', 'approved_at', 'approval', 'updated_at'])],
  handler: async (ctx, input): Promise<HrRunWritten> => {
    const userId = userOf(ctx.actor);
    const run = await loadRun(ctx, input.runId);
    if (run.status !== 'draft') throw new DomainError('HR_RUN_NOT_DRAFT', 409, 'Bảng lương này đã được duyệt');
    const lines = (await ctx.trx.selectFrom('crove_hr.payroll_line').select(LINE_COLUMNS).where('org_id', '=', ctx.orgId).where('run_id', '=', run.id).execute()) as StoredLine[];
    if (lines.length === 0) throw new DomainError('HR_RUN_EMPTY', 422, 'Bảng lương chưa có dòng nào để duyệt');
    const refused = lines.filter((l) => l.status === 'refused').length;
    if (refused > 0) throw new DomainError('HR_RUN_HAS_REFUSED', 422, `${refused} dòng chưa tính được; sửa số liệu của các dòng đó rồi mới duyệt`, { refused });
    // The lines must still be what the calculator gives for the people, terms, dependents and rules as they are now (and rest on the terms in force): a raise, a new function, a dependent or a hire added since the month was opened,
    // or a rule that moved, would otherwise be frozen into the month unseen. The person recalculates and looks again.
    const people = await peopleOf(ctx, run.legal_entity_id, run.month);
    const payLines = new Map(lines.filter((l) => l.kind === 'pay').map((l) => [l.employee_id, l]));
    const stale = people.filter((person) => {
      const l = payLines.get(person.employeeId);
      if (!l) return true;
      // The line must rest on the terms in force for the month: a change that leaves the figures alone (a new function of the work, which picks the expense account of the posting) is still a change.
      if (l.employment_id !== person.terms.id) return true;
      const f = figuresOf(person, parseInputs(l.inputs), run.month, run.working_days);
      const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : money(a).equals(money(b)));
      return !(same(f.gross, l.gross) && same(f.employee_insurance, l.employee_insurance) && same(f.employer_insurance, l.employer_insurance) && same(f.union_fee, l.union_fee) && same(f.taxable_income, l.taxable_income) && same(f.pit, l.pit) && same(f.net, l.net) && same(f.employer_cost, l.employer_cost));
    });
    // A pay line of a person no longer paid in this month (ended before it, erased, no terms in force) is stale too: approving would freeze pay for someone who is not paid.
    const paidNow = new Set(people.map((p) => p.employeeId));
    const orphaned = [...payLines.keys()].filter((employeeId) => !paidNow.has(employeeId));
    const staleCount = stale.length + orphaned.length;
    if (staleCount > 0) throw new DomainError('HR_RUN_STALE', 409, `${staleCount} dòng không còn khớp với hợp đồng, người phụ thuộc, nhân sự hoặc quy tắc hiện tại; hãy bấm tính lại cả bảng rồi xem lại`, { stale: staleCount });
    const { used, blocking } = rulesOfLines(lines);
    // The gate: a rule still `commentary` (not yet read against its primary text by the accountant) blocks the month. The answer lists the rows with where each comes from.
    if (blocking.length > 0) {
      throw new DomainError('HR_RULES_COMMENTARY', 422, `Có ${blocking.length} quy tắc dùng trong bảng lương này chưa được kế toán xác nhận nên chưa duyệt được`, { rules: blocking });
    }
    const fingerprint = fingerprintOf(run, lines);
    if (fingerprint !== input.fingerprint) throw new DomainError('HR_RUN_CHANGED', 409, 'Số liệu đã thay đổi từ lúc bạn xem bảng lương; hãy xem lại rồi duyệt');
    const flagged = failedChecks(lines);
    if (flagged > 0 && !input.acceptFlags) {
      throw new DomainError('HR_FLAGS_NOT_ACCEPTED', 422, `${flagged} dòng có cảnh báo (lương tối thiểu hoặc mức khấu trừ); hãy xem và xác nhận đã xem`, { flagged });
    }
    const totals = totalsOf(lines);
    await ctx.trx
      .updateTable('crove_hr.payroll_run')
      .set({
        status: 'approved',
        approved_by: userId,
        approved_at: ctx.now,
        approval: JSON.stringify({ fingerprint, totals, rules: used, flaggedLines: flagged, flagsAccepted: input.acceptFlags, lines: lines.length }),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', run.id)
      .execute();
    ctx.audit({ runId: run.id, month: run.month, lines: lines.length, rules: used.length, flaggedLines: flagged, approval: auditValue(RUN, 'approval', totals) });
    return { runId: run.id, lines: lines.length };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Queries: every one sensitive (the audit row of the read is committed before it starts).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

const totalsFromStore = (value: unknown): HrRunFigures | null => (value !== null && typeof value === 'object' && 'totals' in value ? ((value as { totals: HrRunFigures }).totals) : null);

export const runList = defineQuery({
  name: 'hr.payroll.run.list',
  input: zHrRunList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrRunSummary[]> => {
    const runs = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status', 'working_days', 'approved_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('month', 'desc')
      .orderBy('id')
      .limit(input.limit)
      .execute();
    if (runs.length === 0) return [];
    const lines = (await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select([...LINE_COLUMNS, 'run_id'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'run_id',
        'in',
        runs.map((r) => r.id),
      )
      .execute()) as (StoredLine & { run_id: string })[];
    return runs.map((r) => {
      const own = lines.filter((l) => l.run_id === r.id);
      return {
        id: r.id,
        legalEntityId: r.legal_entity_id,
        month: r.month,
        status: r.status,
        workingDays: r.working_days,
        lines: own.filter((l) => l.kind === 'pay').length,
        refused: own.filter((l) => l.status === 'refused').length,
        totals: totalsOf(own),
        approvedAt: r.approved_at === null ? null : new Date(r.approved_at).toISOString(),
      };
    });
  },
});

async function employerName(ctx: ReadCtx, legalEntityId: string): Promise<string> {
  const row = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', legalEntityId).executeTakeFirst();
  return row?.name ?? '';
}

export const runSheet = defineQuery({
  name: 'hr.payroll.run.sheet',
  input: zHrRunRef,
  access: MANAGERS,
  sensitive: true,
  target: runTarget,
  handler: async (ctx, input): Promise<HrRunSheet> => {
    const run = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status', 'working_days', 'approved_at', 'approval'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.runId)
      .executeTakeFirst();
    if (!run) throw runNotFound();
    const lines = (await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select([...LINE_COLUMNS, 'breakdown', 'note', 'adjusts_run_id'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', run.id)
      .orderBy('kind')
      .orderBy('id')
      .execute()) as (StoredLine & { breakdown: unknown; note: string | null; adjusts_run_id: string | null; employment_id: string | null })[];
    const employeeIds = [...new Set(lines.map((l) => l.employee_id))];
    const employees = employeeIds.length === 0
      ? []
      : await ctx.trx.selectFrom('crove_hr.payroll_employee').select(['id', 'display_name', 'ended_on']).where('org_id', '=', ctx.orgId).where('id', 'in', employeeIds).execute();
    const firstTerms = employeeIds.length === 0
      ? []
      : await ctx.trx.selectFrom('crove_hr.payroll_employment').select(['id', 'employee_id', 'effective_from', 'contract_type']).where('org_id', '=', ctx.orgId).where('employee_id', 'in', employeeIds).execute();
    const adjusted = [...new Set(lines.flatMap((l) => (l.adjusts_run_id ? [l.adjusts_run_id] : [])))];
    const adjustedRuns = adjusted.length === 0 ? [] : await ctx.trx.selectFrom('crove_hr.payroll_run').select(['id', 'month']).where('org_id', '=', ctx.orgId).where('id', 'in', adjusted).execute();
    const start = monthStart(run.month);
    const end = monthEnd(run.month);
    const views: HrLineView[] = lines.map((l) => {
      const employee = employees.find((e) => e.id === l.employee_id);
      const checks = checksOf(l.checks);
      const own = firstTerms.filter((t) => t.employee_id === l.employee_id).sort((a, b) => (iso(a.effective_from) < iso(b.effective_from) ? -1 : 1));
      const used = own.find((t) => t.id === l.employment_id);
      const flags: HrLineFlag[] = [];
      if (l.status === 'refused') flags.push('refused');
      if (checks.some((c) => c.id === 'minimum_wage' && !c.ok)) flags.push('check_minimum_wage');
      if (checks.some((c) => c.id === 'deduction_cap' && !c.ok)) flags.push('check_deduction_cap');
      // The net pay under the month's minimum wage is flagged too: a deduction or unpaid days can take it there even when the base wage is above it.
      const minimum = checks.find((c) => c.id === 'minimum_wage');
      if (minimum && l.net !== null && money(l.net).lessThan(money(minimum.limit))) flags.push('net_below_minimum');
      if (l.kind === 'pay') {
        const first = own[0];
        if (first && iso(first.effective_from) > start && iso(first.effective_from) <= end) flags.push('new_hire');
        if (employee?.ended_on && iso(employee.ended_on) >= start && iso(employee.ended_on) <= end) flags.push('ends_this_month');
        if (used?.contract_type === 'fixed_term' && l.status === 'refused' && parseInputs(l.inputs).contractTermMonths === null) flags.push('fixed_term_months_missing');
      }
      return {
        id: l.id,
        employeeId: l.employee_id,
        employeeName: employee?.display_name ?? '',
        kind: l.kind,
        status: l.status,
        refusal: l.refusal,
        inputs: (l.inputs ?? {}) as Record<string, unknown>,
        figures: figuresOfLine(l),
        breakdown: (l.breakdown ?? null) as Record<string, unknown> | null,
        checks,
        flags,
        note: l.note,
        adjustsMonth: l.adjusts_run_id ? (adjustedRuns.find((r) => r.id === l.adjusts_run_id)?.month ?? null) : null,
      };
    });
    const stored = run.approval as { rules?: HrRuleView[] } | null;
    const draft = run.status === 'draft';
    const { used, blocking } = draft ? rulesOfLines(lines) : { used: stored?.rules ?? [], blocking: [] as HrRuleView[] };
    const obstacles: HrRunSheet['obstacles'] = [];
    if (lines.length === 0) obstacles.push('no_lines');
    if (lines.some((l) => l.status === 'refused')) obstacles.push('refused_lines');
    if (blocking.length > 0) obstacles.push('rules_commentary');
    return {
      run: {
        id: run.id,
        legalEntityId: run.legal_entity_id,
        employerName: await employerName(ctx, run.legal_entity_id),
        month: run.month,
        status: run.status,
        workingDays: run.working_days,
        approvedAt: run.approved_at === null ? null : new Date(run.approved_at).toISOString(),
      },
      lines: views,
      totals: draft ? totalsOf(lines) : (totalsFromStore(run.approval) ?? totalsOf(lines)),
      rules: used,
      blocking,
      fingerprint: fingerprintOf(run, lines),
      approvable: draft && obstacles.length === 0,
      obstacles,
    };
  },
});

// A payslip of Labor Code Art. 95(3): the stored facts of one person's month and nothing recomputed. An adjustment line has no payslip (it is a correction in the books).
export const linePayslip = defineQuery({
  name: 'hr.payroll.line.payslip',
  input: zHrPayslipRef,
  access: MANAGERS,
  sensitive: true,
  target: (input: { lineId: string }) => ({ type: 'hr.payroll_line', id: input.lineId }),
  handler: async (ctx, input): Promise<HrPayslip> => {
    const line = await ctx.trx
      .selectFrom('crove_hr.payroll_line')
      .select([...LINE_COLUMNS, 'run_id', 'breakdown'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.lineId)
      .executeTakeFirst();
    if (!line) throw lineNotFound();
    if (line.kind !== 'pay' || line.status !== 'calculated' || line.breakdown === null) throw new DomainError('HR_NO_PAYSLIP', 422, 'Dòng này chưa có phiếu lương (chưa tính được hoặc là dòng điều chỉnh)');
    const run = await ctx.trx.selectFrom('crove_hr.payroll_run').select(['id', 'legal_entity_id', 'month', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', line.run_id).executeTakeFirstOrThrow();
    const employee = await ctx.trx.selectFrom('crove_hr.payroll_employee').select('display_name').where('org_id', '=', ctx.orgId).where('id', '=', line.employee_id).executeTakeFirstOrThrow();
    const figures = figuresOfLine(line as StoredLine);
    if (!figures) throw new DomainError('HR_NO_PAYSLIP', 422, 'Dòng này chưa có phiếu lương');
    return {
      lineId: line.id,
      runId: run.id,
      month: run.month,
      status: run.status,
      employerName: await employerName(ctx, run.legal_entity_id),
      employeeName: employee.display_name,
      figures,
      breakdown: line.breakdown as Record<string, unknown>,
      inputs: (line.inputs ?? {}) as Record<string, unknown>,
    };
  },
});

export const hrPayrollCommands = [runOpen, runRecalculate, lineInputsSet, lineAdjust, runApprove];
export const hrPayrollQueries = [runList, runSheet, linePayslip];
