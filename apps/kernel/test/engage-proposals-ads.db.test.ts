// SPDX-License-Identifier: AGPL-3.0-only
// The Ads twins an AI coworker asks with (epic #3857, E4, issue #3863; ADR-0051 decision 10; docs/plan/ads-write.md section 3.1): stopping a launch, the kill switch, and pausing, archiving, lowering the budget
// of or shortening a running ad, and cancelling a waiting change that would raise spend (#4181). Only what STOPS or REDUCES spend has a twin. For each: the call leaves one pending, tainted proposal and changes nothing; a rejection changes nothing, ever; an approval runs the
// original command once, as the approver, with every check it has judged then, on what stands then; a proposal the original refuses stays pending. The fixture is the live launch the invariants of the changes of a
// running ad build (apps/kernel/test/invariant/ads-manage.db.test.ts), copied here: a launch of 100 000 a day that began three days ago and ends in ten, with its campaign, ad set and one ad recorded.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, ENGAGE_SCOPE, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const HASH = `sha256:${'a'.repeat(64)}`;
const ZONE = 'Asia/Ho_Chi_Minh';
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Rig {
  launch: string;
  account: string;
  end: string;
}
interface Case {
  twin: string;
  original: string;
  kind: string;
}

suite('the Ads proposal twins (#3863)', () => {
  let h: Harness;
  let today = '';
  const D = (n: number) => addDays(today, n);
  beforeAll(async () => {
    h = await startHarness('engage_ads');
    today = (await h.q<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]?.d as string;
    // Running ads on for the org: the table's guard asks a signed-in owner for that opening, so it is set aside for the statement, as the fixture of the invariants does for a launch.
    await withoutGuard('ludy_ads.ad_org_setting', 'switch_guard', async (c) => {
      await c.query('INSERT INTO ludy_ads.ad_org_setting (org_id, write_enabled, launches_blocked) VALUES ($1, true, false) ON CONFLICT DO NOTHING', [h.orgId]);
      await c.query('UPDATE ludy_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [h.orgId]);
    });
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  // A statement with one trigger of a table set aside, then ENABLE ALWAYS again (a guard that fires for every role).
  async function withoutGuard(table: string, trigger: string | readonly string[], fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = new pg.Client({ connectionString: h.adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      const triggers = typeof trigger === 'string' ? [trigger] : trigger;
      for (const t of triggers) await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${t}`);
      await fn(c);
      for (const t of triggers) await c.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${t}`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }

  // A live launch of 100 000 a day (begun three days ago, ending in ten) in an account in Vietnam's zone with running ads on, with the campaign, the ad set and one ad recorded.
  async function rig(): Promise<Rig> {
    const connection = randomUUID();
    const account = randomUUID();
    await h.q(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`, [h.orgId, connection, `acct-${connection.slice(0, 8)}`, h.owner]);
    await h.q(`INSERT INTO ludy_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Thử', '2025-10-01', 'VND', $5)`, [h.orgId, account, connection, `acct-${connection.slice(0, 8)}`, ZONE]);
    // The account's write connection (an active one of the write twin's provider) and its switch: each has a guard of its own that asks a signed-in owner, set aside for the one statement.
    const write = randomUUID();
    await h.q(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandboxwrite_ads', $3, 'Thử ghi', '{}', $4)`, [h.orgId, write, `acct-${connection.slice(0, 8)}`, h.owner]);
    await withoutGuard('ludy_ads.ad_account', ['switch_guard', 'write_connection_guard'], async (c) => {
      await c.query('UPDATE ludy_ads.ad_account SET write_enabled = true, write_connection_id = $3 WHERE org_id = $1 AND id = $2', [h.orgId, account, write]);
    });
    const draft = randomUUID();
    await h.q(`INSERT INTO ludy_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [h.orgId, draft, account, h.owner]);
    const launch = randomUUID();
    const end = D(10);
    await h.q(
      `INSERT INTO ludy_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, '1400000', $8, $9, 'queued')`,
      [h.orgId, launch, account, draft, randomUUID(), HASH, D(-3), end, h.owner],
    );
    // queued -> launching is the system's step (the launch guard asks for the worker's context), so the guard is set aside for it and for the move to live, as the invariants' fixture does for the latter.
    await withoutGuard('ludy_ads.ad_launch', 'launch_guard', async (c) => {
      await c.query(`UPDATE ludy_ads.ad_launch SET state = 'launching', step = 'campaign' WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
    });
    const tag = (await h.q<{ tag: string }>(`SELECT tag FROM ludy_ads.ad_launch WHERE org_id = $1 AND id = $2`, [h.orgId, launch])).rows[0]?.tag as string;
    const ids = { campaign: `cmp-${launch.slice(0, 8)}`, ad_set: `set-${launch.slice(0, 8)}`, ad_1: `ad1-${launch.slice(0, 8)}` };
    for (const [slot, level] of [['campaign', 'campaign'], ['ad_set', 'ad_set'], ['ad_1', 'ad']] as const) {
      await h.q(`INSERT INTO ludy_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [h.orgId, account, launch, slot, level, ids[slot], `Thử ${tag} ${slot}`]);
    }
    await withoutGuard('ludy_ads.ad_launch', 'launch_guard', async (c) => {
      expect((await c.query(`UPDATE ludy_ads.ad_launch SET state = 'live', step = 'live' WHERE org_id = $1 AND id = $2`, [h.orgId, launch])).rowCount).toBe(1);
    });
    return { launch, account, end };
  }

  const launchRow = async (launch: string) => (await h.q<{ state: string; commit_until: string | null; daily_budget: string }>(`SELECT state, commit_until::text AS commit_until, daily_budget::text AS daily_budget FROM ludy_ads.ad_launch WHERE org_id = $1 AND id = $2`, [h.orgId, launch])).rows[0] as { state: string; commit_until: string | null; daily_budget: string };
  const changes = async (launch: string, kind?: string) =>
    (await h.q<{ kind: string; slot: string; state: string; from_budget: string | null; to_budget: string | null; to_end_on: string | null }>(
      `SELECT kind, slot, state, from_budget::text AS from_budget, to_budget::text AS to_budget, to_end_on::text AS to_end_on FROM ludy_ads.ad_manage_change WHERE org_id = $1 AND launch_id = $2 AND ($3::text IS NULL OR kind = $3) ORDER BY created_at, id`,
      [h.orgId, launch, kind ?? null],
    )).rows;
  const blocked = async () => (await h.q<{ b: boolean }>('SELECT launches_blocked AS b FROM ludy_ads.ad_org_setting WHERE org_id = $1', [h.orgId])).rows[0]?.b as boolean;
  const proposalsOf = async (twin: string) => (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM ludy_kernel.proposal WHERE org_id = $1 AND command = $2', [h.orgId, twin])).rows[0]?.n ?? 0;
  const asked = async (twin: string, payload: Record<string, unknown>) => {
    const { actor } = await h.grant();
    return h.propose(actor, twin, payload);
  };

  // The three steps every twin with a plain payload goes through. `effect` is what the original leaves behind on the launch (the queued change's rows of the kind, the stopped state).
  async function lifecycle(c: Case, payload: (r: Rig) => Record<string, unknown>, effects: (r: Rig) => Promise<number>) {
    // (a) Proposal only.
    const r = await rig();
    const sent = payload(r);
    const before = await launchRow(r.launch);
    const ranBefore = await h.ran(c.original);
    const made = await asked(c.twin, sent);
    expect(made.status).toBe('pending');
    const row = await h.proposal(made.proposalId);
    expect(row).toMatchObject({ status: 'pending', command: c.twin, kind: c.kind, tainted: true, payload: sent });
    expect(row.requested_by_grant).not.toBeNull();
    expect(await h.ran(c.original)).toBe(ranBefore);
    expect(await launchRow(r.launch)).toEqual(before);
    expect(await effects(r)).toBe(0);
    expect(await h.q('SELECT 1 FROM ludy_kernel.proposal WHERE org_id = $1 AND command = $2 AND payload @> $3::jsonb', [h.orgId, c.twin, JSON.stringify(sent)]).then((x) => x.rowCount)).toBe(1);

    // (b) Approved: the original runs once, as the person, and the proposal is executed.
    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    expect(await effects(r)).toBe(1);
    // A second approval finds nothing to approve: no second effect.
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    expect(await effects(r)).toBe(1);

    // (c) Rejected: the original never runs, and a later approval is refused.
    const other = await rig();
    const sentOther = payload(other);
    const rejected = await asked(c.twin, sentOther);
    await h.reject(rejected.proposalId);
    expect((await h.proposal(rejected.proposalId)).status).toBe('rejected');
    expect(await h.executions(c.original, rejected.proposalId)).toBe(0);
    expect(await effects(other)).toBe(0);
    await expect(h.approve(rejected.proposalId)).rejects.toBeDefined();
    expect(await h.executions(c.original, rejected.proposalId)).toBe(0);
    expect(await effects(other)).toBe(0);
    expect((await launchRow(other.launch)).state).toBe('live');
    return { r, made };
  }
  const kindCount = (kind: string, slot: string) => async (launch: string) => (await changes(launch, kind)).filter((x) => x.slot === slot && x.state === 'queued').length;

  it('ads.object.pause: waits, is never run by a rejection, and queues one pause when approved; an open change of the slot refuses it at the approval', async () => {
    const c: Case = { twin: 'ads.object.pause_approved', original: 'ads.object.pause', kind: 'ads.object_pause' };
    const { r } = await lifecycle(c, (x) => ({ launchId: x.launch, slot: 'ad_set' }), (x) => kindCount('pause', 'ad_set')(x.launch));
    // (d) The pause of the ad set is still queued for the platform: the second pause the coworker asks for is refused by the original's own check, and stays pending.
    const again = await asked(c.twin, { launchId: r.launch, slot: 'ad_set' });
    await expect(h.approve(again.proposalId)).rejects.toMatchObject({ code: 'ADS_CHANGE_OPEN' });
    expect((await h.proposal(again.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, again.proposalId)).toBe(0);
    expect(await kindCount('pause', 'ad_set')(r.launch)).toBe(1);
  });

  it('ads.object.archive: waits, is never run by a rejection, and queues one archive when approved; a launch that has stopped refuses it at the approval', async () => {
    const c: Case = { twin: 'ads.object.archive_approved', original: 'ads.object.archive', kind: 'ads.object_archive' };
    const { r } = await lifecycle(c, (x) => ({ launchId: x.launch, slot: 'ad_1' }), (x) => kindCount('archive', 'ad_1')(x.launch));
    // (d) Another ad's archive is asked while the launch is live, then a person stops the launch: the approval is judged on what stands then, and the launch is no longer live.
    const live = await rig();
    const late = await asked(c.twin, { launchId: live.launch, slot: 'ad_1' });
    await h.runtime.execute('ads.launch.stop', { launchId: live.launch }, { actor: h.person(h.owner), orgId: h.orgId });
    expect((await launchRow(live.launch)).state).toBe('stopped');
    await expect(h.approve(late.proposalId)).rejects.toMatchObject({ code: 'ADS_MANAGE_NOT_LIVE' });
    expect((await h.proposal(late.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, late.proposalId)).toBe(0);
    expect(await kindCount('archive', 'ad_1')(live.launch)).toBe(0);
    expect(await kindCount('archive', 'ad_1')(r.launch)).toBe(1);
  });

  it('ads.budget.lower: waits, is never run by a rejection, and queues one lower budget when approved; a budget that is not lower is refused at the approval', async () => {
    const c: Case = { twin: 'ads.budget.lower_approved', original: 'ads.budget.lower', kind: 'ads.budget_lower' };
    const { r } = await lifecycle(c, (x) => ({ launchId: x.launch, dailyBudget: '60000' }), (x) => kindCount('budget_lower', 'ad_set')(x.launch));
    const queued = (await changes(r.launch, 'budget_lower'))[0];
    expect(queued).toMatchObject({ from_budget: '100000', to_budget: '60000' });
    // The queued change's own platform call has not happened: the launch still holds its 100 000 until the platform confirms.
    expect((await launchRow(r.launch)).daily_budget).toBe('100000');
    // (d) A budget that is not lower than the one held is refused by the original (ADS_BUDGET_INVALID), here the very amount the launch holds; the proposal stays pending and writes nothing.
    const fresh = await rig();
    const same = await asked(c.twin, { launchId: fresh.launch, dailyBudget: '100000' });
    expect(same.status).toBe('pending');
    await expect(h.approve(same.proposalId)).rejects.toMatchObject({ code: 'ADS_BUDGET_INVALID', status: 422 });
    expect((await h.proposal(same.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, same.proposalId)).toBe(0);
    expect(await changes(fresh.launch)).toHaveLength(0);
  });

  it('ads.schedule.shorten: waits, is never run by a rejection, and queues one shorter schedule when approved; an end date that is not earlier is refused at the approval', async () => {
    const c: Case = { twin: 'ads.schedule.shorten_approved', original: 'ads.schedule.shorten', kind: 'ads.schedule_shorten' };
    const done = await lifecycle(c, (x) => ({ launchId: x.launch, endOn: D(5) }), (x) => kindCount('schedule_shorten', 'ad_set')(x.launch));
    expect((await changes(done.r.launch, 'schedule_shorten'))[0]).toMatchObject({ to_end_on: D(5) });
    // (d) An end date that is not earlier than the held one is refused by the original (ADS_SCHEDULE_INVALID); the proposal stays pending and writes nothing.
    const fresh = await rig();
    const same = await asked(c.twin, { launchId: fresh.launch, endOn: fresh.end });
    await expect(h.approve(same.proposalId)).rejects.toMatchObject({ code: 'ADS_SCHEDULE_INVALID', status: 422 });
    expect((await h.proposal(same.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, same.proposalId)).toBe(0);
    expect(await changes(fresh.launch)).toHaveLength(0);
  });

  it('ads.launch.stop: waits, is never run by a rejection, and stops the launch once when approved; a launch that is not running is refused at the approval', async () => {
    const c: Case = { twin: 'ads.launch.stop_approved', original: 'ads.launch.stop', kind: 'ads.launch_stop' };
    const stopped = (x: Rig) => launchRow(x.launch).then((l) => (l.state === 'stopped' ? 1 : 0));
    const { r } = await lifecycle(c, (x) => ({ launchId: x.launch }), stopped);
    expect((await launchRow(r.launch)).state).toBe('stopped');
    // (d) The launch stopped (here by the first approval): a second proposal for it is refused by the original (ADS_LAUNCH_NOT_RUNNING), stays pending and stops nothing.
    const again = await asked(c.twin, { launchId: r.launch });
    await expect(h.approve(again.proposalId)).rejects.toMatchObject({ code: 'ADS_LAUNCH_NOT_RUNNING', status: 409 });
    expect((await h.proposal(again.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, again.proposalId)).toBe(0);
  });

  // A raise a person's approved proposal queued, as the table holds it: the insert guard asks the raise's own approved proposal, so it is set aside for the one statement (the cancel's checks are the cancel's own).
  async function queuedRaise(r: Rig, kind: 'budget_raise' | 'schedule_extend' | 'resume' = 'budget_raise'): Promise<string> {
    const id = randomUUID();
    const shape: Record<typeof kind, { slot: string; level: string; columns: string; values: unknown[] }> = {
      budget_raise: { slot: 'ad_set', level: 'ad_set', columns: 'from_budget, to_budget', values: [100000, 150000] },
      schedule_extend: { slot: 'ad_set', level: 'ad_set', columns: 'from_end_on, to_end_on', values: [r.end, D(20)] },
      resume: { slot: 'ad_1', level: 'ad', columns: 'from_budget', values: [null] },
    };
    const { slot, level, columns, values } = shape[kind];
    await withoutGuard('ludy_ads.ad_manage_change', 'manage_change_guard', async (c) => {
      await c.query(
        `INSERT INTO ludy_ads.ad_manage_change (org_id, id, ad_account_id, launch_id, kind, slot, level, object_id, proposal_id, requested_by, ${columns})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${values.map((_, i) => `$${i + 11}`).join(', ')})`,
        [h.orgId, id, r.account, r.launch, kind, slot, level, `obj-${id.slice(0, 8)}`, randomUUID(), h.owner, ...values],
      );
    });
    return id;
  }
  const stateOf = async (id: string) => (await h.q<{ state: string }>('SELECT state FROM ludy_ads.ad_manage_change WHERE org_id = $1 AND id = $2', [h.orgId, id])).rows[0]?.state;

  it('ads.manage.cancel: waits, is never run by a rejection, and cancels a queued raise once when approved; a settled change and an unknown one are refused at the approval (#4181)', async () => {
    const c: Case = { twin: 'ads.manage.cancel_approved', original: 'ads.manage.cancel', kind: 'ads.manage_cancel' };
    const r = await rig();
    const raise = await queuedRaise(r);
    // (a) Proposal only: the change stays queued, the original never ran.
    const made = await asked(c.twin, { changeId: raise });
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: c.twin, kind: c.kind, tainted: true, payload: { changeId: raise } });
    expect(await h.ran(c.original)).toBe(0);
    expect(await stateOf(raise)).toBe('queued');
    // (c) Rejected: nothing is cancelled, ever, and a later approval is refused.
    const rejected = await asked(c.twin, { changeId: raise });
    await h.reject(rejected.proposalId);
    await expect(h.approve(rejected.proposalId)).rejects.toBeDefined();
    expect(await h.executions(c.original, rejected.proposalId)).toBe(0);
    expect(await stateOf(raise)).toBe('queued');
    // (b) Approved: the original runs once, as the person; the raise no longer waits.
    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    expect(await stateOf(raise)).toBe('cancelled');
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    // (d) The change is settled now: a second ask is refused by the original (ADS_CHANGE_SETTLED), stays pending and cancels nothing.
    const again = await asked(c.twin, { changeId: raise });
    await expect(h.approve(again.proposalId)).rejects.toMatchObject({ code: 'ADS_CHANGE_SETTLED', status: 409 });
    expect((await h.proposal(again.proposalId)).status).toBe('pending');
    expect(await h.executions(c.original, again.proposalId)).toBe(0);
    // A change nobody made is left to the original too (ADS_CHANGE_NOT_FOUND).
    const unknown = await asked(c.twin, { changeId: randomUUID() });
    await expect(h.approve(unknown.proposalId)).rejects.toMatchObject({ code: 'ADS_CHANGE_NOT_FOUND', status: 404 });
    // A change the job already begun (its call was recorded) may have landed: the original refuses it.
    const begun = await queuedRaise(await rig());
    await h.q(`INSERT INTO ludy_kernel.external_call (org_id, key, module, target, step, retry_safety) VALUES ($1, $2, 'ads', 'sandboxwrite_ads', 'manage_budget_raise', 'reconcile_only')`, [h.orgId, `ads.manage:${begun}:apply`]);
    const late = await asked(c.twin, { changeId: begun });
    await expect(h.approve(late.proposalId)).rejects.toMatchObject({ code: 'ADS_CHANGE_BEGUN', status: 409 });
    expect((await h.proposal(late.proposalId)).status).toBe('pending');
    expect(await stateOf(begun)).toBe('queued');
  });

  it('ads.manage.cancel: cancels a waiting resume and a waiting longer schedule once approved, as it does a raised budget: every kind that would start or raise spend (#4181)', async () => {
    const c: Case = { twin: 'ads.manage.cancel_approved', original: 'ads.manage.cancel', kind: 'ads.manage_cancel' };
    for (const kind of ['resume', 'schedule_extend'] as const) {
      const waiting = await queuedRaise(await rig(), kind);
      const made = await asked(c.twin, { changeId: waiting });
      expect(made.status, kind).toBe('pending');
      expect(await stateOf(waiting), kind).toBe('queued');
      await h.approve(made.proposalId);
      expect((await h.proposal(made.proposalId)).status, kind).toBe('executed');
      expect(await h.executions(c.original, made.proposalId), kind).toBe(1);
      expect(await stateOf(waiting), kind).toBe('cancelled');
    }
  });

  it('ads.manage.cancel: never cancels a waiting change that would REDUCE spend: a pause, an archive, a lower budget and a shorter schedule stay queued and the proposal stays pending (#4181)', async () => {
    const c: Case = { twin: 'ads.manage.cancel_approved', original: 'ads.manage.cancel', kind: 'ads.manage_cancel' };
    const r = await rig();
    const ranBefore = await h.ran(c.original);
    // The three reductions a person queues from the Campaigns screen (the original commands, as the owner).
    await h.runtime.execute('ads.object.pause', { launchId: r.launch, slot: 'ad_1' }, { actor: h.person(h.owner), orgId: h.orgId });
    await h.runtime.execute('ads.budget.lower', { launchId: r.launch, dailyBudget: '60000' }, { actor: h.person(h.owner), orgId: h.orgId });
    await h.runtime.execute('ads.schedule.shorten', { launchId: r.launch, endOn: D(5) }, { actor: h.person(h.owner), orgId: h.orgId });
    await h.runtime.execute('ads.object.archive', { launchId: r.launch, slot: 'campaign' }, { actor: h.person(h.owner), orgId: h.orgId });
    const queued =(await h.q<{ id: string; kind: string }>(`SELECT id, kind FROM ludy_ads.ad_manage_change WHERE org_id = $1 AND launch_id = $2 AND state = 'queued'`, [h.orgId, r.launch])).rows;
    expect(queued.map((x) => x.kind).sort()).toEqual(['archive', 'budget_lower', 'pause', 'schedule_shorten']);
    for (const change of queued) {
      const made = await asked(c.twin, { changeId: change.id });
      expect(made.status).toBe('pending');
      await expect(h.approve(made.proposalId), change.kind).rejects.toMatchObject({ code: 'ADS_CANCEL_NOT_OPENING', status: 409 });
      expect((await h.proposal(made.proposalId)).status).toBe('pending');
      expect(await h.executions(c.original, made.proposalId)).toBe(0);
      expect(await stateOf(change.id)).toBe('queued');
    }
    expect(await h.ran(c.original)).toBe(ranBefore);
    // The person's own cancel from the screen is unchanged: the original still cancels a reduction.
    await h.runtime.execute('ads.manage.cancel', { changeId: (queued[0] as { id: string }).id }, { actor: h.person(h.owner), orgId: h.orgId });
    expect(await stateOf((queued[0] as { id: string }).id)).toBe('cancelled');
  });

  it('a call outside the contract is refused: an undeclared key, a person calling a twin, a grant without the Ads scope', async () => {
    const r = await rig();
    const { actor } = await h.grant();
    const before = await proposalsOf('ads.launch.stop_approved');
    const stopsBefore = await h.ran('ads.launch.stop');
    // A key the original does not declare is refused, so a payload cannot carry an approval or any other word of the agent's.
    await expect(h.propose(actor, 'ads.launch.stop_approved', { launchId: r.launch, approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(h.propose(actor, 'ads.budget.lower_approved', { launchId: r.launch, dailyBudget: '60000', force: true })).rejects.toBeDefined();
    await expect(h.runtime.execute('ads.launch.stop_approved', { payload: { launchId: r.launch }, acceptFailedChecks: true }, { actor, orgId: h.orgId })).rejects.toMatchObject({ status: 422 });
    // A person runs the original, never the twin: it runs only from an approved proposal.
    for (const [twin, payload] of [
      ['ads.launch.stop_approved', { launchId: r.launch }],
      ['ads.pause_all_approved', {}],
      ['ads.object.pause_approved', { launchId: r.launch, slot: 'ad_set' }],
      ['ads.object.archive_approved', { launchId: r.launch, slot: 'ad_1' }],
      ['ads.budget.lower_approved', { launchId: r.launch, dailyBudget: '60000' }],
      ['ads.schedule.shorten_approved', { launchId: r.launch, endOn: D(5) }],
      ['ads.manage.cancel_approved', { changeId: randomUUID() }],
    ] as const) {
      await expect(h.runtime.execute(twin, { payload }, { actor: h.person(h.owner, true), orgId: h.orgId }), twin).rejects.toMatchObject({ status: 403 });
    }
    // A grant that holds the Engage scope but not the Ads one is refused by the scope rule and leaves no proposal.
    const { actor: engageOnly } = await h.grant([ENGAGE_SCOPE]);
    await expect(h.propose(engageOnly, 'ads.launch.stop_approved', { launchId: r.launch })).rejects.toMatchObject({ status: 403, details: expect.objectContaining({ rule: 'mcp_scope' }) });
    await expect(h.propose(engageOnly, 'ads.pause_all_approved', {})).rejects.toMatchObject({ status: 403, details: expect.objectContaining({ rule: 'mcp_scope' }) });
    expect(await proposalsOf('ads.launch.stop_approved')).toBe(before);
    expect(await proposalsOf('ads.pause_all_approved')).toBe(0);
    expect((await launchRow(r.launch)).state).toBe('live');
    expect(await h.ran('ads.launch.stop')).toBe(stopsBefore);
  });

  // The kill switch stops every launch of the org, so it goes last: the launches the tests above made are gone with it.
  it('ads.pause_all: waits, is never run by a rejection, and blocks launches and stops every running launch once when approved; asked again it is idempotent', async () => {
    const c: Case = { twin: 'ads.pause_all_approved', original: 'ads.pause_all', kind: 'ads.pause_all' };
    const r = await rig();
    const second = await rig();
    expect(await blocked()).toBe(false);
    // (a) Proposal only.
    const made = await asked(c.twin, {});
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: c.twin, kind: c.kind, tainted: true, payload: {} });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    expect(await h.ran(c.original)).toBe(0);
    expect(await blocked()).toBe(false);
    expect((await launchRow(r.launch)).state).toBe('live');
    expect((await launchRow(second.launch)).state).toBe('live');

    // (c) Rejected: nothing is stopped, ever, and a later approval is refused.
    const rejected = await asked(c.twin, {});
    await h.reject(rejected.proposalId);
    expect((await h.proposal(rejected.proposalId)).status).toBe('rejected');
    await expect(h.approve(rejected.proposalId)).rejects.toBeDefined();
    expect(await h.executions(c.original, rejected.proposalId)).toBe(0);
    expect(await blocked()).toBe(false);
    expect((await launchRow(r.launch)).state).toBe('live');

    // (b) Approved: launches are blocked and both running launches stop, once.
    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    expect(await blocked()).toBe(true);
    expect((await launchRow(r.launch)).state).toBe('stopped');
    expect((await launchRow(second.launch)).state).toBe('stopped');
    const stoppedEvents = (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued'`, [h.orgId])).rows[0]?.n;
    expect(stoppedEvents).toBeGreaterThanOrEqual(2);
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions(c.original, made.proposalId)).toBe(1);
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued'`, [h.orgId])).rows[0]?.n).toBe(stoppedEvents);

    // (d) The kill switch is idempotent: asked again, with the switch already on and nothing running, the approval still runs and changes nothing more.
    const again = await asked(c.twin, {});
    await h.approve(again.proposalId);
    expect(await h.executions(c.original, again.proposalId)).toBe(1);
    expect(await blocked()).toBe(true);
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued'`, [h.orgId])).rows[0]?.n).toBe(stoppedEvents);
  });
});
