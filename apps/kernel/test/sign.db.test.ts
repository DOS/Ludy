// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 1a (#3323): upload guards, PDF inspect/seal workers, ADR-0053
// work/keeping gating, envelope/signer/field/token commands, machinery RLS, hash-chain verification, PDPL, and org purge.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { decodePdfSealInput, type ExtractClient, type PdfSealInput } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import type { PersonalDataErasure, PersonalDataResult } from '@ludy/kernel-contract';
import { Runtime, fileKey, sha256Hex, type AgentActor, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import {
  SIGN_COMPLETED_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_REMIND_MAIL_TEMPLATE,
  signCommands,
  signManifest,
  signQueries,
} from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { signMailTemplates } from '../src/sign-mail.ts';
import { SIGN_ACTOR, runSignPdfInspectJob, runSignPdfSealJob, sweepSignCleanup, sweepSignExpire, sweepSignPendingWork } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sign-3323-0123456789abcdef';
const ISSUER = 'crove-auth';
const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }

  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const pdfFixture = (tag: string) =>
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% sign-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 1a core on PostgreSQL (#3323)', () => {
  const dbName = `crove_test_sign_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let appWithoutSign: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner@sign.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@sign.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@sign.test', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2@sign.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@sign.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@sign.test', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, sessionId: who.session, aal: 'aal1' as const });
  const asMfa = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadFile(
    targetApp: ReturnType<typeof createHttpApp>,
    who: Account,
    bytes: Uint8Array,
    filename: string,
    purpose?: string,
    mime = 'application/pdf',
    slug = org.slug,
  ) {
    const form = new FormData();
    form.append('file', new File([Buffer.from(bytes)], filename, { type: mime }));
    if (purpose !== undefined) form.append('purpose', purpose);
    const res = await targetApp.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': slug },
      body: form,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  }

  function mockExtract(options: {
    inspectError?: { code: 'invalid'; message: string };
    capturedSealInputs?: PdfSealInput[];
  } = {}): ExtractClient {
    return {
      async extract(kind, bytes) {
        if (kind === 'pdf_inspect') {
          if (options.inspectError) {
            return { ok: false, code: options.inspectError.code, message: options.inspectError.message } as never;
          }
          return {
            ok: true,
            kind: 'pdf_inspect',
            pageCount: 2,
            pages: [
              { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
              { page: 2, widthPt: 612, heightPt: 792, rotation: 90 },
            ],
          } as never;
        }
        if (kind === 'pdf_seal') {
          const decoded = decodePdfSealInput(bytes);
          options.capturedSealInputs?.push(decoded);
          return {
            ok: true,
            kind: 'pdf_seal',
            sealedPdfBase64: Buffer.from(`%PDF-1.4\n%sealed-${decoded.certificate.certificateCode}\n`, 'utf8').toString('base64'),
            pageCount: 3,
          } as never;
        }
        throw new Error(`unexpected extract kind in sign test: ${kind}`);
      },
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...signQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...financeCommands, ...signCommands],
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...financeCommands, ...signCommands, orgPurgeCommand({ store })],
      queries: sharedQueries,
    });

    const rtWithoutSign = new Runtime(db, {
      manifests: TEST_MANIFESTS.filter((m) => m !== signManifest.tables),
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: buildKernelCommands({ shippedModules: AVAILABLE_MODULES.filter((m) => m !== 'sign') }),
      queries: kernelQueries({ inboundDomain: null }),
    });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });
    appWithoutSign = createHttpApp({ config, runtime: rtWithoutSign, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, otherMember, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign Test Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await app.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`,
          'content-type': 'application/json',
          'x-crove-org': org.slug,
        },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      expect(invite.status).toBe(200);
      const body = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc('invites/accept', who, { token: body.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const other = await rpc('org/create', outsider, { name: 'Other Org', idempotencyKey: randomUUID() }, null);
    expect(other.status).toBe(200);
    otherOrg = { slug: String(other.body.slug), orgId: String(other.body.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces sign_document HTTP upload rules, rejects 404/415/409 conflicts, and blocks user writes of sealed/certificate sources', async () => {
    const signPdf = pdfFixture('upload-ok');
    const ok = await uploadFile(app, member, signPdf, 'contract.pdf', 'sign_document');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const uploadedFileId = ((ok.body?.files as Array<{ fileId: string }>) ?? [])[0]?.fileId;
    expect(uploadedFileId).toBeTruthy();

    const fileRow = await admin(async (c) =>
      (await c.query('SELECT source, content_type FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [org.orgId, uploadedFileId])).rows[0],
    );
    expect(fileRow).toEqual({ source: 'sign_document', content_type: 'application/pdf' });

    const outboxCount = await admin(async (c) =>
      Number((await c.query("SELECT count(*) AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.ingested'", [org.orgId])).rows[0].n),
    );
    expect(outboxCount).toBe(0);

    const noSignRes = await uploadFile(appWithoutSign, member, pdfFixture('no-sign'), 'contract.pdf', 'sign_document');
    expect(noSignRes.status).toBe(404);

    const nonPdfRes = await uploadFile(app, member, Buffer.from('not a pdf'), 'notes.txt', 'sign_document', 'text/plain');
    expect(nonPdfRes.status).toBe(415);

    const conflictUpload = await uploadFile(app, member, signPdf, 'same.pdf', 'document');
    expect(conflictUpload.status).toBe(409);
    expect(conflictUpload.body?.code).toBe('FILE_SOURCE_CONFLICT');

    const regularPdf = pdfFixture('regular-first');
    const firstUpload = await uploadFile(app, member, regularPdf, 'invoice.pdf', 'document');
    expect(firstUpload.status).toBe(200);
    const conflictSign = await uploadFile(app, member, regularPdf, 'invoice-sign.pdf', 'sign_document');
    expect(conflictSign.status).toBe(409);
    expect(conflictSign.body?.code).toBe('FILE_SOURCE_CONFLICT');

    const sealedBytes = pdfFixture('user-sealed-attempt');
    const sealedSha = sha256Hex(sealedBytes);
    for (const source of ['sign_sealed', 'sign_certificate'] as const) {
      await expect(
        runtime.execute(
          'kernel.file.ingest',
          {
            filename: 'forged.pdf',
            contentType: source === 'sign_sealed' ? 'application/pdf' : 'application/json',
            sizeBytes: sealedBytes.byteLength,
            sha256: sealedSha,
            storageKey: `org/${org.orgId}/${sealedSha}`,
            generation: `content:${sealedSha}`,
            source,
          },
          { actor: asUser(owner), orgId: org.orgId },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
  });

  it('runs Slice 1a lifecycle, ADR-0053 inspect gating, validation, token hashing/machinery RLS, link rotation, remind cooldown, void, seal, verify, and cross-org isolation', async () => {
    const docBytes = pdfFixture('lifecycle');
    const upload = await uploadFile(app, member, docBytes, 'nda.pdf', 'sign_document');
    expect(upload.status).toBe(200);
    const sourceFileId = ((upload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    const regularUpload = await uploadFile(app, member, pdfFixture('non-sign-source'), 'other.pdf', 'document');
    const regularFileId = ((regularUpload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;
    await expect(
      runtime.execute('sign.envelope.create', { title: 'Bad source', sourceFileId: regularFileId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE_FILE', status: 422 });

    // #3428 L2: envelope expiresAt cannot exceed 30 days (720 hours).
    await expect(
      runtime.execute(
        'sign.envelope.create',
        {
          title: 'Too Far Expiry',
          sourceFileId,
          expiresAt: new Date(Date.now() + 31 * DAY_MS).toISOString(),
        },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_EXPIRY', status: 422 });

    const futureExpiry = new Date(Date.now() + 7 * DAY_MS).toISOString();
    const created = await runtime.execute<{ envelopeId: string; status: string; inspectStatus: string; version: number }>(
      'sign.envelope.create',
      { title: 'Mutual NDA 2027', subject: 'Please sign', routingMode: 'sequential', sourceFileId, expiresAt: futureExpiry },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(created).toMatchObject({ status: 'draft', inspectStatus: 'pending', version: 1 });
    const envelopeId = created.envelopeId;

    await expect(
      runtime.execute(
        'sign.envelope.update',
        {
          envelopeId,
          expiresAt: new Date(Date.now() + 31 * DAY_MS).toISOString(),
        },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_EXPIRY', status: 422 });

    const inspectOutbox = await admin(async (c) =>
      (await c.query("SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'sign.envelope.inspect_queued'", [org.orgId])).rows,
    );
    expect(inspectOutbox.some((r) => r.payload?.envelopeId === envelopeId)).toBe(true);

    // ADR-0053 'work': turning 'sign' off makes inspect worker skip without failing.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const skippedInspect = await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId });
    expect(skippedInspect).toEqual({ status: 'skipped_app_off' });
    const offUploadRes = await uploadFile(app, member, pdfFixture('app-off'), 'off.pdf', 'sign_document');
    expect(offUploadRes.status).toBe(404);
    expect(offUploadRes.body?.code).toBe('NOT_FOUND');

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const passedInspect = await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId });
    expect(passedInspect).toEqual({ status: 'passed', pageCount: 2 });

    // Failed PDF inspection path blocks sign.field.set.
    const badUpload = await uploadFile(app, member, pdfFixture('corrupt'), 'corrupt.pdf', 'sign_document');
    const badEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Corrupt draft', sourceFileId: ((badUpload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const failedInspect = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract({ inspectError: { code: 'invalid', message: 'Invalid PDF header' } }) },
      { orgId: org.orgId, envelopeId: badEnv.envelopeId },
    );
    expect(failedInspect).toEqual({ status: 'failed' });

    // Update optimistic lock + signer validations.
    const updated = await runtime.execute<{ version: number }>(
      'sign.envelope.update',
      { envelopeId, expectedVersion: 2, title: 'Mutual NDA Final' },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(updated.version).toBe(3);
    await expect(
      runtime.execute('sign.envelope.update', { envelopeId, expectedVersion: 2, title: 'Stale' }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_VERSION_CONFLICT', status: 409 });

    await expect(
      runtime.execute('sign.signer.add', { envelopeId, name: 'No Email', deliveryMode: 'email' }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_EMAIL_REQUIRED', status: 422 });
    await expect(
      runtime.execute('sign.signer.add', { envelopeId, name: 'OTP No Email', requireEmailOtp: true }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_EMAIL_REQUIRED', status: 422 });
    await expect(
      runtime.execute(
        'sign.signer.add',
        { envelopeId, signerRole: 'cc', name: 'CC', email: 'cc@sign.test', requireEmailOtp: true },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNER', status: 422 });

    const s1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId, routingOrder: 2, signerRole: 'signer', name: 'Nguyen Van A', email: 'Alice@Sign.Test', requireEmailOtp: true },
      { actor: asUser(member), orgId: org.orgId },
    );
    const s2 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId, routingOrder: 1, signerRole: 'approver', name: 'Tran Thi B', email: 'bob@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    const sTemp = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId, routingOrder: 4, signerRole: 'signer', name: 'Temp Signer' },
      { actor: asUser(member), orgId: org.orgId },
    );
    const sCc = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId, routingOrder: 3, signerRole: 'cc', name: 'Legal CC', email: 'legal@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute('sign.signer.remove', { envelopeId, signerId: sTemp.signerId }, { actor: asUser(member), orgId: org.orgId });

    // Reorder so s1 (signer) goes first (order 1), s2 (approver) goes second (order 2).
    await runtime.execute(
      'sign.signer.reorder',
      {
        envelopeId,
        orders: [
          { signerId: s1.signerId, routingOrder: 1 },
          { signerId: s2.signerId, routingOrder: 2 },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Failed inspect draft refuses field.set; CC or page>pageCount or norm>1 refuse field.set.
    await expect(
      runtime.execute('sign.field.set', { envelopeId: badEnv.envelopeId, fields: [] }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_INSPECT_FAILED', status: 409 });

    await expect(
      runtime.execute(
        'sign.field.set',
        {
          envelopeId,
          fields: [{ signerId: sCc.signerId, fieldType: 'text', pageNumber: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.05 }],
        },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_FIELD', status: 422 });

    await expect(
      runtime.execute(
        'sign.field.set',
        {
          envelopeId,
          fields: [{ signerId: s1.signerId, fieldType: 'signature', pageNumber: 3, xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.1 }],
        },
        { actor: asUser(member), orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_FIELD_OUT_OF_BOUNDS', status: 422 });

    // Missing signature field blocks send.
    await expect(
      runtime.execute('sign.envelope.send', { envelopeId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_SIGNATURE_FIELD_REQUIRED', status: 409 });

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          { signerId: s1.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.1, label: 'Sign Here' },
          { signerId: s1.signerId, fieldType: 'initials', pageNumber: 2, xNorm: 0.1, yNorm: 0.8, wNorm: 0.1, hNorm: 0.05 },
          { signerId: s2.signerId, fieldType: 'date', pageNumber: 1, xNorm: 0.6, yNorm: 0.7, wNorm: 0.2, hNorm: 0.05 },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Agent actors are forbidden from sending, minting links, reminding, or voiding.
    const { agentId, positionId } = await runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(owner), orgId: org.orgId },
    );
    await runtime.execute('kernel.task.create', { title: 'Agent task', assigneePositionId: positionId }, { actor: asUser(owner), orgId: org.orgId });
    const agentRun = await workerRuntime.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId },
      { actor: { type: 'system', component: 'kernel.agent' }, orgId: org.orgId },
    );
    const agentActor: AgentActor = { type: 'agent', agentId, runId: agentRun.runId as string };
    await expect(
      workerRuntime.execute('sign.envelope.send', { envelopeId }, { actor: agentActor, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Token-issuing send refuses idempotencyKey so plaintext links never enter idempotency_key.response.
    await expect(
      runtime.execute('sign.envelope.send', { envelopeId }, { actor: asUser(member), orgId: org.orgId, idempotencyKey: 'send-key-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNSUPPORTED', status: 400 });
    const sendIdemRows = await admin(async (c) =>
      (await c.query("SELECT key FROM crove_kernel.idempotency_key WHERE org_id = $1 AND command = 'sign.envelope.send'", [org.orgId])).rows,
    );
    expect(sendIdemRows).toEqual([]);

    // Sequential send activates only s1 (order 1) and mints 1 raw link.
    const sent = await runtime.execute<{ envelopeId: string; status: string; links: Array<{ signerId: string; tokenId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(sent.status).toBe('sent');
    expect(sent.links).toHaveLength(1);
    const firstLink = sent.links[0]!;
    expect(firstLink.signerId).toBe(s1.signerId);
    expect(firstLink.token.length).toBeGreaterThanOrEqual(32);

    // Token is hashed only in crove_sign.signing_token and never leaks into audit/outbox/signing_event.
    const tokenRows = await admin(async (c) =>
      (await c.query('SELECT id, token_sha256, revoked_at FROM crove_sign.signing_token WHERE org_id = $1 AND envelope_id = $2', [org.orgId, envelopeId])).rows,
    );
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].token_sha256).toBe(sha256Hex(Buffer.from(firstLink.token, 'utf8')));
    expect(tokenRows[0].revoked_at).toBeNull();

    const auditDump = await admin(async (c) =>
      JSON.stringify((await c.query("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'sign.%'", [org.orgId])).rows),
    );
    expect(auditDump).not.toContain(firstLink.token);
    const eventDump = await admin(async (c) =>
      JSON.stringify((await c.query('SELECT payload_json FROM crove_sign.signing_event WHERE org_id = $1 AND envelope_id = $2', [org.orgId, envelopeId])).rows),
    );
    expect(eventDump).not.toContain(firstLink.token);

    // Machinery tables refuse direct SELECT/INSERT via app role even in tenant context.
    const appClient = await pool.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(appClient.query('SELECT id FROM crove_sign.signing_token')).rejects.toThrow();
      await expect(appClient.query('SELECT id FROM crove_sign.signing_otp')).rejects.toThrow();
    } finally {
      await appClient.query('ROLLBACK').catch(() => {});
      appClient.release();
    }

    // Draft-only mutations blocked once sent.
    await expect(
      runtime.execute('sign.envelope.update', { envelopeId, title: 'Blocked' }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_DRAFT', status: 409 });

    // Direct non-draft SQL UPDATE/DELETE and guard bypass attempts refused by DB guard even inside tenant user context.
    const guardClient = await pool.connect();
    try {
      await guardClient.query('BEGIN');
      await guardClient.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [member.userId, org.orgId]);
      const expectGuardFailure = async (sqlText: string, params: unknown[], pattern: RegExp) => {
        await guardClient.query('SAVEPOINT sign_guard');
        await expect(guardClient.query(sqlText, params)).rejects.toThrow(pattern);
        await guardClient.query('ROLLBACK TO SAVEPOINT sign_guard');
        await guardClient.query('RELEASE SAVEPOINT sign_guard');
      };
      await expectGuardFailure('DELETE FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [org.orgId, envelopeId], /ENVELOPE_FROZEN/);
      await expectGuardFailure(
        'UPDATE crove_sign.field SET envelope_id = $1 WHERE org_id = $2 AND envelope_id = $3',
        [badEnv.envelopeId, org.orgId, envelopeId],
        /FIELD_IMMUTABLE/,
      );
      await expectGuardFailure(
        "INSERT INTO crove_sign.field (org_id, envelope_id, signer_id, field_type, page_number, x_norm, y_norm, w_norm, h_norm) VALUES ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)",
        [org.orgId, badEnv.envelopeId, s1.signerId],
        /field_signer_fk/,
      );
      await expectGuardFailure(
        "INSERT INTO crove_sign.signer (org_id, envelope_id, role_label, name, delivery_mode, status) VALUES ($1, $2, 'Signer', 'Forged', 'link', 'pending')",
        [org.orgId, badEnv.envelopeId],
        /SIGNER_INVALID_TRANSITION/,
      );
      await expectGuardFailure(
        "INSERT INTO crove_sign.signer (org_id, envelope_id, role_label, name, delivery_mode, status, signed_at, otp_verified_at, signature_kind, consent_accepted_at) VALUES ($1, $2, 'Signer', 'Forged', 'link', 'waiting', now(), now(), 'draw', now())",
        [org.orgId, badEnv.envelopeId],
        /SIGNER_SYSTEM_ONLY/,
      );
      const tempSigner = await guardClient.query<{ id: string }>(
        "INSERT INTO crove_sign.signer (org_id, envelope_id, role_label, name, delivery_mode) VALUES ($1, $2, 'Signer', 'Draft Temp', 'link') RETURNING id",
        [org.orgId, badEnv.envelopeId],
      );
      const tempSignerId = tempSigner.rows[0]!.id;
      await expectGuardFailure(
        "UPDATE crove_sign.signer SET status = 'pending' WHERE org_id = $1 AND id = $2",
        [org.orgId, tempSignerId],
        /SIGNER_INVALID_TRANSITION/,
      );
      await expectGuardFailure(
        'UPDATE crove_sign.signer SET token_last_reminded_at = now() WHERE org_id = $1 AND id = $2',
        [org.orgId, tempSignerId],
        /SIGNER_SYSTEM_ONLY/,
      );
    } finally {
      await guardClient.query('ROLLBACK').catch(() => {});
      guardClient.release();
    }

    // create_link refuses waiting/CC signers, rotates pending signer link & revokes old token.
    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId, signerId: s2.signerId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_SIGNER_NOT_DUE', status: 409 });
    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId, signerId: sCc.signerId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNER', status: 422 });

    // #3428 L3: create_link is restricted to creator, owner, or admin (another member and viewer get 403).
    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId, signerId: s1.signerId }, { actor: asUser(otherMember), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId, signerId: s1.signerId }, { actor: asUser(viewer), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const rotated = await runtime.execute<{ tokenId: string; token: string }>(
      'sign.signer.create_link',
      { envelopeId, signerId: s1.signerId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(rotated.token).not.toBe(firstLink.token);
    const rotatedRows = await admin(async (c) =>
      (await c.query('SELECT id, revoked_at FROM crove_sign.signing_token WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at', [org.orgId, s1.signerId])).rows,
    );
    expect(rotatedRows).toHaveLength(2);
    expect(rotatedRows[0].revoked_at).not.toBeNull();
    expect(rotatedRows[1].revoked_at).toBeNull();

    const ownerRotated = await runtime.execute<{ tokenId: string; token: string }>(
      'sign.signer.create_link',
      { envelopeId, signerId: s1.signerId },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(ownerRotated.token).not.toBe(rotated.token);

    // Token-issuing create_link also refuses idempotencyKey without revoking existing token or storing idempotency rows.
    await expect(
      runtime.execute('sign.signer.create_link', { envelopeId, signerId: s1.signerId }, { actor: asUser(member), orgId: org.orgId, idempotencyKey: 'link-key-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNSUPPORTED', status: 400 });
    const linkIdemRows = await admin(async (c) =>
      (await c.query("SELECT key FROM crove_kernel.idempotency_key WHERE org_id = $1 AND command = 'sign.signer.create_link'", [org.orgId])).rows,
    );
    expect(linkIdemRows).toEqual([]);
    const rotatedAfterRefusal = await admin(async (c) =>
      (await c.query('SELECT id, revoked_at FROM crove_sign.signing_token WHERE org_id = $1 AND signer_id = $2 ORDER BY created_at', [org.orgId, s1.signerId])).rows,
    );
    expect(rotatedAfterRefusal).toHaveLength(3);
    expect(rotatedAfterRefusal[2].revoked_at).toBeNull();

    // remind succeeds then hits 5m cooldown 429.
    const reminded = await runtime.execute<{ remindedSignerIds: string[] }>(
      'sign.envelope.remind',
      { envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(reminded.remindedSignerIds).toEqual([s1.signerId]);
    await expect(
      runtime.execute('sign.envelope.remind', { envelopeId }, { actor: asUser(member), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_REMIND_RATE_LIMITED', status: 429 });

    // Void permissions: another non-creator member is refused (403); viewer is refused (403).
    await expect(
      runtime.execute('sign.envelope.void', { envelopeId, reason: 'Nope' }, { actor: asUser(otherMember), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_FORBIDDEN', status: 403 });
    await expect(
      runtime.execute('sign.envelope.void', { envelopeId, reason: 'Nope' }, { actor: asUser(viewer), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Parallel draft + void flow revokes tokens cleanly.
    const parallelEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Parallel Agreement', routingMode: 'parallel', sourceFileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId: parallelEnv.envelopeId });
    const p1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: parallelEnv.envelopeId, signerRole: 'signer', name: 'P1', email: 'p1@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    const p2 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: parallelEnv.envelopeId, signerRole: 'signer', name: 'P2', email: 'p2@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: parallelEnv.envelopeId,
        fields: [
          { signerId: p1.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
          { signerId: p2.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.4, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const sentParallel = await runtime.execute<{ links: Array<{ signerId: string }> }>(
      'sign.envelope.send',
      { envelopeId: parallelEnv.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(sentParallel.links).toHaveLength(2);
    const voided = await runtime.execute<{ status: string; revokedTokens: number }>(
      'sign.envelope.void',
      { envelopeId: parallelEnv.envelopeId, reason: 'Superseded by Mutual NDA Final' },
      { actor: asUser(adminUser), orgId: org.orgId },
    );
    expect(voided).toMatchObject({ status: 'voided', revokedTokens: 2 });

    // Mark sequential envelope as executed via admin PG update (Slice 1b signing step stand-in), then run seal job.
    await admin(async (c) => {
      await c.query(
        `UPDATE crove_sign.signer
         SET status = 'signed', signed_at = now(), consent_accepted_at = now(), signature_kind = 'type', signature_typed_text = name, updated_at = now()
         WHERE org_id = $1 AND envelope_id = $2 AND signer_role <> 'cc'`,
        [org.orgId, envelopeId],
      );
      await c.query(
        `UPDATE crove_sign.field
         SET value_text = CASE WHEN field_type = 'signature' THEN NULL ELSE '2026-11-16' END,
             signature_png_base64 = CASE WHEN field_type = 'signature' THEN 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' ELSE NULL END,
             filled_at = now(),
             updated_at = now()
         WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, envelopeId],
      );
      await c.query(
        `UPDATE crove_sign.envelope
         SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [org.orgId, envelopeId],
      );
    });

    const capturedSealInputs: PdfSealInput[] = [];
    const sealed = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract({ capturedSealInputs }) },
      { orgId: org.orgId, envelopeId },
    );
    expect(sealed.status).toBe('sealed');
    expect(sealed.certificateCode).toMatch(/^CS-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(capturedSealInputs).toHaveLength(1);
    // Verify Slice 1a mapping from DB field_type 'initials' -> PdfSeal field type 'initial'.
    expect(capturedSealInputs[0]!.fields.some((f) => f.type === 'initial')).toBe(true);
    expect(capturedSealInputs[0]!.fields.some((f) => f.type === 'signature')).toBe(true);

    const envDetail = await runtime.query<{
      envelope: { sealStatus: string; sealedFileId: string; certificateFileId: string; certificateCode: string; sealedSha256: string; certificateSha256: string };
    }>('sign.envelope.get', { envelopeId }, { actor: asUser(viewer), orgId: org.orgId });
    expect(envDetail.envelope.sealStatus).toBe('sealed');
    expect(envDetail.envelope.certificateCode).toBe(sealed.certificateCode);

    const verified = await runtime.query<{ valid: boolean; eventChain: { valid: boolean }; files: { pointersConsistent: boolean } }>(
      'sign.envelope.verify',
      { envelopeId },
      { actor: asUser(viewer), orgId: org.orgId },
    );
    expect(verified).toMatchObject({ valid: true, eventChain: { valid: true }, files: { pointersConsistent: true } });

    // Append-only guard rejects app UPDATE/DELETE on crove_sign.signing_event.
    const appendClient = await pool.connect();
    try {
      await appendClient.query('BEGIN');
      await appendClient.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
      await expect(
        appendClient.query("UPDATE crove_sign.signing_event SET payload_json = '{\"tampered\":true}'::jsonb WHERE org_id = $1 AND envelope_id = $2", [org.orgId, envelopeId]),
      ).rejects.toThrow();
    } finally {
      await appendClient.query('ROLLBACK').catch(() => {});
      appendClient.release();
    }

    // Tamper 1 payload row inside a bypassed admin tx on parallelEnv to prove verifyEventChain detects DB tampering.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_sign.signing_event SET payload_json = '{\"tampered\":true}'::jsonb WHERE org_id = $1 AND envelope_id = $2 AND seq = 2", [
        org.orgId,
        parallelEnv.envelopeId,
      ]);
      await c.query('COMMIT');
    });
    const broken = await runtime.query<{ valid: boolean; eventChain: { valid: boolean; brokenSeq: number | null } }>(
      'sign.envelope.verify',
      { envelopeId: parallelEnv.envelopeId },
      { actor: asUser(viewer), orgId: org.orgId },
    );
    expect(broken.valid).toBe(false);
    expect(broken.eventChain).toMatchObject({ valid: false, brokenSeq: 2 });

    // Cross-org isolation: outsider in otherOrg gets 404 on sign queries & commands.
    await expect(
      runtime.query('sign.envelope.get', { envelopeId }, { actor: asUser(outsider), orgId: otherOrg.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('sign.envelope.verify', { envelopeId }, { actor: asUser(outsider), orgId: otherOrg.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.execute('sign.envelope.void', { envelopeId }, { actor: asUser(outsider), orgId: otherOrg.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
  });

  it('runs keeping sweeps while sign app is off, erases OTP emails under PDPL, and purges all 7 crove_sign tables via orgPurge', async () => {
    const upload = await uploadFile(app, member, pdfFixture('cleanup-expire'), 'sweep.pdf', 'sign_document');
    const sourceFileId = ((upload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    // 1. Expiring envelope (created with future expiry, then backdated past now via admin).
    const expiringEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Soon Expired', sourceFileId, expiresAt: new Date(Date.now() + DAY_MS).toISOString() },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId: expiringEnv.envelopeId });
    const expSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: expiringEnv.envelopeId, signerRole: 'signer', name: 'Erase Subject', email: 'signer-erase@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: expiringEnv.envelopeId,
        fields: [{ signerId: expSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 }],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const sentExp = await runtime.execute<{ links: Array<{ tokenId: string }> }>(
      'sign.envelope.send',
      { envelopeId: expiringEnv.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Draft envelopes for PDPL find & erase verification (same email as expired signer + phone-only signer).
    const draftPdplEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Draft PDPL Erasure', sourceFileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId: draftPdplEnv.envelopeId });
    const draftEraseSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: draftPdplEnv.envelopeId,
        signerRole: 'signer',
        name: 'Draft Erase',
        email: 'signer-erase@sign.test',
        phone: '+84 900 000 001',
        deliveryMode: 'email',
        requireEmailOtp: true,
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const draftCoSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: draftPdplEnv.envelopeId, signerRole: 'signer', name: 'Keep CoSigner', email: 'co-signer@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: draftPdplEnv.envelopeId,
        fields: [
          { signerId: draftEraseSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
          { signerId: draftCoSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.5, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
        ],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const draftPhoneEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Draft Phone PDPL', sourceFileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const draftPhoneSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: draftPhoneEnv.envelopeId, signerRole: 'signer', name: 'Phone Draft', phone: '0999888777' },
      { actor: asUser(member), orgId: org.orgId },
    );

    // Completed + sealed envelope for PDPL preservation verification while unsealed draft/expired signers erase.
    const sealedEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Completed Sealed Env', sourceFileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId: sealedEnv.envelopeId });
    const sealedSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: sealedEnv.envelopeId, signerRole: 'signer', name: 'Sealed Subject', email: 'signer-erase@sign.test' },
      { actor: asUser(member), orgId: org.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: sealedEnv.envelopeId,
        fields: [{ signerId: sealedSigner.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 }],
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    const sentSealed = await runtime.execute<{ links: Array<{ tokenId: string }> }>(
      'sign.envelope.send',
      { envelopeId: sealedEnv.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'UPDATE crove_sign.field SET signature_png_base64 = $3, filled_at = now() WHERE org_id = $1 AND envelope_id = $2',
        [org.orgId, sealedEnv.envelopeId, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
      );
      await c.query("UPDATE crove_sign.signer SET status = 'signed', signed_at = now() WHERE org_id = $1 AND envelope_id = $2", [org.orgId, sealedEnv.envelopeId]);
      await c.query("UPDATE crove_sign.envelope SET status = 'completed', completed_at = now() WHERE org_id = $1 AND id = $2", [org.orgId, sealedEnv.envelopeId]);
      await c.query('COMMIT');
    });
    const sealedDone = await runSignPdfSealJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: org.orgId, envelopeId: sealedEnv.envelopeId });
    expect(sealedDone.status).toBe('sealed');

    // 2. Old untouched draft (>120d) stays preserved; old token (>30d) + old OTP (>24h) prune via cleanup sweep; fresh OTP stays.
    const staleDraft = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Abandoned Draft', sourceFileId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const staleTokenDate = new Date(Date.now() - 40 * DAY_MS);
    const staleOtpDate = new Date(Date.now() - 30 * 3_600_000);
    const staleDraftDate = new Date(Date.now() - 120 * DAY_MS);
    await admin(async (c) => {
      await c.query(
        'UPDATE crove_sign.envelope SET expires_at = now() - interval \'5 minutes\' WHERE org_id = $1 AND id = $2',
        [org.orgId, expiringEnv.envelopeId],
      );
      await c.query(
        'UPDATE crove_sign.envelope SET updated_at = $3 WHERE org_id = $1 AND id = $2',
        [org.orgId, staleDraft.envelopeId, staleDraftDate],
      );
      // Old expired OTP (> 24h) to test cleanup_org_secrets
      await c.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, created_at)
         VALUES ($1, $2, $3, 'stale-otp@sign.test', $4, $5, $5)`,
        [org.orgId, expSigner.signerId, sentExp.links[0]!.tokenId, sha256Hex(Buffer.from('123456')), staleOtpDate],
      );
      // Old revoked token (> 30d) to test cleanup_org_secrets
      await c.query(
        `INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, revoked_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $5)`,
        [org.orgId, expiringEnv.envelopeId, expSigner.signerId, sha256Hex(Buffer.from('stale-tok')), staleTokenDate, member.userId],
      );
      // Fresh OTP for personal_erase_otp
      await c.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at)
         VALUES ($1, $2, $3, 'Signer-Erase@Sign.Test', $4, now() + interval '10 minutes')`,
        [org.orgId, expSigner.signerId, sentExp.links[0]!.tokenId, sha256Hex(Buffer.from('654321'))],
      );
      // ai_analysis row so all 7 tables are populated before orgPurge
      await c.query(
        `INSERT INTO crove_sign.ai_analysis (org_id, envelope_id, source_sha256, status, summary_text)
         VALUES ($1, $2, $3, 'completed', 'Sample AI review')`,
        [org.orgId, expiringEnv.envelopeId, sha256Hex(pdfFixture('cleanup-expire'))],
      );
    });

    // ADR-0053 'keeping': disable sign app, sweeps still expire and prune stale secrets while preserving drafts.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const expiredCount = await sweepSignExpire({ workerDb, runtime: workerRuntime });
    expect(expiredCount).toBe(1);

    const expStatus = await admin(async (c) =>
      (await c.query('SELECT status, expired_at FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [org.orgId, expiringEnv.envelopeId])).rows[0],
    );
    expect(expStatus.status).toBe('expired');
    expect(expStatus.expired_at).not.toBeNull();

    const cleaned = await sweepSignCleanup({ workerDb, runtime: workerRuntime });
    expect(cleaned.otps).toBeGreaterThanOrEqual(1);
    expect(cleaned.tokens).toBeGreaterThanOrEqual(1);
    expect(cleaned.drafts).toBe(0);
    expect(cleaned.draftEvents).toBe(0);

    const staleKept = await admin(async (c) =>
      (await c.query('SELECT id, status FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [org.orgId, staleDraft.envelopeId])).rows,
    );
    expect(staleKept).toEqual([{ id: staleDraft.envelopeId, status: 'draft' }]);

    // Non-owner cannot call crove_sign.personal_erase_otp or personal_erase_unsealed_signers directly.
    const adminClient = await pool.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [adminUser.userId, org.orgId]);
      await adminClient.query('SAVEPOINT sp_erase_otp');
      await expect(adminClient.query("SELECT crove_sign.personal_erase_otp('signer-erase@sign.test')")).rejects.toThrow(/SIGN_FORBIDDEN/);
      await adminClient.query('ROLLBACK TO SAVEPOINT sp_erase_otp');
      await adminClient.query('SAVEPOINT sp_erase_signer');
      await expect(adminClient.query("SELECT crove_sign.personal_erase_unsealed_signers('email', 'signer-erase@sign.test')")).rejects.toThrow(/SIGN_FORBIDDEN/);
      await adminClient.query('ROLLBACK TO SAVEPOINT sp_erase_signer');
    } finally {
      await adminClient.query('ROLLBACK').catch(() => {});
      adminClient.release();
    }

    // Re-verify fresh OTP row before PDPL test (fresh OTP was NOT deleted by cleanup).
    const freshOtpBefore = await admin(async (c) =>
      Number((await c.query("SELECT count(*) AS n FROM crove_sign.signing_otp WHERE org_id = $1 AND lower(email) = 'signer-erase@sign.test'", [org.orgId])).rows[0].n),
    );
    expect(freshOtpBefore).toBe(1);

    const found = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'signer-erase@sign.test' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    const emailMatches = found.matches.filter((m) => m.column === 'crove_sign.signer.email');
    expect(emailMatches.find((m) => m.rowId === draftEraseSigner.signerId)?.handling).toBe('erase');
    expect(emailMatches.find((m) => m.rowId === expSigner.signerId)?.handling).toBe('erase');
    expect(emailMatches.find((m) => m.rowId === sealedSigner.signerId)?.handling).toBe('keep_record');

    const erased = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'signer-erase@sign.test' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased).toEqual(
      expect.arrayContaining([
        { column: 'crove_sign.signing_otp.email', rows: 1 },
        { column: 'crove_sign.signer.name', rows: 2 },
        { column: 'crove_sign.signer.email', rows: 2 },
        { column: 'crove_sign.signer.phone', rows: 1 },
      ]),
    );
    expect(erased.kept).toContainEqual(expect.objectContaining({ column: 'crove_sign.signer.email', rows: 1 }));
    const draftAfterErase = await admin(async (c) => ({
      erasedSigner: (await c.query('SELECT id FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [org.orgId, draftEraseSigner.signerId])).rows,
      erasedField: (await c.query('SELECT id FROM crove_sign.field WHERE org_id = $1 AND signer_id = $2', [org.orgId, draftEraseSigner.signerId])).rows,
      erasedExpSigner: (await c.query('SELECT id FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [org.orgId, expSigner.signerId])).rows,
      keptSealedSigner: (await c.query('SELECT id FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [org.orgId, sealedSigner.signerId])).rows,
      coSigner: (await c.query('SELECT id FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [org.orgId, draftCoSigner.signerId])).rows,
      coField: (await c.query('SELECT id FROM crove_sign.field WHERE org_id = $1 AND signer_id = $2', [org.orgId, draftCoSigner.signerId])).rows,
    }));
    expect(draftAfterErase.erasedSigner).toHaveLength(0);
    expect(draftAfterErase.erasedField).toHaveLength(0);
    expect(draftAfterErase.erasedExpSigner).toHaveLength(0);
    expect(draftAfterErase.keptSealedSigner).toHaveLength(1);
    expect(draftAfterErase.coSigner).toHaveLength(1);
    expect(draftAfterErase.coField).toHaveLength(1);

    const erasedPhone = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '+84 999 888 777' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedPhone.erased).toEqual(
      expect.arrayContaining([
        { column: 'crove_sign.signer.name', rows: 1 },
        { column: 'crove_sign.signer.phone', rows: 1 },
      ]),
    );
    const phoneSignerLeft = await admin(async (c) =>
      (await c.query('SELECT id FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [org.orgId, draftPhoneSigner.signerId])).rows,
    );
    expect(phoneSignerLeft).toHaveLength(0);

    // Insert another OTP row on the preserved sealed signer so orgPurge exercises all 7 crove_sign tables simultaneously.
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at)
         VALUES ($1, $2, $3, 'purge-check@sign.test', $4, now() + interval '5 minutes')`,
        [org.orgId, sealedSigner.signerId, sentSealed.links[0]!.tokenId, sha256Hex(Buffer.from('999999'))],
      );
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [org.orgId]);
      await c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [org.orgId, new Date(Date.now() - 40 * DAY_MS), owner.userId, randomUUID(), '0'.repeat(64), new Date(Date.now() - 31 * DAY_MS), randomUUID()],
      );
      await c.query('COMMIT');
    });

    const lines: string[] = [];
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => lines.push(l), error: (l) => lines.push(l) },
      [org.orgId, '--reason', 'Owner offboarded sign test org'],
    );
    expect(purgeCode, lines.join('\n')).toBe(0);

    for (const table of [
      'crove_sign.signing_otp',
      'crove_sign.signing_token',
      'crove_sign.signing_event',
      'crove_sign.field',
      'crove_sign.signer',
      'crove_sign.ai_analysis',
      'crove_sign.envelope',
    ]) {
      const remaining = await admin(async (c) =>
        Number((await c.query(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [org.orgId])).rows[0].n),
      );
      expect(remaining, table).toBe(0);
    }
  });

  it('enforces draft void, 500-char inspect error, routing order reuse, field micro-units, SQL envelope guards, seal fail-safe, and pending work recovery', async () => {
    const createdReg = await rpc('org/create', owner, { name: 'Sign Regressions Org', idempotencyKey: randomUUID() }, null);
    expect(createdReg.status).toBe(200);
    const regOrgId = String(createdReg.body.orgId);
    const regSlug = String(createdReg.body.slug);

    const upload = await uploadFile(app, owner, pdfFixture('regressions'), 'regressions.pdf', 'sign_document', 'application/pdf', regSlug);
    expect(upload.status).toBe(200);
    const sourceFileId = ((upload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    // 1. Draft void transitions envelope and its signers to voided cleanly.
    const draftEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Draft Void', sourceFileId },
      { actor: asUser(owner), orgId: regOrgId },
    );
    const draftSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      { envelopeId: draftEnv.envelopeId, signerRole: 'signer', name: 'Draft Signer', email: 'draft-void@sign.test' },
      { actor: asUser(owner), orgId: regOrgId },
    );
    const voidedDraft = await runtime.execute<{ status: string }>(
      'sign.envelope.void',
      { envelopeId: draftEnv.envelopeId, reason: 'Cancelled before send' },
      { actor: asUser(owner), orgId: regOrgId },
    );
    expect(voidedDraft.status).toBe('voided');
    const voidedRows = await admin(async (c) => ({
      env: (await c.query('SELECT status, void_reason FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [regOrgId, draftEnv.envelopeId])).rows[0],
      signer: (await c.query('SELECT status FROM crove_sign.signer WHERE org_id = $1 AND id = $2', [regOrgId, draftSigner.signerId])).rows[0],
    }));
    expect(voidedRows.env).toEqual({ status: 'voided', void_reason: 'Cancelled before send' });
    expect(voidedRows.signer).toEqual({ status: 'voided' });

    // Stale inspect job / inspect_complete ignores voided drafts cleanly without rewriting status or appending events.
    const voidedInspect = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract() },
      { orgId: regOrgId, envelopeId: draftEnv.envelopeId },
    );
    expect(voidedInspect.status).toBe('skipped_not_pending');
    const directVoidedInspect = await workerRuntime.execute<{ inspectStatus: string; pageCount: number | null }>(
      'sign.envelope.inspect_complete',
      {
        envelopeId: draftEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: SIGN_ACTOR, orgId: regOrgId },
    );
    expect(directVoidedInspect).toEqual({
      envelopeId: draftEnv.envelopeId,
      inspectStatus: 'pending',
      pageCount: null,
    });
    const voidedEvents = await admin(async (c) =>
      (await c.query<{ event_type: string }>('SELECT event_type FROM crove_sign.signing_event WHERE org_id = $1 AND envelope_id = $2 ORDER BY seq ASC', [regOrgId, draftEnv.envelopeId])).rows,
    );
    expect(voidedEvents.map((e) => e.event_type)).not.toContain('document_inspected');

    // 2. Inspect error longer than 500 chars is clamped by sign-worker and satisfies DB CHECK.
    const failEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Inspect 500 Clamp', sourceFileId },
      { actor: asUser(owner), orgId: regOrgId },
    );
    const inspectFail = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract({ inspectError: { code: 'invalid', message: `bad-pdf-${'x'.repeat(640)}` } }) },
      { orgId: regOrgId, envelopeId: failEnv.envelopeId },
    );
    expect(inspectFail.status).toBe('failed');
    const inspectRow = await admin(async (c) =>
      (await c.query<{ inspect_status: string; inspect_error: string }>('SELECT inspect_status, inspect_error FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [regOrgId, failEnv.envelopeId])).rows[0],
    );
    expect(inspectRow?.inspect_status).toBe('failed');
    expect(inspectRow?.inspect_error.length).toBe(500);

    // 3. Routing order up to 100, default order reuse after delete, phone <6 refusal, and field micro-unit validation.
    const mainEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Guard And Seal Env', sourceFileId },
      { actor: asUser(owner), orgId: regOrgId },
    );
    await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: regOrgId, envelopeId: mainEnv.envelopeId });

    const s1 = await runtime.execute<{ signerId: string; routingOrder: number }>(
      'sign.signer.add',
      { envelopeId: mainEnv.envelopeId, signerRole: 'signer', name: 'First Slot', email: 'slot1@sign.test', routingOrder: 1 },
      { actor: asUser(owner), orgId: regOrgId },
    );
    const s100 = await runtime.execute<{ signerId: string; routingOrder: number }>(
      'sign.signer.add',
      { envelopeId: mainEnv.envelopeId, signerRole: 'signer', name: 'Slot 100', email: 'slot100@sign.test', routingOrder: 100 },
      { actor: asUser(owner), orgId: regOrgId },
    );
    expect(s100.routingOrder).toBe(100);
    await runtime.execute('sign.signer.remove', { envelopeId: mainEnv.envelopeId, signerId: s1.signerId }, { actor: asUser(owner), orgId: regOrgId });

    const sReused = await runtime.execute<{ signerId: string; routingOrder: number }>(
      'sign.signer.add',
      { envelopeId: mainEnv.envelopeId, signerRole: 'signer', name: 'Reused Slot', email: 'reused@sign.test' },
      { actor: asUser(owner), orgId: regOrgId },
    );
    expect(sReused.routingOrder).toBe(1);
    await runtime.execute('sign.signer.remove', { envelopeId: mainEnv.envelopeId, signerId: s100.signerId }, { actor: asUser(owner), orgId: regOrgId });

    await expect(
      runtime.execute(
        'sign.signer.add',
        { envelopeId: mainEnv.envelopeId, signerRole: 'signer', name: 'Short Phone', email: 'short-phone@sign.test', phone: '12345' },
        { actor: asUser(owner), orgId: regOrgId },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    for (const badBox of [
      { xNorm: 0.1, yNorm: 0.1, wNorm: 0.0000004, hNorm: 0.1 },
      { xNorm: 0.9999999, yNorm: 0.1, wNorm: 0.000001, hNorm: 0.1 },
      { xNorm: 0.5, yNorm: 0.1, wNorm: 0.500001, hNorm: 0.1 },
    ]) {
      await expect(
        runtime.execute(
          'sign.field.set',
          { envelopeId: mainEnv.envelopeId, fields: [{ signerId: sReused.signerId, fieldType: 'signature', pageNumber: 1, ...badBox }] },
          { actor: asUser(owner), orgId: regOrgId },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    }

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: mainEnv.envelopeId,
        fields: [{ signerId: sReused.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.5, yNorm: 0.5, wNorm: 0.5, hNorm: 0.5 }],
      },
      { actor: asUser(owner), orgId: regOrgId },
    );

    // 4. Direct tenant SQL cannot forge inspect_status on INSERT/UPDATE or mutate source_file_id.
    const meta = await admin(async (c) =>
      (
        await c.query<{ source_storage_key: string; source_generation: string; source_sha256: string }>(
          'SELECT source_storage_key, source_generation, source_sha256 FROM crove_sign.envelope WHERE org_id = $1 AND id = $2',
          [regOrgId, mainEnv.envelopeId],
        )
      ).rows[0]!,
    );
    const expectTenantSqlRejects = async (sqlText: string, params: unknown[], pattern: RegExp) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, regOrgId]);
        await expect(c.query(sqlText, params)).rejects.toThrow(pattern);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    await expectTenantSqlRejects(
      `INSERT INTO crove_sign.envelope (org_id, title, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
       VALUES ($1, 'Forged Inspect', $2, $3, $4, $5, 'passed', $6)`,
      [regOrgId, sourceFileId, meta.source_storage_key, meta.source_generation, meta.source_sha256, owner.userId],
      /ENVELOPE_FORBIDDEN/,
    );
    await expectTenantSqlRejects(
      "UPDATE crove_sign.envelope SET inspect_status = 'passed' WHERE org_id = $1 AND id = $2",
      [regOrgId, failEnv.envelopeId],
      /ENVELOPE_SYSTEM_ONLY/,
    );
    await expectTenantSqlRejects(
      'UPDATE crove_sign.envelope SET source_file_id = $3 WHERE org_id = $1 AND id = $2',
      [regOrgId, failEnv.envelopeId, randomUUID()],
      /ENVELOPE_IMMUTABLE/,
    );

    // 5. Late seal_complete outcome='failed' never overwrites a sealed envelope.
    await runtime.execute('sign.envelope.send', { envelopeId: mainEnv.envelopeId }, { actor: asUser(owner), orgId: regOrgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'UPDATE crove_sign.field SET signature_png_base64 = $3, filled_at = now() WHERE org_id = $1 AND envelope_id = $2',
        [regOrgId, mainEnv.envelopeId, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
      );
      await c.query("UPDATE crove_sign.signer SET status = 'signed', signed_at = now() WHERE org_id = $1 AND envelope_id = $2", [regOrgId, mainEnv.envelopeId]);
      await c.query("UPDATE crove_sign.envelope SET status = 'completed', completed_at = now() WHERE org_id = $1 AND id = $2", [regOrgId, mainEnv.envelopeId]);
      await c.query('COMMIT');
    });
    await expect(
      workerRuntime.execute(
        'sign.envelope.seal_complete',
        {
          envelopeId: mainEnv.envelopeId,
          outcome: 'sealed',
          certificateCode: 'CS-TEST-0000-0000',
          sealedFileId: sourceFileId,
          certificateFileId: sourceFileId,
        },
        { actor: SIGN_ACTOR, orgId: regOrgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SEALED_FILE', status: 422 });
    const sealDone = await runSignPdfSealJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId: regOrgId, envelopeId: mainEnv.envelopeId });
    expect(sealDone.status).toBe('sealed');

    const lateFail = await workerRuntime.execute<{ sealStatus: string; idempotent?: boolean; ignoredOutcome?: string }>(
      'sign.envelope.seal_complete',
      { envelopeId: mainEnv.envelopeId, outcome: 'failed', error: 'late timeout' },
      { actor: SIGN_ACTOR, orgId: regOrgId },
    );
    expect(lateFail).toMatchObject({ sealStatus: 'sealed', idempotent: true, ignoredOutcome: 'failed' });
    const sealedRow = await admin(async (c) =>
      (await c.query<{ seal_status: string; sealed_file_id: string | null }>('SELECT seal_status, sealed_file_id FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [regOrgId, mainEnv.envelopeId])).rows[0],
    );
    expect(sealedRow?.seal_status).toBe('sealed');
    expect(sealedRow?.sealed_file_id).toBeTruthy();

    // 6. ADR-0053: sweepSignPendingWork skips pending inspect work while sign is off and recovers it once turned back on.
    const pendingEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Pending Recovery', sourceFileId },
      { actor: asUser(owner), orgId: regOrgId },
    );
    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asUser(owner), orgId: regOrgId, idempotencyKey: randomUUID() });
    const offInspectIds: string[] = [];
    const offRecovered = await sweepSignPendingWork({
      workerDb,
      appOn: (id) => workerRuntime.appOn(id, 'sign', { fresh: true }),
      orgId: regOrgId,
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async (_orgId, envId) => {
        offInspectIds.push(envId);
      },
      enqueueSeal: async () => {},
    });
    expect(offRecovered).toEqual({ inspect: 0, seal: 0, caReconcile: 0 });
    expect(offInspectIds).toEqual([]);

    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asUser(owner), orgId: regOrgId, idempotencyKey: randomUUID() });
    const entitlementOffRecovered = await sweepSignPendingWork({
      workerDb,
      appOn: async () => false,
      orgId: regOrgId,
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async () => {},
      enqueueSeal: async () => {},
    });
    expect(entitlementOffRecovered).toEqual({ inspect: 0, seal: 0, caReconcile: 0 });
    const onInspectIds: string[] = [];
    const onRecovered = await sweepSignPendingWork({
      workerDb,
      appOn: (id) => workerRuntime.appOn(id, 'sign', { fresh: true }),
      orgId: regOrgId,
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async (_orgId, envId) => {
        onInspectIds.push(envId);
      },
      enqueueSeal: async () => {},
    });
    expect(onRecovered.inspect).toBeGreaterThanOrEqual(1);
    expect(onInspectIds).toContain(pendingEnv.envelopeId);

    // Unentitled org rows sorted earlier across page boundaries do not starve entitled orgs (#3323).
    const createdBlocked = await rpc('org/create', owner, { name: 'Sign Unentitled Org', idempotencyKey: randomUUID() }, null);
    expect(createdBlocked.status).toBe(200);
    const blockedOrgId = String(createdBlocked.body.orgId);
    const blockedSlug = String(createdBlocked.body.slug);
    const blockedUpload = await uploadFile(app, owner, pdfFixture('blocked-org'), 'blocked.pdf', 'sign_document', 'application/pdf', blockedSlug);
    expect(blockedUpload.status).toBe(200);
    const blockedFileId = ((blockedUpload.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;
    const blockedEnv1 = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Blocked Older 1', sourceFileId: blockedFileId },
      { actor: asUser(owner), orgId: blockedOrgId },
    );
    const blockedEnv2 = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Blocked Older 2', sourceFileId: blockedFileId },
      { actor: asUser(owner), orgId: blockedOrgId },
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        "UPDATE crove_sign.envelope SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE org_id = $1 AND id = ANY($2::uuid[])",
        [blockedOrgId, [blockedEnv1.envelopeId, blockedEnv2.envelopeId]],
      );
      await c.query('COMMIT');
    });
    const pagedInspectIds: string[] = [];
    let appOnCalls = 0;
    const pagedRecovered = await sweepSignPendingWork({
      workerDb,
      batchSize: 1,
      appOn: async (id) => {
        appOnCalls += 1;
        return id === regOrgId;
      },
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async (_orgId, envId) => {
        pagedInspectIds.push(envId);
      },
      enqueueSeal: async () => {},
    });
    expect(pagedRecovered).toEqual({ inspect: 1, seal: 0, caReconcile: 0 });
    expect(pagedInspectIds).toEqual([pendingEnv.envelopeId]);
    expect(appOnCalls).toBe(2);
    await expect(
      sql`SELECT 1 FROM crove_sign.work_recovery_candidates(now(), 10, NULL, now(), NULL, NULL)`.execute(workerDb),
    ).rejects.toMatchObject({ code: '22023' });

    // 7. Inbound email attaching a colliding sign_document PDF keeps the sign source as duplicate without failing valid attachments.
    const invoicePdf = pdfFixture('inbound-invoice');
    const invoiceSha = sha256Hex(invoicePdf);
    const invoiceKey = fileKey(regOrgId, invoiceSha);
    const invoiceGen = await store.put(invoiceKey, invoicePdf);
    const inbound = await workerRuntime.execute<{ duplicate: boolean; fileIds: string[] }>(
      'kernel.inbound.receive',
      {
        messageId: `<sign-colliding-${randomUUID()}@mail.test>`,
        from: 'sender@example.com',
        subject: 'Signed contract and invoice',
        files: [
          {
            filename: 'signed-copy.pdf',
            contentType: 'application/pdf',
            sizeBytes: pdfFixture('regressions').byteLength,
            sha256: meta.source_sha256,
            storageKey: meta.source_storage_key,
            generation: meta.source_generation,
            source: 'email',
          },
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            sizeBytes: invoicePdf.byteLength,
            sha256: invoiceSha,
            storageKey: invoiceKey,
            generation: invoiceGen,
            source: 'email',
          },
        ],
      },
      { actor: { type: 'system', component: 'inbound.email' }, orgId: regOrgId },
    );
    expect(inbound.duplicate).toBe(false);
    expect(inbound.fileIds).toHaveLength(2);
    const collidingRow = await admin(async (c) =>
      (await c.query<{ source: string }>('SELECT source FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [regOrgId, sourceFileId])).rows[0],
    );
    expect(collidingRow?.source).toBe('sign_document');
    const newInvoiceRow = await admin(async (c) =>
      (await c.query<{ source: string }>('SELECT source FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [regOrgId, inbound.fileIds[1]])).rows[0],
    );
    expect(newInvoiceRow?.source).toBe('email');

    const directConflict = await uploadFile(app, owner, pdfFixture('regressions'), 'conflict.pdf', 'document', 'application/pdf', regSlug);
    expect(directConflict.status).toBe(409);
    expect(directConflict.body?.code).toBe('FILE_SOURCE_CONFLICT');

    // Template PDF inspection via worker + pending template recovery sweep (#3526).
    const tplPdf = await uploadFile(app, owner, pdfFixture('tpl-worker-inspect'), 'tpl-worker.pdf', 'sign_document', 'application/pdf', regSlug);
    const tplFileId = ((tplPdf.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;
    const pendingTpl = await runtime.execute<{ templateId: string; inspectStatus: string }>(
      'sign.template.create',
      { title: 'Worker Template Inspect', sourceFileId: tplFileId },
      { actor: asUser(owner), orgId: regOrgId },
    );
    expect(pendingTpl.inspectStatus).toBe('pending');
    const recoveredTplIds: string[] = [];
    await sweepSignPendingWork({
      workerDb,
      batchSize: 1,
      appOn: (id) => workerRuntime.appOn(id, 'sign', { fresh: true }),
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async () => {},
      enqueueSeal: async () => {},
      enqueueTemplateInspect: async (_orgId, tplId) => {
        recoveredTplIds.push(tplId);
      },
    });
    expect(recoveredTplIds).toContain(pendingTpl.templateId);
    await expect(
      sql`SELECT 1 FROM crove_sign.template_work_recovery_candidates(now(), 10, NULL, now(), NULL, NULL)`.execute(workerDb),
    ).rejects.toMatchObject({ code: '22023' });
    const tplInspected = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract() },
      { orgId: regOrgId, targetKind: 'template', templateId: pendingTpl.templateId },
    );
    expect(tplInspected).toMatchObject({ status: 'passed' });
  });

  it('isolates per-org errors inside sweepSignExpire and sweepSignCleanup and processes due orgs in deterministic order (#3428 L4)', async () => {
    const firstCreated = await rpc('org/create', owner, { name: 'Sweep Isolation Org 1', idempotencyKey: randomUUID() }, null);
    const secondCreated = await rpc('org/create', owner, { name: 'Sweep Isolation Org 2', idempotencyKey: randomUUID() }, null);
    expect(firstCreated.status).toBe(200);
    expect(secondCreated.status).toBe(200);
    const sortedOrgs = [String(firstCreated.body.orgId), String(secondCreated.body.orgId)].sort();
    const org1Id = sortedOrgs[0]!;
    const org2Id = sortedOrgs[1]!;
    const slugOf = (id: string) => (id === String(firstCreated.body.orgId) ? String(firstCreated.body.slug) : String(secondCreated.body.slug));

    const seededTokens: Array<{ orgId: string; envelopeId: string; signerId: string; tokenId: string }> = [];
    for (const orgId of [org1Id, org2Id]) {
      const up = await uploadFile(app, owner, pdfFixture(`iso-${orgId}`), 'iso.pdf', 'sign_document', 'application/pdf', slugOf(orgId));
      expect(up.status).toBe(200);
      const fid = ((up.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;
      const env = await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title: 'Sweep Isolation Env', sourceFileId: fid, expiresAt: new Date(Date.now() + DAY_MS).toISOString() },
        { actor: asUser(owner), orgId },
      );
      await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract: mockExtract() }, { orgId, envelopeId: env.envelopeId });
      const s = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        { envelopeId: env.envelopeId, signerRole: 'signer', name: 'Iso Signer', email: `iso-${orgId.slice(0, 8)}@sign.test` },
        { actor: asUser(owner), orgId },
      );
      await runtime.execute(
        'sign.field.set',
        {
          envelopeId: env.envelopeId,
          fields: [{ signerId: s.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 }],
        },
        { actor: asUser(owner), orgId },
      );
      const sent = await runtime.execute<{ links: Array<{ tokenId: string }> }>(
        'sign.envelope.send',
        { envelopeId: env.envelopeId },
        { actor: asUser(owner), orgId },
      );
      seededTokens.push({ orgId, envelopeId: env.envelopeId, signerId: s.signerId, tokenId: sent.links[0]!.tokenId });
    }

    await admin(async (c) => {
      for (const item of seededTokens) {
        await c.query(
          "UPDATE crove_sign.envelope SET expires_at = now() - interval '5 minutes' WHERE org_id = $1 AND id = $2",
          [item.orgId, item.envelopeId],
        );
        await c.query(
          `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, created_at)
           VALUES ($1, $2, $3, 'iso-stale@sign.test', $4, now() - interval '30 hours', now() - interval '30 hours')`,
          [item.orgId, item.signerId, item.tokenId, sha256Hex(Buffer.from('111222'))],
        );
      }
    });

    const { rows: dueExpire } = await sql<{ org_id: string }>`
      SELECT org_id FROM crove_sign.expire_sweep_due_orgs(100)
    `.execute(workerDb);
    expect(dueExpire.map((r) => r.org_id)).toEqual([org1Id, org2Id]);

    const { rows: dueCleanup } = await sql<{ org_id: string }>`
      SELECT org_id FROM crove_sign.cleanup_due_orgs_secrets(${new Date(Date.now() - 24 * 3_600_000)}::timestamptz, ${new Date(Date.now() - 30 * DAY_MS)}::timestamptz, 100)
    `.execute(workerDb);
    expect(dueCleanup.map((r) => r.org_id)).toEqual([org1Id, org2Id]);

    const errors: string[] = [];
    const faultyFirstOrgRuntime = {
      execute: (command: string, input: unknown, opts: { actor: { type: 'system'; component: string }; orgId: string }) => {
        if (opts.orgId === org1Id) {
          return Promise.reject(new Error(`simulated failure for ${opts.orgId}`));
        }
        return workerRuntime.execute(command, input, opts);
      },
    } as unknown as Runtime;

    const expired = await sweepSignExpire({
      workerDb,
      runtime: faultyFirstOrgRuntime,
      log: { error: (...args) => errors.push(args.map(String).join(' ')) },
    });
    expect(expired).toBe(1);
    expect(errors.some((e) => e.includes('[sign-expire-sweep]') && e.includes(org1Id.slice(0, 8)))).toBe(true);
    expect(errors.every((e) => !e.includes('simulated failure'))).toBe(true);

    const cleaned = await sweepSignCleanup({
      workerDb,
      runtime: faultyFirstOrgRuntime,
      log: { error: (...args) => errors.push(args.map(String).join(' ')) },
    });
    expect(cleaned.orgs).toBe(1);
    expect(cleaned.otps).toBe(1);
    expect(errors.some((e) => e.includes('[sign-cleanup]') && e.includes(org1Id.slice(0, 8)))).toBe(true);
    expect(errors.every((e) => !e.includes('simulated failure'))).toBe(true);

    const orgStatuses = await admin(async (c) => ({
      env1: (await c.query<{ status: string }>('SELECT status FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [org1Id, seededTokens[0]!.envelopeId])).rows[0]?.status,
      env2: (await c.query<{ status: string }>('SELECT status FROM crove_sign.envelope WHERE org_id = $1 AND id = $2', [org2Id, seededTokens[1]!.envelopeId])).rows[0]?.status,
      otp1: Number((await c.query('SELECT count(*) AS n FROM crove_sign.signing_otp WHERE org_id = $1', [org1Id])).rows[0].n),
      otp2: Number((await c.query('SELECT count(*) AS n FROM crove_sign.signing_otp WHERE org_id = $1', [org2Id])).rows[0].n),
    }));
    expect(orgStatuses.env1).toBe('sent');
    expect(orgStatuses.env2).toBe('expired');
    expect(orgStatuses.otp1).toBe(1);
    expect(orgStatuses.otp2).toBe(0);

    // Also verify sweepSignPendingWork isolates per-org enqueue/appOn errors (#3428 L4).
    const pendingIds: Array<{ orgId: string; envelopeId: string }> = [];
    for (const orgId of [org1Id, org2Id]) {
      const up = await uploadFile(app, owner, pdfFixture(`pend-${orgId}`), 'pend.pdf', 'sign_document', 'application/pdf', slugOf(orgId));
      const fid = ((up.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;
      const env = await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title: 'Pending Recovery Isolation', sourceFileId: fid },
        { actor: asUser(owner), orgId },
      );
      await admin(async (c) => {
        await c.query("UPDATE crove_sign.envelope SET updated_at = now() - interval '5 minutes' WHERE org_id = $1 AND id = $2", [orgId, env.envelopeId]);
      });
      pendingIds.push({ orgId, envelopeId: env.envelopeId });
    }
    const enqueuedInspects: string[] = [];
    const pendingErrors: string[] = [];
    const pendingRes = await sweepSignPendingWork({
      workerDb,
      olderThan: new Date(Date.now() - 60_000),
      enqueueInspect: async (orgId, envId) => {
        if (orgId === org1Id) throw new Error('simulated queue outage');
        enqueuedInspects.push(envId);
      },
      enqueueSeal: async () => {},
      log: { error: (...args) => pendingErrors.push(args.map(String).join(' ')) },
    });
    expect(pendingRes.inspect).toBeGreaterThanOrEqual(1);
    expect(enqueuedInspects).toContain(pendingIds[1]!.envelopeId);
    expect(pendingErrors.some((e) => e.includes('[sign-pending-work]') && e.includes(org1Id.slice(0, 8)))).toBe(true);
    expect(pendingErrors.every((e) => !e.includes('simulated queue outage'))).toBe(true);
  });

  it('completes end-to-end Approver HTTP ceremony, sequential approver invite copy, and sealed completion mail attachments (#3528)', async () => {
    const approverOwner: Account = { subject: randomUUID(), email: 'approver-owner@sign.test', session: randomUUID(), userId: '' };
    const me = await rpc('me/get', approverOwner, undefined, null);
    expect(me.status).toBe(200);
    approverOwner.userId = String(me.body.userId);

    const createdOrg = await rpc('org/create', approverOwner, { name: 'Approver E2E Org', idempotencyKey: randomUUID() }, null);
    expect(createdOrg.status).toBe(200);
    const e2eOrgId = String(createdOrg.body.orgId);
    const e2eOrgSlug = String(createdOrg.body.slug);

    const up = await uploadFile(app, approverOwner, pdfFixture('approver-e2e'), 'approver-contract.pdf', 'sign_document', 'application/pdf', e2eOrgSlug);
    expect(up.status).toBe(200);
    const sourceFileId = ((up.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    const env = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Quyet dinh phe duyet ngan sach',
        routingMode: 'sequential',
        sourceFileId,
        message: 'Nho anh chi xem xet va phe duyet.',
      },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract() },
      { orgId: e2eOrgId, envelopeId: env.envelopeId },
    );

    const approver1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: env.envelopeId,
        routingOrder: 1,
        signerRole: 'approver',
        roleLabel: 'Ke toan truong',
        name: 'Tran Thi Binh',
        email: 'approver1@sign.test',
        deliveryMode: 'email',
      },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    const approver2 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: env.envelopeId,
        routingOrder: 2,
        signerRole: 'approver',
        roleLabel: 'Giam doc',
        name: 'Nguyen Van Cuong',
        email: 'approver2@sign.test',
        deliveryMode: 'email',
      },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );

    // Optional text field for approver1 and zero fields for approver2 (no signature fields for either).
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: env.envelopeId,
        fields: [
          {
            signerId: approver1.signerId,
            fieldType: 'text',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.3,
            hNorm: 0.05,
            label: 'Ghi chu duyet',
            required: false,
          },
        ],
      },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );

    await runtime.execute(
      'sign.envelope.send',
      { envelopeId: env.envelopeId },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );

    const renderMailForSource = async (
      templateKey: string,
      sourceId: string,
    ) => {
      const row = await admin(async (c) =>
        (
          await c.query<{
            id: string;
            subject: string;
            payload: Readonly<Record<string, unknown>>;
          }>(
            'SELECT id, subject, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND template_key = $2 AND source_id = $3 ORDER BY created_at DESC LIMIT 1',
            [e2eOrgId, templateKey, sourceId],
          )
        ).rows[0],
      );
      expect(row).toBeDefined();
      return signMailTemplates[templateKey]!.render({
        messageId: row!.id,
        subject: row!.subject,
        payload: row!.payload,
        publicUrl: 'https://app.example.test',
        inboundAddress: null,
        brand: 'Ludy',
        store,
        execute: (cmd, cmdPayload) =>
          workerRuntime.execute(cmd, cmdPayload, {
            actor: { type: 'system', component: 'mail' },
            orgId: e2eOrgId,
          }),
      });
    };

    const extractTokenFromMailText = (text: string): string => {
      const match = /#([A-Za-z0-9_-]{32,})/.exec(text);
      expect(match?.[1]).toBeTruthy();
      return match![1]!;
    };

    // 1. Direct invite queued for Approver 1 renders approver subject and wording.
    const mail1 = await renderMailForSource(SIGN_INVITE_MAIL_TEMPLATE, approver1.signerId);
    expect(mail1?.subject).toBe('Moi duyet: Quyet dinh phe duyet ngan sach');
    expect(mail1?.text).toContain('xem va phe duyet tai lieu');
    const token1 = extractTokenFromMailText(mail1!.text);

    // 1b. Reminder email for Approver 1 queues 'Nhac duyet:' and rotates the active signing token cleanly.
    await runtime.execute(
      'sign.envelope.remind',
      { envelopeId: env.envelopeId, signerId: approver1.signerId },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    const remindMail1 = await renderMailForSource(SIGN_REMIND_MAIL_TEMPLATE, approver1.signerId);
    expect(remindMail1?.subject).toBe('Nhac duyet: Quyet dinh phe duyet ngan sach');
    expect(remindMail1?.text).toContain('nhac ban phe duyet tai lieu');
    const activeToken1 = extractTokenFromMailText(remindMail1!.text);
    expect(activeToken1).not.toBe(token1);

    // 2. POST /api/sign/view returns signerRole: 'approver' and non-signature field for the active reminder token.
    const view1Res = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.55', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({ token: activeToken1 }),
    });
    expect(view1Res.status).toBe(200);
    const view1Body = (await view1Res.json()) as {
      state: string;
      signerRole?: string;
      fields?: Array<{ id: string; fieldType: string }>;
    };
    expect(view1Body.state).toBe('ready');
    expect(view1Body.signerRole).toBe('approver');
    expect(view1Body.fields?.map((f) => f.fieldType)).toEqual(['text']);
    const noteFieldId = view1Body.fields![0]!.id;

    // 3. POST /api/sign/submit accepts approver submission with zero signatureKind and optional text note.
    const submit1Res = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.55', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({
        token: activeToken1,
        consentAccepted: true,
        fields: [{ fieldId: noteFieldId, valueText: 'Da kiem tra du toan' }],
      }),
    });
    expect(submit1Res.status).toBe(200);

    // 4. Sequential advancement queued step 2 (Approver 2); rendering rewrites SQL subject and uses approver wording.
    const mail2 = await renderMailForSource(SIGN_INVITE_MAIL_TEMPLATE, approver2.signerId);
    expect(mail2?.subject).toBe('Moi duyet: Quyet dinh phe duyet ngan sach');
    expect(mail2?.text).toContain('xem va phe duyet tai lieu');
    const token2 = extractTokenFromMailText(mail2!.text);

    const view2Res = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.56', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({ token: token2 }),
    });
    expect(view2Res.status).toBe(200);
    const view2Body = (await view2Res.json()) as { state: string; signerRole?: string; fields?: unknown[] };
    expect(view2Body.state).toBe('ready');
    expect(view2Body.signerRole).toBe('approver');
    expect(view2Body.fields).toEqual([]);

    // Approver 2 submits cleanly with 0 fields and no signatureKind.
    const submit2Res = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.56', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({
        token: token2,
        consentAccepted: true,
        fields: [],
      }),
    });
    expect(submit2Res.status).toBe(200);

    // 5. Seal the completed envelope and verify completion mail attaches sealed PDF and audit certificate JSON.
    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract() },
      { orgId: e2eOrgId, envelopeId: env.envelopeId },
    );

    const completedMail = await renderMailForSource(SIGN_COMPLETED_MAIL_TEMPLATE, env.envelopeId);
    expect(completedMail).not.toBeNull();
    expect(completedMail?.attachments?.map((a) => [a.filename, a.contentType])).toEqual([
      ['tai-lieu-da-niem-phong.pdf', 'application/pdf'],
      ['chung-thu-kiem-toan.json', 'application/json'],
    ]);
    expect(completedMail?.text).toContain('duoc dinh kem trong email nay');

    // 6. Approver can decline via POST /api/sign/decline and reject subsequent view cleanly.
    const declineEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Ho so tu choi duyet', sourceFileId },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract() },
      { orgId: e2eOrgId, envelopeId: declineEnv.envelopeId },
    );
    await runtime.execute(
      'sign.signer.add',
      {
        envelopeId: declineEnv.envelopeId,
        signerRole: 'approver',
        roleLabel: 'Kiem soat noi bo',
        name: 'Pham Thi D',
        email: 'approver-decline@sign.test',
        deliveryMode: 'link',
      },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    const declineSent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: declineEnv.envelopeId },
      { actor: asUser(approverOwner), orgId: e2eOrgId },
    );
    const declineToken = declineSent.links[0]!.token;
    const declineRes = await app.request('/api/sign/decline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.57', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({ token: declineToken, reason: 'Chua du ho so kem theo' }),
    });
    expect(declineRes.status).toBe(200);
    const afterDeclineView = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.57', 'user-agent': 'ApproverTest/1.0' },
      body: JSON.stringify({ token: declineToken }),
    });
    expect(afterDeclineView.status).toBe(404);
  });

  it('forwards detectedTags from runSignPdfInspectJob to envelope and template inspect_complete (#3552)', async () => {
    const tagOwner: Account = { subject: randomUUID(), email: 'tag-owner@sign.test', session: randomUUID(), userId: '' };
    const me = await rpc('me/get', tagOwner, undefined, null);
    expect(me.status).toBe(200);
    tagOwner.userId = String(me.body.userId);

    const createdOrg = await rpc('org/create', tagOwner, { name: 'Tag Worker Org', idempotencyKey: randomUUID() }, null);
    expect(createdOrg.status).toBe(200);
    const tagOrgId = String(createdOrg.body.orgId);
    const tagOrgSlug = String(createdOrg.body.slug);

    const up = await uploadFile(app, tagOwner, pdfFixture('worker-tags-3552'), 'tags-3552.pdf', 'sign_document', 'application/pdf', tagOrgSlug);
    expect(up.status).toBe(200);
    const sourceFileId = ((up.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    const sampleDetectedTags = [
      {
        pageNumber: 1,
        fieldType: 'signature' as const,
        roleOrder: 1,
        roleKey: 'r1',
        required: true,
        label: null,
        xNorm: 0.2,
        yNorm: 0.7,
        wNorm: 0.22,
        hNorm: 0.06,
      },
      {
        pageNumber: 1,
        fieldType: 'date' as const,
        roleOrder: 1,
        roleKey: 'r1',
        required: true,
        label: null,
        xNorm: 0.5,
        yNorm: 0.71,
        wNorm: 0.16,
        hNorm: 0.03,
      },
    ];

    const extractWithTags: ExtractClient = {
      async extract(kind) {
        if (kind === 'pdf_inspect') {
          return {
            ok: true,
            kind: 'pdf_inspect',
            pageCount: 1,
            pages: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0, text: '{{signature, r1}} {{date, r1}}' }],
            detectedTags: sampleDetectedTags,
          } as never;
        }
        throw new Error(`unexpected kind ${kind}`);
      },
    };

    const env = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Ho so co the PDF', sourceFileId },
      { actor: asUser(tagOwner), orgId: tagOrgId },
    );
    const envRes = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: extractWithTags },
      { orgId: tagOrgId, envelopeId: env.envelopeId },
    );
    expect(envRes).toEqual({ status: 'passed', pageCount: 1 });

    const fetchedEnv = await runtime.query<{ envelope: { detectedTags: typeof sampleDetectedTags } }>(
      'sign.envelope.get',
      { envelopeId: env.envelopeId },
      { actor: asUser(tagOwner), orgId: tagOrgId },
    );
    expect(fetchedEnv.envelope.detectedTags).toEqual(sampleDetectedTags);

    const upTpl = await uploadFile(app, tagOwner, pdfFixture('worker-tpl-tags-3552'), 'tpl-tags-3552.pdf', 'sign_document', 'application/pdf', tagOrgSlug);
    expect(upTpl.status).toBe(200);
    const tplFileId = ((upTpl.body?.files as Array<{ fileId: string }>) ?? [])[0]!.fileId;

    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau co the PDF', routingMode: 'parallel', sourceFileId: tplFileId },
      { actor: asUser(tagOwner), orgId: tagOrgId },
    );
    const tplRes = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: extractWithTags },
      { orgId: tagOrgId, targetKind: 'template', templateId: tpl.templateId },
    );
    expect(tplRes).toEqual({ status: 'passed', pageCount: 1 });

    const fetchedTpl = await runtime.query<{ template: { detectedTags: typeof sampleDetectedTags } }>(
      'sign.template.get',
      { templateId: tpl.templateId },
      { actor: asUser(tagOwner), orgId: tagOrgId },
    );
    expect(fetchedTpl.template.detectedTags).toEqual(sampleDetectedTags);
  });
});
