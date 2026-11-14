// SPDX-License-Identifier: AGPL-3.0-only
// A member's own webhook for the minutes they publish, on a real database (Meetings A6, #3164, plan docs/plan/meetings-integrations.md section 4.5): the owner's switch (off by default), one
// address per member, the event stored in the recorder's own transaction at publish with only the ticked fields and never the transcript, the delivery's steps as the worker takes them (the body
// is wiped the moment a delivery settles), and everything that stops a queued event (the hook switched off, the owner's switch turned off, the member gone, the text of the meeting changed).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { runMeetingHookSweep } from '../src/meeting-hook-sweep.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const CREDENTIAL = { keyId: 'k1', envelope: 'AAAAAAAAAAAAAAAAAAAAAAAA', hint: 'whk_0a1b2c3d' };
const URL1 = 'https://hooks.example.com/ludy-minutes';

suite("a member's minutes webhook (A6, #3164)", () => {
  const dbName = `crove_test_hook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'meetings.hook' };
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const sysExec = <O = unknown>(name: string, input: unknown) => worker.execute<O>(name, input, { actor: system, orgId });
  const sysQuery = <O = unknown>(name: string, input: unknown) => worker.query<O>(name, input, { actor: system, orgId });
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

  type Delivery = { id: string; type: string; status: string; body: Record<string, unknown> | null; attempts: number; meeting_id: string | null };
  const deliveries = async (meetingId?: string) =>
    (await sqlAdmin<Delivery>(`SELECT id, type, status, body, attempts, meeting_id FROM crove_meetings.hook_delivery WHERE org_id = $1 ${meetingId ? 'AND meeting_id = $2' : ''} ORDER BY created_at, id`, meetingId ? [orgId, meetingId] : [orgId])).rows;
  const setSwitch = (on: boolean) => exec('owner', 'meetings.hooks.switch.set', { on });
  const setHook = (who: string, fields: string[], url = URL1, enabled = true) => exec<{ created: boolean }>(who, 'meetings.hook.set', { url, fields, enabled, credential: CREDENTIAL });

  // A meeting recorded by `recorder`, with a transcript (which must never reach a body), a draft summary with decisions, and two draft action items.
  async function seedPublishable(recorder: string, title = 'Họp giao ban tuần'): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4::text, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3::uuid, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder], title],
    );
    await exec(recorder, 'meetings.transcript.draft_store', { meetingId, segments: [{ startSeconds: 0, endSeconds: 10, speakerLabel: 'Hà', text: 'BÍ MẬT: lời nói trong cuộc họp' }] });
    await exec(recorder, 'meetings.summary.save', { meetingId, summary: 'Chốt kế hoạch tháng 12.', decisions: ['Tăng ngân sách quảng cáo 10%'] });
    for (const [title2, who, when, date] of [['Gửi báo giá cho khách', 'Lan', 'thứ sáu', '2026-11-13'], ['Kiểm kho', '', '', null]] as const) {
      await sqlAdmin(
        `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, when_drafted, when_parsed, stage, status, tainted) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'suggested', false)`,
        [orgId, randomUUID(), meetingId, title2, who, when, date],
      );
    }
    return meetingId;
  }
  const publish = (who: string, meetingId: string) => exec(who, 'meetings.result.publish', { meetingId, confirmed: true });

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
    const login = (role: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      return createPool({ connectionString: url.toString(), max: 4 });
    };
    const appPool = login('crove_app', 'test-app-pw');
    const workerPool = login('crove_worker', 'test-worker-pw');
    pools.push(appPool, workerPool);
    const register = (pool: pg.Pool) =>
      new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...meetingsCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
      });
    runtime = register(appPool);
    workerDb = createDb(workerPool);
    worker = register(workerPool);
    for (const key of ['owner', 'recorder', 'attendee', 'other']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'hook', subject: key, email: `${key}@hook.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Webhook biên bản')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.attendee, users.other]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("is off until the owner turns it on, and only an owner turns it on", async () => {
    expect(await query('recorder', 'meetings.hook.get', {})).toEqual({ switchOn: false, hook: null });
    // Off: no member can save an address.
    expect(await refuses(setHook('recorder', ['summary']))).toBe('MEETING_HOOKS_OFF');
    // An admin, a member: refused. The owner: on.
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.other]);
    expect(await refuses(exec('other', 'meetings.hooks.switch.set', { on: true }))).not.toBeNull();
    expect(await refuses(exec('recorder', 'meetings.hooks.switch.set', { on: true }))).not.toBeNull();
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.other]);
    expect(await setSwitch(true)).toEqual({ on: true });
    expect(await query('recorder', 'meetings.hook.get', {})).toEqual({ switchOn: true, hook: null });
    // A direct write to the column is refused by the guard trigger, whoever the member is.
    expect(await sqlAdmin(`SELECT meeting_hooks FROM crove_kernel.tenant WHERE org_id = $1`, [orgId]).then((r) => r.rows[0]?.meeting_hooks)).toBe(true);
  });

  it('gives a member one address of their own, with the fields they ticked, and no one else sees or changes it', async () => {
    expect(await setHook('recorder', ['title', 'summary', 'decisions', 'action_items'], 'http://hooks.example.com/x').then(() => null, (e: { code?: string }) => e.code ?? 'ERR')).not.toBeNull();
    expect(await refuses(setHook('recorder', ['summary'], 'https://10.0.0.1/hook'))).not.toBeNull();
    expect(await refuses(setHook('recorder', ['transcript']))).not.toBeNull();
    expect(await setHook('recorder', ['title', 'summary', 'decisions', 'action_items'])).toEqual({ created: true });
    expect(await setHook('recorder', ['title', 'summary'])).toEqual({ created: false });
    const state = await query<{ switchOn: boolean; hook: { url: string; fields: string[]; enabled: boolean; secretHint: string } }>('recorder', 'meetings.hook.get', {});
    expect(state.hook).toMatchObject({ url: URL1, fields: ['title', 'summary'], enabled: true, secretHint: 'whk_0a1b2c3d' });
    // The secret never comes back in a read: no key of the view holds the envelope.
    expect(JSON.stringify(state)).not.toContain(CREDENTIAL.envelope);
    // Another member sees their own (none), not the recorder's; the owner neither.
    expect((await query<{ hook: unknown }>('attendee', 'meetings.hook.get', {})).hook).toBeNull();
    expect((await query<{ hook: unknown }>('owner', 'meetings.hook.get', {})).hook).toBeNull();
    expect(await sqlAdmin(`SELECT count(*)::int AS n FROM crove_meetings.member_hook WHERE org_id = $1`, [orgId]).then((r) => r.rows[0]?.n)).toBe(1);
    // The audit rows hold the host and the fields, never the address or the sealed envelope.
    const audits = await sqlAdmin<{ payload: unknown }>(`SELECT payload FROM crove_kernel.audit_event WHERE org_id = $1 AND action IN ('meetings.hook.set')`, [orgId]).catch(() => ({ rows: [] as { payload: unknown }[] }));
    for (const row of audits.rows) {
      const text = JSON.stringify(row.payload);
      expect(text).not.toContain('/ludy-minutes');
      expect(text).not.toContain(CREDENTIAL.envelope);
    }
    // A rotation keeps the old secret verifying for a day and shows the new hint.
    await exec('recorder', 'meetings.hook.rotate_secret', { credential: { ...CREDENTIAL, hint: 'whk_deadbeef' } });
    const rotated = (await query<{ hook: { secretHint: string; previousUntil: string | null } }>('recorder', 'meetings.hook.get', {})).hook;
    expect(rotated.secretHint).toBe('whk_deadbeef');
    expect(rotated.previousUntil).not.toBeNull();
  });

  it("stores the event when the recorder publishes: the ticked fields only, never the transcript, and nothing for a member without a hook", async () => {
    const meetingId = await seedPublishable('recorder');
    expect(await publish('recorder', meetingId)).toMatchObject({ meetingId, results: 1, items: 2 });
    const [d] = await deliveries(meetingId);
    expect(d).toMatchObject({ type: 'meeting.result_published', status: 'queued', attempts: 0 });
    const body = d?.body as { id: string; type: string; org: string; data: Record<string, unknown> };
    expect(body).toMatchObject({ id: d?.id, type: 'meeting.result_published', org: orgId });
    // The always-sent part and the ticked fields (title and summary), no decisions or action items (not ticked), nothing of the transcript.
    expect(Object.keys(body.data).sort()).toEqual(['length_seconds', 'meeting_id', 'published_at', 'started_at', 'summary', 'title']);
    expect(body.data).toMatchObject({ meeting_id: meetingId, length_seconds: 1800, title: 'Họp giao ban tuần', summary: 'Chốt kế hoạch tháng 12.' });
    expect(JSON.stringify(d?.body)).not.toContain('BÍ MẬT');
    // The event id is the published result's id.
    const result = await sqlAdmin<{ id: string }>(`SELECT id FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, meetingId]);
    expect(d?.id).toBe(result.rows[0]?.id);

    // All four fields: the decisions and the action items (text, owner as said, due date).
    await setHook('recorder', ['title', 'summary', 'decisions', 'action_items']);
    const second = await seedPublishable('recorder', 'Họp thứ hai');
    await publish('recorder', second);
    const full = (await deliveries(second))[0]?.body as { data: { decisions: string[]; action_items: Array<{ text: string; owner: string | null; due: string | null }> } };
    expect(full.data.decisions).toEqual(['Tăng ngân sách quảng cáo 10%']);
    expect([...full.data.action_items].sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { text: 'Gửi báo giá cho khách', owner: 'Lan', due: '2026-11-13' },
      { text: 'Kiểm kho', owner: null, due: null },
    ]);
    expect(JSON.stringify(full)).not.toContain('BÍ MẬT');

    // A member who set no hook stores nothing: the attendee records and publishes, and the recorder's hook is not theirs.
    const third = await seedPublishable('attendee', 'Họp của người khác');
    await publish('attendee', third);
    expect(await deliveries(third)).toEqual([]);
  });

  it('sends nothing while the hook is off, and an unpublished meeting stores nothing', async () => {
    await setHook('recorder', ['title'], URL1, false);
    const meetingId = await seedPublishable('recorder', 'Họp khi tắt');
    // Nothing published yet: nothing stored.
    expect(await deliveries(meetingId)).toEqual([]);
    await publish('recorder', meetingId);
    expect(await deliveries(meetingId)).toEqual([]);
    await setHook('recorder', ['title'], URL1, true);
  });

  it("takes the delivery's steps as the worker does, and wipes the body the moment it settles", async () => {
    const meetingId = await seedPublishable('recorder', 'Họp để gửi');
    await publish('recorder', meetingId);
    const [queued] = await deliveries(meetingId);
    const id = queued?.id as string;
    // The job reads the delivery and the address while the hook stands.
    const row = await sysQuery<{ id: string; body: Record<string, unknown> | null; status: string; hookId: string }>('meetings.hook.delivery', { id });
    expect(row).toMatchObject({ id, status: 'queued' });
    expect(row?.body).not.toBeNull();
    const target = await sysQuery<{ url: string; userId: string; sealed: { keyId: string } } | null>('meetings.hook.target', { hookId: (row as { hookId: string }).hookId });
    expect(target).toMatchObject({ url: URL1, userId: users.recorder });
    // A user cannot take any of these steps.
    expect(await refuses(runtime.query('meetings.hook.delivery', { id }, { actor: asUser('recorder'), orgId }))).not.toBeNull();
    expect(await refuses(exec('recorder', 'meetings.hook.record', { id, outcome: 'sent', code: 200 }))).not.toBeNull();
    // A retry keeps the body; the attempt counts.
    expect(await sysExec('meetings.hook.record', { id, outcome: 'retry', code: 503 })).toEqual({ id, recorded: true });
    expect((await deliveries(meetingId))[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await deliveries(meetingId))[0]?.body).not.toBeNull();
    // Sent settles it and wipes the body; a second record of it changes nothing.
    expect(await sysExec('meetings.hook.record', { id, outcome: 'sent', code: 200 })).toEqual({ id, recorded: true });
    expect((await deliveries(meetingId))[0]).toMatchObject({ status: 'sent', body: null, attempts: 2 });
    expect(await sysExec('meetings.hook.record', { id, outcome: 'failed' })).toEqual({ id, recorded: false });
    expect((await query<{ hook: { lastStatus: string; consecutiveFailures: number } }>('recorder', 'meetings.hook.get', {})).hook).toMatchObject({ lastStatus: 'sent', consecutiveFailures: 0 });

    // Failed and expired settle and wipe too.
    for (const outcome of ['failed', 'expired', 'dropped'] as const) {
      const m = await seedPublishable('recorder', `Họp ${outcome}`);
      await publish('recorder', m);
      const e = (await deliveries(m))[0]?.id as string;
      await sysExec('meetings.hook.record', { id: e, outcome });
      expect((await deliveries(m))[0]).toMatchObject({ status: outcome === 'dropped' ? 'dropped' : 'failed', body: null });
    }
  });

  it('hands a stored event to the queue once, again only if never taken up for three minutes, and fails one that waited eight hours', async () => {
    const meetingId = await seedPublishable('recorder', 'Họp để quét');
    await publish('recorder', meetingId);
    const id = (await deliveries(meetingId))[0]?.id as string;
    const sent: Array<{ orgId: string; id: string }> = [];
    const sweep = () => runMeetingHookSweep({ runtime: worker, workerDb, send: async (job) => void sent.push(job) });
    const mine = () => sent.filter((j) => j.id === id).length;
    // Stored at publish and never handed over: handed over now, once; the next pass leaves it for the job.
    await sweep();
    expect(mine()).toBe(1);
    await sweep();
    expect(mine()).toBe(1);
    // Handed over but no job ever took it up (attempts still 0) for three minutes: handed over again.
    await sqlAdmin(`UPDATE crove_meetings.hook_delivery SET handed_at = now() - interval '4 minutes' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    await sweep();
    expect(mine()).toBe(2);
    // Once a job has tried it (a retry waits in the queue), the sweep leaves it alone until it is eight hours old.
    await sysExec('meetings.hook.record', { id, outcome: 'retry', code: 503 });
    await sqlAdmin(`UPDATE crove_meetings.hook_delivery SET handed_at = now() - interval '1 hour' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    await sweep();
    expect(mine()).toBe(2);
    await sqlAdmin(`UPDATE crove_meetings.hook_delivery SET created_at = now() - interval '9 hours' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    const done = await sweep();
    expect(done.expired).toBeGreaterThanOrEqual(1);
    expect((await deliveries(meetingId))[0]).toMatchObject({ status: 'failed', body: null });
    expect(mine()).toBe(2);
  });

  it('refuses a body with a key that could carry a transcript, audio, video or attendee contact, whoever writes it', async () => {
    const meetingId = await seedPublishable('recorder', 'Họp thử CHECK');
    const hook = await sqlAdmin<{ id: string }>(`SELECT id FROM crove_meetings.member_hook WHERE org_id = $1 AND user_id = $2`, [orgId, users.recorder]);
    const hookId = hook.rows[0]?.id as string;
    const insert = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      const body = { id, type: 'meeting.result_published', created_at: '2026-11-14T03:00:00.000Z', org: orgId, ...extra, data: { meeting_id: meetingId, published_at: '2026-11-14T03:00:00.000Z', started_at: '2026-11-10T03:00:00.000Z', length_seconds: 1800, ...data } };
      return sqlAdmin(`INSERT INTO crove_meetings.hook_delivery (org_id, id, hook_id, meeting_id, type, body) VALUES ($1, $2, $3, $4, 'meeting.result_published', $5::jsonb)`, [orgId, id, hookId, meetingId, JSON.stringify(body)]).then(
        () => null,
        (e: { code?: string }) => e.code ?? 'ERR',
      );
    };
    expect(await insert({ title: 'ok' })).toBeNull();
    for (const key of ['transcript', 'transcript_text', 'segments', 'audio_url', 'video_url', 'attendees', 'attendee_emails', 'email', 'phone', 'notes']) expect(await insert({ [key]: 'x' }), key).toBe('23514');
    expect(await insert({}, { transcript: 'x' })).toBe('23514');
    expect(await insert({ summary: 'a'.repeat(8001) })).toBe('23514');
    expect(await insert({ action_items: [{ text: 'Việc', owner: null, due: null, email: 'a@b.c' }] })).toBe('23514');
    // A settled delivery holds no body, and a queued one must hold one.
    expect(await sqlAdmin(`UPDATE crove_meetings.hook_delivery SET status = 'sent' WHERE org_id = $1 AND hook_id = $2 AND status = 'queued' AND body IS NOT NULL`, [orgId, hookId]).then(() => null, (e: { code?: string }) => e.code ?? 'ERR')).toBe('23514');
    await sqlAdmin(`DELETE FROM crove_meetings.hook_delivery WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]);
  });

  it('drops a queued event, and wipes its body, when the hook is turned off, the owner turns the feature off, or the text of its meeting changes', async () => {
    const queuedFor = async (title: string) => {
      const m = await seedPublishable('recorder', title);
      await publish('recorder', m);
      return m;
    };
    const state = async (m: string) => (await deliveries(m))[0];
    // The member turns the hook off.
    const a = await queuedFor('Họp tắt hook');
    expect(await state(a)).toMatchObject({ status: 'queued' });
    await setHook('recorder', ['title'], URL1, false);
    expect(await state(a)).toMatchObject({ status: 'dropped', body: null });
    await setHook('recorder', ['title'], URL1, true);
    // The owner turns the feature off: every queued event of the org is dropped in the same transaction; with it off nothing more is stored.
    const b = await queuedFor('Họp tắt công tắc');
    await setSwitch(false);
    expect(await state(b)).toMatchObject({ status: 'dropped', body: null });
    const c = await seedPublishable('recorder', 'Họp sau khi tắt');
    await publish('recorder', c);
    expect(await deliveries(c)).toEqual([]);
    await setSwitch(true);
    // The text of the meeting changes (a personal-data erasure redacts a summary, an action item or a title): the queued event is dropped.
    const d = await queuedFor('Họp đổi nội dung');
    await sqlAdmin(`UPDATE crove_meetings.meeting_result SET summary = 'đã xóa' WHERE org_id = $1 AND meeting_id = $2`, [orgId, d]);
    expect(await state(d)).toMatchObject({ status: 'dropped', body: null });
    const e = await queuedFor('Họp đổi việc');
    await sqlAdmin(`UPDATE crove_meetings.action_item SET title = 'đã xóa' WHERE org_id = $1 AND meeting_id = $2`, [orgId, e]);
    expect(await state(e)).toMatchObject({ status: 'dropped', body: null });
    const f = await queuedFor('Họp đổi tên');
    await sqlAdmin(`UPDATE crove_meetings.meeting SET title = 'đã xóa' WHERE org_id = $1 AND id = $2`, [orgId, f]);
    expect(await state(f)).toMatchObject({ status: 'dropped', body: null });
  });

  it('never lets the webhook block a publish, leaves a published event alone when a draft is edited, and drops what waits when the address or the fields narrow', async () => {
    await setHook('recorder', ['title', 'summary', 'decisions', 'action_items']);
    // A meeting longer than a day publishes, and its length goes out as null (the body carries at most a day).
    const long = await seedPublishable('recorder', 'Họp rất dài');
    await sqlAdmin(`UPDATE crove_meetings.meeting SET length_seconds = 200000 WHERE org_id = $1 AND id = $2`, [orgId, long]);
    await publish('recorder', long);
    const body = (await deliveries(long))[0]?.body as { data: { length_seconds: number | null } };
    expect(body.data.length_seconds).toBeNull();
    // Editing a draft after the publish (a new draft action item, its text changed) does not drop the published event.
    const keep = await seedPublishable('recorder', 'Họp giữ nguyên');
    await publish('recorder', keep);
    await sqlAdmin(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, when_drafted, stage, status, tainted) VALUES ($1, $2, $3, 'Việc nháp mới', '', '', 'draft', 'suggested', false)`,
      [orgId, randomUUID(), keep],
    );
    await sqlAdmin(`UPDATE crove_meetings.action_item SET title = 'Việc nháp đã sửa' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, keep]);
    expect((await deliveries(keep))[0]).toMatchObject({ status: 'queued' });
    expect((await deliveries(keep))[0]?.body).not.toBeNull();
    // The same address and the same or more fields keep what waits; a new address or a field taken away drops it and wipes the body.
    await setHook('recorder', ['title', 'summary', 'decisions', 'action_items']);
    expect((await deliveries(keep))[0]).toMatchObject({ status: 'queued' });
    await setHook('recorder', ['title', 'summary', 'decisions']);
    expect((await deliveries(keep))[0]).toMatchObject({ status: 'dropped', body: null });
    await setHook('recorder', ['title', 'summary', 'decisions', 'action_items']);
    const moved = await seedPublishable('recorder', 'Họp đổi địa chỉ');
    await publish('recorder', moved);
    expect((await deliveries(moved))[0]).toMatchObject({ status: 'queued' });
    await setHook('recorder', ['title', 'summary', 'decisions', 'action_items'], 'https://other.example.com/minutes');
    expect((await deliveries(moved))[0]).toMatchObject({ status: 'dropped', body: null });
    await setHook('recorder', ['title']);
  });

  it('stops when the member is disabled, leaves, or the meeting is deleted', async () => {
    // A queued event whose meeting is deleted goes with it.
    const m = await seedPublishable('recorder', 'Họp bị xóa');
    await publish('recorder', m);
    expect((await deliveries(m)).length).toBe(1);
    await sqlAdmin(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, m]);
    expect(await deliveries(m)).toEqual([]);
    // A disabled member: the worker's read of the address answers nothing, so the next attempt drops the delivery.
    const k = await seedPublishable('recorder', 'Họp khi vô hiệu');
    await publish('recorder', k);
    const [row] = await deliveries(k);
    const hookId = (await sysQuery<{ hookId: string }>('meetings.hook.delivery', { id: row?.id }))?.hookId as string;
    expect(await sysQuery('meetings.hook.target', { hookId })).not.toBeNull();
    await sqlAdmin(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.recorder]);
    expect(await sysQuery('meetings.hook.target', { hookId })).toBeNull();
    await sqlAdmin(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.recorder]);
    expect(await sysQuery('meetings.hook.target', { hookId })).not.toBeNull();
    // A member who leaves the org takes the hook and its deliveries with them.
    await sqlAdmin(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, users.recorder]);
    expect(await sqlAdmin(`SELECT count(*)::int AS n FROM crove_meetings.member_hook WHERE org_id = $1`, [orgId]).then((r) => r.rows[0]?.n)).toBe(0);
    expect(await deliveries(k)).toEqual([]);
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.recorder]);
  });

  it('sends a test ping with no meeting data, at most once a minute, and clears the member\'s own hook', async () => {
    await setHook('recorder', ['title']);
    const sent = await exec<{ eventId: string; queued: true }>('recorder', 'meetings.hook.test', {});
    expect(sent.queued).toBe(true);
    const [ping] = await deliveries();
    expect(ping).toMatchObject({ id: sent.eventId, type: 'ping', status: 'queued', meeting_id: null });
    expect(ping?.body).toMatchObject({ id: sent.eventId, type: 'ping', org: orgId, data: {} });
    expect(await refuses(exec('recorder', 'meetings.hook.test', {}))).toBe('MEETING_HOOK_TOO_SOON');
    // Nobody but the member tests it; another member has no hook.
    expect(await refuses(exec('attendee', 'meetings.hook.test', {}))).toBe('MEETING_HOOK_NOT_FOUND');
    expect(await exec('recorder', 'meetings.hook.clear', {})).toEqual({ cleared: true });
    expect(await refuses(exec('recorder', 'meetings.hook.clear', {}))).toBe('MEETING_HOOK_NOT_FOUND');
    expect(await deliveries()).toEqual([]);
  });

  it('is deleted with the org: the purge reaches both tables', async () => {
    const tables = await sqlAdmin<{ n: number }>(`SELECT pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) ~ 'crove_meetings.hook_delivery' AND pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) ~ 'crove_meetings.member_hook' AS n`);
    expect(tables.rows[0]?.n).toBe(true);
  });
});
