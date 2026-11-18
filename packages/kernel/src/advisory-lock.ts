// SPDX-License-Identifier: AGPL-3.0-only
// Shared transaction-scoped PostgreSQL advisory lock helper (#3447).
//
// Acquires a 64-bit transaction-level advisory lock via `pg_catalog.hashtextextended(key, 0)` on the command's
// transaction (`ctx.trx`) so concurrent writers on the same logical resource serialize cleanly and release the
// lock automatically on commit or rollback without holding session locks on pooled connections.
import { sql } from 'kysely';
import type { CommandContext } from '@crove/kernel-runtime';

/** Builds a canonical colon-delimited advisory lock key (`<namespace>:<part1>:<part2>...`) from non-empty segments. */
export function advisoryLockKey(namespace: string, ...parts: readonly string[]): string {
  const cleanNamespace = namespace.trim();
  if (!cleanNamespace) {
    throw new Error('advisoryLockKey requires a non-empty namespace');
  }
  for (const part of parts) {
    if (!part || !part.trim()) {
      throw new Error('advisoryLockKey requires non-empty key parts');
    }
  }
  return [cleanNamespace, ...parts.map((part) => part.trim())].join(':');
}

/** Acquires a transaction-scoped PostgreSQL advisory lock (`pg_advisory_xact_lock(hashtextextended(key, 0))`) on `trx`. */
export async function acquireAdvisoryXactLock(trx: CommandContext['trx'], key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error('acquireAdvisoryXactLock requires a non-empty lock key');
  }
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${trimmed}, 0))`.execute(trx);
}
