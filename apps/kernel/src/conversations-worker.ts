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
import { ConversationNoticeError, parseSandboxNotice, type ConversationAdapter, type ConversationNotice } from '@crove/channel';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import type { HideWork, ReplyWork } from '@crove/kernel';

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
};

export interface ClaimedNotice {
  seq: string;
  provider: string;
  body: Buffer | null;
  attempts: number;
  dropped: boolean;
}

export async function claimNotices(workerDb: Db): Promise<ClaimedNotice[]> {
  const { rows } = await sql<{ seq: string; provider: string; body: Buffer | null; attempts: number; dropped: boolean }>`
    SELECT seq::text AS seq, provider, body, attempts, dropped
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
  for (const notice of await claimNotices(deps.workerDb)) {
    if (notice.dropped || notice.body === null) {
      out.dropped++;
      log(`dropped a ${notice.provider} notice after ${notice.attempts} attempts`);
      continue;
    }
    const parse = Object.hasOwn(NOTICE_PARSERS, notice.provider) ? NOTICE_PARSERS[notice.provider] : undefined;
    let parsed: ConversationNotice | null = null;
    try {
      parsed = parse ? parse(notice.body) : null;
    } catch (error) {
      if (!(error instanceof ConversationNoticeError)) throw error;
    }
    if (!parsed) {
      // Not a notice we can read: nothing to retry, so nothing to keep.
      await finishNotice(deps.workerDb, notice.seq);
      out.dropped++;
      log(`dropped an unreadable ${notice.provider} notice of ${notice.body.byteLength} bytes`);
      continue;
    }
    let failed = false;
    for (const target of await connectionsFor(deps.workerDb, notice.provider, parsed.accountId)) {
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
  return out;
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
  const opened = await open(deps, job);
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
