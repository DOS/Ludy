// SPDX-License-Identifier: AGPL-3.0-only
// Zalo OA's webhook as the conversation core takes it (issue #2304, plan docs/plan/conversations.md section 6.5): the signature of
// a notice and the events it carries. Nothing here was read from a live OA yet: every shape below is from secondary sources and is
// marked [S] or [U] in the plan, to be confirmed on a real event by the live-check runbook
// (docs/runbooks/zalo-conversations-live-check.md). The code reads each of them in one place, so a correction is one line.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ConversationNoticeError, type ConversationNotice, type InboundConversationEvent } from './conversation.ts';

// The most a notice may weigh: Zalo sends one event per request, and an event is a few hundred bytes.
export const ZALO_MAX_NOTICE_BYTES = 64 * 1024;

// X-ZEvent-Signature: `mac=<hex>` [S]. The hex is sha256(appId + body + timestamp + oaSecretKey) [S, U until tested on a real event:
// sources disagree on the order of the middle inputs]. `body` is the raw bytes as Zalo sent them, `timestamp` the one in the body.
const MAC_HEADER = /^mac=([0-9a-f]{64})$/i;
const TIMESTAMP_IN_BODY = /"timestamp"\s*:\s*"?(\d{1,20})"?/;

export interface ZaloSignatureInput {
  body: Uint8Array;
  // The value of X-ZEvent-Signature, or undefined when the header is missing.
  header: string | undefined;
  appId: string;
  // The OA secret key of the Zalo app: a credential, never logged, stored or put in an answer.
  oaSecretKey: string;
  // The key it replaces, while a rotation is under way: a notice signed with either is Zalo's.
  oaSecretKeyPrevious?: string | undefined;
}

// Whether the notice is Zalo's. Decides nothing but yes or no, in constant time for the comparison, and never says why it is no.
export function zaloSignatureOk(input: ZaloSignatureInput): boolean {
  const mac = input.header ? MAC_HEADER.exec(input.header.trim()) : null;
  if (!mac || !input.appId || !input.oaSecretKey) return false;
  const text = Buffer.from(input.body).toString('utf8');
  const timestamp = TIMESTAMP_IN_BODY.exec(text)?.[1];
  if (!timestamp) return false;
  const given = Buffer.from(mac[1] as string, 'hex');
  const matches = (key: string): boolean => {
    const expected = createHash('sha256').update(input.appId + text + timestamp + key).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  // Both are always computed, so the time taken says nothing of which key (if any) matched.
  const current = matches(input.oaSecretKey);
  const previous = input.oaSecretKeyPrevious ? matches(input.oaSecretKeyPrevious) : false;
  return current || previous;
}

// What a customer's attachment is called in the thread: v1 stores text only, so an attachment is a placeholder naming its kind, with no
// address (a media address is personal data and expires after seven days [S]).
const CUSTOMER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  // A text message with no text (#2348): not an attachment, so it is not called one.
  user_send_text: '[Khách gửi tin nhắn trống]',
  user_send_image: '[Khách gửi ảnh]',
  user_send_file: '[Khách gửi tệp]',
  user_send_sticker: '[Khách gửi nhãn dán]',
  user_send_gif: '[Khách gửi ảnh động]',
  user_send_location: '[Khách gửi vị trí]',
  user_send_link: '[Khách gửi liên kết]',
  user_send_audio: '[Khách gửi tin nhắn thoại]',
  user_send_video: '[Khách gửi video]',
};
const OA_PLACEHOLDER = '[Trang đã gửi một tệp đính kèm]';

interface ZaloEvent {
  event_name?: unknown;
  timestamp?: unknown;
  sender?: { id?: unknown };
  recipient?: { id?: unknown };
  message?: { msg_id?: unknown; text?: unknown };
}

// An id is a string, or a whole number a double holds exactly: a larger one was rounded by JSON.parse and would match no connection.
const idOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null);
// The most a message, an id or a name holds in the core's schema; text over it is cut, an id over it is no event.
const TEXT_MAX = 20_000;
const ID_MAX = 200;
// PostgreSQL refuses a NUL character in text, which would fail the whole notice.
const clean = (value: string): string => value.replaceAll('\u0000', '');
// Zalo's timestamps are milliseconds [S]; a value of seconds is read as such, so a customer's message is not dated in 1970 (which would
// close its reply window at once). Outside a sane range it is no event.
function atOf(value: unknown): string | null {
  let ms = Number(idOf(value));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1e11) ms *= 1000;
  const date = new Date(ms);
  return ms >= Date.UTC(2020, 0, 1) && ms <= Date.now() + 86_400_000 && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

// The notice's events in the core's words. Events that are not a message (follow, unfollow, delivered, seen) give none: nothing to
// store, and the route answers 200 so Zalo stops sending it. Malformed JSON is an error. A message without its id is dropped (the id is
// what a replay is told by). The OA id is the account the worker finds the connections by; the user id is the thread's.
export function parseZaloNotice(body: Uint8Array): ConversationNotice {
  if (body.byteLength === 0 || body.byteLength > ZALO_MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationNoticeError('malformed');
  const e = parsed as ZaloEvent;
  const name = typeof e.event_name === 'string' ? e.event_name : '';
  const fromCustomer = name.startsWith('user_send_');
  const fromOa = name.startsWith('oa_send_');
  if (!fromCustomer && !fromOa) return { accountId: idOf(e.recipient?.id) ?? '', events: [] };
  const oa = idOf(fromCustomer ? e.recipient?.id : e.sender?.id);
  const customer = idOf(fromCustomer ? e.sender?.id : e.recipient?.id);
  const messageId = idOf(e.message?.msg_id);
  const at = atOf(e.timestamp);
  if (!oa || !customer || !messageId || !at || customer.length > ID_MAX || messageId.length > 300 || oa.length > ID_MAX) return { accountId: oa ?? '', events: [] };
  const cleaned = typeof e.message?.text === 'string' ? clean(e.message.text).slice(0, TEXT_MAX) : '';
  const text = cleaned !== '' ? cleaned : null;
  // An attachment's own name, kept beside its caption when it has one.
  const placeholder = fromCustomer ? (CUSTOMER_PLACEHOLDERS[name] ?? '[Khách gửi một tệp đính kèm]') : OA_PLACEHOLDER;
  const attachment = name !== 'user_send_text' && name !== 'oa_send_text';
  const event: InboundConversationEvent = {
    kind: 'direct',
    threadId: customer,
    messageId,
    direction: fromCustomer ? 'in' : 'out',
    contact: { id: customer },
    text: text === null ? placeholder : attachment ? `${text}\n${placeholder}`.slice(0, TEXT_MAX) : text,
    at,
  };
  return { accountId: oa, events: [event] };
}
