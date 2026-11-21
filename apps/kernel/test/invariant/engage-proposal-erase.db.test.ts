// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite: what erasing a thread does to the proposals an AI coworker made about it (#4234 item 3 and item 1, from the independent review of #4233; #4159, #4160, #4168). The erase guarantees of
// crove_kernel.engage_proposal_erase_gone() live here, in the suite CI runs from the base branch, and not only in apps/kernel/test/engage-proposal-erase-gone.db.test.ts:
//   - it takes no ids (a caller cannot name what to blank), and the old id-taking function is a stub that refuses;
//   - a live thread is out of its reach: a proposal whose conversation and message both exist is never touched, whoever calls it;
//   - one audit row per proposal blanked, with the proposal's id and its state before and nothing of its content; a second run writes nothing;
//   - only an owner, an admin or the system may call it: a member, a viewer and an MCP grant (an agent actor) are refused;
//   - a Meta data deletion request whose erasure failed (a process of the previous release hits the refusing stub during a rolling deploy) stays open and is claimed again every five minutes with no attempt limit, so it
//     outlasts any deploy and is never dropped (#4234 item 4);
//   - a pending proposal it rejects names no person as its decider (an orphan may never have had a thread: nobody decided it), and the audit row names who ran the erasure.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, defineCommand, type Actor, type UserActor } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TWINS = ['kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved'] as const;

// Test-only commands: the definer as a command runs it. Every role reaches the command so the refusal is the definer's own (42501, mapped to 403); the system one is the retention purge's context.
const asPeople = defineCommand({
  name: 'kernel.erase_invariant_test.person',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx) => {
    const { sql } = await import('kysely');
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.engage_proposal_erase_gone() AS n`.execute(ctx.trx);
    return { n: rows[0]?.n ?? 0 };
  },
});
const asSystem = defineCommand({
  name: 'kernel.erase_invariant_test.system',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx) => {
    const { sql } = await import('kysely');
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.engage_proposal_erase_gone() AS n`.execute(ctx.trx);
    return { n: rows[0]?.n ?? 0 };
  },
});

suite('the erasure of an AI coworker\'s proposals keeps its guarantees (#4234)', () => {
  const dbName = `crove_test_engage_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let orgId = '';
  const pools: pg.Pool[] = [];
  const users = { owner: '', admin: '', member: '', viewer: '' };
  let app: Runtime;
  let worker: Runtime;
  let connId = '';
  let identId = '';

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
  const person = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const SYSTEM: Actor = { type: 'system', component: 'erase-invariant-test' };

  // A thread with one message, written by the superuser; deleting it later (a purge) is the superuser's DELETE, as the cascade of the real one.
  async function thread() {
    const conv = randomUUID();
    const msg = randomUUID();
    await q(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at) VALUES ($1, $2, $3, 'comment_thread', $4, $5, 1, now(), now())`, [orgId, conv, connId, `t-${conv.slice(0, 8)}`, identId]);
    await q(`INSERT INTO crove_kernel.conversation_message (org_id, id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, body, tainted, author_identity_id) VALUES ($1, $2, $3, $4, 'comment_thread', 1, 'in', now(), 'contact', 'Số của mình là 0912345678', true, $5)`, [orgId, msg, conv, connId, identId]);
    return { conv, msg };
  }
  const drop = (conv: string) => q('DELETE FROM crove_kernel.conversation WHERE org_id = $1 AND id = $2', [orgId, conv]);
  // A twin proposal as the coworker's grant left it: pending with the payload the client sent, or decided with a note a person typed.
  async function proposal(command: (typeof TWINS)[number], payload: Record<string, unknown>, decided: { by: string; note: string } | null = null) {
    const id = randomUUID();
    await q(
      `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, title, payload, eligible_approvers, authors, status, decided_by, decided_at, decision_note)
       VALUES ($1, $2, 'engage.twin', $3, 'Trả lời khách', $4::jsonb, ARRAY[$5]::uuid[], '[]', $6, $7, ${decided ? 'now()' : 'NULL'}, $8)`,
      [orgId, id, command, JSON.stringify(payload), users.owner, decided ? 'rejected' : 'pending', decided?.by ?? null, decided?.note ?? null],
    );
    return id;
  }
  const row = async (id: string) => (await q<{ status: string; payload: unknown; decided_by: string | null; decision_note: string | null }>('SELECT status, payload, decided_by, decision_note FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0];
  const audits = async () => (await q<{ target_id: string; detail: Record<string, unknown>; outcome: string; actor_type: string; actor_id: string | null }>(`SELECT target_id, detail, outcome, actor_type, actor_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.engage.proposal_erased' ORDER BY id`, [orgId])).rows;
  const eraseAs = (user: string) => app.execute<{ n: number }>('kernel.erase_invariant_test.person', {}, { actor: person(user), orgId });

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      return createDb(pool);
    };
    const registered = { commands: [...kernelCommands, asPeople, asSystem], queries: [...kernelQueries({ inboundDomain: 'in.test' })] };
    const db = login('crove_app', 'test-app-pw');
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(login('crove_worker', 'test-worker-pw'), { manifests: TEST_MANIFESTS }).register(registered);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'engage-erase-invariant', subject: key, email: `${key}@engage-erase-invariant.test`, name: null });
    }
    orgId = (await createOrg(app, person(users.owner), 'Org A')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, users.admin, users.member, users.viewer]);
    connId = randomUUID();
    identId = randomUUID();
    await q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', 'ext-1', 'Trang', $3)`, [orgId, connId, users.owner]);
    await q(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', 'u-1-12345678', 'Khách')`, [orgId, identId]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('takes no ids, is a pinned definer granted to crove_tenant alone, and leaves the old id-taking function a stub that refuses', async () => {
    const fns = (await q<{ args: string; secdef: boolean; config: string[] | null; acl: string | null }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'engage\\_proposal\\_erase%' ORDER BY p.proname`,
    )).rows;
    // Exactly two: the sweep with no arguments, and the old function with ids, which stays as the stub.
    expect(fns.map((f) => f.args).sort()).toEqual(['', 'p_conversations uuid[], p_messages uuid[]']);
    for (const f of fns) {
      expect(f.secdef).toBe(true);
      expect(f.config).toContain('search_path=pg_catalog, pg_temp');
      // No grant to PUBLIC (an ACL entry with an empty grantee), and none to the worker or the definer's own login roles (the app inherits crove_tenant's).
      expect(f.acl ?? '').not.toMatch(/(^|[{,])=/);
      for (const role of ['crove_worker', 'crove_definer_tenant']) expect(f.acl ?? '').not.toContain(`${role}=`);
      expect(f.acl ?? '').toContain('crove_tenant=X');
    }
    // The stub never blanks on the ids a caller passes: it refuses even when called by the superuser.
    await expect(q(`SELECT crove_kernel.engage_proposal_erase(ARRAY[]::uuid[], ARRAY[]::uuid[])`)).rejects.toThrow(/ENGAGE_ERASE_MOVED/);
  });

  it('cannot reach the proposals of a live thread, whoever calls it', async () => {
    const a = await thread();
    const live = await Promise.all([
      proposal(TWINS[0], { conversationId: a.conv, body: 'Dạ đúng 250k ạ', lastSeenSeq: 1 }),
      proposal(TWINS[1], { conversationId: a.conv, messageId: a.msg, body: 'Em nhắn riêng ạ' }),
      // An id written with capitals is the same id: the sweep compares uuids, so a live thread named in capitals is still out of reach.
      proposal(TWINS[2], { conversationId: a.conv.toUpperCase(), messageId: a.msg.toUpperCase() }),
      proposal(TWINS[0], { conversationId: a.conv, body: 'Đã bị từ chối' }, { by: users.owner, note: 'đừng gửi 250k' }),
    ]);
    const before = await Promise.all(live.map(row));
    for (const user of [users.owner, users.admin]) expect((await eraseAs(user)).n).toBe(0);
    expect((await worker.execute<{ n: number }>('kernel.erase_invariant_test.system', {}, { actor: SYSTEM, orgId })).n).toBe(0);
    expect(await Promise.all(live.map(row))).toEqual(before);
    expect(before.map((r) => r?.status)).toEqual(['pending', 'pending', 'pending', 'rejected']);
    // Its message gone while the thread stays: the proposal that names that message is an orphan now (the one that names the live thread alone is not).
    await q('DELETE FROM crove_kernel.conversation_message WHERE org_id = $1 AND id = $2', [orgId, a.msg]);
    expect((await eraseAs(users.owner)).n).toBe(2);
    expect((await row(live[0] as string))?.status).toBe('pending');
    expect((await row(live[1] as string))?.payload).toEqual({ erased: true });
    expect((await row(live[2] as string))?.payload).toEqual({ erased: true });
  });

  it('writes one audit row per proposal it blanks, with its id and the state before and none of the text, and a second run writes nothing', async () => {
    const t = await thread();
    const waiting = await proposal(TWINS[0], { conversationId: t.conv, body: 'Em gọi 0912345678 nhé', lastSeenSeq: 1 });
    const decided = await proposal(TWINS[1], { conversationId: t.conv, messageId: t.msg, body: 'Giao tới 12 Lê Lợi ạ' }, { by: users.admin, note: 'đừng gửi 12 Lê Lợi' });
    const before = (await audits()).length;
    await drop(t.conv);
    expect((await eraseAs(users.owner)).n).toBe(2);
    const rows = (await audits()).slice(before);
    expect(rows.map((r) => r.target_id).sort()).toEqual([waiting, decided].sort());
    expect(rows.every((r) => r.outcome === 'ok' && r.actor_type === 'user' && r.actor_id === users.owner)).toBe(true);
    expect(rows.find((r) => r.target_id === waiting)?.detail).toEqual({ proposalId: waiting, was: 'pending' });
    expect(rows.find((r) => r.target_id === decided)?.detail).toEqual({ proposalId: decided, was: 'rejected' });
    expect(JSON.stringify(rows)).not.toMatch(/0912345678|Lê Lợi/);
    // The payload is blanked, the note a person typed is replaced, and nothing else of a decided row changes: its decider stays as evidence.
    expect(await row(decided)).toEqual({ status: 'rejected', payload: { erased: true }, decided_by: users.admin, decision_note: 'erased' });
    expect(await row(waiting)).toMatchObject({ status: 'rejected', payload: { erased: true }, decision_note: 'conversation erased' });
    expect((await eraseAs(users.admin)).n).toBe(0);
    expect((await audits()).length).toBe(before + 2);
  });

  it('names no person as the decider of a pending proposal it rejects, even one that never had a thread: the audit row names who ran the erasure (#4234 item 1)', async () => {
    const t = await thread();
    const mine = await proposal(TWINS[0], { conversationId: t.conv, body: 'Em chào anh', lastSeenSeq: 1 });
    // An id the org never had: a coworker may name any id, and the next erasure sweeps it. The person who runs that erasure did not delete anything of it.
    const never = await proposal(TWINS[2], { conversationId: randomUUID(), messageId: randomUUID() });
    const before = (await audits()).length;
    await drop(t.conv);
    expect((await eraseAs(users.admin)).n).toBe(2);
    for (const id of [mine, never]) expect(await row(id), id).toMatchObject({ status: 'rejected', decided_by: null, payload: { erased: true } });
    const rows = (await audits()).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.actor_id === users.admin)).toBe(true);
    // The system (the retention purge) names nobody either way.
    const gone = await proposal(TWINS[1], { conversationId: randomUUID(), messageId: randomUUID(), body: 'x' });
    expect((await worker.execute<{ n: number }>('kernel.erase_invariant_test.system', {}, { actor: SYSTEM, orgId })).n).toBe(1);
    expect(await row(gone)).toMatchObject({ status: 'rejected', decided_by: null });
    expect((await audits()).at(-1)).toMatchObject({ target_id: gone, actor_type: 'system', actor_id: null });
  });

  it('is for an owner, an admin or the system only: a member, a viewer and an MCP grant are refused', async () => {
    for (const role of ['member', 'viewer'] as const) {
      await expect(eraseAs(users[role]), role).rejects.toMatchObject({ status: 403 });
    }
    // An MCP grant's context has the actor type 'agent': the definer refuses it without reading the sealed member key.
    const grantId = randomUUID();
    await q(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read', 'ludy.engage.write']::text[], $4, now(), now() + interval '30 days', $3, 'company', NULL)`,
      [orgId, grantId, users.owner, `oauth-${grantId}`, `client-${grantId}`],
    );
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT crove_kernel.enter_mcp_company_write_context($1::uuid, $2::uuid, $3::text)`, [orgId, grantId, 'ludy.engage.write']);
      await expect(c.query('SELECT crove_kernel.engage_proposal_erase_gone()')).rejects.toThrow(/ENGAGE_ERASE_FORBIDDEN|permission denied/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });

  it('keeps a Meta deletion request open when its erasure fails, and claims it again every five minutes without limit: a rolling deploy cannot lose it (#4234 item 4)', async () => {
    const as = async (role: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      return c;
    };
    const api = await as('crove_app', 'test-app-pw');
    const work = await as('crove_worker', 'test-worker-pw');
    try {
      const code = randomUUID().replace(/-/g, '');
      const hash = 'ab'.repeat(32);
      await q('UPDATE crove_kernel.channel_connection SET granted_by_hash = $2 WHERE org_id = $1 AND id = $3', [orgId, hash, connId]);
      expect((await api.query<{ code: string }>('SELECT crove_kernel.conversation_deletion_enqueue($1, $2) AS code', [code, hash])).rows[0]?.code).toBe(code);
      const claimed = async () => (await work.query<{ code: string; connection_id: string | null }>('SELECT code, connection_id FROM crove_kernel.conversation_deletion_claim(50)')).rows.filter((r) => r.code === code);
      const state = async () => (await q<{ completed_at: Date | null; minutes: number }>('SELECT completed_at, (extract(epoch FROM next_attempt_at - now()) / 60)::float8 AS minutes FROM crove_kernel.conversation_deletion_request WHERE code = $1', [code])).rows[0];
      // Each failed pass (the worker's catch calls the defer): put off five minutes, claimed again once due, open, and still naming the connection. Ten failures in a row change nothing: there is no attempt counter to run out.
      for (let pass = 0; pass < 10; pass += 1) {
        expect((await claimed()).map((r) => r.connection_id), `pass ${pass}`).toEqual([connId]);
        await work.query('SELECT crove_kernel.conversation_deletion_defer($1)', [code]);
        const after = await state();
        expect(after?.completed_at).toBeNull();
        expect(after?.minutes).toBeGreaterThan(4.5);
        expect(after?.minutes).toBeLessThanOrEqual(5);
        expect(await claimed(), `not due on pass ${pass}`).toEqual([]);
        await q(`UPDATE crove_kernel.conversation_deletion_request SET next_attempt_at = now() - interval '1 second' WHERE code = $1`, [code]);
      }
      // Meta states no retry schedule: the request is ours to finish, and the worker's catch defers it and never completes or deletes it.
      const source = readFileSync(fileURLToPath(new URL('../../src/conversations-worker.ts', import.meta.url)), 'utf8');
      const run = source.slice(source.indexOf('export async function runConversationDeletions'), source.indexOf("// Vy's drafts"));
      expect(run).toMatch(/catch \(error\)[\s\S]*conversation_deletion_defer/);
      expect(run.match(/conversation_deletion_complete/g)).toHaveLength(1);
      await work.query('SELECT crove_kernel.conversation_deletion_complete($1, 1)', [code]);
      expect((await state())?.completed_at).not.toBeNull();
    } finally {
      await api.end();
      await work.end();
      await q('UPDATE crove_kernel.channel_connection SET granted_by_hash = NULL WHERE org_id = $1 AND id = $2', [orgId, connId]);
    }
  });
});
