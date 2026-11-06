// SPDX-License-Identifier: AGPL-3.0-only
// The stock reports (#2513, plan stock-and-marketplaces.md section 8.3), read-only: nothing here writes, posts or closes a month.
// - finance.stock.report (every role reads): per item and for one month, the opening, in, out and closing quantity and value, and the unit cost, the weighted average way
//   (domain/stock-cost.ts). A purchase line's amount is what a stock-in brings in; what leaves is valued at the month's average.
// - finance.stock.card (every role reads): an item's moves of a month in order with the balance after each, the stock card.
// - finance.stock.periods (every role reads): the months a person has closed, with the cost that was posted.
// The cost is provisional until the month is closed (stock-close.ts). A closed month is read from what the close stored (stock_period_item), never folded again, and the months after
// it open with its closing; so a figure of a closed month does not move with a later change of the rules or of the rounding.
// Quantities and values are decimal strings made by decimal.js; the reads keep the caller's own row policies, so an entity the caller may not see is not in them.
import { sql } from 'kysely';
import { zStockCardInput, zStockPeriodsInput, zStockReportInput, type StockCard, type StockPeriod, type StockReportRow } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { monthFigures, nextMonth, type CostMove, type MonthFigures, type OpeningBalance } from './domain/stock-cost.ts';
import { plainQuantity } from './domain/stock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

interface MoveRow {
  id: string;
  item_id: string;
  move_date: string;
  quantity: string;
  source_type: 'document_line' | 'manual' | 'reversal' | 'order_line' | 'count';
  document_id: string | null;
  line_no: number | null;
  // The value a purchase line brought in, negative for the reversal of such a move; null for any other move.
  value: string | null;
}

// The moves of the org's items (an entity's, or every entity the caller sees) up to the end of `month`, in order, each with the value it brought in.
// `from` leaves out the moves before that date (a close reads only the months after the last closed one, whose figures are stored).
export async function movesUpTo(ctx: Pick<QueryContext, 'trx' | 'orgId'>, month: string, filter: { legalEntityId?: string | undefined; itemId?: string | undefined; from?: string | undefined }): Promise<MoveRow[]> {
  const before = `${nextMonth(month)}-01`;
  const { rows } = await sql<MoveRow>`
    SELECT m.id::text AS id, m.item_id::text AS item_id, m.move_date::text AS move_date, m.quantity::text AS quantity, m.source_type, m.document_id::text AS document_id, m.line_no,
           CASE
             WHEN m.source_type = 'document_line' THEN (
               SELECT l.amount::text FROM crove_finance.purchase_line l JOIN crove_finance.purchase_document d ON d.org_id = l.org_id AND d.id = l.document_id
               WHERE l.org_id = m.org_id AND l.document_id = m.document_id AND l.line_no = m.line_no AND d.direction = 'purchase')
             WHEN m.source_type = 'count' THEN m.amount::text
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
      AND (${filter.from ?? null}::date IS NULL OR m.move_date >= ${filter.from ?? null}::date)
      AND (${filter.legalEntityId ?? null}::uuid IS NULL OR i.legal_entity_id = ${filter.legalEntityId ?? null}::uuid)
      AND (${filter.itemId ?? null}::uuid IS NULL OR m.item_id = ${filter.itemId ?? null}::uuid)
    ORDER BY m.item_id, m.move_date, m.id`.execute(ctx.trx);
  return rows;
}

export const costOf = (move: MoveRow): CostMove => ({ date: move.move_date, quantity: move.quantity, value: move.value });

// What a close stored of one item for one month, as the figures of a month.
interface SnapshotRow {
  item_id: string;
  legal_entity_id: string;
  month: string;
  opening_quantity: string;
  opening_value: string;
  in_quantity: string;
  in_value: string;
  out_quantity: string;
  out_value: string;
  closing_quantity: string;
  closing_value: string;
  unit_cost: string | null;
}

// The last closed month of each legal entity on or before `month`, and what that close stored of each item. An entity with no closed month is not in the map.
export interface ClosedMonths {
  lastByEntity: Map<string, string>;
  snapshots: Map<string, SnapshotRow>;
}

export async function closedMonths(ctx: Pick<QueryContext, 'trx' | 'orgId'>, month: string, legalEntityId: string | undefined): Promise<ClosedMonths> {
  const { rows: periods } = await sql<{ id: string; legal_entity_id: string; month: string }>`
    SELECT p.id::text AS id, p.legal_entity_id::text AS legal_entity_id, pg_catalog.to_char(p.period_month, 'YYYY-MM') AS month
    FROM crove_finance.stock_period p
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.period_month <= ${`${month}-01`}::date
      AND (${legalEntityId ?? null}::uuid IS NULL OR p.legal_entity_id = ${legalEntityId ?? null}::uuid)`.execute(ctx.trx);
  const lastByEntity = new Map<string, string>();
  for (const p of periods) {
    const was = lastByEntity.get(p.legal_entity_id);
    if (was === undefined || p.month > was) lastByEntity.set(p.legal_entity_id, p.month);
  }
  const last = periods.filter((p) => lastByEntity.get(p.legal_entity_id) === p.month).map((p) => p.id);
  const snapshots = new Map<string, SnapshotRow>();
  if (last.length > 0) {
    const { rows } = await sql<SnapshotRow>`
      SELECT i.item_id::text AS item_id, i.legal_entity_id::text AS legal_entity_id, pg_catalog.to_char(p.period_month, 'YYYY-MM') AS month,
             i.opening_quantity::text AS opening_quantity, i.opening_value::text AS opening_value, i.in_quantity::text AS in_quantity, i.in_value::text AS in_value,
             i.out_quantity::text AS out_quantity, i.out_value::text AS out_value, i.closing_quantity::text AS closing_quantity, i.closing_value::text AS closing_value,
             i.unit_cost::text AS unit_cost
      FROM crove_finance.stock_period_item i JOIN crove_finance.stock_period p ON p.org_id = i.org_id AND p.id = i.period_id
      WHERE i.org_id = ${ctx.orgId}::uuid AND i.period_id = ANY (${last}::uuid[])`.execute(ctx.trx);
    for (const r of rows) snapshots.set(r.item_id, r);
  }
  return { lastByEntity, snapshots };
}

const plain = (value: string): string => {
  const text = money(value).toFixed();
  return text === '-0' ? '0' : text;
};

function fromSnapshot(s: SnapshotRow): MonthFigures {
  return {
    month: s.month,
    openingQuantity: plain(s.opening_quantity),
    openingValue: plain(s.opening_value),
    inQuantity: plain(s.in_quantity),
    inValue: plain(s.in_value),
    outQuantity: plain(s.out_quantity),
    outValue: plain(s.out_value),
    closingQuantity: plain(s.closing_quantity),
    closingValue: plain(s.closing_value),
    unitCost: s.unit_cost === null ? null : plain(money(s.unit_cost).toDecimalPlaces(6).toFixed()),
  };
}

// An item's figures for `month`: what the close stored when its entity closed that month, else the months folded from the balance of the entity's last closed month before it (the
// moves of the months up to it are not folded again), else every move folded from the first. `closed` is true for the first.
export function figuresOf(moves: readonly MoveRow[], month: string, itemId: string, entityId: string, closed: ClosedMonths): { figures: MonthFigures | null; closed: boolean } {
  const last = closed.lastByEntity.get(entityId);
  if (last === undefined) return { figures: monthFigures(moves.map(costOf), month), closed: false };
  const snapshot = closed.snapshots.get(itemId);
  if (last === month) return { figures: snapshot ? fromSnapshot(snapshot) : null, closed: true };
  const after = `${nextMonth(last)}-01`;
  const opening: OpeningBalance = snapshot ? { quantity: snapshot.closing_quantity, value: snapshot.closing_value } : { quantity: '0', value: '0' };
  return { figures: monthFigures(moves.filter((m) => m.move_date >= after).map(costOf), month, { opening }), closed: false };
}

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
    const closed = await closedMonths(ctx, input.month, input.legalEntityId);
    const byItem = new Map<string, MoveRow[]>();
    for (const move of moves) {
      const bucket = byItem.get(move.item_id);
      if (bucket) bucket.push(move);
      else byItem.set(move.item_id, [move]);
    }
    const rows: StockReportRow[] = [];
    for (const item of items) {
      const own = byItem.get(item.id) ?? [];
      const { figures, closed: isClosed } = figuresOf(own, input.month, item.id, item.legal_entity_id, closed);
      // An item with no move and not in use has nothing to report; one a closed month stored is reported as it was stored.
      if (own.length === 0 && !item.active && figures === null) continue;
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
        closed: isClosed,
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
    const item = await ctx.trx
      .selectFrom('crove_finance.stock_item')
      .select(['id', 'legal_entity_id', 'code', 'name', 'unit'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
    const moves = await movesUpTo(ctx, input.month, { itemId: item.id });
    const closed = await closedMonths(ctx, input.month, item.legal_entity_id);
    const { figures, closed: isClosed } = figuresOf(moves, input.month, item.id, item.legal_entity_id, closed);
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
      provisional: !isClosed,
      moves: card,
    };
  },
});

export const stockPeriods = defineQuery({
  name: 'finance.stock.periods',
  input: zStockPeriodsInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockPeriod[]> => {
    const { rows } = await sql<{ id: string; legal_entity_id: string; month: string; total_cost: string; voucher_id: string | null; closed_at: Date | string }>`
      SELECT p.id::text AS id, p.legal_entity_id::text AS legal_entity_id, pg_catalog.to_char(p.period_month, 'YYYY-MM') AS month, p.total_cost::text AS total_cost,
             p.voucher_id::text AS voucher_id, p.closed_at
      FROM crove_finance.stock_period p
      WHERE p.org_id = ${ctx.orgId}::uuid AND (${input.legalEntityId ?? null}::uuid IS NULL OR p.legal_entity_id = ${input.legalEntityId ?? null}::uuid)
      ORDER BY p.period_month DESC, p.id`.execute(ctx.trx);
    return rows.map((r) => ({
      id: r.id,
      legalEntityId: r.legal_entity_id,
      month: r.month,
      totalCost: plain(r.total_cost),
      voucherId: r.voucher_id,
      closedAt: new Date(r.closed_at).toISOString(),
    }));
  },
});

export const stockReportQueries = [stockReport, stockCard, stockPeriods];
