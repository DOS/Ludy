// SPDX-License-Identifier: AGPL-3.0-only
// Nightly keeping sweep for Projects Public Roadmap OTP challenges (#4399, ADR-0053, ADR-0057).
// Prunes expired/invalidated `ludy_projects.roadmap_otp` rows older than 24 hours even when `projects` is switched off.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import type { Actor, Runtime } from '@ludy/kernel-runtime';

export const ROADMAP_OTP_RETENTION_HOURS = 24;
const SWEEP_ORG_BATCH = 500;
const ROADMAP_CLEANUP_ACTOR: Actor = { type: 'system', component: 'worker:projects-roadmap-otp-cleanup' };

export async function sweepRoadmapOtpCleanup(deps: {
  workerDb: Db;
  runtime: Runtime;
  now?: Date;
  log?: Pick<Console, 'log' | 'error'>;
}): Promise<{ orgs: number; deleted: number }> {
  const log = deps.log ?? console;
  const nowMs = (deps.now ?? new Date()).getTime();
  const cutoff = new Date(nowMs - ROADMAP_OTP_RETENTION_HOURS * 3_600_000);
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id
      FROM ludy_projects.cleanup_roadmap_otp_due_orgs(${cutoff}::timestamptz, ${SWEEP_ORG_BATCH}::int)
     ORDER BY org_id ASC`.execute(deps.workerDb);

  const totals = { orgs: 0, deleted: 0 };
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ deleted: number }>(
        'kernel.projects_roadmap.otp_cleanup',
        { cutoff: cutoff.toISOString() },
        { actor: ROADMAP_CLEANUP_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.deleted += res.deleted;
    } catch (error) {
      log.error(`[projects-roadmap-cleanup] org ${row.org_id.slice(0, 8)} failed`, error instanceof Error ? error.name : 'error');
    }
  }
  return totals;
}
