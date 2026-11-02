// SPDX-License-Identifier: AGPL-3.0-only
// A customer's image of a conversation message on PostgreSQL 17 (CV5c, #2357): the image is a conversation_attachment row, read by those who
// read its message and by nobody else (the table, the command and the bytes route), fetched through the egress guard from the platform's
// media hosts only, stored under a blob key of its own, and deleted with its message by every path (the erasure of a customer, the retention
// purge, the erasure of a connection, a platform removal, the expiry of its address), the store holding no object afterwards. No address and no
// byte of an image reaches an audit row, an event or a job. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationEvent } from '@crove/kernel-contract';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { sniffConversationImage } from '../src/conversation-media.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { dueConversationAttachments, purgeExpiredConversations, requestConversationAttachments, runConversationAttachment, sweepConversationBlobs } from '../src/conversations-worker.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const SECRET = 'attachments-jwt-secret-for-the-test-0123456789';
const ISSUER = 'https://issuer.test';
const DIRECT_READ = 'kernel.conversation.direct.read';

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

// The smallest bytes each type's first bytes are recognised by, with a PNG header of 2x3 pixels.
const png = (extra = 0): Buffer => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(2, 16);
  header.writeUInt32BE(3, 20);
  return Buffer.concat([header, randomBytes(8 + extra)]);
};

suite('customers’ images as files bound to their message on PostgreSQL (CV5c, #2357)', () => {
  const dbName = `crove_test_conversations_images_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const store2 = store;
  // A local server standing in for the platform's media host: what it answers for each path is set per test.
  let media: Server;
  let mediaBase = '';
  const answers = new Map<string, { status?: number; type?: string; body: Buffer | string; location?: string }>();
  const egress = { allowed: () => true, anyPort: true, httpsOnly: false };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
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
  async function asMember<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  type Org = { orgId: string; slug: string; owner: string; ownerSubject: string; ownerEmail: string; admin: string; desk: string; lan: string; viewer: string; connectionId: string; otherConnectionId: string };
  const person = async (name: string, subject = randomUUID()) => ({ id: (await upsertIdentity(db, { issuer: ISSUER, subject, email: `${name}-${randomUUID().slice(0, 8)}@images.test`, name: null })) as string, subject });
  async function org(provider = 'zalo_oa'): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner.id), `Org ${randomUUID().slice(0, 6)}`);
    const adm = await person('admin');
    const desk = await person('desk');
    const lan = await person('lan');
    const viewer = await person('viewer');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, adm.id, desk.id, lan.id, viewer.id]);
    const connection = async () => {
      const id = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Kênh thử', $5)", [orgId, id, provider, `acct-${randomUUID().slice(0, 8)}`, owner.id]);
      return id;
    };
    const [slug] = await rows<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]);
    const ownerEmail = ((await rows<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [owner.id]))[0] as { email: string }).email;
    return { orgId, slug: (slug as { slug: string }).slug, owner: owner.id, ownerSubject: owner.subject, ownerEmail, admin: adm.id, desk: desk.id, lan: lan.id, viewer: viewer.id, connectionId: await connection(), otherConnectionId: await connection() };
  }

  let tick = 0;
  const imageEvent = (threadId: string, urls: string[], extra: Partial<ConversationEvent> = {}): ConversationEvent => ({
    kind: 'direct',
    threadId,
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: `u-${threadId}`, name: `Khách ${threadId}` },
    text: '[Khách gửi ảnh]',
    at: new Date(Date.now() - 60_000 + tick).toISOString(),
    attachments: urls.map((url) => ({ kind: 'image' as const, url })),
    ...extra,
  });
  const ingest = (o: Org, events: ConversationEvent[], connectionId = o.connectionId) => worker.execute('kernel.conversation.ingest', { connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  // Rows aged past the guard that keeps created_at: a superuser's session skips triggers, as a restore would.
  const asOwnerSql = (text: string, params: unknown[] = []) =>
    admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      return (await c.query(text, params)).rows;
    });
  const attachments = (o: Org) => rows<{ id: string; state: string; source_url: string | null; storage_key: string; message_id: string }>('SELECT id, state, source_url, storage_key, message_id FROM crove_kernel.conversation_attachment WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
  const threadOf = async (o: Org, external: string) => ((await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, external]))[0] as { id: string }).id;
  const doomed = () => rows<{ storage_key: string }>('SELECT storage_key FROM crove_kernel.conversation_blob_doomed ORDER BY storage_key');
  const blobsOf = (o: Org) => [...store.blobs.keys()].filter((k) => k.startsWith(`conversation/${o.orgId}/`));
  const url = (path: string) => `${mediaBase}${path}`;
  // The fetch the worker makes, against the local server, from its host only.
  const fetchOne = (o: Org, attachmentId: string, hosts: readonly string[] = ['127.0.0.1']) =>
    runConversationAttachment({ runtime: worker, store, hosts, egress }, { orgId: o.orgId, connectionId: o.connectionId, action: 'attachment', attachmentId });
  // An image taken in and fetched: its message, its row and its blob.
  async function stored(o: Org, threadId: string, bytes = png()): Promise<{ attachmentId: string; key: string }> {
    const path = `/${threadId}.png`;
    answers.set(path, { type: 'image/png', body: bytes });
    // The ingest schema takes https only, and the local server speaks http: the address is put in the row the way the intake would.
    await ingest(o, [imageEvent(threadId, ['https://cdn.zdn.vn/x.png'])]);
    const [row] = (await attachments(o)).filter((a) => a.state === 'pending').slice(-1);
    const a = row as { id: string; storage_key: string };
    await rows('UPDATE crove_kernel.conversation_attachment SET source_url = $1 WHERE org_id = $2 AND id = $3', [url(path), o.orgId, a.id]);
    expect(await fetchOne(o, a.id)).toBe('stored');
    return { attachmentId: a.id, key: a.storage_key };
  }
  const token = (o: Org, who: { subject: string; email: string }) =>
    new SignJWT({ role: 'authenticated', email: who.email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const emailOf = async (userId: string) => ((await rows<{ email: string; subject: string }>('SELECT email, subject FROM crove_kernel.user_account WHERE id = $1', [userId]))[0] as { email: string; subject: string });
  async function bytesRoute(o: Org, user: string | null, attachmentId: string) {
    const who = user ? await emailOf(user) : null;
    const response = await app.request(`/api/conversations/attachments/${attachmentId}`, { headers: who ? { authorization: `Bearer ${await token(o, who)}`, 'x-crove-org': o.slug } : {} });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }

  beforeAll(async () => {
    media = createServer((req, res) => {
      const answer = answers.get(req.url ?? '');
      if (!answer) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(answer.status ?? 200, { ...(answer.type ? { 'content-type': answer.type } : {}), ...(answer.location ? { location: answer.location } : {}) });
      res.end(answer.body);
    });
    await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve));
    mediaBase = `http://127.0.0.1:${(media.address() as AddressInfo).port}`;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: rt, store: store2, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => media?.close(() => resolve()));
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('the intake and the fetch', () => {
    it('stores a pending row with an address and a blob key of its own, once per message, and refuses what the schema does not take', async () => {
      const o = await org();
      const e = imageEvent('t1', ['https://cdn.zdn.vn/a.png', 'https://cdn.zdn.vn/b.png']);
      await ingest(o, [e]);
      await ingest(o, [e]);
      const rowsNow = await attachments(o);
      expect(rowsNow).toHaveLength(2);
      expect(rowsNow.every((r) => r.state === 'pending' && r.source_url?.startsWith('https://cdn.zdn.vn/'))).toBe(true);
      // A key of its own per row, under the org's prefix and never a content address.
      expect(new Set(rowsNow.map((r) => r.storage_key)).size).toBe(2);
      expect(rowsNow.every((r) => new RegExp(`^conversation/${o.orgId}/[0-9a-f]{64}$`).test(r.storage_key))).toBe(true);
      // No kernel file row is made.
      expect(Number((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.file WHERE org_id = $1', [o.orgId]))[0]?.n)).toBe(0);
      // Six images, a plain http address and an image on an outbound echo are not taken.
      await expect(ingest(o, [imageEvent('t2', Array.from({ length: 6 }, (_, i) => `https://cdn.zdn.vn/${i}.png`))])).rejects.toBeTruthy();
      await expect(ingest(o, [imageEvent('t3', ['http://cdn.zdn.vn/a.png'])])).rejects.toBeTruthy();
      const before = (await attachments(o)).length;
      await ingest(o, [imageEvent('t4', ['https://cdn.zdn.vn/c.png'], { direction: 'out' })]);
      expect((await attachments(o)).length).toBe(before);
    });

    it('adds the images of a message stored before its notice brought them (the history read stores the text alone), once', async () => {
      const o = await org();
      const text = imageEvent('late', [], { attachments: undefined });
      await ingest(o, [text]);
      expect(await attachments(o)).toEqual([]);
      const withImage = { ...text, attachments: [{ kind: 'image' as const, url: 'https://cdn.zdn.vn/late.png' }] };
      await ingest(o, [withImage]);
      await ingest(o, [withImage]);
      expect((await attachments(o)).map((a) => a.state)).toEqual(['pending']);
    });

    it('fetches an image from an allowed host, checks its first bytes, stores it under the reserved key and clears the address', async () => {
      const o = await org();
      const bytes = png();
      const { attachmentId, key } = await stored(o, 'ok', bytes);
      expect(Buffer.compare(Buffer.from(store.blobs.get(key) as Uint8Array), bytes)).toBe(0);
      const [row] = await rows<Record<string, unknown>>('SELECT state, source_url, sha256, content_type, size_bytes, width, height, generation, stored_at FROM crove_kernel.conversation_attachment WHERE org_id = $1 AND id = $2', [o.orgId, attachmentId]);
      expect(row).toMatchObject({ state: 'stored', source_url: null, sha256: sha256Hex(bytes), content_type: 'image/png', size_bytes: bytes.byteLength, width: 2, height: 3 });
      expect(row?.stored_at).toBeTruthy();
      // The message lists it, as the detail read shows it.
      const detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: await threadOf(o, 'ok') }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(detail.messages[0]?.attachments).toEqual([{ id: attachmentId, contentType: 'image/png', width: 2, height: 3 }]);
      expect(detail.messages[0]?.body).toBe('[Khách gửi ảnh]');
      // A stored image never changes.
      await expect(rows('UPDATE crove_kernel.conversation_attachment SET width = 9 WHERE org_id = $1 AND id = $2', [o.orgId, attachmentId])).rejects.toMatchObject({ code: '42501' });
      // A second job for the same image finds nothing to do.
      expect(await fetchOne(o, attachmentId)).toBe('none');
    });

    it('drops an image that is from another host, not an image, over the cap, SVG or gone, and keeps the message’s placeholder', async () => {
      const o = await org();
      const cases: Array<[string, { status?: number; type?: string; body: Buffer | string }, readonly string[], string]> = [
        ['other-host', { type: 'image/png', body: png() }, ['example.invalid'], 'dropped'],
        ['html', { type: 'image/png', body: '<html><script>alert(1)</script></html>' }, ['127.0.0.1'], 'dropped'],
        ['svg', { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, ['127.0.0.1'], 'dropped'],
        ['big', { type: 'image/png', body: png(5 * 1024 * 1024) }, ['127.0.0.1'], 'dropped'],
        ['gone', { status: 404, body: '' }, ['127.0.0.1'], 'dropped'],
      ];
      for (const [name, answer, hosts, expected] of cases) {
        answers.set(`/${name}`, answer);
        await ingest(o, [imageEvent(name, ['https://cdn.zdn.vn/x.png'])]);
        const [pending] = (await attachments(o)).filter((a) => a.state === 'pending').slice(-1);
        await rows('UPDATE crove_kernel.conversation_attachment SET source_url = $1 WHERE org_id = $2 AND id = $3', [url(`/${name}`), o.orgId, (pending as { id: string }).id]);
        expect(await fetchOne(o, (pending as { id: string }).id, hosts), name).toBe(expected);
      }
      expect(await attachments(o)).toEqual([]);
      expect(blobsOf(o)).toEqual([]);
      const bodies = await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId]);
      expect(bodies.map((b) => b.body)).toEqual(Array(cases.length).fill('[Khách gửi ảnh]'));
    });

    it('follows no redirect to a host that is not allowed, and asks again later after a server error', async () => {
      const o = await org();
      answers.set('/redirect', { status: 302, body: '', location: `http://localhost:${new URL(mediaBase).port}/elsewhere.png` });
      answers.set('/elsewhere.png', { type: 'image/png', body: png() });
      answers.set('/flaky', { status: 503, body: '' });
      for (const [name, expected] of [['redirect', 'dropped'], ['flaky', 'retry']] as const) {
        await ingest(o, [imageEvent(name, ['https://cdn.zdn.vn/x.png'])]);
        const [pending] = (await attachments(o)).filter((a) => a.state === 'pending').slice(-1);
        await rows('UPDATE crove_kernel.conversation_attachment SET source_url = $1 WHERE org_id = $2 AND id = $3', [url(`/${name}`), o.orgId, (pending as { id: string }).id]);
        expect(await fetchOne(o, (pending as { id: string }).id), name).toBe(expected);
      }
      // The redirect's image was never fetched, and the flaky one stays pending for the relay to hand out again.
      expect(blobsOf(o)).toEqual([]);
      expect((await attachments(o)).map((a) => a.state)).toEqual(['pending']);
    });

    it('hands out what is pending once, drops what will never be fetched, and puts ids only in the event, the audit row and the log', async () => {
      const o = await org();
      await ingest(o, [imageEvent('relay', ['https://cdn.zdn.vn/private-photo.png'])]);
      await ingest(o, [imageEvent('old', ['https://cdn.zdn.vn/old.png'])]);
      await ingest(o, [imageEvent('tried', ['https://cdn.zdn.vn/tried.png'])]);
      const [relay, old, tried] = await attachments(o);
      await asOwnerSql("UPDATE crove_kernel.conversation_attachment SET created_at = now() - interval '7 days' WHERE org_id = $1 AND id = $2", [o.orgId, (old as { id: string }).id]);
      await rows("UPDATE crove_kernel.conversation_attachment SET fetch_attempts = 5, requested_at = now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, (tried as { id: string }).id]);
      const due = (await dueConversationAttachments(workerDb)).filter((d) => d.orgId === o.orgId);
      expect(due.map((d) => d.attachmentId)).toEqual([(relay as { id: string }).id]);
      // The old image and the one tried five times are gone, their addresses with them; the message keeps its text.
      expect((await attachments(o)).map((a) => a.id)).toEqual([(relay as { id: string }).id]);
      expect(await requestConversationAttachments(worker, due)).toBe(1);
      // Handed out once: not due again until the retry time.
      expect((await dueConversationAttachments(workerDb)).filter((d) => d.orgId === o.orgId)).toEqual([]);
      const events = await rows<{ payload: unknown }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.attachment_queued'", [o.orgId]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ attachmentId: (relay as { id: string }).id, connectionId: o.connectionId });
      // No address anywhere an audit or an event is kept.
      const leaks = await rows<{ n: string }>(
        `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%cdn.zdn.vn%')
              + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%cdn.zdn.vn%') AS n`,
        [o.orgId],
      );
      expect(Number(leaks[0]?.n)).toBe(0);
    });

    it('records the audit of a fetch with ids, the type and the size only', async () => {
      const o = await org();
      const { attachmentId } = await stored(o, 'audit');
      const [audit] = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.attachment_record' AND outcome = 'ok'", [o.orgId]);
      expect(audit?.detail).toMatchObject({ attachment_id: attachmentId, outcome: 'stored', size_bytes: expect.any(Number), content_type: 'image/png' });
      expect(Object.keys(audit?.detail ?? {}).sort()).toEqual(['attachment_id', 'component', 'content_type', 'outcome', 'size_bytes', 'workerInstance']);
      expect(JSON.stringify(audit?.detail)).not.toContain('127.0.0.1');
    });
  });

  describe('who reads the image', () => {
    it('is read by owners and admins and by holders of the direct-message permission, and by nobody else, through the table, the command and the bytes route', async () => {
      const o = await org();
      const { attachmentId } = await stored(o, 'secret');
      const countFor = (user: string) => asMember(o.orgId, user, async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation_attachment')).rows[0].n as number);
      const get = (user: string) => rt.query('kernel.conversation.attachment_get', { attachmentId }, { actor: asUser(user), orgId: o.orgId });
      expect(await countFor(o.owner)).toBe(1);
      expect(await countFor(o.admin)).toBe(1);
      expect(await countFor(o.desk)).toBe(0);
      expect(await countFor(o.lan)).toBe(0);
      expect(await countFor(o.viewer)).toBe(0);
      expect(await get(o.owner)).toMatchObject({ id: attachmentId, contentType: 'image/png' });
      for (const user of [o.desk, o.lan, o.viewer]) await expect(get(user)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
      // The bytes route: the owner gets the image with the headers that keep it an image; the others get a 404 and no byte.
      const ok = await bytesRoute(o, o.owner, attachmentId);
      expect(ok.status).toBe(200);
      expect(sniffConversationImage(ok.bytes)).toBe('image/png');
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(ok.headers.get('content-disposition')).toBe('inline; filename="image.png"');
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
      for (const user of [o.desk, o.lan, o.viewer]) {
        const refused = await bytesRoute(o, user, attachmentId);
        expect(refused.status).toBe(404);
        expect(sniffConversationImage(refused.bytes)).toBeNull();
        expect(refused.bytes.byteLength).toBeLessThan(500);
      }
      expect((await bytesRoute(o, null, attachmentId)).status).toBe(401);
      expect((await bytesRoute(o, o.owner, randomUUID())).status).toBe(404);
      // The permission, as the Service inbox will seed it (a fixture here): its holder reads the image; taking it away takes the image away.
      await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [o.orgId, o.desk, o.owner]);
      await rows("INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES ('desk.agent', $1) ON CONFLICT DO NOTHING", [DIRECT_READ]);
      try {
        expect(await countFor(o.desk)).toBe(1);
        expect((await bytesRoute(o, o.desk, attachmentId)).status).toBe(200);
        // Limited to another channel, the holder reads none of this channel's images.
        await rows('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.desk, o.otherConnectionId, o.owner]);
        expect(await countFor(o.desk)).toBe(0);
        expect((await bytesRoute(o, o.desk, attachmentId)).status).toBe(404);
      } finally {
        await rows("DELETE FROM crove_kernel.role_permission WHERE role_key = 'desk.agent' AND permission = $1", [DIRECT_READ]);
      }
      // No kernel file exists for it, so the file list and the file route have nothing of it.
      expect(await asMember(o.orgId, o.owner, async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.file')).rows[0].n)).toBe(0);
    });

    it('lets a member write none of it: no insert, update or delete in any member’s context', async () => {
      const o = await org();
      const { attachmentId } = await stored(o, 'write');
      const [message] = await rows<{ id: string }>('SELECT message_id AS id FROM crove_kernel.conversation_attachment WHERE org_id = $1 AND id = $2', [o.orgId, attachmentId]);
      await expect(
        asMember(o.orgId, o.owner, (c) =>
          c.query("INSERT INTO crove_kernel.conversation_attachment (org_id, message_id, channel_connection_id, kind, source_url, storage_key) VALUES ($1, $2, $3, 'direct', 'https://x.test/a.png', $4)", [
            o.orgId,
            message?.id,
            o.connectionId,
            `conversation/${o.orgId}/${'a'.repeat(64)}`,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // The stored image never changes (the guard), and a pending one is no member's to change (the row policy): refused either way.
      await expect(asMember(o.orgId, o.owner, (c) => c.query('UPDATE crove_kernel.conversation_attachment SET fetch_attempts = 1'))).rejects.toMatchObject({ code: '42501' });
      await expect(asMember(o.orgId, o.owner, (c) => c.query('DELETE FROM crove_kernel.conversation_attachment'))).resolves.toMatchObject({ rowCount: 0 });
      expect(await attachments(o)).toHaveLength(1);
    });

    it('serves only an image: bytes that are not one are 404 whatever the row says', async () => {
      const o = await org();
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      const key = `conversation/${o.orgId}/${randomBytes(32).toString('hex')}`;
      store.blobs.set(key, html);
      await ingest(o, [imageEvent('bad', ['https://cdn.zdn.vn/x.png'])]);
      const [pending] = (await attachments(o)).slice(-1);
      await rows(
        `UPDATE crove_kernel.conversation_attachment SET state = 'stored', source_url = NULL, storage_key = storage_key, generation = $3, sha256 = $4, content_type = 'image/png', size_bytes = $5, stored_at = now() WHERE org_id = $1 AND id = $2`,
        [o.orgId, (pending as { id: string }).id, `content:${sha256Hex(html)}`, sha256Hex(html), html.byteLength],
      );
      // The row's own key is the reserved one, so the blob is put under it for the route to read.
      store.blobs.set((pending as { storage_key: string }).storage_key, html);
      const answer = await bytesRoute(o, o.owner, (pending as { id: string }).id);
      expect(answer.status).toBe(404);
      expect(answer.bytes.toString()).not.toContain('script');
    });

    it('keeps the doomed keys and the worker’s functions out of the API login’s reach', async () => {
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_blob_doomed')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_blob_claim(10)')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_attachment_due(10, 300)')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT crove_kernel.conversation_blob_done($1::text[])', [[]])).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the image goes with its message, blob and all', () => {
    const settle = async (o: Org) => {
      // A pending row's blob waits an hour for a fetch in flight: let it pass, then sweep.
      await rows("UPDATE crove_kernel.conversation_blob_doomed SET not_before = now() - interval '1 minute'");
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(blobsOf(o)).toEqual([]);
      expect(await doomed()).toEqual([]);
    };

    it('erase_contact deletes the images of every thread of the customer and their blobs', async () => {
      const o = await org();
      const one = await stored(o, 'erase-1');
      await ingest(o, [imageEvent('erase-1', ['https://cdn.zdn.vn/second.png'])]);
      const keep = await stored(o, 'someone-else');
      expect(blobsOf(o)).toHaveLength(2);
      await rt.execute('kernel.conversation.erase_contact', { conversationId: await threadOf(o, 'erase-1'), confirm: true }, { actor: asMfa(o.owner), orgId: o.orgId });
      expect((await attachments(o)).map((a) => a.id)).toEqual([keep.attachmentId]);
      // The stored image's blob is queued for deletion at once; the pending one's after the hour.
      expect((await doomed()).map((d) => d.storage_key)).toContain(one.key);
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(store.blobs.has(one.key)).toBe(false);
      expect(store.blobs.has(keep.key)).toBe(true);
      // The pending image's key (no blob was ever written) is dropped once its hour has passed, and nothing is left waiting.
      await rows("UPDATE crove_kernel.conversation_blob_doomed SET not_before = now() - interval '1 minute'");
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(await doomed()).toEqual([]);
      expect(blobsOf(o)).toEqual([keep.key]);
    });

    it('purge_expired deletes the images of the threads past the retention, with their blobs', async () => {
      const o = await org();
      const old = await stored(o, 'old-thread');
      await rows("UPDATE crove_kernel.conversation SET last_message_at = now() - interval '30 months', opened_at = now() - interval '30 months' WHERE org_id = $1", [o.orgId]);
      expect(await purgeExpiredConversations({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      expect(await attachments(o)).toEqual([]);
      expect((await doomed()).map((d) => d.storage_key)).toContain(old.key);
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(blobsOf(o)).toEqual([]);
    });

    it('erase_connection deletes the images of its conversations, with their blobs, and leaves another connection’s', async () => {
      const o = await org();
      const gone = await stored(o, 'conn-a');
      await ingest(o, [imageEvent('conn-b', ['https://cdn.zdn.vn/b.png'])], o.otherConnectionId);
      await worker.execute('kernel.conversation.erase_connection', { connectionId: o.connectionId }, { actor: SYSTEM, orgId: o.orgId });
      expect((await attachments(o)).map((a) => a.state)).toEqual(['pending']);
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(store.blobs.has(gone.key)).toBe(false);
    });

    it('a platform removal deletes the images of the message and its blobs', async () => {
      const o = await org();
      const e = imageEvent('removal', ['https://cdn.zdn.vn/x.png']);
      answers.set('/removal.png', { type: 'image/png', body: png() });
      await ingest(o, [e]);
      const [row] = await attachments(o);
      await rows('UPDATE crove_kernel.conversation_attachment SET source_url = $1 WHERE org_id = $2 AND id = $3', [url('/removal.png'), o.orgId, (row as { id: string }).id]);
      expect(await fetchOne(o, (row as { id: string }).id)).toBe('stored');
      expect(blobsOf(o)).toHaveLength(1);
      await ingest(o, [{ ...e, removed: true, attachments: undefined, text: '' }]);
      expect(await attachments(o)).toEqual([]);
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(blobsOf(o)).toEqual([]);
      const [message] = await rows<{ body: string; platform_removed_at: Date | null; attachments: string[] }>('SELECT body, platform_removed_at, attachments FROM crove_kernel.conversation_message WHERE org_id = $1', [o.orgId]);
      expect(message).toMatchObject({ body: '', attachments: [] });
      expect(message?.platform_removed_at).toBeTruthy();
    });

    it('sweeps the blob a fetch wrote after its row went (the crash and the erasure that race a fetch), once the hour has passed, and logs ids and counts only', async () => {
      const o = await org();
      await ingest(o, [imageEvent('race', ['https://cdn.zdn.vn/x.png'])]);
      const [row] = await attachments(o);
      const reserved = (row as { storage_key: string }).storage_key;
      // The row goes while its fetch is in flight (the customer is erased) ...
      await worker.execute('kernel.conversation.erase_connection', { connectionId: o.connectionId }, { actor: SYSTEM, orgId: o.orgId });
      // ... and the fetch then writes its bytes under the key it was given.
      store.blobs.set(reserved, png());
      // Within the hour the key waits, so the blob a fetch is still writing is not pulled from under it.
      await sweepConversationBlobs({ workerDb, store, force: true });
      expect(store.blobs.has(reserved)).toBe(true);
      expect((await doomed()).map((d) => d.storage_key)).toEqual(expect.arrayContaining([reserved]));
      await settle(o);
      // A delete that fails keeps the key for the next claim after its lease.
      store.blobs.set(reserved, png());
      await rows('INSERT INTO crove_kernel.conversation_blob_doomed (storage_key, not_before) VALUES ($1, now() - interval \'1 minute\')', [reserved]);
      const failing: BlobStore = { ...store, put: store.put.bind(store), get: store.get.bind(store), delete: async () => { throw new Error('store down'); } };
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
      try {
        expect(await sweepConversationBlobs({ workerDb, store: failing, force: true })).toBe(0);
      } finally {
        console.error = original;
      }
      expect(logged.join('\n')).not.toContain(reserved);
      expect((await doomed()).map((d) => d.storage_key)).toEqual([reserved]);
      await rows("UPDATE crove_kernel.conversation_blob_doomed SET claimed_until = now() - interval '1 minute'");
      await settle(o);
    });
  });
});
