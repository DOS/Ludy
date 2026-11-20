// SPDX-License-Identifier: AGPL-3.0-only
// The origin and taint marks the database stamps on what a connected coworker writes (#4149; ADR-0051 decision 8; found in the security review of #3861): in the sealed engage write context a note, a deal, a quote and its
// lines and a timeline row are marked `actor_origin = 'mcp'` (and `tainted` where the row holds text); the same rows written in any other context are unmarked whatever the statement names; an update never changes where a row
// came from and never lowers the taint, and raises it only when the coworker writes text (a deal's title or a new lost reason, any change of a draft quote); a revision keeps the mark of the quote it copies; the tenant role may not
// update a mark where its grants are by column and a trigger decides where they are not; the checks exist and are validated; the stamp functions are no PUBLIC's to call.
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
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';

suite('the origin and taint marks of the sealed write contexts (#4149)', () => {
  const dbName = `crove_test_mcp_origin_marks_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let orgId = '';
  const pools: pg.Pool[] = [];
  const users = { owner: '', admin: '', member: '', other: '' };
  const s: Record<string, string> = {};
  let runtime: Runtime;

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
  async function inWrite<T>(grantId: string, scope: string, fn: (attempt: (sql: string, params?: unknown[]) => Promise<string | null>, c: pg.Client) => Promise<T>, commit = false): Promise<T> {
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
      const result = await fn(attempt, c);
      // The marks are read afterwards by the superuser, so a test that needs the rows keeps them (the other tests roll back).
      if (commit) await c.query('COMMIT');
      return result;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-origin-marks', subject: key, email: `${key}@mcp-origin-marks.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Org A')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, users.admin, users.member]);
    // The rows the contexts act on, written by the superuser.
    const id = () => randomUUID();
    Object.assign(s, { conv2: id(), deal2: id(), conn: id(), ident: id(), conv: id(), msg: id(), note: id(), party: id(), stageOpen: id(), stageOpen2: id(), stageWon: id(), deal: id(), quoteDraft: id(), quoteSent: id(), step: id(), step2: id(), account: id(), connAds: id(), aiDraft: id(), humanDraft: id() });
    await q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', 'ext-1', 'Trang', $3), ($1, $4, 'sandbox_ads', 'act-1', 'QC', $3)`, [orgId, s.conn, users.owner, s.connAds]);
    await q(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', 'u-1-12345678', 'Khách')`, [orgId, s.ident]);
    await q(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at) VALUES ($1, $2, $3, 'comment_thread', 't-1', $4, 1, now(), now())`, [orgId, s.conv, s.conn, s.ident]);
    await q(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at, status, resolved_at, resolved_by) VALUES ($1, $2, $3, 'comment_thread', 't-2', $4, 1, now(), now(), 'resolved', now(), $5)`, [orgId, s.conv2, s.conn, s.ident, users.admin]);
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

  const mark = async (table: string, id: string) => (await q<{ actor_origin: string; tainted?: boolean }>(`SELECT actor_origin${table === 'crove_kernel.activity' ? '' : ', tainted'} FROM ${table} WHERE id = $1`, [id])).rows[0];

  it('stamps what the engage context writes as the coworker\'s and tainted, and a timeline row as its origin', async () => {
    const g = await grant(orgId, users.owner);
    const made = { note: randomUUID(), deal: randomUUID(), quote: randomUUID(), activity: randomUUID() };
    await inWrite(g, ENGAGE, async (attempt) => {
      expect(await attempt(`INSERT INTO crove_kernel.conversation_note (org_id, id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4, 'Dy ghi')`, [orgId, made.note, s.conv, users.owner])).toBeNull();
      expect(await attempt(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by) VALUES ($1, $2, $3, 'Dy tạo', 5, $4, 'm0', $5, $5)`, [orgId, made.deal, s.party, s.stageOpen, users.owner])).toBeNull();
      expect(await attempt(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, updated_by) VALUES ($1, $2, $3, $4, '2031-02-01', $5, $5)`, [orgId, made.quote, s.deal, s.party, users.owner])).toBeNull();
      expect(await attempt(`INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, unit, quantity, unit_price, discount_percent, vat_rate, amount, vat_amount) VALUES ($1, $2, 1, 'item', 'Dòng', 'cái', 1, 100, 0, '10', 100, 10)`, [orgId, made.quote])).toBeNull();
      expect(await attempt(`INSERT INTO crove_kernel.activity (id, org_id, record_type, record_id, kind, summary, actor_id) VALUES ($1, $2, 'kernel.party', $3, 'party.created', 'Thêm liên hệ', $4)`, [made.activity, orgId, s.party, users.admin])).toBeNull();
    }, true);
    for (const [table, id] of [['crove_kernel.conversation_note', made.note], ['crove_crm.deal', made.deal], ['crove_crm.quote', made.quote]] as const) expect(await mark(table, id), table).toEqual({ actor_origin: 'mcp', tainted: true });
    expect(await mark('crove_kernel.activity', made.activity)).toEqual({ actor_origin: 'mcp' });
    expect((await q(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1`, [made.quote])).rows[0]).toEqual({ actor_origin: 'mcp', tainted: true });
  });

  it('raises the taint of a person\'s deal and quote only when the coworker writes text, and never lowers it or changes where a row came from', async () => {
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt) => {
      // A move of stage and order writes no text.
      expect(await attempt(`UPDATE crove_crm.deal SET stage_id = $2, sort_key = 'n0', version = version + 1, updated_by = $3, updated_at = now() WHERE org_id = $4 AND id = $1`, [s.deal, s.stageOpen2, users.owner, orgId])).toBeNull();
    }, true);
    expect(await mark('crove_crm.deal', s.deal as string)).toEqual({ actor_origin: 'ui', tainted: false });
    await inWrite(g, ENGAGE, async (attempt) => {
      // A lost reason is text; closing the deal with one taints it, and the origin stays a person's.
      expect(await attempt(`UPDATE crove_crm.deal SET stage_id = $2, closed_at = now(), lost_reason = 'Dy ghi lý do', version = version + 1, updated_by = $3, updated_at = now() WHERE org_id = $4 AND id = $1`, [s.deal, s.stageWon, users.owner, orgId])).toBeNull();
    }, true);
    expect(await mark('crove_crm.deal', s.deal as string)).toEqual({ actor_origin: 'ui', tainted: true });
    // A draft quote the coworker changes is tainted (every change of a draft is a save of its text, lines or totals), and stays a person's.
    expect(await mark('crove_crm.quote', s.quoteDraft as string)).toEqual({ actor_origin: 'ui', tainted: false });
    await inWrite(g, ENGAGE, async (attempt) => {
      expect(await attempt(`UPDATE crove_crm.quote SET remarks = 'Dy ghi', version = version + 1, updated_by = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [s.quoteDraft, users.owner, orgId])).toBeNull();
    }, true);
    expect(await mark('crove_crm.quote', s.quoteDraft as string)).toEqual({ actor_origin: 'ui', tainted: true });
    // Never lowered: a person's later rewrite (outside the engage context) leaves the taint and the origin.
    await q(`UPDATE crove_crm.quote SET remarks = 'người sửa', tainted = false, actor_origin = 'ui' WHERE id = $1`, [s.quoteDraft]);
    expect(await mark('crove_crm.quote', s.quoteDraft as string)).toEqual({ actor_origin: 'ui', tainted: true });
    // A person's revision of a tainted quote keeps the mark of the text it copies (and is the person's own row).
    const revision = randomUUID();
    await q(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by, revises_id, revision) VALUES ($1, $2, $3, $4, '2031-03-01', $5, $6, 2)`, [orgId, revision, s.deal, s.party, users.owner, s.quoteDraft]);
    expect(await mark('crove_crm.quote', revision)).toEqual({ actor_origin: 'ui', tainted: true });
    const clean = randomUUID();
    await q(`INSERT INTO crove_crm.quote (org_id, id, deal_id, party_id, valid_until, created_by) VALUES ($1, $2, $3, $4, '2031-03-01', $5)`, [orgId, clean, s.deal, s.party, users.owner]);
    expect(await mark('crove_crm.quote', clean)).toEqual({ actor_origin: 'ui', tainted: false });
  });

  it('clears a lost reason without tainting, and a person\'s own notes, deals and timeline rows are unmarked whatever the statement names', async () => {
    // A deal whose lost reason a person wrote, moved back to an open stage by the coworker: the reason is cleared, no text is written.
    const deal = randomUUID();
    await q(`INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by, lost_reason, closed_at) VALUES ($1, $2, $3, 'Thua', 5, $4, 'p0', $5, $5, 'Người ghi', now())`, [orgId, deal, s.party, s.stageOpen, users.owner]).catch(() => undefined);
    const g = await grant(orgId, users.owner);
    await inWrite(g, ENGAGE, async (attempt) => {
      expect(await attempt(`UPDATE crove_crm.deal SET lost_reason = NULL, closed_at = NULL, version = version + 1, updated_by = $2, updated_at = now() WHERE org_id = $3 AND id = $1`, [deal, users.owner, orgId])).toBeNull();
    }, true);
    expect(await mark('crove_crm.deal', deal)).toEqual({ actor_origin: 'ui', tainted: false });
    // Outside the engage context a statement that names the marks is overridden, on insert and on update.
    const note = await q<{ id: string }>(`INSERT INTO crove_kernel.conversation_note (org_id, conversation_id, author_user_id, body, actor_origin, tainted) VALUES ($1, $2, $3, 'giả', 'mcp', true) RETURNING id`, [orgId, s.conv, users.owner]);
    expect(await mark('crove_kernel.conversation_note', note.rows[0]?.id as string)).toEqual({ actor_origin: 'ui', tainted: false });
    const act = await q<{ id: string }>(`INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, actor_origin) VALUES ($1, 'kernel.party', $2, 'party.updated', 'Sửa', $3, 'mcp') RETURNING id`, [orgId, s.party, users.owner]);
    expect(await mark('crove_kernel.activity', act.rows[0]?.id as string)).toEqual({ actor_origin: 'ui' });
    await q(`UPDATE crove_crm.deal SET actor_origin = 'mcp', tainted = true WHERE id = $1`, [deal]);
    expect(await mark('crove_crm.deal', deal)).toEqual({ actor_origin: 'ui', tainted: false });
    // A person's line stays a person's under a forged update (the lines have a table-level UPDATE grant, so a trigger decides), and the coworker's line stays the coworker's.
    await q(`INSERT INTO crove_crm.quote_line (org_id, quote_id, line_no, kind, description, unit, quantity, unit_price, discount_percent, vat_rate, amount, vat_amount) VALUES ($1, $2, 7, 'item', 'Dòng người', 'cái', 1, 100, 0, '10', 100, 10)`, [orgId, s.quoteDraft]);
    await q(`UPDATE crove_crm.quote_line SET actor_origin = 'mcp', tainted = true WHERE quote_id = $1 AND line_no = 7`, [s.quoteDraft]);
    expect((await q(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE quote_id = $1 AND line_no = 7`, [s.quoteDraft])).rows[0]).toEqual({ actor_origin: 'ui', tainted: false });
    await q(`UPDATE crove_crm.quote_line SET actor_origin = 'ui', tainted = false WHERE org_id = $1 AND description = 'Dòng'`, [orgId]);
    expect((await q(`SELECT actor_origin, tainted FROM crove_crm.quote_line WHERE org_id = $1 AND description = 'Dòng'`, [orgId])).rows[0]).toEqual({ actor_origin: 'mcp', tainted: true });
  });

  it('is no tenant\'s to update where the grants are by column, has its checks validated, and its stamp functions are no PUBLIC\'s to call', async () => {
    for (const t of ['crove_kernel.conversation_note', 'crove_crm.deal', 'crove_crm.quote', 'crove_kernel.activity']) {
      for (const column of t === 'crove_kernel.activity' ? ['actor_origin'] : ['actor_origin', 'tainted']) {
        const granted = await q<{ ok: boolean }>(`SELECT has_column_privilege('crove_tenant', $1::regclass, $2, 'UPDATE') AS ok`, [t, column]);
        expect(granted.rows[0]?.ok, `${t}.${column} UPDATE`).toBe(false);
      }
    }
    const checks = (await q<{ t: string; valid: boolean; def: string }>(`SELECT conrelid::regclass::text AS t, convalidated AS valid, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'mcp_origin_ck' ORDER BY 1`)).rows;
    expect(checks.map((c) => c.t)).toEqual(['crove_crm.deal', 'crove_crm.quote', 'crove_crm.quote_line', 'crove_kernel.activity', 'crove_kernel.conversation_note']);
    for (const c of checks) {
      expect(c.valid, c.t).toBe(true);
      expect(c.def, c.t).toContain("'mcp'");
      if (c.t !== 'crove_kernel.activity') expect(c.def, c.t).toContain('tainted');
    }
    for (const fn of ['crove_kernel.mcp_origin_stamp_insert()', 'crove_kernel.mcp_origin_stamp_update()']) {
      expect((await q<{ ok: boolean }>(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [fn])).rows[0]?.ok, fn).toBe(false);
      expect((await q<{ cfg: string[] | null }>(`SELECT proconfig AS cfg FROM pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0]?.cfg, fn).toEqual(['search_path=pg_catalog, pg_temp']);
    }
    // The stamps fire after the write guard (alphabetical), so the guard judges the statement the command wrote, not the mark.
    const names = (await q<{ t: string; n: string }>(`SELECT tgrelid::regclass::text AS t, tgname AS n FROM pg_trigger WHERE tgname IN ('agent_write_guard', 'mcp_origin_stamp', 'mcp_origin_stamp_update') AND tgrelid = 'crove_crm.deal'::regclass ORDER BY tgname`)).rows.map((r) => r.n);
    expect(names).toEqual(['agent_write_guard', 'mcp_origin_stamp', 'mcp_origin_stamp_update']);
  });
});
