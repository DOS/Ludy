// SPDX-License-Identifier: AGPL-3.0-only
// WhatsApp Business (Cloud API) conversations (issue #3131, plan docs/plan/conversations-channels.md section 4.1): the notice parser, the signature check it
// shares with Messenger, the connect check, the reply and the media id's two calls. Every payload is written from the plan's [S] and [M] facts (no official page
// could be read when it was built), so these tests pin what the code reads, and the live-check runbook settles what Meta really sends.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConversationNoticeError,
  Graph,
  WHATSAPP_MAX_NOTICE_BYTES,
  WHATSAPP_MEDIA_HOSTS,
  WhatsAppConversations,
  connectWhatsApp,
  metaSignatureOk,
  parseWhatsAppNotices,
  whatsappLogin,
  whatsappSecretOf,
  type Fetch,
} from '../src/index.ts';

const APP_SECRET = 'w'.repeat(32);
const PHONE_ID = '104123456789012';
const WABA_ID = '204987654321098';
const CUSTOMER = '84900000001';
const OTHER = '84900000002';
const TOKEN = 'EAAG' + 'x'.repeat(40);
const SECRET = JSON.stringify({ accessToken: TOKEN, wabaId: WABA_ID });
// 2026-11-13 07:00:00 UTC in seconds, as WhatsApp dates a message [M]; "now" is a minute later.
const T0 = 1794553200;
const NOW = (T0 + 60) * 1000;

const sign = (raw: string, secret = APP_SECRET): string => `sha256=${createHmac('sha256', secret).update(new TextEncoder().encode(raw)).digest('hex')}`;

const notice = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '84900000099', phone_number_id: PHONE_ID }, ...value } }], ...extra }],
  });

const parse = (raw: string) => parseWhatsAppNotices(new TextEncoder().encode(raw), NOW);

describe('parseWhatsAppNotices', () => {
  it('turns a customer text into a direct event under their wa_id, with the name they gave', () => {
    const [n, ...rest] = parse(
      notice({
        contacts: [{ profile: { name: 'Lan Nguyễn' }, wa_id: CUSTOMER }],
        messages: [{ from: CUSTOMER, id: 'wamid.HBgLODQ5MDAwMDAwMDEVAgASGBQz', timestamp: String(T0), type: 'text', text: { body: 'Cho mình hỏi giá bánh kem' } }],
      }),
    );
    expect(rest).toEqual([]);
    expect(n).toEqual({
      accountId: PHONE_ID,
      events: [
        {
          kind: 'direct',
          threadId: CUSTOMER,
          messageId: 'wamid.HBgLODQ5MDAwMDAwMDEVAgASGBQz',
          direction: 'in',
          contact: { id: CUSTOMER, name: 'Lan Nguyễn' },
          text: 'Cho mình hỏi giá bánh kem',
          at: new Date(T0 * 1000).toISOString(),
        },
      ],
    });
  });

  it('keeps an image as an attachment by its media id (never an address) and a caption in place of the placeholder', () => {
    const [n] = parse(
      notice({
        contacts: [{ profile: { name: 'Lan' }, wa_id: CUSTOMER }],
        messages: [
          { from: CUSTOMER, id: 'wamid.img1', timestamp: String(T0), type: 'image', image: { id: '555111222333', mime_type: 'image/jpeg', sha256: 'abc', caption: 'Mẫu này nhé' } },
          { from: CUSTOMER, id: 'wamid.img2', timestamp: String(T0 + 1), type: 'image', image: { id: '555111222334', mime_type: 'image/jpeg' } },
          // A media id that is not digits is no attachment: the message keeps its placeholder.
          { from: CUSTOMER, id: 'wamid.img3', timestamp: String(T0 + 2), type: 'image', image: { id: 'https://evil.example/x.jpg?token=1' } },
        ],
      }),
    );
    expect(n?.events.map((e) => [e.text, e.attachments])).toEqual([
      ['Mẫu này nhé', [{ kind: 'image', mediaRef: '555111222333' }]],
      ['[Khách gửi ảnh]', [{ kind: 'image', mediaRef: '555111222334' }]],
      ['[Khách gửi ảnh]', undefined],
    ]);
    expect(JSON.stringify(n)).not.toMatch(/https?:/);
  });

  it('names every other kind of message in a placeholder line, takes a reply button as its title, and opens nothing for a reaction or a system notice', () => {
    const msg = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ from: CUSTOMER, id: `wamid.${id}`, timestamp: String(T0), type, ...extra });
    const [n] = parse(
      notice({
        messages: [
          msg('a', 'audio', { audio: { id: '1' } }),
          msg('v', 'video', { video: { id: '2', caption: 'Xem giúp' } }),
          msg('d', 'document', { document: { id: '3', filename: 'bao-gia.pdf' } }),
          msg('s', 'sticker', { sticker: { id: '4' } }),
          msg('l', 'location', { location: { latitude: 10.7, longitude: 106.7 } }),
          msg('c', 'contacts', { contacts: [{ name: { formatted_name: 'X' } }] }),
          msg('b', 'button', { button: { text: 'Đặt ngay', payload: 'p' } }),
          msg('i', 'interactive', { interactive: { type: 'button_reply', button_reply: { id: '1', title: 'Giao tận nơi' } } }),
          msg('x', 'unsupported', { errors: [{ code: 131051 }] }),
          msg('e', 'text', { text: { body: '   ' } }),
          msg('r', 'reaction', { reaction: { message_id: 'wamid.x', emoji: '👍' } }),
          msg('y', 'system', { system: { body: 'changed number' } }),
        ],
      }),
    );
    expect(n?.events.map((e) => e.text)).toEqual([
      '[Khách gửi tin nhắn thoại]',
      'Xem giúp\n[Khách gửi video]',
      '[Khách gửi tệp]',
      '[Khách gửi nhãn dán]',
      '[Khách gửi vị trí]',
      '[Khách gửi danh thiếp]',
      'Đặt ngay',
      'Giao tận nơi',
      '[Khách gửi tin nhắn đính kèm]',
      '[Khách gửi tin nhắn trống]',
    ]);
    // A location, a contact card and a file name are never copied into the text.
    expect(JSON.stringify(n)).not.toMatch(/10\.7|106\.7|bao-gia|formatted_name/);
  });

  it('turns a status failed into an outbound mark with a coded error, and answers sent, delivered and read with nothing', () => {
    const statuses = (status: string, id: string, errors?: unknown) => ({ id, status, timestamp: String(T0 + 5), recipient_id: CUSTOMER, ...(errors ? { errors } : {}) });
    const out = parse(notice({ statuses: [statuses('sent', 'wamid.s'), statuses('delivered', 'wamid.d'), statuses('read', 'wamid.r'), statuses('failed', 'wamid.f1', [{ code: 131047, title: 'Re-engagement message' }]), statuses('failed', 'wamid.f2')] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.events).toEqual([
      { kind: 'direct', threadId: CUSTOMER, messageId: 'wamid.f1', direction: 'out', contact: { id: CUSTOMER }, text: '', at: new Date((T0 + 5) * 1000).toISOString(), deliveryFailed: { code: 'WA_131047' } },
      { kind: 'direct', threadId: CUSTOMER, messageId: 'wamid.f2', direction: 'out', contact: { id: CUSTOMER }, text: '', at: new Date((T0 + 5) * 1000).toISOString(), deliveryFailed: { code: 'WA_FAILED' } },
    ]);
    // A notice of statuses that carry nothing to store names its account and holds no event.
    expect(parse(notice({ statuses: [statuses('read', 'wamid.r')] }))).toEqual([{ accountId: PHONE_ID, events: [] }]);
  });

  it('groups a batch by the phone number it names, oldest first, and drops what is not a message of a customer', () => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA_ID,
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ from: OTHER, id: 'wamid.late', timestamp: String(T0 + 9), type: 'text', text: { body: 'b' } }, { from: CUSTOMER, id: 'wamid.early', timestamp: String(T0 + 1), type: 'text', text: { body: 'a' } }] } },
            { field: 'messages', value: { metadata: { phone_number_id: '104000000000001' }, messages: [{ from: CUSTOMER, id: 'wamid.second', timestamp: String(T0), type: 'text', text: { body: 'c' } }] } },
            // Another field of the product, a phone number id that is not digits, a message from the business's own number, a bad id and a bad time.
            { field: 'account_update', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ from: CUSTOMER, id: 'wamid.no', timestamp: String(T0), type: 'text', text: { body: 'x' } }] } },
            { field: 'messages', value: { metadata: { phone_number_id: 'abc' }, messages: [{ from: CUSTOMER, id: 'wamid.no2', timestamp: String(T0), type: 'text', text: { body: 'x' } }] } },
            { field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ from: PHONE_ID, id: 'wamid.self', timestamp: String(T0), type: 'text', text: { body: 'x' } }, { from: 'bad id', id: 'wamid.badfrom', timestamp: String(T0), type: 'text', text: { body: 'x' } }, { from: CUSTOMER, id: '', timestamp: String(T0), type: 'text', text: { body: 'x' } }, { from: CUSTOMER, id: 'wamid.t0', timestamp: '0', type: 'text', text: { body: 'x' } }, { from: CUSTOMER, id: 'wamid.future', timestamp: String(T0 + 10 * 86_400), type: 'text', text: { body: 'x' } }] } },
          ],
        },
      ],
    });
    const out = parse(raw);
    expect(out.map((n) => [n.accountId, n.events.map((e) => e.messageId)])).toEqual([
      [PHONE_ID, ['wamid.early', 'wamid.late']],
      ['104000000000001', ['wamid.second']],
    ]);
  });

  it('dates nothing more than a few minutes ahead of the clock, so the 24-hour window is never stretched', () => {
    const at = (seconds: number) =>
      parse(notice({ contacts: [{ profile: { name: 'Lan' }, wa_id: CUSTOMER }], messages: [{ from: CUSTOMER, id: `wamid.t${seconds}`, timestamp: String(seconds), type: 'text', text: { body: 'x' } }] })).flatMap((n) => n.events);
    expect(at(T0 + 60 + 5 * 60)).toHaveLength(1);
    expect(at(T0 + 60 + 11 * 60)).toEqual([]);
    expect(at(T0 + 3_600)).toEqual([]);
  });

  it('takes the contact’s wa_id as the customer when it differs from the message’s from, and matches by from when several write', () => {
    // One sender and one contact whose numbers are written differently: the contact is the customer, who is also who a reply is sent to.
    const [single] = parse(
      notice({ contacts: [{ profile: { name: 'Lan' }, wa_id: '84900000001' }], messages: [{ from: '849000000010', id: 'wamid.a', timestamp: String(T0), type: 'text', text: { body: 'x' } }] }),
    );
    expect(single?.events[0]).toMatchObject({ threadId: '84900000001', contact: { id: '84900000001', name: 'Lan' } });
    // Several contacts: a message keeps its own from, and a name goes to the contact whose wa_id it is.
    const [many] = parse(
      notice({
        contacts: [{ profile: { name: 'Lan' }, wa_id: CUSTOMER }, { profile: { name: 'Minh' }, wa_id: OTHER }],
        messages: [
          { from: CUSTOMER, id: 'wamid.b', timestamp: String(T0), type: 'text', text: { body: 'x' } },
          { from: OTHER, id: 'wamid.c', timestamp: String(T0 + 1), type: 'text', text: { body: 'y' } },
        ],
      }),
    );
    expect(many?.events.map((e) => [e.threadId, e.contact.name])).toEqual([
      [CUSTOMER, 'Lan'],
      [OTHER, 'Minh'],
    ]);
  });

  it('is no notice of ours for another object, and malformed for a body that is not a notice', () => {
    expect(parse(JSON.stringify({ object: 'page', entry: [] }))).toEqual([]);
    expect(parse(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }))).toEqual([]);
    for (const bad of ['', 'not json', '[]', 'null', '{}', JSON.stringify({ object: 'whatsapp_business_account' }), JSON.stringify({ object: 5, entry: [] })]) {
      expect(() => parse(bad), bad).toThrow(ConversationNoticeError);
    }
    expect(() => parseWhatsAppNotices(new Uint8Array(WHATSAPP_MAX_NOTICE_BYTES + 1), NOW)).toThrow(ConversationNoticeError);
  });

  it('cuts a text to the core’s length and strips NUL characters', () => {
    const [n] = parse(notice({ messages: [{ from: CUSTOMER, id: 'wamid.long', timestamp: String(T0), type: 'text', text: { body: `a\u0000${'b'.repeat(25_000)}` } }] }));
    const text = n?.events[0]?.text ?? '';
    expect(text.length).toBe(20_000);
    expect(text).not.toContain('\u0000');
  });
});

describe('the signature of a notice (Messenger’s check, the WhatsApp app’s secret)', () => {
  it('accepts the app secret or the one it replaces, over the exact bytes, and nothing else', () => {
    const raw = notice({ messages: [{ from: CUSTOMER, id: 'wamid.sig', timestamp: String(T0), type: 'text', text: { body: 'Xin chào' } }] });
    const body = new TextEncoder().encode(raw);
    const header = sign(raw);
    expect(metaSignatureOk({ body, header, appSecret: APP_SECRET })).toBe(true);
    expect(metaSignatureOk({ body, header, appSecret: 'n'.repeat(32), appSecretPrevious: APP_SECRET })).toBe(true);
    expect(metaSignatureOk({ body, header, appSecret: 'x'.repeat(32) })).toBe(false);
    expect(metaSignatureOk({ body: new TextEncoder().encode(`${raw} `), header, appSecret: APP_SECRET })).toBe(false);
    expect(metaSignatureOk({ body, header: undefined, appSecret: APP_SECRET })).toBe(false);
    expect(metaSignatureOk({ body, header: header.slice(7), appSecret: APP_SECRET })).toBe(false);
  });
});

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(answers: Array<{ status?: number; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: Fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: new URL(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next instanceof Error) throw next;
    if (next?.bytes) return new Response(next.bytes as Uint8Array<ArrayBuffer>, { status: next.status ?? 200, headers: next.headers ?? {} });
    return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const adapter = (fetchImpl: Fetch) => new WhatsAppConversations(new Graph(APP_SECRET, undefined, fetchImpl));
const replyInput = (over: Partial<Parameters<WhatsAppConversations['reply']>[0]> = {}): Parameters<WhatsAppConversations['reply']>[0] => ({
  externalAccountId: PHONE_ID,
  secret: SECRET,
  kind: 'direct',
  threadId: CUSTOMER,
  postId: null,
  contactId: CUSTOMER,
  text: 'Dạ shop gửi bảng giá ạ',
  lastInboundAt: new Date(NOW - 3_600_000).toISOString(),
  callKey: 'call-1',
  ...over,
});

describe('connecting a number by hand', () => {
  it('checks the fields before any call, and the token once against the phone number', () => {
    expect(whatsappLogin({ accessToken: ` ${TOKEN} `, phoneNumberId: ` ${PHONE_ID}`, wabaId: `${WABA_ID} ` })).toEqual({ accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID });
    for (const [bad, code] of [
      [{ accessToken: 'short', phoneNumberId: PHONE_ID, wabaId: WABA_ID }, 'WHATSAPP_TOKEN_INVALID'],
      [{ accessToken: TOKEN, phoneNumberId: 'abc', wabaId: WABA_ID }, 'WHATSAPP_PHONE_ID_INVALID'],
      [{ accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: 'x' }, 'WHATSAPP_WABA_ID_INVALID'],
    ] as const) {
      expect(() => whatsappLogin(bad), code).toThrowError(expect.objectContaining({ code }));
    }
  });

  it('seals the token and the WABA id for the phone number id, named by the number’s verified name, and sends the token only in a header', async () => {
    const { fetchImpl, calls } = stub([{ body: { verified_name: 'Tiệm Bánh An Nhiên', display_phone_number: '+84 90 000 0099', id: PHONE_ID } }]);
    const account = await connectWhatsApp({ accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID }, { appSecret: APP_SECRET }, fetchImpl);
    expect(account).toMatchObject({ provider: 'whatsapp', externalAccountId: PHONE_ID, displayName: 'Tiệm Bánh An Nhiên', expiresAt: null });
    expect(whatsappSecretOf(account.secret)).toEqual({ accessToken: TOKEN, wabaId: WABA_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(`/v24.0/${PHONE_ID}`);
    expect(calls[0]?.url.search).not.toContain(TOKEN);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // With no verified name the number is the label; with neither, the provider's name.
    expect((await connectWhatsApp({ accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID }, { appSecret: APP_SECRET }, stub([{ body: { display_phone_number: '+84 90 000 0099' } }]).fetchImpl)).displayName).toBe('+84 90 000 0099');
    expect((await connectWhatsApp({ accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID }, { appSecret: APP_SECRET }, stub([{ body: {} }]).fetchImpl)).displayName).toBe('WhatsApp');
  });

  it('says why a number did not connect, by a short code and never by Meta’s words', async () => {
    const login = { accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID };
    const code = async (answer: Parameters<typeof stub>[0][number]) => connectWhatsApp(login, { appSecret: APP_SECRET }, stub([answer]).fetchImpl).catch((e: { code?: string; kind?: string; message?: string }) => e);
    expect(await code({ status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } })).toMatchObject({ kind: 'denied', code: 'WHATSAPP_TOKEN_REFUSED' });
    expect(await code({ status: 403, body: { error: { message: 'Permission', code: 10 } } })).toMatchObject({ kind: 'denied', code: 'WHATSAPP_PERMISSION' });
    expect(await code({ status: 400, body: { error: { message: 'Unsupported get request', code: 100 } } })).toMatchObject({ kind: 'denied', code: 'WHATSAPP_PHONE_NOT_FOUND' });
    expect(await code({ status: 500, body: { error: { message: 'boom', code: 1 } } })).toMatchObject({ kind: 'provider' });
    expect(await code(new Error('network down'))).toMatchObject({ kind: 'provider' });
    expect(JSON.stringify(await code({ status: 401, body: { error: { message: `bad ${TOKEN}`, code: 190 } } }))).not.toContain(TOKEN);
  });
});

describe('WhatsAppConversations.reply', () => {
  it('sends one free-form text to the customer with the sealed token, and answers with the wamid', async () => {
    const { fetchImpl, calls } = stub([{ body: { messaging_product: 'whatsapp', contacts: [{ input: CUSTOMER, wa_id: CUSTOMER }], messages: [{ id: 'wamid.HBgLsent' }] } }]);
    expect(await adapter(fetchImpl).reply(replyInput())).toEqual({ kind: 'accepted', externalId: 'wamid.HBgLsent' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: CUSTOMER, type: 'text', text: { preview_url: false, body: 'Dạ shop gửi bảng giá ạ' } } });
    expect(calls[0]?.url.pathname).toBe(`/v24.0/${PHONE_ID}/messages`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The token is in the header only; the call carries the proof of the app secret.
    expect(calls[0]?.url.search).not.toContain(TOKEN);
    expect(calls[0]?.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex'));
    // No template, and no field that starts a conversation.
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/template|interactive|messaging_type/);
  });

  it('refuses a reply past 24 hours of the customer’s last message without calling Meta', async () => {
    const { fetchImpl, calls } = stub([{ body: {} }]);
    // The adapter reads the real clock, so the customer's message is dated from it.
    const result = await adapter(fetchImpl).reply(replyInput({ lastInboundAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
    expect(result).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' });
    expect(calls).toHaveLength(0);
  });

  it('treats a thread with no known last message as closed: the window is never presumed open', async () => {
    const { fetchImpl, calls } = stub([{ body: {} }]);
    const wa = adapter(fetchImpl);
    expect(await wa.reply(replyInput({ lastInboundAt: null }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' });
    expect(await wa.reply(replyInput({ lastInboundAt: undefined }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' });
    expect(await wa.reply(replyInput({ lastInboundAt: 'not a date' }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses what is not a text it can send, before any call', async () => {
    const { fetchImpl, calls } = stub([{ body: {} }]);
    const wa = adapter(fetchImpl);
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(await wa.reply(replyInput({ text: '   ', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', code: 'EMPTY' });
    expect(await wa.reply(replyInput({ text: 'a'.repeat(4097), lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', code: 'WA_TEXT_LENGTH' });
    expect(await wa.reply(replyInput({ kind: 'comment_thread', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', code: 'WA_NOT_DIRECT' });
    expect(await wa.reply(replyInput({ threadId: 'US.13491208655302741918', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', code: 'WA_BAD_RECIPIENT' });
    expect(await wa.reply(replyInput({ externalAccountId: 'abc', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', code: 'BAD_PHONE_NUMBER_ID' });
    expect(await wa.reply(replyInput({ secret: '{}', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'NO_WHATSAPP_TOKEN' });
    expect(await wa.reply(replyInput({ secret: 'not json', lastInboundAt: recent }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(calls).toHaveLength(0);
    // A text of exactly 4096 characters goes.
    expect(await adapter(stub([{ body: { messages: [{ id: 'wamid.ok' }] } }]).fetchImpl).reply(replyInput({ text: 'a'.repeat(4096), lastInboundAt: recent }))).toMatchObject({ kind: 'accepted' });
  });

  it('maps Meta’s refusals to typed errors, and keeps an unclear answer unclear', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const refuse = (status: number, code: number | undefined, extra: Record<string, unknown> = {}) =>
      adapter(stub([{ status, body: { error: { message: 'm', ...(code === undefined ? {} : { code }), ...extra } } }]).fetchImpl).reply(replyInput({ lastInboundAt: recent }));
    expect(await refuse(400, 131047)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_WINDOW_CLOSED' });
    expect(await refuse(400, 131026)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_UNDELIVERABLE' });
    expect(await refuse(400, 131030)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WA_RECIPIENT_NOT_ALLOWED' });
    expect(await refuse(401, 190)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '190' });
    expect(await refuse(429, 130429)).toEqual({ kind: 'rejected', error: 'rate_limited', code: 'WA_130429' });
    expect(await refuse(400, 131056)).toEqual({ kind: 'rejected', error: 'rate_limited', code: 'WA_131056' });
    expect(await refuse(400, 131031)).toEqual({ kind: 'rejected', error: 'permission', code: 'WA_131031' });
    // A server error, a refusal Meta calls its own fault, a network failure and an answer with no id may all have gone out: never rejected, never sent again by a job.
    expect(await refuse(500, undefined)).toMatchObject({ kind: 'unknown' });
    expect(await refuse(400, 2)).toMatchObject({ kind: 'unknown' });
    expect(await adapter(stub([new Error('socket hang up')]).fetchImpl).reply(replyInput({ lastInboundAt: recent }))).toEqual({ kind: 'unknown', code: 'NETWORK' });
    expect(await adapter(stub([{ body: { messages: [] } }]).fetchImpl).reply(replyInput({ lastInboundAt: recent }))).toEqual({ kind: 'unknown', code: 'WA_NO_MESSAGE_ID' });
    expect(await adapter(stub([{ body: { messages: [{ id: 5 }] } }]).fetchImpl).reply(replyInput({ lastInboundAt: recent }))).toEqual({ kind: 'unknown', code: 'WA_NO_MESSAGE_ID' });
  });
});

describe('WhatsAppConversations.media (a media id in two calls)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const located = (url: string, extra: Record<string, unknown> = {}) => ({ body: { messaging_product: 'whatsapp', url, mime_type: 'image/png', id: '555111222333', file_size: PNG.byteLength, ...extra } });
  const media = (graph: ReturnType<typeof stub>, bytes: Parameters<typeof stub>[0], over: { hosts?: readonly string[]; maxBytes?: number; mediaRef?: string; secret?: string } = {}) => {
    const cdn = stub(bytes);
    const result = adapter(graph.fetchImpl).media!({
      externalAccountId: PHONE_ID,
      secret: over.secret ?? SECRET,
      mediaRef: over.mediaRef ?? '555111222333',
      fetch: cdn.fetchImpl,
      maxBytes: over.maxBytes ?? 5 * 1024 * 1024,
      hosts: over.hosts ?? WHATSAPP_MEDIA_HOSTS,
    });
    return { result, cdn };
  };

  it('asks Meta for the address with the token, then fetches the bytes with the same token, and returns the bytes', async () => {
    const graph = stub([located('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=555111222333&ext=1&hash=h')]);
    const { result, cdn } = media(graph, [{ bytes: PNG }]);
    expect(await result).toEqual({ kind: 'ok', bytes: PNG });
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]?.url.pathname).toBe('/v24.0/555111222333');
    expect(graph.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(cdn.calls).toHaveLength(1);
    expect(cdn.calls[0]?.url.hostname).toBe('lookaside.fbsbx.com');
    expect(cdn.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The token is in no address.
    expect(graph.calls[0]?.url.href).not.toContain(TOKEN);
    expect(cdn.calls[0]?.url.href).not.toContain(TOKEN);
  });

  it('sends the token to no host outside the list, nor over http, nor to an address with credentials', async () => {
    for (const url of ['https://evil.example/a.jpg', 'https://notfbsbx.com/a.jpg', 'http://lookaside.fbsbx.com/a.jpg', 'https://user:pw@lookaside.fbsbx.com/a.jpg', 'https://127.0.0.1/a.jpg', 'ftp://lookaside.fbsbx.com/a', 'not a url', '']) {
      const { result, cdn } = media(stub([located(url)]), [{ bytes: PNG }]);
      expect(await result, url).toEqual({ kind: 'failed', retry: false, code: expect.stringMatching(/^WA_MEDIA_(HOST|URL)$/) });
      expect(cdn.calls, url).toHaveLength(0);
    }
    // The deployment's own list replaces the built-in one.
    const own = media(stub([located('https://media.example.test/a.png')]), [{ bytes: PNG }], { hosts: ['example.test'] });
    expect(await own.result).toEqual({ kind: 'ok', bytes: PNG });
  });

  it('drops an image that is gone, refused or too large, and asks again for a failure that may be temporary', async () => {
    const url = 'https://lookaside.fbsbx.com/a';
    const failed = async (graph: Parameters<typeof stub>[0], bytes: Parameters<typeof stub>[0], over?: Parameters<typeof media>[2]) => media(stub(graph), bytes, over).result;
    // The media id: gone (a 400 "unsupported get request"), refused, rate limited, a server error, a network failure.
    expect(await failed([{ status: 400, body: { error: { message: 'x', code: 100 } } }], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_GONE' });
    expect(await failed([{ status: 401, body: { error: { message: 'x', code: 190 } } }], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_TOKEN_EXPIRED' });
    expect(await failed([{ status: 403, body: { error: { message: 'x', code: 10 } } }], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_PERMISSION' });
    expect(await failed([{ status: 429, body: { error: { message: 'x', code: 4 } } }], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_BUSY' });
    expect(await failed([{ status: 500, body: { error: { message: 'x', code: 1 } } }], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_ERROR' });
    expect(await failed([new Error('down')], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_ERROR' });
    // The bytes call: not found, redirected (never followed), a server error, a drop, an empty body, a body over the cap, a declared size over the cap.
    expect(await failed([located(url)], [{ status: 404, bytes: new Uint8Array(0) }])).toEqual({ kind: 'failed', retry: false, code: 'HTTP_404' });
    expect(await failed([located(url)], [{ status: 302, bytes: new Uint8Array(0), headers: { location: 'https://evil.example/' } }])).toEqual({ kind: 'failed', retry: false, code: 'HTTP_302' });
    expect(await failed([located(url)], [{ status: 503, bytes: new Uint8Array(0) }])).toEqual({ kind: 'failed', retry: true, code: 'HTTP_503' });
    expect(await failed([located(url)], [new Error('socket hang up')])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_FETCH' });
    expect(await failed([located(url)], [{ bytes: new Uint8Array(0) }])).toEqual({ kind: 'failed', retry: false, code: 'BAD_SIZE' });
    expect(await failed([located(url)], [{ bytes: PNG }], { maxBytes: 4 })).toEqual({ kind: 'failed', retry: false, code: 'BAD_SIZE' });
    expect(await failed([located(url, { file_size: 99_999_999 })], [{ bytes: PNG }])).toEqual({ kind: 'failed', retry: false, code: 'BAD_SIZE' });
    // A guard's refusal (the egress guard throws a coded error) is retried only when it may be temporary.
    const guard = (code: string) => Object.assign(new Error('refused'), { code });
    expect(await failed([located(url)], [guard('blocked')])).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_FETCH' });
    expect(await failed([located(url)], [guard('dns')])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_FETCH' });
    expect(await failed([located(url)], [guard('timeout')])).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_FETCH' });
  });

  it('refuses a reference that is not a media id, and a credential with no token, before any call', async () => {
    const graph = stub([located('https://lookaside.fbsbx.com/a')]);
    expect(await media(graph, [{ bytes: PNG }], { mediaRef: '../../me?access_token=x' }).result).toEqual({ kind: 'failed', retry: false, code: 'BAD_MEDIA_REF' });
    expect(await media(graph, [{ bytes: PNG }], { secret: '{}' }).result).toEqual({ kind: 'failed', retry: false, code: 'NO_WHATSAPP_TOKEN' });
    expect(graph.calls).toHaveLength(0);
  });
});
