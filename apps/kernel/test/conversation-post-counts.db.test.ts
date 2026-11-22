// SPDX-License-Identifier: AGPL-3.0-only
// The unanswered comment counts of a screen's posts on PostgreSQL 17 (#3298, plan docs/plan/conversations.md section 11): `kernel.conversation.post_counts` counts the
// comment threads still New under each (channel, platform post) pair in one grouped read, by the reader's own rule (a member limited to other channels sees none of
// this channel's), leaves out a post with none, and returns ids and a number only. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CONVERSATION_POST_COUNTS_MAX, zConversationPostCounts, type ConversationEvent, type ConversationPostCounted } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

suite('unanswered comment counts for a screen of posts (#3298)', () => {
  const dbName = `crove_test_post_counts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
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
  async function admin<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.end();
    }
  }
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@counts.test`, name: null }) as Promise<string>;

  type Org = { orgId: string; owner: string; limited: string; connectionId: string; otherId: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const limited = await person('limited');
    await admin("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, limited]);
    const [connectionId, otherId] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[connectionId, 'Kênh chính'], [otherId, 'Kênh khác']] as const) {
      await admin("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, $4, $5)", [orgId, id, `acct-${randomUUID().slice(0, 8)}`, name, owner]);
    }
    // The member is limited to the other channel: this channel's threads are not theirs.
    await admin('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, limited, otherId, owner]);
    return { orgId, owner, limited, connectionId, otherId };
  }
  let tick = 0;
  const comment = (threadId: string, postId: string): ConversationEvent => ({
    kind: 'comment_thread',
    threadId,
    postId,
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: `u-${threadId}`, name: `Khách ${threadId}` },
    text: `Bình luận ${threadId}`,
    at: new Date(Date.now() - 600_000 + tick * 1000).toISOString(),
  });
  const direct = (threadId: string): ConversationEvent => ({ kind: 'direct', threadId, messageId: `m-${threadId}-${tick++}`, direction: 'in', contact: { id: `u-${threadId}`, name: 'Khách' }, text: 'Nhắn riêng', at: new Date(Date.now() - 600_000 + tick * 1000).toISOString() });
  const ingest = (o: Org, events: ConversationEvent[], connectionId = o.connectionId) => worker.execute('kernel.conversation.ingest', { connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const threadOf = async (o: Org, external: string) => ((await admin<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, external]))[0] as { id: string }).id;
  const counts = (o: Org, user: string, posts: Array<{ connectionId: string; externalPostId: string }>) =>
    rt.query<ConversationPostCounted>('kernel.conversation.post_counts', { posts }, { actor: asUser(user), orgId: o.orgId });
  const byPost = (r: ConversationPostCounted) => Object.fromEntries(r.counts.map((c) => [c.externalPostId, c.unanswered]));

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: ADMIN as string });
    await c.connect();
    await c.query(`CREATE DATABASE ${dbName}`);
    await c.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    pool = createPool({ connectionString: urlFor('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: urlFor('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  });

  it('counts the New comment threads of each post in one read, leaves out posts with none, and ignores resolved threads and private messages', async () => {
    const o = await org();
    await ingest(o, [comment('a1', 'post-a'), comment('a2', 'post-a'), comment('a3', 'post-a'), comment('b1', 'post-b'), comment('c1', 'post-c'), direct('d1')]);
    await rt.execute('kernel.conversation.resolve', { conversationId: await threadOf(o, 'a3') }, { actor: asUser(o.owner), orgId: o.orgId });
    await rt.execute('kernel.conversation.resolve', { conversationId: await threadOf(o, 'c1') }, { actor: asUser(o.owner), orgId: o.orgId });
    const posts = ['post-a', 'post-b', 'post-c', 'post-none'].map((externalPostId) => ({ connectionId: o.connectionId, externalPostId }));
    const got = await counts(o, o.owner, posts);
    expect(got.counts.map((c) => [c.externalPostId, c.unanswered]).sort()).toEqual([
      ['post-a', 2],
      ['post-b', 1],
    ]);
    // Ids and a number only: nothing of the customer's words or names.
    expect(JSON.stringify(got)).not.toMatch(/Bình luận|Khách/);
    expect(byPost(got)).toEqual({ 'post-a': 2, 'post-b': 1 });
    // A thread reopened with the customer's message last is New again, so it counts again.
    await rt.execute('kernel.conversation.reopen', { conversationId: await threadOf(o, 'a3') }, { actor: asUser(o.owner), orgId: o.orgId });
    const again = await counts(o, o.owner, posts);
    expect(byPost(again)).toEqual({ 'post-a': 3, 'post-b': 1 });
  });

  it('keeps a post of one channel apart from the same platform post id on another channel', async () => {
    const o = await org();
    await ingest(o, [comment('x1', 'shared')]);
    await ingest(o, [comment('y1', 'shared'), comment('y2', 'shared')], o.otherId);
    const got = await counts(o, o.owner, [
      { connectionId: o.connectionId, externalPostId: 'shared' },
      { connectionId: o.otherId, externalPostId: 'shared' },
    ]);
    const mine = got.counts.find((c) => c.connectionId === o.connectionId);
    const theirs = got.counts.find((c) => c.connectionId === o.otherId);
    expect(mine?.unanswered).toBe(1);
    expect(theirs?.unanswered).toBe(2);
  });

  it("is the reader's own number: a member limited to another channel sees none of this channel's threads", async () => {
    const o = await org();
    await ingest(o, [comment('p1', 'post-p'), comment('p2', 'post-p')]);
    await ingest(o, [comment('q1', 'post-q')], o.otherId);
    const posts = [
      { connectionId: o.connectionId, externalPostId: 'post-p' },
      { connectionId: o.otherId, externalPostId: 'post-q' },
    ];
    expect((await counts(o, o.owner, posts)).counts).toHaveLength(2);
    const limited = await counts(o, o.limited, posts);
    expect(limited.counts).toEqual([{ connectionId: o.otherId, externalPostId: 'post-q', unanswered: 1 }]);
  });

  it('refuses an empty list and more posts than one read allows, and asks the database once for a repeated post', async () => {
    const one = { connectionId: randomUUID(), externalPostId: 'p' };
    expect(zConversationPostCounts.safeParse({ posts: [] }).success).toBe(false);
    expect(zConversationPostCounts.safeParse({ posts: Array.from({ length: CONVERSATION_POST_COUNTS_MAX + 1 }, (_, i) => ({ ...one, externalPostId: `p${i}` })) }).success).toBe(false);
    expect(zConversationPostCounts.safeParse({ posts: [one, one] }).success).toBe(true);
    const o = await org();
    await ingest(o, [comment('r1', 'post-r')]);
    const ref = { connectionId: o.connectionId, externalPostId: 'post-r' };
    expect((await counts(o, o.owner, [ref, ref, ref])).counts).toEqual([{ connectionId: o.connectionId, externalPostId: 'post-r', unanswered: 1 }]);
  });
});
