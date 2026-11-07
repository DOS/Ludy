// SPDX-License-Identifier: AGPL-3.0-only
// The income reports of the marketplaces as stored rows (#2516, ADR-0045 points 5 and 7), on a real PostgreSQL 17: the two tables a confirmed report leaves behind, channel_settlement (one per
// entity, platform and period) and channel_settlement_line (what the platform paid for one order). What is tested is what the database itself guarantees, before any importer exists: the tables
// hold no buyer column (the exact column list is asserted), they are append-only (the append_only_row and append_only_truncate triggers are there and no tenant role holds UPDATE, DELETE or
// TRUNCATE), owners, admins and members insert and a viewer cannot, a deduction is never negative and the net is what the columns say, a period or a line is stored once, a line names an order
// of its own org, and an unknown platform is refused. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SETTLEMENT_COLUMNS = ['created_at', 'id', 'legal_entity_id', 'org_id', 'payout_ref', 'period_end', 'period_start', 'platform', 'report_net', 'reversal_of', 'source_sha256'];
const LINE_COLUMNS = [
  'adjustment',
  'commission',
  'created_at',
  'id',
  'legal_entity_id',
  'line_key',
  'net',
  'order_id',
  'org_id',
  'other',
  'payment_fee',
  'refund',
  'sales',
  'seller_discount',
  'service_fee',
  'settlement_id',
  'shipping',
  'source_row',
  'tax_withheld',
];
// What would identify a buyer: none of it may be a column of either table.
const BUYER_WORDS = /buyer|customer|phone|email|address|recipient|consignee|receiver|nguoi|khach/i;

suite('marketplace income reports as stored rows (#2516)', () => {
  const dbName = `crove_test_settlement_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let orgId = '';
  let owner = '';
  let member = '';
  let viewer = '';
  let otherOrgId = '';
  let day = 0;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  const periodDay = () => new Date(Date.UTC(2026, 0, 1 + day++)).toISOString().slice(0, 10);

  // One statement as a tenant role in the context of a user of the org, in a transaction that is rolled back on a refusal and committed otherwise. Returns the error code (empty when it ran).
  async function asTenant(user: string, org: string, text: string, values: unknown[] = []): Promise<{ code: string; rowCount: number; constraint?: string | undefined }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await enterUser(client, user, org);
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return { code: '', rowCount: result.rowCount ?? 0 };
      } catch (error) {
        await client.query('ROLLBACK');
        const e = error as { code?: string; constraint?: string };
        return { code: e.code ?? 'unknown', rowCount: 0, constraint: e.constraint };
      }
    } finally {
      client.release();
    }
  }
  const order = (org: string) =>
    admin(async (c) => {
      const id = randomUUID();
      await c.query('INSERT INTO crove_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [org, id, 'shopee', `ST${randomUUID().slice(0, 12)}`]);
      return id;
    });
  const insertSettlement = (user: string, id: string, extra: { platform?: string; start?: string; end?: string; net?: string; ref?: string | null; reversalOf?: string | null } = {}) => {
    const d = periodDay();
    return asTenant(
      user,
      orgId,
      'INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, payout_ref, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [orgId, id, extra.platform ?? 'shopee', extra.start ?? d, extra.end ?? d, extra.ref ?? null, extra.net ?? '95000', extra.reversalOf ?? null],
    );
  };
  const insertLine = (user: string, settlement: string, orderId: string, columns: Record<string, string> = {}, key = 'L1', org = orgId) => {
    const values: Record<string, string> = { sales: '100000', commission: '5000', net: '95000', ...columns };
    const names = Object.keys(values);
    return asTenant(
      user,
      org,
      `INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, ${names.join(', ')}) VALUES ($1, $2, $3, $4, $5, ${names.map((_, i) => `$${i + 6}`).join(', ')})`,
      [org, randomUUID(), settlement, orderId, key, ...names.map((n) => values[n])],
    );
  };
  const seedSettlement = async () => {
    const id = randomUUID();
    const d = periodDay();
    await admin((c) =>
      c.query('INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $4, $5)', [orgId, id, 'shopee', d, '95000']),
    );
    return id;
  };

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    owner = await identity('owner');
    orgId = (await createOrg(rt, asUser(owner), `Công ty Sàn ${randomUUID().slice(0, 6)}`)).orgId;
    const other = await identity('other');
    otherOrgId = (await createOrg(rt, asUser(other), `Công ty Khác ${randomUUID().slice(0, 6)}`)).orgId;
    member = await identity('member');
    viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const columnsOf = (table: string) =>
    admin(async (c) => (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_finance' AND table_name = $1 ORDER BY column_name", [table])).rows.map((r) => r.column_name));

  it('holds no buyer column: the two tables have exactly the columns of the allow-list', async () => {
    const settlement = await columnsOf('channel_settlement');
    const line = await columnsOf('channel_settlement_line');
    expect(settlement).toEqual(SETTLEMENT_COLUMNS);
    expect(line).toEqual(LINE_COLUMNS);
    expect([...settlement, ...line].filter((c) => BUYER_WORDS.test(c))).toEqual([]);
  });

  it('keeps no free text of a report beyond the capped payout reference and the line key', async () => {
    const { rows } = await admin((c) =>
      c.query<{ table_name: string; column_name: string; data_type: string; len: number | null }>(
        `SELECT table_name::text, column_name::text, data_type::text, character_maximum_length AS len FROM information_schema.columns
         WHERE table_schema = 'crove_finance' AND table_name IN ('channel_settlement', 'channel_settlement_line') AND data_type IN ('text', 'character varying') ORDER BY 1, 2`,
      ),
    );
    // Text columns: the platform (a union), the payout reference, the hash of the file and the line key; the last three are capped by a CHECK on their length or form.
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'channel_settlement.payout_ref',
      'channel_settlement.platform',
      'channel_settlement.source_sha256',
      'channel_settlement_line.line_key',
    ]);
    const { rows: caps } = await admin((c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid IN ('crove_finance.channel_settlement'::regclass, 'crove_finance.channel_settlement_line'::regclass) AND contype = 'c'`,
      ),
    );
    const text = caps.map((r) => r.def).join('\n');
    expect(text).toMatch(/char_length\(payout_ref\) >= 1\) AND \(char_length\(payout_ref\) <= 120/);
    expect(text).toMatch(/char_length\(line_key\) >= 1\) AND \(char_length\(line_key\) <= 120/);
    expect(text).toMatch(/source_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(text).toMatch(/platform = ANY/);
  });

  it('is append-only: the append_only_row and append_only_truncate triggers are on both tables, enabled, and refuse an update, a delete and a truncate even to the owner of the table', async () => {
    for (const table of ['channel_settlement', 'channel_settlement_line']) {
      const { rows } = await admin((c) =>
        c.query<{ name: string; enabled: string; fn: string; type: number }>(
          `SELECT t.tgname::text AS name, t.tgenabled::text AS enabled, p.proname::text AS fn, t.tgtype::int AS type
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND t.tgname IN ('append_only_row', 'append_only_truncate') ORDER BY t.tgname`,
          [`crove_finance.${table}`],
        ),
      );
      expect(rows.map((r) => r.name), `${table}: triggers`).toEqual(['append_only_row', 'append_only_truncate']);
      expect(rows.map((r) => r.fn), `${table}: function`).toEqual(['reject_mutation', 'reject_mutation']);
      expect(rows.map((r) => r.enabled), `${table}: enabled`).toEqual(['O', 'O']);
    }
    const settlement = await seedSettlement();
    const orderId = await order(orgId);
    await admin((c) =>
      c.query('INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, net) VALUES ($1, $2, $3, $4, $5, 1, 1)', [orgId, randomUUID(), settlement, orderId, 'L-own']),
    );
    for (const table of ['channel_settlement', 'channel_settlement_line']) {
      for (const statement of [`UPDATE crove_finance.${table} SET org_id = org_id`, `DELETE FROM crove_finance.${table}`, `TRUNCATE crove_finance.${table} CASCADE`]) {
        await expect(admin((c) => c.query(statement)), `${statement} as the table's owner`).rejects.toMatchObject({ message: expect.stringMatching(/append-only/i) });
      }
    }
  });

  it('lets no tenant role hold UPDATE, DELETE or TRUNCATE on either table', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string; table: string; op: string }>(
        `SELECT r::text AS role, t::text AS "table", p::text AS op
         FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant']) r, unnest(ARRAY['crove_finance.channel_settlement', 'crove_finance.channel_settlement_line']) t,
              unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p WHERE has_table_privilege(r, t, p)`,
      ),
    );
    expect(rows).toEqual([]);
    const { rows: columns } = await admin((c) =>
      c.query<{ role: string; col: string }>(
        `SELECT r::text AS role, a.attname::text AS col FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant']) r, pg_attribute a
         WHERE a.attrelid IN ('crove_finance.channel_settlement'::regclass, 'crove_finance.channel_settlement_line'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege(r, a.attrelid, a.attname, 'UPDATE')`,
      ),
    );
    expect(columns).toEqual([]);
    const settlement = await seedSettlement();
    expect((await asTenant(owner, orgId, 'UPDATE crove_finance.channel_settlement SET report_net = 0 WHERE id = $1', [settlement])).code).toBe('42501');
    expect((await asTenant(owner, orgId, 'DELETE FROM crove_finance.channel_settlement WHERE id = $1', [settlement])).code).toBe('42501');
    expect((await asTenant(owner, orgId, 'TRUNCATE crove_finance.channel_settlement CASCADE')).code).toBe('42501');
    expect((await asTenant(owner, orgId, 'UPDATE crove_finance.channel_settlement_line SET net = 0')).code).toBe('42501');
    expect((await asTenant(owner, orgId, 'DELETE FROM crove_finance.channel_settlement_line')).code).toBe('42501');
  });

  it('is inserted by an owner and a member of the org and refused to a viewer, and what is stored is the entity of the org', async () => {
    for (const [who, user] of [['owner', owner], ['member', member]] as const) {
      const orderId = await order(orgId);
      const settlement = randomUUID();
      expect(await insertSettlement(user, settlement), `${who} stores a settlement`).toEqual({ code: '', rowCount: 1 });
      expect(await insertLine(user, settlement, orderId, { sales: '120000', commission: '6000', service_fee: '2000', payment_fee: '1000', shipping: '500', tax_withheld: '1200', net: '109300' }), `${who} stores a line`).toEqual({
        code: '',
        rowCount: 1,
      });
      const { rows } = await admin((c) =>
        c.query<{ entity: string; same: boolean; net: string }>(
          `SELECT l.legal_entity_id::text AS entity, l.legal_entity_id = s.legal_entity_id AS same, l.net::text AS net
           FROM crove_finance.channel_settlement_line l JOIN crove_finance.channel_settlement s ON s.org_id = l.org_id AND s.id = l.settlement_id WHERE l.settlement_id = $1`,
          [settlement],
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ same: true, net: '109300.0000' });
    }
    const refused = randomUUID();
    expect((await insertSettlement(viewer, refused)).code, 'a viewer stores a settlement').toBe('42501');
    const settlement = await seedSettlement();
    expect((await insertLine(viewer, settlement, await order(orgId), {}, 'LV')).code, 'a viewer stores a line').toBe('42501');
  });

  it('reads only the rows of the org, and stores nothing in another org', async () => {
    const mine = await seedSettlement();
    const theirs = randomUUID();
    await admin((c) => c.query('INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $4, 0)', [otherOrgId, theirs, 'lazada', periodDay()]));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enterUser(client, owner, orgId);
      const { rows } = await client.query<{ id: string }>('SELECT id FROM crove_finance.channel_settlement WHERE id = ANY($1::uuid[])', [[mine, theirs]]);
      await client.query('ROLLBACK');
      expect(rows.map((r) => r.id)).toEqual([mine]);
    } finally {
      client.release();
    }
    expect((await asTenant(owner, orgId, 'INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $4, 0)', [otherOrgId, randomUUID(), 'shopee', periodDay()])).code).toBe('42501');
  });

  it('refuses a negative deduction, a net that is not what the columns say, and a period that ends before it starts', async () => {
    const settlement = await seedSettlement();
    const orderId = await order(orgId);
    // The net says what the columns say, so the refusal is the column's own CHECK and not the net identity.
    for (const column of ['seller_discount', 'commission', 'service_fee', 'payment_fee', 'shipping', 'tax_withheld', 'refund']) {
      const result = await insertLine(owner, settlement, orderId, { sales: '100000', commission: '0', [column]: '-1', net: '100001' }, `N-${column}`);
      expect(result.code, `a negative ${column}`).toBe('23514');
      expect(result.constraint, `a negative ${column}`).toBe(`channel_settlement_line_${column}_check`);
    }
    const negSales = await insertLine(owner, settlement, orderId, { sales: '-1', commission: '0', net: '-1' }, 'N-sales');
    expect([negSales.code, negSales.constraint], 'negative sales').toEqual(['23514', 'channel_settlement_line_sales_check']);
    expect((await insertLine(owner, settlement, orderId, { net: '95001' }, 'NET1')).code, 'a net one dong too many').toBe('23514');
    expect((await insertLine(owner, settlement, orderId, { net: '94999' }, 'NET2')).code, 'a net one dong too few').toBe('23514');
    // An adjustment is the one column that may be negative, and the net still has to say so.
    expect((await insertLine(owner, settlement, orderId, { other: '-250', net: '94750' }, 'ADJ')).code, 'a negative adjustment, net said').toBe('');
    // A refund larger than the sales gives a negative net, which is a fact of the report.
    expect((await insertLine(owner, settlement, orderId, { sales: '0', commission: '0', refund: '30000', net: '-30000' }, 'REF')).code, 'a refund with a negative net').toBe('');
    const d = periodDay();
    expect((await insertSettlement(owner, randomUUID(), { start: '2026-06-02', end: '2026-06-01' })).code, 'a period that ends first').toBe('23514');
    expect((await insertSettlement(owner, randomUUID(), { start: d, end: d })).code, 'a one day period').toBe('');
  });

  it('stores a period once per entity and platform, a line key once per settlement, and a platform of the three', async () => {
    const start = '2027-03-01';
    const end = '2027-03-31';
    expect((await insertSettlement(owner, randomUUID(), { start, end, platform: 'tiktok_shop' })).code).toBe('');
    expect((await insertSettlement(owner, randomUUID(), { start, end, platform: 'tiktok_shop' })).code, 'the same report again').toBe('23P01');
    expect((await insertSettlement(owner, randomUUID(), { start, end, platform: 'lazada' })).code, 'the same period of another platform').toBe('');
    expect((await insertSettlement(owner, randomUUID(), { platform: 'temu' })).code, 'a platform that is none of the three').toBe('23514');
    const settlement = await seedSettlement();
    const orderId = await order(orgId);
    expect((await insertLine(owner, settlement, orderId, {}, 'K1')).code).toBe('');
    expect((await insertLine(owner, settlement, orderId, {}, 'K1')).code, 'the same line key again').toBe('23505');
    expect((await insertLine(owner, settlement, orderId, {}, 'K2')).code, 'another line of the same order').toBe('');
    expect((await insertLine(owner, settlement, orderId, {}, '')).code, 'an empty line key').toBe('23514');
    expect((await insertLine(owner, settlement, orderId, {}, 'x'.repeat(121))).code, 'a line key past its cap').toBe('23514');
    expect((await insertSettlement(owner, randomUUID(), { ref: 'y'.repeat(121) })).code, 'a payout reference past its cap').toBe('23514');
  });

  it('refuses a period that overlaps another that stands, for the same entity and platform only', async () => {
    const first = randomUUID();
    expect((await insertSettlement(owner, first, { start: '2027-04-01', end: '2027-04-15' })).code).toBe('');
    expect((await insertSettlement(owner, randomUUID(), { start: '2027-04-10', end: '2027-04-30' })).code, 'a later part of it').toBe('23P01');
    expect((await insertSettlement(owner, randomUUID(), { start: '2027-03-20', end: '2027-04-01' })).code, 'an earlier part of it').toBe('23P01');
    expect((await insertSettlement(owner, randomUUID(), { start: '2027-04-05', end: '2027-04-06' })).code, 'inside it').toBe('23P01');
    expect((await insertSettlement(owner, randomUUID(), { start: '2027-04-16', end: '2027-04-30' })).code, 'the day after it').toBe('');
    expect((await insertSettlement(owner, randomUUID(), { start: '2027-04-01', end: '2027-04-15', platform: 'lazada' })).code, 'another platform').toBe('');
  });

  it('undoes a wrong confirmation by a reversal that mirrors it, once, and then takes the corrected report', async () => {
    const original = randomUUID();
    const orderId = await order(orgId);
    const period = { start: '2027-05-01', end: '2027-05-31' };
    expect((await insertSettlement(owner, original, { ...period, net: '95000' })).code).toBe('');
    expect((await insertLine(owner, original, orderId, {}, 'S1')).code).toBe('');
    const bad = [
      ['a net that is not the negative', { ...period, net: '95000' }],
      ['another period', { start: '2027-05-01', end: '2027-05-30', net: '-95000' }],
      ['another platform', { ...period, net: '-95000', platform: 'lazada' }],
    ] as const;
    for (const [why, extra] of bad) expect((await insertSettlement(owner, randomUUID(), { ...extra, reversalOf: original })).code, `a reversal with ${why}`).toBe('23514');
    const reversal = randomUUID();
    expect((await insertSettlement(owner, reversal, { ...period, net: '-95000', reversalOf: original })).code, 'the reversal').toBe('');
    expect((await insertSettlement(owner, randomUUID(), { ...period, net: '-95000', reversalOf: original })).code, 'a second reversal').toBe('23505');
    expect((await insertSettlement(owner, randomUUID(), { ...period, net: '95000', reversalOf: reversal })).code, 'a reversal of a reversal').toBe('23514');
    // Its lines repeat the original's, marked as adjustments, and nothing else.
    expect((await insertLine(owner, reversal, orderId, {}, 'S1')).code, 'a mirrored line not marked as an adjustment').toBe('23514');
    expect((await insertLine(owner, reversal, orderId, { adjustment: 'true', sales: '90000', net: '85000' }, 'S1')).code, 'a line with other figures').toBe('23514');
    expect((await insertLine(owner, reversal, orderId, { adjustment: 'true' }, 'S9')).code, 'a line the original does not have').toBe('23514');
    expect((await insertLine(owner, reversal, orderId, { adjustment: 'true' }, 'S1')).code, 'the mirrored line').toBe('');
    // The corrected report for the same period stands, its sale line is the same order and key, and a third import of the period is refused.
    const corrected = randomUUID();
    expect((await insertSettlement(owner, corrected, { ...period, net: '94000' })).code, 'the corrected report').toBe('');
    expect((await insertLine(owner, corrected, orderId, { commission: '6000', net: '94000' }, 'S1')).code, 'its sale line').toBe('');
    expect((await insertSettlement(owner, randomUUID(), { ...period, net: '94000' })).code, 'the same period a third time').toBe('23P01');
  });

  it('refuses a sale line already stored for the order and line in another settlement that stands, unless it is a marked later adjustment', async () => {
    const orderId = await order(orgId);
    const a = randomUUID();
    const b = randomUUID();
    expect((await insertSettlement(owner, a, { start: '2027-06-01', end: '2027-06-15' })).code).toBe('');
    expect((await insertSettlement(owner, b, { start: '2027-06-16', end: '2027-06-30' })).code).toBe('');
    expect((await insertLine(owner, a, orderId, {}, 'S1')).code).toBe('');
    expect((await insertLine(owner, b, orderId, {}, 'S1')).code, 'the same sale again').toBe('23505');
    expect((await insertLine(owner, b, orderId, { adjustment: 'true' }, 'S1')).code, 'marked as a later adjustment').toBe('');
    expect((await insertLine(owner, b, orderId, { sales: '0', commission: '0', refund: '30000', net: '-30000' }, 'R1')).code, 'a refund line is not a sale line').toBe('');
    const c = randomUUID();
    expect((await insertSettlement(owner, c, { start: '2027-07-01', end: '2027-07-15' })).code).toBe('');
    expect((await insertLine(owner, c, await order(orgId), {}, 'S1')).code, 'the same key of another order').toBe('');
  });

  it('names an order and a settlement of its own org, and no other', async () => {
    const settlement = await seedSettlement();
    expect((await insertLine(owner, settlement, randomUUID())).code, 'an order that is not stored').toBe('23503');
    const foreign = await order(otherOrgId);
    expect((await insertLine(owner, settlement, foreign)).code, "another org's order").toBe('23503');
    const orderId = await order(orgId);
    expect((await insertLine(owner, randomUUID(), orderId)).code, 'a settlement that is not stored').toBe('23503');
  });
});
