// SPDX-License-Identifier: AGPL-3.0-only
// The one MCP write (#3227, step 3; owner decision 2026-11-14): `social.mcp.draft_create` as the runtime runs it for a company grant that holds `ludy.social.draft`. The draft is an AI post made
// over MCP (origin ai, actor_origin mcp, tainted, author the consenting user), a draft with draft channels, in the review queue's AI list, and nobody's approval is skipped. The refusal pins (no other
// command runs for the grant, a grant without the scope cannot run this one, who may consent to the scope) are in test/invariant/mcp-draft-runtime.db.test.ts; this file keeps the draft's behavior:
// what it creates, where it shows, the person's own limits, the audit row, the strict channel and the signature. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Created {
  postId: string;
  revision: number;
  variants: Array<{ variantId: string; connectionId: string }>;
}

suite('the MCP draft command (#3227)', () => {
  const dbName = `crove_test_social_mcp_draft_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', memberA: '', ownerB: '' };
  const conns = { a1: '', a2: '', b1: '' };

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string, scopes: readonly string[]): UserActor => ({ type: 'user', userId, aal: 'aal1', mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function insertGrant(orgId: string, userId: string, scopes: string[] = ['ludy.read', 'ludy.social.draft']) {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', $6::text[], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`, scopes],
      ),
    );
    return id;
  }

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  async function channel(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  const grantActor = async (org = orgA, owner = users.ownerA, scopes: string[] = ['ludy.read', 'ludy.social.draft']) => ({ actor: mcp(owner, await insertGrant(org, owner, scopes), scopes), orgId: org });
  const draft = async (input: unknown, ctx?: { actor: UserActor; orgId: string }) => runtime.execute<Created>('social.mcp.draft_create', input, ctx ?? (await grantActor()));
  const row = (postId: string) => admin(async (c) => (await c.query('SELECT * FROM crove_social.post WHERE id = $1', [postId])).rows[0]);
  const variantRows = (postId: string) => admin(async (c) => (await c.query('SELECT * FROM crove_social.post_variant WHERE post_id = $1 ORDER BY position', [postId])).rows);

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...socialQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'social-mcp-draft', subject: key, email: `${key}@social-mcp-draft.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]));
    conns.a1 = await channel(orgA, users.ownerA, 'Trang Facebook A');
    conns.a2 = await channel(orgA, users.ownerA, 'Kênh thứ hai');
    conns.b1 = await channel(orgB, users.ownerB, 'Kênh của tổ chức B');
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('creates an AI draft over MCP: origin ai, actor_origin mcp, tainted, a draft by the consenting user, with a draft channel for each channel asked', async () => {
    const planned = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const made = await draft({ body: 'Khuyến mãi tháng 12', title: 'Giảm giá', linkUrl: 'https://example.com/sale', scheduledAt: planned, channels: [{ connectionId: conns.a1 }, { connectionId: conns.a2, body: 'Bản riêng' }] });
    expect(made.revision).toBe(1);
    expect(made.variants.map((v) => v.connectionId)).toEqual([conns.a1, conns.a2]);
    const post = await row(made.postId);
    expect(post).toMatchObject({ org_id: orgA, origin: 'ai', actor_origin: 'mcp', tainted: true, status: 'draft', author_user_id: users.ownerA, body: 'Khuyến mãi tháng 12', title: 'Giảm giá', archived_at: null, assignee_user_id: null });
    expect(new Date(post.scheduled_at).toISOString()).toBe(planned);
    const variants = await variantRows(made.postId);
    expect(variants.map((v) => [v.status, v.published_at, v.scheduled_at, v.review_since, v.body])).toEqual([
      ['draft', null, null, null, null],
      ['draft', null, null, null, 'Bản riêng'],
    ]);
  });

  it('puts the draft where a person finds it: the review queue\'s AI list, marked AI, tainted and from MCP, and in the posts list', async () => {
    const made = await draft({ body: 'Bài soạn qua MCP', channels: [{ connectionId: conns.a1 }] });
    const read = await grantActor(orgA, users.ownerA, ['ludy.read']);
    const queue = await runtime.query<{ aiDrafts: Array<{ id: string; origin: string; actorOrigin: string; tainted: boolean; status: string }>; inReview: unknown[] }>('social.mcp.review_queue', { limit: 50 }, read);
    expect(queue.aiDrafts.find((p) => p.id === made.postId)).toMatchObject({ origin: 'ai', actorOrigin: 'mcp', tainted: true, status: 'draft' });
    expect(queue.inReview).toEqual([]);
    const listed = await runtime.query<{ posts: Array<{ id: string }> }>('social.mcp.posts', { status: 'draft', limit: 50 }, read);
    expect(listed.posts.some((p) => p.id === made.postId)).toBe(true);
    // The owner sees it in the app too, as the AI's drafts show.
    const seen = await runtime.query<Array<{ id: string; origin: string; tainted: boolean }>>('social.post.list', { stage: 'drafts', limit: 200 }, { actor: browser(users.ownerA), orgId: orgA });
    expect(seen.find((p) => p.id === made.postId)).toMatchObject({ origin: 'ai', tainted: true });
  });

  it('refuses a revoked grant, another org\'s channel and anything outside the person\'s own limits, with the same codes', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const ctx = { actor: mcp(users.ownerA, grant, ['ludy.read', 'ludy.social.draft']), orgId: orgA };
    await admin((c) => c.query('UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1', [grant]));
    expect([(await refusal(draft({ body: 'x', channels: [{ connectionId: conns.a1 }] }, ctx))).status]).toEqual([401]);
    expect((await refusal(draft({ body: 'x', channels: [{ connectionId: conns.b1 }] }))).code).toBe('CHANNEL_NOT_FOUND');
    expect((await refusal(draft({ body: 'x', channels: [{ connectionId: conns.a1 }, { connectionId: conns.a1 }] }))).code).toBe('CHANNEL_ALREADY_IN_POST');
    for (const bad of [
      { body: 'x'.repeat(100_001), channels: [{ connectionId: conns.a1 }] },
      { body: 'x', title: 'y'.repeat(501), channels: [{ connectionId: conns.a1 }] },
      { body: 'x', channels: [] },
      { body: 'x', channels: Array.from({ length: 21 }, () => ({ connectionId: randomUUID() })) },
    ]) {
      expect((await refusal(draft(bad))).status).toBe(422);
    }
    // What only the server sets cannot be sent: the AI mark, the actor, the taint, the idea, media, an org.
    for (const extra of [{ origin: 'human' }, { actorOrigin: 'ui' }, { tainted: false }, { aiAssisted: true }, { ideaId: randomUUID() }, { media: [] }, { orgId: orgB }, { status: 'approved' }]) {
      expect((await refusal(draft({ body: 'x', channels: [{ connectionId: conns.a1 }], ...extra }))).status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('audits the call as the grant\'s, not as the person\'s own click', async () => {
    const ctx = await grantActor();
    const made = await draft({ body: 'Có dấu vết', channels: [{ connectionId: conns.a1 }] }, ctx);
    const audited = await admin(async (c) => (await c.query("SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.mcp.draft_create' AND outcome = 'ok' ORDER BY occurred_at DESC LIMIT 1", [orgA])).rows[0]);
    expect(audited).toMatchObject({ actor_type: 'user', actor_id: users.ownerA });
    expect(audited.detail).toMatchObject({ mcpCall: true, mcpGrant: ctx.actor.mcp?.grantId, post_id: made.postId, origin: 'ai', actor_origin: 'mcp' });
  });

  it('takes a channel as its connection, its own text and its own title and nothing else: no media, settings or link of its own', async () => {
    const base = { body: 'Chỉ có chữ', channels: [{ connectionId: conns.a1 }] };
    const extras: Array<Record<string, unknown>> = [
      { settings: { removeAt: '2030-01-01T00:00:00Z', firstComment: 'bình luận' } },
      { media: [{ fileId: randomUUID() }] },
      { linkUrl: 'https://example.com/z' },
    ];
    for (const extra of extras) {
      const bad = await refusal(draft({ ...base, channels: [{ connectionId: conns.a1, ...extra }] }));
      expect([bad.status, bad.code], JSON.stringify(extra)).toEqual([422, expect.any(String)]);
    }
    const ok = await draft({ ...base, channels: [{ connectionId: conns.a1, body: 'Riêng', title: 'Tiêu đề riêng' }] });
    const [v] = await variantRows(ok.postId);
    expect(v).toMatchObject({ body: 'Riêng', title: 'Tiêu đề riêng', status: 'draft' });
  });

  it('copies the channel\'s default signature into the draft\'s channel like any post, and the database lets that one setting in', async () => {
    const conn = await channel(orgA, users.ownerA, 'Kênh có chữ ký');
    await runtime.execute('social.channel.set_signature', { connectionId: conn, signature: 'Hotline 0900 000 000' }, { actor: browser(users.ownerA), orgId: orgA });
    const made = await draft({ body: 'Bài có chữ ký', channels: [{ connectionId: conn }] });
    const [v] = await variantRows(made.postId);
    expect(v).toMatchObject({ status: 'draft', settings: { signature: 'Hotline 0900 000 000' } });
  });
});
