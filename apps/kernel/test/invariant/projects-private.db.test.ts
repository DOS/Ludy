// SPDX-License-Identifier: AGPL-3.0-only
// Private projects security invariants on PostgreSQL 17 (issue #2604, ADR-0056 §1, plan docs/plan/projects-v2.md §4.4):
// - Structural catalog invariant: every crove_projects.* table carrying project_id (plus crove_projects.project) enforces
//   RESTRICTIVE project_visibility RLS; crove_kernel.task enforces RESTRICTIVE private_project_scope; crove_notes.link enforces
//   RESTRICTIVE link_private_project_scope; SECURITY DEFINER helpers pin search_path = pg_catalog, pg_temp and grant
//   EXECUTE to crove_tenant alone (never PUBLIC or crove_definer_tenant).
// - Complete ADR-0056 actor matrix over real login roles (crove_app, crove_worker): non-member member/viewer, other org,
//   no context, org owner/admin, project owner, invited member/viewer, assigned vs unassigned org-chart agent, matching vs
//   non-member member_vy and mcp_member, and system context across project, project_member, project_task, task, task_comment,
//   and crove_notes.link (including attaching an existing org task or linking an org note to a private project/task).
// - Zero cross-module RPC existence/content leaks across projects.*, kernel.task.*, and notes.*.
// Part of the invariant suite: keep self-contained (import only workspace packages under test and ./fixtures/*).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own throwaway database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  Note,
  NoteRecordPanel,
  ProjectBoard,
  ProjectCandidateTask,
  ProjectListResult,
  ProjectTaskProjectEntry,
  TodayItem,
} from '@ludy/kernel-contract';
import { contentGeneration, fileKey, Runtime, sha256Hex, type AgentActor, type UserActor } from '@ludy/kernel-runtime';
import { dealCommands } from '@ludy/mod-crm';
import { financeCommands } from '@ludy/mod-finance';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { aiRunFeature } from './fixtures/ai-run-feature.ts';
import { contextToken } from './fixtures/context-token.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

interface ActorHandle {
  name: string;
  url: () => string;
  enter: (c: pg.Client) => Promise<unknown>;
}

suite('invariant (#2604, ADR-0056): private projects visibility and cross-module isolation', () => {
  const dbName = `crove_test_proj_priv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let appRt: Runtime;
  let workerRt: Runtime;

  let orgId = '';
  let otherOrgId = '';
  const users = {
    owner: '',
    admin: '',
    creator: '',
    invitedMember: '',
    invitedViewer: '',
    nonMemberMember: '',
    nonMemberViewer: '',
    otherOrgOwner: '',
  };

  let orgProjectId = '';
  let privateProjectId = '';
  let privateColumnId = '';
  let privateCycleId = '';
  let orgTaskId = '';
  let unlinkedOrgTaskId = '';
  let privateTaskId = '';
  let agentPrivateTaskId = '';
  let privateCommentId = '';
  let orgCommentId = '';
  let creatorOrgNoteId = '';
  let nonMemberNoteId = '';
  let nonMemberTodoId = '';
  let privateProjectLinkId = '';
  let privateTaskLinkId = '';
  let orgProjectLinkId = '';

  let assignedAgent = { agentId: '', positionId: '', runId: '' };
  let unassignedAgent = { agentId: '', positionId: '', runId: '' };
  let vyInvited = { agentId: '', runId: '' };
  let vyNonMember = { agentId: '', runId: '' };
  let mcpInvitedGrantId = '';
  let mcpNonMemberGrantId = '';

  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const asMfa = (userId: string): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inContext<T>(actor: ActorHandle, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
    const c = createDbClient({ connectionString: actor.url() }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await actor.enter(c);
      await c.query('SET LOCAL ROLE crove_tenant');
      const res = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return res;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await c.end();
    }
  }

  async function attemptSql(actor: ActorHandle, queryText: string, params: unknown[]): Promise<{ ok: true; rowCount: number } | { ok: false; code: string; message: string }> {
    return await inContext(actor, async (c) => {
      await c.query('SAVEPOINT sp');
      try {
        const res = await c.query(queryText, params);
        return { ok: true as const, rowCount: res.rowCount ?? 0 };
      } catch (err: unknown) {
        await c.query('ROLLBACK TO SAVEPOINT sp');
        const pgErr = err as { code?: string; message?: string };
        return { ok: false as const, code: pgErr.code ?? '', message: pgErr.message ?? '' };
      }
    });
  }

  const userActor = (name: string, targetOrg: () => string, userId: () => string): ActorHandle => ({
    name,
    url: () => appUrl,
    enter: (c) =>
      c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        targetOrg(),
        contextToken(userId(), targetOrg()),
      ]),
  });
  const mcpActor = (name: string, grantId: () => string): ActorHandle => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)', [orgId, grantId()]),
  });
  const orgAgentActor = (name: string, info: () => { agentId: string; runId: string }): ActorHandle => ({
    name,
    url: () => workerUrl,
    enter: (c) =>
      c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
        orgId,
        info().agentId,
        info().runId,
      ]),
  });
  const vyActor = (name: string, info: () => { agentId: string; runId: string }): ActorHandle => ({
    name,
    url: () => workerUrl,
    enter: (c) =>
      c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [
        orgId,
        info().agentId,
        info().runId,
      ]),
  });
  const systemActor: ActorHandle = {
    name: 'system',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]),
  };
  const noContextActor: ActorHandle = {
    name: 'no_ctx',
    url: () => appUrl,
    enter: async () => undefined,
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const login = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = dbIds ? dbIds.roleName(username) : username;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');

    const runtimeFor = (url: string) => {
      const pool = createDbPool({ connectionString: url, max: 4 }, dbIds);
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...dealCommands, ...financeCommands, ...notesCommands, ...projectsCommands, ...signCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...notesQueries, ...projectsQueries, ...signQueries],
        }),
      };
    };

    const api = runtimeFor(appUrl);
    appRt = api.runtime;
    workerRt = runtimeFor(workerUrl).runtime;

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, {
        issuer: 'projects-private-inv',
        subject: key,
        email: `${key}@proj-priv.test`,
        name: key,
      });
    }

    orgId = (await createOrg(appRt, asUser(users.owner), 'Công ty Bí Mật')).orgId;
    otherOrgId = (await createOrg(appRt, asUser(users.otherOrgOwner), 'Công ty Khác')).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
           ($1, $2, 'admin'),
           ($1, $3, 'member'),
           ($1, $4, 'member'),
           ($1, $5, 'viewer'),
           ($1, $6, 'member'),
           ($1, $7, 'viewer')`,
        [
          orgId,
          users.admin,
          users.creator,
          users.invitedMember,
          users.invitedViewer,
          users.nonMemberMember,
          users.nonMemberViewer,
        ],
      );
      await c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgId]);
    });

    // Install two org-chart agents on different positions: one assigned a private task, one unassigned.
    const instA = await appRt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    const instB = await appRt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'crm.scheduler', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );

    // Creator creates an org-wide project and a private project (inviting invitedMember and invitedViewer).
    orgProjectId = (
      await appRt.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Dự án Công Khai', visibility: 'org' },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).projectId;

    privateProjectId = (
      await appRt.execute<{ projectId: string }>(
        'projects.project.create',
        {
          name: 'Dự án M&A Mật',
          visibility: 'private',
          memberUserIds: [users.invitedMember, users.invitedViewer],
        },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).projectId;

    // Tasks: one org-project task, one unlinked org task, one human private-project task, one assigned-agent private-project task.
    orgTaskId = (
      await appRt.execute<{ taskId: string }>(
        'projects.task.create',
        { projectId: orgProjectId, title: 'Việc công khai', assigneePositionId: null },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).taskId;

    unlinkedOrgTaskId = (
      await appRt.execute<{ taskId: string }>(
        'kernel.task.create',
        { title: 'Việc chưa gắn dự án', assigneePositionId: null },
        { actor: asUser(users.nonMemberMember), orgId, idempotencyKey: randomUUID() },
      )
    ).taskId;

    privateTaskId = (
      await appRt.execute<{ taskId: string }>(
        'projects.task.create',
        { projectId: privateProjectId, title: 'Đàm phán điều khoản mật', assigneePositionId: null },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).taskId;

    agentPrivateTaskId = (
      await appRt.execute<{ taskId: string }>(
        'projects.task.create',
        { projectId: privateProjectId, title: 'Kiểm tra hợp đồng giúp phòng M&A', assigneePositionId: instA.positionId },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).taskId;
    await appRt.execute(
      'projects.dependency.add',
      { projectId: privateProjectId, blockerTaskId: privateTaskId, blockedTaskId: agentPrivateTaskId },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );
    const initCols = await appRt.execute<{ columns: Array<{ id: string }> }>(
      'projects.column.init_defaults',
      { projectId: privateProjectId },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );
    privateColumnId = initCols.columns[0]!.id;
    const createdCycle = await appRt.execute<{ cycle: { id: string } }>(
      'projects.cycle.create',
      { projectId: privateProjectId, name: 'Chu kỳ Mật 1' },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );
    privateCycleId = createdCycle.cycle.id;

    // Seed comments on both org task and private task.
    await appRt.execute(
      'kernel.task.comment',
      { id: orgTaskId, body: 'Bình luận công khai' },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );
    await appRt.execute(
      'kernel.task.comment',
      { id: privateTaskId, body: 'Bình luận bí mật' },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );

    // Creator shares an org note linked to BOTH privateProject and privateTask (must NOT leak link rows or panel entries to non-members!).
    creatorOrgNoteId = (
      await appRt.execute<{ noteId: string }>(
        'notes.note.create',
        {
          title: 'Biên bản ghi nhớ dùng chung',
          body: 'Nội dung ghi chú công khai',
          visibility: 'org',
          link: { targetType: 'projects.project', targetId: privateProjectId },
        },
        { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
      )
    ).noteId;
    await appRt.execute(
      'notes.link.add',
      { noteId: creatorOrgNoteId, targetType: 'kernel.task', targetId: privateTaskId },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );
    await appRt.execute(
      'notes.link.add',
      { noteId: creatorOrgNoteId, targetType: 'projects.project', targetId: orgProjectId },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );

    // Non-member owns a note and a to-do for negative link insertion tests.
    nonMemberNoteId = (
      await appRt.execute<{ noteId: string }>(
        'notes.note.create',
        { title: 'Ghi chú riêng của non-member', visibility: 'private' },
        { actor: asUser(users.nonMemberMember), orgId, idempotencyKey: randomUUID() },
      )
    ).noteId;
    nonMemberTodoId = (
      await appRt.execute<{ todoId: string }>(
        'notes.todo.create',
        { title: 'Việc riêng của non-member', timeZone: 'Asia/Ho_Chi_Minh' },
        { actor: asUser(users.nonMemberMember), orgId, idempotencyKey: randomUUID() },
      )
    ).todoId;

    // Give instB an unlinked org task so its wakeup queue is live while holding zero private-project tasks.
    await appRt.execute(
      'kernel.task.create',
      { title: 'Việc công khai cho tác tử B', assigneePositionId: instB.positionId },
      { actor: asUser(users.creator), orgId, idempotencyKey: randomUUID() },
    );

    // Start live runs for org-chart agents, member_vy agents, and MCP member grants.
    const runA = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: instA.agentId },
      { actor: SYSTEM, orgId },
    );
    const runB = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: instB.agentId },
      { actor: SYSTEM, orgId },
    );
    if (!runA.runId || !runB.runId) {
      throw new Error(`Expected live agent runs, got runA=${runA.runId} runB=${runB.runId}`);
    }
    assignedAgent = { agentId: instA.agentId, positionId: instA.positionId, runId: runA.runId };
    unassignedAgent = { agentId: instB.agentId, positionId: instB.positionId, runId: runB.runId };

    await admin(async (c) => {
      orgCommentId = (
        await c.query<{ id: string }>(`SELECT id FROM crove_kernel.task_comment WHERE org_id = $1 AND task_id = $2`, [orgId, orgTaskId])
      ).rows[0]!.id;
      privateCommentId = (
        await c.query<{ id: string }>(`SELECT id FROM crove_kernel.task_comment WHERE org_id = $1 AND task_id = $2`, [orgId, privateTaskId])
      ).rows[0]!.id;

      const linkRows = (
        await c.query<{ id: string; target_type: string; target_id: string }>(
          `SELECT id, target_type, target_id FROM crove_notes.link WHERE org_id = $1 AND note_id = $2`,
          [orgId, creatorOrgNoteId],
        )
      ).rows;
      privateProjectLinkId = linkRows.find((r) => r.target_type === 'projects.project' && r.target_id === privateProjectId)!.id;
      privateTaskLinkId = linkRows.find((r) => r.target_type === 'kernel.task' && r.target_id === privateTaskId)!.id;
      orgProjectLinkId = linkRows.find((r) => r.target_type === 'projects.project' && r.target_id === orgProjectId)!.id;

      const feat = await aiRunFeature(c, 'notes.summary');
      const vyInvAgentId = randomUUID();
      const vyInvRunId = randomUUID();
      const vyNonAgentId = randomUUID();
      const vyNonRunId = randomUUID();
      for (const [uid, aid, rid, label] of [
        [users.invitedMember, vyInvAgentId, vyInvRunId, 'Vy invited'],
        [users.nonMemberMember, vyNonAgentId, vyNonRunId, 'Vy non-member'],
      ] as const) {
        await inContext(
          userActor(label, () => orgId, () => uid),
          async (uc) => {
            await uc.query(
              `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
               VALUES ($1, $2, 'kernel.member_vy', $3, 'member_vy', $4, $4)`,
              [orgId, aid, label, uid],
            );
            await uc.query(
              `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, started_at, expires_at${feat.cols})
               VALUES ($1, $2, $3, 'notes', 'running', now(), now() + interval '1 hour'${feat.vals})`,
              [orgId, rid, aid],
            );
          },
          true,
        );
      }
      vyInvited = { agentId: vyInvAgentId, runId: vyInvRunId };
      vyNonMember = { agentId: vyNonAgentId, runId: vyNonRunId };

      mcpInvitedGrantId = randomUUID();
      mcpNonMemberGrantId = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id) VALUES
           ($1, $2, $3, $4, 'MCP Inv', 'inv.example.com', ARRAY['ludy.read'], $5, now(), now() + interval '30 days', $3, 'member', $3),
           ($1, $6, $7, $8, 'MCP Non', 'non.example.com', ARRAY['ludy.read'], $9, now(), now() + interval '30 days', $7, 'member', $7)`,
        [
          orgId,
          mcpInvitedGrantId,
          users.invitedMember,
          `cli-${mcpInvitedGrantId}`,
          `oauth-${mcpInvitedGrantId}`,
          mcpNonMemberGrantId,
          users.nonMemberMember,
          `cli-${mcpNonMemberGrantId}`,
          `oauth-${mcpNonMemberGrantId}`,
        ],
      );
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces structural catalog invariants on every crove_projects table, crove_kernel.task, crove_notes.link, and helper routines', async () => {
    await admin(async (c) => {
      // Every table in crove_projects carrying project_id (plus crove_projects.project itself) must have RLS enabled
      // and a RESTRICTIVE FOR ALL policy named project_visibility.
      const { rows: projTables } = await c.query<{ table_name: string; relrowsecurity: boolean; has_policy: boolean }>(
        `SELECT t.relname AS table_name,
                t.relrowsecurity,
                EXISTS (
                  SELECT 1 FROM pg_catalog.pg_policy p
                   WHERE p.polrelid = t.oid
                     AND p.polname = 'project_visibility'
                     AND NOT p.polpermissive
                     AND p.polcmd = '*'
                ) AS has_policy
           FROM pg_catalog.pg_class t
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'crove_projects'
            AND t.relkind IN ('r', 'p')
            AND (
              t.relname = 'project'
              OR EXISTS (
                SELECT 1 FROM pg_catalog.pg_attribute a
                 WHERE a.attrelid = t.oid AND a.attname = 'project_id' AND NOT a.attisdropped
              )
            )
          ORDER BY t.relname`,
      );
      expect(projTables.map((r) => r.table_name)).toEqual(
        expect.arrayContaining([
          'project',
          'project_column',
          'project_cycle',
          'project_member',
          'project_task',
          'roadmap_board',
          'task_dependency',
          'time_entry',
        ]),
      );
      for (const row of projTables) {
        expect(row.relrowsecurity, `${row.table_name} RLS enabled`).toBe(true);
        expect(row.has_policy, `${row.table_name} RESTRICTIVE project_visibility policy`).toBe(true);
      }

      const { rows: roadmapTriggers } = await c.query<{ tg: string }>(
        `SELECT c.relname || '.' || tg.tgname AS tg
           FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crove_projects'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND ((c.relname = 'roadmap_board' AND tg.tgname = 'roadmap_board_guard_tr')
              OR (c.relname = 'project' AND tg.tgname = 'project_roadmap_privacy_guard_tr'))
          ORDER BY 1`,
      );
      expect(roadmapTriggers.map((r) => r.tg)).toEqual([
        'project.project_roadmap_privacy_guard_tr',
        'roadmap_board.roadmap_board_guard_tr',
      ]);

      const { rows: extPolicies } = await c.query<{ table_name: string; polname: string }>(
        `SELECT c.relname AS table_name, p.polname
           FROM pg_catalog.pg_policy p
           JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE ((n.nspname = 'crove_kernel' AND c.relname = 'task' AND p.polname = 'private_project_scope')
             OR  (n.nspname = 'crove_notes' AND c.relname = 'link' AND p.polname = 'link_private_project_scope')
             OR  (n.nspname = 'crove_sign' AND c.relname = 'envelope' AND p.polname = 'project_acceptance_org_only'))
            AND NOT p.polpermissive
            AND p.polcmd = '*'`,
      );
      expect(extPolicies.map((p) => `${p.table_name}.${p.polname}`).sort()).toEqual([
        'envelope.project_acceptance_org_only',
        'link.link_private_project_scope',
        'task.private_project_scope',
      ]);

      // Verify SECURITY DEFINER helpers pin search_path and limit direct EXECUTE ACL grants strictly to crove_tenant
      // (NOTE: crove_definer_tenant has GRANT crove_tenant WITH INHERIT, so check direct ACL grantees via aclexplode).
      const { rows: fns } = await c.query<{
        sig: string;
        prosecdef: boolean;
        provolatile: string;
        proconfig: string[] | null;
        def: string;
        pub_exec: boolean;
        auth_exec: boolean;
        tenant_exec: boolean;
        grantees: string[];
      }>(
        `SELECT p.oid::pg_catalog.regprocedure::text AS sig,
                p.prosecdef,
                p.provolatile,
                p.proconfig,
                pg_catalog.pg_get_functiondef(p.oid) AS def,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
                pg_catalog.has_function_privilege('crove_auth_reader', p.oid, 'EXECUTE') AS auth_exec,
                pg_catalog.has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant_exec,
                COALESCE(
                  (SELECT pg_catalog.array_agg(DISTINCT (
                     CASE WHEN x.grantee = 0 THEN 'PUBLIC'
                          ELSE (SELECT r.rolname FROM pg_catalog.pg_roles r WHERE r.oid = x.grantee)::text
                     END
                   )::text)
                     FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) x
                    WHERE x.grantee <> p.proowner),
                  '{}'::text[]
                ) AS grantees
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE (n.nspname = 'crove_projects' AND p.proname IN (
                   'actor_bypasses_private_projects',
                   'project_row_visible',
                   'project_visible',
                   'task_visible',
                   'project_acceptance_org_only',
                   'has_project_acceptance_envelope'
                 ))
             OR (n.nspname = 'crove_sign' AND p.proname = 'check_project_acceptance_source')
          ORDER BY 1`,
      );
      expect(fns).toHaveLength(7);
      for (const fn of fns) {
        expect(fn.prosecdef, `${fn.sig} SECURITY DEFINER`).toBe(true);
        if (fn.sig.includes('check_project_acceptance_source')) {
          expect(fn.provolatile, `${fn.sig} VOLATILE for FOR SHARE lock`).toBe('v');
        }
        expect(fn.proconfig, `${fn.sig} pinned search_path`).toContain('search_path=pg_catalog, pg_temp');
        expect(fn.def, `${fn.sig} preserves base acting-user / mcp pg_proc invariants`).not.toMatch(
          /ctx_acting_user_id|ctx_mcp_member_id/i,
        );
        expect(fn.pub_exec, `${fn.sig} revoked from PUBLIC`).toBe(false);
        expect(fn.auth_exec, `${fn.sig} revoked from crove_auth_reader`).toBe(false);
        expect(fn.tenant_exec, `${fn.sig} granted to crove_tenant`).toBe(true);
        expect(fn.grantees, `${fn.sig} direct grantees strictly limited to crove_tenant`).toEqual(['crove_tenant']);
      }

      const { rows: trigFns } = await c.query<{
        sig: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        pub_exec: boolean;
        def_exec: boolean;
        tenant_exec: boolean;
      }>(
        `SELECT p.oid::pg_catalog.regprocedure::text AS sig,
                p.prosecdef,
                p.proconfig,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
                pg_catalog.has_function_privilege('crove_definer_tenant', p.oid, 'EXECUTE') AS def_exec,
                pg_catalog.has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant_exec
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'crove_projects'
            AND p.proname IN ('project_no_private_with_acceptance', 'envelope_require_org_project')
          ORDER BY 1`,
      );
      expect(trigFns).toHaveLength(2);
      for (const tfn of trigFns) {
        expect(tfn.prosecdef, `${tfn.sig} SECURITY DEFINER`).toBe(true);
        expect(tfn.proconfig, `${tfn.sig} pinned search_path`).toContain('search_path=pg_catalog, pg_temp');
        expect(tfn.pub_exec, `${tfn.sig} revoked from PUBLIC`).toBe(false);
        expect(tfn.def_exec, `${tfn.sig} revoked from crove_definer_tenant`).toBe(false);
        expect(tfn.tenant_exec, `${tfn.sig} revoked from crove_tenant`).toBe(false);
      }
    });
  });

  it('enforces the ADR-0056 visibility matrix in raw PostgreSQL across every actor role and context kind', async () => {
    const cases: Array<{
      actor: ActorHandle;
      readsPrivateProject: boolean;
      readsPrivateHumanTask: boolean;
      readsPrivateAgentTask: boolean;
      readsOrgProject: boolean;
      readsOrgNoteLink: boolean;
    }> = [
      { actor: userActor('org owner', () => orgId, () => users.owner), readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: userActor('org admin', () => orgId, () => users.admin), readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: userActor('creator/owner', () => orgId, () => users.creator), readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: userActor('invited member', () => orgId, () => users.invitedMember), readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: true },
      // Viewers cannot read org-visible notes under crove_notes.note note_read RLS.
      { actor: userActor('invited viewer', () => orgId, () => users.invitedViewer), readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: userActor('non-member member', () => orgId, () => users.nonMemberMember), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: userActor('non-member viewer', () => orgId, () => users.nonMemberViewer), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: userActor('other org owner', () => otherOrgId, () => users.otherOrgOwner), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: false, readsOrgNoteLink: false },
      { actor: noContextActor, readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: false, readsOrgNoteLink: false },
      { actor: orgAgentActor('assigned org-chart agent', () => assignedAgent), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: orgAgentActor('unassigned org-chart agent', () => unassignedAgent), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: vyActor('member_vy (invited)', () => vyInvited), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: vyActor('member_vy (non-member)', () => vyNonMember), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: true },
      { actor: mcpActor('mcp_member (invited)', () => mcpInvitedGrantId), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: mcpActor('mcp_member (non-member)', () => mcpNonMemberGrantId), readsPrivateProject: false, readsPrivateHumanTask: false, readsPrivateAgentTask: false, readsOrgProject: true, readsOrgNoteLink: false },
      { actor: systemActor, readsPrivateProject: true, readsPrivateHumanTask: true, readsPrivateAgentTask: true, readsOrgProject: true, readsOrgNoteLink: true },
    ];

    for (const c of cases) {
      const seen = await inContext(c.actor, async (dbClient) => {
        const projects = (await dbClient.query<{ id: string }>('SELECT id FROM crove_projects.project WHERE NOT is_template')).rows.map((r) => r.id);
        const members = (await dbClient.query<{ project_id: string }>('SELECT project_id FROM crove_projects.project_member')).rows.map((r) => r.project_id);
        const projectTasks = (await dbClient.query<{ task_id: string }>('SELECT task_id FROM crove_projects.project_task')).rows.map((r) => r.task_id);
        const columns = (await dbClient.query<{ id: string }>('SELECT id FROM crove_projects.project_column')).rows.map((r) => r.id);
        const cycles = (await dbClient.query<{ id: string }>('SELECT id FROM crove_projects.project_cycle')).rows.map((r) => r.id);
        const dependencies = (await dbClient.query<{ project_id: string }>('SELECT project_id FROM crove_projects.task_dependency')).rows.map((r) => r.project_id);
        const tasks = (await dbClient.query<{ id: string }>('SELECT id FROM crove_kernel.task')).rows.map((r) => r.id);
        const comments = (await dbClient.query<{ id: string }>('SELECT id FROM crove_kernel.task_comment')).rows.map((r) => r.id);
        const links = (await dbClient.query<{ id: string }>('SELECT id FROM crove_notes.link')).rows.map((r) => r.id);
        return { projects, members, projectTasks, columns, cycles, dependencies, tasks, comments, links };
      });

      expect(seen.projects.includes(privateProjectId), `${c.actor.name}: project`).toBe(c.readsPrivateProject);
      expect(seen.members.includes(privateProjectId), `${c.actor.name}: project_member`).toBe(c.readsPrivateProject);
      expect(seen.projectTasks.includes(privateTaskId), `${c.actor.name}: project_task`).toBe(c.readsPrivateProject);
      expect(seen.columns.includes(privateColumnId), `${c.actor.name}: project_column`).toBe(c.readsPrivateProject);
      expect(seen.cycles.includes(privateCycleId), `${c.actor.name}: project_cycle`).toBe(c.readsPrivateProject);
      expect(seen.dependencies.includes(privateProjectId), `${c.actor.name}: task_dependency`).toBe(c.readsPrivateProject);
      expect(seen.tasks.includes(privateTaskId), `${c.actor.name}: human private task`).toBe(c.readsPrivateHumanTask);
      expect(seen.tasks.includes(agentPrivateTaskId), `${c.actor.name}: agent private task`).toBe(c.readsPrivateAgentTask);
      expect(seen.comments.includes(privateCommentId), `${c.actor.name}: private task_comment`).toBe(c.readsPrivateHumanTask);

      // Org project & its artifacts remain visible only within org.
      expect(seen.projects.includes(orgProjectId), `${c.actor.name}: org project`).toBe(c.readsOrgProject);
      expect(seen.tasks.includes(orgTaskId), `${c.actor.name}: org task`).toBe(c.readsOrgProject);
      expect(seen.comments.includes(orgCommentId), `${c.actor.name}: org comment`).toBe(c.readsOrgProject);

      // Links from creator's org-visible note are readable only when both the org note and the target are readable.
      expect(seen.links.includes(privateProjectLinkId), `${c.actor.name}: private project link`).toBe(
        c.readsOrgNoteLink && c.readsPrivateProject,
      );
      expect(seen.links.includes(privateTaskLinkId), `${c.actor.name}: private task link`).toBe(
        c.readsOrgNoteLink && c.readsPrivateHumanTask,
      );
      expect(seen.links.includes(orgProjectLinkId), `${c.actor.name}: org project link`).toBe(
        c.readsOrgNoteLink && c.readsOrgProject,
      );
    }
  });

  it('denies non-member SQL INSERT, UPDATE, and DELETE across project, project_member, project_task, task, task_comment, and crove_notes.link', async () => {
    const nonMembers = [
      userActor('non-member member', () => orgId, () => users.nonMemberMember),
      userActor('non-member viewer', () => orgId, () => users.nonMemberViewer),
    ];

    for (const actor of nonMembers) {
      const targetUid = actor.name.includes('viewer') ? users.nonMemberViewer : users.nonMemberMember;

      // Cannot insert a private project owned by someone else.
      const insProjOther = await attemptSql(
        actor,
        `INSERT INTO crove_projects.project (org_id, name, visibility, owner_user_id, created_by) VALUES ($1, 'Hack', 'private', $2, $3)`,
        [orgId, users.creator, targetUid],
      );
      expect(insProjOther).toMatchObject({ ok: false, code: '42501' });

      // Cannot update or delete the private project row.
      expect(await attemptSql(actor, `UPDATE crove_projects.project SET name = 'Pwned' WHERE org_id = $1 AND id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.project WHERE org_id = $1 AND id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      // Cannot self-add to project_member or mutate members.
      const insMem = await attemptSql(
        actor,
        `INSERT INTO crove_projects.project_member (org_id, project_id, user_id) VALUES ($1, $2, $3)`,
        [orgId, privateProjectId, targetUid],
      );
      expect(insMem).toMatchObject({ ok: false, code: '42501' });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.project_member WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      // Cannot attach an existing unlinked org task to a private project!
      const insPt = await attemptSql(
        actor,
        `INSERT INTO crove_projects.project_task (org_id, project_id, task_id, added_by) VALUES ($1, $2, $3, $4)`,
        [orgId, privateProjectId, unlinkedOrgTaskId, targetUid],
      );
      expect(insPt).toMatchObject({ ok: false, code: '42501' });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.project_task WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      // Cannot insert or delete dependency edges, columns, or cycles on a private project.
      const insDep = await attemptSql(
        actor,
        `INSERT INTO crove_projects.task_dependency (org_id, project_id, blocker_task_id, blocked_task_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [orgId, privateProjectId, agentPrivateTaskId, privateTaskId, targetUid],
      );
      expect(insDep).toMatchObject({ ok: false, code: '42501' });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.task_dependency WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      const insCol = await attemptSql(
        actor,
        `INSERT INTO crove_projects.project_column (org_id, project_id, name, task_status, sort_key) VALUES ($1, $2, $3, 'todo', 'zzzz')`,
        [orgId, privateProjectId, 'Hijack col'],
      );
      expect(insCol).toMatchObject({ ok: false, code: '42501' });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.project_column WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      const insCycle = await attemptSql(
        actor,
        `INSERT INTO crove_projects.project_cycle (org_id, project_id, number, name, starts_on, ends_on, created_by) VALUES ($1, $2, 99, $3, '2026-11-01', '2026-11-14', $4)`,
        [orgId, privateProjectId, 'Hijack cycle', targetUid],
      );
      expect(insCycle).toMatchObject({ ok: false, code: '42501' });
      expect(await attemptSql(actor, `DELETE FROM crove_projects.project_cycle WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      // Cannot link a private project to roadmap_board directly via SQL either (blocked by trigger/RLS).
      const insBoard = await attemptSql(
        actor,
        `INSERT INTO crove_projects.roadmap_board (org_id, slug, title, project_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [orgId, `hijack-board-${targetUid.slice(0, 6)}`, 'Hijack board', privateProjectId, targetUid],
      );
      expect(insBoard.ok).toBe(false);
      expect(['42501', '23514']).toContain((insBoard as { ok: false; code?: string }).code);
      expect(await attemptSql(actor, `DELETE FROM crove_projects.roadmap_board WHERE org_id = $1 AND project_id = $2`, [orgId, privateProjectId])).toEqual({ ok: true, rowCount: 0 });

      // Cannot update private task or insert comment on private task.
      expect(await attemptSql(actor, `UPDATE crove_kernel.task SET title = 'Tamper' WHERE org_id = $1 AND id = $2`, [orgId, privateTaskId])).toEqual({ ok: true, rowCount: 0 });
      const insComment = await attemptSql(
        actor,
        `INSERT INTO crove_kernel.task_comment (org_id, task_id, author_type, author_id, body) VALUES ($1, $2, 'user', $3, 'Sneak')`,
        [orgId, privateTaskId, targetUid],
      );
      expect(insComment).toMatchObject({ ok: false, code: '42501' });

      // Cannot link own note directly in SQL to the private project or private task.
      if (targetUid === users.nonMemberMember) {
        const insLinkProj = await attemptSql(
          actor,
          `INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, created_by) VALUES ($1, $2, 'projects.project', $3, $4)`,
          [orgId, nonMemberNoteId, privateProjectId, targetUid],
        );
        expect(insLinkProj).toMatchObject({ ok: false, code: '42501' });
        const insLinkTask = await attemptSql(
          actor,
          `INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, task_id, created_by) VALUES ($1, $2, 'kernel.task', $3, $3, $4)`,
          [orgId, nonMemberNoteId, privateTaskId, targetUid],
        );
        expect(insLinkTask).toMatchObject({ ok: false, code: '42501' });

        // Cannot attach a crove_sign.envelope to a private project directly in SQL.
        const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8'));
        const sha = sha256Hex(pdfBytes);
        const { fileId: signFileId } = await appRt.execute<{ fileId: string }>(
          'kernel.file.ingest',
          {
            filename: 'probe-acceptance.pdf',
            contentType: 'application/pdf',
            sizeBytes: pdfBytes.byteLength,
            sha256: sha,
            storageKey: fileKey(orgId, sha),
            generation: contentGeneration(sha),
            source: 'sign_document',
          },
          { actor: asUser(targetUid), orgId, idempotencyKey: randomUUID() },
        );
        const insEnv = await attemptSql(
          actor,
          `INSERT INTO crove_sign.envelope (org_id, title, status, routing_mode, source_kind, source_id, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
           VALUES ($1, 'Hack', 'draft', 'parallel', 'project_acceptance', $2, $3, $4, $5, $6, 'pending', $7)`,
          [orgId, privateProjectId, signFileId, fileKey(orgId, sha), contentGeneration(sha), sha, targetUid],
        );
        expect(insEnv).toMatchObject({ ok: false, code: '42501' });
      }
    }
  });

  it('lets an assigned org-chart agent work only its own seat private task and hides unassigned private tasks', async () => {
    const asAssigned: AgentActor = {
      type: 'agent',
      agentId: assignedAgent.agentId,
      runId: assignedAgent.runId,
    };
    const asUnassigned: AgentActor = {
      type: 'agent',
      agentId: unassignedAgent.agentId,
      runId: unassignedAgent.runId,
    };

    // Unassigned agent sees neither private task.
    const unList = await workerRt.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor: asUnassigned, orgId });
    expect(unList.tasks.map((t) => t.id)).not.toContain(agentPrivateTaskId);
    expect(unList.tasks.map((t) => t.id)).not.toContain(privateTaskId);
    await expect(
      workerRt.query('kernel.task.get', { id: agentPrivateTaskId }, { actor: asUnassigned, orgId }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    // Assigned agent sees only its assigned private task (not humanPrivateTaskId), and can checkout, comment, and complete it.
    const aList = await workerRt.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor: asAssigned, orgId });
    expect(aList.tasks.map((t) => t.id)).toContain(agentPrivateTaskId);
    expect(aList.tasks.map((t) => t.id)).not.toContain(privateTaskId);
    await expect(
      workerRt.query('kernel.task.get', { id: privateTaskId }, { actor: asAssigned, orgId }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    const checked = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: agentPrivateTaskId },
      { actor: asAssigned, orgId },
    );
    expect(Number(checked.fence)).toBeGreaterThanOrEqual(1);
    await workerRt.execute(
      'kernel.task.comment',
      { id: agentPrivateTaskId, body: 'Đã kiểm tra hợp đồng', fence: checked.fence },
      { actor: asAssigned, orgId },
    );
    await workerRt.execute(
      'kernel.task.set_status',
      { id: agentPrivateTaskId, status: 'done', fence: checked.fence },
      { actor: asAssigned, orgId },
    );

    // Org-chart agents are always rejected on projects.* commands/queries.
    await expect(
      workerRt.query('projects.project.list', {}, { actor: asAssigned, orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents cross-module RPC existence and content leaks across projects.*, kernel.task.*, and notes.*', async () => {
    for (const nonMemberId of [users.nonMemberMember, users.nonMemberViewer]) {
      const actor = asUser(nonMemberId);

      // projects.project.list omits private project.
      const list = await appRt.query<ProjectListResult>('projects.project.list', {}, { actor, orgId });
      expect(list.projects.map((p) => p.id)).toEqual([orgProjectId]);

      // Read/update queries/commands return 404 PROJECT_NOT_FOUND (or 403 FORBIDDEN for viewer-only write commands).
      await expect(appRt.query('projects.project.get', { id: privateProjectId }, { actor, orgId })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        status: 404,
      });
      await expect(appRt.query<ProjectBoard>('projects.board', { projectId: privateProjectId }, { actor, orgId })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        status: 404,
      });
      await expect(appRt.query('projects.timeline', { projectId: privateProjectId }, { actor, orgId })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        status: 404,
      });
      await expect(appRt.query('projects.cycle.list', { projectId: privateProjectId }, { actor, orgId })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        status: 404,
      });
      await expect(
        appRt.query('projects.cycle.metrics', { projectId: privateProjectId, cycleId: privateCycleId }, { actor, orgId }),
      ).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        status: 404,
      });
      await expect(
        appRt.query('projects.weekly_status_source', { projectId: privateProjectId }, { actor, orgId }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
      const expectedSeatErr = nonMemberId === users.nonMemberViewer ? { code: 'FORBIDDEN', status: 403 } : { code: 'PROJECT_NOT_FOUND', status: 404 };
      await expect(
        appRt.query('projects.tasks_from_note.seats', { projectId: privateProjectId }, { actor, orgId }),
      ).rejects.toMatchObject(expectedSeatErr);
      await expect(
        appRt.query('projects.tasks_from_source.seats', { projectId: privateProjectId }, { actor, orgId }),
      ).rejects.toMatchObject(expectedSeatErr);

      // projects.task_projects, projects.today, and projects.unassigned_tasks omit private project/tasks.
      const taskProjects = await appRt.query<ProjectTaskProjectEntry[]>(
        'projects.task_projects',
        { taskIds: [privateTaskId, orgTaskId] },
        { actor, orgId },
      );
      expect(taskProjects.map((e) => e.project.id)).toEqual([orgProjectId]);

      const unassigned = await appRt.query<ProjectCandidateTask[]>('projects.unassigned_tasks', {}, { actor, orgId });
      expect(unassigned.map((t) => t.id)).not.toContain(privateTaskId);

      const today = await appRt.query<TodayItem[]>('projects.today', {}, { actor, orgId });
      const serializedToday = JSON.stringify(today);
      expect(serializedToday).not.toContain(privateProjectId);
      expect(serializedToday).not.toContain(privateTaskId);

      // kernel.task.* hides private tasks cleanly (404 TASK_NOT_FOUND).
      const kernelList = await appRt.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor, orgId });
      expect(kernelList.tasks.map((t) => t.id)).not.toContain(privateTaskId);
      await expect(appRt.query('kernel.task.get', { id: privateTaskId }, { actor, orgId })).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
        status: 404,
      });

      // notes.record.panel must hide even org-visible notes linked to a private project or private task.
      const projPanel = await appRt.query<NoteRecordPanel>(
        'notes.record.panel',
        { targetType: 'projects.project', targetId: privateProjectId },
        { actor, orgId },
      );
      expect(projPanel).toEqual({ pinned: [], latest: [], todos: [] });
      const taskPanel = await appRt.query<NoteRecordPanel>(
        'notes.record.panel',
        { targetType: 'kernel.task', targetId: privateTaskId },
        { actor, orgId },
      );
      expect(taskPanel).toEqual({ pinned: [], latest: [], todos: [] });

      // Creator's org note itself omits links to private project / private task when read by non-member (viewers get 404 on org notes).
      if (nonMemberId === users.nonMemberMember) {
        const sharedNote = await appRt.query<Note>('notes.note.get', { noteId: creatorOrgNoteId }, { actor, orgId });
        expect(sharedNote.links.map((l) => l.targetId)).toEqual([orgProjectId]);
      } else {
        await expect(appRt.query<Note>('notes.note.get', { noteId: creatorOrgNoteId }, { actor, orgId })).rejects.toMatchObject({
          code: 'NOTE_NOT_FOUND',
          status: 404,
        });
      }
    }

    // Non-member writer RPC write rejections (404, never 403).
    const writerNonMember = asUser(users.nonMemberMember);
    await expect(
      appRt.execute(
        'projects.project.update',
        { projectId: privateProjectId, name: 'Hijack' },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'projects.column.create',
        { projectId: privateProjectId, name: 'Hijack Col', taskStatus: 'todo' },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'projects.cycle.create',
        { projectId: privateProjectId, name: 'Hijack Cycle' },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'projects.task.add',
        { projectId: privateProjectId, taskId: unlinkedOrgTaskId },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'projects.template.create',
        { name: 'Steal', sourceProjectId: privateProjectId },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'kernel.task.comment',
        { id: privateTaskId, body: 'Unauthorized' },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'notes.link.add',
        { noteId: nonMemberNoteId, targetType: 'projects.project', targetId: privateProjectId },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'notes.todo.link_add',
        { todoId: nonMemberTodoId, targetType: 'kernel.task', targetId: privateTaskId },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // Invited member sees the linked org note in notes.record.panel and on notes.note.get.
    const invitedPanel = await appRt.query<NoteRecordPanel>(
      'notes.record.panel',
      { targetType: 'projects.project', targetId: privateProjectId },
      { actor: asUser(users.invitedMember), orgId },
    );
    expect(invitedPanel.latest.map((n) => n.id)).toEqual([creatorOrgNoteId]);

    // Saving a private project as an org template (which forces visibility='org') or creating a shared eSign acceptance
    // envelope for it is forbidden even for members/owners; non-members see 404/403 (never private project metadata).
    const signCheckBytes = Uint8Array.from(Buffer.from('%PDF-1.4\n% priv-check\n%%EOF\n', 'utf8'));
    const signCheckSha = sha256Hex(signCheckBytes);
    const { fileId: ownerSignFileId } = await appRt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: 'owner-acceptance-check.pdf',
        contentType: 'application/pdf',
        sizeBytes: signCheckBytes.byteLength,
        sha256: signCheckSha,
        storageKey: fileKey(orgId, signCheckSha),
        generation: contentGeneration(signCheckSha),
        source: 'sign_document',
      },
      { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      appRt.query('sign.acceptance.source', { projectId: privateProjectId }, { actor: writerNonMember, orgId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      appRt.execute(
        'sign.envelope.create',
        { title: 'Leak via eSign', sourceKind: 'project_acceptance', sourceId: privateProjectId, sourceFileId: ownerSignFileId },
        { actor: writerNonMember, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    for (const allowedUserId of [users.invitedMember, users.owner]) {
      await expect(
        appRt.execute(
          'projects.template.create',
          { name: 'Steal', sourceProjectId: privateProjectId },
          { actor: asUser(allowedUserId), orgId, idempotencyKey: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PRIVATE_TEMPLATE_FORBIDDEN', status: 422 });
      await expect(
        appRt.query('sign.acceptance.source', { projectId: privateProjectId }, { actor: asUser(allowedUserId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN', status: 422 });
      await expect(
        appRt.query('sign.acceptance.ai_status', { projectId: privateProjectId }, { actor: asUser(allowedUserId), orgId }),
      ).rejects.toMatchObject({ code: 'SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN', status: 422 });
    }
    await expect(
      appRt.execute(
        'sign.envelope.create',
        { title: 'Private Acceptance', sourceKind: 'project_acceptance', sourceId: privateProjectId, sourceFileId: ownerSignFileId },
        { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN', status: 422 });

    // Standalone (projectId = null) and org-project roadmap boards work under RESTRICTIVE project_visibility, while
    // linking a private project fails cleanly.
    const { board: standaloneBoard } = await appRt.execute<{ board: { id: string } }>(
      'projects.roadmap.board.create',
      { title: 'Lộ trình độc lập', slug: 'priv-test-standalone', projectId: null },
      { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
    );
    const { board: orgRoadmapBoard } = await appRt.execute<{ board: { id: string } }>(
      'projects.roadmap.board.create',
      { title: 'Lộ trình dự án công khai', slug: 'priv-test-org', projectId: orgProjectId },
      { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      appRt.execute(
        'projects.roadmap.board.create',
        { title: 'Lộ trình dự án mật', slug: 'priv-test-private', projectId: privateProjectId },
        { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN', status: 422 });
    const visibleBoardIds = await inContext(
      userActor('nonMemberMember', () => orgId, () => users.nonMemberMember),
      async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_projects.roadmap_board ORDER BY created_at')).rows.map((r) => r.id),
    );
    expect(visibleBoardIds).toEqual(expect.arrayContaining([standaloneBoard.id, orgRoadmapBoard.id]));
  });

  it('allows system context cleanup/deletion on private projects and tasks', async () => {
    const deletableProjectId = (
      await appRt.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Dự án thử hệ thống', visibility: 'private' },
        { actor: asUser(users.owner), orgId, idempotencyKey: randomUUID() },
      )
    ).projectId;

    await inContext(systemActor, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `DELETE FROM crove_projects.project WHERE org_id = $1 AND id = $2 RETURNING id`,
        [orgId, deletableProjectId],
      );
      expect(rows.map((r) => r.id)).toEqual([deletableProjectId]);
    });
  });
});
