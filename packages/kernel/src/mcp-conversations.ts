// SPDX-License-Identifier: AGPL-3.0-only
// The Hộp thư reads an MCP grant may run (epic #3857, E1, issue #3860; ADR-0051 decisions 2, 10 and 11, the sealed read contexts of #3858 slice b): `ludy_conversations_list` (kernel.mcp.conversations) and
// `ludy_conversation` (kernel.mcp.conversation). They are named `kernel.mcp.*`, not `kernel.conversation.*`, on purpose: the screens' own conversation queries stay closed to a grant, and
// these two are the only way in, each an allowlist projection.
//
// Who reads what is decided in the database, not here (supabase/migrations/..._mcp_grant_conversation_read.sql): a company grant (an owner's or admin's, the whole-org scope) reads every thread of the org and its
// messages; a member-bound grant reads exactly what its member may read (the base role; a member the comment threads of the channels they are limited to, private messages and email only with the
// `kernel.conversation.direct.read` permission; a viewer the comment threads of their channels). A thread the grant may not read is not found, and a list holds only the threads it may read. Because every
// row of a member-bound read goes through a definer and a permission lookup (review note N1 of #3941), both reads are bounded: a small default page, a hard maximum, and a message page of at most
// MCP_CONVERSATION_MESSAGES_MAX.
//
// Privacy review. What leaves, per thread: its id, kind (comment_thread, direct, email), status, the channel (connection id, provider, display name), for a post's comment thread the post's platform id,
// the contact (the customer's name as the platform gave it, the last four characters of their platform id, the party's id and name when a person linked one, and for an email thread the sender's address),
// the assignee's user id, the message counter and the times of the last message and the last inbound one, the reply window's end, the intent label, the email subject and whether the sender is unverified, and a
// preview of the last message (plain, at most MCP_PREVIEW_MAX characters). Per message of one thread: its id and number, direction, who wrote it (customer, member or system) and the customer's name, the text
// (at most MCP_MESSAGE_CHARS characters, line breaks kept, `bodyTruncated` says when cut), the time it was sent, its send state and its error code, whether it was hidden, and how many stored images it has.
// What is tainted: everything a customer wrote (the messages, the subject, the contact's name, the preview) is external text, and `tainted` is true on every inbound message; it reaches the client as data,
// never as an instruction. Never returned: a message that the author or the platform removed (its body is blanked in the table and left out here too, and the row says only `removed`), the internal notes of
// a thread, the draft in play, the saved replies, who is composing, read marks, the images themselves (only how many), the platform's message ids and user ids (only the last four characters), a hide
// request's attempts, the channel's token or settings, and the customer's other threads. Erased data is never sent: erasing a customer deletes their rows and leaves a tombstone with no text, and a
// retention purge deletes old messages, so neither leaves anything for a read to find. Row-level security and the `org_id` filters keep other orgs out.
import { sql } from 'kysely';
import { z } from 'zod';
import { CONVERSATION_INTENTS, CONVERSATION_KINDS, CONVERSATION_STATUSES, plainLine, plainText, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const MCP_CONVERSATIONS_DEFAULT = 15;
export const MCP_CONVERSATIONS_MAX = 30;
export const MCP_CONVERSATION_MESSAGES_DEFAULT = 30;
export const MCP_CONVERSATION_MESSAGES_MAX = 50;
export const MCP_PREVIEW_MAX = 160;
export const MCP_MESSAGE_CHARS = 4000;
const NAME_MAX = 300;

export const zMcpConversationsInput = z.strictObject({
  status: z.enum(CONVERSATION_STATUSES).optional().describe('Only threads in this state: new (waiting for a reply), pending or resolved. Leave out for all.'),
  kind: z.enum(CONVERSATION_KINDS).optional().describe('Only this kind: comment_thread (comments under a post), direct (a private message) or email.'),
  connectionId: zId.optional().describe('Only threads of this channel connection (an id from a thread you listed).'),
  assignee: z.literal('none').optional().describe('"none": only threads nobody is assigned to.'),
  intent: z.enum([...CONVERSATION_INTENTS, 'none']).optional().describe('Only threads a person labelled with this intent, or "none" for the unlabelled ones.'),
  limit: z.number().int().min(1).max(MCP_CONVERSATIONS_MAX).default(MCP_CONVERSATIONS_DEFAULT).describe(`How many threads to return (1 to ${MCP_CONVERSATIONS_MAX}, default ${MCP_CONVERSATIONS_DEFAULT}).`),
  before: z.strictObject({ at: z.iso.datetime({ offset: true }).nullable(), id: zId }).optional().describe('The `next` of the previous answer, to read the following page.'),
});
export const zMcpConversationInput = z.strictObject({
  conversationId: zId,
  limit: z.number().int().min(1).max(MCP_CONVERSATION_MESSAGES_MAX).default(MCP_CONVERSATION_MESSAGES_DEFAULT).describe(`How many of the latest messages (1 to ${MCP_CONVERSATION_MESSAGES_MAX}, default ${MCP_CONVERSATION_MESSAGES_DEFAULT}).`),
  beforeSeq: z.number().int().min(1).max(2_147_483_647).optional().describe('Only messages numbered below this (the `earlierBefore` of the previous answer), to read further back.'),
});

export interface McpConversation {
  id: string;
  kind: string;
  status: string;
  channel: { connectionId: string; provider: string; displayName: string };
  postId: string | null;
  contact: { displayName: string | null; idTail: string; partyId: string | null; partyName: string | null; address: string | null };
  assigneeUserId: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  replyWindowUntil: string | null;
  intent: string | null;
  subject: string | null;
  senderUnverified: boolean;
  // The last message that was not removed, as one plain line: a customer's words (tainted) unless a member wrote it.
  preview: string;
  tainted: true;
}
export interface McpConversations {
  conversations: McpConversation[];
  more: boolean;
  next: { at: string | null; id: string } | null;
}
export interface McpMessage {
  id: string;
  seq: number;
  direction: 'in' | 'out';
  authorKind: 'contact' | 'member' | 'system';
  authorName: string | null;
  body: string;
  bodyTruncated: boolean;
  sentAt: string;
  sendState: string | null;
  sendErrorCode: string | null;
  hidden: boolean;
  removed: boolean;
  images: number;
  tainted: boolean;
}
export interface McpConversationDetail {
  conversation: McpConversation;
  messages: McpMessage[];
  // Set when older messages exist: pass it as `beforeSeq` to read them.
  earlierBefore: number | null;
}

interface SummaryRow {
  id: string;
  kind: string;
  status: string;
  channel_connection_id: string;
  provider: string;
  channel_name: string;
  external_post_id: string | null;
  identity_name: string | null;
  external_user_id: string | null;
  party_id: string | null;
  party_name: string | null;
  assignee_user_id: string | null;
  last_seq: number;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  reply_window_until: Date | null;
  intent: string | null;
  subject: string | null;
  sender_unverified: boolean | null;
  preview: string | null;
}

function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
}
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const optionalLine = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const line = plainLine(value, max);
  return line === '' ? null : line;
};

// The columns of a thread an MCP client may see. The preview is the last message that was not removed; the read marks and composing markers of the screens are not read (a grant has none).
const summarySelect = (orgId: string) => sql`
  SELECT c.id, c.kind, c.status, c.channel_connection_id, ch.provider, ch.display_name AS channel_name, c.external_post_id,
         i.display_name AS identity_name, i.external_user_id, c.party_id, p.name AS party_name,
         c.assignee_user_id, c.last_seq, c.last_message_at, c.last_inbound_at, c.reply_window_until, c.intent, c.subject, c.sender_unverified,
         (SELECT pg_catalog.left(m.body, 2000) FROM crove_kernel.conversation_message m
          WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.platform_removed_at IS NULL ORDER BY m.seq DESC LIMIT 1) AS preview
  FROM crove_kernel.conversation c
  JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.channel_connection_id
  LEFT JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id
  LEFT JOIN crove_kernel.party p ON p.org_id = c.org_id AND p.id = c.party_id
  WHERE c.org_id = ${orgId}::uuid`;

function toConversation(row: SummaryRow): McpConversation {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    channel: { connectionId: row.channel_connection_id, provider: plainLine(row.provider, 40), displayName: plainLine(row.channel_name, NAME_MAX) },
    postId: optionalLine(row.external_post_id, 300),
    contact: {
      displayName: optionalLine(row.identity_name, NAME_MAX),
      idTail: row.external_user_id ? plainLine(row.external_user_id.slice(-4), 4) : '',
      partyId: row.party_id,
      partyName: optionalLine(row.party_name, NAME_MAX),
      // An email thread's sender is the address; for the platforms the id is never given, only its tail.
      address: row.kind === 'email' ? optionalLine(row.external_user_id, 254) : null,
    },
    assigneeUserId: row.assignee_user_id,
    lastSeq: row.last_seq,
    lastMessageAt: iso(row.last_message_at),
    lastInboundAt: iso(row.last_inbound_at),
    replyWindowUntil: iso(row.reply_window_until),
    intent: row.intent,
    subject: optionalLine(row.subject, 300),
    senderUnverified: row.kind === 'email' && row.sender_unverified === true,
    preview: plainLine(row.preview ?? '', MCP_PREVIEW_MAX),
    tainted: true,
  };
}

// `ludy_conversations_list`: the threads the grant may read, the latest message first, at most `limit`.
export const mcpConversations = defineQuery({
  name: 'kernel.mcp.conversations',
  input: zMcpConversationsInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpConversations> => {
    requireGrant(ctx);
    const where = [sql`TRUE`];
    if (input.status) where.push(sql`c.status = ${input.status}`);
    if (input.kind) where.push(sql`c.kind = ${input.kind}`);
    if (input.connectionId) where.push(sql`c.channel_connection_id = ${input.connectionId}::uuid`);
    if (input.assignee === 'none') where.push(sql`c.assignee_user_id IS NULL`);
    if (input.intent === 'none') where.push(sql`c.intent IS NULL`);
    else if (input.intent) where.push(sql`c.intent = ${input.intent}`);
    if (input.before) {
      // Newest first, threads with no message last: the key is (last_message_at, id) descending with nulls last.
      where.push(
        input.before.at === null
          ? sql`(c.last_message_at IS NULL AND c.id < ${input.before.id}::uuid)`
          : sql`(c.last_message_at IS NULL OR c.last_message_at < ${input.before.at}::timestamptz OR (c.last_message_at = ${input.before.at}::timestamptz AND c.id < ${input.before.id}::uuid))`,
      );
    }
    const { rows } = await sql<SummaryRow>`${summarySelect(ctx.orgId)} AND ${sql.join(where, sql` AND `)}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ${input.limit + 1}`.execute(ctx.trx);
    const conversations = rows.slice(0, input.limit).map(toConversation);
    const last = conversations.at(-1);
    const more = rows.length > input.limit;
    return { conversations, more, next: more && last ? { at: last.lastMessageAt, id: last.id } : null };
  },
});

// `ludy_conversation`: one thread with its latest messages (oldest first on the page).
export const mcpConversation = defineQuery({
  name: 'kernel.mcp.conversation',
  input: zMcpConversationInput,
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpConversationDetail> => {
    requireGrant(ctx);
    const { rows } = await sql<SummaryRow>`${summarySelect(ctx.orgId)} AND c.id = ${input.conversationId}::uuid`.execute(ctx.trx);
    const row = rows[0];
    // A thread the grant may not read is the same answer as one that does not exist.
    if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 404, 'Không tìm thấy cuộc trò chuyện');
    let q = ctx.trx
      .selectFrom('crove_kernel.conversation_message')
      .select(['id', 'seq', 'direction', 'author_kind', 'author_identity_id', 'body', 'attachments', 'sent_at', 'send_state', 'send_error_code', 'hidden_at', 'platform_removed_at', 'tainted'])
      .where('org_id', '=', ctx.orgId)
      .where('conversation_id', '=', input.conversationId);
    if (input.beforeSeq !== undefined) q = q.where('seq', '<', input.beforeSeq);
    const found = await q.orderBy('seq', 'desc').limit(input.limit + 1).execute();
    const page = found.slice(0, input.limit);
    const authorIds = [...new Set(page.map((m) => m.author_identity_id).filter((id): id is string => id !== null))];
    const names = new Map<string, string | null>();
    if (authorIds.length > 0) {
      const authors = await ctx.trx.selectFrom('crove_kernel.conversation_identity').select(['id', 'display_name']).where('org_id', '=', ctx.orgId).where('id', 'in', authorIds).execute();
      for (const a of authors) names.set(a.id, a.display_name);
    }
    const messages = page.reverse().map((m): McpMessage => {
      const removed = m.platform_removed_at !== null;
      const text = removed ? { text: '', truncated: false } : plainText(m.body, MCP_MESSAGE_CHARS);
      return {
        id: m.id,
        seq: m.seq,
        direction: m.direction as 'in' | 'out',
        authorKind: m.author_kind as McpMessage['authorKind'],
        authorName: m.author_identity_id ? optionalLine(names.get(m.author_identity_id) ?? null, NAME_MAX) : null,
        body: text.text,
        bodyTruncated: text.truncated,
        sentAt: m.sent_at.toISOString(),
        sendState: m.send_state,
        sendErrorCode: optionalLine(m.send_error_code, 100),
        hidden: m.hidden_at !== null,
        removed,
        images: m.attachments.length,
        // A customer's message is tainted external text, and so is anything the table marks.
        tainted: m.direction === 'in' || m.author_kind === 'contact' || m.tainted,
      };
    });
    const oldest = messages[0];
    return { conversation: toConversation(row), messages, earlierBefore: found.length > input.limit && oldest ? oldest.seq : null };
  },
});

export const mcpConversationQueries = [mcpConversations, mcpConversation];
