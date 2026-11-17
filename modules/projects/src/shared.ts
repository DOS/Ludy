// SPDX-License-Identifier: AGPL-3.0-only
// Shared database loaders and permission checks for the projects module.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import type { ProjectStatus } from '@crove/kernel-contract';
import { DomainError, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

export const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export type Trx = QueryContext['trx'];

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string | null;
  status: ProjectStatus;
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

export function assertNotArchived(row: ProjectRow): void {
  if (row.status === 'archived') {
    throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án đã lưu trữ nên không thể chỉnh sửa');
  }
}

export async function loadProject(trx: Trx, orgId: string, projectId: string, lock: boolean): Promise<ProjectRow> {
  let q = trx
    .selectFrom('crove_projects.project')
    .select(['id', 'name', 'description', 'owner_user_id', 'status', 'created_by', 'created_at', 'updated_at'])
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
