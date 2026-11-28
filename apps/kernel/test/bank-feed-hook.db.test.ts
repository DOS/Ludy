// SPDX-License-Identifier: AGPL-3.0-only
// The webhook of a bank feed that signs with each customer's own secret (Tingee; #4203, S3 of #2045), on a real PostgreSQL 17: who may set the hook (owners and admins, a person), that the key is shown once and only
// its hash is kept, the public route (an unknown key is a 404 with nothing stored, a repeated request id is a no-op, a stale or malformed notice is refused, a validation challenge is answered), the login roles'
// grants (the tables are definer-only; the API puts, the worker claims), the claim (deletes as it hands out), the ten-minute sweep, ten refused notices stopping a hook until it is rotated, and erasure.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { BankFeedProvider } from '@ludy/bank-feed';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, mintContextToken, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { BANK_FEED_HOOK_CLAIM, bankFeedHookKeyHash, rejectBankFeedHook } from '../src/bank-feed-hook.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { jobKey } from '../src/job-keys.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { relayBankFeedHookBatch, relayBankFeedHookBatches } from '../src/worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-feed-hook-0123456789';
const ISSUER = 'ludy-auth';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

// A stand-in adapter: the route needs only the timestamp window of the provider; the signature is the worker's.
const adapter: BankFeedProvider = {
  id: 'bank_tingee',
  hosts: ['open.tingee.vn'],
  async check() {},
  async accounts() {
    return [];
  },
  async pull() {
    return { transactions: [], cursor: '', more: false };
  },
  hookTimestampFresh: (timestamp) => timestamp === '20261120120000000',
  verifyHook: () => 'ok',
};
const FRESH = '20261120120000000';
const PAYER_EMAIL = 'nguoi.chuyen.khoan@example.test';
const BODY = '{"clientId":"hook-test","content":"hook-test-payer-nguyen-van-a"}';

suite('Bank feed webhook (#4203)', () => {
  const dbName = `ludy_test_bank_feed_hook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let app: ReturnType<typeof createHttpApp>;
  let runtimeApi: Runtime;
  let workerRuntime: Runtime;
  let vault: CredentialVault;
  const owner: Account = { subject: randomUUID(), email: 'owner@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@bank-feed-hook.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherSlug = '';
  let otherOrgId = '';
  let connectionId = '';
  let otherConnectionId = '';
  let preUpgradeConnId = '';
  let preUpgradeHookId = '';
  let preUpgradeClaimId = '';
  let inflightPutOverflowError = '';
  let inflightCapCountAfterPut = 0;
  let firstUpgradeBacklogAfterPut = -1;
  let firstUpgradeBacklogAfterTrim = -1;
  let firstUpgradeNoticesAfterTrim: Array<{ hook_id: string; request_id: string; body: string }> = [];
  let postUpgradeNotices: Array<{ hook_id: string; request_id: string; body: string }> = [];
  let postUpgradeBacklogBefore: Array<{ total: number }> = [];
  let postUpgradeClaimed: Array<{ org_id: string; hook_id: string; request_id: string; generation: number }> = [];
  let postUpgradeNoticesAfter: Array<{ hook_id: string; request_id: string; body: string }> = [];
  let postUpgradeBacklogAfter: Array<{ total: number }> = [];
  let postUpgradePreRejectStopped: boolean | undefined;
  let postUpgradeHookAfterReject: Array<{ rejected_count: number; stopped_at: string | null }> = [];
  const preUpgradeStaleReqId = 'pre-upgrade-stale-waiting';
  const preUpgradePostReqId = 'pre-upgrade-post-waiting';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  async function asSealedApp<T extends pg.QueryResultRow = Record<string, unknown>>(who: Account, org: string, text: string, values: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: who.userId,
        orgId: org,
        sessionId: who.session,
        aal: 'aal1',
        mfaAt: null,
      });
      await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [org, ctxToken]);
      const res = await client.query<T>(text, values);
      await client.query('COMMIT');
      return res.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  async function rpc(path: string, token: string, input: unknown, org: string | null = slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-ludy-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, text, body: (body && 'json' in body ? body.json : body) as any };
  }
  const hookSet = async (who: Account, connection: string = connectionId, org: string = slug) => rpc('bankFeeds/hookSet', await tokenFor(who), { connectionId: connection }, org);
  const hookStatus = async (who: Account, connection: string = connectionId, org: string = slug) => rpc('bankFeeds/hook', await tokenFor(who), { connectionId: connection }, org);
  const connectChannel = async (org: string, by: string) => {
    const id = randomUUID();
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'bank_tingee', $3, 'Tingee thử', $4)", [org, id, `tingee-${randomUUID().slice(0, 8)}`, by]);
    return id;
  };
  const post = (key: string, headers: Record<string, string> = {}, body: string = BODY) =>
    app.request(`/api/bank-feed/bank_tingee/webhook/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID(), 'x-request-timestamp': FRESH, 'x-signature': 'f'.repeat(128), ...headers },
      body,
    });
  const notices = async () => rows<{ hook_id: string; request_id: string; body: string }>('SELECT hook_id, request_id, body FROM ludy_finance.bank_feed_webhook_notice ORDER BY received_at, id');
  const asWorker = async <T>(text: string, values: unknown[] = []) => (await workerPool.query(text, values)).rows as T[];
  let keyOwner = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    const preRoot = mkdtempSync(join(tmpdir(), 'ludy-4225-pre-'));
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
      const variantsSource = fileURLToPath(new URL('../../../supabase/shared-variants', import.meta.url));
      if (existsSync(variantsSource)) {
        for (const name of readdirSync(variantsSource)) {
          if (keptMigrations.has(name)) symlinkSync(join(variantsSource, name), join(preVariantsDir, name));
        }
      }
      await migrate({ adminUrl, dir: preDir, sharedVariantsDir: preVariantsDir });
      await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
      const login = (username: string, password: string) => {
        const url = new URL(adminUrl);
        url.username = username;
        url.password = password;
        return url.toString();
      };
      pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
      workerUrl = login('ludy_worker', 'test-worker-pw');
      workerPool = createPool({ connectionString: workerUrl, max: 3 });
      const db = createDb(pool);
      workerDb = createDb(workerPool);
      const registered = {
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      };
      const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register(registered);
      runtimeApi = runtime;
      workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
      const config = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
      vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
      app = createHttpApp({
        config,
        runtime,
        store: new MemoryStore(),
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
        channels: { broker: vault, sandbox: false, bankFeedHosted: { bank_tingee: adapter } },
        bankFeedHooks: { bank_tingee: adapter },
        bankFeedHookLimit: new RateLimiter({ perMinute: 1000 }),
        bankFeedHookBudget: new RateLimiter({ perMinute: 1000 }),
      });
      for (const who of [owner, adminUser, member, outsider]) {
        const me = await rpc('me/get', await tokenFor(who), undefined, null);
        expect(me.status).toBe(200);
        who.userId = String(me.body?.userId);
      }
      const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty nhận thông báo', idempotencyKey: randomUUID() }, null);
      slug = String(created.body?.slug);
      orgId = String(created.body?.orgId);
      await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser.userId, member.userId]);
      const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
      otherSlug = String(other.body?.slug);
      otherOrgId = String(other.body?.orgId);
      const connect = connectChannel;
      connectionId = await connect(orgId, owner.userId);
      otherConnectionId = await connect(otherOrgId, outsider.userId);

      // Simulate a hook claimed before rotation and rotated right before applying 20270329040000 (#4225).
      preUpgradeConnId = await connect(otherOrgId, outsider.userId);
      const preOldKey = randomBytes(16).toString('base64url');
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [preUpgradeConnId, bankFeedHookKeyHash(preOldKey)]);
      preUpgradeHookId = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE channel_connection_id = $1', [preUpgradeConnId]))[0]?.id ?? '';
      expect(
        (await pool.query<{ put: string }>('SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [preUpgradeHookId, bankFeedHookKeyHash(preOldKey), 'pre-upgrade-req', FRESH, 'a'.repeat(128), BODY])).rows[0]?.put,
      ).toBe('accepted');
      const preClaims = await asWorker<{ hook_id: string }>('SELECT hook_id FROM ludy_finance.bank_feed_hook_claim(10)');
      expect(preClaims).toEqual([{ hook_id: preUpgradeHookId }]);
      preUpgradeClaimId = preClaims[0]!.hook_id;
      // Leave an unclaimed old-key waiting notice before rotation, then rotate before upgrading.
      expect(
        (await pool.query<{ put: string }>('SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [preUpgradeHookId, bankFeedHookKeyHash(preOldKey), preUpgradeStaleReqId, FRESH, 'a'.repeat(128), BODY])).rows[0]?.put,
      ).toBe('accepted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const preNewKey = randomBytes(16).toString('base64url');
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [preUpgradeConnId, bankFeedHookKeyHash(preNewKey)]);
      // Also leave one post-rotation notice received after rotated_at so we verify it survives upgrade and is counted in backlog.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (await pool.query<{ put: string }>('SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [preUpgradeHookId, bankFeedHookKeyHash(preNewKey), preUpgradePostReqId, FRESH, 'a'.repeat(128), BODY])).rows[0]?.put,
      ).toBe('accepted');

      // Seed a second rotated hook with 9,999 post-rotation notices (strictly after rotated_at) so after
      // preUpgradeStaleReqId is cleaned up, preUpgradePostReqId + these 9,999 rows leave exactly 10,000 waiting
      // while preUpgradeHookId keeps per-hook headroom (1 < 20) for an in-flight pre-migration put_notice overflow probe.
      const capConnId = await connect(otherOrgId, outsider.userId);
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [capConnId, bankFeedHookKeyHash(randomBytes(16).toString('base64url'))]);
      const capHookId = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE channel_connection_id = $1', [capConnId]))[0]?.id ?? '';
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [capConnId, bankFeedHookKeyHash(randomBytes(16).toString('base64url'))]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rows(
        "INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body) SELECT $1, $2, 'inflight-cap-' || n, $3, $4, $5 FROM generate_series(1, 9999) n",
        [otherOrgId, capHookId, FRESH, 'a'.repeat(128), BODY],
      );

      const cutFileName = readdirSync(MIGRATIONS).filter((n) => n.endsWith('_ludy_finance_bank_feed_hook_followups.sql'))[0]!;
      const followupsSql = readFileSync(join(MIGRATIONS, cutFileName), 'utf8');
      const migratorConn = new pg.Client({ connectionString: adminUrl });
      const appConn = await pool.connect();
      await migratorConn.connect();
      try {
        await migratorConn.query('BEGIN');
        await migratorConn.query('LOCK TABLE ludy_finance.bank_feed_hook IN ACCESS EXCLUSIVE MODE');
        const inflightPutPromise = appConn
          .query<{ put: string }>(
            'SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put',
            [preUpgradeHookId, bankFeedHookKeyHash(preNewKey), `inflight-overflow-${randomUUID()}`, FRESH, 'a'.repeat(128), BODY],
          )
          .then(
            (r) => ({ ok: true as const, put: r.rows[0]?.put }),
            (err: Error) => ({ ok: false as const, message: err.message }),
          );
        const deadline = Date.now() + 5000;
        let putWaiting = false;
        while (Date.now() < deadline) {
          const seen = await rows<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%bank_feed_hook_put_notice%') AS waiting",
          );
          if (seen[0]?.waiting) {
            putWaiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(putWaiting).toBe(true);
        await migratorConn.query(followupsSql);
        await migratorConn.query('COMMIT');
        const putOutcome = await inflightPutPromise;
        expect(putOutcome.ok).toBe(false);
        inflightPutOverflowError = putOutcome.ok ? '' : putOutcome.message;
        inflightCapCountAfterPut = (await rows<{ n: number }>('SELECT pg_catalog.count(*)::int AS n FROM ludy_finance.bank_feed_webhook_notice'))[0]!.n;
        // Verify the 17-slot counter immediately after the very first upgrade commit before idempotent migrate() re-runs.
        firstUpgradeBacklogAfterPut = (
          await rows<{ total: number }>('SELECT COALESCE(pg_catalog.sum(delta), 0)::int AS total FROM ludy_finance.bank_feed_webhook_backlog')
        )[0]!.total;
        await rows("DELETE FROM ludy_finance.bank_feed_webhook_notice WHERE request_id LIKE 'inflight-cap-%'");
        firstUpgradeBacklogAfterTrim = (
          await rows<{ total: number }>('SELECT COALESCE(pg_catalog.sum(delta), 0)::int AS total FROM ludy_finance.bank_feed_webhook_backlog')
        )[0]!.total;
        firstUpgradeNoticesAfterTrim = await notices();
      } finally {
        await migratorConn.query('ROLLBACK').catch(() => {});
        await migratorConn.end().catch(() => {});
        appConn.release();
      }

      await migrate({ adminUrl, dir: MIGRATIONS });
      // Drain and snapshot upgrade state at the end of beforeAll so subsequent tests always start with an empty queue, even under -t filters.
      postUpgradeNotices = await notices();
      postUpgradeBacklogBefore = await rows<{ total: number }>('SELECT COALESCE(pg_catalog.sum(delta), 0)::int AS total FROM ludy_finance.bank_feed_webhook_backlog');
      postUpgradeClaimed = await asWorker<{ org_id: string; hook_id: string; request_id: string; generation: number }>(
        'SELECT org_id, hook_id, request_id, generation FROM ludy_finance.bank_feed_hook_claim(10)',
      );
      postUpgradeNoticesAfter = await notices();
      postUpgradeBacklogAfter = await rows<{ total: number }>('SELECT COALESCE(pg_catalog.sum(delta), 0)::int AS total FROM ludy_finance.bank_feed_webhook_backlog');
      postUpgradePreRejectStopped = (
        await workerPool.query<{ stopped: boolean }>('SELECT ludy_finance.bank_feed_hook_reject($1::uuid) AS stopped', [preUpgradeClaimId])
      ).rows[0]?.stopped;
      postUpgradeHookAfterReject = await rows<{ rejected_count: number; stopped_at: string | null }>(
        'SELECT rejected_count, stopped_at FROM ludy_finance.bank_feed_hook WHERE id = $1',
        [preUpgradeHookId],
      );
    } finally {
      rmSync(preRoot, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('drops pre-rotation unclaimed notices on upgrade while preserving post-rotation waiting notices and rotated tokens', async () => {
    // Only the post-rotation waiting notice survives the upgrade; the unclaimed pre-rotation notice was dropped.
    expect(postUpgradeNotices).toEqual([{ hook_id: preUpgradeHookId, request_id: preUpgradePostReqId, body: BODY }]);
    expect(postUpgradeBacklogBefore).toEqual([{ total: 1 }]);
    expect(postUpgradeClaimed).toHaveLength(1);
    expect(postUpgradeClaimed[0]).toMatchObject({ org_id: otherOrgId, request_id: preUpgradePostReqId, generation: 1 });
    expect(postUpgradeClaimed[0]?.hook_id).not.toBe(preUpgradeHookId);
    expect(postUpgradeNoticesAfter).toEqual([]);
    expect(postUpgradeBacklogAfter).toEqual([{ total: 0 }]);

    // Pre-upgrade 1-arg or 2-arg rejection from pre-rotation claim never increments or stops the rotated hook.
    expect(postUpgradePreRejectStopped).toBe(false);
    expect(postUpgradeHookAfterReject).toEqual([{ rejected_count: 0, stopped_at: null }]);

    // An in-flight pre-migration bank_feed_hook_put_notice at 10,000 rows is stopped by the insert trigger cap check.
    expect(inflightPutOverflowError).toContain('BANK_FEED_HOOK_BACKLOG_FULL');
    expect(inflightCapCountAfterPut).toBe(10000);
    // The initial upgrade transaction (before migrate() idempotent re-run) seeded the exact backlog counter.
    expect(firstUpgradeBacklogAfterPut).toBe(10000);
    expect(firstUpgradeBacklogAfterTrim).toBe(1);
    expect(firstUpgradeNoticesAfterTrim).toEqual([{ hook_id: preUpgradeHookId, request_id: preUpgradePostReqId, body: BODY }]);
  });

  it('lets owners and admins set the hook, refuses a member and an outsider, and keeps only the hash of the key', async () => {
    expect((await hookSet(member)).status).toBe(403);
    expect((await hookSet(outsider)).status).not.toBe(200);
    expect(await rows('SELECT 1 FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId])).toHaveLength(0);
    const made = await hookSet(owner);
    expect(made.status).toBe(200);
    keyOwner = String(made.body.key);
    expect(made.body).toMatchObject({ provider: 'bank_tingee', created: true });
    expect(keyOwner).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = await rows<{ key_sha256: string }>('SELECT key_sha256 FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]);
    expect(stored).toEqual([{ key_sha256: bankFeedHookKeyHash(keyOwner) }]);
    // The key is in no audit row, and the status answers never carry it or its hash.
    const audit = JSON.stringify(await rows('SELECT * FROM ludy_kernel.audit_event WHERE org_id = $1', [orgId]));
    expect(audit).not.toContain(keyOwner);
    expect(audit).not.toContain(bankFeedHookKeyHash(keyOwner));
    const status = await hookStatus(adminUser);
    expect(status.status).toBe(200);
    expect(status.text).not.toContain(keyOwner);
    expect(status.text).not.toContain(bankFeedHookKeyHash(keyOwner));
    expect(status.body).toMatchObject({ exists: true, stopped: false, rejectedCount: 0 });
    expect((await hookStatus(member)).status).toBe(403);
    // A connection of another org is not found, whoever asks.
    expect((await hookSet(owner, otherConnectionId)).status).toBeGreaterThanOrEqual(400);
  });

  it('stores a notice for a known key and nothing for an unknown one; a repeated request id is a no-op', async () => {
    const id = randomUUID();
    const first = await post(keyOwner, { 'x-request-id': id });
    expect(first.status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect((await post(keyOwner, { 'x-request-id': id })).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]).toMatchObject({ request_id: id, body: BODY });
    // The key is the whole address: unknown, another shape, and another provider's all answer 404 and store nothing.
    expect((await post(randomBytes(16).toString('base64url'))).status).toBe(404);
    expect((await post('short')).status).toBe(404);
    expect((await app.request(`/api/bank-feed/bank_other/webhook/${keyOwner}`, { method: 'POST', body: BODY })).status).toBe(404);
    expect(await notices()).toHaveLength(1);
    // A body naming another org's account lands on the hook of the address, not on the org the body names: the org comes from our own row.
    const naming = await post(keyOwner, {}, JSON.stringify({ clientId: 'hook-test', orgId: otherOrgId, accountNumber: 'other' }));
    expect(naming.status).toBe(200);
    expect((await rows<{ org_id: string }>('SELECT DISTINCT org_id FROM ludy_finance.bank_feed_webhook_notice')).map((r) => r.org_id)).toEqual([orgId]);
  });

  it('refuses a stale or malformed notice and an oversize body, answers a validation challenge, and stores none of them', async () => {
    const before = (await notices()).length;
    expect(await (await post(keyOwner, { 'x-request-timestamp': '20200101000000000' })).json()).toMatchObject({ code: 'WEBHOOK_STALE' });
    expect(await (await post(keyOwner, { 'x-signature': '' })).json()).toMatchObject({ code: 'WEBHOOK_MALFORMED' });
    expect((await post(keyOwner, {}, '')).status).toBe(400);
    expect((await post(keyOwner, {}, 'x'.repeat(16 * 1024 + 1))).status).toBe(413);
    expect((await post(keyOwner, { 'webhook-type': 'url-validation' }, '')).status).toBe(200);
    expect((await post(randomBytes(16).toString('base64url'), { 'webhook-type': 'url-validation' }, '')).status).toBe(404);
    expect(await notices()).toHaveLength(before);
  });

  it('keeps the machinery tables out of reach of every login role and gives each login only its own functions', async () => {
    for (const table of ['bank_feed_hook', 'bank_feed_webhook_notice', 'bank_feed_webhook_backlog']) {
      await expect(pool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    // The worker cannot look up, put or set; the API cannot claim, reject or sweep.
    await expect(workerPool.query("SELECT * FROM ludy_finance.bank_feed_hook_lookup('bank_tingee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, 'r', 't', 's', 'b')", [randomUUID(), '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM ludy_finance.bank_feed_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_reject($1::uuid, 1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query("SELECT ludy_finance.bank_feed_notice_decode_escapes('a')")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.bank_feed_notice_decode_escapes('a')")).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query("SELECT ludy_finance.bank_feed_is_deep_json('[]')")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.bank_feed_is_deep_json('[]')")).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query("SELECT ludy_finance.bank_feed_notice_search_text('a')")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.bank_feed_notice_search_text('a')")).rejects.toMatchObject({ code: '42501' });
    // Set and status need the caller's own sealed context: called bare they refuse.
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [connectionId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
  });

  it('maintains valid unique indexes on id and COALESCE(reject_token, id) for lookup and reject filters', async () => {
    const indexes = await rows<{ indexdef: string }>(
      "SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS indexdef FROM pg_catalog.pg_index i WHERE i.indrelid = 'ludy_finance.bank_feed_hook'::regclass AND i.indisunique AND i.indisvalid",
    );
    const defs = indexes.map((r) => r.indexdef);
    expect(defs.some((d) => d.endsWith('USING btree (org_id, id)'))).toBe(true);
    expect(defs.some((d) => d.endsWith('USING btree (id)'))).toBe(true);
    expect(defs.some((d) => d.endsWith('USING btree (COALESCE(reject_token, id))'))).toBe(true);
  });

  it('claims the waiting notices and deletes them as it hands them out, with the hook, generation, and connection they belong to', async () => {
    const waiting = await notices();
    expect(waiting.length).toBeGreaterThan(0);
    const claimed = await asWorker<{ org_id: string; hook_id: string; generation: number; connection_id: string; provider: string; body: string }>(
      'SELECT * FROM ludy_finance.bank_feed_hook_claim(100)',
    );
    expect(claimed).toHaveLength(waiting.length);
    expect(claimed[0]).toMatchObject({ org_id: orgId, connection_id: connectionId, provider: 'bank_tingee', generation: 1 });
    expect(await notices()).toHaveLength(0);
    expect(await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)')).toHaveLength(0);
  });

  it('sweeps all notices older than ten minutes before bounded claim and in the nightly sweep', async () => {
    const hook = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]))[0]!.id;
    const old = async () => {
      await rows("INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) VALUES ($1, $2, $3, $4, $5, $6, now() - interval '11 minutes')", [orgId, hook, randomUUID(), FRESH, 'a'.repeat(128), BODY]);
    };
    await old();
    await old();
    await old();
    expect((await post(keyOwner)).status).toBe(200);
    // Expired notices are swept before applying p_limit = 1 so the fresh active notice is still delivered immediately.
    const claimed = await asWorker<{ org_id: string | null }>('SELECT org_id FROM ludy_finance.bank_feed_hook_claim(1)');
    expect(claimed).toEqual([{ org_id: orgId }]);
    expect(await notices()).toHaveLength(0);
    await old();
    await old();
    expect(await asWorker<{ swept: number }>('SELECT ludy_finance.bank_feed_hook_sweep() AS swept')).toEqual([{ swept: 2 }]);
    expect(await notices()).toHaveLength(0);
  });

  it('takes at most twenty waiting notices a hook and enforces the 10,000 global backlog cap without stale false positives', async () => {
    for (let i = 0; i < 20; i++) expect((await post(keyOwner)).status).toBe(200);
    expect((await post(keyOwner)).status).toBe(503);
    expect(await notices()).toHaveLength(20);
    // A retry of a notice that already waits is acknowledged even though the hook is full.
    const waiting = (await notices())[0]!.request_id;
    expect((await post(keyOwner, { 'x-request-id': waiting })).status).toBe(200);
    expect(await notices()).toHaveLength(20);
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');

    // HTTP route returns 503 when the global 10,000-row backlog is full (atomic cross-org race is covered in invariant suite).
    await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [
      otherConnectionId,
      bankFeedHookKeyHash(randomBytes(16).toString('base64url')),
    ]);
    const bulkHookId = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE channel_connection_id = $1', [otherConnectionId]))[0]!.id;
    const hookRow = (await rows<{ id: string; key_sha256: string }>('SELECT id, key_sha256 FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]))[0]!;
    await rows(
      "INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body) SELECT $1, $2, 'bulk-' || n, $3, $4, $5 FROM generate_series(1, 10000) n",
      [otherOrgId, bulkHookId, FRESH, 'a'.repeat(128), BODY],
    );
    expect(await rows<{ n: number }>('SELECT count(*)::int AS n FROM ludy_finance.bank_feed_webhook_notice')).toEqual([{ n: 10000 }]);
    expect((await post(keyOwner)).status).toBe(503);
    await rows('DELETE FROM ludy_finance.bank_feed_webhook_notice');
    // Individual inserts still keep the backlog counter fixed at 17 rows (slot 0 + delete shards 1..16).
    for (let i = 0; i < 3; i++) expect((await post(keyOwner)).status).toBe(200);
    expect(await rows<{ n: number }>('SELECT count(*)::int AS n FROM ludy_finance.bank_feed_webhook_backlog')).toEqual([{ n: 17 }]);
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');

    // Concurrent open worker claim transactions on disjoint notices never block one another or concurrent put_notice inserts.
    await rows(
      'INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body) VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $4, $5, $6)',
      [otherOrgId, preUpgradeHookId, `open-claim-a-${randomUUID()}`, FRESH, 'a'.repeat(128), BODY, orgId, hookRow.id, `open-claim-b-${randomUUID()}`],
    );
    const workerClientA = await workerPool.connect();
    const workerClientB = await workerPool.connect();
    const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 3000))]);
    try {
      await workerClientA.query('BEGIN');
      const openClaimA = await workerClientA.query('SELECT * FROM ludy_finance.bank_feed_hook_claim(1)');
      expect(openClaimA.rows).toHaveLength(1);

      await workerClientB.query('BEGIN');
      const openClaimB = await withTimeout(workerClientB.query('SELECT * FROM ludy_finance.bank_feed_hook_claim(1)'), 'second concurrent worker claim');
      expect(openClaimB.rows).toHaveLength(1);
      expect(openClaimB.rows[0]?.hook_id).not.toBe(openClaimA.rows[0]?.hook_id);

      const concurrentPut = await withTimeout(Promise.resolve(post(keyOwner)), 'concurrent put_notice while two worker claims stay open');
      expect(concurrentPut.status).toBe(200);

      await workerClientA.query('COMMIT');
      await workerClientB.query('COMMIT');
    } finally {
      await workerClientA.query('ROLLBACK').catch(() => {});
      await workerClientB.query('ROLLBACK').catch(() => {});
      workerClientA.release();
      workerClientB.release();
    }
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
  });

  it('stops the hook after ten refused notices in an hour, binds rejections to hook generation across rotation, and guards pre-upgrade rotations', async () => {
    // Pre-upgrade rotated hook got a backfilled reject_token so its pre-migration claim id cannot increment or stop the rotated hook.
    expect((await workerPool.query<{ stopped: boolean }>('SELECT ludy_finance.bank_feed_hook_reject($1::uuid) AS stopped', [preUpgradeClaimId])).rows[0]?.stopped).toBe(false);
    expect(await rows<{ rejected_count: number; stopped_at: string | null }>('SELECT rejected_count, stopped_at FROM ludy_finance.bank_feed_hook WHERE id = $1', [preUpgradeHookId])).toEqual([
      { rejected_count: 0, stopped_at: null },
    ]);

    const hook = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]))[0]!.id;
    expect((await post(keyOwner)).status).toBe(200);
    const [preRotation] = await asWorker<{ hook_id: string; generation: number }>('SELECT hook_id, generation FROM ludy_finance.bank_feed_hook_claim(100)');
    expect(preRotation?.generation).toBe(1);
    for (let i = 1; i < 10; i++) {
      expect(await rejectBankFeedHook(createDb(workerPool), preRotation!.hook_id, preRotation!.generation)).toBe(false);
    }
    expect((await hookStatus(owner)).body).toMatchObject({ rejectedCount: 9, stopped: false });
    expect(await rejectBankFeedHook(createDb(workerPool), preRotation!.hook_id, preRotation!.generation)).toBe(true);
    expect((await hookStatus(owner)).body).toMatchObject({ stopped: true });
    expect((await post(keyOwner)).status).toBe(200);
    expect(await notices()).toHaveLength(0);

    // Rotation: the new key works at once, the old one is a 404, and the count starts again.
    const rotated = await hookSet(adminUser);
    expect(rotated.body).toMatchObject({ created: false });
    const keyNew = String(rotated.body.key);
    expect(keyNew).not.toBe(keyOwner);
    // Pre-rotation rejections arriving after rotation (via 2-arg or 1-arg compatibility shim) never count against or stop the rotated hook.
    expect(await rejectBankFeedHook(createDb(workerPool), preRotation!.hook_id, preRotation!.generation)).toBe(false);
    expect((await workerPool.query<{ stopped: boolean }>('SELECT ludy_finance.bank_feed_hook_reject($1::uuid) AS stopped', [preRotation!.hook_id])).rows[0]?.stopped).toBe(false);
    expect((await hookStatus(owner)).body).toMatchObject({ stopped: false, rejectedCount: 0 });

    // A request that passed the lookup with the old key and reaches the put after the rotation stores nothing.
    const stale = await pool.query('SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [hook, bankFeedHookKeyHash(keyOwner), randomUUID(), FRESH, 'a'.repeat(128), BODY]);
    expect(stale.rows).toEqual([{ put: 'gone' }]);
    expect(await notices()).toHaveLength(0);
    expect((await post(keyOwner)).status).toBe(404);
    expect((await post(keyNew)).status).toBe(200);
    const [postRotation] = await asWorker<{ hook_id: string; generation: number }>('SELECT hook_id, generation FROM ludy_finance.bank_feed_hook_claim(100)');
    expect(postRotation?.generation).toBe(2);
    expect(postRotation?.hook_id).not.toBe(hook);
    expect((await hookStatus(owner)).body).toMatchObject({ stopped: false, rejectedCount: 0 });
    keyOwner = keyNew;
  });

  it('stops answering for a hook whose connection is closed or whose org has Finance off', async () => {
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
    expect((await post(keyOwner)).status).toBe(200);
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, connectionId]);
    expect((await post(keyOwner)).status).toBe(404);
    expect(await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)')).toEqual([
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
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, connectionId]);
    expect((await post(keyOwner)).status).toBe(200);
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
  });

  it('erases the notices that mention a person including JSON \\uXXXX escapes and non-JSON bodies (owners only), and the purge of an org takes its hook and notices', async () => {
    const body = JSON.stringify({ clientId: 'hook-test', content: `payer ${PAYER_EMAIL}` });
    const escapedEmailBody = `{"clientId":"hook-test","content":"hi \\uD83D\\uDE00 t\\u00e1m\\u0040example.vn"}`;
    const extraEscapesBody = `{"clientId":"hook-test","content":"q\\"\\/\\t\\u0000\\uD800 t\\u00e1m\\u0040example.vn"}`;
    const escapedAsciiEmailBody = `{"clientId":"hook-test","content":"payer nguoi.chuyen.khoan\\u0040example.test"}`;
    const escapedDigitsBody = `{"clientId":"hook-test","content":"phone 0901\\u00a0234\\u00a0567"}`;
    const nulSeparatedDigitsBody = `{"clientId":"hook-test","content":"ref 0901234567\\u00001"}`;
    const literalBackslashBody = `{"clientId":"hook-test","content":"\\\\u006e\\\\u0067\\\\u0075\\\\u006f\\\\u0069.chuyen.khoan\\\\u0040example.test"}`;
    const longerDigitsBody = `{"clientId":"hook-test","content":"ref 0901234567\\u0038"}`;
    const nonJsonEscapedBody = 'payer: \\nam@example.test';
    const validJsonNewlineBody = `{"clientId":"hook-test","content":"hi\\nam@example.test"}`;
    const deepNestedEscapedMatch = `${'['.repeat(7500)}"t\\u00e1m\\u0040example.vn"${']'.repeat(7500)}`;
    const deepNestedMalformed = `${'['.repeat(7500)}"hi\\nam@example.test"${']'.repeat(7499)}`;
    const deepNestedOther = `${'['.repeat(7500)}"other\\u0040test"${']'.repeat(7500)}`;
    expect((await post(keyOwner, {}, body)).status).toBe(200);
    expect((await post(keyOwner, {}, escapedAsciiEmailBody)).status).toBe(200);
    expect((await post(keyOwner, {}, escapedEmailBody)).status).toBe(200);
    expect((await post(keyOwner, {}, extraEscapesBody)).status).toBe(200);
    expect((await post(keyOwner, {}, escapedDigitsBody)).status).toBe(200);
    expect((await post(keyOwner, {}, nulSeparatedDigitsBody)).status).toBe(200);
    expect((await post(keyOwner, {}, literalBackslashBody)).status).toBe(200);
    expect((await post(keyOwner, {}, longerDigitsBody)).status).toBe(200);
    expect((await post(keyOwner, {}, nonJsonEscapedBody)).status).toBe(200);
    expect((await post(keyOwner, {}, validJsonNewlineBody)).status).toBe(200);
    expect((await post(keyOwner, {}, deepNestedEscapedMatch)).status).toBe(200);
    expect((await post(keyOwner, {}, deepNestedMalformed)).status).toBe(200);
    expect((await post(keyOwner, {}, deepNestedOther)).status).toBe(200);
    expect((await post(keyOwner)).status).toBe(200);
    expect(await notices()).toHaveLength(14);

    const asMfa = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    await expect(runtimeApi.execute('kernel.personal_data.erase', { value: PAYER_EMAIL }, { actor: asMfa(adminUser), orgId, idempotencyKey: randomUUID() })).rejects.toBeTruthy();
    expect(await notices()).toHaveLength(14);

    await runtimeApi.execute('kernel.personal_data.erase', { value: PAYER_EMAIL }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    await runtimeApi.execute('kernel.personal_data.erase', { value: 'tám@example.vn' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    await runtimeApi.execute('kernel.personal_data.erase', { value: '0901234567' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    // Erasing am@example.test clears valid JSON "hi\nam@example.test" while leaving non-JSON and deeply nested malformed \nam@ untouched.
    await runtimeApi.execute('kernel.personal_data.erase', { value: 'am@example.test' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    expect((await notices()).map((r) => r.body)).toContain(nonJsonEscapedBody);
    expect((await notices()).map((r) => r.body)).toContain(deepNestedMalformed);
    expect((await notices()).map((r) => r.body)).not.toContain(validJsonNewlineBody);
    await runtimeApi.execute('kernel.personal_data.erase', { value: 'nam@example.test' }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    const left = await notices();
    // Plain BODY, literal double-escaped \\u..., 11-digit 0901234567\u0038, and deeply nested unrelated JSON stay untouched;
    // all ten matching notices (including deeply nested valid JSON with \uXXXX escapes and deeply nested raw non-JSON) erase cleanly.
    expect(left).toHaveLength(4);
    expect(left.map((r) => r.body).sort()).toEqual([BODY, deepNestedOther, literalBackslashBody, longerDigitsBody].sort());
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');

    // The purge function names both tables (the full purge is exercised in org-purge.db.test.ts).
    const def = await rows<{ ok: boolean }>(
      "SELECT pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.bank_feed_webhook_notice' AND pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.bank_feed_hook' AS ok",
    );
    expect(def).toEqual([{ ok: true }]);
  });

  it('claims a full batch past stopped or closed hooks so the relay loop does not stop early while waiting notices remain', async () => {
    // Self-contained fixtures so this test runs cleanly in any order or with `-t`: create its own stopped hook and active hook.
    await admin((c) => c.query('DELETE FROM ludy_finance.bank_feed_webhook_notice'));
    const externalAccountId = `tingee-drain-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ clientId: 'hook-test', secretToken: 'drain-secret' }), {
      orgId,
      provider: 'bank_tingee',
      externalAccountId,
    });
    const asMfa = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const connected = await runtimeApi.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'bank_tingee', externalAccountId, displayName: 'Tingee drain', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asMfa, orgId, idempotencyKey: randomUUID() },
    );
    const activeConnId = connected.connectionId;
    const activeRes = await hookSet(owner, activeConnId);
    expect(activeRes.status).toBe(200);
    const activeHookId = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [orgId, activeConnId]))[0]!.id;

    const stoppedConnId = await connectChannel(otherOrgId, outsider.userId);
    const stoppedRes = await hookSet(outsider, stoppedConnId, otherSlug);
    expect(stoppedRes.status).toBe(200);
    const [stoppedRow] = await rows<{ id: string; generation: number }>('SELECT id, generation FROM ludy_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2', [otherOrgId, stoppedConnId]);
    const stoppedHookId = stoppedRow!.id;
    for (let i = 0; i < 10; i++) {
      await workerPool.query('SELECT ludy_finance.bank_feed_hook_reject($1::uuid, $2::int)', [stoppedHookId, stoppedRow!.generation]);
    }
    const [stoppedHook] = await rows<{ stopped_at: string | null }>('SELECT stopped_at FROM ludy_finance.bank_feed_hook WHERE id = $1', [stoppedHookId]);
    expect(stoppedHook?.stopped_at).not.toBeNull();

    const deadCount = BANK_FEED_HOOK_CLAIM + 20;
    const activeCount = BANK_FEED_HOOK_CLAIM + 50;
    await rows(
      "INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) SELECT $1, $2, 'stopped-' || n, $3, $4, $5, now() - interval '2 minutes' + (n * interval '1 millisecond') FROM generate_series(1, $6) n",
      [otherOrgId, stoppedHookId, FRESH, 'a'.repeat(128), BODY, deadCount],
    );
    await rows(
      "INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) SELECT $1, $2, 'active-' || n, $3, $4, $5, now() - interval '1 minute' + (n * interval '1 millisecond') FROM generate_series(1, $6) n",
      [orgId, activeHookId, FRESH, 'a'.repeat(128), BODY, activeCount],
    );
    // Refresh statistics on the full backlog so Postgres plans against >100 rows instead of stale stats (#5262).
    await rows('ANALYZE ludy_finance.bank_feed_webhook_notice');

    const pgBoss = new PgBoss({
      connectionString: workerUrl,
      schema: JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    pgBoss.on('error', () => {});
    await pgBoss.start();
    try {
      // Drive the exact worker drain helper across an all-dropped first batch so we prove the loop continues into active batches.
      const rounds: Array<{ claimed: number; ok: number; refused: number; dropped: number }> = [];
      await relayBankFeedHookBatches(
        {
          workerDb,
          boss: pgBoss,
          runtime: workerRuntime,
          broker: vault,
          providers: { bank_tingee: adapter },
        },
        (batch) => {
          rounds.push(batch);
        },
      );
      expect(rounds).toEqual([
        { claimed: BANK_FEED_HOOK_CLAIM, ok: 0, refused: 0, dropped: BANK_FEED_HOOK_CLAIM },
        { claimed: BANK_FEED_HOOK_CLAIM, ok: BANK_FEED_HOOK_CLAIM - 20, refused: 0, dropped: 20 },
        { claimed: 70, ok: 70, refused: 0, dropped: 0 },
      ]);
      expect(await notices()).toEqual([]);
      const enqueued = await rows<{ id: string }>(
        `SELECT id FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data->>'orgId' = $2 AND data->>'connectionId' = $3`,
        [QUEUES.bankFeedSync, orgId, activeConnId],
      );
      expect(enqueued.length).toBeGreaterThanOrEqual(1);
    } finally {
      await pgBoss.stop({ graceful: false }).catch(() => {});
    }
  });

  it('enforces p_limit deterministically after ANALYZE on a backlog exceeding one batch', async () => {
    await admin((c) => c.query('DELETE FROM ludy_finance.bank_feed_webhook_notice'));
    const limitConnId = await connectChannel(orgId, owner.userId);
    expect((await hookSet(owner, limitConnId)).status).toBe(200);
    const limitHookId = (
      await rows<{ id: string }>(
        'SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1 AND channel_connection_id = $2',
        [orgId, limitConnId],
      )
    )[0]!.id;

    const total = BANK_FEED_HOOK_CLAIM + 25;
    try {
      await rows(
        "INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) SELECT $1, $2, 'limit-' || n, $3, $4, $5, now() - interval '2 minutes' + (n * interval '1 millisecond') FROM generate_series(1, $6) n",
        [orgId, limitHookId, FRESH, 'a'.repeat(128), BODY, total],
      );
      await rows('ANALYZE ludy_finance.bank_feed_webhook_notice');

      const nullBatch = await asWorker<{ request_id: string }>('SELECT request_id FROM ludy_finance.bank_feed_hook_claim(NULL)');
      expect(nullBatch.map((r) => r.request_id)).toEqual(['limit-1']);

      const zeroBatch = await asWorker<{ request_id: string }>('SELECT request_id FROM ludy_finance.bank_feed_hook_claim(0)');
      expect(zeroBatch.map((r) => r.request_id)).toEqual(['limit-2']);

      const negBatch = await asWorker<{ request_id: string }>('SELECT request_id FROM ludy_finance.bank_feed_hook_claim(-5)');
      expect(negBatch.map((r) => r.request_id)).toEqual(['limit-3']);

      const firstBatch = await asWorker<{ request_id: string }>('SELECT request_id FROM ludy_finance.bank_feed_hook_claim($1::int)', [BANK_FEED_HOOK_CLAIM]);
      expect(firstBatch).toHaveLength(BANK_FEED_HOOK_CLAIM);
      expect(firstBatch[0]?.request_id).toBe('limit-4');
      expect(firstBatch[firstBatch.length - 1]?.request_id).toBe(`limit-${BANK_FEED_HOOK_CLAIM + 3}`);

      const remaining = await asWorker<{ request_id: string }>('SELECT request_id FROM ludy_finance.bank_feed_hook_claim($1::int)', [BANK_FEED_HOOK_CLAIM]);
      expect(remaining).toHaveLength(total - 3 - BANK_FEED_HOOK_CLAIM);
      expect(remaining[0]?.request_id).toBe(`limit-${BANK_FEED_HOOK_CLAIM + 4}`);
      expect(remaining[remaining.length - 1]?.request_id).toBe(`limit-${total}`);
      expect(await notices()).toEqual([]);
    } finally {
      await admin((c) => c.query('DELETE FROM ludy_finance.bank_feed_webhook_notice')).catch(() => {});
    }
  });

  it('accepts a post-claim replay of a valid notice and coalesces it into one pg-boss job per singleton slot via the worker relay helper', async () => {
    // Request-id deduplication covers waiting rows only: once claim deletes a notice, a valid replay with the same x-request-id
    // is accepted again, verified by collectVerifiedBankFeedHookTargets, and coalesced by PgBoss via bankFeedSyncNoticeOptions
    // into one sync job per fixed 30s slot (and pulls advance from the stored cursor).
    const externalAccountId = `tingee-replay-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ clientId: 'hook-test', secretToken: 'replay-secret' }), {
      orgId,
      provider: 'bank_tingee',
      externalAccountId,
    });
    const asMfa = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const connected = await runtimeApi.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'bank_tingee', externalAccountId, displayName: 'Tingee replay', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asMfa, orgId, idempotencyKey: randomUUID() },
    );
    const replayConnId = connected.connectionId;
    const replayHook = await hookSet(owner, replayConnId);
    expect(replayHook.status).toBe(200);
    const replayKey = String(replayHook.body.key);

    const pgBoss = new PgBoss({
      connectionString: workerUrl,
      schema: JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    pgBoss.on('error', () => {});
    await pgBoss.start();
    const setJobClock = (iso: string) =>
      admin((c) =>
        c.query(
          `CREATE OR REPLACE FUNCTION ${JOB_SCHEMA}.job_now() RETURNS timestamp with time zone LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT '${iso}'::timestamptz $$`,
        ),
      );
    const runRelayRound = () =>
      relayBankFeedHookBatch({
        workerDb,
        boss: pgBoss,
        runtime: workerRuntime,
        broker: vault,
        providers: { bank_tingee: adapter },
      });
    try {
      await admin((c) => c.query('DELETE FROM ludy_finance.bank_feed_webhook_notice'));
      // Pin pg-boss clock inside a single 30s slot so boundary timing never flakes between separate relay transactions.
      await setJobClock('2026-11-26T12:00:05Z');

      const replayReqId = randomUUID();
      expect((await post(replayKey, { 'x-request-id': replayReqId })).status).toBe(200);
      expect(await runRelayRound()).toEqual({ claimed: 1, ok: 1, refused: 0, dropped: 0 });
      expect(await notices()).toHaveLength(0);

      // Replaying the same valid request_id after claim deleted the earlier row is accepted again and coalesced by PgBoss in the same 30s slot.
      expect((await post(replayKey, { 'x-request-id': replayReqId })).status).toBe(200);
      expect(await notices()).toHaveLength(1);
      expect(await runRelayRound()).toEqual({ claimed: 1, ok: 1, refused: 0, dropped: 0 });
      expect(await notices()).toHaveLength(0);

      const expectedKey = jobKey(orgId, QUEUES.bankFeedSync, replayConnId);
      const sameSlotJobs = await rows<{ id: string; singleton_key: string | null }>(
        `SELECT id, singleton_key FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data->>'orgId' = $2 AND data->>'connectionId' = $3`,
        [QUEUES.bankFeedSync, orgId, replayConnId],
      );
      expect(sameSlotJobs).toHaveLength(1);
      expect(sameSlotJobs[0]?.singleton_key).toBe(expectedKey);

      // Advancing past the 30s singleton window lets the next valid replay enqueue a fresh pull.
      await setJobClock('2026-11-26T12:00:35Z');
      expect((await post(replayKey, { 'x-request-id': replayReqId })).status).toBe(200);
      expect(await runRelayRound()).toEqual({ claimed: 1, ok: 1, refused: 0, dropped: 0 });
      const nextSlotJobs = await rows<{ id: string; singleton_key: string | null }>(
        `SELECT id, singleton_key FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data->>'orgId' = $2 AND data->>'connectionId' = $3`,
        [QUEUES.bankFeedSync, orgId, replayConnId],
      );
      expect(nextSlotJobs).toHaveLength(2);
    } finally {
      await admin((c) =>
        c.query(
          `CREATE OR REPLACE FUNCTION ${JOB_SCHEMA}.job_now() RETURNS timestamp with time zone LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT pg_catalog.now() $$`,
        ),
      ).catch(() => {});
      await pgBoss.stop({ graceful: false }).catch(() => {});
    }
  });
});
