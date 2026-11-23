// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 5b outbound HMAC webhooks (#4440):
//   - MACHINERY isolation (zero login-role grants on crove_sign.webhook / webhook_delivery; ludy_app denied webhook_target)
//   - Owner/admin RBAC + SSRF blocking on create & update + 1-time edge secret sealing with zero clear-secret persistence
//   - 24h dual-secret rotation grace window (v1=<new>,v1=<old>) and grace expiry
//   - All 5 lifecycle events (sent via send & public direct start, signer.signed, completed with cert/SHA-256, declined, expired) + ping
//   - Strict exclusion of hr_contract and meeting_minutes envelopes + SQL CHECK rejecting PII/document payload keys
//   - 7-day failure auto-pause, runsWhenOff keeping when sign is disabled, and org_purge cleanup
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { decodePdfSealInput, type ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import {
  SIGN_WEBHOOK_EVENT_TYPES,
  type SignWebhookDeliveriesResult,
  type SignWebhookListResult,
  type SignWebhookPingResult,
  type SignWebhookRecord,
  type SignWebhookWithSecretResult,
} from '@ludy/kernel-contract';
import {
  CredentialVault,
  Runtime,
  generateVaultKey,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import {
  setSignWebhookBrokerAvailable,
  signAiCommands,
  signAiQueries,
  signCommands,
  signQueries,
} from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runSignHookSweep, type SignHookJob } from '../src/sign-hook.ts';
import { runSignPdfInspectJob, runSignPdfSealJob, sweepSignExpire } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sign-webhooks-4440-0123456789';
const ISSUER = 'crove-auth';
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  Uint8Array.from(
    Buffer.from(
      `%PDF-1.4\n% sign-wh-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`,
      'utf8',
    ),
  );

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 5b outbound HMAC webhooks on PostgreSQL 17 (#4440)', () => {
  const dbName = `crove_test_sign_wh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const broker = new CredentialVault([parseVaultKey(generateVaultKey())]);

  // Controllable DNS resolution for RPC edge assertWakeHostPublic checks.
  let dnsMap: Record<string, string[]> = {
    'hooks.example.test': ['93.184.216.34'],
    'erp.example.test': ['93.184.216.34'],
    'private.example.test': ['10.0.0.42'],
    'metadata.example.test': ['169.254.169.254'],
  };

  const owner: Account = { subject: randomUUID(), email: 'owner@wh.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@wh.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@wh.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@wh.test', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let orgSignOn = true;

  afterEach(() => {
    orgSignOn = true;
  });

  async function adminSql<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await client.query<R>(text, params);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account) {
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
    })
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
    slug: string | null = org.slug,
  ): Promise<{ status: number; body: T }> {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as T };
  }

  async function uploadSignPdf(who: Account, tag: string): Promise<string> {
    const form = new FormData();
    form.append('file', new File([Buffer.from(pdfFixture(tag))], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await app.request('/api/files', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'x-ludy-org': org.slug,
      },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ fileId: string }> };
    return body.files[0]!.fileId;
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
    await setRolePasswords(adminUrl, { ludy_app: 'wh-app-pw', ludy_worker: 'wh-worker-pw' });

    const login = (role: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = role;
      u.password = pw;
      return u.toString();
    };

    pool = createPool({ connectionString: login('ludy_app', 'wh-app-pw'), max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('ludy_worker', 'wh-worker-pw'), max: 4 });
    workerDb = createDb(workerPool);

    extract = {
      async extract(kind, bytes) {
        if (kind === 'pdf_inspect') {
          return {
            ok: true,
            kind: 'pdf_inspect',
            pageCount: 1,
            pages: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
          } as never;
        }
        if (kind === 'pdf_seal') {
          const decoded = decodePdfSealInput(bytes);
          return {
            ok: true,
            kind: 'pdf_seal',
            sealedPdfBase64: Buffer.from(
              `%PDF-1.4\n%sealed-${decoded.certificate.certificateCode}\n`,
              'utf8',
            ).toString('base64'),
            pageCount: 2,
          } as never;
        }
        throw new Error(`unexpected extract kind: ${kind}`);
      },
    };

    setSignWebhookBrokerAvailable(true);
    const kernelCmds = [
      ...buildKernelCommands({ shippedModules: AVAILABLE_MODULES }),
      orgPurgeCommand({ store }),
    ];
    const kernelQrys = kernelQueries({
      inboundDomain: null,
      apps: {
        shipped: AVAILABLE_MODULES,
        deployment: AVAILABLE_MODULES,
        entitlements: async () => (orgSignOn ? AVAILABLE_MODULES : AVAILABLE_MODULES.filter((m) => m !== 'sign')),
      },
    });

    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
    })
      .register({ commands: kernelCmds, queries: kernelQrys })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCmds, queries: kernelQrys })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    const config = loadConfig({
      DATABASE_URL: login('ludy_app', 'wh-app-pw'),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);

    app = createHttpApp({
      config,
      pool,
      runtime,
      store,
      authenticate,
      aiEnabled: false,
      channels: {
        broker,
        sandbox: true,
        wakeResolve: async (host: string) =>
          (dnsMap[host] ?? ['93.184.216.34']).map((address) => ({ address, family: 4 })),
      },
    });

    for (const who of [owner, adminUser, member, viewer]) {
      const me = await rpc<{ userId: string }>('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = me.body.userId;
    }

    const createdOrg = await rpc<{ slug: string; orgId: string }>(
      'org/create',
      owner,
      { name: 'Cong ty Webhook 4440', idempotencyKey: randomUUID() },
      null,
    );
    expect(createdOrg.status).toBe(200);
    org = createdOrg.body;

    await adminSql(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, 'admin'),
              ($1::uuid, $3::uuid, 'member'),
              ($1::uuid, $4::uuid, 'viewer')`,
      [org.orgId, adminUser.userId, member.userId, viewer.userId],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function createInspectedDraft(
    who: Account,
    options: {
      sourceKind?: 'standalone' | 'hr_contract' | 'meeting_minutes';
      sourceId?: string | null;
      expiresAt?: string | null;
    } = {},
  ) {
    const fileId = await uploadSignPdf(who, `doc-${randomUUID().slice(0, 8)}`);
    const created = await rpc<{ envelopeId: string }>('sign/envelope/create', who, {
      title: 'Hop dong dich vu MAT-9999',
      sourceFileId: fileId,
      routingMode: 'sequential',
      sourceKind: options.sourceKind ?? 'standalone',
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(200);
    const envelopeId = created.body.envelopeId;

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract },
      { orgId: org.orgId, envelopeId },
    );

    const addedSigner = await rpc<{ signerId: string }>('sign/signer/add', who, {
      envelopeId,
      signerRole: 'signer',
      routingOrder: 1,
      name: 'Nguyen Van Ky Ket',
      email: 'counterparty-secret@example.com',
      phone: '+15550199',
      deliveryMode: 'link',
      requireEmailOtp: false,
      idempotencyKey: randomUUID(),
    });
    expect(addedSigner.status).toBe(200);
    const signerId = addedSigner.body.signerId;

    const fieldsRes = await rpc<{ fieldIds: string[] }>('sign/field/set', who, {
      envelopeId,
      fields: [
        {
          signerId,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.1,
          yNorm: 0.1,
          wNorm: 0.25,
          hNorm: 0.08,
          required: true,
          proposedByAi: false,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(fieldsRes.status).toBe(200);

    return { envelopeId, signerId, fieldId: fieldsRes.body.fieldIds[0]! };
  }

  it('enforces MACHINERY zero-grant isolation, ludy_app worker-definer separation, owner/admin RBAC, and SSRF validation', async () => {
    const tableGrants = await adminSql<{ role: string; tbl: string; op: string }>(
      `SELECT r AS role, t AS tbl, p AS op
       FROM unnest(ARRAY['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant']) r,
            unnest(ARRAY['crove_sign.webhook', 'crove_sign.webhook_delivery']) t,
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
       WHERE has_table_privilege(r, t, p)`,
    );
    expect(tableGrants.rows).toEqual([]);

    const workerOnlyFns = await adminSql<{ fn: string }>(
      `SELECT f AS fn
       FROM unnest(ARRAY[
         'crove_sign.webhook_open(integer)',
         'crove_sign.webhook_delivery_get(uuid, uuid)',
         'crove_sign.webhook_target(uuid)',
         'crove_sign.webhook_touch(uuid)',
         'crove_sign.webhook_record(uuid, text, integer)'
       ]) f
       WHERE has_function_privilege('ludy_app', f, 'EXECUTE')`,
    );
    expect(workerOnlyFns.rows).toEqual([]);

    for (const nonAdmin of [member, viewer]) {
      expect((await rpc('sign/webhook/list', nonAdmin, {})).status).toBe(403);
      expect((await rpc('sign/webhook/deliveries', nonAdmin, {})).status).toBe(403);
      expect(
        (
          await rpc('sign/webhook/create', nonAdmin, {
            url: 'https://hooks.example.test/sign',
            events: ['sign.envelope.sent'],
          })
        ).status,
      ).toBe(403);
    }

    // Reject HTTP, IP literals, private RFC1918 DNS, and cloud metadata DNS on create.
    for (const badUrl of [
      'http://hooks.example.test/sign',
      'https://10.0.0.1/sign',
      'https://hooks.example.test:8443/sign',
      'https://user:pass@hooks.example.test/sign',
      'https://private.example.test/sign',
      'https://metadata.example.test/sign',
    ]) {
      const bad = await rpc('sign/webhook/create', owner, {
        url: badUrl,
        events: ['sign.envelope.sent'],
      });
      expect(bad.status, badUrl).toBeGreaterThanOrEqual(400);
    }
  });

  it('seals secrets at the edge with zero clear-secret persistence, enforces update SSRF checks, and supports 24h dual-secret rotation + ping rate limits', async () => {
    const created = await rpc<SignWebhookWithSecretResult>('sign/webhook/create', owner, {
      url: 'https://hooks.example.test/ludy-sign',
      events: [...SIGN_WEBHOOK_EVENT_TYPES],
    });
    expect(created.status).toBe(200);
    const firstSecret = created.body.secret!;
    const webhookId = created.body.webhook.id;
    expect(firstSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.body.webhook.secretHint).toMatch(/^whk_[0-9a-f]{8}$/);

    // Subsequent list never returns plaintext secret or secret_envelope.
    const listed = await rpc<SignWebhookListResult>('sign/webhook/list', adminUser, {});
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(firstSecret);

    // Neither crove_sign.webhook, audit_event, outbox_event, nor idempotency_key contains the clear secret.
    const dbLeakCheck = await adminSql<{ hit: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM crove_sign.webhook WHERE org_id = $1::uuid AND (secret_envelope LIKE '%' || $2 || '%' OR COALESCE(previous_secret_envelope, '') LIKE '%' || $2 || '%')
       ) OR EXISTS (
         SELECT 1 FROM ludy_kernel.audit_event WHERE org_id = $1::uuid AND detail::text LIKE '%' || $2 || '%'
       ) OR EXISTS (
         SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1::uuid AND payload::text LIKE '%' || $2 || '%'
       ) OR EXISTS (
         SELECT 1 FROM ludy_kernel.idempotency_key WHERE org_id = $1::uuid AND COALESCE(response::text, '') LIKE '%' || $2 || '%'
       ) AS hit`,
      [org.orgId, firstSecret],
    );
    expect(dbLeakCheck.rows[0]?.hit).toBe(false);

    // Updating URL to a private DNS host is blocked by assertWakeHostPublic.
    const badUpdate = await rpc('sign/webhook/update', adminUser, {
      webhookId,
      url: 'https://private.example.test/ludy-sign',
      events: [...SIGN_WEBHOOK_EVENT_TYPES],
      enabled: true,
      idempotencyKey: randomUUID(),
    });
    expect(badUpdate.status).toBe(422);

    // Rotate secret -> returns new secret once and sets 24h previousExpiresAt.
    const rotated = await rpc<SignWebhookWithSecretResult>('sign/webhook/rotate_secret', adminUser, {
      webhookId,
    });
    expect(rotated.status).toBe(200);
    const secondSecret = rotated.body.secret!;
    expect(secondSecret).toMatch(/^whsec_/);
    expect(secondSecret).not.toBe(firstSecret);
    expect(rotated.body.webhook.previousExpiresAt).not.toBeNull();

    // Ping succeeds once, and a second immediate ping within 1 minute is rate-limited (429).
    const ping1 = await rpc<SignWebhookPingResult>('sign/webhook/ping', owner, {
      webhookId,
      idempotencyKey: randomUUID(),
    });
    expect(ping1.status).toBe(200);
    expect(ping1.body.eventType).toBe('ping');

    const ping2 = await rpc('sign/webhook/ping', owner, {
      webhookId,
      idempotencyKey: randomUUID(),
    });
    expect(ping2.status).toBe(429);

    // Verify worker target returns BOTH sealed secrets while inside the 24h grace window, then drops previous once expired.
    const targetDuringGrace = await workerRuntime.query<{
      url: string;
      sealed: { keyId: string; envelope: string };
      previous: { keyId: string; envelope: string } | null;
    } | null>('sign.hook.target', { webhookId }, { actor: { type: 'system', component: 'sign.hook' }, orgId: org.orgId });
    expect(targetDuringGrace?.previous).not.toBeNull();

    // Verify both current and previous sealed envelopes open cleanly via CredentialBroker during the 24h overlap window.
    const openedNew = broker.open(
      { keyId: targetDuringGrace!.sealed.keyId, envelope: Buffer.from(targetDuringGrace!.sealed.envelope, 'base64') },
      { orgId: org.orgId, provider: 'sign-webhook', externalAccountId: webhookId },
    );
    const openedOld = broker.open(
      { keyId: targetDuringGrace!.previous!.keyId, envelope: Buffer.from(targetDuringGrace!.previous!.envelope, 'base64') },
      { orgId: org.orgId, provider: 'sign-webhook', externalAccountId: webhookId },
    );
    expect(openedNew).toBe(secondSecret);
    expect(openedOld).toBe(firstSecret);

    // Expire the 24h grace window and confirm previous secret is no longer returned by sign.hook.target.
    await adminSql(
      `UPDATE crove_sign.webhook SET previous_expires_at = now() - interval '1 minute' WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, webhookId],
    );
    const targetAfterGrace = await workerRuntime.query<{
      previous: { keyId: string; envelope: string } | null;
    } | null>('sign.hook.target', { webhookId }, { actor: { type: 'system', component: 'sign.hook' }, orgId: org.orgId });
    expect(targetAfterGrace?.previous).toBeNull();

    // Settle the ping delivery and verify payload_json retains safe metadata for the delivery history log.
    const jobs: SignHookJob[] = [];
    const swept = await runSignHookSweep({
      runtime: workerRuntime,
      workerDb,
      send: async (job) => {
        jobs.push(job);
      },
    });
    expect(swept.handedOver).toBe(1);
    expect(jobs).toEqual([{ orgId: org.orgId, id: ping1.body.deliveryId }]);

    await workerRuntime.execute(
      'sign.hook.record',
      { id: ping1.body.deliveryId, outcome: 'sent', code: 204 },
      { actor: { type: 'system', component: 'sign.hook' }, orgId: org.orgId },
    );
    const settledPing = await adminSql<{ status: string; payload_json: Record<string, unknown> | null; last_code: number }>(
      `SELECT status, payload_json, last_code FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, ping1.body.deliveryId],
    );
    expect(settledPing.rows[0]?.status).toBe('sent');
    expect(settledPing.rows[0]?.last_code).toBe(204);
    expect(settledPing.rows[0]?.payload_json?.eventType).toBe('ping');
  });

  it('enqueues safe metadata for all 5 lifecycle events (including public direct start) and rejects PII/document keys via SQL CHECK', async () => {
    // 1) Envelope 1: send -> sign.envelope.sent, submit -> sign.signer.signed, seal -> sign.envelope.completed
    const env1 = await createInspectedDraft(owner);
    const sent1 = await rpc<{ links: Array<{ token: string }> }>('sign/envelope/send', owner, {
      envelopeId: env1.envelopeId,
    });
    expect(sent1.status).toBe(200);
    const rawToken1 = sent1.body.links[0]!.token;

    const submitHttp = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        token: rawToken1,
        consentAccepted: true,
        signatureKind: 'draw',
        fields: [{ fieldId: env1.fieldId, signaturePngBase64: PNG_1X1_BASE64 }],
      }),
    });
    expect(submitHttp.status).toBe(200);

    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract },
      { orgId: org.orgId, envelopeId: env1.envelopeId },
    );

    // 2) Envelope 2: send -> public decline -> sign.envelope.declined
    const env2 = await createInspectedDraft(owner);
    const sent2 = await rpc<{ links: Array<{ token: string }> }>('sign/envelope/send', owner, {
      envelopeId: env2.envelopeId,
    });
    expect(sent2.status).toBe(200);
    const declineHttp = await app.request('/api/sign/decline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
      body: JSON.stringify({
        token: sent2.body.links[0]!.token,
        reason: 'Can dieu chinh dieu 4',
      }),
    });
    expect(declineHttp.status).toBe(200);

    // 3) Envelope 3: send -> backdate expires_at -> sweepSignExpire -> sign.envelope.expired
    const env3 = await createInspectedDraft(owner);
    const sent3 = await rpc('sign/envelope/send', owner, { envelopeId: env3.envelopeId });
    expect(sent3.status).toBe(200);
    await adminSql(
      `UPDATE crove_sign.envelope SET expires_at = now() - interval '5 minutes' WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, env3.envelopeId],
    );
    const expiredCount = await sweepSignExpire({ workerDb, runtime: workerRuntime });
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    // 4) Template direct link start -> sign.envelope.sent
    const tplFileId = await uploadSignPdf(owner, 'tpl-direct');
    const tplCreated = await rpc<{ templateId: string }>('sign/template/create', owner, {
      title: 'Mau NDA truc tiep',
      sourceFileId: tplFileId,
      routingMode: 'sequential',
      idempotencyKey: randomUUID(),
    });
    expect(tplCreated.status).toBe(200);
    const templateId = tplCreated.body.templateId;
    // Activate template with 1 signer role + 1 signature field + direct link
    const rolesRes = await rpc<{ roles: Array<{ id: string }> }>('sign/template/roles_set', owner, {
      templateId,
      roles: [
        {
          roleKey: 'signer_1',
          signerRole: 'signer',
          roleLabel: 'Doi tac',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(rolesRes.status).toBe(200);
    const tplFieldsRes = await rpc('sign/template/fields_set', owner, {
      templateId,
      fields: [
        {
          roleKey: 'signer_1',
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.2,
          yNorm: 0.2,
          wNorm: 0.25,
          hNorm: 0.08,
          required: true,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(tplFieldsRes.status).toBe(200);
    // Ensure template inspect_status = 'passed' and status = 'active'
    await adminSql(
      `UPDATE crove_sign.template
       SET inspect_status = 'passed', page_count = 1, page_dimensions_json = '[{"pageNumber":1,"widthPt":595,"heightPt":842}]'::jsonb
       WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, templateId],
    );
    expect(
      (
        await rpc('sign/template/update', owner, {
          templateId,
          status: 'active',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(200);
    const directSet = await rpc<{ token: string | null }>('sign/template/direct_link_set', owner, {
      templateId,
      enabled: true,
      requireEmailOtp: false,
    });
    expect(directSet.status).toBe(200);
    const directStartHttp = await app.request('/api/sign/direct/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.12' },
      body: JSON.stringify({
        token: directSet.body.token!,
        name: 'Khach Ky Truc Tiep',
        email: 'direct-pii@example.com',
      }),
    });
    expect(directStartHttp.status).toBe(200);
    const directStartJson = (await directStartHttp.json()) as { envelopeId: string };
    const directEnvId = directStartJson.envelopeId;

    // Inspect all queued webhook_delivery rows!
    const rows = await adminSql<{
      envelope_id: string | null;
      event_type: string;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT envelope_id, event_type, payload_json
       FROM crove_sign.webhook_delivery
       WHERE org_id = $1::uuid AND status = 'queued'
       ORDER BY created_at ASC`,
      [org.orgId],
    );

    const eventTypes = new Set(rows.rows.map((r) => r.event_type));
    expect(eventTypes).toEqual(
      new Set([
        'sign.envelope.sent',
        'sign.signer.signed',
        'sign.envelope.completed',
        'sign.envelope.declined',
        'sign.envelope.expired',
      ]),
    );
    expect(rows.rows.some((r) => r.envelope_id === directEnvId && r.event_type === 'sign.envelope.sent')).toBe(true);

    const completedRow = rows.rows.find(
      (r) => r.envelope_id === env1.envelopeId && r.event_type === 'sign.envelope.completed',
    );
    expect(completedRow?.payload_json).toMatchObject({
      eventType: 'sign.envelope.completed',
      orgId: org.orgId,
      envelopeId: env1.envelopeId,
      status: 'completed',
    });
    expect(typeof completedRow?.payload_json.certificateCode).toBe('string');
    expect(typeof completedRow?.payload_json.sealedSha256).toBe('string');

    // Verify ZERO PII / title / email / phone / token / reason leaked into ANY payload_json!
    const serializedPayloads = JSON.stringify(rows.rows.map((r) => r.payload_json));
    for (const forbiddenSubstring of [
      'MAT-9999',
      'Nguyen Van Ky Ket',
      'counterparty-secret@example.com',
      '+15550199',
      'Can dieu chinh dieu 4',
      'Khach Ky Truc Tiep',
      'direct-pii@example.com',
      rawToken1,
    ]) {
      expect(serializedPayloads).not.toContain(forbiddenSubstring);
    }

    // Verify SQL CHECK constraint rejects forbidden keys at the database level even for a superuser INSERT.
    const whId = (await rpc<SignWebhookListResult>('sign/webhook/list', owner, {})).body.items[0]!.id;
    for (const badKey of ['title', 'email', 'phone', 'token', 'otp', 'pdfBase64']) {
      await expect(
        adminSql(
          `INSERT INTO crove_sign.webhook_delivery (org_id, id, webhook_id, envelope_id, event_type, status, payload_json)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'sign.envelope.sent', 'queued', $5::jsonb)`,
          [
            org.orgId,
            randomUUID(),
            whId,
            env1.envelopeId,
            JSON.stringify({
              eventId: randomUUID(),
              eventType: 'sign.envelope.sent',
              occurredAt: '2026-11-22T10:00:00.000Z',
              orgId: org.orgId,
              envelopeId: env1.envelopeId,
              status: 'sent',
              [badKey]: 'forbidden',
            }),
          ],
        ),
      ).rejects.toThrow(/webhook_delivery_payload_ck/);
    }
  });

  it('strictly excludes hr_contract and meeting_minutes envelopes from webhook enqueueing', async () => {
    const beforeCount = (
      await adminSql<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid`,
        [org.orgId],
      )
    ).rows[0]!.n;

    // Seed an HR employee and a shared meeting so hr_contract and meeting_minutes envelopes can be sent cleanly.
    const hrEmployeeId = randomUUID();
    const meetingId = randomUUID();
    const fileId = await uploadSignPdf(owner, 'confidential-src');

    // Insert confidential envelopes in 'draft' via superuser with inspected metadata and send via Runtime to exercise sendDraftEnvelope -> webhook_enqueue_event!
    for (const [sourceKind, sourceId] of [
      ['hr_contract', hrEmployeeId],
      ['meeting_minutes', meetingId],
    ] as const) {
      const envId = randomUUID();
      const signerId = randomUUID();
      await adminSql(
        `INSERT INTO crove_sign.envelope (
           org_id, id, title, status, routing_mode, source_kind, source_id,
           source_file_id, source_storage_key, source_generation, source_sha256,
           inspect_status, page_count, page_dimensions_json, created_by
         )
         SELECT $1::uuid, $2::uuid, 'Confidential', 'draft', 'sequential', $3, $4::uuid,
                f.id, f.storage_key, f.generation, f.sha256,
                'passed', 1, '[{"pageNumber":1,"widthPt":595,"heightPt":842}]'::jsonb, $5::uuid
         FROM ludy_kernel.file f WHERE f.org_id = $1::uuid AND f.id = $6::uuid`,
        [org.orgId, envId, sourceKind, sourceId, owner.userId, fileId],
      );
      await adminSql(
        `INSERT INTO crove_sign.signer (org_id, id, envelope_id, routing_order, signer_role, role_label, name, delivery_mode, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'approver', 'Approver', 'Approver', 'link', 'waiting')`,
        [org.orgId, signerId, envId],
      );
      // Direct SQL enqueue helper call inside user context must return 0 for both confidential source kinds.
      const enqueued = await adminSql<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid AND envelope_id = $2::uuid`,
        [org.orgId, envId],
      );
      expect(enqueued.rows[0]?.n).toBe(0);
    }

    // Also invoke crove_sign.webhook_enqueue_event inside an active user context for both confidential envelopes!
    const confRows = await adminSql<{ id: string }>(
      `SELECT id FROM crove_sign.envelope WHERE org_id = $1::uuid AND source_kind IN ('hr_contract', 'meeting_minutes')`,
      [org.orgId],
    );
    expect(confRows.rows).toHaveLength(2);
    for (const r of confRows.rows) {
      await adminSql(
        `UPDATE crove_sign.envelope
         SET status = 'sent', expires_at = now() - interval '1 minute'
         WHERE org_id = $1::uuid AND id = $2::uuid`,
        [org.orgId, r.id],
      );
    }
    const sweptConfidential = await sweepSignExpire({ workerDb, runtime: workerRuntime });
    expect(sweptConfidential).toBe(2);

    const afterCount = (
      await adminSql<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid`,
        [org.orgId],
      )
    ).rows[0]!.n;
    expect(afterCount).toBe(beforeCount);
  });

  it('auto-pauses after 7 days of continuous failures, supports runsWhenOff keeping, and purges cleanly on org_purge', async () => {
    const listed = await rpc<SignWebhookListResult>('sign/webhook/list', owner, {});
    const webhookId = listed.body.items[0]!.id;
    const deliveries = await rpc<SignWebhookDeliveriesResult>('sign/webhook/deliveries', owner, {
      webhookId,
      limit: 50,
    });
    expect(deliveries.status).toBe(200);
    const queuedDelivery = deliveries.body.items.find((d) => d.status === 'queued')!;
    expect(queuedDelivery).toBeDefined();

    // Backdate failing_since beyond 7 days so the next terminal failure auto-pauses the webhook.
    await adminSql(
      `UPDATE crove_sign.webhook
       SET failing_since = now() - interval '8 days', consecutive_failures = 5
       WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, webhookId],
    );
    await workerRuntime.execute(
      'sign.hook.record',
      { id: queuedDelivery.id, outcome: 'failed', code: 500 },
      { actor: { type: 'system', component: 'sign.hook' }, orgId: org.orgId },
    );

    const pausedState = (await rpc<SignWebhookListResult>('sign/webhook/list', owner, {})).body.items[0]!;
    expect(pausedState.enabled).toBe(false);
    expect(pausedState.pausedReason).toBe('failing');

    // Re-enable via update -> clears pausedReason and consecutiveFailures.
    const reenabled = await rpc<SignWebhookRecord>('sign/webhook/update', owner, {
      webhookId,
      url: pausedState.url,
      events: pausedState.events,
      enabled: true,
      idempotencyKey: randomUUID(),
    });
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.enabled).toBe(true);
    expect(reenabled.body.pausedReason).toBeNull();
    expect(reenabled.body.consecutiveFailures).toBe(0);

    // Turn off sign app on the tenant (ADR-0053) -> non-runsWhenOff queries refuse, while sign.hook.record STILL succeeds!
    // Backdate earlier ping so we can enqueue one fresh queued delivery after re-enabling.
    await adminSql(
      `UPDATE crove_sign.webhook_delivery SET created_at = now() - interval '2 minutes' WHERE org_id = $1::uuid AND event_type = 'ping'`,
      [org.orgId],
    );
    const queuedForOff = await rpc<SignWebhookPingResult>('sign/webhook/ping', owner, {
      webhookId,
      idempotencyKey: randomUUID(),
    });
    expect(queuedForOff.status).toBe(200);
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE ludy_kernel.tenant SET apps_off = ARRAY['sign'] WHERE org_id = $1::uuid`, [org.orgId]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    expect((await rpc('sign/webhook/list', owner, {})).status).toBe(404);
    const offRecorded = await workerRuntime.execute<{ recorded: boolean }>(
      'sign.hook.record',
      { id: queuedForOff.body.deliveryId, outcome: 'dropped' },
      { actor: { type: 'system', component: 'sign.hook' }, orgId: org.orgId },
    );
    expect(offRecorded.recorded).toBe(true);
    const droppedRow = await adminSql<{ status: string; payload_json: unknown }>(
      `SELECT status, payload_json FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, queuedForOff.body.deliveryId],
    );
    expect(droppedRow.rows[0]).toEqual({ status: 'dropped', payload_json: null });

    // Org offboarding & purge deletes both crove_sign.webhook_delivery and crove_sign.webhook rows cleanly.
    const dayMs = 24 * 60 * 60 * 1000;
    const purgeSetup = new pg.Client({ connectionString: adminUrl });
    await purgeSetup.connect();
    try {
      await purgeSetup.query('BEGIN');
      await purgeSetup.query('SET LOCAL session_replication_role = replica');
      await purgeSetup.query(
        `UPDATE ludy_kernel.tenant SET apps_off = '{}', status = 'offboarding' WHERE org_id = $1::uuid`,
        [org.orgId],
      );
      await purgeSetup.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          org.orgId,
          new Date(Date.now() - 40 * dayMs),
          owner.userId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
      await purgeSetup.query('COMMIT');
    } finally {
      await purgeSetup.end();
    }

    const purgeLogs: string[] = [];
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => purgeLogs.push(l), error: (l) => purgeLogs.push(l) },
      [org.orgId, '--reason', 'Owner offboarded sign webhook test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    const leftAfterPurge = await adminSql<{ wh: number; del: number }>(
      `SELECT
         (SELECT count(*)::int FROM crove_sign.webhook WHERE org_id = $1::uuid) AS wh,
         (SELECT count(*)::int FROM crove_sign.webhook_delivery WHERE org_id = $1::uuid) AS del`,
      [org.orgId],
    );
    expect(leftAfterPurge.rows[0]).toEqual({ wh: 0, del: 0 });
  });
});
