// SPDX-License-Identifier: AGPL-3.0-only
// The pairing code of the MCP endpoint (#4591; ADR-0051 decision 2: the fallback for an AI app without OAuth), the part of it that is a security line, on a real database:
// - only an owner or admin makes a code, with a fresh second factor when they have one, and an MCP grant never does; at most 5 live codes per org;
// - a code and the token it is traded for are stored only as their SHA-256: no row, audit row or other table of the org holds either in clear, nor does the audit row of the command hold the code's hash;
// - a code works once (eight redeems racing on one code give exactly one grant), only for 10 minutes, and a wrong, used, expired or void code (its person lost their role, a kill switch is on) is the same
//   answer, no row, and leaves no grant behind;
// - what a redeem makes is an ordinary company grant of the read scope that every standing check of an OAuth grant applies to, and a revoke (or a lost role) destroys the token's record with it;
// - the two functions are the API login's alone, with a pinned search path.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { auditRoleFunctionExecute, createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest();

suite('the pairing code of the MCP endpoint (#4591)', () => {
  const dbName = `crove_test_mcp_pairing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let appPool: pg.Pool;
  let orgId = '';
  const users = { owner: '', admin: '', member: '' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const person = (userId: string, extra: Partial<UserActor> = {}): UserActor => ({ type: 'user', userId, aal: 'aal1', ...extra });

  // The API's part: it makes the code and the token; the database gets their hashes only.
  const newCode = () => randomBytes(8).toString('hex').toUpperCase();
  const newToken = () => `lpt_${randomBytes(32).toString('base64url')}`;
  const issue = (code: string, label = 'Home-made agent', actor: UserActor = person(users.owner), org = orgId) =>
    runtime.execute<{ expiresAt: string }>('kernel.mcp.pairing.issue', { label, codeHash: sha(code).toString('hex') }, { actor, orgId: org });
  // The redeem as the API login runs it (the app pool), with the token the API made for it.
  async function redeem(code: string, token = newToken()): Promise<{ rows: Array<{ grant_id: string; org_id: string; expires_at: Date }>; token: string }> {
    const { rows } = await appPool.query<{ grant_id: string; org_id: string; expires_at: Date }>(`SELECT grant_id, org_id, expires_at FROM crove_kernel.mcp_pairing_redeem($1::bytea, $2::bytea)`, [sha(code), sha(token)]);
    return { rows, token };
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
  const grantCount = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1`, [orgId])).rows[0]?.n ?? 0;
  const setRole = (userId: string, role: string) => q(`UPDATE crove_kernel.tenant_member SET role = $3 WHERE org_id = $1 AND user_id = $2`, [orgId, userId, role]);
  // A fresh org each time something has to be broken (a role, a kill switch) without touching the others.
  const freshOrg = async (): Promise<string> => (await createOrg(runtime, person(users.owner), `Org ${randomUUID().slice(0, 6)}`)).orgId;

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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const app = new URL(adminUrl);
    app.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    app.password = 'test-app-pw';
    appPool = createDbPool({ connectionString: app.toString(), max: 12 }, dbIds);
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-pairing', subject: `${key}-${randomUUID()}`, email: `${key}-${randomUUID().slice(0, 8)}@mcp-pairing.test`, name: key });
    }
    orgId = (await createOrg(runtime, person(users.owner), 'Pairing org')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, users.admin, users.member]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner and an admin make a code and nobody else, and an MCP grant never', async () => {
    await issue(newCode(), 'By the owner');
    await issue(newCode(), 'By an admin', person(users.admin));
    expect((await refusal(issue(newCode(), 'By a member', person(users.member)))).status).toBe(403);
    const mcp = person(users.owner, { mcp: { grantId: randomUUID(), clientId: 'c', clientName: 'Agent', scopes: ['ludy.read'], kind: 'company' } });
    expect([401, 403]).toContain((await refusal(issue(newCode(), 'By an app', mcp))).status);
    // Not a member of the org at all.
    expect((await refusal(runtime.execute('kernel.mcp.pairing.issue', { label: 'x', codeHash: sha(newCode()).toString('hex') }, { actor: person(randomUUID()), orgId }))).status).toBeGreaterThanOrEqual(401);
  });

  it('asks a person with a second factor for a fresh one, as for a consent', async () => {
    const stale = person(users.owner, { aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) - 3600 });
    expect((await refusal(issue(newCode(), 'Stale', stale))).code).toBe('STEP_UP_REQUIRED');
    const fresh = person(users.owner, { aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) - 10 });
    await issue(newCode(), 'Fresh', fresh);
  });

  it('stores a code only as its SHA-256: not in the record, the audit row or any other row of the org', async () => {
    const org = await freshOrg();
    const code = newCode();
    const made = await issue(code, 'Only a hash', person(users.owner), org);
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const record = await q<{ key_hash: Buffer; payload: Record<string, unknown>; grant_id: string | null; consumed_at: Date | null }>(`SELECT key_hash, payload, grant_id, consumed_at FROM crove_kernel.oauth_record WHERE model = 'PairingCode' AND key_hash = $1`, [sha(code)]);
    expect(record.rowCount).toBe(1);
    expect(record.rows[0]?.consumed_at).toBeNull();
    expect(record.rows[0]?.payload).toEqual({ orgId: org, userId: users.owner, label: 'Only a hash', scopes: ['ludy.read'] });
    const everything = await q<{ blob: string }>(
      `SELECT (SELECT coalesce(string_agg(payload::text || encode(key_hash, 'hex') || coalesce(grant_id, '') || coalesce(uid, ''), ' '), '') FROM crove_kernel.oauth_record)
           || (SELECT coalesce(string_agg(detail::text || coalesce(input_sha256, ''), ' '), '') FROM crove_kernel.audit_event WHERE org_id = $1) AS blob`,
      [org],
    );
    expect(everything.rows[0]?.blob).not.toContain(code);
    // The audit rows of the org name the label and the end of the code, never the code's hash either (the hash is the record's key, nothing else's).
    const trail = (await q<{ blob: string }>(`SELECT coalesce(string_agg(detail::text || coalesce(input_sha256, ''), ' '), '') AS blob FROM crove_kernel.audit_event WHERE org_id = $1`, [org])).rows[0]?.blob;
    expect(trail).not.toContain(sha(code).toString('hex'));
    const audit = await q<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.pairing.issue'`, [org]);
    expect(audit.rows[0]?.detail).toMatchObject({ label: 'Only a hash' });
  });

  it('makes at most 5 live codes per org', async () => {
    const org = await freshOrg();
    for (let i = 0; i < 5; i++) await issue(newCode(), `Code ${i}`, person(users.owner), org);
    expect((await refusal(issue(newCode(), 'The sixth', person(users.owner), org))).code).toBe('MCP_PAIRING_TOO_MANY');
    // A used code frees its place.
    const code = newCode();
    await q(`DELETE FROM crove_kernel.oauth_record WHERE model = 'PairingCode' AND payload ->> 'orgId' = $1`, [org]);
    await issue(code, 'After the clean-up', person(users.owner), org);
  });

  it('trades a code for a company grant of the read scope, once, and keeps the token only as its hash', async () => {
    const code = newCode();
    await issue(code, 'Sales agent');
    const before = await grantCount();
    const { rows, token } = await redeem(code);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.org_id).toBe(orgId);
    expect(await grantCount()).toBe(before + 1);
    const grant = (await q<{ id: string; user_id: string; client_id: string; client_name: string; scopes: string[]; kind: string; oauth_grant_id: string; expires_at: Date; created_at: Date }>(`SELECT * FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgId, rows[0]?.grant_id])).rows[0];
    expect(grant).toMatchObject({ user_id: users.owner, client_name: 'Sales agent', scopes: ['ludy.read'], kind: 'company' });
    expect(grant?.client_id.startsWith('pairing:')).toBe(true);
    const days = ((grant?.expires_at.getTime() ?? 0) - (grant?.created_at.getTime() ?? 0)) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30.01);
    // The token record: the key is the token's SHA-256 and the grant's authorization id is the record's grant, so a revoke destroys it.
    const record = await q<{ payload: Record<string, unknown>; grant_id: string }>(`SELECT payload, grant_id FROM crove_kernel.oauth_record WHERE model = 'PairingToken' AND key_hash = $1`, [sha(token)]);
    expect(record.rowCount).toBe(1);
    expect(record.rows[0]?.grant_id).toBe(grant?.oauth_grant_id);
    expect(record.rows[0]?.payload).toEqual({ grantId: grant?.id, orgId, userId: users.owner, clientId: grant?.client_id, scopes: ['ludy.read'] });
    // Neither the code nor the token is anywhere in the store, the grants or the audit log.
    const everything = (
      await q<{ blob: string }>(
        `SELECT (SELECT coalesce(string_agg(payload::text || encode(key_hash, 'hex') || coalesce(grant_id, '') || coalesce(uid, ''), ' '), '') FROM crove_kernel.oauth_record)
             || (SELECT coalesce(string_agg(g::text, ' '), '') FROM crove_kernel.agent_grant g)
             || (SELECT coalesce(string_agg(detail::text || coalesce(input_sha256, ''), ' '), '') FROM crove_kernel.audit_event) AS blob`,
      )
    ).rows[0]?.blob;
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.slice(4));
    // The system's audit row says what happened and to which grant.
    const audit = await q<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.pairing_redeem' AND target_id = $2`, [orgId, rows[0]?.grant_id]);
    expect(audit.rows[0]?.detail).toMatchObject({ mcpPairing: true, mcpClientName: 'Sales agent', issuedBy: users.owner });
    // The grant stands exactly as an OAuth grant does: the endpoint's own checks accept it.
    const verified = await q(`SELECT 1 FROM crove_kernel.mcp_grant_verify($1::uuid, $2::text)`, [grant?.id, grant?.client_id]);
    expect(verified.rowCount).toBe(1);
  });

  it('refuses a second redeem of the same code, whoever asks and with whatever token', async () => {
    const code = newCode();
    await issue(code);
    expect((await redeem(code)).rows).toHaveLength(1);
    const before = await grantCount();
    expect((await redeem(code)).rows).toHaveLength(0);
    expect(await grantCount()).toBe(before);
  });

  it('gives exactly one grant to eight redeems racing on one code', async () => {
    const code = newCode();
    await issue(code);
    const before = await grantCount();
    const results = await Promise.all(Array.from({ length: 8 }, () => redeem(code)));
    expect(results.filter((r) => r.rows.length === 1)).toHaveLength(1);
    expect(await grantCount()).toBe(before + 1);
    // Only the winner's token is stored.
    const winner = results.find((r) => r.rows.length === 1);
    const stored = await q(`SELECT 1 FROM crove_kernel.oauth_record WHERE model = 'PairingToken' AND key_hash = ANY($1::bytea[])`, [results.map((r) => sha(r.token))]);
    expect(stored.rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM crove_kernel.oauth_record WHERE model = 'PairingToken' AND key_hash = $1`, [sha(winner?.token ?? '')])).rowCount).toBe(1);
  });

  it('refuses an expired code, a wrong one and a malformed hash alike, and makes nothing', async () => {
    const code = newCode();
    await issue(code);
    await q(`UPDATE crove_kernel.oauth_record SET expires_at = now() - interval '1 second' WHERE model = 'PairingCode' AND key_hash = $1`, [sha(code)]);
    const before = await grantCount();
    expect((await redeem(code)).rows).toHaveLength(0);
    expect((await redeem(newCode())).rows).toHaveLength(0);
    // Neither a short hash nor no hash reaches the tables.
    const short = await appPool.query(`SELECT * FROM crove_kernel.mcp_pairing_redeem($1::bytea, $2::bytea)`, [Buffer.from('short'), sha(newToken())]);
    expect(short.rowCount).toBe(0);
    const nothing = await appPool.query(`SELECT * FROM crove_kernel.mcp_pairing_redeem(NULL::bytea, NULL::bytea)`);
    expect(nothing.rowCount).toBe(0);
    // A code does not open a token's record, nor a token a code's.
    const token = newToken();
    const code2 = newCode();
    await issue(code2);
    await redeem(code2, token);
    expect((await redeem(token.slice(4))).rows).toHaveLength(0);
    expect(await grantCount()).toBe(before + 1);
  });

  it('refuses a code whose person lost their role, or whose org has a kill switch on, and consumes it', async () => {
    const org = await freshOrg();
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org, users.admin]);
    const lost = newCode();
    await issue(lost, 'Admin made', person(users.admin), org);
    await q(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    expect((await redeem(lost)).rows).toHaveLength(0);
    await q(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    // The code was consumed by the refused redeem: restoring the role does not bring it back.
    expect((await redeem(lost)).rows).toHaveLength(0);
    const stopped = newCode();
    await issue(stopped, 'Stopped org', person(users.owner), org);
    await q(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [org, users.owner]);
    expect((await redeem(stopped)).rows).toHaveLength(0);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1`, [org])).rows[0]?.n).toBe(0);
    // And no new code while it is on.
    expect((await refusal(issue(newCode(), 'While stopped', person(users.owner), org))).status).toBe(403);
  });

  it('deletes a pending code when its person loses the role, is removed or is disabled, so giving the role back does not revive it', async () => {
    const org = await freshOrg();
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org, users.admin]);
    const pendingFor = async (code: string) => (await q(`SELECT 1 FROM crove_kernel.oauth_record WHERE model = 'PairingCode' AND key_hash = $1`, [sha(code)])).rowCount;
    // Demoted and promoted again inside the 10 minutes.
    const a = newCode();
    await issue(a, 'Demoted', person(users.admin), org);
    expect(await pendingFor(a)).toBe(1);
    await q(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    expect(await pendingFor(a)).toBe(0);
    await q(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    expect((await redeem(a)).rows).toHaveLength(0);
    // Removed and added again.
    const b = newCode();
    await issue(b, 'Removed', person(users.admin), org);
    await q(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    expect(await pendingFor(b)).toBe(0);
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org, users.admin]);
    expect((await redeem(b)).rows).toHaveLength(0);
    // Another person's code in the same org is not touched.
    const c = newCode();
    await issue(c, 'Owner code', person(users.owner), org);
    await q(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org, users.admin]);
    expect(await pendingFor(c)).toBe(1);
    // A disabled account loses its codes in every org.
    const d = newCode();
    await issue(d, 'Disabled', person(users.owner), org);
    await q(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.owner]);
    expect(await pendingFor(d)).toBe(0);
    expect(await pendingFor(c)).toBe(0);
    await q(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.owner]);
  });

  it('ends the token with the grant: a revoke destroys its record at once, and a lost role closes the grant', async () => {
    const code = newCode();
    await issue(code, 'To revoke');
    const { rows, token } = await redeem(code);
    const grantId = rows[0]?.grant_id as string;
    const clientId = (await q<{ client_id: string }>(`SELECT client_id FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgId, grantId])).rows[0]?.client_id as string;
    await runtime.execute('kernel.mcp.grant.revoke', { grantId }, { actor: person(users.admin), orgId });
    expect((await q(`SELECT 1 FROM crove_kernel.oauth_record WHERE model = 'PairingToken' AND key_hash = $1`, [sha(token)])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM crove_kernel.mcp_grant_verify($1::uuid, $2::text)`, [grantId, clientId])).rowCount).toBe(0);
    // A second grant: its person is no longer an owner or admin, so the standing check closes it before any record is looked at.
    const code2 = newCode();
    await issue(code2, 'By an admin', person(users.admin));
    const second = await redeem(code2);
    const grant2 = second.rows[0]?.grant_id as string;
    const client2 = (await q<{ client_id: string }>(`SELECT client_id FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgId, grant2])).rows[0]?.client_id as string;
    expect((await q(`SELECT 1 FROM crove_kernel.mcp_grant_verify($1::uuid, $2::text)`, [grant2, client2])).rowCount).toBe(1);
    await setRole(users.admin, 'member');
    expect((await q(`SELECT 1 FROM crove_kernel.mcp_grant_verify($1::uuid, $2::text)`, [grant2, client2])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM crove_kernel.oauth_record WHERE model = 'PairingToken' AND key_hash = $1`, [sha(second.token)])).rowCount).toBe(0);
    await setRole(users.admin, 'admin');
  });

  it('gives the two functions to the API login alone, with a pinned search path', async () => {
    for (const fn of ['crove_kernel.mcp_pairing_issue(bytea,text)', 'crove_kernel.mcp_pairing_redeem(bytea,bytea)']) {
      const { rows: logins, activeAllowed } = await admin((c) => auditRoleFunctionExecute(c, dbIds, fn, ['crove_app'], 'non_system'));
      expect(logins.some((r) => r.rolname === activeAllowed[0] && r.ok), `${fn}: the API login executes it`).toBe(true);
      for (const { rolname, ok, expected } of logins) expect(ok, `${fn}: ${rolname}`).toBe(expected);
      expect((await q<{ ok: boolean }>(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS ok`)).rows[0]?.ok).toBe(false);
      expect((await q(`SELECT proconfig, prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0]).toEqual({ proconfig: ['search_path=pg_catalog, pg_temp'], prosecdef: true });
    }
    // The tables behind them stay closed to the API login: it reaches the store only through definers.
    const app = createDbClient({ connectionString: new URL(appPool.options.connectionString as string).toString() }, dbIds);
    await app.connect();
    try {
      await expect(app.query(`SELECT 1 FROM crove_kernel.oauth_record LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });
});
