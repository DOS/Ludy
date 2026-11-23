// SPDX-License-Identifier: AGPL-3.0-only
// Project task dependencies (issue #2601, docs/plan/projects-v2.md section 4.3, ADR-0056 section 3).
// Cycle-free directed acyclic graph isolated from ludy_kernel.task.parent_task_id.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { TaskStatus } from '@ludy/db';
import {
  PROJECT_DEPENDENCIES_MAX,
  TASK_DEPENDENCIES_MAX,
  tableWrite,
  zProjectDependencyAddInput,
  zProjectDependencyListInput,
  zProjectDependencyRemoveInput,
  type ProjectDependencyAddResult,
  type ProjectDependencyEdge,
  type ProjectDependencyListResult,
  type ProjectDependencyRemoveResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { READERS, WRITERS, assertNotArchived, loadProject, taskNotFound, userOf } from './shared.ts';

const TABLES = projectsManifest.tables;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Check reachability along existing directed edges (`blocker -> blocked`) from `startTaskId` to `targetTaskId`.
 * Returning `true` means adding `targetTaskId -> startTaskId` would close a cycle.
 */
export function hasDependencyPath(
  edges: ReadonlyArray<{ blocker_task_id: string; blocked_task_id: string }>,
  startTaskId: string,
  targetTaskId: string,
): boolean {
  if (startTaskId === targetTaskId) return true;
  const nextByBlocker = new Map<string, string[]>();
  for (const edge of edges) {
    let targets = nextByBlocker.get(edge.blocker_task_id);
    if (!targets) {
      targets = [];
      nextByBlocker.set(edge.blocker_task_id, targets);
    }
    targets.push(edge.blocked_task_id);
  }
  const visited = new Set<string>([startTaskId]);
  const queue: string[] = [startTaskId];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const neighbors = nextByBlocker.get(current);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (next === targetTaskId) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export const projectDependencyAdd = defineCommand({
  name: 'projects.dependency.add',
  input: zProjectDependencyAddInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'task_dependency', [
      'org_id',
      'id',
      'project_id',
      'blocker_task_id',
      'blocked_task_id',
      'created_by',
      'created_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectDependencyAddResult> => {
    const userId = userOf(ctx.actor);
    // Lock the parent project row first so concurrent edge writes cannot race into a cycle or bypass graph caps.
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    if (input.blockerTaskId === input.blockedTaskId) {
      throw new DomainError(
        'DEPENDENCY_CYCLE',
        422,
        'Không thể tạo phụ thuộc vì sẽ tạo vòng lặp giữa các công việc',
      );
    }

    const { rows: projectTaskRows } = await sql<{ task_id: string }>`
      SELECT pt.task_id
        FROM ludy_projects.project_task pt
        JOIN ludy_kernel.task t
          ON t.org_id = pt.org_id
         AND t.id = pt.task_id
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ${project.id}::uuid
         AND pt.task_id IN (${input.blockerTaskId}::uuid, ${input.blockedTaskId}::uuid)`.execute(ctx.trx);

    const inProject = new Set(projectTaskRows.map((r) => r.task_id));
    if (!inProject.has(input.blockerTaskId) || !inProject.has(input.blockedTaskId)) {
      throw new DomainError(
        'DEPENDENCY_TASK_NOT_IN_PROJECT',
        404,
        'Công việc không thuộc dự án này hoặc bạn không có quyền truy cập',
      );
    }

    const existingEdges = await ctx.trx
      .selectFrom('ludy_projects.task_dependency')
      .select(['id', 'blocker_task_id', 'blocked_task_id'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .execute();

    if (
      existingEdges.some(
        (e) => e.blocker_task_id === input.blockerTaskId && e.blocked_task_id === input.blockedTaskId,
      )
    ) {
      throw new DomainError('DEPENDENCY_ALREADY_EXISTS', 409, 'Phụ thuộc giữa hai công việc này đã tồn tại');
    }

    if (hasDependencyPath(existingEdges, input.blockedTaskId, input.blockerTaskId)) {
      throw new DomainError(
        'DEPENDENCY_CYCLE',
        422,
        'Không thể tạo phụ thuộc vì sẽ tạo vòng lặp giữa các công việc',
      );
    }

    if (existingEdges.length >= PROJECT_DEPENDENCIES_MAX) {
      throw new DomainError(
        'DEPENDENCY_LIMIT_REACHED',
        422,
        'Dự án đã đạt giới hạn tối đa số lượng phụ thuộc',
      );
    }

    let blockerIncident = 0;
    let blockedIncident = 0;
    for (const edge of existingEdges) {
      if (edge.blocker_task_id === input.blockerTaskId || edge.blocked_task_id === input.blockerTaskId) {
        blockerIncident++;
      }
      if (edge.blocker_task_id === input.blockedTaskId || edge.blocked_task_id === input.blockedTaskId) {
        blockedIncident++;
      }
    }
    if (blockerIncident >= TASK_DEPENDENCIES_MAX || blockedIncident >= TASK_DEPENDENCIES_MAX) {
      throw new DomainError(
        'DEPENDENCY_LIMIT_REACHED',
        422,
        'Công việc đã đạt giới hạn tối đa số lượng phụ thuộc',
      );
    }

    const dependencyId = randomUUID();
    await ctx.trx
      .insertInto('ludy_projects.task_dependency')
      .values({
        org_id: ctx.orgId,
        id: dependencyId,
        project_id: project.id,
        blocker_task_id: input.blockerTaskId,
        blocked_task_id: input.blockedTaskId,
        created_by: userId,
        created_at: ctx.now,
      })
      .execute()
      .catch((error: unknown) => {
        const pg = error as { code?: string; constraint?: string } | null | undefined;
        if (pg?.code === '23505' && pg.constraint === 'task_dependency_edge_uq') {
          throw new DomainError('DEPENDENCY_ALREADY_EXISTS', 409, 'Phụ thuộc giữa hai công việc này đã tồn tại');
        }
        throw error;
      });

    ctx.audit({
      dependencyId,
      projectId: project.id,
      blockerTaskId: input.blockerTaskId,
      blockedTaskId: input.blockedTaskId,
    });
    await ctx.emit('projects.dependency.added', {
      dependencyId,
      projectId: project.id,
      blockerTaskId: input.blockerTaskId,
      blockedTaskId: input.blockedTaskId,
    });
    await ctx.activity('projects.project', project.id, 'projects.dependency.added', 'Thêm phụ thuộc công việc');

    return {
      dependencyId,
      projectId: project.id,
      blockerTaskId: input.blockerTaskId,
      blockedTaskId: input.blockedTaskId,
      createdAt: ctx.now.toISOString(),
    };
  },
});

export const projectDependencyRemove = defineCommand({
  name: 'projects.dependency.remove',
  input: zProjectDependencyRemoveInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'task_dependency', [
      'org_id',
      'id',
      'project_id',
      'blocker_task_id',
      'blocked_task_id',
      'created_by',
      'created_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectDependencyRemoveResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const edgeFilter =
      input.dependencyId !== undefined
        ? sql<boolean>`d.id = ${input.dependencyId}::uuid`
        : sql<boolean>`(d.blocker_task_id = ${input.blockerTaskId!}::uuid AND d.blocked_task_id = ${input.blockedTaskId!}::uuid)`;

    const { rows } = await sql<{
      id: string;
      blocker_task_id: string;
      blocked_task_id: string;
      visible: boolean;
    }>`
      SELECT
        d.id,
        d.blocker_task_id,
        d.blocked_task_id,
        (bt.id IS NOT NULL AND dt.id IS NOT NULL) AS visible
      FROM ludy_projects.task_dependency d
      LEFT JOIN ludy_kernel.task bt
        ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
      LEFT JOIN ludy_kernel.task dt
        ON dt.org_id = d.org_id AND dt.id = d.blocked_task_id
      WHERE d.org_id = ${ctx.orgId}::uuid
        AND d.project_id = ${project.id}::uuid
        AND (${edgeFilter})
      LIMIT 1`.execute(ctx.trx);

    const existing = rows[0];
    if (existing && !existing.visible) {
      throw taskNotFound();
    }

    let removed = false;
    let dependencyId: string | null = null;
    if (existing) {
      await ctx.trx
        .deleteFrom('ludy_projects.task_dependency')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('id', '=', existing.id)
        .execute();
      removed = true;
      dependencyId = existing.id;
    }

    ctx.audit({
      projectId: project.id,
      dependencyId: dependencyId ?? input.dependencyId ?? null,
      removed,
    });
    if (removed && existing) {
      await ctx.emit('projects.dependency.removed', {
        dependencyId: existing.id,
        projectId: project.id,
        blockerTaskId: existing.blocker_task_id,
        blockedTaskId: existing.blocked_task_id,
      });
      await ctx.activity('projects.project', project.id, 'projects.dependency.removed', 'Gỡ phụ thuộc công việc');
    }

    return { removed, dependencyId };
  },
});

export const projectDependencyList = defineQuery({
  name: 'projects.dependency.list',
  input: zProjectDependencyListInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectDependencyListResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    const taskFilter = input.taskId
      ? sql<boolean>`(d.blocker_task_id = ${input.taskId}::uuid OR d.blocked_task_id = ${input.taskId}::uuid)`
      : sql<boolean>`TRUE`;

    const { rows } = await sql<{
      id: string;
      project_id: string;
      blocker_task_id: string;
      blocked_task_id: string;
      created_by: string | null;
      created_at: Date | string;
      blocker_title: string;
      blocker_status: string;
      blocker_due: Date | string | null;
      blocked_title: string;
      blocked_status: string;
      blocked_due: Date | string | null;
    }>`
      SELECT
        d.id,
        d.project_id,
        d.blocker_task_id,
        d.blocked_task_id,
        d.created_by,
        d.created_at,
        bt.title AS blocker_title,
        bt.status AS blocker_status,
        bt.due AS blocker_due,
        dt.title AS blocked_title,
        dt.status AS blocked_status,
        dt.due AS blocked_due
      FROM ludy_projects.task_dependency d
      JOIN ludy_kernel.task bt
        ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
      JOIN ludy_kernel.task dt
        ON dt.org_id = d.org_id AND dt.id = d.blocked_task_id
      WHERE d.org_id = ${ctx.orgId}::uuid
        AND d.project_id = ${project.id}::uuid
        AND (${taskFilter})
      ORDER BY d.created_at ASC, d.id ASC`.execute(ctx.trx);

    const edges: ProjectDependencyEdge[] = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      blockerTaskId: r.blocker_task_id,
      blockedTaskId: r.blocked_task_id,
      createdBy: r.created_by,
      createdAt: toIso(r.created_at),
      blocker: {
        id: r.blocker_task_id,
        title: r.blocker_title,
        status: r.blocker_status as TaskStatus,
        due: r.blocker_due === null ? null : toIso(r.blocker_due),
      },
      blocked: {
        id: r.blocked_task_id,
        title: r.blocked_title,
        status: r.blocked_status as TaskStatus,
        due: r.blocked_due === null ? null : toIso(r.blocked_due),
      },
    }));

    return {
      projectId: project.id,
      edges,
      totalEdges: edges.length,
    };
  },
});
