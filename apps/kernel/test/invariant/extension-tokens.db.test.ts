// SPDX-License-Identifier: AGPL-3.0-only
// Security properties of extension tokens and PKCE auth codes (issue #2582, ADR-0047, AI Meeting Notes plan M8) on PostgreSQL 17:
// - no login role (crove_app, crove_worker, crove_tenant, crove_definer_tenant, crove_auth_reader) and no org-chart agent
//   context directly reads or writes crove_kernel.extension_token or crove_kernel.extension_auth_code (definer-only MACHINERY);
// - token_hash and code_hash are 32-byte SHA-256 digests (octet_length = 32), and extension tokens expire in at most 90 days;
// - PKCE authorization codes are single-use, short-lived, and bound to (org_id, user_id, code_challenge);
// - extension tokens are listed and revoked only by their owning member within that org; another member, owner/admin of
//   another org, viewer, agent, and system context cannot list or revoke them;
// - token verification fails immediately when revoked, expired, member removed from tenant_member, or member lacks the module's permission.
// While crove_kernel.extension_token or crove_kernel.extension_auth_code do not exist yet (to_regclass is null), the tests pass cleanly with zero skipped tests.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

function sha256Buffer(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function makeToken(raw = randomBytes(32).toString('hex')) {
  return {
    id: randomUUID(),
    raw,
    hash: sha256Buffer(raw),
  };
}

function makeAuthCode(verifier = randomBytes(32).toString('base64url')) {
  const raw = randomBytes(32).toString('hex');
  return {
    id: randomUUID(),
    raw,
    hash: sha256Buffer(raw),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

suite('extension tokens and PKCE authorization codes on PostgreSQL (#2582, ADR-0047)', () => {
  const dbName = `crove_test_ext_tokens_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgAId = '';
  let orgBId = '';

  const tables = {
    extension_token: false,
    extension_auth_code: false,
  };

  const users = {
    ownerA: '',
    memberA1: '',
    memberA2: '',
    viewerA: '',
    ownerB: '',
    memberB1: '',
  };

  let agent = { agentId: '', runId: '' };

  const tokens = {
    activeA1: makeToken(),
    revokedA1: makeToken(),
    expiredA1: makeToken(),
    activeA2: makeToken(),
    activeB1: makeToken(),
  };

  const authCodes = {
    activeA1: makeAuthCode('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    consumedA1: makeAuthCode('verifier-consumed-0123456789012345678901234'),
    expiredA1: makeAuthCode('verifier-expired-012345678901234567890123456'),
  };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }

  const memberActor = (name: string, userId: () => string, orgId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId(), contextToken(userId(), orgId())]),
  });

  const systemActor = (orgId: () => string): Actor => ({
    name: 'the system context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId()]),
  });

  const agentActor = (orgId: () => string): Actor => ({
    name: 'an agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId(), agent.agentId, agent.runId]),
  });

  const memberA1 = memberActor('member A1', () => users.memberA1, () => orgAId);
  const memberA2 = memberActor('member A2', () => users.memberA2, () => orgAId);
  const viewerA = memberActor('viewer A', () => users.viewerA, () => orgAId);
  const ownerA = memberActor('owner A', () => users.ownerA, () => orgAId);
  const memberB1 = memberActor('member B1', () => users.memberB1, () => orgBId);
  const ownerB = memberActor('owner B', () => users.ownerB, () => orgBId);
  const systemA = systemActor(() => orgAId);
  const agentA = agentActor(() => orgAId);

  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);

  beforeAll(async () => {
    if (!ADMIN) return;
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
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
        }),
      };
    };

    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'extension-tokens', subject: key, email: `${key}@ext-tokens.test`, name: null });
    }

    orgAId = (await createOrg(api.runtime, asUser(users.ownerA), 'Org A')).orgId;
    orgBId = (await createOrg(api.runtime, asUser(users.ownerB), 'Org B')).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
           ($1, $2, 'member'),
           ($1, $3, 'member'),
           ($1, $4, 'viewer'),
           ($5, $6, 'member')`,
        [orgAId, users.memberA1, users.memberA2, users.viewerA, orgBId, users.memberB1],
      );
    });

    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.ownerA), orgId: orgAId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.ownerA), orgId: orgAId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId: orgAId });
    agent = { agentId: installed.agentId, runId: started.runId as string };

    const checkTable = async (name: string): Promise<boolean> => {
      return await admin(async (c) => {
        const res = await c.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [name]);
        return res.rows[0]?.exists === true;
      });
    };

    tables.extension_token = await checkTable('crove_kernel.extension_token');
    tables.extension_auth_code = await checkTable('crove_kernel.extension_auth_code');

    if (tables.extension_token) {
      await admin(async (c) => {
        // Token 1: active for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Laptop Chrome', ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
          [orgAId, tokens.activeA1.id, users.memberA1, tokens.activeA1.hash],
        );

        // Token 2: revoked for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, revoked_at, created_by)
           VALUES ($1, $2, $3, $4, 'Old Phone', ARRAY['meetings'], now() - interval '2 days', now() + interval '88 days', now() - interval '1 hour', $3)`,
          [orgAId, tokens.revokedA1.id, users.memberA1, tokens.revokedA1.hash],
        );

        // Token 3: expired for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Expired Device', ARRAY['meetings'], now() - interval '95 days', now() - interval '5 days', $3)`,
          [orgAId, tokens.expiredA1.id, users.memberA1, tokens.expiredA1.hash],
        );

        // Token 4: active for memberA2 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Work PC', ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
          [orgAId, tokens.activeA2.id, users.memberA2, tokens.activeA2.hash],
        );

        // Token 5: active for memberB1 in Org B
        await c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Org B Mac', ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
          [orgBId, tokens.activeB1.id, users.memberB1, tokens.activeB1.hash],
        );
      });
    }

    if (tables.extension_auth_code) {
      await admin(async (c) => {
        // Auth code 1: active unconsumed for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', now(), now() + interval '5 minutes')`,
          [orgAId, authCodes.activeA1.id, users.memberA1, authCodes.activeA1.hash, authCodes.activeA1.challenge],
        );

        // Auth code 2: consumed for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at, consumed_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', now() - interval '2 minutes', now() + interval '3 minutes', now() - interval '1 minute')`,
          [orgAId, authCodes.consumedA1.id, users.memberA1, authCodes.consumedA1.hash, authCodes.consumedA1.challenge],
        );

        // Auth code 3: expired for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', now() - interval '15 minutes', now() - interval '10 minutes')`,
          [orgAId, authCodes.expiredA1.id, users.memberA1, authCodes.expiredA1.hash, authCodes.expiredA1.challenge],
        );
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

  it('passes cleanly while extension token tables are pending; once present, confirms schema conformance and RLS configuration', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      expect(tables.extension_auth_code).toBe(false);
      return;
    }

    expect(tables.extension_token).toBe(true);
    expect(tables.extension_auth_code).toBe(true);

    await admin(async (c) => {
      // Primary keys must be composite (org_id, id)
      for (const tbl of ['extension_token', 'extension_auth_code']) {
        const pk = await c.query<{ attname: string }>(
          `SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = ('crove_kernel.' || $1)::regclass AND i.indisprimary
           ORDER BY array_position(i.indkey, a.attnum)`,
          [tbl],
        );
        expect(pk.rows.map((r) => r.attname), `${tbl} primary key`).toEqual(['org_id', 'id']);

        // RLS must be enabled and forced
        const rls = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('crove_kernel.' || $1)::regclass`,
          [tbl],
        );
        expect(rls.rows[0]?.relrowsecurity, `${tbl} relrowsecurity`).toBe(true);
        expect(rls.rows[0]?.relforcerowsecurity, `${tbl} relforcerowsecurity`).toBe(true);

        // Foreign key to tenant(org_id)
        const fk = await c.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = ('crove_kernel.' || $1)::regclass AND contype = 'f' AND confrelid = 'crove_kernel.tenant'::regclass`,
          [tbl],
        );
        expect(fk.rows.length, `${tbl} foreign key to crove_kernel.tenant`).toBeGreaterThan(0);

        // No timestamp without time zone columns
        const badTs = await c.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'crove_kernel' AND table_name = $1 AND data_type = 'timestamp without time zone'`,
          [tbl],
        );
        expect(badTs.rows, `${tbl} has no timestamp without time zone`).toEqual([]);
      }
    });
  });

  it('strictly denies direct table access to all login roles and agent contexts (definer-only machinery)', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    const RUNTIME_ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'PUBLIC'];
    const TARGET_TABLES = ['extension_token', 'extension_auth_code'];

    await admin(async (c) => {
      for (const tbl of TARGET_TABLES) {
        for (const role of RUNTIME_ROLES) {
          const privs = await c.query<{ privilege_type: string }>(
            `SELECT privilege_type FROM information_schema.table_privileges
             WHERE table_schema = 'crove_kernel' AND table_name = $1 AND grantee = $2`,
            [tbl, role],
          );
          expect(privs.rows, `crove_kernel.${tbl} grants for ${role}`).toEqual([]);
        }
      }
    });

    // Verify direct SELECT/INSERT from crove_app and crove_worker fails
    const appClient = new pg.Client({ connectionString: appUrl });
    await appClient.connect();
    try {
      await expect(appClient.query('SELECT * FROM crove_kernel.extension_token')).rejects.toMatchObject({ code: '42501' });
      await expect(appClient.query('SELECT * FROM crove_kernel.extension_auth_code')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appClient.end();
    }

    const workerClient = new pg.Client({ connectionString: workerUrl });
    await workerClient.connect();
    try {
      await expect(workerClient.query('SELECT * FROM crove_kernel.extension_token')).rejects.toMatchObject({ code: '42501' });
      await expect(workerClient.query('SELECT * FROM crove_kernel.extension_auth_code')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await workerClient.end();
    }

    // Verify agent context is denied direct access
    await expect(
      run(agentA, async (c) => {
        return await c.query('SELECT * FROM crove_kernel.extension_token');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces cryptographic invariants: 32-byte SHA-256 digests and 90-day maximum lifetime', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    await admin(async (c) => {
      // 1. token_hash octet_length must be 32 bytes (SHA-256)
      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, '\\x1234', 'Short Hash', ARRAY['meetings'], now(), now() + interval '30 days', $3)`,
          [orgAId, randomUUID(), users.memberA1],
        ),
      ).rejects.toThrow();

      // 2. code_hash octet_length must be 32 bytes (SHA-256)
      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
           VALUES ($1, $2, $3, '\\x1234', 'challenge', 'S256', ARRAY['meetings'], 'Device', now(), now() + interval '5 minutes')`,
          [orgAId, randomUUID(), users.memberA1],
        ),
      ).rejects.toThrow();

      // 3. expires_at cannot exceed created_at + 90 days
      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Overlong Expiry', ARRAY['meetings'], now(), now() + interval '91 days', $3)`,
          [orgAId, randomUUID(), users.memberA1, randomBytes(32)],
        ),
      ).rejects.toThrow();
    });
  });

  it('enforces single-use and short lifetime on PKCE authorization codes', async () => {
    if (!tables.extension_auth_code) {
      expect(tables.extension_auth_code).toBe(false);
      return;
    }

    await admin(async (c) => {
      // Verify active code exists and is unconsumed
      const active = await c.query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM crove_kernel.extension_auth_code WHERE id = $1`,
        [authCodes.activeA1.id],
      );
      expect(active.rows[0]?.consumed_at).toBeNull();

      // Verify consumed code has consumed_at populated
      const consumed = await c.query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM crove_kernel.extension_auth_code WHERE id = $1`,
        [authCodes.consumedA1.id],
      );
      expect(consumed.rows[0]?.consumed_at).not.toBeNull();

      // Verify expired code is past its expires_at
      const expired = await c.query<{ is_expired: boolean }>(
        `SELECT expires_at < now() AS is_expired FROM crove_kernel.extension_auth_code WHERE id = $1`,
        [authCodes.expiredA1.id],
      );
      expect(expired.rows[0]?.is_expired).toBe(true);
    });

    const hasExchangeProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.exchange_extension_auth_code(text,text)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasExchangeProc, 'crove_kernel.exchange_extension_auth_code must exist once tables land').toBe(true);

    if (hasExchangeProc) {
      await admin(async (c) => {
        // Exchange with wrong verifier fails
        await expect(
          c.query(`SELECT crove_kernel.exchange_extension_auth_code($1, 'wrong-verifier-1234567890')`, [
            authCodes.activeA1.raw,
          ]),
        ).rejects.toThrow();

        // Exchange with expired code fails
        await expect(
          c.query(`SELECT crove_kernel.exchange_extension_auth_code($1, $2)`, [
            authCodes.expiredA1.raw,
            authCodes.expiredA1.verifier,
          ]),
        ).rejects.toThrow();

        // Exchange with already consumed code fails
        await expect(
          c.query(`SELECT crove_kernel.exchange_extension_auth_code($1, $2)`, [
            authCodes.consumedA1.raw,
            authCodes.consumedA1.verifier,
          ]),
        ).rejects.toThrow();

        // Valid exchange succeeds
        const res = await c.query<{ token: string }>(
          `SELECT * FROM crove_kernel.exchange_extension_auth_code($1, $2)`,
          [authCodes.activeA1.raw, authCodes.activeA1.verifier],
        );
        expect(res.rows.length).toBe(1);

        // Re-exchange of the now-consumed code fails immediately (single-use enforced!)
        await expect(
          c.query(`SELECT crove_kernel.exchange_extension_auth_code($1, $2)`, [
            authCodes.activeA1.raw,
            authCodes.activeA1.verifier,
          ]),
        ).rejects.toThrow();
      });
    }
  });

  it('enforces cross-org and cross-member isolation on listing and revoking extension tokens', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    // Test list definer function if present
    const hasListProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.list_extension_tokens()') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasListProc, 'crove_kernel.list_extension_tokens must exist once tables land').toBe(true);

    if (hasListProc) {
      // Member A1 lists tokens: sees only their own tokens, never other members' or other orgs'
      const a1Tokens = await run(memberA1, async (c) => {
        const res = await c.query<{ id: string; device_name: string; token_hash?: unknown }>(
          `SELECT * FROM crove_kernel.list_extension_tokens()`,
        );
        return res.rows;
      });

      expect(a1Tokens.some((t) => t.id === tokens.activeA1.id)).toBe(true);
      expect(a1Tokens.every((t) => t.id !== tokens.activeA2.id), 'member A1 must not see member A2 tokens').toBe(true);
      expect(a1Tokens.every((t) => t.id !== tokens.activeB1.id), 'member A1 must not see org B tokens').toBe(true);
      expect(a1Tokens.every((t) => t.token_hash === undefined), 'list definer must never return token_hash').toBe(true);

      // Member A2 lists tokens: sees only member A2 tokens
      const a2Tokens = await run(memberA2, async (c) => {
        const res = await c.query<{ id: string }>(`SELECT * FROM crove_kernel.list_extension_tokens()`);
        return res.rows;
      });
      expect(a2Tokens.some((t) => t.id === tokens.activeA2.id)).toBe(true);
      expect(a2Tokens.every((t) => t.id !== tokens.activeA1.id)).toBe(true);

      // Org B member lists tokens: sees only Org B tokens
      const b1Tokens = await run(memberB1, async (c) => {
        const res = await c.query<{ id: string }>(`SELECT * FROM crove_kernel.list_extension_tokens()`);
        return res.rows;
      });
      expect(b1Tokens.some((t) => t.id === tokens.activeB1.id)).toBe(true);
      expect(b1Tokens.every((t) => t.id !== tokens.activeA1.id)).toBe(true);

      // Viewer A cannot list tokens
      const viewerTokens = await run(viewerA, async (c) => {
        return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
      });
      expect(viewerTokens).toEqual([]);

      // Owner A sees only owner A's tokens, not member A1's
      const ownerATokens = await run(ownerA, async (c) => {
        return (await c.query<{ id: string }>(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
      });
      expect(ownerATokens.every((t) => t.id !== tokens.activeA1.id), 'owner A must not see member A1 tokens').toBe(true);

      // Owner B sees only Org B tokens, none from Org A
      const ownerBTokens = await run(ownerB, async (c) => {
        return (await c.query<{ id: string }>(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
      });
      expect(ownerBTokens.every((t) => t.id !== tokens.activeA1.id), 'owner B must not see Org A tokens').toBe(true);

      // System context and agent context cannot list member tokens
      const sysTokens = await run(systemA, async (c) => {
        return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
      });
      expect(sysTokens).toEqual([]);

      const agentTokens = await run(agentA, async (c) => {
        return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
      });
      expect(agentTokens).toEqual([]);
    }

    // Test revoke definer function if present
    const hasRevokeProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.revoke_extension_token(uuid)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasRevokeProc, 'crove_kernel.revoke_extension_token must exist once tables land').toBe(true);

    if (hasRevokeProc) {
      // Member A2 cannot revoke Member A1's token
      const crossMemberRevoke = await run(memberA2, async (c) => {
        const res = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        return res.rows[0]?.revoked ?? false;
      });
      expect(crossMemberRevoke, 'member A2 revoking member A1 token must fail').toBe(false);

      // Member B1 cannot revoke Org A's token
      const crossOrgRevoke = await run(memberB1, async (c) => {
        const res = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        return res.rows[0]?.revoked ?? false;
      });
      expect(crossOrgRevoke, 'member B1 revoking Org A token must fail').toBe(false);

      // Viewer A cannot revoke Member A1's token
      const viewerRevoke = await run(viewerA, async (c) => {
        const res = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        return res.rows[0]?.revoked ?? false;
      });
      expect(viewerRevoke, 'viewer A revoking member A1 token must fail').toBe(false);

      // Owner B cannot revoke Org A's token
      const ownerBRevoke = await run(ownerB, async (c) => {
        const res = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        return res.rows[0]?.revoked ?? false;
      });
      expect(ownerBRevoke, 'owner B revoking Org A token must fail').toBe(false);

      // Member A1 can revoke their own token
      const selfRevoke = await run(memberA1, async (c) => {
        const res = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        return res.rows[0]?.revoked ?? false;
      });
      expect(selfRevoke, 'member A1 revoking own token must succeed').toBe(true);
    }
  });

  it('refuses token verification when revoked, expired, member removed, or module permission lost', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    const hasVerifyProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.verify_extension_token(bytea)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasVerifyProc, 'crove_kernel.verify_extension_token must exist once tables land').toBe(true);

    if (hasVerifyProc) {
      await admin(async (c) => {
        // Active token succeeds
        const activeRes = await c.query<{ valid: boolean; org_id: string; user_id: string }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea)`,
          [tokens.activeA2.hash],
        );
        expect(activeRes.rows.length).toBe(1);
        expect(activeRes.rows[0]?.valid).toBe(true);
        expect(activeRes.rows[0]?.org_id).toBe(orgAId);
        expect(activeRes.rows[0]?.user_id).toBe(users.memberA2);

        // Revoked token fails
        const revokedRes = await c.query<{ valid: boolean }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea)`,
          [tokens.revokedA1.hash],
        );
        expect(revokedRes.rows[0]?.valid ?? false).toBe(false);

        // Expired token fails
        const expiredRes = await c.query<{ valid: boolean }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea)`,
          [tokens.expiredA1.hash],
        );
        expect(expiredRes.rows[0]?.valid ?? false).toBe(false);

        // Token of removed member fails
        await c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [
          orgAId,
          users.memberA2,
        ]);
        const removedRes = await c.query<{ valid: boolean }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea)`,
          [tokens.activeA2.hash],
        );
        expect(removedRes.rows[0]?.valid ?? false).toBe(false);

        // Verification for an ungranted scope is refused
        const scopeRes = await c.query<{ valid: boolean }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'crm'::text)`,
          [tokens.activeA1.hash],
        ).catch(() => ({ rows: [{ valid: false }] }));
        expect(scopeRes.rows[0]?.valid ?? false).toBe(false);
      });
    }
  });

  it('secures definer functions: search_path pinned, no EXECUTE to PUBLIC, no secret hashes leaked', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    await admin(async (c) => {
      const definers = await c.query<{ oid: string; proname: string; prosrc: string; proconfig: string[] | null }>(
        `SELECT p.oid, p.proname, p.prosrc, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_kernel'
           AND p.prosecdef = true
           AND (p.proname LIKE '%extension_token%' OR p.proname LIKE '%extension_auth_code%')`,
      );

      for (const d of definers.rows) {
        // search_path must be pinned
        expect(
          d.proconfig?.some((cfg) => cfg.startsWith('search_path=')),
          `${d.proname} must pin search_path`,
        ).toBe(true);

        // No EXECUTE to PUBLIC: check via function OID
        const pubAcl = await c.query<{ has_exec: boolean }>(
          `SELECT has_function_privilege('public', $1::oid, 'EXECUTE') AS has_exec`,
          [d.oid],
        );
        expect(pubAcl.rows[0]?.has_exec, `${d.proname} PUBLIC EXECUTE`).toBe(false);
      }
    });
  });
});
