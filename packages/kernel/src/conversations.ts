// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core (issue #2303, plan docs/plan/conversations.md, ADR-0041): comments under the org's posts and private
// messages on a connected channel, in one store, with the commands that take them in and answer them.
//
// Who may do what (the database holds the same rules, crove_kernel.conversation_access):
// - the worker, as the system, takes platform events in (kernel.conversation.ingest) and settles the calls a reply or a hide
//   makes (reply_begin, reply_record, hide_begin, hide_record); the org of an event comes from the stored connection;
// - owners, admins and members read and answer a comment thread of a channel they may use; a viewer only reads; a private
//   message is read and answered only by owners, admins and holders of kernel.conversation.direct.read, and the channel limit
//   (crove_kernel.channel_access) applies to every member; an agent reads and writes none.
//
// A reply is a message (queued) and, before the platform is called, an external_call row written by reply_begin in its own
// transaction and committed first, so a worker that dies mid-call leaves a row that says the call may have gone through. No
// platform send call has an idempotency key, so a send is never repeated by a job: an unknown outcome waits for a person
// (reply_settle). A newer message than the one the sender saw refuses the reply (CONVERSATION_MOVED), which is what keeps two
// people from answering one customer. Hide and unhide are idempotent calls, so a job may repeat them.
//
// Nothing the customer wrote reaches an audit row, an event or a log: those carry ids, counts and lengths (ADR-0037).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import {
  CONVERSATION_CALL_STALE_MS,
  CONVERSATION_PREVIEW_CHARS,
  conversationRules,
  zConversationAssign,
  zConversationCounted,
  zConversationCounts,
  zConversationEraseConnection,
  zConversationEraseContact,
  zConversationGet,
  zConversationHide,
  zConversationId,
  zConversationIngest,
  zConversationLinkContact,
  zConversationList,
  zConversationMarkRead,
  zConversationNoteAdd,
  zConversationPurgeExpired,
  zConversationReply,
  zConversationRetentionSet,
  zConversationSandboxComment,
  zConversationSettle,
  CONVERSATION_RETENTION_DEFAULT_MONTHS,
  type ConversationCounted,
  type ConversationErased,
  type ConversationPurged,
  type ConversationRetention,
  type ConversationDetail,
  type ConversationEvent,
  type ConversationKind,
  type ConversationStatus,
  type ConversationIngested,
  type ConversationListed,
  type ConversationSummary,
} from '@crove/kernel-contract';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const HOUR_MS = 3_600_000;
// The most messages one detail read returns (a thread longer than this shows its latest).
export const CONVERSATION_MESSAGES_MAX = 500;

export const REPLY_QUEUED = 'kernel.conversation.reply_queued';
export const HIDE_QUEUED = 'kernel.conversation.hide_queued';

const requireUser = (ctx: Pick<CommandContext, 'actor'>): string => {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
};
const requireSystem = (ctx: Pick<CommandContext, 'actor'>): void => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
};
const notFound = () => new DomainError('CONVERSATION_NOT_FOUND', 404, 'Không tìm thấy hội thoại này');
const messageNotFound = () => new DomainError('MESSAGE_NOT_FOUND', 404, 'Không tìm thấy tin nhắn này');

interface ConversationRow {
  id: string;
  channel_connection_id: string;
  kind: ConversationKind;
  external_thread_id: string;
  external_post_id: string | null;
  identity_id: string | null;
  party_id: string | null;
  status: ConversationStatus;
  assignee_user_id: string | null;
  last_seq: number;
  last_inbound_at: Date | null;
  last_message_at: Date | null;
  reply_window_until: Date | null;
  resolved_at: Date | null;
}
const CONVERSATION_COLUMNS = [
  'id', 'channel_connection_id', 'kind', 'external_thread_id', 'external_post_id', 'identity_id', 'party_id', 'status',
  'assignee_user_id', 'last_seq', 'last_inbound_at', 'last_message_at', 'reply_window_until', 'resolved_at',
] as const;

// The thread, locked. A thread the caller may not read is not found (row-level security hides it).
async function lockConversation(ctx: CommandContext, conversationId: string): Promise<ConversationRow> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.conversation')
    .select(CONVERSATION_COLUMNS)
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', conversationId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound();
  return row as ConversationRow;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  channel_connection_id: string;
  kind: ConversationKind;
  seq: number;
  direction: string;
  external_message_id: string | null;
  body: string;
  send_state: string | null;
  send_attempt: number;
  hidden_at: Date | null;
  hidden_by: string | null;
  hide_request: string | null;
  hide_attempt: number;
  platform_removed_at: Date | null;
}
const MESSAGE_COLUMNS = [
  'id', 'conversation_id', 'channel_connection_id', 'kind', 'seq', 'direction', 'external_message_id', 'body', 'send_state', 'send_attempt',
  'hidden_at', 'hidden_by', 'hide_request', 'hide_attempt', 'platform_removed_at',
] as const;

async function lockMessage(ctx: CommandContext, messageId: string): Promise<MessageRow> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select(MESSAGE_COLUMNS)
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', messageId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw messageNotFound();
  return row as MessageRow;
}

interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  display_name: string;
  updated_at: Date;
}
async function connectionOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, connectionId: string): Promise<ConnectionRow | null> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select(['id', 'provider', 'status', 'display_name', 'updated_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', connectionId)
    .executeTakeFirst();
  return row ?? null;
}

// A provider's error code as stored on a message and a call row: only a code-shaped value (letters, digits and _ . : -, no space),
// else the fallback. What a platform says in words may name a person, so it never lands in a row (ADR-0037).
const code = (value: string | undefined, fallback: string): string => (value !== undefined && /^[A-Za-z0-9_.:-]{1,60}$/.test(value) ? value : fallback);

const previewOf = (body: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= CONVERSATION_PREVIEW_CHARS ? flat : `${flat.slice(0, CONVERSATION_PREVIEW_CHARS - 1)}…`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------------------------------

// Takes the events of a verified notice into the core, for one connection. Idempotent: a replayed message changes nothing.
// The caller (the worker) found the connection from the platform's own account id, so the org is the connection's.
export const conversationIngest = defineCommand({
  name: 'kernel.conversation.ingest',
  input: zConversationIngest,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<ConversationIngested> => {
    requireSystem(ctx);
    const out: ConversationIngested = { stored: 0, duplicates: 0, ignored: 0 };
    const connection = await connectionOf(ctx, input.connectionId);
    const rules = connection && connection.status === 'active' ? conversationRules(connection.provider) : null;
    if (!connection || !rules) {
      out.ignored = input.events.length;
      ctx.audit({ connection_id: input.connectionId, ...out });
      return out;
    }
    // Oldest first, so a thread's messages take their seq in the order the platform dated them within one notice.
    const events = input.events.map((event, i) => ({ event, i })).sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || a.i - b.i);
    for (const { event } of events) {
      if (!rules.kinds.includes(event.kind)) {
        out.ignored++;
        continue;
      }
      const result = await ingestEvent(ctx, input.connectionId, connection.provider, rules.windowHours, event);
      out[result]++;
    }
    ctx.audit({ connection_id: input.connectionId, ...out });
    return out;
  },
});

async function ingestEvent(ctx: CommandContext, connectionId: string, provider: string, windowHours: number | null, event: ConversationEvent): Promise<'stored' | 'duplicates' | 'ignored'> {
  const existing = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select(['id', 'body', 'platform_removed_at'])
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('external_message_id', '=', event.messageId)
    .executeTakeFirst();
  if (existing) {
    // The platform says it was removed: the body goes (plan section 10), once.
    if (event.removed && !existing.platform_removed_at) {
      await ctx.trx
        .updateTable('crove_kernel.conversation_message')
        .set({ body: '', attachments: sql`'{}'::uuid[]`, platform_removed_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    }
    return 'duplicates';
  }
  // A customer erased at the org's request: nothing of theirs dated at or before the erasure comes back (a replayed body, a redelivery,
  // a removal notice). The tombstone is the identity row an erasure leaves, found by the keyed hash of the platform's user id.
  const hashed = await sql<{ h: string }>`SELECT crove_kernel.conversation_identity_hash(${provider}, ${event.contact.id}) AS h`.execute(ctx.trx);
  const tomb = await ctx.trx
    .selectFrom('crove_kernel.conversation_identity')
    .select('erased_at')
    .where('org_id', '=', ctx.orgId)
    .where('provider', '=', provider)
    .where('external_user_id', '=', `erased:${hashed.rows[0]?.h ?? ''}`)
    .executeTakeFirst();
  if (tomb?.erased_at && new Date(event.at).getTime() <= tomb.erased_at.getTime()) return 'ignored';

  // A removal of a message never seen: a blank tombstone takes the message's id, so the add that arrives later (the platform does not
  // order its notices) finds it and never stores the body.
  if (event.removed) {
    const findThread = async () =>
      (await ctx.trx
        .selectFrom('crove_kernel.conversation')
        .select(CONVERSATION_COLUMNS)
        .where('org_id', '=', ctx.orgId)
        .where('channel_connection_id', '=', connectionId)
        .where('kind', '=', event.kind)
        .where('external_thread_id', '=', event.threadId)
        .forUpdate()
        .executeTakeFirst()) as ConversationRow | undefined;
    const who = await ctx.trx
      .insertInto('crove_kernel.conversation_identity')
      .values({ org_id: ctx.orgId, provider, external_user_id: event.contact.id, display_name: event.contact.name ?? null, created_at: ctx.now, updated_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'provider', 'external_user_id']).doUpdateSet({ updated_at: ctx.now }))
      .returning(['id'])
      .executeTakeFirstOrThrow();
    let thread = await findThread();
    if (!thread) {
      // No thread yet: it is made, already resolved (a thread of one removed message needs no answer), so the add that arrives later
      // finds the tombstone and the body is never stored. A later real message reopens it as usual.
      await ctx.trx
        .insertInto('crove_kernel.conversation')
        .values({
          org_id: ctx.orgId,
          channel_connection_id: connectionId,
          kind: event.kind,
          external_thread_id: event.threadId,
          external_post_id: event.postId ?? null,
          identity_id: who.id,
          status: 'resolved',
          resolved_at: ctx.now,
          opened_at: ctx.now,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'kind', 'external_thread_id']).doNothing())
        .execute();
      thread = await findThread();
    }
    if (!thread) return 'ignored';
    const next = thread.last_seq + 1;
    await ctx.trx
      .insertInto('crove_kernel.conversation_message')
      .values({
        org_id: ctx.orgId,
        conversation_id: thread.id,
        channel_connection_id: connectionId,
        kind: event.kind,
        seq: next,
        direction: event.direction,
        external_message_id: event.messageId,
        sent_at: new Date(event.at),
        received_at: ctx.now,
        author_kind: event.direction === 'in' ? 'contact' : 'system',
        body: '',
        send_state: event.direction === 'in' ? null : 'sent',
        tainted: event.direction === 'in',
        platform_removed_at: ctx.now,
        author_identity_id: event.direction === 'in' ? who.id : null,
      })
      .execute();
    await ctx.trx.updateTable('crove_kernel.conversation').set({ last_seq: next, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', thread.id).execute();
    return 'stored';
  }

  const identity = await ctx.trx
    .insertInto('crove_kernel.conversation_identity')
    .values({ org_id: ctx.orgId, provider, external_user_id: event.contact.id, display_name: event.contact.name ?? null, created_at: ctx.now, updated_at: ctx.now })
    .onConflict((oc) =>
      oc.columns(['org_id', 'provider', 'external_user_id']).doUpdateSet({
        display_name: sql<string | null>`COALESCE(excluded.display_name, crove_kernel.conversation_identity.display_name)`,
        updated_at: ctx.now,
      }),
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();

  // The thread, made on first sight. A person's link of this customer's other threads of the same kind (never of the other kind: a
  // private message's contact is not shown on a public comment) brings its party to the new thread.
  const linked = await ctx.trx
    .selectFrom('crove_kernel.conversation')
    .select('party_id')
    .where('org_id', '=', ctx.orgId)
    .where('identity_id', '=', identity.id)
    .where('kind', '=', event.kind)
    .where('party_id', 'is not', null)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  await ctx.trx
    .insertInto('crove_kernel.conversation')
    .values({
      org_id: ctx.orgId,
      channel_connection_id: connectionId,
      kind: event.kind,
      external_thread_id: event.threadId,
      external_post_id: event.postId ?? null,
      identity_id: identity.id,
      party_id: linked?.party_id ?? null,
      status: 'new',
      opened_at: ctx.now,
      created_at: ctx.now,
      updated_at: ctx.now,
    })
    .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'kind', 'external_thread_id']).doNothing())
    .execute();
  const conversation = (await ctx.trx
    .selectFrom('crove_kernel.conversation')
    .select(CONVERSATION_COLUMNS)
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('kind', '=', event.kind)
    .where('external_thread_id', '=', event.threadId)
    .forUpdate()
    .executeTakeFirstOrThrow()) as ConversationRow;

  // The same message may have been stored by a notice redelivered at the same time, between the first check and this lock.
  const again = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('external_message_id', '=', event.messageId)
    .executeTakeFirst();
  if (again) return 'duplicates';

  const sentAt = new Date(event.at);
  // The org's own message seen from the platform's inbox: a reply of ours still being sent takes the platform's id, else it
  // is a message written outside Crove.
  if (event.direction === 'out') {
    const ours = await ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select(['id', 'send_attempt'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', conversation.id)
      .where('direction', '=', 'out')
      .where('send_state', 'in', ['sending', 'unknown'])
      .where('body', '=', event.text)
      .where('external_message_id', 'is', null)
      // An echo belongs to the reply it follows: not one stored after the platform dated the echo (clock skew aside), nor one
      // queued more than a day before it.
      .where('received_at', '<=', new Date(sentAt.getTime() + 5 * 60_000))
      .where('received_at', '>=', new Date(sentAt.getTime() - 24 * HOUR_MS))
      .orderBy('seq')
      .limit(1)
      .executeTakeFirst();
    if (ours) {
      await ctx.trx
        .updateTable('crove_kernel.conversation_message')
        .set({ external_message_id: event.messageId, send_state: 'sent', send_error_code: null, sent_at: sentAt })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', ours.id)
        .execute();
      // The platform has the message, so the call that may or may not have gone through did: nothing is left unfinished or ambiguous.
      await ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ state: 'succeeded', finished_at: ctx.now, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', replyCallKey(ours.id, ours.send_attempt))
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
      return 'stored';
    }
  }

  const seq = conversation.last_seq + 1;
  await ctx.trx
    .insertInto('crove_kernel.conversation_message')
    .values({
      org_id: ctx.orgId,
      conversation_id: conversation.id,
      channel_connection_id: connectionId,
      kind: event.kind,
      seq,
      direction: event.direction,
      external_message_id: event.messageId,
      sent_at: sentAt,
      received_at: ctx.now,
      author_kind: event.direction === 'in' ? 'contact' : 'system',
      body: event.text,
      author_identity_id: event.direction === 'in' ? identity.id : null,
      send_state: event.direction === 'in' ? null : 'sent',
      // A customer's text is tainted external text; the org's own message seen as an echo is its own.
      tainted: event.direction === 'in',
    })
    .execute();

  const inbound = event.direction === 'in';
  const newest = conversation.last_message_at && conversation.last_message_at.getTime() > sentAt.getTime() ? conversation.last_message_at : sentAt;
  const lastInbound = inbound && (!conversation.last_inbound_at || conversation.last_inbound_at.getTime() < sentAt.getTime()) ? sentAt : conversation.last_inbound_at;
  // A customer's new message reopens the thread as new; the org's own message from the platform's inbox answers it.
  // A customer message the platform dated before the thread was resolved does not reopen it.
  const predatesResolution = inbound && conversation.status === 'resolved' && conversation.resolved_at !== null && sentAt.getTime() <= conversation.resolved_at.getTime();
  const status = inbound ? (predatesResolution ? 'resolved' : 'new') : conversation.status === 'new' ? 'pending' : conversation.status;
  await ctx.trx
    .updateTable('crove_kernel.conversation')
    .set({
      last_seq: seq,
      last_message_at: newest,
      last_inbound_at: lastInbound,
      reply_window_until: lastInbound && windowHours !== null ? new Date(lastInbound.getTime() + windowHours * HOUR_MS) : conversation.reply_window_until,
      status,
      // A thread that stays resolved (the org's own message seen from the platform) keeps who resolved it and when.
      ...(status === 'resolved' ? {} : { resolved_at: null, resolved_by: null }),
      updated_at: ctx.now,
    })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', conversation.id)
    .execute();
  return 'stored';
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  kind: string;
  status: string;
  channel_connection_id: string;
  provider: string;
  channel_name: string;
  external_post_id: string | null;
  identity_id: string | null;
  identity_name: string | null;
  external_user_id: string | null;
  party_id: string | null;
  party_name: string | null;
  assignee_user_id: string | null;
  last_seq: number;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  reply_window_until: Date | null;
  preview: string | null;
  read_seq: number | null;
}

// The summary columns of a thread with its channel, customer, party, last message and the viewer's read mark. Row-level
// security decides which threads exist for the viewer.
const summarySelect = (orgId: string, viewer: string | null) => sql`
  SELECT c.id, c.kind, c.status, c.channel_connection_id, ch.provider, ch.display_name AS channel_name, c.external_post_id,
         c.identity_id, i.display_name AS identity_name, i.external_user_id, c.party_id, p.name AS party_name,
         c.assignee_user_id, c.last_seq, c.last_message_at, c.last_inbound_at, c.reply_window_until,
         (SELECT m.body FROM crove_kernel.conversation_message m
          WHERE m.org_id = c.org_id AND m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS preview,
         r.last_read_seq AS read_seq
  FROM crove_kernel.conversation c
  JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.channel_connection_id
  LEFT JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id
  LEFT JOIN crove_kernel.party p ON p.org_id = c.org_id AND p.id = c.party_id
  LEFT JOIN crove_kernel.conversation_read r ON r.org_id = c.org_id AND r.conversation_id = c.id AND r.user_id = ${viewer}::uuid
  WHERE c.org_id = ${orgId}::uuid`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toSummary(row: SummaryRow): ConversationSummary {
  const tail = row.external_user_id ? row.external_user_id.slice(-4) : '';
  return {
    id: row.id,
    kind: row.kind as ConversationSummary['kind'],
    status: row.status as ConversationSummary['status'],
    channel: { connectionId: row.channel_connection_id, provider: row.provider, displayName: row.channel_name },
    postId: row.external_post_id,
    contact: { identityId: row.identity_id, displayName: row.identity_name, idTail: tail, partyId: row.party_id, partyName: row.party_name },
    assigneeUserId: row.assignee_user_id,
    lastSeq: row.last_seq,
    lastMessageAt: iso(row.last_message_at),
    lastInboundAt: iso(row.last_inbound_at),
    replyWindowUntil: iso(row.reply_window_until),
    preview: previewOf(row.preview ?? ''),
    unread: row.last_seq > (row.read_seq ?? 0),
  };
}

const viewerOf = (ctx: Pick<QueryContext, 'actor'>): string | null => (ctx.actor.type === 'user' ? ctx.actor.userId : null);

export const conversationList = defineQuery({
  name: 'kernel.conversation.list',
  input: zConversationList,
  access: ALL,
  handler: async (ctx, input): Promise<ConversationListed> => {
    const me = viewerOf(ctx);
    const where = [sql`TRUE`];
    if (input.status) where.push(sql`c.status = ${input.status}`);
    if (input.kind) where.push(sql`c.kind = ${input.kind}`);
    if (input.connectionId) where.push(sql`c.channel_connection_id = ${input.connectionId}::uuid`);
    if (input.assignee === 'me') where.push(sql`c.assignee_user_id = ${me}::uuid`);
    if (input.assignee === 'none') where.push(sql`c.assignee_user_id IS NULL`);
    if (input.posts) {
      const pairs = input.posts.map((p) => sql`(c.channel_connection_id = ${p.connectionId}::uuid AND c.external_post_id = ${p.externalPostId})`);
      where.push(sql`(${sql.join(pairs, sql` OR `)})`);
    }
    if (input.before) {
      // Newest first, threads with no message last: the key is (last_message_at, id) descending with nulls last.
      where.push(
        input.before.at === null
          ? sql`(c.last_message_at IS NULL AND c.id < ${input.before.id}::uuid)`
          : sql`(c.last_message_at IS NULL OR c.last_message_at < ${input.before.at}::timestamptz OR (c.last_message_at = ${input.before.at}::timestamptz AND c.id < ${input.before.id}::uuid))`,
      );
    }
    const { rows } = await sql<SummaryRow>`${summarySelect(ctx.orgId, me)} AND ${sql.join(where, sql` AND `)}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ${input.limit + 1}`.execute(ctx.trx);
    const more = rows.length > input.limit;
    return { conversations: rows.slice(0, input.limit).map(toSummary), more };
  },
});

export const conversationCounts = defineQuery({
  name: 'kernel.conversation.counts',
  input: zConversationCounts,
  access: ALL,
  handler: async (ctx, input): Promise<ConversationCounted> => {
    const me = viewerOf(ctx);
    const filters = [sql`c.org_id = ${ctx.orgId}::uuid`];
    if (input.kind) filters.push(sql`c.kind = ${input.kind}`);
    if (input.connectionId) filters.push(sql`c.channel_connection_id = ${input.connectionId}::uuid`);
    if (input.posts) {
      const pairs = input.posts.map((p) => sql`(c.channel_connection_id = ${p.connectionId}::uuid AND c.external_post_id = ${p.externalPostId})`);
      filters.push(sql`(${sql.join(pairs, sql` OR `)})`);
    }
    const { rows } = await sql<{ status: string; n: string; unread: string }>`
      SELECT c.status, count(*)::text AS n, count(*) FILTER (WHERE c.last_seq > COALESCE(r.last_read_seq, 0))::text AS unread
      FROM crove_kernel.conversation c
      LEFT JOIN crove_kernel.conversation_read r ON r.org_id = c.org_id AND r.conversation_id = c.id AND r.user_id = ${me}::uuid
      WHERE ${sql.join(filters, sql` AND `)} GROUP BY c.status`.execute(ctx.trx);
    const counted: ConversationCounted = { new: 0, pending: 0, resolved: 0, unread: 0 };
    for (const row of rows) {
      if (row.status === 'new' || row.status === 'pending' || row.status === 'resolved') counted[row.status] = Number(row.n);
      counted.unread += Number(row.unread);
    }
    return zConversationCounted.parse(counted);
  },
});

export const conversationGet = defineQuery({
  name: 'kernel.conversation.get',
  input: zConversationGet,
  access: ALL,
  handler: async (ctx, input): Promise<ConversationDetail> => {
    const me = viewerOf(ctx);
    const { rows } = await sql<SummaryRow>`${summarySelect(ctx.orgId, me)} AND c.id = ${input.conversationId}::uuid`.execute(ctx.trx);
    const row = rows[0];
    if (!row) throw notFound();
    const messages = await ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select(['id', 'seq', 'direction', 'author_kind', 'author_user_id', 'body', 'attachments', 'sent_at', 'send_state', 'send_error_code', 'hidden_at', 'hide_request', 'hide_error_code', 'platform_removed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', input.conversationId)
      .orderBy('seq', 'desc')
      .limit(CONVERSATION_MESSAGES_MAX)
      .execute();
    const notes = await ctx.trx
      .selectFrom('crove_kernel.conversation_note')
      .select(['id', 'author_user_id', 'body', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', input.conversationId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const parent = await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .select(['parent_conversation_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.conversationId)
      .executeTakeFirst();
    let parentId: string | null = null;
    if (parent?.parent_conversation_id) {
      // The parent only when the reader may see it (row-level security).
      const seen = await ctx.trx.selectFrom('crove_kernel.conversation').select('id').where('org_id', '=', ctx.orgId).where('id', '=', parent.parent_conversation_id).executeTakeFirst();
      parentId = seen?.id ?? null;
    }
    const conversation = toSummary(row);
    const connection = await connectionOf(ctx, row.channel_connection_id);
    const rules = connection ? conversationRules(connection.provider) : null;
    let reason: ConversationDetail['reply']['reason'] = null;
    if (!connection || connection.status !== 'active') reason = 'channel_inactive';
    else if (!rules || !rules.kinds.includes(row.kind as ConversationKind)) reason = 'not_supported';
    else if (row.reply_window_until && row.reply_window_until.getTime() < Date.now()) reason = 'window_closed';
    return {
      conversation,
      // Oldest first on screen.
      messages: messages
        .reverse()
        .map((m) => ({
          id: m.id,
          seq: m.seq,
          direction: m.direction as 'in' | 'out',
          authorKind: m.author_kind as 'contact' | 'member' | 'system',
          authorUserId: m.author_user_id,
          body: m.body,
          attachments: m.attachments,
          sentAt: m.sent_at.toISOString(),
          sendState: m.send_state as ConversationDetail['messages'][number]['sendState'],
          sendErrorCode: m.send_error_code,
          hidden: m.hidden_at !== null,
          hideRequest: m.hide_request as ConversationDetail['messages'][number]['hideRequest'],
          hideErrorCode: m.hide_error_code,
          removed: m.platform_removed_at !== null,
        })),
      notes: notes.map((n) => ({ id: n.id, authorUserId: n.author_user_id, body: n.body, createdAt: n.created_at.toISOString() })),
      parentId,
      reply: { allowed: reason === null, reason },
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------------------------------------------------

// Marks a thread read by its viewer up to a seq (never backwards, never past the last message).
async function markRead(ctx: CommandContext, conversationId: string, userId: string, seq: number): Promise<void> {
  await ctx.trx
    .insertInto('crove_kernel.conversation_read')
    .values({ org_id: ctx.orgId, conversation_id: conversationId, user_id: userId, last_read_seq: seq, updated_at: ctx.now })
    .onConflict((oc) =>
      oc.columns(['org_id', 'conversation_id', 'user_id']).doUpdateSet({
        last_read_seq: sql<number>`GREATEST(crove_kernel.conversation_read.last_read_seq, excluded.last_read_seq)`,
        updated_at: ctx.now,
      }),
    )
    .execute();
}

export const conversationReply = defineCommand({
  name: 'kernel.conversation.reply',
  input: zConversationReply,
  // Visible to the customer, through a platform call the worker makes after this commits (an effect outside Crove).
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ messageId: string; seq: number }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    const connection = await connectionOf(ctx, conversation.channel_connection_id);
    if (!connection || connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    const rules = conversationRules(connection.provider);
    if (!rules || !rules.kinds.includes(conversation.kind)) throw new DomainError('REPLY_NOT_SUPPORTED', 409, 'Kênh này chưa hỗ trợ trả lời tại đây');
    if (input.body.length > rules.replyMax) throw new DomainError('REPLY_TOO_LONG', 422, `Câu trả lời dài tối đa ${rules.replyMax} ký tự`, { max: String(rules.replyMax) });
    if (conversation.reply_window_until && conversation.reply_window_until.getTime() < ctx.now.getTime()) {
      throw new DomainError('REPLY_WINDOW_CLOSED', 409, 'Đã quá thời gian nền tảng cho phép trả lời cuộc trò chuyện này');
    }
    // The guarantee against two people answering one customer: a message newer than the one the sender saw.
    if (input.lastSeenSeq !== conversation.last_seq) {
      throw new DomainError('CONVERSATION_MOVED', 409, 'Hội thoại vừa có tin mới, hãy đọc lại trước khi trả lời', { lastSeq: String(conversation.last_seq) });
    }
    const seq = conversation.last_seq + 1;
    const message = await ctx.trx
      .insertInto('crove_kernel.conversation_message')
      .values({
        org_id: ctx.orgId,
        conversation_id: conversation.id,
        channel_connection_id: conversation.channel_connection_id,
        kind: conversation.kind,
        seq,
        direction: 'out',
        sent_at: ctx.now,
        received_at: ctx.now,
        author_kind: 'member',
        author_user_id: me,
        body: input.body,
        send_state: 'queued',
        send_attempt: 1,
        tainted: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('crove_kernel.conversation')
      .set({
        last_seq: seq,
        last_message_at: ctx.now,
        status: 'pending',
        resolved_at: null,
        resolved_by: null,
        // Answering a thread nobody holds takes it; one held by another stays theirs.
        assignee_user_id: conversation.assignee_user_id ?? me,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', conversation.id)
      .execute();
    await markRead(ctx, conversation.id, me, seq);
    await ctx.emit(REPLY_QUEUED, { conversationId: conversation.id, messageId: message.id, connectionId: conversation.channel_connection_id });
    ctx.audit({ conversation_id: conversation.id, message_id: message.id, length: input.body.length });
    return { messageId: message.id, seq };
  },
});

export interface ReplyWork {
  action: 'none' | 'call';
  reason?: 'in_flight' | 'settled' | 'channel_inactive';
  messageId?: string;
  callKey?: string;
  provider?: string;
  connectionId?: string;
  connectionVersion?: string;
  kind?: 'comment_thread' | 'direct';
  threadId?: string;
  postId?: string | null;
  contactId?: string;
  text?: string;
}

const replyCallKey = (messageId: string, attempt: number): string => `conversation.reply:${messageId}:${attempt}`;

// A call a worker began and never finished is a person's to settle after this long: the message says so (unknown).
async function staleCall(ctx: CommandContext, key: string): Promise<boolean> {
  const call = await ctx.trx
    .selectFrom('crove_kernel.external_call')
    .select(['state', 'started_at'])
    .where('org_id', '=', ctx.orgId)
    .where('key', '=', key)
    .executeTakeFirst();
  return !call || (call.state === 'started' && ctx.now.getTime() - call.started_at.getTime() > CONVERSATION_CALL_STALE_MS);
}

// Decides whether the worker sends a reply now, and records the call as started first (committed before the platform is
// called). A message already being sent, or settled, is not sent again.
export const conversationReplyBegin = defineCommand({
  name: 'kernel.conversation.reply_begin',
  input: z.strictObject({ messageId: zId }),
  // Commits the call as started; the worker then makes it, an effect outside Crove.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<ReplyWork> => {
    requireSystem(ctx);
    const message = await lockMessage(ctx, input.messageId);
    if (message.direction !== 'out') return { action: 'none', reason: 'settled' };
    if (message.send_state === 'sending') {
      if (await staleCall(ctx, replyCallKey(message.id, message.send_attempt))) {
        await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'unknown', send_error_code: 'WORKER_LOST' }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
        await ctx.trx
          .updateTable('crove_kernel.external_call')
          .set({ state: 'ambiguous', error_kind: 'unknown', error_code: 'WORKER_LOST', updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('key', '=', replyCallKey(message.id, message.send_attempt))
          .where('state', '=', 'started')
          .execute();
        return { action: 'none', reason: 'settled' };
      }
      return { action: 'none', reason: 'in_flight' };
    }
    if (message.send_state !== 'queued') return { action: 'none', reason: 'settled' };
    const connection = await connectionOf(ctx, message.channel_connection_id);
    if (!connection || connection.status !== 'active' || !conversationRules(connection.provider)) {
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'failed', send_error_code: 'CHANNEL_NOT_ACTIVE' }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      return { action: 'none', reason: 'channel_inactive' };
    }
    const conversation = await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .innerJoin('crove_kernel.conversation_identity as i', (join) => join.onRef('i.org_id', '=', 'crove_kernel.conversation.org_id').onRef('i.id', '=', 'crove_kernel.conversation.identity_id'))
      .select(['crove_kernel.conversation.external_thread_id as thread', 'crove_kernel.conversation.external_post_id as post', 'i.external_user_id as contact'])
      .where('crove_kernel.conversation.org_id', '=', ctx.orgId)
      .where('crove_kernel.conversation.id', '=', message.conversation_id)
      .executeTakeFirst();
    if (!conversation) {
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'failed', send_error_code: 'NO_CONTACT' }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      return { action: 'none', reason: 'settled' };
    }
    const callKey = replyCallKey(message.id, message.send_attempt);
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'kernel', target: connection.provider, step: 'reply', retry_safety: 'reconcile_only', started_at: ctx.now })
      .execute();
    await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'sending', send_error_code: null }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
    ctx.audit({ message_id: message.id, attempt: message.send_attempt });
    return {
      action: 'call',
      messageId: message.id,
      callKey,
      provider: connection.provider,
      connectionId: connection.id,
      connectionVersion: connection.updated_at.toISOString(),
      kind: message.kind,
      threadId: conversation.thread,
      postId: conversation.post,
      contactId: conversation.contact,
      text: message.body,
    };
  },
});

const zErrorKind = z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']);
// What a call row is set to once its outcome is known (external_call's own columns).
interface CallSet {
  state: 'succeeded' | 'failed' | 'ambiguous' | 'started';
  error_kind?: z.infer<typeof zErrorKind> | 'unknown';
  error_code?: string;
  external_ref?: string;
}
const zCallResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(300) }),
  z.strictObject({ kind: z.literal('rejected'), error: zErrorKind, code: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: z.string().max(200).optional() }),
]);

// Stores what the platform answered for a reply; an answer for a call that is no longer the message's current one changes
// nothing.
export const conversationReplyRecord = defineCommand({
  name: 'kernel.conversation.reply_record',
  input: z.strictObject({ messageId: zId, callKey: z.string().min(1).max(300), result: zCallResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<{ state: string }> => {
    requireSystem(ctx);
    const message = await lockMessage(ctx, input.messageId);
    const current = replyCallKey(message.id, message.send_attempt);
    const { result } = input;
    // The echo of the message may have settled it already; a stale call's answer is ignored.
    if (input.callKey !== current) return { state: message.send_state ?? 'none' };
    if (message.send_state === 'sent') {
      await ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ state: 'succeeded', finished_at: ctx.now, updated_at: ctx.now, ...(result.kind === 'accepted' ? { external_ref: result.externalId } : {}) })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', current)
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
      return { state: 'sent' };
    }
    // A worker slower than the stale limit may answer after its message was marked unclear: an accepted answer for the current call
    // still means it went out, so a person is not asked to send it again.
    if (message.send_state !== 'sending' && !(message.send_state === 'unknown' && result.kind === 'accepted')) return { state: message.send_state ?? 'none' };
    const call = (set: CallSet) =>
      ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ ...set, ...(set.state === 'succeeded' || set.state === 'failed' ? { finished_at: ctx.now } : {}), updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', current)
        .execute();
    if (result.kind === 'accepted') {
      // The platform's id may already belong to a message the echo stored first.
      const clash = await ctx.trx
        .selectFrom('crove_kernel.conversation_message')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('channel_connection_id', '=', message.channel_connection_id)
        .where('external_message_id', '=', result.externalId)
        .executeTakeFirst();
      await ctx.trx
        .updateTable('crove_kernel.conversation_message')
        .set({ send_state: 'sent', send_error_code: null, ...(clash ? {} : { external_message_id: result.externalId }) })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', message.id)
        .execute();
      await call({ state: 'succeeded', external_ref: result.externalId });
      return { state: 'sent' };
    }
    if (result.kind === 'rejected') {
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'failed', send_error_code: code(result.code, result.error.toUpperCase()) }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      await call({ state: 'failed', error_kind: result.error, error_code: code(result.code, result.error) });
      return { state: 'failed' };
    }
    await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'unknown', send_error_code: code(result.code, 'UNKNOWN') }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
    await call({ state: 'ambiguous', error_kind: 'unknown', error_code: code(result.code, 'unknown') });
    return { state: 'unknown' };
  },
});

// A person settles a reply the platform refused or left unclear: send it again as a new attempt (for an unclear one, the
// person has looked on the platform and found it did not go out), or record that it did go out.
export const conversationReplySettle = defineCommand({
  name: 'kernel.conversation.reply_settle',
  input: zConversationSettle,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<{ messageId: string; state: string }> => {
    requireUser(ctx);
    const message = await lockMessage(ctx, input.messageId);
    if (message.direction !== 'out' || (message.send_state !== 'failed' && message.send_state !== 'unknown')) {
      throw new DomainError('MESSAGE_NOT_SETTLEABLE', 409, 'Tin nhắn này không cần xử lý thêm');
    }
    if (input.action === 'mark_sent') {
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ send_state: 'sent', send_error_code: null }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      await ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ state: 'succeeded', finished_at: ctx.now, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', replyCallKey(message.id, message.send_attempt))
        .where('state', '=', 'ambiguous')
        .execute();
      ctx.audit({ message_id: message.id, action: 'mark_sent' });
      return { messageId: message.id, state: 'sent' };
    }
    const connection = await connectionOf(ctx, message.channel_connection_id);
    if (!connection || connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    const thread = await ctx.trx.selectFrom('crove_kernel.conversation').select(['reply_window_until', 'last_seq']).where('org_id', '=', ctx.orgId).where('id', '=', message.conversation_id).executeTakeFirst();
    // The same rule as a new reply: a newer message means the customer's words changed what is worth saying, so an earlier reply is not
    // sent after it; a person writes a new one.
    if (thread && thread.last_seq > message.seq) throw new DomainError('CONVERSATION_MOVED', 409, 'Hội thoại vừa có tin mới nên chưa gửi lại. Hãy đọc tin mới rồi viết câu trả lời mới');
    if (thread?.reply_window_until && thread.reply_window_until.getTime() < ctx.now.getTime()) throw new DomainError('REPLY_WINDOW_CLOSED', 409, 'Đã quá thời gian nền tảng cho phép trả lời cuộc trò chuyện này');
    await ctx.trx
      .updateTable('crove_kernel.conversation_message')
      .set({ send_state: 'queued', send_attempt: message.send_attempt + 1, send_error_code: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', message.id)
      .execute();
    await ctx.emit(REPLY_QUEUED, { conversationId: message.conversation_id, messageId: message.id, connectionId: message.channel_connection_id });
    ctx.audit({ message_id: message.id, action: 'retry', attempt: message.send_attempt + 1 });
    return { messageId: message.id, state: 'queued' };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Hiding a comment
// ---------------------------------------------------------------------------------------------------------------------

export const conversationHide = defineCommand({
  name: 'kernel.conversation.hide',
  input: zConversationHide,
  // Hides or shows the comment on the platform, through a call the worker makes after this commits.
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<{ messageId: string }> => {
    const me = requireUser(ctx);
    const message = await lockMessage(ctx, input.messageId);
    if (message.kind !== 'comment_thread' || message.direction !== 'in' || message.platform_removed_at) throw new DomainError('HIDE_NOT_SUPPORTED', 409, 'Chỉ ẩn được bình luận của khách');
    const connection = await connectionOf(ctx, message.channel_connection_id);
    if (!connection || connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    if (!conversationRules(connection.provider)?.canHide) throw new DomainError('HIDE_NOT_SUPPORTED', 409, 'Kênh này chưa hỗ trợ ẩn bình luận');
    const already = input.hidden ? message.hidden_at !== null : message.hidden_at === null;
    if (already && message.hide_request === null) return { messageId: message.id };
    await ctx.trx
      .updateTable('crove_kernel.conversation_message')
      .set({ hide_request: input.hidden ? 'hide' : 'unhide', hide_attempt: message.hide_attempt + 1, hide_error_code: null, hidden_by: input.hidden ? me : message.hidden_by })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', message.id)
      .execute();
    await ctx.emit(HIDE_QUEUED, { conversationId: message.conversation_id, messageId: message.id, connectionId: message.channel_connection_id });
    ctx.audit({ message_id: message.id, hidden: input.hidden });
    return { messageId: message.id };
  },
});

export interface HideWork {
  action: 'none' | 'call';
  messageId?: string;
  callKey?: string;
  provider?: string;
  connectionId?: string;
  connectionVersion?: string;
  externalMessageId?: string;
  hidden?: boolean;
}

const hideCallKey = (messageId: string, attempt: number): string => `conversation.hide:${messageId}:${attempt}`;

// Records the hide call as started (or, for a call made again, one more time: hiding is idempotent on the platform).
export const conversationHideBegin = defineCommand({
  name: 'kernel.conversation.hide_begin',
  input: z.strictObject({ messageId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<HideWork> => {
    requireSystem(ctx);
    const message = await lockMessage(ctx, input.messageId);
    if (!message.hide_request || !message.external_message_id) return { action: 'none' };
    const connection = await connectionOf(ctx, message.channel_connection_id);
    if (!connection || connection.status !== 'active') {
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ hide_request: null, hide_error_code: 'CHANNEL_NOT_ACTIVE', hidden_by: message.hidden_at ? message.hidden_by : null }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      return { action: 'none' };
    }
    const callKey = hideCallKey(message.id, message.hide_attempt);
    const call = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'calls']).where('org_id', '=', ctx.orgId).where('key', '=', callKey).executeTakeFirst();
    if (!call) {
      await ctx.trx
        .insertInto('crove_kernel.external_call')
        .values({ org_id: ctx.orgId, key: callKey, module: 'kernel', target: connection.provider, step: 'hide', retry_safety: 'idempotent', started_at: ctx.now })
        .execute();
    } else if (call.state === 'started' || call.state === 'ambiguous') {
      // Made again: the same hide, which the platform treats as one.
      await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'started', calls: call.calls + 1, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', call.id).execute();
    } else {
      return { action: 'none' };
    }
    return {
      action: 'call',
      messageId: message.id,
      callKey,
      provider: connection.provider,
      connectionId: connection.id,
      connectionVersion: connection.updated_at.toISOString(),
      externalMessageId: message.external_message_id,
      hidden: message.hide_request === 'hide',
    };
  },
});

const zHideResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done') }),
  z.strictObject({ kind: z.literal('rejected'), error: zErrorKind, code: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: z.string().max(200).optional() }),
]);

export const conversationHideRecord = defineCommand({
  name: 'kernel.conversation.hide_record',
  input: z.strictObject({ messageId: zId, callKey: z.string().min(1).max(300), result: zHideResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<{ state: string }> => {
    requireSystem(ctx);
    const message = await lockMessage(ctx, input.messageId);
    if (!message.hide_request || input.callKey !== hideCallKey(message.id, message.hide_attempt)) return { state: 'stale' };
    const { result } = input;
    const settle = (set: CallSet) =>
      ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ ...set, ...(set.state === 'succeeded' || set.state === 'failed' ? { finished_at: ctx.now } : {}), updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', input.callKey)
        .where('state', 'in', ['started', 'ambiguous'])
        .execute();
    if (result.kind === 'done') {
      const hide = message.hide_request === 'hide';
      await ctx.trx
        .updateTable('crove_kernel.conversation_message')
        .set({ hidden_at: hide ? ctx.now : null, hidden_by: hide ? message.hidden_by : null, hide_request: null, hide_error_code: null })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', message.id)
        .execute();
      await settle({ state: 'succeeded' });
      return { state: hide ? 'hidden' : 'visible' };
    }
    if (result.kind === 'unknown') {
      // Left requested: the job asks again (the same call, which is safe); after its last try a person asks again.
      await ctx.trx.updateTable('crove_kernel.conversation_message').set({ hide_error_code: code(result.code, 'UNKNOWN') }).where('org_id', '=', ctx.orgId).where('id', '=', message.id).execute();
      await settle({ state: 'ambiguous', error_kind: 'unknown', error_code: code(result.code, 'unknown') });
      return { state: 'unknown' };
    }
    const failure = code(result.code, result.error.toUpperCase());
    await ctx.trx
      .updateTable('crove_kernel.conversation_message')
      .set({ hide_request: null, hide_error_code: failure, hidden_by: message.hidden_at ? message.hidden_by : null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', message.id)
      .execute();
    await settle({ state: 'failed', error_kind: result.error, error_code: failure });
    return { state: 'failed' };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Working a thread
// ---------------------------------------------------------------------------------------------------------------------

// Whether this member may take a thread: a member who is not a viewer, of an org's thread they could read (a limited member
// only on their channels; a private message only owners and admins until the Service role exists).
async function mayAssign(ctx: CommandContext, conversation: ConversationRow, userId: string): Promise<boolean> {
  const member = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
  if (!member || member.role === 'viewer') return false;
  if (member.role === 'owner' || member.role === 'admin') return true;
  if (conversation.kind === 'direct') return false;
  const rows = await ctx.trx.selectFrom('crove_kernel.channel_access').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
  return rows.length === 0 || rows.some((r) => r.channel_connection_id === conversation.channel_connection_id);
}

export const conversationAssign = defineCommand({
  name: 'kernel.conversation.assign',
  input: zConversationAssign,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ conversationId: string }> => {
    requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    if (input.assigneeUserId && !(await mayAssign(ctx, conversation, input.assigneeUserId))) {
      throw new DomainError('ASSIGNEE_NOT_ALLOWED', 422, 'Người này không xử lý được hội thoại này');
    }
    await ctx.trx.updateTable('crove_kernel.conversation').set({ assignee_user_id: input.assigneeUserId, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', conversation.id).execute();
    ctx.audit({ conversation_id: conversation.id, assigned: input.assigneeUserId !== null });
    return { conversationId: conversation.id };
  },
});

export const conversationResolve = defineCommand({
  name: 'kernel.conversation.resolve',
  input: zConversationId,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ conversationId: string }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    if (conversation.status !== 'resolved') {
      await ctx.trx.updateTable('crove_kernel.conversation').set({ status: 'resolved', resolved_at: ctx.now, resolved_by: me, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', conversation.id).execute();
    }
    ctx.audit({ conversation_id: conversation.id });
    return { conversationId: conversation.id };
  },
});

export const conversationReopen = defineCommand({
  name: 'kernel.conversation.reopen',
  input: zConversationId,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ conversationId: string }> => {
    requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    if (conversation.status === 'resolved') {
      // New when the customer wrote last, pending when the org did.
      const last = await ctx.trx
        .selectFrom('crove_kernel.conversation_message')
        .select('direction')
        .where('org_id', '=', ctx.orgId)
        .where('conversation_id', '=', conversation.id)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      await ctx.trx
        .updateTable('crove_kernel.conversation')
        .set({ status: last?.direction === 'out' ? 'pending' : 'new', resolved_at: null, resolved_by: null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', conversation.id)
        .execute();
    }
    ctx.audit({ conversation_id: conversation.id });
    return { conversationId: conversation.id };
  },
});

export const conversationNoteAdd = defineCommand({
  name: 'kernel.conversation.note',
  input: zConversationNoteAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ noteId: string }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    const note = await ctx.trx
      .insertInto('crove_kernel.conversation_note')
      .values({ org_id: ctx.orgId, conversation_id: conversation.id, author_user_id: me, body: input.body, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The note's text is private to the thread: the audit row holds its id and length only.
    ctx.audit({ conversation_id: conversation.id, note_id: note.id, length: input.body.length });
    return { noteId: note.id };
  },
});

export const conversationLinkContact = defineCommand({
  name: 'kernel.conversation.link_contact',
  input: zConversationLinkContact,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ conversationId: string }> => {
    requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    if (input.partyId) {
      const party = await ctx.trx.selectFrom('crove_kernel.party').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.partyId).executeTakeFirst();
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy liên hệ này');
    }
    // A person's decision about who this is: it holds for the customer's other threads of the same kind, never across kinds.
    await ctx.trx.updateTable('crove_kernel.conversation').set({ party_id: input.partyId, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', conversation.id).execute();
    if (conversation.identity_id) {
      await ctx.trx
        .updateTable('crove_kernel.conversation')
        .set({ party_id: input.partyId, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('identity_id', '=', conversation.identity_id)
        .where('kind', '=', conversation.kind)
        .execute();
    }
    ctx.audit({ conversation_id: conversation.id, party_id: input.partyId });
    return { conversationId: conversation.id };
  },
});

export const conversationMarkRead = defineCommand({
  name: 'kernel.conversation.mark_read',
  input: zConversationMarkRead,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ conversationId: string }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    await markRead(ctx, conversation.id, me, Math.min(input.seq, conversation.last_seq));
    return { conversationId: conversation.id };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The sandbox's demo comment
// ---------------------------------------------------------------------------------------------------------------------

// A member asks the offline sandbox for a comment on a post, so the whole flow runs on a laptop with no platform account.
// The command checks the connection and returns the event; the API puts it through the same intake a platform's notice takes
// (conversation_inbound_enqueue, then the worker's ingest), so nothing here writes a conversation.
export const conversationSandboxComment = defineCommand({
  name: 'kernel.conversation.sandbox_comment',
  input: zConversationSandboxComment,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ accountId: string; events: ConversationEvent[] }> => {
    requireUser(ctx);
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'external_account_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || connection.provider !== 'sandbox') throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Chỉ kênh thử nghiệm mới tạo được bình luận mẫu');
    if (connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    const stamp = `${ctx.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `sbx_in_${stamp}`;
    const event: ConversationEvent = {
      kind: 'comment_thread',
      threadId: input.threadId ?? messageId,
      postId: input.postId,
      messageId,
      direction: 'in',
      // One demo customer per name, so a follow-up comes from the same person.
      // The id is a hash of the whole name, so two names never share one customer, whatever their script.
      contact: { id: `sbx_user_${createHash('sha256').update(input.fromName.normalize('NFC').toLowerCase()).digest('hex').slice(0, 24)}`, name: input.fromName },
      text: input.text,
      at: ctx.now.toISOString(),
    };
    ctx.audit({ connection_id: input.connectionId, length: input.text.length });
    return { accountId: connection.external_account_id, events: [event] };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Retention, erasure and purge (CV6, #2305). Nothing here reads a message out: the audit rows, the counts returned and the logs
// carry ids and numbers only.
// ---------------------------------------------------------------------------------------------------------------------

async function retentionOf(ctx: QueryContext | CommandContext): Promise<ConversationRetention> {
  const row = await ctx.trx.selectFrom('crove_kernel.conversation_setting').select('retention_months').where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!row) return { retentionMonths: CONVERSATION_RETENTION_DEFAULT_MONTHS as 24, isDefault: true };
  const months = row.retention_months;
  return { retentionMonths: months === 6 || months === 12 || months === 24 ? months : null, isDefault: false };
}

export const conversationRetention = defineQuery({
  name: 'kernel.conversation.retention',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<ConversationRetention> => retentionOf(ctx),
});

// How long the org keeps a thread after its last message (6, 12 or 24 months), or until a person deletes it. The daily retention job
// deletes the threads past it. Shortening it deletes the older threads at the next run, so it is R2 and for owners and admins.
export const conversationRetentionSet = defineCommand({
  name: 'kernel.conversation.retention_set',
  input: zConversationRetentionSet,
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<ConversationRetention> => {
    const me = requireUser(ctx);
    await ctx.trx
      .insertInto('crove_kernel.conversation_setting')
      .values({ org_id: ctx.orgId, retention_months: input.retentionMonths, set_by: me })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ retention_months: input.retentionMonths, set_by: me, updated_at: ctx.now }))
      .execute();
    ctx.audit({ retention_months: input.retentionMonths });
    return { retentionMonths: input.retentionMonths, isDefault: false };
  },
});

// Deletes threads and what hangs on them (messages, notes and read marks go with a thread by the foreign keys). Returns counts.
async function deleteThreads(ctx: CommandContext, filter: ReturnType<typeof sql>): Promise<{ threads: number; messages: number }> {
  const { rows } = await sql<{ threads: string; messages: string }>`
    WITH gone AS (DELETE FROM crove_kernel.conversation c WHERE c.org_id = ${ctx.orgId}::uuid AND ${filter} RETURNING c.id)
    SELECT (SELECT count(*) FROM gone)::text AS threads,
           (SELECT count(*) FROM crove_kernel.conversation_message m WHERE m.org_id = ${ctx.orgId}::uuid AND m.conversation_id IN (SELECT id FROM gone))::text AS messages`.execute(ctx.trx);
  return { threads: Number(rows[0]?.threads ?? 0), messages: Number(rows[0]?.messages ?? 0) };
}

// Identities left with no thread: nothing the org holds names them any more.
async function deleteOrphanIdentities(ctx: CommandContext): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    WITH gone AS (
      DELETE FROM crove_kernel.conversation_identity i
      WHERE i.org_id = ${ctx.orgId}::uuid AND i.erased_at IS NULL AND NOT EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = i.org_id AND c.identity_id = i.id)
        -- A person who only replied in other customers' threads is still named by what they wrote there.
        AND NOT EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = i.org_id AND m.author_identity_id = i.id)
      RETURNING i.id)
    SELECT count(*)::text AS n FROM gone`.execute(ctx.trx);
  return Number(rows[0]?.n ?? 0);
}

// Erases one customer at the org's request (a data subject asking, or the org's own decision): every thread of the person whose
// thread this is, with its messages, notes and read marks, and the person's identity. A comment thread that others replied in goes
// whole, since a reply is stored with its thread, not with its author. Irreversible, so R3 (a fresh second factor), owners and
// admins only. If the customer writes again, a new thread opens: erasing is not blocking. A copy of a message in a backup is
// outside this command's reach and goes with the backup's own retention (the runbook says so).
export const conversationEraseContact = defineCommand({
  name: 'kernel.conversation.erase_contact',
  input: zConversationEraseContact,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<ConversationErased> => {
    requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    // The person: the thread's own customer, or the author of the message named (a customer who only replied in this thread).
    let subject = conversation.identity_id;
    if (input.messageId) {
      const m = await ctx.trx
        .selectFrom('crove_kernel.conversation_message')
        .select('author_identity_id')
        .where('org_id', '=', ctx.orgId)
        .where('conversation_id', '=', conversation.id)
        .where('id', '=', input.messageId)
        .executeTakeFirst();
      if (!m?.author_identity_id) throw new DomainError('MESSAGE_NOT_FOUND', 404, 'Không tìm thấy tin của khách này');
      subject = m.author_identity_id;
    }
    const filter = subject ? sql`c.identity_id = ${subject}::uuid` : sql`c.id = ${conversation.id}::uuid`;
    const erased = await deleteThreads(ctx, filter);
    if (subject) {
      // What the customer wrote in other people's comment threads goes too, wherever it is (a reply is stored with the thread, not with
      // its author).
      const others = await sql<{ n: string }>`
        WITH gone AS (DELETE FROM crove_kernel.conversation_message m WHERE m.org_id = ${ctx.orgId}::uuid AND m.author_identity_id = ${subject}::uuid RETURNING 1)
        SELECT count(*)::text AS n FROM gone`.execute(ctx.trx);
      erased.messages += Number(others.rows[0]?.n ?? 0);
      // The identity stays as a tombstone: no name, no party, and no platform id, only a keyed hash of it, so the intake still recognises
      // the customer (and refuses anything dated at or before now) while a copy of the database or the export cannot name them.
      const who = await ctx.trx.selectFrom('crove_kernel.conversation_identity').select(['provider', 'external_user_id']).where('org_id', '=', ctx.orgId).where('id', '=', subject).executeTakeFirst();
      if (who) {
        const h = await sql<{ h: string }>`SELECT crove_kernel.conversation_identity_hash(${who.provider}, ${who.external_user_id}) AS h`.execute(ctx.trx);
        const key = `erased:${h.rows[0]?.h ?? ''}`;
        // A customer erased before, who came back and is erased again within the tombstone's 30 days: the old tombstone is replaced by
        // this one (the key is unique), which carries the later erasure time.
        await ctx.trx.deleteFrom('crove_kernel.conversation_identity').where('org_id', '=', ctx.orgId).where('external_user_id', '=', key).where('id', '<>', subject).execute();
        await ctx.trx
          .updateTable('crove_kernel.conversation_identity')
          .set({ display_name: null, party_id: null, external_user_id: key, erased_at: ctx.now, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', subject)
          .execute();
      }
    }
    ctx.audit({ threads: erased.threads, messages: erased.messages, kind: conversation.kind });
    return erased;
  },
});

// The retention purge of the org in context (the worker, as the system): the threads whose last message is past the org's
// retention, oldest first, at most `limit` a call, and the identities left with no thread. `more` says the batch was full, so the
// job calls again. It deletes nothing of an org that keeps threads (retention NULL), and it never touches a thread of another org.
export const conversationPurgeExpired = defineCommand({
  name: 'kernel.conversation.purge_expired',
  input: zConversationPurgeExpired,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<ConversationPurged> => {
    // An erase tombstone older than 30 days is longer than any redelivery: its identity goes if no thread names it.
    await sql`UPDATE crove_kernel.conversation_identity SET erased_at = NULL WHERE org_id = ${ctx.orgId}::uuid AND erased_at < ${ctx.now}::timestamptz - interval '30 days'`.execute(ctx.trx);
    const retention = await retentionOf(ctx);
    if (retention.retentionMonths === null) {
      const left = await deleteOrphanIdentities(ctx);
      if (left > 0) ctx.audit({ threads: 0, messages: 0, identities: left, retention_months: null });
      return { threads: 0, messages: 0, identities: left, more: false };
    }
    const { rows } = await sql<{ id: string }>`
      SELECT c.id FROM crove_kernel.conversation c
      WHERE c.org_id = ${ctx.orgId}::uuid
        AND COALESCE(c.last_message_at, c.opened_at) < ${ctx.now}::timestamptz - pg_catalog.make_interval(months => ${retention.retentionMonths}::int)
      ORDER BY COALESCE(c.last_message_at, c.opened_at), c.id LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED`.execute(ctx.trx);
    if (rows.length === 0) {
      const left = await deleteOrphanIdentities(ctx);
      if (left > 0) ctx.audit({ threads: 0, messages: 0, identities: left, retention_months: retention.retentionMonths });
      return { threads: 0, messages: 0, identities: left, more: false };
    }
    const erased = await deleteThreads(ctx, sql`c.id = ANY (${rows.map((r) => r.id)}::uuid[])`);
    const identities = await deleteOrphanIdentities(ctx);
    ctx.audit({ threads: erased.threads, messages: erased.messages, identities, retention_months: retention.retentionMonths });
    return { ...erased, identities, more: rows.length >= input.limit };
  },
});

// Erases every conversation of one connection of the org in context and the identities left with no thread (the worker, as the
// system, on Meta's data deletion callback: the person who granted the connection asked for their data to go). Idempotent.
export const conversationEraseConnection = defineCommand({
  name: 'kernel.conversation.erase_connection',
  input: zConversationEraseConnection,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<ConversationPurged> => {
    const erased = await deleteThreads(ctx, sql`c.channel_connection_id = ${input.connectionId}::uuid`);
    const identities = await deleteOrphanIdentities(ctx);
    ctx.audit({ connection_id: input.connectionId, threads: erased.threads, messages: erased.messages, identities });
    return { ...erased, identities, more: false };
  },
});

export const conversationCommands = [
  conversationIngest,
  conversationReply,
  conversationReplyBegin,
  conversationReplyRecord,
  conversationReplySettle,
  conversationHide,
  conversationHideBegin,
  conversationHideRecord,
  conversationAssign,
  conversationResolve,
  conversationReopen,
  conversationNoteAdd,
  conversationLinkContact,
  conversationMarkRead,
  conversationSandboxComment,
  conversationRetentionSet,
  conversationEraseContact,
  conversationPurgeExpired,
  conversationEraseConnection,
];
export const conversationQueries = [conversationList, conversationCounts, conversationGet, conversationRetention];
