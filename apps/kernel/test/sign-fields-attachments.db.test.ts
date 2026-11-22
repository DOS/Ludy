// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 + HTTP integration tests for eSign Slice 4b (#3818):
// 1) dropdown & radio choice fields (1..50 unique options, template + direct-link propagation, unlisted choice 422 rejection).
// 2) POST /api/sign/attachment verified upload (PDF/PNG/JPEG magic-byte + structure check, <= 10 MB cap, SVG/HTML/ZIP/EXE
//    rejection, query-token refusal, opaque 404 across invalid/expired/waiting/MODULE_OFF, OTP gate 403 SIGN_OTP_REQUIRED,
//    rate/concurrency limits, isolated source = 'sign_attachment' never sent to Finance OCR, attachment_uploaded hash chain).
// 3) PDF sealing (dropdown + radio + Audit Certificate SHA-256), attachment download CSP/Content-Disposition headers,
//    hr_contract confidentiality (owner/admin/creator only; 404 for ordinary members/viewers even when MODULE_OFF),
//    and crove_sign.field_guard() tamper protection.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { decodePdfSealInput, type ExtractClient, type PdfSealInput } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, fileKey, putFile, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { SIGN_ACTOR, runSignPdfSealJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_TEST_KEY = 'x'.repeat(32);
const ISSUER = 'crove-auth';

const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_BYTES = new Uint8Array(Buffer.from(VALID_PNG_BASE64, 'base64'));
const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9,
]);

const pdfFixture = (tag: string) =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-4b-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

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

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 4b: choice fields & verified signer supporting attachments on PG17 (#3818)', () => {
  const dbName = `crove_test_sign_4b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@example.com', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@example.com', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
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
      .sign(new TextEncoder().encode(JWT_TEST_KEY));
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

  async function ingestSignPdf(orgId: string, who: Account, tag: string): Promise<string> {
    const bytes = pdfFixture(tag);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, 'application/pdf', sha256);
    const res = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source: 'sign_document',
      },
      { actor: asUser(who), orgId, idempotencyKey: randomUUID() },
    );
    return res.fileId;
  }

  function mockExtract(capturedSealInputs: PdfSealInput[]): ExtractClient {
    return {
      async extract(kind, bytes) {
        if (kind === 'pdf_seal') {
          const decoded = decodePdfSealInput(bytes);
          capturedSealInputs.push(decoded);
          return {
            ok: true,
            kind: 'pdf_seal',
            sealedPdfBase64: Buffer.from(
              `%PDF-1.4\n%sealed-${decoded.certificate.certificateCode}\n%%EOF\n`,
              'utf8',
            ).toString('base64'),
            pageCount: 2,
          } as never;
        }
        throw new Error(`unexpected extract kind: ${kind}`);
      },
    };
  }

  async function postMultipartAttachment(
    targetApp: ReturnType<typeof createHttpApp>,
    params: { token?: string; fieldId?: string; bytes?: Uint8Array; filename?: string; mime?: string; queryToken?: string },
  ) {
    const form = new FormData();
    if (params.token !== undefined) form.set('token', params.token);
    if (params.fieldId !== undefined) form.set('fieldId', params.fieldId);
    if (params.bytes !== undefined) {
      form.set(
        'file',
        new File([Buffer.from(params.bytes)], params.filename ?? 'attachment.pdf', {
          type: params.mime ?? 'application/pdf',
        }),
      );
    }
    const url = params.queryToken ? `/api/sign/attachment?token=${encodeURIComponent(params.queryToken)}` : '/api/sign/attachment';
    return targetApp.request(url, { method: 'POST', body: form });
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

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('ludy_app', 'test-app-pw');
    workerUrl = login('ludy_worker', 'test-worker-pw');
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
    runtime.validate();

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...financeCommands, ...signCommands],
      queries: sharedQueries,
    });
    workerRuntime.validate();

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_TEST_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, otherMember, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sao Mai Co', idempotencyKey: randomUUID() }, null);
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

    const other = await rpc('org/create', outsider, { name: 'Outside Co', idempotencyKey: randomUUID() }, null);
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

  it('validates dropdown/radio options, enforces attachment upload security, seals SHA-256 into certificate, and isolates from Finance OCR', async () => {
    const sourceFileId = await ingestSignPdf(org.orgId, member, 'agency-contract');
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Hợp đồng đại lý 2026',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceFileId,
      },
      { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [
          {
            pageNumber: 1,
            fieldType: 'dropdown',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: 'Kỳ hạn',
            options: ['12 tháng', '24 tháng'],
            xNorm: 0.1,
            yNorm: 0.2,
            wNorm: 0.24,
            hNorm: 0.05,
          },
        ],
      },
      { actor: SIGN_ACTOR, orgId: org.orgId },
    );

    const signerAdded = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: created.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Bên B',
        name: 'Trần Thị B',
        email: 'signer@example.com',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Reject empty/duplicate options on dropdown/radio and reject options on non-choice fields.
    await expect(
      runtime.execute(
        'sign.field.set',
        {
          envelopeId: created.envelopeId,
          fields: [
            {
              signerId: signerAdded.signerId,
              fieldType: 'dropdown',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.24,
              hNorm: 0.05,
              required: true,
              proposedByAi: false,
              options: [],
            },
          ],
        },
        { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    await expect(
      runtime.execute(
        'sign.field.set',
        {
          envelopeId: created.envelopeId,
          fields: [
            {
              signerId: signerAdded.signerId,
              fieldType: 'text',
              pageNumber: 1,
              xNorm: 0.1,
              yNorm: 0.2,
              wNorm: 0.24,
              hNorm: 0.05,
              required: true,
              proposedByAi: false,
              options: ['NotAllowed'],
            },
          ],
        },
        { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    // Reject user attempts to ingest source = 'sign_attachment' directly via kernel.file.ingest.
    const fakeAttBytes = pdfFixture('forged-ingest');
    const fakeAttSha = sha256Hex(fakeAttBytes);
    await expect(
      runtime.execute(
        'kernel.file.ingest',
        {
          filename: 'forged.pdf',
          contentType: 'application/pdf',
          sizeBytes: fakeAttBytes.byteLength,
          sha256: fakeAttSha,
          storageKey: fileKey(org.orgId, fakeAttSha),
          generation: `content:${fakeAttSha}`,
          source: 'sign_attachment',
        },
        { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const setRes = await runtime.execute<{ fieldIds: string[] }>(
      'sign.field.set',
      {
        envelopeId: created.envelopeId,
        fields: [
          {
            signerId: signerAdded.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.72,
            wNorm: 0.24,
            hNorm: 0.08,
            label: 'Chữ ký Bên B',
            required: true,
            proposedByAi: false,
          },
          {
            signerId: signerAdded.signerId,
            fieldType: 'dropdown',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.25,
            wNorm: 0.24,
            hNorm: 0.05,
            label: 'Phương thức thanh toán',
            required: true,
            proposedByAi: false,
            options: ['Chuyển khoản ngân hàng', 'Tiền mặt'],
          },
          {
            signerId: signerAdded.signerId,
            fieldType: 'radio',
            pageNumber: 1,
            xNorm: 0.45,
            yNorm: 0.25,
            wNorm: 0.2,
            hNorm: 0.04,
            label: 'Cam kết bảo mật',
            required: true,
            proposedByAi: false,
            options: ['Đồng ý điều khoản', 'Không áp dụng'],
          },
          {
            signerId: signerAdded.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.42,
            wNorm: 0.26,
            hNorm: 0.06,
            label: 'Giấy ĐKKD',
            required: true,
            proposedByAi: false,
          },
        ],
      },
      { actor: asUser(member), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(setRes.fieldIds).toHaveLength(4);

    const sent = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    const signingToken = sent.links[0]!.token;

    const viewRes = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: signingToken }),
    });
    expect(viewRes.status).toBe(200);
    const viewBody = (await viewRes.json()) as {
      state: string;
      fields: Array<{ id: string; fieldType: string; options: string[] | null; attachment: unknown }>;
    };
    expect(viewBody.state).toBe('ready');
    const sigField = viewBody.fields.find((f) => f.fieldType === 'signature')!;
    const ddField = viewBody.fields.find((f) => f.fieldType === 'dropdown')!;
    const radioField = viewBody.fields.find((f) => f.fieldType === 'radio')!;
    const attField = viewBody.fields.find((f) => f.fieldType === 'attachment')!;
    expect(ddField.options).toEqual(['Chuyển khoản ngân hàng', 'Tiền mặt']);
    expect(radioField.options).toEqual(['Đồng ý điều khoản', 'Không áp dụng']);
    expect(attField.attachment).toBeNull();

    // Query-string token is rejected with 400.
    const queryTokRes = await postMultipartAttachment(app, { queryToken: signingToken });
    expect(queryTokRes.status).toBe(400);
    expect(((await queryTokRes.json()) as { code: string }).code).toBe('SIGN_QUERY_TOKEN_FORBIDDEN');

    // Unknown token returns opaque 404 with security headers.
    const badTokRes = await postMultipartAttachment(app, {
      token: 'Z'.repeat(43),
      fieldId: attField.id,
      bytes: pdfFixture('unknown-tok'),
    });
    expect(badTokRes.status).toBe(404);
    expect(badTokRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(badTokRes.headers.get('cache-control')).toBe('no-store');
    expect(badTokRes.headers.get('x-content-type-options')).toBe('nosniff');

    // Non-attachment fieldId returns 422 SIGN_INVALID_FIELD.
    const wrongFieldRes = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: ddField.id,
      bytes: pdfFixture('wrong-field'),
    });
    expect(wrongFieldRes.status).toBe(422);
    expect(((await wrongFieldRes.json()) as { code: string }).code).toBe('SIGN_INVALID_FIELD');

    // Active-content SVG/HTML/ZIP and > 10 MB uploads are strictly rejected.
    const svgRes = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      filename: 'evil.pdf',
      mime: 'application/pdf',
    });
    expect(svgRes.status).toBe(415);
    expect(((await svgRes.json()) as { code: string }).code).toBe('UNSUPPORTED_TYPE');

    const htmlRes = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: new TextEncoder().encode('<!doctype html><html><body>xss</body></html>'),
      filename: 'evil.png',
      mime: 'image/png',
    });
    expect(htmlRes.status).toBe(415);

    const overTenMb = new Uint8Array(10 * 1024 * 1024 + 64);
    overTenMb.set(pdfFixture('oversize'), 0);
    const oversizeRes = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: overTenMb,
      filename: 'huge.pdf',
    });
    expect(oversizeRes.status).toBe(413);
    expect(((await oversizeRes.json()) as { code: string }).code).toBe('TOO_LARGE');

    // Submitting before uploading required attachment fails with 422 SIGN_ATTACHMENT_REQUIRED without consuming token!
    const missingAttSubmit = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: signingToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [
          { fieldId: sigField.id, signaturePngBase64: VALID_PNG_BASE64 },
          { fieldId: ddField.id, valueText: 'Chuyển khoản ngân hàng' },
          { fieldId: radioField.id, valueText: 'Đồng ý điều khoản' },
          { fieldId: attField.id },
        ],
      }),
    });
    expect(missingAttSubmit.status).toBe(422);
    expect(((await missingAttSubmit.json()) as { code: string }).code).toBe('SIGN_ATTACHMENT_REQUIRED');

    // Valid PNG and JPEG uploads succeed, and final PDF replacement records the PDF's SHA-256!
    const pngUpload = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: VALID_PNG_BYTES,
      filename: 'cccd-mat-truoc.png',
      mime: 'image/png',
    });
    expect(pngUpload.status).toBe(200);
    const supersededPngMeta = (await pngUpload.json()) as { fileId: string };

    const jpegUpload = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: VALID_JPEG_BYTES,
      filename: 'cccd-mat-sau.jpg',
      mime: 'image/jpeg',
    });
    expect(jpegUpload.status).toBe(200);

    const dkkdBytes = pdfFixture('giay-dkkd-2026');
    const dkkdSha = sha256Hex(dkkdBytes);
    const pdfUpload = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: dkkdBytes,
      filename: 'giay-dkkd-2026.pdf',
      mime: 'application/pdf',
    });
    expect(pdfUpload.status).toBe(200);
    const uploadedMeta = (await pdfUpload.json()) as {
      fieldId: string;
      fileId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    };
    expect(uploadedMeta).toMatchObject({
      fieldId: attField.id,
      filename: 'giay-dkkd-2026.pdf',
      contentType: 'application/pdf',
      sizeBytes: dkkdBytes.byteLength,
      sha256: dkkdSha,
    });

    // Verify source = 'sign_attachment' and ZERO Finance extraction / outbox ingestion side effects!
    const dbFileCheck = await withAdmin(async (c) => {
      const fRow = (
        await c.query<{ source: string; created_by: string | null }>(
          'SELECT source, created_by FROM ludy_kernel.file WHERE org_id = $1 AND id = $2',
          [org.orgId, uploadedMeta.fileId],
        )
      ).rows[0];
      const outboxIngested = Number(
        (
          await c.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.ingested'",
            [org.orgId],
          )
        ).rows[0]!.n,
      );
      const extractions = Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM ludy_kernel.extraction WHERE org_id = $1 AND file_id = $2',
            [org.orgId, uploadedMeta.fileId],
          )
        ).rows[0]!.n,
      );
      return { fRow, outboxIngested, extractions };
    });
    expect(dbFileCheck.fRow).toEqual({ source: 'sign_attachment', created_by: null });
    expect(dbFileCheck.outboxIngested).toBe(0);
    expect(dbFileCheck.extractions).toBe(0);

    // Submitting an unlisted dropdown option fails with 422 SIGN_INVALID_FIELD_OPTION without consuming token!
    const badOptionSubmit = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: signingToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [
          { fieldId: sigField.id, signaturePngBase64: VALID_PNG_BASE64 },
          { fieldId: ddField.id, valueText: 'Bitcoin' },
          { fieldId: radioField.id, valueText: 'Đồng ý điều khoản' },
          { fieldId: attField.id },
        ],
      }),
    });
    expect(badOptionSubmit.status).toBe(422);
    expect(((await badOptionSubmit.json()) as { code: string }).code).toBe('SIGN_INVALID_FIELD_OPTION');

    // Valid submit succeeds and consumes the single-use signing token!
    const okSubmit = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: signingToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [
          { fieldId: sigField.id, signaturePngBase64: VALID_PNG_BASE64 },
          { fieldId: ddField.id, valueText: 'Chuyển khoản ngân hàng' },
          { fieldId: radioField.id, valueText: 'Đồng ý điều khoản' },
          { fieldId: attField.id },
        ],
      }),
    });
    expect(okSubmit.status).toBe(200);
    expect(await okSubmit.json()).toMatchObject({ completed: true, envelopeStatus: 'completed' });

    // Replaying attachment upload after submit returns 409 SIGN_ALREADY_SUBMITTED.
    const replayAtt = await postMultipartAttachment(app, {
      token: signingToken,
      fieldId: attField.id,
      bytes: dkkdBytes,
    });
    expect(replayAtt.status).toBe(409);
    expect(((await replayAtt.json()) as { code: string }).code).toBe('SIGN_ALREADY_SUBMITTED');

    // Run PDF seal job and verify dropdown, radio, and Audit Certificate attachment SHA-256!
    const capturedSeals: PdfSealInput[] = [];
    const sealOutcome = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract(capturedSeals) },
      { orgId: org.orgId, envelopeId: created.envelopeId },
    );
    expect(sealOutcome.status).toBe('sealed');
    expect(capturedSeals).toHaveLength(1);
    expect(capturedSeals[0]!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dropdown', text: 'Chuyển khoản ngân hàng' }),
        expect.objectContaining({ type: 'radio', text: 'Đồng ý điều khoản', checked: true }),
      ]),
    );
    expect(capturedSeals[0]!.certificate.signers[0]?.attachments).toEqual([
      {
        label: 'Giấy ĐKKD',
        filename: 'giay-dkkd-2026.pdf',
        sha256: dkkdSha,
      },
    ]);

    // Verify hash chain (including attachment_uploaded events) and canonical certificate JSON!
    const verified = await runtime.query<{ valid: boolean; eventChain: { count: number } }>(
      'sign.envelope.verify',
      { envelopeId: created.envelopeId },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(verified.valid).toBe(true);
    expect(verified.eventChain.count).toBeGreaterThanOrEqual(7);

    // Download supporting attachment via GET /api/files/:id -> Content-Disposition: attachment + sandbox CSP!
    const downloadRes = await app.request(`/api/files/${uploadedMeta.fileId}`, {
      headers: {
        authorization: `Bearer ${await tokenFor(member)}`,
        'x-crove-org': org.slug,
      },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-disposition')).toContain('attachment;');
    expect(downloadRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(downloadRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sha256Hex(new Uint8Array(await downloadRes.arrayBuffer()))).toBe(dkkdSha);

    // Superseded attachment upload (no longer referenced by any field row) gets 404 even for owner.
    const supersededDownload = await app.request(`/api/files/${supersededPngMeta.fileId}`, {
      headers: {
        authorization: `Bearer ${await tokenFor(owner)}`,
        'x-crove-org': org.slug,
      },
    });
    expect(supersededDownload.status).toBe(404);

    // Cross-tenant access gets 404.
    const crossTenantDownload = await app.request(`/api/files/${uploadedMeta.fileId}`, {
      headers: {
        authorization: `Bearer ${await tokenFor(outsider)}`,
        'x-crove-org': otherOrg.slug,
      },
    });
    expect(crossTenantDownload.status).toBe(404);
  });

  it('enforces OTP gate, rate/concurrency limits, direct-link choice options, hr_contract attachment confidentiality, and field_guard', async () => {
    // 1. Template + direct link preserves dropdown/radio options and attachment fields!
    const tplPdfId = await ingestSignPdf(org.orgId, owner, 'tpl-choice');
    const tplCreated = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      {
        title: 'Mẫu đăng ký đại lý',
        routingMode: 'parallel',
        sourceFileId: tplPdfId,
      },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tplCreated.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: org.orgId },
    );
    const rolesSet = await runtime.execute<{ roles: Array<{ id: string }> }>(
      'sign.template.roles_set',
      {
        templateId: tplCreated.templateId,
        roles: [
          {
            roleKey: 'applicant',
            signerRole: 'signer',
            roleLabel: 'Người đăng ký',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tplCreated.templateId,
        fields: [
          {
            templateRoleId: rolesSet.roles[0]!.id,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
          },
          {
            templateRoleId: rolesSet.roles[0]!.id,
            fieldType: 'dropdown',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.3,
            wNorm: 0.24,
            hNorm: 0.05,
            label: 'Khu vực',
            required: true,
            options: ['Miền Bắc', 'Miền Trung', 'Miền Nam'],
          },
          {
            templateRoleId: rolesSet.roles[0]!.id,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.45,
            wNorm: 0.26,
            hNorm: 0.06,
            label: 'CCCD',
            required: true,
          },
        ],
      },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: tplCreated.templateId, status: 'active' },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const dLink = await runtime.execute<{ token: string }>(
      'sign.template.direct_link_set',
      { templateId: tplCreated.templateId, enabled: true },
      { actor: asUser(owner), orgId: org.orgId },
    );

    const directStartRes = await app.request('/api/sign/direct/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: dLink.token, name: 'Lê Minh C' }),
    });
    expect(directStartRes.status).toBe(200);
    const { signingToken: directSigningToken } = (await directStartRes.json()) as { signingToken: string };

    const directViewRes = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: directSigningToken }),
    });
    expect(directViewRes.status).toBe(200);
    const directView = (await directViewRes.json()) as {
      fields: Array<{ id: string; fieldType: string; options: string[] | null }>;
    };
    expect(directView.fields.find((f) => f.fieldType === 'dropdown')?.options).toEqual([
      'Miền Bắc',
      'Miền Trung',
      'Miền Nam',
    ]);

    // 2. hr_contract envelope + OTP gate + confidentiality + MODULE_OFF opaque 404!
    const hrPdfId = await ingestSignPdf(org.orgId, adminUser, 'hr-offer-2026');
    const hrEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Hợp đồng lao động nhân sự',
        routingMode: 'parallel',
        sourceKind: 'hr_contract',
        sourceId: randomUUID(),
        sourceFileId: hrPdfId,
      },
      { actor: asUser(adminUser), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: hrEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: SIGN_ACTOR, orgId: org.orgId },
    );
    const otpSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: hrEnv.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        name: 'Ứng viên D',
        email: 'candidate@example.com',
        deliveryMode: 'email',
        requireEmailOtp: true,
      },
      { actor: asUser(adminUser), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: hrEnv.envelopeId,
        fields: [
          {
            signerId: otpSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.24,
            hNorm: 0.08,
            required: true,
            proposedByAi: false,
          },
          {
            signerId: otpSigner.signerId,
            fieldType: 'attachment',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.4,
            wNorm: 0.26,
            hNorm: 0.06,
            label: 'CCCD ứng viên',
            required: true,
            proposedByAi: false,
          },
        ],
      },
      { actor: asUser(adminUser), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const hrDetail = await runtime.query<{ fields: Array<{ id: string; fieldType: string }> }>(
      'sign.envelope.get',
      { envelopeId: hrEnv.envelopeId },
      { actor: asUser(adminUser), orgId: org.orgId },
    );
    const hrAttFieldId = hrDetail.fields.find((f) => f.fieldType === 'attachment')!.id;

    await runtime.execute(
      'sign.envelope.send',
      { envelopeId: hrEnv.envelopeId },
      { actor: asUser(adminUser), orgId: org.orgId },
    );
    const mintedHrLink = await runtime.execute<{ token: string; tokenId: string }>(
      'sign.signer.create_link',
      { envelopeId: hrEnv.envelopeId, signerId: otpSigner.signerId },
      { actor: asUser(adminUser), orgId: org.orgId },
    );

    // Unverified OTP token is refused 403 SIGN_OTP_REQUIRED BEFORE reading/storing bytes!
    const otpBlockedRes = await postMultipartAttachment(app, {
      token: mintedHrLink.token,
      fieldId: hrAttFieldId,
      bytes: pdfFixture('blocked-before-otp'),
    });
    expect(otpBlockedRes.status).toBe(403);
    expect(((await otpBlockedRes.json()) as { code: string }).code).toBe('SIGN_OTP_REQUIRED');

    // Mark OTP verified for this token and upload confidential HR ID attachment!
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_sign.signing_otp (org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, attempts, verified_at)
         VALUES ($1, $2, $3, 'candidate@example.com', $4, now() + interval '15 minutes', 0, now())`,
        [org.orgId, otpSigner.signerId, mintedHrLink.tokenId, 'a'.repeat(64)],
      );
    });

    const hrAttBytes = pdfFixture('confidential-hr-cccd');
    const hrUploadRes = await postMultipartAttachment(app, {
      token: mintedHrLink.token,
      fieldId: hrAttFieldId,
      bytes: hrAttBytes,
      filename: 'cccd-ung-vien.pdf',
    });
    expect(hrUploadRes.status).toBe(200);
    const hrUploaded = (await hrUploadRes.json()) as { fileId: string };

    // HR confidentiality: owner and adminUser (creator) get 200; ordinary member and viewer get 404!
    for (const allowedWho of [owner, adminUser]) {
      const okRes = await app.request(`/api/files/${hrUploaded.fileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(allowedWho)}`, 'x-crove-org': org.slug },
      });
      expect(okRes.status).toBe(200);
    }
    for (const deniedWho of [member, otherMember, viewer]) {
      const deniedRes = await app.request(`/api/files/${hrUploaded.fileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(deniedWho)}`, 'x-crove-org': org.slug },
      });
      expect(deniedRes.status).toBe(404);
    }

    // field_guard() blocks direct tenant SQL tampering with attachment_sha256 inside org context!
    const tenantClient = new pg.Client({ connectionString: appUrl });
    await tenantClient.connect();
    try {
      await tenantClient.query('BEGIN');
      await tenantClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [
        owner.userId,
        org.orgId,
      ]);
      await expect(
        tenantClient.query('UPDATE crove_sign.field SET attachment_sha256 = $1 WHERE org_id = $2 AND id = $3', [
          'f'.repeat(64),
          org.orgId,
          hrAttFieldId,
        ]),
      ).rejects.toThrow(/ENVELOPE_FROZEN|permission denied/i);
      await tenantClient.query('ROLLBACK');
    } finally {
      await tenantClient.end();
    }

    // Rate limit (429) and concurrency cap (503) on POST /api/sign/attachment!
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_TEST_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const busyLimiter = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const releaseSlot = busyLimiter.tryAcquire('sign-attachment')!;
    const busyApp = createHttpApp({
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      signLimits: { attachmentUploads: busyLimiter },
    });
    const busyRes = await postMultipartAttachment(busyApp, {
      token: mintedHrLink.token,
      fieldId: hrAttFieldId,
      bytes: hrAttBytes,
    });
    releaseSlot();
    expect(busyRes.status).toBe(503);
    expect(((await busyRes.json()) as { code: string }).code).toBe('SIGN_ATTACHMENT_BUSY');

    const tightTokenLimit = new RateLimiter({ perMinute: 1 });
    const limitedApp = createHttpApp({
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      signLimits: { tokenAttachment: tightTokenLimit },
    });
    expect(
      (await postMultipartAttachment(limitedApp, { token: mintedHrLink.token, fieldId: hrAttFieldId, bytes: hrAttBytes })).status,
    ).toBe(200);
    const rateLimitedRes = await postMultipartAttachment(limitedApp, {
      token: mintedHrLink.token,
      fieldId: hrAttFieldId,
      bytes: hrAttBytes,
    });
    expect(rateLimitedRes.status).toBe(429);

    // Unentitled / MODULE_OFF org returns opaque 404 on /api/sign/attachment, and HR attachment stays 404 for ordinary members!
    const unentitledApp = createHttpApp({
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => [] },
    });
    const unentitledRes = await postMultipartAttachment(unentitledApp, {
      token: mintedHrLink.token,
      fieldId: hrAttFieldId,
      bytes: hrAttBytes,
    });
    expect(unentitledRes.status).toBe(404);
  });
});
