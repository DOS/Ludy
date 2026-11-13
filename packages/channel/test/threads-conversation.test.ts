// SPDX-License-Identifier: AGPL-3.0-only
// Threads replies in the conversation core (#3133) against recorded answers. The answer shapes are the plan's [M] ones (no official page was read);
// the live check (docs/runbooks/threads-conversations-live-check.md) settles them. No live call.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConversationNoticeError,
  THREADS_MAX_NOTICE_BYTES,
  THREADS_REPLY_CAP_RETRY_MS,
  ThreadsConnector,
  ThreadsPublisher,
  parseThreadsNotices,
  replyCapExhausted,
  threadsSignatureOk,
  type Fetch,
} from '../src/index.ts';

const APP = { appId: '987654321', appSecret: 'threads-secret-not-real-0123456789' };
const USER = '17841400000000777';
const POST = '18000000000000001';
const SECRET = JSON.stringify({ accessToken: 'threads-token-1' });
const REDIRECT = 'https://crove.example/channels/oauth/threads/callback';
const NOW = Date.parse('2026-11-13T12:00:00Z');

type Answer = { status?: number; body?: unknown; network?: true };

function threads(routes: Record<string, Answer[]>) {
  const calls: { route: string; form: Record<string, string>; query: URLSearchParams; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ route, form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')), query: url.searchParams, auth: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const err = (code: number, status: number, message = 'refused'): Answer => ({ status, body: { error: { message, type: 'OAuthException', code } } });
const sign = (raw: string, secret = APP.appSecret) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const fast = { waitMs: 0, pollMs: 0, commentWaitMs: 0 };

describe('threadsSignatureOk (#3133)', () => {
  it('verifies X-Hub-Signature-256 with the Threads app secret over the raw bytes, and nothing else', () => {
    const raw = JSON.stringify({ object: 'threads', entry: [] });
    const body = new TextEncoder().encode(raw);
    expect(threadsSignatureOk({ body, header: sign(raw), appSecret: APP.appSecret })).toBe(true);
    expect(threadsSignatureOk({ body, header: sign(raw, 'other-secret-0123456789'), appSecret: APP.appSecret })).toBe(false);
    expect(threadsSignatureOk({ body: new TextEncoder().encode(`${raw} `), header: sign(raw), appSecret: APP.appSecret })).toBe(false);
    expect(threadsSignatureOk({ body, header: undefined, appSecret: APP.appSecret })).toBe(false);
    expect(threadsSignatureOk({ body, header: sign(raw).toUpperCase(), appSecret: APP.appSecret })).toBe(false);
    expect(threadsSignatureOk({ body, header: sign(raw), appSecret: '' })).toBe(false);
    expect(threadsSignatureOk({ body: new Uint8Array(THREADS_MAX_NOTICE_BYTES + 1), header: sign(raw), appSecret: APP.appSecret })).toBe(false);
  });
});

describe('parseThreadsNotices (#3133)', () => {
  const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const reply = (over: Record<string, unknown> = {}) => ({
    id: '18100000000000010',
    text: 'Còn size M không shop?',
    username: 'Khach.Hang_1',
    timestamp: '2026-11-13T11:30:00+0000',
    root_post: { id: POST },
    replied_to: { id: POST },
    ...over,
  });

  it('turns a reply to the own post into a comment thread of its own, with the author as contact', () => {
    const [notice, ...rest] = parseThreadsNotices(body({ object: 'threads', entry: [{ id: USER, time: 1_794_000_000, changes: [{ field: 'replies', value: reply() }] }] }), NOW);
    expect(rest).toEqual([]);
    expect(notice).toEqual({
      accountId: USER,
      events: [
        {
          kind: 'comment_thread',
          threadId: '18100000000000010',
          postId: POST,
          messageId: '18100000000000010',
          direction: 'in',
          contact: { id: 'khach.hang_1', name: '@Khach.Hang_1' },
          text: 'Còn size M không shop?',
          at: '2026-11-13T11:30:00.000Z',
        },
      ],
    });
  });

  it('puts a reply to a reply in its parent thread, the profile own reply as out, and keeps the hidden state', () => {
    const [notice] = parseThreadsNotices(
      body({
        object: 'threads',
        entry: [
          {
            id: USER,
            changes: [
              { field: 'replies', value: reply({ id: '18100000000000011', replied_to: { id: '18100000000000010' }, is_reply_owned_by_me: true, username: 'shop.cua.toi', text: 'Còn ạ' }) },
              { field: 'replies', value: reply({ id: '18100000000000012', replied_to: '18100000000000010', hide_status: 'HIDDEN' }) },
            ],
          },
        ],
      }),
      NOW,
    );
    const [own, hidden] = notice?.events ?? [];
    expect(own).toMatchObject({ threadId: '18100000000000010', messageId: '18100000000000011', direction: 'out', contact: { id: 'commenter:18100000000000010' }, text: 'Còn ạ' });
    expect(own?.contact.name).toBeUndefined();
    expect(hidden).toMatchObject({ threadId: '18100000000000010', direction: 'in', hidden: true });
  });

  it('uses a placeholder for a reply with no text, and drops what cannot be a reply', () => {
    const [notice] = parseThreadsNotices(
      body({
        object: 'threads',
        entry: [
          {
            id: USER,
            changes: [
              { field: 'replies', value: reply({ id: '18100000000000020', text: undefined }) },
              { field: 'mentions', value: reply({ id: '18100000000000021' }) },
              { field: 'replies', value: reply({ id: 'not-a-number' }) },
              { field: 'replies', value: reply({ id: '18100000000000022', root_post: undefined }) },
              { field: 'replies', value: reply({ id: '18100000000000023', timestamp: 'yesterday' }) },
              { field: 'replies', value: reply({ id: '18100000000000024', username: 'bad name!' }) },
            ],
          },
          { id: 'x', changes: [{ field: 'replies', value: reply() }] },
        ],
      }),
      NOW,
    );
    expect(notice?.events.map((e) => [e.messageId, e.text])).toEqual([
      ['18100000000000020', '[Khách gửi trả lời đính kèm]'],
      ['18100000000000024', 'Còn size M không shop?'],
    ]);
    // The unreadable username is no contact: the reply belongs to its thread's anonymous commenter.
    expect(notice?.events[1]?.contact).toEqual({ id: 'commenter:18100000000000024' });
  });

  it('ignores another product object, refuses what is not a notice, and keeps no text of a refusal', () => {
    expect(parseThreadsNotices(body({ object: 'page', entry: [{ id: USER }] }), NOW)).toEqual([]);
    for (const bad of ['', 'not json', '[]', '{"object":"threads"}', '{"entry":[]}']) {
      expect(() => parseThreadsNotices(new TextEncoder().encode(bad), NOW)).toThrow(ConversationNoticeError);
    }
    expect(() => parseThreadsNotices(new Uint8Array(THREADS_MAX_NOTICE_BYTES + 1), NOW)).toThrow(ConversationNoticeError);
  });
});

describe('the reply cap (#3133)', () => {
  it('reads the profile reply cap and says nothing when it cannot be read', () => {
    expect(replyCapExhausted({ data: [{ reply_quota_usage: 1000, reply_config: { quota_total: 1000 } }] })).toBe(true);
    expect(replyCapExhausted({ data: [{ reply_quota_usage: 999, reply_config: { quota_total: 1000 } }] })).toBe(false);
    expect(replyCapExhausted({ data: [] })).toBe(false);
    expect(replyCapExhausted(null)).toBe(false);
    expect(replyCapExhausted({ data: [{ reply_quota_usage: 5 }] })).toBe(false);
  });
});

describe('ThreadsConnector reply opt-in (#3133)', () => {
  const answers = (probe: Answer) => ({
    'POST /oauth/access_token': [{ body: { access_token: 'short', user_id: USER } }],
    'GET /access_token': [{ body: { access_token: 'long-token', expires_in: 5_184_000 } }],
    'GET /v1.0/me': [{ body: { id: USER, username: 'quan.a' } }],
    'GET /v1.0/me/replies': [probe],
  });

  it('asks for the reply-reading permission only on the opt-in, and records it only when a read that needs it works', async () => {
    const connector = new ThreadsConnector(APP, threads({}).fetchImpl);
    const plain = new URL(connector.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).searchParams.get('scope');
    const optIn = new URL(connector.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null, comments: true })).searchParams.get('scope');
    expect(plain).toBe('threads_basic,threads_content_publish,threads_manage_replies,threads_manage_insights');
    expect(optIn).toBe(`${plain},threads_read_replies`);

    const granted = threads(answers({ body: { data: [] } }));
    const [withScope] = await new ThreadsConnector(APP, granted.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    expect(withScope?.scopes).toContain('threads_read_replies');
    expect(granted.calls.at(-1)).toMatchObject({ route: 'GET /v1.0/me/replies', auth: 'Bearer long-token' });

    for (const probe of [err(10, 403, 'permission'), err(2, 500), { network: true as const }, { body: { nothing: 1 } }]) {
      const [without] = await new ThreadsConnector(APP, threads(answers(probe)).fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
      expect(without?.scopes).not.toContain('threads_read_replies');
      expect(without?.scopes).toContain('threads_manage_replies');
    }
  });
});

describe('ThreadsConversations.reply (#3133)', () => {
  const CONTAINER = '18000000000000077';
  const create = `POST /v1.0/${USER}/threads`;
  const status = `GET /v1.0/${CONTAINER}`;
  const publish = `POST /v1.0/${USER}/threads_publish`;
  const cap = `GET /v1.0/${USER}/threads_publishing_limit`;
  const input = (over: Record<string, unknown> = {}) => ({
    externalAccountId: USER,
    secret: SECRET,
    kind: 'comment_thread' as const,
    threadId: '18100000000000010',
    postId: POST,
    contactId: 'khach.hang_1',
    text: 'Còn size M ạ, mời bạn ghé shop',
    callKey: 'call-1',
    ...over,
  });
  // Fresh answers each time: the fake takes them off the lists.
  const okAnswers = (): Record<string, Answer[]> => ({
    [cap]: [{ body: { data: [{ reply_quota_usage: 3, reply_config: { quota_total: 1000, quota_duration: 86_400 } }] } }],
    [create]: [{ body: { id: CONTAINER } }],
    [status]: [{ body: { status: 'FINISHED', id: CONTAINER } }],
    [publish]: [{ body: { id: '18100000000000099' } }],
  });

  it('sends one reply: reads the cap, makes a reply container for the thread, publishes it once, and answers with its id', async () => {
    const { fetchImpl, calls } = threads(okAnswers());
    const result = await new ThreadsPublisher(fetchImpl, fast).conversations.reply(input());
    expect(result).toEqual({ kind: 'accepted', externalId: '18100000000000099' });
    expect(calls.map((c) => c.route)).toEqual([cap, create, status, publish]);
    expect(calls[0]?.query.get('fields')).toBe('reply_quota_usage,reply_config');
    expect(calls[1]?.form).toEqual({ media_type: 'TEXT', text: 'Còn size M ạ, mời bạn ghé shop', reply_to_id: '18100000000000010' });
    expect(calls[3]?.form).toEqual({ creation_id: CONTAINER });
    expect(calls.every((c) => c.auth === 'Bearer threads-token-1')).toBe(true);
  });

  it('refuses before any container when the profile used its API replies, and tries on when the cap cannot be read', async () => {
    const full = threads({ ...okAnswers(), [cap]: [{ body: { data: [{ reply_quota_usage: 1000, reply_config: { quota_total: 1000 } }] } }] });
    const before = Date.now();
    const refused = await new ThreadsPublisher(full.fetchImpl, fast).conversations.reply(input());
    expect(refused).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'THREADS_REPLY_CAP' });
    expect(refused.kind === 'rejected' ? refused.retryAt?.getTime() : 0).toBeGreaterThanOrEqual(before + THREADS_REPLY_CAP_RETRY_MS);
    expect(full.calls.map((c) => c.route)).toEqual([cap]);

    const unreadable = threads({ ...okAnswers(), [cap]: [err(2, 500)] });
    expect((await new ThreadsPublisher(unreadable.fetchImpl, fast).conversations.reply(input())).kind).toBe('accepted');
  });

  it('refuses what cannot be sent without a call, and maps the platform answers as the first comment does', async () => {
    const none = threads({});
    const adapter = new ThreadsPublisher(none.fetchImpl, fast).conversations;
    expect(await adapter.reply(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' });
    expect(await adapter.reply(input({ externalAccountId: 'abc' }))).toMatchObject({ kind: 'rejected', code: 'BAD_ACCOUNT_ID' });
    expect(await adapter.reply(input({ threadId: 'private:1' }))).toMatchObject({ kind: 'rejected', code: 'BAD_REPLY_ID' });
    expect(await adapter.reply(input({ text: '   ' }))).toMatchObject({ kind: 'rejected', code: 'EMPTY' });
    expect(await adapter.reply(input({ text: 'x'.repeat(501) }))).toMatchObject({ kind: 'rejected', code: 'THREADS_TEXT_LENGTH' });
    expect(await adapter.reply(input({ text: 'x'.repeat(500) })).then((r) => r.kind)).toBe('rejected');
    expect(none.calls.filter((c) => c.route !== cap && c.route !== create)).toEqual([]);

    const at = (answer: Answer) => new ThreadsPublisher(threads({ ...okAnswers(), [create]: [answer] }).fetchImpl, fast).conversations.reply(input());
    expect(await at(err(190, 401, 'Error validating access token'))).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '190' });
    expect(await at(err(10, 403, 'Application does not have permission'))).toMatchObject({ kind: 'rejected', error: 'permission', code: '10' });
    expect(await at(err(2, 500))).toMatchObject({ kind: 'rejected', error: 'transient' });
    // threads_publish is the visible step: an outage there may have posted the reply, so a person settles it and it is never repeated.
    const atPublish = (answer: Answer) => new ThreadsPublisher(threads({ ...okAnswers(), [publish]: [answer] }).fetchImpl, fast).conversations.reply(input());
    expect(await atPublish(err(2, 500))).toMatchObject({ kind: 'unknown', code: '2' });
    expect(await atPublish({ network: true })).toEqual({ kind: 'unknown', code: 'NETWORK' });
    expect(await atPublish({ body: {} })).toEqual({ kind: 'unknown', code: 'NO_POST_ID' });
  });
});

describe('ThreadsConversations.hide (#3133)', () => {
  const hide = (hidden: boolean, over: Record<string, unknown> = {}) => ({ externalAccountId: USER, secret: SECRET, externalMessageId: '18100000000000010', hidden, callKey: 'h-1', ...over });
  const route = 'POST /v1.0/18100000000000010/manage_reply';

  it('hides and unhides a top-level reply, and says when the platform did not confirm', async () => {
    const { fetchImpl, calls } = threads({ [route]: [{ body: { success: true } }, { body: { success: true } }, { body: {} }, err(190, 401), err(2, 500)] });
    const adapter = new ThreadsPublisher(fetchImpl, fast).conversations;
    expect(await adapter.hide?.(hide(true))).toEqual({ kind: 'done' });
    expect(await adapter.hide?.(hide(false))).toEqual({ kind: 'done' });
    expect(calls.map((c) => c.form)).toEqual([{ hide: 'true' }, { hide: 'false' }]);
    expect(await adapter.hide?.(hide(true))).toEqual({ kind: 'unknown', code: 'HIDE_NOT_CONFIRMED' });
    expect(await adapter.hide?.(hide(true))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await adapter.hide?.(hide(true))).toMatchObject({ kind: 'unknown', code: '2' });
    expect(await adapter.hide?.(hide(true, { externalMessageId: 'x' }))).toMatchObject({ kind: 'rejected', code: 'BAD_REPLY_ID' });
  });
});

describe('ThreadsConversations.history (#3133)', () => {
  const since = new Date('2026-11-10T00:00:00Z');
  const posts = `GET /v1.0/${USER}/threads`;
  const conversation = `GET /v1.0/${POST}/conversation`;
  const me = 'GET /v1.0/me';
  const row = (id: string, parent: string, at: string, over: Record<string, unknown> = {}) => ({ id, text: `text ${id}`, username: 'Khach.Hang_1', timestamp: at, replied_to: { id: parent }, ...over });
  const input = { externalAccountId: USER, secret: SECRET, since, maxChats: 20 };

  it('stores the replies it finds under recent posts, each in its top-level reply, the profile own as out', async () => {
    const { fetchImpl, calls } = threads({
      // The post is older than the last read: a reply to it is new all the same, so posts are not filtered by `since`.
      [posts]: [{ body: { data: [{ id: POST, timestamp: '2026-10-01T09:00:00+0000' }, { id: '18100000000000777', timestamp: '2026-11-12T09:00:00+0000', is_reply: true }] } }],
      [me]: [{ body: { id: USER, username: 'Shop.Cua.Toi' } }],
      [conversation]: [
        {
          body: {
            data: [
              row('18100000000000030', '18100000000000020', '2026-11-12T10:30:00+0000', { username: 'shop.cua.toi', is_reply_owned_by_me: true }),
              // Written in the Threads app: no flag, but the profile's own username.
              row('18100000000000035', '18100000000000030', '2026-11-12T10:40:00+0000', { username: 'Shop.Cua.Toi' }),
              row('18100000000000020', POST, '2026-11-12T10:00:00+0000'),
              row('18100000000000025', '18100000000000020', '2026-11-12T10:10:00+0000', { username: 'Nguoi.Khac', hide_status: 'HIDDEN' }),
              row('18100000000000040', '18100000000000030', '2026-11-12T11:00:00+0000'),
              row('18100000000000001', POST, '2026-11-01T10:00:00+0000'),
            ],
          },
        },
      ],
    });
    const result = await new ThreadsPublisher(fetchImpl, fast).conversations.history?.(input);
    expect(result?.kind).toBe('ok');
    if (result?.kind !== 'ok') return;
    expect(result.complete).toBe(true);
    expect(result.oldest).toBe('2026-11-01T10:00:00.000Z');
    expect(result.events.map((e) => [e.messageId, e.threadId, e.postId, e.direction, e.hidden])).toEqual([
      ['18100000000000020', '18100000000000020', POST, 'in', undefined],
      ['18100000000000025', '18100000000000020', POST, 'in', true],
      ['18100000000000030', '18100000000000020', POST, 'out', undefined],
      ['18100000000000035', '18100000000000020', POST, 'out', undefined],
      ['18100000000000040', '18100000000000020', POST, 'in', undefined],
    ]);
    expect(calls[0]?.query.get('since')).toBeNull();
    expect(calls[0]?.query.get('fields')).toBe('id,timestamp,is_reply');
    // Only the one real post's conversation is read (the profile's own reply listed beside its posts is skipped), newest first.
    const conversationCalls = calls.filter((c) => c.route === conversation);
    expect(conversationCalls).toHaveLength(1);
    expect(conversationCalls[0]?.query.get('fields')).toBe('id,text,username,timestamp,replied_to,is_reply_owned_by_me,hide_status');
    expect(conversationCalls[0]?.query.get('reverse')).toBe('true');
  });

  it('says it is incomplete when a post has more replies than one read, and fails by kind', async () => {
    const many = Array.from({ length: 100 }, (_, i) => row(`181000000000${String(10_000 + i)}`, POST, '2026-11-12T10:00:00+0000'));
    const incomplete = threads({ [posts]: [{ body: { data: [{ id: POST }] } }], [conversation]: [{ body: { data: many, paging: { next: 'https://graph.threads.net/next' } } }] });
    expect(await new ThreadsPublisher(incomplete.fetchImpl, fast).conversations.history?.(input)).toMatchObject({ kind: 'ok', complete: false });

    const failing = (a: Answer, b?: Answer) => new ThreadsPublisher(threads({ [posts]: [a], ...(b ? { [conversation]: [b] } : {}) }).fetchImpl, fast).conversations.history?.(input);
    expect(await failing(err(190, 401))).toMatchObject({ kind: 'failed', retry: false });
    expect(await failing(err(10, 403))).toMatchObject({ kind: 'failed', retry: false });
    expect(await failing(err(2, 500))).toMatchObject({ kind: 'failed', retry: true, code: '2' });
    expect(await failing({ network: true })).toMatchObject({ kind: 'failed', retry: true });
    expect(await failing({ body: { data: [{ id: POST }] } }, err(10, 403))).toMatchObject({ kind: 'failed', retry: false });
    expect(await failing({ body: { data: [{ id: POST }] } }, err(2, 500))).toMatchObject({ kind: 'failed', retry: true });
    // A post that is gone is skipped.
    expect(await failing({ body: { data: [{ id: POST }] } }, err(100, 404))).toMatchObject({ kind: 'ok', events: [] });
    // An invalid request is not a missing post: the read fails, so no gap is cleared by a read that read nothing.
    expect(await failing({ body: { data: [{ id: POST }] } }, err(100, 400))).toMatchObject({ kind: 'failed', retry: false });
    // A next page is unread history even when this page is short.
    const short = threads({ [posts]: [{ body: { data: [{ id: POST }] } }], [conversation]: [{ body: { data: [row('18100000000000060', POST, '2026-11-12T10:00:00+0000')], paging: { next: 'https://graph.threads.net/next' } } }] });
    expect(await new ThreadsPublisher(short.fetchImpl, fast).conversations.history?.(input)).toMatchObject({ kind: 'ok', complete: false });
    // More recent posts than one pass reads is a gap, not a complete read.
    const morePosts = threads({ [posts]: [{ body: { data: [{ id: POST }], paging: { next: 'https://graph.threads.net/next' } } }], [conversation]: [{ body: { data: [] } }] });
    expect(await new ThreadsPublisher(morePosts.fetchImpl, fast).conversations.history?.({ ...input, maxChats: 1 })).toMatchObject({ kind: 'ok', complete: false });
    const noToken = await new ThreadsPublisher(threads({}).fetchImpl, fast).conversations.history?.({ ...input, secret: '{}' });
    expect(noToken).toMatchObject({ kind: 'failed', retry: false, code: 'NO_TOKEN' });
  });
});
