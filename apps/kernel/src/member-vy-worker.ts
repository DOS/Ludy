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
// A pass that hangs is expired after an hour, so the next night's run is not held behind it (pg-boss would otherwise wait its default 15 minutes and then retry,
// which cuts a long pass of many orgs short). A pass handles at most ORGS_PER_PASS orgs and FORMER_MEMBERS_PER_PASS members, each in its own transaction.
export const MEMBER_VY_SWEEP_EXPIRE_SECONDS = 3600;
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
// The orgs (id prefixes) whose unrecorded former members this process has already logged: the same orgs stay in that state every night, so a line is written for an org
// the first time this process sees it and not again (a restart logs once more). Tests pass their own set.
const reportedUnrecorded = new Set<string>();

export async function sweepMemberVyFormerMembers(deps: { runtime: Runtime; workerDb: Db; reported?: Set<string> }): Promise<number> {
  const reported = deps.reported ?? reportedUnrecorded;
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
  // One line for the orgs not seen before, not one per member and not one every night: which orgs (prefixes only) hold data whose latest exit is not recorded.
  const fresh = [...unrecorded].filter((org) => !reported.has(org));
  for (const org of fresh) reported.add(org);
  if (fresh.length > 0) console.warn(`[member-vy-sweep] former members whose latest exit is not recorded, data kept, in ${fresh.length} new org(s): ${fresh.slice(0, 20).join(', ')}`);
  return removed;
}
