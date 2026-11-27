// SPDX-License-Identifier: AGPL-3.0-only
// Files attached to a note on PostgreSQL 17 (Notes v2 E2, #3561, owner decision A3, ADR-0037): the bytes go through
// POST /api/notes/:noteId/attachments into the blob store under notes/<org>/<attachment> and a ludy_notes.attachment row,
// never ludy_kernel.file; GET /api/notes/attachments/:id serves them only to whoever reads the parent note, with nosniff,
// no-store, a sandbox CSP, inline only for raster images, PDF and safe audio, and one uniform 404 for an id that is foreign,
// unknown, unreadable or in the trash. The worker extracts text through crove-extract (a stand-in here) and the note's search
// finds it, an edit of the note keeping it. Every deletion path queues the blob for the worker's sweep. Set
// LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  createOrg,
  FAILED_NOTE_ATTACHMENT_REASON,
  FAILED_PRIVATE_NOTE_ATTACHMENT_REASON,
  kernelCommands,
  kernelQueries,
  PENDING_NOTE_ATTACHMENT_REASON,
  PENDING_PRIVATE_NOTE_ATTACHMENT_REASON,
  upsertIdentity,
} from '@ludy/kernel';
import type { ExtractClient, ExtractKind, ExtractResult } from '@ludy/extract-contract';
import type { PersonalDataErasure, PersonalDataNotice, PersonalDataResult } from '@ludy/kernel-contract';
import { NOTE_ATTACHMENT_MAX_BYTES, type Note, type NoteAttachment, type NoteSummary, type NoteWritten } from '@ludy/kernel-contract';
import { mintContextToken, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT, notesCommands, notesQueries } from '@ludy/mod-notes';
import { hashExtensionSecret, newExtensionToken } from '../src/auth-extension.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { JOB_SCHEMA } from '../src/jobs-schema.ts';
import { queueNoteAttachmentExtract, requestDueNoteAttachmentExtracts, runNoteAttachmentExtract, sweepNoteAttachmentBlobs } from '../src/notes-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'notes' };
const SECRET = 'test-only-jwt-secret-for-note-attachments-0123456789';
const ISSUER = 'https://issuer.example.com';

// Tracks started concurrent commands so early rejections are observed immediately during lock-wait polling and drained after gate ROLLBACK.
function createConcurrencyTracker() {
  const started: Array<Promise<unknown>> = [];
  let earlyError: { error: unknown } | null = null;
  return {
    track<T>(promise: Promise<T>): Promise<T> {
      void promise.catch((err) => {
        if (!earlyError) earlyError = { error: err };
      });
      started.push(promise);
      return promise;
    },
    throwIfFailed(): void {
      if (earlyError) throw earlyError.error;
    },
    async drain(): Promise<void> {
      await Promise.allSettled(started);
    },
  };
}

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
const svgWithLongProlog = () =>
  enc.encode(`<?xml version="1.0"?>\n<!-- ${'x'.repeat(1500)} -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
const html = () => enc.encode('<!doctype html><html><body><script>alert(1)</script></body></html>');
const htmlWithLongComment = () =>
  enc.encode(`<!-- ${'y'.repeat(1500)} -->\n<!doctype html><html><body><script>alert(1)</script></body></html>`);
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
  const dbName = `ludy_test_notes_attachments_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const waitBlockedOnPid = async (
    blockingPid: number,
    queryPattern: string,
    tracker: ReturnType<typeof createConcurrencyTracker>,
  ): Promise<number> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      tracker.throwIfFailed();
      const waits = await rows<{ pid: number }>(
        `SELECT a.pid
           FROM pg_catalog.pg_stat_activity a
          WHERE a.datname = pg_catalog.current_database()
            AND a.state = 'active'
            AND a.wait_event_type = 'Lock'
            AND a.query ILIKE $2
            AND $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
          LIMIT 1`,
        [blockingPid, queryPattern],
      );
      if (waits[0]) return waits[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for query ${queryPattern} to block on pid ${blockingPid}`);
  };

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
  const authHeaders = async (o: Org, who: Person) => ({ authorization: `Bearer ${await token(who)}`, 'x-ludy-org': o.slug });

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
      [svgWithLongProlog(), 'spoofed-svg.png', 'image/svg+xml', 'attachment'],
      [html(), 'trang.html', 'text/html', 'attachment'],
      [htmlWithLongComment(), 'spoofed-html.png', 'text/html', 'attachment'],
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
    const sent: Array<{ name: string; data: unknown; key: unknown; singletonSeconds: unknown }> = [];
    const boss = {
      send: async (name: string, data?: object | null, options?: { singletonKey?: string; singletonSeconds?: number }) => (
        sent.push({ name, data, key: options?.singletonKey, singletonSeconds: options?.singletonSeconds }),
        'job'
      ),
    };
    await requestDueNoteAttachmentExtracts({ runtime: worker, workerDb, boss: boss as never });
    const mine = sent.filter((s) => (s.data as { orgId: string }).orgId === o.orgId);
    expect(mine.map((s) => (s.data as { attachmentId: string }).attachmentId)).toEqual([waiting.id]);
    expect(mine[0]?.name).toBe('notes-attachment-extract');
    expect(mine[0]?.key).toEqual(expect.stringContaining(waiting.id));
    expect(mine[0]?.singletonSeconds).toBe(300);
    expect(sent.some((s) => [fresh.id, inTrash.id].includes((s.data as { attachmentId: string }).attachmentId))).toBe(false);
    // Live PgBoss deduplicates repeated sends for the same org+attachment within the 300s singleton slot while keeping orgs isolated.
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    const pgBoss = new PgBoss({
      connectionString: workerUrl.toString(),
      schema: JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    pgBoss.on('error', () => {});
    await pgBoss.start();
    try {
      const attId = randomUUID();
      const firstId = await queueNoteAttachmentExtract(pgBoss, {
        org_id: o.orgId,
        event_id: randomUUID(),
        type: NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT,
        payload: { attachmentId: attId },
      });
      const dupId = await queueNoteAttachmentExtract(pgBoss, {
        org_id: o.orgId,
        event_id: randomUUID(),
        type: NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT,
        payload: { attachmentId: attId },
      });
      const otherOrgId = await queueNoteAttachmentExtract(pgBoss, {
        org_id: randomUUID(),
        event_id: randomUUID(),
        type: NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT,
        payload: { attachmentId: attId },
      });
      expect(firstId).toEqual(expect.any(String));
      expect(dupId).toBeNull();
      expect(otherOrgId).toEqual(expect.any(String));
    } finally {
      await pgBoss.stop({ graceful: false }).catch(() => {});
    }
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
    const extHeaders = { authorization: `Bearer ${extToken.value}`, 'x-ludy-org': o.slug };
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
    expect(found.pendingNoteAttachments).toBeUndefined();
    expect(JSON.stringify(found)).not.toContain('ho-so-');

    // Backdate both notes' updated_at so we verify shared- and private-note attachment erasure symmetrically bump updated_at.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_notes.note SET updated_at = updated_at - interval '1 hour' WHERE org_id = $1 AND id = ANY($2::uuid[])`, [o.orgId, [privNote, sharedNote]]);
      await c.query('COMMIT');
    });
    const noteTimestamps = async () => {
      const result = await rows<{ id: string; updated_at: Date | string }>(
        `SELECT id, updated_at FROM ludy_notes.note WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [o.orgId, [privNote, sharedNote]],
      );
      const map = new Map(result.map((r) => [r.id, new Date(r.updated_at).getTime()]));
      return { priv: map.get(privNote) ?? 0, shared: map.get(sharedNote) ?? 0 };
    };
    const beforeFirstErase = await noteTimestamps();

    // First erase (before notice): removes shared attachment + queues its blob; keeps private attachment.
    const firstErase = await rt.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect(firstErase.erased).toContainEqual({ column: 'ludy_notes.attachment.extracted_text', rows: 1 });
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${sharedAtt.id}`]);
    const afterFirstErase = await noteTimestamps();
    expect(afterFirstErase.shared).toBeGreaterThan(beforeFirstErase.shared);
    expect(afterFirstErase.priv).toBe(beforeFirstErase.priv);

    // Notify + dispatch + age 25 hours, then second erase removes the private attachment + queues its blob and bumps privNote.updated_at.
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
    const afterSecondErase = await noteTimestamps();
    expect(afterSecondErase.priv).toBeGreaterThan(afterFirstErase.priv);

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

  it('erases private attachments concurrently with notes.attachment.create and notes.link.add(kernel.party) without deadlocking, privilege errors, or regressing updated_at (#5035)', async () => {
    const o = await org();
    const email = 'dong-bo-xoa@example.com';
    const partyId = randomUUID();
    await rows(`INSERT INTO ludy_kernel.party (org_id, id, name, email) VALUES ($1, $2, 'Khách đồng bộ', $3)`, [o.orgId, partyId, email]);
    const monotonicNote = await createNote(o, o.author, 'private', 'Ghi chú giữ mốc thời gian');
    const concurrentNote = await createNote(o, o.author, 'private', 'Ghi chú đồng thời gắn liên kết');
    const linkRaceNote = await createNote(o, o.author, 'private', 'Ghi chú nối liên kết đồng thời');
    const att1 = await attached(o, o.author, monotonicNote, pdf('m1'), 'moc-thoi-gian.pdf');
    const att2 = await attached(o, o.author, concurrentNote, pdf('m2'), 'hop-dong.pdf');
    extract.text = `Email liên hệ: ${email}`;
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: att1.id });
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: att2.id });

    await rt.execute<PersonalDataNotice>('kernel.personal_data.notify', { value: email }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    const [notifiedEvt] = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`,
      [o.orgId],
    );
    await worker.execute('kernel.notification.dispatch', { eventId: notifiedEvt?.id }, { actor: SYSTEM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [o.orgId]);
      await c.query(`UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`, [o.orgId]);
      // Push updated_at ahead of transaction start time on both notes so neither erasure nor concurrent attachment/link writes can regress it.
      await c.query(
        `UPDATE ludy_notes.note SET updated_at = pg_catalog.clock_timestamp() + interval '10 minutes' WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [o.orgId, [monotonicNote, concurrentNote]],
      );
      await c.query('COMMIT');
    });
    const noteUpdatedAt = async (noteId: string) => {
      const result = await rows<{ updated_at: Date | string }>(
        `SELECT updated_at FROM ludy_notes.note WHERE org_id = $1 AND id = $2`,
        [o.orgId, noteId],
      );
      if (!result[0]) throw new Error(`missing note ${noteId}`);
      return new Date(result[0].updated_at).getTime();
    };
    const beforeMonotonicTs = await noteUpdatedAt(monotonicNote);
    const beforeConcurrentTs = await noteUpdatedAt(concurrentNote);

    const lockClient = new pg.Client({ connectionString: adminUrl });
    await lockClient.connect();
    let eraseOut!: PersonalDataErasure;
    let extraAtt!: NoteAttachment;
    const tracker = createConcurrencyTracker();
    try {
      const pidRes = await lockClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
      const lockPid = pidRes.rows[0]?.pid;
      expect(lockPid).toBeTypeOf('number');
      await lockClient.query('BEGIN');
      // Hold concurrentNote FOR UPDATE (like notes.link.add before insertRecordLink) so private_erase and attachment.create must wait on it.
      await lockClient.query('SELECT 1 FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, concurrentNote]);
      const erasePromise = tracker.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: email },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      let sawEraseLockWait = false;
      let erasePid: number | undefined;
      const deadline = Date.now() + 1500;
      while (!sawEraseLockWait && Date.now() < deadline) {
        tracker.throwIfFailed();
        const waits = await rows<{ pid: number }>(
          `SELECT a.pid
             FROM pg_catalog.pg_stat_activity a
            WHERE a.datname = pg_catalog.current_database()
              AND a.state = 'active'
              AND a.wait_event_type = 'Lock'
              AND a.query LIKE '%ludy_notes.private_erase%'
              AND $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
            LIMIT 1`,
          [lockPid],
        );
        if (waits[0]) {
          sawEraseLockWait = true;
          erasePid = waits[0].pid;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(sawEraseLockWait).toBe(true);
      // Also launch notes.attachment.create against concurrentNote while lockClient holds it so erase and attachment.create genuinely contend upon release.
      const attachPromise = tracker.track(attached(o, o.author, concurrentNote, pdf('extra'), 'bo-sung.pdf'));
      let sawAttachLockWait = false;
      const attachDeadline = Date.now() + 1000;
      while (!sawAttachLockWait && Date.now() < attachDeadline) {
        tracker.throwIfFailed();
        const waits = await rows<{ n: number }>(
          `SELECT 1 AS n
             FROM pg_catalog.pg_stat_activity a
            WHERE a.datname = pg_catalog.current_database()
              AND a.state = 'active'
              AND a.wait_event_type = 'Lock'
              AND a.query NOT LIKE '%ludy_notes.private_erase%'
              AND (
                $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
                OR ($2::int IS NOT NULL AND $2::int = ANY(pg_catalog.pg_blocking_pids(a.pid)))
              )
            LIMIT 1`,
          [lockPid, erasePid ?? null],
        );
        if (waits.length > 0) sawAttachLockWait = true;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sawAttachLockWait).toBe(true);
      // While personalDataErase holds party FOR NO KEY UPDATE and waits on concurrentNote, invoke real notes.link.add
      // against that party on a separate note and confirm it completes without blocking or deadlocking.
      let linkTimer: ReturnType<typeof setTimeout> | undefined;
      const concurrentLinkPromise = tracker.track(
        rt.execute<{ noteId: string; linkId: string }>(
          'notes.link.add',
          { noteId: linkRaceNote, targetType: 'kernel.party', targetId: partyId },
          { actor: asUser(o.author.id), orgId: o.orgId },
        ),
      );
      const concurrentLinkOut = await Promise.race([
        concurrentLinkPromise,
        new Promise<never>((_, reject) => {
          linkTimer = setTimeout(
            () => reject(new Error('notes.link.add blocked while personalDataErase held party FOR NO KEY UPDATE')),
            2000,
          );
        }),
      ]).finally(() => {
        if (linkTimer) clearTimeout(linkTimer);
      });
      expect(concurrentLinkOut.noteId).toBe(linkRaceNote);
      // While personalDataErase holds party FOR NO KEY UPDATE and waits on concurrentNote, link_party_fk acquires FOR KEY SHARE on party without deadlocking.
      await lockClient.query(
        `INSERT INTO ludy_notes.link (org_id, note_id, todo_id, target_type, target_id, party_id, created_by)
         VALUES ($1, $2, NULL, 'kernel.party', $3, $3, $4)`,
        [o.orgId, concurrentNote, partyId, o.author.id],
      );
      await lockClient.query('COMMIT');
      [eraseOut, extraAtt] = await Promise.all([erasePromise, attachPromise]);
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      await tracker.drain();
      await lockClient.end().catch(() => undefined);
    }

    const linkOut = await rt.execute<{ noteId: string; linkId: string }>(
      'notes.link.add',
      { noteId: monotonicNote, targetType: 'kernel.party', targetId: partyId },
      { actor: asUser(o.author.id), orgId: o.orgId },
    );
    expect(extraAtt.noteId).toBe(concurrentNote);
    expect(eraseOut.erased).toContainEqual({ column: 'ludy_kernel.party.email', rows: 1 });
    expect(linkOut.noteId).toBe(monotonicNote);
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${att1.id}`, `notes/${o.orgId}/${att2.id}`].sort());
    expect(await noteUpdatedAt(monotonicNote)).toBeGreaterThanOrEqual(beforeMonotonicTs);
    expect(await noteUpdatedAt(concurrentNote)).toBeGreaterThanOrEqual(beforeConcurrentTs);

    // Attachment delete on a note whose updated_at is ahead of transaction time must also keep updated_at monotonic.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_notes.note SET updated_at = pg_catalog.clock_timestamp() + interval '10 minutes' WHERE org_id = $1 AND id = $2`, [o.orgId, concurrentNote]);
      await c.query('COMMIT');
    });
    const beforeDeleteTs = await noteUpdatedAt(concurrentNote);
    await rt.execute('notes.attachment.delete', { attachmentId: extraAtt.id }, { actor: asUser(o.author.id), orgId: o.orgId });
    expect(await noteUpdatedAt(concurrentNote)).toBeGreaterThanOrEqual(beforeDeleteTs);

    // Uppercase notebookId in notes.note.create must hash the same lowercase advisory lock key as PostgreSQL nb.id::text in private_erase.
    const privNb = await rt.execute<{ notebookId: string }>(
      'notes.notebook.create',
      { name: 'Sổ tay chữ hoa', visibility: 'private' },
      { actor: asUser(o.author.id), orgId: o.orgId },
    );
    const nbLockClient = new pg.Client({ connectionString: adminUrl });
    await nbLockClient.connect();
    const nbTracker = createConcurrencyTracker();
    try {
      const pidRes = await nbLockClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
      const nbLockPid = pidRes.rows[0]?.pid;
      expect(nbLockPid).toBeTypeOf('number');
      await nbLockClient.query('BEGIN');
      await nbLockClient.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
        [`notes.notebook:${o.orgId.toLowerCase()}:${privNb.notebookId.toLowerCase()}`],
      );
      const upperNotePromise = nbTracker.track(
        rt.execute<NoteWritten>(
          'notes.note.create',
          { title: 'Ghi chú UUID hoa', body: 'Nội dung', visibility: 'private', notebookId: privNb.notebookId.toUpperCase() },
          { actor: asUser(o.author.id), orgId: o.orgId },
        ),
      );
      let sawNbLockWait = false;
      const nbDeadline = Date.now() + 1500;
      while (!sawNbLockWait && Date.now() < nbDeadline) {
        nbTracker.throwIfFailed();
        const waits = await rows<{ n: number }>(
          `SELECT 1 AS n
             FROM pg_catalog.pg_stat_activity a
            WHERE a.datname = pg_catalog.current_database()
              AND a.state = 'active'
              AND a.wait_event_type = 'Lock'
              AND a.query LIKE '%pg_advisory_xact_lock_shared%'
              AND $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
            LIMIT 1`,
          [nbLockPid],
        );
        if (waits.length > 0) sawNbLockWait = true;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sawNbLockWait).toBe(true);
      await nbLockClient.query('COMMIT');
      const upperCreated = await upperNotePromise;
      expect(upperCreated.noteId).toBeTruthy();
    } finally {
      await nbLockClient.query('ROLLBACK').catch(() => undefined);
      await nbTracker.drain();
      await nbLockClient.end().catch(() => undefined);
    }
  });

  it('serializes concurrent personalDataErase across shared notebooks and private note moves into those notebooks without deadlocking (#5035)', async () => {
    const o = await org();
    const emailA = 'doi-tac-a@example.com';
    const emailB = 'doi-tac-b@example.com';
    const sharedNbA = await rt.execute<{ notebookId: string }>(
      'notes.notebook.create',
      { name: `Sổ tay đối tác ${emailA}`, visibility: 'org' },
      { actor: asUser(o.owner.id), orgId: o.orgId },
    );
    const sharedNbB = await rt.execute<{ notebookId: string }>(
      'notes.notebook.create',
      { name: `Sổ tay đối tác ${emailB}`, visibility: 'org' },
      { actor: asUser(o.owner.id), orgId: o.orgId },
    );
    const createdA = await rt.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chú riêng 1', body: 'Nội dung sạch', visibility: 'private' },
      { actor: asUser(o.author.id), orgId: o.orgId },
    );
    const createdB = await rt.execute<NoteWritten>(
      'notes.note.create',
      { title: 'Ghi chú riêng 2', body: 'Nội dung sạch', visibility: 'private' },
      { actor: asUser(o.author.id), orgId: o.orgId },
    );
    const attA = await attached(o, o.author, createdA.noteId, pdf('a'), 'dinh-kem-a.pdf');
    extract.text = `Email liên hệ: ${emailA}`;
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: attA.id });
    const attB = await attached(o, o.author, createdB.noteId, pdf('b'), 'dinh-kem-b.pdf');
    extract.text = `Email liên hệ: ${emailB}`;
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: attB.id });

    for (const val of [emailA, emailB]) {
      await rt.execute<PersonalDataNotice>('kernel.personal_data.notify', { value: val }, { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() });
    }
    const notifiedEvts = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 2`,
      [o.orgId],
    );
    for (const evt of notifiedEvts) {
      await worker.execute('kernel.notification.dispatch', { eventId: evt.id }, { actor: SYSTEM, orgId: o.orgId });
    }
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [o.orgId]);
      await c.query(`UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`, [o.orgId]);
      await c.query('COMMIT');
    });

    const waitBlockedOnPid = async (
      blockingPid: number,
      queryPattern: string,
      tracker: ReturnType<typeof createConcurrencyTracker>,
    ): Promise<number> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        tracker.throwIfFailed();
        const waits = await rows<{ pid: number }>(
          `SELECT a.pid
             FROM pg_catalog.pg_stat_activity a
            WHERE a.datname = pg_catalog.current_database()
              AND a.state = 'active'
              AND a.wait_event_type = 'Lock'
              AND a.query ILIKE $2
              AND $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
            LIMIT 1`,
          [blockingPid, queryPattern],
        );
        if (waits[0]) return waits[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for query ${queryPattern} to block on pid ${blockingPid}`);
    };

    // Interleaving 1: erase holds shared notebook row lock + notes.erase barrier and waits on createdA row lock while noteUpdate tries to move createdA -> sharedNbA.
    const gateA = new pg.Client({ connectionString: adminUrl });
    await gateA.connect();
    const trackerA = createConcurrencyTracker();
    try {
      const gateAPid = (await gateA.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await gateA.query('BEGIN');
      await gateA.query('SELECT 1 FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, createdA.noteId]);
      const erasePromise = trackerA.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: emailA },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      const erasePid = await waitBlockedOnPid(gateAPid, '%private_erase%', trackerA);
      const movePromise = trackerA.track(
        rt.execute<NoteWritten>(
          'notes.note.update',
          { noteId: createdA.noteId, revision: createdA.revision, notebookId: sharedNbA.notebookId },
          { actor: asUser(o.author.id), orgId: o.orgId },
        ),
      );
      await waitBlockedOnPid(erasePid, '%pg_advisory_xact_lock_shared%', trackerA);
      await gateA.query('COMMIT');
      const [eraseRes, moveRes] = await Promise.all([erasePromise, movePromise]);
      expect(eraseRes.erased).toContainEqual({ column: 'ludy_notes.notebook.name', rows: 1 });
      expect(moveRes.noteId).toBe(createdA.noteId);
    } finally {
      await gateA.query('ROLLBACK').catch(() => undefined);
      await trackerA.drain();
      await gateA.end().catch(() => undefined);
    }

    // Interleaving 2: noteUpdate holds shared notes.erase barrier and createdB FOR UPDATE while erase(emailB) arrives.
    const gateB = new pg.Client({ connectionString: adminUrl });
    await gateB.connect();
    const trackerB = createConcurrencyTracker();
    try {
      const gateBPid = (await gateB.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await gateB.query('BEGIN');
      await gateB.query('SELECT 1 FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, createdB.noteId]);
      const movePromise = trackerB.track(
        rt.execute<NoteWritten>(
          'notes.note.update',
          { noteId: createdB.noteId, revision: createdB.revision, notebookId: sharedNbB.notebookId },
          { actor: asUser(o.author.id), orgId: o.orgId },
        ),
      );
      const movePid = await waitBlockedOnPid(gateBPid, '%from "ludy_notes"."note"%for update%', trackerB);
      const erasePromise = trackerB.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: emailB },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      await waitBlockedOnPid(movePid, '%pg_advisory_xact_lock%', trackerB);
      await gateB.query('COMMIT');
      const [moveRes, eraseRes] = await Promise.all([movePromise, erasePromise]);
      expect(moveRes.noteId).toBe(createdB.noteId);
      expect(eraseRes.erased).toContainEqual({ column: 'ludy_notes.notebook.name', rows: 1 });
    } finally {
      await gateB.query('ROLLBACK').catch(() => undefined);
      await trackerB.drain();
      await gateB.end().catch(() => undefined);
    }

    const nbRows = await rows<{ id: string; name: string }>(
      'SELECT id, name FROM ludy_notes.notebook WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [o.orgId, [sharedNbA.notebookId, sharedNbB.notebookId]],
    );
    expect(nbRows).toHaveLength(2);
    expect(nbRows.every((nb) => !nb.name.includes(emailA) && !nb.name.includes(emailB))).toBe(true);
    const movedRows = await rows<{ id: string; notebook_id: string | null }>(
      'SELECT id, notebook_id FROM ludy_notes.note WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [o.orgId, [createdA.noteId, createdB.noteId]],
    );
    expect(movedRows).toEqual(
      expect.arrayContaining([
        { id: createdA.noteId, notebook_id: sharedNbA.notebookId },
        { id: createdB.noteId, notebook_id: sharedNbB.notebookId },
      ]),
    );
    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${attA.id}`, `notes/${o.orgId}/${attB.id}`].sort());
  });

  it('erases shared-note attachments concurrently with notes.attachment.delete without deadlocking or regressing updated_at (#5035)', async () => {
    const o = await org();
    const sharedEmail = 'chia-se-dinh-kem@example.com';
    const sharedNote = await createNote(o, o.author, 'org', 'Ghi chú dùng chung sạch');
    const sharedAtt1 = await attached(o, o.author, sharedNote, pdf('s1'), 'dinh-kem-chia-se-1.pdf');
    extract.text = `Email liên hệ: ${sharedEmail}`;
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: sharedAtt1.id });
    const sharedAtt2 = await attached(o, o.author, sharedNote, pdf('s2'), 'dinh-kem-chia-se-2.pdf');

    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_notes.note SET updated_at = pg_catalog.clock_timestamp() + interval '10 minutes' WHERE org_id = $1 AND id = $2`, [o.orgId, sharedNote]);
      await c.query('COMMIT');
    });
    const noteUpdatedAt = async () => {
      const result = await rows<{ updated_at: Date | string }>(
        `SELECT updated_at FROM ludy_notes.note WHERE org_id = $1 AND id = $2`,
        [o.orgId, sharedNote],
      );
      return new Date(result[0]!.updated_at).getTime();
    };
    const beforeTs = await noteUpdatedAt();

    const attGate = new pg.Client({ connectionString: adminUrl });
    await attGate.connect();
    const attTracker = createConcurrencyTracker();
    try {
      const attGatePid = (await attGate.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await attGate.query('BEGIN');
      // Hold sharedAtt1 row lock so personalDataErase acquires sharedNote FOR NO KEY UPDATE first and waits at attachment DELETE.
      await attGate.query('SELECT 1 FROM ludy_notes.attachment WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, sharedAtt1.id]);
      const erasePromise = attTracker.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: sharedEmail },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      const erasePid = await waitBlockedOnPid(attGatePid, '%delete from ludy_notes.attachment%', attTracker);
      // Concurrent noteAttachmentDelete on sharedAtt2 blocks cleanly on erasePid's parent sharedNote lock (note -> attachment order).
      const deletePromise = attTracker.track(
        rt.execute(
          'notes.attachment.delete',
          { attachmentId: sharedAtt2.id },
          { actor: asUser(o.author.id), orgId: o.orgId },
        ),
      );
      await waitBlockedOnPid(erasePid, '%from "ludy_notes"."note"%for update%', attTracker);
      await attGate.query('COMMIT');
      const [eraseRes] = await Promise.all([erasePromise, deletePromise]);
      expect(eraseRes.erased).toContainEqual({ column: 'ludy_notes.attachment.extracted_text', rows: 1 });
    } finally {
      await attGate.query('ROLLBACK').catch(() => undefined);
      await attTracker.drain();
      await attGate.end().catch(() => undefined);
    }

    expect(await doomed(o)).toEqual([`notes/${o.orgId}/${sharedAtt1.id}`, `notes/${o.orgId}/${sharedAtt2.id}`].sort());
    expect(await noteUpdatedAt()).toBeGreaterThanOrEqual(beforeTs);

    // Concurrent attachmentExtractRecord waits on personalDataErase's shared notes.erase barrier instead of writing matching text mid-erasure (#5035).
    const raceEmail = 'extract-lock-race@example.com';
    const cleanNote = await createNote(o, o.author, 'org', 'Ghi chú sạch chờ extract');
    const pendingAtt = await attached(o, o.author, cleanNote, pdf('pending-extract'), 'sach-cho-extract.pdf');
    const blockerNote = await createNote(o, o.author, 'org', `Báo cáo ${raceEmail}`);
    const extractGate = new pg.Client({ connectionString: adminUrl });
    await extractGate.connect();
    const extractTracker = createConcurrencyTracker();
    try {
      const extractGatePid = (await extractGate.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await extractGate.query('BEGIN');
      await extractGate.query('SELECT 1 FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, blockerNote]);
      const erasePromise2 = extractTracker.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: raceEmail },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      const erasePid2 = await waitBlockedOnPid(extractGatePid, '%SELECT n.id FROM ludy_notes.note n%', extractTracker);
      const extractPromise = extractTracker.track(
        worker.execute<{ updated: boolean }>(
          'notes.attachment.extract_record',
          { attachmentId: pendingAtt.id, status: 'done', extractedText: `Contact ${raceEmail}` },
          { actor: { type: 'system', component: 'notes' }, orgId: o.orgId },
        ),
      );
      await waitBlockedOnPid(erasePid2, '%pg_advisory_xact_lock_shared%', extractTracker);
      await extractGate.query('COMMIT');
      const [eraseRes2, extractRes] = await Promise.all([erasePromise2, extractPromise]);
      expect(eraseRes2.erased).toContainEqual({ column: 'ludy_notes.note.title', rows: 1 });
      // Initial erasure does not pretend completeness while pendingAtt is still awaiting text extraction.
      expect(eraseRes2.kept).toContainEqual({
        column: 'ludy_notes.attachment.extracted_text',
        rows: 1,
        reason: PENDING_NOTE_ATTACHMENT_REASON,
      });
      expect(extractRes).toEqual({ updated: true });

      // Follow-up erasure after extraction finishes catches the newly extracted text and cleans up cleanly.
      const followUpErase = await rt.execute<PersonalDataErasure>(
        'kernel.personal_data.erase',
        { value: raceEmail },
        { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
      expect(followUpErase.erased).toContainEqual({ column: 'ludy_notes.attachment.extracted_text', rows: 1 });
      expect(followUpErase.kept).toEqual([]);
      const remainingAtt = await rows<{ id: string }>(
        'SELECT id FROM ludy_notes.attachment WHERE org_id = $1 AND id = $2',
        [o.orgId, pendingAtt.id],
      );
      expect(remainingAtt).toEqual([]);
      expect(await doomed(o)).toContain(`notes/${o.orgId}/${pendingAtt.id}`);
    } finally {
      await extractGate.query('ROLLBACK').catch(() => undefined);
      await extractTracker.drain();
      await extractGate.end().catch(() => undefined);
    }
  });

  it('reports private pending attachments under kept during erasure without disclosing note/filename metadata, and clears on follow-up erase (#5035)', async () => {
    const o = await org();
    const privEmail = 'private-pending-race@example.com';
    const privCleanNote = await createNote(o, o.author, 'private', 'Ghi chú riêng sạch chờ extract');
    const privPendingAtt = await attached(o, o.author, privCleanNote, pdf('private-pending'), 'bi-mat-cho-extract.pdf');

    // Direct calls without owner user context are refused by the SECURITY DEFINER count helper.
    await expect(rows('SELECT ludy_notes.private_pending_attachment_count()')).rejects.toThrow();
    await expect(workerPool.query('SELECT ludy_notes.private_pending_attachment_count()')).rejects.toThrow();
    // Under authenticated ludy_tenant sessions, non-owners (admin and author member) get 42501 while owner reads exact pending count.
    const queryPendingCountAs = async (who: Person): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: who.id,
          orgId: o.orgId,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        });
        await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, ctxToken]);
        const res = await client.query<{ n: string }>('SELECT ludy_notes.private_pending_attachment_count()::text AS n');
        return res.rows[0]?.n ?? '';
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await expect(queryPendingCountAs(o.admin)).rejects.toMatchObject({ code: '42501', message: 'NOTES_FORBIDDEN' });
    await expect(queryPendingCountAs(o.author)).rejects.toMatchObject({ code: '42501', message: 'NOTES_FORBIDDEN' });
    await expect(queryPendingCountAs(o.owner)).resolves.toBe('1');

    const firstErase = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: privEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(firstErase.kept).toContainEqual({
      column: 'ludy_notes.attachment',
      rows: 1,
      reason: PENDING_PRIVATE_NOTE_ATTACHMENT_REASON,
    });
    const firstJson = JSON.stringify(firstErase);
    expect(firstJson).not.toContain('bi-mat-cho-extract');
    expect(firstJson).not.toContain(privCleanNote);
    expect(firstJson).not.toContain(privPendingAtt.id);
    expect(firstJson).not.toContain(o.author.id);

    // Worker finishes extraction with matching PII, then follow-up find/notify/erase deletes the private note and clears kept[].
    const recorded = await worker.execute<{ updated: boolean }>(
      'notes.attachment.extract_record',
      { attachmentId: privPendingAtt.id, status: 'done', extractedText: `Private ${privEmail}` },
      { actor: { type: 'system', component: 'notes' }, orgId: o.orgId },
    );
    expect(recorded).toEqual({ updated: true });

    await rt.execute<PersonalDataNotice>(
      'kernel.personal_data.notify',
      { value: privEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const [notifiedEvent] = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`,
      [o.orgId],
    );
    await worker.execute('kernel.notification.dispatch', { eventId: notifiedEvent?.id }, { actor: SYSTEM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`,
        [o.orgId],
      );
      await c.query(
        `UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`,
        [o.orgId],
      );
      await c.query('COMMIT');
    });

    const secondErase = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: privEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(secondErase.erased).toContainEqual({ column: 'ludy_notes.note', rows: 1 });
    expect(secondErase.kept).toEqual([]);
    const remaining = await rows<{ id: string }>(
      'SELECT id FROM ludy_notes.attachment WHERE org_id = $1 AND id = $2',
      [o.orgId, privPendingAtt.id],
    );
    expect(remaining).toEqual([]);
    expect(await doomed(o)).toContain(`notes/${o.orgId}/${privPendingAtt.id}`);

    // A still-pending private attachment deleted by private_erase (via filename match) must not linger in kept[].
    const privNameEmail = 'private-pending-name@example.com';
    const privNameNote = await createNote(o, o.author, 'private', 'Ghi chú giữ lại');
    const privNameAtt = await attached(o, o.author, privNameNote, pdf('pending-name'), `${privNameEmail} ho-so.pdf`);
    await rt.execute<PersonalDataNotice>(
      'kernel.personal_data.notify',
      { value: privNameEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const [notifiedNameEvent] = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`,
      [o.orgId],
    );
    await worker.execute('kernel.notification.dispatch', { eventId: notifiedNameEvent?.id }, { actor: SYSTEM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`,
        [o.orgId],
      );
      await c.query(
        `UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`,
        [o.orgId],
      );
      await c.query('COMMIT');
    });
    const erasedByName = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: privNameEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedByName.erased).toContainEqual({ column: 'ludy_notes.note', rows: 1 });
    expect(erasedByName.kept).toEqual([]);
    expect(await doomed(o)).toContain(`notes/${o.orgId}/${privNameAtt.id}`);
  });

  it('serializes direct SQL ludy_notes.attachment_record_extract calls against concurrent personalDataErase during rolling deploys (#5035)', async () => {
    const o = await org();
    const rollingEmail = 'rolling-worker-extract@example.com';
    const rollingNote = await createNote(o, o.author, 'org', 'Ghi chú worker cũ');
    const rollingAtt = await attached(o, o.author, rollingNote, pdf('rolling-extract'), 'worker-cu.pdf');
    const blockerNote = await createNote(o, o.author, 'org', `Hợp đồng ${rollingEmail}`);
    await expect(
      pool.query('SELECT ludy_notes.attachment_record_extract($1::uuid, $2::text, $3::text)', [rollingAtt.id, 'done', 'x']),
    ).rejects.toMatchObject({ code: '42501' });

    const rollingGate = new pg.Client({ connectionString: adminUrl });
    await rollingGate.connect();
    const rollingTracker = createConcurrencyTracker();
    try {
      const rollingGatePid = (await rollingGate.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await rollingGate.query('BEGIN');
      await rollingGate.query('SELECT 1 FROM ludy_notes.note WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, blockerNote]);

      const erasePromise = rollingTracker.track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: rollingEmail },
          { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
        ),
      );
      const erasePid = await waitBlockedOnPid(rollingGatePid, '%SELECT n.id FROM ludy_notes.note n%', rollingTracker);

      // Simulate an older rolling-deploy worker calling SQL ludy_notes.attachment_record_extract directly without TS lockNotesEraseShared.
      const directExtractPromise = rollingTracker.track(
        (async (): Promise<boolean> => {
          const client = await workerPool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [o.orgId]);
            const res = await client.query<{ updated: boolean }>(
              `SELECT ludy_notes.attachment_record_extract($1::uuid, 'done', $2::text) AS updated`,
              [rollingAtt.id, `Rolling ${rollingEmail}`],
            );
            await client.query('COMMIT');
            return res.rows[0]?.updated === true;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        })(),
      );
      await waitBlockedOnPid(erasePid, '%attachment_record_extract%', rollingTracker);

      await rollingGate.query('COMMIT');
      const [eraseRes, extractUpdated] = await Promise.all([erasePromise, directExtractPromise]);
      expect(eraseRes.erased).toContainEqual({ column: 'ludy_notes.note.title', rows: 1 });
      expect(eraseRes.kept).toContainEqual({
        column: 'ludy_notes.attachment.extracted_text',
        rows: 1,
        reason: PENDING_NOTE_ATTACHMENT_REASON,
      });
      expect(extractUpdated).toBe(true);

      // Follow-up erasure cleans up the newly extracted attachment with zero lost rows or lingering kept[] entries.
      const followUpErase = await rt.execute<PersonalDataErasure>(
        'kernel.personal_data.erase',
        { value: rollingEmail },
        { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
      expect(followUpErase.erased).toContainEqual({ column: 'ludy_notes.attachment.extracted_text', rows: 1 });
      expect(followUpErase.kept).toEqual([]);
      const remaining = await rows<{ id: string }>(
        'SELECT id FROM ludy_notes.attachment WHERE org_id = $1 AND id = $2',
        [o.orgId, rollingAtt.id],
      );
      expect(remaining).toEqual([]);
      expect(await doomed(o)).toContain(`notes/${o.orgId}/${rollingAtt.id}`);
    } finally {
      await rollingGate.query('ROLLBACK').catch(() => undefined);
      await rollingTracker.drain();
      await rollingGate.end().catch(() => undefined);
    }
  });

  it('surfaces pendingNoteAttachments in personalDataFind with owner-only private counts and zero existence oracle (#5127)', async () => {
    const o = await org();
    const probe = 'pending-find-parity@example.com';

    // 0 pending attachments: field is omitted for both owner and admin (100% backward compatible).
    const ownerEmpty = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.owner.id), orgId: o.orgId });
    const adminEmpty = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.admin.id), orgId: o.orgId });
    expect(ownerEmpty.pendingNoteAttachments).toBeUndefined();
    expect(adminEmpty.pendingNoteAttachments).toBeUndefined();

    // Private pending attachment only: owner sees { shared: 0, private: 1 }, admin still sees undefined (no private oracle!).
    const privNote = await createNote(o, o.author, 'private', 'Ghi chú riêng chờ trích xuất');
    const privPending = await attached(o, o.author, privNote, pdf('priv-pending'), 'tai-lieu-mat-pending.pdf');
    const ownerPrivOnly = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.owner.id), orgId: o.orgId });
    const adminPrivOnly = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.admin.id), orgId: o.orgId });
    expect(ownerPrivOnly.pendingNoteAttachments).toEqual({ shared: 0, private: 1 });
    expect(adminPrivOnly.pendingNoteAttachments).toBeUndefined();
    const ownerPrivJson = JSON.stringify(ownerPrivOnly);
    expect(ownerPrivJson).not.toContain('tai-lieu-mat-pending');
    expect(ownerPrivJson).not.toContain(privNote);
    expect(ownerPrivJson).not.toContain(privPending.id);
    expect(ownerPrivJson).not.toContain(o.author.id);

    // Shared + private pending attachments: owner sees { shared: 1, private: 1 }, admin sees { shared: 1, private: null }.
    const sharedNote = await createNote(o, o.author, 'org', 'Ghi chú chung chờ trích xuất');
    const sharedPending = await attached(o, o.author, sharedNote, pdf('shared-pending'), 'tai-lieu-chung-pending.pdf');
    const ownerBoth = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.owner.id), orgId: o.orgId });
    const adminBoth = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.admin.id), orgId: o.orgId });
    expect(ownerBoth.pendingNoteAttachments).toEqual({ shared: 1, private: 1 });
    expect(adminBoth.pendingNoteAttachments).toEqual({ shared: 1, private: null });
    const adminBothJson = JSON.stringify(adminBoth);
    expect(adminBothJson).not.toContain('tai-lieu-mat-pending');
    expect(adminBothJson).not.toContain(privNote);
    expect(adminBothJson).not.toContain(privPending.id);
    expect(adminBothJson).not.toContain(o.author.id);

    // Once extracted, pendingNoteAttachments returns to undefined.
    extract.text = 'Nội dung sạch không khớp';
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: privPending.id });
    await runNoteAttachmentExtract({ runtime: worker, store, extract }, { orgId: o.orgId, attachmentId: sharedPending.id });
    const afterExtract = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: probe }, { actor: asUser(o.owner.id), orgId: o.orgId });
    expect(afterExtract.pendingNoteAttachments).toBeUndefined();
  });

  it('reports failed shared and private note attachments in kept[] alongside pending without disclosing private metadata, and keeps shared note_template updated_at monotonic (#5127)', async () => {
    const o = await org();
    const probeEmail = 'failed-parity@example.com';

    // Shared failed + shared pending + private failed + private pending attachments (with unmatching filenames so they remain in kept[]).
    const sharedNote = await createNote(o, o.author, 'org', `Hồ sơ ${probeEmail}`);
    const sharedPending = await attached(o, o.author, sharedNote, pdf('s-pend'), 'chung-pending.pdf');
    const sharedFailed = await attached(o, o.author, sharedNote, pdf('s-fail'), 'chung-failed.pdf');
    const privNote = await createNote(o, o.author, 'private', 'Ghi chú riêng sạch');
    const privPending = await attached(o, o.author, privNote, pdf('p-pend'), 'bi-mat-pending.pdf');
    const privFailed = await attached(o, o.author, privNote, pdf('p-fail'), 'bi-mat-failed.pdf');

    // Mark the two failed attachments via the worker definer.
    expect(
      await worker.execute<{ updated: boolean }>(
        'notes.attachment.extract_record',
        { attachmentId: sharedFailed.id, status: 'failed', extractedText: null },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).toEqual({ updated: true });
    expect(
      await worker.execute<{ updated: boolean }>(
        'notes.attachment.extract_record',
        { attachmentId: privFailed.id, status: 'failed', extractedText: null },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).toEqual({ updated: true });

    // Shared note_template with updated_at ahead of transaction start time must stay monotonic after redaction.
    const tplRes = await rows<{ id: string }>(
      `INSERT INTO ludy_notes.note_template (org_id, author_user_id, visibility, name, title, body, tags)
       VALUES ($1, $2, 'org', $3, $3, 'Nội dung', ARRAY['mau'])
       RETURNING id`,
      [o.orgId, o.owner.id, `Mẫu ${probeEmail}`],
    );
    const tplId = tplRes[0]!.id;
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_notes.note_template
            SET updated_at = pg_catalog.clock_timestamp() + interval '10 minutes'
          WHERE org_id = $1 AND id = $2`,
        [o.orgId, tplId],
      );
      await c.query('COMMIT');
    });
    const templateUpdatedAt = async () =>
      new Date(
        (await rows<{ updated_at: Date | string }>('SELECT updated_at FROM ludy_notes.note_template WHERE org_id = $1 AND id = $2', [o.orgId, tplId]))[0]!.updated_at,
      ).getTime();
    const beforeTplTs = await templateUpdatedAt();

    // Owner-only refusal check on private_failed_attachment_count().
    await expect(rows('SELECT ludy_notes.private_failed_attachment_count()')).rejects.toThrow();
    await expect(workerPool.query('SELECT ludy_notes.private_failed_attachment_count()')).rejects.toThrow();
    const queryFailedCountAs = async (who: Person): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: who.id,
          orgId: o.orgId,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        });
        await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, ctxToken]);
        const res = await client.query<{ n: string }>('SELECT ludy_notes.private_failed_attachment_count()::text AS n');
        return res.rows[0]?.n ?? '';
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await expect(queryFailedCountAs(o.admin)).rejects.toMatchObject({ code: '42501', message: 'NOTES_FORBIDDEN' });
    await expect(queryFailedCountAs(o.author)).rejects.toMatchObject({ code: '42501', message: 'NOTES_FORBIDDEN' });
    await expect(queryFailedCountAs(o.owner)).resolves.toBe('1');

    const eraseRes = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: probeEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(eraseRes.erased).toContainEqual({ column: 'ludy_notes.note_template.name', rows: 1 });
    expect(await templateUpdatedAt()).toBeGreaterThanOrEqual(beforeTplTs);
    expect(eraseRes.kept).toEqual(
      expect.arrayContaining([
        { column: 'ludy_notes.attachment.extracted_text', rows: 1, reason: PENDING_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment.extracted_text', rows: 1, reason: FAILED_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment', rows: 1, reason: PENDING_PRIVATE_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment', rows: 1, reason: FAILED_PRIVATE_NOTE_ATTACHMENT_REASON },
      ]),
    );
    const eraseJson = JSON.stringify(eraseRes);
    expect(eraseJson).not.toContain('bi-mat-pending');
    expect(eraseJson).not.toContain('bi-mat-failed');
    expect(eraseJson).not.toContain(privNote);
    expect(eraseJson).not.toContain(privPending.id);
    expect(eraseJson).not.toContain(privFailed.id);
    expect(eraseJson).not.toContain(o.author.id);

    // Erase audit row must not expose private attachment counts (ludy_notes.attachment) to admins reading audit_event.
    const [eraseAudit] = await rows<{ detail: { kept?: Record<string, number> } }>(
      `SELECT detail FROM ludy_kernel.audit_event
        WHERE org_id = $1 AND command = 'kernel.personal_data.erase' AND outcome = 'ok'
        ORDER BY id DESC LIMIT 1`,
      [o.orgId],
    );
    expect(eraseAudit?.detail.kept?.['ludy_notes.attachment.extracted_text']).toBe(2);
    expect(eraseAudit?.detail.kept).not.toHaveProperty('ludy_notes.attachment');

    // Separate org with ONLY a private failed attachment (0 shared, 0 pending): owner sees kept[], audit_event still omits ludy_notes.attachment.
    const privOnlyOrg = await org();
    const privOnlyNote = await createNote(privOnlyOrg, privOnlyOrg.author, 'private', 'Ghi chú riêng lỗi trích xuất');
    const privOnlyFailed = await attached(privOnlyOrg, privOnlyOrg.author, privOnlyNote, pdf('p-only-fail'), 'mat-only-fail.pdf');
    await worker.execute(
      'notes.attachment.extract_record',
      { attachmentId: privOnlyFailed.id, status: 'failed', extractedText: null },
      { actor: SYSTEM, orgId: privOnlyOrg.orgId },
    );
    const privOnlyErase = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'priv-only-failed@example.com' },
      { actor: asMfa(privOnlyOrg.owner.id), orgId: privOnlyOrg.orgId, idempotencyKey: randomUUID() },
    );
    expect(privOnlyErase.kept).toEqual([
      { column: 'ludy_notes.attachment', rows: 1, reason: FAILED_PRIVATE_NOTE_ATTACHMENT_REASON },
    ]);
    const [privOnlyAudit] = await rows<{ detail: { kept?: Record<string, number> } }>(
      `SELECT detail FROM ludy_kernel.audit_event
        WHERE org_id = $1 AND command = 'kernel.personal_data.erase' AND outcome = 'ok'
        ORDER BY id DESC LIMIT 1`,
      [privOnlyOrg.orgId],
    );
    expect(privOnlyAudit?.detail.kept).not.toHaveProperty('ludy_notes.attachment');

    // Failed attachment whose filename matches the probe is still scanned and erased.
    const namedFailEmail = 'failed-filename-match@example.com';
    const cleanShared = await createNote(o, o.author, 'org', 'Ghi chú chung sạch');
    const sharedNamedFail = await attached(o, o.author, cleanShared, pdf('snf'), `${namedFailEmail} chung.pdf`);
    await worker.execute(
      'notes.attachment.extract_record',
      { attachmentId: sharedNamedFail.id, status: 'failed', extractedText: null },
      { actor: SYSTEM, orgId: o.orgId },
    );
    const cleanPriv = await createNote(o, o.author, 'private', 'Ghi chú riêng sạch');
    const privNamedFail = await attached(o, o.author, cleanPriv, pdf('pnf'), `${namedFailEmail} rieng.pdf`);
    await worker.execute(
      'notes.attachment.extract_record',
      { attachmentId: privNamedFail.id, status: 'failed', extractedText: null },
      { actor: SYSTEM, orgId: o.orgId },
    );
    await rt.execute<PersonalDataNotice>(
      'kernel.personal_data.notify',
      { value: namedFailEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const [namedFailEvt] = await rows<{ id: string }>(
      `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`,
      [o.orgId],
    );
    await worker.execute('kernel.notification.dispatch', { eventId: namedFailEvt?.id }, { actor: SYSTEM, orgId: o.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`,
        [o.orgId],
      );
      await c.query(
        `UPDATE ludy_kernel.notification SET created_at = created_at - interval '25 hours' WHERE org_id = $1 AND kind = 'kernel.personal_data_notice'`,
        [o.orgId],
      );
      await c.query('COMMIT');
    });
    const erasedFailedByName = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: namedFailEmail },
      { actor: asMfa(o.owner.id), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedFailedByName.erased).toContainEqual({ column: 'ludy_notes.attachment.filename', rows: 1 });
    expect(erasedFailedByName.erased).toContainEqual({ column: 'ludy_notes.note', rows: 1 });
    expect(await doomed(o)).toEqual(
      expect.arrayContaining([`notes/${o.orgId}/${sharedNamedFail.id}`, `notes/${o.orgId}/${privNamedFail.id}`]),
    );
    expect(sharedPending.id).toBeTruthy();
  });
});
