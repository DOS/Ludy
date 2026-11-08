// SPDX-License-Identifier: AGPL-3.0-only
// The Kế toán side of the quote hand-off (#2818, ADR-0050 points 3 and 4, plan crm-quotes.md section 6). Both commands take the facts Engage's `crm.sales_order.handoff` read (the
// `SalesOrderHandoff` contract, carried by the browser), re-check all of them, and write finance tables only; no CRM table is read or written, and no agent holds either command.
// - finance.einvoice.draft_from_order (owners, admins, members; R1): makes a normal draft in state `draft` from the item lines of the order that are not on a draft yet (or the lines
//   named), whole lines only. Every draft check runs as on any draft; a payload whose line amounts do not add up to its totals is refused. Each draft line keeps the order line it came
//   from (source_kind, source_id, source_line_no) and a unique index makes a second invoice of that line impossible (ORDER_LINE_ALREADY_INVOICED). A line with a discount is refused
//   until the draft has a discount column (Decree 254, #2506). Nothing is issued: a person reads the draft and issuing needs finance's approval (ADR-0044).
// - finance.stock.move_from_order_line (same roles; R1): the stock a delivered order line takes out, dated on the delivery, keyed by (order id, line no) and idempotent on it: a retry
//   makes no second move. A return is a reversal row of that move, never an edit. A text line is a service and moves nothing. The month's cost is taken at close (ADR-0045).
// Amounts are decimal strings and every sum goes through decimal.js; audit facts carry ids and counts, never a name, a price or a line text.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  EINVOICE_DRAFT_MAX_LINES,
  ORDER_SOURCE_KIND,
  zEInvoiceDraftFromOrder,
  zStockMoveFromOrderLine,
  type EInvoiceDraft,
  type SalesOrderHandoff,
  type SalesOrderHandoffLine,
  type StockMoveFromOrderLineResult,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { computeLineTotals, money, sumLineTotals } from '@crove/l10n-vn';
import { computeDraft } from './domain/einvoice-draft.ts';
import { moveQuantity, movableQuantity, oppositeQuantity } from './domain/stock.ts';
import { loadDraft, toDraftInput } from './einvoice-drafts.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { loadItem, writeStockMove } from './stock.ts';
import { matchLineItem } from './stock-lines.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

const mismatch = () => new DomainError('ORDER_PAYLOAD_MISMATCH', 422, 'Số liệu của đơn hàng không khớp nhau (số tiền các dòng và tổng cộng), hãy tải lại đơn hàng rồi thử lại');

// A decimal string the way the payload writes it; anything else makes the payload unusable.
function decimal(value: string): ReturnType<typeof money> {
  try {
    return money(value);
  } catch {
    throw mismatch();
  }
}

// What the code recomputes from the lines of the payload must equal what the payload says: every item line's amount and VAT, a text line's none, and the totals as the sum of the
// lines. A payload read from the CRM and carried by the browser can be forged, but only by someone who can already write any draft by hand; this keeps a stale or damaged one out.
export function verifyHandoff(handoff: SalesOrderHandoff): void {
  const seen = new Set<number>();
  for (const line of handoff.lines) {
    if (seen.has(line.lineNo)) throw mismatch();
    seen.add(line.lineNo);
    if (line.kind === 'text') {
      if (!decimal(line.amount).isZero() || !decimal(line.vatAmount).isZero()) throw mismatch();
      continue;
    }
    if (line.quantity === null || line.unitPrice === null || line.vatRate === null) throw mismatch();
    const computed = computeLineTotals({ quantity: line.quantity, unitPrice: line.unitPrice, vatRate: line.vatRate, discountPercent: line.discountPercent });
    if (!decimal(computed.amount).equals(decimal(line.amount)) || !decimal(computed.vatAmount).equals(decimal(line.vatAmount))) throw mismatch();
  }
  const totals = sumLineTotals(handoff.lines.map((l) => ({ amount: l.amount, vatAmount: l.vatAmount })));
  if (!decimal(totals.subtotal).equals(decimal(handoff.subtotal)) || !decimal(totals.vatAmount).equals(decimal(handoff.vatAmount)) || !decimal(totals.total).equals(decimal(handoff.total))) throw mismatch();
}

const hasDiscount = (line: SalesOrderHandoffLine): boolean => decimal(line.discountPercent).greaterThan(0) || decimal(line.discountAmount).greaterThan(0);

export const einvoiceDraftFromOrder = defineCommand({
  name: 'finance.einvoice.draft_from_order',
  input: zEInvoiceDraftFromOrder,
  // A draft is a working copy: no invoice exists until a person issues it (a later step), so it is undone by deleting it.
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceDraft> => {
    const { handoff } = input;
    verifyHandoff(handoff);
    const entity = await resolveLegalEntity(ctx, handoff.legalEntityId);

    // The order's lines that are on a draft already (a draft that was deleted took its lines with it, so they are open again).
    const claimed = new Set(
      (
        await ctx.trx
          .selectFrom('crove_finance.einvoice_draft_line')
          .select('source_line_no')
          .where('org_id', '=', ctx.orgId)
          .where('source_kind', '=', ORDER_SOURCE_KIND)
          .where('source_id', '=', handoff.orderId)
          .execute()
      ).flatMap((r) => (r.source_line_no === null ? [] : [r.source_line_no])),
    );

    let chosen: SalesOrderHandoffLine[];
    if (input.lineNos) {
      const wanted = [...new Set(input.lineNos)].sort((a, b) => a - b);
      chosen = wanted.map((no) => {
        const line = handoff.lines.find((l) => l.lineNo === no);
        if (!line) throw new DomainError('ORDER_LINE_UNKNOWN', 422, 'Đơn hàng không có dòng này', { lineNo: no });
        return line;
      });
      for (const line of chosen) {
        if (line.kind === 'text') throw new DomainError('ORDER_LINE_NOT_INVOICEABLE', 422, 'Dòng ghi chú không có số lượng và đơn giá nên không lập hóa đơn được', { lineNo: line.lineNo });
      }
      const already = chosen.filter((l) => claimed.has(l.lineNo)).map((l) => l.lineNo);
      if (already.length > 0) throw new DomainError('ORDER_LINE_ALREADY_INVOICED', 409, 'Dòng này đã có hóa đơn nháp hoặc hóa đơn', { lineNos: already });
    } else {
      chosen = handoff.lines.filter((l) => l.kind === 'item' && !claimed.has(l.lineNo));
      if (chosen.length === 0) throw new DomainError('ORDER_NOTHING_TO_INVOICE', 409, 'Đơn hàng không còn dòng nào chưa lập hóa đơn');
    }
    // A line with a discount waits for the discount column of the draft (ADR-0050 A2): the person gives the net price instead.
    const discounted = chosen.filter(hasDiscount).map((l) => l.lineNo);
    if (discounted.length > 0) {
      throw new DomainError('ORDER_LINE_DISCOUNTED', 422, 'Dòng có chiết khấu chưa lập hóa đơn được, hãy nhập đơn giá sau chiết khấu trong báo giá', { lineNos: discounted });
    }
    if (chosen.length > EINVOICE_DRAFT_MAX_LINES) throw new DomainError('ORDER_TOO_MANY_LINES', 422, 'Hóa đơn có quá nhiều dòng, hãy chọn bớt dòng');

    const today = await databaseToday(ctx.trx);
    const series = await ctx.trx
      .selectFrom('crove_finance.einvoice_series')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('is_default', '=', true)
      .executeTakeFirst();
    // The buyer as the order froze it: a consumer carries no details; a business keeps its tax code, name and address for the checks to read (a gap is an issue on the draft).
    const draft = toDraftInput({
      date: today,
      seriesId: series?.id ?? null,
      buyer: { kind: handoff.buyer.kind, partyId: null, taxCode: handoff.buyer.taxCode, name: handoff.buyer.name, address: handoff.buyer.address, email: handoff.buyer.email },
      lines: chosen.map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity ?? '0', unitPrice: l.unitPrice ?? '0', vatRate: l.vatRate ?? '' })),
    });
    const computed = computeDraft(draft.lines);
    // The amounts the database can hold (20 digits with 4 decimals), as in finance.einvoice_draft.save.
    if ([computed.subtotal, computed.vatAmount, computed.total, ...computed.lines.flatMap((l) => [l.amount, l.vatAmount])].some((v) => money(v).abs().toFixed(0).length > 15)) {
      throw new DomainError('EINVOICE_TOTAL_TOO_LARGE', 422, 'Số tiền của hóa đơn quá lớn');
    }
    // The draft checks (buyer fields, tax code checksum, VAT rate set, totals) run when the draft is read back, as on any other draft: a gap is an issue on it, not a refusal.
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const draftId = randomUUID();
    try {
      await ctx.trx
        .insertInto('crove_finance.einvoice_draft')
        .values({
          org_id: ctx.orgId,
          id: draftId,
          legal_entity_id: entity,
          created_by: userId,
          series_id: draft.seriesId,
          invoice_date: draft.date,
          currency: draft.currency,
          buyer_kind: draft.buyer.kind,
          buyer_party_id: null,
          buyer_tax_code: draft.buyer.taxCode,
          buyer_name: draft.buyer.name,
          buyer_address: draft.buyer.address,
          buyer_email: draft.buyer.email,
          subtotal: computed.subtotal,
          vat_amount: computed.vatAmount,
          total: computed.total,
        })
        .execute();
      for (const [index, line] of computed.lines.entries()) {
        await ctx.trx
          .insertInto('crove_finance.einvoice_draft_line')
          .values({
            org_id: ctx.orgId,
            legal_entity_id: entity,
            draft_id: draftId,
            line_no: index + 1,
            description: line.description,
            unit: line.unit,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            amount: line.amount,
            vat_rate: line.vatRate,
            vat_amount: line.vatAmount,
            source_kind: ORDER_SOURCE_KIND,
            source_id: handoff.orderId,
            source_line_no: chosen[index]?.lineNo ?? null,
          })
          .execute();
      }
    } catch (error) {
      // Two invoices of one line at once: the second meets the unique index of a source line.
      if (pgCode(error) === '23505') throw new DomainError('ORDER_LINE_ALREADY_INVOICED', 409, 'Dòng này đã có hóa đơn nháp hoặc hóa đơn');
      if (pgCode(error) === '23514') throw new DomainError('EINVOICE_DRAFT_INVALID', 422, 'Bản nháp có giá trị không hợp lệ');
      throw error;
    }
    ctx.audit({ draftId, orderId: handoff.orderId, legalEntityId: entity, lines: computed.lines.length });
    return loadDraft(ctx, draftId, today);
  },
});

// One at a time per order line: a delivery and a return, or two deliveries, of the same line wait for each other.
async function lockOrderLine(ctx: CommandContext, orderId: string, lineNo: number): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.stock.crm_order:${ctx.orgId}:${orderId}:${lineNo}`}, 0))`.execute(ctx.trx);
}

export const stockMoveFromOrderLine = defineCommand({
  name: 'finance.stock.move_from_order_line',
  input: zStockMoveFromOrderLine,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<StockMoveFromOrderLineResult> => {
    const { handoff, lineNo, action } = input;
    verifyHandoff(handoff);
    const line = handoff.lines.find((l) => l.lineNo === lineNo);
    if (!line) throw new DomainError('ORDER_LINE_UNKNOWN', 404, 'Đơn hàng không có dòng này', { lineNo });
    const entity = await resolveLegalEntity(ctx, handoff.legalEntityId);
    // A service (a text line) moves no stock, delivered or returned.
    if (line.kind === 'text') return { status: 'service', moveId: null };
    const today = await databaseToday(ctx.trx);
    if (input.date > today) throw new DomainError('ORDER_DATE_FUTURE', 422, 'Ngày giao hàng không được ở tương lai');
    await lockOrderLine(ctx, handoff.orderId, lineNo);

    const forward = await ctx.trx
      .selectFrom('crove_finance.stock_move')
      .select(['id', 'item_id', 'quantity', 'move_date'])
      .where('org_id', '=', ctx.orgId)
      .where('source_type', '=', 'crm_order_line')
      .where('crm_order_id', '=', handoff.orderId)
      .where('crm_order_line_no', '=', lineNo)
      .executeTakeFirst();
    const reversal = forward
      ? await ctx.trx.selectFrom('crove_finance.stock_move').select('id').where('org_id', '=', ctx.orgId).where('reverses_move_id', '=', forward.id).executeTakeFirst()
      : undefined;

    if (action === 'return') {
      if (!forward) throw new DomainError('ORDER_LINE_NOT_DELIVERED', 409, 'Dòng này chưa xuất kho nên chưa có gì để hoàn lại');
      if (reversal) return { status: 'already_returned', moveId: reversal.id };
      const movedOn = typeof forward.move_date === 'string' ? forward.move_date : new Date(forward.move_date).toISOString().slice(0, 10);
      if (input.date < movedOn) throw new DomainError('ORDER_RETURN_BEFORE_DELIVERY', 422, 'Ngày hoàn hàng không được trước ngày giao hàng');
      const id = await writeStockMove(ctx, { itemId: forward.item_id, date: input.date, quantity: oppositeQuantity(forward.quantity), source: { type: 'reversal', reversesMoveId: forward.id } });
      ctx.audit({ orderId: handoff.orderId, lineNo, action, moveId: id, reversesMoveId: forward.id });
      return { status: 'returned', moveId: id };
    }

    // A delivery: the same answer on every retry. A line whose stock was brought back is not delivered again in this slice (ADR-0050 "Left out").
    if (forward) {
      if (reversal) throw new DomainError('ORDER_LINE_RETURNED', 409, 'Dòng này đã được hoàn kho, không xuất lại được trong phiên bản này');
      return { status: 'already_moved', moveId: forward.id };
    }
    const quantity = movableQuantity(line.quantity);
    if (quantity === null) throw new DomainError('STOCK_LINE_NO_QUANTITY', 422, 'Dòng này không có số lượng để xuất kho');
    // The item the order line names when it is one of this entity's, else the fixed chain of ADR-0045 (the item's code, a taught name); nothing is guessed.
    let target: { itemId: string; factor: string } | null = null;
    if (line.stockItemId) {
      const item = await loadItem(ctx, line.stockItemId).catch((error: unknown) => {
        if (error instanceof DomainError && error.code === 'STOCK_ITEM_NOT_FOUND') return null;
        throw error;
      });
      if (item && item.legal_entity_id === entity && item.active) target = { itemId: item.id, factor: '1' };
    }
    target ??= await matchLineItem(ctx, entity, { description: line.description, unit: line.unit });
    if (!target) throw new DomainError('STOCK_ORDER_LINE_NO_ITEM', 422, 'Chưa biết dòng này là mặt hàng kho nào, hãy gán tên hàng này cho một mặt hàng rồi thử lại', { lineNo });
    const signed = moveQuantity('sale', quantity, target.factor);
    if (signed === null) throw new DomainError('STOCK_LINE_NO_QUANTITY', 422, 'Dòng này không có số lượng để xuất kho');
    let id: string;
    try {
      id = await writeStockMove(ctx, { itemId: target.itemId, date: input.date, quantity: signed, source: { type: 'crm_order_line', orderId: handoff.orderId, lineNo } });
    } catch (error) {
      // A move of this line that the lookup above could not see (it sits in a legal entity the caller may not read): refused with no data about it.
      if (pgCode(error) === '23505') throw new DomainError('ORDER_LINE_ALREADY_DELIVERED', 409, 'Dòng này đã được xuất kho');
      throw error;
    }
    ctx.audit({ orderId: handoff.orderId, lineNo, action, moveId: id });
    return { status: 'moved', moveId: id };
  },
});

export interface OrderSource {
  kind: string;
  id: string;
  lineNo: number;
}

// The order lines behind an issued sales invoice of the entity, by the draft it was issued from (the series' symbol and the issued number, leading zeros ignored): the draft's line number
// to its source and amount. A document line takes the source only when its number and its amount are the draft line's, so a line that was changed on the way to the books carries none.
export async function orderSourcesOfInvoice(ctx: CommandContext, legalEntityId: string, series: string, number: string): Promise<Map<number, OrderSource & { amount: string }>> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.einvoice_draft as d')
    .innerJoin('crove_finance.einvoice_series as s', (join) => join.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.series_id'))
    .innerJoin('crove_finance.einvoice_draft_line as l', (join) => join.onRef('l.org_id', '=', 'd.org_id').onRef('l.draft_id', '=', 'd.id'))
    .select(['l.line_no', 'l.amount', 'l.source_kind', 'l.source_id', 'l.source_line_no'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', legalEntityId)
    .where('d.state', '=', 'issued')
    .where(sql<boolean>`(s.symbol = ${series}::text OR s.template_no || s.symbol = ${series}::text)`)
    .where(sql<boolean>`pg_catalog.ltrim(d.issued_number, '0') = pg_catalog.ltrim(${number}::text, '0')`)
    .where('l.source_kind', 'is not', null)
    .execute();
  const sources = new Map<number, OrderSource & { amount: string }>();
  for (const r of rows) {
    if (r.source_kind !== null && r.source_id !== null && r.source_line_no !== null) sources.set(r.line_no, { kind: r.source_kind, id: r.source_id, lineNo: r.source_line_no, amount: r.amount });
  }
  return sources;
}

export const orderHandoffCommands = [einvoiceDraftFromOrder, stockMoveFromOrderLine];
