// SPDX-License-Identifier: AGPL-3.0-only
// Contact import on PostgreSQL 17 (CRM slice 1, step K5, #2229): rows staged and classified without writing a party, the
// duplicate rules (tax code, then email, then phone key, inside the file too, a row naming two parties a conflict), the
// commit creating exactly the new rows once, filling only empty fields on request, the parties judged again at commit,
// staged rows deleted on commit, cancel and after 7 days, nothing but counts in the audit row, and who may run it. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ImportBatch, ImportCommitted, ImportPreview, ImportRowInput } from '@crove/kernel-contract';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A row as the browser posts it: only what the test names, the rest empty.
const row = (over: Partial<ImportRowInput> = {}): ImportRowInput => ({ kind: null, name: 'Nguyễn Văn An', taxCode: null, email: null, phone: null, address: null, ...over });

suite('contact import on PostgreSQL (CRM K5, #2229)', () => {
  const dbName = `crove_test_crm_import_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@import.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const lan = await person('lan');
    const huy = await person('huy');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, lan, huy, viewer]));
    const exec = <T>(user: string, name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(user), orgId });
    const stage = (user: string, rows: ImportRowInput[], filename = 'lien-he.csv') => exec<ImportPreview>(user, 'crm.import.stage', { filename, rows });
    const commit = (user: string, batchId: string, onDuplicate: 'skip' | 'fill_empty' = 'skip') => exec<ImportCommitted>(user, 'crm.import.commit', { batchId, onDuplicate });
    const party = (fields: { name: string; tax_code?: string; email?: string; phone?: string; address?: string }) =>
      admin((c) =>
        c
          .query<{ id: string }>('INSERT INTO crove_kernel.party (org_id, name, tax_code, email, phone, address) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [orgId, fields.name, fields.tax_code ?? null, fields.email ?? null, fields.phone ?? null, fields.address ?? null])
          .then((r) => r.rows[0]!.id),
      );
    const parties = () => admin((c) => c.query<{ name: string; kind: string; tax_code: string | null; email: string | null; phone: string | null; source_trust: string }>('SELECT name, kind, tax_code, email, phone, source_trust FROM crove_kernel.party WHERE org_id = $1 ORDER BY name', [orgId]).then((r) => r.rows));
    const stagedRows = (batchId: string) => admin((c) => c.query('SELECT 1 FROM crove_crm.import_row WHERE org_id = $1 AND batch_id = $2', [orgId, batchId]).then((r) => r.rowCount ?? 0));
    return { orgId, owner, lan, huy, viewer, exec, query, stage, commit, party, parties, stagedRows };
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

  it('stages and classifies rows without writing a party', async () => {
    const o = await org();
    await o.party({ name: 'Công ty Cũ', tax_code: '0123456780', email: 'cu@khach.test', phone: '0912 345 678' });
    const staged = await o.stage(o.lan, [
      row({ name: 'Mới Một', email: 'moi1@khach.test' }),
      row({ name: 'Trùng MST', taxCode: '0123456780' }),
      row({ name: 'Trùng email', email: 'CU@khach.test' }),
      row({ name: 'Trùng điện thoại', phone: '+84 912 345 678' }),
      row({ name: 'Mới Một lần nữa', email: 'moi1@khach.test' }),
      row({ name: '' }),
      row({ name: 'Email hỏng', email: 'không phải email' }),
      row({ name: 'MST hỏng', taxCode: '12' }),
      row({ name: 'Hai bên', taxCode: '0123456780', email: 'khac@khach.test' }),
    ]);
    expect(staged.batch).toMatchObject({ status: 'staged', filename: 'lien-he.csv', totalRows: 9, newRows: 1, duplicateRows: 5, conflictRows: 0, invalidRows: 3 });
    const byRow = new Map(staged.rows.map((r) => [r.rowNo, r]));
    expect(byRow.get(1)).toMatchObject({ outcome: 'new', reason: null, kind: 'person' });
    expect(byRow.get(2)).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_TAX_CODE', match: { name: 'Công ty Cũ' } });
    expect(byRow.get(3)).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_EMAIL', match: { name: 'Công ty Cũ' } });
    expect(byRow.get(4)).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_PHONE', match: { name: 'Công ty Cũ' } });
    expect(byRow.get(5)).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_IN_FILE', match: null });
    expect(byRow.get(6)).toMatchObject({ outcome: 'invalid', reason: 'INVALID_NAME' });
    expect(byRow.get(7)).toMatchObject({ outcome: 'invalid', reason: 'INVALID_EMAIL' });
    expect(byRow.get(8)).toMatchObject({ outcome: 'invalid', reason: 'INVALID_TAX_CODE' });
    // Its tax code names one party and its email none: a duplicate of that party, by the tax code.
    expect(byRow.get(9)).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_TAX_CODE', match: { name: 'Công ty Cũ' } });
    // Nothing reached party.
    expect((await o.parties()).map((p) => p.name)).toEqual(['Công ty Cũ']);
    // The preview pages in file order and filters by outcome.
    const first = await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: staged.batch.id, limit: 4 });
    expect(first.rows.map((r) => r.rowNo)).toEqual([1, 2, 3, 4]);
    expect(first.more).toBe(true);
    const rest = await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: staged.batch.id, after: 4 });
    expect(rest.rows.map((r) => r.rowNo)).toEqual([5, 6, 7, 8, 9]);
    expect(rest.more).toBe(false);
    expect((await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: staged.batch.id, outcome: 'invalid' })).rows.map((r) => r.rowNo)).toEqual([6, 7, 8]);
  });

  it('calls a row that names two parties a conflict, and skips it', async () => {
    const o = await org();
    await o.party({ name: 'Bên A', email: 'a@khach.test' });
    await o.party({ name: 'Bên B', phone: '0988 000 111' });
    const staged = await o.stage(o.owner, [row({ name: 'Hai bên', email: 'a@khach.test', phone: '0988000111' })]);
    expect(staged.rows[0]).toMatchObject({ outcome: 'conflict', reason: 'CONFLICT_PARTIES', match: null });
    const done = await o.commit(o.owner, staged.batch.id, 'fill_empty');
    expect(done.batch).toMatchObject({ status: 'committed', createdRows: 0, updatedRows: 0 });
    expect(done.skipped).toEqual([{ rowNo: 1, reason: 'CONFLICT_PARTIES' }]);
    expect((await o.parties()).map((p) => p.name)).toEqual(['Bên A', 'Bên B']);
  });

  it('commits exactly the new rows, once, as external parties, and deletes the staged rows', async () => {
    const o = await org();
    await o.party({ name: 'Sẵn có', email: 'san@khach.test' });
    const staged = await o.stage(o.lan, [
      row({ name: 'Công ty Mới', taxCode: '0123456780' }),
      row({ name: 'Trần Thị Bình', email: 'binh@khach.test', phone: '0903 111 222' }),
      row({ name: 'Trùng', email: 'san@khach.test' }),
      row({ name: 'Cá nhân rõ', kind: 'Cá nhân', taxCode: '0123456780' }),
      row({ name: 'Hỏng', email: 'x' }),
    ]);
    expect(staged.batch.newRows).toBe(2);
    const done = await o.commit(o.lan, staged.batch.id);
    expect(done.batch).toMatchObject({ status: 'committed', createdRows: 2, updatedRows: 0, onDuplicate: 'skip' });
    expect(done.skipped).toEqual([
      { rowNo: 3, reason: 'DUPLICATE_EMAIL' },
      { rowNo: 4, reason: 'DUPLICATE_IN_FILE' },
      { rowNo: 5, reason: 'INVALID_EMAIL' },
    ]);
    expect(await o.parties()).toEqual([
      { name: 'Công ty Mới', kind: 'organization', tax_code: '0123456780', email: null, phone: null, source_trust: 'external' },
      { name: 'Sẵn có', kind: 'organization', tax_code: null, email: 'san@khach.test', phone: null, source_trust: 'user' },
      { name: 'Trần Thị Bình', kind: 'person', tax_code: null, email: 'binh@khach.test', phone: '0903 111 222', source_trust: 'external' },
    ]);
    expect(await o.stagedRows(staged.batch.id)).toBe(0);
    // A second commit creates nothing and answers the first one's counts.
    const again = await o.commit(o.lan, staged.batch.id);
    expect(again.batch).toMatchObject({ status: 'committed', createdRows: 2 });
    expect((await o.parties()).length).toBe(3);
    // The timeline of a created party says where it came from.
    const timeline = await admin((c) => c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND kind = 'party.imported'", [o.orgId]));
    expect(timeline.rows).toHaveLength(2);
    // The preview of a decided batch has no rows.
    expect((await o.query<ImportPreview>(o.owner, 'crm.import.preview', { batchId: staged.batch.id })).rows).toEqual([]);
  });

  it('fills only empty fields of a duplicate when asked, and never overwrites a value', async () => {
    const o = await org();
    const id = await o.party({ name: 'Khách Cũ', email: 'cu@khach.test', phone: '0901 000 111' });
    const staged = await o.stage(o.owner, [row({ name: 'Tên Khác', email: 'cu@khach.test', phone: '0999 999 999', address: '12 Lê Lợi, Quận 1', taxCode: '0123456780' })]);
    expect(staged.rows[0]).toMatchObject({ outcome: 'duplicate', reason: 'DUPLICATE_EMAIL' });
    const done = await o.commit(o.owner, staged.batch.id, 'fill_empty');
    expect(done.batch).toMatchObject({ createdRows: 0, updatedRows: 1, onDuplicate: 'fill_empty' });
    const after = await admin((c) => c.query<{ name: string; email: string; phone: string; address: string; tax_code: string; version: number }>('SELECT name, email, phone, address, tax_code, version FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, id]));
    expect(after.rows[0]).toMatchObject({ name: 'Khách Cũ', email: 'cu@khach.test', phone: '0901 000 111', address: '12 Lê Lợi, Quận 1', tax_code: '0123456780', version: 2 });
    // With skip, the same row changes nothing.
    const other = await o.party({ name: 'Khách Hai', email: 'hai@khach.test' });
    const second = await o.stage(o.owner, [row({ name: 'Khách Hai', email: 'hai@khach.test', address: 'Hà Nội' })]);
    const skipped = await o.commit(o.owner, second.batch.id, 'skip');
    expect(skipped.batch).toMatchObject({ updatedRows: 0 });
    expect((await admin((c) => c.query<{ address: string | null }>('SELECT address FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, other]))).rows[0]!.address).toBeNull();
  });

  it('never gives a duplicate a tax code, email or phone that a row created in the same commit holds', async () => {
    const o = await org();
    const id = await o.party({ name: 'Khách Cũ', email: 'cu@khach.test' });
    const staged = await o.stage(o.owner, [
      row({ name: 'Công ty Mới', taxCode: '0123456780', email: 'moi@khach.test', phone: '0903 111 222' }),
      row({ name: 'Khách Cũ Lại', email: 'cu@khach.test', taxCode: '0123456780' }),
      row({ name: 'Khách Cũ Nữa', email: 'cu@khach.test', phone: '0903 111 222' }),
    ]);
    const done = await o.commit(o.owner, staged.batch.id, 'fill_empty');
    // The new row is made; the old party takes nothing the new one holds, and the commit does not fail on the tax code.
    expect(done.batch).toMatchObject({ status: 'committed', createdRows: 1 });
    const after = await admin((c) => c.query<{ tax_code: string | null; phone: string | null }>('SELECT tax_code, phone FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, id]));
    expect(after.rows[0]).toEqual({ tax_code: null, phone: null });
  });

  it('judges the rows again at commit: a party made since the preview turns a new row into a skipped duplicate', async () => {
    const o = await org();
    const staged = await o.stage(o.owner, [row({ name: 'Vừa Có', taxCode: '0123456780' }), row({ name: 'Chưa Có', email: 'chua@khach.test' })]);
    expect(staged.batch.newRows).toBe(2);
    await o.party({ name: 'Người Khác Tạo', tax_code: '0123456780' });
    const done = await o.commit(o.owner, staged.batch.id);
    expect(done.batch).toMatchObject({ createdRows: 1 });
    expect(done.skipped).toEqual([{ rowNo: 1, reason: 'DUPLICATE_TAX_CODE' }]);
    expect((await o.parties()).map((p) => p.name)).toEqual(['Chưa Có', 'Người Khác Tạo']);
  });

  it('deletes the rows on cancel, and refuses a commit after it', async () => {
    const o = await org();
    const staged = await o.stage(o.lan, [row()]);
    await expect(o.exec(o.huy, 'crm.import.cancel', { batchId: staged.batch.id })).rejects.toMatchObject({ code: 'IMPORT_FORBIDDEN', status: 403 });
    const cancelled = await o.exec<ImportBatch>(o.lan, 'crm.import.cancel', { batchId: staged.batch.id });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(await o.stagedRows(staged.batch.id)).toBe(0);
    await expect(o.commit(o.lan, staged.batch.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_STAGED', status: 409 });
    expect((await o.exec<ImportBatch>(o.lan, 'crm.import.cancel', { batchId: staged.batch.id })).status).toBe('cancelled');
    expect(await o.parties()).toEqual([]);
  });

  it('refuses and deletes a batch staged more than 7 days ago', async () => {
    const o = await org();
    const old = await o.stage(o.lan, [row({ name: 'Cũ' })]);
    await admin((c) => c.query("UPDATE crove_crm.import_batch SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2", [o.orgId, old.batch.id]));
    // The preview already calls it expired, though no command has run yet.
    expect((await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: old.batch.id })).batch.status).toBe('expired');
    // A commit answers that it expired, makes nothing, and its rows are gone for good.
    expect((await o.commit(o.lan, old.batch.id)).batch).toMatchObject({ status: 'expired', createdRows: 0 });
    expect(await o.stagedRows(old.batch.id)).toBe(0);
    expect((await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: old.batch.id })).batch).toMatchObject({ status: 'expired' });
    // Another batch staged long ago loses its rows when any import command runs in the org.
    const forgotten = await o.stage(o.huy, [row({ name: 'Quên' })]);
    await admin((c) => c.query("UPDATE crove_crm.import_batch SET created_at = now() - interval '9 days' WHERE org_id = $1 AND id = $2", [o.orgId, forgotten.batch.id]));
    await o.stage(o.owner, [row({ name: 'Mới' })]);
    expect(await o.stagedRows(forgotten.batch.id)).toBe(0);
    expect(await o.parties()).toEqual([]);
  });

  it('takes 2,000 rows and no more, and keeps the audit row to counts', async () => {
    const o = await org();
    const rows = Array.from({ length: 2000 }, (_, i) => row({ name: `Liên hệ bí mật ${i}`, email: `bimat${i}@khach.test` }));
    const staged = await o.stage(o.owner, rows);
    expect(staged.batch).toMatchObject({ totalRows: 2000, newRows: 2000 });
    expect(await o.stagedRows(staged.batch.id)).toBe(2000);
    expect((await o.parties()).length).toBe(0);
    await expect(o.stage(o.owner, [...rows, row()])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.stage(o.owner, [])).rejects.toMatchObject({ code: 'VALIDATION' });
    const done = await o.commit(o.owner, staged.batch.id);
    expect(done.batch).toMatchObject({ createdRows: 2000 });
    expect((await o.parties()).length).toBe(2000);
    const audit = await admin((c) => c.query("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.import.%' AND outcome = 'ok'", [o.orgId]));
    const text = JSON.stringify(audit.rows);
    expect(audit.rows.map((r) => r.command).sort()).toEqual(['crm.import.commit', 'crm.import.stage']);
    expect(text).not.toContain('bí mật');
    expect(text).not.toContain('bimat');
  });

  it('lets owners, admins and members import, viewers only read, and no system actor run it', async () => {
    const o = await org();
    await expect(o.stage(o.viewer, [row()])).rejects.toMatchObject({ status: 403 });
    const staged = await o.stage(o.lan, [row()]);
    await expect(o.commit(o.viewer, staged.batch.id)).rejects.toMatchObject({ status: 403 });
    // The rows are personal data from a person's file: the person who staged them, an owner or an admin read them, no one else.
    await expect(o.query(o.viewer, 'crm.import.preview', { batchId: staged.batch.id })).rejects.toMatchObject({ code: 'IMPORT_FORBIDDEN', status: 403 });
    await expect(o.query(o.huy, 'crm.import.preview', { batchId: staged.batch.id })).rejects.toMatchObject({ code: 'IMPORT_FORBIDDEN', status: 403 });
    expect((await o.query<ImportPreview>(o.lan, 'crm.import.preview', { batchId: staged.batch.id })).rows).toHaveLength(1);
    expect((await o.query<ImportPreview>(o.owner, 'crm.import.preview', { batchId: staged.batch.id })).rows).toHaveLength(1);
    // The org's owner may decide a member's batch.
    expect((await o.commit(o.owner, staged.batch.id)).batch.createdRows).toBe(1);
    await expect(rt.execute('crm.import.stage', { filename: 'x.csv', rows: [row()] }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toBeDefined();
  });

  it('keeps one org out of another', async () => {
    const a = await org();
    const b = await org();
    const staged = await a.stage(a.owner, [row({ name: 'Của A', email: 'a@khach.test' })]);
    await expect(b.query(b.owner, 'crm.import.preview', { batchId: staged.batch.id })).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
    await expect(b.commit(b.owner, staged.batch.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
    // The same email in another org is not a duplicate.
    await b.party({ name: 'Của B', email: 'a@khach.test' });
    expect((await a.stage(a.owner, [row({ name: 'Mới', email: 'a@khach.test' })])).rows[0]).toMatchObject({ outcome: 'new' });
  });
});
