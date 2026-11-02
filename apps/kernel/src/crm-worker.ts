// SPDX-License-Identifier: AGPL-3.0-only
// The worker's part of the crm module's contact import (issue #2251, docs/plan/crm.md step K5b): the daily sweep of staged
// import rows past their 7 days. A commit, a cancel and the next import command of an org already clear what they
// find; this pass reaches the orgs that never import again. startWorker() works and schedules it only when the crm module is
// installed (Runtime.installed('crm'), CROVE_MODULES). The definer lists org ids; the deletion runs as the crm.import.expire
// command in each org's system context. Logs carry ids and codes only.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { IMPORT_STAGED_DAYS } from '@crove/kernel-contract';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

// After the nightly retention purge (02:30) and the notes trash (02:45), on the same clock.
export const CRM_IMPORT_EXPIRE_CRON = '0 3 * * *';
// Orgs one sweep clears at most; the rest wait for the next night.
const SWEEP_ORGS = 500;

const ACTOR = { type: 'system' as const, component: 'crm.import' };

// One pass: every org with a staged batch past the limit, cleared in its own system context. Returns the rows deleted.
export async function sweepCrmImports(deps: { runtime: Runtime; workerDb: Db }, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - IMPORT_STAGED_DAYS * 86_400_000);
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_crm.import_expired(${before}::timestamptz, ${SWEEP_ORGS}::int)`.execute(deps.workerDb);
  let removed = 0;
  for (const row of rows) {
    try {
      removed += (await deps.runtime.execute<{ batches: number; rows: number }>('crm.import.expire', {}, { actor: ACTOR, orgId: row.org_id })).rows;
    } catch (error) {
      console.warn(`[crm-import-expire] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return removed;
}

// The stale-deal rule (#2381, docs/plan/crm.md): once a day, after the import sweep, on the same clock (Vietnam's day is the rule's day).
export const CRM_DEAL_STALE_CRON = '0 4 * * *';
// Orgs one definer call lists, and batches one run walks: past a few thousand orgs with stale deals the rest wait for the next night.
const STALE_ORGS_BATCH = 200;
const STALE_MAX_BATCHES = 50;

const STALE_ACTOR = { type: 'system' as const, component: 'crm.deal_stale' };

// One pass: every org with an open deal that could be stale, in org id order, runs crm.next_step.raise in its own system context. Returns the
// orgs it ran in and the steps raised.
export async function raiseCrmNextSteps(deps: { runtime: Runtime; workerDb: Db }): Promise<{ orgs: number; raised: number }> {
  let after: string | null = null;
  let orgs = 0;
  let raised = 0;
  for (let batch = 0; batch < STALE_MAX_BATCHES; batch++) {
    const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_crm.deal_stale_orgs(${after}::uuid, ${STALE_ORGS_BATCH}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        raised += (await deps.runtime.execute<{ raised: number; closed: number }>('crm.next_step.raise', {}, { actor: STALE_ACTOR, orgId: row.org_id })).raised;
        orgs += 1;
      } catch (error) {
        console.warn(`[crm-deal-stale] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    const last = rows.at(-1);
    if (rows.length < STALE_ORGS_BATCH || !last) break;
    after = last.org_id;
  }
  return { orgs, raised };
}
