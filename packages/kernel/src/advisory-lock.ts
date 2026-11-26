// SPDX-License-Identifier: AGPL-3.0-only
// Shared transaction-scoped PostgreSQL advisory lock helper (#3447).
//
// Acquires a 64-bit transaction-level advisory lock via `pg_catalog.hashtextextended(key, 0)` on the command's
// transaction (`ctx.trx`) so concurrent writers on the same logical resource serialize cleanly and release the
// lock automatically on commit or rollback without holding session locks on pooled connections.
import { sql } from 'kysely';
import type { CommandContext } from '@ludy/kernel-runtime';

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

// Global lock hierarchy for WhatsApp number hand-over (#3152):
//   1. ludy.whatsapp_handover:<externalAccountId> (cross-org advisory lock)
//   2. crove.channel:<orgId>:<provider>:<externalAccountId> (per-org advisory lock)
//   3. SELECT ... FOR UPDATE (row lock acquired by the caller after this helper returns)
export async function acquireChannelLocks(
  trx: CommandContext['trx'],
  orgId: string,
  provider: string,
  externalAccountId: string,
): Promise<void> {
  const channelKey = advisoryLockKey('crove.channel', orgId, provider, externalAccountId);
  const handoverKey = provider.trim() === 'whatsapp' ? advisoryLockKey('ludy.whatsapp_handover', externalAccountId) : null;
  if (handoverKey !== null) {
    await acquireAdvisoryXactLock(trx, handoverKey);
  }
  await acquireAdvisoryXactLock(trx, channelKey);
}

// Disconnecting, revoking, or erasing an existing channel_connection row must keep working and drop credentials even
// if a historical row written before connect validation holds a whitespace-only external_account_id (#5047).
export async function acquireChannelLocksForStoredRow(
  trx: CommandContext['trx'],
  orgId: string,
  provider: string,
  externalAccountId: string,
): Promise<void> {
  if (externalAccountId.trim()) {
    await acquireChannelLocks(trx, orgId, provider, externalAccountId);
    return;
  }
  const channelPrefix = advisoryLockKey('crove.channel', orgId, provider);
  if (provider.trim() === 'whatsapp') {
    await acquireAdvisoryXactLock(trx, 'ludy.whatsapp_handover:');
  }
  await acquireAdvisoryXactLock(trx, `${channelPrefix}:`);
}
