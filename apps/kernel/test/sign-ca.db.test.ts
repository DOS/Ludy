// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end PostgreSQL 17 + crove-extract PAdES CMS worker & oRPC integration test (#3554):
//   - Exercises os.sign.ca.* HTTP RPC routes (settings, save_connection, test_connection, initiate_request, list_requests, disable_connection)
//   - Runs runSignCaReconcileJob against the real crove-extract pdf_inspect -> pdf_seal -> pdf_embed_cms sandbox
//   - Verifies ADR-0053 org_app_on('sign') gating on runSignCaReconcileJob and sweepSignPendingWork recovery
//   - Verifies CredentialVault seal/open round-trip for live CA adapters when SIGN_LIVE_CA_ENABLED=true
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient, type ExtractClient } from '@crove/extract-contract';
import { buildKernelCommands, kernelQueries } from '@crove/kernel';
import type {
  SignCaConnectionRecord,
  SignCaSettingsResult,
  SignCaSigningRequestRecord,
} from '@crove/kernel-contract';
import {
  CredentialVault,
  Runtime,
  generateVaultKey,
  mintContextToken,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@crove/kernel-runtime';
import {
  setSignCaBrokerAvailable,
  setSignLiveCaEnabled,
  signAiCommands,
  signAiQueries,
  signCommands,
  signQueries,
} from '@crove/mod-sign';
import {
  createMisaWeSignAdapter,
  createSandboxCaAdapter,
  createViettelMySignAdapter,
  createVnptSmartCaAdapter,
} from '@crove/sign';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import {
  runSignCaReconcileJob,
  runSignPdfInspectJob,
  runSignPdfSealJob,
  sweepSignPendingWork,
} from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sign-ca-3554-0123456789abcdef';
const ISSUER = 'crove-auth';

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

function buildValidOnePagePdf(label: string): Uint8Array {
  const contentStream = `BT /F1 14 Tf 50 780 Td (${label}) Tj ET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'ascii')} >>\nstream\n${contentStream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, 'ascii'));
    out += obj;
  }
  const xrefOffset = Buffer.byteLength(out, 'ascii');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, 'ascii'));
}

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 2c PAdES worker + crove-extract + oRPC on PostgreSQL 17 (#3554)', () => {
  const dbName = `crove_test_sign_ca_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let extract: ExtractClient;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const broker = new CredentialVault([parseVaultKey(generateVaultKey())]);

  const owner: Account = { subject: randomUUID(), email: 'owner@sign-ca-e2e.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@sign-ca-e2e.test', session: randomUUID(), userId: '' };
  const demotedCreator: Account = { subject: randomUUID(), email: 'creator@sign-ca-e2e.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@sign-ca-e2e.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@sign-ca-e2e.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let validPdfBytes: Uint8Array;

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

  async function rpc<T>(path: string, who: Account, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const raw = (await response.json().catch(() => null)) as ({ json?: T } & Record<string, unknown>) | null;
    return { status: response.status, body: (raw && 'json' in raw ? raw.json : raw) as T };
  }

  beforeAll(async () => {
    validPdfBytes = buildValidOnePagePdf('Hop dong thu nghiem ky so PAdES 3554');

    const extractApp = createExtractApp();
    extract = createExtractClient({
      url: 'http://extract.internal',
      fetch: (async (input, init) => extractApp.request(input, init)) as typeof fetch,
    });

    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'ca-e2e-app-pw', crove_worker: 'ca-e2e-worker-pw' });

    const login = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };

    pool = createPool({ connectionString: login('crove_app', 'ca-e2e-app-pw'), max: 6 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'ca-e2e-worker-pw'), max: 4 });
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const kernelQrys = kernelQueries({
      inboundDomain: null,
      apps: { shipped: AVAILABLE_MODULES, deployment: AVAILABLE_MODULES, entitlements: async () => AVAILABLE_MODULES },
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
      DATABASE_URL: login('crove_app', 'ca-e2e-app-pw'),
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
      },
    });

    for (const who of [owner, adminUser, demotedCreator, member, viewer]) {
      const meRes = await rpc<{ userId: string }>('me/get', who, undefined, null);
      expect(meRes.status).toBe(200);
      who.userId = meRes.body.userId;
    }

    const orgRes = await rpc<{ slug: string; orgId: string }>('org/create', owner, {
      name: 'Cong ty PAdES E2E',
      idempotencyKey: randomUUID(),
    }, null);
    expect(orgRes.status).toBe(200);
    org = orgRes.body;

    const adminClient = new pg.Client({ connectionString: adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1::uuid, $2::uuid, 'admin'),
                ($1::uuid, $3::uuid, 'admin'),
                ($1::uuid, $4::uuid, 'member'),
                ($1::uuid, $5::uuid, 'viewer')`,
        [org.orgId, adminUser.userId, demotedCreator.userId, member.userId, viewer.userId],
      );
    } finally {
      await adminClient.end();
    }
  }, 120_000);

  afterEach(() => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(true);
  });

  afterAll(async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(false);
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('completes end-to-end Sandbox PAdES CMS embedding via RPC + worker + real crove-extract and respects ADR-0053 app switch', async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(true);

    // 1. Boot config refuses SIGN_LIVE_CA_ENABLED=true while #62 is open, and live CA save over oRPC is refused with 422 SIGN_LIVE_CA_GATED.
    expect(() =>
      loadConfig({
        DATABASE_URL: adminUrl,
        AUTH_JWT_SECRET: SECRET,
        AUTH_ISSUER: ISSUER,
        SIGN_LIVE_CA_ENABLED: 'true',
      }),
    ).toThrow(/SIGN_LIVE_CA_ENABLED=true is refused until #62/);

    const gatedRes = await rpc<{ code?: string }>('sign/ca/save_connection', owner, {
      provider: 'vnpt_smartca',
      label: 'VNPT Gate Check',
      status: 'active',
      credentials: {
        provider: 'vnpt_smartca',
        spId: 'sp-check',
        spPassword: 'sp-secret-password',
        userId: 'vnpt-user-1',
      },
    });
    expect(gatedRes.status).toBe(422);

    // 2. Configure & test offline Sandbox PAdES over oRPC.
    const saveSandbox = await rpc<SignCaConnectionRecord>('sign/ca/save_connection', owner, {
      provider: 'sandbox',
      label: 'Sandbox PAdES E2E',
      certRef: 'sandbox-e2e-cert',
      status: 'active',
    });
    expect(saveSandbox.status).toBe(200);
    expect(saveSandbox.body.provider).toBe('sandbox');
    expect(saveSandbox.body.status).toBe('active');

    const testSandbox = await rpc<SignCaConnectionRecord>('sign/ca/test_connection', owner, {
      connectionId: saveSandbox.body.id,
    });
    expect(testSandbox.status).toBe(200);
    expect(testSandbox.body.lastTestState).toBe('works');

    // 3. Upload real PDF, inspect, add signer, send, sign, and seal via real crove-extract!
    const form = new FormData();
    form.append('file', new File([Buffer.from(validPdfBytes)], 'contract.pdf', { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const uploadRes = await app.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-crove-org': org.slug },
      body: form,
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { files: Array<{ fileId: string }> };
    const sourceFileId = uploaded.files[0]!.fileId;

    const envRes = await rpc<{ envelopeId: string }>('sign/envelope/create', owner, {
      title: 'Hop dong lao dong PAdES',
      routingMode: 'parallel',
      sourceKind: 'standalone',
      sourceFileId,
      idempotencyKey: randomUUID(),
    });
    expect(envRes.status).toBe(200);
    const envelopeId = envRes.body.envelopeId;

    const inspectDone = await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract },
      { orgId: org.orgId, envelopeId },
    );
    expect(inspectDone.status).toBe('passed');

    const signerRes = await rpc<{ signerId: string }>('sign/signer/add', owner, {
      envelopeId,
      signerRole: 'signer',
      roleLabel: 'Nguoi lao dong',
      name: 'Tran Thi C',
      deliveryMode: 'link',
      requireEmailOtp: false,
      idempotencyKey: randomUUID(),
    });
    expect(signerRes.status).toBe(200);

    const fieldRes = await rpc<{ fieldIds: string[] }>('sign/field/set', owner, {
      envelopeId,
      fields: [
        {
          signerId: signerRes.body.signerId,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.55,
          yNorm: 0.72,
          wNorm: 0.28,
          hNorm: 0.08,
          required: true,
          proposedByAi: false,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(fieldRes.status).toBe(200);

    const sendRes = await rpc<{ links: Array<{ token: string }> }>('sign/envelope/send', owner, { envelopeId });
    expect(sendRes.status).toBe(200);

    const valid1x1Png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const submitRes = await app.request('/api/sign/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sendRes.body.links[0]!.token,
        consentAccepted: true,
        signatureKind: 'type',
        signatureTypedText: 'Tran Thi C',
        fields: [
          {
            fieldId: fieldRes.body.fieldIds[0]!,
            signaturePngBase64: valid1x1Png,
            valueText: 'Tran Thi C',
          },
        ],
      }),
    });
    expect(submitRes.status).toBe(200);

    const sealDone = await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract },
      { orgId: org.orgId, envelopeId },
    );
    expect(sealDone.status).toBe('sealed');

    // 4. Initiate PAdES CA signing request over oRPC!
    const initiateRes = await rpc<SignCaSigningRequestRecord>('sign/ca/initiate_request', owner, {
      envelopeId,
      caConnectionId: saveSandbox.body.id,
      idempotencyKey: randomUUID(),
    });
    expect(initiateRes.status).toBe(200);
    expect(initiateRes.body.status).toBe('pending');
    const requestId = initiateRes.body.id;

    // 5. Turn Sign app OFF -> runSignCaReconcileJob must skip with skipped_app_off (ADR-0053)!
    const toggleOff = await rpc('org/setApp', owner, {
      module: 'sign',
      enabled: false,
      idempotencyKey: randomUUID(),
    });
    expect(toggleOff.status).toBe(200);

    const skippedOff = await runSignCaReconcileJob(
      { workerDb, runtime: workerRuntime, store, extract, broker },
      { orgId: org.orgId, requestId },
    );
    expect(skippedOff.status).toBe('skipped_app_off');

    // Turn Sign app back ON -> sweepSignPendingWork discovers the pending CA request!
    const toggleOn = await rpc('org/setApp', owner, {
      module: 'sign',
      enabled: true,
      idempotencyKey: randomUUID(),
    });
    expect(toggleOn.status).toBe(200);

    const recoveredIds: string[] = [];
    const swept = await sweepSignPendingWork({
      workerDb,
      olderThan: new Date(Date.now() + 5_000),
      enqueueInspect: async () => {},
      enqueueSeal: async () => {},
      enqueueCaReconcile: async (_orgId, rId) => {
        recoveredIds.push(rId);
      },
    });
    expect(swept.caReconcile).toBe(1);
    expect(recoveredIds).toContain(requestId);

    // 6. Run worker reconciliation with scripted pending -> signed sandbox adapter to test multi-step poll + real PDF CMS embed!
    const scriptedSandbox = createSandboxCaAdapter();
    scriptedSandbox.control.pendingPolls = 1;
    scriptedSandbox.control.script('pending');

    const firstTick = await runSignCaReconcileJob(
      {
        workerDb,
        runtime: workerRuntime,
        store,
        extract,
        broker,
        caAdapters: { sandbox: scriptedSandbox.adapter },
      },
      { orgId: org.orgId, requestId },
    );
    expect(firstTick.status).toBe('pending');
    expect(firstTick.pollAttempts).toBe(1);
    expect(firstTick.nextPollAt).toBeTruthy();
    expect(Date.parse(firstTick.nextPollAt!) - Date.now()).toBeLessThan(20_000);

    {
      const adminClient = new pg.Client({ connectionString: adminUrl });
      await adminClient.connect();
      try {
        await adminClient.query(
          "UPDATE crove_sign.ca_signing_request SET next_poll_at = now() - interval '1 second' WHERE org_id = $1::uuid AND id = $2::uuid",
          [org.orgId, requestId],
        );
      } finally {
        await adminClient.end();
      }
    }

    const secondTick = await runSignCaReconcileJob(
      {
        workerDb,
        runtime: workerRuntime,
        store,
        extract,
        broker,
        caAdapters: { sandbox: scriptedSandbox.adapter },
      },
      { orgId: org.orgId, requestId },
    );
    expect(secondTick.status).toBe('signed');
    expect(secondTick.padesFileId).toBeTruthy();

    // 7. Verify the stored PAdES PDF contains /ByteRange and /SubFilter /ETSI.CAdES.detached and downloads cleanly!
    const listRes = await rpc<{ items: SignCaSigningRequestRecord[] }>('sign/ca/list_requests', owner, { envelopeId });
    expect(listRes.status).toBe(200);
    expect(listRes.body.items[0]).toMatchObject({
      id: requestId,
      status: 'signed',
      subFilter: 'ETSI.CAdES.detached',
      padesFileId: secondTick.padesFileId,
    });

    const downloadRes = await app.request(`/api/files/${secondTick.padesFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-crove-org': org.slug },
    });
    expect(downloadRes.status).toBe(200);
    const padesBuf = Buffer.from(await downloadRes.arrayBuffer());
    const padesText = padesBuf.toString('latin1');
    expect(padesText).toContain('/ByteRange');
    expect(padesText).toContain('/ETSI.CAdES.detached');

    // Verify cryptographic ByteRange digest matches the exact digest signed by the CA and embedded inside /Contents CMS!
    const brMatch = padesText.match(/\/ByteRange\s*\[\s*0\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    expect(brMatch).not.toBeNull();
    const b1 = Number(brMatch![1]);
    const b2 = Number(brMatch![2]);
    const b3 = Number(brMatch![3]);
    const computedByteRangeDigest = createHash('sha256')
      .update(padesBuf.subarray(0, b1))
      .update(padesBuf.subarray(b2, b2 + b3))
      .digest('hex');
    expect(computedByteRangeDigest).toBe(listRes.body.items[0]!.digestSha256);
    const contentsHex = padesBuf.subarray(b1 + 1, b2 - 1).toString('ascii').toLowerCase();
    expect(contentsHex).toContain(computedByteRangeDigest);

    // 8. Standalone envelope PAdES request rows and pades_file_id downloads are readable by org members and viewers!
    for (const reader of [member, viewer]) {
      const readerList = await rpc<{ items: SignCaSigningRequestRecord[] }>('sign/ca/list_requests', reader, { envelopeId });
      expect(readerList.status).toBe(200);
      expect(readerList.body.items.map((item) => item.id)).toEqual([requestId]);

      const readerDownload = await app.request(`/api/files/${secondTick.padesFileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(reader)}`, 'x-crove-org': org.slug },
      });
      expect(readerDownload.status).toBe(200);
      const readerBytes = Buffer.from(await readerDownload.arrayBuffer());
      expect(readerBytes.equals(padesBuf)).toBe(true);
    }
  });

  it('seals, opens, and validates provider-specific credentials for VNPT, Viettel, and MISA via CredentialVault', async () => {
    setSignLiveCaEnabled(true);
    setSignCaBrokerAvailable(true);

    const cases = [
      {
        provider: 'vnpt_smartca' as const,
        credentials: {
          provider: 'vnpt_smartca' as const,
          spId: 'vnpt-sp-01',
          spPassword: 'super-secret-vnpt-pw-12345',
          userId: 'vnpt-user-01',
          serialNumber: '5401AABBCC',
        },
        secretSentinel: 'super-secret-vnpt-pw-12345',
        verifyAdapterAccepts: async (json: string) => {
          let calledUrl = '';
          const adapter = createVnptSmartCaAdapter({
            fetch: (async (url) => {
              calledUrl = String(url);
              return new Response(
                JSON.stringify({ code: 0, data: { list_cert: [{ serial_number: '5401AABBCC', status: 'ACTIVE', cert_data: '' }] } }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }) as typeof fetch,
          });
          await adapter.testConnection(json);
          expect(calledUrl).toContain('gwsca.vnpt.vn');
        },
      },
      {
        provider: 'viettel_mysign' as const,
        credentials: {
          provider: 'viettel_mysign' as const,
          clientId: 'viettel-client-id',
          clientSecret: 'super-secret-viettel-key-12345',
          userId: '0987654321',
          profileId: 'vt-profile-01',
          baseUrl: 'https://remotesigning.viettel.vn',
        },
        secretSentinel: 'super-secret-viettel-key-12345',
        verifyAdapterAccepts: async (json: string) => {
          let calledUrl = '';
          const adapter = createViettelMySignAdapter({
            fetch: (async (url) => {
              calledUrl = String(url);
              return new Response(JSON.stringify({ access_token: 'tok-vt' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }) as typeof fetch,
          });
          await adapter.testConnection(json);
          expect(calledUrl).toContain('remotesigning.viettel.vn');
        },
      },
      {
        provider: 'misa_wesign' as const,
        credentials: {
          provider: 'misa_wesign' as const,
          clientId: 'misa-app-01',
          clientKey: 'super-secret-misa-key-12345',
          username: 'ketoan@example.com',
          password: 'super-secret-misa-pw-67890',
          taxCode: '0101234567',
        },
        secretSentinel: 'super-secret-misa-key-12345',
        verifyAdapterAccepts: async (json: string) => {
          let calledUrl = '';
          const adapter = createMisaWeSignAdapter({
            fetch: (async (url) => {
              calledUrl = String(url);
              return new Response(JSON.stringify({ Success: true, Data: { remoteSigningAccessToken: 'tok-misa' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }) as typeof fetch,
          });
          await adapter.testConnection(json);
          expect(calledUrl).toContain('esignapp.misa.vn');
        },
      },
    ];

    for (const tc of cases) {
      const saveLive = await rpc<SignCaConnectionRecord>('sign/ca/save_connection', owner, {
        provider: tc.provider,
        label: `${tc.provider} Production`,
        certRef: `${tc.provider}-cert-2026`,
        status: 'active',
        credentials: tc.credentials,
      });
      expect(saveLive.status).toBe(200);
      expect(saveLive.body.provider).toBe(tc.provider);

      const settingsRes = await rpc<SignCaSettingsResult>('sign/ca/settings', owner, undefined);
      expect(settingsRes.status).toBe(200);
      expect(JSON.stringify(settingsRes.body)).not.toContain(tc.secretSentinel);

      const sealed = await workerRuntime.query<{
        id: string;
        provider: string;
        keyId: string;
        secretEnvelope: string;
      }>(
        'sign.ca.connection.secret',
        { connectionId: saveLive.body.id },
        { actor: { type: 'system', component: 'sign.worker' }, orgId: org.orgId },
      );
      expect(sealed.secretEnvelope).not.toContain(tc.secretSentinel);
      const openedJson = broker.open(
        { keyId: sealed.keyId, envelope: Buffer.from(sealed.secretEnvelope, 'base64') },
        { orgId: org.orgId, provider: `sign_ca:${tc.provider}`, externalAccountId: saveLive.body.id },
      );
      await tc.verifyAdapterAccepts(openedJson);
    }
  });

  it('enforces hr_contract confidentiality on ca_signing_request rows and pades_file_id downloads while preserving owner, admin, and creator access', async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(true);

    const saveSandbox = await rpc<SignCaConnectionRecord>('sign/ca/save_connection', owner, {
      provider: 'sandbox',
      label: 'Sandbox HR Confidentiality',
      certRef: 'sandbox-hr-cert',
      status: 'active',
    });
    expect(saveSandbox.status).toBe(200);

    const valid1x1Png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    async function createSealedHrPadesEnvelope(creator: Account, label: string) {
      const pdfBytes = buildValidOnePagePdf(label);
      const form = new FormData();
      form.append('file', new File([Buffer.from(pdfBytes)], `${label}.pdf`, { type: 'application/pdf' }));
      form.append('purpose', 'sign_document');
      const uploadRes = await app.request('/api/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${await tokenFor(creator)}`, 'x-crove-org': org.slug },
        body: form,
      });
      expect(uploadRes.status).toBe(200);
      const uploaded = (await uploadRes.json()) as { files: Array<{ fileId: string }> };
      const sourceFileId = uploaded.files[0]!.fileId;

      const envRes = await rpc<{ envelopeId: string }>('sign/envelope/create', creator, {
        title: `HR Contract ${label}`,
        routingMode: 'parallel',
        sourceKind: 'hr_contract',
        sourceId: randomUUID(),
        sourceFileId,
        idempotencyKey: randomUUID(),
      });
      expect(envRes.status).toBe(200);
      const envelopeId = envRes.body.envelopeId;

      const inspected = await runSignPdfInspectJob(
        { workerDb, runtime: workerRuntime, store, extract },
        { orgId: org.orgId, envelopeId },
      );
      expect(inspected.status).toBe('passed');

      const signerRes = await rpc<{ signerId: string }>('sign/signer/add', creator, {
        envelopeId,
        signerRole: 'signer',
        roleLabel: 'Employee',
        name: 'Nguyen Van D',
        deliveryMode: 'link',
        requireEmailOtp: false,
        idempotencyKey: randomUUID(),
      });
      expect(signerRes.status).toBe(200);

      const fieldRes = await rpc<{ fieldIds: string[] }>('sign/field/set', creator, {
        envelopeId,
        fields: [
          {
            signerId: signerRes.body.signerId,
            fieldType: 'signature',
            pageNumber: 1,
            xNorm: 0.5,
            yNorm: 0.7,
            wNorm: 0.25,
            hNorm: 0.08,
            required: true,
            proposedByAi: false,
          },
        ],
        idempotencyKey: randomUUID(),
      });
      expect(fieldRes.status).toBe(200);

      const sendRes = await rpc<{ links: Array<{ token: string }> }>('sign/envelope/send', creator, { envelopeId });
      expect(sendRes.status).toBe(200);

      const submitRes = await app.request('/api/sign/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: sendRes.body.links[0]!.token,
          consentAccepted: true,
          signatureKind: 'type',
          signatureTypedText: 'Nguyen Van D',
          fields: [
            {
              fieldId: fieldRes.body.fieldIds[0]!,
              signaturePngBase64: valid1x1Png,
              valueText: 'Nguyen Van D',
            },
          ],
        }),
      });
      expect(submitRes.status).toBe(200);

      const sealed = await runSignPdfSealJob(
        { workerDb, runtime: workerRuntime, store, extract },
        { orgId: org.orgId, envelopeId },
      );
      expect(sealed.status).toBe('sealed');

      const initRes = await rpc<SignCaSigningRequestRecord>('sign/ca/initiate_request', creator, {
        envelopeId,
        caConnectionId: saveSandbox.body.id,
        idempotencyKey: randomUUID(),
      });
      expect(initRes.status).toBe(200);

      const reconciled = await runSignCaReconcileJob(
        { workerDb, runtime: workerRuntime, store, extract, broker },
        { orgId: org.orgId, requestId: initRes.body.id },
      );
      expect(reconciled.status).toBe('signed');
      expect(reconciled.padesFileId).toBeTruthy();

      return { envelopeId, requestId: initRes.body.id, padesFileId: reconciled.padesFileId! };
    }

    const ownerHr = await createSealedHrPadesEnvelope(owner, 'hr-owner-confidential');
    const creatorHr = await createSealedHrPadesEnvelope(demotedCreator, 'hr-creator-confidential');

    // Demote creator from admin to member so created_by allow branch is exercised directly!
    {
      const adminClient = new pg.Client({ connectionString: adminUrl });
      await adminClient.connect();
      try {
        await adminClient.query(
          `UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1::uuid AND user_id = $2::uuid`,
          [org.orgId, demotedCreator.userId],
        );
      } finally {
        await adminClient.end();
      }
    }

    // Owner and admin can read ca_signing_request rows and download pades_file_id on ownerHr.
    for (const privileged of [owner, adminUser]) {
      const listRes = await rpc<{ items: SignCaSigningRequestRecord[] }>('sign/ca/list_requests', privileged, {
        envelopeId: ownerHr.envelopeId,
      });
      expect(listRes.status).toBe(200);
      expect(listRes.body.items.map((item) => item.id)).toEqual([ownerHr.requestId]);

      const dlRes = await app.request(`/api/files/${ownerHr.padesFileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(privileged)}`, 'x-crove-org': org.slug },
      });
      expect(dlRes.status).toBe(200);
    }

    // Demoted creator retains read access to their own hr_contract envelope's CA requests and PAdES file,
    // while still getting 404 on owner's hr_contract envelope!
    const creatorOwnList = await rpc<{ items: SignCaSigningRequestRecord[] }>('sign/ca/list_requests', demotedCreator, {
      envelopeId: creatorHr.envelopeId,
    });
    expect(creatorOwnList.status).toBe(200);
    expect(creatorOwnList.body.items.map((item) => item.id)).toEqual([creatorHr.requestId]);

    const creatorOwnDl = await app.request(`/api/files/${creatorHr.padesFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(demotedCreator)}`, 'x-crove-org': org.slug },
    });
    expect(creatorOwnDl.status).toBe(200);

    const creatorOtherDl = await app.request(`/api/files/${ownerHr.padesFileId}`, {
      headers: { authorization: `Bearer ${await tokenFor(demotedCreator)}`, 'x-crove-org': org.slug },
    });
    expect(creatorOtherDl.status).toBe(404);

    // Unauthorized member and viewer receive 404 on RPC list_requests, 404 on PAdES download,
    // 0 rows under PostgreSQL RLS on crove_sign.ca_signing_request, and false from crove_sign.can_read_sign_file!
    for (const unauthorized of [member, viewer]) {
      for (const hrTarget of [ownerHr, creatorHr]) {
        const listRes = await rpc('sign/ca/list_requests', unauthorized, { envelopeId: hrTarget.envelopeId });
        expect(listRes.status).toBe(404);

        const dlRes = await app.request(`/api/files/${hrTarget.padesFileId}`, {
          headers: { authorization: `Bearer ${await tokenFor(unauthorized)}`, 'x-crove-org': org.slug },
        });
        expect(dlRes.status).toBe(404);
      }

      const appClient = await pool.connect();
      try {
        await appClient.query('BEGIN');
        const ctxToken = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: unauthorized.userId,
          orgId: org.orgId,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        });
        await appClient.query(`SELECT crove_kernel.enter_user_context($1::uuid, $2::text)`, [org.orgId, ctxToken]);

        const rlsCount = await appClient.query<{ cnt: string }>(
          `SELECT count(*)::text AS cnt FROM crove_sign.ca_signing_request WHERE org_id = $1::uuid AND envelope_id = ANY($2::uuid[])`,
          [org.orgId, [ownerHr.envelopeId, creatorHr.envelopeId]],
        );
        expect(Number(rlsCount.rows[0]?.cnt ?? -1)).toBe(0);

        const canRead = await appClient.query<{ ok: boolean }>(
          `SELECT crove_sign.can_read_sign_file($1::uuid) AS ok`,
          [ownerHr.padesFileId],
        );
        expect(canRead.rows[0]?.ok).toBe(false);
        await appClient.query('ROLLBACK');
      } finally {
        appClient.release();
      }
    }
  });
});
