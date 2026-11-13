// SPDX-License-Identifier: AGPL-3.0-only
// Telegram bot chats (#3132) against recorded Bot API answers and update shapes from the plan (docs/plan/conversations-channels.md section 4.2,
// [M] and [S] until the live check settles them); no live call. These tests pin what the code does with each shape, so a correction from a
// real update changes one line and one expectation.
import { describe, expect, it } from 'vitest';
import {
  ConversationNoticeError,
  TELEGRAM_CHAT_UPDATES,
  TELEGRAM_HOOK_PATTERN,
  TelegramConversations,
  deleteTelegramWebhook,
  newTelegramHookId,
  parseTelegramChatNotice,
  setTelegramWebhook,
  telegramBotId,
  telegramChatEvents,
  telegramHookSecret,
  telegramHookSecretOk,
  wrapTelegramChatNotice,
  type ConversationReplyInput,
  type Fetch,
} from '../src/index.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
const SECRET = JSON.stringify({ botToken: TOKEN, username: 'quanpho' });
const KEY = Buffer.alloc(32, 7);
const OLD_KEY = Buffer.alloc(32, 9);
// 2026-11-13 in seconds.
const DATE = 1_794_500_000;

describe('the hook id and its secret', () => {
  it('makes a 43-character id of 32 random bytes, never the same twice', () => {
    const a = newTelegramHookId();
    const b = newTelegramHookId();
    expect(a).toMatch(TELEGRAM_HOOK_PATTERN);
    expect(a).not.toBe(b);
  });

  it('derives a secret Telegram accepts as secret_token (1 to 256 of A-Za-z0-9_-), the same for the same hook and key', () => {
    const hook = newTelegramHookId();
    const secret = telegramHookSecret(KEY, hook);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(telegramHookSecret(KEY, hook)).toBe(secret);
    // Another hook or another key, another secret; the secret is not the hook.
    expect(telegramHookSecret(KEY, newTelegramHookId())).not.toBe(secret);
    expect(telegramHookSecret(OLD_KEY, hook)).not.toBe(secret);
    expect(secret).not.toBe(hook);
  });

  it('checks the header against the hook in the path: only the right secret passes, under the current key or the one it replaces', () => {
    const hook = newTelegramHookId();
    const ok = (header: string | undefined, over: Partial<{ hook: string; keys: Buffer[] }> = {}) => telegramHookSecretOk({ hook: over.hook ?? hook, header, keys: over.keys ?? [KEY] });
    expect(ok(telegramHookSecret(KEY, hook))).toBe(true);
    // A key rotation that keeps the old key keeps the webhook.
    expect(ok(telegramHookSecret(OLD_KEY, hook), { keys: [KEY, OLD_KEY] })).toBe(true);
    // The secret of another hook, of another key, a missing, empty, short or long header, and an id that is no hook: all the same refusal.
    expect(ok(telegramHookSecret(KEY, newTelegramHookId()))).toBe(false);
    expect(ok(telegramHookSecret(OLD_KEY, hook))).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok(telegramHookSecret(KEY, hook).slice(1))).toBe(false);
    expect(ok(`${telegramHookSecret(KEY, hook)}a`)).toBe(false);
    expect(ok(hook)).toBe(false);
    expect(ok(telegramHookSecret(KEY, 'short'), { hook: 'short' })).toBe(false);
    expect(ok(telegramHookSecret(KEY, hook), { keys: [] })).toBe(false);
  });

  it('takes the bot id from the token and knows no secret of it', () => {
    expect(telegramBotId(TOKEN)).toBe('123456789');
  });
});

const message = (over: Record<string, unknown> = {}, from: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 5,
    from: { id: 111, is_bot: false, first_name: 'An', last_name: 'Nguyễn', username: 'an_ng', language_code: 'vi', ...from },
    chat: { id: 111, first_name: 'An', type: 'private' },
    date: DATE,
    text: 'Shop còn hàng không?',
    ...over,
  },
});

describe('the events of an update', () => {
  it('reads a private message: the thread is the chat, the customer is the sender, the name is first and last name', () => {
    expect(telegramChatEvents(message())).toEqual([
      { kind: 'direct', threadId: '111', messageId: '5', direction: 'in', contact: { id: '111', name: 'An Nguyễn' }, text: 'Shop còn hàng không?', at: new Date(DATE * 1000).toISOString() },
    ]);
  });

  it('falls back to the username for a name, and to none', () => {
    expect(telegramChatEvents(message({}, { first_name: undefined, last_name: undefined }))[0]?.contact).toEqual({ id: '111', name: 'an_ng' });
    expect(telegramChatEvents(message({}, { first_name: ' ', last_name: undefined, username: undefined }))[0]?.contact).toEqual({ id: '111' });
  });

  it('keeps a photo as a placeholder line with its caption, and never the file id', () => {
    const update = message({ text: undefined, caption: 'Cái này', photo: [{ file_id: 'small', width: 90 }, { file_id: 'big', width: 800 }] });
    const [event] = telegramChatEvents(update);
    expect(event?.text).toBe('Cái này\n[Khách gửi ảnh]');
    expect(JSON.stringify(event)).not.toContain('big');
  });

  it('names the other kinds of message by a placeholder', () => {
    for (const [field, line] of [['sticker', '[Khách gửi nhãn dán]'], ['voice', '[Khách gửi tin nhắn thoại]'], ['video', '[Khách gửi video]'], ['document', '[Khách gửi tệp]'], ['location', '[Khách gửi vị trí]'], ['contact', '[Khách gửi danh bạ]']] as const) {
      expect(telegramChatEvents(message({ text: undefined, [field]: { x: 1 } }))[0]?.text).toBe(line);
    }
  });

  it('gives nothing for a group, a channel, a bot, an edit, a service message, a missing id or a date out of range', () => {
    expect(telegramChatEvents(message({ chat: { id: -100123, type: 'supergroup' } }))).toEqual([]);
    expect(telegramChatEvents(message({ chat: { id: -100123, type: 'channel' } }))).toEqual([]);
    expect(telegramChatEvents(message({}, { is_bot: true }))).toEqual([]);
    expect(telegramChatEvents({ update_id: 2, edited_message: message().message })).toEqual([]);
    expect(telegramChatEvents(message({ text: undefined, new_chat_members: [] }))).toEqual([]);
    expect(telegramChatEvents(message({ message_id: undefined }))).toEqual([]);
    expect(telegramChatEvents(message({ date: 3600 }))).toEqual([]);
    expect(telegramChatEvents(message({ date: Date.now() / 1000 + 10 * 86_400 }))).toEqual([]);
    expect(telegramChatEvents(null)).toEqual([]);
    expect(telegramChatEvents([])).toEqual([]);
    expect(telegramChatEvents({ update_id: 3 })).toEqual([]);
  });

  it('removes a NUL character, which PostgreSQL refuses in text', () => {
    expect(telegramChatEvents(message({ text: 'a\u0000b' }))[0]?.text).toBe('ab');
  });
});

describe('the notice the route parks', () => {
  const hook = newTelegramHookId();
  const raw = Buffer.from(JSON.stringify(message()), 'utf8');

  it('wraps the update unchanged and reads it back: the hook is the account, and no org is anywhere', () => {
    const body = wrapTelegramChatNotice(hook, raw);
    expect(JSON.parse(body.toString('utf8'))).toEqual({ v: 1, hook, update: message() });
    const notice = parseTelegramChatNotice(body);
    expect(notice.accountId).toBe(hook);
    expect(notice.events).toHaveLength(1);
    expect(notice.connectionId).toBeUndefined();
  });

  it('is malformed for an empty or oversized body, bad JSON, another version, or a hook of the wrong shape', () => {
    const malformed = (body: Uint8Array) => {
      try {
        parseTelegramChatNotice(body);
        return false;
      } catch (error) {
        return error instanceof ConversationNoticeError && error.reason === 'malformed';
      }
    };
    expect(malformed(Buffer.alloc(0))).toBe(true);
    expect(malformed(Buffer.alloc(200_000, 'a'))).toBe(true);
    expect(malformed(Buffer.from('{nope', 'utf8'))).toBe(true);
    expect(malformed(Buffer.from(JSON.stringify({ v: 2, hook, update: {} }), 'utf8'))).toBe(true);
    expect(malformed(Buffer.from(JSON.stringify({ v: 1, hook: 'short', update: {} }), 'utf8'))).toBe(true);
    expect(malformed(Buffer.from('[]', 'utf8'))).toBe(true);
    expect(malformed(wrapTelegramChatNotice(hook, raw))).toBe(false);
  });

  it('gives a notice with no event for an update that is no customer message', () => {
    const body = wrapTelegramChatNotice(hook, Buffer.from(JSON.stringify({ update_id: 9, edited_message: message().message }), 'utf8'));
    expect(parseTelegramChatNotice(body)).toEqual({ accountId: hook, events: [] });
  });
});

type Sent = { method: string; token: string; json: Record<string, unknown> };
function bot(answers: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Sent[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
    calls.push({ method, token: tokenPart.replace(/^bot/, ''), json: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const answer = answers.shift() ?? { status: 500, body: { ok: false, error_code: 500, description: 'no answer' } };
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const ok = (result: unknown) => ({ body: { ok: true, result } });
const fail = (status: number, description: string, extra: Record<string, unknown> = {}) => ({ status, body: { ok: false, error_code: status, description, ...extra } });

const reply = (over: Partial<ConversationReplyInput> = {}): ConversationReplyInput => ({
  externalAccountId: '-1001234567890',
  secret: SECRET,
  kind: 'direct',
  threadId: '111',
  postId: null,
  contactId: '111',
  text: 'Dạ còn ạ, anh chị cần size nào?',
  callKey: 'call-1',
  ...over,
});

describe('a reply through sendMessage', () => {
  it('sends plain text to the chat once, with no parse mode and never a paid broadcast, and names the message by its id', async () => {
    const { calls, fetchImpl } = bot([ok({ message_id: 42 })]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    expect(await adapter.reply(reply())).toEqual({ kind: 'accepted', externalId: '42' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'sendMessage', token: TOKEN, json: { chat_id: '111', text: 'Dạ còn ạ, anh chị cần size nào?' } });
    expect(Object.keys(calls[0]?.json ?? {}).sort()).toEqual(['chat_id', 'text']);
    expect(JSON.stringify(calls[0]?.json)).not.toMatch(/allow_paid_broadcast|parse_mode/);
  });

  it('refuses before any call: no token, a comment thread, a bad chat id, an empty or too long text', async () => {
    const { calls, fetchImpl } = bot([]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    expect(await adapter.reply(reply({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_NO_TOKEN' });
    expect(await adapter.reply(reply({ kind: 'comment_thread' }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_DIRECT_ONLY' });
    expect(await adapter.reply(reply({ threadId: 'abc' }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_BAD_CHAT' });
    expect(await adapter.reply(reply({ text: '' }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_TEXT_LENGTH' });
    expect(await adapter.reply(reply({ text: 'a'.repeat(4097) }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_TEXT_LENGTH' });
    expect(calls).toHaveLength(0);
  });

  it('maps a blocked bot to permission, a 429 to rate_limited with the time Telegram says, and a wrong token to token_expired', async () => {
    const { fetchImpl } = bot([fail(403, 'Forbidden: bot was blocked by the user'), fail(429, 'Too Many Requests: retry after 7', { parameters: { retry_after: 7 } }), fail(401, 'Unauthorized'), fail(400, 'Bad Request: chat not found'), fail(403, 'Forbidden: user is deactivated')]);
    const adapter = new TelegramConversations({ fetch: fetchImpl, sleep: async () => undefined });
    expect(await adapter.reply(reply({ threadId: '1' }))).toEqual({ kind: 'rejected', error: 'permission', code: 'TELEGRAM_BOT_BLOCKED' });
    const limited = await adapter.reply(reply({ threadId: '2' }));
    expect(limited).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'TELEGRAM_429' });
    expect((limited as { retryAt?: Date }).retryAt).toBeInstanceOf(Date);
    expect(await adapter.reply(reply({ threadId: '3' }))).toEqual({ kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_TOKEN_REFUSED' });
    expect(await adapter.reply(reply({ threadId: '4' }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_CHAT_NOT_FOUND' });
    expect(await adapter.reply(reply({ threadId: '5' }))).toEqual({ kind: 'rejected', error: 'permission', code: 'TELEGRAM_USER_GONE' });
  });

  it('leaves an unclear answer to a person: a server error, a dropped connection, or an answer with no message id is unknown', async () => {
    const { fetchImpl } = bot([fail(502, 'Bad Gateway'), new Error('socket hang up'), ok({})]);
    const adapter = new TelegramConversations({ fetch: fetchImpl, sleep: async () => undefined });
    expect(await adapter.reply(reply({ threadId: '1' }))).toEqual({ kind: 'unknown', code: 'TELEGRAM_502' });
    expect(await adapter.reply(reply({ threadId: '2' }))).toEqual({ kind: 'unknown', code: 'NETWORK' });
    expect(await adapter.reply(reply({ threadId: '3' }))).toEqual({ kind: 'unknown', code: 'TELEGRAM_NO_MESSAGE_ID' });
  });

  it('paces two messages to one chat about a second apart, and does not delay another chat', async () => {
    const { fetchImpl } = bot([ok({ message_id: 1 }), ok({ message_id: 2 }), ok({ message_id: 3 })]);
    let now = 1_000_000;
    const slept: number[] = [];
    const adapter = new TelegramConversations({ fetch: fetchImpl, now: () => now, sleep: async (ms) => void slept.push(ms) });
    await adapter.reply(reply({ threadId: '10' }));
    now += 300;
    await adapter.reply(reply({ threadId: '10' }));
    await adapter.reply(reply({ threadId: '11' }));
    expect(slept).toEqual([700]);
  });
});

describe('turning the webhook on and off', () => {
  const secretToken = telegramHookSecret(KEY, newTelegramHookId());

  it('sets the webhook with the secret and only the updates the slice reads, and returns nothing of either', async () => {
    const { calls, fetchImpl } = bot([ok(true)]);
    const url = 'https://ludy.example.com/api/channels/telegram/webhook/x';
    const result = await setTelegramWebhook(TOKEN, { url, secretToken }, fetchImpl);
    expect(result).toEqual({ kind: 'done' });
    expect(calls[0]).toMatchObject({ method: 'setWebhook', token: TOKEN, json: { url, secret_token: secretToken, allowed_updates: [...TELEGRAM_CHAT_UPDATES] } });
    expect(JSON.stringify(result)).not.toContain(secretToken);
  });

  it('says why it failed in a code and whether asking again may help, and never puts the token, the url or the secret in it', async () => {
    const { fetchImpl } = bot([fail(400, 'Bad Request: bad webhook: HTTPS url must be provided for webhook'), fail(401, 'Unauthorized'), fail(429, 'Too Many Requests', { parameters: { retry_after: 3 } }), fail(502, 'Bad Gateway'), new Error('offline')]);
    const set = () => setTelegramWebhook(TOKEN, { url: 'http://x.test/h', secretToken }, fetchImpl);
    const results = [await set(), await set(), await set(), await set(), await set()];
    expect(results).toEqual([
      { kind: 'failed', retry: false, code: 'TELEGRAM_WEBHOOK_REFUSED' },
      { kind: 'failed', retry: false, code: 'TELEGRAM_TOKEN_REFUSED' },
      { kind: 'failed', retry: true, code: 'TELEGRAM_429' },
      { kind: 'failed', retry: true, code: 'TELEGRAM_502' },
      { kind: 'failed', retry: true, code: 'NETWORK' },
    ]);
    for (const text of results.map((r) => JSON.stringify(r))) expect(text).not.toMatch(/AAH|secret|http/);
  });

  it('deletes the webhook with no arguments', async () => {
    const { calls, fetchImpl } = bot([ok(true), fail(401, 'Unauthorized')]);
    expect(await deleteTelegramWebhook(TOKEN, fetchImpl)).toEqual({ kind: 'done' });
    expect(calls[0]).toMatchObject({ method: 'deleteWebhook', token: TOKEN, json: {} });
    expect(await deleteTelegramWebhook(TOKEN, fetchImpl)).toEqual({ kind: 'failed', retry: false, code: 'TELEGRAM_TOKEN_REFUSED' });
  });

  it('is built from random ids: two hooks never collide in a thousand draws', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newTelegramHookId()));
    expect(ids.size).toBe(1000);
  });
});
