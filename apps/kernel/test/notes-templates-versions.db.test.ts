// SPDX-License-Identifier: AGPL-3.0-only
// Quick note templates and the rolling 20-snapshot note version history through the runtime on PostgreSQL 17 (Notes
// v2 E3, #3562, docs/plan/notes-v2.md sections 3.1 and 3.4): creating a note writes no snapshot; an edit of its text
// or tags snapshots the state before it, and only the newest 20 stay; a restore snapshots the state it replaces and
// never clears taint; snapshots read through their note (private ones by the author alone); templates are private or
// shared like notes; the org export carries shared templates and a count of private ones; the PDPL erasure leaves no
// erased value in shared notes' snapshots or shared templates, and removes a private note's snapshots that name it
// once its author was told. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { NoteTemplate, NoteTemplateWritten, NoteVersion, NoteWritten, PersonalDataErasure } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'notes' };
const suite = ADMIN ? describe : describe.skip;

suite('note templates and version history on PostgreSQL (#3562)', () => {
  const dbName = `crove_test_notes_e3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A fresh org: an owner, an admin, two members (the author and another) and a viewer.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'notes-e3', subject: `${name}-${tag}`, email: `${name}-${tag}@example.com`, name: null });
    const owner = await user('owner');
    const adminUser = await user('admin');
    const author = await user('author');
    const other = await user('other');
    const viewer = await user('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Mẫu ghi chú ${tag}`);
    await admin((c) =>
      c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [
        orgId,
        adminUser,
        author,
        other,
        viewer,
      ]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    const versions = (userId: string, noteId: string) => query<NoteVersion[]>(userId, 'notes.note.versions', { noteId });
    const edit = (userId: string, noteId: string, revision: number, title: string, body = '', tags: string[] = []) =>
      exec<NoteWritten>(userId, 'notes.note.update', { noteId, revision, title, body, tags });
    return { orgId, owner, admin: adminUser, author, other, viewer, exec, query, versions, edit };
  }

  const versionRows = (orgId: string, noteId: string) =>
    admin(async (c) => (await c.query<{ revision: number; title: string }>('SELECT revision, title FROM ludy_notes.note_version WHERE org_id = $1 AND note_id = $2 ORDER BY revision', [orgId, noteId])).rows);

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
    const runtimeFor = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] });
    };
    app = runtimeFor('ludy_app', 'test-app-pw');
    worker = runtimeFor('ludy_worker', 'test-worker-pw');
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('writes no snapshot on create or on a visibility change, snapshots each text or tag edit, and keeps the newest 20', async () => {
    const o = await org();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Bản 1' });
    expect(await versionRows(o.orgId, noteId)).toEqual([]);
    // A visibility change bumps the revision but leaves the text alone: no snapshot.
    expect(await o.exec<NoteWritten>(o.author, 'notes.note.set_visibility', { noteId, visibility: 'org' })).toEqual({ noteId, revision: 2 });
    expect(await versionRows(o.orgId, noteId)).toEqual([]);
    // Saving the same text and tags again writes no snapshot either.
    await o.edit(o.author, noteId, 2, 'Bản 1');
    expect(await versionRows(o.orgId, noteId)).toEqual([]);
    // Tags alone are content: the state before is kept.
    await o.edit(o.author, noteId, 3, 'Bản 1', '', ['khách']);
    expect(await versionRows(o.orgId, noteId)).toEqual([{ revision: 3, title: 'Bản 1' }]);
    let revision = 4;
    for (let i = 2; i <= 25; i += 1) {
      await o.edit(o.author, noteId, revision, `Bản ${i}`, `Nội dung ${i}`);
      revision += 1;
    }
    const kept = await versionRows(o.orgId, noteId);
    expect(kept).toHaveLength(20);
    // The newest 20 pre-edit states: revisions 8 to 27 (Bản 5 to Bản 24); the live note is Bản 25.
    expect(kept.map((v) => v.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 8));
    expect(kept[0]?.title).toBe('Bản 5');
    expect(kept.at(-1)?.title).toBe('Bản 24');
    const listed = await o.versions(o.author, noteId);
    expect(listed.map((v) => v.revision)).toEqual(kept.map((v) => v.revision).reverse());
    expect(listed[0]).toMatchObject({ noteId, authorUserId: o.author, title: 'Bản 24', body: 'Nội dung 24', tainted: false });
  });

  it('shows a shared note history to members, owners and admins, a private note history to its author only, and none to viewers', async () => {
    const o = await org();
    const shared = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Chung cũ', visibility: 'org' });
    const priv = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Riêng cũ' });
    await o.edit(o.author, shared.noteId, 1, 'Chung mới');
    await o.edit(o.author, priv.noteId, 1, 'Riêng mới');
    for (const reader of [o.owner, o.admin, o.other]) {
      expect((await o.versions(reader, shared.noteId)).map((v) => v.title), reader).toEqual(['Chung cũ']);
      await expect(o.versions(reader, priv.noteId), reader).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
    }
    expect((await o.versions(o.author, priv.noteId)).map((v) => v.title)).toEqual(['Riêng cũ']);
    await expect(o.versions(o.viewer, shared.noteId)).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    // Another member cannot restore a snapshot of a shared note they did not write.
    const [sharedVersion] = await o.versions(o.other, shared.noteId);
    await expect(o.exec(o.other, 'notes.note.restore_version', { noteId: shared.noteId, revision: 2, versionId: sharedVersion?.id })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY', status: 403 });
  });

  it('restores a snapshot in one click: snapshots the state it replaces, bumps the revision, and refuses stale or foreign restores', async () => {
    const o = await org();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Biên bản', body: 'Chốt giá 10 triệu', tags: ['họp'], visibility: 'org' });
    await o.edit(o.author, noteId, 1, 'Biên bản', 'Chốt giá 12 triệu', ['họp']);
    const [first] = await o.versions(o.author, noteId);
    expect(first).toMatchObject({ revision: 1, body: 'Chốt giá 10 triệu' });
    const versionId = first?.id as string;
    await expect(o.exec(o.author, 'notes.note.restore_version', { noteId, revision: 1, versionId })).rejects.toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409 });
    await expect(o.exec(o.owner, 'notes.note.restore_version', { noteId, revision: 2, versionId })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY', status: 403 });
    await expect(o.exec(o.author, 'notes.note.restore_version', { noteId, revision: 2, versionId: randomUUID() })).rejects.toMatchObject({ code: 'NOTE_VERSION_NOT_FOUND', status: 404 });
    expect(await o.exec<NoteWritten>(o.author, 'notes.note.restore_version', { noteId, revision: 2, versionId })).toEqual({ noteId, revision: 3 });
    const note = await o.query<{ body: string; revision: number; tags: string[] }>(o.author, 'notes.note.get', { noteId });
    expect(note).toMatchObject({ body: 'Chốt giá 10 triệu', revision: 3, tags: ['họp'] });
    // The state the restore replaced is itself a snapshot, so the restore can be undone.
    expect((await o.versions(o.author, noteId)).map((v) => [v.revision, v.body])).toEqual([
      [2, 'Chốt giá 12 triệu'],
      [1, 'Chốt giá 10 triệu'],
    ]);
    const audit = await admin((c) =>
      c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'notes.note.restore_version'`, [o.orgId]),
    );
    expect(audit.rows[0]?.detail).toMatchObject({ noteId, revision: 3, restoredVersionId: versionId, restoredFromRevision: 1, changed: ['body'] });
    expect(JSON.stringify(audit.rows)).not.toContain('10 triệu');
  });

  it('never clears taint on a restore, and a restored tainted snapshot taints the note again', async () => {
    const o = await org();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Tóm tắt', body: 'Văn bản máy viết' });
    // Marked tainted as a machine-written note would be (the guard trigger is set aside for this one statement).
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE ludy_notes.note SET tainted = true WHERE org_id = $1 AND id = $2', [o.orgId, noteId]);
      await c.query('COMMIT');
    });
    // The author edits the text: taint clears, and the tainted state before is the snapshot.
    await o.edit(o.author, noteId, 1, 'Tóm tắt', 'Văn bản người đã sửa');
    const [tainted] = await o.versions(o.author, noteId);
    expect(tainted).toMatchObject({ revision: 1, tainted: true });
    expect(await o.query(o.author, 'notes.note.get', { noteId })).toMatchObject({ tainted: false });
    await o.exec(o.author, 'notes.note.restore_version', { noteId, revision: 2, versionId: tainted?.id });
    expect(await o.query(o.author, 'notes.note.get', { noteId })).toMatchObject({ tainted: true, body: 'Văn bản máy viết' });
    // Restoring the clean snapshot back keeps the note tainted until a person edits its text.
    const clean = (await o.versions(o.author, noteId)).find((v) => !v.tainted);
    expect(clean).toMatchObject({ body: 'Văn bản người đã sửa' });
    await o.exec(o.author, 'notes.note.restore_version', { noteId, revision: 3, versionId: clean?.id });
    expect(await o.query(o.author, 'notes.note.get', { noteId })).toMatchObject({ tainted: true, body: 'Văn bản người đã sửa' });
  });

  it('keeps private templates to their author, shares org templates, and lets managers edit but not hide a shared one', async () => {
    const o = await org();
    const priv = await o.exec<NoteTemplateWritten>(o.author, 'notes.template.create', { name: 'Mẫu riêng', title: 'Gọi khách', body: '- Hỏi nhu cầu', tags: ['khách'] });
    const shared = await o.exec<NoteTemplateWritten>(o.author, 'notes.template.create', { name: 'Biên bản họp công ty', body: '## Quyết định', visibility: 'org' });
    const names = async (userId: string) => (await o.query<NoteTemplate[]>(userId, 'notes.template.list')).map((t) => t.name).sort();
    expect(await names(o.author)).toEqual(['Biên bản họp công ty', 'Mẫu riêng']);
    for (const reader of [o.owner, o.admin, o.other]) expect(await names(reader), reader).toEqual(['Biên bản họp công ty']);
    expect(await names(o.viewer)).toEqual([]);
    await expect(o.exec(o.viewer, 'notes.template.create', { name: 'Không được' })).rejects.toMatchObject({ status: 403 });
    const update = (userId: string, templateId: string, revision: number, visibility: 'private' | 'org', name = 'Đổi tên') =>
      o.exec<NoteTemplateWritten>(userId, 'notes.template.update', { templateId, revision, name, title: '', body: 'Mới', tags: [], visibility });
    await expect(update(o.other, shared.templateId, 1, 'org')).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_AUTHOR_ONLY', status: 403 });
    await expect(update(o.owner, priv.templateId, 1, 'private')).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_NOT_FOUND', status: 404 });
    expect(await update(o.admin, shared.templateId, 1, 'org', 'Biên bản họp')).toEqual({ templateId: shared.templateId, revision: 2 });
    await expect(update(o.admin, shared.templateId, 2, 'private')).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_AUTHOR_ONLY' });
    await expect(update(o.author, shared.templateId, 1, 'org')).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_REVISION_CONFLICT', status: 409 });
    await expect(o.exec(o.other, 'notes.template.delete', { templateId: shared.templateId })).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_AUTHOR_ONLY' });
    await o.exec(o.owner, 'notes.template.delete', { templateId: shared.templateId });
    expect(await names(o.author)).toEqual(['Mẫu riêng']);
    // Audit rows keep markers, never template text.
    const audits = await admin((c) => c.query<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.template.%'`, [o.orgId]));
    expect(audits.rows.length).toBeGreaterThanOrEqual(4);
    for (const secret of ['Mẫu riêng', 'Gọi khách', 'Hỏi nhu cầu', 'Quyết định']) expect(JSON.stringify(audits.rows)).not.toContain(secret);
  });

  it('exports shared templates and a count of private ones, never their text, and empties history with the trash', async () => {
    const o = await org();
    await o.exec(o.author, 'notes.template.create', { name: 'Mẫu bí mật', body: 'Nội dung bí mật' });
    const shared = await o.exec<NoteTemplateWritten>(o.author, 'notes.template.create', { name: 'SOP quy trình', visibility: 'org' });
    const lines: Record<string, string[]> = {};
    for (const table of ['notes.note_template', 'notes.private_template_count']) {
      await worker.stream('kernel.org.export.snapshot', { table }, { actor: SYSTEM, orgId: o.orgId }, async (batch) => {
        const b = batch as { table: string; lines: string[] };
        lines[b.table] = [...(lines[b.table] ?? []), ...b.lines];
      });
    }
    expect((lines['notes.note_template'] ?? []).map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([shared.templateId]);
    expect((lines['notes.private_template_count'] ?? []).map((l) => JSON.parse(l))).toEqual([{ org_id: o.orgId, author_user_id: o.author, templates: 1 }]);
    expect(JSON.stringify(lines)).not.toContain('bí mật');

    // Emptying the trash removes a note's snapshots with it.
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Sắp xóa' });
    await o.edit(o.author, noteId, 1, 'Sắp xóa hẳn');
    await o.exec(o.author, 'notes.note.delete', { noteId });
    await admin((c) => c.query(`UPDATE ludy_notes.note SET deleted_at = now() - interval '31 days' WHERE org_id = $1 AND id = $2`, [o.orgId, noteId]));
    await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId });
    expect(await versionRows(o.orgId, noteId)).toEqual([]);
  });

  it("erases a person from shared notes' snapshots and shared templates, and from a private note's history once its author was told", async () => {
    const o = await org();
    const value = 'khach-e3@example.com';
    // A shared note that named the person only in an older state, and a shared template naming them.
    const shared = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Khách lớn', body: `Liên hệ ${value}`, visibility: 'org' });
    await o.edit(o.author, shared.noteId, 1, 'Khách lớn', 'Liên hệ qua kế toán');
    const tpl = await o.exec<NoteTemplateWritten>(o.author, 'notes.template.create', { name: 'Gọi khách', body: `Gửi báo giá cho ${value}`, visibility: 'org' });
    // A private note whose live text no longer names the person, but whose history does.
    const priv = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Riêng', body: `Hỏi ${value}` });
    await o.edit(o.author, priv.noteId, 1, 'Riêng', 'Đã gọi xong');
    await o.edit(o.author, priv.noteId, 2, 'Riêng', 'Đã gọi xong, chờ hợp đồng');

    await app.execute('kernel.personal_data.notify', { value }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const notice = (
      await admin((c) =>
        c.query<{ detail: { notes?: string[] } }>(
          `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`,
          [o.orgId],
        ),
      )
    ).rows[0];
    expect(notice?.detail.notes ?? []).toEqual([`${priv.noteId}:3`]);
    const eventId = (await admin((c) => c.query<{ id: string }>(`SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`, [o.orgId]))).rows[0]?.id;
    await worker.execute('kernel.notification.dispatch', { eventId }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [o.orgId]);
      await c.query(`UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`, [o.orgId]);
      await c.query('COMMIT');
    });

    const erased = await app.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const notesErased = Object.fromEntries(erased.erased.filter((e) => e.column.startsWith('ludy_notes.')).map((e) => [e.column, e.rows]));
    expect(notesErased).toMatchObject({ 'ludy_notes.note_version.body': 1, 'ludy_notes.note_template.body': 1 });

    const leftovers = await admin(async (c) => {
      const versions = await c.query<{ body: string }>('SELECT body FROM ludy_notes.note_version WHERE org_id = $1', [o.orgId]);
      const templates = await c.query<{ body: string }>('SELECT body FROM ludy_notes.note_template WHERE org_id = $1 AND id = $2', [o.orgId, tpl.templateId]);
      const notes = await c.query<{ id: string; body: string }>('SELECT id, body FROM ludy_notes.note WHERE org_id = $1 ORDER BY id', [o.orgId]);
      return { versions: versions.rows, templates: templates.rows, notes: notes.rows };
    });
    expect(JSON.stringify(leftovers)).not.toContain(value);
    // The template stays usable with the value edited out; the private note lives on without the history naming them.
    expect(leftovers.templates).toHaveLength(1);
    expect(leftovers.notes.map((n) => n.id).sort()).toEqual([shared.noteId, priv.noteId].sort());
    expect(await versionRows(o.orgId, priv.noteId)).toEqual([{ revision: 2, title: 'Riêng' }]);
  });

  it('never lets a restore racing the erasure write an erased value back into a shared note', async () => {
    const o = await org();
    const value = 'dua-e3@example.com';
    const shared = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Đua', body: `Gọi ${value}`, visibility: 'org' });
    await o.edit(o.author, shared.noteId, 1, 'Đua', 'Đã gọi');
    // A restore in flight: it holds the note's lock and is about to write the old text, which names the person, back.
    const restore = new pg.Client({ connectionString: adminUrl });
    await restore.connect();
    try {
      await restore.query('BEGIN');
      await restore.query('SELECT id FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, shared.noteId]);
      const erasing = app.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
      // The erasure waits on the lock while the restore writes the old text back and commits.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await restore.query(`UPDATE ludy_notes.note SET body = $3, revision = revision + 1 WHERE org_id = $1 AND id = $2`, [o.orgId, shared.noteId, `Gọi ${value}`]);
      await restore.query('COMMIT');
      await erasing;
    } finally {
      await restore.end();
    }
    const left = await admin(async (c) => ({
      note: (await c.query<{ body: string }>('SELECT body FROM ludy_notes.note WHERE org_id = $1 AND id = $2', [o.orgId, shared.noteId])).rows,
      versions: (await c.query<{ body: string }>('SELECT body FROM ludy_notes.note_version WHERE org_id = $1 AND note_id = $2', [o.orgId, shared.noteId])).rows,
    }));
    expect(left.note).toHaveLength(1);
    expect(JSON.stringify(left)).not.toContain(value);
  });
});
