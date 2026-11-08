// SPDX-License-Identifier: AGPL-3.0-only
// The permission vy.use, "Làm việc với Vy" (ADR-0049 decision 10, issue #2781): who holds it by default, who may set an
// exception for whom, and the narrowed viewer rule of role.assign. The invariants (no skip, negative cases unconditional) are in
// test/invariant/member-vy-private.db.test.ts; this file drives the command and the role commands end to end.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('vy.use (ADR-0049 decision 10)', () => {
  const dbName = `crove_test_vy_use_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', admin: '', member: '', viewer: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // What a user's own context answers to ctx_has_permission and ctx_vy_use.
  async function asked(userId: string, permission: string) {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const out = await c.query<{ held: boolean; vy: boolean }>('SELECT crove_kernel.ctx_has_permission($1) AS held, crove_kernel.ctx_vy_use() AS vy', [permission]);
      return out.rows[0] as { held: boolean; vy: boolean };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const set = (actorId: string, userId: string, allowed: boolean | null) =>
    runtime.execute<{ userId: string; changed: boolean }>('kernel.member.permission.set', { userId, permission: 'vy.use', allowed }, { actor: asUser(actorId), orgId });

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
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'vy-use', subject: key, email: `${key}@vy-use.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Vy quyền')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, users.admin, users.member, users.viewer]));
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('holds by default for an owner, an admin and a member, and not for a viewer', async () => {
    for (const [who, expected] of [[users.owner, true], [users.admin, true], [users.member, true], [users.viewer, false]] as const) {
      expect(await asked(who, 'vy.use'), `default for ${who === users.viewer ? 'a viewer' : 'a member'}`).toEqual({ held: expected, vy: expected });
    }
  });

  it('lets an owner deny and restore a member, and a deny beats the default', async () => {
    expect(await set(users.owner, users.member, false)).toMatchObject({ changed: true });
    expect(await asked(users.member, 'vy.use')).toEqual({ held: false, vy: false });
    expect(await set(users.owner, users.member, false), 'the same deny again').toMatchObject({ changed: false });
    expect(await set(users.owner, users.member, null)).toMatchObject({ changed: true });
    expect(await asked(users.member, 'vy.use')).toEqual({ held: true, vy: true });
  });

  it('lets an admin change admins, members and viewers, never an owner, and a member never their own', async () => {
    expect(await set(users.admin, users.viewer, true), 'an admin granting a viewer').toMatchObject({ changed: true });
    await expect(set(users.admin, users.owner, false)).rejects.toMatchObject({ code: 'PERMISSION_MANAGE_FORBIDDEN' });
    await expect(set(users.admin, users.admin, false), 'an admin changing their own').rejects.toMatchObject({ code: 'PERMISSION_MANAGE_FORBIDDEN' });
    await expect(set(users.member, users.member, false)).rejects.toThrow();
    await expect(set(users.viewer, users.viewer, true)).rejects.toThrow();
    // The refused attempts changed nothing.
    expect(await asked(users.owner, 'vy.use')).toEqual({ held: true, vy: true });
    expect(await asked(users.member, 'vy.use')).toEqual({ held: true, vy: true });
  });

  it('gives a viewer with a grant vy.use and no other permission, and a deny takes it away again', async () => {
    expect(await asked(users.viewer, 'vy.use')).toEqual({ held: true, vy: true });
    expect((await asked(users.viewer, 'finance.period.unlock')).held).toBe(false);
    expect(await set(users.owner, users.viewer, false)).toMatchObject({ changed: true });
    expect(await asked(users.viewer, 'vy.use')).toEqual({ held: false, vy: false });
    expect(await set(users.owner, users.viewer, null)).toMatchObject({ changed: true });
  });

  it('refuses a permission other than vy.use and a person who is not a member', async () => {
    await expect(runtime.execute('kernel.member.permission.set', { userId: users.member, permission: 'finance.period.unlock', allowed: true }, { actor: asUser(users.owner), orgId })).rejects.toThrow();
    await expect(set(users.owner, randomUUID(), true)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
  });

  it('gives a viewer a preset that grants only vy.use, and refuses one that grants a real permission', async () => {
    // The grant and the invite both call role_assignment_check; the roles are checked by key here, whatever modules this deployment runs.
    const check = (roleKey: string, legalEntityId: string | null = null) =>
      admin((c) => c.query('SELECT crove_kernel.role_assignment_check($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid)', [orgId, users.viewer, 'viewer', roleKey, legalEntityId]));
    await expect(check('finance.chief_accountant')).rejects.toThrow(/ROLE_PRIVILEGED_FOR_VIEWER/);
    for (const roleKey of ['crm.sales', 'desk.agent', 'hr.manager', 'finance.accountant', 'finance.viewer']) {
      // desk.agent also grants kernel.conversation.direct.read, a real permission: refused too.
      if (roleKey === 'desk.agent') await expect(check(roleKey)).rejects.toThrow(/ROLE_PRIVILEGED_FOR_VIEWER/);
      else await expect(check(roleKey), `${roleKey} for a viewer`).resolves.toBeDefined();
    }
    // A viewer holding a department role through the table works with Vy and holds nothing else.
    await admin((c) => c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'crm.sales', $3)`, [orgId, users.viewer, users.owner]));
    expect(await asked(users.viewer, 'vy.use'), 'a viewer with a department role').toEqual({ held: true, vy: true });
    expect((await asked(users.viewer, 'finance.period.unlock')).held).toBe(false);
  });

  // member_has_permission is SECURITY INVOKER, so row-level security hides some rows from some callers: a tenant login that
  // calls it directly answers only about itself, as an owner or admin, or as the system; every other caller is refused.
  it('answers the same to every caller that may ask, and refuses the rest', async () => {
    await set(users.owner, users.member, false);
    await set(users.owner, users.viewer, true);
    try {
      const askAs = async (enter: (c: pg.Client) => Promise<unknown>, url: string, about: string) => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        try {
          await c.query('BEGIN');
          await enter(c);
          return (await c.query<{ ok: boolean }>('SELECT crove_kernel.member_has_permission($1::uuid, $2::uuid, $3::text) AS ok', [orgId, about, 'vy.use'])).rows[0]?.ok;
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          await c.end();
        }
      };
      const asUserCtx = (userId: string) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const asSystem = (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      const workerUrl = (() => {
        const url = new URL(adminUrl);
        url.username = 'crove_worker';
        url.password = 'test-worker-pw';
        return url.toString();
      })();
      for (const [about, expected] of [[users.member, false], [users.viewer, true], [users.owner, true]] as const) {
        const answers = {
          superuser: (await admin((c) => c.query<{ ok: boolean }>('SELECT crove_kernel.member_has_permission($1::uuid, $2::uuid, $3::text) AS ok', [orgId, about, 'vy.use']))).rows[0]?.ok,
          system: await askAs(asSystem, workerUrl, about),
          owner: await askAs(asUserCtx(users.owner), appUrl, about),
          admin: await askAs(asUserCtx(users.admin), appUrl, about),
        };
        expect(answers, `the answers about ${about === users.member ? 'a denied member' : about === users.viewer ? 'a granted viewer' : 'the owner'}`).toEqual({ superuser: expected, system: expected, owner: expected, admin: expected });
      }
      // The person themselves.
      expect(await askAs(asUserCtx(users.member), appUrl, users.member)).toBe(false);
      expect(await askAs(asUserCtx(users.viewer), appUrl, users.viewer)).toBe(true);
      // Another member, a viewer asking about someone else, and an org-chart or no context get no answer, not a wrong one.
      for (const [who, about] of [[users.member, users.viewer], [users.viewer, users.member], [users.member, users.owner]] as const) {
        await expect(askAs(asUserCtx(who), appUrl, about), 'a member asking about someone else').rejects.toMatchObject({ code: '42501' });
      }
      await expect(askAs(async () => {}, appUrl, users.member), 'no context').rejects.toMatchObject({ code: '42501' });
    } finally {
      await set(users.owner, users.member, null);
      await set(users.owner, users.viewer, null);
    }
  });
});
