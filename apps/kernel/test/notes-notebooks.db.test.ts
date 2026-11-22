// SPDX-License-Identifier: AGPL-3.0-only
// Notes v2 E1 (#3559): PostgreSQL 17 integration tests for notebooks and 2-level stacks, note.notebookId visibility and
// existence-oracle invariants, interactive checkbox body updates with revision conflict guard, RLS-safe [[Note]]
// backlinks, personal-data (PDPL) redaction/erasure, and notes.mine.export.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  Note,
  NoteSummary,
  NoteWritten,
  NotebookDeleted,
  NotebookWritten,
  NotebooksResponse,
  NotesExport,
  PersonalDataErasure,
  PersonalDataNotice,
  PersonalDataResult,
} from '@ludy/kernel-contract';
import { DomainError, Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Notes v2 E1 (#3559): notebooks, 2-level stacks, checkbox updates, [[Note]] backlinks & PDPL on PG17', () => {
  const dbName = `crove_test_notes_notebooks_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let runtime: Runtime;
  const pools: pg.Pool[] = [];
  let orgId = '';
  const users = { owner: '', admin: '', alice: '', bob: '', viewer: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function catchDomain(fn: () => Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
    try {
      await fn();
      throw new Error('Expected DomainError');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      const d = err as DomainError;
      return { code: d.code, status: d.status, message: d.message };
    }
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

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';

    const pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.example.com' }), ...financeQueries, ...notesQueries],
    });

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, {
        issuer: 'notes-notebooks-test',
        subject: key,
        email: `${key}@example.com`,
        name: key,
      });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Cong ty So Tay')).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
        [orgId, users.admin, users.alice, users.bob, users.viewer],
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

  it('supports zero-setup unfiled notes, 2-level stacks, reordering, deletion unfiling, and PII-free audit logs', async () => {
    const secretNbName = 'So tay hop hoi dong bi mat';
    const secretStack = 'Chien luoc Q4 bi mat';

    // Zero-setup: unfiled note works immediately without creating any notebook.
    const unfiled = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chu chua xep so', body: 'Noi dung ban dau' },
      { actor: asUser(users.alice), orgId },
    );

    const initialList = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.alice), orgId });
    expect(initialList.notebooks).toEqual([]);
    expect(initialList.allCount).toBe(1);
    expect(initialList.unfiledCount).toBe(1);

    // Create 2 notebooks in a 2-level stack and 1 standalone pinned notebook.
    const nb1 = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: secretNbName, stackName: secretStack, visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );
    const nb2 = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: 'Ke hoach san pham', stackName: secretStack, visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );
    const nbShared = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: 'Quy trinh ban hang', stackName: 'Kinh doanh', visibility: 'org', pinned: true },
      { actor: asUser(users.alice), orgId },
    );

    // Reorder nb2 before nb1.
    const moved = await runtime.execute<NotebookWritten>(
      'notes.notebook.update',
      { notebookId: nb2.notebookId, revision: nb2.revision, reorder: { place: 'before', anchorId: nb1.notebookId } },
      { actor: asUser(users.alice), orgId },
    );
    expect(moved.revision).toBe(2);

    // File a note into nb1 and another shared note into nbShared.
    const filed1 = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Bien ban Q4', body: 'Chi tiet', notebookId: nb1.notebookId },
      { actor: asUser(users.alice), orgId },
    );
    const filedShared = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Kich ban goi khach', body: 'Buoc 1', visibility: 'org', notebookId: nbShared.notebookId },
      { actor: asUser(users.alice), orgId },
    );

    const afterCreate = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.alice), orgId });
    expect(afterCreate.notebooks.map((b) => b.id)).toEqual([nbShared.notebookId, nb2.notebookId, nb1.notebookId]);
    expect(afterCreate.allCount).toBe(3);
    expect(afterCreate.unfiledCount).toBe(1);
    expect(afterCreate.notebooks.find((b) => b.id === nb1.notebookId)?.noteCount).toBe(1);

    // Filter notes by stackName, notebookId, and 'unfiled'.
    const byStack = await runtime.query<NoteSummary[]>(
      'notes.note.list',
      { view: 'mine', stackName: secretStack },
      { actor: asUser(users.alice), orgId },
    );
    expect(byStack.map((n) => n.id)).toEqual([filed1.noteId]);

    const byUnfiled = await runtime.query<NoteSummary[]>(
      'notes.note.list',
      { view: 'mine', notebookId: 'unfiled' },
      { actor: asUser(users.alice), orgId },
    );
    expect(byUnfiled.map((n) => n.id)).toEqual([unfiled.noteId]);

    // Bob sees only the shared notebook, never Alice's private notebooks; viewer sees 0 shared notebooks and cannot write.
    const bobNotebooks = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.bob), orgId });
    expect(bobNotebooks.notebooks.map((b) => b.id)).toEqual([nbShared.notebookId]);
    expect(bobNotebooks.notebooks[0]?.editable).toBe(false);

    const viewerNotebooks = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.viewer), orgId });
    expect(viewerNotebooks.notebooks).toEqual([]);
    const viewerCreate = await catchDomain(() =>
      runtime.execute('notes.notebook.create', { name: 'Khong duoc' }, { actor: asUser(users.viewer), orgId }),
    );
    expect(viewerCreate.status).toBe(403);

    // Deleting nb1 unfiles filed1 without deleting filed1.
    const deleted = await runtime.execute<NotebookDeleted>(
      'notes.notebook.delete',
      { notebookId: nb1.notebookId },
      { actor: asUser(users.alice), orgId },
    );
    expect(deleted.notebookId).toBe(nb1.notebookId);

    const stillThere = await runtime.query<Note>('notes.note.get', { noteId: filed1.noteId }, { actor: asUser(users.alice), orgId });
    expect(stillThere.notebookId).toBeNull();
    expect(stillThere.deletedAt).toBeNull();

    // Verify audit events contain zero raw notebook name or stack name strings.
    const auditDump = await admin(async (c) => {
      const { rows } = await c.query<{ detail: unknown }>(
        `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.notebook.%'`,
        [orgId],
      );
      return JSON.stringify(rows);
    });
    expect(auditDump).not.toContain(secretNbName);
    expect(auditDump).not.toContain(secretStack);

    // Cleanup notes created in this test so later counts are isolated.
    for (const id of [unfiled.noteId, filed1.noteId, filedShared.noteId]) {
      await runtime.execute('notes.note.delete', { noteId: id }, { actor: asUser(users.alice), orgId });
    }
    await runtime.execute('notes.notebook.delete', { notebookId: nb2.notebookId }, { actor: asUser(users.alice), orgId });
    await runtime.execute('notes.notebook.delete', { notebookId: nbShared.notebookId }, { actor: asUser(users.alice), orgId });
  });

  it('enforces cross-visibility rules, detaches other private notes on privatization, and leaks zero existence oracle', async () => {
    const alicePrivNb = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: 'So rieng Alice', visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );
    const aliceSharedNb = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: 'So chung Alice', visibility: 'org' },
      { actor: asUser(users.alice), orgId },
    );

    // 1) Creating a shared note in a private notebook is rejected with 422 NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK.
    const createSharedInPriv = await catchDomain(() =>
      runtime.execute(
        'notes.note.create',
        { title: 'Chung trong rieng', visibility: 'org', notebookId: alicePrivNb.notebookId },
        { actor: asUser(users.alice), orgId },
      ),
    );
    expect(createSharedInPriv).toMatchObject({ code: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', status: 422 });

    // 2) A private note in a private notebook cannot be shared until moved out.
    const privNote = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chu rieng', visibility: 'private', notebookId: alicePrivNb.notebookId },
      { actor: asUser(users.alice), orgId },
    );
    const shareInPriv = await catchDomain(() =>
      runtime.execute(
        'notes.note.set_visibility',
        { noteId: privNote.noteId, visibility: 'org' },
        { actor: asUser(users.alice), orgId },
      ),
    );
    expect(shareInPriv).toMatchObject({ code: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', status: 422 });

    // 3) While a shared note belongs to aliceSharedNb, turning aliceSharedNb private is rejected with 409 NOTES_NOTEBOOK_HAS_SHARED_NOTES.
    const sharedNote = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chu chung', visibility: 'org', notebookId: aliceSharedNb.notebookId },
      { actor: asUser(users.alice), orgId },
    );
    const privatizeWithShared = await catchDomain(() =>
      runtime.execute(
        'notes.notebook.update',
        { notebookId: aliceSharedNb.notebookId, revision: aliceSharedNb.revision, visibility: 'private' },
        { actor: asUser(users.alice), orgId },
      ),
    );
    expect(privatizeWithShared).toMatchObject({ code: 'NOTES_NOTEBOOK_HAS_SHARED_NOTES', status: 409 });

    // 4) Zero existence oracle: Bob probing Alice's private notebookId vs random UUID gets identical 404 NOTEBOOK_NOT_FOUND.
    const missingId = randomUUID();
    const bobProbeReal = await catchDomain(() =>
      runtime.execute(
        'notes.note.create',
        { title: 'Bob do hoi', visibility: 'private', notebookId: alicePrivNb.notebookId },
        { actor: asUser(users.bob), orgId },
      ),
    );
    const bobProbeFake = await catchDomain(() =>
      runtime.execute(
        'notes.note.create',
        { title: 'Bob do hoi', visibility: 'private', notebookId: missingId },
        { actor: asUser(users.bob), orgId },
      ),
    );
    expect(bobProbeReal).toEqual(bobProbeFake);
    expect(bobProbeReal).toMatchObject({ code: 'NOTEBOOK_NOT_FOUND', status: 404 });

    // 5) Bob files his own private note into aliceSharedNb; once Alice unfiles her sharedNote and turns aliceSharedNb private,
    // Bob's private note is detached cleanly without leaking Bob's private note to Alice.
    const bobPrivInShared = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chu rieng cua Bob', visibility: 'private', notebookId: aliceSharedNb.notebookId },
      { actor: asUser(users.bob), orgId },
    );
    await runtime.execute(
      'notes.note.update',
      { noteId: sharedNote.noteId, revision: sharedNote.revision, notebookId: null },
      { actor: asUser(users.alice), orgId },
    );
    const turnedPriv = await runtime.execute<NotebookWritten>(
      'notes.notebook.update',
      { notebookId: aliceSharedNb.notebookId, revision: aliceSharedNb.revision, visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );
    expect(turnedPriv.revision).toBe(2);

    const bobAfter = await runtime.query<Note>('notes.note.get', { noteId: bobPrivInShared.noteId }, { actor: asUser(users.bob), orgId });
    expect(bobAfter.notebookId).toBeNull();

    // Cleanup.
    await runtime.execute('notes.note.delete', { noteId: privNote.noteId }, { actor: asUser(users.alice), orgId });
    await runtime.execute('notes.note.delete', { noteId: sharedNote.noteId }, { actor: asUser(users.alice), orgId });
    await runtime.execute('notes.note.delete', { noteId: bobPrivInShared.noteId }, { actor: asUser(users.bob), orgId });
    await runtime.execute('notes.notebook.delete', { notebookId: alicePrivNb.notebookId }, { actor: asUser(users.alice), orgId });
    await runtime.execute('notes.notebook.delete', { notebookId: aliceSharedNb.notebookId }, { actor: asUser(users.alice), orgId });
  });

  it('persists interactive preview checkbox updates with optimistic revision conflict protection', async () => {
    const created = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Danh sach kiem tra', body: '- [ ] Gui hoa don\n- [x] Chot so phu' },
      { actor: asUser(users.alice), orgId },
    );

    const toggled = await runtime.execute<NoteWritten>(
      'notes.note.update',
      { noteId: created.noteId, revision: created.revision, body: '- [x] Gui hoa don\n- [x] Chot so phu' },
      { actor: asUser(users.alice), orgId },
    );
    expect(toggled.revision).toBe(2);

    // Stale revision is rejected with 409 NOTE_REVISION_CONFLICT.
    const stale = await catchDomain(() =>
      runtime.execute(
        'notes.note.update',
        { noteId: created.noteId, revision: 1, body: '- [ ] Gui hoa don\n- [ ] Chot so phu' },
        { actor: asUser(users.alice), orgId },
      ),
    );
    expect(stale).toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409 });

    const saved = await runtime.query<Note>('notes.note.get', { noteId: created.noteId }, { actor: asUser(users.alice), orgId });
    expect(saved.body).toBe('- [x] Gui hoa don\n- [x] Chot so phu');
    expect(saved.revision).toBe(2);

    await runtime.execute('notes.note.delete', { noteId: created.noteId }, { actor: asUser(users.alice), orgId });
  });

  it('returns only RLS-readable non-trashed [[Note]] backlinks and ignores links inside code blocks or inline code', async () => {
    const target = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ke hoach nam 2027', body: 'Muc tieu chung', visibility: 'org' },
      { actor: asUser(users.alice), orgId },
    );

    // Alice's private note links to target by title.
    const alicePrivLinker = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Luong thuong rieng cua Alice', body: 'Xem [[Ke hoach nam 2027]] truoc khi duyet.', visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );

    // Bob's shared note links to target by disambiguated [[id|Title]].
    const bobSharedLinker = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Bao cao kinh doanh Q1', body: `Tham chieu [[${target.noteId}|Ke hoach nam 2027]].`, visibility: 'org' },
      { actor: asUser(users.bob), orgId },
    );

    // Notes whose [[Ke hoach nam 2027]] sits inside fenced code or inline backticks MUST NOT count as backlinks.
    const codeOnly = await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Tai lieu cu phap',
        body: 'Vi du inline `[[Ke hoach nam 2027]]` va khoi ma:\n```md\n[[Ke hoach nam 2027]]\n```',
        visibility: 'org',
      },
      { actor: asUser(users.bob), orgId },
    );

    // Trashed note linking to target MUST NOT appear in backlinks.
    const trashedLinker = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ban nhap da xoa', body: '[[Ke hoach nam 2027]]', visibility: 'org' },
      { actor: asUser(users.bob), orgId },
    );
    await runtime.execute('notes.note.delete', { noteId: trashedLinker.noteId }, { actor: asUser(users.bob), orgId });

    // Alice sees BOTH her own private backlink AND Bob's shared backlink.
    const aliceBacklinks = await runtime.query<NoteSummary[]>(
      'notes.note.backlinks',
      { noteId: target.noteId },
      { actor: asUser(users.alice), orgId },
    );
    expect(aliceBacklinks.map((n) => n.id).sort()).toEqual([alicePrivLinker.noteId, bobSharedLinker.noteId].sort());

    // Bob, Owner, and Admin see ONLY Bob's shared backlink - ZERO leakage of Alice's private note title, ID, or count!
    for (const caller of [users.bob, users.owner, users.admin]) {
      const seen = await runtime.query<NoteSummary[]>(
        'notes.note.backlinks',
        { noteId: target.noteId },
        { actor: asUser(caller), orgId },
      );
      expect(seen.map((n) => n.id)).toEqual([bobSharedLinker.noteId]);
      expect(JSON.stringify(seen)).not.toContain('Luong thuong rieng cua Alice');
      expect(JSON.stringify(seen)).not.toContain(alicePrivLinker.noteId);
    }

    // Viewer cannot read shared target note at all -> 404 NOTE_NOT_FOUND, identical to probing Alice's private note or random UUID.
    const viewerTarget = await catchDomain(() =>
      runtime.query('notes.note.backlinks', { noteId: target.noteId }, { actor: asUser(users.viewer), orgId }),
    );
    const bobProbeAlicePriv = await catchDomain(() =>
      runtime.query('notes.note.backlinks', { noteId: alicePrivLinker.noteId }, { actor: asUser(users.bob), orgId }),
    );
    const bobProbeFake = await catchDomain(() =>
      runtime.query('notes.note.backlinks', { noteId: randomUUID() }, { actor: asUser(users.bob), orgId }),
    );
    expect(viewerTarget).toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
    expect(bobProbeAlicePriv).toEqual(bobProbeFake);

    // Cleanup.
    for (const [id, who] of [
      [target.noteId, users.alice],
      [alicePrivLinker.noteId, users.alice],
      [bobSharedLinker.noteId, users.bob],
      [codeOnly.noteId, users.bob],
    ] as const) {
      await runtime.execute('notes.note.delete', { noteId: id }, { actor: asUser(who), orgId });
    }
  });

  it('redacts shared notebooks in place, erases notified private notebooks after 24h under PDPL, and exports mine', async () => {
    const piiEmail = 'khach.vip@example.com';
    const privNb = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: `Ho so ${piiEmail}`, stackName: `Nhom ${piiEmail}`, visibility: 'private' },
      { actor: asUser(users.alice), orgId },
    );
    const sharedNb = await runtime.execute<NotebookWritten>(
      'notes.notebook.create',
      { name: `Doi tac ${piiEmail}`, stackName: `Kenh ${piiEmail}`, visibility: 'org' },
      { actor: asUser(users.alice), orgId },
    );
    const survivingNote = await runtime.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chu khong chua email', body: 'An toan', visibility: 'private', notebookId: privNb.notebookId },
      { actor: asUser(users.alice), orgId },
    );

    // Export mine includes Alice's notebooks and notebookId on her note.
    const exported = await runtime.query<NotesExport>('notes.mine.export', {}, { actor: asUser(users.alice), orgId });
    expect((exported.notebooks ?? []).map((b) => b.id).sort()).toEqual([privNb.notebookId, sharedNb.notebookId].sort());
    expect(exported.notes.find((n) => n.id === survivingNote.noteId)?.notebookId).toBe(privNb.notebookId);

    // Owner runs PDPL find -> sees shared notebook matches + private count for Alice without Alice's private text.
    const found = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: piiEmail },
      { actor: asUser(users.owner), orgId },
    );
    expect(found.matches.some((m) => m.column === 'crove_notes.notebook.name' && m.rowId === sharedNb.notebookId)).toBe(true);
    expect(found.matches.some((m) => m.rowId === privNb.notebookId)).toBe(false);
    expect(found.privateItems).toEqual([{ authorUserId: users.alice, notes: 1, todos: 0 }]);

    // Notify records notebooks in audit detail; immediate erase redacts shared notebook in place and keeps private notebook (<24h).
    const notified = await runtime.execute<PersonalDataNotice>(
      'kernel.personal_data.notify',
      { value: piiEmail },
      { actor: asMfa(users.owner), orgId },
    );
    expect(notified.told).toBe(1);
    expect(notified.authors).toEqual([{ authorUserId: users.alice, notes: 1, todos: 0, meetings: 0 }]);

    // Simulate worker dispatching the personal_data_notice notification to Alice.
    const notifyEvent = await admin(async (c) => {
      const { rows } = await c.query<{ event: string }>(
        `SELECT detail ->> 'event' AS event FROM ludy_kernel.audit_event
         WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY occurred_at DESC LIMIT 1`,
        [orgId],
      );
      const ev = rows[0]?.event as string;
      await c.query(
        `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key)
         VALUES ($1, $2, 'kernel.personal_data_notice', $3)`,
        [orgId, users.alice, `personal_data_notice:${ev}`],
      );
      return ev;
    });
    expect(notifyEvent).toBeTruthy();

    const firstErase = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: piiEmail },
      { actor: asMfa(users.owner), orgId },
    );
    expect(firstErase.erased).toContainEqual({ column: 'crove_notes.notebook.name', rows: 1 });
    expect(firstErase.erased).toContainEqual({ column: 'crove_notes.notebook.stack_name', rows: 1 });
    expect(firstErase.kept.some((k) => k.column === 'crove_notes.note' && k.rows === 1)).toBe(true);

    // Shared notebook name & stackName were redacted in place!
    const sharedAfterRedact = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.bob), orgId });
    const redactedShared = sharedAfterRedact.notebooks.find((b) => b.id === sharedNb.notebookId);
    expect(redactedShared?.name).not.toContain(piiEmail);
    expect(redactedShared?.stackName ?? '').not.toContain(piiEmail);

    // Age notice + notification past 24h -> second erase removes privNb and detaches survivingNote cleanly!
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours'
         WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`,
        [orgId],
      );
      await c.query(
        `UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours'
         WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`,
        [orgId],
      );
      await c.query('COMMIT');
    });

    const secondErase = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: piiEmail },
      { actor: asMfa(users.owner), orgId },
    );
    expect(secondErase.erased).toContainEqual({ column: 'crove_notes.note', rows: 1 });
    expect(secondErase.kept.some((k) => k.column === 'crove_notes.note')).toBe(false);

    const aliceAfterErase = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.alice), orgId });
    expect(aliceAfterErase.notebooks.find((b) => b.id === privNb.notebookId)).toBeUndefined();
    const detachedNote = await runtime.query<Note>('notes.note.get', { noteId: survivingNote.noteId }, { actor: asUser(users.alice), orgId });
    expect(detachedNote.notebookId).toBeNull();
  });

  it('keeps the asked side of the anchor when other members share one sort key, and starts a new notebook after every readable one', async () => {
    const x1 = await runtime.execute<NotebookWritten>('notes.notebook.create', { name: 'Dung chung A', visibility: 'org' }, { actor: asUser(users.owner), orgId });
    const x2 = await runtime.execute<NotebookWritten>('notes.notebook.create', { name: 'Dung chung B', visibility: 'org' }, { actor: asUser(users.admin), orgId });
    const mine = await runtime.execute<NotebookWritten>('notes.notebook.create', { name: 'So rieng cua Bob' }, { actor: asUser(users.bob), orgId });

    // A new notebook goes after every notebook its author reads, not only after its own.
    const keyOf = (r: NotebooksResponse, id: string) => r.notebooks.find((b) => b.id === id)?.sortKey ?? '';
    const created = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.bob), orgId });
    expect(keyOf(created, mine.notebookId) > keyOf(created, x2.notebookId)).toBe(true);
    expect(keyOf(created, x2.notebookId) > keyOf(created, x1.notebookId)).toBe(true);

    // Notebooks made before that (each author's first got the same key) collide; Bob cannot rewrite the shared ones.
    await admin(async (c) => {
      await c.query(`UPDATE crove_notes.notebook SET sort_key = 'V' WHERE org_id = $1 AND id = ANY($2::uuid[])`, [
        orgId,
        [x1.notebookId, x2.notebookId, mine.notebookId],
      ]);
    });
    const [first, second] = [x1.notebookId, x2.notebookId].sort();
    const indexIn = (r: NotebooksResponse, id: string) => r.notebooks.findIndex((b) => b.id === id);

    const after = await runtime.execute<NotebookWritten>(
      'notes.notebook.update',
      { notebookId: mine.notebookId, revision: mine.revision, reorder: { place: 'after', anchorId: first as string } },
      { actor: asUser(users.bob), orgId },
    );
    const afterList = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.bob), orgId });
    expect(indexIn(afterList, mine.notebookId)).toBeGreaterThan(indexIn(afterList, first as string));
    expect(keyOf(afterList, mine.notebookId)).not.toBe('V');

    await runtime.execute<NotebookWritten>(
      'notes.notebook.update',
      { notebookId: mine.notebookId, revision: after.revision, reorder: { place: 'before', anchorId: second as string } },
      { actor: asUser(users.bob), orgId },
    );
    const beforeList = await runtime.query<NotebooksResponse>('notes.notebook.list', {}, { actor: asUser(users.bob), orgId });
    expect(indexIn(beforeList, mine.notebookId)).toBeLessThan(indexIn(beforeList, second as string));
    // The shared notebooks Bob may not manage kept their keys.
    expect(keyOf(beforeList, x1.notebookId)).toBe('V');
    expect(keyOf(beforeList, x2.notebookId)).toBe('V');
  });
});
