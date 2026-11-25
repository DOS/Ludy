// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained HTTP edge and PostgreSQL 17 security invariants for scoped org API keys and `/api/v1/sign/*` (#4441, Slice 5c):
//   - Edge-generated `ludy_sk_<base64url>` secrets via `/api/rpc/sign/api_keys/create`: owner/admin RBAC only,
//     SHA-256 stored in `crove_sign.api_key` (`MACHINERY`), zero cleartext secret in DB, audit_event, or idempotency_key.
//   - Query-string `?token=`, `?api_key=`, `?access_token=`, `?key=` rejected with `400 SIGN_QUERY_TOKEN_FORBIDDEN`
//     before auth; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` on all responses.
//   - Missing/malformed/unknown/expired/revoked Bearer key -> `401 UNAUTHENTICATED` + `WWW-Authenticate: Bearer`.
//   - Scope separation: `sign:read` vs `sign:draft` (`403 FORBIDDEN` when missing required scope).
//   - App-off (`ludy_kernel.org_app_on('sign') = false`) and unentitled billing -> opaque `404 NOT_FOUND` without touching `last_used_at`.
//   - Strict exclusion of `hr_contract`, `meeting_minutes`, and foreign-org envelopes across list, detail, `/sealed`, and `/certificate` (`404` parity).
//   - Verified `/sealed` PDF (`application/pdf`) and `/certificate` (`application/json`) downloads (`409 SIGN_ENVELOPE_NOT_SEALED` when unsealed).
//   - `POST /api/v1/sign/envelopes/from-template` creates `status = 'draft'` ONLY, prefills `textDefaults`, logs hash-chained
//     `envelope_created` (`api_key:<prefix>`), returns `{ id, status: 'draft', reviewUrl }`, and mints zero signing tokens or emails.
//   - Per-IP and per-key `RateLimiter` (`429 RATE_LIMITED` + `Retry-After`) and `ludy_kernel.org_purge` cleanup.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  Runtime,
  contentGeneration,
  fileKey,
  sha256Hex,
  type BlobStore,
  type UserActor,
} from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../../src/org-purge.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { runSignApiV1EnvelopesList } from '../../src/sign-api-v1.ts';
import { runSignPdfSealJob } from '../../src/sign-worker.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-sign-api-v1-inv-0123456789';
const ISSUER = 'ludy-auth';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  beforeGet: ((key: string) => Promise<void>) | null = null;
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
  }
  async get(key: string) {
    if (this.beforeGet) await this.beforeGet(key);
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

function makePngBase64(width = 180, height = 60): string {
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
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-api-v1-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const mockExtract: ExtractClient = {
  async extract(kind) {
    if (kind === 'pdf_seal') {
      return {
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: Buffer.from(makePdf('sealed')).toString('base64'),
      } as never;
    }
    throw new Error(`Unexpected extract kind: ${kind}`);
  },
};

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

function assertNoStoreHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

suite('eSign Slice 5c `/api/v1/sign/*` and scoped API key invariants (#4441)', () => {
  const dbName = `crove_test_sign_api_v1_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let appTightRate!: ReturnType<typeof createHttpApp>;
  let appDefaultPdfLimits!: ReturnType<typeof createHttpApp>;
  let tightKeyReadLimit!: RateLimiter;
  let tightPdfReads!: ConcurrencyLimiter;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner@sign-v1.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@sign-v1.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@sign-v1.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@sign-v1.test', session: randomUUID(), userId: '' };
  const foreignOwner: Account = { subject: randomUUID(), email: 'foreign@sign-v1.test', session: randomUUID(), userId: '' };

  let orgA = { orgId: '', slug: '' };
  let orgB = { orgId: '', slug: '' };

  const ids: Record<string, string> = {};
  let readOnlySecret = '';
  let draftOnlySecret = '';
  let fullScopeSecret = '';
  let fullScopeKeyId = '';

  const asUser = (who: Account): UserActor => ({
    type: 'user',
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1',
  });
  const asMfa = (who: Account): UserActor => ({
    type: 'user',
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2',
    mfaAt: Math.floor(Date.now() / 1000),
  });
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

  async function jwtFor(
    who: Account,
    opts?: { aal?: 'aal1' | 'aal2'; mfaAt?: number | null },
  ): Promise<string> {
    const aal = opts?.aal ?? 'aal1';
    const payload: Record<string, unknown> = {
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal,
      is_anonymous: false,
    };
    if (typeof opts?.mfaAt === 'number') {
      payload.amr = [{ method: 'totp', timestamp: opts.mfaAt }];
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc<T = Record<string, unknown>>(
    path: string,
    who: Account,
    input: unknown,
    slug = orgA.slug,
    opts?: { aal?: 'aal1' | 'aal2'; mfaAt?: number | null },
  ): Promise<{ status: number; body: T }> {
    const res = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await jwtFor(who, opts)}`,
        'content-type': 'application/json',
        'x-ludy-org': slug,
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const raw = (await res.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: res.status, body: (raw && 'json' in raw ? raw.json : raw) as T };
  }

  async function ingestPdf(orgId: string, who: Account, tag: string): Promise<{ fileId: string; sha256: string }> {
    const bytes = makePdf(`${tag}-${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: key,
        generation,
        source: 'sign_document',
      },
      { actor: asUser(who), orgId },
    );
    return { fileId, sha256 };
  }

  async function apiGet(
    path: string,
    bearer?: string,
    targetApp = app,
    ip = '198.51.100.25',
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': ip, 'user-agent': 'SignApiV1Inv/1.0' };
    if (bearer !== undefined) headers.authorization = bearer;
    return targetApp.request(path, { method: 'GET', headers });
  }

  async function apiPost(
    path: string,
    body: unknown,
    bearer?: string,
    targetApp = app,
    ip = '198.51.100.25',
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      'user-agent': 'SignApiV1Inv/1.0',
    };
    if (bearer !== undefined) headers.authorization = bearer;
    return targetApp.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'ludy-sign-api-v1-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.query(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { ludy_app: 'v1-app-pw', ludy_worker: 'v1-worker-pw' }, dbIds);

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(u) : u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('ludy_app', 'v1-app-pw');
    const workerUrl = login('ludy_worker', 'v1-worker-pw');

    pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    workerPool = createDbPool({ connectionString: workerUrl, max: 3 }, dbIds);

    const appDb = createDb(pool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off') })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: [...kernelCommands, orgPurgeCommand({ store })], queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
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

    tightKeyReadLimit = new RateLimiter({ perMinute: 1 });
    tightPdfReads = new ConcurrencyLimiter({ total: 2, perKey: 1 });
    appTightRate = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      signApiV1Limits: {
        ip: new RateLimiter({ perMinute: 100 }),
        keyRead: tightKeyReadLimit,
        keyDraft: new RateLimiter({ perMinute: 1 }),
        pdfReads: tightPdfReads,
      },
    });
    appDefaultPdfLimits = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    for (const acc of [owner, adminUser, member, viewer, foreignOwner]) {
      acc.userId = await upsertIdentity(appDb, {
        issuer: ISSUER,
        subject: acc.subject,
        email: acc.email,
        name: acc.email,
      });
    }

    orgA = await createOrg(runtime, asUser(owner), 'Cong ty Sign API A');
    orgB = await createOrg(runtime, asUser(foreignOwner), 'Cong ty Sign API B');
    // #4703: once the org setting "Ký biên bản họp" exists it is off by default and the server refuses to create a minutes envelope while it is off. These cases create them, so the org turns it
    // on; before the setting's column exists the update finds no column (42703) and is skipped.
    for (const id of [orgA.orgId, orgB.orgId]) {
      await admin((c) => c.query('UPDATE ludy_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [id])).catch((error: { code?: string }) => {
        if (error.code !== '42703') throw error;
      });
    }

    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [orgA.orgId, adminUser.userId, member.userId, viewer.userId],
      ),
    );

    // 1. Seed a completed + sealed standalone envelope in Org A.
    const sealedDoc = await ingestPdf(orgA.orgId, adminUser, 'sealed-contract');
    const createdCompleted = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Hop dong mua ban thiet bi', sourceFileId: sealedDoc.fileId, routingMode: 'parallel' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    ids.completedEnv = createdCompleted.envelopeId;
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: ids.completedEnv,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA.orgId },
    );
    const s1 = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: ids.completedEnv,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Khach hang',
        name: 'Nguyen Van Khach',
        email: 'private-signer-email@sign-v1.test',
        phone: '+84912345678',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: ids.completedEnv,
        fields: [
          {
            signerId: s1.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.15,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const sentCompleted = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: ids.completedEnv },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    ids.signingToken = sentCompleted.links[0]!.token;
    const fRow = await admin(async (c) =>
      (
        await c.query<{ id: string }>('SELECT id FROM crove_sign.field WHERE org_id = $1 AND envelope_id = $2', [
          orgA.orgId,
          ids.completedEnv,
        ])
      ).rows[0]!,
    );
    await admin((c) =>
      c.query(
        `SELECT crove_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, NULL, 'SignApiV1Inv/1.0', NULL)`,
        [sha256Hex(ids.signingToken!), JSON.stringify([{ fieldId: fRow.id, signaturePngBase64: VALID_PNG_BASE64 }])],
      ),
    );
    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: orgA.orgId, envelopeId: ids.completedEnv },
    );

    // 2. Seed an unsealed `draft` standalone envelope in Org A.
    const draftDoc = await ingestPdf(orgA.orgId, adminUser, 'draft-contract');
    const createdDraft = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Hop dong dang soan', sourceFileId: draftDoc.fileId, routingMode: 'parallel' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    ids.draftEnv = createdDraft.envelopeId;

    // 3. Seed confidential `hr_contract` and `meeting_minutes` envelopes in Org A, plus an Org B envelope.
    const hrDoc = await ingestPdf(orgA.orgId, adminUser, 'hr-secret');
    ids.hrEnv = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        {
          title: 'Hop dong lao dong bi mat',
          sourceFileId: hrDoc.fileId,
          routingMode: 'parallel',
          sourceKind: 'hr_contract',
          sourceId: randomUUID(),
        },
        { actor: asUser(adminUser), orgId: orgA.orgId },
      )
    ).envelopeId;

    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Cuoc hop ban giam doc',
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [member.userId],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: 'Noi dung mat', decisions: ['Quyet dinh mat'] },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId, confirmed: true },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const mtgDoc = await ingestPdf(orgA.orgId, adminUser, 'mtg-secret');
    ids.mtgEnv = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        {
          title: 'Bien ban hop noi bo',
          sourceFileId: mtgDoc.fileId,
          routingMode: 'parallel',
          sourceKind: 'meeting_minutes',
          sourceId: meetingId,
        },
        { actor: asUser(adminUser), orgId: orgA.orgId },
      )
    ).envelopeId;

    const orgBDoc = await ingestPdf(orgB.orgId, foreignOwner, 'org-b');
    ids.orgBEnv = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title: 'Hop dong cong ty B', sourceFileId: orgBDoc.fileId, routingMode: 'parallel' },
        { actor: asUser(foreignOwner), orgId: orgB.orgId },
      )
    ).envelopeId;

    // 4. Seed an inspected active template in Org A with a signer role, a CC role, and a labeled `text` field.
    const tplDoc = await ingestPdf(orgA.orgId, adminUser, 'template-v1');
    ids.activeTpl = (
      await runtime.execute<{ templateId: string }>(
        'sign.template.create',
        {
          title: 'Mau hop dong dich vu chuan',
          description: 'Dung cho tich hop ERP',
          sourceFileId: tplDoc.fileId,
          routingMode: 'sequential',
          expiresInHours: 168,
        },
        { actor: asUser(adminUser), orgId: orgA.orgId },
      )
    ).templateId;
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: ids.activeTpl,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: ids.activeTpl,
        roles: [
          { roleKey: 'client', signerRole: 'signer', roleLabel: 'Khach hang', routingOrder: 1, deliveryMode: 'email', requireEmailOtp: true },
          { roleKey: 'legal_cc', signerRole: 'cc', roleLabel: 'Phap che', routingOrder: 2, deliveryMode: 'email', requireEmailOtp: false },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: ids.activeTpl,
        fields: [
          { roleKey: 'client', fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.75, wNorm: 0.25, hNorm: 0.1, required: true },
          { roleKey: 'client', fieldType: 'text', label: 'So hop dong', pageNumber: 1, xNorm: 0.1, yNorm: 0.2, wNorm: 0.3, hNorm: 0.05, required: true },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: ids.activeTpl, status: 'active' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );

    const directCreated = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      // Separate 1-signer template to hold a direct-link capability token we assert never leaks.
      {
        title: 'Mau 1 nguoi ky',
        sourceFileId: tplDoc.fileId,
        routingMode: 'parallel',
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    ids.directTpl = directCreated.templateId;
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: ids.directTpl,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: ids.directTpl,
        roles: [{ roleKey: 'signer_1', signerRole: 'signer', roleLabel: 'Ben ky', routingOrder: 1, deliveryMode: 'link', requireEmailOtp: false }],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: ids.directTpl,
        fields: [{ roleKey: 'signer_1', fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.1, required: true }],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: ids.directTpl, status: 'active' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    ids.directToken = (
      await runtime.execute<{ token: string }>(
        'sign.template.direct_link_set',
        { templateId: ids.directTpl, enabled: true, requireEmailOtp: false },
        { actor: asUser(adminUser), orgId: orgA.orgId },
      )
    ).token;
  }, 180_000);

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

  it('mints ludy_sk_* keys at the RPC edge for owners/admins only and stores zero cleartext secrets in Postgres, audit, or idempotency rows', async () => {
    for (const denied of [member, viewer]) {
      const res = await rpc('sign/api_keys/create', denied, { name: 'Denied Key', scopes: ['sign:read'] });
      expect(res.status).toBe(403);
      const listRes = await rpc('sign/api_keys/list', denied, {});
      expect(listRes.status).toBe(403);
    }

    const readCreated = await rpc<{ apiKey: { id: string; keyPrefix: string; scopes: string[] }; secret: string }>(
      'sign/api_keys/create',
      owner,
      { name: 'Read Only Key', scopes: ['sign:read'] },
    );
    expect(readCreated.status).toBe(200);
    expect(readCreated.body.secret).toMatch(/^ludy_sk_[A-Za-z0-9_-]{43}$/);
    expect(readCreated.body.apiKey.keyPrefix).toBe(readCreated.body.secret.slice(0, 16));
    expect(readCreated.body.apiKey.scopes).toEqual(['sign:read']);
    readOnlySecret = readCreated.body.secret;

    const draftCreated = await rpc<{ apiKey: { id: string }; secret: string }>(
      'sign/api_keys/create',
      adminUser,
      { name: 'Draft Only Key', scopes: ['sign:draft'] },
    );
    expect(draftCreated.status).toBe(200);
    draftOnlySecret = draftCreated.body.secret;

    const fullCreated = await rpc<{ apiKey: { id: string }; secret: string }>(
      'sign/api_keys/create',
      adminUser,
      { name: 'ERP Full Key', scopes: ['sign:read', 'sign:draft'] },
    );
    expect(fullCreated.status).toBe(200);
    fullScopeSecret = fullCreated.body.secret;
    fullScopeKeyId = fullCreated.body.apiKey.id;

    // Verify SHA-256 storage and zero cleartext secret persistence anywhere in Postgres!
    await admin(async (c) => {
      const stored = await c.query<{ key_sha256: string }>(
        'SELECT key_sha256 FROM crove_sign.api_key WHERE org_id = $1 AND id = $2',
        [orgA.orgId, fullScopeKeyId],
      );
      expect(stored.rows[0]?.key_sha256).toBe(sha256Hex(fullScopeSecret));

      const auditLeak = await c.query(
        `SELECT 1 FROM ludy_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE $2`,
        [orgA.orgId, `%${fullScopeSecret.slice(16)}%`],
      );
      expect(auditLeak.rowCount).toBe(0);

      const idemLeak = await c.query(
        `SELECT 1 FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND response::text LIKE $2`,
        [orgA.orgId, `%${fullScopeSecret.slice(16)}%`],
      );
      expect(idemLeak.rowCount).toBe(0);
    });

    const listed = await rpc<{ items: Array<{ id: string; keyPrefix: string }> }>('sign/api_keys/list', owner, {});
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(3);
    expect(JSON.stringify(listed.body)).not.toContain(fullScopeSecret);
    expect(JSON.stringify(listed.body)).not.toContain(sha256Hex(fullScopeSecret));

    // ADR-0028 section 5: aal2 callers must hold fresh MFA (<= 5 min) to create an API key,
    // while revocation stays immediate even on stale aal2.
    const nowS = Math.floor(Date.now() / 1000);
    const staleMissingAmr = await rpc<{ code?: string }>(
      'sign/api_keys/create',
      owner,
      { name: 'Stale Missing AMR', scopes: ['sign:read'] },
      orgA.slug,
      { aal: 'aal2', mfaAt: null },
    );
    expect(staleMissingAmr.status).toBe(403);
    expect(staleMissingAmr.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const staleExpiredMfa = await rpc<{ code?: string }>(
      'sign/api_keys/create',
      owner,
      { name: 'Stale Expired MFA', scopes: ['sign:read'] },
      orgA.slug,
      { aal: 'aal2', mfaAt: nowS - 600 },
    );
    expect(staleExpiredMfa.status).toBe(403);
    expect(staleExpiredMfa.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const afterStaleList = await rpc<{ items: Array<{ id: string }> }>('sign/api_keys/list', owner, {});
    expect(afterStaleList.status).toBe(200);
    expect(afterStaleList.body.items).toHaveLength(3);

    const freshMfaCreated = await rpc<{ apiKey: { id: string }; secret: string }>(
      'sign/api_keys/create',
      owner,
      { name: 'Fresh MFA Key', scopes: ['sign:read'] },
      orgA.slug,
      { aal: 'aal2', mfaAt: nowS },
    );
    expect(freshMfaCreated.status).toBe(200);
    expect(freshMfaCreated.body.secret).toMatch(/^ludy_sk_/);

    const staleRevoke = await rpc<{ id: string; revokedAt: string | null }>(
      'sign/api_keys/revoke',
      owner,
      { apiKeyId: freshMfaCreated.body.apiKey.id },
      orgA.slug,
      { aal: 'aal2', mfaAt: nowS - 600 },
    );
    expect(staleRevoke.status).toBe(200);
    expect(staleRevoke.body.revokedAt).not.toBeNull();

    // Duplicate active API key labels reject with 409 SIGN_API_KEY_DUPLICATE_NAME (case-insensitive),
    // while reusing the name of a revoked key succeeds cleanly (#4510).
    const dupActive = await rpc<{ code?: string }>(
      'sign/api_keys/create',
      owner,
      { name: 'erp full key', scopes: ['sign:read'] },
    );
    expect(dupActive.status).toBe(409);
    expect(dupActive.body).toMatchObject({ code: 'SIGN_API_KEY_DUPLICATE_NAME' });

    const reuseRevokedName = await rpc<{ apiKey: { id: string } }>(
      'sign/api_keys/create',
      owner,
      { name: 'Fresh MFA Key', scopes: ['sign:read'] },
      orgA.slug,
      { aal: 'aal2', mfaAt: nowS },
    );
    expect(reuseRevokedName.status).toBe(200);
    expect(
      (
        await rpc('sign/api_keys/revoke', owner, { apiKeyId: reuseRevokedName.body.apiKey.id })
      ).status,
    ).toBe(200);
  });

  it('enforces query-token rejection, no-store headers, Bearer SHA-256 auth, and sign:read vs sign:draft scope separation', async () => {
    for (const qs of ['token=abc', 'api_key=abc', 'access_token=abc', 'key=abc']) {
      const res = await apiGet(`/api/v1/sign/envelopes?${qs}`, `Bearer ${readOnlySecret}`);
      expect(res.status).toBe(400);
      assertNoStoreHeaders(res);
      await expect(res.json()).resolves.toMatchObject({ code: 'SIGN_QUERY_TOKEN_FORBIDDEN' });
    }

    for (const badAuth of [
      undefined,
      'Basic dXNlcjpwYXNz',
      'Bearer not_a_ludy_key',
      `Bearer ludy_sk_${'A'.repeat(43)}`,
    ]) {
      const res = await apiGet('/api/v1/sign/envelopes', badAuth);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      assertNoStoreHeaders(res);
    }

    // Scope separation: sign:draft key rejected on GET routes; sign:read key rejected on POST /from-template.
    for (const getPath of [
      '/api/v1/sign/envelopes',
      `/api/v1/sign/envelopes/${ids.completedEnv}`,
      `/api/v1/sign/envelopes/${ids.completedEnv}/sealed`,
      `/api/v1/sign/envelopes/${ids.completedEnv}/certificate`,
      '/api/v1/sign/templates',
    ]) {
      const res = await apiGet(getPath, `Bearer ${draftOnlySecret}`);
      expect(res.status, getPath).toBe(403);
      assertNoStoreHeaders(res);
    }

    const forbiddenPost = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      {
        templateId: ids.activeTpl,
        recipients: [{ roleKey: 'client', name: 'A', email: 'a@example.com' }],
      },
      `Bearer ${readOnlySecret}`,
    );
    expect(forbiddenPost.status).toBe(403);
    assertNoStoreHeaders(forbiddenPost);
  });

  it('answers opaque 404 when eSign is switched off or billing is unentitled, without updating last_used_at', async () => {
    const unentitledRes = await apiGet('/api/v1/sign/envelopes', `Bearer ${fullScopeSecret}`, appUnentitled);
    expect(unentitledRes.status).toBe(404);
    assertNoStoreHeaders(unentitledRes);

    await admin((c) =>
      c.query('UPDATE crove_sign.api_key SET last_used_at = NULL WHERE org_id = $1 AND id = $2', [
        orgA.orgId,
        fullScopeKeyId,
      ]),
    );

    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asMfa(owner), orgId: orgA.orgId });
    try {
      for (const res of [
        await apiGet('/api/v1/sign/envelopes', `Bearer ${fullScopeSecret}`),
        await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}`, `Bearer ${fullScopeSecret}`),
        await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}/sealed`, `Bearer ${fullScopeSecret}`),
        await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}/certificate`, `Bearer ${fullScopeSecret}`),
        await apiGet('/api/v1/sign/templates', `Bearer ${fullScopeSecret}`),
        await apiPost(
          '/api/v1/sign/envelopes/from-template',
          { templateId: ids.activeTpl, recipients: [{ roleKey: 'client', name: 'A', email: 'a@example.com' }] },
          `Bearer ${fullScopeSecret}`,
        ),
      ]) {
        expect(res.status).toBe(404);
        assertNoStoreHeaders(res);
      }

      const lastUsed = await admin(async (c) =>
        (
          await c.query<{ last_used_at: string | null }>(
            'SELECT last_used_at FROM crove_sign.api_key WHERE org_id = $1 AND id = $2',
            [orgA.orgId, fullScopeKeyId],
          )
        ).rows[0]?.last_used_at,
      );
      expect(lastUsed).toBeNull();
    } finally {
      await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asMfa(owner), orgId: orgA.orgId });
    }
  });

  it('serves non-confidential envelopes, templates, verified sealed PDF, and verified audit certificate while excluding hr_contract, meeting_minutes, and Org B with 404 parity', async () => {
    const listRes = await apiGet('/api/v1/sign/envelopes', `Bearer ${readOnlySecret}`);
    expect(listRes.status).toBe(200);
    assertNoStoreHeaders(listRes);
    const listBody = (await listRes.json()) as { items: Array<{ id: string; status: string }> };
    expect(listBody.items.map((i) => i.id).sort()).toEqual([ids.completedEnv!, ids.draftEnv!].sort());

    const completedOnlyRes = await apiGet('/api/v1/sign/envelopes?status=completed&limit=10', `Bearer ${readOnlySecret}`);
    expect(completedOnlyRes.status).toBe(200);
    const completedOnly = (await completedOnlyRes.json()) as { items: Array<{ id: string }> };
    expect(completedOnly.items.map((i) => i.id)).toEqual([ids.completedEnv]);

    const inProgressRes = await apiGet('/api/v1/sign/envelopes?status=in_progress&limit=10', `Bearer ${readOnlySecret}`);
    expect(inProgressRes.status).toBe(200);
    const inProgressBody = (await inProgressRes.json()) as { items: Array<{ id: string }> };
    expect(inProgressBody.items).toEqual([]);

    const detailRes = await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}`, `Bearer ${readOnlySecret}`);
    expect(detailRes.status).toBe(200);
    const detailText = await detailRes.text();
    expect(detailText).not.toContain('private-signer-email@sign-v1.test');
    expect(detailText).not.toContain('+84912345678');
    expect(detailText).not.toContain(ids.signingToken!);

    // Confidential and foreign-org envelopes answer identical 404 across detail, sealed, and certificate!
    for (const hiddenId of [randomUUID(), ids.hrEnv!, ids.mtgEnv!, ids.orgBEnv!]) {
      for (const suffix of ['', '/sealed', '/certificate']) {
        const res = await apiGet(`/api/v1/sign/envelopes/${hiddenId}${suffix}`, `Bearer ${readOnlySecret}`);
        expect(res.status, `${hiddenId}${suffix}`).toBe(404);
      }
    }

    // Unsealed draft envelope returns 409 SIGN_ENVELOPE_NOT_SEALED on /sealed and /certificate.
    for (const suffix of ['/sealed', '/certificate']) {
      const unsealed = await apiGet(`/api/v1/sign/envelopes/${ids.draftEnv}${suffix}`, `Bearer ${readOnlySecret}`);
      expect(unsealed.status).toBe(409);
      await expect(unsealed.json()).resolves.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_SEALED' });
    }

    // Completed & sealed envelope streams verified PDF and verified JSON certificate.
    const sealedRes = await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}/sealed`, `Bearer ${readOnlySecret}`);
    expect(sealedRes.status).toBe(200);
    assertNoStoreHeaders(sealedRes);
    expect(sealedRes.headers.get('content-type')).toBe('application/pdf');
    const pdfBytes = new Uint8Array(await sealedRes.arrayBuffer());
    expect(Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    expect(sealedRes.headers.get('x-content-sha256')).toBe(sha256Hex(pdfBytes));

    const certRes = await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}/certificate`, `Bearer ${readOnlySecret}`);
    expect(certRes.status).toBe(200);
    assertNoStoreHeaders(certRes);
    expect(certRes.headers.get('content-type')).toContain('application/json');
    const certBytes = new Uint8Array(await certRes.arrayBuffer());
    expect(certRes.headers.get('x-content-sha256')).toBe(sha256Hex(certBytes));
    const certJson = JSON.parse(Buffer.from(certBytes).toString('utf8')) as { envelopeId?: string };
    expect(certJson.envelopeId).toBe(ids.completedEnv);

    // Templates list includes roles & textFieldLabels and never leaks direct-link tokens.
    const tplRes = await apiGet('/api/v1/sign/templates', `Bearer ${readOnlySecret}`);
    expect(tplRes.status).toBe(200);
    const tplText = await tplRes.text();
    expect(tplText).not.toContain(ids.directToken!);
    const tplBody = JSON.parse(tplText) as {
      items: Array<{ id: string; textFieldLabels: string[]; directLinkEnabled: boolean }>;
    };
    const foundTpl = tplBody.items.find((t) => t.id === ids.activeTpl);
    expect(foundTpl?.textFieldLabels).toEqual(['So hop dong']);
    const foundDirect = tplBody.items.find((t) => t.id === ids.directTpl);
    expect(foundDirect?.directLinkEnabled).toBe(true);
  });

  it('creates draft-only envelopes via POST /api/v1/sign/envelopes/from-template with textDefaults and zero signing tokens or outbound emails', async () => {
    const tokenCountBefore = await admin(async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_sign.signing_token WHERE org_id = $1', [orgA.orgId])).rows[0]!.n),
    );
    const mailCountBefore = await admin(async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.mail_message WHERE org_id = $1', [orgA.orgId])).rows[0]!.n),
    );

    const createRes = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      {
        templateId: ids.activeTpl,
        title: 'Hop dong ERP HD-2027-99',
        subject: 'Moi ky hop dong dich vu',
        message: 'Vui long kiem tra va ky.',
        recipients: [
          { roleKey: 'client', name: 'Tran Thi Doi Tac', email: 'doitac@example.com', deliveryMode: 'link', requireEmailOtp: false },
          { roleKey: 'legal_cc', name: 'Phong Phap Che', email: 'legal@example.com' },
        ],
        textDefaults: {
          'So hop dong': 'HD-2027-99',
        },
      },
      `Bearer ${draftOnlySecret}`,
    );

    expect(createRes.status).toBe(201);
    assertNoStoreHeaders(createRes);
    const created = (await createRes.json()) as { id: string; status: string; reviewUrl: string; [k: string]: unknown };
    expect(Object.keys(created).sort()).toEqual(['id', 'reviewUrl', 'status']);
    expect(created.status).toBe('draft');
    expect(created.reviewUrl).toBe(`http://localhost:8080/o/${orgA.slug}/sign/envelopes/${created.id}`);

    await admin(async (c) => {
      const envRow = (
        await c.query<{ status: string; source_kind: string; title: string }>(
          'SELECT status, source_kind, title FROM crove_sign.envelope WHERE org_id = $1 AND id = $2',
          [orgA.orgId, created.id],
        )
      ).rows[0]!;
      expect(envRow).toEqual({
        status: 'draft',
        source_kind: 'standalone',
        title: 'Hop dong ERP HD-2027-99',
      });

      const textField = (
        await c.query<{ value_text: string | null }>(
          `SELECT value_text FROM crove_sign.field WHERE org_id = $1 AND envelope_id = $2 AND field_type = 'text'`,
          [orgA.orgId, created.id],
        )
      ).rows[0]!;
      expect(textField.value_text).toBe('HD-2027-99');

      const evRow = (
        await c.query<{ event_type: string; actor_label: string; event_hash: string }>(
          `SELECT event_type, actor_label, event_hash FROM crove_sign.signing_event WHERE org_id = $1 AND envelope_id = $2`,
          [orgA.orgId, created.id],
        )
      ).rows[0]!;
      expect(evRow.event_type).toBe('envelope_created');
      expect(evRow.actor_label).toBe(`api_key:${draftOnlySecret.slice(0, 16)}`);
      expect(evRow.event_hash).toMatch(/^[0-9a-f]{64}$/);

      const tokenCountAfter = Number(
        (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_sign.signing_token WHERE org_id = $1', [orgA.orgId])).rows[0]!.n,
      );
      const mailCountAfter = Number(
        (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.mail_message WHERE org_id = $1', [orgA.orgId])).rows[0]!.n,
      );
      expect(tokenCountAfter).toBe(tokenCountBefore);
      expect(mailCountAfter).toBe(mailCountBefore);
    });

    // Human reviewer adjusts draft fields via sign.field.set -> prefilled value_text ('HD-2027-99') is preserved,
    // surfaced in /api/sign/view, accepted on /api/sign/submit without re-typing, and sealed into PDF.
    const draftClientSignerId = await admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_sign.signer WHERE org_id = $1 AND envelope_id = $2 AND role_key = 'client'`,
          [orgA.orgId, created.id],
        )
      ).rows[0]!.id,
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: created.id,
        fields: [
          {
            signerId: draftClientSignerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.1,
            yNorm: 0.75,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
          {
            signerId: draftClientSignerId,
            fieldType: 'text',
            label: 'So hop dong',
            pageNumber: 1,
            xNorm: 0.12,
            yNorm: 0.22,
            wNorm: 0.3,
            hNorm: 0.05,
            required: true,
          },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );

    const sentDraft = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: created.id },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const clientToken = sentDraft.links[0]!.token;

    const viewRes = await app.request('/api/sign/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
      body: JSON.stringify({ token: clientToken }),
    });
    expect(viewRes.status).toBe(200);
    const viewJson = (await viewRes.json()) as {
      state: string;
      fields: Array<{ id: string; fieldType: string; valueText?: string | null }>;
    };
    expect(viewJson.state).toBe('ready');
    const viewTextField = viewJson.fields.find((f) => f.fieldType === 'text')!;
    const viewSigField = viewJson.fields.find((f) => f.fieldType === 'signature')!;
    expect(viewTextField.valueText).toBe('HD-2027-99');

    const submitRes = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
      body: JSON.stringify({
        token: clientToken,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [{ fieldId: viewSigField.id, signaturePngBase64: VALID_PNG_BASE64 }],
      }),
    });
    expect(submitRes.status).toBe(200);

    const sealOutcome = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: orgA.orgId, envelopeId: created.id },
    );
    expect(sealOutcome.status).toBe('sealed');

    // Missing required signer role (sending only optional CC role) returns 422 SIGN_RECIPIENT_REQUIRED.
    const badRoleRes = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      {
        templateId: ids.activeTpl,
        recipients: [{ roleKey: 'legal_cc', name: 'Only CC', email: 'cc@example.com' }],
      },
      `Bearer ${draftOnlySecret}`,
    );
    expect(badRoleRes.status).toBe(422);
    await expect(badRoleRes.json()).resolves.toMatchObject({ code: 'SIGN_RECIPIENT_REQUIRED' });

    // NUL byte in input returns 422 VALIDATION, never 500.
    const nulRes = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      {
        templateId: ids.activeTpl,
        title: 'Bad\u0000Title',
        recipients: [{ roleKey: 'client', name: 'Valid Name', email: 'v@example.com' }],
      },
      `Bearer ${draftOnlySecret}`,
    );
    expect(nulRes.status).toBe(422);
    await expect(nulRes.json()).resolves.toMatchObject({ code: 'VALIDATION' });

    // Non-active (draft) templates reject with 409 SIGN_TEMPLATE_NOT_ACTIVE, while active templates carrying
    // detectedTags + pageDimensions preserve inspection metadata onto created draft envelopes (#4510).
    const draftTplDoc = await ingestPdf(orgA.orgId, adminUser, 'draft-only-template');
    const draftOnlyTpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Mau ban nhap chua kich hoat', sourceFileId: draftTplDoc.fileId, routingMode: 'parallel' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: draftOnlyTpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [
          {
            pageNumber: 1,
            fieldType: 'signature',
            roleOrder: 1,
            roleKey: 'r1',
            required: true,
            label: null,
            xNorm: 0.1,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
          },
        ],
      },
      { actor: asSystem, orgId: orgA.orgId },
    );
    const draftTplReject = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      { templateId: draftOnlyTpl.templateId, recipients: [] },
      `Bearer ${draftOnlySecret}`,
    );
    expect(draftTplReject.status).toBe(409);
    await expect(draftTplReject.json()).resolves.toMatchObject({ code: 'SIGN_TEMPLATE_NOT_ACTIVE' });

    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: draftOnlyTpl.templateId,
        roles: [
          {
            roleKey: 'r1',
            signerRole: 'signer',
            roleLabel: 'Ben ky',
            routingOrder: 1,
            deliveryMode: 'email',
            requireEmailOtp: false,
          },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.template.update',
      { templateId: draftOnlyTpl.templateId, status: 'active' },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const inspectedDraftRes = await apiPost(
      '/api/v1/sign/envelopes/from-template',
      {
        templateId: draftOnlyTpl.templateId,
        recipients: [{ roleKey: 'r1', name: 'Inspected Client', email: 'inspected@example.com' }],
      },
      `Bearer ${draftOnlySecret}`,
    );
    expect(inspectedDraftRes.status).toBe(201);
    const inspectedDraftBody = (await inspectedDraftRes.json()) as { id: string };
    const envMeta = await admin((c) =>
      c.query<{
        inspect_status: string;
        inspect_error: string | null;
        page_count: number | null;
        page_dimensions_json: unknown[];
        detected_tags_json: unknown[];
      }>(
        `SELECT inspect_status, inspect_error, page_count, page_dimensions_json, detected_tags_json
         FROM ludy_sign.envelope WHERE org_id = $1::uuid AND id = $2::uuid`,
        [orgA.orgId, inspectedDraftBody.id],
      ),
    );
    expect(envMeta.rows[0]?.inspect_status).toBe('passed');
    expect(envMeta.rows[0]?.inspect_error).toBeNull();
    expect(envMeta.rows[0]?.page_count).toBe(1);
    expect(envMeta.rows[0]?.page_dimensions_json).toHaveLength(1);
    expect(envMeta.rows[0]?.detected_tags_json).toMatchObject([{ roleKey: 'r1', pageNumber: 1 }]);
  });

  it('enforces per-key rate limits (429 + Retry-After), unknown-key spray isolation, pdfReads isolation, immediate expiry/revocation (401), and org_purge', async () => {
    // Unknown-key Bearer spray returns 401 WITHOUT populating or exhausting per-key RateLimiter buckets.
    for (let i = 0; i < 5; i += 1) {
      const unknownRes = await apiGet(
        '/api/v1/sign/envelopes',
        `Bearer ludy_sk_${String(i).padStart(43, 'X')}`,
        appTightRate,
      );
      expect(unknownRes.status).toBe(401);
    }
    expect(tightKeyReadLimit.size).toBe(0);

    const first = await apiGet('/api/v1/sign/envelopes', `Bearer ${fullScopeSecret}`, appTightRate);
    expect(first.status).toBe(200);
    expect(tightKeyReadLimit.size).toBe(1);
    const orglessSpy = vi.fn(runtime.orgless);
    const peekOut = await runSignApiV1EnvelopesList(
      { orgless: orglessSpy } as unknown as Runtime,
      { entitlements: async () => ['full'] },
      `Bearer ${fullScopeSecret}`,
      {},
      (hash) => tightKeyReadLimit.take(hash),
      (hash) => tightKeyReadLimit.peek(hash),
    );
    expect(peekOut.status).toBe('rate_limited');
    expect(orglessSpy).not.toHaveBeenCalled();

    const second = await apiGet('/api/v1/sign/envelopes', `Bearer ${fullScopeSecret}`, appTightRate);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await expect(second.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests, please retry later',
    });

    // Seed a sealed envelope + API key in Org B so cross-org concurrency isolation can be verified (#4510, B3).
    const orgBSealedDoc = await ingestPdf(orgB.orgId, foreignOwner, 'org-b-sealed');
    const orgBSealedEnv = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title: 'Hop dong cong ty B da dong dau', sourceFileId: orgBSealedDoc.fileId, routingMode: 'parallel' },
        { actor: asUser(foreignOwner), orgId: orgB.orgId },
      )
    ).envelopeId;
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: orgBSealedEnv,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgB.orgId },
    );
    const orgBSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: orgBSealedEnv,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Ben B',
        name: 'Dai dien Cong ty B',
        email: 'signer-b@sign-v1.test',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(foreignOwner), orgId: orgB.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: orgBSealedEnv,
        fields: [
          {
            signerId: orgBSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.15,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
        ],
      },
      { actor: asUser(foreignOwner), orgId: orgB.orgId },
    );
    const orgBSent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: orgBSealedEnv },
      { actor: asUser(foreignOwner), orgId: orgB.orgId },
    );
    const orgBFieldRow = await admin(async (c) =>
      (
        await c.query<{ id: string }>('SELECT id FROM ludy_sign.field WHERE org_id = $1 AND envelope_id = $2', [
          orgB.orgId,
          orgBSealedEnv,
        ])
      ).rows[0]!,
    );
    await admin((c) =>
      c.query(
        `SELECT ludy_sign.public_submit($1, true, 'draw', NULL, $2::jsonb, NULL, 'SignApiV1Inv/1.0', NULL)`,
        [sha256Hex(orgBSent.links[0]!.token), JSON.stringify([{ fieldId: orgBFieldRow.id, signaturePngBase64: VALID_PNG_BASE64 }])],
      ),
    );
    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: orgB.orgId, envelopeId: orgBSealedEnv },
    );
    const orgBKeyRes = await rpc<{ secret: string }>(
      'sign/api_keys/create',
      foreignOwner,
      { name: 'Org B Read Key', scopes: ['sign:read'] },
      orgB.slug,
    );
    expect(orgBKeyRes.status).toBe(200);
    const orgBReadSecret = orgBKeyRes.body.secret;

    // Saturated signApiV1Limits.pdfReads perKey for Org A returns 503 SIGN_PDF_BUSY while Org B succeeds (200).
    const releaseSlot = tightPdfReads.tryAcquire(orgA.orgId);
    expect(releaseSlot).not.toBeNull();
    try {
      const busySealed = await apiGet(`/api/v1/sign/envelopes/${ids.completedEnv}/sealed`, `Bearer ${readOnlySecret}`, appTightRate);
      expect(busySealed.status).toBe(503);
      await expect(busySealed.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });

      const orgBOkOnTight = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appTightRate,
        '198.51.100.99',
      );
      expect(orgBOkOnTight.status).toBe(200);
      expect(orgBOkOnTight.headers.get('content-type')).toContain('application/pdf');
    } finally {
      releaseSlot?.();
    }

    // Production default ConcurrencyLimiter({ total: SIGN_PDF_READS_MAX }) caps perKey below total (4 < 8):
    // saturating Org A's perKey slots returns 503 SIGN_PDF_BUSY for Org A while Org B still returns 200.
    const sealedOrgARow = await admin(async (c) =>
      (
        await c.query<{ sealed_storage_key: string }>(
          `SELECT sealed_storage_key FROM ludy_sign.envelope WHERE org_id = $1 AND id = $2`,
          [orgA.orgId, ids.completedEnv],
        )
      ).rows[0]!,
    );
    let releaseOrgABlobs!: () => void;
    const orgABlobsHeld = new Promise<void>((resolve) => {
      releaseOrgABlobs = resolve;
    });
    let orgAReadsEntered = 0;
    let notifyFourEntered!: () => void;
    const fourEntered = new Promise<void>((resolve) => {
      notifyFourEntered = resolve;
    });
    store.beforeGet = async (key: string) => {
      if (key === sealedOrgARow.sealed_storage_key) {
        orgAReadsEntered += 1;
        if (orgAReadsEntered === 4) notifyFourEntered();
        await orgABlobsHeld;
      }
    };
    try {
      const heldDownloads = Array.from({ length: 4 }, (_, idx) =>
        apiGet(
          `/api/v1/sign/envelopes/${ids.completedEnv}/sealed`,
          `Bearer ${readOnlySecret}`,
          appDefaultPdfLimits,
          `198.51.100.${40 + idx}`,
        ),
      );
      await fourEntered;

      const fifthOrgA = await apiGet(
        `/api/v1/sign/envelopes/${ids.completedEnv}/sealed`,
        `Bearer ${readOnlySecret}`,
        appDefaultPdfLimits,
        '198.51.100.44',
      );
      expect(fifthOrgA.status).toBe(503);
      await expect(fifthOrgA.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });

      const orgBConcurrent = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appDefaultPdfLimits,
        '198.51.100.99',
      );
      expect(orgBConcurrent.status).toBe(200);
      expect(orgBConcurrent.headers.get('content-type')).toContain('application/pdf');
      await orgBConcurrent.arrayBuffer();

      releaseOrgABlobs();
      const finished = await Promise.all(heldDownloads);
      for (const r of finished) {
        expect(r.status).toBe(200);
        await r.arrayBuffer();
      }
    } finally {
      store.beforeGet = null;
      releaseOrgABlobs();
    }

    // Combined process PDF pool ceiling (#4682): public /api/sign/pdf + /api/v1/sign/*/sealed share SIGN_PDF_READS_MAX (8).
    const pubDoc = await ingestPdf(orgA.orgId, adminUser, 'pub-pool-doc');
    const pubEnvId = (
      await runtime.execute<{ envelopeId: string }>(
        'sign.envelope.create',
        { title: 'Hop dong cong khai pool', sourceFileId: pubDoc.fileId, routingMode: 'parallel' },
        { actor: asUser(adminUser), orgId: orgA.orgId },
      )
    ).envelopeId;
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: pubEnvId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem, orgId: orgA.orgId },
    );
    const pubSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: pubEnvId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Ben A',
        name: 'Signer Pool',
        email: 'signer-pool@sign-v1.test',
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: pubEnvId,
        fields: [
          {
            signerId: pubSigner.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.15,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.1,
            required: true,
          },
        ],
      },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const pubSent = await runtime.execute<{ links: Array<{ token: string }> }>(
      'sign.envelope.send',
      { envelopeId: pubEnvId },
      { actor: asUser(adminUser), orgId: orgA.orgId },
    );
    const pubToken = pubSent.links[0]!.token;
    const pubStorageKey = fileKey(orgA.orgId, pubDoc.sha256);

    let releasePoolBlobs!: () => void;
    const poolBlobsHeld = new Promise<void>((resolve) => {
      releasePoolBlobs = resolve;
    });
    let poolEntered = 0;
    let notifyEightEntered!: () => void;
    const eightEntered = new Promise<void>((resolve) => {
      notifyEightEntered = resolve;
    });
    store.beforeGet = async (key: string) => {
      if (key === sealedOrgARow.sealed_storage_key || key === pubStorageKey) {
        poolEntered += 1;
        if (poolEntered === 8) notifyEightEntered();
        await poolBlobsHeld;
      }
    };
    try {
      const pubHeld = Array.from({ length: 4 }, (_, idx) =>
        appDefaultPdfLimits.request('/api/sign/pdf', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${110 + idx}`,
          },
          body: JSON.stringify({ token: pubToken }),
        }),
      );
      const v1Held = Array.from({ length: 4 }, (_, idx) =>
        apiGet(
          `/api/v1/sign/envelopes/${ids.completedEnv}/sealed`,
          `Bearer ${readOnlySecret}`,
          appDefaultPdfLimits,
          `198.51.100.${120 + idx}`,
        ),
      );
      await eightEntered;

      const ninthOrgB = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appDefaultPdfLimits,
        '198.51.100.199',
      );
      expect(ninthOrgB.status).toBe(503);
      await expect(ninthOrgB.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });

      releasePoolBlobs();
      for (const r of await Promise.all([...pubHeld, ...v1Held])) {
        expect(r.status).toBe(200);
        await r.arrayBuffer();
      }
    } finally {
      store.beforeGet = null;
      releasePoolBlobs();
    }

    // Response-body lifetime check (#4682): unread 200 PDF responses continue holding process pool slots
    // until consumed (.arrayBuffer()) or canceled (.body.cancel()).
    const unreadHeld: Response[] = [];
    try {
      for (let idx = 0; idx < 4; idx += 1) {
        const pubRes = await appDefaultPdfLimits.request('/api/sign/pdf', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${130 + idx}`,
          },
          body: JSON.stringify({ token: pubToken }),
        });
        expect(pubRes.status).toBe(200);
        unreadHeld.push(pubRes);

        const v1Res = await apiGet(
          `/api/v1/sign/envelopes/${ids.completedEnv}/sealed`,
          `Bearer ${readOnlySecret}`,
          appDefaultPdfLimits,
          `198.51.100.${140 + idx}`,
        );
        expect(v1Res.status).toBe(200);
        unreadHeld.push(v1Res);
      }

      const saturatedUnread = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appDefaultPdfLimits,
        '198.51.100.200',
      );
      expect(saturatedUnread.status).toBe(503);
      await expect(saturatedUnread.json()).resolves.toMatchObject({ code: 'SIGN_PDF_BUSY' });

      // Canceling one unread public PDF response frees its process slot immediately.
      await unreadHeld[0]!.body?.cancel();
      const afterCancel = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appDefaultPdfLimits,
        '198.51.100.201',
      );
      expect(afterCancel.status).toBe(200);
      await afterCancel.arrayBuffer();

      // Consuming one unread v1 sealed response also frees a slot immediately.
      await unreadHeld[1]!.arrayBuffer();
      const afterConsume = await apiGet(
        `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
        `Bearer ${orgBReadSecret}`,
        appDefaultPdfLimits,
        '198.51.100.202',
      );
      expect(afterConsume.status).toBe(200);
      await afterConsume.arrayBuffer();
    } finally {
      await Promise.all(unreadHeld.map((r) => r.body?.cancel().catch(() => {})));
    }

    // HEAD requests on /sealed and /certificate must release PDF pool slots immediately (Hono drops inner body on HEAD).
    for (let i = 0; i < 10; i += 1) {
      const headSealed = await appDefaultPdfLimits.request(`/api/v1/sign/envelopes/${ids.completedEnv}/sealed`, {
        method: 'HEAD',
        headers: {
          authorization: `Bearer ${readOnlySecret}`,
          'x-forwarded-for': `198.51.100.${210 + i}`,
        },
      });
      expect(headSealed.status).toBe(200);
      const headCert = await appDefaultPdfLimits.request(`/api/v1/sign/envelopes/${ids.completedEnv}/certificate`, {
        method: 'HEAD',
        headers: {
          authorization: `Bearer ${readOnlySecret}`,
          'x-forwarded-for': `198.51.100.${220 + i}`,
        },
      });
      expect(headCert.status).toBe(200);
    }
    const postHeadGet = await apiGet(
      `/api/v1/sign/envelopes/${orgBSealedEnv}/sealed`,
      `Bearer ${orgBReadSecret}`,
      appDefaultPdfLimits,
      '198.51.100.240',
    );
    expect(postHeadGet.status).toBe(200);
    await postHeadGet.arrayBuffer();

    // Revoking fullScopeKeyId via RPC cuts access immediately.
    const revRes = await rpc('sign/api_keys/revoke', owner, { apiKeyId: fullScopeKeyId });
    expect(revRes.status).toBe(200);
    const afterRevoke = await apiGet('/api/v1/sign/envelopes', `Bearer ${fullScopeSecret}`);
    expect(afterRevoke.status).toBe(401);

    // Expiring readOnlySecret cuts access immediately.
    await admin((c) =>
      c.query(`UPDATE crove_sign.api_key SET expires_at = now() - interval '1 minute' WHERE key_sha256 = $1`, [
        sha256Hex(readOnlySecret),
      ]),
    );
    const afterExpire = await apiGet('/api/v1/sign/envelopes', `Bearer ${readOnlySecret}`);
    expect(afterExpire.status).toBe(401);

    // Verify ludy_kernel.org_purge cleanly deletes an org holding crove_sign.api_key rows.
    const purgeOrg = await createOrg(runtime, asUser(owner), 'Cong ty Purge API Key');
    const purgeKeyRes = await rpc<{ apiKey: { id: string } }>(
      'sign/api_keys/create',
      owner,
      { name: 'Purge Test Key', scopes: ['sign:read'] },
      purgeOrg.slug,
    );
    expect(purgeKeyRes.status).toBe(200);

    const dayMs = 24 * 60 * 60 * 1000;
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [purgeOrg.orgId]);
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          purgeOrg.orgId,
          new Date(Date.now() - 40 * dayMs),
          owner.userId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
      await c.query('COMMIT');
    });

    const purgeLogs: string[] = [];
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => purgeLogs.push(l), error: (l) => purgeLogs.push(l) },
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign api key test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    const remaining = await admin(async (c) =>
      Number(
        (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_sign.api_key WHERE org_id = $1', [purgeOrg.orgId]))
          .rows[0]!.n,
      ),
    );
    expect(remaining).toBe(0);
  });
});
