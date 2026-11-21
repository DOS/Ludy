// SPDX-License-Identifier: AGPL-3.0-only
// Retention of the original file of a decided marketplace report (#2516 step C-2b3, ADR-0045 point 8). The worker lists the decided order and income reports that are older than
// MARKETPLACE_ORIGINAL_RETENTION_DAYS (kernel-contract; crove_finance.marketplace_retention_due, worker only), and for each file, in its own org: reads its blob key here, deletes the object, then runs
// finance.marketplace_retention.apply, which marks the original deleted and deletes the staged extraction versions that hold the per-order amounts. The decision's own version (the
// summary: counts, totals, the settlement) and the file row (its sha256, so the same bytes are still recognised) stay. The database checks the kind, the decision and the age again,
// so a bug in the job can fail a run but never delete a bank statement, an invoice, a report still waiting for a member, or anything before day 90.
// The same two commands also serve the purge of what a GONE connection's poll brought in and no member imported (#4284, `disconnected: true`): MARKETPLACE_PURGE_GRACE_DAYS after the connection was
// disconnected or its channel revoked (or after it has stayed expired for MARKETPLACE_PURGE_EXPIRED_DAYS with no new authorization, and then the same grace: 30 + 7 = 37 days by default), the file row, its original and every read of it go (crove_finance.marketplace_purge_*,
// worker only), never a report a member imported. One command name, so the per-org app gate treats it as the retention it is.
// The audit trail carries the file id and counts only: nothing of the file.
import { sql } from 'kysely';
import { z } from 'zod';
import { MARKETPLACE_ORIGINAL_RETENTION_DAYS, MARKETPLACE_PURGE_EXPIRED_DAYS, MARKETPLACE_PURGE_GRACE_DAYS, zId } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

function requireSystem(ctx: CommandContext | QueryContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
}

// `disconnected`: the purge of a gone connection's never-booked files instead of the 90-day retention of decided reports.
const zFile = z.strictObject({ fileId: zId, disconnected: z.boolean().optional() });

// The blob key of one due file, and whether another file row names the same key (then the worker leaves the object). Nothing for a file that is not due.
export const marketplaceRetentionKey = defineQuery({
  name: 'finance.marketplace_retention.key',
  runsWhenOff: 'reads the file key of a report the retention removes while the app is off',
  input: zFile,
  access: 'system',
  handler: async (ctx, input): Promise<{ storageKey: string; shared: boolean } | null> => {
    requireSystem(ctx);
    const { rows } = input.disconnected
      ? await sql<{ storage_key: string; shared: boolean }>`
          SELECT storage_key, shared FROM crove_finance.marketplace_purge_key(${ctx.orgId}::uuid, ${input.fileId}::uuid, ${MARKETPLACE_PURGE_GRACE_DAYS}::int, ${MARKETPLACE_PURGE_EXPIRED_DAYS}::int)`.execute(ctx.trx)
      : await sql<{ storage_key: string; shared: boolean }>`
          SELECT storage_key, shared FROM crove_finance.marketplace_retention_key(${ctx.orgId}::uuid, ${input.fileId}::uuid, ${MARKETPLACE_ORIGINAL_RETENTION_DAYS}::int)`.execute(ctx.trx);
    const row = rows[0];
    return row ? { storageKey: row.storage_key, shared: row.shared } : null;
  },
});

// Marks the original deleted (the worker deleted the object first) and deletes the staged versions of the read; in the purge form it deletes the whole file row instead. applied is false for a file that is not, or no longer, due.
export const marketplaceRetentionApply = defineCommand({
  name: 'finance.marketplace_retention.apply',
  runsWhenOff: 'removes marketplace report files at the end of their retention while the app is off',
  input: zFile,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input): Promise<{ applied: boolean; versions: number }> => {
    requireSystem(ctx);
    const { rows } = input.disconnected
      ? await sql<{ applied: boolean; versions: number }>`
          SELECT applied, versions FROM crove_finance.marketplace_purge_apply(${ctx.orgId}::uuid, ${input.fileId}::uuid, ${MARKETPLACE_PURGE_GRACE_DAYS}::int, ${MARKETPLACE_PURGE_EXPIRED_DAYS}::int)`.execute(ctx.trx)
      : await sql<{ applied: boolean; versions: number }>`
          SELECT applied, versions FROM crove_finance.marketplace_retention_apply(${ctx.orgId}::uuid, ${input.fileId}::uuid, ${MARKETPLACE_ORIGINAL_RETENTION_DAYS}::int)`.execute(ctx.trx);
    const out = { applied: rows[0]?.applied === true, versions: rows[0]?.versions ?? 0 };
    ctx.audit({ fileId: input.fileId, applied: out.applied, versions: out.versions, ...(input.disconnected ? { disconnected: true } : {}) });
    return out;
  },
});

export const marketplaceRetentionCommands = [marketplaceRetentionApply];
export const marketplaceRetentionQueries = [marketplaceRetentionKey];
