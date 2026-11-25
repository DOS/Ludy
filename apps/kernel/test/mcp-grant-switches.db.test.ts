// SPDX-License-Identifier: AGPL-3.0-only
// The module and coworker switches at the write and proposal entries of an MCP grant (#4155), as product flows. The refusals themselves, each audited as the grant's, and the EXECUTE matrix of the check are the
// security line and live in test/invariant/mcp-grant-switches.db.test.ts. This file pins what a person sees around them: a released switch lets the very next call of each entry through (a module's switch and
// an agent switch naming the grant), and so does an app the org switched back on, a switch of another module does not touch a call, a Hộp thư proposal is judged on the kernel and not on another module, and a person's own command is untouched.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type UserActor } from '@ludy/kernel-runtime';
import { ADMIN, ADS_SCOPE, ENGAGE_SCOPE, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const SOCIAL_SCOPE = 'ludy.social.draft';

suite('the module and coworker switches at an MCP grant entry (#4155)', () => {
  let h: Harness;
  let adAccount = '';
  let socialChannel = '';
  let counter = 0;

  const owner = () => h.person(h.owner);
  const stepUp = () => h.person(h.owner, true);
  // The person's own switches, through their commands.
  const stopModule = async (target: string) => (await h.runtime.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'module', target }, { actor: owner(), orgId: h.orgId })).killSwitchId;
  const release = (id: string) => h.runtime.execute('kernel.agent.kill_switch.release', { id }, { actor: stepUp(), orgId: h.orgId });
  const setApp = (module: string, enabled: boolean) => h.runtime.execute('kernel.org.set_app', { module, enabled }, { actor: owner(), orgId: h.orgId, idempotencyKey: randomUUID() });
  // A switch of scope `agent` naming a grant: the table accepts it (a uuid), though no command makes one for a grant today.
  async function stopGrant(grantId: string): Promise<string> {
    const r = await h.q<{ id: string }>(`INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, reason, engaged_by) VALUES ($1, 'agent', $2, 'test', $3) RETURNING id`, [h.orgId, grantId, h.owner]);
    return r.rows[0]?.id as string;
  }
  const releaseRow = (id: string) => h.q(`UPDATE ludy_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND id = $3`, [h.orgId, h.owner, id]);

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
    { label: 'the kernel R1 twin (Hộp thư)', module: 'kernel', scope: ENGAGE_SCOPE, command: 'kernel.mcp.party_create', input: () => ({ kind: 'person', name: `Khách ${counter++}` }), count: () => rows('ludy_kernel.party') },
    { label: 'the CRM R1 twin', module: 'crm', scope: ENGAGE_SCOPE, command: 'crm.mcp.deal_create', input: () => ({ partyId: party, title: `Cơ hội ${counter++}`, amount: '1000000', expectedClose: null }), count: () => rows('ludy_crm.deal') },
    { label: 'the Ads draft', module: 'ads', scope: ADS_SCOPE, command: 'ads.mcp.campaign_draft_save', input: () => ({ adAccountId: adAccount, plan: { name: `Nháp ${counter++}`, objective: 'traffic', dailyBudget: '200000' } }), count: () => rows('ludy_ads.ad_campaign_draft') },
    { label: 'the Social draft', module: 'social', scope: SOCIAL_SCOPE, command: 'social.mcp.draft_create', input: () => ({ body: `Bài ${counter++}`, channels: [{ connectionId: socialChannel }] }), count: () => rows('ludy_social.post') },
  ];
  let party = '';

  const call = (e: Entry, g: { actor: UserActor }) => h.runtime.execute(e.command, e.input(), { actor: g.actor, orgId: h.orgId });

  beforeAll(async () => {
    if (!ADMIN) return;
    h = await startHarness('mcp_switches');
    party = (await h.q<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name, source_trust) VALUES ($1, 'person', 'Khách có sẵn', 'user') RETURNING id`, [h.orgId])).rows[0]?.id as string;
    const connection = randomUUID();
    await h.q(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'act-1', 'Tài khoản QC', $3)`, [h.orgId, connection, h.owner]);
    adAccount = randomUUID();
    await h.q(`INSERT INTO ludy_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'Tài khoản QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [h.orgId, adAccount, connection]);
    socialChannel = randomUUID();
    await h.q(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-social-1', 'Trang', $3)`, [h.orgId, socialChannel, h.owner]);
  }, 300_000);

  afterAll(async () => {
    if (h) await h.stop();
  });

  for (const e of entries) {
    it(`runs ${e.label} again as soon as its module's switch is released, and a switch of another module never touched it`, async () => {
      const g = await h.grant([e.scope]);
      const before = await e.count();
      const other = await stopModule(e.module === 'crm' ? 'ads' : 'crm');
      try {
        await call(e, g);
        expect(await e.count()).toBe(before + 1);
        const id = await stopModule(e.module);
        // The refused call is what the count check watches: it writes nothing while the switch is engaged.
        await expect(call(e, g)).rejects.toMatchObject({ code: 'KILL_SWITCH_ON' });
        expect(await e.count()).toBe(before + 1);
        await release(id);
        await call(e, g);
        expect(await e.count()).toBe(before + 2);
      } finally {
        await h.q(`UPDATE ludy_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND released_at IS NULL`, [h.orgId, h.owner]);
      }
      expect(other).toBeTruthy();
    });

    // The kernel cannot be switched off (the app gate never refuses a kernel command), so only the apps have this case.
    if (e.module !== 'kernel') {
      it(`runs ${e.label} again as soon as the org switches the app back on`, async () => {
        const g = await h.grant([e.scope]);
        const before = await e.count();
        await setApp(e.module, false);
        try {
          await expect(call(e, g)).rejects.toMatchObject({ code: 'MODULE_OFF' });
          expect(await e.count()).toBe(before);
        } finally {
          await setApp(e.module, true);
        }
        await call(e, g);
        expect(await e.count()).toBe(before + 1);
      });
    }

    it(`runs ${e.label} again as soon as the agent switch naming the grant is released`, async () => {
      const g = await h.grant([e.scope]);
      const before = await e.count();
      const id = await stopGrant(g.grantId);
      try {
        await releaseRow(id);
        await call(e, g);
        expect(await e.count()).toBe(before + 1);
      } finally {
        await releaseRow(id);
      }
    });
  }

  const pending = async (command: string) => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.proposal WHERE org_id = $1 AND command = $2 AND status = 'pending'`, [h.orgId, command])).rows[0]?.n ?? 0;

  it('lets a proposal through again once the switches are released', async () => {
    const g = await h.grant([ADS_SCOPE]);
    const command = 'ads.pause_all_approved';
    const before = await pending(command);
    const stopped = await stopModule('ads');
    await release(stopped);
    const grantStop = await stopGrant(g.grantId);
    await releaseRow(grantStop);
    expect((await h.propose(g.actor, command, {})).status).toBe('pending');
    expect(await pending(command)).toBe(before + 1);
  });

  it('judges a kernel proposal (a Hộp thư action) on the kernel switch and never on another module\'s', async () => {
    const g = await h.grant([ENGAGE_SCOPE]);
    const command = 'kernel.conversation.hide_approved';
    const other = await stopModule('ads');
    try {
      // Another module's switch does not touch it: the call goes on to be judged as the twin judges it (it names no real message here, so it is the twin's own refusal, not a switch's).
      const unaffected = await h.propose(g.actor, command, { messageId: randomUUID(), hidden: true }).then(
        () => null,
        (error: unknown) => error as DomainError,
      );
      expect(unaffected?.code).not.toBe('KILL_SWITCH_ON');
    } finally {
      await release(other);
    }
    // The app gate never refuses a kernel command: the kernel cannot be switched off.
    await expect(setApp('kernel', false)).rejects.toBeInstanceOf(DomainError);
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
