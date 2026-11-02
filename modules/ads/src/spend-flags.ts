// SPDX-License-Identifier: AGPL-3.0-only
// The spend-pace and cost-per-result flags of the Ads screen (issue #2378): owners and admins read them, because they show spend. The
// query loads the figures (the accounts the caller reads, the caps in force, the account's days of this month and the campaign days of the
// last 17) and hands them to the pure evaluation in flags.ts. It writes nothing and calls no model: a flag moves no money and changes no
// campaign, and the same figures always give the same flags.
import { z } from 'zod';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import type { AdsFlag } from '@crove/kernel-contract';
import { defineQuery } from '@crove/kernel-runtime';
import { addDays, todayIn } from './domain.ts';
import { CPR_HISTORY_DAYS, CPR_RECENT_DAYS, evaluateFlags, monthStartOf, type FlagCap } from './flags.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

export const adsFlags = defineQuery({
  name: 'ads.flags',
  // `now` is for the tests that fix the clock: the API never passes it.
  input: z.object({ now: z.iso.datetime().optional() }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<AdsFlag[]> => {
    const now = input.now ? new Date(input.now) : new Date();
    const accounts = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'name', 'currency', 'time_zone', 'result_kind', 'synced_through'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('name')
      .orderBy('id')
      .limit(200)
      .execute();
    const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
    const judgeable = accounts.filter((a) => a.currency !== null && a.time_zone !== null && a.synced_through !== null);
    if (judgeable.length === 0) return [];
    // The caps in force: the latest row of each (scope, account, period).
    const capRows = await ctx.trx.selectFrom('crove_ads.ad_spend_cap').select(['id', 'scope', 'ad_account_id', 'period', 'amount', 'currency']).where('org_id', '=', ctx.orgId).orderBy('id').execute();
    const latest = new Map<string, FlagCap>();
    for (const c of capRows) latest.set(`${c.scope}:${c.ad_account_id ?? ''}:${c.period}`, { scope: c.scope as FlagCap['scope'], adAccountId: c.ad_account_id, period: c.period as FlagCap['period'], amount: String(c.amount), currency: c.currency });
    const caps = [...latest.values()];
    const todays = judgeable.map((a) => todayIn(a.time_zone as string, now));
    const earliestToday = todays.reduce((min, d) => (d < min ? d : min));
    const monthFrom = todays.map(monthStartOf).reduce((min, d) => (d < min ? d : min));
    const ids = judgeable.map((a) => a.id);
    const accountDays = (
      await ctx.trx
        .selectFrom('crove_ads.ad_spend_day')
        .select(['ad_account_id', 'day', sql<string>`spend::text`.as('spend')])
        .where('org_id', '=', ctx.orgId)
        .where('level', '=', 'account')
        .where('ad_account_id', 'in', ids)
        .where('day', '>=', monthFrom)
        .execute()
    ).map((r) => ({ adAccountId: r.ad_account_id, day: day(r.day) as string, spend: r.spend }));
    // The campaigns' days: the last days judged and the days before them that make the median, for the accounts that chose a result.
    const campaignFrom = addDays(earliestToday, -(1 + CPR_RECENT_DAYS - 1 + CPR_HISTORY_DAYS + 1));
    const campaignDays: Array<{ adAccountId: string; campaignId: string; campaignName: string; day: string; spend: string; results: string | null }> = [];
    for (const a of judgeable) {
      if (a.result_kind === null) continue;
      const rows = await ctx.trx
        .selectFrom('crove_ads.ad_spend_day')
        .select(['external_object_id', 'object_name', 'day', sql<string>`spend::text`.as('spend'), sql<string | null>`(results ->> ${a.result_kind})`.as('result')])
        .where('org_id', '=', ctx.orgId)
        .where('level', '=', 'campaign')
        .where('ad_account_id', '=', a.id)
        .where('day', '>=', campaignFrom)
        .execute();
      for (const r of rows) campaignDays.push({ adAccountId: a.id, campaignId: r.external_object_id, campaignName: r.object_name, day: day(r.day) as string, spend: r.spend, results: r.result });
    }
    return evaluateFlags(
      {
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, timeZone: a.time_zone, resultKind: a.result_kind, syncedThrough: day(a.synced_through) })),
        caps,
        accountDays,
        campaignDays,
      },
      now,
    );
  },
});

export const flagQueries = [adsFlags];
