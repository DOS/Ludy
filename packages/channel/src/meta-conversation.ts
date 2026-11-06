// SPDX-License-Identifier: AGPL-3.0-only
// Facebook Page comments and Messenger direct messages in the conversation core (issues #2307 and #2308, plan docs/plan/conversations.md
// sections 6.1, 6.2, 6.3, 7 and 13 CV2 & CV4): verifying X-Hub-Signature-256 on raw webhook bytes, turning Page `feed` comment notices and
// `messaging` (`messages`, `message_echoes`) notices into core events, replying to a comment (`POST /{comment-id}/comments`), sending a
// Messenger reply or a private reply to a comment (`POST /{page-id}/messages` with 24h `RESPONSE`, 7d `HUMAN_AGENT`, or `recipient.comment_id`),
// hiding or unhiding a customer's comment (`POST /{comment-id}` with `is_hidden`), subscribing the Page (`POST /{page-id}/subscribed_apps`),
// and reconciling recent posts' comments when a webhook was missed.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConversationNoticeError,
  type ConversationAdapter,
  type ConversationCallResult,
  type ConversationErrorKind,
  type ConversationHideInput,
  type ConversationHideResult,
  type ConversationHistoryInput,
  type ConversationHistoryResult,
  type ConversationNotice,
  type ConversationReplyInput,
  type InboundConversationEvent,
} from './conversation.ts';
import { Graph, GraphError, graphPublishResult } from './meta.ts';
import { graphTime } from './recent.ts';

// Meta batches Page webhook entries; 256 KiB is well above a batch of comment changes and small enough to check in memory.
export const FACEBOOK_MAX_NOTICE_BYTES = 256 * 1024;
export const FACEBOOK_SIGNATURE_HEADER = 'x-hub-signature-256';
export const META_USER_ID = /^\d{1,32}$/;
// The hosts Meta serves a customer's Messenger image attachments from (CV4 #2308, CV5c #2357), checked on every redirect hop by the egress guard.
export const FACEBOOK_MEDIA_HOSTS: readonly string[] = ['fbcdn.net', 'fbsbx.com'];
// The hosts Meta serves a customer's Instagram DM image attachments from (CV7 #2309, CV5c #2357).
export const INSTAGRAM_MEDIA_HOSTS: readonly string[] = ['fbcdn.net', 'fbsbx.com', 'cdninstagram.com'];
export const FACEBOOK_DIRECT_TEXT_MAX = 2000;
export const INSTAGRAM_COMMENT_TEXT_MAX = 2200;
export const INSTAGRAM_DIRECT_TEXT_MAX = 1000;
const STANDARD_WINDOW_MS = 24 * 3_600_000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 3_600_000;

// Keyed hash of the Meta user who granted a connection, with the same domain separation as @crove/ad-platform so one Meta data-deletion
// callback (`/api/ads/meta/data-deletion`) matches both Ads and Page connections granted by that person (#2305, #2307).
export function platformUserHash(appSecret: string, userId: string): string {
  return createHmac('sha256', appSecret).update(`ludy.ads.meta_ads.user:${userId}`).digest('hex');
}

const HUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const NUMERIC_ID = /^\d{1,32}$/;
// A Page comment or post id is `<page-id>_<id>` or a numeric object id (videos, photos, comments).
const COMMENT_TARGET_ID = /^\d{1,32}(_\d{1,32})?$/;
const TEXT_MAX = 20_000;
const ID_MAX = 200;
const MESSAGE_ID_MAX = 300;
const IMAGES_MAX = 5;
const IMAGE_URL_MAX = 2000;
const CUSTOMER_ATTACHMENT_PLACEHOLDER = '[Khách gửi bình luận đính kèm]';
const PAGE_ATTACHMENT_PLACEHOLDER = '[Trang đã gửi bình luận đính kèm]';
const DIRECT_CUSTOMER_IMAGE_PLACEHOLDER = '[Khách gửi ảnh]';
const DIRECT_CUSTOMER_ATTACHMENT_PLACEHOLDER = '[Khách gửi tin nhắn đính kèm]';
const DIRECT_PAGE_ATTACHMENT_PLACEHOLDER = '[Trang đã gửi tin nhắn đính kèm]';

export interface MetaSignatureInput {
  // The raw request bytes, before any UTF-8 or JSON decoding (Meta escapes non-ASCII characters as \uXXXX before signing).
  body: Uint8Array;
  // The value of X-Hub-Signature-256 (`sha256=<64 hex>`), or undefined when absent.
  header: string | undefined;
  appSecret: string;
  // Previous app secret while rotating credentials.
  appSecretPrevious?: string | undefined;
}

// Whether the webhook payload was signed by Meta with the app secret (or the previous one during rotation). Constant-time comparison.
export function metaSignatureOk(input: MetaSignatureInput): boolean {
  if (!input.appSecret || input.body.byteLength === 0 || input.body.byteLength > FACEBOOK_MAX_NOTICE_BYTES) return false;
  const match = input.header ? HUB_SIGNATURE.exec(input.header.trim()) : null;
  if (!match) return false;
  const given = Buffer.from(match[1] as string, 'hex');
  const matches = (secret: string): boolean => {
    const expected = createHmac('sha256', secret).update(input.body).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const current = matches(input.appSecret);
  const previous = input.appSecretPrevious ? matches(input.appSecretPrevious) : false;
  return current || previous;
}

const clean = (value: string): string => value.replaceAll('\u0000', '');

const idOf = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = clean(value).trim();
    return trimmed !== '' ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
};

function atOf(value: unknown, now: number = Date.now()): string | null {
  if (typeof value === 'string' && Number.isNaN(Number(value))) {
    const parsed = graphTime(value);
    if (!parsed) return null;
    const ms = parsed.getTime();
    return ms >= Date.UTC(2020, 0, 1) && ms <= now + 86_400_000 ? parsed.toISOString() : null;
  }
  let ms = Number(idOf(value));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1e11) ms *= 1000;
  const date = new Date(ms);
  return ms >= Date.UTC(2020, 0, 1) && ms <= now + 86_400_000 && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

interface FeedCommentValue {
  item?: unknown;
  verb?: unknown;
  id?: unknown;
  comment_id?: unknown;
  parent_id?: unknown;
  post_id?: unknown;
  media?: { id?: unknown } | null;
  from?: { id?: unknown; name?: unknown; username?: unknown } | null;
  message?: unknown;
  text?: unknown;
  created_time?: unknown;
  timestamp?: unknown;
  is_hidden?: unknown;
  hidden?: unknown;
}

interface WebhookChange {
  field?: unknown;
  value?: FeedCommentValue | null;
}

interface MessagingAttachment {
  type?: unknown;
  payload?: { url?: unknown } | null;
}

interface MessagingMessage {
  mid?: unknown;
  text?: unknown;
  is_echo?: unknown;
  is_deleted?: unknown;
  is_unsupported?: unknown;
  attachments?: MessagingAttachment[] | null;
}

interface MessagingItem {
  sender?: { id?: unknown } | null;
  recipient?: { id?: unknown } | null;
  timestamp?: unknown;
  message?: MessagingMessage | null;
}

interface WebhookEntry {
  id?: unknown;
  time?: unknown;
  changes?: WebhookChange[] | null;
  messaging?: MessagingItem[] | null;
  // Handover protocol standby events are received when Meta Business Suite / Page Inbox holds the primary thread receiver role.
  // They are ignored here so Crove never double-stores or answers while standing by (plan section 6.2).
  standby?: unknown;
}

interface WebhookPayload {
  object?: unknown;
  entry?: WebhookEntry[] | null;
}

function imagesOf(value: unknown): Array<{ kind: 'image'; url: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: 'image'; url: string }> = [];
  for (const item of value) {
    if (out.length >= IMAGES_MAX) break;
    const a = item as MessagingAttachment | null;
    if (!a || typeof a !== 'object') continue;
    const url = a.payload?.url;
    if (a.type !== 'image' || typeof url !== 'string' || url.length === 0 || url.length > IMAGE_URL_MAX || !url.startsWith('https://') || url.includes('\u0000')) continue;
    out.push({ kind: 'image', url });
  }
  return out;
}

function eventFromMessaging(pageId: string, entryTime: unknown, item: MessagingItem, now: number): InboundConversationEvent | null {
  if (!item || typeof item !== 'object') return null;
  const msg = item.message;
  if (!msg || typeof msg !== 'object') return null;
  const senderId = idOf(item.sender?.id);
  const recipientId = idOf(item.recipient?.id);
  const mid = idOf(msg.mid);
  const isEcho = msg.is_echo === true || senderId === pageId;
  const customerId = isEcho ? recipientId : senderId;
  const at = atOf(item.timestamp ?? entryTime, now);
  if (!mid || !customerId || customerId === pageId || !at || mid.length > MESSAGE_ID_MAX || customerId.length > ID_MAX) return null;
  if (msg.is_deleted === true) {
    return {
      kind: 'direct',
      threadId: customerId,
      messageId: mid,
      direction: isEcho ? 'out' : 'in',
      contact: { id: customerId },
      text: '',
      at,
      removed: true,
    };
  }
  const rawText = typeof msg.text === 'string' ? clean(msg.text).slice(0, TEXT_MAX) : '';
  const images = !isEcho ? imagesOf(msg.attachments) : [];
  const hasAttachments = (Array.isArray(msg.attachments) && msg.attachments.length > 0) || msg.is_unsupported === true;
  if (rawText === '' && !hasAttachments) return null;
  const placeholder = isEcho
    ? DIRECT_PAGE_ATTACHMENT_PLACEHOLDER
    : images.length > 0
      ? DIRECT_CUSTOMER_IMAGE_PLACEHOLDER
      : DIRECT_CUSTOMER_ATTACHMENT_PLACEHOLDER;
  return {
    kind: 'direct',
    threadId: customerId,
    messageId: mid,
    direction: isEcho ? 'out' : 'in',
    contact: { id: customerId },
    text: rawText !== '' ? rawText : placeholder,
    at,
    ...(images.length > 0 ? { attachments: images } : {}),
  };
}

function eventFromChange(pageId: string, entryTime: unknown, change: WebhookChange, now: number): InboundConversationEvent | null {
  if (!change || typeof change !== 'object' || change.field !== 'feed') return null;
  const v = change.value;
  if (!v || typeof v !== 'object' || v.item !== 'comment') return null;
  const verb = typeof v.verb === 'string' ? v.verb : '';
  if (verb !== 'add' && verb !== 'edited' && verb !== 'remove' && verb !== 'hide' && verb !== 'unhide') return null;
  const commentId = idOf(v.comment_id);
  const postId = idOf(v.post_id) ?? idOf(v.parent_id);
  const parentId = idOf(v.parent_id);
  const at = atOf(v.created_time ?? entryTime, now);
  if (!commentId || !postId || !at || commentId.length > MESSAGE_ID_MAX || postId.length > ID_MAX) return null;
  const threadId = parentId && parentId !== postId && parentId.length <= ID_MAX ? parentId : commentId;
  if (threadId.length > ID_MAX) return null;
  const fromId = idOf(v.from?.id);
  if (fromId && fromId.length > ID_MAX) return null;
  const fromName = typeof v.from?.name === 'string' ? clean(v.from.name).trim().slice(0, ID_MAX) : '';
  const fromPage = fromId === pageId;
  const contactId = fromPage ? `commenter:${threadId}` : (fromId ?? `commenter:${threadId}`);
  const rawMessage = typeof v.message === 'string' ? clean(v.message).slice(0, TEXT_MAX) : '';
  if (verb === 'remove') {
    return {
      kind: 'comment_thread',
      threadId,
      postId,
      messageId: commentId,
      direction: fromPage ? 'out' : 'in',
      contact: { id: contactId, ...(!fromPage && fromName ? { name: fromName } : {}) },
      text: '',
      at,
      removed: true,
    };
  }
  if (verb === 'hide' || verb === 'unhide') {
    return {
      kind: 'comment_thread',
      threadId,
      postId,
      messageId: commentId,
      direction: fromPage ? 'out' : 'in',
      contact: { id: contactId, ...(!fromPage && fromName ? { name: fromName } : {}) },
      text: rawMessage,
      at,
      hidden: verb === 'hide',
      ...(rawMessage === '' ? { hiddenOnly: true } : {}),
    };
  }
  const placeholder = fromPage ? PAGE_ATTACHMENT_PLACEHOLDER : CUSTOMER_ATTACHMENT_PLACEHOLDER;
  return {
    kind: 'comment_thread',
    threadId,
    postId,
    messageId: commentId,
    direction: fromPage ? 'out' : 'in',
    contact: { id: contactId, ...(!fromPage && fromName ? { name: fromName } : {}) },
    text: rawMessage !== '' ? rawMessage : placeholder,
    at,
    ...(verb === 'edited' ? { edited: true } : {}),
    ...(typeof v.is_hidden === 'boolean' ? { hidden: v.is_hidden } : {}),
  };
}

const sortCommentEvents = (events: InboundConversationEvent[]): InboundConversationEvent[] =>
  events
    .map((event, i) => ({ event, i }))
    .sort(
      (a, b) =>
        Date.parse(a.event.at) - Date.parse(b.event.at) ||
        (a.event.threadId === a.event.messageId ? 0 : 1) - (b.event.threadId === b.event.messageId ? 0 : 1) ||
        a.i - b.i,
    )
    .map(({ event }) => event);

// Parses a Meta `object: 'page'` webhook payload into one ConversationNotice per Page entry in the batch. Non-comment feed changes (status,
// photo, like, reaction) are ignored so the route acknowledges the delivery with 200 without storing noise.
export function parseFacebookNotices(body: Uint8Array, now: number = Date.now()): ConversationNotice[] {
  if (body.byteLength === 0 || body.byteLength > FACEBOOK_MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationNoticeError('malformed');
  const payload = parsed as WebhookPayload;
  if (typeof payload.object !== 'string' || !Array.isArray(payload.entry)) throw new ConversationNoticeError('malformed');
  if (payload.object !== 'page') return [];
  const byPage = new Map<string, InboundConversationEvent[]>();
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const pageId = idOf(entry.id);
    if (!pageId || !NUMERIC_ID.test(pageId)) continue;
    const list = byPage.get(pageId) ?? [];
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const event = eventFromChange(pageId, entry.time, change, now);
      if (event) list.push(event);
    }
    for (const msg of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const event = eventFromMessaging(pageId, entry.time, msg, now);
      if (event) list.push(event);
    }
    byPage.set(pageId, list);
  }
  return [...byPage.entries()].map(([accountId, events]) => ({ accountId, events: sortCommentEvents(events) }));
}

// Single-notice helper for callers and tests when a webhook carries one Page entry.
export function parseFacebookNotice(body: Uint8Array, now: number = Date.now()): ConversationNotice {
  const notices = parseFacebookNotices(body, now);
  if (notices.length === 0) return { accountId: '', events: [] };
  if (notices.length === 1) return notices[0] as ConversationNotice;
  const first = notices[0] as ConversationNotice;
  return { accountId: first.accountId, events: notices.flatMap((n) => n.events) };
}

function eventFromInstagramChange(igId: string, entryTime: unknown, change: WebhookChange, now: number): InboundConversationEvent | null {
  if (!change || typeof change !== 'object') return null;
  if (change.field !== 'comments' && change.field !== 'live_comments') return null;
  const v = change.value;
  if (!v || typeof v !== 'object') return null;
  const commentId = idOf(v.id ?? v.comment_id);
  const postId = idOf(v.media?.id ?? v.post_id) ?? idOf(v.parent_id);
  const parentId = idOf(v.parent_id);
  const at = atOf(v.timestamp ?? v.created_time ?? entryTime, now);
  if (!commentId || !postId || !at || commentId.length > MESSAGE_ID_MAX || postId.length > ID_MAX) return null;
  const threadId = parentId && parentId !== postId && parentId.length <= ID_MAX ? parentId : commentId;
  if (threadId.length > ID_MAX) return null;
  const fromId = idOf(v.from?.id);
  if (fromId && fromId.length > ID_MAX) return null;
  const rawName = typeof v.from?.username === 'string' && v.from.username.trim() !== '' ? v.from.username : v.from?.name;
  const fromName = typeof rawName === 'string' ? clean(rawName).trim().slice(0, ID_MAX) : '';
  const fromSelf = fromId === igId;
  const contactId = fromSelf ? `commenter:${threadId}` : (fromId ?? `commenter:${threadId}`);
  const rawText = typeof v.text === 'string' ? clean(v.text).slice(0, TEXT_MAX) : typeof v.message === 'string' ? clean(v.message).slice(0, TEXT_MAX) : '';
  const placeholder = fromSelf ? PAGE_ATTACHMENT_PLACEHOLDER : CUSTOMER_ATTACHMENT_PLACEHOLDER;
  const hiddenVal = typeof v.hidden === 'boolean' ? v.hidden : typeof v.is_hidden === 'boolean' ? v.is_hidden : undefined;
  return {
    kind: 'comment_thread',
    threadId,
    postId,
    messageId: commentId,
    direction: fromSelf ? 'out' : 'in',
    contact: { id: contactId, ...(!fromSelf && fromName ? { name: fromName } : {}) },
    text: rawText !== '' ? rawText : placeholder,
    at,
    ...(hiddenVal !== undefined ? { hidden: hiddenVal } : {}),
  };
}

// Parses a Meta `object: 'instagram'` webhook payload into one ConversationNotice per Instagram Business Account entry in the batch
// (CV7 #2309, plan section 6.4). Handles `comments` / `live_comments` changes and `messaging` (`messages`, `message_echoes`) items while
// ignoring `standby` handover entries and non-comment/non-message fields.
export function parseInstagramNotices(body: Uint8Array, now: number = Date.now()): ConversationNotice[] {
  if (body.byteLength === 0 || body.byteLength > FACEBOOK_MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationNoticeError('malformed');
  const payload = parsed as WebhookPayload;
  if (typeof payload.object !== 'string' || !Array.isArray(payload.entry)) throw new ConversationNoticeError('malformed');
  if (payload.object !== 'instagram') return [];
  const byAccount = new Map<string, InboundConversationEvent[]>();
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const igId = idOf(entry.id);
    if (!igId || !NUMERIC_ID.test(igId)) continue;
    const list = byAccount.get(igId) ?? [];
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const event = eventFromInstagramChange(igId, entry.time, change, now);
      if (event) list.push(event);
    }
    for (const msg of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const event = eventFromMessaging(igId, entry.time, msg, now);
      if (event) list.push(event);
    }
    byAccount.set(igId, list);
  }
  return [...byAccount.entries()].map(([accountId, events]) => ({ accountId, events: sortCommentEvents(events) }));
}

export function parseInstagramNotice(body: Uint8Array, now: number = Date.now()): ConversationNotice {
  const notices = parseInstagramNotices(body, now);
  if (notices.length === 0) return { accountId: '', events: [] };
  if (notices.length === 1) return notices[0] as ConversationNotice;
  const first = notices[0] as ConversationNotice;
  return { accountId: first.accountId, events: notices.flatMap((n) => n.events) };
}

function pageToken(secret: string): string | null {
  try {
    const token = (JSON.parse(secret) as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

function conversationCallError(error: unknown): ConversationCallResult {
  const res = graphPublishResult(error);
  if (res.kind === 'rejected') {
    return {
      kind: 'rejected',
      error: res.error,
      ...(res.code ? { code: res.code } : {}),
      ...(res.retryAt ? { retryAt: res.retryAt } : {}),
    };
  }
  return { kind: 'unknown', ...(res.kind === 'unknown' && res.code ? { code: res.code } : {}) };
}

function messengerCallError(error: unknown): ConversationCallResult {
  if (error instanceof GraphError) {
    // 2018278 / 2018065: outside the allowed messaging window (24h standard or 7d HUMAN_AGENT).
    if (error.subcode === 2018278 || error.subcode === 2018065) {
      return { kind: 'rejected', error: 'bad_request', code: 'FB_WINDOW_CLOSED' };
    }
    // 10900 / subcode 1772011: a private reply was already sent to this comment, or the 7-day private-reply window passed.
    if (error.code === 10900 || error.subcode === 10900 || error.subcode === 1772011) {
      return { kind: 'rejected', error: 'bad_request', code: 'FB_PRIVATE_REPLIED' };
    }
    // 551: the person is unavailable on Messenger (blocked the Page or deactivated).
    if (error.code === 551 || error.subcode === 551) {
      return { kind: 'rejected', error: 'bad_request', code: 'FB_RECIPIENT_UNAVAILABLE' };
    }
    if (error.code === 100 && error.subcode === 33) {
      return { kind: 'rejected', error: 'bad_request', code: 'FB_NOT_FOUND' };
    }
  }
  return conversationCallError(error);
}

function conversationHideError(error: unknown): ConversationHideResult {
  const res = graphPublishResult(error);
  if (res.kind === 'rejected') {
    return {
      kind: 'rejected',
      error: res.error,
      ...(res.code ? { code: res.code } : {}),
      ...(res.retryAt ? { retryAt: res.retryAt } : {}),
    };
  }
  return { kind: 'unknown', ...(res.kind === 'unknown' && res.code ? { code: res.code } : {}) };
}

interface PublishedPostsAnswer {
  data?: Array<{ id?: unknown; created_time?: unknown }>;
}

interface PostCommentsAnswer {
  data?: Array<{
    id?: unknown;
    parent?: { id?: unknown } | null;
    from?: { id?: unknown; name?: unknown } | null;
    message?: unknown;
    created_time?: unknown;
    is_hidden?: unknown;
  }>;
  paging?: { next?: unknown };
}

const RECONCILE_POSTS_MAX = 25;
const RECONCILE_COMMENTS_PER_POST = 100;

export class FacebookPageConversations implements ConversationAdapter {
  readonly provider = 'facebook_page' as const;
  private readonly graph: Graph;

  constructor(graph: Graph) {
    this.graph = graph;
  }

  // Replies to a comment thread (`POST /{comment-id}/comments`) or sends a Messenger direct message / private reply to a comment
  // (`POST /{page-id}/messages`). Never retried automatically after an unclear answer because neither Graph endpoint takes an idempotency key.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PAGE_ID' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    if (input.kind === 'direct') {
      if (input.text.length > FACEBOOK_DIRECT_TEXT_MAX) {
        return { kind: 'rejected', error: 'bad_request', code: 'FB_TEXT_LENGTH' };
      }
      if (input.threadId.startsWith('private:')) {
        const commentId = input.threadId.slice('private:'.length);
        if (!COMMENT_TARGET_ID.test(commentId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
        try {
          const answer = await this.graph.call<{ message_id?: unknown; id?: unknown }>('POST', `${input.externalAccountId}/messages`, {
            token,
            json: { recipient: { comment_id: commentId }, message: { text: input.text } },
          });
          const msgId = typeof answer.message_id === 'string' && answer.message_id ? answer.message_id : typeof answer.id === 'string' && answer.id ? answer.id : null;
          if (!msgId) return { kind: 'unknown', code: 'FB_NO_MESSAGE_ID' };
          return { kind: 'accepted', externalId: msgId.slice(0, MESSAGE_ID_MAX) };
        } catch (error) {
          return messengerCallError(error);
        }
      }
      if (!NUMERIC_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_RECIPIENT_ID' };
      let useHumanAgent = false;
      if (typeof input.lastInboundAt === 'string' && input.lastInboundAt) {
        const inboundMs = Date.parse(input.lastInboundAt);
        if (Number.isFinite(inboundMs)) {
          const ageMs = Date.now() - inboundMs;
          if (ageMs > HUMAN_AGENT_WINDOW_MS) {
            return { kind: 'rejected', error: 'bad_request', code: 'FB_WINDOW_CLOSED' };
          }
          if (ageMs > STANDARD_WINDOW_MS) {
            useHumanAgent = true;
          }
        }
      }
      try {
        const answer = await this.graph.call<{ message_id?: unknown; id?: unknown }>('POST', `${input.externalAccountId}/messages`, {
          token,
          json: {
            recipient: { id: input.threadId },
            messaging_type: useHumanAgent ? 'MESSAGE_TAG' : 'RESPONSE',
            ...(useHumanAgent ? { tag: 'HUMAN_AGENT' } : {}),
            message: { text: input.text },
          },
        });
        const msgId = typeof answer.message_id === 'string' && answer.message_id ? answer.message_id : typeof answer.id === 'string' && answer.id ? answer.id : null;
        if (!msgId) return { kind: 'unknown', code: 'FB_NO_MESSAGE_ID' };
        return { kind: 'accepted', externalId: msgId.slice(0, MESSAGE_ID_MAX) };
      } catch (error) {
        return messengerCallError(error);
      }
    }
    if (!COMMENT_TARGET_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    try {
      const answer = await this.graph.call<{ id?: unknown }>('POST', `${input.threadId}/comments`, {
        token,
        form: { message: input.text },
      });
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: answer.id.slice(0, MESSAGE_ID_MAX) };
    } catch (error) {
      return conversationCallError(error);
    }
  }

  // Hides or unhides a customer's comment on a Page post (`POST /{comment-id}` with `is_hidden`). Idempotent on Meta.
  async hide(input: ConversationHideInput): Promise<ConversationHideResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PAGE_ID' };
    if (!COMMENT_TARGET_ID.test(input.externalMessageId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', input.externalMessageId, {
        token,
        form: { is_hidden: input.hidden ? 'true' : 'false' },
      });
      return answer.success === true ? { kind: 'done' } : { kind: 'unknown', code: 'HIDE_NOT_CONFIRMED' };
    } catch (error) {
      return conversationHideError(error);
    }
  }

  // Subscribes the Page to `feed`, `messages` and `message_echoes` webhook deliveries (`POST /{page-id}/subscribed_apps`). Falls back to
  // `feed` alone if the Page token was granted comment scopes without `pages_messaging`. Idempotent.
  async subscribe(input: { externalAccountId: string; secret: string; fields?: string }): Promise<{ ok: true } | { ok: false; error: ConversationErrorKind | 'unknown'; code?: string }> {
    const token = pageToken(input.secret);
    if (!token) return { ok: false, error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { ok: false, error: 'bad_request', code: 'BAD_PAGE_ID' };
    const fields = input.fields ?? 'feed,messages,message_echoes';
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', `${input.externalAccountId}/subscribed_apps`, {
        token,
        form: { subscribed_fields: fields },
      });
      return answer.success === true ? { ok: true } : { ok: false, error: 'unknown', code: 'SUBSCRIBE_NOT_CONFIRMED' };
    } catch (error) {
      const res = graphPublishResult(error);
      if (!input.fields && res.kind === 'rejected' && res.error === 'permission') {
        return this.subscribe({ externalAccountId: input.externalAccountId, secret: input.secret, fields: 'feed' });
      }
      if (res.kind === 'rejected') return { ok: false, error: res.error, ...(res.code ? { code: res.code } : {}) };
      return { ok: false, error: 'unknown', ...(res.kind === 'unknown' && res.code ? { code: res.code } : {}) };
    }
  }

  // Reconciles the Page's comment threads (plan section 6.3): re-subscribes the Page to `feed` (idempotent), then reads the comments of
  // the Page's recent posts (`GET /{post-id}/comments?filter=stream&order=reverse_chronological`) back to `input.since`.
  async history(input: ConversationHistoryInput): Promise<ConversationHistoryResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'failed', retry: false, code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'failed', retry: false, code: 'BAD_PAGE_ID' };
    const sub = await this.subscribe({ externalAccountId: input.externalAccountId, secret: input.secret });
    if (!sub.ok && sub.error === 'token_expired') {
      return { kind: 'failed', retry: false, ...(sub.code ? { code: sub.code } : {}) };
    }
    const maxPosts = Math.max(1, Math.min(input.maxChats, RECONCILE_POSTS_MAX));
    let postsAnswer: PublishedPostsAnswer;
    try {
      postsAnswer = await this.graph.call<PublishedPostsAnswer>('GET', `${input.externalAccountId}/published_posts`, {
        token,
        params: { fields: 'id,created_time', limit: String(maxPosts) },
      });
    } catch (error) {
      const res = graphPublishResult(error);
      if (res.kind === 'rejected' && (res.error === 'token_expired' || res.error === 'permission' || res.error === 'bad_request')) {
        return { kind: 'failed', retry: false, ...(res.code ? { code: res.code } : {}) };
      }
      const code = (res.kind === 'rejected' || res.kind === 'unknown') ? res.code : undefined;
      return { kind: 'failed', retry: true, ...(code ? { code } : {}) };
    }
    const events: InboundConversationEvent[] = [];
    let complete = true;
    let oldestMs: number | null = null;
    const sinceMs = input.since.getTime();
    for (const post of (postsAnswer.data ?? []).slice(0, maxPosts)) {
      const postId = idOf(post.id);
      if (!postId || !/^\d{1,32}_\d{1,32}$/.test(postId)) continue;
      let commentsAnswer: PostCommentsAnswer;
      try {
        commentsAnswer = await this.graph.call<PostCommentsAnswer>('GET', `${postId}/comments`, {
          token,
          params: {
            filter: 'stream',
            order: 'reverse_chronological',
            fields: 'id,parent{id},from{id,name},message,created_time,is_hidden',
            limit: String(RECONCILE_COMMENTS_PER_POST),
          },
        });
      } catch (error) {
        if (error instanceof GraphError && error.code === 100 && error.subcode === 33) continue;
        const res = graphPublishResult(error);
        if (res.kind === 'rejected' && (res.error === 'token_expired' || res.error === 'permission')) {
          return { kind: 'failed', retry: false, ...(res.code ? { code: res.code } : {}) };
        }
        const code = (res.kind === 'rejected' || res.kind === 'unknown') ? res.code : undefined;
        return { kind: 'failed', retry: true, ...(code ? { code } : {}) };
      }
      const rows = commentsAnswer.data ?? [];
      let reachedSince = false;
      for (const c of rows) {
        const commentId = idOf(c.id);
        const at = atOf(c.created_time);
        if (!commentId || !at || commentId.length > MESSAGE_ID_MAX) continue;
        const atMs = Date.parse(at);
        if (oldestMs === null || atMs < oldestMs) oldestMs = atMs;
        if (atMs < sinceMs) {
          reachedSince = true;
          continue;
        }
        const parentId = idOf(c.parent?.id);
        const threadId = parentId && parentId !== postId && parentId.length <= ID_MAX ? parentId : commentId;
        if (threadId.length > ID_MAX) continue;
        const fromId = idOf(c.from?.id);
        if (fromId && fromId.length > ID_MAX) continue;
        const fromName = typeof c.from?.name === 'string' ? clean(c.from.name).trim().slice(0, ID_MAX) : '';
        const fromPage = fromId === input.externalAccountId;
        const contactId = fromPage ? `commenter:${threadId}` : (fromId ?? `commenter:${threadId}`);
        const rawMessage = typeof c.message === 'string' ? clean(c.message).slice(0, TEXT_MAX) : '';
        const placeholder = fromPage ? PAGE_ATTACHMENT_PLACEHOLDER : CUSTOMER_ATTACHMENT_PLACEHOLDER;
        events.push({
          kind: 'comment_thread',
          threadId,
          postId,
          messageId: commentId,
          direction: fromPage ? 'out' : 'in',
          contact: { id: contactId, ...(!fromPage && fromName ? { name: fromName } : {}) },
          text: rawMessage !== '' ? rawMessage : placeholder,
          at,
          ...(typeof c.is_hidden === 'boolean' ? { hidden: c.is_hidden } : {}),
        });
      }
      if (!reachedSince && rows.length >= RECONCILE_COMMENTS_PER_POST && typeof commentsAnswer.paging?.next === 'string') {
        complete = false;
      }
    }
    return {
      kind: 'ok',
      events: sortCommentEvents(events),
      complete,
      oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    };
  }
}

interface InstagramMediaAnswer {
  data?: Array<{ id?: unknown; timestamp?: unknown }>;
}

interface InstagramCommentRow {
  id?: unknown;
  text?: unknown;
  timestamp?: unknown;
  hidden?: unknown;
  from?: { id?: unknown; username?: unknown } | null;
  replies?: { data?: InstagramCommentRow[] | null } | null;
}

interface InstagramCommentsAnswer {
  data?: InstagramCommentRow[];
  paging?: { next?: unknown };
}

function instagramSecret(secret: string): { accessToken: string; pageId: string | null } | null {
  try {
    const parsed = JSON.parse(secret) as { accessToken?: unknown; pageId?: unknown };
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    const pageId = typeof parsed.pageId === 'string' && NUMERIC_ID.test(parsed.pageId) ? parsed.pageId : null;
    return { accessToken: parsed.accessToken, pageId };
  } catch {
    return null;
  }
}

export class InstagramConversations implements ConversationAdapter {
  readonly provider = 'instagram' as const;
  private readonly graph: Graph;

  constructor(graph: Graph) {
    this.graph = graph;
  }

  // Replies to an Instagram comment thread (`POST /{ig-comment-id}/replies`) or sends an Instagram direct message / private reply to a
  // comment (`POST /{ig-account-id}/messages`). Never retried automatically after an unclear answer.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const s = instagramSecret(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_IG_ID' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    if (input.kind === 'direct') {
      if (input.text.length > INSTAGRAM_DIRECT_TEXT_MAX) {
        return { kind: 'rejected', error: 'bad_request', code: 'IG_TEXT_LENGTH' };
      }
      if (input.threadId.startsWith('private:')) {
        const commentId = input.threadId.slice('private:'.length);
        if (!COMMENT_TARGET_ID.test(commentId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
        try {
          const answer = await this.graph.call<{ message_id?: unknown; id?: unknown }>('POST', `${input.externalAccountId}/messages`, {
            token: s.accessToken,
            json: { recipient: { comment_id: commentId }, message: { text: input.text } },
          });
          const msgId = typeof answer.message_id === 'string' && answer.message_id ? answer.message_id : typeof answer.id === 'string' && answer.id ? answer.id : null;
          if (!msgId) return { kind: 'unknown', code: 'FB_NO_MESSAGE_ID' };
          return { kind: 'accepted', externalId: msgId.slice(0, MESSAGE_ID_MAX) };
        } catch (error) {
          return messengerCallError(error);
        }
      }
      if (!NUMERIC_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_RECIPIENT_ID' };
      let useHumanAgent = false;
      if (typeof input.lastInboundAt === 'string' && input.lastInboundAt) {
        const inboundMs = Date.parse(input.lastInboundAt);
        if (Number.isFinite(inboundMs)) {
          const ageMs = Date.now() - inboundMs;
          if (ageMs > HUMAN_AGENT_WINDOW_MS) {
            return { kind: 'rejected', error: 'bad_request', code: 'FB_WINDOW_CLOSED' };
          }
          if (ageMs > STANDARD_WINDOW_MS) {
            useHumanAgent = true;
          }
        }
      }
      try {
        const answer = await this.graph.call<{ message_id?: unknown; id?: unknown }>('POST', `${input.externalAccountId}/messages`, {
          token: s.accessToken,
          json: {
            recipient: { id: input.threadId },
            messaging_type: useHumanAgent ? 'MESSAGE_TAG' : 'RESPONSE',
            ...(useHumanAgent ? { tag: 'HUMAN_AGENT' } : {}),
            message: { text: input.text },
          },
        });
        const msgId = typeof answer.message_id === 'string' && answer.message_id ? answer.message_id : typeof answer.id === 'string' && answer.id ? answer.id : null;
        if (!msgId) return { kind: 'unknown', code: 'FB_NO_MESSAGE_ID' };
        return { kind: 'accepted', externalId: msgId.slice(0, MESSAGE_ID_MAX) };
      } catch (error) {
        return messengerCallError(error);
      }
    }
    if (input.text.length > INSTAGRAM_COMMENT_TEXT_MAX) {
      return { kind: 'rejected', error: 'bad_request', code: 'IG_COMMENT_LENGTH' };
    }
    if (!COMMENT_TARGET_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    try {
      const answer = await this.graph.call<{ id?: unknown }>('POST', `${input.threadId}/replies`, {
        token: s.accessToken,
        form: { message: input.text },
      });
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: answer.id.slice(0, MESSAGE_ID_MAX) };
    } catch (error) {
      return conversationCallError(error);
    }
  }

  // Hides or unhides a customer's comment on an Instagram media object (`POST /{ig-comment-id}` with `hide=true|false`). Idempotent on Meta.
  async hide(input: ConversationHideInput): Promise<ConversationHideResult> {
    const s = instagramSecret(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_IG_ID' };
    if (!COMMENT_TARGET_ID.test(input.externalMessageId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', input.externalMessageId, {
        token: s.accessToken,
        form: { hide: input.hidden ? 'true' : 'false' },
      });
      return answer.success === true ? { kind: 'done' } : { kind: 'unknown', code: 'HIDE_NOT_CONFIRMED' };
    } catch (error) {
      return conversationHideError(error);
    }
  }

  // Subscribes the linked Facebook Page so Meta forwards Instagram webhook deliveries (`POST /{page-id}/subscribed_apps`).
  async subscribe(input: { externalAccountId: string; secret: string; fields?: string }): Promise<{ ok: true } | { ok: false; error: ConversationErrorKind | 'unknown'; code?: string }> {
    const s = instagramSecret(input.secret);
    if (!s) return { ok: false, error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!s.pageId) return { ok: false, error: 'bad_request', code: 'NO_PAGE_ID' };
    const fields = input.fields ?? 'feed,messages,message_echoes';
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', `${s.pageId}/subscribed_apps`, {
        token: s.accessToken,
        form: { subscribed_fields: fields },
      });
      return answer.success === true ? { ok: true } : { ok: false, error: 'unknown', code: 'SUBSCRIBE_NOT_CONFIRMED' };
    } catch (error) {
      const res = graphPublishResult(error);
      if (!input.fields && res.kind === 'rejected' && res.error === 'permission') {
        return this.subscribe({ externalAccountId: input.externalAccountId, secret: input.secret, fields: 'feed' });
      }
      if (res.kind === 'rejected') return { ok: false, error: res.error, ...(res.code ? { code: res.code } : {}) };
      return { ok: false, error: 'unknown', ...(res.kind === 'unknown' && res.code ? { code: res.code } : {}) };
    }
  }

  // Reconciles the Instagram Business Account's recent media comments (plan section 6.4): re-subscribes the linked Page when present, then
  // reads the comments and replies of recent media (`GET /{ig-id}/media` and `GET /{media-id}/comments`) back to `input.since`.
  async history(input: ConversationHistoryInput): Promise<ConversationHistoryResult> {
    const s = instagramSecret(input.secret);
    if (!s) return { kind: 'failed', retry: false, code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'failed', retry: false, code: 'BAD_IG_ID' };
    if (s.pageId) {
      const sub = await this.subscribe({ externalAccountId: input.externalAccountId, secret: input.secret });
      if (!sub.ok && sub.error === 'token_expired') {
        return { kind: 'failed', retry: false, ...(sub.code ? { code: sub.code } : {}) };
      }
    }
    const maxMedia = Math.max(1, Math.min(input.maxChats, RECONCILE_POSTS_MAX));
    let mediaAnswer: InstagramMediaAnswer;
    try {
      mediaAnswer = await this.graph.call<InstagramMediaAnswer>('GET', `${input.externalAccountId}/media`, {
        token: s.accessToken,
        params: { fields: 'id,timestamp', limit: String(maxMedia) },
      });
    } catch (error) {
      const res = graphPublishResult(error);
      if (res.kind === 'rejected' && (res.error === 'token_expired' || res.error === 'permission' || res.error === 'bad_request')) {
        return { kind: 'failed', retry: false, ...(res.code ? { code: res.code } : {}) };
      }
      const code = (res.kind === 'rejected' || res.kind === 'unknown') ? res.code : undefined;
      return { kind: 'failed', retry: true, ...(code ? { code } : {}) };
    }
    const events: InboundConversationEvent[] = [];
    let complete = true;
    let oldestMs: number | null = null;
    const sinceMs = input.since.getTime();
    const pushRow = (mediaId: string, threadId: string, row: InstagramCommentRow): boolean => {
      const commentId = idOf(row.id);
      const at = atOf(row.timestamp);
      if (!commentId || !at || commentId.length > MESSAGE_ID_MAX || threadId.length > ID_MAX) return false;
      const atMs = Date.parse(at);
      if (oldestMs === null || atMs < oldestMs) oldestMs = atMs;
      if (atMs < sinceMs) return true;
      const fromId = idOf(row.from?.id);
      if (fromId && fromId.length > ID_MAX) return false;
      const fromName = typeof row.from?.username === 'string' ? clean(row.from.username).trim().slice(0, ID_MAX) : '';
      const fromSelf = fromId === input.externalAccountId;
      const contactId = fromSelf ? `commenter:${threadId}` : (fromId ?? `commenter:${threadId}`);
      const rawText = typeof row.text === 'string' ? clean(row.text).slice(0, TEXT_MAX) : '';
      const placeholder = fromSelf ? PAGE_ATTACHMENT_PLACEHOLDER : CUSTOMER_ATTACHMENT_PLACEHOLDER;
      events.push({
        kind: 'comment_thread',
        threadId,
        postId: mediaId,
        messageId: commentId,
        direction: fromSelf ? 'out' : 'in',
        contact: { id: contactId, ...(!fromSelf && fromName ? { name: fromName } : {}) },
        text: rawText !== '' ? rawText : placeholder,
        at,
        ...(typeof row.hidden === 'boolean' ? { hidden: row.hidden } : {}),
      });
      return false;
    };
    for (const media of (mediaAnswer.data ?? []).slice(0, maxMedia)) {
      const mediaId = idOf(media.id);
      if (!mediaId || !NUMERIC_ID.test(mediaId)) continue;
      let commentsAnswer: InstagramCommentsAnswer;
      try {
        commentsAnswer = await this.graph.call<InstagramCommentsAnswer>('GET', `${mediaId}/comments`, {
          token: s.accessToken,
          params: {
            fields: 'id,text,timestamp,hidden,from{id,username},replies{id,text,timestamp,hidden,from{id,username}}',
            limit: String(RECONCILE_COMMENTS_PER_POST),
          },
        });
      } catch (error) {
        if (error instanceof GraphError && error.code === 100 && error.subcode === 33) continue;
        const res = graphPublishResult(error);
        if (res.kind === 'rejected' && (res.error === 'token_expired' || res.error === 'permission')) {
          return { kind: 'failed', retry: false, ...(res.code ? { code: res.code } : {}) };
        }
        const code = (res.kind === 'rejected' || res.kind === 'unknown') ? res.code : undefined;
        return { kind: 'failed', retry: true, ...(code ? { code } : {}) };
      }
      const rows = commentsAnswer.data ?? [];
      let reachedSince = false;
      for (const c of rows) {
        const topId = idOf(c.id);
        if (!topId) continue;
        if (pushRow(mediaId, topId, c)) reachedSince = true;
        for (const replyRow of Array.isArray(c.replies?.data) ? c.replies.data : []) {
          if (pushRow(mediaId, topId, replyRow)) reachedSince = true;
        }
      }
      if (!reachedSince && rows.length >= RECONCILE_COMMENTS_PER_POST && typeof commentsAnswer.paging?.next === 'string') {
        complete = false;
      }
    }
    return {
      kind: 'ok',
      events: sortCommentEvents(events),
      complete,
      oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    };
  }
}
