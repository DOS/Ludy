// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core's database rules on PostgreSQL 17 (#2303), the ones the commands lean on and must not be the only
// holder of:
// - a private message (kind direct) is read by owners, admins and holders of kernel.conversation.direct.read (the desk.agent
//   role) and by no member, viewer or agent, in the table and in what hangs off it (messages, notes, read marks, identities);
// - a member limited to some channels (crove_kernel.channel_access, moved from Social by this issue) reads only those channels'
//   threads, through Social's own commands, and the rows an older database held in crove_social.channel_access are copied
//   when it migrates, with the Social table dropped;
// - a notice waiting in the intake table longer than seven days is dropped with its body, and returned by id.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own databases.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationEvent, ConversationListed } from '@crove/kernel-contract';
import { Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const DESK_AGENT_PERMISSION = 'kernel.conversation.direct.read';

suite('the conversation core: who reads what, the channel limit, the intake age (#2303)', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_conversations_policy_${stamp}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const urlFor = (base: string, user: string, password: string) => {
    const u = new URL(base);
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
  // SQL in a member's context as the API's login, rolled back.
  async function asMember<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    return withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });
  }
  // SQL as the worker login inside an agent's context, rolled back.
  async function asAgent<T>(orgId: string, actor: AgentActor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    return withClient(workerUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, actor.agentId, actor.runId]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });
  }
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@policy.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; lan: string; viewer: string; desk: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), lan: await person('lan'), viewer: await person('viewer'), desk: await person('desk') };
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')", [orgId, o.admin, o.lan, o.viewer, o.desk]);
    return o;
  }
  async function connection(o: Org): Promise<string> {
    const id = randomUUID();
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [o.orgId, id, `acct-${randomUUID().slice(0, 8)}`, o.owner]);
    return id;
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
    at: new Date(Date.UTC(2026, 10, 2, 3, 0, tick)).toISOString(),
  });
  const ingest = (o: Org, connectionId: string, events: ConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const list = (o: Org, user: string, input: Record<string, unknown> = {}) => rt.query<ConversationListed>('kernel.conversation.list', input, { actor: asUser(user), orgId: o.orgId });
  const previews = async (o: Org, user: string) => (await list(o, user)).conversations.map((c) => c.preview).sort();

  const registered = () => ({ commands: [...kernelCommands, ...financeCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...socialQueries] });
  async function prepare(url: string, name: string): Promise<{ app: string; work: string }> {
    await setRolePasswords(url, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    void name;
    return { app: urlFor(url, 'crove_app', 'test-app-pw'), work: urlFor(url, 'crove_worker', 'test-worker-pw') };
  }

  beforeAll(async () => {
    await withClient(ADMIN as string, async (c) => void (await c.query(`CREATE DATABASE ${dbName}`)));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    const urls = await prepare(adminUrl, dbName);
    appUrl = urls.app;
    workerUrl = urls.work;
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerUrl, max: 2 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered());
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered());
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    await withClient(ADMIN, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS ${dbName}_move WITH (FORCE)`);
    });
  });

  it('shows a private message only to owners, admins and the desk.agent role, in the table and what hangs off it', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [event('direct', 'd1', 'Nhắn riêng'), event('comment_thread', 'c1', 'Bình luận')]);
    const direct = (await rows<{ id: string }>("SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND kind = 'direct'", [o.orgId]))[0]?.id as string;
    // A note and a read mark on the private thread, written by the owner.
    await rt.execute('kernel.conversation.note', { conversationId: direct, body: 'Ghi chú riêng' }, { actor: asUser(o.owner), orgId: o.orgId });
    await rt.execute('kernel.conversation.mark_read', { conversationId: direct, seq: 1 }, { actor: asUser(o.owner), orgId: o.orgId });
    const counts = (user: string) =>
      asMember(o.orgId, user, async (c) => {
        const n = async (table: string, where = 'true') => (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.${table} WHERE ${where}`)).rows[0].n as number;
        return {
          direct: await n('conversation', "kind = 'direct'"),
          comment: await n('conversation', "kind = 'comment_thread'"),
          messages: await n('conversation_message', "kind = 'direct'"),
          notes: await n('conversation_note', `conversation_id = '${direct}'`),
          identities: await n('conversation_identity', "external_user_id = 'u-d1'"),
        };
      });
    const all = { direct: 1, comment: 1, messages: 1, notes: 1, identities: 1 };
    const nothingPrivate = { direct: 0, comment: 1, messages: 0, notes: 0, identities: 0 };
    // No role holds the permission yet (CV3 seeds it for desk.agent): nobody but owners and admins reads a private message.
    expect(await rows('SELECT 1 FROM crove_kernel.role_permission WHERE permission = $1', [DESK_AGENT_PERMISSION])).toHaveLength(0);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [o.orgId, o.desk, o.owner]);
    expect(await counts(o.desk)).toEqual(nothingPrivate);
    // The desk.agent role as the Service inbox will seed it (a fixture here, as the database owner): its holder reads them.
    await rows("INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES ('desk.agent', $1)", [DESK_AGENT_PERMISSION]);

    expect(await counts(o.owner)).toEqual(all);
    expect(await counts(o.admin)).toEqual(all);
    expect(await counts(o.desk)).toEqual(all);
    expect(await counts(o.lan)).toEqual(nothingPrivate);
    expect(await counts(o.viewer)).toEqual(nothingPrivate);
    // The commands say the same: a viewer or member lacking the role finds no such thread; the desk member answers it.
    await expect(rt.query('kernel.conversation.get', { conversationId: direct }, { actor: asUser(o.lan), orgId: o.orgId })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(rt.query('kernel.conversation.get', { conversationId: direct }, { actor: asUser(o.viewer), orgId: o.orgId })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect((await rt.query<{ conversation: { id: string } }>('kernel.conversation.get', { conversationId: direct }, { actor: asUser(o.desk), orgId: o.orgId })).conversation.id).toBe(direct);
    await rt.execute('kernel.conversation.resolve', { conversationId: direct }, { actor: asUser(o.desk), orgId: o.orgId });
    // A member cannot write a private thread either, whatever a command checks: the table refuses the update.
    await expect(asMember(o.orgId, o.lan, (c) => c.query("UPDATE crove_kernel.conversation SET status = 'new' WHERE kind = 'direct'"))).resolves.toMatchObject({ rowCount: 0 });
    await expect(asMember(o.orgId, o.lan, (c) => c.query('INSERT INTO crove_kernel.conversation_note (org_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4)', [o.orgId, direct, o.lan, 'x']))).rejects.toMatchObject({ code: '42501' });
    // The desk role is no way into another org's private messages.
    const other = await org();
    expect((await list(other, other.owner)).conversations).toEqual([]);
    await expect(rt.query('kernel.conversation.get', { conversationId: direct }, { actor: asUser(other.owner), orgId: other.orgId })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await rows("DELETE FROM crove_kernel.role_permission WHERE role_key = 'desk.agent' AND permission = $1", [DESK_AGENT_PERMISSION]);
  });

  it('shows an agent no conversation at all, comment or private message', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [event('direct', 'd1', 'Nhắn riêng'), event('comment_thread', 'c1', 'Bình luận')]);
    const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'finance.chief_accountant', reportsTo: null }, { actor: asMfa(o.owner), orgId: o.orgId });
    await rt.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(o.owner), orgId: o.orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId: o.orgId });
    expect(started.runId).toBeTruthy();
    const agent: AgentActor = { type: 'agent', agentId, runId: started.runId as string };
    const seen = await asAgent(o.orgId, agent, async (c) => ({
      conversations: (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation')).rows[0].n,
      messages: (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation_message')).rows[0].n,
      identities: (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation_identity')).rows[0].n,
    }));
    expect(seen).toEqual({ conversations: 0, messages: 0, identities: 0 });
    // It changes none (it sees none) and writes none: the agent write guard and the policy refuse a new row.
    await expect(asAgent(o.orgId, agent, (c) => c.query("UPDATE crove_kernel.conversation SET status = 'resolved', resolved_at = now()"))).resolves.toMatchObject({ rowCount: 0 });
    await expect(asAgent(o.orgId, agent, (c) => c.query("INSERT INTO crove_kernel.conversation_identity (org_id, provider, external_user_id) VALUES ($1, 'sandbox', 'u-agent')", [o.orgId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('lets only an owner, an admin or the system delete a thread, a message, a note or an identity: a viewer, a member and a channel-limited member delete none', async () => {
    const o = await org();
    const chA = await connection(o);
    const chB = await connection(o);
    await ingest(o, chA, [event('comment_thread', 'd-a', 'Kênh A')]);
    await ingest(o, chB, [event('comment_thread', 'd-b', 'Kênh B')]);
    const [thread] = await rows<{ id: string }>("SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'd-a'", [o.orgId]);
    await rt.execute('kernel.conversation.note', { conversationId: (thread as { id: string }).id, body: 'Ghi chú' }, { actor: asUser(o.lan), orgId: o.orgId });
    // The member is limited to channel A, so their own reads include the thread they try to delete.
    await rt.execute('social.channel_access.set', { userId: o.lan, channelConnectionIds: [chA] }, { actor: asUser(o.owner), orgId: o.orgId });
    const tables = ['conversation_note', 'conversation_message', 'conversation', 'conversation_identity'];
    for (const who of [o.viewer, o.lan, o.desk]) {
      for (const t of tables) {
        await expect(asMember(o.orgId, who, (c) => c.query(`DELETE FROM crove_kernel.${t} WHERE org_id = $1`, [o.orgId]))).resolves.toMatchObject({ rowCount: 0 });
      }
    }
    // The owner and the admin delete (rolled back here), and so does the system context.
    for (const who of [o.owner, o.admin]) {
      const res = await asMember(o.orgId, who, async (c) => (await c.query('DELETE FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).rowCount);
      expect(res).toBe(2);
    }
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(2);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_note WHERE org_id = $1', [o.orgId])).toHaveLength(1);
  });

  it("keeps Social's per-channel limit (#1081) working through the kernel's table", async () => {
    const o = await org();
    const chA = await connection(o);
    const chB = await connection(o);
    await ingest(o, chA, [event('comment_thread', 'a1', 'Kênh A')]);
    await ingest(o, chB, [event('comment_thread', 'b1', 'Kênh B')]);
    expect(await previews(o, o.lan)).toEqual(['Kênh A', 'Kênh B']);
    // Social's own command limits the member to channel A; its rows are the kernel's.
    await rt.execute('social.channel_access.set', { userId: o.lan, channelConnectionIds: [chA] }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await rows('SELECT channel_connection_id FROM crove_kernel.channel_access WHERE org_id = $1 AND user_id = $2', [o.orgId, o.lan])).toEqual([{ channel_connection_id: chA }]);
    expect(await rt.query('social.channel_access.mine', {}, { actor: asUser(o.lan), orgId: o.orgId })).toEqual({ limited: true, connectionIds: [chA] });
    expect(await previews(o, o.lan)).toEqual(['Kênh A']);
    // The table holds the same rule as the command: a member's own statement can add or remove no row.
    await expect(asMember(o.orgId, o.lan, (c) => c.query('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $2)', [o.orgId, o.lan, chB]))).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(o.orgId, o.lan, (c) => c.query('DELETE FROM crove_kernel.channel_access WHERE user_id = $1', [o.lan]))).resolves.toMatchObject({ rowCount: 0 });
    // A limited member cannot widen their own list, and an owner is never limited by a row of theirs.
    await expect(rt.execute('social.channel_access.set', { userId: o.lan, channelConnectionIds: [chA, chB] }, { actor: asUser(o.lan), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.execute('social.channel_access.set', { userId: o.admin, channelConnectionIds: [chB] }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'CHANNEL_ACCESS_NOT_LIMITABLE' });
    // A row an admin has anyway (a role change after a limit) limits nobody who is an owner or admin.
    await rows('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.admin, chB, o.owner]);
    expect(await previews(o, o.admin)).toEqual(['Kênh A', 'Kênh B']);
    // An empty list lifts the limit again.
    await rt.execute('social.channel_access.set', { userId: o.lan, channelConnectionIds: [] }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await previews(o, o.lan)).toEqual(['Kênh A', 'Kênh B']);
    expect(await rows('SELECT 1 FROM crove_kernel.channel_access WHERE org_id = $1 AND user_id = $2', [o.orgId, o.lan])).toHaveLength(0);
    // The Social table is gone.
    expect(await rows("SELECT to_regclass('crove_social.channel_access') AS t")).toEqual([{ t: null }]);
  });

  it("copies the rows of an older database's crove_social.channel_access when it migrates, and drops that table", async () => {
    // A database migrated only up to the version before the move.
    const dir = mkdtempSync(join(tmpdir(), 'crove-migrations-'));
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < '20261118110000')) copyFileSync(join(MIGRATIONS, file), join(dir, file));
    const moveDb = `${dbName}_move`;
    await withClient(ADMIN as string, async (c) => void (await c.query(`CREATE DATABASE ${moveDb}`)));
    const base = new URL(ADMIN as string);
    base.pathname = `/${moveDb}`;
    const url = base.toString();
    await migrate({ adminUrl: url, dir });
    const { app } = await prepare(url, moveDb);
    const pool = createPool({ connectionString: app, max: 2 });
    pools.push(pool);
    const old = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
    const owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@move.test`, name: null });
    const member = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `member-${randomUUID().slice(0, 8)}@move.test`, name: null });
    const { orgId } = await createOrg(old, asUser(owner), 'Org cũ');
    const connectionId = randomUUID();
    await withClient(url, async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
      await c.query("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-old', 'Kênh cũ', $3)", [orgId, connectionId, owner]);
      await c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, member, connectionId, owner]);
    });
    expect((await withClient(url, (c) => c.query("SELECT to_regclass('crove_kernel.channel_access') AS t"))).rows[0].t).toBeNull();
    // The migration that moves it runs: the row is the kernel's, with its author and time, and the Social table is gone.
    await migrate({ adminUrl: url, dir: MIGRATIONS });
    const moved = await withClient(url, (c) => c.query('SELECT user_id, channel_connection_id, created_by FROM crove_kernel.channel_access WHERE org_id = $1', [orgId]));
    expect(moved.rows).toEqual([{ user_id: member, channel_connection_id: connectionId, created_by: owner }]);
    expect((await withClient(url, (c) => c.query("SELECT to_regclass('crove_social.channel_access') AS t"))).rows[0].t).toBeNull();
    // A second run changes nothing.
    await migrate({ adminUrl: url, dir: MIGRATIONS });
    expect((await withClient(url, (c) => c.query('SELECT count(*)::int AS n FROM crove_kernel.channel_access WHERE org_id = $1', [orgId]))).rows[0].n).toBe(1);
  });

  it('drops a waiting notice older than seven days with its body, returned by id, and keeps a fresh one', async () => {
    const enqueue = (body: string) => withClient(appUrl, async (c) => (await c.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2) AS seq', ['sandbox', Buffer.from(body)])).rows[0].seq as string);
    const old = await enqueue('{"v":1,"old":true}');
    const fresh = await enqueue('{"v":1,"fresh":true}');
    await rows("UPDATE crove_kernel.conversation_inbound_pending SET received_at = now() - interval '8 days' WHERE seq = $1", [old]);
    const claimed = await withClient(workerUrl, async (c) => (await c.query('SELECT seq, body, dropped, reason FROM crove_kernel.conversation_inbound_claim(10, 60)')).rows);
    expect(claimed).toEqual([
      { seq: old, body: null, dropped: true, reason: 'expired' },
      { seq: fresh, body: Buffer.from('{"v":1,"fresh":true}'), dropped: false, reason: null },
    ]);
    expect(await rows('SELECT seq::text AS seq FROM crove_kernel.conversation_inbound_pending')).toEqual([{ seq: fresh }]);
    // An expired notice is dropped even while a worker holds its lease (the worker that held it is gone or too slow).
    await rows("UPDATE crove_kernel.conversation_inbound_pending SET received_at = now() - interval '8 days' WHERE seq = $1", [fresh]);
    const second = await withClient(workerUrl, async (c) => (await c.query('SELECT seq, body, dropped, reason FROM crove_kernel.conversation_inbound_claim(10, 60)')).rows);
    expect(second).toEqual([{ seq: fresh, body: null, dropped: true, reason: 'expired' }]);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).toHaveLength(0);
  });
});
