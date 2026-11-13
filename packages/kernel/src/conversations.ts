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
  CONVERSATION_DRAFT_MAX,
  CONVERSATION_FACEBOOK_DIRECT_MAX,
  CONVERSATION_INSTAGRAM_DIRECT_MAX,
  CONVERSATION_PREVIEW_CHARS,
  EMAIL_PROVIDER,
  EMAIL_REFS_MAX,
  conversationRules,
  zConversationAssign,
  zConversationAutoDraftSet,
  zConversationAttachmentGet,
  zConversationAttachmentRecord,
  zConversationAttachmentRequest,
  zConversationAttachmentSource,
  zConversationCounted,
  zConversationCounts,
  zConversationDraftDiscard,
  zConversationDraftEnqueue,
  zConversationDraftRecord,
  zConversationDraftRequest,
  zConversationDraftSource,
  zConversationEraseConnection,
  zConversationEraseContact,
  zConversationGet,
  zConversationHistoryBegin,
  zConversationHistoryRecord,
  zConversationHide,
  zConversationId,
  zConversationEmailIngest,
  zConversationIngest,
  zConversationLinkContact,
  zConversationList,
  zConversationMarkRead,
  zConversationNoteAdd,
  zConversationPrivateReply,
  zConversationProfileApply,
  zConversationProfileBegin,
  zConversationPurgeExpired,
  zConversationReply,
  zConversationRetentionSet,
  zConversationSandboxComment,
  zConversationSyncRequest,
  zConversationSettle,
  zSavedReplyId,
  zSavedReplyInput,
  zSavedReplyList,
  zSavedReplyUpdate,
  SAVED_REPLIES_MAX,
  CONVERSATION_DRAFT_MESSAGES,
  CONVERSATION_OTHERS_MAX,
  CONVERSATION_COMPOSING_EVERY_SECONDS,
  CONVERSATION_COMPOSING_SECONDS,
  zConversationComposing,
  zAvailabilitySet,
  zConversationSetIntent,
  zConversationIntentSuggest,
  zConversationContactMatches,
  CONVERSATION_CONTACT_MATCHES_MAX,
  CONVERSATION_INTENT_CHARS,
  CONVERSATION_INTENT_MESSAGES,
  phoneKeysIn,
  type Availability,
  type ConversationIntent,
  CONVERSATION_ATTACHMENTS_MAX,
  CONVERSATION_RETENTION_DEFAULT_MONTHS,
  type ConversationAttachmentView,
  type ConversationAutoDraft,
  type ConversationCounted,
  type ConversationErased,
  type ConversationPrivateReplied,
  type ConversationPurged,
  type ConversationRetention,
  type ConversationDetail,
  type ConversationEvent,
  type ConversationKind,
  type ConversationStatus,
  type ConversationIngested,
  type ConversationListed,
  type ConversationSummary,
  type SavedReplyListed,
  type SavedReplyView,
  hasNamePlaceholder,
} from '@crove/kernel-contract';
import { z } from 'zod';
import { zId, zTodayItems, type TodayItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, conversationKey, defineCommand, defineQuery, newConversationBlobId, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { createMailMessage } from './mail.ts';
import { notifyMembers, ownersAndAdmins } from './notifications.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const HOUR_MS = 3_600_000;
// The most messages one detail read returns (a thread longer than this shows its latest).
export const CONVERSATION_MESSAGES_MAX = 500;

export const REPLY_QUEUED = 'kernel.conversation.reply_queued';
export const HIDE_QUEUED = 'kernel.conversation.hide_queued';
export const SYNC_QUEUED = 'kernel.conversation.sync_queued';
export const ATTACHMENT_QUEUED = 'kernel.conversation.attachment_queued';
export const DRAFT_QUEUED = 'kernel.conversation.draft_queued';

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
  sender_unverified: boolean;
  status: ConversationStatus;
  assignee_user_id: string | null;
  last_seq: number;
  last_inbound_at: Date | null;
  last_message_at: Date | null;
  reply_window_until: Date | null;
  resolved_at: Date | null;
}
const CONVERSATION_COLUMNS = [
  'id', 'channel_connection_id', 'kind', 'external_thread_id', 'external_post_id', 'identity_id', 'party_id', 'sender_unverified', 'status',
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
    return ingestEvents(ctx, input.connectionId, input.events);
  },
});

async function ingestEvents(ctx: CommandContext, connectionId: string, inputEvents: readonly ConversationEvent[]): Promise<ConversationIngested> {
  const out: ConversationIngested = { stored: 0, duplicates: 0, ignored: 0 };
  const reserved: MailImageSlot[] = [];
  const connection = await connectionOf(ctx, connectionId);
  const rules = connection && connection.status === 'active' ? conversationRules(connection.provider) : null;
  if (!connection || !rules) {
    out.ignored = inputEvents.length;
    ctx.audit({ connection_id: connectionId, ...out });
    return out;
  }
  // Oldest first, so a thread's messages take their seq in the order the platform dated them within one notice.
  const events = inputEvents.map((event, i) => ({ event, i })).sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || a.i - b.i);
  for (const { event } of events) {
    if (!rules.kinds.includes(event.kind)) {
      out.ignored++;
      continue;
    }
    const result = await ingestEvent(ctx, connectionId, connection.provider, rules.windowHours, event, reserved);
    out[result]++;
  }
  // The audit row holds counts only: the reserved keys are the worker's to write and are never recorded.
  ctx.audit({ connection_id: connectionId, ...out });
  return reserved.length > 0 ? { ...out, images: reserved } : out;
}

// The org's email connection (#2439): one, made when the first customer mail arrives, so an org that never gets mail has none. It has no
// account behind it, so it carries no credential; the member named is the org's creator, as the connection needs one.
async function emailConnectionId(ctx: CommandContext): Promise<string> {
  const find = () =>
    ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', EMAIL_PROVIDER)
      .where('status', '<>', 'revoked')
      .orderBy('connected_at')
      .limit(1)
      .executeTakeFirst();
  const existing = await find();
  if (existing) return existing.id;
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('created_by').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  await ctx.trx
    .insertInto('crove_kernel.channel_connection')
    .values({ org_id: ctx.orgId, provider: EMAIL_PROVIDER, external_account_id: 'inbox', display_name: 'Email', status: 'active', connected_by: org.created_by, connected_at: ctx.now, updated_at: ctx.now })
    .onConflict((oc) => oc.columns(['org_id', 'provider', 'external_account_id']).where('status', '<>', 'revoked').doNothing())
    .execute();
  const made = await find();
  if (!made) throw new DomainError('EMAIL_CONNECTION', 409, 'Không mở được kênh email');
  return made.id;
}

// The org's conversation address (#2439, security review of #2528): its own token, issued the first time an owner or admin opens the Inbox (a later call
// returns the same one) and rotated by the owner (kernel.conversation.address_rotate). The definer checks the role again.
export const conversationAddressIssue = defineCommand({
  name: 'kernel.conversation.address_issue',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx): Promise<{ issued: boolean }> => {
    requireUser(ctx);
    const { rows } = await sql<{ token: string | null }>`SELECT crove_kernel.conversation_address_issue() AS token`.execute(ctx.trx);
    if (!rows[0]?.token) throw new DomainError('INTERNAL', 500, 'Không tạo được địa chỉ email của Hộp thư');
    return { issued: true };
  },
});

// A customer mail the worker parsed (#2439): the same intake as a platform's notice, for the org's email connection, which is made if it is the
// first mail. The org is the worker's, found from the stored address. Idempotent: a redelivered Message-ID changes nothing.
export const conversationEmailIngest = defineCommand({
  name: 'kernel.conversation.email_ingest',
  input: zConversationEmailIngest,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<ConversationIngested> => {
    requireSystem(ctx);
    const result = await ingestEvents(ctx, await emailConnectionId(ctx), input.events);
    // What the org used of its daily limit of customer mail: a mail kept counts, a redelivery counts nothing; the invoice reader's limit is its own.
    if (result.stored > 0) await ctx.trx.insertInto('crove_kernel.org_usage').values({ org_id: ctx.orgId, metric: 'conversation_emails', amount: String(result.stored) }).execute();
    // The bytes of the images a new mail reserved count against the org's day of attachment bytes (#2758): a published address must not fill the store.
    const imageBytes = result.stored > 0 ? input.events.reduce((sum, event) => sum + (event.mailImageBytes ?? 0), 0) : 0;
    if (imageBytes > 0) await ctx.trx.insertInto('crove_kernel.org_usage').values({ org_id: ctx.orgId, metric: 'attachment_bytes', amount: String(imageBytes) }).execute();
    return result;
  },
});

// The drafts in play of a thread go stale and drop their text: what they answered has changed or gone (CV8, #2310).
async function staleDrafts(ctx: CommandContext, conversationId: string | readonly string[]): Promise<void> {
  const ids = typeof conversationId === 'string' ? [conversationId] : [...conversationId];
  if (ids.length === 0) return;
  await ctx.trx
    .updateTable('crove_kernel.conversation_draft')
    .set({ state: 'stale', body: null, decided_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('conversation_id', 'in', ids)
    .where('state', 'in', ['requested', 'live'])
    .execute();
}

// The pending rows of a message's images (CV5c, #2357), each with a blob key of its own reserved now.
async function addAttachments(ctx: CommandContext, messageId: string, connectionId: string, kind: ConversationKind, images: ReadonlyArray<{ url: string }>): Promise<void> {
  await ctx.trx
    .insertInto('crove_kernel.conversation_attachment')
    .values(
      images.map((a) => ({
        org_id: ctx.orgId,
        message_id: messageId,
        channel_connection_id: connectionId,
        kind,
        source_url: a.url,
        storage_key: conversationKey(ctx.orgId, newConversationBlobId()),
        created_at: ctx.now,
      })),
    )
    .execute();
}

const customerLock = (ctx: CommandContext, provider: string, externalUserId: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.conversation.customer:${ctx.orgId}:${provider}:${externalUserId}`}, 0))`.execute(ctx.trx);

// The thread an email joins (#2439): the one that holds a Message-ID the mail names in In-Reply-To or References, within this org and this
// channel only, so an id that points at another org's conversation finds nothing and opens a thread of its own. A mail that names none opens a
// thread whose id is its own Message-ID. The subject never joins threads: a wrong merge would show one customer another's mail.
async function emailThreadId(ctx: CommandContext, connectionId: string, event: ConversationEvent): Promise<string> {
  const refs = [...new Set(event.refs ?? [])];
  // A sender the receiving server did not vouch for may be anyone writing as the customer: the mail opens a thread of its own.
  if (refs.length === 0 || event.verified !== true) return event.messageId;
  const row = await ctx.trx
    .selectFrom('crove_kernel.conversation_message as m')
    .innerJoin('crove_kernel.conversation as c', (join) => join.onRef('c.org_id', '=', 'm.org_id').onRef('c.id', '=', 'm.conversation_id'))
    .innerJoin('crove_kernel.conversation_identity as i', (join) => join.onRef('i.org_id', '=', 'c.org_id').onRef('i.id', '=', 'c.identity_id'))
    .select('c.external_thread_id')
    .where('m.org_id', '=', ctx.orgId)
    .where('m.channel_connection_id', '=', connectionId)
    .where('c.kind', '=', 'email')
    // Only the thread's own customer continues it: someone copied on the mail, or who learned a Message-ID, opens a conversation of their own and does not
    // put words in the customer's thread (the answer goes to the customer's address).
    .where('i.external_user_id', '=', event.contact.id)
    .where('m.external_message_id', 'in', refs)
    .orderBy('m.sent_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.external_thread_id ?? event.messageId;
}

// A mail's image whose bytes the worker has yet to write: its reserved row and blob key (#2758).
type MailImageSlot = { attachmentId: string; storageKey: string };

// The rows of a mail's images (#2758), reserved with no source address: the worker already holds the bytes, so nothing is fetched. Each has a blob
// key of its own, as for a platform's image, and the worker writes the bytes under it and records them (attachment_record).
async function reserveMailImages(ctx: CommandContext, messageId: string, connectionId: string, count: number): Promise<MailImageSlot[]> {
  const rows = await ctx.trx
    .insertInto('crove_kernel.conversation_attachment')
    .values(
      // Each row is a millisecond after the one before it: the thread and a redelivery order the images by created_at, and ids made in one
      // millisecond are not in order.
      Array.from({ length: count }, (_, i) => ({
        org_id: ctx.orgId,
        message_id: messageId,
        channel_connection_id: connectionId,
        kind: 'email' as const,
        storage_key: conversationKey(ctx.orgId, newConversationBlobId()),
        created_at: new Date(ctx.now.getTime() + i),
      })),
    )
    .returning(['id', 'storage_key'])
    .execute();
  return rows.map((r) => ({ attachmentId: r.id, storageKey: r.storage_key }));
}

async function ingestEvent(
  ctx: CommandContext,
  connectionId: string,
  provider: string,
  windowHours: number | null,
  original: ConversationEvent,
  reserved: MailImageSlot[],
): Promise<'stored' | 'duplicates' | 'ignored'> {
  let event: ConversationEvent = original.kind === 'email' ? { ...original, threadId: await emailThreadId(ctx, connectionId, original) } : original;
  const existing = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select(['id', 'conversation_id', 'body', 'direction', 'hidden_at', 'platform_removed_at', 'author_identity_id', 'sender_verified'])
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
      // The images go with the body (their blobs are queued for deletion by the delete trigger).
      await ctx.trx.deleteFrom('crove_kernel.conversation_attachment').where('org_id', '=', ctx.orgId).where('message_id', '=', existing.id).execute();
      // A draft Vy wrote from what the person has now removed goes stale with its text.
      await staleDrafts(ctx, existing.conversation_id);
    } else if (!event.removed && !existing.platform_removed_at) {
      if (event.edited && existing.direction === 'in' && event.text !== '' && event.text !== existing.body) {
        await ctx.trx
          .updateTable('crove_kernel.conversation_message')
          .set({ body: event.text })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .execute();
        await staleDrafts(ctx, existing.conversation_id);
      }
      if (event.hidden !== undefined && existing.direction === 'in' && (event.hidden ? existing.hidden_at === null : existing.hidden_at !== null)) {
        await ctx.trx
          .updateTable('crove_kernel.conversation_message')
          .set({ hidden_at: event.hidden ? ctx.now : null, ...(event.hidden ? {} : { hidden_by: null }), hide_request: null, hide_error_code: null })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .execute();
      }
      if (existing.direction === 'in' && event.attachments && event.attachments.length > 0) {
        // The message was stored before its notice brought the images (the history read stores the text alone): the images are added once, when
        // the message has none, so a redelivery does not add them again.
        const has = await ctx.trx.selectFrom('crove_kernel.conversation_attachment').select('id').where('org_id', '=', ctx.orgId).where('message_id', '=', existing.id).limit(1).executeTakeFirst();
        if (!has) await addAttachments(ctx, existing.id, connectionId, event.kind, event.attachments);
      }
    }
    // A redelivery of a mail whose worker died before it wrote every image: the rows it reserved are handed out again, so the images are not lost.
    // Only from the sender of the stored message, with the same standing: someone copied on the mail, or who learned its Message-ID, must not fill or
    // take the slots of a customer's message with their own images.
    const sameSender =
      event.kind === 'email' &&
      existing.author_identity_id !== null &&
      existing.sender_verified === (event.verified === true) &&
      (await ctx.trx.selectFrom('crove_kernel.conversation_identity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', existing.author_identity_id).where('external_user_id', '=', event.contact.id).executeTakeFirst()) !== undefined;
    if (sameSender && event.mailImages && existing.direction === 'in' && !existing.platform_removed_at) {
      const waiting = await ctx.trx
        .selectFrom('crove_kernel.conversation_attachment')
        .select(['id', 'storage_key'])
        .where('org_id', '=', ctx.orgId)
        .where('message_id', '=', existing.id)
        .where('state', '=', 'pending')
        .where('source_url', 'is', null)
        .orderBy('created_at')
        .orderBy('id')
        .limit(CONVERSATION_ATTACHMENTS_MAX)
        .execute();
      for (const w of waiting) reserved.push({ attachmentId: w.id, storageKey: w.storage_key });
    }
    return 'duplicates';
  }
  if (event.hiddenOnly) return 'ignored';
  // One customer's intake and erasure take turns: erase_contact holds the same lock while it deletes and writes the tombstone, so a message
  // that was in flight is checked against the tombstone after the erasure commits, not before it.
  await customerLock(ctx, provider, event.contact.id);
  // The thread is found again under the lock: a mail of this customer that was in flight at the same time (the first mail, as this one answers it) has
  // committed by now, and the first lookup may have missed it.
  if (original.kind === 'email') event = { ...original, threadId: await emailThreadId(ctx, connectionId, original) };
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
        // A name an unverified sender wrote does not replace the one the customer's verified mail gave: the name belongs to the address, which the sender may be forging.
        display_name: event.kind === 'email' && event.verified !== true ? sql<string | null>`crove_kernel.conversation_identity.display_name` : sql<string | null>`COALESCE(excluded.display_name, crove_kernel.conversation_identity.display_name)`,
        updated_at: ctx.now,
      }),
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const sentAt = new Date(event.at);
  // Before opening a new direct thread on an outbound echo, check whether this echo is the platform's confirmation of an in-flight
  // one-shot private reply (`external_thread_id LIKE 'private:%'`) whose Graph answer did not reach us. Matching here avoids creating
  // an empty ghost thread under the PSID and works even when the original comment had no `from.id`.
  if (event.direction === 'out' && event.kind === 'direct') {
    const privateConvs = await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connectionId)
      .where('kind', '=', 'direct')
      .where('external_thread_id', 'like', 'private:%')
      .execute();
    if (privateConvs.length > 0) {
      const privateOurs = await ctx.trx
        .selectFrom('crove_kernel.conversation_message')
        .select(['id', 'send_attempt'])
        .where('org_id', '=', ctx.orgId)
        .where('conversation_id', 'in', privateConvs.map((pc) => pc.id))
        .where('direction', '=', 'out')
        .where('send_state', 'in', ['sending', 'unknown'])
        .where('body', '=', event.text)
        .where('external_message_id', 'is', null)
        .where('received_at', '<=', new Date(sentAt.getTime() + 5 * 60_000))
        .where('received_at', '>=', new Date(sentAt.getTime() - 24 * HOUR_MS))
        .orderBy('received_at')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      if (privateOurs) {
        const againPrivate = await ctx.trx
          .selectFrom('crove_kernel.conversation_message')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('channel_connection_id', '=', connectionId)
          .where('external_message_id', '=', event.messageId)
          .executeTakeFirst();
        if (againPrivate) return 'duplicates';
        await ctx.trx
          .updateTable('crove_kernel.conversation_message')
          .set({ external_message_id: event.messageId, send_state: 'sent', send_error_code: null, sent_at: sentAt })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', privateOurs.id)
          .execute();
        await ctx.trx
          .updateTable('crove_kernel.external_call')
          .set({ state: 'succeeded', finished_at: ctx.now, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('key', '=', replyCallKey(privateOurs.id, privateOurs.send_attempt))
          .where('state', 'in', ['started', 'ambiguous'])
          .execute();
        return 'stored';
      }
    }
  }

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
      party_id: event.kind === 'email' && event.verified !== true ? null : (linked?.party_id ?? null),
      subject: event.kind === 'email' ? (event.subject ?? null) : null,
      sender_unverified: event.kind === 'email' && event.verified !== true,
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
  const stored = await ctx.trx
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
      ...(event.direction === 'in' && event.hidden ? { hidden_at: ctx.now } : {}),
      // A customer's text is tainted external text; the org's own message seen as an echo is its own.
      tainted: event.direction === 'in',
      email_refs: event.kind === 'email' ? [...new Set(event.refs ?? [])] : [],
      sender_verified: event.kind === 'email' ? event.verified === true : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // A mail the receiving server vouched for proves its sender controls the address: the thread's mark goes.
  if (event.kind === 'email' && event.direction === 'in' && event.verified === true && conversation.sender_unverified) {
    await ctx.trx.updateTable('crove_kernel.conversation').set({ sender_unverified: false }).where('org_id', '=', ctx.orgId).where('id', '=', conversation.id).execute();
  }
  // The images a customer's message carries (CV5c, #2357): a pending row each, with the platform's address (personal data, cleared when the
  // bytes are stored, at six days at the latest) and a blob key of its own reserved now, so the row always names its blob. The relay hands
  // them to the worker. The message keeps the placeholder text it was stored with until then, and for good when the fetch cannot be made.
  if (event.direction === 'in' && event.attachments && event.attachments.length > 0) await addAttachments(ctx, stored.id, connectionId, event.kind, event.attachments);
  // A mail's images (#2758): one reserved row each, for the worker to write its bytes under; the thread shows each once it is stored.
  if (event.kind === 'email' && event.direction === 'in' && event.mailImages) reserved.push(...(await reserveMailImages(ctx, stored.id, connectionId, event.mailImages)));
  // A draft answers the message that was last when it was asked for: a newer message of the thread (a customer's, or the org's own written in the platform's
  // inbox, which answers it) makes it stale, its text dropped (a new draft may be made).
  await staleDrafts(ctx, conversation.id);

  const inbound = event.direction === 'in';
  // An email's activity is dated by its arrival: the sender's clock may be years off (a thread whose last message looks that old would fall to the retention
  // purge as it arrives and sort behind every other), and a mail that comes late is news now. Its own Date header is kept as the message's sent_at, and is
  // what the erasure tombstone compares.
  const activityAt = event.kind === 'email' && event.direction === 'in' ? ctx.now : sentAt;
  const newest = conversation.last_message_at && conversation.last_message_at.getTime() > activityAt.getTime() ? conversation.last_message_at : activityAt;
  const lastInbound = inbound && (!conversation.last_inbound_at || conversation.last_inbound_at.getTime() < activityAt.getTime()) ? activityAt : conversation.last_inbound_at;
  // A customer's new message reopens the thread as new; the org's own message from the platform's inbox answers it.
  // A customer message the platform dated before the thread was resolved does not reopen it.
  // An email is delivered once, as it arrives, so it never predates the resolution: its Date header is the sender's clock, and a mail that arrives after a
  // person resolved the thread reopens it whatever the header says.
  const predatesResolution = inbound && event.kind !== 'email' && conversation.status === 'resolved' && conversation.resolved_at !== null && sentAt.getTime() <= conversation.resolved_at.getTime();
  const status = inbound ? (predatesResolution ? 'resolved' : 'new') : conversation.status === 'new' ? 'pending' : conversation.status;
  await ctx.trx
    .updateTable('crove_kernel.conversation')
    .set({
      last_seq: seq,
      last_message_at: newest,
      last_inbound_at: lastInbound,
      // Only direct-message threads have a platform reply window (24h/7d on Messenger, 48h on Zalo OA); public comment threads do not.
      reply_window_until: lastInbound && windowHours !== null && event.kind === 'direct' ? new Date(lastInbound.getTime() + windowHours * HOUR_MS) : conversation.reply_window_until,
      status,
      // A thread that stays resolved (the org's own message seen from the platform) keeps who resolved it and when.
      ...(status === 'resolved' ? {} : { resolved_at: null, resolved_by: null }),
      updated_at: ctx.now,
    })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', conversation.id)
    .execute();
  // A thread that is New now and was not before (a first message, or a customer writing again after it was answered or resolved) is told to the
  // members who can answer it (CV3).
  // Not for a message the platform dated more than a day ago: an old thread brought in by a history read or a reconcile is not news, and a burst of
  // them would be a notice for each reader.
  if (inbound && status === 'new' && (conversation.status !== 'new' || conversation.last_seq === 0) && (event.kind === 'email' || sentAt.getTime() > ctx.now.getTime() - NEW_NOTICE_AGE_MS)) {
    await routeNewConversation(ctx, conversation.id, conversation.assignee_user_id, seq);
  }
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
  // The other members typing a reply now (CV3): markers not expired, never the viewer's own.
  composing: string[] | null;
  // The intent a person applied (CV3, #2306), or null.
  intent: string | null;
  // An email thread's subject (#2439), or null.
  subject: string | null;
  sender_unverified: boolean | null;
}

// The summary columns of a thread with its channel, customer, party, last message and the viewer's read mark. Row-level
// security decides which threads exist for the viewer.
const summarySelect = (orgId: string, viewer: string | null) => sql`
  SELECT c.id, c.kind, c.status, c.channel_connection_id, ch.provider, ch.display_name AS channel_name, c.external_post_id,
         c.identity_id, i.display_name AS identity_name, i.external_user_id, c.party_id, p.name AS party_name,
         c.assignee_user_id, c.last_seq, c.last_message_at, c.last_inbound_at, c.reply_window_until, c.intent, c.subject, c.sender_unverified,
         (SELECT m.body FROM crove_kernel.conversation_message m
          WHERE m.org_id = c.org_id AND m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS preview,
         r.last_read_seq AS read_seq,
         (SELECT pg_catalog.array_agg(x.user_id ORDER BY x.updated_at, x.user_id) FROM crove_kernel.conversation_composing x
          WHERE x.org_id = c.org_id AND x.conversation_id = c.id AND x.expires_at > now() AND x.user_id IS DISTINCT FROM ${viewer}::uuid) AS composing
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
    contact: { identityId: row.identity_id, displayName: row.identity_name, idTail: tail, partyId: row.party_id, partyName: row.party_name, ...(row.kind === 'email' ? { address: row.external_user_id } : {}) },
    assigneeUserId: row.assignee_user_id,
    lastSeq: row.last_seq,
    lastMessageAt: iso(row.last_message_at),
    lastInboundAt: iso(row.last_inbound_at),
    replyWindowUntil: iso(row.reply_window_until),
    preview: previewOf(row.preview ?? ''),
    unread: row.last_seq > (row.read_seq ?? 0),
    composing: row.composing ?? [],
    intent: row.intent as ConversationIntent | null,
    subject: row.subject,
    ...(row.kind === 'email' ? { senderUnverified: row.sender_unverified === true } : {}),
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
    if (input.intent === 'none') where.push(sql`c.intent IS NULL`);
    else if (input.intent) where.push(sql`c.intent = ${input.intent}`);
    if (input.q) {
      // The customer's name, the contact's name, or any message of the thread, ignoring case, Vietnamese marks and punctuation (search_fold, as the
      // contacts' search does). Text that folds to nothing (only punctuation) is no search: every thread stays. The folded text is matched with LIKE's own
      // characters escaped, so a fold that keeps one cannot widen the match.
      const needle = sql`'%' || replace(replace(replace(crove_kernel.search_fold(${input.q}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;
      where.push(sql`(crove_kernel.search_fold(${input.q}) = '' OR crove_kernel.search_fold(COALESCE(i.display_name, '')) LIKE ${needle} ESCAPE '\\'
        OR crove_kernel.search_fold(COALESCE(p.name, '')) LIKE ${needle} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM crove_kernel.conversation_message sm WHERE sm.org_id = c.org_id AND sm.conversation_id = c.id
                   AND crove_kernel.search_fold(sm.body) LIKE ${needle} ESCAPE '\\'))`);
    }
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
      .select(['id', 'seq', 'direction', 'author_kind', 'author_user_id', 'author_identity_id', 'external_message_id', 'body', 'attachments', 'sent_at', 'send_state', 'send_error_code', 'hidden_at', 'hide_request', 'hide_error_code', 'platform_removed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', input.conversationId)
      .orderBy('seq', 'desc')
      .limit(CONVERSATION_MESSAGES_MAX)
      .execute();
    const privateReplies = new Map<string, string>();
    if (row.kind === 'comment_thread' && messages.length > 0) {
      const children = await ctx.trx
        .selectFrom('crove_kernel.conversation')
        .select(['id', 'external_thread_id'])
        .where('org_id', '=', ctx.orgId)
        .where('parent_conversation_id', '=', input.conversationId)
        .where('kind', '=', 'direct')
        .execute();
      for (const child of children) {
        if (child.external_thread_id.startsWith('private:')) {
          privateReplies.set(child.external_thread_id.slice('private:'.length), child.id);
        }
      }
    }
    // Who wrote each customer message: in a comment thread the replies are other people's, not the thread's contact.
    const authorIds = [...new Set(messages.map((m) => m.author_identity_id).filter((id): id is string => id !== null))];
    const authors = new Map<string, { name: string | null; tail: string }>();
    if (authorIds.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.conversation_identity').select(['id', 'display_name', 'external_user_id']).where('org_id', '=', ctx.orgId).where('id', 'in', authorIds).execute();
      for (const a of found) authors.set(a.id, { name: a.display_name, tail: a.external_user_id.slice(-4) });
    }
    // The stored images of these messages, as the reader's own rule shows them (row-level security: the image is read by those who read its
    // message, and by nobody else, whatever route they ask by).
    const images = new Map<string, ConversationAttachmentView[]>();
    if (messages.length > 0) {
      const found = await ctx.trx
        .selectFrom('crove_kernel.conversation_attachment')
        .select(['id', 'message_id', 'content_type', 'width', 'height'])
        .where('org_id', '=', ctx.orgId)
        .where('state', '=', 'stored')
        .where('message_id', 'in', messages.map((m) => m.id))
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      for (const a of found) {
        const list = images.get(a.message_id) ?? [];
        list.push({ id: a.id, contentType: a.content_type as ConversationAttachmentView['contentType'], width: a.width, height: a.height });
        images.set(a.message_id, list);
      }
    }
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
      .select(['parent_conversation_id', 'external_thread_id'])
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
    else if (!rules || !rules.kinds.includes(row.kind as ConversationKind) || parent?.external_thread_id?.startsWith('private:')) reason = 'not_supported';
    else if (row.reply_window_until && row.reply_window_until.getTime() < Date.now()) reason = 'window_closed';
    let gap: ConversationDetail['gap'] = null;
    const lastAt = row.last_message_at;
    if (connection && lastAt) {
      const g = await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['gap_from', 'gap_to']).where('org_id', '=', ctx.orgId).where('id', '=', row.channel_connection_id).executeTakeFirst();
      if (g?.gap_from && g.gap_to && lastAt.getTime() >= g.gap_from.getTime()) gap = { from: g.gap_from.toISOString(), to: g.gap_to.toISOString() };
    }
    // Vy's draft in play for the last customer message, and the saved replies that answer its words (offered beside it, at most three).
    const draftRow = await ctx.trx
      .selectFrom('crove_kernel.conversation_draft')
      .select(['id', 'state', 'source', 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', input.conversationId)
      .where('state', 'in', ['requested', 'live'])
      .executeTakeFirst();
    const lastCustomer = [...messages].find((m) => m.direction === 'in' && m.platform_removed_at === null && m.body.trim() !== '');
    const suggestions = lastCustomer && lastCustomer.seq === row.last_seq ? matchSavedReplies(lastCustomer.body, await savedRepliesOf(ctx), 3) : [];
    // The customer's other threads that this reader may read (row-level security), for the contact panel: what they are and where they stand.
    const otherRows = row.identity_id
      ? await ctx.trx
          .selectFrom('crove_kernel.conversation as o')
          .innerJoin('crove_kernel.channel_connection as oc', (j) => j.onRef('oc.org_id', '=', 'o.org_id').onRef('oc.id', '=', 'o.channel_connection_id'))
          .select(['o.id', 'o.kind', 'o.status', 'o.channel_connection_id', 'oc.provider', 'oc.display_name', 'o.last_message_at'])
          .where('o.org_id', '=', ctx.orgId)
          .where('o.identity_id', '=', row.identity_id)
          .where('o.id', '<>', input.conversationId)
          .orderBy(sql`o.last_message_at DESC NULLS LAST`)
          .orderBy('o.id', 'desc')
          .limit(CONVERSATION_OTHERS_MAX)
          .execute()
      : [];
    return {
      conversation,
      others: otherRows.map((o) => ({
        id: o.id,
        kind: o.kind as ConversationKind,
        status: o.status as ConversationSummary['status'],
        channel: { connectionId: o.channel_connection_id, provider: o.provider, displayName: o.display_name },
        lastMessageAt: iso(o.last_message_at),
      })),
      draft: draftRow ? { id: draftRow.id, state: draftRow.state as 'requested' | 'live', source: draftRow.source, body: draftRow.state === 'live' ? draftRow.body : null, tainted: true as const } : null,
      suggestions,
      // Oldest first on screen.
      messages: messages
        .reverse()
        .map((m) => ({
          id: m.id,
          seq: m.seq,
          direction: m.direction as 'in' | 'out',
          authorKind: m.author_kind as 'contact' | 'member' | 'system',
          authorUserId: m.author_user_id,
          authorName: m.author_identity_id ? (authors.get(m.author_identity_id)?.name ?? null) : null,
          authorTail: m.author_identity_id ? (authors.get(m.author_identity_id)?.tail ?? null) : null,
          body: m.body,
          attachments: images.get(m.id) ?? [],
          sentAt: m.sent_at.toISOString(),
          sendState: m.send_state as ConversationDetail['messages'][number]['sendState'],
          sendErrorCode: m.send_error_code,
          hidden: m.hidden_at !== null,
          hideRequest: m.hide_request as ConversationDetail['messages'][number]['hideRequest'],
          hideErrorCode: m.hide_error_code,
          removed: m.platform_removed_at !== null,
          privateReplyConversationId: m.external_message_id ? (privateReplies.get(m.external_message_id) ?? null) : null,
        })),
      notes: notes.map((n) => ({ id: n.id, authorUserId: n.author_user_id, body: n.body, createdAt: n.created_at.toISOString() })),
      parentId,
      reply: { allowed: reason === null, reason },
      // A gap the history read could not fill, shown on the threads that were alive after it began.
      gap,
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

// A reply that still holds the contact-name placeholder `{tên}` is refused before anything is read or written (#3102): the box fills it when a saved reply
// is picked, so a body that still has it means the fill was skipped, and the braces must never reach a customer. The error names no text.
const refuseUnfilledPlaceholder = (body: string): void => {
  if (hasNamePlaceholder(body)) throw new DomainError('REPLY_PLACEHOLDER', 422, 'Câu trả lời còn chỗ trống {tên} chưa điền, hãy sửa lại trước khi gửi');
};

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
    refuseUnfilledPlaceholder(input.body);
    const conversation = await lockConversation(ctx, input.conversationId);
    const connection = await connectionOf(ctx, conversation.channel_connection_id);
    if (!connection || connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    const rules = conversationRules(connection.provider);
    if (!rules || !rules.kinds.includes(conversation.kind) || conversation.external_thread_id.startsWith('private:')) {
      throw new DomainError('REPLY_NOT_SUPPORTED', 409, 'Kênh này chưa hỗ trợ trả lời tại đây');
    }
    const replyMax =
      connection.provider === 'facebook_page' && conversation.kind === 'direct'
        ? CONVERSATION_FACEBOOK_DIRECT_MAX
        : connection.provider === 'instagram' && conversation.kind === 'direct'
          ? CONVERSATION_INSTAGRAM_DIRECT_MAX
          : rules.replyMax;
    if (input.body.length > replyMax) throw new DomainError('REPLY_TOO_LONG', 422, `Câu trả lời dài tối đa ${replyMax} ký tự`, { max: String(replyMax) });
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
    // The replier is no longer typing: their "is replying" marker goes with the send.
    await ctx.trx.deleteFrom('crove_kernel.conversation_composing').where('org_id', '=', ctx.orgId).where('conversation_id', '=', conversation.id).where('user_id', '=', me).execute();
    // The drafts of the thread end with this reply: the one it began from is used (its length, the length sent and the size of the edit are kept, never the
    // text), any other is discarded; a saved reply it began from is counted.
    const open = await ctx.trx
      .selectFrom('crove_kernel.conversation_draft')
      .select(['id', 'state', 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', conversation.id)
      .where('state', 'in', ['requested', 'live'])
      .forUpdate()
      .execute();
    let usedDraft = false;
    for (const d of open) {
      if (d.id === input.draftId && d.state === 'live' && d.body !== null) {
        usedDraft = true;
        await ctx.trx
          .updateTable('crove_kernel.conversation_draft')
          .set({ state: 'used', body: null, draft_length: d.body.length, final_length: input.body.length, edit_size: editSize(d.body, input.body), decided_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', d.id)
          .execute();
      } else {
        await ctx.trx.updateTable('crove_kernel.conversation_draft').set({ state: 'discarded', body: null, decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', d.id).execute();
      }
    }
    if (input.savedReplyId) {
      await ctx.trx.updateTable('crove_kernel.saved_reply').set({ use_count: sql<number>`use_count + 1` }).where('org_id', '=', ctx.orgId).where('id', '=', input.savedReplyId).execute();
    }
    if (conversation.kind === 'email') await queueEmailReply(ctx, conversation, message.id, input.body);
    else await ctx.emit(REPLY_QUEUED, { conversationId: conversation.id, messageId: message.id, connectionId: conversation.channel_connection_id });
    ctx.audit({ conversation_id: conversation.id, message_id: message.id, length: input.body.length, ...(usedDraft ? { draft_id: input.draftId } : {}) });
    return { messageId: message.id, seq };
  },
});

// Sends a one-shot private reply in Messenger to a customer's comment on a Facebook Page post (CV4, #2308, plan section 7): opens a `direct`
// conversation linked to the comment thread (`parent_conversation_id`) with `external_thread_id = 'private:' + comment.external_message_id`,
// queues the message, and emits `REPLY_QUEUED`. When the customer answers in Messenger, Meta delivers a standard `messages` webhook under
// their PSID and the conversation continues there.
export const conversationReplyPrivately = defineCommand({
  name: 'kernel.conversation.reply_privately',
  input: zConversationPrivateReply,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation_message', id: input.messageId }),
  handler: async (ctx, input): Promise<ConversationPrivateReplied> => {
    const me = requireUser(ctx);
    refuseUnfilledPlaceholder(input.body);
    const comment = await ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select(['id', 'conversation_id', 'channel_connection_id', 'kind', 'direction', 'external_message_id', 'author_identity_id', 'sent_at', 'platform_removed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .forUpdate()
      .executeTakeFirst();
    if (!comment) throw messageNotFound();
    if (comment.kind !== 'comment_thread' || comment.direction !== 'in' || comment.platform_removed_at !== null || !comment.external_message_id) {
      throw new DomainError('REPLY_NOT_SUPPORTED', 409, 'Chỉ có thể trả lời riêng cho bình luận của khách hàng');
    }
    const parentConv = await lockConversation(ctx, comment.conversation_id);
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'status', 'scopes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', comment.channel_connection_id)
      .executeTakeFirst();
    if (!connection || connection.status !== 'active') {
      throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    }
    if (connection.provider !== 'facebook_page' && connection.provider !== 'instagram' && connection.provider !== 'sandbox') {
      throw new DomainError('REPLY_NOT_SUPPORTED', 409, 'Kênh này chưa hỗ trợ trả lời riêng cho bình luận');
    }
    if (connection.provider === 'facebook_page' && !connection.scopes.includes('pages_messaging')) {
      throw new DomainError('CHANNEL_SCOPE_MISSING', 409, 'Trang Facebook chưa cấp quyền nhắn tin Messenger (pages_messaging), hãy kết nối lại kênh');
    }
    if (connection.provider === 'instagram' && !connection.scopes.includes('instagram_manage_messages')) {
      throw new DomainError('CHANNEL_SCOPE_MISSING', 409, 'Tài khoản Instagram chưa cấp quyền nhắn tin (instagram_manage_messages), hãy kết nối lại kênh');
    }
    if (connection.provider === 'instagram' && input.body.length > CONVERSATION_INSTAGRAM_DIRECT_MAX) {
      throw new DomainError('REPLY_TOO_LONG', 422, `Câu trả lời dài tối đa ${CONVERSATION_INSTAGRAM_DIRECT_MAX} ký tự`, { max: String(CONVERSATION_INSTAGRAM_DIRECT_MAX) });
    }
    if (ctx.now.getTime() - comment.sent_at.getTime() > 7 * 24 * HOUR_MS) {
      throw new DomainError('PRIVATE_REPLY_WINDOW_CLOSED', 409, 'Đã quá 7 ngày kể từ khi khách bình luận, Meta không còn cho phép trả lời riêng');
    }
    const access = await sql<{ ok: boolean }>`SELECT crove_kernel.conversation_access('direct', ${connection.id}::uuid, true) AS ok`.execute(ctx.trx);
    if (!access.rows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'Bạn không có quyền gửi tin nhắn riêng trên kênh này');
    }
    const identityId = comment.author_identity_id ?? parentConv.identity_id;
    if (!identityId) {
      throw new DomainError('NO_RECIPIENT', 409, 'Bình luận này không có thông tin người gửi để trả lời riêng');
    }
    const linked = await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .select('party_id')
      .where('org_id', '=', ctx.orgId)
      .where('identity_id', '=', identityId)
      .where('kind', '=', 'direct')
      .where('party_id', 'is not', null)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const externalThreadId = `private:${comment.external_message_id}`;
    await ctx.trx
      .insertInto('crove_kernel.conversation')
      .values({
        org_id: ctx.orgId,
        channel_connection_id: connection.id,
        kind: 'direct',
        external_thread_id: externalThreadId,
        external_post_id: parentConv.external_post_id,
        parent_conversation_id: parentConv.id,
        identity_id: identityId,
        party_id: linked?.party_id ?? null,
        status: 'pending',
        assignee_user_id: me,
        opened_at: ctx.now,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'kind', 'external_thread_id']).doNothing())
      .execute();
    const directConv = (await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .select(CONVERSATION_COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connection.id)
      .where('kind', '=', 'direct')
      .where('external_thread_id', '=', externalThreadId)
      .forUpdate()
      .executeTakeFirstOrThrow()) as ConversationRow;
    const existingMsg = await ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', directConv.id)
      .where('direction', '=', 'out')
      .where('send_state', 'in', ['queued', 'sending', 'sent', 'unknown'])
      .limit(1)
      .executeTakeFirst();
    if (existingMsg) {
      throw new DomainError('PRIVATE_REPLY_ALREADY_SENT', 409, 'Bình luận này đã được gửi tin nhắn trả lời riêng');
    }
    const seq = directConv.last_seq + 1;
    const message = await ctx.trx
      .insertInto('crove_kernel.conversation_message')
      .values({
        org_id: ctx.orgId,
        conversation_id: directConv.id,
        channel_connection_id: connection.id,
        kind: 'direct',
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
        assignee_user_id: directConv.assignee_user_id ?? me,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', directConv.id)
      .execute();
    await markRead(ctx, directConv.id, me, seq);
    await ctx.emit(REPLY_QUEUED, { conversationId: directConv.id, messageId: message.id, connectionId: connection.id });
    ctx.audit({
      conversation_id: directConv.id,
      parent_conversation_id: parentConv.id,
      comment_message_id: comment.id,
      message_id: message.id,
      length: input.body.length,
    });
    return { conversationId: directConv.id, messageId: message.id, seq };
  },
});

// An email reply (#2439) is a mail of the kernel pipeline (ADR-0034), queued in the transaction that wrote the message: the mail queue renders
// it from the template, sends it once, and records the outcome, which settles the message (settleEmailReply in mail.ts). The mail's own
// Message-ID becomes the message's external id, so the customer's next reply, which names it, finds this thread. In-Reply-To names the customer's
// last mail and References the chain it carried, so the customer's client threads the answer.
export const EMAIL_REPLY_SOURCE = 'kernel.conversation.reply';
export const EMAIL_REPLY_TEMPLATE = 'kernel.conversation_reply';
async function queueEmailReply(ctx: CommandContext, conversation: ConversationRow, messageId: string, body: string): Promise<void> {
  const to = conversation.identity_id
    ? await ctx.trx.selectFrom('crove_kernel.conversation_identity').select('external_user_id').where('org_id', '=', ctx.orgId).where('id', '=', conversation.identity_id).executeTakeFirst()
    : undefined;
  if (!to) throw new DomainError('NO_RECIPIENT', 409, 'Hội thoại này chưa có địa chỉ người nhận');
  const last = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select(['external_message_id', 'email_refs'])
    .where('org_id', '=', ctx.orgId)
    .where('conversation_id', '=', conversation.id)
    .where('direction', '=', 'in')
    .where('external_message_id', 'is not', null)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const refs = last?.external_message_id ? [...new Set([...last.email_refs, last.external_message_id])].slice(-EMAIL_REFS_MAX) : [];
  const meta = await ctx.trx
    .selectFrom('crove_kernel.conversation')
    .innerJoin('crove_kernel.tenant', 'crove_kernel.tenant.org_id', 'crove_kernel.conversation.org_id')
    .select(['crove_kernel.conversation.subject as subject', 'crove_kernel.tenant.name as org_name'])
    .where('crove_kernel.conversation.org_id', '=', ctx.orgId)
    .where('crove_kernel.conversation.id', '=', conversation.id)
    .executeTakeFirstOrThrow();
  const subject = meta.subject ? (/^\s*re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`) : `Trả lời từ ${meta.org_name}`;
  const mail = await createMailMessage(ctx, {
    stream: 'transactional',
    source: EMAIL_REPLY_SOURCE,
    sourceId: messageId,
    templateKey: EMAIL_REPLY_TEMPLATE,
    to: to.external_user_id,
    subject: subject.slice(0, 300),
    payload: { org: meta.org_name, text: body, inReplyTo: last?.external_message_id ?? null, references: refs },
    status: 'queued',
  });
  await ctx.trx
    .updateTable('crove_kernel.conversation_message')
    .set({ external_message_id: mail.messageIdHeader, ...(mail.status === 'suppressed' ? { send_state: 'failed', send_error_code: 'SUPPRESSED' } : {}) })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', messageId)
    .execute();
}

export interface ReplyWork {
  action: 'none' | 'call';
  reason?: 'in_flight' | 'settled' | 'channel_inactive';
  messageId?: string;
  callKey?: string;
  provider?: string;
  connectionId?: string;
  connectionVersion?: string;
  kind?: Exclude<ConversationKind, 'email'>;
  threadId?: string;
  postId?: string | null;
  contactId?: string;
  lastInboundAt?: string | null;
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
    // An email reply goes through the mail queue, which sends it and settles the message (settleEmailReply): there is no platform call here.
    if (message.kind === 'email') return { action: 'none', reason: 'settled' };
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
      .select(['crove_kernel.conversation.external_thread_id as thread', 'crove_kernel.conversation.external_post_id as post', 'crove_kernel.conversation.last_inbound_at as lastInboundAt', 'i.external_user_id as contact'])
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
      lastInboundAt: conversation.lastInboundAt ? conversation.lastInboundAt.toISOString() : null,
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
    // An email whose send is unknown may have gone out: it is not sent again blindly (a second copy would reach the customer), a person marks it sent.
    if (message.kind === 'email' && message.send_state === 'unknown') {
      throw new DomainError('EMAIL_SEND_UNKNOWN', 409, 'Thư này có thể đã đi. Hãy kiểm tra rồi đánh dấu là đã gửi');
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
    // An email goes out again as a new mail of the pipeline; any other channel as a new call of the worker.
    if (message.kind === 'email') await queueEmailReply(ctx, await lockConversation(ctx, message.conversation_id), message.id, message.body);
    else await ctx.emit(REPLY_QUEUED, { conversationId: message.conversation_id, messageId: message.id, connectionId: message.channel_connection_id });
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
  if (conversation.kind === 'direct' || conversation.kind === 'email') {
    // A private message or an email is handled by a member who holds the permission to read it (the desk.agent role, CV3), through an org-wide assignment.
    const held = await ctx.trx
      .selectFrom('crove_kernel.role_assignment as a')
      .innerJoin('crove_kernel.role_permission as p', 'p.role_key', 'a.role_key')
      .select('a.id')
      .where('a.org_id', '=', ctx.orgId)
      .where('a.user_id', '=', userId)
      .where('a.legal_entity_id', 'is', null)
      .where('p.permission', '=', 'kernel.conversation.direct.read')
      .executeTakeFirst();
    if (!held) return false;
  }
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
        // A thread whose sender nobody vouched for does not get the link from another thread: a person links it (seeing its mark) or it keeps none.
        .where('sender_unverified', '=', false)
        .execute();
    }
    ctx.audit({ conversation_id: conversation.id, party_id: input.partyId });
    return { conversationId: conversation.id };
  },
});

// A person applies an intent to a thread, changes it or clears it (CV3, #2306): their own decision, in their name. What the AI coworker suggests is read
// apart (kernel.conversation.intent_source feeds it) and never stored; this label is the only thing kept, and the database refuses every writer but a
// person. Nothing is routed, assigned, resolved or hidden by it. The audit row holds the label (one of five words), never a text.
export const conversationSetIntent = defineCommand({
  name: 'kernel.conversation.set_intent',
  input: zConversationSetIntent,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ conversationId: string; intent: ConversationIntent | null }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    const row = await ctx.trx.selectFrom('crove_kernel.conversation').select('intent').where('org_id', '=', ctx.orgId).where('id', '=', conversation.id).executeTakeFirstOrThrow();
    const before = (row.intent as ConversationIntent | null) ?? null;
    if (before !== input.intent) {
      await ctx.trx
        .updateTable('crove_kernel.conversation')
        .set({ intent: input.intent, intent_set_by: input.intent ? me : null, intent_set_at: input.intent ? ctx.now : null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', conversation.id)
        .execute();
    }
    ctx.audit({ conversation_id: conversation.id, label: input.intent, before, ...(before === input.intent ? { unchanged: true } : {}) });
    return { conversationId: conversation.id, intent: input.intent };
  },
});

export interface IntentSource {
  id: string;
  lastSeq: number;
  // The customer's last messages (tainted external text), oldest first, each cut short.
  texts: string[];
}

// What the intent suggestion reads: for each of the threads the caller may read (row-level security decides, so a thread they may not read is not here),
// the customer's last messages. Read only; the model call is made by the API's handler outside this transaction, through the AI meter.
export const conversationIntentSource = defineQuery({
  name: 'kernel.conversation.intent_source',
  input: zConversationIntentSuggest,
  access: WRITERS,
  handler: async (ctx, input): Promise<IntentSource[]> => {
    const { rows } = await sql<{ id: string; last_seq: number; texts: string[] | null }>`
      SELECT c.id, c.last_seq,
             (SELECT pg_catalog.array_agg(t.body ORDER BY t.seq) FROM (
                SELECT pg_catalog.left(m.body, ${CONVERSATION_INTENT_CHARS}) AS body, m.seq FROM crove_kernel.conversation_message m
                WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.direction = 'in' AND m.platform_removed_at IS NULL AND pg_catalog.btrim(m.body) <> ''
                ORDER BY m.seq DESC LIMIT ${CONVERSATION_INTENT_MESSAGES}) t) AS texts
      FROM crove_kernel.conversation c
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ANY(${input.conversationIds}::uuid[])`.execute(ctx.trx);
    const byId = new Map(rows.map((r) => [r.id, { id: r.id, lastSeq: r.last_seq, texts: r.texts ?? [] }]));
    // In the order asked, each thread once.
    return [...new Set(input.conversationIds)].flatMap((id) => {
      const found = byId.get(id);
      return found ? [found] : [];
    });
  },
});

export interface ContactCandidates {
  // The name the platform gave the customer (tainted), when it gave one.
  customerName: string | null;
  // Contacts of the org whose email is the address an email customer writes from (deterministic: the address, folded to lower case).
  email: Array<{ partyId: string; name: string }>;
  // Contacts of the org that carry a phone number the customer wrote in this thread (deterministic: the phone key).
  phone: Array<{ partyId: string; name: string }>;
  // Contacts whose name resembles the customer's (the words they share, ignoring case and Vietnamese marks), the likeliest first.
  names: Array<{ partyId: string; name: string }>;
}

// The contacts a thread's customer may be, for a person to link (CV3, #2306). A thread already linked has none to suggest. The phone match is
// deterministic: a number the customer wrote, in the form of the party's own phone key. The name match is the words the two names share. Row-level
// security applies to the thread and to the contacts, so a member sees only what they may. Nothing is linked here: link_contact is a person's click.
export const conversationContactCandidates = defineQuery({
  name: 'kernel.conversation.contact_candidates',
  input: zConversationContactMatches,
  access: WRITERS,
  handler: async (ctx, input): Promise<ContactCandidates> => {
    const { rows } = await sql<{ party_id: string | null; identity_name: string | null; address: string | null }>`
      SELECT c.party_id, i.display_name AS identity_name, CASE WHEN c.kind = 'email' AND NOT c.sender_unverified THEN i.external_user_id END AS address
      FROM crove_kernel.conversation c
      LEFT JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ${input.conversationId}::uuid`.execute(ctx.trx);
    const thread = rows[0];
    if (!thread) throw notFound();
    const none: ContactCandidates = { customerName: thread.identity_name, email: [], phone: [], names: [] };
    if (thread.party_id !== null) return none;
    // An email customer's address is the deterministic key: a contact that carries it (ignoring case) is the first candidate. Not for a sender the
    // receiving server did not vouch for: anyone can write a customer's address in From.
    const byEmail =
      thread.address === null
        ? []
        : (
            await sql<{ id: string; name: string }>`
              SELECT p.id, p.name FROM crove_kernel.party p
              WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND p.email IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(p.email)) = ${thread.address}
              ORDER BY p.name, p.id LIMIT ${CONVERSATION_CONTACT_MATCHES_MAX}`.execute(ctx.trx)
          ).rows;
    // The numbers the customer wrote in this thread, most recent messages first.
    const written = await sql<{ body: string }>`
      SELECT pg_catalog.left(m.body, 2000) AS body FROM crove_kernel.conversation_message m
      WHERE m.org_id = ${ctx.orgId}::uuid AND m.conversation_id = ${input.conversationId}::uuid AND m.direction = 'in' AND m.platform_removed_at IS NULL
      ORDER BY m.seq DESC LIMIT 20`.execute(ctx.trx);
    const keys: string[] = [];
    for (const { body } of written.rows) for (const key of phoneKeysIn(body)) if (!keys.includes(key) && keys.length < 3) keys.push(key);
    const phone =
      keys.length === 0
        ? []
        : (
            await sql<{ id: string; name: string }>`
              SELECT p.id, p.name FROM crove_kernel.party p
              WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND p.phone IS NOT NULL AND crove_kernel.phone_key(p.phone) = ANY(${keys}::text[])
              ORDER BY p.name, p.id LIMIT ${CONVERSATION_CONTACT_MATCHES_MAX}`.execute(ctx.trx)
          ).rows;
    // Words of two letters or more, folded; a one-word name needs that word, a longer one needs two of its words, so "Nguyễn" alone does not match everyone.
    // The stored search column (its GIN index) narrows the contacts to those with any of the words before a name is folded, so a big address book is not
    // folded name by name.
    const names =
      thread.identity_name === null
        ? []
        : (
            await sql<{ id: string; name: string }>`
              WITH tok AS (
                SELECT DISTINCT w FROM pg_catalog.unnest(pg_catalog.string_to_array(crove_kernel.search_fold(${thread.identity_name}), ' ')) AS w WHERE pg_catalog.length(w) >= 2
              ), need AS (SELECT LEAST(2, pg_catalog.count(*))::int AS n FROM tok),
              q AS (SELECT pg_catalog.to_tsquery('pg_catalog.simple', pg_catalog.string_agg(w, ' | ')) AS tsq FROM tok),
              near AS (
                SELECT p.id, p.name, crove_kernel.search_fold(p.name) AS folded FROM crove_kernel.party p, q
                WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND p.search @@ q.tsq
              )
              SELECT near.id, near.name FROM near JOIN tok ON pg_catalog.strpos(' ' || near.folded || ' ', ' ' || tok.w || ' ') > 0
              GROUP BY near.id, near.name HAVING pg_catalog.count(*) >= (SELECT n FROM need) AND (SELECT n FROM need) > 0
              ORDER BY pg_catalog.count(*) DESC, near.name, near.id LIMIT ${CONVERSATION_CONTACT_MATCHES_MAX + 3}`.execute(ctx.trx)
          ).rows;
    const known = new Set([...byEmail, ...phone].map((r) => r.id));
    return {
      customerName: thread.identity_name,
      email: byEmail.map((r) => ({ partyId: r.id, name: r.name })),
      phone: phone.filter((r) => !byEmail.some((e) => e.id === r.id)).map((r) => ({ partyId: r.id, name: r.name })),
      names: names.filter((r) => !known.has(r.id)).map((r) => ({ partyId: r.id, name: r.name })),
    };
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
// The inbox (CV3, #2306): who is replying, who is available, whom a new conversation is told to, and the Home read
// ---------------------------------------------------------------------------------------------------------------------

// The notification kind of a conversation that needs an answer: ids only, the screen reads the thread itself.
export const CONVERSATION_NEW = 'kernel.conversation_new';
// A thread whose newest customer message is older than this is not told as new.
const NEW_NOTICE_AGE_MS = 24 * 3_600_000;

// Tells the members who can answer a conversation that has become New: the assignee when there is one and they can read it; else the available
// members who can read it; else the owners and admins (whoever is away). The readers are those the database lets read the thread
// (crove_kernel.conversation_readers, the same rule as conversation_access, never a viewer). One notification per member for each time a thread becomes
// New (the key carries the message that did it), no text in it.
async function routeNewConversation(ctx: CommandContext, conversationId: string, assignee: string | null, seq: number): Promise<number> {
  const { rows } = await sql<{ user_id: string; available: boolean }>`SELECT user_id, available FROM crove_kernel.conversation_readers(${conversationId}::uuid)`.execute(ctx.trx);
  // A member who turned this kind off is not told: the choice below is made among those who did not, so the fallback still runs when the available
  // readers all muted it.
  const muted = new Set((await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.notification_mute WHERE org_id = ${ctx.orgId}::uuid AND kind = ${CONVERSATION_NEW}`.execute(ctx.trx)).rows.map((r) => r.user_id));
  const open = rows.filter((r) => !muted.has(r.user_id));
  let users: string[] = [];
  if (assignee && open.some((r) => r.user_id === assignee)) users = [assignee];
  else {
    users = open.filter((r) => r.available).map((r) => r.user_id);
    if (users.length === 0) {
      const admins = new Set(await ownersAndAdmins(ctx));
      users = open.filter((r) => admins.has(r.user_id)).map((r) => r.user_id);
    }
  }
  if (users.length === 0) return 0;
  return notifyMembers(ctx, { kind: CONVERSATION_NEW, users, key: `conversation:${conversationId}:${seq}`, subject: { type: 'kernel.conversation', id: conversationId } });
}

// "Linh is replying": a member typing a reply marks the thread for 60 seconds, at most once in 20 seconds per thread and member (a later call inside the
// window changes nothing and answers `marked: false`). The marker is read with the thread (the summary's `composing`), by those who read it, never
// the member's own; the member who sends (or leaves) removes theirs. No text: the thread's id in the audit row.
export const conversationComposing = defineCommand({
  name: 'kernel.conversation.composing',
  input: zConversationComposing,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ marked: boolean }> => {
    const me = requireUser(ctx);
    // The thread as this member reads it: one they may not read is not found, and the marker's own policy refuses one they may not write.
    const thread = await ctx.trx
      .selectFrom('crove_kernel.conversation')
      .select(['id', 'channel_connection_id', 'kind'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.conversationId)
      .executeTakeFirst();
    if (!thread) throw notFound();
    const current = await ctx.trx
      .selectFrom('crove_kernel.conversation_composing')
      .select('updated_at')
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', thread.id)
      .where('user_id', '=', me)
      .executeTakeFirst();
    if (current && ctx.now.getTime() - current.updated_at.getTime() < CONVERSATION_COMPOSING_EVERY_SECONDS * 1000) return { marked: false };
    const expires = new Date(ctx.now.getTime() + CONVERSATION_COMPOSING_SECONDS * 1000);
    await ctx.trx
      .insertInto('crove_kernel.conversation_composing')
      .values({ org_id: ctx.orgId, conversation_id: thread.id, channel_connection_id: thread.channel_connection_id, kind: thread.kind, user_id: me, expires_at: expires, updated_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'conversation_id', 'user_id']).doUpdateSet({ expires_at: expires, updated_at: ctx.now }))
      .execute();
    ctx.audit({ conversation_id: thread.id });
    return { marked: true };
  },
});

// A member's availability: available, or away (until a time, or until they say so). It only decides whom a new conversation is told to; an away member
// still reads and answers whatever they open.
export const conversationSetAvailability = defineCommand({
  name: 'kernel.conversation.set_availability',
  input: zAvailabilitySet,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<Availability['me']> => {
    const me = requireUser(ctx);
    const until = input.status === 'away' && input.until ? new Date(input.until) : null;
    if (until && until.getTime() <= ctx.now.getTime()) throw new DomainError('AVAILABILITY_PAST', 422, 'Giờ quay lại phải ở tương lai');
    await ctx.trx
      .insertInto('crove_kernel.member_availability')
      .values({ org_id: ctx.orgId, user_id: me, status: input.status, until, updated_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ status: input.status, until, updated_at: ctx.now }))
      .execute();
    ctx.audit({ status: input.status });
    return { userId: me, status: input.status, until: until ? until.toISOString() : null };
  },
});

// The team's availability for the inbox: every member who set it, and the caller's own (available when never set). An `until` that has passed reads as
// available again.
export const conversationAvailability = defineQuery({
  name: 'kernel.conversation.availability',
  input: z.strictObject({}),
  access: WRITERS,
  handler: async (ctx): Promise<Availability> => {
    const me = viewerOf(ctx);
    const rows = await ctx.trx.selectFrom('crove_kernel.member_availability').select(['user_id', 'status', 'until']).where('org_id', '=', ctx.orgId).orderBy('user_id').execute();
    const now = Date.now();
    const entry = (r: { user_id: string; status: string; until: Date | null }): Availability['me'] => {
      const over = r.status === 'away' && r.until !== null && r.until.getTime() <= now;
      return { userId: r.user_id, status: over ? 'available' : (r.status as 'available' | 'away'), until: over || r.until === null ? null : r.until.toISOString() };
    };
    const members = rows.map(entry);
    return { me: members.find((m) => m.userId === me) ?? { userId: me ?? '', status: 'available', until: null }, members };
  },
});

// Home's "Hôm nay cần bạn" (#2383): the conversations that wait for this member, read by the member's own rule (a thread they may not read, because of a
// channel limit or a missing direct-message permission, is not here): New and unassigned, or assigned to them, with the customer's message last. One
// item that counts them and the oldest few, each with the end of the platform's reply window when there is one. No text and no name: the items carry
// the channel's provider code and an id, and `href` is a path inside the org (Home puts the org in front). A viewer cannot answer, so reads none.
const TODAY_CONVERSATIONS = 5;
export const conversationToday = defineQuery({
  name: 'kernel.conversation.today',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<TodayItem[]> => {
    const me = viewerOf(ctx);
    if (!me || ctx.role === 'viewer') return [];
    const waiting = sql`FROM crove_kernel.conversation c JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.channel_connection_id
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.status = 'new' AND (c.assignee_user_id IS NULL OR c.assignee_user_id = ${me}::uuid)`;
    const { rows: total } = await sql<{ n: string }>`SELECT count(*)::text AS n ${waiting}`.execute(ctx.trx);
    const count = Number(total[0]?.n ?? 0);
    if (count === 0) return [];
    const { rows } = await sql<{ id: string; provider: string; reply_window_until: Date | null }>`
      SELECT c.id, ch.provider, c.reply_window_until ${waiting} ORDER BY c.last_inbound_at ASC NULLS LAST, c.id LIMIT ${TODAY_CONVERSATIONS}`.execute(ctx.trx);
    const items: TodayItem[] = [{ kind: 'message', app: 'conversations', id: 'unanswered', title: { key: 'conversations.unanswered', params: { count } }, count, href: '/social/inbox?status=new' }];
    for (const r of rows) {
      items.push({
        kind: 'message',
        app: 'conversations',
        id: `conversation:${r.id}`,
        title: { key: 'conversations.oneUnanswered', params: { provider: r.provider } },
        ...(r.reply_window_until ? { dueAt: r.reply_window_until.toISOString() } : {}),
        href: `/social/inbox?c=${r.id}`,
      });
    }
    return zTodayItems.parse(items);
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
  // The mails the org sent in answer on an email thread (#2439) carry the customer's address, their subject and the answer's text: all three are dropped
  // with the thread (the keyed hash stays, so a bounce still suppresses the address). A mail still queued then fails at send time with no address.
  await sql`
    UPDATE crove_kernel.mail_message mm SET to_address = NULL, subject = NULL, payload = NULL
    WHERE mm.org_id = ${ctx.orgId}::uuid AND mm.source = ${EMAIL_REPLY_SOURCE} AND (mm.to_address IS NOT NULL OR mm.subject IS NOT NULL OR mm.payload IS NOT NULL)
      AND mm.source_id IN (SELECT m.id FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
                           WHERE m.org_id = ${ctx.orgId}::uuid AND c.kind = 'email' AND ${filter})`.execute(ctx.trx);
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
    // The customer's lock first: an intake of theirs in flight finishes before this reads or deletes, and one that starts later sees the tombstone.
    const subjectRow = subject
      ? await ctx.trx.selectFrom('crove_kernel.conversation_identity').select(['provider', 'external_user_id']).where('org_id', '=', ctx.orgId).where('id', '=', subject).executeTakeFirst()
      : undefined;
    if (subjectRow) await customerLock(ctx, subjectRow.provider, subjectRow.external_user_id);
    const filter = subject ? sql`c.identity_id = ${subject}::uuid` : sql`c.id = ${conversation.id}::uuid`;
    const erased = await deleteThreads(ctx, filter);
    if (subject) {
      // What the customer wrote in other people's comment threads goes too, wherever it is (a reply is stored with the thread, not with
      // its author).
      const others = await sql<{ conversation_id: string }>`
        DELETE FROM crove_kernel.conversation_message m WHERE m.org_id = ${ctx.orgId}::uuid AND m.author_identity_id = ${subject}::uuid RETURNING m.conversation_id`.execute(ctx.trx);
      erased.messages += others.rows.length;
      // A draft Vy wrote in one of those threads read what the customer wrote: it goes stale with its text.
      await staleDrafts(ctx, [...new Set(others.rows.map((r) => r.conversation_id))]);
      // The identity stays as a tombstone: no name, no party, and no platform id, only a keyed hash of it, so the intake still recognises
      // the customer (and refuses anything dated at or before now) while a copy of the database or the export cannot name them.
      const who = subjectRow;
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

// ---------------------------------------------------------------------------------------------------------------------
// What the worker reads beyond the webhook (CV5b, #2329). The platform calls are the worker's; these commands only say what to ask,
// and record what came back. Nothing of a name or a message is in an audit row, only ids and flags.
// ---------------------------------------------------------------------------------------------------------------------

// How far back one history read goes, and so how far back a message may be brought in: shorter than the erase tombstone (30 days), so a
// message of an erased customer cannot come back through it.
const HISTORY_WINDOW_DAYS = 7;

// Hands the worker a read from a platform: its account's recent history, or a customer's name. The relay calls it for what
// crove_kernel.conversation_sync_due lists, and it marks the work as handed out (for 30 minutes, 10 for a name), so the same work is not
// handed out every pass; its event is what the worker's queue takes (as a reply's is), so the platform call is made by a job with only
// ids in it. R2 and external, like a reply: the call it leads to reaches a platform.
export const conversationSyncRequest = defineCommand({
  name: 'kernel.conversation.sync_request',
  input: zConversationSyncRequest,
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ queued: boolean }> => {
    requireSystem(ctx);
    const connection = await connectionOf(ctx, input.connectionId);
    if (!connection || connection.status !== 'active') return { queued: false };
    if (input.action === 'history') {
      await ctx.trx.updateTable('crove_kernel.channel_connection').set({ history_requested_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
      await ctx.emit(SYNC_QUEUED, { action: 'history', connectionId: input.connectionId });
    } else {
      await ctx.trx.updateTable('crove_kernel.conversation_identity').set({ profile_requested_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.identityId).execute();
      await ctx.emit(SYNC_QUEUED, { action: 'profile', connectionId: input.connectionId, identityId: input.identityId });
    }
    ctx.audit({ action: input.action, connection_id: input.connectionId });
    return { queued: true };
  },
});

export interface HistoryWork {
  action: 'call' | 'none';
  provider?: string;
  since?: string;
}

export const conversationHistoryBegin = defineCommand({
  name: 'kernel.conversation.history_begin',
  input: zConversationHistoryBegin,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<HistoryWork> => {
    requireSystem(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'scopes', 'history_synced_at', 'connected_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || row.status !== 'active') return { action: 'none' };
    // A Facebook Page connected without pages_read_user_content or an Instagram account connected without instagram_manage_comments
    // has no comment-reading permission for history reconciliation: mark its sync timestamp so the sweep does not ask again for an
    // hour, and make no platform call.
    if (
      (row.provider === 'facebook_page' && !row.scopes.includes('pages_read_user_content')) ||
      (row.provider === 'instagram' && !row.scopes.includes('instagram_manage_comments'))
    ) {
      await ctx.trx
        .updateTable('crove_kernel.channel_connection')
        .set({ history_synced_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
      return { action: 'none' };
    }
    // Back to the last read, or to the connection's start, and never further than the window.
    const floor = new Date(ctx.now.getTime() - HISTORY_WINDOW_DAYS * 24 * HOUR_MS);
    const from = row.history_synced_at ?? row.connected_at;
    return { action: 'call', provider: row.provider, since: (from && from.getTime() > floor.getTime() ? from : floor).toISOString() };
  },
});

export const conversationHistoryRecord = defineCommand({
  name: 'kernel.conversation.history_record',
  input: zConversationHistoryRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ complete: boolean }> => {
    requireSystem(ctx);
    // A read that reached back everywhere leaves no gap (and clears an older one); else the period is kept for the threads to show.
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set(
        input.complete
          ? { history_synced_at: ctx.now, gap_from: null, gap_to: null }
          : { history_synced_at: ctx.now, gap_from: input.gapFrom ? new Date(input.gapFrom) : null, gap_to: input.gapTo ? new Date(input.gapTo) : ctx.now },
      )
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    ctx.audit({ connection_id: input.connectionId, complete: input.complete });
    return { complete: input.complete };
  },
});

export interface ProfileWork {
  action: 'call' | 'none';
  provider?: string;
  contactId?: string;
}

export const conversationProfileBegin = defineCommand({
  name: 'kernel.conversation.profile_begin',
  input: zConversationProfileBegin,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_identity', id: input.identityId }),
  handler: async (ctx, input): Promise<ProfileWork> => {
    requireSystem(ctx);
    const identity = await ctx.trx
      .selectFrom('crove_kernel.conversation_identity')
      .select(['provider', 'external_user_id', 'display_name', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.identityId)
      .executeTakeFirst();
    const connection = await connectionOf(ctx, input.connectionId);
    // A customer erased, already named or with no live connection is not asked about.
    if (!identity || identity.erased_at || identity.display_name || !connection || connection.status !== 'active' || connection.provider !== identity.provider) return { action: 'none' };
    return { action: 'call', provider: identity.provider, contactId: identity.external_user_id };
  },
});

export const conversationProfileApply = defineCommand({
  name: 'kernel.conversation.profile_apply',
  input: zConversationProfileApply,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_identity', id: input.identityId }),
  handler: async (ctx, input): Promise<{ named: boolean }> => {
    requireSystem(ctx);
    // A name the platform gave is kept only where there is none yet and the customer has not been erased since; `retry` leaves the
    // customer to be asked again.
    const set = input.retry
      ? { updated_at: ctx.now }
      : input.displayName
        ? { display_name: input.displayName, profile_checked_at: ctx.now, updated_at: ctx.now }
        : { profile_checked_at: ctx.now, updated_at: ctx.now };
    const res = await ctx.trx
      .updateTable('crove_kernel.conversation_identity')
      .set(set)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.identityId)
      .where('erased_at', 'is', null)
      .where('display_name', 'is', null)
      .executeTakeFirst();
    const named = !input.retry && input.displayName !== null && Number(res.numUpdatedRows) > 0;
    ctx.audit({ identity_id: input.identityId, named, retry: input.retry });
    return { named };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Customers' images (CV5c, #2357). The platform fetch is the worker's; these commands say what to fetch and record what came back. An image
// is a conversation_attachment row (never a kernel file), read by those who read its message; its address is personal data, never in an
// audit row, an event, a log or a job.
// ---------------------------------------------------------------------------------------------------------------------

// Hands the worker one pending image to fetch: marks it handed out (the relay asks again after a few minutes if the job did not finish; only a
// fetch that failed and may be asked again counts as a try, in attachment_record) and
// emits the event the queue takes, with ids only. R2 and external, like a reply: the call it leads to reaches the platform's media host.
export const conversationAttachmentRequest = defineCommand({
  name: 'kernel.conversation.attachment_request',
  input: zConversationAttachmentRequest,
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_attachment', id: input.attachmentId }),
  handler: async (ctx, input): Promise<{ queued: boolean }> => {
    requireSystem(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.conversation_attachment')
      .select(['channel_connection_id', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.state !== 'pending') return { queued: false };
    const connection = await connectionOf(ctx, row.channel_connection_id);
    if (!connection || connection.status !== 'active') return { queued: false };
    await ctx.trx
      .updateTable('crove_kernel.conversation_attachment')
      .set({ requested_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .execute();
    await ctx.emit(ATTACHMENT_QUEUED, { attachmentId: input.attachmentId, connectionId: row.channel_connection_id });
    ctx.audit({ attachment_id: input.attachmentId });
    return { queued: true };
  },
});

export interface AttachmentSource {
  provider: string;
  // The platform's address of the image: personal data, read here for the one fetch and put nowhere.
  sourceUrl: string;
  storageKey: string;
}

// What the fetch needs, for a pending image of an active connection; null when there is nothing to fetch (the image was erased, dropped,
// or already stored), so a job that outlived its row stops.
export const conversationAttachmentSource = defineQuery({
  name: 'kernel.conversation.attachment_source',
  input: zConversationAttachmentSource,
  access: 'system',
  handler: async (ctx, input): Promise<AttachmentSource | null> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.conversation_attachment')
      .select(['channel_connection_id', 'state', 'source_url', 'storage_key'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .executeTakeFirst();
    if (!row || row.state !== 'pending' || !row.source_url) return null;
    const connection = await connectionOf(ctx, row.channel_connection_id);
    if (!connection || connection.status !== 'active') return null;
    return { provider: connection.provider, sourceUrl: row.source_url, storageKey: row.storage_key };
  },
});

// Records what the fetch came to. Stored: the bytes are in the store under the reserved key, so the row becomes final, the address is cleared
// and the message lists it. Failed: asking again later (the row stays and the relay hands it out again after the retry time, up to five
// tries) or never (the row goes, with its address, and the message keeps its placeholder). A row that is gone (the customer was erased, the
// message removed, the six days passed) records nothing: the blob the fetch wrote is then queued by the row's own deletion and removed.
export const conversationAttachmentRecord = defineCommand({
  name: 'kernel.conversation.attachment_record',
  input: zConversationAttachmentRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_attachment', id: input.attachmentId }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    requireSystem(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.conversation_attachment')
      .select(['message_id', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.state !== 'pending') return { recorded: false };
    if (input.outcome === 'stored') {
      await ctx.trx
        .updateTable('crove_kernel.conversation_attachment')
        .set({
          state: 'stored',
          source_url: null,
          generation: input.generation,
          sha256: input.sha256,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          width: input.width,
          height: input.height,
          stored_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.attachmentId)
        .execute();
      await ctx.trx
        .updateTable('crove_kernel.conversation_message')
        .set({ attachments: sql<string[]>`pg_catalog.array_append(attachments, ${input.attachmentId}::uuid)` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.message_id)
        .execute();
      ctx.audit({ attachment_id: input.attachmentId, outcome: 'stored', size_bytes: input.sizeBytes, content_type: input.contentType });
      return { recorded: true };
    }
    if (!input.retry) {
      await ctx.trx.deleteFrom('crove_kernel.conversation_attachment').where('org_id', '=', ctx.orgId).where('id', '=', input.attachmentId).execute();
    } else {
      // A fetch that was made and may be asked again: it counts as a try (five at most; a hand-out that no job ran does not).
      await ctx.trx
        .updateTable('crove_kernel.conversation_attachment')
        .set({ fetch_attempts: sql<number>`fetch_attempts + 1` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.attachmentId)
        .execute();
    }
    ctx.audit({ attachment_id: input.attachmentId, outcome: input.retry ? 'retry' : 'dropped', code: input.code });
    return { recorded: true };
  },
});

export interface AttachmentFile {
  id: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  generation: string;
  storageKey: string;
}

// The stored image the caller may read, for the authenticated route that serves its bytes. Row-level security is the whole rule: an image of
// a message the caller cannot read is not found, the same answer as one that does not exist.
export const conversationAttachmentGet = defineQuery({
  name: 'kernel.conversation.attachment_get',
  input: zConversationAttachmentGet,
  access: ALL,
  handler: async (ctx, input): Promise<AttachmentFile> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.conversation_attachment')
      .select(['id', 'content_type', 'size_bytes', 'sha256', 'generation', 'storage_key'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .where('state', '=', 'stored')
      .executeTakeFirst();
    if (!row || !row.content_type || row.size_bytes === null || !row.sha256 || !row.generation) throw new DomainError('ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
    return { id: row.id, contentType: row.content_type, sizeBytes: row.size_bytes, sha256: row.sha256, generation: row.generation, storageKey: row.storage_key };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Vy's drafts and the saved replies (CV8, #2310). A draft is written by the system context, never by an org-chart agent: a worker job reads the end of
// the thread (customer text: tainted), calls the model in packages/agent and records the answer. A member asks for a draft and decides about it; the text
// and the tainted mark are the system's alone (crove_kernel.conversation_draft_guard). Nothing the customer or Vy wrote is in an audit row, an event or a
// job: those carry ids, lengths and codes.
// ---------------------------------------------------------------------------------------------------------------------

// The words of a text as saved replies are matched by them: lower case, no diacritics (Vietnamese "đ" is "d"), letters and digits only.
export function replyWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'd')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

// The saved replies that answer a customer's text, best first (at most `limit`): a reply scores one for each of its keywords the text contains as a
// whole word or phrase (a keyword may be several words: "giờ mở cửa"), and a reply that matches none is not offered.
export function matchSavedReplies<T extends { keywords: readonly string[]; useCount: number; title: string }>(text: string, replies: readonly T[], limit = 3): T[] {
  const words = replyWords(text);
  if (words.length === 0) return [];
  const padded = ` ${words.join(' ')} `;
  return replies
    .map((r) => ({ r, score: new Set(r.keywords.map((k) => replyWords(k).join(' ')).filter((k) => k !== '' && padded.includes(` ${k} `))).size }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.useCount - a.r.useCount || a.r.title.localeCompare(b.r.title))
    .slice(0, limit)
    .map((x) => x.r);
}

// How far a sent reply is from the draft it began from: the characters between their common beginning and common ending, the larger of the two. A
// number for later learning; it says nothing of what was written.
export function editSize(draft: string, sent: string): number {
  const a = Array.from(draft);
  const b = Array.from(sent);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length - start - end, b.length - start - end);
}

interface SavedReplyRow {
  id: string;
  title: string;
  body: string;
  keywords: string[];
  use_count: number;
}
const toSavedReplyView = (r: SavedReplyRow): SavedReplyView => ({ id: r.id, title: r.title, body: r.body, keywords: r.keywords, useCount: r.use_count });
const savedRepliesOf = async (ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<SavedReplyView[]> =>
  (await ctx.trx.selectFrom('crove_kernel.saved_reply').select(['id', 'title', 'body', 'keywords', 'use_count']).where('org_id', '=', ctx.orgId).orderBy('title').orderBy('id').execute()).map(toSavedReplyView);

const savedReplyNotFound = () => new DomainError('SAVED_REPLY_NOT_FOUND', 404, 'Không tìm thấy câu trả lời mẫu này');
// A keyword is one short phrase: the empty ones and the repeats (after the matching's own reading) are dropped.
const cleanKeywords = (keywords: readonly string[]): string[] => [...new Map(keywords.map((k) => [replyWords(k).join(' '), k.trim()] as const).filter(([key]) => key !== '')).values()];

export const conversationSavedReplyList = defineQuery({
  name: 'kernel.conversation.saved_reply_list',
  input: zSavedReplyList,
  access: ALL,
  handler: async (ctx): Promise<SavedReplyListed> => ({ replies: await savedRepliesOf(ctx) }),
});

export const conversationSavedReplyCreate = defineCommand({
  name: 'kernel.conversation.saved_reply_create',
  input: zSavedReplyInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const me = requireUser(ctx);
    const have = await ctx.trx.selectFrom('crove_kernel.saved_reply').select(sql<string>`count(*)::text`.as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(have.n) >= SAVED_REPLIES_MAX) throw new DomainError('SAVED_REPLY_LIMIT', 409, `Mỗi tổ chức lưu tối đa ${SAVED_REPLIES_MAX} câu trả lời mẫu`, { max: String(SAVED_REPLIES_MAX) });
    const row = await ctx.trx
      .insertInto('crove_kernel.saved_reply')
      .values({ org_id: ctx.orgId, title: input.title, body: input.body, keywords: cleanKeywords(input.keywords), created_by: me, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ saved_reply_id: row.id, title_length: input.title.length, body_length: input.body.length, keywords: input.keywords.length });
    return { id: row.id };
  },
});

export const conversationSavedReplyUpdate = defineCommand({
  name: 'kernel.conversation.saved_reply_update',
  input: zSavedReplyUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.saved_reply', id: input.id }),
  handler: async (ctx, input): Promise<{ id: string }> => {
    requireUser(ctx);
    const res = await ctx.trx
      .updateTable('crove_kernel.saved_reply')
      .set({ title: input.title, body: input.body, keywords: cleanKeywords(input.keywords), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw savedReplyNotFound();
    ctx.audit({ saved_reply_id: input.id, title_length: input.title.length, body_length: input.body.length, keywords: input.keywords.length });
    return { id: input.id };
  },
});

export const conversationSavedReplyDelete = defineCommand({
  name: 'kernel.conversation.saved_reply_delete',
  input: zSavedReplyId,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.saved_reply', id: input.id }),
  handler: async (ctx, input): Promise<{ id: string }> => {
    requireUser(ctx);
    const res = await ctx.trx.deleteFrom('crove_kernel.saved_reply').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw savedReplyNotFound();
    ctx.audit({ saved_reply_id: input.id });
    return { id: input.id };
  },
});

const autoDraftOf = async (ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<boolean> => {
  const row = await ctx.trx.selectFrom('crove_kernel.conversation_setting').select('auto_draft').where('org_id', '=', ctx.orgId).executeTakeFirst();
  return row ? row.auto_draft : true;
};

export const conversationAutoDraft = defineQuery({
  name: 'kernel.conversation.auto_draft',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<ConversationAutoDraft> => ({ autoDraft: await autoDraftOf(ctx) }),
});

// Whether Vy drafts a reply when a new conversation arrives. A customer's message goes to the deployment's AI endpoint for it, so owners and admins
// decide (a draft a member asks for is theirs). On by default.
export const conversationAutoDraftSet = defineCommand({
  name: 'kernel.conversation.auto_draft_set',
  input: zConversationAutoDraftSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<ConversationAutoDraft> => {
    const me = requireUser(ctx);
    await ctx.trx
      .insertInto('crove_kernel.conversation_setting')
      .values({ org_id: ctx.orgId, auto_draft: input.autoDraft, set_by: me })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ auto_draft: input.autoDraft, set_by: me, updated_at: ctx.now }))
      .execute();
    ctx.audit({ auto_draft: input.autoDraft });
    return { autoDraft: input.autoDraft };
  },
});

// Asks for a draft of the thread's last customer message: a row requested (no text) and the event the draft queue takes, with ids only. At most one
// draft is in play per thread, so asking again returns the one that is. Nothing is asked of a thread whose last message is not a customer's.
async function openDraft(ctx: CommandContext, conversation: ConversationRow, source: 'auto' | 'asked', requestedBy: string | null): Promise<{ draftId: string; queued: boolean }> {
  const last = await ctx.trx
    .selectFrom('crove_kernel.conversation_message')
    .select(['direction', 'platform_removed_at'])
    .where('org_id', '=', ctx.orgId)
    .where('conversation_id', '=', conversation.id)
    .where('seq', '=', conversation.last_seq)
    .executeTakeFirst();
  if (!last || last.direction !== 'in' || last.platform_removed_at) throw new DomainError('DRAFT_NOT_NEEDED', 409, 'Chưa có tin nhắn mới của khách để soạn câu trả lời');
  // A draft nobody can send is not made: the channel does not take replies here, or the platform's reply window has closed.
  const connection = await connectionOf(ctx, conversation.channel_connection_id);
  const rules = connection ? conversationRules(connection.provider) : null;
  if (!rules || !rules.kinds.includes(conversation.kind)) throw new DomainError('REPLY_NOT_SUPPORTED', 409, 'Kênh này chưa hỗ trợ trả lời tại đây');
  if (conversation.reply_window_until && conversation.reply_window_until.getTime() < ctx.now.getTime()) {
    throw new DomainError('REPLY_WINDOW_CLOSED', 409, 'Đã quá thời gian nền tảng cho phép trả lời cuộc trò chuyện này');
  }
  const open = await ctx.trx.selectFrom('crove_kernel.conversation_draft').select(['id', 'basis_seq']).where('org_id', '=', ctx.orgId).where('conversation_id', '=', conversation.id).where('state', 'in', ['requested', 'live']).executeTakeFirst();
  if (open && open.basis_seq === conversation.last_seq) return { draftId: open.id, queued: false };
  if (open) {
    await ctx.trx.updateTable('crove_kernel.conversation_draft').set({ state: 'stale', body: null, decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', open.id).execute();
  }
  const row = await ctx.trx
    .insertInto('crove_kernel.conversation_draft')
    .values({
      org_id: ctx.orgId,
      conversation_id: conversation.id,
      channel_connection_id: conversation.channel_connection_id,
      kind: conversation.kind,
      basis_seq: conversation.last_seq,
      source,
      requested_by: requestedBy,
      created_at: ctx.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.emit(DRAFT_QUEUED, { draftId: row.id, conversationId: conversation.id });
  ctx.audit({ conversation_id: conversation.id, draft_id: row.id, source, basis_seq: conversation.last_seq });
  return { draftId: row.id, queued: true };
}

// "Vy soạn": a member asks for a draft of the thread's last customer message. R2 and external like a reply: the call it leads to reaches the AI
// endpoint. The member who may not read the thread finds none (row-level security).
export const conversationDraftRequest = defineCommand({
  name: 'kernel.conversation.draft_request',
  input: zConversationDraftRequest,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ draftId: string; queued: boolean }> => {
    const me = requireUser(ctx);
    const conversation = await lockConversation(ctx, input.conversationId);
    return openDraft(ctx, conversation, 'asked', me);
  },
});

// The relay's own request, for a new conversation (crove_kernel.conversation_draft_due lists them): the same as a member's, unless the org turned
// drafting off or the thread is no longer new.
export const conversationDraftEnqueue = defineCommand({
  name: 'kernel.conversation.draft_enqueue',
  input: zConversationDraftEnqueue,
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation', id: input.conversationId }),
  handler: async (ctx, input): Promise<{ draftId: string | null; queued: boolean }> => {
    requireSystem(ctx);
    const conversation = (await ctx.trx.selectFrom('crove_kernel.conversation').select(CONVERSATION_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', input.conversationId).forUpdate().executeTakeFirst()) as ConversationRow | undefined;
    if (!conversation || conversation.status !== 'new' || !(await autoDraftOf(ctx))) return { draftId: null, queued: false };
    try {
      return await openDraft(ctx, conversation, 'auto', null);
    } catch (error) {
      if (error instanceof DomainError && ['DRAFT_NOT_NEEDED', 'REPLY_NOT_SUPPORTED', 'REPLY_WINDOW_CLOSED'].includes(error.code)) return { draftId: null, queued: false };
      throw error;
    }
  },
});

export interface DraftSource {
  conversationId: string;
  provider: string;
  // The most characters the channel takes in one reply.
  maxChars: number;
  customerName: string | null;
  orgName: string | null;
  // The end of the thread, oldest first: customer text (tainted) and the business's own.
  messages: Array<{ from: 'customer' | 'business'; text: string }>;
  // The org's saved replies that answer the customer's last message, best first.
  savedReplies: Array<{ title: string; body: string }>;
}

// What the draft job reads for a requested draft: the end of its thread and the saved replies that fit. Null when there is nothing to draft (the draft was
// decided, the thread went, its channel is not active, or a newer message made it stale), so a job that outlived its row stops. System only.
export const conversationDraftSource = defineQuery({
  name: 'kernel.conversation.draft_source',
  input: zConversationDraftSource,
  access: 'system',
  handler: async (ctx, input): Promise<DraftSource | null> => {
    const draft = await ctx.trx
      .selectFrom('crove_kernel.conversation_draft')
      .select(['conversation_id', 'channel_connection_id', 'basis_seq', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.draftId)
      .executeTakeFirst();
    if (!draft || draft.state !== 'requested') return null;
    const conversation = await ctx.trx
      .selectFrom('crove_kernel.conversation as c')
      .leftJoin('crove_kernel.conversation_identity as i', (join) => join.onRef('i.org_id', '=', 'c.org_id').onRef('i.id', '=', 'c.identity_id'))
      .select(['c.last_seq', 'c.kind', 'i.display_name as customer_name'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', draft.conversation_id)
      .executeTakeFirst();
    const connection = await connectionOf(ctx, draft.channel_connection_id);
    if (!conversation || conversation.last_seq !== draft.basis_seq || !connection || connection.status !== 'active') return null;
    const rows = await ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select(['direction', 'body', 'platform_removed_at', 'seq'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', draft.conversation_id)
      .where('seq', '<=', draft.basis_seq)
      .orderBy('seq', 'desc')
      .limit(CONVERSATION_DRAFT_MESSAGES)
      .execute();
    const messages = rows
      .filter((m) => !m.platform_removed_at && m.body.trim() !== '')
      .reverse()
      .map((m) => ({ from: m.direction === 'in' ? ('customer' as const) : ('business' as const), text: m.body }));
    const lastCustomer = [...messages].reverse().find((m) => m.from === 'customer');
    const rules = conversationRules(connection.provider);
    const channelMax =
      connection.provider === 'instagram' && conversation.kind === 'direct'
        ? CONVERSATION_INSTAGRAM_DIRECT_MAX
        : (rules?.replyMax ?? CONVERSATION_DRAFT_MAX);
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const matched = lastCustomer ? matchSavedReplies(lastCustomer.text, await savedRepliesOf(ctx), 5) : [];
    return {
      conversationId: draft.conversation_id,
      provider: connection.provider,
      maxChars: Math.min(channelMax, CONVERSATION_DRAFT_MAX),
      customerName: conversation.customer_name,
      orgName: tenant?.name ?? null,
      messages,
      savedReplies: matched.map((r) => ({ title: r.title, body: r.body })),
    };
  },
});

// The job's answer: Vy's text (the draft goes live, always tainted) or none (the model gave nothing usable, was refused or failed: the draft is
// discarded, and the thread is not drafted again for that message). A draft whose thread got a newer message meanwhile is stale and keeps no text.
export const conversationDraftRecord = defineCommand({
  name: 'kernel.conversation.draft_record',
  input: zConversationDraftRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.conversation_draft', id: input.draftId }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    requireSystem(ctx);
    const draft = await ctx.trx
      .selectFrom('crove_kernel.conversation_draft')
      .select(['conversation_id', 'basis_seq', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.draftId)
      .forUpdate()
      .executeTakeFirst();
    if (!draft || draft.state !== 'requested') return { recorded: false };
    const conversation = await ctx.trx.selectFrom('crove_kernel.conversation').select('last_seq').where('org_id', '=', ctx.orgId).where('id', '=', draft.conversation_id).executeTakeFirst();
    const current = conversation !== undefined && conversation.last_seq === draft.basis_seq;
    if (input.outcome === 'written' && current) {
      await ctx.trx.updateTable('crove_kernel.conversation_draft').set({ state: 'live', body: input.body, written_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.draftId).execute();
      ctx.audit({ draft_id: input.draftId, outcome: 'written', length: input.body.length });
      return { recorded: true };
    }
    await ctx.trx
      .updateTable('crove_kernel.conversation_draft')
      .set({ state: input.outcome === 'written' ? 'stale' : 'discarded', body: null, decided_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.draftId)
      .execute();
    ctx.audit({ draft_id: input.draftId, outcome: input.outcome === 'written' ? 'stale' : 'none', ...(input.outcome === 'none' ? { code: input.code } : {}) });
    return { recorded: true };
  },
});

// A member sets a draft aside: a draft that is live or still asked for is discarded and its text dropped. A draft already decided is left as it is.
export const conversationDraftDiscard = defineCommand({
  name: 'kernel.conversation.draft_discard',
  input: zConversationDraftDiscard,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'kernel.conversation_draft', id: input.draftId }),
  handler: async (ctx, input): Promise<{ discarded: boolean }> => {
    requireUser(ctx);
    const draft = await ctx.trx.selectFrom('crove_kernel.conversation_draft').select('state').where('org_id', '=', ctx.orgId).where('id', '=', input.draftId).forUpdate().executeTakeFirst();
    if (!draft) throw new DomainError('DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp này');
    if (draft.state !== 'live' && draft.state !== 'requested') return { discarded: false };
    await ctx.trx.updateTable('crove_kernel.conversation_draft').set({ state: 'discarded', body: null, decided_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.draftId).execute();
    ctx.audit({ draft_id: input.draftId });
    return { discarded: true };
  },
});


export const conversationCommands = [
  conversationAddressIssue,
  conversationEmailIngest,
  conversationIngest,
  conversationReply,
  conversationReplyPrivately,
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
  conversationSetIntent,
  conversationMarkRead,
  conversationComposing,
  conversationSetAvailability,
  conversationSandboxComment,
  conversationRetentionSet,
  conversationEraseContact,
  conversationPurgeExpired,
  conversationEraseConnection,
  conversationHistoryBegin,
  conversationHistoryRecord,
  conversationProfileBegin,
  conversationProfileApply,
  conversationSyncRequest,
  conversationAttachmentRequest,
  conversationAttachmentRecord,
  conversationSavedReplyCreate,
  conversationSavedReplyUpdate,
  conversationSavedReplyDelete,
  conversationAutoDraftSet,
  conversationDraftRequest,
  conversationDraftEnqueue,
  conversationDraftRecord,
  conversationDraftDiscard,
];
export const conversationQueries = [conversationList, conversationIntentSource, conversationContactCandidates, conversationAvailability, conversationToday, conversationCounts, conversationGet, conversationRetention, conversationAttachmentSource, conversationAttachmentGet, conversationSavedReplyList, conversationAutoDraft, conversationDraftSource];
