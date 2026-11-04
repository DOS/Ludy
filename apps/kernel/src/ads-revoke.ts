// SPDX-License-Identifier: AGPL-3.0-only
// The revoke at the platform of the token of a closed ads connection (ADR-0043 point 4, ADR-0025's amendment of 2026-11-03, issue #2296, W2-1), run by the
// worker as the system, once a minute. When an ads write connection is closed (or a Meta read connection whose token holds a spend permission), the database
// copies its sealed token into a holding of its own in the statement that drops it (crove_ads.token_hold); this sweep removes the person's permissions at
// the platform from that copy, and the copy is wiped when it worked, when the person had already removed the app, when another live connection of the same
// person needs the grant, when the platform refuses the token or the copy does not open (nothing can be revoked from it), and after ten tries or seven days
// (modules/ads/src/token-revoke.ts is the policy). A deployment that lacks the platform app's secret or the credential key records nothing: the copies wait.
//
// What this file may do with a token is one thing: open the copy of one claimed obligation through the worker-only definer `crove_ads.token_seal_get`, in
// the org's system context, with the credential broker, and hand it to the narrowed `AdRevoker` of its provider (`revokeToken` and no other call). The
// definer counts the try as it opens, so a crash, a retry and a failed call all count. The secret lives in one function's scope, is never logged, never put
// in an error, and never reaches a command: the outcome that is recorded (ads.token_revoke.record) is a state, a kind of error and the platform's own error
// code. The job carries no data (a sweep on a schedule, never retried by the queue), so no id of an org or a token sits in a job either.
//
// A sweep does three things in order, each safe to run again:
// 1. Obligations past their seven days or their ten tries are settled and their copies wiped.
// 2. A write connection whose connector is no longer an owner or admin of the org (a removed member's, a demoted or disabled one's) is closed with the
//    kernel's system command, so the token that nobody can use any more is held, revoked and wiped instead of sitting in Ludy.
// 3. Due obligations are claimed (a lease of ten minutes in the database, so two workers never try one at once and a crash is found again) and tried. A
//    revoke is the person's, for the app, in every org: before the call, a definer says (a boolean, nothing else) whether another live connection of the same
//    person needs the grant, and then the call is not made.
import { sql } from 'kysely';
import { AdPlatformError, type AdRevoker } from '@crove/ad-platform';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import type { PauseBegin, PauseRecorded } from '@crove/mod-ads';
import { pauseWork } from './ads-pause-run.ts';

const SYSTEM = { type: 'system' as const, component: 'ads.revoke' };

// The obligations one claim takes, and how many claims one sweep makes at most (a minute's work; the rest waits for the next sweep).
export const ADS_REVOKE_BATCH = 20;
export const ADS_REVOKE_MAX_BATCHES = 5;
// The orphan connections one page reads, and how many pages one sweep reads at most (the rest waits for the next sweep).
export const ADS_ORPHAN_PAGE = 200;
export const ADS_ORPHAN_MAX_PAGES = 5;
// The launches of one obligation that are paused in one try (W2-4a); the rest wait for the next.
const PAUSES_PER_TRY = 5;

export interface AdsRevokeDeps {
  runtime: Runtime;
  workerDb: Db;
  // Without a broker (no credential key: absent, or the one with id 'none' that refuses everything) nothing can be opened: the copies stay pending until it is
  // configured or the seventh day ends them.
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
  | { kind: 'done'; how: 'revoked' | 'already_invalid' | 'sandbox' | 'shared_grant' }
  | { kind: 'unrevocable'; code: string | null }
  | { kind: 'failed'; error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown'; code: string | null; retryAt: string | null };

const unrevocable = (code: string | null): Outcome => ({ kind: 'unrevocable', code });
const failed = (error: 'rate_limited' | 'transient' | 'permission' | 'bad_request' | 'unknown', code: string): Outcome => ({ kind: 'failed', error, code, retryAt: null });

// The code of a failure that is not the platform's: a database or broker error is named by its class, never by its message (a message may carry a value).
const codeOf = (error: unknown): string => {
  if (error instanceof DomainError) return error.code.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 64);
  return 'ERROR';
};
const messageOf = (error: unknown): string | undefined => (error as { message?: unknown } | null)?.message as string | undefined;

// Whether another live connection of the same grantor, in any org, needs the grant (crove_ads.token_grant_shared: a boolean and nothing else).
async function sharedGrant(deps: AdsRevokeDeps, row: { orgId: string; id: string }): Promise<boolean> {
  const { rows } = await sql<{ shared: boolean }>`SELECT crove_ads.token_grant_shared(${row.orgId}::uuid, ${row.id}::uuid) AS shared`.execute(deps.workerDb);
  return rows[0]?.shared === true;
}

// The sealed copy of one claimed obligation, opened in the org's system context (the definer counts the try as it opens, with the claim's token). The
// context is entered in the same single statement, before the definer is called (the definer's argument reads the entering step's output, so the order
// holds), and ends with it: nothing is left on the pooled connection. Null when the copy is gone: settled, past its age or its tries, or not claimed by
// this sweep any more.
async function openCopy(deps: AdsRevokeDeps, row: { orgId: string; id: string; leaseToken: string }): Promise<{ keyId: string; envelope: Buffer; provider: string; externalAccountId: string } | null> {
  try {
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account_id: string }>`
      WITH entered AS (SELECT crove_kernel.enter_system_context(${row.orgId}::uuid))
      SELECT s.key_id, s.envelope, s.provider, s.external_account_id
      FROM crove_ads.token_seal_get((SELECT ${row.orgId}::uuid FROM entered), ${row.id}::uuid, ${row.leaseToken}::uuid) s`.execute(deps.workerDb);
    const sealed = rows[0];
    return sealed ? { keyId: sealed.key_id, envelope: sealed.envelope, provider: sealed.provider, externalAccountId: sealed.external_account_id } : null;
  } catch (error) {
    const message = messageOf(error);
    if (message === 'ADS_SEAL_GONE' || message === 'ADS_SEAL_NOT_CLAIMED') return null;
    throw error;
  }
}

// What the launches of the obligation's account made at the platform is paused before the permission is removed (ADR-0043 point 4, W2-4a): a switch-off stops them and
// closes the write connection in the same transaction, so the sealed copy this sweep holds is the only token left to pause with, and a revoke first would leave them
// running with nothing to stop them. The secret is handed to the narrowed pause of the revoker (`pauseWork`) and nowhere else. True while a launch is not paused yet
// (a run is in flight, the platform failed, or a create of the launch may still land): the revoke waits for the next try. A launch Ludy gives up on (the token is refused,
// ten runs, seven days) does not hold the revoke, and its person is told to pause by hand.
async function pausedFirst(deps: AdsRevokeDeps, row: { orgId: string; id: string }, secret: string, revoker: AdRevoker): Promise<boolean> {
  const options = { actor: SYSTEM, orgId: row.orgId };
  // The launches of the account to pause now, and whether others wait on this obligation: more than one page of this account's, or a launch of another account the
  // same person granted that is not paused yet (the revoke is the person's, for the app: it would cut the token that account's launches still need).
  const pending = await deps.runtime.query<{ launches: string[]; blocked: boolean; lastChance: boolean }>('ads.pause.pending', { revokeId: row.id }, options);
  let waiting = pending.blocked;
  // A few launches at a time: each pause may take minutes at a slow platform, and one account must not hold the sweep (the claims of the others run out in ten minutes).
  if (pending.launches.length > PAUSES_PER_TRY) waiting = true;
  for (const launchId of pending.launches.slice(0, PAUSES_PER_TRY)) {
    const work = await deps.runtime.execute<PauseBegin>('ads.pause.begin', { launchId, via: 'copy' }, options);
    if (work.action === 'none') {
      // Another run holds the launch: its pause is not over, and this token must not be revoked under it.
      if (work.reason === 'in_flight') waiting = true;
      continue;
    }
    const result = await pauseWork(revoker, secret, work);
    const recorded = await deps.runtime.execute<PauseRecorded>('ads.pause.record', { launchId, callKey: work.callKey, via: 'copy', result }, options);
    if (!recorded.recorded || recorded.state === 'pending') waiting = true;
  }
  // The obligation's last try revokes whatever the pause came to (see `lastChance` of ads.pause.pending): the permission is removed at the platform, and a launch still
  // not paused is told to the person by its wind-down, who pauses it by hand.
  return pending.lastChance ? false : waiting;
}

// One try of one obligation: opens the copy, calls the revoker, and says what came of it, or null when there is nothing to record (the copy is gone).
// Never throws a platform error and never returns or logs the secret.
async function attempt(deps: AdsRevokeDeps, row: { orgId: string; id: string; provider: string; leaseToken: string }): Promise<Outcome | null> {
  const revoker = Object.hasOwn(deps.revokers, row.provider) ? deps.revokers[row.provider] : undefined;
  // A deployment with no way to call the platform for this token (no app credentials, no credential key) is a configuration fault, not a finding about the
  // token: nothing is opened and nothing is recorded, so the copy stays pending, the claim runs out in ten minutes and it is claimed again once the
  // configuration is fixed. If it never is, the seventh day ends it as given up and the person is told to remove the app by hand (the owner's end
  // conditions are success, ten tries, seven days and the purge; a missing secret must not wipe every pending copy within a minute).
  // The kernel hands a worker with no credential key the broker that refuses everything (id 'none'), not an absent one: it is the same fault, and opening the
  // copy first would count a try and wipe the copy as one that does not open.
  if (!revoker) return null;
  if (!deps.broker || deps.broker.id === 'none') return null;
  // The person's permission is the person's across orgs: when another live connection of the same person needs it, no revoke call is made and the copy goes, but not
  // before what this account's launches made is paused with it (W2-4a): the copy is the only token the closed connection has left.
  const shared = await sharedGrant(deps, row);
  // A database failure while opening the copy is thrown: it leaves the claim to run out and the obligation to be claimed again.
  const sealed = await openCopy(deps, row);
  if (!sealed) return null;
  let secret: string;
  try {
    // The binding is the one stored on the obligation when the copy was made, never the live connection's.
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: sealed.envelope }, { orgId: row.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch {
    // A copy that no longer opens (a key that was removed too early) cannot be revoked from, nor paused with: given up, wiped, revoke by hand (and no revoke was needed when
    // another connection of the same person holds the grant).
    return shared ? { kind: 'done', how: 'shared_grant' } : unrevocable('OPEN_FAILED');
  }
  // What the account's launches made is paused first, with this same copy; the revoke waits for the next try while any is not (the policy's backoff and its ten tries and
  // seven days apply). A database failure here is thrown like one while opening the copy: the claim runs out and the obligation is claimed again.
  if (await pausedFirst(deps, row, secret, revoker)) return failed('transient', 'PAUSE_PENDING');
  if (shared) return { kind: 'done', how: 'shared_grant' };
  try {
    const revoked = await revoker.revokeToken(secret);
    return { kind: 'done', how: revoked.how };
  } catch (error) {
    if (error instanceof AdPlatformError) {
      // The platform does not accept the token and the person did not remove the app (the revoker already counted that one as done): nothing can be
      // revoked from this copy, and the grant may still stand.
      if (error.kind === 'token_expired') return unrevocable(error.code && /^[A-Za-z0-9_.]{1,64}$/.test(error.code) ? error.code : null);
      return { kind: 'failed', error: error.kind, code: error.code && /^[A-Za-z0-9_.]{1,64}$/.test(error.code) ? error.code : null, retryAt: error.retryAt ? error.retryAt.toISOString() : null };
    }
    return failed('unknown', 'ERROR');
  }
}

export async function runAdsRevoke(deps: AdsRevokeDeps): Promise<AdsRevokeResult> {
  const result: AdsRevokeResult = { expired: 0, closed: 0, tried: 0, done: 0 };

  // 1. Past their age or their tries: settled, the copies wiped.
  const { rows: expired } = await sql<{ n: number }>`SELECT crove_ads.token_revoke_expire() AS n`.execute(deps.workerDb);
  result.expired = expired[0]?.n ?? 0;

  // 2. Write connections of people who left: closed, so the holding is made and the revoke below finds it.
  let after = null as { orgId: string; connectionId: string } | null;
  for (let page = 0; page < ADS_ORPHAN_MAX_PAGES; page++) {
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
    const { rows } = await sql<{ org_id: string; id: string; provider: string; lease_token: string }>`SELECT org_id, id, provider, lease_token FROM crove_ads.token_revoke_due(${ADS_REVOKE_BATCH}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      let outcome: Outcome | null;
      try {
        outcome = await attempt(deps, { orgId: row.org_id, id: row.id, provider: row.provider, leaseToken: row.lease_token });
      } catch (error) {
        // The claim runs out in ten minutes and the obligation is claimed again; by code only.
        console.warn(`[ads-revoke] a copy could not be opened: ${codeOf(error)}`);
        continue;
      }
      if (!outcome) continue;
      result.tried++;
      try {
        const recorded = await deps.runtime.execute<{ state: 'pending' | 'done' | 'gave_up'; recorded: boolean }>('ads.token_revoke.record', { revokeId: row.id, leaseToken: row.lease_token, outcome }, { actor: SYSTEM, orgId: row.org_id });
        if (recorded.recorded && recorded.state === 'done') result.done++;
      } catch (error) {
        // The try was counted when the copy was opened; the claim runs out in ten minutes and the obligation is claimed again. Nothing of the outcome is logged.
        console.warn(`[ads-revoke] an outcome could not be recorded: ${codeOf(error)}`);
      }
    }
    if (rows.length < ADS_REVOKE_BATCH) break;
  }
  return result;
}
