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
  telegramBusinessState,
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
      // A message id is unique inside one chat only [O], so the stored id names the chat.
      { kind: 'direct', threadId: '111', messageId: '111:5', direction: 'in', contact: { id: '111', name: 'An Nguyễn' }, text: 'Shop còn hàng không?', at: new Date(DATE * 1000).toISOString() },
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
    expect(await adapter.reply(reply())).toEqual({ kind: 'accepted', externalId: '111:42' });
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

  it('turns chats on through the adapter: the address and the secret are built from the hook and the key, and nothing of them comes back', async () => {
    const { calls, fetchImpl } = bot([ok(true), ok(true)]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    const hook = newTelegramHookId();
    const input = { secret: SECRET, on: true, hook, baseUrl: 'https://ludy.example.com/', key: KEY, takenBotIds: ['999'] };
    const on = await adapter.chatHook(input);
    expect(on).toEqual({ kind: 'done', botId: '123456789' });
    expect(calls[0]).toMatchObject({ method: 'setWebhook', token: TOKEN, json: { url: `https://ludy.example.com/api/channels/telegram/webhook/${hook}`, secret_token: telegramHookSecret(KEY, hook), allowed_updates: [...TELEGRAM_CHAT_UPDATES] } });
    expect(JSON.stringify(on)).not.toMatch(new RegExp(`${hook}|${telegramHookSecret(KEY, hook)}`));
    const off = await adapter.chatHook({ ...input, on: false });
    expect(off).toEqual({ kind: 'done', botId: '123456789' });
    expect(calls[1]).toMatchObject({ method: 'deleteWebhook', json: {} });
  });

  it('refuses chats on before any call: the same bot already answers, a plain-http address, no key, no token', async () => {
    const { calls, fetchImpl } = bot([]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    const base = { secret: SECRET, on: true, hook: newTelegramHookId(), baseUrl: 'https://ludy.example.com', key: KEY, takenBotIds: [] as string[] };
    expect(await adapter.chatHook({ ...base, takenBotIds: ['123456789'] })).toEqual({ kind: 'failed', retry: false, code: 'BOT_IN_USE' });
    expect(await adapter.chatHook({ ...base, baseUrl: 'http://localhost:8080' })).toEqual({ kind: 'failed', retry: false, code: 'WEBHOOK_NEEDS_HTTPS' });
    expect(await adapter.chatHook({ ...base, key: null })).toEqual({ kind: 'failed', retry: false, code: 'NO_HOOK_KEY' });
    expect(await adapter.chatHook({ ...base, secret: '{}' })).toEqual({ kind: 'failed', retry: false, code: 'TELEGRAM_NO_TOKEN' });
    expect(calls).toHaveLength(0);
  });

  it('is built from random ids: two hooks never collide in a thousand draws', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newTelegramHookId()));
    expect(ids.size).toBe(1000);
  });
});

// Telegram Business mode (#3191): the shapes are the official page's (BusinessConnection, Message.business_connection_id, BusinessMessagesDeleted [O]); which
// side wrote a message is [live].
const CONN = 'AbC_dEf-123=';
const OWNER = 900;
const businessMessage = (over: Record<string, unknown> = {}, from: Record<string, unknown> = {}, field = 'business_message') => ({
  update_id: 7,
  [field]: {
    message_id: 8,
    business_connection_id: CONN,
    from: { id: 111, is_bot: false, first_name: 'An', last_name: 'Nguyễn', ...from },
    chat: { id: 111, first_name: 'An', last_name: 'Nguyễn', type: 'private' },
    date: DATE,
    text: 'Cho mình hỏi giá áo này',
    ...over,
  },
});
const AT = new Date(DATE * 1000).toISOString();

describe('the events of a business update', () => {
  it('reads a customer message of a business chat: its own thread beside the bot chat of the same id, a message id that names the chat, and a 24-hour window', () => {
    expect(telegramChatEvents(businessMessage())).toEqual([
      { kind: 'direct', threadId: `b:111:${CONN}`, messageId: `b:111:${CONN}:8`, direction: 'in', contact: { id: '111', name: 'An Nguyễn' }, text: 'Cho mình hỏi giá áo này', at: AT, replyWindowHours: 24 },
    ]);
    // The same chat id and message id in a bot chat is another thread and another message.
    const bot = telegramChatEvents(message({ message_id: 8 }))[0];
    expect(bot?.threadId).toBe('111');
    expect(bot?.messageId).toBe('111:8');
  });

  it('reads the account\'s own message as an outgoing one in the customer\'s thread, named by the chat\'s other party, with no reply window', () => {
    const own = businessMessage({ text: 'Dạ còn ạ' }, { id: OWNER, first_name: 'Chủ shop' });
    expect(telegramChatEvents(own)).toEqual([
      { kind: 'direct', threadId: `b:111:${CONN}`, messageId: `b:111:${CONN}:8`, direction: 'out', contact: { id: '111', name: 'An Nguyễn' }, text: 'Dạ còn ạ', at: AT },
    ]);
    // The bot's own reply sent for the account is the same: an echo of a message already stored, by its id.
    expect(telegramChatEvents(businessMessage({ text: 'Dạ còn ạ' }, { id: 4242, is_bot: true, first_name: 'Quán Phở bot' }))[0]).toMatchObject({ direction: 'out', messageId: `b:111:${CONN}:8` });
    // An attachment the account sent is named as sent, not as the customer's.
    expect(telegramChatEvents(businessMessage({ text: undefined, photo: [{ file_id: 'x' }] }, { id: OWNER }))[0]?.text).toBe('[Đã gửi ảnh]');
    expect(telegramChatEvents(businessMessage({ text: undefined, photo: [{ file_id: 'x' }] }))[0]?.text).toBe('[Khách gửi ảnh]');
  });

  it('reads an edit of a customer message as an edit, and ignores an edit of the account\'s own message', () => {
    expect(telegramChatEvents(businessMessage({ text: 'Giá áo này bao nhiêu' }, {}, 'edited_business_message'))).toEqual([
      { kind: 'direct', threadId: `b:111:${CONN}`, messageId: `b:111:${CONN}:8`, direction: 'in', contact: { id: '111', name: 'An Nguyễn' }, text: 'Giá áo này bao nhiêu', at: AT, edited: true, replyWindowHours: 24 },
    ]);
    expect(telegramChatEvents(businessMessage({}, { id: OWNER }, 'edited_business_message'))).toEqual([]);
  });

  it('reads deleted messages as removals, one for each id, dated so that an erased customer is not brought back', () => {
    const update = { update_id: 9, deleted_business_messages: { business_connection_id: CONN, chat: { id: 111, type: 'private', first_name: 'An' }, message_ids: [8, 9] } };
    expect(telegramChatEvents(update)).toEqual([
      { kind: 'direct', threadId: `b:111:${CONN}`, messageId: `b:111:${CONN}:8`, direction: 'in', contact: { id: '111' }, text: '', at: '2020-01-01T00:00:00.000Z', removed: true },
      { kind: 'direct', threadId: `b:111:${CONN}`, messageId: `b:111:${CONN}:9`, direction: 'in', contact: { id: '111' }, text: '', at: '2020-01-01T00:00:00.000Z', removed: true },
    ]);
  });

  it('gives nothing for a business message with no or a bad business connection id, a group, a bot customer, a service message or a bad deletion', () => {
    expect(telegramChatEvents(businessMessage({ business_connection_id: undefined }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({ business_connection_id: 'has space' }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({ business_connection_id: 'x'.repeat(101) }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({ chat: { id: -100123, type: 'supergroup' } }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({}, { is_bot: true }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({ text: undefined, new_chat_members: [] }))).toEqual([]);
    expect(telegramChatEvents(businessMessage({ date: 3600 }))).toEqual([]);
    const gone = (over: Record<string, unknown>) => ({ update_id: 9, deleted_business_messages: { business_connection_id: CONN, chat: { id: 111, type: 'private' }, message_ids: [8], ...over } });
    expect(telegramChatEvents(gone({ business_connection_id: undefined }))).toEqual([]);
    expect(telegramChatEvents(gone({ chat: { id: -1, type: 'group' } }))).toEqual([]);
    expect(telegramChatEvents(gone({ message_ids: 'x' }))).toEqual([]);
    expect(telegramChatEvents(gone({ message_ids: [] }))).toEqual([]);
    // At most a thousand ids of one deletion are read (the core takes a thousand events a notice).
    expect(telegramChatEvents(gone({ message_ids: Array.from({ length: 150 }, (_, i) => i + 1) }))).toHaveLength(150);
    expect(telegramChatEvents(gone({ message_ids: Array.from({ length: 1500 }, (_, i) => i + 1) }))).toHaveLength(1000);
    // A message of a bot chat that names a business connection is not a bot chat's message.
    expect(telegramChatEvents(message({ business_connection_id: CONN }))).toEqual([]);
  });
});

describe('the business connection of an update is read with its events', () => {
  const hook = newTelegramHookId();
  const parse = (update: unknown) => parseTelegramChatNotice(wrapTelegramChatNotice(hook, Buffer.from(JSON.stringify(update), 'utf8')));

  it('names the connection of the events it gives, and none when it gives none', () => {
    expect(parse(businessMessage()).businessConnectionId).toBe(CONN);
    // An update with two business fields: the one with a good id is the one read, for the events and for the connection alike.
    const inner = (over: Record<string, unknown> = {}) => (businessMessage(over) as unknown as { business_message: Record<string, unknown> }).business_message;
    const mixed = { update_id: 12, business_message: { ...inner(), business_connection_id: 'has space' }, edited_business_message: { ...inner({ text: 'Đã sửa' }), business_connection_id: CONN } };
    const notice = parse(mixed);
    expect(notice.events.map((e) => e.text)).toEqual(['Đã sửa']);
    expect(notice.businessConnectionId).toBe(CONN);
    // An own-side edit gives no event, so no connection is named for it.
    expect(parse(businessMessage({}, { id: OWNER }, 'edited_business_message'))).toEqual({ accountId: hook, events: [] });
  });
});

describe('the state of a business connection', () => {
  const connection = (over: Record<string, unknown> = {}) => ({
    update_id: 11,
    business_connection: { id: CONN, user: { id: OWNER, first_name: 'Lan', last_name: 'Trần' }, user_chat_id: OWNER, date: DATE, rights: { can_reply: true }, is_enabled: true, ...over },
  });

  it('reads a connection: the account, whether it is on and whether the bot may reply', () => {
    expect(telegramBusinessState(connection())).toEqual({ id: CONN, userId: String(OWNER), name: 'Lan Trần', canReply: true, enabled: true });
    expect(telegramBusinessState(connection({ rights: {}, is_enabled: false }))).toEqual({ id: CONN, userId: String(OWNER), name: 'Lan Trần', canReply: false, enabled: false });
    // No `is_enabled` means off, never on; no rights means the bot may not reply.
    expect(telegramBusinessState(connection({ is_enabled: undefined, rights: undefined }))).toMatchObject({ enabled: false, canReply: false });
  });

  it('is nothing for an update that is no whole connection', () => {
    expect(telegramBusinessState(connection({ id: undefined }))).toBeNull();
    expect(telegramBusinessState(connection({ id: 'has space' }))).toBeNull();
    expect(telegramBusinessState(connection({ user: undefined }))).toBeNull();
    expect(telegramBusinessState(connection({ user: { id: 'x' } }))).toBeNull();
    expect(telegramBusinessState(message())).toBeNull();
    expect(telegramBusinessState(null)).toBeNull();
    expect(telegramChatEvents(connection())).toEqual([]);
  });

  it('shows an account by its @username and takes out of its name what could pass for the screen\'s own words: control, bidirectional and zero-width characters, line breaks and @', () => {
    const named = (first: string, over: Record<string, unknown> = {}) => telegramBusinessState(connection({ user: { id: OWNER, first_name: first, ...over } }));
    expect(named('Lan', { username: 'lan_tran' })).toMatchObject({ name: 'Lan', username: 'lan_tran' });
    // A stranger with no @username who writes one into the name: the @ goes, and so does the line break that would start a line of its own.
    expect(named('Lan Trần (@lan_tran)')?.name).toBe('Lan Trần (lan_tran)');
    expect(named('Lan\u202eTrần\u200b\nCho phép\u0000')?.name).toBe('LanTrần Cho phép');
    expect(named('@@@')?.name).toBeUndefined();
    expect(named('x'.repeat(300))?.name).toHaveLength(100);
    // A @username that is not a username (spaces, a length over 64) is not kept.
    expect(named('Lan', { username: 'has space' })).not.toHaveProperty('username');
    expect(named('Lan', { username: 'a'.repeat(65) })).not.toHaveProperty('username');
  });

  it('is carried by the notice beside the business connection of the events, and a bot chat\'s message carries neither', () => {
    const hook = newTelegramHookId();
    const parse = (update: unknown) => parseTelegramChatNotice(wrapTelegramChatNotice(hook, Buffer.from(JSON.stringify(update), 'utf8')));
    expect(parse(connection())).toEqual({ accountId: hook, events: [], businessState: { id: CONN, userId: String(OWNER), name: 'Lan Trần', canReply: true, enabled: true } });
    const business = parse(businessMessage());
    expect(business.businessConnectionId).toBe(CONN);
    expect(business.events).toHaveLength(1);
    expect(business).not.toHaveProperty('businessState');
    expect(parse({ update_id: 3, deleted_business_messages: { business_connection_id: CONN, chat: { id: 111, type: 'private' }, message_ids: [1] } }).businessConnectionId).toBe(CONN);
    expect(parse(message())).toEqual({ accountId: hook, events: expect.any(Array) });
    expect(parse(message())).not.toHaveProperty('businessConnectionId');
  });
});

describe('a reply in a business chat', () => {
  const thread = `b:111:${CONN}`;

  it('sends with the business connection id to the customer\'s chat, and names the message as the thread and its id', async () => {
    const { calls, fetchImpl } = bot([ok({ message_id: 77 })]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    expect(await adapter.reply(reply({ threadId: thread }))).toEqual({ kind: 'accepted', externalId: `${thread}:77` });
    expect(calls[0]).toMatchObject({ method: 'sendMessage', token: TOKEN, json: { chat_id: '111', business_connection_id: CONN, text: 'Dạ còn ạ, anh chị cần size nào?' } });
    expect(Object.keys(calls[0]?.json ?? {}).sort()).toEqual(['business_connection_id', 'chat_id', 'text']);
    expect(JSON.stringify(calls[0]?.json)).not.toMatch(/allow_paid_broadcast|parse_mode/);
  });

  it('makes the echo of the reply the same message id as the one stored from the call', async () => {
    const { fetchImpl } = bot([ok({ message_id: 8 })]);
    const adapter = new TelegramConversations({ fetch: fetchImpl });
    const sent = await adapter.reply(reply({ threadId: thread }));
    const echo = telegramChatEvents(businessMessage({ text: 'Dạ còn ạ, anh chị cần size nào?' }, { id: 4242, is_bot: true }))[0];
    expect(sent).toMatchObject({ kind: 'accepted', externalId: echo?.messageId });
  });

  it('keeps a business chat and a bot chat of the same id apart in the pacing, and refuses a thread it cannot read', async () => {
    const { calls, fetchImpl } = bot([ok({ message_id: 1 }), ok({ message_id: 2 })]);
    const slept: number[] = [];
    const adapter = new TelegramConversations({ fetch: fetchImpl, now: () => 1_000_000, sleep: async (ms) => void slept.push(ms) });
    await adapter.reply(reply({ threadId: thread }));
    await adapter.reply(reply({ threadId: '111' }));
    expect(slept).toEqual([]);
    expect(calls[1]?.json).not.toHaveProperty('business_connection_id');
    for (const bad of ['b:abc:x', 'b:111:', 'b:111:has space', `b:111:${'x'.repeat(101)}`, 'c:111:x']) {
      expect(await adapter.reply(reply({ threadId: bad }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_BAD_CHAT' });
    }
    expect(calls).toHaveLength(2);
  });

  it('maps a refused business connection to permission', async () => {
    const { fetchImpl } = bot([fail(400, 'Bad Request: BUSINESS_CONNECTION_INVALID'), fail(403, 'Forbidden: bot was blocked by the user')]);
    const adapter = new TelegramConversations({ fetch: fetchImpl, sleep: async () => undefined });
    expect(await adapter.reply(reply({ threadId: thread }))).toEqual({ kind: 'rejected', error: 'permission', code: 'TELEGRAM_BUSINESS_REFUSED' });
    expect(await adapter.reply(reply({ threadId: `b:112:${CONN}` }))).toMatchObject({ kind: 'rejected', error: 'permission', code: 'TELEGRAM_BOT_BLOCKED' });
  });
});

describe('what the webhook asks Telegram for', () => {
  it('lists the bot chat update and the four of Business mode, so none is left to the previous setting', () => {
    expect([...TELEGRAM_CHAT_UPDATES]).toEqual(['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']);
  });
});
