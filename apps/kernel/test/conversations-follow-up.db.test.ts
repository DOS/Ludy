// SPDX-License-Identifier: AGPL-3.0-only
// "Create task" from a conversation (CV3, #3295, plan docs/plan/conversations.md section 4 point 2) on PostgreSQL 17, through the API: a member makes an
// ordinary kernel task that links back to the thread and the thread lists its open tasks; the conversation keeps its own status; a viewer, a member who cannot
// read a private thread and another org find the way closed; a repeated click with the same key makes one task; neither the task nor the audit rows hold a
// word of the customer's. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import type { ConversationEvent } from '@ludy/kernel-contract';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-conversation-follow-up-0123';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@followup.test`, session: randomUUID(), userId: '' });

suite('Create task from a conversation (CV3, #3295)', () => {
  const dbName = `crove_test_conversations_follow_up_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const owner = account('owner');
  const desk = account('desk');
  const lan = account('lan');
  const viewer = account('viewer');
  let org = { slug: '', orgId: '', connectionId: '' };
  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => withClient(adminUrl, async (c) => (await c.query<T>(text, params)).rows);
  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  let tick = 0;
  const event = (kind: ConversationEvent['kind'], threadId: string, text: string): ConversationEvent => ({
    kind,
    threadId,
    ...(kind === 'comment_thread' ? { postId: 'post-1' } : {}),
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: `u-${threadId}`, name: `Khách ${threadId}` },
    text,
    at: new Date(Date.now() - 600_000 + tick * 1000).toISOString(),
  });
  const ingest = (events: ConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId: org.connectionId, events }, { actor: SYSTEM, orgId: org.orgId });
  const threadOf = async (external: string) => ((await rows<{ id: string }>('SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [org.orgId, external]))[0] as { id: string }).id;
  const statusOf = async (id: string) => (await rows<{ status: string }>('SELECT status FROM ludy_kernel.conversation WHERE org_id = $1 AND id = $2', [org.orgId, id]))[0]?.status;
  const followUp = (who: Account, conversationId: string, extra: Record<string, unknown> = {}) =>
    rpc('conversations/followUp', who, { conversationId, title: 'Gọi lại báo giá', assigneePositionId: null, idempotencyKey: randomUUID(), ...extra });
  const tasksOf = (who: Account, conversationId: string) => rpc('conversations/tasks', who, { conversationId });

  beforeAll(async () => {
    await withClient(ADMIN as string, async (c) => void (await c.query(`CREATE DATABASE ${dbName}`)));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    appUrl = urlFor('ludy_app', 'test-app-pw');
    workerUrl = urlFor('ludy_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, desk, lan, viewer]) {
      const me = await rpc('me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Cửa hàng Hoa Nắng', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId), connectionId: randomUUID() };
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [org.orgId, desk.userId, lan.userId, viewer.userId]);
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [org.orgId, desk.userId, owner.userId]);
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [org.orgId, org.connectionId, `acct-${randomUUID().slice(0, 8)}`, owner.userId]);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    await withClient(ADMIN, async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)));
  });

  it('makes an ordinary task that links back to the thread, lists it there, and leaves the conversation as it was', async () => {
    await ingest([event('comment_thread', 'a1', 'Cho mình xin báo giá 20 hộp')]);
    const a1 = await threadOf('a1');
    expect((await tasksOf(owner, a1)).body).toEqual({ tasks: [] });
    const before = await statusOf(a1);
    const due = '2030-01-15T16:59:00.000Z';
    const made = await followUp(lan, a1, { title: 'Gửi báo giá cho khách', due });
    expect(made.status).toBe(200);
    const taskId = String(made.body?.taskId);
    // An ordinary task of the org: a person's, untainted, with no description, and a source only kernel code sets.
    const [task] = await rows<{ title: string; description: string | null; source: string; source_ref: { type: string; id: string }; tainted: boolean; assignee_position_id: string | null; due: Date; created_by_id: string | null }>(
      'SELECT title, description, source, source_ref, tainted, assignee_position_id, due, created_by_id FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
      [org.orgId, taskId],
    );
    expect(task).toMatchObject({ title: 'Gửi báo giá cho khách', description: null, source: 'human', tainted: false, assignee_position_id: null, source_ref: { type: 'kernel.conversation', id: a1 } });
    expect(task?.due.toISOString()).toBe(due);
    // The thread lists it, to every member who may read the thread, a viewer included.
    for (const who of [owner, lan, viewer]) {
      const listed = await tasksOf(who, a1);
      expect(listed.status).toBe(200);
      expect(listed.body.tasks).toEqual([expect.objectContaining({ id: taskId, title: 'Gửi báo giá cho khách', status: 'todo', assigneePositionId: null })]);
    }
    // The conversation keeps its own status, and the task is in the org's task list.
    expect(await statusOf(a1)).toBe(before);
    expect((await rpc('tasks/list', owner, {})).body.map((t: { id: string }) => t.id)).toContain(taskId);
  });

  it('lists only the open tasks of that thread, the newest first', async () => {
    await ingest([event('comment_thread', 'b1', 'Hỏi hàng'), event('comment_thread', 'b2', 'Hỏi giao hàng')]);
    const [b1, b2] = [await threadOf('b1'), await threadOf('b2')];
    const first = String((await followUp(owner, b1, { title: 'Việc 1' })).body.taskId);
    const second = String((await followUp(owner, b1, { title: 'Việc 2' })).body.taskId);
    const other = String((await followUp(owner, b2, { title: 'Việc của hội thoại khác' })).body.taskId);
    expect((await tasksOf(owner, b1)).body.tasks.map((t: { id: string }) => t.id)).toEqual([second, first]);
    expect((await tasksOf(owner, b2)).body.tasks.map((t: { id: string }) => t.id)).toEqual([other]);
    // A done or a cancelled task leaves the open list; the others stay.
    await rpc('tasks/setStatus', owner, { id: second, status: 'done', idempotencyKey: randomUUID() });
    expect((await tasksOf(owner, b1)).body.tasks.map((t: { id: string }) => t.id)).toEqual([first]);
    await rpc('tasks/setStatus', owner, { id: first, status: 'cancelled', idempotencyKey: randomUUID() });
    expect((await tasksOf(owner, b1)).body.tasks).toEqual([]);
  });

  it('makes one task for one click: the same key twice is one task', async () => {
    await ingest([event('comment_thread', 'c1', 'Hỏi lại')]);
    const c1 = await threadOf('c1');
    const key = randomUUID();
    const one = await followUp(owner, c1, { idempotencyKey: key });
    const two = await followUp(owner, c1, { idempotencyKey: key });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.taskId).toBe(one.body.taskId);
    expect((await tasksOf(owner, c1)).body.tasks).toHaveLength(1);
  });

  it('is a decision of a member who may write the thread: a viewer, a member who cannot read a private thread and another org find the way closed', async () => {
    await ingest([event('direct', 'd1', 'Nhắn riêng'), event('comment_thread', 'd2', 'Bình luận')]);
    const [d1, d2] = [await threadOf('d1'), await threadOf('d2')];
    expect((await followUp(viewer, d2)).status).toBe(403);
    // A member with no desk role reads no private message: neither the task nor the list of the thread is theirs.
    expect((await followUp(lan, d1)).status).toBe(404);
    expect((await tasksOf(lan, d1)).status).toBe(404);
    expect((await followUp(desk, d1)).status).toBe(200);
    expect((await tasksOf(desk, d1)).body.tasks).toHaveLength(1);
    expect((await tasksOf(lan, d2)).body.tasks).toEqual([]);
    // Bad input: no title, a title past the limit, a NUL, an unknown field.
    expect((await followUp(owner, d2, { title: '   ' })).status).toBe(400);
    expect((await followUp(owner, d2, { title: 'x'.repeat(301) })).status).toBe(400);
    expect((await followUp(owner, d2, { title: 'a\u0000b' })).status).toBe(400);
    expect((await followUp(owner, d2, { description: 'khách nói rằng' })).status).toBe(400);
    expect((await followUp(owner, randomUUID())).status).toBe(404);
    // Another org's thread is not found either, and the task of one org is not listed in another.
    const other = await rpc('org/create', desk, { name: 'Tiệm khác', idempotencyKey: randomUUID() }, { slug: null });
    expect((await followUp(desk, d2)).status).toBe(200);
    const slug = String(other.body?.slug);
    expect((await rpc('conversations/followUp', desk, { conversationId: d2, title: 'Lạ', assigneePositionId: null, idempotencyKey: randomUUID() }, { slug })).status).toBe(404);
    expect((await rpc('conversations/tasks', desk, { conversationId: d2 }, { slug })).status).toBe(404);
  });

  it('puts none of the customer\'s words in the task or the audit: ids only, and no description', async () => {
    await ingest([event('comment_thread', 'e1', 'Số của tôi là 0901234567, giao tới 12 Lê Lợi')]);
    const e1 = await threadOf('e1');
    const taskId = String((await followUp(owner, e1, { title: 'Gọi khách về đơn' })).body.taskId);
    const audit = JSON.stringify(
      await rows("SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('kernel.conversation.follow_up', 'kernel.task.create_from_conversation')", [org.orgId]),
    );
    expect(audit).toContain(taskId);
    expect(audit).toContain(e1);
    expect(audit).not.toContain('Gọi khách về đơn');
    expect(audit).not.toContain('0901234567');
    const [task] = await rows<{ title: string; description: string | null }>('SELECT title, description FROM ludy_kernel.task WHERE org_id = $1 AND id = $2', [org.orgId, taskId]);
    expect(task?.description).toBeNull();
    expect(JSON.stringify(task)).not.toContain('0901234567');
  });
});
