// SPDX-License-Identifier: AGPL-3.0-only
// Stage 6D DB integration tests (#4529) on real PostgreSQL 17:
// 1. Company -> Department -> Employee OKR alignment, legal entity isolation, and decimal.js precision.
// 2. Caller-scoped Ludy Cong tac (projects) task linkage with graceful private project & MODULE_OFF fallback.
// 3. Strictly scoped RLS: owner/admin, active L1 dept manager (revoked when dept archived), linked self check-in
//    (target tamper blocked by DB trigger), unlinked member 0 rows, viewer blocked, cross-org isolation.
// 4. Metered Ly OKR check-in draft (hr.okr_checkin_draft) + 100% deterministic fallback when AI is off.
// 5. PDPL erasure (hr.payroll.employee.erase), member.remove FK cleanup, and ludy_kernel.org_purge.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrDepartmentWritten,
  HrOkrKeyResultMutationResult,
  HrOkrObjectiveMutationResult,
  HrOkrProjectOptionsResult,
  HrOkrProjectTasksResult,
  HrOkrTreeResult,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { hrCommands, hrQueries, type HrOkrDraftSource } from '@ludy/mod-hr';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftOkrCheckinSummary, hrOkrAi } from '../src/hr-okr-ai.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`missing blob ${key}`);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('HR Stage 6D quarterly OKRs and Ludy Projects linkage (#4529)', () => {
  const dbName = `ludy_test_hr6d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const store = new MemoryStore();
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const person = (role: string, name: string) =>
      upsertIdentity(db, { issuer: 'hr6d', subject: `${role}-${tag}`, email: `${role}-${tag}@hr6d.test`, name });
    const owner = await person('owner', 'Chủ Doanh Nghiệp');
    const admin = await person('admin', 'Quản Trị Nhân Sự');
    const manager = await person('manager', 'Trưởng Phòng Kỹ Thuật');
    const otherMgr = await person('othermgr', 'Trưởng Phòng Kinh Doanh');
    const staffA = await person('staffa', 'Nguyễn Văn A');
    const staffB = await person('staffb', 'Trần Thị B');
    const viewer = await person('viewer', 'Người Xem');

    const { orgId } = await createOrg(rt, asUser(owner), `Cty Stage 6D ${tag}`);
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'viewer')`,
      [orgId, admin, manager, otherMgr, staffA, staffB, viewer],
    );

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown,
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, admin, manager, otherMgr, staffA, staffB, viewer, exec, query };
  }

  beforeAll(async () => {
    const rootPool = new pg.Client({ connectionString: ADMIN as string });
    await rootPool.connect();
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    const rtOpts = {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required' as const,
    };
    rt = new Runtime(createDb(appPool), rtOpts).register({
      commands: [...kernelCommands, ...hrCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault }).register({
      commands: [...kernelCommands, ...hrCommands, ...projectsCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...projectsQueries],
    });
  }, 420_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = new pg.Client({ connectionString: ADMIN });
    await rootPool.connect();
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('builds Company -> Dept -> Individual OKR tree with decimal.js math, Projects linkage, strict RLS, AI fallback, and erasure', async () => {
    const o = await setupOrg();
    const o2 = await setupOrg();

    // 1. Setup departments and linked employees.
    const { departmentId: deptTech } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật',
      payFunction: 'production',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.manager });

    const { departmentId: deptSales } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh',
      payFunction: 'sales',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptSales, managerUserId: o.otherMgr });

    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nguyễn Văn A',
          departmentId: deptTech,
          jobTitle: 'Kỹ sư Backend',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '18000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));

    // Notice staffB stays unlinked and manages no department.

    // 2. Setup Ludy Cong tac (projects): one org project and one private project hidden from dept manager.
    const { positionId: seatA } = await o.exec<{ positionId: string }>(
      o.owner,
      'kernel.position.create',
      { title: 'Kỹ sư Backend', module: 'projects', roleKey: 'projects.member' },
      asMfa(o.owner),
    );
    await o.exec(o.owner, 'kernel.position.assign', { id: seatA, holder: { type: 'user', userId: o.staffA } }, asMfa(o.owner));

    const { projectId: orgProjId } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', {
      name: 'Giao hàng Q4',
      visibility: 'org',
    });
    const { taskId: task1 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', {
      projectId: orgProjId,
      title: 'Tích hợp API giao vận',
      assigneePositionId: seatA,
      status: 'done',
    });
    const { taskId: task2 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', {
      projectId: orgProjId,
      title: 'Hoàn thiện màn hình theo dõi',
      assigneePositionId: seatA,
      status: 'todo',
    });

    const { projectId: privProjId } = await o.exec<{ projectId: string }>(o.staffA, 'projects.project.create', {
      name: 'Kế hoạch riêng tư nhân viên',
      visibility: 'private',
      memberUserIds: [],
    });
    const { taskId: privTask } = await o.exec<{ taskId: string }>(o.staffA, 'projects.task.create', {
      projectId: privProjId,
      title: 'Ghi chú nội bộ riêng tư',
      assigneePositionId: seatA,
      status: 'done',
    });

    // 3. Company objective (owner only; L1 manager & staff blocked).
    await expect(
      o.exec(o.manager, 'hr.okr.objective.create', { quarter: '2026-Q4', scope: 'company', title: 'Mở rộng toàn quốc' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const companyObj = await o.exec<HrOkrObjectiveMutationResult>(o.owner, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'company',
      title: 'Tăng doanh thu bền vững Q4',
      activate: true,
    });
    // Currency KR with exact decimal.js repeating division: 100000000 / 300000000 = 33.33%
    const compKr = await o.exec<HrOkrKeyResultMutationResult>(o.admin, 'hr.okr.kr.add', {
      objectiveId: companyObj.objectiveId,
      title: 'Đạt doanh thu thuần 300 triệu',
      metricType: 'currency',
      targetValue: '300000000',
      currentValue: '100000000',
      unit: 'VND',
    });
    expect(compKr.progressPct).toBe('33.33');

    // 4. L1 manager creates Department objective aligned under Company objective + KR linked to Cong tac.
    await expect(
      o.exec(o.manager, 'hr.okr.objective.create', {
        quarter: '2026-Q4',
        scope: 'department',
        departmentId: deptSales,
        title: 'Sai phòng ban',
      }),
    ).rejects.toMatchObject({ code: 'HR_DEPARTMENT_NOT_FOUND', status: 404 });

    const deptObj = await o.exec<HrOkrObjectiveMutationResult>(o.manager, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'department',
      departmentId: deptTech,
      parentObjectiveId: companyObj.objectiveId,
      title: 'Ổn định hạ tầng và bàn giao đúng hạn',
      activate: true,
    });

    // 5. L1 manager creates Individual objective for staffA with Cong tac task linkage.
    const indObj = await o.exec<HrOkrObjectiveMutationResult>(o.manager, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'individual',
      ownerEmployeeId: empA,
      parentObjectiveId: deptObj.objectiveId,
      title: 'Bàn giao phân hệ giao vận Q4',
      activate: true,
    });

    const krTasks = await o.exec<HrOkrKeyResultMutationResult>(o.manager, 'hr.okr.kr.add', {
      objectiveId: indObj.objectiveId,
      title: 'Hoàn thành 2 đầu việc dự án Giao hàng Q4',
      metricType: 'project_tasks',
      linkedProjectId: orgProjId,
      linkedTaskIds: [task1, task2],
    });
    expect(krTasks.targetValue).toBe('2');
    expect(krTasks.currentValue).toBe('1');
    expect(krTasks.progressPct).toBe('50');
    expect(krTasks.completedLinkedTasks).toBe(1);
    expect(krTasks.totalLinkedTasks).toBe(2);

    // Owner/admin links staffA's private project to another KR on indObj (owner can see it per ADR-0056; manager cannot!).
    const krPrivate = await o.exec<HrOkrKeyResultMutationResult>(o.owner, 'hr.okr.kr.add', {
      objectiveId: indObj.objectiveId,
      title: 'Theo dõi việc riêng',
      metricType: 'project_tasks',
      linkedProjectId: privProjId,
      linkedTaskIds: [privTask],
    });

    // Manager calling projectOptions / projectTasks must NOT see staffA's private project.
    const mgrProjects = await o.query<HrOkrProjectOptionsResult>(o.manager, 'hr.okr.project_options', {});
    expect(mgrProjects.projectsAvailable).toBe(true);
    expect(mgrProjects.projects.some((p) => p.id === orgProjId)).toBe(true);
    expect(mgrProjects.projects.some((p) => p.id === privProjId)).toBe(false);

    const mgrPrivTasks = await o.query<HrOkrProjectTasksResult>(o.manager, 'hr.okr.project_tasks', { projectId: privProjId });
    expect(mgrPrivTasks).toEqual({ projectsAvailable: true, projectAccessible: false, tasks: [] });

    // Manager reading tree degrades gracefully on the private-linked KR (no crash/throw, accessible=false).
    const mgrTree = await o.query<HrOkrTreeResult>(o.manager, 'hr.okr.tree', { quarter: '2026-Q4' });
    const mgrIndObj = mgrTree.objectives.find((x) => x.id === indObj.objectiveId);
    expect(mgrIndObj?.progressPct).toBe('75'); // (50 + 100) / 2
    const mgrPrivKr = mgrIndObj?.keyResults.find((k) => k.id === krPrivate.keyResultId);
    expect(mgrPrivKr?.linkedProjectAccessible).toBe(false);
    expect(mgrPrivKr?.linkedTaskIds).toEqual([]);
    expect(mgrPrivKr?.linkedTasks).toEqual([]);
    const ownerTree = await o.query<HrOkrTreeResult>(o.owner, 'hr.okr.tree', { quarter: '2026-Q4' });
    const ownerPrivKr = ownerTree.objectives.find((x) => x.id === indObj.objectiveId)?.keyResults.find((k) => k.id === krPrivate.keyResultId);
    expect(ownerPrivKr?.linkedProjectAccessible).toBe(true);
    expect(ownerPrivKr?.linkedTaskIds).toEqual([privTask]);

    // StaffA completes task2 in Projects, then runs syncFromProjects on self check-in!
    await o.exec(o.owner, 'kernel.task.set_status', { id: task2, status: 'done' });
    const selfCheckedIn = await o.exec<HrOkrKeyResultMutationResult>(o.staffA, 'hr.okr.kr.checkin', {
      keyResultId: krTasks.keyResultId,
      syncFromProjects: true,
      note: 'Đã hoàn thành nốt task kiểm thử giao vận.',
    });
    expect(selfCheckedIn.currentValue).toBe('2');
    expect(selfCheckedIn.progressPct).toBe('100');

    // StaffA CANNOT edit KR targets via command OR raw SQL (trigger okr_key_result_write_guard blocks it).
    await expect(
      o.exec(o.staffA, 'hr.okr.kr.update', { keyResultId: krTasks.keyResultId, title: 'Đổi mục tiêu' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const staffSqlClient = await appPool.connect();
    try {
      await staffSqlClient.query('BEGIN');
      await enterUser(staffSqlClient, o.staffA, o.orgId);
      await expect(
        staffSqlClient.query(`UPDATE ludy_hr.okr_key_result SET target_value = 999 WHERE id = $1`, [krTasks.keyResultId]),
      ).rejects.toThrow(/self check-in cannot modify key result definition or target/);
      await staffSqlClient.query('ROLLBACK');
    } finally {
      staffSqlClient.release();
    }

    // StaffB (unlinked) and viewer get 0 rows; otherMgr sees 0 rows in deptTech/staffA; o2 sees 0 rows.
    const staffBTree = await o.query<HrOkrTreeResult>(o.staffB, 'hr.okr.tree', { quarter: '2026-Q4' });
    expect(staffBTree.objectives).toEqual([]);
    await expect(o.query(o.viewer, 'hr.okr.tree', { quarter: '2026-Q4' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const o2Tree = await o2.query<HrOkrTreeResult>(o2.owner, 'hr.okr.tree', { quarter: '2026-Q4' });
    expect(o2Tree.objectives).toEqual([]);

    // Disabling projects module degrades gracefully and preserves manual progress.
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'projects', enabled: false }, asMfa(o.owner));
    const offTree = await o.query<HrOkrTreeResult>(o.staffA, 'hr.okr.tree', { quarter: '2026-Q4' });
    expect(offTree.projectsAvailable).toBe(false);
    const offSynced = await o.exec<HrOkrKeyResultMutationResult>(o.staffA, 'hr.okr.kr.sync_projects', {
      keyResultId: krTasks.keyResultId,
    });
    expect(offSynced.projectsAvailable).toBe(false);
    expect(offSynced.currentValue).toBe('2');
    expect(offSynced.progressPct).toBe('100');
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'projects', enabled: true }, asMfa(o.owner));

    // Metered Ly OKR check-in draft works identically with AI off (deterministicSummary) and AI on (pseudonymized P1).
    const okrPorts = {
      read: (inp: { keyResultId: string }) =>
        o.query<HrOkrDraftSource>(o.staffA, 'hr.okr.draft.read', { keyResultId: inp.keyResultId }),
      isAiStopped: async () =>
        (await o.query<{ aiStopped: boolean }>(o.staffA, 'hr.okr.ai_status', {})).aiStopped,
      record: (inp: { keyResultId: string; aiStatus: 'used' | 'off' | 'busy' | 'budget' | 'failed' | 'no_data'; progressPct: string; completedLinkedTasks: number }) =>
        o.exec(o.staffA, 'hr.okr.draft.audit', inp),
    };
    const offDraft = await draftOkrCheckinSummary(
      hrOkrAi(null, new DraftBudget()),
      okrPorts,
      rt,
      o.orgId,
      asUser(o.staffA),
      { keyResultId: krTasks.keyResultId },
    );
    expect(offDraft.status).toBe('off');
    expect(offDraft.draftNote).toBeNull();
    expect(offDraft.deterministicSummary).toContain('2026-Q4');
    expect(offDraft.deterministicSummary).toContain('100%');

    const meter: AiMeter = { admit: async () => {}, record: async () => {} };
    const onDraft = await draftOkrCheckinSummary(
      hrOkrAi(
        {
          hrOkrCheckinDraft: async (_inp, opts) => {
            expect(opts?.forbidden).toEqual(['Nguyễn Văn A']);
            return {
              draft: 'Trong quý 2026-Q4, P1 đã hoàn thành 2/2 công việc dự án Giao hàng Q4 (100%).',
              ai: { ok: true, reason: 'ok' },
            };
          },
        },
        new DraftBudget(),
      ),
      okrPorts,
      rt,
      o.orgId,
      asUser(o.staffA),
      { keyResultId: krTasks.keyResultId },
      meter,
    );
    expect(onDraft.status).toBe('used');
    expect(onDraft.draftNote).toContain('P1');

    // Whole-project link keeps persisted current/target/progress_pct invariant for non-manager self check-in even after new task added.
    const krWholeProj = await o.exec<HrOkrKeyResultMutationResult>(o.manager, 'hr.okr.kr.add', {
      objectiveId: indObj.objectiveId,
      title: 'Đồng bộ toàn bộ dự án Giao hàng Q4',
      metricType: 'project_tasks',
      linkedProjectId: orgProjId,
      linkedTaskIds: [],
    });
    await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', {
      projectId: orgProjId,
      title: 'Tác vụ phát sinh thêm sau khi tạo KR',
      assigneePositionId: seatA,
      status: 'todo',
    });
    const wholeSyncedSelf = await o.exec<HrOkrKeyResultMutationResult>(o.staffA, 'hr.okr.kr.sync_projects', {
      keyResultId: krWholeProj.keyResultId,
    });
    // Manager target (2) is unchanged by self sync, 2 of 3 tasks done => current=1.33, target=2, progress=66.5%.
    expect(wholeSyncedSelf.targetValue).toBe('2');
    expect(wholeSyncedSelf.currentValue).toBe('1.33');
    expect(wholeSyncedSelf.progressPct).toBe('66.5');
    // Removing KR is blocked when objective is archived; changing parent quarter with children is blocked.
    await expect(
      o.exec(o.admin, 'hr.okr.objective.update', { objectiveId: companyObj.objectiveId, quarter: '2027-Q1' }),
    ).rejects.toMatchObject({ code: 'HR_OKR_HAS_CHILDREN_QUARTER', status: 409 });
    await o.exec(o.admin, 'hr.okr.kr.remove', { keyResultId: krWholeProj.keyResultId });

    // Archiving department immediately revokes L1 manager visibility and write authority.
    await o.exec(o.owner, 'hr.department.archive', { departmentId: deptTech });
    const afterArchiveTree = await o.query<HrOkrTreeResult>(o.manager, 'hr.okr.tree', { quarter: '2026-Q4' });
    expect(afterArchiveTree.objectives.find((x) => x.id === indObj.objectiveId)).toBeUndefined();
    await expect(
      o.exec(o.manager, 'hr.okr.kr.add', {
        objectiveId: indObj.objectiveId,
        title: 'Sau khi lưu trữ phòng ban',
        metricType: 'percent',
      }),
    ).rejects.toMatchObject({ code: 'HR_OKR_OBJECTIVE_NOT_FOUND', status: 404 });

    // Remove checker member (other than owner) clears FK last_checkin_by without trigger failure; remove non-last user cleanly.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empA, endedOn: '2026-10-01' }, asMfa(o.owner));
    const c = await adminPool.connect();
    let cCommitted = false;
    let cBroken = false;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empA],
      );
      await c.query('COMMIT');
      cCommitted = true;
    } catch (err) {
      if (!cCommitted) await c.query('ROLLBACK').catch(() => { cBroken = true; });
      throw err;
    } finally {
      c.release(cBroken);
    }

    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empA }, asMfa(o.owner));
    const erasedObj = (
      await adminPool.query<{ owner_employee_id: string | null; status: string; title: string }>(
        `SELECT owner_employee_id, status, title FROM ludy_hr.okr_objective WHERE id = $1`,
        [indObj.objectiveId],
      )
    ).rows[0];
    expect(erasedObj).toEqual({ owner_employee_id: null, status: 'archived', title: '[erased]' });
    const keptCompanyObj = (
      await adminPool.query<{ title: string }>(`SELECT title FROM ludy_hr.okr_objective WHERE id = $1`, [companyObj.objectiveId])
    ).rows[0];
    expect(keptCompanyObj?.title).toBe('Tăng doanh thu bền vững Q4');

    // Reopening a PDPL-erased individual objective is blocked in both command and DB trigger (#4679 item 6).
    await expect(
      o.exec(o.owner, 'hr.okr.objective.set_status', { objectiveId: indObj.objectiveId, status: 'active' }),
    ).rejects.toMatchObject({ code: 'HR_OKR_OWNER_ERASED', status: 409 });
    await expect(
      o.exec(o.admin, 'hr.okr.objective.set_status', { objectiveId: indObj.objectiveId, status: 'draft' }),
    ).rejects.toMatchObject({ code: 'HR_OKR_OWNER_ERASED', status: 409 });
    const reopenSql = await appPool.connect();
    try {
      await reopenSql.query('BEGIN');
      await enterUser(reopenSql, o.owner, o.orgId);
      await expect(
        reopenSql.query(`UPDATE ludy_hr.okr_objective SET status = 'active' WHERE org_id = $1 AND id = $2`, [o.orgId, indObj.objectiveId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/cannot reopen erased individual objective/) });
      await reopenSql.query('ROLLBACK');
    } finally {
      reopenSql.release();
    }

    const erasedKr = (
      await adminPool.query<{ last_checkin_note: string | null; progress_pct: string }>(
        `SELECT last_checkin_note, progress_pct::text FROM ludy_hr.okr_key_result WHERE id = $1`,
        [krTasks.keyResultId],
      )
    ).rows[0];
    expect(erasedKr?.last_checkin_note).toBeNull();
    expect(Number(erasedKr?.progress_pct)).toBe(100);

    // member.remove succeeds when member authored a KR check-in.
    await o.exec(o.owner, 'kernel.member.remove', { userId: o.staffA }, asMfa(o.owner));
    const afterMemberRemoved = (
      await adminPool.query<{ last_checkin_by: string | null }>(
        `SELECT last_checkin_by FROM ludy_hr.okr_key_result WHERE id = $1`,
        [krTasks.keyResultId],
      )
    ).rows[0];
    expect(afterMemberRemoved?.last_checkin_by).toBeNull();

    // org_purge cleans both OKR tables completely.
    const dayMs = 24 * 60 * 60 * 1000;
    const pClient = await adminPool.connect();
    let pInTx = false;
    let pBroken = false;
    try {
      await pClient.query('BEGIN');
      pInTx = true;
      await pClient.query('SET LOCAL session_replication_role = replica');
      await pClient.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await pClient.query('COMMIT');
      pInTx = false;
      await pClient.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}')`,
        [
          o.orgId,
          new Date(Date.now() - 40 * dayMs),
          o.owner,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
    } catch (err) {
      if (pInTx) await pClient.query('ROLLBACK').catch(() => { pBroken = true; });
      throw err;
    } finally {
      pClient.release(pBroken);
    }
    const purged = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'Stage 6D test cleanup' });
    expect(purged.kind).toBe('purged');
    for (const tbl of ['ludy_hr.okr_key_result', 'ludy_hr.okr_objective']) {
      const left = await adminPool.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM ${tbl} WHERE org_id = $1`, [o.orgId]);
      expect(left.rows[0]?.cnt).toBe(0);
    }
  });

  it('enforces okr_objective_entity_fk and SECURITY DEFINER employee checks in OKR triggers (#4676)', async () => {
    const o = await setupOrg();
    const o2 = await setupOrg();

    const defaultEntityId = (
      await adminPool.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`,
        [o.orgId],
      )
    ).rows[0]?.id as string;
    const otherOrgEntityId = (
      await adminPool.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`,
        [o2.orgId],
      )
    ).rows[0]?.id as string;
    expect(defaultEntityId).toBeTruthy();
    expect(otherOrgEntityId).toBeTruthy();

    const branchEntity = await o.exec<{ id: string }>(o.owner, 'kernel.legal_entity.create', {
      name: 'Chi nhánh OKR 4676',
      kind: 'branch',
      taxCode: null,
      parentId: defaultEntityId,
    });
    expect(branchEntity.id).not.toBe(defaultEntityId);

    const { departmentId: deptMain } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật Trụ sở',
      payFunction: 'production',
      legalEntityId: defaultEntityId,
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptMain, managerUserId: o.manager });

    const { departmentId: deptBranch } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật Chi nhánh',
      payFunction: 'production',
      legalEntityId: branchEntity.id,
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptBranch, managerUserId: o.manager });

    const empMainActive = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân viên Trụ sở Active',
          legalEntityId: defaultEntityId,
          departmentId: deptMain,
          jobTitle: 'Kỹ sư',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;

    const empMainErased = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân viên Trụ sở Erased',
          legalEntityId: defaultEntityId,
          departmentId: deptMain,
          jobTitle: 'Kỹ sư',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;

    const empBranchActive = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân viên Chi nhánh Active',
          legalEntityId: branchEntity.id,
          departmentId: deptBranch,
          jobTitle: 'Kỹ sư Chi nhánh',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '16000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;

    const existingIndObj = await o.exec<HrOkrObjectiveMutationResult>(o.manager, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'individual',
      ownerEmployeeId: empMainActive,
      title: 'Mục tiêu nhân viên trụ sở',
      activate: true,
    });

    // End and erase empMainErased so erased_at IS NOT NULL and department_id IS NULL.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empMainErased, endedOn: '2026-10-01' }, asMfa(o.owner));
    const backdateClient = await adminPool.connect();
    let backdateCommitted = false;
    let backdateBroken = false;
    try {
      await backdateClient.query('BEGIN');
      await backdateClient.query('SET LOCAL session_replication_role = replica');
      await backdateClient.query(
        `UPDATE ludy_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empMainErased],
      );
      await backdateClient.query('COMMIT');
      backdateCommitted = true;
    } catch (err) {
      if (!backdateCommitted) await backdateClient.query('ROLLBACK').catch(() => { backdateBroken = true; });
      throw err;
    } finally {
      backdateClient.release(backdateBroken);
    }
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empMainErased }, asMfa(o.owner));

    async function withRolledBackTx(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<void>) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => { broken = true; });
        client.release(broken);
      }
    }

    // (a) Raw SQL scope = 'company' insert with nonexistent or cross-org legal_entity_id fails okr_objective_entity_fk.
    for (const badEntityId of [randomUUID(), otherOrgEntityId]) {
      await withRolledBackTx(appPool, async (ownerClient) => {
        await enterUser(ownerClient, o.owner, o.orgId);
        await expect(
          ownerClient.query(
            `INSERT INTO ludy_hr.okr_objective (org_id, legal_entity_id, quarter, scope, title)
             VALUES ($1, $2, '2026-Q4', 'company', 'Invalid legal entity company OKR')`,
            [o.orgId, badEntityId],
          ),
        ).rejects.toMatchObject({ code: '23503', constraint: 'okr_objective_entity_fk' });
      });
    }

    // (b1) L1 department manager raw SQL INSERT targeting either an erased employee OR an active employee
    // in another department fails uniformly BEFORE okr_employee_is_erased (#4679 item 7 / PRRT_kwDOT_fCws67uovu):
    // - with department_id set (passing RLS): uniform department-alignment error (zero erasure oracle)
    // - with department_id omitted: uniform RLS violation
    const { departmentId: deptOtherMain } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh Trụ sở',
      payFunction: 'sales',
      legalEntityId: defaultEntityId,
    });
    const empOtherDeptActive = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân viên Phòng Khác Active',
          legalEntityId: defaultEntityId,
          departmentId: deptOtherMain,
          jobTitle: 'Kinh doanh',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;

    for (const targetEmpId of [empMainErased, empOtherDeptActive]) {
      await withRolledBackTx(appPool, async (mgrClient) => {
        await enterUser(mgrClient, o.manager, o.orgId);
        await expect(
          mgrClient.query(
            `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, department_id, owner_employee_id)
             VALUES ($1, '2026-Q4', 'individual', 'Cross-dept or erased via dept', $2, $3)`,
            [o.orgId, deptMain, targetEmpId],
          ),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/individual objective owner must belong to target department/) });
      });

      await withRolledBackTx(appPool, async (mgrClient) => {
        await enterUser(mgrClient, o.manager, o.orgId);
        await expect(
          mgrClient.query(
            `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
             VALUES ($1, '2026-Q4', 'individual', 'Cross-dept or erased without dept', $2)`,
            [o.orgId, targetEmpId],
          ),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security policy/) });
      });

      // Department-scope objective assigned by L1 manager to erased or out-of-department employee fails identically (#4679 review fix).
      await withRolledBackTx(appPool, async (mgrClient) => {
        await enterUser(mgrClient, o.manager, o.orgId);
        await expect(
          mgrClient.query(
            `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, department_id, owner_employee_id)
             VALUES ($1, '2026-Q4', 'department', 'Dept OKR bad owner', $2, $3)`,
            [o.orgId, deptMain, targetEmpId],
          ),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/department objective owner must belong to target department/) });
      });
    }

    // L1 manager inserting individual objective with department_id of another manager's dept and own dept's employee fails at DB layer.
    await withRolledBackTx(appPool, async (mgrClient) => {
      await enterUser(mgrClient, o.manager, o.orgId);
      await expect(
        mgrClient.query(
          `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, department_id, owner_employee_id)
           VALUES ($1, '2026-Q4', 'individual', 'Cross-dept smuggling', $2, $3)`,
          [o.orgId, deptOtherMain, empMainActive],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/individual objective owner must belong to target department/) });
    });

    // L1 manager creating a department objective with own dept's active employee succeeds, while updating its owner to erased/out-of-dept fails uniformly.
    const existingDeptObj = await o.exec<HrOkrObjectiveMutationResult>(o.manager, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'department',
      departmentId: deptMain,
      ownerEmployeeId: empMainActive,
      title: 'Mục tiêu phòng trụ sở có owner',
      activate: true,
    });
    for (const targetEmpId of [empMainErased, empOtherDeptActive]) {
      await withRolledBackTx(appPool, async (mgrClient) => {
        await enterUser(mgrClient, o.manager, o.orgId);
        await expect(
          mgrClient.query(
            `UPDATE ludy_hr.okr_objective SET owner_employee_id = $1 WHERE org_id = $2 AND id = $3`,
            [targetEmpId, o.orgId, existingDeptObj.objectiveId],
          ),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/department objective owner must belong to target department/) });
      });
    }

    // Owner/admin targeting an erased employee still hits okr_employee_is_erased cleanly.
    await withRolledBackTx(appPool, async (ownerClient) => {
      await enterUser(ownerClient, o.owner, o.orgId);
      await expect(
        ownerClient.query(
          `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, department_id, owner_employee_id)
           VALUES ($1, '2026-Q4', 'individual', 'Owner erased blocked', $2, $3)`,
          [o.orgId, deptMain, empMainErased],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/cannot assign objective to erased employee/) });
    });

    // (b2) L1 department manager raw SQL UPDATE targeting an erased or out-of-department employee fails uniformly,
    // and clearing owner_employee_id on an active individual objective is also refused.
    for (const targetEmpId of [empMainErased, empOtherDeptActive]) {
      await withRolledBackTx(appPool, async (mgrClient) => {
        await enterUser(mgrClient, o.manager, o.orgId);
        await expect(
          mgrClient.query(
            `UPDATE ludy_hr.okr_objective SET owner_employee_id = $1 WHERE org_id = $2 AND id = $3`,
            [targetEmpId, o.orgId, existingIndObj.objectiveId],
          ),
        ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/individual objective owner must belong to target department/) });
      });
    }

    await withRolledBackTx(appPool, async (mgrClient) => {
      await enterUser(mgrClient, o.manager, o.orgId);
      await expect(
        mgrClient.query(
          `UPDATE ludy_hr.okr_objective SET department_id = $1 WHERE org_id = $2 AND id = $3`,
          [deptOtherMain, o.orgId, existingIndObj.objectiveId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/individual objective owner must belong to target department/) });
    });

    await withRolledBackTx(appPool, async (mgrClient) => {
      await enterUser(mgrClient, o.manager, o.orgId);
      await expect(
        mgrClient.query(
          `UPDATE ludy_hr.okr_objective SET owner_employee_id = NULL WHERE org_id = $1 AND id = $2`,
          [o.orgId, existingIndObj.objectiveId],
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/individual objective requires owner_employee_id until employee erasure/),
      });
    });

    // (b3) L1 department manager raw SQL INSERT with legal_entity_id IS NULL and department_id IS NULL
    // derives the employee's actual non-default legal_entity_id via SECURITY DEFINER helper instead of falling back to default.
    await withRolledBackTx(appPool, async (mgrClient) => {
      await enterUser(mgrClient, o.manager, o.orgId);
      const inserted = await mgrClient.query<{ id: string; legal_entity_id: string }>(
        `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
         VALUES ($1, '2026-Q4', 'individual', 'Raw SQL derived branch LE', $2)
         RETURNING id, legal_entity_id`,
        [o.orgId, empBranchActive],
      );
      expect(inserted.rows[0]?.legal_entity_id).toBe(branchEntity.id);
      expect(inserted.rows[0]?.legal_entity_id).not.toBe(defaultEntityId);

      // Direct top-level calls outside a trigger yield NULL / false (no direct-call oracle).
      const directEntity = await mgrClient.query<{ le: string | null }>(
        `SELECT ludy_hr.okr_employee_legal_entity_id($1::uuid, $2::uuid) AS le`,
        [o.orgId, empBranchActive],
      );
      expect(directEntity.rows[0]?.le).toBeNull();
      const directErased = await mgrClient.query<{ erased: boolean }>(
        `SELECT ludy_hr.okr_employee_is_erased($1::uuid, $2::uuid) AS erased`,
        [o.orgId, empMainErased],
      );
      expect(directErased.rows[0]?.erased).toBe(false);
      const directDeptCheck = await mgrClient.query<{ ok1: boolean; ok2: boolean }>(
        `SELECT ludy_hr.okr_employee_in_department($1::uuid, $2::uuid, $3::uuid) AS ok1,
                ludy_hr.okr_department_owner_allowed($1::uuid, $2::uuid, $3::uuid) AS ok2`,
        [o.orgId, deptMain, empMainActive],
      );
      expect(directDeptCheck.rows[0]).toEqual({ ok1: false, ok2: false });
    });

    // Non-manager member (staffB) probing an erased employee hits RLS rather than the erasure guard (no side-channel oracle).
    await withRolledBackTx(appPool, async (unlinkedClient) => {
      await enterUser(unlinkedClient, o.staffB, o.orgId);
      await expect(
        unlinkedClient.query(
          `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
           VALUES ($1, '2026-Q4', 'individual', 'Unlinked probe erased', $2)`,
          [o.orgId, empMainErased],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security policy/) });
    });

    // Manager of branchEntity only (otherMgr) probing an erased employee in defaultEntityId hits RLS, not trigger oracle.
    const { departmentId: deptBranchOnly } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh Chi nhánh',
      payFunction: 'sales',
      legalEntityId: branchEntity.id,
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptBranchOnly, managerUserId: o.otherMgr });
    await withRolledBackTx(appPool, async (crossLeMgr) => {
      await enterUser(crossLeMgr, o.otherMgr, o.orgId);
      await expect(
        crossLeMgr.query(
          `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
           VALUES ($1, '2026-Q4', 'individual', 'Cross-LE manager probe erased', $2)`,
          [o.orgId, empMainErased],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security policy/) });
    });

    // (c) Superuser / table-owner writes outside user context keep branch-LE auto-fill, erased-employee rejection,
    // and PDPL owner_employee_id = NULL cleanup on an already-erased employee's individual objective.
    await withRolledBackTx(adminPool, async (suClient) => {
      const suBranchInsert = await suClient.query<{ id: string; legal_entity_id: string }>(
        `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
         VALUES ($1, '2026-Q4', 'individual', 'Superuser branch LE fill', $2)
         RETURNING id, legal_entity_id`,
        [o.orgId, empBranchActive],
      );
      expect(suBranchInsert.rows[0]?.legal_entity_id).toBe(branchEntity.id);
    });

    await withRolledBackTx(adminPool, async (suClient) => {
      await expect(
        suClient.query(
          `INSERT INTO ludy_hr.okr_objective (org_id, quarter, scope, title, owner_employee_id)
           VALUES ($1, '2026-Q4', 'individual', 'Superuser erased blocked', $2)`,
          [o.orgId, empMainErased],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/cannot assign objective to erased employee/) });
    });

    await withRolledBackTx(adminPool, async (suClient) => {
      await suClient.query('SET LOCAL session_replication_role = replica');
      await suClient.query(
        `UPDATE ludy_hr.payroll_employee
            SET status = 'ended',
                ended_on = '2015-01-01',
                erased_at = pg_catalog.now()
          WHERE org_id = $1 AND id = $2`,
        [o.orgId, empMainActive],
      );
      const cleared = await suClient.query<{ owner_employee_id: string | null }>(
        `UPDATE ludy_hr.okr_objective
            SET owner_employee_id = NULL, status = 'archived'
          WHERE org_id = $1 AND id = $2
          RETURNING owner_employee_id`,
        [o.orgId, existingIndObj.objectiveId],
      );
      expect(cleared.rows[0]?.owner_employee_id).toBeNull();
    });

    // Verify helper SECURITY DEFINER metadata, pinned search_path, and minimal EXECUTE grants (ludy_tenant only).
    for (const fn of [
      'ludy_hr.okr_employee_legal_entity_id(uuid,uuid)',
      'ludy_hr.okr_employee_is_erased(uuid,uuid)',
      'ludy_hr.okr_employee_in_department(uuid,uuid,uuid)',
      'ludy_hr.okr_department_owner_allowed(uuid,uuid,uuid)',
    ]) {
      const meta = (
        await adminPool.query<{
          prosecdef: boolean;
          proconfig: string[];
          pub_exec: boolean;
          auth_reader_exec: boolean;
          tenant_exec: boolean;
          direct_grantees: string[];
        }>(
          `SELECT p.prosecdef,
                  p.proconfig,
                  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
                  pg_catalog.has_function_privilege('ludy_auth_reader', p.oid, 'EXECUTE') AS auth_reader_exec,
                  pg_catalog.has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS tenant_exec,
                  ARRAY(
                    SELECT r.rolname::text
                      FROM pg_catalog.aclexplode(p.proacl) a
                      JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
                     WHERE a.grantee <> p.proowner
                     ORDER BY 1
                  ) AS direct_grantees
             FROM pg_catalog.pg_proc p
            WHERE p.oid = $1::pg_catalog.regprocedure`,
          [fn],
        )
      ).rows[0];
      expect(meta).toEqual({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        pub_exec: false,
        auth_reader_exec: false,
        tenant_exec: true,
        direct_grantees: ['ludy_tenant'],
      });
    }

    // Verify trigger functions stay SECURITY INVOKER with pinned search_path and zero runtime EXECUTE grants.
    for (const fn of [
      'ludy_hr.okr_objective_legal_entity_fill()',
      'ludy_hr.okr_objective_write_guard()',
      'ludy_hr.okr_key_result_write_guard()',
    ]) {
      const meta = (
        await adminPool.query<{
          prosecdef: boolean;
          proconfig: string[];
          pub_exec: boolean;
          tenant_exec: boolean;
        }>(
          `SELECT p.prosecdef,
                  p.proconfig,
                  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
                  pg_catalog.has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS tenant_exec
             FROM pg_catalog.pg_proc p
            WHERE p.oid = $1::pg_catalog.regprocedure`,
          [fn],
        )
      ).rows[0];
      expect(meta).toEqual({
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        pub_exec: false,
        tenant_exec: false,
      });
    }
  });

  it('covers Stage 6D review follow-ups: KR link validation, sync_projects note omission, transfer parity, picker pagination, batched snapshots, and last_checkin_by DB guard (#4679)', async () => {
    const o = await setupOrg();

    const { departmentId: deptTech } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật 4679',
      payFunction: 'production',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.manager });

    const { departmentId: deptSales } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh 4679',
      payFunction: 'sales',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptSales, managerUserId: o.otherMgr });

    const empId = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Lê Minh C',
          departmentId: deptTech,
          jobTitle: 'Kỹ sư',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empId, userId: o.staffA }, asMfa(o.owner));

    // Create 3 active projects + 1 archived project + 1 private project hidden from manager.
    const { projectId: projA } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', { name: 'Alpha CRM', visibility: 'org' });
    const { projectId: projB } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', { name: 'Alpha ERP', visibility: 'org' });
    const { projectId: projC } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', { name: 'Beta Portal', visibility: 'org' });
    const { projectId: projArchived } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', { name: 'Legacy Archived', visibility: 'org' });
    await o.exec(o.owner, 'projects.project.archive', { projectId: projArchived });
    const { projectId: projPriv } = await o.exec<{ projectId: string }>(o.staffA, 'projects.project.create', {
      name: 'Alpha Private',
      visibility: 'private',
      memberUserIds: [],
    });

    const { taskId: taskA1 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', { projectId: projA, title: 'Task A1', assigneePositionId: null, status: 'done' });
    const { taskId: taskA2 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', { projectId: projA, title: 'Task A2', assigneePositionId: null, status: 'todo' });
    const { taskId: taskB1 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', { projectId: projB, title: 'Task B1', assigneePositionId: null, status: 'done' });

    // Item 4: project_options pagination + search + includeArchived filter.
    const page1 = await o.query<HrOkrProjectOptionsResult>(o.manager, 'hr.okr.project_options', { limit: 2 });
    expect(page1.projects).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.projects.some((p) => p.id === projArchived)).toBe(false);

    const page2 = await o.query<HrOkrProjectOptionsResult>(o.manager, 'hr.okr.project_options', {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.projects).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    const combinedIds = [...page1.projects, ...page2.projects].map((p) => p.id).sort();
    expect(combinedIds).toEqual([projA, projB, projC].sort());

    const searched = await o.query<HrOkrProjectOptionsResult>(o.manager, 'hr.okr.project_options', { search: 'Alpha' });
    expect(searched.projects.map((p) => p.id).sort()).toEqual([projA, projB].sort());
    expect(searched.projects.some((p) => p.id === projPriv)).toBe(false);

    const withArchived = await o.query<HrOkrProjectOptionsResult>(o.manager, 'hr.okr.project_options', {
      includeArchived: true,
      search: 'Legacy',
    });
    expect(withArchived.projects.map((p) => p.id)).toEqual([projArchived]);

    // Item 1: hr.okr.kr.update rejects stray linkedTaskIds when nextLinkedProjectId === null.
    const indObj = await o.exec<HrOkrObjectiveMutationResult>(o.manager, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'individual',
      ownerEmployeeId: empId,
      title: 'Mục tiêu nhân viên C',
      activate: true,
    });
    const manualKr = await o.exec<HrOkrKeyResultMutationResult>(o.manager, 'hr.okr.kr.add', {
      objectiveId: indObj.objectiveId,
      title: 'KR thủ công ban đầu',
      metricType: 'number',
      targetValue: '10',
    });
    await expect(
      o.exec(o.manager, 'hr.okr.kr.update', { keyResultId: manualKr.keyResultId, linkedTaskIds: [taskA1] }),
    ).rejects.toMatchObject({ code: 'HR_OKR_PROJECT_REQUIRED', status: 422 });

    await o.exec(o.manager, 'hr.okr.kr.update', {
      keyResultId: manualKr.keyResultId,
      metricType: 'project_tasks',
      linkedProjectId: projA,
      linkedTaskIds: [taskA1, taskA2],
    });
    await expect(
      o.exec(o.manager, 'hr.okr.kr.update', {
        keyResultId: manualKr.keyResultId,
        linkedProjectId: null,
        linkedTaskIds: [taskA1],
      }),
    ).rejects.toMatchObject({ code: 'HR_OKR_PROJECT_REQUIRED', status: 422 });

    // Explicit linkedProjectId: null clears linkedTaskIds: [] cleanly.
    await o.exec(o.manager, 'hr.okr.kr.update', {
      keyResultId: manualKr.keyResultId,
      metricType: 'number',
      targetValue: '10',
      linkedProjectId: null,
    });
    const afterUnlink = (
      await adminPool.query<{ linked_project_id: string | null; linked_task_ids: string[] }>(
        `SELECT linked_project_id, linked_task_ids FROM ludy_hr.okr_key_result WHERE id = $1`,
        [manualKr.keyResultId],
      )
    ).rows[0];
    expect(afterUnlink).toEqual({ linked_project_id: null, linked_task_ids: [] });

    // Item 2 & Item 9/10 batching: link two KRs to two distinct projects, check in with note, then sync_projects.
    await o.exec(o.manager, 'hr.okr.kr.update', {
      keyResultId: manualKr.keyResultId,
      metricType: 'project_tasks',
      linkedProjectId: projA,
      linkedTaskIds: [taskA1, taskA2],
    });
    const krB = await o.exec<HrOkrKeyResultMutationResult>(o.manager, 'hr.okr.kr.add', {
      objectiveId: indObj.objectiveId,
      title: 'KR dự án B',
      metricType: 'project_tasks',
      linkedProjectId: projB,
      linkedTaskIds: [taskB1],
    });
    await o.exec(o.staffA, 'hr.okr.kr.checkin', {
      keyResultId: manualKr.keyResultId,
      syncFromProjects: true,
      note: 'Giữ nguyên ghi chú này khi sync_projects',
    });
    await o.exec(o.owner, 'kernel.task.set_status', { id: taskA2, status: 'done' });
    const synced = await o.exec<HrOkrKeyResultMutationResult>(o.staffA, 'hr.okr.kr.sync_projects', {
      keyResultId: manualKr.keyResultId,
    });
    expect(synced.currentValue).toBe('2');
    expect(synced.progressPct).toBe('100');

    const treeMulti = await o.query<HrOkrTreeResult>(o.manager, 'hr.okr.tree', { quarter: '2026-Q4' });
    const krs = treeMulti.objectives.find((x) => x.id === indObj.objectiveId)?.keyResults ?? [];
    expect(krs.find((k) => k.id === manualKr.keyResultId)?.lastCheckinNote).toBe('Giữ nguyên ghi chú này khi sync_projects');
    expect(krs.find((k) => k.id === manualKr.keyResultId)?.linkedProjectName).toBe('Alpha CRM');
    expect(krs.find((k) => k.id === krB.keyResultId)?.linkedProjectName).toBe('Alpha ERP');

    // Item 8: last_checkin_by DB guard rejects spoofed user IDs / viewer / invalid member on INSERT and UPDATE,
    // while allowing NULL on superuser maintenance.
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, o.manager, o.orgId);
      await expect(
        c.query(
          `INSERT INTO ludy_hr.okr_key_result (org_id, objective_id, title, metric_type, target_value, last_checkin_by)
           VALUES ($1, $2, 'Spoof insert', 'percent', 100, $3)`,
          [o.orgId, indObj.objectiveId, o.staffA],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/last_checkin_by must match current user/) });
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await enterUser(c, o.manager, o.orgId);
      await expect(
        c.query(
          `UPDATE ludy_hr.okr_key_result SET last_checkin_by = $1 WHERE org_id = $2 AND id = $3`,
          [o.staffA, o.orgId, krB.keyResultId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/last_checkin_by must match current user/) });
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await enterUser(c, o.staffA, o.orgId);
      await expect(
        c.query(
          `UPDATE ludy_hr.okr_key_result SET last_checkin_by = NULL, current_value = 1 WHERE org_id = $1 AND id = $2`,
          [o.orgId, manualKr.keyResultId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/last_checkin_by must match current user/) });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }

    const su = await adminPool.connect();
    try {
      await su.query('BEGIN');
      await expect(
        su.query(
          `UPDATE ludy_hr.okr_key_result SET last_checkin_by = $1 WHERE org_id = $2 AND id = $3`,
          [o.viewer, o.orgId, manualKr.keyResultId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/last_checkin_by must be an active org member/) });
      await su.query('ROLLBACK');

      await su.query('BEGIN');
      const clearedCheckin = await su.query<{ last_checkin_by: string | null }>(
        `UPDATE ludy_hr.okr_key_result SET last_checkin_by = NULL WHERE org_id = $1 AND id = $2 RETURNING last_checkin_by`,
        [o.orgId, manualKr.keyResultId],
      );
      expect(clearedCheckin.rows[0]?.last_checkin_by).toBeNull();
      await su.query('ROLLBACK');
    } finally {
      su.release();
    }

    // Item 3 & 7: Mid-quarter transfer moves empId to deptSales -> old manager blocked at DB, new manager must align departmentId.
    await o.exec(
      o.owner,
      'hr.payroll.employee.edit',
      { employeeId: empId, departmentId: deptSales },
      asMfa(o.owner),
    );
    const oldMgrSql = await appPool.connect();
    try {
      await oldMgrSql.query('BEGIN');
      await enterUser(oldMgrSql, o.manager, o.orgId);
      await expect(
        oldMgrSql.query(`UPDATE ludy_hr.okr_objective SET title = 'Old mgr tamper' WHERE org_id = $1 AND id = $2`, [o.orgId, indObj.objectiveId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/individual objective owner must belong to target department/) });
      await oldMgrSql.query('ROLLBACK');
    } finally {
      oldMgrSql.release();
    }

    await expect(
      o.exec(o.owner, 'hr.okr.objective.update', { objectiveId: indObj.objectiveId, title: 'Chưa đổi phòng ban' }),
    ).rejects.toMatchObject({ code: 'HR_OKR_DEPT_MISMATCH', status: 409 });

    await expect(
      o.exec(o.otherMgr, 'hr.okr.objective.update', { objectiveId: indObj.objectiveId, title: 'Chưa đổi phòng ban' }),
    ).rejects.toMatchObject({ code: 'HR_DEPARTMENT_NOT_FOUND', status: 404 });

    await o.exec(o.otherMgr, 'hr.okr.objective.update', {
      objectiveId: indObj.objectiveId,
      departmentId: deptSales,
      title: 'Đã chuyển sang phòng Kinh doanh',
    });

    // Item 6 extended: PDPL-erased individual objective (even if pre-erasure status was completed) cannot be edited or reassigned.
    const empEraseComp = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân viên Hoàn thành rồi Xóa',
          departmentId: deptSales,
          jobTitle: 'Kinh doanh',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const compObj = await o.exec<HrOkrObjectiveMutationResult>(o.owner, 'hr.okr.objective.create', {
      quarter: '2026-Q4',
      scope: 'individual',
      ownerEmployeeId: empEraseComp,
      title: 'Mục tiêu đã hoàn thành',
      activate: true,
    });
    await o.exec(o.owner, 'hr.okr.objective.set_status', { objectiveId: compObj.objectiveId, status: 'completed' });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empEraseComp, endedOn: '2026-10-01' }, asMfa(o.owner));
    const eraseBackdate = await adminPool.connect();
    let eraseCommitted = false;
    let eraseBroken = false;
    try {
      await eraseBackdate.query('BEGIN');
      await eraseBackdate.query('SET LOCAL session_replication_role = replica');
      await eraseBackdate.query(
        `UPDATE ludy_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empEraseComp],
      );
      await eraseBackdate.query('COMMIT');
      eraseCommitted = true;
    } catch (err) {
      if (!eraseCommitted) await eraseBackdate.query('ROLLBACK').catch(() => { eraseBroken = true; });
      throw err;
    } finally {
      eraseBackdate.release(eraseBroken);
    }
    // Completed individual objectives stay completed with owner_employee_id = NULL after erase and cannot be edited, reopened, or reassigned.
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empEraseComp }, asMfa(o.owner));
    await expect(
      o.exec(o.owner, 'hr.okr.objective.update', {
        objectiveId: compObj.objectiveId,
        ownerEmployeeId: empId,
        title: 'Gán lại chủ mới cho mục tiêu đã xóa',
      }),
    ).rejects.toMatchObject({ code: 'HR_OKR_OWNER_ERASED', status: 409 });
    await expect(
      o.exec(o.owner, 'hr.okr.objective.set_status', {
        objectiveId: compObj.objectiveId,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'HR_OKR_OWNER_ERASED', status: 409 });

    const suReassign = await adminPool.connect();
    let suReassignBroken = false;
    try {
      await suReassign.query('BEGIN');
      await expect(
        suReassign.query(
          `UPDATE ludy_hr.okr_objective SET status = 'active', owner_employee_id = $1 WHERE org_id = $2 AND id = $3`,
          [empId, o.orgId, compObj.objectiveId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/cannot reassign erased individual objective/) });
      await suReassign.query('ROLLBACK');

      await suReassign.query('BEGIN');
      await expect(
        suReassign.query(
          `UPDATE ludy_hr.okr_objective SET status = 'active' WHERE org_id = $1 AND id = $2`,
          [o.orgId, compObj.objectiveId],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/cannot reopen erased individual objective/) });
    } finally {
      await suReassign.query('ROLLBACK').catch(() => { suReassignBroken = true; });
      suReassign.release(suReassignBroken);
    }

    // Archiving a completed erased objective remains permitted.
    await o.exec(o.owner, 'hr.okr.objective.set_status', {
      objectiveId: compObj.objectiveId,
      status: 'archived',
    });
  });
});
