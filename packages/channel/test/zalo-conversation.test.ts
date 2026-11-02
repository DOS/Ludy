// SPDX-License-Identifier: AGPL-3.0-only
// Zalo OA's conversations (#2304) against recorded answers and event shapes from secondary sources; no live call. Every shape is
// [S] or [U] in docs/plan/conversations.md section 6.5 and is settled by the live-check runbook: these tests pin what the code
// does with each, so a correction from a real event changes one line and one expectation.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConversationNoticeError, ZALO_MAX_NOTICE_BYTES, ZaloConversations, ZaloOaPublisher, parseZaloNotice, zaloSignatureOk, type Fetch } from '../src/index.ts';

const APP = { appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' };
const OA_KEY = 'test-oa-secret-key-not-real';
const SECRET = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });
const bytes = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

// The header Zalo would send for this body: mac=sha256(appId + body + timestamp + oaSecretKey).
function sign(body: Buffer, timestamp: string, key = OA_KEY, appId = APP.appId): string {
  return `mac=${createHash('sha256').update(appId + body.toString('utf8') + timestamp + key).digest('hex')}`;
}

const TEXT = { app_id: APP.appId, event_name: 'user_send_text', timestamp: '1788300000000', sender: { id: 'u-100' }, recipient: { id: 'oa-1' }, message: { msg_id: 'm-1', text: 'Shop còn hàng không?' } };

describe('the signature of a Zalo notice', () => {
  const body = bytes(TEXT);
  const check = (header: string | undefined, input: Partial<{ body: Uint8Array; appId: string; oaSecretKey: string }> = {}) =>
    zaloSignatureOk({ body: input.body ?? body, header, appId: input.appId ?? APP.appId, oaSecretKey: input.oaSecretKey ?? OA_KEY });

  it('accepts the documented formula and nothing else', () => {
    expect(check(sign(body, TEXT.timestamp))).toBe(true);
    // Upper-case hex is the same hash.
    expect(check(sign(body, TEXT.timestamp).toUpperCase().replace('MAC=', 'mac='))).toBe(true);
    expect(check(undefined)).toBe(false);
    expect(check('')).toBe(false);
    expect(check(sign(body, TEXT.timestamp).slice(4))).toBe(false);
    expect(check(`mac=${'0'.repeat(64)}`)).toBe(false);
    expect(check('mac=zz')).toBe(false);
    // Another key, another app, another body, another timestamp.
    expect(check(sign(body, TEXT.timestamp, 'another-key'))).toBe(false);
    expect(check(sign(body, TEXT.timestamp, OA_KEY, '999'))).toBe(false);
    expect(check(sign(body, '1788300000001'))).toBe(false);
    expect(check(sign(body, TEXT.timestamp), { body: bytes({ ...TEXT, message: { msg_id: 'm-1', text: 'khác' } }) })).toBe(false);
    // No key configured, no body timestamp: never true.
    expect(check(sign(body, TEXT.timestamp), { oaSecretKey: '' })).toBe(false);
    expect(check(sign(bytes({ event_name: 'user_send_text' }), '0'), { body: bytes({ event_name: 'user_send_text' }) })).toBe(false);
  });

  it('reads the timestamp as a string or a number, and signs the raw bytes as sent', () => {
    const asNumber = bytes('{"app_id":"4318000000000000001","timestamp":1788300000000,"event_name":"follow"}');
    expect(check(sign(asNumber, '1788300000000'), { body: asNumber })).toBe(true);
    // Whitespace and key order of the original bytes count: a re-serialized body is another body.
    const spaced = bytes('{ "event_name": "follow",  "timestamp": "1788300000000" }');
    expect(check(sign(spaced, '1788300000000'), { body: spaced })).toBe(true);
    expect(check(sign(spaced, '1788300000000'), { body: bytes({ event_name: 'follow', timestamp: '1788300000000' }) })).toBe(false);
  });
});

describe('what the parser refuses to date, name or carry', () => {
  const events = (patch: Record<string, unknown>) => parseZaloNotice(bytes({ ...TEXT, ...patch })).events;

  it('reads a timestamp of seconds as seconds, and refuses one outside a sane range', () => {
    expect(events({ timestamp: '1788300000' })[0]?.at).toBe('2026-09-01T22:00:00.000Z');
    expect(events({ timestamp: 1788300000000 })[0]?.at).toBe('2026-09-01T22:00:00.000Z');
    expect(events({ timestamp: '1000000000' })).toEqual([]);
    expect(events({ timestamp: '9'.repeat(18) })).toEqual([]);
    expect(events({ timestamp: String(Date.now() + 3 * 86_400_000) })).toEqual([]);
    expect(events({ timestamp: '0' })).toEqual([]);
  });

  it('takes an id as a string or a number a double holds exactly, never a rounded one, and none that is too long', () => {
    expect(events({ sender: { id: 123456789 } })[0]?.threadId).toBe('123456789');
    expect(events({ sender: { id: Number('12345678901234567890') } })).toEqual([]);
    expect(events({ sender: { id: '' } })).toEqual([]);
    expect(events({ sender: { id: 'u'.repeat(201) } })).toEqual([]);
    expect(events({ message: { msg_id: 'm'.repeat(301), text: 'x' } })).toEqual([]);
  });

  it('strips a NUL character, cuts a text to what the core holds, and keeps an attachment beside its caption', () => {
    expect(events({ message: { msg_id: 'm-1', text: 'có\u0000ký tự rỗng' } })[0]?.text).toBe('cóký tự rỗng');
    expect(events({ message: { msg_id: 'm-1', text: 'a'.repeat(30_000) } })[0]?.text).toHaveLength(20_000);
    expect(events({ event_name: 'user_send_image', message: { msg_id: 'm-1', text: 'Ảnh sản phẩm' } })[0]?.text).toBe('Ảnh sản phẩm\n[Khách gửi ảnh]');
    expect(events({ message: { msg_id: 'm-1', text: '\u0000' } })[0]?.text).toBe('[Khách gửi một tệp đính kèm]');
  });
});

describe('the events of a Zalo notice', () => {
  it('turns a customer text into a private message of the thread of that customer, with the OA as the account', () => {
    expect(parseZaloNotice(bytes(TEXT))).toEqual({
      accountId: 'oa-1',
      events: [{ kind: 'direct', threadId: 'u-100', messageId: 'm-1', direction: 'in', contact: { id: 'u-100' }, text: 'Shop còn hàng không?', at: '2026-09-01T22:00:00.000Z' }],
    });
  });

  it('names an attachment by its kind and never keeps its address', () => {
    for (const [event, label] of [
      ['user_send_image', '[Khách gửi ảnh]'],
      ['user_send_file', '[Khách gửi tệp]'],
      ['user_send_sticker', '[Khách gửi nhãn dán]'],
      ['user_send_location', '[Khách gửi vị trí]'],
      ['user_send_audio', '[Khách gửi tin nhắn thoại]'],
    ] as const) {
      const parsed = parseZaloNotice(bytes({ ...TEXT, event_name: event, message: { msg_id: 'm-2', attachments: [{ type: 'image', payload: { url: 'https://zalo.test/secret-photo.jpg' } }] } }));
      expect(parsed.events[0]?.text).toBe(label);
      expect(JSON.stringify(parsed)).not.toContain('secret-photo');
    }
  });

  it("takes the OA's own message, seen from its inbox, as an echo of the thread of its customer", () => {
    const parsed = parseZaloNotice(bytes({ ...TEXT, event_name: 'oa_send_text', sender: { id: 'oa-1' }, recipient: { id: 'u-100' }, message: { msg_id: 'm-3', text: 'Dạ còn ạ' } }));
    expect(parsed).toEqual({
      accountId: 'oa-1',
      events: [{ kind: 'direct', threadId: 'u-100', messageId: 'm-3', direction: 'out', contact: { id: 'u-100' }, text: 'Dạ còn ạ', at: '2026-09-01T22:00:00.000Z' }],
    });
    expect(parseZaloNotice(bytes({ ...TEXT, event_name: 'oa_send_image', sender: { id: 'oa-1' }, recipient: { id: 'u-100' }, message: { msg_id: 'm-4' } })).events[0]?.text).toBe('[Trang đã gửi một tệp đính kèm]');
  });

  it('gives no event for what is not a message, or has no id or time, and refuses what is not an object', () => {
    for (const name of ['follow', 'unfollow', 'user_received_message', 'user_seen_message', 'something_new', '']) {
      expect(parseZaloNotice(bytes({ ...TEXT, event_name: name })).events, name).toEqual([]);
    }
    expect(parseZaloNotice(bytes({ ...TEXT, message: { text: 'không có id' } })).events).toEqual([]);
    expect(parseZaloNotice(bytes({ ...TEXT, timestamp: 'x' })).events).toEqual([]);
    expect(parseZaloNotice(bytes({ ...TEXT, sender: {} })).events).toEqual([]);
    for (const bad of ['not json', '[]', 'null', '"text"', '']) expect(() => parseZaloNotice(bytes(bad))).toThrow(ConversationNoticeError);
    expect(() => parseZaloNotice(Buffer.alloc(ZALO_MAX_NOTICE_BYTES + 1, 32))).toThrow(ConversationNoticeError);
  });
});

function zalo(answers: { status?: number; body?: unknown; throws?: boolean }[]) {
  const calls: { url: string; headers: Headers; json: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), headers, json: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const next = answers.shift();
    if (!next || next.throws) throw new TypeError('network down');
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const reply = (adapter: ZaloConversations, extra: Partial<Parameters<ZaloConversations['reply']>[0]> = {}) =>
  adapter.reply({ externalAccountId: 'oa-1', secret: SECRET, kind: 'direct', threadId: 'u-100', postId: null, contactId: 'u-100', text: 'Dạ còn ạ', callKey: 'conversation.reply:m:1', ...extra });

describe('ZaloConversations.reply', () => {
  it('sends a customer care message once, with the token in the header, to the v3.0 endpoint', async () => {
    const { calls, fetchImpl } = zalo([{ body: { error: 0, message: 'Success', data: { message_id: 'zm-1', user_id: 'u-100' } } }]);
    expect(await reply(new ZaloConversations(APP, fetchImpl))).toEqual({ kind: 'accepted', externalId: 'zm-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openapi.zalo.me/v3.0/oa/message/cs');
    expect(calls[0]?.headers.get('access_token')).toBe('zalo-access-1');
    expect(calls[0]?.json).toEqual({ recipient: { user_id: 'u-100' }, message: { text: 'Dạ còn ạ' } });
    // The publisher carries it, for the worker to find by provider.
    expect(new ZaloOaPublisher(APP, fetchImpl).conversations).toBeInstanceOf(ZaloConversations);
  });

  it("maps Zalo's errors to a typed answer and a code the screen words", async () => {
    const answer = async (status: number, error: number | undefined) => {
      const { fetchImpl } = zalo([{ status, body: error === undefined ? { message: 'x' } : { error, message: 'x' } }]);
      return reply(new ZaloConversations(APP, fetchImpl));
    };
    expect(await answer(200, -216)).toEqual({ kind: 'rejected', error: 'token_expired', code: 'ZALO_TOKEN' });
    expect(await answer(200, -220)).toEqual({ kind: 'rejected', error: 'token_expired', code: 'ZALO_TOKEN' });
    expect(await answer(401, undefined)).toEqual({ kind: 'rejected', error: 'token_expired', code: 'ZALO_TOKEN' });
    expect(await answer(200, -223)).toEqual({ kind: 'rejected', error: 'rate_limited', code: 'ZALO_QUOTA' });
    expect(await answer(200, -32)).toEqual({ kind: 'rejected', error: 'rate_limited', code: 'ZALO_RATE_LIMIT' });
    expect(await answer(429, undefined)).toEqual({ kind: 'rejected', error: 'rate_limited', code: 'ZALO_RATE_LIMIT' });
    expect(await answer(200, -213)).toEqual({ kind: 'rejected', error: 'permission', code: 'ZALO_NOT_FOLLOWER' });
    expect(await answer(200, -232)).toEqual({ kind: 'rejected', error: 'permission', code: 'ZALO_BLOCKED' });
    expect(await answer(200, -224)).toEqual({ kind: 'rejected', error: 'permission', code: 'ZALO_OA_ACCESS' });
    expect(await answer(200, -201)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_BAD_PARAM' });
    expect(await answer(200, -999)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_E999' });
    expect(await answer(400, undefined)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_HTTP_400' });
    // A server error or a lost connection may have gone through: unclear, never repeated by the caller.
    expect(await answer(502, undefined)).toEqual({ kind: 'unknown', code: 'ZALO_5XX' });
    expect(await reply(new ZaloConversations(APP, zalo([{ throws: true }]).fetchImpl))).toEqual({ kind: 'unknown', code: 'ZALO_UNREACHABLE' });
    // An answer that could not be read (not JSON, empty, a redirect, a cut-off body) is unclear too: Zalo may have taken the message.
    const html = async () => reply(new ZaloConversations(APP, (async () => new Response('<html>bad gateway</html>', { status: 200 })) as Fetch));
    expect(await html()).toEqual({ kind: 'unknown', code: 'ZALO_BAD_ANSWER' });
    expect(await reply(new ZaloConversations(APP, (async () => new Response('', { status: 302 })) as Fetch))).toEqual({ kind: 'unknown', code: 'ZALO_BAD_ANSWER' });
    expect(await reply(new ZaloConversations(APP, (async () => new Response('{}', { status: 408 })) as Fetch))).toEqual({ kind: 'unknown', code: 'ZALO_BAD_ANSWER' });
    // Success without an id is unclear too (the echo cannot be matched), and an answer is never the message or the token.
    expect(await reply(new ZaloConversations(APP, zalo([{ body: { error: 0, data: {} } }]).fetchImpl))).toEqual({ kind: 'unknown', code: 'ZALO_NO_MESSAGE_ID' });
  });

  it('refuses before it asks what Zalo cannot take: no token, a comment, no text, too long a text', async () => {
    const { calls, fetchImpl } = zalo([]);
    const adapter = new ZaloConversations(APP, fetchImpl);
    expect(await reply(adapter, { secret: '{}' })).toEqual({ kind: 'rejected', error: 'token_expired', code: 'ZALO_NO_TOKEN' });
    expect(await reply(adapter, { kind: 'comment_thread' })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_DIRECT_ONLY' });
    expect(await reply(adapter, { text: '' })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_TEXT_LENGTH' });
    expect(await reply(adapter, { text: 'a'.repeat(2001) })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ZALO_TEXT_LENGTH' });
    expect(calls).toHaveLength(0);
  });
});

describe('ZaloConversations.profile and history (CV5b, #2329; the answers shapes are [U] until the live check)', () => {
  const profile = (adapter: ZaloConversations) => adapter.profile({ externalAccountId: 'oa-1', secret: SECRET, contactId: 'u-100' });

  it("reads a customer's display name with the user id in `data`, and takes no other field", async () => {
    const { calls, fetchImpl } = zalo([{ body: { error: 0, message: 'Success', data: { display_name: '  Trần Thị Khách  ', user_id: 'u-100', phone: '0912345678', avatar: 'https://x/y.png' } } }]);
    expect(await profile(new ZaloConversations(APP, fetchImpl))).toEqual({ kind: 'ok', displayName: 'Trần Thị Khách' });
    expect(calls[0]?.url).toBe(`https://openapi.zalo.me/v3.0/oa/user/detail?data=${encodeURIComponent('{"user_id":"u-100"}')}`);
    expect(calls[0]?.headers.get('access_token')).toBe('zalo-access-1');
    // No name is a definitive answer, not a failure.
    expect(await profile(new ZaloConversations(APP, zalo([{ body: { error: 0, data: { display_name: '' } } }]).fetchImpl))).toEqual({ kind: 'ok', displayName: null });
    expect(await profile(new ZaloConversations(APP, zalo([{ body: { error: 0, data: {} } }]).fetchImpl))).toEqual({ kind: 'ok', displayName: null });
  });

  it('says whether a failed profile read is worth asking again', async () => {
    const answer = async (status: number, error: number | undefined) => profile(new ZaloConversations(APP, zalo([{ status, body: error === undefined ? { message: 'x' } : { error, message: 'x' } }]).fetchImpl));
    expect(await answer(200, -216)).toEqual({ kind: 'failed', retry: false, code: 'ZALO_TOKEN' });
    expect(await answer(200, -32)).toEqual({ kind: 'failed', retry: true, code: 'ZALO_RATE_LIMIT' });
    expect(await answer(502, undefined)).toEqual({ kind: 'failed', retry: true, code: 'ZALO_5XX' });
    expect(await answer(200, -224)).toEqual({ kind: 'failed', retry: false, code: 'ZALO_OA_ACCESS' });
    expect(await profile(new ZaloConversations(APP, zalo([{ throws: true }]).fetchImpl))).toEqual({ kind: 'failed', retry: true, code: 'ZALO_UNREACHABLE' });
    expect(await profile(new ZaloConversations(APP, zalo([]).fetchImpl)).catch(() => 'threw')).toBeDefined();
  });

  const NOW = Date.now();
  const msg = (id: string, src: 0 | 1, at: number, text: string, extra: Record<string, unknown> = {}) => ({ message_id: id, src, time: at, type: 'text', message: text, from_id: src === 1 ? 'u-100' : 'oa-1', to_id: src === 1 ? 'oa-1' : 'u-100', ...extra });

  it('reads the recent chats and their messages back to the window, and says it reached it', async () => {
    const { calls, fetchImpl } = zalo([
      { body: { error: 0, data: [msg('l-1', 1, NOW - 60_000, 'tin mới nhất')] } },
      { body: { error: 0, data: [msg('h-3', 0, NOW - 30_000, 'Dạ còn ạ'), msg('h-2', 1, NOW - 60_000, 'Shop còn hàng không?'), msg('h-1', 1, NOW - 9 * 86_400_000, 'tin quá cũ')] } },
    ]);
    const out = await new ZaloConversations(APP, fetchImpl).history({ externalAccountId: 'oa-1', secret: SECRET, since: new Date(NOW - 7 * 86_400_000), maxChats: 20 });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.complete).toBe(true);
    expect(out.events.map((e) => [e.messageId, e.direction, e.text, e.contact.id, e.threadId, e.kind])).toEqual([
      ['h-3', 'out', 'Dạ còn ạ', 'u-100', 'u-100', 'direct'],
      ['h-2', 'in', 'Shop còn hàng không?', 'u-100', 'u-100', 'direct'],
    ]);
    expect(calls[0]?.url).toContain('/v2.0/oa/listrecentchat?data=');
    expect(calls[1]?.url).toContain('/v2.0/oa/conversation?data=');
    expect(JSON.parse(new URL(calls[1]?.url as string).searchParams.get('data') as string)).toEqual({ user_id: 'u-100', offset: 0, count: 10 });
  });

  it('says it did not reach back when a chat has more than it read or there are more chats than it reads, and maps attachments to placeholders', async () => {
    // A full page of ten messages all inside the window and the cap on messages reached: not complete.
    const page = (from: number) => Array.from({ length: 10 }, (_, i) => msg(`p-${from + i}`, 1, NOW - (from + i + 1) * 60_000, `tin ${from + i}`));
    const chats = { body: { error: 0, data: [msg('l-1', 1, NOW - 1000, 'x')] } };
    const { fetchImpl } = zalo([chats, ...[0, 10, 20, 30, 40].map((n) => ({ body: { error: 0, data: page(n) } }))]);
    const out = await new ZaloConversations(APP, fetchImpl).history({ externalAccountId: 'oa-1', secret: SECRET, since: new Date(NOW - 7 * 86_400_000), maxChats: 20 });
    expect(out.kind === 'ok' && out.complete).toBe(false);
    expect(out.kind === 'ok' && out.events).toHaveLength(50);
    const attach = zalo([chats, { body: { error: 0, data: [msg('a-1', 1, NOW - 5000, '', { type: 'photo' }), msg('a-2', 0, NOW - 4000, '', { type: 'file' })] } }]);
    const got = await new ZaloConversations(APP, attach.fetchImpl).history({ externalAccountId: 'oa-1', secret: SECRET, since: new Date(NOW - 86_400_000), maxChats: 20 });
    expect(got.kind === 'ok' && got.events.map((e) => e.text)).toEqual(['[Khách gửi một tệp đính kèm]', '[Trang đã gửi một tệp đính kèm]']);
  });

  it('fails a history read with a refused token as final and a lost connection as worth trying again, and returns nothing partial', async () => {
    const input = { externalAccountId: 'oa-1', secret: SECRET, since: new Date(NOW - 86_400_000), maxChats: 20 };
    expect(await new ZaloConversations(APP, zalo([{ body: { error: -216, message: 'x' } }]).fetchImpl).history(input)).toEqual({ kind: 'failed', retry: false, code: 'ZALO_TOKEN' });
    expect(await new ZaloConversations(APP, zalo([{ throws: true }]).fetchImpl).history(input)).toEqual({ kind: 'failed', retry: true, code: 'ZALO_UNREACHABLE' });
    expect(await new ZaloConversations(APP, zalo([{ body: { error: 0, data: [msg('l-1', 1, NOW - 1000, 'x')] } }, { body: { error: -32, message: 'x' } }]).fetchImpl).history(input)).toEqual({ kind: 'failed', retry: true, code: 'ZALO_RATE_LIMIT' });
  });
});
