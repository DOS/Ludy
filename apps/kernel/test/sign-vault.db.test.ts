// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 5a Contract Vault search & metered Vy Q&A (#4439):
// 100% AI-off deterministic parity, metered sign.vault_qa citation grounding, unconfirmed proposal_json exclusion,
// strict hr_contract confidentiality (owner/admin/creator only; zero leaks to non-creator members/viewers or LLM prompts),
// viewer read-only search vs AI-spend refusal (403 FORBIDDEN), and MODULE_OFF gating.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignAiReader, metered, type SignVaultQaModelOutput } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { signAiCommands, signAiQueries, signCommands, signQueries } from '@ludy/mod-sign';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runSignPdfInspectJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-sign-vault-qa-4439-0123456789abcdef';
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
    Buffer.from(`%PDF-1.4\n% sign-vault-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
  );

const mockExtract: ExtractClient = {
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
      } as never;
    }
    throw new Error(`Unexpected extract kind: ${kind}`);
  },
};

const suite = ADMIN ? describe : describe.skip;

suite('eSign Slice 5a Contract Vault search & metered Vy Q&A (#4439)', () => {
  const dbName = `crove_test_sign_vault_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const store = new MemoryStore();

  const capturedVaultPrompts: string[] = [];
  let nextVaultModelOutput: SignVaultQaModelOutput | null = null;

  const owner: Account = { subject: randomUUID(), email: 'owner-vault@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin-vault@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-vault@example.com', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2-vault@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-vault@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal1' as const,
  });

  const asMfa = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

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
      .sign(new TextEncoder().encode(JWT_SIGNING_KEY));
  }

  async function rpc(
    path: string,
    who: Account,
    input: unknown,
    slug: string | null = org.slug,
    targetApp = appAiOff,
  ) {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const response = await targetApp.request(`/api/rpc${suffix}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadSignPdfFor(who: Account, tag: string, slug = org.slug): Promise<{ fileId: string; sha256: string }> {
    const bytes = pdfFixture(tag);
    const form = new FormData();
    form.append('file', new File([Buffer.from(bytes)], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOff.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-ludy-org': slug },
      body: form,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { files: Array<{ fileId: string }> };
    return { fileId: json.files[0]!.fileId, sha256: sha256Hex(bytes) };
  }

  async function createEnvelopeFor(
    who: Account,
    opts: {
      title: string;
      sourceKind?: 'standalone' | 'hr_contract';
      sourceId?: string;
      completed?: boolean;
    },
  ): Promise<{ envelopeId: string; sourceSha256: string }> {
    const { fileId, sha256 } = await uploadSignPdfFor(who, `${opts.title}-${randomUUID().slice(0, 6)}`);
    const createRes = await rpc('sign/envelope/create', who, {
      title: opts.title,
      sourceKind: opts.sourceKind ?? 'standalone',
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      sourceFileId: fileId,
      idempotencyKey: randomUUID(),
    });
    expect(createRes.status).toBe(200);
    const created = createRes.body as { envelopeId: string };

    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: org.orgId, envelopeId: created.envelopeId },
    );

    if (opts.completed) {
      const addSignerRes = await rpc('sign/signer/add', who, {
        envelopeId: created.envelopeId,
        signerRole: 'approver',
        name: 'Người phê duyệt đối tác',
        roleLabel: 'Bên B',
        deliveryMode: 'link',
        requireEmailOtp: false,
        idempotencyKey: randomUUID(),
      });
      expect(addSignerRes.status).toBe(200);
      const sendRes = await rpc('sign/envelope/send', who, {
        envelopeId: created.envelopeId,
      });
      expect(sendRes.status).toBe(200);
      const sent = sendRes.body as { links: Array<{ token: string }> };
      const submitRes = await appAiOff.request('/api/sign/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: sent.links[0]!.token,
          consentAccepted: true,
          fields: [],
        }),
      });
      expect(submitRes.status).toBe(200);
    }
    return { envelopeId: created.envelopeId, sourceSha256: sha256 };
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
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries, ...signAiQueries];
    const sharedCommands = [...kernelCmds, ...signCommands, ...signAiCommands];

    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: sharedCommands,
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: sharedCommands,
      queries: sharedQueries,
    });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    appAiOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    const fakeReader = new SignAiReader(
      { baseURL: 'https://model.example/v1', apiKey: 'test', model: 'test-model' },
      {
        vaultQa: async ({ prompt }) => {
          capturedVaultPrompts.push(prompt);
          const m = await metered('sign.vault_qa', async () => ({
            output: nextVaultModelOutput,
            usage: { inputTokens: 140, outputTokens: 65 },
          }));
          return {
            output: m.output,
            usage: { inputTokens: 140, outputTokens: 65 },
          };
        },
      },
    );
    appAiOn = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: true,
      signAi: fakeReader,
      aiPrice: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
    });

    for (const who of [owner, adminUser, member, otherMember, viewer]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign Vault Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await appAiOff.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`,
          'content-type': 'application/json',
          'x-ludy-org': org.slug,
        },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      expect(invite.status).toBe(200);
      const body = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc('invites/accept', who, { token: body.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('provides 100% AI-off deterministic search parity, meters sign.vault_qa with verified citations when AI is on, and excludes tainted unconfirmed obligations', async () => {
    const minhAnh = await createEnvelopeFor(member, {
      title: 'Hợp đồng dịch vụ phần mềm Minh Anh',
      completed: true,
    });
    const unconfirmedEnv = await createEnvelopeFor(member, {
      title: 'Hợp đồng thử nghiệm nội bộ',
      completed: true,
    });

    // Record completed AI clause analysis on Minh Anh (page 2 penalty quote).
    await workerRuntime.execute(
      'sign.ai_analysis.record',
      {
        envelopeId: minhAnh.envelopeId,
        sourceSha256: minhAnh.sourceSha256,
        status: 'completed',
        extractedPages: [
          { page: 1, text: 'Hợp đồng cung cấp dịch vụ phần mềm Minh Anh.' },
          {
            page: 2,
            text: 'Bên B chịu phạt chậm thanh toán 0,05%/ngày trên số tiền quá hạn. Thanh toán đợt 1 trước ngày 15/12/2026.',
          },
        ],
        proposedFields: [],
        riskClauses: [
          {
            title: 'Phạt chậm thanh toán',
            severity: 'medium',
            pageNumber: 2,
            quote: 'Bên B chịu phạt chậm thanh toán 0,05%/ngày trên số tiền quá hạn.',
            explanation: 'Cần thanh toán đúng hạn để tránh phí phạt.',
          },
        ],
        summaryText: 'Hợp đồng cung cấp dịch vụ phần mềm 12 tháng.',
        promptVersion: 'v1',
      },
      { actor: { type: 'system', component: 'sign-ai-worker' }, orgId: org.orgId },
    );

    // Human-confirm obligations on Minh Anh.
    const upsertRes = await rpc('sign/obligation/upsert', member, {
      envelopeId: minhAnh.envelopeId,
      counterpartyName: 'Công ty TNHH Thương mại Minh Anh',
      effectiveDate: '2026-12-01',
      expiryDate: '2027-11-30',
      renewalNoticeDays: 30,
      autoRenew: true,
      contractValue: '24000000',
      currency: 'VND',
      obligations: [
        {
          id: 'obl-1',
          title: 'Thanh toán đợt 1',
          dueDate: '2026-12-15',
          status: 'pending',
          pageNumber: 2,
          quoteExcerpt: 'Thanh toán đợt 1 trước ngày 15/12/2026.',
        },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(upsertRes.status).toBe(200);

    // Store ONLY an unconfirmed tainted proposal on unconfirmedEnv (status = 'proposed') -> MUST NOT surface in vault!
    const storedProposal = await runtime.execute<{
      status: string;
      proposal: { counterpartyName: string | null } | null;
    }>(
      'sign.obligation.propose',
      {
        envelopeId: unconfirmedEnv.envelopeId,
        promptVersion: 'v1',
        extractedPages: [{ page: 1, text: 'Bên B: DoiTacChuaXacNhanBiMat999' }],
        proposal: {
          counterpartyName: 'DoiTacChuaXacNhanBiMat999',
          autoRenew: false,
          currency: 'VND',
          citations: [
            {
              field: 'counterpartyName',
              pageNumber: 1,
              quoteExcerpt: 'Bên B: DoiTacChuaXacNhanBiMat999',
            },
          ],
          obligations: [],
        },
      },
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(storedProposal.status).toBe('proposed');
    expect(storedProposal.proposal?.counterpartyName).toBe('DoiTacChuaXacNhanBiMat999');

    const taintedSearch = await rpc('sign/vault/search', member, {
      question: 'DoiTacChuaXacNhanBiMat999',
    });
    expect(taintedSearch.status).toBe(200);
    expect(taintedSearch.body).toEqual({ items: [] });

    // 1. AI-off deterministic search & ask parity!
    const searchOff = await rpc('sign/vault/search', member, {
      question: 'phạt chậm thanh toán Minh Anh',
    });
    expect(searchOff.status).toBe(200);
    const searchItems = (searchOff.body as { items: Array<{ envelopeId: string; contractValue: string }> }).items;
    expect(searchItems).toHaveLength(1);
    expect(searchItems[0]?.envelopeId).toBe(minhAnh.envelopeId);
    expect(searchItems[0]?.contractValue).toBe('24000000');

    const askOff = await rpc('sign/vault/ask', member, {
      question: 'phạt chậm thanh toán Minh Anh',
    });
    expect(askOff.status).toBe(200);
    expect(askOff.body).toMatchObject({
      ai: 'off',
      summary: null,
    });
    expect((askOff.body as { items: Array<{ envelopeId: string }> }).items.map((x) => x.envelopeId)).toEqual([
      minhAnh.envelopeId,
    ]);

    // 2. AI-on metered sign.vault_qa with verified citation!
    nextVaultModelOutput = {
      answer: 'Hợp đồng dịch vụ phần mềm Minh Anh quy định mức phạt chậm thanh toán 0,05%/ngày.',
      citations: [
        {
          envelopeId: minhAnh.envelopeId,
          pageNumber: 2,
          quoteExcerpt: 'phạt chậm thanh toán 0,05%/ngày trên số tiền quá hạn.',
        },
      ],
    };

    const askOn = await rpc(
      'sign/vault/ask',
      member,
      { question: 'phạt chậm thanh toán Minh Anh' },
      org.slug,
      appAiOn,
    );
    expect(askOn.status).toBe(200);
    expect(askOn.body).toMatchObject({
      ai: 'used',
      summary: {
        answer: 'Hợp đồng dịch vụ phần mềm Minh Anh quy định mức phạt chậm thanh toán 0,05%/ngày.',
        proposedByAi: true,
        citations: [
          {
            envelopeId: minhAnh.envelopeId,
            envelopeTitle: 'Hợp đồng dịch vụ phần mềm Minh Anh',
            pageNumber: 2,
            quoteExcerpt: 'phạt chậm thanh toán 0,05%/ngày trên số tiền quá hạn.',
          },
        ],
      },
    });

    // Verify AI usage report recorded sign.vault_qa!
    const usageRes = await rpc('/ai/usage', owner, undefined, org.slug, appAiOn);
    expect(usageRes.status).toBe(200);
    const byFeature = (usageRes.body as { byFeature: Array<{ feature: string; calls: number }> }).byFeature;
    expect(byFeature.some((row) => row.feature === 'sign.vault_qa' && row.calls >= 1)).toBe(true);
  });

  it('strictly blocks hr_contract leaks from non-creator members/viewers and enforces viewer AI-spend refusal + MODULE_OFF gating', async () => {
    const hrEnv = await createEnvelopeFor(owner, {
      title: 'Hợp đồng lao động Giám đốc LươngMật888',
      sourceKind: 'hr_contract',
      sourceId: randomUUID(),
      completed: true,
    });
    expect(
      (
        await rpc('sign/obligation/upsert', owner, {
          envelopeId: hrEnv.envelopeId,
          counterpartyName: 'Nguyễn LươngMật888',
          contractValue: '95000000',
          currency: 'VND',
          autoRenew: false,
          obligations: [],
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(200);

    // Owner and Admin CAN find hr_contract in vault search.
    for (const privileged of [owner, adminUser]) {
      const res = await rpc('sign/vault/search', privileged, { question: 'LươngMật888' });
      expect(res.status).toBe(200);
      expect((res.body as { items: Array<{ envelopeId: string }> }).items.map((x) => x.envelopeId)).toContain(
        hrEnv.envelopeId,
      );
    }

    // Non-creator member gets 0 results on search AND no_matches on ask (with ZERO LLM calls / prompts containing LươngMật888!).
    capturedVaultPrompts.length = 0;
    const memberSearch = await rpc('sign/vault/search', otherMember, { question: 'LươngMật888' });
    expect(memberSearch.status).toBe(200);
    expect(memberSearch.body).toEqual({ items: [] });

    const memberAsk = await rpc('sign/vault/ask', otherMember, { question: 'LươngMật888' }, org.slug, appAiOn);
    expect(memberAsk.status).toBe(200);
    expect(memberAsk.body).toEqual({ ai: 'no_matches', items: [], summary: null });
    expect(capturedVaultPrompts).toHaveLength(0);

    // Even when otherMember asks a broad question that matches Minh Anh, hrEnv NEVER enters the LLM prompt!
    nextVaultModelOutput = { answer: null, citations: [] };
    await rpc('sign/vault/ask', otherMember, { question: 'Hợp đồng nào sắp hết hạn?' }, org.slug, appAiOn);
    expect(capturedVaultPrompts.join('\n')).not.toContain('LươngMật888');
    expect(capturedVaultPrompts.join('\n')).not.toContain(hrEnv.envelopeId);

    // Viewer CAN search standalone contracts via sign/vault/search, never sees hr_contract, and gets 403 FORBIDDEN on sign/vault/ask!
    const viewerStandalone = await rpc('sign/vault/search', viewer, { question: 'Minh Anh' });
    expect(viewerStandalone.status).toBe(200);
    expect((viewerStandalone.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);

    const viewerHr = await rpc('sign/vault/search', viewer, { question: 'LươngMật888' });
    expect(viewerHr.status).toBe(200);
    expect(viewerHr.body).toEqual({ items: [] });

    const viewerAsk = await rpc('sign/vault/ask', viewer, { question: 'Minh Anh' }, org.slug, appAiOn);
    expect(viewerAsk.status).toBe(403);

    // Disabling 'sign' app returns 404 MODULE_OFF on both search and ask.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner), orgId: org.orgId },
    );
    const offSearch = await rpc('sign/vault/search', owner, { question: 'Minh Anh' });
    expect(offSearch.status).toBe(404);
    expect(offSearch.body.code).toBe('MODULE_OFF');

    const offAsk = await rpc('sign/vault/ask', owner, { question: 'Minh Anh' }, org.slug, appAiOn);
    expect(offAsk.status).toBe(404);
    expect(offAsk.body.code).toBe('MODULE_OFF');

    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asMfa(owner), orgId: org.orgId },
    );
  });
});
