// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworker's campaign drafts on PostgreSQL 17 (ads W1b, #2295): a member asks, a system job writes a draft with origin `ai` through the AI budget
// meter, and a request that gets no draft keeps a code that says why; nothing the member wrote reaches an audit row, an event or a log; the AI sets no money
// (the budget and the dates are the module's rules over the caps in force); the request row is held by its guard (a member only asks, only the system
// settles it, once); another org's requests are never seen. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metered, type AiUsage, type CampaignDraftRequest, type CampaignDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { AdsCampaignDraftView, AdsCampaignRequestAsked, AdsCampaignRequestView } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { addDays, adsCommands, adsQueries, todayIn } from '@crove/mod-ads';
import { failUnaskable, runAdsCampaignDraft, sweepAdsCampaignRequests, type AdsCampaignDraftJob } from '../src/ads-worker.ts';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { systemMeter } from '../src/ai-meter.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'ads' };

// What the member wrote in these tests: none of it may be found in an audit row, an event or a log.
const BRIEF = 'Quán cà phê Mộc mở thêm chi nhánh ở Quận 3 (bí mật của quán 4242), cần thêm khách vào buổi sáng';

suite('the AI coworker’s campaign drafts on PostgreSQL (ads W1b, #2295)', () => {
  const dbName = `crove_test_ads_campaign_request_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; accountId: string };
  const person = async (name: string) => (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@ads.test`, name: null })) as string;
  // An org with an ad account whose currency is read (VND, Ho Chi Minh time) and an org daily cap of 200 000 and a monthly one of 5 000 000.
  async function org(caps = true): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [adm, member, other, viewer] = [await person('admin'), await person('member'), await person('other'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, adm, member, other, viewer]);
    const connectionId = randomUUID();
    const accountId = randomUUID();
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Quảng cáo thử', $4)", [orgId, connectionId, `act-${randomUUID().slice(0, 8)}`, owner]);
    await rows("INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Tài khoản thử', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')", [orgId, accountId, connectionId, `act-${randomUUID().slice(0, 8)}`]);
    if (caps) {
      await rows("INSERT INTO crove_ads.ad_spend_cap (org_id, id, scope, period, amount, currency, set_by) VALUES ($1, $2, 'org', 'daily', '200000', 'VND', $4), ($1, $3, 'org', 'monthly', '5000000', 'VND', $4)", [orgId, randomUUID(), randomUUID(), owner]);
    }
    return { orgId, owner, admin: adm, member, other, viewer, accountId };
  }

  const ask = (o: Org, user: string, over: Record<string, unknown> = {}) =>
    rt.execute<AdsCampaignRequestAsked>('ads.campaign.draft_request', { adAccountId: o.accountId, objective: 'traffic', brief: BRIEF, ...over }, { actor: asUser(user), orgId: o.orgId });
  const requestsOf = (o: Org, user = o.member) => rt.query<AdsCampaignRequestView[]>('ads.campaign.requests', {}, { actor: asUser(user), orgId: o.orgId });
  const draftOf = (o: Org, id: string, user = o.member) => rt.query<AdsCampaignDraftView>('ads.campaign.draft', { draftId: id }, { actor: asUser(user), orgId: o.orgId });
  const jobOf = (o: Org, requestId: string): AdsCampaignDraftJob => ({ orgId: o.orgId, requestId });
  const PRICE = { inputPerMTok: '1000', outputPerMTok: '3000' };

  // What the model writes when it is well behaved: the creative part only.
  const written: CampaignDraftResult = {
    kind: 'draft',
    plan: {
      name: 'Cà phê Mộc Quận 3',
      durationDays: 7,
      targeting: { locations: [{ country: 'VN', region: 'Hồ Chí Minh' }], ageMin: 20, ageMax: 45, gender: 'all', interests: ['Cà phê'] },
      linkUrl: null,
      variants: [{ headline: 'Cà phê Mộc, chi nhánh mới', primaryText: 'Ghé quán buổi sáng, thêm một chi nhánh ở Quận 3.', callToAction: 'learn_more' }],
    },
  };
  // A stand-in for the model: what it answers, what it was asked, and the tokens it reports. The call goes through the AI budget meter's door, as the writer's
  // default generator does (#2382): the meter counts its cost and refuses it before the model is asked when the budget is spent.
  function model(answer: CampaignDraftResult | Error, usage: AiUsage = { inputTokens: 1000, outputTokens: 200 }) {
    const asked: CampaignDraftRequest[] = [];
    const writer = {
      draft: async (req: CampaignDraftRequest, onUsage?: (u: AiUsage) => void): Promise<CampaignDraftResult> => {
        await metered('ads.campaign_draft', async () => {
          asked.push(req);
          return { usage };
        });
        onUsage?.(usage);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { asked, writer };
  }
  const run = (o: Org, w: ReturnType<typeof model>['writer'], requestId: string, extra: { budget?: DraftBudget } = {}) =>
    runAdsCampaignDraft({ runtime: worker, writer: w, meter: systemMeter(worker, { price: PRICE }), ...(extra.budget ? { budget: extra.budget } : {}) }, jobOf(o, requestId));

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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...adsQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner, an admin and a member ask, a viewer none, one request waiting per member, and carries ids only in the event and the audit row', async () => {
    const o = await org();
    const asked = await ask(o, o.member);
    expect(asked).toMatchObject({ state: 'requested', code: null, draftId: null, objective: 'traffic', adAccountId: o.accountId, adAccountName: 'Tài khoản thử' });
    // The answer of asking has no brief (it is kept for a week to replay a retry); the list has it.
    expect(asked).not.toHaveProperty('brief');
    expect((await requestsOf(o)).find((r) => r.id === asked.id)).toMatchObject({ brief: BRIEF });
    await expect(ask(o, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // One waiting per member: the same member cannot pile requests up into model spend; another member can.
    await expect(ask(o, o.member)).rejects.toMatchObject({ code: 'ADS_DRAFT_REQUEST_OPEN' });
    expect((await ask(o, o.other)).state).toBe('requested');
    expect((await ask(o, o.owner)).state).toBe('requested');
    expect((await ask(o, o.admin)).state).toBe('requested');
    // An account of another org (or none) is not found, and the brief is bounded.
    await expect(ask(o, o.member, { adAccountId: randomUUID() })).rejects.toMatchObject({ code: 'ADS_ACCOUNT_NOT_FOUND' });
    await expect(ask(o, o.member, { brief: 'x'.repeat(1001) })).rejects.toBeTruthy();
    // The event the draft queue takes names the request, nothing else; the audit row has the ids, the objective and the length of the brief.
    const events = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.campaign.draft_queued' AND payload->>'requestId' = $2", [o.orgId, asked.id]);
    expect(events.map((e) => Object.keys(e.payload))).toEqual([['requestId']]);
    const audits = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.campaign.draft_request'", [o.orgId]);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.find((a) => a.detail.requestId === asked.id)?.detail).toMatchObject({ requestId: asked.id, adAccountId: o.accountId, objective: 'traffic', briefLength: BRIEF.length });
    expect(JSON.stringify([events, audits])).not.toContain('4242');
    // Members read the requests of the org; a viewer none.
    expect((await requestsOf(o)).map((r) => r.id)).toContain(asked.id);
    await expect(requestsOf(o, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets only one of two asks of the same member at the same moment through (an anti-flood rule held by the command under an advisory lock, not a money invariant)', async () => {
    const o = await org();
    // Twelve asks at once by one member: the advisory lock of the member serializes them, so the first is stored and every other one sees it waiting.
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ask(o, o.member)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(r.reason).toMatchObject({ code: 'ADS_DRAFT_REQUEST_OPEN' });
    expect((await rows<{ n: number }>("SELECT count(*)::int AS n FROM crove_ads.ad_campaign_request WHERE org_id = $1 AND requested_by = $2 AND state = 'requested'", [o.orgId, o.member]))[0]).toEqual({ n: 1 });
    // Two members at the same moment do not wait for each other: each gets their own.
    const both = await Promise.allSettled([ask(o, o.other), ask(o, o.admin)]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('writes a draft with origin ai in the name of the member who asked, through the AI budget meter, and sets no money of its own', async () => {
    const o = await org();
    const asked = await ask(o, o.member);
    const m = model(written);
    expect(await run(o, m.writer, asked.id)).toBe('written');
    // The model was asked once, with the member's words and the objective, and nothing about money or dates.
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatchObject({ objective: 'traffic', brief: BRIEF, language: 'vi' });
    const [request] = await requestsOf(o);
    expect(request).toMatchObject({ id: asked.id, state: 'written', code: null });
    const draft = await draftOf(o, request?.draftId as string);
    // The dates are the rules' (tomorrow in the account's own time zone, seven days) and the daily budget is below every cap in force: the lowest of the
    // daily cap (200 000) and the monthly cap spread over 31 days (5 000 000 / 31 = 161 290.3, rounded down to the dong).
    const tomorrow = addDays(todayIn('Asia/Ho_Chi_Minh', new Date()), 1);
    expect(draft).toMatchObject({ origin: 'ai', status: 'draft', plan: { name: 'Cà phê Mộc Quận 3', dailyBudget: '161290', startOn: tomorrow, endOn: addDays(tomorrow, 6), objective: 'traffic' }, maxSpend: '1129030', days: 7 });
    expect(draft.aiFields.sort()).toEqual(['dailyBudget', 'endOn', 'linkUrl', 'name', 'startOn', 'targeting', 'variants']);
    // The draft is the member's: created in their name, editable by them like one they wrote, and it passes no cap check wrongly.
    const [row] = await rows<{ created_by: string; origin: string }>('SELECT created_by, origin FROM crove_ads.ad_campaign_draft WHERE org_id = $1 AND id = $2', [o.orgId, draft.id]);
    expect(row).toEqual({ created_by: o.member, origin: 'ai' });
    expect(draft.issues.filter((i) => i.severity === 'error').map((i) => i.code)).not.toContain('daily_cap_exceeded');
    expect(draft.issues.filter((i) => i.severity === 'error').map((i) => i.code)).not.toContain('monthly_cap_exceeded');
    const saved = await rt.execute<AdsCampaignDraftView>('ads.campaign.draft_save', { draftId: draft.id, adAccountId: o.accountId, plan: { name: 'Tên mới', objective: 'traffic' } }, { actor: asUser(o.member), orgId: o.orgId });
    expect(saved.aiFields).not.toContain('name');
    expect(saved.aiFields).toContain('targeting');
    // The model's call was recorded by the meter as an ads usage row (the job records none of its own), and the request can be asked again.
    const usage = await rows<{ module: string; feature: string }>("SELECT module, feature FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'", [o.orgId]);
    expect(usage).toEqual([{ module: 'ads', feature: 'ads.campaign_draft' }]);
    expect((await ask(o, o.member)).state).toBe('requested');
    // Nothing the member wrote is in an audit row.
    const audits = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('ads.campaign.draft_record', 'ads.campaign.draft_request')", [o.orgId]);
    expect(JSON.stringify(audits)).not.toContain('4242');
    expect(JSON.stringify(audits)).not.toContain('Cà phê Mộc');
  });

  it('leaves the budget empty when no cap is in force, and uses the smaller of a cap spread over the month and a daily cap', async () => {
    const o = await org(false);
    const asked = await ask(o, o.member);
    expect(await run(o, model(written).writer, asked.id)).toBe('written');
    const [request] = await requestsOf(o);
    const draft = await draftOf(o, request?.draftId as string);
    expect(draft.plan.dailyBudget ?? null).toBeNull();
    expect(draft.maxSpend).toBeNull();
    expect(draft.aiFields).not.toContain('dailyBudget');
    expect(draft.issues.filter((i) => i.code === 'missing_field').map((i) => i.field)).toContain('dailyBudget');
  });

  it('says why there is no draft: the checks refused the answer, the model failed, the org is rationed, the AI budget is spent', async () => {
    const o = await org();
    const code = async (id: string) => ((await requestsOf(o)).find((r) => r.id === id) as AdsCampaignRequestView);
    // A figure the member did not give is refused whole: nothing is cut or repaired, and the member sees the code.
    const one = await ask(o, o.member);
    expect(await run(o, model({ kind: 'none', code: 'FIGURES' }).writer, one.id)).toBe('none');
    expect(await code(one.id)).toMatchObject({ state: 'none', code: 'FIGURES', draftId: null });
    // A model that fails leaves no draft and no error text anywhere; the request can be made again at once.
    const two = await ask(o, o.member);
    expect(await run(o, model(new Error('boom: the prompt said 4242')).writer, two.id)).toBe('error');
    expect(await code(two.id)).toMatchObject({ state: 'none', code: 'AI_ERROR' });
    // The per-minute budget of AI drafts of the org (ai-draft-limit.ts): the second request in the minute is refused and the member can ask again.
    const budget = new DraftBudget({ perOrgPerMinute: 1 });
    const four = await ask(o, o.member);
    expect(await run(o, model(written).writer, four.id, { budget })).toBe('written');
    const five = await ask(o, o.member);
    expect(await run(o, model(written).writer, five.id, { budget })).toBe('rate');
    expect(await code(five.id)).toMatchObject({ state: 'none', code: 'RATE_LIMITED' });
    // The AI budget of the month is spent (#2382): the meter refuses before the model is asked.
    const spent = await org();
    await rows("INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, updated_by) VALUES ($1, 'org', '*', 0, $2)", [spent.orgId, spent.owner]);
    const six = await ask(spent, spent.member);
    const refused = model(written);
    expect(await run(spent, refused.writer, six.id)).toBe('budget');
    expect(refused.asked).toHaveLength(0);
    expect(((await requestsOf(spent)).find((r) => r.id === six.id) as AdsCampaignRequestView)).toMatchObject({ state: 'none', code: 'AI_BUDGET' });
    // A request the job meets again after it was settled is gone, not written twice.
    expect(await run(o, model(written).writer, one.id)).toBe('gone');
    expect(await run(o, model(written).writer, randomUUID())).toBe('gone');
  });

  it('refuses an answer the contract refuses, as none, without storing anything', async () => {
    const o = await org();
    const asked = await ask(o, o.member);
    // A link that is not https never becomes a plan: the answer is no draft, with the code INVALID.
    const bad: CampaignDraftResult = { kind: 'draft', plan: { ...(written as Extract<CampaignDraftResult, { kind: 'draft' }>).plan, linkUrl: 'http://example.com/x' } };
    expect(await run(o, model(bad).writer, asked.id)).toBe('none');
    expect(((await requestsOf(o)).find((r) => r.id === asked.id) as AdsCampaignRequestView)).toMatchObject({ state: 'none', code: 'INVALID' });
    expect((await rows('SELECT id FROM crove_ads.ad_campaign_draft WHERE org_id = $1', [o.orgId])).length).toBe(0);
  });

  it('settles a request made where this worker has no model as none (AI_OFF), and a request nobody answered after 15 minutes as EXPIRED', async () => {
    const o = await org();
    const off = await ask(o, o.member);
    await failUnaskable(worker, jobOf(o, off.id));
    expect(((await requestsOf(o)).find((r) => r.id === off.id) as AdsCampaignRequestView)).toMatchObject({ state: 'none', code: 'AI_OFF' });
    // Asked again, it can be; one nobody answers is settled by the sweep once it is 15 minutes old (the worker login's definer, with or without a model).
    const stuck = await ask(o, o.member);
    expect(await sweepAdsCampaignRequests({ workerDb, force: true })).toBe(0);
    // The row aged past the guard that keeps requested_at (it fires for every role, replica sessions included): the test switches it off for one statement.
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_campaign_request DISABLE TRIGGER campaign_request_guard');
      try {
        await c.query("UPDATE crove_ads.ad_campaign_request SET requested_at = now() - interval '16 minutes' WHERE org_id = $1 AND id = $2", [o.orgId, stuck.id]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_campaign_request ENABLE ALWAYS TRIGGER campaign_request_guard');
      }
    });
    expect(await sweepAdsCampaignRequests({ workerDb, force: true })).toBeGreaterThanOrEqual(1);
    expect(((await requestsOf(o)).find((r) => r.id === stuck.id) as AdsCampaignRequestView)).toMatchObject({ state: 'none', code: 'EXPIRED' });
    expect((await ask(o, o.member)).state).toBe('requested');
    // The sweep is the worker login's alone.
    await expect(pool.query('SELECT crove_ads.campaign_request_sweep()')).rejects.toBeTruthy();
  });

  it('holds the row whatever path reaches it: a member only asks, only the system settles, once, and the system names an AI draft of the same account and member', async () => {
    const o = await org();
    const asked = await ask(o, o.member);
    const sqlAsMember = async (text: string, params: unknown[]) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.member, o.orgId)]);
        return await c.query(text, params);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    // A member cannot write a settled request, settle one, change the brief or delete a row (no grant), and an insert is stamped with their own name.
    await expect(sqlAsMember("INSERT INTO crove_ads.ad_campaign_request (org_id, ad_account_id, objective, brief, state, code, requested_by) VALUES ($1, $2, 'traffic', 'x', 'none', 'AI_OFF', $3)", [o.orgId, o.accountId, o.member])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    await expect(sqlAsMember("UPDATE crove_ads.ad_campaign_request SET state = 'none', code = 'AI_OFF' WHERE org_id = $1 AND id = $2", [o.orgId, asked.id])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    // The brief and the keys have no UPDATE grant for a member, and nobody has DELETE: the database refuses before the guard.
    await expect(sqlAsMember('UPDATE crove_ads.ad_campaign_request SET brief = $3 WHERE org_id = $1 AND id = $2', [o.orgId, asked.id, 'đổi'])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    await expect(sqlAsMember('DELETE FROM crove_ads.ad_campaign_request WHERE org_id = $1 AND id = $2', [o.orgId, asked.id])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    // The loosened path: the system context may insert a request of its own org (the RLS matrix's own-org control needs it and no command does), but only in
    // the name of a member of that org who may ask. A name that is no member, a member of another org, and a viewer are refused with the guard's own code.
    const stranger = await org();
    const asSystem = async (text: string, params: unknown[]) => {
      const c = await workerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
        return await c.query(text, params);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    const insert = "INSERT INTO crove_ads.ad_campaign_request (org_id, ad_account_id, objective, brief, requested_by) VALUES ($1, $2, 'traffic', 'x', $3)";
    expect((await asSystem(insert, [o.orgId, o.accountId, o.other])).rowCount).toBe(1);
    for (const [who, name] of [[randomUUID(), 'no member'], [stranger.member, 'a member of another org'], [o.viewer, 'a viewer of the org']] as const) {
      await expect(asSystem(insert, [o.orgId, o.accountId, who]), name).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    }
    // Even the database owner's own insert (no context) is born waiting.
    await expect(rows("INSERT INTO crove_ads.ad_campaign_request (org_id, ad_account_id, objective, brief, state, code, requested_by) VALUES ($1, $2, 'traffic', 'x', 'none', 'AI_OFF', $3)", [o.orgId, o.accountId, o.member])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    // Nobody but the system records the answer: a member running the command is refused by its access list.
    await expect(rt.execute('ads.campaign.draft_record', { requestId: asked.id, outcome: 'none', code: 'AI_OFF' }, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Whatever path reaches the row, even the database owner's own statement (the sweep and the purge run so), the guard holds what a written request
    // names: a draft of the same account that this member asked for with origin ai, and no other. A draft a person wrote is no AI draft.
    const human = await rt.execute<AdsCampaignDraftView>('ads.campaign.draft_save', { adAccountId: o.accountId, plan: { name: 'Của người', objective: 'traffic' } }, { actor: asUser(o.member), orgId: o.orgId });
    await expect(rows("UPDATE crove_ads.ad_campaign_request SET state = 'written', draft_id = $3 WHERE org_id = $1 AND id = $2", [o.orgId, asked.id, human.id])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    // The brief and the author never change, and a settled request never changes again.
    await expect(rows('UPDATE crove_ads.ad_campaign_request SET brief = $3 WHERE org_id = $1 AND id = $2', [o.orgId, asked.id, 'đổi'])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    expect(await run(o, model(written).writer, asked.id)).toBe('written');
    await expect(rows("UPDATE crove_ads.ad_campaign_request SET state = 'none', code = 'AI_OFF', draft_id = NULL WHERE org_id = $1 AND id = $2", [o.orgId, asked.id])).rejects.toMatchObject({ message: expect.stringContaining('ADS_REQUEST_FORBIDDEN') });
    // The system's draft is the member's, and the AI coworker is never an actor that submits: the draft only becomes a request for approval through an owner or an admin.
    const [settled] = await requestsOf(o);
    expect(settled).toMatchObject({ state: 'written' });
    await expect(rt.execute('ads.campaign.prepare_launch', { draftId: settled?.draftId }, { actor: SYSTEM, orgId: o.orgId })).rejects.toBeTruthy();
  });

  it('keeps another org’s requests out of the list and of the asks', async () => {
    const a = await org();
    const b = await org();
    const mine = await ask(a, a.member);
    expect((await requestsOf(b)).map((r) => r.id)).not.toContain(mine.id);
    await expect(ask(b, b.member, { adAccountId: a.accountId })).rejects.toMatchObject({ code: 'ADS_ACCOUNT_NOT_FOUND' });
    expect((await rows("SELECT count(*)::int AS n FROM crove_ads.ad_campaign_request WHERE org_id = $1", [b.orgId]))[0]).toEqual({ n: 0 });
  });
});
