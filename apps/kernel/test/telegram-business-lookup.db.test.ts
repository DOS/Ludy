// SPDX-License-Identifier: AGPL-3.0-only
// Reading a Telegram Business connection back (#3224, plan docs/plan/conversations-channels.md section 4.2 point 10) on PostgreSQL 17: an owner who added the
// chatbot in Telegram before turning chats on in Ludy never sent Ludy the `business_connection` update, so a customer's message names a connection the
// connection's list does not hold. The intake asks Telegram once with `getBusinessConnection` (a recorded answer here, never a live call), records an enabled
// one exactly as the update would have (as an account nobody has allowed yet), and the account's chats are taken in once an owner allows it. A disabled, unknown
// or failed answer records nothing; the same id is not asked twice in a window. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { BUSINESS_LOOKUP_PER_CONNECTION, BUSINESS_LOOKUP_WINDOW_MS, runConversationIntake, runTelegramChatHook, type BusinessLookup } from '../src/conversations-worker.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-telegram-lookup-0123456789-abcdefghij';
const BASE = '/api/channels/telegram/webhook';
const TOKEN = '555555555:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5';
const APP_URL = 'https://ludy.example.com';
// Business connection ids as Telegram makes them: printable characters.
const ENABLED = 'EnAbLeD-111_xyz=';
const DISABLED = 'DiSaBlEd-222_xyz=';
const REFUSED = 'ReFuSeD-333_xyz=';
const OTHER = 'OtHeR-444_xyz=';
const OWNER_TG = 910;

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

suite('Telegram Business connection read back on PostgreSQL (#3224)', () => {
  const dbName = `crove_test_telegram_lookup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let api: Runtime;
  let vault: CredentialVault;
  let orgId = '';
  let ownerId = '';
  let connectionId = '';
  let hook = '';
  let updateId = 9000;
  let clock = Date.now();
  const logs: string[] = [];
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
  const derived = () => vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key);
  const post = (body: string) => app.request(`${BASE}/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': telegramHookSecret(derived()[0] as Buffer, hook) }, body });
  const asOwner = () => ({ actor: { type: 'user' as const, userId: ownerId, aal: 'aal1' as const }, orgId });
  const accounts = async () => (await rows<{ chat_business: Array<{ id: string; userId: string; name: string | null; username: string | null; canReply: boolean; enabled: boolean; approved: boolean }> }>('SELECT chat_business FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId]))[0]?.chat_business ?? [];
  const messagesOf = (thread: string) =>
    rows<{ body: string }>('SELECT m.body FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id WHERE m.org_id = $1 AND c.external_thread_id = $2 ORDER BY m.seq', [orgId, thread]);
  const business = (text: string, o: { chat: number; messageId: number; connectionId: string }) =>
    JSON.stringify({
      update_id: updateId++,
      business_message: { message_id: o.messageId, business_connection_id: o.connectionId, from: { id: o.chat, is_bot: false, first_name: 'Khách' }, chat: { id: o.chat, first_name: 'Khách', type: 'private' }, date: nowSec(), text },
    });
  // The answer of getBusinessConnection: the same object a `business_connection` update carries [O].
  const answer = (id: string, over: Record<string, unknown> = {}) => ({
    body: { ok: true, result: { id, user: { id: OWNER_TG, first_name: 'Lan', last_name: 'Trần', username: 'lan_tran' }, user_chat_id: OWNER_TG, date: nowSec(), rights: { can_reply: true }, is_enabled: true, ...over } },
  });
  const refuse = (status: number, description: string) => ({ status, body: { ok: false, error_code: status, description } });

  function telegram(answers: Record<string, Array<{ status?: number; body: unknown }>> = {}) {
    const calls: Array<{ method: string; token: string; json: Record<string, unknown> }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
      calls.push({ method, token: tokenPart.replace(/^bot/, ''), json: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      const next = answers[method]?.shift() ?? { body: { ok: true, result: true } };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }
  // The lookup the worker passes the intake, with the clock the test moves.
  const lookupWith = (t: ReturnType<typeof telegram>): BusinessLookup => {
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    return { broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), now: () => clock };
  };
  const intake = (businessLookup?: BusinessLookup) => runConversationIntake({ workerDb, runtime: worker, log: (m) => logs.push(m), ...(businessLookup ? { businessLookup } : {}) });

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
    // A bot connected with chats on, as an owner does it in Ludy: this time the owner had already added the chatbot in Telegram, so no update came.
    ownerId = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@telegram-lookup.test`, name: null })) as string;
    orgId = (await createOrg(api, { type: 'user', userId: ownerId, aal: 'aal1' }, 'Công ty tra lại')).orgId;
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN, username: null }), { orgId, provider: 'telegram', externalAccountId: '-1005555555555' });
    connectionId = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'telegram', externalAccountId: '-1005555555555', displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        asOwner(),
      )
    ).connectionId;
    await api.execute('kernel.channel.telegram_chat_set', { connectionId, on: true }, asOwner());
    const t = telegram();
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId, connectionId, action: 'chat', on: true })).toBe('on');
    hook = ((await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId]))[0] as { chat_hook: string }).chat_hook;
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('ignores a message of an unknown business connection when the deployment has no lookup, and asks Telegram nothing', async () => {
    expect((await post(business('Tin khi chưa có tra lại', { chat: 3000, messageId: 1, connectionId: OTHER }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await accounts()).toEqual([]);
    expect(await messagesOf(`b:3000:${OTHER}`)).toEqual([]);
  });

  it('asks Telegram once for an unknown id, records an enabled answer as an account nobody has allowed, and takes the account\'s chats once an owner allows it', async () => {
    const t = telegram({ getBusinessConnection: [answer(ENABLED)] });
    const lookup = lookupWith(t);
    expect((await post(business('Tin đầu tiên, trước khi cho phép', { chat: 3001, messageId: 1, connectionId: ENABLED }))).status).toBe(200);
    // The message that made Ludy look is not kept: nothing of an account is stored before a person allows it (plan 4.2 point 9).
    expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    expect(t.calls).toEqual([{ method: 'getBusinessConnection', token: TOKEN, json: { business_connection_id: ENABLED } }]);
    expect(await accounts()).toEqual([{ id: ENABLED, userId: String(OWNER_TG), name: 'Lan Trần', username: 'lan_tran', canReply: true, enabled: true, approved: false }]);
    expect(await messagesOf(`b:3001:${ENABLED}`)).toEqual([]);
    // The screen lists it as waiting, without the ids.
    const list = await api.query<Array<{ id: string; chatBusiness: Array<{ ref: string; approved: boolean }> }>>('kernel.channel.list', {}, asOwner());
    const shown = list.find((c) => c.id === connectionId)?.chatBusiness ?? [];
    expect(shown).toEqual([{ ref: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'Lan Trần', username: 'lan_tran', enabled: true, canReply: true, approved: false }]);
    expect(JSON.stringify(list)).not.toContain(ENABLED);
    // A second message of the same id before the owner allows: the id is known now (nothing to look up), and it is still not stored.
    expect((await post(business('Tin thứ hai, vẫn chưa cho phép', { chat: 3001, messageId: 2, connectionId: ENABLED }))).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    expect(t.calls).toHaveLength(1);
    // The owner allows it; from then on the account's messages are in Hộp thư, and Telegram is not asked again.
    expect(await api.execute('kernel.channel.telegram_business_allow', { connectionId, ref: (shown[0] as { ref: string }).ref, allow: true }, asOwner())).toEqual({ approved: true });
    expect((await post(business('Tin sau khi cho phép', { chat: 3001, messageId: 3, connectionId: ENABLED }))).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 1, dropped: 0 });
    expect((await messagesOf(`b:3001:${ENABLED}`)).map((m) => m.body)).toEqual(['Tin sau khi cho phép']);
    expect(t.calls).toHaveLength(1);
    // Neither the audit log nor an event holds the business connection id, the account's id or its name.
    for (const needle of [ENABLED, 'Lan Trần', 'lan_tran']) {
      expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1', [`%${needle}%`])).length).toBe(0);
      expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE payload::text LIKE $1', [`%${needle}%`])).length).toBe(0);
    }
  });

  it('records nothing for a connection Telegram says is off, asks once inside the window and again after it', async () => {
    const t = telegram({ getBusinessConnection: [answer(DISABLED, { is_enabled: false }), answer(DISABLED, { is_enabled: false })] });
    const lookup = lookupWith(t);
    const before = await accounts();
    expect((await post(business('Tin của kết nối đã tắt', { chat: 3002, messageId: 1, connectionId: DISABLED }))).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    expect(t.calls).toHaveLength(1);
    expect(await accounts()).toEqual(before);
    // A second message of the same id inside the window makes no second call.
    expect((await post(business('Tin thứ hai của kết nối đã tắt', { chat: 3002, messageId: 2, connectionId: DISABLED }))).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    expect(t.calls).toHaveLength(1);
    // After the window the owner may have turned it on again in Telegram: it is asked once more.
    clock += BUSINESS_LOOKUP_WINDOW_MS + 1;
    expect((await post(business('Tin sau cửa sổ', { chat: 3002, messageId: 3, connectionId: DISABLED }))).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    expect(t.calls).toHaveLength(2);
    expect(await accounts()).toEqual(before);
    expect(logs.some((l) => l.includes('read back: disabled'))).toBe(true);
  });

  it('ignores the message and logs a short code when Telegram refuses, the id is unknown, the answer is another connection or the credential is gone, and never repeats inside the window', async () => {
    const t = telegram({
      getBusinessConnection: [refuse(400, `Bad Request: business connection ${REFUSED} not found for ${TOKEN}`), answer('SomeoneElse-9_x='), refuse(401, 'Unauthorized'), refuse(502, 'Bad Gateway')],
    });
    const lookup = lookupWith(t);
    const before = await accounts();
    logs.length = 0;
    const ids = [REFUSED, 'MiSmAtCh-555_x=', 'TokenGone-666_x=', 'Down-777_x='];
    for (const [i, id] of ids.entries()) {
      expect((await post(business(`Tin ${i}`, { chat: 3003 + i, messageId: 1, connectionId: id }))).status).toBe(200);
      expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
      // A second message of the same id inside the window: no second call, whatever came of the first.
      expect((await post(business(`Tin lại ${i}`, { chat: 3003 + i, messageId: 2, connectionId: id }))).status).toBe(200);
      expect(await intake(lookup)).toEqual({ stored: 0, dropped: 0 });
    }
    expect(t.calls.map((c) => c.method)).toEqual(['getBusinessConnection', 'getBusinessConnection', 'getBusinessConnection', 'getBusinessConnection']);
    expect(await accounts()).toEqual(before);
    // The log holds the codes and nothing else: not Telegram's words, an id, the token or an address.
    const text = logs.join('\n');
    for (const code of ['TG_BUSINESS_UNKNOWN', 'TG_BUSINESS_MISMATCH', 'TELEGRAM_TOKEN_REFUSED', 'TELEGRAM_502']) expect(text).toContain(code);
    for (const secret of [TOKEN, '555555555:', REFUSED, ...ids, 'not found', 'Unauthorized', 'Bad Gateway', 'api.telegram.org']) expect(text).not.toContain(secret);
  });

  it('gives one connection at most a few lookups in a window, however many ids its messages name', async () => {
    const t = telegram();
    const lookup = lookupWith(t);
    const many = Array.from({ length: BUSINESS_LOOKUP_PER_CONNECTION + 3 }, (_, i) => `Flood-${i}_x=`);
    for (const [i, id] of many.entries()) expect((await post(business(`Ngập ${i}`, { chat: 3100 + i, messageId: 1, connectionId: id }))).status).toBe(200);
    await intake(lookup);
    expect(t.calls).toHaveLength(BUSINESS_LOOKUP_PER_CONNECTION);
    // The ones that were over the cap are asked in the next window, not at once.
    await intake(lookup);
    expect(t.calls).toHaveLength(BUSINESS_LOOKUP_PER_CONNECTION);
  });

  it('does not look anything up for a business_connection update, a bot chat message, or a connection whose chats are off', async () => {
    const t = telegram();
    const lookup = lookupWith(t);
    const update = JSON.stringify({ update_id: updateId++, business_connection: { id: 'FromUpdate-1_x=', user: { id: OWNER_TG, first_name: 'Lan', username: 'lan_tran' }, user_chat_id: OWNER_TG, date: nowSec(), rights: { can_reply: true }, is_enabled: true } });
    expect((await post(update)).status).toBe(200);
    const bot = JSON.stringify({ update_id: updateId++, message: { message_id: 4, from: { id: 3300, is_bot: false, first_name: 'Khách' }, chat: { id: 3300, type: 'private' }, date: nowSec(), text: 'Tin qua bot' } });
    expect((await post(bot)).status).toBe(200);
    expect(await intake(lookup)).toEqual({ stored: 1, dropped: 0 });
    expect(t.calls).toHaveLength(0);
    expect((await accounts()).some((a) => a.id === 'FromUpdate-1_x=')).toBe(true);
    // Chats switched off: the connection takes no business notice, so there is nothing to look up for.
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'off', chat_hook = NULL WHERE org_id = $1 AND id = $2", [orgId, connectionId]);
    const known = await worker.query<{ lookup: boolean }>('kernel.channel.telegram_business_known', { connectionId, id: 'NotListed-1_x=' }, { actor: { type: 'system', component: 'test' }, orgId });
    expect(known).toEqual({ lookup: false });
    await rows("UPDATE crove_kernel.channel_connection SET chat_state = 'on', chat_hook = $3 WHERE org_id = $1 AND id = $2", [orgId, connectionId, hook]);
    expect(await worker.query('kernel.channel.telegram_business_known', { connectionId, id: 'NotListed-1_x=' }, { actor: { type: 'system', component: 'test' }, orgId })).toEqual({ lookup: true });
    expect(await worker.query('kernel.channel.telegram_business_known', { connectionId, id: ENABLED }, { actor: { type: 'system', component: 'test' }, orgId })).toEqual({ lookup: false });
  });
});
