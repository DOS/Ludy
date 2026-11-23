// SPDX-License-Identifier: AGPL-3.0-only
// The payroll declaration exports as a query and its audit command (issue #2533; payroll plan docs/plan/payroll.md §6.5, ADR-0046 point 7).
//
// `hr.payroll.declaration.get` builds one document (the D02-LT of a month, 05/KK-TNCN of a quarter, 05/QTT-TNCN or the certificate data of a year) in the requesting owner's or admin's own context:
// a sensitive query, so its audit row is committed before it reads. The figures come only from the lines of approved, frozen runs (a draft month is not in a declaration), summed as decimals by
// the builders of ./declarations.ts. The identity number, the tax code and the social insurance number are sealed under each person's key: they are opened here and nowhere else, one batch for the
// people who appear in the period, after the audit row; nothing decrypted reaches an audit fact or a log, and the result is returned to the caller and never stored. An erased person (their key
// is shredded) appears with the placeholder name and no identifier.
//
// `hr.payroll.declaration.export` is the audit row of a downloaded file: kind, period and a row count, never a name or an amount. The route writes it before it answers, so no row, no download.
//
// Never a silently cut file: more people than HR_DECLARATION_MAX_PEOPLE is refused with a message. Nothing is sent and nothing is filed.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { HR_DECLARATION_MAX_PEOPLE, zHrDeclarationExport, zHrDeclarationQuery, zHrLaborCheckAsk, zHrLaborCheckAudit, type HrDeclarationDocument, type HrDeclarationExport, type HrDeclarationQuery, type HrLaborCheckAsk, type HrLaborCheckAudit, type HrLaborCheckKind } from '@ludy/kernel-contract';
import { deriveFixedTermEndDate, formatIsoCalendarDate, money, parseIsoCalendarDate, type LaborContractKind, type ProbationRoleTier } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, hasFreshMfa, type QueryContext } from '@ludy/kernel-runtime';
import { buildAnnual, buildAnnualListing, buildCertificates, buildCertificatesListing, buildD02Lt, buildD02LtListing, buildQuarterly, buildQuarterlyListing, fallbackTaxCode, quarterMonths, type DeclarationBreakdown, type DeclarationContractTerm, type DeclarationContractType, type DeclarationLine, type DeclarationPerson } from './declarations.ts';
import { build01PliReport, buildLaborRegister, parse01PliPeriod, type LaborRegisterPerson } from './labor-register.ts';
import { IDENTITY_PLACE, INSURANCE_PLACE, TAX_CODE_PLACE, subjectOf } from './employees.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const APPROVED = ['approved', 'paid', 'closed'] as const;

export interface HrLaborCheckFact {
  employeeId: string;
  erased: boolean;
  endedOn: string | null;
  hasIdentityNumber: boolean;
  hasInsuranceNumber: boolean;
  hasBirthDate: boolean;
  hasAddress: boolean;
  contractKind: LaborContractKind | 'none';
  contractStartDate: string | null;
  contractEndDate: string | null;
  contractTermMonths: number | null;
  fixedTermSequence: number | null;
  probation?: {
    roleTier: ProbationRoleTier;
    startDate: string;
    endDate: string;
    wage: string | null;
  } | null;
  insured: boolean;
}

export interface HrLaborCheckSnapshot {
  kind: HrLaborCheckKind;
  period: string;
  asOf: string;
  employees: HrLaborCheckFact[];
  names: Array<{ employeeId: string; displayName: string }>;
  forbidden: string[];
}

const iso = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));
function formatLaborRegisterPosition(jobTitle: string | null | undefined, departmentName: string | null | undefined): string | null {
  const parts = [jobTitle, departmentName].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return parts.length > 0 ? parts.join(' - ') : null;
}
const previousMonth = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// The months a declaration reads: the month and the one before for the D02-LT (a change of wage is read against it), the quarter's three, or the year's twelve.
export function declarationMonths(kind: HrDeclarationQuery['kind'], period: string): string[] {
  if (kind === 'labor_register' || kind === '01pli') return [];
  if (kind === 'd02lt') return [period, previousMonth(period)];
  if (kind === 'kk') return quarterMonths(period);
  return Array.from({ length: 12 }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

// The stored breakdown as the builders read it. A line with no breakdown reads as none, and so does an adjustment whatever it holds: a correction keeps only the split of its insurance across the funds
// for its posting (#2532), not the tax and wage detail of a pay line, so it is read as one with no breakdown (its tax and taxable income are added, its assessable income is not, and the document says
// so). A pay line's breakdown the builders cannot read is a bug and surfaces.
function breakdownOf(raw: unknown, kind: string): DeclarationBreakdown | null {
  if (raw === null || raw === undefined || kind === 'adjustment') return null;
  const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeclarationBreakdown;
  return { insurance: { suspended: b.insurance.suspended, funds: b.insurance.funds.map((f) => ({ fund: f.fund, wage: f.wage, employee: f.employee, employer: f.employer })) }, tax: b.tax };
}

type LegalEntityRow = { id: string; name: string; tax_code: string | null; is_default: boolean };
type EmploymentRow = {
  id: string;
  employee_id: string;
  effective_from: Date | string;
  contract_type: string;
  base_wage: string | number;
  term_months?: number | null;
  contract_end_on?: Date | string | null;
  fixed_term_sequence?: number | null;
  probation_role_tier?: string | null;
  probation_end_on?: Date | string | null;
  probation_wage?: string | number | null;
};
type LineMeta = { allowance: string | null; otherAmounts: string | null; contractTermMonths: number | null; insured: boolean | null };
type PayMeta = { allowance: string | null; otherAmounts: string | null };
type EmploymentLineTerms = { contractTermMonths: number | null; insured: boolean | null };
type ProbationSnapshot = {
  roleTier: ProbationRoleTier;
  startDate: string;
  endDate: string;
  wage: string | null;
};
type EmploymentSnapshot = {
  startedOn: string;
  contractKind: LaborContractKind | 'none';
  contractStartDate: string | null;
  contractEndDate: string | null;
  hasSavedEndDate: boolean;
  contractDateUncertain: boolean;
  contractTermMonths: number | null;
  fixedTermSequence: number | null;
  probation: ProbationSnapshot | null;
  insured: boolean | null;
  baseWage: string;
};
type Clear = { identityNumber?: string; taxCode?: string; insuranceNumber?: string };
type SealedEmployeeRow = {
  id: string;
  erased_at: Date | string | null;
  national_id_sealed: string | null;
  tax_code_sealed: string | null;
  insurance_number_sealed: string | null;
};

async function resolveLegalEntity(ctx: QueryContext, legalEntityId?: string): Promise<LegalEntityRow> {
  const entity = legalEntityId
    ? await ctx.trx.selectFrom('ludy_kernel.legal_entity').select(['id', 'name', 'tax_code', 'is_default']).where('org_id', '=', ctx.orgId).where('id', '=', legalEntityId).executeTakeFirst()
    : await ctx.trx.selectFrom('ludy_kernel.legal_entity').select(['id', 'name', 'tax_code', 'is_default']).where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
  if (!entity) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân của bảng kê');
  return entity;
}

async function openSealedFor(
  ctx: Pick<QueryContext, 'openMany'>,
  employees: readonly SealedEmployeeRow[],
  who: ReadonlySet<string> | null,
  fields: readonly ('identityNumber' | 'taxCode' | 'insuranceNumber')[],
): Promise<Map<string, Clear>> {
  const places = { identityNumber: [IDENTITY_PLACE, 'national_id_sealed'], taxCode: [TAX_CODE_PLACE, 'tax_code_sealed'], insuranceNumber: [INSURANCE_PLACE, 'insurance_number_sealed'] } as const;
  const items: { sealed: string; place: string; ref: string }[] = [];
  const slots: { id: string; field: (typeof fields)[number] }[] = [];
  for (const e of employees) {
    if (e.erased_at !== null || (who !== null && !who.has(e.id))) continue;
    for (const field of fields) {
      const [place, column] = places[field];
      const sealed = e[column];
      if (sealed === null) continue;
      items.push({ sealed, place, ref: subjectOf(e.id) });
      slots.push({ id: e.id, field });
    }
  }
  // A value whose key is gone reads as none.
  const opened = items.length === 0 ? [] : await ctx.openMany(items);
  const clear = new Map<string, Clear>();
  slots.forEach((slot, i) => {
    const value = opened[i];
    if (typeof value === 'string') clear.set(slot.id, { ...clear.get(slot.id), [slot.field]: value });
  });
  return clear;
}

function laborCutoffAndWindow(kind: HrLaborCheckKind, period: string): { cutoff: string; windowStart: string | null } {
  if (kind === 'labor_register') return { cutoff: period, windowStart: null };
  const window = parse01PliPeriod(period);
  return { cutoff: window.endDate, windowStart: window.startDate };
}

function parseApprovedInputsMeta(raw: unknown): LineMeta {
  if (raw === null || raw === undefined) return { allowance: null, otherAmounts: null, contractTermMonths: null, insured: null };
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { allowance: null, otherAmounts: null, contractTermMonths: null, insured: null };
  }
  if (!parsed || typeof parsed !== 'object') return { allowance: null, otherAmounts: null, contractTermMonths: null, insured: null };
  const obj = parsed as { allowances?: unknown; otherRegularPay?: unknown; contractTermMonths?: unknown; insured?: unknown };
  let allowanceTotal = money('0');
  if (Array.isArray(obj.allowances)) {
    for (const item of obj.allowances) {
      if (item && typeof item === 'object' && 'amount' in item) {
        const rawAmount = (item as { amount?: unknown }).amount;
        if (typeof rawAmount === 'string' || typeof rawAmount === 'number') {
          try {
            allowanceTotal = allowanceTotal.plus(money(String(rawAmount)));
          } catch {
            // Skip malformed legacy item instead of failing valid employees.
          }
        }
      }
    }
  }
  let otherAmounts: string | null = null;
  if (typeof obj.otherRegularPay === 'string' || typeof obj.otherRegularPay === 'number') {
    try {
      const parsedOther = money(String(obj.otherRegularPay));
      if (parsedOther.greaterThan(0)) otherAmounts = parsedOther.toFixed();
    } catch {
      // Skip malformed legacy item instead of failing valid employees.
    }
  }
  const term = obj.contractTermMonths;
  const contractTermMonths = typeof term === 'number' && Number.isInteger(term) && term >= 1 && term <= 36 ? term : null;
  const insured = typeof obj.insured === 'boolean' ? obj.insured : null;
  return {
    allowance: allowanceTotal.greaterThan(0) ? allowanceTotal.toFixed() : null,
    otherAmounts,
    contractTermMonths,
    insured,
  };
}

async function loadApprovedLineFacts(
  ctx: QueryContext,
  entityId: string,
  employeeIds: readonly string[],
  cutoffMonth: string,
  maxMonthByEmployee: ReadonlyMap<string, string>,
  eligibleEmploymentIds: ReadonlySet<string>,
  disallowedNullMonthsByEmployee: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{
  payMetaByEmployee: Map<string, PayMeta>;
  termsByEmployment: Map<string, EmploymentLineTerms>;
}> {
  const payMetaByEmployee = new Map<string, PayMeta>();
  const termsByEmployment = new Map<string, EmploymentLineTerms>();
  if (employeeIds.length === 0) return { payMetaByEmployee, termsByEmployment };
  const runs = await ctx.trx
    .selectFrom('ludy_hr.payroll_run')
    .select(['id', 'month'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entityId)
    .where('status', 'in', [...APPROVED])
    .where('month', '<=', cutoffMonth)
    .orderBy('month', 'desc')
    .execute();
  if (runs.length === 0) return { payMetaByEmployee, termsByEmployment };
  const monthByRun = new Map(runs.map((r) => [r.id, r.month]));
  const lines = await ctx.trx
    .selectFrom('ludy_hr.payroll_line')
    .select(['run_id', 'employee_id', 'employment_id', 'inputs'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entityId)
    .where('run_id', 'in', runs.map((r) => r.id))
    .where('employee_id', 'in', [...employeeIds])
    .where('kind', '=', 'pay')
    .where('status', '=', 'calculated')
    .execute();
  const bestEmployeeMonth = new Map<string, string>();
  const bestEmploymentMonth = new Map<string, string>();
  for (const line of lines) {
    const month = monthByRun.get(line.run_id);
    if (!month) continue;
    const maxMonth = maxMonthByEmployee.get(line.employee_id) ?? cutoffMonth;
    if (month > maxMonth) continue;
    // Never attribute pay metadata or contract terms from an employment row whose `effective_from` lies after the employee's cutoff date.
    if (line.employment_id !== null) {
      if (!eligibleEmploymentIds.has(line.employment_id)) continue;
    } else if (disallowedNullMonthsByEmployee.get(line.employee_id)?.has(month)) {
      continue;
    }
    const meta = parseApprovedInputsMeta(line.inputs);
    const prevEmpMonth = bestEmployeeMonth.get(line.employee_id);
    if (prevEmpMonth === undefined || month > prevEmpMonth) {
      bestEmployeeMonth.set(line.employee_id, month);
      payMetaByEmployee.set(line.employee_id, {
        allowance: meta.allowance,
        otherAmounts: meta.otherAmounts,
      });
    }
    if (line.employment_id) {
      const prevRowMonth = bestEmploymentMonth.get(line.employment_id);
      if (prevRowMonth === undefined || month > prevRowMonth) {
        bestEmploymentMonth.set(line.employment_id, month);
        termsByEmployment.set(line.employment_id, {
          contractTermMonths: meta.contractTermMonths,
          insured: meta.insured,
        });
      }
    }
  }
  return { payMetaByEmployee, termsByEmployment };
}

function deriveFixedEndIso(startDate: string, termMonths: number): string | null {
  const parsed = parseIsoCalendarDate(startDate);
  return parsed ? formatIsoCalendarDate(deriveFixedTermEndDate(parsed, termMonths)) : null;
}

function resolveFixedTermMetadata(
  startDate: string,
  savedTermMonths: number | null,
  savedEndOn: string | null,
  lineTermMonths: number | null | undefined,
): { contractTermMonths: number | null; contractEndDate: string | null } {
  const contractTermMonths = savedTermMonths ?? (savedEndOn !== null ? null : (lineTermMonths ?? null));
  const contractEndDate = savedEndOn ?? (contractTermMonths !== null ? deriveFixedEndIso(startDate, contractTermMonths) : null);
  return { contractTermMonths, contractEndDate };
}

function probationFromRow(row: EmploymentRow, eff: string): ProbationSnapshot | null {
  if (row.probation_end_on === undefined || row.probation_end_on === null) return null;
  return {
    roleTier: (row.probation_role_tier ?? 'other') as ProbationRoleTier,
    startDate: eff,
    endDate: iso(row.probation_end_on),
    wage: row.probation_wage !== undefined && row.probation_wage !== null ? String(row.probation_wage) : null,
  };
}

function resolveEmploymentHistoryByCutoff(
  rows: readonly EmploymentRow[],
  cutoff: string,
  termsByEmployment: ReadonlyMap<string, EmploymentLineTerms>,
  effectiveCutoffByEmployee: ReadonlyMap<string, string>,
): Map<string, EmploymentSnapshot> {
  const byEmployee = new Map<string, EmploymentSnapshot & { fixedTermCount: number | null }>();
  for (const row of rows) {
    const eff = iso(row.effective_from);
    const empCutoff = effectiveCutoffByEmployee.get(row.employee_id) ?? cutoff;
    if (eff > empCutoff) continue;
    const prev = byEmployee.get(row.employee_id);
    const contractKind = row.contract_type as LaborContractKind | 'none';
    const rowTerms = termsByEmployment.get(row.id);
    const savedTermMonths = row.term_months ?? null;
    const savedEndOn = row.contract_end_on !== undefined && row.contract_end_on !== null ? iso(row.contract_end_on) : null;
    const savedSequence = row.fixed_term_sequence ?? null;
    const rowProbation = probationFromRow(row, eff);

    let contractStartDate: string | null;
    let contractEndDate: string | null = null;
    let hasSavedEndDate = savedEndOn !== null;
    let contractDateUncertain = false;
    let contractTermMonths: number | null;
    let fixedTermCount: number | null;
    let fixedTermSequence: number | null;
    let probation: ProbationSnapshot | null;
    let insured: boolean | null;

    if (contractKind === 'none') {
      const isAmendment = prev?.contractKind === 'none';
      contractStartDate = null;
      contractEndDate =
        savedEndOn !== null
          ? savedEndOn
          : isAmendment && prev.contractEndDate !== null && eff <= prev.contractEndDate
            ? prev.contractEndDate
            : null;
      contractTermMonths = null;
      fixedTermCount = prev ? prev.fixedTermCount : 0;
      fixedTermSequence = null;
      probation = isAmendment && (prev.contractEndDate === null || eff <= prev.contractEndDate) ? (rowProbation ?? prev.probation) : rowProbation;
      insured = rowTerms !== undefined ? rowTerms.insured : isAmendment ? prev.insured : null;
    } else if (!prev || prev.contractKind !== contractKind) {
      contractStartDate = eff;
      if (contractKind === 'indefinite') {
        contractTermMonths = null;
        contractEndDate = null;
        hasSavedEndDate = false;
        fixedTermCount = 0;
        fixedTermSequence = null;
      } else {
        ({ contractTermMonths, contractEndDate } = resolveFixedTermMetadata(eff, savedTermMonths, savedEndOn, rowTerms?.contractTermMonths));
        fixedTermCount = savedSequence ?? (prev ? (prev.fixedTermCount === null ? null : prev.fixedTermCount + 1) : 1);
        fixedTermSequence = fixedTermCount;
      }
      probation = rowProbation;
      insured = rowTerms !== undefined ? rowTerms.insured : null;
    } else if (contractKind === 'indefinite') {
      // An indefinite contract never expires or renews; subsequent indefinite rows are wage/region amendments.
      // Preserve initial probation unless explicitly updated on the amendment, and let approved pay lines override `insured`.
      contractStartDate = prev.contractStartDate;
      contractTermMonths = null;
      contractEndDate = null;
      hasSavedEndDate = false;
      fixedTermCount = 0;
      fixedTermSequence = null;
      probation = rowProbation ?? prev.probation;
      insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
    } else {
      const hasRowTermOrDifferentEnd = savedTermMonths !== null || (savedEndOn !== null && savedEndOn !== prev.contractEndDate);
      const explicitNewFixedTerm =
        savedSequence !== null &&
        ((prev.fixedTermCount !== null && savedSequence !== prev.fixedTermCount) ||
          (prev.contractDateUncertain && (savedTermMonths !== null || savedEndOn !== null)));
      if (!explicitNewFixedTerm && (prev.contractDateUncertain || prev.contractStartDate === null || prev.contractEndDate === null)) {
        // Prior `fixed_term` row lacked stored contract end metadata or an approved term, so renewal vs mid-term raise cannot be verified unless `fixed_term_sequence` marks a new contract.
        contractStartDate = null;
        contractDateUncertain = true;
        contractTermMonths = null;
        contractEndDate = null;
        hasSavedEndDate = false;
        fixedTermCount = null;
        fixedTermSequence = null;
        probation = rowProbation ?? (!hasRowTermOrDifferentEnd ? prev.probation : null);
        insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
      } else if (
        !explicitNewFixedTerm &&
        !hasRowTermOrDifferentEnd &&
        !prev.contractDateUncertain &&
        prev.contractStartDate !== null &&
        prev.contractEndDate !== null &&
        eff <= prev.contractEndDate
      ) {
        // Mid-term amendment of the active fixed-term contract (no new duration or changed end date anchored at `eff`).
        contractStartDate = prev.contractStartDate;
        if (prev.hasSavedEndDate) {
          contractTermMonths = prev.contractTermMonths;
          contractEndDate = prev.contractEndDate;
          hasSavedEndDate = true;
        } else {
          contractTermMonths = rowTerms?.contractTermMonths ?? prev.contractTermMonths;
          contractEndDate = contractTermMonths !== null ? deriveFixedEndIso(prev.contractStartDate, contractTermMonths) : prev.contractEndDate;
          hasSavedEndDate = false;
        }
        fixedTermCount = savedSequence ?? prev.fixedTermCount;
        fixedTermSequence = fixedTermCount;
        probation = rowProbation ?? prev.probation;
        insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
      } else {
        // Either prior term ended before `eff`, `fixed_term_sequence` explicitly changed, or this row saves its own `(term_months, contract_end_on)` anchored at `eff`: keep the pair bound to `eff` and increment only when starting a new sequence.
        contractStartDate = eff;
        ({ contractTermMonths, contractEndDate } = resolveFixedTermMetadata(eff, savedTermMonths, savedEndOn, rowTerms?.contractTermMonths));
        fixedTermCount = savedSequence ?? (prev.fixedTermCount === null ? null : prev.fixedTermCount + 1);
        fixedTermSequence = fixedTermCount;
        probation = rowProbation;
        insured = rowTerms !== undefined ? rowTerms.insured : null;
      }
    }

    byEmployee.set(row.employee_id, {
      startedOn: prev ? prev.startedOn : eff,
      contractKind,
      contractStartDate,
      contractEndDate,
      hasSavedEndDate,
      contractDateUncertain,
      contractTermMonths,
      fixedTermCount,
      fixedTermSequence,
      probation,
      insured,
      baseWage: String(row.base_wage),
    });
  }
  return byEmployee;
}

async function loadLaborCandidateEmployees(ctx: QueryContext, entityId: string): Promise<EmploymentRow[]> {
  return ctx.trx
    .selectFrom('ludy_hr.payroll_employment')
    .select([
      'id',
      'employee_id',
      'effective_from',
      'contract_type',
      'base_wage',
      'term_months',
      'contract_end_on',
      'fixed_term_sequence',
      'probation_role_tier',
      'probation_end_on',
      'probation_wage',
    ])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entityId)
    .orderBy('effective_from', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

function summarizeIncludedEmploymentStarts(
  rows: readonly EmploymentRow[],
  cutoff: string,
  effectiveCutoffByEmployee: ReadonlyMap<string, string>,
): Map<string, string> {
  const startedByEmployee = new Map<string, string>();
  for (const row of rows) {
    const eff = iso(row.effective_from);
    const empCutoff = effectiveCutoffByEmployee.get(row.employee_id) ?? cutoff;
    if (eff <= empCutoff && !startedByEmployee.has(row.employee_id)) startedByEmployee.set(row.employee_id, eff);
  }
  return startedByEmployee;
}

function isIncludedEmployee(
  kind: HrLaborCheckKind,
  endedOnRaw: Date | string | null,
  startedByEmployee: ReadonlyMap<string, string>,
  employeeId: string,
  cutoff: string,
  windowStart: string | null,
): string | null | undefined {
  if (!startedByEmployee.has(employeeId)) return undefined;
  const rawEnded = endedOnRaw === null ? null : iso(endedOnRaw);
  if (kind === '01pli' && rawEnded !== null && windowStart !== null && rawEnded < windowStart) return undefined;
  return rawEnded !== null && rawEnded <= cutoff ? rawEnded : null;
}

async function prepareLaborPeriod<Row extends { id: string; ended_on: Date | string | null }>(
  ctx: QueryContext,
  entityId: string,
  kind: HrLaborCheckKind,
  period: string,
  rows: readonly Row[],
  tooLargeMessage: string,
): Promise<{
  cutoff: string;
  included: Array<{ row: Row; endedOn: string | null }>;
  payMetaByEmployee: Map<string, PayMeta>;
  employments: Map<string, EmploymentSnapshot>;
}> {
  const { cutoff, windowStart } = laborCutoffAndWindow(kind, period);
  const employmentRows = await loadLaborCandidateEmployees(ctx, entityId);
  const effectiveCutoffByEmployee = new Map<string, string>();
  for (const row of rows) {
    const rawEnded = row.ended_on === null ? null : iso(row.ended_on);
    // Cap each person's employment and pay history at min(cutoff, ended_on) so future scheduled changes after leaving never appear.
    effectiveCutoffByEmployee.set(row.id, rawEnded !== null && rawEnded < cutoff ? rawEnded : cutoff);
  }
  const startedByEmployee = summarizeIncludedEmploymentStarts(employmentRows, cutoff, effectiveCutoffByEmployee);
  const included: Array<{ row: Row; endedOn: string | null }> = [];
  for (const row of rows) {
    const endedOn = isIncludedEmployee(kind, row.ended_on, startedByEmployee, row.id, cutoff, windowStart);
    if (endedOn !== undefined) included.push({ row, endedOn });
  }
  if (included.length > HR_DECLARATION_MAX_PEOPLE) {
    throw new DomainError('EXPORT_TOO_LARGE', 422, tooLargeMessage);
  }
  const includedIds = included.map((entry) => entry.row.id);
  const includedIdSet = new Set(includedIds);
  const eligibleEmploymentIds = new Set<string>();
  const disallowedNullMonthsByEmployee = new Map<string, Set<string>>();
  for (const empRow of employmentRows) {
    if (!includedIdSet.has(empRow.employee_id)) continue;
    const eff = iso(empRow.effective_from);
    const empCutoff = effectiveCutoffByEmployee.get(empRow.employee_id) ?? cutoff;
    if (eff <= empCutoff) {
      eligibleEmploymentIds.add(empRow.id);
    } else {
      let months = disallowedNullMonthsByEmployee.get(empRow.employee_id);
      if (!months) {
        months = new Set<string>();
        disallowedNullMonthsByEmployee.set(empRow.employee_id, months);
      }
      months.add(eff.slice(0, 7));
    }
  }
  const maxMonthByEmployee = new Map(includedIds.map((id) => [id, (effectiveCutoffByEmployee.get(id) ?? cutoff).slice(0, 7)]));
  const { payMetaByEmployee, termsByEmployment } = await loadApprovedLineFacts(
    ctx,
    entityId,
    includedIds,
    cutoff.slice(0, 7),
    maxMonthByEmployee,
    eligibleEmploymentIds,
    disallowedNullMonthsByEmployee,
  );
  const employments = resolveEmploymentHistoryByCutoff(employmentRows, cutoff, termsByEmployment, effectiveCutoffByEmployee);
  return { cutoff, included, payMetaByEmployee, employments };
}

// QueryDef.auditDetail values must satisfy TARGET_TYPE (`^[a-z][a-z0-9_.]{0,63}$`), so `'01pli'` maps to `'pli_01'`.
const auditKindOf = (kind: string): string => (kind === '01pli' ? 'pli_01' : kind);

export const declarationGet = defineQuery({
  name: 'hr.payroll.declaration.get',
  input: zHrDeclarationQuery,
  access: MANAGERS,
  sensitive: true,
  // The kind names what is read (a name of fixed shape), so the audit row of the read says which form it was before a value is opened.
  auditDetail: (input) => ({ kind: auditKindOf(input.kind) }),
  handler: async (ctx, input): Promise<HrDeclarationDocument> => {
    // Bulk decryption of staff identifiers needs a second factor used within the last 5 minutes (policy P11), as an R3 command does; the app's StepUpPrompt answers STEP_UP_REQUIRED. Checked
    // before anything is read or opened, and for every caller (the download route and the screen's read).
    if (ctx.actor.type !== 'user' || !hasFreshMfa(ctx.actor)) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const tenantAddress = entity.is_default
      ? ((await ctx.trx.selectFrom('ludy_kernel.tenant').select('address').where('org_id', '=', ctx.orgId).executeTakeFirst())?.address ?? null)
      : null;
    const employer = { name: entity.name, taxCode: entity.tax_code, address: tenantAddress };

    if (input.kind === 'labor_register' || input.kind === '01pli') {
      const rows = await ctx.trx
        .selectFrom('ludy_hr.payroll_employee as e')
        .leftJoin('ludy_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
        .select([
          'e.id',
          'e.display_name',
          'e.address',
          'e.birth_date',
          'e.job_title',
          'd.name as department_name',
          'e.ended_on',
          'e.erased_at',
          'e.national_id_sealed',
          'e.tax_code_sealed',
          'e.insurance_number_sealed',
        ])
        .where('e.org_id', '=', ctx.orgId)
        .where('e.legal_entity_id', '=', entity.id)
        .execute();
      const { included, payMetaByEmployee, employments } = await prepareLaborPeriod(
        ctx,
        entity.id,
        input.kind,
        input.period,
        rows,
        `Có hơn ${HR_DECLARATION_MAX_PEOPLE} người trong bảng kê này; không xuất được một lần`,
      );
      const clear = await openSealedFor(
        ctx,
        included.map((entry) => entry.row),
        null,
        input.kind === 'labor_register' ? ['identityNumber', 'taxCode', 'insuranceNumber'] : ['identityNumber', 'insuranceNumber'],
      );
      const persons: LaborRegisterPerson[] = included.map(({ row, endedOn }) => {
        const c = clear.get(row.id) ?? {};
        const terms = employments.get(row.id)!;
        const payMeta = payMetaByEmployee.get(row.id);
        const contractEndDate = terms.contractDateUncertain ? null : terms.contractEndDate;
        const erased = row.erased_at !== null;
        return {
          employeeId: row.id,
          name: row.display_name,
          erased,
          birthDate: !erased && row.birth_date !== null ? iso(row.birth_date) : null,
          address: !erased ? row.address : null,
          position: erased ? null : formatLaborRegisterPosition(row.job_title, row.department_name),
          identityNumber: c.identityNumber ?? null,
          taxCode: c.taxCode ?? null,
          insuranceNumber: c.insuranceNumber ?? null,
          startedOn: terms.startedOn,
          endedOn,
          contractKind: terms.contractKind,
          contractStartDate: terms.contractStartDate,
          contractDateUncertain: terms.contractDateUncertain,
          contractEndDate,
          baseWage: terms.baseWage,
          allowance: payMeta?.allowance ?? null,
          otherAmounts: payMeta?.otherAmounts ?? null,
          insured: terms.insured ?? (terms.contractKind !== 'none'),
          ...(terms.contractDateUncertain && !erased
            ? { note: 'Chưa đủ kỳ lương đã duyệt để xác định ngày bắt đầu/kết thúc hợp đồng xác định thời hạn.' }
            : {}),
        };
      });
      const document = input.kind === 'labor_register'
        ? buildLaborRegister({ employer, persons, asOf: input.period })
        : build01PliReport({ period: input.period, employer, persons });
      return { ...document, used: { months: [] } };
    }

    const months = declarationMonths(input.kind, input.period);
    const runs = await ctx.trx
      .selectFrom('ludy_hr.payroll_run')
      .select(['id', 'month'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity.id)
      .where('status', 'in', [...APPROVED])
      .where('month', 'in', months)
      .execute();
    const monthOfRun = new Map(runs.map((r) => [r.id, r.month]));
    const approvedMonths = [...new Set(runs.map((r) => r.month))].sort();
    const rows = runs.length === 0
      ? []
      : await ctx.trx
          .selectFrom('ludy_hr.payroll_line')
          .select(['run_id', 'employee_id', 'kind', 'adjusts_run_id', 'gross', 'employee_insurance', 'employer_insurance', 'union_fee', 'taxable_income', 'pit', 'breakdown'])
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', entity.id)
          .where('run_id', 'in', [...monthOfRun.keys()])
          .where('status', '=', 'calculated')
          .execute();
    // The pay month an adjustment line corrects (its run may lie outside the period read), so a correction is grouped by that month's withholding mode.
    const adjustedIds = [...new Set(rows.flatMap((r) => (r.adjusts_run_id ? [r.adjusts_run_id] : [])))];
    const adjustedMonths = new Map<string, string>();
    if (adjustedIds.length > 0) {
      const adjusted = await ctx.trx.selectFrom('ludy_hr.payroll_run').select(['id', 'month']).where('org_id', '=', ctx.orgId).where('id', 'in', adjustedIds).execute();
      for (const r of adjusted) adjustedMonths.set(r.id, r.month);
    }
    const lines: DeclarationLine[] = rows.map((r) => ({
      month: monthOfRun.get(r.run_id) as string,
      employeeId: r.employee_id,
      kind: r.kind as 'pay' | 'adjustment',
      gross: r.gross as string,
      employeeInsurance: r.employee_insurance as string,
      employerInsurance: r.employer_insurance as string,
      unionFee: r.union_fee as string,
      taxableIncome: r.taxable_income as string,
      pit: r.pit as string,
      breakdown: breakdownOf(r.breakdown, r.kind),
      adjustsMonth: r.adjusts_run_id ? (adjustedMonths.get(r.adjusts_run_id) ?? null) : null,
    }));
    const ids = [...new Set(lines.map((l) => l.employeeId))];
    if (ids.length > HR_DECLARATION_MAX_PEOPLE) {
      throw new DomainError('EXPORT_TOO_LARGE', 422, `Có hơn ${HR_DECLARATION_MAX_PEOPLE} người trong bảng kê này; không xuất được một lần`);
    }
    const employees = ids.length === 0
      ? []
      : await ctx.trx
          .selectFrom('ludy_hr.payroll_employee as e')
          .leftJoin('ludy_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
          .select([
            'e.id',
            'e.display_name',
            'e.birth_date',
            'e.job_title',
            'd.name as department_name',
            'e.ended_on',
            'e.erased_at',
            'e.national_id_sealed',
            'e.tax_code_sealed',
            'e.insurance_number_sealed',
            'e.finalization_authorized_years',
          ])
          .where('e.org_id', '=', ctx.orgId)
          .where('e.legal_entity_id', '=', entity.id)
          .where('e.id', 'in', ids)
          .execute();
    if (employees.length !== ids.length) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 409, 'Một dòng lương nêu một nhân viên không còn trong danh sách');
    const employmentRows = ids.length === 0
      ? []
      : await ctx.trx
          .selectFrom('ludy_hr.payroll_employment')
          .select(['employee_id', 'effective_from', 'contract_type'])
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', entity.id)
          .where('employee_id', 'in', ids)
          .orderBy('effective_from', 'asc')
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();
    const startedOn = new Map<string, string>();
    const contractsByEmployee = new Map<string, DeclarationContractTerm[]>();
    for (const row of employmentRows) {
      const eff = iso(row.effective_from);
      if (!startedOn.has(row.employee_id)) startedOn.set(row.employee_id, eff);
      const list = contractsByEmployee.get(row.employee_id) ?? [];
      list.push({ effectiveFrom: eff, contractType: row.contract_type as DeclarationContractType });
      contractsByEmployee.set(row.employee_id, list);
    }

    // What a form prints is all that is opened (the sealed values of a person are opened only when the form shows them): the D02-LT shows the identity number and the social insurance number, and
    // only of the people it lists (a change that month, worked out first from data that is not sealed); the tax forms show the identity number and the tax code. One batch, after the audit row.
    const personsOf = (clear: ReadonlyMap<string, Clear>): DeclarationPerson[] =>
      employees.map((e) => {
        const c = clear.get(e.id) ?? {};
        const erased = e.erased_at !== null;
        // Since 2025-07-01 the tax code is in most cases the identity number: a person with no tax code of their own is listed under the identity number, and the document says so.
        return {
          employeeId: e.id,
          name: e.display_name,
          birthDate: !erased && e.birth_date !== null ? iso(e.birth_date) : null,
          taxCode: c.taxCode ?? fallbackTaxCode(c.identityNumber),
          insuranceNumber: c.insuranceNumber ?? null,
          identityNumber: c.identityNumber ?? null,
          position: erased ? null : (e.job_title ?? null),
          workplace: erased ? null : (e.department_name ?? null),
          contracts: erased ? [] : (contractsByEmployee.get(e.id) ?? []),
          startedOn: startedOn.get(e.id) ?? '1900-01-01',
          endedOn: e.ended_on === null ? null : iso(e.ended_on),
          finalizationAuthorizedYears: [...e.finalization_authorized_years],
        };
      });
    const d02Input = (persons: DeclarationPerson[]) => {
      const previous = months[1] as string;
      const previousLines = approvedMonths.includes(previous) ? lines.filter((l) => l.month === previous && l.kind === 'pay') : null;
      return { month: input.period, employer, persons, lines: lines.filter((l) => l.month === input.period), previousLines, approvedMonths };
    };
    let document: Omit<HrDeclarationDocument, 'used'>;
    let persons: DeclarationPerson[];
    let taxCodeFromIdentity = 0;
    if (input.kind === 'd02lt') {
      const { listed } = buildD02LtListing(d02Input(personsOf(new Map())));
      persons = personsOf(await openSealedFor(ctx, employees, listed, ['identityNumber', 'insuranceNumber']));
      document = buildD02Lt(d02Input(persons));
    } else {
      // Each form opens only what it prints, worked out first from data that is not sealed. 05/KK prints the people its schedules list (not those counted in the headcount only), 05/QTT the
      // authorizers who qualify, 03/TNCN the people it certifies (tax code and identity number) and, on its second sheet, the tax code of the authorizers. A person with no tax code of their own is
      // printed under the identity number, so the identity number of such a person is opened too, after the tax codes are known.
      const blank = personsOf(new Map());
      let identityFor: ReadonlySet<string>;
      let taxCodeFor: ReadonlySet<string>;
      if (input.kind === 'kk') {
        identityFor = taxCodeFor = buildQuarterlyListing({ quarter: input.period, employer, persons: blank, lines, approvedMonths }).printed;
      } else if (input.kind === 'qtt') {
        identityFor = taxCodeFor = buildAnnualListing({ year: Number(input.period), employer, persons: blank, lines, approvedMonths }).printed;
      } else {
        const listing = buildCertificatesListing({ year: Number(input.period), employer, persons: blank, lines, approvedMonths });
        identityFor = listing.certified;
        taxCodeFor = new Set([...listing.certified, ...listing.authorizers]);
      }
      const clear = await openSealedFor(ctx, employees, taxCodeFor, ['taxCode']);
      const needsIdentity = new Set([...identityFor, ...[...taxCodeFor].filter((id) => clear.get(id)?.taxCode === undefined)]);
      for (const [id, c] of await openSealedFor(ctx, employees, needsIdentity, ['identityNumber'])) clear.set(id, { ...clear.get(id), ...c });
      for (const c of clear.values()) if (c.taxCode === undefined && fallbackTaxCode(c.identityNumber) !== null) taxCodeFromIdentity += 1;
      persons = personsOf(clear);
      if (input.kind === 'kk') document = buildQuarterly({ quarter: input.period, employer, persons, lines, approvedMonths });
      else if (input.kind === 'qtt') document = buildAnnual({ year: Number(input.period), employer, persons, lines, approvedMonths });
      else document = buildCertificates({ year: Number(input.period), employer, persons, lines, approvedMonths });
    }
    if (taxCodeFromIdentity > 0) document.notes.push(`${taxCodeFromIdentity} người chưa có mã số thuế riêng trong hồ sơ nên cột mã số thuế lấy số định danh cá nhân (từ 2025-07-01 hai số này thường trùng nhau): kiểm tra lại.`);
    if (employer.taxCode === null) document.notes.push('Đơn vị chưa có mã số thuế trong hồ sơ pháp nhân.');
    // What the list used: the approved months it read (the D02-LT also reads the month before, to tell a change of wage) and, for the annual lists, the authorization list of the year.
    const annual = input.kind === 'qtt' || input.kind === 'certificate';
    const authorizedYear = annual ? Number(input.period) : undefined;
    const authorizedPeople = authorizedYear === undefined ? undefined : persons.filter((p) => p.finalizationAuthorizedYears.includes(authorizedYear)).length;
    document.header.push({ label: 'Bảng lương đã duyệt được dùng', value: approvedMonths.join(', ') || 'không có' });
    if (authorizedYear !== undefined) document.header.push({ label: `Danh sách ủy quyền quyết toán năm ${authorizedYear}`, value: `${authorizedPeople} người trong bảng kê` });
    return { ...document, used: { months: approvedMonths, ...(authorizedYear === undefined ? {} : { authorizedYear, authorizedPeople }) } };
  },
});

export const laborCheckRead = defineQuery({
  name: 'hr.payroll.labor_check.read',
  input: zHrLaborCheckAsk,
  access: MANAGERS,
  sensitive: true,
  auditDetail: (input) => ({ kind: auditKindOf(input.kind) }),
  handler: async (ctx, input: HrLaborCheckAsk): Promise<HrLaborCheckSnapshot> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('ludy_hr.payroll_employee as e')
      .leftJoin('ludy_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
      .select([
        'e.id',
        'e.display_name',
        'e.address',
        'e.birth_date',
        'e.job_title',
        'd.name as department_name',
        'e.ended_on',
        'e.erased_at',
        sql<boolean>`e.national_id_sealed IS NOT NULL`.as('has_national_id'),
        sql<boolean>`e.insurance_number_sealed IS NOT NULL`.as('has_insurance_number'),
      ])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.legal_entity_id', '=', entity.id)
      .execute();
    const { cutoff, included, employments } = await prepareLaborPeriod(
      ctx,
      entity.id,
      input.kind,
      input.period,
      rows,
      `Có hơn ${HR_DECLARATION_MAX_PEOPLE} người trong bảng kê này; không kiểm tra được một lần`,
    );
    const forbidden = new Set<string>();
    const names: Array<{ employeeId: string; displayName: string }> = [];
    if (entity.name.trim() !== '') forbidden.add(entity.name);
    const employees: HrLaborCheckFact[] = included.map(({ row, endedOn }) => {
      const terms = employments.get(row.id)!;
      const erased = row.erased_at !== null;
      if (!erased) {
        if (row.display_name.trim() !== '') {
          forbidden.add(row.display_name);
          names.push({ employeeId: row.id, displayName: row.display_name });
        }
        if (row.address && row.address.trim() !== '') forbidden.add(row.address);
        if (row.job_title && row.job_title.trim() !== '') forbidden.add(row.job_title);
        if (row.department_name && row.department_name.trim() !== '') forbidden.add(row.department_name);
      }
      return {
        employeeId: row.id,
        erased,
        endedOn,
        hasIdentityNumber: !erased && row.has_national_id === true,
        hasInsuranceNumber: !erased && row.has_insurance_number === true,
        hasBirthDate: !erased && row.birth_date !== null,
        hasAddress: !erased && typeof row.address === 'string' && row.address.trim() !== '',
        contractKind: terms.contractKind,
        contractStartDate: terms.contractStartDate,
        contractEndDate: terms.contractDateUncertain ? null : terms.contractEndDate,
        contractTermMonths: terms.contractTermMonths,
        fixedTermSequence: terms.fixedTermSequence,
        probation: terms.probation,
        insured: terms.insured ?? (terms.contractKind !== 'none'),
      };
    });
    return {
      kind: input.kind,
      period: input.period,
      asOf: cutoff,
      employees,
      names,
      forbidden: [...forbidden],
    };
  },
});

export const laborCheckAudit = defineCommand({
  name: 'hr.payroll.labor_check.audit',
  input: zHrLaborCheckAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  handler: async (ctx, input: HrLaborCheckAudit): Promise<{ checked: number }> => {
    ctx.audit({ kind: input.kind, checked: input.checked });
    return { checked: input.checked };
  },
});

export const declarationExport = defineCommand({
  name: 'hr.payroll.declaration.export',
  input: zHrDeclarationExport,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  handler: async (ctx, input: HrDeclarationExport): Promise<{ rows: number }> => {
    ctx.audit({
      kind: input.kind,
      period: input.period,
      rows: input.rows,
      via: input.via,
      months: input.months,
      ...(input.authorizedYear === undefined ? {} : { authorizedYear: input.authorizedYear, authorizedPeople: input.authorizedPeople ?? 0 }),
      ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
    });
    return { rows: input.rows };
  },
});

export const hrDeclarationCommands = [declarationExport, laborCheckAudit];
export const hrDeclarationQueries = [declarationGet, laborCheckRead];
