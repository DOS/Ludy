// SPDX-License-Identifier: AGPL-3.0-only
// The origin and taint marks of what a connected coworker writes (#4149, found in the security review of #3861; ADR-0051 decision 8): a note, a deal, a quote (and its lines) and a timeline row made or changed by
// an Engage twin in the grant's sealed write context carry `actor_origin = 'mcp'` and (where the row holds text) `tainted`, set by the database from the sealed context and never by a caller, while the same rows made
// by a person are unmarked. The taint is never lowered, a person's row an app only moves is not tainted, the tenant role cannot write the columns, and the views the app reads (a thread's notes, a deal, a quote, a contact's timeline)
// carry them. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, PipelineStage, Quote } from '@crove/kernel-contract';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { adsCommands, adsQueries } from '@crove/mod-ads';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';

suite('the origin and taint marks of what a connected coworker writes (#4149)', () => {
  const dbName = `crove_test_engage_mcp_marks_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const channel: Record<string, string> = {};
  let thread = '';
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
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
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
      await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgA, users[who], role]);
    }
    for (const [key, org, owner] of [['a1', orgA, users.owner], ['b1', orgB, users.foreign]] as const) {
      channel[key] = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, $4, $5)`, [org, channel[key], `ext-${key}`, `Trang ${key}`, owner]);
    }
    const seed = async (org: string, ch: string, key: string) => {
      const id = randomUUID();
      const ident = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, 'Khách thử')`, [org, ident, `u-${key}-12345678`]);
      await sqlAdmin(
        `INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at)
         VALUES ($1, $2, $3, 'comment_thread', $4, $5, 1, now(), now())`,
        [org, id, ch, `t-${key}`, ident],
      );
      await sqlAdmin(
        `INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted, author_identity_id)
         VALUES ($1, $2, $3, $4, 'comment_thread', 1, 'in', now(), 'contact', 'Cho mình hỏi giá', true, $5)`,
        [org, randomUUID(), id, ch, ident],
      );
      return { id, ident };
    };
    const a = await seed(orgA, channel.a1 as string, 'a');
    thread = a.id;
    await seed(orgB, channel.b1 as string, 'b');
    const connection = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', 'act-1', 'Tài khoản QC', $3)`, [orgA, connection, users.owner]);
    adAccount = randomUUID();
    await sqlAdmin(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'Tài khoản QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [orgA, adAccount, connection]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const asBrowser = (who: string) => ({ actor: browser(who), orgId: orgA });

  it('marks a note a coworker adds and leaves a person\'s own note unmarked, and the thread detail says which is which', async () => {
    const mine = await run<{ noteId: string }>('kernel.conversation.note', { conversationId: thread, body: 'ghi chú của người' }, asBrowser('owner'));
    const theirs = await run<{ noteId: string }>('kernel.mcp.conversation_note', { conversationId: thread, body: 'ghi chú của Dy' });
    const rows = await sqlAdmin<{ id: string; actor_origin: string; tainted: boolean; author_user_id: string }>(`SELECT id, actor_origin, tainted, author_user_id FROM crove_kernel.conversation_note WHERE id = ANY ($1::uuid[])`, [[mine.noteId, theirs.noteId]]);
    expect(rows.rows.find((r) => r.id === mine.noteId)).toMatchObject({ actor_origin: 'ui', tainted: false });
    // The coworker's note stays under the name of the person who connected the app, and says an app wrote it.
    expect(rows.rows.find((r) => r.id === theirs.noteId)).toMatchObject({ actor_origin: 'mcp', tainted: true, author_user_id: users.owner });
    const detail = await runtime.query<{ notes: Array<{ id: string; actorOrigin: string; tainted: boolean }> }>('kernel.conversation.get', { conversationId: thread }, asBrowser('owner'));
    expect(detail.notes.find((n) => n.id === mine.noteId)).toMatchObject({ actorOrigin: 'ui', tainted: false });
    expect(detail.notes.find((n) => n.id === theirs.noteId)).toMatchObject({ actorOrigin: 'mcp', tainted: true });
  });

  it('marks a deal a coworker opens, taints a person\'s deal only when the coworker writes its text, and never lowers the mark', async () => {
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: 'Công ty dấu' });
    const mine = await run<Deal>('crm.deal.create', { partyId: party.partyId, title: 'Cơ hội của người', amount: '1000000', expectedClose: null }, asBrowser('owner'));
    const theirs = await run<Deal>('crm.mcp.deal_create', { partyId: party.partyId, title: 'Cơ hội của Dy', amount: '2000000', expectedClose: null });
    expect(theirs).toMatchObject({ actorOrigin: 'mcp', tainted: true });
    expect(mine).toMatchObject({ actorOrigin: 'ui', tainted: false });
    const stages = await runtime.query<PipelineStage[]>('crm.stage.list', {}, asBrowser('owner'));
    const second = stages.find((s) => s.kind === 'open' && s.id !== mine.stageId) as PipelineStage;
    const lost = stages.find((s) => s.kind === 'lost') as PipelineStage;
    // A move of stage or order writes no text: the person's deal is not marked.
    const moved = await run<Deal>('crm.mcp.deal_move', { dealId: mine.id, version: mine.version, stageId: second.id });
    expect(moved).toMatchObject({ actorOrigin: 'ui', tainted: false });
    // A lost reason is the coworker's text: the deal is tainted, though a person made it.
    const closed = await run<Deal>('crm.mcp.deal_move', { dealId: mine.id, version: moved.version, stageId: lost.id, lostReason: 'Khách nói giá cao (Dy)' });
    expect(closed).toMatchObject({ actorOrigin: 'ui', tainted: true });
    // A person rewriting it later does not clear the mark.
    const edited = await run<Deal>('crm.deal.update', { dealId: theirs.id, version: theirs.version, partyId: party.partyId, title: 'Cơ hội đã sửa', amount: '2000000', expectedClose: null, ownerUserId: null }, asBrowser('owner'));
    expect(edited).toMatchObject({ actorOrigin: 'mcp', tainted: true });
    // Clearing a person's own lost reason (the coworker moves their lost deal back to an open stage) writes no text: not tainted.
    const own = await run<Deal>('crm.deal.create', { partyId: party.partyId, title: 'Cơ hội thua của người', amount: '3000000', expectedClose: null }, asBrowser('owner'));
    const ownLost = await run<Deal>('crm.deal.move', { dealId: own.id, version: own.version, stageId: lost.id, lostReason: 'Khách chọn nơi khác' }, asBrowser('owner'));
    const reopened = await run<Deal>('crm.mcp.deal_move', { dealId: own.id, version: ownLost.version, stageId: second.id });
    expect(reopened).toMatchObject({ actorOrigin: 'ui', tainted: false, lostReason: null });
    const read = await runtime.query<Deal>('crm.deal.get', { dealId: mine.id }, asBrowser('owner'));
    expect(read).toMatchObject({ actorOrigin: 'ui', tainted: true });
  });

  it('marks a quote and its lines when the coworker saves them, including a person\'s draft it rewrites, and a person\'s own quote stays unmarked', async () => {
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: 'Công ty báo giá dấu' });
    const deal = await run<Deal>('crm.deal.create', { partyId: party.partyId, title: 'Cơ hội báo giá', amount: '5000000', expectedClose: null }, asBrowser('owner'));
    const mine = await run<Quote>('crm.quote.save', { dealId: deal.id, lines: [] }, asBrowser('owner'));
    expect(mine).toMatchObject({ actorOrigin: 'ui', tainted: false });
    const rewritten = await run<Quote>('crm.mcp.quote_save', { quoteId: mine.id, version: mine.version, lines: [{ kind: 'item', description: 'Dòng của Dy', quantity: '1', unitPrice: '100000', vatRate: '10' }] });
    // A person's draft the coworker rewrote: where it came from is unchanged, its text may now be the coworker's.
    expect(rewritten).toMatchObject({ actorOrigin: 'ui', tainted: true });
    expect(await one(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [mine.id])).toMatchObject({ actor_origin: 'mcp', tainted: true });
    const theirs = await run<Quote>('crm.mcp.quote_save', { dealId: deal.id, lines: [] });
    expect(theirs).toMatchObject({ actorOrigin: 'mcp', tainted: true });
    // A person adding a line to the coworker's quote leaves the mark where it was, and the person's own line is not marked.
    const personal = await run<Quote>('crm.quote.save', { quoteId: theirs.id, version: theirs.version, lines: [{ kind: 'item', description: 'Dòng của người', quantity: '1', unitPrice: '50000', vatRate: '10' }] }, asBrowser('owner'));
    expect(personal).toMatchObject({ actorOrigin: 'mcp', tainted: true });
    expect(await one(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [theirs.id])).toMatchObject({ actor_origin: 'ui', tainted: false });
    // A person sends the coworker's quote and then revises it: the revision is the person's, and the coworker's text keeps its mark.
    const sentOne = (await run<{ quote: Quote }>('crm.quote.send', { quoteId: theirs.id, version: personal.version, via: 'link' }, asBrowser('owner'))).quote;
    const revision = await run<Quote>('crm.quote.revise', { quoteId: sentOne.id }, asBrowser('owner'));
    expect(revision).toMatchObject({ status: 'draft', revision: 2, actorOrigin: 'ui', tainted: true });
    const list = await runtime.query<{ items: Array<{ id: string; actorOrigin: string; tainted: boolean }> }>('crm.quote.list', { dealId: deal.id }, asBrowser('owner'));
    expect(list.items.find((q) => q.id === mine.id)).toMatchObject({ actorOrigin: 'ui', tainted: true });
    expect(list.items.find((q) => q.id === theirs.id)).toMatchObject({ actorOrigin: 'mcp', tainted: true });
  });

  it('lets the taint follow the text of a quote line: a person\'s copy of the coworker\'s line keeps it, a line they type does not, and a revision keeps the lines it copies', async () => {
    const party = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'organization', name: 'Công ty dòng báo giá' });
    const deal = await run<Deal>('crm.deal.create', { partyId: party.partyId, title: 'Cơ hội dòng', amount: '1000000', expectedClose: null }, asBrowser('owner'));
    const lines = (text: string) => [{ kind: 'item' as const, description: text, quantity: '1', unitPrice: '100000', vatRate: '10' }];
    const dy = await run<Quote>('crm.mcp.quote_save', { dealId: deal.id, lines: [] });
    const filled = await run<Quote>('crm.mcp.quote_save', { quoteId: dy.id, version: dy.version, lines: lines('Gói Dy đề xuất') });
    // A person copies that line into their own quote (the picker saves it as a new line): same text, still tainted; the row stays the person's.
    const own = await run<Quote>('crm.quote.save', { dealId: deal.id, lines: [] }, asBrowser('owner'));
    expect(own).toMatchObject({ actorOrigin: 'ui', tainted: false });
    const copied = await run<Quote>('crm.quote.save', { quoteId: own.id, version: own.version, lines: lines('Gói Dy đề xuất') }, asBrowser('owner'));
    expect(await one(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [own.id])).toMatchObject({ actor_origin: 'ui', tainted: true });
    // The quote says it carries tainted text though its own row is clean.
    expect(copied).toMatchObject({ actorOrigin: 'ui', tainted: true });
    expect(await one(`SELECT tainted FROM crove_crm.quote WHERE id = $1`, [own.id])).toMatchObject({ tainted: false });
    // A line the person types, or rewrites, is theirs.
    const typed = await run<Quote>('crm.quote.save', { quoteId: own.id, version: copied.version, lines: lines('Gói do người nhập') }, asBrowser('owner'));
    expect(await one(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [own.id])).toMatchObject({ actor_origin: 'ui', tainted: false });
    expect(typed).toMatchObject({ tainted: false });
    // A revision of the coworker's sent quote copies its lines with their mark.
    const sent = (await run<{ quote: Quote }>('crm.quote.send', { quoteId: dy.id, version: filled.version, via: 'link' }, asBrowser('owner'))).quote;
    const revision = await run<Quote>('crm.quote.revise', { quoteId: sent.id }, asBrowser('owner'));
    expect(await one(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [revision.id])).toMatchObject({ actor_origin: 'ui', tainted: true });
  });

  it('marks the contact a coworker adds, in the contact list, and not a person\'s own', async () => {
    const theirs = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'person', name: 'Liên hệ do Dy thêm' });
    const mine = await run<{ partyId: string }>('kernel.party.create', { kind: 'person', name: 'Liên hệ của người' }, asBrowser('owner'));
    const list = await runtime.query<{ items: Array<{ id: string; actorOrigin: string; tainted: boolean }> }>('crm.contact.list', {}, asBrowser('owner'));
    expect(list.items.find((c) => c.id === theirs.partyId)).toMatchObject({ actorOrigin: 'mcp', tainted: true });
    expect(list.items.find((c) => c.id === mine.partyId)).toMatchObject({ actorOrigin: 'ui', tainted: false });
  });

  it('marks the timeline rows a coworker makes and the contact\'s timeline says so, a person\'s rows are unmarked', async () => {
    const made = await run<{ partyId: string }>('kernel.mcp.party_create', { kind: 'person', name: 'Khách dòng thời gian' });
    const mine = await run<{ partyId: string }>('kernel.party.create', { kind: 'person', name: 'Khách của người' }, asBrowser('owner'));
    const timeline = async (id: string) => runtime.query<{ items: Array<{ kind: string; actorOrigin: string; actorName: string | null }> }>('kernel.party.timeline', { partyId: id }, asBrowser('owner'));
    expect((await timeline(made.partyId)).items).toEqual([expect.objectContaining({ kind: 'party.created', actorOrigin: 'mcp' })]);
    expect((await timeline(mine.partyId)).items).toEqual([expect.objectContaining({ kind: 'party.created', actorOrigin: 'ui' })]);
  });
});
