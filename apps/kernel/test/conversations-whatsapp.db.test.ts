// SPDX-License-Identifier: AGPL-3.0-only
// WhatsApp Business (Cloud API) in the conversation core on PostgreSQL 17 (issue #3131, plan docs/plan/conversations-channels.md section 4.1): the webhook route
// exists only where the WhatsApp app secret and verify token are set, answers the handshake, checks X-Hub-Signature-256 over the raw bytes before anything else
// and parks only a verified notice; the worker takes a message into the thread of the customer (by their wa_id) under the org that holds the phone number's
// connection, once; a reply goes out once with the sealed token inside the customer's 24 hours and never after them; a status `failed` marks the message; an
// unclear send is never sent again by a button; an image arrives by media id and is stored through the attachment pipeline with the connection's token opened
// inside the job; Dy's draft, the saved replies and the phone match work on the channel with a person pressing Send; erasure, retention, purge and export cover
// the rows; and no phone number, body, media id or token reaches an audit row, an event, a job or a log. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Graph, WHATSAPP_MAX_NOTICE_BYTES, WhatsAppConversations, type ConversationAdapter, type Fetch } from '@crove/channel';
import { metered, type AiUsage, type ReplyDraftRequest, type ReplyDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { EXPORT_TABLES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail } from '@crove/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { systemMeter } from '../src/ai-meter.ts';
import { dueConversationAttachments, purgeExpiredConversations, requestConversationAttachments, requestDueConversationDrafts, runConversationAttachment, runConversationDraft, runConversationIntake, runConversationJob, sweepConversationBlobs, sweepStaleReplies, type ConversationDraftJob } from '../src/conversations-worker.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { WhatsAppReplayCache } from '../src/whatsapp-webhook.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const JWT_SECRET = 'test-only-jwt-secret-for-whatsapp-0123456789-abcdef';
const APP_SECRET = 'whatsapp-app-secret-not-real-000000000001';
const VERIFY = 'whatsapp-verify-token-not-real';
const ACCESS_TOKEN = `EAAG${'t'.repeat(48)}`;
const PATH = '/api/channels/whatsapp/webhook';
// The customers of these tests: fake numbers in the format WhatsApp gives (digits, country code first), none of them a real person's.
const LAN = '84900000001';
const MINH = '84900000002';
const BODY = 'Cho mình hỏi giá bánh kem xyzzy-bí-mật nhé';
const PNG = (() => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(2, 16);
  header.writeUInt32BE(3, 20);
  return Buffer.concat([header, randomBytes(8)]);
})();

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
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

const sign = (body: string, secret = APP_SECRET) => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}` });

suite('WhatsApp conversations on PostgreSQL (#3131)', () => {
  const dbName = `crove_test_whatsapp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let bare: ReturnType<typeof createHttpApp>;
  let appConfig: ReturnType<typeof loadConfig>;
  let vault: CredentialVault;
  const store = new MemoryStore();

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
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
  // A superuser's session skips triggers, as a restore would: used to age rows past the guards that keep their dates.
  const aged = (text: string, params: unknown[] = []) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      const result = await c.query(text, params);
      await c.query('COMMIT');
      return result.rows;
    });
  const waiting = async () => (await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).length;
  const post = (target: ReturnType<typeof createHttpApp>, body: string, headers: Record<string, string> = sign(body)) =>
    target.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const intake = () => runConversationIntake({ workerDb, runtime: worker, log: () => undefined });

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; phoneId: string; connectionId: string };
  const person = async (name: string) => (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@whatsapp.test`, name: null })) as string;
  let phones = 0;
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [adm, member, viewer] = [await person('admin'), await person('member'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adm, member, viewer]);
    // The number's connection, made as the API makes it: the token and the WABA id sealed for the phone number id.
    const phoneId = `1040000000${String(1000 + phones++)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '204000000000001' }), { orgId, provider: 'whatsapp', externalAccountId: phoneId });
    const connected = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'whatsapp', externalAccountId: phoneId, displayName: 'Tiệm Bánh An Nhiên', scopes: ['whatsapp_business_messaging'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(owner), orgId },
    );
    // The connection began long ago: an event dated before it is the earlier holder's (see 'one number, one organization'), and the tests date messages minutes back.
    await rows("UPDATE crove_kernel.channel_connection SET connected_at = now() - interval '30 days' WHERE org_id = $1 AND id = $2", [orgId, connected.connectionId]);
    return { orgId, owner, admin: adm, member, viewer, phoneId, connectionId: connected.connectionId };
  }

  // The notice Meta sends [M], dated now unless a time is given (seconds, as a string).
  let tick = 0;
  const secondsAgo = (s: number) => String(Math.floor(Date.now() / 1000) - s);
  const message = (from: string, over: Record<string, unknown> = {}) => ({ from, id: `wamid.test${tick++}-${randomUUID().slice(0, 8)}`, timestamp: secondsAgo(60), type: 'text', text: { body: BODY }, ...over });
  const noticeOf = (o: Org, value: Record<string, unknown>) =>
    JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '204000000000001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '84900000099', phone_number_id: o.phoneId }, ...value } }] }] });
  const customerNotice = (o: Org, m: ReturnType<typeof message>, name = 'Lan Nguyễn') => noticeOf(o, { contacts: [{ profile: { name }, wa_id: m.from }], messages: [m] });
  const imageNotice = (o: Org, mediaId: string, wa = LAN) => customerNotice(o, message(wa, { type: 'image', text: undefined, image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'x' } }));
  const threadOf = async (o: Org, wa: string) => ((await rows<{ id: string; last_seq: number }>('SELECT id, last_seq FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, wa]))[0] as { id: string; last_seq: number });
  const detail = (o: Org, id: string, user = o.owner) => api.query<ConversationDetail>('kernel.conversation.get', { conversationId: id }, { actor: asUser(user), orgId: o.orgId });
  // A customer writes: the route parks the notice and the worker stores it.
  async function customerWrites(o: Org, wa = LAN, over: Record<string, unknown> = {}, name = 'Lan Nguyễn') {
    const m = message(wa, over);
    expect((await post(app, customerNotice(o, m, name))).status).toBe(200);
    expect(await intake()).toMatchObject({ dropped: 0 });
    return { m, thread: await threadOf(o, wa) };
  }

  // The Graph API, answered from memory: what the adapter sent is kept, and the next answer is the one queued (or a success with a fresh wamid).
  function graph(answers: Array<{ status?: number; body?: unknown } | Error> = []) {
    const calls: Array<{ method: string; path: string; token: string; body: unknown }> = [];
    let n = 0;
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, token: new Headers(init?.headers).get('authorization') ?? '', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      const body = next?.body ?? { messaging_product: 'whatsapp', messages: [{ id: `wamid.sent${n++}-${randomUUID().slice(0, 8)}` }] };
      return new Response(JSON.stringify(body), { status: next?.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, adapter: new WhatsAppConversations(new Graph(APP_SECRET, undefined, fetchImpl)) };
  }
  const jobDeps = (adapter: ConversationAdapter) => ({ runtime: worker, broker: vault, adapter: (provider: string) => (provider === 'whatsapp' ? adapter : undefined) });
  const reply = (o: Org, thread: { id: string; last_seq: number }, text = 'Dạ shop gửi bảng giá ạ', extra: Record<string, unknown> = {}, user = o.owner) =>
    api.execute<{ messageId: string; seq: number }>('kernel.conversation.reply', { conversationId: thread.id, body: text, lastSeenSeq: thread.last_seq, ...extra }, { actor: asUser(user), orgId: o.orgId });
  const jobOf = (o: Org, messageId: string) => ({ orgId: o.orgId, messageId, connectionId: o.connectionId, action: 'reply' as const });
  const messageRow = async (messageId: string) => (await rows<{ send_state: string; send_error_code: string | null; external_message_id: string | null }>('SELECT send_state, send_error_code, external_message_id FROM crove_kernel.conversation_message WHERE id = $1', [messageId]))[0];

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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    db = createDb(pool);
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    appConfig = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: JWT_SECRET, AUTH_ISSUER: 'crove-auth', AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const common = { config: appConfig, runtime: api, store, authenticate: createAuthenticator(appConfig, db), pool, aiEnabled: false };
    app = createHttpApp({ ...common, whatsappWebhook: { appSecret: APP_SECRET, verifyToken: VERIFY } });
    bare = createHttpApp(common);
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('the channel list', () => {
    it('leaves WhatsApp out of every picker that publishes, and lists it for the screens that ask (the Channels screen, the Inbox, a member’s channel access)', async () => {
      const o = await org();
      const list = (input: Record<string, unknown>) => api.query<Array<{ provider: string; displayName: string }>>('kernel.channel.list', input, { actor: asUser(o.owner), orgId: o.orgId });
      expect((await list({})).map((c) => c.provider)).toEqual([]);
      expect((await list({ includeMessaging: true })).map((c) => [c.provider, c.displayName])).toEqual([['whatsapp', 'Tiệm Bánh An Nhiên']]);
      expect((await list({ includeEmail: true })).map((c) => c.provider)).toEqual(['whatsapp']);
      // The connection is the phone number: reconnecting the same number is a reconnect of the same connection.
      const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '204000000000001' }), { orgId: o.orgId, provider: 'whatsapp', externalAccountId: o.phoneId });
      const again = await api.execute<{ connectionId: string; reconnected: boolean }>(
        'kernel.channel.connect',
        { provider: 'whatsapp', externalAccountId: o.phoneId, displayName: 'Tiệm Bánh An Nhiên', scopes: ['whatsapp_business_messaging'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: asUser(o.owner), orgId: o.orgId },
      );
      expect(again).toEqual({ connectionId: o.connectionId, reconnected: true });
      // A viewer reads the list; the sealed credential is in none of it.
      const text = JSON.stringify(await list({ includeMessaging: true }));
      expect(text).not.toContain(ACCESS_TOKEN);
    });
  });

  describe('one number, one organization', () => {
    it('refuses to connect a number another organization holds, lets the same organization reconnect its own, and allows it once the first disconnected', async () => {
      const a = await org();
      const b = await org();
      const connect = (o: Org, phoneId: string) => {
        const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '204000000000001' }), { orgId: o.orgId, provider: 'whatsapp', externalAccountId: phoneId });
        return api.execute<{ connectionId: string }>(
          'kernel.channel.connect',
          { provider: 'whatsapp', externalAccountId: phoneId, displayName: 'Tiệm Bánh An Nhiên', scopes: ['whatsapp_business_messaging'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
          { actor: asUser(o.owner), orgId: o.orgId },
        );
      };
      // A pasted token proves its holder may call the number, not that the number is theirs: the second organization is refused, and no connection row is made.
      await expect(connect(b, a.phoneId)).rejects.toMatchObject({ code: 'CHANNEL_ACCOUNT_TAKEN', status: 409 });
      expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [b.orgId, a.phoneId])).toHaveLength(0);
      // The organization that holds it reconnects it (a new token) and keeps its row.
      await expect(connect(a, a.phoneId)).resolves.toMatchObject({ connectionId: a.connectionId });
      // A customer's message for the number is stored in the holder only.
      const m = message(LAN);
      expect((await post(app, customerNotice(a, m))).status).toBe(200);
      expect(await intake()).toMatchObject({ dropped: 0 });
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(1);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(0);
      // Once the holder disconnects, the number is free for the other organization.
      await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { actor: asUser(a.owner), orgId: a.orgId });
      const taken = await connect(b, a.phoneId);
      expect(taken.connectionId).not.toBe(a.connectionId);
    });

    it('does not hand a new holder the earlier holder’s customers: a notice waiting from before the number changed hands is ignored, one dated after it is stored', async () => {
      const a = await org();
      const b = await org();
      // A customer of A writes; the notice waits (the worker is busy), then A disconnects and B connects the same number.
      expect((await post(app, customerNotice(a, message(LAN, { timestamp: secondsAgo(120) })))).status).toBe(200);
      expect(await waiting()).toBe(1);
      await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { actor: asUser(a.owner), orgId: a.orgId });
      const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '204000000000001' }), { orgId: b.orgId, provider: 'whatsapp', externalAccountId: a.phoneId });
      await api.execute(
        'kernel.channel.connect',
        { provider: 'whatsapp', externalAccountId: a.phoneId, displayName: 'Tiệm B', scopes: ['whatsapp_business_messaging'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: asUser(b.owner), orgId: b.orgId },
      );
      const holder: Org = { ...b, phoneId: a.phoneId };
      expect(await intake()).toMatchObject({ dropped: 0 });
      // The old message reached nobody: not A (disconnected), not B (it began before B held the number).
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = ANY($1::uuid[])', [[a.orgId, b.orgId]])).toHaveLength(0);
      // A customer who writes after B connected is B's.
      expect((await post(app, customerNotice(holder, message(MINH, { timestamp: secondsAgo(-5) })))).status).toBe(200);
      expect(await intake()).toMatchObject({ dropped: 0 });
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(1);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
    });
  });

  describe('the route', () => {
    it('does not exist without the app secret and the verify token', async () => {
      const unregistered = await bare.request('/api/channels/nobody/webhook', { method: 'POST', body: '{}' });
      const body = '{"object":"whatsapp_business_account","entry":[]}';
      const answer = await post(bare, body);
      expect([answer.status, await answer.text()]).toEqual([unregistered.status, await unregistered.text()]);
      const handshake = await bare.request(`${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`);
      const unregisteredGet = await bare.request('/api/channels/nobody/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1');
      expect([handshake.status, await handshake.text()]).toEqual([unregisteredGet.status, await unregisteredGet.text()]);
      expect(await waiting()).toBe(0);
    });

    it('answers the verify-token handshake with the challenge as text, and refuses any other token or mode with one answer', async () => {
      const ok = await app.request(`${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await ok.text()).toBe('1158201444');
      const refused = await Promise.all(
        [`hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`, `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`, `hub.mode=subscribe&hub.challenge=1`, `hub.mode=subscribe&hub.verify_token=${VERIFY}`, ''].map(async (query) => {
          const r = await app.request(`${PATH}?${query}`);
          return { status: r.status, body: await r.text() };
        }),
      );
      for (const r of refused) expect(r).toEqual({ status: 403, body: '{"code":"WEBHOOK_VERIFY_FAILED"}' });
    });

    it('refuses a missing, malformed or wrong signature with one answer, and parks and stores nothing', async () => {
      const o = await org();
      const body = customerNotice(o, message(LAN));
      const answers = await Promise.all(
        [
          {},
          { 'x-hub-signature-256': 'sha256=zz' },
          { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
          sign(body, 'another-secret-entirely-0000000000'),
          sign(`${body} `),
          { 'x-hub-signature-256': sign(body)['x-hub-signature-256'].toUpperCase() },
        ].map(async (headers) => {
          const r = await post(app, body, headers);
          return { status: r.status, body: await r.text() };
        }),
      );
      for (const a of answers) expect(a).toEqual({ status: 401, body: '{"code":"WEBHOOK_SIGNATURE"}' });
      expect(await waiting()).toBe(0);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(0);
    });

    it('refuses a body over its cap before reading it, even with a valid signature, and a verified body that is not a notice', async () => {
      const big = `{"object":"whatsapp_business_account","entry":[],"x":"${'a'.repeat(WHATSAPP_MAX_NOTICE_BYTES)}"}`;
      expect((await post(app, big)).status).toBe(413);
      const broken = '[{"object":"page"}]';
      const response = await post(app, broken);
      expect([response.status, await response.text()]).toEqual([400, '{"code":"WEBHOOK_MALFORMED"}']);
      expect(await waiting()).toBe(0);
    });

    it('answers a notice of another product 200 and parks nothing, and so for statuses that carry nothing to store', async () => {
      const o = await org();
      expect((await post(app, JSON.stringify({ object: 'page', entry: [] }))).status).toBe(200);
      const statuses = noticeOf(o, { statuses: ['sent', 'delivered', 'read'].map((status, i) => ({ id: `wamid.s${i}`, status, timestamp: secondsAgo(30), recipient_id: LAN })) });
      expect((await post(app, statuses)).status).toBe(200);
      expect(await waiting()).toBe(0);
    });

    it('is charged to a refused request only, and answers 429 past its own limit', async () => {
      const { RateLimiter } = await import('../src/rate-limit.ts');
      const limited = createHttpApp({ config: appConfig, runtime: worker, store, authenticate: (async () => { throw new Error('not used'); }) as never, pool: pools[0] as pg.Pool, aiEnabled: false, whatsappWebhook: { appSecret: APP_SECRET, verifyToken: VERIFY }, whatsappWebhookLimit: new RateLimiter({ perMinute: 2 }) });
      const body = '{"object":"whatsapp_business_account","entry":[]}';
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await post(limited, body, {})).status);
      expect(statuses).toEqual([401, 401, 429]);
      // A verified notice from the same address is still answered, and so is the handshake.
      expect((await post(limited, body)).status).toBe(200);
    });
  });

  describe('a customer writes', () => {
    it('is parked by a verified notice, names no org, writes no tenant row, and is stored by the worker under the connection of the number, tainted, with the name and the number the customer has', async () => {
      const o = await org();
      const m = message(LAN, { timestamp: secondsAgo(120) });
      const response = await post(app, customerNotice(o, m));
      expect([response.status, await response.text()]).toEqual([200, '{"ok":true}']);
      expect(await waiting()).toBe(1);
      expect(await rows('SELECT provider FROM crove_kernel.conversation_inbound_pending')).toEqual([{ provider: 'whatsapp' }]);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(0);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      expect(await waiting()).toBe(0);
      expect(
        await rows(
          `SELECT m.body, m.direction, m.tainted, m.seq, c.kind, c.external_thread_id, c.status, i.external_user_id, i.display_name, i.provider
           FROM crove_kernel.conversation_message m JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
           JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id WHERE m.org_id = $1`,
          [o.orgId],
        ),
      ).toEqual([{ body: BODY, direction: 'in', tainted: true, seq: 1, kind: 'direct', external_thread_id: LAN, status: 'new', external_user_id: LAN, display_name: 'Lan Nguyễn', provider: 'whatsapp' }]);
      // The free window runs 24 hours from the customer's message (the platform's own time), and the thread says so.
      expect(Number((await rows<{ hours: string }>('SELECT extract(epoch FROM (reply_window_until - last_inbound_at)) / 3600 AS hours FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId]))[0]?.hours)).toBe(24);
      const thread = await threadOf(o, LAN);
      expect((await detail(o, thread.id)).conversation).toMatchObject({ kind: 'direct', channel: { provider: 'whatsapp', displayName: 'Tiệm Bánh An Nhiên' }, contact: { displayName: 'Lan Nguyễn' } });
      expect((await detail(o, thread.id)).reply).toEqual({ allowed: true, reason: null });
      // Another org's phone number gets nothing of it: the notice named this number only.
      const other = await org();
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [other.orgId])).toHaveLength(0);
    });

    it('is taken once whatever the order and however many times Meta sends it, and a number no org connected nowhere', async () => {
      const o = await org();
      const first = message(LAN, { timestamp: secondsAgo(300), text: { body: 'Tin đến trước' } });
      const later = message(LAN, { timestamp: secondsAgo(200), text: { body: 'Tin đến sau' } });
      for (const m of [later, first, later]) expect((await post(app, customerNotice(o, m))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 2, dropped: 0 });
      // Each message once, in the order the worker took the notices (the thread's own order is the arrival's).
      expect((await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1 ORDER BY body', [o.orgId])).map((r) => r.body)).toEqual(['Tin đến sau', 'Tin đến trước']);
      const stranger = { ...o, phoneId: '104999999999999' };
      expect((await post(app, customerNotice(stranger, message(MINH)))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 0, dropped: 0 });
      expect(await waiting()).toBe(0);
    });

    it('answers a replayed event without parking it again, and parks one whose first try was refused as backlog', async () => {
      const o = await org();
      let clock = Date.now();
      const replays = new WhatsAppReplayCache(() => clock);
      const replaying = createHttpApp({ config: appConfig, runtime: api, store, authenticate: createAuthenticator(appConfig, db), pool: pools[0] as pg.Pool, aiEnabled: false, whatsappWebhook: { appSecret: APP_SECRET, verifyToken: VERIFY }, whatsappReplays: replays });
      const body = customerNotice(o, message(LAN));
      expect((await post(replaying, body)).status).toBe(200);
      expect(await waiting()).toBe(1);
      for (let i = 0; i < 3; i++) expect((await post(replaying, body)).status).toBe(200);
      expect(await waiting()).toBe(1);
      clock += 37 * 3_600_000;
      expect((await post(replaying, body)).status).toBe(200);
      expect(await waiting()).toBe(2);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      // A notice dated past Meta's retries is answered and not parked; past ten thousand waiting the answer is 503, and the same notice is parked once there is room.
      const old = customerNotice(o, message(LAN, { timestamp: secondsAgo(8 * 86_400) }));
      expect((await post(app, old)).status).toBe(200);
      expect(await waiting()).toBe(0);
      // ...while one a deployment missed for two days is still taken.
      const missed = customerNotice(o, message(LAN, { timestamp: secondsAgo(2 * 86_400) }));
      expect((await post(app, missed)).status).toBe(200);
      expect(await waiting()).toBe(1);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      await rows("INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) SELECT 'whatsapp', 'x'::bytea FROM generate_series(1, 10001)");
      const fresh = customerNotice(o, message(MINH));
      expect([(await post(app, fresh)).status, await (await post(app, fresh)).text()]).toEqual([503, '{"code":"BACKLOG"}']);
      await rows('DELETE FROM crove_kernel.conversation_inbound_pending');
      expect((await post(app, fresh)).status).toBe(200);
      expect(await waiting()).toBe(1);
      await intake();
    });

    it('offers the contact whose phone is the customer’s wa_id, first, with no model, and none for an id that is not a phone number', async () => {
      const o = await org();
      const { thread } = await customerWrites(o, LAN);
      await rows("INSERT INTO crove_kernel.party (org_id, kind, name, phone) VALUES ($1, 'person', 'Nguyễn Thị Lan', '0900 000 001'), ($1, 'person', 'Người khác', '0911 111 111')", [o.orgId]);
      const matched = await api.query<{ phone: Array<{ name: string }>; names: Array<{ name: string }> }>('kernel.conversation.contact_candidates', { conversationId: thread.id }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(matched.phone.map((c) => c.name)).toEqual(['Nguyễn Thị Lan']);
      // An identifier that is not a phone number (Meta may give another one) finds nothing by phone.
      const { thread: other } = await customerWrites(o, 'US.13491208655302741918', {}, 'Khách Mỹ');
      const none = await api.query<{ phone: unknown[] }>('kernel.conversation.contact_candidates', { conversationId: other.id }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(none.phone).toEqual([]);
      // The party is never created or linked by the intake.
      expect((await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1 AND party_id IS NOT NULL', [o.orgId]))).toHaveLength(0);
    });
  });

  describe('a customer with a WhatsApp username (a BSUID, no phone number)', () => {
    it('is stored under their BSUID with the name they gave, matches no CRM contact by phone, and is answered with `recipient` and no `to`', async () => {
      const o = await org();
      const bsuid = 'US.13491208655302741918';
      const m = { from_user_id: bsuid, id: `wamid.test${tick++}-${randomUUID().slice(0, 8)}`, timestamp: secondsAgo(60), type: 'text', text: { body: BODY } };
      expect((await post(app, noticeOf(o, { contacts: [{ profile: { name: 'Khách Mỹ', username: 'khach.my' }, user_id: bsuid }], messages: [m] }))).status).toBe(200);
      expect(await waiting()).toBe(1);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      const thread = await threadOf(o, bsuid);
      const seen = await detail(o, thread.id);
      expect(seen.conversation.contact).toMatchObject({ displayName: 'Khách Mỹ' });
      const none = await api.query<{ phone: unknown[] }>('kernel.conversation.contact_candidates', { conversationId: thread.id }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(none.phone).toEqual([]);
      // The reply goes to the BSUID: `recipient`, never `to`, and is sent once.
      const platform = graph();
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('accepted');
      expect(platform.calls).toHaveLength(1);
      expect(platform.calls[0]).toMatchObject({ method: 'POST', path: `/v24.0/${o.phoneId}/messages`, body: { messaging_product: 'whatsapp', recipient: bsuid, type: 'text' } });
      expect(platform.calls[0]?.body).not.toHaveProperty('to');
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'sent' });
    });
  });

  describe('a reply', () => {
    it('goes out once with the sealed token inside the 24 hours, its wamid is stored, and a second job calls nothing', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const platform = graph();
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('accepted');
      expect(platform.calls).toHaveLength(1);
      expect(platform.calls[0]).toMatchObject({ method: 'POST', path: `/v24.0/${o.phoneId}/messages`, token: `Bearer ${ACCESS_TOKEN}`, body: { messaging_product: 'whatsapp', to: LAN, type: 'text', text: { body: 'Dạ shop gửi bảng giá ạ' } } });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'sent', external_message_id: expect.stringMatching(/^wamid\.sent/) });
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('settled');
      expect(platform.calls).toHaveLength(1);
      // The reply is the member's: 4096 characters at most, and none longer is accepted.
      const fresh = await threadOf(o, LAN);
      await expect(reply(o, fresh, 'a'.repeat(4097))).rejects.toMatchObject({ code: 'REPLY_TOO_LONG', status: 422 });
      await expect(reply(o, fresh, 'a'.repeat(4096))).resolves.toBeDefined();
    });

    it('is refused past the window with its reason, and Meta is not asked; a draft is not made past it either', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      await aged("UPDATE crove_kernel.conversation SET reply_window_until = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [o.orgId, thread.id]);
      await expect(reply(o, thread)).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED', status: 409 });
      expect((await detail(o, thread.id)).reply).toEqual({ allowed: false, reason: 'window_closed' });
      await expect(api.execute('kernel.conversation.draft_request', { conversationId: thread.id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' });
      // A message queued inside the window whose job runs after it closed is refused by the adapter without a call.
      const open = await customerWrites(o, MINH);
      const { messageId } = await reply(o, open.thread);
      await aged("UPDATE crove_kernel.conversation SET last_inbound_at = now() - interval '25 hours' WHERE org_id = $1 AND id = $2", [o.orgId, open.thread.id]);
      const platform = graph();
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('rejected');
      expect(platform.calls).toHaveLength(0);
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'WA_WINDOW_CLOSED' });
      // WhatsApp has no comment to hide, and no history to read back.
      await expect(api.execute('kernel.conversation.hide', { messageId, hidden: true }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
    });

    it('shows a window refusal Meta itself gave (131047) as its own reason, and a refused token expires the connection', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const { messageId } = await reply(o, thread);
      const platform = graph([{ status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } }]);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('rejected');
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'WA_WINDOW_CLOSED' });
      expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [o.connectionId])).toEqual([{ status: 'active' }]);
      const p = await org();
      const second = await customerWrites(p);
      const sent = await reply(p, second.thread);
      const refusing = graph([{ status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } }]);
      expect(await runConversationJob(jobDeps(refusing.adapter), jobOf(p, sent.messageId))).toBe('rejected');
      expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [p.connectionId])).toEqual([{ status: 'expired' }]);
    });

    it('shows a status failed on the message, once, and leaves a message Ludy did not send alone', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const platform = graph();
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('accepted');
      const wamid = (await messageRow(messageId))?.external_message_id as string;
      const failed = (id: string, code = 131047) => noticeOf(o, { statuses: [{ id, status: 'failed', timestamp: secondsAgo(5), recipient_id: LAN, errors: [{ code, title: 'Re-engagement message' }] }] });
      expect((await post(app, failed(wamid))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'WA_131047' });
      const seen = (await detail(o, thread.id)).messages.find((x) => x.id === messageId);
      expect(seen).toMatchObject({ sendState: 'failed', sendErrorCode: 'WA_131047' });
      // The same status again (Meta's retry) changes nothing and stores nothing; a status for a message Ludy never sent creates no message, thread or identity.
      expect((await post(app, failed(wamid, 131026))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 0, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_error_code: 'WA_131047' });
      const before = (await rows('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId])).length;
      const unknown = noticeOf(o, { statuses: [{ id: 'wamid.never-sent-by-ludy', status: 'failed', timestamp: secondsAgo(5), recipient_id: MINH, errors: [{ code: 131026 }] }] });
      expect((await post(app, unknown)).status).toBe(200);
      expect(await intake()).toEqual({ stored: 0, dropped: 0 });
      expect((await rows('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId])).length).toBe(before);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_identity WHERE org_id = $1 AND external_user_id = $2', [o.orgId, MINH])).toHaveLength(0);
      // A person looked on WhatsApp and the message did arrive: marked sent, a late failed status of an earlier attempt would not undo what a person settled.
      await expect(api.execute('kernel.conversation.reply_settle', { messageId, action: 'mark_sent' }, { actor: asUser(o.admin), orgId: o.orgId })).resolves.toMatchObject({ state: 'sent' });
      // ...and a late failed status of the attempt it settled (Meta retries for a while, with a code the replay guard has not seen) does not undo it.
      expect((await post(app, failed(wamid, 131030))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 0, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'sent' });
      expect((await messageRow(messageId))?.send_error_code).not.toBe('WA_131030');
    });

    it('does not let a late failed status of an earlier attempt turn a retried send back to failed, and marks the new attempt by its own wamid', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob(jobDeps(graph().adapter), jobOf(o, messageId))).toBe('accepted');
      const first = (await messageRow(messageId))?.external_message_id as string;
      const failed = (id: string, code: number) => noticeOf(o, { statuses: [{ id, status: 'failed', timestamp: secondsAgo(5), recipient_id: LAN, errors: [{ code }] }] });
      expect((await post(app, failed(first, 131047))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'WA_131047' });
      // A person sends it again (inside the window): the new attempt is queued and goes out under a new wamid.
      expect(await api.execute('kernel.conversation.reply_settle', { messageId, action: 'retry' }, { actor: asUser(o.admin), orgId: o.orgId })).toMatchObject({ state: 'queued' });
      expect(await runConversationJob(jobDeps(graph().adapter), jobOf(o, messageId))).toBe('accepted');
      const second = (await messageRow(messageId))?.external_message_id as string;
      expect(second).not.toBe(first);
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'sent', send_error_code: null });
      // The first attempt's status again, with another code (so the replay guard lets it through): the message stays sent.
      expect((await post(app, failed(first, 131030))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 0, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'sent', send_error_code: null });
      // The new attempt's own failure does mark it.
      expect((await post(app, failed(second, 131026))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'WA_131026' });
    });

    it('never sends twice after a worker died, and an unclear send is not sent again by a button: a person marks it sent', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const platform = graph();
      const { messageId } = await reply(o, thread);
      // The call goes out and the answer is lost (the process is killed, the connection drops).
      const dying: ConversationAdapter = {
        provider: 'whatsapp',
        reply: async (input) => {
          await platform.adapter.reply(input);
          throw new Error('connection reset');
        },
      };
      expect(await runConversationJob(jobDeps(dying), jobOf(o, messageId))).toBe('unknown');
      expect(platform.calls).toHaveLength(1);
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'unknown', send_error_code: 'ADAPTER_ERROR' });
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('settled');
      expect(platform.calls).toHaveLength(1);
      await expect(api.execute('kernel.conversation.reply_settle', { messageId, action: 'retry' }, { actor: asUser(o.admin), orgId: o.orgId })).rejects.toMatchObject({ code: 'SEND_UNKNOWN_NO_RESEND', status: 409 });
      expect(platform.calls).toHaveLength(1);
      expect(await api.execute('kernel.conversation.reply_settle', { messageId, action: 'mark_sent' }, { actor: asUser(o.admin), orgId: o.orgId })).toMatchObject({ state: 'sent' });
      // A worker that died after begin: left unclear within the minute, never sent again.
      const second = await customerWrites(o, MINH);
      const lost = await reply(o, second.thread);
      await worker.execute('kernel.conversation.reply_begin', { messageId: lost.messageId }, { actor: SYSTEM, orgId: o.orgId });
      await aged("UPDATE crove_kernel.external_call SET started_at = now() - interval '11 minutes' WHERE org_id = $1 AND step = 'reply' AND state = 'started'", [o.orgId]);
      expect(await sweepStaleReplies({ workerDb, runtime: worker, now: () => Date.now() + 240_000 })).toBeGreaterThanOrEqual(1);
      expect(await messageRow(lost.messageId)).toMatchObject({ send_state: 'unknown', send_error_code: 'WORKER_LOST' });
      await expect(api.execute('kernel.conversation.reply_settle', { messageId: lost.messageId, action: 'retry' }, { actor: asUser(o.admin), orgId: o.orgId })).rejects.toMatchObject({ code: 'SEND_UNKNOWN_NO_RESEND' });
      // A failed send (the platform said no) may be sent again inside the window.
      const third = await customerWrites(o, '84900000003');
      const refused = await reply(o, third.thread);
      expect(await runConversationJob(jobDeps(graph([{ status: 400, body: { error: { message: 'x', code: 131026 } } }]).adapter), jobOf(o, refused.messageId))).toBe('rejected');
      expect(await api.execute('kernel.conversation.reply_settle', { messageId: refused.messageId, action: 'retry' }, { actor: asUser(o.admin), orgId: o.orgId })).toMatchObject({ state: 'queued' });
    });

    it('fails visibly, not waiting, where the worker has no WhatsApp adapter', async () => {
      const o = await org();
      const { thread } = await customerWrites(o);
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob({ runtime: worker, broker: vault, adapter: () => undefined }, jobOf(o, messageId))).toBe('no_adapter');
      expect(await messageRow(messageId)).toMatchObject({ send_state: 'failed', send_error_code: 'NO_ADAPTER' });
    });
  });

  describe('Dy, the saved replies and the person who presses Send', () => {
    const CUSTOMER_TEXT = 'Áo thun cotton này giá bao nhiêu vậy shop? (bí mật xyzzy)';
    const model = (answer: ReplyDraftResult | Error) => {
      const asked: ReplyDraftRequest[] = [];
      const usage: AiUsage = { inputTokens: 1000, outputTokens: 200 };
      return {
        asked,
        writer: {
          draft: async (req: ReplyDraftRequest): Promise<ReplyDraftResult> => {
            // The model call goes through the AI budget meter's door, as the writer's default generator does.
            await metered('conversation.draft', async () => {
              asked.push(req);
              return { usage };
            });
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      };
    };
    const PRICE = { inputPerMTok: '1000', outputPerMTok: '3000' };
    const draftJob = (o: Org, draftId: string, conversationId: string): ConversationDraftJob => ({ orgId: o.orgId, draftId, conversationId });

    it('drafts a reply for a new conversation by the org’s switch, within the channel and the window, tainted, and sends nothing: a person edits it and presses Send, which sends once', async () => {
      const o = await org();
      await api.execute('kernel.conversation.saved_reply_create', { title: 'Giá áo thun', body: 'Chào {tên}, áo thun cotton giá 150.000đ ạ', keywords: ['giá'] }, { actor: asUser(o.member), orgId: o.orgId });
      // Ten minutes ago: past the relay's quiet period, inside the window.
      const { thread } = await customerWrites(o, LAN, { timestamp: secondsAgo(600), text: { body: CUSTOMER_TEXT } });
      const platform = graph();
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBeGreaterThanOrEqual(1);
      const [draft] = await rows<{ id: string; state: string; source: string }>('SELECT id, state, source FROM crove_kernel.conversation_draft WHERE org_id = $1', [o.orgId]);
      expect(draft).toMatchObject({ state: 'requested', source: 'auto' });
      const source = await worker.query<{ provider: string; maxChars: number; customerName: string | null }>('kernel.conversation.draft_source', { draftId: draft?.id }, { actor: SYSTEM, orgId: o.orgId });
      expect(source).toMatchObject({ provider: 'whatsapp', maxChars: 2000, customerName: 'Lan Nguyễn' });
      const dy = model({ kind: 'draft', body: 'Dạ áo thun cotton giá [giá] ạ, bạn cần size nào ạ?' });
      expect(await runConversationDraft({ runtime: worker, writer: dy.writer, meter: systemMeter(worker, { price: PRICE }) }, draftJob(o, draft?.id as string, thread.id))).toBe('written');
      expect(dy.asked).toHaveLength(1);
      expect(dy.asked[0]).toMatchObject({ maxChars: 2000, customerName: 'Lan Nguyễn', language: 'vi' });
      // The thread shows the draft (tainted) and the saved reply that answers the customer's words; nothing was sent.
      const seen = await detail(o, thread.id);
      expect(seen.draft).toMatchObject({ state: 'live', source: 'auto', tainted: true });
      expect(seen.suggestions.map((s) => s.title)).toEqual(['Giá áo thun']);
      expect(platform.calls).toHaveLength(0);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND direction = $2', [o.orgId, 'out'])).toHaveLength(0);
      // A reply that still holds the placeholder is refused; the person fills it, presses Send, and the draft is marked used by its lengths.
      await expect(reply(o, thread, 'Chào {tên}, áo thun giá 150.000đ ạ')).rejects.toMatchObject({ code: 'REPLY_PLACEHOLDER' });
      const sentText = 'Chào Lan Nguyễn, áo thun cotton giá 150.000đ ạ';
      const { messageId } = await reply(o, thread, sentText, { draftId: draft?.id });
      expect(await rows('SELECT state, body, final_length FROM crove_kernel.conversation_draft WHERE id = $1', [draft?.id])).toEqual([{ state: 'used', body: null, final_length: sentText.length }]);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('accepted');
      expect(platform.calls).toHaveLength(1);
      expect(platform.calls[0]?.body).toMatchObject({ text: { body: sentText } });
    });

    it('works with AI off: no draft is made and nothing waits, and the person replies as before', async () => {
      const o = await org();
      const { thread } = await customerWrites(o, LAN, { timestamp: secondsAgo(600) });
      const asked = await api.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId: thread.id }, { actor: asUser(o.admin), orgId: o.orgId });
      const { failUndraftable } = await import('../src/conversations-worker.ts');
      await failUndraftable(worker, draftJob(o, asked.draftId, thread.id));
      expect((await detail(o, thread.id)).draft).toBeNull();
      const platform = graph();
      const { messageId } = await reply(o, thread);
      expect(await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId))).toBe('accepted');
    });
  });

  describe('an image by media id', () => {
    const pending = (o: Org) =>
      rows<{ id: string; state: string; source_url: string | null; source_ref: string | null; storage_key: string; fetch_attempts: number }>(
        'SELECT id, state, source_url, source_ref, storage_key, fetch_attempts FROM crove_kernel.conversation_attachment WHERE org_id = $1 ORDER BY created_at, id',
        [o.orgId],
      );
    // The platform's media call, answered from memory: what the adapter was given and what it answers.
    function media(answer: Awaited<ReturnType<NonNullable<ConversationAdapter['media']>>> | Error) {
      const given: Array<{ externalAccountId: string; secret: string; mediaRef: string; hosts: readonly string[] }> = [];
      const adapter: ConversationAdapter = {
        provider: 'whatsapp',
        reply: async () => ({ kind: 'unknown' }),
        media: async (input) => {
          given.push({ externalAccountId: input.externalAccountId, secret: input.secret, mediaRef: input.mediaRef, hosts: input.hosts });
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
      return { adapter, given };
    }
    const fetchOne = (o: Org, attachmentId: string, adapter: ConversationAdapter | undefined) =>
      runConversationAttachment({ runtime: worker, store, broker: vault, adapter: () => adapter, egress: { allowed: () => true, anyPort: true, httpsOnly: false } }, { orgId: o.orgId, connectionId: o.connectionId, action: 'attachment', attachmentId });

    it('is parked with its media id, kept as a pending row with the id in source_ref and no address, handed to the worker by ids, and stored with the token opened inside the job', async () => {
      const o = await org();
      expect((await post(app, imageNotice(o, '555111222333'))).status).toBe(200);
      expect(await intake()).toEqual({ stored: 1, dropped: 0 });
      const [row] = await pending(o);
      expect(row).toMatchObject({ state: 'pending', source_url: null, source_ref: '555111222333' });
      expect((await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId]))[0]?.body).toBe('[Khách gửi ảnh]');
      // The relay hands out the pending row by ids only; the event holds no media id.
      expect(await dueConversationAttachments(workerDb)).toEqual(expect.arrayContaining([{ orgId: o.orgId, connectionId: o.connectionId, attachmentId: (row as { id: string }).id }]));
      expect(await requestConversationAttachments(worker, [{ orgId: o.orgId, attachmentId: (row as { id: string }).id }])).toBe(1);
      const event = JSON.stringify(await rows("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.attachment_queued'", [o.orgId]));
      expect(event).not.toContain('555111222333');
      // The job reads the source (the reference, not an address), opens the credential, and asks the adapter; the bytes are stored and the reference is cleared.
      const source = await worker.query<{ provider: string; sourceUrl: string | null; mediaRef: string | null }>('kernel.conversation.attachment_source', { attachmentId: (row as { id: string }).id }, { actor: SYSTEM, orgId: o.orgId });
      expect(source).toMatchObject({ provider: 'whatsapp', sourceUrl: null, mediaRef: '555111222333' });
      const platform = media({ kind: 'ok', bytes: PNG });
      expect(await fetchOne(o, (row as { id: string }).id, platform.adapter)).toBe('stored');
      expect(platform.given).toHaveLength(1);
      expect(platform.given[0]).toMatchObject({ externalAccountId: o.phoneId, mediaRef: '555111222333', hosts: ['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com'] });
      expect(JSON.parse(platform.given[0]?.secret as string)).toMatchObject({ accessToken: ACCESS_TOKEN });
      expect(await pending(o)).toEqual([expect.objectContaining({ id: (row as { id: string }).id, state: 'stored', source_url: null, source_ref: null })]);
      expect(Buffer.from(store.blobs.get((row as { storage_key: string }).storage_key) as Uint8Array).equals(PNG)).toBe(true);
      const thread = await threadOf(o, LAN);
      expect((await detail(o, thread.id)).messages[0]?.attachments).toEqual([expect.objectContaining({ id: (row as { id: string }).id, contentType: 'image/png', width: 2, height: 3 })]);
      // A second job for the stored row does nothing.
      expect(await fetchOne(o, (row as { id: string }).id, platform.adapter)).toBe('none');
      expect(platform.given).toHaveLength(1);
    });

    it('drops an image that is gone or that no adapter can fetch, asks again for a failure that may pass, and clears the reference with the row at five tries or six days', async () => {
      const o = await org();
      for (const [id, mediaId] of [['a', '555000000001'], ['b', '555000000002'], ['c', '555000000003'], ['d', '555000000004'], ['e', '555000000005']] as const) {
        expect((await post(app, imageNotice(o, mediaId, `8490000010${id.charCodeAt(0) % 10}`))).status).toBe(200);
      }
      await intake();
      const [a, b, c, d, e] = await pending(o);
      expect(await fetchOne(o, (a as { id: string }).id, media({ kind: 'failed', retry: false, code: 'WA_MEDIA_GONE' }).adapter)).toBe('dropped');
      expect(await fetchOne(o, (b as { id: string }).id, undefined)).toBe('dropped');
      expect(await fetchOne(o, (c as { id: string }).id, media(new Error('adapter blew up')).adapter)).toBe('retry');
      expect(await fetchOne(o, (d as { id: string }).id, media({ kind: 'ok', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }).adapter)).toBe('dropped');
      expect(await fetchOne(o, (e as { id: string }).id, media({ kind: 'failed', retry: true, code: 'HTTP_503' }).adapter)).toBe('retry');
      const left = await pending(o);
      expect(left.map((r) => [r.source_ref, r.fetch_attempts])).toEqual([['555000000003', 1], ['555000000005', 1]]);
      // Dropped rows leave their messages with the placeholder; a row tried five times, or older than six days, is deleted with its reference.
      await aged("UPDATE crove_kernel.conversation_attachment SET fetch_attempts = 5, requested_at = now() - interval '1 hour' WHERE org_id = $1 AND source_ref = '555000000003'", [o.orgId]);
      await aged("UPDATE crove_kernel.conversation_attachment SET created_at = now() - interval '7 days' WHERE org_id = $1 AND source_ref = '555000000005'", [o.orgId]);
      await dueConversationAttachments(workerDb);
      expect(await pending(o)).toEqual([]);
      expect((await rows('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND body = $2', [o.orgId, '[Khách gửi ảnh]'])).length).toBe(5);
    });

    it('is refused by the database when a row names both an address and a reference, and the reference may hold no URL', async () => {
      const o = await org();
      expect((await post(app, imageNotice(o, '555000000009'))).status).toBe(200);
      await intake();
      const [row] = await pending(o);
      const id = (row as { id: string }).id;
      await expect(rows("UPDATE crove_kernel.conversation_attachment SET source_url = 'https://lookaside.fbsbx.com/x' WHERE org_id = $1 AND id = $2", [o.orgId, id])).rejects.toMatchObject({ code: '23514' });
      for (const bad of ['https://evil.example/x', 'a/b', 'a?token=1', '', 'x'.repeat(301)]) {
        await expect(rows('UPDATE crove_kernel.conversation_attachment SET source_ref = $3 WHERE org_id = $1 AND id = $2', [o.orgId, id, bad]), bad).rejects.toMatchObject({ code: '23514' });
      }
      // A thread's own readers read the row; the reference is not in the export.
      expect(EXPORT_TABLES['kernel.conversation_attachment'].omit).toEqual(expect.arrayContaining(['source_url', 'source_ref']));
    });

    it('is rejected at ingest when an event names both an address and a reference, or a reference that is not a token', async () => {
      const o = await org();
      const event = (attachments: unknown[]) => ({ kind: 'direct', threadId: LAN, messageId: `m-${randomUUID()}`, direction: 'in', contact: { id: LAN }, text: '[Khách gửi ảnh]', at: new Date().toISOString(), attachments });
      await expect(worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events: [event([{ kind: 'image', url: 'https://lookaside.fbsbx.com/x', mediaRef: '1' }])] }, { actor: SYSTEM, orgId: o.orgId })).rejects.toBeDefined();
      await expect(worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events: [event([{ kind: 'image', mediaRef: 'https://evil.example/x' }])] }, { actor: SYSTEM, orgId: o.orgId })).rejects.toBeDefined();
      await expect(worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events: [event([{ kind: 'image' }])] }, { actor: SYSTEM, orgId: o.orgId })).rejects.toBeDefined();
      await expect(worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events: [event([{ kind: 'image', mediaRef: '555111222333' }])] }, { actor: SYSTEM, orgId: o.orgId })).resolves.toMatchObject({ stored: 1 });
    });
  });

  describe('erasure, retention, export and what no record may hold', () => {
    it('erases a customer’s WhatsApp threads with their messages and images, leaves a tombstone with no number, and brings nothing back from a replayed notice', async () => {
      const o = await org();
      const first = message(LAN, { timestamp: secondsAgo(1000) });
      expect((await post(app, customerNotice(o, first))).status).toBe(200);
      expect((await post(app, imageNotice(o, '555111222333', LAN))).status).toBe(200);
      await intake();
      await customerWrites(o, MINH);
      const thread = await threadOf(o, LAN);
      const [pendingRow] = await rows<{ id: string; storage_key: string }>('SELECT id, storage_key FROM crove_kernel.conversation_attachment WHERE org_id = $1', [o.orgId]);
      expect(pendingRow).toBeDefined();
      const erased = await api.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: thread.id, confirm: true }, { actor: asMfa(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
      expect(erased).toEqual({ threads: 1, messages: 2 });
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_attachment WHERE org_id = $1', [o.orgId])).toHaveLength(0);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_blob_doomed WHERE storage_key = $1', [(pendingRow as { storage_key: string }).storage_key])).toHaveLength(1);
      const people = await rows<{ external_user_id: string; display_name: string | null }>('SELECT external_user_id, display_name FROM crove_kernel.conversation_identity WHERE org_id = $1 ORDER BY external_user_id', [o.orgId]);
      expect(people).toEqual([
        { external_user_id: MINH, display_name: 'Lan Nguyễn' },
        { external_user_id: expect.stringMatching(/^erased:k1:[0-9a-f]{64}$/), display_name: null },
      ]);
      // The same notice delivered again after the erasure (the message is dated before it) brings nothing back. It goes through an instance with an empty replay
      // cache, so it is parked and reaches the ingest guard (the first instance would answer it 200 from its cache and park nothing).
      const fresh = createHttpApp({ config: appConfig, runtime: api, store, authenticate: createAuthenticator(appConfig, db), pool: pools[0] as pg.Pool, aiEnabled: false, whatsappWebhook: { appSecret: APP_SECRET, verifyToken: VERIFY }, whatsappReplays: new WhatsAppReplayCache() });
      expect((await post(fresh, customerNotice(o, first))).status).toBe(200);
      expect(await waiting()).toBe(1);
      expect(await intake()).toMatchObject({ dropped: 0 });
      expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, LAN])).toHaveLength(0);
      const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.erase_contact'", [o.orgId]));
      expect(audit).not.toContain(LAN);
    });

    it('purges WhatsApp threads past the org’s retention, and the pending images with them, queueing their blobs', async () => {
      const o = await org();
      expect((await post(app, imageNotice(o, '555111222444'))).status).toBe(200);
      await intake();
      const { thread } = await customerWrites(o, MINH);
      await api.execute('kernel.conversation.retention_set', { retentionMonths: 6 }, { actor: asUser(o.owner), orgId: o.orgId });
      await aged("UPDATE crove_kernel.conversation SET last_message_at = now() - interval '7 months' WHERE org_id = $1 AND external_thread_id = $2", [o.orgId, LAN]);
      const [row] = await rows<{ storage_key: string }>('SELECT storage_key FROM crove_kernel.conversation_attachment WHERE org_id = $1', [o.orgId]);
      await purgeExpiredConversations({ runtime: worker, workerDb });
      expect(await rows('SELECT external_thread_id FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toEqual([{ external_thread_id: MINH }]);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_attachment WHERE org_id = $1', [o.orgId])).toHaveLength(0);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_blob_doomed WHERE storage_key = $1', [(row as { storage_key: string }).storage_key])).toHaveLength(1);
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(thread.id).toBeDefined();
    });

    it('keeps no phone number, wamid, media id, token or words of the customer in any audit row, event, job, activity row or log', async () => {
      const o = await org();
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => {
        const original = console[level];
        console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
        return () => void (console[level] = original);
      });
      try {
        const written = message(LAN, { timestamp: secondsAgo(600), text: { body: BODY } });
        await post(app, customerNotice(o, written));
        await post(app, customerNotice(o, written), {});
        await post(app, '{ not json', sign('{ not json'));
        await post(app, imageNotice(o, '555111222555'));
        await intake();
        const thread = await threadOf(o, LAN);
        const platform = graph();
        const { messageId } = await reply(o, thread, 'Dạ shop trả lời xyzzy-trả-lời');
        await runConversationJob(jobDeps(platform.adapter), jobOf(o, messageId));
        const wamid = (await messageRow(messageId))?.external_message_id as string;
        await post(app, noticeOf(o, { statuses: [{ id: wamid, status: 'failed', timestamp: secondsAgo(2), recipient_id: LAN, errors: [{ code: 131047 }] }] }));
        await intake();
        const [pendingRow] = await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation_attachment WHERE org_id = $1', [o.orgId]);
        const attachment = { kind: 'ok' as const, bytes: PNG };
        await runConversationAttachment({ runtime: worker, store, broker: vault, adapter: () => ({ provider: 'whatsapp', reply: async () => ({ kind: 'unknown' }), media: async () => attachment }) }, { orgId: o.orgId, connectionId: o.connectionId, action: 'attachment', attachmentId: (pendingRow as { id: string }).id });
        await api.execute('kernel.conversation.draft_request', { conversationId: thread.id }, { actor: asUser(o.owner), orgId: o.orgId }).catch(() => undefined);
      } finally {
        for (const restore of spies) restore();
      }
      const secrets = [LAN, '900000001', BODY, 'xyzzy-bí-mật', 'xyzzy-trả-lời', '555111222555', ACCESS_TOKEN, APP_SECRET, 'wamid.'];
      const stores: Array<[string, string]> = [
        ['audit', "SELECT detail::text AS t FROM crove_kernel.audit_event WHERE org_id = $1"],
        ['events', 'SELECT payload::text AS t FROM crove_kernel.outbox_event WHERE org_id = $1'],
        ['activity', 'SELECT summary AS t FROM crove_kernel.activity WHERE org_id = $1'],
      ];
      for (const [name, query] of stores) {
        const text = (await rows<{ t: string }>(query, [o.orgId])).map((r) => r.t).join('\n');
        for (const secret of secrets) expect(text, `${name} holds ${secret}`).not.toContain(secret);
      }
      const jobs = (await rows<{ t: string }>('SELECT to_jsonb(j)::text AS t FROM crove_jobs.job j').catch(() => [] as Array<{ t: string }>)).map((r) => r.t).join('\n');
      for (const secret of secrets) expect(jobs, `jobs hold ${secret}`).not.toContain(secret);
      const logged = lines.join(' | ');
      for (const secret of secrets) expect(logged, `the log holds ${secret}`).not.toContain(secret);
      // The external call row names the provider and a key by message id, never the customer's number.
      const calls = (await rows<{ t: string }>('SELECT to_jsonb(c)::text AS t FROM crove_kernel.external_call c WHERE org_id = $1', [o.orgId])).map((r) => r.t).join('\n');
      expect(calls).not.toContain(LAN);
    });
  });
});
