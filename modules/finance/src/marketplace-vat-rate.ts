// SPDX-License-Identifier: AGPL-3.0-only
// The VAT method and rate of an entity's marketplace sales (#4303 S3a, parent #2520, plan docs/plan/stock-and-marketplaces.md section 8.4), as dated rows of ludy_finance.marketplace_vat_rate.
// - finance.marketplace_vat_rate.set (owners and admins; R1, audited): new rows from their dates, all or none. The table is append-only: a row is never edited, and a wrong one is corrected by entering a
//   later row, for the same date or any other, so long as the date is not inside a locked period (the books of a closed period keep the rate they were posted with). A row exists only because a person
//   entered it, so the row IS the person's confirmation (the settings field offers a suggested schedule and nothing applies until the person picks the method and confirms). Nothing is posted, no money moves.
// - finance.marketplace_vat_rate.list (every role): every entry of one entity, by effective date and, within a date, in the order entered (the last of a date is the one in force).
// `marketplaceVatRateAt` is the ONE function the sales posting reads (S3b): the row in force on a date (the greatest effective_from on or before it, ties broken by the latest entry), or null when no row
// covers it, in which case the month is held back, never guessed. No rate is a constant here.
// Uncertain (#2520, L): one rate for all the goods of the entity; a seller with goods at several rates, or goods outside the 8% cut, waits for an item-level rate (#4303 option A). The audit rows hold ids,
// dates, the method and the rate, nothing else.
import { sql } from 'kysely';
import { vietnamToday, zMarketplaceVatRateSet, zMarketplaceVatRatesGet, type MarketplaceVatRateRow, type MarketplaceVatRates } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

async function ratesOf(ctx: Ctx, entity: string): Promise<MarketplaceVatRates> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.marketplace_vat_rate')
    .select(['effective_from', 'method', 'vat_percent'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('effective_from', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return { legalEntityId: entity, rows: rows.map((r): MarketplaceVatRateRow => ({ effectiveFrom: r.effective_from, method: r.method, vatPercent: r.vat_percent })) };
}

// Every entry of an entity, ordered as `marketplaceVatRateAt` orders candidates: greatest effective_from first and, within a date, latest entry first (matches marketplace_vat_rate_entity_idx).
export async function marketplaceVatRateEntries(ctx: Ctx, entity: string): Promise<MarketplaceVatRateRow[]> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.marketplace_vat_rate')
    .select(['effective_from', 'method', 'vat_percent'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((r): MarketplaceVatRateRow => ({ effectiveFrom: r.effective_from, method: r.method, vatPercent: r.vat_percent }));
}

// The row in force on `date` from `entries` ordered by (effective_from desc, created_at desc, id desc): the greatest effective_from on or before `date` and, among entries of that date, the latest entered.
export function pickMarketplaceVatRate(entries: readonly MarketplaceVatRateRow[], date: string): MarketplaceVatRateRow | null {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid];
    if (entry && entry.effectiveFrom > date) lo = mid + 1;
    else hi = mid;
  }
  return entries[lo] ?? null;
}

// The row in force on `date`: the greatest effective_from on or before it and, among the entries of that date, the latest entered; null when none covers it. The sales posting holds the month back on null.
export async function marketplaceVatRateAt(ctx: Ctx, entity: string, date: string): Promise<MarketplaceVatRateRow | null> {
  const row = await ctx.trx
    .selectFrom('ludy_finance.marketplace_vat_rate')
    .select(['effective_from', 'method', 'vat_percent'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { effectiveFrom: row.effective_from, method: row.method, vatPercent: row.vat_percent } : null;
}

export const marketplaceVatRateSet = defineCommand({
  name: 'finance.marketplace_vat_rate.set',
  input: zMarketplaceVatRateSet,
  // It decides how a marketplace sale's price is split into revenue and output VAT from a date on; no entry is posted here and no money moves.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<MarketplaceVatRates> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    // A row starts no later than the end of next year (Vietnam time): a sanity bound on a mistyped year (a wrong row is corrected by a later entry, but a far date would hold every later day).
    const latestDate = `${Number(vietnamToday(ctx.now).slice(0, 4)) + 1}-12-31`;
    for (const row of input.rows) {
      if (row.effectiveFrom < '2000-01-01' || row.effectiveFrom > latestDate) {
        throw new DomainError('MARKETPLACE_VAT_RATE_DATE', 422, `Ngày hiệu lực phải từ năm 2000 đến hết ngày ${latestDate}`);
      }
    }
    // Two writers of one entity wait for each other, so the entries of one entity are inserted one after the other and their entry times order them.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace_vat_rate:${ctx.orgId}:${entity}`}, 0))`.execute(ctx.trx);
    const first = input.rows[0] as MarketplaceVatRateRow;
    // Not inside a locked period: the books of a closed period keep the rate they were posted with. The entity's lock row is held FOR SHARE to the end of this transaction (#3188), so a lock of a month
    // racing this write waits for it instead of slipping in between the read and the insert.
    const lockedThrough = (await sql<{ locked_through: string | null }>`SELECT ludy_finance.period_lock_share(${entity}::uuid) AS locked_through`.execute(ctx.trx)).rows[0]?.locked_through ?? null;
    if (lockedThrough && first.effectiveFrom <= lockedThrough) {
      throw new DomainError('MARKETPLACE_VAT_RATE_LOCKED', 409, `Kỳ đến hết ngày ${lockedThrough} đã khóa sổ; dòng thuế suất mới phải có hiệu lực sau ngày đó`);
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    for (const row of input.rows) {
      await ctx.trx
        .insertInto('ludy_finance.marketplace_vat_rate')
        .values({ org_id: ctx.orgId, legal_entity_id: entity, effective_from: row.effectiveFrom, method: row.method, vat_percent: row.vatPercent, created_by: userId })
        .execute();
    }
    ctx.audit({ legalEntityId: entity, rows: input.rows.map((row) => ({ effectiveFrom: row.effectiveFrom, method: row.method, vatPercent: row.vatPercent })) });
    return ratesOf(ctx, entity);
  },
});

export const marketplaceVatRateList = defineQuery({
  name: 'finance.marketplace_vat_rate.list',
  input: zMarketplaceVatRatesGet,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceVatRates> => ratesOf(ctx, await resolveLegalEntity(ctx, input.legalEntityId)),
});

export const marketplaceVatRateCommands = [marketplaceVatRateSet];
export const marketplaceVatRateQueries = [marketplaceVatRateList];
