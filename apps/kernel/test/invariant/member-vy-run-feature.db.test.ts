// SPDX-License-Identifier: AGPL-3.0-only
// One live Vy run per member per feature (#3029, ADR-0049 decision 1 amended 2026-11-12): the database holds the rule, so no command, definer or hand-written insert can get around it.
//   - ai_run_one_running_uq is gone; ai_run_one_running_agent_uq keeps one running run per org-chart agent, and ai_run_one_running_feature_uq allows one running run per (agent, feature);
//   - a member_vy run is inserted only with a feature, an org-chart agent's run never has one, and the feature of a run never changes (ai_run_member_vy_bind, also OF feature);
//   - a result's feature must equal its run's (member_vy_result_bind);
//   - the 4-hour bound of a run is per run and unchanged.
// Part of the invariant suite: it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('one live Vy run per member per feature, held by the database (#3029)', () => {
  const dbName = `crove_test_vy_run_feature_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  const users = { owner: '', alice: '', bob: '' };
  const agents = { alice: '', bob: '', chart: '' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // What a statement did, in a savepoint so the transaction goes on: ok, or the error's code, its message and its constraint.
  async function attempt(c: pg.Client, text: string, values: unknown[] = []): Promise<{ ok: boolean; code?: string; message?: string; constraint?: string }> {
    await c.query('SAVEPOINT attempt');
    try {
      await c.query(text, values);
      await c.query('RELEASE SAVEPOINT attempt');
      return { ok: true };
    } catch (error: unknown) {
      await c.query('ROLLBACK TO SAVEPOINT attempt');
      const e = error as { code?: string; message?: string; constraint?: string };
      return { ok: false, ...(e.code ? { code: e.code } : {}), ...(e.message ? { message: e.message } : {}), ...(e.constraint ? { constraint: e.constraint } : {}) };
    }
  }

  // The member's own user context on the app login, in a transaction rolled back at the end.
  async function asMember<T>(userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  const insertRun = (c: pg.Client, agent: string, feature: string | null, opts: { id?: string; status?: string; expires?: string } = {}) =>
    attempt(
      c,
      `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at, finished_at)
       VALUES ($1, $2, $3, 'notes', $4, $5, true, now() - interval '1 minute', now() + $6::interval, CASE WHEN $5 = 'running' THEN NULL ELSE now() END)`,
      [orgId, opts.id ?? randomUUID(), agent, feature, opts.status ?? 'running', opts.expires ?? '30 minutes'],
    );

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'vy-run-feature', subject: key, email: `${key}@vy-run-feature.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Vy theo tính năng')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.alice, users.bob]);
      // Each member's Vy is made in the member's own context; the org-chart agent by the superuser, as the matrix seeds it.
      agents.chart = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.agent (org_id, template_key, display_name, created_by) VALUES ($1, 'finance.chief_accountant', 'Kế toán', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id as string;
    });
    for (const who of ['alice', 'bob'] as const) {
      agents[who] = await asMember(users[who], async (c) => {
        const id = randomUUID();
        await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, id, users[who]]);
        await c.query('COMMIT');
        return id;
      });
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

  it('replaces the one-running-run index by two partial unique indexes: one per org-chart agent, one per (agent, feature)', async () => {
    const rows = await admin(async (c) =>
      (await c.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'crove_kernel' AND tablename = 'ai_run' AND indexname LIKE 'ai_run_one_running%' ORDER BY indexname`)).rows,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['ai_run_one_running_agent_uq', 'ai_run_one_running_feature_uq']);
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/\s+/g, ' ')]));
    expect(byName.ai_run_one_running_agent_uq).toMatch(/CREATE UNIQUE INDEX .* \(org_id, agent_id\) WHERE .*status = 'running'.* AND \(feature IS NULL\)/);
    expect(byName.ai_run_one_running_feature_uq).toMatch(/CREATE UNIQUE INDEX .* \(org_id, agent_id, feature\) WHERE .*status = 'running'.* AND \(feature IS NOT NULL\)/);
  });

  it('lets a member run one feature at a time and several features together, in the member\'s own context', async () => {
    await asMember(users.alice, async (c) => {
      expect(await insertRun(c, agents.alice, 'meetings.transcribe')).toMatchObject({ ok: true });
      expect(await insertRun(c, agents.alice, 'meetings.summary'), 'another feature, together').toMatchObject({ ok: true });
      expect(await insertRun(c, agents.alice, 'notes.summary'), 'a third').toMatchObject({ ok: true });
      const again = await insertRun(c, agents.alice, 'meetings.transcribe');
      expect(again, 'the same feature twice').toMatchObject({ ok: false, code: '23505', constraint: 'ai_run_one_running_feature_uq' });
      // A finished run of the feature does not count.
      expect(await insertRun(c, agents.alice, 'meetings.transcribe', { status: 'succeeded' })).toMatchObject({ ok: true });
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.ai_run WHERE org_id = $1 AND agent_id = $2 AND status = 'running'`, [orgId, agents.alice]);
      expect(rows[0]?.n).toBe('3');
    });
    // The rule is per member's Vy: another member's Vy runs the same feature at the same moment.
    await asMember(users.bob, async (c) => {
      expect(await insertRun(c, agents.bob, 'meetings.transcribe')).toMatchObject({ ok: true });
    });
  });

  it('refuses a member\'s Vy run without a feature, and a change of the feature of a run (ai_run_member_vy_bind)', async () => {
    await asMember(users.alice, async (c) => {
      expect(await insertRun(c, agents.alice, null)).toMatchObject({ ok: false, code: '23514', message: 'MEMBER_VY_RUN_FEATURE' });
      const id = randomUUID();
      expect(await insertRun(c, agents.alice, 'notes.summary', { id })).toMatchObject({ ok: true });
      for (const next of ['meetings.summary', null]) {
        expect(await attempt(c, `UPDATE crove_kernel.ai_run SET feature = $3 WHERE org_id = $1 AND id = $2`, [orgId, id, next]), `feature -> ${next}`).toMatchObject({ ok: false, code: '42501', message: 'MEMBER_VY_RUN_BINDING' });
      }
      // The agent of a run never changes either (unchanged rule).
      expect(await attempt(c, `UPDATE crove_kernel.ai_run SET agent_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, id, agents.bob])).toMatchObject({ ok: false, code: '42501', message: 'MEMBER_VY_RUN_BINDING' });
    });
  });

  it('keeps the 4-hour bound of a member\'s Vy run per run, whatever its feature', async () => {
    await asMember(users.alice, async (c) => {
      expect(await insertRun(c, agents.alice, 'meetings.transcribe', { expires: '4 hours' }), 'the start is a minute back, so 4 hours from now is past the bound').toMatchObject({ ok: false, code: '23514', message: 'MEMBER_VY_RUN_EXPIRY' });
      expect(await insertRun(c, agents.alice, 'meetings.transcribe', { expires: '3 hours 58 minutes' })).toMatchObject({ ok: true });
    });
  });

  it('keeps one running run per org-chart agent, and gives an org-chart agent\'s run no feature', async () => {
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        expect(await insertRun(c, agents.chart, 'finance.invoice_read'), 'an org-chart run with a feature').toMatchObject({ ok: false, code: '23514', message: 'MEMBER_VY_RUN_FEATURE' });
        expect(await insertRun(c, agents.chart, null)).toMatchObject({ ok: true });
        expect(await insertRun(c, agents.chart, null), 'the second running run of the agent').toMatchObject({ ok: false, code: '23505', constraint: 'ai_run_one_running_agent_uq' });
        expect(await insertRun(c, agents.chart, null, { status: 'succeeded' }), 'a finished one').toMatchObject({ ok: true });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('refuses a result whose feature is not its run\'s feature (member_vy_result_bind), and takes one that is', async () => {
    await asMember(users.alice, async (c) => {
      const run = randomUUID();
      expect(await insertRun(c, agents.alice, 'meetings.transcribe', { id: run })).toMatchObject({ ok: true });
      const insertResult = (feature: string) =>
        attempt(
          c,
          `INSERT INTO crove_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, expires_at) VALUES ($1, $2, $3, $4, 'meeting', $5, now() + interval '20 days')`,
          [orgId, users.alice, run, feature, randomUUID()],
        );
      const wrong = await insertResult('meetings.summary');
      expect(wrong).toMatchObject({ ok: false, code: '42501' });
      expect(wrong.message).toContain('member_vy_result');
      expect(await insertResult('meetings.transcribe')).toMatchObject({ ok: true });
    });
  });
});
