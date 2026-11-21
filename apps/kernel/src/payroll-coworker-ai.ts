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
  AiBudgetExhaustedError,
  PAYROLL_ANOMALY_KINDS,
  PAYROLL_SIGNAL_KINDS,
  dependentsCountedOf,
  findAnomalies,
  findSignals,
  payrollFiguresOf,
  pseudonymizeSheet,
  restoreAliases,
  type InboxReader,
  type PayrollSheetLine,
} from '@ludy/agent';
import { Decimal } from '@ludy/l10n-vn';
import type { HrCoworkerExplained, HrCoworkerFlagged, HrCoworkerPrepared, HrLineView, HrPayslip, HrRunSheet, HrRunSummary } from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface PayrollAi {
  reader: Pick<InboxReader, 'payrollPrepare' | 'payrollFlag' | 'payrollExplain'> | null;
  budget: DraftBudget;
  prepareBudget?: DraftBudget;
  flagBudget?: DraftBudget;
  explainBudget?: DraftBudget;
}

/** The owner/admin access check and the audited reads the coworker is built on, each run in the member's own authority. */
export interface PayrollReads {
  authorize?: () => Promise<unknown>;
  sheet(runId: string): Promise<HrRunSheet>;
  runs(legalEntityId: string): Promise<HrRunSummary[]>;
  payslip(lineId: string): Promise<HrPayslip>;
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
