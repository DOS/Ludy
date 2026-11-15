// SPDX-License-Identifier: AGPL-3.0-only
// The apps an org turned off (ADR-0053, issue #3313; slice a of #3307) on a real PostgreSQL 17: every org starts with
// every app on (apps_off empty, version 1); only an owner or admin changes it, through the audited R2 command
// kernel.org.set_app, one app at a time, never kernel, never an app the build does not ship; any other write of the
// column or its version is refused by the database (tenant_apps_guard, tenant_apps_requires_audit), and the shape holds
// for staff too; org_app_on answers the choice to the API and the worker only; another org is untouched.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type CommandDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const SHIPPED = ['kernel', 'finance', 'social', 'hr'] as const;
const suite = ADMIN ? describe : describe.skip;

type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2' };

suite('apps an org turned off on PostgreSQL (ADR-0053)', () => {
  const dbName = `crove_test_orgapps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  // What the billing port answers for each org; absent means self-host's `full`.
  const entitlements = new Map<string, readonly string[]>();
  const clients: pg.Client[] = [];

  const asUser = (userId: string): Actor => ({ type: 'user', userId, aal: 'aal1' });

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Runs fn as the API login role in the user's sealed context of the org, then commits (so deferred triggers run).
  async function committedInContext(userId: string, orgId: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      await fn(app);
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@orgapps.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Apps ${randomUUID().slice(0, 6)}`);
    const [admin, member, viewer] = [await person('admin'), await person('member'), await person('viewer')];
    await withAdmin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, admin, member, viewer]),
    );
    const exec = <T>(actor: Actor, command: string, input: unknown) => rt.execute<T>(command, input, { actor, orgId, idempotencyKey: randomUUID() });
    const setApp = (actor: Actor, module: string, enabled: boolean) => exec<{ module: string; enabled: boolean; version: number }>(actor, 'kernel.org.set_app', { module, enabled });
    const choice = () =>
      withAdmin(
        async (c) =>
          (await c.query<{ off: string[]; version: number }>('SELECT apps_off AS off, apps_version AS version FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0],
      );
    const apps = (actor: Actor) => rt.query<{ apps: Array<{ id: string; deployment: boolean; entitled: boolean; enabled: boolean; effective: boolean }>; version: number; canChange: boolean }>(
      'kernel.org.apps',
      {},
      { actor, orgId },
    );
    const audit = (command: string) =>
      withAdmin(
        async (c) =>
          (
            await c.query<{ detail: Record<string, unknown> }>(
              `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
              [orgId, command],
            )
          ).rows[0]?.detail,
      );
    return { orgId, owner, admin, member, viewer, exec, setApp, choice, apps, audit };
  }

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: buildKernelCommands({ shippedModules: SHIPPED }),
      queries: kernelQueries({
        inboundDomain: null,
        // The deployment runs finance and social, not hr.
        apps: { shipped: SHIPPED, deployment: ['kernel', 'finance', 'social'], entitlements: async (orgId) => entitlements.get(orgId) ?? ['full'] },
      }),
    });
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts every org with every app on, and shows each member the apps and why one is not available', async () => {
    const o = await org();
    expect(await o.choice()).toEqual({ off: [], version: 1 });
    const seen = await o.apps(asUser(o.member));
    // kernel has no switch; hr is not run by this deployment.
    expect(seen.apps).toEqual([
      { id: 'finance', deployment: true, entitled: true, enabled: true, effective: true },
      { id: 'social', deployment: true, entitled: true, enabled: true, effective: true },
      { id: 'hr', deployment: false, entitled: true, enabled: true, effective: false },
    ]);
    expect(seen).toMatchObject({ version: 1, canChange: false });
    expect(await o.apps(asUser(o.viewer))).toMatchObject({ canChange: false });
    expect(await o.apps(asUser(o.admin))).toMatchObject({ canChange: true });
    expect(await o.apps(asUser(o.owner))).toMatchObject({ canChange: true });
  });

  it('applies the org\'s entitlements to the same answer', async () => {
    const o = await org();
    entitlements.set(o.orgId, ['finance']);
    const seen = await o.apps(asUser(o.owner));
    expect(seen.apps.map((a) => [a.id, a.entitled, a.effective])).toEqual([
      ['finance', true, true],
      ['social', false, false],
      ['hr', false, false],
    ]);
    // Switching an app on does not give the org what it does not hold.
    await o.setApp(asUser(o.owner), 'social', false);
    await o.setApp(asUser(o.owner), 'social', true);
    expect((await o.apps(asUser(o.owner))).apps.find((a) => a.id === 'social')).toMatchObject({ enabled: true, entitled: false, effective: false });
  });

  it('lets an owner or an admin turn an app off and on, audited, one app at a time, and tells the live app', async () => {
    const o = await org();
    await expect(o.setApp(asUser(o.owner), 'social', false)).resolves.toEqual({ module: 'social', enabled: false, version: 2 });
    expect(await o.choice()).toEqual({ off: ['social'], version: 2 });
    expect(await o.audit('kernel.org.set_app')).toMatchObject({ module: 'social', enabled: false, version: 2, changed: true });
    await expect(o.setApp(asUser(o.admin), 'hr', false)).resolves.toEqual({ module: 'hr', enabled: false, version: 3 });
    expect(await o.choice()).toEqual({ off: ['hr', 'social'], version: 3 });
    expect((await o.apps(asUser(o.member))).apps.map((a) => [a.id, a.enabled])).toEqual([
      ['finance', true],
      ['social', false],
      ['hr', false],
    ]);
    await expect(o.setApp(asUser(o.admin), 'social', true)).resolves.toEqual({ module: 'social', enabled: true, version: 4 });
    expect(await o.choice()).toEqual({ off: ['hr'], version: 4 });
    const events = await withAdmin(async (c) =>
      (
        await c.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.org.apps_changed' ORDER BY payload->>'version'",
          [o.orgId],
        )
      ).rows.map((r) => r.payload),
    );
    expect(events).toEqual([
      { module: 'social', enabled: false, version: 2 },
      { module: 'hr', enabled: false, version: 3 },
      { module: 'social', enabled: true, version: 4 },
    ]);
  });

  it('changes nothing, and tells nobody, when the app is already in the asked state', async () => {
    const o = await org();
    await expect(o.setApp(asUser(o.owner), 'finance', true)).resolves.toEqual({ module: 'finance', enabled: true, version: 1 });
    await o.setApp(asUser(o.owner), 'finance', false);
    await expect(o.setApp(asUser(o.owner), 'finance', false)).resolves.toEqual({ module: 'finance', enabled: false, version: 2 });
    expect(await o.choice()).toEqual({ off: ['finance'], version: 2 });
    expect(await o.audit('kernel.org.set_app')).toMatchObject({ module: 'finance', enabled: false, version: 2, changed: false });
    const { rows } = await withAdmin((c) => c.query("SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.org.apps_changed'", [o.orgId]));
    expect(rows).toHaveLength(1);
  });

  it('refuses a member, a viewer, a system actor, kernel, an app the build does not ship and a malformed id', async () => {
    const o = await org();
    await expect(o.setApp(asUser(o.member), 'social', false)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.setApp(asUser(o.viewer), 'social', false)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(rt.execute('kernel.org.set_app', { module: 'social', enabled: false }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(o.setApp(asUser(o.owner), 'kernel', false)).rejects.toMatchObject({ code: 'APP_ALWAYS_ON', status: 422 });
    await expect(o.setApp(asUser(o.owner), 'payroll', false)).rejects.toMatchObject({ code: 'UNKNOWN_APP', status: 422 });
    for (const module of ['Social', 'social,hr', '', 'a b', 'x'.repeat(51)]) {
      await expect(o.setApp(asUser(o.owner), module, false)).rejects.toBeTruthy();
    }
    expect(await o.choice()).toEqual({ off: [], version: 1 });
  });

  it('refuses an MCP grant that tries to run it', async () => {
    const o = await org();
    const mcp = { type: 'user' as const, userId: o.owner, aal: 'aal1' as const, mcp: { grantId: randomUUID(), clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read', 'ludy.write'] } };
    await expect(rt.execute('kernel.org.set_app', { module: 'social', enabled: false }, { actor: mcp, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toBeTruthy();
    expect(await o.choice()).toEqual({ off: [], version: 1 });
  });

  it('is a command no agent, MCP grant, extension token or member Vy can run', () => {
    const def = buildKernelCommands({ shippedModules: SHIPPED }).find((c) => c.name === 'kernel.org.set_app') as CommandDef<unknown, unknown>;
    expect(def).toBeDefined();
    expect(def.access).toEqual(['owner', 'admin']);
    expect(def.risk).toBe('R2');
    expect(def.agent).toBeUndefined();
    expect(def.mcp).toBeUndefined();
    expect(def.extension).toBeUndefined();
    expect(def.memberVy).toBeUndefined();
  });

  it('refuses every other write of the choice or its version, in the database', async () => {
    const o = await org();
    const write = (userId: string, sql: string) => committedInContext(userId, o.orgId, async (c) => void (await c.query(sql, [o.orgId])));
    const SET = "UPDATE crove_kernel.tenant SET apps_off = '{social}', apps_version = 2 WHERE org_id = $1";
    // A member, a viewer, an owner or admin that skips the version or keeps it, and an owner or admin without the command's audit row.
    await expect(write(o.member, SET)).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    await expect(write(o.viewer, SET)).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    await expect(write(o.owner, "UPDATE crove_kernel.tenant SET apps_off = '{social}', apps_version = 3 WHERE org_id = $1")).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    await expect(write(o.owner, "UPDATE crove_kernel.tenant SET apps_off = '{social}' WHERE org_id = $1")).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    await expect(write(o.admin, 'UPDATE crove_kernel.tenant SET apps_version = 9 WHERE org_id = $1')).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    await expect(write(o.owner, SET)).rejects.toMatchObject({ message: 'APPS_UNAUDITED' });
    await expect(write(o.admin, SET)).rejects.toMatchObject({ message: 'APPS_UNAUDITED' });
    expect(await o.choice()).toEqual({ off: [], version: 1 });

    // The audit row names one app and one version, and the write must be exactly that change. Each of these writes comes with
    // a matching 'ok' audit row of the command in the same transaction, so only the set and version checks can refuse it.
    await o.setApp(asUser(o.owner), 'social', false);
    const withAuditRow = (userId: string, row: { module: string; enabled: boolean; version: number }, sql: string) =>
      committedInContext(userId, o.orgId, async (c) => {
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, 'user', $2, 'kernel.org.set_app', $3, 'ok', 'test', $4::jsonb)`,
          [o.orgId, userId, randomUUID(), JSON.stringify({ ...row, changed: true })],
        );
        await c.query(sql, [o.orgId]);
      });
    // A second app switched in the same write.
    await expect(
      withAuditRow(o.owner, { module: 'hr', enabled: false, version: 3 }, "UPDATE crove_kernel.tenant SET apps_off = '{finance,hr,social}', apps_version = 3 WHERE org_id = $1"),
    ).rejects.toMatchObject({ message: 'APPS_UNAUDITED' });
    // Enabling an app that was not off (the list does not change, the version does).
    await expect(withAuditRow(o.owner, { module: 'finance', enabled: true, version: 3 }, 'UPDATE crove_kernel.tenant SET apps_version = 3 WHERE org_id = $1')).rejects.toMatchObject({
      message: 'APPS_UNAUDITED',
    });
    // Turning off an app that is already off, and a version bump with no change of the list.
    await expect(withAuditRow(o.owner, { module: 'social', enabled: false, version: 3 }, 'UPDATE crove_kernel.tenant SET apps_version = 3 WHERE org_id = $1')).rejects.toMatchObject({
      message: 'APPS_UNAUDITED',
    });
    // The audit row says the opposite of the write.
    await expect(
      withAuditRow(o.owner, { module: 'hr', enabled: true, version: 3 }, "UPDATE crove_kernel.tenant SET apps_off = '{hr,social}', apps_version = 3 WHERE org_id = $1"),
    ).rejects.toMatchObject({ message: 'APPS_UNAUDITED' });
    // A row for another version.
    await expect(
      withAuditRow(o.owner, { module: 'hr', enabled: false, version: 7 }, "UPDATE crove_kernel.tenant SET apps_off = '{hr,social}', apps_version = 3 WHERE org_id = $1"),
    ).rejects.toMatchObject({ message: 'APPS_UNAUDITED' });
    // A row by a member is not the command's (members cannot run it).
    await expect(
      withAuditRow(o.member, { module: 'hr', enabled: false, version: 3 }, "UPDATE crove_kernel.tenant SET apps_off = '{hr,social}', apps_version = 3 WHERE org_id = $1"),
    ).rejects.toMatchObject({ message: 'APPS_FORBIDDEN' });
    expect(await o.choice()).toEqual({ off: ['social'], version: 2 });
    // The same write with the exact row commits: the control that shows the cases above fail for their own reason.
    await withAuditRow(o.owner, { module: 'hr', enabled: false, version: 3 }, "UPDATE crove_kernel.tenant SET apps_off = '{hr,social}', apps_version = 3 WHERE org_id = $1");
    expect(await o.choice()).toEqual({ off: ['hr', 'social'], version: 3 });
  });

  it('touches no other org: a member of one org changes nothing of another', async () => {
    const a = await org();
    const b = await org();
    await a.setApp(asUser(a.owner), 'social', false);
    expect(await b.choice()).toEqual({ off: [], version: 1 });
    // The other org's row is not visible to a's owner: the update finds no row.
    const { rowCount } = await (async () => {
      let count = 0;
      await committedInContext(a.owner, a.orgId, async (c) => {
        count = (await c.query("UPDATE crove_kernel.tenant SET apps_off = '{finance}', apps_version = 2 WHERE org_id = $1", [b.orgId])).rowCount ?? 0;
      });
      return { rowCount: count };
    })();
    expect(rowCount).toBe(0);
    expect(await b.choice()).toEqual({ off: [], version: 1 });
    expect(await b.apps(asUser(b.owner))).toMatchObject({ version: 1 });
    expect((await b.apps(asUser(b.owner))).apps.every((app) => app.enabled)).toBe(true);
  });

  it('holds the shape of the choice for staff as well: no kernel, no duplicate, no NULL, no malformed id', async () => {
    const o = await org();
    const staff = (sql: string) => withAdmin((c) => c.query(sql, [o.orgId]));
    for (const bad of ["'{kernel}'", "'{social,social}'", "'{Social}'", "'{a b}'", "ARRAY[NULL]::text[]", "'{1x}'", "ARRAY[repeat('x', 51)]"]) {
      await expect(staff(`UPDATE crove_kernel.tenant SET apps_off = ${bad}, apps_version = 2 WHERE org_id = $1`)).rejects.toMatchObject({ message: 'APPS_OFF_INVALID' });
    }
    await expect(staff('UPDATE crove_kernel.tenant SET apps_off = NULL WHERE org_id = $1')).rejects.toBeTruthy();
    // A support fix of the authorization is allowed (a superuser), with a version that grows.
    await staff("UPDATE crove_kernel.tenant SET apps_off = '{social}', apps_version = 2 WHERE org_id = $1");
    expect(await o.choice()).toEqual({ off: ['social'], version: 2 });
    await expect(staff('UPDATE crove_kernel.tenant SET apps_version = 0 WHERE org_id = $1')).rejects.toBeTruthy();
  });

  it('answers org_app_on to the API and the worker only, and lets nobody call the guards', async () => {
    const o = await org();
    await o.setApp(asUser(o.owner), 'social', false);
    const answer = (role: string, module: string, org = o.orgId) =>
      withAdmin(async (c) => {
        await c.query(`SET ROLE ${role}`);
        try {
          return (await c.query<{ on: boolean }>('SELECT crove_kernel.org_app_on($1::uuid, $2::text) AS on', [org, module])).rows[0]?.on;
        } finally {
          await c.query('RESET ROLE');
        }
      });
    for (const role of ['crove_app', 'crove_worker']) {
      expect(await answer(role, 'social')).toBe(false);
      expect(await answer(role, 'finance')).toBe(true);
      // kernel is always on; an org with no tenant row (purged) has nothing on.
      expect(await answer(role, 'kernel')).toBe(true);
      expect(await answer(role, 'finance', randomUUID())).toBe(false);
      expect(await answer(role, 'kernel', randomUUID())).toBe(true);
    }
    const { callers, writes } = await withAdmin(async (c) => ({
      callers: (
        await c.query<{ fn: string; role: string }>(
          `SELECT f AS fn, r AS role FROM unnest(ARRAY['crove_kernel.tenant_apps_guard()', 'crove_kernel.tenant_apps_requires_audit()', 'crove_kernel.org_app_on(uuid,text)']) f, unnest($1::text[]) r
           WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE') ORDER BY 1, 2`,
          [ROLES],
        )
      ).rows,
      writes: (await c.query<{ public_exec: boolean }>("SELECT has_function_privilege('public', 'crove_kernel.org_app_on(uuid,text)'::regprocedure, 'EXECUTE') AS public_exec")).rows[0],
    }));
    expect(callers).toEqual([
      { fn: 'crove_kernel.org_app_on(uuid,text)', role: 'crove_app' },
      { fn: 'crove_kernel.org_app_on(uuid,text)', role: 'crove_worker' },
    ]);
    expect(writes).toEqual({ public_exec: false });
  });
});
