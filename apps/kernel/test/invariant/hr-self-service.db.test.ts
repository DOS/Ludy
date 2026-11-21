// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7, issue #4300, Stage 4A Step 0 of 2): PostgreSQL RLS and trigger isolation
// for HR employee self-service portal and multi-level leave approval.
// On a database before Stage 4A's migration (to_regclass('crove_hr.leave_request') IS NULL), each test verifies
// the pre-migration baseline without skipping (no it.skip: the invariant job fails on skipped tests). Once Stage 4A's
// schema exists (crove_hr.payroll_employee.user_id, crove_hr.department.manager_user_id, crove_hr.leave_request),
// each test pins the database-layer isolation directly as crove_app and crove_worker in sealed contexts.
// Keep this directory self-contained: import only fixtures in test/invariant/ and workspace packages under test.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TENANT_PREDICATE = '(org_id = ( SELECT crove_kernel.ctx_org_id() AS ctx_org_id))';
const LE_SCOPE_PREDICATE =
  "(('*'::text = ANY (( SELECT crove_kernel.ctx_le_scope() AS ctx_le_scope)::text[])) OR ((legal_entity_id)::text = ANY (( SELECT crove_kernel.ctx_le_scope() AS ctx_le_scope)::text[])))";

const EXISTING_HR_TABLES = [
  'crove_hr.candidate',
  'crove_hr.department',
  'crove_hr.job_opening',
  'crove_hr.payroll_bank_template',
  'crove_hr.payroll_dependent',
  'crove_hr.payroll_employee',
  'crove_hr.payroll_employment',
  'crove_hr.payroll_leave_entry',
  'crove_hr.payroll_line',
  'crove_hr.payroll_run',
] as const;

const TABLES_WITH_UPDATED_AT = new Set<string>([
  'crove_hr.candidate',
  'crove_hr.department',
  'crove_hr.job_opening',
  'crove_hr.leave_request',
  'crove_hr.payroll_bank_template',
  'crove_hr.payroll_employee',
  'crove_hr.payroll_leave_entry',
  'crove_hr.payroll_line',
  'crove_hr.payroll_run',
]);

const suite = ADMIN ? describe : describe.skip;

type QueryOutcome<T extends pg.QueryResultRow = pg.QueryResultRow> =
  | { ok: true; rows: T[]; rowCount: number }
  | { ok: false; code?: string; message: string };

interface ActorSession {
  label: string;
  login: 'app' | 'worker';
  enter: (c: pg.Client) => Promise<unknown>;
}

suite('HR employee self-service and multi-level leave approval DB invariants (#4300)', () => {
  const dbName = `crove_test_hr_self_service_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool | undefined;

  const has = {
    leaveRequest: false,
    employeeUserId: false,
    departmentManagerUserId: false,
    stage4a: false,
  };

  let org1Id = '';
  let org2Id = '';
  let branchLe1 = '';

  const users = {
    owner1: '',
    admin1: '',
    userA: '',
    userB: '',
    managerM: '',
    managerM2: '',
    unlinkedMember: '',
    viewer: '',
    scopedMember: '',
    owner2: '',
    userC: '',
  };

  const ids = {
    dept1: randomUUID(),
    dept2: randomUUID(),
    deptOrg2: randomUUID(),
    empA: randomUUID(),
    empA2InDept1: randomUUID(),
    empB: randomUUID(),
    empM: randomUUID(),
    empScoped: randomUUID(),
    empC: randomUUID(),
    draftRun1: randomUUID(),
    approvedRun1: randomUUID(),
    approvedRun2: randomUUID(),
    lineA_draft: randomUUID(),
    lineB_draft: randomUUID(),
    lineA_approved: randomUUID(),
    lineA2_approved: randomUUID(),
    lineB_approved: randomUUID(),
    lineM_approved: randomUUID(),
    lineScoped_approved: randomUUID(),
    lineC_approved: randomUUID(),
    leaveEntryA: randomUUID(),
    leaveEntryB: randomUUID(),
    leaveEntryC: randomUUID(),
    lrA_pendingL1: randomUUID(),
    lrA2_pendingL1: randomUUID(),
    lrB_pendingL1: randomUUID(),
    lrScoped_pendingFinal: randomUUID(),
    lrC_pendingFinal: randomUUID(),
    opening1: randomUUID(),
    candidate1: randomUUID(),
  };

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function runAs<T extends pg.QueryResultRow = pg.QueryResultRow>(
    actor: ActorSession,
    fn: (c: pg.Client) => Promise<pg.QueryResult<T>>,
  ): Promise<QueryOutcome<T>> {
    const url = actor.login === 'worker' ? workerUrl : appUrl;
    return withClient(url, async (c) => {
      await c.query('BEGIN');
      try {
        await actor.enter(c);
        try {
          const res = await fn(c);
          return { ok: true, rows: res.rows, rowCount: res.rowCount ?? 0 };
        } catch (error) {
          const err = error as Error & { code?: string };
          return { ok: false, ...(err.code !== undefined ? { code: err.code } : {}), message: err.message };
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  const userActor = (label: string, orgId: () => string, userId: () => string): ActorSession => ({
    label,
    login: 'app',
    enter: (c) =>
      c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId(), contextToken(userId(), orgId())]),
  });

  const noContextApp: ActorSession = {
    label: 'crove_app with no context',
    login: 'app',
    enter: async () => undefined,
  };

  const systemWorker: ActorSession = {
    label: 'crove_worker in system context of org1',
    login: 'worker',
    enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org1Id]),
  };

  const owner1Actor = userActor('owner1', () => org1Id, () => users.owner1);
  const admin1Actor = userActor('admin1', () => org1Id, () => users.admin1);
  const userAActor = userActor('linked member A', () => org1Id, () => users.userA);
  const userBActor = userActor('linked member B', () => org1Id, () => users.userB);
  const managerMActor = userActor('L1 manager M', () => org1Id, () => users.managerM);
  const unlinkedActor = userActor('unlinked member', () => org1Id, () => users.unlinkedMember);
  const viewerActor = userActor('viewer', () => org1Id, () => users.viewer);
  const scopedActor = userActor('branch-scoped linked member', () => org1Id, () => users.scopedMember);

  function expectBlockedWrite(outcome: QueryOutcome, label: string) {
    if (outcome.ok) {
      expect(outcome.rowCount, `${label}: expected 0 rows affected`).toBe(0);
    } else {
      expect(outcome.code, `${label}: expected 42501 refusal, got ${outcome.message}`).toBe('42501');
    }
  }

  async function selectIds(actor: ActorSession, table: string): Promise<string[]> {
    const out = await runAs<{ id: string }>(actor, (c) => c.query(`SELECT id::text AS id FROM ${table} ORDER BY id`));
    if (!out.ok) {
      throw new Error(`${actor.label} SELECT ${table} failed unexpectedly: ${out.code ?? ''} ${out.message}`);
    }
    return out.rows.map((r) => r.id).sort();
  }

  function hrTables(): string[] {
    return has.stage4a ? [...EXISTING_HR_TABLES, 'crove_hr.leave_request'].sort() : [...EXISTING_HR_TABLES].sort();
  }

  async function probeTableBlocked(actor: ActorSession, table: string) {
    const readOut = await runAs<{ n: number }>(actor, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
    if (readOut.ok) {
      expect(readOut.rows[0]?.n ?? 0, `${actor.label} reading ${table}`).toBe(0);
    } else {
      expect(readOut.code, `${actor.label} reading ${table}`).toBe('42501');
    }
    if (TABLES_WITH_UPDATED_AT.has(table)) {
      const updOut = await runAs(actor, (c) => c.query(`UPDATE ${table} SET updated_at = pg_catalog.now()`));
      expectBlockedWrite(updOut, `${actor.label} blind UPDATE ${table}`);
    }
    const delOut = await runAs(actor, (c) => c.query(`DELETE FROM ${table}`));
    expectBlockedWrite(delOut, `${actor.label} blind DELETE ${table}`);
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
    appUrl = app.toString();

    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();

    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });

    const newUser = async (tag: string) =>
      upsertIdentity(db, {
        issuer: 'hr-self-service.test',
        subject: tag,
        email: `${tag}@hr-self-service.test`,
        name: null,
      });

    users.owner1 = await newUser('owner1');
    users.admin1 = await newUser('admin1');
    users.userA = await newUser('user-a');
    users.userB = await newUser('user-b');
    users.managerM = await newUser('manager-m');
    users.managerM2 = await newUser('manager-m2');
    users.unlinkedMember = await newUser('unlinked-member');
    users.viewer = await newUser('viewer');
    users.scopedMember = await newUser('scoped-member');
    users.owner2 = await newUser('owner2');
    users.userC = await newUser('user-c');

    org1Id = (await createOrg(runtime, { type: 'user', userId: users.owner1, aal: 'aal1' }, 'Cong ty HR 1')).orgId;
    org2Id = (await createOrg(runtime, { type: 'user', userId: users.owner2, aal: 'aal1' }, 'Cong ty HR 2')).orgId;

    await withClient(adminUrl, async (c) => {
      const schemaProbe = (
        await c.query<{
          leave_request: boolean;
          employee_user_id: boolean;
          department_manager_user_id: boolean;
        }>(
          `SELECT (pg_catalog.to_regclass('crove_hr.leave_request') IS NOT NULL) AS leave_request,
                  EXISTS (
                    SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = 'crove_hr.payroll_employee'::pg_catalog.regclass
                       AND a.attname = 'user_id' AND a.attnum > 0 AND NOT a.attisdropped
                  ) AS employee_user_id,
                  EXISTS (
                    SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = 'crove_hr.department'::pg_catalog.regclass
                       AND a.attname = 'manager_user_id' AND a.attnum > 0 AND NOT a.attisdropped
                  ) AS department_manager_user_id`,
        )
      ).rows[0];
      has.leaveRequest = Boolean(schemaProbe?.leave_request);
      has.employeeUserId = Boolean(schemaProbe?.employee_user_id);
      has.departmentManagerUserId = Boolean(schemaProbe?.department_manager_user_id);
      has.stage4a = has.leaveRequest && has.employeeUserId && has.departmentManagerUserId;

      branchLe1 = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by)
         VALUES ($1, $2, 'Chi nhanh 2', 'branch', $3)`,
        [org1Id, branchLe1, users.owner1],
      );

      const org1Members: Array<[string, 'admin' | 'member' | 'viewer']> = [
        [users.admin1, 'admin'],
        [users.userA, 'member'],
        [users.userB, 'member'],
        [users.managerM, 'member'],
        [users.managerM2, 'member'],
        [users.unlinkedMember, 'member'],
        [users.viewer, 'viewer'],
        [users.scopedMember, 'member'],
      ];
      for (const [uid, role] of org1Members) {
        await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [
          org1Id,
          uid,
          role,
        ]);
      }
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [
        org2Id,
        users.userC,
      ]);

      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, $3, 'external_accountant', $4, $5)`,
        [org1Id, randomUUID(), users.scopedMember, branchLe1, users.owner1],
      );

      if (has.stage4a) {
        await c.query(
          `INSERT INTO crove_hr.department (org_id, id, name, manager_user_id)
           VALUES ($1, $2, 'Phong Ky Thuat', $3),
                  ($1, $4, 'Phong Kinh Doanh', $5),
                  ($6, $7, 'Phong Org 2', NULL)`,
          [org1Id, ids.dept1, users.managerM, ids.dept2, users.managerM2, org2Id, ids.deptOrg2],
        );

        await c.query(
          `INSERT INTO crove_hr.payroll_employee (org_id, id, display_name, department_id, user_id)
           VALUES ($1, $2, 'Nguyen Van A', $3, $4),
                  ($1, $5, 'Le Van C', $3, NULL),
                  ($1, $6, 'Tran Thi B', $7, $8),
                  ($1, $9, 'Quan ly M', $3, NULL),
                  ($1, $10, 'Pham Scoped', NULL, $11),
                  ($12, $13, 'Nhan vien Org 2', $14, $15)`,
          [
            org1Id,
            ids.empA,
            ids.dept1,
            users.userA,
            ids.empA2InDept1,
            ids.empB,
            ids.dept2,
            users.userB,
            ids.empM,
            ids.empScoped,
            users.scopedMember,
            org2Id,
            ids.empC,
            ids.deptOrg2,
            users.userC,
          ],
        );
      } else {
        await c.query(
          `INSERT INTO crove_hr.department (org_id, id, name)
           VALUES ($1, $2, 'Phong Ky Thuat'),
                  ($1, $3, 'Phong Kinh Doanh'),
                  ($4, $5, 'Phong Org 2')`,
          [org1Id, ids.dept1, ids.dept2, org2Id, ids.deptOrg2],
        );

        await c.query(
          `INSERT INTO crove_hr.payroll_employee (org_id, id, display_name, department_id)
           VALUES ($1, $2, 'Nguyen Van A', $3),
                  ($1, $4, 'Le Van C', $3),
                  ($1, $5, 'Tran Thi B', $6),
                  ($1, $7, 'Quan ly M', $3),
                  ($1, $8, 'Pham Scoped', NULL),
                  ($9, $10, 'Nhan vien Org 2', $11)`,
          [
            org1Id,
            ids.empA,
            ids.dept1,
            ids.empA2InDept1,
            ids.empB,
            ids.dept2,
            ids.empM,
            ids.empScoped,
            org2Id,
            ids.empC,
            ids.deptOrg2,
          ],
        );
      }

      for (const [orgId, empId] of [
        [org1Id, ids.empA],
        [org1Id, ids.empA2InDept1],
        [org1Id, ids.empB],
        [org1Id, ids.empM],
        [org2Id, ids.empC],
      ] as const) {
        await c.query(
          `INSERT INTO crove_hr.payroll_employment (org_id, id, employee_id, effective_from, contract_type, region, base_wage)
           VALUES ($1, $2, $3, '2026-01-01', 'indefinite', 'I', 20000000)`,
          [orgId, randomUUID(), empId],
        );
        await c.query(
          `INSERT INTO crove_hr.payroll_dependent (org_id, id, employee_id, display_name, relation, registered_on)
           VALUES ($1, $2, $3, 'Nguoi phu thuoc', 'child', '2026-01-01')`,
          [orgId, randomUUID(), empId],
        );
      }

      await c.query(
        `INSERT INTO crove_hr.payroll_leave_entry (org_id, id, employee_id, month, kind, days)
         VALUES ($1, $2, $3, '2026-10', 'annual_leave', 1),
                ($1, $4, $5, '2026-10', 'annual_leave', 2),
                ($6, $7, $8, '2026-10', 'annual_leave', 1)`,
        [org1Id, ids.leaveEntryA, ids.empA, ids.leaveEntryB, ids.empB, org2Id, ids.leaveEntryC, ids.empC],
      );

      // Insert runs as draft first so payroll_frozen_guard allows seeding payroll_line rows, then approve approved runs.
      await c.query(
        `INSERT INTO crove_hr.payroll_run (org_id, id, month, status, working_days)
         VALUES ($1, $2, '2026-11', 'draft', 26),
                ($1, $3, '2026-10', 'draft', 26),
                ($4, $5, '2026-10', 'draft', 26)`,
        [org1Id, ids.draftRun1, ids.approvedRun1, org2Id, ids.approvedRun2],
      );

      const lineRows: Array<[string, string, string, string, string]> = [
        [org1Id, ids.lineA_draft, ids.draftRun1, ids.empA, '15000000'],
        [org1Id, ids.lineB_draft, ids.draftRun1, ids.empB, '18000000'],
        [org1Id, ids.lineA_approved, ids.approvedRun1, ids.empA, '15000000'],
        [org1Id, ids.lineA2_approved, ids.approvedRun1, ids.empA2InDept1, '14000000'],
        [org1Id, ids.lineB_approved, ids.approvedRun1, ids.empB, '18000000'],
        [org1Id, ids.lineM_approved, ids.approvedRun1, ids.empM, '25000000'],
        [org1Id, ids.lineScoped_approved, ids.approvedRun1, ids.empScoped, '16000000'],
        [org2Id, ids.lineC_approved, ids.approvedRun2, ids.empC, '17000000'],
      ];
      for (const [orgId, lineId, runId, empId, gross] of lineRows) {
        await c.query(
          `INSERT INTO crove_hr.payroll_line
             (org_id, id, run_id, employee_id, gross, employee_insurance, employer_insurance, union_fee, taxable_income, pit, net, employer_cost)
           VALUES ($1, $2, $3, $4, $5, 1050000, 2150000, 200000, $5, 0, $5, $5)`,
          [orgId, lineId, runId, empId, gross],
        );
      }

      await c.query(
        `UPDATE crove_hr.payroll_run
            SET status = 'approved', approved_by = $1, approved_at = pg_catalog.now(), approval = '{}'::jsonb
          WHERE org_id = $2 AND id = $3`,
        [users.owner1, org1Id, ids.approvedRun1],
      );
      await c.query(
        `UPDATE crove_hr.payroll_run
            SET status = 'approved', approved_by = $1, approved_at = pg_catalog.now(), approval = '{}'::jsonb
          WHERE org_id = $2 AND id = $3`,
        [users.owner2, org2Id, ids.approvedRun2],
      );

      await c.query(
        `INSERT INTO crove_hr.job_opening (org_id, id, title) VALUES ($1, $2, 'Ky su phan mem')`,
        [org1Id, ids.opening1],
      );
      await c.query(
        `INSERT INTO crove_hr.candidate (org_id, id, opening_id, display_name) VALUES ($1, $2, $3, 'Ung vien Mau')`,
        [org1Id, ids.candidate1, ids.opening1],
      );

      if (has.stage4a) {
        await c.query(
          `INSERT INTO crove_hr.leave_request
             (org_id, id, employee_id, department_id, month, start_on, end_on, kind, days, status)
           VALUES ($1, $2, $3, $4, '2026-11', '2026-11-10', '2026-11-10', 'annual_leave', 1, 'pending_l1'),
                  ($1, $5, $6, $4, '2026-11', '2026-11-11', '2026-11-11', 'annual_leave', 1, 'pending_l1'),
                  ($1, $7, $8, $9, '2026-11', '2026-11-12', '2026-11-12', 'annual_leave', 1, 'pending_l1'),
                  ($1, $10, $11, NULL, '2026-11', '2026-11-13', '2026-11-13', 'personal_paid', 1, 'pending_final'),
                  ($12, $13, $14, $15, '2026-11', '2026-11-14', '2026-11-14', 'annual_leave', 1, 'pending_final')`,
          [
            org1Id,
            ids.lrA_pendingL1,
            ids.empA,
            ids.dept1,
            ids.lrA2_pendingL1,
            ids.empA2InDept1,
            ids.lrB_pendingL1,
            ids.empB,
            ids.dept2,
            ids.lrScoped_pendingFinal,
            ids.empScoped,
            org2Id,
            ids.lrC_pendingFinal,
            ids.empC,
            ids.deptOrg2,
          ],
        );
      }
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pins Stage 4A schema integrity and permissive-only tenant_isolation policies across crove_hr', async () => {
    expect(has.leaveRequest).toBe(has.employeeUserId);
    expect(has.leaveRequest).toBe(has.departmentManagerUserId);

    const tables = hrTables();
    await withClient(adminUrl, async (c) => {
      for (const table of tables) {
        const { rows: policies } = await c.query<{
          name: string;
          permissive: boolean;
          roles: string[];
          qual: string | null;
          check: string | null;
        }>(
          `SELECT p.polname AS name, p.polpermissive AS permissive,
                  ARRAY(SELECT pg_catalog.pg_get_userbyid(o) FROM pg_catalog.unnest(p.polroles) o ORDER BY 1)::text[] AS roles,
                  pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
                  pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
             FROM pg_catalog.pg_policy p
            WHERE p.polrelid = $1::regclass
            ORDER BY 1`,
          [table],
        );
        const permissive = policies.filter((p) => p.permissive);
        expect(permissive, `${table} must keep only the permissive tenant_isolation policy`).toEqual([
          { name: 'tenant_isolation', permissive: true, roles: ['crove_tenant'], qual: TENANT_PREDICATE, check: TENANT_PREDICATE },
        ]);
        const leScope = policies.filter((p) => !p.permissive && p.qual === LE_SCOPE_PREDICATE && p.check === LE_SCOPE_PREDICATE);
        expect(leScope.length, `${table} must retain RESTRICTIVE le_scope policy`).toBe(1);
      }

      if (!has.stage4a) return;

      const { rows: lrInfo } = await c.query<{ rls: boolean; le_notnull: boolean }>(
        `SELECT c.relrowsecurity AS rls,
                EXISTS (
                  SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'legal_entity_id' AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped
                ) AS le_notnull
           FROM pg_catalog.pg_class c
          WHERE c.oid = 'crove_hr.leave_request'::regclass`,
      );
      expect(lrInfo[0]).toEqual({ rls: true, le_notnull: true });

      // Linking a second employee in the same org to the same user_id must fail (unique per org when non-null).
      await c.query('BEGIN');
      try {
        await expect(
          c.query(
            `INSERT INTO crove_hr.payroll_employee (org_id, display_name, user_id) VALUES ($1, 'Trung user_id', $2)`,
            [org1Id, users.userA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('keeps unlinked member, viewer, no-context app, and worker system context at 0 rows and 0 writes across crove_hr', async () => {
    const tables = hrTables();
    // Positive control: owner1 and admin1 read org1 rows (and 0 org2 rows).
    for (const privActor of [owner1Actor, admin1Actor]) {
      expect(await selectIds(privActor, 'crove_hr.payroll_employee')).toEqual(
        [ids.empA, ids.empA2InDept1, ids.empB, ids.empM, ids.empScoped].sort(),
      );
      expect(await selectIds(privActor, 'crove_hr.payroll_run')).toEqual([ids.draftRun1, ids.approvedRun1].sort());
      if (has.stage4a) {
        expect(await selectIds(privActor, 'crove_hr.leave_request')).toEqual(
          [ids.lrA_pendingL1, ids.lrA2_pendingL1, ids.lrB_pendingL1, ids.lrScoped_pendingFinal].sort(),
        );
      }
    }

    for (const actor of [unlinkedActor, viewerActor, noContextApp, systemWorker]) {
      for (const table of tables) {
        await probeTableBlocked(actor, table);
      }

      const insertEmp = await runAs(actor, (c) =>
        c.query(`INSERT INTO crove_hr.payroll_employee (org_id, display_name) VALUES ($1, 'Tu nhan')`, [org1Id]),
      );
      expect(insertEmp.ok, `${actor.label} inserting payroll_employee`).toBe(false);
      expect((insertEmp as { code?: string }).code).toBe('42501');

      const insertDept = await runAs(actor, (c) =>
        c.query(`INSERT INTO crove_hr.department (org_id, name) VALUES ($1, 'Tu tao phong')`, [org1Id]),
      );
      expect(insertDept.ok, `${actor.label} inserting department`).toBe(false);
      expect((insertDept as { code?: string }).code).toBe('42501');
    }

    if (!has.stage4a) return;

    for (const [actor, actorUid] of [
      [unlinkedActor, users.unlinkedMember],
      [viewerActor, users.viewer],
    ] as const) {
      const claimSelf = await runAs(actor, (c) =>
        c.query(`UPDATE crove_hr.payroll_employee SET user_id = $1 WHERE org_id = $2`, [actorUid, org1Id]),
      );
      expectBlockedWrite(claimSelf, `${actor.label} self-claiming payroll_employee.user_id`);

      const claimManager = await runAs(actor, (c) =>
        c.query(`UPDATE crove_hr.department SET manager_user_id = $1 WHERE org_id = $2`, [actorUid, org1Id]),
      );
      expectBlockedWrite(claimManager, `${actor.label} self-claiming department.manager_user_id`);

      const insertLr = await runAs(actor, (c) =>
        c.query(
          `INSERT INTO crove_hr.leave_request (org_id, employee_id, department_id, month, start_on, end_on, kind, days)
           VALUES ($1, $2, $3, '2026-12', '2026-12-01', '2026-12-01', 'annual_leave', 1)`,
          [org1Id, ids.empA, ids.dept1],
        ),
      );
      expect(insertLr.ok, `${actor.label} inserting leave_request`).toBe(false);
      expect((insertLr as { code?: string }).code).toBe('42501');
    }
  });

  it('restricts linked member SELECTs to own employee, own leave, and own approved payslips (never drafts or other staff)', async () => {
    if (!has.stage4a) {
      // Pre-Stage 4A baseline: plain members read 0 rows across every crove_hr table, including payroll_run and payroll_line.
      for (const table of EXISTING_HR_TABLES) {
        await probeTableBlocked(userAActor, table);
        await probeTableBlocked(userBActor, table);
      }
      return;
    }

    // Linked member A sees ONLY own employee, own leave_request, own payroll_leave_entry, approved run, and own approved line.
    expect(await selectIds(userAActor, 'crove_hr.payroll_employee')).toEqual([ids.empA]);
    expect(await selectIds(userAActor, 'crove_hr.payroll_run')).toEqual([ids.approvedRun1]);
    expect(await selectIds(userAActor, 'crove_hr.payroll_line')).toEqual([ids.lineA_approved]);
    expect(await selectIds(userAActor, 'crove_hr.payroll_leave_entry')).toEqual([ids.leaveEntryA]);
    expect(await selectIds(userAActor, 'crove_hr.leave_request')).toEqual([ids.lrA_pendingL1]);

    // Never sees contracts/wages, dependents, recruiting, or unrelated departments.
    expect(await selectIds(userAActor, 'crove_hr.payroll_employment')).toEqual([]);
    expect(await selectIds(userAActor, 'crove_hr.payroll_dependent')).toEqual([]);
    expect(await selectIds(userAActor, 'crove_hr.candidate')).toEqual([]);
    expect(await selectIds(userAActor, 'crove_hr.job_opening')).toEqual([]);
    const userADepts = await selectIds(userAActor, 'crove_hr.department');
    expect(userADepts).not.toContain(ids.dept2);
    expect(userADepts).not.toContain(ids.deptOrg2);

    // Symmetric isolation for linked member B.
    expect(await selectIds(userBActor, 'crove_hr.payroll_employee')).toEqual([ids.empB]);
    expect(await selectIds(userBActor, 'crove_hr.payroll_run')).toEqual([ids.approvedRun1]);
    expect(await selectIds(userBActor, 'crove_hr.payroll_line')).toEqual([ids.lineB_approved]);
    expect(await selectIds(userBActor, 'crove_hr.payroll_leave_entry')).toEqual([ids.leaveEntryB]);
    expect(await selectIds(userBActor, 'crove_hr.leave_request')).toEqual([ids.lrB_pendingL1]);

    // Branch-scoped linked member (scoped to branchLe1) sees 0 rows in defaultLe1 across all self-service tables.
    for (const table of [
      'crove_hr.payroll_employee',
      'crove_hr.payroll_run',
      'crove_hr.payroll_line',
      'crove_hr.payroll_leave_entry',
      'crove_hr.leave_request',
    ]) {
      expect(await selectIds(scopedActor, table), `${scopedActor.label} on ${table}`).toEqual([]);
    }
  });

  it('denies direct SQL writes on master/payroll tables and blocks employee leave-approval or cross-employee writes', async () => {
    if (!has.stage4a) {
      for (const table of EXISTING_HR_TABLES) {
        await probeTableBlocked(userAActor, table);
      }
      const writeUpdates = [
        `UPDATE crove_hr.payroll_employee SET display_name = 'Tamper' WHERE org_id = $1`,
        `UPDATE crove_hr.payroll_run SET working_days = 20 WHERE org_id = $1`,
        `UPDATE crove_hr.payroll_line SET net = 99999999 WHERE org_id = $1`,
        `UPDATE crove_hr.payroll_leave_entry SET days = 30 WHERE org_id = $1`,
        `UPDATE crove_hr.department SET name = 'Tamper' WHERE org_id = $1`,
      ];
      for (const sqlText of writeUpdates) {
        expectBlockedWrite(await runAs(userAActor, (c) => c.query(sqlText, [org1Id])), sqlText);
      }
      return;
    }

    // Linked member A CANNOT insert or mutate payroll_employee, employment, dependent, run, line, leave_entry, or department.
    const readonlySqlChecks: Array<[string, string, unknown[]]> = [
      ['insert employee', `INSERT INTO crove_hr.payroll_employee (org_id, display_name) VALUES ($1, 'Fake')`, [org1Id]],
      ['update own employee', `UPDATE crove_hr.payroll_employee SET display_name = 'Tamper' WHERE org_id = $1 AND id = $2`, [org1Id, ids.empA]],
      ['relink own user_id', `UPDATE crove_hr.payroll_employee SET user_id = $3 WHERE org_id = $1 AND id = $2`, [org1Id, ids.empA, users.userB]],
      [
        'insert employment',
        `INSERT INTO crove_hr.payroll_employment (org_id, employee_id, effective_from, contract_type, region, base_wage) VALUES ($1, $2, '2026-12-01', 'indefinite', 'I', 99000000)`,
        [org1Id, ids.empA],
      ],
      ['insert run', `INSERT INTO crove_hr.payroll_run (org_id, month, working_days) VALUES ($1, '2026-12', 26)`, [org1Id]],
      ['update draft run', `UPDATE crove_hr.payroll_run SET working_days = 10 WHERE org_id = $1`, [org1Id]],
      ['update own line', `UPDATE crove_hr.payroll_line SET net = 99999999 WHERE org_id = $1`, [org1Id]],
      ['delete own line', `DELETE FROM crove_hr.payroll_line WHERE org_id = $1`, [org1Id]],
      [
        'insert leave entry',
        `INSERT INTO crove_hr.payroll_leave_entry (org_id, employee_id, month, kind, days) VALUES ($1, $2, '2026-12', 'annual_leave', 5)`,
        [org1Id, ids.empA],
      ],
      ['update leave entry', `UPDATE crove_hr.payroll_leave_entry SET days = 99 WHERE org_id = $1`, [org1Id]],
      ['delete leave entry', `DELETE FROM crove_hr.payroll_leave_entry WHERE org_id = $1`, [org1Id]],
      ['insert department', `INSERT INTO crove_hr.department (org_id, name) VALUES ($1, 'Fake dept')`, [org1Id]],
      ['update department manager', `UPDATE crove_hr.department SET manager_user_id = $2 WHERE org_id = $1`, [org1Id, users.userA]],
    ];
    for (const [label, sqlText, params] of readonlySqlChecks) {
      expectBlockedWrite(await runAs(userAActor, (c) => c.query(sqlText, params)), `userA ${label}`);
    }

    // Linked member A CANNOT submit a leave request for another employee (empB, empA2, or org2 empC).
    for (const [targetLabel, targetOrg, targetEmp, targetDept] of [
      ['empB', org1Id, ids.empB, ids.dept2],
      ['empA2 same dept', org1Id, ids.empA2InDept1, ids.dept1],
      ['org2 empC', org2Id, ids.empC, ids.deptOrg2],
    ] as const) {
      const insertOther = await runAs(userAActor, (c) =>
        c.query(
          `INSERT INTO crove_hr.leave_request (org_id, employee_id, department_id, month, start_on, end_on, kind, days, status)
           VALUES ($1, $2, $3, '2026-12', '2026-12-01', '2026-12-01', 'annual_leave', 1, 'pending_l1')`,
          [targetOrg, targetEmp, targetDept],
        ),
      );
      expect(insertOther.ok, `userA inserting leave_request for ${targetLabel}`).toBe(false);
      expect((insertOther as { code?: string }).code).toBe('42501');
    }

    // Linked member A CANNOT insert a leave request with approved/rejected status or forged approval columns.
    for (const badStatus of ['approved', 'rejected'] as const) {
      const insertForgedStatus = await runAs(userAActor, (c) =>
        c.query(
          `INSERT INTO crove_hr.leave_request (org_id, employee_id, department_id, month, start_on, end_on, kind, days, status)
           VALUES ($1, $2, $3, '2026-12', '2026-12-02', '2026-12-02', 'annual_leave', 1, $4)`,
          [org1Id, ids.empA, ids.dept1, badStatus],
        ),
      );
      expect(insertForgedStatus.ok, `userA inserting leave_request with status=${badStatus}`).toBe(false);
      expect((insertForgedStatus as { code?: string }).code).toBe('42501');
    }

    const insertForgedApprover = await runAs(userAActor, (c) =>
      c.query(
        `INSERT INTO crove_hr.leave_request
           (org_id, employee_id, department_id, month, start_on, end_on, kind, days, status, l1_approver_user_id, final_acted_by, payroll_leave_entry_id)
         VALUES ($1, $2, $3, '2026-12', '2026-12-03', '2026-12-03', 'annual_leave', 1, 'pending_l1', $4, $4, $5)`,
        [org1Id, ids.empA, ids.dept1, users.userA, ids.leaveEntryA],
      ),
    );
    expect(insertForgedApprover.ok, 'userA inserting leave_request with forged approver/entry fields').toBe(false);
    expect((insertForgedApprover as { code?: string }).code).toBe('42501');

    // Linked member A CANNOT blind-UPDATE other staff leave requests or escalate own leave_request status/days.
    for (const targetLr of [ids.lrB_pendingL1, ids.lrA2_pendingL1]) {
      expectBlockedWrite(
        await runAs(userAActor, (c) =>
          c.query(`UPDATE crove_hr.leave_request SET decision_note = 'tamper' WHERE id = $1`, [targetLr]),
        ),
        `userA updating ${targetLr}`,
      );
    }

    for (const [label, sqlText, params] of [
      ['approve own leave_request', `UPDATE crove_hr.leave_request SET status = 'approved' WHERE org_id = $1 AND id = $2`, [org1Id, ids.lrA_pendingL1]],
      ['skip L1 to pending_final', `UPDATE crove_hr.leave_request SET status = 'pending_final' WHERE org_id = $1 AND id = $2`, [org1Id, ids.lrA_pendingL1]],
      ['reject own leave_request', `UPDATE crove_hr.leave_request SET status = 'rejected' WHERE org_id = $1 AND id = $2`, [org1Id, ids.lrA_pendingL1]],
      ['tamper days on own leave_request', `UPDATE crove_hr.leave_request SET days = 20 WHERE org_id = $1 AND id = $2`, [org1Id, ids.lrA_pendingL1]],
      ['blind approve without WHERE', `UPDATE crove_hr.leave_request SET status = 'approved'`, []],
      ['delete own leave_request', `DELETE FROM crove_hr.leave_request WHERE org_id = $1 AND id = $2`, [org1Id, ids.lrA_pendingL1]],
    ] as const) {
      expectBlockedWrite(
        await runAs(userAActor, (c) => c.query(sqlText, [...params])),
        `userA ${label}`,
      );
    }

    // Confirm none of the seeded leave requests were modified or deleted.
    await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ id: string; status: string; days: string }>(
        `SELECT id::text AS id, status, days::text AS days
           FROM crove_hr.leave_request
          WHERE id = ANY($1::uuid[])
          ORDER BY id`,
        [[ids.lrA_pendingL1, ids.lrA2_pendingL1, ids.lrB_pendingL1]],
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === 'pending_l1' && Number(r.days) === 1)).toBe(true);
    });
  });

  it('scopes L1 department manager to dept1 leave_request rows only, hides staff salaries/PII, and revokes on unassign', async () => {
    if (!has.stage4a) {
      // Pre-Stage 4A baseline: plain member (future L1 manager) reads 0 rows across every crove_hr table.
      for (const table of EXISTING_HR_TABLES) {
        await probeTableBlocked(managerMActor, table);
      }
      return;
    }

    // L1 manager M (unlinked to any employee row) sees ONLY dept1 leave_request rows (never dept2, scoped, or org2).
    expect(await selectIds(managerMActor, 'crove_hr.leave_request')).toEqual(
      [ids.lrA_pendingL1, ids.lrA2_pendingL1].sort(),
    );

    // L1 manager M sees 0 staff PII, contracts, salaries, runs, leave entries, or recruiting records.
    for (const hiddenTable of [
      'crove_hr.payroll_employee',
      'crove_hr.payroll_employment',
      'crove_hr.payroll_dependent',
      'crove_hr.payroll_run',
      'crove_hr.payroll_line',
      'crove_hr.payroll_leave_entry',
      'crove_hr.candidate',
      'crove_hr.job_opening',
    ]) {
      expect(await selectIds(managerMActor, hiddenTable), `${managerMActor.label} on ${hiddenTable}`).toEqual([]);
    }
    const mgrDepts = await selectIds(managerMActor, 'crove_hr.department');
    expect(mgrDepts).not.toContain(ids.dept2);
    expect(mgrDepts).not.toContain(ids.deptOrg2);

    // L1 manager M CANNOT final-approve (status = 'approved'), touch dept2, insert leave_request, or write HR/payroll tables.
    expectBlockedWrite(
      await runAs(managerMActor, (c) =>
        c.query(`UPDATE crove_hr.leave_request SET status = 'approved' WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.lrA_pendingL1,
        ]),
      ),
      'managerM final-approving leave_request',
    );
    expectBlockedWrite(
      await runAs(managerMActor, (c) => c.query(`UPDATE crove_hr.leave_request SET status = 'approved'`)),
      'managerM blind-approving leave_request',
    );
    expectBlockedWrite(
      await runAs(managerMActor, (c) =>
        c.query(`UPDATE crove_hr.leave_request SET status = 'pending_final' WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.lrB_pendingL1,
        ]),
      ),
      'managerM modifying dept2 leave_request',
    );
    const mgrInsertLr = await runAs(managerMActor, (c) =>
      c.query(
        `INSERT INTO crove_hr.leave_request (org_id, employee_id, department_id, month, start_on, end_on, kind, days, status)
         VALUES ($1, $2, $3, '2026-12', '2026-12-04', '2026-12-04', 'annual_leave', 1, 'pending_l1')`,
        [org1Id, ids.empA, ids.dept1],
      ),
    );
    expect(mgrInsertLr.ok, 'managerM inserting leave_request for empA').toBe(false);
    expect((mgrInsertLr as { code?: string }).code).toBe('42501');

    for (const [label, sqlText, params] of [
      ['insert leave entry', `INSERT INTO crove_hr.payroll_leave_entry (org_id, employee_id, month, kind, days) VALUES ($1, $2, '2026-12', 'annual_leave', 1)`, [org1Id, ids.empA]],
      ['update employee', `UPDATE crove_hr.payroll_employee SET display_name = 'Tamper' WHERE org_id = $1`, [org1Id]],
      ['update run', `UPDATE crove_hr.payroll_run SET working_days = 10 WHERE org_id = $1`, [org1Id]],
      ['update line', `UPDATE crove_hr.payroll_line SET net = 99999999 WHERE org_id = $1`, [org1Id]],
      ['update department', `UPDATE crove_hr.department SET manager_user_id = NULL WHERE org_id = $1`, [org1Id]],
    ] as const) {
      expectBlockedWrite(
        await runAs(managerMActor, (c) => c.query(sqlText, [...params])),
        `managerM ${label}`,
      );
    }

    // Even when L1 manager M is also linked to their own pre-seeded employee row (empM) in dept1, M still sees 0 staff salaries/PII.
    await withClient(adminUrl, async (c) => {
      await c.query(
        `UPDATE crove_hr.payroll_employee SET user_id = $3 WHERE org_id = $1 AND id = $2`,
        [org1Id, ids.empM, users.managerM],
      );
    });

    try {
      expect(await selectIds(managerMActor, 'crove_hr.payroll_employee')).toEqual([ids.empM]);
      expect(await selectIds(managerMActor, 'crove_hr.payroll_run')).toEqual([ids.approvedRun1]);
      expect(await selectIds(managerMActor, 'crove_hr.payroll_line')).toEqual([ids.lineM_approved]);
      expect(await selectIds(managerMActor, 'crove_hr.leave_request')).toEqual(
        [ids.lrA_pendingL1, ids.lrA2_pendingL1].sort(),
      );

      // Unassign managerM from dept1 (and unlink empM): managerM immediately sees 0 leave_request rows.
      await withClient(adminUrl, async (c) => {
        await c.query(`UPDATE crove_hr.department SET manager_user_id = NULL WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.dept1,
        ]);
        await c.query(`UPDATE crove_hr.payroll_employee SET user_id = NULL WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.empM,
        ]);
      });

      expect(await selectIds(managerMActor, 'crove_hr.leave_request')).toEqual([]);
      expect(await selectIds(managerMActor, 'crove_hr.payroll_employee')).toEqual([]);
      expect(await selectIds(managerMActor, 'crove_hr.payroll_line')).toEqual([]);
    } finally {
      await withClient(adminUrl, async (c) => {
        await c.query(`UPDATE crove_hr.department SET manager_user_id = $3 WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.dept1,
          users.managerM,
        ]);
        await c.query(`UPDATE crove_hr.payroll_employee SET user_id = NULL WHERE org_id = $1 AND id = $2`, [
          org1Id,
          ids.empM,
        ]);
      });
    }
  });
});
