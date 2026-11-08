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
import type { MemberRole } from '@crove/db';
import { HR_DECLARATION_MAX_PEOPLE, zHrDeclarationExport, zHrDeclarationQuery, type HrDeclarationDocument, type HrDeclarationExport, type HrDeclarationQuery } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { buildAnnual, buildCertificates, buildD02Lt, buildQuarterly, quarterMonths, type DeclarationBreakdown, type DeclarationLine, type DeclarationPerson } from './declarations.ts';
import { IDENTITY_PLACE, INSURANCE_PLACE, TAX_CODE_PLACE, subjectOf } from './employees.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const APPROVED = ['approved', 'paid', 'closed'] as const;

const iso = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));
const previousMonth = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// The months a declaration reads: the month and the one before for the D02-LT (a change of wage is read against it), the quarter's three, or the year's twelve.
export function declarationMonths(kind: HrDeclarationQuery['kind'], period: string): string[] {
  if (kind === 'd02lt') return [period, previousMonth(period)];
  if (kind === 'kk') return quarterMonths(period);
  return Array.from({ length: 12 }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

// The stored breakdown as the builders read it. A line with no breakdown (an adjustment may have none) reads as none; a breakdown the builders cannot read is a bug and surfaces.
function breakdownOf(raw: unknown): DeclarationBreakdown | null {
  if (raw === null || raw === undefined) return null;
  const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeclarationBreakdown;
  return { insurance: { suspended: b.insurance.suspended, funds: b.insurance.funds.map((f) => ({ fund: f.fund, wage: f.wage, employee: f.employee, employer: f.employer })) }, tax: b.tax };
}

export const declarationGet = defineQuery({
  name: 'hr.payroll.declaration.get',
  input: zHrDeclarationQuery,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrDeclarationDocument> => {
    const entity = input.legalEntityId
      ? await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', input.legalEntityId).executeTakeFirst()
      : await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
    if (!entity) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân của bảng kê');
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
      breakdown: breakdownOf(r.breakdown),
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

    // The sealed identifiers opened, here and only here, in one batch for the people who appear: the audit row of this read is already committed. A value whose key is gone reads as none.
    const items: { sealed: string; place: string; ref: string }[] = [];
    const slots: { id: string; field: 'identityNumber' | 'taxCode' | 'insuranceNumber' }[] = [];
    for (const e of employees) {
      if (e.erased_at !== null) continue;
      const subject = subjectOf(e.id);
      if (e.national_id_sealed !== null) { items.push({ sealed: e.national_id_sealed, place: IDENTITY_PLACE, ref: subject }); slots.push({ id: e.id, field: 'identityNumber' }); }
      if (e.tax_code_sealed !== null) { items.push({ sealed: e.tax_code_sealed, place: TAX_CODE_PLACE, ref: subject }); slots.push({ id: e.id, field: 'taxCode' }); }
      if (e.insurance_number_sealed !== null) { items.push({ sealed: e.insurance_number_sealed, place: INSURANCE_PLACE, ref: subject }); slots.push({ id: e.id, field: 'insuranceNumber' }); }
    }
    const opened = items.length === 0 ? [] : await ctx.openMany(items);
    const clear = new Map<string, { identityNumber?: string; taxCode?: string; insuranceNumber?: string }>();
    slots.forEach((slot, i) => {
      const value = opened[i];
      if (typeof value !== 'string') return;
      clear.set(slot.id, { ...clear.get(slot.id), [slot.field]: value });
    });
    let taxCodeFromIdentity = 0;
    const persons: DeclarationPerson[] = employees.map((e) => {
      const c = clear.get(e.id) ?? {};
      // Since 2025-07-01 the tax code is in most cases the identity number: a person with no tax code of their own is listed under the identity number, and the document says so.
      const taxCode = c.taxCode ?? c.identityNumber ?? null;
      if (c.taxCode === undefined && c.identityNumber !== undefined) taxCodeFromIdentity += 1;
      return {
        employeeId: e.id,
        name: e.display_name,
        birthDate: e.erased_at === null && e.birth_date !== null ? iso(e.birth_date) : null,
        taxCode,
        insuranceNumber: c.insuranceNumber ?? null,
        identityNumber: c.identityNumber ?? null,
        startedOn: startedOn.get(e.id) ?? '1900-01-01',
        endedOn: e.ended_on === null ? null : iso(e.ended_on),
        finalizationAuthorizedYears: [...e.finalization_authorized_years],
      };
    });
    const employer = { name: entity.name, taxCode: entity.tax_code, address: null };
    let document: Omit<HrDeclarationDocument, 'used'>;
    if (input.kind === 'd02lt') {
      const previous = months[1] as string;
      const previousLines = approvedMonths.includes(previous) ? lines.filter((l) => l.month === previous && l.kind === 'pay') : null;
      document = buildD02Lt({ month: input.period, employer, persons, lines: lines.filter((l) => l.month === input.period), previousLines });
    } else if (input.kind === 'kk') {
      document = buildQuarterly({ quarter: input.period, employer, persons, lines, approvedMonths });
    } else if (input.kind === 'qtt') {
      document = buildAnnual({ year: Number(input.period), employer, persons, lines, approvedMonths });
    } else {
      document = buildCertificates({ year: Number(input.period), employer, persons, lines });
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
      months: input.months,
      ...(input.authorizedYear === undefined ? {} : { authorizedYear: input.authorizedYear, authorizedPeople: input.authorizedPeople ?? 0 }),
      ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
    });
    return { rows: input.rows };
  },
});

export const hrDeclarationCommands = [declarationExport];
export const hrDeclarationQueries = [declarationGet];
