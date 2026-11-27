// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (#5158, ADR-0060): orgless definer privilege, search_path, no-context isolation,
// poison/10m expiry, and table closure for ludy_projects.github_webhook_pending and hook intake definers.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, upsertIdentity } from '@ludy/kernel';
import { createDb } from '@ludy/db';
import { Runtime } from '@ludy/kernel-runtime';
import { enterUser } from './fixtures/context-token.ts';
import {
  createDbClient,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const suite = ADMIN ? describe : describe.skip;

const WORKER_ONLY_DEFINERS = [
  'crove_projects.github_webhook_sweep()',
  'crove_projects.github_webhook_has_work()',
  'crove_projects.github_webhook_pending_claim(integer, integer)',
  'crove_projects.github_webhook_pending_done(bigint)',
  'crove_projects.github_webhook_hook_claim(integer)',
  'crove_projects.github_webhook_hook_reject(uuid, integer)',
  'crove_projects.github_app_org_bindings(bigint, bigint)',
  'crove_projects.github_pat_org_bindings(uuid, uuid, bigint)',
  'crove_projects.github_sync_delivery_begin(uuid, uuid, text, text, text, text, integer)',
  'crove_projects.github_sync_delivery_finish(uuid, uuid, text, uuid, text, text)',
  'crove_projects.github_app_installation_targets(text)',
] as const;

const APP_ONLY_DEFINERS = [
  'crove_projects.github_webhook_pending_enqueue(text, text, text, bigint, bytea)',
  'crove_projects.github_webhook_hook_find(text)',
  'crove_projects.github_webhook_hook_put(uuid, text, integer, text, text, text, bytea)',
] as const;

const TENANT_DEFINERS = [
  'crove_projects.github_webhook_hook_set(uuid, text)',
  'crove_projects.github_webhook_hook_status(uuid)',
  'crove_projects.github_sync_delivery_list(uuid, integer)',
  'crove_projects.personal_data_erase_github_notice(text, text)',
] as const;

const canonicalRole = (role: string): string => role.replace(/^(crove|ludy)_/, 'crove_');

suite('ludy_projects github webhook pending & definer invariants (#5158)', () => {
  const dbName = `ludy_inv_gh_pend_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let dbIds!: DbIdentifiers;
  let orgId = '';
  let ownerId = '';

  const withRole = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = createDbClient({ connectionString: url }, dbIds, { canonicalizeCatalog: false });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const parsed = new URL(ADMIN as string);
    parsed.pathname = `/${dbName}`;
    adminUrl = parsed.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const login = (logicalRole: 'crove_app' | 'crove_worker', password: string) => {
      const u = new URL(adminUrl);
      u.username = dbIds.roleName(logicalRole);
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');

    const adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    try {
      const db = createDb(adminPool);
      const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands],
        queries: [],
      });
      ownerId = await upsertIdentity(db, {
        issuer: 'test',
        subject: randomUUID(),
        email: 'gh-pending-owner@example.com',
        name: 'GH Pending Owner',
      });
      const created = await createOrg(
        rt,
        { type: 'user', userId: ownerId, aal: 'aal1', sessionId: randomUUID() },
        'GH Pending Test Org',
      );
      orgId = created.orgId;
    } finally {
      await adminPool.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('closes github_webhook_pending table completely and enforces pinned search_path + least-privilege EXECUTE grants', async () => {
    await withRole(adminUrl, async (c) => {
      const { rows: privs } = await c.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type
           FROM information_schema.role_table_grants
          WHERE table_schema = $1 AND table_name = 'github_webhook_pending'
            AND grantee <> 'postgres'`,
        [dbIds.schema('projects')],
      );
      expect(privs, 'github_webhook_pending has zero table privileges to any non-owner role').toEqual([]);

      const { rows: rls } = await c.query<{ relrowsecurity: boolean }>(
        `SELECT t.relrowsecurity
           FROM pg_catalog.pg_class t
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'github_webhook_pending'`,
        [dbIds.schema('projects')],
      );
      expect(rls[0]?.relrowsecurity).toBe(true);

      const allDefiners = [...WORKER_ONLY_DEFINERS, ...APP_ONLY_DEFINERS, ...TENANT_DEFINERS];
      for (const logicalSig of allDefiners) {
        const activeSig = dbIds.rewriteSql(logicalSig);
        const { rows: fnRows } = await c.query<{
          prosecdef: boolean;
          proconfig: string[] | null;
        }>(
          `SELECT p.prosecdef, p.proconfig
             FROM pg_catalog.pg_proc p
            WHERE p.oid = pg_catalog.to_regprocedure($1)`,
          [activeSig],
        );
        expect(fnRows[0]?.prosecdef, `${logicalSig} SECURITY DEFINER`).toBe(true);
        expect(fnRows[0]?.proconfig, `${logicalSig} pinned search_path`).toContain(SEARCH_PATH);

        const { rows: grantRows } = await c.query<{ rolname: string }>(
          `SELECT r.rolname
             FROM pg_catalog.pg_roles r
            WHERE (r.rolname LIKE 'ludy\\_%' OR r.rolname LIKE 'crove\\_%' OR r.rolname IN ('anon', 'authenticated', 'service_role'))
              AND pg_catalog.has_function_privilege(r.oid, pg_catalog.to_regprocedure($1), 'EXECUTE')`,
          [activeSig],
        );
        const granted = grantRows.map((g) => canonicalRole(g.rolname));
        if ((WORKER_ONLY_DEFINERS as readonly string[]).includes(logicalSig)) {
          expect(granted, `${logicalSig} grants`).toEqual(['crove_worker']);
        } else if ((APP_ONLY_DEFINERS as readonly string[]).includes(logicalSig)) {
          expect(granted, `${logicalSig} grants`).toEqual(['crove_app']);
        } else {
          expect(granted, `${logicalSig} grants`).toEqual(
            expect.arrayContaining(['crove_tenant']),
          );
          expect(granted).not.toContain('anon');
          expect(granted).not.toContain('authenticated');
        }
      }
    });
  });

  it('denies cross-role calls and rejects pending claim/done inside tenant or system contexts', async () => {
    await withRole(appUrl, async (c) => {
      await expect(
        c.query(dbIds.rewriteSql('SELECT * FROM crove_projects.github_webhook_pending_claim(10, 60)')),
      ).rejects.toThrow(/permission denied/);
      await expect(
        c.query(dbIds.rewriteSql('SELECT crove_projects.github_webhook_sweep()')),
      ).rejects.toThrow(/permission denied/);
      await expect(
        c.query(dbIds.rewriteSql('SELECT * FROM crove_projects.github_webhook_pending')),
      ).rejects.toThrow(/permission denied/);

      await c.query('BEGIN');
      await enterUser(c, ownerId, orgId);
      await expect(
        c.query(dbIds.rewriteSql('SELECT * FROM crove_projects.github_webhook_pending_claim(10, 60)')),
      ).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    });

    await withRole(workerUrl, async (c) => {
      await expect(
        c.query(
          dbIds.rewriteSql(
            `SELECT crove_projects.github_webhook_pending_enqueue('d1', 'issues', 'sha256=${'a'.repeat(64)}', 1, '\\x7b7d'::bytea)`,
          ),
        ),
      ).rejects.toThrow(/permission denied/);

      // Cannot claim/done while inside a system context.
      await c.query('BEGIN');
      await c.query(dbIds.rewriteSql('SELECT crove_kernel.enter_system_context($1::uuid)'), [orgId]);
      await expect(
        c.query(dbIds.rewriteSql('SELECT * FROM crove_projects.github_webhook_pending_claim(10, 60)')),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query(dbIds.rewriteSql('SELECT crove_kernel.enter_system_context($1::uuid)'), [orgId]);
      await expect(
        c.query(dbIds.rewriteSql('SELECT crove_projects.github_webhook_pending_done(1)')),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });

  it('enforces 10m expiry, poison cap (attempts >= 5), and clean claim/done deletion on pending rows', async () => {
    const seq1 = await withRole(appUrl, async (c) => {
      const { rows } = await c.query<{ seq: string }>(
        dbIds.rewriteSql(
          `SELECT crove_projects.github_webhook_pending_enqueue($1, 'issues', $2, 123, $3) AS seq`,
        ),
        [`del-${randomUUID()}`, `sha256=${'b'.repeat(64)}`, Buffer.from('{"action":"opened"}', 'utf8')],
      );
      return Number(rows[0]?.seq ?? 0);
    });
    expect(seq1).toBeGreaterThan(0);

    // Simulate poison row (attempts = 5) and expired row (> 10 minutes old).
    const seqStale = await withRole(appUrl, async (c) => {
      const { rows } = await c.query<{ seq: string }>(
        dbIds.rewriteSql(
          `SELECT crove_projects.github_webhook_pending_enqueue($1, 'issues', $2, 123, $3) AS seq`,
        ),
        [`del-stale-${randomUUID()}`, `sha256=${'c'.repeat(64)}`, Buffer.from('{"action":"closed"}', 'utf8')],
      );
      return Number(rows[0]?.seq ?? 0);
    });

    await withRole(adminUrl, async (c) => {
      await c.query(
        dbIds.rewriteSql(`UPDATE crove_projects.github_webhook_pending SET attempts = 5 WHERE seq = $1`),
        [seq1],
      );
      await c.query(
        dbIds.rewriteSql(`UPDATE crove_projects.github_webhook_pending SET received_at = clock_timestamp() - interval '11 minutes' WHERE seq = $1`),
        [seqStale],
      );
    });

    await withRole(workerUrl, async (c) => {
      const { rows } = await c.query<{ seq: string; dropped: boolean; reason: string | null }>(
        dbIds.rewriteSql('SELECT seq, dropped, reason FROM crove_projects.github_webhook_pending_claim(50, 60)'),
      );
      // Stale row was deleted upfront by sweep; poison row (seq1) is deleted and reported dropped='poison'.
      expect(rows.some((r) => Number(r.seq) === seqStale)).toBe(false);
      expect(rows.find((r) => Number(r.seq) === seq1)).toMatchObject({ dropped: true, reason: 'poison' });

      const { rows: left } = await c.query<{ ready: boolean }>(
        dbIds.rewriteSql('SELECT crove_projects.github_webhook_has_work() AS ready'),
      );
      expect(left[0]?.ready).toBe(false);
    });
  });
});
