// SPDX-License-Identifier: AGPL-3.0-only
// The module and coworker switches at the write and proposal entries of an MCP company grant (#4155, a follow-up of the shared-core review of #4150; ADR-0051 decisions 10 and 11, ADR-0053): the part of
// the enforcement that is a security line. A person who switches an app off, or stops one coworker, expects the AI app to stop at once, so for every entry a grant has (the kernel and CRM Engage R1 twins, the Ads
// draft, the Social draft, and the proposal entry that asks a person for something above R1) this pins that, while the switch is on:
// - a kill switch of scope `module` for the command's module refuses the call with KILL_SWITCH_ON (403), writes nothing and writes the grant's refusal row under the command's own name;
// - a kill switch of scope `agent` naming the grant refuses it the same way, and a second grant of the org is not touched;
// - an app the org switched off (ADR-0053, `apps_off`) answers MODULE_OFF (404) with the same audit row, for a write and for a proposal (the gate reads the module of the command the proposal is for);
// and that `crove_kernel.mcp_switch_check` is the API login's alone, with a pinned search path, refuses a name that is not a module, and answers only for the context the caller entered (its org and its grant). That a released switch lets the next call through, and that a person's own
// commands are untouched, are product flows: apps/kernel/test/mcp-grant-switches.db.test.ts.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { adsCommands, adsQueries } from '@ludy/mod-ads';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { socialCommands, socialQueries } from '@ludy/mod-social';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';
const SOCIAL = 'ludy.social.draft';

suite('the module and coworker switches at an MCP grant entry (#4155)', () => {
  const dbName = `crove_test_mcp_grant_switches_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgId = '';
  let owner = '';
  let party = '';
  let adAccount = '';
  let socialChannel = '';
  let counter = 0;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const person = (): UserActor => ({ type: 'user', userId: owner, aal: 'aal1' });
  async function grant(scopes: string[]): Promise<{ actor: UserActor; grantId: string }> {
    const grantId = randomUUID();
    const all = ['ludy.read', ...scopes];
    await q(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Dy', 'dy.example.org', $5::text[], $6, now(), now() + interval '30 days', $3, 'company', NULL)`,
      [orgId, grantId, owner, `client-${grantId}`, all, `oauth-${grantId}`],
    );
    return { grantId, actor: { type: 'user', userId: owner, aal: 'aal1', mcp: { grantId, clientId: `client-${grantId}`, clientName: 'Dy', scopes: all, kind: 'company' } } };
  }
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  // The person's own switches, through their commands; the release is the test's own, as a row update (the release command is a person's step-up and is not what is under test).
  const stopModule = async (target: string) => (await runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target }, { actor: person(), orgId })).killSwitchId;
  const releaseAll = () => q(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND released_at IS NULL`, [orgId, owner]);
  const setApp = (module: string, enabled: boolean) => runtime.execute('kernel.org.set_app', { module, enabled }, { actor: person(), orgId, idempotencyKey: randomUUID() });
  // A switch of scope `agent` naming a grant: the table accepts it (a uuid), though no command makes one for a grant today.
  const stopGrant = (grantId: string) => q(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, reason, engaged_by) VALUES ($1, 'agent', $2, 'test', $3)`, [orgId, grantId, owner]);

  async function audited(command: string, grantId: string, outcome: 'denied' | 'failed') {
    const rows = (await q<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $4 AND detail ->> 'mcpGrant' = $3`, [orgId, command, grantId, outcome])).rows;
    expect(rows.length, `${command} ${outcome} audit rows of the grant`).toBeGreaterThan(0);
    expect(rows[0]?.detail).toMatchObject({ mcpCall: true, mcpGrant: grantId });
  }
  const rows = async (table: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0]?.n ?? 0;
  const pending = async (command: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE org_id = $1 AND command = $2 AND status = 'pending'`, [orgId, command])).rows[0]?.n ?? 0;

  interface Entry {
    label: string;
    module: string;
    scope: string;
    command: string;
    input: () => unknown;
    count: () => Promise<number>;
  }
  const entries: Entry[] = [
    { label: 'the kernel R1 twin (Hộp thư)', module: 'kernel', scope: ENGAGE, command: 'kernel.mcp.party_create', input: () => ({ kind: 'person', name: `Khách ${counter++}` }), count: () => rows('crove_kernel.party') },
    { label: 'the CRM R1 twin', module: 'crm', scope: ENGAGE, command: 'crm.mcp.deal_create', input: () => ({ partyId: party, title: `Cơ hội ${counter++}`, amount: '1000000', expectedClose: null }), count: () => rows('crove_crm.deal') },
    { label: 'the Ads draft', module: 'ads', scope: ADS, command: 'ads.mcp.campaign_draft_save', input: () => ({ adAccountId: adAccount, plan: { name: `Nháp ${counter++}`, objective: 'traffic', dailyBudget: '200000' } }), count: () => rows('crove_ads.ad_campaign_draft') },
    { label: 'the Social draft', module: 'social', scope: SOCIAL, command: 'social.mcp.draft_create', input: () => ({ body: `Bài ${counter++}`, channels: [{ connectionId: socialChannel }] }), count: () => rows('crove_social.post') },
  ];
  const call = (e: Entry, g: { actor: UserActor }) => runtime.execute(e.command, e.input(), { actor: g.actor, orgId });

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const pool = createPool({ connectionString: app.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...socialCommands, ...crmCommands, ...adsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, ...crmQueries, ...adsQueries],
    });
    owner = await upsertIdentity(db, { issuer: 'mcp-grant-switches', subject: `owner-${randomUUID()}`, email: `owner-${randomUUID().slice(0, 8)}@mcp-grant-switches.test`, name: 'owner' });
    orgId = (await createOrg(runtime, person(), 'Grant switches')).orgId;
    party = (await q<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, source_trust) VALUES ($1, 'person', 'Khách có sẵn', 'user') RETURNING id`, [orgId])).rows[0]?.id as string;
    const connection = randomUUID();
    await q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'act-1', 'Tài khoản QC', $3)`, [orgId, connection, owner]);
    adAccount = randomUUID();
    await q(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'Tài khoản QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [orgId, adAccount, connection]);
    socialChannel = randomUUID();
    await q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-social-1', 'Trang', $3)`, [orgId, socialChannel, owner]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  for (const e of entries) {
    it(`refuses ${e.label} while its module's switch is engaged, writes nothing, and audits the refusal as the grant's`, async () => {
      const g = await grant([e.scope]);
      const before = await e.count();
      await stopModule(e.module);
      try {
        const err = await refusal(call(e, g));
        expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
        expect(await e.count()).toBe(before);
        await audited(e.command, g.grantId, 'denied');
      } finally {
        await releaseAll();
      }
    });

    it(`refuses ${e.label} while an agent switch names the grant, and only that grant`, async () => {
      const g = await grant([e.scope]);
      const sibling = await grant([e.scope]);
      const before = await e.count();
      await stopGrant(g.grantId);
      try {
        const err = await refusal(call(e, g));
        expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
        expect(await e.count()).toBe(before);
        await audited(e.command, g.grantId, 'denied');
        await call(e, sibling);
        expect(await e.count()).toBe(before + 1);
      } finally {
        await releaseAll();
      }
    });

    if (e.module !== 'kernel') {
      it(`refuses ${e.label} with MODULE_OFF while the org has the app switched off, and audits it as the grant's`, async () => {
        const g = await grant([e.scope]);
        const before = await e.count();
        await setApp(e.module, false);
        try {
          const err = await refusal(call(e, g));
          expect([err.code, err.status, err.details]).toEqual(['MODULE_OFF', 404, expect.objectContaining({ module: e.module })]);
          expect(await e.count()).toBe(before);
          await audited(e.command, g.grantId, 'failed');
        } finally {
          await setApp(e.module, true);
        }
      });
    }
  }

  it('asks for nothing above R1 while the module of the command it is for is stopped or switched off, or the grant is stopped', async () => {
    const g = await grant([ADS]);
    const command = 'ads.pause_all_approved';
    const before = await pending(command);
    // A proposal for an Ads command is judged on the Ads switch (the module of the command it is for), not the proposer's, which is the kernel's.
    await stopModule('ads');
    try {
      const err = await refusal(runtime.execute(command, { payload: {} }, { actor: g.actor, orgId }));
      expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
      expect(await pending(command)).toBe(before);
      await audited(command, g.grantId, 'denied');
    } finally {
      await releaseAll();
    }
    await setApp('ads', false);
    try {
      const off = await refusal(runtime.execute(command, { payload: {} }, { actor: g.actor, orgId }));
      expect([off.code, off.status]).toEqual(['MODULE_OFF', 404]);
      expect(await pending(command)).toBe(before);
      await audited(command, g.grantId, 'failed');
    } finally {
      await setApp('ads', true);
    }
    await stopGrant(g.grantId);
    try {
      expect((await refusal(runtime.execute(command, { payload: {} }, { actor: g.actor, orgId }))).code).toBe('KILL_SWITCH_ON');
      expect(await pending(command)).toBe(before);
    } finally {
      await releaseAll();
    }
  });

  it('refuses a kernel proposal (a Hộp thư action) while the kernel switch is engaged', async () => {
    const g = await grant([ENGAGE]);
    const command = 'kernel.conversation.hide_approved';
    const payload = { messageId: randomUUID(), hidden: true };
    const before = await pending(command);
    await stopModule('kernel');
    try {
      const err = await refusal(runtime.execute(command, { payload }, { actor: g.actor, orgId }));
      expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
      expect(await pending(command)).toBe(before);
      await audited(command, g.grantId, 'denied');
    } finally {
      await releaseAll();
    }
  });

  it('gives the switch check to the API login alone, with a pinned search path, and refuses a name that is not a module', async () => {
    const fn = 'crove_kernel.mcp_switch_check(uuid,uuid,text)';
    const logins = (await q<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper`)).rows.map((r) => r.rolname);
    expect(logins).toContain('crove_app');
    for (const rolname of logins) {
      const ok = (await q<{ ok: boolean }>(`SELECT has_function_privilege($1, '${fn}', 'EXECUTE') AS ok`, [rolname])).rows[0]?.ok;
      expect(ok, `${rolname} executes the switch check`).toBe(rolname === 'crove_app');
    }
    expect((await q<{ ok: boolean }>(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS ok`)).rows[0]?.ok).toBe(false);
    expect((await q(`SELECT proconfig FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0]).toEqual({ proconfig: ['search_path=pg_catalog, pg_temp'] });
    await expect(q(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'Not A Module')`, [orgId, randomUUID()])).rejects.toThrow(/MCP_GRANT_SCOPE/);
  });

  it('answers a switch check only for the context the caller entered: no context, another org or another grant is refused and tells nothing about a switch', async () => {
    const g = await grant([ENGAGE]);
    const other = await grant([ENGAGE]);
    await stopModule('crm');
    try {
      // No sealed context (the superuser's own session): refused before any switch row is read, so an engaged switch is not told.
      await expect(q(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'crm')`, [orgId, g.grantId])).rejects.toThrow(/MCP_SWITCH_CONTEXT/);
      // The API login, in the entered context of the first grant.
      const app = new URL(adminUrl);
      app.username = 'crove_app';
      app.password = 'test-app-pw';
      const c = new pg.Client({ connectionString: app.toString() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, g.grantId, ENGAGE]);
        // Another grant of the same org, and another org with the same grant: both are about a call that is not this one.
        await expect(c.query(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'crm')`, [orgId, other.grantId])).rejects.toThrow(/MCP_SWITCH_CONTEXT/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, g.grantId, ENGAGE]);
        await expect(c.query(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'crm')`, [randomUUID(), g.grantId])).rejects.toThrow(/MCP_SWITCH_CONTEXT/);
        await c.query('ROLLBACK');
        // The control: about its own org and grant the check still reads the switch, so the binding does not blind it.
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, g.grantId, ENGAGE]);
        await expect(c.query(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'crm')`, [orgId, g.grantId])).rejects.toThrow(/KILL_SWITCH_ON/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, g.grantId, ENGAGE]);
        await expect(c.query(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'ads')`, [orgId, g.grantId])).resolves.toBeDefined();
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    } finally {
      await releaseAll();
    }
  });
});
