// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox of the conversation core on PostgreSQL 17 (CV3, #2306, plan docs/plan/conversations.md sections 5.5 and 8): the desk.agent seed, whom a new
// conversation is told to (the assignee, else the available members who can read it, else owners and admins, by the database's own rule of who reads
// what), the "you are replying" marker, the availability switch, the search, the customer's other threads, and the Home read. Set CROVE_TEST_ADMIN_URL
// to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zTodayItems, type Availability, type ConversationDetail, type ConversationEvent, type ConversationListed, type TodayItem } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

suite('the Inbox: routing a new conversation, the replying marker, availability, search and the Home read (CV3, #2306)', () => {
  const dbName = `crove_test_conversations_inbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@inbox.test`, name: null }) as Promise<string>;

  type Org = { orgId: string; owner: string; admin: string; lan: string; desk: string; viewer: string; connectionId: string };
  // An org with an owner, an admin, a member with no role (lan), a member who holds desk.agent (desk) and a viewer, and a sandbox channel.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [admin, lan, desk, viewer] = [await person('admin'), await person('lan'), await person('desk'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, admin, lan, desk, viewer]);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [orgId, desk, owner]);
    const connectionId = randomUUID();
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, owner]);
    return { orgId, owner, admin, lan, desk, viewer, connectionId };
  }
  let tick = 0;
  const event = (kind: ConversationEvent['kind'], threadId: string, text: string, name = `Khách ${threadId}`, contactId = `u-${threadId}`): ConversationEvent => ({
    kind,
    threadId,
    ...(kind === 'comment_thread' ? { postId: 'post-1' } : {}),
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: contactId, name },
    text,
    // Ten minutes ago, a second apart: recent enough to be news (a thread older than a day is not told as new).
    at: new Date(Date.now() - 600_000 + tick * 1000).toISOString(),
  });
  // A message the platform dates after now: a customer who writes again once the thread was resolved (an older one does not reopen it).
  const later = (e: ConversationEvent): ConversationEvent => ({ ...e, at: new Date(Date.now() + 60_000).toISOString() });
  const ingest = (o: Org, events: ConversationEvent[], connectionId = o.connectionId) => worker.execute('kernel.conversation.ingest', { connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const threadOf = async (o: Org, external: string) => ((await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, external]))[0] as { id: string }).id;
  const exec = <T>(o: Org, user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId: o.orgId });
  const query = <T>(o: Org, user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId: o.orgId });
  const list = (o: Org, user: string, input: Record<string, unknown> = {}) => query<ConversationListed>(o, user, 'kernel.conversation.list', input);
  // Who was told, for the thread: the members with a notification of the kind about it, by the key of the message that opened it.
  const told = async (o: Org, conversationId: string) =>
    (await rows<{ user_id: string }>("SELECT DISTINCT user_id FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'kernel.conversation_new' AND subject_id = $2 ORDER BY user_id", [o.orgId, conversationId])).map((r) => r.user_id);
  const sorted = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    await withClient(ADMIN as string, async (c) => void (await c.query(`CREATE DATABASE ${dbName}`)));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    appUrl = urlFor('crove_app', 'test-app-pw');
    workerUrl = urlFor('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    await withClient(ADMIN, async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)));
  });

  describe('whom a new conversation is told to', () => {
    it('tells the members who read a private message (owners, admins, the desk.agent role), never a plain member or a viewer, once for each time it becomes New', async () => {
      const o = await org();
      await ingest(o, [event('direct', 'd1', 'Nhắn riêng đầu tiên')]);
      const d1 = await threadOf(o, 'd1');
      expect(await told(o, d1)).toEqual(sorted(o.owner, o.admin, o.desk));
      // A second message while it is still New tells nobody again.
      await ingest(o, [event('direct', 'd1', 'Còn nữa')]);
      expect((await rows('SELECT 1 FROM crove_kernel.notification WHERE org_id = $1 AND subject_id = $2', [o.orgId, d1])).length).toBe(3);
      // Resolved, then the customer writes again: it is New again, and they are told again.
      await exec(o, o.desk, 'kernel.conversation.resolve', { conversationId: d1 });
      await ingest(o, [later(event('direct', 'd1', 'Em hỏi thêm'))]);
      expect((await rows('SELECT 1 FROM crove_kernel.notification WHERE org_id = $1 AND subject_id = $2', [o.orgId, d1])).length).toBe(6);
      // The notice names the thread and nothing else: no text of the customer, no name.
      const stored = JSON.stringify(await rows('SELECT kind, subject_type, detail FROM crove_kernel.notification WHERE org_id = $1 AND subject_id = $2', [o.orgId, d1]));
      expect(stored).not.toContain('Nhắn riêng');
      expect(stored).not.toContain('Khách');
    });

    it('tells every member who reads a comment thread, the channel limit applied, and never a viewer', async () => {
      const o = await org();
      const other = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh khác', $4)", [o.orgId, other, `acct-${randomUUID().slice(0, 8)}`, o.owner]);
      // The desk member is limited to the other channel: this channel's threads are not theirs.
      await rows('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.desk, other, o.owner]);
      await ingest(o, [event('comment_thread', 'c1', 'Giá bao nhiêu')]);
      expect(await told(o, await threadOf(o, 'c1'))).toEqual(sorted(o.owner, o.admin, o.lan));
      await ingest(o, [event('comment_thread', 'c2', 'Còn hàng không')], other);
      expect(await told(o, await threadOf(o, 'c2'))).toEqual(sorted(o.owner, o.admin, o.lan, o.desk));
    });

    it('tells the available members first, owners and admins when nobody is, and the assignee when there is one', async () => {
      const o = await org();
      const away = (user: string, status: 'away' | 'available' = 'away') => exec(o, user, 'kernel.conversation.set_availability', { status });
      // Everyone who reads it is away: owners and admins are told anyway.
      await away(o.owner);
      await away(o.admin);
      await away(o.desk);
      await ingest(o, [event('direct', 'a1', 'Hỏi lúc không ai rảnh')]);
      expect(await told(o, await threadOf(o, 'a1'))).toEqual(sorted(o.owner, o.admin));
      // The desk member is back: they alone are told (an available member who reads it).
      await away(o.desk, 'available');
      await ingest(o, [event('direct', 'a2', 'Hỏi khi có nhân viên')]);
      expect(await told(o, await threadOf(o, 'a2'))).toEqual([o.desk]);
      // An assigned thread that becomes New again tells its assignee alone, available or not.
      const a2 = await threadOf(o, 'a2');
      await exec(o, o.desk, 'kernel.conversation.assign', { conversationId: a2, assigneeUserId: o.desk });
      await away(o.desk);
      await exec(o, o.desk, 'kernel.conversation.resolve', { conversationId: a2 });
      await ingest(o, [later(event('direct', 'a2', 'Em hỏi lại'))]);
      expect((await rows<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.notification WHERE org_id = $1 AND subject_id = $2 AND user_id = $3", [o.orgId, a2, o.desk]))[0]?.n).toBe('2');
      expect(await told(o, a2)).toEqual([o.desk]);
    });

    it('reads an away time that passed as available, respects a muted kind with the fallback among those who did not, never tells a viewer given the role, and tells nothing of an old thread', async () => {
      const o = await org();
      // Away until a time that has passed (a restore's statement ages the row): available again, so told, as the availability read says.
      await exec(o, o.desk, 'kernel.conversation.set_availability', { status: 'away', until: new Date(Date.now() + 3_600_000).toISOString() });
      await rows("UPDATE crove_kernel.member_availability SET until = now() - interval '1 minute' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.desk]);
      await ingest(o, [event('direct', 'e1', 'Hỏi sau giờ vắng')]);
      expect(await told(o, await threadOf(o, 'e1'))).toEqual(sorted(o.owner, o.admin, o.desk));
      // The desk member turned the kind off: the others who are available are told, the desk member is not.
      await rows("INSERT INTO crove_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, 'kernel.conversation_new')", [o.orgId, o.desk]);
      await ingest(o, [event('direct', 'e2', 'Hỏi khi nhân viên tắt thông báo')]);
      expect(await told(o, await threadOf(o, 'e2'))).toEqual(sorted(o.owner, o.admin));
      // Owner and admin are away and the desk member muted it: the fallback is owners and admins, who did not mute it.
      await exec(o, o.owner, 'kernel.conversation.set_availability', { status: 'away' });
      await exec(o, o.admin, 'kernel.conversation.set_availability', { status: 'away' });
      await ingest(o, [event('direct', 'e3', 'Hỏi khi chỉ còn chủ vắng')]);
      expect(await told(o, await threadOf(o, 'e3'))).toEqual(sorted(o.owner, o.admin));
      // Everyone who could be told muted it: nobody is.
      await rows("INSERT INTO crove_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, 'kernel.conversation_new'), ($1, $3, 'kernel.conversation_new')", [o.orgId, o.owner, o.admin]);
      await ingest(o, [event('direct', 'e4', 'Hỏi khi tất cả tắt')]);
      expect(await told(o, await threadOf(o, 'e4'))).toEqual([]);
      // A viewer given the role (a database owner's statement: the grant itself refuses it) is no reader of a private message and is not told of one.
      const p = await org();
      await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [p.orgId, p.viewer, p.owner]);
      await ingest(p, [event('direct', 'v1', 'Nhắn riêng')]);
      expect(await told(p, await threadOf(p, 'v1'))).toEqual(sorted(p.owner, p.admin, p.desk));
      expect((await list(p, p.viewer)).conversations).toEqual([]);
      // A message the platform dated more than a day ago (a history read, a reconcile) is not news.
      const old = { ...event('direct', 'old1', 'Tin cũ'), at: new Date(Date.now() - 3 * 86_400_000).toISOString() };
      await ingest(p, [old]);
      expect(await told(p, await threadOf(p, 'old1'))).toEqual([]);
    });

    it('answers the readers of a thread to the worker login alone, in a system context', async () => {
      const o = await org();
      await ingest(o, [event('direct', 'r1', 'Nhắn riêng')]);
      const r1 = await threadOf(o, 'r1');
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_readers($1::uuid)', [r1])).rejects.toMatchObject({ code: '42501' });
      await expect(asMember(o.orgId, o.owner, (c) => c.query('SELECT * FROM crove_kernel.conversation_readers($1::uuid)', [r1]))).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query('SELECT * FROM crove_kernel.conversation_readers($1::uuid)', [r1])).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the "you are replying" marker and the availability switch', () => {
    it('marks a thread for 60 seconds at most once in 20, shows it to the others who read the thread and not to the one typing, and forgets it', async () => {
      const o = await org();
      await ingest(o, [event('direct', 'm1', 'Nhắn riêng')]);
      const m1 = await threadOf(o, 'm1');
      expect(await exec(o, o.desk, 'kernel.conversation.composing', { conversationId: m1 })).toEqual({ marked: true });
      // A second call inside the 20 seconds changes nothing.
      expect(await exec(o, o.desk, 'kernel.conversation.composing', { conversationId: m1 })).toEqual({ marked: false });
      const seenBy = async (user: string) => (await list(o, user)).conversations.find((c) => c.id === m1)?.composing;
      expect(await seenBy(o.owner)).toEqual([o.desk]);
      expect(await seenBy(o.desk)).toEqual([]);
      expect((await query<ConversationDetail>(o, o.admin, 'kernel.conversation.get', { conversationId: m1 })).conversation.composing).toEqual([o.desk]);
      // The marker lives 60 seconds: written now, it expires within a minute and the readers ignore it after.
      const lasts = await rows<{ left: number }>('SELECT extract(epoch FROM expires_at - updated_at)::int AS left FROM crove_kernel.conversation_composing WHERE org_id = $1 AND conversation_id = $2', [o.orgId, m1]);
      expect(lasts[0]?.left).toBe(60);
      await rows("UPDATE crove_kernel.conversation_composing SET expires_at = now() - interval '1 second', updated_at = now() - interval '30 seconds' WHERE org_id = $1", [o.orgId]);
      expect(await seenBy(o.owner)).toEqual([]);
      // After the 20 seconds a new mark is written again.
      expect(await exec(o, o.desk, 'kernel.conversation.composing', { conversationId: m1 })).toEqual({ marked: true });
      // A member who may not read the thread finds none; a viewer may not write one.
      await expect(exec(o, o.lan, 'kernel.conversation.composing', { conversationId: m1 })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
      await expect(exec(o, o.viewer, 'kernel.conversation.composing', { conversationId: m1 })).rejects.toMatchObject({ status: 403 });
      // In the table: nobody writes a marker in another's name, and a member who may not read the thread sees none.
      await expect(
        asMember(o.orgId, o.desk, (c) => c.query('INSERT INTO crove_kernel.conversation_composing (org_id, conversation_id, channel_connection_id, kind, user_id, expires_at) SELECT org_id, id, channel_connection_id, kind, $2, now() + interval \'1 minute\' FROM crove_kernel.conversation WHERE id = $1', [m1, o.owner])),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await asMember(o.orgId, o.lan, async (c) => (await c.query('SELECT 1 FROM crove_kernel.conversation_composing')).rowCount)).toBe(0);
      expect(await asMember(o.orgId, o.desk, async (c) => (await c.query('SELECT 1 FROM crove_kernel.conversation_composing')).rowCount)).toBe(1);
      // The audit row of a mark has the thread's id and no text.
      const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.composing'", [o.orgId]));
      expect(audit).toContain(m1);
      expect(audit).not.toContain('Nhắn riêng');
    });

    it('sweeps the markers five minutes after they expired, for the worker login alone', async () => {
      const o = await org();
      await ingest(o, [event('direct', 's1', 'Nhắn riêng')]);
      const s1 = await threadOf(o, 's1');
      await exec(o, o.desk, 'kernel.conversation.composing', { conversationId: s1 });
      await rows("UPDATE crove_kernel.conversation_composing SET expires_at = now() - interval '2 minutes' WHERE org_id = $1", [o.orgId]);
      expect((await workerPool.query('SELECT crove_kernel.conversation_composing_sweep() AS n')).rows[0].n).toBe(0);
      await rows("UPDATE crove_kernel.conversation_composing SET expires_at = now() - interval '10 minutes' WHERE org_id = $1", [o.orgId]);
      expect(((await workerPool.query('SELECT crove_kernel.conversation_composing_sweep() AS n')).rows[0].n as number) >= 1).toBe(true);
      expect(await rows('SELECT 1 FROM crove_kernel.conversation_composing WHERE org_id = $1', [o.orgId])).toEqual([]);
      await expect(pool.query('SELECT crove_kernel.conversation_composing_sweep()')).rejects.toMatchObject({ code: '42501' });
    });

    it('keeps a member’s availability to themselves, shows the team’s to the staff, and reads an away time that passed as available again', async () => {
      const o = await org();
      expect((await query<Availability>(o, o.lan, 'kernel.conversation.availability', {})).me).toMatchObject({ userId: o.lan, status: 'available', until: null });
      const later = new Date(Date.now() + 3_600_000).toISOString();
      expect(await exec(o, o.lan, 'kernel.conversation.set_availability', { status: 'away', until: later })).toMatchObject({ userId: o.lan, status: 'away', until: later });
      const team = await query<Availability>(o, o.desk, 'kernel.conversation.availability', {});
      expect(team.members).toEqual([expect.objectContaining({ userId: o.lan, status: 'away' })]);
      expect(team.me).toMatchObject({ userId: o.desk, status: 'available' });
      // A viewer reads none of it: the screen is for those who answer.
      await expect(query(o, o.viewer, 'kernel.conversation.availability', {})).rejects.toMatchObject({ status: 403 });
      // Setting it again is an update of the one row; an away time in the past is refused; available clears the time.
      await expect(exec(o, o.lan, 'kernel.conversation.set_availability', { status: 'away', until: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ code: 'AVAILABILITY_PAST' });
      expect(await exec(o, o.lan, 'kernel.conversation.set_availability', { status: 'available' })).toMatchObject({ status: 'available', until: null });
      expect(await rows('SELECT 1 FROM crove_kernel.member_availability WHERE org_id = $1 AND user_id = $2', [o.orgId, o.lan])).toHaveLength(1);
      // A viewer sets none; nobody writes another member's row (the table says it).
      await expect(exec(o, o.viewer, 'kernel.conversation.set_availability', { status: 'away' })).rejects.toMatchObject({ status: 403 });
      expect(await asMember(o.orgId, o.desk, async (c) => (await c.query("UPDATE crove_kernel.member_availability SET status = 'away' WHERE user_id = $1", [o.lan])).rowCount)).toBe(0);
      await expect(asMember(o.orgId, o.desk, (c) => c.query("INSERT INTO crove_kernel.member_availability (org_id, user_id, status) VALUES ($1, $2, 'away')", [o.orgId, o.admin]))).rejects.toMatchObject({ code: '42501' });
      // An away time that has passed reads as available again (a restore's statement ages it).
      await exec(o, o.lan, 'kernel.conversation.set_availability', { status: 'away', until: later });
      await rows("UPDATE crove_kernel.member_availability SET until = now() - interval '1 minute' WHERE org_id = $1", [o.orgId]);
      expect((await query<Availability>(o, o.lan, 'kernel.conversation.availability', {})).me).toMatchObject({ status: 'available', until: null });
    });
  });

  describe('searching, the customer’s other threads and the Home read', () => {
    it('searches the customer’s name and the words of a thread without regard to case, Vietnamese marks or punctuation, and punctuation alone is no search', async () => {
      const o = await org();
      await ingest(o, [event('direct', 'q1', 'Cho mình hỏi giá áo thun cotton', 'Nguyễn Thị Hoa'), event('direct', 'q2', 'Đơn hàng giảm 50% còn không', 'Trần Văn Bình')]);
      const ids = async (q: string) => (await list(o, o.owner, { q })).conversations.map((c) => c.contact.displayName).sort();
      expect(await ids('gia ao thun')).toEqual(['Nguyễn Thị Hoa']);
      expect(await ids('NGUYEN thi')).toEqual(['Nguyễn Thị Hoa']);
      expect(await ids('binh')).toEqual(['Trần Văn Bình']);
      expect(await ids('không có')).toEqual([]);
      // Text that is only punctuation folds to nothing: it is no search, so every thread stays; a % in the text is punctuation like the rest.
      expect(await ids('???')).toEqual(['Nguyễn Thị Hoa', 'Trần Văn Bình']);
      expect(await ids('50%')).toEqual(['Trần Văn Bình']);
      // A member who may not read a private message finds none by searching for it.
      expect((await list(o, o.lan, { q: 'gia ao thun' })).conversations).toEqual([]);
    });

    it('lists the customer’s other threads that the reader may read, with no text', async () => {
      const o = await org();
      // One customer writes in a comment thread and in a private message.
      await ingest(o, [event('comment_thread', 'x1', 'Bình luận dưới bài', 'Lê Văn A', 'same-customer'), event('direct', 'x2', 'Nhắn riêng', 'Lê Văn A', 'same-customer')]);
      const [x1, x2] = [await threadOf(o, 'x1'), await threadOf(o, 'x2')];
      const othersOf = async (user: string, id: string) => (await query<ConversationDetail>(o, user, 'kernel.conversation.get', { conversationId: id })).others;
      expect((await othersOf(o.owner, x2)).map((t) => [t.id, t.kind, t.status])).toEqual([[x1, 'comment_thread', 'new']]);
      expect((await othersOf(o.owner, x1)).map((t) => t.id)).toEqual([x2]);
      // A member without the desk role reads the comment thread, and the private one is not among its others.
      expect(await othersOf(o.lan, x1)).toEqual([]);
      expect(JSON.stringify(await othersOf(o.owner, x2))).not.toContain('Bình luận');
    });

    it('answers Home the conversations that wait for the member by their own rule: no text, no name, nothing of a thread they may not read', async () => {
      const o = await org();
      await ingest(o, [event('direct', 't1', 'Nhắn riêng bí mật', 'Phạm Văn Kín'), event('comment_thread', 't2', 'Bình luận bí mật', 'Võ Thị Kín')]);
      const [t1, t2] = [await threadOf(o, 't1'), await threadOf(o, 't2')];
      const today = (user: string) => query<TodayItem[]>(o, user, 'kernel.conversation.today', {});
      const owner = await today(o.owner);
      expect(zTodayItems.safeParse(owner).success).toBe(true);
      expect(owner[0]).toMatchObject({ kind: 'message', app: 'conversations', id: 'unanswered', count: 2, title: { key: 'conversations.unanswered' }, href: '/social/inbox?status=new' });
      expect(owner.slice(1).map((i) => i.id).sort()).toEqual([`conversation:${t1}`, `conversation:${t2}`].sort());
      expect(owner.find((i) => i.id === `conversation:${t1}`)).toMatchObject({ title: { key: 'conversations.oneUnanswered', params: { provider: 'sandbox' } }, href: `/social/inbox?c=${t1}` });
      // The comment thread only for a member with no desk role, both for the desk member; none for a viewer.
      expect((await today(o.lan))[0]).toMatchObject({ count: 1 });
      expect((await today(o.desk))[0]).toMatchObject({ count: 2 });
      expect(await today(o.viewer)).toEqual([]);
      // Nothing a customer wrote, no name, no channel name.
      const text = JSON.stringify([owner, await today(o.lan)]);
      for (const typed of ['bí mật', 'Kín', 'Kênh thử']) expect(text).not.toContain(typed);
      // Assigned to another member: not waiting for this one; answered (pending): for nobody.
      await exec(o, o.owner, 'kernel.conversation.assign', { conversationId: t1, assigneeUserId: o.admin });
      expect((await today(o.desk))[0]).toMatchObject({ count: 1 });
      expect((await today(o.admin))[0]).toMatchObject({ count: 2 });
      // A member limited to another channel gets nothing.
      const other = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh khác', $4)", [o.orgId, other, `acct-${randomUUID().slice(0, 8)}`, o.owner]);
      await rows('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.lan, other, o.owner]);
      expect(await today(o.lan)).toEqual([]);
      // Answered (pending), the thread waits for the customer, not for a member: nothing for anyone.
      await rows("UPDATE crove_kernel.conversation SET status = 'pending' WHERE org_id = $1", [o.orgId]);
      expect(await today(o.owner)).toEqual([]);
      expect(await today(o.admin)).toEqual([]);
    });
  });
});
