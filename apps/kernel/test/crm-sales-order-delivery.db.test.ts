// SPDX-License-Identifier: AGPL-3.0-only
// The delivery of a sales order line (#2697, ADR-0050 point 4, docs/plan/crm-quotes.md step Q4b) on PostgreSQL 17: a person marks a goods line delivered and the record says so once;
// a second mark, a service line, a missing line, a future date and a date before the order are refused; a delivery is taken back by a reversing row, and a line taken back is not
// delivered again; an order with a live delivery is not cancelled (by the command, and by the database when a member goes around it); a cancelled order takes none; the append-only
// table, its keys and its policy hold as the runtime's own login; cross-org isolation; and audit rows hold ids only. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  vietnamToday,
  type Deal,
  type PipelineStage,
  type Quote,
  type QuoteDecided,
  type QuoteSent,
  type SalesOrder,
  type SalesOrderDeliveryChanged,
  type SalesOrderSummary,
} from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'item', description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%', ...over });
const REASON = 'Khách đổi ý vì giá';

suite('crm sales order delivery on PostgreSQL (#2697)', () => {
  const dbName = `crove_test_crm_sales_order_delivery_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@order.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    const party = (name: string) =>
      admin((c) =>
        c
          .query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, tax_code, address) VALUES ($1, $2, 'organization', '0312345678', '12 Lê Lợi, Quận 1') RETURNING id", [orgId, name])
          .then((r) => r.rows[0]!.id),
      );
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const newDeal = async (partyId: string) => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      return exec<Deal>(member, 'crm.deal.create', { partyId, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' });
    };
    // A quote of a new deal, with its lines, sent by link as a person sends it (Q2): ready to be accepted or declined.
    const sentQuote = async (partyId: string, lines: unknown[] = [item()]): Promise<{ deal: Deal; quote: Quote }> => {
      const deal = await newDeal(partyId);
      const q = await exec<Quote>(member, 'crm.quote.save', { dealId: deal.id, lines: [] });
      const ready = await exec<Quote>(member, 'crm.quote.save', { quoteId: q.id, version: q.version, lines });
      const sent = await exec<QuoteSent>(member, 'crm.quote.send', { quoteId: ready.id, version: ready.version, via: 'link' });
      return { deal, quote: sent.quote };
    };
    const accept = (user: string, quote: Quote, extra: Record<string, unknown> = {}) => exec<QuoteDecided>(user, 'crm.quote.accept', { quoteId: quote.id, version: quote.version, ...extra });
    const orderCount = (quoteId?: string) =>
      admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_crm.sales_order WHERE org_id = $1${quoteId ? ' AND quote_id = $2' : ''}`, quoteId ? [orgId, quoteId] : [orgId]).then((r) => Number(r.rows[0]!.n)));
    return { orgId, owner, member, viewer, party, exec, query, newDeal, sentQuote, accept, orderCount };
  }

  async function as<T>(orgId: string, user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, user, orgId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // An accepted order with an item line (1) and a note line (2) unless other lines are given, and the order as read.
  async function acceptedOrder(o: Awaited<ReturnType<typeof org>>, lines: unknown[] = [item(), { kind: 'text', description: 'Giao trong 3 ngày' }]) {
    const { quote } = await o.sentQuote(await o.party('Công ty ABC'), lines);
    const decided = await o.accept(o.member, quote);
    const order = await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: decided.orderId! });
    return order;
  }
  const deliver = (o: Awaited<ReturnType<typeof org>>, user: string, orderId: string, lineNo: number, extra: Record<string, unknown> = {}) =>
    o.exec<SalesOrderDeliveryChanged>(user, 'crm.sales_order.deliver', { orderId, lineNo, ...extra });
  const undeliver = (o: Awaited<ReturnType<typeof org>>, user: string, orderId: string, lineNo: number) => o.exec<SalesOrderDeliveryChanged>(user, 'crm.sales_order.undeliver', { orderId, lineNo });
  const rows = (orgId: string, orderId: string) =>
    admin((c) => c.query<{ kind: string; line_no: number; reverses_id: string | null }>('SELECT kind, line_no, reverses_id FROM crove_crm.sales_order_delivery WHERE org_id = $1 AND order_id = $2 ORDER BY created_at, kind', [orgId, orderId]).then((r) => r.rows));

  it('marks a goods line delivered once, shows it on the order, and a second mark makes no second row', async () => {
    const o = await org();
    const order = await acceptedOrder(o);
    expect(order.deliveries).toEqual([]);
    await expect(deliver(o, o.viewer, order.id, 1)).rejects.toMatchObject({ status: 403 });
    const done = await deliver(o, o.member, order.id, 1);
    expect(done).toEqual({ orderId: order.id, lineNo: 1, delivery: { lineNo: 1, deliveredOn: vietnamToday(), reversed: false } });
    expect((await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: order.id })).deliveries).toEqual([{ lineNo: 1, deliveredOn: vietnamToday(), reversed: false }]);
    await expect(deliver(o, o.owner, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_LINE_ALREADY_DELIVERED', status: 409 });
    expect(await rows(o.orgId, order.id)).toHaveLength(1);
    // A delivery moves nothing in the order itself, and no stock table is touched (the CRM module reaches only its own and the kernel's).
    expect((await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: order.id })).status).toBe('confirmed');
  });

  it('refuses a note line, a line the order does not have, a future date, a date before the order and a bad date', async () => {
    const o = await org();
    const order = await acceptedOrder(o);
    await expect(deliver(o, o.member, order.id, 2)).rejects.toMatchObject({ code: 'ORDER_LINE_NOT_DELIVERABLE', status: 422 });
    await expect(deliver(o, o.member, order.id, 9)).rejects.toMatchObject({ code: 'ORDER_LINE_NOT_FOUND', status: 404 });
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await expect(deliver(o, o.member, order.id, 1, { deliveredOn: tomorrow })).rejects.toMatchObject({ code: 'ORDER_DELIVERY_DATE_FUTURE' });
    await expect(deliver(o, o.member, order.id, 1, { deliveredOn: '2020-01-01' })).rejects.toMatchObject({ code: 'ORDER_DELIVERY_DATE_BEFORE_ORDER' });
    await expect(deliver(o, o.member, order.id, 1, { deliveredOn: '2026-02-30' })).rejects.toBeDefined();
    await expect(deliver(o, o.member, randomUUID(), 1)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 });
    expect(await rows(o.orgId, order.id)).toEqual([]);
  });

  it('takes a delivery back with a reversing row, once, and the line is not delivered again in this slice', async () => {
    const o = await org();
    const order = await acceptedOrder(o);
    await expect(undeliver(o, o.member, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_LINE_NOT_DELIVERED', status: 409 });
    await deliver(o, o.member, order.id, 1);
    await expect(undeliver(o, o.viewer, order.id, 1)).rejects.toMatchObject({ status: 403 });
    const back = await undeliver(o, o.member, order.id, 1);
    expect(back.delivery).toEqual({ lineNo: 1, deliveredOn: vietnamToday(), reversed: true });
    const all = await rows(o.orgId, order.id);
    expect(all.map((r) => r.kind).sort()).toEqual(['delivery', 'reversal']);
    expect(all.find((r) => r.kind === 'reversal')!.reverses_id).not.toBeNull();
    await expect(undeliver(o, o.member, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_LINE_DELIVERY_REVERSED', status: 409 });
    await expect(deliver(o, o.member, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_LINE_DELIVERY_REVERSED', status: 409 });
    expect((await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: order.id })).deliveries).toEqual([{ lineNo: 1, deliveredOn: vietnamToday(), reversed: true }]);
    expect(await rows(o.orgId, order.id)).toHaveLength(2);
  });

  it('does not cancel an order with a live delivery, by the command or by the database, and a cancelled order takes no delivery', async () => {
    const o = await org();
    const order = await acceptedOrder(o);
    await deliver(o, o.member, order.id, 1);
    await expect(o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON })).rejects.toMatchObject({ code: 'ORDER_DELIVERED', status: 409 });
    // A member going around the command meets the guard.
    await expect(
      as(o.orgId, o.member, (c) =>
        c.query("UPDATE crove_crm.sales_order SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, version = version + 1 WHERE org_id = $1 AND id = $2", [o.orgId, order.id, REASON]),
      ),
    ).rejects.toThrow(/ORDER_DELIVERED/);
    // Taken back, the order may be cancelled; then it takes no delivery.
    await undeliver(o, o.member, order.id, 1);
    const cancelled = await o.exec<SalesOrderSummary>(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON });
    expect(cancelled.status).toBe('cancelled');
    await expect(deliver(o, o.member, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_CANCELLED', status: 409 });
  });

  it('holds the table as the runtime\'s own login: append-only, one delivery per line, one reversal per delivery, a reversal of its own line only, and only people who write orders insert', async () => {
    const o = await org();
    const order = await acceptedOrder(o, [item(), item({ description: 'Gói hóa đơn' }), { kind: 'text', description: 'Giao trong 3 ngày' }]);
    await deliver(o, o.member, order.id, 1);
    const delivery = (await rows(o.orgId, order.id))[0]!;
    expect(delivery.kind).toBe('delivery');
    // Nothing updates or deletes a delivery.
    for (const sql of ["UPDATE crove_crm.sales_order_delivery SET delivered_on = '2020-01-01' WHERE org_id = $1 AND order_id = $2", 'DELETE FROM crove_crm.sales_order_delivery WHERE org_id = $1 AND order_id = $2']) {
      await expect(as(o.orgId, o.member, (c) => c.query(sql, [o.orgId, order.id]))).rejects.toMatchObject({ code: '42501' });
    }
    const insert = (user: string, kind: string, lineNo: number, reverses: string | null, on: string | null) =>
      as(o.orgId, user, (c) =>
        c.query('INSERT INTO crove_crm.sales_order_delivery (org_id, order_id, line_no, kind, delivered_on, reverses_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [o.orgId, order.id, lineNo, kind, on, reverses, user]),
      );
    // A second delivery of the same line is a unique violation; a delivery of a note line, or by a viewer, or for another person, is refused by the policy.
    await expect(insert(o.member, 'delivery', 1, null, '2031-01-01')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(o.member, 'delivery', 3, null, '2031-01-01')).rejects.toMatchObject({ code: '42501' });
    await expect(insert(o.viewer, 'delivery', 1, null, '2031-01-01')).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(o.orgId, o.member, (c) => c.query("INSERT INTO crove_crm.sales_order_delivery (org_id, order_id, line_no, kind, delivered_on, created_by) VALUES ($1, $2, 1, 'delivery', '2031-01-01', $3)", [o.orgId, order.id, o.owner])),
    ).rejects.toMatchObject({ code: '42501' });
    // The shape: a delivery has a day and no reversed row, a reversal the opposite.
    await expect(insert(o.member, 'delivery', 1, null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(o.member, 'reversal', 1, randomUUID(), null)).rejects.toMatchObject({ code: '23503' });
    const id = (await admin((c) => c.query<{ id: string }>("SELECT id FROM crove_crm.sales_order_delivery WHERE org_id = $1 AND order_id = $2 AND kind = 'delivery'", [o.orgId, order.id]))).rows[0]!.id;
    // A reversal names the delivery of its own line: line 2 does not match line 1's delivery.
    await expect(insert(o.member, 'reversal', 2, id, null)).rejects.toMatchObject({ code: '23503' });
    // One reversal per delivery.
    await undeliver(o, o.member, order.id, 1);
    await expect(insert(o.member, 'reversal', 1, id, null)).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps another org out: it cannot deliver or take back, and reads nothing', async () => {
    const a = await org();
    const b = await org();
    const order = await acceptedOrder(a);
    await deliver(a, a.member, order.id, 1);
    await expect(deliver(b, b.owner, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 });
    await expect(undeliver(b, b.owner, order.id, 1)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 });
    await expect(b.query(b.member, 'crm.sales_order.get', { orderId: order.id })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 });
    expect(await as(b.orgId, b.member, async (c) => (await c.query('SELECT 1 FROM crove_crm.sales_order_delivery')).rowCount)).toBe(0);
  });

  it('writes audit rows with ids only', async () => {
    const o = await org();
    const order = await acceptedOrder(o);
    await deliver(o, o.member, order.id, 1);
    await undeliver(o, o.member, order.id, 1);
    const audit = await admin((c) =>
      c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.sales_order.%deliver' AND outcome = 'ok' ORDER BY id", [o.orgId]),
    );
    expect(audit.rows.map((r) => r.command)).toEqual(['crm.sales_order.deliver', 'crm.sales_order.undeliver']);
    const text = JSON.stringify(audit.rows);
    for (const needle of ['Công ty ABC', 'Gói kế toán', '0312345678', 'Lê Lợi']) expect(text, needle).not.toContain(needle);
  });
});
