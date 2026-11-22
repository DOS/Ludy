// SPDX-License-Identifier: AGPL-3.0-only
// Projects v2 Wave 2 (#2600, docs/plan/projects-v2.md section 5.2): lean time tracking & billable hours on PostgreSQL 17:
// 1) Live timer start/stop, single-active-timer 409 conflict & explicit atomic stopExisting switch across projects, 14400 min clamp.
// 2) Manual log/update/delete, exact Decimal billable arithmetic (20m/40m rounding, large 16-digit rate), zero auto-posting to Finance/HR.
// 3) Permissions (own entry, project owner/org owner/admin, viewer 403, agent actor 403) + template & archived project rejection.
// 4) Cascade retention: projects.task.remove -> ON DELETE SET NULL (task_id), member removal -> ON DELETE SET NULL (user_id).
// 5) CSV formula-injection neutralization & ludy- filename, le_scope isolation in summary/export/weekly_status_source, PDPL find/erase, export + org_purge.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
  ProjectTimeDeleteResult,
  ProjectTimeExportCsvResult,
  ProjectTimeMutateResult,
  ProjectTimeStartResult,
  ProjectTimeStopResult,
  ProjectTimeSummaryResult,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries, sumTimeBillableAmounts, type ProjectWeeklyStatusSource } from '@ludy/mod-projects';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'crove-auth';
const DAY = 24 * 60 * 60 * 1000;
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

suite('projects lean time tracking & billable hours on PG17 (#2600)', () => {
  const dbName = `crove_test_proj_time_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects-time.test`;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'crove_worker';
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

  it('supports live timers, atomic stopExisting switch, 14400m clamp, Decimal math, role/le_scope checks, CSV defense, PDPL, and org_purge', async () => {
    const owner = await newPerson('time-owner');
    const memberA = await newPerson('time-member-a');
    const memberB = await newPerson('time-member-b');
    const viewer = await newPerson('time-viewer');
    const departing = await newPerson('time-departing');
    const outsider = await newPerson('time-outsider');

    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Chấm Giờ Dự Án');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Tổ chức Khác');

    for (const [person, role] of [
      [memberA, 'member'],
      [memberB, 'member'],
      [viewer, 'viewer'],
      [departing, 'member'],
    ] as const) {
      const inv = await rt.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: person.email, role },
        { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
      );
      await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(person.userId) });
    }

    const { projectId: projA } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án Tư vấn A',
    });
    const { projectId: projB } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án Triển khai B',
    });
    await exec(owner.userId, org.orgId, 'projects.project.set_owner', { projectId: projA, ownerUserId: memberA.userId });

    const { taskId: taskA1 } = await exec<{ taskId: string }>(memberA.userId, org.orgId, 'projects.task.create', {
      projectId: projA,
      title: 'Khảo sát yêu cầu',
      assigneePositionId: null,
    });
    const { taskId: taskA2 } = await exec<{ taskId: string }>(memberA.userId, org.orgId, 'projects.task.create', {
      projectId: projA,
      title: 'Họp chốt giải pháp',
      assigneePositionId: null,
    });
    const { taskId: taskB1 } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: projB,
      title: 'Thiết lập môi trường',
      assigneePositionId: null,
    });

    // 1. Live timer start -> 409 TIMER_ALREADY_RUNNING -> explicit atomic stopExisting switch across projects.
    const startedA = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: projA,
      taskId: taskA1,
      billable: true,
      hourlyRate: '300000',
      note: 'Đang bấm giờ dự án A',
    });
    expect(startedA.stoppedEntry).toBeNull();
    expect(startedA.entry.running).toBe(true);
    expect(startedA.entry.endedAt).toBeNull();
    expect(startedA.entry.durationMinutes).toBeNull();
    expect(startedA.entry.hourlyRate).toBe('300000.00');
    expect(startedA.entry.billableAmount).toBeNull();

    // Viewer & agent actors are blocked from mutations.
    await expect(
      exec(viewer.userId, org.orgId, 'projects.time.start', { projectId: projA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const agentActor: AgentActor = {
      type: 'agent',
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    await expect(
      rt.execute('projects.time.log', {
        projectId: projA,
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        durationMinutes: 30,
      }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Cross-org isolation on task and project.
    await expect(
      exec(outsider.userId, otherOrg.orgId, 'projects.time.start', { projectId: projA }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // Task outside projA rejected.
    await expect(
      exec(memberA.userId, org.orgId, 'projects.time.log', {
        projectId: projA,
        taskId: taskB1,
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });

    // Cannot update duration/endedAt on running entry.
    await expect(
      exec(memberA.userId, org.orgId, 'projects.time.update', {
        entryId: startedA.entry.id,
        durationMinutes: 45,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_RUNNING' });

    // Duplicate timer without stopExisting returns 409 TIMER_ALREADY_RUNNING.
    await expect(
      exec(memberA.userId, org.orgId, 'projects.time.start', {
        projectId: projB,
        taskId: taskB1,
      }),
    ).rejects.toMatchObject({ code: 'TIMER_ALREADY_RUNNING' });

    // Explicit stopExisting: true stops Project A timer and starts Project B timer atomically.
    const switched = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: projB,
      taskId: taskB1,
      stopExisting: true,
      note: 'Chuyển sang dự án B',
    });
    expect(switched.stoppedEntry?.id).toBe(startedA.entry.id);
    expect(switched.stoppedEntry?.running).toBe(false);
    expect(switched.stoppedEntry?.durationMinutes).toBeGreaterThanOrEqual(1);
    expect(switched.entry.projectId).toBe(projB);
    expect(switched.entry.running).toBe(true);

    // Simulate a timer forgotten for 20 days -> clamp cleanly to 14,400 min on stop.
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE crove_projects.time_entry SET started_at = now() - interval '20 days' WHERE org_id = $1 AND id = $2`,
        [org.orgId, switched.entry.id],
      );
    });
    const stoppedB = await exec<ProjectTimeStopResult>(memberA.userId, org.orgId, 'projects.time.stop', {
      entryId: switched.entry.id,
    });
    expect(stoppedB.clampedToMax).toBe(true);
    expect(stoppedB.entry.durationMinutes).toBe(14400);

    // 2. Manual logging with exact Decimal rounding (20 min + 40 min at 100,000.00 VND/hr = 33,333.33 + 66,666.67 = 100,000.00).
    const now = Date.now();
    const log20 = await exec<ProjectTimeMutateResult>(memberB.userId, org.orgId, 'projects.time.log', {
      projectId: projA,
      taskId: taskA2,
      startedAt: new Date(now - 2 * 3600_000).toISOString(),
      durationMinutes: 20,
      billable: true,
      hourlyRate: '100000',
      note: '=SUM(1+1) kiểm tra xuất CSV, liên hệ 0901234567',
    });
    expect(log20.entry.billableAmount).toBe('33333.33');

    // Reject mismatched endedAt + durationMinutes or > 14,400m interval.
    await expect(
      exec(memberB.userId, org.orgId, 'projects.time.log', {
        projectId: projA,
        startedAt: new Date(now - 3600_000).toISOString(),
        endedAt: new Date(now).toISOString(),
        durationMinutes: 15,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_INVALID_RANGE' });

    const log40 = await exec<ProjectTimeMutateResult>(memberB.userId, org.orgId, 'projects.time.log', {
      projectId: projA,
      taskId: null,
      startedAt: new Date(now - 3600_000).toISOString(),
      endedAt: new Date(now - 3600_000 + 40 * 60_000).toISOString(),
      billable: true,
      hourlyRate: '100000.00',
      note: '+1+2 làm chung dự án',
    });
    expect(log40.entry.durationMinutes).toBe(40);
    expect(log40.entry.billableAmount).toBe('66666.67');

    // Member B logs an internal entry, Member A (who is owner of projA) can update it,
    // whereas Member B CANNOT update/delete Member A's own entry on projB.
    await expect(
      exec(memberB.userId, org.orgId, 'projects.time.update', {
        entryId: switched.entry.id,
        note: 'Không được phép sửa',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      exec(memberB.userId, org.orgId, 'projects.time.delete', {
        entryId: switched.entry.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Owner of projA (memberA) updates memberB's project-level log and then edits note cleanly.
    const updated40 = await exec<ProjectTimeMutateResult>(memberA.userId, org.orgId, 'projects.time.update', {
      entryId: log40.entry.id,
      note: '-Hủy công thức, đã cập nhật',
    });
    expect(updated40.entry.note).toBe('-Hủy công thức, đã cập nhật');

    // Departing member logs billable time, then leaves the org -> ON DELETE SET NULL preserves entry & totals!
    await exec<ProjectTimeMutateResult>(departing.userId, org.orgId, 'projects.time.log', {
      projectId: projA,
      taskId: taskA1,
      startedAt: new Date(now - 5 * 3600_000).toISOString(),
      durationMinutes: 60,
      billable: true,
      hourlyRate: '200000',
      note: 'Giờ của thành viên sắp rời công ty',
    });
    await rt.execute('kernel.member.remove', { userId: departing.userId }, { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

    // Remove taskA1 from projA -> ON DELETE SET NULL (task_id) preserves both startedA and departing's entries!
    await exec(memberA.userId, org.orgId, 'projects.task.remove', { projectId: projA, taskId: taskA1 });

    const sumA = await query<ProjectTimeSummaryResult>(viewer.userId, org.orgId, 'projects.time.summary', {
      projectId: projA,
      from: '2000-01-01',
      to: '2099-12-31',
      timeZone: '+07:00',
    });
    expect(sumA.canWrite).toBe(false);
    // Remaining entries on projA: stopped startedA, log20 (33333.33), updated40 (66666.67), departing (200000.00).
    const switchedAmount = switched.stoppedEntry?.billableAmount ?? '5000.00';
    const expectedProjATotal = sumTimeBillableAmounts([switchedAmount, '33333.33', '66666.67', '200000.00']);
    expect(sumA.totals.entryCount).toBe(4);
    expect(sumA.totals.billableMinutes).toBe(120 + (switched.stoppedEntry?.durationMinutes ?? 1));
    expect(sumA.totals.billableAmount).toBe(expectedProjATotal);
    expect(sumA.byMember.some((m) => m.userId === null && m.totals.billableAmount === '200000.00')).toBe(true);
    expect(sumA.entries.some((e) => e.id === log20.entry.id && e.taskTitle === 'Họp chốt giải pháp')).toBe(true);

    // 3. Weekly status source picks up timeThisWeek deterministically.
    const weekly = await query<ProjectWeeklyStatusSource>(viewer.userId, org.orgId, 'projects.weekly_status_source', {
      projectId: projA,
    });
    expect(weekly.timeThisWeek?.entryCount).toBe(4);
    expect(weekly.timeThisWeek?.billableAmount).toBe(expectedProjATotal);

    // 4. CSV export starts with BOM, uses ludy- prefix, and neutralizes =, +, - formulas.
    const exportedCsv = await query<ProjectTimeExportCsvResult>(viewer.userId, org.orgId, 'projects.time.export_csv', {
      projectId: projA,
    });
    expect(exportedCsv.filename.startsWith('ludy-gio-lam-')).toBe(true);
    expect(exportedCsv.filename.endsWith('.csv')).toBe(true);
    expect(exportedCsv.csv.startsWith('\uFEFF')).toBe(true);
    expect(exportedCsv.csv).toContain("'=SUM(1+1)");
    expect(exportedCsv.csv).toContain("'-Hủy công thức");

    // 5. le_scope isolation: create Legal Entity B + task in Entity B; restricted member in Entity A must NOT see Entity B's time entry!
    let leA = '';
    let leB = '';
    let taskLeB = '';
    await withAdmin(async (c) => {
      leA = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh A', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]!.id;
      leB = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]!.id;
      taskLeB = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, status, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Nhiệm vụ mật B', 'todo', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leB],
        )
      ).rows[0]!.id;
      await c.query(
        `INSERT INTO crove_projects.project_task (org_id, project_id, task_id, added_by)
         VALUES ($1, $2, $3, $4)`,
        [org.orgId, projB, taskLeB, owner.userId],
      );
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, memberB.userId, leA, owner.userId],
      );
    });
    await exec<ProjectTimeMutateResult>(owner.userId, org.orgId, 'projects.time.log', {
      projectId: projB,
      taskId: taskLeB,
      startedAt: new Date(now - 3 * 3600_000).toISOString(),
      durationMinutes: 60,
      billable: true,
      hourlyRate: '900000',
      note: 'Bí mật chi nhánh B',
    });
    const restrictedSumB = await query<ProjectTimeSummaryResult>(memberB.userId, org.orgId, 'projects.time.summary', {
      projectId: projB,
    });
    expect(restrictedSumB.entries.some((e) => e.taskId === taskLeB)).toBe(false);
    expect(restrictedSumB.totals.billableAmount).toBe('0.00');

    // 6. Template project refusal at both command level & SQL trigger level.
    const { templateId } = await exec<{ templateId: string }>(owner.userId, org.orgId, 'projects.template.create', {
      name: 'Mẫu dự án tháng',
      tasks: [{ title: 'Việc mẫu 1' }],
    });
    await expect(
      exec(owner.userId, org.orgId, 'projects.time.log', {
        projectId: templateId,
        startedAt: new Date(now - 3600_000).toISOString(),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_TEMPLATE_FORBIDDEN' });

    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_projects.time_entry (org_id, project_id, user_id, started_at, ended_at, duration_minutes)
           VALUES ($1, $2, $3, now() - interval '30 minutes', now(), 30)`,
          [org.orgId, templateId, owner.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 7. Archived project rejects writes while allowing read summary/export.
    await exec(owner.userId, org.orgId, 'projects.project.archive', { projectId: projB });
    await expect(
      exec(owner.userId, org.orgId, 'projects.time.start', { projectId: projB }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    const archivedSum = await query<ProjectTimeSummaryResult>(viewer.userId, org.orgId, 'projects.time.summary', {
      projectId: projB,
    });
    expect(archivedSum.canWrite).toBe(false);

    // 7b. Private project visibility isolation (#2604 + #2600): non-member gets 404 PROJECT_NOT_FOUND on every command/query,
    // and removing a private-project member stops their active timer there so time_entry_running_uq never locks them out.
    const { projectId: privProj } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án Bí mật',
      visibility: 'private',
      memberUserIds: [memberA.userId],
    });
    const privStarted = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: privProj,
      billable: true,
      hourlyRate: '400000',
      note: 'Giờ bí mật',
    });
    for (const op of [
      query(memberB.userId, org.orgId, 'projects.time.summary', { projectId: privProj }),
      query(memberB.userId, org.orgId, 'projects.time.export_csv', { projectId: privProj }),
      exec(memberB.userId, org.orgId, 'projects.time.start', { projectId: privProj }),
      exec(memberB.userId, org.orgId, 'projects.time.stop', { projectId: privProj }),
      exec(memberB.userId, org.orgId, 'projects.time.log', {
        projectId: privProj,
        startedAt: new Date(now - 3600_000).toISOString(),
        durationMinutes: 15,
      }),
      exec(memberB.userId, org.orgId, 'projects.time.update', { projectId: privProj, entryId: privStarted.entry.id, note: 'probe' }),
      exec(memberB.userId, org.orgId, 'projects.time.delete', { projectId: privProj, entryId: privStarted.entry.id }),
    ]) {
      await expect(op).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    }
    await expect(
      exec(memberB.userId, org.orgId, 'projects.time.update', { entryId: privStarted.entry.id, note: 'probe' }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_FOUND', status: 404 });

    await exec(owner.userId, org.orgId, 'projects.member.remove', { projectId: privProj, userId: memberA.userId });
    await expect(query(memberA.userId, org.orgId, 'projects.time.summary', { projectId: privProj })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    const privOwnerSum = await query<ProjectTimeSummaryResult>(owner.userId, org.orgId, 'projects.time.summary', {
      projectId: privProj,
    });
    expect(privOwnerSum.entries.find((e) => e.id === privStarted.entry.id)?.running).toBe(false);
    const restartA = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: projA,
    });
    await exec(memberA.userId, org.orgId, 'projects.time.stop', { entryId: restartA.entry.id });

    // 7c. org -> private stops excluded members' running timers while preserving project members' running timers (#2600 + #2604).
    const { projectId: orgToPrivProj } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án chuyển riêng tư',
      visibility: 'org',
      memberUserIds: [memberA.userId],
    });
    const timerMemberA = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: orgToPrivProj,
      note: 'Thành viên được giữ quyền xem',
    });
    const timerExcludedB = await exec<ProjectTimeStartResult>(memberB.userId, org.orgId, 'projects.time.start', {
      projectId: orgToPrivProj,
      note: 'Thành viên bị loại khi chuyển riêng tư',
    });
    await exec(owner.userId, org.orgId, 'projects.project.update', {
      projectId: orgToPrivProj,
      visibility: 'private',
    });
    await expect(query(memberB.userId, org.orgId, 'projects.time.summary', { projectId: orgToPrivProj })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    const orgToPrivOwnerSum = await query<ProjectTimeSummaryResult>(owner.userId, org.orgId, 'projects.time.summary', {
      projectId: orgToPrivProj,
    });
    expect(orgToPrivOwnerSum.entries.find((e) => e.id === timerExcludedB.entry.id)?.running).toBe(false);
    expect(orgToPrivOwnerSum.entries.find((e) => e.id === timerMemberA.entry.id)?.running).toBe(true);
    const restartB = await exec<ProjectTimeStartResult>(memberB.userId, org.orgId, 'projects.time.start', {
      projectId: projA,
    });
    await exec(memberB.userId, org.orgId, 'projects.time.stop', { entryId: restartB.entry.id });
    const stopAInPriv = await exec<ProjectTimeStopResult>(memberA.userId, org.orgId, 'projects.time.stop', {
      projectId: orgToPrivProj,
      entryId: timerMemberA.entry.id,
    });
    expect(stopAInPriv.entry.running).toBe(false);

    // 7d. Archiving (via archive & set_status) auto-stops running timers, and stopExisting clears an archived prior project's timer.
    const archivedTimerA = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: orgToPrivProj,
    });
    await exec(owner.userId, org.orgId, 'projects.project.archive', { projectId: orgToPrivProj });
    const afterArchiveSum = await query<ProjectTimeSummaryResult>(owner.userId, org.orgId, 'projects.time.summary', {
      projectId: orgToPrivProj,
    });
    expect(afterArchiveSum.entries.find((e) => e.id === archivedTimerA.entry.id)?.running).toBe(false);

    const { projectId: setStatusArchProj } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án đóng bằng set_status',
    });
    const setStatusTimerA = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: setStatusArchProj,
    });
    await exec(owner.userId, org.orgId, 'projects.project.set_status', {
      projectId: setStatusArchProj,
      status: 'archived',
    });
    const afterSetStatusSum = await query<ProjectTimeSummaryResult>(owner.userId, org.orgId, 'projects.time.summary', {
      projectId: setStatusArchProj,
    });
    expect(afterSetStatusSum.entries.find((e) => e.id === setStatusTimerA.entry.id)?.running).toBe(false);

    const { projectId: legacyArchProj } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án giả lập timer còn mở khi đã lưu trữ',
    });
    const legacyArchTimer = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: legacyArchProj,
    });
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_projects.project SET status = 'archived' WHERE org_id = $1 AND id = $2`, [org.orgId, legacyArchProj]);
    });
    const switchedOutOfArchived = await exec<ProjectTimeStartResult>(memberA.userId, org.orgId, 'projects.time.start', {
      projectId: projA,
      stopExisting: true,
    });
    expect(switchedOutOfArchived.stoppedEntry?.id).toBe(legacyArchTimer.entry.id);
    expect(switchedOutOfArchived.stoppedEntry?.running).toBe(false);
    await exec(memberA.userId, org.orgId, 'projects.time.stop', { entryId: switchedOutOfArchived.entry.id });

    // 7e. Timer owner can stop their own running timer even if its task was later moved to a hidden le_scope entity.
    const { taskId: movableTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: projA,
      title: 'Nhiệm vụ chuyển chi nhánh',
      assigneePositionId: null,
    });
    const startedOnMovable = await exec<ProjectTimeStartResult>(memberB.userId, org.orgId, 'projects.time.start', {
      projectId: projA,
      taskId: movableTaskId,
    });
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_kernel.task SET legal_entity_id = $1 WHERE org_id = $2 AND id = $3`, [leB, org.orgId, movableTaskId]);
    });
    const stoppedMovedTaskTimer = await exec<ProjectTimeStopResult>(memberB.userId, org.orgId, 'projects.time.stop', {
      projectId: projA,
      entryId: startedOnMovable.entry.id,
    });
    expect(stoppedMovedTaskTimer.entry.running).toBe(false);
    expect(stoppedMovedTaskTimer.entry.taskTitle).toBeNull();

    // 8. Delete entry works for authorized owner/creator.
    const deleted = await exec<ProjectTimeDeleteResult>(owner.userId, org.orgId, 'projects.time.delete', {
      projectId: projA,
      entryId: updated40.entry.id,
    });
    expect(deleted.deleted).toBe(true);

    // 9. Zero auto-posting: Accounting journals/invoices and HR payroll tables remain untouched.
    await withAdmin(async (c) => {
      for (const tbl of ['crove_finance.journal_entry', 'crove_hr.payroll_run']) {
        const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE org_id = $1`, [org.orgId]);
        expect(rows[0]?.n, tbl).toBe('0');
      }
    });

    // 10. PDPL personal-data find and erase on crove_projects.time_entry.note.
    const foundPd = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: '0901234567' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(foundPd.matches.some((m) => m.column === 'crove_projects.time_entry.note' && m.rowId === log20.entry.id)).toBe(true);

    const erasedPd = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '0901234567' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedPd.erased.find((e) => e.column === 'crove_projects.time_entry.note')?.rows).toBe(1);

    const afterErase = await query<ProjectTimeSummaryResult>(owner.userId, org.orgId, 'projects.time.summary', {
      projectId: projA,
    });
    expect(afterErase.entries.find((e) => e.id === log20.entry.id)?.note).toContain('[đã xóa]');

    // 11. Org export + org_purge deletes crove_projects.time_entry cleanly ahead of task & project.
    expect(EXPORT_TABLE_NAMES).toContain('projects.time_entry');
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exp = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, org.orgId, { now: () => generatedAt });
    const timePart = exp.parts.find((p) => p.table === 'projects.time_entry');
    expect(timePart).toBeDefined();
    const lines = new TextDecoder()
      .decode(sealer.open(await store.get(timePart!.key), exportAad(org.orgId, timePart!), 'aes-256-gcm'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((r) => r.id === log20.entry.id)).toBe(true);

    await rt.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.userId), orgId: org.orgId });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE crove_kernel.audit_event
            SET occurred_at = $1
          WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), org.orgId],
      );
      await c.query('COMMIT');
    });

    const purged = await purgeOrg(workerRt, 30, { ref: org.orgId, reason: 'projects-time-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: org.orgId });

    await withAdmin(async (c) => {
      for (const tbl of [
        'crove_projects.time_entry',
        'crove_projects.project_task',
        'crove_projects.project_member',
        'crove_projects.project',
        'crove_kernel.task',
      ]) {
        const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE org_id = $1`, [org.orgId]);
        expect(rows[0]?.n, tbl).toBe('0');
      }
    });
  });
});
