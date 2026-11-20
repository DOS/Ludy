// SPDX-License-Identifier: AGPL-3.0-only
// What an MCP grant can reach once it is past the HTTP edge (ADR-0051 decision 2, ADR-0032, issue #2975), through the runtime every command and query runs on:
// - exactly the commands WRITES and ENGAGE_WRITES run for a grant (the Social draft command of #3227, owner decision 2026-11-14, and the thirteen Engage R1 twins of #3861), each pinned to its scope and to the narrow shape
//   the sealed write context runs (R1, internal, owners and admins, no permission, extension, agent or member-mode declaration), and a grant runs no other command, whatever the command declares; the only other
//   commands that carry `mcp` are the 14 proposal-only Engage twins of E4 (#3863), each declared `{ scope, mode: 'proposal' }`: a call to one never runs it, it leaves a pending proposal a person approves
//   (pinned below, and in mcp-proposals.db.test.ts);
// - a grant reaches a query only if that query declares the scope (`mcp`), the set of queries that do is pinned here (a new one is a change to this protected
//   file), and none of them is sensitive, open to member mode or an extension token, or holds data private to one member (member-bound grants are a later step);
// - the grant's standing is read in the transaction of every call, with no session check configured: a revoked or expired grant, a consenting user who is no
//   longer an owner or admin, who was removed or disabled, an org that is stopped (its "Dung AI") or the deployment's AI switch refuses the very next call, 401;
// - the grant tables and the authorization server's storage are reachable by no login role except through the API's definers, and the worker reaches none.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { adsCommands, adsQueries } from '@crove/mod-ads';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Every query an MCP grant may run, with its scope. Adding one is a security change: read what it returns first, and keep member-private data out.
const REACHABLE = [
  'kernel.mcp.about:ludy.read',
  'kernel.mcp.parties:ludy.read',
  'finance.mcp.invoices:ludy.read',
  // Tool 1 of #3849 (`ludy_finance_overview`): four money figures of a period; pinned in test/invariant/mcp-overview-projection.db.test.ts.
  'finance.mcp.overview:ludy.read',
  // Tool 2 of #3849 (`ludy_finance_open_balances`): per party the open amount and its age buckets; pinned in test/invariant/mcp-open-balances-projection.db.test.ts.
  'finance.mcp.open_balances:ludy.read',
  // Tool 3 of #3849 (`ludy_payment_reminder_draft`): one overdue customer's reminder draft with the fixed template words; pinned in test/invariant/mcp-payment-reminder-projection.db.test.ts.
  'finance.mcp.payment_reminder:ludy.read',
  // The two Social reads (#3227, plan section 3.8: `ludy_social_posts_list` and `ludy_social_review_queue`). Their privacy review is the comment at the top of modules/social/src/mcp.ts; neither is
  // sensitive, and the checks below apply to them as to every query.
  'social.mcp.posts:ludy.read',
  'social.mcp.review_queue:ludy.read',
  // The two Meetings reads of a company grant (#3731, owner decision 2026-11-18, Meetings PO design review): the published results of meetings whose visibility is 'org', nothing else. Their privacy pins
  // are in test/invariant/mcp-meetings-company.db.test.ts and the projection test of the read.
  'meetings.mcp.list:ludy.read',
  'meetings.mcp.minutes:ludy.read',
  // The Meetings read of the open action items across those same meetings (#3804, step 3 of the two-step landing): published, unflagged items no task was made from, of org-visible meetings inside their
  // text period, for a company grant only. Its projection pins are in test/invariant/meetings-mcp-projection.db.test.ts.
  'meetings.mcp.open_actions:ludy.read',
  // The Meetings read of the open action items of one series of meetings (#3837, step 3 of the two-step landing): keyed on a meeting, never on a series id, over the same readable meetings as the two reads
  // above, for a company grant only. Its projection pins are in test/invariant/meetings-mcp-projection.db.test.ts.
  'meetings.mcp.series_open_items:ludy.read',
  // The Meetings read of the published decisions of the last 7, 14 or 30 days (#4016, step 3 of the three-step landing): the decisions of the same readable meetings as the reads above, started inside the
  // window, for a company grant only. Its projection pins are in test/invariant/meetings-mcp-projection.db.test.ts.
  'meetings.mcp.decisions:ludy.read',
  // The Meetings read that searches the published minutes (#4030, step 3 of the three-step landing): it matches only the views the minutes tool can return, of the same readable meetings as the reads above,
  // for a company grant only; the typed words never reach SQL. Its projection pins are in test/invariant/meetings-mcp-projection.db.test.ts.
  'meetings.mcp.search:ludy.read',
  // The Engage reads of epic #3857, E1 (#3860, owner decision 2026-11-19: Dy and Uy work Engage through MCP; step 3 of the three-step landing, #4052 and #4068 before it). A missing name now fails.
  // Results of Social and Ads, for a company grant only (their privacy review is the comment at the top of each query's file; the output is pinned in the DB tests engage-mcp-results.db.test.ts):
  'social.mcp.metrics_summary:ludy.read',
  'social.mcp.metrics_totals:ludy.read',
  'ads.mcp.spend:ludy.read',
  'ads.mcp.today:ludy.read',
  'ads.mcp.flags:ludy.read',
  // The CRM records: deals and quotes for every role (the CRM tables carry the org policy only, so a member-bound grant reads the whole org's, as that member does in the app); the bookings, a guest's
  // contact details, for a company grant only. Pinned in engage-mcp-crm.db.test.ts.
  'crm.mcp.deals:ludy.read',
  'crm.mcp.deal:ludy.read',
  'crm.mcp.quotes:ludy.read',
  'crm.mcp.quote:ludy.read',
  'crm.mcp.bookings:ludy.read',
  // The Hộp thư conversations, read inside the sealed grant contexts of #3858 slice b (a company grant the whole org, a member-bound grant what its member may read), as paged allowlist projections. They are
  // named `kernel.mcp.*` on purpose: the check below keeps every `kernel.conversation.*` and `kernel.inbox*` name, the screens' own queries, out of a grant's reach. Pinned in
  // test/invariant/mcp-conversation-reads.db.test.ts.
  'kernel.mcp.conversations:ludy.read',
  'kernel.mcp.conversation:ludy.read',
  // The wake rules of Engage (#3862, E3 of epic #3857; ADR-0051 decision 13): the two reads the wake sweep runs as a company grant, in its sealed context, to tell an AI coworker there is work, and that Home runs as
  // the member. Ids, a kind, instants, days and an amount, with exactly those keys, and none of the words a customer, a deal or a guest wrote; a company grant reads its own org's rows only and a member-bound grant
  // is refused by both, the CRM read for a plain member too. Pinned in test/invariant/mcp-wake-engage-reach.db.test.ts and mcp-wake-engage.test.ts.
  'kernel.wake.conversations:ludy.read',
  'crm.wake.facts:ludy.read',
];
// The cross-app signals (Vy V4 and V5, #2967 and #2969) may join the set, each one when its line has reviewed what it returns: the kernel rules and the line reads they
// call (a query run inside a query keeps the caller's identity, so a rule over MCP needs every read it calls to declare the scope as well). They are optional here so each can land
// on its own; a name outside this list still fails, and so does a missing name of REACHABLE.
const SIGNALS = [
  'kernel.signals.deal_without_invoice:ludy.read',
  'kernel.signals.receivable_with_open_deal:ludy.read',
  'kernel.signals.supplier_bank_changed:ludy.read',
  // The fourth rule (#3124): a customer conversation unanswered past its reply window on an open deal. The screens' own conversation read (`kernel.conversation.*`) declares no scope on purpose, so over MCP that
  // read refuses and this rule reports `not_available`, never an empty "all clear"; a grant reads conversations only through the two paged projections `kernel.mcp.conversations` and `kernel.mcp.conversation` (above).
  'kernel.signals.conversation_unanswered:ludy.read',
  'finance.signals.sales:ludy.read',
  'finance.signals.overdue_receivables:ludy.read',
  'finance.signals.supplier_bank_changes:ludy.read',
  'finance.signals.supplier_payments_waiting:ludy.read',
  'crm.signals.won_deals:ludy.read',
  'crm.signals.open_deals:ludy.read',
  // The one query behind the `ludy_signals` tool (step S4): it runs the three rules above as the grant and returns their items.
  'kernel.mcp.signals:ludy.read',
];

// The finance reads of the connected coworker (#3849, plan docs/plan/vy.md section 5 C2 and C3, owner decision 2026-11-18): the overview figures, the open receivables and payables per party, and one payment
// reminder draft. They may join the set one at a time, each when its line and the PO's security review have read what it returns (step 1 of the landing, like the signals above: this list lets a name in, it
// does not require it). A name outside this list still fails, and so do the checks below on every query that carries `mcp`: never sensitive, streamed, role-less or open to member mode or an extension token.
// Must never be returned by any of them (each tool PR pins it under test/invariant/): a customer's email or phone, the org's bank account numbers or holders (the reminder read leaves out `payTo`), the lines of an invoice, anything from a query that is `sensitive`.
const FINANCE_READS: readonly string[] = [
];

// The one command an MCP grant may run (#3227, step 3, owner decision 2026-11-14: one new write scope and exactly one command, "create a draft post for a person to review"). Exactly this one,
// with exactly this scope: a second command that carries `mcp`, or this one with another scope, fails, and so does its absence.
const WRITES = ['social.mcp.draft_create:ludy.social.draft'];
// The R1 write twins of the Engage coworkers (epic #3857, E2, issue #3861; ADR-0051 decisions 10 and 11, owner decision 2026-11-19): each runs the same steps a person's click runs for the app's own
// command (assign, resolve, reopen, note, link a contact, new contact, new deal, move a deal, save or revise a draft quote, mark a next step done or snoozed, save an ads draft), under
// `ludy.engage.write` (the ads draft under `ludy.ads.draft`), each in its own sealed write context (test/invariant/mcp-engage-write.db.test.ts pins the database side). This list is exact: all thirteen
// carry `mcp`, none else does, and each with the scope named here. (`kernel.conversation.follow_up` has no twin: its task is an event and wakes an agent, which the sealed context does not allow.)
const ENGAGE_WRITES: readonly string[] = [
  'kernel.mcp.conversation_assign:ludy.engage.write',
  'kernel.mcp.conversation_resolve:ludy.engage.write',
  'kernel.mcp.conversation_reopen:ludy.engage.write',
  'kernel.mcp.conversation_note:ludy.engage.write',
  'kernel.mcp.conversation_link_contact:ludy.engage.write',
  'kernel.mcp.party_create:ludy.engage.write',
  'crm.mcp.deal_create:ludy.engage.write',
  'crm.mcp.deal_move:ludy.engage.write',
  'crm.mcp.quote_save:ludy.engage.write',
  'crm.mcp.quote_revise:ludy.engage.write',
  'crm.mcp.next_step_done:ludy.engage.write',
  'crm.mcp.next_step_snooze:ludy.engage.write',
  'ads.mcp.campaign_draft_save:ludy.ads.draft',
];
const commands = [...kernelCommands, ...financeCommands, ...meetingsCommands, ...socialCommands, ...adsCommands, ...crmCommands, ...hrCommands, ...notesCommands];
const queries = [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries, ...socialQueries, ...adsQueries, ...crmQueries, ...hrQueries, ...notesQueries];

describe('which definitions an MCP grant can reach (#2975)', () => {
  it('has exactly the commands that run for a grant that WRITES and ENGAGE_WRITES name, with their scope, and each is R1, internal and for owners and admins', () => {
    // A command of mode 'proposal' (the 14 proposal-only twins of E4, #3863) never runs for a grant: it is pinned in the test below and in mcp-proposals.db.test.ts.
    const carrying = commands.filter((c) => (c as { mcp?: unknown }).mcp !== undefined && (c as { mcp: { mode?: string } }).mcp.mode !== 'proposal');
    const named = carrying.map((c) => `${c.name}:${(c as { mcp: { scope: string } }).mcp.scope}`).sort();
    expect(named).toStrictEqual([...WRITES, ...ENGAGE_WRITES].sort());
    for (const c of carrying) {
      expect([c.risk, c.sideEffect, c.access], c.name).toEqual(['R1', 'internal', ['owner', 'admin']]);
      const scope = (c as { mcp: { scope: string } }).mcp.scope;
      // Only the scope, in the mode that runs the command (a command of mode 'proposal' is R2 or R3, and is pinned in mcp-proposals.db.test.ts).
      expect((c as { mcp: unknown }).mcp, c.name).toStrictEqual({ scope });
      expect(WRITES.concat(ENGAGE_WRITES), c.name).toContain(`${c.name}:${scope}`);
      expect(c.permission, c.name).toBeUndefined();
      expect(c.extension, c.name).toBeUndefined();
      expect(c.agent, c.name).toBeUndefined();
      expect(c.memberVy, c.name).toBeUndefined();
      expect(c.bootstrap, c.name).toBeUndefined();
      expect(c.sealedInput, c.name).toBeUndefined();
      expect((c as { sensitive?: unknown }).sensitive, c.name).toBeUndefined();
    }
  });

  // The commands a grant reaches only as a proposal (#3858 slice d; Engage E4, #3863): proposal-only twins of the Engage commands, R2, never run for a grant (the proposer runs in their place), each under its line's scope.
  const PROPOSALS: Record<string, string> = {
    'kernel.conversation.reply_approved': 'ludy.engage.write',
    'kernel.conversation.reply_privately_approved': 'ludy.engage.write',
    'kernel.conversation.hide_approved': 'ludy.engage.write',
    'crm.quote.send_approved': 'ludy.engage.write',
    'crm.booking.move_approved': 'ludy.engage.write',
    'crm.booking.cancel_approved': 'ludy.engage.write',
    'social.post.submit_approved': 'ludy.engage.write',
    'social.variant.schedule_approved': 'ludy.engage.write',
    'ads.launch.stop_approved': 'ludy.ads.draft',
    'ads.pause_all_approved': 'ludy.ads.draft',
    'ads.object.pause_approved': 'ludy.ads.draft',
    'ads.object.archive_approved': 'ludy.ads.draft',
    'ads.budget.lower_approved': 'ludy.ads.draft',
    'ads.schedule.shorten_approved': 'ludy.ads.draft',
  };
  it('has only the proposal-only twins of the Engage commands (E4) as commands a grant reaches as a proposal, each R2, access proposal, under its scope', () => {
    const proposing = commands.filter((c) => (c as { mcp?: { mode?: string } }).mcp?.mode === 'proposal');
    expect(proposing.filter((c) => !Object.hasOwn(PROPOSALS, c.name)).map((c) => c.name)).toEqual([]);
    for (const c of proposing) {
      // Exactly the scope and the mode, nothing more (a command that runs for a grant carries the scope alone).
      expect((c as { mcp: unknown }).mcp, c.name).toStrictEqual({ scope: PROPOSALS[c.name], mode: 'proposal' });
      expect([c.risk, c.access], c.name).toEqual(['R2', 'proposal']);
      expect(c.permission, c.name).toBeUndefined();
      expect(c.extension, c.name).toBeUndefined();
      expect(c.agent, c.name).toBeUndefined();
      expect(c.memberVy, c.name).toBeUndefined();
      expect(c.bootstrap, c.name).toBeUndefined();
      expect(c.sealedInput, c.name).toBeUndefined();
      expect((c as { sensitive?: unknown }).sensitive, c.name).toBeUndefined();
    }
  });

  it('pins the queries that carry `mcp`, and none is sensitive, streamed, role-less or open to member mode or an extension token', () => {
    const carrying = queries.filter((q) => (q as { mcp?: unknown }).mcp !== undefined);
    const names = carrying.map((q) => `${q.name}:${(q as { mcp: { scope: string } }).mcp.scope}`).sort();
    expect(names.filter((n) => !SIGNALS.includes(n) && !FINANCE_READS.includes(n))).toStrictEqual([...REACHABLE].sort());
    for (const q of carrying) {
      expect(Array.isArray(q.access), q.name).toBe(true);
      expect(q.sensitive === true, q.name).toBe(false);
      expect(q.stream === true, q.name).toBe(false);
      expect(q.memberVy, q.name).toBeUndefined();
      expect(q.extension, q.name).toBeUndefined();
      // Member-private data (ADR-0049, ADR-0037): nothing from the notes, the member's own results or memory, until the member-bound grant exists. The screens' own conversation queries (`kernel.conversation.*`, `kernel.inbox*`) stay out of a grant's reach (the signals rule over them reports not_available); a grant reads conversations only through `kernel.mcp.conversations` and `kernel.mcp.conversation`, which read inside the sealed grant context and are pinned in mcp-conversation-reads.db.test.ts.
      expect(q.name.startsWith('notes.') || q.name.startsWith('kernel.member_vy.') || q.name.startsWith('kernel.inbox') || q.name.startsWith('kernel.conversation.'), q.name).toBe(false);
    }
  });

  it('refuses at register() a command that declares `mcp`, and a query that is sensitive or open to member mode with it', () => {
    const base = { name: 'kernel.test.x', input: z.strictObject({}), risk: 'R1', sideEffect: 'internal', access: ['owner'] };
    const rt = new Runtime({} as never, { manifests: TEST_MANIFESTS });
    // A command may declare only a write scope, and only as the narrow kind the sealed write context runs; a read scope on a command, and a write scope on a query, are refused.
    expect(() => rt.register({ commands: [{ ...base, mcp: { scope: 'ludy.read' }, handler: async () => ({}) } as never], queries: [] })).toThrow(/scope/);
    const draft = { ...base, access: ['owner', 'admin'], mcp: { scope: 'ludy.social.draft' }, handler: async () => ({}) };
    expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [draft as never], queries: [] })).not.toThrow();
    for (const bad of [{ risk: 'R2', sideEffect: 'external' }, { access: ['owner', 'member'] }, { access: ['member'] }, { access: [] }, { access: 'system' }, { sensitive: true }, { permission: 'finance.post' }, { extension: { scope: 'meetings.record' } }, { mcp: { scope: 'ludy.social.write' } }]) {
      expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [{ ...draft, ...bad } as never], queries: [] }), JSON.stringify(bad)).toThrow();
    }
    expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [], queries: [{ name: 'kernel.test.w', input: z.strictObject({}), access: ['owner'], mcp: { scope: 'ludy.social.draft' }, handler: async () => ({}) } as never] })).toThrow(/scope/);
    const q = { name: 'kernel.test.q', input: z.strictObject({}), access: ['owner'], mcp: { scope: 'ludy.read' }, handler: async () => ({}) };
    expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [], queries: [{ ...q, sensitive: true } as never] })).toThrow(/MCP grant/);
    expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [], queries: [{ ...q, memberVy: { reads: [] }, name: 'kernel.member_vy.q' } as never] })).toThrow(/MCP grant/);
    expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [], queries: [{ ...q, mcp: { scope: 'ludy.write' } } as never] })).toThrow(/scope/);
  });
});

suite('an MCP grant past the HTTP edge: scope, standing and storage (#2975)', () => {
  const dbName = `crove_test_mcp_scope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', memberA: '', ownerB: '' };

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string, scopes: readonly string[] = ['ludy.read']): UserActor => ({ type: 'user', userId, aal: 'aal1', mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function insertGrant(orgId: string, userId: string, extra = '') {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now() ${extra}, now() ${extra} + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
      ),
    );
    return id;
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    // No session source: a grant's standing is checked whatever the deployment's session mode.
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries],
    });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-scope', subject: key, email: `${key}@mcp-scope.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('runs a query that declares the scope, as the consenting user, and no other', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const about = await runtime.query<{ orgName: string; clientName: string }>('kernel.mcp.about', {}, { actor: mcp(users.ownerA, grant), orgId: orgA });
    expect(about).toMatchObject({ orgName: 'Org A', clientName: 'Test client' });
    // Every other registered query that takes an empty input is closed (rule mcp_scope), whoever the user is and whatever their role: the check precedes the role check.
    const registered = [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries].map((q) => q.name);
    const closed = queries.filter((q) => registered.includes(q.name) && (q as { mcp?: unknown }).mcp === undefined && q.input.safeParse({}).success && q.stream !== true);
    expect(closed.length).toBeGreaterThan(20);
    for (const q of closed) {
      const error = await refusal(runtime.query(q.name, {}, { actor: mcp(users.ownerA, grant), orgId: orgA }));
      expect(error.code, q.name).toBe('FORBIDDEN');
      expect(error.details, q.name).toMatchObject({ rule: 'mcp_scope' });
    }
    // A grant without the scope reaches nothing, not even the query that declares it.
    expect((await refusal(runtime.query('kernel.mcp.about', {}, { actor: mcp(users.ownerA, grant, []), orgId: orgA }))).details).toMatchObject({ rule: 'mcp_scope' });
  });

  it('runs no command, whatever the command declares', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const inputs: Record<string, unknown> = {
      'kernel.mcp.grant.revoke': { grantId: randomUUID() },
      'kernel.mcp.grant.approve': { clientId: 'c', clientName: 'c', clientHost: 'c.example.com', scopes: ['ludy.read'], oauthGrantId: 'g' },
      'kernel.extension.token.revoke': { tokenId: randomUUID() },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const error = await refusal(runtime.execute(name, input, { actor: mcp(users.ownerA, grant), orgId: orgA }));
      expect(error.code, name).toBe('FORBIDDEN');
      expect(error.details, name).toMatchObject({ rule: 'mcp_scope' });
    }
    // And it cannot write by a read: the query runs in a read-only transaction (a write through it fails at the database).
    expect(await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1 AND revoked_at IS NOT NULL`, [orgA]).then((r) => r.rows[0].n))).toBe(0);
  });

  it('refuses the very next call when the grant is revoked, expired or for another org or user', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const call = (actor: UserActor, orgId = orgA) => runtime.query('kernel.mcp.about', {}, { actor, orgId });
    await call(mcp(users.ownerA, grant));
    // Another org's id, another user's id: 401, as for an unknown grant.
    // Each call starts when its turn comes: a rejected promise nobody awaits yet is an unhandled rejection.
    for (const refused of [() => call(mcp(users.ownerA, grant), orgB), () => call(mcp(users.adminA, grant)), () => call(mcp(users.ownerA, randomUUID()))]) {
      const error = await refusal(refused());
      expect(error.status).toBe(401);
      expect(error.code).toBe('MCP_GRANT_INVALID');
    }
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET expires_at = now() - interval '1 second' WHERE id = $1 AND false`, [grant]));
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1`, [grant]));
    expect((await refusal(call(mcp(users.ownerA, grant)))).status).toBe(401);
    const expired = await insertGrant(orgA, users.ownerA, '- interval \'31 days\'');
    expect((await refusal(call(mcp(users.ownerA, expired)))).status).toBe(401);
  });

  it('refuses the very next call when the consenting user is no longer an owner or admin, was removed or disabled, or the org is stopped', async () => {
    const call = (actor: UserActor) => runtime.query('kernel.mcp.about', {}, { actor, orgId: orgA });
    let grant = await insertGrant(orgA, users.adminA);
    await call(mcp(users.adminA, grant));
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]));
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    // The end is for good: restoring the role does not revive the grant (a trigger revoked it when the role dropped), and a new consent is needed.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]));
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    expect(await admin((c) => c.query(`SELECT revoked_at FROM crove_kernel.agent_grant WHERE id = $1`, [grant]).then((r) => r.rows[0].revoked_at))).not.toBeNull();
    grant = await insertGrant(orgA, users.adminA);
    await call(mcp(users.adminA, grant));
    // A member (never an owner or admin) cannot hold a grant: it is refused even when a row exists for them.
    const memberGrant = await insertGrant(orgA, users.memberA);
    expect((await refusal(call(mcp(users.memberA, memberGrant)))).code).toBe('MCP_GRANT_INVALID');
    // Disabled user.
    await admin((c) => c.query(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.adminA]));
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    await admin((c) => c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.adminA]));
    // Re-enabling does not revive it either.
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    grant = await insertGrant(orgA, users.adminA);
    // Removed.
    await call(mcp(users.adminA, grant));
    await admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]));
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgA, users.adminA]));
    // Re-adding does not revive the grant (the membership is newer than the grant).
    expect((await refusal(call(mcp(users.adminA, grant)))).code).toBe('MCP_GRANT_INVALID');
    // The org's "Dung AI" and the deployment's AI switch.
    const ownerGrant = await insertGrant(orgA, users.ownerA);
    await call(mcp(users.ownerA, ownerGrant));
    await admin((c) => c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgA, users.ownerA]));
    expect((await refusal(call(mcp(users.ownerA, ownerGrant)))).code).toBe('MCP_GRANT_INVALID');
    await admin((c) => c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [orgA]));
    await call(mcp(users.ownerA, ownerGrant));
    await admin((c) => c.query(`SELECT crove_kernel.global_kill_switch_set('ai', true, 'test', 'test')`));
    expect((await refusal(call(mcp(users.ownerA, ownerGrant)))).code).toBe('MCP_GRANT_INVALID');
    await admin((c) => c.query(`SELECT crove_kernel.global_kill_switch_set('ai', false, 'test', 'test')`));
    await call(mcp(users.ownerA, ownerGrant));
  });

  it('refuses a grant used with no org', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const error = await refusal(runtime.orgless(async () => runtime.execute('kernel.mcp.grant.revoke', { grantId: grant }, { actor: mcp(users.ownerA, grant), orgId: orgA })));
    expect(error.code).toBe('FORBIDDEN');
  });

  it('names the grant and the client in every audit row of a refusal, never the person alone', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    await refusal(runtime.execute('kernel.org.set_approval_preset', { preset: 'x' }, { actor: mcp(users.ownerA, grant), orgId: orgA }));
    const rows = await admin((c) => c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND detail ->> 'mcpGrant' = $2`, [orgA, grant]));
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(rows.rows[0].detail).toMatchObject({ mcpCall: true, mcpGrant: grant, mcpClient: 'client-1', mcpClientName: 'Test client' });
    // The org's audit log reads those rows as the AI app, never as the owner's own action (#2975).
    const log = await runtime.query<{ items: Array<{ command: string; via: { kind: string; clientName: string } | null }> }>('kernel.audit.list', {}, { actor: { type: 'user', userId: users.ownerA, aal: 'aal1' }, orgId: orgA });
    const viaRows = log.items.filter((i) => i.via !== null);
    expect(viaRows.length).toBeGreaterThan(0);
    for (const row of viaRows) expect(row.via).toEqual({ kind: 'mcp', clientName: 'Test client' });
  });

  it('lets the API login reach the grant tables and the authorization storage only through the definers, and the worker not at all', async () => {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      for (const table of ['crove_kernel.agent_grant', 'crove_kernel.oauth_record']) {
        await expect(app.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
        await expect(app.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await app.end();
    }
    const functions = [
      'mcp_grant_approve(text, text, text, text[], text, timestamptz)',
      'mcp_grant_verify(uuid, text)',
      'mcp_grant_check(uuid, uuid, uuid)',
      'mcp_grant_for_oauth(text)',
      'mcp_call_audit(uuid, uuid, text, text, text)',
      'mcp_rows_charge(uuid, uuid, integer, integer)',
      'mcp_grant_list()',
      'mcp_grant_revoke(uuid)',
      'mcp_grant_standing(uuid, uuid, uuid)',
      'oauth_record_upsert(text, bytea, jsonb, text, text, timestamptz)',
      'oauth_record_find(text, bytea)',
      'oauth_record_find_by_uid(text, text)',
      'oauth_record_consume(text, bytea)',
      'oauth_record_destroy(text, bytea)',
      'oauth_record_revoke_by_grant(text)',
    ];
    for (const fn of functions) {
      const row = await admin((c) =>
        c.query<{ app: boolean; worker: boolean; tenant: boolean; pub: boolean }>(
          `SELECT has_function_privilege('crove_app', 'crove_kernel.${fn}', 'EXECUTE') AS app, has_function_privilege('crove_worker', 'crove_kernel.${fn}', 'EXECUTE') AS worker,
                  has_function_privilege('crove_tenant', 'crove_kernel.${fn}', 'EXECUTE') AS tenant, has_function_privilege('public', 'crove_kernel.${fn}', 'EXECUTE') AS pub`,
        ),
      );
      expect(row.rows[0], fn).toEqual({ app: true, worker: false, tenant: false, pub: false });
    }
  });
});
