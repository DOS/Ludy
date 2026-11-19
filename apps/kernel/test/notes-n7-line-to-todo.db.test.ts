// SPDX-License-Identifier: AGPL-3.0-only
// Notes N7 integration tests on PostgreSQL 17 (issue #1676, docs/plan/notes.md §4 step N7, ADR-0037):
// 1) A member turns a note line (own private note or another member's shared note) into a strictly private to-do with
//    sourceNoteId; another member, the note author, owners, admins, viewers, and entity-limited members read nothing.
// 2) Forged, private-to-another, cross-org, trashed, or entity-inaccessible sourceNoteId values all answer identically
//    with 404 NOTE_NOT_FOUND (zero existence oracle); audit records sourceNoteId ID only with PII redacted.
// 3) When a shared source note becomes private or moves to trash, the to-do stays intact and returns
//    { id, title: null, available: false } without leaking the title; restoring brings it back; purging trash sets
//    source_note_id to NULL via ON DELETE SET NULL while keeping the to-do intact.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MyWork, NoteRecordPanel, NoteWritten, Todo, TodoHandedOver, TodoSummary, TodoWritten } from '@ludy/kernel-contract';
import { Runtime, mintContextToken } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'notes' };
const suite = ADMIN ? describe : describe.skip;

suite('Notes N7: turn a note line into a private to-do on PostgreSQL 17 (#1676)', () => {
  const dbName = `crove_test_notes_n7_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let app: Runtime;
  let worker: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inUserSql<T>(orgId: string, userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
      userId,
      orgId,
      sessionId: null,
      aal: 'aal1',
      mfaAt: null,
    });
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, token]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const makeUser = (name: string) =>
      upsertIdentity(db, {
        issuer: 'notes-n7',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@crove.test`,
        name: `User ${name}`,
      });
    const owner = await makeUser('owner');
    const adminUser = await makeUser('admin');
    const author = await makeUser('author');
    const maker = await makeUser('maker');
    const other = await makeUser('other');
    const viewer = await makeUser('viewer');
    const limited = await makeUser('limited');

    const { orgId } = await createOrg(app, asUser(owner), `Notes N7 ${tag}`);
    const partyId = await withAdmin(async (c) => {
      const branchId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`,
          [orgId, owner],
        )
      ).rows[0]?.id as string;
      for (const [u, role] of [
        [adminUser, 'admin'],
        [author, 'member'],
        [maker, 'member'],
        [other, 'member'],
        [viewer, 'viewer'],
        [limited, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, u, role]);
      }
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, limited, branchId, owner],
      );
      return (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.party (org_id, id, name)
           VALUES ($1, $2, 'Công ty Hoa Mai') RETURNING id`,
          [orgId, randomUUID()],
        )
      ).rows[0]?.id as string;
    });

    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, partyId, owner, adminUser, author, maker, other, viewer, limited, exec, query };
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

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);

    const reg = {
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    };
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register(reg);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(reg);
  }, 300_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('creates a strictly private to-do from a shared note, exposes sourceNote only to creator, and audits ID only', async () => {
    const o = await setupOrg();
    const SHARED_TITLE = 'Biên bản họp khách hàng VIP';
    const SHARED_BODY = '- [ ] Xin sao kê tháng 11 từ giám đốc';
    const TODO_TITLE = 'Xin sao kê tháng 11 từ giám đốc';

    const sharedNote = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: SHARED_TITLE,
      body: SHARED_BODY,
      visibility: 'org',
      link: { targetType: 'kernel.party', targetId: o.partyId },
    });

    // Maker (another org member) turns a line of the shared note into their own private to-do.
    const created = await o.exec<TodoWritten>(o.maker, 'notes.todo.create', {
      title: TODO_TITLE,
      sourceNoteId: sharedNote.noteId,
      link: { targetType: 'kernel.party', targetId: o.partyId },
    });

    // Creator reads sourceNote across todo.get, todo.list, my_work, and record.panel.
    const got = await o.query<Todo>(o.maker, 'notes.todo.get', { todoId: created.todoId });
    expect(got.sourceNoteId).toBe(sharedNote.noteId);
    expect(got.sourceNote).toEqual({ id: sharedNote.noteId, title: SHARED_TITLE, available: true });

    const listed = await o.query<TodoSummary[]>(o.maker, 'notes.todo.list', { view: 'open' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sourceNoteId).toBe(sharedNote.noteId);
    expect(listed[0]?.sourceNote).toEqual({ id: sharedNote.noteId, title: SHARED_TITLE, available: true });

    const work = await o.query<MyWork>(o.maker, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(work.todos.map((t) => t.id)).toEqual([created.todoId]);
    expect(work.todos[0]?.sourceNote).toEqual({ id: sharedNote.noteId, title: SHARED_TITLE, available: true });

    const panel = await o.query<NoteRecordPanel>(o.maker, 'notes.record.panel', { targetType: 'kernel.party', targetId: o.partyId });
    expect(panel.todos.map((t) => t.id)).toEqual([created.todoId]);
    expect(panel.todos[0]?.sourceNote).toEqual({ id: sharedNote.noteId, title: SHARED_TITLE, available: true });

    // Strict ADR-0037 privacy: note author, another member, owner, admin, viewer, and entity-limited member read nothing.
    for (const reader of [o.author, o.other, o.owner, o.adminUser, o.viewer, o.limited]) {
      expect(await o.query<TodoSummary[]>(reader, 'notes.todo.list', { view: 'open' }), reader).toEqual([]);
      expect((await o.query<MyWork>(reader, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' })).todos, reader).toEqual([]);
      await expect(o.query(reader, 'notes.todo.get', { todoId: created.todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND', status: 404 });
      const readerPanel = await o.query<NoteRecordPanel>(reader, 'notes.record.panel', { targetType: 'kernel.party', targetId: o.partyId });
      expect(readerPanel.todos, reader).toEqual([]);

      const rawCount = await inUserSql(o.orgId, reader, async (c) => (await c.query('SELECT id FROM crove_notes.todo WHERE id = $1', [created.todoId])).rowCount);
      expect(rawCount, `SQL RLS for ${reader}`).toBe(0);
    }

    // Audit row keeps sourceNoteId ID only with PII redacted; no note or to-do text enters audit or outbox.
    const audit = await withAdmin((c) =>
      c.query<{ command: string; detail: Record<string, unknown> }>(
        `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'notes.todo.create' ORDER BY occurred_at DESC LIMIT 1`,
        [o.orgId],
      ),
    );
    expect(audit.rows[0]?.detail).toMatchObject({ todoId: created.todoId, sourceNoteId: sharedNote.noteId, title: { redacted: 'pii' } });
    const serializedAudit = JSON.stringify(audit.rows);
    expect(serializedAudit).not.toContain(SHARED_TITLE);
    expect(serializedAudit).not.toContain(SHARED_BODY);
    expect(serializedAudit).not.toContain(TODO_TITLE);

    const outbox = await withAdmin((c) => c.query<{ payload: unknown }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1`, [o.orgId]));
    expect(JSON.stringify(outbox.rows)).not.toContain(TODO_TITLE);

    // Author also turns a line of their own private note into a private to-do; nobody else reads either item.
    const ownPrivateNote = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Ghi chú riêng của tác giả',
      body: '- [ ] Đối chiếu sổ phụ',
      visibility: 'private',
    });
    const ownPrivateTodo = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: 'Đối chiếu sổ phụ',
      sourceNoteId: ownPrivateNote.noteId,
    });
    const authorGot = await o.query<Todo>(o.author, 'notes.todo.get', { todoId: ownPrivateTodo.todoId });
    expect(authorGot.sourceNote).toEqual({ id: ownPrivateNote.noteId, title: 'Ghi chú riêng của tác giả', available: true });
    for (const reader of [o.maker, o.other, o.owner, o.adminUser, o.viewer, o.limited]) {
      await expect(o.query(reader, 'notes.todo.get', { todoId: ownPrivateTodo.todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND', status: 404 });
    }
  });

  it('rejects forged, private-to-another, cross-org, trashed, or entity-inaccessible sourceNoteId with identical 404 NOTE_NOT_FOUND', async () => {
    const o1 = await setupOrg();
    const o2 = await setupOrg();

    const privateTheirs = await o1.exec<NoteWritten>(o1.author, 'notes.note.create', {
      title: 'Ghi chú riêng của tác giả',
      body: '- [ ] Bí mật',
      visibility: 'private',
    });
    const sharedOrgNote = await o1.exec<NoteWritten>(o1.author, 'notes.note.create', {
      title: 'Ghi chú dùng chung',
      body: '- [ ] Việc chung',
      visibility: 'org',
    });
    const trashedNote = await o1.exec<NoteWritten>(o1.maker, 'notes.note.create', {
      title: 'Ghi chú đã xóa',
      body: '- [ ] Dòng trong thùng rác',
      visibility: 'private',
    });
    await o1.exec(o1.maker, 'notes.note.delete', { noteId: trashedNote.noteId });

    const crossOrgNote = await o2.exec<NoteWritten>(o2.owner, 'notes.note.create', {
      title: 'Ghi chú của org khác',
      body: '- [ ] Khác org',
      visibility: 'org',
    });

    const expected404 = { code: 'NOTE_NOT_FOUND', status: 404, message: 'Không tìm thấy ghi chú này' };

    for (const [label, userId, sourceNoteId] of [
      ['forged uuid', o1.maker, randomUUID()],
      ['other member private note', o1.maker, privateTheirs.noteId],
      ['trashed note', o1.maker, trashedNote.noteId],
      ['cross-org note', o1.maker, crossOrgNote.noteId],
      ['shared note for entity-limited member', o1.limited, sharedOrgNote.noteId],
    ] as const) {
      await expect(o1.exec(userId, 'notes.todo.create', { title: 'Thử', sourceNoteId }), label).rejects.toMatchObject(expected404);
    }

    // Viewers cannot create to-dos at all.
    await expect(o1.exec(o1.viewer, 'notes.todo.create', { title: 'Viewer', sourceNoteId: sharedOrgNote.noteId })).rejects.toMatchObject({ status: 403 });
  });

  it('handles shared -> private, trash -> restore, and ON DELETE SET NULL on purge safely without leaking title', async () => {
    const o = await setupOrg();
    const SECRET_TITLE = 'Kế hoạch sáp nhập quý 4';
    const note = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: SECRET_TITLE,
      body: '- [ ] Kiểm tra hợp đồng thuê văn phòng',
      visibility: 'org',
    });
    const makerTodo = await o.exec<TodoWritten>(o.maker, 'notes.todo.create', {
      title: 'Kiểm tra hợp đồng thuê văn phòng',
      sourceNoteId: note.noteId,
    });
    const authorTodo = await o.exec<TodoWritten>(o.author, 'notes.todo.create', {
      title: 'Theo dõi riêng của tác giả',
      sourceNoteId: note.noteId,
    });

    // 1. Author turns the shared note private -> maker sees unavailable (no title leak), author still sees title.
    await o.exec(o.author, 'notes.note.set_visibility', { noteId: note.noteId, visibility: 'private' });
    const makerGotPrivate = await o.query<Todo>(o.maker, 'notes.todo.get', { todoId: makerTodo.todoId });
    expect(makerGotPrivate.sourceNoteId).toBe(note.noteId);
    expect(makerGotPrivate.sourceNote).toEqual({ id: note.noteId, title: null, available: false });
    expect(JSON.stringify(makerGotPrivate)).not.toContain(SECRET_TITLE);
    const makerWorkPrivate = await o.query<MyWork>(o.maker, 'notes.my_work', {});
    expect(makerWorkPrivate.todos[0]?.sourceNote).toEqual({ id: note.noteId, title: null, available: false });
    expect(JSON.stringify(makerWorkPrivate)).not.toContain(SECRET_TITLE);

    const authorGotPrivate = await o.query<Todo>(o.author, 'notes.todo.get', { todoId: authorTodo.todoId });
    expect(authorGotPrivate.sourceNote).toEqual({ id: note.noteId, title: SECRET_TITLE, available: true });

    // Re-sharing makes it available again for maker.
    await o.exec(o.author, 'notes.note.set_visibility', { noteId: note.noteId, visibility: 'org' });
    expect((await o.query<Todo>(o.maker, 'notes.todo.get', { todoId: makerTodo.todoId })).sourceNote).toEqual({
      id: note.noteId,
      title: SECRET_TITLE,
      available: true,
    });

    // 2. Moving the note to trash makes sourceNote unavailable for both maker and author (never leaking title).
    await o.exec(o.author, 'notes.note.delete', { noteId: note.noteId });
    for (const [userId, todoId] of [
      [o.maker, makerTodo.todoId],
      [o.author, authorTodo.todoId],
    ] as const) {
      const gotTrashed = await o.query<Todo>(userId, 'notes.todo.get', { todoId });
      expect(gotTrashed.sourceNote).toEqual({ id: note.noteId, title: null, available: false });
      expect(JSON.stringify(gotTrashed)).not.toContain(SECRET_TITLE);
      const listTrashed = await o.query<TodoSummary[]>(userId, 'notes.todo.list', { view: 'open' });
      expect(listTrashed[0]?.sourceNote).toEqual({ id: note.noteId, title: null, available: false });
    }

    // Restoring brings back the link before permanent purge.
    await o.exec(o.author, 'notes.note.restore', { noteId: note.noteId });
    expect((await o.query<Todo>(o.maker, 'notes.todo.get', { todoId: makerTodo.todoId })).sourceNote).toEqual({
      id: note.noteId,
      title: SECRET_TITLE,
      available: true,
    });

    // 3. Moving to trash and purging after 30 days triggers ON DELETE SET NULL: to-do stays intact with sourceNote = null.
    await o.exec(o.author, 'notes.note.delete', { noteId: note.noteId });
    await withAdmin((c) => c.query(`UPDATE crove_notes.note SET deleted_at = now() - interval '31 days' WHERE org_id = $1 AND id = $2`, [o.orgId, note.noteId]));
    expect(await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 1 });

    const afterPurge = await o.query<Todo>(o.maker, 'notes.todo.get', { todoId: makerTodo.todoId });
    expect(afterPurge.title).toBe('Kiểm tra hợp đồng thuê văn phòng');
    expect(afterPurge.sourceNoteId).toBeNull();
    expect(afterPurge.sourceNote).toBeNull();

    const workAfterPurge = await o.query<MyWork>(o.maker, 'notes.my_work', {});
    expect(workAfterPurge.todos[0]).toMatchObject({
      id: makerTodo.todoId,
      sourceNoteId: null,
      sourceNote: null,
    });
  });

  it('inherits tainted=true from a tainted source note into the to-do and handed-over team task', async () => {
    const o = await setupOrg();
    const taintedNote = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Tóm tắt do AI viết',
      body: '- [ ] Rà soát hóa đơn đầu vào',
      visibility: 'org',
      tainted: true,
    });
    const created = await o.exec<TodoWritten>(o.maker, 'notes.todo.create', {
      title: 'Rà soát hóa đơn đầu vào',
      sourceNoteId: taintedNote.noteId,
    });
    const todoRow = await withAdmin((c) =>
      c.query<{ tainted: boolean }>('SELECT tainted FROM crove_notes.todo WHERE org_id = $1 AND id = $2', [o.orgId, created.todoId]),
    );
    expect(todoRow.rows[0]?.tainted).toBe(true);

    const positionId = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_user_id, status)
           VALUES ($1, 'Kế toán viên', 'kernel', 'staff', $2, 'active') RETURNING id`,
          [o.orgId, o.other],
        )
      ).rows[0]?.id as string,
    );
    const handed = await o.exec<TodoHandedOver>(o.maker, 'notes.todo.hand_over', {
      todoId: created.todoId,
      revision: created.revision,
      positionId,
      title: 'Rà soát hóa đơn đầu vào',
      description: '',
    });
    const taskRow = await withAdmin((c) =>
      c.query<{ tainted: boolean }>('SELECT tainted FROM crove_kernel.task WHERE org_id = $1 AND id = $2', [o.orgId, handed.taskId]),
    );
    expect(taskRow.rows[0]?.tainted).toBe(true);
  });
});
