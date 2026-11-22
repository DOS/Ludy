// SPDX-License-Identifier: AGPL-3.0-only
// Shared database loaders and permission checks for the projects module.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import type { ProjectSeat, ProjectSeatHolder, ProjectStatus } from '@ludy/kernel-contract';
import { DomainError, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

export const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export type Trx = QueryContext['trx'];

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string | null;
  status: ProjectStatus;
  cycles_enabled: boolean;
  cycle_duration_weeks: number;
  points_enabled: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MemberProfile {
  displayName: string | null;
  email: string | null;
}

export function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên mới thực hiện được việc này');
  }
  return actor.userId;
}

export const projectNotFound = () => new DomainError('PROJECT_NOT_FOUND', 404, 'Không tìm thấy dự án này');
export const taskNotFound = () => new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc hoặc bạn không có quyền xem đơn vị của việc này');

export function descriptionOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function canManageProject(role: MemberRole | null, userId: string, ownerUserId: string | null): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role !== null && role !== 'viewer' && ownerUserId !== null && ownerUserId === userId) return true;
  return false;
}

export function canWriteProject(role: MemberRole | null, status: ProjectStatus): boolean {
  return role !== null && role !== 'viewer' && status !== 'archived';
}

export function assertCanManage(ctx: CommandContext, row: ProjectRow, userId: string): void {
  if (!canManageProject(ctx.role, userId, row.owner_user_id)) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ người phụ trách dự án, quản trị viên hoặc chủ sở hữu mới thực hiện được việc này');
  }
}

export function assertNotArchived(row: Pick<ProjectRow, 'status'>): void {
  if (row.status === 'archived') {
    throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án đã lưu trữ nên không thể chỉnh sửa');
  }
}

export async function loadProject(trx: Trx, orgId: string, projectId: string, lock: boolean): Promise<ProjectRow> {
  let q = trx
    .selectFrom('crove_projects.project')
    .select([
      'id',
      'name',
      'description',
      'owner_user_id',
      'status',
      'cycles_enabled',
      'cycle_duration_weeks',
      'points_enabled',
      'created_by',
      'created_at',
      'updated_at',
    ])
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .where('is_template', '=', false);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw projectNotFound();
  return { ...row, status: row.status as ProjectStatus };
}

export async function memberProfilesMap(trx: Trx, userIds: readonly string[]): Promise<Map<string, MemberProfile>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, MemberProfile>();
  if (unique.length === 0) return map;
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
    SELECT user_id, email, display_name
      FROM crove_kernel.member_profiles(${unique}::uuid[])`.execute(trx);
  for (const r of rows) {
    map.set(r.user_id, { displayName: r.display_name, email: r.email });
  }
  return map;
}

export async function loadOrgMembers(trx: Trx, orgId: string): Promise<Array<{ userId: string; role: MemberRole }>> {
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'asc')
    .orderBy('user_id', 'asc')
    .execute();
  return rows.map((r) => ({ userId: r.user_id, role: r.role as MemberRole }));
}

export async function assertOrgMembers(trx: Trx, orgId: string, userIds: readonly string[]): Promise<Map<string, MemberRole>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, MemberRole>();
  if (unique.length === 0) return map;
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .where('user_id', 'in', unique)
    .execute();
  for (const r of rows) {
    map.set(r.user_id, r.role as MemberRole);
  }
  for (const id of unique) {
    if (!map.has(id)) {
      throw new DomainError('PROJECT_MEMBER_NOT_FOUND', 404, 'Thành viên không thuộc tổ chức này');
    }
  }
  return map;
}

export function ownerDisplayName(profiles: ReadonlyMap<string, MemberProfile>, ownerUserId: string | null): string | null {
  if (ownerUserId === null) return null;
  const profile = profiles.get(ownerUserId);
  if (!profile) return null;
  return profile.displayName ?? profile.email ?? null;
}

type SeatStatus = ProjectSeat['status'];

export async function countHiddenProjectTasks(trx: Trx, orgId: string, projectId: string): Promise<number> {
  // Compare project_task against le_scope-filtered crove_kernel.task without SECURITY DEFINER.
  const { rows } = await sql<{ count: string }>`
    SELECT pg_catalog.count(*)::text AS count
      FROM crove_projects.project_task pt
     WHERE pt.org_id = ${orgId}::uuid
       AND pt.project_id = ${projectId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM crove_kernel.task t
          WHERE t.org_id = pt.org_id AND t.id = pt.task_id
       )`.execute(trx);
  return Number(rows[0]?.count ?? 0);
}

export async function loadProjectSeatsAndProfiles(
  trx: Trx,
  orgId: string,
  projectId: string,
  onProjectIds: ReadonlySet<string>,
  extraProfileIds: readonly string[] = [],
): Promise<{
  seats: ProjectSeat[];
  profiles: Map<string, MemberProfile>;
  positionRows: Array<{
    id: string;
    title: string;
    status: string;
    holder_user_id: string | null;
    holder_agent_id: string | null;
  }>;
}> {
  const { rows: usedPositionRows } = await sql<{ id: string }>`
    SELECT DISTINCT t.assignee_position_id AS id
      FROM crove_projects.project_task pt
      JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
     WHERE pt.org_id = ${orgId}::uuid
       AND pt.project_id = ${projectId}::uuid
       AND t.assignee_position_id IS NOT NULL`.execute(trx);
  const usedPositionIds = usedPositionRows.map((p) => p.id);

  const positionRows = await trx
    .selectFrom('crove_kernel.position')
    .select(['id', 'title', 'status', 'holder_user_id', 'holder_agent_id'])
    .where('org_id', '=', orgId)
    .where((eb) =>
      usedPositionIds.length > 0 ? eb.or([eb('status', '<>', 'archived'), eb('id', 'in', usedPositionIds)]) : eb('status', '<>', 'archived'),
    )
    .orderBy('title', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const agentIds = positionRows.map((p) => p.holder_agent_id).filter((id): id is string => id !== null);
  const positionUserIds = positionRows.map((p) => p.holder_user_id).filter((id): id is string => id !== null);
  const allProfileIds = [...new Set([...extraProfileIds, ...positionUserIds])];
  const profiles = await memberProfilesMap(trx, allProfileIds);

  const agentNames = new Map<string, string>();
  if (agentIds.length > 0) {
    const agents = await trx
      .selectFrom('crove_kernel.agent')
      .select(['id', 'display_name'])
      .where('org_id', '=', orgId)
      .where('id', 'in', agentIds)
      .execute();
    for (const a of agents) agentNames.set(a.id, a.display_name);
  }

  const seats: ProjectSeat[] = positionRows.map((p) => {
    let holder: ProjectSeatHolder | null = null;
    if (p.holder_user_id !== null) {
      const prof = profiles.get(p.holder_user_id);
      holder = {
        type: 'user',
        userId: p.holder_user_id,
        displayName: prof?.displayName ?? null,
        email: prof?.email ?? null,
      };
    } else if (p.holder_agent_id !== null) {
      holder = {
        type: 'agent',
        agentId: p.holder_agent_id,
        name: agentNames.get(p.holder_agent_id) ?? null,
      };
    }
    return {
      id: p.id,
      title: p.title,
      status: p.status as SeatStatus,
      onProject: p.holder_user_id !== null && onProjectIds.has(p.holder_user_id),
      holder,
    };
  });

  return { seats, profiles, positionRows };
}

export async function loadProjectTaskCounts(
  trx: Trx,
  orgId: string,
  projectId: string,
  taskIds: readonly string[],
): Promise<{
  commentCounts: Map<string, number>;
  openBlockerCounts: Map<string, number>;
  blockingCounts: Map<string, number>;
}> {
  const commentCounts = new Map<string, number>();
  const openBlockerCounts = new Map<string, number>();
  const blockingCounts = new Map<string, number>();
  if (taskIds.length === 0) {
    return { commentCounts, openBlockerCounts, blockingCounts };
  }
  const [{ rows: counts }, { rows: blockerRows }, { rows: blockingRows }] = await Promise.all([
    sql<{ task_id: string; n: string }>`
      SELECT task_id, pg_catalog.count(*)::text AS n
        FROM crove_kernel.task_comment
       WHERE org_id = ${orgId}::uuid
         AND task_id = ANY(${[...taskIds]}::uuid[])
       GROUP BY task_id`.execute(trx),
    sql<{ task_id: string; n: string }>`
      SELECT d.blocked_task_id AS task_id, pg_catalog.count(*)::text AS n
        FROM crove_projects.task_dependency d
        JOIN crove_kernel.task bt
          ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
       WHERE d.org_id = ${orgId}::uuid
         AND d.project_id = ${projectId}::uuid
         AND d.blocked_task_id = ANY(${[...taskIds]}::uuid[])
         AND bt.status NOT IN ('done', 'cancelled')
       GROUP BY d.blocked_task_id`.execute(trx),
    sql<{ task_id: string; n: string }>`
      SELECT d.blocker_task_id AS task_id, pg_catalog.count(*)::text AS n
        FROM crove_projects.task_dependency d
        JOIN crove_kernel.task bt
          ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
        JOIN crove_kernel.task dt
          ON dt.org_id = d.org_id AND dt.id = d.blocked_task_id
       WHERE d.org_id = ${orgId}::uuid
         AND d.project_id = ${projectId}::uuid
         AND d.blocker_task_id = ANY(${[...taskIds]}::uuid[])
         AND bt.status NOT IN ('done', 'cancelled')
         AND dt.status NOT IN ('done', 'cancelled')
       GROUP BY d.blocker_task_id`.execute(trx),
  ]);
  for (const c of counts) commentCounts.set(c.task_id, Number(c.n));
  for (const b of blockerRows) openBlockerCounts.set(b.task_id, Number(b.n));
  for (const b of blockingRows) blockingCounts.set(b.task_id, Number(b.n));
  return { commentCounts, openBlockerCounts, blockingCounts };
}
