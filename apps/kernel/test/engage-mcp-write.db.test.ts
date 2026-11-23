// SPDX-License-Identifier: AGPL-3.0-only
// The R1 write tools of the Engage coworkers (#3861, E2 of #3857) as the runtime runs them for a company grant that holds `ludy.engage.write` (and `ludy.ads.draft` for the ads draft): the twins of the app's
// Hộp thư and CRM commands. Each does what a person's click does, in the grant's sealed write context, and this file pins what that looks like: the rows that change, who they name, that a contact the
// agent adds is `external`, that the audit row names the grant, the client and the agent, and that every refusal holds (a grant without the scope, a member-bound grant, another org's rows, a person's
// command the grant has no twin of). The database's own bounds, row by row, are in test/invariant/mcp-engage-write.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { Deal, PipelineStage, Quote, QuoteSent } from '@ludy/kernel-contract';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { adsCommands, adsQueries } from '@ludy/mod-ads';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';

suite('the Engage R1 write tools (#3861)', () => {
  const dbName = `crove_test_engage_mcp_write_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const channel: Record<string, string> = {};
  let thread = '';
  let threadB = '';
  let identity = '';
  let adAccount = '';

  const browser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
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
  let counter = 0;
  async function grantFor(who: string, org: string, scopes: string[], kind: 'company' | 'member' = 'company') {
    const id = randomUUID();
    counter += 1;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Dy test client', 'client.example.com', $5::text[], $6, clock_timestamp(), now() + interval '30 days', $3, $7, $8)`,
      [org, id, users[who], `client-${counter}-${id}`, scopes, `oauth-${id}`, kind, kind === 'member' ? users[who] : null],
    );
    const actor: UserActor = { type: 'user', userId: users[who] as string, aal: 'aal1', mcp: { grantId: id, clientId: `client-${counter}-${id}`, clientName: 'Dy test client', scopes, kind } };
    return { actor, orgId: org, grantId: id };
  }
  const dy = (who = 'owner', org = orgA) => grantFor(who, org, ['ludy.read', ENGAGE]);
  const run = async <T = unknown>(name: string, input: unknown, g?: { actor: UserActor; orgId: string }) =>
    runtime.execute<T>(name, input, g ?? (await dy())).catch((error: unknown) => {
      if (process.env.DEBUG_E2) console.error(name, (error as { cause?: unknown }).cause ?? error);
      throw error;
    });
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  const one = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => (await sqlAdmin<R>(text, params)).rows[0] as R;

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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...adsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...adsQueries],
    });
    for (const key of ['owner', 'admin', 'member', 'viewer', 'foreign']) {
      users[key] = await upsertIdentity(db, { issuer: 'engage-mcp-write', subject: key, email: `${key}@engage-mcp-write.test`, name: key });
    }
    orgA = (await createOrg(runtime, browser('owner'), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser('foreign'), 'Org B')).orgId;
    for (const [who, role] of [['admin', 'admin'], ['member', 'member'], ['viewer', 'viewer']] as const) {
      await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgA, users[who], role]);
    }
    for (const [key, org, owner] of [['a1', orgA, users.owner], ['b1', orgB, users.foreign]] as const) {
      channel[key] = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, $4, $5)`, [org, channel[key], `ext-${key}`, `Trang ${key}`, owner]);
    }
    const seed = async (org: string, ch: string, key: string) => {
      const id = randomUUID();
      const ident = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, 'Khách thử')`, [org, ident, `u-${key}-12345678`]);
      await sqlAdmin(
        `INSERT INTO ludy_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at)
         VALUES ($1, $2, $3, 'comment_thread', $4, $5, 1, now(), now())`,
        [org, id, ch, `t-${key}`, ident],
      );
      await sqlAdmin(
        `INSERT INTO ludy_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted, author_identity_id)
         VALUES ($1, $2, $3, $4, 'comment_thread', 1, 'in', now(), 'contact', 'Cho mình hỏi giá', true, $5)`,
        [org, randomUUID(), id, ch, ident],
      );
      return { id, ident };
    };
    const a = await seed(orgA, channel.a1 as string, 'a');
    thread = a.id;
    identity = a.ident;
    threadB = (await seed(orgB, channel.b1 as string, 'b')).id;
    const connection = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'act-1', 'Tài khoản QC', $3)`, [orgA, connection, users.owner]);
    adAccount = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'Tài khoản QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [orgA, adAccount, connection]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('works a thread: takes it, adds a note, links a contact, resolves it and reopens it, each as the grant, and audits the grant, the client and the agent', async () => {
    const g = await dy();
    await run('kernel.mcp.conversation_assign', { conversationId: thread, assigneeUserId: users.member }, g);
    expect(await one(`SELECT assignee_user_id, status FROM ludy_kernel.conversation WHERE id = $1`, [thread])).toMatchObject({ assignee_user_id: users.member });
    const note = await run<{ noteId: string }>('kernel.mcp.conversation_note', { conversationId: thread, body: 'Khách hỏi giá, đã gửi bảng giá. (Dy)' }, g);
    expect(await one(`SELECT author_user_id, body FROM ludy_kernel.conversation_note WHERE id = $1`, [note.noteId])).toMatchObject({ author_user_id: users.owner });
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'person', name: 'Khách Dy tạo', phone: '0901234567' }, g);
    await run('kernel.mcp.conversation_link_contact', { conversationId: thread, partyId: party.partyId }, g);
    expect((await one(`SELECT party_id FROM ludy_kernel.conversation WHERE id = $1`, [thread])).party_id).toBe(party.partyId);
    await run('kernel.mcp.conversation_resolve', { conversationId: thread }, g);
    expect(await one(`SELECT status, resolved_by FROM ludy_kernel.conversation WHERE id = $1`, [thread])).toMatchObject({ status: 'resolved', resolved_by: users.owner });
    await run('kernel.mcp.conversation_reopen', { conversationId: thread }, g);
    expect((await one(`SELECT status FROM ludy_kernel.conversation WHERE id = $1`, [thread])).status).toBe('new');
    // The audit trail of the calls names the grant, the client and the agent (the grant).
    const audit = await sqlAdmin<{ command: string; outcome: string; detail: Record<string, unknown> }>(
      `SELECT command, outcome, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND detail ->> 'mcpGrant' = $2 AND command LIKE 'kernel.mcp.%' ORDER BY occurred_at`,
      [orgA, g.grantId],
    );
    expect(audit.rows.map((r) => [r.command, r.outcome])).toEqual([
      ['kernel.mcp.conversation_assign', 'ok'],
      ['kernel.mcp.conversation_note', 'ok'],
      ['kernel.mcp.party_create', 'ok'],
      ['kernel.mcp.conversation_link_contact', 'ok'],
      ['kernel.mcp.conversation_resolve', 'ok'],
      ['kernel.mcp.conversation_reopen', 'ok'],
    ]);
    for (const r of audit.rows) expect(r.detail).toMatchObject({ mcpCall: true, mcpGrant: g.grantId, mcpClientName: 'Dy test client' });
    // A person's own timeline row, made by a connected app, names the person (the grant is no org-chart agent).
    expect(await one(`SELECT actor_id, agent_id FROM ludy_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'party.created'`, [orgA, party.partyId])).toMatchObject({ actor_id: users.owner, agent_id: null });
  });

  it('links a contact and takes a thread although a colleague resolved another thread of the same customer', async () => {
    // The link also reaches the customer's other threads of the same kind; one that another member resolved keeps who resolved it.
    const other = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at, status, resolved_at, resolved_by)
       VALUES ($1, $2, $3, 'comment_thread', 't-a-older', $4, 1, now(), now(), 'resolved', now(), $5)`,
      [orgA, other, channel.a1, identity, users.admin],
    );
    const g = await dy();
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'person', name: 'Khách quay lại' }, g);
    await run('kernel.mcp.conversation_link_contact', { conversationId: thread, partyId: party.partyId }, g);
    expect(await one(`SELECT party_id, resolved_by FROM ludy_kernel.conversation WHERE id = $1`, [other])).toMatchObject({ party_id: party.partyId, resolved_by: users.admin });
    await run('kernel.mcp.conversation_assign', { conversationId: other, assigneeUserId: users.member }, g);
    expect(await one(`SELECT assignee_user_id, resolved_by FROM ludy_kernel.conversation WHERE id = $1`, [other])).toMatchObject({ assignee_user_id: users.member, resolved_by: users.admin });
  });

  it('adds a contact as an outside value, never one a person vouched for', async () => {
    const made = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: 'Công ty Dy thêm', email: 'ketoan@example.com' });
    expect(await one(`SELECT source_trust, name FROM ludy_kernel.party WHERE id = $1`, [made.partyId])).toMatchObject({ source_trust: 'external', name: 'Công ty Dy thêm' });
    // The tax code is unique, as for a person.
    const tax = '0312345678';
    await run('kernel.mcp.party_create', { kind: 'organization', name: 'Công ty có MST', taxCode: tax });
    expect((await refusal(run('kernel.mcp.party_create', { kind: 'organization', name: 'Trùng MST', taxCode: tax }))).code).toBe('PARTY_TAX_CODE_TAKEN');
  });

  it('opens a deal, moves it, drafts a quote, and the person finds them as any other', async () => {
    const g = await dy();
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: 'Khách có cơ hội' }, g);
    const deal = await run<Deal>('crm.mcp.deal_create', { partyId: party.partyId, title: 'Gói quảng cáo tháng 12', amount: '12000000', expectedClose: null, ownerUserId: users.member }, g);
    expect(await one(`SELECT created_by, updated_by, owner_user_id, title FROM ludy_crm.deal WHERE id = $1`, [deal.id])).toMatchObject({ created_by: users.owner, updated_by: users.owner, owner_user_id: users.member, title: 'Gói quảng cáo tháng 12' });
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, { actor: browser('owner'), orgId: orgA });
    const second = stages.find((s) => s.kind === 'open' && s.id !== deal.stageId) as PipelineStage;
    const moved = await run<Deal>('crm.mcp.deal_move', { dealId: deal.id, version: deal.version, stageId: second.id }, g);
    expect(moved.stageId).toBe(second.id);
    const quote = await run<Quote>('crm.mcp.quote_save', { dealId: deal.id, lines: [] }, g);
    expect(quote.status).toBe('draft');
    const saved = await run<Quote>('crm.mcp.quote_save', { quoteId: quote.id, version: quote.version, lines: [{ kind: 'item', description: 'Chạy quảng cáo', quantity: '1', unitPrice: '12000000', vatRate: '10' }] }, g);
    expect(saved.lines).toHaveLength(1);
    expect(await one(`SELECT count(*)::int AS n FROM ludy_crm.quote_line WHERE quote_id = $1`, [quote.id])).toMatchObject({ n: 1 });
    // A quote a person sent is revised into a new draft by the agent; sending it stays a person's.
    const sent = (await runtime.execute<QuoteSent>('crm.quote.send', { quoteId: saved.id, version: saved.version, via: 'link' }, { actor: browser('owner'), orgId: orgA })).quote;
    const revised = await run<Quote>('crm.mcp.quote_revise', { quoteId: sent.id }, g);
    expect(revised).toMatchObject({ status: 'draft', revision: 2 });
    expect((await refusal(run('crm.quote.send', { quoteId: revised.id, version: revised.version, via: 'link' }, g))).details).toMatchObject({ rule: 'mcp_scope' });
  });

  it('marks a next step done and snoozes another', async () => {
    const g = await dy();
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'person', name: 'Khách bước tiếp' }, g);
    const d1 = await run<Deal>('crm.mcp.deal_create', { partyId: party.partyId, title: 'Cơ hội 1', amount: '1000000', expectedClose: null }, g);
    const d2 = await run<Deal>('crm.mcp.deal_create', { partyId: party.partyId, title: 'Cơ hội 2', amount: '2000000', expectedClose: null }, g);
    const step = async (deal: string) => (await one<{ id: string }>(`INSERT INTO ludy_crm.deal_next_step (org_id, deal_id, reason, since_on) VALUES ($1, $2, 'no_activity', '2026-10-01') RETURNING id`, [orgA, deal])).id;
    const [s1, s2] = [await step(d1.id), await step(d2.id)];
    expect(await run('crm.mcp.next_step_done', { nextStepIds: [s1] }, g)).toMatchObject({ changed: [s1] });
    expect(await one(`SELECT status, resolved_by FROM ludy_crm.deal_next_step WHERE id = $1`, [s1])).toMatchObject({ status: 'done', resolved_by: users.owner });
    expect(await run('crm.mcp.next_step_snooze', { nextStepIds: [s2], days: 7 }, g)).toMatchObject({ changed: [s2] });
    expect((await one<{ snoozed_until: Date }>(`SELECT snoozed_until FROM ludy_crm.deal_next_step WHERE id = $1`, [s2])).snoozed_until).toBeTruthy();
  });

  it('saves an ads draft for a person to read, marked as the AI app\'s, and nothing launches', async () => {
    const g = await grantFor('owner', orgA, ['ludy.read', ADS]);
    const view = await run<{ id: string; origin: string; aiFields: string[]; status: string }>('ads.mcp.campaign_draft_save', { adAccountId: adAccount, plan: { name: 'Khuyến mãi 12', objective: 'traffic', dailyBudget: '200000' } }, g);
    expect(view).toMatchObject({ origin: 'ai', status: 'draft' });
    expect(view.aiFields.sort()).toEqual(['dailyBudget', 'name', 'objective']);
    expect(await one(`SELECT origin, created_by, status FROM ludy_ads.ad_campaign_draft WHERE id = $1`, [view.id])).toMatchObject({ origin: 'ai', created_by: users.owner, status: 'draft' });
    // The engage scope does not open it, and the ads scope does not open the engage commands.
    expect((await refusal(run('ads.mcp.campaign_draft_save', { adAccountId: adAccount, plan: { name: 'x', objective: 'traffic' } }))).details).toMatchObject({ rule: 'mcp_scope' });
    expect((await refusal(run('kernel.mcp.conversation_resolve', { conversationId: thread }, g))).details).toMatchObject({ rule: 'mcp_scope' });
  });

  it('refuses without the scope, for a member-bound grant, and for every command the grant has no twin of', async () => {
    const readOnly = await grantFor('owner', orgA, ['ludy.read']);
    const calls: Array<[string, unknown]> = [
      ['kernel.mcp.conversation_resolve', { conversationId: thread }],
      ['kernel.mcp.party_create', { kind: 'person', name: 'x' }],
      ['crm.mcp.deal_create', { partyId: randomUUID(), title: 'x', amount: '1', expectedClose: null }],
    ];
    for (const [name, input] of calls) {
      const err = await refusal(run(name, input, readOnly));
      expect([err.code, err.status, err.details]).toEqual(['FORBIDDEN', 403, expect.objectContaining({ rule: 'mcp_scope' })]);
    }
    // A member-bound grant (a member's own app) never writes: it cannot hold the scope, and a claim of it is refused.
    const memberGrant = await grantFor('member', orgA, ['ludy.member.read'], 'member');
    const claimed: UserActor = { ...memberGrant.actor, mcp: { ...(memberGrant.actor as { mcp: object }).mcp, scopes: [ENGAGE] } as never };
    expect((await refusal(run('kernel.mcp.conversation_resolve', { conversationId: thread }, { actor: claimed, orgId: orgA }))).status).toBe(403);
    // The person's own commands and the ones above R1 have no twin: closed to the grant whatever it holds.
    const own: Array<[string, unknown]> = [
      ['kernel.conversation.resolve', { conversationId: thread }],
      ['kernel.conversation.note', { conversationId: thread, body: 'x' }],
      ['kernel.conversation.follow_up', { conversationId: thread, title: 'x', assigneePositionId: null }],
      ['crm.deal.create', { partyId: randomUUID(), title: 'x', amount: '1', expectedClose: null }],
      ['crm.quote.send', { quoteId: randomUUID(), version: 1, via: 'link' }],
    ];
    for (const [name, input] of own) {
      const err = await refusal(run(name, input, await dy()));
      expect(err.details, name).toMatchObject({ rule: 'mcp_scope' });
    }
    expect((await one(`SELECT status FROM ludy_kernel.conversation WHERE id = $1`, [thread])).status).not.toBe('resolved');
  });

  it('keeps to its own org: another org\'s thread is not found, and a grant of org B cannot work org A', async () => {
    expect((await refusal(run('kernel.mcp.conversation_resolve', { conversationId: threadB }))).code).toBe('CONVERSATION_NOT_FOUND');
    const foreign = await dy('foreign', orgB);
    expect((await refusal(run('kernel.mcp.conversation_resolve', { conversationId: thread }, foreign))).code).toBe('CONVERSATION_NOT_FOUND');
    expect((await refusal(run('kernel.mcp.conversation_resolve', { conversationId: thread }, { actor: foreign.actor, orgId: orgA }))).status).toBe(401);
  });

  it('refuses the very next write when the grant is revoked or the grantor is demoted to a member', async () => {
    const g = await dy('admin');
    await run('kernel.mcp.conversation_note', { conversationId: thread, body: 'trước khi thu hồi' }, g);
    await sqlAdmin(`UPDATE ludy_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [g.grantId]);
    expect((await refusal(run('kernel.mcp.conversation_note', { conversationId: thread, body: 'sau khi thu hồi' }, g))).status).toBe(401);
    const g2 = await dy('admin');
    await sqlAdmin(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.admin]);
    expect((await refusal(run('kernel.mcp.conversation_note', { conversationId: thread, body: 'sau khi bị hạ quyền' }, g2))).status).toBe(401);
    await sqlAdmin(`UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgA, users.admin]);
    expect(identity).toBeTruthy();
  });
});
