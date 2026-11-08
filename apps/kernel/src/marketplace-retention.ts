// SPDX-License-Identifier: AGPL-3.0-only
// The nightly deletion of the original file of a decided marketplace report, the worker's side (#2516 step C-2b3, ADR-0045 point 8, modules/finance/src/marketplace-retention.ts).
//
// crove_finance.marketplace_retention_due (worker only) lists the order and income reports a member decided more than MARKETPLACE_ORIGINAL_RETENTION_DAYS ago whose original is
// still there. For each, in its own org: the blob key is read (finance.marketplace_retention.key), the object is deleted unless another file row names the same key, and only then
// does finance.marketplace_retention.apply mark the original deleted and delete the staged extraction versions that hold the per-order amounts. The object goes first, so a crash
// between the two steps repeats the delete (a delete of a missing object is a no-op) and never leaves a file row marked deleted whose object still exists. Safe to run twice.
// A failing file is left for the next run and never holds the others behind it. Nothing here logs a filename, an order or an amount: ids and counts.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { BlobStore, Runtime, SystemActor } from '@crove/kernel-runtime';
import { MARKETPLACE_ORIGINAL_RETENTION_DAYS } from '@crove/kernel-contract';
import { opsAlert } from './ops-alert.ts';

const ACTOR: SystemActor = { type: 'system', component: 'finance.marketplace_retention' };
const TAG = '[marketplace-retention]';
const DUE_BATCH = 200;
const MAX_BATCHES = 50;

type Log = Pick<Console, 'log' | 'error'>;

export interface MarketplaceRetentionRun {
  deleted: number;
  objects: number;
  versions: number;
  failed: number;
}

/** One pass over the decided marketplace reports whose original is due. */
export async function runMarketplaceRetention(deps: { runtime: Runtime; workerDb: Db; store: BlobStore; log?: Log; batch?: number }): Promise<MarketplaceRetentionRun> {
  const log = deps.log ?? console;
  const run: MarketplaceRetentionRun = { deleted: 0, objects: 0, versions: 0, failed: 0 };
  // Files that failed in this run: asked for again past them, so a few failing rows never stall the others (the next run tries them again).
  const failedNow = new Set<string>();
  for (let pass = 0; pass < MAX_BATCHES; pass++) {
    const size = deps.batch ?? DUE_BATCH;
    const limit = Math.min(size + failedNow.size, 1000);
    const { rows: listed } = await sql<{ org_id: string; file_id: string }>`
      SELECT org_id, file_id FROM crove_finance.marketplace_retention_due(${MARKETPLACE_ORIGINAL_RETENTION_DAYS}::int, ${limit}::int)`.execute(deps.workerDb);
    const rows = listed.filter((r) => !failedNow.has(r.file_id));
    let progress = 0;
    for (const row of rows) {
      const options = { actor: ACTOR, orgId: row.org_id };
      try {
        const key = await deps.runtime.query<{ storageKey: string; shared: boolean } | null>('finance.marketplace_retention.key', { fileId: row.file_id }, options);
        if (key) {
          // An object another file row also names is left; only this file's original is marked gone.
          if (!key.shared) {
            await deps.store.delete(key.storageKey);
            run.objects += 1;
          }
          const out = await deps.runtime.execute<{ applied: boolean; versions: number }>('finance.marketplace_retention.apply', { fileId: row.file_id }, options);
          if (out.applied) {
            run.deleted += 1;
            run.versions += out.versions;
            progress += 1;
          }
        }
      } catch (error) {
        run.failed += 1;
        failedNow.add(row.file_id);
        // Ids and the error's name only.
        log.error(`${TAG} file ${row.file_id.slice(0, 8)} in org ${row.org_id.slice(0, 8)} not removed`, error instanceof Error ? error.name : typeof error);
      }
    }
    // A batch that removed nothing would list the same files again; they are tried on the next run.
    if (progress === 0 || listed.length < limit) break;
  }
  log.log(`${TAG} originals=${run.deleted} objects=${run.objects} versions=${run.versions} failed=${run.failed}`);
  if (run.failed > 0) opsAlert(`${TAG} ALERT ${run.failed} original file(s) could not be removed; the next run tries again`);
  return run;
}
