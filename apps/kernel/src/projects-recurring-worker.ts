// SPDX-License-Identifier: AGPL-3.0-only
// Worker sweep for recurring project tasks (#2607): scans ludy_projects.recurring_tasks_due and advances due series.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { ProjectRecurringAdvanceResult } from '@ludy/mod-projects';

export const PROJECTS_RECURRING_SWEEP_MS = 15 * 60_000;
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 10;
const SYSTEM_ACTOR: Actor = { type: 'system', component: 'worker:projects-recurring' };

/**
 * Advances every due recurring project task whose latest occurrence is closed ('done' or 'cancelled'),
 * skipping orgs where the `projects` app is disabled and logging only IDs/codes.
 */
export async function sweepProjectsRecurring(deps: {
  runtime: Runtime;
  workerDb: Db;
  pageSize?: number;
}): Promise<number> {
  const pageSize = deps.pageSize ?? SWEEP_PAGE_SIZE;
  const seen = new Set<string>();
  let created = 0;

  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const { rows } = await sql<{ org_id: string; project_id: string; task_id: string }>`
      SELECT org_id, project_id, task_id
        FROM ludy_projects.recurring_tasks_due(${pageSize}::int)`.execute(deps.workerDb);
    if (rows.length === 0) break;

    let progressed = 0;
    for (const row of rows) {
      const key = `${row.org_id}:${row.task_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (!(await deps.runtime.appOn(row.org_id, 'projects'))) continue;
        const result = await deps.runtime.execute<ProjectRecurringAdvanceResult>(
          'projects.recurring.advance',
          { projectId: row.project_id, taskId: row.task_id },
          { actor: SYSTEM_ACTOR, orgId: row.org_id },
        );
        if (result.createdTaskId !== null) {
          created += 1;
          progressed += 1;
        } else if (result.seriesEnded) {
          progressed += 1;
        }
      } catch (error) {
        if (error instanceof DomainError && error.code === 'MODULE_OFF') continue;
        console.warn(
          `[projects-recurring] task ${row.task_id.slice(0, 8)}`,
          error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error',
        );
      }
    }

    if (rows.length < pageSize || progressed === 0) break;
  }

  return created;
}
