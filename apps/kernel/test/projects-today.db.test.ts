// SPDX-License-Identifier: AGPL-3.0-only
// projects.today (#2596), the Projects line of Home's "Hôm nay cần bạn", on PostgreSQL 17 through the runtime:
// 1) A member with overdue and due-today tasks on their seats sees warn flags and deadlines linked to /projects/<id>,
//    plus end-to-end merge through kernel.today with dropped === 0 and todayCoworkerKey('projects') === 'gm' (Vy).
// 2) A project owner sees overdue tasks, vacant-seat tasks and waiting tasks untouched for 3 days, with deduplication
//    and exclusions (unassigned assignee_position_id NULL, agent-held seats, < 3 day waits, done/cancelled tasks,
//    inactive/on_hold/done/archived projects, cross-org isolation).
// 3) A viewer and an entity-limited (le_scope) member see only tasks they can open; zero rows are written.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { TODAY_ITEMS_MAX, todayCoworkerKey, zTodayItems, type TodayItem, type TodayList } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const DAY_MS = 86_400_000;
const NOW = '2026-11-10T03:00:00.000Z'; // 2026-11-10 10:00:00+07:00
const NOW_MS = Date.parse(NOW);

suite('projects.today on PostgreSQL (#2596)', () => {
  const dbName = `crove_test_projects_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;

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

  async function person(tag: string) {
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects-today.test`;
    const userId = await upsertIdentity(db, {
      issuer: 'test',
      subject: randomUUID(),
      email,
      name: `Person ${tag}`,
    });
    return { userId, email, name: `Person ${tag}` };
  }

  async function inviteAndJoin(orgId: string, ownerId: string, user: { email: string; userId: string }, role: 'admin' | 'member' | 'viewer') {
    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: user.email, role },
      { actor: asMfa(ownerId), orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(user.userId) },
    );
  }

  const exec = <T>(orgId: string, userId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const execMfa = <T>(orgId: string, userId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asMfa(userId), orgId, idempotencyKey: randomUUID() });

  const todayAt = (orgId: string, userId: string, now: string = NOW) =>
    rt.query<TodayItem[]>('projects.today', { now }, { actor: asUser(userId), orgId });

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

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    const shipped = ['kernel', 'projects', 'finance'] as const;
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, stepUp: 'required' }).register({
      commands: [...buildKernelCommands({ shippedModules: shipped }), ...projectsCommands, ...financeCommands],
      queries: [
        ...kernelQueries({
          inboundDomain: null,
          apps: { shipped, deployment: shipped, entitlements: async () => ['full'] },
        }),
        ...projectsQueries,
      ],
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

  it('shows overdue and due-today tasks for a member seat, links to the board with no free text, and integrates into kernel.today (AC 1 & 4)', async () => {
    const owner = await person('owner-m');
    const member = await person('member-m');
    const org = await createOrg(rt, asUser(owner.userId), 'Doanh nghiệp Alpha');
    await inviteAndJoin(org.orgId, owner.userId, member, 'member');

    const { positionId: memberSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Nhân viên vận hành',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: memberSeat,
      holder: { type: 'user', userId: member.userId },
    });

    const projectName = 'Project Secret Title 7742';
    const taskSecretTitle = 'Task Secret Title 8819';
    const { projectId } = await exec<{ projectId: string }>(org.orgId, owner.userId, 'projects.project.create', {
      name: projectName,
    });

    const realNow = Date.now();
    const overdueDue = new Date(realNow - 2 * DAY_MS - 3_600_000).toISOString();
    // Deterministic clock (10:00+07:00) for same-day vs tomorrow boundary check, plus real clock check on overdue task via kernel.today.
    const fixedDueToday = new Date(NOW_MS + 3_600_000).toISOString();
    const fixedOverdue = new Date(NOW_MS - 2 * DAY_MS - 3_600_000).toISOString();
    const fixedTomorrow = new Date(NOW_MS + DAY_MS).toISOString();

    const { taskId: overdueId } = await exec<{ taskId: string }>(org.orgId, owner.userId, 'projects.task.create', {
      projectId,
      title: taskSecretTitle,
      assigneePositionId: memberSeat,
      due: overdueDue,
      status: 'in_progress',
    });

    const itemsReal = zTodayItems.parse(await todayAt(org.orgId, member.userId, new Date(realNow).toISOString()));
    expect(itemsReal).toEqual([
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${overdueId}`,
        title: { key: 'projects.taskOverdueDays', params: { days: 2 } },
        severity: 'warn',
        dueAt: overdueDue,
        href: `/projects/${projectId}`,
      },
    ]);

    const serialized = JSON.stringify(itemsReal);
    expect(serialized).not.toContain(projectName);
    expect(serialized).not.toContain(taskSecretTitle);
    expect(serialized).not.toContain(member.name);

    const home = await rt.query<TodayList>('kernel.today', {}, { actor: asUser(member.userId), orgId: org.orgId });
    expect(home.dropped).toBe(0);
    expect(home.failed).toBe(0);
    expect(home.coworkers.gm).toBe('Vy');
    expect(todayCoworkerKey('projects')).toBe('gm');
    const projectHomeItems = home.items.filter((i) => i.app === 'projects');
    expect(projectHomeItems.map((i) => i.id)).toEqual([`overdue:${overdueId}`]);

    // Check deterministic due-today vs tomorrow at fixed clock NOW (10:00+07:00), plus done exclusion.
    const fixedOrg = await createOrg(rt, asUser(owner.userId), 'Doanh nghiệp Fixed');
    await inviteAndJoin(fixedOrg.orgId, owner.userId, member, 'member');
    const { positionId: fixedSeat } = await execMfa<{ positionId: string }>(fixedOrg.orgId, owner.userId, 'kernel.position.create', {
      title: 'Kỹ thuật',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(fixedOrg.orgId, owner.userId, 'kernel.position.assign', {
      id: fixedSeat,
      holder: { type: 'user', userId: member.userId },
    });
    const { projectId: fixedProjId } = await exec<{ projectId: string }>(fixedOrg.orgId, owner.userId, 'projects.project.create', {
      name: 'Fixed clock board',
    });
    const { taskId: fixedOverdueId } = await exec<{ taskId: string }>(fixedOrg.orgId, owner.userId, 'projects.task.create', {
      projectId: fixedProjId,
      title: 'Late on fixed clock',
      assigneePositionId: fixedSeat,
      due: fixedOverdue,
    });
    const { taskId: fixedDueTodayId } = await exec<{ taskId: string }>(fixedOrg.orgId, owner.userId, 'projects.task.create', {
      projectId: fixedProjId,
      title: 'Due today on fixed clock',
      assigneePositionId: fixedSeat,
      due: fixedDueToday,
    });
    await exec(fixedOrg.orgId, owner.userId, 'projects.task.create', {
      projectId: fixedProjId,
      title: 'Due tomorrow on fixed clock',
      assigneePositionId: fixedSeat,
      due: fixedTomorrow,
    });
    await exec(fixedOrg.orgId, owner.userId, 'projects.task.create', {
      projectId: fixedProjId,
      title: 'Done task excluded',
      assigneePositionId: fixedSeat,
      due: fixedOverdue,
      status: 'done',
    });

    const fixedItems = zTodayItems.parse(await todayAt(fixedOrg.orgId, member.userId, NOW));
    expect(fixedItems).toEqual([
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${fixedOverdueId}`,
        title: { key: 'projects.taskOverdueDays', params: { days: 2 } },
        severity: 'warn',
        dueAt: fixedOverdue,
        href: `/projects/${fixedProjId}`,
      },
      {
        kind: 'deadline',
        app: 'projects',
        id: `due:${fixedDueTodayId}`,
        title: { key: 'projects.taskDueToday', params: {} },
        dueAt: fixedDueToday,
        href: `/projects/${fixedProjId}`,
      },
    ]);

    // Solo owner OPC with zero seats sees unassigned overdue and due-today tasks without triggering vacantSeat.
    const soloOwner = await person('solo-owner');
    const soloOrg = await createOrg(rt, asUser(soloOwner.userId), 'Hộ kinh doanh Solo');
    const { projectId: soloProjId } = await exec<{ projectId: string }>(soloOrg.orgId, soloOwner.userId, 'projects.project.create', {
      name: 'Việc cửa hàng',
    });
    const { taskId: soloOverdueId } = await exec<{ taskId: string }>(soloOrg.orgId, soloOwner.userId, 'projects.task.create', {
      projectId: soloProjId,
      title: 'Đặt hàng quá hạn',
      assigneePositionId: null,
      due: fixedOverdue,
    });
    const { taskId: soloDueTodayId } = await exec<{ taskId: string }>(soloOrg.orgId, soloOwner.userId, 'projects.task.create', {
      projectId: soloProjId,
      title: 'Kiểm kê hôm nay',
      assigneePositionId: null,
      due: fixedDueToday,
    });
    await exec(soloOrg.orgId, soloOwner.userId, 'projects.task.create', {
      projectId: soloProjId,
      title: 'Việc không hạn',
      assigneePositionId: null,
    });

    const soloItems = zTodayItems.parse(await todayAt(soloOrg.orgId, soloOwner.userId, '2026-11-10T10:00:00+07:00'));
    expect(soloItems).toEqual([
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${soloOverdueId}`,
        title: { key: 'projects.taskOverdueDays', params: { days: 2 } },
        severity: 'warn',
        dueAt: fixedOverdue,
        href: `/projects/${soloProjId}`,
      },
      {
        kind: 'deadline',
        app: 'projects',
        id: `due:${soloDueTodayId}`,
        title: { key: 'projects.taskDueToday', params: {} },
        dueAt: fixedDueToday,
        href: `/projects/${soloProjId}`,
      },
    ]);
  });

  it('shows overdue, vacant-seat and 3-day waiting tasks to the project owner, deduplicates, and ignores excluded items (AC 2)', async () => {
    const orgOwner = await person('org-owner');
    const projOwner = await person('proj-owner');
    const coworker = await person('coworker');
    const otherOrgOwner = await person('other-org');

    const org = await createOrg(rt, asUser(orgOwner.userId), 'Công ty Beta');
    const otherOrg = await createOrg(rt, asUser(otherOrgOwner.userId), 'Công ty Gamma');
    await inviteAndJoin(org.orgId, orgOwner.userId, projOwner, 'member');
    await inviteAndJoin(org.orgId, orgOwner.userId, coworker, 'member');

    const { positionId: projOwnerSeat } = await execMfa<{ positionId: string }>(org.orgId, orgOwner.userId, 'kernel.position.create', {
      title: 'Trưởng dự án',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, orgOwner.userId, 'kernel.position.assign', {
      id: projOwnerSeat,
      holder: { type: 'user', userId: projOwner.userId },
    });

    const { positionId: coworkerSeat } = await execMfa<{ positionId: string }>(org.orgId, orgOwner.userId, 'kernel.position.create', {
      title: 'Kế toán',
      module: 'finance',
      roleKey: 'finance.accountant',
    });
    await execMfa(org.orgId, orgOwner.userId, 'kernel.position.assign', {
      id: coworkerSeat,
      holder: { type: 'user', userId: coworker.userId },
    });

    const { positionId: vacantSeat } = await execMfa<{ positionId: string }>(org.orgId, orgOwner.userId, 'kernel.position.create', {
      title: 'Vị trí đang trống',
      module: 'crm',
      roleKey: 'crm.sales',
    });

    const installedAgent = await execMfa<{ agentId: string; positionId: string }>(org.orgId, orgOwner.userId, 'kernel.agent.template.install', {
      templateKey: 'finance.chief_accountant',
      displayName: 'Ly kế toán',
    });

    const { projectId } = await exec<{ projectId: string }>(org.orgId, projOwner.userId, 'projects.project.create', {
      name: 'Dự án triển khai',
      ownerUserId: projOwner.userId,
    });

    // Overdue task where projOwner is BOTH seat holder and project owner -> emitted ONCE.
    const { taskId: bothOverdueId } = await exec<{ taskId: string }>(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId,
      title: 'Của trưởng dự án quá hạn',
      assigneePositionId: projOwnerSeat,
      due: new Date(NOW_MS - 3_600_000).toISOString(),
    });
    // Overdue task on coworker's seat in projOwner's project.
    const { taskId: coworkerOverdueId } = await exec<{ taskId: string }>(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId,
      title: 'Của đồng nghiệp quá hạn',
      assigneePositionId: coworkerSeat,
      due: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
    });
    // Vacant seat task.
    const { taskId: vacantTaskId } = await exec<{ taskId: string }>(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId,
      title: 'Việc ở vị trí trống',
      assigneePositionId: vacantSeat,
    });
    // Unassigned solo-owner task (assignee_position_id IS NULL) -> NOT a vacant seat.
    await exec(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId,
      title: 'Việc chưa gán vị trí',
      assigneePositionId: null,
    });
    // Agent-held seat -> NOT a vacant seat.
    await exec(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId,
      title: 'Việc của trợ thủ',
      assigneePositionId: installedAgent.positionId,
    });

    // Seed waiting >= 3 days and waiting < 3 days directly so task_before_update does not overwrite updated_at.
    let stuckWaitingId = '';
    let freshWaitingId = '';
    await withAdmin(async (c) => {
      stuckWaitingId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, source, created_by_type, updated_at)
           VALUES ($1, 'Việc chờ 4 ngày', $2, 'waiting', 'human', 'user', $3) RETURNING id`,
          [org.orgId, coworkerSeat, new Date(NOW_MS - 4 * DAY_MS)],
        )
      ).rows[0]?.id as string;
      freshWaitingId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, source, created_by_type, updated_at)
           VALUES ($1, 'Việc mới chờ 2 ngày', $2, 'waiting', 'human', 'user', $3) RETURNING id`,
          [org.orgId, coworkerSeat, new Date(NOW_MS - 2 * DAY_MS)],
        )
      ).rows[0]?.id as string;
    });
    await exec(org.orgId, projOwner.userId, 'projects.task.add', { projectId, taskId: stuckWaitingId });
    await exec(org.orgId, projOwner.userId, 'projects.task.add', { projectId, taskId: freshWaitingId });

    // On-hold project with overdue + vacant + stuck tasks -> excluded because project status <> 'active'.
    const { projectId: holdProjectId } = await exec<{ projectId: string }>(org.orgId, projOwner.userId, 'projects.project.create', {
      name: 'Dự án tạm dừng',
      ownerUserId: projOwner.userId,
    });
    await exec(org.orgId, projOwner.userId, 'projects.task.create', {
      projectId: holdProjectId,
      title: 'Việc trong dự án tạm dừng',
      assigneePositionId: vacantSeat,
      due: new Date(NOW_MS - DAY_MS).toISOString(),
    });
    await exec(org.orgId, projOwner.userId, 'projects.project.set_status', { projectId: holdProjectId, status: 'on_hold' });

    const ownerItems = zTodayItems.parse(await todayAt(org.orgId, projOwner.userId));
    expect(ownerItems).toEqual([
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${coworkerOverdueId}`,
        title: { key: 'projects.ownerTaskOverdueDays', params: { days: 2 } },
        severity: 'warn',
        dueAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
        href: `/projects/${projectId}`,
      },
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${bothOverdueId}`,
        title: { key: 'projects.taskOverdue', params: {} },
        severity: 'warn',
        dueAt: new Date(NOW_MS - 3_600_000).toISOString(),
        href: `/projects/${projectId}`,
      },
      {
        kind: 'flag',
        app: 'projects',
        id: `waiting:${stuckWaitingId}`,
        title: { key: 'projects.waitingStuck', params: { days: 4 } },
        severity: 'warn',
        href: `/projects/${projectId}`,
      },
      {
        kind: 'flag',
        app: 'projects',
        id: `vacant:${vacantTaskId}`,
        title: { key: 'projects.vacantSeat', params: {} },
        severity: 'warn',
        href: `/projects/${projectId}`,
      },
    ]);

    // Org owner who does not own the project and holds no overdue seat gets nothing from projOwner's project.
    expect(await todayAt(org.orgId, orgOwner.userId)).toEqual([]);
    // Cross-org isolation: otherOrg sees nothing.
    expect(await todayAt(otherOrg.orgId, otherOrgOwner.userId)).toEqual([]);

    // Removing the project owner sets owner_user_id = NULL and vacates projOwnerSeat; orgOwner inherits one item per task.
    await execMfa(org.orgId, orgOwner.userId, 'kernel.member.remove', { userId: projOwner.userId });
    const inheritedItems = zTodayItems.parse(await todayAt(org.orgId, orgOwner.userId));
    expect(inheritedItems.map((i) => `${i.id}:${i.title.key}`)).toEqual([
      `overdue:${coworkerOverdueId}:projects.ownerTaskOverdueDays`,
      `overdue:${bothOverdueId}:projects.ownerTaskOverdue`,
      `waiting:${stuckWaitingId}:projects.waitingStuck`,
      `vacant:${vacantTaskId}:projects.vacantSeat`,
    ]);
  });

  it('respects le_scope for entity-limited members and viewers, and writes zero rows (AC 3)', async () => {
    const owner = await person('owner-rls');
    const plainViewer = await person('viewer-rls');
    const scopedMember = await person('scoped-member');

    const org = await createOrg(rt, asUser(owner.userId), 'Tổ chức đa pháp nhân');
    await inviteAndJoin(org.orgId, owner.userId, plainViewer, 'viewer');
    await inviteAndJoin(org.orgId, owner.userId, scopedMember, 'member');

    let defaultEntityId = '';
    let branchEntityId = '';
    await withAdmin(async (c) => {
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]?.id as string;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Hà Nội', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, scopedMember.userId, branchEntityId, owner.userId],
      );
    });

    const { positionId: ownerSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Điều hành',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: ownerSeat,
      holder: { type: 'user', userId: owner.userId },
    });

    const { positionId: scopedSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Kế toán chi nhánh',
      module: 'finance',
      roleKey: 'finance.accountant',
      leScope: [branchEntityId],
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: scopedSeat,
      holder: { type: 'user', userId: scopedMember.userId },
    });

    const { projectId } = await exec<{ projectId: string }>(org.orgId, owner.userId, 'projects.project.create', {
      name: 'Dự án kiểm toán',
      ownerUserId: scopedMember.userId,
    });

    // Seed tasks in defaultEntity (hidden from scopedMember), branchEntity (visible), and org-wide NULL (visible).
    let hiddenTaskId = '';
    let visibleBranchTaskId = '';
    let orgWideTaskId = '';
    await withAdmin(async (c) => {
      hiddenTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type, legal_entity_id, updated_at)
           VALUES ($1, 'Việc trụ sở chính bị ẩn', $2, 'waiting', $3, 'human', 'user', $4, $5) RETURNING id`,
          [org.orgId, ownerSeat, new Date(NOW_MS - DAY_MS), defaultEntityId, new Date(NOW_MS - 4 * DAY_MS)],
        )
      ).rows[0]?.id as string;
      visibleBranchTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type, legal_entity_id, updated_at)
           VALUES ($1, 'Việc chi nhánh được xem', $2, 'todo', $3, 'human', 'user', $4, $5) RETURNING id`,
          [org.orgId, scopedSeat, new Date(NOW_MS - 2 * DAY_MS), branchEntityId, new Date(NOW_MS - 2 * DAY_MS)],
        )
      ).rows[0]?.id as string;
      orgWideTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type, legal_entity_id, updated_at)
           VALUES ($1, 'Việc chung toàn tổ chức', $2, 'todo', $3, 'human', 'user', NULL, $4) RETURNING id`,
          [org.orgId, scopedSeat, new Date(NOW_MS - DAY_MS), new Date(NOW_MS - DAY_MS)],
        )
      ).rows[0]?.id as string;
    });
    await exec(org.orgId, owner.userId, 'projects.task.add', { projectId, taskId: hiddenTaskId });
    await exec(org.orgId, owner.userId, 'projects.task.add', { projectId, taskId: visibleBranchTaskId });
    await exec(org.orgId, owner.userId, 'projects.task.add', { projectId, taskId: orgWideTaskId });

    // Record audit and outbox counts before read queries.
    const countsBefore = await withAdmin(async (c) => {
      const audit = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1', [org.orgId]);
      const outbox = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1', [org.orgId]);
      return { audit: Number(audit.rows[0]?.n ?? 0), outbox: Number(outbox.rows[0]?.n ?? 0) };
    });

    // Plain viewer sees nothing.
    expect(await todayAt(org.orgId, plainViewer.userId)).toEqual([]);

    // Scoped member sees branch and org-wide tasks, never the hidden default-entity overdue/waiting task.
    const scopedItems = zTodayItems.parse(await todayAt(org.orgId, scopedMember.userId));
    expect(scopedItems.map((i) => i.id)).toEqual([`overdue:${visibleBranchTaskId}`, `overdue:${orgWideTaskId}`]);

    const countsAfterReads = await withAdmin(async (c) => {
      const audit = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1', [org.orgId]);
      const outbox = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1', [org.orgId]);
      return { audit: Number(audit.rows[0]?.n ?? 0), outbox: Number(outbox.rows[0]?.n ?? 0) };
    });
    expect(countsAfterReads).toEqual(countsBefore);

    // Demoting scopedMember (still project owner and seat holder) to viewer suppresses all actionable alerts.
    await execMfa(org.orgId, owner.userId, 'kernel.member.change_role', { userId: scopedMember.userId, role: 'viewer' });
    expect(await todayAt(org.orgId, scopedMember.userId)).toEqual([]);
  });

  it('filters non-actionable rows before LIMIT and respects ADR-0053 per-org app enablement', async () => {
    const owner = await person('limit-owner');
    const coworker = await person('limit-coworker');
    const org = await createOrg(rt, asUser(owner.userId), 'Projects LIMIT & Gate Org');
    await inviteAndJoin(org.orgId, owner.userId, coworker, 'member');

    const { positionId: coworkerSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Kỹ thuật',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: coworkerSeat,
      holder: { type: 'user', userId: coworker.userId },
    });
    const { projectId } = await exec<{ projectId: string }>(org.orgId, owner.userId, 'projects.project.create', {
      name: 'Dự án lớn',
      ownerUserId: owner.userId,
    });

    // Insert 505 tasks assigned to coworkerSeat that are due LATER today (not overdue, not owner's seat)
    // plus 1 stuck waiting task with due IS NULL; SQL filtering + priority ordering must still surface the stuck task.
    const dueLaterToday = new Date(NOW_MS + 2 * 3_600_000);
    const stuckUpdatedAt = new Date(NOW_MS - 4 * DAY_MS);
    let stuckWaitingId = '';
    await withAdmin(async (c) => {
      const inserted = await c.query<{ id: string }>(
        `WITH batch AS (
           INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type)
           SELECT $1, 'Việc đồng nghiệp hôm nay #' || gs, $2, 'todo', $3, 'human', 'user'
           FROM generate_series(1, 505) AS gs
           RETURNING org_id, id
         )
         INSERT INTO crove_projects.project_task (org_id, project_id, task_id)
         SELECT org_id, $4, id FROM batch`,
        [org.orgId, coworkerSeat, dueLaterToday, projectId],
      );
      void inserted;
      stuckWaitingId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type, updated_at)
           VALUES ($1, 'Việc kẹt không hạn', $2, 'waiting', NULL, 'human', 'user', $3) RETURNING id`,
          [org.orgId, coworkerSeat, stuckUpdatedAt],
        )
      ).rows[0]?.id as string;
      await c.query('INSERT INTO crove_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)', [
        org.orgId,
        projectId,
        stuckWaitingId,
      ]);
    });

    const itemsBeforeGate = zTodayItems.parse(await todayAt(org.orgId, owner.userId));
    expect(itemsBeforeGate.map((i) => i.id)).toEqual([`waiting:${stuckWaitingId}`]);

    // Turning projects off refuses direct projects.today with MODULE_OFF and omits projects from kernel.today.
    await exec(org.orgId, owner.userId, 'kernel.org.set_app', { module: 'projects', enabled: false });
    await expect(todayAt(org.orgId, owner.userId)).rejects.toMatchObject({
      code: 'MODULE_OFF',
      status: 404,
      details: { module: 'projects' },
    });
    const homeWhileOff = await rt.query<TodayList>('kernel.today', {}, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(homeWhileOff.failed).toBe(0);
    expect(homeWhileOff.items.filter((i) => i.app === 'projects')).toEqual([]);

    await exec(org.orgId, owner.userId, 'kernel.org.set_app', { module: 'projects', enabled: true });
    const itemsAfterReEnable = zTodayItems.parse(await todayAt(org.orgId, owner.userId));
    expect(itemsAfterReEnable.map((i) => i.id)).toEqual([`waiting:${stuckWaitingId}`]);

    // Turn the 505 non-overdue coworker tasks overdue (506 actionable tasks total > LIMIT 500)
    // and verify projects.more counts all 506 tasks rather than truncating to 500 - 199.
    await withAdmin((c) =>
      c.query(`UPDATE crove_kernel.task SET due = $2 WHERE org_id = $1 AND status = 'todo'`, [
        org.orgId,
        new Date(NOW_MS - DAY_MS),
      ]),
    );
    const overflowItems = zTodayItems.parse(await todayAt(org.orgId, owner.userId));
    expect(overflowItems).toHaveLength(TODAY_ITEMS_MAX);
    expect(overflowItems.at(-1)).toEqual({
      kind: 'flag',
      app: 'projects',
      id: 'more',
      title: { key: 'projects.more', params: { count: 506 - (TODAY_ITEMS_MAX - 1) } },
      count: 506 - (TODAY_ITEMS_MAX - 1),
      severity: 'warn',
      href: '/projects',
    });
  });

  it('filters private project tasks at scale (506+ tasks + private project) for non-members, members, and owners', async () => {
    const owner = await person('priv-scale-owner');
    const privOwner = await person('priv-scale-powner');
    const outsider = await person('priv-scale-outsider');
    const org = await createOrg(rt, asUser(owner.userId), 'Private Scale Org');
    await inviteAndJoin(org.orgId, owner.userId, privOwner, 'member');
    await inviteAndJoin(org.orgId, owner.userId, outsider, 'member');

    const { positionId: privSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Kỹ thuật riêng',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: privSeat,
      holder: { type: 'user', userId: privOwner.userId },
    });
    const { positionId: outSeat } = await execMfa<{ positionId: string }>(org.orgId, owner.userId, 'kernel.position.create', {
      title: 'Kinh doanh',
      module: 'crm',
      roleKey: 'crm.sales',
    });
    await execMfa(org.orgId, owner.userId, 'kernel.position.assign', {
      id: outSeat,
      holder: { type: 'user', userId: outsider.userId },
    });

    const { projectId: orgProjId } = await exec<{ projectId: string }>(org.orgId, owner.userId, 'projects.project.create', {
      name: 'Dự án chung',
      ownerUserId: owner.userId,
    });
    const { projectId: privProjId } = await exec<{ projectId: string }>(org.orgId, privOwner.userId, 'projects.project.create', {
      name: 'Dự án mật',
      visibility: 'private',
      ownerUserId: privOwner.userId,
    });

    const overdueAt = new Date(NOW_MS - DAY_MS);
    const dueLaterToday = new Date(NOW_MS + 2 * 3_600_000);
    let privOverdueId = '';
    let privUnassignedId = '';
    let outOverdueId = '';
    await withAdmin(async (c) => {
      await c.query(
        `WITH batch AS (
           INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type)
           SELECT $1, 'Org later #' || gs, $2, 'todo', $3, 'human', 'user'
           FROM generate_series(1, 510) AS gs
           RETURNING org_id, id
         )
         INSERT INTO crove_projects.project_task (org_id, project_id, task_id)
         SELECT org_id, $4, id FROM batch`,
        [org.orgId, privSeat, dueLaterToday, orgProjId],
      );
      privOverdueId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type)
           VALUES ($1, 'Private overdue', $2, 'todo', $3, 'human', 'user') RETURNING id`,
          [org.orgId, privSeat, overdueAt],
        )
      ).rows[0]?.id as string;
      await c.query('INSERT INTO crove_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)', [
        org.orgId,
        privProjId,
        privOverdueId,
      ]);
      privUnassignedId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type)
           VALUES ($1, 'Private unassigned overdue', NULL, 'todo', $2, 'human', 'user') RETURNING id`,
          [org.orgId, overdueAt],
        )
      ).rows[0]?.id as string;
      await c.query('INSERT INTO crove_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)', [
        org.orgId,
        privProjId,
        privUnassignedId,
      ]);
      // Overdue org task on outsider's seat stays visible while private project tasks stay hidden from non-members.
      outOverdueId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, status, due, source, created_by_type)
           VALUES ($1, 'Outsider org overdue', $2, 'todo', $3, 'human', 'user') RETURNING id`,
          [org.orgId, outSeat, overdueAt],
        )
      ).rows[0]?.id as string;
      await c.query('INSERT INTO crove_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)', [
        org.orgId,
        orgProjId,
        outOverdueId,
      ]);
    });

    const outsiderItems = zTodayItems.parse(await todayAt(org.orgId, outsider.userId));
    expect(outsiderItems.map((i) => i.id)).toEqual([`overdue:${outOverdueId}`]);

    const privOwnerItems = zTodayItems.parse(await todayAt(org.orgId, privOwner.userId));
    expect(privOwnerItems).toHaveLength(TODAY_ITEMS_MAX);
    expect(privOwnerItems.slice(0, 2).map((i) => i.id).sort()).toEqual(
      [`overdue:${privOverdueId}`, `overdue:${privUnassignedId}`].sort(),
    );
    expect(privOwnerItems.at(-1)).toMatchObject({ id: 'more', count: 512 - (TODAY_ITEMS_MAX - 1) });

    const ownerItems = zTodayItems.parse(await todayAt(org.orgId, owner.userId));
    expect(ownerItems.map((i) => i.id).sort()).toEqual([`overdue:${privUnassignedId}`, `overdue:${outOverdueId}`].sort());
  });
});
