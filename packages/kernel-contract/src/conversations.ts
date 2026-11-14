// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core (issue #2303, plan docs/plan/conversations.md, ADR-0041): what customers write to an org on a
// connected channel, a comment under a post or a private message, and how the org answers. The kernel owns the store;
// Social shows the comment threads under its posts and in its comment inbox, Service will show the private messages.
//
// A platform's notice is turned by its adapter (@crove/channel) into the events below, which are the only thing the intake
// command takes: the org comes from the stored connection, never from an event. Text in an event is tainted external text.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const CONVERSATION_KINDS = ['comment_thread', 'direct', 'email'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CONVERSATION_STATUSES = ['new', 'pending', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
// The intent a person applies to a conversation (CV3, #2306): the same five as the database's check and the AI reader's labels (a test compares the
// three). What the AI coworker suggests is never stored; only a person's decision is.
export const CONVERSATION_INTENTS = ['question', 'order_or_price', 'complaint', 'invoice_request', 'spam'] as const;
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];
// An outbound message: queued (a member wrote it), sending (the worker is making the call), sent, failed (the platform
// refused it, nothing went out) or unknown (the call may have gone through; never sent again blindly).
export const MESSAGE_SEND_STATES = ['queued', 'sending', 'sent', 'failed', 'unknown'] as const;
export type MessageSendState = (typeof MESSAGE_SEND_STATES)[number];
export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export const MESSAGE_AUTHOR_KINDS = ['contact', 'member', 'system'] as const;
export const HIDE_REQUESTS = ['hide', 'unhide'] as const;

export const CONVERSATION_BODY_MAX = 20_000;
export const CONVERSATION_REPLY_MAX = 8_000;
export const CONVERSATION_FACEBOOK_DIRECT_MAX = 2_000;
export const CONVERSATION_INSTAGRAM_COMMENT_MAX = 2_200;
export const CONVERSATION_INSTAGRAM_DIRECT_MAX = 1_000;
// Threads' own limit of 500 characters a post applies to a reply [U until the live check and the official page settle it] (#3133, plan section 4.4).
export const CONVERSATION_THREADS_REPLY_MAX = 500;
export const CONVERSATION_NOTE_MAX = 5_000;
export const CONVERSATION_EVENTS_MAX = 1_000;
export const CONVERSATION_LIST_MAX = 100;
export const CONVERSATION_SEARCH_MAX = 100;
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
  // Facebook Page comments and Messenger (CV2 #2307, CV4 #2308, plan section 6.2): public comment threads under Page posts (up to 8000
  // characters, reversible hide/unhide, no reply window) and Messenger direct messages (up to 2000 characters, 24-hour standard window
  // plus 7-day HUMAN_AGENT window = 168 hours).
  facebook_page: { kinds: ['comment_thread', 'direct'], replyMax: CONVERSATION_REPLY_MAX, canHide: true, windowHours: 168 },
  // Instagram Business comments and direct messages (CV7 #2309, plan section 6.4): public comment threads under Instagram media (up to
  // 2200 characters, reversible hide/unhide, no reply window) and Instagram direct messages (up to 1000 characters, 24-hour standard
  // window plus 7-day HUMAN_AGENT window = 168 hours).
  instagram: { kinds: ['comment_thread', 'direct'], replyMax: CONVERSATION_INSTAGRAM_COMMENT_MAX, canHide: true, windowHours: 168 },
  // Threads replies to the business's own posts (#3133, plan docs/plan/conversations-channels.md section 4.4): public comment threads, one
  // per top-level reply, no reply window. No private-message API was found. `canHide` stays false until the live check confirms that
  // `POST /{reply-id}/manage_reply` hides a top-level reply (docs/runbooks/threads-conversations-live-check.md, row 8); the adapter has the
  // call already, so confirming it is a one-word change here. `replyMax` 500 is Threads' post limit [U].
  threads: { kinds: ['comment_thread'], replyMax: CONVERSATION_THREADS_REPLY_MAX, canHide: false, windowHours: null },
  // Zalo OA (#2304): private chats only (no comment API found); 2000 characters a message and a 48-hour free window from the customer's
  // last message [S, U until the live check settles them].
  zalo_oa: { kinds: ['direct'], replyMax: 2000, canHide: false, windowHours: 48 },
  // An email reply is as long as any other reply the core takes (CONVERSATION_REPLY_MAX), so the input, the box and the channel agree.
  email: { kinds: ['email'], replyMax: CONVERSATION_REPLY_MAX, canHide: false, windowHours: null },
};
// Customer email (#2439, plan section 6.7): a conversation channel with no platform behind it, so no reply window and nothing to hide; a
// reply goes out through the kernel mail pipeline, not an adapter. The connection is made when the first mail arrives.
export const EMAIL_PROVIDER = 'email';
// A customer's reply names earlier Message-IDs; at most this many are kept and looked up.
export const EMAIL_REFS_MAX = 50;
export const EMAIL_SUBJECT_MAX = 300;
// The org's conversation address (#2439): its own token, apart from the document address, issued once and rotated by the owner.
export const zConversationAddress = z.strictObject({ conversationAddress: z.string().nullable() });
export type ConversationAddressView = z.infer<typeof zConversationAddress>;
export const conversationRules = (provider: string): ConversationProviderRules | null =>
  Object.hasOwn(CONVERSATION_PROVIDER_RULES, provider) ? (CONVERSATION_PROVIDER_RULES[provider] ?? null) : null;

// Text the database can store: PostgreSQL refuses a NUL character in text, which would fail a whole notice.
const noNul = (value: string) => !value.includes('\u0000');
const zText = (max: number) => z.string().max(max).refine(noNul, 'NUL character');
const zThreadId = z.string().min(1).max(300).refine(noNul, 'NUL character');
export const zConversationKind = z.enum(CONVERSATION_KINDS);
export const zConversationStatus = z.enum(CONVERSATION_STATUSES);
export const zConversationIntent = z.enum(CONVERSATION_INTENTS);

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
  // A comment edited or hidden on the platform (CV2, #2307: Meta's `feed` webhook verbs `edited`, `hide` and `unhide`, and `is_hidden` on reconcile).
  edited: z.boolean().optional(),
  hidden: z.boolean().optional(),
  hiddenOnly: z.boolean().optional(),
  // The images the customer's message carries (CV5c, #2357); each is fetched later by the worker and shown beside the message's text.
  attachments: z.array(zConversationEventImage).max(CONVERSATION_ATTACHMENTS_MAX).optional(),
  // Email only (#2439): the subject line, and the Message-IDs the mail names in In-Reply-To and References, which decide the thread.
  subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX).refine(noNul, 'NUL character').optional(),
  refs: z.array(zThreadId).max(EMAIL_REFS_MAX).optional(),
  // Email only: the mail server that received it vouched for the sender's domain (SPF, DKIM or DMARC pass, read from its Authentication-Results). A mail
  // that is not verified does not join a thread by its References and brings no contact link with it.
  verified: z.boolean().optional(),
  // Email only (#2758): how many images the worker found in the mail (it read their type from the bytes and held each to the size cap). The core reserves
  // a row with a blob key for each and hands the keys back; the worker writes the bytes, which never travel in an event.
  mailImages: z.number().int().min(1).max(CONVERSATION_ATTACHMENTS_MAX).optional(),
  // Email only: the total bytes of those images, counted in the org's day of attachment bytes (the same metric as the invoice reader's, checked at a quarter of its limit).
  mailImageBytes: z.number().int().min(1).max(CONVERSATION_ATTACHMENTS_MAX * CONVERSATION_IMAGE_MAX_BYTES).optional(),
});
export type ConversationEvent = z.infer<typeof zConversationEvent>;

export const zConversationIngest = z.strictObject({
  connectionId: zId,
  events: z.array(zConversationEvent).min(1).max(CONVERSATION_EVENTS_MAX),
});
export type ConversationIngestInput = z.infer<typeof zConversationIngest>;
// What the mail worker hands the core for one customer mail (#2439): the org is the worker's (found from the stored address), the events are
// email events only (the core finds or makes the org's email connection). Everything else of the notice stays with the worker.
export const zConversationEmailIngest = z.strictObject({
  events: z.array(zConversationEvent.refine((event) => event.kind === 'email', 'email events only')).min(1).max(CONVERSATION_EVENTS_MAX),
});
export type ConversationEmailIngestInput = z.infer<typeof zConversationEmailIngest>;
export const zConversationIngested = z.strictObject({
  stored: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  ignored: z.number().int().min(0),
  // Email images whose bytes the worker still has to write (#2758): the reserved rows of the mail's message, new or left by a worker that died.
  images: z.array(z.strictObject({ attachmentId: zId, storageKey: z.string().min(1).max(200) })).optional(),
});
export type ConversationIngested = z.infer<typeof zConversationIngested>;

// What a thread's customer looks like on screen: the platform's name when it gave one, else a short tail of its id.
export const zConversationContact = z.strictObject({
  identityId: zId.nullable(),
  displayName: z.string().nullable(),
  idTail: z.string(),
  partyId: zId.nullable(),
  partyName: z.string().nullable(),
  // An email thread's sender address (#2439), shown beside the name, which the sender chose: null for every other kind.
  address: z.string().nullable().optional(),
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
  // The other members who are typing a reply to this thread now (CV3, #2306): their markers have not expired. Never the reader's own.
  composing: z.array(zId),
  // The intent a person applied (CV3, #2306), or null. Never what the AI coworker suggests: that is read apart and shown as a suggestion.
  intent: zConversationIntent.nullable(),
  // An email thread's subject line (#2439): the sender's own words, shown in the thread header; null for every other kind.
  subject: z.string().nullable().optional(),
  // An email thread that was opened by a mail whose sender the receiving server did not vouch for (#2439): shown with a mark.
  senderUnverified: z.boolean().optional(),
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
  // The private-reply conversation started from this comment (CV4, #2308), when the reader may see it.
  privateReplyConversationId: zId.nullable().optional(),
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

// The one placeholder a saved reply may hold (#3102, plan docs/plan/conversations.md section 5.6): the contact's display name, written `{tên}`. It is
// filled in the reply box when the reply is picked, so the person reads the final text before pressing Send, and the send command refuses a body that
// still holds it, so the braces never reach a customer. No other field is a placeholder. Case and the missing diacritic are tolerated ("{Tên}", "{ten}"),
// and spaces inside the braces; the body is read in NFC so a name typed with combining marks matches too.
export const SAVED_REPLY_NAME_PLACEHOLDER = '{tên}';
// One or two braces each side ("{tên}", "{{tên}}"): bounded, so a text of many braces cannot make the match slow.
const NAME_PLACEHOLDER = /\{{1,2}[^\S\n]*t[eê]n[^\S\n]*\}{1,2}/giu;
// The longest name that is put into a reply: a platform name is untrusted text of any length.
const FILLED_NAME_MAX = 100;

/** Whether the text still holds the contact-name placeholder (a reply with one is refused by the send command). */
export function hasNamePlaceholder(text: string): boolean {
  return new RegExp(NAME_PLACEHOLDER.source, NAME_PLACEHOLDER.flags).test(text.normalize('NFC'));
}

// What of a contact's name may be put into a reply: one line, no control or invisible characters, no braces (so a name can never write a placeholder),
// at most FILLED_NAME_MAX characters. Null when nothing is left.
function usableName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = Array.from(
    name
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}{}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, FILLED_NAME_MAX)
    .join('')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** Fills the placeholder of a saved reply (or of a draft that kept it) with the contact's name. With no usable name the placeholder is dropped and the text
 * around it tidied (no double space, no space or stray comma before a mark), so no "{tên}" ever stays. A text with no placeholder comes back unchanged. */
export function fillNamePlaceholder(text: string, name: string | null | undefined): string {
  const body = text.normalize('NFC');
  if (!hasNamePlaceholder(body)) return text;
  const filled = usableName(name);
  if (filled !== null) return body.replace(NAME_PLACEHOLDER, () => filled);
  // Each placeholder becomes a mark, and only the spaces and the marks of punctuation next to a mark are tidied: the rest of the text stays as written.
  const MARK = '\uE000';
  return body
    .replaceAll(MARK, '')
    .replace(NAME_PLACEHOLDER, MARK)
    .replace(/\uE000(?:[^\S\n]*\uE000)+/gu, MARK)
    .replace(/(^|\n)[^\S\n]*\uE000[^\S\n]*(?:[,;:]+[^\S\n]*)?/gu, '$1')
    .replace(/[,;:][^\S\n]*\uE000(?=[,.!?…])/gu, '')
    .replace(/([([])[^\S\n]*\uE000[^\S\n]*/gu, '$1')
    .replace(/[^\S\n]*\uE000(?=[,.;:!?…)\]])/gu, '')
    .replace(/[^\S\n]*\uE000[^\S\n]*(?=\n|$)/gu, '')
    .replace(/[^\S\n]*\uE000[^\S\n]*/gu, ' ')
    .trim();
}

// Another thread of the same customer, as the contact panel lists it: what it is and where it stands, no text.
export const CONVERSATION_OTHERS_MAX = 10;
export const zConversationOther = z.strictObject({
  id: zId,
  kind: zConversationKind,
  status: zConversationStatus,
  channel: z.strictObject({ connectionId: zId, provider: z.string(), displayName: z.string() }),
  lastMessageAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ConversationOther = z.infer<typeof zConversationOther>;

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
  // The customer's other threads that the reader may read (CV3, the contact panel): newest first, at most CONVERSATION_OTHERS_MAX.
  others: z.array(zConversationOther),
});
export type ConversationDetail = z.infer<typeof zConversationDetail>;

export const zConversationList = z.strictObject({
  status: zConversationStatus.optional(),
  kind: zConversationKind.optional(),
  connectionId: zId.optional(),
  // The threads under these posts (a post page lists the threads of all its channels).
  posts: z.array(z.strictObject({ connectionId: zId, externalPostId: z.string().min(1).max(300) })).min(1).max(CONVERSATION_POSTS_MAX).optional(),
  assignee: z.enum(['me', 'none']).optional(),
  // The threads a person labelled with this intent, or those with no label (CV3, #2306).
  intent: z.union([zConversationIntent, z.literal('none')]).optional(),
  // A search over the customer's name, the contact's name and the words of the thread, ignoring case, Vietnamese marks and punctuation (CV3).
  q: z.string().trim().min(1).max(CONVERSATION_SEARCH_MAX).refine(noNul, 'NUL character').optional(),
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
// A private reply in Messenger to a customer's comment on a Facebook Page post (CV4, #2308, plan section 7): opens a `direct` conversation
// linked to the comment thread (`parent_conversation_id`) and sends one message to `recipient: { comment_id }` within seven days of the comment.
export const zConversationPrivateReply = z.strictObject({
  messageId: zId,
  body: z.string().trim().min(1).max(CONVERSATION_FACEBOOK_DIRECT_MAX).refine(noNul, 'NUL character'),
});
export const zConversationPrivateReplied = z.strictObject({
  conversationId: zId,
  messageId: zId,
  seq: z.number().int(),
});
export type ConversationPrivateReplied = z.infer<typeof zConversationPrivateReplied>;
export const zConversationSettle = z.strictObject({ messageId: zId, action: z.enum(['retry', 'mark_sent']) });
export const zConversationHide = z.strictObject({ messageId: zId, hidden: z.boolean() });
export const zConversationAssign = z.strictObject({ conversationId: zId, assigneeUserId: zId.nullable() });
export const zConversationId = z.strictObject({ conversationId: zId });
export const zConversationNoteAdd = z.strictObject({ conversationId: zId, body: z.string().trim().min(1).max(CONVERSATION_NOTE_MAX).refine(noNul, 'NUL character') });
export const zConversationLinkContact = z.strictObject({ conversationId: zId, partyId: zId.nullable() });
// A person applies an intent to a thread, changes it, or clears it (null) (CV3, #2306).
export const zConversationSetIntent = z.strictObject({ conversationId: zId, intent: zConversationIntent.nullable() });

// The AI coworker's suggestions, read apart from the thread and never stored (CV3, #2306). A suggestion only shows; a person applies it.
// ai: used (the answer came from the model or from what it answered a moment ago), off (the deployment has no model), budget (the org's AI budget of the
// month is spent), busy (too many AI calls just now) or failed (the model gave nothing usable). In every case but used the Inbox works as it did, with
// no suggestion and no error.
export const CONVERSATION_AI_STATES = ['used', 'off', 'budget', 'busy', 'failed'] as const;
// What one suggestion reads of a thread: the customer's last messages, each cut to this many characters (the agent package's bounds, which a test compares).
export const CONVERSATION_INTENT_BATCH_MAX = 10;
export const CONVERSATION_INTENT_MESSAGES = 3;
export const CONVERSATION_INTENT_CHARS = 300;
export const zConversationIntentSuggest = z.strictObject({ conversationIds: z.array(zId).min(1).max(CONVERSATION_INTENT_BATCH_MAX) });
export const zConversationIntentSuggested = z.strictObject({
  ai: z.enum(CONVERSATION_AI_STATES),
  // One entry for each of the threads the reader may read, in the order asked; the intent is null where the model has no suggestion.
  suggestions: z.array(z.strictObject({ conversationId: zId, intent: zConversationIntent.nullable() })),
});
export type ConversationIntentSuggested = z.infer<typeof zConversationIntentSuggested>;
// The contacts a thread's customer may be (a person links one): a contact with the phone number the customer wrote first, then the contacts whose name
// resembles the customer's, ranked by the AI coworker when it is on.
export const CONVERSATION_CONTACT_MATCHES_MAX = 5;
export const zConversationContactMatches = z.strictObject({ conversationId: zId });
export const zConversationContactMatched = z.strictObject({
  ai: z.enum(CONVERSATION_AI_STATES),
  candidates: z.array(z.strictObject({ partyId: zId, name: z.string(), reason: z.enum(['email', 'phone', 'name']) })).max(CONVERSATION_CONTACT_MATCHES_MAX),
});
export type ConversationContactMatched = z.infer<typeof zConversationContactMatched>;
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
// The longest draft a model's answer is kept as, whatever the channel lets a person send (an email reply may be longer): the draft record and the database hold this.
export const CONVERSATION_DRAFT_MAX = 2000;
export const zConversationDraftRecord = z.discriminatedUnion('outcome', [
  // The draft's text (1 to the thread's channel limit), and the model call's tokens for the org's AI cost limit.
  z.strictObject({ outcome: z.literal('written'), draftId: zId, body: z.string().trim().min(1).max(CONVERSATION_DRAFT_MAX).refine(noNul, 'NUL character') }),
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

// The "you are replying" marker (CV3, #2306): a member typing a reply marks the thread for 60 seconds; a mark is written at most once in 20 seconds
// per thread and member, and the screens read it with their poll. A sweep drops the expired ones.
export const CONVERSATION_COMPOSING_SECONDS = 60;
export const CONVERSATION_COMPOSING_EVERY_SECONDS = 20;
export const zConversationComposing = z.strictObject({ conversationId: zId });
export const zConversationComposed = z.strictObject({ marked: z.boolean() });

// A member's availability for the inbox: it decides whom a new conversation is told to. No row means available.
export const MEMBER_AVAILABILITY = ['available', 'away'] as const;
export const zMemberAvailabilityStatus = z.enum(MEMBER_AVAILABILITY);
export const zAvailabilitySet = z.strictObject({ status: zMemberAvailabilityStatus, until: z.iso.datetime({ offset: true }).nullable().optional() });
export const zAvailabilityEntry = z.strictObject({ userId: zId, status: zMemberAvailabilityStatus, until: z.iso.datetime({ offset: true }).nullable() });
export const zAvailability = z.strictObject({ me: zAvailabilityEntry, members: z.array(zAvailabilityEntry) });
export type Availability = z.infer<typeof zAvailability>;
