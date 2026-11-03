// SPDX-License-Identifier: AGPL-3.0-only
// The stock reports (#2513, plan stock-and-marketplaces.md section 8.3), read-only and provisional: nothing here writes, posts or closes a month.
// - finance.stock.report (every role reads): per item and for one month, the opening, in, out and closing quantity and value, and the unit cost, the weighted average way
//   (domain/stock-cost.ts). A purchase line's amount is what a stock-in brings in; what leaves is valued at the month's average.
// - finance.stock.card (every role reads): an item's moves of a month in order with the balance after each, the stock card.
// The cost is provisional until the month is closed by a person (the close, which proposes the cost-of-goods entry, is a later build and waits for the accountant's check of the rules).
// Quantities and values are decimal strings made by decimal.js; the reads keep the caller's own row policies, so an entity the caller may not see is not in them.
import { sql } from 'kysely';
import { zStockCardInput, zStockReportInput, type StockCard, type StockReportRow } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { monthlyFigures, nextMonth, type CostMove } from './domain/stock-cost.ts';
import { plainQuantity } from './domain/stock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

interface MoveRow {
  id: string;
  item_id: string;
  move_date: string;
  quantity: string;
  source_type: 'document_line' | 'manual' | 'reversal';
  document_id: string | null;
  line_no: number | null;
  // The value a purchase line brought in, negative for the reversal of such a move; null for any other move.
  value: string | null;
}

// The moves of the org's items (an entity's, or every entity the caller sees) up to the end of `month`, in order, each with the value it brought in.
async function movesUpTo(ctx: Pick<QueryContext, 'trx' | 'orgId'>, month: string, filter: { legalEntityId?: string | undefined; itemId?: string | undefined }): Promise<MoveRow[]> {
  const before = `${nextMonth(month)}-01`;
  const { rows } = await sql<MoveRow>`
    SELECT m.id::text AS id, m.item_id::text AS item_id, m.move_date::text AS move_date, m.quantity::text AS quantity, m.source_type, m.document_id::text AS document_id, m.line_no,
           CASE
             WHEN m.source_type = 'document_line' THEN (
               SELECT l.amount::text FROM crove_finance.purchase_line l JOIN crove_finance.purchase_document d ON d.org_id = l.org_id AND d.id = l.document_id
               WHERE l.org_id = m.org_id AND l.document_id = m.document_id AND l.line_no = m.line_no AND d.direction = 'purchase')
             WHEN m.source_type = 'reversal' THEN (
               SELECT (-l.amount)::text FROM crove_finance.stock_move o
               JOIN crove_finance.purchase_line l ON l.org_id = o.org_id AND l.document_id = o.document_id AND l.line_no = o.line_no
               JOIN crove_finance.purchase_document d ON d.org_id = l.org_id AND d.id = l.document_id
               WHERE o.org_id = m.org_id AND o.id = m.reverses_move_id AND o.source_type = 'document_line' AND d.direction = 'purchase')
           END AS value
    FROM crove_finance.stock_move m
    JOIN crove_finance.stock_item i ON i.org_id = m.org_id AND i.id = m.item_id
    WHERE m.org_id = ${ctx.orgId}::uuid
      AND m.move_date < ${before}::date
      AND (${filter.legalEntityId ?? null}::uuid IS NULL OR i.legal_entity_id = ${filter.legalEntityId ?? null}::uuid)
      AND (${filter.itemId ?? null}::uuid IS NULL OR m.item_id = ${filter.itemId ?? null}::uuid)
    ORDER BY m.item_id, m.move_date, m.id`.execute(ctx.trx);
  return rows;
}

const costOf = (move: MoveRow): CostMove => ({ date: move.move_date, quantity: move.quantity, value: move.value });

export const stockReport = defineQuery({
  name: 'finance.stock.report',
  input: zStockReportInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockReportRow[]> => {
    const items = await ctx.trx
      .selectFrom('crove_finance.stock_item')
      .select(['id', 'legal_entity_id', 'code', 'name', 'unit', 'active'])
      .where('org_id', '=', ctx.orgId)
      .$if(input.legalEntityId !== undefined, (qb) => qb.where('legal_entity_id', '=', input.legalEntityId as string))
      .orderBy('code')
      .execute();
    const moves = await movesUpTo(ctx, input.month, { legalEntityId: input.legalEntityId });
    const byItem = new Map<string, MoveRow[]>();
    for (const move of moves) byItem.set(move.item_id, [...(byItem.get(move.item_id) ?? []), move]);
    const rows: StockReportRow[] = [];
    for (const item of items) {
      const own = byItem.get(item.id) ?? [];
      // An item with no move and not in use has nothing to report.
      if (own.length === 0 && !item.active) continue;
      const figures = monthlyFigures(own.map(costOf), input.month).find((f) => f.month === input.month);
      const zero = '0';
      rows.push({
        itemId: item.id,
        legalEntityId: item.legal_entity_id,
        code: item.code,
        name: item.name,
        unit: item.unit,
        openingQuantity: figures?.openingQuantity ?? zero,
        openingValue: figures?.openingValue ?? zero,
        inQuantity: figures?.inQuantity ?? zero,
        inValue: figures?.inValue ?? zero,
        outQuantity: figures?.outQuantity ?? zero,
        outValue: figures?.outValue ?? zero,
        closingQuantity: figures?.closingQuantity ?? zero,
        closingValue: figures?.closingValue ?? zero,
        unitCost: figures?.unitCost ?? null,
      });
    }
    return rows;
  },
});

export const stockCard = defineQuery({
  name: 'finance.stock.card',
  input: zStockCardInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockCard> => {
    const item = await ctx.trx.selectFrom('crove_finance.stock_item').select(['id', 'code', 'name', 'unit']).where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).executeTakeFirst();
    if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
    const moves = await movesUpTo(ctx, input.month, { itemId: item.id });
    const figures = monthlyFigures(moves.map(costOf), input.month).find((f) => f.month === input.month);
    const start = `${input.month}-01`;
    const inMonth = moves.filter((m) => m.move_date >= start);
    let balance = money(figures?.openingQuantity ?? '0');
    const card = inMonth.map((m) => {
      balance = balance.plus(money(m.quantity));
      return {
        id: m.id,
        date: m.move_date,
        source: m.source_type,
        quantity: plainQuantity(m.quantity),
        value: m.value === null ? null : money(m.value).toFixed(),
        balance: plainQuantity(balance.toFixed()),
        documentId: m.document_id,
        lineNo: m.line_no,
      };
    });
    return {
      item: { id: item.id, code: item.code, name: item.name, unit: item.unit },
      month: input.month,
      openingQuantity: figures?.openingQuantity ?? '0',
      closingQuantity: figures?.closingQuantity ?? '0',
      unitCost: figures?.unitCost ?? null,
      provisional: true,
      moves: card,
    };
  },
});

export const stockReportQueries = [stockReport, stockCard];
