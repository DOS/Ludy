// SPDX-License-Identifier: AGPL-3.0-only
// Read-only continuous payroll fluctuation preview and What-Changed diff (#4445, Stage 5E):
// compares a draft run, finalized run, or current-month projected snapshot against the immediately
// preceding finalized (approved/paid/closed) run of the same legal entity. Zero DB writes,
// zero side effects, decimal.js money arithmetic only, strict owner/admin authorization.
import {
  HR_DEFAULT_WORKING_DAYS,
  HR_ERASED_NAME,
  HR_PAYROLL_DIFF_REASONS,
  zHrPayrollPreviewDiffAsk,
  type HrPayrollDiffReason,
  type HrPayrollInputs,
  type HrPayrollPreviewDeltas,
  type HrPayrollPreviewDiff,
  type HrPayrollPreviewDiffAsk,
  type HrPayrollPreviewEmployeeDiff,
  type HrPayrollPreviewFigures,
  type HrPayrollPreviewLineFigures,
  type HrPayrollPreviewMode,
  type HrPayrollPreviewRunInfo,
  type HrRunFigures,
  type HrRunStatus,
} from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { MANAGERS, userOf, vietnamDay } from './employees.ts';
import { previousMonth } from './payroll-dates.ts';
import {
  LINE_COLUMNS,
  checksOf,
  employerName,
  figuresOf,
  figuresOfLine,
  formatSyncUnpaidDays,
  initialInputsFor,
  loadBhxhLeaveByEmployee,
  parseInputs,
  peopleOf,
  runNotFound,
  type StoredLine,
} from './payroll-run.ts';

type Decimal = ReturnType<typeof money>;

interface BreakdownSnapshot {
  baseWage: string | null;
  dependentsCounted: number | null;
  taxMode: string | null;
}

export interface PreviewEmploymentMeta {
  id: string;
  baseWage: string;
  payBasis: 'monthly' | 'hourly' | 'piece_rate';
  hourlyRate: string | null;
  pieceRate: string | null;
}

export interface PreviewSourceLine {
  employeeId: string;
  employmentId: string | null;
  kind: 'pay' | 'adjustment';
  status: 'calculated' | 'refused';
  inputs: HrPayrollInputs;
  figures: HrRunFigures | null;
  breakdown: BreakdownSnapshot | null;
  hasFlags: boolean;
}

export interface PreviewPeriodSnapshot {
  runInfo: HrPayrollPreviewRunInfo;
  workingDays: string;
  lines: readonly PreviewSourceLine[];
  employments: ReadonlyMap<string, PreviewEmploymentMeta>;
}

export interface PreviewEmployeeIdentity {
  displayName: string;
  erased: boolean;
}

export interface ComputePayrollDiffInput {
  mode: HrPayrollPreviewMode;
  legalEntityId: string;
  legalEntityName: string;
  month: string;
  current: PreviewPeriodSnapshot;
  prior: PreviewPeriodSnapshot | null;
  employees: ReadonlyMap<string, PreviewEmployeeIdentity>;
  includeUnchanged: boolean;
}

const ZERO = '0';

const parseJsonMaybe = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

function parseBreakdownSnapshot(raw: unknown): BreakdownSnapshot | null {
  const parsed = parseJsonMaybe(raw);
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { pay?: { baseWage?: unknown }; tax?: { dependentsCounted?: unknown; mode?: unknown } };
  return {
    baseWage: typeof obj.pay?.baseWage === 'string' ? obj.pay.baseWage : null,
    dependentsCounted: typeof obj.tax?.dependentsCounted === 'number' ? obj.tax.dependentsCounted : null,
    taxMode: typeof obj.tax?.mode === 'string' ? obj.tax.mode : null,
  };
}

function lineHasComplianceFlag(status: 'calculated' | 'refused', checksRaw: unknown, net: string | null): boolean {
  if (status === 'refused') return true;
  const checks = checksOf(parseJsonMaybe(checksRaw));
  if (checks.some((c) => !c.ok)) return true;
  const minimum = checks.find((c) => c.id === 'minimum_wage');
  return minimum !== undefined && net !== null && money(net).lessThan(money(minimum.limit));
}

function formatSyncBhxhDays(raw: string): string {
  const exact = money(raw);
  const normalized = exact.toDecimalPlaces(2).toFixed();
  if (exact.isNegative() || exact.greaterThan('99.99') || !/^\d{1,2}(\.\d{1,2})?$/.test(normalized)) {
    throw new DomainError(
      'HR_LEAVE_DAYS_OUT_OF_RANGE',
      422,
      'Số ngày nghỉ hưởng BHXH đồng bộ sang bảng lương chỉ hỗ trợ tối đa 2 chữ số thập phân (0 - 99,99 ngày)',
    );
  }
  return normalized;
}

function zeroLineFigures(): HrPayrollPreviewLineFigures {
  return {
    gross: ZERO,
    employeeInsurance: ZERO,
    pit: ZERO,
    otherDeductions: ZERO,
    employeeDeductions: ZERO,
    net: ZERO,
    employerInsurance: ZERO,
    unionFee: ZERO,
    employerStatutory: ZERO,
    employerCost: ZERO,
    taxableIncome: ZERO,
  };
}

function sumLineFigures(items: readonly HrRunFigures[]): HrPayrollPreviewLineFigures {
  if (items.length === 0) return zeroLineFigures();
  const gross = sum(items.map((f) => f.gross));
  const employeeInsurance = sum(items.map((f) => f.employeeInsurance));
  const pit = sum(items.map((f) => f.pit));
  const net = sum(items.map((f) => f.net));
  const employerInsurance = sum(items.map((f) => f.employerInsurance));
  const unionFee = sum(items.map((f) => f.unionFee));
  const employerCost = sum(items.map((f) => f.employerCost));
  const taxableIncome = sum(items.map((f) => f.taxableIncome));

  // Derive other deductions (advances, damage, etc.) and statutory totals via decimal.js
  // so gross - employeeDeductions === net and gross + employerStatutory === employerCost identically.
  const otherDeductions = gross.minus(employeeInsurance).minus(pit).minus(net);
  const employeeDeductions = employeeInsurance.plus(pit).plus(otherDeductions);
  const employerStatutory = employerInsurance.plus(unionFee);

  return {
    gross: toMoney(gross),
    employeeInsurance: toMoney(employeeInsurance),
    pit: toMoney(pit),
    otherDeductions: toMoney(otherDeductions),
    employeeDeductions: toMoney(employeeDeductions),
    net: toMoney(net),
    employerInsurance: toMoney(employerInsurance),
    unionFee: toMoney(unionFee),
    employerStatutory: toMoney(employerStatutory),
    employerCost: toMoney(employerCost),
    taxableIncome: toMoney(taxableIncome),
  };
}

function diffMoney(currentValue: string, priorValue: string): string {
  return toMoney(money(currentValue).minus(money(priorValue)));
}

function nonZeroMoney(value: string): boolean {
  return !money(value).isZero();
}

function leaveDaysOf(inputs: HrPayrollInputs): string {
  const total = money(inputs.unpaidLeaveDays)
    .plus(money(inputs.sicknessBhxhDays))
    .plus(money(inputs.maternityBhxhDays));
  return total.isZero() ? ZERO : total.toDecimalPlaces(2).toFixed();
}

function normalizedAllowances(inputs: HrPayrollInputs): string[] {
  return inputs.allowances
    .filter((a) => !money(a.amount).isZero())
    .map((a) => `${a.type}|${a.namedInContract ? '1' : '0'}|${toMoney(money(a.amount))}|${a.label.trim()}`)
    .sort();
}

function normalizedDeductions(inputs: HrPayrollInputs): string[] {
  return inputs.deductions
    .filter((d) => !money(d.amount).isZero())
    .map((d) => `${d.kind}|${toMoney(money(d.amount))}|${d.label.trim()}`)
    .sort();
}

function normalizedOvertime(inputs: HrPayrollInputs): string[] {
  return inputs.overtime
    .filter((o) => !money(o.hours).isZero())
    .map((o) => `${o.dayKind}|${o.night ? '1' : '0'}|${money(o.hours).toFixed()}`)
    .sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function nullableDecimalEqual(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return money(a).equals(money(b));
}

function sumAdjustmentFigures(lines: readonly PreviewSourceLine[]): { gross: Decimal; insuranceAndPit: Decimal } {
  let gross = money(0);
  let insuranceAndPit = money(0);
  for (const l of lines) {
    if (l.kind !== 'adjustment' || l.figures === null) continue;
    gross = gross.plus(money(l.figures.gross));
    insuranceAndPit = insuranceAndPit.plus(money(l.figures.employeeInsurance)).plus(money(l.figures.pit));
  }
  return { gross, insuranceAndPit };
}

interface EmployeePeriodBucket {
  payLine: PreviewSourceLine | null;
  allLines: PreviewSourceLine[];
  calculatedFigures: HrRunFigures[];
  aggregated: HrPayrollPreviewLineFigures | null;
  hasRefused: boolean;
  hasFlags: boolean;
  leaveDays: string | null;
}

function buildEmployeeBuckets(lines: readonly PreviewSourceLine[]): Map<string, EmployeePeriodBucket> {
  const grouped = new Map<string, PreviewSourceLine[]>();
  for (const line of lines) {
    const list = grouped.get(line.employeeId);
    if (list) list.push(line);
    else grouped.set(line.employeeId, [line]);
  }
  const buckets = new Map<string, EmployeePeriodBucket>();
  for (const [employeeId, list] of grouped) {
    const payLine = list.find((l) => l.kind === 'pay') ?? null;
    const calculatedFigures = list.flatMap((l) => (l.figures !== null ? [l.figures] : []));
    buckets.set(employeeId, {
      payLine,
      allLines: list,
      calculatedFigures,
      aggregated: calculatedFigures.length > 0 ? sumLineFigures(calculatedFigures) : null,
      hasRefused: list.some((l) => l.status === 'refused'),
      hasFlags: list.some((l) => l.hasFlags),
      leaveDays: payLine ? leaveDaysOf(payLine.inputs) : null,
    });
  }
  return buckets;
}

function detectReasons(args: {
  prior: EmployeePeriodBucket | undefined;
  current: EmployeePeriodBucket | undefined;
  priorEmployments: ReadonlyMap<string, PreviewEmploymentMeta> | null;
  currentEmployments: ReadonlyMap<string, PreviewEmploymentMeta>;
  grossDelta: string;
  employeeDeductionDelta: string;
  netDelta: string;
  employerCostDelta: string;
  workingDaysChanged: boolean;
}): HrPayrollDiffReason[] {
  const { prior, current, priorEmployments, currentEmployments, grossDelta, employeeDeductionDelta, netDelta, employerCostDelta, workingDaysChanged } = args;
  if (!prior && current) return ['new_hire'];
  if (prior && !current) return ['terminated'];
  if (!prior || !current) return [];

  const reasons = new Set<HrPayrollDiffReason>();
  const priorPay = prior.payLine;
  const currPay = current.payLine;
  const priorAdj = sumAdjustmentFigures(prior.allLines);
  const currAdj = sumAdjustmentFigures(current.allLines);

  if (priorPay && currPay) {
    const pIn = priorPay.inputs;
    const cIn = currPay.inputs;

    if (
      !money(pIn.unpaidLeaveDays).equals(money(cIn.unpaidLeaveDays)) ||
      !money(pIn.sicknessBhxhDays).equals(money(cIn.sicknessBhxhDays)) ||
      !money(pIn.maternityBhxhDays).equals(money(cIn.maternityBhxhDays))
    ) {
      reasons.add('leave_change');
    }

    if (!arraysEqual(normalizedAllowances(pIn), normalizedAllowances(cIn))) {
      reasons.add('allowance_change');
    }

    const pEmp = priorPay.employmentId ? priorEmployments?.get(priorPay.employmentId) : undefined;
    const cEmp = currPay.employmentId ? currentEmployments.get(currPay.employmentId) : undefined;
    // Compare contractual employment terms (`payroll_employment`), NOT `breakdown.pay.baseWage`,
    // because `breakdown.pay.baseWage` holds prorated `basePaid` after unpaid leave reduction.
    const baseWageChanged =
      pEmp !== undefined &&
      cEmp !== undefined &&
      (pEmp.payBasis !== cEmp.payBasis ||
        !money(pEmp.baseWage).equals(money(cEmp.baseWage)) ||
        !nullableDecimalEqual(pEmp.hourlyRate, cEmp.hourlyRate) ||
        !nullableDecimalEqual(pEmp.pieceRate, cEmp.pieceRate));

    if (
      baseWageChanged ||
      !money(pIn.bonus).equals(money(cIn.bonus)) ||
      !money(pIn.otherRegularPay).equals(money(cIn.otherRegularPay)) ||
      !money(pIn.daysNotEmployed).equals(money(cIn.daysNotEmployed)) ||
      !money(pIn.nightHours).equals(money(cIn.nightHours)) ||
      !nullableDecimalEqual(pIn.workedHours, cIn.workedHours) ||
      !nullableDecimalEqual(pIn.pieceCount, cIn.pieceCount) ||
      !arraysEqual(normalizedOvertime(pIn), normalizedOvertime(cIn)) ||
      !priorAdj.gross.equals(currAdj.gross)
    ) {
      reasons.add('salary_change');
    }

    const pDeps = priorPay.breakdown?.dependentsCounted ?? null;
    const cDeps = currPay.breakdown?.dependentsCounted ?? null;
    const pTaxMode = priorPay.breakdown?.taxMode ?? null;
    const cTaxMode = currPay.breakdown?.taxMode ?? null;
    const explicitDeductionChanged =
      !money(pIn.advance).equals(money(cIn.advance)) ||
      !arraysEqual(normalizedDeductions(pIn), normalizedDeductions(cIn)) ||
      !money(pIn.voluntaryPension).equals(money(cIn.voluntaryPension)) ||
      pIn.insured !== cIn.insured ||
      pIn.withholdingRequested !== cIn.withholdingRequested ||
      pIn.commitment !== cIn.commitment ||
      pIn.contractTermMonths !== cIn.contractTermMonths ||
      (pDeps !== null && cDeps !== null && pDeps !== cDeps) ||
      (pTaxMode !== null && cTaxMode !== null && pTaxMode !== cTaxMode) ||
      !priorAdj.insuranceAndPit.equals(currAdj.insuranceAndPit);

    if (explicitDeductionChanged || (money(grossDelta).isZero() && nonZeroMoney(employeeDeductionDelta))) {
      reasons.add('deduction_change');
    }
  } else {
    if (!priorAdj.gross.equals(currAdj.gross)) reasons.add('salary_change');
    if (!priorAdj.insuranceAndPit.equals(currAdj.insuranceAndPit)) reasons.add('deduction_change');
  }

  if (reasons.size === 0) {
    if (workingDaysChanged && nonZeroMoney(grossDelta)) reasons.add('salary_change');
    else if (nonZeroMoney(grossDelta) || nonZeroMoney(employerCostDelta)) reasons.add('salary_change');
    else if (nonZeroMoney(employeeDeductionDelta) || nonZeroMoney(netDelta)) reasons.add('deduction_change');
  }

  return HR_PAYROLL_DIFF_REASONS.filter((tag) => reasons.has(tag));
}

function periodTotals(buckets: ReadonlyMap<string, EmployeePeriodBucket>): HrPayrollPreviewFigures {
  const allFigures = [...buckets.values()].flatMap((b) => b.calculatedFigures);
  return {
    headcount: buckets.size,
    ...sumLineFigures(allFigures),
  };
}

export function computePayrollDiff(input: ComputePayrollDiffInput): HrPayrollPreviewDiff {
  const priorBuckets = input.prior ? buildEmployeeBuckets(input.prior.lines) : new Map<string, EmployeePeriodBucket>();
  const currentBuckets = buildEmployeeBuckets(input.current.lines);

  const totals = periodTotals(currentBuckets);
  const priorTotals = input.prior ? periodTotals(priorBuckets) : null;
  const zeroTotals: HrPayrollPreviewFigures = { headcount: 0, ...zeroLineFigures() };
  const baseTotals = priorTotals ?? zeroTotals;

  const deltas: HrPayrollPreviewDeltas = {
    headcountDelta: totals.headcount - baseTotals.headcount,
    grossDelta: diffMoney(totals.gross, baseTotals.gross),
    employeeInsuranceDelta: diffMoney(totals.employeeInsurance, baseTotals.employeeInsurance),
    pitDelta: diffMoney(totals.pit, baseTotals.pit),
    otherDeductionDelta: diffMoney(totals.otherDeductions, baseTotals.otherDeductions),
    employeeDeductionDelta: diffMoney(totals.employeeDeductions, baseTotals.employeeDeductions),
    netDelta: diffMoney(totals.net, baseTotals.net),
    employerInsuranceDelta: diffMoney(totals.employerInsurance, baseTotals.employerInsurance),
    unionFeeDelta: diffMoney(totals.unionFee, baseTotals.unionFee),
    employerStatutoryDelta: diffMoney(totals.employerStatutory, baseTotals.employerStatutory),
    employerCostDelta: diffMoney(totals.employerCost, baseTotals.employerCost),
    taxableIncomeDelta: diffMoney(totals.taxableIncome, baseTotals.taxableIncome),
  };

  const allEmployeeIds = new Set<string>([...priorBuckets.keys(), ...currentBuckets.keys()]);
  const workingDaysChanged = input.prior !== null && input.prior.workingDays !== input.current.workingDays;
  const rows: HrPayrollPreviewEmployeeDiff[] = [];
  let unchangedCount = 0;

  for (const employeeId of allEmployeeIds) {
    const prior = priorBuckets.get(employeeId);
    const current = currentBuckets.get(employeeId);
    const priorFigs = prior?.aggregated ?? zeroLineFigures();
    const currFigs = current?.aggregated ?? zeroLineFigures();

    const grossDelta = diffMoney(currFigs.gross, priorFigs.gross);
    const employeeInsuranceDelta = diffMoney(currFigs.employeeInsurance, priorFigs.employeeInsurance);
    const pitDelta = diffMoney(currFigs.pit, priorFigs.pit);
    const otherDeductionDelta = diffMoney(currFigs.otherDeductions, priorFigs.otherDeductions);
    const employeeDeductionDelta = diffMoney(currFigs.employeeDeductions, priorFigs.employeeDeductions);
    const netDelta = diffMoney(currFigs.net, priorFigs.net);
    const employerInsuranceDelta = diffMoney(currFigs.employerInsurance, priorFigs.employerInsurance);
    const unionFeeDelta = diffMoney(currFigs.unionFee, priorFigs.unionFee);
    const employerStatutoryDelta = diffMoney(currFigs.employerStatutory, priorFigs.employerStatutory);
    const employerCostDelta = diffMoney(currFigs.employerCost, priorFigs.employerCost);

    const reasons = detectReasons({
      prior,
      current,
      priorEmployments: input.prior?.employments ?? null,
      currentEmployments: input.current.employments,
      grossDelta,
      employeeDeductionDelta,
      netDelta,
      employerCostDelta,
      workingDaysChanged,
    });

    const hasRefused = Boolean(current?.hasRefused);
    const hasFlags = Boolean(current?.hasFlags);
    const changed =
      !prior ||
      !current ||
      reasons.length > 0 ||
      hasRefused ||
      nonZeroMoney(grossDelta) ||
      nonZeroMoney(employeeDeductionDelta) ||
      nonZeroMoney(netDelta) ||
      nonZeroMoney(employerCostDelta);

    if (!changed) {
      unchangedCount += 1;
      if (!input.includeUnchanged) continue;
    }

    const identity = input.employees.get(employeeId);
    const erased = identity === undefined || identity.erased;

    rows.push({
      employeeId,
      employeeName: erased ? HR_ERASED_NAME : identity.displayName,
      erased,
      changed,
      reasons,
      prior: prior?.aggregated ?? null,
      current: current?.aggregated ?? null,
      grossDelta,
      employeeInsuranceDelta,
      pitDelta,
      otherDeductionDelta,
      employeeDeductionDelta,
      netDelta,
      employerInsuranceDelta,
      unionFeeDelta,
      employerStatutoryDelta,
      employerCostDelta,
      priorLeaveDays: prior?.leaveDays ?? null,
      currentLeaveDays: current?.leaveDays ?? null,
      hasRefused,
      hasFlags,
    });
  }

  rows.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    const costCmp = money(b.employerCostDelta).abs().comparedTo(money(a.employerCostDelta).abs());
    if (costCmp !== 0) return costCmp;
    const netCmp = money(b.netDelta).abs().comparedTo(money(a.netDelta).abs());
    if (netCmp !== 0) return netCmp;
    const nameCmp = a.employeeName.localeCompare(b.employeeName);
    if (nameCmp !== 0) return nameCmp;
    return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
  });

  return {
    mode: input.mode,
    legalEntityId: input.legalEntityId,
    legalEntityName: input.legalEntityName,
    month: input.month,
    current: input.current.runInfo,
    prior: input.prior?.runInfo ?? null,
    totals,
    priorTotals,
    deltas,
    unchangedCount,
    rows,
  };
}

async function loadEmploymentMap(
  ctx: QueryContext,
  employmentIds: readonly string[],
): Promise<Map<string, PreviewEmploymentMeta>> {
  const result = new Map<string, PreviewEmploymentMeta>();
  const uniqueIds = [...new Set(employmentIds)];
  if (uniqueIds.length === 0) return result;
  const rows = await ctx.trx
    .selectFrom('crove_hr.payroll_employment')
    .select(['id', 'base_wage', 'pay_basis', 'hourly_rate', 'piece_rate'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', uniqueIds)
    .execute();
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      baseWage: row.base_wage,
      payBasis: row.pay_basis ?? 'monthly',
      hourlyRate: row.hourly_rate ?? null,
      pieceRate: row.piece_rate ?? null,
    });
  }
  return result;
}

async function loadStoredPeriodSnapshot(
  ctx: QueryContext,
  run: {
    id: string;
    month: string;
    status: HrRunStatus;
    working_days: string;
    approved_at: Date | string | null;
  },
): Promise<PreviewPeriodSnapshot> {
  const rows = (await ctx.trx
    .selectFrom('crove_hr.payroll_line')
    .select([...LINE_COLUMNS, 'breakdown'])
    .where('org_id', '=', ctx.orgId)
    .where('run_id', '=', run.id)
    .orderBy('kind')
    .orderBy('id')
    .execute()) as (StoredLine & { breakdown: unknown })[];

  const lines: PreviewSourceLine[] = rows.map((row) => ({
    employeeId: row.employee_id,
    employmentId: row.employment_id,
    kind: row.kind,
    status: row.status,
    inputs: row.kind === 'pay' ? parseInputs(row.inputs) : parseInputs({}),
    figures: figuresOfLine(row),
    breakdown: parseBreakdownSnapshot(row.breakdown),
    hasFlags: lineHasComplianceFlag(row.status, row.checks, row.net),
  }));

  const employmentIds = rows.flatMap((r) => (r.employment_id ? [r.employment_id] : []));
  const employments = await loadEmploymentMap(ctx, employmentIds);
  const distinctEmployees = new Set(lines.map((l) => l.employeeId));

  return {
    runInfo: {
      runId: run.id,
      month: run.month,
      status: run.status,
      approvedAt: run.approved_at === null ? null : new Date(run.approved_at).toISOString(),
      headcount: distinctEmployees.size,
      refusedCount: lines.filter((l) => l.status === 'refused').length,
      flaggedCount: lines.filter((l) => l.hasFlags).length,
    },
    workingDays: run.working_days,
    lines,
    employments,
  };
}

async function buildProjectedSnapshot(
  ctx: QueryContext,
  legalEntityId: string,
  month: string,
): Promise<PreviewPeriodSnapshot> {
  const workingDays = HR_DEFAULT_WORKING_DAYS;
  const people = await peopleOf(ctx, legalEntityId, month);
  const employeeIds = people.map((p) => p.employeeId);

  const prevMonthLines =
    people.length === 0
      ? []
      : await ctx.trx
          .selectFrom('crove_hr.payroll_line as l')
          .innerJoin('crove_hr.payroll_run as r', (join) => join.onRef('r.org_id', '=', 'l.org_id').onRef('r.id', '=', 'l.run_id'))
          .select(['l.employee_id', 'l.employment_id', 'l.inputs'])
          .where('l.org_id', '=', ctx.orgId)
          .where('r.legal_entity_id', '=', legalEntityId)
          .where('r.month', '=', previousMonth(month))
          .where('l.kind', '=', 'pay')
          .execute();
  const lastInputs = new Map(prevMonthLines.map((b) => [b.employee_id, { employment_id: b.employment_id, inputs: b.inputs }]));

  const bhxhByEmployee = await loadBhxhLeaveByEmployee(ctx, employeeIds, month);
  const unpaidEntries =
    employeeIds.length === 0
      ? []
      : await ctx.trx
          .selectFrom('crove_hr.payroll_leave_entry')
          .select(['employee_id', 'days'])
          .where('org_id', '=', ctx.orgId)
          .where('employee_id', 'in', employeeIds)
          .where('month', '=', month)
          .where('kind', '=', 'unpaid_leave')
          .execute();
  const unpaidByEmployee = new Map(unpaidEntries.map((e) => [e.employee_id, formatSyncUnpaidDays(e.days)]));

  const employments = new Map<string, PreviewEmploymentMeta>();
  const lines: PreviewSourceLine[] = [];

  for (const person of people) {
    employments.set(person.terms.id, {
      id: person.terms.id,
      baseWage: person.terms.baseWage,
      payBasis: person.terms.payBasis,
      hourlyRate: person.terms.hourlyRate,
      pieceRate: person.terms.pieceRate,
    });
    const base = initialInputsFor(person, lastInputs.get(person.employeeId), bhxhByEmployee.get(person.employeeId));
    const unpaid = unpaidByEmployee.get(person.employeeId);
    const inputs: HrPayrollInputs =
      unpaid !== undefined ? { ...base, unpaidLeaveDays: unpaid, unpaidLeaveFromLedger: true } : base;

    // Ensure BHXH day formatting stays consistent with runSyncLeave checks.
    if (inputs.sicknessBhxhDays !== '0') formatSyncBhxhDays(inputs.sicknessBhxhDays);
    if (inputs.maternityBhxhDays !== '0') formatSyncBhxhDays(inputs.maternityBhxhDays);

    const calc = figuresOf(person, inputs, month, workingDays);
    const figures: HrRunFigures | null =
      calc.status === 'refused' || calc.gross === null
        ? null
        : {
            gross: calc.gross,
            employeeInsurance: calc.employee_insurance ?? ZERO,
            employerInsurance: calc.employer_insurance ?? ZERO,
            unionFee: calc.union_fee ?? ZERO,
            taxableIncome: calc.taxable_income ?? ZERO,
            pit: calc.pit ?? ZERO,
            net: calc.net ?? ZERO,
            employerCost: calc.employer_cost ?? ZERO,
          };

    lines.push({
      employeeId: person.employeeId,
      employmentId: person.terms.id,
      kind: 'pay',
      status: calc.status,
      inputs,
      figures,
      breakdown: parseBreakdownSnapshot(calc.breakdown),
      hasFlags: lineHasComplianceFlag(calc.status, calc.checks, calc.net),
    });
  }

  return {
    runInfo: {
      runId: null,
      month,
      status: null,
      approvedAt: null,
      headcount: people.length,
      refusedCount: lines.filter((l) => l.status === 'refused').length,
      flaggedCount: lines.filter((l) => l.hasFlags).length,
    },
    workingDays,
    lines,
    employments,
  };
}

async function resolveTargetLegalEntity(
  ctx: QueryContext,
  requestedId: string | undefined,
): Promise<{ id: string; name: string }> {
  if (requestedId !== undefined) {
    const row = await ctx.trx
      .selectFrom('ludy_kernel.legal_entity')
      .select(['id', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', requestedId)
      .executeTakeFirst();
    if (!row) throw new DomainError('HR_LEGAL_ENTITY_NOT_FOUND', 404, 'Không tìm thấy pháp nhân này');
    return row;
  }
  const defaultEntity = await ctx.trx
    .selectFrom('ludy_kernel.legal_entity')
    .select(['id', 'name'])
    .where('org_id', '=', ctx.orgId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (defaultEntity) return defaultEntity;
  const fallback = await ctx.trx
    .selectFrom('ludy_kernel.legal_entity')
    .select(['id', 'name'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (!fallback) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy tạo hoặc chọn pháp nhân để xem trước bảng lương');
  return fallback;
}

export const payrollPreviewDiff = defineQuery({
  name: 'hr.payroll.preview_diff',
  input: zHrPayrollPreviewDiffAsk,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input: HrPayrollPreviewDiffAsk): Promise<HrPayrollPreviewDiff> => {
    userOf(ctx.actor);

    let mode: HrPayrollPreviewMode;
    let legalEntityId: string;
    let legalEntityName: string;
    let month: string;
    let currentSnapshot: PreviewPeriodSnapshot;

    if (input.runId !== undefined) {
      const targetRun = await ctx.trx
        .selectFrom('crove_hr.payroll_run')
        .select(['id', 'legal_entity_id', 'month', 'status', 'working_days', 'approved_at'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.runId)
        .executeTakeFirst();
      if (!targetRun) throw runNotFound();

      mode = targetRun.status === 'draft' ? 'draft_run' : 'finalized_run';
      legalEntityId = targetRun.legal_entity_id;
      legalEntityName = await employerName(ctx, legalEntityId);
      month = targetRun.month;
      currentSnapshot = await loadStoredPeriodSnapshot(ctx, targetRun);
    } else {
      const entity = await resolveTargetLegalEntity(ctx, input.legalEntityId);
      mode = 'projected';
      legalEntityId = entity.id;
      legalEntityName = entity.name;
      month = input.month ?? vietnamDay(new Date()).slice(0, 7);
      currentSnapshot = await buildProjectedSnapshot(ctx, legalEntityId, month);
    }

    const priorRun = await ctx.trx
      .selectFrom('crove_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status', 'working_days', 'approved_at'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('month', '<', month)
      .where('status', 'in', ['approved', 'paid', 'closed'])
      .orderBy('month', 'desc')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst();

    const priorSnapshot = priorRun ? await loadStoredPeriodSnapshot(ctx, priorRun) : null;

    const employeeIds = [
      ...new Set([
        ...currentSnapshot.lines.map((l) => l.employeeId),
        ...(priorSnapshot?.lines.map((l) => l.employeeId) ?? []),
      ]),
    ];
    const employeeRows =
      employeeIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_hr.payroll_employee')
            .select(['id', 'display_name', 'erased_at'])
            .where('org_id', '=', ctx.orgId)
            .where('id', 'in', employeeIds)
            .execute();

    const employees = new Map<string, PreviewEmployeeIdentity>(
      employeeRows.map((e) => [
        e.id,
        {
          displayName: e.erased_at !== null ? HR_ERASED_NAME : e.display_name,
          erased: e.erased_at !== null,
        },
      ]),
    );

    return computePayrollDiff({
      mode,
      legalEntityId,
      legalEntityName,
      month,
      current: currentSnapshot,
      prior: priorSnapshot,
      employees,
      includeUnchanged: input.includeUnchanged ?? false,
    });
  },
});

export const hrPayrollPreviewQueries = [payrollPreviewDiff];
