// SPDX-License-Identifier: AGPL-3.0-only
// Zalo OA's webhook of customers' messages on PostgreSQL 17 (conversation core, #2304): the route exists only where the Zalo app and its
// OA secret key are set; it checks the signature before anything else and refuses a wrong one with one answer that says nothing; it caps
// the body before reading it; it parks only a verified notice that carries a message, names no org in its path or answer, and writes no
// tenant row; and the worker takes a parked notice into the thread of the customer under the org that holds the OA's connection, once,
// whatever order and however many times Zalo sends it. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZALO_MAX_NOTICE_BYTES, ZaloOaPublisher, type Fetch } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { runConversationIntake, runConversationJob } from '../src/conversations-worker.ts';
import { ZALO_REPLAY_WINDOW_MS, ZaloReplayCache } from '../src/zalo-webhook.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-zalo-0123456789-abcdefghij';
const ISSUER = 'crove-auth';
const APP_ID = '4318000000000000001';
const OA_KEY = 'test-oa-secret-key-not-real';
const PATH = '/api/channels/zalo/webhook';
// The route's clock: the fixtures are dated within a day of it (a notice older than a day is not parked).
const NOW = 1788300200000;

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

const mac = (body: string, timestamp: string, key = OA_KEY) => `mac=${createHash('sha256').update(APP_ID + body + timestamp + key).digest('hex')}`;

suite('the Zalo OA webhook on PostgreSQL (#2304)', () => {
  const dbName = `crove_test_zalo_webhook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let bare: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let orgId = '';
  let connectionId = '';
  let ownerId = '';
  let api: Runtime;
  let appConfig: ReturnType<typeof loadConfig>;
  let appDb: Db;
  let vault: CredentialVault;

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
  const post = (target: ReturnType<typeof createHttpApp>, body: string, headers: Record<string, string> = {}) =>
    target.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const signed = (body: string, timestamp: string, key = OA_KEY) => ({ 'x-zevent-signature': mac(body, timestamp, key) });
  const text = (msgId: string, content: string, timestamp = '1788300000000', user = 'u-100', oa = 'oa-1') =>
    `{"app_id":"${APP_ID}","user_id_by_app":"app-${user}","event_name":"user_send_text","timestamp":"${timestamp}","sender":{"id":"${user}"},"recipient":{"id":"${oa}"},"message":{"msg_id":"${msgId}","text":${JSON.stringify(content)}}}`;
  const intake = () => runConversationIntake({ workerDb, runtime: worker });
  const commonDeps = () => ({ config: appConfig, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(appConfig, appDb), pool: pools[0] as pg.Pool, aiEnabled: false });

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
    app = createHttpApp({ ...common, zaloWebhook: { appId: APP_ID, oaSecretKey: OA_KEY, now: () => NOW } });
    bare = createHttpApp(common);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    // An org with a Zalo OA connection (the account is the OA's own id).
    ownerId = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@zalo.test`, name: null })) as string;
    orgId = (await createOrg(api, { type: 'user', userId: ownerId, aal: 'aal1' }, 'Công ty Zalo')).orgId;
    // The owner connects the OA through the command, its tokens sealed as the API seals them.
    const sealed = vault.seal(JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' }), { orgId, provider: 'zalo_oa', externalAccountId: 'oa-1' });
    connectionId = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'zalo_oa', externalAccountId: 'oa-1', displayName: 'OA thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: { type: 'user', userId: ownerId, aal: 'aal1' }, orgId },
      )
    ).connectionId;
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('does not exist without the Zalo app and its OA secret key', async () => {
    const body = text('m-0', 'xin chào');
    // Not a route: it answers as a path nobody registered does, whatever the signature, and nothing is parked.
    const unregistered = await bare.request('/api/channels/nobody/webhook', { method: 'POST', body });
    const answer = await post(bare, body, signed(body, '1788300000000'));
    expect([answer.status, await answer.text()]).toEqual([unregistered.status, await unregistered.text()]);
    expect(await waiting()).toBe(0);
  });

  it('refuses a missing, malformed or wrong signature with one answer, and parks and stores nothing', async () => {
    const body = text('m-1', 'Nội dung không được lưu');
    const answers = await Promise.all(
      [
        {},
        { 'x-zevent-signature': 'mac=zz' },
        { 'x-zevent-signature': `mac=${'0'.repeat(64)}` },
        signed(body, '1788300000000', 'another-key'),
        signed(body, '1788300000001'),
        signed(`${body} `, '1788300000000'),
      ].map(async (headers) => {
        const r = await post(app, body, headers);
        return { status: r.status, body: await r.text() };
      }),
    );
    for (const a of answers) expect(a).toEqual({ status: 401, body: '{"code":"WEBHOOK_SIGNATURE"}' });
    expect(await waiting()).toBe(0);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [orgId])).toHaveLength(0);
  });

  it('refuses a body over its cap before reading it, even with a valid signature', async () => {
    const big = `{"timestamp":"1788300000000","event_name":"user_send_text","x":"${'a'.repeat(ZALO_MAX_NOTICE_BYTES)}"}`;
    const response = await post(app, big, signed(big, '1788300000000'));
    expect(response.status).toBe(413);
    expect(await waiting()).toBe(0);
  });

  it('parks a verified message, names no org, and writes no tenant row', async () => {
    const body = text('m-2', 'Shop còn hàng không?');
    const response = await post(app, body, signed(body, '1788300000000'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(await waiting()).toBe(1);
    // Nothing of an org or a thread yet: only the worker finds the org, from the stored connection.
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [orgId])).toHaveLength(0);
    expect(await rows('SELECT provider FROM crove_kernel.conversation_inbound_pending')).toEqual([{ provider: 'zalo_oa' }]);
    // The worker stores it in the thread of that customer, deletes the notice, and the text is the customer's, tainted.
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await waiting()).toBe(0);
    expect(await rows("SELECT m.body, m.direction, m.tainted, m.seq, c.kind, c.external_thread_id, c.reply_window_until IS NOT NULL AS windowed, i.external_user_id FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id WHERE m.org_id = $1", [orgId])).toEqual([
      { body: 'Shop còn hàng không?', direction: 'in', tainted: true, seq: 1, kind: 'direct', external_thread_id: 'u-100', windowed: true, external_user_id: 'u-100' },
    ]);
    // The free window runs 48 hours from the customer's message (the platform's own time).
    expect(Number((await rows<{ hours: string }>("SELECT extract(epoch FROM (reply_window_until - last_inbound_at)) / 3600 AS hours FROM crove_kernel.conversation WHERE org_id = $1", [orgId]))[0]?.hours)).toBe(48);
  });

  it('answers a replayed event without parking it again for an hour, and parks one whose first try was refused', async () => {
    let clock = Date.now();
    const replays = new ZaloReplayCache(() => clock);
    const replaying = createHttpApp({ ...commonDeps(), zaloWebhook: { appId: APP_ID, oaSecretKey: OA_KEY, now: () => NOW }, zaloReplays: replays });
    const body = text('m-replay', 'Gửi lại nhiều lần', '1788300090000');
    const send = () => post(replaying, body, signed(body, '1788300090000'));
    expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(1);
    // Zalo's resend and a captured body replayed: each is answered 200 and none is parked.
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(1);
    // Another event is parked as usual; a replay past the window is parked again (the unique message id keeps the thread to one).
    const other = text('m-replay-2', 'Tin khác', '1788300091000');
    expect((await post(replaying, other, signed(other, '1788300091000'))).status).toBe(200);
    expect(await waiting()).toBe(2);
    clock += ZALO_REPLAY_WINDOW_MS + 1;
    expect((await send()).status).toBe(200);
    expect(await waiting()).toBe(3);
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND external_message_id = 'm-replay'", [orgId])).toHaveLength(1);
    // A signature that fails never reaches the cache, so a forged body cannot make a real one look replayed.
    const real = text('m-forged', 'Thật', '1788300092000');
    expect((await post(replaying, real, signed(real, '1788300092000', 'another-key'))).status).toBe(401);
    expect((await post(replaying, real, signed(real, '1788300092000'))).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
  });

  it('answers 200 and parks nothing for a verified notice older than a day, and says 503 past ten thousand waiting', async () => {
    const old = text('m-old', 'Bản ghi bị phát lại', String(NOW - 25 * 3_600_000));
    expect((await post(app, old, signed(old, String(NOW - 25 * 3_600_000)))).status).toBe(200);
    expect(await waiting()).toBe(0);
    // The definer refuses past 10000 waiting notices; Zalo does not retry an error status, so this is the loss the history read recovers.
    await rows("INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) SELECT 'zalo_oa', 'x'::bytea FROM generate_series(1, 10001)");
    const fresh = text('m-full', 'Hàng đợi đầy', '1788300110000');
    const response = await post(app, fresh, signed(fresh, '1788300110000'));
    expect([response.status, await response.text()]).toEqual([503, '{"code":"BACKLOG"}']);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
    // Once there is room the same notice (Zalo's resend, or the next try) is parked: a refused one was not remembered as seen.
    expect((await post(app, fresh, signed(fresh, '1788300110000'))).status).toBe(200);
    expect(await waiting()).toBe(1);
    await intake();
  });

  it('logs nothing of the body it parks or refuses', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
      return () => void (console[level] = original);
    });
    try {
      const secretText = 'số điện thoại 0912345678 của Nguyễn Văn Mẫu';
      const good = text('m-quiet', secretText, '1788300100000');
      await post(app, good, signed(good, '1788300100000'));
      await post(app, good, {});
      await post(app, '{ not json', signed('{ not json', '1'));
      await intake();
    } finally {
      for (const restore of spies) restore();
    }
    expect(lines.join(' | ')).not.toMatch(/0912345678|Nguyễn Văn Mẫu|m-quiet|u-100/);
    expect(lines.join(' | ')).not.toContain(OA_KEY);
  });

  it('takes a redelivered or out-of-order notice once, and an OA with no connection nowhere', async () => {
    const first = text('m-3', 'Tin đến trước', '1788300010000');
    const later = text('m-4', 'Tin đến sau', '1788300020000');
    for (const [body, ts] of [[later, '1788300020000'], [first, '1788300010000'], [later, '1788300020000']] as const) {
      expect((await post(app, body, signed(body, ts))).status).toBe(200);
    }
    expect(await intake()).toEqual({ stored: 2, dropped: 0 });
    const seen = await rows<{ body: string; seq: number }>("SELECT body, seq FROM crove_kernel.conversation_message WHERE org_id = $1 AND body LIKE 'Tin đến%' ORDER BY seq", [orgId]);
    expect(seen).toHaveLength(2);
    // An OA no org connected: parked, claimed, found nowhere, deleted.
    const stranger = text('m-5', 'Gửi cho OA lạ', '1788300030000', 'u-9', 'oa-nobody');
    expect((await post(app, stranger, signed(stranger, '1788300030000'))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await waiting()).toBe(0);
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_message WHERE body = 'Gửi cho OA lạ'")).toHaveLength(0);
  });

  it('answers 200 and parks nothing for a verified notice with no message in it, and 400 for a verified body that is not a notice', async () => {
    const follow = `{"app_id":"${APP_ID}","event_name":"follow","timestamp":"1788300040000","follower":{"id":"u-1"},"oa_id":"oa-1"}`;
    expect((await post(app, follow, signed(follow, '1788300040000'))).status).toBe(200);
    const seen = `{"app_id":"${APP_ID}","event_name":"user_seen_message","timestamp":"1788300050000","sender":{"id":"u-100"},"recipient":{"id":"oa-1"}}`;
    expect((await post(app, seen, signed(seen, '1788300050000'))).status).toBe(200);
    expect(await waiting()).toBe(0);
    const broken = '[{"timestamp":"1788300060000"}]';
    const response = await post(app, broken, signed(broken, '1788300060000'));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"code":"WEBHOOK_MALFORMED"}');
    expect(await waiting()).toBe(0);
  });

  it("stores the OA's own message from its inbox as an echo, and answers 429 past its rate limit", async () => {
    const echo = `{"app_id":"${APP_ID}","event_name":"oa_send_text","timestamp":"1788300070000","sender":{"id":"oa-1"},"recipient":{"id":"u-100"},"message":{"msg_id":"zm-9","text":"Dạ còn ạ"}}`;
    expect((await post(app, echo, signed(echo, '1788300070000'))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await rows("SELECT direction, author_kind, send_state FROM crove_kernel.conversation_message WHERE org_id = $1 AND external_message_id = 'zm-9'", [orgId])).toEqual([{ direction: 'out', author_kind: 'system', send_state: 'sent' }]);
    // A limit of its own per client address, before anything is read.
    const limited = createHttpApp({
      config: loadConfig({ DATABASE_URL: 'postgres://x/y', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }),
      runtime: worker,
      store: new MemoryStore(),
      authenticate: (async () => {
        throw new Error('not used');
      }) as never,
      pool: pools[0] as pg.Pool,
      aiEnabled: false,
      zaloWebhook: { appId: APP_ID, oaSecretKey: OA_KEY },
      zaloWebhookLimit: new RateLimiter({ perMinute: 2 }),
    });
    const body = text('m-10', 'x');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(limited, body, {})).status);
    expect(statuses).toEqual([401, 401, 429]);
    // Only refused requests are charged: with the bucket of this address spent, a verified notice from it is still answered (#2348).
    const follow = `{"app_id":"${APP_ID}","event_name":"follow","timestamp":"1788300041000","follower":{"id":"u-1"},"oa_id":"oa-1"}`;
    expect((await post(limited, follow, signed(follow, '1788300041000'))).status).toBe(200);
    expect((await post(limited, body, {})).status).toBe(429);
  });

  it('takes a notice signed with the previous OA secret key while a rotation is under way, and refuses any other key (#2348)', async () => {
    const rotating = createHttpApp({
      config: appConfig,
      runtime: api,
      store: new MemoryStore(),
      authenticate: createAuthenticator(appConfig, appDb),
      pool: pools[0] as pg.Pool,
      aiEnabled: false,
      zaloWebhook: { appId: APP_ID, oaSecretKey: 'the-new-oa-secret-key-0001', oaSecretKeyPrevious: OA_KEY, now: () => NOW },
    });
    const viaOld = text('m-rot-1', 'Ký bằng khóa cũ', '1788300300000');
    expect((await post(rotating, viaOld, signed(viaOld, '1788300300000', OA_KEY))).status).toBe(200);
    const viaNew = text('m-rot-2', 'Ký bằng khóa mới', '1788300310000');
    expect((await post(rotating, viaNew, signed(viaNew, '1788300310000', 'the-new-oa-secret-key-0001'))).status).toBe(200);
    const viaOther = text('m-rot-3', 'Khóa lạ', '1788300320000');
    expect((await post(rotating, viaOther, signed(viaOther, '1788300320000', 'some-other-key-entirely'))).status).toBe(401);
    // Without a previous key the old one is refused.
    expect((await post(app, viaNew, signed(viaNew, '1788300310000', 'the-new-oa-secret-key-0001'))).status).toBe(401);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
  });

  it("is not refused for the sandbox's backlog: the cap is per provider (#2348)", async () => {
    // The sandbox is refused at its own cap of 1000 waiting notices, while the real platform is still accepted.
    await rows("INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) SELECT 'sandbox', 'x'::bytea FROM generate_series(1, 1000)");
    const client = new pg.Client({ connectionString: appConfig.DATABASE_URL });
    await client.connect();
    try {
      await expect(client.query("SELECT crove_kernel.conversation_inbound_enqueue('sandbox', 'y'::bytea)")).rejects.toMatchObject({ code: '53400' });
      await expect(client.query("SELECT crove_kernel.conversation_inbound_enqueue('zalo_oa', 'z'::bytea)")).resolves.toBeDefined();
    } finally {
      await client.end();
    }
    await rows("DELETE FROM crove_kernel.conversation_inbound_pending WHERE provider = 'zalo_oa'");
    const real = text('m-cap-1', 'Tin thật vẫn nhận', '1788300400000');
    expect((await post(app, real, signed(real, '1788300400000'))).status).toBe(200);
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_inbound_pending WHERE provider = 'zalo_oa'")).toHaveLength(1);
    await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
  });
  it('answers the customer through the customer care API once, inside the 48-hour window, and refuses a reply after it', async () => {
    const asOwner = { actor: { type: 'user' as const, userId: ownerId, aal: 'aal1' as const }, orgId };
    // The fixtures above are dated in the past (the window counts from the platform's own time), so the customer writes again now.
    const now = String(Date.now());
    const fresh = text('m-now', 'Còn hàng không shop?', now);
    expect((await post(app, fresh, signed(fresh, now))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    const thread = (await rows<{ id: string; last_seq: number }>("SELECT id, last_seq FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'u-100'", [orgId]))[0] as { id: string; last_seq: number };
    const calls: { url: string; user: string; text: string; token: string }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const json = JSON.parse(String(init?.body)) as { recipient: { user_id: string }; message: { text: string } };
      calls.push({ url: String(input), user: json.recipient.user_id, text: json.message.text, token: new Headers(init?.headers).get('access_token') ?? '' });
      return new Response(JSON.stringify({ error: 0, message: 'Success', data: { message_id: 'zm-reply-1', user_id: json.recipient.user_id } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new ZaloOaPublisher({ appId: APP_ID, appSecret: 'test-zalo-secret-not-real' }, fetchImpl).conversations;
    const deps = { runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'zalo_oa' ? adapter : undefined) };
    // The window is open (the notices above just arrived); the customer's last message is the newest in the thread.
    const { messageId } = await api.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: thread.id, body: 'Dạ shop còn hàng ạ', lastSeenSeq: thread.last_seq }, asOwner);
    const job = { orgId, messageId, connectionId, action: 'reply' as const };
    expect(await runConversationJob(deps, job)).toBe('accepted');
    expect(calls).toEqual([{ url: 'https://openapi.zalo.me/v3.0/oa/message/cs', user: 'u-100', text: 'Dạ shop còn hàng ạ', token: 'zalo-access-1' }]);
    expect(await rows('SELECT send_state, external_message_id FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [orgId, messageId])).toEqual([{ send_state: 'sent', external_message_id: 'zm-reply-1' }]);
    // The same job again calls nothing; the echo of the reply that then arrives matches it by id and stores no second message.
    expect(await runConversationJob(deps, job)).toBe('settled');
    expect(calls).toHaveLength(1);
    const echo = `{"app_id":"${APP_ID}","event_name":"oa_send_text","timestamp":"1788300080000","sender":{"id":"oa-1"},"recipient":{"id":"u-100"},"message":{"msg_id":"zm-reply-1","text":"Dạ shop còn hàng ạ"}}`;
    expect((await post(app, echo, signed(echo, '1788300080000'))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await rows("SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND body = 'Dạ shop còn hàng ạ'", [orgId])).toHaveLength(1);
    // Past 48 hours from the customer's last message a reply is refused with its reason, and Zalo is not asked.
    await rows("UPDATE crove_kernel.conversation SET reply_window_until = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [orgId, thread.id]);
    const seq = (await rows<{ last_seq: number }>('SELECT last_seq FROM crove_kernel.conversation WHERE id = $1', [thread.id]))[0]?.last_seq as number;
    await expect(api.execute('kernel.conversation.reply', { conversationId: thread.id, body: 'Quá hạn', lastSeenSeq: seq }, asOwner)).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED', status: 409 });
    const detail = await api.query<{ reply: { allowed: boolean; reason: string | null } }>('kernel.conversation.get', { conversationId: thread.id }, asOwner);
    expect(detail.reply).toEqual({ allowed: false, reason: 'window_closed' });
    expect(calls).toHaveLength(1);
    // A reply to a customer of the OA is not a comment: Zalo has no comment API, so hiding is not offered either.
    await expect(api.execute('kernel.conversation.hide', { messageId, hidden: true }, asOwner)).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
  });
});
