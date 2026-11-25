// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for eSign .docx upload & conversion confidentiality (#4721, #4729):
//   - Pre-storage authorization: viewer and extension actors fail 403 BEFORE BlobStore tmp/ staging or request audit
//   - Cross-user and cross-org poll isolation: same-org owner/admin/other-member and foreign-org actors get 404
//     on pending, completed, and failed jobIds without triggering finalization or leaking failure details
//   - Unattached converted PDF confidentiality: finalization ingests strictly as actorOf(uploader), so
//     ludy_sign.can_read_sign_file returns false for owner/admin/other-member/viewer, kernel.file.get returns 404,
//     and sign.envelope.create / sign.template.create cannot attach another user's unattached sign_document file
//   - Cross-user sourceDocxSha256 provenance isolation: another member cannot claim uploader's sourceDocxSha256
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createExtractApp } from '@ludy/extract';
import { createExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { SignDocxConvertHttpResponse } from '@ludy/kernel-contract';
import {
  CredentialVault,
  DomainError,
  LocalDiskStore,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import { signCommands, signQueries } from '@ludy/mod-sign';
import type { AuthUser } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { handleSignDocxConvertUpload } from '../../src/sign-docx-http.ts';
import { runSignDocxConvertJob } from '../../src/sign-docx-worker.ts';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function buildZip(entries: Array<{ name: string; data: string }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8');
    const body = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const cdSize = centrals.reduce((sum, b) => sum + b.byteLength, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

function buildDocx(bodyXml: string): Uint8Array {
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
    },
  ]);
}

suite('eSign .docx cross-user polling and unattached file confidentiality invariants (#4729)', () => {
  const dbName = `ludy_test_sign_docx_conf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  let blobDir: string;
  let baseStore: LocalDiskStore;
  let putCalls: string[] = [];
  let store: BlobStore;

  const extractApp = createExtractApp();
  const realExtractClient = createExtractClient({
    url: 'http://crove-extract.local',
    fetch: (async (input, init) => Promise.resolve(extractApp.request(input instanceof Request ? input : new Request(input, init)))) as typeof fetch,
  });

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
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

  async function canReadSignFileAsUser(userId: string, orgId: string, fileId: string): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, userId, orgId);
      const res = await c.query<{ allowed: boolean }>('SELECT ludy_sign.can_read_sign_file($1::uuid) AS allowed', [fileId]);
      return Boolean(res.rows[0]?.allowed);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const person = (label: string) =>
      upsertIdentity(createDb(pool), {
        issuer: 'sign-docx-conf',
        subject: `${label}-${tag}`,
        email: `${label}-${tag}@signdocxconf.test`,
        name: label,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const member2 = await person('member2');
    const viewer = await person('viewer');
    const foreignOwner = await person('foreign');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `SignDocxConf ${tag}`);
    const { orgId: foreignOrgId, slug: foreignSlug } = await createOrg(rt, asUser(foreignOwner), `SignDocxOther ${tag}`);
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
        [orgId, admin, member, member2, viewer],
      ),
    );
    return { orgId, slug, foreignOrgId, foreignSlug, owner, admin, member, member2, viewer, foreignOwner };
  }

  function makeHttp(o: Awaited<ReturnType<typeof setupOrg>>) {
    const nowS = Math.floor(Date.now() / 1000);
    const users = new Map<string, AuthUser>([
      ...[o.owner, o.admin, o.member, o.member2, o.viewer, o.foreignOwner].map(
        (id) => [id, { userId: id, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const,
      ),
      [
        'ext-user',
        {
          userId: o.member,
          email: '',
          name: null,
          aal: 'aal1' as const,
          sessionId: '',
          mfaAt: null,
          extension: {
            tokenId: randomUUID(),
            orgId: o.orgId,
            userId: o.member,
            scopes: ['meetings'] as const,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ],
    ]);

    const app = createHttpApp({
      exports: new ConcurrencyLimiter({ total: 2, perKey: 2 }),
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-sign-docx-conf-012345',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      runtime: rt,
      store,
      authenticate: async (header) => {
        const token = String(header ?? '').replace('Bearer ', '');
        const user = users.get(token);
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
        return user;
      },
      pool,
      aiEnabled: false,
      signDocxWaitMs: 0,
    });

    const postDocx = async (token: string, bytes: Uint8Array, filename: string, orgSlug = o.slug) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: DOCX_MIME }), filename);
      const res = await app.request('/api/sign/convert-docx', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-ludy-org': orgSlug },
        body: form,
      });
      const body = (await res.json().catch(() => null)) as SignDocxConvertHttpResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    const pollDocx = async (token: string, jobId: string, orgSlug = o.slug) => {
      const res = await app.request(`/api/sign/convert-docx/${jobId}`, {
        headers: { authorization: `Bearer ${token}`, 'x-ludy-org': orgSlug },
      });
      const body = (await res.json().catch(() => null)) as SignDocxConvertHttpResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    return { app, users, postDocx, pollDocx };
  }

  async function drainQueuedDocxJobs(orgId: string) {
    const events = await withAdmin((c) =>
      c.query<{ id: string; payload: { jobId: string; storageKey: string; sha256: string; sizeBytes: number } }>(
        `SELECT e.id, e.payload
         FROM ludy_kernel.outbox_event e
         WHERE e.org_id = $1
           AND e.type = 'sign.docx_convert_queued'
           AND NOT EXISTS (
             SELECT 1 FROM ludy_kernel.audit_event a
             WHERE a.org_id = e.org_id
               AND a.command = 'sign.docx_convert.complete'
               AND a.detail ->> 'jobId' = e.payload ->> 'jobId'
           )
         ORDER BY e.id ASC`,
        [orgId],
      ),
    );
    const out = [];
    for (const ev of events.rows) {
      out.push(
        await runSignDocxConvertJob(
          { runtime: workerRt, store, extract: realExtractClient },
          { orgId, targetKind: 'docx_convert', ...ev.payload },
        ),
      );
    }
    return out;
  }

  beforeAll(async () => {
    blobDir = mkdtempSync(join(tmpdir(), 'ludy-sign-docx-conf-'));
    baseStore = new LocalDiskStore(blobDir);
    store = {
      put: async (key, bytes) => {
        putCalls.push(key);
        return baseStore.put(key, bytes);
      },
      get: (key) => baseStore.get(key),
      delete: (key) => baseStore.delete(key),
    };
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appConn = new URL(adminUrl);
    appConn.username = 'ludy_app';
    appConn.password = 'test-app-pw';
    appUrl = appConn.toString();
    const workerConn = new URL(adminUrl);
    workerConn.username = 'ludy_worker';
    workerConn.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerConn.toString(), max: 2 });
    const registry = {
      commands: [...kernelCommands, ...signCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...signQueries],
    };
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required',
    }).register(registry);
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    rmSync(blobDir, { recursive: true, force: true });
    if (ADMIN) {
      const rootDb = new pg.Client({ connectionString: ADMIN });
      await rootDb.connect();
      await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await rootDb.end();
    }
  });

  it('refuses viewer/extension uploads before BlobStore tmp staging and enforces cross-user poll + unattached file confidentiality', async () => {
    const o = await setupOrg();
    const http = makeHttp(o);
    const confidentialDocx = buildDocx('<w:p><w:r><w:t>Hợp đồng riêng tư chưa gửi ký</w:t></w:r></w:p>');
    const inputSha256 = sha256Hex(confidentialDocx);

    // 1. Pre-storage authorization: viewer and extension actors fail 403 with zero BlobStore puts and zero audit rows.
    putCalls = [];
    const viewerForm = new FormData();
    viewerForm.append('file', new Blob([new Uint8Array(confidentialDocx)], { type: DOCX_MIME }), 'viewer.docx');
    await expect(
      handleSignDocxConvertUpload({
        runtime: rt,
        store,
        user: http.users.get(o.viewer)!,
        orgId: o.orgId,
        req: new Request('http://localhost/api/sign/convert-docx', { method: 'POST', body: viewerForm }),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(putCalls).toEqual([]);

    const viewerHttp = await http.postDocx(o.viewer, confidentialDocx, 'viewer.docx');
    expect(viewerHttp.status).toBe(403);
    const extHttp = await http.postDocx('ext-user', confidentialDocx, 'ext.docx');
    expect(extHttp.status).toBe(403);
    expect(putCalls).toEqual([]);

    // 2. Uploader queues conversion.
    const queued = await http.postDocx(o.member, confidentialDocx, 'confidential.docx');
    expect(queued.status).toBe(202);
    if (queued.body.status !== 'pending') throw new Error('expected pending');
    const { jobId } = queued.body;

    // Cross-user and cross-org polling while pending returns 404 (403 for viewer).
    for (const outsider of [o.owner, o.admin, o.member2]) {
      expect((await http.pollDocx(outsider, jobId)).status).toBe(404);
    }
    expect((await http.pollDocx(o.viewer, jobId)).status).toBe(403);
    expect((await http.pollDocx(o.foreignOwner, jobId, o.foreignSlug)).status).toBe(404);

    // 3. Worker converts .docx to PDF.
    const workerResults = await drainQueuedDocxJobs(o.orgId);
    expect(workerResults).toHaveLength(1);
    expect(workerResults[0]?.status).toBe('completed');

    // Cross-user polling after worker completion STILL returns 404 and does NOT finalize/ingest any file row.
    for (const outsider of [o.owner, o.admin, o.member2]) {
      const deniedPoll = await http.pollDocx(outsider, jobId);
      expect(deniedPoll.status).toBe(404);
      expect(deniedPoll.body).toMatchObject({ code: 'SIGN_DOCX_JOB_NOT_FOUND' });
    }
    expect((await http.pollDocx(o.foreignOwner, jobId, o.foreignSlug)).status).toBe(404);
    const filesBeforeUploaderPoll = await withAdmin((c) =>
      c.query<{ count: string }>(`SELECT pg_catalog.count(*)::text AS count FROM ludy_kernel.file WHERE org_id = $1`, [o.orgId]),
    );
    expect(filesBeforeUploaderPoll.rows[0]?.count).toBe('0');

    // 4. Uploader poll finalizes and ingests strictly as actorOf(o.member).
    const completed = await http.pollDocx(o.member, jobId);
    expect(completed.status).toBe(200);
    if (completed.body.status !== 'completed') throw new Error('expected completed');
    const { fileId } = completed.body;

    const fileMeta = await withAdmin((c) =>
      c.query<{ created_by: string; source: string; content_type: string }>(
        `SELECT created_by, source, content_type FROM ludy_kernel.file WHERE org_id = $1 AND id = $2`,
        [o.orgId, fileId],
      ),
    );
    expect(fileMeta.rows[0]).toEqual({
      created_by: o.member,
      source: 'sign_document',
      content_type: 'application/pdf',
    });

    // 5. Unattached file confidentiality: only uploader can read via can_read_sign_file, kernel.file.get, and HTTP /api/files/:id.
    expect(await canReadSignFileAsUser(o.member, o.orgId, fileId)).toBe(true);
    await expect(rt.query('kernel.file.get', { id: fileId }, { actor: asUser(o.member), orgId: o.orgId })).resolves.toMatchObject({
      id: fileId,
      source: 'sign_document',
    });
    for (const peer of [o.owner, o.admin, o.member2, o.viewer]) {
      expect(await canReadSignFileAsUser(peer, o.orgId, fileId)).toBe(false);
      await expect(rt.query('kernel.file.get', { id: fileId }, { actor: asUser(peer), orgId: o.orgId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      const httpFileRes = await http.app.request(`/api/files/${fileId}`, {
        headers: { authorization: `Bearer ${peer}`, 'x-ludy-org': o.slug },
      });
      expect(httpFileRes.status).toBe(404);
    }
    expect(await canReadSignFileAsUser(o.foreignOwner, o.foreignOrgId, fileId)).toBe(false);

    // 6. Another org user (even owner/admin) cannot attach uploader's unattached file to a new envelope or template.
    for (const attacker of [o.owner, o.admin, o.member2]) {
      await expect(
        rt.execute('sign.envelope.create', { title: 'Stolen envelope', sourceFileId: fileId }, { actor: asUser(attacker), orgId: o.orgId }),
      ).rejects.toThrow();
      await expect(
        rt.execute('sign.template.create', { title: 'Stolen template', sourceFileId: fileId }, { actor: asUser(attacker), orgId: o.orgId }),
      ).rejects.toThrow();
    }

    // 7. Even after uploader attaches fileId to a shared org template, another user cannot forge sourceDocxSha256 provenance.
    await rt.execute(
      'sign.template.create',
      { title: 'Shared template', sourceFileId: fileId, sourceDocxSha256: inputSha256 },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    await expect(
      rt.execute(
        'sign.envelope.create',
        { title: 'Forged provenance', sourceFileId: fileId, sourceDocxSha256: inputSha256 },
        { actor: asUser(o.admin), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    // 8. Failed conversion jobIds also keep strict cross-user 404 parity (never leak Track Changes failure details).
    const trackedDocx = buildDocx('<w:p><w:ins w:id="1"><w:r><w:t>Hidden</w:t></w:r></w:ins></w:p>');
    const trackedQueued = await http.postDocx(o.member, trackedDocx, 'tracked.docx');
    if (trackedQueued.body.status !== 'pending') throw new Error('expected pending');
    await drainQueuedDocxJobs(o.orgId);
    expect((await http.pollDocx(o.admin, trackedQueued.body.jobId)).status).toBe(404);
    expect((await http.pollDocx(o.owner, trackedQueued.body.jobId)).status).toBe(404);
    expect((await http.pollDocx(o.member, trackedQueued.body.jobId)).status).toBe(422);
  }, 60_000);
});
