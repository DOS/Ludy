// SPDX-License-Identifier: AGPL-3.0-only
// Items of stock, the names a source uses for them, and the moves of stock (#2512, ADR-0045 point 1, plan stock-and-marketplaces.md sections 8.1 and 8.2):
// - finance.stock_item.save (owners, admins, members; R1): makes an item or edits one (name, unit, account, trade; the code and the entity stay). An item with moves keeps
//   its unit and its account (the database says so too).
// - finance.stock_item.set_active (same roles; R1): deactivates an item or brings it back. An item is never deleted.
// - finance.stock_alias.teach / forget (same roles; R1): the names a source uses for an item and the factor to its unit.
// - finance.stock_move.reverse (same roles; R1): the correction of a move, which is a reversing move of the opposite quantity; moves are append-only and written only here
//   and by the lines of a posted document (stock-lines.ts: the posting, finance.stock.assign and the void of a document), always through writeStockMove.
// - finance.stock_item.list / finance.stock_move.list: every member reads. On hand is the sum of an item's moves, computed here, never a column.
// Quantities are decimal strings (numeric(20,6) in the database) and sums go through decimal.js; audit facts carry ids and counts, never a name.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zStockAliasTeach, zStockItemInput, type StockItem, type StockMove } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { chartAccounts } from './accounts.ts';
import { normalizeAlias, oppositeQuantity, plainQuantity, sameUnit } from './domain/stock.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;
const pgMessage = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? '');

// The one write of a move: every move of stock goes through here (the posting of a document's lines uses it too), so the checks are made once. The database holds the
// same rules (append-only, one move per line, a reversal is the opposite of one move and happens once, the entity is the item's).
export interface StockMoveWrite {
  itemId: string;
  date: string;
  // Signed decimal string, not zero.
  quantity: string;
  source:
    | { type: 'document_line'; documentId: string; lineNo: number }
    | { type: 'manual' }
    | { type: 'reversal'; reversesMoveId: string }
    // A shipment (out) or a return (in) of a marketplace order line (#2515), each once per line.
    | { type: 'order_line'; orderLineId: string; move: 'ship' | 'return' };
}

export async function writeStockMove(ctx: CommandContext, move: StockMoveWrite): Promise<string> {
  const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  // The try of a line: one more than the moves it already made (the database accepts it only when the one before was reversed, and keeps two writers from taking the same).
  const attempt =
    move.source.type === 'document_line'
      ? Number(
          (
            await ctx.trx
              .selectFrom('crove_finance.stock_move')
              .select(sql<string>`coalesce(max(line_attempt), 0) + 1`.as('n'))
              .where('org_id', '=', ctx.orgId)
              .where('document_id', '=', move.source.documentId)
              .where('line_no', '=', move.source.lineNo)
              .where('source_type', '=', 'document_line')
              .executeTakeFirstOrThrow()
          ).n,
        )
      : null;
  const row = await ctx.trx
    .insertInto('crove_finance.stock_move')
    .values({
      org_id: ctx.orgId,
      item_id: move.itemId,
      move_date: move.date,
      quantity: move.quantity,
      source_type: move.source.type,
      document_id: move.source.type === 'document_line' ? move.source.documentId : null,
      line_no: move.source.type === 'document_line' ? move.source.lineNo : null,
      line_attempt: attempt,
      order_line_id: move.source.type === 'order_line' ? move.source.orderLineId : null,
      order_move: move.source.type === 'order_line' ? move.source.move : null,
      reverses_move_id: move.source.type === 'reversal' ? move.source.reversesMoveId : null,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

export async function loadItem(ctx: Ctx, itemId: string) {
  const item = await ctx.trx
    .selectFrom('crove_finance.stock_item')
    .select(['id', 'legal_entity_id', 'code', 'name', 'unit', 'stock_account', 'trade', 'active'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
  return item;
}

// The account an item is booked to is a goods account of the entity's chart (156 or a sub-account of it) that is in use.
async function assertStockAccount(ctx: QueryContext, code: string): Promise<void> {
  const account = (await chartAccounts(ctx, [code])).get(code);
  if (!account) throw new DomainError('STOCK_ACCOUNT_UNKNOWN', 422, 'Tài khoản kho này không có trong hệ thống tài khoản');
  if (!account.active) throw new DomainError('STOCK_ACCOUNT_INACTIVE', 422, 'Tài khoản kho này đã ngừng sử dụng');
  if (account.rootCode !== '156') throw new DomainError('STOCK_ACCOUNT_KIND', 422, 'Hàng hóa ghi vào tài khoản 156 hoặc tài khoản con của nó');
}

export const stockItemSave = defineCommand({
  name: 'finance.stock_item.save',
  input: zStockItemInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => (input.itemId ? { type: 'finance.stock_item', id: input.itemId } : null),
  handler: async (ctx, input): Promise<{ id: string }> => {
    await assertStockAccount(ctx, input.stockAccount);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    if (input.itemId === null) {
      const entity = await resolveLegalEntity(ctx, input.legalEntityId);
      try {
        const row = await ctx.trx
          .insertInto('crove_finance.stock_item')
          .values({ org_id: ctx.orgId, legal_entity_id: entity, code: input.code, name: input.name, unit: input.unit, stock_account: input.stockAccount, trade: input.trade, created_by: userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        ctx.audit({ itemId: row.id, legalEntityId: entity, created: true });
        return { id: row.id };
      } catch (error) {
        if (pgCode(error) === '23505') throw new DomainError('STOCK_ITEM_CODE_EXISTS', 409, 'Mã hàng này đã có trong pháp nhân này');
        throw error;
      }
    }
    // The item row is locked before it is read: the unit comparison and the taught-names check below then read committed state, and a name taught meanwhile (its foreign key takes
    // a share of this row) waits for this commit instead of slipping between the check and the update.
    await ctx.trx.selectFrom('crove_finance.stock_item').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).forUpdate().executeTakeFirst();
    const item = await loadItem(ctx, input.itemId);
    if (input.code !== item.code) throw new DomainError('STOCK_ITEM_CODE_FIXED', 422, 'Mã hàng không đổi được sau khi đã tạo');
    if (input.legalEntityId !== null && input.legalEntityId !== item.legal_entity_id) throw new DomainError('STOCK_ITEM_ENTITY_FIXED', 422, 'Mặt hàng thuộc về một pháp nhân và không đổi sang pháp nhân khác được');
    // A taught name carries a factor against the item's unit, so the unit stays while names are taught: the factor would otherwise be applied to a unit it was not made for.
    if (!sameUnit(input.unit, item.unit)) {
      const taught = await ctx.trx.selectFrom('crove_finance.stock_alias').select('id').where('org_id', '=', ctx.orgId).where('item_id', '=', item.id).limit(1).executeTakeFirst();
      if (taught) throw new DomainError('STOCK_ITEM_IN_USE', 409, 'Mặt hàng đã có tên gán với hệ số quy đổi theo đơn vị hiện tại; hãy bỏ gán các tên trước khi đổi đơn vị tính');
    }
    try {
      await ctx.trx
        .updateTable('crove_finance.stock_item')
        .set({ name: input.name, unit: input.unit, stock_account: input.stockAccount, trade: input.trade, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', item.id)
        .execute();
    } catch (error) {
      if (pgMessage(error).includes('STOCK_ITEM_IN_USE')) throw new DomainError('STOCK_ITEM_IN_USE', 409, 'Mặt hàng đã có phát sinh nên không đổi đơn vị tính hoặc tài khoản kho được');
      throw error;
    }
    ctx.audit({ itemId: item.id, legalEntityId: item.legal_entity_id, created: false });
    return { id: item.id };
  },
});

export const stockItemSetActive = defineCommand({
  name: 'finance.stock_item.set_active',
  input: z.strictObject({ itemId: zId, active: z.boolean() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.stock_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ active: boolean }> => {
    const item = await loadItem(ctx, input.itemId);
    await ctx.trx.updateTable('crove_finance.stock_item').set({ active: input.active, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', item.id).execute();
    ctx.audit({ itemId: item.id, active: input.active });
    return { active: input.active };
  },
});

export const stockAliasTeach = defineCommand({
  name: 'finance.stock_alias.teach',
  input: zStockAliasTeach,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.stock_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    const item = await loadItem(ctx, input.itemId);
    if (!item.active) throw new DomainError('STOCK_ITEM_INACTIVE', 409, 'Mặt hàng này đã ngừng dùng, hãy bật lại trước khi gán tên cho nó');
    const key = normalizeAlias(input.key);
    if (key === '') throw new DomainError('STOCK_ALIAS_EMPTY', 422, 'Tên dùng để nhận ra mặt hàng không được để trống');
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const inserted = await ctx.trx
      .insertInto('crove_finance.stock_alias')
      .values({ org_id: ctx.orgId, item_id: item.id, source: input.source, alias_key: key, factor: input.factor, source_unit: input.unit ?? null, created_by: userId })
      // The same name taught twice is the same alias; a name another item holds is refused below.
      .onConflict((conflict) => conflict.columns(['org_id', 'legal_entity_id', 'source', 'alias_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      ctx.audit({ itemId: item.id, aliasId: inserted.id });
      return { id: inserted.id, existing: false };
    }
    const held = await ctx.trx
      .selectFrom('crove_finance.stock_alias')
      .select(['id', 'item_id', 'factor', 'source_unit'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', item.legal_entity_id)
      .where('source', '=', input.source)
      .where('alias_key', '=', key)
      .executeTakeFirstOrThrow();
    if (held.item_id !== item.id) throw new DomainError('STOCK_ALIAS_TAKEN', 409, 'Tên này đã được gán cho một mặt hàng khác; hãy bỏ gán ở đó trước');
    // A name taught in a unit is the same alias only in that unit: teaching it again in a unit when it holds none (or another) is refused, never left unscoped, so its factor is
    // never applied to a unit it was not made for. Taught again with no unit, it is the alias it was.
    const otherUnit = input.unit !== undefined && !sameUnit(held.source_unit, input.unit);
    if (plainQuantity(held.factor) !== plainQuantity(input.factor) || otherUnit) throw new DomainError('STOCK_ALIAS_FACTOR', 409, 'Tên này đã được gán cho mặt hàng này với một hệ số hoặc đơn vị quy đổi khác; hãy bỏ gán rồi gán lại');
    return { id: held.id, existing: true };
  },
});

export const stockAliasForget = defineCommand({
  name: 'finance.stock_alias.forget',
  input: z.strictObject({ aliasId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<{ removed: boolean }> => {
    const gone = await ctx.trx.deleteFrom('crove_finance.stock_alias').where('org_id', '=', ctx.orgId).where('id', '=', input.aliasId).executeTakeFirst();
    const removed = Number(gone.numDeletedRows) > 0;
    ctx.audit({ aliasId: input.aliasId, removed });
    return { removed };
  },
});

export const stockMoveReverse = defineCommand({
  name: 'finance.stock_move.reverse',
  input: z.strictObject({ moveId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.stock_move', id: input.moveId }),
  handler: async (ctx, input): Promise<{ id: string }> => {
    const move = await ctx.trx
      .selectFrom('crove_finance.stock_move')
      .select(['id', 'item_id', 'quantity', 'source_type'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.moveId)
      .executeTakeFirst();
    if (!move) throw new DomainError('STOCK_MOVE_NOT_FOUND', 404, 'Không tìm thấy phát sinh kho này');
    if (move.source_type === 'reversal') throw new DomainError('STOCK_MOVE_IS_REVERSAL', 409, 'Đây đã là một phát sinh đảo, không đảo thêm được');
    // The stock an order line moved follows the line's own stage (a return brings it back); reversing it alone would leave the line shipped with nothing to move again.
    if (move.source_type === 'order_line') throw new DomainError('STOCK_MOVE_ORDER_LINE', 409, 'Phát sinh này đến từ đơn hàng sàn nên không đảo riêng được; kho tự hoàn lại khi đơn được báo hoàn trả hoặc hủy sau khi giao');
    const done = await ctx.trx.selectFrom('crove_finance.stock_move').select('id').where('org_id', '=', ctx.orgId).where('reverses_move_id', '=', move.id).executeTakeFirst();
    if (done) throw new DomainError('STOCK_MOVE_REVERSED', 409, 'Phát sinh kho này đã được đảo');
    // Two reversals at once: the second meets the unique index (a move is reversed once), and the move rows cannot be locked here (the tenant role only reads and inserts).
    try {
      const id = await writeStockMove(ctx, { itemId: move.item_id, date: await databaseToday(ctx.trx), quantity: oppositeQuantity(move.quantity), source: { type: 'reversal', reversesMoveId: move.id } });
      ctx.audit({ moveId: move.id, reversalId: id });
      return { id };
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('STOCK_MOVE_REVERSED', 409, 'Phát sinh kho này đã được đảo');
      throw error;
    }
  },
});

export const stockItemList = defineQuery({
  name: 'finance.stock_item.list',
  input: z.strictObject({ legalEntityId: zId.optional(), includeInactive: z.boolean().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<StockItem[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.stock_item as i')
      .select(['i.id', 'i.legal_entity_id', 'i.code', 'i.name', 'i.unit', 'i.kind', 'i.stock_account', 'i.trade', 'i.active'])
      .select((eb) => [
        eb
          .selectFrom('crove_finance.stock_move as m')
          .select(sql<string>`coalesce(sum(m.quantity), 0)::text`.as('s'))
          .whereRef('m.org_id', '=', 'i.org_id')
          .whereRef('m.item_id', '=', 'i.id')
          .as('on_hand'),
        eb
          .selectFrom('crove_finance.stock_move as m')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('m.org_id', '=', 'i.org_id')
          .whereRef('m.item_id', '=', 'i.id')
          .as('moves'),
      ])
      .where('i.org_id', '=', ctx.orgId);
    if (input.legalEntityId) query = query.where('i.legal_entity_id', '=', input.legalEntityId);
    if (!input.includeInactive) query = query.where('i.active', '=', true);
    const rows = await query.orderBy('i.code').execute();
    return rows.map((r) => ({
      id: r.id,
      legalEntityId: r.legal_entity_id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      kind: r.kind,
      stockAccount: r.stock_account,
      trade: r.trade,
      active: r.active,
      onHand: plainQuantity(r.on_hand ?? '0'),
      moves: Number(r.moves ?? 0),
    }));
  },
});

export const stockMoveList = defineQuery({
  name: 'finance.stock_move.list',
  input: z.strictObject({ itemId: zId, limit: z.number().int().min(1).max(500).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<StockMove[]> => {
    await loadItem(ctx, input.itemId);
    const rows = await ctx.trx
      .selectFrom('crove_finance.stock_move as m')
      .select(['m.id', 'm.item_id', 'm.legal_entity_id', 'm.move_date', 'm.quantity', 'm.source_type', 'm.document_id', 'm.line_no', 'm.reverses_move_id'])
      .select((eb) => eb.exists(eb.selectFrom('crove_finance.stock_move as r').select('r.id').whereRef('r.org_id', '=', 'm.org_id').whereRef('r.reverses_move_id', '=', 'm.id')).as('reversed'))
      .where('m.org_id', '=', ctx.orgId)
      .where('m.item_id', '=', input.itemId)
      .orderBy('m.move_date', 'desc')
      .orderBy('m.id', 'desc')
      .limit(input.limit ?? 200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      legalEntityId: r.legal_entity_id,
      date: typeof r.move_date === 'string' ? r.move_date : new Date(r.move_date).toISOString().slice(0, 10),
      quantity: plainQuantity(r.quantity),
      source: r.source_type,
      documentId: r.document_id,
      lineNo: r.line_no,
      reversesMoveId: r.reverses_move_id,
      reversed: Boolean(r.reversed),
    }));
  },
});

export const stockCommands = [stockItemSave, stockItemSetActive, stockAliasTeach, stockAliasForget, stockMoveReverse];
export const stockQueries = [stockItemList, stockMoveList];
