// SPDX-License-Identifier: AGPL-3.0-only
// YouTube comments in the conversation core (#3134) against recorded answers. The answer shapes are the plan's [M] ones (no official page was read: the
// build session's network denied developers.google.com); the live check (docs/runbooks/youtube-conversations-live-check.md) settles them. No live call.
import { describe, expect, it } from 'vitest';
import { YOUTUBE_POLL_PAGES_MAX, YOUTUBE_REPLY_REFRESH_MAX, YouTubePublisher, type Fetch } from '../src/index.ts';

const APP = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const OTHER = 'UCzyxwvutsrqponmlkjihgfe';
const VIDEO = 'dQw4w9WgXcQ';
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const SINCE = new Date('2026-11-01T00:00:00Z');
const THREAD = 'UgxAAAAAAAAAAAAAAAAAAAAAAAAB';

type Answer = { status?: number; body?: unknown; network?: true };
function google(routes: Record<string, Answer[]>) {
  const calls: { route: string; url: URL; body: unknown; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const raw = init?.body;
    calls.push({ route, url, body: typeof raw === 'string' ? JSON.parse(raw) : undefined, auth: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, errors: [{ reason: 'backendError' }] } } };
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const refusal = (status: number, reason: string): Answer => ({ status, body: { error: { code: status, message: 'refused', errors: [{ reason }] } } });
const comment = (id: string, over: { author?: string; name?: string; text?: string; at?: string; parentId?: string } = {}) => ({
  id,
  snippet: {
    authorDisplayName: over.name ?? '@khach-hang',
    authorChannelId: { value: over.author ?? OTHER },
    textDisplay: over.text ?? 'Video này dùng loại bột nào vậy shop?',
    publishedAt: over.at ?? '2026-11-13T09:00:00Z',
    ...(over.parentId ? { parentId: over.parentId } : {}),
  },
});
const thread = (id: string, top: ReturnType<typeof comment>, replies: ReturnType<typeof comment>[] = [], total = replies.length) => ({
  id,
  snippet: { videoId: VIDEO, channelId: CHANNEL, topLevelComment: top, totalReplyCount: total },
  ...(replies.length > 0 ? { replies: { comments: replies } } : {}),
});
const LIST = 'GET /youtube/v3/commentThreads';
const adapter = (fetchImpl: Fetch) => new YouTubePublisher(APP, fetchImpl).conversations;
const read = (a: ReturnType<typeof adapter>, since = SINCE) => a.history({ externalAccountId: CHANNEL, secret: SECRET, since, maxChats: 25 });

describe('YouTubeConversations.history (#3134)', () => {
  it('reads the channel-wide list in one request and turns a thread into a comment thread under its video, the own reply as out', async () => {
    const { fetchImpl, calls } = google({
      [LIST]: [
        {
          body: {
            items: [
              thread(THREAD, comment(THREAD), [comment(`${THREAD}.9aBcDeFgHiJ`, { author: CHANNEL, name: 'Tiệm Bánh B', text: 'Dạ bột mì số 11 ạ', at: '2026-11-13T09:30:00Z', parentId: THREAD })]),
              thread('UgxBBBBBBBBBBBBBBBBBBBBBBBBB', comment('UgxBBBBBBBBBBBBBBBBBBBBBBBBB', { text: '', at: '2026-11-12T08:00:00Z' })),
            ],
          },
        },
      ],
    });
    const answer = await read(adapter(fetchImpl));
    expect(answer.kind).toBe('ok');
    if (answer.kind !== 'ok') return;
    // One request, one unit; the whole channel at once, newest first, plain text, with the replies.
    expect(answer.units).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe('Bearer ya29.token-1');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ part: 'snippet,replies', allThreadsRelatedToChannelId: CHANNEL, order: 'time', maxResults: '100', textFormat: 'plainText' });
    // The list ended without a next page, so nothing is missing.
    expect(answer.complete).toBe(true);
    expect(answer.oldest).toBe('2026-11-12T08:00:00.000Z');
    // Oldest first, a thread's top-level comment before its replies.
    expect(answer.events.map((e) => [e.messageId, e.direction, e.threadId, e.postId])).toEqual([
      ['UgxBBBBBBBBBBBBBBBBBBBBBBBBB', 'in', 'UgxBBBBBBBBBBBBBBBBBBBBBBBBB', VIDEO],
      [THREAD, 'in', THREAD, VIDEO],
      [`${THREAD}.9aBcDeFgHiJ`, 'out', THREAD, VIDEO],
    ]);
    expect(answer.events[1]).toMatchObject({ kind: 'comment_thread', text: 'Video này dùng loại bột nào vậy shop?', contact: { id: OTHER, name: '@khach-hang' }, at: '2026-11-13T09:00:00.000Z' });
    // The business's own reply is not a customer: its contact is a placeholder of the thread, with no name.
    expect(answer.events[2]?.contact).toEqual({ id: `commenter:${THREAD}` });
    // A comment with no text still opens a thread, with a placeholder line.
    expect(answer.events[0]?.text).toBe('[Khách gửi bình luận không có chữ]');
  });

  it('stops at the first thread older than `since`, which is the end of what was asked for', async () => {
    const { fetchImpl, calls } = google({
      [LIST]: [
        {
          body: {
            items: [thread(THREAD, comment(THREAD, { at: '2026-11-13T09:00:00Z' })), thread('UgxOLDOLDOLDOLDOLDOLDOLDOLD', comment('UgxOLDOLDOLDOLDOLDOLDOLDOLD', { at: '2026-10-01T09:00:00Z' }))],
            nextPageToken: 'PAGE2',
          },
        },
      ],
    });
    const answer = await read(adapter(fetchImpl));
    expect(answer.kind === 'ok' && answer.events.map((e) => e.messageId)).toEqual([THREAD]);
    expect(answer.kind === 'ok' && answer.complete).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('follows the next page and, at its page cap, says the read is not complete and what it cost', async () => {
    const page = (n: number) => ({ body: { items: [thread(`Ugx${String(n).repeat(25)}`, comment(`Ugx${String(n).repeat(25)}`))], nextPageToken: `P${n + 1}` } });
    const { fetchImpl, calls } = google({ [LIST]: [page(1), page(2), page(3), page(4)] });
    const answer = await read(adapter(fetchImpl));
    expect(answer.kind).toBe('ok');
    if (answer.kind !== 'ok') return;
    expect(calls).toHaveLength(YOUTUBE_POLL_PAGES_MAX);
    expect(answer.units).toBe(YOUTUBE_POLL_PAGES_MAX);
    expect(answer.complete).toBe(false);
    expect(calls[1]?.url.searchParams.get('pageToken')).toBe('P2');
  });

  it('reads the replies of a thread that has more than the list holds, within a cap, and deduplicates', async () => {
    const full = Array.from({ length: YOUTUBE_REPLY_REFRESH_MAX + 2 }, (_, i) => thread(`Ugx${String(i).padStart(2, '0')}${'X'.repeat(23)}`, comment(`Ugx${String(i).padStart(2, '0')}${'X'.repeat(23)}`, { at: `2026-11-13T0${i % 9}:00:00Z` }), [], 8));
    const refreshed = (id: string) => ({ body: { items: [comment(`${id}.AAAAAAAAAAA`, { parentId: id, at: '2026-11-13T10:00:00Z' }), comment(`${id}.BBBBBBBBBBB`, { parentId: id, at: '2026-11-13T10:05:00Z' })] } });
    const { fetchImpl, calls } = google({
      [LIST]: [{ body: { items: full } }],
      'GET /youtube/v3/comments': full.slice(0, YOUTUBE_REPLY_REFRESH_MAX).map((t) => refreshed(t.id)),
    });
    const answer = await read(adapter(fetchImpl));
    expect(answer.kind).toBe('ok');
    if (answer.kind !== 'ok') return;
    // One list request and at most the refresh cap of reply reads: each is a unit.
    expect(calls.filter((c) => c.route === 'GET /youtube/v3/comments')).toHaveLength(YOUTUBE_REPLY_REFRESH_MAX);
    expect(answer.units).toBe(1 + YOUTUBE_REPLY_REFRESH_MAX);
    expect(calls.find((c) => c.route === 'GET /youtube/v3/comments')?.url.searchParams.get('parentId')).toBe(full[0]?.id);
    // Two threads were left without their replies read: the read says so.
    expect(answer.complete).toBe(false);
    expect(answer.events.filter((e) => e.threadId !== e.messageId && !e.messageId.includes('.'))).toEqual([]);
    expect(new Set(answer.events.map((e) => e.messageId)).size).toBe(answer.events.length);
  });

  it('maps a spent project quota to a held poll until the reset, and counts the refused request as a unit', async () => {
    const { fetchImpl } = google({ [LIST]: [refusal(403, 'quotaExceeded')] });
    const answer = await read(adapter(fetchImpl));
    expect(answer).toMatchObject({ kind: 'failed', retry: false, code: 'YOUTUBE_QUOTA', units: 1 });
    expect(answer.kind === 'failed' && answer.quotaUntil instanceof Date && answer.quotaUntil.getTime() > Date.now()).toBe(true);
  });

  it('tells a failure worth trying again from one only a person can fix, and never reads without a token', async () => {
    const cases: [Answer, boolean, string][] = [
      [{ network: true }, true, 'NETWORK'],
      [refusal(503, 'backendError'), true, 'backendError'],
      [refusal(429, 'rateLimitExceeded'), true, 'YOUTUBE_RATE_LIMIT'],
      [refusal(401, 'authError'), false, 'YOUTUBE_TOKEN'],
      [refusal(403, 'insufficientPermissions'), false, 'YOUTUBE_RECONNECT'],
      [refusal(403, 'forbidden'), false, 'YOUTUBE_FORBIDDEN'],
    ];
    for (const [answer, retry, code] of cases) {
      const { fetchImpl } = google({ [LIST]: [answer] });
      expect(await read(adapter(fetchImpl))).toMatchObject({ kind: 'failed', retry, code });
    }
    const none = google({});
    expect(await adapter(none.fetchImpl).history({ externalAccountId: CHANNEL, secret: '{}', since: SINCE, maxChats: 25 })).toMatchObject({ kind: 'failed', retry: false, code: 'NO_TOKEN' });
    expect(await adapter(none.fetchImpl).history({ externalAccountId: 'nope', secret: SECRET, since: SINCE, maxChats: 25 })).toMatchObject({ kind: 'failed', retry: false, code: 'BAD_ACCOUNT_ID' });
    expect(none.calls).toHaveLength(0);
  });
});

describe('YouTubeConversations.reply (#3134)', () => {
  const input = (over: Record<string, unknown> = {}) => ({ externalAccountId: CHANNEL, secret: SECRET, kind: 'comment_thread' as const, threadId: THREAD, postId: VIDEO, contactId: OTHER, text: 'Dạ bột mì số 11 ạ', callKey: 'call-1', ...over });

  it('answers a thread with comments.insert under its top-level comment, once, and returns the new comment id', async () => {
    const { fetchImpl, calls } = google({ 'POST /youtube/v3/comments': [{ body: { id: `${THREAD}.9aBcDeFgHiJ` } }] });
    expect(await adapter(fetchImpl).reply(input())).toEqual({ kind: 'accepted', externalId: `${THREAD}.9aBcDeFgHiJ` });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get('part')).toBe('snippet');
    expect(calls[0]?.body).toEqual({ snippet: { parentId: THREAD, textOriginal: 'Dạ bột mì số 11 ạ' } });
  });

  it('refuses a bad input before any call, and names the platform refusals for a person', async () => {
    const none = google({});
    const a = adapter(none.fetchImpl);
    expect(await a.reply(input({ text: '   ' }))).toMatchObject({ kind: 'rejected', code: 'EMPTY' });
    expect(await a.reply(input({ text: 'x'.repeat(10_001) }))).toMatchObject({ kind: 'rejected', code: 'YOUTUBE_TEXT_LENGTH' });
    expect(await a.reply(input({ threadId: '../x' }))).toMatchObject({ kind: 'rejected', code: 'BAD_COMMENT_ID' });
    expect(await a.reply(input({ externalAccountId: 'x' }))).toMatchObject({ kind: 'rejected', code: 'BAD_ACCOUNT_ID' });
    expect(await a.reply(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' });
    expect(none.calls).toHaveLength(0);
    const cases: [Answer, string, string][] = [
      [refusal(403, 'quotaExceeded'), 'rate_limited', 'YOUTUBE_QUOTA'],
      [refusal(403, 'insufficientPermissions'), 'permission', 'YOUTUBE_RECONNECT'],
      [refusal(403, 'commentsDisabled'), 'bad_request', 'YOUTUBE_COMMENTS_OFF'],
      [refusal(404, 'commentNotFound'), 'bad_request', 'YOUTUBE_COMMENT_GONE'],
      [refusal(401, 'authError'), 'token_expired', 'YOUTUBE_TOKEN'],
    ];
    for (const [answer, error, code] of cases) {
      const { fetchImpl } = google({ 'POST /youtube/v3/comments': [answer] });
      expect(await adapter(fetchImpl).reply(input())).toMatchObject({ kind: 'rejected', error, code });
    }
    // A spent quota says when sending may be tried again.
    const quota = await adapter(google({ 'POST /youtube/v3/comments': [refusal(403, 'quotaExceeded')] }).fetchImpl).reply(input());
    expect(quota.kind === 'rejected' && quota.retryAt instanceof Date && quota.retryAt.getTime() > Date.now()).toBe(true);
  });

  it('leaves an unclear answer unclear (a person settles it) and never repeats the call', async () => {
    for (const answer of [{ network: true } as Answer, refusal(503, 'backendError'), { body: {} } as Answer]) {
      const { fetchImpl, calls } = google({ 'POST /youtube/v3/comments': [answer] });
      expect((await adapter(fetchImpl).reply(input())).kind).toBe('unknown');
      expect(calls).toHaveLength(1);
    }
  });
});
