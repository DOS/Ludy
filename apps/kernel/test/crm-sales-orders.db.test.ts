// SPDX-License-Identifier: AGPL-3.0-only
// Quote acceptance and the sales order (#2696, ADR-0050, docs/plan/crm-quotes.md step Q4) on PostgreSQL 17: a person records the customer's yes and exactly one frozen order
// is made, numbered from the kernel's gapless series; a second accept makes none; the refusals (not sent, expired, stale, a future date, tampered totals, a viewer, a caller
// that is not a person); a decline; the order's hand-off to Kế toán and its cancellation; that the database holds the line when a member goes around the commands; cross-org
// isolation; and that audit rows never hold a customer value or a reason. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
  type SalesOrderHandoff,
  type SalesOrderPage,
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

suite('crm sales orders on PostgreSQL (#2696)', () => {
  const dbName = `crove_test_crm_sales_orders_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    // A tax code is unique within an org (party_tax_code_uq), so only the org's first customer has one; the others have none.
    let customers = 0;
    const party = (name: string) =>
      admin((c) =>
        c
          .query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, tax_code, address) VALUES ($1, $2, 'organization', $3, '12 Lê Lợi, Quận 1') RETURNING id", [orgId, name, customers++ === 0 ? '0312345678' : null])
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

  it('accepts a sent quote: one frozen order with the quote\'s buyer, lines and totals, a gapless number, and a second accept makes none', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const { deal, quote } = await o.sentQuote(party, [item(), { kind: 'text', description: 'Giao trong 3 ngày' }]);
    const year = vietnamToday().slice(0, 4);
    const decided = await o.accept(o.member, quote, { acceptedVia: 'chat' });
    expect(decided).toMatchObject({ quoteId: quote.id, status: 'accepted' });
    expect(decided.orderNumber).toBe(`DH-${year}-0001`);
    const order = await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: decided.orderId });
    expect(order).toMatchObject({
      id: decided.orderId,
      number: `DH-${year}-0001`,
      quoteId: quote.id,
      quoteNumber: quote.number,
      dealId: deal.id,
      partyId: party,
      status: 'confirmed',
      orderDate: vietnamToday(),
      buyerName: 'Công ty ABC',
      buyer: { kind: 'business', name: 'Công ty ABC', taxCode: '0312345678', address: '12 Lê Lợi, Quận 1', email: null },
      currency: 'VND',
      acceptedVia: 'chat',
      subtotal: quote.subtotal,
      vatAmount: quote.vatAmount,
      total: quote.total,
      lineCount: 2,
      cancelledAt: null,
      cancelReason: null,
    });
    expect(order.lines).toEqual(quote.lines);
    const after = await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id });
    expect(after.status).toBe('accepted');
    // The same quote cannot be accepted again, with the version the caller holds or the new one; exactly one order exists.
    await expect(o.accept(o.member, quote)).rejects.toMatchObject({ code: 'QUOTE_ALREADY_ACCEPTED', status: 409 });
    await expect(o.accept(o.member, after)).rejects.toMatchObject({ code: 'QUOTE_ALREADY_ACCEPTED', status: 409 });
    expect(await o.orderCount(quote.id)).toBe(1);
    // The next order of the org takes the next number; a refused accept gave its number back, so there is no gap.
    const second = await o.sentQuote(await o.party('Công ty XYZ'));
    await expect(o.accept(o.viewer, second.quote)).rejects.toMatchObject({ status: 403 });
    expect((await o.accept(o.owner, second.quote)).orderNumber).toBe(`DH-${year}-0002`);
    expect(await o.orderCount()).toBe(2);
    // The lists: by deal, by status, and a page.
    expect((await o.query<SalesOrderSummary[]>(o.viewer, 'crm.deal.sales_orders', { dealId: deal.id })).map((r) => r.id)).toEqual([decided.orderId]);
    const page = await o.query<SalesOrderPage>(o.viewer, 'crm.sales_order.list', { status: 'confirmed' });
    expect(page.items.map((r) => r.number)).toEqual([`DH-${year}-0002`, `DH-${year}-0001`]);
    expect(page.next).toBeNull();
    // A deal that has an order is kept (it has a quote).
    await expect(o.exec(o.owner, 'crm.deal.delete', { dealId: deal.id })).rejects.toMatchObject({ code: 'DEAL_HAS_QUOTES' });
    // An accepted quote is final: it is not revised.
    await expect(o.exec(o.member, 'crm.quote.revise', { quoteId: quote.id })).rejects.toMatchObject({ code: 'QUOTE_NOT_REVISABLE' });
  });

  it('refuses a draft, a stale version, an expired quote, a date in the future, tampered totals and a caller that is not a person, and makes no order', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(party);
    const draft = await o.exec<Quote>(o.member, 'crm.quote.save', { dealId: deal.id, lines: [] });
    await expect(o.accept(o.member, draft)).rejects.toMatchObject({ code: 'QUOTE_NOT_DECIDABLE' });
    await expect(o.exec(o.member, 'crm.quote.decline', { quoteId: draft.id, version: draft.version })).rejects.toMatchObject({ code: 'QUOTE_NOT_DECIDABLE' });
    await expect(o.accept(o.member, { ...draft, id: randomUUID() })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', status: 404 });

    const { quote } = await o.sentQuote(party);
    await expect(o.accept(o.member, { ...quote, version: quote.version + 1 })).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409 });
    await expect(o.accept(o.member, quote, { acceptedOn: '2099-01-01' })).rejects.toMatchObject({ code: 'ORDER_DATE_INVALID' });
    await expect(o.accept(o.member, quote, { acceptedOn: '2026-02-30' })).rejects.toMatchObject({ code: 'ORDER_DATE_INVALID' });
    await expect(rt.execute('crm.quote.accept', { quoteId: quote.id, version: quote.version }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toBeDefined();

    // Totals that are not the sums of the lines (changed behind the command's back, as the database owner may) are refused, not repaired.
    await admin((c) => c.query('UPDATE crove_crm.quote SET subtotal = subtotal + 1, total = total + 1 WHERE org_id = $1 AND id = $2', [o.orgId, quote.id]));
    await expect(o.accept(o.member, quote)).rejects.toMatchObject({ code: 'QUOTE_TOTALS_MISMATCH', status: 409 });
    await admin((c) => c.query('UPDATE crove_crm.quote SET subtotal = subtotal - 1, total = total - 1 WHERE org_id = $1 AND id = $2', [o.orgId, quote.id]));

    // An expired quote is revised, never accepted late (nor declined: it just lapses).
    await admin((c) => c.query("UPDATE crove_crm.quote SET valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 3 WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]));
    await expect(o.accept(o.member, quote)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED', status: 409 });
    expect(await o.orderCount()).toBe(0);
    expect((await o.query<Quote>(o.viewer, 'crm.quote.get', { quoteId: quote.id })).status).toBe('sent');
  });

  it('declines a sent quote with an optional reason: no order, no second decision, and the quote can be revised', async () => {
    const o = await org();
    const { quote } = await o.sentQuote(await o.party('Công ty ABC'));
    await expect(o.exec(o.viewer, 'crm.quote.decline', { quoteId: quote.id, version: quote.version })).rejects.toMatchObject({ status: 403 });
    const decided = await o.exec<QuoteDecided>(o.member, 'crm.quote.decline', { quoteId: quote.id, version: quote.version, reason: `  ${REASON}  ` });
    expect(decided).toEqual({ quoteId: quote.id, status: 'declined', orderId: null, orderNumber: null });
    const row = await admin((c) => c.query<{ status: string; decline_reason: string; decided_at: Date | null }>('SELECT status, decline_reason, decided_at FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [o.orgId, quote.id]));
    expect(row.rows[0]).toMatchObject({ status: 'declined', decline_reason: REASON });
    expect(row.rows[0]!.decided_at).not.toBeNull();
    expect(await o.orderCount()).toBe(0);
    await expect(o.accept(o.member, { ...quote, version: quote.version + 1 })).rejects.toMatchObject({ code: 'QUOTE_ALREADY_DECLINED' });
    await expect(o.exec(o.member, 'crm.quote.decline', { quoteId: quote.id, version: quote.version + 1 })).rejects.toMatchObject({ code: 'QUOTE_ALREADY_DECLINED' });
    const revised = await o.exec<Quote>(o.member, 'crm.quote.revise', { quoteId: quote.id });
    expect(revised).toMatchObject({ status: 'draft', revision: 2, revisesId: quote.id });
  });

  it('hands the order to Kế toán as facts, with the discount as a percent and an amount, and refuses a cancelled one; a confirmed order is cancelled once, with a reason', async () => {
    const o = await org();
    const { quote } = await o.sentQuote(await o.party('Công ty ABC'), [
      item({ description: 'Có giảm giá', quantity: '1', unitPrice: '1000000', discountPercent: '12.5', vatRate: '8%' }),
      item({ description: 'Không giảm', quantity: '3', unitPrice: '333.5', vatRate: '10%' }),
      { kind: 'text', description: 'Ghi chú' },
    ]);
    const decided = await o.accept(o.member, quote);
    const handoff = await o.query<SalesOrderHandoff>(o.viewer, 'crm.sales_order.handoff', { orderId: decided.orderId });
    const entity = await admin((c) => c.query<{ issuer_entity_id: string }>('SELECT issuer_entity_id FROM crove_crm.sales_order WHERE org_id = $1 AND id = $2', [o.orgId, decided.orderId]));
    expect(handoff).toMatchObject({
      orderId: decided.orderId,
      orderNumber: decided.orderNumber,
      orderDate: vietnamToday(),
      legalEntityId: entity.rows[0]!.issuer_entity_id,
      currency: 'VND',
      buyer: { kind: 'business', name: 'Công ty ABC', taxCode: '0312345678' },
      subtotal: quote.subtotal,
      vatAmount: quote.vatAmount,
      total: quote.total,
    });
    expect(handoff.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(handoff.lines[0]).toMatchObject({ kind: 'item', discountPercent: '12.5', discountAmount: '125000', amount: '875000', vatRate: '8%', vatAmount: '70000', stockItemId: null });
    expect(handoff.lines[1]).toMatchObject({ discountPercent: '0', discountAmount: '0', amount: '1001' });
    expect(handoff.lines[2]).toMatchObject({ kind: 'text', quantity: null, unitPrice: null, vatRate: null, discountAmount: '0', amount: '0' });

    const order = await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: decided.orderId });
    await expect(o.exec(o.viewer, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version + 1, reason: REASON })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: '' })).rejects.toBeDefined();
    const cancelled = await o.exec<SalesOrderSummary>(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON });
    expect(cancelled).toMatchObject({ id: order.id, status: 'cancelled', version: order.version + 1 });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect((await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: order.id })).cancelReason).toBe(REASON);
    await expect(o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: cancelled.version, reason: REASON })).rejects.toMatchObject({ code: 'ORDER_ALREADY_CANCELLED' });
    await expect(o.query(o.viewer, 'crm.sales_order.handoff', { orderId: order.id })).rejects.toMatchObject({ code: 'ORDER_CANCELLED', status: 409 });
    expect((await o.query<SalesOrderPage>(o.viewer, 'crm.sales_order.list', { status: 'cancelled' })).items.map((r) => r.id)).toEqual([order.id]);
    expect((await o.query<SalesOrderPage>(o.viewer, 'crm.sales_order.list', { status: 'confirmed' })).items).toEqual([]);
  });

  it('holds the line in SQL when a member goes around the commands: no decision without its order, nothing frozen changes, no delete, no change to a line, a cancelled order stays cancelled', async () => {
    const o = await org();
    const { quote } = await o.sentQuote(await o.party('Công ty ABC'));
    // A quote cannot be taken to accepted without its order, nor without the decision time, nor with a reason, nor changed in any other column on the way.
    const toAccepted = (extra = '') => `UPDATE crove_crm.quote SET status = 'accepted', decided_at = now()${extra} WHERE org_id = $1 AND id = $2`;
    await expect(as(o.orgId, o.member, (c) => c.query(toAccepted(), [o.orgId, quote.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.quote SET status = 'accepted' WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(o.orgId, o.member, (c) => c.query(toAccepted(', remarks = \'x\''), [o.orgId, quote.id]))).rejects.toMatchObject({ code: '42501' });
    // A viewer changes nothing.
    expect(await as(o.orgId, o.viewer, async (c) => (await c.query(toAccepted(), [o.orgId, quote.id])).rowCount)).toBe(0);

    const decided = await o.accept(o.member, quote);
    const order = await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: decided.orderId });
    // What the order froze is not a person's to change: the amounts and the buyer are not granted, the order and its lines are not deleted, a line is not changed.
    for (const sql of [
      'UPDATE crove_crm.sales_order SET total = total + 1, subtotal = subtotal + 1 WHERE org_id = $1 AND id = $2',
      "UPDATE crove_crm.sales_order SET buyer_name = 'x' WHERE org_id = $1 AND id = $2",
      'DELETE FROM crove_crm.sales_order WHERE org_id = $1 AND id = $2',
    ]) {
      await expect(as(o.orgId, o.member, (c) => c.query(sql, [o.orgId, order.id]))).rejects.toMatchObject({ code: '42501' });
    }
    for (const sql of ["UPDATE crove_crm.sales_order_line SET description = 'x' WHERE org_id = $1 AND order_id = $2", 'DELETE FROM crove_crm.sales_order_line WHERE org_id = $1 AND order_id = $2']) {
      await expect(as(o.orgId, o.member, (c) => c.query(sql, [o.orgId, order.id]))).rejects.toMatchObject({ code: '42501' });
    }
    // A viewer inserts no order and changes none.
    expect(await as(o.orgId, o.viewer, async (c) => (await c.query("UPDATE crove_crm.sales_order SET cancel_reason = cancel_reason WHERE org_id = $1 AND id = $2", [o.orgId, order.id])).rowCount)).toBe(0);
    // The accepted quote is frozen: no one changes its status back or its decision.
    await expect(as(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.quote SET status = 'sent' WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]))).rejects.toMatchObject({ code: '42501' });
    // A cancelled order stays cancelled.
    await o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON });
    await expect(
      as(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.sales_order SET status = 'confirmed', cancelled_at = NULL, cancel_reason = NULL WHERE org_id = $1 AND id = $2", [o.orgId, order.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a quote with a newer revision and a date before it was sent, and the database refuses an order that does not match its quote or a line added later', async () => {
    const o = await org();
    const { quote, deal } = await o.sentQuote(await o.party('Công ty ABC'));
    // The customer cannot have said yes before the quote went out (Vietnam calendar).
    await expect(o.accept(o.member, quote, { acceptedOn: '2020-01-01' })).rejects.toMatchObject({ code: 'ORDER_DATE_INVALID' });
    // A newer revision (here a draft) replaces the quote: it is accepted on the latest one only.
    await o.exec(o.member, 'crm.quote.revise', { quoteId: quote.id });
    await expect(o.accept(o.member, quote)).rejects.toMatchObject({ code: 'QUOTE_HAS_NEWER_REVISION', status: 409 });
    expect(await o.orderCount()).toBe(0);

    // Another sent quote: an order insert must carry the quote's own deal, customer and issuing entity, and the signer's own id.
    const other = await o.sentQuote(await o.party('Công ty XYZ'));
    const row = await admin((c) => c.query<{ issuer_entity_id: string; party_id: string; deal_id: string }>('SELECT issuer_entity_id, party_id, deal_id FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [o.orgId, other.quote.id])).then((r) => r.rows[0]!);
    const insertOrder = (over: Record<string, string>, user = o.member) => {
      const v = { deal_id: row.deal_id, party_id: row.party_id, issuer_entity_id: row.issuer_entity_id, created_by: user, ...over };
      return as(o.orgId, user, (c) =>
        c.query(
          "INSERT INTO crove_crm.sales_order (org_id, quote_id, deal_id, party_id, issuer_entity_id, number, order_date, buyer_name, created_by) VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', 'x', $7)",
          [o.orgId, other.quote.id, v.deal_id, v.party_id, v.issuer_entity_id, `DH-X-${randomUUID().slice(0, 6)}`, v.created_by],
        ),
      );
    };
    await expect(insertOrder({ deal_id: deal.id })).rejects.toMatchObject({ code: '42501' });
    await expect(insertOrder({ created_by: o.owner })).rejects.toMatchObject({ code: '42501' });
    await expect(insertOrder({})).resolves.toBeDefined();

    // A line cannot be added to an order made earlier: only in the transaction that made it.
    const done = await o.sentQuote(await o.party('Công ty DEF'));
    const decided = await o.accept(o.member, done.quote);
    await expect(
      as(o.orgId, o.member, (c) =>
        c.query("INSERT INTO crove_crm.sales_order_line (org_id, order_id, line_no, kind, description, quantity, unit_price, vat_rate, amount, vat_amount) VALUES ($1, $2, 99, 'item', 'late', '1', '1', '10%', '1', '0.1')", [o.orgId, decided.orderId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps orders to their org', async () => {
    const a = await org();
    const b = await org();
    const { quote } = await a.sentQuote(await a.party('Công ty ABC'));
    const decided = await a.accept(a.member, quote);
    await expect(b.query(b.member, 'crm.sales_order.get', { orderId: decided.orderId })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 });
    await expect(b.exec(b.member, 'crm.sales_order.cancel', { orderId: decided.orderId, version: 1, reason: REASON })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(b.exec(b.member, 'crm.quote.accept', { quoteId: quote.id, version: quote.version })).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    expect((await b.query<SalesOrderPage>(b.member, 'crm.sales_order.list', {})).items).toEqual([]);
    expect(await b.orderCount()).toBe(0);
  });

  it('keeps customer text and the reasons out of audit rows', async () => {
    const o = await org();
    const first = await o.sentQuote(await o.party('Công ty Bí Mật'));
    const second = await o.sentQuote(await o.party('Công ty Khác'));
    const decided = await o.accept(o.member, first.quote, { acceptedVia: 'phone' });
    const order = await o.query<SalesOrder>(o.viewer, 'crm.sales_order.get', { orderId: decided.orderId });
    await o.exec(o.member, 'crm.sales_order.cancel', { orderId: order.id, version: order.version, reason: REASON });
    await o.exec(o.member, 'crm.quote.decline', { quoteId: second.quote.id, version: second.quote.version, reason: `${REASON} lần hai` });
    const audit = await admin((c) =>
      c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND (command LIKE 'crm.quote.accept' OR command LIKE 'crm.quote.decline' OR command LIKE 'crm.sales_order%') AND outcome = 'ok' ORDER BY id", [o.orgId]),
    );
    expect(audit.rows.map((r) => r.command)).toEqual(['crm.quote.accept', 'crm.sales_order.cancel', 'crm.quote.decline']);
    const text = JSON.stringify(audit.rows);
    for (const needle of ['Bí Mật', 'Công ty Khác', 'Khách đổi ý', '0312345678', 'Lê Lợi', 'Gói kế toán']) expect(text, needle).not.toContain(needle);
  });
});
