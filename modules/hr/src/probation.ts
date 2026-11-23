// SPDX-License-Identifier: AGPL-3.0-only
// HR end-of-probation review domain queries and commands (#4448, Stage 5B).
// Pulls completed Ludy Cong tac (ludy_projects) tasks via ctx.query respecting org_app_on and caller RLS,
// aggregates deterministic attendance/leave/OT metrics, and stores human review decisions.
import { sql } from 'kysely';
import {
  auditValue,
  tableWrite,
  vietnamToday,
  zHrProbationAiStatusAsk,
  zHrProbationBriefAudit,
  zHrProbationDecide,
  zHrProbationList,
  zHrProbationPreviewAsk,
  type HrProbationAttendanceSummary,
  type HrProbationDecideResult,
  type HrProbationDecision,
  type HrProbationPreviewResult,
  type HrProbationReviewView,
  type HrProbationTaskFact,
  type ProjectMemberCompletedTasksResult,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { MANAGERS, lockEmployeeErasure, userOf } from './employees.ts';
import { assertNotSelfApprover } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';

const PROBATION = hrManifest.tables.ludy_hr.probation_review;

export interface HrProbationBriefSource {
  preview: HrProbationPreviewResult;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

const formatDecimalString = (val: ReturnType<typeof money>): string => {
  const fixed = val.toDecimalPlaces(2).toFixed();
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
};

function parseTaskSnapshot(value: unknown): HrProbationTaskFact[] {
  if (!Array.isArray(value)) return [];
  const out: HrProbationTaskFact[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.taskId !== 'string' || typeof rec.title !== 'string' || typeof rec.completedAt !== 'string') {
      continue;
    }
    out.push({
      taskId: rec.taskId,
      title: rec.title,
      projectId: typeof rec.projectId === 'string' ? rec.projectId : null,
      projectName: typeof rec.projectName === 'string' ? rec.projectName : null,
      completedAt: rec.completedAt,
    });
  }
  return out;
}

function parseAttendanceSnapshot(value: unknown): HrProbationAttendanceSummary {
  const empty: HrProbationAttendanceSummary = {
    monthCount: 0,
    annualLeaveDays: '0',
    personalPaidLeaveDays: '0',
    unpaidLeaveDays: '0',
    sicknessBhxhDays: '0',
    maternityBhxhDays: '0',
    overtimeHours: '0',
    overtimeRequestsCount: 0,
  };
  if (!value || typeof value !== 'object') return empty;
  const rec = value as Record<string, unknown>;
  return {
    monthCount: typeof rec.monthCount === 'number' ? rec.monthCount : 0,
    annualLeaveDays: typeof rec.annualLeaveDays === 'string' ? rec.annualLeaveDays : '0',
    personalPaidLeaveDays: typeof rec.personalPaidLeaveDays === 'string' ? rec.personalPaidLeaveDays : '0',
    unpaidLeaveDays: typeof rec.unpaidLeaveDays === 'string' ? rec.unpaidLeaveDays : '0',
    sicknessBhxhDays: typeof rec.sicknessBhxhDays === 'string' ? rec.sicknessBhxhDays : '0',
    maternityBhxhDays: typeof rec.maternityBhxhDays === 'string' ? rec.maternityBhxhDays : '0',
    overtimeHours: typeof rec.overtimeHours === 'string' ? rec.overtimeHours : '0',
    overtimeRequestsCount: typeof rec.overtimeRequestsCount === 'number' ? rec.overtimeRequestsCount : 0,
  };
}

async function loadProbationFacts(
  ctx: QueryContext,
  employeeId: string,
  requestedPeriodStart?: string,
  requestedPeriodEnd?: string,
): Promise<HrProbationPreviewResult> {
  const emp = await ctx.trx
    .selectFrom('ludy_hr.payroll_employee as e')
    .leftJoin('ludy_hr.department as d', (j) =>
      j.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'),
    )
    .select([
      'e.id',
      'e.display_name',
      'e.user_id',
      'e.job_title',
      'e.erased_at',
      'd.name as department_name',
    ])
    .where('e.org_id', '=', ctx.orgId)
    .where('e.id', '=', employeeId)
    .executeTakeFirst();
  if (!emp) {
    throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
  }
  if (emp.erased_at !== null) {
    throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
  }

  const terms = await ctx.trx
    .selectFrom('ludy_hr.payroll_employment')
    .select(['effective_from', 'probation_end_on'])
    .where('org_id', '=', ctx.orgId)
    .where('employee_id', '=', emp.id)
    .orderBy('effective_from', 'asc')
    .execute();

  const firstTerm = terms[0];
  const latestTerm = terms[terms.length - 1];
  const today = vietnamToday();
  const probationEndOn = latestTerm?.probation_end_on ? iso(latestTerm.probation_end_on) : null;
  const periodStart = requestedPeriodStart ?? (firstTerm ? iso(firstTerm.effective_from) : today);
  const defaultEnd = probationEndOn && probationEndOn >= periodStart ? probationEndOn : today >= periodStart ? today : periodStart;
  const periodEnd = requestedPeriodEnd ?? defaultEnd;
  if (periodEnd < periodStart) {
    throw new DomainError('HR_PROBATION_PERIOD_INVALID', 422, 'Ngày kết thúc đánh giá phải từ ngày bắt đầu trở đi');
  }

  const startMonth = periodStart.slice(0, 7);
  const endMonth = periodEnd.slice(0, 7);
  const leaveRows = await ctx.trx
    .selectFrom('ludy_hr.payroll_leave_entry')
    .select(['month', 'kind', 'days', 'approved'])
    .where('org_id', '=', ctx.orgId)
    .where('employee_id', '=', emp.id)
    .where('month', '>=', startMonth)
    .where('month', '<=', endMonth)
    .execute();

  const monthsSeen = new Set<string>();
  let annualLeave = money(0);
  let personalPaidLeave = money(0);
  let unpaidLeave = money(0);
  let sicknessBhxh = money(0);
  let maternityBhxh = money(0);
  for (const row of leaveRows) {
    monthsSeen.add(row.month);
    if (row.kind !== 'unpaid_leave' && !row.approved) continue;
    const d = money(row.days);
    if (row.kind === 'annual_leave') annualLeave = annualLeave.plus(d);
    else if (row.kind === 'personal_paid') personalPaidLeave = personalPaidLeave.plus(d);
    else if (row.kind === 'unpaid_leave') unpaidLeave = unpaidLeave.plus(d);
    else if (row.kind === 'sickness_bhxh') sicknessBhxh = sicknessBhxh.plus(d);
    else if (row.kind === 'maternity_bhxh') maternityBhxh = maternityBhxh.plus(d);
  }

  const otRows = await ctx.trx
    .selectFrom('ludy_hr.overtime_request')
    .select(['month', 'hours'])
    .where('org_id', '=', ctx.orgId)
    .where('employee_id', '=', emp.id)
    .where('status', '=', 'approved')
    .where('work_date', '>=', periodStart)
    .where('work_date', '<=', periodEnd)
    .execute();

  let otHours = money(0);
  for (const row of otRows) {
    monthsSeen.add(row.month);
    otHours = otHours.plus(money(row.hours));
  }

  let projectsAvailable = false;
  let completedTasksCount = 0;
  let completedTasks: HrProbationTaskFact[] = [];
  if (emp.user_id !== null) {
    const res = await ctx.query<ProjectMemberCompletedTasksResult>('projects.member_completed_tasks', {
      userId: emp.user_id,
      from: periodStart,
      to: periodEnd,
      limit: 50,
    });
    if (res.status === 'ok') {
      projectsAvailable = true;
      completedTasksCount = res.value.totalCount;
      completedTasks = res.value.tasks;
    }
  }

  return {
    employeeId: emp.id,
    employeeName: emp.display_name,
    linkedUserId: emp.user_id,
    departmentName: emp.department_name ?? null,
    jobTitle: emp.job_title,
    probationEndOn,
    periodStart,
    periodEnd,
    projectsAvailable,
    completedTasksCount,
    completedTasks,
    attendance: {
      monthCount: monthsSeen.size,
      annualLeaveDays: formatDecimalString(annualLeave),
      personalPaidLeaveDays: formatDecimalString(personalPaidLeave),
      unpaidLeaveDays: formatDecimalString(unpaidLeave),
      sicknessBhxhDays: formatDecimalString(sicknessBhxh),
      maternityBhxhDays: formatDecimalString(maternityBhxh),
      overtimeHours: formatDecimalString(otHours),
      overtimeRequestsCount: otRows.length,
    },
  };
}

export const probationPreview = defineQuery({
  name: 'hr.probation.preview',
  input: zHrProbationPreviewAsk,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrProbationPreviewResult> => {
    userOf(ctx.actor);
    return loadProbationFacts(ctx, input.employeeId, input.periodStart, input.periodEnd);
  },
});

export const probationBriefRead = defineQuery({
  name: 'hr.probation.brief.read',
  input: zHrProbationPreviewAsk,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrProbationBriefSource> => {
    userOf(ctx.actor);
    const preview = await loadProbationFacts(ctx, input.employeeId, input.periodStart, input.periodEnd);
    const { rows: metaRows } = await sql<{ ai_stopped: boolean; budget_spent: boolean }>`
      SELECT
        (
          ludy_kernel.global_kill_switch_on('ai')
          OR EXISTS (
            SELECT 1 FROM ludy_kernel.kill_switch k
             WHERE k.org_id = ${ctx.orgId}::uuid
               AND k.released_at IS NULL
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target IN ('hr', 'projects')))
          )
        ) AS ai_stopped,
        ludy_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, 'hr', NULL::uuid) AS budget_spent
    `.execute(ctx.trx);
    const meta = metaRows[0];
    return {
      preview,
      aiStopped: meta?.ai_stopped === true,
      aiBudgetSpent: meta?.budget_spent === true,
    };
  },
});

export const probationAiStatus = defineQuery({
  name: 'hr.probation.ai_status',
  input: zHrProbationAiStatusAsk,
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
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target IN ('hr', 'projects')))
          )
        ) AS ai_stopped
    `.execute(ctx.trx);
    return { aiStopped: rows[0]?.ai_stopped === true };
  },
});

export const probationBriefAudit = defineCommand({
  name: 'hr.probation.brief.audit',
  input: zHrProbationBriefAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.payroll_employee', id: input.employeeId }),
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      employeeId: input.employeeId,
      aiStatus: input.aiStatus,
      completedTasksCount: input.completedTasksCount,
    });
    return { ok: true };
  },
});

export const probationDecide = defineCommand({
  name: 'hr.probation.decide',
  input: zHrProbationDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input) => ({ type: 'hr.payroll_employee', id: input.employeeId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'probation_review', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'reviewer_user_id',
      'probation_end_on',
      'period_start',
      'period_end',
      'completed_tasks_count',
      'completed_tasks_snapshot',
      'projects_available',
      'attendance_snapshot',
      'decision',
      'extended_until',
      'review_note',
      'ai_draft_note',
      'decided_at',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrProbationDecideResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    await lockEmployeeErasure(ctx.trx, ctx.orgId, input.employeeId);
    const lockedEmp = await ctx.trx
      .selectFrom('ludy_hr.payroll_employee')
      .select(['id', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .forUpdate()
      .executeTakeFirst();
    if (!lockedEmp) {
      throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
    }
    if (lockedEmp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }

    const selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, input.employeeId, true);
    const facts = await loadProbationFacts(ctx, input.employeeId, input.periodStart, input.periodEnd);

    const inserted = await ctx.trx
      .insertInto('ludy_hr.probation_review')
      .values({
        org_id: ctx.orgId,
        employee_id: input.employeeId,
        reviewer_user_id: callerUserId,
        probation_end_on: input.probationEndOn ?? facts.probationEndOn,
        period_start: facts.periodStart,
        period_end: facts.periodEnd,
        completed_tasks_count: facts.completedTasksCount,
        completed_tasks_snapshot: JSON.stringify(facts.completedTasks),
        projects_available: facts.projectsAvailable,
        attendance_snapshot: JSON.stringify(facts.attendance),
        decision: input.decision,
        extended_until: input.decision === 'extend' ? (input.extendedUntil ?? null) : null,
        review_note: input.reviewNote ?? null,
        ai_draft_note: input.aiDraftNote ?? null,
        decided_at: ctx.now,
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'legal_entity_id'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      reviewId: inserted.id,
      employeeId: input.employeeId,
      legalEntityId: inserted.legal_entity_id,
      decision: input.decision,
      completedTasksCount: facts.completedTasksCount,
      projectsAvailable: facts.projectsAvailable,
      selfApproved,
      ...(input.reviewNote !== undefined ? { reviewNote: auditValue(PROBATION, 'review_note', input.reviewNote) } : {}),
      ...(input.aiDraftNote !== undefined && input.aiDraftNote !== null
        ? { aiDraftNote: auditValue(PROBATION, 'ai_draft_note', input.aiDraftNote) }
        : {}),
    });

    return { reviewId: inserted.id, decision: input.decision };
  },
});

export const probationList = defineQuery({
  name: 'hr.probation.list',
  input: zHrProbationList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrProbationReviewView[]> => {
    userOf(ctx.actor);
    let q = ctx.trx
      .selectFrom('ludy_hr.probation_review as r')
      .innerJoin('ludy_hr.payroll_employee as e', (j) =>
        j.onRef('e.org_id', '=', 'r.org_id').onRef('e.id', '=', 'r.employee_id'),
      )
      .select([
        'r.id',
        'r.employee_id',
        'e.display_name as employee_name',
        'r.reviewer_user_id',
        'r.probation_end_on',
        'r.period_start',
        'r.period_end',
        'r.completed_tasks_count',
        'r.completed_tasks_snapshot',
        'r.projects_available',
        'r.attendance_snapshot',
        'r.decision',
        'r.extended_until',
        'r.review_note',
        'r.ai_draft_note',
        'r.decided_at',
        'r.created_at',
      ])
      .where('r.org_id', '=', ctx.orgId)
      .orderBy('r.decided_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(input.limit);

    if (input.employeeId !== undefined) q = q.where('r.employee_id', '=', input.employeeId);
    if (input.decision !== undefined) q = q.where('r.decision', '=', input.decision);

    const rows = await q.execute();
    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      reviewerUserId: row.reviewer_user_id,
      probationEndOn: row.probation_end_on === null ? null : iso(row.probation_end_on),
      periodStart: iso(row.period_start),
      periodEnd: iso(row.period_end),
      completedTasksCount: row.completed_tasks_count,
      completedTasks: parseTaskSnapshot(row.completed_tasks_snapshot),
      projectsAvailable: row.projects_available,
      attendance: parseAttendanceSnapshot(row.attendance_snapshot),
      decision: row.decision as HrProbationDecision,
      extendedUntil: row.extended_until === null ? null : iso(row.extended_until),
      reviewNote: row.review_note,
      aiDraftNote: row.ai_draft_note,
      decidedAt: new Date(row.decided_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  },
});

export const hrProbationCommands = [probationBriefAudit, probationDecide];
export const hrProbationQueries = [probationPreview, probationBriefRead, probationAiStatus, probationList];
