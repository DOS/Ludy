// SPDX-License-Identifier: AGPL-3.0-only
// The nightly deletion of the parsed rows of a decided bank statement, the worker's side (#2195, modules/finance/src/bank-statement-rows-retention.ts).
//
// ludy_finance.bank_statement_rows_due (worker only) lists the statements a member imported or skipped more than BANK_STATEMENT_ROWS_RETENTION_DAYS ago whose staged rows are still there,
// for orgs whose finance app is on. For each, in its own org, finance.bank.statement_rows_purge deletes the staged extraction versions that hold the rows; the decision's summary, the file and
// its original, the audit trail and the booked lines stay. There is no stored object to delete here. Safe to run twice (a file with no rows left is no longer listed). A failing file is left for
// the next run and never holds the others behind it; an org that switched finance off between the list and the command is skipped, not failed (MODULE_OFF). Nothing here logs a file name, an
// account number or an amount: ids and counts.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { BANK_STATEMENT_ROWS_RETENTION_DAYS } from '@ludy/kernel-contract';
import { moduleOffOf, type Runtime, type SystemActor } from '@ludy/kernel-runtime';
import { opsAlert } from './ops-alert.ts';

const ACTOR: SystemActor = { type: 'system', component: 'finance.bank_statement_rows_retention' };
const TAG = '[bank-statement-retention]';
const DUE_BATCH = 200;
const MAX_BATCHES = 50;

type Log = Pick<Console, 'log' | 'error'>;

export interface BankStatementRetentionRun {
  statements: number;
  versions: number;
  skipped: number;
  failed: number;
}

/** One pass over the decided bank statements whose staged rows are due. */
export async function runBankStatementRetention(deps: { runtime: Runtime; workerDb: Db; log?: Log; batch?: number }): Promise<BankStatementRetentionRun> {
  const log = deps.log ?? console;
  const run: BankStatementRetentionRun = { statements: 0, versions: 0, skipped: 0, failed: 0 };
  // Files left in this run (failed, skipped, or not due any more): asked for again past them, so a few such rows never stall the others; the next run tries them again.
  const leftNow = new Set<string>();
  for (let pass = 0; pass < MAX_BATCHES; pass++) {
    const size = deps.batch ?? DUE_BATCH;
    const limit = Math.min(size + leftNow.size, 1000);
    const { rows: listed } = await sql<{ org_id: string; file_id: string }>`SELECT org_id, file_id FROM ludy_finance.bank_statement_rows_due(${BANK_STATEMENT_ROWS_RETENTION_DAYS}::int, ${limit}::int)`.execute(deps.workerDb);
    const rows = listed.filter((r) => !leftNow.has(r.file_id));
    for (const row of rows) {
      try {
        const out = await deps.runtime.execute<{ applied: boolean; versions: number }>('finance.bank.statement_rows_purge', { fileId: row.file_id }, { actor: ACTOR, orgId: row.org_id });
        if (out.applied) {
          run.statements += 1;
          run.versions += out.versions;
        } else {
          // Not due any more: a re-read staged it again, a hold was set, or another run got there first.
          leftNow.add(row.file_id);
        }
      } catch (error) {
        leftNow.add(row.file_id);
        if (moduleOffOf(error) !== null) {
          run.skipped += 1;
        } else {
          run.failed += 1;
          // Ids and the error's name only.
          log.error(`${TAG} file ${row.file_id.slice(0, 8)} in org ${row.org_id.slice(0, 8)} not cleared`, error instanceof Error ? error.name : typeof error);
        }
      }
    }
    // Nothing new in this batch (every row was already left in this run): they are tried on the next run. A full batch of left rows does not hide the newer ones behind it: the next list is asked for that many more.
    if (rows.length === 0 || listed.length < limit) break;
  }
  log.log(`${TAG} statements=${run.statements} versions=${run.versions} skipped=${run.skipped} failed=${run.failed}`);
  if (run.failed > 0) opsAlert(`${TAG} ALERT ${run.failed} bank statement(s) could not be cleared of their staged rows; the next run tries again`);
  return run;
}
