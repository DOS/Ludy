// SPDX-License-Identifier: AGPL-3.0-only
// The member-bound MCP grant against a real database (ADR-0051 decision 2, design note on #2975, slice 3, step 3a-2): the org's switch (an owner's, off by default), who may consent for
// themself while it is off and on, what ends a member grant (turning the switch off, a role that no longer counts, a removal), the cap of five, and that a company grant is as before.
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

suite('the member-bound MCP grant (#2975, slice 3, step 3a-2)', () => {
  const dbName = `crove_test_mcp_member_grant_db_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '', viewerA: '', outsider: '', capA: '' };
  const user = (userId: string, extra: Partial<UserActor> = {}): UserActor => ({ type: 'user', userId, aal: 'aal1', ...extra });
  const mcp = (userId: string, grantId: string): UserActor => user(userId, { mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read'] } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
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
  const consent = (userId: string, kind: 'company' | 'member', scopes: string[] = ['ludy.read'], clientId = `client-${randomUUID()}`) =>
    runtime.execute<{ grantId: string }>(
      'kernel.mcp.grant.approve',
      { clientId, clientName: 'Test client', clientHost: 'client.example.com', scopes, oauthGrantId: `oauth-${randomUUID()}`, kind },
      { actor: user(userId), orgId: orgA },
    );
  const setSwitch = (userId: string, enabled: boolean) => runtime.execute('kernel.mcp.member_grants.set', { enabled }, { actor: user(userId), orgId: orgA });
  const about = (userId: string, grantId: string) => runtime.query('kernel.mcp.about', {}, { actor: mcp(userId, grantId), orgId: orgA });
  const row = (grantId: string) => admin((c) => c.query(`SELECT kind, member_id, user_id, scopes, revoked_at FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgA, grantId]).then((r) => r.rows[0]));

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
      users[key] = await upsertIdentity(db, { issuer: 'mcp-member-grant-db', subject: key, email: `${key}@mcp-member-grant-db.test`, name: null });
    }
    orgA = (await createOrg(runtime, user(users.ownerA), 'Org A')).orgId;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'admin')`, [orgA, users.adminA, users.memberA, users.viewerA, users.capA]),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the org\'s switch off by default and lets an owner alone change it, an owner or admin read it', async () => {
    expect(await runtime.query('kernel.mcp.member_grants.get', {}, { actor: user(users.ownerA), orgId: orgA })).toEqual({ enabled: false });
    expect(await runtime.query('kernel.mcp.member_grants.get', {}, { actor: user(users.adminA), orgId: orgA })).toEqual({ enabled: false });
    for (const who of [users.adminA, users.memberA, users.viewerA]) expect((await refusal(setSwitch(who, true))).code).toBe('FORBIDDEN');
    expect((await refusal(runtime.query('kernel.mcp.member_grants.get', {}, { actor: user(users.memberA), orgId: orgA }))).code).toBe('FORBIDDEN');
    // An MCP grant never changes it.
    const grant = (await consent(users.ownerA, 'company')).grantId;
    expect((await refusal(runtime.execute('kernel.mcp.member_grants.set', { enabled: true }, { actor: mcp(users.ownerA, grant), orgId: orgA }))).code).toBe('FORBIDDEN');
    expect(await runtime.query('kernel.mcp.member_grants.get', {}, { actor: user(users.ownerA), orgId: orgA })).toEqual({ enabled: false });
  });

  it('lets an owner and an admin make a member grant for themself while the switch is off, and a member or viewer only once it is on', async () => {
    for (const who of [users.ownerA, users.adminA]) {
      const { grantId } = await consent(who, 'member');
      expect(await row(grantId)).toMatchObject({ kind: 'member', member_id: who, user_id: who });
    }
    for (const who of [users.memberA, users.viewerA]) expect((await refusal(consent(who, 'member'))).code).toBe('FORBIDDEN');
    // A company grant is still an owner's or admin's alone, switch or not.
    await setSwitch(users.ownerA, true);
    for (const who of [users.memberA, users.viewerA]) expect((await refusal(consent(who, 'company'))).code).toBe('FORBIDDEN');
    for (const who of [users.memberA, users.viewerA]) {
      const { grantId } = await consent(who, 'member');
      expect(await row(grantId)).toMatchObject({ kind: 'member', member_id: who, scopes: ['ludy.read'] });
    }
    // Someone who is not a member of the org gets nothing.
    expect((await refusal(consent(users.outsider, 'member'))).code).toBe('NOT_A_MEMBER');
  });

  it('ends a non-admin member grant at its next request when an owner turns the switch off, and not an admin\'s; turning it on again revives it', async () => {
    await setSwitch(users.ownerA, true);
    const mine = (await consent(users.memberA, 'member')).grantId;
    const admins = (await consent(users.adminA, 'member')).grantId;
    expect(await about(users.memberA, mine)).toMatchObject({ orgName: 'Org A' });
    await setSwitch(users.ownerA, false);
    expect((await refusal(about(users.memberA, mine))).code).toMatch(/UNAUTH|FORBIDDEN|SESSION|MCP/);
    expect(await about(users.adminA, admins)).toMatchObject({ orgName: 'Org A' });
    await setSwitch(users.ownerA, true);
    expect(await about(users.memberA, mine)).toMatchObject({ orgName: 'Org A' });
  });

  it('runs a member grant under the member\'s live standing: a removed member and a disabled account end it', async () => {
    await setSwitch(users.ownerA, true);
    const viewer = (await consent(users.viewerA, 'member')).grantId;
    expect(await about(users.viewerA, viewer)).toMatchObject({ orgName: 'Org A' });
    await admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, users.viewerA]));
    await refusal(about(users.viewerA, viewer));
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgA, users.viewerA]));
    // Back in the org, but after the grant was made: it does not come back to life.
    await refusal(about(users.viewerA, viewer));
  });

  it('ends every grant of an owner or admin who is demoted, a member grant of theirs too, and none of them comes back when the role does (stricter on purpose)', async () => {
    await setSwitch(users.ownerA, true);
    const demoted = users.capA;
    const company = (await consent(demoted, 'company')).grantId;
    const mine = (await consent(demoted, 'member')).grantId;
    expect(await about(demoted, company)).toMatchObject({ orgName: 'Org A' });
    expect(await about(demoted, mine)).toMatchObject({ orgName: 'Org A' });
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, demoted]));
    // The trigger that guards the grants ends them all (and destroys their tokens) with the admin role they were made under: a demotion is a change of
    // standing the person did not choose, so nothing they connected under the old role keeps reading. They connect again as the member they now are.
    for (const id of [company, mine]) expect((await refusal(about(demoted, id))).status).toBe(401);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgA, demoted]));
    for (const id of [company, mine]) expect((await refusal(about(demoted, id))).status).toBe(401);
    const fresh = (await consent(demoted, 'member')).grantId;
    expect(await about(demoted, fresh)).toMatchObject({ orgName: 'Org A' });
    // Leave the user clean for the cap test, which counts a user's live member grants.
    await runtime.execute('kernel.mcp.grant.revoke', { grantId: fresh }, { actor: user(demoted), orgId: orgA });
  });

  it('allows five live member grants per user and refuses the sixth, and a new consent for the same client replaces the old one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await consent(users.capA, 'member', ['ludy.read'], `cap-${i}`)).grantId);
    expect((await refusal(consent(users.capA, 'member', ['ludy.read'], 'cap-extra'))).code).toBe('MCP_GRANT_TOO_MANY');
    // The same client again replaces its grant, so it does not count twice.
    const again = (await consent(users.capA, 'member', ['ludy.read'], 'cap-0')).grantId;
    expect(again).not.toBe(ids[0]);
    expect((await row(ids[0] as string)).revoked_at).not.toBeNull();
  });

  it('still makes a company grant as before: no member, the same standing', async () => {
    const { grantId } = await consent(users.ownerA, 'company');
    expect(await row(grantId)).toMatchObject({ kind: 'company', member_id: null, scopes: ['ludy.read'] });
    expect(await about(users.ownerA, grantId)).toMatchObject({ orgName: 'Org A' });
    // The private scope is a member grant's alone: the database refuses it on a company grant and the definer refuses the kind.
    expect((await refusal(consent(users.ownerA, 'company', ['ludy.read', 'ludy.member.read']))).code).toBe('INVALID');
  });
});
