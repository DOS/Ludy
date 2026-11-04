// SPDX-License-Identifier: AGPL-3.0-only
// Invites that carry a department role (issue #2611, plan §4.6, after #1281's scoped invites) on a real PostgreSQL 17: only an
// owner sends one, never with an entity limit, and the database refuses any other such row; on accept the invitee joins
// holding the role, granted as the inviter, by the same rules role.assign applies; an invite whose inviter stopped being an
// owner (removed or demoted), whose role stopped passing a grant's rules, or whose module is gone, adds nobody (never the
// base role alone); an invite never changes an existing member's access; the role key never changes after insert; and the
// invitee's preview shows the role's key and nothing of what it grants.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type InviteRole = 'admin' | 'member' | 'viewer';
interface Created {
  inviteId: string;
  acceptPath: string;
}

suite('invites that carry a department role on PostgreSQL (#2611)', () => {
  const dbName = `crove_test_role_invites_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // finance is installed here, so its roles are offered; crm is not.
  let runtime: Runtime;
  // A deployment that left finance out: accepting there refuses a finance role.
  let bare: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '5b2e7c1a-9d4f-4e3b-8a60-2c1d0e9f7a14',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string) {
    const email = `${name}-${randomUUID().slice(0, 8)}@roleinv.test`;
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  // An org with an owner, an admin and one entity-scoped legal entity.
  async function org() {
    const owner = await person('owner');
    const adminUser = await person('admin');
    const { orgId } = await createOrg(runtime, asUser(owner.id), `RoleInv ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser.id]));
    const entity = await admin(
      async (c) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh A', 'branch', $2) RETURNING id`, [orgId, owner.id]))
          .rows[0]?.id as string,
    );
    return { orgId, owner, adminUser, entity };
  }

  const invite = (orgId: string, inviter: string, email: string, role: InviteRole, extra: { roleKey?: string; legalEntityIds?: string[] } = {}) =>
    runtime.execute<Created>('kernel.member.invite.create', { email, role, ...extra }, { actor: asMfa(inviter), orgId });
  const tokenOf = (created: Created) => created.acceptPath.slice(created.acceptPath.indexOf('#') + 1);
  const accept = (token: string, userId: string, rt: Runtime = runtime) =>
    rt.executeOrgless<{ orgId: string; role: string }>('kernel.member.invite.accept', { token }, { actor: asUser(userId) });
  const assignments = (orgId: string, userId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ role_key: string; legal_entity_id: string | null; granted_by: string }>(
            'SELECT role_key, legal_entity_id, granted_by FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 ORDER BY role_key',
            [orgId, userId],
          )
        ).rows,
    );
  const membership = (orgId: string, userId: string) =>
    admin(async (c) => (await c.query<{ role: string }>('SELECT role FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows[0]?.role ?? null);
  const inviteStatus = (orgId: string, inviteId: string) =>
    admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.member_invite WHERE org_id = $1 AND id = $2', [orgId, inviteId])).rows[0]?.status);
  const auditOf = (orgId: string, command: string, actor: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' AND actor_id = $3 ORDER BY occurred_at DESC LIMIT 1`,
            [orgId, command, actor],
          )
        ).rows[0]?.detail,
    );

  // A raw insert of an invite row in the sealed context of a user, as the API login role does.
  async function rawInvite(orgId: string, contextUser: string, inviter: string, columns: { roleKey: string; role?: string; entities?: string[] }) {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(contextUser, orgId)]);
      await app.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, role_key, legal_entity_ids) VALUES ($1, $2, $3, $4, $5, $6::uuid[])`,
        [orgId, `raw-${randomUUID().slice(0, 6)}@roleinv.test`, columns.role ?? 'member', inviter, columns.roleKey, columns.entities ?? null],
      );
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    } finally {
      await app.end();
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
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: kernelQueries({ inboundDomain: null }) });
    bare = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only an owner send a role invite, never with an entity limit, and refuses what role.assign would refuse', async () => {
    const o = await org();
    const invitee = await person('invitee');
    await expect(invite(o.orgId, o.adminUser.id, invitee.email, 'member', { roleKey: 'finance.accountant' })).rejects.toMatchObject({ code: 'INVITE_ROLE_OWNER_ONLY', status: 403 });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', { roleKey: 'finance.accountant', legalEntityIds: [o.entity] })).rejects.toMatchObject({
      code: 'INVITE_ROLE_WITH_ENTITIES',
      status: 422,
    });
    // An entity role is the entity limit, not a department pick; a role of a module this deployment does not run is refused.
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', { roleKey: 'external_accountant' })).rejects.toMatchObject({ code: 'ROLE_SCOPE_REQUIRED' });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', { roleKey: 'crm.sales' })).rejects.toMatchObject({ code: 'ROLE_MODULE_NOT_INSTALLED' });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', { roleKey: 'not.a_role' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A viewer gets no role that grants a permission, the rule of role.assign (ROLE_PRIVILEGED_FOR_VIEWER).
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'viewer', { roleKey: 'finance.chief_accountant' })).rejects.toMatchObject({ code: 'ROLE_PRIVILEGED_FOR_VIEWER' });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.member_invite WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
    // What the inviter gets back is the same as for any invite: no role key in it (the list and the audit carry it).
    const ok = await invite(o.orgId, o.owner.id, invitee.email, 'viewer', { roleKey: 'finance.accountant' });
    expect(Object.keys(ok).sort()).toEqual(['acceptPath', 'email', 'expiresAt', 'inviteId', 'role']);
  });

  it('refuses a role invite row from anyone but an owner of the org naming itself, and one that also names entities', async () => {
    const o = await org();
    await expect(rawInvite(o.orgId, o.adminUser.id, o.adminUser.id, { roleKey: 'finance.accountant' })).rejects.toMatchObject({ message: 'INVITE_ROLE_OWNER_ONLY' });
    await expect(rawInvite(o.orgId, o.adminUser.id, o.owner.id, { roleKey: 'finance.accountant' })).rejects.toMatchObject({ message: 'INVITE_ROLE_OWNER_ONLY' });
    // The grant rules, in the database too: an entity role needs an entity, a viewer takes no privileged role.
    await expect(rawInvite(o.orgId, o.owner.id, o.owner.id, { roleKey: 'external_accountant' })).rejects.toMatchObject({ message: 'ROLE_SCOPE_REQUIRED' });
    await expect(rawInvite(o.orgId, o.owner.id, o.owner.id, { roleKey: 'finance.chief_accountant', role: 'viewer' })).rejects.toMatchObject({ message: 'ROLE_PRIVILEGED_FOR_VIEWER' });
    await expect(rawInvite(o.orgId, o.owner.id, o.owner.id, { roleKey: 'finance.accountant', entities: [o.entity] })).rejects.toMatchObject({ code: '23514' });
    await expect(rawInvite(o.orgId, o.owner.id, o.owner.id, { roleKey: 'no.such_role' })).rejects.toMatchObject({ message: 'ROLE_NOT_FOUND' });
    await rawInvite(o.orgId, o.owner.id, o.owner.id, { roleKey: 'finance.accountant' });
  });

  it('never changes the role key after insert', async () => {
    const o = await org();
    const created = await invite(o.orgId, o.owner.id, (await person('fixed')).email, 'member', { roleKey: 'finance.accountant' });
    await expect(admin((c) => c.query("UPDATE crove_kernel.member_invite SET role_key = 'finance.viewer' WHERE id = $1", [created.inviteId]))).rejects.toMatchObject({ message: 'INVITE_IMMUTABLE' });
    await expect(admin((c) => c.query('UPDATE crove_kernel.member_invite SET role_key = NULL WHERE id = $1', [created.inviteId]))).rejects.toMatchObject({ message: 'INVITE_IMMUTABLE' });
  });

  it('gives the invitee the role as the inviter, in their first context, with the key in the audit and the preview', async () => {
    const o = await org();
    const invitee = await person('accountant');
    const created = await invite(o.orgId, o.owner.id, invitee.email, 'member', { roleKey: 'finance.chief_accountant' });
    await expect(runtime.query('kernel.member.invites.list', {}, { actor: asUser(o.owner.id), orgId: o.orgId })).resolves.toMatchObject([
      { id: created.inviteId, role: 'member', roleKey: 'finance.chief_accountant', legalEntityIds: null },
    ]);
    expect(await auditOf(o.orgId, 'kernel.member.invite.create', o.owner.id)).toMatchObject({ invite_id: created.inviteId, role: 'member', role_key: 'finance.chief_accountant' });
    // The preview names the role's key and nothing of what it grants (it is reachable before membership).
    const peek = await admin(async (c) => (await c.query<Record<string, unknown>>('SELECT * FROM crove_kernel.invite_peek($1::uuid, $2, false)', [invitee.id, tokenOf(created)])).rows[0]);
    expect(peek).toMatchObject({ role: 'member', role_key: 'finance.chief_accountant' });
    expect(Object.keys(peek ?? {}).sort()).toEqual(['expires_at', 'invited_by_email', 'invited_by_name', 'org_name', 'role', 'role_key']);
    await expect(accept(tokenOf(created), invitee.id)).resolves.toMatchObject({ orgId: o.orgId, role: 'member' });
    expect(await assignments(o.orgId, invitee.id)).toEqual([{ role_key: 'finance.chief_accountant', legal_entity_id: null, granted_by: o.owner.id }]);
    expect(await auditOf(o.orgId, 'kernel.member.invite.accept', invitee.id)).toMatchObject({ role_key: 'finance.chief_accountant', role_applied: true, role: 'member' });
    // An ordinary invite carries no role and applies none.
    const plain = await person('plain');
    await accept(tokenOf(await invite(o.orgId, o.adminUser.id, plain.email, 'member')), plain.id);
    expect(await assignments(o.orgId, plain.id)).toEqual([]);
    expect(await auditOf(o.orgId, 'kernel.member.invite.accept', plain.id)).toMatchObject({ role_key: null, role_applied: false });
  });

  it('adds nobody when the inviter is no longer an owner, never falling back to the base role', async () => {
    const o = await org();
    const coOwner = await person('co-owner');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'owner')", [o.orgId, coOwner.id]));
    const late = await person('late');
    const byCoOwner = await invite(o.orgId, coOwner.id, late.email, 'member', { roleKey: 'finance.accountant' });
    // Demoted to admin behind the command's back: an admin may still invite a member, but no longer give a role.
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [o.orgId, coOwner.id]));
    await expect(accept(tokenOf(byCoOwner), late.id)).rejects.toMatchObject({ code: 'INVITE_ROLE_STALE', status: 409 });
    expect(await membership(o.orgId, late.id)).toBeNull();
    expect(await assignments(o.orgId, late.id)).toEqual([]);
    expect(await inviteStatus(o.orgId, byCoOwner.inviteId)).toBe('pending');

    // Removed from the org: the invite is revoked by the command and stays refused behind its back.
    const gone = await person('gone');
    const removed = await person('removed-owner');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'owner')", [o.orgId, removed.id]));
    const byRemoved = await invite(o.orgId, removed.id, gone.email, 'member', { roleKey: 'finance.accountant' });
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, removed.id]));
    await expect(accept(tokenOf(byRemoved), gone.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    expect(await membership(o.orgId, gone.id)).toBeNull();
  });

  it('revokes a demoted owner\'s role invites in the same command, and keeps the invites an admin may still send', async () => {
    const o = await org();
    const coOwner = await person('demoted');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'owner')", [o.orgId, coOwner.id]));
    const withRole = await invite(o.orgId, coOwner.id, (await person('with-role')).email, 'member', { roleKey: 'finance.accountant' });
    const plain = await invite(o.orgId, coOwner.id, (await person('plain-member')).email, 'member');
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'admin' }, { actor: asMfa(o.owner.id), orgId: o.orgId });
    expect(await inviteStatus(o.orgId, withRole.inviteId)).toBe('revoked');
    expect(await inviteStatus(o.orgId, plain.inviteId)).toBe('pending');
    const audit = await auditOf(o.orgId, 'kernel.member.change_role', o.owner.id);
    expect((audit as { revoked_invites?: string[] } | undefined)?.revoked_invites).toEqual([withRole.inviteId]);
  });

  it('refuses the whole accept when the role no longer passes a grant\'s rules or its module is gone', async () => {
    const o = await org();
    // finance.accountant grants nothing, so a viewer may take it; if the role later grants a permission, a viewer may not.
    const viewer = await person('viewer');
    const created = await invite(o.orgId, o.owner.id, viewer.email, 'viewer', { roleKey: 'finance.accountant' });
    await admin((c) => c.query("INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES ('finance.accountant', 'finance.test.probe')"));
    try {
      await expect(accept(tokenOf(created), viewer.id)).rejects.toMatchObject({ code: 'INVITE_ROLE_STALE', status: 409 });
    } finally {
      await admin((c) => c.query("DELETE FROM crove_kernel.role_permission WHERE role_key = 'finance.accountant' AND permission = 'finance.test.probe'"));
    }
    expect(await membership(o.orgId, viewer.id)).toBeNull();
    expect(await assignments(o.orgId, viewer.id)).toEqual([]);

    // The module left the deployment between the invite and the accept: the database granted the role in this transaction,
    // the accept command refuses, and everything rolls back.
    const member = await person('member');
    const second = await invite(o.orgId, o.owner.id, member.email, 'member', { roleKey: 'finance.accountant' });
    await expect(accept(tokenOf(second), member.id, bare)).rejects.toMatchObject({ code: 'INVITE_ROLE_STALE', status: 409 });
    expect(await membership(o.orgId, member.id)).toBeNull();
    expect(await assignments(o.orgId, member.id)).toEqual([]);
    expect(await inviteStatus(o.orgId, second.inviteId)).toBe('pending');
    // The same invite still works where the module runs.
    await expect(accept(tokenOf(second), member.id)).resolves.toMatchObject({ orgId: o.orgId });
    expect(await assignments(o.orgId, member.id)).toEqual([{ role_key: 'finance.accountant', legal_entity_id: null, granted_by: o.owner.id }]);
  });

  it('never changes an existing member\'s access', async () => {
    const o = await org();
    const second = await person('second');
    const pending = await invite(o.orgId, o.owner.id, second.email, 'member', { roleKey: 'finance.accountant' });
    // The invitee joined another way while the invite was pending: refused, nothing changed, the invite still pending.
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, second.id]));
    await expect(accept(tokenOf(pending), second.id)).rejects.toMatchObject({ code: 'INVITE_ROLE_ALREADY_MEMBER', status: 409 });
    expect(await inviteStatus(o.orgId, pending.inviteId)).toBe('pending');
    expect(await membership(o.orgId, second.id)).toBe('member');
    expect(await assignments(o.orgId, second.id)).toEqual([]);
  });

  it('keeps the EXECUTE matrix of invite_accept and invite_peek, and no login role can call the guard or the check', async () => {
    const functions = [
      'crove_kernel.invite_accept(uuid,text,boolean)',
      'crove_kernel.invite_peek(uuid,text,boolean)',
      'crove_kernel.invite_for_user(uuid,text,boolean,boolean)',
      'crove_kernel.member_invite_guard()',
      'crove_kernel.member_invite_role_guard()',
      'crove_kernel.role_assignment_check(uuid,uuid,text,text,uuid)',
    ];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roles],
      );
      return Object.fromEntries(functions.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_kernel.invite_accept(uuid,text,boolean)': ['crove_app'],
      'crove_kernel.invite_peek(uuid,text,boolean)': ['crove_app'],
      'crove_kernel.invite_for_user(uuid,text,boolean,boolean)': [],
      'crove_kernel.member_invite_guard()': [],
      'crove_kernel.member_invite_role_guard()': [],
      'crove_kernel.role_assignment_check(uuid,uuid,text,text,uuid)': [],
    });
    // The guard keeps its search_path pinned, and the old three-argument peek is gone (one peek, with the role key).
    const catalog = await admin(
      async (c) =>
        (
          await c.query<{ proname: string; config: string[] | null }>(
            `SELECT proname, proconfig AS config FROM pg_proc WHERE oid IN ('crove_kernel.member_invite_role_guard()'::regprocedure, 'crove_kernel.role_assignment_check(uuid,uuid,text,text,uuid)'::regprocedure) ORDER BY proname`,
          )
        ).rows,
    );
    for (const row of catalog) expect(row.config).toContain('search_path=pg_catalog, pg_temp');
  });
});
