// SPDX-License-Identifier: AGPL-3.0-only
// What the runtime lets an MCP grant do with the one MCP write command (#3227, step 3; owner decision 2026-11-14), as the base copy of the suite will hold it:
// - a grant that holds `ludy.social.draft` runs that one command and no other: every Social command that approves, submits, schedules, edits, cancels, archives or creates for a person, and the
//   grant approval, is refused with rule `mcp_scope`, and nothing it tried changed the draft;
// - only an owner or admin can consent to the scope, as a company grant; a read-only consent stays read-only, and no member grant can hold it;
// - a grant that holds only `ludy.read`, a browser session, a member's grant and a claim of the scope the database row does not hold cannot run the draft, and a refusal of a company grant is
//   audited as the grant's call.
// Part of the invariant suite; the fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Created {
  postId: string;
  revision: number;
  variants: Array<{ variantId: string; connectionId: string }>;
}

suite('the MCP draft command is the only write an MCP grant has (#3227)', () => {
  const dbName = `crove_test_mcp_draft_runtime_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      users[key] = await upsertIdentity(db, { issuer: 'mcp-draft-runtime', subject: key, email: `${key}@mcp-draft-runtime.test`, name: null });
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

  it('runs the draft for a grant that holds the scope, and no other command, whatever it names', async () => {
    const ctx = await grantActor();
    const made = await draft({ body: 'Chờ người duyệt', channels: [{ connectionId: conns.a1 }] }, ctx);
    const variantId = made.variants[0]?.variantId as string;
    const attempts: Array<[string, unknown]> = [
      ['social.post.submit', { postId: made.postId }],
      ['social.variant.decide', { postId: made.postId, decision: 'approved', variants: [{ variantId, revision: 1, contentHash: `sha256:${'a'.repeat(64)}` }] }],
      ['social.variant.schedule', { postId: made.postId, variantIds: [variantId], at: new Date(Date.now() + 86_400_000).toISOString() }],
      ['social.variant.cancel', { variantIds: [variantId] }],
      ['social.post.update', { postId: made.postId, revision: 1, body: 'đổi' }],
      ['social.post.archive', { postId: made.postId }],
      ['social.post.create', { body: 'Người soạn', channels: [{ connectionId: conns.a1 }] }],
      ['kernel.mcp.grant.approve', { clientId: 'c', clientName: 'c', clientHost: 'c.example.com', scopes: ['ludy.read'], oauthGrantId: 'g' }],
    ];
    for (const [name, input] of attempts) {
      const refused = await refusal(runtime.execute(name, input, ctx));
      expect([refused.status, refused.details], name).toEqual([403, expect.objectContaining({ rule: 'mcp_scope' })]);
    }
    const [v] = await variantRows(made.postId);
    expect(v).toMatchObject({ status: 'draft', published_at: null });
    expect((await row(made.postId)).status).toBe('draft');
  });

  it('refuses the draft to a grant with only the read scope, a browser session, a member\'s grant and a forged claim, and audits a company grant\'s refusal as its own', async () => {
    const input = { body: 'x', channels: [{ connectionId: conns.a1 }] };
    const readOnlyCtx = await grantActor(orgA, users.ownerA, ['ludy.read']);
    const readOnly = await refusal(draft(input, readOnlyCtx));
    expect([readOnly.status, readOnly.details]).toEqual([403, expect.objectContaining({ rule: 'mcp_scope' })]);
    const denied = await admin((c) => c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.mcp.draft_create' AND outcome = 'denied' AND detail ->> 'mcpGrant' = $2`, [orgA, readOnlyCtx.actor.mcp?.grantId]));
    expect(denied.rowCount).toBe(1);
    expect(denied.rows[0].detail).toMatchObject({ mcpCall: true, mcpClient: 'client-1', mcpClientName: 'Test client' });
    expect((await refusal(draft(input, { actor: browser(users.ownerA), orgId: orgA }))).status).toBe(403);
    const memberGrant = await insertGrant(orgA, users.memberA);
    expect((await refusal(draft(input, { actor: mcp(users.memberA, memberGrant, ['ludy.read', 'ludy.social.draft']), orgId: orgA }))).status).toBe(401);
    const forged = await refusal(draft(input, { actor: mcp(users.ownerA, await insertGrant(orgA, users.ownerA, ['ludy.read']), ['ludy.read', 'ludy.social.draft']), orgId: orgA }));
    expect([forged.status, forged.details]).toEqual([403, expect.objectContaining({ rule: 'mcp_scope' })]);
    // None of those left a post behind.
    expect((await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_social.post WHERE org_id = $1 AND body = 'x'`, [orgA]))).rows[0].n).toBe(0);
  });

  it('is the one door to the scope: only an owner or admin can consent to it, as a company grant, and no member grant can hold it', async () => {
    const approve = (userId: string, input: Record<string, unknown>) =>
      runtime.execute<{ grantId: string }>('kernel.mcp.grant.approve', { clientId: `c-${randomUUID()}`, clientName: 'Client', clientHost: 'client.example.com', oauthGrantId: `g-${randomUUID()}`, ...input }, { actor: browser(userId), orgId: orgA });
    const scopesOf = async (id: string) => (await admin((c) => c.query('SELECT scopes, kind FROM crove_kernel.agent_grant WHERE id = $1', [id]))).rows[0] as { scopes: string[]; kind: string };
    for (const who of [users.ownerA, users.adminA]) {
      const made = await approve(who, { scopes: ['ludy.read', 'ludy.social.draft'] });
      expect(await scopesOf(made.grantId)).toEqual({ scopes: ['ludy.read', 'ludy.social.draft'], kind: 'company' });
    }
    // A read-only consent never gains the scope: it stays what it asked for.
    expect((await scopesOf((await approve(users.ownerA, { scopes: ['ludy.read'] })).grantId)).scopes).toEqual(['ludy.read']);
    // A plain member cannot make a company grant, and a member-bound grant cannot hold the scope or a company grant the member scope.
    expect((await refusal(approve(users.memberA, { scopes: ['ludy.read', 'ludy.social.draft'] }))).status).toBe(403);
    expect([403, 422]).toContain((await refusal(approve(users.memberA, { kind: 'member', scopes: ['ludy.member.read', 'ludy.social.draft'] }))).status);
    expect([403, 422]).toContain((await refusal(approve(users.ownerA, { kind: 'member', scopes: ['ludy.social.draft'] }))).status);
    expect((await refusal(approve(users.ownerA, { scopes: ['ludy.member.read'] }))).status).toBe(422);
  });
});
