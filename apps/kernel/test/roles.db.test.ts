// SPDX-License-Identifier: AGPL-3.0-only
// Product flows for the Marketing department preset role (social.marketer, issue #2612, ADR-0049 decision 10) on
// PostgreSQL 17: offered only when social runs (never by ads alone), assigned and revoked through Runtime.execute()
// with R3 step-up, granting a viewer vy.use and no other permission, honoring an owner deny, and carried through
// member.invite.create and member.invite.accept.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MemberRoles } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { adsCommands, adsManifest, adsQueries } from '@crove/mod-ads';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface CreatedInvite {
  inviteId: string;
  acceptPath: string;
}

suite('Marketing preset role social.marketer (#2612)', () => {
  const dbName = `crove_test_role_marketer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let socialRuntime: Runtime;
  let adsOnlyRuntime: Runtime;
  let orgId = '';
  let branchId = '';
  let owner = { id: '', email: '' };
  let adminUser = { id: '', email: '' };
  let memberUser = { id: '', email: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '6c3f8a2b-1e5d-4c7a-9b80-3d2e1f0a8b25',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function person(prefix: string) {
    const email = `${prefix}-${randomUUID().slice(0, 8)}@marketer-role.test`;
    const id = await upsertIdentity(db, { issuer: 'marketer-role', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  async function asked(userId: string, permission: string) {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const out = await c.query<{ held: boolean; vy: boolean }>(
        'SELECT crove_kernel.ctx_has_permission($1) AS held, crove_kernel.ctx_vy_use() AS vy',
        [permission],
      );
      return out.rows[0] as { held: boolean; vy: boolean };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
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
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    db = createDb(pool);
    const manifests = [...TEST_MANIFESTS, adsManifest.tables];
    socialRuntime = new Runtime(db, { manifests }).register({
      commands: [...kernelCommands, ...socialCommands, ...adsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...socialQueries, ...adsQueries],
    });
    adsOnlyRuntime = new Runtime(db, { manifests }).register({
      commands: [...kernelCommands, ...adsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...adsQueries],
    });
    owner = await person('owner');
    adminUser = await person('admin');
    memberUser = await person('member');
    orgId = (await createOrg(socialRuntime, asUser(owner.id), 'Công ty Marketing')).orgId;
    await admin((c) =>
      c.query(
        "INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')",
        [orgId, adminUser.id, memberUser.id],
      ),
    );
    branchId = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            "INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Đà Nẵng', 'branch', $2) RETURNING id",
            [orgId, owner.id],
          )
        ).rows[0]?.id as string,
    );
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('offers social.marketer with vy.use when social runs, and omits and refuses it when social is off even if ads runs', async () => {
    const withSocial = await socialRuntime.query<MemberRoles>('kernel.member.roles.list', {}, { actor: asUser(owner.id), orgId });
    expect(withSocial.roles.find((r) => r.key === 'social.marketer')).toEqual({
      key: 'social.marketer',
      scope: 'org',
      permissions: ['vy.use'],
    });

    const withoutSocial = await adsOnlyRuntime.query<MemberRoles>('kernel.member.roles.list', {}, { actor: asUser(owner.id), orgId });
    expect(withoutSocial.roles.some((r) => r.key === 'social.marketer')).toBe(false);

    await expect(
      adsOnlyRuntime.execute(
        'kernel.member.role.assign',
        { userId: memberUser.id, roleKey: 'social.marketer', legalEntityId: null },
        { actor: asMfa(owner.id), orgId },
      ),
    ).rejects.toMatchObject({ code: 'ROLE_MODULE_NOT_INSTALLED' });

    await expect(
      adsOnlyRuntime.execute(
        'kernel.member.invite.create',
        { email: 'ads-only@marketer-role.test', role: 'member', roleKey: 'social.marketer' },
        { actor: asMfa(owner.id), orgId },
      ),
    ).rejects.toMatchObject({ code: 'ROLE_MODULE_NOT_INSTALLED' });
  });

  it('enforces owner + MFA and org scope, grants a viewer vy.use alone, honors an owner deny, and revokes cleanly', async () => {
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer.id]),
    );

    const orgForViewer = () => socialRuntime.query<{ permissions: string[] }>('kernel.org.get', {}, { actor: asUser(viewer.id), orgId });
    expect((await orgForViewer()).permissions).toEqual([]);
    expect(await asked(viewer.id, 'vy.use')).toEqual({ held: false, vy: false });

    await expect(
      socialRuntime.execute(
        'kernel.member.role.assign',
        { userId: viewer.id, roleKey: 'social.marketer', legalEntityId: null },
        { actor: asUser(owner.id), orgId },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });

    await expect(
      socialRuntime.execute(
        'kernel.member.role.assign',
        { userId: viewer.id, roleKey: 'social.marketer', legalEntityId: null },
        { actor: asMfa(adminUser.id), orgId },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      socialRuntime.execute(
        'kernel.member.role.assign',
        { userId: viewer.id, roleKey: 'social.marketer', legalEntityId: branchId },
        { actor: asMfa(owner.id), orgId },
      ),
    ).rejects.toMatchObject({ code: 'ROLE_SCOPE_NOT_ALLOWED' });

    const assigned = await socialRuntime.execute<{ assignmentId: string; created: boolean }>(
      'kernel.member.role.assign',
      { userId: viewer.id, roleKey: 'social.marketer', legalEntityId: null },
      { actor: asMfa(owner.id), orgId },
    );
    expect(assigned.created).toBe(true);
    expect((await orgForViewer()).permissions).toEqual(['vy.use']);
    expect(await asked(viewer.id, 'vy.use')).toEqual({ held: true, vy: true });
    expect((await asked(viewer.id, 'finance.period.unlock')).held).toBe(false);
    expect((await asked(viewer.id, 'kernel.conversation.direct.read')).held).toBe(false);

    // An owner deny overrides the role grant; clearing the exception restores vy.use from social.marketer.
    await socialRuntime.execute(
      'kernel.member.permission.set',
      { userId: viewer.id, permission: 'vy.use', allowed: false },
      { actor: asUser(owner.id), orgId },
    );
    expect((await orgForViewer()).permissions).toEqual([]);
    expect(await asked(viewer.id, 'vy.use')).toEqual({ held: false, vy: false });

    await socialRuntime.execute(
      'kernel.member.permission.set',
      { userId: viewer.id, permission: 'vy.use', allowed: null },
      { actor: asUser(owner.id), orgId },
    );
    expect((await orgForViewer()).permissions).toEqual(['vy.use']);
    expect(await asked(viewer.id, 'vy.use')).toEqual({ held: true, vy: true });

    await socialRuntime.execute(
      'kernel.member.role.revoke',
      { assignmentId: assigned.assignmentId },
      { actor: asMfa(owner.id), orgId },
    );
    expect((await orgForViewer()).permissions).toEqual([]);
    expect(await asked(viewer.id, 'vy.use')).toEqual({ held: false, vy: false });
  });

  it('carries social.marketer through invite creation and acceptance for both a member and a viewer', async () => {
    const invitedViewer = await person('inv-viewer');
    const invitedMember = await person('inv-member');

    for (const [invitee, baseRole] of [
      [invitedViewer, 'viewer'],
      [invitedMember, 'member'],
    ] as const) {
      const created = await socialRuntime.execute<CreatedInvite>(
        'kernel.member.invite.create',
        { email: invitee.email, role: baseRole, roleKey: 'social.marketer' },
        { actor: asMfa(owner.id), orgId },
      );
      const token = created.acceptPath.slice(created.acceptPath.indexOf('#') + 1);
      const accepted = await socialRuntime.executeOrgless<{ orgId: string; role: string }>(
        'kernel.member.invite.accept',
        { token },
        { actor: asUser(invitee.id) },
      );
      expect(accepted).toMatchObject({ orgId, role: baseRole });
    }

    const listed = await socialRuntime.query<MemberRoles>('kernel.member.roles.list', {}, { actor: asUser(owner.id), orgId });
    expect(listed.assignments.filter((a) => a.userId === invitedViewer.id)).toMatchObject([
      { userId: invitedViewer.id, roleKey: 'social.marketer', legalEntityId: null },
    ]);
    expect(listed.assignments.filter((a) => a.userId === invitedMember.id)).toMatchObject([
      { userId: invitedMember.id, roleKey: 'social.marketer', legalEntityId: null },
    ]);

    const viewerOrg = await socialRuntime.query<{ permissions: string[] }>(
      'kernel.org.get',
      {},
      { actor: asUser(invitedViewer.id), orgId },
    );
    expect(viewerOrg.permissions).toEqual(['vy.use']);
    expect(await asked(invitedViewer.id, 'vy.use')).toEqual({ held: true, vy: true });
  });
});
