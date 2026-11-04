// SPDX-License-Identifier: AGPL-3.0-only
// Facebook Page comments in the conversation core (issue #2307, plan docs/plan/conversations.md sections 6.1, 6.2, 6.3 and 13 CV2):
// verifying X-Hub-Signature-256 on raw webhook bytes, turning a Page `feed` comment notice into core events, replying to a comment
// (`POST /{comment-id}/comments`), hiding or unhiding a customer's comment (`POST /{comment-id}` with `is_hidden`), subscribing the Page
// (`POST /{page-id}/subscribed_apps?subscribed_fields=feed`), and reconciling recent posts' comments when a webhook was missed.
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
const CUSTOMER_ATTACHMENT_PLACEHOLDER = '[Khách gửi bình luận đính kèm]';
const PAGE_ATTACHMENT_PLACEHOLDER = '[Trang đã gửi bình luận đính kèm]';

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
  comment_id?: unknown;
  parent_id?: unknown;
  post_id?: unknown;
  from?: { id?: unknown; name?: unknown } | null;
  message?: unknown;
  created_time?: unknown;
  is_hidden?: unknown;
}

interface WebhookChange {
  field?: unknown;
  value?: FeedCommentValue | null;
}

interface WebhookEntry {
  id?: unknown;
  time?: unknown;
  changes?: WebhookChange[] | null;
}

interface WebhookPayload {
  object?: unknown;
  entry?: WebhookEntry[] | null;
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

  // Replies to a comment thread on the Page (`POST /{comment-id}/comments` with `message`). Never retried automatically after an unclear
  // answer because Graph comment creation has no idempotency key.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (! NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PAGE_ID' };
    if (!COMMENT_TARGET_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
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

  // Subscribes the Page to `feed` webhook deliveries (`POST /{page-id}/subscribed_apps` with `subscribed_fields=feed`). Idempotent.
  async subscribe(input: { externalAccountId: string; secret: string }): Promise<{ ok: true } | { ok: false; error: ConversationErrorKind | 'unknown'; code?: string }> {
    const token = pageToken(input.secret);
    if (!token) return { ok: false, error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { ok: false, error: 'bad_request', code: 'BAD_PAGE_ID' };
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', `${input.externalAccountId}/subscribed_apps`, {
        token,
        form: { subscribed_fields: 'feed' },
      });
      return answer.success === true ? { ok: true } : { ok: false, error: 'unknown', code: 'SUBSCRIBE_NOT_CONFIRMED' };
    } catch (error) {
      const res = graphPublishResult(error);
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
