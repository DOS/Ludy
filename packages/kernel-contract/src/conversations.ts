// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core (issue #2303, plan docs/plan/conversations.md, ADR-0041): what customers write to an org on a
// connected channel, a comment under a post or a private message, and how the org answers. The kernel owns the store;
// Social shows the comment threads under its posts and in its comment inbox, Service will show the private messages.
//
// A platform's notice is turned by its adapter (@crove/channel) into the events below, which are the only thing the intake
// command takes: the org comes from the stored connection, never from an event. Text in an event is tainted external text.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const CONVERSATION_KINDS = ['comment_thread', 'direct'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CONVERSATION_STATUSES = ['new', 'pending', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
// An outbound message: queued (a member wrote it), sending (the worker is making the call), sent, failed (the platform
// refused it, nothing went out) or unknown (the call may have gone through; never sent again blindly).
export const MESSAGE_SEND_STATES = ['queued', 'sending', 'sent', 'failed', 'unknown'] as const;
export type MessageSendState = (typeof MESSAGE_SEND_STATES)[number];
export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export const MESSAGE_AUTHOR_KINDS = ['contact', 'member', 'system'] as const;
export const HIDE_REQUESTS = ['hide', 'unhide'] as const;

export const CONVERSATION_BODY_MAX = 20_000;
export const CONVERSATION_REPLY_MAX = 8_000;
export const CONVERSATION_NOTE_MAX = 5_000;
export const CONVERSATION_EVENTS_MAX = 1_000;
export const CONVERSATION_LIST_MAX = 100;
// The posts one list asks about at most (the post page lists the threads of all its channels).
export const CONVERSATION_POSTS_MAX = 20;
// A message shown in a list is cut to this many characters.
export const CONVERSATION_PREVIEW_CHARS = 140;
// The calls a reply or a hide makes are a person's, so a stale started call (a worker that died mid-call) is settled by them.
export const CONVERSATION_CALL_STALE_MS = 10 * 60_000;

// What each provider lets a reply do: static capability data, not a hard-coded truth (a provider's rule changes; the live-check
// runbook of its issue confirms it). windowHours: the platform's free-reply window counted from the customer's last message.
export interface ConversationProviderRules {
  readonly kinds: readonly ConversationKind[];
  readonly replyMax: number;
  readonly canHide: boolean;
  readonly windowHours: number | null;
}
export const CONVERSATION_PROVIDER_RULES: Readonly<Record<string, ConversationProviderRules>> = {
  sandbox: { kinds: ['comment_thread', 'direct'], replyMax: 2000, canHide: true, windowHours: null },
  // Zalo OA (#2304): private chats only (no comment API found); 2000 characters a message and a 48-hour free window from the customer's
  // last message [S, U until the live check settles them].
  zalo_oa: { kinds: ['direct'], replyMax: 2000, canHide: false, windowHours: 48 },
};
export const conversationRules = (provider: string): ConversationProviderRules | null =>
  Object.hasOwn(CONVERSATION_PROVIDER_RULES, provider) ? (CONVERSATION_PROVIDER_RULES[provider] ?? null) : null;

// Text the database can store: PostgreSQL refuses a NUL character in text, which would fail a whole notice.
const noNul = (value: string) => !value.includes('\u0000');
const zText = (max: number) => z.string().max(max).refine(noNul, 'NUL character');
const zThreadId = z.string().min(1).max(300).refine(noNul, 'NUL character');
export const zConversationKind = z.enum(CONVERSATION_KINDS);
export const zConversationStatus = z.enum(CONVERSATION_STATUSES);

// One thing a notice told us, in the core's own words. `contact` is the customer of the thread (the commenter, or the
// person writing to the page, also when the event is the page's own message seen as an echo); `direction` out is the
// org's own message, written from the platform's own inbox.
export const zConversationEvent = z.strictObject({
  kind: zConversationKind,
  threadId: zThreadId,
  // A comment thread: the post or media it is under. A reply under a comment names its top-level comment as the thread.
  postId: z.string().min(1).max(300).refine(noNul, 'NUL character').optional(),
  messageId: zThreadId,
  direction: z.enum(MESSAGE_DIRECTIONS),
  contact: z.strictObject({ id: z.string().min(1).max(200).refine(noNul, 'NUL character'), name: z.string().trim().min(1).max(200).refine(noNul, 'NUL character').optional() }),
  text: zText(CONVERSATION_BODY_MAX),
  // The platform's time of the message.
  at: z.iso.datetime({ offset: true }),
  // The platform says the message was removed: the body is blanked (plan section 10).
  removed: z.boolean().optional(),
});
export type ConversationEvent = z.infer<typeof zConversationEvent>;

export const zConversationIngest = z.strictObject({
  connectionId: zId,
  events: z.array(zConversationEvent).min(1).max(CONVERSATION_EVENTS_MAX),
});
export type ConversationIngestInput = z.infer<typeof zConversationIngest>;
export const zConversationIngested = z.strictObject({ stored: z.number().int().min(0), duplicates: z.number().int().min(0), ignored: z.number().int().min(0) });
export type ConversationIngested = z.infer<typeof zConversationIngested>;

// What a thread's customer looks like on screen: the platform's name when it gave one, else a short tail of its id.
export const zConversationContact = z.strictObject({
  identityId: zId.nullable(),
  displayName: z.string().nullable(),
  idTail: z.string(),
  partyId: zId.nullable(),
  partyName: z.string().nullable(),
});
export type ConversationContact = z.infer<typeof zConversationContact>;

export const zConversationSummary = z.strictObject({
  id: zId,
  kind: zConversationKind,
  status: zConversationStatus,
  channel: z.strictObject({ connectionId: zId, provider: z.string(), displayName: z.string() }),
  postId: z.string().nullable(),
  contact: zConversationContact,
  assigneeUserId: zId.nullable(),
  lastSeq: z.number().int(),
  lastMessageAt: z.iso.datetime({ offset: true }).nullable(),
  lastInboundAt: z.iso.datetime({ offset: true }).nullable(),
  replyWindowUntil: z.iso.datetime({ offset: true }).nullable(),
  preview: z.string(),
  unread: z.boolean(),
});
export type ConversationSummary = z.infer<typeof zConversationSummary>;

export const zConversationMessage = z.strictObject({
  id: zId,
  seq: z.number().int(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  authorKind: z.enum(MESSAGE_AUTHOR_KINDS),
  authorUserId: zId.nullable(),
  body: z.string(),
  attachments: z.array(zId),
  sentAt: z.iso.datetime({ offset: true }),
  sendState: z.enum(MESSAGE_SEND_STATES).nullable(),
  sendErrorCode: z.string().nullable(),
  hidden: z.boolean(),
  hideRequest: z.enum(HIDE_REQUESTS).nullable(),
  hideErrorCode: z.string().nullable(),
  removed: z.boolean(),
});
export type ConversationMessage = z.infer<typeof zConversationMessage>;

export const zConversationNote = z.strictObject({ id: zId, authorUserId: zId, body: z.string(), createdAt: z.iso.datetime({ offset: true }) });
export type ConversationNote = z.infer<typeof zConversationNote>;

export const zConversationDetail = z.strictObject({
  conversation: zConversationSummary,
  messages: z.array(zConversationMessage),
  notes: z.array(zConversationNote),
  // The comment thread a private reply continues, when the reader may see it.
  parentId: zId.nullable(),
  // Whether a reply can be sent now, else why not (a code the screen turns into words).
  reply: z.strictObject({ allowed: z.boolean(), reason: z.enum(['channel_inactive', 'not_supported', 'window_closed']).nullable() }),
});
export type ConversationDetail = z.infer<typeof zConversationDetail>;

export const zConversationList = z.strictObject({
  status: zConversationStatus.optional(),
  kind: zConversationKind.optional(),
  connectionId: zId.optional(),
  // The threads under these posts (a post page lists the threads of all its channels).
  posts: z.array(z.strictObject({ connectionId: zId, externalPostId: z.string().min(1).max(300) })).min(1).max(CONVERSATION_POSTS_MAX).optional(),
  assignee: z.enum(['me', 'none']).optional(),
  limit: z.number().int().min(1).max(CONVERSATION_LIST_MAX).default(50),
  // The last thread of the previous page: lastMessageAt (null for none) and id.
  before: z.strictObject({ at: z.iso.datetime({ offset: true }).nullable(), id: zId }).optional(),
});
export const zConversationListed = z.strictObject({ conversations: z.array(zConversationSummary), more: z.boolean() });
export type ConversationListed = z.infer<typeof zConversationListed>;

export const zConversationCounts = z.strictObject({
  kind: zConversationKind.optional(),
  connectionId: zId.optional(),
  // The same posts filter as the list, so the tabs of a post page count what the list shows.
  posts: z.array(z.strictObject({ connectionId: zId, externalPostId: z.string().min(1).max(300) })).min(1).max(CONVERSATION_POSTS_MAX).optional(),
});
export const zConversationCounted = z.strictObject({
  new: z.number().int(),
  pending: z.number().int(),
  resolved: z.number().int(),
  // Threads with a message the caller has not seen.
  unread: z.number().int(),
});
export type ConversationCounted = z.infer<typeof zConversationCounted>;

export const zConversationGet = z.strictObject({ conversationId: zId });
export const zConversationReply = z.strictObject({
  conversationId: zId,
  body: z.string().trim().min(1).max(CONVERSATION_REPLY_MAX).refine(noNul, 'NUL character'),
  // The last message the sender saw: a newer one refuses the reply (CONVERSATION_MOVED).
  lastSeenSeq: z.number().int().min(0),
});
export const zConversationReplied = z.strictObject({ messageId: zId, seq: z.number().int() });
export const zConversationSettle = z.strictObject({ messageId: zId, action: z.enum(['retry', 'mark_sent']) });
export const zConversationHide = z.strictObject({ messageId: zId, hidden: z.boolean() });
export const zConversationAssign = z.strictObject({ conversationId: zId, assigneeUserId: zId.nullable() });
export const zConversationId = z.strictObject({ conversationId: zId });
export const zConversationNoteAdd = z.strictObject({ conversationId: zId, body: z.string().trim().min(1).max(CONVERSATION_NOTE_MAX).refine(noNul, 'NUL character') });
export const zConversationLinkContact = z.strictObject({ conversationId: zId, partyId: zId.nullable() });
export const zConversationMarkRead = z.strictObject({ conversationId: zId, seq: z.number().int().min(0) });
export const zConversationDone = z.strictObject({ conversationId: zId });
// A demo comment on a post of a sandbox connection (a thread of its own, or a follow-up in one).
export const zConversationSandboxComment = z.strictObject({
  connectionId: zId,
  postId: z.string().min(1).max(300),
  text: z.string().trim().min(1).max(2000),
  fromName: z.string().trim().min(1).max(100).default('Khách thử nghiệm'),
  // A follow-up to this thread's top-level comment instead of a new top-level comment.
  threadId: z.string().min(1).max(300).optional(),
});
export const zConversationSandboxQueued = z.strictObject({ queued: z.literal(true) });
