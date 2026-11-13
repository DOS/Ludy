// SPDX-License-Identifier: AGPL-3.0-only
// The runtime's wiring of a member-bound MCP grant (ADR-0051 decision 2; design note on #2975, slice 3, step 3b-2): a grant of kind 'member' enters the
// sealed member context afresh on every request, reads only the queries that declare `mcp`, never what is owner or admin only, never a command, and
// every way it can stop answers the client with the one generic "grant not valid" while the specific reason goes to the security event.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the runtime wiring of a member-bound MCP grant (#2975, slice 3, step 3b-2)', () => {
  const dbName = `crove_test_mcp_member_rt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '', viewerA: '' };
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
  const mcp = (userId: string, grantId: string, kind: 'company' | 'member' = 'member'): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal1',
    mcp: { grantId, clientId: 'client', clientName: 'Test client', scopes: ['ludy.read'], kind },
  });
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  let counter = 0;
  async function grant(userId: string, over: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    counter += 1;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, ${over.expired ? "now() - interval '2 days'" : 'clock_timestamp()'}, ${over.expired ? "now() - interval '1 day'" : "now() + interval '30 days'"},
                 ${over.revoked ? 'now()' : 'NULL'}, $3, 'member', $3)`,
        [orgA, id, userId, `client-${counter}-${id}`, `oauth-${id}`],
      ),
    );
    return id;
  }
  const setSwitch = (on: boolean) => admin((c) => c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = $2 WHERE org_id = $1`, [orgA, on]));
  const about = (actor: UserActor) => runtime.query<{ orgName: string }>('kernel.mcp.about', {}, { actor, orgId: orgA });

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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-member-rt', subject: key, email: `${key}@mcp-member-rt.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgA, users.adminA, users.memberA, users.viewerA]),
    );
    await setSwitch(true);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the one query open to every role for a member, a viewer and an owner, each through its own member grant', async () => {
    for (const userId of [users.memberA, users.viewerA, users.adminA, users.ownerA]) {
      const id = await grant(userId);
      expect(await about(mcp(userId, id))).toMatchObject({ orgName: 'Org A' });
    }
  });

  it('keeps a member grant out of what is owner or admin only, and out of every command and every query that declares no `mcp`', async () => {
    const id = await grant(users.memberA);
    const parties = await refusal(runtime.query('kernel.mcp.parties', {}, { actor: mcp(users.memberA, id), orgId: orgA }));
    expect(parties.code).toBe('FORBIDDEN');
    const list = await refusal(runtime.query('kernel.mcp.grant.list', {}, { actor: mcp(users.memberA, id), orgId: orgA }));
    expect(list.details).toMatchObject({ rule: 'mcp_scope' });
    const inputs: Record<string, unknown> = {
      'kernel.mcp.grant.revoke': { grantId: randomUUID() },
      'kernel.mcp.grant.approve': { clientId: 'c', clientName: 'c', clientHost: 'c.example.com', scopes: ['ludy.read'], oauthGrantId: 'g' },
      'kernel.mcp.member_grants.set': { enabled: true },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const error = await refusal(runtime.execute(name, input, { actor: mcp(users.memberA, id), orgId: orgA }));
      expect(error.code, name).toBe('FORBIDDEN');
      expect(error.details, name).toMatchObject({ rule: 'mcp_scope' });
    }
    // The same owner-only query is open to the owner's own member grant: the role comes from the seal, live.
    const ownerGrant = await grant(users.ownerA);
    await expect(runtime.query('kernel.mcp.parties', {}, { actor: mcp(users.ownerA, ownerGrant), orgId: orgA })).resolves.toBeDefined();
  });

  it('re-enters on every request: a revoke, an expiry and the switch turned off each refuse the very next call with the same generic answer', async () => {
    const revoked = await grant(users.memberA, { revoked: true });
    const expired = await grant(users.memberA, { expired: true });
    const answers: DomainError[] = [];
    answers.push(await refusal(about(mcp(users.memberA, revoked))));
    answers.push(await refusal(about(mcp(users.memberA, expired))));
    const live = await grant(users.memberA);
    await about(mcp(users.memberA, live));
    await setSwitch(false);
    try {
      answers.push(await refusal(about(mcp(users.memberA, live))));
      // An owner's own member grant needs no switch.
      await expect(about(mcp(users.ownerA, await grant(users.ownerA)))).resolves.toBeDefined();
    } finally {
      await setSwitch(true);
    }
    await about(mcp(users.memberA, live));
    answers.push(await refusal(about(mcp(users.memberA, randomUUID()))));
    for (const error of answers) {
      expect(error.status).toBe(401);
      expect(error.code).toBe('MCP_GRANT_INVALID');
      expect(error.message).toBe(answers[0]?.message);
    }
    // The specific reason is in the security event, not in the answer.
    const codes = await admin((c) => c.query(`SELECT DISTINCT code FROM crove_kernel.security_event WHERE target_org = $1 AND command = 'kernel.mcp.about'`, [orgA]).then((r) => r.rows.map((x) => x.code as string)));
    expect(codes).toEqual(expect.arrayContaining(['MCP_GRANT_REVOKED', 'MCP_GRANT_EXPIRED', 'MCP_MEMBER_GRANTS_OFF', 'MCP_GRANT_INVALID']));
  });

  it('refuses a grant used by another user than its member, as a bug and never as a role', async () => {
    const id = await grant(users.memberA);
    const error = await refusal(about(mcp(users.ownerA, id)));
    expect(error.status).toBe(500);
  });
});
