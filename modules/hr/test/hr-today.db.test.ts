// SPDX-License-Identifier: AGPL-3.0-only
// HR Home Today feed integration tests (#4444, Stage 5A) on PostgreSQL 17:
// - owner/admin deterministic lifecycle & compliance alerts: probation <= 7d, fixed-term contracts <= 30d & expired,
//   foreign work permits <= 60d & expired, semi-annual 01/PLI filing windows, and pending leave approvals;
// - active L1 department manager (member, linked or unlinked) scoped strictly to managed active department(s) pending_l1
//   excluding own self-requests, archived departments, pending_final, and erased employees, linking to /hr/my;
// - non-manager member & viewer receive [], erased/ended exclusions, cross-org & le_scope isolation, MODULE_OFF gating;
// - zero PII in params/payload, zero DB/audit writes, and end-to-end kernel.today integration (Ly).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  todayCoworkerKey,
  zTodayItems,
  type HrLeaveRequestActionResult,
  type HrSelfLeaveSubmitResult,
  type HrWritten,
  type TodayItem,
  type TodayList,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { hrCommands, hrManifest, hrQueries, hrToday, labor01PliWindowFor } from '../src/index.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type PoolHandle = ReturnType<typeof createPool>;

suite('HR Home Today alerts (#4444)', () => {
  const dbName = `ludy_test_hr_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: PoolHandle;
  let appPool: PoolHandle;
  let rt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function setupOrg(namePrefix = 'Cty HR Today') {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const person = (role: string) =>
      upsertIdentity(db, {
        issuer: 'hr-today',
        subject: `${role}-${tag}`,
        email: `${role}-${tag}@hr-today.test`,
        name: null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const mgrLinked = await person('mgr-linked');
    const mgrUnlinked = await person('mgr-unlinked');
    const mgrOther = await person('mgr-other');
    const staffEng1 = await person('staff-eng1');
    const staffEng2 = await person('staff-eng2');
    const staffSales = await person('staff-sales');
    const staffOther = await person('staff-other');
    const nonMgrUnlinked = await person('nonmgr-unlinked');
    const viewer = await person('viewer');

    const created = await createOrg(rt, asUser(owner), `${namePrefix} ${tag}`);
    const orgId = created.orgId;
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'),
              ($1, $3, 'member'),
              ($1, $4, 'member'),
              ($1, $5, 'member'),
              ($1, $6, 'member'),
              ($1, $7, 'member'),
              ($1, $8, 'member'),
              ($1, $9, 'member'),
              ($1, $10, 'member'),
              ($1, $11, 'viewer')`,
      [orgId, admin, mgrLinked, mgrUnlinked, mgrOther, staffEng1, staffEng2, staffSales, staffOther, nonMgrUnlinked, viewer],
    );

    const defaultEntityRow = await adminPool.query<{ id: string }>(
      `SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 ORDER BY created_at, id LIMIT 1`,
      [orgId],
    );
    const defaultEntityId = defaultEntityRow.rows[0]?.id as string;

    const branch = async (name = 'Chi nhánh HN') => {
      const res = await adminPool.query<{ id: string }>(
        `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`,
        [orgId, name, owner],
      );
      return res.rows[0]?.id as string;
    };

    const exec = <O>(userId: string, name: string, input: unknown, actor: Parameters<Runtime['execute']>[2]['actor'] = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}, actor: Parameters<Runtime['query']>[2]['actor'] = asUser(userId)) =>
      rt.query<O>(name, input, { actor, orgId });

    return {
      orgId,
      defaultEntityId,
      owner,
      admin,
      mgrLinked,
      mgrUnlinked,
      mgrOther,
      staffEng1,
      staffEng2,
      staffSales,
      staffOther,
      nonMgrUnlinked,
      viewer,
      branch,
      exec,
      query,
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });

    const shipped = ['kernel', 'hr'] as const;
    rt = new Runtime(createDb(appPool), {
      manifests: [kernelManifest.tables, hrManifest.tables],
      subjectVault: new SubjectVault(
        new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO),
      ),
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...buildKernelCommands({ shippedModules: shipped }), ...hrCommands],
      queries: [
        ...kernelQueries({
          inboundDomain: null,
          apps: { shipped, deployment: shipped, entitlements: async () => ['full'] },
        }),
        ...hrQueries,
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1, resetOnRelease: false });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('computes 01/PLI filing windows purely and suppresses 01/PLI when no labor exists in period', async () => {
    expect(labor01PliWindowFor('2026-05-06')).toEqual({
      period: '2026-H1',
      dueDate: '2026-06-05',
      windowStart: '2026-01-01',
      daysRemaining: 30,
    });
    expect(labor01PliWindowFor('2026-05-05')).toBeNull();
    expect(labor01PliWindowFor('2026-06-06')).toBeNull();
    expect(labor01PliWindowFor('2026-11-05')).toEqual({
      period: '2026',
      dueDate: '2026-12-05',
      windowStart: '2026-01-01',
      daysRemaining: 30,
    });
    expect(labor01PliWindowFor('2026-11-22')).toEqual({
      period: '2026',
      dueDate: '2026-12-05',
      windowStart: '2026-01-01',
      daysRemaining: 13,
    });
    expect(labor01PliWindowFor('2026-12-06')).toBeNull();

    const o = await setupOrg('Cty Không Nhân Sự');
    // Zero employees on 2026-11-22 (inside annual 01/PLI window): must return [].
    expect(await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-11-22T09:00:00+07:00' })).toEqual([]);

    // Ended employee in 2025: still outside 2026 labor window -> [].
    const oldEnded = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân sự đã nghỉ 2025',
      employment: { effectiveFrom: '2025-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: oldEnded.employeeId, endedOn: '2025-12-15' });
    expect(await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-11-22T09:00:00+07:00' })).toEqual([]);

    // Ended employee in 2026: counted for 2026 annual 01/PLI report window.
    const ended2026 = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân sự nghỉ giữa 2026',
      employment: { effectiveFrom: '2026-01-10', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: ended2026.employeeId, endedOn: '2026-03-01' });

    const annualInfo = await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-11-22T09:00:00+07:00' });
    expect(annualInfo).toEqual([
      {
        app: 'hr',
        kind: 'deadline',
        id: 'pli-01:2026',
        title: { key: 'hr.laborReport01Pli', params: { period: '2026', date: '2026-12-05' } },
        dueAt: '2026-12-05T23:59:59+07:00',
        severity: 'info',
        href: '/hr/declarations',
      },
    ]);

    // Within 7 days of 2026-12-05 -> severity escalates to warn.
    const annualWarn = await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-11-28T09:00:00+07:00' });
    expect(annualWarn[0]).toMatchObject({ id: 'pli-01:2026', severity: 'warn' });

    // H1 window in May.
    const h1 = await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-05-20T09:00:00+07:00' });
    expect(h1).toEqual([
      {
        app: 'hr',
        kind: 'deadline',
        id: 'pli-01:2026-H1',
        title: { key: 'hr.laborReport01Pli', params: { period: '2026-H1', date: '2026-06-05' } },
        dueAt: '2026-06-05T23:59:59+07:00',
        severity: 'info',
        href: '/hr/declarations',
      },
    ]);

    // Outside windows in July -> no 01/PLI alert.
    expect(await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-07-10T09:00:00+07:00' })).toEqual([]);
  });

  it('surfaces manager lifecycle alerts with exact notice boundaries and excludes ended and erased staff', async () => {
    const o = await setupOrg('Cty Chu Kỳ');
    const asOf = '2026-11-22T10:00:00+07:00'; // 2026-11-22 in Asia/Ho_Chi_Minh

    // Probation boundaries: <= 7d (2026-11-29 INCLUDED) vs 8d (2026-11-30 EXCLUDED).
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Thử việc 7 ngày Canary Name',
      employment: {
        effectiveFrom: '2026-10-15',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '15000000',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-11-29',
        probationWage: '13000000',
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Thử việc 8 ngày',
      employment: {
        effectiveFrom: '2026-10-15',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '15000000',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-11-30',
        probationWage: '13000000',
      },
    });

    // Fixed-term contracts: 18d (2026-12-10 INCLUDED), 30d (2026-12-22 INCLUDED), 31d (2026-12-23 EXCLUDED), expired (2026-10-01 INCLUDED).
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'HĐLĐ 18 ngày',
      employment: {
        effectiveFrom: '2025-12-11',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        contractEndOn: '2026-12-10',
        fixedTermSequence: 1,
        region: 'I',
        baseWage: '18000000',
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'HĐLĐ 30 ngày',
      employment: {
        effectiveFrom: '2025-12-23',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        contractEndOn: '2026-12-22',
        fixedTermSequence: 1,
        region: 'I',
        baseWage: '18000000',
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'HĐLĐ 31 ngày',
      employment: {
        effectiveFrom: '2025-12-24',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        contractEndOn: '2026-12-23',
        fixedTermSequence: 1,
        region: 'I',
        baseWage: '18000000',
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'HĐLĐ quá hạn đang làm',
      employment: {
        effectiveFrom: '2025-10-02',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        contractEndOn: '2026-10-01',
        fixedTermSequence: 1,
        region: 'I',
        baseWage: '22000000',
      },
    });

    // Foreign work permits: 60d (2027-01-21 INCLUDED), 61d (2027-01-22 EXCLUDED), expired (2026-11-10 INCLUDED), exempt (EXCLUDED).
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Chuyên gia GPLĐ 60 ngày',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'WP-001',
      workPermitExpiresOn: '2027-01-21',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '45000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Chuyên gia GPLĐ 61 ngày',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'WP-002',
      workPermitExpiresOn: '2027-01-22',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '45000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Chuyên gia GPLĐ quá hạn',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'WP-003',
      workPermitExpiresOn: '2026-11-10',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '45000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Chuyên gia miễn GPLĐ',
      isForeign: true,
      workPermitExempt: true,
      workPermitExpiresOn: '2026-11-25',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '45000000' },
    });

    // Ended foreign worker with expired fixed-term contract + probation ending tomorrow -> must be excluded.
    const endedEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Đã nghỉ việc',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'WP-END',
      workPermitExpiresOn: '2026-11-25',
      employment: {
        effectiveFrom: '2025-11-01',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        contractEndOn: '2026-10-31',
        fixedTermSequence: 1,
        region: 'I',
        baseWage: '15000000',
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: endedEmp.employeeId, endedOn: '2026-11-01' });

    // Erased employee who had an expiring work permit -> must be excluded.
    const toErase = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân sự đã xóa PDPL',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'WP-ERASE',
      workPermitExpiresOn: '2026-11-26',
      employment: { effectiveFrom: '2015-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: toErase.employeeId, endedOn: '2015-12-31' });
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: toErase.employeeId }, asMfa(o.owner));

    // Malformed legacy employment bounds (end date before effective date) must be skipped safely without failing the feed.
    const malformed = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Hồ sơ cũ ngày lệch',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    await adminPool.query(
      `INSERT INTO ludy_hr.payroll_employment (
         org_id, legal_entity_id, employee_id, effective_from, contract_type,
         region, base_wage, pay_function, term_months, contract_end_on
       )
       SELECT org_id, legal_entity_id, employee_id, '2026-02-01'::date, 'fixed_term',
              region, base_wage, pay_function, 12, '2026-06-30'::date
         FROM ludy_hr.payroll_employment
        WHERE org_id = $1 AND employee_id = $2
        LIMIT 1`,
      [o.orgId, malformed.employeeId],
    );

    const ownerItems = await o.query<TodayItem[]>(o.owner, 'hr.today', { now: asOf });
    const adminItems = await o.query<TodayItem[]>(o.admin, 'hr.today', { now: asOf });
    expect(ownerItems).toEqual(adminItems);
    expect(zTodayItems.parse(ownerItems)).toEqual(ownerItems);

    expect(ownerItems).toEqual([
      {
        app: 'hr',
        kind: 'flag',
        id: 'contracts-expired',
        title: { key: 'hr.contractsExpired', params: { count: 1 } },
        count: 1,
        severity: 'block',
        href: '/hr/employees',
      },
      {
        app: 'hr',
        kind: 'flag',
        id: 'work-permits-expired',
        title: { key: 'hr.workPermitsExpired', params: { count: 1 } },
        count: 1,
        severity: 'block',
        href: '/hr/employees',
      },
      {
        app: 'hr',
        kind: 'deadline',
        id: 'probation-ending',
        title: { key: 'hr.probationEnding', params: { count: 1 } },
        count: 1,
        dueAt: '2026-11-29T23:59:59+07:00',
        severity: 'warn',
        href: '/hr/employees',
      },
      {
        app: 'hr',
        kind: 'deadline',
        id: 'contracts-expiring',
        title: { key: 'hr.contractsExpiring', params: { count: 2 } },
        count: 2,
        dueAt: '2026-12-10T23:59:59+07:00',
        severity: 'warn',
        href: '/hr/employees',
      },
      {
        app: 'hr',
        kind: 'deadline',
        id: 'work-permits-expiring',
        title: { key: 'hr.workPermitsExpiring', params: { count: 1 } },
        count: 1,
        dueAt: '2027-01-21T23:59:59+07:00',
        severity: 'warn',
        href: '/hr/employees',
      },
      {
        app: 'hr',
        kind: 'deadline',
        id: 'pli-01:2026',
        title: { key: 'hr.laborReport01Pli', params: { period: '2026', date: '2026-12-05' } },
        dueAt: '2026-12-05T23:59:59+07:00',
        severity: 'info',
        href: '/hr/declarations',
      },
    ]);

    // Zero PII in params or serialized output.
    const serialized = JSON.stringify(ownerItems);
    expect(serialized).not.toContain('Canary Name');
    expect(serialized).not.toContain('WP-');
    expect(serialized).not.toContain('45000000');
  });

  it('scopes member alerts strictly to active L1 managed departments and enforces RBAC, MODULE_OFF, le_scope, and zero writes', async () => {
    const o = await setupOrg('Cty Nghỉ Phép');
    const otherOrg = await setupOrg('Cty Khác');
    const branchId = await o.branch('Chi nhánh Miền Bắc');

    // Departments: Eng (managed by linked mgrLinked), Sales (managed by unlinked mgrUnlinked), Other (managed by mgrOther),
    // Archived (archived while manager = mgrLinked), BranchDept (in branchId, manager = mgrLinked).
    const { departmentId: deptEng } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật',
      payFunction: 'production',
    });
    const { departmentId: deptSales } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh',
      payFunction: 'sales',
    });
    const { departmentId: deptOther } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Vận hành',
      payFunction: 'admin',
    });
    const { departmentId: deptArchived } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Phòng Cũ',
      payFunction: 'admin',
    });
    const { departmentId: deptBranch } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      legalEntityId: branchId,
      name: 'Kỹ thuật Chi nhánh',
      payFunction: 'production',
    });

    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptEng, managerUserId: o.mgrLinked });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptSales, managerUserId: o.mgrUnlinked });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptOther, managerUserId: o.mgrOther });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptArchived, managerUserId: o.mgrLinked });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptBranch, managerUserId: o.mgrLinked });

    // Create & link employees. Note mgrUnlinked deliberately has NO payroll_employee row.
    const addLinked = async (userId: string | null, displayName: string, departmentId: string, legalEntityId?: string) => {
      const emp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
        displayName,
        ...(legalEntityId ? { legalEntityId } : {}),
        departmentId,
        employment: {
          effectiveFrom: '2025-12-11',
          contractType: 'fixed_term',
          contractForm: 'written',
          termMonths: 12,
          contractEndOn: '2026-12-10',
          fixedTermSequence: 1,
          region: 'I',
          baseWage: '33000000',
        },
      });
      if (userId !== null) {
        await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: emp.employeeId, userId });
      }
      return emp.employeeId as string;
    };

    const mgrEmpId = await addLinked(o.mgrLinked, 'Trưởng phòng Kỹ thuật Canary', deptEng);
    await addLinked(o.staffEng1, 'Nhân viên Eng 1 Canary', deptEng);
    await addLinked(o.staffEng2, 'Nhân viên Eng 2 Canary', deptEng);
    await addLinked(o.staffSales, 'Nhân viên Sales Canary', deptSales);
    await addLinked(o.staffOther, 'Nhân viên Other Canary', deptOther);
    const erasedSub = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân viên Đã Xóa Canary',
      departmentId: deptEng,
      employment: { effectiveFrom: '2015-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
    });
    const erasedSubId = erasedSub.employeeId as string;
    const archivedDeptEmpId = await addLinked(null, 'Nhân viên Phòng Cũ', deptArchived);
    const branchEmpId = await addLinked(null, 'Nhân viên Chi nhánh', deptBranch, branchId);

    // Archive deptArchived after assigning its employee.
    await o.exec(o.owner, 'hr.department.archive', { departmentId: deptArchived });

    // Restrict mgrLinked's legal-entity scope to defaultEntityId only (so deptBranch in branchId is out of scope).
    await o.exec(o.owner, 'kernel.member.role.assign', {
      userId: o.mgrLinked,
      roleKey: 'external_accountant',
      legalEntityId: o.defaultEntityId,
    }, asMfa(o.owner));

    // Submit leave requests in deptEng:
    // 1) staffEng1: two pending_l1 requests (one stays pending_l1, second approved -> approved)
    const engReqPendingL1 = await o.exec<HrSelfLeaveSubmitResult>(o.staffEng1, 'hr.self.leave.request_submit', {
      startOn: '2026-12-01',
      endOn: '2026-12-01',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Lý do bí mật Eng1',
    });
    const engReqApproved = await o.exec<HrSelfLeaveSubmitResult>(o.staffEng1, 'hr.self.leave.request_submit', {
      startOn: '2026-12-03',
      endOn: '2026-12-03',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Nghỉ đã duyệt',
    });
    await o.exec<HrLeaveRequestActionResult>(o.mgrLinked, 'hr.leave_request.approve_l1', { requestId: engReqApproved.requestId });
    await o.exec<HrLeaveRequestActionResult>(o.owner, 'hr.leave_request.approve_final', { requestId: engReqApproved.requestId });

    // 2) staffEng2: two pending_l1 requests -> one stays pending_l1, one L1-approved -> pending_final
    const eng2ReqPendingL1 = await o.exec<HrSelfLeaveSubmitResult>(o.staffEng2, 'hr.self.leave.request_submit', {
      startOn: '2026-12-04',
      endOn: '2026-12-04',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Lý do bí mật Eng2',
    });
    const eng2ReqPendingFinal = await o.exec<HrSelfLeaveSubmitResult>(o.staffEng2, 'hr.self.leave.request_submit', {
      startOn: '2026-12-05',
      endOn: '2026-12-05',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Chờ duyệt cuối',
    });
    await o.exec<HrLeaveRequestActionResult>(o.mgrLinked, 'hr.leave_request.approve_l1', { requestId: eng2ReqPendingFinal.requestId });
    expect(engReqPendingL1.status).toBe('pending_l1');
    expect(eng2ReqPendingL1.status).toBe('pending_l1');

    // 3) mgrLinked own self-request (submitted -> pending_final) plus an explicit pending_l1 row for mgrLinked's own employee_id
    await o.exec<HrSelfLeaveSubmitResult>(o.mgrLinked, 'hr.self.leave.request_submit', {
      startOn: '2026-12-08',
      endOn: '2026-12-08',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Đơn tự nghỉ của trưởng phòng',
    });
    await adminPool.query(
      `INSERT INTO ludy_hr.leave_request (org_id, legal_entity_id, employee_id, department_id, month, start_on, end_on, kind, days, status, reason, created_by)
       VALUES ($1, $2, $3, $4, '2026-12', '2026-12-09', '2026-12-09', 'unpaid_leave', 1, 'pending_l1', 'Self pending_l1 edge', $5)`,
      [o.orgId, o.defaultEntityId, mgrEmpId, deptEng, o.mgrLinked],
    );

    // 4) deptSales (managed by unlinked mgrUnlinked): 1 pending_l1
    await o.exec<HrSelfLeaveSubmitResult>(o.staffSales, 'hr.self.leave.request_submit', {
      startOn: '2026-12-10',
      endOn: '2026-12-10',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Đơn Sales',
    });

    // 5) deptOther (managed by mgrOther): 1 pending_l1
    await o.exec<HrSelfLeaveSubmitResult>(o.staffOther, 'hr.self.leave.request_submit', {
      startOn: '2026-12-11',
      endOn: '2026-12-11',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Đơn Other',
    });

    // 6) deptArchived pending_l1 + deptBranch pending_l1 (out of le_scope for mgrLinked) + erased employee pending_l1
    await adminPool.query(
      `INSERT INTO ludy_hr.leave_request (org_id, legal_entity_id, employee_id, department_id, month, start_on, end_on, kind, days, status, reason)
       VALUES ($1, $2, $3, $4, '2026-12', '2026-12-12', '2026-12-12', 'unpaid_leave', 1, 'pending_l1', 'Archived dept request'),
              ($1, $5, $6, $7, '2026-12', '2026-12-13', '2026-12-13', 'unpaid_leave', 1, 'pending_l1', 'Branch dept request'),
              ($1, $2, $8, $9, '2026-12', '2026-12-14', '2026-12-14', 'unpaid_leave', 1, 'pending_l1', 'Erased employee request')`,
      [o.orgId, o.defaultEntityId, archivedDeptEmpId, deptArchived, branchId, branchEmpId, deptBranch, erasedSubId, deptEng],
    );
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: erasedSubId, endedOn: '2015-12-31' });
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: erasedSubId }, asMfa(o.owner));

    // Check audit_event & DB counts before read calls.
    const countState = async () => {
      const audit = await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.audit_event WHERE org_id = $1`, [o.orgId]);
      const reqs = await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_hr.leave_request WHERE org_id = $1`, [o.orgId]);
      const emps = await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_hr.payroll_employee WHERE org_id = $1`, [o.orgId]);
      return { audit: audit.rows[0]!.n, reqs: reqs.rows[0]!.n, emps: emps.rows[0]!.n };
    };
    const before = await countState();

    // Linked L1 manager (`member`): sees ONLY active in-scope deptEng non-erased subordinate pending_l1 (count = 2), link to /hr/my.
    const mgrLinkedItems = await o.query<TodayItem[]>(o.mgrLinked, 'hr.today', {});
    expect(mgrLinkedItems).toEqual([
      {
        app: 'hr',
        kind: 'proposal',
        id: 'leave-approvals-l1',
        title: { key: 'hr.deptLeave', params: { count: 2 } },
        count: 2,
        href: '/hr/my',
      },
    ]);

    // Unlinked L1 manager (`member`): sees ONLY deptSales pending_l1 (count = 1), link to /hr/my.
    const mgrUnlinkedItems = await o.query<TodayItem[]>(o.mgrUnlinked, 'hr.today', {});
    expect(mgrUnlinkedItems).toEqual([
      {
        app: 'hr',
        kind: 'proposal',
        id: 'leave-approvals-l1',
        title: { key: 'hr.deptLeave', params: { count: 1 } },
        count: 1,
        href: '/hr/my',
      },
    ]);

    // Non-manager members (linked & unlinked) and viewer receive [].
    expect(await o.query<TodayItem[]>(o.staffEng1, 'hr.today', {})).toEqual([]);
    expect(await o.query<TodayItem[]>(o.nonMgrUnlinked, 'hr.today', {})).toEqual([]);
    expect(await o.query<TodayItem[]>(o.viewer, 'hr.today', {})).toEqual([]);

    // Owner sees total waiting approvals (pending_l1 + pending_final) across non-erased employees = 9:
    // eng1 pending_l1 (1) + eng2 pending_l1 (1) + eng2 pending_final (1) + mgr pending_final (1) + mgr pending_l1 (1)
    // + sales (1) + other (1) + archived (1) + branch (1), excluding erased (1) and approved (1).
    const ownerItems = await o.query<TodayItem[]>(o.owner, 'hr.today', { now: '2026-11-22T10:00:00+07:00' });
    const leaveProposal = ownerItems.find((i) => i.id === 'leave-approvals');
    expect(leaveProposal).toEqual({
      app: 'hr',
      kind: 'proposal',
      id: 'leave-approvals',
      title: { key: 'hr.leaveApprovalsPending', params: { count: 9 } },
      count: 9,
      href: '/hr/employees',
    });

    // End-to-end kernel.today integration for owner and L1 manager.
    expect(todayCoworkerKey('hr')).toBe('finance');
    const ownerHome = await o.query<TodayList>(o.owner, 'kernel.today', {});
    expect(ownerHome.failed).toBe(0);
    expect(ownerHome.dropped).toBe(0);
    expect(ownerHome.items.filter((i) => i.app === 'hr').length).toBeGreaterThanOrEqual(2);

    const mgrHome = await o.query<TodayList>(o.mgrLinked, 'kernel.today', {});
    expect(mgrHome.failed).toBe(0);
    expect(mgrHome.items.filter((i) => i.app === 'hr')).toEqual(mgrLinkedItems);

    const viewerHome = await o.query<TodayList>(o.viewer, 'kernel.today', {});
    expect(viewerHome.failed).toBe(0);
    expect(viewerHome.items.filter((i) => i.app === 'hr')).toEqual([]);

    // Zero PII across kernel.today output.
    const serializedHome = JSON.stringify(ownerHome);
    expect(serializedHome).not.toContain('Canary');
    expect(serializedHome).not.toContain('Lý do bí mật');
    expect(serializedHome).not.toContain('33000000');

    // Cross-org isolation: otherOrg owner sees nothing from org o.
    expect(await otherOrg.query<TodayItem[]>(otherOrg.owner, 'hr.today', { now: '2026-11-22T10:00:00+07:00' })).toEqual([]);

    // Zero DB & audit writes during read queries.
    expect(await countState()).toEqual(before);

    // MODULE_OFF gating: disabling 'hr' rejects hr.today, drops hr items in kernel.today with failed=0, and direct handler returns [].
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: false });
    await expect(o.query(o.owner, 'hr.today', {})).rejects.toMatchObject({ code: 'MODULE_OFF' });
    const homeWhileOff = await o.query<TodayList>(o.owner, 'kernel.today', {});
    expect(homeWhileOff.failed).toBe(0);
    expect(homeWhileOff.items.filter((i) => i.app === 'hr')).toEqual([]);

    await createDb(appPool)
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT ludy_kernel.enter_context(${o.owner}::uuid, ${o.orgId}::uuid)`.execute(trx);
        await sql`SET LOCAL ROLE ludy_tenant`.execute(trx);
        const directResult = await hrToday.handler(
          {
            trx,
            orgId: o.orgId,
            role: 'owner',
            actor: asUser(o.owner),
            now: new Date('2026-11-22T10:00:00+07:00'),
          } as unknown as Parameters<typeof hrToday.handler>[0],
          { now: '2026-11-22T10:00:00+07:00' },
        );
        expect(directResult).toEqual([]);
      });

    // Re-enabling restores hr.today and kernel.today alerts cleanly (including direct ludy_tenant invocation).
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: true });
    expect((await o.query<TodayItem[]>(o.mgrLinked, 'hr.today', {})).length).toBe(1);
    await createDb(appPool)
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT ludy_kernel.enter_context(${o.mgrLinked}::uuid, ${o.orgId}::uuid)`.execute(trx);
        await sql`SET LOCAL ROLE ludy_tenant`.execute(trx);
        const directMember = await hrToday.handler(
          {
            trx,
            orgId: o.orgId,
            role: 'member',
            actor: asUser(o.mgrLinked),
            now: new Date('2026-11-22T10:00:00+07:00'),
          } as unknown as Parameters<typeof hrToday.handler>[0],
          {},
        );
        expect(directMember).toEqual(mgrLinkedItems);
      });
    const homeReenabled = await o.query<TodayList>(o.owner, 'kernel.today', {});
    expect(homeReenabled.failed).toBe(0);
    expect(homeReenabled.items.some((i) => i.app === 'hr')).toBe(true);
  });
});
