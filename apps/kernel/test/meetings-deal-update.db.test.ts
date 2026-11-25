// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy proposing the update of a deal after a meeting linked to it (#4766, ADR-0048, ADR-0049) on PostgreSQL 17 with a fake model: the card's status (no link, no minutes, closed deal, no CRM,
// Vy off), recorder-only access, a proposal that writes nothing, a confirm that writes a tainted task, a timeline line and closes the stale-deal reminder in one transaction, the checks on what is
// on screen (stale minutes, another deal, a day the minutes never wrote, a link in the text), one task per idempotency key, ids and counts only in audit, and no prose in logs.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { DealUpdateConfirmed, DealUpdateStatus, Deal, PipelineStage } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { dealUpdateStatusOf, runMeetingDealUpdate, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_SUMMARY = 'Chốt gói thử 2 tuần tại xưởng Bình Minh.';
const STEP = 'Gửi lịch triển khai cho anh An';
const NOTE = 'Hai bên chốt gói thử 2 tuần tại xưởng Bình Minh.';

suite('the recorder\'s Vy updating the deal a meeting is linked to (#4766)', () => {
  const dbName = `ludy_test_deal_update_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let noCrm: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, key?: string) =>
    runtime.execute<O>(name, input, { actor: asUser(who), orgId, ...(key ? { idempotencyKey: key } : {}) });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  let modelCalls = 0;
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))),
  );
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    setSummaryEnabled(true);
  });

  let answer = '';
  let lastPrompt: { system: string; user: string; feature?: string | undefined } | null = null;
  const model: ModelPort = {
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastPrompt = prompt;
      return { text: answer, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (): MeetingSummaryDeps => ({ runtime, model, meter: () => meter, budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }), timeoutMs: 2000 });
  const proposal = (over: Record<string, unknown> = {}) => JSON.stringify({ nextStep: { text: STEP, item: 1 }, note: NOTE, ...over });

  async function seedMeeting(opts: { publish?: boolean } = {}): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp khách', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: SECRET_SUMMARY, decisions: ['Giữ tiến độ'] });
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Gửi lịch triển khai', who: 'An', whoUserId: null, when: 'thứ sáu', whenDate: '2026-11-27', transcriptSeconds: 90 });
    if (opts.publish !== false) await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.other]);
    return meetingId;
  }
  const party = (name: string) => sqlAdmin<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => r.rows[0]!.id);
  const makeDeal = async (partyId: string, title: string) => exec<Deal>('recorder', 'crm.deal.create', { partyId, title, amount: '5000000', expectedClose: '2026-12-31' });
  const link = (meetingId: string, dealId: string) => exec('recorder', 'meetings.link.add', { meetingId, kind: 'deal', targetId: dealId });
  const status = (meetingId: string, who = 'recorder') => runtime.query<DealUpdateStatus>('meetings.deal_update.status', { meetingId }, { actor: asUser(who), orgId });
  const confirm = (meetingId: string, dealId: string, minutesKey: string, over: Record<string, unknown> = {}, key: string = randomUUID(), who = 'recorder') =>
    exec<DealUpdateConfirmed>(who, 'meetings.deal_update.confirm', { meetingId, dealId, minutesKey, nextStep: { text: STEP, dueOn: '2026-11-27' }, note: NOTE, ...over }, key);
  const tasksOf = (meetingId: string) =>
    sqlAdmin<{ id: string; title: string; tainted: boolean; due: Date | null; source_ref: { type: string; id: string } }>(
      `SELECT id, title, tainted, due, source_ref FROM ludy_kernel.task WHERE org_id = $1 AND source_ref ->> 'id' = $2`,
      [orgId, meetingId],
    ).then((r) => r.rows);
  const activityOf = (partyId: string) =>
    sqlAdmin<{ summary: string }>(`SELECT summary FROM ludy_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'crm.deal.meeting_update'`, [orgId, partyId]).then((r) => r.rows);
  const commentsOf = (taskId: string) => sqlAdmin<{ body: string; author_type: string }>('SELECT body, author_type FROM ludy_kernel.task_comment WHERE org_id = $1 AND task_id = $2 ORDER BY created_at', [orgId, taskId]).then((r) => r.rows);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries] });
    noCrm = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['crm'] }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'other', 'viewer']) users[key] = await upsertIdentity(db, { issuer: 'deal-update', subject: key, email: `${key}@deal-update.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Cập Nhật')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, users.recorder, users.other, users.viewer]);
    await exec('recorder', 'crm.pipeline.setup', {});
  }, 300_000);

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    setSummaryEnabled(false);
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows the card only for the recorder of a meeting linked to an open deal with published minutes', async () => {
    const partyId = await party('Khách A');
    const deal = await makeDeal(partyId, 'Hợp đồng A');
    const unpublished = await seedMeeting({ publish: false });
    expect(await status(unpublished)).toMatchObject({ available: false, enabled: false, reason: 'no_deal', deal: null, minutesKey: null });
    await link(unpublished, deal.id);
    expect(await status(unpublished)).toMatchObject({ available: false, reason: 'no_minutes' });
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    const ready = await status(meetingId);
    expect(ready).toMatchObject({ available: true, enabled: true, reason: null, deal: { id: deal.id, title: 'Hợp đồng A' } });
    expect(typeof ready.minutesKey).toBe('string');
    // A reader who did not record it is told so and gets nothing about the deal.
    expect(await status(meetingId, 'other')).toMatchObject({ available: false, reason: 'not_recorder', deal: null, minutesKey: null });
    // Vy off: the card still shows, the button does not.
    setSummaryEnabled(false);
    expect(await status(meetingId)).toMatchObject({ available: true, enabled: false, reason: 'off' });
    setSummaryEnabled(true);
    // A deployment without the CRM has no deal to update.
    expect(await noCrm.query<DealUpdateStatus>('meetings.deal_update.status', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ available: false, reason: 'no_crm' });
    // A closed deal needs no next step.
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, { actor: asUser('recorder'), orgId });
    const won = stages.find((s) => s.kind === 'won') as PipelineStage;
    await exec('recorder', 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: won.id });
    expect(await status(meetingId)).toMatchObject({ available: false, reason: 'deal_closed' });
    expect(await refuses(confirm(meetingId, deal.id, ready.minutesKey as string))).toBe('DEAL_CLOSED');
  });

  it('proposes without writing anything, stores counts only and leaks no prose into logs', async () => {
    const partyId = await party('Khách B');
    const deal = await makeDeal(partyId, 'Hợp đồng B');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    answer = proposal();
    const out = await runMeetingDealUpdate(deps(), orgId, asUser('recorder'), { meetingId });
    expect(out).toMatchObject({ ai: 'used', errorCode: null, dealId: deal.id, nextStep: { text: STEP, dueOn: '2026-11-27' }, note: NOTE, dropped: 0 });
    expect(typeof out.minutesKey).toBe('string');
    expect(modelCalls).toBe(1);
    expect(lastPrompt?.feature).toBe('meetings.deal_update');
    expect(lastPrompt?.user).toMatch(/<items-[0-9a-f]+>/u);
    // Nothing was written to the deal's world by the proposal.
    expect(await tasksOf(meetingId)).toHaveLength(0);
    expect(await activityOf(partyId)).toHaveLength(0);
    const rows = await sqlAdmin<{ status: string; feature: string; body: string | null }>(
      `SELECT status, feature, body FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`,
      [orgId, meetingId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 'ready', feature: 'meetings.deal_update' });
    expect(JSON.parse(rows.rows[0]?.body ?? 'null')).toEqual({ v: 1, nextStep: true, note: true, dropped: 0 });
    expect(logged.join('\n')).not.toContain('Bình Minh');
    expect(logged.join('\n')).not.toContain(STEP);
  });

  it('drops what the checks refuse, answers nothing for a hopeless answer, and refuses before any call when Vy is off or the caller is not the recorder', async () => {
    const partyId = await party('Khách C');
    const deal = await makeDeal(partyId, 'Hợp đồng C');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    answer = proposal({ note: 'Xem tại evil.example.com ngay.' });
    const dropped = await runMeetingDealUpdate(deps(), orgId, asUser('recorder'), { meetingId });
    expect(dropped).toMatchObject({ ai: 'used', note: null, dropped: 1, nextStep: { text: STEP } });
    answer = 'không phải JSON';
    expect(await runMeetingDealUpdate(deps(), orgId, asUser('recorder'), { meetingId })).toMatchObject({ ai: 'none', nextStep: null, note: null, dropped: 1 });
    const calls = modelCalls;
    setSummaryEnabled(false);
    expect(await runMeetingDealUpdate(deps(), orgId, asUser('recorder'), { meetingId })).toMatchObject({ ai: 'off', errorCode: 'SUMMARY_OFF' });
    setSummaryEnabled(true);
    expect(await refuses(runMeetingDealUpdate(deps(), orgId, asUser('other'), { meetingId }))).toBe('FORBIDDEN');
    expect(modelCalls).toBe(calls);
    expect((await dealUpdateStatusOf(deps(), orgId, asUser('recorder'), meetingId)).enabled).toBe(true);
    expect((await dealUpdateStatusOf({ ...deps(), model: null }, orgId, asUser('recorder'), meetingId)).reason).toBe('off');
  });

  it('confirms in one transaction: a tainted task due on the minutes\' day with the note as its comment, a fixed line on the contact\'s timeline, the stale-deal reminder closed, ids and counts only in audit, once per key', async () => {
    const partyId = await party('Khách D');
    const deal = await makeDeal(partyId, 'Hợp đồng D');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    await sqlAdmin(`INSERT INTO ludy_crm.deal_next_step (org_id, deal_id, reason, since_on) VALUES ($1, $2, 'no_activity', current_date - 20)`, [orgId, deal.id]);
    const key = (await status(meetingId)).minutesKey as string;
    const idem = randomUUID();
    const done = await confirm(meetingId, deal.id, key, {}, idem);
    expect(done).toMatchObject({ dealId: deal.id, noteSaved: true, remindersClosed: 1 });
    expect(typeof done.taskId).toBe('string');
    const tasks = await tasksOf(meetingId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: done.taskId, title: STEP, tainted: true, source_ref: { type: 'meetings.meeting', id: meetingId } });
    // 23:59 on the 27th in Vietnam.
    expect(new Date(tasks[0]?.due as Date).toISOString()).toBe('2026-11-27T16:59:00.000Z');
    // The note is a comment of the task, by the recorder; the timeline gets a line of fixed words and never the deal's title or the note (a summary keeps no free text).
    expect(await commentsOf(done.taskId)).toEqual([{ body: NOTE, author_type: 'user' }]);
    const lines = await activityOf(partyId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.summary).not.toContain('Hợp đồng D');
    expect(lines[0]?.summary).not.toContain(NOTE);
    const step = await sqlAdmin<{ status: string; closed_reason: string | null }>('SELECT status, closed_reason FROM ludy_crm.deal_next_step WHERE org_id = $1 AND deal_id = $2', [orgId, deal.id]);
    expect(step.rows).toEqual([{ status: 'closed', closed_reason: 'deal_edited' }]);
    // The same click again is the same answer and no second task.
    expect(await confirm(meetingId, deal.id, key, {}, idem)).toEqual(done);
    expect(await tasksOf(meetingId)).toHaveLength(1);
    expect(await activityOf(partyId)).toHaveLength(1);
    // Audit: ids, flags and counts, never the texts.
    const audit = await sqlAdmin<{ command: string; detail: unknown }>(`SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('meetings.deal_update.confirm', 'crm.deal.meeting_update.apply')`, [orgId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain('Bình Minh');
    expect(text).not.toContain(STEP);
    expect(text).toContain(String(done.taskId));
  });

  it('closes only the stale-deal reminder: a quote reminder stays open', async () => {
    const partyId = await party('Khách G');
    const deal = await makeDeal(partyId, 'Hợp đồng G');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    await sqlAdmin(`INSERT INTO ludy_crm.deal_next_step (org_id, deal_id, reason, since_on) VALUES ($1, $2, 'quote_unanswered', current_date - 8)`, [orgId, deal.id]);
    const done = await confirm(meetingId, deal.id, (await status(meetingId)).minutesKey as string);
    expect(done.remindersClosed).toBe(0);
    const step = await sqlAdmin<{ status: string }>('SELECT status FROM ludy_crm.deal_next_step WHERE org_id = $1 AND deal_id = $2', [orgId, deal.id]);
    expect(step.rows).toEqual([{ status: 'open' }]);
  });

  it('offers no action item that already has a task, and the CRM command refuses a meeting that is not linked to the deal', async () => {
    const partyId = await party('Khách H');
    const deal = await makeDeal(partyId, 'Hợp đồng H');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    const before = (await status(meetingId)).minutesKey;
    const taskId = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status) VALUES ($1, $2, 'Đã có việc', 'human', 'system', 'in_progress')`, [orgId, taskId]);
    await sqlAdmin(`UPDATE ludy_meetings.action_item SET task_id = $3, status = 'accepted' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, meetingId, taskId]);
    expect((await status(meetingId)).minutesKey).not.toBe(before);
    const stranger = await seedMeeting();
    expect(await refuses(exec('other', 'crm.deal.meeting_update.apply', { dealId: deal.id, meetingId: stranger, nextStep: null, note: NOTE, due: null }))).toBe('MEETING_NOT_LINKED');
  });

  it('works by hand with Vy off: a note alone, no day, a task of fixed title that holds it', async () => {
    const partyId = await party('Khách E');
    const deal = await makeDeal(partyId, 'Hợp đồng E');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    setSummaryEnabled(false);
    const key = (await status(meetingId)).minutesKey as string;
    const done = await confirm(meetingId, deal.id, key, { nextStep: null, note: 'Khách hẹn gọi lại tuần sau.' });
    expect(done).toMatchObject({ noteSaved: true });
    // A note with no next step is a task of fixed title that holds the note as a comment.
    const tasks = await tasksOf(meetingId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: done.taskId, title: 'Ghi chú sau cuộc họp', tainted: true });
    expect(tasks[0]?.due).toBeNull();
    expect(await commentsOf(done.taskId)).toEqual([{ body: 'Khách hẹn gọi lại tuần sau.', author_type: 'user' }]);
    expect(await activityOf(partyId)).toHaveLength(1);
  });

  it('refuses what is on screen but not true: stale minutes, another deal, a day the minutes never wrote, a link, nothing at all, a non-recorder, a viewer, and the CRM command called directly', async () => {
    const partyId = await party('Khách F');
    const deal = await makeDeal(partyId, 'Hợp đồng F');
    const other = await makeDeal(partyId, 'Hợp đồng khác');
    const meetingId = await seedMeeting();
    await link(meetingId, deal.id);
    const key = (await status(meetingId)).minutesKey as string;
    expect(await refuses(confirm(meetingId, deal.id, 'not-the-key'))).toBe('STALE_DEAL_UPDATE');
    expect(await refuses(confirm(meetingId, other.id, key))).toBe('STALE_DEAL_UPDATE');
    expect(await refuses(confirm(meetingId, deal.id, key, { nextStep: { text: STEP, dueOn: '2026-12-30' } }))).toBe('DEAL_UPDATE_DATE_INVALID');
    expect(await refuses(confirm(meetingId, deal.id, key, { note: 'Xem tại evil.example.com ngay.' }))).toBe('DEAL_UPDATE_TEXT_INVALID');
    expect(await refuses(confirm(meetingId, deal.id, key, { nextStep: { text: 'Gọi 0901234567 ngay', dueOn: null } }))).toBe('DEAL_UPDATE_TEXT_INVALID');
    expect(await refuses(confirm(meetingId, deal.id, key, { nextStep: null, note: null }))).toBe('DEAL_UPDATE_EMPTY');
    expect(await refuses(confirm(meetingId, deal.id, key, {}, randomUUID(), 'other'))).toBe('FORBIDDEN');
    expect(await refuses(confirm(meetingId, deal.id, key, {}, randomUUID(), 'viewer'))).not.toBeNull();
    // The CRM command has no route of its own and the viewer is not an editor of deals.
    expect(await refuses(exec('viewer', 'crm.deal.meeting_update.apply', { dealId: deal.id, meetingId, nextStep: null, note: NOTE, due: null }))).not.toBeNull();
    expect(await tasksOf(meetingId)).toHaveLength(0);
    expect(await activityOf(partyId)).toHaveLength(0);
    // The published minutes change: a proposal made for the old text is refused.
    await sqlAdmin(`UPDATE ludy_meetings.meeting_result SET summary = 'Đã sửa tóm tắt', updated_at = now() + interval '1 second' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, meetingId]);
    expect(await refuses(confirm(meetingId, deal.id, key))).toBe('STALE_DEAL_UPDATE');
  });
});
