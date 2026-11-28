// SPDX-License-Identifier: AGPL-3.0-only
// CRM contact import tax-code suggestions (issue #4990, TC3) on real PostgreSQL 17:
// - 200-row batch with 120 valid codes makes at most 50 provider calls (cache first, then TC1 rate limit); rest wait as not_looked_up
// - Rerunning preview hits 24h cache with 0 extra provider calls; every provider call runs strictly outside any DB transaction
// - Invalid codes, 12-digit citizen IDs, and rows with non-empty name + address are never looked up
// - Staged-row fill writes ONLY empty name/address fields, re-evaluates validity/duplicate status, never overwrites non-empty fields
// - Respects REVOKE UPDATE on import_row, keeps staged rows expiring at 7 days / commit / cancel, and writes counts-only audit rows
// - Enforces deployment off, org switch off, viewer/other-member/agent/unauthenticated gating, and never caches household results
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, singleCell, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { TaxLookupLimiter, TaxLookupUpstreamError, type TaxLookupProvider, type TaxLookupResult } from '@ludy/kernel';
import type {
  ImportBatch,
  ImportCommitted,
  ImportFillTaxSuggestionsResult,
  ImportPreview,
  ImportRowInput,
  ImportTaxLookupResult,
} from '@ludy/kernel-contract';
import { sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { serverRuntime } from '../src/kernel.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-crm-import-tc3-db-0123456789';
const ISSUER = 'ludy-auth';

// Synthetic test codes that do not trigger PII checks (tools/ci/pii-scan.mjs).
const ENTERPRISE_CODE = '0101234564';
const BRANCH_CODE = '0101234564-002';
const HOUSEHOLD_CODE = '0100000002';
const NOT_FOUND_CODE = '0309876546';
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

const row = (over: Partial<ImportRowInput> = {}): ImportRowInput => ({
  kind: null,
  name: '',
  taxCode: null,
  email: null,
  phone: null,
  address: null,
  ...over,
});

const batchCode = (index: number) => `010500${String(index).padStart(4, '0')}`;

const suite = ADMIN ? describe : describe.skip;

suite('TC3 CRM contact import tax-code suggestions (#4990)', () => {
  const dbName = `ludy_test_tc3_import_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let offApp: ReturnType<typeof createHttpApp>;
  let batchApp: ReturnType<typeof createHttpApp>;
  let defaultLimitApp: ReturnType<typeof createHttpApp>;
  let batchRuntime: ReturnType<typeof serverRuntime>;
  let workerRuntime: ReturnType<typeof serverRuntime>;

  const providerCalls: string[] = [];
  const defaultLimitCalls: string[] = [];
  const txActiveDuringLookup: number[] = [];
  let force429 = false;

  const owner: Account = { subject: randomUUID(), email: 'owner@tc3-import.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@tc3-import.test', session: randomUUID(), userId: '' };
  const otherMember: Account = { subject: randomUUID(), email: 'other-member@tc3-import.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@tc3-import.test', session: randomUUID(), userId: '' };
  const otherOrgOwner: Account = { subject: randomUUID(), email: 'other-org@tc3-import.test', session: randomUUID(), userId: '' };

  let orgA = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };

  async function asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  function makeProvider(recorded: string[], should429: () => boolean): TaxLookupProvider {
    return {
      id: 'casso',
      async lookup(code): Promise<TaxLookupResult> {
        recorded.push(code);
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
        txActiveDuringLookup.push(openTx);
        if (should429()) {
          throw new TaxLookupUpstreamError('rate_limited', 'Upstream 429 in TC3 test', 30);
        }
        if (code === HOUSEHOLD_CODE) {
          return {
            found: true,
            taxCode: HOUSEHOLD_CODE,
            name: 'Hộ kinh doanh Lan Hương',
            address: '15 Hàng Bông, Hà Nội',
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
          name: `Công ty TNHH Gợi Ý ${code}`,
          address: `Số ${code.slice(-3)} Lê Lợi, Quận 1, TP.HCM`,
          statusText: 'Đang hoạt động',
          source: 'casso',
          household: false,
        };
      },
    };
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc<T = Record<string, unknown>>(
    target: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account | null,
    input: unknown,
    slug: string | null = orgA.slug,
    options: { mfa?: boolean } = {},
  ): Promise<{ status: number; body: T & { code?: string } }> {
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
    const parsed = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return {
      status: response.status,
      body: (parsed && 'json' in parsed ? parsed.json : parsed) as T & { code?: string },
    };
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
      CASSO_CLIENT_ID: 'tc3-app-id',
      CASSO_CLIENT_SECRET: 'tc3-app-secret',
    });

    const offRuntime = serverRuntime(singleCell(db), offConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    });
    batchRuntime = serverRuntime(singleCell(db), cassoConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
      partyTaxLookup: {
        provider: makeProvider(providerCalls, () => force429),
        limiter: new TaxLookupLimiter({ orgPerHour: 100, orgPerDay: 200, memberPerMinute: 100 }),
      },
    });
    const defaultLimitRuntime = serverRuntime(singleCell(db), cassoConfig, {
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
      partyTaxLookup: {
        provider: makeProvider(defaultLimitCalls, () => false),
        limiter: new TaxLookupLimiter(),
      },
    });
    workerRuntime = serverRuntime(singleCell(workerDb), offConfig, {});

    const authenticate = createAuthenticator(offConfig, db);
    const store = new EmptyBlobStore();
    offApp = createHttpApp({
      config: offConfig,
      runtime: offRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      partyTaxLookup: false,
    });
    batchApp = createHttpApp({
      config: cassoConfig,
      runtime: batchRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      partyTaxLookup: true,
    });
    defaultLimitApp = createHttpApp({
      config: cassoConfig,
      runtime: defaultLimitRuntime,
      store,
      authenticate,
      pool,
      aiEnabled: false,
      partyTaxLookup: true,
    });

    for (const who of [owner, member, otherMember, viewer, otherOrgOwner]) {
      const me = await rpc(batchApp, 'me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const createdA = await rpc(batchApp, 'org/create', owner, { name: 'TC3 Org A', idempotencyKey: randomUUID() }, null);
    expect(createdA.status).toBe(200);
    orgA = { slug: String(createdA.body.slug), orgId: String(createdA.body.orgId) };

    const createdB = await rpc(batchApp, 'org/create', otherOrgOwner, { name: 'TC3 Org B', idempotencyKey: randomUUID() }, null);
    expect(createdB.status).toBe(200);
    orgB = { slug: String(createdB.body.slug), orgId: String(createdB.body.orgId) };

    for (const [who, role] of [
      [member, 'member'],
      [otherMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc(batchApp, 'org/invite', owner, { email: who.email, role }, orgA.slug, { mfa: true });
      expect(invite.status).toBe(200);
      const token = String(invite.body.acceptPath).split('#')[1];
      const accepted = await rpc(batchApp, 'invites/accept', who, { token }, null);
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

  it('enforces deployment off, org switch off, viewer/other-member/agent/unauthenticated gating', async () => {
    const staged = await rpc<ImportPreview>(offApp, 'crm/contactImport/stage', member, {
      filename: 'gate.csv',
      rows: [row({ taxCode: ENTERPRISE_CODE })],
    });
    expect(staged.status).toBe(200);
    const batchId = staged.body.batch.id;

    // Deployment off -> 404 TAX_LOOKUP_DISABLED, zero provider calls.
    expect(await rpc(offApp, 'crm/contactImport/taxLookup', member, { batchId })).toMatchObject({
      status: 404,
      body: { code: 'TAX_LOOKUP_DISABLED' },
    });

    // Org switch off -> 409 TAX_LOOKUP_ORG_DISABLED, zero provider calls.
    expect(await rpc(batchApp, 'crm/contactImport/taxLookup', member, { batchId })).toMatchObject({
      status: 409,
      body: { code: 'TAX_LOOKUP_ORG_DISABLED' },
    });

    // Enable org switch for orgA and orgB.
    expect(await rpc(batchApp, 'parties/taxLookupSwitch/set', owner, { enabled: true })).toMatchObject({ status: 200 });
    expect(await rpc(batchApp, 'parties/taxLookupSwitch/set', otherOrgOwner, { enabled: true }, orgB.slug)).toMatchObject({ status: 200 });

    // Unauthenticated, viewer, other member who did not stage, and other org are refused.
    expect(await rpc(batchApp, 'crm/contactImport/taxLookup', null, { batchId })).toMatchObject({ status: 401 });
    expect(await rpc(batchApp, 'crm/contactImport/taxLookup', viewer, { batchId })).toMatchObject({ status: 403 });
    expect(await rpc(batchApp, 'crm/contactImport/taxLookup', otherMember, { batchId })).toMatchObject({
      status: 403,
      body: { code: 'IMPORT_FORBIDDEN' },
    });
    expect(await rpc(batchApp, 'crm/contactImport/taxLookup', otherOrgOwner, { batchId }, orgB.slug)).toMatchObject({
      status: 404,
      body: { code: 'IMPORT_NOT_FOUND' },
    });

    // AI agents are refused on both candidates query and fill command.
    const installed = await batchRuntime.execute<{ agentId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant' },
      { actor: { type: 'user', userId: owner.userId, aal: 'aal2', sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) }, orgId: orgA.orgId },
    );
    const runId = randomUUID();
    await asAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, status, tainted, expires_at)
         VALUES ($1, $2, $3, 'crm', 'running', false, now() + interval '10 minutes')`,
        [orgA.orgId, runId, installed.agentId],
      ),
    );
    await expect(
      batchRuntime.query(
        'crm.import.tax_lookup_candidates',
        { batchId, deploymentEnabled: true },
        { actor: { type: 'agent', agentId: installed.agentId, runId }, orgId: orgA.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      batchRuntime.execute(
        'crm.import.fill_tax_suggestions',
        { batchId, rows: [{ rowNo: 1, name: 'Agent Guess' }] },
        { actor: { type: 'agent', agentId: installed.agentId, runId }, orgId: orgA.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(providerCalls).toEqual([]);
  });

  it('caps a 200-row batch with 120 valid codes at 50 calls outside any tx, skips invalid/12-digit/full rows, and hits cache on rerun', async () => {
    providerCalls.length = 0;
    txActiveDuringLookup.length = 0;

    // 200 rows:
    // - 1..120: valid 10-digit enterprise codes missing name and/or address
    // - 121..140: valid 10-digit codes that ALREADY have both non-empty name and non-empty address
    // - 141..160: 12-digit citizen IDs with empty name
    // - 161..180: invalid tax codes with empty name
    // - 181..200: rows without tax codes
    const rows: ImportRowInput[] = [];
    for (let i = 1; i <= 120; i += 1) {
      rows.push(
        i % 2 === 0
          ? row({ name: `Tên Sẵn ${i}`, taxCode: batchCode(i), address: null })
          : row({ name: '', taxCode: batchCode(i), address: i % 3 === 0 ? `Địa chỉ sẵn ${i}` : null }),
      );
    }
    for (let i = 121; i <= 140; i += 1) {
      rows.push(row({ name: `Đủ Tên ${i}`, taxCode: batchCode(i), address: `Đủ Địa Chỉ ${i}` }));
    }
    for (let i = 141; i <= 160; i += 1) {
      rows.push(row({ name: '', taxCode: CITIZEN_ID_12 }));
    }
    for (let i = 161; i <= 180; i += 1) {
      rows.push(row({ name: '', taxCode: '12345' }));
    }
    for (let i = 181; i <= 200; i += 1) {
      rows.push(row({ name: `Không Mã ${i}`, email: `noaddr${i}@tc3-import.test` }));
    }

    const staged = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', member, {
      filename: 'batch-200.csv',
      rows,
    });
    expect(staged.status).toBe(200);
    expect(staged.body.batch.totalRows).toBe(200);

    const first = await rpc<ImportTaxLookupResult>(batchApp, 'crm/contactImport/taxLookup', member, {
      batchId: staged.body.batch.id,
    });
    expect(first.status).toBe(200);
    expect(first.body.expired).toBe(false);
    expect(first.body.providerCalls).toBe(50);
    expect(first.body.lookedUpRows).toBe(50);
    expect(first.body.stopReason).toBe('batch_limit');
    expect(first.body.items).toHaveLength(120);
    expect(providerCalls).toHaveLength(50);
    // Every external lookup ran with zero active DB transactions on ludy_app.
    expect(txActiveDuringLookup.every((n) => n === 0)).toBe(true);

    const byRow = new Map(first.body.items.map((item) => [item.rowNo, item]));
    expect(byRow.get(1)).toMatchObject({
      status: 'suggested',
      suggestedName: `Công ty TNHH Gợi Ý ${batchCode(1)}`,
      suggestedAddress: `Số 001 Lê Lợi, Quận 1, TP.HCM`,
    });
    // Row 2 had non-empty name: only empty address is suggested, never name.
    expect(byRow.get(2)).toMatchObject({
      status: 'suggested',
      suggestedName: null,
      suggestedAddress: `Số 002 Lê Lợi, Quận 1, TP.HCM`,
    });
    // Row 3 had non-empty address: only empty name is suggested, never address.
    expect(byRow.get(3)).toMatchObject({
      status: 'suggested',
      suggestedName: `Công ty TNHH Gợi Ý ${batchCode(3)}`,
      suggestedAddress: null,
    });
    // Rows 51..120 wait as not_looked_up ("chưa tra").
    for (let r = 51; r <= 120; r += 1) {
      expect(byRow.get(r)).toMatchObject({ status: 'not_looked_up', suggestedName: null, suggestedAddress: null });
    }
    // Rows 121..200 (already full, 12-digit citizen ID, invalid tax code, no tax code) were never eligible or looked up.
    for (let r = 121; r <= 200; r += 1) {
      expect(byRow.get(r)).toBeUndefined();
    }

    // Running preview again (re-staging the same 200-row file) hits the 24h cache and makes 0 provider calls.
    providerCalls.length = 0;
    const restaged = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', member, {
      filename: 'batch-200-rerun.csv',
      rows,
    });
    expect(restaged.status).toBe(200);
    const rerun = await rpc<ImportTaxLookupResult>(batchApp, 'crm/contactImport/taxLookup', member, {
      batchId: restaged.body.batch.id,
    });
    expect(rerun.status).toBe(200);
    expect(rerun.body.providerCalls).toBe(0);
    expect(rerun.body.lookedUpRows).toBe(50);
    expect(rerun.body.stopReason).toBe('batch_limit');
    expect(providerCalls).toEqual([]);
    expect(rerun.body.items.slice(0, 50).every((item) => item.cached && item.status === 'suggested')).toBe(true);
    expect(rerun.body.items.slice(50).every((item) => item.status === 'not_looked_up')).toBe(true);
  });

  it('stops gracefully at TC1 rate limit, never caches household results, and preserves 1h negative cache', async () => {
    defaultLimitCalls.length = 0;

    // With default TC1 limiter (memberPerMinute = 10), a 15-code batch stops at 10 calls and marks the remaining 5 not_looked_up.
    const rateRows: ImportRowInput[] = Array.from({ length: 15 }, (_, i) =>
      row({ taxCode: `030000${String(i + 1).padStart(4, '0')}` }),
    );
    const rateStaged = await rpc<ImportPreview>(defaultLimitApp, 'crm/contactImport/stage', owner, {
      filename: 'rate-limit.csv',
      rows: rateRows,
    });
    expect(rateStaged.status).toBe(200);
    const rateLookup = await rpc<ImportTaxLookupResult>(defaultLimitApp, 'crm/contactImport/taxLookup', owner, {
      batchId: rateStaged.body.batch.id,
    });
    expect(rateLookup.status).toBe(200);
    expect(rateLookup.body.providerCalls).toBe(10);
    expect(rateLookup.body.lookedUpRows).toBe(10);
    expect(rateLookup.body.stopReason).toBe('rate_limit');
    expect(rateLookup.body.items.slice(10).every((i) => i.status === 'not_looked_up')).toBe(true);
    expect(defaultLimitCalls).toHaveLength(10);

    // Household & not-found handling on batchApp: household never cached in tax_lookup_cache; not_found cached 1h.
    providerCalls.length = 0;
    const specialStaged = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', owner, {
      filename: 'special.csv',
      rows: [
        row({ taxCode: HOUSEHOLD_CODE }),
        row({ taxCode: NOT_FOUND_CODE }),
        row({ taxCode: '0101234564002' }),
      ],
    });
    const specialLookup = await rpc<ImportTaxLookupResult>(batchApp, 'crm/contactImport/taxLookup', owner, {
      batchId: specialStaged.body.batch.id,
    });
    expect(specialLookup.status).toBe(200);
    expect(specialLookup.body.items).toMatchObject([
      { rowNo: 1, taxCode: HOUSEHOLD_CODE, status: 'suggested', household: true, cached: false },
      { rowNo: 2, taxCode: NOT_FOUND_CODE, status: 'not_found', cached: false },
      { rowNo: 3, taxCode: BRANCH_CODE, status: 'suggested', household: false, cached: false },
    ]);

    const hhRows = await asAdmin(
      async (c) => (await c.query(`SELECT id FROM ludy_kernel.tax_lookup_cache WHERE org_id = $1 AND tax_code = $2`, [orgA.orgId, HOUSEHOLD_CODE])).rows,
    );
    expect(hhRows).toEqual([]);

    // Upstream 429 triggers backoff and leaves rows as not_looked_up without throwing.
    force429 = true;
    const backoffStaged = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', owner, {
      filename: 'backoff.csv',
      rows: [row({ taxCode: '0109990001' })],
    });
    const backoffLookup = await rpc<ImportTaxLookupResult>(batchApp, 'crm/contactImport/taxLookup', owner, {
      batchId: backoffStaged.body.batch.id,
    });
    force429 = false;
    expect(backoffLookup.status).toBe(200);
    expect(backoffLookup.body.stopReason).toBe('unavailable');
    expect(backoffLookup.body.items[0]).toMatchObject({ rowNo: 1, status: 'not_looked_up' });
  });

  it('fills only empty name/address fields on staged rows, re-evaluates outcomes, leaves non-empty untouched, commits cleanly, and writes counts-only audits', async () => {
    // Seed an existing party matching row 3 by tax code so re-evaluation detects DUPLICATE_TAX_CODE cleanly.
    const existingDup = await rpc(batchApp, 'parties/create', owner, {
      kind: 'organization',
      name: 'Công ty Đã Có',
      taxCode: '0108880003',
    });
    expect(existingDup.status).toBe(200);

    const staged = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', member, {
      filename: 'fill-test.csv',
      rows: [
        // Row 1: empty name, existing address -> invalid(INVALID_NAME) -> new after fill, address preserved
        row({ name: '', taxCode: '0108880001', address: 'Địa chỉ Giữ Nguyên' }),
        // Row 2: existing name, empty address -> new, name preserved, address filled
        row({ name: 'Tên File Giữ Nguyên', taxCode: '0108880002', address: null }),
        // Row 3: empty name matching existing tax code -> invalid -> duplicate(DUPLICATE_TAX_CODE) after fill
        row({ name: '', taxCode: '0108880003', address: null }),
        // Row 4: 12-digit citizen ID -> never filled even if fillTaxSuggestions is sent directly
        row({ name: '', taxCode: CITIZEN_ID_12, address: null }),
        // Row 5: empty name + bad email -> stays invalid, reason updates from INVALID_NAME to INVALID_EMAIL
        row({ name: '', taxCode: '0108880005', email: 'not-an-email' }),
      ],
    });
    expect(staged.status).toBe(200);
    expect(staged.body.batch).toMatchObject({ newRows: 1, duplicateRows: 0, invalidRows: 4 });
    const batchId = staged.body.batch.id;

    // Fill rows 1, 2, 3, 4 (attempting overwrite on non-empty fields + attempting fill on 12-digit row 4), and 5.
    const filled = await rpc<ImportFillTaxSuggestionsResult>(batchApp, 'crm/contactImport/fillTaxSuggestions', member, {
      batchId,
      rows: [
        { rowNo: 1, name: 'Công ty Mới Từ MST 1', address: 'Địa chỉ Bị Bỏ Qua' },
        { rowNo: 2, name: 'Tên Bị Bỏ Qua', address: '100 Nguyễn Trãi, Hà Nội' },
        { rowNo: 3, name: 'Tên Mới Row 3', address: '200 Hai Bà Trưng' },
        { rowNo: 4, name: 'Không Được Điền CCCD', address: 'Không Được Điền' },
        { rowNo: 5, name: 'Công ty Email Hỏng', address: '55 Lý Tự Trọng' },
      ],
    });
    expect(filled.status).toBe(200);
    expect(filled.body.filledRows).toBe(4);
    expect(filled.body.filledName).toBe(3);
    expect(filled.body.filledAddress).toBe(3);
    expect(filled.body.batch).toMatchObject({ newRows: 2, duplicateRows: 1, conflictRows: 0, invalidRows: 2 });

    const preview = await rpc<ImportPreview>(batchApp, 'crm/contactImport/preview', member, { batchId });
    expect(preview.status).toBe(200);
    const byNo = new Map(preview.body.rows.map((r) => [r.rowNo, r]));
    expect(byNo.get(1)).toMatchObject({
      kind: 'organization',
      name: 'Công ty Mới Từ MST 1',
      address: 'Địa chỉ Giữ Nguyên',
      outcome: 'new',
      reason: null,
    });
    expect(byNo.get(2)).toMatchObject({
      kind: 'organization',
      name: 'Tên File Giữ Nguyên',
      address: '100 Nguyễn Trãi, Hà Nội',
      outcome: 'new',
    });
    expect(byNo.get(3)).toMatchObject({
      outcome: 'duplicate',
      reason: 'DUPLICATE_TAX_CODE',
      address: '200 Hai Bà Trưng',
    });
    expect(byNo.get(4)).toMatchObject({
      name: '',
      address: null,
      outcome: 'invalid',
      reason: 'INVALID_NAME',
    });
    expect(byNo.get(5)).toMatchObject({
      name: 'Công ty Email Hỏng',
      address: '55 Lý Tự Trọng',
      outcome: 'invalid',
      reason: 'INVALID_EMAIL',
    });

    // Commit creates the 2 new parties with preserved non-empty fields + filled empty fields, fills duplicate's empty address, and deletes staged rows.
    const committed = await rpc<ImportCommitted>(batchApp, 'crm/contactImport/commit', member, {
      batchId,
      onDuplicate: 'fill_empty',
      createCompanies: false,
    });
    expect(committed.status).toBe(200);
    expect(committed.body.batch).toMatchObject({ status: 'committed', createdRows: 2, updatedRows: 1 });

    const remainingStaged = await asAdmin(
      async (c) => (await c.query(`SELECT 1 FROM ludy_crm.import_row WHERE org_id = $1 AND batch_id = $2`, [orgA.orgId, batchId])).rowCount,
    );
    expect(remainingStaged).toBe(0);

    const createdParties = await asAdmin(
      async (c) =>
        (
          await c.query<{ tax_code: string; name: string; address: string | null }>(
            `SELECT tax_code, name, address FROM ludy_kernel.party WHERE org_id = $1 AND tax_code IN ('0108880001', '0108880002', '0108880003') ORDER BY tax_code`,
            [orgA.orgId],
          )
        ).rows,
    );
    expect(createdParties).toEqual([
      { tax_code: '0108880001', name: 'Công ty Mới Từ MST 1', address: 'Địa chỉ Giữ Nguyên' },
      { tax_code: '0108880002', name: 'Tên File Giữ Nguyên', address: '100 Nguyễn Trãi, Hà Nội' },
      { tax_code: '0108880003', name: 'Công ty Đã Có', address: '200 Hai Bà Trưng' },
    ]);

    // Audit rows for fill_tax_suggestions and tax_lookup_batch contain counts/IDs ONLY (never names, addresses, or tax codes).
    const audits = await asAdmin(
      async (c) =>
        (
          await c.query<{ command: string; detail: unknown }>(
            `SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('crm.import.fill_tax_suggestions', 'kernel.party.tax_lookup_batch')`,
            [orgA.orgId],
          )
        ).rows,
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(audits);
    for (const secret of ['Công ty Mới Từ MST 1', 'Địa chỉ Giữ Nguyên', 'Nguyễn Trãi', '0108880001', '0108880002', 'Hộ kinh doanh', 'Công ty TNHH Gợi Ý']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('expires staged rows filled by tax suggestions after 7 days and on cancel', async () => {
    const cancelledBatch = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', member, {
      filename: 'cancel-after-fill.csv',
      rows: [row({ name: '', taxCode: '0107770003' })],
    });
    expect(
      await rpc<ImportFillTaxSuggestionsResult>(batchApp, 'crm/contactImport/fillTaxSuggestions', member, {
        batchId: cancelledBatch.body.batch.id,
        rows: [{ rowNo: 1, name: 'Công ty Sẽ Hủy', address: '1 Đường Hủy' }],
      }),
    ).toMatchObject({ status: 200, body: { filledRows: 1 } });
    expect(await rpc<ImportBatch>(batchApp, 'crm/contactImport/cancel', member, { batchId: cancelledBatch.body.batch.id })).toMatchObject({
      status: 200,
      body: { status: 'cancelled' },
    });
    expect(
      await asAdmin(async (c) => (await c.query(`SELECT 1 FROM ludy_crm.import_row WHERE org_id = $1 AND batch_id = $2`, [orgA.orgId, cancelledBatch.body.batch.id])).rowCount),
    ).toBe(0);

    // 7-day expiry sweep deletes staged rows filled by tax suggestions.
    const agedBatch = await rpc<ImportPreview>(batchApp, 'crm/contactImport/stage', member, {
      filename: 'expire-after-fill.csv',
      rows: [row({ name: '', taxCode: '0107770002' })],
    });
    expect(
      await rpc<ImportFillTaxSuggestionsResult>(batchApp, 'crm/contactImport/fillTaxSuggestions', member, {
        batchId: agedBatch.body.batch.id,
        rows: [{ rowNo: 1, name: 'Công ty Hết Hạn' }],
      }),
    ).toMatchObject({ status: 200, body: { filledRows: 1 } });

    await asAdmin((c) =>
      c.query(`UPDATE ludy_crm.import_batch SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [
        orgA.orgId,
        agedBatch.body.batch.id,
      ]),
    );
    const expiredLookup = await rpc<ImportTaxLookupResult>(batchApp, 'crm/contactImport/taxLookup', member, {
      batchId: agedBatch.body.batch.id,
    });
    expect(expiredLookup.status).toBe(200);
    expect(expiredLookup.body.expired).toBe(true);

    const swept = await workerRuntime.execute<{ batches: number; rows: number }>(
      'crm.import.expire',
      {},
      { actor: { type: 'system', component: 'crm.import' }, orgId: orgA.orgId },
    );
    expect(swept).toEqual({ batches: 1, rows: 1 });
    expect(
      await asAdmin(async (c) => (await c.query(`SELECT 1 FROM ludy_crm.import_row WHERE org_id = $1 AND batch_id = $2`, [orgA.orgId, agedBatch.body.batch.id])).rowCount),
    ).toBe(0);
  });
});
