// SPDX-License-Identifier: AGPL-3.0-only
// The saved layouts of the banks' bulk-salary files, through the real commands (#2893, payroll plan 6.4) on a real PostgreSQL 17:
// - an owner and an admin create, edit, list and delete a template; the layout comes back as saved;
// - a name is unique per entity (create and edit say so); the same name in another entity is fine;
// - a layout with an unknown column, a repeated one, five columns, a header too long or a brace form other than {month} is refused before anything is stored;
// - a member and a viewer can call none of the four; a template of another org is not found; the audit rows hold ids and field names, never a header or a content text.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const COLUMNS = [
  { key: 'sequence', header: 'STT' },
  { key: 'name', header: 'Ten nguoi nhan' },
  { key: 'account', header: 'So tai khoan' },
  { key: 'bank', header: 'Ngan hang' },
  { key: 'amount', header: 'So tien' },
  { key: 'content', header: 'Noi dung' },
];
const layout = (over: Record<string, unknown> = {}) => ({ columns: COLUMNS, content: 'Luong thang {month}', ...over });
interface Template {
  id: string;
  legalEntityId: string;
  name: string;
  layout: { columns: Array<{ key: string; header: string }>; content: string };
}

suite('saved bank templates through the commands (#2893)', () => {
  const dbName = `crove_test_hr_bank_cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Mẫu ngân hàng ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));
    const exec = <O>(userId: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(userId), orgId });
    const list = (userId: string, input: unknown = {}) => rt.query<Template[]>('hr.payroll.bank_template.list', input, { actor: asUser(userId), orgId });
    const create = (userId: string, input: unknown) => exec<{ templateId: string }>(userId, 'hr.payroll.bank_template.create', input);
    const branch = () => withAdmin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])).rows[0]?.id as string);
    const audits = (command: string) => withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, owner, admin, member, viewer, exec, list, create, branch, audits };
  }

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('lets an owner and an admin create, edit, list and delete a template, and gives the layout back as saved', async () => {
    const o = await org();
    const a = await o.create(o.owner, { name: 'Vietcombank', layout: layout() });
    const b = await o.create(o.admin, { name: 'ACB', layout: layout({ content: 'Salary {month}' }) });
    const listed = await o.list(o.owner);
    expect(listed.map((t) => t.name)).toEqual(['ACB', 'Vietcombank']);
    expect(listed.find((t) => t.id === a.templateId)?.layout).toEqual(layout());
    // Trimmed on the way in, edited by name and by layout, and the stamp moves.
    await o.exec(o.admin, 'hr.payroll.bank_template.edit', { templateId: a.templateId, name: '  VCB  ', layout: layout({ columns: [...COLUMNS].reverse() }) });
    const edited = (await o.list(o.owner)).find((t) => t.id === a.templateId);
    expect(edited?.name).toBe('VCB');
    const stamped = await withAdmin(async (c) => (await c.query<{ moved: boolean }>('SELECT updated_at > created_at AS moved FROM crove_hr.payroll_bank_template WHERE org_id = $1 AND id = $2', [o.orgId, a.templateId])).rows[0]?.moved);
    expect(stamped).toBe(true);
    expect(edited?.layout.columns.map((c) => c.key)).toEqual(['content', 'amount', 'bank', 'account', 'name', 'sequence']);
    await o.exec(o.owner, 'hr.payroll.bank_template.delete', { templateId: b.templateId });
    expect((await o.list(o.admin)).map((t) => t.name)).toEqual(['VCB']);
  });

  it('keeps a name once per entity, on create and on edit, and allows it in another entity', async () => {
    const o = await org();
    const first = await o.create(o.owner, { name: 'Techcombank', layout: layout() });
    await expect(o.create(o.owner, { name: 'Techcombank', layout: layout() })).rejects.toMatchObject({ code: 'HR_BANK_TEMPLATE_NAME_TAKEN', status: 409 });
    const other = await o.create(o.owner, { name: 'BIDV', layout: layout() });
    await expect(o.exec(o.owner, 'hr.payroll.bank_template.edit', { templateId: other.templateId, name: 'Techcombank' })).rejects.toMatchObject({ code: 'HR_BANK_TEMPLATE_NAME_TAKEN' });
    // Editing a template to its own name is not a clash.
    await o.exec(o.owner, 'hr.payroll.bank_template.edit', { templateId: first.templateId, name: 'Techcombank', layout: layout({ content: 'Luong {month}' }) });
    const branch = await o.branch();
    await o.create(o.owner, { legalEntityId: branch, name: 'Techcombank', layout: layout() });
    expect((await o.list(o.owner, { legalEntityId: branch })).map((t) => t.name)).toEqual(['Techcombank']);
    expect((await o.list(o.owner)).map((t) => t.name)).toEqual(['BIDV', 'Techcombank']);
  });

  it('refuses a layout with an unknown or repeated column, the wrong number of columns, a long header or another brace form, and stores nothing', async () => {
    const o = await org();
    const bad: unknown[] = [
      layout({ columns: [...COLUMNS.slice(0, 5), { key: 'note', header: 'Ghi chu' }] }),
      layout({ columns: [...COLUMNS.slice(0, 5), { key: 'name', header: 'Lap' }] }),
      layout({ columns: COLUMNS.slice(0, 5) }),
      layout({ columns: [{ key: 'sequence', header: 'x'.repeat(61) }, ...COLUMNS.slice(1)] }),
      layout({ columns: [{ key: 'sequence', header: '   ' }, ...COLUMNS.slice(1)] }),
      layout({ content: 'Luong {year}' }),
      layout({ content: 'Luong {{month}}' }),
      layout({ content: '' }),
      layout({ content: 'x'.repeat(141) }),
      { columns: COLUMNS },
    ];
    bad.push(layout({ content: 'Luong\u0000 {month}' }), layout({ columns: [{ key: 'sequence', header: 'ST\u0000T' }, ...COLUMNS.slice(1)] }));
    for (const one of bad) await expect(o.create(o.owner, { name: 'Bank', layout: one })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.create(o.owner, { name: '   ', layout: layout() })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.create(o.owner, { name: 'Ban\u0000k', layout: layout() })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.create(o.owner, { name: 'x'.repeat(81), layout: layout() })).rejects.toMatchObject({ code: 'VALIDATION' });
    // An edit that changes nothing is refused too.
    const ok = await o.create(o.owner, { name: 'Bank', layout: layout() });
    await expect(o.exec(o.owner, 'hr.payroll.bank_template.edit', { templateId: ok.templateId })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await o.list(o.owner)).map((t) => t.name)).toEqual(['Bank']);
  });

  it('refuses a member and a viewer on all four, and does not find a template of another org', async () => {
    const o = await org();
    const t = await o.create(o.owner, { name: 'Bank', layout: layout() });
    for (const who of [o.member, o.viewer]) {
      await expect(o.create(who, { name: 'Other', layout: layout() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.exec(who, 'hr.payroll.bank_template.edit', { templateId: t.templateId, name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.exec(who, 'hr.payroll.bank_template.delete', { templateId: t.templateId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.list(who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const stranger = await org();
    await expect(stranger.exec(stranger.owner, 'hr.payroll.bank_template.edit', { templateId: t.templateId, name: 'X' })).rejects.toMatchObject({ code: 'HR_BANK_TEMPLATE_NOT_FOUND' });
    await expect(stranger.exec(stranger.owner, 'hr.payroll.bank_template.delete', { templateId: t.templateId })).rejects.toMatchObject({ code: 'HR_BANK_TEMPLATE_NOT_FOUND' });
    await expect(o.exec(o.owner, 'hr.payroll.bank_template.delete', { templateId: randomUUID() })).rejects.toMatchObject({ code: 'HR_BANK_TEMPLATE_NOT_FOUND' });
    expect((await stranger.list(stranger.owner)).length).toBe(0);
    expect((await o.list(o.owner)).length).toBe(1);
  });

  it('leaves audit rows with ids and the names of the changed fields only', async () => {
    const o = await org();
    const t = await o.create(o.owner, { name: 'Ngan hang rieng', layout: layout({ content: 'Noi dung rieng {month}' }) });
    await o.exec(o.owner, 'hr.payroll.bank_template.edit', { templateId: t.templateId, layout: layout() });
    await o.exec(o.owner, 'hr.payroll.bank_template.delete', { templateId: t.templateId });
    const rows = [...(await o.audits('hr.payroll.bank_template.create')), ...(await o.audits('hr.payroll.bank_template.edit')), ...(await o.audits('hr.payroll.bank_template.delete'))];
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok']);
    const text = JSON.stringify(rows.map((r) => r.detail));
    expect(text).toContain(t.templateId);
    expect(text).toContain('layout');
    for (const secret of ['Ngan hang rieng', 'Noi dung rieng', 'Ten nguoi nhan', 'So tai khoan']) expect(text).not.toContain(secret);
  });
});
