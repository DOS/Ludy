// SPDX-License-Identifier: AGPL-3.0-only
// Telegram bot chats on PostgreSQL 17 (conversation core, #3132, plan docs/plan/conversations-channels.md section 4.2): the route exists only where
// Telegram is on and the credential key can derive the secret; it checks the secret header derived from the hook in the path before it reads the
// body or asks the database, and refuses a wrong one with one answer that says nothing; it caps the body; it parks only a verified private-chat
// message, names no org in its path or answer and writes no tenant row; two bots on one deployment reach their own connections; the worker takes a
// parked update into the customer's thread under the org that holds the hook, once; chats are turned on and off through a command and a job that
// sets and deletes the webhook with the sealed token; and a reply goes out through sendMessage exactly once. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TELEGRAM_HOOK_KEY_INFO, TELEGRAM_MAX_NOTICE_BYTES, TelegramPublisher, telegramHookSecret, TelegramConversations, type Fetch } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { runConversationIntake, runConversationJob, runTelegramChatHook } from '../src/conversations-worker.ts';
import { TELEGRAM_REPLAY_WINDOW_MS, TelegramReplayCache } from '../src/telegram-webhook.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-telegram-0123456789-abcdefghij';
const ISSUER = 'crove-auth';
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
  const dbName = `crove_test_telegram_webhook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let bare: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let api: Runtime;
  let appConfig: ReturnType<typeof loadConfig>;
  let appDb: Db;
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
  const waiting = async () => (await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).length;
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

  // A Telegram that answers every method with ok and records what it was asked.
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
    return { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined), baseUrl };
  };

  // Turns chats on through the command and runs the job the relay would queue, against a recorded Telegram. Returns the hook the connection got.
  async function turnOn(o: Org): Promise<{ hook: string; calls: ReturnType<typeof telegram>['calls'] }> {
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: o.connectionId, on: true }, asOwner(o));
    const t = telegram();
    const outcome = await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: o.orgId, connectionId: o.connectionId, action: 'chat', on: true });
    expect(outcome).toBe('on');
    const [row] = await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId]);
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
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    appConfig = config;
    appDb = db;
    const common = { config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...common, telegramWebhook: { keys: derived, now: () => NOW } });
    bare = createHttpApp(common);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
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
    const [before] = await rows<{ chat_hook: string; chat_state: string }>('SELECT chat_hook, chat_state FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId]);
    expect(before?.chat_state).toBe('enabling');
    expect(before?.chat_hook).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: true }, asOwner(a))).toEqual({ chatState: 'enabling' });
    const [same] = await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId]);
    expect(same?.chat_hook).toBe(before?.chat_hook);
    const t = telegram();
    const outcome = await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: true });
    expect(outcome).toBe('on');
    hookA = before?.chat_hook as string;
    // One setWebhook with this bot's token, the hook in the path, the derived secret as secret_token, and only private messages asked for.
    expect(t.calls).toEqual([{ method: 'setWebhook', token: TOKEN_A, json: { url: `${APP_URL}${BASE}/${hookA}`, secret_token: secretOf(hookA), allowed_updates: ['message'] } }]);
    expect(await rows('SELECT chat_state, chat_error, chat_bot_id FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'on', chat_error: null, chat_bot_id: '111111111' }]);
    // The same job again finds the connection already on and calls nothing.
    expect(await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: true })).toBe('none');
    expect(t.calls).toHaveLength(1);
    // Only an owner or an admin may; a viewer is refused and a connection of another provider is not a bot.
    const viewerId = (await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `viewer-${randomUUID().slice(0, 8)}@telegram.test`, name: null })) as string;
    await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, { actor: { type: 'user', userId: viewerId, aal: 'aal1' }, orgId: a.orgId })).rejects.toBeDefined();
    // The hook is a capability: neither the audit log nor the events hold it.
    expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1', [`%${hookA}%`])).length).toBe(0);
    expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE payload::text LIKE $1', [`%${hookA}%`])).length).toBe(0);
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
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
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
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
    expect(await rows('SELECT provider FROM crove_kernel.conversation_inbound_pending')).toEqual([{ provider: 'telegram_chat' }]);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await waiting()).toBe(0);
    const seen = await rows(
      "SELECT m.body, m.direction, m.tainted, m.seq, c.kind, c.external_thread_id, c.reply_window_until IS NULL AS no_window, i.external_user_id, i.display_name, i.provider FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id WHERE m.org_id = $1",
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
    const onA = await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1 AND body LIKE $2', [a.orgId, 'Gửi cho bot%']);
    const onB = await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1 AND body LIKE $2', [b.orgId, 'Gửi cho bot%']);
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
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND body = 'Gửi lại nhiều lần'", [a.orgId])).toHaveLength(1);
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
    await rows("INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) SELECT 'telegram_chat', 'x'::bytea FROM generate_series(1, 10001)");
    const fresh = update('Hàng đợi đầy', { chat: 701, messageId: 51 });
    const response = await post(app, hookA, fresh, signed(hookA));
    expect([response.status, await response.text()]).toEqual([503, '{"code":"BACKLOG"}']);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
    expect((await post(app, hookA, fresh, signed(hookA))).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
  });

  it('is not refused for the sandbox\'s backlog: the cap is per provider', async () => {
    await rows("INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) SELECT 'sandbox', 'x'::bytea FROM generate_series(1, 1000)");
    const real = update('Tin thật vẫn nhận', { chat: 801, messageId: 61 });
    expect((await post(app, hookA, real, signed(hookA))).status).toBe(200);
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_inbound_pending WHERE provider = 'telegram_chat'")).toHaveLength(1);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
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
    const seen = await rows<{ body: string; seq: number }>("SELECT body, seq FROM crove_kernel.conversation_message WHERE org_id = $1 AND body LIKE 'Tin đến%' ORDER BY seq", [a.orgId]);
    expect(seen.map((m) => m.body).sort()).toEqual(['Tin đến sau', 'Tin đến trước']);
    // A hook whose connection was turned off: the secret still derives (nothing is stored), so the update is parked, claimed, found nowhere, deleted.
    await rows("UPDATE crove_kernel.channel_connection SET chat_hook = NULL, chat_state = 'off' WHERE org_id = $1 AND id = $2", [b.orgId, b.connectionId]);
    const stranger = update('Gửi cho hook cũ', { chat: 1002, messageId: 83 });
    expect((await post(app, hookB, stranger, signed(hookB))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await waiting()).toBe(0);
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_message WHERE body = 'Gửi cho hook cũ'")).toHaveLength(0);
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
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
  });

  it('answers the customer through sendMessage once, with no window, and the reply is the business\'s own message', async () => {
    const now = sec(Date.now());
    const incoming = update('Còn hàng không shop?', { chat: 1201, messageId: 101, date: now });
    expect((await post(createHttpApp({ ...commonDeps(), telegramWebhook: { keys: derived } }), hookA, incoming, signed(hookA))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    const thread = (await rows<{ id: string; last_seq: number }>("SELECT id, last_seq FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1201'", [a.orgId]))[0] as { id: string; last_seq: number };
    const t = telegram({ sendMessage: [{ body: { ok: true, result: { message_id: 5551 } } }] });
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: t.fetchImpl })).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined) };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ shop còn hàng ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    const job = { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' as const };
    expect(await runConversationJob(deps, job)).toBe('accepted');
    expect(t.calls).toEqual([{ method: 'sendMessage', token: TOKEN_A, json: { chat_id: '1201', text: 'Dạ shop còn hàng ạ' } }]);
    expect(await rows('SELECT send_state, external_message_id FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ send_state: 'sent', external_message_id: '5551' }]);
    // The same job again calls nothing: a reply is sent exactly once.
    expect(await runConversationJob(deps, job)).toBe('settled');
    expect(t.calls).toHaveLength(1);
    // No window to close: the screen's reply state is allowed, and a long-ago customer message can still be answered.
    await rows("UPDATE crove_kernel.conversation SET last_inbound_at = now() - interval '40 days' WHERE org_id = $1 AND id = $2", [a.orgId, thread.id]);
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
    const thread = (await rows<{ id: string; last_seq: number }>("SELECT id, last_seq FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = '1301'", [a.orgId]))[0] as { id: string; last_seq: number };
    const t = telegram({ sendMessage: [{ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }] });
    const adapter = new TelegramConversations({ fetch: t.fetchImpl });
    const deps = { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'telegram' ? adapter : undefined) };
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ 100k ạ', lastSeenSeq: thread.last_seq }, asOwner(a));
    expect(await runConversationJob(deps, { orgId: a.orgId, messageId, connectionId: a.connectionId, action: 'reply' })).toBe('rejected');
    expect(await rows('SELECT send_state, send_error_code FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [a.orgId, messageId])).toEqual([{ send_state: 'failed', send_error_code: 'TELEGRAM_BOT_BLOCKED' }]);
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
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, second])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: 'BOT_IN_USE' }]);
    // A plain-http deployment cannot take a Telegram webhook: refused in words before any call.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second, on: true }, asOwner(a));
    await rows("UPDATE crove_kernel.channel_connection SET chat_bot_id = NULL WHERE org_id = $1", [a.orgId]);
    expect(await runTelegramChatHook(hookDeps(idle.fetchImpl, 'http://localhost:8080'), { orgId: a.orgId, connectionId: second, action: 'chat', on: true })).toBe('failed:WEBHOOK_NEEDS_HTTPS');
    // Telegram refuses the address: recorded as a code, the connection is off again with nothing to delete.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: second, on: true }, asOwner(a));
    const refusing = telegram({ setWebhook: [{ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' } }] });
    expect(await runTelegramChatHook(hookDeps(refusing.fetchImpl), { orgId: a.orgId, connectionId: second, action: 'chat', on: true })).toBe('failed:TELEGRAM_WEBHOOK_REFUSED');
    expect(await rows('SELECT chat_state, chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, second])).toEqual([{ chat_state: 'off', chat_hook: null }]);
    // Off: the command marks it disabling and keeps the hook until the job has deleted the webhook with this bot's token.
    expect(await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, asOwner(a))).toEqual({ chatState: 'disabling' });
    expect(await rows('SELECT chat_state, chat_hook IS NOT NULL AS hooked FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'disabling', hooked: true }]);
    // While it is being turned off an update on the hook is still taken in (nothing in flight is lost), and turning on again waits.
    await expect(api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: true }, asOwner(a))).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    const off = telegram();
    expect(await runTelegramChatHook(hookDeps(off.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: false })).toBe('off');
    expect(off.calls).toEqual([{ method: 'deleteWebhook', token: TOKEN_A, json: {} }]);
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: null }]);
    // A failed delete leaves it off in Ludy with the code for the screen: nothing is received any more either way.
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: b.connectionId, on: false }, asOwner(b));
    const dead = telegram({ deleteWebhook: [{ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }] });
    expect(await runTelegramChatHook(hookDeps(dead.fetchImpl), { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: false })).toBe('failed:TELEGRAM_TOKEN_REFUSED');
    expect(await rows('SELECT chat_state, chat_hook, chat_error FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null, chat_error: 'TELEGRAM_TOKEN_REFUSED' }]);
    // Neither the hook, the secret nor the token is in anything the job returned or recorded.
    expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1 OR detail::text LIKE $2', [`%${TOKEN_A}%`, `%${hookA}%`])).length).toBe(0);
  });

  it('gives the hook up when the connection is disconnected, and refuses chats for a connection that is not a Telegram one', async () => {
    const { hook } = await turnOn(a);
    expect(await rows('SELECT chat_state FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'on' }]);
    // While chats are on it is refused (the webhook is removed by turning off, which needs the token a disconnect forgets); turned off first it goes.
    await expect(api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { ...asOwner(a), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CHAT_IS_ON', status: 409 });
    await api.execute('kernel.channel.telegram_chat_set', { connectionId: a.connectionId, on: false }, asOwner(a));
    const gone = telegram();
    expect(await runTelegramChatHook(hookDeps(gone.fetchImpl), { orgId: a.orgId, connectionId: a.connectionId, action: 'chat', on: false })).toBe('off');
    expect(gone.calls.map((c) => c.method)).toEqual(['deleteWebhook']);
    await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { ...asOwner(a), idempotencyKey: randomUUID() });
    expect(await rows('SELECT chat_state, chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [a.orgId, a.connectionId])).toEqual([{ chat_state: 'off', chat_hook: null }]);
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

  it('gives a reconnected connection a new hook and so a new secret, and sets the webhook again with the new token', async () => {
    // The bot of org B answers chats (the test before left it off with a failed delete).
    hookB = (await turnOn(b)).hook;
    const before = (await rows<{ chat_hook: string; chat_state: string }>('SELECT chat_hook, chat_state FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId]))[0] as { chat_hook: string; chat_state: string };
    expect(before.chat_state).toBe('on');
    // The owner pastes the bot token again: the same account reconnects on the same row.
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN_B, username: null }), { orgId: b.orgId, provider: 'telegram', externalAccountId: CHANNEL_B });
    const again = await api.execute<{ connectionId: string; reconnected: boolean }>(
      'kernel.channel.connect',
      { provider: 'telegram', externalAccountId: CHANNEL_B, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      asOwner(b),
    );
    expect(again).toEqual({ connectionId: b.connectionId, reconnected: true });
    const [after] = await rows<{ chat_hook: string; chat_state: string }>('SELECT chat_hook, chat_state FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, b.connectionId]);
    expect(after?.chat_state).toBe('enabling');
    expect(after?.chat_hook).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(after?.chat_hook).not.toBe(before.chat_hook);
    const t = telegram();
    expect(await runTelegramChatHook(hookDeps(t.fetchImpl), { orgId: b.orgId, connectionId: b.connectionId, action: 'chat', on: true })).toBe('on');
    expect(t.calls).toEqual([{ method: 'setWebhook', token: TOKEN_B, json: { url: `${APP_URL}${BASE}/${after?.chat_hook}`, secret_token: secretOf(after?.chat_hook as string), allowed_updates: ['message'] } }]);
    // The secret of the old hook opens nothing on the new one, and an update on the old hook finds no connection.
    expect((await post(app, after?.chat_hook as string, update('x'), signed(before.chat_hook))).status).toBe(401);
    hookB = after?.chat_hook as string;
    // A connect event of the reconnect and the queued switch carry ids only, never the hook.
    expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE payload::text LIKE $1', [`%${after?.chat_hook}%`])).length).toBe(0);
  });

  it('lists the chat state of a connection and keeps the hook out of the list and the export', async () => {
    const list = await api.query<Array<{ id: string; chatState: string; chatError: string | null }>>('kernel.channel.list', {}, asOwner(b));
    // The reconnect before left it on (its webhook set again with the new hook).
    expect(list.find((c) => c.id === b.connectionId)).toMatchObject({ chatState: 'on', chatError: null });
    const after = await api.query<Array<{ id: string; chatState: string; chatError: string | null }>>('kernel.channel.list', {}, asOwner(b));
    const row = after.find((c) => c.id === b.connectionId);
    expect(row).toMatchObject({ chatState: 'on', chatError: null });
    expect(JSON.stringify(after)).not.toContain(hookB);
  });
});
