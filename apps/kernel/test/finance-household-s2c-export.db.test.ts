// SPDX-License-Identifier: AGPL-3.0-only
// The S2c-HKD book's Excel download (#2517 slice 2b) through the HTTP route a user calls, on PostgreSQL 17: a household on the income method gets the file while its rows are still `commentary` (the
// cells carry the provisional label; the workbook unit tests cover them) and one audit row (the entity, the book, the period, the number of entries); a household that keeps S1a only, an entity that is not
// a household and a period that is not one are refused and write no audit row. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-s2c-export-0123456789';
const ISSUER = 'crove-auth';
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

suite('the S2c-HKD book download (#2517 slice 2b)', () => {
  const dbName = `crove_test_s2c_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let slug = '';
  let orgId = '';
  let percentage = '';
  let groupOne = '';
  const owner = { subject: randomUUID(), email: 'owner@s2c-export.test', session: randomUUID() };

  const token = () =>
    new SignJWT({ role: 'authenticated', email: owner.email, session_id: owner.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const download = async (query: string) => app.request(`/api/export/household-s2c.xlsx?${query}`, { headers: { authorization: `Bearer ${await token()}`, 'x-crove-org': slug } });
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
    // The seeded law rows are `confirmed` from #3710 (finance-household.db.test.ts checks that). This file exercises the provisional label, so it starts from the rows as they were before:
    // `commentary`, restored here as the database owner (the law tables are read-only to every tenant login).
    // The yearly revenue threshold and the PIT cut are set to 0 here: these files test the books' rows, splits, labels and Excel with small revenues, so every revenue is above the threshold and the tax is the plain
    // percentage of it, as before the yearly rule (#3710 slice 3). That rule has its own file, finance-household-annual.db.test.ts, on the real rows (1 billion VND, PIT cut 30%).
    const restore = new pg.Client({ connectionString: adminUrl });
    await restore.connect();
    await restore.query(
      "UPDATE crove_finance.household_threshold SET amount = 0 WHERE code = 'no_tax_revenue'; UPDATE crove_finance.household_tax_reduction SET cut_percent = 0 WHERE kind = 'pit'; UPDATE crove_finance.household_trade_rate SET status = 'commentary'; UPDATE crove_finance.household_form_version SET status = 'commentary'; UPDATE crove_finance.household_return_form_version SET status = 'commentary'",
    );
    await restore.end();
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
      body: JSON.stringify({ json: { name: 'Công ty Sổ Hộ', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    percentage = randomUUID();
    groupOne = randomUUID();
    await admin(async (a) => {
      const user = (await a.query<{ user_id: string }>("SELECT user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'", [orgId])).rows[0]?.user_id;
      for (const [id, name, group, method] of [[percentage, 'Hộ Theo Thu Nhập', 3, 'income'], [groupOne, 'Hộ Nhóm Một', 1, null]] as const) {
        await a.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, $3, 'household', $4)", [orgId, id, name, user]);
        await a.query("INSERT INTO crove_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', $3, $4, ARRAY['goods'])", [orgId, id, group, method]);
      }
      // One sale on account 511 and one expense on account 632 in September for the household on the income method; one transaction, since an entry needs its lines at commit.
      await a.query('BEGIN');
      const entry = (await a.query<{ id: string }>("INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, DATE '2026-09-12', 'Bán hàng', 'finance.journal_voucher', $2, $3) RETURNING id", [orgId, randomUUID(), percentage])).rows[0]?.id;
      await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 500000, 0), ($1, $2, 2, '511', 0, 500000)", [orgId, entry]);
      const expense = (await a.query<{ id: string }>("INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, DATE '2026-09-13', 'Mua hàng', 'finance.journal_voucher', $2, $3) RETURNING id", [orgId, randomUUID(), percentage])).rows[0]?.id;
      await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '632', 200000, 0), ($1, $2, 2, '111', 0, 200000)", [orgId, expense]);
      await a.query('COMMIT');
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

  it('answers the file while the rows are still commentary and writes one audit row', async () => {
    const response = await download(`legalEntityId=${percentage}&period=2026-09`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX);
    expect(response.headers.get('content-disposition')).toContain('so-s2c-hkd-2026-09');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // A real workbook (a zip); its cells are covered by the workbook unit tests, its figures by the query tests.
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect(await audits()).toEqual([{ book: 'S2c', legalEntityId: percentage, period: '2026-09', rows: 2 }]);
  });

  it('refuses a household that keeps S1a only, an entity that is not a household and a period that is not one, writing no audit row', async () => {
    const before = (await audits()).length;
    const one = await download(`legalEntityId=${groupOne}&period=2026-09`);
    expect(one.status).toBe(422);
    expect(await one.json()).toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    for (const query of [`legalEntityId=${percentage}&period=2026-13`, `legalEntityId=${percentage}&period=abc`, `legalEntityId=${percentage}`, 'legalEntityId=not-an-id&period=2026-09']) {
      const response = await download(query);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get('content-type')).not.toBe(XLSX);
    }
    expect(await audits()).toHaveLength(before);
  });
});
