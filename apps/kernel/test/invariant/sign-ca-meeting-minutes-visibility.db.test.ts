// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for #4157 (ADR-0047):
//   - Meeting minutes confidentiality on ludy_sign.ca_signing_request and ca_signing_request.pades_file_id
//   - Non-reader owner, admin, outsider member, viewer, agent, and cross-org callers receive identical 404
//     across sign.ca.requests.by_envelope (sign/ca/list_requests), sign.ca.request.initiate, kernel.file.get,
//     and GET /api/files/:padesFileId, with 0 RLS rows on ludy_sign.ca_signing_request and false from
//     ludy_sign.can_read_sign_file
//   - Dynamic reader removal and meeting retention expiry revoke non-creator attendee CA/PAdES access
//     while retaining meeting creator access
//   - kernel.org.export.snapshot omits meeting_minutes envelopes, their ca_signing_request rows, and
//     their pades_file_id rows while preserving standalone CA envelopes and PAdES artifacts
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createExtractApp } from '@ludy/extract';
import { createExtractClient, type ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { SignCaConnectionRecord, SignCaSigningRequestRecord } from '@ludy/kernel-contract';
import {
  CredentialVault,
  Runtime,
  generateVaultKey,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import {
  setSignCaBrokerAvailable,
  setSignLiveCaEnabled,
  signCommands,
  signQueries,
} from '@ludy/mod-sign';
import { createAuthenticator } from '../../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import {
  runSignCaReconcileJob,
  runSignPdfInspectJob,
  runSignPdfSealJob,
} from '../../src/sign-worker.ts';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-sign-ca-mtg-inv-0123456789abcdef';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

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

const VALID_1X1_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

suite('eSign CA PAdES meeting minutes reader isolation invariants (#4157, ADR-0047)', () => {
  const dbName = `ludy_test_sign_ca_mtg_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let extract!: ExtractClient;
  let app!: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const broker = new CredentialVault([parseVaultKey(generateVaultKey())]);

  const owner: Account = { subject: randomUUID(), email: 'owner@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const recorder: Account = { subject: randomUUID(), email: 'recorder@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const attendee: Account = { subject: randomUUID(), email: 'attendee@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const outsiderMember: Account = { subject: randomUUID(), email: 'outsider@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@ca-mtg-inv.test', session: randomUUID(), userId: '' };
  const otherOwner: Account = { subject: randomUUID(), email: 'other@ca-mtg-inv.test', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, sessionId: who.session, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });

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

  async function rpc<T>(path: string, who: Account, input: unknown, slug: string = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        'x-crove-org': slug,
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const raw = (await response.json().catch(() => null)) as ({ json?: T } & Record<string, unknown>) | null;
    return { status: response.status, body: (raw && 'json' in raw ? raw.json : raw) as T };
  }

  beforeAll(async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(true);

    const extractApp = createExtractApp();
    extract = createExtractClient({
      url: 'http://extract.internal',
      fetch: (async (input, init) => extractApp.request(input, init)) as typeof fetch,
    });

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'ca-mtg-app-pw', ludy_worker: 'ca-mtg-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    pool = createPool({ connectionString: login('ludy_app', 'ca-mtg-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'ca-mtg-worker-pw'), max: 4 });
    const appDb = createDb(pool);
    workerDb = createDb(workerPool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const kernelQrys = kernelQueries({
      inboundDomain: null,
      apps: { shipped: AVAILABLE_MODULES, deployment: AVAILABLE_MODULES, entitlements: async () => AVAILABLE_MODULES },
    });

    runtime = new Runtime(appDb, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
    })
      .register({ commands: kernelCmds, queries: kernelQrys })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: kernelCmds, queries: kernelQrys })
      .register({ commands: meetingsCommands, queries: meetingsQueries })
      .register({ commands: signCommands, queries: signQueries });

    const config = loadConfig({
      DATABASE_URL: login('ludy_app', 'ca-mtg-app-pw'),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({
      config,
      pool,
      runtime,
      store,
      authenticate: createAuthenticator(config, appDb),
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    for (const acc of [owner, adminUser, recorder, attendee, outsiderMember, viewer, otherOwner]) {
      acc.userId = await upsertIdentity(appDb, {
        issuer: ISSUER,
        subject: acc.subject,
        email: acc.email,
        name: acc.email.split('@')[0]!,
      });
    }

    org = await createOrg(runtime, asUser(owner), 'Cong ty Bien Ban CA');
    otherOrg = await createOrg(runtime, asUser(otherOwner), 'Cong ty Khac CA');

    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, 'admin'),
       ($1::uuid, $3::uuid, 'admin'),
       ($1::uuid, $4::uuid, 'member'),
       ($1::uuid, $5::uuid, 'member'),
       ($1::uuid, $6::uuid, 'viewer')`,
      [org.orgId, adminUser.userId, recorder.userId, attendee.userId, outsiderMember.userId, viewer.userId],
    );
  }, 120_000);

  afterAll(async () => {
    setSignLiveCaEnabled(false);
    setSignCaBrokerAvailable(true);
    await pool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('isolates meeting_minutes ca_signing_request and pades_file_id across sign.ca.*, kernel.file.get, RLS, and kernel.org.export.snapshot', async () => {
    const saveSandbox = await rpc<SignCaConnectionRecord>('sign/ca/save_connection', owner, {
      provider: 'sandbox',
      label: 'Sandbox Meeting CA',
      certRef: 'sandbox-mtg-cert',
      status: 'active',
    });
    expect(saveSandbox.status).toBe(200);

    // 1. Recorder creates an attendees-only meeting readable ONLY by recorder + attendee (NOT owner, NOT admin).
    const { meetingId } = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Hop HDQT bao mat',
        language: 'vi',
        visibility: 'attendees',
        keepVideo: false,
        liveNotes: false,
        summaryTemplate: 'general',
        consentMethod: 'told_at_start',
        readerUserIds: [attendee.userId],
      },
      { actor: asUser(recorder), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: 'Tom tat quyet dinh bao mat.', decisions: ['Chot pades'] },
      { actor: asUser(recorder), orgId: org.orgId },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId, confirmed: true },
      { actor: asUser(recorder), orgId: org.orgId },
    );

    async function buildSealedPadesEnvelope(
      creator: Account,
      opts: { label: string; sourceKind: 'meeting_minutes' | 'standalone'; sourceId?: string },
    ) {
      const pdfBytes = buildValidOnePagePdf(opts.label);
      const form = new FormData();
      form.append('file', new File([Buffer.from(pdfBytes)], `${opts.label}.pdf`, { type: 'application/pdf' }));
      form.append('purpose', 'sign_document');
      const upRes = await app.request('/api/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${await tokenFor(creator)}`, 'x-crove-org': org.slug },
        body: form,
      });
      expect(upRes.status).toBe(200);
      const uploaded = (await upRes.json()) as { files: Array<{ fileId: string }> };
      const sourceFileId = uploaded.files[0]!.fileId;

      const envRes = await rpc<{ envelopeId: string }>('sign/envelope/create', creator, {
        title: opts.label,
        routingMode: 'parallel',
        sourceKind: opts.sourceKind,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        sourceFileId,
        idempotencyKey: randomUUID(),
      });
      expect(envRes.status).toBe(200);
      const envelopeId = envRes.body.envelopeId;

      const inspected = await runSignPdfInspectJob({ workerDb, runtime: workerRuntime, store, extract }, { orgId: org.orgId, envelopeId });
      expect(inspected.status).toBe('passed');

      const signerRes = await rpc<{ signerId: string }>('sign/signer/add', creator, {
        envelopeId,
        signerRole: 'signer',
        roleLabel: 'Thanh vien',
        name: 'Nguyen Van Ky',
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
            xNorm: 0.4,
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

      const sent = await rpc<{ links: Array<{ token: string }> }>('sign/envelope/send', creator, { envelopeId });
      expect(sent.status).toBe(200);

      const submit = await app.request('/api/sign/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: sent.body.links[0]!.token,
          consentAccepted: true,
          signatureKind: 'type',
          signatureTypedText: 'Nguyen Van Ky',
          fields: [{ fieldId: fieldRes.body.fieldIds[0]!, signaturePngBase64: VALID_1X1_PNG, valueText: 'Nguyen Van Ky' }],
        }),
      });
      expect(submit.status).toBe(200);

      const sealed = await runSignPdfSealJob({ workerDb, runtime: workerRuntime, store, extract }, { orgId: org.orgId, envelopeId });
      expect(sealed.status).toBe('sealed');

      const initiated = await rpc<SignCaSigningRequestRecord>('sign/ca/initiate_request', creator, {
        envelopeId,
        caConnectionId: saveSandbox.body.id,
        idempotencyKey: randomUUID(),
      });
      expect(initiated.status).toBe(200);

      const reconciled = await runSignCaReconcileJob(
        { workerDb, runtime: workerRuntime, store, extract, broker },
        { orgId: org.orgId, requestId: initiated.body.id },
      );
      expect(reconciled.status).toBe('signed');
      expect(reconciled.padesFileId).toBeTruthy();

      return { envelopeId, requestId: initiated.body.id, padesFileId: reconciled.padesFileId! };
    }

    const mtgCa = await buildSealedPadesEnvelope(recorder, {
      label: 'Bien ban hop HDQT CA',
      sourceKind: 'meeting_minutes',
      sourceId: meetingId,
    });
    const standaloneCa = await buildSealedPadesEnvelope(owner, {
      label: 'Hop dong thuong mai CA',
      sourceKind: 'standalone',
    });

    // Demote recorder to plain member after initiating CA so creator retention & non-privileged reader rules are exercised.
    await adminPool!.query(
      `UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1::uuid AND user_id = $2::uuid`,
      [org.orgId, recorder.userId],
    );

    // 2. Active meeting readers (recorder + attendee) CAN read CA requests, kernel.file.get, and HTTP /api/files/:id.
    for (const reader of [recorder, attendee]) {
      const caList = await runtime.query<{ items: SignCaSigningRequestRecord[] }>(
        'sign.ca.requests.by_envelope',
        { envelopeId: mtgCa.envelopeId },
        { actor: asUser(reader), orgId: org.orgId },
      );
      expect(caList.items.map((x) => x.id)).toEqual([mtgCa.requestId]);

      const rpcList = await rpc<{ items: SignCaSigningRequestRecord[] }>('sign/ca/list_requests', reader, {
        envelopeId: mtgCa.envelopeId,
      });
      expect(rpcList.status).toBe(200);
      expect(rpcList.body.items.map((x) => x.id)).toEqual([mtgCa.requestId]);

      const fileMeta = await runtime.query<{ id: string }>(
        'kernel.file.get',
        { id: mtgCa.padesFileId },
        { actor: asUser(reader), orgId: org.orgId },
      );
      expect(fileMeta.id).toBe(mtgCa.padesFileId);

      const dl = await app.request(`/api/files/${mtgCa.padesFileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(reader)}`, 'x-crove-org': org.slug },
      });
      expect(dl.status).toBe(200);
    }

    // 3. Non-readers (EVEN owner and admin, plus outsiderMember and viewer) receive identical 404 across:
    //    - sign.ca.requests.by_envelope (direct + HTTP RPC)
    //    - sign.ca.request.initiate (direct + HTTP RPC)
    //    - kernel.file.get & GET /api/files/:padesFileId
    //    - direct PostgreSQL RLS on ludy_sign.ca_signing_request + ludy_sign.can_read_sign_file
    for (const nonReader of [owner, adminUser, outsiderMember, viewer]) {
      await expect(
        runtime.query(
          'sign.ca.requests.by_envelope',
          { envelopeId: mtgCa.envelopeId },
          { actor: asUser(nonReader), orgId: org.orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });

      const rpcList = await rpc('sign/ca/list_requests', nonReader, { envelopeId: mtgCa.envelopeId });
      expect(rpcList.status).toBe(404);

      if (nonReader === owner || nonReader === adminUser) {
        await expect(
          runtime.execute(
            'sign.ca.request.initiate',
            { envelopeId: mtgCa.envelopeId, caConnectionId: saveSandbox.body.id },
            { actor: asUser(nonReader), orgId: org.orgId },
          ),
        ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
      } else {
        await expect(
          runtime.execute(
            'sign.ca.request.initiate',
            { envelopeId: mtgCa.envelopeId, caConnectionId: saveSandbox.body.id },
            { actor: asUser(nonReader), orgId: org.orgId },
          ),
        ).rejects.toMatchObject({ status: 403 });
      }

      const rpcInit = await rpc('sign/ca/initiate_request', nonReader, {
        envelopeId: mtgCa.envelopeId,
        caConnectionId: saveSandbox.body.id,
        idempotencyKey: randomUUID(),
      });
      expect(rpcInit.status).toBe(nonReader === owner || nonReader === adminUser ? 404 : 403);

      await expect(
        runtime.query('kernel.file.get', { id: mtgCa.padesFileId }, { actor: asUser(nonReader), orgId: org.orgId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

      const dl = await app.request(`/api/files/${mtgCa.padesFileId}`, {
        headers: { authorization: `Bearer ${await tokenFor(nonReader)}`, 'x-crove-org': org.slug },
      });
      expect(dl.status).toBe(404);

      const appClient = await pool!.connect();
      try {
        await appClient.query('BEGIN');
        await enterUser(appClient, nonReader.userId, org.orgId);

        const rlsRows = await appClient.query<{ cnt: string }>(
          'SELECT count(*)::text AS cnt FROM ludy_sign.ca_signing_request WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
          [org.orgId, mtgCa.envelopeId],
        );
        expect(Number(rlsRows.rows[0]?.cnt ?? -1)).toBe(0);

        const canRead = await appClient.query<{ ok: boolean }>(
          'SELECT ludy_sign.can_read_sign_file($1::uuid) AS ok',
          [mtgCa.padesFileId],
        );
        expect(canRead.rows[0]?.ok).toBe(false);
        await appClient.query('ROLLBACK');
      } finally {
        appClient.release();
      }
    }

    // Agent context sees zero meeting_minutes ca_signing_request rows and receives false from can_read_sign_file.
    const agentRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO ludy_kernel.agent (org_id, template_key, display_name, created_by)
       VALUES ($1::uuid, 'finance.chief_accountant', 'Sign Ca Mtg Probe Agent', $2::uuid)
       RETURNING id`,
      [org.orgId, owner.userId],
    );
    const agentId = agentRes.rows[0]!.id;
    const defaultLe = await adminPool!.query<{ id: string }>(
      'SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1::uuid AND is_default LIMIT 1',
      [org.orgId],
    );
    await adminPool!.query(
      `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_agent_id, le_scope)
       VALUES ($1::uuid, 'Probe Seat', 'finance', 'finance.chief_accountant', $2::uuid, ARRAY[$3::text])`,
      [org.orgId, agentId, defaultLe.rows[0]!.id],
    );
    const runRes = await adminPool!.query<{ id: string }>(
      `INSERT INTO ludy_kernel.ai_run (org_id, agent_id, module, status, expires_at)
       VALUES ($1::uuid, $2::uuid, 'finance', 'running', now() + interval '10 minutes')
       RETURNING id`,
      [org.orgId, agentId],
    );
    const runId = runRes.rows[0]!.id;
    const workerClient = await workerPool!.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
        org.orgId,
        agentId,
        runId,
      ]);
      const agentCaRows = await workerClient.query<{ cnt: string }>(
        'SELECT count(*)::text AS cnt FROM ludy_sign.ca_signing_request WHERE org_id = $1::uuid AND envelope_id = $2::uuid',
        [org.orgId, mtgCa.envelopeId],
      );
      expect(Number(agentCaRows.rows[0]?.cnt ?? -1)).toBe(0);
      const agentCanRead = await workerClient.query<{ ok: boolean }>(
        'SELECT ludy_sign.can_read_sign_file($1::uuid) AS ok',
        [mtgCa.padesFileId],
      );
      expect(agentCanRead.rows[0]?.ok).toBe(false);
      await workerClient.query('ROLLBACK');
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      workerClient.release();
    }

    // Cross-org isolation on CA request + PAdES file.
    await expect(
      runtime.query('sign.ca.requests.by_envelope', { envelopeId: mtgCa.envelopeId }, { actor: asUser(otherOwner), orgId: otherOrg.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('kernel.file.get', { id: mtgCa.padesFileId }, { actor: asUser(otherOwner), orgId: otherOrg.orgId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    // 4. Dynamic reader removal & meeting retention expiry revoke attendee access while keeping recorder creator access.
    await runtime.execute(
      'meetings.reader.remove',
      { meetingId, userId: attendee.userId },
      { actor: asUser(recorder), orgId: org.orgId },
    );
    await expect(
      runtime.query('sign.ca.requests.by_envelope', { envelopeId: mtgCa.envelopeId }, { actor: asUser(attendee), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('kernel.file.get', { id: mtgCa.padesFileId }, { actor: asUser(attendee), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    await runtime.execute(
      'meetings.reader.add',
      { meetingId, userId: attendee.userId },
      { actor: asUser(recorder), orgId: org.orgId },
    );
    await adminPool!.query(
      `UPDATE ludy_meetings.meeting
          SET text_retention_date = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [org.orgId, meetingId],
    );
    await expect(
      runtime.query('sign.ca.requests.by_envelope', { envelopeId: mtgCa.envelopeId }, { actor: asUser(attendee), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'SIGN_ENVELOPE_NOT_FOUND', status: 404 });
    await expect(
      runtime.query('kernel.file.get', { id: mtgCa.padesFileId }, { actor: asUser(attendee), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    // Creator retains access to their own meeting_minutes CA request and PAdES PDF.
    const creatorFile = await runtime.query<{ id: string }>(
      'kernel.file.get',
      { id: mtgCa.padesFileId },
      { actor: asUser(recorder), orgId: org.orgId },
    );
    expect(creatorFile.id).toBe(mtgCa.padesFileId);

    // 5. kernel.org.export.snapshot omits meeting_minutes CA request + pades_file_id while preserving standalone CA rows.
    const exportedCaIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'sign.ca_signing_request' },
      { actor: asSystem('org-export'), orgId: org.orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedCaIds.push((JSON.parse(line) as { id: string }).id);
        }
      },
    );
    expect(exportedCaIds).toContain(standaloneCa.requestId);
    expect(exportedCaIds).not.toContain(mtgCa.requestId);

    const exportedFileIds: string[] = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'kernel.file' },
      { actor: asSystem('org-export'), orgId: org.orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedFileIds.push((JSON.parse(line) as { id: string }).id);
        }
      },
    );
    expect(exportedFileIds).toContain(standaloneCa.padesFileId);
    expect(exportedFileIds).not.toContain(mtgCa.padesFileId);
  }, 60_000);
});
