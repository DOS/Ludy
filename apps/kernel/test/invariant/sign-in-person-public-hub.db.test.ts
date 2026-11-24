// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for eSign Slice 4d (#3820, #4278):
//   - sign.signer.start_in_person RBAC/turn/role/hr_contract gates (viewer 403, waiting 409, cc 422, hr_contract 404)
//   - public_token_resolve omits internal inPersonHostUserId and locks allowDelegation = false
//   - Active in-person token blocks POST /api/sign/delegate & SQL public_delegate (403) without consuming token,
//     and public_mail_token_issue returns NULL while an unexpired in-person host session is active
//   - public_record_view and public_decline record host_user_id on signer_viewed and signer_declined events
//   - Public hub /-/sign/p/:orgSlug enforces no-Turnstile CSP (#203), ?token= rejection (400), opaque 404 parity,
//     zero leaked orgId/tokens, org_app_on/entitlement gating, OTP PDF blocks (403), and per-(IP + template) RateLimiter partitioning
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { SIGN_PUBLIC_HUB_PAGE_PREFIX } from '@ludy/kernel-contract';
import { DomainError, Runtime, contentGeneration, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { signCommands, signQueries, verifyEventChain } from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { TURNSTILE_ORIGIN, createHttpApp } from '../../src/http.ts';
import { runMailJob } from '../../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../../src/mail-templates.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-sign-4d-inv-0123456789abcdef';
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

const makePdf = (tag: string): Uint8Array =>
  Uint8Array.from(Buffer.from(`%PDF-1.4\n% 4d-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'));

function assertNoReferrerNoStore(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

suite('eSign Slice 4d in-person & public hub security invariants (#3820, #4278)', () => {
  const dbName = `ludy_test_sign_4d_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let orgSlug = '';
  let emptyOrgSlug = '';
  let ownerUserId = '';
  let memberUserId = '';
  let viewerUserId = '';

  const asOwner = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asMember = () => ({ type: 'user' as const, userId: memberUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asViewer = () => ({ type: 'user' as const, userId: viewerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
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
        'user-agent': 'Sign4dInvariant/1.0',
      },
      body: JSON.stringify(body),
    });
  }

  async function getHub(targetApp: ReturnType<typeof createHttpApp>, slug: string, ip = '198.51.100.10'): Promise<Response> {
    return targetApp.request(`/api/sign/public-hub/${slug}`, {
      method: 'GET',
      headers: {
        'x-forwarded-for': ip,
        'user-agent': 'Sign4dInvariant/1.0',
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
  }): Promise<{ templateId: string; directToken: string }> {
    const { fileId } = await ingestPdf(orgId, opts.title);
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
    await runtime.execute('sign.template.update', { templateId: created.templateId, status: 'active' }, { actor: asOwner(), orgId });
    const direct = await runtime.execute<{ token: string | null }>(
      'sign.template.direct_link_set',
      {
        templateId: created.templateId,
        enabled: true,
        requireEmailOtp: opts.requireEmailOtp,
        listedOnPublicHub: opts.listedOnPublicHub,
      },
      { actor: asOwner(), orgId },
    );
    return { templateId: created.templateId, directToken: direct.token! };
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'ludy-sign-4d-inv-web-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy Sign Hub</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 's4d-inv-app-pw', ludy_worker: 's4d-inv-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('ludy_app', 's4d-inv-app-pw');
    const workerUrl = login('ludy_worker', 's4d-inv-worker-pw');
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
    appUnentitled = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      billing: { entitlements: async () => [] },
    });

    ownerUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'owner-4d-inv',
      email: 'owner-4d-inv@example.com',
      name: 'Owner 4d Inv',
    });
    memberUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'member-4d-inv',
      email: 'member-4d-inv@example.com',
      name: 'Member 4d Inv',
    });
    viewerUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'viewer-4d-inv',
      email: 'viewer-4d-inv@example.com',
      name: 'Viewer 4d Inv',
    });

    const createdOrg = await createOrg(runtime, asOwner(), 'Cong ty Invariant Hub');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;
    const emptyOrg = await createOrg(runtime, asOwner(), 'Cong ty Rong Hub');
    emptyOrgSlug = emptyOrg.slug;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgId, memberUserId, viewerUserId],
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

  it('enforces in-person RBAC/turn/hr_contract gates, host_user_id attribution, delegation lock, mail guard, and no leaked hostUserId in resolve', async () => {
    const { fileId } = await ingestPdf(orgId, 'in-person-inv');
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'Bien ban tai quay Invariant',
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
        roleLabel: 'Khach',
        name: 'Khach Mot',
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
        roleLabel: 'Quan ly',
        name: 'Quan ly Hai',
        email: 'quanly-inv@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asOwner(), orgId },
    );
    const cc = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId,
        routingOrder: 3,
        signerRole: 'cc',
        roleLabel: 'Luu tru',
        name: 'Luu tru Ba',
        email: 'cc-inv@example.com',
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
    await runtime.execute('sign.envelope.send', { envelopeId }, { actor: asOwner(), orgId });

    // Viewer, waiting sequential signer, CC recipient, and confidential hr_contract non-creator all blocked.
    await expect(
      runtime.execute('sign.signer.start_in_person', { envelopeId, signerId: s1.signerId }, { actor: asViewer(), orgId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.execute('sign.signer.start_in_person', { envelopeId, signerId: s2.signerId }, { actor: asOwner(), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_SIGNER_NOT_DUE', status: 409 } satisfies Partial<DomainError>);
    await expect(
      runtime.execute('sign.signer.start_in_person', { envelopeId, signerId: cc.signerId }, { actor: asOwner(), orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SIGNER', status: 422 } satisfies Partial<DomainError>);

    const hrDoc = await ingestPdf(orgId, 'hr-inv');
    const hrEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: 'HR Confidential In-Person',
        sourceFileId: hrDoc.fileId,
        routingMode: 'parallel',
        sourceKind: 'hr_contract',
        sourceId: randomUUID(),
      },
      { actor: asOwner(), orgId },
    );
    await expect(
      runtime.execute(
        'sign.signer.start_in_person',
        { envelopeId: hrEnv.envelopeId, signerId: randomUUID() },
        { actor: asMember(), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 } satisfies Partial<DomainError>);

    // Member starts in-person session -> public_token_resolve exposes inPerson=true, allowDelegation=false, ZERO inPersonHostUserId.
    const started1 = await runtime.execute<{ tokenId: string; token: string }>(
      'sign.signer.start_in_person',
      { envelopeId, signerId: s1.signerId, expiresInMinutes: 30 },
      { actor: asMember(), orgId },
    );
    const token1Hash = sha256Hex(Buffer.from(started1.token, 'utf8'));
    const resolvedRow = await pool!.query<{ v: Record<string, unknown> | null }>(
      'SELECT ludy_sign.public_token_resolve($1, false) AS v',
      [token1Hash],
    );
    expect(resolvedRow.rows[0]?.v).toMatchObject({ inPerson: true, allowDelegation: false });
    expect(Object.prototype.hasOwnProperty.call(resolvedRow.rows[0]?.v ?? {}, 'inPersonHostUserId')).toBe(false);

    // View records signer_viewed WITH host_user_id and intact hash chain.
    const viewRes = await postJson(app, '/api/sign/view', { token: started1.token }, '198.51.100.21');
    expect(viewRes.status).toBe(200);

    // Active in-person token blocks POST /api/sign/delegate and SQL public_delegate cleanly.
    const delHttp = await postJson(
      app,
      '/api/sign/delegate',
      {
        token: started1.token,
        delegateName: 'Uy Quyen Cam',
        delegateEmail: 'blocked-del@example.com',
        reason: 'Test block',
      },
      '198.51.100.21',
    );
    expect(delHttp.status).toBe(403);
    const delSql = await pool!.query<{ result: Record<string, unknown> }>(
      `SELECT ludy_sign.public_delegate($1, 'Uy Quyen Cam', 'blocked-del@example.com', 'Test block', NULL, 'Sign4dInv/1.0', $2) AS result`,
      [token1Hash, DEFAULT_MESSAGE_ID_DOMAIN],
    );
    expect(delSql.rows[0]?.result).toMatchObject({ code: 'SIGN_DELEGATION_DISABLED', httpStatus: 403 });

    // Declining during in-person host ceremony records host_user_id on signer_declined and revokes open tokens.
    const decRes = await postJson(
      app,
      '/api/sign/decline',
      { token: started1.token, reason: 'Khach tu choi tai quay' },
      '198.51.100.21',
    );
    expect(decRes.status).toBe(200);

    const eventsRes = await runtime.query<{
      events: Array<{ eventType: string; signerId: string | null; hostUserId?: string | null }>;
    }>('sign.envelope.events', { envelopeId }, { actor: asOwner(), orgId });
    expect(
      eventsRes.events.find((ev) => ev.eventType === 'signer_viewed' && ev.signerId === s1.signerId)?.hostUserId,
    ).toBe(memberUserId);
    expect(
      eventsRes.events.find((ev) => ev.eventType === 'signer_declined' && ev.signerId === s1.signerId)?.hostUserId,
    ).toBe(memberUserId);

    // Also verify public_mail_token_issue returns NULL while an active unexpired in-person host token exists.
    const { fileId: mailFileId } = await ingestPdf(orgId, 'mail-guard');
    const mailEnv = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      { title: 'Mail Guard Env', sourceFileId: mailFileId, routingMode: 'parallel' },
      { actor: asOwner(), orgId },
    );
    await workerRuntime.execute(
      'sign.envelope.inspect_complete',
      {
        envelopeId: mailEnv.envelopeId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
        detectedTags: [],
      },
      { actor: asSystem, orgId },
    );
    const emailSigner = await runtime.execute<{ signerId: string }>(
      'sign.signer.add',
      {
        envelopeId: mailEnv.envelopeId,
        signerRole: 'signer',
        roleLabel: 'Ben ky',
        name: 'Remote Guard',
        email: 'remote-guard@example.com',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
      { actor: asOwner(), orgId },
    );
    await runtime.execute(
      'sign.field.set',
      {
        envelopeId: mailEnv.envelopeId,
        fields: [
          {
            signerId: emailSigner.signerId,
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
    await runtime.execute('sign.envelope.send', { envelopeId: mailEnv.envelopeId }, { actor: asOwner(), orgId });
    const startedInPersonMail = await runtime.execute<{ tokenId: string; token: string }>(
      'sign.signer.start_in_person',
      { envelopeId: mailEnv.envelopeId, signerId: emailSigner.signerId, expiresInMinutes: 30 },
      { actor: asOwner(), orgId },
    );
    const queuedMailId = await admin(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.mail_message WHERE org_id = $1 AND source_id = $2 AND template_key = 'sign.invite' LIMIT 1`,
        [orgId, emailSigner.signerId],
      );
      return r.rows[0]!.id;
    });

    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      const issuedRow = await workerClient.query<{ issued: unknown }>(
        `SELECT ludy_sign.public_mail_token_issue($1::uuid, $2::uuid, $3::uuid, now() + interval '7 days', now()) AS issued`,
        [mailEnv.envelopeId, emailSigner.signerId, queuedMailId],
      );
      expect(issuedRow.rows[0]?.issued).toBeNull();
      await workerClient.query('COMMIT');
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      workerClient.release();
    }

    const dispatched: OutboundMail[] = [];
    const spyMailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(m) {
        dispatched.push(m);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };
    await runMailJob(
      {
        runtime: workerRuntime,
        mailer: spyMailer,
        templates: MAIL_TEMPLATES,
        publicUrl: 'http://localhost:8080',
        bounceDomain: null,
        store,
      },
      { orgId, messageId: queuedMailId },
    );
    expect(dispatched).toHaveLength(0);

    await admin(async (c) => {
      const tokCheck = await c.query<{
        used_at: string | null;
        revoked_at: string | null;
        in_person_host_user_id: string | null;
      }>('SELECT used_at, revoked_at, in_person_host_user_id FROM ludy_sign.signing_token WHERE org_id = $1 AND id = $2', [
        orgId,
        startedInPersonMail.tokenId,
      ]);
      expect(tokCheck.rows[0]).toEqual({
        used_at: null,
        revoked_at: null,
        in_person_host_user_id: ownerUserId,
      });
    });

    // Event hash chain on declined envelope stays cryptographically valid.
    const rawEvents = await admin(async (c) => {
      const r = await c.query<{
        id: string;
        org_id: string;
        envelope_id: string;
        signer_id: string | null;
        host_user_id: string | null;
        seq: number;
        event_type: string;
        actor_type: 'ai' | 'signer' | 'system' | 'user';
        actor_id: string | null;
        actor_label: string;
        document_sha256: string;
        prev_event_hash: string | null;
        event_hash: string;
        payload_json: Record<string, unknown>;
        ip_hash: string | null;
        user_agent: string | null;
        occurred_at: Date;
      }>('SELECT * FROM ludy_sign.signing_event WHERE org_id = $1 AND envelope_id = $2 ORDER BY seq ASC', [
        orgId,
        envelopeId,
      ]);
      return r.rows;
    });
    expect(verifyEventChain(rawEvents).valid).toBe(true);
  });

  it('enforces public hub no-Turnstile CSP, ?token= rejection, opaque 404 parity, org_app_on/entitlement gates, and IP+template rate-limit isolation', async () => {
    const pageRes = await app.request(`${SIGN_PUBLIC_HUB_PAGE_PREFIX}/${orgSlug}`, { method: 'GET' });
    expect(pageRes.status).toBe(200);
    assertNoReferrerNoStore(pageRes);
    const csp = pageRes.headers.get('content-security-policy') ?? '';
    expect(csp.length).toBeGreaterThan(0);
    expect(csp).toContain('default-src');
    expect(csp).toContain('script-src');
    expect(csp).not.toContain(TURNSTILE_ORIGIN);

    expect((await app.request(`/api/sign/public-hub/${orgSlug}?token=leak`, { method: 'GET' })).status).toBe(400);
    expect(
      (await app.request(`/api/sign/public-hub/${orgSlug}?token=leak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })).status,
    ).toBe(400);

    const privateTpl = await setupTemplate({ title: 'Mau Bi Mat Hub Inv', requireEmailOtp: false, listedOnPublicHub: false });
    const unknownGet = await getHub(app, 'khong-ton-tai-org-404', '198.51.100.31');
    const emptyGet = await getHub(app, emptyOrgSlug, '198.51.100.31');
    const unlistedGet = await getHub(app, orgSlug, '198.51.100.31');
    const expected404 = { code: 'NOT_FOUND', message: 'Not found' };
    expect(unknownGet.status).toBe(404);
    expect(emptyGet.status).toBe(404);
    expect(unlistedGet.status).toBe(404);
    await expect(unknownGet.json()).resolves.toEqual(expected404);
    await expect(emptyGet.json()).resolves.toEqual(expected404);
    await expect(unlistedGet.json()).resolves.toEqual(expected404);

    // Malformed payload against unlisted template returns identical opaque 404 (never 422 oracle).
    expect(
      (await postJson(app, `/api/sign/public-hub/${orgSlug}`, { action: 'start', templateId: privateTpl.templateId, name: '', email: 'bad' }, '198.51.100.32')).status,
    ).toBe(404);

    const tplA = await setupTemplate({ title: 'Mau Cong Khai A', requireEmailOtp: false, listedOnPublicHub: true });
    const tplOtp = await setupTemplate({ title: 'Mau Cong Khai OTP', requireEmailOtp: true, listedOnPublicHub: true });

    const listRes = await getHub(app, orgSlug, '198.51.100.40');
    expect(listRes.status).toBe(200);
    assertNoReferrerNoStore(listRes);
    const listBody = (await listRes.json()) as { orgId?: unknown; items: Array<Record<string, unknown>> };
    expect(listBody.orgId).toBeUndefined();
    expect(JSON.stringify(listBody)).not.toContain(tplA.directToken);
    expect(JSON.stringify(listBody)).not.toContain('token_sha256');

    expect((await getHub(appUnentitled, orgSlug, '198.51.100.41')).status).toBe(404);
    expect((await postJson(app, `/api/sign/public-hub/${orgSlug}`, { action: 'pdf', templateId: tplOtp.templateId }, '198.51.100.42')).status).toBe(403);

    await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: false }, { actor: asOwner(), orgId });
    try {
      expect((await getHub(app, orgSlug, '198.51.100.43')).status).toBe(404);
      expect(
        (await postJson(app, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: tplA.templateId }, '198.51.100.43')).status,
      ).toBe(404);
    } finally {
      await runtime.execute('kernel.org.set_app', { module: 'sign', enabled: true }, { actor: asOwner(), orgId });
    }

    // Per-(IP + template) bucket partitioning (#4278): IP1 hitting 429 on tplA NEVER starves IP2 on tplA OR IP1 on tplOtp.
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
    const tightApp = createHttpApp({
      config: rlConfig,
      runtime,
      store,
      authenticate: createAuthenticator(rlConfig, appDb),
      pool: pool!,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      signPublicHubLimits: {
        templateActions: new RateLimiter({ perMinute: 2 }),
      },
    });

    expect((await postJson(tightApp, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: tplA.templateId }, '198.51.100.80')).status).toBe(200);
    expect((await postJson(tightApp, `/api/sign/public-hub/${orgSlug}`, { action: 'pdf', templateId: tplA.templateId }, '198.51.100.80')).status).toBe(200);
    const ip1Blocked = await postJson(tightApp, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: tplA.templateId }, '198.51.100.80');
    expect(ip1Blocked.status).toBe(429);
    expect(Number(ip1Blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Different IP on same template succeeds (no noisy-neighbor exhaustion across clients).
    expect((await postJson(tightApp, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: tplA.templateId }, '198.51.100.81')).status).toBe(200);
    // Same IP on a different template ALSO succeeds.
    expect((await postJson(tightApp, `/api/sign/public-hub/${orgSlug}`, { action: 'view', templateId: tplOtp.templateId }, '198.51.100.80')).status).toBe(200);
  });
});
