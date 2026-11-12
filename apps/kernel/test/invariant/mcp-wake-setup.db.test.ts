// SPDX-License-Identifier: AGPL-3.0-only
// The setup of an MCP grant's wake-up webhook (ADR-0051 decision 4, issue #3024, step a), through the runtime every command runs on:
// - the secret and the URL leave no trace but in their own sealed row: not in an audit row, an outbox event, an idempotency answer, a log line or any other
//   table of any module (every table is searched for the clear secret, the sealed envelope and a token planted in the URL's path);
// - only an owner or admin of the org sets, rotates or clears one, for a grant of their own org that is live; a member, an agent, an MCP grant and another org's
//   owner are refused, and a refusal says nothing about whether a grant or a wake-up exists;
// - a revoked or expired grant, a consenting user who is no longer an owner or admin, a removed or disabled user, a stopped org and a switched-off wake-up end the
//   delivery worker's very next read (`mcp_wake_target` answers nothing), and the previous secret signs only for the 24 hours of a rotation;
// - the table and the definers are reachable by no login role beyond the two named: the API's setup functions, the worker's target read, and nothing to PUBLIC.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type McpWakeCredential } from '@crove/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { makeWakeSecret } from '../../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up setup of an MCP grant (#3024)', () => {
  const dbName = `crove_test_mcp_wake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', memberA: '', ownerB: '' };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  // A token planted in the receiver's path: the URL is read back to an owner or admin only, so it must reach no other table.
  const TOKEN = `tok_${randomBytes(9).toString('hex')}`;
  const URL_OK = `https://hooks.example.com/ludy/${TOKEN}`;

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read'] } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function insertGrant(orgId: string, userId: string, extra = ''): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now() ${extra}, now() ${extra} + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
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

  const set = (actor: UserActor, orgId: string, grantId: string, credential: McpWakeCredential, extra: Record<string, unknown> = {}) =>
    runtime.execute<{ grantId: string; created: boolean }>('kernel.mcp.wake.set', { grantId, url: URL_OK, credential, ...extra }, { actor, orgId });
  const target = (orgId: string, grantId: string) =>
    admin((c) => c.query(`SELECT * FROM crove_kernel.mcp_wake_target($1, $2)`, [orgId, grantId]).then((r) => r.rows as Array<{ url: string; secret_sealed: unknown; previous_sealed: unknown; previous_until: Date | null }>));

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
    appUrl = url.toString();
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    workerUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 6 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries],
    });
    const db = createDb(pool);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-wake', subject: key, email: `${key}@mcp-wake.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('leaves no trace of the secret, its envelope or the URL anywhere but in the wake-up row, whether it is set, changed, rotated or cleared', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      return () => (console[level] = original);
    });
    const first = makeWakeSecret(vault, orgA, grant);
    const second = makeWakeSecret(vault, orgA, grant);
    let done: { created: boolean };
    try {
      done = await set(browser(users.ownerA), orgA, grant, first.credential, { schedule: 'daily', minute: 480 });
      // A change to the existing wake-up keeps its secret; the one made for the change is dropped.
      await set(browser(users.ownerA), orgA, grant, second.credential, { schedule: 'off' });
      await runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: grant, credential: second.credential }, { actor: browser(users.adminA), orgId: orgA });
      await runtime.query('kernel.mcp.wake.get', {}, { actor: browser(users.ownerA), orgId: orgA });
    } finally {
      for (const restore of spies) restore();
    }
    expect(done.created).toBe(true);
    // Every table of every crove schema, as text, searched for what must stay in its row: the clear secrets never, the envelopes and the token only in agent_grant_wake.
    const probes = [
      { name: 'the clear secret', needle: first.secret, allowedIn: [] as string[] },
      { name: 'the second clear secret', needle: second.secret, allowedIn: [] as string[] },
      { name: 'the first envelope', needle: first.credential.envelope, allowedIn: ['crove_kernel.agent_grant_wake'] },
      { name: 'the second envelope', needle: second.credential.envelope, allowedIn: ['crove_kernel.agent_grant_wake'] },
      { name: 'the token in the URL path', needle: TOKEN, allowedIn: ['crove_kernel.agent_grant_wake'] },
    ];
    await admin(async (c) => {
      const tables = (await c.query(`SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_catalog.pg_tables WHERE schemaname LIKE 'crove\\_%'`)).rows.map((r: { t: string }) => r.t);
      expect(tables.length).toBeGreaterThan(50);
      for (const table of tables) {
        for (const probe of probes) {
          if (probe.allowedIn.includes(table)) continue;
          const n = (await c.query(`SELECT count(*)::int AS n FROM ${table} x WHERE x::text LIKE '%' || $1 || '%'`, [probe.needle])).rows[0].n as number;
          expect(n, `${probe.name} in ${table}`).toBe(0);
        }
      }
      // The wake-up row itself holds the sealed one and never the clear one, and its envelope opens to the secret only with the binding it was made for.
      const row = (await c.query(`SELECT secret_sealed, previous_sealed FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grant])).rows[0];
      expect(JSON.stringify(row)).not.toContain(first.secret);
      expect(JSON.stringify(row)).not.toContain(second.secret);
      const sealed = row.secret_sealed as { keyId: string; envelope: string };
      expect(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: orgA, provider: 'mcp-wake', externalAccountId: grant })).toBe(second.secret);
      expect(() => vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: orgA, provider: 'mcp-wake', externalAccountId: randomUUID() })).toThrow();
      const previous = row.previous_sealed as { keyId: string; envelope: string };
      expect(vault.open({ keyId: previous.keyId, envelope: Buffer.from(previous.envelope, 'base64') }, { orgId: orgA, provider: 'mcp-wake', externalAccountId: grant })).toBe(first.secret);
    });
    // The log lines of the runtime and the commands carry none of them either.
    const logged = lines.join('\n');
    for (const probe of probes) expect(logged, probe.name).not.toContain(probe.needle);
    // The audit rows of the three commands name the grant, and the receiver's host, never the URL.
    const audit = await admin((c) => c.query(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.mcp.wake.%' ORDER BY occurred_at`, [orgA]));
    expect(audit.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of audit.rows) {
      expect(JSON.stringify(r.detail)).toContain(grant);
      expect(JSON.stringify(r.detail)).not.toContain('hooks.example.com/');
    }
    expect(JSON.stringify(audit.rows.find((r: { command: string }) => r.command === 'kernel.mcp.wake.set')?.detail)).toContain('hooks.example.com');
  });

  it('shows an owner or admin the wake-up and never a secret, and refuses a member, an agent, an MCP grant and another org', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const made = makeWakeSecret(vault, orgA, grant);
    await set(browser(users.adminA), orgA, grant, made.credential, { schedule: 'weekly', minute: 540, weekday: 1 });
    const [view] = await runtime.query<Array<Record<string, unknown>>>('kernel.mcp.wake.get', { grantId: grant }, { actor: browser(users.ownerA), orgId: orgA });
    expect(view).toMatchObject({ grantId: grant, url: URL_OK, enabled: true, schedule: 'weekly', minute: 540, weekday: 1, secretHint: made.credential.hint, consecutiveFailures: 0 });
    expect(JSON.stringify(view)).not.toContain(made.secret);
    expect(JSON.stringify(view)).not.toContain(made.credential.envelope);
    expect(typeof view?.nextDueAt).toBe('string');
    const next = new Date(view?.nextDueAt as string);
    // Monday 09:00 in Vietnam time (02:00 UTC), in the future.
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(2);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // Refused: a member, an agent, the MCP grant itself, and the owner of another org (one answer for a grant that is not theirs).
    for (const [name, call] of [
      ['a member sets', () => set(browser(users.memberA), orgA, grant, made.credential)],
      ['a member reads', () => runtime.query('kernel.mcp.wake.get', {}, { actor: browser(users.memberA), orgId: orgA })],
      ['a member clears', () => runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, { actor: browser(users.memberA), orgId: orgA })],
      ['the MCP grant sets', () => set(mcp(users.ownerA, grant), orgA, grant, made.credential)],
      ['an agent sets', () => set({ type: 'agent', agentId: randomUUID(), runId: randomUUID() } as never, orgA, grant, made.credential)],
      ['an agent reads', () => runtime.query('kernel.mcp.wake.get', {}, { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() } as never, orgId: orgA })],
    ] as const) {
      const error = await refusal(call());
      expect(error.status, name).toBeGreaterThanOrEqual(401);
      expect(error.status, name).toBeLessThanOrEqual(403);
    }
    const other = await refusal(set(browser(users.ownerB), orgB, grant, made.credential));
    expect(other.code).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    const unknown = await refusal(set(browser(users.ownerB), orgB, randomUUID(), made.credential));
    expect(unknown.code).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    expect(await runtime.query<unknown[]>('kernel.mcp.wake.get', {}, { actor: browser(users.ownerB), orgId: orgB })).toEqual([]);
    // Another org sees none of it, and a rotation or clear for a grant that has no wake-up in its org is the same kind of answer.
    expect((await refusal(runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: grant, credential: made.credential }, { actor: browser(users.ownerB), orgId: orgB }))).code).toBe('MCP_WAKE_GRANT_NOT_FOUND');
    expect((await refusal(runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, { actor: browser(users.ownerB), orgId: orgB }))).code).toBe('MCP_WAKE_NOT_FOUND');
  });

  it('refuses a receiver that is not https, an address, another port, with credentials, a fragment or a private name, in the command and again in the database', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const made = makeWakeSecret(vault, orgA, grant);
    for (const url of ['http://hooks.example.com/x', 'https://hooks.example.com:8443/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com/x#frag', 'https://10.0.0.5/x', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/x', 'https://intranet/x', 'https://printer.local/x', 'ftp://hooks.example.com/x', 'not a url']) {
      const error = await refusal(set(browser(users.ownerA), orgA, grant, made.credential, { url }));
      expect([400, 422], url).toContain(error.status);
    }
    // The database holds the same rule on its own: a row written around the command is refused.
    for (const url of ['http://hooks.example.com/x', 'https://10.0.0.5/x', 'https://hooks.example.com:8443/x', 'https://hooks.example.com/x y']) {
      await expect(
        admin((c) =>
          c.query(
            `INSERT INTO crove_kernel.agent_grant_wake (org_id, grant_id, url, secret_sealed, secret_hint, created_by) VALUES ($1, $2, $3, '{"keyId":"k","envelope":"AAAAAAAAAAAAAAAA"}', 'whk_00000000', $4)`,
            [orgA, grant, url, users.ownerA],
          ),
        ),
        url,
      ).rejects.toThrow();
    }
    expect(await target(orgA, grant)).toEqual([]);
  });

  it('ends the delivery worker\'s read the moment the grant is revoked or expires, the consenting user loses the role, is removed or disabled, the org is stopped, or the wake-up is switched off', async () => {
    const fresh = async (userId = users.ownerA): Promise<string> => {
      const grant = await insertGrant(orgA, userId);
      await set(browser(userId), orgA, grant, makeWakeSecret(vault, orgA, grant).credential);
      expect(await target(orgA, grant), 'live').toHaveLength(1);
      return grant;
    };
    const cases: Array<[string, (grant: string) => Promise<unknown>, (grant: string) => Promise<unknown>]> = [
      ['revoked', (g) => admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [g])), async () => undefined],
      ['expired', (g) => admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET created_at = now() - interval '40 days', expires_at = now() - interval '1 second' WHERE id = $1`, [g])), async () => undefined],
      ['switched off by the owner', (g) => set(browser(users.ownerA), orgA, g, makeWakeSecret(vault, orgA, g).credential, { enabled: false }), async () => undefined],
      ['org stopped', () => admin((c) => c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgA, users.ownerA])), () => admin((c) => c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [orgA]))],
    ];
    for (const [name, end, undo] of cases) {
      const grant = await fresh();
      await end(grant);
      expect(await target(orgA, grant), name).toEqual([]);
      await undo(grant);
    }
    // The consenting user: demoted, then restored (the grant stays ended), removed, disabled.
    for (const [name, end] of [
      ['demoted', () => admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]))],
      ['removed', () => admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]))],
    ] as const) {
      await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`, [orgA, users.adminA]));
      const grant = await fresh(users.adminA);
      await end();
      expect(await target(orgA, grant), name).toEqual([]);
    }
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`, [orgA, users.adminA]));
    const grant = await fresh(users.adminA);
    await admin((c) => c.query(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.adminA]));
    expect(await target(orgA, grant), 'disabled').toEqual([]);
    await admin((c) => c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.adminA]));
    // Another org's id for the grant answers nothing either.
    const own = await fresh();
    expect(await target(orgB, own)).toEqual([]);
  });

  it('keeps the previous secret for the 24 hours of a rotation only, and removes everything with a clear', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const first = makeWakeSecret(vault, orgA, grant);
    const second = makeWakeSecret(vault, orgA, grant);
    expect((await set(browser(users.ownerA), orgA, grant, first.credential)).created).toBe(true);
    expect((await set(browser(users.ownerA), orgA, grant, second.credential)).created).toBe(false);
    expect((await target(orgA, grant))[0]).toMatchObject({ previous_sealed: null, previous_until: null });
    await runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: grant, credential: second.credential }, { actor: browser(users.ownerA), orgId: orgA });
    const [rotated] = await target(orgA, grant);
    expect(rotated?.previous_sealed).not.toBeNull();
    const until = rotated?.previous_until;
    if (!until) throw new Error('the rotation has no overlap');
    const hours = (until.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    // Past the overlap the previous secret is no longer handed out, and the row keeps only the current one signing.
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant_wake SET previous_until = now() - interval '1 second' WHERE grant_id = $1`, [grant]));
    expect((await target(orgA, grant))[0]).toMatchObject({ previous_sealed: null, previous_until: null });
    await runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, { actor: browser(users.ownerA), orgId: orgA });
    expect(await target(orgA, grant)).toEqual([]);
    expect(await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grant]).then((r) => r.rows[0].n))).toBe(0);
  });

  it('computes the next daily and weekly time in Vietnam time, once', async () => {
    const at = (schedule: string, minute: number | null, weekday: number | null, from: string) =>
      admin((c) => c.query(`SELECT crove_kernel.mcp_wake_next_due($1, $2::smallint, $3::smallint, $4::timestamptz) AS t`, [schedule, minute, weekday, from]).then((r) => (r.rows[0].t as Date | null)?.toISOString() ?? null));
    // 08:00 Vietnam time is 01:00 UTC. From 00:30 UTC (07:30 there) the next is the same day; from 01:00 sharp or later, the next day.
    expect(await at('daily', 480, null, '2026-11-12T00:30:00Z')).toBe('2026-11-12T01:00:00.000Z');
    expect(await at('daily', 480, null, '2026-11-12T01:00:00Z')).toBe('2026-11-13T01:00:00.000Z');
    // Monday 2026-11-16 at 09:00 there (02:00 UTC); 2026-11-12 is a Thursday.
    expect(await at('weekly', 540, 1, '2026-11-12T00:00:00Z')).toBe('2026-11-16T02:00:00.000Z');
    expect(await at('off', 480, null, '2026-11-12T00:00:00Z')).toBeNull();
  });

  it('is reachable by no login role beyond the API\'s setup functions and the worker\'s one read, and nothing to PUBLIC', async () => {
    await admin(async (c) => {
      const roles = (await c.query(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\\_%'`)).rows.map((r: { rolname: string }) => r.rolname);
      const tableRights = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
      for (const role of roles) {
        for (const right of tableRights) {
          const ok = (await c.query(`SELECT has_table_privilege($1, 'crove_kernel.agent_grant_wake', $2) AS ok`, [role, right])).rows[0].ok as boolean;
          expect(ok, `${role} ${right} on the wake-up table`).toBe(false);
        }
      }
      expect((await c.query(`SELECT has_table_privilege('public', 'crove_kernel.agent_grant_wake', 'SELECT') AS ok`)).rows[0].ok).toBe(false);
      const functions = {
        'crove_kernel.mcp_wake_put(uuid, text, jsonb, text, text, smallint, smallint, boolean)': ['crove_app'],
        'crove_kernel.mcp_wake_rotate(uuid, jsonb, text)': ['crove_app'],
        'crove_kernel.mcp_wake_clear(uuid)': ['crove_app'],
        'crove_kernel.mcp_wake_get(uuid)': ['crove_app'],
        'crove_kernel.mcp_wake_target(uuid, uuid)': ['crove_worker'],
        'crove_kernel.mcp_wake_caller()': [],
        'crove_kernel.mcp_wake_next_due(text, smallint, smallint, timestamptz)': [],
      } as const;
      for (const [fn, allowed] of Object.entries(functions)) {
        for (const role of roles) {
          const ok = (await c.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok as boolean;
          expect(ok, `${role} execute ${fn}`).toBe((allowed as readonly string[]).includes(role));
        }
        expect((await c.query(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [fn])).rows[0].ok, `public ${fn}`).toBe(false);
        // Every one is a definer with a pinned search_path.
        const meta = (await c.query(`SELECT prosecdef, proconfig FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0];
        if (!fn.includes('next_due')) expect(meta.prosecdef, fn).toBe(true);
        expect(JSON.stringify(meta.proconfig), fn).toContain('search_path=pg_catalog, pg_temp');
      }
    });
    // And through the real logins: the worker cannot set anything up, the API cannot read the sealed target.
    const asApp = new pg.Client({ connectionString: appUrl });
    const asWorker = new pg.Client({ connectionString: workerUrl });
    await asApp.connect();
    await asWorker.connect();
    try {
      await expect(asApp.query(`SELECT * FROM crove_kernel.mcp_wake_target($1, $2)`, [orgA, randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(asWorker.query(`SELECT crove_kernel.mcp_wake_clear($1)`, [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(asApp.query(`SELECT * FROM crove_kernel.agent_grant_wake`)).rejects.toThrow(/permission denied/);
      await expect(asWorker.query(`SELECT * FROM crove_kernel.agent_grant_wake`)).rejects.toThrow(/permission denied/);
    } finally {
      await asApp.end();
      await asWorker.end();
    }
  });
});
