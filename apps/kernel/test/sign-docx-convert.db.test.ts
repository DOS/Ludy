// SPDX-License-Identifier: AGPL-3.0-only
// eSign Slice 6b DB + crove-extract sandbox integration tests (#4721, Gate T12):
// - Staged .docx upload -> outbox -> worker crove-extract('docx_to_pdf') -> tmp cleanup -> actorOf(user) ingest
// - Cross-user polling and unattached sign_document confidentiality live in test/invariant/sign-docx-confidentiality.db.test.ts
// - Preserved {{signature, r1}} / {{dropdown, r1, ...}} tags inspected by runSignPdfInspectJob
// - sourceDocxSha256 recorded in signing_event (envelope_created) and template create audit
// - Clean 422 on OLE2 and Track Changes, 415 on invalid MIME/magic, 403 on extension/viewer, ADR-0053 appOn guard
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
  fileKey,
  parseVaultKey,
  putFile,
  sha256Hex,
} from '@ludy/kernel-runtime';
import { signCommands, signQueries } from '@ludy/mod-sign';
import type { AuthUser } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runSignDocxConvertJob } from '../src/sign-docx-worker.ts';
import { runSignPdfInspectJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
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

function buildDocx(bodyXml: string, extraParts: Record<string, string> = {}): Uint8Array {
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
    },
    ...Object.entries(extraParts).map(([name, data]) => ({ name, data })),
  ]);
}

suite('eSign Slice 6b: native .docx upload -> tagged A4 PDF via crove-extract (#4721)', () => {
  const dbName = `ludy_test_sign_docx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  let blobDir: string;
  let store: LocalDiskStore;

  const extractApp = createExtractApp();
  const realExtractClient = createExtractClient({
    url: 'http://crove-extract.local',
    fetch: (async (input, init) => Promise.resolve(extractApp.request(input instanceof Request ? input : new Request(input, init)))) as typeof fetch,
  });

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const person = (roleName: 'owner' | 'admin' | 'member' | 'viewer') =>
      upsertIdentity(createDb(pool), {
        issuer: 'sign-docx',
        subject: `${roleName}-${tag}`,
        email: `${roleName}-${tag}@signdocx.test`,
        name: roleName,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `SignDocx ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [
        orgId,
        admin,
        member,
        viewer,
      ]),
    );
    return { orgId, slug, owner, admin, member, viewer };
  }

  function makeHttp(o: Awaited<ReturnType<typeof setupOrg>>, options: { signDocxWaitMs?: number } = {}) {
    const nowS = Math.floor(Date.now() / 1000);
    const users = new Map<string, AuthUser>([
      ...[o.owner, o.admin, o.member, o.viewer].map(
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
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-sign-docx-012345',
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
      ...(options.signDocxWaitMs !== undefined ? { signDocxWaitMs: options.signDocxWaitMs } : {}),
    });

    const postDocx = async (token: string, bytes: Uint8Array, filename: string, mime = DOCX_MIME) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
      const res = await app.request('/api/sign/convert-docx', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-ludy-org': o.slug },
        body: form,
      });
      const body = (await res.json().catch(() => null)) as SignDocxConvertHttpResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    const pollDocx = async (token: string, jobId: string) => {
      const res = await app.request(`/api/sign/convert-docx/${jobId}`, {
        headers: { authorization: `Bearer ${token}`, 'x-ludy-org': o.slug },
      });
      const body = (await res.json().catch(() => null)) as SignDocxConvertHttpResponse & Record<string, unknown>;
      return { status: res.status, body };
    };

    return { app, postDocx, pollDocx };
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
    blobDir = mkdtempSync(join(tmpdir(), 'ludy-sign-docx-blobs-'));
    store = new LocalDiskStore(blobDir);
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
  }, 180_000);

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

  it('converts native .docx via worker crove-extract, preserves uploaded_by confidentiality, survives pdf_inspect tags, and stores sourceDocxSha256', async () => {
    const o = await setupOrg();
    const http = makeHttp(o, { signDocxWaitMs: 0 });
    const docxBytes = buildDocx(
      '<w:p><w:r><w:t>Hợp đồng dịch vụ mẫu. Đại diện: {{signature, r1}} {{dropdown, r1, Đồng ý|Từ chối}}</w:t></w:r></w:p>',
      { 'word/media/logo.png': 'png-bytes' },
    );
    const inputSha256 = sha256Hex(docxBytes);

    const queued = await http.postDocx(o.member, docxBytes, 'hop-dong-mau.docx');
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ status: 'pending', jobId: expect.any(String) });
    if (queued.body.status !== 'pending') throw new Error('expected pending');
    const { jobId } = queued.body;

    // Pending sweep lists the queued job before completion.
    const pendingBefore = await workerRt.query<Array<{ jobId: string }>>(
      'sign.docx_convert.pending',
      {},
      { actor: { type: 'system', component: 'sign.docx_convert' }, orgId: o.orgId },
    );
    expect(pendingBefore.map((p) => p.jobId)).toContain(jobId);

    // Run worker extraction against real crove-extract.
    const workerResults = await drainQueuedDocxJobs(o.orgId);
    expect(workerResults).toHaveLength(1);
    expect(workerResults[0]?.status).toBe('completed');

    // Cross-user poll isolation is pinned in test/invariant/sign-docx-confidentiality.db.test.ts.
    // Uploader poll finalizes as actorOf(o.member) and emits warnings cleanly.
    const completed = await http.pollDocx(o.member, jobId);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: 'completed',
      fileId: expect.any(String),
      filename: 'hop-dong-mau.pdf',
      pageCount: 1,
      sourceDocxSha256: inputSha256,
      warnings: ['images_skipped'],
    });
    if (completed.body.status !== 'completed') throw new Error('expected completed');
    const { fileId } = completed.body;

    // Second poll hits idempotent cache and returns the same fileId.
    const secondPoll = await http.pollDocx(o.member, jobId);
    expect(secondPoll.status).toBe(200);
    expect(secondPoll.body).toEqual(completed.body);

    // A duplicate/stale failed complete call (e.g. from dead-letter or replay) never overwrites an existing completed job.
    await workerRt.execute(
      'sign.docx_convert.complete',
      { jobId, ok: false, pdfSha256: null, errorCode: 'SIGN_DOCX_CONVERT_FAILED' },
      { actor: { type: 'system', component: 'sign.docx_convert' }, orgId: o.orgId },
    );
    const completeAuditCount = await withAdmin((c) =>
      c.query<{ count: string }>(
        `SELECT pg_catalog.count(*)::text AS count FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'sign.docx_convert.complete' AND detail ->> 'jobId' = $2`,
        [o.orgId, jobId],
      ),
    );
    expect(completeAuditCount.rows[0]?.count).toBe('1');
    const pollAfterReplay = await http.pollDocx(o.member, jobId);
    expect(pollAfterReplay.status).toBe(200);
    expect(pollAfterReplay.body).toEqual(completed.body);

    // Unattached sign_document confidentiality (can_read_sign_file & cross-user attachment refusal) lives in test/invariant/sign-docx-confidentiality.db.test.ts.
    // Uploader creates envelope carrying sourceDocxSha256 -> stored in signing_event (envelope_created).
    const env = await rt.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Hợp đồng từ Word', sourceFileId: fileId, sourceDocxSha256: inputSha256 },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    const events = await withAdmin((c) =>
      c.query<{ event_type: string; payload_json: Record<string, unknown> }>(
        `SELECT event_type, payload_json FROM ludy_sign.signing_event WHERE org_id = $1 AND envelope_id = $2`,
        [o.orgId, env.envelopeId],
      ),
    );
    expect(events.rows[0]?.event_type).toBe('envelope_created');
    expect(events.rows[0]?.payload_json.sourceDocxSha256).toBe(inputSha256);

    // Run real sign PDF inspection and verify placeholder tags survived into detected_tags_json.
    const inspectDone = await runSignPdfInspectJob(
      { workerDb: createDb(workerPool), runtime: workerRt, store, extract: realExtractClient },
      { orgId: o.orgId, envelopeId: env.envelopeId },
    );
    expect(inspectDone).toEqual({ status: 'passed', pageCount: 1 });
    const envRow = await withAdmin((c) =>
      c.query<{ inspect_status: string; detected_tags_json: Array<{ fieldType: string; roleKey: string }> }>(
        `SELECT inspect_status, detected_tags_json FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2`,
        [o.orgId, env.envelopeId],
      ),
    );
    expect(envRow.rows[0]?.inspect_status).toBe('passed');
    expect(envRow.rows[0]?.detected_tags_json.map((t) => [t.fieldType, t.roleKey])).toEqual([
      ['signature', 'r1'],
      ['dropdown', 'r1'],
    ]);

    // Uploader creates template carrying sourceDocxSha256 -> recorded in audit_event.
    const tpl = await rt.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mẫu từ Word', sourceFileId: fileId, sourceDocxSha256: inputSha256 },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    const tplAudit = await withAdmin((c) =>
      c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'sign.template.create' AND detail ->> 'templateId' = $2 LIMIT 1`,
        [o.orgId, tpl.templateId],
      ),
    );
    expect(tplAudit.rows[0]?.detail.sourceDocxSha256).toBe(inputSha256);
  }, 60_000);

  it('rejects OLE2, non-docx uploads, extension/viewer actors, Track Changes, and respects ADR-0053 sign appOn gate', async () => {
    const o = await setupOrg();
    const http = makeHttp(o, { signDocxWaitMs: 0 });

    const ole2 = await http.postDocx(o.member, new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'old.doc', 'application/msword');
    expect(ole2.status).toBe(422);

    const badZip = await http.postDocx(o.member, buildZip([{ name: 'a.txt', data: 'hi' }]), 'archive.zip', 'application/zip');
    expect(badZip.status).toBe(415);

    const extRefused = await http.postDocx('ext-user', buildDocx('<w:p/>'), 'hop-dong.docx');
    expect(extRefused.status).toBe(403);

    const viewerRefused = await http.postDocx(o.viewer, buildDocx('<w:p/>'), 'hop-dong.docx');
    expect(viewerRefused.status).toBe(403);

    // Track Changes .docx enters worker and transitions to clean 422 failure on poll.
    const trackedDocx = buildDocx('<w:p><w:ins w:id="1"><w:r><w:t>Hidden clause</w:t></w:r></w:ins></w:p>');
    const trackedReq = await http.postDocx(o.member, trackedDocx, 'tracked.docx');
    expect(trackedReq.status).toBe(202);
    if (trackedReq.body.status !== 'pending') throw new Error('expected pending');
    const trackedRun = await drainQueuedDocxJobs(o.orgId);
    expect(trackedRun[0]?.status).toBe('failed');
    const failedPoll = await http.pollDocx(o.member, trackedReq.body.jobId);
    expect(failedPoll.status).toBe(422);

    // ADR-0053: worker skips execution when sign module is switched off.
    await rt.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asMfa(o.owner), orgId: o.orgId });
    const appOffRes = await runSignDocxConvertJob(
      { runtime: workerRt, store, extract: realExtractClient },
      {
        orgId: o.orgId,
        targetKind: 'docx_convert',
        jobId: randomUUID(),
        storageKey: `tmp/${o.orgId}/${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
      },
    );
    expect(appOffRes).toEqual({ status: 'skipped_app_off' });
  }, 60_000);

  it('verifies sourceDocxSha256 provenance, keeps plain PDFs working, maps storage-key/25MB failures safely, and serializes complete', async () => {
    const o = await setupOrg();
    const http = makeHttp(o, { signDocxWaitMs: 0 });
    const docxBytes = buildDocx('<w:p><w:r><w:t>Hợp đồng kiểm tra nguồn gốc</w:t></w:r></w:p>');
    const inputSha256 = sha256Hex(docxBytes);

    const queued = await http.postDocx(o.member, docxBytes, 'provenance.docx');
    if (queued.body.status !== 'pending') throw new Error('expected pending');
    await drainQueuedDocxJobs(o.orgId);

    const completed = await http.pollDocx(o.member, queued.body.jobId);
    expect(completed.status).toBe(200);
    if (completed.body.status !== 'completed') throw new Error('expected completed');
    const convertedFileId = completed.body.fileId;

    // Concurrent duplicate sign.docx_convert.complete calls serialize cleanly under advisory lock.
    await Promise.all([
      workerRt.execute(
        'sign.docx_convert.complete',
        { jobId: queued.body.jobId, ok: false, pdfSha256: null, errorCode: 'SIGN_DOCX_CONVERT_FAILED' },
        { actor: { type: 'system', component: 'sign.docx_convert' }, orgId: o.orgId },
      ),
      workerRt.execute(
        'sign.docx_convert.complete',
        { jobId: queued.body.jobId, ok: false, pdfSha256: null, errorCode: 'SIGN_DOCX_CONVERT_FAILED' },
        { actor: { type: 'system', component: 'sign.docx_convert' }, orgId: o.orgId },
      ),
    ]);
    const completeCount = await withAdmin((c) =>
      c.query<{ count: string }>(
        `SELECT pg_catalog.count(*)::text AS count FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'sign.docx_convert.complete' AND detail ->> 'jobId' = $2`,
        [o.orgId, queued.body.jobId],
      ),
    );
    expect(completeCount.rows[0]?.count).toBe('1');

    // Ingest a separate genuine PDF as o.member.
    const plainPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
    const plainPdfSha = sha256Hex(plainPdfBytes);
    const plainPdfKey = fileKey(o.orgId, plainPdfSha);
    const plainPdfGen = await putFile(store, plainPdfKey, plainPdfBytes, 'application/pdf', plainPdfSha);
    const { fileId: plainPdfId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: 'plain.pdf',
        contentType: 'application/pdf',
        sizeBytes: plainPdfBytes.byteLength,
        sha256: plainPdfSha,
        storageKey: plainPdfKey,
        generation: plainPdfGen,
        source: 'sign_document',
      },
      { actor: asUser(o.member), orgId: o.orgId },
    );

    // Normal PDF creation without sourceDocxSha256 succeeds seamlessly.
    const plainEnv = await rt.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Plain PDF envelope', sourceFileId: plainPdfId },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    expect(plainEnv.envelopeId).toBeTruthy();
    const plainTpl = await rt.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Plain PDF template', sourceFileId: plainPdfId },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    expect(plainTpl.templateId).toBeTruthy();

    // Forged or mismatched sourceDocxSha256 is refused with 422 SIGN_INVALID_SOURCE_FILE.
    await expect(
      rt.execute(
        'sign.envelope.create',
        { title: 'Forged hash', sourceFileId: convertedFileId, sourceDocxSha256: 'f'.repeat(64) },
        { actor: asUser(o.member), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    await expect(
      rt.execute(
        'sign.template.create',
        { title: 'Forged template hash', sourceFileId: convertedFileId, sourceDocxSha256: 'f'.repeat(64) },
        { actor: asUser(o.member), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    await expect(
      rt.execute(
        'sign.envelope.create',
        { title: 'Mismatched PDF hash', sourceFileId: plainPdfId, sourceDocxSha256: inputSha256 },
        { actor: asUser(o.member), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    await expect(
      rt.execute(
        'sign.template.create',
        { title: 'Mismatched template PDF hash', sourceFileId: plainPdfId, sourceDocxSha256: inputSha256 },
        { actor: asUser(o.member), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    // Cross-user provenance: once convertedFileId is visible via an org template, o.admin can create a normal envelope
    // from it without sourceDocxSha256, but cannot claim o.member's sourceDocxSha256.
    await rt.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Member docx template', sourceFileId: convertedFileId, sourceDocxSha256: inputSha256 },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    await expect(
      rt.execute(
        'sign.envelope.create',
        { title: 'Stolen docx provenance', sourceFileId: convertedFileId, sourceDocxSha256: inputSha256 },
        { actor: asUser(o.admin), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });
    await expect(
      rt.execute(
        'sign.envelope.create',
        { title: 'Plain reuse of template PDF', sourceFileId: convertedFileId },
        { actor: asUser(o.admin), orgId: o.orgId },
      ),
    ).resolves.toMatchObject({ envelopeId: expect.any(String) });

    // Invalid storageKey inside worker is masked as SIGN_DOCX_CONVERT_FAILED (never leaked on poll).
    const badKeyJobId = randomUUID();
    await rt.execute(
      'sign.docx_convert.request',
      { jobId: badKeyJobId, sha256: inputSha256, sizeBytes: docxBytes.byteLength },
      { actor: asUser(o.member), orgId: o.orgId },
    );
    const badKeyRes = await runSignDocxConvertJob(
      { runtime: workerRt, store, extract: realExtractClient },
      {
        orgId: o.orgId,
        targetKind: 'docx_convert',
        jobId: badKeyJobId,
        storageKey: `tmp/${o.orgId}/wrong-key`,
        sha256: inputSha256,
        sizeBytes: docxBytes.byteLength,
      },
    );
    expect(badKeyRes).toEqual({ status: 'failed', errorCode: 'SIGN_DOCX_CONVERT_FAILED' });
    const badKeyPoll = await http.pollDocx(o.member, badKeyJobId);
    expect(badKeyPoll.status).toBe(422);
    expect(badKeyPoll.body).toMatchObject({ code: 'SIGN_DOCX_CONVERT_FAILED' });

    // >25 MB converted PDF refusal from extract classifies as 413 SIGN_DOCX_TOO_LARGE on poll.
    const bigPdfDocxBytes = buildDocx('<w:p><w:r><w:t>Tệp lớn giả lập 25 MB</w:t></w:r></w:p>');
    const bigPdfReq = await http.postDocx(o.member, bigPdfDocxBytes, 'oversize-pdf.docx');
    if (bigPdfReq.body.status !== 'pending') throw new Error('expected pending');
    const bigPdfPayload = await withAdmin((c) =>
      c.query<{ payload: { jobId: string; storageKey: string; sha256: string; sizeBytes: number } }>(
        `SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.docx_convert_queued' AND payload ->> 'jobId' = $2`,
        [o.orgId, bigPdfReq.body.jobId],
      ),
    );
    const fake25MbExtract: typeof realExtractClient = {
      ...realExtractClient,
      extract: async () => ({
        ok: false,
        code: 'too_large',
        message: 'Tệp PDF sau khi chuyển đổi vượt quá giới hạn 25 MB',
      }),
    };
    const bigPdfRun = await runSignDocxConvertJob(
      { runtime: workerRt, store, extract: fake25MbExtract },
      { orgId: o.orgId, targetKind: 'docx_convert', ...bigPdfPayload.rows[0]!.payload },
    );
    expect(bigPdfRun).toEqual({ status: 'failed', errorCode: 'SIGN_DOCX_TOO_LARGE' });
    const bigPdfPoll = await http.pollDocx(o.member, bigPdfReq.body.jobId);
    expect(bigPdfPoll.status).toBe(413);
    expect(bigPdfPoll.body).toMatchObject({ code: 'SIGN_DOCX_TOO_LARGE' });
  }, 60_000);
});
