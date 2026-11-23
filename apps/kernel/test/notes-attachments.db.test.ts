// SPDX-License-Identifier: AGPL-3.0-only
// Files attached to a note on PostgreSQL 17 (Notes v2 E2, #3561, owner decision A3, ADR-0037): the bytes go through
// POST /api/notes/:noteId/attachments into the blob store under notes/<org>/<attachment> and a ludy_notes.attachment row,
// never ludy_kernel.file; GET /api/notes/attachments/:id serves them only to whoever reads the parent note, with nosniff,
// no-store, a sandbox CSP, inline only for raster images, PDF and safe audio, and one uniform 404 for an id that is foreign,
// unknown, unreadable or in the trash. The worker extracts text through crove-extract (a stand-in here) and the note's search
// finds it, an edit of the note keeping it. Every deletion path queues the blob for the worker's sweep. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { ExtractClient, ExtractKind, ExtractResult } from '@ludy/extract-contract';
import type { PersonalDataErasure, PersonalDataNotice, PersonalDataResult } from '@ludy/kernel-contract';
import { NOTE_ATTACHMENT_MAX_BYTES, type Note, type NoteAttachment, type NoteSummary, type NoteWritten } from '@ludy/kernel-contract';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { hashExtensionSecret, newExtensionToken } from '../src/auth-extension.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { requestDueNoteAttachmentExtracts, runNoteAttachmentExtract, sweepNoteAttachmentBlobs } from '../src/notes-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'notes' };
const SECRET = 'test-only-jwt-secret-for-note-attachments-0123456789';
const ISSUER = 'https://issuer.example.com';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const enc = new TextEncoder();
const pdf = (text: string) => enc.encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3]);
const svg = () => enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = () => enc.encode('<!doctype html><html><body><script>alert(1)</script></body></html>');
const docx = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc.encode('word/document.xml'), 0, 0, 0]);

// The internal crove-extract stand-in: answers the PDF and DOCX text it is told to.
class FakeExtract implements ExtractClient {
  text = 'Biên bản đối soát ngân quỹ tháng mười';
  calls: ExtractKind[] = [];
  async extract<K extends ExtractKind>(kind: K): Promise<ExtractResult<K>> {
    this.calls.push(kind);
    if (kind === 'pdf_text') return { ok: true, kind: 'pdf_text', text: this.text, pages: 1 } as unknown as ExtractResult<K>;
    return { ok: true, kind: 'docx_text', text: this.text } as unknown as ExtractResult<K>;
  }
}

suite('files attached to a note on PostgreSQL (#3561)', () => {
  const dbName = `crove_test_notes_attachments_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const extract = new FakeExtract();

  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);

  type Person = { id: string; subject: string; email: string };
  type Org = { orgId: string; slug: string; owner: Person; admin: Person; author: Person; other: Person; viewer: Person };
  const person = async (name: string): Promise<Person> => {
    const subject = randomUUID();
    const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
    return { id: (await upsertIdentity(db, { issuer: ISSUER, subject, email, name: null })) as string, subject, email };
  };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner.id), `Ghi chú ${randomUUID().slice(0, 6)}`);
    const adm = await person('admin');
    const author = await person('author');
    const other = await person('other');
    const viewer = await person('viewer');
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [
      orgId,
      adm.id,
      author.id,
      other.id,
      viewer.id,
    ]);
    const [slug] = await rows<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]);
    return { orgId, slug: (slug as { slug: string }).slug, owner, admin: adm, author, other, viewer };
  }

  const token = (who: Person) =>
    new SignJWT({ role: 'authenticated', email: who.email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const authHeaders = async (o: Org, who: Person) => ({ authorization: `Bearer ${await token(who)}`, 'x-crove-org': o.slug });

  const createNote = async (o: Org, who: Person, visibility: 'private' | 'org', title = 'Ghi chú họp') =>
    (await rt.execute<NoteWritten>('notes.note.create', { title, body: 'Nội dung', visibility }, { actor: asUser(who.id), orgId: o.orgId })).noteId;

  async function upload(o: Org, who: Person, noteId: string, bytes: Uint8Array, filename: string, type = 'application/octet-stream', extra: Record<string, string> = {}) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
    const response = await app.request(`/api/notes/${noteId}/attachments`, { method: 'POST', body: form, headers: { ...(await authHeaders(o, who)), ...extra } });
    const body = (await response.json().catch(() => null)) as { attachment?: NoteAttachment; code?: string } | null;
    return { status: response.status, body, headers: response.headers };
  }
  async function download(o: Org, who: Person, id: string) {
    const response = await app.request(`/api/notes/attachments/${id}`, { headers: await authHeaders(o, who) });
    return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const attached = async (o: Org, who: Person, noteId: string, bytes: Uint8Array, filename: string) => {
    const r = await upload(o, who, noteId, bytes, filename);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body?.attachment as NoteAttachment;
  };
  const search = async (o: Org, who: Person, q: string) =>
    (await rt.query<NoteSummary[]>('notes.note.search', { q }, { actor: asUser(who.id), orgId: o.orgId })).map((n) => n.id);
  const doomed = async (o: Org) =>
    (await rows<{ storage_key: string }>('SELECT storage_key FROM ludy_notes.attachment_blob_doomed WHERE storage_key LIKE $1 ORDER BY 1', [`notes/${o.orgId}/%`])).map((r) => r.storage_key);
  const blobsOf = (o: Org) => [...store.blobs.keys()].filter((k) => k.startsWith(`notes/${o.orgId}/`)).sort();
  const fileRows = async (o: Org) => Number((await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.file WHERE org_id = $1', [o.orgId]))[0]?.n);

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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const appUrl = login('ludy_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: rt, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('stores a pasted screenshot and a PDF under notes/<org>/<id>, never in ludy_kernel.file, and lists them on the note', async () => {
    const o = await org();
    const noteId = await createNote(o, o.author, 'private');
    const shot = await attached(o, o.author, noteId, png(), 'image.png');
    const doc = await attached(o, o.author, noteId, pdf('hop dong'), 'hợp đồng.pdf');
    expect(shot).toMatchObject({ noteId, contentType: 'image/png', extractStatus: 'skipped', filename: 'image.png' });
    expect(doc).toMatchObject({ noteId, contentType: 'application/pdf', extractStatus: 'pending', filename: 'hợp đồng.pdf' });
    expect(blobsOf(o)).toEqual([`notes/${o.orgId}/${shot.id}`, `notes/${o.orgId}/${doc.id}`].sort());
    expect(await fileRows(o)).toBe(0);
    const note = await rt.query<Note>('notes.note.get', { noteId }, { actor: asUser(o.author.id), orgId: o.orgId });
    expect(note.attachments?.map((a) => a.id)).toEqual([shot.id, doc.id]);
    // The PDF asks the worker for its text; the screenshot does not.
    const events = await rows<{ payload: { attachmentId: string } }>("SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'notes.attachment.extract_queued'", [o.orgId]);
    expect(events.map((e) => e.payload.attachmentId)).toEqual([doc.id]);
    // No file name or byte reaches the audit trail of a private note.
    const audit = JSON.stringify(await rows("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.attachment.%'", [o.orgId]));
    expect(audit).not.toContain('hợp đồng');
  });

  it('serves the bytes with nosniff, no-store and a sandbox CSP, inline only for raster images, PDF and audio, and as a download for SVG, HTML and DOCX', async () => {
    const o = await org();
    const noteId = await createNote(o, o.author, 'private');
    const cases: Array<[Uint8Array, string, string, 'inline' | 'attachment']> = [
      [png(), 'anh.png', 'image/png', 'inline'],
      [pdf('x'), 'tai-lieu.pdf', 'application/pdf', 'inline'],
      [svg(), 'logo.svg', 'image/svg+xml', 'attachment'],
      [html(), 'trang.html', 'text/html', 'attachment'],
      [docx(), 'van-ban.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'attachment'],
    ];
    for (const [bytes, name, type, mode] of cases) {
      // The declared type is ignored: SVG declared as PNG is still SVG.
      const a = (await upload(o, o.author, noteId, bytes, name, 'image/png')).body?.attachment as NoteAttachment;
      expect(a.contentType, name).toBe(type);
      const r = await download(o, o.author, a.id);
      expect(r.status, name).toBe(200);
      expect(Buffer.from(r.bytes).equals(Buffer.from(bytes)), name).toBe(true);
      expect(r.headers.get('content-type'), name).toBe(type);
      expect(r.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(r.headers.get('cache-control'), name).toBe('private, no-store');
      expect(r.headers.get('content-security-policy'), name).toMatch(/^sandbox; default-src 'none'/);
      expect(r.headers.get('content-disposition')?.split(';')[0], name).toBe(mode);
    }
  });

  it('answers one uniform 404 to every other member, owner, admin, viewer and org for a private note, and for an unknown, malformed or trashed id', async () => {
    const o = await org();
    const elsewhere = await org();
    const privateNote = await createNote(o, o.author, 'private');
    const sharedNote = await createNote(o, o.author, 'org');
    const hidden = await attached(o, o.author, privateNote, pdf('rieng'), 'rieng.pdf');
    const shared = await attached(o, o.author, sharedNote, pdf('chung'), 'chung.pdf');
    const notFound = await download(o, o.author, randomUUID());
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff');
    expect(notFound.headers.get('cache-control')).toBe('private, no-store');
    const uniform = Buffer.from(notFound.bytes).toString('utf8');
    for (const who of [o.owner, o.admin, o.other, o.viewer]) {
      const r = await download(o, who, hidden.id);
      expect([who.email, r.status]).toEqual([who.email, 404]);
      expect(Buffer.from(r.bytes).toString('utf8')).toBe(uniform);
      // The shared note's file is read by every owner, admin and member of the org; a viewer reads no note (ADR-0037).
      expect([who.email, (await download(o, who, shared.id)).status]).toEqual([who.email, who === o.viewer ? 404 : 200]);
    }
    // Another org's member, under their own org: the same 404.
    const foreign = await download(elsewhere, elsewhere.owner, shared.id);
    expect(foreign.status).toBe(404);
    expect(Buffer.from(foreign.bytes).toString('utf8')).toBe(uniform);
    expect((await download(o, o.author, 'not-a-uuid')).status).toBe(404);
    // In the trash: the author gets the same 404.
    await rt.execute('notes.note.delete', { noteId: privateNote }, { actor: asUser(o.author.id), orgId: o.orgId });
    const trashed = await download(o, o.author, hidden.id);
    expect(trashed.status).toBe(404);
    expect(Buffer.from(trashed.bytes).toString('utf8')).toBe(uniform);
    // Neither the list nor a sha256 probe gives the private file to another member.
    const seen = await rt.query<NoteSummary[]>('notes.note.search', { q: 'rieng' }, { actor: asUser(o.owner.id), orgId: o.orgId });
    expect(seen).toEqual([]);
    await expect(rt.query('notes.attachment.list', { noteId: privateNote }, { actor: asUser(o.owner.id), orgId: o.orgId })).rejects.toMatchObject({ status: 404 });
  });

  it('takes uploads only from the note author, refuses a viewer, a foreign origin and more than 25 MB, and leaves no blob behind a refusal', async () => {
    const o = await org();
    const privateNote = await createNote(o, o.author, 'private');
    const sharedNote = await createNote(o, o.author, 'org');
    expect((await upload(o, o.viewer, sharedNote, pdf('v'), 'v.pdf')).status).toBe(403);
    expect((await upload(o, o.other, sharedNote, pdf('o'), 'o.pdf')).status).toBe(403);
    expect((await upload(o, o.other, privateNote, pdf('o'), 'o.pdf')).status).toBe(404);
    expect((await upload(o, o.owner, privateNote, pdf('o'), 'o.pdf')).status).toBe(404);
    expect((await upload(o, o.author, privateNote, pdf('x'), 'x.pdf', 'application/pdf', { origin: 'https://evil.example.com' })).status).toBe(403);
    // One byte over 25 MiB, sent raw without a length: refused while streaming.
    const big = await app.request(`/api/notes/${privateNote}/attachments?filename=big.bin`, {
      method: 'POST',
      body: new Uint8Array(NOTE_ATTACHMENT_MAX_BYTES + 1),
      headers: { ...(await authHeaders(o, o.author)), 'content-type': 'application/octet-stream' },
    });
    expect(big.status).toBe(413);
    // Exactly 25 MiB is taken.
    const edge = new Uint8Array(NOTE_ATTACHMENT_MAX_BYTES);
    edge.set(pdf('edge'));
    expect((await upload(o, o.author, privateNote, edge, 'edge.pdf')).status).toBe(201);
    expect(blobsOf(o)).toHaveLength(1);
    expect(await fileRows(o)).toBe(0);
  });

  it('extracts the text of a PDF through crove-extract, folds it and the file name into the note search, and keeps it when the note is edited', async () => {
    const o = await org();
    const noteId = await createNote(o, o.author, 'private', 'Họp quý');
    const a = await attached(o, o.author, noteId, pdf('so lieu'), 'bao-cao-quy.pdf');
    expect(await search(o, o.author, 'doi soat')).toEqual([]);
    expect(await search(o, o.author, 'bao cao quy')).toEqual([noteId]);
    expect(await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: a.id })).toEqual({ status: 'done' });
    expect(extract.calls.at(-1)).toBe('pdf_text');
    // A second run finds nothing pending.
    expect(await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: a.id })).toEqual({ status: 'skipped_not_pending' });
    expect(await search(o, o.author, 'doi soat ngan quy')).toEqual([noteId]);
    // Another member, the owner and the admin never find the private note by its file.
    for (const who of [o.owner, o.admin, o.other]) expect(await search(o, who, 'doi soat')).toEqual([]);
    const note = await rt.query<Note>('notes.note.get', { noteId }, { actor: asUser(o.author.id), orgId: o.orgId });
    await rt.execute('notes.note.update', { noteId, revision: note.revision, title: 'Họp quý (sửa)', body: 'Nội dung mới', tags: [] }, { actor: asUser(o.author.id), orgId: o.orgId });
    expect(await search(o, o.author, 'doi soat')).toEqual([noteId]);
    expect(await search(o, o.author, 'noi dung moi')).toEqual([noteId]);
    // The worker definers hand back no note text and refuse any login but the worker's.
    await expect(rows('SELECT * FROM ludy_notes.attachment_for_extract($1::uuid)', [a.id])).rejects.toThrow();
  });

  it('asks again for the text of an attachment still pending after 10 minutes, outside the trash, once per attachment', async () => {
    const o = await org();
    const kept = await createNote(o, o.author, 'private');
    const trashed = await createNote(o, o.author, 'private');
    const waiting = await attached(o, o.author, kept, pdf('cho'), 'cho.pdf');
    const fresh = await attached(o, o.author, kept, pdf('moi'), 'moi.pdf');
    const inTrash = await attached(o, o.author, trashed, pdf('rac'), 'rac.pdf');
    await rt.execute('notes.note.delete', { noteId: trashed }, { actor: asUser(o.author.id), orgId: o.orgId });
    await admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE ludy_notes.attachment SET created_at = now() - interval '20 minutes' WHERE org_id = $1 AND id = ANY($2)", [o.orgId, [waiting.id, inTrash.id]]);
    });
    const sent: Array<{ name: string; data: unknown; key: unknown }> = [];
    const boss = { send: async (name: string, data?: object | null, options?: { singletonKey?: string }) => (sent.push({ name, data, key: options?.singletonKey }), 'job') };
    await requestDueNoteAttachmentExtracts({ runtime: worker, workerDb, boss: boss as never });
    const mine = sent.filter((s) => (s.data as { orgId: string }).orgId === o.orgId);
    expect(mine.map((s) => (s.data as { attachmentId: string }).attachmentId)).toEqual([waiting.id]);
    expect(mine[0]?.name).toBe('notes-attachment-extract');
    expect(mine[0]?.key).toEqual(expect.stringContaining(waiting.id));
    expect(sent.some((s) => [fresh.id, inTrash.id].includes((s.data as { attachmentId: string }).attachmentId))).toBe(false);
    // The app login may not list them.
    await expect(admin((c) => c.query('SET ROLE ludy_app').then(() => c.query('SELECT * FROM ludy_notes.attachment_extract_due(10)')))).rejects.toThrow();
  });

  it('queues the blob on attachment delete, on the trash purge and on a note delete, and the sweep removes it from the store', async () => {
    const o = await org();
    const noteA = await createNote(o, o.author, 'private');
    const noteB = await createNote(o, o.author, 'org');
    const one = await attached(o, o.author, noteA, pdf('1'), 'mot.pdf');
    const two = await attached(o, o.author, noteA, pdf('2'), 'hai.pdf');
    const three = await attached(o, o.author, noteB, pdf('3'), 'ba.pdf');
    // Another member may not delete; the owner may on a shared note.
    await expect(rt.execute('notes.attachment.delete', { attachmentId: three.id }, { actor: asUser(o.other.id), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.execute('notes.attachment.delete', { attachmentId: one.id }, { actor: asUser(o.owner.id), orgId: o.orgId })).rejects.toMatchObject({ status: 404 });
    await rt.execute('notes.attachment.delete', { attachmentId: one.id }, { actor: asUser(o.author.id), orgId: o.orgId });
    await rt.execute('notes.attachment.delete', { attachmentId: three.id }, { actor: asUser(o.owner.id), orgId: o.orgId });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${one.id}`, `notes/${o.orgId}/${three.id}`].sort());
    // The trash purge after 30 days removes the note and its attachment.
    await rt.execute('notes.note.delete', { noteId: noteA }, { actor: asUser(o.author.id), orgId: o.orgId });
    await admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE ludy_notes.note SET deleted_at = now() - interval '40 days' WHERE org_id = $1 AND id = $2", [o.orgId, noteA]);
    });
    await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${one.id}`, `notes/${o.orgId}/${two.id}`, `notes/${o.orgId}/${three.id}`].sort());
    expect(blobsOf(o)).toHaveLength(3);
    await sweepNoteAttachmentBlobs({ workerDb, store, force: true });
    expect(blobsOf(o)).toEqual([]);
    expect(await doomed(o)).toEqual([]);
    // A member may not ask for what the worker reads to extract.
    await expect(rt.query('notes.attachment.extract_source', { attachmentId: two.id }, { actor: asUser(o.author.id), orgId: o.orgId })).rejects.toBeTruthy();
  });

  it('refuses extension tokens (403) on note attachment upload, download and RPC', async () => {
    const o = await org();
    const noteId = await createNote(o, o.author, 'private');
    const att = await attached(o, o.author, noteId, png(), 'anh.png');
    const extToken = newExtensionToken();
    const tokenId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'Clipper', ARRAY['notes'], now(), now() + interval '7 days', $3)`,
      [o.orgId, tokenId, o.author.id, hashExtensionSecret(extToken.value)],
    );
    const extHeaders = { authorization: `Bearer ${extToken.value}`, 'x-crove-org': o.slug };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png())], { type: 'image/png' }), 'ext.png');
    const up = await app.request(`/api/notes/${noteId}/attachments`, { method: 'POST', body: form, headers: extHeaders });
    expect(up.status).toBe(403);
    const dl = await app.request(`/api/notes/attachments/${att.id}`, { headers: extHeaders });
    expect(dl.status).toBe(403);
    const extActor = { type: 'user' as const, userId: o.author.id, aal: 'aal1' as const, extension: { tokenId, scopes: ['notes'] as const } };
    await expect(rt.query('notes.attachment.list', { noteId }, { actor: extActor, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.execute('notes.attachment.delete', { attachmentId: att.id }, { actor: extActor, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('queues private attachment blobs on member_items_purge and PDPL find/notify/erase without leaking private text', async () => {
    const o = await org();
    const privNote = await createNote(o, o.author, 'private', 'Ghi chú riêng');
    const sharedNote = await createNote(o, o.author, 'org', 'Ghi chú chung');
    const email = 'khach-hang@example.com';

    const privAtt = await attached(o, o.author, privNote, pdf('rieng'), 'ho-so-rieng.pdf');
    const sharedAtt = await attached(o, o.author, sharedNote, pdf('chung'), 'tai-lieu-chung.pdf');
    extract.text = `Liên hệ ${email} để đối chiếu`;
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: privAtt.id });
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: sharedAtt.id });

    const found = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: email }, { actor: asUser(o.owner.id), orgId: o.orgId });
    expect(found.matches.map((m) => m.column).sort()).toEqual(['ludy_notes.attachment.extracted_text']);
    expect(found.privateItems).toEqual([{ authorUserId: o.author.id, notes: 1, todos: 0 }]);
    expect(JSON.stringify(found)).not.toContain('ho-so-');

    // First erase (before notice): removes shared attachment + queues its blob; keeps private attachment.
    const firstErase = await rt.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect(firstErase.erased).toContainEqual({ column: 'ludy_notes.attachment.extracted_text', rows: 1 });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${sharedAtt.id}`]);

    // Notify + dispatch + age 25 hours, then second erase removes the private attachment + queues its blob.
    await rt.execute<PersonalDataNotice>('kernel.personal_data.notify', { value: email }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    const [notifiedEvent] = await rows<{ id: string }>(`SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`, [o.orgId]);
    await worker.execute('kernel.notification.dispatch', { eventId: notifiedEvent?.id }, { actor: SYSTEM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [o.orgId]);
      await c.query(`UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`, [o.orgId]);
      await c.query('COMMIT');
    });
    await rt.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${privAtt.id}`, `notes/${o.orgId}/${sharedAtt.id}`].sort());

    // Now test member_items.purge cascading a remaining private attachment and keeping shared ones.
    const privTwo = await createNote(o, o.author, 'private', 'Tệp thành viên rời');
    const sharedTwo = await createNote(o, o.author, 'org', 'Tệp chung giữ lại');
    const purgeAtt = await attached(o, o.author, privTwo, png(), 'roi-nhom.png');
    const keptAtt = await attached(o, o.author, sharedTwo, png(), 'giu-lai.png');
    await rt.execute('kernel.member.remove', { userId: o.author.id }, { actor: asMfa(o.owner.id), orgId: o.orgId });
    const [removedEvt] = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.removed' AND payload ->> 'userId' = $2 ORDER BY id DESC LIMIT 1`,
      [o.orgId, o.author.id],
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '35 days' WHERE org_id = $1 AND command = 'kernel.member.remove'`, [o.orgId]);
      await c.query('COMMIT');
    });
    expect(await worker.execute('notes.member_items.purge', { userId: o.author.id, eventId: removedEvt?.id }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 2 });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${privAtt.id}`, `notes/${o.orgId}/${purgeAtt.id}`, `notes/${o.orgId}/${sharedAtt.id}`].sort());
    await sweepNoteAttachmentBlobs({ workerDb, store, force: true });
    expect(blobsOf(o)).toEqual([`notes/${o.orgId}/${keptAtt.id}`]);
  });
});
