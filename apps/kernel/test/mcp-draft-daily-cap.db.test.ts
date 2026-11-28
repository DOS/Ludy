// SPDX-License-Identifier: AGPL-3.0-only
// The database-backed daily cap on the drafts an MCP grant makes (#3253, follow-up of #3227): `ludy_kernel.mcp_drafts_charge` and the `ludy_social_draft_create` tool that takes it. A grant may make
// only so many drafts a UTC day, and all the grants of an org together only so many, however slowly it asks and however many API instances it asks; a refusal says it starts again at midnight UTC.
// This test pins the cap, the new day, the org's sum (a revoked grant still counts, so connecting the app again does not start the day over), a revoked grant, and that calls at once cannot pass the
// caps. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { socialCommands, socialQueries } from '@ludy/mod-social';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { toolsFor } from '../src/mcp-endpoint.ts';
import { McpWriteBudget } from '../src/mcp-write-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SCOPES = ['ludy.read', 'ludy.social.draft'];

suite('the daily cap on MCP drafts (#3253)', () => {
  const dbName = `ludy_test_mcp_draft_cap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let db: ReturnType<typeof createDb>;
  // Each org has an owner of its own: one person may create only 5 orgs a day.
  const ownerOf = new Map<string, string>();
  let seq = 0;

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A fresh org with one sandbox channel, so each test has its own counters.
  async function freshOrg(name: string) {
    const owner = await upsertIdentity(db, { issuer: 'mcp-draft-cap', subject: `owner-${seq++}`, email: `owner-${seq}@mcp-draft-cap.test`, name: null });
    const orgId = (await createOrg(runtime, browser(owner), name)).orgId;
    ownerOf.set(orgId, owner);
    const connectionId = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, connectionId, 'sandbox', `acct-${connectionId.slice(0, 8)}`, 'Kênh thử', owner]),
    );
    return { orgId, connectionId };
  }

  // One grant of the org's owner. The live-grant index allows one per client, so each grant has its own client.
  async function grantOf(orgId: string) {
    const owner = ownerOf.get(orgId) as string;
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', $6::text[], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, owner, `oauth-${id}`, `client-${id}`, SCOPES],
      ),
    );
    return id;
  }

  // The draft tool as the endpoint builds it for a grant, with its own minute budget (the burst of six is never what these tests reach) and the caps under test.
  function draftTool(orgId: string, grantId: string, caps: { perGrant: number; perOrg: number }) {
    const actor: UserActor = { type: 'user', userId: ownerOf.get(orgId) as string, aal: 'aal1', mcp: { grantId, clientId: `client-${grantId}`, clientName: 'Test client', scopes: SCOPES, kind: 'company' } };
    const tool = toolsFor(runtime, actor, orgId, new DraftBudget(), new McpWriteBudget(), caps).find((t) => t.name === 'ludy_social_draft_create');
    if (!tool) throw new Error('the draft tool is not listed');
    return (connectionId: string) => tool.read({ body: 'Bản nháp do ứng dụng AI soạn', channels: [{ connectionId }] });
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

  const drafts = async (orgId: string) => Number((await admin((c) => c.query(`SELECT count(*) AS n FROM ludy_social.post WHERE org_id = $1 AND actor_origin = 'mcp'`, [orgId]))).rows[0].n);
  const counter = async (orgId: string, grantId: string) =>
    (await admin((c) => c.query(`SELECT drafts_day::text AS day, drafts_used AS used, (now() AT TIME ZONE 'UTC')::date::text AS today FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgId, grantId]))).rows[0] as {
      day: string | null;
      used: number;
      today: string;
    };

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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 8 });
    pools.push(pool);
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...socialQueries] });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('makes drafts up to the grant\'s cap, then refuses as rate limited with the seconds to midnight UTC and makes no more', async () => {
    const { orgId, connectionId } = await freshOrg('Cap grant');
    const grantId = await grantOf(orgId);
    const make = draftTool(orgId, grantId, { perGrant: 3, perOrg: 100 });
    for (let i = 0; i < 3; i += 1) await make(connectionId);
    expect(await drafts(orgId)).toBe(3);
    const refused = await refusal(make(connectionId));
    expect(refused).toMatchObject({ code: 'RATE_LIMITED', status: 429, details: { what: 'daily_drafts' } });
    const wait = (refused.details as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(86_400);
    // Still refused, and nothing was made, however often it asks.
    await refusal(make(connectionId));
    expect(await drafts(orgId)).toBe(3);
    const c = await counter(orgId, grantId);
    expect(c).toMatchObject({ used: 3, day: c.today });
  });

  it('holds across API instances and restarts: a second tool with its own empty minute budget meets the same counter', async () => {
    const { orgId, connectionId } = await freshOrg('Cap instances');
    const grantId = await grantOf(orgId);
    await draftTool(orgId, grantId, { perGrant: 2, perOrg: 100 })(connectionId);
    await draftTool(orgId, grantId, { perGrant: 2, perOrg: 100 })(connectionId);
    expect((await refusal(draftTool(orgId, grantId, { perGrant: 2, perOrg: 100 })(connectionId))).details).toMatchObject({ what: 'daily_drafts' });
    expect(await drafts(orgId)).toBe(2);
  });

  it('starts a new UTC day at zero', async () => {
    const { orgId, connectionId } = await freshOrg('Cap new day');
    const grantId = await grantOf(orgId);
    const make = draftTool(orgId, grantId, { perGrant: 2, perOrg: 100 });
    await admin((c) => c.query(`UPDATE ludy_kernel.agent_grant SET drafts_day = (now() AT TIME ZONE 'UTC')::date - 1, drafts_used = 2 WHERE org_id = $1 AND id = $2`, [orgId, grantId]));
    await make(connectionId);
    const c = await counter(orgId, grantId);
    expect(c).toMatchObject({ used: 1, day: c.today });
    await make(connectionId);
    await refusal(make(connectionId));
    expect(await drafts(orgId)).toBe(2);
  });

  it('caps the org as the sum of its grants, a revoked one included, and keeps another org\'s count apart', async () => {
    const { orgId, connectionId } = await freshOrg('Cap org');
    const other = await freshOrg('Cap other org');
    const first = await grantOf(orgId);
    const second = await grantOf(orgId);
    // A grant that made its drafts on an earlier day is left out of today's sum.
    const old = await grantOf(orgId);
    await admin((c) => c.query(`UPDATE ludy_kernel.agent_grant SET drafts_day = (now() AT TIME ZONE 'UTC')::date - 1, drafts_used = 50 WHERE org_id = $1 AND id = $2`, [orgId, old]));
    await draftTool(orgId, first, { perGrant: 10, perOrg: 3 })(connectionId);
    await draftTool(orgId, first, { perGrant: 10, perOrg: 3 })(connectionId);
    // Disconnecting the app and connecting it again does not start the day over: the revoked grant's two drafts still count.
    await admin((c) => c.query('UPDATE ludy_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2', [orgId, first]));
    await draftTool(orgId, second, { perGrant: 10, perOrg: 3 })(connectionId);
    expect((await refusal(draftTool(orgId, second, { perGrant: 10, perOrg: 3 })(connectionId))).details).toMatchObject({ what: 'daily_drafts' });
    expect(await drafts(orgId)).toBe(3);
    // Another org is not touched by it.
    const otherGrant = await grantOf(other.orgId);
    await draftTool(other.orgId, otherGrant, { perGrant: 10, perOrg: 3 })(other.connectionId);
    expect(await drafts(other.orgId)).toBe(1);
  });

  it('refuses a revoked grant as no longer valid before anything is made', async () => {
    const { orgId, connectionId } = await freshOrg('Cap revoked');
    const grantId = await grantOf(orgId);
    await admin((c) => c.query('UPDATE ludy_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2', [orgId, grantId]));
    const refused = await refusal(draftTool(orgId, grantId, { perGrant: 5, perOrg: 5 })(connectionId));
    expect(refused.status).toBe(401);
    expect(await drafts(orgId)).toBe(0);
    expect((await counter(orgId, grantId)).used).toBe(0);
  });

  it('never passes the caps when many calls arrive at once, on one grant and across two grants of the org', async () => {
    const { orgId, connectionId } = await freshOrg('Cap concurrent');
    const grantId = await grantOf(orgId);
    const second = await grantOf(orgId);
    // Six calls at once on each grant (cap 3 each), and 5 for the org across both.
    const caps = { perGrant: 3, perOrg: 5 };
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => draftTool(orgId, grantId, caps)(connectionId)),
      ...Array.from({ length: 6 }, () => draftTool(orgId, second, caps)(connectionId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await drafts(orgId)).toBe(5);
    const a = (await counter(orgId, grantId)).used;
    const b = (await counter(orgId, second)).used;
    expect(a + b).toBe(5);
    expect(a).toBeLessThanOrEqual(3);
    expect(b).toBeLessThanOrEqual(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'RATE_LIMITED', details: { what: 'daily_drafts' } });
    }
  });

  it('is executable by the application role alone', async () => {
    const roles = (
      await admin((c) =>
        c.query(
          `SELECT r.rolname FROM pg_catalog.pg_roles r
           WHERE pg_catalog.has_function_privilege(r.oid, 'ludy_kernel.mcp_drafts_charge(uuid, uuid, integer, integer)'::regprocedure, 'EXECUTE') AND NOT r.rolsuper
           ORDER BY r.rolname`,
        ),
      )
    ).rows.map((r) => r.rolname as string);
    expect(roles).toEqual(['ludy_app']);
    expect((await admin((c) => c.query(`SELECT pg_catalog.has_function_privilege('public', 'ludy_kernel.mcp_drafts_charge(uuid, uuid, integer, integer)'::regprocedure, 'EXECUTE') AS ok`))).rows[0].ok).toBe(false);
  });

  it('refuses a cap or a grant the function cannot take, and charges nothing', async () => {
    const { orgId } = await freshOrg('Cap invalid');
    const grantId = await grantOf(orgId);
    for (const [grantCap, orgCap] of [[0, 5], [5, 0], [100_001, 5], [5, 1_000_001]]) {
      await expect(admin((c) => c.query('SELECT ludy_kernel.mcp_drafts_charge($1, $2, $3, $4)', [grantId, orgId, grantCap, orgCap]))).rejects.toMatchObject({ code: '22023' });
    }
    // A grant of another org, or one that does not exist.
    await expect(admin((c) => c.query('SELECT ludy_kernel.mcp_drafts_charge($1, $2, 5, 5)', [grantId, randomUUID()]))).rejects.toMatchObject({ code: '22023' });
    await expect(admin((c) => c.query('SELECT ludy_kernel.mcp_drafts_charge($1, $2, 5, 5)', [randomUUID(), orgId]))).rejects.toMatchObject({ code: '22023' });
    expect((await counter(orgId, grantId)).used).toBe(0);
  });
});
