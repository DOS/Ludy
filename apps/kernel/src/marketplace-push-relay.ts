// SPDX-License-Identifier: AGPL-3.0-only
// The worker's half of a marketplace push (#4327, S3a of #4315; the table and its definers are S1, #4316): claim the raw pushes the route stored (the claim DELETES them as it hands them out), open each connection's sealed
// secret once for the batch, have marketplace-push.ts verify each, and tell the worker which connections get ONE coalesced poll. The body lives in this process's memory for one HMAC check and is not kept past the verdict:
// it is not logged, not put in an error, not passed to the poll job (which carries ids only), and not returned. A refused push is counted on its hook after the batch commits (see rejectMarketplaceHook): ten in an hour
// stop the hook until it is rotated.
import { sql, type Transaction } from 'kysely';
import type { Database, Db } from '@ludy/db';
import type { CredentialBroker, Runtime } from '@ludy/kernel-runtime';
import { verifyMarketplacePush, type MarketplacePushVerdict } from './marketplace-push.ts';

// The relay claims this many pushes at a time.
export const MARKETPLACE_HOOK_CLAIM = 100;
// Pushes of one connection inside this many seconds share one poll (the singleton slot of the poll job).
export const MARKETPLACE_PUSH_SLOT_SECONDS = 30;

export interface MarketplaceHookNoticeRow {
  orgId: string;
  hookId: string;
  generation: number;
  marketplaceConnectionId: string;
  channelConnectionId: string;
  adapter: string;
  platform: string;
  authorization: string;
  body: Uint8Array;
  requestUrl: string | null;
}

// The claim (ludy_finance.marketplace_hook_claim, the worker login's alone). The rows are deleted as they are claimed, and anything older than ten minutes is swept first.
export async function claimMarketplaceHookNotices(trx: Transaction<Database>): Promise<MarketplaceHookNoticeRow[]> {
  const { rows } = await sql<{
    org_id: string;
    hook_id: string;
    generation: number;
    marketplace_connection_id: string;
    channel_connection_id: string;
    adapter: string;
    platform: string;
    authorization_header: string;
    body: Buffer;
    request_url: string | null;
  }>`SELECT org_id, hook_id, generation, marketplace_connection_id, channel_connection_id, adapter, platform, authorization_header, body, request_url FROM ludy_finance.marketplace_hook_claim(${MARKETPLACE_HOOK_CLAIM}::int)`.execute(trx);
  return rows.map((r) => ({
    orgId: r.org_id,
    hookId: r.hook_id,
    generation: Number(r.generation),
    marketplaceConnectionId: r.marketplace_connection_id,
    channelConnectionId: r.channel_connection_id,
    adapter: r.adapter,
    platform: r.platform,
    authorization: r.authorization_header,
    body: r.body,
    requestUrl: r.request_url,
  }));
}

// The sweep of pushes older than ten minutes (ludy_finance.marketplace_hook_sweep), for a worker that was away: how many went.
export async function sweepMarketplaceHookNotices(workerDb: Db): Promise<number> {
  const { rows } = await sql<{ swept: number }>`SELECT ludy_finance.marketplace_hook_sweep() AS swept`.execute(workerDb);
  return Number(rows[0]?.swept ?? 0);
}

// Counts a refused push on its hook when the hook's generation still matches what the claim saw; true when the hook is now stopped (ten within an hour). Called AFTER the claim's transaction has committed, never inside
// it: the claim holds the deleted pushes' row locks, and an API retry that holds the hook's lock would otherwise wait on the claim while the claim waits on the hook.
export async function rejectMarketplaceHook(db: Db | Transaction<Database>, hookId: string, generation: number): Promise<boolean> {
  const { rows } = await sql<{ stopped: boolean }>`SELECT ludy_finance.marketplace_hook_reject(${hookId}::uuid, ${generation}::int) AS stopped`.execute(db);
  return rows[0]?.stopped === true;
}

export interface MarketplaceHookDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The adapters this deployment runs (a push for another is dropped).
  adapters: ReadonlySet<string>;
  reject: (hookId: string, generation: number) => Promise<unknown>;
  now?: () => number;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace' };

// One verdict for each claimed push, in order. A connection's secret is opened once for the batch. Nothing is logged here: the worker prints the counts.
export async function verifyMarketplaceHookNotices(deps: MarketplaceHookDeps, rows: readonly MarketplaceHookNoticeRow[]): Promise<MarketplacePushVerdict[]> {
  const secrets = new Map<string, string | null>();
  const secretOf = async (row: MarketplaceHookNoticeRow): Promise<string | null> => {
    const key = `${row.orgId}:${row.channelConnectionId}`;
    if (secrets.has(key)) return secrets.get(key) as string | null;
    let secret: string | null = null;
    try {
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: row.channelConnectionId }, { actor: SYSTEM, orgId: row.orgId });
      secret = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
    } catch {
      // A connection whose owner left or that is no longer active, whose key was retired or whose envelope cannot be opened has no secret to check with. That is the connection's own state, not the batch's: its pushes are
      // dropped (a push is only a hint, the periodic poll makes it up), so one broken credential never holds back the other orgs' pushes in the shared claim.
    }
    secrets.set(key, secret);
    return secret;
  };
  const verdicts: MarketplacePushVerdict[] = [];
  for (const row of rows) {
    if (!deps.adapters.has(row.adapter)) {
      verdicts.push('dropped');
      continue;
    }
    const secret = await secretOf(row);
    if (secret === null) {
      verdicts.push('dropped');
      continue;
    }
    let verdict: MarketplacePushVerdict;
    try {
      verdict = verifyMarketplacePush(row.adapter, secret, { authorization: row.authorization, body: row.body, requestUrl: row.requestUrl }, deps.now?.());
    } catch {
      verdict = 'dropped';
    }
    if (verdict === 'refused') await deps.reject(row.hookId, row.generation);
    verdicts.push(verdict);
  }
  return verdicts;
}
