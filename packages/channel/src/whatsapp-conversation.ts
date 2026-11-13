// SPDX-License-Identifier: AGPL-3.0-only
// WhatsApp Business (Cloud API) conversations in the conversation core (issue #3131, plan docs/plan/conversations-channels.md section 4.1): the
// webhook's `whatsapp_business_account` notice turned into core events, a reply (`POST /{phone-number-id}/messages`), and the two calls that turn a media
// id into bytes. Nothing here was read from a live account or from the platform's official pages (the pages could not be reached when this was written):
// every shape and error code below is [S] or [M] in the plan, to be settled by the live-check runbook docs/runbooks/whatsapp-conversations-live-check.md.
// Each is read in one place, so a correction is one line.
//
// The webhook signature is Meta's X-Hub-Signature-256 over the raw bytes, the same check as Messenger's (`metaSignatureOk`), with the secret of the
// WhatsApp product's own Meta app. The connection is made by hand (a system user token, the phone number id and the WABA id, sealed); its
// `external_account_id` is the phone number id, which is what a notice names in `metadata.phone_number_id`.
import {
  ConversationNoticeError,
  type ConversationAdapter,
  type ConversationCallResult,
  type ConversationMediaInput,
  type ConversationMediaResult,
  type ConversationNotice,
  type ConversationReplyInput,
  type InboundConversationEvent,
} from './conversation.ts';
import type { ConnectedAccount } from './index.ts';
import { FACEBOOK_MAX_NOTICE_BYTES, FACEBOOK_SIGNATURE_HEADER } from './meta-conversation.ts';
import { Graph, GraphError, graphPublishResult } from './meta.ts';
import { ConnectorError, type Fetch } from './oauth.ts';
import { mediaHostAllowed } from './zalo-conversation.ts';

// The same cap and header as Meta's other webhooks: the check of the signature is one HMAC over at most this much.
export const WHATSAPP_MAX_NOTICE_BYTES = FACEBOOK_MAX_NOTICE_BYTES;
export const WHATSAPP_SIGNATURE_HEADER = FACEBOOK_SIGNATURE_HEADER;
// The webhook's `object` for the WhatsApp Business Account product [S].
export const WHATSAPP_WEBHOOK_OBJECT = 'whatsapp_business_account';
export const WHATSAPP_TEXT_MAX = 4096;
// A free-form reply is allowed for 24 hours after the customer's last message [S, live]; CONVERSATION_PROVIDER_RULES.whatsapp holds the same number for the
// screen and the command, and the adapter checks it again so a stale call never reaches Meta.
const WINDOW_MS = 24 * 3_600_000;
// The hosts Meta serves a customer's media from [M, live: row "image within the URL's life" of the runbook]: a suffix of a host name, matched on a label boundary.
// The fetch job sends the connection's token only to one of these (or of the deployment's own list, CHANNEL_WHATSAPP_MEDIA_HOSTS), and never follows a redirect.
export const WHATSAPP_MEDIA_HOSTS: readonly string[] = ['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com'];

const PHONE_NUMBER_ID = /^\d{5,32}$/;
const WABA_ID = /^\d{5,32}$/;
// A customer's WhatsApp id [M]: the phone number in digits (`wa_id`). If Meta later gives another identifier, the identity keeps whatever the webhook gives and
// the phone match finds nothing; a reply goes only to a digits id.
const CUSTOMER_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const SENDABLE_ID = /^\d{5,20}$/;
const MEDIA_ID = /^\d{1,32}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{20,600}$/;
const TEXT_MAX = 20_000;
const MESSAGE_ID_MAX = 300;
const NAME_MAX = 200;
const IMAGES_MAX = 5;
const clean = (value: string): string => value.replaceAll('\u0000', '');

// What a customer's non-text message is called in the thread: the placeholder naming its kind. An image is also fetched and shown (by its media id) when the
// fetch succeeds; the placeholder stays when it does not. A caption is kept in place of the placeholder.
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  image: '[Khách gửi ảnh]',
  audio: '[Khách gửi tin nhắn thoại]',
  video: '[Khách gửi video]',
  document: '[Khách gửi tệp]',
  sticker: '[Khách gửi nhãn dán]',
  location: '[Khách gửi vị trí]',
  contacts: '[Khách gửi danh thiếp]',
  order: '[Khách gửi đơn hàng]',
};
const UNSUPPORTED_PLACEHOLDER = '[Khách gửi tin nhắn đính kèm]';

interface WaMedia {
  id?: unknown;
  caption?: unknown;
}
interface WaMessage {
  id?: unknown;
  from?: unknown;
  timestamp?: unknown;
  type?: unknown;
  text?: { body?: unknown } | null;
  image?: WaMedia | null;
  video?: WaMedia | null;
  document?: WaMedia | null;
  button?: { text?: unknown } | null;
  interactive?: { button_reply?: { title?: unknown } | null; list_reply?: { title?: unknown } | null } | null;
}
interface WaStatus {
  id?: unknown;
  status?: unknown;
  timestamp?: unknown;
  recipient_id?: unknown;
  errors?: Array<{ code?: unknown }> | null;
}
interface WaValue {
  metadata?: { phone_number_id?: unknown } | null;
  contacts?: Array<{ wa_id?: unknown; profile?: { name?: unknown } | null }> | null;
  messages?: WaMessage[] | null;
  statuses?: WaStatus[] | null;
}
interface WaPayload {
  object?: unknown;
  entry?: Array<{ id?: unknown; changes?: Array<{ field?: unknown; value?: WaValue | null }> | null }> | null;
}

// Digits and letters of an id, or null. Numbers a double holds exactly are taken as their digits.
const idOf = (value: unknown, pattern: RegExp): string | null => {
  const text = typeof value === 'string' ? clean(value).trim() : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return pattern.test(text) ? text : null;
};

// The platform's time, in seconds (a string) [M]; a value in milliseconds is read as such. Outside a sane range it is no event: not dated in 1970 (which would close
// its reply window at once), and not ahead of this clock by more than a few minutes (a message dated a day ahead would stretch the 24-hour window to two days).
const CLOCK_SKEW_MS = 10 * 60_000;
function atOf(value: unknown, now: number): string | null {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return ms >= Date.UTC(2020, 0, 1) && ms <= now + CLOCK_SKEW_MS ? new Date(ms).toISOString() : null;
}

const captionOf = (media: WaMedia | null | undefined): string => (typeof media?.caption === 'string' ? clean(media.caption).trim().slice(0, TEXT_MAX) : '');

function textOf(message: WaMessage): { text: string; images: Array<{ kind: 'image'; mediaRef: string }> } | null {
  const type = typeof message.type === 'string' ? message.type : '';
  switch (type) {
    case 'text': {
      const body = typeof message.text?.body === 'string' ? clean(message.text.body).slice(0, TEXT_MAX) : '';
      return { text: body.trim() === '' ? '[Khách gửi tin nhắn trống]' : body, images: [] };
    }
    case 'image': {
      const id = idOf(message.image?.id, MEDIA_ID);
      const caption = captionOf(message.image);
      return { text: caption !== '' ? caption : (PLACEHOLDERS.image as string), images: id ? [{ kind: 'image', mediaRef: id }] : [] };
    }
    case 'video':
    case 'document': {
      const caption = captionOf(type === 'video' ? message.video : message.document);
      return { text: caption !== '' ? `${caption}\n${PLACEHOLDERS[type] as string}`.slice(0, TEXT_MAX) : (PLACEHOLDERS[type] as string), images: [] };
    }
    case 'audio':
    case 'sticker':
    case 'location':
    case 'contacts':
    case 'order':
      return { text: PLACEHOLDERS[type] as string, images: [] };
    case 'button': {
      const title = typeof message.button?.text === 'string' ? clean(message.button.text).trim().slice(0, TEXT_MAX) : '';
      return { text: title !== '' ? title : UNSUPPORTED_PLACEHOLDER, images: [] };
    }
    case 'interactive': {
      const reply = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
      const title = typeof reply === 'string' ? clean(reply).trim().slice(0, TEXT_MAX) : '';
      return { text: title !== '' ? title : UNSUPPORTED_PLACEHOLDER, images: [] };
    }
    // A reaction opens nothing (the customer reacted to a message), and a system notice (a changed number) is not a message.
    case 'reaction':
    case 'system':
      return null;
    default:
      return { text: UNSUPPORTED_PLACEHOLDER, images: [] };
  }
}

// The notice's events in the core's words, one notice for each phone number the batch names. `object` other than the WhatsApp one is no notice of ours:
// no events. A customer's message is an `in` event under their id; a status `failed` is an `out` event that only marks the message it names; `sent`,
// `delivered` and `read` are answered and stored nowhere. Malformed JSON, or a body with no `entry`, is an error.
export function parseWhatsAppNotices(body: Uint8Array, now: number = Date.now()): ConversationNotice[] {
  if (body.byteLength === 0 || body.byteLength > WHATSAPP_MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationNoticeError('malformed');
  const payload = parsed as WaPayload;
  if (typeof payload.object !== 'string' || !Array.isArray(payload.entry)) throw new ConversationNoticeError('malformed');
  if (payload.object !== WHATSAPP_WEBHOOK_OBJECT) return [];
  const byAccount = new Map<string, InboundConversationEvent[]>();
  for (const entry of payload.entry) {
    if (!entry || typeof entry !== 'object') continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!change || typeof change !== 'object' || change.field !== 'messages') continue;
      const value = change.value;
      if (!value || typeof value !== 'object') continue;
      const phoneNumberId = idOf(value.metadata?.phone_number_id, PHONE_NUMBER_ID);
      if (!phoneNumberId) continue;
      const list = byAccount.get(phoneNumberId) ?? [];
      // The customer is their `wa_id` [M: contacts[].wa_id], with the name they gave [M: contacts[].profile.name]. `messages[].from` is the same number in most
      // cases and not in all (Meta writes some countries' numbers differently there): when a notice names one sender and one contact, the contact's wa_id is the
      // customer's id, which is also the id a reply is sent to; with several, a message is matched to the contact whose wa_id is its `from`.
      const contacts: Array<{ id: string; name: string }> = [];
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const id = idOf(contact?.wa_id, CUSTOMER_ID);
        if (id) contacts.push({ id, name: typeof contact?.profile?.name === 'string' ? clean(contact.profile.name).trim().slice(0, NAME_MAX) : '' });
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const senders = new Set(messages.map((m) => idOf(m?.from, CUSTOMER_ID)).filter((id): id is string => id !== null));
      const [onlySender] = senders;
      const onlyContact = contacts.length === 1 && senders.size === 1 ? (contacts[0] as { id: string; name: string }) : null;
      const names = new Map(contacts.filter((c) => c.name !== '').map((c) => [c.id, c.name]));
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const from = idOf(message.from, CUSTOMER_ID);
        const customer = from !== null && from === onlySender && onlyContact ? onlyContact.id : from;
        const messageId = idOf(message.id, /^[A-Za-z0-9._=+/-]{1,300}$/);
        const at = atOf(message.timestamp, now);
        // The customer is never the business's own number: a message "from" the account is not a customer's.
        if (!customer || !messageId || !at || customer === phoneNumberId || messageId.length > MESSAGE_ID_MAX) continue;
        const content = textOf(message);
        if (!content) continue;
        const name = names.get(customer);
        list.push({
          kind: 'direct',
          threadId: customer,
          messageId,
          direction: 'in',
          contact: { id: customer, ...(name ? { name } : {}) },
          text: content.text,
          at,
          ...(content.images.length > 0 ? { attachments: content.images.slice(0, IMAGES_MAX) } : {}),
        });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!status || typeof status !== 'object' || status.status !== 'failed') continue;
        const customer = idOf(status.recipient_id, CUSTOMER_ID);
        const messageId = idOf(status.id, /^[A-Za-z0-9._=+/-]{1,300}$/);
        const at = atOf(status.timestamp, now);
        if (!customer || !messageId || !at) continue;
        const code = status.errors?.[0]?.code;
        list.push({
          kind: 'direct',
          threadId: customer,
          messageId,
          direction: 'out',
          contact: { id: customer },
          text: '',
          at,
          deliveryFailed: { code: typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? `WA_${code}` : 'WA_FAILED' },
        });
      }
      byAccount.set(phoneNumberId, list);
    }
  }
  return [...byAccount.entries()]
    .map(([accountId, events]) => ({ accountId, events: events.map((event, i) => ({ event, i })).sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || a.i - b.i).map((x) => x.event) }));
}

// The sealed credential of a connection: the system user token and the WABA id [M].
export interface WhatsAppSecret {
  accessToken: string;
  wabaId: string;
}
export function whatsappSecretOf(secret: string): WhatsAppSecret | null {
  try {
    const parsed = JSON.parse(secret) as { accessToken?: unknown; wabaId?: unknown };
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return null;
    return { accessToken: parsed.accessToken, wabaId: typeof parsed.wabaId === 'string' ? parsed.wabaId : '' };
  } catch {
    return null;
  }
}

// The connect form's fields, checked before any call (a typo costs no try).
export function whatsappLogin(input: { accessToken: string; phoneNumberId: string; wabaId: string }): { accessToken: string; phoneNumberId: string; wabaId: string } {
  const accessToken = input.accessToken.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  const wabaId = input.wabaId.trim();
  if (!ACCESS_TOKEN.test(accessToken)) throw new ConnectorError('denied', 'not a WhatsApp access token', 'WHATSAPP_TOKEN_INVALID');
  if (!PHONE_NUMBER_ID.test(phoneNumberId)) throw new ConnectorError('denied', 'not a phone number id', 'WHATSAPP_PHONE_ID_INVALID');
  if (!WABA_ID.test(wabaId)) throw new ConnectorError('denied', 'not a WhatsApp Business Account id', 'WHATSAPP_WABA_ID_INVALID');
  return { accessToken, phoneNumberId, wabaId };
}

// Checks the token once against the phone number (`GET /{phone-number-id}?fields=verified_name,display_phone_number` [M]) and builds the account the kernel
// seals. The token is never logged, stored or put in an answer here. The connection's id is the phone number id.
export async function connectWhatsApp(
  login: { accessToken: string; phoneNumberId: string; wabaId: string },
  app: { appSecret: string; graphVersion?: string | undefined },
  fetchImpl?: Fetch,
): Promise<ConnectedAccount> {
  const graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
  let answer: { verified_name?: unknown; display_phone_number?: unknown };
  try {
    answer = await graph.call('GET', login.phoneNumberId, { token: login.accessToken, params: { fields: 'verified_name,display_phone_number' } });
  } catch (error) {
    if (error instanceof GraphError) {
      if (error.status === 401 || error.code === 190) throw new ConnectorError('denied', 'WhatsApp refused the token', 'WHATSAPP_TOKEN_REFUSED');
      if (error.status === 403 || error.code === 10 || (error.code !== undefined && error.code >= 200 && error.code <= 299)) throw new ConnectorError('denied', 'the token may not read this phone number', 'WHATSAPP_PERMISSION');
      if (error.status === 400 || error.status === 404) throw new ConnectorError('denied', 'WhatsApp does not know this phone number id for the token', 'WHATSAPP_PHONE_NOT_FOUND');
    }
    throw new ConnectorError('provider', 'WhatsApp did not answer');
  }
  const verified = typeof answer.verified_name === 'string' ? clean(answer.verified_name).trim() : '';
  const number = typeof answer.display_phone_number === 'string' ? clean(answer.display_phone_number).trim() : '';
  const displayName = (verified !== '' ? verified : number !== '' ? number : 'WhatsApp').slice(0, NAME_MAX);
  const secret: WhatsAppSecret = { accessToken: login.accessToken, wabaId: login.wabaId };
  return { provider: 'whatsapp', externalAccountId: login.phoneNumberId, displayName, scopes: ['whatsapp_business_messaging'], expiresAt: null, secret: JSON.stringify(secret) };
}

// Meta's error codes for a send [M, live: the runbook's "131047 after 24 hours" row and the sandbox rows settle them]. A code not listed here goes through the
// generic Graph mapping (a token refusal, a rate limit, an unclear 5xx).
const WINDOW_CLOSED = 131047;
const UNDELIVERABLE = 131026;
const NOT_ALLOWED_RECIPIENT = 131030;
const RATE_LIMITED = new Set([130429, 131048, 131056, 133016]);
const PERMISSION = new Set([131005, 131031, 131037, 133010]);

function sendError(error: unknown): ConversationCallResult {
  if (error instanceof GraphError) {
    const code = error.code;
    if (code === WINDOW_CLOSED) return { kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' };
    if (code === UNDELIVERABLE) return { kind: 'rejected', error: 'bad_request', code: 'WA_UNDELIVERABLE' };
    if (code === NOT_ALLOWED_RECIPIENT) return { kind: 'rejected', error: 'bad_request', code: 'WA_RECIPIENT_NOT_ALLOWED' };
    if (code !== undefined && RATE_LIMITED.has(code)) return { kind: 'rejected', error: 'rate_limited', code: `WA_${code}` };
    if (code !== undefined && PERMISSION.has(code)) return { kind: 'rejected', error: 'permission', code: `WA_${code}` };
  }
  const res = graphPublishResult(error);
  if (res.kind === 'rejected') return { kind: 'rejected', error: res.error, ...(res.code ? { code: res.code } : {}), ...(res.retryAt ? { retryAt: res.retryAt } : {}) };
  // An unclear answer stays unclear: the send call has no idempotency key and no history can be read back, so it is never sent again blindly.
  return { kind: 'unknown', ...(res.kind === 'unknown' && res.code ? { code: res.code } : {}) };
}

// An egress refusal or a network failure of the bytes call: worth asking again when it may be temporary.
function transientEgress(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === 'dns' || code === 'timeout' || code === 'network';
}

export class WhatsAppConversations implements ConversationAdapter {
  readonly provider = 'whatsapp' as const;
  private readonly graph: Graph;

  constructor(graph: Graph) {
    this.graph = graph;
  }

  // A free-form text reply to a customer who wrote within the last 24 hours. A reply past the window is refused here (`WA_WINDOW_CLOSED`) without a call:
  // Ludy sends no template and no business-initiated message. Never retried after an unclear answer.
  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    const secret = whatsappSecretOf(input.secret);
    if (!secret) return { kind: 'rejected', error: 'token_expired', code: 'NO_WHATSAPP_TOKEN' };
    if (!PHONE_NUMBER_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PHONE_NUMBER_ID' };
    if (input.kind !== 'direct') return { kind: 'rejected', error: 'bad_request', code: 'WA_NOT_DIRECT' };
    if (input.text.trim().length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    if (input.text.length > WHATSAPP_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'WA_TEXT_LENGTH' };
    if (!SENDABLE_ID.test(input.threadId)) return { kind: 'rejected', error: 'bad_request', code: 'WA_BAD_RECIPIENT' };
    // Closed unless the customer's last message is known and within 24 hours: with no date the window cannot be shown open, and a free-form send outside it is
    // what Meta refuses (131047) and the business must never be billed for.
    const inboundMs = typeof input.lastInboundAt === 'string' ? Date.parse(input.lastInboundAt) : NaN;
    if (!Number.isFinite(inboundMs) || Date.now() - inboundMs > WINDOW_MS) return { kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' };
    try {
      const answer = await this.graph.call<{ messages?: Array<{ id?: unknown }> }>('POST', `${input.externalAccountId}/messages`, {
        token: secret.accessToken,
        json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: input.threadId, type: 'text', text: { preview_url: false, body: input.text } },
      });
      const id = answer.messages?.[0]?.id;
      if (typeof id !== 'string' || id === '' || id.length > MESSAGE_ID_MAX) return { kind: 'unknown', code: 'WA_NO_MESSAGE_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      return sendError(error);
    }
  }

  // The bytes of a customer's image, by its media id, in the two calls Meta asks for [O]: the media id answers a short-lived address (`GET /{media-id}`),
  // and the address is fetched with the same token. The address and the token live in this call only. The address must be https on one of `hosts`, the bytes
  // call goes through the caller's guarded fetch (which follows no redirect), and a declared size above the cap is refused before it.
  async media(input: ConversationMediaInput): Promise<ConversationMediaResult> {
    const secret = whatsappSecretOf(input.secret);
    if (!secret) return { kind: 'failed', retry: false, code: 'NO_WHATSAPP_TOKEN' };
    if (!MEDIA_ID.test(input.mediaRef)) return { kind: 'failed', retry: false, code: 'BAD_MEDIA_REF' };
    let located: { url?: unknown; file_size?: unknown };
    try {
      located = await this.graph.call('GET', input.mediaRef, { token: secret.accessToken });
    } catch (error) {
      const res = graphPublishResult(error);
      if (res.kind === 'rejected' && (res.error === 'token_expired' || res.error === 'permission')) return { kind: 'failed', retry: false, code: `WA_MEDIA_${res.error.toUpperCase()}` };
      // The id is unknown or past its life (the id is downloadable for 7 days [O]): asking again will not bring it back.
      if (res.kind === 'rejected' && res.error === 'bad_request') return { kind: 'failed', retry: false, code: 'WA_MEDIA_GONE' };
      return { kind: 'failed', retry: true, code: res.kind === 'rejected' ? 'WA_MEDIA_BUSY' : 'WA_MEDIA_ERROR' };
    }
    const size = typeof located.file_size === 'number' ? located.file_size : typeof located.file_size === 'string' && /^\d{1,12}$/.test(located.file_size) ? Number(located.file_size) : null;
    if (size !== null && size > input.maxBytes) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
    const raw = typeof located.url === 'string' ? located.url : '';
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: 'failed', retry: false, code: 'WA_MEDIA_URL' };
    }
    // Before the token goes anywhere: https, no credentials in the address, and a host of the list.
    if (raw.length > 2000 || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !mediaHostAllowed(url.hostname, input.hosts)) return { kind: 'failed', retry: false, code: 'WA_MEDIA_HOST' };
    let response: Response;
    try {
      response = await input.fetch(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${secret.accessToken}` } });
    } catch (error) {
      return { kind: 'failed', retry: transientEgress(error), code: 'WA_MEDIA_FETCH' };
    }
    if (response.status === 429 || response.status >= 500) return { kind: 'failed', retry: true, code: `HTTP_${response.status}` };
    if (response.status !== 200) return { kind: 'failed', retry: false, code: `HTTP_${response.status}` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) return { kind: 'failed', retry: false, code: 'BAD_SIZE' };
    return { kind: 'ok', bytes };
  }
}
