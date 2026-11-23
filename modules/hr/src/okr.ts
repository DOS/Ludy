// SPDX-License-Identifier: AGPL-3.0-only
// HR quarterly OKRs/goals aligned Company -> Department -> Employee with caller-scoped Ludy Cong tac linkage (#4529, Stage 6D).
// Zero edits to ludy_projects RLS: all task/project reads run strictly via ctx.query as the calling user with manual fallback when disabled or private.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { memberProfiles } from '@ludy/kernel';
import {
  auditValue,
  tableWrite,
  vietnamToday,
  zHrOkrAiStatusAsk,
  zHrOkrDraftAudit,
  zHrOkrDraftCheckinAsk,
  zHrOkrKeyResultAdd,
  zHrOkrKeyResultCheckin,
  zHrOkrKeyResultRemove,
  zHrOkrKeyResultSyncProjects,
  zHrOkrKeyResultUpdate,
  zHrOkrObjectiveCreate,
  zHrOkrObjectiveSetStatus,
  zHrOkrObjectiveUpdate,
  zHrOkrProjectOptionsAsk,
  zHrOkrProjectTasksAsk,
  zHrOkrTreeAsk,
  type HrOkrDraftReadResult,
  type HrOkrKeyResultMutationResult,
  type HrOkrKeyResultRemoveResult,
  type HrOkrKeyResultView,
  type HrOkrLinkedTaskView,
  type HrOkrMetricType,
  type HrOkrObjectiveMutationResult,
  type HrOkrObjectiveView,
  type HrOkrProjectOption,
  type HrOkrProjectOptionsResult,
  type HrOkrProjectTasksResult,
  type HrOkrScope,
  type HrOkrStatus,
  type HrOkrTreeResult,
  type ProjectBoard,
  type ProjectListResult,
  type ProjectSummary,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { memberLabel, userOf } from './employees.ts';
import { hrManifest } from './manifest.ts';
import { isoDate } from './payroll-dates.ts';

const KEY_RESULT = hrManifest.tables.ludy_hr.okr_key_result;

const STAFF_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

type VisibleEmployeeRow = {
  id: string;
  legal_entity_id: string;
  department_id: string | null;
  display_name: string;
  job_title: string | null;
  status: string;
};

type VisibleDepartmentRow = {
  id: string;
  legal_entity_id: string;
  name: string;
  manager_user_id: string | null;
  archived_at: Date | null;
};

type CallerOkrContext = {
  userId: string;
  isAdminOrOwner: boolean;
  selfEmployeeId: string | null;
  managedDeptIds: Set<string>;
  visibleEmployeesById: Map<string, VisibleEmployeeRow>;
  visibleDeptsById: Map<string, VisibleDepartmentRow>;
};

export interface HrOkrDraftSource {
  facts: HrOkrDraftReadResult;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

export function currentVietnamQuarter(now: Date): string {
  const day = vietnamToday(now);
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${q}`;
}

export function formatOkrDecimal(val: ReturnType<typeof money>): string {
  const fixed = val.toDecimalPlaces(2).toFixed();
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function computeKrProgressPct(metricType: HrOkrMetricType, currentStr: string, targetStr: string): string {
  const cur = money(currentStr);
  const tgt = money(targetStr);
  if (tgt.lte(0)) {
    return metricType === 'project_tasks' ? '0' : '0';
  }
  const pct = cur.div(tgt).mul(100);
  if (pct.lte(0)) return '0';
  if (pct.gte(100)) return '100';
  return formatOkrDecimal(pct);
}

export function computeObjectiveProgressPct(keyResults: readonly { progressPct: string }[]): string {
  if (keyResults.length === 0) return '0';
  let sum = money('0');
  for (const kr of keyResults) {
    sum = sum.plus(money(kr.progressPct));
  }
  return formatOkrDecimal(sum.div(keyResults.length));
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const objectiveNotFound = () => new DomainError('HR_OKR_OBJECTIVE_NOT_FOUND', 404, 'Không tìm thấy mục tiêu OKR này');
const keyResultNotFound = () => new DomainError('HR_OKR_KEY_RESULT_NOT_FOUND', 404, 'Không tìm thấy kết quả then chốt này');
const okrForbidden = () => new DomainError('FORBIDDEN', 403, 'Bạn không có quyền thực hiện thao tác OKR này');

async function loadCallerOkrContext(ctx: QueryContext): Promise<CallerOkrContext> {
  const userId = userOf(ctx.actor);

  const [memberRow, { rows: empRows }, deptRows, selfRows] = await Promise.all([
    ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('role')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    sql<VisibleEmployeeRow>`
      SELECT id, legal_entity_id, department_id, display_name, job_title, status
        FROM ludy_hr.okr_visible_employees(${ctx.orgId}::uuid)
    `.execute(ctx.trx),
    ctx.trx
      .selectFrom('ludy_hr.department')
      .select(['id', 'legal_entity_id', 'name', 'manager_user_id', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('name', 'asc')
      .execute(),
    ctx.trx
      .selectFrom('ludy_hr.payroll_employee')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('erased_at', 'is', null)
      .execute(),
  ]);

  const isAdminOrOwner = memberRow?.role === 'owner' || memberRow?.role === 'admin';

  const visibleEmployeesById = new Map<string, VisibleEmployeeRow>();
  for (const row of empRows) {
    visibleEmployeesById.set(row.id, row);
  }
  const visibleDeptsById = new Map<string, VisibleDepartmentRow>();
  const managedDeptIds = new Set<string>();
  for (const dept of deptRows) {
    visibleDeptsById.set(dept.id, dept);
    if (dept.archived_at === null && dept.manager_user_id === userId) {
      managedDeptIds.add(dept.id);
    }
  }

  return {
    userId,
    isAdminOrOwner,
    selfEmployeeId: selfRows[0]?.id ?? null,
    managedDeptIds,
    visibleEmployeesById,
    visibleDeptsById,
  };
}

function canManageObjective(
  caller: CallerOkrContext,
  obj: { scope: HrOkrScope; department_id: string | null; owner_employee_id: string | null },
): boolean {
  if (caller.isAdminOrOwner) return true;
  if (obj.scope === 'company') return false;
  if (obj.scope === 'department') {
    return obj.department_id !== null && caller.managedDeptIds.has(obj.department_id);
  }
  if (obj.department_id !== null && caller.managedDeptIds.has(obj.department_id)) {
    return true;
  }
  if (obj.owner_employee_id !== null) {
    const ownerEmp = caller.visibleEmployeesById.get(obj.owner_employee_id);
    if (ownerEmp?.department_id !== null && ownerEmp?.department_id !== undefined) {
      return caller.managedDeptIds.has(ownerEmp.department_id);
    }
  }
  return false;
}

function canCheckinObjective(
  caller: CallerOkrContext,
  obj: { scope: HrOkrScope; status: HrOkrStatus; department_id: string | null; owner_employee_id: string | null },
): boolean {
  if (obj.status === 'archived') return false;
  if (canManageObjective(caller, obj)) return true;
  return (
    obj.scope === 'individual' &&
    obj.status === 'active' &&
    caller.selfEmployeeId !== null &&
    obj.owner_employee_id === caller.selfEmployeeId
  );
}

async function resolveDefaultLegalEntity(ctx: QueryContext): Promise<string> {
  const { rows: scopeRows } = await sql<{ scope: string[] }>`SELECT ludy_kernel.ctx_le_scope()::text[] AS scope`.execute(ctx.trx);
  const scope = scopeRows[0]?.scope ?? ['*'];
  let q = ctx.trx
    .selectFrom('ludy_kernel.legal_entity')
    .select(['id', 'is_default'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('is_default', 'desc');
  if (scope.length > 0 && !scope.includes('*')) {
    q = q.where('id', 'in', [...scope]);
  }
  const row = await q.executeTakeFirst();
  if (!row) {
    throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Không tìm thấy pháp nhân hợp lệ trong phạm vi hiện tại');
  }
  return row.id;
}

type ProjectsSnapshot = {
  projectsAvailable: boolean;
  projectsById: Map<string, ProjectSummary>;
  boardsById: Map<string, ProjectBoard>;
};

async function loadProjectsSnapshot(ctx: QueryContext, projectIds: readonly string[]): Promise<ProjectsSnapshot> {
  const listRes = await ctx.query<ProjectListResult>('projects.project.list', {});
  if (listRes.status !== 'ok') {
    return {
      projectsAvailable: false,
      projectsById: new Map(),
      boardsById: new Map(),
    };
  }
  const projectsById = new Map<string, ProjectSummary>();
  for (const proj of listRes.value.projects) {
    projectsById.set(proj.id, proj);
  }
  const boardsById = new Map<string, ProjectBoard>();
  const uniqueProjectIds = uniqueIds(projectIds);
  for (const projectId of uniqueProjectIds) {
    if (!projectsById.has(projectId)) continue;
    try {
      const boardRes = await ctx.query<ProjectBoard>('projects.board', { projectId });
      if (boardRes.status === 'ok') {
        boardsById.set(projectId, boardRes.value);
      }
    } catch (err) {
      if (err instanceof DomainError && (err.status === 403 || err.status === 404)) {
        continue;
      }
      throw err;
    }
  }
  return { projectsAvailable: true, projectsById, boardsById };
}

function summarizeLinkedTasks(
  linkedProjectId: string | null,
  linkedTaskIds: readonly string[],
  projects: ProjectsSnapshot,
): {
  linkedProjectName: string | null;
  linkedProjectAccessible: boolean;
  linkedTasks: HrOkrLinkedTaskView[];
  completedLinkedTasks: number;
  totalLinkedTasks: number;
} {
  if (!linkedProjectId || !projects.projectsAvailable) {
    return {
      linkedProjectName: null,
      linkedProjectAccessible: false,
      linkedTasks: [],
      completedLinkedTasks: 0,
      totalLinkedTasks: linkedTaskIds.length,
    };
  }
  const summary = projects.projectsById.get(linkedProjectId);
  const board = projects.boardsById.get(linkedProjectId);
  if (!summary || !board) {
    return {
      linkedProjectName: summary?.name ?? null,
      linkedProjectAccessible: false,
      linkedTasks: [],
      completedLinkedTasks: 0,
      totalLinkedTasks: linkedTaskIds.length,
    };
  }
  const colNames = new Map<string, string>();
  for (const col of board.columns ?? []) {
    colNames.set(col.id, col.name);
  }
  const tasksById = new Map(board.tasks.map((t) => [t.id, t]));

  if (linkedTaskIds.length > 0) {
    const linkedTasks: HrOkrLinkedTaskView[] = [];
    let completed = 0;
    for (const taskId of linkedTaskIds) {
      const task = tasksById.get(taskId);
      if (!task) continue;
      const done = task.status === 'done';
      if (done) completed += 1;
      linkedTasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        completed: done,
        statusName: (task.columnId ? colNames.get(task.columnId) : null) ?? task.status,
      });
    }
    return {
      linkedProjectName: summary.name,
      linkedProjectAccessible: true,
      linkedTasks,
      completedLinkedTasks: completed,
      totalLinkedTasks: linkedTaskIds.length,
    };
  }

  const activeBoardTasks = board.tasks.filter((t) => t.status !== 'cancelled');
  const completed = activeBoardTasks.filter((t) => t.status === 'done').length;
  const linkedTasks: HrOkrLinkedTaskView[] = activeBoardTasks.slice(0, 50).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    completed: t.status === 'done',
    statusName: (t.columnId ? colNames.get(t.columnId) : null) ?? t.status,
  }));
  return {
    linkedProjectName: summary.name,
    linkedProjectAccessible: true,
    linkedTasks,
    completedLinkedTasks: completed,
    totalLinkedTasks: activeBoardTasks.length,
  };
}

function defaultTargetForMetric(metricType: HrOkrMetricType, explicitTarget: string | undefined, totalTasks: number): string {
  if (explicitTarget !== undefined) return explicitTarget;
  if (metricType === 'percent') return '100';
  if (metricType === 'boolean') return '1';
  if (metricType === 'project_tasks') return String(totalTasks);
  throw new DomainError('HR_OKR_TARGET_REQUIRED', 422, 'Cần nhập mục tiêu lớn hơn 0 cho chỉ số này');
}

function assertValidTargetValue(metricType: HrOkrMetricType, targetValue: string): void {
  if (metricType !== 'project_tasks' && money(targetValue).lte(0)) {
    throw new DomainError('HR_OKR_TARGET_POSITIVE', 422, 'Giá trị mục tiêu phải lớn hơn 0');
  }
}

export const hrOkrTree = defineQuery({
  name: 'hr.okr.tree',
  input: zHrOkrTreeAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrOkrTreeResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const activeQuarter = input.quarter ?? currentVietnamQuarter(new Date());

    const quarterRows = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .select('quarter')
      .distinct()
      .where('org_id', '=', ctx.orgId)
      .orderBy('quarter', 'desc')
      .execute();

    const availableQuarters = Array.from(new Set([activeQuarter, ...quarterRows.map((r) => r.quarter)])).sort().reverse();

    let objQuery = ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('quarter', '=', activeQuarter)
      .orderBy(sql`CASE scope WHEN 'company' THEN 0 WHEN 'department' THEN 1 ELSE 2 END`, 'asc')
      .orderBy('created_at', 'asc');

    if (!input.includeArchived) {
      objQuery = objQuery.where('status', '<>', 'archived');
    }
    if (input.scope) {
      objQuery = objQuery.where('scope', '=', input.scope);
    }
    if (input.departmentId) {
      objQuery = objQuery.where('department_id', '=', input.departmentId);
    }
    if (input.employeeId) {
      objQuery = objQuery.where('owner_employee_id', '=', input.employeeId);
    }

    const objectiveRows = await objQuery.execute();
    const objectiveIds = objectiveRows.map((o) => o.id);
    const krRows =
      objectiveIds.length > 0
        ? await ctx.trx
            .selectFrom('ludy_hr.okr_key_result')
            .selectAll()
            .where('org_id', '=', ctx.orgId)
            .where('objective_id', 'in', objectiveIds)
            .orderBy('created_at', 'asc')
            .execute()
        : [];

    const linkedProjectIds = krRows.map((kr) => kr.linked_project_id).filter((id): id is string => id !== null);
    const checkinUserIds = krRows.map((kr) => kr.last_checkin_by).filter((id): id is string => id !== null);

    const [projects, profiles] = await Promise.all([
      loadProjectsSnapshot(ctx, linkedProjectIds),
      checkinUserIds.length > 0 ? memberProfiles(ctx.trx, checkinUserIds) : Promise.resolve(new Map()),
    ]);

    const krsByObjective = new Map<string, HrOkrKeyResultView[]>();
    const objById = new Map(objectiveRows.map((o) => [o.id, o]));

    for (const kr of krRows) {
      const parent = objById.get(kr.objective_id);
      if (!parent) continue;
      const canManage = canManageObjective(caller, parent);
      const canCheckin = canCheckinObjective(caller, parent);
      const projSummary = summarizeLinkedTasks(kr.linked_project_id, kr.linked_task_ids, projects);
      const checkerProfile = kr.last_checkin_by ? profiles.get(kr.last_checkin_by) : undefined;
      const list = krsByObjective.get(kr.objective_id) ?? [];
      list.push({
        id: kr.id,
        objectiveId: kr.objective_id,
        title: kr.title,
        metricType: kr.metric_type,
        targetValue: formatOkrDecimal(money(kr.target_value)),
        currentValue: formatOkrDecimal(money(kr.current_value)),
        unit: kr.unit,
        linkedProjectId: kr.linked_project_id,
        linkedProjectName: projSummary.linkedProjectName,
        linkedProjectAccessible: projSummary.linkedProjectAccessible,
        linkedTaskIds: [...kr.linked_task_ids],
        linkedTasks: projSummary.linkedTasks,
        completedLinkedTasks: projSummary.completedLinkedTasks,
        totalLinkedTasks: projSummary.totalLinkedTasks,
        progressPct: formatOkrDecimal(money(kr.progress_pct)),
        lastCheckinNote: kr.last_checkin_note,
        lastCheckinAt: kr.last_checkin_at ? kr.last_checkin_at.toISOString() : null,
        lastCheckinBy: kr.last_checkin_by,
        lastCheckinByName: checkerProfile ? memberLabel(checkerProfile) : null,
        canCheckin,
        canEdit: canManage,
        createdAt: kr.created_at.toISOString(),
        updatedAt: kr.updated_at.toISOString(),
      });
      krsByObjective.set(kr.objective_id, list);
    }

    const objectives: HrOkrObjectiveView[] = objectiveRows.map((obj) => {
      const keyResults = krsByObjective.get(obj.id) ?? [];
      const ownerEmp = obj.owner_employee_id ? caller.visibleEmployeesById.get(obj.owner_employee_id) : undefined;
      const dept = obj.department_id ? caller.visibleDeptsById.get(obj.department_id) : undefined;
      return {
        id: obj.id,
        legalEntityId: obj.legal_entity_id,
        quarter: obj.quarter,
        scope: obj.scope,
        title: obj.title,
        ownerEmployeeId: obj.owner_employee_id,
        ownerEmployeeName: ownerEmp?.display_name ?? null,
        departmentId: obj.department_id,
        departmentName: dept?.name ?? null,
        parentObjectiveId: obj.parent_objective_id,
        status: obj.status,
        progressPct: computeObjectiveProgressPct(keyResults),
        keyResults,
        canManage: canManageObjective(caller, obj),
        createdAt: obj.created_at.toISOString(),
        updatedAt: obj.updated_at.toISOString(),
      };
    });

    const manageableDepartments = Array.from(caller.visibleDeptsById.values())
      .filter((d) => d.archived_at === null && (caller.isAdminOrOwner || caller.managedDeptIds.has(d.id)))
      .map((d) => ({ id: d.id, name: d.name, legalEntityId: d.legal_entity_id }));

    const manageableEmployees =
      caller.isAdminOrOwner || caller.managedDeptIds.size > 0
        ? Array.from(caller.visibleEmployeesById.values())
            .filter(
              (e) =>
                e.status !== 'ended' &&
                (caller.isAdminOrOwner || (e.department_id !== null && caller.managedDeptIds.has(e.department_id))),
            )
            .map((e) => ({ id: e.id, displayName: e.display_name, departmentId: e.department_id, jobTitle: e.job_title }))
        : [];

    return {
      quarter: activeQuarter,
      availableQuarters,
      projectsAvailable: projects.projectsAvailable,
      canManageAny: caller.isAdminOrOwner || caller.managedDeptIds.size > 0,
      selfEmployeeId: caller.selfEmployeeId,
      manageableDepartments,
      manageableEmployees,
      objectives,
    };
  },
});

export const hrOkrProjectOptions = defineQuery({
  name: 'hr.okr.project_options',
  input: zHrOkrProjectOptionsAsk,
  access: STAFF_ROLES,
  handler: async (ctx, input): Promise<HrOkrProjectOptionsResult> => {
    userOf(ctx.actor);
    const listRes = await ctx.query<ProjectListResult>('projects.project.list', {});
    if (listRes.status !== 'ok') {
      return { projectsAvailable: false, projects: [] };
    }
    const projects: HrOkrProjectOption[] = listRes.value.projects
      .filter((p) => input.includeArchived || p.status !== 'archived')
      .map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        archived: p.status === 'archived',
        openTaskCount: p.openTaskCount,
        doneTaskCount: p.doneTaskCount,
      }));
    return { projectsAvailable: true, projects };
  },
});

export const hrOkrProjectTasks = defineQuery({
  name: 'hr.okr.project_tasks',
  input: zHrOkrProjectTasksAsk,
  access: STAFF_ROLES,
  handler: async (ctx, input): Promise<HrOkrProjectTasksResult> => {
    userOf(ctx.actor);
    const snapshot = await loadProjectsSnapshot(ctx, [input.projectId]);
    if (!snapshot.projectsAvailable) {
      return { projectsAvailable: false, projectAccessible: false, tasks: [] };
    }
    const board = snapshot.boardsById.get(input.projectId);
    if (!board) {
      return { projectsAvailable: true, projectAccessible: false, tasks: [] };
    }
    const colNames = new Map<string, string>();
    for (const col of board.columns ?? []) {
      colNames.set(col.id, col.name);
    }
    const tasks: HrOkrLinkedTaskView[] = board.tasks
      .filter((t) => t.status !== 'cancelled')
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        completed: t.status === 'done',
        statusName: (t.columnId ? colNames.get(t.columnId) : null) ?? t.status,
      }));
    return { projectsAvailable: true, projectAccessible: true, tasks };
  },
});

async function resolveAndValidateObjectiveInput(
  ctx: CommandContext,
  caller: CallerOkrContext,
  params: {
    quarter: string;
    scope: HrOkrScope;
    departmentId: string | null;
    ownerEmployeeId: string | null;
    parentObjectiveId: string | null;
    fixedLegalEntityId?: string;
  },
): Promise<{ legalEntityId: string; departmentId: string | null; ownerEmployeeId: string | null }> {
  let departmentId = params.departmentId;
  const ownerEmployeeId = params.ownerEmployeeId;
  let legalEntityId = params.fixedLegalEntityId;

  let ownerEmp: VisibleEmployeeRow | undefined;
  if (ownerEmployeeId !== null) {
    ownerEmp = caller.visibleEmployeesById.get(ownerEmployeeId);
    if (!ownerEmp) {
      throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên trong phạm vi quản lý của bạn');
    }
    if (ownerEmp.status === 'ended') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Không thể giao OKR mới cho nhân viên đã nghỉ việc');
    }
    if (legalEntityId && ownerEmp.legal_entity_id !== legalEntityId) {
      throw new DomainError('HR_OKR_ENTITY_MISMATCH', 409, 'Nhân viên không thuộc cùng pháp nhân với mục tiêu');
    }
    legalEntityId ??= ownerEmp.legal_entity_id;
  }

  if (params.scope === 'company') {
    if (!caller.isAdminOrOwner) throw okrForbidden();
    if (departmentId !== null || params.parentObjectiveId !== null) {
      throw new DomainError('HR_OKR_INVALID_SCOPE', 422, 'Mục tiêu công ty không gắn phòng ban hoặc mục tiêu cha');
    }
    legalEntityId ??= await resolveDefaultLegalEntity(ctx);
  } else if (params.scope === 'department') {
    if (!departmentId) {
      throw new DomainError('HR_OKR_DEPARTMENT_REQUIRED', 422, 'Mục tiêu phòng ban phải chọn phòng ban');
    }
    const dept = caller.visibleDeptsById.get(departmentId);
    if (!dept) {
      throw new DomainError('HR_DEPARTMENT_NOT_FOUND', 404, 'Không tìm thấy phòng ban này');
    }
    if (dept.archived_at !== null) {
      throw new DomainError('HR_DEPARTMENT_ARCHIVED', 409, 'Phòng ban này đã lưu trữ, không thể gắn OKR');
    }
    if (!caller.isAdminOrOwner && !caller.managedDeptIds.has(departmentId)) {
      throw okrForbidden();
    }
    if (legalEntityId && dept.legal_entity_id !== legalEntityId) {
      throw new DomainError('HR_OKR_ENTITY_MISMATCH', 409, 'Phòng ban không thuộc cùng pháp nhân');
    }
    legalEntityId ??= dept.legal_entity_id;
  } else {
    if (!ownerEmployeeId || !ownerEmp) {
      throw new DomainError('HR_OKR_OWNER_REQUIRED', 422, 'Mục tiêu cá nhân phải gắn nhân viên sở hữu');
    }
    if (departmentId === null && ownerEmp.department_id !== null) {
      departmentId = ownerEmp.department_id;
    }
    if (departmentId !== null) {
      const dept = caller.visibleDeptsById.get(departmentId);
      if (!dept || dept.archived_at !== null) {
        throw new DomainError('HR_DEPARTMENT_NOT_FOUND', 404, 'Không tìm thấy phòng ban đang hoạt động');
      }
      if (dept.legal_entity_id !== ownerEmp.legal_entity_id) {
        throw new DomainError('HR_OKR_ENTITY_MISMATCH', 409, 'Phòng ban và nhân viên không cùng pháp nhân');
      }
      if (ownerEmp.department_id !== null && ownerEmp.department_id !== departmentId) {
        throw new DomainError('HR_OKR_DEPT_MISMATCH', 409, 'Phòng ban được chọn phải khớp phòng ban của nhân viên');
      }
    }
    if (!canManageObjective(caller, { scope: 'individual', department_id: departmentId, owner_employee_id: ownerEmployeeId })) {
      throw okrForbidden();
    }
  }

  const finalEntityId = legalEntityId ?? (await resolveDefaultLegalEntity(ctx));

  if (params.parentObjectiveId !== null) {
    const parent = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .select(['id', 'legal_entity_id', 'quarter', 'scope', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', params.parentObjectiveId)
      .executeTakeFirst();
    if (!parent) {
      throw new DomainError('HR_OKR_PARENT_NOT_FOUND', 404, 'Không tìm thấy mục tiêu cha để liên kết');
    }
    if (parent.legal_entity_id !== finalEntityId) {
      throw new DomainError('HR_OKR_ENTITY_MISMATCH', 409, 'Mục tiêu cha phải thuộc cùng pháp nhân');
    }
    if (parent.quarter !== params.quarter) {
      throw new DomainError('HR_OKR_QUARTER_MISMATCH', 409, 'Mục tiêu cha phải thuộc cùng quý OKR');
    }
    if (parent.status === 'archived') {
      throw new DomainError('HR_OKR_PARENT_ARCHIVED', 409, 'Không thể liên kết vào mục tiêu cha đã lưu trữ');
    }
    if (params.scope === 'department' && parent.scope !== 'company') {
      throw new DomainError('HR_OKR_PARENT_SCOPE', 422, 'Mục tiêu phòng ban chỉ có thể liên kết lên mục tiêu công ty');
    }
    if (params.scope === 'individual' && parent.scope === 'individual') {
      throw new DomainError('HR_OKR_PARENT_SCOPE', 422, 'Mục tiêu cá nhân phải liên kết lên mục tiêu công ty hoặc phòng ban');
    }
  }

  return { legalEntityId: finalEntityId, departmentId, ownerEmployeeId };
}

export const hrOkrObjectiveCreate = defineCommand({
  name: 'hr.okr.objective.create',
  input: zHrOkrObjectiveCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_objective', ['legal_entity_id', 'quarter', 'scope', 'title', 'owner_employee_id', 'department_id', 'parent_objective_id', 'status', 'created_by'])],
  handler: async (ctx, input): Promise<HrOkrObjectiveMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const resolved = await resolveAndValidateObjectiveInput(ctx, caller, {
      quarter: input.quarter,
      scope: input.scope,
      departmentId: input.departmentId ?? null,
      ownerEmployeeId: input.ownerEmployeeId ?? null,
      parentObjectiveId: input.parentObjectiveId ?? null,
    });
    const status: HrOkrStatus = input.activate ? 'active' : 'draft';
    const row = await ctx.trx
      .insertInto('ludy_hr.okr_objective')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: resolved.legalEntityId,
        quarter: input.quarter,
        scope: input.scope,
        title: input.title,
        department_id: resolved.departmentId,
        owner_employee_id: resolved.ownerEmployeeId,
        parent_objective_id: input.parentObjectiveId ?? null,
        status,
        created_by: caller.userId,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      objectiveId: row.id,
      quarter: input.quarter,
      scope: input.scope,
      status: row.status,
      departmentId: resolved.departmentId,
      ownerEmployeeId: resolved.ownerEmployeeId,
      parentObjectiveId: input.parentObjectiveId ?? null,
    });

    return { objectiveId: row.id, status: row.status };
  },
});

export const hrOkrObjectiveUpdate = defineCommand({
  name: 'hr.okr.objective.update',
  input: zHrOkrObjectiveUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_objective', id: input.objectiveId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_objective', ['quarter', 'title', 'owner_employee_id', 'department_id', 'parent_objective_id', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOkrObjectiveMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.objectiveId)
      .executeTakeFirst();
    if (!existing) throw objectiveNotFound();
    if (!canManageObjective(caller, existing)) throw okrForbidden();
    if (existing.status === 'archived') {
      throw new DomainError('HR_OKR_ARCHIVED', 409, 'Mục tiêu đã lưu trữ không thể chỉnh sửa');
    }

    const nextQuarter = input.quarter ?? existing.quarter;
    const nextDepartmentId = input.departmentId === undefined ? existing.department_id : input.departmentId;
    const nextOwnerEmployeeId = input.ownerEmployeeId === undefined ? existing.owner_employee_id : input.ownerEmployeeId;
    const nextParentId = input.parentObjectiveId === undefined ? existing.parent_objective_id : input.parentObjectiveId;
    if (nextParentId === existing.id) {
      throw new DomainError('HR_OKR_SELF_PARENT', 422, 'Mục tiêu không thể tự liên kết với chính nó');
    }

    const resolved = await resolveAndValidateObjectiveInput(ctx, caller, {
      quarter: nextQuarter,
      scope: existing.scope,
      departmentId: nextDepartmentId,
      ownerEmployeeId: nextOwnerEmployeeId,
      parentObjectiveId: nextParentId,
      fixedLegalEntityId: existing.legal_entity_id,
    });

    const updated = await ctx.trx
      .updateTable('ludy_hr.okr_objective')
      .set({
        quarter: nextQuarter,
        title: input.title ?? existing.title,
        department_id: resolved.departmentId,
        owner_employee_id: resolved.ownerEmployeeId,
        parent_objective_id: nextParentId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      objectiveId: updated.id,
      quarter: nextQuarter,
      scope: existing.scope,
      departmentId: resolved.departmentId,
      ownerEmployeeId: resolved.ownerEmployeeId,
      parentObjectiveId: nextParentId,
    });

    return { objectiveId: updated.id, status: updated.status };
  },
});

export const hrOkrObjectiveSetStatus = defineCommand({
  name: 'hr.okr.objective.set_status',
  input: zHrOkrObjectiveSetStatus,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_objective', id: input.objectiveId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_objective', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOkrObjectiveMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.objectiveId)
      .executeTakeFirst();
    if (!existing) throw objectiveNotFound();
    if (!canManageObjective(caller, existing)) throw okrForbidden();

    const updated = await ctx.trx
      .updateTable('ludy_hr.okr_objective')
      .set({ status: input.status, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      objectiveId: updated.id,
      fromStatus: existing.status,
      toStatus: updated.status,
    });

    return { objectiveId: updated.id, status: updated.status };
  },
});

async function validateAndMeasureProjectLink(
  ctx: QueryContext,
  linkedProjectId: string | null,
  linkedTaskIds: readonly string[],
): Promise<{
  linkedProjectId: string | null;
  linkedTaskIds: string[];
  projectsAvailable: boolean;
  projectAccessible: boolean;
  completedLinkedTasks: number;
  totalLinkedTasks: number;
}> {
  const uniqueTaskIds = uniqueIds(linkedTaskIds);
  if (linkedProjectId === null) {
    if (uniqueTaskIds.length > 0) {
      throw new DomainError('HR_OKR_PROJECT_REQUIRED', 422, 'Cần chọn dự án Công tác trước khi chọn công việc');
    }
    return {
      linkedProjectId: null,
      linkedTaskIds: [],
      projectsAvailable: true,
      projectAccessible: true,
      completedLinkedTasks: 0,
      totalLinkedTasks: 0,
    };
  }
  const snapshot = await loadProjectsSnapshot(ctx, [linkedProjectId]);
  if (!snapshot.projectsAvailable) {
    throw new DomainError('HR_OKR_PROJECTS_OFF', 409, 'Ứng dụng Công tác chưa bật cho tổ chức này; hãy dùng chỉ số thủ công');
  }
  const board = snapshot.boardsById.get(linkedProjectId);
  if (!board) {
    throw new DomainError('HR_OKR_PROJECT_NOT_FOUND', 404, 'Bạn không có quyền truy cập dự án Công tác này hoặc dự án không tồn tại');
  }
  const boardTaskIds = new Set(board.tasks.map((t) => t.id));
  for (const taskId of uniqueTaskIds) {
    if (!boardTaskIds.has(taskId)) {
      throw new DomainError('HR_OKR_TASK_NOT_IN_PROJECT', 422, 'Công việc được chọn không thuộc dự án Công tác đã chọn');
    }
  }
  const summary = summarizeLinkedTasks(linkedProjectId, uniqueTaskIds, snapshot);
  return {
    linkedProjectId,
    linkedTaskIds: uniqueTaskIds,
    projectsAvailable: true,
    projectAccessible: summary.linkedProjectAccessible,
    completedLinkedTasks: summary.completedLinkedTasks,
    totalLinkedTasks: summary.totalLinkedTasks,
  };
}

export const hrOkrKeyResultAdd = defineCommand({
  name: 'hr.okr.kr.add',
  input: zHrOkrKeyResultAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_key_result', ['legal_entity_id', 'objective_id', 'title', 'metric_type', 'target_value', 'current_value', 'unit', 'linked_project_id', 'linked_task_ids', 'progress_pct', 'created_by'])],
  handler: async (ctx, input): Promise<HrOkrKeyResultMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const parent = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.objectiveId)
      .executeTakeFirst();
    if (!parent) throw objectiveNotFound();
    if (!canManageObjective(caller, parent)) throw okrForbidden();
    if (parent.status === 'archived') {
      throw new DomainError('HR_OKR_ARCHIVED', 409, 'Không thể thêm kết quả then chốt cho mục tiêu đã lưu trữ');
    }

    const projectLink = await validateAndMeasureProjectLink(ctx, input.linkedProjectId ?? null, input.linkedTaskIds ?? []);
    const targetValue = defaultTargetForMetric(input.metricType, input.targetValue, projectLink.totalLinkedTasks);
    assertValidTargetValue(input.metricType, targetValue);

    const currentValue =
      input.currentValue ??
      (input.metricType === 'project_tasks' && projectLink.linkedProjectId !== null ? String(projectLink.completedLinkedTasks) : '0');
    const progressPct = computeKrProgressPct(input.metricType, currentValue, targetValue);

    const inserted = await ctx.trx
      .insertInto('ludy_hr.okr_key_result')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: parent.legal_entity_id,
        objective_id: parent.id,
        title: input.title,
        metric_type: input.metricType,
        target_value: targetValue,
        current_value: currentValue,
        unit: input.unit ?? null,
        linked_project_id: projectLink.linkedProjectId,
        linked_task_ids: projectLink.linkedTaskIds,
        progress_pct: progressPct,
        created_by: caller.userId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      keyResultId: inserted.id,
      objectiveId: parent.id,
      metricType: input.metricType,
      hasLinkedProject: projectLink.linkedProjectId !== null,
      linkedTaskCount: projectLink.linkedTaskIds.length,
    });

    return {
      keyResultId: inserted.id,
      objectiveId: parent.id,
      currentValue: formatOkrDecimal(money(currentValue)),
      targetValue: formatOkrDecimal(money(targetValue)),
      progressPct,
      completedLinkedTasks: projectLink.completedLinkedTasks,
      totalLinkedTasks: projectLink.totalLinkedTasks,
      projectsAvailable: projectLink.projectsAvailable,
      projectAccessible: projectLink.projectAccessible,
    };
  },
});

export const hrOkrKeyResultUpdate = defineCommand({
  name: 'hr.okr.kr.update',
  input: zHrOkrKeyResultUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_key_result', id: input.keyResultId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_key_result', ['title', 'metric_type', 'target_value', 'unit', 'linked_project_id', 'linked_task_ids', 'progress_pct', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOkrKeyResultMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.okr_key_result')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.keyResultId)
      .executeTakeFirst();
    if (!existing) throw keyResultNotFound();

    const parent = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.objective_id)
      .executeTakeFirst();
    if (!parent) throw objectiveNotFound();
    if (!canManageObjective(caller, parent)) throw okrForbidden();
    if (parent.status === 'archived') {
      throw new DomainError('HR_OKR_ARCHIVED', 409, 'Mục tiêu đã lưu trữ không thể sửa kết quả then chốt');
    }

    const nextMetricType = input.metricType ?? existing.metric_type;
    const nextLinkedProjectId = input.linkedProjectId === undefined ? existing.linked_project_id : input.linkedProjectId;
    const nextLinkedTaskIds =
      input.linkedProjectId === null
        ? []
        : input.linkedTaskIds !== undefined
          ? input.linkedTaskIds
          : existing.linked_task_ids;

    const projectChanged =
      input.linkedProjectId !== undefined || input.linkedTaskIds !== undefined;

    let completedLinkedTasks = 0;
    let totalLinkedTasks = uniqueIds(nextLinkedTaskIds).length;
    let projectsAvailable = false;
    let projectAccessible = false;
    let finalTaskIds = uniqueIds(nextLinkedTaskIds);

    if (projectChanged && nextLinkedProjectId !== null) {
      const measured = await validateAndMeasureProjectLink(ctx, nextLinkedProjectId, finalTaskIds);
      finalTaskIds = measured.linkedTaskIds;
      completedLinkedTasks = measured.completedLinkedTasks;
      totalLinkedTasks = measured.totalLinkedTasks;
      projectsAvailable = measured.projectsAvailable;
      projectAccessible = measured.projectAccessible;
    } else if (nextLinkedProjectId !== null) {
      const snapshot = await loadProjectsSnapshot(ctx, [nextLinkedProjectId]);
      const summary = summarizeLinkedTasks(nextLinkedProjectId, finalTaskIds, snapshot);
      projectsAvailable = snapshot.projectsAvailable;
      projectAccessible = summary.linkedProjectAccessible;
      completedLinkedTasks = summary.completedLinkedTasks;
      totalLinkedTasks = summary.totalLinkedTasks;
    }

    const nextTarget =
      input.targetValue ??
      (nextMetricType === 'project_tasks' && projectChanged && totalLinkedTasks > 0
        ? String(totalLinkedTasks)
        : formatOkrDecimal(money(existing.target_value)));
    assertValidTargetValue(nextMetricType, nextTarget);

    const currentStr = formatOkrDecimal(money(existing.current_value));
    const nextProgress = computeKrProgressPct(nextMetricType, currentStr, nextTarget);

    await ctx.trx
      .updateTable('ludy_hr.okr_key_result')
      .set({
        title: input.title ?? existing.title,
        metric_type: nextMetricType,
        target_value: nextTarget,
        unit: input.unit === undefined ? existing.unit : input.unit,
        linked_project_id: nextLinkedProjectId,
        linked_task_ids: finalTaskIds,
        progress_pct: nextProgress,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      keyResultId: existing.id,
      objectiveId: existing.objective_id,
      metricType: nextMetricType,
      progressPct: nextProgress,
    });

    return {
      keyResultId: existing.id,
      objectiveId: existing.objective_id,
      currentValue: currentStr,
      targetValue: formatOkrDecimal(money(nextTarget)),
      progressPct: nextProgress,
      completedLinkedTasks,
      totalLinkedTasks,
      projectsAvailable,
      projectAccessible,
    };
  },
});

export const hrOkrKeyResultRemove = defineCommand({
  name: 'hr.okr.kr.remove',
  input: zHrOkrKeyResultRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_key_result', id: input.keyResultId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_key_result', ['id'])],
  handler: async (ctx, input): Promise<HrOkrKeyResultRemoveResult> => {
    const caller = await loadCallerOkrContext(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.okr_key_result')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.keyResultId)
      .executeTakeFirst();
    if (!existing) throw keyResultNotFound();

    const parent = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.objective_id)
      .executeTakeFirst();
    if (!parent) throw objectiveNotFound();
    if (!canManageObjective(caller, parent)) throw okrForbidden();

    await ctx.trx
      .deleteFrom('ludy_hr.okr_key_result')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      keyResultId: existing.id,
      objectiveId: existing.objective_id,
    });

    return { removed: true, keyResultId: existing.id };
  },
});

async function applyProjectSyncAndCheckin(
  ctx: CommandContext,
  caller: CallerOkrContext,
  keyResultId: string,
  options: { syncFromProjects: boolean; explicitCurrentValue?: string; note?: string | null },
): Promise<HrOkrKeyResultMutationResult> {
  const existing = await ctx.trx
    .selectFrom('ludy_hr.okr_key_result')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', keyResultId)
    .executeTakeFirst();
  if (!existing) throw keyResultNotFound();

  const parent = await ctx.trx
    .selectFrom('ludy_hr.okr_objective')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', existing.objective_id)
    .executeTakeFirst();
  if (!parent) throw objectiveNotFound();

  const isManager = canManageObjective(caller, parent);
  if (!canCheckinObjective(caller, parent)) {
    throw okrForbidden();
  }

  let projectsAvailable = false;
  let projectAccessible = false;
  let completedLinkedTasks = 0;
  let totalLinkedTasks = existing.linked_task_ids.length;

  let nextTarget = formatOkrDecimal(money(existing.target_value));
  let nextCurrent = options.explicitCurrentValue ?? formatOkrDecimal(money(existing.current_value));

  if (existing.linked_project_id !== null) {
    const snapshot = await loadProjectsSnapshot(ctx, [existing.linked_project_id]);
    const summary = summarizeLinkedTasks(existing.linked_project_id, existing.linked_task_ids, snapshot);
    projectsAvailable = snapshot.projectsAvailable;
    projectAccessible = summary.linkedProjectAccessible;
    completedLinkedTasks = summary.completedLinkedTasks;
    totalLinkedTasks = summary.totalLinkedTasks;

    if (options.syncFromProjects && projectAccessible) {
      if (existing.metric_type === 'project_tasks') {
        nextCurrent = String(completedLinkedTasks);
        if (isManager && existing.linked_task_ids.length === 0 && totalLinkedTasks > 0) {
          nextTarget = String(totalLinkedTasks);
        }
      } else if (options.explicitCurrentValue === undefined && totalLinkedTasks > 0) {
        const computed = money(completedLinkedTasks).div(totalLinkedTasks).mul(money(nextTarget));
        nextCurrent = formatOkrDecimal(computed);
      }
    }
  }

  const effectiveTargetForRatio =
    options.syncFromProjects &&
    projectAccessible &&
    existing.metric_type === 'project_tasks' &&
    existing.linked_task_ids.length === 0 &&
    totalLinkedTasks > 0
      ? String(totalLinkedTasks)
      : nextTarget;

  const nextProgress = computeKrProgressPct(existing.metric_type, nextCurrent, effectiveTargetForRatio);
  const nextNote = options.note === undefined ? existing.last_checkin_note : options.note;

  // Non-manager self check-in must never modify target_value (enforced by okr_key_result_write_guard trigger).
  await ctx.trx
    .updateTable('ludy_hr.okr_key_result')
    .set({
      ...(isManager && nextTarget !== formatOkrDecimal(money(existing.target_value)) ? { target_value: nextTarget } : {}),
      current_value: nextCurrent,
      progress_pct: nextProgress,
      last_checkin_note: nextNote,
      last_checkin_at: ctx.now,
      last_checkin_by: caller.userId,
      updated_at: ctx.now,
    })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', existing.id)
    .execute();

  ctx.audit({
    keyResultId: existing.id,
    objectiveId: existing.objective_id,
    progressPct: nextProgress,
    syncFromProjects: options.syncFromProjects,
    projectsAvailable,
    projectAccessible,
    noteUpdated: options.note !== undefined ? auditValue(KEY_RESULT, 'last_checkin_note', options.note ?? '') : undefined,
  });

  return {
    keyResultId: existing.id,
    objectiveId: existing.objective_id,
    currentValue: formatOkrDecimal(money(nextCurrent)),
    targetValue: nextTarget,
    progressPct: nextProgress,
    completedLinkedTasks,
    totalLinkedTasks,
    projectsAvailable,
    projectAccessible,
  };
}

export const hrOkrKeyResultCheckin = defineCommand({
  name: 'hr.okr.kr.checkin',
  input: zHrOkrKeyResultCheckin,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_key_result', id: input.keyResultId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_key_result', ['target_value', 'current_value', 'progress_pct', 'last_checkin_note', 'last_checkin_at', 'last_checkin_by', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOkrKeyResultMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    return applyProjectSyncAndCheckin(ctx, caller, input.keyResultId, {
      syncFromProjects: input.syncFromProjects,
      ...(input.currentValue !== undefined ? { explicitCurrentValue: input.currentValue } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  },
});

export const hrOkrKeyResultSyncProjects = defineCommand({
  name: 'hr.okr.kr.sync_projects',
  input: zHrOkrKeyResultSyncProjects,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_key_result', id: input.keyResultId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'okr_key_result', ['target_value', 'current_value', 'progress_pct', 'last_checkin_at', 'last_checkin_by', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOkrKeyResultMutationResult> => {
    const caller = await loadCallerOkrContext(ctx);
    return applyProjectSyncAndCheckin(ctx, caller, input.keyResultId, {
      syncFromProjects: true,
    });
  },
});

export const hrOkrDraftRead = defineQuery({
  name: 'hr.okr.draft.read',
  input: zHrOkrDraftCheckinAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrOkrDraftSource> => {
    const caller = await loadCallerOkrContext(ctx);
    const kr = await ctx.trx
      .selectFrom('ludy_hr.okr_key_result')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.keyResultId)
      .executeTakeFirst();
    if (!kr) throw keyResultNotFound();

    const parent = await ctx.trx
      .selectFrom('ludy_hr.okr_objective')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', kr.objective_id)
      .executeTakeFirst();
    if (!parent) throw objectiveNotFound();

    if (!canCheckinObjective(caller, parent)) {
      throw okrForbidden();
    }

    const projects =
      kr.linked_project_id !== null
        ? await loadProjectsSnapshot(ctx, [kr.linked_project_id])
        : { projectsAvailable: false, projectsById: new Map<string, ProjectSummary>(), boardsById: new Map<string, ProjectBoard>() };
    const summary = summarizeLinkedTasks(kr.linked_project_id, kr.linked_task_ids, projects);

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

    const ownerEmp = parent.owner_employee_id ? caller.visibleEmployeesById.get(parent.owner_employee_id) : undefined;
    const dept = parent.department_id ? caller.visibleDeptsById.get(parent.department_id) : undefined;

    const facts: HrOkrDraftReadResult = {
      keyResultId: kr.id,
      objectiveId: parent.id,
      quarter: parent.quarter,
      objectiveScope: parent.scope,
      objectiveTitle: parent.title,
      keyResultTitle: kr.title,
      metricType: kr.metric_type,
      targetValue: formatOkrDecimal(money(kr.target_value)),
      currentValue: formatOkrDecimal(money(kr.current_value)),
      unit: kr.unit,
      progressPct: formatOkrDecimal(money(kr.progress_pct)),
      ownerEmployeeId: parent.owner_employee_id,
      ownerName: ownerEmp?.display_name ?? null,
      departmentName: dept?.name ?? null,
      lastCheckinNote: kr.last_checkin_note,
      lastCheckinAt: kr.last_checkin_at ? isoDate(kr.last_checkin_at) : null,
      projectsAvailable: projects.projectsAvailable,
      projectAccessible: summary.linkedProjectAccessible,
      linkedProjectName: summary.linkedProjectName,
      completedLinkedTasks: summary.completedLinkedTasks,
      totalLinkedTasks: summary.totalLinkedTasks,
      linkedTaskTitles: summary.linkedTasks.slice(0, 20).map((t) => ({ title: t.title, completed: t.completed })),
    };

    const meta = metaRows[0];
    return {
      facts,
      aiStopped: meta?.ai_stopped === true,
      aiBudgetSpent: meta?.budget_spent === true,
    };
  },
});

export const hrOkrAiStatus = defineQuery({
  name: 'hr.okr.ai_status',
  input: zHrOkrAiStatusAsk,
  access: STAFF_ROLES,
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

export const hrOkrDraftAudit = defineCommand({
  name: 'hr.okr.draft.audit',
  input: zHrOkrDraftAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: STAFF_ROLES,
  target: (input) => ({ type: 'hr.okr_key_result', id: input.keyResultId }),
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      keyResultId: input.keyResultId,
      aiStatus: input.aiStatus,
      progressPct: input.progressPct,
      completedLinkedTasks: input.completedLinkedTasks,
    });
    return { ok: true };
  },
});

export const hrOkrQueries = [hrOkrTree, hrOkrProjectOptions, hrOkrProjectTasks, hrOkrDraftRead, hrOkrAiStatus];
export const hrOkrCommands = [
  hrOkrObjectiveCreate,
  hrOkrObjectiveUpdate,
  hrOkrObjectiveSetStatus,
  hrOkrKeyResultAdd,
  hrOkrKeyResultUpdate,
  hrOkrKeyResultRemove,
  hrOkrKeyResultCheckin,
  hrOkrKeyResultSyncProjects,
  hrOkrDraftAudit,
];
