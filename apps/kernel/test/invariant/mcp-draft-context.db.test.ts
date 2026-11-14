// SPDX-License-Identifier: AGPL-3.0-only
// The write context of the one MCP write command (#3227, step 3; owner decision 2026-11-14: one new write scope, `ludy.social.draft`, and exactly one command): what the database lets it do.
// - the entry is the API login's alone, with a pinned search path, refuses a read-only transaction, a grant without the scope, a revoked grant and a member-bound grant, and no other function
//   names its kind of the seal;
// - the scope is a company grant's alone (a CHECK), and an MCP post is an AI post and tainted whatever wrote the row (a CHECK);
// - in the sealed context the write guard lets a draft post by the sealed grantor and its draft channels in, and nothing else: no post that is a person's, approved, assigned, planned for publish,
//   repeated or archived, no channel of another post or past draft, no update, no delete, no other table, no event, no idempotency key;
// - the read context of a company grant is unchanged: it still writes only its audit row.
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
const ENTRY = 'crove_kernel.enter_mcp_company_draft_context(uuid,uuid)';
// A task is guarded by its own agent rule (a lease on a run), which a sealed MCP context never has.
const FORBIDDEN = /AGENT_FORBIDDEN|AGENT_LEASE_REQUIRED|permission denied/;
const HASH = `'sha256:${'a'.repeat(64)}'`;

suite('the write context of the MCP draft command (#3227)', () => {
  const dbName = `crove_test_mcp_draft_context_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let orgId = '';
  let otherOrg = '';
  const pools: pg.Pool[] = [];
  const users = { owner: '', admin: '', member: '', other: '' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const asApp = async () => {
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };

  async function grant(org: string, user: string, scopes: string[] = ['ludy.read', 'ludy.social.draft'], extra = '') {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', $6::text[], $4, now() ${extra}, now() ${extra} + interval '30 days', $3)`,
        [org, id, user, `oauth-${id}`, `client-${id}`, scopes],
      ),
    );
    return id;
  }

  // One transaction of the API login that has entered the write context of a grant; `fn` runs inside it, each statement it tries in a savepoint so a refusal does not end the transaction.
  async function inWrite<T>(grantId: string, fn: (attempt: (sql: string, params?: unknown[]) => Promise<string | null>, c: pg.Client) => Promise<T>): Promise<T> {
    const c = await asApp();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)`, [orgId, grantId]);
      let n = 0;
      const attempt = async (sql: string, params: unknown[] = []) => {
        const sp = `sp_${n++}`;
        await c.query(`SAVEPOINT ${sp}`);
        try {
          await c.query(sql, params);
          await c.query(`RELEASE SAVEPOINT ${sp}`);
          return null;
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
      users[key] = await upsertIdentity(db, { issuer: 'mcp-draft-context', subject: key, email: `${key}@mcp-draft-context.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Org A')).orgId;
    otherOrg = (await createOrg(runtime, { type: 'user', userId: users.other, aal: 'aal1' }, 'Org B')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, users.admin, users.member]));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives the entry to the API login alone, with a pinned search path, and lets only it name the kind of the seal', async () => {
    await admin(async (c) => {
      // Every role that is not a superuser or a built-in one: the `crove_` logins, and any other a platform adds (`authenticated`, `anon`, `service_role`).
      const logins = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper`)).rows as Array<{ rolname: string }>;
      expect(logins.map((r) => r.rolname)).toContain('crove_app');
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, '${ENTRY}', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute the draft entry`).toBe(rolname === 'crove_app');
      }
      expect((await c.query(`SELECT has_function_privilege('public', '${ENTRY}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
      const cfg = (await c.query(`SELECT proconfig FROM pg_proc WHERE oid = '${ENTRY}'::regprocedure`)).rows[0].proconfig as string[] | null;
      expect(cfg).toEqual(['search_path=pg_catalog, pg_temp']);
      const { rows } = await c.query(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~ '''mcp_company_draft'''
         ORDER BY 1`,
      );
      // The entry seals the kind and the guard reads it: no other function names it.
      expect(rows.map((r: { n: string }) => r.n)).toEqual(['crove_kernel.agent_write_guard()', ENTRY]);
    });
  });

  it('enters only for a live company grant that holds the scope, in a transaction that may write, with no user, at R1, tainted', async () => {
    const live = await grant(orgId, users.owner);
    const c = await asApp();
    try {
      await c.query('BEGIN');
      const got = (await c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid) AS got`, [orgId, live])).rows[0].got as { role: string; grantor: string; maxRisk: string; tainted: boolean };
      expect(got).toEqual({ role: 'owner', grantor: users.owner, maxRisk: 'R1', tainted: true });
      expect((await c.query(`SELECT crove_kernel.ctx_user_id() AS u, crove_kernel.ctx_actor_type() AS t`)).rows[0]).toEqual({ u: null, t: 'agent' });
      // The whole seal, key by key: a key added, dropped or changed is a change to what a draft grant may do.
      const sealed = JSON.parse((await c.query(`SELECT current_setting('crove.ctx') AS ctx`)).rows[0].ctx as string) as Record<string, unknown>;
      expect(sealed).toEqual({
        v: 1, org: orgId, actor: 'agent', user: null, role: 'owner', agent: live, run: null, position: null, module: 'social', max_risk: 'R1', tainted: true, le_scope: ['*'], flags: [],
        kind: 'mcp_company_draft', grantor: users.owner,
      });
      await c.query('ROLLBACK');
      // The same grant in a read-only transaction: a write context has no use there.
      await c.query('BEGIN READ ONLY');
      await expect(c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)`, [orgId, live])).rejects.toThrow(/MCP_WRITE_READ_ONLY/);
      await c.query('ROLLBACK');
      const refused = async (id: string, org = orgId) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)`, [org, id]);
          return null;
        } catch (error) {
          return (error as Error).message;
        } finally {
          await c.query('ROLLBACK');
        }
      };
      expect(await refused(await grant(orgId, users.owner, ['ludy.read']))).toBe('MCP_GRANT_SCOPE');
      const revoked = await grant(orgId, users.owner);
      await admin((a) => a.query('UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1', [revoked]));
      expect(await refused(revoked)).toBe('MCP_GRANT_REVOKED');
      expect(await refused(await grant(orgId, users.owner, ['ludy.read', 'ludy.social.draft'], '- interval \'40 days\''))).toBe('MCP_GRANT_EXPIRED');
      // A member of the org (not an owner or an admin) is not in standing, and another org's id finds nothing.
      expect(await refused(await grant(orgId, users.member))).toBe('MCP_GRANT_INVALID');
      expect(await refused(live, otherOrg)).toBe('MCP_GRANT_INVALID');
      expect(await refused(randomUUID())).toBe('MCP_GRANT_INVALID');
    } finally {
      await c.end();
    }
  });

  it('keeps the scope a company grant\'s alone and an MCP post an AI post and tainted, whoever writes the row', async () => {
    await admin(async (c) => {
      await expect(
        c.query(
          `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
           VALUES ($1, $2, $3, 'cm', 'M', 'm.example.com', ARRAY['ludy.read', 'ludy.social.draft'], 'oauth-m', now(), now() + interval '30 days', $3, 'member', $3)`,
          [orgId, randomUUID(), users.owner],
        ),
      ).rejects.toThrow(/agent_grant_scopes_ck/);
      await expect(
        c.query(`INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
                 VALUES ($1, $2, $3, 'cx', 'X', 'x.example.com', ARRAY['ludy.write'], 'oauth-x', now(), now() + interval '30 days', $3)`, [orgId, randomUUID(), users.owner]),
      ).rejects.toThrow(/agent_grant_scopes_ck/);
      for (const [origin, tainted] of [
        ['human', true],
        ['ai', false],
      ] as const) {
        await expect(
          c.query(`INSERT INTO crove_social.post (org_id, body, origin, actor_origin, tainted, author_user_id) VALUES ($1, 'x', $2, 'mcp', $3, $4)`, [orgId, origin, tainted, users.owner]),
        ).rejects.toThrow(/post_mcp_ai_tainted_ck/);
      }
      await expect(c.query(`INSERT INTO crove_social.post (org_id, body, origin, actor_origin, tainted, author_user_id) VALUES ($1, 'x', 'ai', 'mcp', true, $2)`, [orgId, users.owner])).resolves.toBeDefined();
    });
  });

  it('lets the sealed write context insert a draft post of the grantor and its draft channels, and nothing else', async () => {
    const g = await grant(orgId, users.owner);
    const conn = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-draft-ctx', 'Kênh', $3)`, [orgId, conn, users.owner]));
    await inWrite(g, async (attempt, c) => {
      const post = (origin: string, actor: string, tainted: boolean, status: string, extra = '', author = users.owner) =>
        attempt(`INSERT INTO crove_social.post (org_id, id, body, origin, actor_origin, tainted, author_user_id, status${extra ? `, ${extra.split('=')[0]}` : ''}) VALUES ($1, $2, 'x', $3, $4, $5, $6, $7${extra ? `, ${extra.split('=')[1]}` : ''})`, [orgId, randomUUID(), origin, actor, tainted, author, status]);
      // The draft the command makes.
      const id = randomUUID();
      expect(await attempt(`INSERT INTO crove_social.post (org_id, id, body, origin, actor_origin, tainted, author_user_id) VALUES ($1, $2, 'x', 'ai', 'mcp', true, $3)`, [orgId, id, users.owner])).toBeNull();
      expect(await attempt(`INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, content_hash) VALUES ($1, $2, $3, 'sandbox', 0, ${HASH})`, [orgId, id, conn])).toBeNull();
      // A channel may carry the channel's signature in its settings (a channel with a default signature copies it in), and nothing else there.
      const conn3 = randomUUID();
      await admin((a) => a.query(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-draft-ctx-3', 'Kênh 3', $3)`, [orgId, conn3, users.owner]));
      expect(await attempt(`INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, settings, content_hash) VALUES ($1, $2, $3, 'sandbox', 2, '{"signature":"Hotline 0900"}'::jsonb, ${HASH})`, [orgId, id, conn3])).toBeNull();
      // Not a person's, not approved, not planned, not assigned, not repeated, not archived, not another's author.
      for (const [label, result] of [
        ['a person\'s post', await post('human', 'ui', false, 'draft')],
        ['a post by the app', await post('ai', 'ui', true, 'draft')],
        ['an untainted AI post', await post('ai', 'mcp', false, 'draft').then((m) => m)],
        ['an approved post', await post('ai', 'mcp', true, 'approved')],
        ['a scheduled post', await post('ai', 'mcp', true, 'scheduled')],
        ['another author', await post('ai', 'mcp', true, 'draft', '', users.admin)],
        ['an assigned post', await post('ai', 'mcp', true, 'draft', `assignee_user_id='${users.admin}'`)],
        ['an archived post', await post('ai', 'mcp', true, 'draft', 'archived_at=now()')],
        ['an evergreen post', await post('ai', 'mcp', true, 'draft', 'evergreen_days=30')],
        ['a post due at a time', await post('ai', 'mcp', true, 'draft', 'due_at=now()')],
        ['a repost', await post('ai', 'mcp', true, 'draft', `repost_of='${id}'`)],
        ['a recurring post', await post('ai', 'mcp', true, 'draft', `recurrence='{"every":"week"}'::jsonb`)],
        ['a copy of a recurring post', await post('ai', 'mcp', true, 'draft', `recurrence_source_id='${id}'`)],
        ['a post archived by a person', await post('ai', 'mcp', true, 'draft', `archived_by='${users.owner}'`)],
        ['a later revision', await post('ai', 'mcp', true, 'draft', 'revision=2')],
        ['a post that already recurred', await post('ai', 'mcp', true, 'draft', 'recurrence_count=3')],
        ['a post with a next recurrence', await post('ai', 'mcp', true, 'draft', 'recurrence_next_at=now()')],
        ['a post with a last recurrence', await post('ai', 'mcp', true, 'draft', 'recurrence_last_at=now()')],
        ['a post with text variations', await post('ai', 'mcp', true, 'draft', `text_variations='["v"]'::jsonb`)],
        ['a post with a variation counter', await post('ai', 'mcp', true, 'draft', 'text_variation_next=2')],
      ] as const) {
        expect(result, label).toMatch(/AGENT_FORBIDDEN|post_mcp_ai_tainted_ck/);
      }
      // A channel only as a plain draft of such a post: another status, a time, a publish, another post.
      const otherPost = randomUUID();
      await admin((a) => a.query(`INSERT INTO crove_social.post (org_id, id, body, origin, actor_origin, tainted, author_user_id) VALUES ($1, $2, 'p', 'human', 'ui', false, $3)`, [orgId, otherPost, users.owner]));
      const conn2 = randomUUID();
      await admin((a) => a.query(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', 'acct-draft-ctx-2', 'Kênh 2', $3)`, [orgId, conn2, users.owner]));
      for (const [label, sql, args] of [
        ['an approved channel', `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, status, content_hash) VALUES ($1, $2, $3, 'sandbox', 1, 'approved', ${HASH})`, [orgId, id, conn2]],
        ['a timed channel', `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, scheduled_at, content_hash) VALUES ($1, $2, $3, 'sandbox', 1, now(), ${HASH})`, [orgId, id, conn2]],
        ['a published channel', `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, published_at, content_hash) VALUES ($1, $2, $3, 'sandbox', 1, now(), ${HASH})`, [orgId, id, conn2]],
        ['a channel of a person\'s post', `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, content_hash) VALUES ($1, $2, $3, 'sandbox', 1, ${HASH})`, [orgId, otherPost, conn2]],
        ...(
          [
            ['revision', 'revision', '2'],
            ['a queue slot', 'queue_slot_at', 'now()'],
            ['a review time', 'review_since', 'now()'],
            ['a platform id', 'external_post_id', "'p1'"],
            ['a public link', 'external_url', "'https://example.com/p'"],
            ['a takedown', 'removed_at', 'now()'],
            ['an attempt count', 'attempt', '3'],
            ['an error code', 'error_code', "'E'"],
            ['an error message', 'error_message', "'m'"],
            ['a retry time', 'error_retry_at', 'now()'],
            ['a check time', 'next_check_at', 'now()'],
            ['a paused connection', 'paused_connection_version', 'now()'],
            ['a frozen text', 'content_frozen', 'true'],
            ['a removal request', 'remove_requested_at', 'now()'],
            ['an edit text', 'edit_body', "'e'"],
            ['an edit request time', 'edit_requested_at', 'now()'],
            ['an edit requester', 'edit_requested_by', `'${users.owner}'`],
            ['a published revision', 'published_revision', '1'],
            ['media of its own', 'media', "'[]'::jsonb"],
            ['a link of its own', 'link_url', "'https://example.com/x'"],
            ['settings with a first comment', 'settings', `'{"firstComment":"x"}'::jsonb`],
            ['settings with a removal time', 'settings', `'{"signature":"s","removeAt":"2030-01-01T00:00:00Z"}'::jsonb`],
            ['a signature that is not text', 'settings', `'{"signature":{"a":1}}'::jsonb`],
          ] as const
        ).map(([label, column, value]) => [`a channel with ${label}`, `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, position, ${column}, content_hash) VALUES ($1, $2, $3, 'sandbox', 1, ${value}, ${HASH})`, [orgId, id, conn2]] as const),
      ] as const) {
        expect(await attempt(sql, [...args]), label).toMatch(FORBIDDEN);
      }
      // No update and no delete of anything, its own post included, and no other table.
      expect(await attempt(`UPDATE crove_social.post SET body = 'y' WHERE org_id = $1 AND id = $2`, [orgId, id])).toMatch(FORBIDDEN);
      expect(await attempt(`UPDATE crove_social.post SET status = 'approved' WHERE org_id = $1 AND id = $2`, [orgId, id])).toMatch(FORBIDDEN);
      expect(await attempt(`UPDATE crove_social.post_variant SET status = 'approved' WHERE org_id = $1 AND post_id = $2`, [orgId, id])).toMatch(FORBIDDEN);
      expect(await attempt(`DELETE FROM crove_social.post WHERE org_id = $1 AND id = $2`, [orgId, id])).toMatch(FORBIDDEN);
      expect(await attempt(`DELETE FROM crove_social.post_variant WHERE org_id = $1 AND post_id = $2`, [orgId, id])).toMatch(FORBIDDEN);
      for (const [label, sql] of [
        ['an approval', `INSERT INTO crove_social.post_approval (org_id, variant_id, revision, content_hash, decision, decided_by, actor_origin, snapshot) VALUES ('${orgId}', gen_random_uuid(), 1, 'h', 'approved', '${users.owner}', 'mcp', '{}')`],
        ['a task', `INSERT INTO crove_kernel.task (org_id, title) VALUES ('${orgId}', 't')`],
        ['a pending event (refused by the guard or by the login\'s missing privilege)', `INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES ('${orgId}', gen_random_uuid())`],
        ['an idempotency key', `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response) VALUES ('${orgId}', 'user:${users.owner}', 'k', 'c', 'h', NULL)`],
        ['a member', `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ('${orgId}', '${users.other}', 'owner')`],
        ['a grant', `UPDATE crove_kernel.agent_grant SET scopes = ARRAY['ludy.read'] WHERE org_id = '${orgId}'`],
      ] as const) {
        expect(await attempt(sql), label).toMatch(FORBIDDEN);
      }
      // It emits no event: the emit definer needs a run it has not.
      expect(await attempt(`SELECT crove_kernel.emit('social.post.created', '{}'::jsonb, NULL)`)).toMatch(/outbox_event_actor|AGENT_FORBIDDEN|AGENT_LEASE_REQUIRED/);
      await c.query('SELECT 1');
    });
  });

  it('leaves the read context of a company grant as it was: it writes its audit row and nothing else', async () => {
    const g = await grant(orgId, users.owner, ['ludy.read']);
    const c = await asApp();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid)`, [orgId, g]);
      await expect(c.query(`INSERT INTO crove_social.post (org_id, body, origin, actor_origin, tainted, author_user_id) VALUES ($1, 'x', 'ai', 'mcp', true, $2)`, [orgId, users.owner])).rejects.toThrow(FORBIDDEN);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('takes the member row lock before the grant row lock, the order a demotion takes them', async () => {
    const def = (await admin((c) => c.query(`SELECT pg_get_functiondef('${ENTRY}'::regprocedure) AS def`))).rows[0].def as string;
    const member = def.search(/FROM crove_kernel\.tenant_member m WHERE [^;]*FOR SHARE;/);
    const grantRow = def.search(/FROM crove_kernel\.agent_grant g WHERE [^;]*FOR SHARE OF g;/);
    expect(member, 'the member row lock').toBeGreaterThan(-1);
    expect(grantRow, 'the grant row lock').toBeGreaterThan(-1);
    expect(member, 'the member row is locked first').toBeLessThan(grantRow);
  });

  it('does not deadlock when a draft enters while a demotion of its grantor commits: it waits, then is refused', async () => {
    const g = await grant(orgId, users.admin);
    const demote = new pg.Client({ connectionString: adminUrl });
    await demote.connect();
    const c = await asApp();
    try {
      await demote.query('BEGIN');
      // The demotion holds the member row and, through its trigger, revokes the person's grants: the order the entry's locks follow.
      await demote.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
      await c.query('BEGIN');
      const entering = c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)`, [orgId, g]).then(
        () => 'entered',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await demote.query('COMMIT');
      const outcome = await entering;
      expect(outcome).not.toMatch(/deadlock/);
      expect(outcome).toMatch(/MCP_GRANT_(REVOKED|INVALID)/);
    } finally {
      await demote.query('ROLLBACK').catch(() => {});
      await demote.end();
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });
});
