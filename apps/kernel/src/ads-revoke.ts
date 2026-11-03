// SPDX-License-Identifier: AGPL-3.0-only
// The revoke at the platform of the token of a closed ads connection (ADR-0043 point 4, ADR-0025's amendment of 2026-11-03, issue #2296, W2-1), run by the
// worker as the system, once a minute. When an ads write connection is closed (or a read connection whose token holds a spend permission), the database
// copies its sealed token into a holding of its own in the transaction that drops it (crove_ads.token_hold); this sweep removes the person's permissions at
// the platform from that copy, and the copy is wiped when it worked, after ten tries or seven days (modules/ads/src/token-revoke.ts is the policy).
//
// What this file may do with a token is one thing: open the copy of one obligation through the worker-only definer `crove_ads.token_seal_get`, with the
// credential broker, and hand it to the narrowed `AdRevoker` of its provider (`revokeToken` and no other call). The secret lives in one function's scope, is
// never logged, never put in an error, and never reaches a command: the outcome that is recorded (ads.token_revoke.record) is a state, a kind of error
// and the platform's own error code. The job carries no data (a sweep on a schedule), so no id of an org or a token sits in a job either.
//
// A sweep does three things in order, each safe to run again:
// 1. Obligations past their seven days are settled without a try and their copies wiped.
// 2. A write connection whose connector is no longer an owner or admin of the org (a removed member's, a demoted or disabled one's) is closed with the
//    kernel's system command, so the token that nobody can use any more is held, revoked and wiped instead of sitting in Ludy.
// 3. Due obligations are claimed (a lease of ten minutes in the database, so two workers never try one at once and a crash is found again) and tried.
import { sql } from 'kysely';
import { AdPlatformError, type AdRevoker } from '@crove/ad-platform';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'ads.revoke' };

// The obligations one claim takes, and how many claims one sweep makes at most (a minute's work; the rest waits for the next sweep).
export const ADS_REVOKE_BATCH = 20;
export const ADS_REVOKE_MAX_BATCHES = 5;
// The orphan connections one page reads.
export const ADS_ORPHAN_PAGE = 200;

export interface AdsRevokeDeps {
  runtime: Runtime;
  workerDb: Db;
  // Without a broker nothing can be opened: a due obligation is tried and fails (NO_BROKER), up to its limits.
  broker: CredentialBroker | undefined;
  revokers: Readonly<Record<string, AdRevoker>>;
}

export interface AdsRevokeResult {
  expired: number;
  closed: number;
  tried: number;
  done: number;
}

type Outcome =
  | { kind: 'done'; how: 'revoked' | 'already_invalid' | 'sandbox' }
  | { kind: 'failed'; error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'; code: string | null; retryAt: string | null };

const failed = (error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown', code: string): Outcome => ({ kind: 'failed', error, code, retryAt: null });

// The code of a failure that is not the platform's: a database or broker error is named by its class, never by its message (a message may carry a value).
const codeOf = (error: unknown): string => {
  if (error instanceof DomainError) return error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64);
  return 'ERROR';
};

// One try of one obligation: opens the copy, calls the revoker, and says what came of it. Never throws and never returns or logs the secret.
async function attempt(deps: AdsRevokeDeps, row: { orgId: string; id: string; provider: string }): Promise<Outcome> {
  const revoker = Object.hasOwn(deps.revokers, row.provider) ? deps.revokers[row.provider] : undefined;
  if (!revoker) return failed('unknown', 'NO_REVOKER');
  if (!deps.broker) return failed('unknown', 'NO_BROKER');
  let secret: string;
  try {
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account_id: string }>`
      SELECT key_id, envelope, provider, external_account_id FROM crove_ads.token_seal_get(${row.orgId}::uuid, ${row.id}::uuid)`.execute(deps.workerDb);
    const sealed = rows[0];
    if (!sealed) return failed('unknown', 'SEAL_GONE');
    secret = deps.broker.open({ keyId: sealed.key_id, envelope: sealed.envelope }, { orgId: row.orgId, provider: sealed.provider, externalAccountId: sealed.external_account_id });
  } catch (error) {
    // A seal that is gone is not a platform failure but is counted as a try all the same (the record command refuses an obligation already settled).
    if ((error as { message?: unknown } | null)?.message === 'ADS_SEAL_GONE') return failed('unknown', 'SEAL_GONE');
    return failed('unknown', 'OPEN_FAILED');
  }
  try {
    const revoked = await revoker.revokeToken(secret);
    return { kind: 'done', how: revoked.how };
  } catch (error) {
    if (error instanceof AdPlatformError) {
      // A token the platform no longer accepts has nothing left to revoke.
      if (error.kind === 'token_expired') return { kind: 'done', how: 'already_invalid' };
      return { kind: 'failed', error: error.kind, code: error.code && /^[A-Za-z0-9_.]{1,64}$/.test(error.code) ? error.code : null, retryAt: error.retryAt ? error.retryAt.toISOString() : null };
    }
    return failed('unknown', 'ERROR');
  }
}

export async function runAdsRevoke(deps: AdsRevokeDeps): Promise<AdsRevokeResult> {
  const result: AdsRevokeResult = { expired: 0, closed: 0, tried: 0, done: 0 };

  // 1. Past their age: settled without a try, the copies wiped.
  const { rows: expired } = await sql<{ n: number }>`SELECT crove_ads.token_revoke_expire() AS n`.execute(deps.workerDb);
  result.expired = expired[0]?.n ?? 0;

  // 2. Write connections of people who left: closed, so the holding is made and the revoke below finds it.
  let after: { orgId: string; connectionId: string } | null = null;
  for (;;) {
    const { rows } = await sql<{ org_id: string; connection_id: string }>`
      SELECT org_id, connection_id FROM crove_ads.write_orphans(${after?.orgId ?? null}::uuid, ${after?.connectionId ?? null}::uuid, ${ADS_ORPHAN_PAGE}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        const closed = await deps.runtime.execute<{ closed: boolean }>('kernel.channel.close_orphan', { connectionId: row.connection_id }, { actor: SYSTEM, orgId: row.org_id });
        if (closed.closed) result.closed++;
      } catch (error) {
        // By code only: the next sweep finds it again.
        console.warn(`[ads-revoke] a connection of a member who left could not be closed: ${codeOf(error)}`);
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < ADS_ORPHAN_PAGE) break;
    after = { orgId: last.org_id, connectionId: last.connection_id };
  }

  // 3. Due obligations.
  for (let batch = 0; batch < ADS_REVOKE_MAX_BATCHES; batch++) {
    const { rows } = await sql<{ org_id: string; id: string; provider: string }>`SELECT org_id, id, provider FROM crove_ads.token_revoke_due(${ADS_REVOKE_BATCH}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      const outcome = await attempt(deps, { orgId: row.org_id, id: row.id, provider: row.provider });
      result.tried++;
      try {
        const recorded = await deps.runtime.execute<{ state: 'pending' | 'done' | 'gave_up'; recorded: boolean }>('ads.token_revoke.record', { revokeId: row.id, outcome }, { actor: SYSTEM, orgId: row.org_id });
        if (recorded.recorded && recorded.state === 'done') result.done++;
      } catch (error) {
        // The lease puts the obligation back in ten minutes with its count as it was; nothing of the outcome is logged.
        console.warn(`[ads-revoke] an outcome could not be recorded: ${codeOf(error)}`);
      }
    }
    if (rows.length < ADS_REVOKE_BATCH) break;
  }
  return result;
}
