// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core's worker side (issue #2303, plan docs/plan/conversations.md sections 6.1 and 7), run as the system.
//
// Intake. A platform's signed notice is parked by the public webhook (or, for the sandbox, by the API) in
// crove_kernel.conversation_inbound_pending, which holds the body only until it is stored: the worker claims notices under a
// lease, parses each with its provider's parser, finds the connections the platform's own account id names (the org comes
// from the stored connection, never from the notice) and runs kernel.conversation.ingest for each, then deletes the notice.
// A body is personal data of a third party, so it is never logged, never put in a job and never kept past its storing; a
// notice that cannot be parsed or stored is dropped, with its provider and size logged, not its text.
//
// Sending. A reply or a hide is begun (the call row is committed as started), made with the credential the API sealed, and
// recorded. A reply is never repeated after an unclear answer (no platform send call has an idempotency key); a hide is
// idempotent, so its job may repeat it.
import {
  ConversationNoticeError,
  parseFacebookNotices,
  parseInstagramNotices,
  TELEGRAM_HOOK_KEY_INFO,
  parseSandboxNotice,
  parseTelegramChatNotice,
  parseThreadsNotices,
  parseZaloNotice,
  type ConversationAdapter,
  type ConversationNotice,
} from '@crove/channel';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { BlobConflictError, DomainError, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { AiBudgetExhaustedError, withAiScope, type AiMeter, type ConversationWriter, type ReplyDraftResult } from '@crove/agent';
import type { AttachmentSource, DraftSource, HideWork, HistoryWork, ProfileWork, ReplyWork, TelegramChatWork, UsageLimits } from '@crove/kernel';
import type { DraftBudget } from './ai-draft-limit.ts';
import { fetchConversationImage, mediaHostsOf, type FetchConversationImageOptions } from './conversation-media.ts';
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
    FROM crove_kernel.conversation_inbound_claim(${CONVERSATION_CLAIM}::int, ${CONVERSATION_LEASE_SECONDS}::int)`.execute(workerDb);
  return rows;
}

const finishNotice = async (workerDb: Db, seq: string): Promise<void> => {
  await sql`SELECT crove_kernel.conversation_inbound_done(${seq}::bigint)`.execute(workerDb);
};

async function connectionsFor(workerDb: Db, provider: string, accountId: string): Promise<Array<{ orgId: string; connectionId: string }>> {
  const { rows } = HOOK_PROVIDERS.has(provider)
    ? await sql<{ org_id: string; connection_id: string }>`SELECT org_id, connection_id FROM crove_kernel.conversation_chat_hook_connections(${accountId})`.execute(workerDb)
    : await sql<{ org_id: string; connection_id: string }>`SELECT org_id, connection_id FROM crove_kernel.conversation_connections_for(${provider}, ${accountId})`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id }));
}

export interface IntakeDeps {
  workerDb: Db;
  runtime: Runtime;
  // For the log only.
  log?: (message: string) => void;
}

// A refusal of the command itself (the events do not fit its shape, the connection went away) is the notice's own and will
// not change on a retry; anything else is the database or the runtime failing and is left to the lease.
const isPermanent = (error: unknown): boolean => error instanceof DomainError && error.status >= 400 && error.status < 500;

// One pass over the waiting notices: how many were stored, and how many dropped.
export async function runConversationIntake(deps: IntakeDeps): Promise<{ stored: number; dropped: number }> {
  const log = deps.log ?? ((message: string) => console.log(`[conversations] ${message}`));
  const out = { stored: 0, dropped: 0 };
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
      // No active connection holds this account (expired, revoked, offboarding, or none): the platforms keep no history to pull, so the
      // notice is gone; the count says so.
      if (targets.length === 0) log(`notice ${notice.seq} (${notice.provider}) names no active connection: dropped after storing nothing`);
      for (const target of targets) {
        try {
          if (parsed.businessState) {
            const { id, userId, name, username, canReply, enabled } = parsed.businessState;
            await deps.runtime.execute('kernel.channel.telegram_business_record', { connectionId: target.connectionId, account: { id, userId, name: name ?? null, username: username ?? null, canReply, enabled } }, { actor: SYSTEM, orgId: target.orgId });
          }
          if (parsed.events.length === 0) continue;
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
  const { rows } = await sql<{ org_id: string; message_id: string }>`SELECT org_id, message_id FROM crove_kernel.conversation_stale_sends(50::int)`.execute(deps.workerDb);
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
}

// Sets or deletes the connection's webhook and records the outcome. The returned text is for the log: a state or a code, nothing a platform
// said and nothing of the hook. The adapter builds the address and the secret from the hook and the deployment's key and never returns them.
// If the hook that was wanted changed while the call was made (a reconnect gave a new one), the answer is not applied and the job looks again, a few
// times at most, so Telegram ends up pointing at the hook the database holds.
export async function runTelegramChatHook(deps: ChatHookDeps, job: ConversationChatJob): Promise<string> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const action = job.on ? ('enable' as const) : ('disable' as const);
  let usedHookFp: string | undefined;
  let last = 'none';
  for (let round = 0; round < 3; round++) {
    const work = await deps.runtime.query<TelegramChatWork>('kernel.channel.telegram_chat_work', { connectionId: job.connectionId, action, ...(usedHookFp ? { usedHookFp } : {}) }, options);
    if (work.action !== 'call' || (job.on && !work.hook)) return last;
    const record = (outcome: 'done' | 'failed', extra: { botId?: string; code?: string } = {}) =>
      deps.runtime.execute<{ applied: boolean; hookChanged: boolean }>('kernel.channel.telegram_chat_record', { connectionId: job.connectionId, action, outcome, ...(work.hookFp ? { hookFp: work.hookFp } : {}), ...extra }, options);
    const failed = async (code: string): Promise<{ text: string; again: boolean }> => {
      const recorded = await record('failed', { code });
      return { text: `failed:${code}`, again: recorded.hookChanged };
    };
    const adapter = deps.adapter('telegram');
    let outcome: { text: string; again: boolean };
    if (!adapter?.chatHook) {
      outcome = await failed('NO_ADAPTER');
    } else {
      let opened: Opened | null = null;
      try {
        opened = await open(deps, job);
      } catch {
        opened = null;
      }
      if (!opened) {
        outcome = await failed('CREDENTIAL_ERROR');
      } else if (opened.kind === 'refused') {
        outcome = await failed(opened.code);
      } else {
        let answer;
        try {
          answer = await adapter.chatHook({ secret: opened.secret, on: job.on, hook: work.hook ?? '', baseUrl: deps.baseUrl, key: deps.broker.deriveKeys?.(TELEGRAM_HOOK_KEY_INFO)[0]?.key ?? null, takenBotIds: work.takenBotIds ?? [] });
        } catch {
          answer = { kind: 'failed' as const, retry: true, code: 'ADAPTER_ERROR' };
        }
        if (answer.kind === 'failed') {
          outcome = await failed(answer.code);
        } else {
          const recorded = await record('done', job.on && answer.botId ? { botId: answer.botId } : {});
          outcome = { text: job.on ? 'on' : 'off', again: recorded.hookChanged };
        }
      }
    }
    last = outcome.text;
    if (!outcome.again) return last;
    usedHookFp = work.hookFp;
  }
  return `${last}:busy`;
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
    // Asked again by the job's retry, then by the next pass after an hour; a refusal that will not change waits for the reconnect.
    if (answer.retry) throw new Error('history read failed');
    return 'failed';
  }
  for (let i = 0; i < answer.events.length; i += INGEST_CHUNK) {
    await deps.runtime.execute('kernel.conversation.ingest', { connectionId: job.connectionId, events: answer.events.slice(i, i + INGEST_CHUNK) }, options);
  }
  await deps.runtime.execute('kernel.conversation.history_record', { connectionId: job.connectionId, complete: answer.complete, gapFrom: answer.complete ? null : work.since, gapTo: answer.complete ? null : answer.oldest }, options);
  return answer.complete ? 'complete' : 'gap';
}

// The work the relay hands out each pass (crove_kernel.conversation_sync_due, the worker login's): which connections' history is due,
// and which customers have no name yet, for the providers whose adapters can read them.
export async function dueConversationSync(workerDb: Db, providers: { history: string[]; profile: string[] }): Promise<ConversationSyncJob[]> {
  if (providers.history.length === 0 && providers.profile.length === 0) return [];
  const { rows } = await sql<{ kind: string; org_id: string; connection_id: string; identity_id: string | null }>`
    SELECT kind, org_id, connection_id, identity_id FROM crove_kernel.conversation_sync_due(${providers.history}::text[], ${providers.profile}::text[], 60, 50)`.execute(workerDb);
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
  const got = await fetchConversationImage(source.sourceUrl, { hosts: mediaHostsOf(source.provider, deps.hosts), ...(deps.egress ? { egress: deps.egress } : {}) });
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

// The pending images the relay hands out each pass (crove_kernel.conversation_attachment_due, the worker login's). The same call drops the
// images that will never be fetched: older than six days, or tried five times.
export const ATTACHMENT_RETRY_SECONDS = 300;
export const ATTACHMENT_BATCH = 50;
export async function dueConversationAttachments(workerDb: Db): Promise<Array<{ orgId: string; connectionId: string; attachmentId: string }>> {
  const { rows } = await sql<{ org_id: string; attachment_id: string; connection_id: string }>`
    SELECT org_id, attachment_id, connection_id FROM crove_kernel.conversation_attachment_due(${ATTACHMENT_BATCH}::int, ${ATTACHMENT_RETRY_SECONDS}::int)`.execute(workerDb);
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

// Deletes from the store the blobs whose rows are gone (crove_kernel.conversation_blob_doomed: every path that deletes a row queued its
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
    const { rows } = await sql<{ blob_key: string }>`SELECT blob_key FROM crove_kernel.conversation_blob_claim(${BLOB_SWEEP_BATCH}::int)`.execute(deps.workerDb);
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
    if (done.length > 0) await sql`SELECT crove_kernel.conversation_blob_done(${done}::text[])`.execute(deps.workerDb);
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
// 6, 12 or 24 months, or none; the deployment default is 24) gets the purge command in its own system context, in batches. A failing
// org is logged by name of the error and left for the next run, so one org cannot hold the others behind it. Returns the threads
// deleted. Nothing a customer wrote is read or logged: only counts.
export async function purgeExpiredConversations(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_kernel.conversation_purge_due(${PURGE_ORGS}::int)`.execute(deps.workerDb);
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

// The requests of Meta's data deletion callback that name conversations (crove_kernel.conversation_deletion_*): for each open
// request that is due, the connections its keyed hash names are closed (as a platform's deletion closes them: the credential is
// forgotten) and their conversations erased, each in the connection's own org, then the request is completed. A request that names
// no connection is completed with none. Every step is idempotent, so a pass that dies half way is run again whole; a request that
// fails is put off five minutes in the database. Returns how many requests it completed.
export async function runConversationDeletions(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ code: string; org_id: string | null; connection_id: string | null }>`
    SELECT code, org_id, connection_id FROM crove_kernel.conversation_deletion_claim(50::int)`.execute(deps.workerDb);
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
      await sql`SELECT crove_kernel.conversation_deletion_complete(${code}, ${connections.length}::int)`.execute(deps.workerDb);
      completed++;
    } catch (error) {
      // By code only: nothing of the request or the connections goes to the log.
      console.error(`[conversations] deletion request ${code.slice(0, 8)} not completed`, error instanceof Error ? error.name : 'error');
      await sql`SELECT crove_kernel.conversation_deletion_defer(${code})`.execute(deps.workerDb).catch(() => undefined);
    }
  }
  return completed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Vy's drafts (CV8, #2310). The relay asks crove_kernel.conversation_draft_due which new conversations to draft for, and hands each through
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

// Drafts that outlived their time (crove_kernel.conversation_draft_sweep, the worker login's): a request the job never answered is settled after 15
// minutes, and a live draft nobody opened loses its text after 7 days. The relay runs it whether or not a model is configured: the text of a draft is
// customer-derived, and it must not outlive its week in a deployment that switched the model off (ADR-0041). Not more often than every ten seconds.
export async function sweepConversationDrafts(deps: { workerDb: Db; now?: () => number; force?: boolean }): Promise<{ settled: number; expired: number }> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastDraftSweep < DRAFT_DUE_MS) return { settled: 0, expired: 0 };
  lastDraftSweep = now;
  const { rows } = await sql<{ settled: number; expired: number }>`SELECT settled, expired FROM crove_kernel.conversation_draft_sweep()`.execute(deps.workerDb);
  return rows[0] ?? { settled: 0, expired: 0 };
}

// The "you are replying" markers that expired more than five minutes ago (crove_kernel.conversation_composing_sweep, the worker login's, CV3): readers
// ignore a marker after its 60 seconds, so this only keeps the table small. Not more often than every ten seconds; runs in every deployment.
let lastComposingSweep = 0;
export async function sweepConversationComposing(deps: { workerDb: Db; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastComposingSweep < DRAFT_DUE_MS) return 0;
  lastComposingSweep = now;
  const { rows } = await sql<{ n: number }>`SELECT crove_kernel.conversation_composing_sweep() AS n`.execute(deps.workerDb);
  return rows[0]?.n ?? 0;
}

// The new conversations to draft for (crove_kernel.conversation_draft_due, the worker login's), at most a few at a time and not more often than every
// ten seconds: each costs a model call.
const DRAFT_DUE_MS = 10_000;
let lastDraftSweep = 0;
const DRAFT_BATCH = 5;
let lastDraftDue = 0;
export async function requestDueConversationDrafts(deps: { runtime: Runtime; workerDb: Db; now?: () => number; force?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (!deps.force && now - lastDraftDue < DRAFT_DUE_MS) return 0;
  lastDraftDue = now;
  const { rows } = await sql<{ org_id: string; conversation_id: string }>`SELECT org_id, conversation_id FROM crove_kernel.conversation_draft_due(${DRAFT_BATCH}::int)`.execute(deps.workerDb);
  let queued = 0;
  for (const row of rows) {
    const result = await deps.runtime.execute<{ queued: boolean }>('kernel.conversation.draft_enqueue', { conversationId: row.conversation_id }, { actor: SYSTEM, orgId: row.org_id });
    if (result.queued) queued++;
  }
  return queued;
}
