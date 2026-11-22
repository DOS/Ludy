// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained HTTP edge security invariants for eSign Slice 1b (#3324):
//   - Referrer-Policy: no-referrer, Cache-Control: no-store, X-Content-Type-Options: nosniff on GET /-/sign and every /api/sign/* response
//   - Query-string ?token= rejection (400 SIGN_QUERY_TOKEN_FORBIDDEN) on all /api/sign/* routes
//   - OTP blocking on POST /api/sign/pdf (403 OTP_REQUIRED) & /api/sign/submit, real mail-queue worker rendering, 5-attempt lockout (423)
//   - PNG validation blocking SVG / HTML / tEXt <script> / polyglot trailing bytes with 422 SIGN_INVALID_SIGNATURE_PNG (token unconsumed)
//   - Concurrent HTTP Promise.all replay on POST /api/sign/submit & POST /api/sign/decline (200 + 409 SIGN_ALREADY_SUBMITTED)
//   - Opaque 404 parity across invalid tokens, billing un-entitled orgs, and org_app_on('sign') disabled (MODULE_OFF)
//   - Per-IP and per-token RateLimiter (429 + Retry-After) + bounded PDF ConcurrencyLimiter (503 SIGN_PDF_BUSY) with zero CAPTCHA
//   - PDF sealing + ADR-0034 sign.invite / sign.otp / sign.completed emails + POST /api/sign/verify lookup
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { SIGN_PAGE_PATH } from '@ludy/kernel-contract';
import { Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { hashSigningToken, signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { runMailJob } from '../../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../../src/mail-templates.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { runSignPdfSealJob } from '../../src/sign-worker.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-sign-http-inv-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

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

function makePngBytes(width = 200, height = 80, extraChunks: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rawBytes = width > 0 && height > 0 ? Buffer.alloc(height * (1 + width * 4), 0) : Buffer.from([0, 0, 0, 0, 255]);
  const idat = pngChunk('IDAT', deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    idat,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const VALID_PNG_BYTES = makePngBytes();
const VALID_PNG_BASE64 = VALID_PNG_BYTES.toString('base64');

const makePdf = (tag: string): Uint8Array =>
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% http-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

function assertNoReferrerNoStore(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

suite('eSign Slice 1b HTTP edge security invariants (#3324)', () => {
  const dbName = `crove_test_sign_http_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let tmpWebDist = '';
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
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
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
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
    ip = '198.51.100.1',
  ): Promise<Response> {
    return targetApp.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'SignHttpInv/1.0',
      },
      body: JSON.stringify(body),
    });
  }

  async function setupEnvelope(opts: {
    title: string;
    requireEmailOtp: boolean;
    twoSigners?: boolean;
    deliveryMode?: 'link' | 'email';
  }): Promise<{
    envelopeId: string;
    pdfBytes: Uint8Array;
    signerIds: string[];
    fieldIdsBySigner: Map<string, string[]>;
    links: Array<{ signerId: string; tokenId: string; token: string }>;
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

    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: opts.title, sourceFileId: fileId, routingMode: 'parallel' },
      { actor: asUser, orgId },
    );

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: created.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId },
    );

    const signerIds: string[] = [];
    const s1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: created.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Nguoi ky',
        name: 'Tran Van A',
        email: 'signer.a@sign-http.test',
        deliveryMode: opts.deliveryMode ?? 'link',
        requireEmailOtp: opts.requireEmailOtp,
      },
      { actor: asUser, orgId },
    );
    signerIds.push(s1.signerId);

    const fieldsInput: Array<{
      signerId: string;
      fieldType: 'signature';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      required: boolean;
    }> = [
      { signerId: s1.signerId, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.1, required: true },
    ];

    if (opts.twoSigners) {
      const s2 = await runtime.execute<{ signerId: string }>(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: 'Nguoi ky 2',
          name: 'Le Thi B',
          email: 'signer.b@sign-http.test',
          deliveryMode: opts.deliveryMode ?? 'link',
          requireEmailOtp: false,
        },
        { actor: asUser, orgId },
      );
      signerIds.push(s2.signerId);
      fieldsInput.push({
        signerId: s2.signerId,
        fieldType: 'signature',
        pageNumber: 1,
        xNorm: 0.5,
        yNorm: 0.7,
        wNorm: 0.25,
        hNorm: 0.1,
        required: true,
      });
    }

    await runtime.execute('sign.field.set', { envelopeId: created.envelopeId, fields: fieldsInput }, { actor: asUser, orgId });

    const fieldRows = await admin(async (c) =>
      (await c.query<{ id: string; signer_id: string }>('SELECT id, signer_id FROM crove_sign.field WHERE org_id = $1 AND envelope_id = $2', [orgId, created.envelopeId])).rows,
    );
    const fieldIdsBySigner = new Map<string, string[]>();
    for (const row of fieldRows) {
      const arr = fieldIdsBySigner.get(row.signer_id) ?? [];
      arr.push(row.id);
      fieldIdsBySigner.set(row.signer_id, arr);
    }

    const sent = await runtime.execute<{ links: Array<{ signerId: string; tokenId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.envelopeId },
      { actor: asUser, orgId },
    );

    return {
      envelopeId: created.envelopeId,
      pdfBytes,
      signerIds,
      fieldIdsBySigner,
      links: sent.links,
    };
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'crove-sign-web-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy Sign</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'http-app-pw', crove_worker: 'http-worker-pw' }, dbIds);

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(u) : u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('crove_app', 'http-app-pw');
    const workerUrl = login('crove_worker', 'http-worker-pw');

    pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    workerPool = createDbPool({ connectionString: workerUrl, max: 3 }, dbIds);

    const appDb = createDb(pool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
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
      issuer: 'sign-http-inv',
      subject: 'owner',
      email: 'owner@sign-http.test',
      name: 'Owner HTTP',
    });
    orgId = (await createOrg(runtime, asUser, 'Cong ty HTTP Sign')).orgId;
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

  it('sets no-referrer & no-store headers on GET /-/sign and every /api/sign/* endpoint and rejects ?token= queries', async () => {
    const pageRes = await app.request(SIGN_PAGE_PATH, { method: 'GET' });
    expect(pageRes.status).toBe(200);
    assertNoReferrerNoStore(pageRes);

    const subPageRes = await app.request(`${SIGN_PAGE_PATH}/verify`, { method: 'GET' });
    expect(subPageRes.status).toBe(200);
    assertNoReferrerNoStore(subPageRes);

    const routes = [
      '/api/sign/view',
      '/api/sign/pdf',
      '/api/sign/otp/request',
      '/api/sign/otp/verify',
      '/api/sign/submit',
      '/api/sign/decline',
      '/api/sign/verify',
    ];
    for (const route of routes) {
      const qsRes = await postSign(app, `${route}?token=leak-in-url`, { token: 'x'.repeat(43) }, '198.51.100.10');
      expect(qsRes.status).toBe(400);
      assertNoReferrerNoStore(qsRes);
      await expect(qsRes.json()).resolves.toMatchObject({ code: 'SIGN_QUERY_TOKEN_FORBIDDEN' });

      const emptyRes = await postSign(app, route, {}, '198.51.100.11');
      expect(emptyRes.status).toBe(404);
      assertNoReferrerNoStore(emptyRes);
      await expect(emptyRes.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('enforces OTP PDF/submit gate, ADR-0034 mail rendering, 5-guess lockout (423), PNG validation, concurrent Promise.all submit, sealing & verify', async () => {
    const env = await setupEnvelope({ title: 'HTTP OTP Contract', requireEmailOtp: true, deliveryMode: 'email' });
    expect(env.links).toEqual([]);
    const signerId = env.signerIds[0]!;
    const fieldId = env.fieldIdsBySigner.get(signerId)![0]!;
    const ip = '198.51.100.20';

    const sentMails: OutboundMail[] = [];
    let ambiguousNext = false;
    const mailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(mail) {
        sentMails.push(mail);
        if (ambiguousNext) {
          ambiguousNext = false;
          return { status: 'unknown', code: 'http_502' };
        }
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
    };
    const drainQueuedMails = async () => {
      const due = await admin(async (c) =>
        (await c.query<{ id: string; template_key: string }>("SELECT id, template_key FROM crove_kernel.mail_message WHERE org_id = $1 AND status IN ('queued', 'ambiguous') ORDER BY created_at ASC", [orgId])).rows,
      );
      for (const row of due) {
        const jobArgs = {
          runtime: workerRuntime,
          workerDb,
          mailer,
          templates: MAIL_TEMPLATES,
          store,
          publicUrl: 'http://localhost:8080',
          bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
        };
        const first = await runMailJob(jobArgs, { orgId, messageId: row.id });
        let finalRes = first;
        if (first.action === 'recorded' && first.outcome === 'ambiguous') {
          await admin(async (c) => {
            await c.query("UPDATE crove_kernel.mail_message SET updated_at = now() - interval '10 minutes' WHERE org_id = $1 AND id = $2", [
              orgId,
              row.id,
            ]);
          });
          finalRes = await runMailJob(jobArgs, { orgId, messageId: row.id });
        }
        expect({ template: row.template_key, res: finalRes }).toEqual({
          template: row.template_key,
          res: { action: 'recorded', outcome: 'sent', code: null },
        });
      }
    };

    // Sending sign.invite across an ambiguous retry keeps identical Message-ID and identical active token (never revokes attempt 1's link).
    ambiguousNext = true;
    await drainQueuedMails();
    const inviteMails = sentMails.filter((m) => m.subject.includes('Moi ky:'));
    expect(inviteMails).toHaveLength(2);
    expect(inviteMails[0]!.messageId).toBe(inviteMails[1]!.messageId);
    const inviteMail = inviteMails[1]!;
    expect(inviteMail.html).not.toContain('?token=');
    const tokenAttempt1 = inviteMails[0]!.html.match(new RegExp(`${SIGN_PAGE_PATH.replace('/', '\\/')}#([A-Za-z0-9_-]{43})`))?.[1];
    const rawToken = inviteMail.html.match(new RegExp(`${SIGN_PAGE_PATH.replace('/', '\\/')}#([A-Za-z0-9_-]{43})`))?.[1];
    expect(rawToken).toBeDefined();
    expect(tokenAttempt1).toBe(rawToken);

    // View before OTP returns masked otp_required state.
    const view1 = await postSign(app, '/api/sign/view', { token: rawToken! }, ip);
    expect(view1.status).toBe(200);
    assertNoReferrerNoStore(view1);
    await expect(view1.json()).resolves.toMatchObject({ state: 'otp_required' });

    // PDF & submit refuse before OTP verified.
    const pdfBlocked = await postSign(app, '/api/sign/pdf', { token: rawToken! }, ip);
    expect(pdfBlocked.status).toBe(403);
    assertNoReferrerNoStore(pdfBlocked);
    await expect(pdfBlocked.json()).resolves.toMatchObject({ code: 'OTP_REQUIRED' });

    const submitBlocked = await postSign(
      app,
      '/api/sign/submit',
      { token: rawToken!, consentAccepted: true, signatureKind: 'draw', fields: [{ fieldId, signaturePngBase64: VALID_PNG_BASE64 }] },
      ip,
    );
    expect(submitBlocked.status).toBe(403);
    assertNoReferrerNoStore(submitBlocked);

    const declineBlocked = await postSign(
      app,
      '/api/sign/decline',
      { token: rawToken!, reason: 'before otp' },
      ip,
    );
    expect(declineBlocked.status).toBe(403);
    assertNoReferrerNoStore(declineBlocked);
    await expect(declineBlocked.json()).resolves.toMatchObject({ code: 'SIGN_OTP_REQUIRED' });

    // Send OTP #1 via real mail queue worker and extract 6-digit code from rendered mail.
    const otpReq1 = await postSign(app, '/api/sign/otp/request', { token: rawToken! }, ip);
    expect(otpReq1.status).toBe(200);
    assertNoReferrerNoStore(otpReq1);

    await drainQueuedMails();
    const otpMail1 = sentMails.find((m) => m.subject.includes('Ma xac thuc'));
    expect(otpMail1).toBeDefined();
    const code1 = otpMail1!.text.match(/\b(\d{6})\b/)?.[1];
    expect(code1).toMatch(/^\d{6}$/);

    // 4 wrong guesses -> 401; 5th -> 423 locked; 6th with real code1 -> 423 locked.
    const badCode = code1 === '111111' ? '222222' : '111111';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await postSign(app, '/api/sign/otp/verify', { token: rawToken!, code: badCode }, ip);
      expect(res.status).toBe(attempt < 5 ? 401 : 423);
      assertNoReferrerNoStore(res);
      await expect(res.json()).resolves.toMatchObject({ ok: false, locked: attempt === 5, attemptsRemaining: 5 - attempt });
    }
    const lockedAttempt = await postSign(app, '/api/sign/otp/verify', { token: rawToken!, code: code1 }, ip);
    expect(lockedAttempt.status).toBe(423);
    assertNoReferrerNoStore(lockedAttempt);

    // Request OTP #2, simulate ambiguous retry in worker mail queue, verify identical code across retry & refreshed expiry.
    const otpReq2 = await postSign(app, '/api/sign/otp/request', { token: rawToken! }, ip);
    expect(otpReq2.status).toBe(200);
    ambiguousNext = true;
    await drainQueuedMails();
    const otpMails2 = sentMails.filter((m) => m.subject.includes('Ma xac thuc')).slice(-2);
    expect(otpMails2).toHaveLength(2);
    expect(otpMails2[0]!.messageId).toBe(otpMails2[1]!.messageId);
    const code2Attempt1 = otpMails2[0]!.text.match(/\b(\d{6})\b/)![1]!;
    const code2 = otpMails2[1]!.text.match(/\b(\d{6})\b/)![1]!;
    expect(code2Attempt1).toBe(code2);

    // Simulate a worker mail retry after delay: push existing expires_at into the past;
    // sign.public.otp_mail_data must keep the deterministic OTP code and refresh expires_at past now().
    const otpMail2Row = await admin(async (c) =>
      (
        await c.query<{ otp_id: string }>(
          "SELECT payload->>'otpId' AS otp_id FROM crove_kernel.mail_message WHERE org_id = $1 AND template_key = 'sign.otp' ORDER BY created_at DESC LIMIT 1",
          [orgId],
        )
      ).rows[0]!,
    );
    await admin(async (c) => {
      await c.query("UPDATE crove_sign.signing_otp SET expires_at = now() - interval '2 minutes' WHERE org_id = $1 AND id = $2", [
        orgId,
        otpMail2Row.otp_id,
      ]);
    });
    const retriedOtp = await workerRuntime.execute<{ code: string }>(
      'sign.public.otp_mail_data',
      { signerId, otpId: otpMail2Row.otp_id },
      { actor: asSystem, orgId },
    );
    const codeRetry = retriedOtp.code;
    expect(codeRetry).toBe(code2);

    const otpOk = await postSign(app, '/api/sign/otp/verify', { token: rawToken!, code: codeRetry }, ip);
    expect(otpOk.status).toBe(200);
    assertNoReferrerNoStore(otpOk);
    await expect(otpOk.json()).resolves.toMatchObject({ ok: true, locked: false });

    // Now /api/sign/pdf streams exact PDF bytes with security headers.
    const pdfOk = await postSign(app, '/api/sign/pdf', { token: rawToken! }, ip);
    expect(pdfOk.status).toBe(200);
    assertNoReferrerNoStore(pdfOk);
    expect(pdfOk.headers.get('content-type')).toBe('application/pdf');
    expect(pdfOk.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const streamed = new Uint8Array(await pdfOk.arrayBuffer());
    expect(Buffer.from(streamed).equals(Buffer.from(env.pdfBytes))).toBe(true);

    // Ready view normalizes pageDimensions to pageNumber / widthPt / heightPt.
    const viewReady = await postSign(app, '/api/sign/view', { token: rawToken! }, ip);
    expect(viewReady.status).toBe(200);
    await expect(viewReady.json()).resolves.toMatchObject({
      state: 'ready',
      pageDimensions: [{ pageNumber: 1, widthPt: 595, heightPt: 842 }],
    });

    // SVG / HTML / tEXt <script> / polyglot trailing bytes / corrupt IDAT PNG payloads are rejected 422 without consuming token.
    const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8').toString('base64');
    const htmlDataUrl = `data:text/html;base64,${Buffer.from('<html><script>alert(1)</script></html>', 'utf8').toString('base64')}`;
    const polyglotBase64 = Buffer.concat([VALID_PNG_BYTES, Buffer.from('<html><script>alert(1)</script></html>', 'utf8')]).toString('base64');
    const badTextChunkPng = makePngBytes(120, 40, [pngChunk('tEXt', Buffer.from('Comment\0<script>alert(1)</script>', 'utf8'))]).toString('base64');
    const corruptIdatIhdr = Buffer.alloc(13);
    corruptIdatIhdr.writeUInt32BE(1, 0);
    corruptIdatIhdr.writeUInt32BE(1, 4);
    corruptIdatIhdr[8] = 8;
    corruptIdatIhdr[9] = 6;
    const corruptIdatPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', corruptIdatIhdr),
      pngChunk('IDAT', Buffer.from([0x41])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');

    for (const evil of [svgBase64, htmlDataUrl, polyglotBase64, badTextChunkPng, corruptIdatPng]) {
      const badSubmit = await postSign(
        app,
        '/api/sign/submit',
        { token: rawToken!, consentAccepted: true, signatureKind: 'draw', fields: [{ fieldId, signaturePngBase64: evil }] },
        ip,
      );
      expect(badSubmit.status).toBe(422);
      assertNoReferrerNoStore(badSubmit);
      await expect(badSubmit.json()).resolves.toMatchObject({ code: 'SIGN_INVALID_SIGNATURE_PNG' });
    }

    // Concurrent Promise.all /api/sign/submit: strictly one 200 and one 409 SIGN_ALREADY_SUBMITTED.
    const goodBody = {
      token: rawToken!,
      consentAccepted: true,
      signatureKind: 'draw',
      fields: [{ fieldId, signaturePngBase64: VALID_PNG_BASE64 }],
    };
    const [s1, s2] = await Promise.all([
      postSign(app, '/api/sign/submit', goodBody, ip),
      postSign(app, '/api/sign/submit', goodBody, ip),
    ]);
    expect([s1.status, s2.status].sort()).toEqual([200, 409]);
    const conflictRes = s1.status === 409 ? s1 : s2;
    assertNoReferrerNoStore(conflictRes);
    await expect(conflictRes.json()).resolves.toMatchObject({ code: 'SIGN_ALREADY_SUBMITTED' });

    // Re-using consumed token returns 404 on view/pdf and 409 on submit/decline.
    expect((await postSign(app, '/api/sign/view', { token: rawToken! }, ip)).status).toBe(404);
    expect((await postSign(app, '/api/sign/pdf', { token: rawToken! }, ip)).status).toBe(404);
    expect((await postSign(app, '/api/sign/decline', { token: rawToken! }, ip)).status).toBe(409);

    // Seal completed envelope, send sign.completed email via MAIL_TEMPLATES, and verify certificate endpoint.
    const sealedPdf = makePdf('sealed-http-inv');
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
      { orgId, envelopeId: env.envelopeId },
    );
    expect(sealed.status).toBe('sealed');

    await drainQueuedMails();
    const completedMails = sentMails.filter((m) => m.subject.includes('Hoan tat ky:'));
    expect(completedMails.map((m) => m.to).sort()).toEqual(['owner@sign-http.test', 'signer.a@sign-http.test']);
    const completedMail = completedMails.find((m) => m.to === 'owner@sign-http.test');
    expect(completedMail).toBeDefined();
    expect(completedMail!.html).toContain(sealed.certificateCode!);
    expect(completedMail!.html).toContain(sealedSha);
    expect(completedMail!.attachments).toHaveLength(2);
    const sealedAtt = completedMail!.attachments!.find((a) => a.filename === 'tai-lieu-da-niem-phong.pdf');
    const certAtt = completedMail!.attachments!.find((a) => a.filename === 'chung-thu-kiem-toan.json');
    expect(sealedAtt?.contentType).toBe('application/pdf');
    expect(Buffer.from(sealedAtt!.content).subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(Buffer.from(sealedAtt!.content).equals(Buffer.from(sealedPdf))).toBe(true);
    expect(certAtt?.contentType).toBe('application/json');
    const certJson = JSON.parse(Buffer.from(certAtt!.content).toString('utf8')) as {
      certificateCode: string;
      sealedSha256: string;
      signers: Array<{ ipHashPrefix: string | null }>;
    };
    expect(certJson).toMatchObject({
      certificateCode: sealed.certificateCode,
      sealedSha256: sealedSha,
    });
    const unkeyedHttpPrefix = sha256Hex(`crove:sign:ip:v1:${ip}`).slice(0, 16);
    expect(certJson.signers[0]?.ipHashPrefix).toMatch(/^[0-9a-f]{16}$/);
    expect(certJson.signers[0]?.ipHashPrefix).not.toBe(unkeyedHttpPrefix);

    const verifyOk = await postSign(
      app,
      '/api/sign/verify',
      { certificateCode: sealed.certificateCode, fileSha256: sealedSha },
      '198.51.100.21',
    );
    expect(verifyOk.status).toBe(200);
    assertNoReferrerNoStore(verifyOk);
    await expect(verifyOk.json()).resolves.toMatchObject({ matched: true, signerCount: 1, sealedSha256: sealedSha });

    const verifyMismatch = await postSign(
      app,
      '/api/sign/verify',
      { certificateCode: sealed.certificateCode, fileSha256: 'b'.repeat(64) },
      '198.51.100.21',
    );
    expect(verifyMismatch.status).toBe(404);
    assertNoReferrerNoStore(verifyMismatch);

    // Verify raw signing tokens and OTP codes never persisted in mail_message table.
    const mailDump = await admin(async (c) =>
      JSON.stringify((await c.query('SELECT payload, subject FROM crove_kernel.mail_message WHERE org_id = $1', [orgId])).rows),
    );
    expect(mailDump).not.toContain(rawToken!);
    expect(mailDump).not.toContain(code1!);
    expect(mailDump).not.toContain(code2);
    expect(mailDump).not.toContain(codeRetry);
  });

  it('enforces Promise.all decline, billing/MODULE_OFF opaque 404 parity, RateLimiter (429), and PDF ConcurrencyLimiter (503)', async () => {
    const env = await setupEnvelope({ title: 'HTTP Limits Decline', requireEmailOtp: false, twoSigners: true });
    const token1 = env.links.find((l) => l.signerId === env.signerIds[0]!)!.token;
    const token2 = env.links.find((l) => l.signerId === env.signerIds[1]!)!.token;
    const field2Id = env.fieldIdsBySigner.get(env.signerIds[1]!)![0]!;

    // Billing un-entitled returns opaque 404 across routes.
    expect((await postSign(appUnentitled, '/api/sign/view', { token: token1 }, '198.51.100.30')).status).toBe(404);
    expect((await postSign(appUnentitled, '/api/sign/pdf', { token: token1 }, '198.51.100.30')).status).toBe(404);

    // MODULE_OFF returns identical opaque 404 across all public routes.
    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asUser, orgId, idempotencyKey: randomUUID() });
    const offView = await postSign(app, '/api/sign/view', { token: token1 }, '198.51.100.31');
    const bogusView = await postSign(app, '/api/sign/view', { token: 'Z'.repeat(43) }, '198.51.100.32');
    expect(offView.status).toBe(404);
    expect(bogusView.status).toBe(404);
    expect(await offView.json()).toEqual(await bogusView.json());
    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asUser, orgId, idempotencyKey: randomUUID() });

    // Custom tight limits verify RateLimiter (IP + tokenHash 429) and ConcurrencyLimiter (503 SIGN_PDF_BUSY).
    const config = loadConfig({
      DATABASE_URL: appPoolUrl(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
    });
    const pdfReads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const tightApp = createHttpApp({
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, createDb(pool!)),
      pool: pool!,
      aiEnabled: false,
      signLimits: {
        views: new RateLimiter({ perMinute: 5 }),
        tokenViews: new RateLimiter({ perMinute: 2 }),
        pdfs: new RateLimiter({ perMinute: 1 }),
        pdfReads,
      },
    });

    // Token bucket limit (perMinute: 2 across different IPs) -> 3rd returns 429 + Retry-After.
    expect((await postSign(tightApp, '/api/sign/view', { token: token1 }, '198.51.100.41')).status).toBe(200);
    expect((await postSign(tightApp, '/api/sign/view', { token: token1 }, '198.51.100.42')).status).toBe(200);
    const tokLimited = await postSign(tightApp, '/api/sign/view', { token: token1 }, '198.51.100.43');
    expect(tokLimited.status).toBe(429);
    assertNoReferrerNoStore(tokLimited);
    expect(Number(tokLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // ConcurrencyLimiter busy -> 503 SIGN_PDF_BUSY, then 200 after release, then 429 from IP limiter on 2nd call.
    const release = pdfReads.tryAcquire('sign-pdf');
    expect(release).not.toBeNull();
    try {
      const busyPdf = await postSign(tightApp, '/api/sign/pdf', { token: token1 }, '198.51.100.44');
      expect(busyPdf.status).toBe(503);
      assertNoReferrerNoStore(busyPdf);
      await expect(busyPdf.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });
    } finally {
      release!();
    }
    expect((await postSign(tightApp, '/api/sign/pdf', { token: token1 }, '198.51.100.45')).status).toBe(200);
    expect((await postSign(tightApp, '/api/sign/pdf', { token: token1 }, '198.51.100.45')).status).toBe(429);

    // Animated PNG (APNG acTL chunk) is rejected 422 SIGN_INVALID_SIGNATURE_PNG without consuming token2.
    const apng = makePngBytes(120, 40, [pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))]).toString('base64');
    const apngSubmit = await postSign(
      app,
      '/api/sign/submit',
      { token: token2, consentAccepted: true, signatureKind: 'draw', fields: [{ fieldId: field2Id, signaturePngBase64: apng }] },
      '198.51.100.48',
    );
    expect(apngSubmit.status).toBe(422);
    assertNoReferrerNoStore(apngSubmit);
    await expect(apngSubmit.json()).resolves.toMatchObject({ code: 'SIGN_INVALID_SIGNATURE_PNG' });

    // Oversized signature valueText (> 2000 chars) returns 422 VALIDATION at HTTP and SQL without consuming token2.
    const oversizedValueSubmit = await postSign(
      app,
      '/api/sign/submit',
      { token: token2, consentAccepted: true, signatureKind: 'draw', fields: [{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64, valueText: 'x'.repeat(2001) }] },
      '198.51.100.49',
    );
    expect(oversizedValueSubmit.status).toBe(422);
    assertNoReferrerNoStore(oversizedValueSubmit);
    await expect(oversizedValueSubmit.json()).resolves.toMatchObject({ code: 'VALIDATION' });
    const sqlOversized = await pool!.query<{ res: { status: string; code: string; httpStatus: number } }>(
      'SELECT crove_sign.public_submit($1, true, $2, NULL, $3::jsonb, NULL, NULL, NULL) AS res',
      [
        hashSigningToken(token2),
        'draw',
        JSON.stringify([{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64, valueText: 'x'.repeat(2001) }]),
      ],
    );
    expect(sqlOversized.rows[0]?.res).toMatchObject({ status: 'error', code: 'VALIDATION', httpStatus: 422 });

    // NUL bytes in submit / decline strings return clean 422 VALIDATION rather than PostgreSQL 22021 500 without consuming token2.
    const nulSubmit = await postSign(
      app,
      '/api/sign/submit',
      { token: token2, consentAccepted: true, signatureKind: 'draw', fields: [{ fieldId: field2Id, signaturePngBase64: VALID_PNG_BASE64, valueText: 'abc\u0000def' }] },
      '198.51.100.49',
    );
    expect(nulSubmit.status).toBe(422);
    assertNoReferrerNoStore(nulSubmit);
    await expect(nulSubmit.json()).resolves.toMatchObject({ code: 'VALIDATION' });

    const nulDecline = await postSign(app, '/api/sign/decline', { token: token2, reason: 'Bad\u0000reason' }, '198.51.100.49');
    expect(nulDecline.status).toBe(422);
    assertNoReferrerNoStore(nulDecline);
    await expect(nulDecline.json()).resolves.toMatchObject({ code: 'VALIDATION' });

    // Body limit (413) preserves Referrer-Policy, Cache-Control, and X-Content-Type-Options headers.
    const bodyTooLarge = await postSign(app, '/api/sign/view', { token: token2, pad: 'p'.repeat(3000) }, '198.51.100.52');
    expect(bodyTooLarge.status).toBe(413);
    assertNoReferrerNoStore(bodyTooLarge);
    expect(bodyTooLarge.headers.get('x-content-type-options')).toBe('nosniff');

    // Concurrent Promise.all /api/sign/decline: strictly one 200 and one 409, and token2 is revoked (404).
    const [d1, d2] = await Promise.all([
      postSign(app, '/api/sign/decline', { token: token1, reason: 'Cancelled' }, '198.51.100.50'),
      postSign(app, '/api/sign/decline', { token: token1, reason: 'Cancelled' }, '198.51.100.50'),
    ]);
    expect([d1.status, d2.status].sort()).toEqual([200, 409]);
    expect((await postSign(app, '/api/sign/view', { token: token2 }, '198.51.100.51')).status).toBe(404);
    expect(hashSigningToken(token1)).not.toBe(token1);
  });

  function appPoolUrl(): string {
    const u = new URL(adminUrl);
    u.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    u.password = 'http-app-pw';
    return u.toString();
  }
});
