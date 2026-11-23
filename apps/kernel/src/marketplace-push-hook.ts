// SPDX-License-Identifier: AGPL-3.0-only
// The API's half of a marketplace push (TikTok Shop, Shopee, Lazada; #4346, S2 of the push receiver #4315). The platform signs a push with the seller's OWN app secret, which only the worker can open (ADR-0025), so this
// side checks no signature: it finds the hook by the SHA-256 of the key in the address, and keeps the RAW push for the worker (ludy_finance.marketplace_hook_put_notice, #4324), whose relay verifies it (#4344).
//   In order (http.ts runs the first two): the per-address limit, the 16 KB body cap; then here the shape of the key, the lookup of its hash (the org and the connection come from OUR row for that hash, never from
//   the body; an unknown or retired key is a 404 and nothing is stored), a stopped hook, a budget per hook, and the put of the bytes, the `Authorization` header as sent and the dedupe key.
// What the platform is answered: an EMPTY 2xx for a push that is stored or deliberately not (a duplicate, a stopped hook, a full backlog, a hook over its budget): Shopee asks for an empty 2xx and disables a subscription
// below 30% success over 600 pushes in six hours, so nothing here is ever a 429; a push is only a hint to poll, and what a drop would have told the worker the periodic poll makes up (decision 1 of #4315). A 404 is for
// a key or an adapter that is not ours. Nothing of the key, the header, the body or a secret is logged or answered.
// Shopee signs the address it called, so the address is stored with its push: it is built from the CONFIGURED public URL and the path, never from `Host` or `X-Forwarded-*` (which a proxy or a client can set), and only for
// Shopee (the definer stores NULL for any other adapter).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { MARKETPLACE_HOOK_KEY_LENGTH, marketplaceHookAddress } from '@ludy/kernel-contract';
import type { Runtime } from '@ludy/kernel-runtime';

// The most a push's body may be: a push is a few hundred bytes, so a larger one is not a platform's.
export const MAX_MARKETPLACE_PUSH_BYTES = 16 * 1024;
// Pushes one hook takes a minute; more are answered with an empty 2xx and dropped (a burst of orders is coalesced into one poll anyway).
export const MARKETPLACE_PUSHES_PER_MINUTE = 300;
// Pushes one client address sends a minute across all hooks (the platforms push from a few addresses): more are answered with an empty 2xx and dropped, never a 429.
export const MARKETPLACE_PUSH_ADDRESS_PER_MINUTE = 1200;
const HOOK_KEY = new RegExp(`^[A-Za-z0-9_-]{${MARKETPLACE_HOOK_KEY_LENGTH}}$`);
// A key of the wrong shape cannot be one of ours: the route answers 404 before it reads a body, and nothing is looked up for it.
export const isMarketplaceHookKey = (key: string): boolean => HOOK_KEY.test(key);
const hasControlCharacter = (text: string): boolean => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const ADAPTER = /^[a-z][a-z0-9_]{0,31}$/;

export const marketplaceHookKeyHash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

// The dedupe key of a push: the SHA-256 of the header, a newline (a header holds none) and the bytes, so a platform's retry of the same push is acknowledged and waits only once.
export function marketplacePushDedupeKey(authorization: string, body: Uint8Array): string {
  return createHash('sha256').update(authorization, 'utf8').update('\n', 'utf8').update(body).digest('hex');
}

// What the platform is answered. 200 carries an EMPTY body; 404 a bare not found; 500 a fixed code (the platform retries).
export type MarketplacePushOutcome = { status: 200 } | { status: 404 };

export interface MarketplacePushRequest {
  key: string;
  // The `Authorization` header as sent.
  authorization: string | undefined;
  // The raw body, as received.
  body: Uint8Array;
}

export interface MarketplacePushBudget {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export async function acceptMarketplacePush(
  runtime: Runtime,
  adapter: string,
  request: MarketplacePushRequest,
  budget: MarketplacePushBudget,
  publicUrl: string,
): Promise<MarketplacePushOutcome> {
  // A key or an adapter of the wrong shape cannot be one of ours: nothing is looked up for it.
  if (!ADAPTER.test(adapter) || !isMarketplaceHookKey(request.key)) return { status: 404 };
  const authorization = request.authorization;
  // No header, an over long or odd one, an empty body: not a platform's push (the put would refuse it too). Answered as stored and checked BEFORE the lookup, so such a request costs no database work and nothing here tells a
  // caller which part was wrong.
  if (typeof authorization !== 'string' || authorization.length < 1 || authorization.length > 256 || hasControlCharacter(authorization) || request.body.length < 1 || request.body.length > MAX_MARKETPLACE_PUSH_BYTES) {
    return { status: 200 };
  }
  const hash = marketplaceHookKeyHash(request.key);
  const hook = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ hook_id: string; standing: string }>`SELECT hook_id, standing FROM ludy_finance.marketplace_hook_lookup(${adapter}, ${hash})`.execute(db);
    const row = rows[0];
    return row ? { hookId: row.hook_id, standing: row.standing } : null;
  });
  if (!hook) return { status: 404 };
  // A hook stopped by refused pushes answers like a stored one, so the platform stops retrying; nothing is stored.
  if (hook.standing !== 'ok') return { status: 200 };
  // Over its budget the hook drops the push and still answers a success: a 429 would count against the platform's success rate.
  if (!budget.take(hook.hookId).allowed) return { status: 200 };
  const requestUrl = adapter === 'shopee' ? marketplaceHookAddress(publicUrl, adapter, request.key) : null;
  const dedupe = marketplacePushDedupeKey(authorization, request.body);
  const body = Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength);
  const put = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ put: string }>`
      SELECT ludy_finance.marketplace_hook_put_notice(${hook.hookId}::uuid, ${hash}, ${dedupe}, ${authorization}, ${body}, ${requestUrl}::text) AS put`.execute(db);
    return rows[0]?.put ?? 'gone';
  });
  // 'accepted', 'duplicate' and 'busy' (twenty waiting for the hook, or the machine's backlog full) are all an empty success; 'gone' (stopped, its key rotated since the lookup, its connection closed) is a retired key. A hook stopped in the moment between the lookup and the put is answered 404 as well (the put cannot tell a stop from a rotation): the window is a few statements wide and a push is only a hint.
  return put === 'gone' ? { status: 404 } : { status: 200 };
}
