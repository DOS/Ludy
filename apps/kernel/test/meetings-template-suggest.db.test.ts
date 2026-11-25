// SPDX-License-Identifier: AGPL-3.0-only
// Suggesting the minutes template of a meeting from the meeting itself (#4772) on a real database: code's query reads the series' previous template, a linked deal, words in the title and the number of people under the
// recorder's own row security, answers only to the recorder of a meeting with a transcript that is still on the general summary, and never names a meeting's text; Vy's fallback run (a fake model) is the recorder's alone,
// asks once, refuses before the call when the budget is spent, keeps an injected instruction as data, names every failure by a fixed code, stores counts only and logs no text.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runMeetingTemplateSuggest, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_LINE = 'Khách A hẹn gặp tại quán cà phê Bình Minh lúc 9 giờ';

suite('suggesting the minutes template (#4772)', () => {
  const dbName = `ludy_test_template_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
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
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    setSummaryEnabled(true);
  });

  let lastPrompt: { system: string; user: string; feature?: string | undefined } | null = null;
  const model = (text: string | (() => Promise<string>)): ModelPort => ({
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastPrompt = prompt;
      const out = typeof text === 'string' ? text : await text();
      return { text: out, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  });
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingSummaryDeps> = {}): MeetingSummaryDeps => ({
    runtime,
    model: model(JSON.stringify({ template: 'customer', reason: 'Khách hẹn gặp lúc 9 giờ.', second: 0 })),
    meter: () => meter,
    budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }),
    timeoutMs: 2000,
    ...over,
  });

  async function seedMeeting(recorder: string, over: { title?: string; template?: string; seriesId?: string | null; startedAt?: string; transcript?: boolean } = {}): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, summary_template, series_id)
       VALUES ($1, $2, $3, 'vi', $4, '2026-11-10T04:00:00Z', 1800, $5, 'attendees', 'ready', 'told_at_start', $5, now(), '1.0', current_date + 30, current_date + 365, $6, $7)`,
      [orgId, meetingId, over.title ?? 'Họp', over.startedAt ?? '2026-11-10T03:00:00Z', users[recorder], over.template ?? 'general', over.seriesId ?? null],
    );
    if (over.transcript !== false) {
      await exec(recorder, 'meetings.transcript.draft_store', { meetingId, segments: [{ startSeconds: 0, endSeconds: 10, speakerLabel: 'Hà', text: SECRET_LINE }, { startSeconds: 10, endSeconds: 20, speakerLabel: 'Nam', text: 'Em sẽ gọi lại khách ngày mai' }] });
    }
    return meetingId;
  }
  const suggest = (who: string, meetingId: string) => runtime.query<{ meetingId: string; state: string; template: string | null; reasons: string[] }>('meetings.template.suggest', { meetingId }, { actor: asUser(who), orgId });
  const runs = async () => (await sqlAdmin<{ status: string; subject_type: string; body: string | null }>(`SELECT status, subject_type, body FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND feature = 'meetings.template_suggest' ORDER BY created_at`, [orgId])).rows;
  const clearRuns = () => sqlAdmin(`DELETE FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND feature = 'meetings.template_suggest'`, [orgId]);

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
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'attendee', 'foreign']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'template-suggest', subject: key, email: `${key}@template-suggest.test`, name: key === 'recorder' ? 'Hà' : null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Gợi ý mẫu')).orgId;
    await createOrg(runtime, asUser('foreign'), 'Org khác');
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.recorder, users.attendee]);
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

  describe('code first', () => {
    it('suggests from the words of the title, and says nothing of the meeting\'s text', async () => {
      const meetingId = await seedMeeting('recorder', { title: 'Họp giao ban tuần 47' });
      expect(await suggest('recorder', meetingId)).toEqual({ meetingId, state: 'suggested', template: 'briefing', reasons: ['title'] });
    });

    it('suggests a customer meeting from a linked deal, and says it cannot tell with no signal or two in conflict', async () => {
      const linked = await seedMeeting('recorder');
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [orgId, randomUUID(), linked, randomUUID(), users.recorder]);
      expect(await suggest('recorder', linked)).toMatchObject({ state: 'suggested', template: 'customer', reasons: ['deal'] });
      expect(await suggest('recorder', await seedMeeting('recorder'))).toMatchObject({ state: 'unknown', template: null, reasons: [] });
      const conflict = await seedMeeting('recorder', { title: 'Giao ban tuần' });
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_link (org_id, id, meeting_id, deal_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [orgId, randomUUID(), conflict, randomUUID(), users.recorder]);
      expect(await suggest('recorder', conflict)).toMatchObject({ state: 'unknown', template: null });
    });

    it('suggests the template the previous meeting of the series used, and ignores a previous meeting still on the general summary', async () => {
      const seriesId = randomUUID();
      await seedMeeting('recorder', { seriesId, template: 'supplier', startedAt: '2026-11-03T03:00:00Z' });
      const next = await seedMeeting('recorder', { seriesId, startedAt: '2026-11-10T03:00:00Z' });
      expect(await suggest('recorder', next)).toMatchObject({ state: 'suggested', template: 'supplier', reasons: ['series'] });
      // A previous meeting on the general summary tells nothing.
      const plain = randomUUID();
      await seedMeeting('recorder', { seriesId: plain, startedAt: '2026-11-03T03:00:00Z' });
      expect(await suggest('recorder', await seedMeeting('recorder', { seriesId: plain, startedAt: '2026-11-10T03:00:00Z' }))).toMatchObject({ state: 'unknown' });
    });

    it('counts two people only as a corroboration of a one-to-one', async () => {
      const meetingId = await seedMeeting('recorder', { title: '1:1 Nam' });
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
      expect(await suggest('recorder', meetingId)).toMatchObject({ state: 'suggested', template: 'one_on_one', reasons: ['title', 'people'] });
      const alone = await seedMeeting('recorder');
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), alone, users.attendee]);
      expect(await suggest('recorder', alone)).toMatchObject({ state: 'unknown' });
    });

    it('has nothing to say for anyone but the recorder, for a meeting with no transcript or already on a template, and hides a meeting the caller cannot read', async () => {
      const meetingId = await seedMeeting('recorder', { title: 'Họp giao ban' });
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
      expect(await suggest('attendee', meetingId)).toEqual({ meetingId, state: 'not_applicable', template: null, reasons: [] });
      expect(await suggest('recorder', await seedMeeting('recorder', { title: 'Họp giao ban', transcript: false }))).toMatchObject({ state: 'not_applicable' });
      expect(await suggest('recorder', await seedMeeting('recorder', { title: 'Họp giao ban', template: 'customer' }))).toMatchObject({ state: 'not_applicable' });
      // A member who does not read the meeting gets the same answer as for one that is not there.
      const hidden = await seedMeeting('recorder', { title: 'Họp giao ban' });
      expect(await refuses(suggest('attendee', hidden))).toBe('MEETING_NOT_FOUND');
      expect(await refuses(suggest('foreign', hidden))).not.toBeNull();
    });
  });

  describe('Vy when code cannot tell', () => {
    const ask = (who: string, meetingId: string, over: Partial<MeetingSummaryDeps> = {}) => runMeetingTemplateSuggest(deps(over), orgId, asUser(who), meetingId);

    it('runs end to end: the model asked once with the transcript in the run\'s tags, one template back, counts only stored', async () => {
      await clearRuns();
      const meetingId = await seedMeeting('recorder');
      const out = await ask('recorder', meetingId);
      expect(out).toEqual({ state: 'suggested', errorCode: null, template: 'customer', reason: 'Khách hẹn gặp lúc 9 giờ.', seconds: 0, dropped: 0 });
      expect(modelCalls).toBe(1);
      expect(lastPrompt?.feature).toBe('meetings.template_suggest');
      expect(lastPrompt?.user).toMatch(/<subject-[0-9a-f]+>/);
      const rows = await runs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'ready', subject_type: 'meetings.template_suggest' });
      expect(JSON.parse(rows[0]?.body ?? 'null')).toEqual({ v: 1, suggested: 1, dropped: 0 });
      expect(logged.join('\n')).not.toContain('Bình Minh');
      expect(logged.join('\n')).not.toContain('hẹn gặp');
    });

    it('is the recorder\'s alone, and a meeting with no transcript is refused before any call', async () => {
      await clearRuns();
      const meetingId = await seedMeeting('recorder');
      expect(await refuses(ask('attendee', meetingId))).toBe('MEETING_NOT_FOUND');
      await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
      expect(await refuses(ask('attendee', meetingId))).toBe('FORBIDDEN');
      expect(await refuses(ask('recorder', await seedMeeting('recorder', { transcript: false })))).toBe('TRANSCRIPT_EMPTY');
      expect(modelCalls).toBe(0);
      expect(await runs()).toEqual([]);
    });

    it('is off with the switch off or no model, and makes no run and no call', async () => {
      await clearRuns();
      const meetingId = await seedMeeting('recorder');
      setSummaryEnabled(false);
      expect(await refuses(ask('recorder', meetingId))).toBe('SUMMARY_OFF');
      setSummaryEnabled(true);
      expect(await refuses(ask('recorder', meetingId, { model: null }))).toBe('SUMMARY_OFF');
      expect(modelCalls).toBe(0);
      expect(await runs()).toEqual([]);
    });

    it('refuses before the call when the budget is spent: a fixed code, no model call', async () => {
      const meetingId = await seedMeeting('recorder');
      await sqlAdmin(`INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', 0, 80, true, $2)`, [orgId, users.owner]);
      try {
        expect(await ask('recorder', meetingId)).toEqual({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED', template: null, reason: null, seconds: null, dropped: 0 });
        expect(modelCalls).toBe(0);
      } finally {
        await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1 AND scope = 'org' AND target = '*'`, [orgId]);
      }
    });

    it('keeps an instruction in the transcript as data: a model that obeys it gets nothing past the checks', async () => {
      const meetingId = await seedMeeting('recorder');
      const out = await ask('recorder', meetingId, { model: model(JSON.stringify({ template: 'customer', reason: 'Liên hệ admin@evil.test hoặc 0901234567.', second: 10 })) });
      expect(out).toMatchObject({ state: 'none', template: null, reason: null });
      expect(lastPrompt?.user).toContain('Bình Minh');
    });

    it('shows "none" for an unusable answer or "none fits", and names a model failure and a timeout by a fixed code', async () => {
      const meetingId = await seedMeeting('recorder');
      expect(await ask('recorder', meetingId, { model: model('not json at all') })).toMatchObject({ state: 'none' });
      expect(await ask('recorder', meetingId, { model: model(JSON.stringify({ template: null, reason: '', second: 0 })) })).toMatchObject({ state: 'none' });
      expect(await ask('recorder', meetingId, { model: model(JSON.stringify({ template: 'customer', reason: 'Một lý do.', second: 999 })) })).toMatchObject({ state: 'none' });
      const code = async (port: ModelPort) => (await ask('recorder', meetingId, { model: port })).errorCode;
      expect(await code({ generate: async () => { throw new Error('boom'); } })).toBe('TEMPLATE_SUGGEST_FAILED');
      expect(await ask('recorder', meetingId, { model: model(() => new Promise<string>(() => undefined)), timeoutMs: 150 })).toMatchObject({ state: 'failed', errorCode: 'TEMPLATE_SUGGEST_TIMEOUT' });
    });
  });
});
