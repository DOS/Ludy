// SPDX-License-Identifier: AGPL-3.0-only
// Stock from the lines of a posted document (#2512, ADR-0045 point 4, plan stock-and-marketplaces.md section 8.2). The posting of a purchase or a sale (record.ts) calls
// postDocumentStock once its lines are written: a goods line (156 on a purchase, 5111 on a sale) with a quantity that matches an item makes a move; the others move nothing
// and wait in the "Chưa gán hàng" list (finance.stock.unassigned) for a person to assign them (finance.stock.assign, which also teaches the name). The entry the posting
// writes is the same with or without stock: this module reads the lines and writes moves, nothing else.
// A line matches an item of the document's entity by a fixed chain: the item's code (the line's text is the code, in the item's unit), else an alias a person taught (the
// normalized text, with its factor to the item's unit). Nothing is guessed. A voided document reverses the moves it made (reverseDocumentStock).
import { sql } from 'kysely';
import { ORDER_SOURCE_KIND, zStockAssign, zStockUnassignedInput, type StockUnassignedLine } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { chartAccounts } from './accounts.ts';
import { money } from '@crove/l10n-vn';
import { STOCK_GOODS_ACCOUNT, STOCK_SALE_DEFAULT_ACCOUNT, moveQuantity, movableQuantity, normalizeAlias, oppositeQuantity, sameUnit } from './domain/stock.ts';
import { latestRevision } from './source-entry.ts';
import { loadItem, writeStockMove } from './stock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

type Direction = 'purchase' | 'sale';

// A line made from a CRM sales order (ORDER_SOURCE_KIND, ADR-0050) moves its stock with the delivery (finance.stock.move_from_order_line), never with the document.

// A line of a document being posted, as the posting holds it: the account is the line's own (the debit account of a purchase line, the revenue account of a sale line).
export interface PostedLine {
  lineNo: number;
  description: string;
  unit: string | null;
  quantity: string | null;
  // The line's amount: a line that is not above zero (a discount, a credit) is not goods moving.
  amount: string;
  account: string;
  // The order line the invoice line was made from (ADR-0050 A4): the delivery of that line owns its stock move, so the document line moves nothing and is not "unassigned".
  source?: { kind: string; id: string; lineNo: number } | null;
}

// The accounts among `codes` that are goods on this side: the goods account itself or a sub-account of it in the entity's chart.
async function goodsAccounts(ctx: CommandContext, direction: Direction, codes: readonly string[]): Promise<Set<string>> {
  const chart = await chartAccounts(ctx, [...new Set(codes)]);
  return new Set([...chart.values()].filter((account) => account.rootCode === STOCK_GOODS_ACCOUNT[direction]).map((account) => account.code));
}

interface Matches {
  // By the lower-cased code; null where two active items of the entity share it, so neither is taken.
  byCode: Map<string, { id: string; unit: string } | null>;
  byAlias: Map<string, { itemId: string; factor: string; unit: string | null }>;
}

async function matchesFor(ctx: CommandContext, legalEntityId: string, keys: readonly string[]): Promise<Matches> {
  const byCode: Matches['byCode'] = new Map();
  const items = await ctx.trx
    .selectFrom('crove_finance.stock_item')
    .select(['id', 'code', 'unit'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('active', '=', true)
    .where(sql<string>`pg_catalog.lower(code)`, 'in', [...keys])
    // Held while the posting writes its moves, so the unit it matched on is the unit when the move lands.
    .forShare()
    .execute();
  for (const item of items) {
    const key = item.code.toLowerCase();
    byCode.set(key, byCode.has(key) ? null : { id: item.id, unit: item.unit });
  }
  const byAlias: Matches['byAlias'] = new Map();
  const aliases = await ctx.trx
    .selectFrom('crove_finance.stock_alias as a')
    .innerJoin('crove_finance.stock_item as i', (join) => join.onRef('i.org_id', '=', 'a.org_id').onRef('i.id', '=', 'a.item_id'))
    .select(['a.alias_key', 'a.item_id', 'a.factor', 'a.source_unit'])
    .where('a.org_id', '=', ctx.orgId)
    .where('a.legal_entity_id', '=', legalEntityId)
    .where('a.source', '=', 'text')
    .where('a.alias_key', 'in', [...keys])
    .where('i.active', '=', true)
    .forShare('i')
    .execute();
  for (const alias of aliases) byAlias.set(alias.alias_key, { itemId: alias.item_id, factor: alias.factor, unit: alias.source_unit });
  return { byCode, byAlias };
}

// The stock a posted document makes: one move per goods line that matched an item. Returns how many moves it made and how many goods lines it left for a person to assign.
export async function postDocumentStock(
  ctx: CommandContext,
  document: { documentId: string; legalEntityId: string; direction: Direction; date: string; adjustment: boolean },
  lines: readonly PostedLine[],
): Promise<{ moved: number; unassigned: number }> {
  // An adjustment invoice carries a difference, not goods.
  if (document.adjustment) return { moved: 0, unassigned: 0 };
  const withQuantity = lines.flatMap((line) => {
    if (line.source?.kind === ORDER_SOURCE_KIND) return [];
    const quantity = movableQuantity(line.quantity);
    return quantity === null || !money(line.amount).greaterThan(0) ? [] : [{ line, quantity }];
  });
  if (withQuantity.length === 0) return { moved: 0, unassigned: 0 };
  const goods = await goodsAccounts(ctx, document.direction, withQuantity.map(({ line }) => line.account));
  // A sale line still on the default 511 moves stock when its text names an item, so the defaults work with no setup; it is never counted as unassigned.
  const onDefaultSale = (line: PostedLine) => document.direction === 'sale' && line.account === STOCK_SALE_DEFAULT_ACCOUNT;
  const candidates = withQuantity.filter(({ line }) => goods.has(line.account) || onDefaultSale(line));
  if (candidates.length === 0) return { moved: 0, unassigned: 0 };
  const keys = [...new Set(candidates.map(({ line }) => normalizeAlias(line.description)).filter((key) => key !== ''))];
  const { byCode, byAlias } = keys.length > 0 ? await matchesFor(ctx, document.legalEntityId, keys) : { byCode: new Map(), byAlias: new Map() };
  let moved = 0;
  let unassigned = 0;
  for (const { line, quantity } of candidates) {
    const key = normalizeAlias(line.description);
    const code = byCode.get(key);
    const alias = byAlias.get(key);
    // The code only when the line is in the item's unit (or says none); a name taught with a factor carries its own conversion.
    // A name taught in a unit matches a line in that unit only, so its factor is never applied to another.
    const aliasFits = alias !== undefined && (alias.unit === null || sameUnit(line.unit, alias.unit));
    const target = code && sameUnit(line.unit?.trim() ? line.unit : code.unit, code.unit) ? { itemId: code.id, factor: '1' } : alias && aliasFits ? { itemId: alias.itemId, factor: alias.factor } : null;
    const signed = target ? moveQuantity(document.direction, quantity, target.factor) : null;
    if (!target || signed === null) {
      if (goods.has(line.account)) unassigned += 1;
      continue;
    }
    await writeStockMove(ctx, { itemId: target.itemId, date: document.date, quantity: signed, source: { type: 'document_line', documentId: document.documentId, lineNo: line.lineNo } });
    moved += 1;
  }
  return { moved, unassigned };
}

// The item an order line moves, by the same fixed chain as a document line (the item's code in the item's unit, else a taught name with its factor); nothing is guessed. Null
// when no active item of the entity matches, for a person to teach the name.
export async function matchLineItem(
  ctx: CommandContext,
  legalEntityId: string,
  line: { description: string; unit: string | null },
): Promise<{ itemId: string; factor: string } | null> {
  const key = normalizeAlias(line.description);
  if (key === '') return null;
  const { byCode, byAlias } = await matchesFor(ctx, legalEntityId, [key]);
  const code = byCode.get(key);
  const alias = byAlias.get(key);
  const aliasFits = alias !== undefined && (alias.unit === null || sameUnit(line.unit, alias.unit));
  if (code && sameUnit(line.unit?.trim() ? line.unit : code.unit, code.unit)) return { itemId: code.id, factor: '1' };
  if (alias && aliasFits) return { itemId: alias.itemId, factor: alias.factor };
  return null;
}

// A voided document takes back the stock it made: every move of its lines that is not reversed yet gets its reversing move on the date of the void.
export async function reverseDocumentStock(ctx: CommandContext, documentId: string, date: string): Promise<number> {
  // One at a time per document with an assignment of one of its lines (finance.stock.assign takes the same lock before it looks at the void): the one that comes second sees the
  // other's rows, so a voided document never keeps a move that nothing reverses.
  await lockDocumentStock(ctx, documentId);
  const moves = await ctx.trx
    .selectFrom('crove_finance.stock_move as m')
    .select(['m.id', 'm.item_id', 'm.quantity'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.document_id', '=', documentId)
    .where('m.source_type', '=', 'document_line')
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.stock_move AS r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id)`)
    .orderBy('m.line_no')
    .execute();
  for (const move of moves) {
    await writeStockMove(ctx, { itemId: move.item_id, date, quantity: oppositeQuantity(move.quantity), source: { type: 'reversal', reversesMoveId: move.id } });
  }
  return moves.length;
}

async function lockDocumentStock(ctx: CommandContext, documentId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.stock.document:${ctx.orgId}:${documentId}`}, 0))`.execute(ctx.trx);
}

const isoDate = (value: string | Date): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));

export const stockUnassigned = defineQuery({
  name: 'finance.stock.unassigned',
  input: zStockUnassignedInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockUnassignedLine[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.purchase_line as l')
      .innerJoin('crove_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'l.org_id').onRef('d.id', '=', 'l.document_id'))
      .select(['l.document_id', 'l.line_no', 'l.description', 'l.unit', 'l.quantity', 'd.legal_entity_id', 'd.direction', 'd.invoice_date', 'd.invoice_series', 'd.invoice_number'])
      .where('l.org_id', '=', ctx.orgId)
      .where(sql<boolean>`l.quantity > 0 AND l.amount > 0 AND d.correction_kind IS DISTINCT FROM 'adjustment' AND l.source_kind IS DISTINCT FROM ${ORDER_SOURCE_KIND}`)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void AS v WHERE v.org_id = l.org_id AND v.document_id = l.document_id)`)
      // A line has a live move when its latest try was not reversed; one whose move was reversed (assigned to the wrong item) is unassigned again.
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.stock_move AS m WHERE m.org_id = l.org_id AND m.document_id = l.document_id AND m.line_no = l.line_no AND m.source_type = 'document_line'
          AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move AS r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id))`,
      )
      .where(
        sql<boolean>`CASE WHEN d.direction = 'sale'
          THEN (l.credit_account = ${STOCK_GOODS_ACCOUNT.sale} OR l.credit_account IN (SELECT o.code FROM crove_finance.org_account AS o WHERE o.org_id = l.org_id AND o.root_code = ${STOCK_GOODS_ACCOUNT.sale}))
          ELSE (l.debit_account = ${STOCK_GOODS_ACCOUNT.purchase} OR l.debit_account IN (SELECT o.code FROM crove_finance.org_account AS o WHERE o.org_id = l.org_id AND o.root_code = ${STOCK_GOODS_ACCOUNT.purchase}))
        END`,
      );
    if (input.legalEntityId) query = query.where('d.legal_entity_id', '=', input.legalEntityId);
    const rows = await query.orderBy('d.invoice_date', 'desc').orderBy('d.id').orderBy('l.line_no').limit(input.limit ?? 200).execute();
    return rows.map((r) => ({
      documentId: r.document_id,
      lineNo: r.line_no,
      legalEntityId: r.legal_entity_id,
      direction: r.direction,
      invoiceDate: isoDate(r.invoice_date),
      invoiceSeries: r.invoice_series,
      invoiceNumber: r.invoice_number,
      description: r.description,
      unit: r.unit,
      quantity: movableQuantity(r.quantity) ?? '0',
    }));
  },
});

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

export const stockAssign = defineCommand({
  name: 'finance.stock.assign',
  input: zStockAssign,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.stock_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ moveId: string; aliasId: string | null }> => {
    // The document first: a void of it runs the same lock before it reads the moves, so what is checked below is what stands when this commits.
    await lockDocumentStock(ctx, input.documentId);
    const item = await loadItem(ctx, input.itemId);
    if (!item.active) throw new DomainError('STOCK_ITEM_INACTIVE', 409, 'Mặt hàng này đã ngừng dùng, hãy bật lại trước khi gán tên cho nó');
    const line = await ctx.trx
      .selectFrom('crove_finance.purchase_line as l')
      .innerJoin('crove_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'l.org_id').onRef('d.id', '=', 'l.document_id'))
      .select(['l.description', 'l.unit', 'l.quantity', 'l.amount', 'l.debit_account', 'l.credit_account', 'd.direction', 'd.legal_entity_id', 'd.invoice_date', 'd.correction_kind', 'l.source_kind'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.document_id', '=', input.documentId)
      .where('l.line_no', '=', input.lineNo)
      .executeTakeFirst();
    if (!line) throw new DomainError('STOCK_LINE_NOT_FOUND', 404, 'Không tìm thấy dòng hóa đơn này');
    if (line.source_kind === ORDER_SOURCE_KIND) throw new DomainError('STOCK_LINE_ORDER_SOURCE', 409, 'Dòng này lập từ đơn bán hàng, kho ghi theo lần giao hàng của đơn');
    if (line.legal_entity_id !== item.legal_entity_id) throw new DomainError('STOCK_ITEM_ENTITY_MISMATCH', 422, 'Mặt hàng và hóa đơn thuộc hai pháp nhân khác nhau');
    const voided = await ctx.trx.selectFrom('crove_finance.purchase_document_void').select('document_id').where('org_id', '=', ctx.orgId).where('document_id', '=', input.documentId).executeTakeFirst();
    if (voided) throw new DomainError('STOCK_LINE_VOIDED', 409, 'Hóa đơn này đã bị hủy');
    // A line with a move not yet reversed is assigned; one whose move was reversed may be assigned again, and the history stays.
    const made = await ctx.trx
      .selectFrom('crove_finance.stock_move as m')
      .select('m.id')
      .where('m.org_id', '=', ctx.orgId)
      .where('m.document_id', '=', input.documentId)
      .where('m.line_no', '=', input.lineNo)
      .where('m.source_type', '=', 'document_line')
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_finance.stock_move AS r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id)`)
      .executeTakeFirst();
    if (made) throw new DomainError('STOCK_LINE_ASSIGNED', 409, 'Dòng này đã được gán cho một mặt hàng');
    const account = line.direction === 'sale' ? line.credit_account : line.debit_account;
    const goods = account === null ? new Set<string>() : await goodsAccounts(ctx, line.direction, [account]);
    const onDefaultSale = line.direction === 'sale' && account === STOCK_SALE_DEFAULT_ACCOUNT;
    if (account === null || !(goods.has(account) || onDefaultSale) || line.correction_kind === 'adjustment' || !money(line.amount).greaterThan(0)) {
      throw new DomainError('STOCK_LINE_NOT_GOODS', 422, 'Chỉ dòng hàng hóa mới gán được vào kho');
    }
    const quantity = movableQuantity(line.quantity);
    const signed = quantity === null ? null : moveQuantity(line.direction, quantity, input.factor);
    if (signed === null) throw new DomainError('STOCK_LINE_NO_QUANTITY', 422, 'Dòng này không có số lượng để nhập hoặc xuất kho');
    // A purchase goes in on the date of its entry (a later posting date the approver chose counts), a sale on its invoice date.
    const entry =
      line.direction === 'sale'
        ? null
        : await ctx.trx
            .selectFrom('crove_finance.journal_entry as e')
            .select('e.entry_date')
            .where('e.org_id', '=', ctx.orgId)
            .where('e.source_type', '=', 'finance.purchase_document')
            .where('e.source_id', '=', input.documentId)
            .where('e.reverses_entry_id', 'is', null)
            .where(latestRevision('e'))
            .executeTakeFirst();
    const date = isoDate(entry?.entry_date ?? line.invoice_date);
    let moveId: string;
    try {
      moveId = await writeStockMove(ctx, { itemId: item.id, date, quantity: signed, source: { type: 'document_line', documentId: input.documentId, lineNo: input.lineNo } });
    } catch (error) {
      // Two assignments of one line at once: the second meets the unique index of a line's move.
      if (pgCode(error) === '23505') throw new DomainError('STOCK_LINE_ASSIGNED', 409, 'Dòng này đã được gán cho một mặt hàng');
      throw error;
    }
    let aliasId: string | null = null;
    if (input.teach && normalizeAlias(line.description) !== '') {
      const unit = line.unit?.trim().slice(0, 40);
      aliasId = (await ctx.run<{ id: string }>('finance.stock_alias.teach', { itemId: item.id, source: 'text', key: line.description, factor: input.factor, ...(unit ? { unit } : {}) })).id;
    }
    ctx.audit({ itemId: item.id, documentId: input.documentId, lineNo: input.lineNo, moveId, taught: aliasId !== null });
    return { moveId, aliasId };
  },
});

export const stockLineCommands = [stockAssign];
export const stockLineQueries = [stockUnassigned];
