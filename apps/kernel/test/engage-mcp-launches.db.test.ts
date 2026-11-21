// SPDX-License-Identifier: AGPL-3.0-only
// The read of the ad launches that have started (`ads.mcp.launches`, tool `ludy_ads_launches`; epic #3857, E4b, issue #4147) and what an AI coworker does with its ids: it lists a live launch, asks for it to be
// stopped or its budget lowered, nothing happens until a person approves, and then the original command runs once as that person. The projection is pinned here (the exact keys, amounts as decimal strings,
// every text one plain line, only launches that have started, nothing of the plan, the platform's ids or the proposal); who may read is pinned with the other results reads in engage-mcp-results.db.test.ts.
// The fixture is the live launch the invariants of the changes of a running ad build (apps/kernel/test/invariant/ads-manage.db.test.ts), as in engage-proposals-ads.db.test.ts. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpAdsLaunches } from '@crove/mod-ads';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const HASH = `sha256:${'b'.repeat(64)}`;
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// A character a person cannot see or that breaks the line, but a model reads.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LAUNCH_KEYS = ['adAccountId', 'adAccountName', 'canChange', 'currency', 'dailyBudget', 'endOn', 'heldDailyBudget', 'heldEndOn', 'launchId', 'objects', 'queuedRaises', 'startOn', 'state'];
const OBJECT_KEYS = ['level', 'name', 'pending', 'slot', 'status'];

interface View {
  launches: Array<Record<string, unknown> & { launchId: string; objects: Array<Record<string, unknown>> }>;
  truncated: boolean;
}

suite('the read of started ad launches and the proposals made with its ids (#4147)', () => {
  let h: Harness;
  let today = '';
  const D = (n: number) => addDays(today, n);
  beforeAll(async () => {
    h = await startHarness('engage_launches');
    today = (await h.q<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]?.d as string;
    await withoutGuard('crove_ads.ad_org_setting', 'switch_guard', async (c) => {
      await c.query('INSERT INTO crove_ads.ad_org_setting (org_id, write_enabled, launches_blocked) VALUES ($1, true, false) ON CONFLICT DO NOTHING', [h.orgId]);
      await c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [h.orgId]);
    });
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

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

  // A launch of 100 000 a day (begun three days ago, ending in ten) in an account in Vietnam's zone with running ads on, in the state asked for, with the campaign, the ad set and one ad recorded.
  async function rig(state: 'queued' | 'live' | 'stopped', accountName = 'Thử'): Promise<{ launch: string; account: string; draft: string; proposal: string; connection: string; write: string }> {
    const connection = randomUUID();
    const account = randomUUID();
    await h.q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`, [h.orgId, connection, `acct-${connection.slice(0, 8)}`, h.owner]);
    await h.q(
      `INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, $6, '2025-10-01', 'VND', $5)`,
      [h.orgId, account, connection, `ext-${account.slice(0, 8)}`, 'Asia/Ho_Chi_Minh', accountName],
    );
    const write = randomUUID();
    await h.q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandboxwrite_ads', $3, 'Thử ghi', '{}', $4)`, [h.orgId, write, `acct-${connection.slice(0, 8)}`, h.owner]);
    await withoutGuard('crove_ads.ad_account', ['switch_guard', 'write_connection_guard'], async (c) => {
      await c.query('UPDATE crove_ads.ad_account SET write_enabled = true, write_connection_id = $3 WHERE org_id = $1 AND id = $2', [h.orgId, account, write]);
    });
    const draft = randomUUID();
    await h.q(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [h.orgId, draft, account, h.owner]);
    const launch = randomUUID();
    const proposal = randomUUID();
    await h.q(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, '1400000', $8, $9, 'queued')`,
      [h.orgId, launch, account, draft, proposal, HASH, D(-3), D(10), h.owner],
    );
    if (state !== 'queued') {
      await withoutGuard('crove_ads.ad_launch', 'launch_guard', async (c) => {
        await c.query(`UPDATE crove_ads.ad_launch SET state = 'launching', step = 'campaign' WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
      });
      const tag = (await h.q<{ tag: string }>(`SELECT tag FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [h.orgId, launch])).rows[0]?.tag as string;
      const ids = { campaign: `cmp-${launch.slice(0, 8)}`, ad_set: `set-${launch.slice(0, 8)}`, ad_1: `ad1-${launch.slice(0, 8)}` };
      for (const [slot, level] of [['campaign', 'campaign'], ['ad_set', 'ad_set'], ['ad_1', 'ad']] as const) {
        await h.q(`INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [h.orgId, account, launch, slot, level, ids[slot], `Thử ${tag} ${slot}`]);
      }
      await withoutGuard('crove_ads.ad_launch', 'launch_guard', async (c) => {
        await c.query(`UPDATE crove_ads.ad_launch SET state = 'live', step = 'live' WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
      });
    }
    if (state === 'stopped') {
      await withoutGuard('crove_ads.ad_launch', 'launch_guard', async (c) => {
        await c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', stop_reason = 'owner_stop', finished_at = now() WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
      });
    }
    return { launch, account, draft, proposal, connection, write };
  }

  const read = async (): Promise<View> => {
    const { actor } = await h.grant(['ludy.ads.draft']);
    return h.runtime.query<View>('ads.mcp.launches', {}, { actor, orgId: h.orgId });
  };
  const launchRow = async (launch: string) => (await h.q<{ state: string; daily_budget: string }>(`SELECT state, daily_budget::text AS daily_budget FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [h.orgId, launch])).rows[0];

  it('lists a live launch with exactly the keys of the privacy review, amounts as decimal strings and every text as one plain line, and leaves out one that has not started or has stopped', async () => {
    const live = await rig('live', 'Tài khoản​ ‮Thử\nhai');
    const queued = await rig('queued');
    const stopped = await rig('stopped');
    const view = await read();
    expect(Object.keys(view).sort()).toEqual(['launches', 'truncated']);
    expect(view.truncated).toBe(false);
    const ids = view.launches.map((l) => l.launchId);
    expect(ids).toContain(live.launch);
    expect(ids).not.toContain(queued.launch);
    expect(ids).not.toContain(stopped.launch);
    const mine = view.launches.find((l) => l.launchId === live.launch);
    expect(Object.keys(mine as object).sort()).toEqual(LAUNCH_KEYS);
    expect(mine).toMatchObject({ adAccountId: live.account, state: 'live', currency: 'VND', startOn: D(-3), endOn: D(10), canChange: true });
    expect(typeof mine?.dailyBudget).toBe('string');
    expect(Number(mine?.dailyBudget)).toBe(100000);
    expect(Number(mine?.heldDailyBudget)).toBe(100000);
    expect(mine?.heldEndOn).toBe(D(10));
    // The account's name is one plain line: the invisible and the line-breaking characters are gone.
    expect(String(mine?.adAccountName)).not.toMatch(HIDDEN);
    expect(String(mine?.adAccountName)).toContain('Tài khoản');
    expect(mine?.objects.map((o) => o.slot).sort()).toEqual(['ad_1', 'ad_set', 'campaign']);
    for (const o of mine?.objects ?? []) {
      expect(Object.keys(o).sort()).toEqual(OBJECT_KEYS);
      expect(o).toMatchObject({ status: 'active', pending: null });
      expect(String(o.name)).not.toMatch(HIDDEN);
    }
    // What the security review asked to keep out (#4147): the proposal that approved the launch, the plan's hash, who created or updated it, the draft, the platform's account and object ids, the connections
    // and any token. Pinned by key and by value, and the largest amount is not returned either (only the budget, as a decimal string).
    const text = JSON.stringify(view);
    for (const key of ['proposal_id', 'proposalId', 'plan_hash', 'planHash', 'created_by', 'createdBy', 'updated_by', 'updatedBy', 'draftId', 'externalId', 'external_id', 'connection', 'token', 'amount']) expect(text, key).not.toContain(`"${key}"`);
    expect(text).not.toMatch(/plan|token|secret/i);
    for (const value of [HASH, live.proposal, live.draft, live.connection, live.write, h.owner]) expect(text, value).not.toContain(value);
    // The platform's own ids of the rig (its objects' and its accounts'), by their exact values.
    for (const id of [`cmp-${live.launch.slice(0, 8)}`, `set-${live.launch.slice(0, 8)}`, `ad1-${live.launch.slice(0, 8)}`, `ext-${live.account.slice(0, 8)}`, `acct-${live.connection.slice(0, 8)}`]) expect(text, id).not.toContain(id);
  });

  it('is a read for owners and admins of a company grant, and the tables it reads keep the RESTRICTIVE legal-entity policy the grant\'s scope is judged by, beside the org policy', async () => {
    expect(mcpAdsLaunches.access).toEqual(['owner', 'admin']);
    expect(mcpAdsLaunches.mcp).toEqual({ scope: 'ludy.read' });
    expect((mcpAdsLaunches as { sensitive?: unknown }).sensitive).toBeUndefined();
    // Each table the read touches has the org policy (permissive, org only) and, beside it, the RESTRICTIVE `le_scope` policy that narrows it to the grant's legal entities: a company grant's scope is the whole
    // org, so what it reads is what an owner or an admin sees on the Campaigns screen, and a scope that names fewer entities would narrow the read here as it narrows the screen.
    const policies = await h.q<{ t: string; name: string; restrictive: boolean; text: string }>(
      `SELECT r.relname AS t, p.polname AS name, NOT p.polpermissive AS restrictive, pg_get_expr(p.polqual, p.polrelid) AS text FROM pg_policy p JOIN pg_class r ON r.oid = p.polrelid JOIN pg_namespace s ON s.oid = r.relnamespace
       WHERE s.nspname = 'crove_ads' AND r.relname IN ('ad_launch', 'ad_object', 'ad_account', 'ad_manage_change')`,
    );
    for (const table of ['ad_launch', 'ad_object', 'ad_account', 'ad_manage_change']) {
      const mine = policies.rows.filter((p) => p.t === table);
      const scope = mine.filter((p) => p.name === 'le_scope');
      expect(scope.length, `${table} le_scope`).toBe(1);
      expect(scope[0]?.restrictive, `${table} le_scope is restrictive`).toBe(true);
      expect(scope[0]?.text, `${table} le_scope`).toMatch(/ctx_le_scope/);
      // The other policies of the table are the org's own and name no entity.
      for (const p of mine.filter((x) => x.name !== 'le_scope')) expect(p.text, `${table} ${p.name}`).not.toMatch(/ctx_le_scope/);
    }
  });

  it('lets an AI coworker ask to stop a launch it listed: nothing happens until a person approves, and then the stop runs once', async () => {
    const { launch } = await rig('live');
    const listed = (await read()).launches.find((l) => l.launchId === launch);
    expect(listed).toBeDefined();
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'ads.launch.stop_approved', { launchId: listed?.launchId });
    expect(made.status).toBe('pending');
    expect((await launchRow(launch))?.state).toBe('live');
    expect(await h.ran('ads.launch.stop')).toBe(0);
    await h.approve(made.proposalId);
    expect((await launchRow(launch))?.state).toBe('stopped');
    expect(await h.executions('ads.launch.stop', made.proposalId)).toBe(1);
    // A stopped launch is not in the list any more.
    expect((await read()).launches.map((l) => l.launchId)).not.toContain(launch);
  });

  it('lists the waiting changes that would raise spend (and only those) with the id a cancel takes, and an AI coworker asks to cancel one it read (#4181)', async () => {
    const { launch, account } = await rig('live');
    // A change as the table holds it: the insert guard asks a raise's own approved proposal, so it is set aside for the one statement. Only a raise carries a proposal.
    const insert = async (kind: string, slot: string, level: string, columns: string, values: unknown[]): Promise<string> => {
      const id = randomUUID();
      const proposal = kind === 'budget_raise' ? randomUUID() : null;
      const marks = values.map((_, i) => `$${i + 9}`).join(', ');
      await withoutGuard('crove_ads.ad_manage_change', 'manage_change_guard', async (c) => {
        await c.query(`INSERT INTO crove_ads.ad_manage_change (org_id, id, ad_account_id, launch_id, kind, slot, level, object_id, proposal_id, requested_by, ${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${proposal ? `'${proposal}'` : 'NULL'}, '${h.owner}', ${marks})`, [h.orgId, id, account, launch, kind, slot, level, `obj-${id.slice(0, 8)}`, ...values]);
      });
      return id;
    };
    // Before anything waits: an empty list.
    expect((await read()).launches.find((l) => l.launchId === launch)?.queuedRaises).toEqual([]);
    const raise = await insert('budget_raise', 'ad_set', 'ad_set', 'from_budget, to_budget', [100000, 150000]);
    // A waiting pause on another object is not a raise: it is never listed (a cancel of it would keep an ad running).
    await insert('pause', 'ad_1', 'ad', 'from_budget', [null]);
    const mine = (await read()).launches.find((l) => l.launchId === launch);
    expect(mine?.queuedRaises).toEqual([{ changeId: raise, kind: 'budget_raise', slot: 'ad_set', toBudget: '150000', toEndOn: null }]);
    // The coworker names that change in a cancel; a person approves it and it no longer waits (and no longer shows in the list).
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'ads.manage.cancel_approved', { changeId: raise });
    expect(made.status).toBe('pending');
    await h.approve(made.proposalId);
    expect(await h.executions('ads.manage.cancel', made.proposalId)).toBe(1);
    expect((await read()).launches.find((l) => l.launchId === launch)?.queuedRaises).toEqual([]);
  });

  it('lets an AI coworker ask to lower a budget it read, and a budget that is not lower is refused when the person approves, leaving the proposal pending', async () => {
    const { launch } = await rig('live');
    const listed = (await read()).launches.find((l) => l.launchId === launch) as unknown as { dailyBudget: string };
    expect(Number(listed.dailyBudget)).toBe(100000);
    const { actor } = await h.grant();
    const higher = await h.propose(actor, 'ads.budget.lower_approved', { launchId: launch, dailyBudget: '150000' });
    await expect(h.approve(higher.proposalId)).rejects.toBeDefined();
    expect((await h.proposal(higher.proposalId)).status).toBe('pending');
    const lower = await h.propose(actor, 'ads.budget.lower_approved', { launchId: launch, dailyBudget: '70000' });
    await h.approve(lower.proposalId);
    expect(await h.executions('ads.budget.lower', lower.proposalId)).toBe(1);
  });
});
