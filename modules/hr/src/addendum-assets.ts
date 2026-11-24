// SPDX-License-Identifier: AGPL-3.0-only
// Stage 6C (#4528): Contract addendums -> PDF/eSign handoff, career timeline, and asset handover checklist.
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  HR_TIMELINE_EVENT_KINDS,
  tableWrite,
  vietnamToday,
  zHrAddendumAiStatusAsk,
  zHrAddendumCheckAsk,
  zHrAddendumCheckAudit,
  zHrAddendumCreate,
  zHrAddendumIssue,
  zHrAddendumList,
  zHrAddendumPdfAsk,
  zHrAddendumUpdate,
  zHrAddendumVoid,
  zHrAssetAssign,
  zHrAssetList,
  zHrAssetUpdateStatus,
  zHrSelfAssetsAsk,
  zHrTimelineAsk,
  type HrAddendumStatus,
  type HrAddendumView,
  type HrAddendumWriteResult,
  type HrAssetStatus,
  type HrAssetView,
  type HrAssetWriteResult,
  type HrAddendumPdfResult,
  type HrSelfAssetView,
  type HrTimelineEvent,
  type HrTimelineResult,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import {
  addendumPdfFilename,
  renderContractAddendumPdf,
} from './addendum-pdf.ts';
import {
  defaultContractNumber,
  defaultEmployeeCode,
  sanitizeNoEmDash as sanitizeBaseNoEmDash,
} from './contract-pdf.ts';

const sanitizeNoEmDash = (value: string): string =>
  sanitizeBaseNoEmDash(value).replace(/[\u2013\u2014]/gu, '-');
import {
  MANAGERS,
  loadEmployee,
  lockEmployeeErasure,
  requireActive,
  userOf,
} from './employees.ts';
import { STAFF_ROLES, resolveSelfEmployee, selfNotLinked } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';

const isoTimestamp = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

const formatDecimalRate = (raw: string | null): string | null => {
  if (raw === null) return null;
  const parsed = money(raw);
  return parsed.isInteger() ? parsed.toFixed(0) : parsed.toFixed(2);
};

const parseNonNegativeRate = (raw: string | null | undefined): string | null => {
  if (raw === undefined || raw === null) return null;
  const parsed = money(raw);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new DomainError('HR_ADDENDUM_INVALID_PAY_RATE', 422, 'Mức lương trong phụ lục phải lớn hơn hoặc bằng 0');
  }
  return parsed.toFixed(2);
};

const empTarget = (input: { employeeId: string }) => ({ type: 'hr.payroll_employee', id: input.employeeId });
const addendumTarget = (input: { addendumId: string }) => ({ type: 'hr.contract_addendum', id: input.addendumId });
const assetTarget = (input: { assetId: string }) => ({ type: 'hr.employee_asset_handover', id: input.assetId });

export interface HrAddendumCheckSource {
  employeeId: string;
  employmentId: string;
  contractType: string;
  employmentEffectiveFrom: string;
  currentTitle: string | null;
  currentBaseWage: string;
  addendumNumber: string;
  effectiveOn: string;
  changeSummary: string;
  previousPayRate: string | null;
  newPayRate: string | null;
  previousTitle: string | null;
  newTitle: string | null;
  forbiddenTerms: string[];
}

function mapAddendumView(row: {
  id: string;
  employee_id: string;
  employment_id: string | null;
  legal_entity_id: string;
  addendum_number: string;
  effective_on: Date | string;
  change_summary: string;
  previous_pay_rate: string | null;
  new_pay_rate: string | null;
  previous_title: string | null;
  new_title: string | null;
  status: HrAddendumStatus;
  issued_at: Date | string | null;
  voided_at: Date | string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): HrAddendumView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employmentId: row.employment_id,
    legalEntityId: row.legal_entity_id,
    addendumNumber: row.addendum_number,
    effectiveOn: iso(row.effective_on),
    changeSummary: row.change_summary,
    previousPayRate: formatDecimalRate(row.previous_pay_rate),
    newPayRate: formatDecimalRate(row.new_pay_rate),
    previousTitle: row.previous_title,
    newTitle: row.new_title,
    status: row.status,
    issuedAt: isoTimestamp(row.issued_at),
    voidedAt: isoTimestamp(row.voided_at),
    voidReason: row.void_reason,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at) ?? '',
    updatedAt: isoTimestamp(row.updated_at) ?? '',
  };
}

function mapAssetView(row: {
  id: string;
  employee_id: string;
  legal_entity_id: string;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  handed_over_on: Date | string;
  returned_on: Date | string | null;
  status: HrAssetStatus;
  notes: string | null;
  cleared_by: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): HrAssetView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    legalEntityId: row.legal_entity_id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    serialNumber: row.serial_number,
    handedOverOn: iso(row.handed_over_on),
    returnedOn: row.returned_on === null ? null : iso(row.returned_on),
    status: row.status,
    notes: row.notes,
    clearedBy: row.cleared_by,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at) ?? '',
    updatedAt: isoTimestamp(row.updated_at) ?? '',
  };
}

async function assertEmployeeExists(ctx: QueryContext, employeeId: string) {
  const row = await ctx.trx
    .selectFrom('ludy_hr.payroll_employee')
    .select(['id', 'legal_entity_id', 'display_name', 'birth_date', 'job_title', 'status', 'ended_on', 'erased_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', employeeId)
    .executeTakeFirst();
  if (!row) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
  return row;
}

const addendumNotFound = () =>
  new DomainError('HR_ADDENDUM_NOT_FOUND', 404, 'Không tìm thấy phụ lục hợp đồng này');
const assetNotFound = () =>
  new DomainError('HR_ASSET_NOT_FOUND', 404, 'Không tìm thấy bản ghi bàn giao tài sản này');

async function preReadAndLockAddendum(ctx: CommandContext, addendumId: string) {
  const preRead = await ctx.trx
    .selectFrom('ludy_hr.contract_addendum')
    .select(['id', 'employee_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', addendumId)
    .executeTakeFirst();
  if (!preRead) throw addendumNotFound();
  await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
  await loadEmployee(ctx, preRead.employee_id);
  const existing = await ctx.trx
    .selectFrom('ludy_hr.contract_addendum')
    .select(['id', 'employee_id', 'addendum_number', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', addendumId)
    .forUpdate()
    .executeTakeFirst();
  if (!existing) throw addendumNotFound();
  return existing;
}

async function preReadAndLockAsset(ctx: CommandContext, assetId: string) {
  const preRead = await ctx.trx
    .selectFrom('ludy_hr.employee_asset_handover')
    .select(['id', 'employee_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', assetId)
    .executeTakeFirst();
  if (!preRead) throw assetNotFound();
  await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
  await loadEmployee(ctx, preRead.employee_id);
  const existing = await ctx.trx
    .selectFrom('ludy_hr.employee_asset_handover')
    .select(['id', 'employee_id', 'asset_code', 'handed_over_on', 'status', 'notes'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', assetId)
    .forUpdate()
    .executeTakeFirst();
  if (!existing) throw assetNotFound();
  return existing;
}

export const addendumList = defineQuery({
  name: 'hr.addendum.list',
  input: zHrAddendumList,
  access: MANAGERS,
  sensitive: true,
  target: empTarget,
  handler: async (ctx, input): Promise<HrAddendumView[]> => {
    await assertEmployeeExists(ctx, input.employeeId);
    const rows = await ctx.trx
      .selectFrom('ludy_hr.contract_addendum')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', input.employeeId)
      .orderBy('effective_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map(mapAddendumView);
  },
});

export const addendumCreate = defineCommand({
  name: 'hr.addendum.create',
  input: zHrAddendumCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: empTarget,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'contract_addendum', [
      'id',
      'legal_entity_id',
      'employee_id',
      'employment_id',
      'addendum_number',
      'effective_on',
      'change_summary',
      'previous_pay_rate',
      'new_pay_rate',
      'previous_title',
      'new_title',
      'status',
      'issued_at',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAddendumWriteResult> => {
    const actorUserId = userOf(ctx.actor);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, input.employeeId);
    const employee = await loadEmployee(ctx, input.employeeId);

    const employment = await ctx.trx
      .selectFrom('ludy_hr.payroll_employment')
      .select(['id', 'legal_entity_id', 'effective_from'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employmentId)
      .where('employee_id', '=', input.employeeId)
      .executeTakeFirst();
    if (!employment || employment.legal_entity_id !== employee.legal_entity_id) {
      throw new DomainError(
        'HR_EMPLOYMENT_NOT_FOUND',
        404,
        'Không tìm thấy hợp đồng lao động tương ứng của nhân viên này',
      );
    }

    const prevPay = parseNonNegativeRate(input.previousPayRate);
    const nextPay = parseNonNegativeRate(input.newPayRate);
    const id = randomUUID();
    const status: HrAddendumStatus = input.issueImmediately ? 'issued' : 'draft';
    const issuedAt = input.issueImmediately ? ctx.now : null;

    try {
      await ctx.trx
        .insertInto('ludy_hr.contract_addendum')
        .values({
          org_id: ctx.orgId,
          id,
          legal_entity_id: employee.legal_entity_id,
          employee_id: input.employeeId,
          employment_id: employment.id,
          addendum_number: sanitizeNoEmDash(input.addendumNumber),
          effective_on: input.effectiveOn,
          change_summary: sanitizeNoEmDash(input.changeSummary),
          previous_pay_rate: prevPay,
          new_pay_rate: nextPay,
          previous_title: input.previousTitle ? sanitizeNoEmDash(input.previousTitle) : null,
          new_title: input.newTitle ? sanitizeNoEmDash(input.newTitle) : null,
          status,
          issued_at: issuedAt,
          voided_at: null,
          void_reason: null,
          created_by: actorUserId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505') {
        throw new DomainError(
          'HR_ADDENDUM_NUMBER_TAKEN',
          409,
          'Số phụ lục hợp đồng này đã tồn tại trong pháp nhân',
        );
      }
      throw error;
    }

    ctx.audit({
      employeeId: input.employeeId,
      addendumId: id,
      employmentId: employment.id,
      addendumNumber: input.addendumNumber,
      effectiveOn: input.effectiveOn,
      status,
    });
    return { addendumId: id, status };
  },
});

export const addendumUpdate = defineCommand({
  name: 'hr.addendum.update',
  input: zHrAddendumUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: addendumTarget,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'contract_addendum', [
      'effective_on',
      'change_summary',
      'previous_pay_rate',
      'new_pay_rate',
      'previous_title',
      'new_title',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAddendumWriteResult> => {
    userOf(ctx.actor);
    const existing = await preReadAndLockAddendum(ctx, input.addendumId);

    if (existing.status !== 'draft') {
      throw new DomainError(
        'HR_ADDENDUM_NOT_DRAFT',
        409,
        'Chỉ chỉnh sửa được phụ lục đang ở trạng thái nháp',
      );
    }

    const patch: {
      effective_on?: string;
      change_summary?: string;
      previous_pay_rate?: string | null;
      new_pay_rate?: string | null;
      previous_title?: string | null;
      new_title?: string | null;
      updated_at: Date;
    } = { updated_at: ctx.now };

    if (input.effectiveOn !== undefined) patch.effective_on = input.effectiveOn;
    if (input.changeSummary !== undefined) patch.change_summary = sanitizeNoEmDash(input.changeSummary);
    if (input.previousPayRate !== undefined) patch.previous_pay_rate = parseNonNegativeRate(input.previousPayRate);
    if (input.newPayRate !== undefined) patch.new_pay_rate = parseNonNegativeRate(input.newPayRate);
    if (input.previousTitle !== undefined) {
      patch.previous_title = input.previousTitle ? sanitizeNoEmDash(input.previousTitle) : null;
    }
    if (input.newTitle !== undefined) {
      patch.new_title = input.newTitle ? sanitizeNoEmDash(input.newTitle) : null;
    }

    await ctx.trx
      .updateTable('ludy_hr.contract_addendum')
      .set(patch)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.addendumId)
      .execute();

    ctx.audit({ addendumId: input.addendumId, employeeId: existing.employee_id, status: existing.status });
    return { addendumId: input.addendumId, status: existing.status };
  },
});

export const addendumIssue = defineCommand({
  name: 'hr.addendum.issue',
  input: zHrAddendumIssue,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: addendumTarget,
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'contract_addendum', ['status', 'issued_at', 'updated_at'])],
  handler: async (ctx, input): Promise<HrAddendumWriteResult> => {
    userOf(ctx.actor);
    const existing = await preReadAndLockAddendum(ctx, input.addendumId);

    if (existing.status !== 'draft') {
      throw new DomainError(
        'HR_ADDENDUM_NOT_DRAFT',
        409,
        'Phụ lục này đã được phát hành hoặc đã hủy, không thể phát hành lại',
      );
    }

    await ctx.trx
      .updateTable('ludy_hr.contract_addendum')
      .set({ status: 'issued', issued_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.addendumId)
      .execute();

    ctx.audit({
      addendumId: input.addendumId,
      employeeId: existing.employee_id,
      addendumNumber: existing.addendum_number,
      status: 'issued',
    });
    return { addendumId: input.addendumId, status: 'issued' };
  },
});

export const addendumVoid = defineCommand({
  name: 'hr.addendum.void',
  input: zHrAddendumVoid,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: addendumTarget,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'contract_addendum', ['status', 'voided_at', 'void_reason', 'updated_at']),
  ],
  handler: async (ctx, input): Promise<HrAddendumWriteResult> => {
    userOf(ctx.actor);
    const existing = await preReadAndLockAddendum(ctx, input.addendumId);

    if (existing.status === 'voided') {
      throw new DomainError('HR_ADDENDUM_ALREADY_VOIDED', 409, 'Phụ lục này đã bị hủy trước đó');
    }

    await ctx.trx
      .updateTable('ludy_hr.contract_addendum')
      .set({
        status: 'voided',
        voided_at: ctx.now,
        void_reason: sanitizeNoEmDash(input.reason),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.addendumId)
      .execute();

    ctx.audit({
      addendumId: input.addendumId,
      employeeId: existing.employee_id,
      addendumNumber: existing.addendum_number,
      status: 'voided',
    });
    return { addendumId: input.addendumId, status: 'voided' };
  },
});

export const addendumPdf = defineQuery({
  name: 'hr.addendum.pdf',
  input: zHrAddendumPdfAsk,
  access: MANAGERS,
  sensitive: true,
  target: addendumTarget,
  handler: async (ctx, input): Promise<HrAddendumPdfResult> => {
    const addendum = await ctx.trx
      .selectFrom('ludy_hr.contract_addendum')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.addendumId)
      .executeTakeFirst();
    if (!addendum) throw new DomainError('HR_ADDENDUM_NOT_FOUND', 404, 'Không tìm thấy phụ lục hợp đồng này');

    const employee = await assertEmployeeExists(ctx, addendum.employee_id);
    if (employee.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu, không xuất lại PDF được');
    }

    const employment = addendum.employment_id
      ? await ctx.trx
          .selectFrom('ludy_hr.payroll_employment')
          .select(['id', 'effective_from'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', addendum.employment_id)
          .executeTakeFirst()
      : await ctx.trx
          .selectFrom('ludy_hr.payroll_employment')
          .select(['id', 'effective_from'])
          .where('org_id', '=', ctx.orgId)
          .where('employee_id', '=', employee.id)
          .orderBy('effective_from', 'desc')
          .limit(1)
          .executeTakeFirst();

    const entity = await ctx.trx
      .selectFrom('ludy_kernel.legal_entity')
      .select(['name', 'tax_code'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', addendum.legal_entity_id)
      .executeTakeFirst();

    const employmentFrom = employment ? iso(employment.effective_from) : null;
    const contractNumber = employment && employmentFrom ? defaultContractNumber(employmentFrom, employment.id) : null;
    const bytes = renderContractAddendumPdf({
      addendumNumber: addendum.addendum_number,
      effectiveOn: iso(addendum.effective_on),
      changeSummary: addendum.change_summary,
      previousPayRate: formatDecimalRate(addendum.previous_pay_rate),
      newPayRate: formatDecimalRate(addendum.new_pay_rate),
      previousTitle: addendum.previous_title,
      newTitle: addendum.new_title,
      contractNumber,
      contractEffectiveFrom: employmentFrom,
      legalEntityName: entity?.name ?? 'Doanh nghiệp',
      legalEntityTaxCode: entity?.tax_code ?? null,
      employeeName: employee.display_name,
      employeeBirthDate: employee.birth_date ? iso(employee.birth_date) : null,
      employeeCode: defaultEmployeeCode(employee.id),
      includeSignTags: input.includeSignTags ?? false,
    });

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      addendumId: addendum.id,
      filename: addendumPdfFilename(employee.display_name, addendum.addendum_number),
      contentType: 'application/pdf',
      sha256,
      pdfBase64: Buffer.from(bytes).toString('base64'),
    };
  },
});

export const addendumCheckRead = defineQuery({
  name: 'hr.addendum.check.read',
  input: zHrAddendumCheckAsk,
  access: MANAGERS,
  sensitive: true,
  target: empTarget,
  handler: async (ctx, input): Promise<HrAddendumCheckSource> => {
    userOf(ctx.actor);
    const employee = await assertEmployeeExists(ctx, input.employeeId);
    if (employee.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu');
    }

    const employment = await ctx.trx
      .selectFrom('ludy_hr.payroll_employment')
      .select(['id', 'legal_entity_id', 'effective_from', 'contract_type', 'base_wage'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employmentId)
      .where('employee_id', '=', input.employeeId)
      .executeTakeFirst();
    if (!employment || employment.legal_entity_id !== employee.legal_entity_id) {
      throw new DomainError('HR_EMPLOYMENT_NOT_FOUND', 404, 'Không tìm thấy hợp đồng lao động tương ứng của nhân viên này');
    }

    const forbiddenTerms: string[] = [];
    if (employee.display_name && employee.display_name.trim().length > 1) {
      forbiddenTerms.push(employee.display_name.trim());
    }

    return {
      employeeId: employee.id,
      employmentId: employment.id,
      contractType: employment.contract_type,
      employmentEffectiveFrom: iso(employment.effective_from),
      currentTitle: employee.job_title,
      currentBaseWage: formatDecimalRate(employment.base_wage) ?? '0',
      addendumNumber: input.addendumNumber ?? '',
      effectiveOn: input.effectiveOn ?? '',
      changeSummary: input.changeSummary ?? '',
      previousPayRate:
        input.previousPayRate !== undefined ? input.previousPayRate : formatDecimalRate(employment.base_wage),
      newPayRate: input.newPayRate ?? null,
      previousTitle: input.previousTitle !== undefined ? input.previousTitle : employee.job_title,
      newTitle: input.newTitle ?? null,
      forbiddenTerms,
    };
  },
});

export const addendumAiStatus = defineQuery({
  name: 'hr.addendum.ai_status',
  input: zHrAddendumAiStatusAsk,
  access: MANAGERS,
  handler: async (ctx): Promise<{ aiStopped: boolean }> => {
    userOf(ctx.actor);
    const { rows } = await sql<{ ai_stopped: boolean }>`
      SELECT
        (
          ludy_kernel.global_kill_switch_on('ai')
          OR EXISTS (
            SELECT 1 FROM ludy_kernel.kill_switch k
             WHERE k.org_id = ${ctx.orgId}::uuid
               AND k.released_at IS NULL
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = 'hr'))
          )
        ) AS ai_stopped
    `.execute(ctx.trx);
    return { aiStopped: rows[0]?.ai_stopped === true };
  },
});

export const addendumCheckAudit = defineCommand({
  name: 'hr.addendum.check.audit',
  input: zHrAddendumCheckAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  target: empTarget,
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      employeeId: input.employeeId,
      employmentId: input.employmentId,
      readyToIssue: input.readyToIssue,
      findingsCount: input.findingsCount,
      aiReason: input.aiReason,
    });
    return { ok: true };
  },
});

export const timelineGet = defineQuery({
  name: 'hr.timeline.get',
  input: zHrTimelineAsk,
  access: MANAGERS,
  sensitive: true,
  target: empTarget,
  handler: async (ctx, input): Promise<HrTimelineResult> => {
    const employee = await assertEmployeeExists(ctx, input.employeeId);
    const erased = employee.erased_at !== null;

    const [employments, probations, addendums] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_hr.payroll_employment')
        .select(['id', 'effective_from', 'contract_type', 'base_wage', 'created_at'])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', input.employeeId)
        .orderBy('effective_from', 'asc')
        .orderBy('created_at', 'asc')
        .limit(200)
        .execute(),
      ctx.trx
        .selectFrom('ludy_hr.probation_review')
        .select(['id', 'probation_end_on', 'period_end', 'decision', 'extended_until', 'created_at'])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', input.employeeId)
        .orderBy('period_end', 'asc')
        .orderBy('created_at', 'asc')
        .limit(200)
        .execute(),
      ctx.trx
        .selectFrom('ludy_hr.contract_addendum')
        .select([
          'id',
          'addendum_number',
          'effective_on',
          'change_summary',
          'previous_pay_rate',
          'new_pay_rate',
          'previous_title',
          'new_title',
          'status',
          'created_at',
        ])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', input.employeeId)
        .where('status', '=', 'issued')
        .orderBy('effective_on', 'asc')
        .orderBy('created_at', 'asc')
        .limit(200)
        .execute(),
    ]);

    const events: Array<{ event: HrTimelineEvent; rank: number; sortAt: string }> = [];

    for (const empRow of employments) {
      const occurredOn = iso(empRow.effective_from);
      events.push({
        rank: 0,
        sortAt: isoTimestamp(empRow.created_at) ?? '',
        event: {
          id: `employment:${empRow.id}`,
          kind: HR_TIMELINE_EVENT_KINDS[0],
          occurredOn,
          title: empRow.contract_type,
          subtitle: `${formatDecimalRate(empRow.base_wage) ?? '0'} VND`,
          status: 'recorded',
          refId: empRow.id,
          metadata: {
            contractType: empRow.contract_type,
            baseWage: formatDecimalRate(empRow.base_wage),
          },
        },
      });
    }

    for (const rev of probations) {
      const occurredOn = iso(rev.probation_end_on ?? rev.period_end);
      events.push({
        rank: 1,
        sortAt: isoTimestamp(rev.created_at) ?? '',
        event: {
          id: `probation:${rev.id}`,
          kind: HR_TIMELINE_EVENT_KINDS[1],
          occurredOn,
          title: rev.decision,
          subtitle: rev.extended_until ? iso(rev.extended_until) : null,
          status: rev.decision,
          refId: rev.id,
          metadata: {
            decision: rev.decision,
            extendedUntil: rev.extended_until ? iso(rev.extended_until) : null,
          },
        },
      });
    }

    for (const add of addendums) {
      const occurredOn = iso(add.effective_on);
      events.push({
        rank: 2,
        sortAt: isoTimestamp(add.created_at) ?? '',
        event: {
          id: `addendum:${add.id}`,
          kind: HR_TIMELINE_EVENT_KINDS[2],
          occurredOn,
          title: add.addendum_number,
          subtitle: erased ? null : add.change_summary,
          status: add.status,
          refId: add.id,
          metadata: {
            addendumNumber: add.addendum_number,
            previousPayRate: formatDecimalRate(add.previous_pay_rate),
            newPayRate: formatDecimalRate(add.new_pay_rate),
            previousTitle: erased ? null : add.previous_title,
            newTitle: erased ? null : add.new_title,
          },
        },
      });
    }

    events.sort((a, b) => {
      if (a.event.occurredOn !== b.event.occurredOn) {
        return a.event.occurredOn.localeCompare(b.event.occurredOn);
      }
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.sortAt !== b.sortAt) return a.sortAt.localeCompare(b.sortAt);
      return a.event.id.localeCompare(b.event.id);
    });

    return {
      employeeId: input.employeeId,
      events: events.map((item) => item.event),
    };
  },
});

export const assetList = defineQuery({
  name: 'hr.assets.list',
  input: zHrAssetList,
  access: MANAGERS,
  sensitive: true,
  target: empTarget,
  handler: async (ctx, input): Promise<HrAssetView[]> => {
    await assertEmployeeExists(ctx, input.employeeId);
    const rows = await ctx.trx
      .selectFrom('ludy_hr.employee_asset_handover')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', input.employeeId)
      .orderBy('handed_over_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map(mapAssetView);
  },
});

export const assetAssign = defineCommand({
  name: 'hr.assets.assign',
  input: zHrAssetAssign,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: empTarget,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'employee_asset_handover', [
      'id',
      'legal_entity_id',
      'employee_id',
      'asset_code',
      'asset_name',
      'serial_number',
      'handed_over_on',
      'returned_on',
      'status',
      'notes',
      'cleared_by',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAssetWriteResult> => {
    const actorUserId = userOf(ctx.actor);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, input.employeeId);
    const employee = await loadEmployee(ctx, input.employeeId);
    requireActive(employee);

    const id = randomUUID();
    await ctx.trx
      .insertInto('ludy_hr.employee_asset_handover')
      .values({
        org_id: ctx.orgId,
        id,
        legal_entity_id: employee.legal_entity_id,
        employee_id: input.employeeId,
        asset_code: sanitizeNoEmDash(input.assetCode),
        asset_name: sanitizeNoEmDash(input.assetName),
        serial_number: input.serialNumber ? sanitizeNoEmDash(input.serialNumber) : null,
        handed_over_on: input.handedOverOn,
        returned_on: null,
        status: 'assigned',
        notes: input.notes ? sanitizeNoEmDash(input.notes) : null,
        cleared_by: null,
        created_by: actorUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .execute();

    ctx.audit({
      employeeId: input.employeeId,
      assetId: id,
      assetCode: input.assetCode,
      handedOverOn: input.handedOverOn,
      status: 'assigned',
    });
    return { assetId: id, status: 'assigned' };
  },
});

export const assetUpdateStatus = defineCommand({
  name: 'hr.assets.update_status',
  input: zHrAssetUpdateStatus,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: assetTarget,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'employee_asset_handover', [
      'status',
      'returned_on',
      'notes',
      'cleared_by',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAssetWriteResult> => {
    const actorUserId = userOf(ctx.actor);
    const existing = await preReadAndLockAsset(ctx, input.assetId);

    if (existing.status !== 'assigned') {
      throw new DomainError('HR_ASSET_ALREADY_CLEARED', 409, 'Tài sản này đã được xác nhận thu hồi hoặc thanh lý trước đó');
    }

    const handedOverOn = iso(existing.handed_over_on);
    const returnedOn =
      input.status === 'returned'
        ? input.returnedOn ?? vietnamToday()
        : input.returnedOn ?? null;

    if (returnedOn !== null && returnedOn < handedOverOn) {
      throw new DomainError(
        'HR_ASSET_RETURN_BEFORE_HANDOVER',
        422,
        'Ngày thu hồi tài sản không thể trước ngày bàn giao',
      );
    }

    const nextNotes =
      input.notes !== undefined
        ? input.notes
          ? sanitizeNoEmDash(input.notes)
          : null
        : existing.notes;

    await ctx.trx
      .updateTable('ludy_hr.employee_asset_handover')
      .set({
        status: input.status,
        returned_on: returnedOn,
        notes: nextNotes,
        cleared_by: actorUserId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.assetId)
      .execute();

    ctx.audit({
      assetId: input.assetId,
      employeeId: existing.employee_id,
      assetCode: existing.asset_code,
      status: input.status,
      returnedOn,
    });
    return { assetId: input.assetId, status: input.status };
  },
});

export const selfAssetList = defineQuery({
  name: 'hr.self.assets.list',
  input: zHrSelfAssetsAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx): Promise<HrSelfAssetView[]> => {
    const callerUserId = userOf(ctx.actor);
    const selfEmp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!selfEmp) throw selfNotLinked();

    const rows = await ctx.trx
      .selectFrom('ludy_hr.employee_asset_handover')
      .select([
        'id',
        'asset_code',
        'asset_name',
        'serial_number',
        'handed_over_on',
        'returned_on',
        'status',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', selfEmp.id)
      .orderBy('handed_over_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      serialNumber: row.serial_number,
      handedOverOn: iso(row.handed_over_on),
      returnedOn: row.returned_on === null ? null : iso(row.returned_on),
      status: row.status,
    }));
  },
});

export const hrAddendumAssetsCommands = [
  addendumCreate,
  addendumUpdate,
  addendumIssue,
  addendumVoid,
  addendumCheckAudit,
  assetAssign,
  assetUpdateStatus,
];

export const hrAddendumAssetsQueries = [
  addendumList,
  addendumPdf,
  addendumCheckRead,
  addendumAiStatus,
  timelineGet,
  assetList,
  selfAssetList,
];
