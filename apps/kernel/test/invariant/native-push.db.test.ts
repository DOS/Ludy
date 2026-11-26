// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for mobile native push (#4883, ADR-0059):
//   - Direct SQL RLS restricts ludy_kernel.native_push_device strictly to the owning user (ctx_user_id(), never member_vy).
//   - ludy_kernel.native_push_sent is definer-only machinery (zero login role grants).
//   - Worker-only definers reject ludy_app calls; fail-closed AUTH_GRANTS_MISSING when upstream check is required.
//   - Cross-user token handoff definer requires the authenticated owner's user context and active membership.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, type AgentActor } from '@ludy/kernel-runtime';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'native-push.invariant' };
const suite = ADMIN ? describe : describe.skip;

suite('native push security invariants on PostgreSQL 17 (#4883)', () => {
  const dbName = `ludy_inv_native_push_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;

  const asUser = (userId: string, sessionId: string = randomUUID()) => ({
    type: 'user' as const,
    userId,
    sessionId,
    aal: 'aal1' as const,
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inUrl<T>(
    url: string,
    setup: (c: pg.Client) => Promise<unknown>,
    fn: (c: pg.Client) => Promise<T>,
    commit = false,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await setup(c);
      const out = await fn(c);
      if (commit) await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  const asApp = <T>(orgId: string, userId: string, fn: (c: pg.Client) => Promise<T>, commit = false) =>
    inUrl(
      appUrl,
      (c) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]),
      fn,
      commit,
    );

  async function person(name: string): Promise<string> {
    return upsertIdentity(db, {
      issuer: 'native-push-invariant',
      subject: randomUUID(),
      email: `${name}-${randomUUID().slice(0, 8)}@np-invariant.test`,
      name: null,
    });
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'inv-app-pw', ludy_worker: 'inv-worker-pw' });

    const login = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = login('ludy_app', 'inv-app-pw');
    workerUrl = login('ludy_worker', 'inv-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces per-user RLS (never member_vy), machinery revocation, worker-only definers, and fail-closed auth grants check', async () => {
    const owner = await person('owner');
    const memberA = await person('member-a');
    const memberB = await person('member-b');
    const { orgId } = await createOrg(rt, asUser(owner), `Inv Org ${randomUUID().slice(0, 6)}`);
    await admin((c) =>
      c.query(
        "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
        [orgId, memberA, memberB],
      ),
    );

    const aReg = await rt.execute<{ id: string }>(
      'kernel.native_push.register',
      { platform: 'apns', token: `apns-invariant-a-${randomUUID()}` },
      { actor: asUser(memberA), orgId },
    );

    // 1. Cross-member SQL RLS isolation on ludy_app.
    expect(
      (await asApp(orgId, memberB, (c) => c.query('SELECT id FROM ludy_kernel.native_push_device WHERE id = $1', [aReg.id]))).rows,
    ).toEqual([]);
    expect(
      await asApp(
        orgId,
        memberB,
        async (c) => (await c.query("UPDATE ludy_kernel.native_push_device SET label = 'stolen' WHERE id = $1", [aReg.id])).rowCount,
      ),
    ).toBe(0);
    expect(
      await asApp(
        orgId,
        memberB,
        async (c) => (await c.query('DELETE FROM ludy_kernel.native_push_device WHERE id = $1', [aReg.id])).rowCount,
      ),
    ).toBe(0);
    await expect(
      asApp(orgId, memberB, (c) =>
        c.query(
          "INSERT INTO ludy_kernel.native_push_device (org_id, user_id, session_id, platform, token) VALUES ($1, $2, $3, 'apns', $4)",
          [orgId, memberA, randomUUID(), `apns-forged-${randomUUID()}`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // 2. Definer-only machinery & worker-only gate.
    await expect(asApp(orgId, owner, (c) => c.query('SELECT * FROM ludy_kernel.native_push_sent'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      inUrl(workerUrl, async () => {}, (c) => c.query('SELECT * FROM ludy_kernel.native_push_sent')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(orgId, owner, (c) => c.query('SELECT * FROM ludy_kernel.native_push_claim(10, NULL)'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      inUrl(
        workerUrl,
        (c) => c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]),
        (c) => c.query('SELECT * FROM ludy_kernel.native_push_claim(10, NULL)'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(orgId, owner, (c) => c.query('SELECT * FROM ludy_kernel.native_push_targets($1::uuid, false)', [randomUUID()])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(orgId, memberB, (c) =>
        c.query('SELECT ludy_kernel.native_push_claim_token($1::uuid, $2::uuid, $3::text, $4::text)', [
          orgId,
          memberA,
          'apns',
          `apns-hijack-${randomUUID()}`,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(rt.query('kernel.native_push.targets', { notificationId: randomUUID() }, { actor: asUser(owner), orgId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      worker.execute('kernel.native_push.register', { platform: 'fcm', token: `fcm-sys-${randomUUID()}` }, { actor: SYSTEM, orgId }),
    ).rejects.toMatchObject({ status: 403 });

    // 3. member_vy for the SAME memberA CANNOT read/modify/insert memberA's native_push_device rows (ctx_user_id() != ctx_acting_user_id()).
    const vyAgentId = randomUUID();
    const vyRunId = randomUUID();
    await asApp(
      orgId,
      memberA,
      async (c) => {
        await c.query(
          `INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
           VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
          [orgId, vyAgentId, memberA],
        );
        await c.query(
          `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at)
           VALUES ($1, $2, $3, 'notes', 'notes.summary', 'running', true, now(), now() + interval '30 minutes')`,
          [orgId, vyRunId, vyAgentId],
        );
      },
      true,
    );

    await inUrl(
      workerUrl,
      (c) => c.query('SELECT ludy_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vyAgentId, vyRunId]),
      async (c) => {
        expect((await c.query('SELECT id FROM ludy_kernel.native_push_device')).rows).toEqual([]);
        expect((await c.query("UPDATE ludy_kernel.native_push_device SET label = 'hijacked'")).rowCount).toBe(0);
        expect((await c.query('DELETE FROM ludy_kernel.native_push_device')).rowCount).toBe(0);
        await expect(
          c.query(
            "INSERT INTO ludy_kernel.native_push_device (org_id, user_id, session_id, platform, token) VALUES ($1, $2, $3, 'fcm', $4)",
            [orgId, memberA, randomUUID(), `fcm-vy-forged-${randomUUID()}`],
          ),
        ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
      },
    );

    const vyActor: AgentActor = { type: 'agent', agentId: vyAgentId, runId: vyRunId, memberVy: true };
    await expect(
      worker.execute(
        'kernel.native_push.register',
        { platform: 'fcm', token: `fcm-vy-cmd-${randomUUID()}` },
        { actor: vyActor, orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 4. Upstream check fails closed when auth_grants_ready() is false and checkUpstream=true.
    await expect(
      worker.query('kernel.native_push.targets', { notificationId: randomUUID(), checkUpstream: true }, { actor: SYSTEM, orgId }),
    ).rejects.toMatchObject({ code: 'AUTH_NOT_READY', status: 503 });
  });
});
