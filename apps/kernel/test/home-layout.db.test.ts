// SPDX-License-Identifier: AGPL-3.0-only
// Per-member, per-org Global Home layout product flows on PostgreSQL 17 (#4923 Phase 1, #4925).
// Verifies Role x Enabled-App defaults (including member + finance.viewer), non-destructive disabled-app saving,
// customized order/reset persistence, audit + outbox recording, and membership cascade.
// Security/RLS/CHECK/actor-denial/stream invariants live in apps/kernel/test/invariant/home-layout.db.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HomeLayoutSaveInput, HomeLayoutView } from '@ludy/kernel-contract';
import { Runtime, defineQuery } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ALL_MODULES = ['kernel', 'finance', 'social', 'ads', 'crm', 'notes', 'hr', 'meetings', 'projects', 'sign'] as const;
const suite = ADMIN ? describe : describe.skip;

suite('member_home_layout product flows on PostgreSQL (#4925)', () => {
  const dbName = `ludy_test_home_layout_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) =>
    upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@home.test`, name: null });

  type OrgFixture = {
    orgId: string;
    owner: string;
    adminUser: string;
    accountant: string;
    financeViewer: string;
    salesMember: string;
    hrMember: string;
    viewer: string;
  };

  async function setupOrg(): Promise<OrgFixture> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const fixture: OrgFixture = {
      orgId,
      owner,
      adminUser: await person('admin'),
      accountant: await person('accountant'),
      financeViewer: await person('finviewer'),
      salesMember: await person('sales'),
      hrMember: await person('hr'),
      viewer: await person('viewer'),
    };
    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'viewer')`,
        [orgId, fixture.adminUser, fixture.accountant, fixture.financeViewer, fixture.salesMember, fixture.hrMember, fixture.viewer],
      );
    });
    await rt.execute('kernel.member.role.assign', { userId: fixture.accountant, roleKey: 'finance.accountant', legalEntityId: null }, { actor: asMfa(owner), orgId });
    await rt.execute('kernel.member.role.assign', { userId: fixture.financeViewer, roleKey: 'finance.viewer', legalEntityId: null }, { actor: asMfa(owner), orgId });
    await rt.execute('kernel.member.role.assign', { userId: fixture.salesMember, roleKey: 'crm.sales', legalEntityId: null }, { actor: asMfa(owner), orgId });
    await rt.execute('kernel.member.role.assign', { userId: fixture.hrMember, roleKey: 'hr.manager', legalEntityId: null }, { actor: asMfa(owner), orgId });
    return fixture;
  }

  const getLayout = (orgId: string, userId: string) =>
    rt.query<HomeLayoutView>('kernel.member.home_layout.get', {}, { actor: asUser(userId), orgId });

  const saveLayout = (orgId: string, userId: string, input: HomeLayoutSaveInput) =>
    rt.execute<HomeLayoutView>('kernel.member.home_layout.save', input, { actor: asUser(userId), orgId });

  const setApp = (orgId: string, ownerId: string, module: string, enabled: boolean) =>
    rt.execute('kernel.org.set_app', { module, enabled }, { actor: asUser(ownerId), orgId });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';

    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);

    const moduleProbes = ALL_MODULES.filter((m) => m !== 'kernel').map((m) =>
      defineQuery({ name: `${m}.probe`, input: z.object({}), access: ['owner'], handler: async () => null }),
    );
    const registry = {
      commands: buildKernelCommands({ apps: { deployment: ALL_MODULES, entitlements: async () => ['full'] } }),
      queries: [
        ...kernelQueries({
          inboundDomain: null,
          apps: { shipped: ALL_MODULES, deployment: ALL_MODULES, entitlements: async () => ['full'] },
        }),
        ...moduleProbes,
      ],
    };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('computes Role x Enabled-App defaults and hides disabled modules without deleting saved layouts', async () => {
    const o = await setupOrg();

    const ownerView = await getLayout(o.orgId, o.owner);
    expect(ownerView.customized).toBe(false);
    expect(ownerView.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', true],
      ['finance_approvals', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const adminView = await getLayout(o.orgId, o.adminUser);
    expect(adminView.blocks).toEqual(ownerView.blocks);

    const accountantView = await getLayout(o.orgId, o.accountant);
    expect(accountantView.blocks.map((b) => [b.id, b.visible])).toEqual(ownerView.blocks.map((b) => [b.id, b.visible]));

    // Member with finance.viewer gets finance_tax_deadlines by default, NOT finance_approvals.
    const financeViewerView = await getLayout(o.orgId, o.financeViewer);
    expect(financeViewerView.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const salesView = await getLayout(o.orgId, o.salesMember);
    expect(salesView.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['finance_tax_deadlines', false],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
      ['hr_pending', true],
      ['esign_pending', true],
    ]);

    const hrView = await getLayout(o.orgId, o.hrMember);
    expect(hrView.blocks.map((b) => [b.id, b.visible])).toEqual(salesView.blocks.map((b) => [b.id, b.visible]));

    const viewerView = await getLayout(o.orgId, o.viewer);
    expect(viewerView.blocks.map((b) => [b.id, b.visible])).toEqual([['teamwork_my_work', true]]);

    // Save customized order for owner, toggle finance off, save another change, then toggle finance back on.
    await saveLayout(o.orgId, o.owner, {
      blocks: [
        { id: 'esign_pending', visible: true },
        { id: 'finance_approvals', visible: false },
        { id: 'finance_tax_deadlines', visible: true },
        { id: 'teamwork_my_work', visible: true },
        { id: 'engage_pipeline', visible: true },
        { id: 'hr_pending', visible: true },
      ],
    });

    await setApp(o.orgId, o.owner, 'finance', false);
    const whileFinanceOff = await getLayout(o.orgId, o.owner);
    expect(whileFinanceOff.customized).toBe(true);
    expect(whileFinanceOff.blocks.map((b) => b.id)).toEqual(['esign_pending', 'teamwork_my_work', 'engage_pipeline', 'hr_pending']);

    // Edit and save while Finance is off: saved hidden Finance preferences & relative anchor stay intact.
    await saveLayout(o.orgId, o.owner, {
      blocks: [
        { id: 'hr_pending', visible: false },
        { id: 'esign_pending', visible: true },
        { id: 'teamwork_my_work', visible: true },
        { id: 'engage_pipeline', visible: true },
      ],
    });

    await setApp(o.orgId, o.owner, 'finance', true);
    const afterFinanceBackOn = await getLayout(o.orgId, o.owner);
    expect(afterFinanceBackOn.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['hr_pending', false],
      ['esign_pending', true],
      ['finance_approvals', false],
      ['finance_tax_deadlines', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
    ]);

    // Mid-edit re-enable race: editor opened with Finance off, admin re-enables Finance before member saves partial payload.
    await setApp(o.orgId, o.owner, 'finance', false);
    const draftWithoutFinance = (await getLayout(o.orgId, o.owner)).blocks.map(({ id, visible }) => ({ id, visible }));
    await setApp(o.orgId, o.owner, 'finance', true);
    const afterMidEditReenable = await saveLayout(o.orgId, o.owner, { blocks: draftWithoutFinance });
    expect(afterMidEditReenable.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['hr_pending', false],
      ['esign_pending', true],
      ['finance_approvals', false],
      ['finance_tax_deadlines', true],
      ['teamwork_my_work', true],
      ['engage_pipeline', true],
    ]);

    // Switching notes off hides viewer's teamwork_my_work read-only notes block.
    await setApp(o.orgId, o.owner, 'notes', false);
    const viewerNotesOff = await getLayout(o.orgId, o.viewer);
    expect(viewerNotesOff.blocks).toEqual([]);
  });

  it('persists customized order, appends missing defaults, resets cleanly, cascades on member removal, and rejects invalid Zod inputs', async () => {
    const o = await setupOrg();

    await expect(saveLayout(o.orgId, o.owner, { blocks: [{ id: 'bogus_block' as never, visible: true }] })).rejects.toMatchObject({
      code: 'VALIDATION',
      status: 422,
    });
    await expect(
      saveLayout(o.orgId, o.owner, {
        blocks: [
          { id: 'teamwork_my_work', visible: true },
          { id: 'teamwork_my_work', visible: false },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(saveLayout(o.orgId, o.owner, { blocks: [] })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    const saved = await saveLayout(o.orgId, o.owner, {
      blocks: [
        { id: 'hr_pending', visible: false },
        { id: 'teamwork_my_work', visible: true },
      ],
    });
    expect(saved.customized).toBe(true);
    expect(saved.blocks.map((b) => [b.id, b.visible])).toEqual([
      ['hr_pending', false],
      ['teamwork_my_work', true],
      ['finance_tax_deadlines', true],
      ['finance_approvals', true],
      ['engage_pipeline', true],
      ['esign_pending', true],
    ]);

    const reloaded = await getLayout(o.orgId, o.owner);
    expect(reloaded).toEqual(saved);

    const reset = await saveLayout(o.orgId, o.owner, { reset: true });
    expect(reset.customized).toBe(false);
    expect(reset.blocks).toEqual(reset.defaults);

    const afterReset = await getLayout(o.orgId, o.owner);
    expect(afterReset.customized).toBe(false);
    expect(afterReset.blocks).toEqual(afterReset.defaults);

    const auditRows = await admin(async (c) =>
      (
        await c.query<{ command: string; detail: Record<string, unknown> }>(
          `SELECT command, detail FROM ludy_kernel.audit_event
           WHERE org_id = $1 AND command = 'kernel.member.home_layout.save' ORDER BY occurred_at`,
          [o.orgId],
        )
      ).rows,
    );
    expect(auditRows.map((r) => r.detail)).toEqual([
      { reset: false, blockCount: 2 },
      { reset: true, blockCount: 0 },
    ]);

    const events = await admin(async (c) =>
      (
        await c.query<{ type: string; payload: Record<string, unknown> }>(
          `SELECT type, payload FROM ludy_kernel.outbox_event
           WHERE org_id = $1 AND type = 'kernel.member.home_layout_updated' ORDER BY created_at`,
          [o.orgId],
        )
      ).rows,
    );
    expect(events.map((e) => e.payload)).toEqual([
      { userId: o.owner, reset: false, blockCount: 2 },
      { userId: o.owner, reset: true, blockCount: 0 },
    ]);

    // Removing the member cascades and deletes their saved layout row.
    await saveLayout(o.orgId, o.salesMember, { blocks: [{ id: 'engage_pipeline', visible: false }] });
    await admin((c) => c.query('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.salesMember]));
    const left = await admin((c) =>
      c.query<{ user_id: string }>('SELECT user_id FROM ludy_kernel.member_home_layout WHERE org_id = $1', [o.orgId]),
    );
    expect(left.rows).toEqual([]);
  });
});
