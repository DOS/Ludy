// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7, #4225, parent #4203): access-isolation, role grants, sealed-context bounds,
// raw-body confinement, generation-bound rejection, full-batch claim past inactive hooks, and escaped-JSON
// personal-data erasure for bank feed hooks.
// Self-contained under apps/kernel/test/invariant/ (AGENTS.md Protected paths).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bankFeedHostedProviders, vietnamStamp, type BankFeedProvider } from '@ludy/bank-feed';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, parseVaultKey, Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { acceptBankFeedHook, claimBankFeedHookBatch, claimBankFeedHookNotices, rejectBankFeedHook } from '../../src/bank-feed-hook.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { JOB_SCHEMA, QUEUES } from '../../src/jobs-schema.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { relayBankFeedHookBatch } from '../../src/worker.ts';
import { contextToken } from './fixtures/context-token.ts';
import {
  auditRoleFunctionExecute,
  auditRoleTablePrivileges,
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Independent Tingee HMAC-SHA512 vector generator so invariant tests do not reuse the package signer under test.
const tingeeHmac = (secret: string, timestamp: string, body: string) =>
  createHmac('sha512', secret).update(`${timestamp}:${body}`, 'utf8').digest('hex');
const tingee = bankFeedHostedProviders({ tingee: true, uat: false }).bank_tingee as BankFeedProvider;
const CANARY = 'invariant-bank-hook-canary-7c2f4a19-do-not-keep';
const SIG = 'f'.repeat(128);

const makeBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ clientId: 'bank-hook-inv', content: CANARY, ...extra });

const freshHeaders = (requestId: string) => ({
  'content-type': 'application/json',
  'x-request-id': requestId,
  'x-request-timestamp': vietnamStamp(new Date(), true),
  'x-signature': SIG,
});

const DEFINERS: ReadonlyArray<{ sig: string; roles: readonly string[] }> = [
  { sig: 'crove_finance.bank_feed_hook_lookup(text,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.bank_feed_hook_put_notice(uuid,text,text,text,text,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.bank_feed_hook_set(uuid,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.bank_feed_hook_status(uuid)', roles: ['crove_app'] },
  { sig: 'crove_finance.personal_data_erase_bank_feed_notice(text,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.bank_feed_hook_sweep()', roles: ['crove_worker'] },
  { sig: 'crove_finance.bank_feed_hook_claim(integer)', roles: ['crove_worker'] },
  { sig: 'crove_finance.bank_feed_hook_reject(uuid,integer)', roles: ['crove_worker'] },
  { sig: 'crove_finance.bank_feed_hook_reject(uuid)', roles: ['crove_worker'] },
  { sig: 'crove_finance.bank_feed_hook_rotate_guard()', roles: [] },
  { sig: 'crove_finance.bank_feed_hook_rotate_cleanup()', roles: [] },
  { sig: 'crove_finance.bank_feed_webhook_backlog_on_insert()', roles: [] },
  { sig: 'crove_finance.bank_feed_webhook_backlog_on_delete()', roles: [] },
  { sig: 'crove_finance.bank_feed_webhook_backlog_on_truncate()', roles: [] },
];

const HELPERS: ReadonlyArray<{ sig: string; roles: readonly string[] }> = [
  { sig: 'crove_finance.bank_feed_notice_decode_escapes(text)', roles: [] },
  { sig: 'crove_finance.bank_feed_is_deep_json(text)', roles: [] },
  { sig: 'crove_finance.bank_feed_notice_search_text(text)', roles: [] },
];

suite('bank feed hook security invariants (#4225)', () => {
  const dbName = `ludy_test_bf_hook_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let workerUrl = '';
  let appDb: Db;
  let workerDb: Db;
  let apiRuntime: Runtime;
  let workerRuntime: Runtime;

  const users = { owner: '', admin: '', member: '', outsider: '' };
  let orgId = '';
  let otherOrgId = '';
  let connAId = '';
  let connBId = '';
  let otherConnId = '';
  let hookAId = '';
  let otherHookId = '';
  let inflightHookId = '';
  let inflightStoppedResult: boolean | undefined;
  const keyA = randomBytes(16).toString('base64url');
  const keyB = randomBytes(16).toString('base64url');
  const otherKey = randomBytes(16).toString('base64url');

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function withSealedApp<T extends pg.QueryResultRow = Record<string, unknown>>(
    userId: string,
    targetOrg: string,
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [targetOrg, contextToken(userId, targetOrg)]);
      const res = await client.query<T>(text, values);
      await client.query('COMMIT');
      return res.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function connectBankFeed(targetOrg: string, by: string) {
    const channelId = randomUUID();
    await withAdmin((c) =>
      c.query(
        "INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'bank_tingee', $3, 'Tingee invariant', $4)",
        [targetOrg, channelId, `tingee-${randomUUID().slice(0, 8)}`, by],
      ),
    );
    return channelId;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    const preRoot = mkdtempSync(join(tmpdir(), 'ludy-4225-inv-pre-'));
    const preDir = join(preRoot, 'migrations');
    const preVariantsDir = join(preRoot, 'shared-variants');
    try {
      mkdirSync(preDir);
      mkdirSync(preVariantsDir);
      const migrationNames = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
      const cutFile = migrationNames.find((n) => n.endsWith('_ludy_finance_bank_feed_hook_followups.sql'));
      expect(cutFile).toBeTruthy();
      const keptMigrations = new Set<string>();
      for (const name of migrationNames) {
        if (name < cutFile!) {
          symlinkSync(join(MIGRATIONS, name), join(preDir, name));
          keptMigrations.add(name);
        }
      }
      const variantsSource = fileURLToPath(new URL('../../../../supabase/shared-variants', import.meta.url));
      if (existsSync(variantsSource)) {
        for (const name of readdirSync(variantsSource)) {
          if (keptMigrations.has(name)) symlinkSync(join(variantsSource, name), join(preVariantsDir, name));
        }
      }
      await migrate({ adminUrl, dir: preDir, sharedVariantsDir: preVariantsDir });
      dbIds = await resolveDbIdentifiers(adminUrl);
      await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

      const loginUrl = (username: string, password: string) => {
        const url = new URL(adminUrl);
        url.username = dbIds ? dbIds.roleName(username) : username;
        url.password = password;
        return url.toString();
      };
      workerUrl = loginUrl('crove_worker', 'test-worker-pw');
      appPool = createDbPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 }, dbIds);
      workerPool = createDbPool({ connectionString: workerUrl, max: 2 }, dbIds);
      appDb = createDb(appPool);
      workerDb = createDb(workerPool);
      const registered = {
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      };
      apiRuntime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registered);
      workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);

      for (const role of Object.keys(users) as Array<keyof typeof users>) {
        users[role] = await upsertIdentity(appDb, {
          issuer: 'test',
          subject: `bf-hook-inv-${role}-${randomUUID()}`,
          email: `bf-hook-inv-${role}@example.test`,
          name: null,
        });
      }
      orgId = (await createOrg(apiRuntime, asUser(users.owner), 'Công ty invariant bank hook')).orgId;
      otherOrgId = (await createOrg(apiRuntime, asUser(users.outsider), 'Công ty khác bank hook')).orgId;
      await withAdmin((c) =>
        c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [
          orgId,
          users.admin,
          users.member,
        ]),
      );

      // Seed a rotated hook at 9 post-rotation rejections and verify with two DB connections that an in-flight
      // pre-migration bank_feed_hook_reject(uuid) queued behind ACCESS EXCLUSIVE cannot push it to 10/stopped.
      const inflightConnId = await connectBankFeed(otherOrgId, users.outsider);
      await withSealedApp(users.outsider, otherOrgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [
        inflightConnId,
        sha(randomBytes(16).toString('base64url')),
      ]);
      inflightHookId =
        (
          await withAdmin((c) =>
            c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE channel_connection_id = $1', [inflightConnId]),
          )
        ).rows[0]?.id ?? '';
      await withSealedApp(users.outsider, otherOrgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [
        inflightConnId,
        sha(randomBytes(16).toString('base64url')),
      ]);
      for (let i = 0; i < 9; i++) {
        expect(
          (await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [inflightHookId])).rows[0]
            ?.stopped,
        ).toBe(false);
      }

      const followupsSql = readFileSync(join(MIGRATIONS, cutFile!), 'utf8');
      const migratorConn = new pg.Client({ connectionString: adminUrl });
      const workerConn = new pg.Client({ connectionString: workerUrl });
      await migratorConn.connect();
      await workerConn.connect();
      try {
        await migratorConn.query('BEGIN');
        await migratorConn.query(`LOCK TABLE ${dbIds.table('crove_finance.bank_feed_hook')} IN ACCESS EXCLUSIVE MODE`);
        const inflightRejectPromise = workerConn.query<{ stopped: boolean }>(
          `SELECT ${dbIds.table('crove_finance.bank_feed_hook_reject')}($1::uuid) AS stopped`,
          [inflightHookId],
        );
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const seen = await withAdmin((c) =>
            c.query<{ waiting: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%bank_feed_hook_reject%') AS waiting",
            ),
          );
          if (seen.rows[0]?.waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await migratorConn.query(followupsSql);
        await migratorConn.query('COMMIT');
        inflightStoppedResult = (await inflightRejectPromise).rows[0]?.stopped;
      } finally {
        await migratorConn.query('ROLLBACK').catch(() => {});
        await migratorConn.end().catch(() => {});
        await workerConn.end().catch(() => {});
      }

      await migrate({ adminUrl, dir: MIGRATIONS });
      dbIds = await resolveDbIdentifiers(adminUrl);
    } finally {
      rmSync(preRoot, { recursive: true, force: true });
    }

    connAId = await connectBankFeed(orgId, users.owner);
    connBId = await connectBankFeed(orgId, users.owner);
    otherConnId = await connectBankFeed(otherOrgId, users.outsider);

    await withAdmin(async (c) => {
      hookAId =
        (
          await c.query<{ id: string }>(
            'INSERT INTO crove_finance.bank_feed_hook (org_id, channel_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id',
            [orgId, connAId, sha(keyA)],
          )
        ).rows[0]?.id ?? '';
      await c.query(
        'INSERT INTO crove_finance.bank_feed_hook (org_id, channel_connection_id, key_sha256) VALUES ($1, $2, $3)',
        [orgId, connBId, sha(keyB)],
      );
      otherHookId =
        (
          await c.query<{ id: string }>(
            'INSERT INTO crove_finance.bank_feed_hook (org_id, channel_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id',
            [otherOrgId, otherConnId, sha(otherKey)],
          )
        ).rows[0]?.id ?? '';
    });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps bank_feed_hook, bank_feed_webhook_notice, and bank_feed_webhook_backlog definer-only with RLS, zero grants, unique lookup indexes, and rotation guard', async () => {
    await withAdmin(async (c) => {
      for (const table of ['crove_finance.bank_feed_hook', 'crove_finance.bank_feed_webhook_notice', 'crove_finance.bank_feed_webhook_backlog']) {
        const reg = dbIds!.table(table);
        const rls = await c.query<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass($1)', [reg]);
        expect(rls.rows, table).toEqual([{ on: true }]);

        const tableAcl = await c.query<{ grantee: string; privilege_type: string }>(
          `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type
             FROM pg_catalog.pg_class c
             CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
             LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
            WHERE c.oid = pg_catalog.to_regclass($1)
              AND a.grantee <> c.relowner
            ORDER BY 1, 2`,
          [reg],
        );
        expect(tableAcl.rows, table).toEqual([]);

        const privs = await auditRoleTablePrivileges(
          c,
          dbIds,
          table,
          ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
          'non_system',
        );
        expect(privs.length, table).toBeGreaterThan(0);
        expect(privs.filter((row) => row.ok), table).toEqual([]);

        const colAcl = await c.query<{ attname: string; grantee: string; privilege_type: string }>(
          `SELECT a.attname, COALESCE(r.rolname, 'PUBLIC') AS grantee, acl.privilege_type
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
             CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
             LEFT JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
            WHERE c.oid = pg_catalog.to_regclass($1)
              AND a.attnum > 0
              AND NOT a.attisdropped
              AND a.attacl IS NOT NULL
              AND acl.grantee <> c.relowner
            ORDER BY 1, 2, 3`,
          [reg],
        );
        expect(colAcl.rows, table).toEqual([]);

        const colPrivs = await c.query<{ rolname: string; privilege: string }>(
          `SELECT r.rolname, p AS privilege
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_roles r ON r.oid <> c.relowner
             CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
            WHERE c.oid = pg_catalog.to_regclass($1)
              AND r.rolname !~ '^pg_'
              AND NOT r.rolsuper
              AND pg_catalog.has_any_column_privilege(r.oid, c.oid, p)
            ORDER BY 1, 2`,
          [reg],
        );
        expect(colPrivs.rows, table).toEqual([]);

        const publicPrivs = await c.query<{ privilege: string }>(
          `SELECT p AS privilege
             FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
            WHERE pg_catalog.has_table_privilege('public', $1::regclass, p)
               OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND pg_catalog.has_any_column_privilege('public', $1::regclass, p))
            ORDER BY 1`,
          [reg],
        );
        expect(publicPrivs.rows, table).toEqual([]);
      }

      const uniqueIndexes = await c.query<{ indexdef: string }>(
        'SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS indexdef FROM pg_catalog.pg_index i WHERE i.indrelid = pg_catalog.to_regclass($1) AND i.indisunique AND i.indisvalid',
        [dbIds!.table('crove_finance.bank_feed_hook')],
      );
      const defs = uniqueIndexes.rows.map((r) => r.indexdef);
      expect(defs.some((d) => d.endsWith('USING btree (org_id, id)'))).toBe(true);
    });

    for (const table of ['crove_finance.bank_feed_hook', 'crove_finance.bank_feed_webhook_notice', 'crove_finance.bank_feed_webhook_backlog']) {
      await expect(appPool.query(`SELECT 1 FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query(`SELECT 1 FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('pins SECURITY DEFINER, search_path, no PUBLIC grant, and exact EXECUTE matrix across all roles', async () => {
    await withAdmin(async (c) => {
      for (const def of DEFINERS) {
        const meta = await c.query<{ secdef: boolean; config: string[] | null; acl: string | null }>(
          'SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure',
          [def.sig],
        );
        expect(meta.rows[0]?.secdef, def.sig).toBe(true);
        expect(meta.rows[0]?.config, def.sig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(meta.rows[0]?.acl ?? '', def.sig).not.toMatch(/(^|[{,])=X\//);

        const matrix = await auditRoleFunctionExecute(c, dbIds, def.sig, def.roles, 'non_system');
        expect(matrix.rows.filter((r) => r.ok !== r.expected), def.sig).toEqual([]);
      }

      for (const helper of HELPERS) {
        const helperMeta = await c.query<{ config: string[] | null; acl: string | null }>(
          'SELECT proconfig AS config, proacl::text AS acl FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure',
          [helper.sig],
        );
        expect(helperMeta.rows[0]?.config, helper.sig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(helperMeta.rows[0]?.acl ?? '', helper.sig).not.toMatch(/(^|[{,])=X\//);
        const helperMatrix = await auditRoleFunctionExecute(c, dbIds, helper.sig, helper.roles, 'non_system');
        expect(helperMatrix.rows.filter((r) => r.ok !== r.expected), helper.sig).toEqual([]);
      }
    });

    await expect(workerPool.query("SELECT * FROM crove_finance.bank_feed_hook_lookup('bank_tingee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerPool.query('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6)', [
        randomUUID(),
        '0'.repeat(64),
        'req-1',
        '20261120120000000',
        SIG,
        '{}',
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT * FROM crove_finance.bank_feed_hook_status($1::uuid)', [connAId])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT crove_finance.personal_data_erase_bank_feed_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT crove_finance.bank_feed_notice_decode_escapes('a')")).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_finance.bank_feed_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.bank_feed_hook_reject($1::uuid, 1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.bank_feed_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.bank_feed_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query("SELECT crove_finance.bank_feed_notice_decode_escapes('a')")).rejects.toMatchObject({ code: '42501' });
  });

  it('requires a sealed context, enforces owner/admin/owner-only roles, and isolates cross-org connections and keys', async () => {
    await expect(appPool.query('SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_finance.bank_feed_hook_status($1::uuid)', [connAId])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query("SELECT crove_finance.personal_data_erase_bank_feed_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });

    await expect(withSealedApp(users.member, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.member, orgId, 'SELECT * FROM crove_finance.bank_feed_hook_status($1::uuid)', [connAId])).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.member, orgId, "SELECT crove_finance.personal_data_erase_bank_feed_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.admin, orgId, "SELECT crove_finance.personal_data_erase_bank_feed_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });

    await expect(withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [otherConnId, '0'.repeat(64)])).rejects.toMatchObject({ code: '22023' });
    expect(await withSealedApp(users.owner, orgId, 'SELECT * FROM crove_finance.bank_feed_hook_status($1::uuid)', [otherConnId])).toEqual([]);

    const made = await apiRuntime.execute<{ provider: string; key: string; created: boolean }>(
      'finance.bank_feed.hook_set',
      { connectionId: connBId },
      { actor: asUser(users.admin), orgId },
    );
    expect(made).toMatchObject({ provider: 'bank_tingee', created: false });
    const status = await withSealedApp<{ created_at: Date; rotated_at: Date | null; last_seen_at: Date | null; rejected_count: number; stopped: boolean }>(
      users.admin,
      orgId,
      'SELECT * FROM crove_finance.bank_feed_hook_status($1::uuid)',
      [connBId],
    );
    expect(status).toHaveLength(1);
    expect(Object.keys(status[0] ?? {}).sort()).toEqual(['created_at', 'last_seen_at', 'rejected_count', 'rotated_at', 'stopped']);
    const audit = await withAdmin((c) => c.query('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]));
    for (const secret of [made.key, sha(made.key), sha(keyB)]) {
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
    }
  });

  it('derives org strictly from the hook row, stays dark when closed or Finance is off, and purges inactive notices without stopping claim early', async () => {
    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    const spoofedBody = makeBody({ org_id: otherOrgId });
    expect(
      await acceptBankFeedHook(apiRuntime, tingee, { key: keyA, headers: freshHeaders('inv-spoof-1'), body: spoofedBody }, budget),
    ).toEqual({ status: 200 });

    const claimed0 = await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx));
    expect(claimed0).toHaveLength(1);
    expect(claimed0[0]?.orgId).toBe(orgId);
    expect(claimed0[0]?.connectionId).toBe(connAId);
    expect(claimed0[0]?.hookId).toBe(hookAId);

    // Turning Finance off makes lookup empty, put 'gone', and claim drop waiting notices.
    expect(
      await acceptBankFeedHook(apiRuntime, tingee, { key: keyA, headers: freshHeaders('inv-fin-off'), body: makeBody() }, budget),
    ).toEqual({ status: 200 });
    await withAdmin((c) => c.query("UPDATE crove_kernel.tenant SET apps_off = ARRAY['finance'] WHERE org_id = $1", [orgId]));
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: keyA, headers: freshHeaders('inv-fin-off-2'), body: makeBody() }, budget)).toEqual({ status: 404 });
    expect(
      await appPool
        .query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
          hookAId,
          sha(keyA),
          'inv-fin-off-put',
          vietnamStamp(new Date(), true),
          SIG,
          makeBody(),
        ])
        .then((r) => r.rows[0]?.put),
    ).toBe('gone');
    expect(await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx))).toEqual([]);
    await withAdmin(async (c) => {
      const left = await c.query<{ n: number }>('SELECT pg_catalog.count(*)::int AS n FROM crove_finance.bank_feed_webhook_notice');
      expect(left.rows[0]?.n).toBe(0);
      await c.query("UPDATE crove_kernel.tenant SET apps_off = '{}'::text[] WHERE org_id = $1", [orgId]);
    });

    // Revoking connection A while org/Finance remain active yields an all-NULL placeholder row in SQL
    // (no org_id/body/signature leak) while active notices on another org still deliver without dropping out of claim.
    await withAdmin(async (c) => {
      await c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, connAId]);
      await c.query(
        "INSERT INTO crove_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) VALUES ($1, $2, 'inv-rev-one', '20261120120000000', $3, $4, now() - interval '3 minutes')",
        [orgId, hookAId, SIG, makeBody()],
      );
    });
    const revokedSqlClaim = await workerPool.query('SELECT * FROM crove_finance.bank_feed_hook_claim(1)');
    expect(revokedSqlClaim.rows).toEqual([
      {
        org_id: null,
        hook_id: null,
        connection_id: null,
        provider: null,
        request_id: null,
        notice_timestamp: null,
        signature: null,
        body: null,
        generation: null,
      },
    ]);
    await withAdmin(async (c) => {
      await c.query(
        "INSERT INTO crove_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) VALUES ($1, $2, 'inv-rev-2', '20261120120000000', $3, $4, now() - interval '2 minutes')",
        [orgId, hookAId, SIG, makeBody()],
      );
      await c.query(
        "INSERT INTO crove_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) VALUES ($1, $2, 'inv-active-after', '20261120120000000', $3, $4, now() - interval '1 minute')",
        [otherOrgId, otherHookId, SIG, makeBody()],
      );
    });
    const mixedBatch = await workerDb.transaction().execute((trx) => claimBankFeedHookBatch(trx));
    expect(mixedBatch.claimed).toBe(2);
    expect(mixedBatch.rows).toHaveLength(1);
    expect(mixedBatch.rows[0]).toMatchObject({ orgId: otherOrgId, hookId: otherHookId, connectionId: otherConnId, requestId: 'inv-active-after' });
    await withAdmin(async (c) => {
      const left = await c.query<{ n: number }>('SELECT pg_catalog.count(*)::int AS n FROM crove_finance.bank_feed_webhook_notice');
      expect(left.rows[0]?.n).toBe(0);
      await c.query("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, connAId]);
    });
  });

  it('confines the raw body to bank_feed_webhook_notice, emits empty notifications and canary-free sync jobs, and names both tables in org_purge', async () => {
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const externalAccountId = `tingee-canary-${randomUUID().slice(0, 8)}`;
    const canarySecret = 'inv-canary-secret';
    const sealed = vault.seal(JSON.stringify({ clientId: 'bank-hook-inv', secretToken: canarySecret }), {
      orgId,
      provider: 'bank_tingee',
      externalAccountId,
    });
    const asMfa = { type: 'user' as const, userId: users.owner, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const connected = await apiRuntime.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'bank_tingee',
        externalAccountId,
        displayName: 'Tingee canary confinement',
        scopes: [],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asMfa, orgId, idempotencyKey: randomUUID() },
    );
    const canaryConnId = connected.connectionId;
    const canaryKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [canaryConnId, sha(canaryKey)]);

    const heard: string[] = [];
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      let resolveHeard: (() => void) | undefined;
      const notificationArrived = new Promise<void>((resolve, reject) => {
        resolveHeard = resolve;
        timeoutHandle = setTimeout(() => reject(new Error('timed out waiting for outbox notification')), 5000);
      });
      listener.on('notification', (message) => {
        heard.push(String(message.payload ?? ''));
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        resolveHeard?.();
      });
      const outboxChannel = dbIds?.isKernelLudy ? 'ludy_outbox' : 'crove_outbox';
      await listener.query(`LISTEN ${outboxChannel}`);

      const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
      const body = makeBody();
      const stamp = vietnamStamp(new Date(), true);
      const sig = tingeeHmac(canarySecret, stamp, body);
      expect(
        await acceptBankFeedHook(
          apiRuntime,
          tingee,
          {
            key: canaryKey,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'inv-canary',
              'x-request-timestamp': stamp,
              'x-signature': sig,
            },
            body,
          },
          budget,
        ),
      ).toEqual({ status: 200 });
      await notificationArrived;
      expect(heard.length).toBeGreaterThan(0);
      expect(heard.every((payload) => payload === '')).toBe(true);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      await listener.end().catch(() => {});
    }

    const pgBoss = new PgBoss({
      connectionString: workerUrl,
      schema: dbIds?.schema('jobs') ?? JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    pgBoss.on('error', () => {});
    await pgBoss.start();
    try {
      const round = await relayBankFeedHookBatch({
        workerDb,
        boss: pgBoss,
        runtime: workerRuntime,
        broker: vault,
        providers: { bank_tingee: tingee },
      });
      expect(round).toEqual({ claimed: 1, ok: 1, refused: 0, dropped: 0 });
    } finally {
      await pgBoss.stop({ graceful: false }).catch(() => {});
    }

    await withAdmin(async (c) => {
      const enqueued = await c.query<{ name: string; data_text: string }>(
        "SELECT name, data::text AS data_text FROM crove_jobs.job WHERE name = $1 AND data->>'orgId' = $2 AND data->>'connectionId' = $3",
        [QUEUES.bankFeedSync, orgId, canaryConnId],
      );
      expect(enqueued.rows).toHaveLength(1);
      expect(JSON.parse(enqueued.rows[0]!.data_text)).toEqual({ orgId, connectionId: canaryConnId });
      expect(enqueued.rows[0]?.data_text).not.toContain(CANARY);
      expect(enqueued.rows[0]?.data_text).not.toContain(canarySecret);
      expect(enqueued.rows[0]?.data_text).not.toContain(canaryKey);

      const canaryHex = Buffer.from(CANARY, 'utf8').toString('hex');
      const tables = await c.query<{ table_schema: string; table_name: string }>(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('crove_kernel', 'crove_jobs', 'crove_finance') AND table_type = 'BASE TABLE'",
      );
      for (const { table_schema, table_name } of tables.rows) {
        const found = await c.query<{ hit: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${table_schema}.${table_name} t WHERE t::text LIKE $1 OR t::text LIKE $2) AS hit`,
          [`%${CANARY}%`, `%${canaryHex}%`],
        );
        expect({ table: `${table_schema}.${table_name}`, hit: found.rows[0]?.hit }).toEqual({
          table: `${table_schema}.${table_name}`,
          hit: false,
        });
      }
      const purge = await c.query<{ def: string }>("SELECT pg_catalog.pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) AS def");
      const def = purge.rows[0]?.def ?? '';
      const noticePos = def.indexOf('crove_finance.bank_feed_webhook_notice');
      const hookPos = def.search(/crove_finance\.bank_feed_hook(?!_)/);
      expect(noticePos).toBeGreaterThan(-1);
      expect(hookPos).toBeGreaterThan(noticePos);
    });
  });

  it('rejects bad signatures and mismatched clientId through relayBankFeedHookBatch, queues no sync jobs, and counts on active generation', async () => {
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const externalAccountId = `tingee-reject-${randomUUID().slice(0, 8)}`;
    const rejectSecret = 'inv-reject-secret';
    const expectedClientId = 'bank-hook-reject-expected';
    const sealed = vault.seal(JSON.stringify({ clientId: expectedClientId, secretToken: rejectSecret }), {
      orgId,
      provider: 'bank_tingee',
      externalAccountId,
    });
    const asMfa = { type: 'user' as const, userId: users.owner, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const connected = await apiRuntime.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'bank_tingee',
        externalAccountId,
        displayName: 'Tingee reject pipeline invariant',
        scopes: [],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asMfa, orgId, idempotencyKey: randomUUID() },
    );
    const rejectConnId = connected.connectionId;
    const rejectKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [rejectConnId, sha(rejectKey)]);
    const rejectHookId = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [orgId, rejectConnId]),
      )
    ).rows[0]!.id;

    const pgBoss = new PgBoss({
      connectionString: workerUrl,
      schema: dbIds?.schema('jobs') ?? JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    pgBoss.on('error', () => {});
    await pgBoss.start();
    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    const syncJobsForConn = () =>
      withAdmin(async (c) => {
        const res = await c.query<{ id: string }>(
          "SELECT id FROM crove_jobs.job WHERE name = $1 AND data->>'orgId' = $2 AND data->>'connectionId' = $3",
          [QUEUES.bankFeedSync, orgId, rejectConnId],
        );
        return res.rows;
      });
    const hookCounters = () =>
      withAdmin(async (c) => {
        const res = await c.query<{ rejected_count: number; generation: number; stopped_at: Date | null }>(
          'SELECT rejected_count, generation, stopped_at FROM crove_finance.bank_feed_hook WHERE id = $1',
          [rejectHookId],
        );
        return res.rows[0];
      });
    try {
      // 1. Bad HMAC signature with matching clientId is refused through the full relay pipeline.
      const goodClientBody = JSON.stringify({ clientId: expectedClientId, content: 'reject-pipeline-bad-sig' });
      const badSigStamp = vietnamStamp(new Date(), true);
      expect(
        await acceptBankFeedHook(
          apiRuntime,
          tingee,
          {
            key: rejectKey,
            headers: {
              'content-type': 'application/json',
              'x-request-id': `inv-bad-sig-${randomUUID()}`,
              'x-request-timestamp': badSigStamp,
              'x-signature': tingeeHmac('wrong-secret', badSigStamp, goodClientBody),
            },
            body: goodClientBody,
          },
          budget,
        ),
      ).toEqual({ status: 200 });
      expect(
        await relayBankFeedHookBatch({
          workerDb,
          boss: pgBoss,
          runtime: workerRuntime,
          broker: vault,
          providers: { bank_tingee: tingee },
        }),
      ).toEqual({ claimed: 1, ok: 0, refused: 1, dropped: 0 });
      expect(await syncJobsForConn()).toHaveLength(0);
      expect(await hookCounters()).toEqual({ rejected_count: 1, generation: 1, stopped_at: null });

      // 2. Valid HMAC signature with a mismatched clientId is refused through the full relay pipeline.
      const wrongClientBody = JSON.stringify({ clientId: 'other-client-id', content: 'reject-pipeline-wrong-client' });
      const wrongClientStamp = vietnamStamp(new Date(), true);
      expect(
        await acceptBankFeedHook(
          apiRuntime,
          tingee,
          {
            key: rejectKey,
            headers: {
              'content-type': 'application/json',
              'x-request-id': `inv-wrong-client-${randomUUID()}`,
              'x-request-timestamp': wrongClientStamp,
              'x-signature': tingeeHmac(rejectSecret, wrongClientStamp, wrongClientBody),
            },
            body: wrongClientBody,
          },
          budget,
        ),
      ).toEqual({ status: 200 });
      expect(
        await relayBankFeedHookBatch({
          workerDb,
          boss: pgBoss,
          runtime: workerRuntime,
          broker: vault,
          providers: { bank_tingee: tingee },
        }),
      ).toEqual({ claimed: 1, ok: 0, refused: 1, dropped: 0 });
      expect(await syncJobsForConn()).toHaveLength(0);
      expect(await hookCounters()).toEqual({ rejected_count: 2, generation: 1, stopped_at: null });

      // 3. Rotating the key resets the counter on generation 2, and a relay rejection increments generation 2 cleanly.
      const rotatedRejectKey = randomBytes(16).toString('base64url');
      await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [rejectConnId, sha(rotatedRejectKey)]);
      const gen2Stamp = vietnamStamp(new Date(), true);
      expect(
        await acceptBankFeedHook(
          apiRuntime,
          tingee,
          {
            key: rotatedRejectKey,
            headers: {
              'content-type': 'application/json',
              'x-request-id': `inv-gen2-bad-sig-${randomUUID()}`,
              'x-request-timestamp': gen2Stamp,
              'x-signature': tingeeHmac('wrong-secret', gen2Stamp, goodClientBody),
            },
            body: goodClientBody,
          },
          budget,
        ),
      ).toEqual({ status: 200 });
      expect(
        await relayBankFeedHookBatch({
          workerDb,
          boss: pgBoss,
          runtime: workerRuntime,
          broker: vault,
          providers: { bank_tingee: tingee },
        }),
      ).toEqual({ claimed: 1, ok: 0, refused: 1, dropped: 0 });
      expect(await syncJobsForConn()).toHaveLength(0);
      expect(await hookCounters()).toEqual({ rejected_count: 1, generation: 2, stopped_at: null });
    } finally {
      await pgBoss.stop({ graceful: false }).catch(() => {});
      await withAdmin((c) => c.query('DELETE FROM crove_finance.bank_feed_webhook_notice'));
    }
  });

  it('blocks an in-flight pre-migration bank_feed_hook_reject(uuid) queued across migration from stopping a rotated hook', async () => {
    expect(inflightStoppedResult).toBe(false);
    const row = (
      await withAdmin((c) =>
        c.query<{ rejected_count: number; stopped_at: Date | null; reject_token: string; generation: number }>(
          'SELECT rejected_count, stopped_at, reject_token, generation FROM crove_finance.bank_feed_hook WHERE id = $1',
          [inflightHookId],
        ),
      )
    ).rows[0];
    expect(row?.rejected_count).toBe(9);
    expect(row?.stopped_at).toBeNull();
    expect(await rejectBankFeedHook(workerDb, row!.reject_token, row!.generation)).toBe(true);
  });

  it('binds bank_feed_hook_reject to hook generation so pre-rotation notices cannot count against a rotated address', async () => {
    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: keyA, headers: freshHeaders('inv-rot-1'), body: makeBody() }, budget)).toEqual({ status: 200 });
    const [preRotation] = await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx));
    expect(preRotation?.hookId).toBe(hookAId);
    const oldGeneration = preRotation!.generation;

    // Rotate before post-commit reject runs: generation increments, reject_token rotates, and waiting notices are dropped.
    const nextKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, sha(nextKey)]);

    // Stale generation refusal (both 2-arg and 1-arg compatibility shim) is a no-op and never increments or stops the rotated hook.
    expect(await rejectBankFeedHook(workerDb, preRotation!.hookId, oldGeneration)).toBe(false);
    expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [preRotation!.hookId])).rows[0]?.stopped).toBe(false);
    expect(
      await withSealedApp<{ rejected_count: number; stopped: boolean }>(
        users.owner,
        orgId,
        'SELECT rejected_count, stopped FROM crove_finance.bank_feed_hook_status($1::uuid)',
        [connAId],
      ),
    ).toEqual([{ rejected_count: 0, stopped: false }]);

    // Current generation claim returns a distinct per-rotation token so even a rolled-back 1-arg worker counts and stops at 10.
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: nextKey, headers: freshHeaders('inv-rot-2'), body: makeBody() }, budget)).toEqual({ status: 200 });
    const [postRotation] = await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx));
    expect(postRotation?.generation).toBe(oldGeneration + 1);
    expect(postRotation?.hookId).not.toBe(hookAId);

    // Passing the current token with an older generation is ignored so h.generation = p_generation holds independently.
    expect(await rejectBankFeedHook(workerDb, postRotation!.hookId, oldGeneration)).toBe(false);
    expect(
      await withSealedApp<{ rejected_count: number; stopped: boolean }>(
        users.owner,
        orgId,
        'SELECT rejected_count, stopped FROM crove_finance.bank_feed_hook_status($1::uuid)',
        [connAId],
      ),
    ).toEqual([{ rejected_count: 0, stopped: false }]);

    // 1st refusal via 2-arg worker, then 2nd..10th via 1-arg shim stop the rotated address on the 10th.
    expect(await rejectBankFeedHook(workerDb, postRotation!.hookId, postRotation!.generation)).toBe(false);
    for (let n = 2; n < 10; n++) {
      expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [postRotation!.hookId])).rows[0]?.stopped).toBe(false);
    }
    expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [postRotation!.hookId])).rows[0]?.stopped).toBe(true);

    // Rotating again invalidates the previous rotation's 1-arg token and 2-arg generation, while minting another token.
    const gen3Key = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, sha(gen3Key)]);
    expect(await rejectBankFeedHook(workerDb, postRotation!.hookId, postRotation!.generation)).toBe(false);
    expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [postRotation!.hookId])).rows[0]?.stopped).toBe(false);
    expect(
      await withSealedApp<{ rejected_count: number; stopped: boolean }>(
        users.owner,
        orgId,
        'SELECT rejected_count, stopped FROM crove_finance.bank_feed_hook_status($1::uuid)',
        [connAId],
      ),
    ).toEqual([{ rejected_count: 0, stopped: false }]);
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: gen3Key, headers: freshHeaders('inv-rot-3'), body: makeBody() }, budget)).toEqual({ status: 200 });
    const [gen3Claim] = await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx));
    expect(gen3Claim?.generation).toBe(oldGeneration + 2);
    expect(gen3Claim?.hookId).not.toBe(hookAId);
    expect(gen3Claim?.hookId).not.toBe(postRotation!.hookId);

    // Even a legacy UPDATE changing key_sha256/rotated_at without mentioning generation/reject_token triggers both
    // the rotation guard (new generation + reject_token) and the cleanup trigger (drops waiting pre-rotation notices).
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: gen3Key, headers: freshHeaders('inv-rot-stale-wait'), body: makeBody() }, budget)).toEqual({ status: 200 });
    const guardKey = randomBytes(16).toString('base64url');
    await withAdmin((c) =>
      c.query(
        'UPDATE crove_finance.bank_feed_hook SET key_sha256 = $2, rotated_at = pg_catalog.clock_timestamp(), rejected_count = 0, rejected_window_start = NULL, stopped_at = NULL WHERE org_id = $1 AND id = $3',
        [orgId, sha(guardKey), hookAId],
      ),
    );
    expect(await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx))).toEqual([]);
    expect(await rejectBankFeedHook(workerDb, gen3Claim!.hookId, gen3Claim!.generation)).toBe(false);
    expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.bank_feed_hook_reject($1::uuid) AS stopped', [gen3Claim!.hookId])).rows[0]?.stopped).toBe(false);
    expect(await acceptBankFeedHook(apiRuntime, tingee, { key: guardKey, headers: freshHeaders('inv-rot-4'), body: makeBody() }, budget)).toEqual({ status: 200 });
    const [guardClaim] = await workerDb.transaction().execute((trx) => claimBankFeedHookNotices(trx));
    expect(guardClaim?.generation).toBe(oldGeneration + 3);
    expect(guardClaim?.hookId).not.toBe(gen3Claim!.hookId);
  });

  it('scopes personal_data_erase_bank_feed_notice strictly to the caller org and erases JSON \\uXXXX escapes and non-JSON payloads', async () => {
    const email = 'tám.escaped@example.test';
    const nonJsonEmail = 'nam.escaped@example.test';
    const escapedBody = '{"clientId":"bank-hook-inv","content":"t\\u00e1m.escaped\\u0040example.test"}';
    const literalEscapeBody = '{"clientId":"bank-hook-inv","content":"\\\\u0074\\\\u00e1m.escaped\\\\u0040example.test"}';
    const nonJsonEscapedBody = 'payer: \\nam.escaped@example.test';
    const currentKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [connAId, sha(currentKey)]);

    const stamp = vietnamStamp(new Date(), true);
    expect(
      await appPool
        .query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
          hookAId,
          sha(currentKey),
          'erase-iso-org-a-escaped',
          stamp,
          SIG,
          escapedBody,
        ])
        .then((r) => r.rows[0]?.put),
    ).toBe('accepted');
    expect(
      await appPool
        .query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
          hookAId,
          sha(currentKey),
          'erase-iso-org-a-literal',
          stamp,
          SIG,
          literalEscapeBody,
        ])
        .then((r) => r.rows[0]?.put),
    ).toBe('accepted');
    expect(
      await appPool
        .query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
          hookAId,
          sha(currentKey),
          'erase-iso-org-a-nonjson',
          stamp,
          SIG,
          nonJsonEscapedBody,
        ])
        .then((r) => r.rows[0]?.put),
    ).toBe('accepted');
    expect(
      await appPool
        .query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
          otherHookId,
          sha(otherKey),
          'erase-iso-org-b',
          stamp,
          SIG,
          escapedBody,
        ])
        .then((r) => r.rows[0]?.put),
    ).toBe('accepted');

    const erased = await withSealedApp<{ rows: number }>(
      users.owner,
      orgId,
      "SELECT crove_finance.personal_data_erase_bank_feed_notice('email', $1) AS rows",
      [email],
    );
    expect(erased).toEqual([{ rows: 1 }]);

    const erasedNonJson = await withSealedApp<{ rows: number }>(
      users.owner,
      orgId,
      "SELECT crove_finance.personal_data_erase_bank_feed_notice('email', $1) AS rows",
      [nonJsonEmail],
    );
    expect(erasedNonJson).toEqual([{ rows: 1 }]);

    await withAdmin(async (c) => {
      const remaining = await c.query<{ org_id: string; hook_id: string; request_id: string }>(
        'SELECT org_id, hook_id, request_id FROM crove_finance.bank_feed_webhook_notice ORDER BY received_at, id',
      );
      expect(remaining.rows).toEqual([
        { org_id: orgId, hook_id: hookAId, request_id: 'erase-iso-org-a-literal' },
        { org_id: otherOrgId, hook_id: otherHookId, request_id: 'erase-iso-org-b' },
      ]);
      await c.query('DELETE FROM crove_finance.bank_feed_webhook_notice');
    });
  });

  it('isolates tenant row locks across orgs and enforces post-lock Finance-off and concurrent connection revocation', async () => {
    const lockConnA = await connectBankFeed(orgId, users.owner);
    const lockKeyA = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [lockConnA, sha(lockKeyA)]);
    const lockHookA = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [orgId, lockConnA]),
      )
    ).rows[0]!.id;

    const lockConnB = await connectBankFeed(otherOrgId, users.outsider);
    const lockKeyB = randomBytes(16).toString('base64url');
    await withSealedApp(users.outsider, otherOrgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [lockConnB, sha(lockKeyB)]);
    const lockHookB = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [otherOrgId, lockConnB]),
      )
    ).rows[0]!.id;

    const locker = createDbClient({ connectionString: adminUrl }, dbIds);
    const revoker = createDbClient({ connectionString: adminUrl }, dbIds);
    await locker.connect();
    await revoker.connect();
    const probeStamp = vietnamStamp(new Date(), true);
    const probeBody = JSON.stringify({ clientId: 'bank-hook-inv', content: 'concurrency-invariant-probe' });
    const waitLockOn = async (queryPattern: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const waiting = await withAdmin(async (c) => {
          const res = await c.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE $1) AS waiting",
            [queryPattern],
          );
          return res.rows[0]?.waiting === true;
        });
        if (waiting) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };

    try {
      await withAdmin((c) => c.query('DELETE FROM crove_finance.bank_feed_webhook_notice'));

      // 1. Holding org A's tenant row lock stalls org A before slot 0 while org B accepts without delay.
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM crove_kernel.tenant WHERE org_id = $1 FOR UPDATE', [orgId]);
      const pendingPutA = appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookA, sha(lockKeyA), `inv-tenant-lock-a-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(await waitLockOn('%bank_feed_hook_put_notice%')).toBe(true);

      const resB = await appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookB, sha(lockKeyB), `inv-tenant-lock-b-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(resB.rows).toEqual([{ put: 'accepted' }]);
      await locker.query('ROLLBACK');
      expect((await pendingPutA).rows).toEqual([{ put: 'accepted' }]);
      await workerPool.query('SELECT * FROM crove_finance.bank_feed_hook_claim(100)');

      // 2. If the tenant transaction disables Finance before committing, waiting put_notice observes Finance off post-lock and returns 'gone'.
      await locker.query('BEGIN');
      await locker.query("UPDATE crove_kernel.tenant SET apps_off = ARRAY['finance'], apps_version = apps_version + 1 WHERE org_id = $1", [orgId]);
      const pendingPutOff = appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookA, sha(lockKeyA), `inv-fin-off-race-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(await waitLockOn('%bank_feed_hook_put_notice%')).toBe(true);
      await locker.query('COMMIT');
      expect((await pendingPutOff).rows).toEqual([{ put: 'gone' }]);
      await locker.query("UPDATE crove_kernel.tenant SET apps_off = '{}'::text[], apps_version = apps_version + 1 WHERE org_id = $1", [orgId]);

      // 3. Uncommitted channel revocation stalls only org A before slot 0 (org B still accepts) and makes org A return 'gone' once committed.
      await locker.query('BEGIN');
      await locker.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, lockConnA]);
      const pendingRevokedPut = appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookA, sha(lockKeyA), `inv-rev-before-slot-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(await waitLockOn('%bank_feed_hook_put_notice%')).toBe(true);
      const resOtherDuringRevoke = await appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookB, sha(lockKeyB), `inv-rev-other-org-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(resOtherDuringRevoke.rows).toEqual([{ put: 'accepted' }]);
      await locker.query('COMMIT');
      expect((await pendingRevokedPut).rows).toEqual([{ put: 'gone' }]);
      await locker.query("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, lockConnA]);
      await workerPool.query('SELECT * FROM crove_finance.bank_feed_hook_claim(100)');

      // 4. While another transaction holds slot 0, put_notice keeps FOR SHARE on the active connection until slot 0 frees,
      // forcing a concurrent revocation to commit strictly after put_notice completes and making subsequent puts return 'gone'.
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM crove_finance.bank_feed_webhook_backlog WHERE slot = 0 FOR UPDATE');
      const whileSlotHeldReqId = `inv-rev-during-slot-${randomUUID()}`;
      const slotWaitingPut = appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookA, sha(lockKeyA), whileSlotHeldReqId, probeStamp, SIG, probeBody],
      );
      expect(await waitLockOn('%bank_feed_hook_put_notice%')).toBe(true);
      const concurrentRevoke = revoker.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [
        orgId,
        lockConnA,
      ]);
      expect(await waitLockOn('%channel_connection%')).toBe(true);

      await locker.query('COMMIT');
      expect((await slotWaitingPut).rows).toEqual([{ put: 'accepted' }]);
      await concurrentRevoke;

      const postRevokePut = await appPool.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lockHookA, sha(lockKeyA), `inv-rev-after-slot-${randomUUID()}`, probeStamp, SIG, probeBody],
      );
      expect(postRevokePut.rows).toEqual([{ put: 'gone' }]);
      await withAdmin(async (c) => {
        const stored = await c.query<{ hook_id: string; request_id: string }>(
          'SELECT hook_id, request_id FROM crove_finance.bank_feed_webhook_notice ORDER BY received_at, id',
        );
        expect(stored.rows).toEqual([{ hook_id: lockHookA, request_id: whileSlotHeldReqId }]);
      });
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      await revoker.query('ROLLBACK').catch(() => {});
      await withAdmin(async (c) => {
        await c.query("UPDATE crove_kernel.tenant SET apps_off = '{}'::text[], apps_version = apps_version + 1 WHERE org_id = $1 AND apps_off <> '{}'::text[]", [orgId]);
        await c.query("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, lockConnA]);
        await c.query('DELETE FROM crove_finance.bank_feed_webhook_notice');
      }).catch(() => {});
      await locker.end().catch(() => {});
      await revoker.end().catch(() => {});
    }
  });

  it('enforces the 10,000-row shared backlog cap atomically across orgs while still acknowledging waiting duplicates', async () => {
    const bulkConn = await connectBankFeed(otherOrgId, users.outsider);
    const bulkKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.outsider, otherOrgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [bulkConn, sha(bulkKey)]);
    const bulkHookId = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [otherOrgId, bulkConn]),
      )
    ).rows[0]!.id;

    const raceConnA = await connectBankFeed(orgId, users.owner);
    const raceKeyA = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [raceConnA, sha(raceKeyA)]);
    const raceHookA = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [orgId, raceConnA]),
      )
    ).rows[0]!.id;

    const raceConnB = await connectBankFeed(otherOrgId, users.outsider);
    const raceKeyB = randomBytes(16).toString('base64url');
    await withSealedApp(users.outsider, otherOrgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [raceConnB, sha(raceKeyB)]);
    const raceHookB = (
      await withAdmin((c) =>
        c.query<{ id: string }>('SELECT id FROM crove_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [otherOrgId, raceConnB]),
      )
    ).rows[0]!.id;

    const stamp = vietnamStamp(new Date(), true);
    const probeBody = JSON.stringify({ clientId: 'bank-hook-inv', content: 'backlog-cap-invariant-probe' });
    const connA = await appPool.connect();
    const connB = await appPool.connect();
    try {
      await withAdmin(async (c) => {
        await c.query('DELETE FROM crove_finance.bank_feed_webhook_notice');
        await c.query(
          "INSERT INTO crove_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body) SELECT $1, $2, 'inv-cap-' || n, $3, $4, $5 FROM generate_series(1, 9999) n",
          [otherOrgId, bulkHookId, stamp, SIG, probeBody],
        );
      });

      // Keep tx A open holding slot 0 after inserting row 10,000 so tx B overlaps on slot 0 and observes 10,000 committed rows post-lock.
      await connA.query('BEGIN');
      const firstSlot = await connA.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [raceHookA, sha(raceKeyA), `inv-race-a-${randomUUID()}`, stamp, SIG, probeBody],
      );
      expect(firstSlot.rows).toEqual([{ put: 'accepted' }]);

      const secondSlotPromise = connB.query<{ put: string }>(
        'SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [raceHookB, sha(raceKeyB), `inv-race-b-${randomUUID()}`, stamp, SIG, probeBody],
      );
      const lockDeadline = Date.now() + 5000;
      let secondWaiting = false;
      while (Date.now() < lockDeadline) {
        const seen = await withAdmin((c) =>
          c.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%bank_feed_hook_put_notice%') AS waiting",
          ),
        );
        if (seen.rows[0]?.waiting) {
          secondWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(secondWaiting).toBe(true);
      await connA.query('COMMIT');
      expect((await secondSlotPromise).rows).toEqual([{ put: 'busy' }]);

      // At 10,000 rows, a new notice is rejected as 'busy' while a retry of an existing waiting row is still acknowledged as 'duplicate'.
      expect(
        (
          await appPool.query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
            raceHookA,
            sha(raceKeyA),
            `inv-overflow-${randomUUID()}`,
            stamp,
            SIG,
            probeBody,
          ])
        ).rows[0]?.put,
      ).toBe('busy');
      expect(
        (
          await appPool.query<{ put: string }>('SELECT crove_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [
            bulkHookId,
            sha(bulkKey),
            'inv-cap-1',
            stamp,
            SIG,
            probeBody,
          ])
        ).rows[0]?.put,
      ).toBe('duplicate');

      await withAdmin(async (c) => {
        const countRes = await c.query<{ n: number }>('SELECT pg_catalog.count(*)::int AS n FROM crove_finance.bank_feed_webhook_notice');
        const sumRes = await c.query<{ total: number }>('SELECT COALESCE(pg_catalog.sum(delta), 0)::int AS total FROM crove_finance.bank_feed_webhook_backlog');
        expect(countRes.rows[0]?.n).toBe(10000);
        expect(sumRes.rows[0]?.total).toBe(10000);
      });
    } finally {
      await connA.query('ROLLBACK').catch(() => {});
      await connB.query('ROLLBACK').catch(() => {});
      connA.release();
      connB.release();
      await withAdmin((c) => c.query('DELETE FROM crove_finance.bank_feed_webhook_notice')).catch(() => {});
    }
  });

  it('enforces unknown-provider 404, 16 KB body limit 413, and per-address 429 via createHttpApp before DB key lookup', async () => {
    const httpConn = await connectBankFeed(orgId, users.owner);
    const httpKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.bank_feed_hook_set($1::uuid, $2)', [httpConn, sha(httpKey)]);

    let orglessCalls = 0;
    const trackedRuntime = new Proxy(apiRuntime, {
      get(target, prop) {
        if (prop === 'orgless') {
          return ((fn: Parameters<Runtime['orgless']>[0]) => {
            orglessCalls += 1;
            return target.orgless(fn);
          }) as Runtime['orgless'];
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const httpConfig = loadConfig({
      DATABASE_URL: workerUrl,
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'ludy-auth',
      AUTH_SESSION_CHECK: 'off',
      WEB_DIST: '/nonexistent',
    });
    const makeHttp = (perMinute: number) =>
      createHttpApp({
        config: httpConfig,
        runtime: trackedRuntime,
        store: {} as BlobStore,
        authenticate: (async () => {
          throw new Error('webhook route must not authenticate a user');
        }) as never,
        pool: appPool,
        aiEnabled: false,
        bankFeedHooks: { bank_tingee: tingee },
        bankFeedHookLimit: new RateLimiter({ perMinute }),
        bankFeedHookBudget: new RateLimiter({ perMinute: 100 }),
      });

    const http = makeHttp(2);
    const stamp = vietnamStamp(new Date(), true);
    const validBody = JSON.stringify({ clientId: 'bank-hook-inv', content: 'http-ingress-probe' });
    const headers = (requestId: string, bodyText: string) => ({
      'content-type': 'application/json',
      'x-request-id': requestId,
      'x-request-timestamp': stamp,
      'x-signature': tingeeHmac('http-probe-secret', stamp, bodyText),
    });

    try {
      await withAdmin((c) => c.query('DELETE FROM crove_finance.bank_feed_webhook_notice'));

      // 1. Unknown provider returns 404 before rate limit consumption or DB lookup.
      expect(
        (await http.request(`/api/bank-feed/nobody/webhook/${httpKey}`, { method: 'POST', headers: headers('http-unknown-prov', 'x'), body: 'x' })).status,
      ).toBe(404);
      expect(orglessCalls).toBe(0);

      // 2. Oversize payload (> fixed 16 KiB ADR-0039 limit) returns 413 before any DB lookup or notice insert.
      const oversizeBody = 'x'.repeat(16 * 1024 + 1);
      expect(
        (
          await http.request(`/api/bank-feed/bank_tingee/webhook/${httpKey}`, {
            method: 'POST',
            headers: headers('http-oversize', oversizeBody),
            body: oversizeBody,
          })
        ).status,
      ).toBe(413);
      expect(orglessCalls).toBe(0);

      // 3. Valid request reaches DB lookup + put_notice (2 orgless calls) and stores 1 notice.
      expect(
        (
          await http.request(`/api/bank-feed/bank_tingee/webhook/${httpKey}`, {
            method: 'POST',
            headers: headers('http-valid-1', validBody),
            body: validBody,
          })
        ).status,
      ).toBe(200);
      expect(orglessCalls).toBe(2);

      // 4. Exhausted per-address limit returns 429 BEFORE reading a chunked stream or invoking DB lookup.
      let pulled = 0;
      const chunkedStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
          if (pulled > 3) controller.close();
        },
      });
      const limitedRes = await http.request(`/api/bank-feed/bank_tingee/webhook/${httpKey}`, {
        method: 'POST',
        headers: headers('http-limited', validBody),
        body: chunkedStream,
        duplex: 'half',
      } as RequestInit);
      expect(limitedRes.status).toBe(429);
      expect(limitedRes.headers.get('retry-after')).toBeTruthy();
      expect(orglessCalls).toBe(2);
      expect(pulled).toBeLessThanOrEqual(1);

      // 5. Short invalid key format skips DB lookup (orglessCalls stays 2), whereas a valid-shape 22-char unknown key runs lookup once (3) and returns 404.
      const unthrottled = makeHttp(5);
      expect(
        (
          await unthrottled.request('/api/bank-feed/bank_tingee/webhook/short-invalid-key', {
            method: 'POST',
            headers: headers('http-short-key', validBody),
            body: validBody,
          })
        ).status,
      ).toBe(404);
      expect(orglessCalls).toBe(2);
      const unknownKey = randomBytes(16).toString('base64url');
      expect(
        (
          await unthrottled.request(`/api/bank-feed/bank_tingee/webhook/${unknownKey}`, {
            method: 'POST',
            headers: headers('http-unknown-key', validBody),
            body: validBody,
          })
        ).status,
      ).toBe(404);
      expect(orglessCalls).toBe(3);

      await withAdmin(async (c) => {
        const stored = await c.query<{ request_id: string }>('SELECT request_id FROM crove_finance.bank_feed_webhook_notice ORDER BY received_at, id');
        expect(stored.rows).toEqual([{ request_id: 'http-valid-1' }]);
      });
    } finally {
      await withAdmin((c) => c.query('DELETE FROM crove_finance.bank_feed_webhook_notice')).catch(() => {});
    }
  });
});
