// SPDX-License-Identifier: AGPL-3.0-only
// Projects P4 integration tests on PostgreSQL 17 (issue #2595, docs/plan/projects.md §9 P4, docs/plan/notes.md §3.4):
// 1) A private to-do linked to a kernel.task or projects.project shows on the record panel and in SQL only to its owner;
//    another member, an owner, an admin, a viewer, an agent context, and the system context see no trace of it, and
//    private to-do audit rows never name the linked record or title.
// 2) Shared and private notes link to kernel.task and projects.project with reader availability checked per module/entity.
// 3) notes.todo.hand_over with optional projectId attaches the new team task atomically in the same transaction; archived,
//    missing, or disabled projects reject cleanly with full rollback.
// 4) Leaving projects out of CROVE_MODULES marks projects.project links unavailable without breaking panels or gets, and
//    refuses new project links.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  Note,
  NoteRecordPanel,
  NoteWritten,
  NotesExport,
  ProjectBoard,
  Todo,
  TodoHandedOver,
  TodoWritten,
} from '@ludy/kernel-contract';
import { Runtime, mintContextToken } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('projects P4: link notes and private to-dos to tasks and projects (#2595)', () => {
  const dbName = `crove_test_proj_notes_links_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let workerDb: Db;
  let app: Runtime;
  let noProjects: Runtime;
  let worker: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inSqlContext<T>(
    url: string,
    enter: (c: pg.Client) => Promise<unknown>,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  function contextToken(userId: string, orgId: string): string {
    return mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
      userId,
      orgId,
      sessionId: null,
      aal: 'aal1',
      mfaAt: null,
    });
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const makeUser = (name: string) =>
      upsertIdentity(db, {
        issuer: 'projects-notes-links',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@crove.test`,
        name: `User ${name}`,
      });
    const owner = await makeUser('owner');
    const adminUser = await makeUser('admin');
    const author = await makeUser('author');
    const other = await makeUser('other');
    const viewer = await makeUser('viewer');
    const limited = await makeUser('limited');

    const { orgId } = await createOrg(app, asUser(owner), `Projects Notes ${tag}`);
    const ids = await withAdmin(async (c) => {
      const entityA = (
        await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])
      ).rows[0]?.id as string;
      const entityB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Branch B', 'branch', $2) RETURNING id`,
          [orgId, owner],
        )
      ).rows[0]?.id as string;
      for (const [u, role] of [
        [adminUser, 'admin'],
        [author, 'member'],
        [other, 'member'],
        [viewer, 'viewer'],
        [limited, 'member'],
      ] as const) {
        await c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, u, role]);
      }
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, limited, entityB, owner],
      );
      const positionId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_user_id, status)
           VALUES ($1, 'Operations lead', 'kernel', 'staff', $2, 'active') RETURNING id`,
          [orgId, other],
        )
      ).rows[0]?.id as string;
      return { entityA, entityB, positionId };
    });

    const exec = <O>(userId: string, name: string, input: unknown = {}, rt: Runtime = app) =>
      rt.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}, rt: Runtime = app) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    const { projectId } = await exec<{ projectId: string }>(owner, 'projects.project.create', {
      name: 'Q4 Tax Close',
    });
    const { a: taskId, b: taskBId } = await withAdmin(async (c) => {
      const a = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Reconcile ledger', 'human', 'user', $2) RETURNING id`,
          [orgId, ids.entityA],
        )
      ).rows[0]?.id as string;
      const b = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Branch inventory check', 'human', 'user', $2) RETURNING id`,
          [orgId, ids.entityB],
        )
      ).rows[0]?.id as string;
      return { a, b };
    });

    const installed = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(owner), orgId },
    );
    await exec(owner, 'kernel.task.create', { title: 'Agent wake task', assigneePositionId: installed.positionId });
    const started = await worker.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId },
    );
    expect(started.runId).toBeTruthy();

    return {
      orgId,
      owner,
      adminUser,
      author,
      other,
      viewer,
      limited,
      positionId: ids.positionId,
      projectId,
      taskId,
      taskBId,
      agent: { agentId: installed.agentId, runId: started.runId as string },
      exec,
      query,
    };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const uApp = new URL(adminUrl);
    uApp.username = 'ludy_app';
    uApp.password = 'test-app-pw';
    appUrl = uApp.toString();

    const uWorker = new URL(adminUrl);
    uWorker.username = 'ludy_worker';
    uWorker.password = 'test-worker-pw';
    workerUrl = uWorker.toString();

    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerUrl, max: 2 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);
    workerDb = createDb(workerPool);

    const kernel = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernel.commands, ...financeCommands, ...notesCommands, ...projectsCommands],
      queries: [...kernel.queries, ...financeQueries, ...notesQueries, ...projectsQueries],
    });
    noProjects = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['projects'] }).register({
      commands: [...kernel.commands, ...notesCommands],
      queries: [...kernel.queries, ...notesQueries],
    });
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernel.commands, ...financeCommands],
      queries: [...kernel.queries, ...financeQueries],
    });
  }, 300_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows a private to-do linked to a task or project only to its owner across record panels, SQL RLS, and audits', async () => {
    const o = await setupOrg();
    const SECRET_TITLE = 'Verify confidential bank fee invoice #99';
    const { todoId } = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: SECRET_TITLE,
      timeZone: 'Asia/Ho_Chi_Minh',
      link: { targetType: 'kernel.task', targetId: o.taskId },
    });
    const addedProject = await o.exec<{ todoId: string; linkId: string }>(o.author, 'notes.todo.link_add', {
      todoId,
      targetType: 'projects.project',
      targetId: o.projectId,
    });
    expect(addedProject.linkId).toBeTruthy();

    // Duplicate link on the same to-do and target is rejected (409).
    await expect(
      o.exec(o.author, 'notes.todo.link_add', { todoId, targetType: 'kernel.task', targetId: o.taskId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_EXISTS', status: 409 });

    // Owner reads both links on notes.todo.get and sees the to-do in both record panels.
    const todo = await o.query<Todo>(o.author, 'notes.todo.get', { todoId });
    expect(todo.links.map((l) => [l.targetType, l.targetId, l.available])).toEqual([
      ['kernel.task', o.taskId, true],
      ['projects.project', o.projectId, true],
    ]);

    for (const target of [
      { targetType: 'kernel.task', targetId: o.taskId },
      { targetType: 'projects.project', targetId: o.projectId },
    ] as const) {
      const ownerPanel = await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', target);
      expect(ownerPanel.todos.map((t) => t.id)).toEqual([todoId]);
      expect(ownerPanel.todos[0]?.title).toBe(SECRET_TITLE);

      // Every other org role sees zero trace of the private to-do on the task or project panel.
      for (const reader of [o.other, o.owner, o.adminUser, o.viewer]) {
        const panel = await o.query<NoteRecordPanel>(reader, 'notes.record.panel', target);
        expect(panel.todos, `reader=${reader} target=${target.targetType}`).toEqual([]);
      }
    }

    // Raw SQL RLS on ludy_notes.link and ludy_notes.todo isolates the link row to the owner only.
    const sqlActors = [
      { name: 'other member', url: appUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.other, o.orgId)]) },
      { name: 'owner', url: appUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]) },
      { name: 'admin', url: appUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.adminUser, o.orgId)]) },
      { name: 'viewer', url: appUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.viewer, o.orgId)]) },
      { name: 'agent', url: workerUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [o.orgId, o.agent.agentId, o.agent.runId]) },
      { name: 'system', url: workerUrl, enter: (c: pg.Client) => c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [o.orgId]) },
    ];
    for (const actor of sqlActors) {
      const seen = await inSqlContext(actor.url, actor.enter, async (c) => ({
        todos: (await c.query('SELECT id FROM ludy_notes.todo WHERE id = $1', [todoId])).rowCount,
        links: (await c.query('SELECT id FROM ludy_notes.link WHERE todo_id = $1', [todoId])).rowCount,
      }));
      expect(seen, actor.name).toEqual({ todos: 0, links: 0 });
    }

    const authorSql = await inSqlContext(
      appUrl,
      (c) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.author, o.orgId)]),
      async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_notes.link WHERE todo_id = $1', [todoId])).rowCount,
    );
    expect(authorSql).toBe(2);

    // Personal export includes links attached to the owner's private to-dos, while exposing nothing to others.
    const authorExport = await o.query<NotesExport>(o.author, 'notes.mine.export');
    expect(authorExport.todos.find((x) => x.id === todoId)?.links).toEqual([
      { targetType: 'kernel.task', targetId: o.taskId },
      { targetType: 'projects.project', targetId: o.projectId },
    ]);
    expect(await o.query<NotesExport>(o.owner, 'notes.mine.export')).toMatchObject({ todos: [] });

    // Other users and viewers cannot link/unlink another member's private to-do or link an inaccessible task.
    await expect(
      o.exec(o.owner, 'notes.todo.link_add', { todoId, targetType: 'kernel.task', targetId: o.taskId }),
    ).rejects.toMatchObject({ code: 'TODO_NOT_FOUND', status: 404 });
    await expect(
      o.exec(o.other, 'notes.todo.link_remove', { linkId: addedProject.linkId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_NOT_FOUND', status: 404 });
    await expect(
      o.exec(o.viewer, 'notes.todo.link_add', { todoId, targetType: 'kernel.task', targetId: o.taskId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      o.exec(o.author, 'notes.todo.link_add', { todoId, targetType: 'kernel.task', targetId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // Entity-limited member cannot link to a task on another entity (taskId is on entityA, limited is scoped to entityB).
    const { todoId: limitedTodo } = await o.exec<TodoWritten>(o.limited, 'notes.todo.create', {
      title: 'Branch follow-up',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    await expect(
      o.exec(o.limited, 'notes.todo.link_add', { todoId: limitedTodo, targetType: 'kernel.task', targetId: o.taskId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // Removing a link drops the to-do from that record's panel; soft-deleting the to-do hides it, restore shows it again.
    await o.exec(o.author, 'notes.todo.link_remove', { linkId: addedProject.linkId });
    expect((await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', { targetType: 'projects.project', targetId: o.projectId })).todos).toEqual([]);
    await o.exec(o.author, 'notes.todo.delete', { todoId });
    expect((await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', { targetType: 'kernel.task', targetId: o.taskId })).todos).toEqual([]);
    await o.exec(o.author, 'notes.todo.restore', { todoId });
    expect((await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', { targetType: 'kernel.task', targetId: o.taskId })).todos.map((t) => t.id)).toEqual([todoId]);

    // Deleting the linked task cascades on ludy_notes.link without deleting the personal to-do.
    await withAdmin((c) => c.query('DELETE FROM ludy_kernel.task WHERE org_id = $1 AND id = $2', [o.orgId, o.taskId]));
    expect((await o.query<Todo>(o.author, 'notes.todo.get', { todoId })).links).toEqual([]);

    // Audit rows for private to-dos keep target='private' and omit title, targetType, and targetId (ADR-0037 §3).
    const audits = await withAdmin(
      async (c) =>
        (
          await c.query<{ command: string; detail: Record<string, unknown> }>(
            `SELECT command, detail FROM ludy_kernel.audit_event
             WHERE org_id = $1 AND command IN ('notes.todo.create', 'notes.todo.link_add', 'notes.todo.link_remove')
               AND detail ->> 'todoId' = $2
             ORDER BY occurred_at, id`,
            [o.orgId, todoId],
          )
        ).rows,
    );
    expect(audits.map((r) => r.command)).toEqual(['notes.todo.create', 'notes.todo.link_add', 'notes.todo.link_remove']);
    for (const row of audits) {
      expect(row.detail).toMatchObject({ target: 'private' });
      expect(row.detail).not.toHaveProperty('targetType');
      expect(row.detail).not.toHaveProperty('targetId');
      expect(JSON.stringify(row.detail)).not.toContain(o.taskId);
      expect(JSON.stringify(row.detail)).not.toContain(o.projectId);
      expect(JSON.stringify(row.detail)).not.toContain(SECRET_TITLE);
    }
  });

  it('links shared and private notes to kernel.task and projects.project with reader availability', async () => {
    const o = await setupOrg();
    const { noteId: sharedId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Project kickoff decisions',
      visibility: 'org',
      link: { targetType: 'projects.project', targetId: o.projectId },
    });
    await o.exec(o.author, 'notes.link.add', {
      noteId: sharedId,
      targetType: 'kernel.task',
      targetId: o.taskId,
    });
    const { noteId: privateId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Private reminder for task',
      visibility: 'private',
      link: { targetType: 'kernel.task', targetId: o.taskId },
    });

    const otherProjectPanel = await o.query<NoteRecordPanel>(o.other, 'notes.record.panel', {
      targetType: 'projects.project',
      targetId: o.projectId,
    });
    expect(otherProjectPanel.latest.map((n) => n.id)).toEqual([sharedId]);

    const otherTaskPanel = await o.query<NoteRecordPanel>(o.other, 'notes.record.panel', {
      targetType: 'kernel.task',
      targetId: o.taskId,
    });
    expect(otherTaskPanel.latest.map((n) => n.id)).toEqual([sharedId]);

    const authorTaskPanel = await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', {
      targetType: 'kernel.task',
      targetId: o.taskId,
    });
    expect(authorTaskPanel.latest.map((n) => n.id).sort()).toEqual([sharedId, privateId].sort());

    const sharedNote = await o.query<Note>(o.other, 'notes.note.get', { noteId: sharedId });
    expect(sharedNote.links.map((l) => [l.targetType, l.targetId, l.available])).toEqual([
      ['projects.project', o.projectId, true],
      ['kernel.task', o.taskId, true],
    ]);

    // An entity-limited member cannot read entityA's task, so direct linking from a private note fails cleanly.
    const { noteId: limitedPrivate } = await o.exec<NoteWritten>(o.limited, 'notes.note.create', {
      title: 'Limited branch note',
      visibility: 'private',
    });
    await expect(
      o.exec(o.limited, 'notes.link.add', { noteId: limitedPrivate, targetType: 'kernel.task', targetId: o.taskId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    // Linking to Branch B's own task succeeds.
    await o.exec(o.limited, 'notes.link.add', {
      noteId: limitedPrivate,
      targetType: 'kernel.task',
      targetId: o.taskBId,
    });
  });

  it('hands a to-do over into a project atomically and rolls back when project attach fails', async () => {
    const o = await setupOrg();
    const { todoId } = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: 'Prepare VAT return draft',
      dueOn: '2026-11-28',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    const handed = await o.exec<TodoHandedOver>(o.author, 'notes.todo.hand_over', {
      todoId,
      revision: 1,
      positionId: o.positionId,
      projectId: o.projectId,
      title: 'Prepare VAT return draft for team',
      description: 'Confirmed scope',
    });
    expect(handed.taskId).toBeTruthy();

    const board = await o.query<ProjectBoard>(o.owner, 'projects.board', { projectId: o.projectId });
    expect(board.tasks.map((t) => t.id)).toContain(handed.taskId);
    const todoRow = await o.query<Todo>(o.author, 'notes.todo.get', { todoId });
    expect(todoRow.status).toBe('handed_over');
    expect(todoRow.taskId).toBe(handed.taskId);

    // Audit row for hand_over includes projectId alongside taskId.
    const handOverAudit = await withAdmin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM ludy_kernel.audit_event
             WHERE org_id = $1 AND command = 'notes.todo.hand_over' AND detail ->> 'todoId' = $2`,
            [o.orgId, todoId],
          )
        ).rows[0]?.detail,
    );
    expect(handOverAudit).toMatchObject({ todoId, taskId: handed.taskId, positionId: o.positionId, projectId: o.projectId });

    // Atomicity: archiving the project or passing a nonexistent projectId rolls back both task creation and to-do update.
    const { projectId: archivedProject } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', {
      name: 'Archived project',
    });
    await o.exec(o.owner, 'projects.project.archive', { projectId: archivedProject });

    const countTasks = () =>
      withAdmin(
        async (c) =>
          (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1', [o.orgId])).rows[0]?.n,
      );
    const beforeTasks = await countTasks();

    const { todoId: retryTodo } = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: 'Rollback check to-do',
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    await expect(
      o.exec(o.author, 'notes.todo.hand_over', {
        todoId: retryTodo,
        revision: 1,
        positionId: o.positionId,
        projectId: archivedProject,
        title: 'Should roll back on archived project',
        description: '',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });

    await expect(
      o.exec(o.author, 'notes.todo.hand_over', {
        todoId: retryTodo,
        revision: 1,
        positionId: o.positionId,
        projectId: randomUUID(),
        title: 'Should roll back on missing project',
        description: '',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    await expect(
      o.exec(
        o.author,
        'notes.todo.hand_over',
        {
          todoId: retryTodo,
          revision: 1,
          positionId: o.positionId,
          projectId: o.projectId,
          title: 'Should roll back when projects module is off',
          description: '',
        },
        noProjects,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await countTasks()).toBe(beforeTasks);
    const stillOpen = await o.query<Todo>(o.author, 'notes.todo.get', { todoId: retryTodo });
    expect(stillOpen.status).toBe('open');
    expect(stillOpen.taskId).toBeNull();

    // Handing over without projectId succeeds even when projects module is off.
    const plainHandOver = await o.exec<TodoHandedOver>(
      o.author,
      'notes.todo.hand_over',
      {
        todoId: retryTodo,
        revision: 1,
        positionId: o.positionId,
        title: 'Plain team task without project',
        description: '',
      },
      noProjects,
    );
    expect(plainHandOver.taskId).toBeTruthy();
  });

  it('degrades gracefully when projects module is off: marks project links unavailable and blocks new project links', async () => {
    const o = await setupOrg();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Shared note on project',
      visibility: 'org',
      link: { targetType: 'projects.project', targetId: o.projectId },
    });
    const { todoId } = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: 'Private to-do on project',
      timeZone: 'Asia/Ho_Chi_Minh',
      link: { targetType: 'projects.project', targetId: o.projectId },
    });

    // With projects module off: existing note and to-do still load, showing available: false on projects.project links.
    const noteOff = await o.query<Note>(o.other, 'notes.note.get', { noteId }, noProjects);
    expect(noteOff.links.map((l) => [l.targetType, l.targetId, l.available])).toEqual([
      ['projects.project', o.projectId, false],
    ]);
    const todoOff = await o.query<Todo>(o.author, 'notes.todo.get', { todoId }, noProjects);
    expect(todoOff.links.map((l) => [l.targetType, l.targetId, l.available])).toEqual([
      ['projects.project', o.projectId, false],
    ]);

    // notes.record.panel still returns the linked items cleanly with projects off.
    const panelOff = await o.query<NoteRecordPanel>(
      o.author,
      'notes.record.panel',
      { targetType: 'projects.project', targetId: o.projectId },
      noProjects,
    );
    expect(panelOff.latest.map((n) => n.id)).toEqual([noteId]);
    expect(panelOff.todos.map((t) => t.id)).toEqual([todoId]);

    // Adding a new projects.project link refuses when projects is off.
    const { noteId: freshNote } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Fresh' }, noProjects);
    await expect(
      o.exec(o.author, 'notes.link.add', { noteId: freshNote, targetType: 'projects.project', targetId: o.projectId }, noProjects),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    const { todoId: freshTodo } = await o.exec<TodoWritten>(
      o.author,
      'notes.todo.create',
      { title: 'Fresh todo', timeZone: 'Asia/Ho_Chi_Minh' },
      noProjects,
    );
    await expect(
      o.exec(o.author, 'notes.todo.link_add', { todoId: freshTodo, targetType: 'projects.project', targetId: o.projectId }, noProjects),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // Re-enabling projects restores available: true.
    const noteBack = await o.query<Note>(o.other, 'notes.note.get', { noteId });
    expect(noteBack.links[0]?.available).toBe(true);
    const todoBack = await o.query<Todo>(o.author, 'notes.todo.get', { todoId });
    expect(todoBack.links[0]?.available).toBe(true);
  });
});
