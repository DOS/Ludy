// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained HTTP edge security invariants for eSign Slice 2a A1 direct signing links (#3551):
//   - GET /-/sign/d serves strict no-Turnstile CSP (#203) + Referrer-Policy: no-referrer, Cache-Control: no-store, X-Content-Type-Options: nosniff
//   - Query-string ?token= rejection (400 SIGN_QUERY_TOKEN_FORBIDDEN) on all 5 /api/sign/direct/* routes
//   - Opaque 404 parity across invalid tokens, un-entitled orgs, MODULE_OFF, disabled/revoked/expired/max_uses links (zero existence oracle)
//   - Pre-envelope OTP gate (403 OTP_REQUIRED on /pdf, 403 SIGN_OTP_REQUIRED on /start), real runMailJob rendering, 5-attempt lockout (423)
//   - Per-IP, per-token, and per-token-email RateLimiter (429 + Retry-After) + bounded PDF ConcurrencyLimiter (503 SIGN_PDF_BUSY)
//   - End-to-end /api/sign/direct/start -> /api/sign/view -> /api/sign/submit -> runSignPdfSealJob -> /api/sign/verify SHA-256 chain
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { SIGN_DIRECT_PAGE_PATH } from '@ludy/kernel-contract';
import { Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { TURNSTILE_ORIGIN, createHttpApp } from '../../src/http.ts';
import { runMailJob } from '../../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../../src/mail-templates.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { runSignPdfSealJob } from '../../src/sign-worker.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-sign-direct-http-0123456';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

const DIRECT_ROUTES = [
  '/api/sign/direct/view',
  '/api/sign/direct/pdf',
  '/api/sign/direct/otp/request',
  '/api/sign/direct/otp/verify',
  '/api/sign/direct/start',
] as const;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length)) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

function makePngBase64(width = 200, height = 80): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rawBytes = Buffer.alloc(height * (1 + width * 4), 0);
  const idat = pngChunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    idat,
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_PNG_BASE64 = makePngBase64();

const makePdf = (tag: string): Uint8Array =>
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% direct-http-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

function assertNoReferrerNoStore(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

suite('eSign Slice 2a A1 direct signing HTTP edge invariants (#3551)', () => {
  const dbName = `crove_test_sign_direct_http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let tmpWebDist = '';
  let adminUrl = '';
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let app!: ReturnType<typeof createHttpApp>;
  let appUnentitled!: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  let orgId = '';
  let userId = '';

  const sessionId = randomUUID();
  const asUser = { type: 'user' as const, get userId() { return userId; }, sessionId, aal: 'aal1' as const };
  const asSystem = { type: 'system' as const, component: 'sign-worker' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function postSign(
    targetApp: ReturnType<typeof createHttpApp>,
    path: string,
    body: unknown,
    ip = '198.51.100.10',
  ): Promise<Response> {
    return targetApp.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'SignDirectHttpInv/1.0',
      },
      body: JSON.stringify(body),
    });
  }

  async function setupDirectTemplate(opts: {
    title: string;
    requireEmailOtp: boolean;
    maxUses?: number | null;
    includeCc?: boolean;
  }): Promise<{
    templateId: string;
    pdfBytes: Uint8Array;
    directToken: string;
  }> {
    const pdfBytes = makePdf(`${opts.title}-${randomUUID()}`);
    const sha256 = sha256Hex(pdfBytes);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, pdfBytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${opts.title}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
        sha256,
        storageKey: key,
        generation,
        source: 'sign_document',
      },
      { actor: asUser, orgId },
    );

    const created = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: opts.title, sourceFileId: fileId, routingMode: 'parallel' },
      { actor: asUser, orgId },
    );

    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: created.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId },
    );

    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: created.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Khach hang',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
          ...(opts.includeCc
            ? [
                {
                  roleKey: 'cc1',
                  signerRole: 'cc' as const,
                  roleLabel: 'Ke toan CC',
                  routingOrder: 2,
                  deliveryMode: 'link' as const,
                  requireEmailOtp: false,
                },
              ]
            : []),
        ],
      },
      { actor: asUser, orgId },
    );

    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: created.templateId,
        fields: [
          {
            roleKey: 'r1',
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
        ],
      },
      { actor: asUser, orgId },
    );

    await runtime.execute(
      'sign.template.update',
      { templateId: created.templateId, status: 'active' },
      { actor: asUser, orgId },
    );

    const direct = await runtime.execute<{ token: string | null }>(
      'sign.template.direct_link_set',
      {
        templateId: created.templateId,
        enabled: true,
        requireEmailOtp: opts.requireEmailOtp,
        ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
      },
      { actor: asUser, orgId },
    );
    expect(direct.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    return {
      templateId: created.templateId,
      pdfBytes,
      directToken: direct.token!,
    };
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'crove-sign-direct-web-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy Direct Sign</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'http-direct-app-pw', crove_worker: 'http-direct-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('crove_app', 'http-direct-app-pw');
    const workerUrl = login('crove_worker', 'http-direct-worker-pw');

    pool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 3 });

    const appDb = createDb(pool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    // Configure TURNSTILE_SITE_KEY + TURNSTILE_SECRET to prove /-/sign/d strips Cloudflare Turnstile from its CSP (#203).
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    });

    const authenticate = createAuthenticator(config, appDb);
    app = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    appUnentitled = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => [] },
    });

    userId = await upsertIdentity(appDb, {
      issuer: 'sign-direct-http-inv',
      subject: 'owner',
      email: 'owner@sign-direct-http.test',
      name: 'Owner Direct HTTP',
    });
    orgId = (await createOrg(runtime, asUser, 'Cong ty Direct Sign')).orgId;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (tmpWebDist) rmSync(tmpWebDist, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('serves GET /-/sign/d with strict no-Turnstile CSP (#203) and rejects ?token= on all 5 /api/sign/direct/* routes', async () => {
    const directPageRes = await app.request(SIGN_DIRECT_PAGE_PATH, { method: 'GET' });
    expect(directPageRes.status).toBe(200);
    assertNoReferrerNoStore(directPageRes);
    const directCsp = directPageRes.headers.get('content-security-policy') ?? '';
    expect(directCsp).toContain("default-src 'self'");
    expect(directCsp).not.toContain(TURNSTILE_ORIGIN);
    expect(directCsp).not.toContain('crove-turnstile');

    // Non-sign SPA routes still carry Turnstile when configured.
    const rootRes = await app.request('/login', { method: 'GET' });
    expect(rootRes.headers.get('content-security-policy') ?? '').toContain(TURNSTILE_ORIGIN);

    for (const path of DIRECT_ROUTES) {
      const qRes = await app.request(`${path}?token=leaked`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.11' },
        body: '{}',
      });
      expect(qRes.status, path).toBe(400);
      assertNoReferrerNoStore(qRes);
      await expect(qRes.json()).resolves.toMatchObject({ code: 'SIGN_QUERY_TOKEN_FORBIDDEN' });
    }
  });

  it('enforces opaque 404 parity across invalid tokens, un-entitled orgs, MODULE_OFF, and malformed extra fields', async () => {
    const tpl = await setupDirectTemplate({ title: 'Direct Opaque Check', requireEmailOtp: false });
    const fakeToken = 'Z'.repeat(43);

    for (const path of DIRECT_ROUTES) {
      // Invalid token with invalid secondary fields still answers 404 (never 422), preventing existence oracle.
      const invalidRes = await postSign(app, path, { token: fakeToken, name: '', email: 'bad', code: 'bad' }, '198.51.100.12');
      expect(invalidRes.status, `${path} invalid`).toBe(404);
      assertNoReferrerNoStore(invalidRes);
      const invalidJson = await invalidRes.json();
      expect(invalidJson).toEqual({ code: 'NOT_FOUND', message: 'Not found' });

      const unentitledRes = await postSign(
        appUnentitled,
        path,
        { token: tpl.directToken, name: '', email: 'bad', code: 'bad' },
        '198.51.100.13',
      );
      expect(unentitledRes.status, `${path} unentitled`).toBe(404);
      expect(await unentitledRes.json()).toEqual(invalidJson);
    }

    // Valid view leaks zero internal UUIDs (orgId, directLinkId, templateId).
    const okViewRes = await postSign(app, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.14');
    expect(okViewRes.status).toBe(200);
    assertNoReferrerNoStore(okViewRes);
    const okViewBody = (await okViewRes.json()) as Record<string, unknown>;
    expect(okViewBody).toMatchObject({ state: 'ready', title: 'Direct Opaque Check', signerRole: 'signer' });
    expect(okViewBody.orgId).toBeUndefined();
    expect(okViewBody.templateId).toBeUndefined();
    expect(okViewBody.directLinkId).toBeUndefined();

    // MODULE_OFF flips all 5 routes to identical 404.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asUser, orgId },
    );
    try {
      for (const path of DIRECT_ROUTES) {
        const offRes = await postSign(app, path, { token: tpl.directToken, name: 'Test', email: 'a@example.com', code: '123456' }, '198.51.100.15');
        expect(offRes.status, `${path} MODULE_OFF`).toBe(404);
        assertNoReferrerNoStore(offRes);
        await expect(offRes.json()).resolves.toEqual({ code: 'NOT_FOUND', message: 'Not found' });
      }
    } finally {
      await runtime.execute(
        'kernel.org.set_app',
        { module: 'sign', enabled: true },
        { actor: asUser, orgId },
      );
    }
  });

  it('completes end-to-end OTP-gated direct ceremony -> /api/sign/submit -> PDF seal -> /api/sign/verify', async () => {
    const sentMails: OutboundMail[] = [];
    const mailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(mail) {
        sentMails.push(mail);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };

    const drainQueuedMails = async () => {
      const due = await admin(async (c) =>
        (
          await c.query<{ id: string; template_key: string }>(
            "SELECT id, template_key FROM crove_kernel.mail_message WHERE org_id = $1 AND status = 'queued' ORDER BY created_at ASC",
            [orgId],
          )
        ).rows,
      );
      for (const row of due) {
        const res = await runMailJob(
          {
            runtime: workerRuntime,
            workerDb,
            mailer,
            templates: MAIL_TEMPLATES,
            store,
            publicUrl: 'http://localhost:8080',
            bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
          },
          { orgId, messageId: row.id },
        );
        expect(res).toEqual({ action: 'recorded', outcome: 'sent', code: null });
      }
    };

    const tpl = await setupDirectTemplate({
      title: 'OTP Direct Ceremony',
      requireEmailOtp: true,
      includeCc: true,
      maxUses: 1,
    });
    const ip = '198.51.100.25';

    // 1. View returns otp_required; PDF and start fail closed with 403 before OTP verification.
    const view1 = await postSign(app, '/api/sign/direct/view', { token: tpl.directToken }, ip);
    expect(view1.status).toBe(200);
    assertNoReferrerNoStore(view1);
    await expect(view1.json()).resolves.toMatchObject({ state: 'otp_required', requireEmailOtp: true });

    const pdfBlocked = await postSign(app, '/api/sign/direct/pdf', { token: tpl.directToken }, ip);
    expect(pdfBlocked.status).toBe(403);
    assertNoReferrerNoStore(pdfBlocked);
    await expect(pdfBlocked.json()).resolves.toMatchObject({ code: 'OTP_REQUIRED' });

    const startBlocked = await postSign(
      app,
      '/api/sign/direct/start',
      { token: tpl.directToken, name: 'Pham Van D', email: 'signer@direct.test' },
      ip,
    );
    expect(startBlocked.status).toBe(403);
    assertNoReferrerNoStore(startBlocked);
    await expect(startBlocked.json()).resolves.toMatchObject({ code: 'SIGN_OTP_REQUIRED' });

    // 2. Request OTP #1, render via worker mail queue, and trigger 5-attempt 423 lockout.
    const otpReq1 = await postSign(app, '/api/sign/direct/otp/request', { token: tpl.directToken, email: 'signer@direct.test' }, ip);
    expect(otpReq1.status).toBe(200);
    assertNoReferrerNoStore(otpReq1);

    await drainQueuedMails();
    const otpMail1 = sentMails.at(-1);
    expect(otpMail1?.subject).toContain('Ma xac thuc ky tai lieu');
    const code1 = otpMail1!.text.match(/\b(\d{6})\b/)?.[1];
    expect(code1).toMatch(/^\d{6}$/);

    const badCode = code1 === '111111' ? '222222' : '111111';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await postSign(
        app,
        '/api/sign/direct/otp/verify',
        { token: tpl.directToken, email: 'signer@direct.test', code: badCode },
        ip,
      );
      expect(res.status).toBe(attempt < 5 ? 401 : 423);
      assertNoReferrerNoStore(res);
      await expect(res.json()).resolves.toMatchObject({ ok: false, locked: attempt === 5, attemptsRemaining: 5 - attempt });
    }

    // 3. Request OTP #2, verify cleanly, preview PDF, and start signing ceremony.
    const otpReq2 = await postSign(app, '/api/sign/direct/otp/request', { token: tpl.directToken, email: 'signer@direct.test' }, ip);
    expect(otpReq2.status).toBe(200);
    await drainQueuedMails();
    const code2 = sentMails.at(-1)!.text.match(/\b(\d{6})\b/)![1]!;

    const verifyOk = await postSign(
      app,
      '/api/sign/direct/otp/verify',
      { token: tpl.directToken, email: 'signer@direct.test', code: code2 },
      ip,
    );
    expect(verifyOk.status).toBe(200);
    assertNoReferrerNoStore(verifyOk);
    const verifiedPayload = (await verifyOk.json()) as { ok: boolean; otpSessionToken: string; verifiedEmail: string };
    expect(verifiedPayload.ok).toBe(true);
    expect(verifiedPayload.otpSessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifiedPayload.verifiedEmail).toBe('signer@direct.test');

    const pdfOk = await postSign(
      app,
      '/api/sign/direct/pdf',
      { token: tpl.directToken, otpSessionToken: verifiedPayload.otpSessionToken },
      ip,
    );
    expect(pdfOk.status).toBe(200);
    assertNoReferrerNoStore(pdfOk);
    expect(pdfOk.headers.get('content-type')).toBe('application/pdf');
    expect(pdfOk.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await pdfOk.arrayBuffer()).equals(Buffer.from(tpl.pdfBytes))).toBe(true);

    const startOk = await postSign(
      app,
      '/api/sign/direct/start',
      {
        token: tpl.directToken,
        name: 'Pham Van D',
        email: 'signer@direct.test',
        otpSessionToken: verifiedPayload.otpSessionToken,
      },
      ip,
    );
    expect(startOk.status).toBe(200);
    assertNoReferrerNoStore(startOk);
    const started = (await startOk.json()) as { envelopeId: string; signerId: string; signingToken: string };
    expect(started.signingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Because maxUses === 1, any further direct view/start returns opaque 404.
    expect((await postSign(app, '/api/sign/direct/view', { token: tpl.directToken }, ip)).status).toBe(404);

    // 4. Transition to /api/sign/view and /api/sign/submit with the minted single-use signingToken (no duplicate OTP prompt!).
    const ceremonyViewRes = await postSign(app, '/api/sign/view', { token: started.signingToken }, ip);
    expect(ceremonyViewRes.status).toBe(200);
    const ceremonyView = (await ceremonyViewRes.json()) as {
      state: string;
      otpVerified: boolean;
      fields: Array<{ id: string }>;
    };
    expect(ceremonyView.state).toBe('ready');
    expect(ceremonyView.otpVerified).toBe(true);
    expect(ceremonyView.fields).toHaveLength(1);

    const submitRes = await postSign(
      app,
      '/api/sign/submit',
      {
        token: started.signingToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [{ fieldId: ceremonyView.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }],
      },
      ip,
    );
    expect(submitRes.status).toBe(200);
    await expect(submitRes.json()).resolves.toMatchObject({ completed: true, envelopeStatus: 'completed' });

    // 5. Seal completed envelope and verify public certificate endpoint.
    const sealedPdf = makePdf('sealed-direct-http-inv');
    const sealedSha = sha256Hex(sealedPdf);
    const mockExtract: ExtractClient = {
      async extract(kind) {
        if (kind === 'pdf_seal') {
          return {
            ok: true,
            kind: 'pdf_seal',
            sealedPdfBase64: Buffer.from(sealedPdf).toString('base64'),
            pageCount: 2,
          } as never;
        }
        throw new Error(`unexpected extract kind: ${kind}`);
      },
    };
    const sealed = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId, envelopeId: started.envelopeId },
    );
    expect(sealed.status).toBe('sealed');

    const certVerify = await postSign(
      app,
      '/api/sign/verify',
      { certificateCode: sealed.certificateCode, fileSha256: sealedSha },
      ip,
    );
    expect(certVerify.status).toBe(200);
    await expect(certVerify.json()).resolves.toMatchObject({ matched: true, signerCount: 1, sealedSha256: sealedSha });
  });

  it('enforces per-IP, per-token, per-email rate limits (429 + Retry-After) and bounded PDF concurrency (503)', async () => {
    const tpl = await setupDirectTemplate({ title: 'Rate Limit Direct Template', requireEmailOtp: true });

    const pdfReads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const appDb = createDb(pool!);
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/unused',
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
    });
    const tightApp = createHttpApp({
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, appDb),
      pool: pool!,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      signLimits: { pdfReads },
      signDirectLimits: {
        views: new RateLimiter({ perMinute: 2 }),
        tokenViews: new RateLimiter({ perMinute: 3 }),
        emailOtpRequest: new RateLimiter({ perMinute: 1 }),
      },
    });

    // IP budget of 2/min triggers 429 on the 3rd request from the same IP.
    expect((await postSign(tightApp, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.60')).status).toBe(200);
    expect((await postSign(tightApp, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.60')).status).toBe(200);
    const ipLimited = await postSign(tightApp, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.60');
    expect(ipLimited.status).toBe(429);
    assertNoReferrerNoStore(ipLimited);
    expect(Number(ipLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Token budget of 3/min (2 already consumed above) allows 1 more from a fresh IP, then 429 on 4th.
    expect((await postSign(tightApp, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.61')).status).toBe(200);
    const tokenLimited = await postSign(tightApp, '/api/sign/direct/view', { token: tpl.directToken }, '198.51.100.62');
    expect(tokenLimited.status).toBe(429);
    assertNoReferrerNoStore(tokenLimited);

    // Per-(token+email) OTP request budget of 1/min allows first request, then 429 on second for same email.
    expect(
      (await postSign(tightApp, '/api/sign/direct/otp/request', { token: tpl.directToken, email: 'rl@direct.test' }, '198.51.100.63')).status,
    ).toBe(200);
    const emailLimited = await postSign(
      tightApp,
      '/api/sign/direct/otp/request',
      { token: tpl.directToken, email: 'rl@direct.test' },
      '198.51.100.64',
    );
    expect(emailLimited.status).toBe(429);
    assertNoReferrerNoStore(emailLimited);

    // Bounded PDF ConcurrencyLimiter returns 503 SIGN_PDF_BUSY when saturated.
    const noOtpTpl = await setupDirectTemplate({ title: 'PDF Busy Direct Template', requireEmailOtp: false });
    const release = pdfReads.tryAcquire('sign-pdf');
    expect(release).not.toBeNull();
    try {
      const busyPdf = await postSign(tightApp, '/api/sign/direct/pdf', { token: noOtpTpl.directToken }, '198.51.100.65');
      expect(busyPdf.status).toBe(503);
      assertNoReferrerNoStore(busyPdf);
      await expect(busyPdf.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });
    } finally {
      release!();
    }
    expect((await postSign(tightApp, '/api/sign/direct/pdf', { token: noOtpTpl.directToken }, '198.51.100.66')).status).toBe(200);
  });
});
