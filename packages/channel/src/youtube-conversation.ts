// SPDX-License-Identifier: AGPL-3.0-only
// Comments on the business's own YouTube channel in the conversation core (issue #3134, plan docs/plan/conversations-channels.md section 4.5).
// YouTube has no push for comments and meters its Data API in quota units per Google project, so this adapter only reads (`history`, the poll) and
// answers (`reply`); the kernel decides when to poll, within the connection's daily unit budget, and counts the units each call says it spent.
// Every platform fact below is tagged in the plan: none was read from the official page (the build session's network denied developers.google.com),
// so the field names and the cost of a request are [M]/[O] until docs/runbooks/youtube-conversations-live-check.md settles them.
import type { ConversationAdapter, ConversationCallResult, ConversationHistoryInput, ConversationHistoryResult, ConversationReplyInput, InboundConversationEvent } from './conversation.ts';

// YouTube's own limit on a comment [U]; the core's reply is shorter (CONVERSATION_REPLY_MAX), so this is the adapter's own last check.
export const YOUTUBE_COMMENT_TEXT_MAX = 10_000;
// The scope reading and answering comments needs (the connect dialog already asks for it, #791); a grant without it is told to reconnect.
export const YOUTUBE_COMMENT_SCOPE_ID = 'https://www.googleapis.com/auth/youtube.force-ssl';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// A comment's id is URL-safe base64 (a thread's is its top-level comment's; a reply's adds `.` and a suffix).
const COMMENT_ID = /^[A-Za-z0-9_.-]{10,160}$/;
const PAGE_TOKEN_MAX = 200;
const NAME_MAX = 200;
const TEXT_MAX = 20_000;
const NO_TEXT = '[Khách gửi bình luận không có chữ]';
const OWN_NO_TEXT = '[Kênh đã gửi bình luận không có chữ]';
// One poll reads at most this many pages of 100 threads, and refreshes the replies of at most this many threads that have more than the answer holds;
// each request is one unit, so a poll costs at most PAGES + REFRESHES (YOUTUBE_POLL_MAX_UNITS in the contract is the budget gate's figure).
export const YOUTUBE_POLL_PAGES_MAX = 3;
export const YOUTUBE_REPLY_REFRESH_MAX = 5;
const API = 'https://www.googleapis.com/youtube/v3';
const QUOTA_REASONS = ['quotaExceeded', 'dailyLimitExceeded'];

// What the adapter needs of the Google client, so this file does not import youtube.ts (which builds it).
export interface YouTubeConversationApi {
  call<T>(method: 'GET' | 'POST', url: string, token: string, options?: { json?: unknown; timeoutMs?: number }): Promise<{ body: T | null }>;
  // The platform's refusal behind an error (its HTTP status and reason), or null for anything else (a network failure, a timeout).
  refusal(error: unknown): { status: number; reason: string | undefined } | null;
  // The access token inside the opened credential, or null.
  token(secret: string): string | null;
  // When the day's quota resets (the next midnight Pacific time).
  quotaResetAt(): Date;
}

interface Classified {
  result: { kind: 'rejected'; error: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient'; code: string; retryAt?: Date } | { kind: 'unknown'; code: string };
  // The project's daily quota is spent: nothing is asked of it before the reset.
  quota: boolean;
}

function classify(api: YouTubeConversationApi, error: unknown): Classified {
  const refusal = api.refusal(error);
  if (!refusal) return { result: { kind: 'unknown', code: 'NETWORK' }, quota: false };
  const { status, reason } = refusal;
  if (status >= 500 || status < 400) return { result: { kind: 'unknown', code: reason ?? `HTTP_${status}` }, quota: false };
  if (status === 401) return { result: { kind: 'rejected', error: 'token_expired', code: 'YOUTUBE_TOKEN' }, quota: false };
  if (QUOTA_REASONS.includes(reason ?? '')) return { result: { kind: 'rejected', error: 'rate_limited', code: 'YOUTUBE_QUOTA', retryAt: api.quotaResetAt() }, quota: true };
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return { result: { kind: 'rejected', error: 'rate_limited', code: 'YOUTUBE_RATE_LIMIT' }, quota: false };
  if (status === 403) {
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return { result: { kind: 'rejected', error: 'permission', code: 'YOUTUBE_RECONNECT' }, quota: false };
    if (reason === 'commentsDisabled') return { result: { kind: 'rejected', error: 'bad_request', code: 'YOUTUBE_COMMENTS_OFF' }, quota: false };
    return { result: { kind: 'rejected', error: 'permission', code: 'YOUTUBE_FORBIDDEN' }, quota: false };
  }
  if (status === 404) return { result: { kind: 'rejected', error: 'bad_request', code: 'YOUTUBE_COMMENT_GONE' }, quota: false };
  if (reason === 'commentTextTooLong' || reason === 'invalidCommentText') return { result: { kind: 'rejected', error: 'bad_request', code: 'YOUTUBE_TEXT_LENGTH' }, quota: false };
  return { result: { kind: 'rejected', error: 'bad_request', code: 'YOUTUBE_BAD_REQUEST' }, quota: false };
}

const clean = (value: string): string => value.replaceAll('\u0000', '');
const timeOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  // YouTube's comments start in 2005; nothing more than a day ahead.
  return Number.isFinite(ms) && ms >= Date.UTC(2005, 0, 1) && ms <= Date.now() + 86_400_000 ? new Date(ms).toISOString() : null;
};

interface CommentResource {
  id?: unknown;
  snippet?: {
    authorDisplayName?: unknown;
    authorChannelId?: { value?: unknown } | null;
    textDisplay?: unknown;
    textOriginal?: unknown;
    publishedAt?: unknown;
    parentId?: unknown;
    videoId?: unknown;
  };
}
interface ThreadResource {
  id?: unknown;
  snippet?: { videoId?: unknown; channelId?: unknown; topLevelComment?: CommentResource; totalReplyCount?: unknown };
  replies?: { comments?: CommentResource[] };
}
interface ListAnswer<T> {
  items?: T[];
  nextPageToken?: unknown;
}

// One comment as an event: the thread is the top-level comment's id, the post the video. The channel's own comments are the business's (`out`);
// the author's channel id is the customer's external id (class pii), and the display name is what YouTube shows.
function eventOf(accountId: string, threadId: string, videoId: string, comment: CommentResource | undefined): InboundConversationEvent | null {
  const id = typeof comment?.id === 'string' ? comment.id : '';
  const at = timeOf(comment?.snippet?.publishedAt);
  if (!comment || !COMMENT_ID.test(id) || !at) return null;
  const authorId = typeof comment.snippet?.authorChannelId?.value === 'string' ? comment.snippet.authorChannelId.value : '';
  const own = authorId === accountId;
  const name = typeof comment.snippet?.authorDisplayName === 'string' ? clean(comment.snippet.authorDisplayName).trim().slice(0, NAME_MAX) : '';
  const raw = typeof comment.snippet?.textDisplay === 'string' ? comment.snippet.textDisplay : typeof comment.snippet?.textOriginal === 'string' ? comment.snippet.textOriginal : '';
  const text = clean(raw).slice(0, TEXT_MAX);
  return {
    kind: 'comment_thread',
    threadId,
    postId: videoId,
    messageId: id,
    direction: own ? 'out' : 'in',
    contact: { id: own || !CHANNEL_ID.test(authorId) ? `commenter:${threadId}` : authorId, ...(!own && name !== '' && CHANNEL_ID.test(authorId) ? { name } : {}) },
    text: text.trim() !== '' ? text : own ? OWN_NO_TEXT : NO_TEXT,
    at,
  };
}

const sortEvents = (events: InboundConversationEvent[]): InboundConversationEvent[] =>
  events
    .map((event, i) => ({ event, i }))
    .sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || (a.event.threadId === a.event.messageId ? 0 : 1) - (b.event.threadId === b.event.messageId ? 0 : 1) || a.i - b.i)
    .map(({ event }) => event);

export class YouTubeConversations implements ConversationAdapter {
  readonly provider = 'youtube' as const;
  private readonly api: YouTubeConversationApi;

  constructor(api: YouTubeConversationApi) {
    this.api = api;
  }

  // A reply to a comment (`comments.insert` with `parentId`, 50 quota units [O]); YouTube keeps replies one level deep, so the parent is always the
  // thread's top-level comment. The call has no idempotency key: it is never repeated after an unclear answer (the caller does not), and the answer
  // carries the new comment's id.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const token = this.api.token(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!CHANNEL_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    if (!COMMENT_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_COMMENT_ID' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    if (input.text.length > YOUTUBE_COMMENT_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'YOUTUBE_TEXT_LENGTH' };
    try {
      const answer = await this.api.call<{ id?: unknown }>('POST', `${API}/comments?part=snippet`, token, { json: { snippet: { parentId: input.threadId, textOriginal: input.text } } });
      const id = answer.body?.id;
      if (typeof id !== 'string' || !COMMENT_ID.test(id)) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      return classify(this.api, error).result;
    }
  }

  // The poll (plan section 4.5): the newest comment threads of the whole channel in one list (`commentThreads.list` with
  // `allThreadsRelatedToChannelId`, newest first [M]), a page at a time back to `input.since`, and the replies of a thread the answer holds only
  // part of. Every request is one unit [O] and `units` says how many were made, so the kernel counts them against the day's budget; a poll that
  // cannot finish within its pages says so (`complete` false) and the gap is shown. A replies-only change on an older thread is not seen by this
  // read (the list is ordered by the top-level comment's date [M]): the live check settles it.
  async history(input: ConversationHistoryInput): Promise<ConversationHistoryResult> {
    const token = this.api.token(input.secret);
    if (!token) return { kind: 'failed', retry: false, code: 'NO_TOKEN', units: 0 };
    if (!CHANNEL_ID.test(input.externalAccountId)) return { kind: 'failed', retry: false, code: 'BAD_ACCOUNT_ID', units: 0 };
    let units = 0;
    const failed = (error: unknown): ConversationHistoryResult => {
      const c = classify(this.api, error);
      const code = c.result.code;
      // A refused request still costs at least one unit [O].
      units += 1;
      if (c.quota) return { kind: 'failed', retry: false, code, units, quotaUntil: c.result.kind === 'rejected' && c.result.retryAt ? c.result.retryAt : this.api.quotaResetAt() };
      // A network or server failure and a burst limit are worth trying again later; a refused credential, scope or request is not until a person acts.
      const retry = c.result.kind === 'unknown' || (c.result.kind === 'rejected' && (c.result.error === 'rate_limited' || c.result.error === 'transient'));
      return { kind: 'failed', retry, code, units };
    };
    const sinceMs = input.since.getTime();
    const events: InboundConversationEvent[] = [];
    const incomplete: ThreadResource[] = [];
    let oldestMs: number | null = null;
    let complete = false;
    let pageToken: string | null = null;
    for (let page = 0; page < YOUTUBE_POLL_PAGES_MAX; page++) {
      const query: string = `part=snippet,replies&allThreadsRelatedToChannelId=${input.externalAccountId}&order=time&maxResults=100&textFormat=plainText${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      let answer: ListAnswer<ThreadResource> | null;
      try {
        answer = (await this.api.call<ListAnswer<ThreadResource>>('GET', `${API}/commentThreads?${query}`, token)).body;
        units += 1;
      } catch (error) {
        return failed(error);
      }
      let reachedSince = false;
      for (const thread of Array.isArray(answer?.items) ? answer.items : []) {
        const threadId = typeof thread?.id === 'string' ? thread.id : '';
        const videoId = typeof thread?.snippet?.videoId === 'string' ? thread.snippet.videoId : '';
        const top = eventOf(input.externalAccountId, threadId, videoId, thread?.snippet?.topLevelComment);
        if (!COMMENT_ID.test(threadId) || !VIDEO_ID.test(videoId) || !top) continue;
        const topMs = Date.parse(top.at);
        if (oldestMs === null || topMs < oldestMs) oldestMs = topMs;
        // Newest first: a thread older than `since` ends the read (its replies are not looked at: they were stored by an earlier pass or are a gap).
        if (topMs < sinceMs) {
          reachedSince = true;
          continue;
        }
        events.push(top);
        const replies = Array.isArray(thread.replies?.comments) ? thread.replies.comments : [];
        for (const reply of replies) {
          const event = eventOf(input.externalAccountId, threadId, videoId, reply);
          if (event && Date.parse(event.at) >= sinceMs) events.push(event);
        }
        const total = Number(thread.snippet?.totalReplyCount);
        if (Number.isFinite(total) && total > replies.length) incomplete.push(thread);
      }
      const next: unknown = answer?.nextPageToken;
      pageToken = typeof next === 'string' && next !== '' && next.length <= PAGE_TOKEN_MAX ? next : null;
      if (reachedSince || !pageToken) {
        complete = true;
        break;
      }
    }
    // A thread with more replies than the list holds: its replies are read once each, newest activity first, within the poll's refresh cap.
    for (const thread of incomplete.slice(0, YOUTUBE_REPLY_REFRESH_MAX)) {
      const threadId = thread.id as string;
      const videoId = thread.snippet?.videoId as string;
      try {
        const answer = await this.api.call<ListAnswer<CommentResource>>('GET', `${API}/comments?part=snippet&parentId=${encodeURIComponent(threadId)}&maxResults=100&textFormat=plainText`, token);
        units += 1;
        for (const reply of Array.isArray(answer.body?.items) ? answer.body.items : []) {
          const event = eventOf(input.externalAccountId, threadId, videoId, reply);
          if (event && Date.parse(event.at) >= sinceMs) events.push(event);
        }
      } catch (error) {
        // The threads were read; only some replies are missing, and the next pass reads them again: the read stands, with a gap noted.
        const c = classify(this.api, error);
        units += 1;
        complete = false;
        if (c.quota) return { kind: 'failed', retry: false, code: c.result.code, units, quotaUntil: c.result.kind === 'rejected' && c.result.retryAt ? c.result.retryAt : this.api.quotaResetAt() };
        break;
      }
    }
    if (incomplete.length > YOUTUBE_REPLY_REFRESH_MAX) complete = false;
    // The same reply can be in both the thread's replies and the refresh: the ingest is idempotent on the message id, but a batch is deduplicated here.
    const seen = new Set<string>();
    const unique = events.filter((event) => (seen.has(event.messageId) ? false : (seen.add(event.messageId), true)));
    return { kind: 'ok', events: sortEvents(unique), complete, oldest: oldestMs !== null ? new Date(oldestMs).toISOString() : null, units };
  }
}
