// SPDX-License-Identifier: AGPL-3.0-only
// The org's stock settings (#2685, plan stock-and-marketplaces.md section 8.6): how many days a supplier takes to deliver ("thời gian giao hàng").
// - finance.stock_setting.get (every role): the org's lead time in days (14 until it sets another).
// - finance.stock_setting.set (owners and admins; R1, audited): sets the org's lead time in days (1 to 90).
// Stored on the org's single row in ludy_finance.collection_setting (no new tenant table). The audit row holds only the number (leadDays).
import { sql } from 'kysely';
import { z } from 'zod';
import { STOCK_LEAD_DAYS_DEFAULT, zStockSetting, type StockSetting } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

export async function readStockLeadDays(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<number> {
  const row = await ctx.trx
    .selectFrom('ludy_finance.collection_setting')
    .select('stock_lead_days')
    .where('org_id', '=', ctx.orgId)
    .executeTakeFirst();
  return row?.stock_lead_days ?? STOCK_LEAD_DAYS_DEFAULT;
}

export const stockSettingGet = defineQuery({
  name: 'finance.stock_setting.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<StockSetting> => ({ leadDays: await readStockLeadDays(ctx) }),
});

export const stockSettingSet = defineCommand({
  name: 'finance.stock_setting.set',
  input: zStockSetting,
  // It only changes which items show as running low and how many units the list suggests reordering: no money moves, nothing is ordered or sent.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<StockSetting> => {
    // Share the org-row advisory lock with collection_setting.set so concurrent upserts on the org's single row serialize cleanly.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.collection_setting:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    await ctx.trx
      .insertInto('ludy_finance.collection_setting')
      .values({ org_id: ctx.orgId, stock_lead_days: input.leadDays, set_by: userId })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ stock_lead_days: input.leadDays, set_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ leadDays: input.leadDays });
    return { leadDays: input.leadDays };
  },
});

export const stockSettingCommands = [stockSettingSet];
export const stockSettingQueries = [stockSettingGet];
