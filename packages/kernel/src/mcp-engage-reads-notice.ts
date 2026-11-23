// SPDX-License-Identifier: AGPL-3.0-only
// The worker's pass that tells the people who connected an AI app before its Engage reads existed (#4069, follow-up of #4068; ADR-0051 decision 2). The scan
// (ludy_kernel.mcp_engage_reads_to_tell, ids only, across active orgs) finds the people with a live grant made before the consent screen named the reads, who were not told yet and are members now;
// for each it runs kernel.mcp.engage_reads_notify, which stamps their grants and writes one notification. A failure for one person never stops the others; it is tried again on the next pass.
// Once everyone was told the scan reads an empty partial index.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type Runtime, type SystemActor } from '@ludy/kernel-runtime';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.mcp.engage_reads_notice' };
// How often the worker looks, and how many people it takes per pass.
export const MCP_ENGAGE_READS_NOTICE_SWEEP_MS = 5 * 60_000;
export const MCP_ENGAGE_READS_NOTICE_LIMIT = 100;

// One pass; the number of people handled.
export async function sweepMcpEngageReadsNotices(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; user_id: string }>`SELECT org_id, user_id FROM ludy_kernel.mcp_engage_reads_to_tell(${MCP_ENGAGE_READS_NOTICE_LIMIT}::int)`.execute(deps.workerDb);
  let done = 0;
  for (const row of rows) {
    try {
      await deps.runtime.execute('kernel.mcp.engage_reads_notify', { userId: row.user_id }, { actor: ACTOR, orgId: row.org_id });
      done += 1;
    } catch (error) {
      console.warn(`[mcp-engage-reads-notice] ${row.user_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  return done;
}
