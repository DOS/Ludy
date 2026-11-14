// SPDX-License-Identifier: AGPL-3.0-only
// The 01/CNKD worksheet's Excel download (#2518) through the HTTP route a user calls, on PostgreSQL 17: a household on the percentage method whose rows the accountant confirmed gets the file with its
// exact figures and one audit row (the entity, the form, the quarter, the number of trade lines); a household with several trades is asked for the split (422) and gets the file with it; a household whose
// rows are still `commentary` gets neither a file nor an audit row (HOUSEHOLD_RULES_UNCONFIRMED). The cells are covered by the workbook unit tests and the figures by finance-household-return.db.test.ts; here
// the route, the roles and the audit row. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-cnkd-export-0123456789';
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

suite('the 01/CNKD worksheet download (#2518)', () => {
  const dbName = `crove_test_cnkd_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let slug = '';
  let orgId = '';
  let single = '';
  let several = '';
  let unconfirmed = '';
  const owner = { subject: randomUUID(), email: 'owner@cnkd-export.test', session: randomUUID() };

  const token = () =>
    new SignJWT({ role: 'authenticated', email: owner.email, session_id: owner.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const download = async (query: string) => app.request(`/api/export/household-cnkd.xlsx?${query}`, { headers: { authorization: `Bearer ${await token()}`, 'x-crove-org': slug } });
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
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.household.export' AND outcome = 'ok' ORDER BY occurred_at, id", [orgId])).rows.map((r) => r.detail));

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
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
      body: JSON.stringify({ json: { name: 'Công ty Tờ khai', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    single = randomUUID();
    several = randomUUID();
    unconfirmed = randomUUID();
    await admin(async (a) => {
      const user = (await a.query<{ user_id: string }>("SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'", [orgId])).rows[0]?.user_id;
      for (const [id, name, trades] of [[single, 'Hộ Một Ngành', ['goods']], [several, 'Hộ Nhiều Ngành', ['goods', 'services']], [unconfirmed, 'Hộ Chưa Xác Nhận', ['goods']]] as const) {
        await a.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, $3, 'household', $4)", [orgId, id, name, user]);
        await a.query("INSERT INTO crove_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', 2, 'percentage', $3)", [orgId, id, trades]);
        // Revenue of Q4 on account 511 (and of Q3 for the household whose rows stay unconfirmed).
        for (const date of id === unconfirmed ? ['2026-08-12'] : ['2026-11-12']) {
          // One transaction: an entry needs its lines at commit.
          await a.query('BEGIN');
          const entry = (await a.query<{ id: string }>("INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, 'Bán hàng', 'finance.journal_voucher', $3, $4) RETURNING id", [orgId, date, randomUUID(), id])).rows[0]?.id;
          await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 1600000, 0), ($1, $2, 2, '511', 0, 1600000)", [orgId, entry]);
          await a.query('COMMIT');
        }
      }
      // The accountant's confirmation is a later dated row: from 2026-10-01 the form and the percentages are confirmed, so Q4 is exportable and Q3 is not.
      await a.query("INSERT INTO crove_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES ('01/CNKD', '2026.2', DATE '2026-10-01', 'Tờ khai 01/CNKD', ARRAY['percentage'], 'test', 'confirmed') ON CONFLICT DO NOTHING");
      for (const [trade, vat, pit] of [['goods', 1, 0.5], ['services', 5, 2]] as const) {
        await a.query("INSERT INTO crove_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES ($1, DATE '2026-10-01', $2, $3, 'test', 'confirmed') ON CONFLICT DO NOTHING", [trade, vat, pit]);
      }
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

  it('answers the file and writes one audit row', async () => {
    const response = await download(`legalEntityId=${single}&year=2026&quarter=4`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX);
    expect(response.headers.get('content-disposition')).toContain('to-khai-01-cnkd-2026-Q4');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // A real workbook (a zip); its cells are covered by the workbook unit tests, its figures by the query tests.
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect(await audits()).toEqual([{ book: '01/CNKD', legalEntityId: single, period: '2026-Q4', rows: 1 }]);
  });

  it('asks a household with several trades for the split, and answers the file with it', async () => {
    const before = (await audits()).length;
    const open = await download(`legalEntityId=${several}&year=2026&quarter=4`);
    expect(open.status).toBe(422);
    expect(await open.json()).toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
    const response = await download(`legalEntityId=${several}&year=2026&quarter=4&split=goods:1000000,services:600000`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    // The refusal wrote no audit row; the file wrote one, with its two trade lines.
    expect((await audits()).slice(before)).toEqual([{ book: '01/CNKD', legalEntityId: several, period: '2026-Q4', rows: 2 }]);
  });

  it('answers no file and writes no audit row while a row behind the figures is still commentary', async () => {
    const before = (await audits()).length;
    const response = await download(`legalEntityId=${unconfirmed}&year=2026&quarter=3`);
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).not.toBe(XLSX);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'HOUSEHOLD_RULES_UNCONFIRMED' });
    expect(await audits()).toHaveLength(before);
  });

  it('refuses a year or quarter that is not one, and an entity that is not a household', async () => {
    for (const query of [`legalEntityId=${single}&year=2026&quarter=5`, `legalEntityId=${single}&year=abc&quarter=1`, `legalEntityId=${single}&quarter=1`, 'legalEntityId=not-an-id&year=2026&quarter=4']) {
      const response = await download(query);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get('content-type')).not.toBe(XLSX);
    }
  });
});
