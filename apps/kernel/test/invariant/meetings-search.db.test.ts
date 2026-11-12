// SPDX-License-Identifier: AGPL-3.0-only
// Search across meeting text (issue #2589, meetings plan L2, ADR-0047 point 2), on PostgreSQL 17. What must hold on every later change to it:
// - The search finds a transcript line only for a caller who reads it: the recorder (every stage of their own meeting) and a reader of the meeting (published lines). An owner or
//   admin who is not a reader, a member who is not named, a draft that is not theirs, another org, and a meeting past its text date give no id; a viewer, an agent, the system context and
//   a caller with no context are refused (42501) and an invalid page raises; the answer is the same for a word that is not there and a line that is not theirs.
// - The folded words (transcript_segment.search) are a GENERATED column: nothing writes them, the database rebuilds them from the text on every update, so a correction or an erasure of
//   a mention leaves nothing of the old text in them, and no delete, purge or erase path has a second copy to clear.
// - A search definer of crove_meetings pins search_path, is granted to no PUBLIC, worker or app login, and answers ids only (never text).
// Part of the invariant suite; imports package code under test only. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;
const SEARCH = 'crove_meetings.search_segment_ids(text, integer, integer)';

suite('search across meeting text on PostgreSQL (#2589, ADR-0047)', () => {
  const dbName = `crove_test_meetings_search_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  const users = { owner: '', admin: '', recorder: '', attendee: '', stranger: '', viewer: '', outsider: '' };
  const seg: Record<string, string> = {};
  let agent = { agentId: '', runId: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const member = (name: string, userId: () => string, org: () => string = () => orgId): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org(), contextToken(userId(), org())]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = { name: 'an agent context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]) };
  const noContext: Actor = { name: 'no context', url: () => appUrl, enter: async () => undefined };
  async function run<T>(actor: Actor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: actor.url() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await actor.enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  const idsFor = async (actor: Actor, q: string, limit = 51, offset = 0) => (await run(actor, (c) => c.query<{ id: string }>(`SELECT id FROM ${SEARCH.replace(/\(.*/, '')}($1, $2, $3)`, [q, limit, offset]))).rows.map((r) => r.id);

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const apiRuntime = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(apiRuntime.db, { issuer: 'meetings-search-inv', subject: key, email: `${key}@meetings-search-inv.test`, name: null });
    orgId = (await createOrg(apiRuntime.runtime, asUser(users.owner), 'Tìm trong họp (bất biến)')).orgId;
    otherOrgId = (await createOrg(apiRuntime.runtime, asUser(users.outsider), 'Org khác (bất biến)')).orgId;
    const meeting = async (id: string, org: string, recorder: string, visibility: 'attendees' | 'org', textRetention = 'current_date + 365', readers: string[] = []) => {
      await admin(async (c) => {
        await c.query(
          `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, 'Họp thử', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, $4, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, ${textRetention})`,
          [org, id, recorder, visibility],
        );
        for (const reader of readers) await c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [org, randomUUID(), id, reader]);
      });
    };
    const line = async (key: string, org: string, meetingId: string, stage: 'draft' | 'published', text: string) => {
      seg[key] = randomUUID();
      await admin((c) => c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 5, 'Hà', $4, $5)`, [org, seg[key], meetingId, text, stage]));
    };
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`, [
        orgId,
        users.admin,
        users.recorder,
        users.attendee,
        users.stranger,
        users.viewer,
      ]),
    );
    const hidden = randomUUID();
    const shared = randomUUID();
    const expired = randomUUID();
    const foreign = randomUUID();
    await meeting(hidden, orgId, users.recorder, 'attendees', undefined, [users.attendee]);
    await meeting(shared, orgId, users.recorder, 'org');
    await meeting(expired, orgId, users.recorder, 'org', `(timezone('Asia/Ho_Chi_Minh', now()))::date`);
    await meeting(foreign, otherOrgId, users.outsider, 'org');
    await line('hiddenPublished', orgId, hidden, 'published', 'Chiết khấu kín cho nhóm lương');
    await line('hiddenDraft', orgId, hidden, 'draft', 'Nháp chiết khấu của người ghi');
    await line('sharedPublished', orgId, shared, 'published', 'Chiết khấu chung cho khách quen');
    await line('sharedDraft', orgId, shared, 'draft', 'Nháp chiết khấu riêng');
    await line('expired', orgId, expired, 'published', 'Chiết khấu hết hạn chữ');
    await line('foreign', otherOrgId, foreign, 'published', 'Chiết khấu của org khác');
    const installed = await apiRuntime.runtime.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'finance.chief_accountant', reportsTo: null }, { actor: { ...asUser(users.owner), aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId });
    await apiRuntime.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('names a line only to a caller who reads it', async () => {
    const recorder = member('the recorder', () => users.recorder);
    const attendee = member('an attendee', () => users.attendee);
    // The recorder: every stage of their own meetings, and nothing past its text date or of another org.
    expect((await idsFor(recorder, 'chiet khau')).sort()).toEqual([seg.hiddenPublished, seg.hiddenDraft, seg.sharedPublished, seg.sharedDraft].sort());
    // A named attendee: published lines of the meeting they are named in and of the shared one; never a draft.
    expect((await idsFor(attendee, 'chiet khau')).sort()).toEqual([seg.hiddenPublished, seg.sharedPublished].sort());
    // A member not named, an owner and an admin who are no readers of the attendees-only meeting: only the shared meeting's published line.
    for (const actor of [member('a member who is not named', () => users.stranger), member('an owner', () => users.owner), member('an admin', () => users.admin)]) {
      expect(await idsFor(actor, 'chiet khau'), actor.name).toEqual([seg.sharedPublished]);
      expect(await idsFor(actor, 'luong'), actor.name).toEqual([]);
    }
    // Another org's user sees their own org's line only, in their own org's context.
    expect(await idsFor(member('another org', () => users.outsider, () => otherOrgId), 'chiet khau')).toEqual([seg.foreign]);
    // A word nobody wrote answers the same empty list as a line the caller may not read.
    expect(await idsFor(member('an owner', () => users.owner), 'khongaiviet')).toEqual([]);
    // A member of org A who enters org B's context is refused by the context itself.
    const crossed = await outcome(run(member('a member of another org', () => users.owner, () => otherOrgId), (c) => c.query(`SELECT * FROM crove_meetings.search_segment_ids('chiet', 10, 0)`)));
    expect(crossed.ok).toBe(false);
  });

  it('refuses a viewer, an agent, the system context and a caller with no context, and an invalid page', async () => {
    for (const actor of [member('a viewer', () => users.viewer), agentActor, system, noContext]) {
      expect(await outcome(run(actor, (c) => c.query(`SELECT * FROM crove_meetings.search_segment_ids('chiet', 10, 0)`))), actor.name).toMatchObject({ ok: false, code: '42501' });
    }
    const owner = member('an owner', () => users.owner);
    for (const [limit, offset] of [[0, 0], [52, 0], [10, -1], [10, 201]]) {
      expect(await outcome(run(owner, (c) => c.query(`SELECT * FROM crove_meetings.search_segment_ids('chiet', $1, $2)`, [limit, offset]))), `limit ${limit} offset ${offset}`).toMatchObject({ ok: false, code: '22023' });
    }
    expect(await outcome(run(owner, (c) => c.query(`SELECT * FROM crove_meetings.search_segment_ids(NULL, 10, 0)`)))).toMatchObject({ ok: false, code: '22023' });
    // Text that folds to nothing is no hit, not an error; a page never holds more than it was asked for.
    expect(await idsFor(owner, '!!! ...')).toEqual([]);
    expect(await idsFor(owner, 'chiet', 1)).toHaveLength(1);
  });

  it('pins the search definer: search_path, no PUBLIC, worker or app grant, ids only', async () => {
    const rows = await admin(async (c) =>
      (
        await c.query<{ sig: string; secdef: boolean; config: string[] | null; ret: string; public_exec: boolean; app_exec: boolean; worker_exec: boolean }>(
          `SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS sig, p.prosecdef AS secdef, p.proconfig AS config,
                  pg_catalog.pg_get_function_result(p.oid) AS ret,
                  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                  pg_catalog.has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app_exec,
                  pg_catalog.has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker_exec
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'crove_meetings' AND p.proname LIKE 'search\\_%'`,
        )
      ).rows,
    );
    // The names are part of the contract: another search definer is a new surface to review.
    expect(rows.map((r) => r.sig)).toEqual([SEARCH]);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(row.config?.some((s) => s === 'search_path=pg_catalog, pg_temp')).toBe(true);
      expect(row.public_exec).toBe(false);
      // crove_app and crove_worker inherit the grant of crove_tenant; the worker's system context is refused inside (the test above), and no login role has a grant of its own (below).
      expect(row.ret).toBe('TABLE(id uuid)');
    }
    // The grant belongs to crove_tenant, not to a login role directly.
    const direct = await admin((c) => c.query(`SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.proname = 'search_segment_ids' AND a.privilege_type = 'EXECUTE' AND a.grantee <> 'crove_tenant'::regrole AND a.grantee <> p.proowner`));
    expect(direct.rowCount).toBe(0);
  });

  it('keeps the folded words a generated column nothing writes, rebuilt from the text on every update', async () => {
    const col = await admin((c) => c.query<{ attgenerated: string; typ: string }>(`SELECT a.attgenerated, pg_catalog.format_type(a.atttypid, NULL) AS typ FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'crove_meetings.transcript_segment'::regclass AND a.attname = 'search' AND NOT a.attisdropped`));
    expect(col.rows[0]).toEqual({ attgenerated: 's', typ: 'tsvector' });
    // No role writes it: an insert or update that names it is refused by the database, as the owner's too.
    await expect(admin((c) => c.query(`UPDATE crove_meetings.transcript_segment SET search = to_tsvector('simple', 'x') WHERE id = $1`, [seg.sharedPublished]))).rejects.toMatchObject({ code: '428C9' });
    // An update of the text rebuilds it in the same statement: the old words are gone, the new ones are there.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(`UPDATE crove_meetings.transcript_segment SET text = 'Giá mới hoàn toàn' WHERE id = $1`, [seg.sharedDraft]);
      const words = (await c.query<{ search: string }>(`SELECT search::text AS search FROM crove_meetings.transcript_segment WHERE id = $1`, [seg.sharedDraft])).rows[0]?.search ?? '';
      await c.query('ROLLBACK');
      expect(words).toContain('hoan');
      expect(words).not.toContain('chiet');
    });
    // Nor an insert that names it, from the login role that writes meeting text.
    const named = await outcome(
      run(member('the recorder', () => users.recorder), (c) =>
        c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage, search) SELECT org_id, meeting_id, 0, 1, 'Hà', 'x', 'draft', to_tsvector('simple', 'chiet') FROM crove_meetings.transcript_segment WHERE id = $1`, [seg.hiddenDraft]),
      ),
    );
    expect(named).toMatchObject({ ok: false, code: '428C9' });
  });
});
