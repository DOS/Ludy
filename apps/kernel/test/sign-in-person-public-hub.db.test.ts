// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 4d (#3820):
//   - 2a In-person host signing ceremony: sign.signer.start_in_person (<= 2h single-use TTL, viewer 403,
//     waiting sequential signer 409, confidential hr_contract non-creator member refusal), POST /api/sign/view
//     (inPerson: true), POST /api/sign/submit (in_person_signed + hostUserId provenance), and runSignPdfSealJob
//     (certificate.json carries hostUserId on in_person_session_started & in_person_signed with intact hash chain).
//   - 2b Self-service public template hub: GET /-/sign/p/:orgSlug no-Turnstile CSP (#203), ?token= rejection,
//     opaque 404 parity across unknown org / empty hub / unlisted direct link / unentitled org / org_app_on('sign')=false,
//     end-to-end public hub view -> pdf -> otp_request/otp_verify -> start -> /api/sign/submit -> max_uses enforcement,
//     instant unlisting without revoking private /-/sign/d#<token> links, and per-IP/email rate limiting (429 + Retry-After).
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
import { Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMailJob } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runSignPdfSealJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-sign-slice4d-3820-0123456789';
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
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% slice4d-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

function assertNoReferrerNoStore(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

suite('eSign Slice 4d in-person signing and public template hub (#3820)', () => {
  const dbName = `crove_test_sign_slice4d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let tmpWebDist = '';
  let adminUrl = '';
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let app!: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  let orgId = '';
  let orgSlug = '';
  let ownerUserId = '';
  let memberUserId = '';

  const asOwner = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asMember = () => ({ type: 'user' as const, userId: memberUserId, sessionId: randomUUID(), aal: 'aal1' as const });
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

  async function postJson(
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
        'user-agent': 'SignSlice4dTest/1.0',
      },
      body: JSON.stringify(body),
    });
  }

  async function getHub(
    targetApp: ReturnType<typeof createHttpApp>,
    slug: string,
    ip = '198.51.100.10',
  ): Promise<Response> {
    return targetApp.request(`/api/sign/public-hub/${slug}`, {
      method: 'GET',
      headers: {
        'x-forwarded-for': ip,
        'user-agent': 'SignSlice4dTest/1.0',
      },
    });
  }

  async function ingestPdf(targetOrgId: string, tag: string): Promise<{ fileId: string; pdfBytes: Uint8Array; sha256: string }> {
    const pdfBytes = makePdf(`${tag}-${randomUUID()}`);
    const sha256 = sha256Hex(pdfBytes);
    const key = fileKey(targetOrgId, sha256);
    const generation = await store.put(key, pdfBytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
        sha256,
        storageKey: key,
        generation,
        source: 'sign_document',
      },
      { actor: asOwner(), orgId: targetOrgId },
    );
    return { fileId, pdfBytes, sha256 };
  }

  async function setupTemplate(opts: {
    title: string;
    requireEmailOtp: boolean;
    listedOnPublicHub: boolean;
    maxUses?: number | null;
    expiresAt?: string;
  }): Promise<{ templateId: string; pdfBytes: Uint8Array; directToken: string }> {
    const { fileId, pdfBytes } = await ingestPdf(orgId, opts.title);
    const created = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: opts.title, sourceFileId: fileId, routingMode: 'parallel' },
      { actor: asOwner(), orgId },
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
            roleLabel: 'Khach dang ky',
            routingOrder: 1,
            deliveryMode: 'link',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asOwner(), orgId },
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
      { actor: asOwner(), orgId },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: created.templateId, status: 'active' },
      { actor: asOwner(), orgId },
    );
    const direct = await runtime.execute<{ token: string | null; listedOnPublicHub?: boolean }>(
      'sign.template.direct_link_set',
      {
        templateId: created.templateId,
        enabled: true,
        requireEmailOtp: opts.requireEmailOtp,
        listedOnPublicHub: opts.listedOnPublicHub,
        ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      },
      { actor: asOwner(), orgId },
    );
    expect(direct.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(direct.listedOnPublicHub).toBe(opts.listedOnPublicHub);
    return {
      templateId: created.templateId,
      pdfBytes,
      directToken: direct.token!,
    };
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'crove-sign-slice4d-web-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy Sign Hub</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'slice4d-app-pw', ludy_worker: 'slice4d-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('ludy_app', 'slice4d-app-pw');
    const workerUrl = login('ludy_worker', 'slice4d-worker-pw');

    pool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 3 });

    const appDb = createDb(pool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'off' })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: signCommands, queries: signQueries });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
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

    ownerUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'owner-slice4d',
      email: 'owner-slice4d@example.com',
      name: 'Owner Slice 4d',
    });
    memberUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'member-slice4d',
      email: 'member-slice4d@example.com',
      name: 'Member Slice 4d',
    });

    const createdOrg = await createOrg(runtime, asOwner(), 'Cong ty Sao Mai');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`,
        [orgId, memberUserId],
      );
    });
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

  it('completes in-person host signing end-to-end, enforces role/turn/hr_contract gates, and seals hostUserId in certificate.json', async () => {
    const { fileId } = await ingestPdf(orgId, 'in-person-seq');
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Bien ban ban giao tai quay',
        sourceFileId: fileId,
        routingMode: 'sequential',
        allowDelegation: true,
      },
      { actor: asOwner(), orgId },
    );
    const envelopeId = created.envelopeId;

    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: asSystem, orgId },
    );

    const s1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Khach hang',
        name: 'Nguyen Van Khach',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asOwner(), orgId },
    );
    const s2 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        routingOrder: 2,
        signerRole: 'approver',
        roleLabel: 'Quan ly quay',
        name: 'Tran Thi Quan Ly',
        email: 'quanly-quay@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asOwner(), orgId },
    );

    await runtime.execute(
      'sign.field.set',
      {
        envelopeId,
        fields: [
          {
            signerId: s1.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
            proposedByAi: false,
          },
        ],
      },
      { actor: asOwner(), orgId },
    );

    const sent = await runtime.execute<{ links: Array<{ signerId: string; token: string }> }>(
      'sign.envelope.send',
      { envelopeId },
      { actor: asOwner(), orgId },
    );
    const initialToken = sent.links[0]!.token;

    // Member starts an in-person session for due signer #1 (<= 2h TTL), revoking the prior remote link.
    // Security gates (viewer/waiting/cc/hr_contract, delegation lock, mail guard, opaque hub 404s) live in
    // apps/kernel/test/invariant/sign-in-person-public-hub.db.test.ts.
    const started1 = await runtime.execute<{
      tokenId: string;
      token: string;
      hostUserId: string;
      ceremonyPath: string;
      expiresAt: string;
    }>(
      'sign.signer.start_in_person',
      { envelopeId, signerId: s1.signerId, expiresInMinutes: 30 },
      { actor: asMember(), orgId },
    );
    expect(started1.hostUserId).toBe(memberUserId);
    expect(started1.ceremonyPath).toBe(`/-/sign?in_person=1#${started1.token}`);
    const ttlMs = new Date(started1.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(20 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(31 * 60_000);

    // Prior remote link is revoked immediately.
    const oldViewRes = await postJson(app, '/api/sign/view', { token: initialToken }, '198.51.100.20');
    expect(oldViewRes.status).toBe(404);

    // View returns state: 'ready', inPerson: true, and suppresses allowDelegation even when allow_delegation = true.
    const view1Res = await postJson(app, '/api/sign/view', { token: started1.token }, '198.51.100.21');
    expect(view1Res.status).toBe(200);
    const view1Json = (await view1Res.json()) as {
      state: string;
      inPerson?: boolean;
      allowDelegation?: boolean;
      fields: Array<{ id: string }>;
    };
    expect(view1Json).toMatchObject({ state: 'ready', inPerson: true, allowDelegation: false });

    // Submit signer #1 -> records in_person_signed and advances sequential approver #2.
    const submit1Res = await postJson(
      app,
      '/api/sign/submit',
      {
        token: started1.token,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [{ fieldId: view1Json.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }],
      },
      '198.51.100.21',
    );
    expect(submit1Res.status).toBe(200);
    await expect(submit1Res.json()).resolves.toMatchObject({
      signerId: s1.signerId,
      signerStatus: 'signed',
      envelopeStatus: 'in_progress',
      completed: false,
      inPerson: true,
    });

    // Reusing single-use in-person token returns 409 SIGN_ALREADY_SUBMITTED.
    const replayRes = await postJson(
      app,
      '/api/sign/submit',
      { token: started1.token, consentAccepted: true, fields: [] },
      '198.51.100.21',
    );
    expect(replayRes.status).toBe(409);

    // Owner starts in-person session for sequential approver #2 and completes envelope.
    const started2 = await runtime.execute<{ tokenId: string; token: string }>(
      'sign.signer.start_in_person',
      { envelopeId, signerId: s2.signerId, expiresInMinutes: 45 },
      { actor: asOwner(), orgId },
    );

    const submit2Res = await postJson(
      app,
      '/api/sign/submit',
      { token: started2.token, consentAccepted: true, fields: [] },
      '198.51.100.22',
    );
    expect(submit2Res.status).toBe(200);
    await expect(submit2Res.json()).resolves.toMatchObject({
      signerId: s2.signerId,
      completed: true,
      envelopeStatus: 'completed',
      inPerson: true,
    });

    // 6. Seal PDF and verify hash chain + certificate.json hostUserId provenance!
    const sealedPdf = makePdf('sealed-in-person');
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
      { orgId, envelopeId },
    );
    expect(sealed.status).toBe('sealed');

    const verifyRes = await runtime.query<{
      valid: boolean;
      eventChain: { valid: boolean; count: number };
      files: { certificateSha256: string | null };
    }>('sign.envelope.verify', { envelopeId }, { actor: asOwner(), orgId });
    expect(verifyRes.valid).toBe(true);
    expect(verifyRes.eventChain.valid).toBe(true);

    const eventsRes = await runtime.query<{
      events: Array<{ eventType: string; signerId: string | null; hostUserId?: string | null }>;
    }>('sign.envelope.events', { envelopeId }, { actor: asOwner(), orgId });
    const s1Started = eventsRes.events.find(
      (ev) => ev.eventType === 'in_person_session_started' && ev.signerId === s1.signerId,
    );
    const s1Signed = eventsRes.events.find(
      (ev) => ev.eventType === 'in_person_signed' && ev.signerId === s1.signerId,
    );
    const s2Signed = eventsRes.events.find(
      (ev) => ev.eventType === 'in_person_signed' && ev.signerId === s2.signerId,
    );
    expect(s1Started?.hostUserId).toBe(memberUserId);
    expect(s1Signed?.hostUserId).toBe(memberUserId);
    expect(s2Signed?.hostUserId).toBe(ownerUserId);

    const certKey = fileKey(orgId, verifyRes.files.certificateSha256!);
    const certJson = JSON.parse(Buffer.from(await store.get(certKey)).toString('utf8')) as {
      events: Array<{ eventType: string; signerId: string | null; hostUserId?: string }>;
    };
    expect(
      certJson.events.find((ev) => ev.eventType === 'in_person_signed' && ev.signerId === s1.signerId)?.hostUserId,
    ).toBe(memberUserId);
    expect(
      certJson.events.find((ev) => ev.eventType === 'in_person_signed' && ev.signerId === s2.signerId)?.hostUserId,
    ).toBe(ownerUserId);
  });

  it('completes public hub self-service signing (plain + OTP), respects maxUses/unlisting, rate limits, and re-evaluates fresh clock_timestamp() in public_submit', async () => {
    const sentMails: OutboundMail[] = [];
    const mailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(msg) {
        sentMails.push(msg);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };
    const drainQueuedMails = async () => {
      const rows = await admin(async (c) => {
        const { rows: queued } = await c.query<{ id: string }>(
          `SELECT id FROM ludy_kernel.mail_message WHERE org_id = $1 AND status = 'queued' ORDER BY created_at ASC`,
          [orgId],
        );
        return queued;
      });
      for (const row of rows) {
        await runMailJob(
          {
            workerDb,
            runtime: workerRuntime,
            mailer,
            templates: MAIL_TEMPLATES,
            store,
            publicUrl: 'http://localhost:8080',
            bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
          },
          { orgId, messageId: row.id },
        );
      }
    };

    const openTpl = await setupTemplate({
      title: 'Bieu mau Dang ky Su kien',
      requireEmailOtp: false,
      listedOnPublicHub: true,
      maxUses: 1,
    });
    const otpTpl = await setupTemplate({
      title: 'Thoa thuan Bao mat NDA Cong khai',
      requireEmailOtp: true,
      listedOnPublicHub: true,
    });

    // 1. GET hub lists only opted-in templates and exposes zero internal orgId or direct-link tokens.
    const listRes = await getHub(app, orgSlug, '198.51.100.40');
    expect(listRes.status).toBe(200);
    assertNoReferrerNoStore(listRes);
    const listBody = (await listRes.json()) as {
      orgSlug: string;
      orgName: string;
      orgId?: unknown;
      items: Array<Record<string, unknown>>;
    };
    expect(listBody.orgSlug).toBe(orgSlug);
    expect(listBody.orgName).toBe('Cong ty Sao Mai');
    expect(listBody.orgId).toBeUndefined();
    expect(listBody.items.map((i) => i.templateId)).toEqual(expect.arrayContaining([openTpl.templateId, otpTpl.templateId]));
    expect(JSON.stringify(listBody)).not.toContain(openTpl.directToken);
    expect(JSON.stringify(listBody)).not.toContain('token_sha256');

    // Open template: view -> pdf -> start -> submit -> maxUses=1 exhausted -> disappears from hub!
    const viewOpen = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'view', templateId: openTpl.templateId },
      '198.51.100.43',
    );
    expect(viewOpen.status).toBe(200);
    await expect(viewOpen.json()).resolves.toMatchObject({ state: 'ready', title: 'Bieu mau Dang ky Su kien' });

    const pdfOpen = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'pdf', templateId: openTpl.templateId },
      '198.51.100.43',
    );
    expect(pdfOpen.status).toBe(200);
    expect(pdfOpen.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await pdfOpen.arrayBuffer())).toEqual(openTpl.pdfBytes);

    const startOpen = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'start', templateId: openTpl.templateId, name: 'Pham Minh Khach', email: 'khach-hub@example.com' },
      '198.51.100.43',
    );
    expect(startOpen.status).toBe(200);
    const startedOpen = (await startOpen.json()) as { signingToken: string; envelopeId: string };
    expect(startedOpen.signingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const ceremonyView = await postJson(app, '/api/sign/view', { token: startedOpen.signingToken }, '198.51.100.43');
    const ceremonyJson = (await ceremonyView.json()) as { fields: Array<{ id: string }> };
    const ceremonySubmit = await postJson(
      app,
      '/api/sign/submit',
      {
        token: startedOpen.signingToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [{ fieldId: ceremonyJson.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }],
      },
      '198.51.100.43',
    );
    expect(ceremonySubmit.status).toBe(200);

    // maxUses=1 reached: openTpl is no longer listed or startable.
    const exhaustedView = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'view', templateId: openTpl.templateId },
      '198.51.100.43',
    );
    expect(exhaustedView.status).toBe(404);

    // 5. OTP-gated template on hub: view=otp_required, pdf=403, otp_request -> otp_verify -> start.
    const otpView1 = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'view', templateId: otpTpl.templateId },
      '198.51.100.44',
    );
    expect(otpView1.status).toBe(200);
    await expect(otpView1.json()).resolves.toMatchObject({ state: 'otp_required', requireEmailOtp: true });

    const otpPdfBlocked = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'pdf', templateId: otpTpl.templateId },
      '198.51.100.44',
    );
    expect(otpPdfBlocked.status).toBe(403);

    const otpReq = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'otp_request', templateId: otpTpl.templateId, email: 'nda-guest@example.com' },
      '198.51.100.44',
    );
    expect(otpReq.status).toBe(200);
    await drainQueuedMails();
    const otpCode = sentMails.at(-1)!.text.match(/\b(\d{6})\b/)?.[1];
    expect(otpCode).toMatch(/^\d{6}$/);

    const otpVerify = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'otp_verify', templateId: otpTpl.templateId, email: 'nda-guest@example.com', code: otpCode },
      '198.51.100.44',
    );
    expect(otpVerify.status).toBe(200);
    const verifiedOtp = (await otpVerify.json()) as { ok: boolean; otpSessionToken: string };
    expect(verifiedOtp.ok).toBe(true);

    const otpStart = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      {
        action: 'start',
        templateId: otpTpl.templateId,
        name: 'Hoang Gia Khach',
        email: 'nda-guest@example.com',
        otpSessionToken: verifiedOtp.otpSessionToken,
      },
      '198.51.100.44',
    );
    expect(otpStart.status).toBe(200);

    // 6. Unchecking listedOnPublicHub revokes hub access immediately while keeping private /-/sign/d#<token> live!
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: otpTpl.templateId, enabled: true, listedOnPublicHub: false },
      { actor: asOwner(), orgId },
    );
    expect((await getHub(app, orgSlug, '198.51.100.45')).status).toBe(404);
    expect(
      (await postJson(app, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: otpTpl.templateId }, '198.51.100.45')).status,
    ).toBe(404);
    const privateDirectStillWorks = await postJson(
      app,
      '/api/sign/direct/view',
      { token: otpTpl.directToken },
      '198.51.100.45',
    );
    expect(privateDirectStillWorks.status).toBe(200);

    // 7. Re-enable hub listing and verify per-IP rate limiting (429 + Retry-After, zero CAPTCHA).
    await runtime.execute(
      'sign.template.direct_link_set',
      { templateId: otpTpl.templateId, enabled: true, listedOnPublicHub: true },
      { actor: asOwner(), orgId },
    );
    const appDb = createDb(pool!);
    const rlConfig = loadConfig({
      DATABASE_URL: 'postgres://localhost/unused',
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
    });
    const tightHubApp = createHttpApp({
      config: rlConfig,
      runtime,
      store,
      authenticate: createAuthenticator(rlConfig, appDb),
      pool: pool!,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      signPublicHubLimits: {
        lists: new RateLimiter({ perMinute: 2 }),
      },
    });
    expect((await getHub(tightHubApp, orgSlug, '198.51.100.70')).status).toBe(200);
    expect((await getHub(tightHubApp, orgSlug, '198.51.100.70')).status).toBe(200);
    const rlRes = await getHub(tightHubApp, orgSlug, '198.51.100.70');
    expect(rlRes.status).toBe(429);
    assertNoReferrerNoStore(rlRes);
    expect(Number(rlRes.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Verify public_submit re-evaluates fresh clock_timestamp() and rejects a token whose deadline passes while blocked inside public_submit (#4278, MOkI).
    const expTpl = await setupTemplate({
      title: 'Mau Het Han Khi Ky',
      requireEmailOtp: false,
      listedOnPublicHub: true,
    });
    async function waitForPublicSubmitFieldLock(): Promise<void> {
      const waitUntil = Date.now() + 5000;
      while (Date.now() < waitUntil) {
        const waiting = await admin(async (c) => {
          const r = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND query LIKE '%public_submit%'`,
          );
          return r.rows[0]?.cnt ?? 0;
        });
        if (waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('public_submit did not block on field lock within 5000ms');
    }

    // Case 1: Enter public_submit while still valid, block on ludy_sign.field lock until past deadline, then release -> 404 + used_at IS NULL.
    const expDeadlineMs = Date.now() + 2500;
    await runtime.execute(
      'sign.template.direct_link_set',
      {
        templateId: expTpl.templateId,
        enabled: true,
        requireEmailOtp: false,
        listedOnPublicHub: true,
        expiresAt: new Date(expDeadlineMs).toISOString(),
      },
      { actor: asOwner(), orgId },
    );
    const startExp = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'start', templateId: expTpl.templateId, name: 'Khach Het Han', email: 'exp-submit@example.com' },
      '198.51.100.71',
    );
    expect(startExp.status).toBe(200);
    const expStarted = (await startExp.json()) as { signingToken: string; envelopeId: string };
    const expView = (await (await postJson(app, '/api/sign/view', { token: expStarted.signingToken }, '198.51.100.71')).json()) as {
      fields: Array<{ id: string }>;
    };

    const expLockClient = new pg.Client({ connectionString: adminUrl });
    await expLockClient.connect();
    let expSubmitPromise: Promise<Response> | null = null;
    try {
      await expLockClient.query('BEGIN');
      await expLockClient.query(
        'SELECT 1 FROM ludy_sign.field WHERE org_id = $1 AND envelope_id = $2 FOR UPDATE',
        [orgId, expStarted.envelopeId],
      );
      expect(Date.now()).toBeLessThan(expDeadlineMs - 500);
      expSubmitPromise = postJson(
        app,
        '/api/sign/submit',
        {
          token: expStarted.signingToken,
          consentAccepted: true,
          signatureKind: 'draw',
          fields: [{ fieldId: expView.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }],
        },
        '198.51.100.71',
      );
      await waitForPublicSubmitFieldLock();
      const remainingMs = expDeadlineMs + 300 - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
      await expLockClient.query('COMMIT');
    } finally {
      await expLockClient.query('ROLLBACK').catch(() => {});
      await expLockClient.end().catch(() => {});
    }
    const expSubmit = await expSubmitPromise!;
    expect(expSubmit.status).toBe(404);
    const expHash = sha256Hex(Buffer.from(expStarted.signingToken, 'utf8'));
    await admin(async (c) => {
      const tokLeft = await c.query<{ used_at: string | null }>(
        'SELECT used_at FROM ludy_sign.signing_token WHERE org_id = $1 AND token_sha256 = $2',
        [orgId, expHash],
      );
      expect(tokLeft.rows[0]?.used_at).toBeNull();
    });

    // Case 2 (control): Same lock mechanism released BEFORE deadline succeeds -> 200 + used_at IS NOT NULL.
    const ctrlDeadlineMs = Date.now() + 8000;
    await runtime.execute(
      'sign.template.direct_link_set',
      {
        templateId: expTpl.templateId,
        enabled: true,
        requireEmailOtp: false,
        listedOnPublicHub: true,
        expiresAt: new Date(ctrlDeadlineMs).toISOString(),
      },
      { actor: asOwner(), orgId },
    );
    const startCtrl = await postJson(
      app,
      `/api/sign/public-hub/${orgSlug}`,
      { action: 'start', templateId: expTpl.templateId, name: 'Khach Con Han', email: 'ctrl-submit@example.com' },
      '198.51.100.72',
    );
    expect(startCtrl.status).toBe(200);
    const ctrlStarted = (await startCtrl.json()) as { signingToken: string; envelopeId: string };
    const ctrlView = (await (await postJson(app, '/api/sign/view', { token: ctrlStarted.signingToken }, '198.51.100.72')).json()) as {
      fields: Array<{ id: string }>;
    };

    const ctrlLockClient = new pg.Client({ connectionString: adminUrl });
    await ctrlLockClient.connect();
    let ctrlSubmitPromise: Promise<Response> | null = null;
    try {
      await ctrlLockClient.query('BEGIN');
      await ctrlLockClient.query(
        'SELECT 1 FROM ludy_sign.field WHERE org_id = $1 AND envelope_id = $2 FOR UPDATE',
        [orgId, ctrlStarted.envelopeId],
      );
      ctrlSubmitPromise = postJson(
        app,
        '/api/sign/submit',
        {
          token: ctrlStarted.signingToken,
          consentAccepted: true,
          signatureKind: 'draw',
          fields: [{ fieldId: ctrlView.fields[0]!.id, signaturePngBase64: VALID_PNG_BASE64 }],
        },
        '198.51.100.72',
      );
      await waitForPublicSubmitFieldLock();
      expect(Date.now()).toBeLessThan(ctrlDeadlineMs - 1000);
      await ctrlLockClient.query('COMMIT');
    } finally {
      await ctrlLockClient.query('ROLLBACK').catch(() => {});
      await ctrlLockClient.end().catch(() => {});
    }
    const ctrlSubmit = await ctrlSubmitPromise!;
    expect(ctrlSubmit.status).toBe(200);
    const ctrlHash = sha256Hex(Buffer.from(ctrlStarted.signingToken, 'utf8'));
    await admin(async (c) => {
      const tokDone = await c.query<{ used_at: string | null }>(
        'SELECT used_at FROM ludy_sign.signing_token WHERE org_id = $1 AND token_sha256 = $2',
        [orgId, ctrlHash],
      );
      expect(tokDone.rows[0]?.used_at).not.toBeNull();
    });
  });
});
