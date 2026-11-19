// SPDX-License-Identifier: AGPL-3.0-only
// Vy checking whether a meeting covered its agenda (#3959) on a real database with a fake model: only for the recorder, only on a click; the agenda is the typed lines then the open items of the previous meeting of
// the series; the model is given the numbered agenda and transcript and nothing else (no id, no email, no speaker); a "covered" claim keeps only valid cited lines and the answer shows the transcript's own words;
// nothing is stored (the run's result row holds counts only); no agenda, no transcript, a transcript too long, AI off and a reader of the meeting make no call.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdherenceModelError, AiBudgetExhaustedError, type AiMeter } from '@crove/agent';
import type { ModelPort } from '@crove/agent/member-vy';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { AdherenceAgenda } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { adherenceStatusOf, runMeetingAdherence, type MeetingBriefDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Vy checking whether a meeting covered its agenda (#3959)', () => {
  const dbName = `crove_test_adherence_ai_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
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

  // What the model was given, and everything a handler wrote to the console.
  let modelCalls = 0;
  let lastData: { agenda: Array<{ n: number; text: string }>; transcript: Array<{ n: number; t: string; text: string }> } | null = null;
  let lastSystem = '';
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    lastData = null;
    lastSystem = '';
    setSummaryEnabled(true);
  });
  const saying = (answer: (agenda: Array<{ n: number; text: string }>) => unknown): ModelPort => ({
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastSystem = prompt.system;
      lastData = JSON.parse(/<subject-[0-9a-f]+>\n([\s\S]*?)\n<\/subject-[0-9a-f]+>/.exec(prompt.user)?.[1] ?? '{}') as NonNullable<typeof lastData>;
      const body = answer(lastData.agenda);
      return { text: typeof body === 'string' ? body : JSON.stringify(body), usage: { inputTokens: 900, outputTokens: 40 } };
    },
  });
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingBriefDeps> = {}): MeetingBriefDeps => ({
    runtime,
    model: saying((agenda) => ({ items: agenda.map((a) => (a.n === 1 ? { n: 1, covered: true, lines: [2] } : { n: a.n, covered: false, lines: [] })) })),
    meter: () => meter,
    budget: new DraftBudget({ perUserPerMinute: 50, perOrgPerMinute: 200 }),
    ...over,
  });
  const check = (who: string, meetingId: string, typed: string[] = [], over: Partial<MeetingBriefDeps> = {}) => runMeetingAdherence(deps(over), orgId, asUser(who), { meetingId, typed });
  const agendaOf = (who: string, meetingId: string) => runtime.query<AdherenceAgenda>('meetings.adherence.agenda', { meetingId }, { actor: asUser(who), orgId });
  const resultRows = async () => (await sqlAdmin<{ status: string; body: string | null; error_code: string | null }>(`SELECT status, body, error_code FROM crove_kernel.member_vy_result WHERE org_id = $1 AND feature = 'meetings.adherence' ORDER BY created_at`, [orgId])).rows;

  async function meeting(title: string, startMinutes: number, series: string | null, readers: string[] = []): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $6, 'vi', $4, $5, 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365, $7)`,
      [orgId, id, users.rec, iso(startMinutes), iso(startMinutes + 60), title, series],
    );
    for (const who of readers) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[who]]);
    return id;
  }
  const line = (meetingId: string, start: number, text: string, stage = 'draft') =>
    sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, $4::numeric, $4::numeric + 5, 'Trần Văn Nam', $5, $6)`, [orgId, randomUUID(), meetingId, start, text, stage]);
  async function openItem(meetingId: string, title: string, task?: string): Promise<void> {
    let taskId: string | null = null;
    if (task !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type, status) VALUES ($1, $2, $3, 'human', 'system', $4)`, [orgId, taskId, title, task]);
    }
    await sqlAdmin(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', 'published', $6, $7, false, 10)`,
      [orgId, randomUUID(), meetingId, title, users.lan, taskId === null ? 'suggested' : 'accepted', taskId],
    );
  }
  // A series of two meetings: the earlier one with two open items and a finished one, the later one (the one to check) with a four-line draft transcript.
  async function seeded() {
    const series = randomUUID();
    const earlier = await meeting('Giao ban tuần trước', -7 * 24 * 60, series, ['lan']);
    await openItem(earlier, 'Gửi báo giá cho khách A', 'in_progress');
    await openItem(earlier, 'Chốt lịch giao hàng đợt 2');
    await openItem(earlier, 'Việc đã xong', 'done');
    const current = await meeting('Giao ban tuần này', -90, series, ['lan']);
    await line(current, 5, 'Chào mọi người, hôm nay mình rà lại việc tuần trước.');
    await line(current, 42, 'Báo giá khách A mình gửi chiều nay, khách đã đồng ý giá.');
    await line(current, 90, 'Hạn gói bảo trì tính từ ngày ký.');
    await line(current, 125, 'Hết giờ, mai họp tiếp.');
    return { series, earlier, current };
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    setSummaryEnabled(true);
    for (const key of ['owner', 'rec', 'lan', 'stranger']) users[key] = await upsertIdentity(db, { issuer: 'adherence-ai', subject: key, email: `${key}@adherence-ai.test`, name: key === 'rec' ? 'Trần Văn Nam' : key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Kiểm Tra')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.rec, users.lan, users.stranger]);
  }, 300_000);

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    setSummaryEnabled(false);
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the open items of the previous meeting of the series as the agenda and counts the transcript, for the recorder only; a finished item is left out', async () => {
    const s = await seeded();
    const own = await agendaOf('rec', s.current);
    expect(own.previous).toMatchObject({ meetingId: s.earlier, title: 'Giao ban tuần trước' });
    expect(own.items.map((i) => i.text).sort()).toEqual(['Chốt lịch giao hàng đợt 2', 'Gửi báo giá cho khách A']);
    expect(own).toMatchObject({ transcriptLines: 4, transcriptFits: true });
    // A reader of the meeting gets nothing: the agenda and the draft transcript are the recorder's.
    expect(await agendaOf('lan', s.current)).toMatchObject({ previous: null, items: [], transcriptLines: 0, transcriptFits: false });
    // A meeting outside any series has no open items, and the typed lines are the only agenda.
    const alone = await meeting('Họp lẻ', -30, null);
    expect(await agendaOf('rec', alone)).toMatchObject({ previous: null, items: [], transcriptLines: 0 });
  });

  it('checks the typed lines first and then the open items; the model sees the numbered agenda and transcript only; the answer holds the transcript\'s own words; the result row holds counts only', async () => {
    const s = await seeded();
    const before = (await resultRows()).length;
    const out = await check('rec', s.current, ['  Chốt giá gói bảo trì  ', 'gửi báo giá cho khách a']);
    expect(modelCalls).toBe(1);
    // The typed line first; the second typed line repeats an open item (case folded) and is kept once, as the typed one.
    expect(lastData?.agenda.map((a) => a.text)).toEqual(['Chốt giá gói bảo trì', 'gửi báo giá cho khách a', 'Chốt lịch giao hàng đợt 2']);
    expect(lastData?.transcript).toHaveLength(4);
    expect(lastData?.transcript[1]).toEqual({ n: 2, t: '00:42', text: 'Báo giá khách A mình gửi chiều nay, khách đã đồng ý giá.' });
    // Nothing else goes: no id, no email, no speaker, no title of the meeting.
    const given = JSON.stringify(lastData);
    for (const secret of [...Object.values(users), '@adherence-ai.test', 'Trần Văn Nam', 'Giao ban tuần']) expect(given, secret).not.toContain(secret);
    expect(lastSystem).toContain('Do not judge the people or the meeting');
    expect(out).toMatchObject({ state: 'checked', errorCode: null, reason: null, dropped: 0 });
    expect(out.items).toEqual([
      { n: 1, text: 'Chốt giá gói bảo trì', source: 'typed', covered: true, cites: [{ n: 2, startSeconds: 42, text: 'Báo giá khách A mình gửi chiều nay, khách đã đồng ý giá.' }] },
      { n: 2, text: 'gửi báo giá cho khách a', source: 'typed', covered: false, cites: [] },
      { n: 3, text: 'Chốt lịch giao hàng đợt 2', source: 'open_item', covered: false, cites: [] },
    ]);
    const rows = (await resultRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ready', body: JSON.stringify({ v: 1, agenda: 3, transcript: 4, covered: 1, dropped: 0 }) });
    expect(JSON.stringify(rows)).not.toMatch(/báo giá|bảo trì|giao hàng/iu);
    expect(logged.join('\n')).not.toMatch(/báo giá|bảo trì|giao hàng/iu);
    // Nothing of the check is stored on the meeting.
    const kept = await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2', [orgId, s.current]);
    expect(kept.rows[0]?.n).toBe('4');
  });

  it('turns a covered claim with no valid cited line into not heard and counts it; an answer that is not the object fails with a fixed code', async () => {
    const s = await seeded();
    const claims = saying((agenda) => ({ items: agenda.map((a) => ({ n: a.n, covered: true, lines: a.n === 1 ? [] : [99] })) }));
    const out = await check('rec', s.current, ['Chốt giá gói bảo trì'], { model: claims });
    expect(out.state).toBe('checked');
    expect(out.items.every((i) => !i.covered && i.cites.length === 0)).toBe(true);
    expect(out.dropped).toBe(out.items.length);
    // A transcript line that tells the model to cover everything cannot cover an item by itself: no cited line, no claim.
    const bad = await check('rec', s.current, [], { model: saying(() => 'Mục 1 đã bàn') });
    expect(bad).toMatchObject({ state: 'failed', errorCode: 'ADHERENCE_UNPARSABLE', items: [] });
    expect((await resultRows()).at(-1)).toMatchObject({ status: 'failed', error_code: 'ADHERENCE_UNPARSABLE' });
  });

  it('makes no run and no call with no agenda, no transcript or a transcript that is too long, and says why', async () => {
    const alone = await meeting('Họp lẻ không bản ghi', -30, null);
    const runs = (await resultRows()).length;
    expect(await check('rec', alone)).toMatchObject({ state: 'none', reason: 'no_agenda', items: [] });
    expect(await check('rec', alone, ['Chốt giá'])).toMatchObject({ state: 'none', reason: 'no_transcript' });
    const long = await meeting('Họp rất dài', -30, null);
    await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) SELECT $1::uuid, gen_random_uuid(), $2::uuid, g, g + 1, 'Hà', 'Một dòng ngắn ' || g, 'draft' FROM generate_series(0, 700) g`, [orgId, long]);
    expect(await check('rec', long, ['Chốt giá'])).toMatchObject({ state: 'none', reason: 'too_long' });
    expect(await agendaOf('rec', long)).toMatchObject({ transcriptLines: 701, transcriptFits: false });
    expect(modelCalls).toBe(0);
    expect((await resultRows()).length).toBe(runs);
  });

  it('refuses a reader of the meeting, AI off and no model before any call; the status says the same', async () => {
    const s = await seeded();
    expect(await refuses(check('lan', s.current, ['Chốt giá']))).toBe('FORBIDDEN');
    expect(await adherenceStatusOf(deps(), orgId, asUser('lan'), s.current)).toMatchObject({ enabled: false, reason: 'not_recorder' });
    setSummaryEnabled(false);
    expect(await refuses(check('rec', s.current, ['Chốt giá']))).toBe('ADHERENCE_OFF');
    expect(await adherenceStatusOf(deps(), orgId, asUser('rec'), s.current)).toMatchObject({ enabled: false, reason: 'off' });
    setSummaryEnabled(true);
    expect(await refuses(runMeetingAdherence({ ...deps(), model: null }, orgId, asUser('rec'), { meetingId: s.current, typed: ['Chốt giá'] }))).toBe('ADHERENCE_OFF');
    expect(await adherenceStatusOf({ ...deps(), model: null }, orgId, asUser('rec'), s.current)).toMatchObject({ enabled: false, reason: 'off' });
    const on = await adherenceStatusOf(deps(), orgId, asUser('rec'), s.current);
    expect(on).toMatchObject({ enabled: true, reason: null, estimate: { inputTokens: 30000, outputTokens: 400 } });
    // Someone who reads nothing of the meeting finds no meeting.
    expect(await refuses(check('stranger', s.current, ['Chốt giá']))).toBe('MEETING_NOT_FOUND');
    expect(modelCalls).toBe(0);
  });

  it('stores a failed result with a fixed code for a timeout, a provider failure and a spent budget, and logs no agenda or transcript text', async () => {
    const s = await seeded();
    const before = (await resultRows()).length;
    const failing = (error: unknown): ModelPort => ({ generate: async () => Promise.reject(error) });
    const timeout = await check('rec', s.current, ['Chốt giá gói bảo trì'], { model: failing(new AdherenceModelError('timeout')) });
    const failed = await check('rec', s.current, ['Chốt giá gói bảo trì'], { model: failing(new AdherenceModelError('failed')) });
    const spent = await check('rec', s.current, ['Chốt giá gói bảo trì'], { model: failing(new AiBudgetExhaustedError('org', null)) });
    expect([timeout, failed, spent].map((o) => [o.state, o.errorCode])).toEqual([
      ['failed', 'ADHERENCE_TIMEOUT'],
      ['failed', 'ADHERENCE_FAILED'],
      ['failed', 'AI_BUDGET_EXHAUSTED'],
    ]);
    expect((await resultRows()).slice(before).map((r) => [r.status, r.error_code])).toEqual([
      ['failed', 'ADHERENCE_TIMEOUT'],
      ['failed', 'ADHERENCE_FAILED'],
      ['failed', 'AI_BUDGET_EXHAUSTED'],
    ]);
    expect(logged.join('\n')).not.toMatch(/báo giá|bảo trì|giao hàng/iu);
  });
});
