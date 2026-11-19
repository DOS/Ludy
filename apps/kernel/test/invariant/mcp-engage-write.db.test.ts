// SPDX-License-Identifier: AGPL-3.0-only
// The sealed write contexts of the Engage coworkers (E2 of #3857, issue #3861; ADR-0051 decisions 10 and 11; the review's N4): what the database lets a company MCP grant do once it holds
// `ludy.engage.write` (kind `mcp_engage_write`) or `ludy.ads.draft` (kind `mcp_ads_draft`).
// - the entry `crove_kernel.enter_mcp_company_write_context(org, grant, scope)` is the API login's alone with a pinned search path, refuses a read-only transaction, a scope that is not one of the two,
//   a grant without the scope, a revoked, expired, member-bound or demoted grant and another org's, and seals exactly the keys named below (no user, tainted, R1);
// - only the entry, the write guard, the helper that says which rows, the timeline stamp and the next step's guard name a kind of the two;
// - in the sealed engage context the guard lets in only the writes of the commands: the update of a thread's assignee, status, resolution and contact; a note by the grantor; a contact that is `external`; a deal by the
//   grantor and its stage, order and close; a draft quote and its lines; a next step marked done by the grantor or snoozed; nothing else on those tables (not a thread's channel, kind, sender or text, a message,
//   a deal's title or amount, a sent quote, a quote's number, a delete of anything but a draft quote's lines) and nothing on any other table, whatever the table, the statement or the row;
// - in the sealed ads context only a new AI draft of the grantor, and an edit of an AI draft that stays one, for ads, and nothing else;
// - the other contexts are as they were: a person's own writes of the same rows still pass, and the read context of a company grant still writes its audit row and nothing else.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENTRY = 'crove_kernel.enter_mcp_company_write_context(uuid,uuid,text)';
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';
// A refused statement ends in one of these (the guard first; a table with a rule of its own or a missing privilege may speak before it). What matters is that it never succeeds.
const REFUSED = /AGENT_FORBIDDEN|AGENT_LEASE_REQUIRED|[A-Z_]+_FORBIDDEN|[A-Z_]+_IMMUTABLE|[A-Z_]+_FROZEN|NO_ROW|permission denied|row-level security|violates|null value|CHECK|policy/;
// The tables the engage kind may write at all (and no other), the same list as mcp_write_row_ok's engage branch.
const ENGAGE_TABLES = ['crove_crm.deal', 'crove_crm.deal_next_step', 'crove_crm.pipeline_stage', 'crove_crm.quote', 'crove_crm.quote_line', 'crove_kernel.conversation', 'crove_kernel.conversation_note', 'crove_kernel.party'];
const ADS_TABLES = ['crove_ads.ad_campaign_draft'];

suite('the sealed write contexts of the Engage coworkers (#3861)', () => {
  const dbName = `crove_test_mcp_engage_write_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let orgId = '';
  let otherOrg = '';
  const pools: pg.Pool[] = [];
  const users = { owner: '', admin: '', member: '', other: '' };
  const s: Record<string, string> = {};

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
  const asApp = async () => {
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  async function grant(org: string, user: string, scopes: string[] = ['ludy.read', ENGAGE, ADS], extra = '', kind = 'company') {
    const id = randomUUID();
    await q(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', $6::text[], $4, now() ${extra}, now() ${extra} + interval '30 days', $3, $7, $8)`,
      [org, id, user, `oauth-${id}`, `client-${id}`, scopes, kind, kind === 'member' ? user : null],
    );
    return id;
  }

  // One transaction of the API login that has entered a write context of a grant; `fn` runs inside it, each statement tried in a savepoint so a refusal does not end the transaction. `attempt` answers
  // null when the statement succeeded, else the error message.
  async function inWrite<T>(grantId: string, scope: string, fn: (attempt: (sql: string, params?: unknown[]) => Promise<string | null>, c: pg.Client) => Promise<T>): Promise<T> {
    const c = await asApp();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, grantId, scope]);
      let n = 0;
      const attempt = async (sql: string, params: unknown[] = []) => {
        const sp = `sp_${n++}`;
        await c.query(`SAVEPOINT ${sp}`);
        try {
          const done = await c.query(sql, params);
          await c.query(`RELEASE SAVEPOINT ${sp}`);
          // An update or a delete that no policy lets reach its row changes nothing and raises nothing: that is a refusal too, and a write that was meant to land and did not is a failure.
          return /^\s*(UPDATE|DELETE)/i.test(sql) && done.rowCount === 0 ? 'NO_ROW' : null;
        } catch (error) {
          await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          return (error as Error).message;
        }
      };
      return await fn(attempt, c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  // A delete that no policy lets reach its row matches nothing and raises nothing: what must hold is that the row is still there.
  const kept = async (label: string, c: pg.Client, attempt: (sql: string, params?: unknown[]) => Promise<string | null>, table: string, id: string) => {
    const count = async () => (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id])).rows[0].n as number;
    const before = await count();
    expect(before, `${label}: the row exists`).toBe(1);
    const result = await attempt(`DELETE FROM ${table} WHERE org_id = $1 AND id = $2`, [orgId, id]);
    if (result !== null) expect(result, label).toMatch(REFUSED);
    expect(await count(), `${label}: the row is still there`).toBe(1);
  };
  // The rows of a table the context can see, or 0 where it cannot read the table (in a savepoint, so a refusal does not end the transaction).
  const countOf = async (c: pg.Client, table: string): Promise<number> => {
    await c.query('SAVEPOINT counting');
    try {
      const n = (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
      await c.query('RELEASE SAVEPOINT counting');
      return n;
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT counting');
      return 0;
    }
  };
  const refused = (label: string, message: string | null) => {
    expect(message, `${label}: it must be refused`).not.toBeNull();
    expect(message as string, label).toMatch(REFUSED);
  };

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
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-engage-write', subject: key, email: `${key}@mcp-engage-write.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Org A')).orgId;
    otherOrg = (await createOrg(runtime, { type: 'user', userId: users.other, aal: 'aal1' }, 'Org B')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, users.admin, users.member]);
    // The rows the contexts act on, written by the superuser.
    const id = () => randomUUID();
    Object.assign(s, { deal2: id(), conn: id(), ident: id(), conv: id(), msg: id(), note: id(), party: id(), stageOpen: id(), stageOpen2: id(), stageWon: id(), deal: id(), quoteDraft: id(), quoteSent: id(), step: id(), step2: id(), account: id(), connAds: id(), aiDraft: id(), humanDraft: id() });
    await q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', 'ext-1', 'Trang', $3), ($1, $4, 'sandbox_ads', 'act-1', 'QC', $3)`, [orgId, s.conn, users.owner, s.connAds]);
    await q(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', 'u-1-12345678', 'Khách')`, [orgId, s.ident]);
    await q(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at) VALUES ($1, $2, $3, 'comment_thread', 't-1', $4, 1, now(), now())`, [orgId, s.conv, s.conn, s.ident]);
    await q(`INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted, author_identity_id) VALUES ($1, $2, $3, $4, 'comment_thread', 1, 'in', now(), 'contact', 'Xin chào', true, $5)`, [orgId, s.msg, s.conv, s.conn, s.ident]);
    await q(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'ghi chú của người')`, [orgId, s.note, s.conv, users.owner]);
    await q(`INSERT INTO crove_kernel.party (org_id, id, kind, name, source_trust) VALUES ($1, $2, 'person', 'Khách A', 'user')`, [orgId, s.party]);
    await q(`INSERT INTO crove_crm.pipeline_stage (org_id, id, name, kind, position) VALUES ($1, $2, 'Mới', 'open', 1), ($1, $3, 'Đang bàn', 'open', 2), ($1, $4, 'Thắng', 'won', 3)`, [orgId, s.stageOpen, s.stageOpen2, s.stageWon]);
    await q(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'Cơ hội', 1000000, $4, 'a0', $5, $5)`, [orgId, s.deal, s.party, s.stageOpen, users.owner]);
    await q(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'Cơ hội hai', 2000000, $4, 'a1', $5, $5)`, [orgId, s.deal2, s.party, s.stageOpen, users.owner]);
    await q(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by) VALUES ($1, $2, $3, $4, '2031-01-31', $5)`, [orgId, s.quoteDraft, s.deal, s.party, users.owner]);
    const entity = (await q<{ id: string }>(`SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0]?.id ?? null;
    await q(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, status, number, sent_at, sent_via, issuer_entity_id, buyer_name) VALUES ($1, $2, $3, $4, '2031-01-31', $5, 'sent', 'BG-2031-0001', now(), 'link', $6, 'Khách A')`, [orgId, s.quoteSent, s.deal, s.party, users.owner, entity]);
    await q(`INSERT INTO crove_crm.deal_next_step (org_id, id, deal_id, reason, since_on) VALUES ($1, $2, $3, 'no_activity', '2026-10-01'), ($1, $5, $4, 'past_close', '2026-10-02')`, [orgId, s.step, s.deal, s.deal2, s.step2]);
    await q(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', 'act-1', 'QC', '2025-10-01', 'VND', 'Asia/Ho_Chi_Minh')`, [orgId, s.account, s.connAds]);
    await q(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by, origin, ai_fields) VALUES ($1, $2, $3, 'AI', 'traffic', $4, 'ai', ARRAY['name']), ($1, $5, $3, 'Người', 'traffic', $4, 'human', ARRAY[]::text[])`, [orgId, s.aiDraft, s.account, users.owner, s.humanDraft]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives the entry to the API login alone, with a pinned search path, and lets only six functions name a kind of the two', async () => {
    await admin(async (c) => {
      const logins = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper`)).rows as Array<{ rolname: string }>;
      expect(logins.map((r) => r.rolname)).toContain('crove_app');
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, '${ENTRY}', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute the write entry`).toBe(rolname === 'crove_app');
      }
      expect((await c.query(`SELECT has_function_privilege('public', '${ENTRY}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
      expect((await c.query(`SELECT proconfig FROM pg_proc WHERE oid = '${ENTRY}'::regprocedure`)).rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      // The helper that says which rows is no login's to call.
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, 'crove_kernel.mcp_write_row_ok(text,text,text,jsonb,jsonb,uuid)', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute mcp_write_row_ok`).toBe(false);
      }
      const { rows } = await c.query(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~ '''(mcp_engage_write|mcp_ads_draft)''' ORDER BY 1`,
      );
      expect(rows.map((r) => r.n)).toEqual([
        'crove_crm.deal_next_step_guard()',
        'crove_kernel.activity_stamp_agent()',
        'crove_kernel.agent_write_guard()',
        'crove_kernel.ctx_mcp_engage_write()',
        'crove_kernel.enter_mcp_company_write_context(uuid,uuid,text)',
        'crove_kernel.mcp_write_row_ok(text,text,text,jsonb,jsonb,uuid)',
      ]);
      // The engage kind is asked about in policies of exactly these tables, through the one function and never by reading the sealed key, and only by read or write checks the engage kind passes.
      const pol = (await c.query(`SELECT schemaname || '.' || tablename AS t, policyname AS n FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '(ctx_mcp_engage_write|mcp_engage_write|mcp_ads_draft)' ORDER BY 1, 2`)).rows;
      expect(pol.map((r) => `${r.t}.${r.n}`)).toEqual([
        'crove_crm.deal_next_step.deal_next_step_update',
        'crove_crm.quote.quote_insert',
        'crove_crm.quote.quote_update',
        'crove_crm.quote_line.quote_line_delete',
        'crove_crm.quote_line.quote_line_insert',
        'crove_kernel.conversation.conversation_scope_read',
        'crove_kernel.conversation.conversation_scope_update',
        'crove_kernel.conversation_message.conversation_message_scope_read',
        'crove_kernel.conversation_note.conversation_note_scope',
      ]);
      // None of them reads the sealed context itself, and the ads kind is in no policy. The function is for the tenant roles (a definer role inherits it) and no other login.
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname || '.' || tablename || '.' || policyname IN ('crove_crm.quote.quote_insert', 'crove_crm.quote_line.quote_line_insert', 'crove_crm.deal_next_step.deal_next_step_update', 'crove_kernel.conversation_note.conversation_note_scope') AND coalesce(qual, '') || coalesce(with_check, '') ~ 'ctx_verified'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'mcp_ads_draft'`)).rows[0].n).toBe(0);
      // The tenant role evaluates the policies, so it may call it (the logins that inherit it can too, as they can every policy helper); PUBLIC may not, and the function reads nothing but the sealed context.
      for (const [rolname, expected] of [['crove_tenant', true], ['public', false]] as const) {
        const ok = (await c.query(`SELECT has_function_privilege($1, 'crove_kernel.ctx_mcp_engage_write()', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute ctx_mcp_engage_write`).toBe(expected);
      }
    });
  });

  it('enters only for a live company grant that holds the scope it names, in a transaction that may write, with no user, at R1, tainted', async () => {
    const live = await grant(orgId, users.owner);
    const c = await asApp();
    try {
      await c.query('BEGIN');
      const got = (await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text) AS got`, [orgId, live, ENGAGE])).rows[0].got;
      expect(got).toEqual({ role: 'owner', grantor: users.owner, maxRisk: 'R1', tainted: true });
      expect((await c.query(`SELECT crove_kernel.ctx_user_id() AS u, crove_kernel.ctx_actor_type() AS t`)).rows[0]).toEqual({ u: null, t: 'agent' });
      // The whole seal, key by key: a key added, dropped or changed is a change to what an engage grant may do.
      expect(JSON.parse((await c.query(`SELECT current_setting('crove.ctx') AS ctx`)).rows[0].ctx as string)).toEqual({
        v: 1, org: orgId, actor: 'agent', user: null, role: 'owner', agent: live, run: null, position: null, module: 'kernel', max_risk: 'R1', tainted: true, le_scope: ['*'], flags: [],
        kind: 'mcp_engage_write', grantor: users.owner,
      });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, live, ADS]);
      expect(JSON.parse((await c.query(`SELECT current_setting('crove.ctx') AS ctx`)).rows[0].ctx as string)).toMatchObject({ module: 'ads', kind: 'mcp_ads_draft', user: null, tainted: true, max_risk: 'R1' });
      await c.query('ROLLBACK');
      await c.query('BEGIN READ ONLY');
      await expect(c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, live, ENGAGE])).rejects.toThrow(/MCP_WRITE_READ_ONLY/);
      await c.query('ROLLBACK');
      const refusal = async (id: string, scope = ENGAGE, org = orgId) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [org, id, scope]);
          return null;
        } catch (error) {
          return (error as Error).message;
        } finally {
          await c.query('ROLLBACK');
        }
      };
      // A scope that is not one of the two (the social draft has its own entry, the read scope no write context), a grant without the scope it names.
      for (const scope of ['ludy.social.draft', 'ludy.read', 'ludy.member.read', 'ludy.write', '']) expect(await refusal(live, scope), scope).toBe('MCP_GRANT_SCOPE');
      expect(await refusal(await grant(orgId, users.owner, ['ludy.read', ADS]), ENGAGE)).toBe('MCP_GRANT_SCOPE');
      expect(await refusal(await grant(orgId, users.owner, ['ludy.read', ENGAGE]), ADS)).toBe('MCP_GRANT_SCOPE');
      const revoked = await grant(orgId, users.owner);
      await q('UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1', [revoked]);
      expect(await refusal(revoked)).toBe('MCP_GRANT_REVOKED');
      expect(await refusal(await grant(orgId, users.owner, ['ludy.read', ENGAGE], '- interval \'40 days\''))).toBe('MCP_GRANT_EXPIRED');
      // A member of the org is not in standing; another org's id and an unknown id find nothing; a member-bound grant is no company grant.
      expect(await refusal(await grant(orgId, users.member))).toBe('MCP_GRANT_INVALID');
      expect(await refusal(live, ENGAGE, otherOrg)).toBe('MCP_GRANT_INVALID');
      expect(await refusal(randomUUID())).toBe('MCP_GRANT_INVALID');
      expect(await refusal(await grant(orgId, users.owner, ['ludy.member.read'], '', 'member'))).toBe('MCP_GRANT_NOT_COMPANY');
    } finally {
      await c.end();
    }
  });

  it('lets the engage context update a thread\'s assignee, status, resolution and contact, and nothing else of it, and read its messages', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt, c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM crove_kernel.conversation_message WHERE conversation_id = $1`, [s.conv])).rows[0].n).toBe(1);
      expect(await attempt(`UPDATE crove_kernel.conversation SET assignee_user_id = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [s.conv, users.admin, orgId])).toBeNull();
      expect(await attempt(`UPDATE crove_kernel.conversation SET status = 'resolved', resolved_at = now(), resolved_by = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [s.conv, users.owner, orgId])).toBeNull();
      expect(await attempt(`UPDATE crove_kernel.conversation SET party_id = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [s.conv, s.party, orgId])).toBeNull();
      for (const [label, set] of [
        ['its channel', `channel_connection_id = '${randomUUID()}'`],
        ['its kind', `kind = 'direct'`],
        ['its sender', `identity_id = NULL`],
        ['its external id', `external_thread_id = 'x'`],
        ['its counter', `last_seq = 9`],
        ['its subject', `subject = 'đổi chủ đề'`],
        ['its reply window', `reply_window_until = now()`],
        ['a status that is not one', `status = 'archived'`],
        ['a resolver that is not the grantor', `resolved_by = '${users.admin}'`],
        ['its sender mark', `sender_unverified = true`],
      ] as const) {
        refused(`a thread with ${label} changed`, await attempt(`UPDATE crove_kernel.conversation SET ${set} WHERE org_id = $2 AND id = $1`, [s.conv, orgId]));
      }
      await kept('a thread deleted', c, attempt, 'crove_kernel.conversation', s.conv as string);
      refused('a thread made', await attempt(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, last_seq) VALUES ($1, $2, $3, 'comment_thread', 'made', 0)`, [orgId, randomUUID(), s.conn]));
      // A message is never written, edited or removed.
      refused('a message made', await attempt(`INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body) VALUES ($1, $2, $3, $4, 'comment_thread', 2, 'out', now(), 'member', 'x')`, [orgId, randomUUID(), s.conv, s.conn]));
      refused('a message edited', await attempt(`UPDATE crove_kernel.conversation_message SET body = 'sửa' WHERE org_id = $2 AND id = $1`, [s.msg, orgId]));
      await kept('a message deleted', c, attempt, 'crove_kernel.conversation_message', s.msg as string);
      // A note, by the grantor, never edited or removed, and not on a thread of another org.
      expect(await attempt(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'Dy ghi')`, [orgId, randomUUID(), s.conv, users.owner])).toBeNull();
      refused('a note by someone else', await attempt(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'giả')`, [orgId, randomUUID(), s.conv, users.admin]));
      refused('a note edited', await attempt(`UPDATE crove_kernel.conversation_note SET body = 'sửa' WHERE org_id = $2 AND id = $1`, [s.note, orgId]));
      await kept('a note deleted', c, attempt, 'crove_kernel.conversation_note', s.note as string);
    });
  });

  it('lets the engage context add a contact that is external, a deal of the grantor and its stage, and nothing else of them', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt, c) => {
      expect(await attempt(`INSERT INTO crove_kernel.party (org_id, id, kind, name, source_trust) VALUES ($1, $2, 'person', 'Dy thêm', 'external')`, [orgId, randomUUID()])).toBeNull();
      for (const trust of ['user', 'system']) refused(`a contact that is ${trust}`, await attempt(`INSERT INTO crove_kernel.party (org_id, id, kind, name, source_trust) VALUES ($1, $2, 'person', 'Giả', $3)`, [orgId, randomUUID(), trust]));
      refused('a contact edited', await attempt(`UPDATE crove_kernel.party SET name = 'đổi tên' WHERE org_id = $2 AND id = $1`, [s.party, orgId]));
      refused('a contact\'s email edited', await attempt(`UPDATE crove_kernel.party SET email = 'doi@example.com' WHERE org_id = $2 AND id = $1`, [s.party, orgId]));
      await kept('a contact deleted', c, attempt, 'crove_kernel.party', s.party as string);
      // A deal by the grantor, then its stage, order and close.
      expect(await attempt(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'Mới', 5, $4, 'b0', $5, $5)`, [orgId, randomUUID(), s.party, s.stageOpen, users.owner])).toBeNull();
      refused('a deal made in another\'s name', await attempt(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'Giả', 5, $4, 'b1', $5, $5)`, [orgId, randomUUID(), s.party, s.stageOpen, users.admin]));
      expect(await attempt(`UPDATE crove_crm.deal SET stage_id = $2, sort_key = 'c0', version = version + 1, updated_by = $3, updated_at = now() WHERE org_id = $4 AND id = $1`, [s.deal, s.stageOpen2, users.owner, orgId])).toBeNull();
      expect(await attempt(`UPDATE crove_crm.deal SET stage_id = $2, closed_at = now(), version = version + 1, updated_by = $3, updated_at = now() WHERE org_id = $4 AND id = $1`, [s.deal, s.stageWon, users.owner, orgId])).toBeNull();
      for (const [label, set] of [
        ['its title', `title = 'đổi'`],
        ['its amount', `amount = 1`],
        ['its customer', `party_id = '${randomUUID()}'`],
        ['its owner', `owner_user_id = '${users.admin}'`],
        ['its expected close', `expected_close = '2030-01-01'`],
        ['its maker', `created_by = '${users.admin}'`],
      ] as const) {
        refused(`a deal with ${label} changed`, await attempt(`UPDATE crove_crm.deal SET ${set}, updated_by = $2 WHERE org_id = $3 AND id = $1`, [s.deal, users.owner, orgId]));
      }
      refused('a deal moved in another\'s name', await attempt(`UPDATE crove_crm.deal SET stage_id = $2, updated_by = $3 WHERE org_id = $4 AND id = $1`, [s.deal, s.stageOpen, users.admin, orgId]));
      await kept('a deal deleted', c, attempt, 'crove_crm.deal', s.deal as string);
      // The default stages of a first use are the one other row of the pipeline; a stage is never changed or removed.
      expect(await attempt(`INSERT INTO crove_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Thua', 'lost', 9)`, [orgId])).toBeNull();
      refused('a stage renamed', await attempt(`UPDATE crove_crm.pipeline_stage SET name = 'đổi' WHERE org_id = $2 AND id = $1`, [s.stageOpen, orgId]));
      await kept('a stage deleted', c, attempt, 'crove_crm.pipeline_stage', s.stageWon as string);
    });
  });

  it('lets the engage context write a draft quote and its lines and mark a next step, and never a sent quote, a number or a step\'s history', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt, c) => {
      const draft = randomUUID();
      expect(await attempt(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, updated_by) VALUES ($1, $2, $3, $4, '2031-02-01', $5, $5)`, [orgId, draft, s.deal, s.party, users.owner])).toBeNull();
      expect(await attempt(`INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, unit, quantity, unit_price, discount_percent, vat_rate, amount, vat_amount) VALUES ($1, $2, 1, 'item', 'Dòng', 'cái', 1, 100, 0, '10', 100, 10)`, [orgId, draft])).toBeNull();
      expect(await attempt(`DELETE FROM crove_crm.quote_line WHERE org_id = $1 AND quote_id = $2`, [orgId, draft])).toBeNull();
      expect(await attempt(`UPDATE crove_crm.quote SET subtotal = 100, total = 110, vat_amount = 10, remarks = 'ghi chú', version = version + 1, updated_by = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [s.quoteDraft, users.owner, orgId])).toBeNull();
      refused('a quote made in another\'s name', await attempt(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, updated_by) VALUES ($1, $2, $3, $4, '2031-02-01', $5, $5)`, [orgId, randomUUID(), s.deal, s.party, users.admin]));
      refused('a numbered quote made', await attempt(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, updated_by, number) VALUES ($1, $2, $3, $4, '2031-02-01', $5, $5, 'BG-1')`, [orgId, randomUUID(), s.deal, s.party, users.owner]));
      refused('a sent quote made', await attempt(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, updated_by, status, sent_at, sent_via, number) VALUES ($1, $2, $3, $4, '2031-02-01', $5, $5, 'sent', now(), 'link', 'BG-2')`, [orgId, randomUUID(), s.deal, s.party, users.owner]));
      refused('a draft quote sent', await attempt(`UPDATE crove_crm.quote SET status = 'sent', sent_at = now(), sent_via = 'link', number = 'BG-3', updated_by = $2 WHERE org_id = $3 AND id = $1`, [s.quoteDraft, users.owner, orgId]));
      refused('a draft quote\'s number', await attempt(`UPDATE crove_crm.quote SET number = 'BG-4', updated_by = $2 WHERE org_id = $3 AND id = $1`, [s.quoteDraft, users.owner, orgId]));
      refused('a draft quote moved to another deal', await attempt(`UPDATE crove_crm.quote SET deal_id = '${randomUUID()}', updated_by = $2 WHERE org_id = $3 AND id = $1`, [s.quoteDraft, users.owner, orgId]));
      refused('a sent quote edited', await attempt(`UPDATE crove_crm.quote SET remarks = 'sửa', updated_by = $2 WHERE org_id = $3 AND id = $1`, [s.quoteSent, users.owner, orgId]));
      await kept('a quote deleted', c, attempt, 'crove_crm.quote', s.quoteDraft as string);
      refused('a line of a sent quote made', await attempt(`INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, unit, quantity, unit_price, discount_percent, vat_rate, amount, vat_amount) VALUES ($1, $2, 1, 'item', 'Dòng', 'cái', 1, 100, 0, '10', 100, 10)`, [orgId, s.quoteSent]));
      refused('a line edited', await attempt(`UPDATE crove_crm.quote_line SET description = 'sửa' WHERE org_id = $1 AND quote_id = $2`, [orgId, s.quoteDraft]));
      // A next step: done in the grantor's own name, or snoozed within 14 days; never raised, reopened, reassigned or made someone else's act.
      refused('a step made', await attempt(`INSERT INTO crove_crm.deal_next_step (org_id, deal_id, reason, since_on) VALUES ($1, $2, 'no_activity', '2026-10-05')`, [orgId, s.deal]));
      refused('a step done in another\'s name', await attempt(`UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now(), resolved_by = $2 WHERE org_id = $3 AND id = $1`, [s.step, users.admin, orgId]));
      refused('a step snoozed a year', await attempt(`UPDATE crove_crm.deal_next_step SET snoozed_until = now() + interval '365 days' WHERE org_id = $2 AND id = $1`, [s.step, orgId]));
      refused('a step reassigned', await attempt(`UPDATE crove_crm.deal_next_step SET assignee_user_id = $2 WHERE org_id = $3 AND id = $1`, [s.step, users.admin, orgId]));
      await kept('a step deleted', c, attempt, 'crove_crm.deal_next_step', s.step as string);
      expect(await attempt(`UPDATE crove_crm.deal_next_step SET snoozed_until = now() + interval '7 days' WHERE org_id = $2 AND id = $1`, [s.step, orgId])).toBeNull();
      expect(await attempt(`UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now(), resolved_by = $2, snoozed_until = NULL WHERE org_id = $3 AND id = $1`, [s.step2, users.owner, orgId])).toBeNull();
    });
  });

  it('lets the ads context save a new AI draft of the grantor and edit one that stays an AI draft, and nothing else', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ADS, async (attempt, c) => {
      expect(await attempt(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by, origin, ai_fields) VALUES ($1, $2, $3, 'AI mới', 'traffic', $4, 'ai', ARRAY['name'])`, [orgId, randomUUID(), s.account, users.owner])).toBeNull();
      refused('a human draft made', await attempt(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Người', 'traffic', $4)`, [orgId, randomUUID(), s.account, users.owner]));
      refused('an AI draft in another\'s name', await attempt(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by, origin) VALUES ($1, $2, $3, 'Giả', 'traffic', $4, 'ai')`, [orgId, randomUUID(), s.account, users.admin]));
      refused('an approved draft made', await attempt(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by, origin, status) VALUES ($1, $2, $3, 'Duyệt', 'traffic', $4, 'ai', 'approved')`, [orgId, randomUUID(), s.account, users.owner]));
      refused('a person\'s draft edited', await attempt(`UPDATE crove_ads.ad_campaign_draft SET name = 'sửa' WHERE org_id = $2 AND id = $1`, [s.humanDraft, orgId]));
      refused('an AI draft turned human', await attempt(`UPDATE crove_ads.ad_campaign_draft SET origin = 'human' WHERE org_id = $2 AND id = $1`, [s.aiDraft, orgId]));
      refused('an AI draft discarded', await attempt(`UPDATE crove_ads.ad_campaign_draft SET status = 'discarded' WHERE org_id = $2 AND id = $1`, [s.aiDraft, orgId]));
      refused('an AI draft approved', await attempt(`UPDATE crove_ads.ad_campaign_draft SET status = 'approved' WHERE org_id = $2 AND id = $1`, [s.aiDraft, orgId]));
      await kept('a draft deleted', c, attempt, 'crove_ads.ad_campaign_draft', s.aiDraft as string);
      // The ads context writes nothing of Hộp thư or the CRM, and the engage context nothing of ads.
      refused('a note from the ads context', await attempt(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'x')`, [orgId, randomUUID(), s.conv, users.owner]));
      refused('a deal from the ads context', await attempt(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'x', 5, $4, 'z', $5, $5)`, [orgId, randomUUID(), s.party, s.stageOpen, users.owner]));
    });
    await inWrite(await grant(orgId, users.owner), ENGAGE, async (attempt) => {
      refused('an ads draft from the engage context', await attempt(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by, origin) VALUES ($1, $2, $3, 'x', 'traffic', $4, 'ai')`, [orgId, randomUUID(), s.account, users.owner]));
    });
  });

  it('refuses both contexts every other table, whatever the statement: no event, no key, no grant, no member, no file, no money', async () => {
    const revokedBefore = (await q(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1 AND revoked_at IS NOT NULL`, [orgId])).rows[0].n as number;
    const tables = (await q<{ t: string }>(
      `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname LIKE 'crove\\_%' AND n.nspname NOT IN ('crove_meta', 'crove_jobs') AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    )).rows.map((r) => r.t);
    expect(tables.length).toBeGreaterThan(100);
    for (const [kind, scope, allowed] of [['engage', ENGAGE, ENGAGE_TABLES], ['ads', ADS, ADS_TABLES]] as const) {
      const g = await grant(orgId, users.owner);
      await inWrite(g, scope, async (attempt, c) => {
        const other = tables.filter((t) => !allowed.includes(t) && !['crove_kernel.activity', 'crove_kernel.task', 'crove_kernel.task_comment', 'crove_kernel.ai_run', 'crove_kernel.outbox_event', 'crove_kernel.refusal_tally'].includes(t));
        for (const t of other) {
          const result = await attempt(`INSERT INTO ${t} DEFAULT VALUES`);
          expect(result, `${kind}: insert into ${t}`).not.toBeNull();
        }
        // A delete that reaches no row is not a write; one that reaches a row must not succeed (counted, in a savepoint that is rolled back).
        for (const t of other) {
          const before = await countOf(c, t);
          const result = await attempt(`DELETE FROM ${t}`);
          if (result === null && before > 0) {
            const left = await countOf(c, t);
            expect(left, `${kind}: delete from ${t} removed rows`).toBe(before);
          } else if (result !== null) {
            refused(`${kind}: delete from ${t}`, result);
          }
        }
        // The tables the guard exempts (they carry an agent rule of their own: a lease on a run, which a sealed MCP context never has) take no row from it either.
        for (const t of ['crove_kernel.task', 'crove_kernel.task_comment', 'crove_kernel.ai_run', 'crove_kernel.outbox_event', 'crove_kernel.refusal_tally']) {
          expect(await attempt(`INSERT INTO ${t} DEFAULT VALUES`), `${kind}: insert into ${t}`).not.toBeNull();
        }
        // The rows the engage context writes are still there after the refused deletes (they ran in savepoints; the check is that none of them removed what it should not).
        expect(await attempt(`SELECT crove_kernel.emit('kernel.test.event', '{}'::jsonb, NULL)`)).not.toBeNull();
      });
    }
    // Nothing that was refused changed a row of the people and the keys the contexts must not reach.
    expect((await q(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1 AND revoked_at IS NOT NULL`, [orgId])).rows[0].n).toBe(revokedBefore);
    expect((await q(`SELECT count(*)::int AS n FROM crove_kernel.tenant_member WHERE org_id = $1`, [orgId])).rows[0].n).toBe(3);
  });

  it('writes the timeline row of a call as the grantor and no agent, and leaves a person\'s and an org-chart agent\'s as they were', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt, c) => {
      expect(await attempt(`INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, agent_id) VALUES ($1, 'kernel.party', $2, 'party.created', 'Thêm liên hệ', $3, NULL)`, [orgId, s.party, users.admin])).toBeNull();
      const row = (await c.query(`SELECT actor_id, agent_id FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 ORDER BY occurred_at DESC LIMIT 1`, [orgId, s.party])).rows[0];
      // Whatever the row claimed, the database stamped the grantor's id and no agent (the claim of another actor was replaced).
      expect(row).toEqual({ actor_id: users.owner, agent_id: null });
    });
  });

  it('leaves the read context of a company grant as it was: it writes its audit row and nothing else', async () => {
    const g = await grant(orgId, users.owner, ['ludy.read', ENGAGE]);
    const c = await asApp();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid)`, [orgId, g]);
      await c.query('SAVEPOINT a');
      // The row is out of its reach for an update (no row matches) or the update is refused: either way nothing changes.
      const updated = await c.query(`UPDATE crove_kernel.conversation SET status = 'resolved' WHERE org_id = $1 AND id = $2`, [orgId, s.conv]).then((r) => r.rowCount, () => 0);
      expect(updated).toBe(0);
      await c.query('ROLLBACK TO SAVEPOINT a');
      await c.query('SAVEPOINT b');
      await expect(c.query(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'x')`, [orgId, randomUUID(), s.conv, users.owner])).rejects.toThrow(/AGENT_FORBIDDEN|read-only|permission denied|row-level/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });
});
