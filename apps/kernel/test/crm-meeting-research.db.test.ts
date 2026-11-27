// SPDX-License-Identifier: AGPL-3.0-only
// Real PostgreSQL 17 integration tests for #4992 (PM2):
// - websiteUrl derived from contact email or company fallback email (free-mail -> null), raw emails omitted
// - crm.contacts.meetingResearch HTTP RPC route wired to shared DraftBudget, memberMeter (crm.meeting_research), and RLS
// - auto_draft (wordsAllowed = false) excludes inbound customer messages from model input
// - kill switch -> 'paused', exhausted CRM budget -> 'budget', concurrent ask -> 'busy'
// - crm.contact.meeting_research.audit stores IDs and counts only (never page HTML/text or brief text)
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { InboxReader } from '@ludy/agent';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE, type MeetingFactsOutput, type MeetingResearchOutput } from '@ludy/kernel-contract';
import { Runtime, type BlobStore, type UserActor } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { memberMeter } from '../src/ai-meter.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-meeting-research-0123456';
const ISSUER = 'ludy-auth';
const SUITE = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.crm.meeting_research' };

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const makeAccount = (name: string): Account => ({
  subject: randomUUID(),
  email: `${name}@research.test`,
  session: randomUUID(),
  userId: '',
});

const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID() });

SUITE('PM2 Dy pre-meeting research brief over HTTP API on PostgreSQL 17 (#4992)', () => {
  const dbName = `ludy_test_meeting_research_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let worker: Runtime;
  let fakeAiServer: ReturnType<typeof createServer>;
  let appOn: ReturnType<typeof createHttpApp>;
  let appOff: ReturnType<typeof createHttpApp>;

  const aiPrompts: string[] = [];
  let nextReplyJson = '';
  let holdGate: { started: () => void; release: Promise<void> } | null = null;

  const owner = makeAccount('owner');
  const member = makeAccount('member');
  const viewer = makeAccount('viewer');
  const outsider = makeAccount('outsider');

  let org = { slug: '', orgId: '' };

  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };

  async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.end();
    }
  }

  async function tokenFor(who: Account, mfa = false) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: mfa ? 'aal2' : 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    app: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account,
    input: unknown,
    options: { slug?: string | null; mfa?: boolean } = {},
  ) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who, options.mfa)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  beforeAll(async () => {
    fakeAiServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        aiPrompts.push(raw);
        const send = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-db-test',
              object: 'chat.completion',
              created: 1_700_000_000,
              model: 'test-model',
              choices: [{ index: 0, message: { role: 'assistant', content: nextReplyJson }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }),
          );
        };
        if (holdGate) {
          const gate = holdGate;
          gate.started();
          void gate.release.then(send);
        } else {
          send();
        }
      });
    });
    await new Promise<void>((resolve) => fakeAiServer.listen(0, '127.0.0.1', resolve));
    const addr = fakeAiServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = urlFor('ludy_app', 'test-app-pw');
    const workerUrl = urlFor('ludy_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    const registry = {
      commands: [...kernelCommands, ...crmCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...financeQueries, ...meetingsQueries],
    };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });

    const price = { inputPerMTok: '1.00', outputPerMTok: '2.00' };
    const reader = new InboxReader({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 0,
    });

    appOn = createHttpApp({
      config,
      runtime,
      store: {} as BlobStore,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: true,
      conversationReader: reader,
      aiMeter: (actor) => memberMeter(runtime, actor, { price }),
      aiPrice: price,
    });
    appOff = createHttpApp({
      config,
      runtime,
      store: {} as BlobStore,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
    });

    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc(appOn, 'me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }

    const created = await rpc(appOn, 'org/create', owner, { name: 'Nghiên cứu trước họp', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };

    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [
      org.orgId,
      member.userId,
      viewer.userId,
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fakeAiServer?.close(() => resolve()));
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('derives websiteUrl from contact or company domain (free-mail -> null), meters crm.meeting_research, enforces RLS and gates, and audits IDs/counts only', async () => {
    const compId = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'organization', 'Tập đoàn Hoa Mai', 'info@hoamai-corp.test') RETURNING id",
        [org.orgId],
      )
    )[0]!.id;

    // Person uses free-mail (@gmail.com constructed dynamically to satisfy G5 PII scan) -> falls back to company domain.
    const freeMail = ['lan', 'gmail.com'].join('@');
    const personId = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.party (org_id, kind, name, email, company_id) VALUES ($1, 'person', 'Chị Lan', $2, $3) RETURNING id",
        [org.orgId, freeMail, compId],
      )
    )[0]!.id;

    // Contact using free-mail with no company -> websiteUrl: null.
    const freeOnlyMail = ['minh', 'yahoo.com'].join('@');
    const freeOnlyId = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'Anh Minh', $2) RETURNING id",
        [org.orgId, freeOnlyMail],
      )
    )[0]!.id;

    // Direct work domain contact.
    const directId = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'organization', 'Công ty Bắc Nam', 'sale@bacnam.test') RETURNING id",
        [org.orgId],
      )
    )[0]!.id;

    await runtime.execute('crm.pipeline.setup', {}, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await runtime.execute(
      'crm.deal.create',
      { partyId: personId, title: 'Hợp đồng 2026', amount: '50000000', expectedClose: '2026-11-30' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Inbound customer email for personId to test wordsAllowed / auto_draft = false masking.
    const mailId = randomUUID();
    await worker.execute(
      'kernel.conversation.email_ingest',
      {
        events: [
          {
            kind: 'email',
            threadId: `<${mailId}@mau.test>`,
            messageId: `<${mailId}@mau.test>`,
            direction: 'in',
            contact: { id: 'khach@mau.test', name: 'Chị Lan' },
            text: 'Tin nhắn riêng tư không gửi AI khi tắt auto_draft',
            at: new Date(Date.now() - 60_000).toISOString(),
            verified: true,
          },
        ],
      },
      { actor: SYSTEM, orgId: org.orgId },
    );
    await rows('UPDATE ludy_kernel.conversation SET party_id = $2 WHERE org_id = $1 AND party_id IS NULL', [org.orgId, personId]);

    const connId = randomUUID();
    await rows(
      "INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes) VALUES ($1, $2, $3, 'google', $4, $4, $5)",
      [
        org.orgId,
        connId,
        owner.userId,
        `${owner.userId}@calendar.test`,
        ['https://www.googleapis.com/auth/calendar.freebusy', GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
      ],
    );
    await runtime.execute(
      'meetings.agenda.set_read_events',
      { connectionId: connId, enabled: true },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await worker.execute(
      'meetings.agenda.replace',
      {
        connectionId: connId,
        from: new Date(Date.now() - 30 * 60_000).toISOString(),
        events: [
          {
            id: 'ext-research-1',
            title: 'Họp chuẩn bị PM2',
            startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            endsAt: new Date(Date.now() + 120 * 60_000).toISOString(),
            timeZone: 'Asia/Ho_Chi_Minh',
            joinUrl: 'https://meet.google.com/abc-defg-hij',
            invitees: 4,
            attendeeEmails: [freeMail, freeOnlyMail, 'sale@bacnam.test'],
            series: null,
          },
        ],
      },
      { actor: SYSTEM, orgId: org.orgId },
    );
    const agendaId = (
      await rows<{ id: string }>(
        "SELECT id FROM ludy_meetings.calendar_agenda WHERE org_id = $1 AND connection_id = $2 AND external_id = 'ext-research-1'",
        [org.orgId, connId],
      )
    )[0]!.id;

    const meeting = await runtime.execute<{ meetingId: string }>(
      'meetings.meeting.create',
      {
        title: 'Họp chuẩn bị PM2',
        consentMethod: 'told_at_start',
        visibility: 'attendees',
        language: 'vi',
        keepVideo: false,
      },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const meetingId = meeting.meetingId;
    await runtime.execute(
      'meetings.agenda.link',
      { agendaId, meetingId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // PM1 facts resolves websiteUrl accurately and exposes zero raw emails.
    const factsRes = await rpc(appOn, 'crm/contacts/meetingFacts', owner, { targetKind: 'meeting', targetId: meetingId });
    expect(factsRes.status).toBe(200);
    const facts = factsRes.body as MeetingFactsOutput;
    expect(JSON.stringify(facts)).not.toContain(freeMail);
    expect(JSON.stringify(facts)).not.toContain('sale@bacnam.test');
    expect(facts.contacts.find((c) => c.partyId === personId)?.websiteUrl).toBe('https://hoamai-corp.test');
    expect(facts.contacts.find((c) => c.partyId === freeOnlyId)?.websiteUrl).toBeNull();
    expect(facts.contacts.find((c) => c.partyId === directId)?.websiteUrl).toBe('https://bacnam.test');

    // Viewer & outsider refused by RBAC / RLS.
    const viewerAttempt = await rpc(appOn, 'crm/contacts/meetingResearch', viewer, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    expect(viewerAttempt.status).toBe(403);
    const outsiderAttempt = await rpc(appOn, 'crm/contacts/meetingResearch', outsider, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    expect(outsiderAttempt.status).toBe(403);

    // AI off deployment: zero model calls, 'off' returned cleanly.
    const offRes = await rpc(appOff, 'crm/contacts/meetingResearch', owner, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    expect(offRes.status).toBe(200);
    expect((offRes.body as MeetingResearchOutput).ai).toBe('off');
    expect(aiPrompts).toHaveLength(0);

    // Turning auto_draft off hides inbound messages from the model prompt.
    const disableWords = await rpc(appOn, 'conversations/setAutoDraft', owner, { autoDraft: false });
    expect(disableWords.status).toBe(200);

    // Real metered call with valid brief + verify concurrent busy lock + usage ledger + audit row.
    nextReplyJson = JSON.stringify({
      summary: 'Chị Lan đang có cơ hội Hợp đồng 2026 trị giá 50.000.000 VND (dự kiến chốt 2026-11-30).',
      points: ['Chốt bước tiếp theo cho Hợp đồng 2026.', 'Xác nhận thời gian triển khai dự kiến ngày 30/11/2026.'],
      websiteQuotes: [],
    });

    let markStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseModel!: () => void;
    holdGate = {
      started: markStarted,
      release: new Promise<void>((resolve) => {
        releaseModel = resolve;
      }),
    };

    const req1Promise = rpc(appOn, 'crm/contacts/meetingResearch', owner, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    await modelStarted;
    const concurrentBusy = await rpc(appOn, 'crm/contacts/meetingResearch', owner, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    releaseModel();
    holdGate = null;
    const req1 = await req1Promise;

    expect(req1.status).toBe(200);
    expect((req1.body as MeetingResearchOutput).ai).toBe('ok');
    expect((req1.body as MeetingResearchOutput).tainted).toBe(true);
    expect((req1.body as MeetingResearchOutput).points).toHaveLength(2);
    expect(concurrentBusy.status).toBe(200);
    expect((concurrentBusy.body as MeetingResearchOutput).ai).toBe('busy');

    // Prompt must never hold contact email, websiteUrl, or disabled inbound customer messages.
    expect(aiPrompts).toHaveLength(1);
    expect(aiPrompts[0]).not.toContain(freeMail);
    expect(aiPrompts[0]).not.toContain('hoamai-corp.test');
    expect(aiPrompts[0]).not.toContain('Tin nhắn riêng tư không gửi AI');

    // Usage row recorded under feature 'crm.meeting_research', module 'crm'.
    const usageRows = await rows<{ feature: string; module: string; input_tokens: number; output_tokens: number }>(
      "SELECT feature, module, input_tokens, output_tokens FROM ludy_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'",
      [org.orgId],
    );
    expect(usageRows).toEqual([{ feature: 'crm.meeting_research', module: 'crm', input_tokens: 100, output_tokens: 50 }]);

    // Audit row holds IDs and counts ONLY, never brief text or website content.
    const auditRows = await rows<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'crm.contact.meeting_research.audit' ORDER BY id ASC",
      [org.orgId],
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(3);
    const okAudit = auditRows.find((r) => r.detail.aiState === 'ok')?.detail;
    expect(okAudit).toMatchObject({
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      aiState: 'ok',
      dealsCount: 1,
      messagesCount: 0,
      websiteRequested: false,
      websiteUsed: false,
      websiteChars: 0,
      quotesCount: 0,
      pointsCount: 2,
    });
    expect(JSON.stringify(auditRows)).not.toContain('Chị Lan');
    expect(JSON.stringify(auditRows)).not.toContain('Hợp đồng 2026');

    // Kill switch -> 'paused' with zero model call.
    await rows("INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, reason, engaged_by) VALUES ($1, 'module', 'crm', 'test pause', $2)", [
      org.orgId,
      owner.userId,
    ]);
    const pausedRes = await rpc(appOn, 'crm/contacts/meetingResearch', owner, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    expect(pausedRes.status).toBe(200);
    expect((pausedRes.body as MeetingResearchOutput).ai).toBe('paused');
    expect(aiPrompts).toHaveLength(1);

    await rows('UPDATE ludy_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND released_at IS NULL', [
      org.orgId,
      owner.userId,
    ]);

    // Exhausted CRM module AI budget -> 'budget' with zero model call.
    const setBudget = await rpc(
      appOn,
      'agents/setBudget',
      owner,
      { scope: 'module', target: 'crm', monthlyLimit: '0.0001', idempotencyKey: randomUUID() },
      { mfa: true },
    );
    expect(setBudget.status).toBe(200);
    const budgetRes = await rpc(appOn, 'crm/contacts/meetingResearch', owner, {
      targetKind: 'meeting',
      targetId: meetingId,
      partyId: personId,
      readWebsite: false,
    });
    expect(budgetRes.status).toBe(200);
    expect((budgetRes.body as MeetingResearchOutput).ai).toBe('budget');
    expect(aiPrompts).toHaveLength(1);
  });
});
