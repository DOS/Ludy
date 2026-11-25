// SPDX-License-Identifier: AGPL-3.0-only
// Vy's brief before a meeting (#3543, plan row L7, builds on the series of #3542) on a real database with a fake model: the facts (the decisions of the previous meeting of the series, the series' open
// items, the linked customer's open deals with their stage) are read as the member, so a member who did not read the previous meeting gets none of it; they work with AI off; Vy's sentences go through
// the member's own run and meter, cite numbered facts, and a sentence whose figure no cited fact writes is dropped; with nothing to say there is no brief, no run and no call; and nothing of a fact
// or a sentence is stored (the run's result row holds counts only) or logged.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, BriefModelError, type AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { briefLines, type BriefFacts, type BriefStatus, type Deal, type PipelineStage } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { briefStatusOf, runMeetingBrief, type MeetingBriefDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite("Vy's brief before a meeting (#3543)", () => {
  const dbName = `ludy_test_brief_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let noCrm: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const facts = (who: string, target: { meetingId?: string; agendaId?: string }, rt: Runtime = runtime) =>
    rt.query<BriefFacts>('meetings.brief.facts', { meetingId: target.meetingId ?? null, agendaId: target.agendaId ?? null }, { actor: asUser(who), orgId });
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
  const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

  // What the model was given and what it said, and everything a handler wrote to the console.
  let modelCalls = 0;
  let lastData: { facts: Array<{ n: number; kind: string; text: string }> } | null = null;
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    lastData = null;
    setSummaryEnabled(true);
  });
  const answering = (pick: (facts: Array<{ n: number; kind: string; text: string }>) => Array<{ text: string; cites: unknown[] }>): ModelPort => ({
    generate: async (_who, prompt) => {
      modelCalls += 1;
      const data = /<subject-[0-9a-f]+>\n([\s\S]*?)\n<\/subject-[0-9a-f]+>/.exec(prompt.user)?.[1] ?? '{}';
      lastData = JSON.parse(data) as NonNullable<typeof lastData>;
      return { text: JSON.stringify({ sentences: pick(lastData.facts) }), usage: { inputTokens: 100, outputTokens: 60 } };
    },
  });
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingBriefDeps> = {}): MeetingBriefDeps => ({
    runtime,
    model: answering((f) => [{ text: 'Có một điều đã chốt.', cites: [f[0]?.n] }]),
    meter: () => meter,
    budget: new DraftBudget({ perUserPerMinute: 50, perOrgPerMinute: 200 }),
    ...over,
  });
  const brief = (who: string, target: { meetingId?: string; agendaId?: string }, over: Partial<MeetingBriefDeps> = {}) =>
    runMeetingBrief(deps(over), orgId, asUser(who), { meetingId: target.meetingId ?? null, agendaId: target.agendaId ?? null });
  const resultRows = async () =>
    (await sqlAdmin<{ status: string; body: string | null; error_code: string | null }>(`SELECT status, body, error_code FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND feature = 'meetings.brief' ORDER BY created_at`, [orgId])).rows;

  async function meeting(recorder: string, title: string, startMinutes: number, readers: string[], series: string | null): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $6, 'vi', $4, $5, 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365, $7)`,
      [orgId, id, users[recorder], iso(startMinutes), iso(startMinutes + 60), title, series],
    );
    for (const who of readers) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[who]]);
    return id;
  }
  const publish = (meetingId: string, decisions: string[]) =>
    sqlAdmin(`INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, 'Tóm tắt buổi họp', $3::jsonb, 'manual', 'published')`, [orgId, meetingId, JSON.stringify(decisions)]);
  async function item(meetingId: string, title: string, task?: string): Promise<void> {
    let taskId: string | null = null;
    if (task !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status) VALUES ($1, $2, $3, 'human', 'system', $4)`, [orgId, taskId, title, task]);
    }
    await sqlAdmin(
      `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', 'published', $6, $7, false, 10)`,
      [orgId, randomUUID(), meetingId, title, users.lan, taskId === null ? 'suggested' : 'accepted', taskId],
    );
  }
  const party = (name: string) => sqlAdmin<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => r.rows[0]!.id);
  const linkParty = (meetingId: string, partyId: string) =>
    sqlAdmin("INSERT INTO ludy_meetings.meeting_link (org_id, meeting_id, party_id, created_by) VALUES ($1, $2, $3, $4)", [orgId, meetingId, partyId, users.rec]);
  async function deal(partyId: string, title: string, amount: string, won = false): Promise<Deal> {
    const created = await exec<Deal>('rec', 'crm.deal.create', { partyId, title, amount, expectedClose: '2026-12-31' });
    if (!won) return created;
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, { actor: asUser('rec'), orgId });
    const wonStage = stages.find((s) => s.kind === 'won') as PipelineStage;
    return exec<Deal>('rec', 'crm.deal.move', { dealId: created.id, version: created.version, stageId: wonStage.id });
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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries] });
    // A deployment without the CRM module: its queries answer "not installed", and a customer is shown with no deals.
    noCrm = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['crm'] }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    setSummaryEnabled(true);
    for (const key of ['owner', 'rec', 'lan', 'nam', 'other']) users[key] = await upsertIdentity(db, { issuer: 'brief', subject: key, email: `${key}@brief.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Chuẩn bị')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.rec, users.lan, users.nam, users.other]);
    await exec('rec', 'crm.pipeline.setup', {});
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

  // One series with a customer: the previous meeting (read by lan and nam when `readers` says so), its decisions, open and finished items, and the customer's open and won deals.
  async function seeded(readers: string[]) {
    const series = randomUUID();
    const earlier = await meeting('rec', 'Giao ban tuần trước', -7 * 24 * 60, readers, series);
    const current = await meeting('rec', 'Giao ban tuần này', -10, ['lan', 'nam'], series);
    await publish(earlier, ['Chốt giá gói kế toán 15.000.000 đồng', 'Gửi hợp đồng trước thứ sáu']);
    await item(earlier, 'Gửi báo giá bản cuối', 'in_progress');
    await item(earlier, 'Việc đã xong', 'done');
    await item(earlier, 'Chưa ai nhận việc này');
    const customer = await party('Công ty Á Châu');
    await linkParty(earlier, customer);
    const open = await deal(customer, 'Gói kế toán năm', '15000000');
    const won = await deal(customer, 'Gói cũ đã chốt', '9000000', true);
    return { series, earlier, current, customer, open, won };
  }

  it('reads the decisions, the open items and the linked customer\'s open deals with their stage, each as the member reads them; a won deal and a finished item are left out', async () => {
    const s = await seeded(['lan', 'nam']);
    const out = await facts('lan', { meetingId: s.current });
    expect(out.previous).toMatchObject({ meetingId: s.earlier, title: 'Giao ban tuần trước' });
    expect(out.decisions).toEqual(['Chốt giá gói kế toán 15.000.000 đồng', 'Gửi hợp đồng trước thứ sáu']);
    expect(out.items.map((i) => [i.title, i.assigned]).sort()).toEqual([
      ['Chưa ai nhận việc này', false],
      ['Gửi báo giá bản cuối', true],
    ]);
    expect(out.customer).toEqual({ partyId: s.customer, name: 'Công ty Á Châu' });
    expect(out.deals).toEqual([{ id: s.open.id, title: 'Gói kế toán năm', stage: 'Mới', amount: '15000000.00', expectedClose: '2026-12-31' }]);
    expect(out.empty).toBe(false);
    // The numbered lines are the same on both sides: decisions, items, deals, each with its source.
    const lines = briefLines(out);
    expect(lines.map((l) => l.kind)).toEqual(['decision', 'decision', 'item', 'item', 'deal']);
    expect(lines.at(-1)).toMatchObject({ n: 5, source: { type: 'deal', id: s.open.id } });
    expect(lines.at(-1)?.text).toContain('amount: 15.000.000 VND');
    expect(lines[0]?.source).toEqual({ type: 'meeting', id: s.earlier });
  });

  it('shows a member who did not read the previous meeting none of it: no decision, no item, no customer and no deal, so no brief', async () => {
    const s = await seeded(['lan']);
    const seen = await facts('nam', { meetingId: s.current });
    expect(seen).toEqual({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true });
    expect(JSON.stringify(seen)).not.toMatch(/Chốt giá|hợp đồng|báo giá|Á Châu|Gói/);
    // Nor does Vy get anything to write from: no run, no call.
    const runs = (await resultRows()).length;
    expect(await brief('nam', { meetingId: s.current })).toEqual({ state: 'none', errorCode: null, sentences: [], dropped: 0 });
    expect(modelCalls).toBe(0);
    expect((await resultRows()).length).toBe(runs);
    expect((await facts('lan', { meetingId: s.current })).decisions).toHaveLength(2);
  });

  it('prepares an upcoming calendar event of the member\'s own agenda, from the series of the event; another member\'s event is not found', async () => {
    const s = await seeded(['lan', 'nam']);
    // The meeting of this week is not recorded yet: the event is what comes after the previous one.
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, s.current]);
    const connection = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, 'google', 'lan@calendar.test', 'lan', '{}', true)`, [orgId, connection, users.lan]);
    const agenda = (await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, series_id)
       VALUES ($1, $2, $3, $4, 'Giao ban', $5, $6, 'Asia/Ho_Chi_Minh', $7) RETURNING id`,
      [orgId, connection, users.lan, randomUUID(), iso(60), iso(120), s.series],
    )).rows[0]!.id;
    const out = await facts('lan', { agendaId: agenda });
    expect(out.previous?.meetingId).toBe(s.earlier);
    expect(out.decisions).toHaveLength(2);
    expect(out.customer?.partyId).toBe(s.customer);
    expect(await refuses(facts('nam', { agendaId: agenda }))).toBe('AGENDA_NOT_FOUND');
  });

  it('takes the customer of the meeting itself before the one of the previous meeting, and shows the customer with no deals where the deployment has no CRM', async () => {
    const s = await seeded(['lan', 'nam']);
    const other = await party('Công ty Hải Phòng');
    await linkParty(s.current, other);
    const out = await facts('lan', { meetingId: s.current });
    expect(out.customer).toEqual({ partyId: other, name: 'Công ty Hải Phòng' });
    expect(out.deals).toEqual([]);
    const without = await facts('lan', { meetingId: s.current }, noCrm);
    expect(without.customer?.partyId).toBe(other);
    expect(without.deals).toEqual([]);
    const previousOnly = await seeded(['lan']);
    expect((await facts('lan', { meetingId: previousOnly.current }, noCrm)).deals).toEqual([]);
  });

  it('has no brief for a meeting in no series with no linked customer, or whose series has nothing open: no run and no call', async () => {
    const alone = await meeting('rec', 'Họp một mình', -10, ['lan'], null);
    expect(await facts('lan', { meetingId: alone })).toEqual({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true });
    const series = randomUUID();
    const first = await meeting('rec', 'Buổi trước trống', -3 * 24 * 60, ['lan'], series);
    const second = await meeting('rec', 'Buổi sau', -10, ['lan'], series);
    await item(first, 'Việc đã xong rồi', 'done');
    const out = await facts('lan', { meetingId: second });
    expect(out).toMatchObject({ decisions: [], items: [], customer: null, deals: [], empty: true });
    expect(await brief('lan', { meetingId: second })).toMatchObject({ state: 'none' });
    expect(modelCalls).toBe(0);
  });

  it('has the member\'s own Vy write sentences that cite the facts they were given; a sentence with a number or an amount no cited fact writes is dropped; only counts are stored; nothing is logged', async () => {
    const s = await seeded(['lan', 'nam']);
    const runs = (await resultRows()).length;
    const out = await brief('lan', { meetingId: s.current }, {
      model: answering((f) => [
        { text: 'Buổi trước đã chốt giá gói kế toán 15.000.000 đồng.', cites: [f[0]?.n] },
        { text: 'Khách còn một cơ hội giá 20.000.000 đồng.', cites: [f.at(-1)?.n] },
        { text: 'Còn việc chưa giao cho ai.', cites: [f.find((x) => x.kind === 'item' && x.text.includes('Chưa ai nhận'))?.n] },
        { text: 'Một câu không dẫn nguồn.', cites: [] },
      ]),
    });
    expect(out.state).toBe('written');
    expect(out.sentences.map((x) => x.text)).toEqual(['Buổi trước đã chốt giá gói kế toán 15.000.000 đồng.', 'Còn việc chưa giao cho ai.']);
    expect(out.dropped).toBe(2);
    expect(modelCalls).toBe(1);
    // The model got the numbered facts the member can see, and nothing else (no title of a meeting, no id).
    expect(lastData?.facts.map((f) => f.kind)).toEqual(['decision', 'decision', 'item', 'item', 'deal']);
    expect(JSON.stringify(lastData)).not.toContain('Giao ban tuần');
    // Counts only: no fact and no sentence is stored, and the console holds none.
    const rows = (await resultRows()).slice(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(JSON.parse(rows[0]?.body ?? '{}')).toEqual({ v: 1, facts: 5, sentences: 2, dropped: 2 });
    expect(JSON.stringify(rows)).not.toContain('15.000.000');
    expect(logged.join('\n')).not.toMatch(/15\.000\.000|Gói kế toán|Á Châu|chưa giao/);
  });

  it('works with AI off: the facts still come, the button says off, and no run or call is made; a spent budget or a refusing meter leaves the facts list', async () => {
    const s = await seeded(['lan', 'nam']);
    setSummaryEnabled(false);
    expect(await briefStatusOf({ runtime, price: undefined, model: deps().model, meter: () => meter }, orgId, asUser('lan'))).toMatchObject({ enabled: false, reason: 'off' });
    expect((await facts('lan', { meetingId: s.current })).empty).toBe(false);
    const runs = (await resultRows()).length;
    expect(await refuses(brief('lan', { meetingId: s.current }))).toBe('BRIEF_OFF');
    expect(await refuses(brief('lan', { meetingId: s.current }, { model: null }))).toBe('BRIEF_OFF');
    expect(modelCalls).toBe(0);
    expect((await resultRows()).length).toBe(runs);
    setSummaryEnabled(true);
    const status = await briefStatusOf({ runtime, price: undefined, model: deps().model, meter: () => meter }, orgId, asUser('lan'));
    expect(status).toMatchObject({ enabled: true, reason: null } satisfies Partial<BriefStatus>);
    // The meter refuses (the month's budget is spent): the answer is a fixed code, the run is closed as failed, and the member keeps the facts.
    const out = await brief('lan', { meetingId: s.current }, { model: { generate: async () => { throw new AiBudgetExhaustedError('org', null); } } });
    expect(out).toMatchObject({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED', sentences: [] });
    expect((await resultRows()).at(-1)).toMatchObject({ status: 'failed', error_code: 'AI_BUDGET_EXHAUSTED' });
    // A model that times out or fails closes the run as failed with a fixed code; the member keeps the facts and nothing of the facts is logged.
    const timedOut = await brief('lan', { meetingId: s.current }, { model: { generate: async () => { throw new BriefModelError('timeout'); } } });
    expect(timedOut).toMatchObject({ state: 'failed', errorCode: 'BRIEF_TIMEOUT', sentences: [] });
    expect((await resultRows()).at(-1)).toMatchObject({ status: 'failed', error_code: 'BRIEF_TIMEOUT' });
    const broken = await brief('lan', { meetingId: s.current }, { model: { generate: async () => { throw new BriefModelError('failed'); } } });
    expect(broken).toMatchObject({ state: 'failed', errorCode: 'BRIEF_FAILED' });
    expect(logged.join('\n')).not.toMatch(/15\.000\.000|Gói kế toán|Á Châu/);
  });

  it('lets a newer brief of the same member replace one still running: the old one is stopped and shows none of its text', async () => {
    const s = await seeded(['lan', 'nam']);
    let release: () => void = () => undefined;
    const slow: ModelPort = { generate: () => new Promise((resolve) => { release = () => resolve({ text: JSON.stringify({ sentences: [{ text: 'Buổi trước đã chốt giá gói kế toán 15.000.000 đồng.', cites: [1] }] }), usage: { inputTokens: 1, outputTokens: 1 } }); }) };
    const first = brief('lan', { meetingId: s.current }, { model: slow });
    await new Promise((r) => setTimeout(r, 400));
    expect(await brief('lan', { meetingId: s.current })).toMatchObject({ state: 'written' });
    release();
    // The kernel kept one live run per feature: the older run was ended, so its words are not shown.
    expect(await first).toEqual({ state: 'failed', errorCode: 'AI_STOPPED', sentences: [], dropped: 0 });
  });
});
