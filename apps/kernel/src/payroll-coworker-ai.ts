// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on payroll, on the API side (#2534; plan docs/plan/payroll.md 6.6 and 6.7, ADR-0046). The stored run is read through the audited sensitive queries
// (hr.payroll.run.sheet, hr.payroll.run.list, hr.payroll.line.payslip: owners and admins only, the audit row written before each read), in the member's own transaction. The model call
// then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told the pseudonymized sheet only: an alias
// per employee, fixed component labels and amounts, and yes/no facts and counts worked out below from the stored flags; never a name, identity number, tax code, account or address
// (none of them is read here but the display name, which is used to put names back after the checks, and to refuse a prompt that holds one). Pay is never recomputed: every figure is
// a stored one.
//
// What is not stored yet is not guessed: the payment method of a person and the registration of a dependent are not in the stored run, so those findings are not
// raised (the sheet says nothing the data does not show). Everything is read, never written: nothing here stores a text, changes a run or approves. Caller authorization runs first without
// burning a rate ticket; when AI is on, the rate ticket is taken before the sensitive audited reads (so a rate-limited caller triggers zero audited reads) and refunded when deterministic checks
// find nothing (`quiet`). When AI is off, out of budget, failed or its text is refused, every finding code made is still returned (its facts, with the names put back by code); the model's
// sentence is attached to a finding only when it passed the checks.
// A failure is named, never quoted: neither the sheet nor the model's answer is logged.
import {
  ADJUSTMENT_SHARE_THRESHOLD_PERCENT,
  ADVANCE_SHARE_THRESHOLD_PERCENT,
  AiBudgetExhaustedError,
  PAYROLL_ANOMALY_KINDS,
  PAYROLL_SHEET_LINES_MAX,
  PAYROLL_SIGNAL_KINDS,
  amountText,
  dependentsCountedOf,
  findAnomalies,
  findSignals,
  payrollFiguresOf,
  pseudonymizePayrollDiff,
  pseudonymizeSheet,
  restoreAliases,
  restoreDiffAliases,
  type InboxReader,
  type PayrollDiffFactRow,
  type PayrollSheetLine,
} from '@ludy/agent';
import { Decimal } from '@ludy/l10n-vn';
import type {
  HrCoworkerExplained,
  HrCoworkerFlagged,
  HrCoworkerPrepared,
  HrLineView,
  HrPayrollDiffExplainAsk,
  HrPayrollDiffExplained,
  HrPayrollPreviewDiff,
  HrPayrollPreviewDiffAsk,
  HrPayslip,
  HrRunSheet,
  HrRunSummary,
} from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface PayrollAi {
  reader: (Pick<InboxReader, 'payrollPrepare' | 'payrollFlag' | 'payrollExplain'> & Partial<Pick<InboxReader, 'payrollDiffExplain'>>) | null;
  budget: DraftBudget;
  prepareBudget?: DraftBudget;
  flagBudget?: DraftBudget;
  explainBudget?: DraftBudget;
  diffBudget?: DraftBudget;
}

/** The owner/admin access check and the audited reads the coworker is built on, each run in the member's own authority. */
export interface PayrollReads {
  authorize?: () => Promise<unknown>;
  sheet(runId: string): Promise<HrRunSheet>;
  runs(legalEntityId: string): Promise<HrRunSummary[]>;
  payslip(lineId: string): Promise<HrPayslip>;
  previewDiff?: (input: HrPayrollPreviewDiffAsk) => Promise<HrPayrollPreviewDiff>;
}

const monthBefore = (month: string, back: number): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const payLines = (sheet: HrRunSheet | null): HrLineView[] => (sheet ? sheet.lines.filter((l) => l.kind === 'pay' && l.status === 'calculated' && l.figures !== null) : []);
const figuresOfLine = (l: HrLineView) => payrollFiguresOf(l.figures as NonNullable<HrLineView['figures']>, l.breakdown);

// The insured wage was cut down to a cap: the insurable pay is above the cap of a fund.
function insuredAboveCap(breakdown: HrLineView['breakdown']): boolean {
  const insurance = (breakdown?.insurance ?? {}) as { insurablePay?: unknown; bounds?: unknown };
  if (typeof insurance.insurablePay !== 'string' || !Array.isArray(insurance.bounds)) return false;
  const pay = new Decimal(insurance.insurablePay);
  return insurance.bounds.some((b) => typeof (b as { cap?: unknown }).cap === 'string' && pay.greaterThan((b as { cap: string }).cap));
}

export interface PayrollSource {
  lines: PayrollSheetLine[];
  names: Map<string, string>;
  blockingRules: number;
  employerName: string;
}

/** The sheet of a run as facts: this month's lines with last month's figures, the overtime run and the stored flags. The earlier months are the run's own legal entity's. */
export async function payrollSource(reads: PayrollReads, runId: string): Promise<PayrollSource> {
  const sheet = await reads.sheet(runId);
  // The sheet's header: the pay run it is about. Read by key, since the job-egress scan reads any `.run` of this server as a call to the job runner.
  const header = sheet['run'];
  const runs = await reads.runs(header.legalEntityId);
  const earlier = async (back: number): Promise<HrRunSheet | null> => {
    const month = monthBefore(header.month, back);
    const found = runs.find((r) => r.legalEntityId === header.legalEntityId && r.month === month);
    return found ? reads.sheet(found.id) : null;
  };
  const one = await earlier(1);
  const two = one ? await earlier(2) : null;
  const before = new Map(payLines(one).map((l) => [l.employeeId, figuresOfLine(l)]));
  const beforeThat = new Map(payLines(two).map((l) => [l.employeeId, figuresOfLine(l)]));
  const names = new Map<string, string>();
  const lines: PayrollSheetLine[] = payLines(sheet).map((l) => {
    names.set(l.employeeId, l.employeeName);
    const figures = figuresOfLine(l);
    const previous = before.get(l.employeeId) ?? null;
    const overtime = (f: { overtime: string } | null | undefined) => f !== null && f !== undefined && new Decimal(f.overtime).greaterThan(0);
    const streak = overtime(figures) ? 1 + (overtime(previous) ? 1 + (overtime(beforeThat.get(l.employeeId)) ? 1 : 0) : 0) : 0;
    const annualLeaveExceeded = l.flags.includes('annual_leave_exceeded');
    const numericInput = (key: string): string => {
      const raw = l.inputs?.[key];
      return typeof raw === 'string' && /^\d{1,16}(\.\d{1,2})?$/.test(raw) ? raw : '0';
    };
    const advanceAmt = new Decimal(numericInput('advance'));
    const retroAmt = new Decimal(numericInput('retroPay'));
    const offsetAmt = new Decimal(numericInput('offsetDeduction'));
    const baseWage = new Decimal(figures.base_wage || '0');
    const largeSalaryAdvance =
      advanceAmt.greaterThan(0) &&
      (baseWage.isZero() || advanceAmt.dividedBy(baseWage).times(100).greaterThan(ADVANCE_SHARE_THRESHOLD_PERCENT));
    const totalAdj = retroAmt.plus(offsetAmt);
    const largePayrollAdjustment =
      totalAdj.greaterThan(0) &&
      (baseWage.isZero() || totalAdj.dividedBy(baseWage).times(100).greaterThan(ADJUSTMENT_SHARE_THRESHOLD_PERCENT));
    return {
      employeeId: l.employeeId,
      figures,
      previous,
      contract: {
        startsInMonth: l.flags.includes('new_hire'),
        probationEndsInMonth: l.flags.includes('probation_ends_this_month'),
        endsInMonth: l.flags.includes('ends_this_month'),
        severanceCheckSuggested: l.flags.includes('severance_check'),
      },
      overtimeMonthsInRow: streak,
      dependentsWithoutRegistration: 0,
      exceededAnnualDays: annualLeaveExceeded && typeof l.exceededAnnualDays === 'string' ? l.exceededAnnualDays : '0',
      advanceAmount: advanceAmt.toFixed(),
      retroPayAmount: retroAmt.toFixed(),
      offsetDeductionAmount: offsetAmt.toFixed(),
      checks: {
        minimumWageFailed: l.flags.includes('check_minimum_wage'),
        deductionCapFailed: l.flags.includes('check_deduction_cap'),
        overtimeCapFailed: l.checks.some((c) => c.id === 'overtime_cap' && !c.ok),
        netBelowMinimum: l.flags.includes('net_below_minimum'),
        insuredAboveCap: insuredAboveCap(l.breakdown),
        cashPaymentOverLimit: false,
        annualLeaveExceeded,
        workPermitExpiring: l.flags.includes('work_permit_expiring'),
        bhxhSuspendedRegime: l.flags.includes('bhxh_suspended_regime'),
        nonResidentFlatPit: l.flags.includes('non_resident_flat_pit'),
        largeSalaryAdvance,
        largePayrollAdjustment,
      },
    };
  });
  return { lines, names, blockingRules: sheet.blocking.length, employerName: header.employerName };
}

type State = HrCoworkerExplained['ai'];

async function runModel<T>(label: string, call: () => Promise<T>): Promise<{ state: 'budget' | 'failed' } | { value: T }> {
  try {
    return { value: await call() };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return { state: 'budget' };
    console.error(`[payroll-coworker-ai] ${label} failed`, error instanceof Error ? error.name : typeof error);
    return { state: 'failed' };
  }
}

function isForbiddenError(error: unknown): boolean {
  return error instanceof DomainError && error.status === 403;
}

const forbiddenOf = (source: PayrollSource): string[] => [...source.names.values(), source.employerName].filter((v) => v.trim() !== '');

// The findings are what CODE found in the stored run (plan 6.7: "code finds the anomalies"), written by code with the people's names put back. Once the sheet has been read (AI off, out of
// budget, failed or a sentence refused), the owner still sees each one; a rate-limited call (`busy`) stops before reading the sheet so repeated calls trigger zero sensitive audited reads.
const KIND_ORDER: readonly string[] = [...PAYROLL_ANOMALY_KINDS, ...PAYROLL_SIGNAL_KINDS];
const byKindThenFacts = <T extends { kind: string; facts: string }>(a: T, b: T) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.facts < b.facts ? -1 : a.facts > b.facts ? 1 : 0);

function namesOf(source: PayrollSource, aliases: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...aliases].map(([alias, id]) => [alias, source.names.get(id) ?? alias]));
}

export async function prepareMonth(ai: PayrollAi, reads: PayrollReads, orgId: string, userId: string, runId: string, language: 'vi' | 'en'): Promise<HrCoworkerPrepared> {
  await reads.authorize?.();
  if (!ai.reader) {
    const source = await payrollSource(reads, runId);
    const { sheet, aliases } = pseudonymizeSheet(source.lines, { language, blockingRules: source.blockingRules });
    const signals = findSignals(sheet);
    if (signals.length === 0) return { ai: 'quiet', items: [] };
    const named = namesOf(source, aliases);
    return {
      ai: 'off',
      items: signals
        .map((s) => ({ id: s.id, kind: s.kind, employeeId: aliases.get(s.alias) ?? null, facts: restoreAliases(s.facts, named), field: null, text: null }))
        .sort(byKindThenFacts),
    };
  }
  const reader = ai.reader;
  const ticket = (ai.prepareBudget ?? ai.budget).take(orgId, userId);
  if (!ticket.allowed) return { ai: 'busy', items: [] };
  try {
    let source: PayrollSource;
    try {
      source = await payrollSource(reads, runId);
    } catch (error: unknown) {
      if (isForbiddenError(error)) ticket.refund?.();
      throw error;
    }
    const { sheet, aliases } = pseudonymizeSheet(source.lines, { language, blockingRules: source.blockingRules });
    const signals = findSignals(sheet);
    if (signals.length === 0) {
      ticket.refund?.();
      return { ai: 'quiet', items: [] };
    }
    const named = namesOf(source, aliases);
    const itemsOf = (proposals: ReadonlyMap<string, { field: HrCoworkerPrepared['items'][number]['field']; note: string }>): HrCoworkerPrepared['items'] =>
      signals
        .map((s) => {
          const p = proposals.get(s.id);
          return { id: s.id, kind: s.kind, employeeId: aliases.get(s.alias) ?? null, facts: restoreAliases(s.facts, named), field: p?.field ?? null, text: p ? restoreAliases(p.note, named) : null };
        })
        .sort(byKindThenFacts);
    const answer = await runModel('prepare', () => reader.payrollPrepare(sheet, { forbidden: forbiddenOf(source) }));
    if ('state' in answer) return { ai: answer.state, items: itemsOf(new Map()) };
    if (answer.value.kind === 'none') {
      if (answer.value.code === 'QUIET') {
        ticket.refund?.();
        return { ai: 'quiet', items: [] };
      }
      console.error(`[payroll-coworker-ai] prepare refused: ${answer.value.code}`);
      return { ai: 'failed', items: itemsOf(new Map()) };
    }
    return { ai: 'used', items: itemsOf(new Map(answer.value.items.map((i) => [i.id, { field: i.field, note: i.note }]))) };
  } finally {
    ticket.release();
  }
}

export async function flagMonth(ai: PayrollAi, reads: PayrollReads, orgId: string, userId: string, runId: string, language: 'vi' | 'en'): Promise<HrCoworkerFlagged> {
  await reads.authorize?.();
  if (!ai.reader) {
    const source = await payrollSource(reads, runId);
    const { sheet, aliases } = pseudonymizeSheet(source.lines, { language, blockingRules: source.blockingRules });
    const anomalies = findAnomalies(sheet);
    if (anomalies.length === 0) return { ai: 'quiet', items: [] };
    const named = namesOf(source, aliases);
    return {
      ai: 'off',
      items: anomalies
        .map((a) => ({ id: a.id, kind: a.kind, employeeId: a.alias === null ? null : (aliases.get(a.alias) ?? null), facts: restoreAliases(a.facts, named), text: null }))
        .sort(byKindThenFacts),
    };
  }
  const reader = ai.reader;
  const ticket = (ai.flagBudget ?? ai.budget).take(orgId, userId);
  if (!ticket.allowed) return { ai: 'busy', items: [] };
  try {
    let source: PayrollSource;
    try {
      source = await payrollSource(reads, runId);
    } catch (error: unknown) {
      if (isForbiddenError(error)) ticket.refund?.();
      throw error;
    }
    const { sheet, aliases } = pseudonymizeSheet(source.lines, { language, blockingRules: source.blockingRules });
    const anomalies = findAnomalies(sheet);
    if (anomalies.length === 0) {
      ticket.refund?.();
      return { ai: 'quiet', items: [] };
    }
    const named = namesOf(source, aliases);
    const itemsOf = (sentences: ReadonlyMap<string, string>): HrCoworkerFlagged['items'] =>
      anomalies
        .map((a) => ({ id: a.id, kind: a.kind, employeeId: a.alias === null ? null : (aliases.get(a.alias) ?? null), facts: restoreAliases(a.facts, named), text: sentences.has(a.id) ? restoreAliases(sentences.get(a.id) as string, named) : null }))
        .sort(byKindThenFacts);
    const answer = await runModel('flag', () => reader.payrollFlag(sheet, { forbidden: forbiddenOf(source) }));
    if ('state' in answer) return { ai: answer.state, items: itemsOf(new Map()) };
    if (answer.value.kind === 'none') {
      if (answer.value.code === 'QUIET') {
        ticket.refund?.();
        return { ai: 'quiet', items: [] };
      }
      console.error(`[payroll-coworker-ai] flag refused: ${answer.value.code}`);
      return { ai: 'failed', items: itemsOf(new Map()) };
    }
    return { ai: 'used', items: itemsOf(new Map(answer.value.items.map((i) => [i.id, i.text]))) };
  } finally {
    ticket.release();
  }
}

export async function explainPayslip(ai: PayrollAi, reads: PayrollReads, orgId: string, userId: string, lineId: string, language: 'vi' | 'en'): Promise<HrCoworkerExplained> {
  await reads.authorize?.();
  const none = (state: State): HrCoworkerExplained => ({ ai: state, text: null });
  if (!ai.reader) {
    await reads.payslip(lineId);
    return none('off');
  }
  const reader = ai.reader;
  const ticket = (ai.explainBudget ?? ai.budget).take(orgId, userId);
  if (!ticket.allowed) return none('busy');
  try {
    let slip: HrPayslip;
    try {
      slip = await reads.payslip(lineId);
    } catch (error: unknown) {
      if (isForbiddenError(error)) ticket.refund?.();
      throw error;
    }
    const breakdown = (slip.breakdown ?? {}) as { tax?: { mode?: unknown }; insurance?: { suspended?: unknown } };
    const taxMode = typeof breakdown.tax?.mode === 'string' ? breakdown.tax.mode : undefined;
    const insuranceSuspended = typeof breakdown.insurance?.suspended === 'string' ? breakdown.insurance.suspended : null;
    const request = {
      language,
      figures: payrollFiguresOf(slip.figures, slip.breakdown),
      dependentsCounted: dependentsCountedOf(slip.breakdown),
      ...(taxMode !== undefined ? { taxMode } : {}),
      ...(insuranceSuspended !== null ? { insuranceSuspended } : {}),
    };
    const forbidden = [slip.employeeName, slip.employerName].filter((v) => v.trim() !== '');
    const answer = await runModel('explain', () => reader.payrollExplain(request, { forbidden }));
    if ('state' in answer) return none(answer.state);
    if (answer.value.kind === 'none') {
      console.error(`[payroll-coworker-ai] explanation refused: ${answer.value.code}`);
      return none('failed');
    }
    return { ai: 'used', text: answer.value.text };
  } finally {
    ticket.release();
  }
}

const isPreviewQuiet = (diff: HrPayrollPreviewDiff): boolean =>
  diff.rows.every((r) => !r.changed) &&
  diff.deltas.headcountDelta === 0 &&
  new Decimal(diff.deltas.grossDelta).isZero() &&
  new Decimal(diff.deltas.employeeDeductionDelta).isZero() &&
  new Decimal(diff.deltas.netDelta).isZero() &&
  new Decimal(diff.deltas.employerCostDelta).isZero();

const signedSummaryDelta = (value: string, language: 'vi' | 'en'): string => {
  const d = new Decimal(value);
  if (d.isZero()) return language === 'vi' ? 'không đổi' : 'unchanged';
  const dir = d.isPositive() ? (language === 'vi' ? 'tăng' : 'up') : language === 'vi' ? 'giảm' : 'down';
  const unit = language === 'vi' ? 'đồng' : 'dong';
  return `${dir} ${amountText(d.abs().toFixed(), language)} ${unit}`;
};

export function deterministicDiffSummary(diff: HrPayrollPreviewDiff, language: 'vi' | 'en'): string {
  const changed = diff.rows.filter((r) => r.changed);
  if (diff.prior === null) {
    if (diff.current.headcount === 0) {
      return language === 'vi' ? 'Chưa có nhân sự hoặc số liệu trong kỳ.' : 'No employees or figures in this period yet.';
    }
    return language === 'vi'
      ? `Kỳ lương đầu tiên (${diff.current.headcount} người): tổng chi phí công ty ${amountText(diff.totals.employerCost, 'vi')} đồng, thực nhận ${amountText(diff.totals.net, 'vi')} đồng.`
      : `First payroll period (${diff.current.headcount} people): employer cost ${amountText(diff.totals.employerCost, 'en')} dong, net pay ${amountText(diff.totals.net, 'en')} dong.`;
  }
  if (isPreviewQuiet(diff)) {
    return language === 'vi'
      ? 'Không có biến động so với kỳ lương đã duyệt gần nhất.'
      : 'No payroll fluctuations compared with the immediately preceding finalized run.';
  }
  const hcText =
    diff.deltas.headcountDelta === 0
      ? ''
      : diff.deltas.headcountDelta > 0
        ? language === 'vi'
          ? `, tăng ${diff.deltas.headcountDelta} người`
          : `, up ${diff.deltas.headcountDelta} headcount`
        : language === 'vi'
          ? `, giảm ${Math.abs(diff.deltas.headcountDelta)} người`
          : `, down ${Math.abs(diff.deltas.headcountDelta)} headcount`;
  const drivers = changed
    .slice(0, 2)
    .map((r) => r.employeeName)
    .join(', ');
  const driverSuffix =
    drivers.length > 0
      ? language === 'vi'
        ? `; biến động chính ở ${drivers}.`
        : `; top movers: ${drivers}.`
      : '.';
  return language === 'vi'
    ? `Tổng chi phí công ty ${signedSummaryDelta(diff.deltas.employerCostDelta, 'vi')}, thực nhận ${signedSummaryDelta(diff.deltas.netDelta, 'vi')}${hcText}${driverSuffix}`
    : `Employer cost ${signedSummaryDelta(diff.deltas.employerCostDelta, 'en')}, net pay ${signedSummaryDelta(diff.deltas.netDelta, 'en')}${hcText}${driverSuffix}`;
}

export async function explainPayrollDiff(
  ai: PayrollAi,
  reads: PayrollReads,
  orgId: string,
  userId: string,
  input: HrPayrollDiffExplainAsk,
): Promise<HrPayrollDiffExplained> {
  await reads.authorize?.();
  if (!reads.previewDiff) {
    throw new DomainError('INTERNAL', 500, 'Thiếu hàm đọc biến động bảng lương');
  }
  const language = input.lang ?? 'vi';
  const queryArg: HrPayrollPreviewDiffAsk = {
    ...(input.runId !== undefined
      ? { runId: input.runId }
      : {
          ...(input.month !== undefined ? { month: input.month } : {}),
          ...(input.legalEntityId !== undefined ? { legalEntityId: input.legalEntityId } : {}),
        }),
    includeUnchanged: false,
  };
  const reader = ai.reader;
  if (!reader?.payrollDiffExplain) {
    const diff = await reads.previewDiff(queryArg);
    const deterministicText = deterministicDiffSummary(diff, language);
    return { ai: isPreviewQuiet(diff) ? 'quiet' : 'off', text: null, deterministicText };
  }

  const ticket = (ai.diffBudget ?? ai.budget).take(orgId, userId);
  if (!ticket.allowed) {
    return { ai: 'busy', text: null, deterministicText: '' };
  }
  try {
    let diff: HrPayrollPreviewDiff;
    try {
      diff = await reads.previewDiff(queryArg);
    } catch (error: unknown) {
      if (isForbiddenError(error)) ticket.refund?.();
      throw error;
    }
    const deterministicText = deterministicDiffSummary(diff, language);
    if (isPreviewQuiet(diff)) {
      ticket.refund?.();
      return { ai: 'quiet', text: null, deterministicText };
    }
    const changed = diff.rows.filter((r) => r.changed);
    const promptRows: PayrollDiffFactRow[] =
      changed.length <= PAYROLL_SHEET_LINES_MAX
        ? changed.map((r) => ({
            employeeId: r.employeeId,
            reasons: r.reasons,
            grossDelta: r.grossDelta,
            employeeDeductionDelta: r.employeeDeductionDelta,
            netDelta: r.netDelta,
            employerStatutoryDelta: r.employerStatutoryDelta,
            employerCostDelta: r.employerCostDelta,
            priorLeaveDays: r.priorLeaveDays,
            currentLeaveDays: r.currentLeaveDays,
            hasRefused: r.hasRefused,
            hasFlags: r.hasFlags,
          }))
        : [];
    const { sheet, aliases } = pseudonymizePayrollDiff({
      language,
      hasPrior: diff.prior !== null,
      headcount: diff.current.headcount,
      priorHeadcount: diff.prior?.headcount ?? null,
      headcountDelta: diff.deltas.headcountDelta,
      grossDelta: diff.deltas.grossDelta,
      employeeDeductionDelta: diff.deltas.employeeDeductionDelta,
      netDelta: diff.deltas.netDelta,
      employerStatutoryDelta: diff.deltas.employerStatutoryDelta,
      employerCostDelta: diff.deltas.employerCostDelta,
      rows: promptRows,
    });
    const rowByEmployeeId = new Map(changed.map((r) => [r.employeeId, r]));
    const namesByAlias = new Map<string, string>();
    for (const [alias, employeeId] of aliases) {
      const row = rowByEmployeeId.get(employeeId);
      if (row) namesByAlias.set(alias, row.employeeName);
    }
    const forbidden = [
      diff.legalEntityName,
      ...changed.filter((r) => !r.erased).map((r) => r.employeeName),
    ].filter((v) => v.trim() !== '');

    const answer = await runModel('diff', () => reader.payrollDiffExplain!(sheet, { forbidden }));
    if ('state' in answer) {
      return { ai: answer.state, text: null, deterministicText };
    }
    if (answer.value.kind === 'none') {
      if (answer.value.code === 'QUIET') {
        ticket.refund?.();
        return { ai: 'quiet', text: null, deterministicText };
      }
      console.error(`[payroll-coworker-ai] diff refused: ${answer.value.code}`);
      return { ai: 'failed', text: null, deterministicText };
    }
    return {
      ai: 'used',
      text: restoreDiffAliases(answer.value.text, namesByAlias),
      deterministicText,
    };
  } finally {
    ticket.release();
  }
}
