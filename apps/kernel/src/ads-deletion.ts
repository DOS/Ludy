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
import type { Runtime } from '@crove/kernel-runtime';

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
  const code = randomBytes(16).toString('hex');
  try {
    await runtime.orgless(async (db) => {
      await sql`SELECT crove_ads.deletion_request_enqueue(${code}, ${platformUserHash(appSecret, userId)})`.execute(db);
    });
  } catch (error) {
    // The API login is not trusted with volume: past the backlog limit the definer raises configuration_limit_exceeded.
    const sqlState = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (sqlState === '53400') return { status: 503, code: 'DELETION_BACKLOG' };
    throw error;
  }
  return { status: 200, code };
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
// A request whose erasure failed is tried again this long after, in this process: the relay passes every second.
const RETRY_AFTER_MS = 5 * 60_000;
const failedUntil = new Map<string, number>();

// One relay pass: for each open request, closes the connection of every ad account its hash names (as a platform's deletion
// closes it: the credential is forgotten) and erases the account's figures, sync log and row, each in the account's own org,
// then marks the request completed. A request that names no account (none was ever linked with this person's grant, or its
// accounts were deleted already) is completed with none. Every step is idempotent, so a pass that dies half way is run again
// whole. Returns how many requests it completed.
export async function runAdsDeletions(deps: { runtime: Runtime; workerDb: Db; now?: () => number }): Promise<number> {
  const now = deps.now ?? Date.now;
  const claimed = await claimAdsDeletions(deps.workerDb);
  const byCode = new Map<string, Array<{ orgId: string; adAccountId: string; connectionId: string }>>();
  for (const row of claimed) {
    const accounts = byCode.get(row.code) ?? [];
    if (row.orgId && row.adAccountId && row.connectionId) accounts.push({ orgId: row.orgId, adAccountId: row.adAccountId, connectionId: row.connectionId });
    byCode.set(row.code, accounts);
  }
  let completed = 0;
  for (const [code, accounts] of byCode) {
    if ((failedUntil.get(code) ?? 0) > now()) continue;
    try {
      for (const account of accounts) {
        const options = { actor: SYSTEM, orgId: account.orgId };
        await deps.runtime.execute('kernel.channel.revoke_by_platform', { connectionId: account.connectionId }, options);
        await deps.runtime.execute('ads.account.erase', { adAccountId: account.adAccountId }, options);
      }
      await sql`SELECT crove_ads.deletion_request_complete(${code}, ${accounts.length}::int)`.execute(deps.workerDb);
      failedUntil.delete(code);
      completed++;
    } catch (error) {
      failedUntil.set(code, now() + RETRY_AFTER_MS);
      // By code only: nothing of the request or the accounts goes to the log.
      console.error(`[ads-deletion] request ${code.slice(0, 8)} not completed`, error instanceof Error ? error.name : 'error');
    }
  }
  return completed;
}

// The status page's words, in Vietnamese and English (the person is a Meta user, in any language the app speaks).
export function renderAdsDeletionStatus(status: AdsDeletionStatus | null): string {
  const text = !status
    ? { vi: 'Không tìm thấy yêu cầu xóa dữ liệu này.', en: 'No such data deletion request was found.' }
    : status.completedAt
      ? status.accounts && status.accounts > 0
        ? { vi: 'Dữ liệu quảng cáo của các tài khoản bạn đã cấp quyền cho Ludy đã được xóa.', en: 'The ad data of the accounts you granted to Ludy has been deleted.' }
        : { vi: 'Yêu cầu đã được xử lý: Ludy không giữ dữ liệu quảng cáo nào của bạn.', en: 'The request has been handled: Ludy holds no ad data of yours.' }
      : { vi: 'Yêu cầu đã được nhận và đang được xử lý, thường trong vòng một giờ.', en: 'The request was received and is being handled, usually within the hour.' };
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Ludy</title></head><body><p>${text.vi}</p><p lang="en">${text.en}</p></body></html>`;
}
