// SPDX-License-Identifier: AGPL-3.0-only
// The reads behind the finance coworker on stock (#2514, plan stock-and-marketplaces.md section 8.6). Every one runs in the caller's own transaction and writes nothing:
// - finance.stock.low (every role reads): the items whose stock will not last the lead days at the pace of the last eight weeks, with the supplier each was last bought from and
//   how much to ask for (domain/stock-low.ts). Home's "Hàng sắp hết" item counts the same list.
// - finance.stock.suggest_source (owners, admins, members): the unassigned goods lines a person asked about and the entity's items, as the model may see them (a line's description
//   and unit; an item's code, name and unit; no amount, party or document number). The API asks the model outside any transaction and checks what it answers.
// - finance.stock.reorder_source (same roles): the names, units and quantities of a reorder message, the supplier, the business's name and the fixed template. The text itself is the
//   model's or the template, never stored.
// The sales pace counts what left through a posted sale or a shipped marketplace order, net of its reversals and returns, each dated by the move it undoes (a return by the shipment of
// its line); counts, manual moves and purchases are not sales.
import { sql } from 'kysely';
import { zStockLowInput, zStockReorderAsk, zStockSuggestInput, STOCK_LEAD_DAYS_DEFAULT, STOCK_REORDER_ITEMS_MAX, type StockLowItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { LOW_WINDOW_DAYS, lowFigures, observedDays, pickCandidates, reorderTemplate } from './domain/stock-low.ts';
import { plainQuantity } from './domain/stock.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { oneLine } from './missing-invoices.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The most items the model is offered for the lines of one call (packages/agent STOCK_MATCH_ITEMS_MAX).
const OFFERED_ITEMS_MAX = 60;

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

interface PaceRow {
  item_id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  unit: string;
  on_hand: string;
  first_move: string | null;
  sold: string;
}

// One plain ASCII address: letters, digits and . _ + - before the @, a dotted domain after it. Nothing a mailto: link reads as more than the address (no ? & = # % or space), so a seller's
// e-mail on an invoice can never add a recipient or a body.
const PLAIN_ADDRESS = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const plainEmail = (email: string | null): string | null => (email !== null && PLAIN_ADDRESS.test(email.trim()) ? email.trim() : null);

interface Supplier {
  partyId: string;
  name: string;
  email: string | null;
}

// The party an item was last bought from (the kept party of a duplicate group), by item. A bought-in move that was reversed (a voided or replaced document) does not count.
async function suppliersOf(ctx: Ctx, itemIds: readonly string[]): Promise<Map<string, Supplier>> {
  const found = new Map<string, Supplier>();
  if (itemIds.length === 0) return found;
  const { rows } = await sql<{ item_id: string; party_id: string }>`
    SELECT DISTINCT ON (pm.item_id) pm.item_id::text AS item_id, coalesce(x.duplicate_of, x.id)::text AS party_id
    FROM crove_finance.stock_move pm
    JOIN crove_finance.purchase_document d ON d.org_id = pm.org_id AND d.id = pm.document_id AND d.direction = 'purchase'
    JOIN crove_kernel.party x ON x.org_id = d.org_id AND x.id = d.party_id
    WHERE pm.org_id = ${ctx.orgId}::uuid AND pm.item_id = ANY (${[...itemIds]}::uuid[]) AND pm.source_type = 'document_line' AND pm.quantity > 0
      AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = pm.org_id AND r.reverses_move_id = pm.id)
    ORDER BY pm.item_id, pm.move_date DESC, pm.id DESC`.execute(ctx.trx);
  if (rows.length === 0) return found;
  const parties = await ctx.trx
    .selectFrom('crove_kernel.party')
    .select(['id', 'name', 'email'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...new Set(rows.map((r) => r.party_id))])
    .execute();
  const byId = new Map(parties.map((p) => [p.id, p]));
  for (const row of rows) {
    const party = byId.get(row.party_id);
    if (party) found.set(row.item_id, { partyId: party.id, name: oneLine(party.name), email: plainEmail(party.email) });
  }
  return found;
}

/** The items running low (see the header), the shortest cover first, then by code; `legalEntityId` limits the read to one entity (the caller's row policies keep an entity they may not
 * see out of it either way). */
export async function lowStockItems(ctx: Ctx, options: { legalEntityId?: string | undefined; leadDays: number; limit: number }): Promise<StockLowItem[]> {
  const today = await databaseToday(ctx.trx);
  const entity = options.legalEntityId ?? null;
  const { rows } = await sql<PaceRow>`
    WITH out_moves AS (
      -- What left through a sale or a shipped order line, and what undid it. A return of an order line, and the reversal of one, count on the day the line shipped; any other reversal on the day
      -- of the move it undoes. A shipment or a sale is read only inside the window, so the rows read are the window's plus the (few) returns and reversals of the org.
      SELECT m.item_id, m.quantity,
             CASE WHEN m.source_type = 'reversal' THEN coalesce(osh.move_date, o.move_date)
                  WHEN m.order_move = 'return' THEN coalesce(sh.move_date, m.move_date)
                  ELSE m.move_date END AS effective_date
      FROM crove_finance.stock_move m
      LEFT JOIN crove_finance.stock_move o ON o.org_id = m.org_id AND o.id = m.reverses_move_id
      LEFT JOIN crove_finance.stock_move sh ON sh.org_id = m.org_id AND m.order_move = 'return' AND sh.order_line_id = m.order_line_id AND sh.order_move = 'ship' AND sh.order_attempt = m.order_attempt
      LEFT JOIN crove_finance.stock_move osh ON osh.org_id = o.org_id AND o.order_move = 'return' AND osh.order_line_id = o.order_line_id AND osh.order_move = 'ship' AND osh.order_attempt = o.order_attempt
      WHERE m.org_id = ${ctx.orgId}::uuid
        AND (
          (m.source_type = 'document_line' AND m.quantity < 0 AND m.move_date > (${today}::date - ${LOW_WINDOW_DAYS}::int))
          OR (m.source_type = 'order_line' AND (m.order_move = 'return' OR m.move_date > (${today}::date - ${LOW_WINDOW_DAYS}::int)))
          OR (m.source_type = 'reversal' AND (o.source_type = 'order_line' OR (o.source_type = 'document_line' AND o.quantity < 0)))
        )
    ), sold AS (
      SELECT item_id, -pg_catalog.sum(quantity) AS sold
      FROM out_moves
      WHERE effective_date > (${today}::date - ${LOW_WINDOW_DAYS}::int) AND effective_date <= ${today}::date
      GROUP BY item_id
    ), stock AS (
      -- Only the items that sold in the window need their balance.
      SELECT m.item_id, pg_catalog.sum(m.quantity) AS on_hand, pg_catalog.min(m.move_date) AS first_move
      FROM crove_finance.stock_move m
      WHERE m.org_id = ${ctx.orgId}::uuid AND m.item_id IN (SELECT item_id FROM sold)
      GROUP BY m.item_id
    )
    SELECT i.id::text AS item_id, i.legal_entity_id::text AS legal_entity_id, i.code, i.name, i.unit,
           coalesce(s.on_hand, 0)::text AS on_hand, s.first_move::text AS first_move, sold.sold::text AS sold
    FROM crove_finance.stock_item i
    JOIN sold ON sold.item_id = i.id
    LEFT JOIN stock s ON s.item_id = i.id
    WHERE i.org_id = ${ctx.orgId}::uuid AND i.active
      AND (${entity}::uuid IS NULL OR i.legal_entity_id = ${entity}::uuid)
    ORDER BY i.code, i.id`.execute(ctx.trx);
  const low = rows
    .flatMap((row) => {
      const figures = lowFigures({ onHand: row.on_hand, sold: row.sold, days: observedDays(today, row.first_move), leadDays: options.leadDays });
      return figures === null ? [] : [{ row, figures }];
    })
    .sort((a, b) => a.figures.coverDays - b.figures.coverDays || a.row.code.localeCompare(b.row.code))
    .slice(0, options.limit);
  const suppliers = await suppliersOf(ctx, low.map((l) => l.row.item_id));
  return low.map(({ row, figures }) => ({
    itemId: row.item_id,
    legalEntityId: row.legal_entity_id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    onHand: plainQuantity(row.on_hand),
    dailyOut: figures.dailyOut,
    coverDays: figures.coverDays,
    suggestedQuantity: figures.suggestedQuantity,
    supplier: suppliers.get(row.item_id) ?? null,
  }));
}

export const stockLow = defineQuery({
  name: 'finance.stock.low',
  input: zStockLowInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockLowItem[]> =>
    lowStockItems(ctx, { legalEntityId: input.legalEntityId, leadDays: input.leadDays ?? STOCK_LEAD_DAYS_DEFAULT, limit: input.limit ?? 50 }),
});

// What the model may see of the lines a person asked about, and of the items to choose among.
export interface SuggestSource {
  lines: Array<{ documentId: string; lineNo: number; description: string; unit: string | null }>;
  items: Array<{ id: string; code: string; name: string; unit: string }>;
}

export const stockSuggestSource = defineQuery({
  name: 'finance.stock.suggest_source',
  input: zStockSuggestInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<SuggestSource> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    // Only lines that are still unassigned in this entity count: an assigned, voided or foreign line is left out, never read.
    const open = await ctx.query<Array<{ documentId: string; lineNo: number; description: string; unit: string | null }>>('finance.stock.unassigned', { legalEntityId: entity, limit: 500 });
    if (open.status !== 'ok') return { lines: [], items: [] };
    const asked = new Set(input.lines.map((l) => `${l.documentId}:${l.lineNo}`));
    const lines = open.value.filter((l) => asked.has(`${l.documentId}:${l.lineNo}`) && l.description.trim() !== '').map((l) => ({ documentId: l.documentId, lineNo: l.lineNo, description: l.description, unit: l.unit }));
    if (lines.length === 0) return { lines: [], items: [] };
    const items = await ctx.trx
      .selectFrom('crove_finance.stock_item')
      .select(['id', 'code', 'name', 'unit'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('active', '=', true)
      .orderBy('code')
      .execute();
    return { lines, items: pickCandidates(lines.map((l) => l.description), items, OFFERED_ITEMS_MAX) };
  },
});

// The facts of a reorder message as the books hold them, and the fixed template over them.
export interface ReorderSource {
  orgName: string;
  supplier: Supplier | null;
  items: Array<{ itemId: string; name: string; unit: string; quantity: string }>;
  template: string;
}

export const stockReorderSource = defineQuery({
  name: 'finance.stock.reorder_source',
  input: zStockReorderAsk,
  access: EDITORS,
  handler: async (ctx, input): Promise<ReorderSource> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const ids = input.items.map((i) => i.itemId);
    if (new Set(ids).size !== ids.length) throw new DomainError('STOCK_REORDER_DUPLICATE', 422, 'Mỗi mặt hàng chỉ nằm một lần trong tin đặt hàng');
    if (ids.length > STOCK_REORDER_ITEMS_MAX) throw new DomainError('STOCK_REORDER_TOO_MANY', 422, 'Tin đặt hàng có quá nhiều mặt hàng');
    for (const line of input.items) {
      if (!money(line.quantity).greaterThan(0)) throw new DomainError('STOCK_REORDER_QUANTITY', 422, 'Số lượng đặt phải lớn hơn không');
    }
    const rows = await ctx.trx.selectFrom('crove_finance.stock_item').select(['id', 'legal_entity_id', 'name', 'unit']).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = input.items.map((line) => {
      const item = byId.get(line.itemId);
      if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
      if (item.legal_entity_id !== entity) throw new DomainError('STOCK_ITEM_ENTITY_MISMATCH', 422, 'Mặt hàng và pháp nhân đang chọn không khớp nhau');
      return { itemId: item.id, name: oneLine(item.name), unit: oneLine(item.unit, 40), quantity: plainQuantity(line.quantity) };
    });
    let supplier: Supplier | null = null;
    if (input.supplierPartyId) {
      const party = await ctx.trx
        .selectFrom('crove_kernel.party')
        .select(['id', 'name', 'email'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.supplierPartyId)
        .executeTakeFirst();
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy đối tác này');
      supplier = { partyId: party.id, name: oneLine(party.name), email: plainEmail(party.email) };
    }
    const holder = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
    const tenant = holder ? null : await ctx.trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const orgName = oneLine(holder?.name ?? tenant?.name ?? '');
    const language = input.lang ?? 'vi';
    return { orgName, supplier, items, template: reorderTemplate({ language, orgName, supplierName: supplier?.name ?? null, items }) };
  },
});

export const stockLowQueries = [stockLow, stockSuggestSource, stockReorderSource];
