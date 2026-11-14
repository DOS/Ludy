// SPDX-License-Identifier: AGPL-3.0-only
// Telegram bot chats as the conversation core takes them (issue #3132, plan docs/plan/conversations-channels.md section 4.2): the
// secret a webhook is checked by, the events of a private-chat message, the reply through `sendMessage`, and the two calls that turn
// the webhook on and off. Written from the Bot API as the plan records it; the official pages could not be read when this was built, so
// every shape below is [M] or [S] in the plan and is settled on a real bot by docs/runbooks/telegram-conversations-live-check.md. Each
// shape is read in one place, so a correction is one line.
//
// The webhook cannot name the bot an update is for, so the route is `/api/channels/telegram/webhook/<hook>`: <hook> is an opaque id the
// connection holds, and the `secret_token` Telegram echoes in X-Telegram-Bot-Api-Secret-Token is not stored anywhere but derived from the
// hook under a key of the deployment (telegramHookSecret), so the route can check it before it reads the body or asks the database.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConversationNoticeError, type ConversationAdapter, type ConversationCallResult, type ConversationChatHookInput, type ConversationChatHookResult, type ConversationNotice, type ConversationReplyInput, type InboundConversationEvent } from './conversation.ts';
import { TELEGRAM_TEXT_MAX, TelegramClient, TelegramError, telegramSecretOf } from './telegram.ts';
import type { Fetch } from './oauth.ts';

// The most a notice may weigh: one update is a few hundred bytes (a photo lists its sizes), so a body past this is no update of Telegram's.
export const TELEGRAM_MAX_NOTICE_BYTES = 64 * 1024;

// The purpose string the broker derives the webhook key from (HKDF-SHA256 of the credential key): one key for this purpose and no other.
export const TELEGRAM_HOOK_KEY_INFO = 'crove.telegram.chat-hook.v1';
// A hook id: 32 random bytes, base64url, so 43 characters of [A-Za-z0-9_-].
export const TELEGRAM_HOOK_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEADER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newTelegramHookId(): string {
  return randomBytes(32).toString('base64url');
}

// The `secret_token` of a hook: HMAC-SHA256 of the hook id under the deployment's derived key, base64url, 43 characters (inside Telegram's
// `[A-Za-z0-9_-]{1,256}`). Nothing is stored: the worker computes it to set the webhook and the route computes it to check a request.
export function telegramHookSecret(key: Buffer, hook: string): string {
  return createHmac('sha256', key).update(`telegram.chat_hook:${hook}`).digest('base64url');
}

// Whether a request carries the secret of its hook, under the current key or one it replaces. Constant time: the header is compared by digest, every
// key is always tried, and a malformed hook or header gives the same `false` as a wrong one. It never says why.
export function telegramHookSecretOk(input: { hook: string; header: string | undefined; keys: readonly Buffer[] }): boolean {
  const shaped = TELEGRAM_HOOK_PATTERN.test(input.hook) && typeof input.header === 'string' && HEADER_PATTERN.test(input.header);
  const given = createHash('sha256').update(shaped ? (input.header as string) : '').digest();
  let ok = false;
  for (const key of input.keys) {
    const expected = createHash('sha256').update(telegramHookSecret(key, shaped ? input.hook : '')).digest();
    ok = timingSafeEqual(given, expected) || ok;
  }
  return shaped && ok;
}

// The bot id is the number before the colon of the token: public, and what tells two connections of one bot apart from two bots.
export function telegramBotId(botToken: string): string {
  return botToken.split(':')[0] ?? '';
}

// The envelope the route parks after the secret check: the hook the request came on, and the update as Telegram sent it.
export function wrapTelegramChatNotice(hook: string, update: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`{"v":1,"hook":"${hook}","update":`, 'utf8'), Buffer.from(update), Buffer.from('}', 'utf8')]);
}

// What a customer's attachment is called in the thread: the placeholder naming its kind. The file itself is never in the text.
const PLACEHOLDERS: ReadonlyArray<readonly [string, string]> = [
  ['photo', '[Khách gửi ảnh]'],
  ['sticker', '[Khách gửi nhãn dán]'],
  ['animation', '[Khách gửi ảnh động]'],
  ['voice', '[Khách gửi tin nhắn thoại]'],
  ['audio', '[Khách gửi âm thanh]'],
  ['video', '[Khách gửi video]'],
  ['video_note', '[Khách gửi video]'],
  ['document', '[Khách gửi tệp]'],
  ['location', '[Khách gửi vị trí]'],
  ['venue', '[Khách gửi vị trí]'],
  ['contact', '[Khách gửi danh bạ]'],
  ['poll', '[Khách gửi một cuộc khảo sát]'],
  ['dice', '[Khách gửi một biểu tượng]'],
];

const TEXT_MAX = 20_000;
const NAME_MAX = 200;
const ID_MAX = 200;
// PostgreSQL refuses a NUL character in text, which would fail the whole notice.
const clean = (value: string): string => value.replaceAll('\u0000', '');
const idText = (value: unknown): string | null => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null);

// Telegram dates a message in seconds since 1970. Outside a sane range it is no event (a customer's message must not close its own window by
// being dated in 1970).
function atOf(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const ms = value * 1000;
  return ms >= Date.UTC(2020, 0, 1) && ms <= Date.now() + 86_400_000 ? new Date(ms).toISOString() : null;
}

interface TelegramUser {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
}
interface TelegramMessage {
  message_id?: unknown;
  from?: TelegramUser;
  chat?: { id?: unknown; type?: unknown };
  date?: unknown;
  text?: unknown;
  caption?: unknown;
  [field: string]: unknown;
}

// The name Telegram gives a person: first and last name, else the username. User-chosen text, so tainted like any customer text.
function nameOf(user: TelegramUser): string | undefined {
  const text = (value: unknown): string => (typeof value === 'string' ? clean(value).trim() : '');
  const full = [text(user.first_name), text(user.last_name)].filter((part) => part !== '').join(' ');
  const name = full !== '' ? full : text(user.username);
  return name === '' ? undefined : name.slice(0, NAME_MAX);
}

// The events of one update. Only a private chat's message counts: a group, a supergroup, a channel and every other kind of update (an edit, a
// callback, a member's change) give none, and so does a message of a bot. Returns [] for any of those, never throws.
export function telegramChatEvents(update: unknown): InboundConversationEvent[] {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) return [];
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return [];
  const m = message as TelegramMessage;
  const chatId = idText(m.chat?.id);
  const userId = idText(m.from?.id);
  const messageId = idText(m.message_id);
  const at = atOf(m.date);
  if (m.chat?.type !== 'private' || !chatId || !userId || !messageId || !at || m.from?.is_bot === true) return [];
  if (chatId.length > ID_MAX || userId.length > ID_MAX) return [];
  const body = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  const cleaned = clean(body).slice(0, TEXT_MAX);
  const placeholder = PLACEHOLDERS.find(([field]) => m[field] !== undefined && m[field] !== null)?.[1] ?? null;
  // A message with neither words nor a kind we know (a service message) is not a customer's message.
  const hasAttachment = placeholder !== null;
  if (cleaned.trim() === '' && !hasAttachment) return [];
  const text = cleaned.trim() === '' ? (placeholder as string) : hasAttachment ? `${cleaned}\n${placeholder}`.slice(0, TEXT_MAX) : cleaned;
  const name = nameOf(m.from as TelegramUser);
  return [{ kind: 'direct', threadId: chatId, messageId, direction: 'in', contact: { id: userId, ...(name ? { name } : {}) }, text, at }];
}

// The notice the route parked: its hook is the account id, which the worker maps to a connection (ADR-0039: it names no org). Malformed JSON, a
// wrong envelope or a hook of another shape is an error; a well-formed update that is no customer message gives no event.
export function parseTelegramChatNotice(body: Uint8Array): ConversationNotice {
  if (body.byteLength === 0 || body.byteLength > TELEGRAM_MAX_NOTICE_BYTES + 128) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  const envelope = parsed as { v?: unknown; hook?: unknown; update?: unknown } | null;
  if (typeof envelope !== 'object' || envelope === null || envelope.v !== 1 || typeof envelope.hook !== 'string' || !TELEGRAM_HOOK_PATTERN.test(envelope.hook)) {
    throw new ConversationNoticeError('malformed');
  }
  return { accountId: envelope.hook, events: telegramChatEvents(envelope.update) };
}

// One message a second to one chat is Telegram's own pace [O]; a reply is a person's, so this only shows when two go out in a row.
const CHAT_GAP_MS = 1000;

export interface TelegramConversationsOptions {
  fetch?: Fetch | undefined;
  // Tests only.
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

// A reply to a customer who wrote to the bot, through `sendMessage` [M]: the chat id is the thread, the text is plain (no parse mode, so
// nothing in it is markup) and never asks for a paid broadcast. The call has no idempotency key, so it is made once: an unclear answer is
// `unknown` and waits for a person. A refusal of a blocked bot is `permission`; a 429 is `rate_limited` with the time Telegram says.
export class TelegramConversations implements ConversationAdapter {
  readonly provider = 'telegram' as const;
  private readonly client: TelegramClient;
  private readonly fetchImpl: Fetch | undefined;
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TelegramConversationsOptions = {}) {
    this.client = new TelegramClient(options.fetch, 15_000);
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_NO_TOKEN' };
    if (input.kind !== 'direct') return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_DIRECT_ONLY' };
    if (!/^-?\d{1,20}$/.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_BAD_CHAT' };
    if (input.text.length === 0 || input.text.length > TELEGRAM_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_TEXT_LENGTH' };
    // Under about one message a second to one chat: wait out what is left of the second since the last one to this chat.
    const wait = (this.lastSent.get(input.threadId) ?? 0) + CHAT_GAP_MS - this.now();
    if (wait > 0) await this.sleep(Math.min(wait, CHAT_GAP_MS));
    this.lastSent.set(input.threadId, this.now());
    if (this.lastSent.size > 5000) this.lastSent.delete(this.lastSent.keys().next().value as string);
    try {
      const sent = await this.client.call<{ message_id?: unknown }>(s.botToken, 'sendMessage', { chat_id: input.threadId, text: input.text });
      const id = idText(sent?.message_id);
      return id ? { kind: 'accepted', externalId: id } : { kind: 'unknown', code: 'TELEGRAM_NO_MESSAGE_ID' };
    } catch (error) {
      return replyFailure(error);
    }
  }

  // Points the bot's webhook at the connection's hook, or takes it away. On: refused before any call when another connection of the org holds the
  // same bot, when the deployment's address is not https (Telegram only takes https) or when there is no key to derive the secret from.
  async chatHook(input: ConversationChatHookInput): Promise<ConversationChatHookResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'failed', retry: false, code: 'TELEGRAM_NO_TOKEN' };
    const botId = telegramBotId(s.botToken);
    if (!input.on) {
      const deleted = await deleteTelegramWebhook(s.botToken, this.fetchImpl);
      return deleted.kind === 'done' ? { kind: 'done', botId } : deleted;
    }
    if (input.takenBotIds.includes(botId)) return { kind: 'failed', retry: false, code: 'BOT_IN_USE' };
    if (!input.baseUrl.startsWith('https://')) return { kind: 'failed', retry: false, code: 'WEBHOOK_NEEDS_HTTPS' };
    if (!input.key) return { kind: 'failed', retry: false, code: 'NO_HOOK_KEY' };
    // The trailing slashes of the address are cut by hand (a pattern on an address a deployment sets would be a polynomial regular expression).
    let end = input.baseUrl.length;
    while (end > 0 && input.baseUrl.charCodeAt(end - 1) === 47) end--;
    const url = `${input.baseUrl.slice(0, end)}/api/channels/telegram/webhook/${input.hook}`;
    const set = await setTelegramWebhook(s.botToken, { url, secretToken: telegramHookSecret(input.key, input.hook) }, this.fetchImpl);
    return set.kind === 'done' ? { kind: 'done', botId } : set;
  }
}

function replyFailure(error: unknown): ConversationCallResult {
  // Not an answer of Telegram's (a timeout, a dropped connection): the message may or may not have gone out.
  if (!(error instanceof TelegramError)) return { kind: 'unknown', code: 'NETWORK' };
  const description = error.message;
  if (error.status === 429) {
    return { kind: 'rejected', error: 'rate_limited', code: 'TELEGRAM_429', ...(error.retryAfter ? { retryAt: new Date(Date.now() + error.retryAfter * 1000) } : {}) };
  }
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_TOKEN_REFUSED' };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', code: /blocked/i.test(description) ? 'TELEGRAM_BOT_BLOCKED' : /deactivated/i.test(description) ? 'TELEGRAM_USER_GONE' : 'TELEGRAM_403' };
  if (error.status === 400) return { kind: 'rejected', error: 'bad_request', code: /chat not found/i.test(description) ? 'TELEGRAM_CHAT_NOT_FOUND' : 'TELEGRAM_400' };
  // A server error may or may not have sent it: Telegram cannot be asked.
  return { kind: 'unknown', code: `TELEGRAM_${error.status}` };
}

export type TelegramHookResult = { kind: 'done' } | { kind: 'failed'; retry: boolean; code: string };

function hookFailure(error: unknown): TelegramHookResult {
  if (error instanceof TelegramError) {
    if (error.status === 401 || error.status === 404) return { kind: 'failed', retry: false, code: 'TELEGRAM_TOKEN_REFUSED' };
    if (error.status === 400) return { kind: 'failed', retry: false, code: 'TELEGRAM_WEBHOOK_REFUSED' };
    if (error.status === 429) return { kind: 'failed', retry: true, code: 'TELEGRAM_429' };
    return { kind: 'failed', retry: true, code: `TELEGRAM_${error.status}` };
  }
  return { kind: 'failed', retry: true, code: 'NETWORK' };
}

// The updates a bot asks for: private-chat messages only in v1 (the Business mode slice adds its own).
export const TELEGRAM_CHAT_UPDATES: readonly string[] = ['message'];

// Points the bot's webhook at the connection's hook, with the secret Telegram will echo. The token is in the call's path, as the API takes it,
// and the url and the secret are never logged or returned. `url` must be https on a port Telegram allows [M]; a 400 means it refused the address.
export async function setTelegramWebhook(botToken: string, hook: { url: string; secretToken: string }, fetchImpl?: Fetch): Promise<TelegramHookResult> {
  try {
    await new TelegramClient(fetchImpl, 15_000).call<boolean>(botToken, 'setWebhook', { url: hook.url, secret_token: hook.secretToken, allowed_updates: TELEGRAM_CHAT_UPDATES });
    return { kind: 'done' };
  } catch (error) {
    return hookFailure(error);
  }
}

// Takes the webhook off: the bot sends nothing to Ludy afterwards. Idempotent at Telegram's end (no webhook set is still `true`).
export async function deleteTelegramWebhook(botToken: string, fetchImpl?: Fetch): Promise<TelegramHookResult> {
  try {
    await new TelegramClient(fetchImpl, 15_000).call<boolean>(botToken, 'deleteWebhook', {});
    return { kind: 'done' };
  } catch (error) {
    return hookFailure(error);
  }
}
