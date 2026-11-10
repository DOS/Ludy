// SPDX-License-Identifier: AGPL-3.0-only
// Security properties of extension tokens and PKCE auth codes (issue #2582, ADR-0047, AI Meeting Notes plan M8) on PostgreSQL 17:
// - no login role (crove_app, crove_worker, crove_tenant, crove_definer_tenant, crove_auth_reader, crove_prober, crove_reporter, public)
//   and no org-chart agent context directly reads or writes crove_kernel.extension_token or crove_kernel.extension_auth_code (definer-only MACHINERY);
// - relforcerowsecurity is false on MACHINERY tables; table owner is migration installer/admin, never any runtime login role;
// - token_hash and code_hash are 32-byte SHA-256 digests (octet_length = 32), and extension tokens expire in at most 90 days;
// - PKCE authorization codes are single-use, short-lived (<= 10 min), code_challenge_method = 'S256', and bound to (org_id, user_id, code_challenge);
// - extension tokens are listed and revoked only by their owning member within that org; another member, owner/admin of
//   another org, viewer, agent, and system context cannot list or revoke them;
// - verify_extension_token(bytea, text) returns TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[]) or 0 rows;
//   fails immediately when revoked, expired, member removed, demoted to viewer, user disabled, or scope mismatch;
// - exchange_extension_auth_code(bytea, text, bytea, text) (the last argument is the id of the extension asking, from the Origin header, #2850) returns TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, code_id uuid);
//   a code is exchanged only by the extension id it was issued for; an unbound code, another id or a malformed id gets no row and the code is not spent;
//   issue_extension_auth_code(bytea, text, text, text[], text, text) requires that id; the older 5- and 3-argument forms no longer exist (step 2 of #2850, #2855);
//   neither raw auth code nor raw extension token is passed to SQL statements or query logs;
// - all 5 definers grant EXECUTE to crove_app only (crove_worker and all other roles refused);
// - agent_write_guard trigger is installed on both tables.
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
// The extension id the seeded codes are bound to (32 letters a to p), and another one (#2850).
const EXT_A = 'a'.repeat(32);
const EXT_B = 'b'.repeat(32);

const ALL_RUNTIME_ROLES = [
  'public',
  'crove_app',
  'crove_worker',
  'crove_tenant',
  'crove_definer_tenant',
  'crove_auth_reader',
  'crove_prober',
  'crove_reporter',
];

const EXPECTED_REFUSAL_SQLSTATES = new Set(['42501', 'P0001', '22023', '28000']);
function isExpectedRefusal(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    EXPECTED_REFUSAL_SQLSTATES.has((err as { code: string }).code)
  );
}

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
    // A member of org A kept only for the post-issuance eligibility probes of exchange_extension_auth_code (#2662): they demote, disable and remove
    // this member, so a probe that fails half way cannot leave memberA1, the member the other tests use, in a state they would fail on.
    probeA: '',
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
           ($5, $6, 'member'),
           ($1, $7, 'member')`,
        [orgAId, users.memberA1, users.memberA2, users.viewerA, orgBId, users.memberB1, users.probeA],
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
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
          [orgAId, authCodes.activeA1.id, users.memberA1, authCodes.activeA1.hash, authCodes.activeA1.challenge],
        );

        // Auth code 2: consumed for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at, consumed_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '2 minutes', now() + interval '3 minutes', now() - interval '1 minute')`,
          [orgAId, authCodes.consumedA1.id, users.memberA1, authCodes.consumedA1.hash, authCodes.consumedA1.challenge],
        );

        // Auth code 3: expired for memberA1 in Org A
        await c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Laptop Chrome', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '15 minutes', now() - interval '10 minutes')`,
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

        // RLS must be enabled and relforcerowsecurity must be false (P0-1)
        const rls = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; relowner: string }>(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_catalog.pg_get_userbyid(c.relowner) AS relowner
           FROM pg_class c
           WHERE c.oid = ('crove_kernel.' || $1)::regclass`,
          [tbl],
        );
        expect(rls.rows[0]?.relrowsecurity, `${tbl} relrowsecurity`).toBe(true);
        expect(rls.rows[0]?.relforcerowsecurity, `${tbl} relforcerowsecurity`).toBe(false);
        expect(ALL_RUNTIME_ROLES, `${tbl} relowner must not be a runtime login role`).not.toContain(rls.rows[0]?.relowner);

        // agent_write_guard trigger must be installed on both tables
        const guard = await c.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid = ('crove_kernel.' || $1)::regclass
               AND t.tgname = 'agent_write_guard'
               AND NOT t.tgisinternal
               AND t.tgenabled = 'O'
               AND t.tgfoid = 'crove_kernel.agent_write_guard()'::regprocedure
           ) AS exists`,
          [tbl],
        );
        expect(guard.rows[0]?.exists, `${tbl} must have agent_write_guard trigger installed`).toBe(true);

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

    const TARGET_TABLES = ['extension_token', 'extension_auth_code'];
    const TABLE_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const COLUMN_OPS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

    await admin(async (c) => {
      for (const tbl of TARGET_TABLES) {
        for (const role of ALL_RUNTIME_ROLES) {
          // Table-level privilege check
          for (const op of TABLE_OPS) {
            const priv = await c.query<{ has_priv: boolean }>(
              `SELECT has_table_privilege($1, ('crove_kernel.' || $2)::regclass, $3) AS has_priv`,
              [role, tbl, op],
            );
            expect(priv.rows[0]?.has_priv, `${role} must not have ${op} on ${tbl}`).toBe(false);
          }
          // Column-level privilege check
          for (const op of COLUMN_OPS) {
            const colPriv = await c.query<{ has_col_priv: boolean }>(
              `SELECT has_any_column_privilege($1, ('crove_kernel.' || $2)::regclass, $3) AS has_col_priv`,
              [role, tbl, op],
            );
            expect(colPriv.rows[0]?.has_col_priv, `${role} must not have column ${op} on ${tbl}`).toBe(false);
          }
        }
      }
    });

    // Verify direct SELECT/INSERT from crove_app and crove_worker fails with 42501
    const appClient = new pg.Client({ connectionString: appUrl });
    await appClient.connect();
    try {
      await expect(appClient.query('SELECT * FROM crove_kernel.extension_token')).rejects.toMatchObject({ code: '42501' });
      await expect(appClient.query('SELECT * FROM crove_kernel.extension_auth_code')).rejects.toMatchObject({ code: '42501' });
      await expect(
        appClient.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Probe', ARRAY['meetings'], now(), now() + interval '30 days', $3)`,
          [orgAId, randomUUID(), users.memberA1, randomBytes(32)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        appClient.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'ch', 'S256', ARRAY['meetings'], 'Probe', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
          [orgAId, randomUUID(), users.memberA1, randomBytes(32)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
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
    await expect(
      run(agentA, async (c) => {
        return await c.query('SELECT * FROM crove_kernel.extension_auth_code');
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
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, '\\x1234', 'challenge', 'S256', ARRAY['meetings'], 'Device', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
          [orgAId, randomUUID(), users.memberA1],
        ),
      ).rejects.toThrow();

      // 3. expires_at cannot exceed created_at + 90 days for tokens
      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'Overlong Expiry', ARRAY['meetings'], now(), now() + interval '91 days', $3)`,
          [orgAId, randomUUID(), users.memberA1, randomBytes(32)],
        ),
      ).rejects.toThrow();

      // 4. auth code CHECK constraints: code_challenge_method must be S256, expires_at <= created_at + 10 minutes
      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'challenge', 'plain', ARRAY['meetings'], 'Device', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
          [orgAId, randomUUID(), users.memberA1, randomBytes(32)],
        ),
      ).rejects.toThrow();

      await expect(
        c.query(
          `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'challenge', 'S256', ARRAY['meetings'], 'Device', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '11 minutes')`,
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
        `SELECT to_regprocedure('crove_kernel.exchange_extension_auth_code(bytea,text,bytea,text)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasExchangeProc, 'crove_kernel.exchange_extension_auth_code(bytea, text, bytea, text) must exist once tables land').toBe(true);

    if (hasExchangeProc) {
      // Call exchange as crove_app (appUrl)
      const appClient = new pg.Client({ connectionString: appUrl });
      await appClient.connect();
      try {
        const dummyTokenHash = randomBytes(32);

        const safeExchange = async (codeHash: Buffer, verifier: string, tokenHash: Buffer, extensionId: string | null = EXT_A) => {
          try {
            return await appClient.query<{ token_id: string; org_id: string; user_id: string; scopes: string[]; expires_at: Date }>(
              `SELECT * FROM crove_kernel.exchange_extension_auth_code($1, $2, $3, $4)`,
              [codeHash, verifier, tokenHash, extensionId],
            );
          } catch (e) {
            if (isExpectedRefusal(e)) return { rows: [] };
            throw e;
          }
        };

        // Exchange with wrong verifier fails (raises or returns 0 rows)
        const wrongVerifierRes = await safeExchange(authCodes.activeA1.hash, 'w'.repeat(43), dummyTokenHash);
        expect(wrongVerifierRes.rows.length, 'wrong verifier must fail').toBe(0);

        // Exchange with expired code fails
        const expiredRes = await safeExchange(authCodes.expiredA1.hash, authCodes.expiredA1.verifier, dummyTokenHash);
        expect(expiredRes.rows.length, 'expired code must fail').toBe(0);

        // Exchange with already consumed code fails
        const consumedRes = await safeExchange(authCodes.consumedA1.hash, authCodes.consumedA1.verifier, dummyTokenHash);
        expect(consumedRes.rows.length, 'already consumed code must fail').toBe(0);

        // Valid exchange succeeds with fresh token hash
        const newToken = makeToken();
        const res = await safeExchange(authCodes.activeA1.hash, authCodes.activeA1.verifier, newToken.hash);
        expect(res.rows.length).toBe(1);
        expect(res.rows[0]?.user_id).toBe(users.memberA1);
        expect(res.rows[0]?.org_id).toBe(orgAId);
        expect(res.rows[0]?.scopes).toEqual(['meetings']);

        // Re-exchange of the now-consumed code fails immediately (single-use enforced!)
        const replayRes = await safeExchange(authCodes.activeA1.hash, authCodes.activeA1.verifier, randomBytes(32));
        expect(replayRes.rows.length, 'replayed exchange must return 0 rows or throw').toBe(0);

        // A code is bound to the extension it was issued for (#2850, step 2 #2855): another id, a malformed id, no id and an unbound code all get no
        // row, and a refusal for the id does not spend the code or count a failed attempt, so the real extension can still use it.
        const boundCode = makeAuthCode();
        const unboundCode = makeAuthCode();
        await admin(async (c) => {
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Bound Test', $6, now(), now() + interval '5 minutes')`,
            [orgAId, boundCode.id, users.memberA1, boundCode.hash, boundCode.challenge, EXT_A],
          );
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Unbound Test', now(), now() + interval '5 minutes')`,
            [orgAId, unboundCode.id, users.memberA1, unboundCode.hash, unboundCode.challenge],
          );
        });
        for (const asking of [EXT_B, 'A'.repeat(32), 'c'.repeat(31), '', null]) {
          const refused = await safeExchange(boundCode.hash, boundCode.verifier, randomBytes(32), asking);
          expect(refused.rows.length, `a code for ${EXT_A} must not exchange for ${String(asking)}`).toBe(0);
        }
        for (const asking of [EXT_A, EXT_B, null]) {
          const refused = await safeExchange(unboundCode.hash, unboundCode.verifier, randomBytes(32), asking);
          expect(refused.rows.length, `an unbound code must not exchange for ${String(asking)}`).toBe(0);
        }
        await admin(async (c) => {
          const state = await c.query<{ id: string; consumed_at: Date | null; failed_attempts: number }>(
            `SELECT id, consumed_at, failed_attempts FROM crove_kernel.extension_auth_code WHERE id = ANY($1::uuid[])`,
            [[boundCode.id, unboundCode.id]],
          );
          expect(state.rows).toHaveLength(2);
          for (const row of state.rows) expect(row, 'a refused id must not spend the code').toMatchObject({ consumed_at: null, failed_attempts: 0 });
        });
        const boundOk = await safeExchange(boundCode.hash, boundCode.verifier, randomBytes(32), EXT_A);
        expect(boundOk.rows.length, 'the code of that id still exchanges, once').toBe(1);
        expect((await safeExchange(boundCode.hash, boundCode.verifier, randomBytes(32), EXT_A)).rows.length).toBe(0);

        // Newly exchanged token verifies immediately
        const verifyRes = await appClient.query<{ token_id: string }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1, 'meetings')`,
          [newToken.hash],
        );
        expect(verifyRes.rows.length).toBe(1);
        expect(verifyRes.rows[0]?.token_id).toBe(res.rows[0]?.token_id);

        // Post-issuance eligibility check on exchange: demoted, disabled, removed member (Round 2 item 4). Run on the dedicated member probeA (#2662), restored
        // after each probe, so a failure here leaves memberA1 and the tests after this one untouched.
        // A control first: the dedicated member is eligible as it stands, so each refusal below is the doing of its own change and not of a fixture
        // that could never exchange (a probe on a member that is refused anyway would pass for nothing).
        const controlCode = makeAuthCode();
        await admin(async (c) => {
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Probe Control', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
            [orgAId, controlCode.id, users.probeA, controlCode.hash, controlCode.challenge],
          );
        });
        const controlExchange = await safeExchange(controlCode.hash, controlCode.verifier, randomBytes(32));
        expect(controlExchange.rows.length, 'an eligible probe member must exchange').toBe(1);
        expect(controlExchange.rows[0]?.user_id).toBe(users.probeA);
        await admin(async (c) => {
          await c.query(`DELETE FROM crove_kernel.extension_token WHERE id = $1`, [controlExchange.rows[0]?.token_id]);
        });

        // (a) Demoted to 'viewer'
        const demoteCode = makeAuthCode();
        await admin(async (c) => {
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Demote Test', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
            [orgAId, demoteCode.id, users.probeA, demoteCode.hash, demoteCode.challenge],
          );
          await c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgAId, users.probeA]);
        });
        const demoteExchange = await safeExchange(demoteCode.hash, demoteCode.verifier, randomBytes(32));
        expect(demoteExchange.rows.length, 'exchange for demoted member must return 0 rows').toBe(0);
        await admin(async (c) => {
          const tokenRows = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt FROM crove_kernel.extension_token WHERE org_id = $1 AND user_id = $2 AND device_name = 'Demote Test'`,
            [orgAId, users.probeA],
          );
          expect(tokenRows.rows[0]?.cnt).toBe(0);
          await c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgAId, users.probeA]);
        });

        // (b) User account disabled
        const disabledCode = makeAuthCode();
        await admin(async (c) => {
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Disabled Test', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
            [orgAId, disabledCode.id, users.probeA, disabledCode.hash, disabledCode.challenge],
          );
          await c.query(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.probeA]);
        });
        const disabledExchange = await safeExchange(disabledCode.hash, disabledCode.verifier, randomBytes(32));
        expect(disabledExchange.rows.length, 'exchange for disabled user must return 0 rows').toBe(0);
        await admin(async (c) => {
          const tokenRows = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt FROM crove_kernel.extension_token WHERE org_id = $1 AND user_id = $2 AND device_name = 'Disabled Test'`,
            [orgAId, users.probeA],
          );
          expect(tokenRows.rows[0]?.cnt).toBe(0);
          await c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.probeA]);
        });

        // (c) Member removed from tenant_member
        const removedCode = makeAuthCode();
        await admin(async (c) => {
          await c.query(
            `INSERT INTO crove_kernel.extension_auth_code (org_id, id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY['meetings'], 'Removed Test', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() + interval '5 minutes')`,
            [orgAId, removedCode.id, users.probeA, removedCode.hash, removedCode.challenge],
          );
          await c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgAId, users.probeA]);
        });
        const removedExchange = await safeExchange(removedCode.hash, removedCode.verifier, randomBytes(32));
        expect(removedExchange.rows.length, 'exchange for removed member must return 0 rows').toBe(0);
        await admin(async (c) => {
          const tokenRows = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt FROM crove_kernel.extension_token WHERE org_id = $1 AND user_id = $2 AND device_name = 'Removed Test'`,
            [orgAId, users.probeA],
          );
          expect(tokenRows.rows[0]?.cnt).toBe(0);
          await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgAId, users.probeA]);
        });
      } finally {
        await appClient.end();
      }
    }

    // Verify issue_extension_auth_code definer access control (Round 2 item 3: pinned to_regprocedure)
    const hasIssueProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.issue_extension_auth_code(bytea,text,text,text[],text,text)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasIssueProc, 'crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text) must exist once tables land').toBe(true);

    if (hasIssueProc) {
      // Member A1 can issue an auth code
      const memberCode = makeAuthCode();
      const issueRes = await run(memberA1, async (c) => {
        return (
          await c.query<{ id: string }>(
            `SELECT crove_kernel.issue_extension_auth_code($1, $2, 'S256', ARRAY['meetings'], 'Device A1', $3) AS id`,
            [memberCode.hash, memberCode.challenge, EXT_A],
          )
        ).rows[0];
      });
      expect(issueRes?.id).toBeDefined();

      // Viewer A cannot issue an auth code
      const viewerCode = makeAuthCode();
      await expect(
        run(viewerA, async (c) => {
          return await c.query(
            `SELECT crove_kernel.issue_extension_auth_code($1, $2, 'S256', ARRAY['meetings'], 'Device Viewer', $3) AS id`,
            [viewerCode.hash, viewerCode.challenge, EXT_A],
          );
        }),
      ).rejects.toSatisfy((e) => isExpectedRefusal(e));

      // System context and agent context cannot issue auth codes
      await expect(
        run(systemA, async (c) => {
          return await c.query(
            `SELECT crove_kernel.issue_extension_auth_code($1, $2, 'S256', ARRAY['meetings'], 'Device Sys', $3) AS id`,
            [viewerCode.hash, viewerCode.challenge, EXT_A],
          );
        }),
      ).rejects.toSatisfy((e) => isExpectedRefusal(e));

      await expect(
        run(agentA, async (c) => {
          return await c.query(
            `SELECT crove_kernel.issue_extension_auth_code($1, $2, 'S256', ARRAY['meetings'], 'Device Agent', $3) AS id`,
            [viewerCode.hash, viewerCode.challenge, EXT_A],
          );
        }),
      ).rejects.toSatisfy((e) => isExpectedRefusal(e));
    }
  });

  it('refuses the owner and admin device routines once the org is no longer active (#2868)', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }
    // The context is entered while the org is active, then the org is closed inside the same rolled-back transaction: what is left
    // to refuse is the routine itself, as it is for issuing a code. Entered as the owner of org A, from the admin connection. The close
    // is run outside the refusal path and must change exactly one row, so a refused or empty UPDATE cannot make the test pass; only the
    // routine's own error is caught, and it must be EXTENSION_FORBIDDEN.
    const afterClose = (statement: string, params: unknown[] = []) =>
      inContext(adminUrl, ownerA.enter, async (c) => {
        const before = await c.query('SELECT * FROM crove_kernel.list_extension_tokens_for_org()');
        expect(before.rows.length, 'the owner of an active org reads the list').toBeGreaterThan(0);
        const close = await c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [orgAId]);
        const error = await c.query(statement, params).then(
          () => null,
          (e: unknown) => e,
        );
        return { closedRows: close.rowCount, error };
      });
    for (const [what, statement, params] of [
      ['list_extension_tokens_for_org', 'SELECT * FROM crove_kernel.list_extension_tokens_for_org()', []],
      ['revoke_extension_token_as_admin', 'SELECT crove_kernel.revoke_extension_token_as_admin($1::uuid)', [randomUUID()]],
    ] as const) {
      const { closedRows, error } = await afterClose(statement, [...params]);
      expect(closedRows, `closing the org changes exactly one tenant row before ${what} runs`).toBe(1);
      expect(error, `${what} must refuse a closed org`).toMatchObject({ code: '42501', message: expect.stringContaining('EXTENSION_FORBIDDEN') });
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

      // Viewer A cannot list tokens (Round 2 item 2: catch isExpectedRefusal only)
      const viewerTokens = await run(viewerA, async (c) => {
        try {
          return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
        } catch (e) {
          if (isExpectedRefusal(e)) return [];
          throw e;
        }
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

      // System context and agent context cannot list member tokens (connects as crove_worker, expected 42501 refusal)
      const sysTokens = await run(systemA, async (c) => {
        try {
          return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
        } catch (e) {
          if (isExpectedRefusal(e)) return [];
          throw e;
        }
      });
      expect(sysTokens).toEqual([]);

      const agentTokens = await run(agentA, async (c) => {
        try {
          return (await c.query(`SELECT * FROM crove_kernel.list_extension_tokens()`)).rows;
        } catch (e) {
          if (isExpectedRefusal(e)) return [];
          throw e;
        }
      });
      expect(agentTokens).toEqual([]);

      // Probe context-requiring definers on crove_app outside any user context (Round 2 item 2)
      const unenteredClient = new pg.Client({ connectionString: appUrl });
      await unenteredClient.connect();
      try {
        const dummyCode = makeAuthCode();
        const unenteredIssue = await unenteredClient
          .query(`SELECT crove_kernel.issue_extension_auth_code($1, $2, 'S256', ARRAY['meetings'], 'Probe', $3)`, [dummyCode.hash, dummyCode.challenge, EXT_A])
          .then((r) => r.rows)
          .catch((e) => {
            if (isExpectedRefusal(e)) return [];
            throw e;
          });
        expect(unenteredIssue).toEqual([]);

        const unenteredList = await unenteredClient
          .query(`SELECT * FROM crove_kernel.list_extension_tokens()`)
          .then((r) => r.rows)
          .catch((e) => {
            if (isExpectedRefusal(e)) return [];
            throw e;
          });
        expect(unenteredList).toEqual([]);

        const unenteredRevoke = await unenteredClient
          .query<{ revoked: boolean }>(`SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`, [randomUUID()])
          .then((r) => r.rows[0]?.revoked ?? false)
          .catch((e) => {
            if (isExpectedRefusal(e)) return false;
            throw e;
          });
        expect(unenteredRevoke).toBe(false);
      } finally {
        await unenteredClient.end();
      }
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
      const safeRevoke = async (actor: Actor, tokenId: string) => {
        return await run(actor, async (c) => {
          try {
            const res = await c.query<{ revoked: boolean }>(
              `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
              [tokenId],
            );
            return res.rows[0]?.revoked ?? false;
          } catch (e) {
            if (isExpectedRefusal(e)) return false;
            throw e;
          }
        });
      };

      // Member A2 cannot revoke Member A1's token
      expect(await safeRevoke(memberA2, tokens.activeA1.id), 'member A2 revoking member A1 token must fail').toBe(false);

      // Member B1 cannot revoke Org A's token
      expect(await safeRevoke(memberB1, tokens.activeA1.id), 'member B1 revoking Org A token must fail').toBe(false);

      // Viewer A cannot revoke Member A1's token
      expect(await safeRevoke(viewerA, tokens.activeA1.id), 'viewer A revoking member A1 token must fail').toBe(false);

      // Owner A cannot revoke Member A1's token (only token owner may revoke)
      expect(await safeRevoke(ownerA, tokens.activeA1.id), 'owner A revoking member A1 token must fail').toBe(false);

      // Owner B cannot revoke Org A's token
      expect(await safeRevoke(ownerB, tokens.activeA1.id), 'owner B revoking Org A token must fail').toBe(false);

      // System context cannot revoke member token
      expect(await safeRevoke(systemA, tokens.activeA1.id), 'system context revoking member token must fail').toBe(false);

      // Agent context cannot revoke member token
      expect(await safeRevoke(agentA, tokens.activeA1.id), 'agent context revoking member token must fail').toBe(false);

      // The eligibility steps of the exchange test demoted, disabled and removed member A1. Whether that voided the token
      // (revoked_at set, #2740 step 2) or only suspended it (step 1), this step needs it live: make it so for both.
      await admin(async (c) => {
        await c.query(`UPDATE crove_kernel.extension_token SET revoked_at = NULL WHERE org_id = $1 AND id = $2`, [orgAId, tokens.activeA1.id]);
      });

      // Member A1 can revoke their own token: assert persistence inside transaction (P1-4)
      await run(memberA1, async (c) => {
        const selfRevoke = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        expect(selfRevoke.rows[0]?.revoked, 'member A1 revoking own token must succeed').toBe(true);

        // Verification immediately fails
        const verifyRes = await c.query(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
          [tokens.activeA1.hash],
        );
        expect(verifyRes.rows.length, 'token must fail verification immediately upon revocation').toBe(0);

        // list_extension_tokens shows revoked_at is not null
        const listRes = await c.query<{ id: string; revoked_at: string | null }>(
          `SELECT id, revoked_at FROM crove_kernel.list_extension_tokens() WHERE id = $1`,
          [tokens.activeA1.id],
        );
        expect(listRes.rows[0]?.revoked_at, 'revoked_at must be populated').not.toBeNull();

        // Revoking a second time does not un-revoke or return true for active token
        const secondRevoke = await c.query<{ revoked: boolean }>(
          `SELECT crove_kernel.revoke_extension_token($1::uuid) AS revoked`,
          [tokens.activeA1.id],
        );
        expect(secondRevoke.rows[0]?.revoked, 'second revoke on already revoked token must return false').toBe(false);
      });
    }
  });

  it('refuses token verification when revoked, expired, member removed, demoted to viewer, or user disabled', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }

    const hasVerifyProc = await admin(async (c) => {
      const res = await c.query<{ exists: boolean }>(
        `SELECT to_regprocedure('crove_kernel.verify_extension_token(bytea,text)') IS NOT NULL AS exists`,
      );
      return res.rows[0]?.exists === true;
    });
    expect(hasVerifyProc, 'crove_kernel.verify_extension_token(bytea, text) must exist once tables land').toBe(true);

    if (hasVerifyProc) {
      // Must run verification as crove_app (appUrl)
      const appClient = new pg.Client({ connectionString: appUrl });
      await appClient.connect();
      try {
        // Active token with matching scope succeeds
        const activeRes = await appClient.query<{ token_id: string; org_id: string; user_id: string; scopes: string[] }>(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
          [tokens.activeA2.hash],
        );
        expect(activeRes.rows.length).toBe(1);
        expect(activeRes.rows[0]?.token_id).toBe(tokens.activeA2.id);
        expect(activeRes.rows[0]?.org_id).toBe(orgAId);
        expect(activeRes.rows[0]?.user_id).toBe(users.memberA2);
        expect(activeRes.rows[0]?.scopes).toEqual(['meetings']);

        // Verification for ungranted scope returns 0 rows without throwing (CodeRabbit thread PRRT_kwDOT_fCws60WAoV)
        const ungrantedScopeRes = await appClient.query(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'crm'::text)`,
          [tokens.activeA2.hash],
        );
        expect(ungrantedScopeRes.rows.length, 'ungranted scope must return 0 rows').toBe(0);

        // Revoked token fails (returns 0 rows)
        const revokedRes = await appClient.query(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
          [tokens.revokedA1.hash],
        );
        expect(revokedRes.rows.length, 'revoked token must return 0 rows').toBe(0);

        // Expired token fails (returns 0 rows)
        const expiredRes = await appClient.query(
          `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
          [tokens.expiredA1.hash],
        );
        expect(expiredRes.rows.length, 'expired token must return 0 rows').toBe(0);

        // P1-3: Test real post-issuance permission/eligibility loss
        await admin(async (c) => {
          // (a) Demoting member from 'member' to 'viewer' immediately causes verify_extension_token to return 0 rows
          await c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [
            orgAId,
            users.memberA2,
          ]);
          const viewerVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [tokens.activeA2.hash],
          );
          expect(viewerVerify.rows.length, 'demoted member token must return 0 rows').toBe(0);

          // Restore member role
          await c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [
            orgAId,
            users.memberA2,
          ]);
          const restoredVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [tokens.activeA2.hash],
          );
          // Step 2 of #2740: the demotion voided the token for good (revoked_at is set), so restoring the role does not revive it.
          expect(restoredVerify.rows.length, 'restored member token must stay refused').toBe(0);

          // The disable step needs its own live token: the demotion above already voided activeA2, so testing it again
          // would pass even without a trigger on user_account.
          const disableToken = makeToken();
          await c.query(
            `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
             VALUES ($1, $2, $3, $4, 'Disable step', ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
            [orgAId, disableToken.id, users.memberA2, disableToken.hash],
          );
          const liveVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [disableToken.hash],
          );
          expect(liveVerify.rows.length, 'the fresh token is live before the user is disabled').toBe(1);

          // (b) Setting user_account.disabled_at = now() immediately causes verify_extension_token to return 0 rows
          await c.query(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.memberA2]);
          const disabledVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [disableToken.hash],
          );
          expect(disabledVerify.rows.length, 'disabled user token must return 0 rows').toBe(0);

          // Restore active user
          await c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.memberA2]);
          const enabledVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [disableToken.hash],
          );
          // Step 2 of #2740: disabling voided the token for good, so re-enabling the user does not revive it.
          expect(enabledVerify.rows.length, 're-enabled user token must stay refused').toBe(0);
          const disabledRow = await c.query(`SELECT revoked_at FROM crove_kernel.extension_token WHERE id = $1`, [disableToken.id]);
          expect(disabledRow.rows[0]?.revoked_at, 'disabling the user voids the token for good').not.toBeNull();

          // (c) Removing member from tenant_member succeeds without FK restrict error and causes verify to return 0 rows.
          // A live token again, so the removal itself is what the assertions test.
          const removalToken = makeToken();
          await c.query(
            `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
             VALUES ($1, $2, $3, $4, 'Removal step', ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
            [orgAId, removalToken.id, users.memberA2, removalToken.hash],
          );
          const removalLive = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [removalToken.hash],
          );
          expect(removalLive.rows.length, 'the fresh token is live before the member is removed').toBe(1);
          await c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [
            orgAId,
            users.memberA2,
          ]);
          const removalRow = await c.query(`SELECT revoked_at FROM crove_kernel.extension_token WHERE id = $1`, [removalToken.id]);
          expect(removalRow.rows[0]?.revoked_at, 'removing the member voids the token and records it').not.toBeNull();
          const removedVerify = await appClient.query(
            `SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`,
            [removalToken.hash],
          );
          expect(removedVerify.rows.length, 'removed member token must return 0 rows').toBe(0);
        });
      } finally {
        await appClient.end();
      }
    }
  });

  it('secures definer functions: search_path pinned, no EXECUTE to PUBLIC, no secret hashes leaked, EXECUTE matrix correct', async () => {
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

      // P2-1: Must have at least 5 definers (exchange, issue, list, revoke, verify)
      expect(definers.rows.length, 'at least 5 extension definer functions expected').toBeGreaterThanOrEqual(5);

      for (const d of definers.rows) {
        // search_path must be pinned to pg_catalog, pg_temp
        expect(
          d.proconfig,
          `${d.proname} must pin search_path to pg_catalog, pg_temp`,
        ).toContain('search_path=pg_catalog, pg_temp');

        // Function return type must not leak token_hash or code_hash
        const returnType = await c.query<{ rettype: string }>(
          `SELECT pg_get_function_result($1::oid) AS rettype`,
          [d.oid],
        );
        expect(returnType.rows[0]?.rettype, `${d.proname} return type must not leak token_hash`).not.toContain('token_hash');
        expect(returnType.rows[0]?.rettype, `${d.proname} return type must not leak code_hash`).not.toContain('code_hash');

        // No EXECUTE to PUBLIC: check via function OID
        const pubAcl = await c.query<{ has_exec: boolean }>(
          `SELECT has_function_privilege('public', $1::oid, 'EXECUTE') AS has_exec`,
          [d.oid],
        );
        expect(pubAcl.rows[0]?.has_exec, `${d.proname} PUBLIC EXECUTE must be false`).toBe(false);
      }

      // Step 2 of #2850 (#2855): only the id-bound definers exist; the 5-argument issue and the 3-argument exchange are dropped.
      const pinned = await c.query<{ issue6: string | null; exchange4: string | null; issue5: string | null; exchange3: string | null }>(
        `SELECT to_regprocedure('crove_kernel.issue_extension_auth_code(bytea,text,text,text[],text,text)')::text AS issue6,
                to_regprocedure('crove_kernel.exchange_extension_auth_code(bytea,text,bytea,text)')::text AS exchange4,
                to_regprocedure('crove_kernel.issue_extension_auth_code(bytea,text,text,text[],text)')::text AS issue5,
                to_regprocedure('crove_kernel.exchange_extension_auth_code(bytea,text,bytea)')::text AS exchange3`,
      );
      expect(pinned.rows[0]?.issue6).not.toBeNull();
      expect(pinned.rows[0]?.exchange4).not.toBeNull();
      expect(pinned.rows[0]?.issue5, 'the unbound issue must be gone').toBeNull();
      expect(pinned.rows[0]?.exchange3, 'the unbound exchange must be gone').toBeNull();
      expect(definers.rows.filter((d) => d.proname === 'issue_extension_auth_code' || d.proname === 'exchange_extension_auth_code')).toHaveLength(2);

      // Enforce EXECUTE matrix on ALL 5 definers: crove_app = true, all other runtime roles = false (Round 2 item 2)
      for (const d of definers.rows) {
        // crove_app has EXECUTE
        const appExec = await c.query<{ has_exec: boolean }>(
          `SELECT has_function_privilege('crove_app', $1::oid, 'EXECUTE') AS has_exec`,
          [d.oid],
        );
        expect(appExec.rows[0]?.has_exec, `${d.proname} crove_app EXECUTE must be true`).toBe(true);

        // Other runtime roles do NOT have EXECUTE
        for (const role of ['public', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter']) {
          const roleExec = await c.query<{ has_exec: boolean }>(
            `SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS has_exec`,
            [role, d.oid],
          );
          expect(roleExec.rows[0]?.has_exec, `${d.proname} ${role} EXECUTE must be false`).toBe(false);
        }
      }
    });
  });
  it('lets no login role or agent run the internal ext_device_* routines (they are named outside the definer pattern above)', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }
    await admin(async (c) => {
      const routines = await c.query<{ oid: string; proname: string }>(
        `SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'ext\\_device\\_%'`,
      );
      // The routines exist once the lifecycle migration has run; before it there is nothing to check.
      for (const r of routines.rows) {
        for (const role of ['public', 'crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter']) {
          const exec = await c.query<{ has_exec: boolean }>(`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS has_exec`, [role, r.oid]);
          expect(exec.rows[0]?.has_exec, `${r.proname} ${role} EXECUTE must be false`).toBe(false);
        }
        const pinned = await c.query<{ proconfig: string[] | null }>(`SELECT proconfig FROM pg_proc WHERE oid = $1::oid`, [r.oid]);
        expect(pinned.rows[0]?.proconfig, `${r.proname} must pin search_path`).toContain('search_path=pg_catalog, pg_temp');
      }
    });
  });

  it('voids, once, the tokens whose member was already disabled or already a viewer before the lifecycle migration, and keeps them void after a restore', async () => {
    if (!tables.extension_token) {
      expect(tables.extension_token).toBe(false);
      return;
    }
    const hasBackfill = await admin(async (c) => (await c.query(`SELECT to_regprocedure('crove_kernel.ext_device_backfill_suspended()') IS NOT NULL AS ok`)).rows[0]?.ok === true);
    expect(hasBackfill, 'the lifecycle migration adds ext_device_backfill_suspended()').toBe(true);
    const viewerToken = makeToken();
    const disabledToken = makeToken();
    const insertToken = (c: pg.Client, orgId: string, userId: string, t: ReturnType<typeof makeToken>, name: string) =>
      c.query(
        `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, ARRAY['meetings'], now(), now() + interval '90 days', $3)`,
        [orgId, t.id, userId, t.hash, name],
      );
    const verify = (hash: Buffer) => admin(async (c) => (await c.query(`SELECT * FROM crove_kernel.verify_extension_token($1::bytea, 'meetings'::text)`, [hash])).rows.length);
    await admin(async (c) => {
      // The state before the migration: a token of a member who is a viewer, and one of a disabled user, both still unrevoked
      // (a demotion or a disable only suspended them). A token is inserted for the viewer as it stands; the disable is made with
      // the trigger off, as it was made before the trigger existed.
      await insertToken(c, orgAId, users.viewerA, viewerToken, 'Viewer before');
      await insertToken(c, orgBId, users.memberB1, disabledToken, 'Disabled before');
      await c.query('ALTER TABLE crove_kernel.user_account DISABLE TRIGGER user_account_voids_extension_tokens');
      try {
        await c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.memberB1]);
      } finally {
        await c.query('ALTER TABLE crove_kernel.user_account ENABLE TRIGGER user_account_voids_extension_tokens');
      }
    });
    // Suspended, not void: refused today, but unrevoked.
    expect(await verify(viewerToken.hash)).toBe(0);
    expect(await verify(disabledToken.hash)).toBe(0);
    const unrevoked = await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.extension_token WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL', [[viewerToken.id, disabledToken.id]])).rows[0].n as number);
    expect(unrevoked).toBe(2);

    const voided = await admin(async (c) => (await c.query<{ n: number }>('SELECT crove_kernel.ext_device_backfill_suspended() AS n')).rows[0]!.n);
    expect(voided).toBeGreaterThanOrEqual(2);
    const rows = await admin(async (c) => (await c.query('SELECT id, revoked_at FROM crove_kernel.extension_token WHERE id = ANY($1::uuid[])', [[viewerToken.id, disabledToken.id]])).rows as Array<{ id: string; revoked_at: Date | null }>);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    const audit = await admin(async (c) => (await c.query(`SELECT target_id, detail FROM crove_kernel.audit_event WHERE command = 'kernel.extension.token.auto_revoked' AND target_id = ANY($1::uuid[])`, [[viewerToken.id, disabledToken.id]])).rows as Array<{ target_id: string; detail: Record<string, unknown> }>);
    expect(audit).toHaveLength(2);
    expect(audit.find((a) => a.target_id === viewerToken.id)?.detail).toEqual({ tokenId: viewerToken.id, userId: users.viewerA, reason: 'role_change' });
    expect(audit.find((a) => a.target_id === disabledToken.id)?.detail).toEqual({ tokenId: disabledToken.id, userId: users.memberB1, reason: 'user_disabled' });

    // Restoring the role and the account does not bring either back.
    await admin(async (c) => {
      await c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgAId, users.viewerA]);
      await c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.memberB1]);
    });
    expect(await verify(viewerToken.hash), 'a token suspended before the migration stays void after the role is restored').toBe(0);
    expect(await verify(disabledToken.hash), 'a token suspended before the migration stays void after the account is re-enabled').toBe(0);
    // Idempotent: a second run finds nothing live to void for these two.
    await admin(async (c) => {
      await c.query('SELECT crove_kernel.ext_device_backfill_suspended()');
    });
    const after = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE command = 'kernel.extension.token.auto_revoked' AND target_id = ANY($1::uuid[])`, [[viewerToken.id, disabledToken.id]])).rows[0].n as number);
    expect(after).toBe(2);
  });
});
