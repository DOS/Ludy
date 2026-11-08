// SPDX-License-Identifier: AGPL-3.0-only
// Quote acceptance and the sales order (issue #2696, ADR-0050, plan docs/plan/crm-quotes.md sections 4.7 and 6, step Q4): a person records that the customer accepted a
// sent quote, which makes exactly one frozen sales order in the same transaction; or records that the customer declined it. The order is handed to Kế toán as facts
// (`crm.sales_order.handoff`, R0); Kế toán makes the e-invoice draft with its own command on a person's click, and nothing here writes a finance table.
//
// Owners, admins and members write; viewers read; **no agent writes any command of this file** (the commands refuse a caller that is not a person, and the ADR-0029
// allowlist is unchanged). Every command is R1 and internal: it changes only the org's own records, posts nothing, moves no stock and sends nothing. The audit rows hold
// ids and counts, never a customer value, a price or a reason text. The order number comes from the kernel's gapless yearly series (doc type crm.sales_order), taken in the
// same transaction as the order, so a rolled-back accept gives the number back.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  SALES_ORDER_PAGE_SIZE,
  vietnamToday,
  zQuoteAccept,
  zQuoteDecline,
  zSalesOrderCancel,
  zSalesOrderListQuery,
  zSalesOrderRef,
  type QuoteDecided,
  type SalesOrder,
  type SalesOrderBuyer,
  type SalesOrderHandoff,
  type SalesOrderPage,
  type SalesOrderStatus,
  type SalesOrderSummary,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { Decimal, money, sumLineTotals } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { z } from 'zod';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

type Reader = Pick<QueryContext, 'trx' | 'orgId'>;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const day = (value: Date | string): string => (typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
const quoteNotFound = () => new DomainError('QUOTE_NOT_FOUND', 404, 'Không tìm thấy báo giá này');
const orderNotFound = () => new DomainError('ORDER_NOT_FOUND', 404, 'Không tìm thấy đơn hàng này');
const stale = () => new DomainError('STALE_VERSION', 409, 'Báo giá này vừa được người khác sửa; hãy mở lại để xem bản mới');

// The date a person gives for "the customer said yes on": a real calendar day, never after today in Vietnam.
function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------------------------------------------
// Accept and decline
// ---------------------------------------------------------------------------------------------------------------

interface QuoteForDecision {
  id: string;
  deal_id: string;
  party_id: string;
  status: string;
  version: number;
  valid_until: Date | string;
  subtotal: string;
  vat_amount: string;
  total: string;
  issuer_entity_id: string | null;
  buyer_name: string | null;
  buyer_tax_code: string | null;
  buyer_address: string | null;
  buyer_email: string | null;
}

async function loadQuoteForDecision(ctx: Pick<CommandContext, 'trx' | 'orgId'>, quoteId: string): Promise<QuoteForDecision> {
  const quote = await ctx.trx
    .selectFrom('crove_crm.quote')
    .select(['id', 'deal_id', 'party_id', 'status', 'version', 'valid_until', 'subtotal', 'vat_amount', 'total', 'issuer_entity_id', 'buyer_name', 'buyer_tax_code', 'buyer_address', 'buyer_email'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', quoteId)
    .forUpdate()
    .executeTakeFirst();
  if (!quote) throw quoteNotFound();
  return quote;
}

// The refusals every decision shares, in the order a person should meet them. An accepted quote names its order, so a second accept is told which one.
async function checkDecidable(ctx: Pick<CommandContext, 'trx' | 'orgId' | 'now'>, quote: QuoteForDecision, version: number): Promise<void> {
  if (quote.status === 'accepted') {
    const order = await ctx.trx.selectFrom('crove_crm.sales_order').select('number').where('org_id', '=', ctx.orgId).where('quote_id', '=', quote.id).executeTakeFirst();
    throw new DomainError('QUOTE_ALREADY_ACCEPTED', 409, order ? `Báo giá này đã được ghi nhận chấp nhận (đơn ${order.number})` : 'Báo giá này đã được ghi nhận chấp nhận');
  }
  if (quote.status === 'declined') throw new DomainError('QUOTE_ALREADY_DECLINED', 409, 'Báo giá này đã được ghi nhận từ chối');
  if (quote.status !== 'sent') throw new DomainError('QUOTE_NOT_SENT', 409, 'Chỉ ghi nhận được cho báo giá đã gửi');
  if (quote.version !== version) throw stale();
  // Expiry is derived, never stored: a sent quote whose validity date is before today in Vietnam is expired and is revised, never accepted late.
  if (day(quote.valid_until) < vietnamToday(ctx.now)) throw new DomainError('QUOTE_EXPIRED', 409, 'Báo giá đã hết hạn; hãy tạo bản sửa đổi và gửi lại');
}

export const quoteAccept = defineCommand({
  name: 'crm.quote.accept',
  input: zQuoteAccept,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<QuoteDecided> => {
    const userId = userOf(ctx.actor);
    const today = vietnamToday(ctx.now);
    const acceptedOn = input.acceptedOn ?? today;
    if (!validDate(acceptedOn) || acceptedOn > today) throw new DomainError('QUOTE_DATE_INVALID', 422, 'Ngày khách đồng ý không hợp lệ');
    const quote = await loadQuoteForDecision(ctx, input.quoteId);
    await checkDecidable(ctx, quote, input.version);
    if (!quote.issuer_entity_id || !quote.buyer_name) throw new DomainError('QUOTE_INCOMPLETE', 422, 'Báo giá chưa đủ thông tin người bán và người mua');
    const lines = await ctx.trx
      .selectFrom('crove_crm.quote_line')
      .select(['line_no', 'kind', 'description', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'])
      .where('org_id', '=', ctx.orgId)
      .where('quote_id', '=', quote.id)
      .orderBy('line_no')
      .execute();
    // The stored totals must be the sums of the stored lines: a quote changed behind the command's back is refused, not repaired.
    const sums = sumLineTotals(lines.map((l) => ({ amount: l.amount, vatAmount: l.vat_amount })));
    if (!money(quote.subtotal).equals(sums.subtotal) || !money(quote.vat_amount).equals(sums.vatAmount) || !money(quote.total).equals(sums.total) || !money(quote.total).greaterThan(0)) {
      throw new DomainError('QUOTE_TOTALS_MISMATCH', 409, 'Tổng tiền của báo giá không khớp các dòng; hãy mở lại báo giá');
    }
    // The kernel's gapless yearly series of the issuing entity; the number is given back if anything below fails (the last step before the order's insert).
    const orderId = randomUUID();
    const allocated = await ctx.numbering.allocate({ legalEntityId: quote.issuer_entity_id, docType: 'crm.sales_order', documentDate: acceptedOn, targetType: 'crm.sales_order', targetId: orderId });
    const year = /^\d{4}/.test(allocated.periodKey) ? allocated.periodKey.slice(0, 4) : acceptedOn.slice(0, 4);
    const number = `DH-${year}-${String(allocated.number).padStart(4, '0')}`;
    await ctx.trx
      .insertInto('crove_crm.sales_order')
      .values({
        org_id: ctx.orgId,
        id: orderId,
        quote_id: quote.id,
        deal_id: quote.deal_id,
        party_id: quote.party_id,
        issuer_entity_id: quote.issuer_entity_id,
        number,
        order_date: acceptedOn,
        buyer_name: quote.buyer_name,
        buyer_tax_code: quote.buyer_tax_code,
        buyer_address: quote.buyer_address,
        buyer_email: quote.buyer_email,
        subtotal: quote.subtotal,
        vat_amount: quote.vat_amount,
        total: quote.total,
        accepted_via: input.acceptedVia ?? null,
        confirmed_at: ctx.now,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .execute()
      // A second accept of the same quote that raced this one: the unique key lets one in.
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') throw new DomainError('QUOTE_ALREADY_ACCEPTED', 409, 'Báo giá này đã được ghi nhận chấp nhận');
        throw error;
      });
    if (lines.length > 0) {
      await ctx.trx
        .insertInto('crove_crm.sales_order_line')
        .values(
          lines.map((l) => ({
            org_id: ctx.orgId,
            order_id: orderId,
            line_no: l.line_no,
            kind: l.kind,
            description: l.description,
            unit: l.unit,
            quantity: l.quantity,
            unit_price: l.unit_price,
            discount_percent: l.discount_percent,
            vat_rate: l.vat_rate,
            amount: l.amount,
            vat_amount: l.vat_amount,
            stock_item_id: l.stock_item_id,
          })),
        )
        .execute();
    }
    await ctx.trx
      .updateTable('crove_crm.quote')
      .set({ status: 'accepted', decided_at: ctx.now, version: quote.version + 1, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', quote.id)
      .execute();
    ctx.audit({ quoteId: quote.id, orderId, dealId: quote.deal_id, partyId: quote.party_id, lines: lines.length });
    await ctx.activity('kernel.party', quote.party_id, 'quote.accepted', 'Ghi nhận khách chấp nhận báo giá');
    return { quoteId: quote.id, status: 'accepted', orderId, orderNumber: number };
  },
});

export const quoteDecline = defineCommand({
  name: 'crm.quote.decline',
  input: zQuoteDecline,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<QuoteDecided> => {
    const userId = userOf(ctx.actor);
    const quote = await loadQuoteForDecision(ctx, input.quoteId);
    await checkDecidable(ctx, quote, input.version);
    const reason = input.reason === undefined || input.reason === null || input.reason === '' ? null : input.reason;
    await ctx.trx
      .updateTable('crove_crm.quote')
      .set({ status: 'declined', decided_at: ctx.now, decline_reason: reason, version: quote.version + 1, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', quote.id)
      .execute();
    ctx.audit({ quoteId: quote.id, dealId: quote.deal_id, partyId: quote.party_id, hasReason: reason !== null });
    await ctx.activity('kernel.party', quote.party_id, 'quote.declined', 'Ghi nhận khách từ chối báo giá');
    return { quoteId: quote.id, status: 'declined', orderId: null, orderNumber: null };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

interface OrderRow {
  id: string;
  number: string;
  quote_id: string;
  deal_id: string;
  party_id: string;
  buyer_name: string;
  order_date: Date | string;
  status: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  version: number;
  confirmed_at: Date | string;
  cancelled_at: Date | string | null;
  deal_title: string;
  quote_number: string | null;
  line_count: number;
}

function base(ctx: Reader) {
  return ctx.trx
    .selectFrom('crove_crm.sales_order as o')
    .innerJoin('crove_crm.deal as d', (j) => j.onRef('d.org_id', '=', 'o.org_id').onRef('d.id', '=', 'o.deal_id'))
    .innerJoin('crove_crm.quote as q', (j) => j.onRef('q.org_id', '=', 'o.org_id').onRef('q.id', '=', 'o.quote_id'))
    .select([
      'o.id',
      'o.number',
      'o.quote_id',
      'o.deal_id',
      'o.party_id',
      'o.buyer_name',
      'o.order_date',
      'o.status',
      'o.subtotal',
      'o.vat_amount',
      'o.total',
      'o.version',
      'o.confirmed_at',
      'o.cancelled_at',
      'd.title as deal_title',
      'q.number as quote_number',
      sql<number>`(SELECT pg_catalog.count(*)::int FROM crove_crm.sales_order_line l WHERE l.org_id = o.org_id AND l.order_id = o.id)`.as('line_count'),
    ])
    .where('o.org_id', '=', ctx.orgId);
}

function summary(r: OrderRow): SalesOrderSummary {
  return {
    id: r.id,
    number: r.number,
    quoteId: r.quote_id,
    quoteNumber: r.quote_number,
    dealId: r.deal_id,
    dealTitle: r.deal_title,
    partyId: r.party_id,
    buyerName: r.buyer_name,
    orderDate: day(r.order_date),
    status: r.status as SalesOrderStatus,
    subtotal: money(r.subtotal).toFixed(),
    vatAmount: money(r.vat_amount).toFixed(),
    total: money(r.total).toFixed(),
    lineCount: r.line_count,
    version: r.version,
    confirmedAt: iso(r.confirmed_at),
    cancelledAt: r.cancelled_at === null ? null : iso(r.cancelled_at),
  };
}

// A buyer with a tax code is a business; one without is a consumer (the invoice's own rule for the buyer fields).
const buyerOf = (r: { buyer_name: string; buyer_tax_code: string | null; buyer_address: string | null; buyer_email: string | null }): SalesOrderBuyer => ({
  kind: r.buyer_tax_code ? 'business' : 'consumer',
  name: r.buyer_name,
  taxCode: r.buyer_tax_code,
  address: r.buyer_address,
  email: r.buyer_email,
});

async function loadLines(ctx: Reader, orderId: string) {
  const rows = await ctx.trx
    .selectFrom('crove_crm.sales_order_line')
    .select(['line_no', 'kind', 'description', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'])
    .where('org_id', '=', ctx.orgId)
    .where('order_id', '=', orderId)
    .orderBy('line_no')
    .execute();
  return rows.map((l) => ({
    lineNo: l.line_no,
    kind: l.kind,
    description: l.description,
    unit: l.unit,
    quantity: l.quantity === null ? null : money(l.quantity).toFixed(),
    unitPrice: l.unit_price === null ? null : money(l.unit_price).toFixed(),
    discountPercent: money(l.discount_percent).toFixed(),
    vatRate: l.vat_rate,
    amount: money(l.amount).toFixed(),
    vatAmount: money(l.vat_amount).toFixed(),
    stockItemId: l.stock_item_id,
  }));
}

async function loadOrder(ctx: Reader, orderId: string): Promise<SalesOrder> {
  const row = await base(ctx).where('o.id', '=', orderId).executeTakeFirst();
  if (!row) throw orderNotFound();
  const extra = await ctx.trx
    .selectFrom('crove_crm.sales_order')
    .select(['issuer_entity_id', 'buyer_tax_code', 'buyer_address', 'buyer_email', 'accepted_via', 'cancel_reason'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();
  return {
    ...summary(row),
    issuerEntityId: extra.issuer_entity_id,
    currency: 'VND',
    buyer: buyerOf({ buyer_name: row.buyer_name, buyer_tax_code: extra.buyer_tax_code, buyer_address: extra.buyer_address, buyer_email: extra.buyer_email }),
    acceptedVia: extra.accepted_via,
    cancelReason: extra.cancel_reason,
    lines: await loadLines(ctx, orderId),
  };
}

export const salesOrderGet = defineQuery({
  name: 'crm.sales_order.get',
  input: zSalesOrderRef,
  access: ALL,
  handler: async (ctx, input): Promise<SalesOrder> => loadOrder(ctx, input.orderId),
});

export const salesOrderList = defineQuery({
  name: 'crm.sales_order.list',
  input: zSalesOrderListQuery,
  access: ALL,
  handler: async (ctx, input): Promise<SalesOrderPage> => {
    const limit = input.limit ?? SALES_ORDER_PAGE_SIZE;
    let q = base(ctx);
    if (input.dealId) q = q.where('o.deal_id', '=', input.dealId);
    if (input.partyId) q = q.where('o.party_id', '=', input.partyId);
    if (input.status) q = q.where('o.status', '=', input.status);
    if (input.cursor) q = q.where(sql<boolean>`(o.created_at, o.id) < (${new Date(input.cursor.createdAt)}::timestamptz, ${input.cursor.id}::uuid)`);
    const rows = await q.select('o.created_at').orderBy('o.created_at', 'desc').orderBy('o.id', 'desc').limit(limit + 1).execute();
    const items = rows.slice(0, limit).map(summary);
    const last = rows.slice(0, limit).at(-1);
    return { items, next: rows.length > limit && last ? { createdAt: iso(last.created_at), id: last.id } : null };
  },
});

// The orders of one deal, newest first: the deal panel's tab.
export const dealSalesOrders = defineQuery({
  name: 'crm.deal.sales_orders',
  input: z.strictObject({ dealId: z.uuid() }),
  access: ALL,
  handler: async (ctx, input): Promise<SalesOrderSummary[]> => {
    const rows = await base(ctx).where('o.deal_id', '=', input.dealId).orderBy('o.created_at', 'desc').orderBy('o.id', 'desc').limit(100).execute();
    return rows.map(summary);
  },
});

// What Kế toán takes to make an e-invoice draft (ADR-0050 point 3): everything it needs and nothing it fills itself. A cancelled order is refused. The discount amount
// is what the percent came to on the line, rounded half up to whole dong as the amounts are (plan 4.4), so Kế toán can take either form of a discount.
export const salesOrderHandoff = defineQuery({
  name: 'crm.sales_order.handoff',
  input: zSalesOrderRef,
  access: ALL,
  handler: async (ctx, input): Promise<SalesOrderHandoff> => {
    const order = await loadOrder(ctx, input.orderId);
    if (order.status !== 'confirmed') throw new DomainError('ORDER_CANCELLED', 409, 'Đơn hàng đã hủy nên không lập hóa đơn được');
    return {
      orderId: order.id,
      orderNumber: order.number,
      orderDate: order.orderDate,
      legalEntityId: order.issuerEntityId,
      currency: 'VND',
      buyer: order.buyer,
      lines: order.lines.map((l) => ({
        lineNo: l.lineNo,
        kind: l.kind,
        stockItemId: l.stockItemId,
        description: l.description,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent,
        discountAmount:
          l.kind === 'item' && l.quantity !== null && l.unitPrice !== null
            ? money(l.quantity).times(money(l.unitPrice)).times(money(l.discountPercent)).dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed()
            : '0',
        amount: l.amount,
        vatRate: l.vatRate,
        vatAmount: l.vatAmount,
      })),
      subtotal: order.subtotal,
      vatAmount: order.vatAmount,
      total: order.total,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------------------------

// A confirmed order is cancelled with a reason, once. What Kế toán has made from it (a draft) is read from Kế toán and cannot be checked here (no module reads the other's
// tables, ADR-0050 "Consequences"): the Orders screen disables the action for an order it last read a draft for, and a draft is only a draft until finance issues it. The
// delivery check of Q4b joins this one when `sales_order_delivery` exists.
export const salesOrderCancel = defineCommand({
  name: 'crm.sales_order.cancel',
  input: zSalesOrderCancel,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.sales_order', id: input.orderId }),
  handler: async (ctx, input): Promise<SalesOrderSummary> => {
    const userId = userOf(ctx.actor);
    const order = await ctx.trx
      .selectFrom('crove_crm.sales_order')
      .select(['id', 'deal_id', 'party_id', 'status', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) throw orderNotFound();
    if (order.status !== 'confirmed') throw new DomainError('ORDER_ALREADY_CANCELLED', 409, 'Đơn hàng này đã hủy');
    if (order.version !== input.version) throw new DomainError('STALE_VERSION', 409, 'Đơn hàng này vừa được người khác sửa; hãy mở lại để xem bản mới');
    await ctx.trx
      .updateTable('crove_crm.sales_order')
      .set({ status: 'cancelled', cancelled_at: ctx.now, cancel_reason: input.reason, version: order.version + 1, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', order.id)
      .execute();
    ctx.audit({ orderId: order.id, dealId: order.deal_id, partyId: order.party_id });
    await ctx.activity('kernel.party', order.party_id, 'order.cancelled', 'Hủy một đơn hàng');
    const row = await base(ctx).where('o.id', '=', order.id).executeTakeFirstOrThrow();
    return summary(row);
  },
});

export const salesOrderCommands = [quoteAccept, quoteDecline, salesOrderCancel];
export const salesOrderQueries = [salesOrderGet, salesOrderList, dealSalesOrders, salesOrderHandoff];
