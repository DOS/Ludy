// SPDX-License-Identifier: AGPL-3.0-only
// The module and coworker switches at the write and proposal entries of an MCP grant (#4155, a follow-up of the shared-core review of #4150; ADR-0051 decisions 10 and 11, ADR-0053).
// A person who switches an app off, or stops one coworker, expects the AI app to stop at once. For each entry a company grant has (the Engage R1 twins of the kernel and CRM, the Social draft, the Ads draft,
// and the proposal entry that asks a person for something above R1) this pins that:
//   - an engaged kill switch of scope `module` for the command's module refuses the call with KILL_SWITCH_ON (403) and writes the grant's refusal row, and nothing is written;
//   - an engaged kill switch of scope `agent` naming the grant refuses it, and another grant of the same org is not touched;
//   - an app the org switched off (ADR-0053, `apps_off`) answers MODULE_OFF (404) with the same audit row, for a write and for a proposal (the gate reads the module of the command the proposal is for);
//   - the call runs again once the switch is released, so the refusal is the switch and nothing else.
// A kernel command is never refused by the app gate, and a switch of another module does not touch it. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type UserActor } from '@crove/kernel-runtime';
import { ADMIN, ADS_SCOPE, ENGAGE_SCOPE, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const SOCIAL_SCOPE = 'ludy.social.draft';

suite('the module and coworker switches at an MCP grant entry (#4155)', () => {
  let h: Harness;
  let adAccount = '';
  let socialChannel = '';
  let counter = 0;

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  const owner = () => h.person(h.owner);
  const stepUp = () => h.person(h.owner, true);
  // The person's own switches, through their commands.
  const stopModule = async (target: string) => (await h.runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target }, { actor: owner(), orgId: h.orgId })).killSwitchId;
  const release = (id: string) => h.runtime.execute('kernel.agent.kill_switch.release', { id }, { actor: stepUp(), orgId: h.orgId });
  const setApp = (module: string, enabled: boolean) => h.runtime.execute('kernel.org.set_app', { module, enabled }, { actor: owner(), orgId: h.orgId, idempotencyKey: randomUUID() });
  // A switch of scope `agent` naming a grant: the table accepts it (a uuid), though no command makes one for a grant today.
  async function stopGrant(grantId: string): Promise<string> {
    const r = await h.q<{ id: string }>(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, reason, engaged_by) VALUES ($1, 'agent', $2, 'test', $3) RETURNING id`, [h.orgId, grantId, h.owner]);
    return r.rows[0]?.id as string;
  }
  const releaseRow = (id: string) => h.q(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND id = $3`, [h.orgId, h.owner, id]);

  // Every refusal of a grant's call is audited as the grant's, under the command's own name.
  async function audited(command: string, grantId: string, outcome = 'denied') {
    const rows = (await h.q<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $4 AND detail ->> 'mcpGrant' = $3`, [h.orgId, command, grantId, outcome])).rows;
    expect(rows.length, `${command} ${outcome} audit rows of the grant`).toBeGreaterThan(0);
    expect(rows[0]?.detail).toMatchObject({ mcpCall: true, mcpGrant: grantId });
  }

  interface Entry {
    label: string;
    module: string;
    scope: string;
    command: string;
    input: () => unknown;
    count: () => Promise<number>;
  }
  const rows = async (table: string) => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [h.orgId])).rows[0]?.n ?? 0;
  const entries: Entry[] = [
    { label: 'the kernel R1 twin (Hộp thư)', module: 'kernel', scope: ENGAGE_SCOPE, command: 'kernel.mcp.party_create', input: () => ({ kind: 'person', name: `Khách ${counter++}` }), count: () => rows('crove_kernel.party') },
    { label: 'the CRM R1 twin', module: 'crm', scope: ENGAGE_SCOPE, command: 'crm.mcp.deal_create', input: () => ({ partyId: party, title: `Cơ hội ${counter++}`, amount: '1000000', expectedClose: null }), count: () => rows('crove_crm.deal') },
    { label: 'the Ads draft', module: 'ads', scope: ADS_SCOPE, command: 'ads.mcp.campaign_draft_save', input: () => ({ adAccountId: adAccount, plan: { name: `Nháp ${counter++}`, objective: 'traffic', dailyBudget: '200000' } }), count: () => rows('crove_ads.ad_campaign_draft') },
    { label: 'the Social draft', module: 'social', scope: SOCIAL_SCOPE, command: 'social.mcp.draft_create', input: () => ({ body: `Bài ${counter++}`, channels: [{ connectionId: socialChannel }] }), count: () => rows('crove_social.post') },
  ];
  let party = '';

  const call = (e: Entry, g: { actor: UserActor }) => h.runtime.execute(e.command, e.input(), { actor: g.actor, orgId: h.orgId });

  beforeAll(async () => {
    if (!ADMIN) return;
    h = await startHarness('mcp_switches');
    party = (await h.q<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, source_trust) VALUES ($1, 'person', 'Khách có sẵn', 'user') RETURNING id`, [h.orgId])).rows[0]?.id as string;
    const connection = randomUUID();
    await h.q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'act-1', 'Tài khoản QC', $3)`, [h.orgId, connection, h.owner]);
    adAccount = randomUUID();
    await h.q(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'Tài khoản QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [h.orgId, adAccount, connection]);
    socialChannel = randomUUID();
    await h.q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-social-1', 'Trang', $3)`, [h.orgId, socialChannel, h.owner]);
  }, 300_000);

  afterAll(async () => {
    if (h) await h.stop();
  });

  for (const e of entries) {
    it(`stops ${e.label} at the entry when its module's switch is engaged, and runs it again when released`, async () => {
      const g = await h.grant([e.scope]);
      await call(e, g);
      const before = await e.count();
      const id = await stopModule(e.module);
      const other = await stopModule(e.module === 'crm' ? 'ads' : 'crm');
      try {
        const err = await refusal(call(e, g));
        expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
        expect(await e.count()).toBe(before);
        await audited(e.command, g.grantId);
        // The switch of another module does not touch it.
        await release(id);
        await call(e, g);
        expect(await e.count()).toBe(before + 1);
      } finally {
        // A failed assertion must not leave a switch engaged for the next test (one active row per scope and target).
        await h.q(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND released_at IS NULL`, [h.orgId, h.owner]);
      }
      expect(other).toBeTruthy();
    });

    it(`stops ${e.label} when an agent switch names the grant, and only that grant`, async () => {
      const g = await h.grant([e.scope]);
      const sibling = await h.grant([e.scope]);
      const id = await stopGrant(g.grantId);
      try {
        const before = await e.count();
        const err = await refusal(call(e, g));
        expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
        expect(await e.count()).toBe(before);
        await audited(e.command, g.grantId);
        await call(e, sibling);
        expect(await e.count()).toBe(before + 1);
        await releaseRow(id);
        await call(e, g);
        expect(await e.count()).toBe(before + 2);
      } finally {
        await releaseRow(id);
      }
    });

    if (e.module !== 'kernel') {
      it(`refuses ${e.label} with MODULE_OFF at the entry when the org switched the app off, and audits it as the grant's`, async () => {
        const g = await h.grant([e.scope]);
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
        await call(e, g);
        expect(await e.count()).toBe(before + 1);
      });
    }
  }

  const pending = async (command: string) => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE org_id = $1 AND command = $2 AND status = 'pending'`, [h.orgId, command])).rows[0]?.n ?? 0;

  it('asks for nothing above R1 while the command\'s module is switched off or stopped, and while the grant is stopped', async () => {
    const g = await h.grant([ADS_SCOPE]);
    const command = 'ads.pause_all_approved';
    const before = await pending(command);
    // A proposal for an Ads command is judged on the Ads switch (the module of the command it is for), not the proposer's, which is the kernel's.
    const stopped = await stopModule('ads');
    const err = await refusal(h.propose(g.actor, command, {}));
    expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
    expect(await pending(command)).toBe(before);
    await audited(command, g.grantId);
    await release(stopped);
    await setApp('ads', false);
    try {
      const off = await refusal(h.propose(g.actor, command, {}));
      expect([off.code, off.status]).toEqual(['MODULE_OFF', 404]);
      expect(await pending(command)).toBe(before);
      await audited(command, g.grantId, 'failed');
    } finally {
      await setApp('ads', true);
    }
    const grantStop = await stopGrant(g.grantId);
    expect((await refusal(h.propose(g.actor, command, {}))).code).toBe('KILL_SWITCH_ON');
    expect(await pending(command)).toBe(before);
    await releaseRow(grantStop);
    expect((await h.propose(g.actor, command, {})).status).toBe('pending');
    expect(await pending(command)).toBe(before + 1);
  });

  it('judges a kernel proposal (a Hộp thư action) on the kernel switch and the grant\'s, and never on another module\'s', async () => {
    const g = await h.grant([ENGAGE_SCOPE]);
    const command = 'kernel.conversation.hide_approved';
    const payload = { messageId: randomUUID(), hidden: true };
    const other = await stopModule('ads');
    // Another module's switch does not touch it: the call goes on to be judged as the twin judges it (it names no real message here, so it is the twin's own refusal, not a switch's).
    const unaffected = await h.propose(g.actor, command, payload).then(
      () => null,
      (error: unknown) => error as DomainError,
    );
    expect(unaffected?.code).not.toBe('KILL_SWITCH_ON');
    await release(other);
    const kernelStop = await stopModule('kernel');
    const err = await refusal(h.propose(g.actor, command, payload));
    expect([err.code, err.status]).toEqual(['KILL_SWITCH_ON', 403]);
    await audited(command, g.grantId);
    await release(kernelStop);
    // The app gate never refuses a kernel command.
    await expect(setApp('kernel', false)).rejects.toBeInstanceOf(DomainError);
  });

  it('gives the switch check to the API login alone, with a pinned search path, and refuses a module name that is not one', async () => {
    const fn = 'crove_kernel.mcp_switch_check(uuid,uuid,text)';
    const logins = (await h.q<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper`)).rows.map((r) => r.rolname);
    expect(logins).toContain('crove_app');
    for (const rolname of logins) {
      const ok = (await h.q<{ ok: boolean }>(`SELECT has_function_privilege($1, '${fn}', 'EXECUTE') AS ok`, [rolname])).rows[0]?.ok;
      expect(ok, `${rolname} executes the switch check`).toBe(rolname === 'crove_app');
    }
    expect((await h.q<{ ok: boolean }>(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS ok`)).rows[0]?.ok).toBe(false);
    expect((await h.q(`SELECT proconfig FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0]).toEqual({ proconfig: ['search_path=pg_catalog, pg_temp'] });
    await expect(h.q(`SELECT crove_kernel.mcp_switch_check($1::uuid, $2::uuid, 'Not A Module')`, [h.orgId, randomUUID()])).rejects.toThrow(/MCP_GRANT_SCOPE/);
  });

  it('does not touch a person\'s own command: the owner still works while the AI of the same module is stopped', async () => {
    const stopped = await stopModule('crm');
    try {
      const made = await h.runtime.execute<{ id: string }>('crm.deal.create', { partyId: party, title: 'Người tạo', amount: '1', expectedClose: null }, { actor: owner(), orgId: h.orgId });
      expect(made.id).toBeTruthy();
    } finally {
      await release(stopped);
    }
  });
});
