// SPDX-License-Identifier: AGPL-3.0-only
// Pluggable enterprise tax-code lookup (issue #4988, TC1) on a real PostgreSQL 17, through /api/rpc,
// serverRuntime, and PostgreSQL triggers/functions:
// - TAX_LOOKUP_PROVIDER defaults to off (/api/config partyTaxLookup=false, 404 TAX_LOOKUP_DISABLED) while keeping #324 onboarding intact
// - Per-org opt-in switch (off by default, owner/admin only, SQL guard trigger, audited)
// - Role & actor gates (owner/admin/member allowed; viewer, unauthenticated, and AI agents refused)
// - 10 & 10-3 codes cached 24h (hit) / 1h (404), org-scoped, zero party writes, households never cached
// - 12-digit citizen ID refused (422 CITIZEN_ID_NOT_ALLOWED) before provider or cache
// - Org rate limits (cache hits free), 80% quota warning callback, 429 backoff -> 503 TAX_LOOKUP_UNAVAILABLE
// - Audit rows omit PII/company fields; PDPL personal_data.erase and org_purge clean org tax_lookup_cache
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, singleCell, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { TaxLookupLimiter, TaxLookupUpstreamError, type TaxLookupProvider, type TaxLookupResult } from '@ludy/kernel';
import { DomainError, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { serverRuntime } from '../src/kernel.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { getPartyTaxLookupAdapter } from '../src/tax-lookup-casso.ts';
import type { TaxCodeLookup } from '../src/tax-lookup.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-tax-lookup-tc1-db-0123456789';
const ISSUER = 'ludy-auth';

// Synthetic checksum-invalid tax codes (see PII fixture guard in tools/ci/pii-scan.mjs).
const ENTERPRISE_CODE = '0101234564';
const BRANCH_CODE = '0101234564-002';
const HOUSEHOLD_CODE = '0100000002';
const NOT_FOUND_CODE = '0309876546';
const ERASURE_PARTY_CODE = '0100000005';
const ERASURE_DIRECT_CODE = '0100000004';
const CITIZEN_ID_12 = '001090123456';

class EmptyBlobStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('unused');
  }
  async delete(): Promise<void> {}
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('TC1 enterprise tax-code lookup (#4988)', () => {
  const dbName = `ludy_test_tc1_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let offApp: ReturnType<typeof createHttpApp>;
  let cassoApp: ReturnType<typeof createHttpApp>;
  let smallQuotaApp: ReturnType<typeof createHttpApp>;
  let cassoRuntime: ReturnType<typeof serverRuntime>;
  let workerRuntime: ReturnType<typeof serverRuntime>;

  const providerCalls: string[] = [];
  const txActiveCountsDuringLookup: number[] = [];
  const quotaWarnings: Array<{ orgId: string; provider: string; usedPercent: number }> = [];
  const smallQuotaWarnings: Array<{ orgId: string; provider: string; usedPercent: number }> = [];
  let forceUpstream429 = false;
  let smallForceUpstream429 = false;

  const owner: Account = { subject: randomUUID(), email: 'owner@tc1-tax.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@tc1-tax.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@tc1-tax.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@tc1-tax.test', session: randomUUID(), userId: '' };
  const otherOwner: Account = { subject: randomUUID(), email: 'other@tc1-tax.test', session: randomUUID(), userId: '' };

  let orgA = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };

  // Existing #324 onboarding tax registry lookup must remain independent and working.
  const onboardingRegistry: TaxCodeLookup = {
    async lookup(taxCode) {
      if (taxCode.replace(/\D/g, '') !== ENTERPRISE_CODE) {
        throw new DomainError('TAX_CODE_NOT_FOUND', 404, 'not found');
      }
      return { taxCode: ENTERPRISE_CODE, name: 'CÔNG TY MẪU #324', address: '1 Phố Huế, Hà Nội' };
    },
  };

  function makeFakeCassoProvider(should429: () => boolean, recordCall = true): TaxLookupProvider {
    return {
      id: 'casso',
      async lookup(code): Promise<TaxLookupResult> {
        if (recordCall) {
          providerCalls.push(code);
          const openTx = await asAdmin(
            async (c) =>
              Number(
                (
                  await c.query<{ n: number }>(
                    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = pg_catalog.current_database() AND usename = 'ludy_app' AND state <> 'idle'`,
                  )
                ).rows[0]?.n ?? -1,
              ),
          );
          txActiveCountsDuringLookup.push(openTx);
        }
        if (should429()) {
          throw new TaxLookupUpstreamError('rate_limited', 'Upstream 429 from test Casso stub', 45);
        }
        if (code === HOUSEHOLD_CODE) {
          return {
            found: true,
            taxCode: HOUSEHOLD_CODE,
            name: 'Hộ kinh doanh Minh Anh',
            address: '22 Hàng Đào, Hà Nội',
            statusText: 'Đang hoạt động',
            source: 'casso',
            household: true,
          };
        }
        if (code === NOT_FOUND_CODE) {
          return {
            found: false,
            taxCode: NOT_FOUND_CODE,
            name: null,
            address: null,
            statusText: null,
            source: 'casso',
          };
        }
        return {
          found: true,
          taxCode: code,
          name: `Công ty TNHH Mẫu ${code}`,
          address: `Số 10 Đường Kiểm Thử ${code}, Hà Nội`,
          statusText: 'Đang hoạt động',
          source: 'casso',
          household: false,
        };
      },
    };
  }

  async function asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    target: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account | null,
    input: unknown,
    slug: string | null = orgA.slug,
    options: { mfa?: boolean } = {},
  ) {
    const token = who ? await tokenFor(who, options) : null;
    const response = await target.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        ...(slug ? { 'x-ludy-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> & { code?: string } };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appDbUrl = new URL(adminUrl);
    appDbUrl.username = 'ludy_app';
    appDbUrl.password = 'test-app-pw';
    appUrl = appDbUrl.toString();

    const workerDbUrl = new URL(adminUrl);
    workerDbUrl.username = 'ludy_worker';
    workerDbUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerDbUrl.toString(), max: 2 });
    db = createDb(pool);
    const workerDb = createDb(workerPool);

    const offConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const cassoConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      TAX_LOOKUP_PROVIDER: 'casso',
      CASSO_CLIENT_ID: 'tc1-app-id',
      CASSO_CLIENT_SECRET: 'tc1-app-secret',
    });

    const offRuntime = serverRuntime(singleCell(db), offConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    });
    cassoRuntime = serverRuntime(singleCell(db), cassoConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
      partyTaxLookup: {
        provider: makeFakeCassoProvider(() => forceUpstream429),
        limiter: new TaxLookupLimiter(),
        onQuotaWarning: (w) => quotaWarnings.push(w),
      },
    });
    const smallQuotaRuntime = serverRuntime(singleCell(db), cassoConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
      partyTaxLookup: {
        provider: makeFakeCassoProvider(() => smallForceUpstream429, false),
        limiter: new TaxLookupLimiter({ orgPerHour: 4, orgPerDay: 5, memberPerMinute: 20, backoffMs: 60_000 }),
        onQuotaWarning: (w) => smallQuotaWarnings.push(w),
      },
    });
    workerRuntime = serverRuntime(singleCell(workerDb), offConfig, {}).register({
      commands: [orgPurgeCommand({ store: new EmptyBlobStore() })],
      queries: [],
    });

    const authenticate = createAuthenticator(offConfig, db);
    const store = new EmptyBlobStore();
    offApp = createHttpApp({
      config: offConfig,
      runtime: offRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      taxLookup: onboardingRegistry,
      partyTaxLookup: false,
    });
    cassoApp = createHttpApp({
      config: cassoConfig,
      runtime: cassoRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      taxLookup: onboardingRegistry,
      partyTaxLookup: true,
    });
    smallQuotaApp = createHttpApp({
      config: cassoConfig,
      runtime: smallQuotaRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      taxLookup: onboardingRegistry,
      partyTaxLookup: true,
    });

    for (const who of [owner, adminUser, member, viewer, otherOwner]) {
      const me = await rpc(cassoApp, 'me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const createdA = await rpc(cassoApp, 'org/create', owner, { name: 'TC1 Org A', idempotencyKey: randomUUID() }, null);
    expect(createdA.status).toBe(200);
    orgA = { slug: String(createdA.body.slug), orgId: String(createdA.body.orgId) };

    const createdB = await rpc(cassoApp, 'org/create', otherOwner, { name: 'TC1 Org B', idempotencyKey: randomUUID() }, null);
    expect(createdB.status).toBe(200);
    orgB = { slug: String(createdB.body.slug), orgId: String(createdB.body.orgId) };

    for (const [who, role] of [
      [adminUser, 'admin'],
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc(cassoApp, 'org/invite', owner, { email: who.email, role }, orgA.slug, { mfa: true });
      expect(invite.status).toBe(200);
      const token = String(invite.body.acceptPath).split('#')[1];
      const accepted = await rpc(cassoApp, 'invites/accept', who, { token }, null);
      expect(accepted.status).toBe(200);
    }
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

  it('defaults to off, keeps #324 onboarding intact, and guards the per-org opt-in switch', async () => {
    const offCfg = await offApp.request('/api/config');
    expect(offCfg.status).toBe(200);
    expect(await offCfg.json()).toMatchObject({ taxCodeLookup: true, partyTaxLookup: false });

    const cassoCfg = await cassoApp.request('/api/config');
    expect(cassoCfg.status).toBe(200);
    expect(await cassoCfg.json()).toMatchObject({ taxCodeLookup: true, partyTaxLookup: true });

    // #324 onboarding still responds when partyTaxLookup provider is off.
    expect(await rpc(offApp, 'taxRegistry/lookup', member, { taxCode: ENTERPRISE_CODE }, null)).toMatchObject({
      status: 200,
      body: { taxCode: ENTERPRISE_CODE, name: 'CÔNG TY MẪU #324' },
    });

    // Default off provider answers 404 TAX_LOOKUP_DISABLED and makes zero external calls.
    expect(await rpc(offApp, 'parties/taxLookup', owner, { taxCode: ENTERPRISE_CODE }, orgA.slug)).toMatchObject({
      status: 404,
      body: { code: 'TAX_LOOKUP_DISABLED' },
    });
    expect(providerCalls).toEqual([]);

    // Per-org switch starts off for every org; viewer cannot inspect/flip and member cannot flip or use before opt-in.
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/get', member, {}, orgA.slug)).toMatchObject({
      status: 200,
      body: { enabled: false },
    });
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/get', viewer, {}, orgA.slug)).toMatchObject({ status: 403 });
    expect(await rpc(cassoApp, 'parties/taxLookup', owner, { taxCode: ENTERPRISE_CODE }, orgA.slug)).toMatchObject({
      status: 409,
      body: { code: 'TAX_LOOKUP_ORG_DISABLED' },
    });
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/set', member, { enabled: true }, orgA.slug)).toMatchObject({ status: 403 });
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/set', viewer, { enabled: true }, orgA.slug)).toMatchObject({ status: 403 });

    // Direct SQL update with member context is refused by the database trigger.
    const appConn = await pool.connect();
    try {
      await appConn.query('BEGIN');
      await enterUser(appConn, member.userId, orgA.orgId);
      await expect(
        appConn.query(`UPDATE ludy_kernel.tenant SET tax_lookup_enabled = true WHERE org_id = $1`, [orgA.orgId]),
      ).rejects.toThrow(/TAX_LOOKUP_SETTING_FORBIDDEN/);
      await appConn.query('ROLLBACK');
    } finally {
      appConn.release();
    }

    // Admin enables the org switch; action is audited with enabled/previous.
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/set', adminUser, { enabled: true }, orgA.slug)).toMatchObject({
      status: 200,
      body: { enabled: true },
    });
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/get', member, {}, orgA.slug)).toMatchObject({
      status: 200,
      body: { enabled: true },
    });
    expect(await rpc(cassoApp, 'parties/taxLookupSwitch/set', otherOwner, { enabled: true }, orgB.slug)).toMatchObject({
      status: 200,
      body: { enabled: true },
    });

    const switchAudits = await asAdmin(
      async (c) =>
        (
          await c.query<{ detail: unknown }>(
            `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.tax_lookup_switch.set' AND outcome = 'ok'`,
            [orgA.orgId],
          )
        ).rows,
    );
    expect(switchAudits.map((r) => r.detail)).toEqual([{ enabled: true, previous: false }]);
  });

  it('refuses viewers, unauthenticated callers, AI agents, 12-digit citizen IDs, and malformed codes', async () => {
    expect(await rpc(cassoApp, 'parties/taxLookup', null, { taxCode: ENTERPRISE_CODE }, orgA.slug)).toMatchObject({ status: 401 });
    expect(await rpc(cassoApp, 'parties/taxLookup', viewer, { taxCode: ENTERPRISE_CODE }, orgA.slug)).toMatchObject({ status: 403 });

    const installed = await cassoRuntime.execute<{ agentId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant' },
      { actor: { type: 'user', userId: owner.userId, aal: 'aal2', sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) }, orgId: orgA.orgId },
    );
    const runId = randomUUID();
    await asAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, status, tainted, expires_at)
         VALUES ($1, $2, $3, 'finance', 'running', false, now() + interval '10 minutes')`,
        [orgA.orgId, runId, installed.agentId],
      ),
    );

    expect(getPartyTaxLookupAdapter(workerRuntime)).toBeUndefined();

    await expect(
      cassoRuntime.query(
        'kernel.party.tax_lookup_prepare',
        { taxCode: ENTERPRISE_CODE, deploymentEnabled: true },
        { actor: { type: 'agent', agentId: installed.agentId, runId }, orgId: orgA.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      cassoRuntime.execute(
        'kernel.party.tax_lookup',
        {
          mode: 'miss',
          taxCode: ENTERPRISE_CODE,
          provider: 'casso',
          found: true,
          name: 'Test',
          address: null,
          statusText: null,
          source: 'casso',
          household: false,
        },
        { actor: { type: 'agent', agentId: installed.agentId, runId }, orgId: orgA.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 12-digit citizen ID and malformed codes fail cleanly without calling the provider.
    const callsBefore = providerCalls.length;
    expect(await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: CITIZEN_ID_12 }, orgA.slug)).toMatchObject({
      status: 422,
      body: { code: 'CITIZEN_ID_NOT_ALLOWED' },
    });
    expect(await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: '12345' }, orgA.slug)).toMatchObject({
      status: 422,
      body: { code: 'INVALID_TAX_CODE' },
    });
    expect(providerCalls.length).toBe(callsBefore);
  });

  it('caches hits 24h and misses 1h per org, writes zero party rows, never caches households, and writes PII-free audits', async () => {
    providerCalls.length = 0;
    txActiveCountsDuringLookup.length = 0;
    const partiesBefore = await asAdmin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM ludy_kernel.party WHERE org_id = $1`, [orgA.orgId])).rows[0].n));

    // 10-digit enterprise lookup writes cache and returns cached: false, then cache hit returns cached: true with 0 calls.
    const first = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: ` ${ENTERPRISE_CODE} ` }, orgA.slug);
    expect(first).toMatchObject({
      status: 200,
      body: {
        found: true,
        taxCode: ENTERPRISE_CODE,
        name: `Công ty TNHH Mẫu ${ENTERPRISE_CODE}`,
        address: `Số 10 Đường Kiểm Thử ${ENTERPRISE_CODE}, Hà Nội`,
        statusText: 'Đang hoạt động',
        source: 'casso',
        cached: false,
        household: false,
      },
    });
    const second = await rpc(cassoApp, 'parties/taxLookup', owner, { taxCode: ENTERPRISE_CODE }, orgA.slug);
    expect(second).toMatchObject({
      status: 200,
      body: { found: true, taxCode: ENTERPRISE_CODE, cached: true, household: false },
    });
    expect(providerCalls).toEqual([ENTERPRISE_CODE]);

    // Branch 10-3 code normalizes and caches separately.
    const branch = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: '0101234564002' }, orgA.slug);
    expect(branch).toMatchObject({ status: 200, body: { found: true, taxCode: BRANCH_CODE, cached: false } });
    expect(providerCalls).toEqual([ENTERPRISE_CODE, BRANCH_CODE]);

    // Separate org does NOT share orgA's cache entry.
    const otherOrgRes = await rpc(cassoApp, 'parties/taxLookup', otherOwner, { taxCode: ENTERPRISE_CODE }, orgB.slug);
    expect(otherOrgRes).toMatchObject({ status: 200, body: { found: true, taxCode: ENTERPRISE_CODE, cached: false } });
    expect(providerCalls).toEqual([ENTERPRISE_CODE, BRANCH_CODE, ENTERPRISE_CODE]);
    // Every external provider lookup executed outside any open ludy_app DB transaction.
    expect(txActiveCountsDuringLookup).toEqual([0, 0, 0]);

    // TTL assertions: hit ~24h, expired row refreshes cleanly, 404 negative cache ~1h.
    const hitRow = await asAdmin(
      async (c) =>
        (
          await c.query<{ ttl_seconds: number }>(
            `SELECT EXTRACT(EPOCH FROM (expires_at - fetched_at))::int AS ttl_seconds FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1 AND tax_code = $2`,
            [orgA.orgId, ENTERPRISE_CODE],
          )
        ).rows[0],
    );
    expect(hitRow?.ttl_seconds).toBeGreaterThanOrEqual(86_390);
    expect(hitRow?.ttl_seconds).toBeLessThanOrEqual(86_410);

    await asAdmin((c) =>
      c.query(
        `UPDATE ludy_kernel.tax_lookup_cache
            SET fetched_at = now() - interval '2 hours',
                expires_at = now() - interval '1 minute'
          WHERE org_id = $1 AND tax_code = $2`,
        [orgA.orgId, ENTERPRISE_CODE],
      ),
    );
    const refreshed = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: ENTERPRISE_CODE }, orgA.slug);
    expect(refreshed).toMatchObject({ status: 200, body: { found: true, cached: false } });

    const miss1 = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: NOT_FOUND_CODE }, orgA.slug);
    const miss2 = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: NOT_FOUND_CODE }, orgA.slug);
    expect(miss1).toMatchObject({ status: 200, body: { found: false, taxCode: NOT_FOUND_CODE, name: null, address: null, cached: false } });
    expect(miss2).toMatchObject({ status: 200, body: { found: false, taxCode: NOT_FOUND_CODE, cached: true } });
    const missRow = await asAdmin(
      async (c) =>
        (
          await c.query<{ ttl_seconds: number; name: string | null; address: string | null }>(
            `SELECT EXTRACT(EPOCH FROM (expires_at - fetched_at))::int AS ttl_seconds, name, address FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1 AND tax_code = $2`,
            [orgA.orgId, NOT_FOUND_CODE],
          )
        ).rows[0],
    );
    expect(missRow?.name).toBeNull();
    expect(missRow?.address).toBeNull();
    expect(missRow?.ttl_seconds).toBeGreaterThanOrEqual(3_590);
    expect(missRow?.ttl_seconds).toBeLessThanOrEqual(3_610);

    // Household lookup succeeds without writing any row to tax_lookup_cache.
    const callsBeforeHousehold = providerCalls.length;
    const hh1 = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: HOUSEHOLD_CODE }, orgA.slug);
    const hh2 = await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: HOUSEHOLD_CODE }, orgA.slug);
    expect(hh1).toMatchObject({ status: 200, body: { found: true, household: true, cached: false } });
    expect(hh2).toMatchObject({ status: 200, body: { found: true, household: true, cached: false } });
    expect(providerCalls.length).toBe(callsBeforeHousehold + 2);
    const hhRows = await asAdmin(
      async (c) => (await c.query(`SELECT id FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1 AND tax_code = $2`, [orgA.orgId, HOUSEHOLD_CODE])).rows,
    );
    expect(hhRows).toEqual([]);

    // Zero rows written to ludy_kernel.party.
    const partiesAfter = await asAdmin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM ludy_kernel.party WHERE org_id = $1`, [orgA.orgId])).rows[0].n));
    expect(partiesAfter).toBe(partiesBefore);

    // Audit rows contain metadata only (never taxCode, company name, or address).
    const audits = await asAdmin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.tax_lookup' AND outcome = 'ok'`,
            [orgA.orgId],
          )
        ).rows,
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      expect(Object.keys(row.detail).sort()).toEqual(['cached', 'codeKind', 'found', 'household', 'provider', 'quotaWarning']);
      const serialized = JSON.stringify(row.detail);
      expect(serialized).not.toContain(ENTERPRISE_CODE);
      expect(serialized).not.toContain('Hoa Sen');
      expect(serialized).not.toContain('Hộ kinh doanh');
      expect(serialized).not.toContain('Kiểm Thử');
    }
  });

  it('enforces org rate limits with free cache hits, 80% warning callback, and 429 backoff -> 503', async () => {
    smallQuotaWarnings.length = 0;

    // 4 uncached calls against smallQuotaApp (orgPerHour=4, orgPerDay=5) reach 80% daily quota warning.
    for (let i = 1; i <= 4; i += 1) {
      const code = `01000000${10 + i}`;
      const res = await rpc(smallQuotaApp, 'parties/taxLookup', member, { taxCode: code }, orgA.slug);
      expect(res.status, code).toBe(200);
      if (i < 4) expect(res.body.quotaWarning).toBeUndefined();
      else expect(res.body.quotaWarning).toBe(true);
    }
    expect(smallQuotaWarnings).toEqual([{ orgId: orgA.orgId, provider: 'casso', usedPercent: 80 }]);
    expect(quotaWarnings).toEqual([]);

    // 5th distinct code exceeds orgPerHour=4 -> 429 TAX_LOOKUP_RATE_LIMIT.
    expect(await rpc(smallQuotaApp, 'parties/taxLookup', member, { taxCode: '0100000019' }, orgA.slug)).toMatchObject({
      status: 429,
      body: { code: 'TAX_LOOKUP_RATE_LIMIT' },
    });

    // Cached lookup stays free even after org hourly limit is reached.
    expect(await rpc(smallQuotaApp, 'parties/taxLookup', member, { taxCode: '0100000011' }, orgA.slug)).toMatchObject({
      status: 200,
      body: { taxCode: '0100000011', cached: true },
    });

    // Upstream 429 on another org triggers deployment-wide backoff -> 503 TAX_LOOKUP_UNAVAILABLE.
    smallForceUpstream429 = true;
    expect(await rpc(smallQuotaApp, 'parties/taxLookup', otherOwner, { taxCode: '0100000020' }, orgB.slug)).toMatchObject({
      status: 503,
      body: { code: 'TAX_LOOKUP_UNAVAILABLE' },
    });
    smallForceUpstream429 = false;
    expect(await rpc(smallQuotaApp, 'parties/taxLookup', otherOwner, { taxCode: '0100000021' }, orgB.slug)).toMatchObject({
      status: 503,
      body: { code: 'TAX_LOOKUP_UNAVAILABLE' },
    });
  });

  it('deletes matching tax_lookup_cache rows on PDPL personal_data.erase and org_purge without touching other orgs', async () => {
    // Seed cache in both orgA and orgB for ERASURE_PARTY_CODE and ERASURE_DIRECT_CODE.
    expect(await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: ERASURE_PARTY_CODE }, orgA.slug)).toMatchObject({ status: 200 });
    expect(await rpc(cassoApp, 'parties/taxLookup', member, { taxCode: ERASURE_DIRECT_CODE }, orgA.slug)).toMatchObject({ status: 200 });
    expect(await rpc(cassoApp, 'parties/taxLookup', otherOwner, { taxCode: ERASURE_PARTY_CODE }, orgB.slug)).toMatchObject({ status: 200 });

    // Create a party in orgA holding ERASURE_PARTY_CODE + email; erasing by email also removes orgA's cached tax code.
    const partyRes = await rpc(
      cassoApp,
      'parties/create',
      member,
      {
        kind: 'organization',
        name: 'Công ty TNHH Xóa Dữ Liệu',
        taxCode: ERASURE_PARTY_CODE,
        email: 'erase-tax@tc1-tax.test',
      },
      orgA.slug,
    );
    expect(partyRes.status).toBe(200);

    expect(
      await rpc(
        cassoApp,
        'org/personalDataErase',
        owner,
        { value: 'erase-tax@tc1-tax.test', idempotencyKey: randomUUID() },
        orgA.slug,
        { mfa: true },
      ),
    ).toMatchObject({ status: 200 });

    // Erasing directly by cached tax code works even with no party row.
    expect(
      await rpc(
        cassoApp,
        'org/personalDataErase',
        owner,
        { value: ERASURE_DIRECT_CODE, idempotencyKey: randomUUID() },
        orgA.slug,
        { mfa: true },
      ),
    ).toMatchObject({ status: 200 });

    const remainingOrgAErased = await asAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT tax_code FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1 AND tax_code IN ($2, $3)`,
            [orgA.orgId, ERASURE_PARTY_CODE, ERASURE_DIRECT_CODE],
          )
        ).rows,
    );
    expect(remainingOrgAErased).toEqual([]);

    const remainingOrgB = await asAdmin(
      async (c) => (await c.query(`SELECT tax_code FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1`, [orgB.orgId])).rows,
    );
    expect(remainingOrgB.length).toBeGreaterThanOrEqual(1);

    // Offboard orgA (minDays=30 backdated) and run org_purge: orgA's remaining cache rows vanish, orgB stays untouched.
    const dayMs = 24 * 60 * 60 * 1000;
    await asAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgA.orgId]);
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'::jsonb),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}'::jsonb)`,
        [
          orgA.orgId,
          new Date(Date.now() - 40 * dayMs),
          owner.userId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 40 * dayMs),
          randomUUID(),
        ],
      );
      await c.query('COMMIT');
    });

    const purgeLogs: string[] = [];
    const exitCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: (l) => purgeLogs.push(l), error: (l) => purgeLogs.push(l) },
      [orgA.orgId, '--reason', 'TC1 org purge test'],
    );
    expect(exitCode, purgeLogs.join('\n')).toBe(0);

    const afterPurgeOrgA = await asAdmin(
      async (c) => (await c.query(`SELECT id FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1`, [orgA.orgId])).rows,
    );
    expect(afterPurgeOrgA).toEqual([]);

    const afterPurgeOrgB = await asAdmin(
      async (c) => (await c.query(`SELECT id FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1`, [orgB.orgId])).rows,
    );
    expect(afterPurgeOrgB.length).toBe(remainingOrgB.length);
  });
});
