// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core's worker side (issue #2303, plan docs/plan/conversations.md sections 6.1 and 7), run as the system.
//
// Intake. A platform's signed notice is parked by the public webhook (or, for the sandbox, by the API) in
// ludy_kernel.conversation_inbound_pending, which holds the body only until it is stored: the worker claims notices under a
// lease, parses each with its provider's parser, finds the connections the platform's own account id names (the org comes
// from the stored connection, never from the notice) and runs kernel.conversation.ingest for each, then deletes the notice.
// A body is personal data of a third party, so it is never logged, never put in a job and never kept past its storing; a
// notice that cannot be parsed or stored is dropped, with its provider and size logged, not its text.
//
// Sending. A reply or a hide is begun (the call row is committed as started), made with the credential the API sealed, and
// recorded. A reply is never repeated after an unclear answer (no platform send call has an idempotency key); a hide is
// idempotent, so its job may repeat it.
import { randomUUID } from 'node:crypto';
import {
  ConversationNoticeError,
  parseFacebookNotices,
  parseInstagramNotices,
  TELEGRAM_HOOK_KEY_INFO,
  parseSandboxNotice,
  parseWhatsAppNotices,
  parseTelegramChatNotice,
  parseThreadsNotices,
  parseZaloNotice,
  type ConversationAdapter,
  type ConversationNotice,
} from '@ludy/channel';
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { BlobConflictError, DomainError, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { AiBudgetExhaustedError, withAiScope, type AiMeter, type ConversationWriter, type ReplyDraftResult } from '@ludy/agent';
import type { AttachmentSource, DraftSource, HideWork, HistoryWork, ProfileWork, ReplyWork, TelegramChatWork, UsageLimits } from '@ludy/kernel';
import type { DraftBudget } from './ai-draft-limit.ts';
import { fetchConversationImage, fetchConversationMedia, mediaHostsOf, type FetchConversationImageOptions } from './conversation-media.ts';
import { opsAlert } from './ops-alert.ts';

const SYSTEM = { type: 'system' as const, component: 'conversations' };

// A notice is claimed for this long; a worker that dies holding it lets it go to the next claim.
export const CONVERSATION_LEASE_SECONDS = 120;
// The notices one pass claims at most.
export const CONVERSATION_CLAIM = 20;

// The providers whose notices the worker can read: each turns a verified notice into events. A provider with no parser here
// has its notices dropped.
type NoticeParser = (body: Uint8Array) => ConversationNotice | readonly ConversationNotice[];
export const NOTICE_PARSERS: Readonly<Record<string, NoticeParser>> = {
  sandbox: parseSandboxNotice,
  // Facebook Page comments (#2307): X-Hub-Signature-256 was checked by the route before the body was parked.
  facebook_page: parseFacebookNotices,
  // Instagram Business comments and direct messages (#2309): X-Hub-Signature-256 was checked by the route before the body was parked.
  instagram: parseInstagramNotices,
  // Zalo OA (#2304): its signature was checked by the route before the body was parked.
  zalo_oa: parseZaloNotice,
  // WhatsApp Business (#3131): X-Hub-Signature-256 was checked by the route before the body was parked.
  whatsapp: parseWhatsAppNotices,
  // Telegram bot chats (#3132): the hook and its secret were checked by the route before the update was parked; the notice's account id is the hook.
  telegram_chat: parseTelegramChatNotice,
  // Threads replies (#3133): X-Hub-Signature-256 was checked with the Threads app's secret by the route before the body was parked.
  threads: parseThreadsNotices,
};

// The intake providers whose notice names a connection's hook rather than a platform account (the hook is an opaque capability, never an org):
// the worker finds the connection by the hook.
const HOOK_PROVIDERS: ReadonlySet<string> = new Set(['telegram_chat']);

export interface ClaimedNotice {
  seq: string;
  provider: string;
  body: Buffer | null;
  attempts: number;
  dropped: boolean;
  // Why a notice was dropped: claimed five times without being finished, or waiting longer than seven days.
  reason: 'poison' | 'expired' | null;
}

export async function claimNotices(workerDb: Db): Promise<ClaimedNotice[]> {
  const { rows } = await sql<ClaimedNotice>`
    SELECT seq::text AS seq, provider, body, attempts, dropped, reason
    FROM ludy_kernel.conversation_inbound_claim(${CONVERSATION_CLAIM}::int, ${CONVERSATION_LEASE_SECONDS}::int)`.execute(workerDb);
  return rows;
}

const finishNotice = async (workerDb: Db, seq: string): Promise<void> => {
  await sql`SELECT ludy_kernel.conversation_inbound_done(${seq}::bigint)`.execute(workerDb);
};

async function connectionsFor(workerDb: Db, provider: string, accountId: string): Promise<Array<{ orgId: string; connectionId: string }>> {
  const { rows } = HOOK_PROVIDERS.has(provider)
    ? await sql<{ org_id: string; connection_id: string }>`SELECT org_id, connection_id FROM ludy_kernel.conversation_chat_hook_connections(${accountId})`.execute(workerDb)
    : await sql<{ org_id: string; connection_id: string }>`SELECT org_id, connection_id FROM ludy_kernel.conversation_connections_for(${provider}, ${accountId})`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id }));
}

export interface IntakeDeps {
  workerDb: Db;
  runtime: Runtime;
  // For the log only.
  log?: (message: string) => void;
  // Reading back a Telegram Business connection Ludy missed (#3224). Without it (no credential broker or no Telegram adapter in this deployment) an unknown
  // business connection stays ignored, as before.
  businessLookup?: BusinessLookup | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// A Telegram Business connection Ludy never recorded (#3224). The owner may add the chatbot in Telegram before turning chats on in Ludy; Telegram sent the
// `business_connection` update then, nobody was listening, and it is not sent again. A business message that names a connection the connection's list does not
// hold therefore asks Telegram once with `getBusinessConnection` (the adapter's call: api.telegram.org only, the sealed token opened here and used for that one
// call, never logged), and records an enabled answer exactly as the update would have: as an account nobody has allowed yet (the person's allowing is never
// skipped, and a message that came before it is not kept, plan 4.2 point 9). A disabled, unknown or failed answer records nothing. At most one lookup per
// connection and id in a window, and a few per connection in it, so a flood of messages (or of ids) is not a flood of calls to Telegram; a failure counts as the
// lookup, and one pass makes a few at most. The window is kept in this process: another worker process may ask once more, which is the same bounded cost.
// ---------------------------------------------------------------------------------------------------------------------

// How long an id that was looked up is not looked up again, and how many lookups one connection gets in that time.
export const BUSINESS_LOOKUP_WINDOW_MS = 10 * 60_000;
export const BUSINESS_LOOKUP_PER_CONNECTION = 10;
// The most lookups one intake pass makes: each can wait on the Bot API client's 15-second deadline, so a pass that finds Telegram hanging waits 45 seconds at most, well inside its notices' lease of 120. A notice past this is
// taken as an unknown connection (ignored); the next message of that id looks it up.
export const BUSINESS_LOOKUP_PER_PASS = 3;
const BUSINESS_LOOKUP_TRACKED = 2000;

export interface BusinessLookup {
  broker: CredentialBroker;
  adapter: (provider: string) => ConversationAdapter | undefined;
  now?: (() => number) | undefined;
  // The ids asked about and when (milliseconds), by `<connection>:<id>`: the window's memory.
  asked?: Map<string, number> | undefined;
}

// Whether a lookup may be made now, and if so, that it has been.
function takeBusinessLookup(deps: BusinessLookup, connectionId: string, id: string): boolean {
  const now = (deps.now ?? Date.now)();
  const asked = (deps.asked ??= new Map());
  for (const [key, at] of asked) {
    if (now - at < BUSINESS_LOOKUP_WINDOW_MS) break;
    asked.delete(key);
  }
  const key = `${connectionId}:${id}`;
  if (asked.has(key)) return false;
  let used = 0;
  for (const key2 of asked.keys()) if (key2.startsWith(`${connectionId}:`)) used++;
  if (used >= BUSINESS_LOOKUP_PER_CONNECTION) return false;
  if (asked.size >= BUSINESS_LOOKUP_TRACKED) asked.delete(asked.keys().next().value as string);
  asked.set(key, now);
  return true;
}

// Looks the connection up and records it. Returns what became of it, a short word for the log: nothing of Telegram's answer, the id or the token is in it.
async function readBackBusinessConnection(deps: IntakeDeps, lookup: BusinessLookup, budget: { left: number }, target: { orgId: string; connectionId: string }, id: string): Promise<string> {
  const options = { actor: SYSTEM, orgId: target.orgId };
  const known = await deps.runtime.query<{ lookup: boolean }>('kernel.channel.telegram_business_known', { connectionId: target.connectionId, id }, options);
  if (!known.lookup) return 'known';
  if (budget.left <= 0) return 'limited';
  if (!takeBusinessLookup(lookup, target.connectionId, id)) return 'limited';
  let opened: Opened;
  try {
    opened = await open({ runtime: deps.runtime, broker: lookup.broker }, target);
  } catch {
    return 'failed:CREDENTIAL_ERROR';
  }
  if (opened.kind === 'refused') return `failed:${opened.code}`;
  const adapter = lookup.adapter('telegram');
  if (!adapter?.businessConnection) return 'failed:NO_ADAPTER';
  budget.left--;
  let answer;
  try {
    answer = await adapter.businessConnection({ secret: opened.secret, businessConnectionId: id });
  } catch {
    return 'failed:ADAPTER_ERROR';
  }
  if (answer.kind === 'failed') return `failed:${answer.code}`;
  // A connection that is off stays ignored, as one Telegram reported off would.
  if (!answer.state.enabled) return 'disabled';
  // A `business_connection` update may have been recorded while Telegram was asked: it is newer than this answer, and the account is no longer unknown.
  const again = await deps.runtime.query<{ lookup: boolean }>('kernel.channel.telegram_business_known', { connectionId: target.connectionId, id }, options);
  if (!again.lookup) return 'known';
  const { userId, name, username, date, updateId, canReply, enabled } = answer.state;
  const recorded = await deps.runtime.execute<{ applied: boolean }>('kernel.channel.telegram_business_record', { connectionId: target.connectionId, account: { id: answer.state.id, userId, name: name ?? null, username: username ?? null, ...(date !== undefined ? { date } : {}), ...(updateId !== undefined ? { updateId } : {}), canReply, enabled } }, options);
  return recorded.applied ? 'recorded' : 'not_recorded';
}

// A refusal of the command itself (the events do not fit its shape, the connection went away) is the notice's own and will
// not change on a retry; anything else is the database or the runtime failing and is left to the lease.
const isPermanent = (error: unknown): boolean => error instanceof DomainError && error.status >= 400 && error.status < 500;

// One pass over the waiting notices: how many were stored, and how many dropped.
export async function runConversationIntake(deps: IntakeDeps): Promise<{ stored: number; dropped: number }> {
  const log = deps.log ?? ((message: string) => console.log(`[conversations] ${message}`));
  const out = { stored: 0, dropped: 0 };
  const lookups = { left: BUSINESS_LOOKUP_PER_PASS };
  // The notices the database dropped (poison or too old), by id: a body is personal data, so an alert names ids and counts only.
  const lost: ClaimedNotice[] = [];
  for (const notice of await claimNotices(deps.workerDb)) {
    if (notice.dropped || notice.body === null) {
      out.dropped++;
      lost.push(notice);
      log(`dropped notice ${notice.seq} (${notice.provider}, ${notice.reason ?? 'unknown'}) after ${notice.attempts} attempt(s)`);
      continue;
    }
    const parse = Object.hasOwn(NOTICE_PARSERS, notice.provider) ? NOTICE_PARSERS[notice.provider] : undefined;
    let parsedList: readonly ConversationNotice[] | null = null;
    try {
      const raw = parse ? parse(notice.body) : null;
      parsedList = raw === null ? null : Array.isArray(raw) ? raw : [raw as ConversationNotice];
    } catch (error) {
      if (!(error instanceof ConversationNoticeError)) throw error;
    }
    if (!parsedList) {
      // Not a notice we can read: nothing to retry, so nothing to keep.
      await finishNotice(deps.workerDb, notice.seq);
      out.dropped++;
      log(`dropped notice ${notice.seq} (${notice.provider}): unreadable, ${notice.body.byteLength} bytes`);
      continue;
    }
    // A notice that tells the connection's own state (Telegram Business: a business account connected or disconnected, #3191) counts as well as one with events.
    const nonEmpty = parsedList.filter((p) => p.events.length > 0 || p.businessState);
    // A notice with no event (Zalo's follow or seen, or a Facebook Page status/like event): nothing to store.
    if (nonEmpty.length === 0) {
      await finishNotice(deps.workerDb, notice.seq);
      continue;
    }
    let failed = false;
    for (const parsed of nonEmpty) {
      const targets = (await connectionsFor(deps.workerDb, notice.provider, parsed.accountId)).filter((t) => !parsed.connectionId || t.connectionId === parsed.connectionId);
      // Fail closed if a hook lookup ever matches more than one connection across orgs or rows (#3150 item 4): never park into either org.
      if (HOOK_PROVIDERS.has(notice.provider) && targets.length > 1) {
        log(`dropped notice ${notice.seq} (${notice.provider}): refused ambiguous hook match (${targets.length} connections)`);
        out.dropped++;
        continue;
      }
      // No active connection holds this account (expired, revoked, offboarding, or none): the platforms keep no history to pull, so the
      // notice is gone; the count says so.
      if (targets.length === 0) log(`notice ${notice.seq} (${notice.provider}) names no active connection: dropped after storing nothing`);
      for (const target of targets) {
        try {
          if (parsed.businessState) {
            const { id, userId, name, username, date, updateId, canReply, enabled } = parsed.businessState;
            await deps.runtime.execute('kernel.channel.telegram_business_record', { connectionId: target.connectionId, account: { id, userId, name: name ?? null, username: username ?? null, ...(date !== undefined ? { date } : {}), ...(updateId !== undefined ? { updateId } : {}), canReply, enabled } }, { actor: SYSTEM, orgId: target.orgId });
          }
          if (parsed.events.length === 0) continue;
          if (parsed.businessConnectionId && !parsed.businessState && deps.businessLookup && notice.provider === 'telegram_chat') {
            const outcome = await readBackBusinessConnection(deps, deps.businessLookup, lookups, target, parsed.businessConnectionId);
            if (outcome !== 'known' && outcome !== 'limited') log(`a telegram business connection read back: ${outcome}`);
          }
          const done = await deps.runtime.execute<{ stored: number }>(
            'kernel.conversation.ingest',
            { connectionId: target.connectionId, events: parsed.events, ...(parsed.businessConnectionId ? { businessConnectionId: parsed.businessConnectionId } : {}) },
            { actor: SYSTEM, orgId: target.orgId },
          );
          out.stored += done.stored;
        } catch (error) {
          // The notice's own fault is logged by its code only; a transient one leaves the notice to its lease.
          if (isPermanent(error)) log(`a ${notice.provider} notice was refused by ingest (${(error as DomainError).code})`);
          else failed = true;
        }
      }
    }
    if (!failed) await finishNotice(deps.workerDb, notice.seq);
  }
  if (lost.length > 0) {
    const expired = lost.filter((n) => n.reason === 'expired').length;
    opsAlert(`[conversations] ALERT ${lost.length} waiting notice(s) dropped (${expired} older than 7 days, ${lost.length - expired} that failed 5 times): ${lost.slice(0, 20).map((n) => n.seq).join(', ')}${lost.length > 20 ? ', ...' : ''}`);
  }
  return out;
}

// The sends a worker began more than ten minutes ago and never recorded (it died, or the answer was lost): reply_begin settles each as
// unclear for a person. At most once a minute, and a few at a time.
const STALE_SWEEP_MS = 60_000;
let lastStaleSweep = 0;
export async function sweepStaleReplies(deps: { workerDb: Db; runtime: Runtime; now?: () => number }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (now - lastStaleSweep < STALE_SWEEP_MS) return 0;
  lastStaleSweep = now;
  const { rows } = await sql<{ org_id: string; message_id: string }>`SELECT org_id, message_id FROM ludy_kernel.conversation_stale_sends(50::int)`.execute(deps.workerDb);
  for (const row of rows) {
    await deps.runtime.execute('kernel.conversation.reply_begin', { messageId: row.message_id }, { actor: SYSTEM, orgId: row.org_id });
  }
  return rows.length;
}

// A reply or a hide queued where this worker has no channel to send it through (no publisher or no credential broker): the call is
// begun and recorded as refused, so the message shows as failed, a person may send it again once the deployment has the channel,
// and nothing stays queued with no job. Nothing was sent.
export async function failUnsendable(runtime: Runtime, job: ConversationJob): Promise<void> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const result = { kind: 'rejected', error: 'bad_request', code: 'CHANNEL_NOT_CONFIGURED' };
  if (job.action === 'hide') {
    const work = await runtime.execute<{ action: string; callKey?: string }>('kernel.conversation.hide_begin', { messageId: job.messageId }, options);
    if (work.action === 'call' && work.callKey) await runtime.execute('kernel.conversation.hide_record', { messageId: job.messageId, callKey: work.callKey, result }, options);
    return;
  }
  const work = await runtime.execute<{ action: string; callKey?: string }>('kernel.conversation.reply_begin', { messageId: job.messageId }, options);
  if (work.action === 'call' && work.callKey) await runtime.execute('kernel.conversation.reply_record', { messageId: job.messageId, callKey: work.callKey, result }, options);
}

// ---------------------------------------------------------------------------------------------------------------------
// Telegram bot chats on and off (#3132). The webhook is set (or deleted) by a job on this queue, ids only in its data: the worker alone opens
// the bot token. The hook that makes the webhook's address, and the secret derived from it, are built here from the stored hook and the
// deployment's key, used for the one call and never logged, stored or returned.
// ---------------------------------------------------------------------------------------------------------------------

// `on`: the webhook is to be set (true) or deleted (false). One action value, so the job is a member of the queue's union that a check narrows away.
export type ConversationChatJob = { orgId: string; connectionId: string; action: 'chat'; on: boolean };

export interface ChatHookDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The provider's adapter (Telegram's), which makes the platform call.
  adapter: (provider: string) => ConversationAdapter | undefined;
  // The API's public origin (PUBLIC_URL, where webhooks are answered): the webhook is `<baseUrl>/api/channels/telegram/webhook/<hook>`. Telegram only takes https.
  baseUrl: string;
  // Worker DB connection for checking whether another org previously held the same Telegram bot's webhook (#3150 item 2).
  workerDb?: Db;
}

const currentKeyOfBroker = (broker: CredentialBroker): string | undefined => {
  const id = (broker as { keyId?: unknown }).keyId;
  return typeof id === 'string' && id ? id : undefined;
};

const BOT_LOCK_TTL_SECONDS = 60;
const BOT_LOCK_WAIT_MS = 20_000;
const REKEY_SWEEP_TTL_SECONDS = 120;

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const botLockKeyOfId = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  return `bot:${/^[a-z0-9._-]{1,80}$/i.test(raw) ? raw.toLowerCase() : sha256Hex(raw).slice(0, 32)}`;
};

const validBotId = (raw: string | null | undefined): string | null => (raw && /^[0-9]{3,20}$/.test(raw) ? raw : null);

async function tryAcquireWebhookLock(workerDb: Db, lockKey: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
  const { rows } = await sql<{ locked: boolean }>`
    SELECT ludy_kernel.telegram_webhook_lock_acquire(${lockKey}, ${ownerId}::uuid, ${ttlSeconds}::int) AS locked`.execute(workerDb);
  return rows[0]?.locked === true;
}

async function releaseWebhookLock(workerDb: Db, lockKey: string, ownerId: string): Promise<void> {
  await sql`SELECT ludy_kernel.telegram_webhook_lock_release(${lockKey}, ${ownerId}::uuid)`.execute(workerDb);
}

async function tryWithBotWebhookLock<T>(workerDb: Db, lockKey: string, waitMs: number, fn: (renew: () => Promise<boolean>) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const ownerId = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const acquired = await tryAcquireWebhookLock(workerDb, lockKey, ownerId, BOT_LOCK_TTL_SECONDS);
    if (acquired) break;
    if (Date.now() >= deadline) return { acquired: false };
    await sleepMs(40 + Math.floor(Math.random() * 60));
  }
  try {
    return { acquired: true, value: await fn(() => tryAcquireWebhookLock(workerDb, lockKey, ownerId, BOT_LOCK_TTL_SECONDS)) };
  } finally {
    await releaseWebhookLock(workerDb, lockKey, ownerId).catch(() => undefined);
  }
}

async function withBotWebhookLock<T>(workerDb: Db, lockKey: string, fn: (renew: () => Promise<boolean>) => Promise<T>): Promise<T> {
  const res = await tryWithBotWebhookLock(workerDb, lockKey, BOT_LOCK_WAIT_MS, fn);
  if (!res.acquired) throw new Error('TELEGRAM_BOT_LOCK_BUSY');
  return res.value;
}

// When one org registers Telegram's webhook for a bot token, Telegram replaces any webhook another org had set for the
// same bot. Mark those other orgs' connections off and notify their admins via SYSTEM without revealing which org took it (#3150 item 2).
async function displaceOtherTelegramOrgs(
  runtime: Runtime,
  workerDb: Db | undefined,
  excludeOrgId: string,
  botId: string | null | undefined,
  takenAt: string | null,
  renewLock?: () => Promise<boolean>,
): Promise<boolean> {
  if (!workerDb || !botId) return false;
  const { rows } = await sql<{ org_id: string; connection_id: string }>`
    SELECT org_id, connection_id FROM ludy_kernel.telegram_chat_other_orgs_with_bot(${botId}, ${excludeOrgId}::uuid)`.execute(workerDb);
  let ok = true;
  for (const [index, other] of rows.entries()) {
    if (renewLock && index > 0 && index % 5 === 0) {
      const held = await renewLock().catch(() => false);
      if (!held) return false;
    }
    try {
      await runtime.execute(
        'kernel.channel.telegram_chat_displaced',
        { connectionId: other.connection_id, botId, ...(takenAt ? { takenAt } : {}) },
        { actor: SYSTEM, orgId: other.org_id },
      );
    } catch (error) {
      ok = false;
      console.error(`[conversations] displace ${other.connection_id.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
    }
  }
  return ok;
}

async function displaceAndAck(
  runtime: Runtime,
  workerDb: Db | undefined,
  orgId: string,
  connectionId: string,
  botId: string | null | undefined,
  checkedAt: string | null,
  renewLock?: () => Promise<boolean>,
): Promise<void> {
  if (!workerDb || !botId) return;
  const done = await displaceOtherTelegramOrgs(runtime, workerDb, orgId, botId, checkedAt, renewLock).catch((error: unknown) => {
    console.error(`[conversations] displace scan ${connectionId.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
    return false;
  });
  if (!done) return;
  await runtime
    .execute(
      'kernel.channel.telegram_chat_displaced_ack',
      { connectionId, botId, ...(checkedAt ? { checkedAt } : {}) },
      { actor: SYSTEM, orgId },
    )
    .catch((error: unknown) => {
      console.error(`[conversations] displace ack ${connectionId.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
    });
}

const DISPLACE_SWEEP_MS = 10_000;
let lastDisplaceSweep = 0;

// Reconciles pending cross-org bot displacements independently of setWebhook so transient displacement errors recover (#3150 item 2).
export async function reconcileTelegramDisplacements(deps: { workerDb: Db; runtime: Runtime; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastDisplaceSweep < DISPLACE_SWEEP_MS) return 0;
  lastDisplaceSweep = now;
  const { rows } = await sql<{ org_id: string; connection_id: string; chat_bot_id: string; chat_changed_at: Date | null }>`
    SELECT org_id, connection_id, chat_bot_id, chat_changed_at FROM ludy_kernel.telegram_chat_displace_due(100::int)`.execute(deps.workerDb);
  let checked = 0;
  for (const row of rows) {
    const lockKey = botLockKeyOfId(row.chat_bot_id);
    if (!lockKey) continue;
    await tryWithBotWebhookLock(deps.workerDb, lockKey, 0, async (renew) => {
      const work = await deps.runtime.query<TelegramChatWork>(
        'kernel.channel.telegram_chat_work',
        { connectionId: row.connection_id, action: 'enable', rekey: true },
        { actor: SYSTEM, orgId: row.org_id },
      );
      if (work.action !== 'call') return;
      await displaceAndAck(deps.runtime, deps.workerDb, row.org_id, row.connection_id, row.chat_bot_id, row.chat_changed_at?.toISOString() ?? null, renew);
      checked += 1;
    }).catch((error: unknown) => {
      console.error(`[conversations] reconcile displace ${row.connection_id.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
    });
  }
  return checked;
}

// Sets or deletes the connection's webhook and records the outcome. The returned text is for the log: a state or a code, nothing a platform
// said and nothing of the hook. The adapter builds the address and the secret from the hook and the deployment's key and never returns them.
// Per-bot DB leases serialize concurrent enable, disable, and rekey calls on the same bot, re-reading state under the lock before Telegram is asked.
export async function runTelegramChatHook(deps: ChatHookDeps, job: ConversationChatJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const action = job.on ? ('enable' as const) : ('disable' as const);
  let usedHookFp: string | undefined;
  let last = 'none';
  for (let round = 0; round < 4; round++) {
    const preWork = await deps.runtime.query<TelegramChatWork>('kernel.channel.telegram_chat_work', { connectionId: job.connectionId, action, ...(usedHookFp ? { usedHookFp } : {}) }, options);
    if (preWork.action !== 'call' || (job.on && !preWork.hook)) return last;
    const record = (workFp: string | undefined, outcome: 'done' | 'failed', extra: { botId?: string; code?: string; hookKeyId?: string } = {}) =>
      deps.runtime.execute<{ applied: boolean; hookChanged: boolean; chatState: string | null; changedAt: string | null }>(
        'kernel.channel.telegram_chat_record',
        { connectionId: job.connectionId, action, outcome, ...(workFp ? { hookFp: workFp } : {}), ...extra },
        options,
      );
    const failed = async (workFp: string | undefined, code: string): Promise<{ text: string; again: boolean }> => {
      const recorded = await record(workFp, 'failed', { code });
      return { text: `failed:${code}`, again: recorded.hookChanged };
    };
    const adapter = deps.adapter('telegram');
    let outcome: { text: string; again: boolean };
    let activeHookFp = preWork.hookFp;
    if (!adapter?.chatHook) {
      outcome = await failed(preWork.hookFp, 'NO_ADAPTER');
    } else {
      let opened: Opened | null = null;
      try {
        opened = await open(deps, job);
      } catch {
        opened = null;
      }
      if (!opened) {
        outcome = await failed(preWork.hookFp, 'CREDENTIAL_ERROR');
      } else if (opened.kind === 'refused') {
        outcome = await failed(preWork.hookFp, opened.code);
      } else {
        const openedSecret = opened.secret;
        const lockKey = deps.workerDb ? botLockKeyOfId(adapter.chatHookBotId?.(openedSecret)) : null;
        const runLocked = async (renewLock?: () => Promise<boolean>): Promise<{ text: string; again: boolean; workFp: string | undefined }> => {
          const work = deps.workerDb && lockKey
            ? await deps.runtime.query<TelegramChatWork>('kernel.channel.telegram_chat_work', { connectionId: job.connectionId, action, ...(usedHookFp ? { usedHookFp } : {}) }, options)
            : preWork;
          if (work.action !== 'call' || (job.on && !work.hook)) return { text: last, again: false, workFp: work.hookFp };
          // If the channel reconnected with a different hook/bot between opening the token and acquiring the bot lock, re-open and re-lock for the new bot.
          if (preWork.hookFp && work.hookFp && work.hookFp !== preWork.hookFp) {
            return { text: last, again: true, workFp: usedHookFp };
          }
          // Before deleting the bot's webhook, check whether another org says 'on'; if so, verify live Telegram webhook
          // ownership so a stale peer row cannot prevent B from deleting its own webhook while another owner's webhook stays untouched.
          const lockBotId = validBotId(adapter.chatHookBotId?.(openedSecret) ?? null);
          if (!job.on && deps.workerDb && lockBotId) {
            const { rows: takers } = await sql<{ taken: boolean }>`
              SELECT ludy_kernel.telegram_chat_other_org_holds_bot(${lockBotId}, ${job.orgId}::uuid) AS taken`.execute(deps.workerDb);
            if (takers[0]?.taken === true) {
              if (adapter.chatHookInfo && work.hook) {
                if (renewLock && !(await renewLock().catch(() => false))) {
                  const res = await failed(work.hookFp, 'TELEGRAM_BOT_LOCK_BUSY');
                  return { ...res, workFp: work.hookFp };
                }
                const info = await adapter.chatHookInfo({ secret: openedSecret, hook: work.hook, baseUrl: deps.baseUrl });
                if (info.kind === 'failed') {
                  const res = await failed(work.hookFp, info.code);
                  return { ...res, workFp: work.hookFp };
                }
                if (info.url === '' || (!info.matchesHook && info.matchesHookPath !== true)) {
                  const recorded = await record(work.hookFp, 'done');
                  return { text: 'off', again: recorded.hookChanged, workFp: work.hookFp };
                }
              } else {
                const recorded = await record(work.hookFp, 'done');
                return { text: 'off', again: recorded.hookChanged, workFp: work.hookFp };
              }
            }
          }
          if (renewLock && !(await renewLock().catch(() => false))) {
            const res = await failed(work.hookFp, 'TELEGRAM_BOT_LOCK_BUSY');
            return { ...res, workFp: work.hookFp };
          }
          const derived = deps.broker.deriveKeys?.(TELEGRAM_HOOK_KEY_INFO)[0];
          let answer;
          try {
            answer = await adapter.chatHook!({ secret: openedSecret, on: job.on, hook: work.hook ?? '', baseUrl: deps.baseUrl, key: derived?.key ?? null, takenBotIds: work.takenBotIds ?? [] });
          } catch {
            answer = { kind: 'failed' as const, retry: true, code: 'ADAPTER_ERROR' };
          }
          if (answer.kind === 'failed') {
            const res = await failed(work.hookFp, answer.code);
            return { ...res, workFp: work.hookFp };
          }
          const hookKeyId = job.on ? (derived?.id ?? currentKeyOfBroker(deps.broker)) : undefined;
          const recorded = await record(work.hookFp, 'done', {
            ...(job.on && answer.botId ? { botId: answer.botId } : {}),
            ...(hookKeyId ? { hookKeyId } : {}),
          });
          if (job.on && recorded.applied && recorded.chatState === 'on') {
            await displaceAndAck(deps.runtime, deps.workerDb, job.orgId, job.connectionId, answer.botId, recorded.changedAt, renewLock);
          }
          return { text: job.on ? 'on' : 'off', again: recorded.hookChanged, workFp: work.hookFp };
        };
        try {
          const lockedResult = deps.workerDb && lockKey ? await withBotWebhookLock(deps.workerDb, lockKey, runLocked) : await runLocked();
          activeHookFp = lockedResult.workFp;
          outcome = { text: lockedResult.text, again: lockedResult.again };
        } catch (error) {
          if (error instanceof Error && error.message === 'TELEGRAM_BOT_LOCK_BUSY') {
            outcome = await failed(preWork.hookFp, 'TELEGRAM_BOT_LOCK_BUSY');
          } else {
            throw error;
          }
        }
      }
    }
    last = outcome.text;
    if (!outcome.again) return last;
    usedHookFp = activeHookFp;
  }
  return `${last}:busy`;
}

const REKEY_ACTOR = { type: 'system' as const, component: 'kernel.telegram_webhook.rekey' };
const REKEY_LOCK_KEY = 'ludy.telegram-webhook-rekey';
const REKEY_LIMIT = 200;
const REKEY_PAGES = 5;

interface RekeyCursor {
  rekeyAt: Date | null;
  orgId: string;
  id: string;
}

const rekeySweepCursors = new Map<string, RekeyCursor | null>();

export interface TelegramWebhookRekeyDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  adapter: (provider: string) => ConversationAdapter | undefined;
  baseUrl: string;
  maxPages?: number;
}

export interface TelegramWebhookRekeyOutcome {
  rekeyed: number;
  failed: number;
  leftActive: number;
  leftInactive: number;
  skipped: boolean;
  skipReason?: 'unconfigured' | 'locked';
}

const markRekeyRetry = async (runtime: Runtime, orgId: string, connectionId: string, hookFp: string): Promise<void> => {
  await runtime
    .execute('kernel.channel.telegram_chat_rekey_retry', { connectionId, hookFp }, { actor: REKEY_ACTOR, orgId })
    .catch((error: unknown) => console.error(`[telegram-webhook-rekey] mark retry ${connectionId.slice(0, 8)}`, error instanceof Error ? error.name : typeof error));
};

// Re-registers live Telegram webhooks under the current credential key after CREDENTIAL_KEY rotates (#3150 item 1).
// Uses non-blocking DB leases instead of holding pool connections across HTTP/RPC calls, checks live webhook ownership via
// getWebhookInfo before calling setWebhook, and sorts transient failures behind untouched rows so healthy channels are never starved.
export async function rekeyTelegramWebhooks(deps: TelegramWebhookRekeyDeps): Promise<TelegramWebhookRekeyOutcome> {
  const outcome: TelegramWebhookRekeyOutcome = { rekeyed: 0, failed: 0, leftActive: 0, leftInactive: 0, skipped: false };
  const adapter = deps.adapter('telegram');
  const derived = deps.broker.deriveKeys?.(TELEGRAM_HOOK_KEY_INFO)[0];
  const current = derived?.id ?? currentKeyOfBroker(deps.broker) ?? null;
  if (!adapter?.chatHook || !current || !derived?.key || !deps.baseUrl.startsWith('https://')) {
    return { ...outcome, skipped: true, skipReason: 'unconfigured' };
  }
  const lockOwner = randomUUID();
  const locked = await tryAcquireWebhookLock(deps.workerDb, REKEY_LOCK_KEY, lockOwner, REKEY_SWEEP_TTL_SECONDS);
  if (!locked) return { ...outcome, skipped: true, skipReason: 'locked' };
  try {
    await reconcileTelegramDisplacements({ workerDb: deps.workerDb, runtime: deps.runtime, force: true }).catch((error: unknown) => {
      console.error('[telegram-webhook-rekey] reconcile displace', error instanceof Error ? error.name : typeof error);
    });
    const pages = Math.max(1, Math.floor(deps.maxPages ?? REKEY_PAGES));
    let after = rekeySweepCursors.get(current) ?? null;
    const seen = new Set<string>();
    for (let page = 0; page < pages; page += 1) {
      if (!(await tryAcquireWebhookLock(deps.workerDb, REKEY_LOCK_KEY, lockOwner, REKEY_SWEEP_TTL_SECONDS))) break;
      const { rows } = await sql<{ org_id: string; connection_id: string; chat_hook_rekey_after: Date | null }>`
        SELECT org_id, connection_id, chat_hook_rekey_after
        FROM ludy_kernel.telegram_chat_hook_rekey_due(${current}, ${REKEY_LIMIT}::int, ${after?.rekeyAt ?? null}::timestamptz, ${after?.orgId ?? null}::uuid, ${after?.id ?? null}::uuid)`.execute(deps.workerDb);
      if (rows.length === 0) {
        rekeySweepCursors.set(current, null);
        break;
      }
      let wrappedToSeen = false;
      let lockLost = false;
      for (const [index, row] of rows.entries()) {
        if (index > 0 && index % 3 === 0) {
          if (!(await tryAcquireWebhookLock(deps.workerDb, REKEY_LOCK_KEY, lockOwner, REKEY_SWEEP_TTL_SECONDS))) {
            lockLost = true;
            break;
          }
        }
        if (seen.has(row.connection_id)) {
          wrappedToSeen = true;
          continue;
        }
        seen.add(row.connection_id);
        const result = await rekeyOneTelegramWebhook(deps, adapter, current, derived.key, row).catch((error: unknown) => {
          console.error(`[telegram-webhook-rekey] connection ${row.connection_id.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
          return 'failed' as const;
        });
        if (result === 'rekeyed') outcome.rekeyed += 1;
        else if (result === 'failed') outcome.failed += 1;
      }
      if (lockLost) break;
      const last = rows.at(-1);
      if (!last || rows.length < REKEY_LIMIT || wrappedToSeen) {
        rekeySweepCursors.set(current, null);
        break;
      }
      after = { rekeyAt: last.chat_hook_rekey_after, orgId: last.org_id, id: last.connection_id };
      rekeySweepCursors.set(current, after);
    }
    const left = await countTelegramWebhookRekeyLeft(deps.workerDb, current);
    outcome.leftActive = left.leftActive;
    outcome.leftInactive = left.leftInactive;
    return outcome;
  } finally {
    await releaseWebhookLock(deps.workerDb, REKEY_LOCK_KEY, lockOwner).catch(() => undefined);
  }
}

export async function countTelegramWebhookRekeyLeft(workerDb: Db, currentKeyId?: string): Promise<{ leftActive: number; leftInactive: number }> {
  const { rows: counts } = await sql<{ key_id: string; active: string; inactive: string }>`
    SELECT key_id, active, inactive FROM ludy_kernel.telegram_chat_hook_rekey_counts()`.execute(workerDb);
  let leftActive = 0;
  let leftInactive = 0;
  for (const c of counts) {
    if (currentKeyId && c.key_id === currentKeyId) continue;
    leftActive += Number(c.active);
    leftInactive += Number(c.inactive);
  }
  return { leftActive, leftInactive };
}

async function rekeyOneTelegramWebhook(
  deps: TelegramWebhookRekeyDeps,
  adapter: ConversationAdapter,
  currentKeyId: string,
  derivedKey: Buffer,
  row: { org_id: string; connection_id: string },
): Promise<'rekeyed' | 'failed' | 'skipped'> {
  if (!adapter.chatHook) return 'skipped';
  const options = { actor: REKEY_ACTOR, orgId: row.org_id };
  const preWork = await deps.runtime.query<TelegramChatWork>('kernel.channel.telegram_chat_work', { connectionId: row.connection_id, action: 'enable', rekey: true }, options);
  if (preWork.action !== 'call' || !preWork.hook || !preWork.hookFp) return 'skipped';
  const opened = await open({ runtime: deps.runtime, broker: deps.broker }, { orgId: row.org_id, connectionId: row.connection_id });
  if (opened.kind === 'refused') {
    await markRekeyRetry(deps.runtime, row.org_id, row.connection_id, preWork.hookFp);
    return 'failed';
  }
  const rawBotId = adapter.chatHookBotId?.(opened.secret) ?? null;
  const lockKey = botLockKeyOfId(rawBotId);
  const runLocked = async (renewLock?: () => Promise<boolean>): Promise<'rekeyed' | 'failed' | 'skipped'> => {
    const work = await deps.runtime.query<TelegramChatWork>('kernel.channel.telegram_chat_work', { connectionId: row.connection_id, action: 'enable', rekey: true }, options);
    if (work.action !== 'call' || !work.hook || !work.hookFp) return 'skipped';
    if (work.hookFp !== preWork.hookFp || (work.expectedBotId && rawBotId && rawBotId !== work.expectedBotId)) {
      return 'skipped';
    }
    if (adapter.chatHookInfo) {
      const checkedAt = new Date().toISOString();
      const info = await adapter.chatHookInfo({ secret: opened.secret, hook: work.hook, baseUrl: deps.baseUrl });
      if (info.kind === 'failed') {
        console.error(`[telegram-webhook-rekey] connection ${row.connection_id.slice(0, 8)} ${info.code}`);
        await markRekeyRetry(deps.runtime, row.org_id, row.connection_id, work.hookFp);
        return 'failed';
      }
      if (info.url !== '' && info.matchesHook === false && info.matchesHookPath !== true) {
        const botId = validBotId(rawBotId);
        if (botId) {
          await deps.runtime.execute('kernel.channel.telegram_chat_displaced', { connectionId: row.connection_id, botId, takenAt: checkedAt }, { actor: SYSTEM, orgId: row.org_id });
        }
        return 'skipped';
      }
      if (renewLock && !(await renewLock().catch(() => false))) return 'skipped';
    }
    const answer = await adapter.chatHook!({ secret: opened.secret, on: true, hook: work.hook, baseUrl: deps.baseUrl, key: derivedKey, takenBotIds: work.takenBotIds ?? [] });
    if (answer.kind === 'failed') {
      console.error(`[telegram-webhook-rekey] connection ${row.connection_id.slice(0, 8)} ${answer.code}`);
      await markRekeyRetry(deps.runtime, row.org_id, row.connection_id, work.hookFp);
      return 'failed';
    }
    const recorded = await deps.runtime.execute<{ applied: boolean; displaceAt: string | null }>(
      'kernel.channel.telegram_chat_rekey_record',
      { connectionId: row.connection_id, hookFp: work.hookFp, hookKeyId: currentKeyId, ...(answer.botId ? { botId: answer.botId } : {}) },
      options,
    );
    if (recorded.applied) {
      await displaceAndAck(deps.runtime, deps.workerDb, row.org_id, row.connection_id, answer.botId, recorded.displaceAt, renewLock);
      return 'rekeyed';
    }
    return 'skipped';
  };
  return lockKey ? withBotWebhookLock(deps.workerDb, lockKey, runLocked) : runLocked();
}

// A chat switch queued where this worker has no channel to make the call through: the attempt is recorded as failed, so the screen says so and
// nothing stays enabling with no job.
export async function failChatHook(runtime: Runtime, job: ConversationChatJob): Promise<void> {
  await runtime.execute('kernel.channel.telegram_chat_record', { connectionId: job.connectionId, action: job.on ? 'enable' : 'disable', outcome: 'failed', code: 'CHANNEL_NOT_CONFIGURED' }, { actor: SYSTEM, orgId: job.orgId });
}

// The jobs that read from a platform beyond the webhook (CV5b, #2329), on the same queue as a reply: ids only, never a name or a message.
export type ConversationSyncJob = { orgId: string; connectionId: string; action: 'history' } | { orgId: string; connectionId: string; action: 'profile'; identityId: string };

// The most chats one history read goes through, and the events one ingest call takes.
const HISTORY_CHATS = 20;
const INGEST_CHUNK = 200;

// Reads one platform call's worth of what the webhook did not bring: the account's recent history (stored through the same idempotent
// ingest, with a gap recorded when it could not reach back far enough) or a customer's name. A refused credential is left for the
// reconnect; a failure worth trying again throws so the queue retries; nothing a platform said is logged, only counts and ids.
export async function runConversationSync(deps: SendDeps, job: ConversationSyncJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  if (job.action === 'profile') {
    const work = await deps.runtime.execute<ProfileWork>('kernel.conversation.profile_begin', { identityId: job.identityId, connectionId: job.connectionId }, options);
    if (work.action !== 'call' || !work.provider || !work.contactId) return 'none';
    const adapter = deps.adapter(work.provider);
    if (!adapter?.profile) return 'no_adapter';
    const opened = await open(deps, job);
    if (opened.kind === 'refused') return 'refused';
    let answer: Awaited<ReturnType<NonNullable<ConversationAdapter['profile']>>>;
    try {
      answer = await adapter.profile({ externalAccountId: opened.externalAccountId, secret: opened.secret, contactId: work.contactId });
    } catch {
      answer = { kind: 'failed', retry: true, code: 'ADAPTER_ERROR' };
    }
    if (answer.kind === 'ok') {
      await deps.runtime.execute('kernel.conversation.profile_apply', { identityId: job.identityId, displayName: answer.displayName, retry: false }, options);
      return answer.displayName ? 'named' : 'no_name';
    }
    // A refusal that asking again will not change is final (the customer is marked checked); the rest is asked again later.
    await deps.runtime.execute('kernel.conversation.profile_apply', { identityId: job.identityId, displayName: null, retry: answer.retry }, options);
    return answer.retry ? 'retry' : 'failed';
  }
  const work = await deps.runtime.execute<HistoryWork>('kernel.conversation.history_begin', { connectionId: job.connectionId }, options);
  if (work.action !== 'call' || !work.provider || !work.since) return 'none';
  const adapter = deps.adapter(work.provider);
  if (!adapter?.history) return 'no_adapter';
  const opened = await open(deps, job);
  if (opened.kind === 'refused') return 'refused';
  let answer: Awaited<ReturnType<NonNullable<ConversationAdapter['history']>>>;
  try {
    answer = await adapter.history({ externalAccountId: opened.externalAccountId, secret: opened.secret, since: new Date(work.since), maxChats: HISTORY_CHATS });
  } catch {
    answer = { kind: 'failed', retry: true, code: 'ADAPTER_ERROR' };
  }
  if (answer.kind === 'failed') {
    // A provider that meters its API (YouTube, #3134) has its spent units and its next poll recorded, and is never read again by the job's own retry:
    // asking again at once would spend more of a quota that is the failure. Its poll comes back by its own interval (the kernel sets it).
    if (work.provider === 'youtube') {
      await deps.runtime.execute(
        'kernel.conversation.history_record',
        {
          connectionId: job.connectionId,
          complete: false,
          gapFrom: null,
          gapTo: null,
          quota: { units: Math.min(answer.units ?? 0, 1000), outcome: answer.retry ? 'retry' : 'final', newMessages: 0, blockedUntil: answer.quotaUntil ? answer.quotaUntil.toISOString() : null },
        },
        options,
      );
      return 'failed';
    }
    // Asked again by the job's retry, then by the next pass after an hour; a refusal that will not change waits for the reconnect.
    if (answer.retry) throw new Error('history read failed');
    return 'failed';
  }
  let stored = 0;
  try {
    for (let i = 0; i < answer.events.length; i += INGEST_CHUNK) {
      const ingested = await deps.runtime.execute<{ stored: number }>('kernel.conversation.ingest', { connectionId: job.connectionId, events: answer.events.slice(i, i + INGEST_CHUNK) }, options);
      stored += ingested.stored;
    }
  } catch (error) {
    if (work.provider !== 'youtube') throw error;
    // The platform was asked and its units are spent whatever happens after: they are counted, and the poll comes back by its own interval, never by the
    // job's retry (which would ask Google again, uncounted, while the store is failing).
    await deps.runtime.execute(
      'kernel.conversation.history_record',
      { connectionId: job.connectionId, complete: false, gapFrom: null, gapTo: null, quota: { units: Math.min(answer.units ?? 0, 1000), outcome: 'retry', newMessages: 0, blockedUntil: null } },
      options,
    );
    return 'failed';
  }
  await deps.runtime.execute(
    'kernel.conversation.history_record',
    {
      connectionId: job.connectionId,
      complete: answer.complete,
      gapFrom: answer.complete ? null : work.since,
      gapTo: answer.complete ? null : answer.oldest,
      ...(work.provider === 'youtube' ? { quota: { units: Math.min(answer.units ?? 0, 1000), outcome: 'ok' as const, newMessages: stored, blockedUntil: null } } : {}),
    },
    options,
  );
  return answer.complete ? 'complete' : 'gap';
}

// The work the relay hands out each pass (ludy_kernel.conversation_sync_due, the worker login's): which connections' history is due,
// and which customers have no name yet, for the providers whose adapters can read them.
export async function dueConversationSync(workerDb: Db, providers: { history: string[]; profile: string[] }): Promise<ConversationSyncJob[]> {
  if (providers.history.length === 0 && providers.profile.length === 0) return [];
  const { rows } = await sql<{ kind: string; org_id: string; connection_id: string; identity_id: string | null }>`
    SELECT kind, org_id, connection_id, identity_id FROM ludy_kernel.conversation_sync_due(${providers.history}::text[], ${providers.profile}::text[], 60, 50)`.execute(workerDb);
  return rows.map((r) => (r.kind === 'history' ? { orgId: r.org_id, connectionId: r.connection_id, action: 'history' as const } : { orgId: r.org_id, connectionId: r.connection_id, action: 'profile' as const, identityId: r.identity_id as string }));
}

// Hands each due piece of work to the worker's queue through the command that marks it handed out and emits its event.
export async function requestConversationSync(runtime: Runtime, jobs: readonly ConversationSyncJob[]): Promise<number> {
  let queued = 0;
  for (const job of jobs) {
    const input = job.action === 'profile' ? { action: job.action, connectionId: job.connectionId, identityId: job.identityId } : { action: job.action, connectionId: job.connectionId };
    const result = await runtime.execute<{ queued: boolean }>('kernel.conversation.sync_request', input, { actor: SYSTEM, orgId: job.orgId });
    if (result.queued) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------------------------------------------------------------
// Customers' images (CV5c, #2357). A message that carries an image is stored at once with its placeholder text and a pending
// conversation_attachment row holding the platform's address; the relay hands each pending row to this queue (ids only in the job), the job
// fetches the image through the egress guard and records the bytes, and the row's blob is deleted by the sweep below when the row goes.
// Nothing the platform sent (the address, a byte of the image) is logged, put in a job, an audit row or an event.
// ---------------------------------------------------------------------------------------------------------------------

export type ConversationAttachmentJob = { orgId: string; connectionId: string; action: 'attachment'; attachmentId: string };

export interface AttachmentDeps {
  runtime: Runtime;
  store: BlobStore;
  // The deployment's own list of media hosts (CHANNEL_ZALO_MEDIA_HOSTS); unset, each provider's own.
  hosts?: readonly string[] | undefined;
  // The deployment's own list of another provider's media hosts (CHANNEL_WHATSAPP_MEDIA_HOSTS, #3131); an empty list is the provider's own.
  providerHosts?: Readonly<Record<string, readonly string[]>> | undefined;
  // For an image given by a reference (#3131): the credential broker that opens the connection's token inside this job, and the provider's adapter that turns the
  // reference into bytes with it. Without them such an image is dropped (nothing can fetch it).
  broker?: CredentialBroker | undefined;
  adapter?: ((provider: string) => ConversationAdapter | undefined) | undefined;
  // Tests only: the egress guard's resolver, address check and port.
  egress?: FetchConversationImageOptions['egress'];
}

// Fetches one pending image and records what came of it: 'stored', 'dropped' (the image will never be fetched), 'retry' (asked again by the
// relay after a few minutes, up to five tries), or 'none' (nothing to do: the row is gone, stored, or its connection is not active). The
// outcome string is for the log and carries no platform text.
export async function runConversationAttachment(deps: AttachmentDeps, job: ConversationAttachmentJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const source = await deps.runtime.query<AttachmentSource | null>('kernel.conversation.attachment_source', { attachmentId: job.attachmentId }, options);
  if (!source) return 'none';
  const failed = async (retry: boolean, code: string): Promise<string> => {
    await deps.runtime.execute('kernel.conversation.attachment_record', { outcome: 'failed', attachmentId: job.attachmentId, retry, code }, options);
    return retry ? 'retry' : 'dropped';
  };
  const hosts = mediaHostsOf(source.provider, deps.hosts, deps.providerHosts);
  let got: Awaited<ReturnType<typeof fetchConversationImage>>;
  if (source.sourceUrl !== null) {
    got = await fetchConversationImage(source.sourceUrl, { hosts, ...(deps.egress ? { egress: deps.egress } : {}) });
  } else if (source.mediaRef !== null) {
    // The reference is turned into bytes by the adapter with the connection's sealed token, opened here and nowhere else; nothing of it is logged or put in a job.
    const adapter = deps.adapter?.(source.provider);
    if (!adapter?.media || !deps.broker) return failed(false, 'NO_MEDIA_ADAPTER');
    let opened: Opened;
    try {
      opened = await open({ runtime: deps.runtime, broker: deps.broker }, job);
    } catch {
      return failed(true, 'CREDENTIAL_ERROR');
    }
    if (opened.kind === 'refused') return failed(false, opened.code);
    got = await fetchConversationMedia(adapter, { externalAccountId: opened.externalAccountId, secret: opened.secret, mediaRef: source.mediaRef, hosts, ...(deps.egress ? { egress: deps.egress } : {}) });
  } else {
    return 'none';
  }
  if (got.kind === 'failed') return failed(got.retry, got.code);
  const sha256 = sha256Hex(got.bytes);
  let generation: string;
  try {
    generation = await putFile(deps.store, source.storageKey, got.bytes, got.contentType, sha256);
  } catch (error) {
    // The key was reserved for these bytes alone, so other bytes under it mean the same key was written twice with different answers (a
    // retry of a job that already ran): the image is dropped and its blob deleted with the row. Anything else is the store failing.
    return failed(!(error instanceof BlobConflictError), error instanceof BlobConflictError ? 'STORE_CONFLICT' : 'STORE_ERROR');
  }
  const done = await deps.runtime.execute<{ recorded: boolean }>(
    'kernel.conversation.attachment_record',
    { outcome: 'stored', attachmentId: job.attachmentId, sha256, sizeBytes: got.bytes.byteLength, contentType: got.contentType, generation, width: got.width, height: got.height },
    options,
  );
  // A row that went while the bytes were being fetched (the customer was erased) recorded nothing; its blob is queued by its deletion.
  return done.recorded ? 'stored' : 'none';
}

// The pending images the relay hands out each pass (ludy_kernel.conversation_attachment_due, the worker login's). The same call drops the
// images that will never be fetched: older than six days, or tried five times.
export const ATTACHMENT_RETRY_SECONDS = 300;
export const ATTACHMENT_BATCH = 50;
export async function dueConversationAttachments(workerDb: Db): Promise<Array<{ orgId: string; connectionId: string; attachmentId: string }>> {
  const { rows } = await sql<{ org_id: string; attachment_id: string; connection_id: string }>`
    SELECT org_id, attachment_id, connection_id FROM ludy_kernel.conversation_attachment_due(${ATTACHMENT_BATCH}::int, ${ATTACHMENT_RETRY_SECONDS}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, attachmentId: r.attachment_id }));
}

// Hands each due image to the queue through the command that marks it handed out and emits its event.
export async function requestConversationAttachments(runtime: Runtime, due: ReadonlyArray<{ orgId: string; attachmentId: string }>): Promise<number> {
  let queued = 0;
  for (const row of due) {
    const result = await runtime.execute<{ queued: boolean }>('kernel.conversation.attachment_request', { attachmentId: row.attachmentId }, { actor: SYSTEM, orgId: row.orgId });
    if (result.queued) queued++;
  }
  return queued;
}

// Deletes from the store the blobs whose rows are gone (ludy_kernel.conversation_blob_doomed: every path that deletes a row queued its
// key in the same transaction), then tells the database which are done. A key that could not be deleted stays leased for five minutes and
// is claimed again. At most once a minute, a batch at a time; `force` skips the wait (tests, and a purge that wants its blobs now).
// Returns how many blobs were deleted. A missing object is a success (the store's delete says nothing of it).
const BLOB_SWEEP_MS = 60_000;
const BLOB_SWEEP_BATCH = 200;
let lastBlobSweep = 0;
export async function sweepConversationBlobs(deps: { workerDb: Db; store: BlobStore; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastBlobSweep < BLOB_SWEEP_MS) return 0;
  lastBlobSweep = now;
  let deleted = 0;
  for (let pass = 0; pass < 10; pass++) {
    const { rows } = await sql<{ blob_key: string }>`SELECT blob_key FROM ludy_kernel.conversation_blob_claim(${BLOB_SWEEP_BATCH}::int)`.execute(deps.workerDb);
    if (rows.length === 0) break;
    const done: string[] = [];
    for (const { blob_key: key } of rows) {
      try {
        await deps.store.delete(key);
        done.push(key);
      } catch {
        // Left to its lease; nothing of the key or the error goes to the log, only the count below.
      }
    }
    if (done.length > 0) await sql`SELECT ludy_kernel.conversation_blob_done(${done}::text[])`.execute(deps.workerDb);
    deleted += done.length;
    if (done.length < rows.length) {
      console.error(`[conversations] ${rows.length - done.length} blob(s) not deleted; claimed again after the lease`);
      break;
    }
    if (rows.length < BLOB_SWEEP_BATCH) break;
  }
  return deleted;
}

export interface ConversationJob {
  orgId: string;
  messageId: string;
  connectionId: string;
  action: 'reply' | 'hide';
}

export interface SendDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  adapter: (provider: string) => ConversationAdapter | undefined;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

type Opened = { kind: 'ok'; externalAccountId: string; secret: string } | { kind: 'refused'; code: string; expired: boolean };

// The credential of a connection, opened here and nowhere else. kernel.channel.credential refuses once the member who connected
// the account may no longer use it or the connection is not active.
async function open(deps: Pick<SendDeps, 'runtime' | 'broker'>, job: { orgId: string; connectionId: string }): Promise<Opened> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE' || error.code === 'CHANNEL_NOT_FOUND')) {
      return { kind: 'refused', code: error.code, expired: error.code === 'CHANNEL_OWNER_LEFT' };
    }
    throw error;
  }
  const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  return { kind: 'ok', externalAccountId: sealed.externalAccountId, secret };
}

const expire = async (deps: SendDeps, job: { orgId: string; connectionId: string }, reason: string, version: string): Promise<void> => {
  await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: job.connectionId, reason, ifVersion: version }, { actor: SYSTEM, orgId: job.orgId });
};

// Sends one reply or hide. Returns what became of it, for the log: the message id is not text, but nothing else is logged.
export async function runConversationJob(deps: SendDeps, job: ConversationJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  if (job.action === 'hide') return runHide(deps, job);
  const work = await deps.runtime.execute<ReplyWork>('kernel.conversation.reply_begin', { messageId: job.messageId }, options);
  if (work.action !== 'call' || !work.callKey || !work.provider || !work.connectionVersion || !work.kind || !work.threadId || !work.contactId || work.text === undefined) return work.reason ?? 'none';
  const record = (result: unknown) => deps.runtime.execute('kernel.conversation.reply_record', { messageId: job.messageId, callKey: work.callKey, result }, options);
  // The call is begun, so a failure to open the credential must not leave the message sending: nothing went out yet, so it is a
  // failed call a person may send again.
  let opened: Opened;
  try {
    opened = await open(deps, job);
  } catch {
    await record({ kind: 'rejected', error: 'transient', code: 'CREDENTIAL_ERROR' });
    return 'credential_error';
  }
  if (opened.kind === 'refused') {
    await record({ kind: 'rejected', error: 'permission', code: opened.code });
    if (opened.expired) await expire(deps, job, 'owner_left', work.connectionVersion);
    return 'refused';
  }
  const adapter = deps.adapter(work.provider);
  if (!adapter) {
    await record({ kind: 'rejected', error: 'bad_request', code: 'NO_ADAPTER' });
    return 'no_adapter';
  }
  // A throw out of an adapter says nothing of whether the platform got the message: unclear, a person settles it.
  let answer;
  try {
    answer = await adapter.reply({
      externalAccountId: opened.externalAccountId,
      secret: opened.secret,
      kind: work.kind,
      threadId: work.threadId,
      postId: work.postId ?? null,
      contactId: work.contactId,
      lastInboundAt: work.lastInboundAt ?? null,
      text: work.text,
      callKey: work.callKey,
    });
  } catch {
    answer = { kind: 'unknown' as const, code: 'ADAPTER_ERROR' };
  }
  await record(answer.kind === 'accepted' ? { kind: 'accepted', externalId: answer.externalId } : answer.kind === 'rejected' ? { kind: 'rejected', error: answer.error, ...(answer.code ? { code: answer.code } : {}) } : { kind: 'unknown', ...(answer.code ? { code: answer.code } : {}) });
  if (answer.kind === 'rejected' && answer.error === 'token_expired') await expire(deps, job, 'token_expired', work.connectionVersion);
  return answer.kind;
}

async function runHide(deps: SendDeps, job: ConversationJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const work = await deps.runtime.execute<HideWork>('kernel.conversation.hide_begin', { messageId: job.messageId }, options);
  if (work.action !== 'call' || !work.callKey || !work.provider || !work.connectionVersion || !work.externalMessageId || work.hidden === undefined) return 'none';
  const record = (result: unknown) => deps.runtime.execute('kernel.conversation.hide_record', { messageId: job.messageId, callKey: work.callKey, result }, options);
  // A credential that cannot be opened is a failed call a person may try again, not a hide left pending with no code.
  let opened: Opened;
  try {
    opened = await open(deps, job);
  } catch {
    await record({ kind: 'rejected', error: 'transient', code: 'CREDENTIAL_ERROR' });
    return 'credential_error';
  }
  if (opened.kind === 'refused') {
    await record({ kind: 'rejected', error: 'permission', code: opened.code });
    if (opened.expired) await expire(deps, job, 'owner_left', work.connectionVersion);
    return 'refused';
  }
  const adapter = deps.adapter(work.provider);
  if (!adapter?.hide) {
    await record({ kind: 'rejected', error: 'bad_request', code: 'NO_ADAPTER' });
    return 'no_adapter';
  }
  let answer;
  try {
    answer = await adapter.hide({ externalAccountId: opened.externalAccountId, secret: opened.secret, externalMessageId: work.externalMessageId, hidden: work.hidden, callKey: work.callKey });
  } catch {
    answer = { kind: 'unknown' as const, code: 'ADAPTER_ERROR' };
  }
  await record(answer.kind === 'done' ? { kind: 'done' } : answer.kind === 'rejected' ? { kind: 'rejected', error: answer.error, ...(answer.code ? { code: answer.code } : {}) } : { kind: 'unknown', ...(answer.code ? { code: answer.code } : {}) });
  if (answer.kind === 'rejected' && answer.error === 'token_expired') await expire(deps, job, 'token_expired', work.connectionVersion);
  // Hiding is idempotent: an unclear answer is asked again by the job's retry, which begins the same call once more.
  if (answer.kind === 'unknown') throw new Error('hide outcome unknown');
  return answer.kind;
}

// The batches of threads one org's purge may take in one daily run, and the orgs one run reaches: a backlog (a long retention just
// shortened, a first run on old data) is worked off over days rather than in one long transaction chain.
const PURGE_ORGS = 200;
const PURGE_BATCHES_PER_ORG = 25;
const PURGE_BATCH = 200;

// The daily retention purge of the conversation core (CV6): each org that holds a thread past its retention (an owner's choice of
// 6, 12 or 24 months, or none; the deployment default is 24), an erase tombstone older than 30 days, or an identity no thread or message names any more (#4381) gets the purge command in its own system context, in batches. A failing
// org is logged by name of the error and left for the next run, so one org cannot hold the others behind it. Returns the threads
// deleted. Nothing a customer wrote is read or logged: only counts.
export async function purgeExpiredConversations(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM ludy_kernel.conversation_purge_due(${PURGE_ORGS}::int)`.execute(deps.workerDb);
  let threads = 0;
  for (const { org_id: orgId } of rows) {
    try {
      for (let batch = 0; batch < PURGE_BATCHES_PER_ORG; batch++) {
        const out = await deps.runtime.execute<{ threads: number; more: boolean }>('kernel.conversation.purge_expired', { limit: PURGE_BATCH }, { actor: SYSTEM, orgId });
        threads += out.threads;
        if (!out.more) break;
      }
    } catch (error) {
      console.error(`[conversations] retention purge of org ${orgId.slice(0, 8)} failed`, error instanceof Error ? error.name : 'error');
    }
  }
  return threads;
}

// The requests of Meta's data deletion callback that name conversations (ludy_kernel.conversation_deletion_*): for each open
// request that is due, the connections its keyed hash names are closed (as a platform's deletion closes them: the credential is
// forgotten) and their conversations erased, each in the connection's own org, then the request is completed. A request that names
// no connection is completed with none. Every step is idempotent, so a pass that dies half way is run again whole; a request that
// fails is put off five minutes in the database. Returns how many requests it completed.
export async function runConversationDeletions(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ code: string; org_id: string | null; connection_id: string | null }>`
    SELECT code, org_id, connection_id FROM ludy_kernel.conversation_deletion_claim(50::int)`.execute(deps.workerDb);
  const byCode = new Map<string, Array<{ orgId: string; connectionId: string }>>();
  for (const row of rows) {
    const connections = byCode.get(row.code) ?? [];
    if (row.org_id && row.connection_id) connections.push({ orgId: row.org_id, connectionId: row.connection_id });
    byCode.set(row.code, connections);
  }
  let completed = 0;
  for (const [code, connections] of byCode) {
    try {
      for (const c of connections) {
        const options = { actor: SYSTEM, orgId: c.orgId };
        await deps.runtime.execute('kernel.channel.revoke_by_platform', { connectionId: c.connectionId }, options);
        await deps.runtime.execute('kernel.conversation.erase_connection', { connectionId: c.connectionId }, options);
      }
      await sql`SELECT ludy_kernel.conversation_deletion_complete(${code}, ${connections.length}::int)`.execute(deps.workerDb);
      completed++;
    } catch (error) {
      // By code only: nothing of the request or the connections goes to the log.
      console.error(`[conversations] deletion request ${code.slice(0, 8)} not completed`, error instanceof Error ? error.name : 'error');
      await sql`SELECT ludy_kernel.conversation_deletion_defer(${code})`.execute(deps.workerDb).catch(() => undefined);
    }
  }
  return completed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Vy's drafts (CV8, #2310). The relay asks ludy_kernel.conversation_draft_due which new conversations to draft for, and hands each through
// kernel.conversation.draft_enqueue (a row requested and the event the draft queue takes, ids only); a member's "Vy soạn" makes the same event. The job
// reads the end of the thread (customer text: tainted), calls the model in packages/agent and records the answer as a system command, so the draft is the
// system's text, always tainted, and no org-chart agent writes anything. Nothing the customer or Vy wrote is logged or put in a job: ids and codes only.
// ---------------------------------------------------------------------------------------------------------------------

export type ConversationDraftJob = { orgId: string; draftId: string; conversationId: string };

export interface DraftDeps {
  runtime: Runtime;
  writer: Pick<ConversationWriter, 'draft'>;
  // The org's daily limits and the model's price (the extraction's): over the AI cost limit a draft is not asked for.
  limits?: UsageLimits | undefined;
  // The AI budget meter (#2382) the draft's model call counts against, as the system: the meter records each call, so this job records no cost of its own.
  meter?: AiMeter | undefined;
  // The existing per-minute budget of AI drafting (ai-draft-limit.ts): a model call is made only when it allows one for the org; no counter of this job's own.
  budget?: DraftBudget | undefined;
}

// Half of a decimal amount ("20" is "10", "0.000003" is "0.000002"), by integer arithmetic on six decimals: an amount of money is never a JS number.
export function halfOf(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  const half = micro / 2n;
  return `${half / 1_000_000n}.${String(half % 1_000_000n).padStart(6, '0')}`;
}

// Writes one requested draft: what became of it, as a short word for the log ('written', 'none', 'limit', 'error', or 'gone' when the draft was decided
// or went stale while the job waited). A failure of the model call, a refusal and a draft the checks refused leave no draft (the person writes the reply
// or asks again): they are not retried, so a failing endpoint costs one call per message, not a loop.
export async function runConversationDraft(deps: DraftDeps, job: ConversationDraftJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const none = (code: string) => deps.runtime.execute('kernel.conversation.draft_record', { outcome: 'none', draftId: job.draftId, code }, options);
  const source = await deps.runtime.query<DraftSource | null>('kernel.conversation.draft_source', { draftId: job.draftId }, options);
  if (!source) return 'gone';
  if (deps.limits) {
    // Drafts stop at half the org's daily AI cost limit, so a customer who writes a lot cannot use up what the org's invoice reading needs.
    const over = await deps.runtime.query<{ metric: string } | null>('kernel.usage.over', { metrics: ['ai_cost'], limits: { ai_cost: halfOf(deps.limits.ai_cost) } }, options);
    if (over) {
      await none('AI_LIMIT');
      return 'limit';
    }
  }
  // The org's per-minute budget of AI drafts (a draft a member asked for was already rationed per member by the API): over it, no draft now, and the
  // person can ask again. The ticket is per draft, so the per-member part never refuses an automatic draft.
  const ticket = deps.budget?.take(job.orgId, `vy:${job.draftId}`);
  if (ticket && !ticket.allowed) {
    await none('RATE_LIMITED');
    return 'rate';
  }
  let result: ReplyDraftResult | null = null;
  let budgetSpent = false;
  try {
    const request = { messages: source.messages, customerName: source.customerName, language: 'vi' as const, maxChars: source.maxChars, savedReplies: source.savedReplies, orgName: source.orgName };
    // The call counts against the org's AI budget of the month (the meter records its cost, so it still counts toward the daily cost limit above).
    result = deps.meter ? await withAiScope({ orgId: job.orgId, meter: deps.meter }, () => deps.writer.draft(request)) : await deps.writer.draft(request);
  } catch (error) {
    // The org's budget is spent (#2382): no draft now; the person writes the reply, and the books and everything that needs no AI go on.
    budgetSpent = error instanceof AiBudgetExhaustedError;
    // Any other failure (the model, the endpoint, the network): nothing of the error (it may quote the prompt) goes to the log.
  } finally {
    ticket?.release();
  }
  if (budgetSpent) {
    await none('AI_BUDGET');
    return 'budget';
  }
  if (!result) {
    await none('AI_ERROR');
    return 'error';
  }
  if (result.kind === 'none') {
    await none(result.code);
    return 'none';
  }
  const done = await deps.runtime.execute<{ recorded: boolean }>('kernel.conversation.draft_record', { outcome: 'written', draftId: job.draftId, body: result.body }, options);
  return done.recorded ? 'written' : 'gone';
}

// A draft asked for where this worker has no model (no AI endpoint is configured): settled at once as none, so the thread shows no waiting draft and
// nothing stays requested with no job.
export async function failUndraftable(runtime: Runtime, job: ConversationDraftJob): Promise<void> {
  await runtime.execute('kernel.conversation.draft_record', { outcome: 'none', draftId: job.draftId, code: 'AI_OFF' }, { actor: SYSTEM, orgId: job.orgId });
}

// Drafts that outlived their time (ludy_kernel.conversation_draft_sweep, the worker login's): a request the job never answered is settled after 15
// minutes, and a live draft nobody opened loses its text after 7 days. The relay runs it whether or not a model is configured: the text of a draft is
// customer-derived, and it must not outlive its week in a deployment that switched the model off (ADR-0041). Not more often than every ten seconds.
export async function sweepConversationDrafts(deps: { workerDb: Db; now?: () => number; force?: boolean }): Promise<{ settled: number; expired: number }> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastDraftSweep < DRAFT_DUE_MS) return { settled: 0, expired: 0 };
  lastDraftSweep = now;
  const { rows } = await sql<{ settled: number; expired: number }>`SELECT settled, expired FROM ludy_kernel.conversation_draft_sweep()`.execute(deps.workerDb);
  return rows[0] ?? { settled: 0, expired: 0 };
}

// The "you are replying" markers that expired more than five minutes ago (ludy_kernel.conversation_composing_sweep, the worker login's, CV3): readers
// ignore a marker after its 60 seconds, so this only keeps the table small. Not more often than every ten seconds; runs in every deployment.
let lastComposingSweep = 0;
export async function sweepConversationComposing(deps: { workerDb: Db; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastComposingSweep < DRAFT_DUE_MS) return 0;
  lastComposingSweep = now;
  const { rows } = await sql<{ n: number }>`SELECT ludy_kernel.conversation_composing_sweep() AS n`.execute(deps.workerDb);
  return rows[0]?.n ?? 0;
}

// The new conversations to draft for (ludy_kernel.conversation_draft_due, the worker login's), at most a few at a time and not more often than every
// ten seconds: each costs a model call.
const DRAFT_DUE_MS = 10_000;
let lastDraftSweep = 0;
const DRAFT_BATCH = 5;
let lastDraftDue = 0;
export async function requestDueConversationDrafts(deps: { runtime: Runtime; workerDb: Db; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastDraftDue < DRAFT_DUE_MS) return 0;
  lastDraftDue = now;
  const { rows } = await sql<{ org_id: string; conversation_id: string }>`SELECT org_id, conversation_id FROM ludy_kernel.conversation_draft_due(${DRAFT_BATCH}::int)`.execute(deps.workerDb);
  let queued = 0;
  for (const row of rows) {
    const result = await deps.runtime.execute<{ queued: boolean }>('kernel.conversation.draft_enqueue', { conversationId: row.conversation_id }, { actor: SYSTEM, orgId: row.org_id });
    if (result.queued) queued++;
  }
  return queued;
}
