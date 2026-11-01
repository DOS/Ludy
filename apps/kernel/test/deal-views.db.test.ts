// SPDX-License-Identifier: AGPL-3.0-only
// Saved views of the deals on PostgreSQL 17 (CRM K3, #2227): every operator of the `crm.deal` scope against real deals
// through crm.deal.list, the sort and the cursor by deal id (with deals that have no expected close date), the same
// result for a viewer who opens a shared view as for the filter typed by hand, and the limits of a view: it only narrows
// what row-level security lets the member read, and a forged cursor is a 422. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { SAVED_VIEW_SCOPES, vietnamToday, type DealPage, type FilterAst, type SavedView } from '@crove/kernel-contract';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Days from today in Vietnam, as the date columns hold them.
const day = (offset: number) => vietnamToday(new Date(Date.now() + offset * 86_400_000));

suite('saved views of the deals on PostgreSQL (CRM K3, #2227)', () => {
  const dbName = `crove_test_deal_views_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
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
  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@deals.test`, name: null });
  }
  type Org = { orgId: string; owner: string; admin: string; lan: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), lan: await person('lan'), viewer: await person('viewer') };
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, o.admin, o.lan, o.viewer]),
    );
    return o;
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const list = (o: Org, user: string, input: Record<string, unknown> = {}) => rt.query<DealPage>('crm.deal.list', input, { actor: asUser(user), orgId: o.orgId });
  const titles = async (o: Org, user: string, input: Record<string, unknown> = {}) => (await list(o, user, input)).items.map((d) => d.title);
  const all = (...conditions: FilterAst['all']): { filters: FilterAst } => ({ filters: { v: 1, all: conditions } });
  const sorted = async (o: Org, user: string, filters: FilterAst | undefined, sort: { field: string; dir: 'asc' | 'desc' }) => titles(o, user, { ...(filters ? { filters } : {}), sort });

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
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let o: Org;
  let other: Org;
  let stages: Array<{ id: string; kind: string; name: string }>;
  let open1: string;
  let open2: string;
  let won: string;
  let lost: string;
  let p1: string;
  let p2: string;

  beforeAll(async () => {
    o = await org();
    other = await org();
    stages = await exec(o, o.lan, 'crm.pipeline.setup', {});
    const opens = stages.filter((s) => s.kind === 'open');
    open1 = opens[0]?.id as string;
    open2 = opens[1]?.id as string;
    won = stages.find((s) => s.kind === 'won')?.id as string;
    lost = stages.find((s) => s.kind === 'lost')?.id as string;
    const party = async (name: string) => (await exec<{ partyId: string }>(o, o.lan, 'kernel.party.create', { kind: 'organization', name })).partyId;
    p1 = await party('Công ty Nguyễn');
    p2 = await party('Trần Văn B');
    const p3 = await party('Phạm Thị D');
    const make = (partyId: string, title: string, amount: string, expectedClose: string | null, ownerUserId: string | null, stageId: string) =>
      exec<{ id: string; version: number }>(o, o.lan, 'crm.deal.create', { partyId, title, amount, expectedClose, ownerUserId, stageId });
    await make(p1, 'Báo giá website Nguyễn', '5000000', day(-5), o.lan, open1);
    await make(p2, 'Hợp đồng Trần', '20000000', day(2), o.admin, open2);
    await make(p1, 'Dự án Lê', '0', null, null, open1);
    const d = await make(p3, 'Đã thắng Phạm', '100.50', day(-9), o.lan, open1);
    await exec(o, o.lan, 'crm.deal.move', { dealId: d.id, version: d.version, stageId: won });
    const e = await make(p2, 'Mất Hoàng 50%', '1', day(30), o.admin, open1);
    await exec(o, o.lan, 'crm.deal.move', { dealId: e.id, version: e.version, stageId: lost, lostReason: 'Giá cao' });
    // Creation dates a view can tell apart.
    for (const [title, days] of [['Hợp đồng Trần', 40], ['Đã thắng Phạm', 100], ['Mất Hoàng 50%', 200]] as const) {
      await admin((c) => c.query(`UPDATE crove_crm.deal SET created_at = now() - make_interval(days => $3) WHERE org_id = $1 AND title = $2`, [o.orgId, title, days]));
    }
    // Another org's deal that every filter below could match.
    const otherStages = await exec<Array<{ id: string; kind: string }>>(other, other.owner, 'crm.pipeline.setup', {});
    const stranger = (await exec<{ partyId: string }>(other, other.owner, 'kernel.party.create', { kind: 'person', name: 'Nguyễn của tổ chức khác' })).partyId;
    await exec(other, other.owner, 'crm.deal.create', { partyId: stranger, title: 'Báo giá website Nguyễn của tổ chức khác', amount: '5000000', expectedClose: day(-5), ownerUserId: other.owner, stageId: otherStages.find((s) => s.kind === 'open')?.id });
  });

  it('lists the newest first as before when no view is applied', async () => {
    expect(await titles(o, o.lan)).toEqual(['Dự án Lê', 'Báo giá website Nguyễn', 'Hợp đồng Trần', 'Đã thắng Phạm', 'Mất Hoàng 50%']);
  });

  it('matches the title and the contact’s name without marks, a wildcard as itself', async () => {
    const q = async (value: string) => [...(await titles(o, o.lan, all({ field: 'search', op: 'contains', value })))].sort();
    expect(await q('nguyen')).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
    expect(await q('DU AN')).toEqual(['Dự án Lê']);
    expect(await q('tran van')).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
    expect(await q('xyz')).toEqual([]);
    expect(await q('%')).toEqual(['Mất Hoàng 50%']);
    expect(await q('_')).toEqual([]);
    expect(await q("'; DROP TABLE crove_crm.deal; --")).toEqual([]);
  });

  it('matches stage, status, owner and contact', async () => {
    const q = async (...c: FilterAst['all']) => [...(await titles(o, o.lan, all(...c)))].sort();
    expect(await q({ field: 'stage', op: 'in', value: [open2] })).toEqual(['Hợp đồng Trần']);
    expect(await q({ field: 'stage', op: 'in', value: [won, lost] })).toEqual(['Mất Hoàng 50%', 'Đã thắng Phạm']);
    expect(await q({ field: 'stage', op: 'in', value: [randomUUID()] })).toEqual([]);
    expect(await q({ field: 'status', op: 'is', value: 'open' })).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Hợp đồng Trần']);
    expect(await q({ field: 'status', op: 'is', value: 'won' })).toEqual(['Đã thắng Phạm']);
    expect(await q({ field: 'status', op: 'is', value: 'lost' })).toEqual(['Mất Hoàng 50%']);
    expect(await q({ field: 'owner', op: 'is', value: o.admin })).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
    expect(await q({ field: 'owner', op: 'is_empty' })).toEqual(['Dự án Lê']);
    expect(await q({ field: 'owner', op: 'is', value: randomUUID() })).toEqual([]);
    expect(await q({ field: 'party', op: 'is', value: p1 })).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
    // "Is me" is the member who asks.
    expect([...(await titles(o, o.lan, all({ field: 'owner', op: 'is_me' })))].sort()).toEqual(['Báo giá website Nguyễn', 'Đã thắng Phạm']);
    expect([...(await titles(o, o.admin, all({ field: 'owner', op: 'is_me' })))].sort()).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
    expect(await titles(o, o.viewer, all({ field: 'owner', op: 'is_me' }))).toEqual([]);
  });

  it('compares amounts as decimals', async () => {
    const q = async (...c: FilterAst['all']) => [...(await titles(o, o.lan, all(...c)))].sort();
    expect(await q({ field: 'amount', op: 'gte', value: '5000000' })).toEqual(['Báo giá website Nguyễn', 'Hợp đồng Trần']);
    expect(await q({ field: 'amount', op: 'lte', value: '5000000.00' })).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Mất Hoàng 50%', 'Đã thắng Phạm']);
    expect(await q({ field: 'amount', op: 'gte', value: '100.50' })).toEqual(['Báo giá website Nguyễn', 'Hợp đồng Trần', 'Đã thắng Phạm']);
    expect(await q({ field: 'amount', op: 'lte', value: '100.49' })).toEqual(['Dự án Lê', 'Mất Hoàng 50%']);
    expect(await q({ field: 'amount', op: 'gte', value: '9999999999999999.99' })).toEqual([]);
  });

  it('matches the expected close date, overdue and due soon on open deals only', async () => {
    const q = async (...c: FilterAst['all']) => [...(await titles(o, o.lan, all(...c)))].sort();
    expect(await q({ field: 'expected_close', op: 'before', value: day(0) })).toEqual(['Báo giá website Nguyễn', 'Đã thắng Phạm']);
    expect(await q({ field: 'expected_close', op: 'after', value: day(0) })).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
    // Overdue: before today and still open; the won deal that was due nine days ago is not.
    expect(await q({ field: 'expected_close', op: 'overdue' })).toEqual(['Báo giá website Nguyễn']);
    expect(await q({ field: 'expected_close', op: 'within_next_days', value: 1 })).toEqual([]);
    expect(await q({ field: 'expected_close', op: 'within_next_days', value: 3 })).toEqual(['Hợp đồng Trần']);
    // The lost deal due in 30 days is closed, so it is never "due soon".
    expect(await q({ field: 'expected_close', op: 'within_next_days', value: 60 })).toEqual(['Hợp đồng Trần']);
    expect(await q({ field: 'expected_close', op: 'is_empty' })).toEqual(['Dự án Lê']);
  });

  it('matches what was created within the last N days, and ANDs conditions with each other and with the older filters', async () => {
    const q = async (...c: FilterAst['all']) => [...(await titles(o, o.lan, all(...c)))].sort();
    expect(await q({ field: 'created', op: 'within_last_days', value: 1 })).toEqual(['Báo giá website Nguyễn', 'Dự án Lê']);
    expect(await q({ field: 'created', op: 'within_last_days', value: 60 })).toEqual(['Báo giá website Nguyễn', 'Dự án Lê', 'Hợp đồng Trần']);
    expect(await q({ field: 'created', op: 'within_last_days', value: 365 })).toHaveLength(5);
    expect(await q({ field: 'status', op: 'is', value: 'open' }, { field: 'owner', op: 'is', value: o.admin })).toEqual(['Hợp đồng Trần']);
    expect(await q({ field: 'status', op: 'is', value: 'open' }, { field: 'amount', op: 'lte', value: '5000000' }, { field: 'owner', op: 'is_empty' })).toEqual(['Dự án Lê']);
    // The filters the list already had still apply beside a view's.
    expect(await titles(o, o.lan, { ...all({ field: 'status', op: 'is', value: 'open' }), ownerUserId: o.lan })).toEqual(['Báo giá website Nguyễn']);
    expect(await titles(o, o.lan, { ...all({ field: 'amount', op: 'gte', value: '1' }), partyId: p2 })).toEqual(['Hợp đồng Trần', 'Mất Hoàng 50%']);
  });

  it('runs every operator of the crm.deal scope in a case above', () => {
    const covered = new Set([
      'search:contains', 'stage:in', 'status:is', 'owner:is', 'owner:is_me', 'owner:is_empty', 'party:is', 'amount:gte', 'amount:lte',
      'expected_close:before', 'expected_close:after', 'expected_close:overdue', 'expected_close:within_next_days', 'expected_close:is_empty', 'created:within_last_days',
    ]);
    const registry = Object.entries(SAVED_VIEW_SCOPES['crm.deal'].fields).flatMap(([field, f]) => Object.keys(f.ops).map((op) => `${field}:${op}`));
    expect([...covered].sort()).toEqual(registry.sort());
  });

  it('sorts by the view’s field and direction, and pages by deal id through every sort', async () => {
    expect(await sorted(o, o.lan, undefined, { field: 'amount', dir: 'desc' })).toEqual(['Hợp đồng Trần', 'Báo giá website Nguyễn', 'Đã thắng Phạm', 'Mất Hoàng 50%', 'Dự án Lê']);
    expect(await sorted(o, o.lan, undefined, { field: 'amount', dir: 'asc' })).toEqual(['Dự án Lê', 'Mất Hoàng 50%', 'Đã thắng Phạm', 'Báo giá website Nguyễn', 'Hợp đồng Trần']);
    expect(await sorted(o, o.lan, undefined, { field: 'created', dir: 'asc' })).toEqual(['Mất Hoàng 50%', 'Đã thắng Phạm', 'Hợp đồng Trần', 'Báo giá website Nguyễn', 'Dự án Lê']);
    // The deal with no date goes last either way.
    const byClose = await sorted(o, o.lan, undefined, { field: 'expected_close', dir: 'asc' });
    expect(byClose.at(-1)).toBe('Dự án Lê');
    expect(byClose.slice(0, 4)).toEqual(['Đã thắng Phạm', 'Báo giá website Nguyễn', 'Hợp đồng Trần', 'Mất Hoàng 50%']);
    expect((await sorted(o, o.lan, undefined, { field: 'expected_close', dir: 'desc' })).at(-1)).toBe('Dự án Lê');
    for (const sort of [
      { field: 'amount', dir: 'desc' },
      { field: 'amount', dir: 'asc' },
      { field: 'expected_close', dir: 'asc' },
      { field: 'expected_close', dir: 'desc' },
      { field: 'name', dir: 'asc' },
      { field: 'created', dir: 'desc' },
      { field: 'updated', dir: 'asc' },
    ] as const) {
      const whole = await sorted(o, o.lan, undefined, sort);
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 6; page++) {
        const got = await list(o, o.lan, { sort, limit: 2, ...(after ? { after } : {}) });
        expect(got.items.length).toBeLessThanOrEqual(2);
        seen.push(...got.items.map((d) => d.title));
        if (got.next === null) break;
        after = got.next.id;
      }
      expect(seen, JSON.stringify(sort)).toEqual(whole);
    }
    // Paging within a filter keeps the filter.
    const first = await list(o, o.lan, { ...all({ field: 'status', op: 'is', value: 'open' }), sort: { field: 'amount', dir: 'desc' }, limit: 2 });
    const second = await list(o, o.lan, { ...all({ field: 'status', op: 'is', value: 'open' }), sort: { field: 'amount', dir: 'desc' }, limit: 2, after: first.next?.id as string });
    expect([...first.items, ...second.items].map((d) => d.title)).toEqual(['Hợp đồng Trần', 'Báo giá website Nguyễn', 'Dự án Lê']);
    expect(second.next).toBeNull();
  });

  it('answers 422 to an unknown field, operator, value or sort, and to a forged or foreign cursor', async () => {
    const refused = (input: Record<string, unknown>) => expect(list(o, o.lan, input)).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await refused(all({ field: 'color', op: 'is', value: 'red' }));
    await refused(all({ field: 'status', op: 'startswith', value: 'o' }));
    await refused(all({ field: 'status', op: 'is', value: 'pending' }));
    await refused(all({ field: 'amount', op: 'gte', value: 5 }));
    await refused(all({ field: 'has_email', op: 'is', value: true }));
    await refused({ sort: { field: 'color', dir: 'asc' } });
    await refused({ sort: { field: 'amount', dir: 'sideways' } });
    await refused({ after: 'không-phải-id' });
    // The id of nothing, and the id of another org's deal, are stale cursors.
    const theirs = (await list(other, other.owner)).items[0];
    await refused({ after: randomUUID() });
    await refused({ after: theirs?.id });
  });

  it('applies a saved view of the deals: a viewer opens the shared one and lists what the typed filter lists', async () => {
    const filters: FilterAst = { v: 1, all: [{ field: 'status', op: 'is', value: 'open' }, { field: 'expected_close', op: 'overdue' }] };
    const saved = await exec<{ viewId: string }>(o, o.lan, 'kernel.saved_view.save', { scope: 'crm.deal', name: 'Quá hạn', filters, sort: { field: 'amount', dir: 'desc' }, shared: true });
    const views = await rt.query<SavedView[]>('kernel.saved_view.list', { scope: 'crm.deal' }, { actor: asUser(o.viewer), orgId: o.orgId });
    const view = views.find((v) => v.id === saved.viewId);
    expect(view?.sort).toEqual({ field: 'amount', dir: 'desc' });
    const opened = await titles(o, o.viewer, { filters: view?.filters, sort: view?.sort });
    expect(opened).toEqual(await titles(o, o.viewer, { filters, sort: { field: 'amount', dir: 'desc' } }));
    expect(opened).toEqual(['Báo giá website Nguyễn']);
    // The same view in another org lists that org's own deal, never ours: a view carries a filter, not rows.
    expect(await titles(other, other.owner, { filters: view?.filters, sort: view?.sort })).toEqual(['Báo giá website Nguyễn của tổ chức khác']);
    // And a view cannot reach what the member could not read: the other org's deal is not in ours for any filter.
    expect(await titles(o, o.lan, all({ field: 'search', op: 'contains', value: 'tổ chức khác' }))).toEqual([]);
  });
});
