// SPDX-License-Identifier: AGPL-3.0-only
// Reads suggested lost-goods cost for marketplace settlement lines (#4337, option B of #4303 S4):
// for each settlement line's order, finds its live ship moves (current attempt, unreversed) and multiplies each move's shipped quantity by the item's monthly weighted-average unit cost
// at the ship date's month, reusing stock-report / stock-close cost folding (`closedMonths`, `movesUpTo`, `figuresOf` -> `monthFigures`).
// Advisory only: the UI prefills `costAmount` from this suggestion for a person to confirm or edit, and `finance.marketplace_payout.record` still requires and bounds the person's explicit `costAmount`.
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';
import { suggestOrderLostCost } from './domain/marketplace-payout-cost.ts';
import { nextMonth } from './domain/stock-cost.ts';
import { closedMonths, figuresOf, movesUpTo, type StockCostMoveRow } from './stock-report.ts';

interface ShipMoveRow {
  settlement_line_id: string;
  item_id: string | null;
  legal_entity_id: string | null;
  ship_date: string | null;
  quantity: string | null;
}

// Returns a map from lowercase settlement line id to whole-dong suggested costAmount for lines whose order has live ship moves for every shipped line and a priced unit cost for each move.
export async function suggestCompensationCosts(
  ctx: Pick<QueryContext, 'trx' | 'orgId'>,
  settlementLineIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniqueIds = [...new Set(settlementLineIds.map((id) => id.toLowerCase()))];
  if (uniqueIds.length === 0) return out;

  // Include active shipped order lines without a live ship move (item_id IS NULL) so partial assignment on a multi-line order omits the suggestion rather than under-suggesting one part.
  const { rows: shipMoves } = await sql<ShipMoveRow>`
    SELECT sl.id::text AS settlement_line_id,
           s.item_id::text AS item_id,
           i.legal_entity_id::text AS legal_entity_id,
           s.move_date::text AS ship_date,
           (-s.quantity)::text AS quantity
    FROM ludy_finance.channel_settlement_line sl
    JOIN ludy_finance.channel_order_line ol
      ON ol.org_id = sl.org_id AND ol.legal_entity_id = sl.legal_entity_id AND ol.order_id = sl.order_id
    LEFT JOIN ludy_finance.stock_move s
      ON s.org_id = ol.org_id
      AND s.order_line_id = ol.id
      AND s.order_move = 'ship'
      AND s.order_attempt = ol.attempt
      AND NOT EXISTS (
        SELECT 1 FROM ludy_finance.stock_move r
        WHERE r.org_id = s.org_id AND r.reverses_move_id = s.id
      )
    LEFT JOIN ludy_finance.stock_item i
      ON i.org_id = s.org_id AND i.id = s.item_id
    WHERE sl.org_id = ${ctx.orgId}::uuid
      AND sl.id = ANY (${uniqueIds}::uuid[])
      AND (s.id IS NOT NULL OR ol.stage IN ('shipped', 'completed', 'returned'))
    ORDER BY sl.id, ol.id, s.id`.execute(ctx.trx);

  if (shipMoves.length === 0) return out;

  // Group needed item lookups by (legalEntityId, shipMonth) so each distinct entity-month reads closed periods and moves at most once.
  const buckets = new Map<string, { legalEntityId: string; month: string; itemIds: Set<string> }>();
  for (const row of shipMoves) {
    if (row.item_id === null || row.legal_entity_id === null || row.ship_date === null || row.quantity === null) continue;
    const month = row.ship_date.slice(0, 7);
    const key = `${row.legal_entity_id}:${month}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { legalEntityId: row.legal_entity_id, month, itemIds: new Set() };
      buckets.set(key, bucket);
    }
    bucket.itemIds.add(row.item_id);
  }

  const unitCostByItemMonth = new Map<string, string | null>();
  for (const bucket of buckets.values()) {
    const itemIds = [...bucket.itemIds];
    const closed = await closedMonths(ctx, bucket.month, bucket.legalEntityId, itemIds);
    const last = closed.lastByEntity.get(bucket.legalEntityId);
    const byItem = new Map<string, StockCostMoveRow[]>();
    if (last !== bucket.month) {
      const from = last === undefined ? undefined : `${nextMonth(last)}-01`;
      const moves = await movesUpTo(ctx, bucket.month, { legalEntityId: bucket.legalEntityId, itemIds, ...(from ? { from } : {}) });
      for (const move of moves) {
        const list = byItem.get(move.item_id);
        if (list) list.push(move);
        else byItem.set(move.item_id, [move]);
      }
    }
    for (const itemId of itemIds) {
      const { figures } = figuresOf(byItem.get(itemId) ?? [], bucket.month, itemId, bucket.legalEntityId, closed);
      unitCostByItemMonth.set(`${itemId}:${bucket.month}`, figures?.unitCost ?? null);
    }
  }

  const movesByLine = new Map<string, ShipMoveRow[]>();
  for (const row of shipMoves) {
    const lineId = row.settlement_line_id.toLowerCase();
    const list = movesByLine.get(lineId);
    if (list) list.push(row);
    else movesByLine.set(lineId, [row]);
  }
  for (const [lineId, rows] of movesByLine) {
    const suggested = suggestOrderLostCost(
      rows.map((r) =>
        r.item_id === null || r.ship_date === null || r.quantity === null
          ? { quantity: '1', unitCost: null }
          : {
              quantity: r.quantity,
              unitCost: unitCostByItemMonth.get(`${r.item_id}:${r.ship_date.slice(0, 7)}`) ?? null,
            },
      ),
    );
    if (suggested !== null) out.set(lineId, suggested);
  }
  return out;
}
