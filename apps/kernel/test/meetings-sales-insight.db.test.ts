// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for L26 sales call insights (#4920):
//   - recorder-only access (`status`, `facts`, `start`, `runMeetingSalesInsight`), returning 404 MEETING_NOT_FOUND to all non-recorders (outsiders & attendee readers)
//   - open-deal requirement (refuses no-deal, closed deal, no-CRM, empty transcript, and live transcription cleanly with 0 model calls)
//   - AI off, kill-switch engaged, budget exhausted, and projected-cost admission refusal via memberMeter with 0 model calls
//   - deterministic checks over real DB segment IDs (#4789 contact leak + missing citations dropped), code-computed customer talk share, counts-only member_vy_result, deal untouched, and zero prose in logs
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { metered, type AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { Deal, PipelineStage, SalesInsightStatus, Transcript } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { memberMeter } from '../src/ai-meter.ts';
import { runMeetingSalesInsight, salesInsightStatusOf, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_TEXT = 'Khách hàng Hoàng Minh phản hồi phí triển khai 120 triệu hơi cao và muốn thử nghiệm vào tháng 12.';

suite('sales call insights for a meeting linked to an open deal (#4920)', () => {
  const dbName = `ludy_test_sales_insight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let noCrm: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const qry = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string; status?: number }) ?? { code: 'ERR' });

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

  let modelReply = '';
  let lastPrompt: { system: string; user: string; feature?: string | undefined; expected?: { inputTokens: number; outputTokens: number } | undefined } | null = null;
  const model: ModelPort = {
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastPrompt = prompt;
      return { text: modelReply, usage: { inputTokens: 150, outputTokens: 75 } };
    },
  };
  const noopMeter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingSummaryDeps> = {}): MeetingSummaryDeps => ({
    runtime,
    model,
    meter: () => noopMeter,
    budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }),
    timeoutMs: 2000,
    ...over,
  });

  async function seedMeeting(opts: { withTranscript?: boolean; genericSpeakers?: boolean } = {}): Promise<{ meetingId: string; segIds: [string, string, string] }> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Trao đổi báo giá CRM', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    if (opts.withTranscript === false) {
      return { meetingId, segIds: ['', '', ''] };
    }
    const spInternal = opts.genericSpeakers ? 'Người nói 1' : 'Thu Lan';
    const spCustomer = opts.genericSpeakers ? 'Người nói 2' : 'Hoàng Minh';
    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 20, speakerLabel: spInternal, text: 'Chào anh Minh, em xin trình bày gói giải pháp cho công ty mình.' },
        { startSeconds: 20, endSeconds: 50, speakerLabel: spCustomer, text: SECRET_TEXT },
        { startSeconds: 50, endSeconds: 60, speakerLabel: spInternal, text: 'Vâng, chiều nay em sẽ gửi báo giá điều chỉnh cho anh trình giám đốc. Liên hệ 0912345678 nếu cần.' },
      ],
    });
    const tr = await runtime.query<Transcript>('meetings.transcript.get', { meetingId }, { actor: asUser('recorder'), orgId });
    const ids = tr.segments.map((s) => s.id);
    return { meetingId, segIds: [ids[0]!, ids[1]!, ids[2]!] };
  }

  const createCompanyAndContact = async (companyName: string, contactName: string) => {
    const companyId = (
      await sqlAdmin<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, companyName])
    ).rows[0]!.id;
    await sqlAdmin("INSERT INTO ludy_kernel.party (org_id, name, kind, company_id) VALUES ($1, $2, 'person', $3)", [orgId, contactName, companyId]);
    return companyId;
  };
  const makeDeal = (partyId: string, title: string) => exec<Deal>('recorder', 'crm.deal.create', { partyId, title, amount: '120000000', expectedClose: '2026-12-31' });
  const linkDeal = (meetingId: string, dealId: string) => exec('recorder', 'meetings.link.add', { meetingId, kind: 'deal', targetId: dealId });

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
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries],
    });
    noCrm = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['crm'] }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'attendee', 'outsider', 'stranger']) {
      const displayName = key === 'recorder' ? 'Thu Lan' : key === 'attendee' ? 'Văn Hùng' : key;
      users[key] = await upsertIdentity(db, { issuer: 'sales-insight', subject: key, email: `${key}@sales-insight.test`, name: displayName });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty CRM Test')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [
      orgId,
      users.recorder,
      users.attendee,
      users.outsider,
    ]);
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

  it('allows recorder only, returns 404 MEETING_NOT_FOUND to all non-recorders (outsider & attendee reader), and refuses non-open-deal or empty transcript', async () => {
    const companyId = await createCompanyAndContact('Công ty Minh Tâm', 'Hoàng Minh');
    const deal = await makeDeal(companyId, 'Gói ERP Minh Tâm');
    const noTranscript = await seedMeeting({ withTranscript: false });
    // Before linking deal
    expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), noTranscript.meetingId)).toMatchObject({ available: false, reason: 'no_deal', deal: null });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('recorder'), noTranscript.meetingId))).toMatchObject({ code: 'MEETING_NO_DEAL', status: 409 });

    // Linked to open deal, but no transcript yet
    await linkDeal(noTranscript.meetingId, deal.id);
    expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), noTranscript.meetingId)).toMatchObject({ available: false, reason: 'no_transcript' });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('recorder'), noTranscript.meetingId))).toMatchObject({ code: 'TRANSCRIPT_EMPTY' });

    const { meetingId } = await seedMeeting();
    await linkDeal(meetingId, deal.id);
    expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({
      available: true,
      enabled: true,
      reason: null,
      deal: { id: deal.id, title: 'Gói ERP Minh Tâm' },
    });

    // Non-recorders in the org (both attendee reader and non-reader member) receive 404 MEETING_NOT_FOUND on status & analyze, with zero model calls.
    expect(await refuses(salesInsightStatusOf(deps(), orgId, asUser('attendee'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('attendee'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('outsider'), meetingId))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('stranger'), meetingId))).toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });

    // Deployment without CRM sees no_crm cleanly.
    expect(await noCrm.query<SalesInsightStatus>('meetings.sales_insight.status', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({
      available: false,
      reason: 'no_crm',
    });

    // Closed deal refused cleanly with 0 model calls.
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, { actor: asUser('recorder'), orgId });
    const won = stages.find((s) => s.kind === 'won')!;
    await exec('recorder', 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: won.id });
    expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ available: false, reason: 'deal_closed' });
    expect(await refuses(runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId))).toMatchObject({ code: 'DEAL_CLOSED', status: 409 });
    expect(modelCalls).toBe(0);
  });

  it('refuses AI off, kill switch paused, spent budget, and projected-cost overflow with clear reasons and 0 model calls', async () => {
    const companyId = await createCompanyAndContact('Công ty Sao Mai', 'Anh Tuấn');
    const deal = await makeDeal(companyId, 'Gói Kế toán Sao Mai');
    const { meetingId } = await seedMeeting();
    await linkDeal(meetingId, deal.id);

    // 1. AI off (deployment switch & null model)
    setSummaryEnabled(false);
    // Even with AI off, start refuses non-recorders with 404 MEETING_NOT_FOUND before SUMMARY_OFF.
    expect(await refuses(exec('attendee', 'meetings.sales_insight.start', { meetingId }))).toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });
    expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ available: true, enabled: false, reason: 'off' });
    expect(await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ state: 'off', errorCode: 'SUMMARY_OFF', concerns: [] });
    setSummaryEnabled(true);
    expect(await runMeetingSalesInsight(deps({ model: null }), orgId, asUser('recorder'), meetingId)).toMatchObject({ state: 'off', errorCode: 'SUMMARY_OFF' });
    expect(modelCalls).toBe(0);

    // 2. Kill switch engaged on module 'meetings'
    const engaged = await runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' }, { actor: asMfa('owner'), orgId });
    try {
      expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ available: true, enabled: false, reason: 'paused' });
      expect(await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ state: 'paused', errorCode: 'AI_STOPPED' });
      expect(modelCalls).toBe(0);
    } finally {
      await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa('owner'), orgId });
    }

    // 3. Budget exhausted at 0 limit
    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0', 80, true, $2)`,
      [orgId, users.owner],
    );
    try {
      expect(await salesInsightStatusOf(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ available: true, enabled: false, reason: 'budget' });
      expect(await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId)).toMatchObject({ state: 'budget', errorCode: 'AI_BUDGET_EXHAUSTED' });
      expect(modelCalls).toBe(0);
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }

    // 4. Projected-cost admission refusal via real memberMeter: remaining budget > 0, yet spent + projectedCost >= limit -> admits fails before calling provider model.
    const meteredModel: ModelPort = {
      generate: async (_who, prompt) =>
        metered(
          'meetings.sales_insight',
          async () => {
            modelCalls += 1;
            return { text: modelReply, usage: { inputTokens: 150, outputTokens: 75 } };
          },
          undefined,
          prompt.expected,
        ),
    };
    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', '0.000500', 80, true, $2)`,
      [orgId, users.owner],
    );
    try {
      const meteredResult = await runMeetingSalesInsight(
        deps({
          model: meteredModel,
          meter: (actor) => memberMeter(runtime, actor, { price: { inputPerMTok: '3.00', outputPerMTok: '15.00' } }),
        }),
        orgId,
        asUser('recorder'),
        meetingId,
      );
      expect(meteredResult).toMatchObject({ state: 'budget', errorCode: 'AI_BUDGET_EXHAUSTED', concerns: [], buyingSignals: [], nextSteps: [] });
      expect(modelCalls).toBe(0);
    } finally {
      await sqlAdmin('DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }
  });

  it('extracts cited insights + customer talk share, drops leaked contacts/invalid citations, stores counts only, leaves deal untouched, and logs no prose', async () => {
    const companyId = await createCompanyAndContact('Công ty Bình An', 'Hoàng Minh');
    const deal = await makeDeal(companyId, 'Gói Phần Mềm Bình An');
    const { meetingId, segIds } = await seedMeeting();
    await linkDeal(meetingId, deal.id);
    const dealBefore = await qry<Deal>('recorder', 'crm.deal.get', { dealId: deal.id });

    modelReply = JSON.stringify({
      concerns: [
        { text: 'Khách lo ngại phí triển khai 120 triệu hơi cao.', lineIds: [segIds[1]] },
        // Leaked phone from uncited segIds[2] cited only as segIds[1] -> dropped!
        { text: 'Gọi lại số 0912345678 để thương lượng.', lineIds: [segIds[1]] },
      ],
      buyingSignals: [
        { text: 'Khách muốn thử nghiệm vào tháng 12.', lineIds: [segIds[1]] },
        // Missing citation -> dropped!
        { text: 'Sẽ ký ngay.', lineIds: ['missing-line-id'] },
      ],
      nextSteps: [{ text: 'Gửi báo giá điều chỉnh trong chiều nay.', owner: 'Thu Lan', lineIds: [segIds[2]] }],
    });

    const out = await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId);
    expect(modelCalls).toBe(1);
    expect(lastPrompt?.feature).toBe('meetings.sales_insight');
    expect(lastPrompt?.expected?.inputTokens).toBeGreaterThan(0);
    expect(out.state).toBe('ready');
    expect(out.errorCode).toBeNull();
    expect(out.dropped).toBe(2);
    expect(out.concerns).toEqual([
      { text: 'Khách lo ngại phí triển khai 120 triệu hơi cao.', citations: [{ lineId: segIds[1], seconds: 20, speakerLabel: 'Hoàng Minh' }] },
    ]);
    expect(out.buyingSignals).toEqual([
      { text: 'Khách muốn thử nghiệm vào tháng 12.', citations: [{ lineId: segIds[1], seconds: 20, speakerLabel: 'Hoàng Minh' }] },
    ]);
    expect(out.nextSteps).toEqual([
      { text: 'Gửi báo giá điều chỉnh trong chiều nay.', owner: 'Thu Lan', citations: [{ lineId: segIds[2], seconds: 50, speakerLabel: 'Thu Lan' }] },
    ]);
    // 30s customer out of 60s total = 50%
    expect(out.customerTalkShare).toEqual({
      customerPercent: 50,
      internalPercent: 50,
      customerSeconds: 30,
      totalSeconds: 60,
      customerSpeakers: ['Hoàng Minh'],
    });

    // Deal row and CRM tasks/activities were NEVER touched.
    const dealAfter = await qry<Deal>('recorder', 'crm.deal.get', { dealId: deal.id });
    expect(dealAfter.version).toBe(dealBefore.version);
    const crmTasks = await sqlAdmin('SELECT id FROM ludy_kernel.task WHERE org_id = $1 AND source_ref ->> \'id\' = $2', [orgId, meetingId]);
    expect(crmTasks.rows).toHaveLength(0);

    // member_vy_result stores counts only under an ephemeral random subject (not meetingId).
    const meetingRows = await sqlAdmin('SELECT id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2', [orgId, meetingId]);
    expect(meetingRows.rows).toHaveLength(0);
    const ephemeralRows = await sqlAdmin<{ body: string | null; status: string }>(
      `SELECT r.body, r.status FROM ludy_kernel.member_vy_result r JOIN ludy_kernel.ai_run a ON a.org_id = r.org_id AND a.id = r.run_id WHERE r.org_id = $1 AND a.feature = 'meetings.sales_insight'`,
      [orgId],
    );
    expect(ephemeralRows.rows.some((r) => r.status === 'ready' && r.body === JSON.stringify({ v: 1, concerns: 1, buyingSignals: 1, nextSteps: 1, dropped: 2 }))).toBe(true);

    // Generic speaker labels yield null customerTalkShare cleanly.
    const generic = await seedMeeting({ genericSpeakers: true });
    await linkDeal(generic.meetingId, deal.id);
    modelReply = JSON.stringify({ concerns: [{ text: 'Khách lo ngại phí triển khai 120 triệu hơi cao.', lineIds: [generic.segIds[1]] }], buyingSignals: [], nextSteps: [] });
    const genericOut = await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), generic.meetingId);
    expect(genericOut.customerTalkShare).toBeNull();

    // Unparsable model output returns 'none' cleanly while preserving code-computed customerTalkShare.
    modelReply = 'không phải JSON';
    const unparsableOut = await runMeetingSalesInsight(deps(), orgId, asUser('recorder'), meetingId);
    expect(unparsableOut).toMatchObject({
      state: 'none',
      errorCode: null,
      concerns: [],
      buyingSignals: [],
      nextSteps: [],
      customerTalkShare: { customerPercent: 50, internalPercent: 50 },
    });

    // No transcript or insight prose leaked to console logs.
    expect(logged.join('\n')).not.toContain('Hoàng Minh');
    expect(logged.join('\n')).not.toContain('120 triệu');
  });
});
