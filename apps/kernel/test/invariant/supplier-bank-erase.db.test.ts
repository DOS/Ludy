// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (#3738): privilege, CHECK-constraint, and trigger guards for supplier bank erase tombstones.
// Guarantees that:
//   - ludy_finance.supplier_bank_account_erase_tombstone(uuid, timestamptz) is SECURITY DEFINER with search_path = pg_catalog, pg_temp and executable by ludy_app alone;
//   - the three guard trigger functions pin search_path = pg_catalog, pg_temp and cannot be executed by PUBLIC or tenant/runtime roles;
//   - no role (superuser included) can insert tombstones or NULL-bypassed change hashes, or mutate last4 / hashes / change history outside the definer;
//   - direct calls to the definer require user/owner context, fresh step-up, retired accounts only, an already-shredded subject key, and no waiting payments or proposals;
//   - member removal (ON DELETE SET NULL) and superuser-only changed_at backdating keep working on tombstoned/intact rows without altering hashes.
// Part of the invariant suite: self-contained under apps/kernel/test/invariant/ (imports only packages under test and local fixtures).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { enterUser } from './fixtures/context-token.ts';
import {
  auditRoleFunctionExecute,
  createDbClient,
  createDbPool,
  createRawPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const TOMBSTONE_FN = 'crove_finance.supplier_bank_account_erase_tombstone(uuid,timestamptz)';
const GUARD_FNS = [
  'crove_finance.supplier_bank_account_guard()',
  'crove_finance.supplier_bank_account_change_guard()',
  'crove_finance.supplier_payment_guard()',
] as const;
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const canonical = (role: string): string => role.replace(/^(crove|ludy)_/, 'crove_');

const NUMBER = '0123 4567 8901';
const OTHER = '9988776655';
const HOLDER = 'Nguyen Van Canary';

describe.skipIf(!ADMIN)('supplier bank erase tombstone privileges, constraints, and guard triggers (#3738)', () => {
  const dbName = `ludy_test_supplier_erase_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers;
  let adminClient: pg.Client;
  let appPool: pg.Pool;
  let runtimePool: pg.Pool;
  let workerClient: pg.Client;
  let db: Db;
  let rt: Runtime;

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const hashRoot = { id: 'k-inv-1', key: randomBytes(32) };
  const user = (userId: string, fresh = true) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    mfaAt: fresh ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) - 3600,
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);

  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@inv.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; supplier: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Cong ty Invariant ${randomUUID().slice(0, 6)}`);
    const adminUser = await identity('admin');
    const member = await identity('member');
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser, member]);
    });
    const supplier = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nha cung cap thu')", [orgId, supplier]));
    return { orgId, owner, admin: adminUser, member, supplier };
  }

  const execute = <T>(o: Org, name: string, input: unknown, who = o.owner, fresh = true) =>
    rt.execute<T>(name, input, { actor: user(who, fresh), orgId: o.orgId, idempotencyKey: randomUUID() });

  beforeAll(async () => {
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`CREATE DATABASE ${dbName}`);
    await rootClient.end();

    const dbBase = new URL(ADMIN as string);
    dbBase.pathname = `/${dbName}`;
    adminUrl = dbBase.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const app = new URL(adminUrl);
    app.username = dbIds.roleName('crove_app');
    app.password = 'test-app-pw';
    const worker = new URL(adminUrl);
    worker.username = dbIds.roleName('crove_worker');
    worker.password = 'test-worker-pw';

    adminClient = createDbClient({ connectionString: adminUrl }, dbIds);
    await adminClient.connect();
    appPool = createRawPool({ connectionString: app.toString(), max: 4 }, dbIds);
    runtimePool = createDbPool({ connectionString: app.toString(), max: 4 });
    workerClient = createDbClient({ connectionString: worker.toString() }, dbIds);
    await workerClient.connect();

    db = createDb(runtimePool);
    const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, subjectVault, keyedHashRoots: [hashRoot] }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await workerClient?.end().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    await runtimePool?.end().catch(() => undefined);
    await adminClient?.end().catch(() => undefined);
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  const resolved = (signature: string): string => dbIds.rewriteSql(signature);

  it('pins search_path and SECURITY DEFINER on the erase tombstone definer and grants EXECUTE only to the app role', async () => {
    const checkList: Array<[string, boolean]> = [
      [TOMBSTONE_FN, true],
      ...GUARD_FNS.map((sig): [string, boolean] => [sig, false]),
    ];
    for (const [signature, secdef] of checkList) {
      const { rows: proc } = await adminClient.query<{ secdef: boolean; config: string[] | null }>(
        'SELECT p.prosecdef AS secdef, p.proconfig AS config FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid',
        [resolved(signature)],
      );
      expect(proc, `${signature} exists`).toHaveLength(1);
      expect(proc[0]?.secdef, `${signature} prosecdef`).toBe(secdef);
      expect(proc[0]?.config ?? [], `${signature} search_path`).toEqual([SEARCH_PATH]);
    }

    const granted = async (signature: string): Promise<string[]> => {
      const { rows: acl } = await adminClient.query<{ grantee: string }>(
        `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee
           FROM pg_catalog.pg_proc p
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
          WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
          ORDER BY 1`,
        [resolved(signature)],
      );
      return acl.map((r) => canonical(r.grantee));
    };

    // canonical() normalizes post-Stage-7 ludy_app to crove_app for db-identifiers.ts compatibility across brands.
    expect(await granted(TOMBSTONE_FN)).toEqual(['crove_app']);
    const tombstoneAudit = await auditRoleFunctionExecute(adminClient, dbIds, TOMBSTONE_FN, ['crove_app'], 'non_system');
    expect(tombstoneAudit.rows.some((r) => r.rolname === tombstoneAudit.activeAllowed[0] && r.ok)).toBe(true);
    expect(tombstoneAudit.rows.filter((r) => r.ok !== r.expected)).toEqual([]);

    for (const guardSig of GUARD_FNS) {
      expect(await granted(guardSig)).toEqual([]);
      const guardAudit = await auditRoleFunctionExecute(adminClient, dbIds, guardSig, [], 'non_system');
      expect(guardAudit.rows.filter((r) => r.ok), guardSig).toEqual([]);
    }
  });

  it('rejects null/tombstone inserts, direct mutations, GUC spoofing, missing step-up, active keys, and non-owners, while allowing member cleanup and superuser changed_at backdating', async () => {
    const o = await org();
    // Admin creates the initial account so created_by and changed_by reference o.admin for member-removal cleanup below.
    const account = await execute<{ id: string }>(o, 'finance.supplier_bank_account.add', {
      partyId: o.supplier,
      bankName: 'Vietcombank',
      accountHolder: HOLDER,
      accountNumber: NUMBER,
    }, o.admin);
    await execute(o, 'finance.supplier_bank_account.retire', { accountId: account.id }, o.owner);

    // Reject forged tombstone inserts and NULL-hash inserts across supplier_bank_account and supplier_bank_account_change.
    await expect(
      rows(
        `INSERT INTO crove_finance.supplier_bank_account (org_id, party_id, bank_name, account_holder_sealed, number_sealed, number_hash, hash_key_id, last4)
         VALUES ($1, $2, 'Raw', 'ludy:s1:x', 'ludy:s1:x', 'erased', 'subject:v1', '****')`,
        [o.orgId, o.supplier],
      ),
    ).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_STATE|supplier_bank_account/);
    await expect(
      rows(
        `INSERT INTO crove_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, new_number_hash, step_up_at)
         VALUES ($1, $2, $3, 'added', 'erased', now())`,
        [o.orgId, o.supplier, account.id],
      ),
    ).rejects.toThrow(/SUPPLIER_BANK_CHANGE_IMMUTABLE/);
    await expect(
      rows(
        `INSERT INTO crove_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, step_up_at)
         VALUES ($1, $2, $3, 'added', now())`,
        [o.orgId, o.supplier, account.id],
      ),
    ).rejects.toThrow(/supplier_bank_account_change_hash_ck/);
    await expect(
      rows(
        `INSERT INTO crove_finance.supplier_bank_account_change (org_id, party_id, account_id, kind, step_up_at)
         VALUES ($1, $2, $3, 'retired', now())`,
        [o.orgId, o.supplier, account.id],
      ),
    ).rejects.toThrow(/supplier_bank_account_change_hash_ck/);

    // Superuser outside definer cannot rewrite last4, number_hash, or change history, even when setting ludy.supplier_bank_erase directly.
    await expect(rows("UPDATE crove_finance.supplier_bank_account SET number_hash = 'erased', last4 = '****' WHERE org_id = $1 AND id = $2", [o.orgId, account.id])).rejects.toThrow(
      /SUPPLIER_BANK_ACCOUNT_STATE/,
    );
    await expect(rows("UPDATE crove_finance.supplier_bank_account_change SET new_number_hash = 'erased' WHERE org_id = $1 AND account_id = $2 AND kind = 'added'", [o.orgId, account.id])).rejects.toThrow(
      /SUPPLIER_BANK_CHANGE_IMMUTABLE/,
    );
    await expect(
      rows("UPDATE crove_finance.supplier_bank_account_change SET changed_at = now() - interval '1 day', new_number_hash = 'erased' WHERE org_id = $1 AND account_id = $2 AND kind = 'added'", [
        o.orgId,
        account.id,
      ]),
    ).rejects.toThrow(/SUPPLIER_BANK_CHANGE_IMMUTABLE/);
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query("SELECT pg_catalog.set_config('ludy.supplier_bank_erase', $1, true)", [`${o.orgId}:${o.supplier}`]);
          await c.query("UPDATE crove_finance.supplier_bank_account SET number_hash = 'erased', last4 = '****' WHERE org_id = $1 AND id = $2", [o.orgId, account.id]);
          await c.query('COMMIT');
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        }
      }),
    ).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_STATE/);

    // Superuser changed_at backdating alone (outside actor context, hashes untouched) remains allowed for time-window tests.
    await expect(rows("UPDATE crove_finance.supplier_bank_account_change SET changed_at = now() - interval '35 days' WHERE org_id = $1 AND account_id = $2 AND kind = 'added'", [o.orgId, account.id])).resolves.toBeDefined();

    // Worker login is denied EXECUTE on erase_tombstone.
    await expect(workerClient.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier])).rejects.toThrow(/permission denied/);

    // App login checks: no context, non-owner, missing/stale step-up, GUC spoof UPDATEs, active account, active subject key.
    const appClient = await appPool.connect();
    try {
      await expect(appClient.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier])).rejects.toThrow(/NO_CONTEXT/);

      const runAs = async (who: string, fn: (c: pg.PoolClient) => Promise<unknown>) => {
        await appClient.query('BEGIN');
        try {
          await enterUser(appClient, who, o.orgId);
          const result = await fn(appClient);
          await appClient.query('COMMIT');
          return result;
        } catch (error) {
          await appClient.query('ROLLBACK');
          throw error;
        }
      };

      await expect(runAs(o.admin, (c) => c.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier]))).rejects.toThrow(/SUPPLIER_BANK_ERASE_FORBIDDEN/);
      await expect(runAs(o.member, (c) => c.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier]))).rejects.toThrow(/SUPPLIER_BANK_ERASE_FORBIDDEN/);
      await expect(runAs(o.owner, (c) => c.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, NULL)', [o.supplier]))).rejects.toThrow(/STEP_UP_REQUIRED/);
      await expect(
        runAs(o.owner, (c) => c.query("SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, pg_catalog.now() - interval '6 minutes')", [o.supplier])),
      ).rejects.toThrow(/STEP_UP_REQUIRED/);
      await expect(
        runAs(o.owner, (c) => c.query("SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, pg_catalog.now() + interval '2 minutes')", [o.supplier])),
      ).rejects.toThrow(/STEP_UP_REQUIRED/);

      // Direct UPDATE by ludy_app even with spoofed GUC fails permission/guard checks.
      await expect(
        runAs(o.owner, async (c) => {
          await c.query("SELECT pg_catalog.set_config('ludy.supplier_bank_erase', $1, true)", [`${o.orgId}:${o.supplier}`]);
          await c.query("UPDATE crove_finance.supplier_bank_account SET number_hash = 'erased', last4 = '****' WHERE org_id = $1 AND id = $2", [o.orgId, account.id]);
        }),
      ).rejects.toThrow(/permission denied|SUPPLIER_BANK_ACCOUNT_STATE/);
      await expect(
        runAs(o.owner, async (c) => {
          await c.query("SELECT pg_catalog.set_config('ludy.supplier_bank_erase', $1, true)", [`${o.orgId}:${o.supplier}`]);
          await c.query("UPDATE crove_finance.supplier_bank_account_change SET new_number_hash = 'erased' WHERE org_id = $1 AND account_id = $2", [o.orgId, account.id]);
        }),
      ).rejects.toThrow(/permission denied|SUPPLIER_BANK_CHANGE_IMMUTABLE/);
      await expect(
        runAs(o.owner, async (c) => {
          await c.query("SELECT pg_catalog.set_config('ludy.supplier_bank_erase', $1, true)", [`${o.orgId}:${o.supplier}`]);
          await c.query("UPDATE crove_finance.supplier_payment SET number_hash = 'erased' WHERE org_id = $1 AND party_id = $2", [o.orgId, o.supplier]);
        }),
      ).rejects.toThrow(/permission denied|SUPPLIER_PAYMENT_STATE/);

      // Without shredding subject:<partyId>, even an owner with fresh step-up and retired-only accounts is refused SUPPLIER_BANK_KEY_ACTIVE.
      await expect(runAs(o.owner, (c) => c.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier]))).rejects.toThrow(/SUPPLIER_BANK_KEY_ACTIVE/);

      // While an active account exists, direct owner call refuses SUPPLIER_BANK_ACCOUNT_ACTIVE.
      await execute(o, 'finance.supplier_bank_account.add', { partyId: o.supplier, bankName: 'ACB', accountHolder: HOLDER, accountNumber: OTHER }, o.owner);
      await expect(runAs(o.owner, (c) => c.query('SELECT * FROM crove_finance.supplier_bank_account_erase_tombstone($1::uuid, now())', [o.supplier]))).rejects.toThrow(/SUPPLIER_BANK_ACCOUNT_ACTIVE/);
    } finally {
      appClient.release();
    }

    // Agent actor cannot execute erase command.
    await expect(
      rt.execute(
        'finance.supplier_bank_account.erase',
        { partyId: o.supplier },
        { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() } as never, orgId: o.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toBeTruthy();

    // Full erase via command succeeds, and departing member FK cleanup (ON DELETE SET NULL on created_by/changed_by) still works on tombstoned rows.
    await execute(o, 'finance.supplier_bank_account.erase', { partyId: o.supplier }, o.owner);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin]));
    const cleanedAccount = (
      await rows<{ created_by: string | null; number_hash: string; last4: string }>(
        'SELECT created_by, number_hash, last4 FROM crove_finance.supplier_bank_account WHERE org_id = $1 AND id = $2',
        [o.orgId, account.id],
      )
    )[0];
    expect(cleanedAccount).toEqual({ created_by: null, number_hash: 'erased', last4: '****' });
    const cleanedChange = (
      await rows<{ changed_by: string | null; old_number_hash: string | null; new_number_hash: string | null }>(
        "SELECT changed_by, old_number_hash, new_number_hash FROM crove_finance.supplier_bank_account_change WHERE org_id = $1 AND account_id = $2 AND kind = 'added'",
        [o.orgId, account.id],
      )
    )[0];
    expect(cleanedChange).toEqual({ changed_by: null, old_number_hash: null, new_number_hash: 'erased' });
  });
});
