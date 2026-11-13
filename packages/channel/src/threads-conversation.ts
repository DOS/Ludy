// SPDX-License-Identifier: AGPL-3.0-only
// Replies to the business's own Threads posts in the conversation core (issue #3133, plan docs/plan/conversations-channels.md section 4.4):
// the signature and parser of a Threads reply webhook, a reply to a reply (a text container with `reply_to_id`, then `threads_publish`, made
// by the publisher's comment call), hiding or unhiding a top-level reply (`POST /{reply-id}/manage_reply`), the profile's reply cap, and the
// reconcile read of the replies under recent posts. Every platform fact below is tagged in the plan: none was read from the official page (the
// session's network denied it), so the field names are [M] and the runbook docs/runbooks/threads-conversations-live-check.md settles them.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConversationNoticeError,
  type ConversationAdapter,
  type ConversationCallResult,
  type ConversationHideInput,
  type ConversationHideResult,
  type ConversationHistoryInput,
  type ConversationHistoryResult,
  type ConversationNotice,
  type ConversationReplyInput,
  type InboundConversationEvent,
} from './conversation.ts';
import type { CommentInput, CommentResult, PublishResult } from './index.ts';
import { graphTime } from './recent.ts';

// A webhook batch of reply notices is small; the same cap as the Meta Page webhook, whose route takes this one too.
export const THREADS_MAX_NOTICE_BYTES = 256 * 1024;
// Threads' limit of 500 characters a post applies to a reply [U].
export const THREADS_REPLY_TEXT_MAX = 500;
// The scope the "also read and answer replies" opt-in adds to the publishing ones (`threads_manage_replies` is already asked for, since
// first comments need it). A connection without it has no reply reading, so nothing is read for it.
export const THREADS_REPLY_SCOPES = ['threads_read_replies'] as const;
// The profile may publish at most this many API replies in a rolling 24 hours (readable at /{user-id}/threads_publishing_limit) [O].
export const THREADS_REPLY_CAP = 1000;
// When a refused reply may be tried again: the cap is a rolling 24 hours, and the answer does not say when a slot frees.
export const THREADS_REPLY_CAP_RETRY_MS = 60 * 60 * 1000;

const NUMERIC_ID = /^\d{1,32}$/;
const USERNAME = /^[A-Za-z0-9._]{1,60}$/;
const ID_MAX = 200;
const TEXT_MAX = 20_000;
const REPLIES_PLACEHOLDER = '[Khách gửi trả lời đính kèm]';
const OWN_PLACEHOLDER = '[Trang đã gửi trả lời đính kèm]';
// The most posts one reconcile pass reads, the replies read under each, and how far up a nested reply is followed to its top-level one.
const RECONCILE_POSTS_MAX = 25;
const RECONCILE_REPLIES_PER_POST = 100;
const ANCESTOR_DEPTH_MAX = 25;

export interface ThreadsSignatureInput {
  // The raw request bytes, before any decoding.
  body: Uint8Array;
  // The value of X-Hub-Signature-256 (`sha256=<64 hex>`), or undefined when absent.
  header: string | undefined;
  // The Threads app's secret: the Threads product may have its own, as Instagram's does [U].
  appSecret: string;
}

const HUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/;

// Whether a webhook body was signed with the Threads app secret. Constant-time comparison; nothing is read from the body when it is not.
export function threadsSignatureOk(input: ThreadsSignatureInput): boolean {
  if (!input.appSecret || input.body.byteLength === 0 || input.body.byteLength > THREADS_MAX_NOTICE_BYTES) return false;
  const match = input.header ? HUB_SIGNATURE.exec(input.header.trim()) : null;
  if (!match) return false;
  const given = Buffer.from(match[1] as string, 'hex');
  const expected = createHmac('sha256', input.appSecret).update(input.body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
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

// A time as an ISO string: Threads writes `2026-11-13T10:00:00+0000`, a webhook may carry epoch seconds. Nothing before 2023 (Threads' launch)
// or more than a day ahead.
function atOf(value: unknown, now: number): string | null {
  let ms: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value)) ms = Number(value) < 1e11 ? Number(value) * 1000 : Number(value);
  else {
    const parsed = graphTime(value);
    ms = parsed ? parsed.getTime() : null;
  }
  if (ms === null || !Number.isFinite(ms) || ms < Date.UTC(2023, 0, 1) || ms > now + 86_400_000) return null;
  return new Date(ms).toISOString();
}

// The reply's author: the username is what Threads gives (the id is not given for another person's reply) [U]. It is the customer's external id
// (class pii); it can change if the person renames, which then reads as a new customer.
function authorOf(username: unknown): { id: string; name: string } | null {
  if (typeof username !== 'string') return null;
  const name = clean(username).trim().replace(/^@/, '');
  return USERNAME.test(name) ? { id: name.toLowerCase(), name: `@${name}` } : null;
}

interface ReplyValue {
  id?: unknown;
  text?: unknown;
  username?: unknown;
  timestamp?: unknown;
  created_time?: unknown;
  root_post?: { id?: unknown } | string | null;
  root_post_id?: unknown;
  replied_to?: { id?: unknown } | string | null;
  reply_to_id?: unknown;
  from?: { id?: unknown } | null;
  is_reply_owned_by_me?: unknown;
  hide_status?: unknown;
  hidden?: unknown;
}

const refId = (value: { id?: unknown } | string | null | undefined): string | null => (typeof value === 'object' && value !== null ? idOf(value.id) : idOf(value));

interface WebhookChange {
  field?: unknown;
  value?: ReplyValue | null;
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

// Whether the platform says the reply is hidden: `hide_status` reads `HIDDEN` (or `NOT_HUSHED`, `UNHUSHED`... for shown) [M].
function hiddenOf(v: ReplyValue): boolean | undefined {
  if (typeof v.hidden === 'boolean') return v.hidden;
  if (typeof v.hide_status === 'string') {
    const status = v.hide_status.toUpperCase();
    if (status === 'HIDDEN' || status === 'HUSHED') return true;
    if (status === 'NOT_HUSHED' || status === 'UNHUSHED' || status === 'VISIBLE') return false;
  }
  return undefined;
}

function eventFromValue(accountId: string, entryTime: unknown, v: ReplyValue | null | undefined, now: number): InboundConversationEvent | null {
  if (!v || typeof v !== 'object') return null;
  const replyId = idOf(v.id);
  const postId = idOf(refId(v.root_post)) ?? idOf(v.root_post_id);
  const parentId = refId(v.replied_to) ?? idOf(v.reply_to_id);
  const at = atOf(v.timestamp ?? v.created_time ?? entryTime, now);
  if (!replyId || !postId || !at || replyId.length > ID_MAX || postId.length > ID_MAX || !NUMERIC_ID.test(replyId) || !NUMERIC_ID.test(postId)) return null;
  // A reply to a reply names its parent: the thread is that parent (a webhook does not give the whole chain; the reconcile read fixes a deeper one).
  const threadId = parentId && parentId !== postId && NUMERIC_ID.test(parentId) && parentId.length <= ID_MAX ? parentId : replyId;
  const fromId = idOf(v.from?.id);
  const own = v.is_reply_owned_by_me === true || fromId === accountId;
  const author = authorOf(v.username);
  const text = typeof v.text === 'string' ? clean(v.text).slice(0, TEXT_MAX) : '';
  const hidden = hiddenOf(v);
  return {
    kind: 'comment_thread',
    threadId,
    postId,
    messageId: replyId,
    direction: own ? 'out' : 'in',
    contact: { id: own || !author ? `commenter:${threadId}` : author.id, ...(!own && author ? { name: author.name } : {}) },
    text: text !== '' ? text : own ? OWN_PLACEHOLDER : REPLIES_PLACEHOLDER,
    at,
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

// Parses a Threads webhook payload (`object: 'threads'`) into one ConversationNotice per profile entry. Fields other than `replies` (mentions,
// deletes) are ignored so the route acknowledges the delivery with 200 without storing noise. [M]: the field and value names, settled by the live check.
export function parseThreadsNotices(body: Uint8Array, now: number = Date.now()): ConversationNotice[] {
  if (body.byteLength === 0 || body.byteLength > THREADS_MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationNoticeError('malformed');
  const payload = parsed as WebhookPayload;
  if (typeof payload.object !== 'string' || !Array.isArray(payload.entry)) throw new ConversationNoticeError('malformed');
  if (payload.object !== 'threads') return [];
  const byProfile = new Map<string, InboundConversationEvent[]>();
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const accountId = idOf(entry.id);
    if (!accountId || !NUMERIC_ID.test(accountId)) continue;
    const list = byProfile.get(accountId) ?? [];
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!change || typeof change !== 'object' || change.field !== 'replies') continue;
      const event = eventFromValue(accountId, entry.time, change.value, now);
      if (event) list.push(event);
    }
    byProfile.set(accountId, list);
  }
  return [...byProfile.entries()].map(([accountId, events]) => ({ accountId, events: sortEvents(events) }));
}

// Oldest first, a thread's top-level reply before the replies under it.
const sortEvents = (events: InboundConversationEvent[]): InboundConversationEvent[] =>
  events
    .map((event, i) => ({ event, i }))
    .sort(
      (a, b) =>
        Date.parse(a.event.at) - Date.parse(b.event.at) ||
        (a.event.threadId === a.event.messageId ? 0 : 1) - (b.event.threadId === b.event.messageId ? 0 : 1) ||
        a.i - b.i,
    )
    .map(({ event }) => event);

// Whether the cap answer says the profile has no API reply left; a cap that cannot be read says nothing (the platform refuses by itself).
export function replyCapExhausted(answer: { data?: { reply_quota_usage?: unknown; reply_config?: { quota_total?: unknown } }[] } | null): boolean {
  const d = answer?.data?.[0];
  const usage = d?.reply_quota_usage;
  const total = d?.reply_config?.quota_total;
  return typeof usage === 'number' && typeof total === 'number' && total > 0 && usage >= total;
}

// What the adapter needs of the Threads client and of the publisher's own calls, so this file does not import threads.ts (which builds it).
export interface ThreadsConversationApi {
  call<T>(method: 'GET' | 'POST', path: string, options?: { token?: string; params?: Record<string, string>; form?: Record<string, string>; timeoutMs?: number }): Promise<T>;
  // A platform answer or failure as the publisher classifies it.
  failure(error: unknown): PublishResult;
  // The publisher's first-comment call: a TEXT container with `reply_to_id`, a wait until it is finished, then `threads_publish`.
  comment(input: CommentInput): Promise<CommentResult>;
  token(secret: string): string | null;
  version: string;
}

interface RepliesAnswer {
  data?: ReplyValue[];
  paging?: { next?: unknown; cursors?: { after?: unknown } };
}
interface PostsAnswer {
  data?: Array<{ id?: unknown; timestamp?: unknown }>;
}

export class ThreadsConversations implements ConversationAdapter {
  readonly provider = 'threads' as const;
  private readonly api: ThreadsConversationApi;

  constructor(api: ThreadsConversationApi) {
    this.api = api;
  }

  // Replies to a reply or to the profile's own post. Never retried by the caller after an unclear answer: neither call takes an idempotency key.
  // The profile's reply cap is read first; a cap that cannot be read says nothing, and the platform's own refusal is mapped when it comes.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const token = this.api.token(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    if (!NUMERIC_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_REPLY_ID' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    if (input.text.length > THREADS_REPLY_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'THREADS_TEXT_LENGTH' };
    const cap = await this.api
      .call<Parameters<typeof replyCapExhausted>[0]>('GET', `${this.api.version}/${input.externalAccountId}/threads_publishing_limit`, { token, params: { fields: 'reply_quota_usage,reply_config' }, timeoutMs: 10_000 })
      .catch(() => null);
    if (replyCapExhausted(cap)) return { kind: 'rejected', error: 'rate_limited', code: 'THREADS_REPLY_CAP', retryAt: new Date(Date.now() + THREADS_REPLY_CAP_RETRY_MS) };
    const answer = await this.api.comment({ externalAccountId: input.externalAccountId, secret: input.secret, externalId: input.threadId, text: input.text, callKey: input.callKey });
    if (answer.kind === 'accepted') return { kind: 'accepted', externalId: answer.externalId };
    if (answer.kind === 'rejected') return { kind: 'rejected', error: answer.error, ...(answer.code ? { code: answer.code } : {}) };
    return { kind: 'unknown', ...(answer.code ? { code: answer.code } : {}) };
  }

  // Hides or unhides a top-level reply (`POST /{reply-id}/manage_reply`); nested replies follow their parent. Idempotent on the platform [M].
  // Rules keep `canHide` false until the live check confirms the call, so the core never asks for it before then.
  async hide(input: ConversationHideInput): Promise<ConversationHideResult> {
    const token = this.api.token(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalMessageId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_REPLY_ID' };
    try {
      const answer = await this.api.call<{ success?: unknown }>('POST', `${this.api.version}/${input.externalMessageId}/manage_reply`, { token, form: { hide: input.hidden ? 'true' : 'false' }, timeoutMs: 15_000 });
      return answer.success === true ? { kind: 'done' } : { kind: 'unknown', code: 'HIDE_NOT_CONFIRMED' };
    } catch (error) {
      const result = this.api.failure(error);
      if (result.kind === 'rejected') return { kind: 'rejected', error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
      return { kind: 'unknown', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
  }

  // Reconciles the replies under the profile's recent posts (plan section 4.4, the safety net for a missed webhook): the recent posts
  // (`GET /{user}/threads`), then each post's whole conversation (`GET /{media-id}/conversation`), back to `input.since`. A reply gets its
  // top-level reply as its thread, found through the parents of the same answer.
  async history(input: ConversationHistoryInput): Promise<ConversationHistoryResult> {
    const token = this.api.token(input.secret);
    if (!token) return { kind: 'failed', retry: false, code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'failed', retry: false, code: 'BAD_ACCOUNT_ID' };
    const maxPosts = Math.max(1, Math.min(input.maxChats, RECONCILE_POSTS_MAX));
    const failed = (error: unknown): ConversationHistoryResult => {
      const result = this.api.failure(error);
      if (result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'permission')) return { kind: 'failed', retry: false, ...(result.code ? { code: result.code } : {}) };
      const code = result.kind === 'rejected' || result.kind === 'unknown' ? result.code : undefined;
      return { kind: 'failed', retry: true, ...(code ? { code } : {}) };
    };
    let posts: PostsAnswer;
    try {
      posts = await this.api.call<PostsAnswer>('GET', `${this.api.version}/${input.externalAccountId}/threads`, {
        token,
        params: { fields: 'id,timestamp', since: String(Math.floor(input.since.getTime() / 1000)), limit: String(maxPosts) },
      });
    } catch (error) {
      return failed(error);
    }
    const now = Date.now();
    const sinceMs = input.since.getTime();
    const events: InboundConversationEvent[] = [];
    let complete = true;
    let oldestMs: number | null = null;
    for (const post of (Array.isArray(posts.data) ? posts.data : []).slice(0, maxPosts)) {
      const postId = idOf(post.id);
      if (!postId || !NUMERIC_ID.test(postId)) continue;
      let answer: RepliesAnswer;
      try {
        answer = await this.api.call<RepliesAnswer>('GET', `${this.api.version}/${postId}/conversation`, {
          token,
          params: { fields: 'id,text,username,timestamp,replied_to,is_reply_owned_by_me,hide_status', limit: String(RECONCILE_REPLIES_PER_POST) },
        });
      } catch (error) {
        // A post that is gone has nothing to read; any other failure ends the pass.
        const result = this.api.failure(error);
        if (result.kind === 'rejected' && result.error === 'bad_request') continue;
        return failed(error);
      }
      const rows = (Array.isArray(answer.data) ? answer.data : []).filter((row) => row && typeof row === 'object');
      const parentOf = new Map<string, string>();
      for (const row of rows) {
        const id = idOf(row.id);
        const parent = refId(row.replied_to);
        if (id && parent) parentOf.set(id, parent);
      }
      let reachedSince = false;
      for (const row of rows) {
        const id = idOf(row.id);
        if (!id) continue;
        const at = atOf(row.timestamp, now);
        if (!at) continue;
        const atMs = Date.parse(at);
        if (oldestMs === null || atMs < oldestMs) oldestMs = atMs;
        if (atMs < sinceMs) {
          reachedSince = true;
          continue;
        }
        // The top-level reply: follow the parents until the post (or something the answer does not list).
        let top = id;
        for (let depth = 0; depth < ANCESTOR_DEPTH_MAX; depth++) {
          const parent = parentOf.get(top);
          if (!parent || parent === postId) break;
          top = parent;
        }
        const event = eventFromValue(input.externalAccountId, at, { ...row, id, root_post: postId, replied_to: top === id ? postId : top, timestamp: at }, now);
        if (event) events.push(event);
      }
      if (!reachedSince && rows.length >= RECONCILE_REPLIES_PER_POST && typeof answer.paging?.next === 'string') complete = false;
    }
    return { kind: 'ok', events: sortEvents(events), complete, oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null };
  }
}
