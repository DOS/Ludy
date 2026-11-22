// SPDX-License-Identifier: AGPL-3.0-only
// The stock side of a marketplace return (#4355, rule 8 of #2520, plan docs/plan/stock-and-marketplaces.md section 8.4): a person says whether the goods of a line that came back are back.
// The platform's status ("returned", or cancelled after the shipment) only offers the question: its report cannot tell a return from a refund-only claim or a loss, so no report writes the return
// move any more (marketplace-orders.ts writes the shipment only).
// - finance.marketplace_return.decide (R1, owners, admins and members, a person only): `back` writes the stock-in of the shipment's item and quantity, dated today (a closed month takes it in the open
//   one), priced by the month close at the month's average, Dr 156 / Cr 632 in the close entry a person approves; `not_back` moves nothing. The answer is stored on the line with its attempt, the member
//   and the time, once (the database guard holds it). Nothing is posted here; the existing approvals stand.
// - returnsToConfirm is the work list's read of the lines that wait for the answer; compensatedOrder and goodsBackOnLines are the two halves of the exclusion between this answer and S4's carrier
//   compensation (#4338): an order with a payout proposal that names carrier compensation on one of its settlement lines is not offered, and a payout cannot classify carrier compensation on an order
//   that has a return move. Both look at the order, not the line: a settlement line carries the income report's row key, which is not the order line's.
// Uncertain (#2520): the move is dated the confirmation day because no report gives a return day; whether the platform's return status means the goods are physically back is the person's call.
import { sql, type RawBuilder } from 'kysely';
import { zMarketplaceReturnDecide, type MarketplaceReturnDecided, type MarketplaceReturnToConfirm } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, type QueryContext } from '@ludy/kernel-runtime';
import { oppositeQuantity, plainQuantity } from './domain/stock.ts';
import { platformPartyName } from './marketplace-settlement-record.ts';
import { databaseToday } from './period-lock.ts';
import { writeStockMove } from './stock.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The most lines the list shows at once.
const OFFERED_MAX = 200;

// Whether an order has a settlement line that a payout proposal (waiting, approved or executed) names as carrier compensation. A rejected, failed or expired proposal does not count. `orderId` is an
// SQL expression of the order's id.
const compensatedOn = (orgId: string, orderId: RawBuilder<unknown>): RawBuilder<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM crove_kernel.proposal p
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.payload -> 'adjustments') = 'array' THEN p.payload -> 'adjustments' ELSE '[]'::jsonb END) AS a
  JOIN crove_finance.channel_settlement_line sl ON sl.org_id = p.org_id AND sl.id::text = lower(a ->> 'lineId')
  WHERE p.org_id = ${orgId}::uuid AND p.command = 'finance.marketplace_payout.record'
    AND p.status IN ('pending', 'approved', 'executed') AND a ->> 'kind' = 'carrier_compensation'
    AND sl.order_id = ${orderId})`;

interface OfferedRow {
  id: string;
  legal_entity_id: string;
  platform: string;
  order_no: string;
  sku: string | null;
  stage: 'returned' | 'cancelled';
  shipped_at: string | null;
  code: string;
  name: string;
  unit: string;
  quantity: string;
}

// The lines that came back and wait for "are the goods back?": returned, or cancelled after the shipment; with their live shipment, no return move, no answer for the live attempt, and no carrier
// compensation on their order. One query, newest orders first, at most OFFERED_MAX.
export async function returnsToConfirm(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string | undefined): Promise<MarketplaceReturnToConfirm[]> {
  const { rows } = await sql<OfferedRow>`
    SELECT l.id::text AS id, l.legal_entity_id::text AS legal_entity_id, o.platform, o.order_no, l.sku, l.stage, l.shipped_at::text AS shipped_at,
           i.code, i.name, i.unit, (-s.quantity)::text AS quantity
    FROM crove_finance.channel_order_line l
    JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id
    JOIN crove_finance.stock_move s ON s.org_id = l.org_id AND s.order_line_id = l.id AND s.order_move = 'ship' AND s.order_attempt = l.attempt
    JOIN crove_finance.stock_item i ON i.org_id = s.org_id AND i.id = s.item_id
    WHERE l.org_id = ${ctx.orgId}::uuid
      AND l.stage IN ('returned', 'cancelled')
      AND (l.goods_back IS NULL OR l.goods_back_attempt <> l.attempt)
      AND (${legalEntityId ?? null}::uuid IS NULL OR l.legal_entity_id = ${legalEntityId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = l.org_id AND r.order_line_id = l.id AND r.order_move = 'return' AND r.order_attempt = l.attempt)
      AND NOT ${compensatedOn(ctx.orgId, sql`l.order_id`)}
    ORDER BY o.ordered_at DESC NULLS LAST, o.id, l.line_key
    LIMIT ${OFFERED_MAX}`.execute(ctx.trx);
  return rows.map((r) => ({
    orderLineId: r.id,
    legalEntityId: r.legal_entity_id,
    platform: r.platform,
    platformName: platformPartyName(r.platform),
    orderNo: r.order_no,
    sku: r.sku,
    itemCode: r.code,
    itemName: r.name,
    unit: r.unit,
    quantity: plainQuantity(r.quantity),
    stage: r.stage,
    shippedAt: r.shipped_at === null ? null : r.shipped_at.slice(0, 10),
  }));
}

// The first of the settlement lines whose order has a live return move (a line that came back, by the old automatic return or by a person's answer): a payout cannot classify carrier compensation on
// it, the goods came back. Null when none does. The live attempt only: the moves of an earlier attempt were reversed.
export async function goodsBackOnLines(ctx: Pick<QueryContext, 'trx' | 'orgId'>, settlementLineIds: readonly string[]): Promise<string | null> {
  if (settlementLineIds.length === 0) return null;
  const row = await ctx.trx
    .selectFrom('crove_finance.channel_settlement_line as sl')
    .innerJoin('crove_finance.channel_order_line as ol', (join) => join.onRef('ol.org_id', '=', 'sl.org_id').onRef('ol.order_id', '=', 'sl.order_id'))
    .innerJoin('crove_finance.stock_move as m', (join) =>
      join.onRef('m.org_id', '=', 'ol.org_id').onRef('m.order_line_id', '=', 'ol.id').onRef('m.order_attempt', '=', 'ol.attempt').on('m.order_move', '=', 'return'),
    )
    .select('sl.id')
    .where('sl.org_id', '=', ctx.orgId)
    .where('sl.id', 'in', [...settlementLineIds])
    .orderBy('sl.id')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export const marketplaceReturnDecide = defineCommand({
  name: 'finance.marketplace_return.decide',
  input: zMarketplaceReturnDecide,
  // Writes a stock move or nothing, and the answer on the line: no entry is posted here (R1, like finance.stock_move.return).
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.channel_order_line', id: input.orderLineId }),
  handler: async (ctx, input): Promise<MarketplaceReturnDecided> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xác nhận được hàng trả về');
    const userId = ctx.actor.userId;
    // The lock the assignment of the same line takes, then the row: an answer, an assignment and a report that confirms the line cannot interleave.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace.line:${ctx.orgId}:${input.orderLineId}`}, 0))`.execute(ctx.trx);
    await ctx.trx.selectFrom('crove_finance.channel_order_line').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.orderLineId).forUpdate().executeTakeFirst();
    const line = await ctx.trx
      .selectFrom('crove_finance.channel_order_line')
      .select(['id', 'order_id', 'stage', 'attempt', 'goods_back', 'goods_back_attempt'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.orderLineId)
      .executeTakeFirst();
    if (!line) throw new DomainError('MARKETPLACE_RETURN_NOT_FOUND', 404, 'Không tìm thấy dòng đơn hàng này');
    const made = await ctx.trx
      .selectFrom('crove_finance.stock_move')
      .select(['order_move', 'item_id', 'quantity'])
      .where('org_id', '=', ctx.orgId)
      .where('order_line_id', '=', line.id)
      .where('order_attempt', '=', line.attempt)
      .execute();
    const ship = made.find((m) => m.order_move === 'ship');
    // Answered already: by a person for this attempt, or by the old automatic return, which stays as it was.
    if ((line.goods_back !== null && line.goods_back_attempt === line.attempt) || made.some((m) => m.order_move === 'return')) {
      throw new DomainError('MARKETPLACE_RETURN_DECIDED', 409, 'Dòng này đã được xác nhận hàng về hoặc không về');
    }
    if ((line.stage !== 'returned' && line.stage !== 'cancelled') || !ship) {
      throw new DomainError('MARKETPLACE_RETURN_NOT_OFFERED', 422, 'Dòng này chưa được báo trả hàng hoặc chưa có phiếu xuất kho để hoàn lại');
    }
    const compensated = (await sql<{ yes: boolean }>`SELECT ${compensatedOn(ctx.orgId, sql`${line.order_id}::uuid`)} AS yes`.execute(ctx.trx)).rows[0]?.yes === true;
    if (compensated) {
      throw new DomainError('MARKETPLACE_RETURN_COMPENSATED', 409, 'Đơn này đã được phân loại là hãng vận chuyển bồi thường hàng mất trong khoản sàn trả, nên không xác nhận hàng về được');
    }
    await ctx.trx
      .updateTable('crove_finance.channel_order_line')
      .set({ goods_back: input.decision, goods_back_attempt: line.attempt, goods_back_by: userId, goods_back_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', line.id)
      .execute();
    let moveId: string | null = null;
    if (input.decision === 'back') {
      const today = await databaseToday(ctx.trx);
      moveId = await writeStockMove(ctx, {
        itemId: ship.item_id,
        date: today,
        quantity: oppositeQuantity(String(ship.quantity)),
        source: { type: 'order_line', orderLineId: line.id, move: 'return', attempt: line.attempt },
      });
    }
    ctx.audit({ orderLineId: line.id, decision: input.decision, itemId: ship.item_id, moveId });
    return { orderLineId: line.id, decision: input.decision, moveId };
  },
});

export const marketplaceReturnCommands = [marketplaceReturnDecide];
