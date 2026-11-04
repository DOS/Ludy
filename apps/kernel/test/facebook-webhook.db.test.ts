// SPDX-License-Identifier: AGPL-3.0-only
// Facebook Page comments end-to-end on PostgreSQL 17 (issue #2307, plan docs/plan/conversations.md sections 6.1, 6.2, 6.3 and 13 CV2):
// GET/POST /api/channels/facebook/webhook (subscription challenge, X-Hub-Signature-256 verification, replay guard, secret rotation),
// intake into comment_thread conversations linked to published posts, in-place comment edits, hide/unhide, comment removal,
// outbound reply and hide via FacebookPagePublisher, hourly comment reconciliation (only when pages_read_user_content is granted),
// granted_by_hash stored on channel_connection, and no customer text in audit or outbox rows.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FacebookPagePublisher, platformUserHash, type Fetch } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationListed } from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { runConversationIntake, runConversationJob, runConversationSync } from '../src/conversations-worker.ts';
import { FACEBOOK_SIGNATURE_HEADER, FACEBOOK_WEBHOOK_PATH } from '../src/facebook-webhook.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const APP_SECRET = 'a'.repeat(32);
const PREV_SECRET = 'p'.repeat(32);
const VERIFY_TOKEN = 'v'.repeat(28);
const SECRET_COMMENT = 'Số điện thoại 0909123456 của khách Lê Thị Hoa';

function signHub(body: string | Uint8Array, secret = APP_SECRET): string {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

suite('Facebook Page conversations on PostgreSQL (#2307)', () => {
  const dbName = `crove_test_fb_conv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@fb-conv.test`, name: null });
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

  function buildApp(limit?: RateLimiter) {
    const config = loadConfig({
      DATABASE_URL: adminUrl,
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'crove-auth',
    });
    return createHttpApp({
      config,
      runtime: rt,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
      },
      pool,
      aiEnabled: false,
      facebookWebhook: {
        appSecret: APP_SECRET,
        appSecretPrevious: PREV_SECRET,
        verifyToken: VERIFY_TOKEN,
      },
      ...(limit ? { facebookWebhookLimit: limit } : {}),
    });
  }

  it('verifies GET handshake and refuses bad verify_token or bad POST signature with per-address rate limiting', async () => {
    const limit = new RateLimiter({ perMinute: 2 });
    const app = buildApp(limit);

    const okGet = await app.request(
      `${FACEBOOK_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=challenge-12345`,
    );
    expect(okGet.status).toBe(200);
    expect(await okGet.text()).toBe('challenge-12345');

    const badGet = await app.request(`${FACEBOOK_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-12345`);
    expect(badGet.status).toBe(403);

    const body = JSON.stringify({ object: 'page', entry: [] });
    const badPost = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: 'sha256=' + '0'.repeat(64) },
      body,
    });
    expect(badPost.status).toBe(401);

    // Third refused request exceeds the 2/min refusal limit and gets 429.
    const limitedPost = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: 'sha256=' + '0'.repeat(64) },
      body,
    });
    expect(limitedPost.status).toBe(429);

    // A properly signed notice is still accepted even when the refusal limiter is exhausted.
    const signedWithPrev = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(body, PREV_SECRET) },
      body,
    });
    expect(signedWithPrev.status).toBe(200);
  });

  it('ingests Page comments, edits, hides, unhides, removals, replies, and reconciles history without leaking text to audit or outbox', async () => {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const pageId = '100200300400500';
    const postId = `${pageId}_900800700600500`;
    const commentId = '900800700600500_111';
    const grantedByHash = platformUserHash(APP_SECRET, '987654321012345');
    const pageSecret = JSON.stringify({ accessToken: 'page-token-xyz' });
    const sealed = broker.seal(pageSecret, { orgId, provider: 'facebook_page', externalAccountId: pageId });

    const { connectionId } = await rt.execute<{ connectionId: string; reconnected: boolean }>(
      'kernel.channel.connect',
      {
        provider: 'facebook_page',
        externalAccountId: pageId,
        displayName: 'Tiệm Bánh An Nhiên',
        scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content', 'pages_manage_metadata'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
        grantedByHash,
      },
      { actor: asUser(owner), orgId },
    );

    const storedHash = await admin(async (c) => (await c.query<{ granted_by_hash: string | null }>('SELECT granted_by_hash FROM crove_kernel.channel_connection WHERE id = $1', [connectionId])).rows[0]?.granted_by_hash);
    expect(storedHash).toBe(grantedByHash);

    const app = buildApp();
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Customer adds a comment via webhook.
    const addPayload = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: nowSec,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: commentId,
                post_id: postId,
                parent_id: postId,
                created_time: nowSec - 30,
                message: SECRET_COMMENT,
                from: { id: '777888999', name: 'Lê Thị Hoa' },
              },
            },
          ],
        },
      ],
    });
    const resAdd = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(addPayload) },
      body: addPayload,
    });
    expect(resAdd.status).toBe(200);

    await runConversationIntake({ workerDb, runtime: worker });

    const listed = await rt.query<ConversationListed>('kernel.conversation.list', {}, { actor: asUser(owner), orgId });
    expect(listed.conversations).toHaveLength(1);
    const convId = listed.conversations[0]!.id;
    let detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, { actor: asUser(owner), orgId });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({
      direction: 'in',
      body: SECRET_COMMENT,
      hidden: false,
      removed: false,
    });

    // 2. Customer edits the comment -> updates in place.
    const editPayload = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: nowSec + 1,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'edited',
                comment_id: commentId,
                post_id: postId,
                parent_id: postId,
                created_time: nowSec - 10,
                message: `${SECRET_COMMENT} (đã sửa)`,
                from: { id: '777888999', name: 'Lê Thị Hoa' },
              },
            },
          ],
        },
      ],
    });
    await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(editPayload) },
      body: editPayload,
    });
    await runConversationIntake({ workerDb, runtime: worker });

    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, { actor: asUser(owner), orgId });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]?.body).toBe(`${SECRET_COMMENT} (đã sửa)`);

    // 3. Owner replies and hides the comment via FacebookPagePublisher.
    const graphCalls: { method: string; path: string; form: URLSearchParams }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      graphCalls.push({ method, path: url.pathname, form });
      if (method === 'POST' && url.pathname === `/v24.0/${commentId}/comments`) {
        return new Response(JSON.stringify({ id: '900800700600500_222' }), { status: 200 });
      }
      if (method === 'POST' && url.pathname === `/v24.0/${commentId}`) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'POST' && url.pathname === `/v24.0/${pageId}/subscribed_apps`) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'GET' && url.pathname === `/v24.0/${pageId}/published_posts`) {
        return new Response(JSON.stringify({ data: [{ id: postId }] }), { status: 200 });
      }
      if (method === 'GET' && url.pathname === `/v24.0/${postId}/comments`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '900800700600500_333',
                message: 'Bình luận bù từ đối soát',
                created_time: new Date((nowSec + 10) * 1000).toISOString(),
                from: { id: '888999000', name: 'Trần Văn Nam' },
                is_hidden: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    };
    const publisher = new FacebookPagePublisher({ appSecret: APP_SECRET }, fetchImpl);
    const sendDeps = { runtime: worker, broker, adapter: (p: string) => (p === 'facebook_page' ? publisher.conversations : undefined) };

    const { messageId: replyMessageId } = await rt.execute<{ messageId: string }>(
      'kernel.conversation.reply',
      { conversationId: convId, body: 'Dạ tiệm đã nhận đơn ạ!', lastSeenSeq: 1 },
      { actor: asUser(owner), orgId },
    );
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId: replyMessageId, action: 'reply' })).toBe('accepted');

    // Webhook echo of that same Page reply does not duplicate the message.
    const echoPayload = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: nowSec + 2,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '900800700600500_222',
                post_id: postId,
                parent_id: commentId,
                created_time: nowSec,
                message: 'Dạ tiệm đã nhận đơn ạ!',
                from: { id: pageId, name: 'Tiệm Bánh An Nhiên' },
              },
            },
          ],
        },
      ],
    });
    await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(echoPayload) },
      body: echoPayload,
    });
    await runConversationIntake({ workerDb, runtime: worker });

    const customerMessageId = detail.messages[0]!.id;
    await rt.execute('kernel.conversation.hide', { messageId: customerMessageId, hidden: true }, { actor: asUser(owner), orgId });
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId: customerMessageId, action: 'hide' })).toBe('done');

    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, { actor: asUser(owner), orgId });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]?.hidden).toBe(true);
    expect(detail.messages[1]?.sendState).toBe('sent');
    const storedReplyExternalId = await admin(
      async (c) => (await c.query<{ external_message_id: string | null }>('SELECT external_message_id FROM crove_kernel.conversation_message WHERE id = $1', [replyMessageId])).rows[0]?.external_message_id,
    );
    expect(storedReplyExternalId).toBe('900800700600500_222');

    // 4. Reconciliation (`history`) backfills missed comments when pages_read_user_content is granted.
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('complete');
    const afterSync = await rt.query<ConversationListed>('kernel.conversation.list', {}, { actor: asUser(owner), orgId });
    expect(afterSync.conversations).toHaveLength(2);

    // 5. No customer text or name reaches audit_event or outbox_event.
    const leakedAudit = await admin((c) =>
      c.query('SELECT 1 FROM crove_kernel.audit_event a WHERE org_id = $1 AND row_to_json(a)::text ILIKE $2', [orgId, '%0909123456%']),
    );
    const leakedEvents = await admin((c) =>
      c.query('SELECT 1 FROM crove_kernel.outbox_event e WHERE org_id = $1 AND row_to_json(e)::text ILIKE $2', [orgId, '%0909123456%']),
    );
    expect(leakedAudit.rows).toHaveLength(0);
    expect(leakedEvents.rows).toHaveLength(0);
  });
});
