// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind (#2517, ADR-0045, plan docs/plan/stock-and-marketplaces.md section 8.5): the profile of a legal entity of kind household, the books it requires, and the law as
// dated data. A household keeps TT133 books underneath and a household user is never asked to pick an account or a book: the profile decides which books of Circular 152 apply.
// - finance.household.profile_set (owners and admins; R1, audited): a new row from a date, for an entity of kind household. A profile is never edited: a change is a later row, and it may
//   not start inside a locked period, so the books of a closed period keep the profile they were made under.
// - finance.household.profile_get (every role): the profile in force on a date and the books it requires.
// - finance.household.rules (every role): the thresholds, the percentages by trade, the expense groups and the forms in force on a date, each with its source and status.
// No rate, threshold or group is a constant here: they are rows with an effective date (migration 20261231030035), a source and a status. A row is `commentary` until the accountant has checked
// it against the primary text (#2520); the answers say so (`commentary`), and nothing that files or computes a tax may rely on one yet. The audit rows hold ids, the group, the method, the dates
// and the trades, never the representative's name.
import { sql } from 'kysely';
import {
  vietnamToday,
  zHouseholdProfileGet,
  zHouseholdProfileSet,
  zHouseholdRulesGet,
  type HouseholdBookRule,
  type HouseholdProfile,
  type HouseholdProfileView,
  type HouseholdRules,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { pickInForce } from './domain/household-rules.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { periodLockedThrough } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

const notHousehold = () => new DomainError('HOUSEHOLD_NOT_HOUSEHOLD', 422, 'Chỉ pháp nhân là hộ kinh doanh mới có hồ sơ hộ kinh doanh');

// The row in force on `date` for one entity (the latest that starts on or before it).
async function profileAt(ctx: Ctx, entity: string, date: string): Promise<HouseholdProfile | null> {
  const row = await ctx.trx
    .selectFrom('crove_finance.household_profile')
    .select(['effective_from', 'tax_group', 'pit_method', 'trades', 'einvoice_registered', 'representative_name'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    effectiveFrom: row.effective_from,
    taxGroup: row.tax_group,
    pitMethod: row.pit_method,
    trades: [...row.trades],
    einvoiceRegistered: row.einvoice_registered,
    representativeName: row.representative_name,
  };
}

// The books a PIT method keeps, each at the layout in force on `date`: the version in force is picked per book over every row, then the method is checked, so a later version that retires
// a book from a method (an empty list, or another method) is not hidden behind an earlier one.
async function booksFor(ctx: Ctx, method: 'none' | 'percentage' | 'income', date: string): Promise<HouseholdBookRule[]> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.household_form_version')
    .select(['book', 'version', 'effective_from', 'name', 'pit_methods', 'status'])
    .where('effective_from', '<=', date)
    .execute();
  return pickInForce(rows, (r) => r.book, date)
    .filter((r) => r.pit_methods.includes(method))
    .map((r) => ({ book: r.book, version: r.version, name: r.name, status: r.status }))
    .sort((a, b) => a.book.localeCompare(b.book));
}

export async function householdProfileView(ctx: Ctx, entity: string, date: string): Promise<HouseholdProfileView> {
  // An entity that is no longer a household (its kind was changed) keeps its old rows but shows no profile and no book.
  const kind = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  const profile = kind?.kind === 'household' ? await profileAt(ctx, entity, date) : null;
  if (!profile) return { date, profile: null, books: [], commentary: false };
  const books = await booksFor(ctx, profile.pitMethod ?? 'none', date);
  return { date, profile, books, commentary: books.some((b) => b.status !== 'confirmed') };
}

export const householdProfileGet = defineQuery({
  name: 'finance.household.profile_get',
  input: zHouseholdProfileGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdProfileView> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    return householdProfileView(ctx, entity, input.date ?? vietnamToday());
  },
});

export const householdProfileSet = defineCommand({
  name: 'finance.household.profile_set',
  input: zHouseholdProfileSet,
  // It decides which books a household keeps from its date on; no entry is posted, nothing is filed and no money moves.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<HouseholdProfileView> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const kind = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
    if (kind?.kind !== 'household') throw notHousehold();
    // Group 1 pays no PIT, group 2 pays a percentage of revenue or, by choice, on income, group 3 on income.
    const okMethod =
      input.taxGroup === 1 ? input.pitMethod === null : input.taxGroup === 2 ? input.pitMethod === 'percentage' || input.pitMethod === 'income' : input.pitMethod === 'income';
    if (!okMethod) {
      throw new DomainError('HOUSEHOLD_PROFILE_METHOD', 422, 'Nhóm thuế và phương pháp tính thuế thu nhập cá nhân không khớp nhau (nhóm 1 không có phương pháp, nhóm 2 chọn theo tỷ lệ trên doanh thu hoặc theo thu nhập, nhóm 3 theo thu nhập)');
    }
    // A profile starts no later than the end of next year (Vietnam time): a mistyped far date could never be corrected, since every new row must come after the latest.
    const latestDate = `${Number(vietnamToday(ctx.now).slice(0, 4)) + 1}-12-31`;
    if (input.effectiveFrom < '2000-01-01' || input.effectiveFrom > latestDate) throw new DomainError('HOUSEHOLD_PROFILE_DATE', 422, `Ngày hiệu lực phải từ năm 2000 đến hết ngày ${latestDate}`);
    // Two writers of one entity wait for each other, so the order check below sees what the first left.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.household_profile:${ctx.orgId}:${entity}`}, 0))`.execute(ctx.trx);
    const latest = await ctx.trx
      .selectFrom('crove_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .orderBy('effective_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    // A profile is never edited and none is slipped in before one that exists: a change is a later row.
    if (latest && input.effectiveFrom <= latest.effective_from) {
      throw new DomainError('HOUSEHOLD_PROFILE_ORDER', 409, `Hồ sơ mới phải có hiệu lực sau ngày ${latest.effective_from} của hồ sơ gần nhất; một thay đổi là một dòng mới từ ngày đó`);
    }
    // Not inside a locked period: the books of a closed period keep the profile they were made under.
    const lockedThrough = await periodLockedThrough(ctx as QueryContext, entity);
    if (lockedThrough && input.effectiveFrom <= lockedThrough) {
      throw new DomainError('HOUSEHOLD_PROFILE_LOCKED', 409, `Kỳ đến hết ngày ${lockedThrough} đã khóa sổ; hồ sơ mới phải có hiệu lực sau ngày đó`);
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    await ctx.trx
      .insertInto('crove_finance.household_profile')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: entity,
        effective_from: input.effectiveFrom,
        tax_group: input.taxGroup,
        pit_method: input.pitMethod,
        trades: input.trades,
        einvoice_registered: input.einvoiceRegistered,
        representative_name: input.representativeName,
        created_by: userId,
      })
      .execute();
    ctx.audit({ legalEntityId: entity, effectiveFrom: input.effectiveFrom, taxGroup: input.taxGroup, pitMethod: input.pitMethod, trades: input.trades, einvoiceRegistered: input.einvoiceRegistered });
    // The answer is stored with the request's idempotency key for a week, so it holds no name: the screen reads the profile again.
    const view = await householdProfileView(ctx, entity, input.effectiveFrom);
    return { ...view, profile: view.profile ? { ...view.profile, representativeName: null } : null };
  },
});

// The law in force on a date. Money and percentages are the decimal strings the database keeps.
export const householdRulesGet = defineQuery({
  name: 'finance.household.rules',
  input: zHouseholdRulesGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdRules> => {
    const date = input.date ?? vietnamToday();
    const thresholds = pickInForce(
      await ctx.trx.selectFrom('crove_finance.household_threshold').select(['code', 'effective_from', 'amount', 'source', 'status']).where('effective_from', '<=', date).execute(),
      (r) => r.code,
      date,
    ).map((r) => ({ code: r.code, amount: r.amount, effectiveFrom: r.effective_from, source: r.source, status: r.status }));
    const tradeRates = pickInForce(
      await ctx.trx.selectFrom('crove_finance.household_trade_rate').select(['trade', 'effective_from', 'vat_percent', 'pit_percent', 'source', 'status']).where('effective_from', '<=', date).execute(),
      (r) => r.trade,
      date,
    ).map((r) => ({ trade: r.trade, vatPercent: r.vat_percent, pitPercent: r.pit_percent, effectiveFrom: r.effective_from, source: r.source, status: r.status }));
    const expenseGroups = pickInForce(
      await ctx.trx.selectFrom('crove_finance.household_expense_group_map').select(['expense_group', 'account_prefix', 'effective_from', 'source', 'status']).where('effective_from', '<=', date).execute(),
      (r) => r.account_prefix,
      date,
    ).map((r) => ({ expenseGroup: r.expense_group, accountPrefix: r.account_prefix, effectiveFrom: r.effective_from, source: r.source, status: r.status }));
    const forms = pickInForce(
      await ctx.trx.selectFrom('crove_finance.household_form_version').select(['book', 'version', 'effective_from', 'name', 'pit_methods', 'source', 'status']).where('effective_from', '<=', date).execute(),
      (r) => r.book,
      date,
    ).map((r) => ({ book: r.book, version: r.version, name: r.name, pitMethods: [...r.pit_methods] as Array<'none' | 'percentage' | 'income'>, effectiveFrom: r.effective_from, source: r.source, status: r.status }));
    const commentary = [...thresholds, ...tradeRates, ...expenseGroups, ...forms].some((r) => r.status !== 'confirmed');
    return { date, thresholds, tradeRates, expenseGroups, forms, commentary };
  },
});

export const householdCommands = [householdProfileSet];
export const householdQueries = [householdProfileGet, householdRulesGet];
