// SPDX-License-Identifier: AGPL-3.0-only
// The HR module's people (#2530, payroll plan 6.1 and 6.6, ADR-0046, ADR-0017) on a real PostgreSQL 17, through the runtime:
// - owners and admins add, edit, end and read employees, employment terms and dependents; a member, a viewer and the system read and write nothing, and cannot tell whether a row exists;
// - every read leaves an audit row before it (a sensitive query), and no audit fact, response or log line carries the identity number or the account number;
// - the identity number and the account number are stored sealed: a canary of each is in no column of any crove_* table, before and after an erasure;
// - an erasure after the retention (the date moved) deletes the person's key, so the two numbers can never be opened again, clears the name, the address and the dependents' names, and
//   leaves the append-only employment rows readable as amounts;
// - the employment rows are append-only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { HR_ERASED_NAME, vietnamToday, type HrEmployee, type HrEmployeeErased, type HrEmployeeSummary, type HrWritten } from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, parseVaultKey, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { hrCommands, hrQueries, retentionEnds } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A national id and a bank account as a person types them, and their digits alone: all are searched for in the whole database.
const IDENTITY = '079 123 456 789';
const IDENTITY_DIGITS = '079123456789';
const ACCOUNT = '1903 4455 6677 88';
const ACCOUNT_DIGITS = '19034455667788';
const NEEDLES = [IDENTITY, IDENTITY_DIGITS, '79123456789', ACCOUNT, ACCOUNT_DIGITS];
const NAME = 'Nguyễn Thị Hằng Canary';
const ADDRESS = '12 Đường Canary, Quận 1';
const DEPENDENT = 'Nguyễn Văn Con Canary';

const TERMS = { effectiveFrom: '2026-01-01', contractType: 'indefinite' as const, region: 'I' as const, baseWage: '15000000' };

suite('HR payroll people on PostgreSQL (#2530)', () => {
  const dbName = `crove_test_hr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // R3 needs a fresh second factor.
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  // What a member would see: the rows of the three tables, read and written through the runtime in the caller's own context, by test-only commands and queries that every role may call,
  // so the database's policies are what refuse them (the module's own access lists would refuse first).
  const PEEK = defineQuery({
    name: 't2530.peek',
    input: z.object({}),
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async (ctx) => {
      const employees = await ctx.trx.selectFrom('crove_hr.payroll_employee').select('id').where('org_id', '=', ctx.orgId).execute();
      const employments = await ctx.trx.selectFrom('crove_hr.payroll_employment').select('id').where('org_id', '=', ctx.orgId).execute();
      const dependents = await ctx.trx.selectFrom('crove_hr.payroll_dependent').select('id').where('org_id', '=', ctx.orgId).execute();
      return { employees: employees.length, employments: employments.length, dependents: dependents.length };
    },
  }) as QueryDef<unknown, unknown>;
  const INSERT = defineCommand({
    name: 't2530.insert',
    input: z.object({ legalEntityId: z.string() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin', 'member', 'viewer'],
    writes: [],
    handler: async (ctx, input) => {
      await ctx.trx.insertInto('crove_hr.payroll_employee').values({ org_id: ctx.orgId, legal_entity_id: input.legalEntityId, display_name: 'Not allowed' }).execute();
      return {};
    },
  }) as CommandDef<unknown, unknown>;
  const SYSTEM_PEEK = defineCommand({
    name: 't2530.system_peek',
    input: z.object({}),
    risk: 'R1',
    sideEffect: 'internal',
    access: 'system',
    writes: [],
    handler: async (ctx) => {
      const rows = await ctx.trx.selectFrom('crove_hr.payroll_employee').select('id').where('org_id', '=', ctx.orgId).execute();
      return { employees: rows.length };
    },
  }) as CommandDef<unknown, unknown>;

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Every column of the crove schemas that can hold text, bytes or a number, searched for each form of the two numbers: the places they are found.
  const hits = (needles: readonly string[] = NEEDLES) =>
    withAdmin(async (c) => {
      const cols = (
        await c.query<{ s: string; t: string; c: string; type: string }>(
          `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type
             FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
            WHERE c.table_schema LIKE 'crove\\_%' AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY', 'USER-DEFINED', 'numeric', 'bigint', 'integer', 'smallint', 'double precision')`,
        )
      ).rows;
      const found: string[] = [];
      for (const { s, t, c: col, type } of cols) {
        for (const needle of needles) {
          const expr = type === 'bytea' ? `position(convert_to($1, 'UTF8') in "${col}") > 0` : `"${col}"::text LIKE '%' || $1 || '%'`;
          const { rowCount } = await c.query(`SELECT 1 FROM "${s}"."${t}" WHERE ${expr} LIMIT 1`, [needle]);
          if (rowCount) found.push(`${s}.${t}.${col}`);
        }
      }
      return [...new Set(found)];
    });

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Nhân sự ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const add = (userId: string, extra: Record<string, unknown> = {}) =>
      exec<HrWritten>(userId, 'hr.payroll.employee.add', { displayName: NAME, address: ADDRESS, identityNumber: IDENTITY, accountNumber: ACCOUNT, employment: TERMS, ...extra });
    const audits = (command: string) =>
      withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, owner, admin, member, viewer, exec, query, add, audits };
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
      subjectVault: new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands, INSERT, SYSTEM_PEEK], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, PEEK] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('lets an owner and an admin add an employee with terms, read the list, and open one with the sealed numbers', async () => {
    const o = await org();
    const mine = await o.add(o.owner);
    const theirs = await o.add(o.admin, { displayName: 'Trần Văn Hai' });
    expect(mine.employeeId && mine.employmentId).toBeTruthy();
    const list = await o.query<HrEmployeeSummary[]>(o.admin, 'hr.payroll.employee.list', {});
    expect(list.map((e) => e.id).sort()).toEqual([mine.employeeId, theirs.employeeId].sort());
    const first = list.find((e) => e.id === mine.employeeId);
    expect(first).toMatchObject({ displayName: NAME, status: 'active', hasIdentityNumber: true, hasAccountNumber: true, current: { contractType: 'indefinite', region: 'I', baseWage: '15000000.00', payFunction: 'admin' } });
    // The list never carries the numbers; the one employee asked for does, opened from the sealed text.
    expect(JSON.stringify(list)).not.toContain(IDENTITY_DIGITS);
    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: mine.employeeId });
    expect(detail).toMatchObject({ identityNumber: IDENTITY, accountNumber: ACCOUNT, address: ADDRESS, erased: false });
    expect(detail.employments).toHaveLength(1);
  });

  it('keeps the pay function with the terms: administration by default, a change of function is a new row', async () => {
    const o = await org();
    const plain = await o.add(o.owner);
    const sales = await o.add(o.owner, { displayName: 'Trần Văn Hai', employment: { ...TERMS, payFunction: 'sales' } });
    const list = await o.query<HrEmployeeSummary[]>(o.owner, 'hr.payroll.employee.list', {});
    expect(list.find((e) => e.id === plain.employeeId)?.current?.payFunction).toBe('admin');
    expect(list.find((e) => e.id === sales.employeeId)?.current?.payFunction).toBe('sales');
    await o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: sales.employeeId, effectiveFrom: '2026-07-01', contractType: 'indefinite', region: 'I', baseWage: '15000000', payFunction: 'production' });
    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: sales.employeeId });
    expect(detail.employments.map((t) => t.payFunction)).toEqual(['production', 'sales']);
    await expect(o.add(o.owner, { displayName: 'Lê Thị Ba', employment: { ...TERMS, payFunction: 'marketing' } })).rejects.toThrow();
  });

  it('keeps a member, a viewer and the system out: nothing is read, written or told, in the commands, the queries and the database', async () => {
    const o = await org();
    const created = await o.add(o.owner);
    for (const who of [o.member, o.viewer]) {
      await expect(o.add(who), 'add').rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.query(who, 'hr.payroll.employee.list', {}), 'list').rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.query(who, 'hr.payroll.employee.get', { employeeId: created.employeeId }), 'get').rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Even a caller the module's own lists would admit sees no row and cannot write one: the database's owner_admin policy.
      expect(await o.query(who, 't2530.peek')).toEqual({ employees: 0, employments: 0, dependents: 0 });
    }
    const entity = await withAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId])).rows[0]?.id as string);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const who of [o.member, o.viewer]) await expect(o.exec(who, 't2530.insert', { legalEntityId: entity })).rejects.toBeInstanceOf(DomainError);
    } finally {
      logged.mockRestore();
    }
    expect(await o.query(o.admin, 't2530.peek')).toEqual({ employees: 1, employments: 1, dependents: 0 });
    // The system context (the worker's) reads none.
    // (the database refuses the system context the schema outright)
    await expect(rt.execute('t2530.system_peek', {}, { actor: { type: 'system', component: 'hr' }, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A refused read leaves no audit row of a read.
    expect((await o.audits('hr.payroll.employee.list')).length).toBe(0);
  });

  it('writes an audit row before every read, and none of it carries a value', async () => {
    const o = await org();
    const created = await o.add(o.owner);
    await o.query(o.owner, 'hr.payroll.employee.list', {});
    await o.query(o.admin, 'hr.payroll.employee.list', {});
    await o.query(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect((await o.audits('hr.payroll.employee.list')).map((a) => a.outcome)).toEqual(['ok', 'ok']);
    expect((await o.audits('hr.payroll.employee.get')).map((a) => a.outcome)).toEqual(['ok']);
    const all = await withAdmin(async (c) => (await c.query<{ row: string }>('SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId])).rows.map((r) => r.row).join('\n'));
    for (const needle of [...NEEDLES, NAME, ADDRESS, '15000000']) expect(all, needle).not.toContain(needle);
    // What the add's own audit row says: ids, flags and a marker for each classified value.
    const [added] = await o.audits('hr.payroll.employee.add');
    expect(added?.detail).toMatchObject({ employeeId: created.employeeId, hasIdentityNumber: true, hasAccountNumber: true, name: { redacted: 'pii' }, baseWage: { redacted: 'sensitive' } });
  });

  it('stores the two numbers sealed: a canary is in no column of any crove table, and the stored text opens only at its place', async () => {
    const o = await org();
    const created = await o.add(o.owner);
    await o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, identityNumber: '012 987 654 321' });
    expect(await hits()).toEqual([]);
    const row = await withAdmin(async (c) => (await c.query<{ national_id_sealed: string; bank_account_sealed: string }>('SELECT national_id_sealed, bank_account_sealed FROM crove_hr.payroll_employee WHERE id = $1', [created.employeeId])).rows[0]);
    expect(row?.national_id_sealed).toMatch(/^crove:s1:/);
    expect(row?.bank_account_sealed).toMatch(/^crove:s1:/);
    // A plain number cannot be written into a sealed column, even by a statement that bypasses the commands.
    await expect(withAdmin((c) => c.query("UPDATE crove_hr.payroll_employee SET national_id_sealed = '079123456789' WHERE id = $1", [created.employeeId]))).rejects.toMatchObject({ code: '23514' });
    // The edit changed the identity number only.
    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect(detail).toMatchObject({ identityNumber: '012 987 654 321', accountNumber: ACCOUNT });
  });

  it('holds the birth date, the sealed tax code and insurance number, and the finalization authorization of a person (#2533)', async () => {
    const o = await org();
    const TAX = '8412905638';
    const INS = '7305186294';
    const created = await o.add(o.owner, { birthDate: '1990-05-17', taxCode: TAX, insuranceNumber: INS });
    // Both numbers are sealed: neither text is in any column of any crove table, and the stored text is a sealed value that opens at its own place only.
    expect(await hits([TAX, INS])).toEqual([]);
    const row = await withAdmin(async (c) => (await c.query<{ tax_code_sealed: string; insurance_number_sealed: string; birth_date: string }>('SELECT tax_code_sealed, insurance_number_sealed, birth_date::text FROM crove_hr.payroll_employee WHERE id = $1', [created.employeeId])).rows[0]);
    expect(row?.tax_code_sealed).toMatch(/^crove:s1:/);
    expect(row?.insurance_number_sealed).toMatch(/^crove:s1:/);
    await expect(withAdmin((c) => c.query(`UPDATE crove_hr.payroll_employee SET tax_code_sealed = '${TAX}' WHERE id = $1`, [created.employeeId]))).rejects.toMatchObject({ code: '23514' });
    expect(await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId })).toMatchObject({ birthDate: '1990-05-17', taxCode: TAX, insuranceNumber: INS, finalizationAuthorizedYears: [] });
    // The audit row of the add holds flags, never a value.
    const [added] = await o.audits('hr.payroll.employee.add');
    expect(added?.detail).toMatchObject({ hasTaxNumber: true, hasInsuranceNo: true, birth: { redacted: 'pii' } });
    expect(JSON.stringify(added?.detail)).not.toContain(TAX);
    // The formats: 10 or 12 digits for both numbers, a birth date from 1900 to today; nothing else is stored.
    for (const bad of [{ taxCode: '000000' }, { taxCode: '12345678901' }, { taxCode: 'AB12345678' }, { insuranceNumber: '000000' }, { insuranceNumber: 'SI-1234567890' }, { birthDate: '1899-12-31' }, { birthDate: '2999-01-01' }]) {
      await expect(o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, ...bad }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // An edit changes and clears them; the authorization is a list of years, each once, sorted; an admin may set it, a member may not; a year that has not begun is refused.
    const INS2 = '123456789012';
    await o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, taxCode: null, insuranceNumber: INS2 });
    const year = Number(vietnamToday().slice(0, 4));
    await o.exec(o.admin, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year, authorized: true });
    await o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year, authorized: true });
    await o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year: 2026, authorized: true });
    await expect(o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year: year + 1, authorized: true })).rejects.toMatchObject({ code: 'HR_YEAR_NOT_BEGUN' });
    await expect(o.exec(o.member, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year, authorized: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year: 1999, authorized: true })).rejects.toBeDefined();
    expect(await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId })).toMatchObject({ taxCode: null, insuranceNumber: INS2, finalizationAuthorizedYears: [...new Set([2026, year])].sort() });
    await o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year, authorized: false });
    // Revoking removes exactly that year: 2026 stays when the current year is a later one, and nothing is left when the current year is 2026.
    expect((await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId })).finalizationAuthorizedYears).toEqual(year === 2026 ? [] : [2026]);
    // A former employee: the declarations need the birth date, tax code and insurance number of a leaver, so those three may still be set (audited); nothing else of the record changes, and the authorization is not changed.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: created.employeeId, endedOn: '2026-08-31' });
    await o.exec(o.admin, 'hr.payroll.employee.edit', { employeeId: created.employeeId, birthDate: '1991-02-03', taxCode: '056123456789', insuranceNumber: '4051739286' });
    expect(await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId })).toMatchObject({ birthDate: '1991-02-03', taxCode: '056123456789', insuranceNumber: '4051739286' });
    await expect(o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, birthDate: '1991-02-04', address: 'Somewhere' })).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ENDED' });
    await expect(o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: created.employeeId, year: 2026, authorized: true })).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ENDED' });
    const edits = await o.audits('hr.payroll.employee.edit');
    expect(edits.filter((e) => e.outcome === 'ok').at(-1)?.detail).toMatchObject({ changed: ['birthDate', 'taxCode', 'insuranceNumber'] });
    expect(JSON.stringify(edits)).not.toContain('056123456789');
  });

  it('keeps the terms append-only and orders them: a raise is a new row, an older start is refused, the list shows the one in force', async () => {
    const o = await org();
    const created = await o.add(o.owner);
    await o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: created.employeeId, effectiveFrom: '2026-07-01', contractType: 'indefinite', region: 'II', baseWage: '18000000' });
    await expect(o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: created.employeeId, effectiveFrom: '2026-03-01', contractType: 'indefinite', region: 'I', baseWage: '1' })).rejects.toMatchObject({
      code: 'HR_EMPLOYMENT_NOT_NEWER',
    });
    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect(detail.employments.map((t) => [t.effectiveFrom, t.baseWage])).toEqual([
      ['2026-07-01', '18000000.00'],
      ['2026-01-01', '15000000.00'],
    ]);
    await expect(withAdmin((c) => c.query("UPDATE crove_hr.payroll_employment SET base_wage = 1 WHERE employee_id = $1", [created.employeeId]))).rejects.toThrow(/append-only/);
    await expect(withAdmin((c) => c.query('DELETE FROM crove_hr.payroll_employment WHERE employee_id = $1', [created.employeeId]))).rejects.toThrow(/append-only/);
  });

  it('adds and ends dependents and ends an employee, with the refusals', async () => {
    const o = await org();
    const created = await o.add(o.owner);
    const dep = await o.exec<HrWritten>(o.admin, 'hr.payroll.dependent.add', { employeeId: created.employeeId, displayName: DEPENDENT, relation: 'child', registeredOn: '2026-02-01' });
    await expect(o.exec(o.admin, 'hr.payroll.dependent.end', { dependentId: dep.dependentId, endedOn: '2026-01-01' })).rejects.toMatchObject({ code: 'HR_DEPENDENT_END_BEFORE_START' });
    await o.exec(o.admin, 'hr.payroll.dependent.end', { dependentId: dep.dependentId, endedOn: '2026-06-30' });
    await expect(o.exec(o.admin, 'hr.payroll.dependent.end', { dependentId: dep.dependentId, endedOn: '2026-07-01' })).rejects.toMatchObject({ code: 'HR_DEPENDENT_ENDED' });
    await expect(o.exec(o.admin, 'hr.payroll.employee.end', { employeeId: created.employeeId, endedOn: '2025-12-31' })).rejects.toMatchObject({ code: 'HR_END_BEFORE_START' });
    // A raise already scheduled after the last day of work does not stop the employee from leaving before it.
    await o.exec(o.admin, 'hr.payroll.employment.add', { employeeId: created.employeeId, effectiveFrom: '2026-09-01', contractType: 'indefinite', region: 'I', baseWage: '16000000' });
    await o.exec(o.admin, 'hr.payroll.employee.end', { employeeId: created.employeeId, endedOn: '2026-08-31' });
    // An ended employee takes no new terms or dependents, and drops out of the default list.
    await expect(o.exec(o.admin, 'hr.payroll.employment.add', { employeeId: created.employeeId, effectiveFrom: '2026-09-01', contractType: 'none', region: 'I', baseWage: '1000000' })).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ENDED' });
    expect(await o.query<HrEmployeeSummary[]>(o.admin, 'hr.payroll.employee.list', {})).toEqual([]);
    expect(await o.query<HrEmployeeSummary[]>(o.admin, 'hr.payroll.employee.list', { status: 'all' })).toHaveLength(1);
    const detail = await o.query<HrEmployee>(o.admin, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect(detail.dependents).toEqual([expect.objectContaining({ displayName: DEPENDENT, endedOn: '2026-06-30' })]);
    // A former employee's record is kept for the retention: no edit at all, so neither an admin nor an owner can clear the numbers, the name or the address.
    for (const who of [o.admin, o.owner]) {
      for (const change of [{ identityNumber: null }, { accountNumber: null }, { address: null }, { displayName: 'Changed' }]) {
        await expect(o.exec(who, 'hr.payroll.employee.edit', { employeeId: created.employeeId, ...change }), JSON.stringify(change)).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ENDED' });
      }
    }
    const kept = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect(kept).toMatchObject({ displayName: NAME, address: ADDRESS, identityNumber: IDENTITY, accountNumber: ACCOUNT });
  });

  it('erases an ended employee only after the retention, and then no one can open the numbers again', async () => {
    const o = await org();
    // Names of their own: the database holds the other tests' employees too.
    const tag = randomUUID().slice(0, 8);
    const [name, address, child] = [`${NAME} ${tag}`, `${ADDRESS} ${tag}`, `${DEPENDENT} ${tag}`];
    const created = await o.add(o.owner, { displayName: name, address });
    await o.exec(o.owner, 'hr.payroll.dependent.add', { employeeId: created.employeeId, displayName: child, relation: 'child', registeredOn: '2026-02-01' });
    const erase = () => o.exec<HrEmployeeErased>(o.owner, 'hr.payroll.employee.erase', { employeeId: created.employeeId }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, birthDate: '1985-03-09', taxCode: '5927301846', insuranceNumber: '618034297561' });
    // Not ended: refused. An admin is refused for the role.
    await expect(erase()).rejects.toMatchObject({ code: 'HR_EMPLOYEE_NOT_ENDED' });
    await expect(o.exec(o.admin, 'hr.payroll.employee.erase', { employeeId: created.employeeId }, asMfa(o.admin))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: created.employeeId, endedOn: '2026-08-31' });
    // Within the retention: refused, with the day it runs out.
    await expect(erase()).rejects.toMatchObject({ code: 'HR_RETENTION_NOT_PASSED', message: expect.stringContaining(retentionEnds('2026-08-31')) });
    // The boundary: left exactly ten years ago, today is the last day it is kept; a day later it can go.
    const leftOn = (years: string) => withAdmin((c) => c.query(`UPDATE crove_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '${years}')::date WHERE id = $1`, [created.employeeId]));
    await leftOn('10 years');
    await expect(erase()).rejects.toMatchObject({ code: 'HR_RETENTION_NOT_PASSED' });
    const before = await withAdmin(async (c) => (await c.query<{ national_id_sealed: string; bank_account_sealed: string }>('SELECT national_id_sealed, bank_account_sealed FROM crove_hr.payroll_employee WHERE id = $1', [created.employeeId])).rows[0]);
    // The date moved: the person left ten years and a day ago.
    await leftOn('10 years 1 day');
    const result = await erase();
    expect(result).toMatchObject({ employeeId: created.employeeId, shreddedKeys: 1 });
    expect(result.cleared).toContain('name');
    expect(result.kept.length).toBeGreaterThan(0);
    // The record reads as erased: no name, no address, no dependent's name, no numbers; the terms stay as amounts.
    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: created.employeeId });
    expect(detail).toMatchObject({ displayName: HR_ERASED_NAME, address: null, identityNumber: null, accountNumber: null, birthDate: null, taxCode: null, insuranceNumber: null, erased: true });
    expect(detail.dependents.map((d) => d.displayName)).toEqual([HR_ERASED_NAME]);
    expect(detail.employments).toHaveLength(1);
    expect(detail.employments[0]?.baseWage).toBe('15000000.00');
    // The sealed text is byte for byte as it was; the key that opens it is gone.
    const after = await withAdmin(async (c) => (await c.query<{ national_id_sealed: string; bank_account_sealed: string }>('SELECT national_id_sealed, bank_account_sealed FROM crove_hr.payroll_employee WHERE id = $1', [created.employeeId])).rows[0]);
    expect(after).toEqual(before);
    expect(await withAdmin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.subject_key WHERE org_id = $1 AND ref = $2", [o.orgId, `employee:${created.employeeId}`])).rowCount)).toBe(0);
    // Nothing about the person is found anywhere, and the record cannot be changed again.
    expect(await hits()).toEqual([]);
    // The name, the address and the dependent's name are in no column of any crove table (the audit rows hold markers, the rows hold the placeholder).
    expect(await hits([name, address, child, '5927301846', '618034297561'])).toEqual([]);
    await expect(o.exec(o.owner, 'hr.payroll.employee.edit', { employeeId: created.employeeId, displayName: 'Again' })).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED' });
    await expect(erase()).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED' });
  });
});
