// SPDX-License-Identifier: AGPL-3.0-only
// Telegram bot chats on PostgreSQL 17 (conversation core, #3132, plan docs/plan/conversations-channels.md section 4.2): the route exists only where
// Telegram is on and the credential key can derive the secret; it checks the secret header derived from the hook in the path before it reads the
// body or asks the database, and refuses a wrong one with one answer that says nothing; it caps the body; it parks only a verified private-chat
// message, names no org in its path or answer and writes no tenant row; two bots on one deployment reach their own connections; the worker takes a
// parked update into the customer's thread under the org that holds the hook, once; chats are turned on and off through a command and a job that
// sets and deletes the webhook with the sealed token; and a reply goes out through sendMessage exactly once. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser
// URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TELEGRAM_CHAT_UPDATES, TELEGRAM_HOOK_KEY_INFO, TELEGRAM_MAX_NOTICE_BYTES, TelegramPublisher, telegramHookSecret, TelegramConversations, wrapTelegramChatNotice, type ConversationAdapter, type Fetch } from '@ludy/channel';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { EXPORT_TABLES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { failChatHook, reconcileTelegramDisplacements, rekeyTelegramWebhooks, runConversationIntake, runConversationJob, runTelegramChatHook } from '../src/conversations-worker.ts';
import { TELEGRAM_REPLAY_WINDOW_MS, TelegramReplayCache } from '../src/telegram-webhook.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-telegram-0123456789-abcdefghij';
const ISSUER = 'ludy-auth';
const BASE = '/api/channels/telegram/webhook';
// Two bots of two orgs on one deployment: the token's number before the colon is the bot's id.
const TOKEN_A = '111111111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
const TOKEN_B = '222222222:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2';
const CHANNEL_A = '-1001111111111';
const CHANNEL_B = '-1002222222222';
const APP_URL = 'https://ludy.example.com';

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
  token: string;
}

suite('the Telegram bot chats webhook on PostgreSQL (#3132)', () => {
  const dbName = `ludy_test_telegram_webhook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let bare: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let api: Runtime;
  let appConfig: ReturnType<typeof loadConfig>;
  let appDb: Db;
  let vaultKey1: ReturnType<typeof parseVaultKey>;
  let vault: CredentialVault;
  let a: Org;
  let b: Org;
  let hookA = '';
  let hookB = '';
  // The route's clock: the fixtures are dated within a day of it (a message older than two days is not parked).
  const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
  const sec = (ms: number) => Math.floor(ms / 1000);

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
  const waiting = async () => (await rows('SELECT 1 FROM ludy_kernel.conversation_inbound_pending')).length;
  const derived = () => vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key);
  const secretOf = (hook: string) => telegramHookSecret(derived()[0] as Buffer, hook);
  const post = (target: ReturnType<typeof createHttpApp>, hook: string, body: string, headers: Record<string, string> = {}) =>
    target.request(`${BASE}/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const signed = (hook: string) => ({ 'x-telegram-bot-api-secret-token': secretOf(hook) });
  let updateId = 1000;
  const update = (text: string, over: { messageId?: number; chat?: number; date?: number; from?: Record<string, unknown>; chatType?: string; extra?: Record<string, unknown> } = {}) =>
    JSON.stringify({
      update_id: updateId++,
      message: {
        message_id: over.messageId ?? updateId,
        from: { id: over.chat ?? 777, is_bot: false, first_name: 'An', last_name: 'Nguyễn', username: 'an_ng', ...over.from },
        chat: { id: over.chat ?? 777, first_name: 'An', type: over.chatType ?? 'private' },
        date: over.date ?? sec(NOW - 60_000),
        text,
        ...over.extra,
      },
    });
  const intake = () => runConversationIntake({ workerDb, runtime: worker });
  const commonDeps = () => ({ config: appConfig, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(appConfig, appDb), pool: pools[0] as pg.Pool, aiEnabled: false });
  const asOwner = (o: Org) => ({ actor: { type: 'user' as const, userId: o.ownerId, aal: 'aal1' as const }, orgId: o.orgId });

  const liveUrls = new Map<string, string>();
  // A Telegram that answers every method with ok, tracks each bot's live webhook URL across calls, and records what it was asked.
  function telegram(answers: Record<string, { status?: number; body: unknown }[]> = {}) {
    const calls: Array<{ method: string; token: string; json: Record<string, unknown> }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
      const token = tokenPart.replace(/^bot/, '');
      const json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, token, json });
      const explicit = answers[method]?.shift();
      if (explicit) {
        if ((explicit.status ?? 200) === 200 && method === 'setWebhook') liveUrls.set(token, String(json.url ?? ''));
        if ((explicit.status ?? 200) === 200 && method === 'deleteWebhook') liveUrls.delete(token);
        return new Response(JSON.stringify(explicit.body), { status: explicit.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'setWebhook') liveUrls.set(token, String(json.url ?? ''));
      if (method === 'deleteWebhook') liveUrls.delete(token);
      const result = method === 'sendMessage' ? { message_id: 9001 } : method === 'getWebhookInfo' ? { url: liveUrls.get(token) ?? '' } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  async function connectBot(name: string, token: string, channel: string): Promise<Org> {
    const ownerId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@telegram.test`, name: null })) as string;
    const orgId = (await createOrg(api, { type: 'user', userId: ownerId, aal: 'aal1' }, name)).orgId;
    const sealed = vault.seal(JSON.stringify({ botToken: token, username: null }), { orgId, provider: 'telegram', externalAccountId: channel });
    const connectionId = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'telegram', externalAccountId: channel, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: { type: 'user', userId: ownerId, aal: 'aal1' }, orgId },
      )
    ).connectionId;
    return { orgId, ownerId, connectionId, token };
  }

  // The worker's side of the switch: the Telegram adapter over a recorded Telegram.
  const hookDeps = (fetchImpl: Fetch, baseUrl = APP_URL) => {
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: fetchImpl })).conversations;
    return { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined), baseUrl, workerDb };
  };

  // Turns chats on through the command and runs the job the relay would queue, against a recorded Telegram. Returns the hook the connection got.
  async function turnOn(o: Org): Promise<{ hook: string; calls: ReturnType<typeof telegram>['calls'] }> {
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: true }, asOwner(o));
    const t = telegram();
    const outcome = await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: o.orgId, connectionId: o.connectionId, action: 'chat', on: true });
    expect(outcome).toBe('on');
    const [row] = await rows<{ chat_hook: string }>('SELECT chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId]);
    return { hook: (row as { chat_hook: string }).chat_hook, calls: t.calls };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    vaultKey1 = parseVaultKey(randomBytes(32).toString('base64'));
    vault = new CredentialVault([vaultKey1]);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    appConfig = config;
    appDb = db;
    const common = { config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...common, telegramWebhook: { keys: derived, now: () => NOW } });
    bare = createHttpApp(common);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    a = await connectBot('Công ty Telegram A', TOKEN_A, CHANNEL_A);
    b = await connectBot('Công ty Telegram B', TOKEN_B, CHANNEL_B);
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('turns chats on: the command makes a hook, the job sets the webhook with the derived secret and the sealed token, and the state is on', async () => {
    const asked = await api.execute<{ chatState: string }>('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: true }, asOwner(a));
    expect(asked).toEqual({ chatState: 'enabling' });
    // A second ask while it is enabling changes nothing (no second hook, no second job).
    // The hook being set waits in chat_hook_next; there is no live one yet.
    const [before] = await rows<{ chat_hook: string | null; chat_hook_next: string; chat_state: string }>('SELECT chat_hook, chat_hook_next, chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId]);
    expect(before?.chat_state).toBe('enabling');
    expect(before?.chat_hook).toBeNull();
    expect(before?.chat_hook_next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: true }, asOwner(a))).toEqual({ chatState: 'enabling' });
    const [same] = await rows<{ chat_hook_next: string }>('SELECT chat_hook_next FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId]);
    expect(same?.chat_hook_next).toBe(before?.chat_hook_next);
    const t = telegram();
    const outcome = await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: true });
    expect(outcome).toBe('on');
    expect(outcome).not.toContain(before?.chat_hook_next as string);
    hookA = before?.chat_hook_next as string;
    // One setWebhook with this bot's token, the hook in the path, the derived secret as secret_token, and only private messages asked for.
    expect(t.calls).toEqual([{ method: 'setWebhook', token: TOKEN_A, json: { url: `${APP_URL}${BASE}/${hookA}`, secret_token: secretOf(hookA), allowed_updates: [...TELEGRAM_CHAT_UPDATES] } }]);
    // The hook being set is the live one now, and the connection remembers its bot and signing key id.
    expect(await rows('SELECT chat_state, chat_error, chat_bot_id, chat_hook, chat_hook_next, chat_hook_key_id FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'on', chat_error: null, chat_bot_id: '111111111', chat_hook: hookA, chat_hook_next: null, chat_hook_key_id: vault.keyId }]);
    // The same job again finds the connection already on and calls nothing.
    expect(await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: true })).toBe('none');
    expect(t.calls).toHaveLength(1);
    // Only an owner or an admin may; a viewer is refused and a connection of another provider is not a bot.
    for (const role of ['member', 'viewer'] as const) {
      const personId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${role}-${randomUUID().slice(0, 8)}@telegram.test`, name: null })) as string;
      await rows('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [a.orgId, personId, role]);
      await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, { actor: { type: 'user', userId: personId, aal: 'aal1' }, orgId: a.orgId })).rejects.toMatchObject({ status: 403 });
    }
    // The export of the org never carries a hook.
    expect(EXPORT_TABLES['kernel.channel_connection'].omit).toEqual(expect.arrayContaining(['chat_hook', 'chat_hook_next']));
    // The hook is a capability: neither the audit log nor the events hold it.
    expect((await rows('SELECT 1 FROM ludy_kernel.audit_event WHERE detail::text LIKE $1', [`%${hookA}%`])).length).toBe(0);
    expect((await rows('SELECT 1 FROM ludy_kernel.outbox_event WHERE payload::text LIKE $1', [`%${hookA}%`])).length).toBe(0);
  });

  it('does not exist without the credential key: it answers as a path nobody registered does', async () => {
    const body = update('xin chào');
    const unregistered = await bare.request('/api/channels/nobody/webhook', { method: 'POST', body });
    const answer = await post(bare, hookA, body, signed(hookA));
    expect([answer.status, await answer.text()]).toEqual([unregistered.status, await unregistered.text()]);
    expect(await waiting()).toBe(0);
  });

  it('refuses a missing, malformed or wrong secret, a wrong hook and an unknown hook with one answer, and parks and stores nothing', async () => {
    const body = update('Nội dung không được lưu');
    const unknownHook = randomBytes(32).toString('base64url');
    const answers = await Promise.all(
      [
        [hookA, {}],
        [hookA, { 'x-telegram-bot-api-secret-token': 'short' }],
        [hookA, { 'x-telegram-bot-api-secret-token': '0'.repeat(43) }],
        [hookA, { 'x-telegram-bot-api-secret-token': 'x'.repeat(43) }],
        // A hook nobody was given, with the secret of a real one: a secret is good for its own hook's path only.
        [unknownHook, signed(hookA)],
        [unknownHook, { 'x-telegram-bot-api-secret-token': unknownHook }],
        // Ids that are no hook at all, whatever header they carry.
        ['not-a-hook', signed('not-a-hook')],
        [hookA.slice(0, 42), signed(hookA.slice(0, 42))],
        [`${hookA}a`, signed(`${hookA}a`)],
      ].map(async ([hook, headers]) => {
        const r = await post(app, hook as string, body, headers as Record<string, string>);
        return { status: r.status, body: await r.text() };
      }),
    );
    // The secret of the other bot is a valid one for ITS hook only: it opens nothing on this one.
    hookB = (await turnOn(b)).hook;
    const crossed = await post(app, hookA, body, signed(hookB));
    answers.push({ status: crossed.status, body: await crossed.text() });
    for (const answer of answers) expect(answer).toEqual({ status: 401, body: '{"code":"WEBHOOK_SIGNATURE"}' });
    expect(await waiting()).toBe(0);
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
  });

  it('refuses before it reads the body: a wrong secret with a body that is no JSON is the same 401, not a 400', async () => {
    const response = await post(app, hookA, '{ not json', {});
    expect([response.status, await response.text()]).toEqual([401, '{"code":"WEBHOOK_SIGNATURE"}']);
    // With the right secret the same body is a malformed update.
    const verified = await post(app, hookA, '{ not json', signed(hookA));
    expect([verified.status, await verified.text()]).toEqual([400, '{"code":"WEBHOOK_MALFORMED"}']);
    const noId = await post(app, hookA, '{"message":{}}', signed(hookA));
    expect(noId.status).toBe(400);
    expect(await waiting()).toBe(0);
  });

  it('refuses a wrong secret before any body handling: an oversized body with no secret is the same 401, not a 413', async () => {
    const big = JSON.stringify({ update_id: 1, pad: 'a'.repeat(TELEGRAM_MAX_NOTICE_BYTES) });
    const response = await post(app, hookA, big, {});
    expect([response.status, await response.text()]).toEqual([401, '{"code":"WEBHOOK_SIGNATURE"}']);
    expect(await waiting()).toBe(0);
  });

  it('refuses a body over its cap before reading it, even with a valid secret', async () => {
    const big = JSON.stringify({ update_id: 1, pad: 'a'.repeat(TELEGRAM_MAX_NOTICE_BYTES) });
    const response = await post(app, hookA, big, signed(hookA));
    expect(response.status).toBe(413);
    expect(await waiting()).toBe(0);
  });

  it('parks a verified message, names no org, and writes no tenant row; the worker stores it in the customer\'s thread under the org of the hook', async () => {
    const body = update('Shop còn hàng không?', { messageId: 11 });
    const response = await post(app, hookA, body, signed(hookA));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(await waiting()).toBe(1);
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
    expect(await rows('SELECT provider FROM ludy_kernel.conversation_inbound_pending')).toEqual([{ provider: 'telegram_chat' }]);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await waiting()).toBe(0);
    const seen = await rows(
      "SELECT m.body, m.direction, m.tainted, m.seq, c.kind, c.external_thread_id, c.reply_window_until IS NULL AS no_window, i.external_user_id, i.display_name, i.provider FROM ludy_kernel.conversation_message m JOIN ludy_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id JOIN ludy_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id WHERE m.org_id = $1",
      [a.orgId],
    );
    // A bot may answer at any time: no window. The customer is the sender, the thread is the chat, the text is tainted.
    expect(seen).toEqual([{ body: 'Shop còn hàng không?', direction: 'in', tainted: true, seq: 1, kind: 'direct', external_thread_id: '777', no_window: true, external_user_id: '777', display_name: 'An Nguyễn', provider: 'telegram' }]);
  });

  it('routes two bots of one deployment to their own connections: each hook reaches only its own org', async () => {
    const forA = update('Gửi cho bot A', { chat: 501, messageId: 21 });
    const forB = update('Gửi cho bot B', { chat: 502, messageId: 22 });
    expect((await post(app, hookA, forA, signed(hookA))).status).toBe(200);
    expect((await post(app, hookB, forB, signed(hookB))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    const onA = await rows<{ body: string }>('SELECT body FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body LIKE $2', [a.orgId, 'Gửi cho bot%']);
    const onB = await rows<{ body: string }>('SELECT body FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body LIKE $2', [b.orgId, 'Gửi cho bot%']);
    expect(onA).toEqual([{ body: 'Gửi cho bot A' }]);
    expect(onB).toEqual([{ body: 'Gửi cho bot B' }]);
  });

  it('answers a replayed message without parking it again for two days, and parks one whose first try was refused', async () => {
    let clock = Date.now();
    const replays = new TelegramReplayCache(() => clock);
    const replaying = createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived, now: () => NOW }, telegramReplays: replays });
    const body = update('Gửi lại nhiều lần', { chat: 601, messageId: 31 });
    const send = () => post(replaying, hookA, body, signed(hookA));
    expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(1);
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(1);
    const other = update('Tin khác', { chat: 601, messageId: 32 });
    expect((await post(replaying, hookA, other, signed(hookA))).status).toBe(200);
    expect(await waiting()).toBe(2);
    clock += TELEGRAM_REPLAY_WINDOW_MS + 1;
    expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(3);
    // The unique message id keeps the thread to one copy however often the update was parked.
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body = 'Gửi lại nhiều lần'", [a.orgId])).toHaveLength(1);
    // A secret that fails never reaches the cache, so a forged body cannot make a real one look replayed.
    const real = update('Thật', { chat: 601, messageId: 33 });
    expect((await post(replaying, hookA, real, {})).status).toBe(401);
    expect((await post(replaying, hookA, real, signed(hookA))).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
  });

  it('answers 200 and parks nothing for a group, an edit, a bot, a message older than two days and a service message, and says 503 past ten thousand waiting', async () => {
    const ok = async (body: string) => (await post(app, hookA, body, signed(hookA))).status;
    expect(await ok(update('Trong nhóm', { chatType: 'supergroup', chat: -100777 }))).toBe(200);
    expect(await ok(JSON.stringify({ update_id: 5, edited_message: { message_id: 1, chat: { id: 777, type: 'private' }, from: { id: 777 }, date: sec(NOW), text: 'sửa' } }))).toBe(200);
    expect(await ok(update('Bot nói', { from: { is_bot: true } }))).toBe(200);
    expect(await ok(update('Cũ', { date: sec(NOW - 3 * 86_400_000), messageId: 41 }))).toBe(200);
    expect(await ok(JSON.stringify({ update_id: 6, message: { message_id: 2, chat: { id: 777, type: 'private' }, from: { id: 777 }, date: sec(NOW), pinned_message: {} } }))).toBe(200);
    expect(await waiting()).toBe(0);
    await rows("INSERT INTO ludy_kernel.conversation_inbound_pending (provider, body) SELECT 'telegram_chat', 'x'::bytea FROM generate_series(1, 10001)");
    const fresh = update('Hàng đợi đầy', { chat: 701, messageId: 51 });
    const response = await post(app, hookA, fresh, signed(hookA));
    expect([response.status, await response.text()]).toEqual([503, '{"code":"BACKLOG"}']);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');
    expect((await post(app, hookA, fresh, signed(hookA))).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
  });

  it('is not refused for the sandbox\'s backlog: the cap is per provider', async () => {
    await rows("INSERT INTO ludy_kernel.conversation_inbound_pending (provider, body) SELECT 'sandbox', 'x'::bytea FROM generate_series(1, 1000)");
    const real = update('Tin thật vẫn nhận', { chat: 801, messageId: 61 });
    expect((await post(app, hookA, real, signed(hookA))).status).toBe(200);
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_inbound_pending WHERE provider = 'telegram_chat'")).toHaveLength(1);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');
  });

  it('logs nothing of the body it parks or refuses, the hook or the secret', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
      return () => void (console[level] = original);
    });
    try {
      const secretText = 'số điện thoại 0912345678 của Nguyễn Văn Mẫu';
      const good = update(secretText, { chat: 901, messageId: 71 });
      await post(app, hookA, good, signed(hookA));
      await post(app, hookA, good, {});
      await post(app, hookA, '{ not json', signed(hookA));
      await intake();
    } finally {
      for (const restore of spies) restore();
    }
    const log = lines.join(' | ');
    expect(log).not.toMatch(/0912345678|Nguyễn Văn Mẫu|901/);
    expect(log).not.toContain(hookA);
    expect(log).not.toContain(secretOf(hookA));
    expect(log).not.toContain(TOKEN_A);
  });

  it('takes a redelivered or out-of-order update once, and a hook with no connection nowhere', async () => {
    const first = update('Tin đến trước', { chat: 1001, messageId: 81, date: sec(NOW - 120_000) });
    const later = update('Tin đến sau', { chat: 1001, messageId: 82, date: sec(NOW - 60_000) });
    for (const body of [later, first, later]) expect((await post(app, hookA, body, signed(hookA))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    const seen = await rows<{ body: string; seq: number }>("SELECT body, seq FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body LIKE 'Tin đến%' ORDER BY seq", [a.orgId]);
    expect(seen.map((m) => m.body).sort()).toEqual(['Tin đến sau', 'Tin đến trước']);
    // A hook whose connection was turned off: the secret still derives (nothing is stored), so the update is parked, claimed, found nowhere, deleted.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook = NULL, chat_state = 'off' WHERE org_id = $1 AND id = $2", [b.orgId, b.connectionId]);
    const stranger = update('Gửi cho hook cũ', { chat: 1002, messageId: 83 });
    expect((await post(app, hookB, stranger, signed(hookB))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await waiting()).toBe(0);
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_message WHERE body = 'Gửi cho hook cũ'")).toHaveLength(0);
    // Put the other bot back on for the tests after.
    hookB = (await turnOn(b)).hook;
  });

  it('answers 429 past its rate limit for refused requests only', async () => {
    const limited = createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived }, telegramWebhookLimit: new RateLimiter({ perMinute: 2 }) });
    const body = update('x');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(limited, hookA, body, {})).status);
    expect(statuses).toEqual([401, 401, 429]);
    // Only refused requests are charged: with the bucket of this address spent, a verified update from it is still answered.
    const edit = JSON.stringify({ update_id: 9, edited_message: {} });
    expect((await post(limited, hookA, edit, signed(hookA))).status).toBe(200);
    expect((await post(limited, hookA, body, {})).status).toBe(429);
  });

  it('takes a secret derived under the key it replaces during a rotation, and refuses any other key', async () => {
    const oldKey = Buffer.alloc(32, 3);
    const rotating = createHttpApp({ ...commonDeps(), telegramWebhook: { keys: () => [Buffer.alloc(32, 5), oldKey], now: () => NOW } });
    const body = update('Ký bằng khóa cũ', { chat: 1101, messageId: 91 });
    expect((await post(rotating, hookA, body, { 'x-telegram-bot-api-secret-token': telegramHookSecret(oldKey, hookA) })).status).toBe(200);
    expect((await post(rotating, hookA, body, { 'x-telegram-bot-api-secret-token': telegramHookSecret(Buffer.alloc(32, 5), hookA) })).status).toBe(200);
    expect((await post(rotating, hookA, body, { 'x-telegram-bot-api-secret-token': telegramHookSecret(Buffer.alloc(32, 8), hookA) })).status).toBe(401);
    // Without the old key in the list the old secret is refused.
    expect((await post(app, hookA, body, { 'x-telegram-bot-api-secret-token': telegramHookSecret(oldKey, hookA) })).status).toBe(401);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');
  });

  it('answers the customer through sendMessage once, with no window, and the reply is the business\'s own message', async () => {
    const now = sec(Date.now());
    const incoming = update('Còn hàng không shop?', { chat: 1201, messageId: 101, date: now });
    expect((await post(createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived } }), hookA, incoming, signed(hookA))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    const thread = (await rows<{ id: string; last_seq: number }>("SELECT id, last_seq FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1201'", [a.orgId]))[0] as { id: string; last_seq: number };
    const t = telegram({ sendMessage: [{ body: { ok: true, result: { message_id: 5551 } } }] });
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined) };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ shop còn hàng ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    const job = { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' as const };
    expect(await runConversationJob(deps, job)).toBe('accepted');
    expect(t.calls).toEqual([{ method: 'sendMessage', token: TOKEN_A, json: { chat_id: '1201', text: 'Dạ shop còn hàng ạ' } }]);
    expect(await rows('SELECT send_state, external_message_id FROM ludy_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ send_state: 'sent', external_message_id: '1201:5551' }]);
    // The same job again calls nothing: a reply is sent exactly once.
    expect(await runConversationJob(deps, job)).toBe('settled');
    expect(t.calls).toHaveLength(1);
    // No window to close: the screen's reply state is allowed, and a long-ago customer message can still be answered.
    await rows("UPDATE ludy_kernel.conversation SET last_inbound_at = now() - interval '40 days' WHERE org_id = $1 AND id = $2", [a.orgId, thread.id]);
    const detail = await api.query<{ reply: { allowed: boolean; reason: string | null } }>('kernel.conversation.get', { conversationId: thread.id }, asOwner(a));
    expect(detail.reply).toEqual({ allowed: true, reason: null });
    // A comment is not a chat, and hiding is not offered.
    await expect(api.execute('kernel.conversation.hide', { messageId, hidden: true }, asOwner(a))).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
  });

  it('maps a blocked bot to a refused reply a person can read, and never sends a second time on its own', async () => {
    const now = sec(Date.now());
    const incoming = update('Hỏi giá', { chat: 1301, messageId: 111, date: now });
    expect((await post(createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived } }), hookA, incoming, signed(hookA))).status).toBe(200);
    await intake();
    const thread = (await rows<{ id: string; last_seq: number }>("SELECT id, last_seq FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1301'", [a.orgId]))[0] as { id: string; last_seq: number };
    const t = telegram({ sendMessage: [{ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }] });
    const adapter = new TelegramConversations({ fetch: t.fetchImpl });
    const deps = { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined) };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ 100k ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' })).toBe('rejected');
    expect(await rows('SELECT send_state, send_error_code FROM ludy_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ send_state: 'failed', send_error_code: 'TELEGRAM_BOT_BLOCKED' }]);
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' })).toBe('settled');
    expect(t.calls).toHaveLength(1);
  });

  it('refuses a second connection of the same bot, turns chats off by deleting the webhook, and records a failure for the screen to word', async () => {
    // A second connection of org A to another channel with the same bot token: the same bot has one webhook, so enabling it is refused.
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN_A, username: null }), { orgId: a.orgId, provider: 'telegram', externalAccountId: '-1003333333333' });
    const second = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'telegram', externalAccountId: '-1003333333333', displayName: 'Kênh thứ hai', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        asOwner(a),
      )
    ).connectionId;
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second, on: true }, asOwner(a));
    const idle = telegram();
    expect(await runTelegramChatHook(hookDeps(idle.fetchImpl), { orgId: a.orgId, connectionId: second, action: 'chat', on: true })).toBe('failed:BOT_IN_USE');
    expect(idle.calls).toHaveLength(0);
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, second])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: 'BOT_IN_USE' }]);
    // A plain-http deployment cannot take a Telegram webhook: refused in words before any call.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second, on: true }, asOwner(a));
    await rows("UPDATE ludy_kernel.channel_connection SET chat_bot_id = NULL WHERE org_id = $1", [a.orgId]);
    expect(await runTelegramChatHook(hookDeps(idle.fetchImpl, 'http://localhost:8080'), { orgId: a.orgId, connectionId: second, action: 'chat', on: true })).toBe('failed:WEBHOOK_NEEDS_HTTPS');
    // Telegram refuses the address: recorded as a code, the connection is off again with nothing to delete.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second, on: true }, asOwner(a));
    const refusing = telegram({ setWebhook: [{ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' } }] });
    expect(await runTelegramChatHook(hookDeps(refusing.fetchImpl), { orgId: a.orgId, connectionId: second, action: 'chat', on: true })).toBe('failed:TELEGRAM_WEBHOOK_REFUSED');
    expect(await rows('SELECT chat_state, chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, second])).toEqual([{ chat_state: 'off', chat_hook: null }]);
    // Off: the command marks it disabling and keeps the hook until the job has deleted the webhook with this bot's token.
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, asOwner(a))).toEqual({ chatState: 'disabling' });
    expect(await rows('SELECT chat_state, chat_hook IS NOT NULL AS hooked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'disabling', hooked: true }]);
    // While it is being turned off an update on the hook is still taken in (nothing in flight is lost), and turning on again waits.
    await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: true }, asOwner(a))).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    const off = telegram();
    expect(await runTelegramChatHook(hookDeps(off.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: false })).toBe('off');
    expect(off.calls).toEqual([{ method: 'deleteWebhook', token: TOKEN_A, json: {} }]);
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: null }]);
    // A failed delete leaves it off in Ludy with the code for the screen: nothing is received any more either way.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: b.connectionId, on: false }, asOwner(b));
    const dead = telegram({ deleteWebhook: [{ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }] });
    expect(await runTelegramChatHook(hookDeps(dead.fetchImpl), { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: false })).toBe('failed:TELEGRAM_TOKEN_REFUSED');
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: 'TELEGRAM_TOKEN_REFUSED' }]);
    // Neither the hook, the secret nor the token is in anything the job returned or recorded.
    expect((await rows('SELECT 1 FROM ludy_kernel.audit_event WHERE detail::text LIKE $1 OR detail::text LIKE $2', [`%${TOKEN_A}%`, `%${hookA}%`])).length).toBe(0);
  });

  it('gives the hook up when the connection is disconnected, and refuses chats for a connection that is not a Telegram one', async () => {
    const { hook } = await turnOn(a);
    expect(await rows('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'on' }]);
    // While chats are on it is refused (the webhook is removed by turning off, which needs the token a disconnect forgets); turned off first it goes.
    await expect(api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { ...asOwner(a), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CHAT_IS_ON', status: 409 });
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, asOwner(a));
    const gone = telegram();
    expect(await runTelegramChatHook(hookDeps(gone.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: false })).toBe('off');
    expect(gone.calls.map((c) => c.method)).toEqual(['deleteWebhook']);
    await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { ...asOwner(a), idempotencyKey: randomUUID() });
    expect(await rows('SELECT chat_state, chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null }]);
    // An update still arriving on the old hook finds no connection and is dropped after storing nothing.
    expect((await post(app, hook, update('Đến hook cũ', { chat: 1401, messageId: 121 }), signed(hook))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_x' }), { orgId: b.orgId, provider: 'sandbox', externalAccountId: 'sandbox-1' });
    const sandbox = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'sandbox', externalAccountId: 'sandbox-1', displayName: 'Thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        asOwner(b),
      )
    ).connectionId;
    await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: sandbox, on: true }, asOwner(b))).rejects.toMatchObject({ code: 'CHAT_NOT_SUPPORTED' });
  });

  it('gives a reconnected connection a new hook and so a new secret, keeps the old hook valid until the new webhook is set, and sets it with the new token', async () => {
    // The bot of org B answers chats (the test before left it off with a failed delete).
    const old = (await turnOn(b)).hook;
    // The owner pastes the bot token again: the same account reconnects on the same row.
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN_B, username: null }), { orgId: b.orgId, provider: 'telegram', externalAccountId: CHANNEL_B });
    const again = await api.execute<{ connectionId: string; reconnected: boolean }>(
      'kernel.channel.connect',
      { provider: 'telegram', externalAccountId: CHANNEL_B, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      asOwner(b),
    );
    expect(again).toEqual({ connectionId: b.connectionId, reconnected: true });
    const [mid] = await rows<{ chat_hook: string; chat_hook_next: string; chat_state: string }>('SELECT chat_hook, chat_hook_next, chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId]);
    expect(mid?.chat_state).toBe('enabling');
    expect(mid?.chat_hook).toBe(old);
    expect(mid?.chat_hook_next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mid?.chat_hook_next).not.toBe(old);
    // Until the job has set the new webhook, Telegram still posts on the old hook: its updates are taken in, none is lost.
    expect((await post(app, old, update('Đến lúc đổi hook', { chat: 1601, messageId: 141 }), signed(old))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    const t = telegram();
    expect(await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: true })).toBe('on');
    const next = mid?.chat_hook_next as string;
    expect(t.calls).toEqual([{ method: 'setWebhook', token: TOKEN_B, json: { url: `${APP_URL}${BASE}/${next}`, secret_token: secretOf(next), allowed_updates: [...TELEGRAM_CHAT_UPDATES] } }]);
    expect(await rows('SELECT chat_state, chat_hook, chat_hook_next FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId])).toEqual([{ chat_state: 'on', chat_hook: next, chat_hook_next: null }]);
    // The secret of the old hook opens nothing on the new one, and an update still arriving on the old hook finds no connection.
    expect((await post(app, next, update('x'), signed(old))).status).toBe(401);
    expect((await post(app, old, update('Hook cũ đã bỏ', { chat: 1602, messageId: 142 }), signed(old))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    hookB = next;
    // The connect event of the reconnect and the queued switch carry ids only, never a hook.
    expect((await rows('SELECT 1 FROM ludy_kernel.outbox_event WHERE payload::text LIKE $1 OR payload::text LIKE $2', [`%${next}%`, `%${old}%`])).length).toBe(0);
  });

  it('keeps Telegram pointing at the hook the database holds when a reconnect changes it while the job is at Telegram', async () => {
    // Org B's bot answers chats (the test before left it on).
    expect((await rows<{ chat_state: string }>('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId]))[0]?.chat_state).toBe('on');
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN_B, username: null }), { orgId: b.orgId, provider: 'telegram', externalAccountId: CHANNEL_B });
    const reconnect = () =>
      api.execute('kernel.channel.connect', { provider: 'telegram', externalAccountId: CHANNEL_B, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } }, asOwner(b));
    await reconnect();
    // A Telegram adapter that, on its first call, is overtaken by a second reconnect (a new hook) before it answers.
    const sent: string[] = [];
    let first = true;
    const inner = hookDeps(telegram().fetchImpl);
    const adapter = {
      provider: 'telegram',
      reply: async () => ({ kind: 'unknown' as const }),
      chatHook: async (input: { hook: string; on: boolean }) => {
        sent.push(input.hook);
        if (first) {
          first = false;
          await reconnect();
        }
        liveUrls.set(TOKEN_B, `${APP_URL}${BASE}/${input.hook}`);
        return { kind: 'done' as const, botId: '222222222' };
      },
    };
    const outcome = await runTelegramChatHook({ ...inner, adapter: () => adapter }, { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: true });
    expect(outcome).toBe('on');
    // The job set the first hook, found it was no longer the one wanted, and set the new one: the last hook sent is the one the row holds.
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
    const [row] = await rows<{ chat_state: string; chat_hook: string; chat_hook_next: string | null }>('SELECT chat_state, chat_hook, chat_hook_next FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId]);
    expect(row).toMatchObject({ chat_state: 'on', chat_hook: sent[1], chat_hook_next: null });
    hookB = row?.chat_hook as string;
  });

  it('lets an owner turn chats off, and disconnect, when the connection no longer works, and asks again for a switch whose job was lost', async () => {
    const o = await connectBot('Công ty Telegram C', '333333333:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw3', '-1003333333330');
    await turnOn(o);
    // The bot's token is refused: the connection is marked expired. It cannot be asked of Telegram, so turning off is done here.
    await worker.execute('kernel.channel.mark_expired', { connectionId: o.connectionId, reason: 'token_refused' }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId });
    await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: true }, asOwner(o))).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    const events = () => rows("SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.chat_queued'", [o.orgId]);
    const queued = (await events()).length;
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: false }, asOwner(o))).toEqual({ chatState: 'off' });
    expect(await rows('SELECT chat_state, chat_hook, chat_hook_next, chat_bot_id FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null, chat_hook_next: null, chat_bot_id: null }]);
    expect((await events()).length).toBe(queued);
    // A connection that went inactive while chats were on may be disconnected without turning them off first.
    const p = await connectBot('Công ty Telegram D', '444444444:DDHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw4', '-1004444444440');
    await turnOn(p);
    await expect(api.execute('kernel.channel.disconnect', { connectionId: p.connectionId }, { ...asOwner(p), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CHAT_IS_ON' });
    await worker.execute('kernel.channel.mark_expired', { connectionId: p.connectionId, reason: 'token_refused' }, { actor: { type: 'system', component: 'test' }, orgId: p.orgId });
    await api.execute('kernel.channel.disconnect', { connectionId: p.connectionId }, { ...asOwner(p), idempotencyKey: randomUUID() });
    expect(await rows('SELECT status, chat_state, chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [p.orgId, p.connectionId])).toEqual([{ status: 'revoked', chat_state: 'off', chat_hook: null }]);
    // A switch whose job was lost (no answer for minutes) is asked again by the same command; inside the window it changes nothing.
    const q = await connectBot('Công ty Telegram E', '555555555:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5', '-1005555555550');
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: q.connectionId, on: true }, asOwner(q));
    const hookOf = async () => ((await rows<{ chat_hook_next: string }>('SELECT chat_hook_next FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [q.orgId, q.connectionId]))[0] as { chat_hook_next: string }).chat_hook_next;
    const first = await hookOf();
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: q.connectionId, on: true }, asOwner(q))).toEqual({ chatState: 'enabling' });
    expect(await hookOf()).toBe(first);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_changed_at = now() - interval '5 minutes' WHERE org_id = $1 AND id = $2", [q.orgId, q.connectionId]);
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: q.connectionId, on: true }, asOwner(q))).toEqual({ chatState: 'enabling' });
    expect(await hookOf()).not.toBe(first);
    expect((await rows("SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.chat_queued'", [q.orgId])).length).toBe(2);
    // The same for a turn off that stood: it is asked again once the window has passed.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'disabling', chat_hook = chat_hook_next, chat_hook_next = NULL, chat_changed_at = now() WHERE org_id = $1 AND id = $2", [q.orgId, q.connectionId]);
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: q.connectionId, on: false }, asOwner(q))).toEqual({ chatState: 'disabling' });
    expect((await rows("SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.chat_queued'", [q.orgId])).length).toBe(2);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_changed_at = now() - interval '5 minutes' WHERE org_id = $1 AND id = $2", [q.orgId, q.connectionId]);
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: q.connectionId, on: false }, asOwner(q))).toEqual({ chatState: 'disabling' });
    expect((await rows("SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.chat_queued'", [q.orgId])).length).toBe(3);
  });

  it('records a switch queued where the worker has no channel as failed, so the screen says so and nothing waits for a job that will never exist', async () => {
    const o = await connectBot('Công ty Telegram F', '666666666:FFHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw6', '-1006666666660');
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: true }, asOwner(o));
    await failChatHook(worker, { orgId: o.orgId, connectionId: o.connectionId, action: 'chat', on: true });
    expect(await rows('SELECT chat_state, chat_error, chat_hook, chat_hook_next FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId])).toEqual([{ chat_state: 'off', chat_error: 'CHANNEL_NOT_CONFIGURED', chat_hook: null, chat_hook_next: null }]);
  });

  it('holds one hook to a rate against a flood on a public bot, without charging other hooks or refused requests', async () => {
    const limited = createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived, now: () => NOW }, telegramHookLimit: new RateLimiter({ perMinute: 2 }) });
    const noise = (n: number) => update('x', { chatType: 'supergroup', chat: -100900 - n });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(limited, hookA, noise(i), signed(hookA))).status);
    expect(statuses).toEqual([200, 200, 429]);
    // Another hook has its own budget, and a request refused for its secret never spends the budget of the hook it named.
    expect((await post(limited, hookB, noise(9), signed(hookB))).status).toBe(200);
    expect((await post(limited, hookA, noise(8), {})).status).toBe(401);
  });

  it('erases a Telegram customer with their thread and messages, keeps what they write next out for the tombstone window, and leaves no row behind', async () => {
    // Org B's bot is on (the reconnect test left it so); a customer writes twice, and an owner erases them.
    const first = update('Số của mình là 0912 345 678', { chat: 1501, messageId: 131 });
    expect((await post(app, hookB, first, signed(hookB))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    const thread = (await rows<{ id: string }>("SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1501'", [b.orgId]))[0] as { id: string };
    const erased = await api.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: thread.id, confirm: true }, { actor: { type: 'user', userId: b.ownerId, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId: b.orgId, idempotencyKey: randomUUID() });
    expect(erased).toEqual({ threads: 1, messages: 1 });
    // Nothing of the customer is left: the thread, the messages and the identity are gone.
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1501'", [b.orgId])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body LIKE '%0912%'", [b.orgId])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_identity WHERE org_id = $1 AND external_user_id = '1501'", [b.orgId])).toHaveLength(0);
    // The message the erased customer writes next is not brought back in (the erase tombstone).
    const again = update('Mình nhắn lại', { chat: 1501, messageId: 132 });
    expect((await post(app, hookB, again, signed(hookB))).status).toBe(200);
    await intake();
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation_message WHERE org_id = $1 AND body = 'Mình nhắn lại'", [b.orgId])).toHaveLength(0);
    // The export of the org lists the conversation tables (provider-neutral), and the retention purge works on a Telegram thread like any other.
    const kept = update('Tin cũ để xóa theo thời hạn', { chat: 1502, messageId: 133 });
    expect((await post(app, hookB, kept, signed(hookB))).status).toBe(200);
    await intake();
    await rows("UPDATE ludy_kernel.conversation SET last_message_at = now() - interval '30 months', last_inbound_at = now() - interval '30 months' WHERE org_id = $1 AND external_thread_id = '1502'", [b.orgId]);
    await rows("UPDATE ludy_kernel.conversation_message SET received_at = now() - interval '30 months', sent_at = now() - interval '30 months' WHERE org_id = $1 AND body = 'Tin cũ để xóa theo thời hạn'", [b.orgId]);
    const purged = await worker.execute<{ threads: number }>('kernel.conversation.purge_expired', { limit: 10 }, { actor: { type: 'system', component: 'conversations' }, orgId: b.orgId });
    expect(purged.threads).toBe(1);
    expect(await rows("SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1502'", [b.orgId])).toHaveLength(0);
  });

  it('lists the chat state of a connection and keeps the hook out of the list and the export', async () => {
    const list = await api.query<Array<{ id: string; chatState: string; chatError: string | null }>>('kernel.channel.list', {}, asOwner(b));
    // The tests before left it on.
    expect(list.find((c) => c.id === b.connectionId)).toMatchObject({ chatState: 'on', chatError: null });
    const after = await api.query<Array<{ id: string; chatState: string; chatError: string | null }>>('kernel.channel.list', {}, asOwner(b));
    const row = after.find((c) => c.id === b.connectionId);
    expect(row).toMatchObject({ chatState: 'on', chatError: null });
    expect(JSON.stringify(after)).not.toContain(hookB);
  });

  it('marks the first org displaced and notifies its owners and admins when a second org enables the same Telegram bot, without cross-org leaks (#3150 item 2)', async () => {
    const sharedToken = '888888888:HHHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8';
    const first = await connectBot('Công ty Thứ Nhất', sharedToken, '-1008888888881');
    const second = await connectBot('Công ty Thứ Hai', sharedToken, '-1008888888882');
    const admin1 = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `admin1-${randomUUID().slice(0, 8)}@telegram.test`, name: null })) as string;
    const member1 = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `member1-${randomUUID().slice(0, 8)}@telegram.test`, name: null })) as string;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [first.orgId, admin1, member1]);

    const { hook: firstHook } = await turnOn(first);
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second.connectionId, on: true }, asOwner(second));
    const t2 = telegram();
    const adapter2 = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t2.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: () => adapter2, baseUrl: APP_URL, workerDb }, { orgId: second.orgId, connectionId: second.connectionId, action: 'chat', on: true })).toBe('on');

    // Second org gets chats on cleanly without seeing anything about the first org.
    const secondRow = (await rows<{ chat_state: string; chat_error: string | null }>('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [second.orgId, second.connectionId]))[0];
    expect(secondRow).toEqual({ chat_state: 'on', chat_error: null });
    const secondDump = JSON.stringify(await rows('SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1', [second.orgId]));
    expect(secondDump).not.toContain(first.orgId);
    expect(secondDump).not.toContain(first.connectionId);

    // First org is displaced cleanly: off, cleared hook/bot/key, BOT_TAKEN_OVER error, and admins/owners notified (not members).
    expect((await rows('SELECT chat_state, chat_hook, chat_hook_next, chat_bot_id, chat_hook_key_id, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [first.orgId, first.connectionId]))[0]).toEqual({
      chat_state: 'off',
      chat_hook: null,
      chat_hook_next: null,
      chat_bot_id: null,
      chat_hook_key_id: null,
      chat_error: 'BOT_TAKEN_OVER',
    });
    const notifs = await rows<{ user_id: string; kind: string; subject_id: string; detail: unknown }>(
      "SELECT user_id, kind, subject_id, detail FROM ludy_kernel.notification WHERE org_id = $1 AND kind = 'kernel.telegram_chat_displaced' ORDER BY user_id",
      [first.orgId],
    );
    expect(notifs.map((n) => n.user_id).sort()).toEqual([first.ownerId, admin1].sort());
    expect(notifs[0]?.subject_id).toBe(first.connectionId);
    expect(JSON.stringify(notifs)).not.toContain(second.orgId);
    expect(JSON.stringify(notifs)).not.toContain(second.connectionId);
    expect(JSON.stringify(notifs)).not.toContain(sharedToken);

    // Updates on first org's retired hook store nothing.
    expect((await post(app, firstHook, update('Gửi cho hook bị chiếm', { chat: 1801, messageId: 161 }), signed(firstHook))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });

    // Stale takenAt guard: re-enabling on org 1 cannot be displaced by an older timestamp.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: first.connectionId, on: true }, asOwner(first));
    const t1 = telegram();
    const adapter1 = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t1.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: () => adapter1, baseUrl: APP_URL, workerDb }, { orgId: first.orgId, connectionId: first.connectionId, action: 'chat', on: true })).toBe('on');
    expect((await rows<{ chat_state: string }>('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [second.orgId, second.connectionId]))[0]?.chat_state).toBe('off');
    const staleDisplace = await worker.execute<{ displaced: boolean }>(
      'kernel.channel.telegram_chat_displaced',
      { connectionId: first.connectionId, botId: '888888888', takenAt: new Date(Date.now() - 60_000).toISOString() },
      { actor: { type: 'system', component: 'test' }, orgId: first.orgId },
    );
    expect(staleDisplace.displaced).toBe(false);
    expect((await rows<{ chat_state: string }>('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [first.orgId, first.connectionId]))[0]?.chat_state).toBe('on');

    // Re-enabling and displacing the same connection a second time notifies admins again instead of deduping (#3150).
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second.connectionId, on: true }, asOwner(second));
    const t3 = telegram();
    const adapter3 = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t3.fetchImpl })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: () => adapter3, baseUrl: APP_URL, workerDb }, { orgId: second.orgId, connectionId: second.connectionId, action: 'chat', on: true })).toBe('on');
    expect((await rows<{ id: string }>("SELECT id FROM ludy_kernel.notification WHERE org_id = $1 AND kind = 'kernel.telegram_chat_displaced'", [first.orgId])).length).toBe(4);
  });

  it('caps Telegram inbound notices per org at 1,000 so one org flood cannot starve another (#3150 item 3)', async () => {
    const orgX = await connectBot('Công ty Xả Lũ', '900000001:JJHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1', '-1009000000001');
    const orgY = await connectBot('Công ty Bình Thường', '900000002:JJHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2', '-1009000000002');
    const { hook: hookX } = await turnOn(orgX);
    const { hook: hookY } = await turnOn(orgY);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');

    // Fill 999 notices for orgX using its hashed bucket_key, verify the 1,000th is accepted via webhook and the 1,001st gets 503 BACKLOG.
    await rows(
      "INSERT INTO ludy_kernel.conversation_inbound_pending (provider, bucket_key, body) SELECT 'telegram_chat', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex'), 'x'::bytea FROM generate_series(1, 999)",
      [orgX.orgId],
    );
    const ok1000 = await post(app, hookX, update('Tin 1000', { chat: 1901, messageId: 171 }), signed(hookX));
    expect(ok1000.status).toBe(200);
    const over = await post(app, hookX, update('Tin 1001', { chat: 1901, messageId: 172 }), signed(hookX));
    expect([over.status, await over.text()]).toEqual([503, '{"code":"BACKLOG"}']);

    // Verify bucket_key stores SHA-256 hex rather than raw orgId (ADR-0039).
    const buckets = await rows<{ bucket_key: string }>('SELECT DISTINCT bucket_key FROM ludy_kernel.conversation_inbound_pending WHERE bucket_key IS NOT NULL');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.bucket_key).toMatch(/^[0-9a-f]{64}$/);
    expect(buckets[0]?.bucket_key).not.toBe(orgX.orgId);

    // Org Y is unaffected while org X is capped at 1,000.
    const okY = await post(app, hookY, update('Tin của Y', { chat: 1902, messageId: 173 }), signed(hookY));
    expect(okY.status).toBe(200);
    expect(await waiting()).toBe(1001);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');
  });

  it('enforces cross-column chat_hook/chat_hook_next uniqueness, deterministic lookup order, and fail-closed intake (#3150 items 4, 5)', async () => {
    const o1 = await connectBot('Công ty Trùng Hook 1', '900000003:JJHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw3', '-1009000000003');
    const o2 = await connectBot('Công ty Trùng Hook 2', '900000004:JJHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw4', '-1009000000004');
    const { hook: h1 } = await turnOn(o1);
    await turnOn(o2);

    // DB trigger prevents one connection's chat_hook_next from colliding with another connection's chat_hook (and vice versa).
    await expect(
      rows("UPDATE ludy_kernel.channel_connection SET chat_hook_next = $1, chat_state = 'enabling' WHERE org_id = $2 AND id = $3", [h1, o2.orgId, o2.connectionId]),
    ).rejects.toMatchObject({ code: '23505' });

    // Worker fails closed if multiple connections ever match one hook, and SQL orders deterministically by (org_id, id).
    await rows('ALTER TABLE ludy_kernel.channel_connection DISABLE TRIGGER channel_connection_chat_hook_unique');
    try {
      await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_next = $1, chat_state = 'enabling' WHERE org_id = $2 AND id = $3", [h1, o2.orgId, o2.connectionId]);
      const matched = await rows<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM ludy_kernel.conversation_chat_hook_connections($1)', [h1]);
      expect(matched).toEqual([
        ...[
          { org_id: o1.orgId, connection_id: o1.connectionId },
          { org_id: o2.orgId, connection_id: o2.connectionId },
        ].sort((x, y) => x.org_id.localeCompare(y.org_id) || x.connection_id.localeCompare(y.connection_id)),
      ]);
      // Bypass enqueue check by inserting directly into pending with a valid envelope (v: 1), and verify intake refuses to write to either org.
      const notice = wrapTelegramChatNotice(h1, Buffer.from(update('Trùng hook', { chat: 1955, messageId: 181 }), 'utf8'));
      await rows('INSERT INTO ludy_kernel.conversation_inbound_pending (provider, body) VALUES ($1, $2)', ['telegram_chat', notice]);
      const logs: string[] = [];
      expect(await runConversationIntake({ workerDb, runtime: worker, log: (m) => logs.push(m) })).toEqual({ stored: 0, dropped: 1 });
      expect(logs.some((m) => m.includes('refused ambiguous hook match'))).toBe(true);
      expect(await waiting()).toBe(0);
      expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id IN ($1, $2)', [o1.orgId, o2.orgId])).toHaveLength(0);
    } finally {
      await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_next = NULL, chat_state = 'on' WHERE org_id = $1 AND id = $2", [o2.orgId, o2.connectionId]);
      await rows('ALTER TABLE ludy_kernel.channel_connection ENABLE TRIGGER channel_connection_chat_hook_unique');
    }
  });

  it('re-registers live Telegram webhooks under the new credential key on rotation, keeping failed rows live (#3150 item 1)', async () => {
    const token = '777777777:GGHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw7';
    const rot = await connectBot('Công ty Xoay Khóa', token, '-1007777777770');
    const { hook: rotHook } = await turnOn(rot);
    expect((await rows<{ chat_hook_key_id: string }>('SELECT chat_hook_key_id FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [rot.orgId, rot.connectionId]))[0]?.chat_hook_key_id).toBe(vaultKey1.id);

    const vaultKey2 = parseVaultKey(randomBytes(32).toString('base64'));
    const v12 = new CredentialVault([vaultKey2, vaultKey1]);
    const v2Only = new CredentialVault([vaultKey2]);
    const liveCount = (await rows<{ n: string }>("SELECT count(*) AS n FROM ludy_kernel.channel_connection WHERE provider = 'telegram' AND status = 'active' AND chat_state = 'on' AND chat_hook IS NOT NULL"))[0]?.n;

    // Simulate transient Telegram failures during rotation: rows stay chat_state = 'on', keep vaultKey1.id, and record chat_hook_rekey_after so untouched rows sort first.
    const tFail = telegram({
      setWebhook: Array.from({ length: Number(liveCount) + 1 }, () => ({ status: 500, body: { ok: false, error_code: 500, description: 'Internal' } })),
    });
    const adapterFail = new TelegramPublisher(undefined, new TelegramConversations({ fetch: tFail.fetchImpl })).conversations;
    const failedOutcome = await rekeyTelegramWebhooks({ runtime: worker, broker: v12, workerDb, adapter: () => adapterFail, baseUrl: APP_URL });
    expect(failedOutcome.failed).toBe(Number(liveCount));
    expect((await rows('SELECT chat_state, chat_hook_key_id, chat_hook_rekey_after IS NOT NULL AS retry_marked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [rot.orgId, rot.connectionId]))[0]).toEqual({ chat_state: 'on', chat_hook_key_id: vaultKey1.id, retry_marked: true });

    // Adding a brand-new untouched connection places it ahead of previously-failed rows in rekey_due ordering.
    const extraToken = '777777778:GGHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8';
    const extra = await connectBot('Công ty Xoay Sau', extraToken, '-1007777777771');
    await turnOn(extra);
    const dueOrder = await rows<{ connection_id: string }>('SELECT connection_id FROM ludy_kernel.telegram_chat_hook_rekey_due($1, 200, NULL, NULL, NULL)', [vaultKey2.id]);
    expect(dueOrder[0]?.connection_id).toBe(extra.connectionId);

    // Clean pass under [vaultKey2, vaultKey1] while another worker task holds 1 of the 2 pool connections (WORKER_DATABASE_POOL_MAX=2 minimum), proving zero lock deadlock.
    const tRekey = telegram();
    const adapterRekey = new TelegramPublisher(undefined, new TelegramConversations({ fetch: tRekey.fetchImpl })).conversations;
    let markHeld!: () => void;
    const heldReady = new Promise<void>((r) => { markHeld = r; });
    let releasePeer!: () => void;
    const peerWait = new Promise<void>((r) => { releasePeer = r; });
    const peerHolding = workerDb.connection().execute(async () => {
      markHeld();
      await peerWait;
    });
    await heldReady;
    const rekeyed = await (async () => {
      try {
        return await rekeyTelegramWebhooks({ runtime: worker, broker: v12, workerDb, adapter: () => adapterRekey, baseUrl: APP_URL });
      } finally {
        releasePeer();
        await peerHolding;
      }
    })();
    expect(rekeyed).toEqual({ rekeyed: Number(liveCount) + 1, failed: 0, leftActive: 0, leftInactive: 1, skipped: false });
    const callRot = tRekey.calls.find((c) => c.token === token && c.method === 'setWebhook');
    const derivedKey2 = v12.deriveKeys(TELEGRAM_HOOK_KEY_INFO)[0]?.key as Buffer;
    expect(callRot?.json).toEqual({
      url: `${APP_URL}${BASE}/${rotHook}`,
      secret_token: telegramHookSecret(derivedKey2, rotHook),
      allowed_updates: [...TELEGRAM_CHAT_UPDATES],
    });
    expect((await rows('SELECT chat_state, chat_hook_key_id, chat_hook_rekey_after FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [rot.orgId, rot.connectionId]))[0]).toEqual({ chat_state: 'on', chat_hook_key_id: vaultKey2.id, chat_hook_rekey_after: null });

    // Legacy anti-hijack check: if two orgs both hold chat_state='on' (pre-upgrade legacy rows) and getWebhookInfo points to org B,
    // rekey skips setWebhook for org A, marks org A displaced, and rekeys org B cleanly (#3150 item 1 + review P1).
    const dupToken = '777777779:GGHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';
    const dupA = await connectBot('Công ty Cũ A', dupToken, '-1007777777772');
    const dupB = await connectBot('Công ty Cũ B', dupToken, '-1007777777773');
    const { hook: dupHookA } = await turnOn(dupA);
    const { hook: dupHookB } = await turnOn(dupB);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $1, chat_hook_next = NULL, chat_bot_id = '777777779', chat_hook_key_id = NULL, chat_error = NULL WHERE org_id = $2 AND id = $3", [dupHookA, dupA.orgId, dupA.connectionId]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = NULL WHERE org_id = $1 AND id = $2", [dupB.orgId, dupB.connectionId]);
    liveUrls.set(dupToken, `${APP_URL}${BASE}/${dupHookB}`);
    const tDup = telegram();
    const adapterDup = new TelegramPublisher(undefined, new TelegramConversations({ fetch: tDup.fetchImpl })).conversations;
    const dupRekey = await rekeyTelegramWebhooks({ runtime: worker, broker: v12, workerDb, adapter: () => adapterDup, baseUrl: APP_URL });
    expect(dupRekey).toMatchObject({ rekeyed: 1, failed: 0, leftActive: 0, skipped: false });
    const dupSets = tDup.calls.filter((c) => c.token === dupToken && c.method === 'setWebhook');
    expect(dupSets.map((c) => c.json.url)).toEqual([`${APP_URL}${BASE}/${dupHookB}`]);
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [dupA.orgId, dupA.connectionId]))[0]).toEqual({ chat_state: 'off', chat_error: 'BOT_TAKEN_OVER' });
    expect((await rows('SELECT chat_state, chat_hook_key_id FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [dupB.orgId, dupB.connectionId]))[0]).toEqual({ chat_state: 'on', chat_hook_key_id: vaultKey2.id });

    // Once CREDENTIAL_KEY_PREVIOUS is dropped (only vaultKey2 remains), webhooks signed under vaultKey2 still pass while vaultKey1 returns 401.
    const appV2Only = createHttpApp({ ...commonDeps(), telegramWebhook: { keys: () => v2Only.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key), now: () => NOW } });
    const msg = update('Sau khi xoay khóa', { chat: 1701, messageId: 151 });
    expect((await post(appV2Only, rotHook, msg, { 'x-telegram-bot-api-secret-token': telegramHookSecret(derivedKey2, rotHook) })).status).toBe(200);
    expect((await post(appV2Only, rotHook, msg, { 'x-telegram-bot-api-secret-token': telegramHookSecret(vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO)[0]?.key as Buffer, rotHook) })).status).toBe(401);
    await rows('DELETE FROM ludy_kernel.conversation_inbound_pending');
  });

  it('serializes concurrent same-bot enable races and reconciles failed displacements without re-calling setWebhook (#3150)', async () => {
    const raceToken = '666666667:FFHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw7';
    const rA = await connectBot('Công ty Đua A', raceToken, '-1006666666667');
    const rB = await connectBot('Công ty Đua B', raceToken, '-1006666666668');
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: rA.connectionId, on: true }, asOwner(rA));
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: rB.connectionId, on: true }, asOwner(rB));

    // Delay the first setWebhook slightly while both orgs run concurrently; per-bot lock serializes them so Telegram webhook and DB winner match.
    const slowFetch: Fetch = async (input, init) => {
      const [, tokenPart, method] = new URL(input).pathname.split('/') as [string, string, string];
      const tok = tokenPart.replace(/^bot/, '');
      const json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (method === 'setWebhook') {
        await new Promise((r) => setTimeout(r, 80));
        liveUrls.set(tok, String(json.url ?? ''));
      }
      return new Response(JSON.stringify({ ok: true, result: method === 'getWebhookInfo' ? { url: liveUrls.get(tok) ?? '' } : true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const [resA, resB] = await Promise.all([
      runTelegramChatHook(hookDeps(slowFetch), { orgId: rA.orgId, connectionId: rA.connectionId, action: 'chat', on: true }),
      runTelegramChatHook(hookDeps(slowFetch), { orgId: rB.orgId, connectionId: rB.connectionId, action: 'chat', on: true }),
    ]);
    expect([resA, resB]).toEqual(['on', 'on']);
    const [rowA] = await rows<{ chat_state: string; chat_hook: string | null }>('SELECT chat_state, chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [rA.orgId, rA.connectionId]);
    const [rowB] = await rows<{ chat_state: string; chat_hook: string | null }>('SELECT chat_state, chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [rB.orgId, rB.connectionId]);
    const liveUrl = liveUrls.get(raceToken);
    if (rowA?.chat_state === 'on') {
      expect(rowB?.chat_state).toBe('off');
      expect(liveUrl).toBe(`${APP_URL}${BASE}/${rowA.chat_hook}`);
    } else {
      expect(rowB?.chat_state).toBe('on');
      expect(rowA?.chat_state).toBe('off');
      expect(liveUrl).toBe(`${APP_URL}${BASE}/${rowB?.chat_hook}`);
    }

    // Durable displacement recovery: if a stale row missed notification/off and winner has chat_displace_pending=true, reconcileTelegramDisplacements fixes it without Telegram API calls.
    const winner = rowA?.chat_state === 'on' ? rA : rB;
    const loser = winner.orgId === rA.orgId ? rB : rA;
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = 'stalehook__________________________________', chat_bot_id = '666666667', chat_error = NULL, chat_changed_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [loser.orgId, loser.connectionId]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_displace_pending = true WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId]);
    expect(await reconcileTelegramDisplacements({ workerDb, runtime: worker, force: true })).toBeGreaterThanOrEqual(1);
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [loser.orgId, loser.connectionId]))[0]).toEqual({ chat_state: 'off', chat_error: 'BOT_TAKEN_OVER' });
    expect((await rows<{ chat_displace_pending: boolean }>('SELECT chat_displace_pending FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]?.chat_displace_pending).toBe(false);

    // Rekey respects takenAt when getWebhookInfo sees a stale mismatch concurrent with a newer re-enable (#3150).
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = $1 WHERE chat_state = 'on'", [vaultKey1.id]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = 'stale-key', chat_changed_at = now() - interval '10 seconds' WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId]);
    const raceInfoFetch: Fetch = async (input) => {
      const method = new URL(input).pathname.split('/').at(-1);
      if (method === 'getWebhookInfo') {
        await rows("UPDATE ludy_kernel.channel_connection SET chat_changed_at = now() + interval '5 seconds' WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId]);
        return new Response(JSON.stringify({ ok: true, result: { url: `${APP_URL}/stale-other-hook` } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const raceAdapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: raceInfoFetch })).conversations;
    await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => raceAdapter, baseUrl: APP_URL });
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'on', chat_error: null });

    // Same-hook different origin (e.g. PUBLIC_URL migrated) or unregistered live webhook (url: '') re-registers under current key instead of false BOT_TAKEN_OVER.
    const [winnerHookRow] = await rows<{ chat_hook: string }>('SELECT chat_hook FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]);
    const migrateCalls: string[] = [];
    const migrateFetch: Fetch = async (input) => {
      const method = new URL(input).pathname.split('/').at(-1) as string;
      migrateCalls.push(method);
      if (method === 'getWebhookInfo') {
        return new Response(JSON.stringify({ ok: true, result: { url: `https://old.example.invalid${BASE}/${winnerHookRow?.chat_hook}` } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const migrateAdapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: migrateFetch })).conversations;
    expect(await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => migrateAdapter, baseUrl: APP_URL })).toMatchObject({ rekeyed: 1, failed: 0, leftActive: 0 });
    expect(migrateCalls).toEqual(['getWebhookInfo', 'setWebhook']);
    expect((await rows('SELECT chat_state, chat_hook_key_id, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'on', chat_hook_key_id: vaultKey1.id, chat_error: null });

    // Disable race guard: if org B holds the bot in DB AND Telegram's live URL points to org B, org A skips deleteWebhook and leaves B's URL untouched.
    const loserHook = 'orgB_live_hook_____________________________';
    const loserUrl = `${APP_URL}${BASE}/${loserHook}`;
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: winner.connectionId, on: false }, asOwner(winner));
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_bot_id = '666666667', chat_error = NULL WHERE org_id = $1 AND id = $2", [loser.orgId, loser.connectionId, loserHook]);
    liveUrls.set(raceToken, loserUrl);
    const tTakeover = telegram();
    expect(await runTelegramChatHook(hookDeps(tTakeover.fetchImpl), { orgId: winner.orgId, connectionId: winner.connectionId, action: 'chat', on: false })).toBe('off');
    expect(tTakeover.calls.map((c) => c.method)).toEqual(['getWebhookInfo']);
    expect(liveUrls.get(raceToken)).toBe(loserUrl);
    expect((await rows('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'off' });
    expect((await rows('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [loser.orgId, loser.connectionId]))[0]).toEqual({ chat_state: 'on' });

    // Conversely, when another org has a stale 'on' row in DB but Telegram's live URL still points to the disabling org, disable deletes the webhook cleanly.
    const winnerUrl = `${APP_URL}${BASE}/${winnerHookRow?.chat_hook}`;
    liveUrls.set(raceToken, winnerUrl);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'disabling', chat_hook = $3, chat_bot_id = '666666667', chat_error = NULL WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId, winnerHookRow?.chat_hook]);
    const tStalePeer = telegram();
    expect(await runTelegramChatHook(hookDeps(tStalePeer.fetchImpl), { orgId: winner.orgId, connectionId: winner.connectionId, action: 'chat', on: false })).toBe('off');
    expect(tStalePeer.calls.map((c) => c.method)).toEqual(['getWebhookInfo', 'deleteWebhook']);
    expect(liveUrls.get(raceToken)).toBeUndefined();
    expect((await rows('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'off' });

    // Reconcile recovery when another org legitimately holds 'on' with a newer timestamp displaces the older stale connection instead of leaving both 'on' (#3150).
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_hook_next = NULL, chat_bot_id = '666666667', chat_displace_pending = true, chat_error = NULL, chat_changed_at = now() - interval '2 minutes' WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId, winnerHookRow?.chat_hook]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_hook_next = NULL, chat_bot_id = '666666667', chat_displace_pending = false, chat_error = NULL, chat_changed_at = now() WHERE org_id = $1 AND id = $2", [loser.orgId, loser.connectionId, loserHook]);
    expect(await reconcileTelegramDisplacements({ workerDb, runtime: worker, force: true })).toBeGreaterThanOrEqual(1);
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'off', chat_error: 'BOT_TAKEN_OVER' });
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [loser.orgId, loser.connectionId]))[0]).toEqual({ chat_state: 'on', chat_error: null });

    // Disabling mid-rotation (chat_hook_next set while peer holds 'on') deletes Telegram's live URL when it points to chat_hook_next (#3150).
    const altNextHook = 'winner_next_hook___________________________';
    liveUrls.set(raceToken, `${APP_URL}${BASE}/${altNextHook}`);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'disabling', chat_hook = $3, chat_hook_next = $4, chat_bot_id = '666666667', chat_error = NULL WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId, winnerHookRow?.chat_hook, altNextHook]);
    const tAltDisable = telegram();
    expect(await runTelegramChatHook(hookDeps(tAltDisable.fetchImpl), { orgId: winner.orgId, connectionId: winner.connectionId, action: 'chat', on: false })).toBe('off');
    expect(tAltDisable.calls.map((c) => c.method)).toEqual(['getWebhookInfo', 'deleteWebhook']);
    expect(liveUrls.get(raceToken)).toBeUndefined();
    expect((await rows('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_state: 'off' });

    // Reconcile bot-switch race guard: if a connection switches bots between telegram_chat_displace_due and lock acquisition,
    // reconcileTelegramDisplacements skips the stale bot id so another org live on the old bot is never displaced (#3150).
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_hook_next = NULL, chat_bot_id = '666666667', chat_displace_pending = true, chat_error = NULL WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId, winnerHookRow?.chat_hook]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook = $3, chat_hook_next = NULL, chat_bot_id = '666666667', chat_displace_pending = false, chat_error = NULL WHERE org_id = $1 AND id = $2", [loser.orgId, loser.connectionId, loserHook]);
    let switchedBotDuringLock = false;
    const switchRacingRuntime = new Proxy(worker, {
      get(target, prop) {
        if (prop === 'query') {
          return async (name: string, ...rest: unknown[]) => {
            const input = rest[0] as { connectionId?: string } | undefined;
            if (!switchedBotDuringLock && name === 'kernel.channel.telegram_chat_work' && input?.connectionId === winner.connectionId) {
              switchedBotDuringLock = true;
              await rows("UPDATE ludy_kernel.channel_connection SET chat_bot_id = '666666668' WHERE org_id = $1 AND id = $2", [winner.orgId, winner.connectionId]);
            }
            return Reflect.apply(target.query, target, [name, ...rest]);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Runtime;
    expect(await reconcileTelegramDisplacements({ workerDb, runtime: switchRacingRuntime, force: true })).toBe(0);
    expect(switchedBotDuringLock).toBe(true);
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [loser.orgId, loser.connectionId]))[0]).toEqual({ chat_state: 'on', chat_error: null });
    expect((await rows('SELECT chat_bot_id, chat_displace_pending FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_bot_id: '666666668', chat_displace_pending: true });
    expect(await reconcileTelegramDisplacements({ workerDb, runtime: worker, force: true })).toBe(1);
    expect((await rows('SELECT chat_displace_pending FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [winner.orgId, winner.connectionId]))[0]).toEqual({ chat_displace_pending: false });
  });

  it('marks chat_hook_rekey_after on thrown open, chatHookInfo, chatHook, and TELEGRAM_BOT_LOCK_BUSY errors and renews outer sweep lease every row (#5028)', async () => {
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = $1 WHERE chat_state = 'on'", [vaultKey1.id]);
    const errToken = '611111111:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
    const okToken = '622222222:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2';
    const tErr = await connectBot('Công ty Rekey Lỗi', errToken, '-1006111111111');
    const tOk = await connectBot('Công ty Rekey Khỏe', okToken, '-1006222222222');
    await turnOn(tErr);
    await turnOn(tOk);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = 'stale-key', chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tErr.orgId, tErr.connectionId]);

    const otherKey = parseVaultKey(randomBytes(32).toString('base64'));
    const wrongBroker = new CredentialVault([otherKey]);
    const happyBase = new TelegramConversations({ fetch: telegram().fetchImpl });

    // 1) open() throws on an un-openable envelope: advances chat_hook_rekey_after instead of keeping NULL.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = $1 WHERE chat_state = 'on'", [otherKey.id]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = 'stale-key', chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tErr.orgId, tErr.connectionId]);
    const openFailOutcome = await rekeyTelegramWebhooks({ runtime: worker, broker: wrongBroker, workerDb, adapter: () => happyBase, baseUrl: APP_URL });
    expect(openFailOutcome.failed).toBe(1);
    expect((await rows('SELECT chat_state, chat_hook_key_id, chat_hook_rekey_after IS NOT NULL AS retry_marked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tErr.orgId, tErr.connectionId]))[0]).toEqual({
      chat_state: 'on',
      chat_hook_key_id: 'stale-key',
      retry_marked: true,
    });
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = $1 WHERE chat_state = 'on' AND id <> $2", [vaultKey1.id, tErr.connectionId]);

    // Untouched row sorts ahead of the failed row in telegram_chat_hook_rekey_due.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = 'stale-key', chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tOk.orgId, tOk.connectionId]);
    const dueIds = (await rows<{ connection_id: string }>('SELECT connection_id FROM ludy_kernel.telegram_chat_hook_rekey_due($1, 200, NULL, NULL, NULL)', [vaultKey1.id])).map((r) => r.connection_id);
    expect(dueIds).toContain(tOk.connectionId);
    expect(dueIds).toContain(tErr.connectionId);
    expect(dueIds.indexOf(tOk.connectionId)).toBeLessThan(dueIds.indexOf(tErr.connectionId));

    // Keep only tErr due under vaultKey1 while testing chatHookInfo, chatHook, and TELEGRAM_BOT_LOCK_BUSY throws.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = $1, chat_hook_rekey_after = NULL WHERE org_id = $2 AND id = $3", [vaultKey1.id, tOk.orgId, tOk.connectionId]);

    // 2) adapter.chatHookInfo() throws unexpectedly -> retry backoff marked.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tErr.orgId, tErr.connectionId]);
    const throwingInfoAdapter: ConversationAdapter = {
      provider: 'telegram',
      reply: (input) => happyBase.reply(input),
      chatHookBotId: (s) => happyBase.chatHookBotId(s),
      chatHookInfo: async () => {
        throw new Error('chatHookInfo exploded');
      },
      chatHook: (input) => happyBase.chatHook(input),
    };
    const infoThrowOutcome = await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => throwingInfoAdapter, baseUrl: APP_URL });
    expect(infoThrowOutcome.failed).toBe(1);
    expect((await rows('SELECT chat_state, chat_hook_rekey_after IS NOT NULL AS retry_marked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tErr.orgId, tErr.connectionId]))[0]).toEqual({
      chat_state: 'on',
      retry_marked: true,
    });

    // 3) adapter.chatHook() throws unexpectedly -> retry backoff marked.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tErr.orgId, tErr.connectionId]);
    const throwingHookAdapter: ConversationAdapter = {
      provider: 'telegram',
      reply: (input) => happyBase.reply(input),
      chatHookBotId: (s) => happyBase.chatHookBotId(s),
      chatHookInfo: async () => ({ kind: 'ok', url: '', matchesHook: false, matchesHookPath: false }),
      chatHook: async () => {
        throw new Error('chatHook exploded');
      },
    };
    const hookThrowOutcome = await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => throwingHookAdapter, baseUrl: APP_URL });
    expect(hookThrowOutcome.failed).toBe(1);
    expect((await rows('SELECT chat_state, chat_hook_rekey_after IS NOT NULL AS retry_marked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tErr.orgId, tErr.connectionId]))[0]).toEqual({
      chat_state: 'on',
      retry_marked: true,
    });

    // 4) withBotWebhookLock() throws TELEGRAM_BOT_LOCK_BUSY -> retry backoff marked.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_rekey_after = NULL WHERE org_id = $1 AND id = $2", [tErr.orgId, tErr.connectionId]);
    await rows(
      "INSERT INTO ludy_kernel.telegram_webhook_lock (lock_key, owner_id, locked_until) VALUES ('bot:611111111', $1, now() + interval '5 minutes') ON CONFLICT (lock_key) DO UPDATE SET owner_id = EXCLUDED.owner_id, locked_until = EXCLUDED.locked_until",
      [randomUUID()],
    );
    try {
      const busyOutcome = await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => happyBase, baseUrl: APP_URL, botLockWaitMs: 0 });
      expect(busyOutcome.failed).toBe(1);
      expect((await rows('SELECT chat_state, chat_hook_rekey_after IS NOT NULL AS retry_marked FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tErr.orgId, tErr.connectionId]))[0]).toEqual({
        chat_state: 'on',
        retry_marked: true,
      });
    } finally {
      await rows("DELETE FROM ludy_kernel.telegram_webhook_lock WHERE lock_key = 'bot:611111111'");
    }

    // 5) Outer rekey_sweep lease renews every row (index > 0): stealing REKEY_LOCK_KEY during row 0 stops the sweep before row 1.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_hook_key_id = 'stale-key', chat_hook_rekey_after = NULL WHERE org_id = ANY($1::uuid[]) AND id = ANY($2::uuid[])", [
      [tErr.orgId, tOk.orgId],
      [tErr.connectionId, tOk.connectionId],
    ]);
    let setCalls = 0;
    const thiefAdapter: ConversationAdapter = {
      provider: 'telegram',
      reply: (input) => happyBase.reply(input),
      chatHookBotId: (s) => happyBase.chatHookBotId(s),
      chatHookInfo: (input) => happyBase.chatHookInfo(input),
      chatHook: async (input) => {
        setCalls += 1;
        if (setCalls === 1) {
          await rows("UPDATE ludy_kernel.telegram_webhook_lock SET owner_id = $1, locked_until = now() + interval '5 minutes' WHERE lock_key = 'ludy.telegram-webhook-rekey'", [randomUUID()]);
        }
        return happyBase.chatHook(input);
      },
    };
    try {
      const stolenSweep = await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => thiefAdapter, baseUrl: APP_URL });
      expect(stolenSweep).toMatchObject({ rekeyed: 1, failed: 0, leftActive: 1, skipped: false });
    } finally {
      await rows("DELETE FROM ludy_kernel.telegram_webhook_lock WHERE lock_key = 'ludy.telegram-webhook-rekey'");
    }
    const finishedSweep = await rekeyTelegramWebhooks({ runtime: worker, broker: vault, workerDb, adapter: () => happyBase, baseUrl: APP_URL });
    expect(finishedSweep).toMatchObject({ rekeyed: 1, failed: 0, leftActive: 0, skipped: false });
  });

  it('tightens null chat_bot_id displacement to chat_state=on and enforces chat_business_order CHECK and partial indexes (#5028)', async () => {
    const tGuard = await connectBot('Công ty Bảo Vệ Bot ID', '633333333:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw3', '-1006333333333');
    await turnOn(tGuard);

    for (const state of ['enabling', 'disabling'] as const) {
      const hookNext = state === 'enabling' ? randomBytes(32).toString('base64url') : null;
      await rows('UPDATE ludy_kernel.channel_connection SET chat_state = $1, chat_hook_next = $2, chat_bot_id = NULL WHERE org_id = $3 AND id = $4', [
        state,
        hookNext,
        tGuard.orgId,
        tGuard.connectionId,
      ]);
      const res = await worker.execute<{ displaced: boolean }>(
        'kernel.channel.telegram_chat_displaced',
        { connectionId: tGuard.connectionId, botId: '633333333' },
        { actor: { type: 'system', component: 'test' }, orgId: tGuard.orgId },
      );
      expect(res.displaced).toBe(false);
      expect((await rows<{ chat_state: string }>('SELECT chat_state FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tGuard.orgId, tGuard.connectionId]))[0]?.chat_state).toBe(state);
    }

    // Legacy pre-chat_bot_id connection in chat_state='on' with NULL chat_bot_id is still displaced cleanly.
    await rows("UPDATE ludy_kernel.channel_connection SET chat_state = 'on', chat_hook_next = NULL, chat_bot_id = NULL WHERE org_id = $1 AND id = $2", [tGuard.orgId, tGuard.connectionId]);
    const legacyDisplaced = await worker.execute<{ displaced: boolean }>(
      'kernel.channel.telegram_chat_displaced',
      { connectionId: tGuard.connectionId, botId: '633333333' },
      { actor: { type: 'system', component: 'test' }, orgId: tGuard.orgId },
    );
    expect(legacyDisplaced.displaced).toBe(true);
    expect((await rows('SELECT chat_state, chat_error FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [tGuard.orgId, tGuard.connectionId]))[0]).toEqual({
      chat_state: 'off',
      chat_error: 'BOT_TAKEN_OVER',
    });

    // Forward migration CHECK constraint on chat_business_order (validated, text-length bounded) and concurrent partial indexes.
    const constraintRow = await rows<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_catalog.pg_constraint WHERE conrelid = 'ludy_kernel.channel_connection'::regclass AND conname = 'channel_connection_chat_business_order_check'",
    );
    expect(constraintRow).toEqual([{ convalidated: true }]);
    await rows("UPDATE ludy_kernel.channel_connection SET chat_business_order = '{\"0123456789ab\":1}'::jsonb WHERE org_id = $1 AND id = $2", [
      tGuard.orgId,
      tGuard.connectionId,
    ]);
    await expect(
      rows("UPDATE ludy_kernel.channel_connection SET chat_business_order = '[]'::jsonb WHERE org_id = $1 AND id = $2", [tGuard.orgId, tGuard.connectionId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      rows('UPDATE ludy_kernel.channel_connection SET chat_business_order = $1::jsonb WHERE org_id = $2 AND id = $3', [
        JSON.stringify({ big: 'x'.repeat(9000) }),
        tGuard.orgId,
        tGuard.connectionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const idxs = await rows<{ relname: string; indisvalid: boolean }>(
      `SELECT c.relname, i.indisvalid
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ludy_kernel'
          AND i.indrelid = 'ludy_kernel.channel_connection'::regclass
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [['channel_connection_chat_bot_id_idx', 'channel_connection_chat_displace_pending_idx']],
    );
    expect(idxs).toEqual([
      { relname: 'channel_connection_chat_bot_id_idx', indisvalid: true },
      { relname: 'channel_connection_chat_displace_pending_idx', indisvalid: true },
    ]);
  });
});
