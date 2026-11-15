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
import type { MemberRole } from '@crove/db';
import { HR_DECLARATION_MAX_PEOPLE, zHrDeclarationExport, zHrDeclarationQuery, zHrLaborCheckAsk, zHrLaborCheckAudit, type HrDeclarationDocument, type HrDeclarationExport, type HrDeclarationQuery, type HrLaborCheckAsk, type HrLaborCheckAudit, type HrLaborCheckKind } from '@crove/kernel-contract';
import { deriveFixedTermEndDate, formatIsoCalendarDate, money, parseIsoCalendarDate, type LaborContractKind } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery, hasFreshMfa, type QueryContext } from '@crove/kernel-runtime';
import { buildAnnual, buildAnnualListing, buildCertificates, buildCertificatesListing, buildD02Lt, buildD02LtListing, buildQuarterly, buildQuarterlyListing, quarterMonths, type DeclarationBreakdown, type DeclarationLine, type DeclarationPerson } from './declarations.ts';
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
  contractTermMonths: number | null;
  fixedTermSequence: number | null;
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

type LegalEntityRow = { id: string; name: string; tax_code: string | null };
type EmploymentRow = {
  id: string;
  employee_id: string;
  effective_from: Date | string;
  contract_type: string;
  base_wage: string | number;
};
type LineMeta = { allowance: string | null; otherAmounts: string | null; contractTermMonths: number | null; insured: boolean | null };
type PayMeta = { allowance: string | null; otherAmounts: string | null };
type EmploymentLineTerms = { contractTermMonths: number | null; insured: boolean | null };
type EmploymentSnapshot = {
  startedOn: string;
  contractKind: LaborContractKind | 'none';
  contractStartDate: string | null;
  contractDateUncertain: boolean;
  contractTermMonths: number | null;
  fixedTermSequence: number | null;
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
    ? await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', legalEntityId).executeTakeFirst()
    : await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
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
): Promise<{
  payMetaByEmployee: Map<string, PayMeta>;
  termsByEmployment: Map<string, EmploymentLineTerms>;
}> {
  const payMetaByEmployee = new Map<string, PayMeta>();
  const termsByEmployment = new Map<string, EmploymentLineTerms>();
  if (employeeIds.length === 0) return { payMetaByEmployee, termsByEmployment };
  const runs = await ctx.trx
    .selectFrom('crove_hr.payroll_run')
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
    .selectFrom('crove_hr.payroll_line')
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

    let contractStartDate: string | null;
    let contractDateUncertain = false;
    let contractTermMonths: number | null;
    let fixedTermCount: number | null;
    let fixedTermSequence: number | null;
    let insured: boolean | null;

    if (contractKind === 'none') {
      contractStartDate = null;
      contractTermMonths = null;
      fixedTermCount = prev ? prev.fixedTermCount : 0;
      fixedTermSequence = null;
      insured = rowTerms !== undefined ? rowTerms.insured : prev?.contractKind === 'none' ? prev.insured : null;
    } else if (!prev || prev.contractKind !== contractKind) {
      contractStartDate = eff;
      if (contractKind === 'indefinite') {
        contractTermMonths = null;
        fixedTermCount = 0;
        fixedTermSequence = null;
      } else {
        contractTermMonths = rowTerms?.contractTermMonths ?? null;
        fixedTermCount = prev ? (prev.fixedTermCount === null ? null : prev.fixedTermCount + 1) : 1;
        fixedTermSequence = fixedTermCount;
      }
      insured = rowTerms !== undefined ? rowTerms.insured : null;
    } else if (contractKind === 'indefinite') {
      // An indefinite contract never expires or renews; subsequent indefinite rows are wage/region amendments.
      // When an approved pay line exists for this row, use its `insured` directly (null = contract-type default) rather than carrying over prev.insured.
      contractStartDate = prev.contractStartDate;
      contractTermMonths = null;
      fixedTermCount = 0;
      fixedTermSequence = null;
      insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
    } else if (prev.contractDateUncertain || prev.contractStartDate === null) {
      // An earlier unverified `fixed_term -> fixed_term` boundary makes subsequent dates and sequence counts unverifiable until an indefinite contract.
      contractStartDate = null;
      contractDateUncertain = true;
      contractTermMonths = null;
      fixedTermCount = null;
      fixedTermSequence = null;
      insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
    } else if (prev.contractTermMonths !== null) {
      // Consecutive `fixed_term` rows stay in the same contract ONLY when an approved pay line on the prior row proves `eff <= endDate`.
      const parsedPrevStart = parseIsoCalendarDate(prev.contractStartDate);
      const prevEnd = parsedPrevStart ? formatIsoCalendarDate(deriveFixedTermEndDate(parsedPrevStart, prev.contractTermMonths)) : null;
      const sameContract = prevEnd !== null && eff <= prevEnd;
      if (sameContract) {
        contractStartDate = prev.contractStartDate;
        contractTermMonths = rowTerms?.contractTermMonths ?? prev.contractTermMonths;
        fixedTermCount = prev.fixedTermCount;
        fixedTermSequence = prev.fixedTermSequence;
        insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
      } else {
        contractStartDate = eff;
        contractTermMonths = rowTerms?.contractTermMonths ?? null;
        fixedTermCount = prev.fixedTermCount === null ? null : prev.fixedTermCount + 1;
        fixedTermSequence = fixedTermCount;
        insured = rowTerms !== undefined ? rowTerms.insured : null;
      }
    } else {
      // Prior `fixed_term` row lacked an approved term, so whether this row started a renewal or a mid-term raise cannot be verified.
      contractStartDate = null;
      contractDateUncertain = true;
      contractTermMonths = null;
      fixedTermCount = null;
      fixedTermSequence = null;
      insured = rowTerms !== undefined ? rowTerms.insured : prev.insured;
    }

    byEmployee.set(row.employee_id, {
      startedOn: prev ? prev.startedOn : eff,
      contractKind,
      contractStartDate,
      contractDateUncertain,
      contractTermMonths,
      fixedTermCount,
      fixedTermSequence,
      insured,
      baseWage: String(row.base_wage),
    });
  }
  return byEmployee;
}

async function loadLaborCandidateEmployees(ctx: QueryContext, entityId: string): Promise<EmploymentRow[]> {
  return ctx.trx
    .selectFrom('crove_hr.payroll_employment')
    .select(['id', 'employee_id', 'effective_from', 'contract_type', 'base_wage'])
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
  const maxMonthByEmployee = new Map(includedIds.map((id) => [id, (effectiveCutoffByEmployee.get(id) ?? cutoff).slice(0, 7)]));
  const { payMetaByEmployee, termsByEmployment } = await loadApprovedLineFacts(ctx, entityId, includedIds, cutoff.slice(0, 7), maxMonthByEmployee);
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
    const employer = { name: entity.name, taxCode: entity.tax_code, address: null };

    if (input.kind === 'labor_register' || input.kind === '01pli') {
      const rows = await ctx.trx
        .selectFrom('crove_hr.payroll_employee')
        .select(['id', 'display_name', 'address', 'birth_date', 'ended_on', 'erased_at', 'national_id_sealed', 'tax_code_sealed', 'insurance_number_sealed'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', entity.id)
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
        let contractEndDate: string | null = null;
        if (!terms.contractDateUncertain && terms.contractKind === 'fixed_term' && terms.contractStartDate !== null && terms.contractTermMonths !== null) {
          const parsedStart = parseIsoCalendarDate(terms.contractStartDate);
          if (parsedStart) contractEndDate = formatIsoCalendarDate(deriveFixedTermEndDate(parsedStart, terms.contractTermMonths));
        }
        return {
          employeeId: row.id,
          name: row.display_name,
          erased: row.erased_at !== null,
          birthDate: row.erased_at === null && row.birth_date !== null ? iso(row.birth_date) : null,
          address: row.erased_at === null ? row.address : null,
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
          ...(terms.contractDateUncertain && row.erased_at === null
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
      .selectFrom('crove_hr.payroll_run')
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
          .selectFrom('crove_hr.payroll_line')
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
      const adjusted = await ctx.trx.selectFrom('crove_hr.payroll_run').select(['id', 'month']).where('org_id', '=', ctx.orgId).where('id', 'in', adjustedIds).execute();
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
          .selectFrom('crove_hr.payroll_employee')
          .select(['id', 'display_name', 'birth_date', 'ended_on', 'erased_at', 'national_id_sealed', 'tax_code_sealed', 'insurance_number_sealed', 'finalization_authorized_years'])
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', entity.id)
          .where('id', 'in', ids)
          .execute();
    if (employees.length !== ids.length) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 409, 'Một dòng lương nêu một nhân viên không còn trong danh sách');
    const starts = ids.length === 0
      ? []
      : await ctx.trx.selectFrom('crove_hr.payroll_employment').select(['employee_id', 'effective_from']).where('org_id', '=', ctx.orgId).where('employee_id', 'in', ids).orderBy('effective_from', 'asc').execute();
    const startedOn = new Map<string, string>();
    for (const s of starts) if (!startedOn.has(s.employee_id)) startedOn.set(s.employee_id, iso(s.effective_from));

    // What a form prints is all that is opened (the sealed values of a person are opened only when the form shows them): the D02-LT shows the identity number and the social insurance number, and
    // only of the people it lists (a change that month, worked out first from data that is not sealed); the tax forms show the identity number and the tax code. One batch, after the audit row.
    const personsOf = (clear: ReadonlyMap<string, Clear>): DeclarationPerson[] =>
      employees.map((e) => {
        const c = clear.get(e.id) ?? {};
        // Since 2025-07-01 the tax code is in most cases the identity number: a person with no tax code of their own is listed under the identity number, and the document says so.
        return {
          employeeId: e.id,
          name: e.display_name,
          birthDate: e.erased_at === null && e.birth_date !== null ? iso(e.birth_date) : null,
          taxCode: c.taxCode ?? c.identityNumber ?? null,
          insuranceNumber: c.insuranceNumber ?? null,
          identityNumber: c.identityNumber ?? null,
          startedOn: startedOn.get(e.id) ?? '1900-01-01',
          endedOn: e.ended_on === null ? null : iso(e.ended_on),
          finalizationAuthorizedYears: [...e.finalization_authorized_years],
        };
      });
    const d02Input = (persons: DeclarationPerson[]) => {
      const previous = months[1] as string;
      const previousLines = approvedMonths.includes(previous) ? lines.filter((l) => l.month === previous && l.kind === 'pay') : null;
      return { month: input.period, employer, persons, lines: lines.filter((l) => l.month === input.period), previousLines };
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
        const listing = buildCertificatesListing({ year: Number(input.period), employer, persons: blank, lines });
        identityFor = listing.certified;
        taxCodeFor = new Set([...listing.certified, ...listing.authorizers]);
      }
      const clear = await openSealedFor(ctx, employees, taxCodeFor, ['taxCode']);
      const needsIdentity = new Set([...identityFor, ...[...taxCodeFor].filter((id) => clear.get(id)?.taxCode === undefined)]);
      for (const [id, c] of await openSealedFor(ctx, employees, needsIdentity, ['identityNumber'])) clear.set(id, { ...clear.get(id), ...c });
      for (const c of clear.values()) if (c.taxCode === undefined && c.identityNumber !== undefined) taxCodeFromIdentity += 1;
      persons = personsOf(clear);
      if (input.kind === 'kk') document = buildQuarterly({ quarter: input.period, employer, persons, lines, approvedMonths });
      else if (input.kind === 'qtt') document = buildAnnual({ year: Number(input.period), employer, persons, lines, approvedMonths });
      else document = buildCertificates({ year: Number(input.period), employer, persons, lines });
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
      .selectFrom('crove_hr.payroll_employee')
      .select([
        'id',
        'display_name',
        'address',
        'birth_date',
        'ended_on',
        'erased_at',
        sql<boolean>`national_id_sealed IS NOT NULL`.as('has_national_id'),
        sql<boolean>`insurance_number_sealed IS NOT NULL`.as('has_insurance_number'),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity.id)
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
        contractTermMonths: terms.contractTermMonths,
        fixedTermSequence: terms.fixedTermSequence,
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
