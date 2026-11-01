// SPDX-License-Identifier: AGPL-3.0-only
// Saved views of a list on PostgreSQL 17 (CRM slice 1, step K3, #2227): a private view is its owner's alone and a shared
// one every member's, in the commands and in the table's own policy below them; owners and admins change a shared view
// but never make it private; at most 30 per member and scope, under a lock; an unknown scope, field or operator is a 422;
// a view goes with its member and with the org. The Filter AST becomes a SQL condition: every operator of the registry
// runs against real rows, and a view applied under a member's context only narrows what row-level security lets them
// read. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import {
  amountCompare,
  createOrg,
  dateCompare,
  filterCondition,
  flagIs,
  hasText,
  idIn,
  idIs,
  kernelCommands,
  kernelQueries,
  memberIs,
  sortTerms,
  textContains,
  upsertIdentity,
  valueIs,
  withinLastDays,
  type FieldCondition,
  type FilterContext,
} from '@crove/kernel';
import { SAVED_VIEW_LIMIT, SAVED_VIEW_SCOPES, type FilterAst, type SavedView } from '@crove/kernel-contract';
import { Runtime, defineQuery } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Every saved view the caller's context reads, with no filter of its own: what the table's policy lets through.
const rawViews = defineQuery({
  name: 'test.saved_view.raw',
  input: z.object({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx) => (await ctx.trx.selectFrom('crove_kernel.saved_view').select(['id', 'name']).orderBy('name').execute()).map((r) => r.name),
});

// The contacts of the caller's org whose view applies, through the `crm.party` conditions below, under the member's context:
// what a view of the contacts lists. The condition is ANDed into a query that row-level security already narrows.
const NOW = new Date('2026-11-10T05:00:00Z');
const TODAY = '2026-11-10';
const partyFields = (): Record<string, FieldCondition> => ({
  search: textContains([sql`p.name`, sql`p.email`, sql`p.phone`, sql`p.tax_code`]),
  kind: valueIs(sql`p.kind`),
  has_email: flagIs(hasText(sql`p.email`)),
  has_phone: flagIs(hasText(sql`p.phone`)),
  has_tax_code: flagIs(hasText(sql`p.tax_code`)),
  has_open_deal: flagIs(sql`false`),
  created: withinLastDays(sql`p.created_at`),
});
const viewedParties = defineQuery({
  name: 'test.party.viewed',
  input: z.object({ filters: z.unknown() }),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) => {
    const me = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const where = filterCondition('crm.party', input.filters as FilterAst, partyFields(), { me, today: TODAY, now: NOW });
    const rows = await sql<{ name: string }>`SELECT p.name FROM crove_kernel.party p WHERE ${where} ORDER BY p.name`.execute(ctx.trx);
    return rows.rows.map((r) => r.name);
  },
});

suite('saved views on PostgreSQL (CRM K3, #2227)', () => {
  const dbName = `crove_test_saved_views_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let adminDb: Db;
  let adminPool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  // A statement in a member's context as the API's login (crove_app), always rolled back: the policy, not a command.
  async function asApp<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@views.test`, name: null });
  }
  type Org = { orgId: string; owner: string; admin: string; lan: string; minh: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), lan: await person('lan'), minh: await person('minh'), viewer: await person('viewer') };
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [
        orgId,
        o.admin,
        o.lan,
        o.minh,
        o.viewer,
      ]),
    );
    return o;
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const list = (o: Org, user: string, scope = 'crm.deal') => rt.query<SavedView[]>('kernel.saved_view.list', { scope }, { actor: asUser(user), orgId: o.orgId });
  const raw = (o: Org, user: string) => rt.query<string[]>('test.saved_view.raw', {}, { actor: asUser(user), orgId: o.orgId });
  const none: FilterAst = { v: 1, all: [] };
  const save = (o: Org, user: string, input: Record<string, unknown>) =>
    exec<{ viewId: string }>(o, user, 'kernel.saved_view.save', { scope: 'crm.deal', filters: none, shared: false, ...input });

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    adminDb = createDb(adminPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null }), rawViews, viewedParties] });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows a private view to its owner alone and a shared one to every member, in the commands and in the policy', async () => {
    const o = await org();
    const mine = await save(o, o.lan, { name: 'Của tôi', filters: { v: 1, all: [{ field: 'owner', op: 'is_me' }] }, sort: { field: 'amount', dir: 'desc' } });
    const team = await save(o, o.lan, { name: 'Đang mở', filters: { v: 1, all: [{ field: 'status', op: 'is', value: 'open' }] }, shared: true });
    expect(await list(o, o.lan)).toEqual([
      {
        id: mine.viewId,
        scope: 'crm.deal',
        name: 'Của tôi',
        filters: { v: 1, all: [{ field: 'owner', op: 'is_me' }] },
        sort: { field: 'amount', dir: 'desc' },
        shared: false,
        ownerId: o.lan,
        mine: true,
        canChange: true,
        updatedAt: expect.any(String),
      },
      {
        id: team.viewId,
        scope: 'crm.deal',
        name: 'Đang mở',
        filters: { v: 1, all: [{ field: 'status', op: 'is', value: 'open' }] },
        sort: null,
        shared: true,
        ownerId: o.lan,
        mine: true,
        canChange: true,
        updatedAt: expect.any(String),
      },
    ]);
    // Another member, an admin and a viewer see the shared view only; the member may not change it, the admin may.
    expect((await list(o, o.minh)).map((v) => [v.name, v.canChange])).toEqual([['Đang mở', false]]);
    expect((await list(o, o.admin)).map((v) => [v.name, v.canChange])).toEqual([['Đang mở', true]]);
    expect((await list(o, o.viewer)).map((v) => v.name)).toEqual(['Đang mở']);
    // Another scope lists none of them.
    expect(await list(o, o.lan, 'crm.party')).toEqual([]);
    // Below the query's own filter: the table's policy shows the same rows.
    expect(await raw(o, o.lan)).toEqual(['Của tôi', 'Đang mở']);
    expect(await raw(o, o.minh)).toEqual(['Đang mở']);
    expect(await raw(o, o.owner)).toEqual(['Đang mở']);
    // Another org sees nothing, its owner included.
    const other = await org();
    expect(await list(other, other.owner)).toEqual([]);
    expect(await raw(other, other.owner)).toEqual([]);

    // A private view: nobody else changes or deletes it, an owner of the org neither.
    await expect(exec(o, o.owner, 'kernel.saved_view.rename', { viewId: mine.viewId, name: 'Đổi tên' })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    await expect(exec(o, o.owner, 'kernel.saved_view.set_shared', { viewId: mine.viewId, shared: true })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    await expect(exec(o, o.owner, 'kernel.saved_view.save', { viewId: mine.viewId, filters: none })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    await expect(exec(o, o.owner, 'kernel.saved_view.delete', { viewId: mine.viewId })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    expect(await asApp(o.orgId, o.owner, async (c) => (await c.query("UPDATE crove_kernel.saved_view SET name = 'x' WHERE id = $1", [mine.viewId])).rowCount)).toBe(0);
    expect(await asApp(o.orgId, o.owner, async (c) => (await c.query('DELETE FROM crove_kernel.saved_view WHERE id = $1', [mine.viewId])).rowCount)).toBe(0);
    // A shared view: another member may not change or delete it, in the command or in the table.
    await expect(exec(o, o.minh, 'kernel.saved_view.rename', { viewId: team.viewId, name: 'Của Minh' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(exec(o, o.minh, 'kernel.saved_view.delete', { viewId: team.viewId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query("UPDATE crove_kernel.saved_view SET name = 'x' WHERE id = $1", [team.viewId])).rowCount)).toBe(0);
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('DELETE FROM crove_kernel.saved_view WHERE id = $1', [team.viewId])).rowCount)).toBe(0);
    // Nor write a view in someone else's name.
    await expect(
      asApp(o.orgId, o.minh, (c) => c.query("INSERT INTO crove_kernel.saved_view (org_id, user_id, scope, name, filters) VALUES ($1, $2, 'crm.deal', 'Giả', '{}')", [o.orgId, o.lan])),
    ).rejects.toThrow(/row-level security/);
    // The scope and the owner of a view never change in place, even for its owner.
    await expect(asApp(o.orgId, o.lan, (c) => c.query("UPDATE crove_kernel.saved_view SET scope = 'crm.party' WHERE id = $1", [mine.viewId]))).rejects.toThrow(/permission denied/);
    await expect(asApp(o.orgId, o.lan, (c) => c.query('UPDATE crove_kernel.saved_view SET user_id = $2 WHERE id = $1', [mine.viewId, o.minh]))).rejects.toThrow(/permission denied/);
    // The admin renames it and replaces its filter, and keeps it shared, but may not make it private in either place.
    await exec(o, o.admin, 'kernel.saved_view.rename', { viewId: team.viewId, name: 'Đang mở (tuần)' });
    await exec(o, o.admin, 'kernel.saved_view.save', { viewId: team.viewId, filters: { v: 1, all: [{ field: 'amount', op: 'gte', value: '1000000' }] }, sort: { field: 'created', dir: 'asc' } });
    await expect(exec(o, o.admin, 'kernel.saved_view.set_shared', { viewId: team.viewId, shared: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(asApp(o.orgId, o.admin, (c) => c.query('UPDATE crove_kernel.saved_view SET shared = false WHERE id = $1', [team.viewId]))).rejects.toThrow(/row-level security/);
    expect((await list(o, o.lan)).find((v) => v.id === team.viewId)).toMatchObject({
      name: 'Đang mở (tuần)',
      shared: true,
      ownerId: o.lan,
      filters: { v: 1, all: [{ field: 'amount', op: 'gte', value: '1000000' }] },
      sort: { field: 'created', dir: 'asc' },
    });
    // Its owner makes it private again; then only they see it.
    await exec(o, o.lan, 'kernel.saved_view.set_shared', { viewId: team.viewId, shared: false });
    expect(await list(o, o.minh)).toEqual([]);
    expect(await raw(o, o.admin)).toEqual([]);
    // A viewer saves views of their own but does not share them.
    await save(o, o.viewer, { name: 'Của tôi' });
    await expect(save(o, o.viewer, { name: 'Cho cả nhóm', shared: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const own = await save(o, o.viewer, { name: 'Riêng' });
    await expect(exec(o, o.viewer, 'kernel.saved_view.set_shared', { viewId: own.viewId, shared: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The owner deletes their own; the admin a shared one.
    const again = await save(o, o.minh, { name: 'Của Minh', shared: true });
    expect(await exec(o, o.admin, 'kernel.saved_view.delete', { viewId: again.viewId })).toEqual({ viewId: again.viewId });
    expect(await exec(o, o.lan, 'kernel.saved_view.delete', { viewId: mine.viewId })).toEqual({ viewId: mine.viewId });
    expect((await list(o, o.lan)).map((v) => v.name)).toEqual(['Đang mở (tuần)']);
  });

  it('keeps a private view from a second member of the same org in the table itself, and lets them read a shared one', async () => {
    const o = await org();
    const priv = await save(o, o.lan, { name: 'Riêng của Lan' });
    const pub = await save(o, o.lan, { name: 'Chung của Lan', shared: true });
    const ids = async (user: string) =>
      asApp(o.orgId, user, async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.saved_view WHERE org_id = $1 ORDER BY name', [o.orgId])).rows.map((r) => r.id));
    // Minh, a member of the same org, reads the shared view and not the private one: no SELECT, by id or in a list.
    expect(await ids(o.minh)).toEqual([pub.viewId]);
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('SELECT 1 FROM crove_kernel.saved_view WHERE id = $1', [priv.viewId])).rowCount)).toBe(0);
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('SELECT 1 FROM crove_kernel.saved_view WHERE id = $1', [pub.viewId])).rowCount)).toBe(1);
    // He changes and deletes neither: the private one is invisible to him, the shared one is Lan's.
    for (const id of [priv.viewId, pub.viewId]) {
      expect(await asApp(o.orgId, o.minh, async (c) => (await c.query("UPDATE crove_kernel.saved_view SET name = 'Của Minh' WHERE id = $1", [id])).rowCount)).toBe(0);
      expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('UPDATE crove_kernel.saved_view SET shared = true WHERE id = $1', [id])).rowCount)).toBe(0);
      expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('DELETE FROM crove_kernel.saved_view WHERE id = $1', [id])).rowCount)).toBe(0);
    }
    // Nothing changed for Lan.
    expect(await ids(o.lan)).toEqual([pub.viewId, priv.viewId]);
    expect((await list(o, o.lan)).map((v) => [v.name, v.shared])).toEqual([['Chung của Lan', true], ['Riêng của Lan', false]]);
    // The org's admin reads the shared view and not the private one, and an owner neither.
    expect(await ids(o.admin)).toEqual([pub.viewId]);
    expect(await ids(o.owner)).toEqual([pub.viewId]);
  });

  it('refuses an agent, whatever it asks, and an agent context reads no view', async () => {
    const o = await org();
    const view = await save(o, o.lan, { name: 'Riêng', shared: true });
    const agent = { type: 'agent' as const, agentId: randomUUID(), runId: randomUUID() };
    await expect(rt.execute('kernel.saved_view.delete', { viewId: view.viewId }, { actor: agent, orgId: o.orgId })).rejects.toBeTruthy();
    await expect(rt.execute('kernel.saved_view.save', { scope: 'crm.deal', name: 'Của máy', filters: none, shared: false }, { actor: agent, orgId: o.orgId })).rejects.toBeTruthy();
    expect(await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_kernel.saved_view WHERE org_id = $1', [o.orgId])).then((r) => r.rows[0]?.n)).toBe(1);
  });

  it('keeps one name per member and scope, at most 30 views per member and scope under a lock, and drops a member’s views with them', async () => {
    const o = await org();
    expect(SAVED_VIEW_LIMIT).toBe(30);
    await save(o, o.lan, { name: 'Tuần này' });
    await expect(save(o, o.lan, { name: '  Tuần này ' })).rejects.toMatchObject({ code: 'SAVED_VIEW_NAME_TAKEN' });
    // A name typed with combining marks is the same name as the precomposed one.
    await expect(save(o, o.lan, { name: 'Tuần này'.normalize('NFD') })).rejects.toMatchObject({ code: 'SAVED_VIEW_NAME_TAKEN' });
    // Another member, and another scope, may use the same name.
    await save(o, o.minh, { name: 'Tuần này', shared: true });
    await save(o, o.lan, { scope: 'crm.party', name: 'Tuần này' });
    for (let i = 2; i < SAVED_VIEW_LIMIT; i++) await save(o, o.lan, { name: `Chế độ ${i}` });
    // Two saves at once for the last place: one is kept, the other refused at the limit.
    const both = await Promise.allSettled([save(o, o.lan, { name: 'Cuối A' }), save(o, o.lan, { name: 'Cuối B' })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'SAVED_VIEW_LIMIT' } });
    const count = async (user: string, scope = 'crm.deal') =>
      (await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.saved_view WHERE org_id = $1 AND user_id = $2 AND scope = $3', [o.orgId, user, scope]))).rows[0]?.n;
    expect(await count(o.lan)).toBe(String(SAVED_VIEW_LIMIT));
    // The 31st view of the scope is refused; the limit counts the member's own views of that scope only: Minh's shared
    // view and Lan's contact view did not take one of Lan's places, and a contact view still saves.
    await expect(save(o, o.lan, { name: 'Thứ 31' })).rejects.toMatchObject({ code: 'SAVED_VIEW_LIMIT', status: 409 });
    await expect(save(o, o.lan, { scope: 'crm.party', name: 'Liên hệ 2' })).resolves.toBeTruthy();
    // A rename and a new filter still work at the limit.
    const first = (await list(o, o.lan)).find((v) => v.name === 'Tuần này' && v.mine);
    await exec(o, o.lan, 'kernel.saved_view.rename', { viewId: first?.id, name: 'Tuần sau' });
    await expect(exec(o, o.lan, 'kernel.saved_view.rename', { viewId: first?.id, name: 'Chế độ 3' })).rejects.toMatchObject({ code: 'SAVED_VIEW_NAME_TAKEN' });
    await exec(o, o.lan, 'kernel.saved_view.save', { viewId: first?.id, filters: { v: 1, all: [{ field: 'owner', op: 'is_empty' }] } });
    // A replacement without a sort keeps the view's sort; a null sort clears it.
    await exec(o, o.lan, 'kernel.saved_view.save', { viewId: first?.id, filters: none, sort: { field: 'amount', dir: 'asc' } });
    await exec(o, o.lan, 'kernel.saved_view.save', { viewId: first?.id, filters: { v: 1, all: [{ field: 'owner', op: 'is_empty' }] } });
    expect((await list(o, o.lan)).find((v) => v.id === first?.id)).toMatchObject({ sort: { field: 'amount', dir: 'asc' }, filters: { v: 1, all: [{ field: 'owner', op: 'is_empty' }] } });
    await exec(o, o.lan, 'kernel.saved_view.save', { viewId: first?.id, filters: none, sort: null });
    expect((await list(o, o.lan)).find((v) => v.id === first?.id)).toMatchObject({ sort: null });
    // A rename racing a rename to the same name is answered SAVED_VIEW_NAME_TAKEN, not by the unique index.
    const second = (await list(o, o.lan)).find((v) => v.name === 'Chế độ 2');
    const race = await Promise.allSettled([
      exec(o, o.lan, 'kernel.saved_view.rename', { viewId: first?.id, name: 'Trùng tên' }),
      exec(o, o.lan, 'kernel.saved_view.rename', { viewId: second?.id, name: 'Trùng tên' }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'SAVED_VIEW_NAME_TAKEN' } });
    // The table's own checks hold without the command.
    await expect(
      admin((c) => c.query("INSERT INTO crove_kernel.saved_view (org_id, user_id, scope, name, filters) VALUES ($1, $2, 'crm.deal', 'Mảng', '[]')", [o.orgId, o.minh])),
    ).rejects.toThrow(/check constraint/);
    await expect(
      admin((c) => c.query("INSERT INTO crove_kernel.saved_view (org_id, user_id, scope, name, filters) VALUES ($1, $2, 'crm.deal', 'To', $3)", [o.orgId, o.minh, JSON.stringify({ q: 'x'.repeat(5000) })])),
    ).rejects.toThrow(/check constraint/);
    await expect(
      admin((c) => c.query("INSERT INTO crove_kernel.saved_view (org_id, user_id, scope, name, filters) VALUES ($1, $2, 'Crm Deal', 'Sai', '{}')", [o.orgId, o.minh])),
    ).rejects.toThrow(/check constraint/);
    await expect(
      admin((c) => c.query("INSERT INTO crove_kernel.saved_view (org_id, user_id, scope, name, filters, sort) VALUES ($1, $2, 'crm.deal', 'Sắp', '{}', '[]')", [o.orgId, o.minh])),
    ).rejects.toThrow(/check constraint/);
    // A member who leaves takes their views along, shared ones too.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.minh]));
    expect(await count(o.minh)).toBe('0');
    expect((await list(o, o.lan)).every((v) => v.ownerId === o.lan)).toBe(true);
  });

  it('answers 422 to an unknown scope, field, operator or sort, a wrong value, a repeated condition and too many conditions', async () => {
    const o = await org();
    const refused = (input: Record<string, unknown>) => expect(save(o, o.lan, { name: 'Lạ', ...input })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await refused({ scope: 'crm.nothing' });
    await refused({ scope: 'Crm' });
    await refused({ filters: { v: 1, all: [{ field: 'color', op: 'is', value: 'red' }] } });
    await refused({ filters: { v: 1, all: [{ field: 'status', op: 'startswith', value: 'o' }] } });
    await refused({ filters: { v: 1, all: [{ field: 'status', op: 'is', value: 'pending' }] } });
    await refused({ filters: { v: 1, all: [{ field: 'amount', op: 'gte', value: 5 }] } });
    await refused({ filters: { v: 1, all: [{ field: 'owner', op: 'is_me', value: 'x' }] } });
    await refused({ filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'a' }, { field: 'search', op: 'contains', value: 'b' }] } });
    await refused({ filters: { v: 2, all: [] } });
    await refused({ filters: { v: 1, all: [], extra: true } });
    await refused({ filters: { v: 1, all: Array.from({ length: 9 }, (_, i) => ({ field: 'search', op: `contains${i}`, value: 'a' })) } });
    await refused({ sort: { field: 'color', dir: 'asc' } });
    await refused({ sort: { field: 'amount', dir: 'sideways' } });
    await refused({ name: '   ' });
    await refused({ name: 'x'.repeat(61) });
    // A party field is not a deal field, and a deal sort is not a party sort.
    await refused({ filters: { v: 1, all: [{ field: 'has_email', op: 'is', value: true }] } });
    await refused({ scope: 'crm.party', sort: { field: 'amount', dir: 'asc' } });
    // A new filter for a stored view is checked against its own scope.
    const view = await save(o, o.lan, { scope: 'crm.party', name: 'Liên hệ' });
    await expect(exec(o, o.lan, 'kernel.saved_view.save', { viewId: view.viewId, filters: { v: 1, all: [{ field: 'stage', op: 'in', value: [randomUUID()] }] } })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(list(o, o.lan, 'crm.nothing')).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    // Nothing was stored but the one valid view.
    expect(await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_kernel.saved_view WHERE org_id = $1', [o.orgId])).then((r) => r.rows[0]?.n)).toBe(1);
    // The widest filter the registry allows fits the stored size.
    const widest: FilterAst = {
      v: 1,
      all: [
        { field: 'search', op: 'contains', value: 'x'.repeat(100) },
        { field: 'stage', op: 'in', value: Array.from({ length: 20 }, () => randomUUID()) },
        { field: 'status', op: 'is', value: 'open' },
        { field: 'owner', op: 'is', value: randomUUID() },
        { field: 'party', op: 'is', value: randomUUID() },
        { field: 'amount', op: 'gte', value: '9999999999999999.99' },
        { field: 'expected_close', op: 'before', value: '2026-12-31' },
        { field: 'created', op: 'within_last_days', value: 3650 },
      ],
    };
    await expect(save(o, o.lan, { name: 'Rộng nhất', filters: widest })).resolves.toBeTruthy();
  });

  // The conditions of the deals and the contacts against rows of a scratch table each, so every operator of the registry
  // runs against real rows. The field map is what crm's deal filter will hold for the deal table (K1).
  describe('the filter on real rows', () => {
    const U1 = randomUUID();
    const U2 = randomUUID();
    const S1 = randomUUID();
    const S2 = randomUUID();
    const S3 = randomUUID();
    const S4 = randomUUID();
    const P1 = randomUUID();
    const P2 = randomUUID();
    const P3 = randomUUID();
    const ctx: FilterContext = { me: U2, today: TODAY, now: NOW };
    const dealFields: Record<string, FieldCondition> = {
      search: textContains([sql`d.title`]),
      stage: idIn(sql`d.stage_id`),
      status: valueIs(sql`d.status`),
      owner: memberIs(sql`d.owner_id`),
      party: idIs(sql`d.party_id`),
      amount: amountCompare(sql`d.amount`),
      expected_close: dateCompare(sql`d.expected_close`, sql<boolean>`d.closed_at IS NULL`),
      created: withinLastDays(sql`d.created_at`),
    };
    const deals = async (filters: FilterAst, who = ctx) => {
      const where = filterCondition('crm.deal', filters, dealFields, who);
      const r = await sql<{ title: string }>`SELECT d.title FROM sv_deal d WHERE ${where} ORDER BY d.title COLLATE "C"`.execute(adminDb);
      return r.rows.map((x) => x.title);
    };
    const parties = async (filters: FilterAst) => {
      const where = filterCondition('crm.party', filters, { ...partyFields(), has_open_deal: flagIs(sql`p.open_deal`) }, ctx);
      const r = await sql<{ name: string }>`SELECT p.name FROM sv_party p WHERE ${where} ORDER BY p.name COLLATE "C"`.execute(adminDb);
      return r.rows.map((x) => x.name);
    };
    const all = (...conditions: FilterAst['all']): FilterAst => ({ v: 1, all: conditions });

    beforeAll(async () => {
      await admin(async (c) => {
        await c.query(`CREATE TABLE sv_deal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, stage_id uuid, status text, owner_id uuid, party_id uuid,
          amount numeric(20,2) NOT NULL, expected_close date, created_at timestamptz NOT NULL, closed_at timestamptz)`);
        await c.query(`INSERT INTO sv_deal (title, stage_id, status, owner_id, party_id, amount, expected_close, created_at, closed_at) VALUES
          ('Báo giá website Nguyễn', $1, 'open', $5, $7, 5000000.00, '2026-11-05', '2026-11-08T05:00:00Z', NULL),
          ('Hợp đồng Trần', $2, 'open', $6, $8, 20000000.00, '2026-11-12', '2026-10-01T00:00:00Z', NULL),
          ('Dự án Lê', $1, 'open', NULL, $7, 0.00, NULL, '2026-11-10T04:00:00Z', NULL),
          ('Đã thắng Phạm', $3, 'won', $5, $9, 100.50, '2026-11-01', '2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z'),
          ('Mất Hoàng 50%', $4, 'lost', $6, $8, 1.00, '2026-12-31', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')`, [S1, S2, S3, S4, U1, U2, P1, P2, P3]);
        await c.query(`CREATE TABLE sv_party (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, kind text NOT NULL, email text, phone text, tax_code text,
          created_at timestamptz NOT NULL, open_deal boolean NOT NULL)`);
        await c.query(`INSERT INTO sv_party (name, kind, email, phone, tax_code, created_at, open_deal) VALUES
          ('Công ty Nguyễn', 'organization', 'kinhdoanh@example.com', '0912345678', '0101234567', '2026-11-09T00:00:00Z', true),
          ('Trần Văn B', 'person', NULL, '0903 000 000', NULL, '2026-10-01T00:00:00Z', false),
          ('Lê Thị C', 'person', '', '   ', '', '2026-11-10T01:00:00Z', false)`);
      });
    });

    it('matches text without marks or case, and a wildcard as itself', async () => {
      expect(await deals(all({ field: 'search', op: 'contains', value: 'nguyen' }))).toEqual(['Báo giá website Nguyễn']);
      expect(await deals(all({ field: 'search', op: 'contains', value: 'NGUYỄN' }))).toEqual(['Báo giá website Nguyễn']);
      expect(await deals(all({ field: 'search', op: 'contains', value: 'du an' }))).toEqual(['Dự án Lê']);
      expect(await deals(all({ field: 'search', op: 'contains', value: 'đã thắng' }))).toEqual(['Đã thắng Phạm']);
      expect(await deals(all({ field: 'search', op: 'contains', value: 'xyz' }))).toEqual([]);
      // `%` and `_` are characters, not wildcards: only the title holding a literal % matches, and `_` matches nothing.
      expect(await deals(all({ field: 'search', op: 'contains', value: '%' }))).toEqual(['Mất Hoàng 50%']);
      expect(await deals(all({ field: 'search', op: 'contains', value: '_' }))).toEqual([]);
      // A quote is data, not SQL.
      expect(await deals(all({ field: 'search', op: 'contains', value: "'; DROP TABLE sv_deal; --" }))).toEqual([]);
      expect(await deals(none)).toHaveLength(5);
    });

    it('matches stage, status, owner and party', async () => {
      expect(await deals(all({ field: 'stage', op: 'in', value: [S1] }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
      expect(await deals(all({ field: 'stage', op: 'in', value: [S1, S3] }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Đã thắng Phạm']);
      // A stage that no longer exists matches nothing.
      expect(await deals(all({ field: 'stage', op: 'in', value: [randomUUID()] }))).toEqual([]);
      expect(await deals(all({ field: 'status', op: 'is', value: 'won' }))).toEqual(['Đã thắng Phạm']);
      expect(await deals(all({ field: 'status', op: 'is', value: 'open' }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Hợp đồng Trần']);
      expect(await deals(all({ field: 'status', op: 'is', value: 'lost' }))).toEqual(['Mất Hoàng 50%']);
      expect(await deals(all({ field: 'owner', op: 'is', value: U1 }))).toEqual(['Báo giá website Nguyễn', 'Đã thắng Phạm']);
      expect(await deals(all({ field: 'owner', op: 'is_me' }))).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
      expect(await deals(all({ field: 'owner', op: 'is_me' }), { ...ctx, me: U1 })).toEqual(['Báo giá website Nguyễn', 'Đã thắng Phạm']);
      expect(await deals(all({ field: 'owner', op: 'is_me' }), { ...ctx, me: null })).toEqual([]);
      expect(await deals(all({ field: 'owner', op: 'is_empty' }))).toEqual(['Dự án Lê']);
      // A member that no longer exists matches nothing.
      expect(await deals(all({ field: 'owner', op: 'is', value: randomUUID() }))).toEqual([]);
      expect(await deals(all({ field: 'party', op: 'is', value: P1 }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
    });

    it('compares amounts as decimals, never as JS numbers', async () => {
      expect(await deals(all({ field: 'amount', op: 'gte', value: '5000000' }))).toEqual(['Báo giá website Nguyễn', 'Hợp đồng Trần']);
      expect(await deals(all({ field: 'amount', op: 'lte', value: '5000000.00' }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Mất Hoàng 50%', 'Đã thắng Phạm']);
      expect(await deals(all({ field: 'amount', op: 'gte', value: '100.50' }))).toEqual(['Báo giá website Nguyễn', 'Hợp đồng Trần', 'Đã thắng Phạm']);
      expect(await deals(all({ field: 'amount', op: 'lte', value: '100.49' }))).toEqual(['Dự án Lê', 'Mất Hoàng 50%']);
      expect(await deals(all({ field: 'amount', op: 'gte', value: '9999999999999999.99' }))).toEqual([]);
    });

    it('matches the expected close date, overdue and due soon on open deals only', async () => {
      expect(await deals(all({ field: 'expected_close', op: 'before', value: '2026-11-05' }))).toEqual(['Đã thắng Phạm']);
      expect(await deals(all({ field: 'expected_close', op: 'after', value: '2026-11-05' }))).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
      // Overdue: before today (2026-11-10) and still open; the won deal due on 11-01 is not.
      expect(await deals(all({ field: 'expected_close', op: 'overdue' }))).toEqual(['Báo giá website Nguyễn']);
      // Within the next N days: today to today + N, both included, open deals only.
      expect(await deals(all({ field: 'expected_close', op: 'within_next_days', value: 1 }))).toEqual([]);
      expect(await deals(all({ field: 'expected_close', op: 'within_next_days', value: 2 }))).toEqual(['Hợp đồng Trần']);
      expect(await deals(all({ field: 'expected_close', op: 'within_next_days', value: 90 }))).toEqual(['Hợp đồng Trần']);
      expect(await deals(all({ field: 'expected_close', op: 'is_empty' }))).toEqual(['Dự án Lê']);
    });

    it('matches what was created within the last N days', async () => {
      expect(await deals(all({ field: 'created', op: 'within_last_days', value: 1 }))).toEqual(['Dự án Lê']);
      expect(await deals(all({ field: 'created', op: 'within_last_days', value: 7 }))).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
      expect(await deals(all({ field: 'created', op: 'within_last_days', value: 3650 }))).toHaveLength(5);
    });

    it('ANDs the conditions of a filter', async () => {
      expect(await deals(all({ field: 'status', op: 'is', value: 'open' }, { field: 'owner', op: 'is_me' }))).toEqual(['Hợp đồng Trần']);
      expect(await deals(all({ field: 'status', op: 'is', value: 'open' }, { field: 'amount', op: 'lte', value: '5000000' }, { field: 'stage', op: 'in', value: [S1] }, { field: 'owner', op: 'is_empty' }))).toEqual(['Dự án Lê']);
      expect(await deals(all({ field: 'status', op: 'is', value: 'won' }, { field: 'owner', op: 'is_empty' }))).toEqual([]);
    });

    it('matches the contacts', async () => {
      expect(await parties(all({ field: 'search', op: 'contains', value: 'nguyen' }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'search', op: 'contains', value: '0903' }))).toEqual(['Trần Văn B']);
      expect(await parties(all({ field: 'search', op: 'contains', value: 'kinhdoanh@' }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'search', op: 'contains', value: '0101234' }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'kind', op: 'is', value: 'person' }))).toEqual(['Lê Thị C', 'Trần Văn B']);
      expect(await parties(all({ field: 'kind', op: 'is', value: 'organization' }))).toEqual(['Công ty Nguyễn']);
      // An empty or blank value is not an email, a phone or a tax code.
      expect(await parties(all({ field: 'has_email', op: 'is', value: true }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'has_email', op: 'is', value: false }))).toEqual(['Lê Thị C', 'Trần Văn B']);
      expect(await parties(all({ field: 'has_phone', op: 'is', value: true }))).toEqual(['Công ty Nguyễn', 'Trần Văn B']);
      expect(await parties(all({ field: 'has_phone', op: 'is', value: false }))).toEqual(['Lê Thị C']);
      expect(await parties(all({ field: 'has_tax_code', op: 'is', value: true }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'has_tax_code', op: 'is', value: false }))).toEqual(['Lê Thị C', 'Trần Văn B']);
      expect(await parties(all({ field: 'has_open_deal', op: 'is', value: true }))).toEqual(['Công ty Nguyễn']);
      expect(await parties(all({ field: 'has_open_deal', op: 'is', value: false }))).toEqual(['Lê Thị C', 'Trần Văn B']);
      expect(await parties(all({ field: 'created', op: 'within_last_days', value: 2 }))).toEqual(['Công ty Nguyễn', 'Lê Thị C']);
    });

    it('runs every operator of the registry in a case above', () => {
      // The cases the tests above run, as scope:field:op. A new operator in the registry fails here until it has a case.
      const covered = new Set([
        'crm.deal:search:contains', 'crm.deal:stage:in', 'crm.deal:status:is', 'crm.deal:owner:is', 'crm.deal:owner:is_me', 'crm.deal:owner:is_empty',
        'crm.deal:party:is', 'crm.deal:amount:gte', 'crm.deal:amount:lte', 'crm.deal:expected_close:before', 'crm.deal:expected_close:after',
        'crm.deal:expected_close:overdue', 'crm.deal:expected_close:within_next_days', 'crm.deal:expected_close:is_empty', 'crm.deal:created:within_last_days',
        'crm.party:search:contains', 'crm.party:kind:is', 'crm.party:has_email:is', 'crm.party:has_phone:is', 'crm.party:has_tax_code:is',
        'crm.party:has_open_deal:is', 'crm.party:created:within_last_days',
      ]);
      const registry = Object.entries(SAVED_VIEW_SCOPES).flatMap(([scope, spec]) =>
        Object.entries(spec.fields).flatMap(([field, f]) => Object.keys(f.ops).map((op) => `${scope}:${field}:${op}`)),
      );
      expect([...covered].sort()).toEqual(registry.sort());
    });

    it('sorts by the view’s field and direction, rows without a value last, ties by id', async () => {
      const sortable = {
        created: sql`d.created_at`,
        name: sql`d.title`,
        amount: sql`d.amount`,
        expected_close: sql`d.expected_close`,
        updated: sql`d.created_at`,
      };
      const ordered = async (sort: Parameters<typeof sortTerms>[1]) => {
        const terms = sortTerms('crm.deal', sort, sortable, sql`d.id`, { field: 'created', dir: 'desc' });
        const r = await sql<{ title: string }>`SELECT d.title FROM sv_deal d ORDER BY ${sql.join(terms, sql`, `)}`.execute(adminDb);
        return r.rows.map((x) => x.title);
      };
      expect(await ordered({ field: 'amount', dir: 'desc' })).toEqual(['Hợp đồng Trần', 'Báo giá website Nguyễn', 'Đã thắng Phạm', 'Mất Hoàng 50%', 'Dự án Lê']);
      expect(await ordered({ field: 'amount', dir: 'asc' })).toEqual(['Dự án Lê', 'Mất Hoàng 50%', 'Đã thắng Phạm', 'Báo giá website Nguyễn', 'Hợp đồng Trần']);
      // The deal without a date goes last in both directions.
      expect((await ordered({ field: 'expected_close', dir: 'asc' })).at(-1)).toBe('Dự án Lê');
      expect((await ordered({ field: 'expected_close', dir: 'desc' })).at(-1)).toBe('Dự án Lê');
      // No sort: the scope's default, newest first.
      expect(await ordered(null)).toEqual(['Dự án Lê', 'Báo giá website Nguyễn', 'Hợp đồng Trần', 'Đã thắng Phạm', 'Mất Hoàng 50%']);
      expect(() => sortTerms('crm.deal', { field: 'color', dir: 'asc' }, sortable, sql`d.id`, { field: 'created', dir: 'desc' })).toThrow(/Cách sắp xếp/);
    });

    it('refuses a stored filter the registry no longer knows, rather than guessing', () => {
      const stale = all({ field: 'color', op: 'is', value: 'red' });
      expect(() => filterCondition('crm.deal', stale, dealFields, ctx)).toThrow(/Bộ lọc không hợp lệ/);
      expect(() => filterCondition('crm.nothing', none, dealFields, ctx)).toThrow(/Chế độ xem không hợp lệ/);
      // The module owes a condition for every field of its scope: a missing one is a bug, not a user's mistake.
      expect(() => filterCondition('crm.deal', all({ field: 'party', op: 'is', value: P1 }), {}, ctx)).toThrow(/no condition for field party/);
    });
  });

  it('only narrows what the member’s row-level security lets them read', async () => {
    const a = await org();
    const b = await org();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $3, 'Nguyễn của A'), ($2, $4, 'Nguyễn của B'), ($1, $5, 'Trần của A')`,
        [a.orgId, b.orgId, randomUUID(), randomUUID(), randomUUID()],
      ),
    );
    const viewed = (o: Org, user: string, filters: FilterAst) => rt.query<string[]>('test.party.viewed', { filters }, { actor: asUser(user), orgId: o.orgId });
    // The same filter, in two orgs: each member lists their own org's contact and never the other's.
    const nguyen: FilterAst = { v: 1, all: [{ field: 'search', op: 'contains', value: 'nguyen' }] };
    expect(await viewed(a, a.lan, nguyen)).toEqual(['Nguyễn của A']);
    expect(await viewed(b, b.lan, nguyen)).toEqual(['Nguyễn của B']);
    // The empty filter lists exactly what the member read without one.
    expect(await viewed(a, a.lan, none)).toEqual(['Nguyễn của A', 'Trần của A']);
    // A view shared by A's member and applied by B's member lists B's contacts: it carries a filter, not rows.
    const shared = await save(a, a.lan, { scope: 'crm.party', name: 'Nguyễn', filters: nguyen, shared: true });
    const seen = (await list(a, a.minh, 'crm.party')).find((v) => v.id === shared.viewId);
    expect(seen?.filters).toEqual(nguyen);
    expect(await list(b, b.lan, 'crm.party')).toEqual([]);
    expect(await viewed(b, b.lan, seen?.filters as FilterAst)).toEqual(['Nguyễn của B']);
    // A filter that matches both orgs' rows by id or by name cannot reach across: a hostile search string is data.
    expect(await viewed(a, a.lan, { v: 1, all: [{ field: 'search', op: 'contains', value: "') OR true OR ('" }] })).toEqual([]);
  });

  it('is purged with the org: the purge function lists the table among the working rows it deletes before the members', async () => {
    const { rows } = await admin((c) => c.query<{ src: string }>("SELECT prosrc AS src FROM pg_catalog.pg_proc WHERE oid = 'crove_kernel.org_purge(integer)'::regprocedure"));
    const src = rows[0]?.src ?? '';
    expect(src).toContain("'crove_kernel.saved_view'");
    expect(src.indexOf("'crove_kernel.saved_view'")).toBeLessThan(src.indexOf('DELETE FROM crove_kernel.tenant_member'));
  });
});
