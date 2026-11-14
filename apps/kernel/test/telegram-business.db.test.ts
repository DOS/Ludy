// SPDX-License-Identifier: AGPL-3.0-only
// Telegram Business mode on PostgreSQL 17 (conversation core, #3191, plan docs/plan/conversations-channels.md section 4.2): the bot of a connection
// that has chats on is connected by an owner to their own Telegram account, and Telegram says so in a `business_connection` update. The route parks it,
// the worker records the account on the connection, and from then on the customer chats of that account come into Hộp thư as threads of their own
// (beside a bot chat with the same id), answered for 24 hours after the customer's last message, through `sendMessage` with the business connection id,
// and only when a person presses Send. An unknown or disabled business connection stores nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL; each
// run makes its own database.
//
// Telegram lets any Premium user connect a bot that has Business Mode on, so an account Telegram reports is not the org's own until an owner or admin
// allows it: nothing of a new account is stored before, and stopping it ends its messages at once.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TELEGRAM_HOOK_KEY_INFO, TelegramPublisher, TelegramConversations, telegramHookSecret, type Fetch } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { runConversationIntake, runConversationJob, runTelegramChatHook } from '../src/conversations-worker.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-telegram-business-0123456789-abcdef';
const BASE = '/api/channels/telegram/webhook';
const TOKEN_A = '333333333:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw3';
const TOKEN_B = '444444444:DDHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw4';
const APP_URL = 'https://ludy.example.com';
// A business connection id as Telegram makes one: printable characters, and a second one that no connection of the org has.
const CONN = 'AbCd-123_xyz=';
const OTHER_CONN = 'ZZZZ-999_other=';
const OWNER_TG = 900;

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Org {
  orgId: string;
  ownerId: string;
  connectionId: string;
  hook: string;
}

suite('Telegram Business mode on PostgreSQL (#3191)', () => {
  const dbName = `crove_test_telegram_business_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let api: Runtime;
  let vault: CredentialVault;
  let a: Org;
  let b: Org;
  let updateId = 5000;
  // The fingerprint the screen names the first account by.
  let ref = '';
  const nowSec = () => Math.floor(Date.now() / 1000);

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const waiting = async () => (await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).length;
  const derived = () => vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key);
  const secretOf = (hook: string) => telegramHookSecret(derived()[0] as Buffer, hook);
  const post = (hook: string, body: string) => app.request(`${BASE}/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secretOf(hook) }, body });
  const intake = () => runConversationIntake({ workerDb, runtime: worker });
  const asOwner = (o: Org) => ({ actor: { type: 'user' as const, userId: o.ownerId, aal: 'aal1' as const }, orgId: o.orgId });

  const connection = (o: { id?: string; enabled?: boolean; canReply?: boolean; name?: string } = {}) =>
    JSON.stringify({
      update_id: updateId++,
      business_connection: {
        id: o.id ?? CONN,
        user: { id: OWNER_TG, first_name: o.name ?? 'Lan', last_name: 'Trần', username: 'lan_tran' },
        user_chat_id: OWNER_TG,
        date: nowSec(),
        rights: o.canReply === false ? {} : { can_reply: true },
        is_enabled: o.enabled ?? true,
      },
    });
  // A message of a business chat. `chat` is the customer's user id (the chat's other party); `from` is the customer unless `own`.
  const business = (text: string, o: { chat: number; messageId: number; own?: boolean; connectionId?: string; field?: string; date?: number }) =>
    JSON.stringify({
      update_id: updateId++,
      [o.field ?? 'business_message']: {
        message_id: o.messageId,
        business_connection_id: o.connectionId ?? CONN,
        from: o.own ? { id: OWNER_TG, is_bot: false, first_name: 'Lan' } : { id: o.chat, is_bot: false, first_name: 'Khách', last_name: String(o.chat) },
        chat: { id: o.chat, first_name: 'Khách', last_name: String(o.chat), type: 'private' },
        date: o.date ?? nowSec(),
        text,
      },
    });
  const botChat = (text: string, o: { chat: number; messageId: number }) =>
    JSON.stringify({ update_id: updateId++, message: { message_id: o.messageId, from: { id: o.chat, is_bot: false, first_name: 'Khách' }, chat: { id: o.chat, type: 'private' }, date: nowSec(), text } });
  const deleted = (o: { chat: number; ids: number[]; connectionId?: string }) =>
    JSON.stringify({ update_id: updateId++, deleted_business_messages: { business_connection_id: o.connectionId ?? CONN, chat: { id: o.chat, type: 'private', first_name: 'Khách' }, message_ids: o.ids } });
  const threadRow = async (o: Org, externalThreadId: string) =>
    (await rows<{ id: string; last_seq: number; status: string; reply_window_until: Date | null; last_inbound_at: Date | null }>('SELECT id, last_seq, status, reply_window_until, last_inbound_at FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, externalThreadId]))[0];
  const messagesOf = (o: Org, thread: string) =>
    rows<{ body: string; direction: string; external_message_id: string; platform_removed_at: Date | null }>(
      'SELECT m.body, m.direction, m.external_message_id, m.platform_removed_at FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id WHERE m.org_id = $1 AND c.external_thread_id = $2 ORDER BY m.seq',
      [o.orgId, thread],
    );
  const accountsOf = async (o: Org) => (await rows<{ chat_business: Array<{ id: string; userId: string; name: string | null; username: string | null; canReply: boolean; enabled: boolean; approved: boolean }> }>('SELECT chat_business FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId]))[0]?.chat_business ?? [];

  function telegram(answers: Record<string, { status?: number; body: unknown }[]> = {}) {
    const calls: Array<{ method: string; token: string; json: Record<string, unknown> }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
      calls.push({ method, token: tokenPart.replace(/^bot/, ''), json: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      const answer = answers[method]?.shift() ?? { body: { ok: true, result: method === 'sendMessage' ? { message_id: 9001 } : true } };
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  async function connectBot(name: string, token: string, channel: string): Promise<Org> {
    const ownerId = (await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@telegram-business.test`, name: null })) as string;
    const orgId = (await createOrg(api, { type: 'user', userId: ownerId, aal: 'aal1' }, name)).orgId;
    const sealed = vault.seal(JSON.stringify({ botToken: token, username: null }), { orgId, provider: 'telegram', externalAccountId: channel });
    const connectionId = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'telegram', externalAccountId: channel, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: { type: 'user', userId: ownerId, aal: 'aal1' }, orgId },
      )
    ).connectionId;
    const o = { orgId, ownerId, connectionId, hook: '' };
    await api.execute('kernel.channel.telegram_chat_set', { connectionId, on: true }, asOwner(o));
    const t = telegram();
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId, connectionId, action: 'chat', on: true })).toBe('on');
    // The webhook asks for the four business updates beside the messages.
    expect(t.calls[0]?.json.allowed_updates).toEqual(['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']);
    const [row] = await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId]);
    return { ...o, hook: (row as { chat_hook: string }).chat_hook };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false, telegramWebhook: { keys: derived } });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    a = await connectBot('Công ty Business A', TOKEN_A, '-1003333333333');
    b = await connectBot('Công ty Business B', TOKEN_B, '-1004444444444');
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('records the business account from a verified business_connection update as not yet allowed, shows it without any id, and answers a redelivery without parking it again', async () => {
    const body = connection();
    expect((await post(a.hook, body)).status).toBe(200);
    expect(await waiting()).toBe(1);
    // It is state, not a message: nothing is stored in a thread, and the connection now lists the account, which nobody has allowed yet.
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
    expect(await accountsOf(a)).toEqual([{ id: CONN, userId: String(OWNER_TG), name: 'Lan Trần', username: 'lan_tran', canReply: true, enabled: true, approved: false }]);
    // The screen's list names the account and what the bot may do, with a fingerprint to name it by, and never the platform's ids.
    const list = await api.query<Array<{ id: string; chatBusiness: Array<{ ref: string }> }>>('kernel.channel.list', {}, asOwner(a));
    const shown = list.find((c) => c.id === a.connectionId)?.chatBusiness;
    expect(shown).toEqual([{ ref: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'Lan Trần', username: 'lan_tran', enabled: true, canReply: true, approved: false }]);
    expect(JSON.stringify(list)).not.toContain(CONN);
    expect(JSON.stringify(list)).not.toContain(String(OWNER_TG));
    ref = (shown as Array<{ ref: string }>)[0]?.ref as string;
    // Neither the audit log nor an event holds the business connection id, the account's id, its name or its @username.
    for (const needle of [CONN, 'Lan Trần', 'lan_tran']) {
      expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1', [`%${needle}%`])).length).toBe(0);
      expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE payload::text LIKE $1', [`%${needle}%`])).length).toBe(0);
    }
    // Telegram repeats the same update: answered, not parked again.
    expect((await post(a.hook, body)).status).toBe(200);
    expect(await waiting()).toBe(0);
    // The other org's connection knows nothing of it: a hook reaches only its own connection.
    expect(await accountsOf(b)).toEqual([]);
  });

  it('stores nothing for a business message of a connection the org does not know, or knows but nobody has allowed, and takes it once an owner allows the account', async () => {
    const stranger = business('Gửi qua kết nối lạ', { chat: 2001, messageId: 1, connectionId: OTHER_CONN });
    expect((await post(a.hook, stranger)).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    // The account is known and enabled but nobody allowed it: any Premium user could have connected the bot, so nothing of it is stored.
    expect((await post(a.hook, business('Tin của tài khoản chưa được cho phép', { chat: 2003, messageId: 1 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
    // The other org's hook with this org's business connection id is no connection of that org either.
    expect((await post(b.hook, business('Gửi qua hook của tổ chức khác', { chat: 2002, messageId: 2 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(0);
    // Only an owner or admin chooses: a member and a viewer are refused, an account the connection does not hold is not found, and only a Telegram connection has accounts.
    for (const role of ['member', 'viewer'] as const) {
      const personId = (await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'test', subject: randomUUID(), email: `${role}-${randomUUID().slice(0, 8)}@telegram-business.test`, name: null })) as string;
      await rows('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [a.orgId, personId, role]);
      await expect(api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref, allow: true }, { actor: { type: 'user', userId: personId, aal: 'aal1' }, orgId: a.orgId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref: '0'.repeat(12), allow: true }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_NOT_FOUND', status: 404 });
    await expect(api.execute('kernel.channel.telegram_business_allow', { connectionId: b.connectionId, ref, allow: true }, asOwner(b))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_NOT_FOUND' });
    expect((await accountsOf(a))[0]?.approved).toBe(false);
    // The owner allows it; the audit row holds the choice and the fingerprint, nothing of the account.
    expect(await api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref, allow: true }, asOwner(a))).toEqual({ approved: true });
    expect((await accountsOf(a))[0]).toMatchObject({ id: CONN, approved: true });
    expect((await rows("SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE '%business_allow%'")).length).toBeGreaterThan(0);
    for (const needle of [CONN, 'Lan Trần', 'lan_tran']) expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1', [`%${needle}%`])).length).toBe(0);
    // A later update of the same account (a rights change) keeps what the owner decided.
    expect((await post(a.hook, connection({ canReply: true }))).status).toBe(200);
    await intake();
    expect((await accountsOf(a))[0]).toMatchObject({ id: CONN, approved: true });
  });

  it('takes a customer message of a business chat into a thread of its own beside a bot chat of the same id, with a 24-hour window and a message id that names the chat', async () => {
    expect((await post(a.hook, business('Cho mình hỏi giá áo này', { chat: 2101, messageId: 8 }))).status).toBe(200);
    expect((await post(a.hook, botChat('Mình hỏi qua bot', { chat: 2101, messageId: 8 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    const biz = await threadRow(a, `b:2101:${CONN}`);
    const bot = await threadRow(a, '2101');
    expect(biz?.id).toBeDefined();
    expect(bot?.id).toBeDefined();
    expect(biz?.id).not.toBe(bot?.id);
    expect(await messagesOf(a, `b:2101:${CONN}`)).toEqual([{ body: 'Cho mình hỏi giá áo này', direction: 'in', external_message_id: `b:2101:${CONN}:8`, platform_removed_at: null }]);
    expect(await messagesOf(a, '2101')).toEqual([{ body: 'Mình hỏi qua bot', direction: 'in', external_message_id: '2101:8', platform_removed_at: null }]);
    // A business chat can be answered for 24 hours after the customer's last message; a bot chat has no window.
    const until = biz?.reply_window_until as Date;
    const last = biz?.last_inbound_at as Date;
    expect((until.getTime() - last.getTime()) / 3_600_000).toBe(24);
    expect(bot?.reply_window_until).toBeNull();
    // The same message id in two different chats of one bot is two messages, not a repeat.
    expect((await post(a.hook, botChat('Khách một', { chat: 2102, messageId: 5 }))).status).toBe(200);
    expect((await post(a.hook, botChat('Khách hai', { chat: 2103, messageId: 5 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
  });

  it('answers through sendMessage with the business connection id once, after a person sends it, and the echo of that reply is the message already stored', async () => {
    const thread = (await threadRow(a, `b:2101:${CONN}`)) as { id: string; last_seq: number };
    const t = telegram({ sendMessage: [{ body: { ok: true, result: { message_id: 8800 } } }] });
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined) };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ áo này 250k ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    // Nothing is sent by the command itself.
    expect(t.calls).toHaveLength(0);
    const job = { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' as const };
    expect(await runConversationJob(deps, job)).toBe('accepted');
    expect(t.calls).toEqual([{ method: 'sendMessage', token: TOKEN_A, json: { chat_id: '2101', business_connection_id: CONN, text: 'Dạ áo này 250k ạ' } }]);
    expect(await rows('SELECT send_state, external_message_id FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ send_state: 'sent', external_message_id: `b:2101:${CONN}:8800` }]);
    expect(await runConversationJob(deps, job)).toBe('settled');
    expect(t.calls).toHaveLength(1);
    // Telegram tells the bot about the message it sent for the account: the same id, so nothing is added.
    const before = (await messagesOf(a, `b:2101:${CONN}`)).length;
    const echo = JSON.stringify({ update_id: updateId++, business_message: { message_id: 8800, business_connection_id: CONN, sender_business_bot: { id: 333333333, is_bot: true, first_name: 'bot' }, from: { id: OWNER_TG, is_bot: false, first_name: 'Lan' }, chat: { id: 2101, type: 'private', first_name: 'Khách' }, date: nowSec(), text: 'Dạ áo này 250k ạ' } });
    expect((await post(a.hook, echo)).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect((await messagesOf(a, `b:2101:${CONN}`)).length).toBe(before);
  });

  it('shows what the owner typed in Telegram as an outgoing message in the customer\'s thread, and a customer\'s edit and deletion change the stored words', async () => {
    expect((await post(a.hook, business('Có size M không shop?', { chat: 2201, messageId: 1 }))).status).toBe(200);
    expect((await post(a.hook, business('Dạ mình còn size M ạ', { chat: 2201, messageId: 3, own: true }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    const key = `b:2201:${CONN}`;
    expect((await messagesOf(a, key)).map((m) => [m.direction, m.body])).toEqual([['in', 'Có size M không shop?'], ['out', 'Dạ mình còn size M ạ']]);
    // The thread's customer is the chat's other party, whoever wrote the first message.
    expect(await rows("SELECT i.external_user_id FROM crove_kernel.conversation c JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id WHERE c.org_id = $1 AND c.external_thread_id = $2", [a.orgId, key])).toEqual([{ external_user_id: '2201' }]);
    // An edit of the customer's message changes the stored body; an edit of the owner's own message is not news.
    expect((await post(a.hook, business('Có size L không shop?', { chat: 2201, messageId: 1, field: 'edited_business_message' }))).status).toBe(200);
    expect((await post(a.hook, business('Dạ còn size M và L', { chat: 2201, messageId: 3, own: true, field: 'edited_business_message' }))).status).toBe(200);
    await intake();
    expect((await messagesOf(a, key)).map((m) => m.body)).toEqual(['Có size L không shop?', 'Dạ mình còn size M ạ']);
    // A second edit of the same message is its own update, not a repeat of the first.
    expect((await post(a.hook, business('Có size XL không shop?', { chat: 2201, messageId: 1, field: 'edited_business_message' }))).status).toBe(200);
    await intake();
    expect((await messagesOf(a, key)).map((m) => m.body)).toEqual(['Có size XL không shop?', 'Dạ mình còn size M ạ']);
    // The customer deletes it: the words go, once.
    expect((await post(a.hook, deleted({ chat: 2201, ids: [1] }))).status).toBe(200);
    await intake();
    const left = await messagesOf(a, key);
    expect(left[0]).toMatchObject({ body: '', direction: 'in' });
    expect(left[0]?.platform_removed_at).not.toBeNull();
    expect(left[1]?.body).toBe('Dạ mình còn size M ạ');
  });

  it('stops taking a disabled business connection\'s messages, takes them again when it is enabled, ends them when an owner stops the account, and ignores a chat of the account with itself', async () => {
    expect((await post(a.hook, connection({ enabled: false }))).status).toBe(200);
    await intake();
    expect((await accountsOf(a))[0]).toMatchObject({ id: CONN, enabled: false });
    expect((await api.query<Array<{ id: string; chatBusiness: Array<{ enabled: boolean }> }>>('kernel.channel.list', {}, asOwner(a))).find((c) => c.id === a.connectionId)?.chatBusiness[0]?.enabled).toBe(false);
    expect((await post(a.hook, business('Tin khi đã tắt', { chat: 2301, messageId: 1 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await threadRow(a, `b:2301:${CONN}`)).toBeUndefined();
    expect((await post(a.hook, connection({ enabled: true }))).status).toBe(200);
    await intake();
    expect((await post(a.hook, business('Tin khi đã bật lại', { chat: 2301, messageId: 2 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    // An owner stops the account: its messages end at once, and allowing it again lets them in.
    expect(await api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref, allow: false }, asOwner(a))).toEqual({ approved: false });
    expect((await post(a.hook, business('Tin sau khi chủ ngừng nhận', { chat: 2301, messageId: 3 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    await api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref, allow: true }, asOwner(a));
    expect((await post(a.hook, business('Tin khi đã cho nhận lại', { chat: 2301, messageId: 4 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    // A chat of the business account with itself (the chat is the account's own user) is nobody's customer.
    expect((await post(a.hook, business('Ghi chú cho chính mình', { chat: OWNER_TG, messageId: 1 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await threadRow(a, `b:${OWNER_TG}:${CONN}`)).toBeUndefined();
  });

  it('refuses a reply once the 24 hours are over, and a connection that is read-only shows so', async () => {
    const thread = (await threadRow(a, `b:2301:${CONN}`)) as { id: string; last_seq: number };
    await rows("UPDATE crove_kernel.conversation SET reply_window_until = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [a.orgId, thread.id]);
    await expect(api.execute('kernel.conversation.reply', { conversationId: thread.id, body: 'Quá muộn rồi', lastSeenSeq: thread.last_seq }, asOwner(a))).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' });
    const detail = await api.query<{ reply: { allowed: boolean; reason: string | null } }>('kernel.conversation.get', { conversationId: thread.id }, asOwner(a));
    expect(detail.reply).toEqual({ allowed: false, reason: 'window_closed' });
    // The bot may be connected with no right to reply: the account is listed as it is, and the messages still come in.
    expect((await post(a.hook, connection({ canReply: false }))).status).toBe(200);
    await intake();
    expect((await accountsOf(a))[0]).toMatchObject({ canReply: false, enabled: true });
  });

  it('answers a business thread only through an account that is on, allowed and may reply, and says why not: the reply, the queued send, the retry, the draft and the thread\'s own state all refuse', async () => {
    const t = telegram();
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined) };
    const state = async (over: { enabled?: boolean; canReply?: boolean }) => {
      expect((await post(a.hook, connection({ enabled: over.enabled ?? true, canReply: over.canReply ?? true }))).status).toBe(200);
      await intake();
    };
    const detail = async (id: string) => (await api.query<{ reply: { allowed: boolean; reason: string | null } }>('kernel.conversation.get', { conversationId: id }, asOwner(a))).reply;
    const allow = (on: boolean) => api.execute('kernel.channel.telegram_business_allow', { connectionId: a.connectionId, ref, allow: on }, asOwner(a));
    await state({});
    await allow(true);
    expect((await post(a.hook, business('Còn hàng không shop?', { chat: 2501, messageId: 1 }))).status).toBe(200);
    await intake();
    const thread = (await threadRow(a, `b:2501:${CONN}`)) as { id: string; last_seq: number };
    expect(await detail(thread.id)).toEqual({ allowed: true, reason: null });
    // A reply is queued while the account is on; the owner stops the account before the worker sends it: nothing goes to Telegram, and the message says why.
    const queued = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ còn ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    await allow(false);
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId: queued.messageId, connectionId: a.connectionId, action: 'reply' })).toBe('settled');
    expect(t.calls).toHaveLength(0);
    expect(await rows('SELECT send_state, send_error_code FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, queued.messageId])).toEqual([{ send_state: 'failed', send_error_code: 'BUSINESS_ACCOUNT_STOPPED' }]);
    // The same for a new reply, a retry of that one, a draft and what the screen is told.
    expect(await detail(thread.id)).toEqual({ allowed: false, reason: 'business_stopped' });
    await expect(api.execute('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ còn ạ', lastSeenSeq: thread.last_seq + 1 }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_STOPPED', status: 409 });
    await expect(api.execute('kernel.conversation.reply_settle', { messageId: queued.messageId, action: 'retry' }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_STOPPED' });
    // A connection Telegram reports as disconnected, even when allowed, answers nothing; one with no right to reply is read-only.
    await allow(true);
    await state({ enabled: false });
    expect(await detail(thread.id)).toEqual({ allowed: false, reason: 'business_stopped' });
    await state({ canReply: false });
    expect(await detail(thread.id)).toEqual({ allowed: false, reason: 'business_read_only' });
    await expect(api.execute('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ còn ạ', lastSeenSeq: thread.last_seq + 1 }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_READ_ONLY' });
    // Back on, allowed and with the right: answered, and the retry of the refused message is accepted.
    await state({});
    expect(await detail(thread.id)).toEqual({ allowed: true, reason: null });
    expect(await api.execute('kernel.conversation.reply_settle', { messageId: queued.messageId, action: 'retry' }, asOwner(a))).toMatchObject({ state: 'queued' });
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId: queued.messageId, connectionId: a.connectionId, action: 'reply' })).toBe('accepted');
    expect(t.calls.map((c) => c.method)).toEqual(['sendMessage']);
    // A draft is not asked either, so no model call is spent on a thread nobody may answer: a customer's last message waits in a thread of its own.
    expect((await post(a.hook, business('Anh ơi cho em hỏi giá', { chat: 2504, messageId: 1 }))).status).toBe(200);
    await intake();
    const waitingThread = (await threadRow(a, `b:2504:${CONN}`)) as { id: string };
    await allow(false);
    await expect(api.execute('kernel.conversation.draft_request', { conversationId: waitingThread.id }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_STOPPED' });
    await allow(true);
    await state({ canReply: false });
    await expect(api.execute('kernel.conversation.draft_request', { conversationId: waitingThread.id }, asOwner(a))).rejects.toMatchObject({ code: 'BUSINESS_ACCOUNT_READ_ONLY' });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_draft WHERE org_id = $1 AND conversation_id = $2', [a.orgId, waitingThread.id])).toHaveLength(0);
    await state({});
    // A business thread that holds no customer message (the owner wrote first) has no window to answer in: Telegram answers only chats with a message in the last 24 hours.
    expect((await post(a.hook, business('Chào anh, em là chủ shop', { chat: 2502, messageId: 1, own: true }))).status).toBe(200);
    await intake();
    const own = (await threadRow(a, `b:2502:${CONN}`)) as { id: string; last_seq: number; reply_window_until: Date | null };
    expect(own.reply_window_until).toBeNull();
    expect(await detail(own.id)).toEqual({ allowed: false, reason: 'window_closed' });
    await expect(api.execute('kernel.conversation.reply', { conversationId: own.id, body: 'Alo', lastSeenSeq: own.last_seq }, asOwner(a))).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' });
  });

  it('keeps nothing that names the customer\'s chat or the business connection in a finished call row, so erasing the customer leaves no copy of them', async () => {
    const t = telegram({ sendMessage: [{ body: { ok: true, result: { message_id: 9100 } } }] });
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined) };
    expect((await post(a.hook, business('Số của mình là 0912 345 678', { chat: 8827361, messageId: 1 }))).status).toBe(200);
    await intake();
    const thread = (await threadRow(a, `b:8827361:${CONN}`)) as { id: string; last_seq: number };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ em nhận rồi ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' })).toBe('accepted');
    // The message keeps the whole id (it is how the echo of the reply is told to be the same message); the call row keeps the platform's own message id only.
    expect(await rows('SELECT external_message_id FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ external_message_id: `b:8827361:${CONN}:9100` }]);
    expect(await rows('SELECT external_ref FROM crove_kernel.external_call WHERE org_id = $1 AND key LIKE $2', [a.orgId, `conversation.reply:${messageId}:%`])).toEqual([{ external_ref: '9100' }]);
    await api.execute('kernel.conversation.erase_contact', { conversationId: thread.id, confirm: true }, { actor: { type: 'user', userId: a.ownerId, aal: 'aal2', sessionId: randomUUID(), mfaAt: nowSec() }, orgId: a.orgId, idempotencyKey: randomUUID() });
    expect(await threadRow(a, `b:8827361:${CONN}`)).toBeUndefined();
    // Nothing the org holds names the customer's chat or the business connection any more: not the call rows, the audit log nor the events.
    // (Other customers' messages through the same business connection keep naming it, so the messages are checked for the erased chat only.)
    for (const [table, column] of [['external_call', 'external_ref'], ['audit_event', 'detail::text'], ['outbox_event', 'payload::text'], ['conversation_message', 'external_message_id']] as const) {
      for (const needle of table === 'conversation_message' ? ['8827361'] : ['8827361', CONN]) expect({ table, needle, found: (await rows(`SELECT 1 FROM crove_kernel.${table} WHERE org_id = $1 AND ${column} LIKE $2`, [a.orgId, `%${needle}%`])).length }).toEqual({ table, needle, found: 0 });
    }
  });

  it('refuses a business thread that does not come through the gate: no business connection, or another one, or a business connection with a bot thread', async () => {
    const event = (threadId: string, id: string) => ({ kind: 'direct' as const, threadId, messageId: `${threadId}:${id}`, direction: 'in' as const, contact: { id: '2601' }, text: 'Thử', at: new Date().toISOString() });
    const ingest = (events: ReturnType<typeof event>[], via?: string) => worker.execute<{ stored: number; ignored: number }>('kernel.conversation.ingest', { connectionId: a.connectionId, events, ...(via ? { businessConnectionId: via } : {}) }, { actor: { type: 'system', component: 'test' }, orgId: a.orgId });
    // A thread of the business shape with no business connection named, or the wrong one, is refused (whatever the notice parser said).
    expect(await ingest([event(`b:2601:${CONN}`, '1')])).toMatchObject({ stored: 0, ignored: 1 });
    expect(await ingest([event(`b:2601:${OTHER_CONN}`, '2')], CONN)).toMatchObject({ stored: 0, ignored: 1 });
    // A business connection with a thread that is a bot chat's is refused too, and a thread of a connection whose id merely ends with this one's is not this one's.
    expect(await ingest([event('2601', '3')], CONN)).toMatchObject({ stored: 0, ignored: 1 });
    expect(await ingest([event(`b:2601:X:${CONN}`, '5')], CONN)).toMatchObject({ stored: 0, ignored: 1 });
    expect(await rows("SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id IN ($2, '2601')", [a.orgId, `b:2601:${CONN}`])).toHaveLength(0);
    // The right pair is taken (the account is on and allowed by now).
    expect(await ingest([event(`b:2601:${CONN}`, '4')], CONN)).toMatchObject({ stored: 1, ignored: 0 });
  });

  it('takes an edit of a message older than two days, which carries the message\'s first date', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const thread = `b:2701:${CONN}`;
    await worker.execute('kernel.conversation.ingest', { connectionId: a.connectionId, businessConnectionId: CONN, events: [{ kind: 'direct', threadId: thread, messageId: `${thread}:1`, direction: 'in', contact: { id: '2701' }, text: 'Giá cũ', at: old }] }, { actor: { type: 'system', component: 'test' }, orgId: a.orgId });
    const edit = business('Giá mới', { chat: 2701, messageId: 1, field: 'edited_business_message', date: Math.floor(Date.parse(old) / 1000) });
    expect((await post(a.hook, edit)).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
    expect((await messagesOf(a, thread)).map((m) => m.body)).toEqual(['Giá mới']);
    // An edit of a message the org never took in (it came before the account was allowed, or went with a purged thread) stores nothing: a replayed or late edit
    // carries the message's first date and must not bring it back as a new message.
    expect((await post(a.hook, business('Tin chưa từng nhận', { chat: 2702, messageId: 1, field: 'edited_business_message', date: Math.floor(Date.parse(old) / 1000) }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await threadRow(a, `b:2702:${CONN}`)).toBeUndefined();
  });

  it('records accounts only while chats are on, keeps at most ten, and forgets them when the connection is disconnected', async () => {
    // While chats are on the command records an account; once they are off it is refused quietly and nothing changes.
    const first = await worker.execute<{ applied: boolean }>('kernel.channel.telegram_business_record', { connectionId: b.connectionId, account: { id: 'x1', userId: '1', name: null, username: null, canReply: true, enabled: true } }, { actor: { type: 'system', component: 'test' }, orgId: b.orgId });
    expect(first.applied).toBe(true);
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: b.connectionId, on: false }, asOwner(b));
    const t = telegram();
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: false })).toBe('off');
    const refused = await worker.execute<{ applied: boolean }>('kernel.channel.telegram_business_record', { connectionId: b.connectionId, account: { id: 'x2', userId: '2', name: null, username: null, canReply: true, enabled: true } }, { actor: { type: 'system', component: 'test' }, orgId: b.orgId });
    expect(refused.applied).toBe(false);
    expect((await accountsOf(b)).map((x) => x.id)).toEqual(['x1']);
    // The account list is a person's data: a user cannot write it, only the system command can.
    await expect(api.execute('kernel.channel.telegram_business_record', { connectionId: b.connectionId, account: { id: 'x3', userId: '3', name: null, username: null, canReply: true, enabled: true } }, asOwner(b))).rejects.toMatchObject({ status: 403 });
    // Ten accounts at most. A stranger's account (nobody allowed it) must not keep the org's own out: when the list is full the oldest account nobody
    // allowed goes first.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: b.connectionId, on: true }, asOwner(b));
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: true })).toBe('on');
    const record = (id: string, enabled: boolean) => worker.execute<{ applied: boolean }>('kernel.channel.telegram_business_record', { connectionId: b.connectionId, account: { id, userId: '5', name: null, username: null, canReply: true, enabled } }, { actor: { type: 'system', component: 'test' }, orgId: b.orgId });
    for (let i = 2; i <= 10; i++) expect((await record(`x${i}`, true)).applied).toBe(true);
    expect((await accountsOf(b)).length).toBe(10);
    expect((await accountsOf(b)).every((x) => !x.approved)).toBe(true);
    expect((await record('x11', true)).applied).toBe(true);
    expect((await accountsOf(b)).map((x) => x.id)).toEqual(['x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11']);
    // The owner allows every one that is there: a full list of allowed, enabled accounts takes no newcomer.
    const refs = ((await api.query<Array<{ id: string; chatBusiness: Array<{ ref: string }> }>>('kernel.channel.list', {}, asOwner(b))).find((c) => c.id === b.connectionId)?.chatBusiness ?? []).map((x) => x.ref);
    expect(refs).toHaveLength(10);
    for (const r of refs) await api.execute('kernel.channel.telegram_business_allow', { connectionId: b.connectionId, ref: r, allow: true }, asOwner(b));
    expect((await accountsOf(b)).every((x) => x.approved)).toBe(true);
    expect((await record('x12', true)).applied).toBe(false);
    // One of them goes off in Telegram: it is the one a newcomer replaces, and the newcomer starts not allowed.
    expect((await record('x4', false)).applied).toBe(true);
    expect((await accountsOf(b)).find((x) => x.id === 'x4')).toMatchObject({ enabled: false, approved: true });
    expect((await record('x12', true)).applied).toBe(true);
    expect((await accountsOf(b)).map((x) => x.id)).not.toContain('x4');
    expect((await accountsOf(b)).find((x) => x.id === 'x12')).toMatchObject({ enabled: true, approved: false });
    expect((await accountsOf(b)).length).toBe(10);
    // Disconnecting forgets the accounts: chats turned off first, as for the hook.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: b.connectionId, on: false }, asOwner(b));
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: false })).toBe('off');
    await api.execute('kernel.channel.disconnect', { connectionId: b.connectionId }, { ...asOwner(b), idempotencyKey: randomUUID() });
    expect(await accountsOf(b)).toEqual([]);
  });

  it('does not bring an erased customer back with a deletion notice, and keeps what the account\'s own side wrote out of the customer erasure', async () => {
    expect((await post(a.hook, business('Số của mình là 0912 345 678', { chat: 2401, messageId: 1 }))).status).toBe(200);
    await intake();
    const key = `b:2401:${CONN}`;
    const thread = (await threadRow(a, key)) as { id: string };
    const erased = await api.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: thread.id, confirm: true }, { actor: { type: 'user', userId: a.ownerId, aal: 'aal2', sessionId: randomUUID(), mfaAt: nowSec() }, orgId: a.orgId, idempotencyKey: randomUUID() });
    expect(erased).toEqual({ threads: 1, messages: 1 });
    expect(await threadRow(a, key)).toBeUndefined();
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_identity WHERE org_id = $1 AND external_user_id = '2401'", [a.orgId])).toHaveLength(0);
    // A notice that deletes a message of the erased customer is dated at the earliest instant: it does not make the customer's thread or identity again.
    expect((await post(a.hook, deleted({ chat: 2401, ids: [1, 2] }))).status).toBe(200);
    await intake();
    expect(await threadRow(a, key)).toBeUndefined();
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_identity WHERE org_id = $1 AND external_user_id = '2401'", [a.orgId])).toHaveLength(0);
    // Nor does a new message of theirs dated before the erasure; one written after it is a new customer's first message (the tombstone only holds back what is older).
    expect((await post(a.hook, business('Tin cũ gửi lại', { chat: 2401, messageId: 3, date: nowSec() - 3600 }))).status).toBe(200);
    await intake();
    expect(await threadRow(a, key)).toBeUndefined();
    // A deletion notice for a message never seen makes a blank, resolved thread (nobody to answer), for a customer who was not erased.
    expect((await post(a.hook, deleted({ chat: 2402, ids: [7] }))).status).toBe(200);
    await intake();
    expect(await threadRow(a, `b:2402:${CONN}`)).toMatchObject({ status: 'resolved' });
  });
});
