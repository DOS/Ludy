// SPDX-License-Identifier: AGPL-3.0-only
// Threads replies end-to-end on PostgreSQL 17 (issue #3133, plan docs/plan/conversations-channels.md section 4.4): the reply notice through
// POST /api/channels/facebook/webhook (signed with the Threads app's secret, the same URL as the Page webhook), intake into a comment thread
// under the profile's post (so Social's post tab lists it), a reply sent exactly once through ThreadsPublisher, the hide the rules do not
// offer yet, the reconcile read that stores a missed reply, the permission gate on that read, and no customer text in audit or outbox rows.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThreadsPublisher, type Fetch } from '@crove/channel';
import { metered, type AiUsage, type ReplyDraftRequest, type ReplyDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationListed } from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { runConversationDraft, runConversationIntake, runConversationJob, runConversationSync } from '../src/conversations-worker.ts';
import { systemMeter } from '../src/ai-meter.ts';
import { FACEBOOK_SIGNATURE_HEADER, FACEBOOK_WEBHOOK_PATH } from '../src/facebook-webhook.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const PAGES_SECRET = 'a'.repeat(32);
const THREADS_SECRET = 't'.repeat(32);
const VERIFY_TOKEN = 'v'.repeat(28);
const SECRET_TEXT = 'Số điện thoại 0909123456 của khách Lê Thị Hoa';
const USER = '17841400000000777';
const POST = '18000000000000001';
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_manage_insights'];

const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(new TextEncoder().encode(body)).digest('hex')}`;

suite('Threads replies on PostgreSQL (#3133)', () => {
  const dbName = `crove_test_threads_conv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  const broker = new CredentialVault([{ id: 'k1', key: randomBytes(32) }]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const buildApp = () =>
    createHttpApp({
      config: loadConfig({ DATABASE_URL: adminUrl, AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth' }),
      runtime: rt,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
      },
      pool,
      aiEnabled: false,
      facebookWebhook: { appSecret: PAGES_SECRET, threadsAppSecret: THREADS_SECRET, verifyToken: VERIFY_TOKEN },
    });

  const post = (app: ReturnType<typeof buildApp>, body: string, secret: string) =>
    app.request(FACEBOOK_WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: sign(body, secret) }, body });

  it('takes a reply in, answers it once, refuses what the rules do not offer, reconciles a missed one, and keeps text out of audit and outbox', async () => {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@threads-conv.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Threads ${randomUUID().slice(0, 6)}`);
    const sealed = broker.seal(JSON.stringify({ accessToken: 'threads-token-1' }), { orgId, provider: 'threads', externalAccountId: USER });
    const connect = (scopes: string[]) =>
      rt.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'threads', externalAccountId: USER, displayName: '@tiem.banh', scopes, expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor: asUser(owner), orgId },
      );
    // A profile that did not opt in has no reply reading: the sync makes no platform call.
    const { connectionId } = await connect(SCOPES);
    const platformCalls: { method: string; path: string; form: URLSearchParams }[] = [];
    const replyId = '18100000000000099';
    const missedId = '18100000000000050';
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      platformCalls.push({ method, path: url.pathname, form: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.pathname === `/v1.0/${USER}/threads_publishing_limit`) return json({ data: [{ reply_quota_usage: 1, reply_config: { quota_total: 1000 } }] });
      if (method === 'POST' && url.pathname === `/v1.0/${USER}/threads`) return json({ id: '18000000000000077' });
      if (url.pathname === '/v1.0/18000000000000077') return json({ status: 'FINISHED', id: '18000000000000077' });
      if (method === 'POST' && url.pathname === `/v1.0/${USER}/threads_publish`) return json({ id: replyId });
      if (url.pathname === `/v1.0/${USER}/threads`) return json({ data: [{ id: POST, timestamp: new Date().toISOString() }] });
      if (url.pathname === `/v1.0/${POST}/conversation`) {
        return json({ data: [{ id: missedId, text: 'Bình luận bù từ đối soát', username: 'tran.van.nam', timestamp: new Date().toISOString(), replied_to: { id: POST } }] });
      }
      return new Response('{}', { status: 404 });
    };
    const publisher = new ThreadsPublisher(fetchImpl, { waitMs: 0, pollMs: 0, commentWaitMs: 0 });
    const sendDeps = { runtime: worker, broker, adapter: (p: string) => (p === 'threads' ? publisher.conversations : undefined) };
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('none');
    expect(platformCalls).toEqual([]);

    const nowSec = Math.floor(Date.now() / 1000);
    const notice = JSON.stringify({
      object: 'threads',
      entry: [{ id: USER, time: nowSec, changes: [{ field: 'replies', value: { id: '18100000000000010', text: SECRET_TEXT, username: 'le.thi.hoa', timestamp: nowSec - 20, root_post: { id: POST }, replied_to: { id: POST } } }] }],
    });
    const asOwner = { actor: asUser(owner), orgId };
    // Without the opt-in a reply the platform pushes is acknowledged and stored nowhere.
    const early = buildApp();
    expect((await post(early, notice, THREADS_SECRET)).status).toBe(200);
    await runConversationIntake({ workerDb, runtime: worker });
    expect((await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner)).conversations).toHaveLength(0);
    // The opt-in: a reconnect that holds threads_read_replies.
    await connect([...SCOPES, 'threads_read_replies']);

    // The webhook: signed with the Threads secret it is parked and read; signed with the Pages secret a Threads object is not read.
    const app = buildApp();
    expect((await post(app, notice, PAGES_SECRET)).status).toBe(200);
    await runConversationIntake({ workerDb, runtime: worker });
    expect((await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner)).conversations).toHaveLength(0);
    expect((await post(app, notice, 'wrong-secret-0123456789abcdef')).status).toBe(401);
    expect((await post(app, notice, THREADS_SECRET)).status).toBe(200);
    // A replay is parked only once (the cache) and stored only once (the core), so one thread with one message and one unread mark.
    expect((await post(app, notice, THREADS_SECRET)).status).toBe(200);
    await runConversationIntake({ workerDb, runtime: worker });
    await runConversationIntake({ workerDb, runtime: worker });

    const listed = await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner);
    expect(listed.conversations).toHaveLength(1);
    expect(listed.conversations[0]).toMatchObject({ kind: 'comment_thread', unread: true, channel: { provider: 'threads' }, contact: { displayName: '@le.thi.hoa' } });
    // The post tab of Social lists the same one thread, by the media id.
    const underPost = await rt.query<ConversationListed>('kernel.conversation.list', { posts: [{ connectionId, externalPostId: POST }] }, asOwner);
    expect(underPost.conversations.map((c) => c.id)).toEqual([listed.conversations[0]?.id]);
    const convId = listed.conversations[0]!.id;
    let detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ direction: 'in', body: SECRET_TEXT });

    // Dy's draft for the new reply thread: asked, written by the system job through the AI budget meter within Threads' 500 characters from the
    // customer's words, tainted, and live for the person to read; it sends nothing (the reply below is the person's own press of Send).
    const asked = await rt.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId: convId }, asOwner);
    expect(asked.queued).toBe(true);
    const seen: ReplyDraftRequest[] = [];
    const usage: AiUsage = { inputTokens: 1000, outputTokens: 200 };
    const writer = {
      draft: async (req: ReplyDraftRequest, onUsage?: (u: AiUsage) => void): Promise<ReplyDraftResult> => {
        await metered('conversation.draft', async () => {
          seen.push(req);
          return { usage };
        });
        onUsage?.(usage);
        return { kind: 'draft', body: 'Dạ tiệm còn size M ạ, bạn ghé tiệm nhé!' };
      },
    };
    const draftJob = { orgId, draftId: asked.draftId, conversationId: convId };
    expect(await runConversationDraft({ runtime: worker, writer, meter: systemMeter(worker, { price: { inputPerMTok: '1000', outputPerMTok: '3000' } }) }, draftJob)).toBe('written');
    expect(seen[0]).toMatchObject({ maxChars: 500, messages: [{ from: 'customer', text: SECRET_TEXT }] });
    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.draft).toMatchObject({ state: 'live', source: 'asked', tainted: true });
    expect(detail.messages).toHaveLength(1);

    // A reply: over Threads' 500 characters is refused, and hiding is not offered until the live check confirms it.
    await expect(rt.execute('kernel.conversation.reply', { conversationId: convId, body: 'x'.repeat(501), lastSeenSeq: 1 }, asOwner)).rejects.toMatchObject({ code: 'REPLY_TOO_LONG' });
    await expect(rt.execute('kernel.conversation.hide', { messageId: detail.messages[0]!.id, hidden: true }, asOwner)).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
    const { messageId } = await rt.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: convId, body: 'Dạ tiệm còn size M ạ!', lastSeenSeq: 1 }, asOwner);
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId, action: 'reply' })).toBe('accepted');
    // Sent exactly once: the job run again makes no second publish.
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId, action: 'reply' })).toBe('settled');
    expect(platformCalls.filter((c) => c.method === 'POST' && c.path === `/v1.0/${USER}/threads_publish`)).toHaveLength(1);
    expect(platformCalls.find((c) => c.method === 'POST' && c.path === `/v1.0/${USER}/threads`)?.form.get('reply_to_id')).toBe('18100000000000010');
    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.messages.at(-1)).toMatchObject({ direction: 'out', sendState: 'sent' });
    const storedId = await admin(async (c) => (await c.query<{ external_message_id: string | null }>('SELECT external_message_id FROM crove_kernel.conversation_message WHERE id = $1', [messageId])).rows[0]?.external_message_id);
    expect(storedId).toBe(replyId);

    // The customer answers the business's answer: Threads names the answer as the parent, and the reply stays in the same thread (one conversation
    // per top-level reply, however deep the replies go), also when the answer was sent from Ludy and its id is the one the platform gave.
    const deep = (id: string, parent: string, text: string) =>
      JSON.stringify({ object: 'threads', entry: [{ id: USER, time: nowSec, changes: [{ field: 'replies', value: { id, text, username: 'le.thi.hoa', timestamp: nowSec - 5, root_post: { id: POST }, replied_to: { id: parent } } }] }] });
    for (const [id, parent] of [['18100000000000101', replyId], ['18100000000000102', '18100000000000101']] as const) {
      expect((await post(app, deep(id, parent, `Cảm ơn shop ${id}`), THREADS_SECRET)).status).toBe(200);
    }
    await runConversationIntake({ workerDb, runtime: worker });
    expect((await rt.query<ConversationListed>('kernel.conversation.list', { posts: [{ connectionId, externalPostId: POST }] }, asOwner)).conversations).toHaveLength(1);
    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.messages.map((m) => m.direction)).toEqual(['in', 'out', 'in', 'in']);

    // The reconcile read stores the reply the webhook missed.
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('complete');
    const after = await rt.query<ConversationListed>('kernel.conversation.list', { posts: [{ connectionId, externalPostId: POST }] }, asOwner);
    expect(after.conversations).toHaveLength(2);

    // Erasing the customer works on Threads rows as on any channel's: the thread, its messages and the username (kept only as a tombstone) go.
    const mfa = { type: 'user' as const, userId: owner, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const erased = await rt.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: convId, confirm: true }, { actor: mfa, orgId, idempotencyKey: randomUUID() });
    expect(erased.threads).toBe(1);
    const left = await admin((c) => c.query('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND body ILIKE $2', [orgId, '%0909123456%']));
    expect(left.rows).toHaveLength(0);
    const names = await admin((c) => c.query<{ external_user_id: string }>('SELECT external_user_id FROM crove_kernel.conversation_identity WHERE org_id = $1 AND provider = $2', [orgId, 'threads']));
    expect(names.rows.map((r) => r.external_user_id)).not.toContain('le.thi.hoa');
    expect((await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner)).conversations).toHaveLength(1);

    // No customer text, name or phone number reaches audit_event or outbox_event.
    for (const table of ['audit_event', 'outbox_event']) {
      const leaked = await admin((c) => c.query(`SELECT 1 FROM crove_kernel.${table} t WHERE org_id = $1 AND (row_to_json(t)::text ILIKE $2 OR row_to_json(t)::text ILIKE $3 OR row_to_json(t)::text ILIKE $4)`, [orgId, '%0909123456%', '%le.thi.hoa%', '%đối soát%']));
      expect(leaked.rows).toHaveLength(0);
    }
  });
});
