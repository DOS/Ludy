// SPDX-License-Identifier: AGPL-3.0-only
// Engage's wake rules against a real database (#3862, E3 of epic #3857; ADR-0051 decision 13): the deterministic rules, with no model, that tell the AI coworkers there is work.
//   - the org's N (hours, days) is the inbox settings row's: defaults with no row, set by an owner or admin, refused to a member, bounded; the quote follow-up of the CRM raises after it;
//   - the conversation read (`kernel.wake.conversations`) answers ids, a kind and instants only, as a member (Home) and as a company grant in its sealed context;
//   - Home shows the rules with no agent connected (`kernel.today`): the inbox's three, and the CRM's quote follow-up and booking tomorrow;
//   - the sweep sends each rule's event once per item per window (its own "seen" key, kept with the event), again for a new window, only to a company grant that holds the line's scope, and never a name,
//     a message, a note or a deal's title: the bodies hold ids, days, amounts and enum words (the canary strings of the data never leave);
//   - the database refuses what the sweep would never send: a key that is not the type's own, a second event for a seen key.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { Deal, EngageWakeConversations, EngageWakeCrm, EngageWakeRulesView, PipelineStage, TodayList } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, type UserActor } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { LINE_WAKE_EVENTS, wakeBody } from '../src/mcp-wake-body.ts';
import { adsItems, conversationItems, crmItems, engageWakeFeed, wakeKey } from '../src/mcp-wake-engage.ts';
import { runWakeSweep, type LineWakeFeed } from '../src/mcp-wake-sweep.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
// Words a customer, a deal and a note carry: none may reach a wake body.
const CANARY = 'Nguyễn Văn Canary 7777';
const DEAL_TITLE = 'Hợp đồng bí mật của anh Canary';
const ALL_SCOPES = ['ludy.read', 'ludy.engage.write', 'ludy.social.draft', 'ludy.ads.draft'];

suite('Engage wake rules on PostgreSQL (#3862)', () => {
  const dbName = `crove_test_engage_wake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@wake.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, name: string, input: unknown = {}) => rt.query<T>(name, input, { actor: asUser(user), orgId });

    // A channel and the threads of this org. `sinceMinutes`: how long the customer's oldest unanswered message has waited.
    const channel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, $4, $5)`, [orgId, channel, `ext-${channel.slice(0, 8)}`, `Trang ${CANARY}`, owner]);
    const thread = async (opts: { kind: 'direct' | 'email' | 'comment_thread'; sinceMinutes: number; status?: string; windowMinutes?: number; post?: boolean; answeredBeforeMinutes?: number }) => {
      const id = randomUUID();
      const identity = randomUUID();
      await rows(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, $4)`, [orgId, identity, `u-${id.slice(0, 8)}`, CANARY]);
      await rows(
        `INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, external_post_id, identity_id, status, last_seq, last_inbound_at, reply_window_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 3, now() - make_interval(mins => $9), CASE WHEN $10::int IS NULL THEN NULL ELSE now() + make_interval(mins => $10::int) END)`,
        [orgId, id, channel, opts.kind, `t-${id}`, opts.post ? `post-${id.slice(0, 8)}` : null, identity, opts.status ?? 'new', opts.sinceMinutes, opts.windowMinutes ?? null],
      );
      let seq = 1;
      if (opts.answeredBeforeMinutes !== undefined) {
        // The customer wrote, the org answered, then the customer wrote again: the wait counts from the later message.
        await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, tainted) VALUES ($1, $2, $3, $4, 1, 'in', now() - make_interval(mins => $5), now() - make_interval(mins => $5), 'contact', $6, true)`, [orgId, id, channel, opts.kind, opts.answeredBeforeMinutes + 60, `${CANARY} hỏi giá`]);
        await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, send_state) VALUES ($1, $2, $3, $4, 2, 'out', now() - make_interval(mins => $5), now() - make_interval(mins => $5), 'member', $6, 'sent')`, [orgId, id, channel, opts.kind, opts.answeredBeforeMinutes, `${CANARY} đã trả lời`]);
        seq = 3;
      }
      await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, tainted) VALUES ($1, $2, $3, $4, $5, 'in', now() - make_interval(mins => $6), now() - make_interval(mins => $6), 'contact', $7, true)`, [orgId, id, channel, opts.kind, seq, opts.sinceMinutes, `${CANARY} cần báo giá gấp`]);
      return id;
    };

    // Many threads in one connection (for the paging tests): `n` threads of one kind whose customer began waiting `startMinutes` ago and then each a minute later.
    const bulk = (n: number, kind: 'direct' | 'comment_thread', startMinutes: number) =>
      admin(async (c) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          const id = randomUUID();
          const identity = randomUUID();
          const minutes = startMinutes - i;
          await c.query(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, $4)`, [orgId, identity, `u-${id.slice(0, 8)}`, CANARY]);
          await c.query(
            `INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, external_post_id, identity_id, status, last_seq, last_inbound_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', 1, now() - make_interval(mins => $8))`,
            [orgId, id, channel, kind, `t-${id}`, kind === 'comment_thread' ? `post-${id.slice(0, 8)}` : null, identity, minutes],
          );
          await c.query(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, tainted) VALUES ($1, $2, $3, $4, 1, 'in', now() - make_interval(mins => $5), now() - make_interval(mins => $5), 'contact', 'x', true)`, [orgId, id, channel, kind, minutes]);
          ids.push(id);
        }
        return ids;
      });

    // The CRM: a party, a deal that is called by a name, a quote sent `sentDaysAgo` days ago.
    const party = () => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, CANARY]).then((r) => (r[0] as { id: string }).id);
    const dealWithQuote = async (sentDaysAgo: number) => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      const deal = await exec<Deal>(owner, 'crm.deal.create', { partyId: await party(), title: DEAL_TITLE, amount: '15000000', expectedClose: null });
      const draft = await exec<{ id: string }>(owner, 'crm.quote.save', { dealId: deal.id, lines: [{ kind: 'item', description: 'Dòng bí mật 777', unit: 'cái', quantity: '2', unitPrice: '123456', vatRate: '10%' }] });
      await rows(
        "UPDATE crove_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30 WHERE org_id = $1 AND id = $2",
        [orgId, draft.id, `BG-2026-${Math.floor(Math.random() * 9000) + 1000}`, sentDaysAgo],
      );
      return deal.id;
    };
    const raise = () => worker.execute<{ raised: number; closed: number }>('crm.next_step.raise', {}, { actor: SYSTEM, orgId });
    // A confirmed booking at 10:00 tomorrow, Vietnam's calendar.
    const bookingTomorrow = async (hour = 10) => {
      const tomorrow = new Date(Date.now() + 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
      const starts = new Date(`${tomorrow}T${String(hour).padStart(2, '0')}:00:00+07:00`);
      const ends = new Date(starts.getTime() + 1_800_000);
      const type = randomUUID();
      const event = randomUUID();
      await rows('INSERT INTO crove_crm.event_type (org_id, id, slug, title, duration_min, host_user_id, created_by) VALUES ($1, $2, $3, $4, 30, $5, $5)', [orgId, type, `t-${type.slice(0, 8)}`, `Tư vấn ${CANARY}`, owner]);
      await rows("INSERT INTO crove_kernel.calendar_event (org_id, id, user_id, starts_at, ends_at, time_zone, kind, created_by) VALUES ($1, $2, $3, $4, $5, 'Asia/Ho_Chi_Minh', 'booking', $3)", [orgId, event, owner, starts, ends]);
      const id = randomUUID();
      await rows("INSERT INTO crove_crm.booking (org_id, id, event_type_id, calendar_event_id, starts_at, ends_at, status, visitor_name, email, note, time_zone) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, 'khach@canary.test', $7, 'Asia/Ho_Chi_Minh')", [orgId, id, type, event, starts, ends, CANARY]);
      return { id, on: tomorrow };
    };
    // A company grant with a wake-up (the real setup command); the receiver is only stored.
    const wakeUp = async (scopes: string[] = ALL_SCOPES, kind: 'company' | 'member' = 'company') => {
      const grantId = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $5, 'Dy', 'client.example.com', $6::text[], $4, now(), now() + interval '30 days', $3, $7, $8)`,
        [orgId, grantId, owner, `oauth-${grantId}`, `client-${grantId}`, scopes, kind, kind === 'member' ? owner : null],
      );
      const made = makeWakeSecret(vault, orgId, grantId);
      await exec(owner, 'kernel.mcp.wake.set', { grantId, url: 'https://hooks.example.com/ludy', credential: made.credential, schedule: 'off', enabled: true });
      return grantId;
    };
    const deliveries = (grantId: string) => rows<{ id: string; type: string; body: { data: Record<string, string> } }>(`SELECT id, type, body FROM crove_kernel.agent_wake_delivery WHERE org_id = $1 AND grant_id = $2 ORDER BY created_at, id`, [orgId, grantId]);
    const sweep = async (feeds: readonly LineWakeFeed[]) => {
      const done = await runWakeSweep({ runtime: worker, workerDb, send: async () => undefined, evaluate: async () => ({ items: [], complete: [] }), feeds });
      return done;
    };
    // Makes the signals due again (the sweep looks at a grant's signals every five minutes).
    const due = (grantId: string) => rows("UPDATE crove_kernel.agent_grant_wake SET signals_checked_at = now() - interval '6 minutes' WHERE grant_id = $1", [grantId]);
    return { orgId, owner, member, exec, query, thread, bulk, dealWithQuote, raise, bookingTomorrow, wakeUp, deliveries, sweep, due };
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
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS, mcpEntry: 'worker' }).register(registered);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('has the org\'s N: defaults with no row, set by an owner, refused to a member, bounded', async () => {
    const o = await org();
    expect(await o.query<EngageWakeRulesView>(o.member, 'kernel.conversation.wake_rules')).toEqual({ unansweredHours: 4, replyWindowHours: 3, quoteDays: 5, isDefault: true });
    await expect(o.exec(o.member, 'kernel.conversation.wake_rules_set', { unansweredHours: 8, replyWindowHours: 3, quoteDays: 5 })).rejects.toMatchObject({ status: 403 });
    for (const bad of [{ unansweredHours: 0 }, { unansweredHours: 73 }, { replyWindowHours: 24 }, { quoteDays: 1 }, { quoteDays: 31 }, { quoteDays: 2.5 }]) {
      await expect(o.exec(o.owner, 'kernel.conversation.wake_rules_set', { unansweredHours: 4, replyWindowHours: 3, quoteDays: 5, ...bad })).rejects.toBeTruthy();
    }
    const set = await o.exec<EngageWakeRulesView>(o.owner, 'kernel.conversation.wake_rules_set', { unansweredHours: 8, replyWindowHours: 6, quoteDays: 2 });
    expect(set).toEqual({ unansweredHours: 8, replyWindowHours: 6, quoteDays: 2, isDefault: false });
    expect(await o.query<EngageWakeRulesView>(o.member, 'kernel.conversation.wake_rules')).toEqual(set);
    // The database holds the bounds too, whatever writes the row.
    await expect(rows('UPDATE crove_kernel.conversation_setting SET wake_quote_days = 1 WHERE org_id = $1', [o.orgId])).rejects.toThrow();
    // The audit row holds the numbers and nothing else.
    const audit = await rows<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.wake_rules_set'`, [o.orgId]);
    expect(audit.map((a) => a.detail)).toContainEqual({ unansweredHours: 8, replyWindowHours: 6, quoteDays: 2 });
  });

  it('raises a sent quote\'s follow-up after the org\'s N days, and the wake read gives its ids, day and amount only', async () => {
    const o = await org();
    const deal = await o.dealWithQuote(3);
    // Five days is the default: three days is too early.
    expect((await o.raise()).raised).toBe(0);
    await o.exec(o.owner, 'kernel.conversation.wake_rules_set', { unansweredHours: 4, replyWindowHours: 3, quoteDays: 2 });
    expect((await o.raise()).raised).toBe(1);
    const grantId = await o.wakeUp();
    const read = await worker.query<EngageWakeCrm>('crm.wake.facts', {}, { actor: { type: 'user', userId: o.owner, aal: 'aal1', mcp: { grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ALL_SCOPES } }, orgId: o.orgId });
    expect(read.quoteSteps).toHaveLength(1);
    expect(read.quoteSteps[0]).toMatchObject({ dealId: deal, dealAmount: '15000000.00', currency: 'VND' });
    expect(Object.keys(read.quoteSteps[0] as object).sort()).toEqual(['currency', 'dealAmount', 'dealId', 'sinceOn', 'stepId']);
    expect(JSON.stringify(read)).not.toContain(CANARY);
    expect(JSON.stringify(read)).not.toContain('BG-2026');
    // Home shows the same step (with no agent in the picture) and tomorrow's booking.
    const booking = await o.bookingTomorrow();
    const home = await o.query<TodayList>(o.owner, 'kernel.today');
    const ids = home.items.map((i) => i.id);
    expect(ids).toContain(`booking-tomorrow:${booking.id}`);
    expect(home.items.some((i) => i.id.startsWith('next-step:') && i.title.key === 'crm.quoteUnanswered')).toBe(true);
    const facts = await worker.query<EngageWakeCrm>('crm.wake.facts', {}, { actor: { type: 'user', userId: o.owner, aal: 'aal1', mcp: { grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ALL_SCOPES } }, orgId: o.orgId });
    expect(facts.bookingsTomorrow).toEqual([{ bookingId: booking.id, on: booking.on }]);
    // A page is read from an offset, so a long list is reached in pages: a second booking is on the first page, and nothing is on the one after a hundred.
    const second = await o.bookingTomorrow(14);
    const asGrant = { actor: { type: 'user' as const, userId: o.owner, aal: 'aal1' as const, mcp: { grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ALL_SCOPES } }, orgId: o.orgId };
    expect((await worker.query<EngageWakeCrm>('crm.wake.facts', {}, asGrant)).bookingsTomorrow.map((b) => b.bookingId).sort()).toEqual([booking.id, second.id].sort());
    expect((await worker.query<EngageWakeCrm>('crm.wake.facts', { offset: 1 }, asGrant)).bookingsTomorrow).toHaveLength(1);
    expect((await worker.query<EngageWakeCrm>('crm.wake.facts', { offset: 100 }, asGrant)).bookingsTomorrow).toHaveLength(0);
  });

  it('reads the inbox rules as ids and instants only, for the member (Home) and for the grant, and Home shows them with no agent', async () => {
    const o = await org();
    const unanswered = await o.thread({ kind: 'direct', sinceMinutes: 6 * 60 });
    const fresh = await o.thread({ kind: 'direct', sinceMinutes: 30, windowMinutes: 90 });
    const comment = await o.thread({ kind: 'comment_thread', sinceMinutes: 60, post: true });
    const ancient = await o.thread({ kind: 'direct', sinceMinutes: 10 * 24 * 60 });
    const pending = await o.thread({ kind: 'direct', sinceMinutes: 6 * 60, status: 'pending' });
    const answered = await o.thread({ kind: 'email', sinceMinutes: 60, answeredBeforeMinutes: 5 * 60 });
    const input = { unansweredHours: 4, replyWindowHours: 3 };
    const mine = await o.query<EngageWakeConversations>(o.owner, 'kernel.wake.conversations', input);
    expect(mine.unanswered.map((r) => r.id)).toEqual([unanswered]);
    expect(mine.newInbound.map((r) => r.id).sort()).toEqual([fresh, unanswered].sort());
    expect(mine.replyWindow.map((r) => r.id)).toEqual([fresh]);
    expect(mine.comments.map((r) => r.id)).toEqual([comment]);
    for (const id of [ancient, pending, answered]) expect(JSON.stringify(mine)).not.toContain(id);
    expect(JSON.stringify(mine)).not.toContain(CANARY);
    // The grant reads the same, in its sealed context (the worker's entry), and its answer holds nothing a person typed.
    const grantId = await o.wakeUp();
    const asGrant = await worker.query<EngageWakeConversations>('kernel.wake.conversations', input, { actor: { type: 'user', userId: o.owner, aal: 'aal1', mcp: { grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ALL_SCOPES } }, orgId: o.orgId });
    expect(asGrant).toEqual(mine);
    expect(JSON.stringify(asGrant)).not.toContain(CANARY);
    // Home, with no agent connected for the member (there is a grant in the org, but Home never needs one): the three inbox rules.
    const home = await o.query<TodayList>(o.owner, 'kernel.today');
    const byId = new Map(home.items.map((i) => [i.id, i]));
    expect(byId.get('wake:unanswered')).toMatchObject({ kind: 'message', app: 'conversations', count: 1, title: { key: 'wake.unanswered', params: { count: 1, plus: '', hours: 4 } } });
    expect(byId.get('wake:reply-window')).toMatchObject({ kind: 'deadline', count: 1, title: { key: 'wake.replyWindow', params: { count: 1, plus: '', hours: 3 } } });
    expect(byId.get('wake:comments')).toMatchObject({ app: 'social', count: 1, title: { key: 'wake.postComments' } });
    // N is the org's: eight hours and the six-hour wait no longer counts.
    await o.exec(o.owner, 'kernel.conversation.wake_rules_set', { unansweredHours: 8, replyWindowHours: 3, quoteDays: 5 });
    expect((await o.query<TodayList>(o.owner, 'kernel.today')).items.some((i) => i.id === 'wake:unanswered')).toBe(false);
  });

  it('sends each rule once per item per window, only registered types, to a grant that holds the scope, and never a name, a message or a note', async () => {
    const o = await org();
    const unanswered = await o.thread({ kind: 'direct', sinceMinutes: 6 * 60 });
    const closing = await o.thread({ kind: 'direct', sinceMinutes: 30, windowMinutes: 90 });
    const comment = await o.thread({ kind: 'comment_thread', sinceMinutes: 60, post: true });
    const dealId = await o.dealWithQuote(6);
    await o.raise();
    const booking = await o.bookingTomorrow();
    const adAccount = randomUUID();
    const ads: LineWakeFeed = {
      types: ['ads.pace_over', 'ads.daily_cap_over', 'ads.monthly_cap_over'],
      read: async (grant) =>
        adsItems(
          [
            { kind: 'pace', scope: 'account', adAccountId: adAccount, accountName: CANARY, currency: 'USD', cap: '5000', spent: '3000', projected: '6200.456789', elapsedDays: 12, daysInMonth: 30, month: '2026-11-01', skippedAccounts: 0 },
            { kind: 'day', scope: 'org', adAccountId: null, accountName: null, currency: 'VND', period: 'monthly', cap: '30000000', share: '1000000', day: '2026-11-18', spend: '2400000', ratio: '2.4', skippedAccounts: 0 },
            { kind: 'cpr', adAccountId: adAccount, accountName: CANARY, campaignId: 'c1', campaignName: CANARY, currency: 'VND', day: '2026-11-18', recentCost: '1', medianCost: '1', ratio: '3', recentResults: '1', historyDays: 7 },
          ],
          grant.orgId,
        ),
    };
    const grantId = await o.wakeUp();
    const readOnly = await o.wakeUp(['ludy.read']);
    const memberBound = await o.wakeUp(['ludy.read'], 'member');
    const feeds = [engageWakeFeed(worker), ads];
    const first = await o.sweep(feeds);
    // unanswered (+ new), reply window, comment, quote, booking, two ad flags: one event each.
    const rows1 = await o.deliveries(grantId);
    const byType = (type: string) => rows1.filter((r) => r.type === type);
    expect(byType('engage.conversation_unanswered').map((r) => r.body.data.conversation_id)).toEqual([unanswered]);
    expect(byType('engage.conversation_new').map((r) => r.body.data.conversation_id).sort()).toEqual([closing, unanswered].sort());
    expect(byType('engage.reply_window_closing').map((r) => r.body.data.conversation_id)).toEqual([closing]);
    expect(byType('social.post_comment_new').map((r) => r.body.data.conversation_id)).toEqual([comment]);
    expect(byType('engage.quote_unanswered')).toHaveLength(1);
    expect(byType('engage.quote_unanswered')[0]?.body.data).toMatchObject({ deal_id: dealId, deal_amount: '15000000', currency: 'vnd' });
    expect(byType('engage.booking_tomorrow').map((r) => r.body.data)).toEqual([{ booking_id: booking.id, on: booking.on }]);
    expect(byType('ads.pace_over')[0]?.body.data).toMatchObject({ scope: 'account', projected: '6200.4568', cap: '5000', currency: 'usd' });
    expect(byType('ads.monthly_cap_over')[0]?.body.data).toMatchObject({ scope: 'org', day: '2026-11-18', spend: '2400000', cap: '30000000', currency: 'vnd' });
    expect(byType('ads.daily_cap_over')).toHaveLength(0);
    expect(rows1).toHaveLength(9);
    expect(first.lines).toBeGreaterThanOrEqual(9);
    // No name, message, deal title, quote number or note left, in any body, and every body is one the builder accepts.
    const all = JSON.stringify(rows1.map((r) => r.body));
    for (const secret of [CANARY, 'Canary', DEAL_TITLE, 'BG-2026', 'khach@canary.test', 'Dòng bí mật', 'cần báo giá']) expect(all).not.toContain(secret);
    for (const r of rows1) expect(() => wakeBody(r.body)).not.toThrow();
    // One check for the whole grant in the pass, whatever the number of types (a command leaves an audit row each): the readOnly and member-bound grants ask nothing, so one row for this org.
    const checks = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.wake.line_check'`, [o.orgId]);
    expect(checks[0]?.n).toBe('1');
    // A grant that only reads, and a member-bound grant, got none of it.
    expect(await o.deliveries(readOnly)).toHaveLength(0);
    expect(await o.deliveries(memberBound)).toHaveLength(0);

    // Again, five minutes on: the same items hold, and nothing is sent twice.
    await o.due(grantId);
    const again = await o.sweep(feeds);
    const rows1b = await o.deliveries(grantId);
    expect(again.lines, JSON.stringify(rows1b.slice(9).map((r) => [r.type, r.body.data]))).toBe(0);
    expect(rows1b).toHaveLength(9);

    // A new window is a new event: the org answered, and the customer wrote again two days ago (a later wait, another day).
    await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, send_state) SELECT org_id, id, channel_connection_id, kind, 4, 'out', now() - interval '50 hours', now() - interval '50 hours', 'member', 'x', 'sent' FROM crove_kernel.conversation WHERE id = $1`, [unanswered]);
    await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, tainted) SELECT org_id, id, channel_connection_id, kind, 5, 'in', now() - interval '48 hours', now() - interval '48 hours', 'contact', 'lại hỏi', true FROM crove_kernel.conversation WHERE id = $1`, [unanswered]);
    await o.due(grantId);
    await o.sweep(feeds);
    const rows2 = await o.deliveries(grantId);
    expect(rows2.filter((r) => r.type === 'engage.conversation_unanswered').map((r) => r.body.data.since)).toHaveLength(2);
    expect(new Set(rows2.filter((r) => r.type === 'engage.conversation_unanswered').map((r) => r.body.data.since)).size).toBe(2);

    // The keys are kept with the events, one each, and a line key is never mistaken for a signal's.
    const seen = await rows<{ key: string }>(`SELECT key FROM crove_kernel.agent_wake_signal_seen WHERE org_id = $1 AND grant_id = $2 ORDER BY key`, [o.orgId, grantId]);
    expect(seen).toHaveLength(10);
    expect(seen.every((s) => /^(engage|social|ads)_[a-z_]+:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/.test(s.key))).toBe(true);
  });

  it('asks nothing of a grant for a line whose scope it does not hold, and sends at most twenty events of a type in a pass, the rest in the next', async () => {
    const asked: string[] = [];
    const spy = { query: async (name: string) => { asked.push(name); throw new Error('not asked'); } } as unknown as Runtime;
    const feed = engageWakeFeed(spy);
    const grant = { orgId: randomUUID(), grantId: randomUUID(), userId: randomUUID() };
    const plan = (scopes: string[], appsOff: string[] = []) => ({ kind: 'company' as const, scopes, appsOff, unansweredHours: 4, replyWindowHours: 3, quoteDays: 5 });
    expect(await feed.read(grant, plan(['ludy.read']))).toEqual([]);
    expect(asked).toEqual([]);
    await feed.read(grant, plan(['ludy.read', 'ludy.ads.draft']));
    expect(asked).toEqual(['ads.mcp.flags']);
    asked.length = 0;
    await feed.read(grant, plan(['ludy.read', 'ludy.social.draft']));
    expect(asked).toEqual(['kernel.wake.conversations']);

    const o = await org();
    for (let n = 0; n < 25; n += 1) await o.thread({ kind: 'direct', sinceMinutes: 6 * 60 + n });
    const grantId = await o.wakeUp();
    await o.sweep([engageWakeFeed(worker)]);
    const first = (await o.deliveries(grantId)).filter((r) => r.type === 'engage.conversation_unanswered');
    expect(first).toHaveLength(20);
    await o.due(grantId);
    await o.sweep([engageWakeFeed(worker)]);
    const second = (await o.deliveries(grantId)).filter((r) => r.type === 'engage.conversation_unanswered');
    expect(second).toHaveLength(25);
    expect(new Set(second.map((r) => r.body.data.conversation_id)).size).toBe(25);
  });

  it('sends every item of a type that holds across passes (more than a pass sends), so none is starved by the ones already sent', async () => {
    const o = await org();
    const grantId = await o.wakeUp();
    const items = Array.from({ length: 45 }, () => randomUUID()).map((id) => ({ type: 'engage.booking_tomorrow', key: wakeKey('engage.booking_tomorrow', id, '2026-11-20'), data: { booking_id: id, on: '2026-11-20' } }));
    const feed: LineWakeFeed = { types: ['engage.booking_tomorrow'], read: async () => items };
    const counts: number[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await o.sweep([feed]);
      counts.push((await o.deliveries(grantId)).length);
      await o.due(grantId);
    }
    expect(counts).toEqual([20, 40, 45, 45]);
  });

  it('reaches every qualifying thread however many do not qualify or come first: each rule has its own eligibility and bound, and the next page is read while a list is full', async () => {
    const o = await org();
    // 105 fresh comment threads (newer, and not the unanswered rule's), one direct thread that waited five hours, and 105 direct threads that waited over four hours.
    const comments = await o.bulk(105, 'comment_thread', 120);
    const lone = await o.thread({ kind: 'direct', sinceMinutes: 5 * 60 });
    const input = { unansweredHours: 4, replyWindowHours: 3 };
    const first = await o.query<EngageWakeConversations>(o.owner, 'kernel.wake.conversations', input);
    expect(first.unanswered.map((r) => r.id)).toEqual([lone]);
    expect(first.comments).toHaveLength(100);
    const second = await o.query<EngageWakeConversations>(o.owner, 'kernel.wake.conversations', { ...input, offset: 100 });
    expect(second.comments).toHaveLength(5);
    expect(new Set([...first.comments, ...second.comments].map((r) => r.id))).toEqual(new Set(comments));
    // The feed puts the pages together: every comment thread is an event over the passes, none is lost behind the first hundred.
    const grantId = await o.wakeUp();
    const feed = engageWakeFeed(worker);
    const types = ['social.post_comment_new', 'engage.conversation_unanswered'];
    for (let pass = 0; pass < 8; pass += 1) {
      await o.sweep([feed]);
      await o.due(grantId);
    }
    const sent = (await o.deliveries(grantId)).filter((r) => types.includes(r.type));
    expect(sent.filter((r) => r.type === 'social.post_comment_new')).toHaveLength(105);
    expect(sent.filter((r) => r.type === 'engage.conversation_unanswered').map((r) => r.body.data.conversation_id)).toEqual([lone]);
  });

  it('lets a key the database refuses stop only its own type, and logs it by code, never by value', async () => {
    const o = await org();
    const grantId = await o.wakeUp();
    const good = randomUUID();
    const bad = { type: 'engage.booking_tomorrow', key: 'engage_booking_tomorrow:Nguyễn Văn A:2026-11-20', data: { booking_id: randomUUID(), on: '2026-11-20' } };
    const ok = { type: 'social.post_comment_new', key: wakeKey('social.post_comment_new', good, '2026-11-19'), data: { conversation_id: good, since: '2026-11-19' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await o.sweep([{ types: ['engage.booking_tomorrow', 'social.post_comment_new'], read: async () => [bad, ok] }]);
      const sent = await o.deliveries(grantId);
      expect(sent.map((r) => r.type)).toEqual(['social.post_comment_new']);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Nguyễn');
    } finally {
      warn.mockRestore();
    }
  });

  it('wakes no coworker about an app the org switched off', async () => {
    const o = await org();
    await o.thread({ kind: 'direct', sinceMinutes: 6 * 60 });
    await o.thread({ kind: 'comment_thread', sinceMinutes: 60, post: true });
    await rows("UPDATE crove_kernel.tenant SET apps_off = ARRAY['social'] WHERE org_id = $1", [o.orgId]);
    const grantId = await o.wakeUp();
    await o.sweep([engageWakeFeed(worker)]);
    expect(await o.deliveries(grantId)).toHaveLength(0);
    await rows("UPDATE crove_kernel.tenant SET apps_off = ARRAY[]::text[] WHERE org_id = $1", [o.orgId]);
    await o.due(grantId);
    await o.sweep([engageWakeFeed(worker)]);
    expect((await o.deliveries(grantId)).length).toBeGreaterThan(0);
  });

  it('refuses in the database what the sweep never sends: a key that is not the type\'s own, a second event for a seen key, a key that is not a line key', async () => {
    const o = await org();
    const grantId = await o.wakeUp();
    const conversation = randomUUID();
    const body = (id: string, type: string, data: Record<string, string>) => ({ id, type, created_at: new Date().toISOString(), org: o.orgId, grant: grantId, data });
    const enqueue = (type: string, data: Record<string, string>, keys: string[] | null) =>
      worker.execute<{ stored: boolean }>('kernel.mcp.wake.enqueue', { ...(() => { const id = randomUUID(); return { id, grantId, type, body: body(id, type, data) }; })(), ...(keys ? { keys } : {}) }, { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: o.orgId });
    const data = { conversation_id: conversation, closes_on: '2026-11-19' };
    const key = `engage_reply_window_closing:${conversation}:2026-11-19`;
    await expect(enqueue('engage.reply_window_closing', data, [`engage_conversation_new:${conversation}:2026-11-19`])).rejects.toMatchObject({ status: 422 });
    await expect(enqueue('engage.reply_window_closing', data, [key, key])).rejects.toMatchObject({ status: 422 });
    await expect(enqueue('engage.reply_window_closing', data, [`engage_reply_window_closing:${conversation}`])).rejects.toMatchObject({ status: 422 });
    expect((await enqueue('engage.reply_window_closing', data, [key])).stored).toBe(true);
    // The same key again stores nothing, whatever the event id.
    expect((await enqueue('engage.reply_window_closing', data, [key])).stored).toBe(false);
    expect(await o.deliveries(grantId)).toHaveLength(1);
    // A free-text key (a name) is refused by the check as well as by the table.
    await expect(worker.execute('kernel.mcp.wake.line_check', { grantId, keys: [`engage_conversation_new:Nguyễn Văn A:2026-11-19`] }, { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: o.orgId })).rejects.toBeTruthy();
    const fresh = await worker.execute<{ fresh: string[] }>('kernel.mcp.wake.line_check', { grantId, keys: [key, `engage_booking_tomorrow:${conversation}:2026-11-20`] }, { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: o.orgId });
    expect(fresh.fresh).toEqual([`engage_booking_tomorrow:${conversation}:2026-11-20`]);
    // A grant that is not for this line gets the refusal of the scope, not an event: an otherwise valid event for the read-only grant (its own id and grant in the body, the type's own key), and the one failure is the scope.
    const readOnly = await o.wakeUp(['ludy.read']);
    const eventId = randomUUID();
    const booking = randomUUID();
    const scoped = { id: eventId, grantId: readOnly, type: 'engage.booking_tomorrow', body: { id: eventId, type: 'engage.booking_tomorrow', created_at: new Date().toISOString(), org: o.orgId, grant: readOnly, data: { booking_id: booking, on: '2026-11-20' } }, keys: [`engage_booking_tomorrow:${booking}:2026-11-20`] };
    await expect(worker.execute('kernel.mcp.wake.enqueue', scoped, { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: o.orgId })).rejects.toMatchObject({ code: 'MCP_WAKE_SCOPE', status: 403 });
    expect(await o.deliveries(readOnly)).toHaveLength(0);
  });

  it('has the same types in the catalog as in the registry in code, each with the scope of its line', async () => {
    const catalog = await rows<{ type: string; scope: string; fields: unknown }>('SELECT type, scope, fields FROM crove_kernel.mcp_wake_event_type ORDER BY type');
    expect(catalog.map((r) => [r.type, r.scope, r.fields])).toEqual(Object.keys(LINE_WAKE_EVENTS).sort().map((t) => [t, LINE_WAKE_EVENTS[t]?.scope, LINE_WAKE_EVENTS[t]?.fields]));
  });

  it('maps the reads to events with plain helpers (the feed adds only the scope and the read)', () => {
    const id = randomUUID();
    const since = '2026-11-19T01:00:00.000Z';
    expect(conversationItems({ newInbound: [], unanswered: [{ id, kind: 'email', since }], replyWindow: [], comments: [] })[0]).toMatchObject({ type: 'engage.conversation_unanswered', key: `engage_conversation_unanswered:${id}:2026-11-19`, data: { conversation_id: id, kind: 'email', since: '2026-11-19' } });
    expect(crmItems({ quoteSteps: [], bookingsTomorrow: [] })).toEqual([]);
  });
});
