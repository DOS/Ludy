// SPDX-License-Identifier: AGPL-3.0-only
// Notes N8 (#1677, ADR-0037, ADR-0049) end-to-end DB tests on PostgreSQL 17:
// 1. Monotonic taint trigger (ludy_notes.note.b_taint) and ludy_notes.todo taint immutability;
// 2. Member-scoped Vy summarize / suggestTodos / vyResults privacy and prompt-injection/HTML/date/cap guards;
// 3. Author-only note.accept_summary vs shared-note reader personal todo.accept_suggestions;
// 4. Revoked note readability hiding stored Vy results immediately, stale revisions, trash, AI controls & zero log/audit/outbox leakage.
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
  zonedDate,
  type Note,
  type NoteVyStatus,
  type NoteWritten,
  type Todo,
  type TodoAcceptSuggestionsResult,
  type TodoSummary,
} from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import {
  notesVyStatusOf,
  readNotesVyResults,
  runNotesSuggestTodos,
  runNotesSummarize,
  type MeetingSummaryDeps,
} from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { enterUser } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_NOTE_MARKER = 'BI_MAT_NOTE_DO_NOT_LEAK_1677';
const INJECTED_PHRASE = 'INJECTED_HTML_AND_LINK';

suite('Notes N8: member-scoped Vy summary, suggested to-dos, and monotonic taint on PostgreSQL 17 (#1677)', () => {
  const dbName = `crove_test_notes_n8_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let db: Db;

  const asUser = (userId: string, aal: 'aal1' | 'aal2' = 'aal1'): UserActor => ({
    type: 'user',
    userId,
    aal,
    ...(aal === 'aal2' ? { mfaAt: Math.floor(Date.now() / 1000) } : {}),
  });
  const okMeter: AiMeter = { admit: async () => undefined, record: async () => undefined };

  async function sqlAdmin<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<T>(text, params);
    } finally {
      await c.end();
    }
  }

  async function withTenantUser<T>(
    orgId: string,
    userId: string,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, userId, orgId);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  }

  async function withAdminUserCtx<T>(
    orgId: string,
    userId: string,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, userId, orgId);
      await c.query('RESET ROLE');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const makePerson = async (name: string) => {
      const userId = await upsertIdentity(db, {
        issuer: 'notes-n8',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@notes-n8.test`,
        name: null,
      });
      return { userId };
    };
    const owner = await makePerson('owner');
    const adminUser = await makePerson('admin');
    const alice = await makePerson('alice');
    const carol = await makePerson('carol');
    const viewer = await makePerson('viewer');
    const { orgId } = await createOrg(app, asUser(owner.userId), `Notes N8 ${tag}`);

    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, adminUser.userId, alice.userId, carol.userId, viewer.userId],
    );

    const exec = <O>(userId: string, name: string, input: unknown = {}, aal: 'aal1' | 'aal2' = 'aal1') =>
      app.execute<O>(name, input, { actor: asUser(userId, aal), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      app.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, adminUser, alice, carol, viewer, exec, query };
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
    const registered = {
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...notesQueries],
    };
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);

    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    pools.push(workerPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces monotonic taint on notes & to-dos and keeps private notes & AI outputs isolated from leaks', async () => {
    const { orgId, owner, adminUser, alice, carol, viewer, exec, query } = await setupOrg();
    const today = zonedDate('Asia/Ho_Chi_Minh', Date.now());

    const { noteId: privateNoteId } = await exec<{ noteId: string }>(alice.userId, 'notes.note.create', {
      title: 'Ghi chu hop khach hang A',
      body: [
        SECRET_NOTE_MARKER,
        'Hom nay goi anh Minh xac nhan bao gia Q4.',
        'Han 2026-12-20 nop ho so thue va ky hop dong.',
        'Gui tai lieu kem theo sau buoi hop.',
      ].join(' '),
      visibility: 'private',
    });

    const initialNote = await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId });
    expect(initialNote.tainted).toBe(false);

    // Carol cannot access Alice's private note before or after Vy runs; viewer cannot run Vy at all.
    let modelCalls = 0;
    const hostileModel: ModelPort = {
      generate: async (_who, prompt) => {
        modelCalls++;
        if (prompt.feature === 'notes.summary') {
          return {
            text: JSON.stringify({
              summary: `<script>alert(1)</script>Tom tat hop Q4 (${SECRET_NOTE_MARKER}) https://evil.invalid/x`,
              bullets: [
                `<img src=x onerror=alert(1)>Goi anh Minh xac nhan bao gia`,
                `[Click](https://evil.invalid) Nop ho so truoc 2026-12-20`,
                `   `,
              ],
            }),
            usage: { inputTokens: 80, outputTokens: 45 },
          };
        }
        // Return 12 suggestions, including invalid date, empty title, and injection links to test cap + pruning.
        return {
          text: JSON.stringify({
            suggestions: [
              { title: '<b>Goi anh Minh xac nhan bao gia</b>', details: 'Check https://evil.invalid', dueOn: today },
              { title: 'Nop ho so thue Q4', details: 'Ky du bo', dueOn: '2026-12-20' },
              { title: 'Chuan bi hop dong', details: 'Unground date test', dueOn: '2026-02-31' },
              { title: 'Hoan 5000 USD phi', details: '', dueOn: null },
              { title: '   ', details: 'Empty title should be dropped', dueOn: null },
              ...Array.from({ length: 8 }, (_, idx) => ({
                title: `Viec bo sung ${String.fromCharCode(65 + idx)}`,
                details: 'Theo ghi chu',
                dueOn: null,
              })),
            ],
          }),
          usage: { inputTokens: 90, outputTokens: 110 },
        };
      },
    };

    const logLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      }),
    );

    try {
      const deps = makeDeps(hostileModel);

      expect(await notesVyStatusOf(deps, orgId, asUser(viewer.userId))).toEqual({
        available: false,
        reason: 'forbidden',
        resetOn: null,
      });
      await expect(runNotesSummarize(deps, orgId, asUser(viewer.userId), { noteId: privateNoteId })).rejects.toMatchObject({
        code: 'VY_NOT_ALLOWED',
      });
      await expect(runNotesSuggestTodos(deps, orgId, asUser(carol.userId), { noteId: privateNoteId })).rejects.toMatchObject({
        code: 'NOTE_NOT_FOUND',
      });
      await expect(readNotesVyResults(deps, orgId, asUser(carol.userId), privateNoteId)).rejects.toMatchObject({
        code: 'NOTE_NOT_FOUND',
      });
      expect(modelCalls).toBe(0);

      // Alice runs summarize + suggestTodos; results stay uncommitted until explicit accept.
      const summaryOut = await runNotesSummarize(deps, orgId, asUser(alice.userId), {
        noteId: privateNoteId,
        language: 'vi',
      });
      expect(summaryOut.state).toBe('ready');
      expect(summaryOut.noteRevision).toBe(1);
      expect(summaryOut.stale).toBe(false);
      expect(summaryOut.dropped).toBe(1);
      expect(summaryOut.summary).not.toContain('<script>');
      expect(summaryOut.summary).not.toContain('https://evil.invalid');
      expect(summaryOut.bullets).toEqual([
        'Goi anh Minh xac nhan bao gia',
        'Click Nop ho so truoc 2026-12-20',
      ]);

      const todosOut = await runNotesSuggestTodos(deps, orgId, asUser(alice.userId), {
        noteId: privateNoteId,
        timeZone: 'Asia/Ho_Chi_Minh',
        language: 'vi',
      });
      expect(todosOut.state).toBe('ready');
      expect(todosOut.noteRevision).toBe(1);
      expect(todosOut.dropped).toBe(4);
      // Capped at 10; invalid calendar date 2026-02-31 stripped to null; ungrounded figure 5000 dropped; HTML & URL removed cleanly.
      expect(todosOut.suggestions).toHaveLength(10);
      expect(todosOut.suggestions[0]).toEqual({
        title: 'Goi anh Minh xac nhan bao gia',
        details: 'Check',
        dueOn: today,
      });
      expect(todosOut.suggestions[1]).toEqual({
        title: 'Nop ho so thue Q4',
        details: 'Ky du bo',
        dueOn: '2026-12-20',
      });
      expect(todosOut.suggestions[2]).toEqual({
        title: 'Chuan bi hop dong',
        details: 'Unground date test',
        dueOn: null,
      });

      // Stored member_vy_result rows are strictly private to Alice (private_read = true) and hidden from everyone else.
      for (const outsiderId of [owner.userId, adminUser.userId, carol.userId, viewer.userId]) {
        await expect(
          query(outsiderId, 'kernel.member_vy.result.get', { runId: summaryOut.runId }),
        ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
        await expect(
          query(outsiderId, 'kernel.member_vy.result.get', { runId: todosOut.runId }),
        ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
      }
      const fetchedByAlice = await readNotesVyResults(deps, orgId, asUser(alice.userId), privateNoteId);
      expect(fetchedByAlice.summary?.runId).toBe(summaryOut.runId);
      expect(fetchedByAlice.todoSuggest?.runId).toBe(todosOut.runId);

      // Before acceptance: note is NOT tainted and zero to-dos exist.
      expect((await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId })).tainted).toBe(false);
      expect(await query<TodoSummary[]>(alice.userId, 'notes.todo.list', { view: 'open' })).toEqual([]);

      // Manual edit before acceptance advances revision -> readNotesVyResults marks cached drafts stale: true.
      const beforeAcceptEdit = await exec<NoteWritten>(alice.userId, 'notes.note.update', {
        noteId: privateNoteId,
        revision: 1,
        title: 'Ghi chu hop khach hang A (ban 2)',
        body: initialNote.body,
        tags: [],
      });
      expect(beforeAcceptEdit.revision).toBe(2);
      const staleResults = await readNotesVyResults(deps, orgId, asUser(alice.userId), privateNoteId);
      expect(staleResults.summary?.stale).toBe(true);
      expect(staleResults.todoSuggest?.stale).toBe(true);

      // Author accepts summary in append mode -> revision bumps, HTML sanitized, tainted flips false -> true monotonically.
      const appended = await exec<NoteWritten>(alice.userId, 'notes.note.accept_summary', {
        noteId: privateNoteId,
        revision: 2,
        mode: 'append',
        summary: '<b>Tom tat da duyet</b>',
        bullets: ['<img src=x>Goi anh Minh', 'Nop ho so Q4'],
        runId: summaryOut.runId,
      });
      expect(appended.revision).toBe(3);

      const noteAfterAppend = await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId });
      expect(noteAfterAppend.tainted).toBe(true);
      expect(noteAfterAppend.body).toContain(SECRET_NOTE_MARKER);
      expect(noteAfterAppend.body).toContain('Tom tat da duyet');
      expect(noteAfterAppend.body).not.toContain('<b>');
      expect(noteAfterAppend.body).not.toContain('<img');

      // Persisted summary acceptance hides the applied run on subsequent readNotesVyResults, and replaying the same runId fails cleanly.
      const afterSummaryAccept = await readNotesVyResults(deps, orgId, asUser(alice.userId), privateNoteId);
      expect(afterSummaryAccept.summary).toBeNull();
      expect(afterSummaryAccept.todoSuggest?.runId).toBe(todosOut.runId);
      await expect(
        exec(alice.userId, 'notes.note.accept_summary', {
          noteId: privateNoteId,
          revision: 3,
          mode: 'append',
          summary: 'Duplicate apply',
          runId: summaryOut.runId,
        }),
      ).rejects.toMatchObject({ code: 'VY_RUN_ALREADY_ACCEPTED', status: 409 });

      // Stale revision on accept_summary is rejected cleanly with NOTE_REVISION_CONFLICT.
      await expect(
        exec(alice.userId, 'notes.note.accept_summary', {
          noteId: privateNoteId,
          revision: 2,
          mode: 'replace',
          summary: 'Stale write',
        }),
      ).rejects.toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409 });

      // Metadata-only edit (tags only, unchanged title/body) preserves tainted=true per #1679 guard!
      const afterMetaOnlyEdit = await exec<NoteWritten>(alice.userId, 'notes.note.update', {
        noteId: privateNoteId,
        revision: 3,
        title: noteAfterAppend.title,
        body: noteAfterAppend.body,
        tags: ['n8-meta'],
      });
      expect(afterMetaOnlyEdit.revision).toBe(4);
      expect((await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId })).tainted).toBe(true);

      // Author editing title or body clears tainted=false (#1679 rule); another accept_summary sets tainted=true again.
      const afterManualEdit = await exec<NoteWritten>(alice.userId, 'notes.note.update', {
        noteId: privateNoteId,
        revision: 4,
        title: 'Ghi chu hop khach hang A (da sua)',
        body: noteAfterAppend.body,
        tags: [],
      });
      expect(afterManualEdit.revision).toBe(5);
      expect((await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId })).tainted).toBe(false);

      // Replace mode also succeeds with a second Vy run, sets tainted=true again, preserves < and > comparisons, and keeps BOTH runIds blocked from replay.
      const summaryOut2 = await runNotesSummarize(deps, orgId, asUser(alice.userId), { noteId: privateNoteId });
      expect(summaryOut2.state).toBe('ready');
      const replaced = await exec<NoteWritten>(alice.userId, 'notes.note.accept_summary', {
        noteId: privateNoteId,
        revision: 5,
        mode: 'replace',
        summary: 'Ban tom tat thay the: keep stock < 10 boxes and cash > 20 VND.',
        bullets: ['Muc 1'],
        runId: summaryOut2.runId!,
      });
      expect(replaced.revision).toBe(6);
      const noteAfterReplace = await query<Note>(alice.userId, 'notes.note.get', { noteId: privateNoteId });
      expect(noteAfterReplace.body).toBe('Ban tom tat thay the: keep stock < 10 boxes and cash > 20 VND.\n\n- Muc 1');
      expect(noteAfterReplace.tainted).toBe(true);
      await expect(
        exec(alice.userId, 'notes.note.accept_summary', {
          noteId: privateNoteId,
          revision: 6,
          mode: 'append',
          summary: 'Replay earlier run R1',
          runId: summaryOut.runId!,
        }),
      ).rejects.toMatchObject({ code: 'VY_RUN_ALREADY_ACCEPTED', status: 409 });

      // DB trigger b_taint (#1679): clearing tainted = false without editing title or body fails with NOTES_TAINT_EDIT_REQUIRED;
      // non-author / out-of-context updates fail with NOTES_TAINT_AUTHOR_ONLY.
      await expect(
        withTenantUser(orgId, alice.userId, (c) =>
          c.query(`UPDATE ludy_notes.note SET tainted = false WHERE org_id = $1 AND id = $2`, [orgId, privateNoteId]),
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_EDIT_REQUIRED') });

      await expect(
        sqlAdmin(`UPDATE ludy_notes.note SET tainted = false WHERE org_id = $1 AND id = $2`, [orgId, privateNoteId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_AUTHOR_ONLY') });

      // DB trigger b_taint: non-author cannot flip tainted on an untainted note even if RLS were bypassed!
      const { noteId: untaintedNoteId } = await exec<{ noteId: string }>(alice.userId, 'notes.note.create', {
        title: 'Untainted shared note',
        body: 'Manual text only.',
        visibility: 'org',
      });
      await expect(
        withAdminUserCtx(orgId, owner.userId, (c) =>
          c.query(`UPDATE ludy_notes.note SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, untaintedNoteId]),
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_AUTHOR_ONLY') });

      // Author CAN set tainted false -> true under ludy_tenant (trigger allows author false -> true).
      await expect(
        withTenantUser(orgId, alice.userId, (c) =>
          c.query(`UPDATE ludy_notes.note SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, untaintedNoteId]),
        ),
      ).resolves.toBeTruthy();

      // Accept suggested personal to-dos for Alice -> creates private tainted to-dos linked via source_note_id.
      const acceptedTodos = await exec<TodoAcceptSuggestionsResult>(alice.userId, 'notes.todo.accept_suggestions', {
        noteId: privateNoteId,
        noteRevision: 6,
        runId: todosOut.runId,
        items: [
          {
            title: `Goi anh Minh chot gia ${INJECTED_PHRASE}`,
            details: 'Kem PDF ky',
            dueOn: today,
            dueTime: '09:30',
            timeZone: 'Asia/Ho_Chi_Minh',
            reminder: 'auto',
          },
          {
            title: 'Nop ho so thue Q4',
            details: '',
            dueOn: '2026-12-20',
            dueTime: null,
            timeZone: 'Asia/Ho_Chi_Minh',
            reminder: 'off',
          },
        ],
      });
      expect(acceptedTodos.created).toBe(2);
      expect(acceptedTodos.todoIds).toHaveLength(2);

      // Accepted to-do run stays hidden across reload/navigation and cannot be replayed to duplicate to-dos.
      const afterTodosAccept = await readNotesVyResults(deps, orgId, asUser(alice.userId), privateNoteId);
      expect(afterTodosAccept.todoSuggest).toBeNull();
      await expect(
        exec(alice.userId, 'notes.todo.accept_suggestions', {
          noteId: privateNoteId,
          noteRevision: 6,
          runId: todosOut.runId,
          items: [{ title: 'Duplicate todo batch' }],
        }),
      ).rejects.toMatchObject({ code: 'VY_RUN_ALREADY_ACCEPTED', status: 409 });

      // Soft-deleting a note immediately hides stored Vy results and blocks acceptance; permanent deletion immediately purges member_vy_result rows via note_discard_vy_tr and makes readNotesVyResults reject with NOTE_NOT_FOUND (#3453).
      const trashNote = await exec<NoteWritten>(owner.userId, 'notes.note.create', {
        title: 'Ghi chu chuan bi dua vao thung rac',
        body: 'Noi dung bi xoa khoi danh sach chinh.',
        visibility: 'private',
      });
      const trashSum = await runNotesSummarize(deps, orgId, asUser(owner.userId), { noteId: trashNote.noteId });
      const trashTodos = await runNotesSuggestTodos(deps, orgId, asUser(owner.userId), { noteId: trashNote.noteId });
      expect(trashSum.state).toBe('ready');
      expect(trashTodos.state).toBe('ready');
      const deletedTrashNote = await exec<NoteWritten>(owner.userId, 'notes.note.delete', {
        noteId: trashNote.noteId,
      });
      expect(await readNotesVyResults(deps, orgId, asUser(owner.userId), trashNote.noteId)).toEqual({
        noteId: trashNote.noteId,
        summary: null,
        todoSuggest: null,
      });
      await expect(
        exec(owner.userId, 'notes.note.accept_summary', {
          noteId: trashNote.noteId,
          revision: deletedTrashNote.revision,
          mode: 'append',
          summary: 'Trashed apply',
          runId: trashSum.runId!,
        }),
      ).rejects.toMatchObject({ code: 'NOTE_IN_TRASH', status: 409 });
      await sqlAdmin(`DELETE FROM ludy_notes.note WHERE org_id = $1 AND id = $2`, [orgId, trashNote.noteId]);
      const leftoverAfterHardDelete = await sqlAdmin<{ n: number }>(
        `SELECT count(*)::int AS n FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
        [orgId, trashNote.noteId],
      );
      expect(leftoverAfterHardDelete.rows[0]?.n).toBe(0);
      await expect(readNotesVyResults(deps, orgId, asUser(owner.userId), trashNote.noteId)).rejects.toMatchObject({
        code: 'NOTE_NOT_FOUND',
      });

      const aliceTodos = await query<TodoSummary[]>(alice.userId, 'notes.todo.list', { view: 'open' });
      expect(aliceTodos).toHaveLength(2);
      for (const todo of aliceTodos) {
        expect(todo.tainted).toBe(true);
        expect(todo.sourceNoteId).toBe(privateNoteId);
      }
      const firstTodoDetail = await query<Todo>(alice.userId, 'notes.todo.get', {
        todoId: acceptedTodos.todoIds[0]!,
      });
      expect(firstTodoDetail.tainted).toBe(true);
      expect(firstTodoDetail.sourceNoteId).toBe(privateNoteId);
      expect(firstTodoDetail.remindAt).toBeTruthy();

      // Manual edit on suggested to-do preserves tainted = true, and ludy_tenant still cannot UPDATE tainted directly.
      await exec(alice.userId, 'notes.todo.update', {
        todoId: acceptedTodos.todoIds[0]!,
        revision: firstTodoDetail.revision,
        title: 'Goi anh Minh chot gia (da sua)',
        details: firstTodoDetail.details,
        checklist: firstTodoDetail.checklist,
        dueOn: firstTodoDetail.dueOn,
        dueTime: firstTodoDetail.dueTime,
        timeZone: firstTodoDetail.timeZone,
      });
      expect(
        (await query<Todo>(alice.userId, 'notes.todo.get', { todoId: acceptedTodos.todoIds[0]! })).tainted,
      ).toBe(true);
      await expect(
        withTenantUser(orgId, alice.userId, (c) =>
          c.query(`UPDATE ludy_notes.todo SET tainted = false WHERE org_id = $1 AND id = $2`, [
            orgId,
            acceptedTodos.todoIds[0]!,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // Outsiders never see Alice's personal to-dos.
      expect(await query<TodoSummary[]>(carol.userId, 'notes.todo.list', { view: 'open' })).toEqual([]);
      expect(await query<TodoSummary[]>(owner.userId, 'notes.todo.list', { view: 'open' })).toEqual([]);

      // Zero note, summary, or to-do text in console logs, audit events, or outbox events!
      const auditRows = await sqlAdmin(`SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1`, [orgId]);
      const outboxRows = await sqlAdmin(`SELECT * FROM ludy_kernel.outbox_event WHERE org_id = $1`, [orgId]);
      const leaksBlob = JSON.stringify({
        logs: logLines,
        audits: auditRows.rows,
        outbox: outboxRows.rows,
      });
      expect(leaksBlob).not.toContain(SECRET_NOTE_MARKER);
      expect(leaksBlob).not.toContain('Tom tat da duyet');
      expect(leaksBlob).not.toContain('Ban tom tat thay the');
      expect(leaksBlob).not.toContain('Goi anh Minh chot gia');
      expect(leaksBlob).not.toContain(INJECTED_PHRASE);
      expect(leaksBlob).not.toContain('Nop ho so thue Q4');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('handles shared org notes, revocation hiding vyResults immediately, kill switches, budget, permissions, trash & MODULE_OFF', async () => {
    const { orgId, owner, adminUser, alice, carol, viewer, exec, query } = await setupOrg();

    // Owner writes a shared org note.
    const { noteId: sharedNoteId } = await exec<{ noteId: string }>(owner.userId, 'notes.note.create', {
      title: 'Ke hoach tuan moi',
      body: 'Alice gui bao cao doanh thu thu Nam.',
      visibility: 'org',
    });

    let calls = 0;
    const model: ModelPort = {
      generate: async (_who, prompt) => {
        calls++;
        if (prompt.feature === 'notes.summary') {
          return {
            text: JSON.stringify({ summary: 'Tong hop ke hoach tuan moi.', bullets: ['Gui bao cao thu Nam'] }),
            usage: { inputTokens: 30, outputTokens: 20 },
          };
        }
        return {
          text: JSON.stringify({
            suggestions: [{ title: 'Gui bao cao doanh thu', details: 'Truoc thu Nam', dueOn: '2026-12-20' }],
          }),
          usage: { inputTokens: 30, outputTokens: 25 },
        };
      },
    };
    const deps = makeDeps(model);

    // Non-author Alice CAN read summary & suggest personal to-dos for herself on shared note,
    // CAN save personal to-dos (private to Alice!), and CANNOT insert summary into Owner's note.
    const aliceSum = await runNotesSummarize(deps, orgId, asUser(alice.userId), { noteId: sharedNoteId });
    const aliceTodos = await runNotesSuggestTodos(deps, orgId, asUser(alice.userId), { noteId: sharedNoteId });
    expect(aliceSum.state).toBe('ready');
    expect(aliceTodos.state).toBe('ready');

    await expect(
      exec(alice.userId, 'notes.note.accept_summary', {
        noteId: sharedNoteId,
        revision: 1,
        mode: 'append',
        summary: 'Non-author should fail',
      }),
    ).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY', status: 403 });

    const beforeSave = await readNotesVyResults(deps, orgId, asUser(alice.userId), sharedNoteId);
    expect(beforeSave.summary?.summary).toBe('Tong hop ke hoach tuan moi.');
    expect(beforeSave.todoSuggest?.suggestions).toHaveLength(1);

    const aliceSaved = await exec<TodoAcceptSuggestionsResult>(alice.userId, 'notes.todo.accept_suggestions', {
      noteId: sharedNoteId,
      noteRevision: 1,
      runId: aliceTodos.runId,
      items: [{ title: 'Gui bao cao doanh thu', dueOn: '2026-12-20', reminder: 'auto' }],
    });
    expect(aliceSaved.created).toBe(1);
    expect(await query<TodoSummary[]>(owner.userId, 'notes.todo.list', { view: 'open' })).toEqual([]);
    expect((await query<TodoSummary[]>(alice.userId, 'notes.todo.list', { view: 'open' }))[0]?.sourceNoteId).toBe(
      sharedNoteId,
    );

    // After accepting to-dos, summary remains readable while accepted todoSuggest stays hidden across reloads.
    const beforeRevoke = await readNotesVyResults(deps, orgId, asUser(alice.userId), sharedNoteId);
    expect(beforeRevoke.summary?.summary).toBe('Tong hop ke hoach tuan moi.');
    expect(beforeRevoke.todoSuggest).toBeNull();

    // Owner makes the shared note private -> Alice IMMEDIATELY loses access to stored Vy results AND cannot run again!
    await exec(owner.userId, 'notes.note.set_visibility', { noteId: sharedNoteId, visibility: 'private' });
    await expect(readNotesVyResults(deps, orgId, asUser(alice.userId), sharedNoteId)).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    await expect(
      exec(alice.userId, 'notes.todo.accept_suggestions', {
        noteId: sharedNoteId,
        noteRevision: 2,
        items: [{ title: 'Should fail after revoke' }],
      }),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });

    // Share again, then trash -> non-author sees NOTE_NOT_FOUND; author sees NOTE_IN_TRASH cleanly.
    await exec(owner.userId, 'notes.note.set_visibility', { noteId: sharedNoteId, visibility: 'org' });
    await exec(owner.userId, 'notes.note.delete', { noteId: sharedNoteId });
    await expect(runNotesSummarize(deps, orgId, asUser(owner.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'NOTE_IN_TRASH',
    });
    await expect(
      exec(owner.userId, 'notes.note.accept_summary', {
        noteId: sharedNoteId,
        revision: 3,
        mode: 'append',
        summary: 'Trashed note',
      }),
    ).rejects.toMatchObject({ code: 'NOTE_IN_TRASH' });
    await expect(
      exec(owner.userId, 'notes.todo.accept_suggestions', {
        noteId: sharedNoteId,
        noteRevision: 3,
        items: [{ title: 'Trashed note todo' }],
      }),
    ).rejects.toMatchObject({ code: 'NOTE_IN_TRASH' });

    await exec(owner.userId, 'notes.note.restore', { noteId: sharedNoteId });

    // No model configured -> reason 'off', runs reject AI_OFF.
    expect(await notesVyStatusOf(makeDeps(null), orgId, asUser(alice.userId))).toEqual({
      available: false,
      reason: 'off',
      resetOn: null,
    });
    await expect(runNotesSummarize(makeDeps(null), orgId, asUser(alice.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'AI_OFF',
    });

    const callsBeforeControls = calls;

    // Org, module:notes, and member_vy agent kill switches stop Vy while manual notes & todos keep working.
    const aliceAgentId = (
      await sqlAdmin<{ id: string }>(
        `SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`,
        [orgId, alice.userId],
      )
    ).rows[0]!.id;

    for (const [scope, target] of [
      ['org', '*'],
      ['module', 'notes'],
      ['agent', aliceAgentId],
    ] as const) {
      const ksId = (
        await sqlAdmin<{ id: string }>(
          `INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [orgId, scope, target, owner.userId],
        )
      ).rows[0]!.id;
      try {
        expect(await notesVyStatusOf(deps, orgId, asUser(alice.userId))).toEqual({
          available: false,
          reason: 'paused',
          resetOn: null,
        });
        await expect(runNotesSuggestTodos(deps, orgId, asUser(alice.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
          code: 'AI_PAUSED',
        });
      } finally {
        await sqlAdmin(`DELETE FROM ludy_kernel.kill_switch WHERE id = $1`, [ksId]);
      }
    }

    // Budget exhausted on module:notes -> reason 'budget' with reset date YYYY-MM-01, while manual notes/to-dos work.
    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, hard_stop, updated_by)
       VALUES ($1, 'module', 'notes', ludy_kernel.ai_budget_spent($1::uuid, 'module', 'notes'), true, $2)`,
      [orgId, owner.userId],
    );
    try {
      const budgetStatus: NoteVyStatus = await notesVyStatusOf(deps, orgId, asUser(alice.userId));
      expect(budgetStatus.available).toBe(false);
      expect(budgetStatus.reason).toBe('budget');
      expect(budgetStatus.resetOn).toMatch(/^\d{4}-\d{2}-01$/);
      await expect(runNotesSummarize(deps, orgId, asUser(alice.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
        code: 'AI_BUDGET_EXHAUSTED',
      });
      // Manual create note & todo keep working with AI budget exhausted.
      const manualTodo = await exec<{ todoId: string }>(alice.userId, 'notes.todo.create', {
        title: 'Viec tu tao khi AI het ngan sach',
      });
      expect(manualTodo.todoId).toBeTruthy();
    } finally {
      await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    }

    // Revoking vy.use stops Carol; pausing Alice's member_vy agent stops Alice without calling model.
    await exec(
      owner.userId,
      'kernel.member.permission.set',
      { userId: carol.userId, permission: 'vy.use', allowed: false },
      'aal2',
    );
    expect(await notesVyStatusOf(deps, orgId, asUser(carol.userId))).toEqual({
      available: false,
      reason: 'forbidden',
      resetOn: null,
    });
    await expect(runNotesSummarize(deps, orgId, asUser(carol.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'VY_NOT_ALLOWED',
    });

    await exec(owner.userId, 'kernel.agent.update', { id: aliceAgentId, status: 'paused' }, 'aal2');
    try {
      expect(await notesVyStatusOf(deps, orgId, asUser(alice.userId))).toEqual({
        available: false,
        reason: 'forbidden',
        resetOn: null,
      });
      await expect(runNotesSuggestTodos(deps, orgId, asUser(alice.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
        code: 'VY_NOT_ALLOWED',
      });
    } finally {
      await exec(owner.userId, 'kernel.agent.update', { id: aliceAgentId, status: 'active' }, 'aal2');
    }

    // Admin can still call readNotesVyResults for zero results if they haven't run Vy (null summary & null todoSuggest).
    // A viewer without vy.use is refused; a viewer WITH explicit vy.use grant can use read-only Vy on shared org notes
    // while still blocked (FORBIDDEN 403) from accept_summary and accept_suggestions.
    expect(await readNotesVyResults(deps, orgId, asUser(adminUser.userId), sharedNoteId)).toEqual({
      noteId: sharedNoteId,
      summary: null,
      todoSuggest: null,
    });
    expect(await notesVyStatusOf(deps, orgId, asUser(viewer.userId))).toEqual({
      available: false,
      reason: 'forbidden',
      resetOn: null,
    });
    expect(calls).toBe(callsBeforeControls);

    // Owner creates a note for Carol while she is a member? Better: Carol (member) creates a note first, then gets demoted to viewer.
    await exec(owner.userId, 'kernel.member.permission.set', { userId: carol.userId, permission: 'vy.use', allowed: true }, 'aal2');
    const { noteId: carolNoteId } = await exec<{ noteId: string }>(carol.userId, 'notes.note.create', {
      title: 'Ghi chu rieng cua Carol',
      body: 'Carol tong hop tai lieu hop dong truoc thu Sau.',
      visibility: 'private',
    });
    await sqlAdmin(`UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [
      orgId,
      carol.userId,
    ]);
    await exec(owner.userId, 'kernel.member.permission.set', { userId: carol.userId, permission: 'vy.use', allowed: false }, 'aal2');
    expect(await notesVyStatusOf(deps, orgId, asUser(carol.userId))).toEqual({
      available: false,
      reason: 'forbidden',
      resetOn: null,
    });

    await exec(owner.userId, 'kernel.member.permission.set', { userId: carol.userId, permission: 'vy.use', allowed: true }, 'aal2');
    expect(await notesVyStatusOf(deps, orgId, asUser(carol.userId))).toEqual({
      available: true,
      reason: null,
      resetOn: null,
    });
    const carolViewerSum = await runNotesSummarize(deps, orgId, asUser(carol.userId), { noteId: carolNoteId });
    expect(carolViewerSum.state).toBe('ready');
    const carolViewerTodos = await runNotesSuggestTodos(deps, orgId, asUser(carol.userId), { noteId: carolNoteId });
    expect(carolViewerTodos.state).toBe('ready');
    // Viewer only reads what a viewer reads (own notes; cannot read another member's shared org note) and cannot write.
    await expect(runNotesSummarize(deps, orgId, asUser(carol.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    await expect(
      exec(carol.userId, 'notes.note.accept_summary', {
        noteId: carolNoteId,
        revision: 1,
        mode: 'append',
        summary: 'Viewer write blocked',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      exec(carol.userId, 'notes.todo.accept_suggestions', {
        noteId: carolNoteId,
        noteRevision: 1,
        items: [{ title: 'Viewer todo blocked' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await exec(owner.userId, 'kernel.member.permission.set', { userId: carol.userId, permission: 'vy.use', allowed: false }, 'aal2');

    // Mid-flight access revocation while model.generate is running must refuse and must NOT store a ready result.
    let revokedCalls = 0;
    const revokingDeps = makeDeps({
      generate: async (_who, prompt) => {
        revokedCalls++;
        if (revokedCalls === 1) {
          await exec(owner.userId, 'notes.note.set_visibility', { noteId: sharedNoteId, visibility: 'private' });
        } else {
          await exec(owner.userId, 'notes.note.delete', { noteId: sharedNoteId });
        }
        return {
          text:
            prompt.feature === 'notes.summary'
              ? JSON.stringify({ summary: 'Leaked summary after revoke', bullets: [] })
              : JSON.stringify({ suggestions: [{ title: 'Leaked todo after revoke', dueOn: null }] }),
          usage: { inputTokens: 20, outputTokens: 20 },
        };
      },
    });
    await expect(runNotesSummarize(revokingDeps, orgId, asUser(alice.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    await exec(owner.userId, 'notes.note.set_visibility', { noteId: sharedNoteId, visibility: 'org' });
    await expect(runNotesSuggestTodos(revokingDeps, orgId, asUser(owner.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'NOTE_IN_TRASH',
    });
    const staleRevokedRows = await sqlAdmin<{ body: string | null; status: string; error_code: string | null }>(
      `SELECT r.body, r.status, r.error_code
         FROM ludy_kernel.member_vy_result r
        WHERE r.org_id = $1 AND r.subject_id = $2
        ORDER BY r.created_at DESC LIMIT 2`,
      [orgId, sharedNoteId],
    );
    expect(staleRevokedRows.rows.map((r) => [r.status, r.body, r.error_code])).toEqual([
      ['failed', null, 'NOTE_IN_TRASH'],
      ['failed', null, 'NOTE_NOT_FOUND'],
    ]);
    await exec(owner.userId, 'notes.note.restore', { noteId: sharedNoteId });

    // ADR-0053: disabling notes module refuses status, runs, and acceptance commands cleanly with MODULE_OFF.
    await exec(owner.userId, 'kernel.org.set_app', { module: 'notes', enabled: false });
    await expect(notesVyStatusOf(deps, orgId, asUser(owner.userId))).rejects.toMatchObject({
      code: 'MODULE_OFF',
      status: 404,
      details: { module: 'notes' },
    });
    await expect(runNotesSummarize(deps, orgId, asUser(owner.userId), { noteId: sharedNoteId })).rejects.toMatchObject({
      code: 'MODULE_OFF',
      status: 404,
      details: { module: 'notes' },
    });
    await expect(
      exec(owner.userId, 'notes.note.accept_summary', {
        noteId: sharedNoteId,
        revision: 3,
        mode: 'append',
        summary: 'Module off',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_OFF', details: { module: 'notes' } });
    await expect(
      exec(alice.userId, 'notes.todo.accept_suggestions', {
        noteId: sharedNoteId,
        noteRevision: 3,
        items: [{ title: 'Module off todo' }],
      }),
    ).rejects.toMatchObject({ code: 'MODULE_OFF', details: { module: 'notes' } });
  });

  it('immediately purges member_vy_result rows and cancels running Vy runs on note trash purge or delete without touching other notes or orgs (#3453)', async () => {
    const org1 = await setupOrg();
    const org2 = await setupOrg();

    const model: ModelPort = {
      generate: async (_who, prompt) => {
        if (prompt.feature === 'notes.summary') {
          return {
            text: JSON.stringify({ summary: 'Tom tat ngan gon.', bullets: ['Diem chinh 1'] }),
            usage: { inputTokens: 20, outputTokens: 15 },
          };
        }
        return {
          text: JSON.stringify({ suggestions: [] }),
          usage: { inputTokens: 15, outputTokens: 10 },
        };
      },
    };
    const deps = makeDeps(model);

    const targetNote = await org1.exec<NoteWritten>(org1.owner.userId, 'notes.note.create', {
      title: 'Ghi chu sap bi xoa vinh vien',
      body: 'Noi dung can xoa sach ket qua Vy.',
      visibility: 'private',
    });
    const siblingNote = await org1.exec<NoteWritten>(org1.alice.userId, 'notes.note.create', {
      title: 'Ghi chu khac trong cung org',
      body: 'Khong duoc cham toi ket qua Vy cua ghi chu nay.',
      visibility: 'private',
    });
    const directDeleteNote = await org1.exec<NoteWritten>(org1.owner.userId, 'notes.note.create', {
      title: 'Ghi chu bi xoa truc tiep',
      body: 'Kiem tra trigger khi xoa truc tiep qua SQL.',
      visibility: 'private',
    });
    const otherOrgNote = await org2.exec<NoteWritten>(org2.owner.userId, 'notes.note.create', {
      title: 'Ghi chu cua org khac',
      body: 'Cach ly hoan toan giua cac org.',
      visibility: 'private',
    });

    // Seed both finished ('ready') and live ('running') note-bound Vy runs across both subject_type conventions
    // ('notes.note' for notes.summary / notes.todo_suggest / projects.tasks_from_source, and 'note' for projects.tasks_from_note).
    const targetSum = await runNotesSummarize(deps, org1.orgId, asUser(org1.owner.userId), { noteId: targetNote.noteId });
    expect(targetSum.state).toBe('ready');
    const targetSuggestRun = await org1.exec<{ runId: string }>(org1.owner.userId, 'kernel.member_vy.run.start', {
      feature: 'notes.todo_suggest',
      subjectType: 'notes.note',
      subjectId: targetNote.noteId,
    });
    const targetProjectRun = await org1.exec<{ runId: string }>(org1.owner.userId, 'kernel.member_vy.run.start', {
      feature: 'projects.tasks_from_note',
      subjectType: 'note',
      subjectId: targetNote.noteId,
    });
    // Non-note run for the same owner (subject_type = 'member') must stay untouched when targetNote is purged.
    const ownerPlanRun = await org1.exec<{ runId: string }>(org1.owner.userId, 'kernel.member_vy.run.start', {
      feature: 'notes.todo_plan',
      subjectType: 'member',
      subjectId: org1.owner.userId,
    });

    // Sibling note in org1 (Alice) and note in org2 (Owner2).
    const siblingSum = await runNotesSummarize(deps, org1.orgId, asUser(org1.alice.userId), { noteId: siblingNote.noteId });
    expect(siblingSum.state).toBe('ready');
    const siblingSuggestRun = await org1.exec<{ runId: string }>(org1.alice.userId, 'kernel.member_vy.run.start', {
      feature: 'notes.todo_suggest',
      subjectType: 'notes.note',
      subjectId: siblingNote.noteId,
    });
    const siblingProjectRun = await org1.exec<{ runId: string }>(org1.alice.userId, 'kernel.member_vy.run.start', {
      feature: 'projects.tasks_from_note',
      subjectType: 'note',
      subjectId: siblingNote.noteId,
    });
    const otherOrgSum = await runNotesSummarize(deps, org2.orgId, asUser(org2.owner.userId), { noteId: otherOrgNote.noteId });
    expect(otherOrgSum.state).toBe('ready');
    const otherOrgSuggestRun = await org2.exec<{ runId: string }>(org2.owner.userId, 'kernel.member_vy.run.start', {
      feature: 'notes.todo_suggest',
      subjectType: 'notes.note',
      subjectId: otherOrgNote.noteId,
    });

    const resultCount = async (orgId: string, subjectId: string) =>
      (
        await sqlAdmin<{ n: number }>(
          `SELECT count(*)::int AS n FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
          [orgId, subjectId],
        )
      ).rows[0]!.n;
    const runState = async (orgId: string, runId: string) =>
      (
        await sqlAdmin<{ status: string; error: string | null; finished_at: Date | null }>(
          `SELECT status, error, finished_at FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        )
      ).rows[0]!;

    expect(await resultCount(org1.orgId, targetNote.noteId)).toBe(3);
    expect(await resultCount(org1.orgId, siblingNote.noteId)).toBe(3);
    expect(await resultCount(org2.orgId, otherOrgNote.noteId)).toBe(2);

    // Soft-deleting (moving to trash) preserves running runs until permanent purge, then notes.trash.empty fires note_discard_vy_tr.
    await org1.exec(org1.owner.userId, 'notes.note.delete', { noteId: targetNote.noteId });
    expect((await runState(org1.orgId, targetSuggestRun.runId)).status).toBe('running');
    await sqlAdmin(`UPDATE ludy_notes.note SET deleted_at = now() - interval '31 days' WHERE org_id = $1 AND id = $2`, [
      org1.orgId,
      targetNote.noteId,
    ]);
    expect(
      await worker.execute('notes.trash.empty', {}, { actor: { type: 'system', component: 'notes' }, orgId: org1.orgId }),
    ).toEqual({ removed: 1 });

    expect(await resultCount(org1.orgId, targetNote.noteId)).toBe(0);
    expect(await runState(org1.orgId, targetSuggestRun.runId)).toMatchObject({
      status: 'cancelled',
      error: 'NOTE_REMOVED',
    });
    expect((await runState(org1.orgId, targetSuggestRun.runId)).finished_at).not.toBeNull();
    expect(await runState(org1.orgId, targetProjectRun.runId)).toMatchObject({
      status: 'cancelled',
      error: 'NOTE_REMOVED',
    });
    expect((await runState(org1.orgId, targetProjectRun.runId)).finished_at).not.toBeNull();
    // Already-finished run for the deleted note preserves its terminal status.
    expect(await runState(org1.orgId, targetSum.runId!)).toMatchObject({
      status: 'succeeded',
      error: null,
    });
    // Storing into a run cancelled by note deletion is rejected cleanly.
    await expect(
      org1.exec(org1.owner.userId, 'kernel.member_vy.result.store', {
        runId: targetSuggestRun.runId,
        outcome: { status: 'ready', body: '{"suggestions":[],"dropped":0}', sourceRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE', status: 409 });

    // Sibling note, member-level todo_plan run, and other org's note stay untouched.
    expect(await resultCount(org1.orgId, siblingNote.noteId)).toBe(3);
    expect(await runState(org1.orgId, siblingSuggestRun.runId)).toMatchObject({ status: 'running', error: null });
    expect(await runState(org1.orgId, siblingProjectRun.runId)).toMatchObject({ status: 'running', error: null });
    expect(await resultCount(org1.orgId, org1.owner.userId)).toBe(1);
    expect(await runState(org1.orgId, ownerPlanRun.runId)).toMatchObject({ status: 'running', error: null });
    expect(await resultCount(org2.orgId, otherOrgNote.noteId)).toBe(2);
    expect(await runState(org2.orgId, otherOrgSuggestRun.runId)).toMatchObject({ status: 'running', error: null });

    // Direct SQL delete also fires BEFORE DELETE trigger for projects.tasks_from_source ('notes.note').
    const directSourceRun = await org1.exec<{ runId: string }>(org1.owner.userId, 'kernel.member_vy.run.start', {
      feature: 'projects.tasks_from_source',
      subjectType: 'notes.note',
      subjectId: directDeleteNote.noteId,
    });
    expect(await resultCount(org1.orgId, directDeleteNote.noteId)).toBe(1);
    await sqlAdmin(`DELETE FROM ludy_notes.note WHERE org_id = $1 AND id = $2`, [org1.orgId, directDeleteNote.noteId]);
    expect(await resultCount(org1.orgId, directDeleteNote.noteId)).toBe(0);
    expect(await runState(org1.orgId, directSourceRun.runId)).toMatchObject({
      status: 'cancelled',
      error: 'NOTE_REMOVED',
    });

    // Verify trigger function security metadata and zero runtime EXECUTE grants.
    const fnInfo = await sqlAdmin<{
      definer: boolean;
      config: string[] | null;
      pub: boolean;
      tenant: boolean;
      app: boolean;
      workerRole: boolean;
      definerTenant: boolean;
    }>(
      `SELECT p.prosecdef AS definer,
              p.proconfig AS config,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              pg_catalog.has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS tenant,
              pg_catalog.has_function_privilege('ludy_app', p.oid, 'EXECUTE') AS app,
              pg_catalog.has_function_privilege('ludy_worker', p.oid, 'EXECUTE') AS "workerRole",
              pg_catalog.has_function_privilege('ludy_definer_tenant', p.oid, 'EXECUTE') AS "definerTenant"
         FROM pg_catalog.pg_proc p
        WHERE p.oid = 'ludy_notes.note_discard_vy()'::pg_catalog.regprocedure`,
    );
    expect(fnInfo.rows[0]).toEqual({
      definer: true,
      config: ['search_path=pg_catalog, pg_temp'],
      pub: false,
      tenant: false,
      app: false,
      workerRole: false,
      definerTenant: false,
    });
  });
});
