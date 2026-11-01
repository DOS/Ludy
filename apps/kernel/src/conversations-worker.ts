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
import { ConversationNoticeError, parseSandboxNotice, parseZaloNotice, type ConversationAdapter, type ConversationNotice } from '@crove/channel';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import type { HideWork, ReplyWork } from '@crove/kernel';
import { opsAlert } from './ops-alert.ts';

const SYSTEM = { type: 'system' as const, component: 'conversations' };

// A notice is claimed for this long; a worker that dies holding it lets it go to the next claim.
export const CONVERSATION_LEASE_SECONDS = 120;
// The notices one pass claims at most.
export const CONVERSATION_CLAIM = 20;

// The providers whose notices the worker can read: each turns a verified notice into events. A provider with no parser here
// has its notices dropped.
type NoticeParser = (body: Uint8Array) => ConversationNotice;
export const NOTICE_PARSERS: Readonly<Record<string, NoticeParser>> = {
  sandbox: parseSandboxNotice,
  // Zalo OA (#2304): its signature was checked by the route before the body was parked.
  zalo_oa: parseZaloNotice,
};

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
  const { rows } = await sql<{ org_id: string; connection_id: string }>`
    SELECT org_id, connection_id FROM crove_kernel.conversation_connections_for(${provider}, ${accountId})`.execute(workerDb);
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
    let parsed: ConversationNotice | null = null;
    try {
      parsed = parse ? parse(notice.body) : null;
    } catch (error) {
      if (!(error instanceof ConversationNoticeError)) throw error;
    }
    // A notice with no event (Zalo's follow or seen): nothing to store.
    if (parsed && parsed.events.length === 0) {
      await finishNotice(deps.workerDb, notice.seq);
      continue;
    }
    if (!parsed) {
      // Not a notice we can read: nothing to retry, so nothing to keep.
      await finishNotice(deps.workerDb, notice.seq);
      out.dropped++;
      log(`dropped notice ${notice.seq} (${notice.provider}): unreadable, ${notice.body.byteLength} bytes`);
      continue;
    }
    let failed = false;
    const targets = (await connectionsFor(deps.workerDb, notice.provider, parsed.accountId)).filter((t) => !parsed.connectionId || t.connectionId === parsed.connectionId);
    // No active connection holds this account (expired, revoked, offboarding, or none): the platforms keep no history to pull, so the
    // notice is gone; the count says so.
    if (targets.length === 0) log(`notice ${notice.seq} (${notice.provider}) names no active connection: dropped after storing nothing`);
    for (const target of targets) {
      try {
        const done = await deps.runtime.execute<{ stored: number }>('kernel.conversation.ingest', { connectionId: target.connectionId, events: parsed.events }, { actor: SYSTEM, orgId: target.orgId });
        out.stored += done.stored;
      } catch (error) {
        // The notice's own fault is logged by its code only; a transient one leaves the notice to its lease.
        if (isPermanent(error)) log(`a ${notice.provider} notice was refused by ingest (${(error as DomainError).code})`);
        else failed = true;
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
async function open(deps: SendDeps, job: ConversationJob): Promise<Opened> {
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

const expire = async (deps: SendDeps, job: ConversationJob, reason: string, version: string): Promise<void> => {
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
  const opened = await open(deps, job);
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
