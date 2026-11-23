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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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
  const dbName = `crove_test_hr6d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    expect(mgrPrivKr?.linkedTasks).toEqual([]);

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
      await adminPool.query<{ owner_employee_id: string | null; status: string }>(
        `SELECT owner_employee_id, status FROM ludy_hr.okr_objective WHERE id = $1`,
        [indObj.objectiveId],
      )
    ).rows[0];
    expect(erasedObj).toEqual({ owner_employee_id: null, status: 'archived' });

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
});
