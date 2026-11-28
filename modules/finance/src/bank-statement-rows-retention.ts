// SPDX-License-Identifier: AGPL-3.0-only
// Retention of the parsed rows of a decided bank statement (#2195, the pattern of marketplace-retention.ts). The Inbox stages a statement as an extraction version that holds the parsed rows
// (the other side's names, descriptions and account numbers, amounts); a decision inserts a newer, finished version with the summary only. BANK_STATEMENT_ROWS_RETENTION_DAYS (kernel-contract)
// after the decision, the worker (apps/kernel/src/bank-statement-retention.ts) lists the decided statements (ludy_finance.bank_statement_rows_due, worker only) and runs this command for
// each, in its own org: ludy_finance.bank_statement_rows_apply deletes the OLDER versions that hold the rows and nothing else. The decision's version (file name, the org's own account
// number, counts, totals, the import id), the file row, its original bytes, the audit trail and the lines already booked stay. extraction_guard is untouched: a finished version still never
// changes. The database checks the kind, the decision, the age, the file's evidence hold and the file lock again, so a bug in the job can fail a run but never delete a statement still waiting
// for a member, another kind of file, or anything before day 90.
// Not declared runsWhenOff (owner decision on #2195): an org that switched finance off waits, and the sweep catches up when it is turned on again.
// The audit trail carries the file id and counts only: nothing of the statement.
import { sql } from 'kysely';
import { z } from 'zod';
import { BANK_STATEMENT_ROWS_RETENTION_DAYS, zId } from '@ludy/kernel-contract';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';

// Deletes the staged versions that hold the rows of one decided statement. applied is false for a file that is not, or no longer, due (or that has no rows left).
export const bankStatementRowsPurge = defineCommand({
  name: 'finance.bank.statement_rows_purge',
  input: z.strictObject({ fileId: zId }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input): Promise<{ applied: boolean; versions: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
    const { rows } = await sql<{ applied: boolean; versions: number }>`
      SELECT applied, versions FROM ludy_finance.bank_statement_rows_apply(${ctx.orgId}::uuid, ${input.fileId}::uuid, ${BANK_STATEMENT_ROWS_RETENTION_DAYS}::int)`.execute(ctx.trx);
    const out = { applied: rows[0]?.applied === true, versions: rows[0]?.versions ?? 0 };
    ctx.audit({ fileId: input.fileId, applied: out.applied, versions: out.versions });
    return out;
  },
});

export const bankStatementRowsRetentionCommands = [bankStatementRowsPurge];
