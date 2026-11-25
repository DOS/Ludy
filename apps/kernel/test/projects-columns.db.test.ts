// SPDX-License-Identifier: AGPL-3.0-only
// Projects v2 Wave 1 (#2605, docs/plan/projects-v2.md section 4.2, ADR-0056): custom board columns per project
// mapped to canonical ludy_kernel.task.status on a real PostgreSQL 17 instance:
// 1) Zero-setup behavior matches v1 when 0 project_column rows exist.
// 2) Opt-in init_defaults creates 5 editable columns, maps existing tasks, and is idempotent.
// 3) Create, update, reorder, delete (with required fallbackColumnId + todo/done retention + max 12 guard), and soft WIP counts.
// 4) projects.task.move_column updates column_id + task.status + sort_key atomically and preserves TASK_CHECKED_OUT lease refusal.
// 5) Direct agent task.status updates without changing column_id resolve deterministically on board and weekly-status reads.
// 6) Cross-org isolation, agent context refusal on project commands, PDPL find/erase of column names, and org_purge order.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  EXPORT_TABLE_NAMES,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import type {
  PersonalDataErasure,
  PersonalDataResult,
  ProjectBoard,
  ProjectColumnDeleteResult,
  ProjectColumnInitDefaultsResult,
  ProjectColumnMutateResult,
  ProjectColumnReorderResult,
  ProjectTaskMoveColumnResult,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries, type ProjectWeeklyStatusSource } from '@ludy/mod-projects';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'ludy-auth';
const DAY = 24 * 60 * 60 * 1000;
const SYSTEM = { type: 'system' as const, component: 'test' };
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

suite('projects custom board columns (#2605)', () => {
  const dbName = `ludy_test_proj_cols_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  const store = new MemoryStore();
  const exportKeyBytes = randomBytes(32);
  const sealer = new ExportSealer(exportKeyBytes);

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function newPerson(tag: string) {
    const subject = randomUUID();
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects-cols.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    rt.query<T>(name, input, { actor: asUser(userId), orgId });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'ludy_worker';
    wUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: wUrl.toString(), max: 2 });
    db = createDb(pool);

    const rtOpts = { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const };
    rt = new Runtime(db, rtOpts).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('preserves v1 zero-setup behavior, opts into 5 editable columns atomically, and enforces CRUD/reorder/delete/WIP rules', async () => {
    const owner = await newPerson('cols-owner');
    const member = await newPerson('cols-member');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Cột Tùy Chỉnh');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: member.email, role: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(member.userId) });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Ra mắt sản phẩm Q4',
    });

    const { taskId: tTodo } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Lên kế hoạch',
      assigneePositionId: null,
      status: 'todo',
    });
    const { taskId: tProg } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Thiết kế giao diện',
      assigneePositionId: null,
      status: 'in_progress',
    });

    // Unconfigured project behaves identically to v1: columns=[], task.columnId=null.
    const boardV1 = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardV1.columns).toEqual([]);
    expect(boardV1.tasks.map((t) => t.columnId)).toEqual([null, null]);

    // Non-manager member cannot mutate column schema (but can still move tasks once enabled).
    await expect(
      exec(member.userId, org.orgId, 'projects.column.init_defaults', { projectId, language: 'vi' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Cannot create custom columns before defaults initialize (keeps >=1 todo and >=1 done invariant).
    await expect(
      exec(owner.userId, org.orgId, 'projects.column.create', {
        projectId,
        name: 'QA',
        taskStatus: 'in_review',
      }),
    ).rejects.toMatchObject({ code: 'COLUMN_STATUS_REQUIRED', status: 409 });

    // Opt-in init_defaults creates 5 editable columns and backfills existing tasks.
    const init1 = await exec<ProjectColumnInitDefaultsResult>(owner.userId, org.orgId, 'projects.column.init_defaults', {
      projectId,
      language: 'vi',
    });
    expect(init1.initialized).toBe(true);
    expect(init1.columns.map((c) => c.taskStatus)).toEqual(['todo', 'in_progress', 'waiting', 'in_review', 'done']);

    const init2 = await exec<ProjectColumnInitDefaultsResult>(owner.userId, org.orgId, 'projects.column.init_defaults', {
      projectId,
      language: 'vi',
    });
    expect(init2.initialized).toBe(false);
    expect(init2.columns).toHaveLength(5);

    const boardInit = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    const todoCol = init1.columns.find((c) => c.taskStatus === 'todo')!;
    const progCol = init1.columns.find((c) => c.taskStatus === 'in_progress')!;
    const reviewCol = init1.columns.find((c) => c.taskStatus === 'in_review')!;
    const doneCol = init1.columns.find((c) => c.taskStatus === 'done')!;
    expect(boardInit.tasks.find((t) => t.id === tTodo)?.columnId).toBe(todoCol.id);
    expect(boardInit.tasks.find((t) => t.id === tProg)?.columnId).toBe(progCol.id);

    // Create a second 'in_progress' column with WIP limit = 1 and custom semantic color, placed after progCol.
    const createdQa = await exec<ProjectColumnMutateResult>(owner.userId, org.orgId, 'projects.column.create', {
      projectId,
      name: 'Kiểm thử nội bộ 2',
      taskStatus: 'in_progress',
      color: 'warning',
      wipLimit: 1,
      place: 'after',
      anchorId: progCol.id,
    });
    const qaCol = createdQa.column;
    expect(qaCol.taskStatus).toBe('in_progress');
    expect(qaCol.color).toBe('warning');
    expect(qaCol.wipLimit).toBe(1);

    // Create a task directly in qaCol; mismatched status/columnId is rejected.
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.create', {
        projectId,
        title: 'Sai trạng thái',
        assigneePositionId: null,
        columnId: qaCol.id,
        status: 'done',
      }),
    ).rejects.toMatchObject({ code: 'COLUMN_STATUS_MISMATCH', status: 400 });

    const { taskId: tQa1 } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Kiểm tra tích hợp',
      assigneePositionId: null,
      columnId: qaCol.id,
    });

    // Soft WIP limit allows moving a second card into qaCol (member can move cards); updates task_status & sort_key too.
    const moved = await exec<ProjectTaskMoveColumnResult>(member.userId, org.orgId, 'projects.task.move_column', {
      projectId,
      taskId: tTodo,
      columnId: qaCol.id,
      place: 'before',
      anchorId: tQa1,
    });
    expect(moved).toEqual({
      projectId,
      taskId: tTodo,
      columnId: qaCol.id,
      status: 'in_progress',
    });

    // Weekly status includes custom column counts & WIP limits deterministically.
    const weekly = await query<ProjectWeeklyStatusSource>(owner.userId, org.orgId, 'projects.weekly_status_source', {
      projectId,
    });
    expect(weekly.columns?.find((c) => c.id === qaCol.id)).toMatchObject({
      name: 'Kiểm thử nội bộ 2',
      taskStatus: 'in_progress',
      wipLimit: 1,
      taskCount: 2,
    });

    // Reorder qaCol after reviewCol and update its name/color/WIP.
    const reordered = await exec<ProjectColumnReorderResult>(owner.userId, org.orgId, 'projects.column.reorder', {
      projectId,
      columnId: qaCol.id,
      place: 'after',
      anchorId: reviewCol.id,
    });
    const reorderedIds = reordered.columns.map((c) => c.id);
    expect(reorderedIds.indexOf(qaCol.id)).toBe(reorderedIds.indexOf(reviewCol.id) + 1);

    const updated = await exec<ProjectColumnMutateResult>(owner.userId, org.orgId, 'projects.column.update', {
      projectId,
      columnId: qaCol.id,
      name: 'Kiểm thử giai đoạn 2',
      color: 'proposal',
      wipLimit: 2,
    });
    expect(updated.column.name).toBe('Kiểm thử giai đoạn 2');
    expect(updated.column.color).toBe('proposal');
    expect(updated.column.wipLimit).toBe(2);

    // Deleting or changing status away from the sole todo/done column is refused with COLUMN_STATUS_REQUIRED.
    await expect(
      exec(owner.userId, org.orgId, 'projects.column.update', {
        projectId,
        columnId: todoCol.id,
        taskStatus: 'waiting',
      }),
    ).rejects.toMatchObject({ code: 'COLUMN_STATUS_REQUIRED', status: 409 });

    await expect(
      exec(owner.userId, org.orgId, 'projects.column.delete', {
        projectId,
        columnId: doneCol.id,
        fallbackColumnId: todoCol.id,
      }),
    ).rejects.toMatchObject({ code: 'COLUMN_STATUS_REQUIRED', status: 409 });

    // Deleting qaCol with a different-status fallback (todoCol) migrates both column_id and kernel.task.status cleanly.
    const deleted = await exec<ProjectColumnDeleteResult>(owner.userId, org.orgId, 'projects.column.delete', {
      projectId,
      columnId: qaCol.id,
      fallbackColumnId: todoCol.id,
    });
    expect(deleted.columns.some((c) => c.id === qaCol.id)).toBe(false);

    const boardAfterDelete = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardAfterDelete.tasks.find((t) => t.id === tTodo)).toMatchObject({ columnId: todoCol.id, status: 'todo' });
    expect(boardAfterDelete.tasks.find((t) => t.id === tQa1)).toMatchObject({ columnId: todoCol.id, status: 'todo' });

    // Max 12 columns enforced (currently 5 columns remain -> add 7 more -> 13th throws PROJECT_COLUMNS_MAX).
    for (let i = 0; i < 7; i++) {
      await exec(owner.userId, org.orgId, 'projects.column.create', {
        projectId,
        name: `Cột mở rộng ${i + 1}`,
        taskStatus: 'in_progress',
      });
    }
    await expect(
      exec(owner.userId, org.orgId, 'projects.column.create', {
        projectId,
        name: 'Cột thứ 13',
        taskStatus: 'in_progress',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_COLUMNS_MAX', status: 409 });
  });

  it('enforces TASK_CHECKED_OUT lease on move_column/delete and falls back deterministically when an agent sets task.status directly', async () => {
    const owner = await newPerson('lease-cols-owner');
    const orgB = await createOrg(rt, asUser(owner.userId), 'Other Isolation Org');
    const org = await createOrg(rt, asUser(owner.userId), 'Agent Column Co');

    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án tác tử',
    });
    const init = await exec<ProjectColumnInitDefaultsResult>(owner.userId, org.orgId, 'projects.column.init_defaults', {
      projectId,
      language: 'vi',
    });
    const todoCol = init.columns.find((c) => c.taskStatus === 'todo')!;
    const progCol = init.columns.find((c) => c.taskStatus === 'in_progress')!;
    const reviewCol = init.columns.find((c) => c.taskStatus === 'in_review')!;

    const { taskId: agentTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Đối soát công nợ AI',
      assigneePositionId: installed.positionId,
      columnId: todoCol.id,
    });

    // Extra in_progress column that holds the checked-out task once we move it before checkout.
    const extraColRes = await exec<ProjectColumnMutateResult>(owner.userId, org.orgId, 'projects.column.create', {
      projectId,
      name: 'Đang kiểm AI',
      taskStatus: 'in_progress',
    });
    await exec(owner.userId, org.orgId, 'projects.task.move_column', {
      projectId,
      taskId: agentTaskId,
      columnId: extraColRes.column.id,
    });

    // Start agent run & acquire task checkout lease.
    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId: org.orgId },
    );
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };
    const checkedOut = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: agentTaskId },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Human move_column refuses with TASK_CHECKED_OUT while lease is live.
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.move_column', {
        projectId,
        taskId: agentTaskId,
        columnId: progCol.id,
      }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    // Deleting the column into a different-status fallback also refuses with TASK_CHECKED_OUT without deleting or mutating.
    await expect(
      exec(owner.userId, org.orgId, 'projects.column.delete', {
        projectId,
        columnId: extraColRes.column.id,
        fallbackColumnId: reviewCol.id,
      }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    // Org-chart agent completes its task by updating task.status directly ('in_review'), releasing its lease.
    await workerRt.execute(
      'kernel.task.set_status',
      { id: agentTaskId, status: 'in_review', fence: checkedOut.fence },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Board and weekly-status read deterministically resolves stale column_id (still extraColRes.column.id in DB) to reviewCol!
    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(board.tasks.find((t) => t.id === agentTaskId)).toMatchObject({
      status: 'in_review',
      columnId: reviewCol.id,
    });
    const weekly = await query<ProjectWeeklyStatusSource>(owner.userId, org.orgId, 'projects.weekly_status_source', { projectId });
    expect(weekly.columns?.find((c) => c.id === reviewCol.id)?.taskCount).toBe(1);
    expect(weekly.columns?.find((c) => c.id === extraColRes.column.id)?.taskCount).toBe(0);

    // Deleting the apparently empty extra column with a different-status fallback (todoCol) must NOT revert
    // agentTaskId back to todo and must reset its stale project_task.column_id to NULL so reads keep resolving reviewCol.
    await exec(owner.userId, org.orgId, 'projects.column.delete', {
      projectId,
      columnId: extraColRes.column.id,
      fallbackColumnId: todoCol.id,
    });
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ column_id: string | null }>(
        'SELECT column_id FROM ludy_projects.project_task WHERE org_id = $1 AND project_id = $2 AND task_id = $3',
        [org.orgId, projectId, agentTaskId],
      );
      expect(rows[0]?.column_id).toBeNull();
    });
    const boardAfterDelete = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardAfterDelete.tasks.find((t) => t.id === agentTaskId)).toMatchObject({
      status: 'in_review',
      columnId: reviewCol.id,
    });

    // Cross-org isolation: orgB cannot see or mutate org's columns; agent actor cannot call column commands.
    await expect(
      exec(owner.userId, orgB.orgId, 'projects.column.init_defaults', { projectId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      rt.execute('projects.column.init_defaults', { projectId }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('supports export, PDPL personal-data find/erase on column names, and clean org_purge ordering', async () => {
    const owner = await newPerson('pdpl-cols-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'PDPL Columns Co');

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Hồ sơ giao nhận',
    });
    const init = await exec<ProjectColumnInitDefaultsResult>(owner.userId, org.orgId, 'projects.column.init_defaults', {
      projectId,
      language: 'vi',
    });
    const todoCol = init.columns.find((c) => c.taskStatus === 'todo')!;

    const { column: piiCol } = await exec<ProjectColumnMutateResult>(owner.userId, org.orgId, 'projects.column.create', {
      projectId,
      name: 'Duyệt bởi 0901234567',
      taskStatus: 'in_review',
    });
    await exec(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Kiểm tra bước này',
      assigneePositionId: null,
      columnId: piiCol.id,
    });

    // PDPL find and erase redacts ludy_projects.project_column.name.
    const found = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: '0901234567' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(found.matches.some((m) => m.column === 'ludy_projects.project_column.name' && m.rowId === piiCol.id)).toBe(true);

    const erased = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '0901234567' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.find((e) => e.column === 'ludy_projects.project_column.name')?.rows).toBe(1);

    const boardAfterErase = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardAfterErase.columns?.find((c) => c.id === piiCol.id)?.name).toContain('[đã xóa]');

    // Export + org_purge removes project_task and project_column before project without FK violations.
    expect(EXPORT_TABLE_NAMES).toContain('projects.project_column');
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exp = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, org.orgId, { now: () => generatedAt });
    const colPart = exp.parts.find((p) => p.table === 'projects.project_column');
    expect(colPart).toBeDefined();
    const lines = new TextDecoder()
      .decode(sealer.open(await store.get(colPart!.key), exportAad(org.orgId, colPart!), 'aes-256-gcm'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((r) => r.id === piiCol.id)).toBe(true);
    expect(lines.some((r) => r.id === todoCol.id)).toBe(true);

    await rt.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.userId), orgId: org.orgId });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event
            SET occurred_at = $1
          WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), org.orgId],
      );
      await c.query('COMMIT');
    });

    const purged = await purgeOrg(workerRt, 30, { ref: org.orgId, reason: 'projects-columns-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: org.orgId });

    await withAdmin(async (c) => {
      for (const tbl of [
        'ludy_projects.project_column',
        'ludy_projects.project_task',
        'ludy_projects.project_member',
        'ludy_projects.project',
        'ludy_kernel.task',
      ]) {
        const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE org_id = $1`, [org.orgId]);
        expect(rows[0]?.n, tbl).toBe('0');
      }
    });
  });
});
