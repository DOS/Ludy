// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports as files (#2515, ADR-0045 points 4, 5 and 7): a Shopee, TikTok Shop or Lazada order report forwarded to the org's inbound address or dropped in the Inbox
// as an .xlsx or CSV, read in the parsing sandbox (kind marketplace_orders, through the platform's profile) and STAGED: the lines are kept with the file's read, none is stored as an
// order, until a member confirms. Like a bank statement (#2142), a file's sender chooses nothing: the platform is told by the file's headers and shown for confirmation, the legal entity
// is the one the file was uploaded for (or the org's default), and a forged or unknown file stages nothing. No buyer data is read at all (the sandbox returns an allow-list of columns), so
// none can be stored, shown or logged.
// - readMarketplaceFile is the worker's side, tried before the bank statement's: the sandbox's answer is checked again, then the read is recorded (kernel.extraction.record) as done
//   (staged, with the lines) or failed (the exception, with the reason); a file that is no order report is not handled and goes on as before.
// - finance.marketplace.staged and .preview (members) are what the Inbox card shows: the summary, and how the lines stand against the org's orders and stock items now.
// - finance.marketplace.confirm (owners, admins, members; R1) stores the orders once, deduplicated on (platform, order number, line), moves a line's stage forward and never back, writes the
//   stock moves of the lines that name an item (a shipment takes stock out at the shipping day, a return brings it back), and marks the read imported, in one transaction;
//   finance.marketplace.reject skips it. Both run on the staged run only, locked, so two members cannot both decide it, and a re-upload is idempotent.
import { sql } from 'kysely';
import { z } from 'zod';
import { EXTRACT_LIMIT_RETRIES, EXTRACT_LIMITS, zExtractedMarketplaceOrders, type ExtractClient } from '@crove/extract-contract';
import type { MemberRole } from '@crove/db';
import { STAGED_STATEMENT_MAX_BYTES, zId, zMarketplaceAssign, zMarketplaceOrdersInput, zMarketplaceSummary, zMarketplaceUnassignedInput, type MarketplaceConfirmResult, type MarketplaceOrder, type MarketplacePreview, type MarketplaceUnassignedLine, type MarketplaceStaged, type MarketplaceSummary } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, readVerified, type BlobStore, type CommandContext, type QueryContext, type Runtime } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { moveQuantity, movableQuantity, normalizeAlias, plainQuantity } from './domain/stock.ts';
import { loadItem, writeStockMove } from './stock.ts';

export const MARKETPLACE_ACTOR = { type: 'system' as const, component: 'finance.marketplace' };
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const ZIP = 'application/zip';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv';

type Platform = MarketplaceSummary['platform'];
type Stage = keyof MarketplaceSummary['stages'];
const zLine = zExtractedMarketplaceOrders.shape.lines.element;
type StagedLine = z.infer<typeof zLine>;
const zStagedResult = z.object({ kind: z.literal('marketplace_orders'), summary: zMarketplaceSummary, lines: z.array(zLine).optional() });

// How far a line may move: forward only, the same moves the table's guard allows (an unknown status to any, placed to shipped, completed, returned or cancelled, shipped to completed,
// returned or cancelled, completed to returned; cancelled and returned are final).
export function canAdvance(from: Stage, to: Stage): boolean {
  if (from === to) return false;
  if (from === 'unknown') return true;
  if (from === 'placed') return to === 'shipped' || to === 'completed' || to === 'returned' || to === 'cancelled';
  if (from === 'shipped') return to === 'completed' || to === 'returned' || to === 'cancelled';
  if (from === 'completed') return to === 'returned';
  return false;
}

// The stages that move stock: a shipment takes it out, a return brings it back; a placed or cancelled order moves nothing.
const MOVES_STOCK: ReadonlySet<Stage> = new Set(['shipped', 'completed', 'returned']);

// The summary a staged read keeps: the file's own figures, nothing of the orders' content beyond counts.
export function summaryOf(read: { platform: Platform; profile: { version: string; confirmed: boolean }; lines: readonly StagedLine[]; skipped: ReadonlyArray<{ reason: string }>; unknownStatuses: readonly string[] }, filename: string): MarketplaceSummary {
  const stages = { placed: 0, shipped: 0, completed: 0, cancelled: 0, returned: 0, unknown: 0 };
  const orders = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;
  for (const line of read.lines) {
    stages[line.stage] += 1;
    orders.add(line.orderNo);
    if (line.orderedAt !== null && (from === null || line.orderedAt < from)) from = line.orderedAt;
    if (line.orderedAt !== null && (to === null || line.orderedAt > to)) to = line.orderedAt;
  }
  return {
    state: 'staged',
    platform: read.platform,
    profileVersion: read.profile.version,
    profileConfirmed: read.profile.confirmed,
    filename,
    orders: orders.size,
    lines: read.lines.length,
    from,
    to,
    stages,
    unknownStatuses: [...read.unknownStatuses],
    ignoredRows: read.skipped.filter((s) => s.reason === 'no_order_no').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The items a line's SKU names
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface ItemMatch {
  itemId: string;
  // How many of the item's units one unit of the report's is (a taught name carries it, an item code is 1).
  factor: string;
}

// The item each SKU names, in the entity: the item's code (the SKU is the code, without case), else a name taught for this platform (the alias of source = the platform, with its
// factor). Nothing is guessed; an ambiguous code names none. Read under the caller's own policies.
async function matchSkus(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string, platform: Platform, skus: readonly string[]): Promise<Map<string, ItemMatch>> {
  const keys = [...new Set(skus.map((s) => normalizeAlias(s)).filter((k) => k !== ''))];
  const out = new Map<string, ItemMatch>();
  if (keys.length === 0) return out;
  const items = await ctx.trx
    .selectFrom('crove_finance.stock_item')
    .select(['id', 'code'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('active', '=', true)
    .where(sql<string>`pg_catalog.lower(code)`, 'in', keys)
    .execute();
  const byCode = new Map<string, string | null>();
  for (const item of items) {
    const key = normalizeAlias(item.code);
    byCode.set(key, byCode.has(key) ? null : item.id);
  }
  for (const [key, id] of byCode) if (id !== null) out.set(key, { itemId: id, factor: '1' });
  const aliases = await ctx.trx
    .selectFrom('crove_finance.stock_alias as a')
    .innerJoin('crove_finance.stock_item as i', (join) => join.onRef('i.org_id', '=', 'a.org_id').onRef('i.id', '=', 'a.item_id'))
    .select(['a.alias_key', 'a.item_id', 'a.factor'])
    .where('a.org_id', '=', ctx.orgId)
    .where('a.legal_entity_id', '=', legalEntityId)
    .where('a.source', '=', platform)
    .where('a.alias_key', 'in', keys)
    .where('i.active', '=', true)
    .execute();
  for (const alias of aliases) if (!out.has(alias.alias_key)) out.set(alias.alias_key, { itemId: alias.item_id, factor: alias.factor });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The staged read
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The newest run of a file when it is a staged order report: the run a member decides. `lock`: the file row and the run are locked for the decision (the order a re-read and a record
// take them in, as for a bank statement).
async function stagedRun(ctx: QueryContext, fileId: string, lock: boolean): Promise<{ summary: MarketplaceSummary; platform: Platform; lines: StagedLine[]; legalEntityId: string | null; sha256: string } | null> {
  const file = await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'sha256']).where('org_id', '=', ctx.orgId).where('id', '=', fileId).$if(lock, (qb) => qb.forUpdate()).executeTakeFirst();
  if (!file) return null;
  let query = ctx.trx.selectFrom('crove_kernel.extraction').select(['result', 'status', 'legal_entity_id']).where('org_id', '=', ctx.orgId).where('file_id', '=', fileId).orderBy('version', 'desc').limit(1);
  if (lock) query = query.forUpdate();
  const run = await query.executeTakeFirst();
  if (!run || run.status !== 'done') return null;
  const parsed = zStagedResult.safeParse(run.result);
  if (!parsed.success || parsed.data.summary.state !== 'staged' || !parsed.data.lines) return null;
  return { summary: parsed.data.summary, platform: parsed.data.summary.platform, lines: parsed.data.lines, legalEntityId: run.legal_entity_id ?? null, sha256: file.sha256 };
}

const lockReport = (ctx: QueryContext, fileId: string) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace.report:${ctx.orgId}:${fileId}`}, 0))`.execute(ctx.trx);
const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;
const notStaged = () => new DomainError('MARKETPLACE_NOT_STAGED', 409, 'Báo cáo này đã được xử lý hoặc đã được đọc lại; hãy tải lại danh sách');

type OrderKey = { platform: Platform; orderNo: string; lineKey: string };
const keyOf = (k: OrderKey) => `${k.platform}\u0000${k.orderNo}\u0000${k.lineKey}`;

// The lines of this entity the report names, as the org holds them now, by (platform, order number, line).
async function knownLines(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string, platform: Platform, orderNos: readonly string[]) {
  const map = new Map<string, { id: string; stage: Stage; quantity: string; sku: string | null; shippedAt: string | null; orderedAt: string | null }>();
  for (let i = 0; i < orderNos.length; i += 1000) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.channel_order_line as l')
      .innerJoin('crove_finance.channel_order as o', (join) => join.onRef('o.org_id', '=', 'l.org_id').onRef('o.id', '=', 'l.order_id'))
      .select(['l.id', 'l.line_key', 'l.stage', 'l.quantity', 'l.sku', 'l.shipped_at', 'o.order_no', 'o.ordered_at'])
      .where('l.org_id', '=', ctx.orgId)
      .where('o.legal_entity_id', '=', legalEntityId)
      .where('o.platform', '=', platform)
      .where('o.order_no', 'in', orderNos.slice(i, i + 1000))
      .execute();
    for (const r of rows) {
      map.set(keyOf({ platform, orderNo: r.order_no, lineKey: r.line_key }), {
        id: r.id,
        stage: r.stage,
        quantity: String(r.quantity),
        sku: r.sku,
        shippedAt: r.shipped_at === null ? null : String(r.shipped_at).slice(0, 10),
        orderedAt: r.ordered_at === null ? null : String(r.ordered_at).slice(0, 10),
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Queries for the Inbox card
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const marketplaceStaged = defineQuery({
  name: 'finance.marketplace.staged',
  input: z.strictObject({}),
  access: IMPORTERS,
  handler: async (ctx): Promise<MarketplaceStaged[]> => {
    const { rows } = await sql<{ file_id: string; filename: string; created_at: Date; summary: unknown; legal_entity_id: string | null }>`
      SELECT x.file_id::text AS file_id, f.filename, f.created_at, x.result -> 'summary' AS summary, x.legal_entity_id::text AS legal_entity_id
      FROM crove_kernel.extraction x
      JOIN crove_kernel.file f ON f.org_id = x.org_id AND f.id = x.file_id
      WHERE x.org_id = ${ctx.orgId}::uuid AND x.method = 'unsupported' AND x.status = 'done' AND x.result ->> 'kind' = 'marketplace_orders' AND x.result -> 'summary' ->> 'state' = 'staged'
        AND x.version = (SELECT max(v.version) FROM crove_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
      ORDER BY f.created_at DESC
      LIMIT 20`.execute(ctx.trx);
    const entityIds = [...new Set(rows.flatMap((r) => (r.legal_entity_id ? [r.legal_entity_id] : [])))];
    const names = new Map<string, string>();
    if (entityIds.length > 0) {
      for (const e of await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', entityIds).execute()) names.set(e.id, e.name);
    }
    return rows.flatMap((r) => {
      const summary = zMarketplaceSummary.safeParse(r.summary);
      if (!summary.success) return [];
      const entityName = r.legal_entity_id ? names.get(r.legal_entity_id) : undefined;
      return [{ fileId: r.file_id, filename: r.filename, createdAt: r.created_at.toISOString(), summary: summary.data, entity: r.legal_entity_id && entityName !== undefined ? { id: r.legal_entity_id, name: entityName } : null }];
    });
  },
});

// How a staged report stands against the org's orders and stock items now (read-only): what is new, what is known, what a stage moves forward, and how many lines that move stock name an item.
async function previewOf(ctx: QueryContext, staged: NonNullable<Awaited<ReturnType<typeof stagedRun>>>): Promise<MarketplacePreview> {
  const entity = await resolveLegalEntity(ctx, staged.legalEntityId);
  const platform = staged.summary.platform;
  const known = await knownLines(ctx, entity, platform, [...new Set(staged.lines.map((l) => l.orderNo))]);
  const matches = await matchSkus(ctx, entity, platform, staged.lines.flatMap((l) => (l.sku ? [l.sku] : [])));
  let newLines = 0;
  let knownLinesCount = 0;
  let advancedLines = 0;
  let matched = 0;
  let unmatched = 0;
  for (const line of staged.lines) {
    const was = known.get(keyOf({ platform, orderNo: line.orderNo, lineKey: line.lineKey }));
    if (!was) newLines += 1;
    else if (canAdvance(was.stage, line.stage)) advancedLines += 1;
    else knownLinesCount += 1;
    if (MOVES_STOCK.has(line.stage)) {
      if (line.sku && matches.has(normalizeAlias(line.sku))) matched += 1;
      else unmatched += 1;
    }
  }
  return { newLines, knownLines: knownLinesCount, advancedLines, matchedLines: matched, unmatchedLines: unmatched };
}

export const marketplacePreview = defineQuery({
  name: 'finance.marketplace.preview',
  input: z.strictObject({ fileId: zId }),
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplacePreview> => {
    const staged = await stagedRun(ctx, input.fileId, false);
    if (!staged) throw notStaged();
    return previewOf(ctx, staged);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The confirmed orders
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// How far an order has got is its lines' furthest stage: a cancelled order is cancelled only when every line is, a returned line makes it returned.
const ORDER_RANK: Record<Stage, number> = { unknown: 0, cancelled: 1, placed: 2, shipped: 3, completed: 4, returned: 5 };

export const marketplaceOrders = defineQuery({
  name: 'finance.marketplace.orders',
  input: zMarketplaceOrdersInput,
  // Every role reads: an order holds no buyer data, only the platform's order number, SKUs, quantities and amounts.
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input): Promise<MarketplaceOrder[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.channel_order as o')
      .select(['o.id', 'o.legal_entity_id', 'o.platform', 'o.order_no', 'o.ordered_at', 'o.created_at'])
      .where('o.org_id', '=', ctx.orgId)
      .orderBy('o.ordered_at', sql`desc nulls last`)
      .orderBy('o.created_at', 'desc')
      .orderBy('o.id')
      .limit(input.limit ?? 100);
    if (input.legalEntityId) query = query.where('o.legal_entity_id', '=', input.legalEntityId);
    if (input.platform) query = query.where('o.platform', '=', input.platform);
    // An order with a line at the stage asked for.
    const stage = input.stage;
    if (stage) query = query.where((eb) => eb.exists(eb.selectFrom('crove_finance.channel_order_line as s').select('s.id').whereRef('s.org_id', '=', 'o.org_id').whereRef('s.order_id', '=', 'o.id').where('s.stage', '=', stage)));
    const orders = await query.execute();
    if (orders.length === 0) return [];
    const lines = await ctx.trx
      .selectFrom('crove_finance.channel_order_line as l')
      .select(['l.id', 'l.order_id', 'l.line_key', 'l.sku', 'l.item_name', 'l.quantity', 'l.unit_price', 'l.amount', 'l.stage', 'l.shipped_at'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.order_id', 'in', orders.map((o) => o.id))
      .orderBy('l.line_key')
      .execute();
    // The item each shipped line moved, by its code.
    const shipped = lines.length === 0 ? [] : await ctx.trx
      .selectFrom('crove_finance.stock_move as m')
      .innerJoin('crove_finance.stock_item as i', (join) => join.onRef('i.org_id', '=', 'm.org_id').onRef('i.id', '=', 'm.item_id'))
      .select(['m.order_line_id', 'i.code'])
      .where('m.org_id', '=', ctx.orgId)
      .where('m.order_move', '=', 'ship')
      .where('m.order_line_id', 'in', lines.map((l) => l.id))
      .execute();
    const codes = new Map(shipped.flatMap((m) => (m.order_line_id ? [[m.order_line_id, m.code] as const] : [])));
    return orders.map((o) => {
      const own = lines.filter((l) => l.order_id === o.id);
      const furthest = own.reduce<Stage>((best, l) => (ORDER_RANK[l.stage] > ORDER_RANK[best] ? l.stage : best), 'unknown');
      return {
        id: o.id,
        legalEntityId: o.legal_entity_id,
        platform: o.platform,
        orderNo: o.order_no,
        orderedAt: o.ordered_at === null ? null : String(o.ordered_at).slice(0, 10),
        stage: furthest,
        lines: own.map((l) => ({
          id: l.id,
          lineKey: l.line_key,
          sku: l.sku,
          itemName: l.item_name,
          quantity: plainQuantity(String(l.quantity)),
          unitPrice: l.unit_price === null ? null : plainQuantity(String(l.unit_price)),
          amount: l.amount === null ? null : plainQuantity(String(l.amount)),
          stage: l.stage,
          shippedAt: l.shipped_at === null ? null : String(l.shipped_at).slice(0, 10),
          itemCode: codes.get(l.id) ?? null,
        })),
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// One order of an entity and platform: stored once, never changed (a re-upload adds only what is new).
async function ensureOrder(ctx: CommandContext, legalEntityId: string, platform: Platform, orderNo: string, orderedAt: string | null): Promise<string> {
  const inserted = await ctx.trx
    .insertInto('crove_finance.channel_order')
    .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, platform, order_no: orderNo, ordered_at: orderedAt })
    .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'platform', 'order_no']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const row = await ctx.trx
    .selectFrom('crove_finance.channel_order')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('platform', '=', platform)
    .where('order_no', '=', orderNo)
    .executeTakeFirstOrThrow();
  return row.id;
}

// The stock a line moves, once: a shipment at the shipping day (or the order's, or today), a return after its shipment, both through the item the line names (the shipment's item for a
// return). A line cancelled after it shipped (a failed delivery) brings its stock back like a return; one cancelled before shipping moved nothing. A line that names no item moves nothing
// and waits for a person.
async function moveLineStock(
  ctx: CommandContext,
  line: { id: string; stage: Stage; quantity: string; shippedAt: string | null; orderedAt: string | null; sku: string | null },
  matches: ReadonlyMap<string, ItemMatch>,
  today: string,
  // An item a person chose for the line (the assignment): used instead of looking the SKU up.
  explicit?: ItemMatch,
): Promise<number> {
  if (!MOVES_STOCK.has(line.stage) && line.stage !== 'cancelled') return 0;
  const made = await ctx.trx.selectFrom('crove_finance.stock_move').select(['order_move', 'item_id', 'quantity']).where('org_id', '=', ctx.orgId).where('order_line_id', '=', line.id).execute();
  const ship = made.find((m) => m.order_move === 'ship');
  const returned = made.find((m) => m.order_move === 'return');
  // Cancelled: only a line that had shipped has anything to bring back.
  if (line.stage === 'cancelled' && !ship) return 0;
  const day = line.shippedAt ?? line.orderedAt ?? today;
  let moves = 0;
  let shipped = ship ? { itemId: ship.item_id, quantity: String(ship.quantity) } : null;
  if (!shipped) {
    const match = explicit ?? (line.sku ? matches.get(normalizeAlias(line.sku)) : undefined);
    const quantity = movableQuantity(line.quantity);
    const signed = match && quantity !== null ? moveQuantity('sale', quantity, match.factor) : null;
    if (!match || signed === null) return 0;
    await writeStockMove(ctx, { itemId: match.itemId, date: day, quantity: signed, source: { type: 'order_line', orderLineId: line.id, move: 'ship' } });
    shipped = { itemId: match.itemId, quantity: signed };
    moves += 1;
  }
  if ((line.stage === 'returned' || line.stage === 'cancelled') && !returned) {
    const back = shipped.quantity.startsWith('-') ? shipped.quantity.slice(1) : `-${shipped.quantity}`;
    await writeStockMove(ctx, { itemId: shipped.itemId, date: today, quantity: back, source: { type: 'order_line', orderLineId: line.id, move: 'return' } });
    moves += 1;
  }
  return moves;
}

export const marketplaceConfirm = defineCommand({
  name: 'finance.marketplace.confirm',
  input: z.strictObject({ fileId: zId }),
  // Records orders the platform reported and moves stock for the lines that name an item; it posts nothing (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplaceConfirmResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập được báo cáo đơn hàng');
    await lockReport(ctx, input.fileId);
    const staged = await stagedRun(ctx, input.fileId, true);
    if (!staged) throw notStaged();
    const legalEntityId = await resolveLegalEntity(ctx, staged.legalEntityId);
    const platform = staged.platform;
    const today = await databaseToday(ctx.trx);
    const known = await knownLines(ctx, legalEntityId, platform, [...new Set(staged.lines.map((l) => l.orderNo))]);
    const orderIds = new Map<string, string>();
    const touched: Array<{ id: string; stage: Stage; quantity: string; shippedAt: string | null; orderedAt: string | null; sku: string | null }> = [];
    let newLines = 0;
    let updatedLines = 0;
    let duplicateLines = 0;
    let stockMoves = 0;
    // The lock is per report, so another member confirming an overlapping report at the same moment can reach the same new line or the same stock move first: that meets a unique index.
    try {
      for (const line of staged.lines) {
        const key = keyOf({ platform, orderNo: line.orderNo, lineKey: line.lineKey });
        const was = known.get(key);
        if (was) {
          if (canAdvance(was.stage, line.stage)) {
            // The shipping day is set once; a later report can give it, never change it.
            await ctx.trx
              .updateTable('crove_finance.channel_order_line')
              .set({ stage: line.stage, ...(was.shippedAt === null && line.shippedAt !== null ? { shipped_at: line.shippedAt } : {}), updated_at: ctx.now })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', was.id)
              .execute();
            updatedLines += 1;
            touched.push({ id: was.id, stage: line.stage, quantity: was.quantity, shippedAt: was.shippedAt ?? line.shippedAt, orderedAt: was.orderedAt ?? line.orderedAt, sku: was.sku });
          } else {
            duplicateLines += 1;
            // A line known and unchanged may still have stock to move (the item was assigned since).
            touched.push({ id: was.id, stage: was.stage, quantity: was.quantity, shippedAt: was.shippedAt, orderedAt: was.orderedAt ?? line.orderedAt, sku: was.sku });
          }
          continue;
        }
        let orderId = orderIds.get(line.orderNo);
        if (!orderId) {
          orderId = await ensureOrder(ctx, legalEntityId, platform, line.orderNo, line.orderedAt);
          orderIds.set(line.orderNo, orderId);
        }
        const row = await ctx.trx
          .insertInto('crove_finance.channel_order_line')
          .values({
            org_id: ctx.orgId,
            order_id: orderId,
            line_key: line.lineKey,
            sku: line.sku,
            item_name: line.itemName,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            amount: line.amount,
            stage: line.stage,
            shipped_at: line.shippedAt,
            source_sha256: staged.sha256,
            source_row: line.rowNo,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        newLines += 1;
        touched.push({ id: row.id, stage: line.stage, quantity: line.quantity, shippedAt: line.shippedAt, orderedAt: line.orderedAt, sku: line.sku });
      }
      // Stock: the lines that move it and name an item, each once.
      const matches = await matchSkus(ctx, legalEntityId, platform, touched.flatMap((l) => (l.sku ? [l.sku] : [])));
      for (const line of touched) stockMoves += await moveLineStock(ctx, line, matches, today);
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('MARKETPLACE_BUSY', 409, 'Có báo cáo khác đang được nhập cùng lúc; hãy thử lại sau ít phút');
      throw error;
    }
    await ctx.run('kernel.extraction.statement_state', { fileId: input.fileId, state: 'imported', newLines, duplicateLines: duplicateLines + updatedLines });
    ctx.audit({ fileId: input.fileId, platform, newLines, updatedLines, duplicateLines, stockMoves });
    return { newLines, updatedLines, duplicateLines, stockMoves };
  },
});

export const marketplaceReject = defineCommand({
  name: 'finance.marketplace.reject',
  input: z.strictObject({ fileId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<{ fileId: string }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới bỏ qua được báo cáo đơn hàng');
    await lockReport(ctx, input.fileId);
    if (!(await stagedRun(ctx, input.fileId, true))) throw notStaged();
    // Nothing was stored as an order, and the lines stay in the finished run's result, which nothing may change and no tenant may delete (they hold no buyer data).
    await ctx.run('kernel.extraction.statement_state', { fileId: input.fileId, state: 'rejected' });
    ctx.audit({ fileId: input.fileId });
    return { fileId: input.fileId };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface ReportFileSource {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  generation: string | null;
  sha256: string;
  hasExtraction: boolean;
  // With a version: that re-read is still pending.
  due: boolean;
}

export interface MarketplaceFileDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

export const NOT_A_REPORT = 'Không nhận ra báo cáo đơn hàng của Shopee, TikTok Shop hoặc Lazada';
const TOO_MANY_LINES = `Báo cáo có hơn ${EXTRACT_LIMITS.maxOrderLines.toLocaleString('vi-VN')} dòng; hãy chia thành nhiều tệp theo tháng`;
const TOO_BIG = 'Báo cáo có quá nhiều dữ liệu để chờ nhập (tối đa 4 MB nội dung các dòng); hãy chia thành nhiều tệp theo tháng';

// Tries to read a received file as a marketplace order report, before it is read as a bank statement, an invoice or an archive: an .xlsx arrives as a ZIP, a CSV with its own type.
// handled is true when the file's read is recorded here (staged, or a failed read with the reason), false when it is no order report and the caller goes on as before. A report
// that could not be read in full (a row with an amount, a quantity, a date or an id that does not read) is recorded as failed with the rows, and nothing is staged: a layout the
// profile does not know shows what it could not read, and stores nothing.
export async function readMarketplaceFile(deps: MarketplaceFileDeps, orgId: string, fileId: string, attempt = 0, version?: number): Promise<{ handled: boolean }> {
  const actor = MARKETPLACE_ACTOR;
  const file = await deps.runtime.query<ReportFileSource | null>('finance.extraction.file', { fileId, ...(version === undefined ? {} : { version }) }, { actor: { type: 'system', component: 'finance.extract' }, orgId });
  if (!file || ![ZIP, XLSX, CSV].includes(file.content_type)) return { handled: false };
  // Already read, or a re-read that is no longer pending: not this reader's to take; the next reader finds the same and ends the job.
  if (version === undefined ? file.hasExtraction : !file.due) return { handled: false };
  const record = (status: 'done' | 'failed', fields: { error: string | null; result?: unknown; summary?: string }) =>
    deps.runtime.execute(
      'kernel.extraction.record',
      {
        fileId,
        ...(version === undefined ? {} : { version }),
        method: 'unsupported',
        status,
        result: fields.result ?? null,
        checks: [],
        error: fields.error,
        proposal: null,
        statement: true,
        ...(fields.summary ? { summary: fields.summary } : {}),
      },
      { actor, orgId },
    );
  const bytes = await readVerified(deps.store, { key: file.storage_key, generation: file.generation, sha256: file.sha256 });
  if (bytes.byteLength > EXTRACT_LIMITS.maxOrderReportBytes) return { handled: false };
  const read = await deps.extract.extract('marketplace_orders', bytes);
  if (!read.ok) {
    const limitHit = read.code === 'timeout' || read.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${read.code}`);
    return { handled: false };
  }
  const orders = read.orders;
  if (!orders.recognized || orders.platform === null || orders.profile === null) return { handled: false };
  if (orders.tooMany) {
    await record('failed', { error: TOO_MANY_LINES });
    return { handled: true };
  }
  // A row the profile could not read stops the file (a totals row without an order number does not): what could not be read is named by its row, and nothing is stored.
  const blocking = orders.skipped.filter((s) => s.reason !== 'no_order_no');
  if (blocking.length > 0 || orders.lines.length === 0) {
    const rows = [...new Set(blocking.map((s) => s.rowNo))].slice(0, 20);
    await record('failed', {
      error: (blocking.length > 0
        ? `Báo cáo ${orders.platform} có ${blocking.length} dòng không đọc được (dòng ${rows.join(', ')} của tệp): số lượng, số tiền, ngày hoặc mã đơn không đúng định dạng; hãy kiểm tra lại tệp hoặc báo cho người hỗ trợ nếu sàn đã đổi mẫu báo cáo`
        : NOT_A_REPORT
      ).slice(0, 2000),
    });
    return { handled: true };
  }
  const summary = summaryOf({ platform: orders.platform, profile: orders.profile, lines: orders.lines, skipped: orders.skipped, unknownStatuses: orders.unknownStatuses }, file.filename.slice(0, 255));
  const result = { kind: 'marketplace_orders', summary, lines: orders.lines };
  // The lines are kept with the file's read until a member decides: a bounded amount, refused with the reason past it.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > STAGED_STATEMENT_MAX_BYTES) {
    await record('failed', { error: TOO_BIG });
    return { handled: true };
  }
  await record('done', { error: null, result, summary: `Báo cáo đơn hàng ${orders.platform} chờ nhập: ${summary.orders} đơn, ${summary.lines} dòng` });
  return { handled: true };
}

// Fails the pending re-read `version` of an order report with the reason, for a job that kept failing.
export function recordMarketplaceReadFailure(runtime: Runtime, orgId: string, fileId: string, version: number, error: string) {
  return runtime.execute(
    'kernel.extraction.record',
    { fileId, version, method: 'unsupported', status: 'failed', result: null, checks: [], error: error.slice(0, 2000), proposal: null, statement: true },
    { actor: MARKETPLACE_ACTOR, orgId },
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The lines that name no item
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const marketplaceUnassigned = defineQuery({
  name: 'finance.marketplace.unassigned',
  input: zMarketplaceUnassignedInput,
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input): Promise<MarketplaceUnassignedLine[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.channel_order_line as l')
      .innerJoin('crove_finance.channel_order as o', (join) => join.onRef('o.org_id', '=', 'l.org_id').onRef('o.id', '=', 'l.order_id'))
      .select(['l.id', 'l.legal_entity_id', 'l.sku', 'l.item_name', 'l.quantity', 'l.stage', 'o.platform', 'o.order_no', 'o.ordered_at'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.stage', 'in', ['shipped', 'completed', 'returned'])
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.stock_move AS m WHERE m.org_id = l.org_id AND m.order_line_id = l.id AND m.order_move = 'ship')`)
      .orderBy('o.ordered_at', sql`desc nulls last`)
      .orderBy('o.id')
      .orderBy('l.line_key')
      .limit(input.limit ?? 200);
    if (input.legalEntityId) query = query.where('l.legal_entity_id', '=', input.legalEntityId);
    return (await query.execute()).map((r) => ({
      lineId: r.id,
      legalEntityId: r.legal_entity_id,
      platform: r.platform,
      orderNo: r.order_no,
      orderedAt: r.ordered_at === null ? null : String(r.ordered_at).slice(0, 10),
      sku: r.sku,
      itemName: r.item_name,
      quantity: plainQuantity(String(r.quantity)),
      stage: r.stage,
    }));
  },
});

export const marketplaceAssign = defineCommand({
  name: 'finance.marketplace.assign',
  input: zMarketplaceAssign,
  // Records the stock an order line moved, through the item a person chose, and teaches the SKU: no posting (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  target: (input) => ({ type: 'finance.stock_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ moves: number }> => {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace.line:${ctx.orgId}:${input.lineId}`}, 0))`.execute(ctx.trx);
    const line = await ctx.trx
      .selectFrom('crove_finance.channel_order_line as l')
      .innerJoin('crove_finance.channel_order as o', (join) => join.onRef('o.org_id', '=', 'l.org_id').onRef('o.id', '=', 'l.order_id'))
      .select(['l.id', 'l.legal_entity_id', 'l.sku', 'l.quantity', 'l.stage', 'l.shipped_at', 'o.platform', 'o.ordered_at'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.id', '=', input.lineId)
      .executeTakeFirst();
    if (!line) throw new DomainError('MARKETPLACE_LINE_NOT_FOUND', 404, 'Không tìm thấy dòng đơn hàng này');
    const item = await loadItem(ctx, input.itemId);
    if (!item.active) throw new DomainError('STOCK_ITEM_INACTIVE', 409, 'Mặt hàng này đã ngừng dùng, hãy bật lại trước khi gán');
    if (item.legal_entity_id !== line.legal_entity_id) throw new DomainError('STOCK_ITEM_ENTITY_MISMATCH', 422, 'Mặt hàng và đơn hàng thuộc hai pháp nhân khác nhau');
    if (!MOVES_STOCK.has(line.stage)) throw new DomainError('MARKETPLACE_LINE_NOT_SHIPPED', 409, 'Dòng này chưa giao nên chưa có gì để ghi kho');
    const shipped = await ctx.trx.selectFrom('crove_finance.stock_move').select('id').where('org_id', '=', ctx.orgId).where('order_line_id', '=', line.id).where('order_move', '=', 'ship').executeTakeFirst();
    if (shipped) throw new DomainError('MARKETPLACE_LINE_ASSIGNED', 409, 'Dòng này đã được gán cho một mặt hàng');
    const today = await databaseToday(ctx.trx);
    const moves = await moveLineStock(
      ctx,
      { id: line.id, stage: line.stage, quantity: String(line.quantity), shippedAt: line.shipped_at === null ? null : String(line.shipped_at).slice(0, 10), orderedAt: line.ordered_at === null ? null : String(line.ordered_at).slice(0, 10), sku: line.sku },
      new Map(),
      today,
      { itemId: item.id, factor: input.factor },
    );
    if (moves === 0) throw new DomainError('MARKETPLACE_LINE_NO_QUANTITY', 422, 'Số lượng của dòng này không ghi kho được');
    let taught = false;
    if (input.teach && line.sku && normalizeAlias(line.sku) !== '') {
      await ctx.run('finance.stock_alias.teach', { itemId: item.id, source: line.platform, key: line.sku, factor: input.factor });
      taught = true;
    }
    ctx.audit({ lineId: line.id, itemId: item.id, platform: line.platform, moves, taught });
    return { moves };
  },
});

export const marketplaceCommands = [marketplaceConfirm, marketplaceReject, marketplaceAssign];
export const marketplaceQueries = [marketplaceStaged, marketplacePreview, marketplaceOrders, marketplaceUnassigned];
