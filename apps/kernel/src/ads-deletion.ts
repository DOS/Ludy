// SPDX-License-Identifier: AGPL-3.0-only
// Meta's data deletion request for the Ads connection (ads plan section 9, R7, #2219). Meta posts a form with a `signed_request`
// to the URL set in the app's dashboard when a person removes the app and asks for their data to be deleted. The API checks the
// signature before anything else: a forged, malformed or unsupported one is refused and stored nowhere. A verified one carries
// the person's app-scoped Meta user id, which is turned into the keyed hash a connection stores (platformUserHash) and handed,
// with a fresh confirmation code, to crove_ads.deletion_request_enqueue() without a tenant context. The id and the body are
// stored nowhere. The worker relay (apps/kernel/src/worker.ts) claims the requests, closes and erases the ad accounts the hash
// names in each org, and marks the request completed; the status page Meta shows the person reads it by the code.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { platformUserHash } from '@crove/ad-platform';
import type { Db } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

// A signed request is a few hundred bytes; this bounds what the API reads before checking its signature.
export const MAX_ADS_DELETION_BYTES = 8 * 1024;
// The requests one relay pass claims at most.
export const ADS_DELETION_CLAIM = 50;
export const ADS_DELETION_PATH = '/api/ads/meta/data-deletion';

const base64urlDecode = (text: string): Buffer | null => (/^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url') : null);

// How old a signed request may be, by the time Meta stamped it (`issued_at`, seconds): a replay of an old one is refused. A day
// leaves room for Meta to retry a request our endpoint failed to answer [U: Meta says nothing of its retries]; one stamped
// more than five minutes ahead of our clock is refused too.
export const SIGNED_REQUEST_MAX_AGE_SECONDS = 24 * 3600;
export const SIGNED_REQUEST_MAX_AHEAD_SECONDS = 300;

// The Meta user id inside a signed request, or null when it is not one: two base64url parts, the first the HMAC-SHA256 of the
// second as sent (the encoded text) under the app secret, compared in constant time, and a payload that names that algorithm,
// is not expired, and carries an app-scoped user id (digits).
export function verifySignedRequest(signedRequest: string, appSecret: string, now: number = Date.now()): string | null {
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [encodedSignature, encodedPayload] = parts as [string, string];
  const signature = base64urlDecode(encodedSignature);
  if (!signature || !encodedPayload || !base64urlDecode(encodedPayload)) return null;
  const expected = createHmac('sha256', appSecret).update(encodedPayload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse((base64urlDecode(encodedPayload) as Buffer).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { algorithm, user_id: userId, issued_at: issuedAt } = payload as { algorithm?: unknown; user_id?: unknown; issued_at?: unknown };
  if (typeof algorithm !== 'string' || algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
  // No stamp, or a stamp outside the window: not a request to act on, whoever signed it.
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  const age = now / 1000 - issuedAt;
  if (age > SIGNED_REQUEST_MAX_AGE_SECONDS || age < -SIGNED_REQUEST_MAX_AHEAD_SECONDS) return null;
  return typeof userId === 'string' && /^\d{1,32}$/.test(userId) ? userId : null;
}

export type AdsDeletionOutcome = { status: 200; code: string } | { status: 400; code: 'DELETION_MALFORMED' } | { status: 401; code: 'DELETION_SIGNATURE' } | { status: 503; code: 'DELETION_BACKLOG' };

export async function acceptAdsDeletion(runtime: Runtime, appSecret: string, body: string, now: number = Date.now()): Promise<AdsDeletionOutcome> {
  const signed = new URLSearchParams(body).get('signed_request');
  if (!signed) return { status: 400, code: 'DELETION_MALFORMED' };
  const userId = verifySignedRequest(signed, appSecret, now);
  if (userId === null) return { status: 401, code: 'DELETION_SIGNATURE' };
  try {
    // A person with a request still open (a replay of this one, or a second one) gets that request's code, not a new row.
    const code = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ code: string }>`
        SELECT crove_ads.deletion_request_enqueue(${randomBytes(16).toString('hex')}, ${platformUserHash(appSecret, userId)}) AS code`.execute(db);
      return rows[0]?.code ?? null;
    });
    if (!code) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    return { status: 200, code };
  } catch (error) {
    // The API login is not trusted with volume: past the table's limit the definer raises configuration_limit_exceeded, which
    // the runtime reports as OVERLOADED; Meta tries again later.
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'DELETION_BACKLOG' };
    throw error;
  }
}

export interface AdsDeletionStatus {
  requestedAt: Date;
  completedAt: Date | null;
  accounts: number | null;
}

// What the status page shows for a confirmation code, or null for a code nobody was given.
export async function adsDeletionStatus(runtime: Runtime, code: string): Promise<AdsDeletionStatus | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ requested_at: Date; completed_at: Date | null; accounts: number | null }>`
      SELECT requested_at, completed_at, accounts FROM crove_ads.deletion_request_status(${code})`.execute(db);
    const row = rows[0];
    return row ? { requestedAt: row.requested_at, completedAt: row.completed_at, accounts: row.accounts } : null;
  });
}

// The relay's claim of open requests (crove_ads.deletion_request_claim, the worker login's alone): one row per ad account a
// request names, and one row of nulls for a request that names none.
export async function claimAdsDeletions(workerDb: Db): Promise<Array<{ code: string; orgId: string | null; adAccountId: string | null; connectionId: string | null }>> {
  const { rows } = await sql<{ code: string; org_id: string | null; ad_account_id: string | null; connection_id: string | null }>`
    SELECT code, org_id, ad_account_id, connection_id FROM crove_ads.deletion_request_claim(${ADS_DELETION_CLAIM}::int)`.execute(workerDb);
  return rows.map((r) => ({ code: r.code, orgId: r.org_id, adAccountId: r.ad_account_id, connectionId: r.connection_id }));
}

const SYSTEM = { type: 'system' as const, component: 'ads' };

// One relay pass: for each open request that is due, closes the connection of every ad account its hash names (as a platform's
// deletion closes it: the credential is forgotten) and erases the account's figures, sync log and row, each in the account's
// own org, then marks the request completed. A request that names no account (none was ever linked with this person's grant,
// or its accounts were deleted already) is completed with none. Every step is idempotent, so a pass that dies half way is run
// again whole. A request that fails is put off for five minutes in the database (crove_ads.deletion_request_defer), so it
// holds nothing behind it and no restart forgets it. Returns how many requests it completed.
export async function runAdsDeletions(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const claimed = await claimAdsDeletions(deps.workerDb);
  const byCode = new Map<string, Array<{ orgId: string; adAccountId: string; connectionId: string }>>();
  for (const row of claimed) {
    const accounts = byCode.get(row.code) ?? [];
    if (row.orgId && row.adAccountId && row.connectionId) accounts.push({ orgId: row.orgId, adAccountId: row.adAccountId, connectionId: row.connectionId });
    byCode.set(row.code, accounts);
  }
  let completed = 0;
  for (const [code, accounts] of byCode) {
    try {
      for (const account of accounts) {
        const options = { actor: SYSTEM, orgId: account.orgId };
        await deps.runtime.execute('kernel.channel.revoke_by_platform', { connectionId: account.connectionId }, options);
        await deps.runtime.execute('ads.account.erase', { adAccountId: account.adAccountId }, options);
      }
      await sql`SELECT crove_ads.deletion_request_complete(${code}, ${accounts.length}::int)`.execute(deps.workerDb);
      completed++;
    } catch (error) {
      // By code only: nothing of the request or the accounts goes to the log.
      console.error(`[ads-deletion] request ${code.slice(0, 8)} not completed`, error instanceof Error ? error.name : 'error');
      await sql`SELECT crove_ads.deletion_request_defer(${code})`.execute(deps.workerDb).catch(() => undefined);
    }
  }
  return completed;
}
