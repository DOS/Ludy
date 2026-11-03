// SPDX-License-Identifier: AGPL-3.0-only
// The company a person works at (#2438) against the books on PostgreSQL 17: `party` is shared with the accounting, so with `company_id` set the accounting's
// customer and vendor reads answer the same shape, an invoice's party is still found by its tax code (no second party, the link untouched), a party that books
// point at keeps its kind while a fresh one can change it, and a company the writer cannot see is refused by the command (so the legal-entity policy to come on
// `party`, #1538, needs no change in the link). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { PARTY_KIND_HOLDERS, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Party } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Checksum-invalid tax codes on purpose (#157).
const CUSTOMER_TAX_CODE = '0309876546';
const VENDOR_TAX_CODE = '0305551110';

suite('the company of a person and the accounting (#2438)', () => {
  const dbName = `crove_test_party_company_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; member: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await identity('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    return { orgId, owner, member };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const create = (o: Org, input: Record<string, unknown>) => execute<{ partyId: string; version: number }>(o, 'kernel.party.create', input);
  const partiesWithTax = async (o: Org, taxCode: string) => admin(async (c) => (await c.query<{ id: string; company_id: string | null }>('SELECT id, company_id FROM crove_kernel.party WHERE org_id = $1 AND tax_code = $2', [o.orgId, taxCode])).rows);
  // The opening balances: a receivable of the customer company, a payable of the vendor, and cash that balances them.
  const books = (o: Org) =>
    execute(o, 'finance.opening_balance.post', {
      asOf: '2025-12-31',
      rows: [
        { rowNo: 2, accountCode: '112', accountName: 'Tiền gửi', debit: '50000000', credit: '' },
        { rowNo: 3, accountCode: '131', accountName: 'Phải thu', debit: '20000000', credit: '', partyTaxCode: CUSTOMER_TAX_CODE, partyName: 'Công ty Khách Hàng' },
        { rowNo: 4, accountCode: '331', accountName: 'Phải trả', debit: '', credit: '70000000', partyTaxCode: VENDOR_TAX_CODE, partyName: 'Công ty Nhà Cung Cấp' },
      ],
    });
  const shapeOf = (rows: Array<Record<string, unknown>>) => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...crmCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...crmQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the accounting reads and the matching of an invoice party by tax code the same with company_id set', async () => {
    // Two orgs, the same books: one with people linked to the customer company, one with no link at all.
    const linked = await org();
    const plain = await org();
    for (const o of [linked, plain]) await create(o, { kind: 'organization', name: 'Công ty Khách Hàng', taxCode: CUSTOMER_TAX_CODE });
    const company = (await partiesWithTax(linked, CUSTOMER_TAX_CODE))[0]?.id as string;
    const lan = await create(linked, { kind: 'person', name: 'Lan Trần', phone: '0912 345 678' });
    await execute(linked, 'kernel.party.set_company', { partyId: lan.partyId, companyId: company, version: lan.version });
    await create(plain, { kind: 'person', name: 'Lan Trần', phone: '0912 345 678' });
    // The books name the company by its tax code: the party is found, not made again, and its people stay linked.
    await books(linked);
    await books(plain);
    expect(await partiesWithTax(linked, CUSTOMER_TAX_CODE)).toEqual([{ id: company, company_id: null }]);
    expect((await partiesWithTax(plain, CUSTOMER_TAX_CODE)).length).toBe(1);
    expect((await admin((c) => c.query<{ company_id: string | null }>('SELECT company_id FROM crove_kernel.party WHERE id = $1', [lan.partyId]))).rows[0]?.company_id).toBe(company);
    // The reads answer the same: the same parties, the same fields, no field of the link, and the person is no customer or vendor for having a company.
    const customers = async (o: Org) => (await query<{ items: Array<Record<string, unknown>> }>(o, 'finance.customers.list', {})).items;
    const vendors = async (o: Org, all: boolean) => query<Party[]>(o, 'finance.vendors.list', { all });
    expect((await customers(linked)).map((c) => [c.name, c.taxCode, c.receivable])).toEqual((await customers(plain)).map((c) => [c.name, c.taxCode, c.receivable]));
    expect((await customers(linked)).map((c) => c.name)).toEqual(['Công ty Khách Hàng']);
    for (const all of [false, true]) {
      const a = await vendors(linked, all);
      const b = await vendors(plain, all);
      expect(a.map((v) => [v.name, v.taxCode])).toEqual(b.map((v) => [v.name, v.taxCode]));
      expect(shapeOf(a as unknown as Array<Record<string, unknown>>)).toEqual(shapeOf(b as unknown as Array<Record<string, unknown>>));
      expect(JSON.stringify(a)).not.toMatch(/company/i);
    }
    expect(JSON.stringify(await customers(linked))).not.toMatch(/company/i);
    // The same with the crm module off: a runtime with no crm commands and the module absent answers as the one that has them.
    const noCrm = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['social', 'ads', 'crm', 'notes'] }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    expect(noCrm.installed('crm')).toBe(false);
    const ctx = { actor: asUser(linked.owner), orgId: linked.orgId };
    expect(await noCrm.query('finance.customers.list', {}, ctx)).toEqual(await rt.query('finance.customers.list', {}, ctx));
    for (const all of [false, true]) expect(await noCrm.query('finance.vendors.list', { all }, ctx)).toEqual(await rt.query('finance.vendors.list', { all }, ctx));
  });

  it('lets a party that nothing points at change its kind, and keeps the kind of one the books, a person or a link point at', async () => {
    const o = await org();
    await books(o);
    const booked = (await partiesWithTax(o, CUSTOMER_TAX_CODE))[0]?.id as string;
    const bookedVersion = Number((await admin((c) => c.query<{ version: number }>('SELECT version FROM crove_kernel.party WHERE id = $1', [booked]))).rows[0]?.version);
    const rename = (partyId: string, version: number, kind: 'person' | 'organization', name = 'Tên mới') =>
      execute<{ partyId: string; version: number }>(o, 'kernel.party.update', { partyId, version, name, taxCode: null, address: null, email: null, phone: null, kind });
    // The booked company has a receivable: it stays a company. (The tax code stays: it cannot be removed, so the call keeps it.)
    await expect(execute(o, 'kernel.party.update', { partyId: booked, version: bookedVersion, name: 'Công ty Khách Hàng', taxCode: CUSTOMER_TAX_CODE, address: null, email: null, phone: null, kind: 'person' })).rejects.toMatchObject({ code: 'PARTY_KIND_LOCKED', status: 422 });
    // A fresh party with nothing pointing at it: switch it both ways; the audit row names the field and no value.
    const fresh = await create(o, { kind: 'organization', name: 'Người nhập nhầm là công ty' });
    const FRESH = 'Người nhập nhầm là công ty';
    const asPerson = await rename(fresh.partyId, fresh.version, 'person', FRESH);
    expect((await admin((c) => c.query<{ kind: string }>('SELECT kind FROM crove_kernel.party WHERE id = $1', [fresh.partyId]))).rows[0]?.kind).toBe('person');
    const back = await rename(fresh.partyId, asPerson.version, 'organization', FRESH);
    expect(back.version).toBe(asPerson.version + 1);
    const audit = (await admin((c) => c.query<{ detail: { changed?: string[] } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.update' AND outcome = 'ok' AND detail ->> 'partyId' = $2 ORDER BY id", [o.orgId, fresh.partyId]))).rows;
    expect(audit.map((r) => r.detail.changed)).toEqual([['kind'], ['kind']]);
    // A company people work at stays a company; a person with a company clears the link before becoming a company.
    const person = await create(o, { kind: 'person', name: 'Bình Lê' });
    const linked = await execute<{ version: number }>(o, 'kernel.party.set_company', { partyId: person.partyId, companyId: fresh.partyId, version: person.version });
    await expect(rename(fresh.partyId, back.version, 'person', FRESH)).rejects.toMatchObject({ code: 'PARTY_KIND_LOCKED' });
    await expect(rename(person.partyId, linked.version, 'organization', 'Bình Lê')).rejects.toMatchObject({ code: 'PARTY_HAS_COMPANY', status: 422 });
    const cleared = await execute<{ version: number }>(o, 'kernel.party.set_company', { partyId: person.partyId, companyId: null, version: linked.version });
    await rename(person.partyId, cleared.version, 'organization', 'Bình Lê');
  });

  it('leaves a kind change to a member who sees every legal entity, as the rows of another entity are hidden from one limited to a branch', async () => {
    const o = await org();
    await books(o);
    const booked = (await partiesWithTax(o, CUSTOMER_TAX_CODE))[0]?.id as string;
    const fresh = await create(o, { kind: 'organization', name: 'Công ty nhập nhầm' });
    // An accountant limited to a branch: the books of the default entity are not theirs to see, so "nothing points at it" is not theirs to say.
    const accountant = await identity('accountant');
    await admin(async (c) => {
      const branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [o.orgId, o.owner])).rows[0]?.id;
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, accountant]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [o.orgId, accountant, branch, o.owner]);
    });
    const edit = (partyId: string, version: number, kind: 'person' | 'organization', name: string, user: string) =>
      execute<{ partyId: string; version: number }>(o, 'kernel.party.update', { partyId, version, name, taxCode: null, address: null, email: null, phone: null, kind }, user);
    const version = async (partyId: string) => Number((await admin((c) => c.query<{ version: number }>('SELECT version FROM crove_kernel.party WHERE id = $1', [partyId]))).rows[0]?.version);
    await expect(edit(fresh.partyId, fresh.version, 'person', 'Công ty nhập nhầm', accountant)).rejects.toMatchObject({ code: 'PARTY_KIND_SCOPE', status: 403 });
    // Editing the name, the same kind, is not a kind change: the limited member still does it.
    await edit(fresh.partyId, fresh.version, 'organization', 'Công ty đã đổi tên', accountant);
    // The owner sees every entity: the booked company stays a company, the fresh one may change.
    await expect(execute(o, 'kernel.party.update', { partyId: booked, version: await version(booked), name: 'Công ty Khách Hàng', taxCode: CUSTOMER_TAX_CODE, address: null, email: null, phone: null, kind: 'person' })).rejects.toMatchObject({ code: 'PARTY_KIND_LOCKED' });
    await edit(fresh.partyId, await version(fresh.partyId), 'person', 'Công ty đã đổi tên', o.owner);
  });

  it('merges a company into another company with its people, and refuses to merge a company people work at into a person', async () => {
    const o = await org();
    const company = await create(o, { kind: 'organization', name: 'Công ty A' });
    const same = await create(o, { kind: 'organization', name: 'Công ty A (trùng)' });
    const alone = await create(o, { kind: 'organization', name: 'Công ty không ai làm' });
    const lan = await create(o, { kind: 'person', name: 'Lan Trần' });
    const linked = await execute<{ version: number }>(o, 'kernel.party.set_company', { partyId: lan.partyId, companyId: same.partyId, version: lan.version });
    // Into a person: the people of the company would read a person as their company, or the person themselves.
    await expect(execute(o, 'kernel.party.mark_duplicate', { partyId: same.partyId, keepId: lan.partyId })).rejects.toMatchObject({ code: 'PARTY_MERGE_KIND', status: 422 });
    await expect(execute(o, 'kernel.party.mark_duplicate', { partyId: same.partyId, keepId: (await create(o, { kind: 'person', name: 'Bình Lê' })).partyId })).rejects.toMatchObject({ code: 'PARTY_MERGE_KIND' });
    // A company with no one working at it may go where the person chooses (nothing reads a company through it); another company is the usual case.
    await execute(o, 'kernel.party.mark_duplicate', { partyId: alone.partyId, keepId: lan.partyId });
    await execute(o, 'kernel.party.mark_duplicate', { partyId: same.partyId, keepId: company.partyId });
    const people = await query<{ items: Array<{ id: string; company: { id: string } | null }> }>(o, 'crm.contact.list', { filters: { v: 1, all: [{ field: 'company', op: 'is', value: company.partyId }] } });
    expect(people.items.map((p) => [p.id, p.company?.id])).toEqual([[lan.partyId, company.partyId]]);
    expect(linked.version).toBeGreaterThan(lan.version);
  });

  it('clears the link of a person who is erased, and of the people of a company that is erased', async () => {
    const o = await org();
    const company = await create(o, { kind: 'organization', name: 'Công ty xóa', email: 'cong-ty-xoa@example.test' });
    const lan = await create(o, { kind: 'person', name: 'Lan Trần', email: 'lan-tran@example.test' });
    const binh = await create(o, { kind: 'person', name: 'Bình Lê' });
    await execute(o, 'kernel.party.set_company', { partyId: lan.partyId, companyId: company.partyId, version: lan.version });
    await execute(o, 'kernel.party.set_company', { partyId: binh.partyId, companyId: company.partyId, version: binh.version });
    const companyOf = async (partyId: string) => (await admin((c) => c.query<{ company_id: string | null }>('SELECT company_id FROM crove_kernel.party WHERE id = $1', [partyId]))).rows[0]?.company_id;
    // An erasure is irreversible (R3): it needs a session of the owner.
    const erase = (value: string) => rt.execute('kernel.personal_data.erase', { value }, { actor: { ...asUser(o.owner), sessionId: randomUUID() }, orgId: o.orgId, idempotencyKey: randomUUID() });
    // Erasing the company by its email (it has no document, so it is forgotten): both people are no one's staff of it any more.
    await erase('cong-ty-xoa@example.test');
    expect(await companyOf(lan.partyId)).toBeNull();
    expect(await companyOf(binh.partyId)).toBeNull();
    // Erasing a person with a company (undocumented) clears their own link too.
    const another = await create(o, { kind: 'organization', name: 'Công ty khác' });
    const mai = await create(o, { kind: 'person', name: 'Mai Phạm', email: 'mai-pham@example.test' });
    await execute(o, 'kernel.party.set_company', { partyId: mai.partyId, companyId: another.partyId, version: mai.version });
    await erase('mai-pham@example.test');
    expect(await companyOf(mai.partyId)).toBeNull();
    expect(await companyOf(another.partyId)).toBeNull();
  });

  it('clears the company of a person the books name when they are erased, keeps their name for the books, and counts it', async () => {
    const o = await org();
    const company = await create(o, { kind: 'organization', name: 'Công ty Chủ Việc' });
    const hoa = await create(o, { kind: 'person', name: 'Hoa Nguyễn', email: 'hoa-chung-tu@example.test' });
    await execute(o, 'kernel.party.set_company', { partyId: hoa.partyId, companyId: company.partyId, version: hoa.version });
    // A line of the ledger names the person (a receivable), so the books keep their place and their name.
    await admin(async (c) => {
      await c.query('BEGIN');
      const entry = (await c.query<{ id: string }>("INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, current_date, 'Bán hàng', 'test.sale', $2) RETURNING id", [o.orgId, randomUUID()])).rows[0]?.id;
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '131', 500000, 0, $3), ($1, $2, 2, '511', 0, 500000, NULL)", [o.orgId, entry, hoa.partyId]);
      await c.query('COMMIT');
    });
    const erased = await rt.execute<{ erased: Array<{ column: string; rows: number }>; kept: Array<{ column: string }> }>(
      'kernel.personal_data.erase',
      { value: 'hoa-chung-tu@example.test' },
      { actor: { ...asUser(o.owner), sessionId: randomUUID() }, orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const row = (await admin((c) => c.query<{ name: string; company_id: string | null; email: string | null }>('SELECT name, company_id, email FROM crove_kernel.party WHERE id = $1', [hoa.partyId]))).rows[0];
    // The books keep the name; the employer and the contact details go.
    expect(row).toEqual({ name: 'Hoa Nguyễn', company_id: null, email: null });
    expect(erased.erased).toContainEqual({ column: 'crove_kernel.party.company_id', rows: 1 });
    expect(erased.erased).toContainEqual({ column: 'crove_kernel.party.email', rows: 1 });
    expect(erased.erased.map((e) => e.column)).not.toContain('crove_kernel.party.name');
  });

  it('knows every table that points at a party: each foreign key to party either holds its kind or is listed as not reading it', async () => {
    // A table added later with a foreign key to party fails here until it is put on one side: PARTY_KIND_HOLDERS (the rows that pin a party's kind) or this list.
    const NOT_READING_THE_KIND = ['crove_notes.link.party_id', 'crove_crm.import_row.match_party_id', 'crove_crm.import_row.company_party_id'];
    const { rows } = await admin((c) =>
      c.query<{ ref: string }>(
        `SELECT DISTINCT n.nspname || '.' || c.relname || '.' || a.attname AS ref
           FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN LATERAL unnest(k.conkey) AS u (attnum) ON true
           JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
          WHERE k.contype = 'f' AND k.confrelid = 'crove_kernel.party'::regclass AND a.attname <> 'org_id'`,
      ),
    );
    const holders = PARTY_KIND_HOLDERS.map(([table, column]) => `${table}.${column}`);
    const unknown = rows.map((r) => r.ref).filter((ref) => !holders.includes(ref) && !NOT_READING_THE_KIND.includes(ref));
    expect(unknown).toEqual([]);
    expect(holders.filter((h) => NOT_READING_THE_KIND.includes(h))).toEqual([]);
    // Everything listed as pinning the kind exists (a renamed column fails here and in the kind-change test), but the ledger line has no foreign key: it is the one
    // holder the catalog cannot show.
    expect(holders.filter((h) => !rows.some((r) => r.ref === h))).toEqual(['crove_finance.journal_line.party_id']);
  });

  it('refuses a company the writer cannot see, as the legal-entity policy to come on party will hide one (#1538)', async () => {
    const o = await org();
    const lan = await create(o, { kind: 'person', name: 'Hà Trần' });
    const hidden = await create(o, { kind: 'organization', name: 'Công ty không thấy được' });
    const visible = await create(o, { kind: 'organization', name: 'Công ty thấy được' });
    // The guard trigger and the command both read party as the writer, so a row the writer's policies hide is a company they cannot name. A restrictive policy
    // on party stands in for the one #1538 will add.
    await admin((c) => c.query(`CREATE POLICY test_hide_company ON crove_kernel.party AS RESTRICTIVE FOR SELECT TO crove_tenant USING (id <> '${hidden.partyId}'::uuid)`));
    try {
      await expect(execute(o, 'kernel.party.set_company', { partyId: lan.partyId, companyId: hidden.partyId, version: lan.version }, o.member)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
      await execute(o, 'kernel.party.set_company', { partyId: lan.partyId, companyId: visible.partyId, version: lan.version }, o.member);
    } finally {
      await admin((c) => c.query('DROP POLICY IF EXISTS test_hide_company ON crove_kernel.party'));
    }
  });
});
