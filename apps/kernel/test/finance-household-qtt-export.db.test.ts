// SPDX-License-Identifier: AGPL-3.0-only
// The 02/CNKD-TNCN-QTT worksheet's Excel download (#5285) through the HTTP route a user calls, on PostgreSQL 17: a household on the income method whose year is above the tax-free threshold gets the file and
// one audit row (the entity, the form, the year, the number of lines); a worksheet that is held (revenue at or under the threshold) is refused (422 HOUSEHOLD_RETURN_HELD) and writes no audit row; a household on
// the percentage method is refused (422 HOUSEHOLD_RETURN_METHOD); the amounts the household types must be whole dong; a request with no token is refused (401). The cells and the provisional label are covered
// by the workbook unit tests and the figures by finance-household-qtt.db.test.ts; this file covers the route, the roles and the audit row.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-qtt-export-0123456789';
const ISSUER = 'ludy-auth';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class MemoryStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('missing blob');
  }
  async delete() {}
}

const suite = ADMIN ? describe : describe.skip;

suite('the 02/CNKD-TNCN-QTT worksheet download (#5285)', () => {
  const dbName = `ludy_test_qtt_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let slug = '';
  let orgId = '';
  let income = '';
  let small = '';
  let percentage = '';
  const owner = { subject: randomUUID(), email: 'owner@qtt-export.test', session: randomUUID() };

  const token = () =>
    new SignJWT({ role: 'authenticated', email: owner.email, session_id: owner.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const download = async (query: string) => app.request(`/api/export/household-qtt.xlsx?${query}`, { headers: { authorization: `Bearer ${await token()}`, 'x-ludy-org': slug } });
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const audits = () =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.household.export' AND outcome = 'ok' ORDER BY occurred_at, id", [orgId])).rows.map((r) => r.detail));
  // One entry of the ledger of an entity, with its lines, in one transaction (an entry needs its lines at commit).
  const entry = (a: pg.Client, entity: string, date: string, lines: Array<[string, number, number]>) =>
    (async () => {
      await a.query('BEGIN');
      const id = (await a.query<{ id: string }>("INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, 'Sổ cái', 'finance.journal_voucher', $3, $4) RETURNING id", [orgId, date, randomUUID(), entity])).rows[0]?.id;
      let no = 1;
      for (const [account, debit, credit] of lines) await a.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, no++, account, debit, credit]);
      await a.query('COMMIT');
    })();

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db: Db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    const created = await app.request('/api/rpc/org/create', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'Công ty Quyết toán', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    income = randomUUID();
    small = randomUUID();
    percentage = randomUUID();
    await admin(async (a) => {
      const user = (await a.query<{ user_id: string }>("SELECT user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'", [orgId])).rows[0]?.user_id;
      for (const [id, name, group, method] of [[income, 'Hộ Thu Nhập', 3, 'income'], [small, 'Hộ Doanh Thu Nhỏ', 3, 'income'], [percentage, 'Hộ Tỷ Lệ', 2, 'percentage']] as const) {
        await a.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, $3, 'household', $4)", [orgId, id, name, user]);
        await a.query("INSERT INTO ludy_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', $3, $4, ARRAY['goods'])", [orgId, id, group, method]);
      }
      // 1.5 billion of revenue and 500 million of cost of goods: above the 1 billion threshold, income 1 billion, the 15% band.
      await entry(a, income, '2026-03-10', [['111', 1_500_000_000, 0], ['511', 0, 1_500_000_000]]);
      await entry(a, income, '2026-04-10', [['632', 500_000_000, 0], ['111', 0, 500_000_000]]);
      // 900 million: at or under the threshold, so the worksheet is held.
      await entry(a, small, '2026-03-10', [['111', 900_000_000, 0], ['511', 0, 900_000_000]]);
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the file and writes one audit row, with the amounts the household typed', async () => {
    const response = await download(`legalEntityId=${income}&year=2026&withheld=10000000&prepaid=50000000&noPaymentRevenue=0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX);
    expect(response.headers.get('content-disposition')).toContain('to-khai-02-cnkd-tncn-qtt-2026');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // A real workbook (a zip); its cells are covered by the workbook unit tests, its figures by the query tests.
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    // The 21 lines of part A of the form.
    expect(await audits()).toEqual([{ book: '02/CNKD-TNCN-QTT', legalEntityId: income, period: '2026', rows: 21 }]);
  });

  it('answers the file when the household typed nothing (the notes in it say so)', async () => {
    const before = (await audits()).length;
    const response = await download(`legalEntityId=${income}&year=2026`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX);
    expect((await audits()).slice(before)).toEqual([{ book: '02/CNKD-TNCN-QTT', legalEntityId: income, period: '2026', rows: 21 }]);
  });

  it('refuses a held worksheet and writes no audit row', async () => {
    const before = (await audits()).length;
    const response = await download(`legalEntityId=${small}&year=2026`);
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).not.toBe(XLSX);
    expect(await response.json()).toMatchObject({ code: 'HOUSEHOLD_RETURN_HELD' });
    expect(await audits()).toHaveLength(before);
  });

  it('refuses a household on the percentage method, which files the quarterly 01/CNKD', async () => {
    const before = (await audits()).length;
    const response = await download(`legalEntityId=${percentage}&year=2026`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'HOUSEHOLD_RETURN_METHOD' });
    expect(await audits()).toHaveLength(before);
  });

  it('refuses amounts that are not whole dong, an empty amount, a year that is not one, and an entity that is not a household', async () => {
    const before = (await audits()).length;
    const queries = [
      `legalEntityId=${income}&year=2026&withheld=0.5`,
      `legalEntityId=${income}&year=2026&prepaid=1.000.000`,
      `legalEntityId=${income}&year=2026&noPaymentRevenue=abc`,
      `legalEntityId=${income}&year=2026&withheld=-1`,
      `legalEntityId=${income}&year=2026&withheld=`,
      `legalEntityId=${income}&year=abc`,
      `legalEntityId=${income}`,
      'legalEntityId=not-an-id&year=2026',
    ];
    for (const query of queries) {
      const response = await download(query);
      expect(response.status, query).toBeGreaterThanOrEqual(400);
      expect(response.status, query).toBeLessThan(500);
      expect(response.headers.get('content-type'), query).not.toBe(XLSX);
    }
    expect(await audits()).toHaveLength(before);
  });

  it('refuses a request with no token', async () => {
    const response = await app.request(`/api/export/household-qtt.xlsx?legalEntityId=${income}&year=2026`, { headers: { 'x-ludy-org': slug } });
    expect(response.status).toBe(401);
  });
});
