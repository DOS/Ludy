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
import { DomainError, defineCommand, defineQuery, hasFreshMfa } from '@crove/kernel-runtime';
import { buildAnnual, buildAnnualListing, buildCertificates, buildCertificatesListing, buildD02Lt, buildD02LtListing, buildQuarterly, buildQuarterlyListing, quarterMonths, type DeclarationBreakdown, type DeclarationLine, type DeclarationPerson } from './declarations.ts';
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

// The stored breakdown as the builders read it. A line with no breakdown reads as none, and so does an adjustment whatever it holds: a correction keeps only the split of its insurance across the funds
// for its posting (#2532), not the tax and wage detail of a pay line, so it is read as one with no breakdown (its tax and taxable income are added, its assessable income is not, and the document says
// so). A pay line's breakdown the builders cannot read is a bug and surfaces.
function breakdownOf(raw: unknown, kind: string): DeclarationBreakdown | null {
  if (raw === null || raw === undefined || kind === 'adjustment') return null;
  const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeclarationBreakdown;
  return { insurance: { suspended: b.insurance.suspended, funds: b.insurance.funds.map((f) => ({ fund: f.fund, wage: f.wage, employee: f.employee, employer: f.employer })) }, tax: b.tax };
}

export const declarationGet = defineQuery({
  name: 'hr.payroll.declaration.get',
  input: zHrDeclarationQuery,
  access: MANAGERS,
  sensitive: true,
  // The kind names what is read (a name of fixed shape), so the audit row of the read says which form it was before a value is opened.
  auditDetail: (input) => ({ kind: input.kind }),
  handler: async (ctx, input): Promise<HrDeclarationDocument> => {
    // Bulk decryption of staff identifiers needs a second factor used within the last 5 minutes (policy P11), as an R3 command does; the app's StepUpPrompt answers STEP_UP_REQUIRED. Checked
    // before anything is read or opened, and for every caller (the download route and the screen's read).
    if (ctx.actor.type !== 'user' || !hasFreshMfa(ctx.actor)) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
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
    const employer = { name: entity.name, taxCode: entity.tax_code, address: null };
    type Clear = { identityNumber?: string; taxCode?: string; insuranceNumber?: string };
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
    const openFor = async (who: ReadonlySet<string> | null, fields: readonly ('identityNumber' | 'taxCode' | 'insuranceNumber')[]): Promise<Map<string, Clear>> => {
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
    };
    let document: Omit<HrDeclarationDocument, 'used'>;
    let persons: DeclarationPerson[];
    let taxCodeFromIdentity = 0;
    if (input.kind === 'd02lt') {
      const { listed } = buildD02LtListing(d02Input(personsOf(new Map())));
      persons = personsOf(await openFor(listed, ['identityNumber', 'insuranceNumber']));
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
      const clear = await openFor(taxCodeFor, ['taxCode']);
      const needsIdentity = new Set([...identityFor, ...[...taxCodeFor].filter((id) => clear.get(id)?.taxCode === undefined)]);
      for (const [id, c] of await openFor(needsIdentity, ['identityNumber'])) clear.set(id, { ...clear.get(id), ...c });
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

export const hrDeclarationCommands = [declarationExport];
export const hrDeclarationQueries = [declarationGet];
