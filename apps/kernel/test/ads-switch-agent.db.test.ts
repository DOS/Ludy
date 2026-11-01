// SPDX-License-Identifier: AGPL-3.0-only
// No agent can touch the switches of running ads (ADR-0043, issue #2294, the Platform PO's condition on W0a): a live agent run,
// entered as the worker enters one (crove_kernel.enter_agent_context with a run that is live), cannot turn writing on or off for
// the org or an ad account, cannot block or unblock launches, and cannot add a spend cap, all refused by the database, not by a
// command's role check (the SQL is run directly in the agent's context); and none of the commands of running ads runs for it.
// The agent is installed from a template and given a run the way apps/kernel/test/invariant/agents.db.test.ts does it. The open
// state the test needs is made as a signed-in owner's context makes it, in SQL (what a proposal's effect will do), since the
// guard fires for every role. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { mintContextToken, Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { adsCommands, adsQueries } from '@crove/mod-ads';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

const suite = ADMIN ? describe : describe.skip;

suite('a live agent run and the switches of running ads (ADR-0043, #2294)', () => {
  const dbName = `crove_test_ads_agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let orgId = '';
  let adAccountId = '';
  let agent: AgentActor;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs SQL as crove_worker inside the agent's context, always rolled back.
  async function inAgentContext<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]);
      // The context is the agent's: the actor the database sees is not a user.
      expect((await c.query<{ actor: string }>('SELECT crove_kernel.ctx_actor_type() AS actor')).rows[0]?.actor).toBe('agent');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  // Runs SQL as crove_app inside the owner's own context, committed: the way a proposal's effect will open the switches.
  async function asOwnerSql(sqlText: string, params: unknown[] = []): Promise<void> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: owner, orgId, sessionId: null, aal: 'aal1', mfaAt: null });
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, token]);
      await c.query(sqlText, params);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    workerUrl = login('crove_worker', 'test-worker-pw');
    appUrl = login('crove_app', 'test-app-pw');
    const runtimeFor = (url: string): { db: Db; runtime: Runtime } => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands, ...adsCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...adsQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    app = api.runtime;
    worker = runtimeFor(workerUrl).runtime;
    owner = await upsertIdentity(api.db, { issuer: 'ads-agent', subject: 'owner', email: 'owner@ads-agent.test', name: null });
    orgId = (await createOrg(app, asUser(owner), 'Ads agent')).orgId;
    // An ad account to enable (the way the RLS matrix seeds one: a connection of its own, and its entity by the trigger).
    adAccountId = randomUUID();
    await admin(async (c) => {
      const connection = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'sandbox-agent-test', 'Agent test', $3)`,
        [orgId, connection, owner],
      );
      await c.query(
        `INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from) VALUES ($1, $2, $3, 'sandbox_ads', 'sandbox-agent-test', 'Agent test', '2025-10-01')`,
        [orgId, adAccountId, connection],
      );
      // The org's row of switches exists, both off.
      await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1)', [orgId]);
    });
    // A live agent: installed from the template, holding its own position, with a run started through a task that wakes it.
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE, reportsTo: null }, { actor: asMfa(owner), orgId });
    await app.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('the agent run did not start');
    agent = { type: 'agent', agentId, runId: started.runId };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const state = () =>
    admin(async (c) => {
      const setting = (await c.query<{ write_enabled: boolean; launches_blocked: boolean }>('SELECT write_enabled, launches_blocked FROM crove_ads.ad_org_setting WHERE org_id = $1', [orgId])).rows[0];
      const account = (await c.query<{ write_enabled: boolean }>('SELECT write_enabled FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2', [orgId, adAccountId])).rows[0];
      const caps = (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_ads.ad_spend_cap WHERE org_id = $1', [orgId])).rows[0]?.n;
      return { setting, account, caps };
    });

  it('refuses a live agent run every way of opening or closing the switches and of adding a cap, at the database', async () => {
    const before = await state();
    expect(before).toEqual({ setting: { write_enabled: false, launches_blocked: false }, account: { write_enabled: false }, caps: '0' });
    // Opening: writing on for the org, writing on for an account. Closing: launches blocked. And a cap. Each in a transaction of
    // its own, since a refused statement aborts the one it ran in.
    const attempts: Array<[string, string, unknown[]]> = [
      ['write on for the org', 'UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1', [orgId]],
      ['launches blocked', 'UPDATE crove_ads.ad_org_setting SET launches_blocked = true WHERE org_id = $1', [orgId]],
      ['write on for an account', 'UPDATE crove_ads.ad_account SET write_enabled = true WHERE org_id = $1 AND id = $2', [orgId, adAccountId]],
      ['a cap', `INSERT INTO crove_ads.ad_spend_cap (org_id, scope, period, amount, currency, set_by) VALUES ($1, 'org', 'daily', '1000000', 'VND', $2)`, [orgId, owner]],
      ['a second row of switches', 'INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1)', [orgId]],
    ];
    for (const [what, text, params] of attempts) {
      await inAgentContext(async (c) => {
        await expect(c.query(text, params), what).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23505)$/) });
      });
    }
    // Closing what is open is refused too: the owner opens the switches in their own context (the guard fires for every role, so
    // no other connection could), and the agent then tries to turn them off.
    await asOwnerSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1', [orgId]);
    await asOwnerSql('UPDATE crove_ads.ad_account SET write_enabled = true WHERE org_id = $1 AND id = $2', [orgId, adAccountId]);
    const opened = await state();
    expect(opened.setting?.write_enabled).toBe(true);
    expect(opened.account?.write_enabled).toBe(true);
    for (const [what, text, params] of [
      ['write off for the org', 'UPDATE crove_ads.ad_org_setting SET write_enabled = false WHERE org_id = $1', [orgId]],
      ['write off for an account', 'UPDATE crove_ads.ad_account SET write_enabled = false WHERE org_id = $1 AND id = $2', [orgId, adAccountId]],
    ] as Array<[string, string, unknown[]]>) {
      await inAgentContext(async (c) => {
        await expect(c.query(text, params), what).rejects.toMatchObject({ code: '42501' });
      });
    }
    // Launches blocked by an owner stay blocked: the agent cannot unblock them.
    await app.execute('ads.pause_all', {}, { actor: asUser(owner), orgId });
    expect((await state()).setting?.launches_blocked).toBe(true);
    await inAgentContext(async (c) => {
      await expect(c.query('UPDATE crove_ads.ad_org_setting SET launches_blocked = false WHERE org_id = $1', [orgId])).rejects.toMatchObject({ code: '42501' });
    });
    // Nothing the agent tried changed anything.
    expect(await state()).toEqual({ setting: { write_enabled: true, launches_blocked: true }, account: { write_enabled: true }, caps: '0' });
  });

  it('refuses a live agent run every command of running ads, audited as denied', async () => {
    for (const [name, input] of [
      ['ads.write.disable', {}],
      ['ads.account.disable_write', { adAccountId }],
      ['ads.pause_all', {}],
      ['ads.cap.lower', { scope: 'org', period: 'daily', amount: '1' }],
      // Asking for what opens the way to spend, and the commands an approval runs, are no agent's either.
      ['ads.write.prepare_enable', {}],
      ['ads.account.prepare_enable_write', { adAccountId }],
      ['ads.cap.prepare_set', { scope: 'org', period: 'daily', amount: '1', currency: 'VND' }],
      ['ads.launches.prepare_unblock', {}],
      ['kernel.proposal.request', { command: 'ads.write.enable', input: {} }],
      ['ads.write.enable', { payload: {} }],
      ['ads.account.enable_write', { payload: { adAccountId, adAccountName: 'x' } }],
      ['ads.cap.set', { payload: { scope: 'org', period: 'daily', amount: '1', currency: 'VND', previous: null, previousCurrency: null } }],
      ['ads.launches.unblock', { payload: { blockedSince: '2026-11-02 00:00:00+00' } }],
    ] as Array<[string, unknown]>) {
      await expect(worker.execute(name, input, { actor: agent, orgId }), name).rejects.toMatchObject({ status: 403 });
    }
    const denied = await admin(async (c) => (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'ads.%' AND actor_type = 'agent' AND outcome = 'denied'`, [orgId])).rows[0]?.n);
    expect(Number(denied)).toBeGreaterThanOrEqual(1);
  });
});
