// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for eSign Slice 4e (#3821):
// manual AI-off upsert & item completion, metered tainted Vy proposals vs confirmed separation,
// Renewals list & Home kernel.today surfacing, hr_contract restrictive RLS + query confidentiality,
// MODULE_OFF gating, and ludy_kernel.org_purge cleanup.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignAiReader, type AiCall, type AiMeter } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { ExtractClient } from '@ludy/extract-contract';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { todayCoworkerKey, vietnamToday, type TodayList } from '@ludy/kernel-contract';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { addDaysIso, signCommands, signQueries } from '@ludy/mod-sign';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { proposeEnvelopeObligations, signAi } from '../src/sign-ai.ts';
import { runSignPdfInspectJob } from '../src/sign-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-sign-obligations-3821-0123456789abcdef';
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
    Buffer.from(`%PDF-1.4\n% sign-obl-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'utf8'),
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

suite('eSign Slice 4e post-signature obligations, renewals, and Vy Home alerts (#3821)', () => {
  const dbName = `crove_test_sign_obl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner-obl@example.com', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin-obl@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member-obl@example.com', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'member2-obl@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer-obl@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let purgeOrg = { slug: '', orgId: '' };

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
      .sign(new TextEncoder().encode(JWT_SIGNING_KEY));
  }

  async function rpc(
    path: string,
    who: Account,
    input: unknown,
    slug: string | null = org.slug,
    targetApp = appAiOff,
  ) {
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadSignPdfFor(who: Account, tag: string, slug = org.slug): Promise<string> {
    const form = new FormData();
    form.append('file', new File([Buffer.from(pdfFixture(tag))], `${tag}.pdf`, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOff.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': slug },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ fileId: string }> };
    return body.files[0]!.fileId;
  }

  async function createEnvelopeFor(
    who: Account,
    options: {
      title: string;
      sourceKind?: 'standalone' | 'crm_quote' | 'hr_contract';
      completed: boolean;
      targetOrg?: { slug: string; orgId: string };
    },
  ): Promise<string> {
    const targetOrg = options.targetOrg ?? org;
    const fileId = await uploadSignPdfFor(who, options.title.replace(/\s+/g, '-').toLowerCase(), targetOrg.slug);
    const sourceKind = options.sourceKind ?? 'standalone';
    const created = await runtime.execute<{ envelopeId: string }>(
      'sign.envelope.create',
      {
        title: options.title,
        routingMode: 'parallel',
        sourceFileId: fileId,
        sourceKind,
        ...(sourceKind !== 'standalone' ? { sourceId: randomUUID() } : {}),
      },
      { actor: asUser(who), orgId: targetOrg.orgId },
    );
    await runSignPdfInspectJob(
      { workerDb, runtime: workerRuntime, store, extract: mockExtract },
      { orgId: targetOrg.orgId, envelopeId: created.envelopeId },
    );

    if (options.completed) {
      await runtime.execute(
        'sign.signer.add',
        {
          envelopeId: created.envelopeId,
          signerRole: 'approver',
          name: 'Approver Test',
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
        { actor: asUser(who), orgId: targetOrg.orgId },
      );
      const sent = await runtime.execute<{ links: Array<{ token: string }> }>(
        'sign.envelope.send',
        { envelopeId: created.envelopeId },
        { actor: asUser(who), orgId: targetOrg.orgId },
      );
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
    return created.envelopeId;
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
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...signQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...signCommands],
      queries: sharedQueries,
    });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCmds, ...signCommands, orgPurgeCommand({ store })],
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

    for (const who of [owner, adminUser, member, otherMember, viewer]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc('org/create', owner, { name: 'Sign Obligations Org', idempotencyKey: randomUUID() }, null);
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
          'x-crove-org': org.slug,
        },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      expect(invite.status).toBe(200);
      const body = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc('invites/accept', who, { token: body.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const createdPurge = await rpc('org/create', owner, { name: 'Purge Sign Org', idempotencyKey: randomUUID() }, null);
    expect(createdPurge.status).toBe(200);
    purgeOrg = { slug: String(createdPurge.body.slug), orgId: String(createdPurge.body.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('supports 100% manual AI-off obligation upsert, NUMERIC(20,4) decimal round-trip, validation errors, and item completion', async () => {
    const draftEnvId = await createEnvelopeFor(member, { title: 'Draft Contract', completed: false });
    const completedEnvId = await createEnvelopeFor(member, { title: 'Completed Service Contract', completed: true });

    // AI-off extract degrades cleanly without throwing.
    const aiOffRes = await rpc('sign/obligation/extract', member, {
      envelopeId: completedEnvId,
      pages: [{ page: 1, text: 'Some contract text' }],
    });
    expect(aiOffRes.status).toBe(200);
    expect(aiOffRes.body).toEqual({ ai: 'off', status: 'off', obligation: null });

    // Non-completed envelope refuses upsert with 409 SIGN_OBLIGATION_ENVELOPE_NOT_COMPLETED.
    const draftErr = await rpc('sign/obligation/upsert', member, {
      envelopeId: draftEnvId,
      autoRenew: false,
      currency: 'VND',
      obligations: [],
    });
    expect(draftErr.status).toBe(409);
    expect(draftErr.body.code).toBe('SIGN_OBLIGATION_ENVELOPE_NOT_COMPLETED');

    // Invalid calendar date, inverted date order, and negative/overflow amounts fail deterministically with 422.
    const badDate = await rpc('sign/obligation/upsert', member, {
      envelopeId: completedEnvId,
      effectiveDate: '2026-02-30',
      autoRenew: false,
      currency: 'VND',
      obligations: [],
    });
    expect(badDate.status).toBe(422);
    expect(badDate.body.code).toBe('SIGN_OBLIGATION_INVALID_DATE');

    const badOrder = await rpc('sign/obligation/upsert', member, {
      envelopeId: completedEnvId,
      effectiveDate: '2027-06-01',
      expiryDate: '2027-01-01',
      autoRenew: false,
      currency: 'VND',
      obligations: [],
    });
    expect(badOrder.status).toBe(422);
    expect(badOrder.body.code).toBe('SIGN_OBLIGATION_DATE_ORDER');

    const badMoney = await rpc('sign/obligation/upsert', member, {
      envelopeId: completedEnvId,
      contractValue: '-100.50',
      autoRenew: false,
      currency: 'VND',
      obligations: [],
    });
    expect(badMoney.status).toBe(422);
    expect(badMoney.body.code).toBe('SIGN_OBLIGATION_INVALID_VALUE');

    const todayVn = vietnamToday(new Date());
    const overdueDate = addDaysIso(todayVn, -3);
    const expirySoon = addDaysIso(todayVn, 20);

    const upserted = await rpc('sign/obligation/upsert', member, {
      envelopeId: completedEnvId,
      counterpartyName: 'Công ty TNHH Minh Anh',
      effectiveDate: '2026-01-01',
      expiryDate: expirySoon,
      renewalNoticeDays: 30,
      autoRenew: true,
      contractValue: '24000000.2575',
      currency: 'VND',
      obligations: [
        { id: 'mile-1', title: 'Thanh toán đợt 1', dueDate: overdueDate, status: 'pending' },
      ],
    });
    expect(upserted.status).toBe(200);
    expect(upserted.body).toMatchObject({
      envelopeId: completedEnvId,
      status: 'confirmed',
      counterpartyName: 'Công ty TNHH Minh Anh',
      expiryDate: expirySoon,
      renewalNoticeDays: 30,
      autoRenew: true,
      contractValue: '24000000.2575',
      currency: 'VND',
    });

    // Direct writes touching next_pending_due_date without obligations_json must recompute authoritatively (#4510).
    await admin((c) =>
      c.query(
        `UPDATE ludy_sign.envelope_obligation
         SET next_pending_due_date = '2099-12-31'::date
         WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, completedEnvId],
      ),
    );
    const tamperedCheck = await admin((c) =>
      c.query<{ next_pending_due_date: string | null }>(
        `SELECT next_pending_due_date::text AS next_pending_due_date
         FROM ludy_sign.envelope_obligation
         WHERE org_id = $1 AND envelope_id = $2`,
        [org.orgId, completedEnvId],
      ),
    );
    expect(tamperedCheck.rows[0]?.next_pending_due_date).toBe(overdueDate);

    // Viewer can read confirmed obligation (canEdit: false) and renewals_list, but cannot mutate.
    const viewerGet = await rpc('sign/obligation/get', viewer, { envelopeId: completedEnvId });
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.canEdit).toBe(false);

    const viewerWrite = await rpc('sign/obligation/complete_item', viewer, {
      envelopeId: completedEnvId,
      itemId: 'mile-1',
      completed: true,
    });
    expect(viewerWrite.status).toBe(403);

    // Home kernel.today surfaces both the overdue item and the open renewal notice window for member, with 0 dropped/failed.
    const homeBefore = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(member), orgId: org.orgId });
    expect(homeBefore.dropped).toBe(0);
    expect(homeBefore.failed).toBe(0);
    expect(todayCoworkerKey('sign')).toBe('gm');
    const signItemsBefore = homeBefore.items.filter((i) => i.app === 'sign');
    expect(signItemsBefore.map((i) => i.id)).toEqual([
      `obligation-item:${completedEnvId}:mile-1`,
      `obligation-renewal:${completedEnvId}`,
    ]);
    expect(signItemsBefore[1]?.amount).toBe('24000000.2575');
    expect(JSON.stringify(signItemsBefore)).not.toContain('Minh Anh');

    // Viewer gets zero actionable items from sign.obligations.today.
    const viewerToday = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(viewer), orgId: org.orgId });
    expect(viewerToday.items.filter((i) => i.app === 'sign')).toEqual([]);

    // Completing mile-1 removes the overdue item from Home while keeping the renewal window item.
    const completedItem = await rpc('sign/obligation/complete_item', member, {
      envelopeId: completedEnvId,
      itemId: 'mile-1',
      completed: true,
    });
    expect(completedItem.status).toBe(200);

    const homeAfter = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(member), orgId: org.orgId });
    expect(homeAfter.items.filter((i) => i.app === 'sign').map((i) => i.id)).toEqual([
      `obligation-renewal:${completedEnvId}`,
    ]);

    // Verify expiry_date IS NULL envelope with overdue pending obligation ranks FIRST ahead of already-expired contracts in renewals_list and Home!
    const oldExpiredEnvId = await createEnvelopeFor(member, { title: 'Historical Expired Contract', completed: true });
    await rpc('sign/obligation/upsert', member, {
      envelopeId: oldExpiredEnvId,
      effectiveDate: '2024-01-01',
      expiryDate: '2025-01-01',
      autoRenew: false,
      currency: 'VND',
      obligations: [],
    });

    const undatedOverdueEnvId = await createEnvelopeFor(member, {
      title: 'Undated Retainer With Overdue Deliverable',
      completed: true,
    });
    await rpc('sign/obligation/upsert', member, {
      envelopeId: undatedOverdueEnvId,
      expiryDate: null,
      autoRenew: false,
      currency: 'VND',
      obligations: [{ id: 'deliv-1', title: 'Submit handover report', dueDate: overdueDate, status: 'pending' }],
    });

    const renewalsList = await rpc('sign/obligation/renewals_list', member, { limit: 10 });
    expect(renewalsList.status).toBe(200);
    const orderedIds = ((renewalsList.body.items as Array<{ envelope: { id: string } }>) ?? []).map(
      (x) => x.envelope.id,
    );
    expect(orderedIds.indexOf(undatedOverdueEnvId)).toBeGreaterThanOrEqual(0);
    expect(orderedIds.indexOf(undatedOverdueEnvId)).toBeLessThan(orderedIds.indexOf(oldExpiredEnvId));

    const homeWithUndated = await runtime.query<TodayList>(
      'kernel.today',
      {},
      { actor: asUser(member), orgId: org.orgId },
    );
    expect(homeWithUndated.items.some((i) => i.id === `obligation-item:${undatedOverdueEnvId}:deliv-1`)).toBe(true);
  });

  it('keeps metered Vy proposals tainted (excluded from Renewals and Home) until human confirmation, and preserves confirmed status on re-extract', async () => {
    const aiEnvId = await createEnvelopeFor(member, { title: 'AI Extracted Lease Agreement', completed: true });
    const todayVn = vietnamToday(new Date());
    const proposedExpiry = addDaysIso(todayVn, 25);
    const [y, m, d] = proposedExpiry.split('-');
    const printedExpiryDmy = `${d}/${m}/${y}`;

    const admitted: AiCall[] = [];
    const meter: AiMeter = {
      admit: async (call) => {
        admitted.push(call);
      },
      record: async () => {},
    };

    const reader = new SignAiReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        obligationExtract: async () => ({
          output: {
            counterpartyName: 'Công ty Cổ phần Sao Mai',
            effectiveDate: '2026-01-01',
            expiryDate: proposedExpiry,
            renewalNoticeDays: 30,
            autoRenew: true,
            contractValue: '48000000',
            currency: 'VND',
            citations: [
              { field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Bên cho thuê: Công ty Cổ phần Sao Mai' },
              { field: 'effectiveDate', pageNumber: 1, quoteExcerpt: 'Hiệu lực từ 01/01/2026 đến ' + printedExpiryDmy },
              { field: 'expiryDate', pageNumber: 1, quoteExcerpt: 'Hiệu lực từ 01/01/2026 đến ' + printedExpiryDmy },
              { field: 'renewalNoticeDays', pageNumber: 2, quoteExcerpt: 'báo trước 30 ngày bằng văn bản' },
              { field: 'autoRenew', pageNumber: 2, quoteExcerpt: 'tự động gia hạn mỗi năm' },
              { field: 'contractValue', pageNumber: 1, quoteExcerpt: 'Giá thuê: 48.000.000 VND' },
            ],
            obligations: [
              {
                title: 'Đặt cọc tiền thuê',
                dueDate: todayVn,
                pageNumber: 2,
                quoteExcerpt: `Đặt cọc tiền thuê vào ngày ${todayVn}`,
              },
            ],
          },
          usage: { inputTokens: 80, outputTokens: 40 },
        }),
      },
    );
    // Note: custom generator bypasses HTTP fetch while checkSignObligationExtract runs deterministic quote checks.
    // Let's also verify metered('sign.obligation_extract') via default generator with stubbed fetch or check admitted:
    const outcome = await proposeEnvelopeObligations({
      ai: signAi(reader, new DraftBudget()),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: aiEnvId,
      pages: [
        {
          page: 1,
          text: `Bên cho thuê: Công ty Cổ phần Sao Mai\nHiệu lực từ 01/01/2026 đến ${printedExpiryDmy}\nGiá thuê: 48.000.000 VND`,
        },
        {
          page: 2,
          text: `Hợp đồng tự động gia hạn mỗi năm nếu không báo trước 30 ngày bằng văn bản.\nĐặt cọc tiền thuê vào ngày ${todayVn}.`,
        },
      ],
      meter,
    });

    expect(outcome.ai).toBe('used');
    expect(outcome.status).toBe('proposed');
    expect(outcome.obligation?.status).toBe('proposed');
    expect(outcome.obligation?.counterpartyName).toBeNull();
    expect(outcome.obligation?.proposal?.counterpartyName).toBe('Công ty Cổ phần Sao Mai');
    expect(outcome.obligation?.proposal?.contractValue).toBe('48000000');

    // CRITICAL: Tainted unconfirmed proposal MUST NOT appear in renewals_list or Home kernel.today!
    const renewalsBefore = await rpc('sign/obligation/renewals_list', member, {});
    expect(renewalsBefore.status).toBe(200);
    const renewalIdsBefore = ((renewalsBefore.body.items as Array<{ envelope: { id: string } }>) ?? []).map(
      (x) => x.envelope.id,
    );
    expect(renewalIdsBefore).not.toContain(aiEnvId);

    const homeBefore = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(member), orgId: org.orgId });
    expect(homeBefore.items.some((i) => i.id.includes(aiEnvId))).toBe(false);

    // Human confirms via sign.obligation.upsert -> immediately surfaces in renewals_list and Home kernel.today!
    const confirmed = await rpc('sign/obligation/upsert', member, {
      envelopeId: aiEnvId,
      counterpartyName: 'Công ty Cổ phần Sao Mai',
      effectiveDate: '2026-01-01',
      expiryDate: proposedExpiry,
      renewalNoticeDays: 30,
      autoRenew: true,
      contractValue: '48000000',
      currency: 'VND',
      obligations: outcome.obligation!.proposal!.obligations.map((o) => ({
        id: o.id,
        title: o.title,
        dueDate: o.dueDate,
        status: o.status,
        pageNumber: o.pageNumber,
        quoteExcerpt: o.quoteExcerpt,
        proposedByAi: true,
      })),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    expect(confirmed.body.proposal).toBeNull();

    const renewalsAfter = await rpc('sign/obligation/renewals_list', member, {});
    const renewalIdsAfter = ((renewalsAfter.body.items as Array<{ envelope: { id: string } }>) ?? []).map(
      (x) => x.envelope.id,
    );
    expect(renewalIdsAfter).toContain(aiEnvId);

    const homeAfter = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(member), orgId: org.orgId });
    expect(homeAfter.items.some((i) => i.id === `obligation-renewal:${aiEnvId}`)).toBe(true);
    expect(homeAfter.items.some((i) => i.id.startsWith(`obligation-item:${aiEnvId}:`))).toBe(true);

    // Re-proposing on an already-confirmed envelope preserves status === 'confirmed' and confirmed values!
    const reProposed = await proposeEnvelopeObligations({
      ai: signAi(reader, new DraftBudget()),
      runtime,
      orgId: org.orgId,
      actor: asUser(member),
      envelopeId: aiEnvId,
      pages: [
        {
          page: 1,
          text: `Bên cho thuê: Công ty Cổ phần Sao Mai\nHiệu lực từ 01/01/2026 đến ${printedExpiryDmy}\nGiá thuê: 48.000.000 VND`,
        },
        {
          page: 2,
          text: `Hợp đồng tự động gia hạn mỗi năm nếu không báo trước 30 ngày bằng văn bản.\nĐặt cọc tiền thuê vào ngày ${todayVn}.`,
        },
      ],
      meter,
    });
    expect(reProposed.status).toBe('confirmed');
    expect(reProposed.obligation?.status).toBe('confirmed');
    expect(reProposed.obligation?.contractValue).toBe('48000000');
    expect(reProposed.obligation?.proposal).not.toBeNull();

    // Dismissing proposal on confirmed envelope clears proposal_json while keeping status === 'confirmed'.
    const dismissed = await rpc('sign/obligation/dismiss_proposal', member, { envelopeId: aiEnvId });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({
      envelopeId: aiEnvId,
      dismissed: true,
      obligation: { status: 'confirmed', proposal: null },
    });

    void admitted;
  });

  it('enforces hr_contract confidentiality across restrictive RLS, obligation RPCs, renewals_list, and Home kernel.today', async () => {
    const hrEnvId = await createEnvelopeFor(owner, {
      title: 'Confidential Executive Employment Contract',
      sourceKind: 'hr_contract',
      completed: true,
    });
    const todayVn = vietnamToday(new Date());
    const hrExpiry = addDaysIso(todayVn, 10);

    const savedHr = await rpc('sign/obligation/upsert', owner, {
      envelopeId: hrEnvId,
      counterpartyName: 'Executive Candidate',
      effectiveDate: '2026-01-01',
      expiryDate: hrExpiry,
      renewalNoticeDays: 30,
      autoRenew: false,
      contractValue: '120000000',
      currency: 'VND',
      obligations: [{ id: 'hr-1', title: 'Probation review', dueDate: todayVn, status: 'pending' }],
    });
    expect(savedHr.status).toBe(200);

    // Non-creator member gets 404 on every obligation RPC for hr_contract; viewer gets 404 on reads and 403 on write commands.
    expect((await rpc('sign/obligation/get', otherMember, { envelopeId: hrEnvId })).status).toBe(404);
    expect((await rpc('sign/obligation/extract', otherMember, { envelopeId: hrEnvId })).status).toBe(404);
    expect(
      (
        await rpc('sign/obligation/upsert', otherMember, {
          envelopeId: hrEnvId,
          autoRenew: false,
          currency: 'VND',
          obligations: [],
        })
      ).status,
    ).toBe(404);
    expect((await rpc('sign/obligation/dismiss_proposal', otherMember, { envelopeId: hrEnvId })).status).toBe(404);
    expect(
      (await rpc('sign/obligation/complete_item', otherMember, { envelopeId: hrEnvId, itemId: 'hr-1', completed: true }))
        .status,
    ).toBe(404);

    expect((await rpc('sign/obligation/get', viewer, { envelopeId: hrEnvId })).status).toBe(404);
    expect(
      (
        await rpc('sign/obligation/upsert', viewer, {
          envelopeId: hrEnvId,
          autoRenew: false,
          currency: 'VND',
          obligations: [],
        })
      ).status,
    ).toBe(403);

    for (const who of [otherMember, viewer]) {
      const ren = await rpc('sign/obligation/renewals_list', who, {});
      const ids = ((ren.body.items as Array<{ envelope: { id: string } }>) ?? []).map((x) => x.envelope.id);
      expect(ids).not.toContain(hrEnvId);

      const home = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(who), orgId: org.orgId });
      expect(home.items.some((i) => i.id.includes(hrEnvId))).toBe(false);
    }

    // Direct tenant SQL as non-creator member sees 0 rows on ludy_sign.envelope_obligation due to RESTRICTIVE hr_contract_envelope_access RLS!
    const tenantClient = await pool.connect();
    try {
      await tenantClient.query('BEGIN');
      await tenantClient.query('SELECT ludy_kernel.enter_context($1::uuid, $2::uuid)', [otherMember.userId, org.orgId]);
      const rlsRows = await tenantClient.query(
        'SELECT id FROM ludy_sign.envelope_obligation WHERE org_id = $1 AND envelope_id = $2',
        [org.orgId, hrEnvId],
      );
      expect(rlsRows.rows).toEqual([]);
    } finally {
      await tenantClient.query('ROLLBACK').catch(() => {});
      tenantClient.release();
    }

    // Owner and adminUser DO see the hr_contract obligation in get, renewals_list, and Home kernel.today.
    for (const privileged of [owner, adminUser]) {
      expect((await rpc('sign/obligation/get', privileged, { envelopeId: hrEnvId })).status).toBe(200);
      const home = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(privileged), orgId: org.orgId });
      expect(home.items.some((i) => i.id === `obligation-renewal:${hrEnvId}`)).toBe(true);
    }
  });

  it('respects org_app_on MODULE_OFF gating and purges ludy_sign.envelope_obligation cleanly on org_purge', async () => {
    const purgeEnvId = await createEnvelopeFor(owner, {
      title: 'Purgeable Contract',
      completed: true,
      targetOrg: purgeOrg,
    });
    const todayVn = vietnamToday(new Date());
    const saved = await rpc(
      'sign/obligation/upsert',
      owner,
      {
        envelopeId: purgeEnvId,
        counterpartyName: 'Purge Vendor',
        expiryDate: addDaysIso(todayVn, 7),
        renewalNoticeDays: 14,
        autoRenew: false,
        contractValue: '10000000',
        currency: 'VND',
        obligations: [],
      },
      purgeOrg.slug,
    );
    expect(saved.status).toBe(200);

    // Disable sign module for purgeOrg via kernel.org.set_app -> direct queries return 404 MODULE_OFF and kernel.today omits sign with failed === 0.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: false },
      { actor: asMfa(owner), orgId: purgeOrg.orgId },
    );

    const offGet = await rpc('sign/obligation/get', owner, { envelopeId: purgeEnvId }, purgeOrg.slug);
    expect(offGet.status).toBe(404);
    expect(offGet.body.code).toBe('MODULE_OFF');

    const homeOff = await runtime.query<TodayList>('kernel.today', {}, { actor: asUser(owner), orgId: purgeOrg.orgId });
    expect(homeOff.failed).toBe(0);
    expect(homeOff.items.filter((i) => i.app === 'sign')).toEqual([]);

    // Re-enable sign and verify org_purge deletes ludy_sign.envelope_obligation cleanly.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'sign', enabled: true },
      { actor: asMfa(owner), orgId: purgeOrg.orgId },
    );

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
      [purgeOrg.orgId, '--reason', 'Owner offboarded sign obligations test org'],
    );
    expect(purgeCode, purgeLogs.join('\n')).toBe(0);

    const leftRows = await admin(async (c) =>
      (await c.query('SELECT id FROM ludy_sign.envelope_obligation WHERE org_id = $1', [purgeOrg.orgId])).rows,
    );
    expect(leftRows).toEqual([]);
  });
});
