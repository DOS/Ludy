// SPDX-License-Identifier: AGPL-3.0-only
// Telegram bot chats as the conversation core takes them (issue #3132, plan docs/plan/conversations-channels.md section 4.2): the
// secret a webhook is checked by, the events of a private-chat message, the reply through `sendMessage`, and the two calls that turn
// the webhook on and off. Written from the Bot API as the plan records it: the shapes of bot chats are [M] there and the Business mode ones
// (#3191) were read on the official page [O], and a real bot settles every [live] row by docs/runbooks/telegram-conversations-live-check.md. Each
// shape is read in one place, so a correction is one line.
//
// The webhook cannot name the bot an update is for, so the route is `/api/channels/telegram/webhook/<hook>`: <hook> is an opaque id the
// connection holds, and the `secret_token` Telegram echoes in X-Telegram-Bot-Api-Secret-Token is not stored anywhere but derived from the
// hook under a key of the deployment (telegramHookSecret), so the route can check it before it reads the body or asks the database.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConversationNoticeError, type ConversationAdapter, type ConversationBusinessState, type ConversationCallResult, type ConversationChatHookInput, type ConversationChatHookResult, type ConversationMediaInput, type ConversationMediaResult, type ConversationNotice, type ConversationReplyInput, type InboundConversationEvent } from './conversation.ts';
import { TELEGRAM_HOSTS, TELEGRAM_TEXT_MAX, TelegramClient, TelegramError, telegramSecretOf } from './telegram.ts';
import { mediaHostAllowed } from './zalo-conversation.ts';
import { allowlistedFetch, type Fetch } from './oauth.ts';

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

// Customers' photos (#3192). A message's `photo` lists the sizes of one photo (`PhotoSize`: file_id, file_unique_id, width, height, file_size?) [O]; the
// largest one that fits the cap is the image, named by its `file_id` (a reference, not an address and not the bot's token). The bytes are fetched by the media job
// through `getFile` and `https://api.telegram.org/file/bot<token>/<file_path>` [O], a host that is the Bot API's own: the job's guard lists it and nothing else.
export const TELEGRAM_MEDIA_HOSTS: readonly string[] = Object.freeze([...TELEGRAM_HOSTS]);
// The cap of a stored image (`CONVERSATION_IMAGE_MAX_BYTES` of @crove/kernel-contract, which the kernel's media test holds this to: this package does not
// import the contract).
export const TELEGRAM_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
// A `file_id` is a base64url string of the bot's own [O: opaque]; the core's reference pattern takes `[A-Za-z0-9._:=-]{1,300}`, of which these are the ones a file id uses.
const FILE_ID = /^[A-Za-z0-9_-]{1,300}$/;
// A `file_path` as Telegram's own server gives it (`photos/file_12.jpg`): plain segments, never absolute (a self-hosted Bot API server answers with a local path),
// never `.` or `..`, so the address built from it cannot leave the bot's file path.
const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}){0,3}$/;
// A photo lists a handful of sizes (four or five in practice); more than this is no photo of Telegram's.
const PHOTO_SIZES_MAX = 20;

const TEXT_MAX = 20_000;
const NAME_MAX = 200;
const ID_MAX = 200;
// PostgreSQL refuses a NUL character in text, which would fail the whole notice.
const clean = (value: string): string => value.replaceAll('\u0000', '');
// Cut to a number of characters, not of UTF-16 units: a cut through a surrogate pair leaves a lone half, which a jsonb column refuses.
const cut = (value: string, max: number): string => (value.length <= max ? value : Array.from(value).slice(0, max).join(''));
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

// The name Telegram gives a person: first and last name, else the username. User-chosen text, so tainted like any other customer text.
function nameOf(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined;
  const text = (value: unknown): string => (typeof value === 'string' ? clean(value).trim() : '');
  const full = [text(user.first_name), text(user.last_name)].filter((part) => part !== '').join(' ');
  const name = full !== '' ? full : text(user.username);
  return name === '' ? undefined : cut(name, NAME_MAX);
}

// Telegram Business (#3191). A business chat is independent of a bot chat with the same id [O], so its thread is `b:<chat id>:<business connection id>`; a
// bot chat's thread stays the bare chat id. `message_id` is unique inside one chat only [O], so a message is `<thread id>:<message_id>` in both, and the id
// a reply is stored under (the adapter's `externalId`) is built the same way, which makes the echo of a reply the duplicate of the stored message.
const BUSINESS_ID = /^[!-~]{1,100}$/;
const BUSINESS_THREAD = /^b:(-?\d{1,20}):([!-~]{1,100})$/;
// A business chat can be answered for 24 hours after the customer's last message [O: BusinessBotRights.can_reply].
export const TELEGRAM_BUSINESS_WINDOW_HOURS = 24;
// A removal notice has no date of its own, so it is dated at the earliest instant an event may have: no later than an erased customer's erasure, so an
// erased customer is never brought back by a deletion notice (the core ignores what is dated at or before the erasure).
const REMOVED_AT = '2020-01-01T00:00:00.000Z';
// A deletion names up to this many messages (the core takes a thousand events a notice).
const DELETED_IDS_MAX = 1000;

const threadOf = (chatId: string, businessId: string | null): string => (businessId ? `b:${chatId}:${businessId}` : chatId);
const messageKey = (thread: string, messageId: string): string => `${thread}:${messageId}`;
const businessIdOf = (value: unknown): string | null => (typeof value === 'string' && BUSINESS_ID.test(value) ? value : null);

// The photo of a message as the image the core will fetch: the largest of its sizes (by pixels) whose declared size fits the cap, named by its `file_id`. None when
// there is no photo, or no size that reads as one (an id that is not a file id, a size without its pixels, every size over the cap): the message then keeps its
// placeholder line alone. At most one image, whatever the sizes: they are one photo.
function photoOf(m: TelegramMessage): Array<{ kind: 'image'; mediaRef: string }> {
  if (!Array.isArray(m.photo)) return [];
  let best: { id: string; pixels: number } | null = null;
  for (const size of m.photo.slice(0, PHOTO_SIZES_MAX)) {
    const s = objectOf(size);
    if (!s) continue;
    const id = typeof s.file_id === 'string' && FILE_ID.test(s.file_id) ? s.file_id : null;
    const width = typeof s.width === 'number' && Number.isSafeInteger(s.width) && s.width > 0 ? s.width : null;
    const height = typeof s.height === 'number' && Number.isSafeInteger(s.height) && s.height > 0 ? s.height : null;
    if (!id || !width || !height) continue;
    // A size whose declared weight is over the cap would only be refused at the fetch: the next one down is taken instead.
    if (typeof s.file_size === 'number' && s.file_size > TELEGRAM_PHOTO_MAX_BYTES) continue;
    if (best === null || width * height > best.pixels) best = { id, pixels: width * height };
  }
  return best ? [{ kind: 'image', mediaRef: best.id }] : [];
}

// What the message says: its words, with a placeholder naming an attachment the customer sent (or, for the account's own side, that was sent). A photo that is
// fetched as an image says its caption alone (as a WhatsApp image does): its words, or the placeholder when it has none; a fetch that fails leaves those words.
function bodyOf(m: TelegramMessage, own: boolean, withImage = false): string | null {
  const body = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  const cleaned = clean(body).slice(0, TEXT_MAX);
  const found = PLACEHOLDERS.find(([field]) => m[field] !== undefined && m[field] !== null)?.[1] ?? null;
  const placeholder = found !== null && own ? found.replace('Khách gửi', 'Đã gửi') : found;
  // A message with neither words nor a kind we know (a service message) says nothing.
  if (cleaned.trim() === '' && placeholder === null) return null;
  if (withImage && cleaned.trim() !== '') return cleaned;
  return cleaned.trim() === '' ? (placeholder as string) : placeholder !== null ? `${cleaned}\n${placeholder}`.slice(0, TEXT_MAX) : cleaned;
}

// One message of a private chat as an event. A bot chat (`businessId` null) counts only a person's message. A business chat's message is the
// customer's when it comes from the chat's own user (in a private chat the chat id is the other party's user id [live]); anything else is the account's
// own side (the owner typing in Telegram, the bot's reply echoed, an away message), which keeps the thread current and answers nothing.
function messageEvent(m: TelegramMessage, businessId: string | null, edited: boolean): InboundConversationEvent | null {
  const chatId = idText(m.chat?.id);
  const messageId = idText(m.message_id);
  const at = atOf(m.date);
  if (m.chat?.type !== 'private' || !chatId || !messageId || !at || chatId.length > ID_MAX) return null;
  const thread = threadOf(chatId, businessId);
  const fromId = idText(m.from?.id);
  if (fromId && fromId.length > ID_MAX) return null;
  if (businessId === null) {
    if (!fromId || m.from?.is_bot === true) return null;
    // A customer's photo is an image to fetch (an edit brings none: the message keeps the images of its first arrival, so an edit says its words the way the
    // first arrival did, with no placeholder line beside the image).
    const photo = photoOf(m);
    const images = edited ? [] : photo;
    const text = bodyOf(m, false, photo.length > 0);
    if (text === null) return null;
    const name = nameOf(m.from);
    return { kind: 'direct', threadId: thread, messageId: messageKey(thread, messageId), direction: 'in', contact: { id: fromId, ...(name ? { name } : {}) }, text, at, ...(images.length > 0 ? { attachments: images } : {}) };
  }
  const fromCustomer = fromId === chatId;
  // An account's own message edited is not news: the core changes only a stored customer body, so it would only create a message.
  if (edited && !fromCustomer) return null;
  if (fromCustomer && m.from?.is_bot === true) return null;
  // Only the customer's photos are fetched: what the account itself sent stays a placeholder line, and an edit brings no images.
  const photo = fromCustomer ? photoOf(m) : [];
  const images = edited ? [] : photo;
  const text = bodyOf(m, !fromCustomer, photo.length > 0);
  if (text === null) return null;
  // The customer is the chat's other party: `Chat.first_name`, `last_name` and `username` are theirs in a private chat [O].
  const name = nameOf(fromCustomer ? m.from : (m.chat as TelegramUser | undefined));
  return {
    kind: 'direct',
    threadId: thread,
    messageId: messageKey(thread, messageId),
    direction: fromCustomer ? 'in' : 'out',
    contact: { id: chatId, ...(name ? { name } : {}) },
    text,
    at,
    ...(edited ? { edited: true } : {}),
    ...(fromCustomer ? { replyWindowHours: TELEGRAM_BUSINESS_WINDOW_HOURS } : {}),
    ...(images.length > 0 ? { attachments: images } : {}),
  };
}

const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

// One update read once: its events and the business connection they came through (null for a bot chat's message), so the two can never disagree.
function scan(update: unknown): { events: InboundConversationEvent[]; via: string | null } {
  const none = { events: [], via: null };
  const u = objectOf(update);
  if (!u) return none;
  const one = (value: unknown, businessId: string | null, edited: boolean): InboundConversationEvent[] => {
    const m = objectOf(value);
    const event = m ? messageEvent(m as TelegramMessage, businessId, edited) : null;
    return event ? [event] : [];
  };
  const message = objectOf(u.message);
  // A bot chat's message names no business connection: one that does is not a bot chat's, and is not taken as one.
  if (message) return message.business_connection_id === undefined ? { events: one(message, null, false), via: null } : none;
  for (const [field, edited] of [['business_message', false], ['edited_business_message', true]] as const) {
    const m = objectOf(u[field]);
    const businessId = m ? businessIdOf(m.business_connection_id) : null;
    if (m && businessId) {
      const events = one(m, businessId, edited);
      return { events, via: events.length > 0 ? businessId : null };
    }
  }
  const deleted = objectOf(u.deleted_business_messages);
  const businessId = deleted ? businessIdOf(deleted.business_connection_id) : null;
  const chat = objectOf(deleted?.chat);
  const chatId = idText(chat?.id);
  if (!deleted || !businessId || !chat || chat.type !== 'private' || !chatId || chatId.length > ID_MAX || !Array.isArray(deleted.message_ids)) return none;
  const thread = threadOf(chatId, businessId);
  const events: InboundConversationEvent[] = [];
  for (const id of deleted.message_ids.slice(0, DELETED_IDS_MAX)) {
    const messageId = idText(id);
    if (messageId) events.push({ kind: 'direct', threadId: thread, messageId: messageKey(thread, messageId), direction: 'in', contact: { id: chatId }, text: '', at: REMOVED_AT, removed: true });
  }
  return { events, via: events.length > 0 ? businessId : null };
}

// The events of one update: a private chat's message, or with Business mode a message of a connected account's chat, its edit and its deletion. A group,
// a supergroup, a channel and every other kind of update (a callback, a member's change) give none, and a bot's own message in a bot chat none. Returns []
// for any of those, never throws.
export const telegramChatEvents = (update: unknown): InboundConversationEvent[] => scan(update).events;

// An account's name as the owner is shown it to decide whether to allow the account: the name is the account's own choice, so what could pass for the screen's
// own words is taken out: control, format (bidirectional and zero-width) and line characters, lone surrogates, and `@` (also its fullwidth and small forms), which
// would let a name wear a @username it does not have.
function accountNameOf(user: TelegramUser): string | undefined {
  const name = nameOf(user);
  if (!name) return undefined;
  const plain = cut(name.replace(/[\p{Zl}\p{Zp}\r\n\t]/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}@\uFF20\uFE6B]/gu, '').replace(/\s+/g, ' ').trim(), 100);
  return plain === '' ? undefined : plain;
}

// A `business_connection` update: the bot was connected to, edited on or disconnected from a business account. Anything that does not read as a
// whole connection (a missing id or user, `is_enabled` not true) is not state, and `is_enabled` missing means off, never on.
export function telegramBusinessState(update: unknown): ConversationBusinessState | null {
  const connection = objectOf(objectOf(update)?.business_connection);
  if (!connection) return null;
  const id = businessIdOf(connection.id);
  const user = objectOf(connection.user) as TelegramUser | null;
  const userId = idText(user?.id);
  if (!id || !user || !userId || userId.length > ID_MAX) return null;
  const rights = objectOf(connection.rights);
  const name = accountNameOf(user);
  const username = typeof user.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(user.username) ? user.username : null;
  return { id, userId, ...(name ? { name } : {}), ...(username ? { username } : {}), canReply: rights?.can_reply === true || connection.can_reply === true, enabled: connection.is_enabled === true };
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
  const { events, via } = scan(envelope.update);
  const state = telegramBusinessState(envelope.update);
  return { accountId: envelope.hook, events, ...(via ? { businessConnectionId: via } : {}), ...(state ? { businessState: state } : {}) };
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
    // A bot chat's thread is the chat id; a business chat's names the chat and the business connection the reply goes out through.
    const business = BUSINESS_THREAD.exec(input.threadId);
    const chatId = business ? (business[1] as string) : input.threadId;
    if (!business && !/^-?\d{1,20}$/.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_BAD_CHAT' };
    if (input.text.length === 0 || input.text.length > TELEGRAM_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_TEXT_LENGTH' };
    // Under about one message a second to one chat: wait out what is left of the second since the last one to this chat.
    const wait = (this.lastSent.get(input.threadId) ?? 0) + CHAT_GAP_MS - this.now();
    if (wait > 0) await this.sleep(Math.min(wait, CHAT_GAP_MS));
    this.lastSent.set(input.threadId, this.now());
    if (this.lastSent.size > 5000) this.lastSent.delete(this.lastSent.keys().next().value as string);
    try {
      const sent = await this.client.call<{ message_id?: unknown }>(s.botToken, 'sendMessage', { chat_id: chatId, text: input.text, ...(business ? { business_connection_id: business[2] } : {}) });
      const id = idText(sent?.message_id);
      return id ? { kind: 'accepted', externalId: messageKey(input.threadId, id) } : { kind: 'unknown', code: 'TELEGRAM_NO_MESSAGE_ID' };
    } catch (error) {
      return replyFailure(error);
    }
  }

  // The bytes of a customer's photo, by its file id (#3192), in the two calls the Bot API asks for [O]: `getFile` answers the file's path, and
  // `https://api.telegram.org/file/bot<token>/<file_path>` serves it. Both go through the caller's guarded fetch (public addresses only, the connection pinned to the
  // checked address, https, no redirect followed, a byte cap), and the bot's token is in those two paths and nowhere else: not in the result, not in a header, and not in
  // a failure, which is a short code and never Telegram's words or an address. The path Telegram answers is checked before an address is built from it, and a declared
  // size above the cap is refused before the second call.
  async media(input: ConversationMediaInput): Promise<ConversationMediaResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'failed', retry: false, code: 'NO_TELEGRAM_TOKEN' };
    if (!FILE_ID.test(input.mediaRef)) return { kind: 'failed', retry: false, code: 'BAD_MEDIA_REF' };
    // Before the token goes anywhere: the deployment's list must name the Bot API's host.
    if (!mediaHostAllowed(TELEGRAM_HOSTS[0], input.hosts)) return { kind: 'failed', retry: false, code: 'TG_MEDIA_HOST' };
    let located: { file_size?: unknown; file_path?: unknown } | null;
    try {
      located = await new TelegramClient(input.fetch, 15_000).call<{ file_size?: unknown; file_path?: unknown } | null>(s.botToken, 'getFile', { file_id: input.mediaRef });
    } catch (error) {
      if (error instanceof TelegramError) {
        // The token was refused, or the file id is unknown or past its life: asking again will not change it. A busy Telegram may.
        if (error.status === 401 || error.status === 404) return { kind: 'failed', retry: false, code: 'TELEGRAM_TOKEN_REFUSED' };
        // A 400 is "wrong file_id or the file is temporarily unavailable" [M] (one text for both: not asked for again), or a file over what a bot may download.
        if (error.status === 400) return { kind: 'failed', retry: false, code: /too big/i.test(error.message) ? 'BAD_SIZE' : 'TG_MEDIA_GONE' };
        return { kind: 'failed', retry: error.status === 429 || error.status >= 500, code: error.status === 429 || error.status >= 500 ? 'TG_MEDIA_BUSY' : `TG_MEDIA_${error.status}` };
      }
      return { kind: 'failed', retry: transientEgress(error), code: 'TG_MEDIA_ERROR' };
    }
    const size = typeof located?.file_size === 'number' ? located.file_size : null;
    if (size !== null && size > input.maxBytes) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
    // A file with no path (one over what a bot may download) or a path that is not plain segments is no file to fetch.
    const path = typeof located?.file_path === 'string' ? located.file_path : '';
    if (!FILE_PATH.test(path)) return { kind: 'failed', retry: false, code: 'TG_MEDIA_PATH' };
    let response: Response;
    try {
      // The same check as the Bot API calls get: the Bot API's host only, https, no redirect asked for, a deadline.
      response = await allowlistedFetch(TELEGRAM_HOSTS, input.fetch, 20_000)(`https://${TELEGRAM_HOSTS[0]}/file/bot${s.botToken}/${path}`, { method: 'GET' });
    } catch (error) {
      return { kind: 'failed', retry: transientEgress(error), code: 'TG_MEDIA_FETCH' };
    }
    if (response.status === 429 || response.status >= 500) return { kind: 'failed', retry: true, code: `HTTP_${response.status}` };
    if (response.status !== 200) return { kind: 'failed', retry: false, code: `HTTP_${response.status}` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
    return { kind: 'ok', bytes };
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

// Whether asking again may bring the file: a name that did not resolve, a timeout and a dropped connection may; an error with no code says nothing, so it is asked
// again (up to the row's five tries).
function transientEgress(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === 'dns' || code === 'timeout' || code === 'network';
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
  // A business connection that is gone, disabled or without the right to send is refused as a permission (the account took the bot's access away) [live].
  if (error.status === 400 && /business/i.test(description)) return { kind: 'rejected', error: 'permission', code: 'TELEGRAM_BUSINESS_REFUSED' };
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

// The updates a bot asks for: private-chat messages, and the four of Business mode (#3191), which only arrive once an owner has connected the bot to their
// account in Telegram. `allowed_updates` not specified would keep the previous setting [O], so every call lists them.
export const TELEGRAM_CHAT_UPDATES: readonly string[] = ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'];

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
