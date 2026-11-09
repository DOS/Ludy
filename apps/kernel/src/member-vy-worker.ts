// SPDX-License-Identifier: AGPL-3.0-only
// The worker's part of Vy working for one member (ADR-0049 decision 3, #2822), independent of the Notes module: once a day, the results past their
// expires_at are removed, then the results and memory of the people who left more than 30 days ago (the definer itself refuses a member or a removal
// younger than that, so this sweep cannot purge early). Each org is handled in its own system context through the commands
// kernel.vy_data.results.expire and kernel.vy_data.member_data.purge; the lists come from definers that answer ids, never text. Logs carry org
// prefixes and codes only.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

// After the nightly retention purge (02:30) and the notes trash (02:45), on the same clock.
export const MEMBER_VY_SWEEP_CRON = '15 3 * * *';
export const MEMBER_VY_SWEEP_TZ = 'Asia/Ho_Chi_Minh';
// Orgs and former members one pass handles at most; the rest wait for the next night.
const ORGS_PER_PASS = 500;
const FORMER_MEMBERS_PER_PASS = 500;

const ACTOR = { type: 'system' as const, component: 'kernel.member_vy' };

const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

// One pass of the expiry: every org that holds a result past its expires_at, emptied of them in its own system context (the command removes
// up to 50,000 at a time, in batches of 1,000). The due list is read in pages of ORGS_PER_PASS by org id, so the pass reaches every due org.
export async function sweepMemberVyResults(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  let removed = 0;
  let after: string | null = null;
  for (;;) {
    const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_kernel.member_vy_results_due(${ORGS_PER_PASS}::int, ${after}::uuid)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        removed += (await deps.runtime.execute<{ removed: number }>('kernel.vy_data.results.expire', {}, { actor: ACTOR, orgId: row.org_id })).removed;
      } catch (error) {
        console.warn(`[member-vy-sweep] results, org ${row.org_id.slice(0, 8)}`, codeOf(error));
      }
    }
    if (rows.length < ORGS_PER_PASS) return removed;
    after = rows[rows.length - 1]?.org_id ?? null;
  }
}

// One pass of the former members, after the expiry: the users who hold Vy results or memory in an org they left more than 30 days ago, each purged in
// the org's system context. A user whose membership ended with no removal in the audit trail has no date to count the 30 days from: their data is
// kept and logged, never purged here (the rule of the Notes sweep).
export async function sweepMemberVyFormerMembers(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; user_id: string; recorded: boolean }>`
    SELECT org_id, user_id, recorded FROM crove_kernel.member_vy_former_members_due(${FORMER_MEMBERS_PER_PASS}::int)`.execute(deps.workerDb);
  let removed = 0;
  const unrecorded = new Set<string>();
  for (const row of rows) {
    if (!row.recorded) {
      unrecorded.add(row.org_id.slice(0, 8));
      continue;
    }
    try {
      removed += (await deps.runtime.execute<{ removed: number }>('kernel.vy_data.member_data.purge', { userId: row.user_id }, { actor: ACTOR, orgId: row.org_id })).removed;
    } catch (error) {
      console.warn(`[member-vy-sweep] former member, org ${row.org_id.slice(0, 8)}`, codeOf(error));
    }
  }
  // One line a night, not one per member: how many were kept and in which orgs (prefixes only).
  if (unrecorded.size > 0) console.warn(`[member-vy-sweep] former members with no recorded removal, data kept, in ${unrecorded.size} org(s): ${[...unrecorded].slice(0, 20).join(', ')}`);
  return removed;
}
