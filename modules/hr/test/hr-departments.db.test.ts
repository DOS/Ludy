// SPDX-License-Identifier: AGPL-3.0-only
// HR departments and employee department/job-title assignment (issue #3412, Part of #3403 Stage 3 Slice 3a) on PostgreSQL 17:
// - CRUD (add/edit/archive/list) with unique name per legal entity, archived edit rejection, and idempotent archive;
// - owner/admin-only commands & queries, plus direct database RLS enforcement for owner_admin and le_scope;
// - zero-setup SME default (employees without department or job title), payFunction default inheritance and override;
// - archive preserves existing employees while blocking new assignment to archived departments;
// - active headcount and exact Decimal baseWageTotal rollup as of today (excluding ended employees and future terms);
// - employee list filtering, edit clearing (null), ended-employee refusal, erasure clearing, offboarding export, and org_purge order.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrDepartmentView, HrEmployee, HrEmployeeSummary, HrWritten } from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { hrCommands, hrManifest, hrQueries } from '../src/index.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type PoolHandle = ReturnType<typeof createPool>;

suite('HR departments & employee assignment (#3412)', () => {
  const dbName = `crove_test_hr_dept_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: PoolHandle;
  let appPool: PoolHandle;
  let workerPool: PoolHandle;
  let rt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function org(namePrefix = 'Phòng ban') {
    const tag = randomUUID().slice(0, 8);
    const person = (role: string) =>
      upsertIdentity(createDb(appPool), {
        issuer: 'hr',
        subject: `${role}-${tag}`,
        email: `${role}-${tag}@hr.test`,
        name: null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const created = await createOrg(rt, asUser(owner), `${namePrefix} ${tag}`);
    const orgId = created.orgId;
    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgId, admin, member, viewer],
    );
    const defaultEntityRow = await adminPool.query<{ id: string }>(
      `SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 ORDER BY created_at, id LIMIT 1`,
      [orgId],
    );
    const defaultEntityId = defaultEntityRow.rows[0]?.id as string;

    const exec = <O>(userId: string, name: string, input: unknown, actor: Parameters<Runtime['execute']>[2]['actor'] = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}, actor: Parameters<Runtime['query']>[2]['actor'] = asUser(userId)) =>
      rt.query<O>(name, input, { actor, orgId });
    const branch = async (name = 'Chi nhánh HN') => {
      const res = await adminPool.query<{ id: string }>(
        `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`,
        [orgId, name, owner],
      );
      return res.rows[0]?.id as string;
    };
    const addDept = (userId: string, input: Record<string, unknown>) =>
      exec<{ departmentId: string }>(userId, 'hr.department.add', input);
    const editDept = (userId: string, input: Record<string, unknown>) =>
      exec<{ departmentId: string }>(userId, 'hr.department.edit', input);
    const archiveDept = (userId: string, departmentId: string) =>
      exec<{ departmentId: string }>(userId, 'hr.department.archive', { departmentId });
    const listDepts = (userId: string, input: Record<string, unknown> = {}) =>
      query<HrDepartmentView[]>(userId, 'hr.department.list', input);
    const addEmp = (userId: string, input: Record<string, unknown>) =>
      exec<HrWritten>(userId, 'hr.payroll.employee.add', input);
    const editEmp = (userId: string, input: Record<string, unknown>) =>
      exec<HrWritten>(userId, 'hr.payroll.employee.edit', input);
    const listEmps = (userId: string, input: Record<string, unknown> = {}) =>
      query<HrEmployeeSummary[]>(userId, 'hr.payroll.employee.list', input);
    const getEmp = (userId: string, employeeId: string) =>
      query<HrEmployee>(userId, 'hr.payroll.employee.get', { employeeId });

    return {
      orgId,
      slug: created.slug,
      defaultEntityId,
      owner,
      admin,
      member,
      viewer,
      exec,
      query,
      branch,
      addDept,
      editDept,
      archiveDept,
      listDepts,
      addEmp,
      editEmp,
      listEmps,
      getEmp,
    };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1, resetOnRelease: false });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });

    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    rt = new Runtime(createDb(appPool), {
      manifests: [kernelManifest.tables, hrManifest.tables],
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1, resetOnRelease: false });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('supports CRUD, entity name uniqueness, archive rules, and zero-setup employees', async () => {
    const o = await org('Cty A');
    // SME zero-setup: no departments created, adding an employee without department or job title works seamlessly.
    expect(await o.listDepts(o.owner)).toEqual([]);
    const bare = await o.addEmp(o.owner, {
      displayName: 'Nguyễn Văn Không',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
    });
    const bareId = bare.employeeId as string;
    const bareDetail = await o.getEmp(o.owner, bareId);
    expect(bareDetail.departmentId).toBeNull();
    expect(bareDetail.departmentName).toBeNull();
    expect(bareDetail.jobTitle).toBeNull();
    expect(bareDetail.current?.payFunction).toBe('admin');

    // Create and edit departments by owner and admin.
    const { departmentId: salesId } = await o.addDept(o.owner, { name: '  Kinh doanh  ', code: '  KD-01 ', payFunction: 'sales' });
    const { departmentId: opsId } = await o.addDept(o.admin, { name: 'Vận hành', payFunction: 'production' });
    expect(await o.listDepts(o.owner)).toEqual([
      {
        id: salesId,
        legalEntityId: o.defaultEntityId,
        name: 'Kinh doanh',
        code: 'KD-01',
        payFunction: 'sales',
        archivedAt: null,
        activeEmployees: 0,
        activeBaseWageTotal: '0',
      },
      {
        id: opsId,
        legalEntityId: o.defaultEntityId,
        name: 'Vận hành',
        code: null,
        payFunction: 'production',
        archivedAt: null,
        activeEmployees: 0,
        activeBaseWageTotal: '0',
      },
    ]);

    // Duplicate name in the same entity rejected; same name in a branch entity allowed.
    await expect(o.addDept(o.owner, { name: 'Kinh doanh', payFunction: 'sales' })).rejects.toMatchObject({
      code: 'HR_DEPARTMENT_NAME_TAKEN',
      status: 409,
    });
    const branchId = await o.branch('Chi nhánh Đà Nẵng');
    const { departmentId: branchSalesId } = await o.addDept(o.owner, {
      legalEntityId: branchId,
      name: 'Kinh doanh',
      payFunction: 'sales',
    });
    expect(branchSalesId).not.toBe(salesId);

    // Edit department details and prevent duplicate name on edit.
    await expect(o.editDept(o.owner, { departmentId: opsId, name: 'Kinh doanh' })).rejects.toMatchObject({
      code: 'HR_DEPARTMENT_NAME_TAKEN',
      status: 409,
    });
    // Direct in-process calls with explicit undefined optional keys must only log the fields that were actually provided (#3433).
    await o.editDept(o.admin, {
      departmentId: opsId,
      name: 'Xưởng sản xuất tạm',
      code: undefined,
      payFunction: undefined,
    });
    const partialAudit = await adminPool.query<{ detail: { departmentId: string; changed: string[] } }>(
      `SELECT detail FROM crove_kernel.audit_event
       WHERE org_id = $1 AND command = 'hr.department.edit' AND outcome = 'ok'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [o.orgId],
    );
    expect(partialAudit.rows[0]?.detail).toEqual({
      departmentId: opsId,
      changed: ['name'],
    });

    await o.editDept(o.admin, { departmentId: opsId, name: 'Xưởng sản xuất', code: 'SX', payFunction: 'overhead' });
    const fullAudit = await adminPool.query<{ detail: { departmentId: string; changed: string[] } }>(
      `SELECT detail FROM crove_kernel.audit_event
       WHERE org_id = $1 AND command = 'hr.department.edit' AND outcome = 'ok'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [o.orgId],
    );
    expect(fullAudit.rows[0]?.detail).toEqual({
      departmentId: opsId,
      changed: ['name', 'code', 'payFunction'],
    });

    // Archive is idempotent; editing an archived department is refused; includeArchived surfaces it after active ones.
    await o.archiveDept(o.owner, opsId);
    await o.archiveDept(o.owner, opsId);
    await expect(o.editDept(o.owner, { departmentId: opsId, name: 'Không được' })).rejects.toMatchObject({
      code: 'HR_DEPARTMENT_ARCHIVED',
      status: 409,
    });
    const activeOnly = await o.listDepts(o.owner);
    expect(activeOnly.map((d) => d.id)).not.toContain(opsId);
    const withArchived = await o.listDepts(o.owner, { includeArchived: true });
    const archivedRow = withArchived.find((d) => d.id === opsId);
    expect(archivedRow).toMatchObject({
      name: 'Xưởng sản xuất',
      code: 'SX',
      payFunction: 'overhead',
    });
    expect(archivedRow?.archivedAt).toEqual(expect.any(String));
    // Active rows come before archived rows in list output.
    expect(withArchived[withArchived.length - 1]?.id).toBe(opsId);

    // Cross-org isolation returns 404.
    const other = await org('Cty B');
    await expect(other.editDept(other.owner, { departmentId: salesId, name: 'Hack' })).rejects.toMatchObject({
      code: 'HR_DEPARTMENT_NOT_FOUND',
      status: 404,
    });
  });

  it('enforces owner_admin, le_scope RLS, and entity assignment boundaries', async () => {
    const o = await org('Cty RLS');
    const branchId = await o.branch('Chi nhánh HCM');
    const { departmentId: hqDept } = await o.addDept(o.owner, { name: 'Hành chính', payFunction: 'admin' });
    const { departmentId: branchDept } = await o.addDept(o.owner, {
      legalEntityId: branchId,
      name: 'Kho HCM',
      payFunction: 'production',
    });

    // Member and viewer are blocked from all department commands & queries.
    for (const actorId of [o.member, o.viewer]) {
      await expect(o.listDepts(actorId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(o.addDept(actorId, { name: 'Tự tạo' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(o.editDept(actorId, { departmentId: hqDept, name: 'Sửa' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(o.archiveDept(actorId, hqDept)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }

    // Wrong legal entity assignment via employee.add / employee.edit is rejected with 422 HR_DEPARTMENT_WRONG_ENTITY.
    await expect(
      o.addEmp(o.owner, {
        displayName: 'Sai pháp nhân',
        legalEntityId: o.defaultEntityId,
        departmentId: branchDept,
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
      }),
    ).rejects.toMatchObject({ code: 'HR_DEPARTMENT_WRONG_ENTITY', status: 422 });

    const { employeeId: hqEmpId } = await o.addEmp(o.owner, {
      displayName: 'Đúng pháp nhân',
      legalEntityId: o.defaultEntityId,
      departmentId: hqDept,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    await expect(
      o.editEmp(o.owner, { employeeId: hqEmpId as string, departmentId: branchDept }),
    ).rejects.toMatchObject({ code: 'HR_DEPARTMENT_WRONG_ENTITY', status: 422 });

    // Direct SQL RLS verification as crove_tenant: member sees nothing and cannot insert;
    // org admin sees only its own org's departments (cross-tenant isolated) and legalEntityId filter scopes results.
    const other = await org('Cty Khác RLS');
    await other.addDept(other.owner, { name: 'Khác', payFunction: 'admin' });
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT crove_kernel.enter_context($1::uuid, $2::uuid)`, [o.member, o.orgId]);
      await client.query('SET LOCAL ROLE crove_tenant');
      const memberRows = await client.query(`SELECT id FROM crove_hr.department`);
      expect(memberRows.rowCount).toBe(0);
      await expect(
        client.query(`INSERT INTO crove_hr.department (org_id, legal_entity_id, name, pay_function) VALUES ($1, $2, 'Bypass', 'admin')`, [o.orgId, o.defaultEntityId]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT crove_kernel.enter_context($1::uuid, $2::uuid)`, [o.admin, o.orgId]);
      await client.query('SET LOCAL ROLE crove_tenant');
      const adminRows = await client.query<{ id: string }>(`SELECT id FROM crove_hr.department ORDER BY id`);
      expect(adminRows.rows.map((r) => r.id).sort()).toEqual([hqDept, branchDept].sort());
      await expect(
        client.query(`UPDATE crove_hr.department SET name = 'CrossOrg' WHERE org_id = $1`, [other.orgId]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Legal-entity filter on listDepts returns only the requested entity's departments.
    expect((await o.listDepts(o.admin, { legalEntityId: branchId })).map((d) => d.id)).toEqual([branchDept]);
  });

  it('inherits department payFunction, rolls up headcount & Decimal wages, handles archive/edit/erase', async () => {
    const o = await org('Cty Lương');
    const { departmentId: salesDept } = await o.addDept(o.owner, { name: 'Kinh doanh', code: 'KD', payFunction: 'sales' });
    const { departmentId: devDept } = await o.addDept(o.owner, { name: 'Kỹ thuật', code: 'KT', payFunction: 'production' });

    // Employee 1: payFunction omitted -> inherits 'sales' from salesDept.
    const { employeeId: e1 } = await o.addEmp(o.owner, {
      displayName: 'Trần Thị Bán Hàng',
      departmentId: salesDept,
      jobTitle: '  Trưởng nhóm KD ',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000.50' },
    });
    const d1 = await o.getEmp(o.owner, e1 as string);
    expect(d1.departmentId).toBe(salesDept);
    expect(d1.departmentName).toBe('Kinh doanh');
    expect(d1.jobTitle).toBe('Trưởng nhóm KD');
    expect(d1.current?.payFunction).toBe('sales');

    // Add a newer effective term already active AND a future-dated term -> rollup must pick latest effective <= today, not the future one.
    await o.exec(o.owner, 'hr.payroll.employment.add', {
      employeeId: e1,
      effectiveFrom: '2026-06-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '18500000.25',
      payFunction: 'sales',
    });
    await o.exec(o.owner, 'hr.payroll.employment.add', {
      employeeId: e1,
      effectiveFrom: '2099-01-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '99000000.00',
      payFunction: 'sales',
    });

    // Employee 2: assigned to salesDept, explicit payFunction override ('overhead').
    const { employeeId: e2 } = await o.addEmp(o.owner, {
      displayName: 'Lê Văn Điều Phối',
      departmentId: salesDept,
      jobTitle: 'Điều phối',
      employment: { effectiveFrom: '2026-02-01', contractType: 'fixed_term', region: 'I', baseWage: '19000000.25', payFunction: 'overhead' },
    });
    expect((await o.getEmp(o.owner, e2 as string)).current?.payFunction).toBe('overhead');

    // Employee 3: added to devDept, then ended -> must NOT count toward devDept headcount or activeBaseWageTotal.
    const { employeeId: e3 } = await o.addEmp(o.owner, {
      displayName: 'Phạm Văn Đã Nghỉ',
      departmentId: devDept,
      jobTitle: 'Kỹ sư',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '22000000.00' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: e3, endedOn: '2026-08-31' });

    // Refusing edits on ended employee for department/jobTitle change.
    await expect(o.editEmp(o.owner, { employeeId: e3 as string, jobTitle: 'Mới' })).rejects.toMatchObject({
      code: 'HR_EMPLOYEE_ENDED',
      status: 409,
    });
    await expect(o.editEmp(o.owner, { employeeId: e3 as string, departmentId: salesDept })).rejects.toMatchObject({
      code: 'HR_EMPLOYEE_ENDED',
      status: 409,
    });

    // Check headcount & Decimal sum: 18500000.25 + 19000000.25 = 37500000.5 on salesDept; 0 / 0 on devDept.
    const depts = await o.listDepts(o.owner);
    expect(depts).toEqual([
      {
        id: salesDept,
        legalEntityId: o.defaultEntityId,
        name: 'Kinh doanh',
        code: 'KD',
        payFunction: 'sales',
        archivedAt: null,
        activeEmployees: 2,
        activeBaseWageTotal: '37500000.5',
      },
      {
        id: devDept,
        legalEntityId: o.defaultEntityId,
        name: 'Kỹ thuật',
        code: 'KT',
        payFunction: 'production',
        archivedAt: null,
        activeEmployees: 0,
        activeBaseWageTotal: '0',
      },
    ]);

    // Filter employee list by departmentId & check department/jobTitle fields.
    const salesEmps = await o.listEmps(o.owner, { departmentId: salesDept });
    expect(salesEmps.map((e) => e.id).sort()).toEqual([e1 as string, e2 as string].sort());
    expect(salesEmps.find((e) => e.id === e1)).toMatchObject({
      departmentId: salesDept,
      departmentName: 'Kinh doanh',
      jobTitle: 'Trưởng nhóm KD',
    });

    // Archive salesDept: keeps e1 & e2 assigned, but blocks new assignments in employee.add and employee.edit.
    await o.archiveDept(o.owner, salesDept);
    expect(await o.getEmp(o.owner, e1 as string)).toMatchObject({
      departmentId: salesDept,
      departmentName: 'Kinh doanh',
    });
    await expect(
      o.addEmp(o.owner, {
        displayName: 'Người mới bị chặn',
        departmentId: salesDept,
        employment: { effectiveFrom: '2026-09-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
      }),
    ).rejects.toMatchObject({ code: 'HR_DEPARTMENT_ARCHIVED', status: 409 });

    // Moving e2 to devDept works, while moving e2 from devDept back to archived salesDept is blocked;
    // editing e1's jobTitle while e1 stays in already-archived salesDept still works.
    await o.editEmp(o.owner, { employeeId: e1 as string, jobTitle: 'Trưởng phòng KD' });
    await o.editEmp(o.owner, { employeeId: e2 as string, departmentId: devDept, jobTitle: null });
    expect(await o.getEmp(o.owner, e2 as string)).toMatchObject({
      departmentId: devDept,
      departmentName: 'Kỹ thuật',
      jobTitle: null,
    });
    await expect(o.editEmp(o.owner, { employeeId: e2 as string, departmentId: salesDept })).rejects.toMatchObject({
      code: 'HR_DEPARTMENT_ARCHIVED',
      status: 409,
    });
    // Clearing departmentId to null works cleanly.
    await o.editEmp(o.owner, { employeeId: e2 as string, departmentId: null });
    expect(await o.getEmp(o.owner, e2 as string)).toMatchObject({
      departmentId: null,
      departmentName: null,
      jobTitle: null,
    });

    // Erasure after retention clears department_id and job_title in DB and read models.
    await adminPool.query(
      `UPDATE crove_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date WHERE id = $1`,
      [e3],
    );
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: e3 }, asMfa(o.owner));
    const dbErased = await adminPool.query<{ department_id: string | null; job_title: string | null }>(
      `SELECT department_id, job_title FROM crove_hr.payroll_employee WHERE id = $1`,
      [e3],
    );
    expect(dbErased.rows[0]).toEqual({ department_id: null, job_title: null });
    const endedList = await o.listEmps(o.owner, { status: 'ended' });
    expect(endedList.find((e) => e.id === e3)).toMatchObject({
      departmentId: null,
      departmentName: null,
      jobTitle: null,
    });
  });

  it('exports hr.department via kernel.org.export.people and deletes employees before departments on org_purge', async () => {
    const o = await org('Cty Xuất');
    const { departmentId } = await o.addDept(o.owner, { name: 'Kế toán', code: 'KT', payFunction: 'admin' });
    await o.addEmp(o.owner, {
      displayName: 'Nguyễn Thị Xuất',
      departmentId,
      jobTitle: 'Kế toán trưởng',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '20000000' },
    });

    // Offboarding begins before kernel.org.export.people can stream hr.department.
    await rt.execute('kernel.org.offboard', { confirmSlug: o.slug }, { actor: asMfa(o.owner), orgId: o.orgId });

    const exported: Array<Record<string, unknown>> = [];
    await rt.stream('kernel.org.export.people', { table: 'hr.department' }, { actor: asMfa(o.owner), orgId: o.orgId }, async (raw) => {
      for (const line of (raw as { lines: string[] }).lines) exported.push(JSON.parse(line) as Record<string, unknown>);
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      org_id: o.orgId,
      id: departmentId,
      legal_entity_id: o.defaultEntityId,
      name: 'Kế toán',
      code: 'KT',
      pay_function: 'admin',
      archived_at: null,
    });

    // Backdate offboard timestamp and insert a 31-day-old export record, then run crove_kernel.org_purge(30) as worker role.
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query(
        `UPDATE crove_kernel.audit_event SET occurred_at = now() - interval '35 days' WHERE org_id = $1 AND command = 'kernel.org.offboard'`,
        [o.orgId],
      );
      await adminClient.query('COMMIT');
    } finally {
      adminClient.release();
    }
    await adminPool.query(
      `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, occurred_at, input_sha256, detail)
       VALUES ($1, 'system', 'kernel.org.export.record', $2, 'ok', now() - interval '31 days', repeat('0', 64), '{"format":"crove.org-export.v2"}'::jsonb)`,
      [o.orgId, randomUUID()],
    );

    const worker = await workerPool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      const purgeRes = await worker.query<{ outcome: string; counts: Record<string, Record<string, number>> }>(
        'SELECT outcome, counts FROM crove_kernel.org_purge(30)',
      );
      expect(purgeRes.rows[0]?.outcome).toBe('ok');
      await worker.query(
        `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, occurred_at, input_sha256, detail)
         VALUES ($1, 'system', 'kernel.org.purge', $2, 'ok', now(), repeat('0', 64), '{}'::jsonb)`,
        [o.orgId, randomUUID()],
      );
      await worker.query('COMMIT');
    } finally {
      worker.release();
    }

    const leftDept = await adminPool.query(`SELECT 1 FROM crove_hr.department WHERE org_id = $1`, [o.orgId]);
    const leftEmp = await adminPool.query(`SELECT 1 FROM crove_hr.payroll_employee WHERE org_id = $1`, [o.orgId]);
    expect(leftDept.rowCount).toBe(0);
    expect(leftEmp.rowCount).toBe(0);
  });
});
