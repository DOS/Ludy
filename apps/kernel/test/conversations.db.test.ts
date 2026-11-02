// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core on PostgreSQL 17 (#2303, plan docs/plan/conversations.md): a platform's events are stored once and in
// order under a thread of their own, the org comes from the stored connection and never from an event, a reply goes out
// exactly once (a worker killed mid-call leaves a call row and no second send), a newer message refuses a reply, a comment
// thread is read like the channel it is on and a private message only by owners and admins, and no customer text reaches an
// audit row or an event. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationCounted, ConversationDetail, ConversationEvent, ConversationIngested, ConversationListed } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };
// Text no audit row, event or log may hold.
const SECRET_TEXT = 'số điện thoại 0912345678 của khách Nguyễn Văn Mẫu';

suite('conversations on PostgreSQL (#2303)', () => {
  const dbName = `crove_test_conversations_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
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
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  // A statement in a member's context as the API's login, rolled back: the table's policy, not a command.
  async function asApp<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@conversations.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; lan: string; minh: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), lan: await person('lan'), minh: await person('minh'), viewer: await person('viewer') };
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, o.admin, o.lan, o.minh, o.viewer]),
    );
    return o;
  }
  async function connection(o: Org, provider = 'sandbox'): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Kênh thử', $5)", [
        o.orgId,
        id,
        provider,
        `acct-${randomUUID().slice(0, 8)}`,
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const sys = <O>(o: Org, name: string, input: unknown) => worker.execute<O>(name, input, { actor: SYSTEM, orgId: o.orgId });
  const ingest = (o: Org, connectionId: string, events: ConversationEvent[]) => sys<ConversationIngested>(o, 'kernel.conversation.ingest', { connectionId, events });

  let tick = 0;
  const comment = (threadId: string, text: string, extra: Partial<ConversationEvent> = {}): ConversationEvent => ({
    kind: 'comment_thread',
    threadId,
    postId: 'post-1',
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: 'u-1001', name: 'Trần Thị Khách' },
    text,
    at: new Date(Date.UTC(2026, 10, 2, 3, 0, tick)).toISOString(),
    ...extra,
  });
  const listAll = (o: Org, user: string, input: Record<string, unknown> = {}) => query<ConversationListed>(o, user, 'kernel.conversation.list', input);
  const detail = (o: Org, user: string, id: string) => query<ConversationDetail>(o, user, 'kernel.conversation.get', { conversationId: id });
  const threadOf = async (o: Org, connectionId: string, threadId: string) =>
    (await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND channel_connection_id = $2 AND external_thread_id = $3', [o.orgId, connectionId, threadId]))[0]?.id as string;

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
    appUrl = app.toString();
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
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

  it('stores a comment once under a thread of its own, and a replayed event changes nothing', async () => {
    const o = await org();
    const ch = await connection(o);
    const first = comment('c-1', SECRET_TEXT);
    expect(await ingest(o, ch, [first])).toEqual({ stored: 1, duplicates: 0, ignored: 0 });
    expect(await ingest(o, ch, [first])).toEqual({ stored: 0, duplicates: 1, ignored: 0 });
    // A follow-up under the same top-level comment joins its thread; another top-level comment is a thread of its own.
    const follow = comment('c-1', 'Còn hàng không shop?', { messageId: 'm-follow-1' });
    const other = comment('c-2', 'Giá bao nhiêu?', { contact: { id: 'u-2002', name: 'Lê Văn Hỏi' } });
    expect(await ingest(o, ch, [follow, other])).toEqual({ stored: 2, duplicates: 0, ignored: 0 });
    const listed = await listAll(o, o.lan);
    expect(listed.conversations).toHaveLength(2);
    const t1 = await threadOf(o, ch, 'c-1');
    const seen = await detail(o, o.lan, t1);
    expect(seen.messages.map((m) => [m.seq, m.direction, m.body])).toEqual([
      [1, 'in', SECRET_TEXT],
      [2, 'in', 'Còn hàng không shop?'],
    ]);
    expect(seen.conversation).toMatchObject({ kind: 'comment_thread', status: 'new', postId: 'post-1', lastSeq: 2, unread: true });
    expect(seen.conversation.contact).toMatchObject({ displayName: 'Trần Thị Khách', idTail: '1001', partyId: null });
    // Inbound text is tainted external text, always.
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND direction = $2 AND NOT tainted', [o.orgId, 'in'])).toHaveLength(0);
  });

  it('refuses text the database cannot store before it starts, and counts a post page the way its list does', async () => {
    const o = await org();
    const ch = await connection(o);
    await expect(ingest(o, ch, [comment('c-1', 'có ký tự rỗng')])).rejects.toMatchObject({ status: 422 });
    await ingest(o, ch, [comment('c-1', 'Dưới bài 1', { postId: 'post-1' }), comment('c-2', 'Dưới bài 2', { postId: 'post-2', contact: { id: 'u-2', name: 'Khác' } })]);
    const posts = [{ connectionId: ch, externalPostId: 'post-2' }];
    expect((await listAll(o, o.lan, { posts })).conversations.map((c) => c.preview)).toEqual(['Dưới bài 2']);
    expect(await query<ConversationCounted>(o, o.lan, 'kernel.conversation.counts', { posts })).toEqual({ new: 1, pending: 0, resolved: 0, unread: 1 });
    expect(await query<ConversationCounted>(o, o.lan, 'kernel.conversation.counts', {})).toMatchObject({ new: 2 });
  });

  it("keeps a linked contact to its kind: a private message's link is not shown on the customer's public comments", async () => {
    const o = await org();
    const ch = await connection(o);
    const same = { id: 'u-same', name: 'Cùng một người' };
    await ingest(o, ch, [comment('d-1', 'Riêng', { kind: 'direct', postId: undefined, contact: same }), comment('c-1', 'Công khai', { contact: same })]);
    const party = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Khách hàng Z')", [o.orgId, party]));
    await exec(o, o.owner, 'kernel.conversation.link_contact', { conversationId: await threadOf(o, ch, 'd-1'), partyId: party });
    expect((await detail(o, o.lan, await threadOf(o, ch, 'c-1'))).conversation.contact.partyId).toBeNull();
    // A new private thread of the same customer inherits it; a new comment thread does not.
    await ingest(o, ch, [comment('d-2', 'Riêng nữa', { kind: 'direct', postId: undefined, contact: same }), comment('c-2', 'Công khai nữa', { contact: same })]);
    expect((await detail(o, o.owner, await threadOf(o, ch, 'd-2'))).conversation.contact.partyId).toBe(party);
    expect((await detail(o, o.lan, await threadOf(o, ch, 'c-2'))).conversation.contact.partyId).toBeNull();
  });

  it('takes the org from the stored connection, never from an event', async () => {
    const a = await org();
    const b = await org();
    const chB = await connection(b);
    // Org A's context names org B's connection: it is not found there, so nothing is stored anywhere.
    expect(await ingest(a, chB, [comment('x-1', 'hi')])).toEqual({ stored: 0, duplicates: 0, ignored: 1 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE channel_connection_id = $1', [chB])).toHaveLength(0);
    // Only the system runs it; a member is refused.
    await expect(exec(a, a.owner, 'kernel.conversation.ingest', { connectionId: chB, events: [comment('x-2', 'hi')] })).rejects.toMatchObject({ status: 403 });
    // An inactive connection stores nothing.
    const chA = await connection(a);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [chA]));
    expect(await ingest(a, chA, [comment('x-3', 'hi')])).toEqual({ stored: 0, duplicates: 0, ignored: 1 });
  });

  it('reopens a resolved thread when the customer writes again, and blanks a message the platform removed', async () => {
    const o = await org();
    const ch = await connection(o);
    const first = comment('c-1', 'Xin chào');
    await ingest(o, ch, [first]);
    const id = await threadOf(o, ch, 'c-1');
    await exec(o, o.lan, 'kernel.conversation.resolve', { conversationId: id });
    expect((await detail(o, o.lan, id)).conversation.status).toBe('resolved');
    await ingest(o, ch, [comment('c-1', 'Alo?', { messageId: 'm-again', at: new Date(Date.now() + 1000).toISOString() })]);
    expect((await detail(o, o.lan, id)).conversation.status).toBe('new');
    // The platform tells us the first one is gone: the body goes, the row stays.
    await ingest(o, ch, [{ ...first, removed: true }]);
    const after = await detail(o, o.lan, id);
    expect(after.messages[0]).toMatchObject({ seq: 1, body: '', removed: true });
    expect(after.messages[1]?.body).toBe('Alo?');
  });

  it('sends a reply exactly once: a call row before the call, a killed worker never sends twice', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('c-1', 'Ship về Đà Nẵng bao lâu?')]);
    const id = await threadOf(o, ch, 'c-1');
    // The reply carries the last message its sender saw: a newer one refuses it.
    await expect(exec(o, o.lan, 'kernel.conversation.reply', { conversationId: id, body: 'Dạ 3 ngày ạ', lastSeenSeq: 0 })).rejects.toMatchObject({ code: 'CONVERSATION_MOVED', status: 409 });
    const replied = await exec<{ messageId: string; seq: number }>(o, o.lan, 'kernel.conversation.reply', { conversationId: id, body: 'Dạ 3 ngày ạ', lastSeenSeq: 1 });
    expect(replied.seq).toBe(2);
    const after = await detail(o, o.lan, id);
    expect(after.conversation).toMatchObject({ status: 'pending', assigneeUserId: o.lan });
    expect(after.messages[1]).toMatchObject({ direction: 'out', authorKind: 'member', sendState: 'queued', body: 'Dạ 3 ngày ạ' });
    // The first worker begins the call, and dies before it records an answer.
    const begin = () => sys<{ action: string; reason?: string; callKey?: string; text?: string; contactId?: string }>(o, 'kernel.conversation.reply_begin', { messageId: replied.messageId });
    const first = await begin();
    expect(first).toMatchObject({ action: 'call', callKey: `conversation.reply:${replied.messageId}:1`, text: 'Dạ 3 ngày ạ', contactId: 'u-1001' });
    // The job comes round again: the call is in flight, so it makes none.
    expect(await begin()).toEqual({ action: 'none', reason: 'in_flight' });
    expect(await rows("SELECT state, retry_safety FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'reply'", [o.orgId])).toEqual([{ state: 'started', retry_safety: 'reconcile_only' }]);
    // The call is still started long after: a person settles it, the message says it is unclear.
    // (The call row's start never changes through the app; the test ages it as the database owner, triggers off.)
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query("UPDATE crove_kernel.external_call SET started_at = now() - interval '11 minutes' WHERE org_id = $1 AND step = 'reply'", [o.orgId]);
      await c.query('COMMIT');
    });
    expect(await begin()).toEqual({ action: 'none', reason: 'settled' });
    expect((await detail(o, o.lan, id)).messages[1]).toMatchObject({ sendState: 'unknown', sendErrorCode: 'WORKER_LOST' });
    expect(await rows("SELECT state FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'reply'", [o.orgId])).toEqual([{ state: 'ambiguous' }]);
    // A person looked on the platform and it did go out.
    await exec(o, o.lan, 'kernel.conversation.reply_settle', { messageId: replied.messageId, action: 'mark_sent' });
    expect((await detail(o, o.lan, id)).messages[1]?.sendState).toBe('sent');
  });

  it('records the platform answer, and a refused reply is sent again only by a person, as a new attempt', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('c-1', 'Xin giá')]);
    const id = await threadOf(o, ch, 'c-1');
    const { messageId } = await exec<{ messageId: string }>(o, o.minh, 'kernel.conversation.reply', { conversationId: id, body: 'Dạ 100k', lastSeenSeq: 1 });
    const call = await sys<{ callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: call.callKey, result: { kind: 'rejected', error: 'permission', code: 'PERMISSION_DENIED' } });
    expect((await detail(o, o.minh, id)).messages[1]).toMatchObject({ sendState: 'failed', sendErrorCode: 'PERMISSION_DENIED' });
    // A failed one is not begun again by a job: nothing is queued until a person asks.
    expect(await sys(o, 'kernel.conversation.reply_begin', { messageId })).toEqual({ action: 'none', reason: 'settled' });
    await exec(o, o.minh, 'kernel.conversation.reply_settle', { messageId, action: 'retry' });
    const again = await sys<{ action: string; callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    expect(again).toMatchObject({ action: 'call', callKey: `conversation.reply:${messageId}:2` });
    // An answer for the first attempt's call changes nothing now.
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: call.callKey, result: { kind: 'accepted', externalId: 'old' } });
    expect((await detail(o, o.minh, id)).messages[1]?.sendState).toBe('sending');
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: again.callKey, result: { kind: 'accepted', externalId: 'sbx_reply_1' } });
    expect((await detail(o, o.minh, id)).messages[1]).toMatchObject({ sendState: 'sent', sendErrorCode: null });
    expect(await rows("SELECT key, state, external_ref FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'reply' ORDER BY key", [o.orgId])).toEqual([
      { key: `conversation.reply:${messageId}:1`, state: 'failed', external_ref: null },
      { key: `conversation.reply:${messageId}:2`, state: 'succeeded', external_ref: 'sbx_reply_1' },
    ]);
  });

  it("matches the platform's echo of a reply being sent, without a second message", async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [{ ...comment('d-1', 'Alo', { kind: 'direct', postId: undefined }) }]);
    const id = await threadOf(o, ch, 'd-1');
    const { messageId } = await exec<{ messageId: string }>(o, o.owner, 'kernel.conversation.reply', { conversationId: id, body: 'Chào bạn', lastSeenSeq: 1 });
    const call = await sys<{ callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    // The echo reaches the worker before the answer is recorded.
    await ingest(o, ch, [comment('d-1', 'Chào bạn', { kind: 'direct', postId: undefined, direction: 'out', messageId: 'platform-echo-1', at: new Date().toISOString() })]);
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: call.callKey, result: { kind: 'accepted', externalId: 'platform-echo-1' } });
    const seen = await detail(o, o.owner, id);
    expect(seen.messages.map((m) => [m.direction, m.sendState])).toEqual([['in', null], ['out', 'sent']]);
  });

  it('keeps a resolved thread resolved for a customer message dated before the resolution, and never stores the body of a message removed before it arrived', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('r-1', 'Xin chào')]);
    const id = await threadOf(o, ch, 'r-1');
    await exec(o, o.lan, 'kernel.conversation.resolve', { conversationId: id });
    // A late notice of an older message: the platform dated it before the thread was resolved.
    await ingest(o, ch, [comment('r-1', 'Tin đến muộn', { messageId: 'm-late', at: new Date(Date.now() - 3_600_000).toISOString() })]);
    const late = await detail(o, o.lan, id);
    expect(late.conversation.status).toBe('resolved');
    expect(late.messages.map((m) => m.body)).toEqual(['Xin chào', 'Tin đến muộn']);
    // The removal of a comment reaches the worker before the comment itself: a blank tombstone takes its id, and the add that follows
    // finds it, so the text the platform removed is never stored.
    const first = await ingest(o, ch, [comment('r-1', 'Bình luận đã bị gỡ', { messageId: 'm-gone', removed: true })]);
    expect(first.stored).toBe(1);
    const second = await ingest(o, ch, [comment('r-1', 'Bình luận đã bị gỡ', { messageId: 'm-gone' })]);
    expect(second.duplicates).toBe(1);
    const after = await detail(o, o.lan, id);
    expect(after.messages.map((m) => m.body)).not.toContain('Bình luận đã bị gỡ');
    expect(after.messages.at(-1)).toMatchObject({ body: '', removed: true });
    // A removal for a thread never seen makes the thread, already resolved, with the tombstone; the add that follows stores no text.
    expect((await ingest(o, ch, [comment('r-none', 'Chữ đã bị gỡ', { messageId: 'm-none', removed: true })])).stored).toBe(1);
    const none = await threadOf(o, ch, 'r-none');
    expect((await detail(o, o.lan, none)).conversation.status).toBe('resolved');
    expect((await ingest(o, ch, [comment('r-none', 'Chữ đã bị gỡ', { messageId: 'm-none' })])).duplicates).toBe(1);
    expect((await detail(o, o.lan, none)).messages.map((m) => m.body)).toEqual(['']);
  });

  it("binds the platform's echo to the reply it follows and settles the reply's call", async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [{ ...comment('e-1', 'Alo', { kind: 'direct', postId: undefined }) }]);
    const id = await threadOf(o, ch, 'e-1');
    const { messageId } = await exec<{ messageId: string }>(o, o.owner, 'kernel.conversation.reply', { conversationId: id, body: 'Dạ vâng', lastSeenSeq: 1 });
    const call = await sys<{ callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    // An echo of the same words dated a day before the reply was written is not this reply's.
    await ingest(o, ch, [comment('e-1', 'Dạ vâng', { kind: 'direct', postId: undefined, direction: 'out', messageId: 'old-echo', at: new Date(Date.now() - 2 * 86_400_000).toISOString() })]);
    expect((await detail(o, o.owner, id)).messages.filter((m) => m.direction === 'out').map((m) => m.sendState)).toEqual(['sending', 'sent']);
    await ingest(o, ch, [comment('e-1', 'Dạ vâng', { kind: 'direct', postId: undefined, direction: 'out', messageId: 'platform-echo-2', at: new Date().toISOString() })]);
    const states = (await detail(o, o.owner, id)).messages.filter((m) => m.direction === 'out').map((m) => m.sendState);
    expect(states).toEqual(['sent', 'sent']);
    // The call row is finished, not left started.
    expect((await rows<{ state: string }>('SELECT state FROM crove_kernel.external_call WHERE org_id = $1 AND key = $2', [o.orgId, call.callKey]))[0]?.state).toBe('succeeded');
  });

  it('refuses to send an earlier reply again after a newer message, and a note with a NUL character as input', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('f-1', 'Alo', { kind: 'direct', postId: undefined })]);
    const id = await threadOf(o, ch, 'f-1');
    const { messageId } = await exec<{ messageId: string }>(o, o.owner, 'kernel.conversation.reply', { conversationId: id, body: 'Dạ', lastSeenSeq: 1 });
    const call = await sys<{ callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: call.callKey, result: { kind: 'rejected', error: 'transient', code: 'ZALO_5XX' } });
    await ingest(o, ch, [comment('f-1', 'Sao không trả lời?', { kind: 'direct', postId: undefined, at: new Date(Date.now() + 1000).toISOString() })]);
    await expect(exec(o, o.owner, 'kernel.conversation.reply_settle', { messageId, action: 'retry' })).rejects.toMatchObject({ code: 'CONVERSATION_MOVED' });
    await expect(exec(o, o.owner, 'kernel.conversation.note', { conversationId: id, body: 'a b' })).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a reply with a NUL character as input, not as a server error', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('n-1', 'Alo')]);
    const id = await threadOf(o, ch, 'n-1');
    await expect(exec(o, o.owner, 'kernel.conversation.reply', { conversationId: id, body: 'a b', lastSeenSeq: 1 })).rejects.toMatchObject({ status: 422 });
  });

  it('reads a comment thread like its channel, and a private message only as owners and admins', async () => {
    const o = await org();
    const chA = await connection(o);
    const chB = await connection(o);
    await ingest(o, chA, [comment('c-a', 'Kênh A')]);
    await ingest(o, chB, [comment('c-b', 'Kênh B', { contact: { id: 'u-9', name: 'Khách B' } })]);
    await ingest(o, chB, [comment('d-1', 'Nhắn riêng', { kind: 'direct', postId: undefined, contact: { id: 'u-7', name: 'Khách riêng' } })]);
    const texts = async (user: string) => (await listAll(o, user)).conversations.map((c) => c.preview).sort();
    // Owners and admins read everything; a member and a viewer read the comments but never the private message.
    expect(await texts(o.owner)).toEqual(['Kênh A', 'Kênh B', 'Nhắn riêng']);
    expect(await texts(o.admin)).toEqual(['Kênh A', 'Kênh B', 'Nhắn riêng']);
    expect(await texts(o.lan)).toEqual(['Kênh A', 'Kênh B']);
    expect(await texts(o.viewer)).toEqual(['Kênh A', 'Kênh B']);
    const direct = await threadOf(o, chB, 'd-1');
    await expect(detail(o, o.lan, direct)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(exec(o, o.lan, 'kernel.conversation.note', { conversationId: direct, body: 'x' })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    // The table itself says the same to a member context that bypasses the commands.
    const direct$ = await asApp(o.orgId, o.lan, async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation WHERE kind = $1', ['direct'])).rows[0].n);
    expect(direct$).toBe(0);
    const messages$ = await asApp(o.orgId, o.lan, async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation_message WHERE kind = $1', ['direct'])).rows[0].n);
    expect(messages$).toBe(0);
    // A member limited to channel A reads that channel's comments and no other's (owners and admins are never limited).
    await admin((c) => c.query('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.lan, chA, o.owner]));
    expect(await texts(o.lan)).toEqual(['Kênh A']);
    expect(await texts(o.minh)).toEqual(['Kênh A', 'Kênh B']);
    expect(await texts(o.admin)).toEqual(['Kênh A', 'Kênh B', 'Nhắn riêng']);
    const other = await threadOf(o, chB, 'c-b');
    await expect(detail(o, o.lan, other)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(exec(o, o.lan, 'kernel.conversation.reply', { conversationId: other, body: 'hi', lastSeenSeq: 1 })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    // A viewer reads and cannot answer, hide, resolve or note.
    const threadA = await threadOf(o, chA, 'c-a');
    for (const name of ['kernel.conversation.resolve', 'kernel.conversation.reopen']) {
      await expect(exec(o, o.viewer, name, { conversationId: threadA })).rejects.toMatchObject({ status: 403 });
    }
    await expect(exec(o, o.viewer, 'kernel.conversation.reply', { conversationId: threadA, body: 'hi', lastSeenSeq: 1 })).rejects.toMatchObject({ status: 403 });
    // Another org sees none of it.
    const stranger = await org();
    expect((await listAll(stranger, stranger.owner)).conversations).toEqual([]);
  });

  it('hides a comment through a call that may be repeated, and shows it again', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('c-1', 'Spam spam', { messageId: 'm-spam' })]);
    const id = await threadOf(o, ch, 'c-1');
    const messageId = (await detail(o, o.lan, id)).messages[0]?.id as string;
    await exec(o, o.lan, 'kernel.conversation.hide', { messageId, hidden: true });
    expect((await detail(o, o.lan, id)).messages[0]).toMatchObject({ hidden: false, hideRequest: 'hide' });
    const begin = () => sys<{ action: string; callKey?: string; hidden?: boolean; externalMessageId?: string }>(o, 'kernel.conversation.hide_begin', { messageId });
    const call = await begin();
    expect(call).toMatchObject({ action: 'call', hidden: true, externalMessageId: 'm-spam' });
    // The same hide is made again (idempotent on the platform): one call row, counted twice.
    expect((await begin()).action).toBe('call');
    expect(await rows("SELECT calls, retry_safety FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'hide'", [o.orgId])).toEqual([{ calls: 2, retry_safety: 'idempotent' }]);
    await sys(o, 'kernel.conversation.hide_record', { messageId, callKey: call.callKey, result: { kind: 'done' } });
    expect((await detail(o, o.lan, id)).messages[0]).toMatchObject({ hidden: true, hideRequest: null });
    expect(await begin()).toEqual({ action: 'none' });
    await exec(o, o.minh, 'kernel.conversation.hide', { messageId, hidden: false });
    const undo = await begin();
    expect(undo).toMatchObject({ action: 'call', hidden: false });
    await sys(o, 'kernel.conversation.hide_record', { messageId, callKey: undo.callKey, result: { kind: 'rejected', error: 'permission', code: 'NO_RIGHT' } });
    // Refused: still hidden, and the screen says why.
    expect((await detail(o, o.lan, id)).messages[0]).toMatchObject({ hidden: true, hideRequest: null, hideErrorCode: 'NO_RIGHT' });
    // Only a customer's comment can be hidden.
    const { messageId: out } = await exec<{ messageId: string }>(o, o.lan, 'kernel.conversation.reply', { conversationId: id, body: 'ok', lastSeenSeq: 1 });
    await expect(exec(o, o.lan, 'kernel.conversation.hide', { messageId: out, hidden: true })).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
  });

  it('works a thread: assign, note, link a contact, read marks, resolve, reopen, and the counts', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('c-1', 'Một'), comment('c-2', 'Hai', { contact: { id: 'u-2', name: 'Khách hai' } })]);
    const id = await threadOf(o, ch, 'c-1');
    expect(await query<ConversationCounted>(o, o.lan, 'kernel.conversation.counts', {})).toEqual({ new: 2, pending: 0, resolved: 0, unread: 2 });
    await exec(o, o.lan, 'kernel.conversation.mark_read', { conversationId: id, seq: 1 });
    expect(await query<ConversationCounted>(o, o.lan, 'kernel.conversation.counts', {})).toMatchObject({ unread: 1 });
    // A viewer cannot be given a thread, nor someone limited away from its channel.
    await expect(exec(o, o.owner, 'kernel.conversation.assign', { conversationId: id, assigneeUserId: o.viewer })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ALLOWED' });
    await exec(o, o.owner, 'kernel.conversation.assign', { conversationId: id, assigneeUserId: o.minh });
    expect((await listAll(o, o.minh, { assignee: 'me' })).conversations.map((c) => c.id)).toEqual([id]);
    expect((await listAll(o, o.minh, { assignee: 'none' })).conversations).toHaveLength(1);
    const { noteId } = await exec<{ noteId: string }>(o, o.minh, 'kernel.conversation.note', { conversationId: id, body: SECRET_TEXT });
    expect((await detail(o, o.viewer, id)).notes).toEqual([{ id: noteId, authorUserId: o.minh, body: SECRET_TEXT, createdAt: expect.any(String) }]);
    // Linking a contact is a person's decision, and holds for the customer's other threads.
    const party = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Khách')", [o.orgId, party]));
    await exec(o, o.lan, 'kernel.conversation.link_contact', { conversationId: id, partyId: party });
    expect((await detail(o, o.lan, id)).conversation.contact).toMatchObject({ partyId: party, partyName: 'Công ty Khách' });
    await ingest(o, ch, [comment('c-3', 'Ba lần', { messageId: 'm-3' })]);
    expect((await detail(o, o.lan, await threadOf(o, ch, 'c-3'))).conversation.contact.partyId).toBe(party);
    await expect(exec(o, o.lan, 'kernel.conversation.link_contact', { conversationId: id, partyId: randomUUID() })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    await exec(o, o.lan, 'kernel.conversation.resolve', { conversationId: id });
    expect((await listAll(o, o.lan, { status: 'resolved' })).conversations.map((c) => c.id)).toEqual([id]);
    await exec(o, o.lan, 'kernel.conversation.reopen', { conversationId: id });
    expect((await detail(o, o.lan, id)).conversation.status).toBe('new');
    // Paging: newest first, the key is the last thread of the page.
    const first = await listAll(o, o.lan, { limit: 2 });
    expect(first).toMatchObject({ more: true });
    const last = first.conversations.at(-1);
    const next = await listAll(o, o.lan, { limit: 2, before: { at: last?.lastMessageAt ?? null, id: last?.id } });
    expect(next.conversations).toHaveLength(1);
    expect(new Set([...first.conversations, ...next.conversations].map((c) => c.id)).size).toBe(3);
  });

  it('keeps customer text out of audit rows and events', async () => {
    const o = await org();
    const ch = await connection(o);
    await ingest(o, ch, [comment('c-1', SECRET_TEXT)]);
    const id = await threadOf(o, ch, 'c-1');
    await exec(o, o.lan, 'kernel.conversation.note', { conversationId: id, body: SECRET_TEXT });
    const { messageId } = await exec<{ messageId: string }>(o, o.lan, 'kernel.conversation.reply', { conversationId: id, body: SECRET_TEXT, lastSeenSeq: 1 });
    await exec(o, o.lan, 'kernel.conversation.hide', { messageId: (await detail(o, o.lan, id)).messages[0]?.id, hidden: true });
    const begin = await sys<{ callKey: string }>(o, 'kernel.conversation.reply_begin', { messageId });
    await sys(o, 'kernel.conversation.reply_record', { messageId, callKey: begin.callKey, result: { kind: 'rejected', error: 'bad_request', code: SECRET_TEXT } });
    for (const needle of ['0912345678', 'Nguyễn Văn Mẫu', 'Trần Thị Khách']) {
      const audit = await rows('SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND (detail::text ILIKE $2 OR target_id::text ILIKE $2)', [o.orgId, `%${needle}%`]);
      expect(audit, `audit rows hold ${needle}`).toHaveLength(0);
      const events = await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text ILIKE $2', [o.orgId, `%${needle}%`]);
      expect(events, `events hold ${needle}`).toHaveLength(0);
      const calls = await rows('SELECT 1 FROM crove_kernel.external_call WHERE org_id = $1 AND (key ILIKE $2 OR error_code ILIKE $2 OR external_ref ILIKE $2)', [o.orgId, `%${needle}%`]);
      expect(calls, `call rows hold ${needle}`).toHaveLength(0);
    }
    // What a reply queues names ids only.
    const queued = await rows<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.reply_queued'", [o.orgId]);
    expect(queued).toHaveLength(1);
    expect(Object.keys(queued[0]?.payload ?? {}).sort()).toEqual(['connectionId', 'conversationId', 'messageId']);
  });

  it('makes a demo comment only for a sandbox connection, for owners and admins', async () => {
    const o = await org();
    const ch = await connection(o);
    const real = await connection(o, 'facebook_page');
    const made = await exec<{ accountId: string; events: ConversationEvent[] }>(o, o.admin, 'kernel.conversation.sandbox_comment', { connectionId: ch, postId: 'post-9', text: 'Bình luận thử' });
    expect(made.events).toHaveLength(1);
    expect(made.events[0]).toMatchObject({ kind: 'comment_thread', postId: 'post-9', direction: 'in', text: 'Bình luận thử', contact: { name: 'Khách thử nghiệm' } });
    // It is only an event: nothing is stored until the intake takes it.
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [o.orgId])).toHaveLength(0);
    expect(await ingest(o, ch, made.events)).toEqual({ stored: 1, duplicates: 0, ignored: 0 });
    await expect(exec(o, o.lan, 'kernel.conversation.sandbox_comment', { connectionId: ch, postId: 'p', text: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.owner, 'kernel.conversation.sandbox_comment', { connectionId: real, postId: 'p', text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
  });

  it('parks webhook notices for the worker alone: lease, finish, drop a poison notice, find the connections', async () => {
    const o = await org();
    const ch = await connection(o);
    const accountId = (await rows<{ external_account_id: string }>('SELECT external_account_id FROM crove_kernel.channel_connection WHERE id = $1', [ch]))[0]?.external_account_id as string;
    const asRole = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    };
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    // Only the API's login enqueues; only the worker's claims, finishes and finds connections; neither reads the table.
    const seq = await asRole(appUrl, async (c) => (await c.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2) AS seq', ['sandbox', Buffer.from('{"v":1}')])).rows[0].seq);
    await expect(asRole(appUrl, (c) => c.query('SELECT * FROM crove_kernel.conversation_inbound_claim(10, 60)'))).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(workerUrl.toString(), (c) => c.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2)', ['sandbox', Buffer.from('x')]))).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(appUrl, (c) => c.query('SELECT * FROM crove_kernel.conversation_inbound_pending'))).rejects.toMatchObject({ code: '42501' });
    // Neither login role reads or writes the table itself, whatever the statement: only the definers above touch it.
    for (const url of [appUrl, workerUrl.toString()]) {
      for (const statement of [
        'SELECT * FROM crove_kernel.conversation_inbound_pending',
        "INSERT INTO crove_kernel.conversation_inbound_pending (provider, body) VALUES ('sandbox', 'x'::bytea)",
        "UPDATE crove_kernel.conversation_inbound_pending SET attempts = 0",
        'DELETE FROM crove_kernel.conversation_inbound_pending',
        'TRUNCATE crove_kernel.conversation_inbound_pending',
      ]) {
        await expect(asRole(url, (c) => c.query(statement)), statement).rejects.toMatchObject({ code: '42501' });
      }
    }
    const claim = () => asRole(workerUrl.toString(), async (c) => (await c.query('SELECT seq, provider, body, attempts, dropped, reason FROM crove_kernel.conversation_inbound_claim(10, 60)')).rows);
    const first = await claim();
    expect(first).toEqual([{ seq, provider: 'sandbox', body: Buffer.from('{"v":1}'), attempts: 1, dropped: false, reason: null }]);
    // Leased: a second worker finds nothing until the lease passes.
    expect(await claim()).toEqual([]);
    for (let attempt = 2; attempt <= 5; attempt++) {
      await admin((c) => c.query("UPDATE crove_kernel.conversation_inbound_pending SET claimed_until = now() - interval '1 second' WHERE seq = $1", [seq]));
      expect(await claim()).toMatchObject([{ attempts: attempt, dropped: false }]);
    }
    // Claimed five times and never finished: dropped with its body, so one poison notice never blocks the rest.
    await admin((c) => c.query("UPDATE crove_kernel.conversation_inbound_pending SET claimed_until = now() - interval '1 second' WHERE seq = $1", [seq]));
    expect(await claim()).toEqual([{ seq, provider: 'sandbox', body: null, attempts: 5, dropped: true, reason: 'poison' }]);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).toHaveLength(0);
    const next = await asRole(appUrl, async (c) => (await c.query('SELECT crove_kernel.conversation_inbound_enqueue($1, $2) AS seq', ['sandbox', Buffer.from('{}')])).rows[0].seq);
    await asRole(workerUrl.toString(), (c) => c.query('SELECT crove_kernel.conversation_inbound_done($1)', [next]));
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).toHaveLength(0);
    // Where a notice goes: the active connections of active orgs that name the platform's own account id.
    const found = await asRole(workerUrl.toString(), async (c) => (await c.query('SELECT org_id, connection_id FROM crove_kernel.conversation_connections_for($1, $2)', ['sandbox', accountId])).rows);
    expect(found).toEqual([{ org_id: o.orgId, connection_id: ch }]);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [ch]));
    expect(await asRole(workerUrl.toString(), async (c) => (await c.query('SELECT 1 FROM crove_kernel.conversation_connections_for($1, $2)', ['sandbox', accountId])).rows)).toEqual([]);
  });
});
