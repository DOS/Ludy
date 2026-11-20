// SPDX-License-Identifier: AGPL-3.0-only
// The webhook of a bank feed whose provider signs its notices with each customer's OWN secret (Tingee; #4203, S3 of #2045; ADR-0039 as amended). Such a notice names no org and its signature can only be checked with
// the secret of the connection it belongs to, which only the worker can open. So each connection has an address of its own, `/api/bank-feed/<provider>/webhook/<hookKey>`: the key is 128 random bits of which only
// the SHA-256 is kept (crove_finance.bank_feed_hook), and the org and the connection come from OUR row for that hash, never from the body.
//   The API (acceptBankFeedHook): after the per-address limit and the body cap (http.ts, before this runs) it checks the headers and the timestamp window, looks the hash up, applies a budget per hook, and stores the RAW
//   notice for the worker (crove_finance.bank_feed_hook_put_notice): the request id, the provider's timestamp and signature as sent, the body. It checks no signature (it has no secret) and stores no transaction.
//   The worker (claimBankFeedHookNotices, verifyBankFeedHookNotices): claims the waiting notices, opens each connection's sealed secret, has the adapter verify the HMAC (constant-time) and that the body names the
//   connection's own client, and queues one coalesced pull for each connection with a good notice (apps/kernel/src/worker.ts). A refused one is counted on the hook; ten in an hour stop it until it is rotated.
// The notice's body is personal data (the transfer content and the payer's name): it is kept only until the worker verifies it (at most ten minutes whatever its state, deleted by the claim and the nightly sweep), and
// nothing here logs it, the signature, the hook key or the secret: a log line carries a count and a code.
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database, Db } from '@crove/db';
import type { BankFeedProvider } from '@crove/bank-feed';
import { BANK_FEED_HOOK_KEY_LENGTH } from '@crove/kernel-contract';
import type { CredentialBroker, Runtime } from '@crove/kernel-runtime';

// The most a notice's body may be: the provider's notices are a few hundred bytes (a transaction), so a larger one is not its.
export const MAX_BANK_FEED_HOOK_BYTES = 16 * 1024;
// Notices a single hook takes a minute; more are answered 429 and the provider retries (a provider retries a few times a minute apart).
export const BANK_FEED_HOOKS_PER_MINUTE = 60;
// The relay claims this many notices at a time.
export const BANK_FEED_HOOK_CLAIM = 100;

const HOOK_KEY = new RegExp(`^[A-Za-z0-9_-]{${BANK_FEED_HOOK_KEY_LENGTH}}$`);
const hasControlCharacter = (text: string): boolean => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

export const bankFeedHookKeyHash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

// What the provider answers to: 200 with its own success body for a notice that is stored or deliberately not (a duplicate, a stopped hook, a validation challenge); the codes below otherwise. An unknown key is a 404 and
// nothing is stored for it.
export type BankFeedHookOutcome =
  | { status: 200 }
  | { status: 400; code: 'WEBHOOK_MALFORMED' | 'WEBHOOK_STALE' }
  | { status: 404 }
  | { status: 429; retryAfterSeconds: number }
  | { status: 503; code: 'BANK_FEED_HOOK_BUSY' };

export interface BankFeedHookRequest {
  key: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface BankFeedHookBudget {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export async function acceptBankFeedHook(runtime: Runtime, provider: BankFeedProvider, request: BankFeedHookRequest, budget: BankFeedHookBudget, now: number = Date.now()): Promise<BankFeedHookOutcome> {
  if (!provider.hookTimestampFresh) throw new Error('the adapter takes no hook notices');
  // A key of the wrong shape cannot be one of ours: nothing is looked up for it.
  if (!HOOK_KEY.test(request.key)) return { status: 404 };
  const hash = bankFeedHookKeyHash(request.key);
  const lookup = async (): Promise<{ hookId: string; standing: string } | null> =>
    runtime.orgless(async (db) => {
      const { rows } = await sql<{ hook_id: string; standing: string }>`SELECT hook_id, standing FROM crove_finance.bank_feed_hook_lookup(${provider.id}, ${hash})`.execute(db);
      const row = rows[0];
      return row ? { hookId: row.hook_id, standing: row.standing } : null;
    });
  // The provider's check of an address, when a customer saves it in its portal: answered for a key we know, nothing stored.
  if ((request.headers['webhook-type'] ?? '').toLowerCase() === 'url-validation') {
    return (await lookup()) ? { status: 200 } : { status: 404 };
  }
  const requestId = request.headers['x-request-id'];
  const timestamp = request.headers['x-request-timestamp'];
  const signature = request.headers['x-signature'];
  const fine = (v: string | undefined, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !hasControlCharacter(v);
  if (!fine(requestId, 100) || !fine(timestamp, 40) || !fine(signature, 256) || request.body.length === 0 || request.body.includes('\u0000')) return { status: 400, code: 'WEBHOOK_MALFORMED' };
  if (!provider.hookTimestampFresh(timestamp, now)) return { status: 400, code: 'WEBHOOK_STALE' };
  const hook = await lookup();
  if (!hook) return { status: 404 };
  // A hook stopped by refused notices answers like a stored one, so the provider stops retrying; nothing is stored.
  if (hook.standing !== 'ok') return { status: 200 };
  const turn = budget.take(hook.hookId);
  if (!turn.allowed) return { status: 429, retryAfterSeconds: turn.retryAfterSeconds };
  const put = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ put: string }>`
      SELECT crove_finance.bank_feed_hook_put_notice(${hook.hookId}::uuid, ${requestId}, ${timestamp}, ${signature}, ${request.body}) AS put`.execute(db);
    return rows[0]?.put ?? 'gone';
  });
  if (put === 'accepted' || put === 'duplicate') return { status: 200 };
  if (put === 'busy') return { status: 503, code: 'BANK_FEED_HOOK_BUSY' };
  return { status: 404 };
}

export interface BankFeedHookNoticeRow {
  orgId: string;
  hookId: string;
  connectionId: string;
  provider: string;
  requestId: string;
  timestamp: string;
  signature: string;
  body: string;
}

// The relay's claim of waiting notices (crove_finance.bank_feed_hook_claim, the worker login's alone). The rows are deleted as they are claimed, and anything older than ten minutes is swept first.
export async function claimBankFeedHookNotices(trx: Transaction<Database>): Promise<BankFeedHookNoticeRow[]> {
  const { rows } = await sql<{ org_id: string; hook_id: string; connection_id: string; provider: string; request_id: string; notice_timestamp: string; signature: string; body: string }>`
    SELECT org_id, hook_id, connection_id, provider, request_id, notice_timestamp, signature, body FROM crove_finance.bank_feed_hook_claim(${BANK_FEED_HOOK_CLAIM}::int)`.execute(trx);
  return rows.map((r) => ({ orgId: r.org_id, hookId: r.hook_id, connectionId: r.connection_id, provider: r.provider, requestId: r.request_id, timestamp: r.notice_timestamp, signature: r.signature, body: r.body }));
}

// The nightly sweep of notices older than ten minutes (crove_finance.bank_feed_hook_sweep), for a worker that was away: how many went.
export async function sweepBankFeedHookNotices(workerDb: Db): Promise<number> {
  const { rows } = await sql<{ swept: number }>`SELECT crove_finance.bank_feed_hook_sweep() AS swept`.execute(workerDb);
  return Number(rows[0]?.swept ?? 0);
}

// Counts a refused notice on its hook; true when the hook is now stopped (ten within an hour). The worker calls it AFTER the claim's transaction has committed, never inside it: the claim holds the deleted notices'
// row locks, and an API retry of the same request id that holds the hook's lock would otherwise wait on the claim while the claim waits on the hook.
export async function rejectBankFeedHook(db: Db | Transaction<Database>, hookId: string): Promise<boolean> {
  const { rows } = await sql<{ stopped: boolean }>`SELECT crove_finance.bank_feed_hook_reject(${hookId}::uuid) AS stopped`.execute(db);
  return rows[0]?.stopped === true;
}

// What became of a claimed notice: `ok` (the signature and the client are the connection's: a pull is queued), `refused` (counted on the hook), `dropped` (nothing to do: the adapter or the credential is not there, the
// body is signed but not one the adapter reads, or the secret cannot be read).
export type BankFeedHookVerdict = 'ok' | 'refused' | 'dropped';

export interface BankFeedHookDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  providers: Readonly<Record<string, BankFeedProvider>>;
  reject: (hookId: string) => Promise<unknown>;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

const SYSTEM = { type: 'system' as const, component: 'finance.bank_feed' };

// One verdict for each claimed notice, in order. A connection's secret is opened once for the batch. Nothing is logged here: the worker prints the counts.
export async function verifyBankFeedHookNotices(deps: BankFeedHookDeps, rows: readonly BankFeedHookNoticeRow[]): Promise<BankFeedHookVerdict[]> {
  const secrets = new Map<string, string | null>();
  const secretOf = async (row: BankFeedHookNoticeRow): Promise<string | null> => {
    const key = `${row.orgId}:${row.connectionId}`;
    if (secrets.has(key)) return secrets.get(key) as string | null;
    let secret: string | null = null;
    try {
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: row.connectionId }, { actor: SYSTEM, orgId: row.orgId });
      secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
    } catch {
      // A connection whose owner left or that is no longer active, whose key was retired or whose sealed envelope cannot be opened has no secret to check with. That is the connection's own state, not the batch's:
      // its notices are dropped (a notice is only a hint, the daily pull makes it up) so one broken credential never holds back the other orgs' notices in the shared claim.
    }
    secrets.set(key, secret);
    return secret;
  };
  const verdicts: BankFeedHookVerdict[] = [];
  for (const row of rows) {
    const provider = Object.hasOwn(deps.providers, row.provider) ? (deps.providers[row.provider] as BankFeedProvider) : undefined;
    if (!provider?.verifyHook) {
      verdicts.push('dropped');
      continue;
    }
    const secret = await secretOf(row);
    if (secret === null) {
      verdicts.push('dropped');
      continue;
    }
    let verdict: ReturnType<NonNullable<BankFeedProvider['verifyHook']>>;
    try {
      verdict = provider.verifyHook(secret, { timestamp: row.timestamp, signature: row.signature, body: row.body });
    } catch {
      // A stored credential the adapter cannot read: not the notice's fault, so it is not counted against the hook.
      verdicts.push('dropped');
      continue;
    }
    if (verdict === 'ok') {
      verdicts.push('ok');
    } else if (verdict === 'malformed') {
      // Signed with the connection's own secret but not a notice the adapter reads: dropped, not counted.
      verdicts.push('dropped');
    } else {
      await deps.reject(row.hookId);
      verdicts.push('refused');
    }
  }
  return verdicts;
}
