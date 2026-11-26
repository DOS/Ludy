// SPDX-License-Identifier: AGPL-3.0-only
// Meetings 5-table member_vy read opt-in tests (#5073 Step 2a, ADR-0049 decision 2 amendment):
//   - verifies member_vy_table registration, hardeningViolations, and is_agent_meeting_reader security properties;
//   - verifies memberVy reads own/shared/org meetings, published results/items, links, and own calendar_agenda while
//     excluding drafts, hidden mAtt meetings, and sensitive non-opt-in tables;
//   - verifies scopedVy legal-entity isolation, viewerVy (with vy.use) complete denial, org_chart/system/cross-org
//     isolation, and write refusals across all 5 tables.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { hardeningViolations, migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meetings.brief_daily' };
const AGENT_SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

interface RunHandle {
  agentId: string;
  runId: string;
}

suite('Meetings 5-table member_vy read opt-in (#5073 Step 2a)', () => {
  const dbName = `ludy_test_meetings_vy_read_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let orgA = '';
  let orgB = '';
  let branchId = '';

  const users = {
    owner: '',
    memberVy: '',
    scopedVy: '',
    viewerVy: '',
    other: '',
    foreign: '',
  };

  const runs: Record<'memberVy' | 'scopedVy' | 'viewerVy' | 'orgChart', RunHandle> = {
    memberVy: { agentId: '', runId: '' },
    scopedVy: { agentId: '', runId: '' },
    viewerVy: { agentId: '', runId: '' },
    orgChart: { agentId: '', runId: '' },
  };

  const ids = {
    mOrg: randomUUID(),
    mAtt: randomUUID(),
    mSharedMine: randomUUID(),
    mRecMine: randomUUID(),
    mRecScoped: randomUUID(),
    mForeignOrg: randomUUID(),
    resOrgPub: randomUUID(),
    resOrgDraft: randomUUID(),
    resAttPub: randomUUID(),
    resSharedPub: randomUUID(),
    resSharedDraft: randomUUID(),
    resRecPub: randomUUID(),
    resRecDraft: randomUUID(),
    resScopedPub: randomUUID(),
    resScopedDraft: randomUUID(),
    resForeignPub: randomUUID(),
    itemOrgPub: randomUUID(),
    itemOrgDraft: randomUUID(),
    itemAttPub: randomUUID(),
    itemSharedPub: randomUUID(),
    itemSharedDraft: randomUUID(),
    itemRecPub: randomUUID(),
    itemRecDraft: randomUUID(),
    itemScopedPub: randomUUID(),
    itemScopedDraft: randomUUID(),
    itemForeignPub: randomUUID(),
    linkOrg: randomUUID(),
    linkAtt: randomUUID(),
    linkShared: randomUUID(),
    linkRec: randomUUID(),
    linkScoped: randomUUID(),
    linkForeign: randomUUID(),
    calAgendaVy: randomUUID(),
    calAgendaScoped: randomUUID(),
    calAgendaViewer: randomUUID(),
    calAgendaOwner: randomUUID(),
    calAgendaForeign: randomUUID(),
  };

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

  async function inRoleContext<T>(
    url: string,
    enter: (c: pg.Client) => Promise<unknown>,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  const inWorkerContext = <T>(enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>) =>
    inRoleContext(workerUrl, enter, fn);

  const enterUser = (userId: string, org = orgA) =>
    (c: pg.Client) =>
      c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [org, contextToken(userId, org)]);

  const enterMemberVy = (run: RunHandle, org = orgA) =>
    (c: pg.Client) =>
      c.query('SELECT ludy_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [
        org,
        run.agentId,
        run.runId,
      ]);

  const enterOrgChart = (c: pg.Client) =>
    c.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
      orgA,
      runs.orgChart.agentId,
      runs.orgChart.runId,
    ]);

  const enterSystem = (c: pg.Client) =>
    c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgA]);

  async function seenIds(
    enter: (c: pg.Client) => Promise<unknown>,
    table: string,
    targetIds: readonly string[],
  ): Promise<string[]> {
    return inWorkerContext(enter, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM ${table} WHERE id = ANY($1::uuid[])`,
        [[...targetIds]],
      );
      return rows.map((r) => r.id).sort();
    });
  }

  async function attemptInSavepoint(
    c: pg.Client,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ ok: true; rowCount: number } | { ok: false; code: string; message: string }> {
    await c.query('SAVEPOINT sp_write_probe');
    try {
      const res = await c.query(sql, params);
      await c.query('RELEASE SAVEPOINT sp_write_probe');
      return { ok: true, rowCount: res.rowCount ?? 0 };
    } catch (error: unknown) {
      await c.query('ROLLBACK TO SAVEPOINT sp_write_probe');
      const e = error as { code?: string; message?: string };
      return { ok: false, code: e.code ?? '', message: e.message ?? '' };
    }
  }

  async function seedMeeting(
    c: pg.Client,
    orgId: string,
    meetingId: string,
    recorderId: string,
    visibility: 'org' | 'attendees',
    title: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.meeting (
         org_id, id, recorder_user_id, visibility, title, language, status,
         started_at, ended_at, length_seconds, consent_method,
         consent_confirmed_by, consent_confirmed_at, consent_notice_version,
         audio_retention_date, text_retention_date
       )
       VALUES (
         $1, $2, $3, $4, $5, 'vi', 'ready',
         '2026-11-26T08:00:00Z', '2026-11-26T08:30:00Z', 1800, 'told_at_start',
         $3, '2026-11-26T08:00:00Z', '1.0',
         '2027-01-01', '2028-01-01'
       )`,
      [orgId, meetingId, recorderId, visibility, title],
    );
  }

  async function seedResult(
    c: pg.Client,
    orgId: string,
    id: string,
    meetingId: string,
    stage: 'draft' | 'published',
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.meeting_result (
         org_id, id, meeting_id, summary, decisions, feature, stage, tainted
       )
       VALUES ($1, $2, $3, $4, '["Quyet dinh"]'::jsonb, 'meetings.summary', $5, $6)`,
      [orgId, id, meetingId, `Summary ${stage}`, stage, stage === 'draft'],
    );
  }

  async function seedActionItem(
    c: pg.Client,
    orgId: string,
    id: string,
    meetingId: string,
    stage: 'draft' | 'published',
    whoParsed: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.action_item (
         org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted,
         when_parsed, transcript_seconds, stage, status, flags, tainted
       )
       VALUES (
         $1, $2, $3, $4, 'An', $5, 'Thu sau',
         '2026-11-27', 60, $6, 'suggested', '[]'::jsonb, $7
       )`,
      [orgId, id, meetingId, `Action ${stage}`, whoParsed, stage, stage === 'draft'],
    );
  }

  async function seedLink(
    c: pg.Client,
    orgId: string,
    id: string,
    meetingId: string,
    createdBy: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, id, meetingId, randomUUID(), createdBy],
    );
  }

  async function seedAgenda(
    c: pg.Client,
    orgId: string,
    agendaId: string,
    userId: string,
    title: string,
  ): Promise<void> {
    const connId = randomUUID();
    await c.query(
      `INSERT INTO ludy_kernel.calendar_connection (
         org_id, id, user_id, provider, external_account, display_name
       )
       VALUES ($1, $2, $3, 'google', $4, 'Calendar')`,
      [orgId, connId, userId, `${userId}-${agendaId}@calendar.test`],
    );
    await c.query(
      `INSERT INTO ludy_meetings.calendar_agenda (
         org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         '2026-11-27T09:00:00Z', '2026-11-27T09:30:00Z', 'Asia/Ho_Chi_Minh'
       )`,
      [orgId, agendaId, connId, userId, `ext-${agendaId}`, title],
    );
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
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);

    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);
    // Register finance because kernel.agent.template.install for finance.chief_accountant requires the finance module on.
    const registry = {
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries],
    };
    app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'meetings-vy-read',
        subject: key,
        email: `${key}@meetings-vy.test`,
        name: null,
      });
    }

    orgA = (await createOrg(app, asUser(users.owner), 'Meetings Vy Org A')).orgId;
    orgB = (await createOrg(app, asUser(users.foreign), 'Meetings Vy Org B')).orgId;

    await admin(async (c) => {
      const branchRow = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by)
         VALUES ($1, 'Branch A', 'branch', $2) RETURNING id`,
        [orgA, users.owner],
      );
      branchId = branchRow.rows[0]?.id ?? '';
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')`,
        [orgA, users.memberVy, users.scopedVy, users.viewerVy, users.other],
      );
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgA, users.scopedVy, branchId, users.owner],
      );
    });

    await app.execute(
      'kernel.member.permission.set',
      { userId: users.viewerVy, permission: 'vy.use', allowed: true },
      { actor: asUser(users.owner), orgId: orgA },
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
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId: orgA },
    );
    await app.execute(
      'kernel.task.create',
      { title: 'Org chart probe', assigneePositionId: installed.positionId },
      { actor: asUser(users.owner), orgId: orgA },
    );
    const orgChartStart = await worker.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: AGENT_SYSTEM, orgId: orgA },
    );
    runs.orgChart = { agentId: installed.agentId, runId: orgChartStart.runId ?? '' };

    await admin(async (c) => {
      await seedMeeting(c, orgA, ids.mOrg, users.owner, 'org', 'Org visible meeting');
      await seedMeeting(c, orgA, ids.mAtt, users.owner, 'attendees', 'Hidden attendees meeting');
      await seedMeeting(c, orgA, ids.mSharedMine, users.owner, 'attendees', 'Shared attendees meeting');
      await seedMeeting(c, orgA, ids.mRecMine, users.memberVy, 'attendees', 'Member own recorded meeting');
      await seedMeeting(c, orgA, ids.mRecScoped, users.scopedVy, 'attendees', 'Scoped own recorded meeting');
      await seedMeeting(c, orgB, ids.mForeignOrg, users.foreign, 'org', 'Foreign org visible meeting');

      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id)
         VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
        [orgA, randomUUID(), ids.mSharedMine, users.memberVy, randomUUID(), ids.mAtt, users.other],
      );

      await c.query(
        `INSERT INTO ludy_meetings.transcript_segment (
           org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage
         )
         VALUES ($1, $2, $3, 0, 10, 'Speaker 1', 'Confidential transcript', 'published')`,
        [orgA, randomUUID(), ids.mOrg],
      );
      await c.query(
        `INSERT INTO ludy_meetings.meeting_note (org_id, id, meeting_id, body)
         VALUES ($1, $2, $3, 'Recorder private rough note')`,
        [orgA, randomUUID(), ids.mRecMine],
      );

      await seedResult(c, orgA, ids.resOrgPub, ids.mOrg, 'published');
      await seedResult(c, orgA, ids.resOrgDraft, ids.mOrg, 'draft');
      await seedResult(c, orgA, ids.resAttPub, ids.mAtt, 'published');
      await seedResult(c, orgA, ids.resSharedPub, ids.mSharedMine, 'published');
      await seedResult(c, orgA, ids.resSharedDraft, ids.mSharedMine, 'draft');
      await seedResult(c, orgA, ids.resRecPub, ids.mRecMine, 'published');
      await seedResult(c, orgA, ids.resRecDraft, ids.mRecMine, 'draft');
      await seedResult(c, orgA, ids.resScopedPub, ids.mRecScoped, 'published');
      await seedResult(c, orgA, ids.resScopedDraft, ids.mRecScoped, 'draft');
      await seedResult(c, orgB, ids.resForeignPub, ids.mForeignOrg, 'published');

      await seedActionItem(c, orgA, ids.itemOrgPub, ids.mOrg, 'published', users.owner);
      await seedActionItem(c, orgA, ids.itemOrgDraft, ids.mOrg, 'draft', users.owner);
      await seedActionItem(c, orgA, ids.itemAttPub, ids.mAtt, 'published', users.owner);
      await seedActionItem(c, orgA, ids.itemSharedPub, ids.mSharedMine, 'published', users.owner);
      await seedActionItem(c, orgA, ids.itemSharedDraft, ids.mSharedMine, 'draft', users.owner);
      await seedActionItem(c, orgA, ids.itemRecPub, ids.mRecMine, 'published', users.memberVy);
      await seedActionItem(c, orgA, ids.itemRecDraft, ids.mRecMine, 'draft', users.memberVy);
      await seedActionItem(c, orgA, ids.itemScopedPub, ids.mRecScoped, 'published', users.scopedVy);
      await seedActionItem(c, orgA, ids.itemScopedDraft, ids.mRecScoped, 'draft', users.scopedVy);
      await seedActionItem(c, orgB, ids.itemForeignPub, ids.mForeignOrg, 'published', users.foreign);

      await seedLink(c, orgA, ids.linkOrg, ids.mOrg, users.owner);
      await seedLink(c, orgA, ids.linkAtt, ids.mAtt, users.owner);
      await seedLink(c, orgA, ids.linkShared, ids.mSharedMine, users.owner);
      await seedLink(c, orgA, ids.linkRec, ids.mRecMine, users.memberVy);
      await seedLink(c, orgA, ids.linkScoped, ids.mRecScoped, users.scopedVy);
      await seedLink(c, orgB, ids.linkForeign, ids.mForeignOrg, users.foreign);

      await seedAgenda(c, orgA, ids.calAgendaVy, users.memberVy, 'Vy calendar event');
      await seedAgenda(c, orgA, ids.calAgendaScoped, users.scopedVy, 'Scoped calendar event');
      await seedAgenda(c, orgA, ids.calAgendaViewer, users.viewerVy, 'Viewer calendar event');
      await seedAgenda(c, orgA, ids.calAgendaOwner, users.owner, 'Owner calendar event');
      await seedAgenda(c, orgB, ids.calAgendaForeign, users.foreign, 'Foreign calendar event');
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

  it('registers the 5 Meetings read tables, passes hardeningViolations, and locks helper execution', async () => {
    await admin(async (c) => {
      expect(await hardeningViolations(c)).toEqual([]);

      const { rows: catalogRows } = await c.query<{ table_name: string; mode: string }>(
        `SELECT table_name, mode FROM ludy_kernel.member_vy_table
         WHERE table_name LIKE 'ludy_meetings.%'
         ORDER BY 1`,
      );
      expect(catalogRows).toEqual([
        { table_name: 'ludy_meetings.action_item', mode: 'read' },
        { table_name: 'ludy_meetings.calendar_agenda', mode: 'read' },
        { table_name: 'ludy_meetings.meeting', mode: 'read' },
        { table_name: 'ludy_meetings.meeting_link', mode: 'read' },
        { table_name: 'ludy_meetings.meeting_result', mode: 'read' },
      ]);

      const { rows: fnRows } = await c.query<{
        secdef: boolean;
        proconfig: string[] | null;
        rettype: string;
        publicExec: boolean;
        tenantExec: boolean;
        proberExec: boolean;
      }>(
        `SELECT p.prosecdef AS secdef,
                p.proconfig,
                pg_catalog.pg_get_function_result(p.oid) AS rettype,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExec",
                pg_catalog.has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS "tenantExec",
                pg_catalog.has_function_privilege('ludy_prober', p.oid, 'EXECUTE') AS "proberExec"
         FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('ludy_meetings.is_agent_meeting_reader(uuid,uuid)')`,
      );
      expect(fnRows).toEqual([
        {
          secdef: true,
          proconfig: ['search_path=pg_catalog, pg_temp'],
          rettype: 'boolean',
          publicExec: false,
          tenantExec: true,
          proberExec: false,
        },
      ]);

      const { rows: userHelpers } = await c.query<{ name: string; body: string }>(
        `SELECT p.oid::regprocedure::text AS name, pg_catalog.pg_get_functiondef(p.oid) AS body
         FROM pg_catalog.pg_proc p
         WHERE p.oid IN (
           pg_catalog.to_regprocedure('ludy_meetings.is_meeting_reader(uuid,uuid,uuid)'),
           pg_catalog.to_regprocedure('ludy_meetings.is_meeting_recorder(uuid,uuid)')
         )
         ORDER BY 1`,
      );
      expect(userHelpers).toHaveLength(2);
      for (const helper of userHelpers) {
        expect(helper.body, helper.name).not.toMatch(/ctx_acting_user_id|ctx_verified|'(?:crove|ludy)\.ctx/i);
      }
    });
  });

  it('admits member_vy reads across all 5 tables while excluding drafts, mAtt rows, and unopted sensitive tables', async () => {
    const meetingPool = [ids.mOrg, ids.mAtt, ids.mSharedMine, ids.mRecMine, ids.mRecScoped, ids.mForeignOrg];
    const resultPool = [
      ids.resOrgPub,
      ids.resOrgDraft,
      ids.resAttPub,
      ids.resSharedPub,
      ids.resSharedDraft,
      ids.resRecPub,
      ids.resRecDraft,
      ids.resScopedPub,
      ids.resScopedDraft,
      ids.resForeignPub,
    ];
    const itemPool = [
      ids.itemOrgPub,
      ids.itemOrgDraft,
      ids.itemAttPub,
      ids.itemSharedPub,
      ids.itemSharedDraft,
      ids.itemRecPub,
      ids.itemRecDraft,
      ids.itemScopedPub,
      ids.itemScopedDraft,
      ids.itemForeignPub,
    ];
    const linkPool = [ids.linkOrg, ids.linkAtt, ids.linkShared, ids.linkRec, ids.linkScoped, ids.linkForeign];
    const agendaPool = [
      ids.calAgendaVy,
      ids.calAgendaScoped,
      ids.calAgendaViewer,
      ids.calAgendaOwner,
      ids.calAgendaForeign,
    ];

    const enter = enterMemberVy(runs.memberVy);

    expect(await seenIds(enter, 'ludy_meetings.meeting', meetingPool)).toEqual(
      [ids.mOrg, ids.mSharedMine, ids.mRecMine].sort(),
    );
    expect(await seenIds(enter, 'ludy_meetings.meeting_result', resultPool)).toEqual(
      [ids.resOrgPub, ids.resSharedPub, ids.resRecPub].sort(),
    );
    expect(await seenIds(enter, 'ludy_meetings.action_item', itemPool)).toEqual(
      [ids.itemOrgPub, ids.itemSharedPub, ids.itemRecPub].sort(),
    );
    expect(await seenIds(enter, 'ludy_meetings.meeting_link', linkPool)).toEqual(
      [ids.linkOrg, ids.linkShared, ids.linkRec].sort(),
    );
    expect(await seenIds(enter, 'ludy_meetings.calendar_agenda', agendaPool)).toEqual([ids.calAgendaVy]);

    for (const closedTable of [
      'ludy_meetings.transcript_segment',
      'ludy_meetings.meeting_note',
      'ludy_meetings.meeting_reader',
      'ludy_meetings.audio_segment',
      'ludy_meetings.meeting_video',
    ]) {
      const count = await inWorkerContext(enter, async (c) => {
        const res = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${closedTable}`);
        return res.rows[0]?.n ?? -1;
      });
      expect(count, `${closedTable} must remain closed to member_vy`).toBe(0);
    }
  });

  it('enforces legal-entity scope for scopedVy and denies viewerVy (with vy.use) across all 5 tables', async () => {
    const meetingPool = [ids.mOrg, ids.mAtt, ids.mSharedMine, ids.mRecMine, ids.mRecScoped, ids.mForeignOrg];
    const resultPool = [
      ids.resOrgPub,
      ids.resOrgDraft,
      ids.resAttPub,
      ids.resSharedPub,
      ids.resSharedDraft,
      ids.resRecPub,
      ids.resRecDraft,
      ids.resScopedPub,
      ids.resScopedDraft,
      ids.resForeignPub,
    ];
    const itemPool = [
      ids.itemOrgPub,
      ids.itemOrgDraft,
      ids.itemAttPub,
      ids.itemSharedPub,
      ids.itemSharedDraft,
      ids.itemRecPub,
      ids.itemRecDraft,
      ids.itemScopedPub,
      ids.itemScopedDraft,
      ids.itemForeignPub,
    ];
    const linkPool = [ids.linkOrg, ids.linkAtt, ids.linkShared, ids.linkRec, ids.linkScoped, ids.linkForeign];
    const agendaPool = [
      ids.calAgendaVy,
      ids.calAgendaScoped,
      ids.calAgendaViewer,
      ids.calAgendaOwner,
      ids.calAgendaForeign,
    ];

    const scopedEnter = enterMemberVy(runs.scopedVy);
    expect(await seenIds(scopedEnter, 'ludy_meetings.meeting', meetingPool)).toEqual([ids.mRecScoped]);
    expect(await seenIds(scopedEnter, 'ludy_meetings.meeting_result', resultPool)).toEqual([ids.resScopedPub]);
    expect(await seenIds(scopedEnter, 'ludy_meetings.action_item', itemPool)).toEqual([ids.itemScopedPub]);
    expect(await seenIds(scopedEnter, 'ludy_meetings.meeting_link', linkPool)).toEqual([ids.linkScoped]);
    expect(await seenIds(scopedEnter, 'ludy_meetings.calendar_agenda', agendaPool)).toEqual([ids.calAgendaScoped]);

    const viewerEnter = enterMemberVy(runs.viewerVy);
    const viewerActing = await inWorkerContext(viewerEnter, async (c) => {
      const res = await c.query<{ u: string | null }>('SELECT ludy_kernel.ctx_acting_user_id()::text AS u');
      return res.rows[0]?.u ?? null;
    });
    expect(viewerActing).toBe(users.viewerVy);

    expect(await seenIds(viewerEnter, 'ludy_meetings.meeting', meetingPool)).toEqual([]);
    expect(await seenIds(viewerEnter, 'ludy_meetings.meeting_result', resultPool)).toEqual([]);
    expect(await seenIds(viewerEnter, 'ludy_meetings.action_item', itemPool)).toEqual([]);
    expect(await seenIds(viewerEnter, 'ludy_meetings.meeting_link', linkPool)).toEqual([]);
    expect(await seenIds(viewerEnter, 'ludy_meetings.calendar_agenda', agendaPool)).toEqual([]);
  });

  it('denies org_chart agents, system context, cross-org queries, and inactive/demoted state', async () => {
    const meetingPool = [ids.mOrg, ids.mAtt, ids.mSharedMine, ids.mRecMine, ids.mRecScoped, ids.mForeignOrg];
    const resultPool = [ids.resOrgPub, ids.resSharedPub, ids.resRecPub, ids.resScopedPub, ids.resForeignPub];
    const itemPool = [ids.itemOrgPub, ids.itemSharedPub, ids.itemRecPub, ids.itemScopedPub, ids.itemForeignPub];
    const linkPool = [ids.linkOrg, ids.linkShared, ids.linkRec, ids.linkScoped, ids.linkForeign];
    const agendaPool = [ids.calAgendaVy, ids.calAgendaOwner, ids.calAgendaForeign];

    for (const [label, enter] of [
      ['org_chart agent', enterOrgChart],
      ['system context', enterSystem],
    ] as const) {
      expect(await seenIds(enter, 'ludy_meetings.meeting', meetingPool), `${label} meeting`).toEqual([]);
      expect(await seenIds(enter, 'ludy_meetings.meeting_result', resultPool), `${label} meeting_result`).toEqual([]);
      expect(await seenIds(enter, 'ludy_meetings.action_item', itemPool), `${label} action_item`).toEqual([]);
      expect(await seenIds(enter, 'ludy_meetings.meeting_link', linkPool), `${label} meeting_link`).toEqual([]);
      expect(await seenIds(enter, 'ludy_meetings.calendar_agenda', agendaPool), `${label} calendar_agenda`).toEqual([]);

      const helperAns = await inWorkerContext(enter, async (c) => {
        const res = await c.query<{ ok: boolean }>('SELECT ludy_meetings.is_agent_meeting_reader($1::uuid, $2::uuid) AS ok', [
          orgA,
          ids.mOrg,
        ]);
        return res.rows[0]?.ok;
      });
      expect(helperAns, `${label} helper`).toBe(false);
    }

    const userAns = await inRoleContext(appUrl, enterUser(users.owner), async (c) => {
      const res = await c.query<{ ok: boolean }>('SELECT ludy_meetings.is_agent_meeting_reader($1::uuid, $2::uuid) AS ok', [
        orgA,
        ids.mOrg,
      ]);
      const seen = await c.query<{ id: string }>(
        'SELECT id::text AS id FROM ludy_meetings.meeting WHERE id = ANY($1::uuid[])',
        [[ids.mOrg, ids.mAtt, ids.mSharedMine, ids.mRecMine]],
      );
      return { ok: res.rows[0]?.ok, meetings: seen.rows.map((r) => r.id).sort() };
    });
    expect(userAns).toEqual({
      ok: false,
      meetings: [ids.mOrg, ids.mAtt, ids.mSharedMine].sort(),
    });

    const memberEnter = enterMemberVy(runs.memberVy);
    const crossOrgAns = await inWorkerContext(memberEnter, async (c) => {
      const res = await c.query<{ ok: boolean }>('SELECT ludy_meetings.is_agent_meeting_reader($1::uuid, $2::uuid) AS ok', [
        orgB,
        ids.mForeignOrg,
      ]);
      return res.rows[0]?.ok;
    });
    expect(crossOrgAns).toBe(false);

    for (const table of [
      'ludy_meetings.meeting',
      'ludy_meetings.meeting_result',
      'ludy_meetings.action_item',
      'ludy_meetings.meeting_link',
      'ludy_meetings.calendar_agenda',
    ]) {
      const crossRows = await inWorkerContext(memberEnter, async (c) => {
        const res = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgB]);
        return res.rows[0]?.n ?? -1;
      });
      expect(crossRows, `${table} cross-org`).toBe(0);
    }

    // Demoting memberVy to viewer or closing the run denies is_agent_meeting_reader and calendar_agenda_read.
    await admin((c) =>
      c.query(`UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [
        orgA,
        users.memberVy,
      ]),
    );
    try {
      expect(await seenIds(memberEnter, 'ludy_meetings.meeting', meetingPool)).toEqual([]);
      expect(await seenIds(memberEnter, 'ludy_meetings.calendar_agenda', agendaPool)).toEqual([]);
    } finally {
      await admin((c) =>
        c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [
          orgA,
          users.memberVy,
        ]),
      );
    }

    await admin((c) =>
      c.query(`UPDATE ludy_kernel.ai_run SET status = 'cancelled' WHERE org_id = $1 AND id = $2`, [
        orgA,
        runs.memberVy.runId,
      ]),
    );
    try {
      await inRoleContext(
        adminUrl,
        (c) =>
          c.query(
            `SELECT ludy_kernel.ctx_write(jsonb_build_object(
               'v', 1, 'org', $1::uuid, 'actor', 'agent', 'user', NULL, 'role', 'member',
               'agent', $2::uuid, 'run', $3::uuid, 'position', NULL, 'module', 'meetings',
               'max_risk', 'R1', 'tainted', true, 'le_scope', '["*"]'::jsonb, 'flags', '[]'::jsonb,
               'kind', 'member_vy', 'member', $4::uuid
             ))`,
            [orgA, runs.memberVy.agentId, runs.memberVy.runId, users.memberVy],
          ),
        async (c) => {
          await c.query('SET LOCAL ROLE ludy_tenant');
          const res = await c.query<{ ok: boolean }>('SELECT ludy_meetings.is_agent_meeting_reader($1::uuid, $2::uuid) AS ok', [
            orgA,
            ids.mOrg,
          ]);
          expect(res.rows[0]?.ok).toBe(false);
        },
      );
    } finally {
      await admin((c) =>
        c.query(`UPDATE ludy_kernel.ai_run SET status = 'running' WHERE org_id = $1 AND id = $2`, [
          orgA,
          runs.memberVy.runId,
        ]),
      );
    }
  });

  it('refuses INSERT, UPDATE, and DELETE across all 5 opt-in tables in member_vy context', async () => {
    await inWorkerContext(enterMemberVy(runs.memberVy), async (c) => {
      const insMeeting = await attemptInSavepoint(
        c,
        `INSERT INTO ludy_meetings.meeting (
           org_id, id, recorder_user_id, visibility, title, language, status,
           consent_method, consent_confirmed_by, consent_notice_version,
           audio_retention_date, text_retention_date
         )
         VALUES ($1, $2, $3, 'attendees', 'Spoof', 'vi', 'ready', 'told_at_start', $3, '1.0', '2027-01-01', '2028-01-01')`,
        [orgA, randomUUID(), users.memberVy],
      );
      expect(insMeeting).toMatchObject({ ok: false, code: '42501', message: 'AGENT_FORBIDDEN' });

      const insResult = await attemptInSavepoint(
        c,
        `INSERT INTO ludy_meetings.meeting_result (
           org_id, id, meeting_id, summary, decisions, feature, stage, tainted
         )
         VALUES ($1, $2, $3, 'Spoof', '[]'::jsonb, 'meetings.summary', 'draft', true)`,
        [orgA, randomUUID(), ids.mRecMine],
      );
      expect(insResult).toMatchObject({ ok: false, code: '42501', message: 'AGENT_FORBIDDEN' });

      const insItem = await attemptInSavepoint(
        c,
        `INSERT INTO ludy_meetings.action_item (
           org_id, id, meeting_id, title, stage, status, flags, tainted
         )
         VALUES ($1, $2, $3, 'Spoof', 'draft', 'suggested', '[]'::jsonb, true)`,
        [orgA, randomUUID(), ids.mRecMine],
      );
      expect(insItem).toMatchObject({ ok: false, code: '42501', message: 'AGENT_FORBIDDEN' });

      const insLink = await attemptInSavepoint(
        c,
        `INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgA, randomUUID(), ids.mRecMine, randomUUID(), users.memberVy],
      );
      expect(insLink).toMatchObject({ ok: false, code: '42501', message: 'AGENT_FORBIDDEN' });

      const insAgenda = await attemptInSavepoint(
        c,
        `INSERT INTO ludy_meetings.calendar_agenda (
           org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone
         )
         VALUES ($1, $2, $3, $4, 'spoof', 'Spoof', '2026-11-27T10:00:00Z', '2026-11-27T10:30:00Z', 'Asia/Ho_Chi_Minh')`,
        [orgA, randomUUID(), randomUUID(), users.memberVy],
      );
      expect(insAgenda).toMatchObject({ ok: false, code: '42501' });

      const updMeeting = await attemptInSavepoint(
        c,
        `UPDATE ludy_meetings.meeting SET title = 'Mutated' WHERE id = $1`,
        [ids.mRecMine],
      );
      if (updMeeting.ok) expect(updMeeting.rowCount).toBe(0);
      else expect(updMeeting.code).toBe('42501');

      const updResult = await attemptInSavepoint(
        c,
        `UPDATE ludy_meetings.meeting_result SET summary = 'Mutated' WHERE id = $1`,
        [ids.resRecPub],
      );
      if (updResult.ok) expect(updResult.rowCount).toBe(0);
      else expect(updResult.code).toBe('42501');

      const updItem = await attemptInSavepoint(
        c,
        `UPDATE ludy_meetings.action_item SET title = 'Mutated' WHERE id = $1`,
        [ids.itemRecPub],
      );
      if (updItem.ok) expect(updItem.rowCount).toBe(0);
      else expect(updItem.code).toBe('42501');

      const updLink = await attemptInSavepoint(
        c,
        `UPDATE ludy_meetings.meeting_link SET deal_id = $1 WHERE id = $2`,
        [randomUUID(), ids.linkRec],
      );
      expect(updLink).toMatchObject({ ok: false, code: '42501' });

      const updAgenda = await attemptInSavepoint(
        c,
        `UPDATE ludy_meetings.calendar_agenda SET meeting_id = $1 WHERE id = $2`,
        [ids.mRecMine, ids.calAgendaVy],
      );
      if (updAgenda.ok) expect(updAgenda.rowCount).toBe(0);
      else expect(updAgenda.code).toBe('42501');

      for (const [table, targetId] of [
        ['ludy_meetings.meeting', ids.mRecMine],
        ['ludy_meetings.meeting_result', ids.resRecPub],
        ['ludy_meetings.action_item', ids.itemRecPub],
        ['ludy_meetings.meeting_link', ids.linkRec],
        ['ludy_meetings.calendar_agenda', ids.calAgendaVy],
      ] as const) {
        const del = await attemptInSavepoint(c, `DELETE FROM ${table} WHERE id = $1`, [targetId]);
        if (del.ok) expect(del.rowCount, `DELETE ${table}`).toBe(0);
        else expect(del.code, `DELETE ${table}`).toBe('42501');
      }
    });

    await admin(async (c) => {
      const m = await c.query<{ title: string }>('SELECT title FROM ludy_meetings.meeting WHERE id = $1', [ids.mRecMine]);
      expect(m.rows).toEqual([{ title: 'Member own recorded meeting' }]);
      const r = await c.query<{ summary: string }>('SELECT summary FROM ludy_meetings.meeting_result WHERE id = $1', [
        ids.resRecPub,
      ]);
      expect(r.rows).toEqual([{ summary: 'Summary published' }]);
      const i = await c.query<{ title: string }>('SELECT title FROM ludy_meetings.action_item WHERE id = $1', [
        ids.itemRecPub,
      ]);
      expect(i.rows).toEqual([{ title: 'Action published' }]);
      const l = await c.query<{ id: string }>('SELECT id FROM ludy_meetings.meeting_link WHERE id = $1', [ids.linkRec]);
      expect(l.rows).toHaveLength(1);
      const a = await c.query<{ meeting_id: string | null }>(
        'SELECT meeting_id FROM ludy_meetings.calendar_agenda WHERE id = $1',
        [ids.calAgendaVy],
      );
      expect(a.rows).toEqual([{ meeting_id: null }]);
    });
  });
});
