// SPDX-License-Identifier: AGPL-3.0-only
// What a sealed MCP grant context reads of Hộp thư and the CRM, and that it writes nothing (#3858 slice b; ADR-0051 decisions 10 to 12, owner decision 2026-11-18/19). The database decides, not the query:
// - a company grant (kind `mcp_company`, whole-org scope) reads every conversation of its own org and their messages, notes and contact identities, of every kind, and no row of another org; a company context
//   without the whole-org scope reads none;
// - a member-bound grant (kind `mcp_member`) reads exactly what its member reads as a person (owner and admin everything; a member comment threads, private messages and email only with
//   `kernel.conversation.direct.read`, and only the channels they are limited to; a viewer comment threads), never another member's share, and nothing at all when the sealed member is not a member of the org
//   (another org's member, a removed member);
// - the tables the grant does not need stay closed to it (attachments, AI drafts, composing markers, read marks);
// - the CRM tables (party, deal, quote) answer a sealed context its own org's rows and no other org's;
// - NOTHING WRITES: every insert, update and delete on these tables is refused to both kinds, in a read-write transaction (the read-only transaction of a query is the second wall), while a person's own
//   context still writes (so the refusal is the grant's, not a table nobody can write);
// - the policies that name the company kind in crove_kernel and crove_crm are exactly the two read policies this slice adds, no write policy names either kind, and the member function is the API's alone in
//   the sense that only the tenant role may call it and it answers false to every context but a member grant's.
// The sealed contexts are written by the superuser (ctx_write) in the exact shape the entries write, then read as crove_tenant; one case also goes through the real entries as the API login.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const CANARY = 'BÍ MẬT-3858';

suite('what a sealed MCP grant context reads of Hộp thư and the CRM, and that it writes nothing (#3858 slice b)', () => {
  const dbName = `crove_test_mcp_grant_read_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};
  // Every seeded row by key: conversations, messages, notes, parties, deals.
  const conv: Record<string, string> = {};
  const channel: Record<string, string> = {};

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

  type Sealed = Record<string, unknown>;
  const company = (org: string, leScope: string[] = ['*']): Sealed => ({
    v: 1, org, actor: 'agent', user: null, role: 'admin', agent: randomUUID(), run: null, position: null, module: 'kernel', max_risk: 'R0', tainted: true, le_scope: leScope, flags: [], kind: 'mcp_company', grantor: users.admin,
  });
  const member = (org: string, who: string): Sealed => ({
    v: 1, org, actor: 'agent', user: null, role: roles[who] ?? 'member', agent: randomUUID(), run: null, position: null, module: 'kernel', max_risk: 'R0', tainted: true, le_scope: ['*'], flags: [], kind: 'mcp_member', member: users[who] ?? who,
  });
  const person = (org: string, who: string): Sealed => ({ v: 1, org, actor: 'user', user: users[who], role: roles[who] ?? 'member', le_scope: ['*'], flags: [] });

  async function asSealed<T>(ctx: Sealed, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.ctx_write($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('SET LOCAL ROLE crove_tenant');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const ids = (ctx: Sealed, table: string) => asSealed(ctx, async (c) => (await c.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((r) => r.id).sort());
  const orgsOf = (ctx: Sealed, table: string) => asSealed(ctx, async (c) => [...new Set((await c.query<{ org_id: string }>(`SELECT org_id FROM ${table}`)).rows.map((r) => r.org_id))]);
  const sorted = (keys: string[]) => keys.map((k) => conv[k] as string).sort();
  // The conversation ids of one org by kind.
  const A_ALL = ['a1c', 'a1d', 'a1e', 'a2c', 'a2d'];
  const A_COMMENTS = ['a1c', 'a2c'];

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
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of ['owner', 'admin', 'desk', 'plain', 'limited', 'limitedDesk', 'viewer', 'foreign', 'outsider']) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-grant-read', subject: key, email: `${key}@mcp-grant-read.test`, name: key });
    }
    const asUser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
    orgA = (await createOrg(runtime, asUser('owner'), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser('foreign'), 'Org B')).orgId;
    Object.assign(roles, { owner: 'owner', admin: 'admin', desk: 'member', plain: 'member', limited: 'member', limitedDesk: 'member', viewer: 'viewer', foreign: 'owner' });
    for (const who of ['admin', 'desk', 'plain', 'limited', 'limitedDesk', 'viewer']) {
      await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgA, users[who], roles[who]]);
    }
    // desk.agent holds kernel.conversation.direct.read (migration 20261121100000).
    for (const who of ['desk', 'limitedDesk']) {
      await sqlAdmin(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)`, [orgA, users[who], users.owner]);
    }
    for (const [key, org, owner] of [['a1', orgA, users.owner], ['a2', orgA, users.owner], ['b1', orgB, users.foreign]] as const) {
      channel[key] = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, $4, $5)`, [org, channel[key], `ext-${key}`, `Trang ${key}`, owner]);
    }
    // The limits: `limited` reads channel a1 only, `limitedDesk` channel a2 only.
    await sqlAdmin(`INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)`, [orgA, users.limited, channel.a1, users.owner, users.limitedDesk, channel.a2]);
    const seedConversation = async (key: string, org: string, ch: string, kind: 'comment_thread' | 'direct' | 'email', author: string) => {
      conv[key] = randomUUID();
      const identity = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, $4)`, [org, identity, `u-${key}`, `${CANARY} ${key}`]);
      conv[`identity:${key}`] = identity;
      await sqlAdmin(
        `INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [org, conv[key], ch, kind, `t-${key}`, identity],
      );
      const message = randomUUID();
      conv[`message:${key}`] = message;
      await sqlAdmin(
        `INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted) VALUES ($1, $2, $3, $4, $5, 1, 'in', now(), 'contact', $6, true)`,
        [org, message, conv[key], ch, kind, `${CANARY} tin nhắn ${key}`],
      );
      const note = randomUUID();
      conv[`note:${key}`] = note;
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, $5)`, [org, note, conv[key], author, `${CANARY} ghi chú ${key}`]);
      // The tables a grant does not need: one row each, so "reads none of them" is not a table that is empty.
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_read (org_id, conversation_id, user_id, last_read_seq) VALUES ($1, $2, $3, 1)`, [org, conv[key], author]);
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_draft (org_id, conversation_id, channel_connection_id, kind, basis_seq, source) VALUES ($1, $2, $3, $4, 1, 'asked')`, [org, conv[key], ch, kind]);
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_composing (org_id, conversation_id, channel_connection_id, kind, user_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`, [org, conv[key], ch, kind, author]);
      await sqlAdmin(`INSERT INTO crove_kernel.conversation_attachment (org_id, message_id, channel_connection_id, kind, storage_key) VALUES ($1, $2, $3, $4, $5)`, [org, message, ch, kind, `conversation/${org}/${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`]);
    };
    await seedConversation('a1c', orgA, channel.a1 as string, 'comment_thread', users.owner as string);
    await seedConversation('a1d', orgA, channel.a1 as string, 'direct', users.owner as string);
    await seedConversation('a1e', orgA, channel.a1 as string, 'email', users.owner as string);
    await seedConversation('a2c', orgA, channel.a2 as string, 'comment_thread', users.owner as string);
    await seedConversation('a2d', orgA, channel.a2 as string, 'direct', users.owner as string);
    await seedConversation('b1c', orgB, channel.b1 as string, 'comment_thread', users.foreign as string);
    await seedConversation('b1d', orgB, channel.b1 as string, 'direct', users.foreign as string);
    // The CRM: a party, a stage, a deal and a quote in each org.
    for (const [key, org, owner] of [['a', orgA, users.owner], ['b', orgB, users.foreign]] as const) {
      const party = randomUUID();
      const stage = randomUUID();
      const deal = randomUUID();
      conv[`party:${key}`] = party;
      conv[`deal:${key}`] = deal;
      await sqlAdmin(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, $3)`, [org, party, `${CANARY} khách ${key}`]);
      await sqlAdmin(`INSERT INTO crove_crm.pipeline_stage (org_id, id, name, kind, position) VALUES ($1, $2, 'Mới', 'open', 1)`, [org, stage]);
      await sqlAdmin(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, stage_id, sort_key, created_by) VALUES ($1, $2, $3, $4, $5, 'a0', $6)`, [org, deal, party, `${CANARY} deal ${key}`, stage, owner]);
    }
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const CONVERSATION_TABLES = ['crove_kernel.conversation', 'crove_kernel.conversation_message', 'crove_kernel.conversation_note', 'crove_kernel.conversation_identity'];
  const CLOSED_TABLES = ['crove_kernel.conversation_attachment', 'crove_kernel.conversation_draft', 'crove_kernel.conversation_composing', 'crove_kernel.conversation_read'];
  // The row of each table that belongs to a conversation key.
  const rowsOfKeys = (table: string, keys: string[]): string[] => {
    const prefix: Record<string, string> = { 'crove_kernel.conversation': '', 'crove_kernel.conversation_message': 'message:', 'crove_kernel.conversation_note': 'note:', 'crove_kernel.conversation_identity': 'identity:' };
    return keys.map((k) => conv[`${prefix[table]}${k}`] as string).sort();
  };

  it('lets a company grant read every conversation of its org with its messages, notes and contacts, of every kind, and nothing of another org', async () => {
    for (const table of CONVERSATION_TABLES) {
      expect(await ids(company(orgA), table), table).toEqual(rowsOfKeys(table, A_ALL));
      expect(await ids(company(orgB), table), table).toEqual(rowsOfKeys(table, ['b1c', 'b1d']));
      expect(await orgsOf(company(orgA), table)).toEqual([orgA]);
    }
  });

  it('reads nothing for a company context without the whole-org scope, as a person limited to an entity reads none of the org-wide rows', async () => {
    for (const table of CONVERSATION_TABLES) expect(await ids(company(orgA, ['11111111-1111-4111-8111-111111111111']), table), table).toEqual([]);
  });

  it('keeps the tables a grant does not need closed to it: attachments, AI drafts, composing markers and read marks', async () => {
    for (const ctx of [company(orgA), member(orgA, 'admin'), member(orgA, 'owner')]) {
      for (const table of CLOSED_TABLES) expect(await ids(ctx, table), table).toEqual([]);
    }
    // Control: they hold rows for a person who may read the thread (an owner reads the attachments).
    expect((await ids(person(orgA, 'owner'), 'crove_kernel.conversation_attachment')).length).toBe(5);
  });

  it('reads for a member-bound grant exactly what its member reads as a person, for every role, channel limit and the direct-message permission', async () => {
    const expected: Record<string, string[]> = {
      owner: A_ALL,
      admin: A_ALL,
      desk: A_ALL,
      plain: A_COMMENTS,
      limited: ['a1c'],
      limitedDesk: ['a2c', 'a2d'],
      viewer: A_COMMENTS,
    };
    for (const [who, keys] of Object.entries(expected)) {
      for (const table of CONVERSATION_TABLES) {
        expect(await ids(member(orgA, who), table), `grant of ${who} on ${table}`).toEqual(rowsOfKeys(table, keys));
        // The same answer a person of that role gets: the grant never reads more (or less) than its member.
        expect(await ids(person(orgA, who), table), `person ${who} on ${table}`).toEqual(rowsOfKeys(table, keys));
      }
    }
  });

  it('keeps one member\'s grant from reading another\'s share and the company\'s: a limited member never reads the other channel, a member without the permission never reads a private message', async () => {
    expect(await ids(member(orgA, 'limited'), 'crove_kernel.conversation')).not.toContain(conv.a2c);
    expect(await ids(member(orgA, 'plain'), 'crove_kernel.conversation')).not.toContain(conv.a1d);
    expect(await ids(member(orgA, 'plain'), 'crove_kernel.conversation_message')).not.toContain(conv['message:a1d']);
    expect(await ids(member(orgA, 'limitedDesk'), 'crove_kernel.conversation')).not.toContain(conv.a1d);
    expect(await ids(member(orgA, 'viewer'), 'crove_kernel.conversation_note')).not.toContain(conv['note:a1d']);
  });

  it('reads nothing for a member-bound grant whose member is not a member of the org: another org\'s member, a person who never joined, an unknown id', async () => {
    for (const who of ['foreign', 'outsider', randomUUID()]) {
      for (const table of CONVERSATION_TABLES) expect(await ids(member(orgA, who), table), `${who} on ${table}`).toEqual([]);
    }
    // A member of org B reads org B's rows only, through their own org's context.
    expect(await ids(member(orgB, 'foreign'), 'crove_kernel.conversation')).toEqual(sorted(['b1c', 'b1d']));
  });

  it('reads no row for a context that is neither a company grant nor a member grant: an agent of another kind, a user of no membership, no context', async () => {
    const other: Sealed = { ...company(orgA), kind: 'mcp_company_draft' };
    expect(await ids(other, 'crove_kernel.conversation')).toEqual([]);
    const agent: Sealed = { ...company(orgA), kind: undefined };
    expect(await ids(agent, 'crove_kernel.conversation')).toEqual([]);
    const stranger: Sealed = { ...person(orgA, 'outsider'), user: users.outsider };
    expect(await ids(stranger, 'crove_kernel.conversation')).toEqual([]);
    // A company seal that names a member does not borrow a member's rights, and a member seal does not read the company way: the one without the whole-org branch sees only its member's share.
    const mixed: Sealed = { ...member(orgA, 'plain'), grantor: users.admin };
    expect(await ids(mixed, 'crove_kernel.conversation')).toEqual(sorted(A_COMMENTS));
  });

  it('reads the CRM of its own org and no other, for a company grant and a member grant alike', async () => {
    for (const ctx of [company(orgA), member(orgA, 'plain'), member(orgA, 'viewer')]) {
      expect(await ids(ctx, 'crove_kernel.party')).toEqual([conv['party:a']]);
      expect(await ids(ctx, 'crove_crm.deal')).toEqual([conv['deal:a']]);
      expect(await orgsOf(ctx, 'crove_crm.pipeline_stage')).toEqual([orgA]);
    }
    expect(await ids(company(orgB), 'crove_crm.deal')).toEqual([conv['deal:b']]);
    // A context with no org of its own reads nothing: the seal of an org that does not exist.
    expect(await ids(company(randomUUID()), 'crove_crm.deal')).toEqual([]);
    expect(await ids(company(randomUUID()), 'crove_kernel.conversation')).toEqual([]);
  });

  it('writes nothing: no insert, update or delete on a conversation table or a CRM table, for either kind, even in a read-write transaction', async () => {
    const attempts: Array<[string, string, unknown[]]> = [
      [`UPDATE crove_kernel.conversation SET status = 'pending' WHERE org_id = $1`, 'update conversation', [orgA]],
      [`DELETE FROM crove_kernel.conversation WHERE org_id = $1`, 'delete conversation', [orgA]],
      [`UPDATE crove_kernel.conversation_message SET body = 'x' WHERE org_id = $1`, 'update message', [orgA]],
      [`DELETE FROM crove_kernel.conversation_message WHERE org_id = $1`, 'delete message', [orgA]],
      [`DELETE FROM crove_kernel.conversation_note WHERE org_id = $1`, 'delete note', [orgA]],
      [`UPDATE crove_kernel.conversation_identity SET display_name = 'x' WHERE org_id = $1`, 'update identity', [orgA]],
      [`UPDATE crove_kernel.party SET name = 'x' WHERE org_id = $1`, 'update party', [orgA]],
      [`DELETE FROM crove_crm.deal WHERE org_id = $1`, 'delete deal', [orgA]],
      [`UPDATE crove_crm.deal SET title = 'x' WHERE org_id = $1`, 'update deal', [orgA]],
    ];
    const inserts: Array<[string, string, (k: string) => unknown[]]> = [
      [
        `INSERT INTO crove_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id) VALUES ($1, $2, 'comment_thread', 'x')`,
        'insert conversation',
        () => [orgA, channel.a1],
      ],
      [
        `INSERT INTO crove_kernel.conversation_note (org_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, 'x')`,
        'insert note',
        () => [orgA, conv.a1c, users.admin],
      ],
      [
        `INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, send_state) VALUES ($1, $2, $3, 'comment_thread', 2, 'out', now(), 'member', 'x', 'queued')`,
        'insert message',
        () => [orgA, conv.a1c, channel.a1],
      ],
      [`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'x')`, 'insert party', () => [orgA]],
    ];
    for (const ctx of [company(orgA), member(orgA, 'admin'), member(orgA, 'owner'), member(orgA, 'desk')]) {
      await asSealed(ctx, async (c) => {
        let n = 0;
        const refused = async (text: string, params: unknown[]): Promise<boolean> => {
          const sp = `sp_${n++}`;
          await c.query(`SAVEPOINT ${sp}`);
          try {
            const res = await c.query(text, params);
            await c.query(`ROLLBACK TO ${sp}`);
            // A statement that changes no row (the policy filtered every row out) counts as refused; one that changes a row does not.
            return (res.rowCount ?? 0) === 0;
          } catch {
            await c.query(`ROLLBACK TO ${sp}`);
            return true;
          }
        };
        for (const [text, label, params] of attempts) expect(await refused(text, params), `${String(ctx.kind)}: ${label}`).toBe(true);
        for (const [text, label, params] of inserts) expect(await refused(text, params('')), `${String(ctx.kind)}: ${label}`).toBe(true);
      });
    }
    // Control: a person of the same org still writes the same rows, so the refusal above is the grant's and not a table nobody can write.
    await asSealed(person(orgA, 'owner'), async (c) => {
      expect((await c.query(`UPDATE crove_kernel.conversation SET status = 'pending' WHERE org_id = $1 AND id = $2`, [orgA, conv.a1c])).rowCount).toBe(1);
      expect((await c.query(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'x')`, [orgA])).rowCount).toBe(1);
    });
  });

  it('reads and writes through the real entries as the API login: the company grant reads its org, the member grant reads its member\'s share, and a write is refused', async () => {
    await sqlAdmin(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
    const grant = async (who: string, kind: 'company' | 'member') => {
      const id = randomUUID();
      await sqlAdmin(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, now(), now() + interval '30 days', $3, $6, $7)`,
        [orgA, id, users[who], `client-${id}`, `oauth-${id}`, kind, kind === 'member' ? users[who] : null],
      );
      return id;
    };
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const through = async (entry: string, grantId: string): Promise<{ conversations: string[]; refused: boolean }> => {
      const c = new pg.Client({ connectionString: app.toString() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.${entry}($1::uuid, $2::uuid)`, [orgA, grantId]);
        await c.query('SET LOCAL ROLE crove_tenant');
        const conversations = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.conversation')).rows.map((r) => r.id).sort();
        await c.query('SAVEPOINT w');
        const refused = await c.query(`UPDATE crove_kernel.conversation SET status = 'pending'`).then((r) => r.rowCount === 0, () => true);
        await c.query('ROLLBACK TO w');
        return { conversations, refused };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const companyRun = await through('enter_mcp_company_context', await grant('admin', 'company'));
    expect(companyRun.conversations).toEqual(sorted(A_ALL));
    expect(companyRun.refused).toBe(true);
    const memberRun = await through('enter_mcp_member_context', await grant('plain', 'member'));
    expect(memberRun.conversations).toEqual(sorted(A_COMMENTS));
    expect(memberRun.refused).toBe(true);
    const limitedRun = await through('enter_mcp_member_context', await grant('limitedDesk', 'member'));
    expect(limitedRun.conversations).toEqual(sorted(['a2c', 'a2d']));
    expect(limitedRun.refused).toBe(true);
  });

  it('names the company kind in exactly two policies of crove_kernel and crove_crm, both read policies, and no write policy names either kind or the member helper', async () => {
    const { rows } = await sqlAdmin<{ t: string; n: string; cmd: string; text: string }>(
      `SELECT p.polrelid::regclass::text AS t, p.polname::text AS n, p.polcmd::text AS cmd,
              coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS text
       FROM pg_policy p JOIN pg_class r ON r.oid = p.polrelid JOIN pg_namespace s ON s.oid = r.relnamespace
       WHERE s.nspname IN ('crove_kernel', 'crove_crm') ORDER BY 1, 2`,
    );
    const naming = rows.filter((p) => /mcp_company|mcp_member|ctx_mcp_member_id|conversation_access_mcp_member/.test(p.text));
    expect(naming.map((p) => `${p.t}.${p.n}.${p.cmd}`)).toEqual(['crove_kernel.conversation.conversation_scope_read.r', 'crove_kernel.conversation_message.conversation_message_scope_read.r']);
    for (const p of rows.filter((x) => x.cmd !== 'r')) expect(p.text, `${p.t}.${p.n}`).not.toMatch(/mcp_company|mcp_member|ctx_mcp_member_id|conversation_access_mcp_member/);
    // The tables that follow a thread's own row, and the CRM tables, carry no kind of their own.
    for (const p of rows.filter((x) => /conversation_(note|identity)$|crove_crm\./.test(x.t))) expect(p.text, `${p.t}.${p.n}`).not.toMatch(/mcp_company|mcp_member/);
    // The reads of the two policies keep the person branch and the whole-org scope.
    for (const p of rows.filter((x) => x.n === 'conversation_scope_read' || x.n === 'conversation_message_scope_read')) {
      expect(p.text).toMatch(/conversation_access\(kind, channel_connection_id, false\)/);
      expect(p.text).toMatch(/ctx_le_scope/);
    }
  });

  it('keeps the member function to the tenant role and its members, a definer with a pinned search path, answering false to every context but a member grant\'s and reading no kind by name', async () => {
    const fn = 'crove_kernel.conversation_access_mcp_member(text, uuid)';
    await admin(async (c) => {
      const logins = (await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper`)).rows;
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, '${fn}', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        // The tenant role and the logins that are members of it (the API runs its queries as crove_tenant) hold it; no other role and not the public.
        const tenant = (await c.query(`SELECT pg_has_role($1, 'crove_tenant', 'MEMBER') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute ${fn}`).toBe(tenant);
      }
      expect((await c.query(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
      const cfg = (await c.query(`SELECT proconfig FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0].proconfig as string[] | null;
      expect(JSON.stringify(cfg)).toContain('search_path=pg_catalog, pg_temp');
      const def = (await c.query(`SELECT pg_get_functiondef('${fn}'::regprocedure) AS d`)).rows[0].d as string;
      expect(def).not.toMatch(/mcp_company|'member'/i);
      expect(def).toMatch(/SECURITY DEFINER/);
      expect(def).toMatch(/ctx_mcp_member_id/);
    });
    // A person, a company grant and no context get false, whatever kind and channel they ask for.
    for (const ctx of [person(orgA, 'admin'), person(orgA, 'owner'), company(orgA)]) {
      const answer = await asSealed(ctx, async (c) => (await c.query<{ ok: boolean }>(`SELECT crove_kernel.conversation_access_mcp_member('comment_thread', $1) AS ok`, [channel.a1])).rows[0]?.ok);
      expect(answer, String(ctx.kind ?? ctx.actor)).toBe(false);
    }
  });
});
