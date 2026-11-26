// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7, #4326, parent #2524): access-isolation, role grants, sealed-context bounds,
// raw-body confinement, request_url scoping, and generation-bound rejection for marketplace push hooks.
// Self-contained under apps/kernel/test/invariant/ (AGENTS.md Protected paths).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { acceptMarketplacePush } from '../../src/marketplace-push-hook.ts';
import { claimMarketplaceHookNotices, rejectMarketplaceHook } from '../../src/marketplace-push-relay.ts';
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
const HEADER = 'a'.repeat(64);
const PUBLIC_URL = 'https://api.example.test';
const CANARY = 'invariant-hook-canary-9a4e2c11-do-not-keep';
const BODY = Buffer.concat([Buffer.from(`{"shop_id":"7495540735365777507","note":"${CANARY}"}`), Buffer.from([0xff, 0xfe])]);

const DEFINERS: ReadonlyArray<{ sig: string; roles: readonly string[] }> = [
  { sig: 'crove_finance.marketplace_hook_lookup(text,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.marketplace_hook_put_notice(uuid,text,text,text,bytea,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.marketplace_hook_set(uuid,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.marketplace_hook_status(uuid)', roles: ['crove_app'] },
  { sig: 'crove_finance.personal_data_erase_marketplace_hook_notice(text,text)', roles: ['crove_app'] },
  { sig: 'crove_finance.marketplace_hook_sweep()', roles: ['crove_worker'] },
  { sig: 'crove_finance.marketplace_hook_claim(integer)', roles: ['crove_worker'] },
  { sig: 'crove_finance.marketplace_hook_reject(uuid,integer)', roles: ['crove_worker'] },
  { sig: 'crove_finance.marketplace_hook_reject(uuid)', roles: ['crove_worker'] },
];

suite('marketplace push hook security invariants (#4326)', () => {
  const dbName = `ludy_test_mkt_hook_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let apiRuntime: Runtime;

  const users = { owner: '', admin: '', member: '', outsider: '' };
  let orgId = '';
  let otherOrgId = '';
  let shopeeConnId = '';
  let lazadaConnId = '';
  let otherTiktokConnId = '';
  let shopeeHookId = '';
  let lazadaHookId = '';
  let otherTiktokHookId = '';
  const shopeeKey = randomBytes(16).toString('base64url');
  const lazadaKey = randomBytes(16).toString('base64url');
  const otherTiktokKey = randomBytes(16).toString('base64url');

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

  async function connectMarketplace(targetOrg: string, by: string, adapter: 'shopee' | 'lazada' | 'tiktok_shop') {
    const channelId = randomUUID();
    const connectionId = randomUUID();
    await withAdmin(async (c) => {
      await c.query(
        "INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Sàn invariant', $5)",
        [targetOrg, channelId, `marketplace_${adapter}`, `acct-${randomUUID().slice(0, 8)}`, by],
      );
      await c.query(
        'INSERT INTO crove_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)',
        [targetOrg, connectionId, channelId, `marketplace_${adapter}`, adapter],
      );
    });
    return connectionId;
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appPool = createDbPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 }, dbIds);
    workerPool = createDbPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 2 }, dbIds);
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    apiRuntime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });

    for (const role of Object.keys(users) as Array<keyof typeof users>) {
      users[role] = await upsertIdentity(appDb, {
        issuer: 'test',
        subject: `mkt-hook-inv-${role}-${randomUUID()}`,
        email: `mkt-hook-inv-${role}@example.test`,
        name: null,
      });
    }
    orgId = (await createOrg(apiRuntime, asUser(users.owner), 'Công ty invariant push')).orgId;
    otherOrgId = (await createOrg(apiRuntime, asUser(users.outsider), 'Công ty khác invariant')).orgId;
    await withAdmin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [
        orgId,
        users.admin,
        users.member,
      ]),
    );

    shopeeConnId = await connectMarketplace(orgId, users.owner, 'shopee');
    lazadaConnId = await connectMarketplace(orgId, users.owner, 'lazada');
    otherTiktokConnId = await connectMarketplace(otherOrgId, users.outsider, 'tiktok_shop');

    await withAdmin(async (c) => {
      shopeeHookId =
        (
          await c.query<{ id: string }>(
            'INSERT INTO crove_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id',
            [orgId, shopeeConnId, sha(shopeeKey)],
          )
        ).rows[0]?.id ?? '';
      lazadaHookId =
        (
          await c.query<{ id: string }>(
            'INSERT INTO crove_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id',
            [orgId, lazadaConnId, sha(lazadaKey)],
          )
        ).rows[0]?.id ?? '';
      otherTiktokHookId =
        (
          await c.query<{ id: string }>(
            'INSERT INTO crove_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id',
            [otherOrgId, otherTiktokConnId, sha(otherTiktokKey)],
          )
        ).rows[0]?.id ?? '';
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps marketplace_hook and marketplace_hook_notice definer-only with RLS enabled and zero grants to any role', async () => {
    await withAdmin(async (c) => {
      for (const table of ['crove_finance.marketplace_hook', 'crove_finance.marketplace_hook_notice']) {
        const rls = await c.query<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_catalog.pg_class WHERE oid = $1::regclass', [table]);
        expect(rls.rows[0]?.on, table).toBe(true);
        const privs = await auditRoleTablePrivileges(c, dbIds, table, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'], 'non_system');
        expect(privs.filter((row) => row.ok), table).toEqual([]);
      }
    });
    for (const table of ['crove_finance.marketplace_hook', 'crove_finance.marketplace_hook_notice']) {
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
    });

    await expect(workerPool.query("SELECT * FROM crove_finance.marketplace_hook_lookup('shopee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerPool.query('SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6)', [
        randomUUID(),
        '0'.repeat(64),
        '0'.repeat(64),
        'a',
        Buffer.from('b'),
        null,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [shopeeConnId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)', [shopeeConnId])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT crove_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.marketplace_hook_reject($1::uuid, 1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.marketplace_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT crove_finance.marketplace_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
  });

  it('requires a sealed context, enforces owner/admin/owner-only roles, and isolates cross-org connections and keys', async () => {
    await expect(appPool.query('SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [shopeeConnId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)', [shopeeConnId])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query("SELECT crove_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });

    await expect(withSealedApp(users.member, orgId, 'SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [shopeeConnId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.member, orgId, 'SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)', [shopeeConnId])).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.member, orgId, "SELECT crove_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
    await expect(withSealedApp(users.admin, orgId, "SELECT crove_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });

    // Cross-org connection id: set refuses (22023 MARKETPLACE_HOOK_NOT_FOUND) and status returns empty.
    await expect(withSealedApp(users.owner, orgId, 'SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [otherTiktokConnId, '0'.repeat(64)])).rejects.toMatchObject({ code: '22023' });
    expect(await withSealedApp(users.owner, orgId, 'SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)', [otherTiktokConnId])).toEqual([]);

    // Status never returns key or key hash, and command audit events never leak key, hash or address.
    const made = await apiRuntime.execute<{ adapter: string; key: string; created: boolean }>(
      'finance.marketplace_connection.push_hook_set',
      { id: lazadaConnId },
      { actor: asUser(users.admin), orgId },
    );
    expect(made).toMatchObject({ adapter: 'lazada', created: false });
    const status = await withSealedApp<{ created_at: Date; rotated_at: Date | null; last_seen_at: Date | null; rejected_count: number; stopped: boolean }>(
      users.admin,
      orgId,
      'SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)',
      [lazadaConnId],
    );
    expect(status).toHaveLength(1);
    expect(Object.keys(status[0] ?? {}).sort()).toEqual(['created_at', 'last_seen_at', 'rejected_count', 'rotated_at', 'stopped']);
    const audit = await withAdmin((c) => c.query('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]));
    for (const secret of [made.key, sha(made.key), sha(lazadaKey)]) {
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
    }
  });

  it('derives org strictly from the hook row, confines request_url to Shopee, and stays dark when closed or Finance is off', async () => {
    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    const spoofedBody = Buffer.from(JSON.stringify({ org_id: otherOrgId, shop_id: '7495540735365777507', note: CANARY }), 'utf8');
    expect(
      await acceptMarketplacePush(apiRuntime, 'shopee', { key: shopeeKey, authorization: HEADER, body: spoofedBody }, budget, PUBLIC_URL),
    ).toEqual({ status: 200 });

    const spoofedUrl = `${PUBLIC_URL}/api/marketplace/lazada/webhook/should-not-store`;
    expect(
      await appPool.query<{ put: string }>(
        'SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [otherTiktokHookId, sha(otherTiktokKey), sha('inv-tiktok-url'), HEADER, BODY, spoofedUrl],
      ).then((r) => r.rows[0]?.put),
    ).toBe('accepted');

    const freshLazadaKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [lazadaConnId, sha(freshLazadaKey)]);
    expect(
      await appPool.query<{ put: string }>(
        'SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [lazadaHookId, sha(freshLazadaKey), sha('inv-lazada-url'), HEADER, BODY, spoofedUrl],
      ).then((r) => r.rows[0]?.put),
    ).toBe('accepted');

    // Verify persisted table rows BEFORE claim deletes them so request_url cannot merely be masked by claim.
    await withAdmin(async (c) => {
      const stored = await c.query<{ hook_id: string; request_url: string | null }>(
        'SELECT hook_id, request_url FROM crove_finance.marketplace_hook_notice',
      );
      expect(stored.rows.find((r) => r.hook_id === shopeeHookId)?.request_url).toBe(`${PUBLIC_URL}/api/marketplace/shopee/webhook/${shopeeKey}`);
      expect(stored.rows.find((r) => r.hook_id === otherTiktokHookId)?.request_url).toBeNull();
      expect(stored.rows.find((r) => r.hook_id === lazadaHookId)?.request_url).toBeNull();
    });

    const claimed = await workerDb.transaction().execute((trx) => claimMarketplaceHookNotices(trx));
    const shopeeRow = claimed.find((r) => r.hookId === shopeeHookId);
    const tiktokRow = claimed.find((r) => r.hookId === otherTiktokHookId);
    const lazadaRow = claimed.find((r) => r.hookId === lazadaHookId);
    expect(shopeeRow?.orgId).toBe(orgId);
    expect(shopeeRow?.requestUrl).toBe(`${PUBLIC_URL}/api/marketplace/shopee/webhook/${shopeeKey}`);
    expect(tiktokRow?.orgId).toBe(otherOrgId);
    expect(tiktokRow?.requestUrl).toBeNull();
    expect(lazadaRow?.orgId).toBe(orgId);
    expect(lazadaRow?.requestUrl).toBeNull();

    // Turning Finance off or revoking the channel connection makes lookup empty, put 'gone', and claim drop waiting pushes.
    expect(
      await acceptMarketplacePush(apiRuntime, 'shopee', { key: shopeeKey, authorization: HEADER, body: BODY }, budget, PUBLIC_URL),
    ).toEqual({ status: 200 });
    await withAdmin((c) => c.query("UPDATE crove_kernel.tenant SET apps_off = ARRAY['finance'] WHERE org_id = $1", [orgId]));
    expect(await acceptMarketplacePush(apiRuntime, 'shopee', { key: shopeeKey, authorization: HEADER, body: BODY }, budget, PUBLIC_URL)).toEqual({ status: 404 });
    expect(await workerDb.transaction().execute((trx) => claimMarketplaceHookNotices(trx))).toEqual([]);
    await withAdmin((c) => c.query("UPDATE crove_kernel.tenant SET apps_off = '{}'::text[] WHERE org_id = $1", [orgId]));
  });

  it('confines the raw body to marketplace_hook_notice, emits empty notifications, and names both tables in org_purge', async () => {
    const heard: string[] = [];
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    listener.on('notification', (message) => heard.push(String(message.payload ?? '')));
    const outboxChannel = dbIds?.isKernelLudy ? 'ludy_outbox' : 'crove_outbox';
    await listener.query(`LISTEN ${outboxChannel}`);

    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    expect(await acceptMarketplacePush(apiRuntime, 'shopee', { key: shopeeKey, authorization: HEADER, body: BODY }, budget, PUBLIC_URL)).toEqual({ status: 200 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await listener.end();
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((payload) => payload === '')).toBe(true);

    const claimed = await workerDb.transaction().execute((trx) => claimMarketplaceHookNotices(trx));
    expect(claimed).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(claimed[0]!.body), BODY)).toBe(0);

    await withAdmin(async (c) => {
      const tables = await c.query<{ table_schema: string; table_name: string }>(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('crove_kernel', 'crove_jobs', 'crove_finance') AND table_type = 'BASE TABLE'",
      );
      for (const { table_schema, table_name } of tables.rows) {
        const found = await c.query<{ hit: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${table_schema}.${table_name} t WHERE t::text LIKE $1 OR t::text LIKE $2) AS hit`,
          [`%${CANARY}%`, `%${Buffer.from(CANARY).toString('hex')}%`],
        );
        expect({ table: `${table_schema}.${table_name}`, hit: found.rows[0]?.hit }).toEqual({
          table: `${table_schema}.${table_name}`,
          hit: false,
        });
      }
      const purge = await c.query<{ def: string }>("SELECT pg_catalog.pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) AS def");
      const def = purge.rows[0]?.def ?? '';
      const noticePos = def.indexOf('crove_finance.marketplace_hook_notice');
      const hookPos = def.search(/crove_finance\.marketplace_hook(?!_)/);
      expect(noticePos).toBeGreaterThan(-1);
      expect(hookPos).toBeGreaterThan(noticePos);
    });
  });

  it('binds marketplace_hook_reject to hook generation so pre-rotation pushes cannot count against a rotated address', async () => {
    const budget = { take: () => ({ allowed: true, retryAfterSeconds: 1 }) };
    expect(await acceptMarketplacePush(apiRuntime, 'shopee', { key: shopeeKey, authorization: HEADER, body: BODY }, budget, PUBLIC_URL)).toEqual({ status: 200 });
    const [preRotation] = await workerDb.transaction().execute((trx) => claimMarketplaceHookNotices(trx));
    expect(preRotation?.hookId).toBe(shopeeHookId);
    const oldGeneration = preRotation!.generation;

    // Rotate before the post-commit reject runs: generation increments and waiting pushes are dropped.
    const nextKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [shopeeConnId, sha(nextKey)]);

    // Stale generation refusal (both 2-arg and 1-arg gen-1 shim) is a no-op and never increments or stops the rotated hook.
    expect(await rejectMarketplaceHook(workerDb, shopeeHookId, oldGeneration)).toBe(false);
    expect((await workerPool.query<{ stopped: boolean }>('SELECT crove_finance.marketplace_hook_reject($1::uuid) AS stopped', [shopeeHookId])).rows[0]?.stopped).toBe(false);
    const afterStale = await withSealedApp<{ rejected_count: number; stopped: boolean }>(
      users.owner,
      orgId,
      'SELECT rejected_count, stopped FROM crove_finance.marketplace_hook_status($1::uuid)',
      [shopeeConnId],
    );
    expect(afterStale).toEqual([{ rejected_count: 0, stopped: false }]);

    // Current generation refusal counts normally.
    expect(await rejectMarketplaceHook(workerDb, shopeeHookId, oldGeneration + 1)).toBe(false);
    const afterCurrent = await withSealedApp<{ rejected_count: number; stopped: boolean }>(
      users.owner,
      orgId,
      'SELECT rejected_count, stopped FROM crove_finance.marketplace_hook_status($1::uuid)',
      [shopeeConnId],
    );
    expect(afterCurrent).toEqual([{ rejected_count: 1, stopped: false }]);
  });

  it('scopes personal_data_erase_marketplace_hook_notice strictly to the caller org when erasing matching notices', async () => {
    const email = 'erase.isolated@example.test';
    const body = Buffer.from(JSON.stringify({ buyer: 'Nguyễn Văn Tám', email }), 'utf8');
    const currentShopeeKey = randomBytes(16).toString('base64url');
    await withSealedApp(users.owner, orgId, 'SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [shopeeConnId, sha(currentShopeeKey)]);

    expect(
      await appPool.query<{ put: string }>(
        'SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [shopeeHookId, sha(currentShopeeKey), sha('erase-iso-org-a'), HEADER, body, `${PUBLIC_URL}/api/marketplace/shopee/webhook/${currentShopeeKey}`],
      ).then((r) => r.rows[0]?.put),
    ).toBe('accepted');
    expect(
      await appPool.query<{ put: string }>(
        'SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
        [otherTiktokHookId, sha(otherTiktokKey), sha('erase-iso-org-b'), HEADER, body, null],
      ).then((r) => r.rows[0]?.put),
    ).toBe('accepted');

    const erased = await withSealedApp<{ rows: number }>(
      users.owner,
      orgId,
      "SELECT crove_finance.personal_data_erase_marketplace_hook_notice('email', $1) AS rows",
      [email],
    );
    expect(erased).toEqual([{ rows: 1 }]);

    await withAdmin(async (c) => {
      const remaining = await c.query<{ org_id: string; hook_id: string }>(
        'SELECT org_id, hook_id FROM crove_finance.marketplace_hook_notice ORDER BY received_at, id',
      );
      expect(remaining.rows).toEqual([{ org_id: otherOrgId, hook_id: otherTiktokHookId }]);
      await c.query('DELETE FROM crove_finance.marketplace_hook_notice');
    });
  });
});
