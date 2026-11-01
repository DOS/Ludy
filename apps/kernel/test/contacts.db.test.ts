// SPDX-License-Identifier: AGPL-3.0-only
// Contacts of the CRM on PostgreSQL 17 (CRM slice 1, step K4, #2228): a person or a company added by hand, a duplicate tax
// code refused with the existing party named, search without Vietnamese marks ("nguyen" finds "Nguyễn") and through the
// phone key, the TypeScript and SQL phone keys agreeing on every case of one table, filters and sorts as a saved view
// stores them, cursor paging that lists every contact once, and the isolation of orgs and roles. Set CROVE_TEST_ADMIN_URL
// to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { PHONE_KEY_CASES, type ContactPage, type FilterAst } from '@crove/kernel-contract';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { Runtime } from '@crove/kernel-runtime';

import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('contacts on PostgreSQL (CRM K4, #2228)', () => {
  const dbName = `crove_test_contacts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@contacts.test`, name: null });
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
  const create = (o: Org, user: string, input: Record<string, unknown>) => exec<{ partyId: string; version: number }>(o, user, 'kernel.party.create', { kind: 'person', ...input });
  const list = (o: Org, user: string, input: Record<string, unknown> = {}) => rt.query<ContactPage>('crm.contact.list', input, { actor: asUser(user), orgId: o.orgId });
  const names = async (o: Org, user: string, input: Record<string, unknown> = {}) => (await list(o, user, input)).items.map((c) => c.name);
  const all = (...conditions: FilterAst['all']): { filters: FilterAst } => ({ filters: { v: 1, all: conditions } });

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

  it('gives every phone of the one table of cases the same key in SQL as in TypeScript', async () => {
    // The TypeScript side runs the same table in packages/kernel-contract/test/phone.test.ts.
    const keys = await admin(async (c) => {
      const out: Array<string | null> = [];
      for (const [phone] of PHONE_KEY_CASES) out.push((await c.query<{ k: string | null }>('SELECT crove_kernel.phone_key($1) AS k', [phone])).rows[0]?.k ?? null);
      return out;
    });
    expect(keys).toEqual(PHONE_KEY_CASES.map(([, key]) => key));
    // No phone, no key.
    expect((await admin((c) => c.query<{ k: string | null }>('SELECT crove_kernel.phone_key(NULL) AS k'))).rows[0]?.k).toBeNull();
  });

  it('backs the party phone key with an expression index the planner can use, and lets tenants call the function', async () => {
    const o = await org();
    await create(o, o.lan, { name: 'Có số', phone: '0912 345 678' });
    const plan = await admin(async (c) => {
      await c.query('SET enable_seqscan = off');
      return (
        await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM crove_kernel.party WHERE org_id = $1 AND crove_kernel.phone_key(phone) = '0912345678'`, [o.orgId])
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
    });
    expect(plan).toContain('party_phone_key_idx');
    const executable = await admin((c) =>
      c.query<{ ok: boolean }>("SELECT has_function_privilege('crove_tenant', 'crove_kernel.phone_key(text)', 'EXECUTE') AS ok, has_function_privilege('public', 'crove_kernel.phone_key(text)', 'EXECUTE') AS pub"),
    );
    expect(executable.rows[0]).toMatchObject({ ok: true, pub: false });
    // The stored phone is never rewritten.
    expect((await admin((c) => c.query<{ phone: string }>('SELECT phone FROM crove_kernel.party WHERE org_id = $1', [o.orgId]))).rows[0]?.phone).toBe('0912 345 678');
  });

  it('adds a person or a company by hand, checked as an edit is, and refuses a used tax code naming the party', async () => {
    const o = await org();
    const made = await create(o, o.lan, { kind: 'organization', name: '  Công ty  TNHH Nguyễn  ', taxCode: '0101234567', address: '12 Lê Lợi, Hà Nội', email: 'lien-he@example.com', phone: '+84 912 345 678' });
    const row = (await admin((c) => c.query('SELECT * FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, made.partyId]))).rows[0];
    expect(row).toMatchObject({ kind: 'organization', name: 'Công ty TNHH Nguyễn', tax_code: '0101234567', address: '12 Lê Lợi, Hà Nội', email: 'lien-he@example.com', phone: '+84 912 345 678', source_trust: 'user', version: 1 });
    expect(made.version).toBe(1);
    // Only a name is needed.
    await expect(create(o, o.lan, { name: 'Trần Văn B' })).resolves.toMatchObject({ version: 1 });
    // The same checks as an edit.
    await expect(create(o, o.lan, { name: '   ' })).rejects.toMatchObject({ code: 'INVALID_PARTY_NAME', status: 422 });
    await expect(create(o, o.lan, { name: 'x'.repeat(301) })).rejects.toMatchObject({ code: 'INVALID_PARTY_NAME' });
    await expect(create(o, o.lan, { name: 'A', email: 'không-phải-email' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(create(o, o.lan, { name: 'A', phone: 'gọi tôi' })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await expect(create(o, o.lan, { name: 'A', taxCode: '12345' })).rejects.toMatchObject({ code: 'INVALID_TAX_CODE' });
    await expect(create(o, o.lan, { name: 'A', address: 'x'.repeat(600) })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(create(o, o.lan, { kind: 'company', name: 'A' })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    // A used tax code refuses and names the existing party, written with or without the formatting.
    const dup = await create(o, o.admin, { name: 'Bản sao', taxCode: '0101234567' }).catch((e: unknown) => e);
    expect(dup).toMatchObject({ code: 'PARTY_TAX_CODE_TAKEN', status: 409, details: { partyId: made.partyId, name: 'Công ty TNHH Nguyễn' } });
    expect((dup as Error).message).toContain('Công ty TNHH Nguyễn');
    // Two at once with a new tax code: one is made, the other refused, never two.
    const both = await Promise.allSettled([create(o, o.lan, { name: 'Cùng lúc A', taxCode: '0309876543' }), create(o, o.admin, { name: 'Cùng lúc B', taxCode: '0309876543' })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'PARTY_TAX_CODE_TAKEN' } });
    expect((await admin((c) => c.query("SELECT count(*)::int AS n FROM crove_kernel.party WHERE org_id = $1 AND tax_code = '0309876543'", [o.orgId]))).rows[0]?.n).toBe(1);
    // Another org may use the same tax code.
    const other = await org();
    await expect(create(other, other.owner, { name: 'Ở tổ chức khác', taxCode: '0101234567' })).resolves.toBeTruthy();
  });

  it('lets owners, admins and members add contacts, never viewers or agents, and keeps names and contact details out of the audit row', async () => {
    const o = await org();
    await create(o, o.owner, { name: 'Do chủ' });
    await create(o, o.admin, { name: 'Do quản trị' });
    await create(o, o.lan, { name: 'Do thành viên' });
    await expect(create(o, o.viewer, { name: 'Do người xem' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const agent = { type: 'agent' as const, agentId: randomUUID(), runId: randomUUID() };
    await expect(rt.execute('kernel.party.create', { kind: 'person', name: 'Do máy' }, { actor: agent, orgId: o.orgId })).rejects.toBeTruthy();
    expect((await admin((c) => c.query("SELECT count(*)::int AS n FROM crove_kernel.party WHERE org_id = $1 AND name LIKE 'Do %'", [o.orgId]))).rows[0]?.n).toBe(3);

    const made = await create(o, o.lan, { kind: 'organization', name: 'Công ty Bí Mật', taxCode: '0108888880', address: '9 Phố Bí Mật', email: 'bi-mat@example.vn', phone: '0988 777 777' });
    const audit = (await admin((c) => c.query<{ detail: unknown; command: string }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.create' AND detail ->> 'partyId' = $2", [o.orgId, made.partyId]))).rows;
    expect(audit).toHaveLength(1);
    const detail = JSON.stringify(audit[0]?.detail);
    for (const secret of ['Bí Mật', '0108888880', 'bi-mat@example.vn', '0988', '9 Phố']) expect(detail).not.toContain(secret);
    expect(audit[0]?.detail).toMatchObject({ partyId: made.partyId, kind: 'organization', fields: ['name', 'taxCode', 'address', 'email', 'phone'] });
    // The party's timeline says it was added, with fixed text.
    const activity = (await admin((c) => c.query<{ summary: string }>("SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'party.created'", [o.orgId, made.partyId]))).rows;
    expect(activity).toEqual([{ summary: 'Thêm liên hệ' }]);
  });

  it('shows a contact’s timeline, oldest first and in fixed words, to every role of its org only', async () => {
    const o = await org();
    const other = await org();
    const made = await create(o, o.lan, { name: 'Có lịch sử', phone: '0912 345 678' });
    await exec(o, o.admin, 'kernel.party.update', { partyId: made.partyId, version: made.version, name: 'Có lịch sử mới', taxCode: null, address: null, email: null, phone: '0912 345 678' });
    const timeline = (org_: Org, user: string, partyId: string) => rt.query<{ items: Array<{ kind: string; summary: string; actorType: string }>; more: boolean }>('kernel.party.timeline', { partyId }, { actor: asUser(user), orgId: org_.orgId });
    const got = await timeline(o, o.viewer, made.partyId);
    expect(got.items.map((e) => [e.kind, e.summary, e.actorType])).toEqual([
      ['party.created', 'Thêm liên hệ', 'user'],
      ['party.updated', 'Đổi tên', 'user'],
    ]);
    expect(got.more).toBe(false);
    // The summaries are fixed words: no name or contact detail.
    expect(JSON.stringify(got)).not.toContain('0912');
    // Another org cannot read it, and an unknown contact is not found.
    await expect(timeline(other, other.owner, made.partyId)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
    await expect(timeline(o, o.lan, randomUUID())).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
  });

  describe('the list', () => {
    let o: Org;
    let other: Org;
    beforeAll(async () => {
      o = await org();
      other = await org();
      await create(o, o.lan, { kind: 'organization', name: 'Công ty Nguyễn Hoàng', taxCode: '0101234567', email: 'kinh.doanh@example.com', phone: '+84 912 345 678' });
      await create(o, o.lan, { name: 'Trần Văn B', phone: '0903 000 000' });
      await create(o, o.lan, { name: 'Lê Thị Cúc', email: 'cuc@example.vn' });
      await create(o, o.lan, { kind: 'organization', name: 'Đặng Gia Hưng', taxCode: '0109999999', address: 'Hải Phòng' });
      await create(o, o.lan, { name: 'Phạm Thị D' });
      await create(other, other.owner, { name: 'Nguyễn của tổ chức khác', phone: '0912 345 678' });
    });

    it('lists the contacts by name, every role the same, and none of another org', async () => {
      const expected = ['Công ty Nguyễn Hoàng', 'Lê Thị Cúc', 'Phạm Thị D', 'Trần Văn B', 'Đặng Gia Hưng'];
      const got = await names(o, o.lan);
      expect([...got].sort()).toEqual([...expected].sort());
      expect(await names(o, o.viewer)).toEqual(got);
      expect(await names(o, o.owner)).toEqual(got);
      expect(await names(other, other.owner)).toEqual(['Nguyễn của tổ chức khác']);
      const first = (await list(o, o.lan)).items.find((c) => c.name === 'Công ty Nguyễn Hoàng');
      expect(first).toEqual({
        id: expect.any(String),
        kind: 'organization',
        name: 'Công ty Nguyễn Hoàng',
        taxCode: '0101234567',
        address: null,
        email: 'kinh.doanh@example.com',
        phone: '+84 912 345 678',
        version: 1,
        createdAt: expect.any(String),
      });
    });

    it('finds "Nguyễn" by typing "nguyen", whatever the case, marks or punctuation', async () => {
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'nguyen' }))).toEqual(['Công ty Nguyễn Hoàng']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'NGUYỄN' }))).toEqual(['Công ty Nguyễn Hoàng']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'le thi cuc' }))).toEqual(['Lê Thị Cúc']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'dang gia' }))).toEqual(['Đặng Gia Hưng']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'đặng' }))).toEqual(['Đặng Gia Hưng']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'xyz' }))).toEqual([]);
      // The email, the tax code and the phone are searched too, and a wildcard is a character.
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'cuc@example' }))).toEqual(['Lê Thị Cúc']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: '0109999' }))).toEqual(['Đặng Gia Hưng']);
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: '%' }))).toEqual([]);
    });

    it('finds a phone number written any way through its key', async () => {
      for (const typed of ['0912 345 678', '+84 912 345 678', '84912345678', '0912345', '+84 912 345', '0084 912']) {
        expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: typed })), typed).toEqual(['Công ty Nguyễn Hoàng']);
      }
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: '0903000' }))).toEqual(['Trần Văn B']);
      // Another org's contact with the same phone is not listed.
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: '0912 345 678' }))).not.toContain('Nguyễn của tổ chức khác');
    });

    it('filters by kind and by what is recorded', async () => {
      expect([...(await names(o, o.lan, all({ field: 'kind', op: 'is', value: 'organization' })))].sort()).toEqual(['Công ty Nguyễn Hoàng', 'Đặng Gia Hưng']);
      expect(await names(o, o.lan, all({ field: 'has_email', op: 'is', value: true, }))).toHaveLength(2);
      expect(await names(o, o.lan, all({ field: 'has_phone', op: 'is', value: true }))).toHaveLength(2);
      expect(await names(o, o.lan, all({ field: 'has_tax_code', op: 'is', value: false }))).toHaveLength(3);
      // Deals (K1): a contact has an open deal while one of its deals is in an open stage, not once it is won or lost.
      expect(await names(o, o.lan, all({ field: 'has_open_deal', op: 'is', value: true }))).toEqual([]);
      expect(await names(o, o.lan, all({ field: 'has_open_deal', op: 'is', value: false }))).toHaveLength(5);
      const stages = await exec<Array<{ id: string; kind: string }>>(o, o.lan, 'crm.pipeline.setup', {});
      const trans = (await list(o, o.lan, all({ field: 'search', op: 'contains', value: 'Trần Văn B' }))).items[0];
      const cuc = (await list(o, o.lan, all({ field: 'search', op: 'contains', value: 'Lê Thị Cúc' }))).items[0];
      const open = stages.find((s) => s.kind === 'open');
      const won = stages.find((s) => s.kind === 'won');
      // A deal starts in an open stage; Cúc's is won at once.
      const deal = (partyId: string | undefined, title: string) =>
        exec<{ id: string; version: number }>(o, o.lan, 'crm.deal.create', { partyId, title, amount: '1000000', expectedClose: null, ...(open ? { stageId: open.id } : {}) });
      const opened = await deal(trans?.id, 'Báo giá cho Trần Văn B');
      const closed = await deal(cuc?.id, 'Đã chốt với Lê Thị Cúc');
      await exec(o, o.lan, 'crm.deal.move', { dealId: closed.id, version: closed.version, stageId: won?.id });
      expect(await names(o, o.lan, all({ field: 'has_open_deal', op: 'is', value: true }))).toEqual(['Trần Văn B']);
      expect(await names(o, o.lan, all({ field: 'has_open_deal', op: 'is', value: false }))).toHaveLength(4);
      // Won and lost deals are not open: the contact leaves the list once its only open deal is won.
      await exec(o, o.lan, 'crm.deal.move', { dealId: opened.id, version: opened.version, stageId: won?.id });
      expect(await names(o, o.lan, all({ field: 'has_open_deal', op: 'is', value: true }))).toEqual([]);
      // Another org's deals never count here.
      expect(await names(other, other.owner, all({ field: 'has_open_deal', op: 'is', value: true }))).toEqual([]);
      expect(await names(o, o.lan, all({ field: 'created', op: 'within_last_days', value: 1 }))).toHaveLength(5);
      // Conditions are ANDed.
      expect(await names(o, o.lan, all({ field: 'kind', op: 'is', value: 'organization' }, { field: 'has_email', op: 'is', value: true }))).toEqual(['Công ty Nguyễn Hoàng']);
    });

    it('applies a saved view of the contacts, and a view cannot widen what the member reads', async () => {
      const view = await exec<{ viewId: string }>(o, o.lan, 'kernel.saved_view.save', {
        scope: 'crm.party',
        name: 'Công ty có email',
        filters: { v: 1, all: [{ field: 'kind', op: 'is', value: 'organization' }, { field: 'has_email', op: 'is', value: true }] },
        sort: { field: 'name', dir: 'desc' },
        shared: true,
      });
      const views = await rt.query<Array<{ id: string; filters: FilterAst; sort: { field: string; dir: 'asc' | 'desc' } | null }>>('kernel.saved_view.list', { scope: 'crm.party' }, { actor: asUser(o.viewer), orgId: o.orgId });
      const stored = views.find((v) => v.id === view.viewId);
      // A viewer opens the shared view: the same contacts as the filter typed by hand.
      expect(await names(o, o.viewer, { filters: stored?.filters, sort: stored?.sort })).toEqual(['Công ty Nguyễn Hoàng']);
      // Another org applying it lists its own contacts, never ours.
      expect(await names(other, other.owner, { filters: stored?.filters, sort: stored?.sort })).toEqual([]);
      expect(await names(other, other.owner, { filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'nguyen' }] } })).toEqual(['Nguyễn của tổ chức khác']);
    });

    it('sorts by name, creation and change, either way, and pages by cursor listing every contact once', async () => {
      const asc = await names(o, o.lan, { sort: { field: 'name', dir: 'asc' } });
      expect(await names(o, o.lan, { sort: { field: 'name', dir: 'desc' } })).toEqual([...asc].reverse());
      const created = await names(o, o.lan, { sort: { field: 'created', dir: 'asc' } });
      expect(created[0]).toBe('Công ty Nguyễn Hoàng');
      expect(created.at(-1)).toBe('Phạm Thị D');
      expect(await names(o, o.lan, { sort: { field: 'created', dir: 'desc' } })).toEqual([...created].reverse());
      expect(await names(o, o.lan, { sort: { field: 'updated', dir: 'desc' } })).toHaveLength(5);
      for (const sort of [{ field: 'name', dir: 'asc' }, { field: 'name', dir: 'desc' }, { field: 'created', dir: 'desc' }, { field: 'updated', dir: 'asc' }]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const got = await list(o, o.lan, { sort, limit: 2, ...(cursor ? { cursor } : {}) });
          expect(got.items.length).toBeLessThanOrEqual(2);
          seen.push(...got.items.map((c) => c.name));
          if (got.next === null) break;
          cursor = got.next;
        }
        expect(seen, JSON.stringify(sort)).toEqual(await names(o, o.lan, { sort }));
        expect(new Set(seen).size).toBe(5);
      }
      // A page stays stable while a contact is added: the next page never repeats one already shown.
      const first = await list(o, o.lan, { limit: 2, sort: { field: 'name', dir: 'asc' } });
      await create(o, o.lan, { name: 'Aaa vừa thêm' });
      const second = await list(o, o.lan, { limit: 2, sort: { field: 'name', dir: 'asc' }, cursor: first.next as string });
      expect(second.items.map((c) => c.name).filter((n) => first.items.some((f) => f.name === n))).toEqual([]);
    });

    it('pages through contacts with the longest names, and refuses a forged cursor with 422', async () => {
      const long = await org();
      const stem = 'CÔNG TY CỔ PHẦN ĐẦU TƯ XÂY DỰNG VÀ PHÁT TRIỂN HẠ TẦNG ĐÔ THỊ NGUYỄN TRẦN LÊ PHẠM '.repeat(3).slice(0, 290);
      for (const [i, letter] of ['A', 'B', 'C'].entries()) await create(long, long.lan, { kind: 'organization', name: `${stem}${letter}${i}` });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const got = await list(long, long.lan, { limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...got.items.map((c) => c.name));
        // The cursor never holds a name: it stays short whatever the names are.
        if (got.next !== null) expect(got.next.length).toBeLessThan(120);
        if (got.next === null) break;
        cursor = got.next;
      }
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
      // A cursor made up by hand: not an id, an id of nothing, another org's contact, or a valid one for another sort.
      const forge = (payload: object) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const mine = (await list(long, long.lan)).items[0];
      const theirs = (await list(other, other.owner)).items[0];
      for (const id of ['-'.repeat(36), randomUUID(), theirs?.id]) {
        await expect(list(long, long.lan, { cursor: forge({ f: 'name', d: 'asc', id }) }), String(id)).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      }
      await expect(list(long, long.lan, { cursor: forge({ f: 'name', d: 'asc', id: "'; DROP TABLE crove_kernel.party; --" }) })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(long, long.lan, { cursor: forge({ f: 'created', d: 'asc', id: mine?.id }) })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(long, long.lan, { cursor: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    });

    it('leaves out a duplicate, answers 422 to an unknown field, sort or cursor, and a cursor from another sort', async () => {
      const dup = await create(o, o.lan, { name: 'Bản sao Trần Văn B' });
      const keep = (await list(o, o.lan, { filters: all({ field: 'search', op: 'contains', value: 'Trần Văn B' }).filters })).items.find((c) => c.name === 'Trần Văn B');
      await exec(o, o.owner, 'kernel.party.mark_duplicate', { partyId: dup.partyId, keepId: keep?.id });
      expect(await names(o, o.lan, all({ field: 'search', op: 'contains', value: 'Trần Văn B' }))).toEqual(['Trần Văn B']);
      await expect(list(o, o.lan, all({ field: 'color', op: 'is', value: 'red' }))).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(o, o.lan, all({ field: 'stage', op: 'in', value: [randomUUID()] }))).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(o, o.lan, { sort: { field: 'amount', dir: 'asc' } })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(o, o.lan, { cursor: 'không-phải-con-trỏ' })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      const page = await list(o, o.lan, { limit: 1, sort: { field: 'name', dir: 'asc' } });
      await expect(list(o, o.lan, { limit: 1, sort: { field: 'created', dir: 'asc' }, cursor: page.next as string })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
      await expect(list(o, o.lan, { limit: 101 })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    });
  });
});
