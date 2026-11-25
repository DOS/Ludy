// SPDX-License-Identifier: AGPL-3.0-only
// The type a new org picks at creation (ADR-0053 amendment of 2026-11-25, #4802) on a real PostgreSQL 17. Set LUDY_TEST_ADMIN_URL (or
// CROVE_TEST_ADMIN_URL) to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { ORG_KIND_APPS_OFF, SWITCHABLE_MODULE_IDS } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

const SOLO_OFF = ['ads', 'crm', 'hr', 'sign', 'social'];

suite('org type at creation on PostgreSQL (#4802)', () => {
  const dbName = `ludy_test_orgkind_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // The kernel as the API registers it: the build ships every module.
  let runtime: Runtime;
  // A build that ships fewer modules.
  let small: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function newUser(label: string): Promise<string> {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    return upsertIdentity(db, { issuer: 'test', subject: tag, email: `${tag}@example.com`, name: null });
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

  async function tenantApps(orgId: string) {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ off: string[]; version: number }>('SELECT apps_off AS off, apps_version AS version FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]);
      return rows[0] as { off: string[]; version: number };
    });
  }

  async function audits(orgId: string, command: string) {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ outcome: string; actor_type: string; actor_id: string; detail: Record<string, unknown> }>(
        'SELECT outcome, actor_type, actor_id, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at, id',
        [orgId, command],
      );
      return rows;
    });
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    const queries = kernelQueries({ inboundDomain: 'in.test' });
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: buildKernelCommands({ shippedModules: ['kernel', ...SWITCHABLE_MODULE_IDS] }),
      queries,
    });
    small = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: buildKernelCommands({ shippedModules: ['kernel', 'finance', 'hr', 'social', 'notes'] }),
      queries,
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('names the owner decision: solo keeps finance, notes, projects and meetings on; team keeps every module on', () => {
    expect([...ORG_KIND_APPS_OFF.solo].sort()).toEqual(SOLO_OFF);
    const solo = SWITCHABLE_MODULE_IDS.filter((m) => !ORG_KIND_APPS_OFF.solo.includes(m)).sort();
    expect(solo).toEqual(['finance', 'meetings', 'notes', 'projects']);
    expect(ORG_KIND_APPS_OFF.team).toEqual([]);
  });

  it('"solo" starts the org with social, crm, ads, hr and sign off, each switch an audited run of kernel.org.set_app by its owner', async () => {
    const founder = await newUser('solo');
    const org = await createOrg(runtime, asUser(founder), 'Một mình tôi', randomUUID(), 'solo');
    expect(org.role).toBe('owner');
    const apps = await tenantApps(org.orgId);
    expect(apps.off).toEqual(SOLO_OFF);
    expect(apps.version).toBe(1 + SOLO_OFF.length);

    const switches = await audits(org.orgId, 'kernel.org.set_app');
    expect(switches.map((a) => [a.outcome, a.actor_type, a.actor_id, a.detail.module, a.detail.enabled, a.detail.changed])).toEqual(
      ORG_KIND_APPS_OFF.solo.map((m) => ['ok', 'user', founder, m, false, true]),
    );
    const created = await audits(org.orgId, 'kernel.org.create');
    expect(created).toHaveLength(1);
    expect(created[0]?.detail).toMatchObject({ slug: org.slug, kind: 'solo', appsOff: [...ORG_KIND_APPS_OFF.solo] });
  });

  it('"team" and no type start the org with every app on and write no switch', async () => {
    const founder = await newUser('team');
    const team = await createOrg(runtime, asUser(founder), 'Có nhân viên', randomUUID(), 'team');
    const none = await createOrg(runtime, asUser(founder), 'Không chọn', randomUUID());
    for (const org of [team, none]) {
      expect(await tenantApps(org.orgId)).toEqual({ off: [], version: 1 });
      expect(await audits(org.orgId, 'kernel.org.set_app')).toEqual([]);
    }
    expect((await audits(team.orgId, 'kernel.org.create'))[0]?.detail).toMatchObject({ kind: 'team', appsOff: [] });
    expect((await audits(none.orgId, 'kernel.org.create'))[0]?.detail).not.toHaveProperty('kind');
    // The kernel registered alone, as the older callers do (no module list, the default create command): no type, nothing switched.
    const bare = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    const legacy = await createOrg(bare, asUser(founder), 'Cũ', randomUUID());
    expect(await tenantApps(legacy.orgId)).toEqual({ off: [], version: 1 });
  });

  it('leaves orgs that already exist as they are, whatever another org picks', async () => {
    const founder = await newUser('existing');
    const before = await createOrg(runtime, asUser(founder), 'Đã có', randomUUID());
    await runtime.execute('kernel.org.set_app', { module: 'hr', enabled: false }, { actor: asUser(founder), orgId: before.orgId });
    const snapshot = await tenantApps(before.orgId);
    expect(snapshot).toEqual({ off: ['hr'], version: 2 });
    await createOrg(runtime, asUser(founder), 'Mới một mình', randomUUID(), 'solo');
    await createOrg(runtime, asUser(await newUser('other')), 'Người khác', randomUUID(), 'solo');
    expect(await tenantApps(before.orgId)).toEqual(snapshot);
  });

  it('switching an app on later works, is audited, and keeps the data of an app that is off', async () => {
    const founder = await newUser('later');
    const org = await createOrg(runtime, asUser(founder), 'Bật sau', randomUUID(), 'solo');
    await runtime.execute('kernel.org.set_app', { module: 'social', enabled: true }, { actor: asUser(founder), orgId: org.orgId });
    const apps = await tenantApps(org.orgId);
    expect(apps.off).toEqual(['ads', 'crm', 'hr', 'sign']);
    expect(apps.version).toBe(2 + SOLO_OFF.length);
    const switches = await audits(org.orgId, 'kernel.org.set_app');
    expect(switches.at(-1)?.detail).toMatchObject({ module: 'social', enabled: true, changed: true, version: apps.version });
    expect(switches).toHaveLength(SOLO_OFF.length + 1);
    // Nothing was deleted by the switches: the tenant row and its owner are the ones created.
    const members = await withAdmin(async (admin) => (await admin.query('SELECT 1 FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = $2', [org.orgId, 'owner'])).rowCount);
    expect(members).toBe(1);
  });

  it('a replay of the same request returns the same org and switches nothing again, even after the owner switched an app on', async () => {
    const founder = await newUser('replay');
    const key = randomUUID();
    const first = await createOrg(runtime, asUser(founder), 'Gửi lại', key, 'solo');
    await runtime.execute('kernel.org.set_app', { module: 'hr', enabled: true }, { actor: asUser(founder), orgId: first.orgId });
    const afterOwner = await tenantApps(first.orgId);
    await expect(createOrg(runtime, asUser(founder), 'Gửi lại', key, 'solo')).resolves.toEqual(first);
    expect(await tenantApps(first.orgId)).toEqual(afterOwner);
    expect(afterOwner.off).not.toContain('hr');
    expect(await audits(first.orgId, 'kernel.org.create')).toHaveLength(1);
  });

  it('switches only the modules the build ships', async () => {
    const founder = await newUser('small');
    const org = await createOrg(small, asUser(founder), 'Bản nhỏ', randomUUID(), 'solo');
    expect((await tenantApps(org.orgId)).off).toEqual(['hr', 'social']);
  });

  it('refuses a type that is not one of the two and creates nothing', async () => {
    const founder = await newUser('bad');
    await expect(
      runtime.executeOrgless('kernel.org.create', { name: 'Sai kiểu', kind: 'enterprise' }, { actor: asUser(founder), idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 422 });
    const left = await withAdmin(async (admin) => (await admin.query('SELECT 1 FROM ludy_kernel.tenant WHERE created_by = $1', [founder])).rowCount);
    expect(left).toBe(0);
  });

  it('keeps the guard closed: the type gives a member or a stranger no way to set the apps, and a direct write is still refused', async () => {
    const founder = await newUser('guard');
    const org = await createOrg(runtime, asUser(founder), 'Bảo vệ', randomUUID(), 'solo');
    const member = await newUser('member');
    await withAdmin((admin) => admin.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [org.orgId, member]));
    await expect(runtime.execute('kernel.org.set_app', { module: 'hr', enabled: true }, { actor: asUser(member), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
    // A stranger can not run it in someone else's org, and the new org's apps stay what the type set.
    const stranger = await newUser('stranger');
    await expect(runtime.execute('kernel.org.set_app', { module: 'hr', enabled: true }, { actor: asUser(stranger), orgId: org.orgId })).rejects.toBeDefined();
    expect((await tenantApps(org.orgId)).off).toEqual(SOLO_OFF);
  });
});
