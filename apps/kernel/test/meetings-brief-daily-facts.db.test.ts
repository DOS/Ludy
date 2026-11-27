// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy daily briefing facts query tests (#5073 Step 2b-1):
//   - verifies meetings.brief.daily_facts registration, zDailyBriefFactsInput validation, and isolation from RPC/contract;
//   - verifies memberVyRuntime reads own calendar_agenda without joining calendar_connection, reuses briefFactsOf under
//     RLS (published vs draft, series org vs private mAtt, reader grants, expired retention, CRM off, legal-entity scope);
//   - verifies deduplication across connections, connectionIds filtering, empty-brief skipping, 5-item cap, 20-scan cap,
//     non-contamination from notes/memory, cross-org isolation, MODULE_OFF, and actor denials.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  DAILY_BRIEF_MEETINGS_MAX,
  DAILY_BRIEF_WINDOW_HOURS_MAX,
  zDailyBriefFactsInput,
  type DailyBriefFacts,
  type Deal,
  type PipelineStage,
} from '@ludy/kernel-contract';
import { Runtime, memberVyRuntime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meetings.brief_daily' };
const AGENT_SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

const DAY1_FROM = '2026-11-27T00:00:00+07:00';
const DAY1_TO = '2026-11-28T00:00:00+07:00';
const DAY2_FROM = '2026-11-28T00:00:00+07:00';
const DAY2_TO = '2026-11-29T00:00:00+07:00';
const DAY3_FROM = '2026-11-29T00:00:00+07:00';
const DAY3_TO = '2026-11-30T00:00:00+07:00';

const NOTE_SECRET_SENTINEL = 'SENTINEL_PRIVATE_NOTE_MUST_NOT_LEAK_5073';
const MEMORY_SECRET_SENTINEL = 'SENTINEL_VY_MEMORY_MUST_NOT_LEAK_5073';

interface RunHandle {
  agentId: string;
  runId: string;
}

describe('meetings.brief.daily_facts registration (#5073)', () => {
  it('registers kernel, crm, and meetings cleanly with narrow memberVy opt-in on meetings.brief.daily_facts', () => {
    const rt = new Runtime({} as never, { manifests: TEST_MANIFESTS });
    expect(() =>
      rt.register({
        commands: [...kernelCommands, ...crmCommands, ...meetingsCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries],
      }),
    ).not.toThrow();

    const optedIn = meetingsQueries.filter((q) => q.memberVy !== undefined);
    expect(optedIn.map((q) => q.name)).toEqual(['meetings.brief.daily_facts']);

    const daily = optedIn[0]!;
    expect(daily.access).toEqual(['owner', 'admin', 'member']);
    expect(daily.memberVy).toEqual({ reads: ['crm.deal.get', 'crm.deal.list', 'crm.stage.list'] });
    expect(daily.sensitive).toBeUndefined();
    expect(daily.stream).toBeUndefined();
    expect(daily.mcp).toBeUndefined();

    const singleBrief = meetingsQueries.find((q) => q.name === 'meetings.brief.facts');
    expect(singleBrief?.sensitive).toBe(true);
    expect(singleBrief?.memberVy).toBeUndefined();
  });

  it('validates zDailyBriefFactsInput window bounds, offsets, and connectionIds limits', () => {
    expect(zDailyBriefFactsInput.safeParse({ from: DAY1_FROM, to: DAY1_TO }).success).toBe(true);
    expect(
      zDailyBriefFactsInput.safeParse({
        from: '2026-11-27T00:00:00Z',
        to: new Date(Date.parse('2026-11-27T00:00:00Z') + DAILY_BRIEF_WINDOW_HOURS_MAX * 3_600_000).toISOString(),
        connectionIds: [],
      }).success,
    ).toBe(true);

    // to <= from
    expect(zDailyBriefFactsInput.safeParse({ from: DAY1_FROM, to: DAY1_FROM }).success).toBe(false);
    expect(zDailyBriefFactsInput.safeParse({ from: DAY1_TO, to: DAY1_FROM }).success).toBe(false);

    // > 26h window
    expect(
      zDailyBriefFactsInput.safeParse({
        from: '2026-11-27T00:00:00Z',
        to: new Date(Date.parse('2026-11-27T00:00:00Z') + DAILY_BRIEF_WINDOW_HOURS_MAX * 3_600_000 + 1).toISOString(),
      }).success,
    ).toBe(false);

    // > 20 connectionIds
    expect(
      zDailyBriefFactsInput.safeParse({
        from: DAY1_FROM,
        to: DAY1_TO,
        connectionIds: Array.from({ length: 21 }, () => randomUUID()),
      }).success,
    ).toBe(false);

    // Missing timezone offset and strict extra keys
    expect(zDailyBriefFactsInput.safeParse({ from: '2026-11-27T00:00:00', to: DAY1_TO }).success).toBe(false);
    expect(zDailyBriefFactsInput.safeParse({ from: DAY1_FROM, to: DAY1_TO, extra: true }).success).toBe(false);
  });
});

suite('meetings.brief.daily_facts on PostgreSQL (#5073)', () => {
  const dbName = `ludy_test_brief_daily_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;

  let orgA = '';
  let orgB = '';
  let branchId = '';

  const users = {
    ownerA: '',
    memberVy: '',
    scopedVy: '',
    viewerVy: '',
    other: '',
    ownerB: '',
  };

  const runs: Record<'memberVy' | 'scopedVy' | 'viewerVy' | 'orgChart', RunHandle> = {
    memberVy: { agentId: '', runId: '' },
    scopedVy: { agentId: '', runId: '' },
    viewerVy: { agentId: '', runId: '' },
    orgChart: { agentId: '', runId: '' },
  };

  const conns = {
    primary: randomUUID(),
    secondary: randomUUID(),
    disconnected: randomUUID(),
    scoped: randomUUID(),
    orgB: randomUUID(),
  };

  const series = {
    org: randomUUID(),
    attPrivate: randomUUID(),
    dup: randomUUID(),
    emptyDone: randomUUID(),
    scopedShared: randomUUID(),
    day2: Array.from({ length: 6 }, () => randomUUID()),
    day3Hit: randomUUID(),
  };

  const ids = {
    // Day 1 meetings
    mOrgPrev: randomUUID(),
    mAttPrev: randomUUID(),
    mShared: randomUUID(),
    mDupPrev: randomUUID(),
    mDupRecorded: randomUUID(),
    mExpired: randomUUID(),
    mScopedOwn: randomUUID(),
    mScopedSharedPrev: randomUUID(),
    mOrgB: randomUUID(),

    // Day 1 agenda rows
    agOrg: randomUUID(),
    agAtt: randomUUID(),
    agShared: randomUUID(),
    agDupSeriesLow: '',
    agDupSeriesHigh: '',
    agDupMeetingLow: '',
    agDupMeetingHigh: '',
    agDisconnected: randomUUID(),
    agExpired: randomUUID(),
    agScopedOrg: randomUUID(),
    agScopedOwn: randomUUID(),
    agScopedShared: randomUUID(),
    agOrgB: randomUUID(),

    // Day 2 & Day 3 agenda rows
    agDay2NonEmpty: Array.from({ length: 6 }, () => randomUUID()),
    agDay3Hit: randomUUID(),
  };

  let partyA1 = '';
  let partyA2 = '';
  let partySecret = '';
  let partyScoped = '';
  let partyB = '';
  let dealA1!: Deal;
  let dealA4!: Deal;
  let dealScoped!: Deal;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function expectForbidden(promise: Promise<unknown>, rule?: 'member_vy_access' | 'agent_access') {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject(
      rule ? { code: 'FORBIDDEN', status: 403, details: { rule } } : { code: 'FORBIDDEN', status: 403 },
    );
  }

  async function seedMeeting(
    c: pg.Client,
    orgId: string,
    meetingId: string,
    recorderId: string,
    visibility: 'org' | 'attendees',
    title: string,
    startedAt: string,
    seriesId: string | null,
    expiredText = false,
  ): Promise<void> {
    const retentionSql = expiredText ? 'current_date - 2' : 'current_date + 365';
    await c.query(
      `INSERT INTO ludy_meetings.meeting (
         org_id, id, recorder_user_id, visibility, title, language, status,
         started_at, ended_at, length_seconds, consent_method,
         consent_confirmed_by, consent_confirmed_at, consent_notice_version,
         audio_retention_date, text_retention_date, series_id
       )
       VALUES (
         $1, $2, $3, $4, $5, 'vi', 'ready',
         $6::timestamptz, $6::timestamptz + interval '30 minutes', 1800, 'told_at_start',
         $3, $6::timestamptz, '1.0',
         current_date + 30, ${retentionSql}, $7
       )`,
      [orgId, meetingId, recorderId, visibility, title, startedAt, seriesId],
    );
  }

  async function seedResult(
    c: pg.Client,
    orgId: string,
    meetingId: string,
    stage: 'draft' | 'published',
    decisions: readonly string[],
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.meeting_result (
         org_id, id, meeting_id, summary, decisions, feature, stage, tainted
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, 'manual', $6, $7)`,
      [orgId, randomUUID(), meetingId, `Summary ${stage}`, JSON.stringify(decisions), stage, stage === 'draft'],
    );
  }

  async function seedActionItem(
    c: pg.Client,
    orgId: string,
    meetingId: string,
    title: string,
    stage: 'draft' | 'published',
    whoParsed: string,
    taskStatus?: 'todo' | 'in_progress' | 'done',
  ): Promise<void> {
    let taskId: string | null = null;
    if (taskStatus !== undefined) {
      taskId = randomUUID();
      await c.query(
        `INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status)
         VALUES ($1, $2, $3, 'human', 'system', $4)`,
        [orgId, taskId, title, taskStatus],
      );
    }
    await c.query(
      `INSERT INTO ludy_meetings.action_item (
         org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted,
         when_parsed, transcript_seconds, stage, status, task_id, flags, tainted
       )
       VALUES (
         $1, $2, $3, $4, 'An', $5, 'Thu sau',
         '2026-11-27', 60, $6, $7, $8, '[]'::jsonb, $9
       )`,
      [orgId, randomUUID(), meetingId, title, whoParsed, stage, taskId === null ? 'suggested' : 'accepted', taskId, stage === 'draft'],
    );
  }

  async function seedConnection(
    c: pg.Client,
    orgId: string,
    connectionId: string,
    userId: string,
    tag: string,
    options: { status?: 'active' | 'expired'; readEvents?: boolean } = {},
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_kernel.calendar_connection (
         org_id, id, user_id, provider, external_account, display_name, scopes, status, read_events
       )
       VALUES ($1, $2, $3, 'google', $4, $5, '{}'::text[], $6, $7)`,
      [orgId, connectionId, userId, `${userId}-${tag}@calendar.test`, tag, options.status ?? 'active', options.readEvents ?? true],
    );
  }

  async function seedAgendaRow(
    c: pg.Client,
    row: {
      orgId: string;
      id: string;
      connectionId: string;
      userId: string;
      externalId: string;
      title: string;
      startsAt: string;
      meetingId?: string | null;
      seriesId?: string | null;
    },
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.calendar_agenda (
         org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, meeting_id, series_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::timestamptz, $7::timestamptz + interval '30 minutes', 'Asia/Ho_Chi_Minh', $8, $9
       )`,
      [
        row.orgId,
        row.id,
        row.connectionId,
        row.userId,
        row.externalId,
        row.title,
        row.startsAt,
        row.meetingId ?? null,
        row.seriesId ?? null,
      ],
    );
  }

  beforeAll(async () => {
    const [dupSeriesLow, dupSeriesHigh] = [randomUUID(), randomUUID()].sort() as [string, string];
    ids.agDupSeriesLow = dupSeriesLow;
    ids.agDupSeriesHigh = dupSeriesHigh;
    const [dupMeetLow, dupMeetHigh] = [randomUUID(), randomUUID()].sort() as [string, string];
    ids.agDupMeetingLow = dupMeetLow;
    ids.agDupMeetingHigh = dupMeetHigh;

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

    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);

    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    const registry = {
      commands: [...kernelCommands, ...crmCommands, ...meetingsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...crmQueries, ...meetingsQueries, ...notesQueries],
    };
    app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'meetings-brief-daily-facts',
        subject: key,
        email: `${key}-${randomUUID().slice(0, 8)}@brief-daily.test`,
        name: key,
      });
    }

    orgA = (await createOrg(app, asUser(users.ownerA), 'Org A Daily Brief')).orgId;
    orgB = (await createOrg(app, asUser(users.ownerB), 'Org B Daily Brief')).orgId;

    await admin(async (c) => {
      const branchRow = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by)
         VALUES ($1, 'Branch A', 'branch', $2) RETURNING id`,
        [orgA, users.ownerA],
      );
      branchId = branchRow.rows[0]?.id ?? '';
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member'),
                ($6, $2, 'member')`,
        [orgA, users.memberVy, users.scopedVy, users.viewerVy, users.other, orgB],
      );
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgA, users.scopedVy, branchId, users.ownerA],
      );
    });

    await app.execute(
      'kernel.member.permission.set',
      { userId: users.viewerVy, permission: 'vy.use', allowed: true },
      { actor: asUser(users.ownerA), orgId: orgA },
    );

    const startDaily = (userId: string) =>
      worker.execute<{ agentId: string; runId: string }>(
        'kernel.member_vy.run.start_daily',
        { userId, feature: 'meetings.brief_daily' },
        { actor: SYSTEM, orgId: orgA },
      );

    runs.memberVy = await startDaily(users.memberVy);
    runs.scopedVy = await startDaily(users.scopedVy);
    runs.viewerVy = await startDaily(users.viewerVy);

    const installed = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'crm.scheduler' },
      { actor: asMfa(users.ownerA), orgId: orgA },
    );
    await app.execute(
      'kernel.task.create',
      { title: 'Org chart agent probe', assigneePositionId: installed.positionId },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    const orgChartStart = await worker.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: AGENT_SYSTEM, orgId: orgA },
    );
    runs.orgChart = { agentId: installed.agentId, runId: orgChartStart.runId ?? '' };

    // CRM pipeline and deals in Org A and Org B
    const stagesA = await app.execute<PipelineStage[]>('crm.pipeline.setup', {}, { actor: asUser(users.ownerA), orgId: orgA });
    await app.execute<PipelineStage[]>('crm.pipeline.setup', {}, { actor: asUser(users.ownerB), orgId: orgB });
    const wonStageA = stagesA.find((s) => s.kind === 'won')!;

    const newParty = async (orgId: string, actorId: string, name: string) =>
      (await app.execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name }, { actor: asUser(actorId), orgId })).partyId;

    partyA1 = await newParty(orgA, users.ownerA, 'Cong ty Minh Anh');
    partyA2 = await newParty(orgA, users.ownerA, 'Cong ty Binh Minh');
    partySecret = await newParty(orgA, users.ownerA, 'Cong ty Bi Mat');
    partyScoped = await newParty(orgA, users.ownerA, 'Cong ty Chi Nhanh');
    partyB = await newParty(orgB, users.ownerB, 'Cong ty Ngoai To Chuc');

    dealA1 = await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partyA1, title: 'Goi tu van nam', amount: '15000000.5', expectedClose: '2026-12-31', ownerUserId: users.memberVy },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    const wonDeal = await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partyA1, title: 'Goi da chot', amount: '9000000', expectedClose: '2026-10-01', ownerUserId: users.ownerA },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    await app.execute<Deal>(
      'crm.deal.move',
      { dealId: wonDeal.id, version: wonDeal.version, stageId: wonStageA.id },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    dealA4 = await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partyA2, title: 'Goi mo rong', amount: '4200000', expectedClose: '2026-12-15', ownerUserId: users.other },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partySecret, title: 'Goi rieng tu mAtt', amount: '7777777', expectedClose: null, ownerUserId: users.other },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    dealScoped = await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partyScoped, title: 'Goi chi nhanh A', amount: '3100000.25', expectedClose: '2026-12-20', ownerUserId: users.scopedVy },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    await app.execute<Deal>(
      'crm.deal.create',
      { partyId: partyB, title: 'Goi bi mat Org B', amount: '88888888', expectedClose: '2026-12-31', ownerUserId: users.ownerB },
      { actor: asUser(users.ownerB), orgId: orgB },
    );

    // Seed private note and Vy memory for memberVy to verify non-contamination
    await app.execute(
      'notes.note.create',
      { title: NOTE_SECRET_SENTINEL, body: `Body ${NOTE_SECRET_SENTINEL}`, visibility: 'private' },
      { actor: asUser(users.memberVy), orgId: orgA },
    );
    await app.execute(
      'kernel.member_vy.memory.save',
      { body: MEMORY_SECRET_SENTINEL },
      { actor: asUser(users.memberVy), orgId: orgA },
    );

    await admin(async (c) => {
      // Calendar connections
      await seedConnection(c, orgA, conns.primary, users.memberVy, 'primary');
      await seedConnection(c, orgA, conns.secondary, users.memberVy, 'secondary');
      await seedConnection(c, orgA, conns.disconnected, users.memberVy, 'disconnected', { status: 'expired', readEvents: false });
      await seedConnection(c, orgA, conns.scoped, users.scopedVy, 'scoped');
      await seedConnection(c, orgB, conns.orgB, users.memberVy, 'orgB');

      // (a) Org-visible previous meeting in series.org (published + draft + open/done items + linked partyA1)
      await seedMeeting(c, orgA, ids.mOrgPrev, users.ownerA, 'org', 'Org Series Prev', '2026-11-20T09:00:00+07:00', series.org);
      await seedResult(c, orgA, ids.mOrgPrev, 'published', ['Chot gia goi tu van 15.000.000 dong']);
      await seedResult(c, orgA, ids.mOrgPrev, 'draft', ['Quyet dinh nhap khong duoc lo']);
      await seedActionItem(c, orgA, ids.mOrgPrev, 'Gui hop dong ban cuoi', 'published', users.memberVy, 'in_progress');
      await seedActionItem(c, orgA, ids.mOrgPrev, 'Viec da hoan thanh', 'published', users.memberVy, 'done');
      await seedActionItem(c, orgA, ids.mOrgPrev, 'Muc nhap bi an', 'draft', users.memberVy);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mOrgPrev, partyA1, users.ownerA],
      );

      // (b) Private attendees meeting NOT shared with memberVy (shared only with other)
      await seedMeeting(c, orgA, ids.mAttPrev, users.ownerA, 'attendees', 'Private mAtt Prev', '2026-11-20T10:00:00+07:00', series.attPrivate);
      await seedResult(c, orgA, ids.mAttPrev, 'published', ['Secret mAtt decision']);
      await seedActionItem(c, orgA, ids.mAttPrev, 'Secret mAtt action', 'published', users.other);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [orgA, randomUUID(), ids.mAttPrev, users.other],
      );
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mAttPrev, partySecret, users.ownerA],
      );

      // (c) Recorded attendees meeting shared via meeting_reader, linked to dealA4 by deal_id
      await seedMeeting(c, orgA, ids.mShared, users.ownerA, 'attendees', 'Shared Recorded Meeting', '2026-11-27T11:00:00+07:00', null);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [orgA, randomUUID(), ids.mShared, users.memberVy],
      );
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mShared, dealA4.id, users.ownerA],
      );

      // (d) Duplicate series & recorded meetings
      await seedMeeting(c, orgA, ids.mDupPrev, users.memberVy, 'attendees', 'Dup Series Prev', '2026-11-20T13:00:00+07:00', series.dup);
      await seedResult(c, orgA, ids.mDupPrev, 'published', ['Dup series published decision']);

      await seedMeeting(c, orgA, ids.mDupRecorded, users.memberVy, 'attendees', 'Dup Recorded Meeting', '2026-11-27T14:00:00+07:00', null);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mDupRecorded, partyA2, users.memberVy],
      );

      // (g) Expired text_retention_date meeting
      await seedMeeting(c, orgA, ids.mExpired, users.memberVy, 'attendees', 'Expired Text Meeting', '2026-11-27T15:00:00+07:00', null, true);
      await seedResult(c, orgA, ids.mExpired, 'published', ['Expired decision should not surface']);

      // Empty-brief series with only a done task (used in Day 2)
      const mDoneOnly = randomUUID();
      await seedMeeting(c, orgA, mDoneOnly, users.memberVy, 'attendees', 'Done Only Prev', '2026-11-20T08:00:00+07:00', series.emptyDone);
      await seedActionItem(c, orgA, mDoneOnly, 'Already finished item', 'published', users.memberVy, 'done');

      // Day 1 agenda rows for memberVy
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agOrg,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day1-org',
        title: 'Org Recurring Call',
        startsAt: '2026-11-27T09:00:00+07:00',
        seriesId: series.org,
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agAtt,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day1-att',
        title: 'Private Attendees Call',
        startsAt: '2026-11-27T10:00:00+07:00',
        seriesId: series.attPrivate,
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agShared,
        connectionId: conns.secondary,
        userId: users.memberVy,
        externalId: 'ext-day1-shared',
        title: 'Shared Recorded Call',
        startsAt: '2026-11-27T11:00:00+07:00',
        meetingId: ids.mShared,
      });
      // Duplicate pair 1: series_id !== null beats unlinked (even when unlinked row has smaller id)
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDupSeriesLow,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day1-dup-series',
        title: 'Dup Series Unlinked',
        startsAt: '2026-11-27T13:00:00+07:00',
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDupSeriesHigh,
        connectionId: conns.secondary,
        userId: users.memberVy,
        externalId: 'ext-day1-dup-series',
        title: 'Dup Series Linked',
        startsAt: '2026-11-27T13:00:00+07:00',
        seriesId: series.dup,
      });
      // Duplicate pair 2: meeting_id !== null beats series_id !== null (even when series-only row has smaller id)
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDupMeetingLow,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day1-dup-meeting',
        title: 'Dup Meeting Series Only',
        startsAt: '2026-11-27T14:00:00+07:00',
        seriesId: series.emptyDone,
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDupMeetingHigh,
        connectionId: conns.secondary,
        userId: users.memberVy,
        externalId: 'ext-day1-dup-meeting',
        title: 'Dup Meeting Recorded',
        startsAt: '2026-11-27T14:00:00+07:00',
        meetingId: ids.mDupRecorded,
        seriesId: series.emptyDone,
      });
      // Disconnected/unselected connection event
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDisconnected,
        connectionId: conns.disconnected,
        userId: users.memberVy,
        externalId: 'ext-day1-disconnected',
        title: 'Disconnected Connection Call',
        startsAt: '2026-11-27T14:30:00+07:00',
        seriesId: series.org,
      });
      // Expired retention event
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agExpired,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day1-expired',
        title: 'Expired Meeting Call',
        startsAt: '2026-11-27T15:00:00+07:00',
        meetingId: ids.mExpired,
      });

      // (i) ScopedVy meetings and Day 1 agenda rows
      await seedMeeting(c, orgA, ids.mScopedOwn, users.scopedVy, 'attendees', 'Scoped Own Meeting', '2026-11-27T10:00:00+07:00', null);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mScopedOwn, partyScoped, users.scopedVy],
      );
      await seedMeeting(c, orgA, ids.mScopedSharedPrev, users.ownerA, 'attendees', 'Scoped Shared Prev', '2026-11-20T11:00:00+07:00', series.scopedShared);
      await seedResult(c, orgA, ids.mScopedSharedPrev, 'published', ['Scoped shared series decision']);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [orgA, randomUUID(), ids.mScopedSharedPrev, users.scopedVy],
      );

      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agScopedOrg,
        connectionId: conns.scoped,
        userId: users.scopedVy,
        externalId: 'ext-scoped-org',
        title: 'Scoped Org Series Hidden',
        startsAt: '2026-11-27T09:00:00+07:00',
        seriesId: series.org,
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agScopedOwn,
        connectionId: conns.scoped,
        userId: users.scopedVy,
        externalId: 'ext-scoped-own',
        title: 'Scoped Own Recorded',
        startsAt: '2026-11-27T10:00:00+07:00',
        meetingId: ids.mScopedOwn,
      });
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agScopedShared,
        connectionId: conns.scoped,
        userId: users.scopedVy,
        externalId: 'ext-scoped-shared',
        title: 'Scoped Shared Series',
        startsAt: '2026-11-27T11:00:00+07:00',
        seriesId: series.scopedShared,
      });

      // (f) Day 2: 3 empty-brief events interleaved with 6 non-empty events (cap at 5)
      for (let i = 0; i < 6; i++) {
        const prevId = randomUUID();
        const sid = series.day2[i]!;
        await seedMeeting(c, orgA, prevId, users.memberVy, 'attendees', `Day2 Prev ${i + 1}`, '2026-11-20T08:00:00+07:00', sid);
        await seedResult(c, orgA, prevId, 'published', [`Day2 decision ${i + 1}`]);
      }
      const day2Plan: Array<{ hour: string; agId?: string; sid?: string }> = [
        { hour: '08:00' },
        { hour: '09:00', agId: ids.agDay2NonEmpty[0]!, sid: series.day2[0]! },
        { hour: '10:00', sid: series.emptyDone },
        { hour: '11:00', agId: ids.agDay2NonEmpty[1]!, sid: series.day2[1]! },
        { hour: '12:00', sid: series.attPrivate },
        { hour: '13:00', agId: ids.agDay2NonEmpty[2]!, sid: series.day2[2]! },
        { hour: '14:00', agId: ids.agDay2NonEmpty[3]!, sid: series.day2[3]! },
        { hour: '15:00', agId: ids.agDay2NonEmpty[4]!, sid: series.day2[4]! },
        { hour: '16:00', agId: ids.agDay2NonEmpty[5]!, sid: series.day2[5]! },
      ];
      for (const [idx, slot] of day2Plan.entries()) {
        await seedAgendaRow(c, {
          orgId: orgA,
          id: slot.agId ?? randomUUID(),
          connectionId: conns.primary,
          userId: users.memberVy,
          externalId: `ext-day2-${idx}`,
          title: `Day2 Slot ${idx}`,
          startsAt: `2026-11-28T${slot.hour}:00+07:00`,
          seriesId: slot.sid ?? null,
        });
      }

      // Day 3: 20 empty events before 1 non-empty event at #21 (tests DAILY_BRIEF_SCAN_MAX = 20)
      const prevDay3 = randomUUID();
      await seedMeeting(c, orgA, prevDay3, users.memberVy, 'attendees', 'Day3 Prev', '2026-11-20T08:00:00+07:00', series.day3Hit);
      await seedResult(c, orgA, prevDay3, 'published', ['Day3 decision past scan limit']);
      for (let i = 0; i < 20; i++) {
        const hh = String(Math.floor(i / 2) + 8).padStart(2, '0');
        const mm = i % 2 === 0 ? '00' : '30';
        await seedAgendaRow(c, {
          orgId: orgA,
          id: randomUUID(),
          connectionId: conns.primary,
          userId: users.memberVy,
          externalId: `ext-day3-empty-${i}`,
          title: `Day3 Empty ${i}`,
          startsAt: `2026-11-29T${hh}:${mm}:00+07:00`,
        });
      }
      await seedAgendaRow(c, {
        orgId: orgA,
        id: ids.agDay3Hit,
        connectionId: conns.primary,
        userId: users.memberVy,
        externalId: 'ext-day3-hit',
        title: 'Day3 Past Scan Max',
        startsAt: '2026-11-29T20:00:00+07:00',
        seriesId: series.day3Hit,
      });

      // Org B data (same userId memberVy + ownerB) for cross-org isolation
      await seedMeeting(c, orgB, ids.mOrgB, users.memberVy, 'org', 'Org B Secret Meeting', '2026-11-27T09:00:00+07:00', null);
      await seedResult(c, orgB, ids.mOrgB, 'published', ['Org B Secret Decision']);
      await c.query(
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgB, randomUUID(), ids.mOrgB, partyB, users.memberVy],
      );
      await seedAgendaRow(c, {
        orgId: orgB,
        id: ids.agOrgB,
        connectionId: conns.orgB,
        userId: users.memberVy,
        externalId: 'ext-orgb',
        title: 'Org B Call',
        startsAt: '2026-11-27T09:00:00+07:00',
        meetingId: ids.mOrgB,
      });
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('returns org-visible, shared, and deduplicated daily facts while excluding drafts, private mAtt, won deals, expired retention, notes, and Vy memory', async () => {
    const vy = memberVyRuntime(worker, orgA, runs.memberVy);

    // Exclude disconnected connection via caller-supplied active connectionIds
    const daily = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY1_FROM,
      to: DAY1_TO,
      connectionIds: [conns.primary, conns.secondary],
    });

    expect(daily.items.map((item) => item.agendaId)).toEqual([
      ids.agOrg,
      ids.agShared,
      ids.agDupSeriesHigh,
      ids.agDupMeetingHigh,
    ]);

    // (a) Unrecorded event in recurring org series: published decisions & open items, won deal & drafts excluded
    const itemOrg = daily.items[0]!;
    expect(itemOrg.meetingId).toBeNull();
    expect(itemOrg.brief.previous?.meetingId).toBe(ids.mOrgPrev);
    expect(itemOrg.brief.decisions).toEqual(['Chot gia goi tu van 15.000.000 dong']);
    expect(itemOrg.brief.items.map((i) => i.title)).toEqual(['Gui hop dong ban cuoi']);
    expect(itemOrg.brief.customer).toEqual({ partyId: partyA1, name: 'Cong ty Minh Anh' });
    expect(itemOrg.brief.deals).toEqual([
      {
        id: dealA1.id,
        title: 'Goi tu van nam',
        stage: 'Mới',
        amount: '15000000.50',
        expectedClose: '2026-12-31',
      },
    ]);

    // (c) Recorded event shared via meeting_reader with deal_id link -> resolves customer & open deal decimal string
    const itemShared = daily.items[1]!;
    expect(itemShared.meetingId).toBe(ids.mShared);
    expect(itemShared.brief.customer).toEqual({ partyId: partyA2, name: 'Cong ty Binh Minh' });
    expect(itemShared.brief.deals).toEqual([
      {
        id: dealA4.id,
        title: 'Goi mo rong',
        stage: 'Mới',
        amount: '4200000.00',
        expectedClose: '2026-12-15',
      },
    ]);

    // (d) Deduplication prefers series_id over unlinked, and meeting_id over series_id
    const itemDupSeries = daily.items[2]!;
    expect(itemDupSeries.meetingId).toBeNull();
    expect(itemDupSeries.brief.decisions).toEqual(['Dup series published decision']);

    const itemDupMeeting = daily.items[3]!;
    expect(itemDupMeeting.meetingId).toBe(ids.mDupRecorded);
    expect(itemDupMeeting.brief.customer).toEqual({ partyId: partyA2, name: 'Cong ty Binh Minh' });

    // (b), (g), (j) Zero leakage from private mAtt, drafts, expired retention, Org B, notes, or Vy memory
    const serialized = JSON.stringify(daily);
    expect(serialized).not.toContain('Secret mAtt');
    expect(serialized).not.toContain('Cong ty Bi Mat');
    expect(serialized).not.toContain('Goi rieng tu mAtt');
    expect(serialized).not.toContain('Quyet dinh nhap');
    expect(serialized).not.toContain('Muc nhap bi an');
    expect(serialized).not.toContain('Goi da chot');
    expect(serialized).not.toContain('Viec da hoan thanh');
    expect(serialized).not.toContain('Expired decision');
    expect(serialized).not.toContain('Org B Secret');
    expect(serialized).not.toContain('Disconnected Connection Call');
    expect(serialized).not.toContain(NOTE_SECRET_SENTINEL);
    expect(serialized).not.toContain(MEMORY_SECRET_SENTINEL);

    // Verify member_vy_table opt-in catalog has strictly the 5 Meetings read tables (zero notes/memory cross-opt-in here)
    await admin(async (c) => {
      const { rows } = await c.query<{ table_name: string }>(
        `SELECT table_name FROM ludy_kernel.member_vy_table WHERE table_name LIKE 'ludy_meetings.%' ORDER BY 1`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'ludy_meetings.action_item',
        'ludy_meetings.calendar_agenda',
        'ludy_meetings.meeting',
        'ludy_meetings.meeting_link',
        'ludy_meetings.meeting_result',
      ]);
    });
  });

  it('filters by connectionIds and handles empty connectionIds without failing', async () => {
    const vy = memberVyRuntime(worker, orgA, runs.memberVy);

    expect(
      await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
        from: DAY1_FROM,
        to: DAY1_TO,
        connectionIds: [],
      }),
    ).toEqual({ items: [] });

    const onlyPrimary = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY1_FROM,
      to: DAY1_TO,
      connectionIds: [conns.primary],
    });
    expect(onlyPrimary.items.map((item) => item.agendaId)).toEqual([ids.agOrg]);
  });

  it('skips empty briefs, caps output at DAILY_BRIEF_MEETINGS_MAX (5), and stops scanning after 20 deduplicated rows', async () => {
    const vy = memberVyRuntime(worker, orgA, runs.memberVy);

    const day2 = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY2_FROM,
      to: DAY2_TO,
      connectionIds: [conns.primary],
    });
    expect(day2.items).toHaveLength(DAILY_BRIEF_MEETINGS_MAX);
    expect(day2.items.map((item) => item.agendaId)).toEqual(ids.agDay2NonEmpty.slice(0, DAILY_BRIEF_MEETINGS_MAX));
    expect(day2.items.map((item) => item.brief.decisions[0])).toEqual([
      'Day2 decision 1',
      'Day2 decision 2',
      'Day2 decision 3',
      'Day2 decision 4',
      'Day2 decision 5',
    ]);

    const day3 = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY3_FROM,
      to: DAY3_TO,
      connectionIds: [conns.primary],
    });
    expect(day3).toEqual({ items: [] });
  });

  it('returns decisions and items with deals: [] when the CRM app is disabled', async () => {
    const vy = memberVyRuntime(worker, orgA, runs.memberVy);
    await app.execute('kernel.org.set_app', { module: 'crm', enabled: false }, { actor: asUser(users.ownerA), orgId: orgA });
    try {
      const daily = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
        from: DAY1_FROM,
        to: DAY1_TO,
        connectionIds: [conns.primary, conns.secondary],
      });
      // mShared (deal_id only) and mDupRecorded (party_id only, no decisions/items) yield empty briefs when CRM is off
      // and are skipped cleanly; agOrg and agDupSeriesHigh still return with decisions/items and deals: [].
      expect(daily.items.map((item) => item.agendaId)).toEqual([
        ids.agOrg,
        ids.agDupSeriesHigh,
      ]);
      expect(daily.items[0]!.brief.decisions).toEqual(['Chot gia goi tu van 15.000.000 dong']);
      expect(daily.items[0]!.brief.items.map((i) => i.title)).toEqual(['Gui hop dong ban cuoi']);
      expect(daily.items[0]!.brief.customer).toEqual({ partyId: partyA1, name: 'Cong ty Minh Anh' });
      expect(daily.items[0]!.brief.deals).toEqual([]);
      expect(daily.items[1]!.brief.decisions).toEqual(['Dup series published decision']);
      expect(daily.items[1]!.brief.deals).toEqual([]);
    } finally {
      await app.execute('kernel.org.set_app', { module: 'crm', enabled: true }, { actor: asUser(users.ownerA), orgId: orgA });
    }
  });

  it('enforces single-branch legal-entity scope on scopedVy while allowing own and shared meetings', async () => {
    const vyScoped = memberVyRuntime(worker, orgA, runs.scopedVy);
    const daily = await vyScoped.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY1_FROM,
      to: DAY1_TO,
      connectionIds: [conns.scoped],
    });

    expect(daily.items.map((item) => item.agendaId)).toEqual([ids.agScopedOwn, ids.agScopedShared]);
    expect(daily.items[0]!.meetingId).toBe(ids.mScopedOwn);
    expect(daily.items[0]!.brief.customer).toEqual({ partyId: partyScoped, name: 'Cong ty Chi Nhanh' });
    expect(daily.items[0]!.brief.deals).toEqual([
      {
        id: dealScoped.id,
        title: 'Goi chi nhanh A',
        stage: 'Mới',
        amount: '3100000.25',
        expectedClose: '2026-12-20',
      },
    ]);
    expect(daily.items[1]!.meetingId).toBeNull();
    expect(daily.items[1]!.brief.decisions).toEqual(['Scoped shared series decision']);
    expect(JSON.stringify(daily)).not.toContain('Chot gia goi tu van');
  });

  it('denies interactive users, viewerVy, org-chart agents, system actors, and disabled Meetings app', async () => {
    const vyViewer = memberVyRuntime(worker, orgA, runs.viewerVy);
    const orgAgentActor = {
      type: 'agent' as const,
      agentId: runs.orgChart.agentId,
      runId: runs.orgChart.runId,
    };
    const input = { from: DAY1_FROM, to: DAY1_TO };

    await expectForbidden(app.query('meetings.brief.daily_facts', input, { actor: asUser(users.memberVy), orgId: orgA }));
    await expectForbidden(vyViewer.query('meetings.brief.daily_facts', input), 'member_vy_access');
    await expectForbidden(worker.query('meetings.brief.daily_facts', input, { actor: orgAgentActor, orgId: orgA }), 'agent_access');
    await expectForbidden(worker.query('meetings.brief.daily_facts', input, { actor: SYSTEM, orgId: orgA }));

    const vy = memberVyRuntime(worker, orgA, runs.memberVy);

    // Cross-org isolation: even without connectionIds or with Org B's connectionId, Org A sees zero Org B data
    const allConnsDay1 = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: DAY1_FROM,
      to: DAY1_TO,
    });
    expect(allConnsDay1.items.some((item) => item.agendaId === ids.agOrgB)).toBe(false);
    expect(JSON.stringify(allConnsDay1)).not.toContain('Org B Secret');
    expect(
      await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
        from: DAY1_FROM,
        to: DAY1_TO,
        connectionIds: [conns.orgB],
      }),
    ).toEqual({ items: [] });

    await app.execute('kernel.org.set_app', { module: 'meetings', enabled: false }, { actor: asUser(users.ownerA), orgId: orgA });
    try {
      await expect(vy.query('meetings.brief.daily_facts', input)).rejects.toMatchObject({ code: 'MODULE_OFF' });
    } finally {
      await app.execute('kernel.org.set_app', { module: 'meetings', enabled: true }, { actor: asUser(users.ownerA), orgId: orgA });
    }
  });
});
