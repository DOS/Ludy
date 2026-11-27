// SPDX-License-Identifier: AGPL-3.0-only
// Full morning daily briefing (#5080 Slice A2 + C2 + O5) on a real PostgreSQL 17 database:
// - Opt-in full mode queues metadata-only payload with source_id = member user id (zero titles/names/deals/Vy lines stored).
// - Render-time query (meetings.morning.mail_content) runs strictly inside read-only member_briefing runtime, deduplicates multi-connection
//   calendar events keeping linked rows, reads org reader display names (never emails), previous published decisions, live open/overdue/mine
//   action item flags, open CRM deals (via party_id or deal_id, graceful when CRM is absent), and gated 36h Vy prep lines (max 5 meetings).
// - Revoked access, downgrade back to count, removed membership, and disabled mail fail closed with zero preview or PII leak.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  MORNING_BRIEFING_CAPS,
  MORNING_MAIL_CONTENT_COMMAND,
  type Deal,
  type MorningBriefingContent,
  type MorningState,
  type PipelineStage,
} from '@ludy/kernel-contract';
import { createLogProvider, type MailProvider, type OutboundMail, type SendResult } from '@ludy/mail';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { runMailJob, type MailQueueDeps } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { runMeetingsMorningSweep } from '../src/meetings-morning.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ZONE = 'Asia/Ho_Chi_Minh';
const SYSTEM = { type: 'system' as const, component: 'test.morning.briefing' };

suite('morning full daily briefing end-to-end (#5080)', () => {
  const dbName = `ludy_test_morning_briefing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appConnUrl = '';
  let workerConnUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let orgSlug = '';
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  let noCrmWorker: Runtime;
  const users: Record<string, string> = {};

  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({
    type: 'user' as const,
    userId: users[who] as string,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const exec = <O = unknown>(who: string, name: string, input: unknown) =>
    runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const setMorning = (who: string, input: Record<string, unknown>) =>
    exec<MorningState>(who, 'meetings.morning.set', input);
  const getMorning = (who: string) =>
    runtime.query<MorningState>('meetings.morning.get', {}, { actor: asUser(who), orgId });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin((c) => c.query<R>(text, params));

  const localNow = async (zone: string) =>
    (
      await sqlAdmin<{ day: string; minute: number; start_of_day: Date }>(
        `SELECT (now() AT TIME ZONE $1)::date::text AS day,
                (date_part('hour', now() AT TIME ZONE $1) * 60 + date_part('minute', now() AT TIME ZONE $1))::int AS minute,
                ((now() AT TIME ZONE $1)::date::timestamp AT TIME ZONE $1) AS start_of_day`,
        [zone],
      )
    ).rows[0]!;

  async function connectCalendar(who: string, suffix = 'main', status = 'active'): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events, status)
       VALUES ($1, $2, $3, 'google', $4, $5, '{}', true, $6)`,
      [orgId, id, users[who], `${who}-${suffix}@calendar.test`, `${who}-${suffix}`, status],
    );
    return id;
  }

  async function insertAgenda(opts: {
    connectionId: string;
    who: string;
    externalId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    inviteeCount?: number;
    meetingId?: string | null;
    seriesId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.calendar_agenda
         (org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, invitee_count, meeting_id, series_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        orgId,
        id,
        opts.connectionId,
        users[opts.who],
        opts.externalId,
        opts.title,
        opts.startsAt,
        opts.endsAt,
        ZONE,
        opts.inviteeCount ?? 0,
        opts.meetingId ?? null,
        opts.seriesId ?? null,
      ],
    );
    return id;
  }

  async function createMeeting(opts: {
    recorder: string;
    title: string;
    startedAt: Date;
    readers: string[];
    seriesId?: string | null;
    retentionOffsetDays?: number;
  }): Promise<string> {
    const id = randomUUID();
    const endedAt = new Date(opts.startedAt.getTime() + 30 * 60_000);
    const retention = opts.retentionOffsetDays ?? 365;
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting
         (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status,
          consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $3, 'vi', $4, $5, 1800, $6, 'attendees', 'ready',
               'told_at_start', $6, now(), '1.0', current_date + 20, current_date + $7::int, $8)`,
      [orgId, id, opts.title, opts.startedAt, endedAt, users[opts.recorder], retention, opts.seriesId ?? null],
    );
    for (const reader of opts.readers) {
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [orgId, randomUUID(), id, users[reader]],
      );
    }
    return id;
  }

  const addResult = (meetingId: string, decisions: string[], stage: 'draft' | 'published' = 'published') =>
    sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
       VALUES ($1, $2, 'Tóm tắt cuộc họp', $3::jsonb, 'manual', $4)`,
      [orgId, meetingId, JSON.stringify(decisions), stage],
    );

  async function addActionItem(opts: {
    meetingId: string;
    title: string;
    stage?: 'draft' | 'published';
    whoParsed?: string | null;
    whenParsed?: string | null;
    taskStatus?: string;
    taskDue?: Date | null;
    assigneePositionId?: string | null;
  }): Promise<string> {
    let taskId: string | null = null;
    if (opts.taskStatus !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(
        `INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status, due, assignee_position_id)
         VALUES ($1, $2, $3, 'human', 'system', $4, $5, $6)`,
        [orgId, taskId, opts.title, opts.taskStatus, opts.taskDue ?? null, opts.assigneePositionId ?? null],
      );
    }
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.action_item
         (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Người phụ trách', $5, 'trong tuần', $6, $7, $8, $9, false, 15)`,
      [
        orgId,
        id,
        opts.meetingId,
        opts.title,
        opts.whoParsed ? users[opts.whoParsed] : null,
        opts.whenParsed ?? null,
        opts.stage ?? 'published',
        taskId === null ? 'suggested' : 'accepted',
        taskId,
      ],
    );
    return id;
  }

  async function upsertVyLines(who: string, meetingId: string, lines: string[], expiresOffsetHours = 12): Promise<void> {
    const client = new pg.Client({ connectionString: workerConnUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      await client.query(
        `SELECT ludy_meetings.morning_brief_lines_upsert($1::uuid, $2::uuid, $3::uuid, $4::jsonb, now() + make_interval(hours => $5::int))`,
        [orgId, users[who], meetingId, JSON.stringify(lines), expiresOffsetHours],
      );
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  }

  const createParty = (name: string) =>
    sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id`,
      [orgId, name],
    ).then((r) => r.rows[0]!.id);

  async function createDeal(partyId: string, title: string, amount: string, won = false): Promise<Deal> {
    const created = await exec<Deal>('rec', 'crm.deal.create', {
      partyId,
      title,
      amount,
      expectedClose: '2026-12-31',
    });
    if (!won) return created;
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, { actor: asUser('rec'), orgId });
    const wonStage = stages.find((s) => s.kind === 'won') as PipelineStage;
    return exec<Deal>('rec', 'crm.deal.move', { dealId: created.id, version: created.version, stageId: wonStage.id });
  }

  const mailRowsFor = (who: string) =>
    sqlAdmin<{
      id: string;
      status: string;
      subject: string | null;
      source: string;
      source_id: string | null;
      payload: Record<string, unknown>;
      error_code: string | null;
    }>(
      `SELECT id, status, subject, source, source_id, payload, error_code
       FROM ludy_kernel.mail_message
       WHERE org_id = $1 AND to_address = $2 AND template_key = 'meetings.morning'
       ORDER BY created_at DESC`,
      [orgId, `${who}@morning-briefing.test`],
    ).then((r) => r.rows);

  function captureMailer(answers: SendResult[] = []): { mailer: MailProvider; sent: OutboundMail[] } {
    const sent: OutboundMail[] = [];
    const mailer: MailProvider = {
      name: 'resend',
      enabled: true,
      sendRetrySafety: 'idempotent',
      send: async (mail) => {
        sent.push(mail);
        return answers.shift() ?? { status: 'accepted', providerMessageId: `em_${randomUUID()}` };
      },
    };
    return { mailer, sent };
  }

  const mailDeps = (mailer: MailProvider, customRuntime: Runtime = worker): MailQueueDeps => ({
    runtime: customRuntime,
    mailer,
    templates: MAIL_TEMPLATES,
    publicUrl: 'https://ludy.test/',
    bounceDomain: null,
    brand: 'Ludy',
    workerDb,
  });

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appConnUrl = login('ludy_app', 'test-app-pw');
    workerConnUrl = login('ludy_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appConnUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerConnUrl, max: 4 });
    pools.push(appPool, workerPool);
    workerDb = createDb(workerPool);

    const registry = {
      commands: [...kernelCommands, ...crmCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries],
    };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
    noCrmWorker = new Runtime(workerDb, { manifests: TEST_MANIFESTS, absentModules: ['crm'] }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });

    const people: Array<[string, string]> = [
      ['owner', 'Chủ Doanh Nghiệp'],
      ['rec', 'Người Ghi Họp'],
      ['lan', 'Nguyễn Thị Lan'],
      ['nam', 'Trần Văn Nam'],
      ['hoa', 'Lê Hoa'],
      ['other', 'Khách Nội Bộ Khác'],
      ['no_vy', 'Phạm Không Vy'],
      ['vy_cap', 'Vũ Nhiều Cuộc Họp'],
      ['downgrade', 'Đào Hạ Cấp'],
      ['removed', 'Bùi Rời Nhóm'],
      ['mail_off', 'Đỗ Tắt Thư'],
      ['no_crm', 'Hồ Không CRM'],
    ];
    for (const [key, displayName] of people) {
      users[key] = await upsertIdentity(createDb(appPool), {
        issuer: 'morning-briefing',
        subject: key,
        email: `${key}@morning-briefing.test`,
        name: displayName,
      });
    }
    const createdOrg = await createOrg(runtime, asUser('owner'), 'Công ty Bản Tin Sáng');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;
    const memberIds = people.filter(([k]) => k !== 'owner').map(([k]) => users[k]);
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       SELECT $1, u, 'member' FROM unnest($2::uuid[]) u`,
      [orgId, memberIds],
    );
    await exec('rec', 'crm.pipeline.setup', {});
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('queues v2 metadata-only mail and renders full briefing with O2 readers, decisions, task flags, O5 CRM deals, and O3 Vy lines', async () => {
    const now = await localNow(ZONE);
    const connPrimary = await connectCalendar('lan', 'primary');
    const connSecondary = await connectCalendar('lan', 'secondary');
    const connInactive = await connectCalendar('lan', 'paused', 'expired');

    const seriesId = randomUUID();
    const prevMeetingId = await createMeeting({
      recorder: 'rec',
      title: 'Họp tuần trước với Á Châu',
      startedAt: new Date(now.start_of_day.getTime() - 7 * 86_400_000 + 9 * 3600_000),
      readers: ['lan'],
      seriesId,
    });
    const todayMeetingId = await createMeeting({
      recorder: 'rec',
      title: 'Họp triển khai Q4',
      startedAt: new Date(now.start_of_day.getTime() + 9 * 3600_000),
      readers: ['lan', 'nam', 'hoa'],
      seriesId,
    });
    const dealLinkedMeetingId = await createMeeting({
      recorder: 'rec',
      title: 'Họp chốt hợp đồng Bình Minh',
      startedAt: new Date(now.start_of_day.getTime() + 14 * 3600_000),
      readers: ['lan'],
    });
    const otherConn = await connectCalendar('other');
    const otherSecretMeetingId = await createMeeting({
      recorder: 'other',
      title: 'Họp lương mật ban giám đốc',
      startedAt: new Date(now.start_of_day.getTime() + 11 * 3600_000),
      readers: ['other'],
    });
    await insertAgenda({
      connectionId: otherConn,
      who: 'other',
      externalId: 'other-secret-agenda',
      title: 'Họp lương mật ban giám đốc',
      startsAt: new Date(now.start_of_day.getTime() + 11 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 11.5 * 3600_000),
      meetingId: otherSecretMeetingId,
    });

    // Previous decisions: published shown, draft excluded.
    await addResult(prevMeetingId, ['Chốt báo giá 15 triệu với Á Châu'], 'published');
    await addResult(prevMeetingId, ['Nháp nội bộ không được lộ'], 'draft');

    // Position for lan to verify assignee_position_id ownership resolution in task flags.
    const lanPositionId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, holder_user_id, status)
       VALUES ($1, $2, 'Phụ trách khách hàng', 'crm', 'account_lead', $3, 'active')`,
      [orgId, lanPositionId, users.lan],
    );
    const yesterdayDate = new Date(now.start_of_day.getTime() - 86_400_000);
    await addActionItem({
      meetingId: prevMeetingId,
      title: 'Gửi hợp đồng bản cuối',
      stage: 'published',
      taskStatus: 'in_progress',
      taskDue: yesterdayDate,
      assigneePositionId: lanPositionId,
    });
    await addActionItem({
      meetingId: prevMeetingId,
      title: 'Chuẩn bị slide demo hôm nay',
      stage: 'published',
      whoParsed: 'lan',
      whenParsed: now.day,
    });
    await addActionItem({
      meetingId: prevMeetingId,
      title: 'Việc đã hoàn tất phải ẩn',
      stage: 'published',
      taskStatus: 'done',
      whoParsed: 'lan',
    });
    await addActionItem({
      meetingId: prevMeetingId,
      title: 'Việc nháp phải ẩn',
      stage: 'draft',
      whoParsed: 'lan',
    });

    // CRM links: party_id on previous meeting, plus direct deal_id on today's second meeting.
    const partyAsia = await createParty('Công ty Á Châu');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_link (org_id, meeting_id, party_id, created_by) VALUES ($1, $2, $3, $4)`,
      [orgId, prevMeetingId, partyAsia, users.rec],
    );
    await createDeal(partyAsia, 'Gói Enterprise Á Châu', '15000000');
    await createDeal(partyAsia, 'Gói Thử Nghiệm 0đ', '0');
    await createDeal(partyAsia, 'Gói Cũ Đã Chốt', '9000000', true);

    const partySunrise = await createParty('Công ty Bình Minh');
    const directDeal = await createDeal(partySunrise, 'Hợp đồng Bình Minh', '24500000');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_link (org_id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4)`,
      [orgId, dealLinkedMeetingId, directDeal.id, users.rec],
    );

    // Vy 36h prep lines: valid for lan + expired + nam's lines (must not cross members).
    await setMorning('lan', {
      enabled: true,
      minute: Math.max(0, now.minute - 10),
      timeZone: ZONE,
      language: 'vi',
      content: 'full',
      vyLines: true,
    });
    await setMorning('nam', {
      enabled: true,
      minute: 60,
      timeZone: 'UTC',
      language: 'vi',
      content: 'full',
      vyLines: true,
    });
    await upsertVyLines('lan', todayMeetingId, ['Kiểm tra lại hợp đồng Á Châu trước 9 giờ.'], 12);
    await upsertVyLines('lan', dealLinkedMeetingId, ['Hết hạn rồi không được hiện.'], 12);
    await sqlAdmin(
      `UPDATE ludy_meetings.morning_brief_lines
       SET expires_at = now() - interval '1 hour'
       WHERE org_id = $1 AND user_id = $2 AND meeting_id = $3`,
      [orgId, users.lan, dealLinkedMeetingId],
    );
    await upsertVyLines('nam', todayMeetingId, ['Ghi chú riêng của Nam không được lộ cho Lan.'], 12);
    await setMorning('nam', { enabled: false, minute: 60, timeZone: 'UTC', language: 'vi', content: 'count', vyLines: false });

    // Deduplicated calendar agenda: duplicate external_id across connections keeps linked row; inactive connection ignored.
    const t1Start = new Date(now.start_of_day.getTime() + 9 * 3600_000);
    const t1End = new Date(t1Start.getTime() + 45 * 60_000);
    await insertAgenda({
      connectionId: connPrimary,
      who: 'lan',
      externalId: 'shared-standup',
      title: 'Họp triển khai Q4',
      startsAt: t1Start,
      endsAt: t1End,
      inviteeCount: 6,
      meetingId: null,
    });
    await insertAgenda({
      connectionId: connSecondary,
      who: 'lan',
      externalId: 'shared-standup',
      title: 'Họp triển khai Q4',
      startsAt: t1Start,
      endsAt: t1End,
      inviteeCount: 6,
      meetingId: todayMeetingId,
      seriesId,
    });
    await insertAgenda({
      connectionId: connPrimary,
      who: 'lan',
      externalId: 'sunrise-sync',
      title: 'Họp chốt hợp đồng Bình Minh',
      startsAt: new Date(now.start_of_day.getTime() + 14 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 14.5 * 3600_000),
      inviteeCount: 3,
      meetingId: dealLinkedMeetingId,
    });
    await insertAgenda({
      connectionId: connPrimary,
      who: 'lan',
      externalId: 'external-intro',
      title: 'Trao đổi đối tác bên ngoài',
      startsAt: new Date(now.start_of_day.getTime() + 16 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 16.5 * 3600_000),
      inviteeCount: 7,
      meetingId: null,
    });
    await insertAgenda({
      connectionId: connInactive,
      who: 'lan',
      externalId: 'paused-connection-event',
      title: 'Sự kiện từ lịch đã tạm dừng',
      startsAt: new Date(now.start_of_day.getTime() + 17 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 17.5 * 3600_000),
    });

    await setMorning('lan', {
      enabled: true,
      minute: Math.max(0, now.minute - 10),
      timeZone: ZONE,
      language: 'vi',
      content: 'full',
      vyLines: true,
    });
    expect(await getMorning('lan')).toMatchObject({ enabled: true, content: 'full', vyLines: true });

    // meetings.morning.mail_content cannot be called directly by user or plain system runtime.
    await expect(
      runtime.query(MORNING_MAIL_CONTENT_COMMAND, { day: now.day, orgPrefix: `/o/${orgSlug}` }, { actor: asUser('lan'), orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      worker.query(MORNING_MAIL_CONTENT_COMMAND, { day: now.day, orgPrefix: `/o/${orgSlug}` }, { actor: SYSTEM, orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const sweep = await runMeetingsMorningSweep({ runtime: worker, workerDb });
    expect(sweep.sent).toBeGreaterThanOrEqual(1);

    const queued = await mailRowsFor('lan');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      status: 'queued',
      source: 'meetings.morning',
      source_id: users.lan,
      subject: 'Lịch họp trong ngày',
    });
    expect(queued[0]!.payload).toEqual({
      lang: 'vi',
      org: 'Công ty Bản Tin Sáng',
      path: `/o/${orgSlug}/meetings`,
      day: now.day,
    });
    // Zero sensitive strings stored in DB queue row before render time.
    const serializedQueue = JSON.stringify(queued[0]!.payload);
    expect(serializedQueue).not.toMatch(/triển khai|Á Châu|hợp đồng|Kiểm tra/u);

    const { mailer, sent } = captureMailer();
    const outcome = await runMailJob(mailDeps(mailer), { orgId, messageId: queued[0]!.id });
    expect(outcome).toEqual({ action: 'recorded', outcome: 'sent', code: null });
    expect(sent).toHaveLength(1);

    const rendered = sent[0]!;
    expect(rendered.subject).toBe('Lịch họp trong ngày');
    // Deduplicated 3 events (shared-standup collapsed, paused-connection ignored).
    expect(rendered.text).toContain('3 cuộc họp');
    expect(rendered.text).toContain('Họp triển khai Q4');
    expect(rendered.text).toContain('Họp chốt hợp đồng Bình Minh');
    expect(rendered.text).toContain('Trao đổi đối tác bên ngoài');
    expect(rendered.text).not.toContain('Sự kiện từ lịch đã tạm dừng');
    expect(rendered.text).not.toContain('Họp lương mật');

    // O2 org readers display names (no email leakage) + external invitee count.
    expect(rendered.text).toContain('6 khách mời');
    expect(rendered.text).toContain('7 khách mời');
    expect(rendered.text).toContain('Nguyễn Thị Lan');
    expect(rendered.text).toContain('Trần Văn Nam');
    expect(rendered.text).toContain('Lê Hoa');
    expect(rendered.text).not.toContain('lan@morning-briefing.test');
    expect(rendered.text).not.toContain('nam@morning-briefing.test');

    // Previous decisions (published only), open/overdue/mine action items (done/draft excluded).
    expect(rendered.text).toContain('Chốt báo giá 15 triệu với Á Châu');
    expect(rendered.text).not.toContain('Nháp nội bộ không được lộ');
    expect(rendered.text).toContain('Gửi hợp đồng bản cuối');
    expect(rendered.text).toContain('Quá hạn');
    expect(rendered.text).toContain('Việc của bạn');
    expect(rendered.text).toContain('Chuẩn bị slide demo hôm nay');
    expect(rendered.text).not.toContain('Việc đã hoàn tất phải ẩn');
    expect(rendered.text).not.toContain('Việc nháp phải ẩn');

    // O5 open CRM deals (won excluded, 0đ amount omitted, direct deal_id link supported).
    expect(rendered.text).toContain('Gói Enterprise Á Châu');
    expect(rendered.text).toContain('15.000.000 đồng');
    expect(rendered.text).toContain('Gói Thử Nghiệm 0đ');
    expect(rendered.text).toContain('Hợp đồng Bình Minh');
    expect(rendered.text).toContain('24.500.000 đồng');
    expect(rendered.text).not.toContain('Gói Cũ Đã Chốt');

    // O3 Vy prep lines (valid non-expired row for lan shown; expired and nam's excluded).
    expect(rendered.text).toContain('Kiểm tra lại hợp đồng Á Châu trước 9 giờ.');
    expect(rendered.text).not.toContain('Hết hạn rồi không được hiện.');
    expect(rendered.text).not.toContain('Ghi chú riêng của Nam không được lộ cho Lan.');
  });

  it('respects vyLines toggle off, enforces 5-meeting Vy cap, and handles missing CRM gracefully', async () => {
    const now = await localNow(ZONE);
    const dueMinute = Math.max(0, now.minute - 10);
    const connNoVy = await connectCalendar('no_vy');
    const meetingNoVy = await createMeeting({
      recorder: 'no_vy',
      title: 'Họp giữ kiện thực tế',
      startedAt: new Date(now.start_of_day.getTime() + 9 * 3600_000),
      readers: ['no_vy'],
    });
    await addResult(meetingNoVy, ['Quyết định giữ nguyên kế hoạch']);
    const seriesNoVy = randomUUID();
    const prevNoVy = await createMeeting({
      recorder: 'no_vy',
      title: 'Họp tuần trước no_vy',
      startedAt: new Date(now.start_of_day.getTime() - 2 * 86_400_000 + 9 * 3600_000),
      readers: ['no_vy'],
      seriesId: seriesNoVy,
    });
    await addResult(prevNoVy, ['Quyết định từ phiên trước của no_vy']);
    await setMorning('no_vy', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: true });
    await upsertVyLines('no_vy', meetingNoVy, ['Gợi ý Vy phải bị ẩn khi vyLines tắt']);
    await insertAgenda({
      connectionId: connNoVy,
      who: 'no_vy',
      externalId: 'no-vy-1',
      title: 'Họp giữ kiện thực tế',
      startsAt: new Date(now.start_of_day.getTime() + 9 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 9.5 * 3600_000),
      meetingId: meetingNoVy,
      seriesId: seriesNoVy,
    });
    await setMorning('no_vy', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: false });
    await worker.execute('meetings.morning.notice', { userId: users.no_vy, day: now.day }, { actor: SYSTEM, orgId });
    const noVyMail = (await mailRowsFor('no_vy'))[0]!;
    const outNoVy = captureMailer();
    expect(await runMailJob(mailDeps(outNoVy.mailer), { orgId, messageId: noVyMail.id })).toEqual({
      action: 'recorded',
      outcome: 'sent',
      code: null,
    });
    expect(outNoVy.sent[0]!.text).toContain('Quyết định từ phiên trước của no_vy');
    expect(outNoVy.sent[0]!.text).not.toContain('Gợi ý Vy phải bị ẩn khi vyLines tắt');

    // Cap vyLines at MORNING_BRIEFING_CAPS.vyMeetingsMax (5) across 7 meetings.
    const connCap = await connectCalendar('vy_cap');
    await setMorning('vy_cap', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'en', content: 'full', vyLines: true });
    for (let i = 0; i < 7; i += 1) {
      const mId = await createMeeting({
        recorder: 'vy_cap',
        title: `Họp cap ${i + 1}`,
        startedAt: new Date(now.start_of_day.getTime() + (8 + i) * 3600_000),
        readers: ['vy_cap'],
      });
      await upsertVyLines('vy_cap', mId, [`Gợi ý Vy số ${i + 1}`]);
      await insertAgenda({
        connectionId: connCap,
        who: 'vy_cap',
        externalId: `cap-${i}`,
        title: `Họp cap ${i + 1}`,
        startsAt: new Date(now.start_of_day.getTime() + (8 + i) * 3600_000),
        endsAt: new Date(now.start_of_day.getTime() + (8.5 + i) * 3600_000),
        meetingId: mId,
      });
    }
    await worker.execute('meetings.morning.notice', { userId: users.vy_cap, day: now.day }, { actor: SYSTEM, orgId });
    const capMail = (await mailRowsFor('vy_cap'))[0]!;
    const outCap = captureMailer();
    expect(await runMailJob(mailDeps(outCap.mailer), { orgId, messageId: capMail.id })).toEqual({
      action: 'recorded',
      outcome: 'sent',
      code: null,
    });
    expect(outCap.sent[0]!.subject).toBe('Daily meeting briefing');
    let shownVyCount = 0;
    for (let i = 0; i < 7; i += 1) {
      if (outCap.sent[0]!.text.includes(`Gợi ý Vy số ${i + 1}`)) shownVyCount += 1;
    }
    expect(shownVyCount).toBe(MORNING_BRIEFING_CAPS.vyMeetingsMax);
    expect(outCap.sent[0]!.text).toContain('Họp cap 7');

    // Deployment without CRM module renders full briefing smoothly without CRM deals.
    const connNoCrm = await connectCalendar('no_crm');
    const noCrmMeeting = await createMeeting({
      recorder: 'no_crm',
      title: 'Họp khi không có CRM',
      startedAt: new Date(now.start_of_day.getTime() + 10 * 3600_000),
      readers: ['no_crm'],
    });
    const noCrmParty = await createParty('Khách hàng Không CRM');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting_link (org_id, meeting_id, party_id, created_by) VALUES ($1, $2, $3, $4)`,
      [orgId, noCrmMeeting, noCrmParty, users.no_crm],
    );
    await createDeal(noCrmParty, 'Cơ hội ẩn khi tắt CRM', '5000000');
    await insertAgenda({
      connectionId: connNoCrm,
      who: 'no_crm',
      externalId: 'no-crm-1',
      title: 'Họp khi không có CRM',
      startsAt: new Date(now.start_of_day.getTime() + 10 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 10.5 * 3600_000),
      meetingId: noCrmMeeting,
    });
    await setMorning('no_crm', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: false });
    await worker.execute('meetings.morning.notice', { userId: users.no_crm, day: now.day }, { actor: SYSTEM, orgId });
    const noCrmMail = (await mailRowsFor('no_crm'))[0]!;
    const outNoCrm = captureMailer();
    expect(await runMailJob(mailDeps(outNoCrm.mailer, noCrmWorker), { orgId, messageId: noCrmMail.id })).toEqual({
      action: 'recorded',
      outcome: 'sent',
      code: null,
    });
    expect(outNoCrm.sent[0]!.text).toContain('Họp khi không có CRM');
    expect(outNoCrm.sent[0]!.text).not.toContain('Cơ hội ẩn khi tắt CRM');
  });

  it('fails closed on revoked readers, downgrade to count, removed membership, mail off, and non-worker SQL callers', async () => {
    const now = await localNow(ZONE);
    const dueMinute = Math.max(0, now.minute - 10);

    // 1. Reader revoked after mail queued -> falls back to /meetings/record without meeting details, readers, decisions, or Vy lines.
    const connRev = await connectCalendar('nam');
    const revSeries = randomUUID();
    const revPrev = await createMeeting({
      recorder: 'rec',
      title: 'Phiên trước đã bị gỡ quyền',
      startedAt: new Date(now.start_of_day.getTime() - 86_400_000 + 9 * 3600_000),
      readers: ['nam'],
      seriesId: revSeries,
    });
    await addResult(revPrev, ['Quyết định mật đã gỡ quyền']);
    const revToday = await createMeeting({
      recorder: 'rec',
      title: 'Họp Nam vừa bị gỡ quyền đọc',
      startedAt: new Date(now.start_of_day.getTime() + 15 * 3600_000),
      readers: ['nam', 'hoa'],
      seriesId: revSeries,
    });
    await setMorning('nam', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: true });
    await upsertVyLines('nam', revToday, ['Gợi ý Vy phải biến mất khi gỡ quyền']);
    await insertAgenda({
      connectionId: connRev,
      who: 'nam',
      externalId: 'rev-1',
      title: 'Họp Nam vừa bị gỡ quyền đọc',
      startsAt: new Date(now.start_of_day.getTime() + 15 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 15.5 * 3600_000),
      meetingId: revToday,
      seriesId: revSeries,
    });
    await worker.execute('meetings.morning.notice', { userId: users.nam, day: now.day }, { actor: SYSTEM, orgId });
    await sqlAdmin(
      `DELETE FROM ludy_meetings.meeting_reader WHERE org_id = $1 AND user_id = $2 AND meeting_id IN ($3, $4)`,
      [orgId, users.nam, revPrev, revToday],
    );
    const namMail = (await mailRowsFor('nam'))[0]!;
    const outNam = captureMailer();
    expect(await runMailJob(mailDeps(outNam.mailer), { orgId, messageId: namMail.id })).toEqual({
      action: 'recorded',
      outcome: 'sent',
      code: null,
    });
    expect(outNam.sent[0]!.html).toContain(`/o/${orgSlug}/meetings/record`);
    expect(outNam.sent[0]!.html).not.toContain(`/o/${orgSlug}/meetings/${revToday}`);
    expect(outNam.sent[0]!.text).not.toContain('Lê Hoa');
    expect(outNam.sent[0]!.text).not.toContain('Quyết định mật đã gỡ quyền');
    expect(outNam.sent[0]!.text).not.toContain('Gợi ý Vy phải biến mất khi gỡ quyền');

    // 2. Downgrade from full back to count before send -> fails closed with TEMPLATE_DATA, sends zero mail.
    const connDown = await connectCalendar('downgrade');
    await insertAgenda({
      connectionId: connDown,
      who: 'downgrade',
      externalId: 'down-1',
      title: 'Họp không được gửi sau hạ cấp',
      startsAt: new Date(now.start_of_day.getTime() + 11 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 11.5 * 3600_000),
    });
    await setMorning('downgrade', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: false });
    await worker.execute('meetings.morning.notice', { userId: users.downgrade, day: now.day }, { actor: SYSTEM, orgId });
    await setMorning('downgrade', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'count' });
    const downMail = (await mailRowsFor('downgrade'))[0]!;
    const outDown = captureMailer();
    expect(await runMailJob(mailDeps(outDown.mailer), { orgId, messageId: downMail.id })).toEqual({
      action: 'recorded',
      outcome: 'failed',
      code: 'TEMPLATE_DATA',
    });
    expect(outDown.sent).toHaveLength(0);

    // 3. Removed member before send -> fails closed with TEMPLATE_DATA, sends zero mail.
    const connRem = await connectCalendar('removed');
    await insertAgenda({
      connectionId: connRem,
      who: 'removed',
      externalId: 'rem-1',
      title: 'Họp thành viên đã rời tổ chức',
      startsAt: new Date(now.start_of_day.getTime() + 12 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 12.5 * 3600_000),
    });
    await setMorning('removed', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: false });
    await worker.execute('meetings.morning.notice', { userId: users.removed, day: now.day }, { actor: SYSTEM, orgId });
    await runtime.execute('kernel.member.remove', { userId: users.removed }, { actor: asMfa('owner'), orgId });
    const remMail = (await mailRowsFor('removed'))[0]!;
    const outRem = captureMailer();
    expect(await runMailJob(mailDeps(outRem.mailer), { orgId, messageId: remMail.id })).toEqual({
      action: 'recorded',
      outcome: 'failed',
      code: 'TEMPLATE_DATA',
    });
    expect(outRem.sent).toHaveLength(0);

    // 4. !mailer.enabled skips log preview for v2 full briefing so sensitive titles are never logged.
    const connMailOff = await connectCalendar('mail_off');
    await insertAgenda({
      connectionId: connMailOff,
      who: 'mail_off',
      externalId: 'mail-off-1',
      title: 'Tiêu đề bí mật không được in vào log',
      startsAt: new Date(now.start_of_day.getTime() + 13 * 3600_000),
      endsAt: new Date(now.start_of_day.getTime() + 13.5 * 3600_000),
    });
    await setMorning('mail_off', { enabled: true, minute: dueMinute, timeZone: ZONE, language: 'vi', content: 'full', vyLines: false });
    await worker.execute('meetings.morning.notice', { userId: users.mail_off, day: now.day }, { actor: SYSTEM, orgId });
    const mailOffRow = (await mailRowsFor('mail_off'))[0]!;
    const previewLogs: string[] = [];
    const logProvider = createLogProvider((line) => previewLogs.push(line));
    expect(await runMailJob(mailDeps(logProvider), { orgId, messageId: mailOffRow.id })).toEqual({
      action: 'recorded',
      outcome: 'failed',
      code: 'MAIL_OFF',
    });
    expect(previewLogs).toEqual([]);

    // 5. Direct SQL role & context checks on morning briefing helper definers.
    const appClient = new pg.Client({ connectionString: appConnUrl });
    await appClient.connect();
    try {
      await expect(
        appClient.query(`SELECT ludy_meetings.morning_notice_is_full($1::uuid, $2::uuid)`, [orgId, users.lan]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appClient.query(`SELECT * FROM ludy_meetings.morning_briefing_window($1::date)`, [now.day]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appClient.query(`SELECT * FROM ludy_meetings.morning_briefing_active_connections()`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appClient.query(`SELECT * FROM ludy_meetings.morning_briefing_task_flags($1::uuid[], $2::date)`, [[], now.day]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.end();
    }

    const workerClient = new pg.Client({ connectionString: workerConnUrl });
    await workerClient.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      await expect(
        workerClient.query(`SELECT * FROM ludy_meetings.morning_briefing_window($1::date)`, [now.day]),
      ).rejects.toMatchObject({ code: '42501' });
      await workerClient.query('ROLLBACK');

      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      await expect(
        workerClient.query(`SELECT * FROM ludy_meetings.morning_briefing_active_connections()`),
      ).rejects.toMatchObject({ code: '42501' });
      await workerClient.query('ROLLBACK');

      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      await expect(
        workerClient.query(`SELECT * FROM ludy_meetings.morning_briefing_task_flags($1::uuid[], $2::date)`, [[], now.day]),
      ).rejects.toMatchObject({ code: '42501' });
      await workerClient.query('ROLLBACK');
    } finally {
      await workerClient.end();
    }

    // Type check dummy MorningBriefingContent reference to ensure contract import stays exercised cleanly.
    const checkType: Pick<MorningBriefingContent, 'day'> = { day: now.day };
    expect(checkType.day).toBe(now.day);
  });
});
