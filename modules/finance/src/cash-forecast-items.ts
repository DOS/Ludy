// SPDX-License-Identifier: AGPL-3.0-only
// The items an owner enters into the 90-day cash forecast (#5326, plan docs/plan/cash-forecast.md "Not built"): the costs and receipts the books cannot show (rent, a loan, payroll, a one-off), one row per item
// of ONE legal entity. finance.cash_forecast_item_set creates (no id) or edits (id) an item and finance.cash_forecast_item_remove deletes it: both R1 (nothing is posted, paid or sent), for owners and admins,
// and for a user only (an agent, Vy or an MCP client writes none). The runtime audits every run; the audit holds the item's id, category, direction, recurrence, amount and dates (and the previous ones on an
// edit), NEVER the label: it is the owner's own words, often a person's name, and an audit row cannot be erased. finance.cash_forecast_items lists an entity's items for the card, for every role. An entity
// holds at most CASH_FORECAST_ITEMS_MAX items; the count and the write run under one advisory lock per entity, so two writers cannot both take the last place. The forecast read that merges the items into its
// figures is a later step of the same issue.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  CASH_FORECAST_ITEMS_MAX,
  zCashForecastItemRemove,
  zCashForecastItems,
  zCashForecastItemSet,
  zFinanceCashForecastInput,
  type CashForecastItemRemove,
  type CashForecastItems,
  type CashForecastItemSet,
  type CashForecastItemView,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { Decimal } from '@ludy/l10n-vn';
import { nextOccurrence } from './domain/cash-forecast-items.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const cashForecastItemLimit = () =>
  new DomainError('CASH_FORECAST_ITEM_LIMIT', 422, `Mỗi pháp nhân chỉ nhập được tối đa ${CASH_FORECAST_ITEMS_MAX} khoản dự kiến; hãy xóa bớt một khoản trước khi thêm khoản mới`);
const itemNotFound = () => new DomainError('NOT_FOUND', 404, 'Không tìm thấy khoản dự kiến trong pháp nhân này');
const usersOnly = () => new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập hoặc sửa khoản dự kiến được');

const COLUMNS = ['id', 'legal_entity_id', 'label', 'category', 'direction', 'amount', 'first_date', 'recurrence', 'end_date'] as const;

interface ItemRow {
  id: string;
  legal_entity_id: string;
  label: string;
  category: CashForecastItemView['category'];
  direction: CashForecastItemView['direction'];
  amount: string;
  first_date: string | Date;
  recurrence: CashForecastItemView['recurrence'];
  end_date: string | Date | null;
}

// A date column as YYYY-MM-DD, whatever the driver returns.
const day = (value: string | Date): string => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

function viewOf(row: ItemRow, today: string): CashForecastItemView {
  const firstDate = day(row.first_date);
  const endDate = row.end_date === null ? null : day(row.end_date);
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    label: row.label,
    category: row.category,
    direction: row.direction,
    amount: new Decimal(row.amount).toFixed(),
    firstDate,
    recurrence: row.recurrence,
    endDate,
    nextDate: nextOccurrence({ firstDate, recurrence: row.recurrence, endDate }, today),
  };
}

// What an audit row may say of an item: ids, the kind, the money and the dates, never the label.
const auditOf = (row: ItemRow, prefix = ''): Record<string, unknown> => ({
  [`${prefix}category`]: row.category,
  [`${prefix}direction`]: row.direction,
  [`${prefix}recurrence`]: row.recurrence,
  [`${prefix}amount`]: new Decimal(row.amount).toFixed(),
  [`${prefix}first_date`]: day(row.first_date),
  [`${prefix}end_date`]: row.end_date === null ? null : day(row.end_date),
});

async function itemsOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, entity: string): Promise<ItemRow[]> {
  return (await ctx.trx
    .selectFrom('ludy_finance.cash_forecast_item')
    .select([...COLUMNS])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('first_date')
    .orderBy('id')
    .limit(CASH_FORECAST_ITEMS_MAX)
    .execute()) as unknown as ItemRow[];
}

// One item of the org by id, as the caller sees it (le_scope hides another entity's), or null.
async function itemById(ctx: Pick<QueryContext, 'trx' | 'orgId'>, id: string): Promise<ItemRow | null> {
  const row = await ctx.trx
    .selectFrom('ludy_finance.cash_forecast_item')
    .select([...COLUMNS])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as unknown as ItemRow | undefined) ?? null;
}

// Two writers of one entity's items wait for each other, so the count below is of what the first left.
const lockEntity = (ctx: CommandContext, entity: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.cash_forecast_item:${ctx.orgId}:${entity}`}, 0))`.execute(ctx.trx);

const cashForecastItemsQuery = defineQuery({
  name: 'finance.cash_forecast_items',
  input: zFinanceCashForecastInput,
  access: ALL,
  handler: async (ctx, input): Promise<CashForecastItems> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const today = input.asOf ?? (await databaseToday(ctx.trx));
    const items = (await itemsOf(ctx, entity)).map((row) => viewOf(row, today));
    // The next occurrence first, those with none (finished, or later than day 90) last, then by id.
    const key = (i: CashForecastItemView) => `${i.nextDate ?? '9999-99-99'} ${i.id}`;
    items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return zCashForecastItems.parse({ legalEntityId: entity, asOf: today, items, limit: CASH_FORECAST_ITEMS_MAX });
  },
});

const cashForecastItemSet = defineCommand({
  name: 'finance.cash_forecast_item_set',
  input: zCashForecastItemSet,
  // Nothing is posted, paid or sent: the item only feeds the forecast the owner reads.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input: CashForecastItemSet): Promise<CashForecastItemView> => {
    if (ctx.actor.type !== 'user') throw usersOnly();
    const today = await databaseToday(ctx.trx);
    const values = {
      label: input.label,
      category: input.category,
      direction: input.direction,
      amount: input.amount,
      first_date: input.firstDate,
      recurrence: input.recurrence,
      end_date: input.endDate ?? null,
    };
    if (input.id) {
      // An edit keeps the item's entity; one the caller cannot see, or of another entity than the one named, is not found.
      const before = await itemById(ctx, input.id);
      if (!before || (input.legalEntityId !== undefined && input.legalEntityId !== before.legal_entity_id)) throw itemNotFound();
      await lockEntity(ctx, before.legal_entity_id);
      // Read again under the lock: a writer that held it first may have changed or removed the item since, and the audit's previous values are what this edit replaced.
      const current = await itemById(ctx, input.id);
      if (!current) throw itemNotFound();
      const row = (await ctx.trx
        .updateTable('ludy_finance.cash_forecast_item')
        .set({ ...values, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .returning([...COLUMNS])
        .executeTakeFirst()) as unknown as ItemRow | undefined;
      if (!row) throw itemNotFound();
      ctx.audit({ item_id: row.id, created: false, ...auditOf(row), ...auditOf(current, 'previous_') });
      return viewOf(row, today);
    }
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    await lockEntity(ctx, entity);
    const held = await ctx.trx
      .selectFrom('ludy_finance.cash_forecast_item')
      .select(sql<string>`count(*)`.as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .executeTakeFirst();
    if (Number(held?.n ?? 0) >= CASH_FORECAST_ITEMS_MAX) throw cashForecastItemLimit();
    const row = (await ctx.trx
      .insertInto('ludy_finance.cash_forecast_item')
      .values({ org_id: ctx.orgId, legal_entity_id: entity, ...values, created_by: ctx.actor.userId })
      .returning([...COLUMNS])
      .executeTakeFirstOrThrow()) as unknown as ItemRow;
    ctx.audit({ item_id: row.id, created: true, ...auditOf(row) });
    return viewOf(row, today);
  },
});

const cashForecastItemRemove = defineCommand({
  name: 'finance.cash_forecast_item_remove',
  input: zCashForecastItemRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input: CashForecastItemRemove): Promise<CashForecastItemRemove> => {
    if (ctx.actor.type !== 'user') throw usersOnly();
    const before = await itemById(ctx, input.id);
    if (!before) throw itemNotFound();
    await lockEntity(ctx, before.legal_entity_id);
    // Read again under the lock (see the edit): the audit holds what was removed, not what it was before the wait.
    const current = await itemById(ctx, input.id);
    if (!current) throw itemNotFound();
    const gone = await ctx.trx.deleteFrom('ludy_finance.cash_forecast_item').where('org_id', '=', ctx.orgId).where('id', '=', input.id).returning('id').executeTakeFirst();
    if (!gone) throw itemNotFound();
    ctx.audit({ item_id: input.id, ...auditOf(current) });
    return { id: input.id };
  },
});

export const cashForecastItemCommands = [cashForecastItemSet, cashForecastItemRemove];
export const cashForecastItemQueries = [cashForecastItemsQuery];
