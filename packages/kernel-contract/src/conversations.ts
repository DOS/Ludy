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
// A customer's image stored with its message (CV5c, #2357): at most this many a message, this many bytes each, and only these types (read
// from the bytes, never from what the platform said). Anything else stays the placeholder the message was stored with.
export const CONVERSATION_ATTACHMENTS_MAX = 5;
export const CONVERSATION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CONVERSATION_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ConversationImageType = (typeof CONVERSATION_IMAGE_TYPES)[number];
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

// An image the platform says a customer's message carries, by the address it can be fetched from (personal data: kept only until fetched,
// at most six days, and never in an audit row, an event, a log or a job). https only; the fetch itself is limited to the platform's media hosts.
export const zConversationEventImage = z.strictObject({
  kind: z.literal('image'),
  url: z.string().min(1).max(2000).refine(noNul, 'NUL character').refine((value) => value.startsWith('https://'), 'https only'),
});

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
  // The images the customer's message carries (CV5c, #2357); each is fetched later by the worker and shown beside the message's text.
  attachments: z.array(zConversationEventImage).max(CONVERSATION_ATTACHMENTS_MAX).optional(),
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

// A stored image of a message: read through its own route (an authenticated GET of the id), never as HTML.
export const zConversationAttachmentView = z.strictObject({
  id: zId,
  contentType: z.enum(CONVERSATION_IMAGE_TYPES),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type ConversationAttachmentView = z.infer<typeof zConversationAttachmentView>;

export const zConversationMessage = z.strictObject({
  id: zId,
  seq: z.number().int(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  authorKind: z.enum(MESSAGE_AUTHOR_KINDS),
  authorUserId: zId.nullable(),
  // The customer who wrote it, by the name the platform gave or the tail of their id: in a comment thread each reply has its own author,
  // who is not always the thread's contact. Null for the org's own messages.
  authorName: z.string().nullable(),
  authorTail: z.string().nullable(),
  body: z.string(),
  attachments: z.array(zConversationAttachmentView),
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

// Vy's draft of a reply (CV8, #2310): asked for (requested, the text is on its way) or live (the text). Always tainted: a model wrote it from a customer's
// text, so the screen says so and a person reads it, edits it and sends it.
export const CONVERSATION_DRAFT_STATES = ['requested', 'live', 'used', 'discarded', 'stale'] as const;
export const zConversationDraftView = z.strictObject({
  id: zId,
  state: z.enum(['requested', 'live']),
  source: z.enum(['auto', 'asked']),
  // Null while requested.
  body: z.string().nullable(),
  tainted: z.literal(true),
});
export type ConversationDraftView = z.infer<typeof zConversationDraftView>;

// A saved reply as the reply box offers it beside the draft: matched by the words of the customer's last message.
export const SAVED_REPLY_TITLE_MAX = 100;
export const SAVED_REPLY_BODY_MAX = 2000;
export const SAVED_REPLY_KEYWORDS_MAX = 20;
export const SAVED_REPLY_KEYWORD_MAX = 40;
export const SAVED_REPLIES_MAX = 200;
// How many of the thread's last messages a draft reads.
export const CONVERSATION_DRAFT_MESSAGES = 12;
export const zSavedReplyView = z.strictObject({ id: zId, title: z.string(), body: z.string(), keywords: z.array(z.string()), useCount: z.number().int() });
export type SavedReplyView = z.infer<typeof zSavedReplyView>;

export const zConversationDetail = z.strictObject({
  conversation: zConversationSummary,
  messages: z.array(zConversationMessage),
  notes: z.array(zConversationNote),
  // The comment thread a private reply continues, when the reader may see it.
  parentId: zId.nullable(),
  // Whether a reply can be sent now, else why not (a code the screen turns into words).
  reply: z.strictObject({ allowed: z.boolean(), reason: z.enum(['channel_inactive', 'not_supported', 'window_closed']).nullable() }),
  // Events of this channel may be missing between these two times (the platform's history could not be read back far enough to fill
  // them): shown on a thread that was active after `from`.
  gap: z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).nullable(),
  // Vy's draft for the last customer message, when one is in play (CV8), and the saved replies that answer its words (at most three, best first).
  draft: zConversationDraftView.nullable(),
  suggestions: z.array(zSavedReplyView),
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
  // The draft this reply began from (CV8): it is marked used, with the lengths and the size of the person's edit, never the text. Any other draft of
  // the thread is discarded by a reply.
  draftId: zId.optional(),
  // The saved reply this reply began from: its use count goes up.
  savedReplyId: zId.optional(),
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
// What the worker reads beyond the webhook (CV5b, #2329): the account's recent history, and a customer's name. System commands.
// The relay hands the worker a read of one account's history or one customer's name (kernel.conversation.sync_request).
export const zConversationSyncRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('history'), connectionId: zId }),
  z.strictObject({ action: z.literal('profile'), connectionId: zId, identityId: zId }),
]);
export const zConversationHistoryBegin = z.strictObject({ connectionId: zId });
export const zConversationHistoryRecord = z.strictObject({
  connectionId: zId,
  // Every chat reached back to `since`: no gap is left. Else the period that may be missing.
  complete: z.boolean(),
  gapFrom: z.iso.datetime({ offset: true }).nullable(),
  gapTo: z.iso.datetime({ offset: true }).nullable(),
});
export const zConversationProfileBegin = z.strictObject({ identityId: zId, connectionId: zId });
export const zConversationProfileApply = z.strictObject({
  identityId: zId,
  // The name the platform gave, or null when it has none (a definitive answer); `retry` leaves it to be asked again.
  displayName: z.string().trim().min(1).max(200).refine(noNul, 'NUL character').nullable(),
  retry: z.boolean().default(false),
});
// The images of a customer's messages (CV5c, #2357): the relay hands the worker one pending image to fetch (kernel.conversation.attachment_request,
// which marks it handed out and emits the event the queue takes, ids only), the job reads its address (a query), fetches it, stores the bytes and
// records the outcome. A failure that asking again will not change (a refused host, a wrong type, too large, gone) drops the image, and the
// message keeps its placeholder.
export const zConversationAttachmentRequest = z.strictObject({ attachmentId: zId });
export const zConversationAttachmentSource = z.strictObject({ attachmentId: zId });
export const zConversationAttachmentRecord = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('stored'),
    attachmentId: zId,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().min(1).max(CONVERSATION_IMAGE_MAX_BYTES),
    contentType: z.enum(CONVERSATION_IMAGE_TYPES),
    generation: z.string().min(1).max(1100),
    width: z.number().int().min(1).max(100_000).nullable(),
    height: z.number().int().min(1).max(100_000).nullable(),
  }),
  // retry: asking again may succeed (a timeout, a server error); else the image is dropped. `code` is a short code, never a platform's words.
  z.strictObject({ outcome: z.literal('failed'), attachmentId: zId, retry: z.boolean(), code: z.string().regex(/^[A-Za-z0-9_.:-]{1,60}$/) }),
]);
export const zConversationAttachmentGet = z.strictObject({ attachmentId: zId });
export const zConversationSandboxQueued = z.strictObject({ queued: z.literal(true) });

// Retention (CV6, #2305): the months a thread is kept after its last message; null keeps it until a person deletes it. An org with
// no choice has the default.
export const CONVERSATION_RETENTION_MONTHS = [6, 12, 24] as const;
export const CONVERSATION_RETENTION_DEFAULT_MONTHS = 24;
const zRetentionMonths = z.union([z.literal(6), z.literal(12), z.literal(24)]).nullable();
export const zConversationRetentionSet = z.strictObject({ retentionMonths: zRetentionMonths });
export const zConversationRetention = z.strictObject({ retentionMonths: zRetentionMonths, isDefault: z.boolean() });
export type ConversationRetention = z.infer<typeof zConversationRetention>;

// Vy's drafts (CV8, #2310). A member asks for one (kernel.conversation.draft_request) or the relay does when a conversation is new
// (draft_enqueue, system); a worker job reads the draft's source (draft_source, system query), calls the model and records the answer
// (draft_record, system). A member discards one (draft_discard). The owner's switch for drafting on arrival is auto_draft_set.
export const zConversationDraftRequest = z.strictObject({ conversationId: zId });
export const zConversationDraftEnqueue = z.strictObject({ conversationId: zId });
export const zConversationDraftSource = z.strictObject({ draftId: zId });
export const zConversationDraftDiscard = z.strictObject({ draftId: zId });
export const zConversationDraftRecord = z.discriminatedUnion('outcome', [
  // The draft's text (1 to the thread's channel limit), and the model call's tokens for the org's AI cost limit.
  z.strictObject({ outcome: z.literal('written'), draftId: zId, body: z.string().trim().min(1).max(2000).refine(noNul, 'NUL character') }),
  // No draft: the model gave none, was refused or failed; `code` is a short code, never a platform's or a model's words.
  z.strictObject({ outcome: z.literal('none'), draftId: zId, code: z.string().regex(/^[A-Za-z0-9_.:-]{1,60}$/) }),
]);
export const zConversationAutoDraft = z.strictObject({ autoDraft: z.boolean() });
export const zConversationAutoDraftSet = z.strictObject({ autoDraft: z.boolean() });
export type ConversationAutoDraft = z.infer<typeof zConversationAutoDraft>;

// Saved replies: the org's own text for common answers. `keywords` are the words the reply answers, matched against the customer's text.
export const zSavedReplyInput = z.strictObject({
  title: z.string().trim().min(1).max(SAVED_REPLY_TITLE_MAX).refine(noNul, 'NUL character'),
  body: z.string().trim().min(1).max(SAVED_REPLY_BODY_MAX).refine(noNul, 'NUL character'),
  keywords: z.array(z.string().trim().min(1).max(SAVED_REPLY_KEYWORD_MAX).refine(noNul, 'NUL character')).max(SAVED_REPLY_KEYWORDS_MAX).default([]),
});
export const zSavedReplyUpdate = zSavedReplyInput.extend({ id: zId });
export const zSavedReplyId = z.strictObject({ id: zId });
export const zSavedReplyList = z.strictObject({});
export const zSavedReplyListed = z.strictObject({ replies: z.array(zSavedReplyView) });
export type SavedReplyListed = z.infer<typeof zSavedReplyListed>;
// Erasing a customer: every thread of the same person (their identity on the platform) goes, with its messages, notes and read marks.
// The thread the button is on names the person; a thread with no identity goes alone. `confirm` is the screen's confirmation.
// `messageId`: a customer message of that thread whose author is the person to erase (a customer who only replied in someone else's
// comment thread has no thread of their own to start from); without it, the thread's own customer.
export const zConversationEraseContact = z.strictObject({ conversationId: zId, messageId: zId.optional(), confirm: z.literal(true) });
// The route takes an idempotency key too (it travels in the call's options, never in the command's input): a retry after a lost answer
// returns the first result instead of a false not-found.
export const zConversationErased = z.strictObject({ threads: z.number().int(), messages: z.number().int() });
export type ConversationErased = z.infer<typeof zConversationErased>;
// The worker's retention purge of one org, in batches of threads, and the erasure of one connection's conversations that Meta's
// data deletion callback asks for.
export const zConversationPurgeExpired = z.strictObject({ limit: z.number().int().min(1).max(1000).default(200) });
export const zConversationPurged = z.strictObject({ threads: z.number().int(), messages: z.number().int(), identities: z.number().int(), more: z.boolean() });
export type ConversationPurged = z.infer<typeof zConversationPurged>;
export const zConversationEraseConnection = z.strictObject({ connectionId: zId });
