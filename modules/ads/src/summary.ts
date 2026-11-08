// SPDX-License-Identifier: AGPL-3.0-only
// What the Ads screen reads (plan docs/plan/ads.md sections 2 and 7.3): one account's spend, results and cost per result
// over a stretch of days, by month, by campaign and by day, in the account's currency (never converted). The cost per
// result is worked out here from the action type the owner chose, not read from the platform: spend over results in
// decimal, rounded to the currency's smallest unit, null when there is no result. Reach is not summed (it is not additive),
// so only a day carries it.
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ADS_SUMMARY_MAX_DAYS, zAdsSummaryInput, type AdsMetric, type AdsSummary } from '@crove/kernel-contract';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { costPerResult, resultsText, spendText } from './domain.ts';

const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

interface Sums {
  spend: Decimal;
  impressions: number;
  clicks: number;
  results: Decimal | null;
}

const empty = (hasKind: boolean): Sums => ({ spend: new Decimal(0), impressions: 0, clicks: 0, results: hasKind ? new Decimal(0) : null });

function add(into: Sums, spend: string, impressions: string, clicks: string, result: string | null): void {
  into.spend = into.spend.plus(spend);
  into.impressions += Number(impressions);
  into.clicks += Number(clicks);
  if (into.results !== null && result !== null) into.results = into.results.plus(result);
}

function metric(sums: Sums, currency: string | null): AdsMetric {
  return {
    spend: spendText(sums.spend, currency),
    impressions: sums.impressions,
    clicks: sums.clicks,
    results: sums.results === null ? null : resultsText(sums.results),
    costPerResult: costPerResult(sums.spend, sums.results, currency),
  };
}

const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

export const adsSpendSummary = defineQuery({
  name: 'ads.spend.summary',
  input: zAdsSummaryInput,
  access: ALL,
  handler: async (ctx, input): Promise<AdsSummary> => {
    if (input.from > input.to) throw new DomainError('ADS_RANGE_INVALID', 422, 'Khoảng ngày không hợp lệ');
    if ((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000 >= ADS_SUMMARY_MAX_DAYS) {
      throw new DomainError('ADS_RANGE_INVALID', 422, `Chỉ xem được tối đa ${ADS_SUMMARY_MAX_DAYS} ngày một lần`);
    }
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'currency', 'time_zone', 'result_kind', 'settled_through', 'synced_through'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.adAccountId)
      .executeTakeFirst();
    if (!account) throw new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
    const kind = account.result_kind;
    const hasKind = kind !== null;
    // The chosen result's count, as a decimal string, or null when the row has none of that action type.
    const resultOf = kind === null ? sql<string | null>`NULL::text` : sql<string | null>`(d.results ->> ${kind})`;

    const dayRows = await ctx.trx
      .selectFrom('crove_ads.ad_spend_day as d')
      .select([
        sql<string>`d.day::text`.as('day'),
        sql<string>`d.spend::text`.as('spend'),
        sql<string>`d.impressions::text`.as('impressions'),
        sql<string>`d.clicks::text`.as('clicks'),
        sql<string | null>`d.reach::text`.as('reach'),
        resultOf.as('result'),
        sql<boolean>`d.settled_at IS NOT NULL`.as('settled'),
      ])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.ad_account_id', '=', account.id)
      .where('d.level', '=', 'account')
      .where('d.day', '>=', input.from)
      .where('d.day', '<=', input.to)
      .orderBy('d.day')
      .execute();
    const total = empty(hasKind);
    const months = new Map<string, Sums>();
    const days: AdsSummary['days'] = [];
    for (const r of dayRows) {
      add(total, r.spend, r.impressions, r.clicks, r.result);
      const month = r.day.slice(0, 7);
      let m = months.get(month);
      if (!m) months.set(month, (m = empty(hasKind)));
      add(m, r.spend, r.impressions, r.clicks, r.result);
      const one = empty(hasKind);
      add(one, r.spend, r.impressions, r.clicks, r.result);
      days.push({ day: r.day, ...metric(one, account.currency), reach: r.reach === null ? null : Number(r.reach), settled: r.settled });
    }

    const campaignRows = await ctx.trx
      .selectFrom('crove_ads.ad_spend_day as d')
      .select([
        'd.external_object_id',
        // The latest name the platform gave it.
        sql<string>`(pg_catalog.array_agg(d.object_name ORDER BY d.day DESC))[1]`.as('name'),
        sql<string>`pg_catalog.sum(d.spend)::text`.as('spend'),
        sql<string>`pg_catalog.sum(d.impressions)::text`.as('impressions'),
        sql<string>`pg_catalog.sum(d.clicks)::text`.as('clicks'),
        kind === null ? sql<string | null>`NULL::text`.as('result') : sql<string | null>`pg_catalog.sum((d.results ->> ${kind})::numeric)::text`.as('result'),
      ])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.ad_account_id', '=', account.id)
      .where('d.level', '=', 'campaign')
      .where('d.day', '>=', input.from)
      .where('d.day', '<=', input.to)
      .groupBy('d.external_object_id')
      .orderBy(sql`pg_catalog.sum(d.spend)`, 'desc')
      .orderBy('d.external_object_id')
      .limit(500)
      .execute();
    const campaigns = campaignRows.map((r) => {
      const one = empty(hasKind);
      add(one, r.spend, r.impressions, r.clicks, r.result);
      return { externalObjectId: r.external_object_id, name: r.name, ...metric(one, account.currency) };
    });

    return {
      adAccountId: account.id,
      currency: account.currency,
      timeZone: account.time_zone,
      resultKind: kind,
      from: input.from,
      to: input.to,
      total: metric(total, account.currency),
      months: [...months.entries()].map(([month, sums]) => ({ month, ...metric(sums, account.currency) })),
      campaigns,
      days,
      settledThrough: day(account.settled_through),
      syncedThrough: day(account.synced_through),
    };
  },
});

export const summaryQueries = [adsSpendSummary];
