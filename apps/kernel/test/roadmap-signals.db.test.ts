// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for #4492 Omnichannel Roadmap Signals (ADR-0058 Slice 1).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxReader, withAiScope, type AiMeter } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  buildKernelCommands,
  createOrg,
  ERASED_PARTY_NAME,
  EXPORT_TABLES,
  kernelQueries,
  REDACTED_MARK,
  upsertIdentity,
} from '@ludy/kernel';
import {
  zRoadmapSignalValueByCurrency,
  type ConversationEvent,
  type Deal,
  type MeetingResults,
  type Notes,
  type RoadmapAdminItem,
  type RoadmapBoardSummary,
  type RoadmapSignalCreateResult,
  type RoadmapSignalDeleteResult,
  type RoadmapSignalListResult,
  type RoadmapSignalMatchResult,
  type RoadmapSignalRollupResult,
  type Transcript,
} from '@ludy/kernel-contract';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import {
  enrichMeetingSignalMatchSource,
  projectsCommands,
  projectsQueries,
  type RoadmapAiSignalMatchSource,
} from '@ludy/mod-projects';
import { Runtime, type Actor, type BlobStore, type UserActor } from '@ludy/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { prepareRoadmapSignalMatch, projectRoadmapAi } from '../src/project-roadmap-ai.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SIGNING_PHRASE = 'x'.repeat(32);
const ISSUER = 'crove-auth';
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const WORKER_SYSTEM = { type: 'system' as const, component: 'worker' };
const CANARY_QUOTE = 'CANARY_PRIVATE_CUSTOMER_QUOTE_8842';
const CANARY_ACCOUNT = 'Cong ty Minh Anh Canary 8842';
const CANARY_RECORDER_NOTES = 'CANARY_RECORDER_ROUGH_NOTES_9913';

describe.skipIf(!ADMIN)('Projects #4492: Omnichannel Roadmap Signals (PG17)', () => {
  const dbName = `ludy_4492_test_${randomUUID().slice(0, 8)}`;
  let adminUrl = '';
  let adminPool: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let openaiServer: Server | undefined;
  let openaiBaseUrl = '';
  let openaiHits = 0;
  let openaiPayload = '{}';
  let onApp: ReturnType<typeof createHttpApp>;
  let offApp: ReturnType<typeof createHttpApp>;
  const recordedCalls: Array<{ feature: string }> = [];
  const spyMeter: AiMeter = {
    admit: async () => undefined,
    record: async (entry) => {
      recordedCalls.push({ feature: entry.feature });
    },
  };

  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID() });
  const asMfa = (userId: string): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  const sqlAdmin = async <R extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> => {
    if (!adminPool) throw new Error('adminPool not open');
    return adminPool.query<R>(text, params);
  };

  async function person(tag: string) {
    const email = `${tag}-${randomUUID().slice(0, 8)}@p4492.test`;
    const subject = randomUUID();
    const userId = await upsertIdentity(db, {
      issuer: ISSUER,
      subject,
      email,
      name: `User ${tag}`,
    });
    return { userId, email, subject };
  }

  async function tokenFor(p: { subject: string; email: string }) {
    return new SignJWT({ role: 'authenticated', email: p.email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(p.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SIGNING_PHRASE));
  }

  async function rpc(
    app: ReturnType<typeof createHttpApp>,
    path: string,
    p: { subject: string; email: string },
    input: unknown,
    orgSlug: string,
  ) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(p)}`,
        'content-type': 'application/json',
        'x-crove-org': orgSlug,
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> | null };
  }

  async function inviteAndJoin(
    orgId: string,
    ownerId: string,
    user: { email: string; userId: string },
    role: 'admin' | 'member' | 'viewer',
  ) {
    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: user.email, role },
      { actor: asMfa(ownerId), orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(user.userId), idempotencyKey: randomUUID() },
    );
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await root.end();
    }

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';

    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    db = createDb(pool);

    const shipped = ['kernel', 'crm', 'meetings', 'projects'] as const;
    const noBlobs = { put: async () => undefined, deletePrefix: async () => 0 } as unknown as BlobStore;
    const registered = {
      commands: [
        ...buildKernelCommands({ shippedModules: shipped }),
        ...crmCommands,
        ...meetingsCommands,
        ...projectsCommands,
        orgPurgeCommand({ store: noBlobs }),
      ],
      queries: [
        ...kernelQueries({
          inboundDomain: null,
          apps: { shipped, deployment: shipped, entitlements: async () => ['full'] },
        }),
        ...crmQueries,
        ...meetingsQueries,
        ...projectsQueries,
      ],
    };

    rt = new Runtime(db, { manifests: TEST_MANIFESTS, stepUp: 'required' }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);

    openaiServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        openaiHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: `chatcmpl-${openaiHits}`,
            object: 'chat.completion',
            created: 1700000000,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: openaiPayload,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => openaiServer!.listen(0, '127.0.0.1', resolve));
    openaiBaseUrl = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}/v1`;

    const httpConfig = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SIGNING_PHRASE,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const httpRuntime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register(registered);
    const httpReader = new InboxReader({
      baseURL: openaiBaseUrl,
      apiKey: 'test-key',
      model: 'test-model',
      supportsStructuredOutputs: true,
      maxRetries: 0,
    });
    onApp = createHttpApp({
      config: httpConfig,
      runtime: httpRuntime,
      store: noBlobs,
      authenticate: createAuthenticator(httpConfig, db),
      pool,
      aiMeter: () => spyMeter,
      aiEnabled: true,
      conversationReader: httpReader,
    });
    offApp = createHttpApp({
      config: httpConfig,
      runtime: httpRuntime,
      store: noBlobs,
      authenticate: createAuthenticator(httpConfig, db),
      pool,
      aiEnabled: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (openaiServer) await new Promise<void>((resolve) => openaiServer!.close(() => resolve()));
    await pool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it('keeps public_roadmap_view and public_roadmap_* functions completely blind to roadmap_signal', async () => {
    const funcs = await sqlAdmin<{ proname: string; prosrc: string }>(
      `SELECT p.proname, p.prosrc
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ludy_projects' AND p.proname LIKE 'public_roadmap%'`,
    );
    expect(funcs.rows.length).toBeGreaterThan(0);
    expect(funcs.rows.some((fn) => fn.proname === 'public_roadmap_view')).toBe(true);
    for (const fn of funcs.rows) {
      const src = fn.prosrc.toLowerCase();
      expect(src, `function ${fn.proname} must not reference roadmap_signal`).not.toContain('roadmap_signal');
      expect(src, `function ${fn.proname} must not expose account_label`).not.toContain('account_label');
      expect(src, `function ${fn.proname} must not expose quote_excerpt`).not.toContain('quote_excerpt');
      expect(src, `function ${fn.proname} must not expose deal_value`).not.toContain('deal_value');
      expect(src, `function ${fn.proname} must not expose deal_currency`).not.toContain('deal_currency');
    }
  });

  it('supports idempotent CRM/Inbox/Meeting signals, auto-hydration, decimal.js multi-currency rollups, merge dedupe, caller-scoped checks, Vy guards, PDPL, offboarding, and org purge', async () => {
    const owner = await person('owner');
    const alice = await person('alice');
    const bob = await person('bob');
    const carol = await person('carol');
    const viewer = await person('viewer');

    const orgA = await createOrg(rt, asUser(owner.userId), 'Cong ty Alpha 4492');
    const orgB = await createOrg(rt, asUser(carol.userId), 'Cong ty Beta 4492');
    await inviteAndJoin(orgA.orgId, owner.userId, alice, 'member');
    await inviteAndJoin(orgA.orgId, owner.userId, bob, 'member');
    await inviteAndJoin(orgA.orgId, owner.userId, carol, 'member');
    await inviteAndJoin(orgA.orgId, owner.userId, viewer, 'viewer');

    const exec = <T>(userId: string, cmd: string, input: unknown, orgId = orgA.orgId) =>
      rt.execute<T>(cmd, input, { actor: asUser(userId), orgId });
    const query = <T>(userId: string, q: string, input: unknown, orgId = orgA.orgId) =>
      rt.query<T>(q, input, { actor: asUser(userId), orgId });

    // Setup roadmap board + items A, B, and archived C
    const { board } = await exec<{ board: RoadmapBoardSummary }>(owner.userId, 'projects.roadmap.board.create', {
      title: 'Lo trinh 2027',
      slug: 'roadmap-2027',
    });
    await exec(owner.userId, 'projects.roadmap.board.update', {
      boardId: board.id,
      enabled: true,
    });
    const { item: itemA } = await exec<{ item: RoadmapAdminItem }>(owner.userId, 'projects.roadmap.item.create', {
      boardId: board.id,
      publicTitle: 'Xuat hoa don XML hang loat',
      publicSummary: 'Xuat nhieu hoa don dien tu trong mot lan',
      category: 'Ke toan',
    });
    const { item: itemB } = await exec<{ item: RoadmapAdminItem }>(owner.userId, 'projects.roadmap.item.create', {
      boardId: board.id,
      publicTitle: 'Dong bo ton kho da chi nhanh',
      publicSummary: 'Dong bo so lieu ton kho theo thoi gian thuc',
      category: 'Kho',
    });
    const { item: archivedItem } = await exec<{ item: RoadmapAdminItem }>(owner.userId, 'projects.roadmap.item.create', {
      boardId: board.id,
      publicTitle: 'Y tuong da luu tru',
      publicSummary: null,
      category: null,
    });
    await exec(owner.userId, 'projects.roadmap.item.moderate', {
      itemId: archivedItem.id,
      moderationStatus: 'archived',
    });

    // Setup CRM pipeline, parties & deals
    await exec(owner.userId, 'crm.pipeline.setup', {});
    const partyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id`,
      [orgA.orgId, CANARY_ACCOUNT],
    );
    const partyId = partyRes.rows[0]!.id;
    const partyBRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id`,
      [orgA.orgId, 'Global Buyer Corp'],
    );
    const partyBId = partyBRes.rows[0]!.id;

    const deal1 = await exec<Deal>(alice.userId, 'crm.deal.create', {
      partyId,
      title: 'Goi Enterprise 2027',
      amount: '25000000',
      expectedClose: null,
    });
    const deal2 = await exec<Deal>(alice.userId, 'crm.deal.create', {
      partyId: partyBId,
      title: 'Export Compliance USD Deal',
      amount: '10000000',
      expectedClose: null,
    });

    // Setup direct Inbox conversation (only Alice gets desk.agent)
    await sqlAdmin(
      `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)`,
      [orgA.orgId, alice.userId, owner.userId],
    );
    const connectionId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by)
       VALUES ($1, $2, 'sandbox', $3, 'OA Channel', $4)`,
      [orgA.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, owner.userId],
    );
    await worker.execute(
      'kernel.conversation.ingest',
      {
        connectionId,
        events: [
          {
            kind: 'direct',
            threadId: 'dm-4492',
            messageId: 'm-4492',
            direction: 'in',
            contact: { id: 'u-4492', name: 'Anh Minh' },
            text: `Can tinh nang xuat XML hoa don hang loat (${CANARY_QUOTE}).`,
            at: '2026-11-18T09:00:00.000Z',
          } satisfies ConversationEvent,
        ],
      },
      { actor: SYSTEM, orgId: orgA.orgId },
    );
    const convRows = await sqlAdmin<{ id: string }>(
      `SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'dm-4492'`,
      [orgA.orgId],
    );
    const convId = convRows.rows[0]!.id;

    // Setup attendees-only meeting (Alice is recorder, Bob is reader, Carol is NOT invited)
    const { meetingId } = await exec<{ meetingId: string }>(alice.userId, 'meetings.meeting.create', {
      title: 'Hop khach hang roadmap Q1',
      consentMethod: 'told_at_start',
      visibility: 'attendees',
    });
    await exec(alice.userId, 'meetings.reader.add', { meetingId, userId: bob.userId });
    await exec(alice.userId, 'meetings.summary.save', {
      meetingId,
      summary: 'Khach de xuat dong bo ton kho nhieu chi nhanh.',
      decisions: ['Uu tien dong bo realtime'],
    });
    await exec(alice.userId, 'meetings.notes.save', {
      meetingId,
      body: `Private recorder note ${CANARY_RECORDER_NOTES}`,
    });
    await exec(alice.userId, 'meetings.result.publish', { meetingId, confirmed: true });

    // 1. Auto-hydration + idempotent signal creation + outbox & audit privacy
    const create1 = await exec<RoadmapSignalCreateResult>(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemA.id,
      sourceType: 'crm.deal',
      sourceId: deal1.id,
      quoteExcerpt: `  ${CANARY_QUOTE}  `,
    });
    expect(create1.alreadyLinked).toBe(false);
    expect(create1.signal.accountLabel).toBe(CANARY_ACCOUNT);
    expect(create1.signal.dealValue).toBe('25000000.00');
    expect(create1.signal.dealCurrency).toBe('VND');
    expect(create1.signal.tainted).toBe(true);

    const createDup = await exec<RoadmapSignalCreateResult>(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemA.id,
      sourceType: 'crm.deal',
      sourceId: deal1.id,
    });
    expect(createDup.alreadyLinked).toBe(true);
    expect(createDup.signal.id).toBe(create1.signal.id);

    const outboxRows = await sqlAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'projects.roadmap.signal_linked'`,
      [orgA.orgId],
    );
    expect(Number(outboxRows.rows[0]!.count)).toBe(1);

    const auditRows = await sqlAdmin<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'projects.roadmap.signal.create'`,
      [orgA.orgId],
    );
    const auditJson = JSON.stringify(auditRows.rows);
    expect(auditJson).not.toContain(CANARY_QUOTE);
    expect(auditJson).not.toContain(CANARY_ACCOUNT);

    // 2. Link USD deal + conversation to Item A, and Meeting + overlapping Deal 1 to Item B
    await exec(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemA.id,
      sourceType: 'crm.deal',
      sourceId: deal2.id,
      accountLabel: 'Global Buyer Corp',
      dealValue: '1500.25',
      dealCurrency: 'USD',
    });
    await exec(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemA.id,
      sourceType: 'kernel.conversation',
      sourceId: convId,
      accountLabel: ` ${CANARY_ACCOUNT.toLowerCase()} `,
      dealValue: '10000000.50',
      dealCurrency: 'VND',
    });

    const rollupBeforeMerge = await query<RoadmapSignalRollupResult>(
      owner.userId,
      'projects.roadmap.signal.rollup',
      { boardId: board.id },
    );
    expect(rollupBeforeMerge.totalSignals).toBe(3);
    expect(rollupBeforeMerge.distinctAccountCount).toBe(2);
    expect(rollupBeforeMerge.valueByCurrency).toEqual([
      { currency: 'USD', totalAmount: '1500.25', signalCount: 1 },
      { currency: 'VND', totalAmount: '35000000.50', signalCount: 2 },
    ]);

    // Attach Deal 1 (overlap) and Meeting 1 to Item B, then merge Item B into Item A
    await exec(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemB.id,
      sourceType: 'crm.deal',
      sourceId: deal1.id,
    });
    await exec(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemB.id,
      sourceType: 'meetings.meeting',
      sourceId: meetingId,
      accountLabel: 'Cong ty Khac',
      quoteExcerpt: 'Needs sync',
    });

    await exec(owner.userId, 'projects.roadmap.item.merge', {
      sourceItemId: itemB.id,
      targetItemId: itemA.id,
    });

    const afterMergeList = await query<RoadmapSignalListResult>(owner.userId, 'projects.roadmap.signal.list', {
      boardId: board.id,
      roadmapItemId: itemA.id,
    });
    // Overlapping deal1 on itemB was deduplicated; meeting1 transferred -> 4 distinct signals on itemA
    expect(afterMergeList.signals).toHaveLength(4);
    const mergedItemSignals = await sqlAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND roadmap_item_id = $2`,
      [orgA.orgId, itemB.id],
    );
    expect(Number(mergedItemSignals.rows[0]!.count)).toBe(0);

    // Refuses attaching new signal to merged or archived items
    await expect(
      exec(alice.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: itemB.id,
        sourceType: 'crm.deal',
        sourceId: deal1.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ROADMAP_ITEM_MERGED' });

    await expect(
      exec(alice.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: archivedItem.id,
        sourceType: 'crm.deal',
        sourceId: deal1.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'ROADMAP_ITEM_ARCHIVED' });

    // 3. Public roadmap SQL function NEVER returns signals, account labels, quotes, or deal amounts
    const publicBoard = await sqlAdmin<{ payload: unknown }>(
      `SELECT ludy_projects.public_roadmap_view($1, $2, NULL, NULL) AS payload`,
      [orgA.slug, 'roadmap-2027'],
    );
    const pubJson = JSON.stringify(publicBoard.rows[0]?.payload ?? null);
    expect(pubJson).toContain(itemA.id);
    expect(pubJson).not.toContain(CANARY_QUOTE);
    expect(pubJson).not.toContain(CANARY_ACCOUNT);
    expect(pubJson).not.toContain('25000000');

    // 4. Caller-scoped access checks (direct conversation RLS, attendees-only meeting RLS, module off)
    await expect(
      exec(bob.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: itemA.id,
        sourceType: 'kernel.conversation',
        sourceId: convId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'SOURCE_NOT_FOUND' });

    await expect(
      exec(carol.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: itemA.id,
        sourceType: 'meetings.meeting',
        sourceId: meetingId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'SOURCE_NOT_FOUND' });

    // Bob (reader, not recorder) invokes ai_signal_match_source + audited top-level meeting reads: NEVER receives Alice's rough notes!
    const bobRawMatchSource = await query<RoadmapAiSignalMatchSource>(
      bob.userId,
      'projects.roadmap.ai_signal_match_source',
      { boardId: board.id, sourceType: 'meetings.meeting', sourceId: meetingId },
    );
    expect(bobRawMatchSource.sourceIsRecorder).toBe(false);
    const bobResults = await query<MeetingResults>(bob.userId, 'meetings.result.get', { meetingId });
    const bobTranscript = await query<Transcript>(bob.userId, 'meetings.transcript.get', { meetingId });
    const bobNotes: Notes | null = bobRawMatchSource.sourceIsRecorder
      ? await query<Notes>(bob.userId, 'meetings.notes.get', { meetingId })
      : null;
    const bobMatchSource = enrichMeetingSignalMatchSource(bobRawMatchSource, {
      results: bobResults,
      transcript: bobTranscript,
      notes: bobNotes,
    });
    expect(bobMatchSource.sourceExcerpt).toContain('Khach de xuat dong bo ton kho');
    expect(bobMatchSource.sourceExcerpt).not.toContain(CANARY_RECORDER_NOTES);

    // Disabling CRM cleanly blocks crm.deal source checks while kernel.conversation still succeeds
    await exec(owner.userId, 'kernel.org.set_app', { module: 'crm', enabled: false });
    await expect(
      exec(alice.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: itemA.id,
        sourceType: 'crm.deal',
        sourceId: deal1.id,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'CRM_NOT_INSTALLED' });
    await exec(owner.userId, 'kernel.org.set_app', { module: 'crm', enabled: true });

    // 5. Role, agent_write_guard, & cross-tenant RLS isolation
    await expect(
      exec(viewer.userId, 'projects.roadmap.signal.create', {
        boardId: board.id,
        roadmapItemId: itemA.id,
        sourceType: 'crm.deal',
        sourceId: deal1.id,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      rt.execute(
        'projects.roadmap.signal.create',
        {
          boardId: board.id,
          roadmapItemId: itemA.id,
          sourceType: 'crm.deal',
          sourceId: deal1.id,
        },
        {
          actor: { type: 'agent', agentId: randomUUID(), userId: owner.userId } as unknown as Actor,
          orgId: orgA.orgId,
        },
      ),
    ).rejects.toBeTruthy();

    await expect(
      query(carol.userId, 'projects.roadmap.signal.list', { boardId: board.id }, orgB.orgId),
    ).rejects.toMatchObject({ status: 404 });

    // 6. Vy AI parity (AI off), red-team UNKNOWN_ID / LINK refusal, and metered 'projects.roadmap_signal_match'
    const aiSource = await query<RoadmapAiSignalMatchSource>(
      alice.userId,
      'projects.roadmap.ai_signal_match_source',
      { boardId: board.id, sourceType: 'kernel.conversation', sourceId: convId },
    );
    expect(aiSource.items[0]?.tainted).toBe(false);

    const offAi = projectRoadmapAi(null, new DraftBudget({ perUserPerMinute: 20, perOrgPerMinute: 60 }));
    const offRes = await prepareRoadmapSignalMatch(offAi, orgA.orgId, alice.userId, aiSource, 'vi');
    expect(offRes.ai).toBe('off');
    expect(offRes.suggestions).toEqual([]);
    expect(offRes.inspectedCount).toBe(1);

    const badUuidReader = new InboxReader(
      { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' },
      {
        roadmapSignalMatch: async () => ({
          output: {
            matches: [{ roadmapItemId: randomUUID(), confidence: 'high', reason: 'Invented id' }],
            newIdeaDraft: null,
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
    );
    const refusedUuid = await withAiScope({ orgId: orgA.orgId, meter: spyMeter }, () =>
      prepareRoadmapSignalMatch(
        projectRoadmapAi(badUuidReader, new DraftBudget({ perUserPerMinute: 20, perOrgPerMinute: 60 })),
        orgA.orgId,
        alice.userId,
        aiSource,
        'vi',
      ),
    );
    expect(refusedUuid.ai).toBe('refused');

    const linkReader = new InboxReader(
      { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' },
      {
        roadmapSignalMatch: async () => ({
          output: {
            matches: [{ roadmapItemId: itemA.id, confidence: 'high', reason: 'Bam https://evil.test ngay' }],
            newIdeaDraft: null,
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
    );
    const refusedLink = await withAiScope({ orgId: orgA.orgId, meter: spyMeter }, () =>
      prepareRoadmapSignalMatch(
        projectRoadmapAi(linkReader, new DraftBudget({ perUserPerMinute: 20, perOrgPerMinute: 60 })),
        orgA.orgId,
        alice.userId,
        aiSource,
        'vi',
      ),
    );
    expect(refusedLink.ai).toBe('refused');

    // Exercise real InboxReader (no generator override) against HTTP /v1/chat/completions mock -> exercises metered('projects.roadmap_signal_match')
    recordedCalls.length = 0;
    openaiHits = 0;
    openaiPayload = JSON.stringify({
      matches: [{ roadmapItemId: itemA.id, confidence: 'high', reason: 'Khach de cap xuat hoa don XML' }],
      newIdeaDraft: { suggestedTitle: 'Xuat XML', suggestedSummary: 'Tu dong hoa xuat XML' },
    });
    const realReader = new InboxReader({
      baseURL: openaiBaseUrl,
      apiKey: 'test-key',
      model: 'test-model',
      supportsStructuredOutputs: true,
      maxRetries: 0,
    });
    const usedRes = await withAiScope({ orgId: orgA.orgId, meter: spyMeter }, () =>
      prepareRoadmapSignalMatch(
        projectRoadmapAi(realReader, new DraftBudget({ perUserPerMinute: 20, perOrgPerMinute: 60 })),
        orgA.orgId,
        alice.userId,
        aiSource,
        'vi',
      ),
    );
    expect(usedRes.ai).toBe('used');
    expect(usedRes.suggestions).toHaveLength(1);
    expect(usedRes.newIdeaDraft?.tainted).toBe(true);
    expect(openaiHits).toBe(1);
    expect(recordedCalls.filter((c) => c.feature === 'projects.roadmap_signal_match')).toHaveLength(1);

    // HTTP RPC: when kernel.conversation.auto_draft is false, WRITERS check runs first (viewer gets 403), then ai='off' before AI calls
    await exec(owner.userId, 'kernel.conversation.auto_draft_set', { autoDraft: false });
    const viewerAutoDraftOffRpc = await rpc(
      onApp,
      'projects/roadmap/signalMatchSuggest',
      viewer,
      { boardId: board.id, sourceType: 'kernel.conversation', sourceId: convId, language: 'vi' },
      orgA.slug,
    );
    expect(viewerAutoDraftOffRpc.status).toBe(403);
    const hitsBeforeAutoDraftOff = openaiHits;
    const autoDraftOffRpc = await rpc(
      onApp,
      'projects/roadmap/signalMatchSuggest',
      alice,
      { boardId: board.id, sourceType: 'kernel.conversation', sourceId: convId, language: 'vi' },
      orgA.slug,
    );
    expect(autoDraftOffRpc.status).toBe(200);
    expect(autoDraftOffRpc.body as RoadmapSignalMatchResult).toEqual({
      ai: 'off',
      suggestions: [],
      newIdeaDraft: null,
      inspectedCount: 0,
      truncated: false,
    });
    expect(openaiHits).toBe(hitsBeforeAutoDraftOff);

    const autoDraftOffSource = await query<RoadmapAiSignalMatchSource>(
      alice.userId,
      'projects.roadmap.ai_signal_match_source',
      { boardId: board.id, sourceType: 'kernel.conversation', sourceId: convId },
    );
    expect(autoDraftOffSource.conversationAutoDraftOff).toBe(true);
    expect(autoDraftOffSource.sourceTitle).toBe('');
    expect(autoDraftOffSource.sourceExcerpt).toBe('');
    expect(autoDraftOffSource.items).toEqual([]);

    const aiReaderOffSource = await query<RoadmapAiSignalMatchSource>(
      alice.userId,
      'projects.roadmap.ai_signal_match_source',
      { boardId: board.id, sourceType: 'crm.deal', sourceId: deal1.id, aiReaderEnabled: false },
    );
    expect(aiReaderOffSource.sourceTitle).toBe('');
    expect(aiReaderOffSource.sourceExcerpt).toBe('');
    expect(aiReaderOffSource.items).toEqual([]);

    // Turning auto_draft back on allows HTTP RPC signalMatchSuggest to run and hit real InboxReader
    await exec(owner.userId, 'kernel.conversation.auto_draft_set', { autoDraft: true });
    const autoDraftOnRpc = await rpc(
      onApp,
      'projects/roadmap/signalMatchSuggest',
      alice,
      { boardId: board.id, sourceType: 'kernel.conversation', sourceId: convId, language: 'vi' },
      orgA.slug,
    );
    expect(autoDraftOnRpc.status).toBe(200);
    expect((autoDraftOnRpc.body as RoadmapSignalMatchResult).ai).toBe('used');
    expect(openaiHits).toBe(hitsBeforeAutoDraftOff + 1);

    // HTTP RPC with deployment AI off (offApp): skips sensitive meetings.result/transcript/notes audit reads
    const meetingReadsBefore = await sqlAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('meetings.result.get', 'meetings.transcript.get', 'meetings.notes.get')`,
      [orgA.orgId],
    );
    const offMeetingRpc = await rpc(
      offApp,
      'projects/roadmap/signalMatchSuggest',
      alice,
      { boardId: board.id, sourceType: 'meetings.meeting', sourceId: meetingId, language: 'vi' },
      orgA.slug,
    );
    expect(offMeetingRpc.status).toBe(200);
    expect((offMeetingRpc.body as RoadmapSignalMatchResult).ai).toBe('off');
    const meetingReadsAfter = await sqlAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('meetings.result.get', 'meetings.transcript.get', 'meetings.notes.get')`,
      [orgA.orgId],
    );
    expect(Number(meetingReadsAfter.rows[0]!.count)).toBe(Number(meetingReadsBefore.rows[0]!.count));

    // Delete signal test
    const deletedRes = await exec<RoadmapSignalDeleteResult>(alice.userId, 'projects.roadmap.signal.delete', {
      signalId: create1.signal.id,
    });
    expect(deletedRes.deleted).toBe(true);

    // 7. PDPL find/erase preserves CHECK constraints, offboarding registry, and org_purge
    const pdplEmail = 'pdpl.canary@p4492.test';
    await exec(alice.userId, 'projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: itemA.id,
      sourceType: 'crm.deal',
      sourceId: deal1.id,
      accountLabel: pdplEmail,
      quoteExcerpt: `Need export sent to ${pdplEmail} weekly`,
    });

    const found = await rt.execute<{ matches: Array<{ column: string }> }>(
      'kernel.personal_data.find',
      { value: pdplEmail },
      { actor: asMfa(owner.userId), orgId: orgA.orgId },
    );
    const foundCols = found.matches.map((m) => m.column);
    expect(foundCols).toContain('ludy_projects.roadmap_signal.account_label');
    expect(foundCols).toContain('ludy_projects.roadmap_signal.quote_excerpt');

    await rt.execute(
      'kernel.personal_data.erase',
      { value: pdplEmail },
      { actor: asMfa(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() },
    );
    const afterErase = await sqlAdmin<{ account_label: string | null; quote_excerpt: string | null }>(
      `SELECT account_label, quote_excerpt FROM ludy_projects.roadmap_signal WHERE org_id = $1`,
      [orgA.orgId],
    );
    expect(JSON.stringify(afterErase.rows)).not.toContain(pdplEmail);

    expect(EXPORT_TABLES['projects.roadmap_signal']).toEqual({
      from: 'ludy_projects.roadmap_signal',
      omit: [],
    });

    // Purge Org A cleanly including ludy_projects.roadmap_signal
    const client = await adminPool!.connect();
    try {
      const exportedAt = new Date(Date.now() - 35 * 86_400_000);
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgA.orgId]);
      for (const [cmd, actorType, actorId, detail] of [
        ['kernel.org.offboard', 'user', owner.userId, { reason: 'test' }],
        ['kernel.org.export.record', 'system', null, { format: 'crove.org-export.v2' }],
      ] as const) {
        await client.query(
          `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)`,
          [orgA.orgId, exportedAt, actorType, actorId, cmd, randomUUID(), '0'.repeat(64), JSON.stringify(detail)],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await worker.execute(
      'kernel.org.purge',
      { minDays: 30, reason: 'owner_request' },
      { actor: { type: 'system', component: 'operator' }, orgId: orgA.orgId },
    );
    const purgedRows = await sqlAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM ludy_projects.roadmap_signal WHERE org_id = $1`,
      [orgA.orgId],
    );
    expect(Number(purgedRows.rows[0]!.count)).toBe(0);
  }, 60_000);

  it('validates >16-digit decimal rollups, masks non-org meetings in offboarding export, and handles PDPL crm.deal linkage + NULL redaction', async () => {
    const owner2 = await person('owner-post');
    const alice2 = await person('alice-post');
    const org2 = await createOrg(rt, asUser(owner2.userId), 'Cong ty Gamma 4492');
    await inviteAndJoin(org2.orgId, owner2.userId, alice2, 'member');

    const exec2 = <T>(userId: string, cmd: string, input: unknown, idempotencyKey?: string) =>
      rt.execute<T>(cmd, input, {
        actor: asUser(userId),
        orgId: org2.orgId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    const query2 = <T>(userId: string, q: string, input: unknown) =>
      rt.query<T>(q, input, { actor: asUser(userId), orgId: org2.orgId });

    const { board: board2 } = await exec2<{ board: RoadmapBoardSummary }>(owner2.userId, 'projects.roadmap.board.create', {
      title: 'Board Post Review',
      slug: 'board-post-review',
    });
    const { item: item2A } = await exec2<{ item: RoadmapAdminItem }>(owner2.userId, 'projects.roadmap.item.create', {
      boardId: board2.id,
      publicTitle: 'Enterprise Billing',
      publicSummary: null,
      category: null,
    });
    const { item: item2B } = await exec2<{ item: RoadmapAdminItem }>(owner2.userId, 'projects.roadmap.item.create', {
      boardId: board2.id,
      publicTitle: 'Privacy Compliance',
      publicSummary: null,
      category: null,
    });
    const { item: item2C } = await exec2<{ item: RoadmapAdminItem }>(owner2.userId, 'projects.roadmap.item.create', {
      boardId: board2.id,
      publicTitle: 'Replay & Documented Party Checks',
      publicSummary: null,
      category: null,
    });

    await exec2(owner2.userId, 'crm.pipeline.setup', {});
    const largePartyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, 'MegaBuyer Ltd', 'organization') RETURNING id`,
      [org2.orgId],
    );
    const largePartyId = largePartyRes.rows[0]!.id;
    const dealBig1 = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: largePartyId,
      title: 'Mega Deal 1',
      amount: '1000',
      expectedClose: null,
    });
    const dealBig2 = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: largePartyId,
      title: 'Mega Deal 2',
      amount: '1000',
      expectedClose: null,
    });

    // 1. Multi-signal aggregate > 16 integer digits ('19999999999999999.98') validates cleanly end-to-end
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'crm.deal',
      sourceId: dealBig1.id,
      dealValue: '9999999999999999.99',
      dealCurrency: 'USD',
    });
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'crm.deal',
      sourceId: dealBig2.id,
      dealValue: '9999999999999999.99',
      dealCurrency: 'USD',
    });
    const bigRollup = await query2<RoadmapSignalRollupResult>(owner2.userId, 'projects.roadmap.signal.rollup', {
      boardId: board2.id,
    });
    expect(bigRollup.valueByCurrency).toEqual([{ currency: 'USD', totalAmount: '19999999999999999.98', signalCount: 2 }]);
    expect(zRoadmapSignalValueByCurrency.parse(bigRollup.valueByCurrency[0])).toEqual({
      currency: 'USD',
      totalAmount: '19999999999999999.98',
      signalCount: 2,
    });

    // 2. ADR-0047: Offboarding snapshot omits quote_excerpt for attendees-only meetings, preserves org-shared meetings
    const { meetingId: privMeetingId } = await exec2<{ meetingId: string }>(alice2.userId, 'meetings.meeting.create', {
      title: 'Attendees Only Sync',
      consentMethod: 'told_at_start',
      visibility: 'attendees',
    });
    const { meetingId: pubMeetingId } = await exec2<{ meetingId: string }>(alice2.userId, 'meetings.meeting.create', {
      title: 'Org Shared Sync',
      consentMethod: 'told_at_start',
      visibility: 'org',
    });
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'meetings.meeting',
      sourceId: privMeetingId,
      accountLabel: 'Private Co',
      quoteExcerpt: 'PRIVATE_ATTENDEES_QUOTE_9901',
    });
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'meetings.meeting',
      sourceId: pubMeetingId,
      accountLabel: 'Shared Co',
      quoteExcerpt: 'PUBLIC_ORG_SHARED_QUOTE_9902',
    });

    const exportedSignalRows: Array<{ source_type: string; source_id: string; quote_excerpt: string | null }> = [];
    await worker.stream(
      'kernel.org.export.snapshot',
      { table: 'projects.roadmap_signal' },
      { actor: WORKER_SYSTEM, orgId: org2.orgId },
      async (batch) => {
        const typed = batch as { lines: string[] };
        for (const line of typed.lines) {
          exportedSignalRows.push(JSON.parse(line) as { source_type: string; source_id: string; quote_excerpt: string | null });
        }
      },
    );
    const privExported = exportedSignalRows.find((r) => r.source_id === privMeetingId);
    const pubExported = exportedSignalRows.find((r) => r.source_id === pubMeetingId);
    expect(privExported).toBeDefined();
    expect(privExported?.quote_excerpt).toBeNull();
    expect(pubExported?.quote_excerpt).toBe('PUBLIC_ORG_SHARED_QUOTE_9902');

    // ADR-0047: projects.roadmap.signal.list masks quoteExcerpt to null for attendees-only meetings when caller lacks access
    const recorderList = await query2<RoadmapSignalListResult>(alice2.userId, 'projects.roadmap.signal.list', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
    });
    expect(recorderList.signals.find((s) => s.sourceId === privMeetingId)?.quoteExcerpt).toBe('PRIVATE_ATTENDEES_QUOTE_9901');
    expect(recorderList.signals.find((s) => s.sourceId === pubMeetingId)?.quoteExcerpt).toBe('PUBLIC_ORG_SHARED_QUOTE_9902');

    const nonAttendeeList = await query2<RoadmapSignalListResult>(owner2.userId, 'projects.roadmap.signal.list', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
    });
    expect(nonAttendeeList.signals.find((s) => s.sourceId === privMeetingId)?.quoteExcerpt).toBeNull();
    expect(nonAttendeeList.signals.find((s) => s.sourceId === pubMeetingId)?.quoteExcerpt).toBe('PUBLIC_ORG_SHARED_QUOTE_9902');

    // 3. PDPL: party match via crm.deal FK + erase clears copied account_label + post-erase create skips ERASED_PARTY_NAME + full redact -> NULL
    const hiddenPartyEmail = 'linked.party@p4492.test';
    const hiddenPartyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, email, kind) VALUES ($1, 'Cong ty Bi Quyet Khong Chua Email', $2, 'organization') RETURNING id`,
      [org2.orgId, hiddenPartyEmail],
    );
    const hiddenPartyId = hiddenPartyRes.rows[0]!.id;
    const dealSecret = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: hiddenPartyId,
      title: 'Secret Party Deal',
      amount: '5000000',
      expectedClose: null,
    });
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'crm.deal',
      sourceId: dealSecret.id,
    });

    const onlyRedactEmail = 'only.redacted@p4492.test';
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2B.id,
      sourceType: 'meetings.meeting',
      sourceId: pubMeetingId,
      accountLabel: onlyRedactEmail,
    });
    await exec2(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2B.id,
      sourceType: 'meetings.meeting',
      sourceId: privMeetingId,
      accountLabel: `Cong ty ${onlyRedactEmail}`,
    });

    const foundByPartyEmail = await rt.execute<{ matches: Array<{ column: string; handling: string; rowId: string | null }> }>(
      'kernel.personal_data.find',
      { value: hiddenPartyEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId },
    );
    expect(
      foundByPartyEmail.matches.some(
        (m) => m.column === 'ludy_projects.roadmap_signal.account_label' && m.handling === 'erase',
      ),
    ).toBe(true);

    await rt.execute(
      'kernel.personal_data.erase',
      { value: hiddenPartyEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    const secretSignalAfterErase = await sqlAdmin<{ account_label: string | null }>(
      `SELECT account_label FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND source_id = $2`,
      [org2.orgId, dealSecret.id],
    );
    expect(secretSignalAfterErase.rows[0]?.account_label).toBeNull();

    // Linking an already-erased party's deal MUST coerce stale explicit accountLabel & skip auto-hydration
    const afterEraseCreate = await exec2<RoadmapSignalCreateResult>(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2B.id,
      sourceType: 'crm.deal',
      sourceId: dealSecret.id,
      accountLabel: 'Cong ty Bi Quyet Stale Name',
    });
    expect(afterEraseCreate.signal.accountLabel).toBeNull();
    const afterEraseDb = await sqlAdmin<{ account_label: string | null }>(
      `SELECT account_label FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND id = $2`,
      [org2.orgId, afterEraseCreate.signal.id],
    );
    expect(afterEraseDb.rows[0]?.account_label).toBeNull();

    // Full '[đã xóa]' redaction turns account_label to NULL while partial keeps prefix + '[đã xóa]'
    await rt.execute(
      'kernel.personal_data.erase',
      { value: onlyRedactEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    const item2BSignalsAfterRedact = await sqlAdmin<{ source_id: string; account_label: string | null }>(
      `SELECT source_id, account_label FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND roadmap_item_id = $2 AND source_type = 'meetings.meeting'`,
      [org2.orgId, item2B.id],
    );
    const fullRedactedRow = item2BSignalsAfterRedact.rows.find((r) => r.source_id === pubMeetingId);
    const partialRedactedRow = item2BSignalsAfterRedact.rows.find((r) => r.source_id === privMeetingId);
    expect(fullRedactedRow?.account_label).toBeNull();
    expect(partialRedactedRow?.account_label).toBe(`Cong ty ${REDACTED_MARK}`);

    const item2BRollup = await query2<RoadmapSignalRollupResult>(owner2.userId, 'projects.roadmap.signal.rollup', {
      boardId: board2.id,
      roadmapItemId: item2B.id,
    });
    expect(item2BRollup.distinctAccountCount).toBe(1);

    // 4. PDPL 9-digit shortNumber phone erase clears crm.deal signal & idempotency replay; free-text PII replay redact; documented party kept
    const shortPhone = '091234567';
    const shortPartyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, phone, kind) VALUES ($1, 'Cong ty So Ngan 9 Chu So', $2, 'organization') RETURNING id`,
      [org2.orgId, shortPhone],
    );
    const shortPartyId = shortPartyRes.rows[0]!.id;
    const shortDeal = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: shortPartyId,
      title: 'Short Phone Deal',
      amount: '2000000',
      expectedClose: null,
    });
    const shortIdemKey = randomUUID();
    const shortCreatePayload = {
      boardId: board2.id,
      roadmapItemId: item2A.id,
      sourceType: 'crm.deal' as const,
      sourceId: shortDeal.id,
    };
    const shortSignal = await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      shortCreatePayload,
      shortIdemKey,
    );
    expect(shortSignal.signal.accountLabel).toBe('Cong ty So Ngan 9 Chu So');

    const shortEraseRes = await rt.execute<{ erased: Array<{ column: string; rows: number }> }>(
      'kernel.personal_data.erase',
      { value: shortPhone },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    expect(shortEraseRes.erased.find((e) => e.column === 'ludy_projects.roadmap_signal.account_label')?.rows).toBe(1);

    const erasedPartyRow = await sqlAdmin<{ name: string; phone: string | null }>(
      `SELECT name, phone FROM ludy_kernel.party WHERE org_id = $1 AND id = $2`,
      [org2.orgId, shortPartyId],
    );
    expect(erasedPartyRow.rows[0]?.phone).toBeNull();
    expect(erasedPartyRow.rows[0]?.name).toBe(ERASED_PARTY_NAME);

    const shortSignalAfterErase = await sqlAdmin<{ account_label: string | null }>(
      `SELECT account_label FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND id = $2`,
      [org2.orgId, shortSignal.signal.id],
    );
    expect(shortSignalAfterErase.rows[0]?.account_label).toBeNull();

    const shortReplay = await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      shortCreatePayload,
      shortIdemKey,
    );
    expect(shortReplay.signal.accountLabel).toBeNull();
    const shortIdemRow = await sqlAdmin<{ resp_text: string }>(
      `SELECT response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org2.orgId, shortIdemKey],
    );
    expect(shortIdemRow.rows[0]?.resp_text).not.toContain('Cong ty So Ngan 9 Chu So');
    expect(shortIdemRow.rows[0]?.resp_text).not.toContain(ERASED_PARTY_NAME);

    // Free-text PII idempotency replay redaction (non-meeting signal preserves redacted quote, while meeting signal keeps quoteExcerpt = null)
    const replayEmail = 'replay.pii@p4492.test';
    const textPartyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, 'Cong ty Text Replay 4492', 'organization') RETURNING id`,
      [org2.orgId],
    );
    const textPartyId = textPartyRes.rows[0]!.id;
    const textDeal = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: textPartyId,
      title: 'Free Text Replay Deal',
      amount: '1500000',
      expectedClose: null,
    });
    const textIdemKey = randomUUID();
    const textCreatePayload = {
      boardId: board2.id,
      roadmapItemId: item2C.id,
      sourceType: 'crm.deal' as const,
      sourceId: textDeal.id,
      accountLabel: replayEmail,
      quoteExcerpt: `Send quote to ${replayEmail}`,
    };
    const textSignal = await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      textCreatePayload,
      textIdemKey,
    );
    expect(textSignal.signal.accountLabel).toBe(replayEmail);

    await rt.execute(
      'kernel.personal_data.erase',
      { value: replayEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    const textReplay = await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      textCreatePayload,
      textIdemKey,
    );
    expect(textReplay.signal.accountLabel).toBeNull();
    expect(textReplay.signal.quoteExcerpt).toBe(`Send quote to ${REDACTED_MARK}`);
    const textIdemRow = await sqlAdmin<{ resp_text: string }>(
      `SELECT response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org2.orgId, textIdemKey],
    );
    expect(textIdemRow.rows[0]?.resp_text).not.toContain(replayEmail);

    const meetingEraseEmail = 'meeting.erase.pii@p4492.test';
    const meetingSecretQuote = 'CONFIDENTIAL_MEETING_QUOTE_DO_NOT_REPLAY_4492';
    const meetingTextKey = randomUUID();
    const meetingTextPayload = {
      boardId: board2.id,
      roadmapItemId: item2C.id,
      sourceType: 'meetings.meeting' as const,
      sourceId: privMeetingId,
      accountLabel: meetingEraseEmail,
      quoteExcerpt: meetingSecretQuote,
    };
    await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      meetingTextPayload,
      meetingTextKey,
    );
    await rt.execute(
      'kernel.personal_data.erase',
      { value: meetingEraseEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    const meetingTextReplay = await exec2<RoadmapSignalCreateResult>(
      alice2.userId,
      'projects.roadmap.signal.create',
      meetingTextPayload,
      meetingTextKey,
    );
    expect(meetingTextReplay.signal.accountLabel).toBeNull();
    expect(meetingTextReplay.signal.quoteExcerpt).toBeNull();
    const meetingIdemAfterErase = await sqlAdmin<{ resp_text: string }>(
      `SELECT response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org2.orgId, meetingTextKey],
    );
    expect(meetingIdemAfterErase.rows[0]?.resp_text).not.toContain(meetingEraseEmail);
    expect(meetingIdemAfterErase.rows[0]?.resp_text).not.toContain(meetingSecretQuote);

    // Documented party retains account_label and reports it in kept[]
    const docEmail = 'documented.party@p4492.test';
    const docPartyRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, email, kind) VALUES ($1, 'Cong ty Co Chung Tu', $2, 'organization') RETURNING id`,
      [org2.orgId, docEmail],
    );
    const docPartyId = docPartyRes.rows[0]!.id;
    const docClient = await adminPool!.connect();
    try {
      await docClient.query('BEGIN');
      await docClient.query(`SET LOCAL session_replication_role = 'replica'`);
      await docClient.query(
        `INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
         VALUES ($1, $2, 'C26TAA', '4492', '2026-09-01', 100, 10, 110)`,
        [org2.orgId, docPartyId],
      );
      await docClient.query('COMMIT');
    } catch (e) {
      await docClient.query('ROLLBACK');
      throw e;
    } finally {
      docClient.release();
    }
    const docDeal = await exec2<Deal>(alice2.userId, 'crm.deal.create', {
      partyId: docPartyId,
      title: 'Documented Party Deal',
      amount: '9000000',
      expectedClose: null,
    });
    const docSignal = await exec2<RoadmapSignalCreateResult>(alice2.userId, 'projects.roadmap.signal.create', {
      boardId: board2.id,
      roadmapItemId: item2C.id,
      sourceType: 'crm.deal',
      sourceId: docDeal.id,
    });
    expect(docSignal.signal.accountLabel).toBe('Cong ty Co Chung Tu');

    const docEraseRes = await rt.execute<{
      kept: Array<{ column: string; rows: number; reason: string }>;
    }>(
      'kernel.personal_data.erase',
      { value: docEmail },
      { actor: asMfa(owner2.userId), orgId: org2.orgId, idempotencyKey: randomUUID() },
    );
    expect(
      docEraseRes.kept.find((k) => k.column === 'ludy_projects.roadmap_signal.account_label')?.rows,
    ).toBe(1);
    const docSignalAfterErase = await sqlAdmin<{ account_label: string | null }>(
      `SELECT account_label FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND id = $2`,
      [org2.orgId, docSignal.signal.id],
    );
    expect(docSignalAfterErase.rows[0]?.account_label).toBe('Cong ty Co Chung Tu');
  }, 60_000);

  it('scrubs accountLabel and quoteExcerpt from idempotency_key.response on signal delete and item merge (#4492)', async () => {
    const owner3 = await person('owner-scrub');
    const alice3 = await person('alice-scrub');
    const bob3 = await person('bob-scrub');
    const org3 = await createOrg(rt, asUser(owner3.userId), 'Cong ty Delta 4492');
    await inviteAndJoin(org3.orgId, owner3.userId, alice3, 'member');
    await inviteAndJoin(org3.orgId, owner3.userId, bob3, 'member');

    const exec3 = <T>(userId: string, cmd: string, input: unknown, idempotencyKey?: string) =>
      rt.execute<T>(cmd, input, {
        actor: asUser(userId),
        orgId: org3.orgId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    const query3 = <T>(userId: string, qName: string, input: unknown) =>
      rt.query<T>(qName, input, { actor: asUser(userId), orgId: org3.orgId });

    const { board: board3 } = await exec3<{ board: RoadmapBoardSummary }>(owner3.userId, 'projects.roadmap.board.create', {
      title: 'Scrub Regression Board',
      slug: 'scrub-regression',
    });
    const { item: itemDel } = await exec3<{ item: RoadmapAdminItem }>(owner3.userId, 'projects.roadmap.item.create', {
      boardId: board3.id,
      publicTitle: 'Delete Signal Item',
      publicSummary: null,
      category: null,
    });
    const { item: itemMergeSrc } = await exec3<{ item: RoadmapAdminItem }>(owner3.userId, 'projects.roadmap.item.create', {
      boardId: board3.id,
      publicTitle: 'Merge Source Item',
      publicSummary: null,
      category: null,
    });
    const { item: itemMergeDst } = await exec3<{ item: RoadmapAdminItem }>(owner3.userId, 'projects.roadmap.item.create', {
      boardId: board3.id,
      publicTitle: 'Merge Target Item',
      publicSummary: null,
      category: null,
    });

    await exec3(owner3.userId, 'crm.pipeline.setup', {});
    const partyScrubRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, 'Scrub Party 4492', 'organization') RETURNING id`,
      [org3.orgId],
    );
    const partyScrubId = partyScrubRes.rows[0]!.id;
    const dealScrub1 = await exec3<Deal>(alice3.userId, 'crm.deal.create', {
      partyId: partyScrubId,
      title: 'Scrub Regression Deal 1',
      amount: '1000000',
      expectedClose: null,
    });
    const dealScrub2 = await exec3<Deal>(alice3.userId, 'crm.deal.create', {
      partyId: partyScrubId,
      title: 'Scrub Regression Deal 2',
      amount: '2000000',
      expectedClose: null,
    });

    type IdemSignalRow = {
      resp_text: string;
      response: { value?: { signal?: { accountLabel: string | null; quoteExcerpt: string | null } } };
    };

    // 1. Signal delete immediately scrubs accountLabel & quoteExcerpt from idempotency_key.response
    const delIdemKey = randomUUID();
    const delPiiAccount = 'Delete Canary Co 4492';
    const delPiiQuote = 'DELETE_IDEM_QUOTE_CANARY_4492';
    const delPayload = {
      boardId: board3.id,
      roadmapItemId: itemDel.id,
      sourceType: 'crm.deal' as const,
      sourceId: dealScrub1.id,
      accountLabel: delPiiAccount,
      quoteExcerpt: delPiiQuote,
    };
    const delCreated = await exec3<RoadmapSignalCreateResult>(
      alice3.userId,
      'projects.roadmap.signal.create',
      delPayload,
      delIdemKey,
    );

    const beforeDeleteRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, delIdemKey],
    );
    expect(beforeDeleteRow.rows[0]?.resp_text).toContain(delPiiAccount);
    expect(beforeDeleteRow.rows[0]?.resp_text).toContain(delPiiQuote);

    await exec3(alice3.userId, 'projects.roadmap.signal.delete', { signalId: delCreated.signal.id });

    const afterDeleteRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, delIdemKey],
    );
    expect(afterDeleteRow.rows[0]?.response?.value?.signal?.accountLabel).toBeNull();
    expect(afterDeleteRow.rows[0]?.response?.value?.signal?.quoteExcerpt).toBeNull();
    expect(afterDeleteRow.rows[0]?.resp_text).not.toContain(delPiiAccount);
    expect(afterDeleteRow.rows[0]?.resp_text).not.toContain(delPiiQuote);

    const delReplay = await exec3<RoadmapSignalCreateResult>(
      alice3.userId,
      'projects.roadmap.signal.create',
      delPayload,
      delIdemKey,
    );
    expect(delReplay.signal.id).toBe(delCreated.signal.id);
    expect(delReplay.signal.accountLabel).toBeNull();
    expect(delReplay.signal.quoteExcerpt).toBeNull();

    // 2. Item merge immediately scrubs deduplicated source signal's idempotency_key.response while keeping transferred signals
    await exec3(alice3.userId, 'projects.roadmap.signal.create', {
      boardId: board3.id,
      roadmapItemId: itemMergeDst.id,
      sourceType: 'crm.deal',
      sourceId: dealScrub1.id,
    });

    const mergeSrcIdemKey = randomUUID();
    const mergePiiAccount = 'Merge Source Canary Co 4492';
    const mergePiiQuote = 'MERGE_IDEM_QUOTE_CANARY_4492';
    const mergeSrcPayload = {
      boardId: board3.id,
      roadmapItemId: itemMergeSrc.id,
      sourceType: 'crm.deal' as const,
      sourceId: dealScrub1.id,
      accountLabel: mergePiiAccount,
      quoteExcerpt: mergePiiQuote,
    };
    const mergeSrcCreated = await exec3<RoadmapSignalCreateResult>(
      alice3.userId,
      'projects.roadmap.signal.create',
      mergeSrcPayload,
      mergeSrcIdemKey,
    );

    const keepIdemKey = randomUUID();
    const keepAccount = 'Keep Transferred Co 4492';
    const keepQuote = 'KEEP_TRANSFERRED_QUOTE_4492';
    await exec3<RoadmapSignalCreateResult>(
      alice3.userId,
      'projects.roadmap.signal.create',
      {
        boardId: board3.id,
        roadmapItemId: itemMergeSrc.id,
        sourceType: 'crm.deal',
        sourceId: dealScrub2.id,
        accountLabel: keepAccount,
        quoteExcerpt: keepQuote,
      },
      keepIdemKey,
    );

    const beforeMergeRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, mergeSrcIdemKey],
    );
    expect(beforeMergeRow.rows[0]?.resp_text).toContain(mergePiiAccount);
    expect(beforeMergeRow.rows[0]?.resp_text).toContain(mergePiiQuote);

    await exec3(owner3.userId, 'projects.roadmap.item.merge', {
      sourceItemId: itemMergeSrc.id,
      targetItemId: itemMergeDst.id,
    });

    const afterMergeRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, mergeSrcIdemKey],
    );
    expect(afterMergeRow.rows[0]?.response?.value?.signal?.accountLabel).toBeNull();
    expect(afterMergeRow.rows[0]?.response?.value?.signal?.quoteExcerpt).toBeNull();
    expect(afterMergeRow.rows[0]?.resp_text).not.toContain(mergePiiAccount);
    expect(afterMergeRow.rows[0]?.resp_text).not.toContain(mergePiiQuote);

    const mergeReplay = await exec3<RoadmapSignalCreateResult>(
      alice3.userId,
      'projects.roadmap.signal.create',
      mergeSrcPayload,
      mergeSrcIdemKey,
    );
    expect(mergeReplay.signal.id).toBe(mergeSrcCreated.signal.id);
    expect(mergeReplay.signal.accountLabel).toBeNull();
    expect(mergeReplay.signal.quoteExcerpt).toBeNull();

    const keptRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, keepIdemKey],
    );
    expect(keptRow.rows[0]?.response?.value?.signal?.accountLabel).toBe(keepAccount);
    expect(keptRow.rows[0]?.response?.value?.signal?.quoteExcerpt).toBe(keepQuote);

    // 3. Meeting signals omit quoteExcerpt in signal.create & idempotency_key cache so access revocation never leaks via replay
    const { meetingId: privMeeting } = await exec3<{ meetingId: string }>(alice3.userId, 'meetings.meeting.create', {
      title: 'Confidential Signal Meeting',
      consentMethod: 'told_at_start',
      visibility: 'attendees',
    });
    await exec3(alice3.userId, 'meetings.reader.add', { meetingId: privMeeting, userId: bob3.userId });

    const meetIdemKey = randomUUID();
    const meetQuoteCanary = 'MEETING_QUOTE_REVOKE_CANARY_4492';
    const meetPayload = {
      boardId: board3.id,
      roadmapItemId: itemDel.id,
      sourceType: 'meetings.meeting' as const,
      sourceId: privMeeting,
      accountLabel: 'Meeting Client 4492',
      quoteExcerpt: meetQuoteCanary,
    };
    const meetCreated = await exec3<RoadmapSignalCreateResult>(
      bob3.userId,
      'projects.roadmap.signal.create',
      meetPayload,
      meetIdemKey,
    );
    expect(meetCreated.signal.quoteExcerpt).toBeNull();

    const meetIdemRow = await sqlAdmin<IdemSignalRow>(
      `SELECT response, response::text AS resp_text FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org3.orgId, meetIdemKey],
    );
    expect(meetIdemRow.rows[0]?.response?.value?.signal?.quoteExcerpt).toBeNull();
    expect(meetIdemRow.rows[0]?.resp_text).not.toContain(meetQuoteCanary);

    const listBobBefore = await query3<RoadmapSignalListResult>(bob3.userId, 'projects.roadmap.signal.list', {
      boardId: board3.id,
      roadmapItemId: itemDel.id,
    });
    expect(listBobBefore.signals.find((s) => s.id === meetCreated.signal.id)?.quoteExcerpt).toBe(meetQuoteCanary);

    await exec3(alice3.userId, 'meetings.reader.remove', { meetingId: privMeeting, userId: bob3.userId });

    const meetReplayAfterRevoke = await exec3<RoadmapSignalCreateResult>(
      bob3.userId,
      'projects.roadmap.signal.create',
      meetPayload,
      meetIdemKey,
    );
    expect(meetReplayAfterRevoke.signal.id).toBe(meetCreated.signal.id);
    expect(meetReplayAfterRevoke.signal.quoteExcerpt).toBeNull();

    const listBobAfter = await query3<RoadmapSignalListResult>(bob3.userId, 'projects.roadmap.signal.list', {
      boardId: board3.id,
      roadmapItemId: itemDel.id,
    });
    expect(listBobAfter.signals.find((s) => s.id === meetCreated.signal.id)?.quoteExcerpt).toBeNull();

    const listAlice = await query3<RoadmapSignalListResult>(alice3.userId, 'projects.roadmap.signal.list', {
      boardId: board3.id,
      roadmapItemId: itemDel.id,
    });
    expect(listAlice.signals.find((s) => s.id === meetCreated.signal.id)?.quoteExcerpt).toBe(meetQuoteCanary);

    // 4. Propagates item tainted flag to ai_signal_match_source so external submissions are never whitelisted
    await sqlAdmin(`UPDATE ludy_projects.roadmap_item SET tainted = true WHERE org_id = $1 AND id = $2`, [
      org3.orgId,
      itemDel.id,
    ]);
    const taintedMatchSource = await query3<RoadmapAiSignalMatchSource>(
      alice3.userId,
      'projects.roadmap.ai_signal_match_source',
      { boardId: board3.id, sourceType: 'meetings.meeting', sourceId: privMeeting },
    );
    expect(taintedMatchSource.items.find((i) => i.id === itemDel.id)?.tainted).toBe(true);
  }, 60_000);

  it('clears party-linked signal account_label and source_party_id even after crm.deal.update reassigns the deal (#4492)', async () => {
    const owner4 = await person('owner-reassign');
    const org4 = await createOrg(rt, asUser(owner4.userId), 'Cong ty Reassign 4492');
    const exec4 = <T>(userId: string, cmd: string, input: unknown, idempotencyKey?: string) =>
      rt.execute<T>(cmd, input, {
        actor: asUser(userId),
        orgId: org4.orgId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

    const { board: board4 } = await exec4<{ board: RoadmapBoardSummary }>(owner4.userId, 'projects.roadmap.board.create', {
      title: 'Lo trinh Reassign',
      slug: 'roadmap-reassign',
    });
    const { item: item4 } = await exec4<{ item: RoadmapAdminItem }>(owner4.userId, 'projects.roadmap.item.create', {
      boardId: board4.id,
      publicTitle: 'Dong bo CRM',
      publicSummary: null,
      category: null,
    });

    await exec4(owner4.userId, 'crm.pipeline.setup', {});
    const emailA = 'reassign.pdpl@p4492.test';
    const nameA = 'Khach hang Goc Reassign';
    const partyARes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'person', $3) RETURNING id`,
      [org4.orgId, nameA, emailA],
    );
    const partyAId = partyARes.rows[0]!.id;
    const partyBRes = await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'organization', $3) RETURNING id`,
      [org4.orgId, 'Cong ty Moi Sau Doi', 'kept.party@p4492.test'],
    );
    const partyBId = partyBRes.rows[0]!.id;

    const deal = await exec4<Deal>(owner4.userId, 'crm.deal.create', {
      partyId: partyAId,
      title: 'Hop dong doi chu',
      amount: '5000000',
      expectedClose: null,
    });

    const signalIdemKey = randomUUID();
    const signalPayload = {
      boardId: board4.id,
      roadmapItemId: item4.id,
      sourceType: 'crm.deal' as const,
      sourceId: deal.id,
    };
    const created = await exec4<RoadmapSignalCreateResult>(
      owner4.userId,
      'projects.roadmap.signal.create',
      signalPayload,
      signalIdemKey,
    );
    expect(created.signal.accountLabel).toBe(nameA);

    await exec4<Deal>(owner4.userId, 'crm.deal.update', {
      dealId: deal.id,
      version: deal.version,
      partyId: partyBId,
      title: deal.title,
      amount: deal.amount,
      expectedClose: deal.expectedClose,
      ownerUserId: deal.ownerUserId,
    });

    const foundBefore = await rt.execute<{ matches: Array<{ column: string; rowId: string | null }> }>(
      'kernel.personal_data.find',
      { value: emailA },
      { actor: asMfa(owner4.userId), orgId: org4.orgId },
    );
    expect(
      foundBefore.matches.some(
        (m) => m.column === 'ludy_projects.roadmap_signal.account_label' && m.rowId === created.signal.id,
      ),
    ).toBe(true);

    await rt.execute(
      'kernel.personal_data.erase',
      { value: emailA },
      { actor: asMfa(owner4.userId), orgId: org4.orgId, idempotencyKey: randomUUID() },
    );

    const dbRow = await sqlAdmin<{ account_label: string | null; source_party_id: string | null }>(
      `SELECT account_label, source_party_id FROM ludy_projects.roadmap_signal WHERE org_id = $1 AND id = $2`,
      [org4.orgId, created.signal.id],
    );
    expect(dbRow.rows[0]?.account_label).toBeNull();
    expect(dbRow.rows[0]?.source_party_id).toBeNull();

    const idemRow = await sqlAdmin<{ response: { value?: { signal?: { accountLabel?: string | null } } } | null }>(
      `SELECT response FROM ludy_kernel.idempotency_key WHERE org_id = $1 AND key = $2 AND command = 'projects.roadmap.signal.create'`,
      [org4.orgId, signalIdemKey],
    );
    expect(idemRow.rows[0]?.response?.value?.signal?.accountLabel).toBeNull();

    const replay = await exec4<RoadmapSignalCreateResult>(
      owner4.userId,
      'projects.roadmap.signal.create',
      signalPayload,
      signalIdemKey,
    );
    expect(replay.signal.id).toBe(created.signal.id);
    expect(replay.signal.accountLabel).toBeNull();
  }, 60_000);
});
