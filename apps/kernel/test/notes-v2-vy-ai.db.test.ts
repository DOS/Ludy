// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests for Notes v2 Vy daily planner (notes.todo_plan) and inbox organizer (notes.organize) against PG17 (#3563):
// verifies strict member RLS scoping, writer-only enforcement, vy.use entitlement, kill switches, budget exhaustion,
// AI_OFF resilience, zero automatic writes, zero plaintext in member_vy_result/audit/outbox, and caller 1-click apply.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  DEFAULT_TIME_ZONE,
  addTodoLocalDays,
  zonedDate,
  type NoteOrganizeResult,
  type TodoPlanResult,
} from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runNotesOrganize, runNotesTodoPlan, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const okMeter: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

const SECRET_TODO_TITLE = 'Bi mat: hoan thue cong ty X 2026';
const SECRET_NOTE_TITLE = 'Tai lieu hop rieng cua Carol';
const SECRET_NOTE_BODY = 'Mat khau noi bo khong duoc ro ri sang member khac';

suite('Notes v2 Vy daily planner & inbox organizer PG17 integration (#3563)', () => {
  const dbName = `crove_test_notes_v2_vy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let app: Runtime;

  const asUser = (userId: string, aal: 'aal1' | 'aal2' = 'aal1'): UserActor => ({
    type: 'user',
    userId,
    aal,
    ...(aal === 'aal2' ? { sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) } : {}),
  });

  async function sqlAdmin<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const res = await client.query<T>(text, values);
      return res.rows;
    } finally {
      await client.end();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const makePerson = async (name: string) => ({
      userId: await upsertIdentity(db, {
        issuer: 'notes-v2-vy',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@notes-v2-vy.test`,
        name: null,
      }),
    });
    const owner = await makePerson('owner');
    const alice = await makePerson('alice');
    const carol = await makePerson('carol');
    const viewer = await makePerson('viewer');
    const { orgId } = await createOrg(app, asUser(owner.userId), `Notes v2 Vy ${tag}`);

    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgId, alice.userId, carol.userId, viewer.userId],
    );

    const exec = <O>(userId: string, name: string, input: unknown = {}, aal: 'aal1' | 'aal2' = 'aal1') =>
      app.execute<O>(name, input, { actor: asUser(userId, aal), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      app.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, alice, carol, viewer, exec, query };
  }

  function makeDeps(model: ModelPort | null): MeetingSummaryDeps {
    return {
      runtime: app,
      model,
      meter: () => okMeter,
      budget: new DraftBudget({ perUserPerMinute: 30, perOrgPerMinute: 60 }),
      timeoutMs: 5_000,
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
    await setRolePasswords(adminUrl, {
      ludy_app: 'test-app-pw',
      ludy_worker: 'test-worker-pw',
    });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    pools.push(pool);
    db = createDb(pool);
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...notesQueries],
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

  it('scopes todo_plan and organize strictly to caller items, drops rogue cross-member IDs, stores counts only, and applies via caller commands', async () => {
    const { orgId, owner, alice, carol, viewer, exec, query } = await setupOrg();
    const today = zonedDate(DEFAULT_TIME_ZONE, Date.now());
    const yesterday = addTodoLocalDays(today, -1);
    const tomorrow = addTodoLocalDays(today, 1);

    // Seed Alice's overdue and open todos, plus Carol's private overdue todo & private unfiled note.
    const { todoId: aliceOverdueId } = await exec<{ todoId: string }>(alice.userId, 'notes.todo.create', {
      title: 'Nop bao cao tai chinh qua han',
      priority: 1,
      dueOn: yesterday,
      timeZone: DEFAULT_TIME_ZONE,
    });
    const { todoId: aliceTodayId } = await exec<{ todoId: string }>(alice.userId, 'notes.todo.create', {
      title: 'Goi dien chot hop dong A',
      priority: 2,
      dueOn: today,
      timeZone: DEFAULT_TIME_ZONE,
    });
    const { todoId: carolPrivateTodoId } = await exec<{ todoId: string }>(carol.userId, 'notes.todo.create', {
      title: SECRET_TODO_TITLE,
      priority: 1,
      dueOn: yesterday,
      timeZone: DEFAULT_TIME_ZONE,
    });

    const { notebookId: alicePrivateNbId } = await exec<{ notebookId: string }>(alice.userId, 'notes.notebook.create', {
      name: 'Tai chinh ca nhan',
      visibility: 'private',
    });
    const { notebookId: orgOpsNbId } = await exec<{ notebookId: string }>(owner.userId, 'notes.notebook.create', {
      name: 'Van hanh cong ty',
      visibility: 'org',
    });
    const { noteId: aliceUnfiledId } = await exec<{ noteId: string }>(alice.userId, 'notes.note.create', {
      title: 'Hoa don EVN thang 11',
      body: 'Can thanh toan hoa don dien truoc thu sau',
      visibility: 'private',
    });
    const { noteId: carolPrivateNoteId } = await exec<{ noteId: string }>(carol.userId, 'notes.note.create', {
      title: SECRET_NOTE_TITLE,
      body: SECRET_NOTE_BODY,
      visibility: 'private',
    });
    // Shared unfiled org note authored by Owner: member Alice must NEVER receive or edit it in organize,
    // while owner CAN move it into an org notebook (but NEVER into a private notebook).
    const { noteId: ownerOrgUnfiledId } = await exec<{ noteId: string }>(owner.userId, 'notes.note.create', {
      title: 'Thong bao noi bo',
      body: 'Lich nghi le chung cua cong ty',
      visibility: 'org',
    });

    const seenPrompts: string[] = [];
    const model: ModelPort = {
      generate: async (_who, prompt) => {
        seenPrompts.push(prompt.user);
        if (prompt.feature === 'notes.todo_plan') {
          return {
            text: JSON.stringify({
              focus: [
                { todoId: aliceOverdueId, reason: 'Qua han P1 can xu ly ngay' },
                { todoId: carolPrivateTodoId, reason: 'Rogue Carol todo must drop' },
                { todoId: aliceTodayId, reason: 'Viec trong ngay P2' },
              ],
              reschedules: [
                { todoId: aliceOverdueId, dueOn: tomorrow, reason: 'Doi sang ngay mai' },
                { todoId: carolPrivateTodoId, dueOn: tomorrow, reason: 'Rogue Carol reschedule' },
                { todoId: aliceTodayId, dueOn: tomorrow, reason: 'Today todo not overdue must drop' },
              ],
            }),
            usage: { inputTokens: 100, outputTokens: 60 },
          };
        }
        return {
          text: JSON.stringify({
            suggestions: [
              {
                noteId: aliceUnfiledId,
                notebookId: alicePrivateNbId,
                tags: ['#evn', 'hoa don'],
                reason: 'Thuoc tai chinh ca nhan',
              },
              {
                noteId: carolPrivateNoteId,
                notebookId: orgOpsNbId,
                tags: ['stolen'],
                reason: 'Rogue Carol private note',
              },
              {
                noteId: ownerOrgUnfiledId,
                notebookId: alicePrivateNbId,
                tags: ['should-drop-when-alice'],
                reason: 'Member Alice cannot see/organize Owner org note',
              },
            ],
          }),
          usage: { inputTokens: 120, outputTokens: 70 },
        };
      },
    };

    const deps = makeDeps(model);

    // 1. Alice runs todoPlan: prompts never saw Carol's secret todo, rogue Carol/non-overdue IDs dropped, zero DB writes.
    const planRes: TodoPlanResult = await runNotesTodoPlan(deps, orgId, asUser(alice.userId), {
      timeZone: DEFAULT_TIME_ZONE,
      language: 'vi',
    });
    expect(planRes.state).toBe('ready');
    expect(planRes.focus.map((f) => f.todoId)).toEqual([aliceOverdueId, aliceTodayId]);
    expect(planRes.reschedules).toEqual([
      expect.objectContaining({
        todoId: aliceOverdueId,
        currentDueOn: yesterday,
        dueOn: tomorrow,
      }),
    ]);
    expect(planRes.dropped).toBe(3);
    expect(seenPrompts.join('\n')).not.toContain(SECRET_TODO_TITLE);

    // Verify zero automatic DB mutations on todo during generation.
    const beforeReschedule = await query<{ dueOn: string | null; revision: number }>(alice.userId, 'notes.todo.get', {
      todoId: aliceOverdueId,
    });
    expect(beforeReschedule.dueOn).toBe(yesterday);
    expect(beforeReschedule.revision).toBe(1);

    // 2. Alice applies proposed reschedule via caller's own notes.todo.reschedule command.
    await exec(alice.userId, 'notes.todo.reschedule', { todoIds: [aliceOverdueId], dueOn: tomorrow });
    const afterReschedule = await query<{ dueOn: string | null; revision: number }>(alice.userId, 'notes.todo.get', {
      todoId: aliceOverdueId,
    });
    expect(afterReschedule.dueOn).toBe(tomorrow);
    expect(afterReschedule.revision).toBe(2);

    // 3. Alice runs organize: prompts never saw Carol's secret note OR Owner's org note (Alice is member, not owner/admin).
    seenPrompts.length = 0;
    const orgRes: NoteOrganizeResult = await runNotesOrganize(deps, orgId, asUser(alice.userId), { language: 'vi' });
    expect(orgRes.state).toBe('ready');
    expect(orgRes.suggestions).toEqual([
      expect.objectContaining({
        noteId: aliceUnfiledId,
        notebookId: alicePrivateNbId,
        tags: ['evn', 'hoa don'],
        canEditTags: true,
      }),
    ]);
    expect(orgRes.dropped).toBe(2);
    expect(seenPrompts.join('\n')).not.toContain(SECRET_NOTE_TITLE);
    expect(seenPrompts.join('\n')).not.toContain(SECRET_NOTE_BODY);
    expect(seenPrompts.join('\n')).not.toContain(ownerOrgUnfiledId);

    // Verify zero automatic DB writes on note during generation.
    const beforeOrganize = await query<{ notebookId: string | null; tags: string[]; revision: number }>(alice.userId, 'notes.note.get', {
      noteId: aliceUnfiledId,
    });
    expect(beforeOrganize.notebookId).toBeNull();
    expect(beforeOrganize.tags).toEqual([]);

    // 4. Alice applies proposal via caller's own notes.note.update command.
    await exec(alice.userId, 'notes.note.update', {
      noteId: aliceUnfiledId,
      revision: beforeOrganize.revision,
      notebookId: alicePrivateNbId,
      tags: ['evn', 'hoa don'],
    });
    const afterOrganize = await query<{ notebookId: string | null; tags: string[]; revision: number }>(alice.userId, 'notes.note.get', {
      noteId: aliceUnfiledId,
    });
    expect(afterOrganize.notebookId).toBe(alicePrivateNbId);
    expect(afterOrganize.tags).toEqual(['evn', 'hoa don']);

    // 5. Running organize again when Alice has no unfiled notes returns clean empty result with runId = null.
    const emptyOrg = await runNotesOrganize(deps, orgId, asUser(alice.userId), { language: 'vi' });
    expect(emptyOrg).toEqual({ state: 'ready', runId: null, suggestions: [], dropped: 0, errorCode: null });

    // 6. Verify member_vy_result stored counts only, NEVER plaintext titles/tags/reasons, and audit/outbox stayed clean.
    const storedResults = await sqlAdmin<{ feature: string; body: string | null; private_read: boolean }>(
      `SELECT feature, body, private_read FROM ludy_kernel.member_vy_result
       WHERE org_id = $1 AND feature IN ('notes.todo_plan', 'notes.organize')`,
      [orgId],
    );
    expect(storedResults).toHaveLength(2);
    for (const row of storedResults) {
      expect(row.private_read).toBe(true);
      expect(row.body).not.toContain('Hoa don EVN');
      expect(row.body).not.toContain('Nop bao cao');
      expect(row.body).not.toContain('Qua han P1');
    }

    // 7. Viewer is ALWAYS refused 403 FORBIDDEN even if explicitly granted vy.use.
    await exec(owner.userId, 'kernel.member.permission.set', { userId: viewer.userId, permission: 'vy.use', allowed: true }, 'aal2');
    await expect(runNotesTodoPlan(deps, orgId, asUser(viewer.userId), { timeZone: DEFAULT_TIME_ZONE })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(runNotesOrganize(deps, orgId, asUser(viewer.userId), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('enforces vy.use entitlement, kill switches, budget caps, mid-run AI_STOPPED, and AI_OFF without breaking manual Notes workflows', async () => {
    const { orgId, owner, alice, exec } = await setupOrg();
    const today = zonedDate(DEFAULT_TIME_ZONE, Date.now());
    const yesterday = addTodoLocalDays(today, -1);

    const { todoId } = await exec<{ todoId: string }>(alice.userId, 'notes.todo.create', {
      title: 'Kiem tra doanh thu',
      priority: 1,
      dueOn: yesterday,
      timeZone: DEFAULT_TIME_ZONE,
    });
    const { noteId } = await exec<{ noteId: string }>(alice.userId, 'notes.note.create', {
      title: 'Ghi chu chua phan loai',
      body: 'Noi dung cho kiem thu',
      visibility: 'private',
    });

    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 1. Revoking vy.use rejects with 403 VY_NOT_ALLOWED.
      await exec(owner.userId, 'kernel.member.permission.set', { userId: alice.userId, permission: 'vy.use', allowed: false }, 'aal2');
      const okModelDeps = makeDeps({
        generate: async () => ({
          text: '{"focus":[],"reschedules":[],"suggestions":[]}',
          usage: { inputTokens: 10, outputTokens: 10 },
        }),
      });
      await expect(runNotesTodoPlan(okModelDeps, orgId, asUser(alice.userId), { timeZone: DEFAULT_TIME_ZONE })).rejects.toMatchObject({
        code: 'VY_NOT_ALLOWED',
        status: 403,
      });
      await exec(owner.userId, 'kernel.member.permission.set', { userId: alice.userId, permission: 'vy.use', allowed: true }, 'aal2');

      // 2. AI_OFF (missing model) fails 422 while manual todo & note updates work normally.
      const noModelDeps = makeDeps(null);
      await expect(runNotesTodoPlan(noModelDeps, orgId, asUser(alice.userId), { timeZone: DEFAULT_TIME_ZONE })).rejects.toMatchObject({
        code: 'AI_OFF',
        status: 422,
      });
      await exec(alice.userId, 'notes.todo.reschedule', { todoIds: [todoId], dueOn: today });
      await exec(alice.userId, 'notes.note.update', { noteId, revision: 1, tags: ['thu'] });

      // 3. Budget exhausted rejects with 422 AI_BUDGET_EXHAUSTED.
      await sqlAdmin(
        `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, hard_stop, updated_by)
         VALUES ($1, 'module', 'notes', ludy_kernel.ai_budget_spent($1::uuid, 'module', 'notes'), true, $2)`,
        [orgId, owner.userId],
      );
      await expect(runNotesOrganize(okModelDeps, orgId, asUser(alice.userId), {})).rejects.toMatchObject({
        code: 'AI_BUDGET_EXHAUSTED',
        status: 422,
      });
      await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);

      // 4. Mid-run kill switch discards model output (AI_STOPPED) instead of returning proposals.
      let ksId = '';
      const stopMidRunDeps = makeDeps({
        generate: async (_who, prompt) => {
          const rows = await sqlAdmin<{ id: string }>(
            `INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'module', 'notes', $2) RETURNING id`,
            [orgId, owner.userId],
          );
          ksId = rows[0]?.id ?? '';
          if (prompt.feature === 'notes.organize') {
            return {
              text: JSON.stringify({ suggestions: [{ noteId, notebookId: null, tags: ['leak-tag'], reason: 'Should discard' }] }),
              usage: { inputTokens: 10, outputTokens: 10 },
            };
          }
          return { text: '{"focus":[],"reschedules":[]}', usage: { inputTokens: 10, outputTokens: 10 } };
        },
      });
      const stoppedRes = await runNotesOrganize(stopMidRunDeps, orgId, asUser(alice.userId), {});
      expect(stoppedRes).toEqual({ state: 'failed', runId: expect.any(String), suggestions: [], dropped: 0, errorCode: 'AI_STOPPED' });
      if (ksId) await sqlAdmin(`DELETE FROM ludy_kernel.kill_switch WHERE id = $1`, [ksId]);
    } finally {
      spyErr.mockRestore();
    }
  });
});
