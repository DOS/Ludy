// SPDX-License-Identifier: AGPL-3.0-only
// The VAT method and rate of an entity's marketplace sales (#4303 S3a, parent #2520, plan docs/plan/stock-and-marketplaces.md section 8.4), as dated rows of crove_finance.marketplace_vat_rate.
// - finance.marketplace_vat_rate.set (owners and admins; R1, audited): new rows from their dates, all or none. A row is never edited: a change is a later row, and it may not start inside a locked period,
//   so the books of a closed period keep the rate they were posted with. A row exists only because a person entered it, so the row IS the person's confirmation (the settings field offers a suggested
//   schedule and nothing applies until it is confirmed once). Nothing is posted, no money moves.
// - finance.marketplace_vat_rate.list (every role): the rows of one entity, oldest first.
// `marketplaceVatRateAt` is what the sales posting reads (S3b): the row in force on a date, or null when no row covers it, in which case the month is held back, never guessed. No rate is a constant here.
// Uncertain (#2520, L): one rate for all the goods of the entity; a seller with goods at several rates, or goods outside the 8% cut, waits for an item-level rate (#4303 option A). The audit rows hold ids,
// dates, the method and the rate, nothing else.
import { sql } from 'kysely';
import { vietnamToday, zMarketplaceVatRateSet, zMarketplaceVatRatesGet, type MarketplaceVatRateRow, type MarketplaceVatRates } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

async function ratesOf(ctx: Ctx, entity: string): Promise<MarketplaceVatRates> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.marketplace_vat_rate')
    .select(['effective_from', 'method', 'vat_percent'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('effective_from', 'asc')
    .execute();
  return { legalEntityId: entity, rows: rows.map((r): MarketplaceVatRateRow => ({ effectiveFrom: r.effective_from, method: r.method, vatPercent: r.vat_percent })) };
}

// The row in force on `date` (the latest that starts on or before it), or null when none covers it. The sales posting holds the month back on null.
export async function marketplaceVatRateAt(ctx: Ctx, entity: string, date: string): Promise<MarketplaceVatRateRow | null> {
  const row = await ctx.trx
    .selectFrom('crove_finance.marketplace_vat_rate')
    .select(['effective_from', 'method', 'vat_percent'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
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
    // A row starts no later than the end of next year (Vietnam time): a mistyped far date could never be corrected, since every new row must come after the latest.
    const latestDate = `${Number(vietnamToday(ctx.now).slice(0, 4)) + 1}-12-31`;
    for (const row of input.rows) {
      if (row.effectiveFrom < '2000-01-01' || row.effectiveFrom > latestDate) {
        throw new DomainError('MARKETPLACE_VAT_RATE_DATE', 422, `Ngày hiệu lực phải từ năm 2000 đến hết ngày ${latestDate}`);
      }
    }
    // Two writers of one entity wait for each other, so the order check below sees what the first left.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.marketplace_vat_rate:${ctx.orgId}:${entity}`}, 0))`.execute(ctx.trx);
    const latest = await ctx.trx
      .selectFrom('crove_finance.marketplace_vat_rate')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .orderBy('effective_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    // A row is never edited and none is slipped in before one that exists: a change is a later row.
    const first = input.rows[0] as MarketplaceVatRateRow;
    if (latest && first.effectiveFrom <= latest.effective_from) {
      throw new DomainError('MARKETPLACE_VAT_RATE_ORDER', 409, `Dòng thuế suất mới phải có hiệu lực sau ngày ${latest.effective_from} của dòng gần nhất; một thay đổi là một dòng mới từ ngày đó`);
    }
    // Not inside a locked period: the books of a closed period keep the rate they were posted with. The entity's lock row is held FOR SHARE to the end of this transaction (#3188), so a lock of a month
    // racing this write waits for it instead of slipping in between the read and the insert.
    const lockedThrough = (await sql<{ locked_through: string | null }>`SELECT crove_finance.period_lock_share(${entity}::uuid) AS locked_through`.execute(ctx.trx)).rows[0]?.locked_through ?? null;
    if (lockedThrough && first.effectiveFrom <= lockedThrough) {
      throw new DomainError('MARKETPLACE_VAT_RATE_LOCKED', 409, `Kỳ đến hết ngày ${lockedThrough} đã khóa sổ; dòng thuế suất mới phải có hiệu lực sau ngày đó`);
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    for (const row of input.rows) {
      await ctx.trx
        .insertInto('crove_finance.marketplace_vat_rate')
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
