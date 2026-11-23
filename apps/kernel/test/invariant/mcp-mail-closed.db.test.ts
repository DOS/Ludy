// SPDX-License-Identifier: AGPL-3.0-only
// The mail tables are closed to the sealed contexts of an MCP grant (#3956, review follow-up N2 of #3941; ADR-0051 decision 12 opens conversations and CRM to a grant and says "nothing else new"):
// - a sealed MCP context reads no row of mail_event, mail_suppression, inbound_message or today_mail and no non-reply row of mail_message, whatever its kind starts as `mcp_`: the company, member, draft,
//   proposal and Engage kinds and a kind that does not exist yet, whole-org scope or entity scope, and writes none (insert, update and delete are refused or touch nothing);
// - the one exception is the reply row of a conversation thread (`kernel.conversation.reply`), which #3941 lets a grant read exactly as far as it may read the thread (PO decision on #3956, option C): a company grant
//   reads the reply rows of every thread, a member grant those of the threads its member may read, and no grant reads the reply row of a thread it may not;
// - nothing moves for anyone else: a person reads the org's rows (their own on today_mail), an org-chart agent context with no sealed kind keeps its read, and no context reads another org;
// - the real entries (enter_mcp_company_context, enter_mcp_member_context) are closed too, so the test is not only about a hand-sealed shape;
// - the closure is a ratchet: every table of crove_kernel that holds mail (a name with `mail`, and inbound_message) and that the tenant role can read carries exactly one restrictive FOR ALL policy `mcp_sealed_closed`
//   that compares the sealed kind by its `mcp_` prefix and names no kind, so a mail table added later fails here until it is closed or the decision to open it is written.
// The sealed contexts are written by the superuser (ctx_write) in the exact shape the entries write, then read as crove_tenant.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const MAIL_TABLES = ['crove_kernel.mail_message', 'crove_kernel.mail_event', 'crove_kernel.mail_suppression', 'crove_kernel.inbound_message', 'crove_kernel.today_mail'] as const;

suite('the mail tables are closed to the sealed contexts of an MCP grant (#3956)', () => {
  const dbName = `crove_test_mcp_mail_closed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  // The ids of the seeded rows by table and org key.
  const seeded: Record<string, string[]> = {};

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  type Sealed = Record<string, unknown>;
  const sealedBase = (org: string): Sealed => ({ v: 1, org, actor: 'agent', user: null, role: 'admin', agent: randomUUID(), run: null, position: null, module: 'kernel', max_risk: 'R0', tainted: true, le_scope: ['*'], flags: [] });
  const company = (org: string, leScope: string[] = ['*']): Sealed => ({ ...sealedBase(org), le_scope: leScope, kind: 'mcp_company', grantor: users.admin });
  const member = (org: string, who: string): Sealed => ({ ...sealedBase(org), role: 'member', kind: 'mcp_member', member: users[who] });
  // The write kinds of the other MCP entries, and a kind that does not exist yet: all of them are of the `mcp_` family.
  const family = (org: string, kind: string): Sealed => ({ ...sealedBase(org), kind, grantor: users.admin });
  const person = (org: string, who: string): Sealed => ({ v: 1, org, actor: 'user', user: users[who], role: who === 'viewer' ? 'viewer' : 'owner', le_scope: ['*'], flags: [] });
  // An org-chart agent: an agent actor with a run and no sealed kind.
  const orgChartAgent = (org: string): Sealed => ({ v: 1, org, actor: 'agent', user: null, role: 'member', agent: randomUUID(), run: randomUUID(), position: null, module: 'kernel', max_risk: 'R0', tainted: false, le_scope: ['*'], flags: [] });

  async function asSealed<T>(ctx: Sealed, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
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
  const idsOf = (ctx: Sealed, table: string) => asSealed(ctx, async (c) => (await c.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((r) => r.id).sort());
  const countOf = (ctx: Sealed, table: string) => asSealed(ctx, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1);
  const want = (table: string, org: 'a' | 'b'): string[] => [...(seeded[`${table}:${org}`] ?? [])].sort();

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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    const pool = createDbPool({ connectionString: url.toString(), max: 4 }, dbIds);
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of ['owner', 'admin', 'plain', 'viewer', 'foreign']) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-mail-closed', subject: key, email: `${key}@mcp-mail-closed.test`, name: key });
    }
    const asUser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
    orgA = (await createOrg(runtime, asUser('owner'), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser('foreign'), 'Org B')).orgId;
    for (const [who, role] of [['admin', 'admin'], ['plain', 'member'], ['viewer', 'viewer']] as const) {
      await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgA, users[who], role]);
    }
    const keep = (table: string, org: 'a' | 'b', id: string) => (seeded[`${table}:${org}`] ??= []).push(id);
    for (const [key, org, owner] of [['a', orgA, users.owner], ['b', orgB, users.foreign]] as const) {
      // Two mail rows of an org: one any command wrote, and the reply row of a conversation thread (the one #3941 let a grant read through its thread).
      const mail = randomUUID();
      await sqlAdmin(
        `INSERT INTO crove_kernel.mail_message (org_id, id, stream, source, template_key, to_address, to_hash, subject, message_id_header)
         VALUES ($1, $2, 'transactional', 'kernel.invite', 'kernel.invite', $3, $4, 'BÍ MẬT-3956', $5)`,
        [org, mail, `khach-${key}@mcp-mail-closed.test`, 'a'.repeat(64), `<${randomUUID()}@mcp-mail-closed.test>`],
      );
      const channel = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, 'Trang', $4)`, [org, channel, `ext-${key}`, owner]);
      keep('crove_kernel.mail_message', key, mail);
      // The reply row of an email thread and of a comment thread: a member without direct-message rights reads the second thread, not the first, and the reply row follows.
      for (const [short, kind] of [['email', 'email'], ['comment', 'comment_thread']] as const) {
        const reply = randomUUID();
        const identity = randomUUID();
        const conversation = randomUUID();
        const message = randomUUID();
        await sqlAdmin(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, 'Khách')`, [org, identity, `u-${key}-${short}`]);
        await sqlAdmin(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq) VALUES ($1, $2, $3, $4, $5, $6, 1)`, [org, conversation, channel, kind, `t-${key}-${short}`, identity]);
        await sqlAdmin(
          `INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted) VALUES ($1, $2, $3, $4, $5, 1, 'in', now(), 'contact', 'BÍ MẬT-3956', true)`,
          [org, message, conversation, channel, kind],
        );
        await sqlAdmin(
          `INSERT INTO crove_kernel.mail_message (org_id, id, stream, source, source_id, template_key, to_address, to_hash, subject, message_id_header)
           VALUES ($1, $2, 'transactional', 'kernel.conversation.reply', $3, 'kernel.conversation_reply', $4, $5, 'BÍ MẬT-3956', $6)`,
          [org, reply, message, `khach-${key}@mcp-mail-closed.test`, 'b'.repeat(64), `<${randomUUID()}@mcp-mail-closed.test>`],
        );
        keep('crove_kernel.mail_message', key, reply);
        (seeded[`reply:${key}:${short}`] ??= []).push(reply);
      }
      const event = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.mail_event (org_id, id, message_id, provider, provider_event_id, kind, occurred_at) VALUES ($1, $2, $3, 'test', $4, 'delivered', now())`, [org, event, mail, `ev-${key}`]);
      keep('crove_kernel.mail_event', key, event);
      const suppression = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.mail_suppression (org_id, id, to_hash, scope, reason) VALUES ($1, $2, $3, 'all', 'manual')`, [org, suppression, 'c'.repeat(64)]);
      keep('crove_kernel.mail_suppression', key, suppression);
      const inbound = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.inbound_message (org_id, id, message_id, from_address, subject, body_text) VALUES ($1, $2, $3, $4, 'BÍ MẬT-3956', 'BÍ MẬT-3956')`, [org, inbound, `<${randomUUID()}@mcp-mail-closed.test>`, `khach-${key}@mcp-mail-closed.test`]);
      keep('crove_kernel.inbound_message', key, inbound);
      const today = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.today_mail (org_id, id, user_id) VALUES ($1, $2, $3)`, [org, today, owner]);
      keep('crove_kernel.today_mail', key, today);
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

  it('has rows in every mail table of both orgs, so "reads none" is not a table that is empty', async () => {
    for (const table of MAIL_TABLES) {
      expect(want(table, 'a').length, table).toBeGreaterThan(0);
      expect(await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0]?.n), table).toBe(want(table, 'a').length + want(table, 'b').length);
    }
  });

  // The only mail rows a sealed grant may read: the reply rows of the threads it may read (mail_message_conversation_reply follows the thread's own message).
  const READS = ['crove_kernel.mail_message'];
  const replyOf = (...keys: string[]) => keys.map((k) => seeded[`reply:${k}`]?.[0] as string).sort();
  const visible = async (ctx: Sealed, table: string) => (READS.includes(table) ? idsOf(ctx, table) : countOf(ctx, table).then((n) => (n === 0 ? [] : [`${n} rows`])));

  it('reads no mail row in a sealed company context, whole-org or entity-scoped, in any org, but the reply rows of the threads it reads', async () => {
    for (const table of MAIL_TABLES) {
      const own = table === 'crove_kernel.mail_message' ? replyOf('a:email', 'a:comment') : [];
      expect(await visible(company(orgA), table), `${table} (company, whole org)`).toEqual(own);
      expect(await visible(company(orgB), table), `${table} (company B)`).toEqual(table === 'crove_kernel.mail_message' ? replyOf('b:email', 'b:comment') : []);
      expect(await visible(company(orgA, ['00000000-0000-0000-0000-000000000001']), table), `${table} (company, entity scope)`).toEqual([]);
    }
  });

  it('reads no non-reply mail row in a sealed member context of any role, and only the reply rows of the threads its member may read', async () => {
    const reads: Record<string, string[]> = {
      owner: replyOf('a:email', 'a:comment'),
      admin: replyOf('a:email', 'a:comment'),
      // A member without `kernel.conversation.direct.read` reads comment threads, not email: the reply row of the email thread is not theirs.
      plain: replyOf('a:comment'),
      viewer: replyOf('a:comment'),
    };
    for (const table of MAIL_TABLES) {
      for (const who of ['owner', 'admin', 'plain', 'viewer']) {
        expect(await visible(member(orgA, who), table), `${table} (member ${who})`).toEqual(table === 'crove_kernel.mail_message' ? reads[who] : []);
      }
    }
    // The non-reply mail row of the org is read by no grant at all.
    for (const ctx of [company(orgA), member(orgA, 'owner'), member(orgA, 'admin')]) {
      expect(await asSealed(ctx, async (c) => (await c.query(`SELECT 1 FROM crove_kernel.mail_message WHERE source <> 'kernel.conversation.reply'`)).rowCount), String(ctx.kind)).toBe(0);
    }
  });

  it('reads no reply row of a thread it may not read: a member without direct-message rights, a viewer and a context that is no grant of a company or member read none of the email thread\'s reply', async () => {
    const email = replyOf('a:email');
    expect(await idsOf(member(orgA, 'plain'), 'crove_kernel.mail_message')).not.toContain(email[0]);
    expect(await idsOf(member(orgA, 'viewer'), 'crove_kernel.mail_message')).not.toContain(email[0]);
    // The thread the reply belongs to is not readable for them either: the reply row follows the thread, not the other way round.
    for (const who of ['plain', 'viewer']) {
      expect(await asSealed(member(orgA, who), async (c) => (await c.query(`SELECT 1 FROM crove_kernel.conversation_message WHERE kind = 'email'`)).rowCount), who).toBe(0);
    }
    // The other kinds of the family read at most what their own conversation rights open (the Engage write contexts read the threads they act on): never a non-reply mail row, and never a reply row
    // beyond the reply rows of org A, and a kind with no conversation read (draft, proposal, a kind not yet invented) reads none.
    const replies = replyOf('a:email', 'a:comment');
    for (const kind of ['mcp_company_draft', 'mcp_company_proposal', 'mcp_engage_write', 'mcp_ads_draft', 'mcp_not_yet_invented']) {
      const got = await idsOf(family(orgA, kind), 'crove_kernel.mail_message');
      expect(got.filter((id) => !replies.includes(id)), `${kind}: no mail row but a reply row`).toEqual([]);
    }
    for (const kind of ['mcp_company_draft', 'mcp_company_proposal', 'mcp_not_yet_invented']) {
      expect(await idsOf(family(orgA, kind), 'crove_kernel.mail_message'), kind).toEqual([]);
    }
    // The four other tables are closed to every kind of the family, the Engage write kinds included.
    for (const kind of ['mcp_company_draft', 'mcp_company_proposal', 'mcp_engage_write', 'mcp_ads_draft', 'mcp_not_yet_invented']) {
      for (const table of MAIL_TABLES.filter((t) => t !== 'crove_kernel.mail_message')) expect(await countOf(family(orgA, kind), table), `${table} (${kind})`).toBe(0);
    }
  });

  it('writes no mail row: an insert, an update and a delete from a sealed MCP context are refused or touch nothing', async () => {
    const before = await sqlAdmin<{ status: string }>(`SELECT status FROM crove_kernel.mail_message ORDER BY id`);
    for (const ctx of [company(orgA), member(orgA, 'owner'), family(orgA, 'mcp_engage_write')]) {
      const attempts: Array<[string, unknown[]]> = [
        [`INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_address, to_hash, message_id_header) VALUES ($1, 'transactional', 'kernel.invite', 'kernel.invite', 'x@y.test', '${'d'.repeat(64)}', '<x@y.test>')`, [orgA]],
        [`UPDATE crove_kernel.mail_message SET status = 'failed' WHERE org_id = $1`, [orgA]],
        [`DELETE FROM crove_kernel.mail_message WHERE org_id = $1`, [orgA]],
        // The reply row of a thread the grant reads is readable, but never writable: the exception is for the read alone.
        [`UPDATE crove_kernel.mail_message SET status = 'failed' WHERE org_id = $1 AND source = 'kernel.conversation.reply'`, [orgA]],
        [`INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, message_id_header) SELECT $1, 'transactional', 'kernel.conversation.reply', m.id, 'kernel.conversation_reply', 'x@y.test', '${'d'.repeat(64)}', '<r@y.test>' FROM crove_kernel.conversation_message m WHERE m.org_id = $1 LIMIT 1`, [orgA]],
        [`INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason) VALUES ($1, '${'e'.repeat(64)}', 'all', 'manual')`, [orgA]],
        [`UPDATE crove_kernel.mail_suppression SET lifted_at = now(), lifted_by = '${users.owner}', lift_reason = 'x' WHERE org_id = $1`, [orgA]],
        [`INSERT INTO crove_kernel.inbound_message (org_id, message_id) VALUES ($1, '<x@y.test>')`, [orgA]],
        [`DELETE FROM crove_kernel.inbound_message WHERE org_id = $1`, [orgA]],
      ];
      for (const [text, params] of attempts) {
        const touched = await asSealed(ctx, async (c) => {
          await c.query('SAVEPOINT w');
          return c.query(text, params).then((r) => r.rowCount ?? 0, () => 0);
        });
        expect(touched, `${String(ctx.kind)}: ${text.slice(0, 60)}`).toBe(0);
      }
    }
    // Controls: the same statements work for a person of the org, so a refusal above is the grant's and not a statement that fails for its own reasons.
    const control = async (text: string, params: unknown[]) => asSealed(person(orgA, 'owner'), async (c) => (await c.query(text, params)).rowCount ?? 0);
    expect(await control(`UPDATE crove_kernel.mail_message SET status = 'failed' WHERE org_id = $1 AND source = 'kernel.conversation.reply'`, [orgA])).toBeGreaterThan(0);
    expect(await control(`UPDATE crove_kernel.mail_suppression SET lifted_at = now(), lifted_by = '${users.owner}', lift_reason = 'x' WHERE org_id = $1`, [orgA])).toBeGreaterThan(0);
    expect(await control(`INSERT INTO crove_kernel.inbound_message (org_id, message_id) VALUES ($1, '<x@y.test>')`, [orgA])).toBe(1);
    expect((await sqlAdmin<{ status: string }>(`SELECT status FROM crove_kernel.mail_message ORDER BY id`)).rows).toEqual(before.rows);
    expect(await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.mail_suppression WHERE lifted_at IS NOT NULL`).then((r) => r.rows[0]?.n)).toBe(0);
  });

  it('changes nothing for anyone else: a person reads the org\'s mail rows (their own on today_mail) and no other org\'s, and an org-chart agent keeps its read', async () => {
    for (const table of MAIL_TABLES) {
      // today_mail has its own rule for a person (own row) and for an agent actor (none): the other four follow the org.
      const own = table === 'crove_kernel.today_mail';
      expect(await idsOf(person(orgA, 'owner'), table), `${table} (owner of A)`).toEqual(want(table, 'a'));
      expect(await idsOf(person(orgB, 'foreign'), table), `${table} (owner of B)`).toEqual(want(table, 'b'));
      // The reply row of a thread follows the thread's message (mail_message_conversation_reply), which an org-chart agent does not read: that is the rule from before this migration, not a new one.
      if (!own) expect(await idsOf(orgChartAgent(orgA), table), `${table} (org-chart agent)`).toEqual(want(table, 'a').filter((id) => !replyOf('a:email', 'a:comment').includes(id)));
    }
    // The reply row follows its thread for a person, as before (mail_message_conversation_reply).
    expect(await asSealed(person(orgA, 'owner'), async (c) => (await c.query(`SELECT 1 FROM crove_kernel.mail_message WHERE source = 'kernel.conversation.reply'`)).rowCount)).toBe(2);
  });

  it('closes the real entries as the API login: the company and the member context read no mail but the reply rows of the threads they read', async () => {
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
    app.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    app.password = 'test-app-pw';
    const through = async (entry: string, grantId: string) => {
      const c = createDbClient({ connectionString: app.toString() }, dbIds);
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT crove_kernel.${entry}($1::uuid, $2::uuid)`, [orgA, grantId]);
        await c.query('SET LOCAL ROLE crove_tenant');
        const counts: Record<string, number> = {};
        for (const table of MAIL_TABLES) counts[table] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;
        const conversations = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.conversation`)).rows[0]?.n ?? -1;
        return { counts, conversations };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    // The two reply rows of org A's threads (the email and the comment thread) are the only mail a company grant, or the member grant of its owner, reads.
    const none = Object.fromEntries(MAIL_TABLES.map((t) => [t, t === 'crove_kernel.mail_message' ? 2 : 0]));
    const companyRun = await through('enter_mcp_company_context', await grant('admin', 'company'));
    expect(companyRun.counts).toEqual(none);
    expect(companyRun.conversations, 'the conversation read of #3941 is untouched').toBeGreaterThan(0);
    const memberRun = await through('enter_mcp_member_context', await grant('owner', 'member'));
    expect(memberRun.counts).toEqual(none);
    expect(memberRun.conversations, 'the conversation read of #3941 is untouched').toBeGreaterThan(0);
  });

  it('is a ratchet: every mail table the tenant role reads carries exactly the restrictive `mcp_sealed_closed` policy, a prefix test that names no kind', async () => {
    const tables = await sqlAdmin<{ n: string }>(
      `SELECT c.relname::text AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname = 'crove_kernel' AND c.relkind IN ('r', 'p') AND (c.relname ~ 'mail' OR c.relname = 'inbound_message') AND has_table_privilege('crove_tenant', c.oid, 'SELECT')
       ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.n), 'a mail table the tenant role reads: close it with mcp_sealed_closed, or write the decision that opens it to a grant').toEqual(
      MAIL_TABLES.map((t) => t.replace('crove_kernel.', '')).sort(),
    );
    for (const table of MAIL_TABLES) {
      const { rows } = await sqlAdmin<{ n: string; permissive: boolean; cmd: string; roles: string[]; qual: string; check: string }>(
        `SELECT p.polname::text AS n, p.polpermissive AS permissive, p.polcmd::text AS cmd,
                ARRAY(SELECT CASE WHEN o = 0 THEN 'public' ELSE pg_get_userbyid(o) END FROM unnest(p.polroles) o ORDER BY 1)::text[] AS roles,
                coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual, coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS check
         FROM pg_policy p WHERE p.polrelid = $1::regclass AND p.polname = 'mcp_sealed_closed'`,
        [table],
      );
      expect(rows.length, `${table}: one mcp_sealed_closed policy`).toBe(1);
      const p = rows[0];
      // mail_message is closed to reading except the reply row of a thread (which the reply restriction ties to the thread), and to every write: its write commands have their own policies below.
      expect([p?.permissive, p?.cmd, p?.roles], `${table}: restrictive, the tenant role`).toEqual([false, table === 'crove_kernel.mail_message' ? 'r' : '*', ['crove_tenant']]);
      expect(p?.qual, `${table}: a read condition`).not.toBe('');
      for (const text of [p?.qual ?? '', ...(p?.check ? [p.check] : [])]) {
        expect(text, `${table}: reads the sealed kind by its prefix`).toMatch(/ctx_verified/);
        expect(text, `${table}: a prefix test`).toMatch(/'mcp_'/);
        expect(text, `${table}: names no kind of its own`).not.toMatch(/mcp_company|mcp_member|mcp_engage|mcp_ads|ctx_mcp_member_id|'member'/);
      }
      if (table === 'crove_kernel.mail_message') {
        expect(p?.qual, 'the one exception of the read').toMatch(/source = 'kernel\.conversation\.reply'::text\)? OR/);
        const writes = await sqlAdmin<{ n: string; cmd: string; qual: string; check: string }>(
          `SELECT p.polname::text AS n, p.polcmd::text AS cmd, coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual, coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS check
           FROM pg_policy p WHERE p.polrelid = $1::regclass AND p.polname ~ '^mcp_sealed_closed_' AND NOT p.polpermissive ORDER BY 1`,
          [table],
        );
        expect(writes.rows.map((r) => [r.n, r.cmd]), 'one restrictive policy per write command, with no exception').toEqual([['mcp_sealed_closed_delete', 'd'], ['mcp_sealed_closed_insert', 'a'], ['mcp_sealed_closed_update', 'w']]);
        for (const w of writes.rows) {
          expect(`${w.qual} ${w.check}`, w.n).toMatch(/'mcp_'/);
          expect(`${w.qual} ${w.check}`, `${w.n}: no exception`).not.toMatch(/conversation\.reply/);
        }
      }
    }
  });
});
