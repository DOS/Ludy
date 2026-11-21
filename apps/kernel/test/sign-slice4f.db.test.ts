// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 + crove-extract sandbox integration tests for eSign Slice 4f (#3822):
// 2a. Sender-approved counterparty summary on /-/sign and /-/sign/d (never auto-published, never leaked pre-OTP,
//     mutable on draft/sent/in_progress by owner/admin/creator only, frozen on terminal envelopes, refused to AI agents).
// 2b. PDF Contract Version Diff ('sign/diff/compare'): 100% deterministic diff when AI is off/stopped/exhausted,
//     metered 'sign.version_diff' risk deltas when AI is on, and strict can_read_sign_file hr_contract confidentiality.
// 2c. Vietnamese SME Contract Drafter ('sign/drafter/renderPdf' & 'sign/drafter/proposeClauses'): real crove-extract
//     pdf_inspect + pdf_text + pdf_seal verification, 4 genuine embedded tags (r1/r2), and neutralized user/AI {{tags}}.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignAiReader } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import type { ExtractClient } from '@crove/extract-contract';
import { buildKernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type AgentActor, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { signCommands, signQueries } from '@crove/mod-sign';
import { memberMeter } from '../src/ai-meter.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runSignPdfInspectJob, runSignPdfSealJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sign-3822-0123456789abcdef';
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

const pdfFixture = (tag: string) =>
  Uint8Array.from(
    Buffer.from(`%PDF-1.4\n% sign-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 4f on PostgreSQL 17 + crove-extract (#3822)', () => {
  const dbName = `crove_test_sign_4f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let appAiOff: ReturnType<typeof createHttpApp>;
  let appAiOn: ReturnType<typeof createHttpApp>;
  let modelServer: Server;
  let realExtract: ExtractClient;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner@sign4f.test', session: randomUUID(), userId: '' };
  const memberCreator: Account = {
    subject: randomUUID(),
    email: 'creator@sign4f.test',
    session: randomUUID(),
    userId: '',
  };
  const otherMember: Account = {
    subject: randomUUID(),
    email: 'other@sign4f.test',
    session: randomUUID(),
    userId: '',
  };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@sign4f.test', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };

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

  async function rpcOn(
    targetApp: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account,
    input: unknown,
    options: { slug?: string | null; mfa?: boolean } = {},
  ) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who, options.mfa ? { mfa: true } : {})}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function publicPost(targetApp: ReturnType<typeof createHttpApp>, path: string, payload: unknown) {
    const res = await targetApp.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  }

  async function uploadSignDoc(who: Account, bytes: Uint8Array, filename: string) {
    const form = new FormData();
    form.append('file', new File([Buffer.from(bytes)], filename, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOff.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': org.slug },
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
      commands: [...kernelCmds, ...financeCommands, ...signCommands],
      queries: sharedQueries,
    });

    const extractApp = createExtractApp();
    realExtract = {
      async extract(kind, bytes) {
        const res = await extractApp.request(`/extract?kind=${kind}`, {
          method: 'POST',
          body: Buffer.from(bytes),
        });
        return (await res.json()) as never;
      },
    };

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);

    modelServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const isDiff = bodyStr.includes('version diff') || bodyStr.includes('Changed hunks');
      const content = isDiff
        ? {
            summaryText: 'Phí dịch vụ tăng từ 50.000.000 VND lên 75.000.000 VND.',
            riskDeltas: [
              {
                title: 'Tăng phí dịch vụ',
                severity: 'high',
                pageV1: 1,
                pageV2: 1,
                beforeQuote: 'Phí dịch vụ là 50.000.000 VND.',
                afterQuote: 'Phí dịch vụ là 75.000.000 VND.',
                explanation: 'Mức phí tăng lên 75.000.000 VND tại trang 1.',
              },
            ],
          }
        : {
            summaryNote: 'Đã đề xuất điều khoản bảo hành 6 tháng.',
            proposedClauses: [
              {
                heading: 'Bảo hành và hỗ trợ kỹ thuật {{signature, r9}}',
                body: 'Bên B bảo hành miễn phí trong 6 tháng kể từ ngày nghiệm thu {{date, r9}}.',
                rationale: 'Theo yêu cầu bảo hành 6 tháng của người soạn.',
              },
            ],
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-local-4f',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 180, completion_tokens: 75, total_tokens: 255 },
        }),
      );
    });
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', () => resolve()));
    const modelPort = (modelServer.address() as AddressInfo).port;

    const fakeReader = new SignAiReader({
      baseURL: `http://127.0.0.1:${modelPort}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 0,
    });

    const price = { inputPerMTok: '1000', outputPerMTok: '1000' };

    appAiOff = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      signAi: null,
    });

    appAiOn = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: true,
      aiPrice: price,
      aiMeter: (actor) => memberMeter(runtime, actor, { price }),
      signAi: fakeReader,
    });

    for (const who of [owner, memberCreator, otherMember, viewer]) {
      const me = await rpcOn(appAiOff, 'me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpcOn(
      appAiOff,
      'org/create',
      owner,
      { name: 'Công ty TNHH Sao Mai', idempotencyKey: randomUUID() },
      { slug: null },
    );
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [memberCreator, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpcOn(appAiOff, 'org/invite', owner, { email: who.email, role }, { mfa: true });
      expect(invite.status).toBe(200);
      const acceptToken = String(invite.body.acceptPath).split('#')[1];
      const accepted = await rpcOn(appAiOff, 'invites/accept', who, { token: acceptToken }, { slug: null });
      expect(accepted.status).toBe(200);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (modelServer ? modelServer.close(() => resolve()) : resolve()));
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const mockInspectExtract: ExtractClient = {
    async extract(kind) {
      if (kind === 'pdf_inspect') {
        return {
          ok: true,
          kind: 'pdf_inspect',
          pageCount: 2,
          pages: [
            { page: 1, widthPt: 595, heightPt: 842, rotation: 0 },
            { page: 2, widthPt: 595, heightPt: 842, rotation: 0 },
          ],
          detectedTags: [],
        } as never;
      }
      throw new Error(`unexpected extract kind ${kind}`);
    },
  };

  it('2a: enforces human-only creator/owner/admin summary rules, hides sharedSummary before OTP verification, and supports live sent-envelope toggling + /-/sign/d direct links', async () => {
    const fileId = await uploadSignDoc(memberCreator, pdfFixture('2a-summary'), 'hop-dong-2a.pdf');

    const envRes = await rpcOn(appAiOff, 'sign/envelope/create', memberCreator, {
      title: 'Hợp đồng tư vấn #2A',
      routingMode: 'parallel',
      sourceKind: 'standalone',
      sourceFileId: fileId,
      idempotencyKey: randomUUID(),
    });
    expect(envRes.status).toBe(200);
    const envelopeId = String(envRes.body.envelopeId);

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockInspectExtract },
      { orgId: org.orgId, envelopeId },
    );

    // Add 2 signers: signer 1 (no OTP) and signer 2 (OTP required)
    const s1Res = await rpcOn(appAiOff, 'sign/signer/add', memberCreator, {
      envelopeId,
      routingOrder: 1,
      signerRole: 'signer',
      roleLabel: 'Bên B1',
      name: 'Nguyễn Văn B1',
      deliveryMode: 'link',
      requireEmailOtp: false,
      idempotencyKey: randomUUID(),
    });
    expect(s1Res.status).toBe(200);
    const signer1Id = String(s1Res.body.signerId);

    const s2Res = await rpcOn(appAiOff, 'sign/signer/add', memberCreator, {
      envelopeId,
      routingOrder: 2,
      signerRole: 'signer',
      roleLabel: 'Bên B2 (OTP)',
      name: 'Trần Thị B2',
      email: 'b2-otp@counterparty.test',
      deliveryMode: 'link',
      requireEmailOtp: true,
      idempotencyKey: randomUUID(),
    });
    expect(s2Res.status).toBe(200);
    const signer2Id = String(s2Res.body.signerId);

    const fieldsRes = await rpcOn(appAiOff, 'sign/field/set', memberCreator, {
      envelopeId,
      fields: [
        { signerId: signer1Id, fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true },
        { signerId: signer2Id, fieldType: 'signature', pageNumber: 2, xNorm: 0.5, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08, required: true },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(fieldsRes.status).toBe(200);

    const summaryPayload = {
      summaryText: 'Tóm tắt hợp đồng tư vấn 2 trang đã được người gửi kiểm duyệt.',
      keyTerms: [
        {
          label: 'Phí dịch vụ',
          value: '50.000.000 VND',
          pageNumber: 1,
          quoteExcerpt: 'Tổng phí tư vấn trọn gói là 50.000.000 VND.',
        },
      ],
    };

    // Non-creator member and viewer are refused
    const forbiddenMember = await rpcOn(appAiOff, 'sign/envelope/shared_summary_set', otherMember, {
      envelopeId,
      shareSummaryWithSigners: true,
      sharedSummary: summaryPayload,
      idempotencyKey: randomUUID(),
    });
    expect(forbiddenMember.status).toBe(403);

    const forbiddenViewer = await rpcOn(appAiOff, 'sign/envelope/shared_summary_set', viewer, {
      envelopeId,
      shareSummaryWithSigners: true,
      sharedSummary: summaryPayload,
      idempotencyKey: randomUUID(),
    });
    expect(forbiddenViewer.status).toBe(403);

    // AI agent actor is refused (never auto-published without human review)
    const agentActor: AgentActor = {
      type: 'agent',
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    await expect(
      runtime.execute(
        'sign.envelope.shared_summary_set',
        {
          envelopeId,
          shareSummaryWithSigners: true,
          sharedSummary: summaryPayload,
          idempotencyKey: randomUUID(),
        },
        { orgId: org.orgId, actor: agentActor },
      ),
    ).rejects.toThrow();

    // Creator saves summary with shareSummaryWithSigners = false first -> never exposed publicly
    const savedPrivate = await rpcOn(appAiOff, 'sign/envelope/shared_summary_set', memberCreator, {
      envelopeId,
      shareSummaryWithSigners: false,
      sharedSummary: summaryPayload,
      idempotencyKey: randomUUID(),
    });
    expect(savedPrivate.status).toBe(200);
    expect(savedPrivate.body.shareSummaryWithSigners).toBe(false);

    // Send envelope
    const sendRes = await rpcOn(appAiOff, 'sign/envelope/send', memberCreator, { envelopeId });
    expect(sendRes.status).toBe(200);
    const links = sendRes.body.links as Array<{ signerId: string; token: string }>;
    const token1 = links.find((l) => l.signerId === signer1Id)!.token;
    const token2 = links.find((l) => l.signerId === signer2Id)!.token;

    // Signer 1 views while shareSummaryWithSigners=false -> sharedSummary is null
    const view1BeforeToggle = await publicPost(appAiOff, '/api/sign/view', { token: token1 });
    expect(view1BeforeToggle.status).toBe(200);
    expect(view1BeforeToggle.body?.state).toBe('ready');
    expect(view1BeforeToggle.body?.sharedSummary).toBeNull();

    // Creator toggles shareSummaryWithSigners = true on the live 'sent' envelope!
    const toggledLive = await rpcOn(appAiOff, 'sign/envelope/shared_summary_set', memberCreator, {
      envelopeId,
      shareSummaryWithSigners: true,
      sharedSummary: summaryPayload,
      idempotencyKey: randomUUID(),
    });
    expect(toggledLive.status).toBe(200);
    expect(toggledLive.body.shareSummaryWithSigners).toBe(true);

    // Signer 1 ('ready') NOW receives sharedSummary!
    const view1AfterToggle = await publicPost(appAiOff, '/api/sign/view', { token: token1 });
    expect(view1AfterToggle.status).toBe(200);
    expect(view1AfterToggle.body?.state).toBe('ready');
    expect(view1AfterToggle.body?.sharedSummary).toEqual(summaryPayload);

    // Signer 2 (OTP required, BEFORE OTP verification) gets 'otp_required' and ZERO sharedSummary leak!
    const view2PreOtp = await publicPost(appAiOff, '/api/sign/view', { token: token2 });
    expect(view2PreOtp.status).toBe(200);
    expect(view2PreOtp.body?.state).toBe('otp_required');
    expect(view2PreOtp.body?.sharedSummary).toBeUndefined();
    expect(JSON.stringify(view2PreOtp.body)).not.toContain('50.000.000');

    // Request + verify OTP for Signer 2 -> transitions to 'ready' and NOW exposes sharedSummary!
    const otpReq = await publicPost(appAiOff, '/api/sign/otp/request', { token: token2 });
    expect(otpReq.status).toBe(200);
    await admin(async (client) => {
      await client.query(
        `UPDATE crove_sign.signing_otp
            SET otp_sha256 = encode(sha256(convert_to('crove:sign:otp:v1:' || signer_id::text || ':' || id::text || ':654321', 'UTF8')), 'hex')
          WHERE org_id = $1 AND signer_id = $2 AND verified_at IS NULL AND invalidated_at IS NULL`,
        [org.orgId, signer2Id],
      );
    });
    const otpVerify = await publicPost(appAiOff, '/api/sign/otp/verify', { token: token2, code: '654321' });
    expect(otpVerify.status).toBe(200);
    expect(otpVerify.body?.ok).toBe(true);

    const view2PostOtp = await publicPost(appAiOff, '/api/sign/view', { token: token2 });
    expect(view2PostOtp.status).toBe(200);
    expect(view2PostOtp.body?.state).toBe('ready');
    expect(view2PostOtp.body?.sharedSummary).toEqual(summaryPayload);

    // Void the envelope -> terminal envelopes freeze sharedSummary writes
    const voided = await rpcOn(appAiOff, 'sign/envelope/void', memberCreator, {
      envelopeId,
      reason: 'Hủy thử nghiệm',
      idempotencyKey: randomUUID(),
    });
    expect(voided.status).toBe(200);

    const afterTerminal = await rpcOn(appAiOff, 'sign/envelope/shared_summary_set', owner, {
      envelopeId,
      shareSummaryWithSigners: false,
      sharedSummary: null,
      idempotencyKey: randomUUID(),
    });
    expect(afterTerminal.status).toBe(409);

    // Direct-signing template (/-/sign/d): otp_required hides sharedSummary; ready + child envelope inherit sharedSummary
    const tplCreate = await rpcOn(appAiOff, 'sign/template/create', owner, {
      title: 'Mẫu NDA công khai',
      routingMode: 'parallel',
      sourceFileId: fileId,
      idempotencyKey: randomUUID(),
    });
    expect(tplCreate.status).toBe(200);
    const templateId = String(tplCreate.body.templateId);

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockInspectExtract },
      { orgId: org.orgId, targetKind: 'template', templateId },
    );

    const rolesRes = await rpcOn(appAiOff, 'sign/template/roles_set', owner, {
      templateId,
      roles: [
        {
          roleKey: 'r1',
          signerRole: 'signer',
          roleLabel: 'Đối tác ký',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(rolesRes.status).toBe(200);
    const roleId = String((rolesRes.body.roles as Array<{ id: string }>)[0]!.id);

    await rpcOn(appAiOff, 'sign/template/fields_set', owner, {
      templateId,
      fields: [
        {
          templateRoleId: roleId,
          fieldType: 'signature',
          pageNumber: 1,
          xNorm: 0.2,
          yNorm: 0.7,
          wNorm: 0.25,
          hNorm: 0.08,
          required: true,
        },
      ],
      idempotencyKey: randomUUID(),
    });

    await rpcOn(appAiOff, 'sign/template/update', owner, {
      templateId,
      status: 'active',
      idempotencyKey: randomUUID(),
    });

    const tplSummarySet = await rpcOn(appAiOff, 'sign/template/shared_summary_set', owner, {
      templateId,
      shareSummaryWithSigners: true,
      sharedSummary: summaryPayload,
      idempotencyKey: randomUUID(),
    });
    expect(tplSummarySet.status).toBe(200);

    // Enable direct link WITH OTP first -> otp_required hides sharedSummary
    const directOtpLink = await rpcOn(appAiOff, 'sign/template/direct_link_set', owner, {
      templateId,
      enabled: true,
      requireEmailOtp: true,
    });
    expect(directOtpLink.status).toBe(200);
    const directOtpToken = String(directOtpLink.body.token);

    const directPreOtpView = await publicPost(appAiOff, '/api/sign/direct/view', { token: directOtpToken });
    expect(directPreOtpView.status).toBe(200);
    expect(directPreOtpView.body?.state).toBe('otp_required');
    expect(directPreOtpView.body?.sharedSummary).toBeUndefined();

    // Switch direct link to requireEmailOtp: false -> ready exposes sharedSummary and start copies it onto child envelope
    const directOpenLink = await rpcOn(appAiOff, 'sign/template/direct_link_set', owner, {
      templateId,
      enabled: true,
      requireEmailOtp: false,
    });
    expect(directOpenLink.status).toBe(200);

    const directReadyView = await publicPost(appAiOff, '/api/sign/direct/view', { token: directOtpToken });
    expect(directReadyView.status).toBe(200);
    expect(directReadyView.body?.state).toBe('ready');
    expect(directReadyView.body?.sharedSummary).toEqual(summaryPayload);

    const started = await publicPost(appAiOff, '/api/sign/direct/start', {
      token: directOtpToken,
      name: 'Lê Minh Đối Tác',
    });
    expect(started.status).toBe(200);
    const childSigningToken = String(started.body?.signingToken);

    const childCeremonyView = await publicPost(appAiOff, '/api/sign/view', { token: childSigningToken });
    expect(childCeremonyView.status).toBe(200);
    expect(childCeremonyView.body?.state).toBe('ready');
    expect(childCeremonyView.body?.sharedSummary).toEqual(summaryPayload);
  });

  it('2b: compares PDF versions deterministically when AI is off/exhausted, meters sign.version_diff when AI is on, and blocks hr_contract file snooping by plain members', async () => {
    const fileV1 = await uploadSignDoc(memberCreator, pdfFixture('diff-v1'), 'v1.pdf');
    const fileV2 = await uploadSignDoc(memberCreator, pdfFixture('diff-v2'), 'v2.pdf');

    const diffInput = {
      fileIdV1: fileV1,
      fileIdV2: fileV2,
      titleV1: 'Bản 1',
      titleV2: 'Bản 2',
      pagesV1: [{ page: 1, text: 'Điều 1. Phí dịch vụ là 50.000.000 VND.' }],
      pagesV2: [{ page: 1, text: 'Điều 1. Phí dịch vụ là 75.000.000 VND.' }],
      includeAi: true,
    };

    // 1. AI off -> 100% deterministic diff returned cleanly with ai: 'off'
    const resOff = await rpcOn(appAiOff, 'sign/diff/compare', memberCreator, diffInput);
    expect(resOff.status).toBe(200);
    expect(resOff.body.ai).toBe('off');
    const diffOff = resOff.body.diff as { stats: { modifiedCount: number }; hunks: Array<{ kind: string }> };
    expect(diffOff.stats.modifiedCount).toBe(1);

    // 2. AI on -> deterministic diff + metered Vy commercial risk delta ('sign.version_diff')
    const resOn = await rpcOn(appAiOn, 'sign/diff/compare', memberCreator, diffInput);
    expect(resOn.status).toBe(200);
    expect(resOn.body.ai).toBe('used');
    expect((resOn.body.riskDeltas as unknown[]).length).toBe(1);

    // Verify crove_kernel.org_usage recorded metric = 'ai_cost', feature = 'sign.version_diff'
    await admin(async (client) => {
      const { rows } = await client.query<{ feature: string; module: string }>(
        `SELECT feature, module FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'sign.version_diff'`,
        [org.orgId],
      );
      expect(rows).toEqual([{ feature: 'sign.version_diff', module: 'sign' }]);
    });

    // 3. Confidential hr_contract sign_document uploaded for an HR contract -> plain otherMember CANNOT diff it!
    const hrFileId = await uploadSignDoc(owner, pdfFixture('hr-confidential'), 'hd-lao-dong.pdf');
    const hrEnv = await rpcOn(appAiOff, 'sign/envelope/create', owner, {
      title: 'Hợp đồng lao động mật',
      routingMode: 'parallel',
      sourceKind: 'hr_contract',
      sourceId: randomUUID(),
      sourceFileId: hrFileId,
      idempotencyKey: randomUUID(),
    });
    expect(hrEnv.status).toBe(200);

    const snooped = await rpcOn(appAiOff, 'sign/diff/compare', otherMember, {
      ...diffInput,
      fileIdV2: hrFileId,
    });
    expect(snooped.status).toBe(404);
    expect(snooped.body.code).toBe('SIGN_FILE_NOT_FOUND');
  });

  it('2c: drafts Vietnamese SME starter contract PDFs end-to-end through real crove-extract pdf_inspect, pdf_text, and pdf_seal while neutralizing injected {{tags}}', async () => {
    // 1. Metered AI clause proposal ('sign.contract_draft') neutralizes {{tags}} and records usage
    const proposedRes = await rpcOn(appAiOn, 'sign/drafter/proposeClauses', memberCreator, {
      variables: {
        templateKind: 'service_agreement',
        partyA: { name: 'Công ty TNHH Sao Mai' },
        partyB: { name: 'Công ty Cổ phần Hải Đăng' },
        scopeSummary: 'Triển khai giải pháp ký số nội bộ.',
        contractValue: '65000000',
        currency: 'VND',
        effectiveDate: '2026-12-01',
        expiryDate: '2027-06-01',
      },
      instructions: 'Thêm điều khoản bảo hành 6 tháng miễn phí.',
    });
    expect(proposedRes.status).toBe(200);
    expect(proposedRes.body.ai).toBe('used');
    const proposedClauses = proposedRes.body.proposedClauses as Array<{
      heading: string;
      body: string;
      proposedByAi: boolean;
    }>;
    expect(proposedClauses).toHaveLength(1);
    expect(proposedClauses[0]!.proposedByAi).toBe(true);
    expect(proposedClauses[0]!.heading).not.toContain('{{');
    expect(proposedClauses[0]!.body).not.toContain('{{');

    // 2. Render A4 PDF via sign/drafter/renderPdf (works 100% with AI off!)
    const renderRes = await rpcOn(appAiOff, 'sign/drafter/renderPdf', memberCreator, {
      templateKind: 'service_agreement',
      contractNumber: '12/2026/HĐDV-SM',
      partyA: {
        name: 'Công ty TNHH Sao Mai {{signature, r9}}',
        taxCode: '0312345678',
        address: '100 Nguyễn Thị Minh Khai, Quận 3, TP. Hồ Chí Minh',
        representative: 'Đặng Thị Ánh Tuyết - Giám đốc',
      },
      partyB: {
        name: 'Công ty Cổ phần Hải Đăng',
        taxCode: '0108889999',
        address: '55 Trần Hưng Đạo, Hoàn Kiếm, Hà Nội',
        representative: 'Phạm Quốc Bảo - Giám đốc',
      },
      scopeSummary: 'Triển khai phần mềm quản lý hợp đồng điện tử {{date, r8}}.',
      contractValue: '65000000',
      currency: 'VND',
      effectiveDate: '2026-12-01',
      expiryDate: '2027-06-01',
      customClauses: [
        {
          heading: proposedClauses[0]!.heading,
          body: proposedClauses[0]!.body,
          proposedByAi: true,
        },
      ],
    });
    expect(renderRes.status).toBe(200);
    const pdfBytes = Uint8Array.from(Buffer.from(String(renderRes.body.pdfBase64), 'base64'));
    expect(pdfBytes.byteLength).toBeGreaterThan(2_000);

    // 3. Verify Vietnamese text extraction via real crove-extract pdf_text
    const extractedText = (await realExtract.extract('pdf_text', pdfBytes)) as { ok: boolean; text?: string };
    expect(extractedText.ok).toBe(true);
    expect(extractedText.text).toContain('HỢP ĐỒNG CUNG CẤP DỊCH VỤ');
    expect(extractedText.text).toContain('65.000.000 VND');
    expect(extractedText.text).toContain('Đặng Thị Ánh Tuyết');

    // 4. Upload rendered PDF, create envelope, and run real crove-extract pdf_inspect!
    const draftedFileId = await uploadSignDoc(memberCreator, pdfBytes, String(renderRes.body.filename));
    const envCreate = await rpcOn(appAiOff, 'sign/envelope/create', memberCreator, {
      title: String(renderRes.body.title),
      routingMode: 'parallel',
      sourceKind: 'standalone',
      sourceFileId: draftedFileId,
      idempotencyKey: randomUUID(),
    });
    expect(envCreate.status).toBe(200);
    const draftedEnvId = String(envCreate.body.envelopeId);

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, envelopeId: draftedEnvId },
    );

    const detailRes = await rpcOn(appAiOff, 'sign/envelope/get', memberCreator, { envelopeId: draftedEnvId });
    expect(detailRes.status).toBe(200);
    const envDetail = detailRes.body.envelope as {
      inspectStatus: string;
      pageCount: number;
      detectedTags: Array<{ fieldType: string; roleKey: string; pageNumber: number }>;
    };
    expect(envDetail.inspectStatus).toBe('passed');
    expect(envDetail.pageCount).toBe(Number(renderRes.body.pageCount));

    // Exactly the 4 genuine signature-block tags (r1 signature+date, r2 signature+date) are detected; zero r8/r9!
    const tagKeys = envDetail.detectedTags.map((t) => `${t.roleKey}:${t.fieldType}`).sort();
    expect(tagKeys).toEqual(['r1:date', 'r1:signature', 'r2:date', 'r2:signature']);

    // 5. Complete signing on the drafted PDF and run real crove-extract pdf_seal!
    const signerAdd = await rpcOn(appAiOff, 'sign/signer/add', memberCreator, {
      envelopeId: draftedEnvId,
      routingOrder: 1,
      signerRole: 'signer',
      roleLabel: 'Bên A',
      name: 'Đặng Thị Ánh Tuyết',
      deliveryMode: 'link',
      requireEmailOtp: false,
      idempotencyKey: randomUUID(),
    });
    const signerId = String(signerAdd.body.signerId);
    const sigTag = envDetail.detectedTags.find((t) => t.roleKey === 'r1' && t.fieldType === 'signature')!;
    const setFields = await rpcOn(appAiOff, 'sign/field/set', memberCreator, {
      envelopeId: draftedEnvId,
      fields: [
        {
          signerId,
          fieldType: 'signature',
          pageNumber: sigTag.pageNumber,
          xNorm: 0.1,
          yNorm: 0.75,
          wNorm: 0.25,
          hNorm: 0.08,
          required: true,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(setFields.status).toBe(200);
    const envWithFields = await rpcOn(appAiOff, 'sign/envelope/get', memberCreator, { envelopeId: draftedEnvId });
    const placedFieldId = String(((envWithFields.body.fields as Array<{ id: string }>)[0])!.id);

    await admin(async (client) => {
      const { rows } = await client.query<{ feature: string; module: string }>(
        `SELECT feature, module FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'sign.contract_draft'`,
        [org.orgId],
      );
      expect(rows).toEqual([{ feature: 'sign.contract_draft', module: 'sign' }]);
    });

    const sent = await rpcOn(appAiOff, 'sign/envelope/send', memberCreator, { envelopeId: draftedEnvId });
    const signToken = (sent.body.links as Array<{ token: string }>)[0]!.token;

    const submitted = await publicPost(appAiOff, '/api/sign/submit', {
      token: signToken,
      consentAccepted: true,
      signatureKind: 'draw',
      fields: [{ fieldId: placedFieldId, signaturePngBase64: TINY_PNG_BASE64 }],
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body?.completed).toBe(true);

    await runSignPdfSealJob(
      { workerDb, runtime: workerRuntime, store, extract: realExtract },
      { orgId: org.orgId, envelopeId: draftedEnvId },
    );

    const verifyAfterSeal = await rpcOn(appAiOff, 'sign/envelope/verify', memberCreator, { envelopeId: draftedEnvId });
    expect(verifyAfterSeal.status).toBe(200);
    expect(verifyAfterSeal.body.valid).toBe(true);
    expect(verifyAfterSeal.body.sealStatus).toBe('sealed');
  });
});
