// SPDX-License-Identifier: AGPL-3.0-only
// HR employee self-service onboarding checklist and HR approval workflow (#4448, Stage 5B).
// Employees submit confirmation flags and optional profile/bank updates as pending submissions on /hr/my;
// HR owners/admins review and approve before updating ludy_hr.payroll_employee (no unreviewed PII overwrite).
import {
  auditValue,
  tableWrite,
  zHrOnboardingDecide,
  zHrOnboardingList,
  zHrOnboardingSubmissionRef,
  zHrSelfOnboardingGetAsk,
  zHrSelfOnboardingSubmit,
  type HrOnboardingApproveResult,
  type HrOnboardingCancelResult,
  type HrOnboardingRejectResult,
  type HrOnboardingStatus,
  type HrOnboardingSubmissionView,
  type HrSelfOnboardingState,
  type HrSelfOnboardingSubmitResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import {
  ACCOUNT_PLACE,
  IDENTITY_PLACE,
  INSURANCE_PLACE,
  MANAGERS,
  lockEmployeeErasure,
  requireKnownBank,
  TAX_CODE_PLACE,
  subjectOf,
  userOf,
} from './employees.ts';
import { assertNotSelfApprover, resolveSelfEmployee, selfNotLinked, STAFF_ROLES } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';

const ONBOARDING = hrManifest.tables.ludy_hr.onboarding_submission;
const EMPLOYEE = hrManifest.tables.ludy_hr.payroll_employee;

const submissionNotFound = () =>
  new DomainError('HR_ONBOARDING_NOT_FOUND', 404, 'Không tìm thấy phiếu xác nhận thông tin nhân viên này');
const invalidOnboardingState = (message: string) =>
  new DomainError('HR_ONBOARDING_INVALID_STATE', 409, message);

async function preReadAndLockEmployeeErasure(
  trx: QueryContext['trx'],
  orgId: string,
  submissionId: string,
): Promise<{ id: string; employee_id: string }> {
  const preRead = await trx
    .selectFrom('ludy_hr.onboarding_submission')
    .select(['id', 'employee_id'])
    .where('org_id', '=', orgId)
    .where('id', '=', submissionId)
    .executeTakeFirst();
  if (!preRead) throw submissionNotFound();
  await lockEmployeeErasure(trx, orgId, preRead.employee_id);
  return preRead;
}

interface RawOnboardingRow {
  id: string;
  legal_entity_id: string;
  employee_id: string;
  employee_name: string;
  department_name: string | null;
  erased_at: Date | string | null;
  status: HrOnboardingStatus;
  contact_confirmed: boolean;
  id_confirmed: boolean;
  bank_confirmed: boolean;
  handbook_confirmed: boolean;
  address: string | null;
  birth_date: Date | string | null;
  national_id_sealed: string | null;
  bank_code: string | null;
  bank_account_sealed: string | null;
  tax_code_sealed: string | null;
  insurance_number_sealed: string | null;
  note: string | null;
  decision_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  created_at: Date | string;
}

export function maskBankAccountPreview(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 4) return '****';
  const shown = Math.min(4, Math.max(2, Math.floor(trimmed.length / 2) - 1));
  return `****${trimmed.slice(-shown)}`;
}

function mapSubmissionView(row: RawOnboardingRow, bankAccountMasked: string | null): HrOnboardingSubmissionView {
  const erased = row.erased_at !== null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    legalEntityId: row.legal_entity_id,
    departmentName: erased ? null : row.department_name,
    status: row.status,
    contactConfirmed: row.contact_confirmed,
    idConfirmed: row.id_confirmed,
    bankConfirmed: row.bank_confirmed,
    handbookConfirmed: row.handbook_confirmed,
    address: erased ? null : row.address,
    birthDate: erased || row.birth_date === null ? null : iso(row.birth_date),
    bankCode: erased ? null : row.bank_code,
    bankAccountMasked: erased ? null : bankAccountMasked,
    hasIdentityNumber: !erased && row.national_id_sealed !== null,
    hasBankAccount: !erased && row.bank_account_sealed !== null,
    hasTaxCode: !erased && row.tax_code_sealed !== null,
    hasInsuranceNumber: !erased && row.insurance_number_sealed !== null,
    note: erased ? null : row.note,
    decisionNote: erased ? null : row.decision_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function querySubmissionViews(
  ctx: QueryContext,
  orgId: string,
  filters: { employeeId?: string; status?: HrOnboardingStatus; limit: number },
): Promise<HrOnboardingSubmissionView[]> {
  let q = ctx.trx
    .selectFrom('ludy_hr.onboarding_submission as s')
    .innerJoin('ludy_hr.payroll_employee as e', (j) =>
      j.onRef('e.org_id', '=', 's.org_id').onRef('e.id', '=', 's.employee_id'),
    )
    .leftJoin('ludy_hr.department as d', (j) =>
      j.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'),
    )
    .select([
      's.id',
      's.legal_entity_id',
      's.employee_id',
      'e.display_name as employee_name',
      'e.erased_at',
      'd.name as department_name',
      's.status',
      's.contact_confirmed',
      's.id_confirmed',
      's.bank_confirmed',
      's.handbook_confirmed',
      's.address',
      's.birth_date',
      's.national_id_sealed',
      's.bank_code',
      's.bank_account_sealed',
      's.tax_code_sealed',
      's.insurance_number_sealed',
      's.note',
      's.decision_note',
      's.reviewed_by',
      's.reviewed_at',
      's.created_at',
    ])
    .where('s.org_id', '=', orgId)
    .orderBy('s.created_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(filters.limit);

  if (filters.employeeId !== undefined) {
    q = q.where('s.employee_id', '=', filters.employeeId);
  }
  if (filters.status !== undefined) {
    q = q.where('s.status', '=', filters.status);
  }
  const rows = (await q.execute()) as RawOnboardingRow[];
  const sealedItems: { sealed: string; place: string; ref: string }[] = [];
  const sealedRowIndex: number[] = [];
  rows.forEach((row, index) => {
    if (row.erased_at === null && row.bank_account_sealed !== null) {
      sealedItems.push({ sealed: row.bank_account_sealed, place: ACCOUNT_PLACE, ref: subjectOf(row.employee_id) });
      sealedRowIndex.push(index);
    }
  });
  const opened = sealedItems.length === 0 ? [] : await ctx.openMany(sealedItems);
  const maskedByRow = new Map<number, string>();
  sealedRowIndex.forEach((rowIdx, itemIdx) => {
    const val = opened[itemIdx];
    if (typeof val === 'string') {
      maskedByRow.set(rowIdx, maskBankAccountPreview(val));
    }
  });
  return rows.map((row, index) => mapSubmissionView(row, maskedByRow.get(index) ?? null));
}

export const selfOnboardingGet = defineQuery({
  name: 'hr.self.onboarding.get',
  input: zHrSelfOnboardingGetAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx): Promise<HrSelfOnboardingState> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    const record = await ctx.trx
      .selectFrom('ludy_hr.payroll_employee')
      .select([
        'address',
        'birth_date',
        'national_id_sealed',
        'bank_code',
        'bank_account_sealed',
        'tax_code_sealed',
        'insurance_number_sealed',
        'erased_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', emp.id)
      .executeTakeFirstOrThrow();

    const submissions = await querySubmissionViews(ctx, ctx.orgId, {
      employeeId: emp.id,
      limit: 50,
    });
    const approved = submissions.filter((s) => s.status === 'approved');
    const erased = record.erased_at !== null;

    return {
      employeeId: emp.id,
      checklist: {
        hasAddress: !erased && record.address !== null,
        hasBirthDate: !erased && record.birth_date !== null,
        hasIdentityNumber: !erased && record.national_id_sealed !== null,
        hasBankAccount: !erased && record.bank_account_sealed !== null,
        bankCode: erased ? null : record.bank_code,
        hasTaxCode: !erased && record.tax_code_sealed !== null,
        hasInsuranceNumber: !erased && record.insurance_number_sealed !== null,
        contactConfirmed: approved.some((s) => s.contactConfirmed),
        idConfirmed: approved.some((s) => s.idConfirmed),
        bankConfirmed: approved.some((s) => s.bankConfirmed),
        handbookConfirmed: approved.some((s) => s.handbookConfirmed),
      },
      submissions,
    };
  },
});

export const selfOnboardingSubmit = defineCommand({
  name: 'hr.self.onboarding.submit',
  input: zHrSelfOnboardingSubmit,
  sealedInput: ['identityNumber', 'accountNumber', 'taxCode', 'insuranceNumber'],
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'onboarding_submission', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'status',
      'contact_confirmed',
      'id_confirmed',
      'bank_confirmed',
      'handbook_confirmed',
      'address',
      'birth_date',
      'national_id_sealed',
      'bank_code',
      'bank_account_sealed',
      'tax_code_sealed',
      'insurance_number_sealed',
      'note',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrSelfOnboardingSubmitResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, emp.id);
    const record = await ctx.trx
      .selectFrom('ludy_hr.payroll_employee')
      .select(['status', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', emp.id)
      .executeTakeFirst();
    if (!record || record.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu');
    }
    if (record.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã nghỉ việc, không thể gửi phiếu xác nhận');
    }
    if ((input.bankCode !== undefined) !== (input.accountNumber !== undefined)) {
      throw new DomainError('VALIDATION', 422, 'Khi cập nhật ngân hàng cần nhập đầy đủ cả mã ngân hàng và số tài khoản');
    }
    if (input.bankCode !== undefined) {
      requireKnownBank(input.bankCode);
    }

    const existingPending = await ctx.trx
      .selectFrom('ludy_hr.onboarding_submission')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('status', '=', 'pending')
      .limit(1)
      .executeTakeFirst();
    if (existingPending) {
      throw invalidOnboardingState(
        'Bạn đã có một phiếu xác nhận thông tin đang chờ duyệt; vui lòng hủy hoặc chờ xử lý trước khi gửi phiếu mới',
      );
    }

    const subject = subjectOf(emp.id);
    const nationalIdSealed = input.identityNumber !== undefined ? await ctx.seal(subject, IDENTITY_PLACE, input.identityNumber) : null;
    const bankAccountSealed = input.accountNumber !== undefined ? await ctx.seal(subject, ACCOUNT_PLACE, input.accountNumber) : null;
    const taxCodeSealed = input.taxCode !== undefined ? await ctx.seal(subject, TAX_CODE_PLACE, input.taxCode) : null;
    const insuranceSealed = input.insuranceNumber !== undefined ? await ctx.seal(subject, INSURANCE_PLACE, input.insuranceNumber) : null;

    let inserted: { id: string; legal_entity_id: string };
    try {
      inserted = await ctx.trx
        .insertInto('ludy_hr.onboarding_submission')
        .values({
          org_id: ctx.orgId,
          employee_id: emp.id,
          status: 'pending',
          contact_confirmed: input.contactConfirmed,
          id_confirmed: input.idConfirmed,
          bank_confirmed: input.bankConfirmed,
          handbook_confirmed: input.handbookConfirmed,
          address: input.address ?? null,
          birth_date: input.birthDate ?? null,
          national_id_sealed: nationalIdSealed,
          bank_code: input.bankCode ?? null,
          bank_account_sealed: bankAccountSealed,
          tax_code_sealed: taxCodeSealed,
          insurance_number_sealed: insuranceSealed,
          note: input.note ?? null,
          created_by: callerUserId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returning(['id', 'legal_entity_id'])
        .executeTakeFirstOrThrow();
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'onboarding_submission_one_pending_uq') {
        throw invalidOnboardingState(
          'Bạn đã có một phiếu xác nhận thông tin đang chờ duyệt; vui lòng hủy hoặc chờ xử lý trước khi gửi phiếu mới',
        );
      }
      throw error;
    }

    ctx.audit({
      submissionId: inserted.id,
      employeeId: emp.id,
      legalEntityId: inserted.legal_entity_id,
      contactConfirmed: input.contactConfirmed,
      idConfirmed: input.idConfirmed,
      bankConfirmed: input.bankConfirmed,
      handbookConfirmed: input.handbookConfirmed,
      ...(input.address !== undefined ? { address: auditValue(ONBOARDING, 'address', input.address) } : {}),
      ...(input.birthDate !== undefined ? { birthDate: auditValue(ONBOARDING, 'birth_date', input.birthDate) } : {}),
      ...(input.bankCode !== undefined ? { bankCode: auditValue(ONBOARDING, 'bank_code', input.bankCode) } : {}),
      ...(nationalIdSealed !== null ? { hasIdentityNumber: true } : {}),
      ...(bankAccountSealed !== null ? { hasBankAccount: true } : {}),
      ...(taxCodeSealed !== null ? { hasTaxCode: true } : {}),
      ...(insuranceSealed !== null ? { hasInsuranceNumber: true } : {}),
      ...(input.note !== undefined ? { note: auditValue(ONBOARDING, 'note', input.note) } : {}),
    });

    return { submissionId: inserted.id, status: 'pending' };
  },
});

export const selfOnboardingCancel = defineCommand({
  name: 'hr.self.onboarding.cancel',
  input: zHrOnboardingSubmissionRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { submissionId: string }) => ({ type: 'hr.onboarding_submission', id: input.submissionId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'onboarding_submission', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOnboardingCancelResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await preReadAndLockEmployeeErasure(ctx.trx, ctx.orgId, input.submissionId);

    const existing = await ctx.trx
      .selectFrom('ludy_hr.onboarding_submission')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.submissionId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw submissionNotFound();
    if (existing.employee_id !== emp.id) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ nhân viên đã gửi mới có thể hủy phiếu này');
    }
    if (existing.status !== 'pending') {
      throw invalidOnboardingState('Chỉ hủy được phiếu xác nhận đang chờ duyệt');
    }

    await ctx.trx
      .updateTable('ludy_hr.onboarding_submission')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({ submissionId: existing.id, employeeId: existing.employee_id });
    return { submissionId: existing.id, status: 'cancelled' };
  },
});

export const onboardingList = defineQuery({
  name: 'hr.onboarding.list',
  input: zHrOnboardingList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrOnboardingSubmissionView[]> => {
    userOf(ctx.actor);
    return querySubmissionViews(ctx, ctx.orgId, {
      ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      limit: input.limit,
    });
  },
});

export const onboardingApprove = defineCommand({
  name: 'hr.onboarding.approve',
  input: zHrOnboardingDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { submissionId: string }) => ({ type: 'hr.onboarding_submission', id: input.submissionId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'onboarding_submission', [
      'status',
      'decision_note',
      'reviewed_by',
      'reviewed_at',
      'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_employee', [
      'address',
      'birth_date',
      'national_id_sealed',
      'bank_code',
      'bank_account_sealed',
      'tax_code_sealed',
      'insurance_number_sealed',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrOnboardingApproveResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    const preRead = await preReadAndLockEmployeeErasure(ctx.trx, ctx.orgId, input.submissionId);
    const selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, preRead.employee_id, true);

    const emp = await ctx.trx
      .selectFrom('ludy_hr.payroll_employee')
      .select(['id', 'status', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', preRead.employee_id)
      .forUpdate()
      .executeTakeFirst();
    if (!emp || emp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã xóa theo yêu cầu, không thể áp dụng thay đổi');
    }
    if (emp.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã nghỉ việc, không thể cập nhật hồ sơ từ phiếu xác nhận');
    }

    const existing = await ctx.trx
      .selectFrom('ludy_hr.onboarding_submission')
      .select([
        'id',
        'employee_id',
        'status',
        'address',
        'birth_date',
        'national_id_sealed',
        'bank_code',
        'bank_account_sealed',
        'tax_code_sealed',
        'insurance_number_sealed',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.submissionId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw submissionNotFound();
    if (existing.status !== 'pending') {
      throw invalidOnboardingState('Phiếu xác nhận này đã được xử lý trước đó');
    }

    if ((existing.bank_code !== null) !== (existing.bank_account_sealed !== null)) {
      throw new DomainError('VALIDATION', 422, 'Thông tin ngân hàng phải có đủ cả mã ngân hàng và số tài khoản đi kèm');
    }
    if (existing.bank_code !== null) {
      requireKnownBank(existing.bank_code);
    }

    const empPatch: {
      address?: string;
      birth_date?: string;
      national_id_sealed?: string;
      bank_code?: string;
      bank_account_sealed?: string;
      tax_code_sealed?: string;
      insurance_number_sealed?: string;
      updated_at: Date;
    } = { updated_at: ctx.now };
    const updatedFields: string[] = [];
    if (existing.address !== null) {
      empPatch.address = existing.address;
      updatedFields.push('address');
    }
    if (existing.birth_date !== null) {
      empPatch.birth_date = existing.birth_date;
      updatedFields.push('birthDate');
    }
    if (existing.national_id_sealed !== null) {
      empPatch.national_id_sealed = existing.national_id_sealed;
      updatedFields.push('identityNumber');
    }
    if (existing.bank_code !== null) {
      empPatch.bank_code = existing.bank_code;
      updatedFields.push('bankCode');
    }
    if (existing.bank_account_sealed !== null) {
      empPatch.bank_account_sealed = existing.bank_account_sealed;
      updatedFields.push('accountNumber');
    }
    if (existing.tax_code_sealed !== null) {
      empPatch.tax_code_sealed = existing.tax_code_sealed;
      updatedFields.push('taxCode');
    }
    if (existing.insurance_number_sealed !== null) {
      empPatch.insurance_number_sealed = existing.insurance_number_sealed;
      updatedFields.push('insuranceNumber');
    }

    if (updatedFields.length > 0) {
      await ctx.trx
        .updateTable('ludy_hr.payroll_employee')
        .set(empPatch)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.employee_id)
        .execute();
    }

    await ctx.trx
      .updateTable('ludy_hr.onboarding_submission')
      .set({
        status: 'approved',
        reviewed_by: callerUserId,
        reviewed_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const noted = input.note !== undefined;
    ctx.audit({
      submissionId: existing.id,
      employeeId: existing.employee_id,
      updatedFields,
      selfApproved,
      noted,
      ...(updatedFields.includes('address') ? { address: auditValue(EMPLOYEE, 'address', existing.address) } : {}),
      ...(updatedFields.includes('birthDate') ? { birthDate: auditValue(EMPLOYEE, 'birth_date', existing.birth_date) } : {}),
      ...(updatedFields.includes('bankCode') ? { bankCode: auditValue(EMPLOYEE, 'bank_code', existing.bank_code) } : {}),
    });

    return {
      submissionId: existing.id,
      employeeId: existing.employee_id,
      status: 'approved',
      updatedFields,
    };
  },
});

export const onboardingReject = defineCommand({
  name: 'hr.onboarding.reject',
  input: zHrOnboardingDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input: { submissionId: string }) => ({ type: 'hr.onboarding_submission', id: input.submissionId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'onboarding_submission', [
      'status',
      'decision_note',
      'reviewed_by',
      'reviewed_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrOnboardingRejectResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    await preReadAndLockEmployeeErasure(ctx.trx, ctx.orgId, input.submissionId);

    const existing = await ctx.trx
      .selectFrom('ludy_hr.onboarding_submission')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.submissionId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw submissionNotFound();

    const selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, existing.employee_id, true);
    if (existing.status !== 'pending') {
      throw invalidOnboardingState('Phiếu xác nhận này đã được xử lý trước đó');
    }

    await ctx.trx
      .updateTable('ludy_hr.onboarding_submission')
      .set({
        status: 'rejected',
        reviewed_by: callerUserId,
        reviewed_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const noted = input.note !== undefined;
    ctx.audit({
      submissionId: existing.id,
      employeeId: existing.employee_id,
      selfApproved,
      noted,
    });

    return {
      submissionId: existing.id,
      employeeId: existing.employee_id,
      status: 'rejected',
    };
  },
});

export const hrOnboardingCommands = [
  selfOnboardingSubmit,
  selfOnboardingCancel,
  onboardingApprove,
  onboardingReject,
];

export const hrOnboardingQueries = [
  selfOnboardingGet,
  onboardingList,
];
