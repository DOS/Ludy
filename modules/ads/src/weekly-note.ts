// SPDX-License-Identifier: AGPL-3.0-only
// The deterministic weekly comparison note on the Ads screen (#2220, plan docs/plan/ads.md section 9): for each currency the
// org's synced ad accounts report in (currencies are never added or compared across each other), compares the last 7 completed
// days against the 7 days before, broken down side by side by platform (Meta, Google, sandbox) and naming the campaign whose
// spend moved the most across the org's connected platforms. Read only; no model is called.
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import type { AdsWeeklyCampaignMove, AdsWeeklyNote, AdsWeeklyPlatformNote } from '@crove/kernel-contract';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { addDays, costPerResult, resultsText, spendText, todayIn } from './domain.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const WEEKLY_WINDOW_DAYS = 7;

export interface WeeklyNoteAccount {
  id: string;
  name: string;
  provider: string;
  currency: string | null;
  timeZone: string | null;
  resultKind: string | null;
  syncedThrough: string | null;
}

export interface WeeklyAccountDay {
  adAccountId: string;
  day: string;
  spend: string;
  results: string | null;
}

export interface WeeklyCampaignDay {
  adAccountId: string;
  campaignId: string;
  campaignName: string;
  day: string;
  spend: string;
}

export interface WeeklyNoteInput {
  accounts: readonly WeeklyNoteAccount[];
  accountDays: readonly WeeklyAccountDay[];
  campaignDays: readonly WeeklyCampaignDay[];
}

const PROVIDER_RANK: Readonly<Record<string, number>> = {
  meta_ads: 0,
  google_ads: 1,
  sandbox_ads: 2,
};

function compareProvider(a: string, b: string): number {
  const ra = PROVIDER_RANK[a] ?? 99;
  const rb = PROVIDER_RANK[b] ?? 99;
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

// Pure evaluation of the weekly comparison note as of `now`. Accounts not yet synced through their own yesterday are counted in
// `skippedAccounts` for their currency and left out of the sums so a lagging account never skews a 7-day comparison.
export function evaluateWeeklyNotes(input: WeeklyNoteInput, now: Date): AdsWeeklyNote[] {
  const byCurrency = new Map<
    string,
    {
      synced: Array<WeeklyNoteAccount & { currency: string; timeZone: string; yesterday: string }>;
      skipped: number;
    }
  >();

  for (const account of input.accounts) {
    if (account.currency === null || account.timeZone === null) continue;
    let group = byCurrency.get(account.currency);
    if (!group) {
      group = { synced: [], skipped: 0 };
      byCurrency.set(account.currency, group);
    }
    const yesterday = addDays(todayIn(account.timeZone, now), -1);
    if (account.syncedThrough === null || account.syncedThrough < yesterday) {
      group.skipped += 1;
      continue;
    }
    group.synced.push({ ...account, currency: account.currency, timeZone: account.timeZone, yesterday });
  }

  const notes: AdsWeeklyNote[] = [];
  const currencies = [...byCurrency.keys()].sort((a, b) => a.localeCompare(b));

  for (const currency of currencies) {
    const group = byCurrency.get(currency)!;
    if (group.synced.length === 0) continue;

    // The latest 7 completed days every synced account of this currency has already reached.
    const recentTo = group.synced.map((a) => a.yesterday).reduce((min, d) => (d < min ? d : min));
    const recentFrom = addDays(recentTo, -(WEEKLY_WINDOW_DAYS - 1));
    const priorTo = addDays(recentFrom, -1);
    const priorFrom = addDays(priorTo, -(WEEKLY_WINDOW_DAYS - 1));

    const syncedById = new Map(group.synced.map((a) => [a.id, a]));
    let totalRecent = new Decimal(0);
    let totalPrior = new Decimal(0);

    const byProvider = new Map<
      string,
      {
        accounts: Array<WeeklyNoteAccount & { currency: string }>;
        recentSpend: Decimal;
        priorSpend: Decimal;
        recentResults: Decimal;
        priorResults: Decimal;
      }
    >();

    for (const account of group.synced) {
      let p = byProvider.get(account.provider);
      if (!p) {
        p = {
          accounts: [],
          recentSpend: new Decimal(0),
          priorSpend: new Decimal(0),
          recentResults: new Decimal(0),
          priorResults: new Decimal(0),
        };
        byProvider.set(account.provider, p);
      }
      p.accounts.push(account);
    }

    for (const row of input.accountDays) {
      const account = syncedById.get(row.adAccountId);
      if (!account) continue;
      const inRecent = row.day >= recentFrom && row.day <= recentTo;
      const inPrior = row.day >= priorFrom && row.day <= priorTo;
      if (!inRecent && !inPrior) continue;

      const spend = new Decimal(row.spend);
      const p = byProvider.get(account.provider)!;
      if (inRecent) {
        totalRecent = totalRecent.plus(spend);
        p.recentSpend = p.recentSpend.plus(spend);
        if (row.results !== null) p.recentResults = p.recentResults.plus(row.results);
      } else {
        totalPrior = totalPrior.plus(spend);
        p.priorSpend = p.priorSpend.plus(spend);
        if (row.results !== null) p.priorResults = p.priorResults.plus(row.results);
      }
    }

    if (!totalRecent.gt(0) && !totalPrior.gt(0)) continue;

    const platforms: AdsWeeklyPlatformNote[] = [...byProvider.entries()]
      .sort(([a], [b]) => compareProvider(a, b))
      .map(([provider, p]) => {
        const kinds = new Set(p.accounts.map((a) => a.resultKind));
        const onlyKind = kinds.size === 1 ? [...kinds][0]! : null;
        const recentSpendText = spendText(p.recentSpend, currency);
        const priorSpendText = spendText(p.priorSpend, currency);
        const spendDelta = spendText(p.recentSpend.minus(p.priorSpend), currency);
        const recentCpr = onlyKind !== null ? costPerResult(p.recentSpend, p.recentResults, currency) : null;
        const priorCpr = onlyKind !== null ? costPerResult(p.priorSpend, p.priorResults, currency) : null;
        const cprDelta =
          recentCpr !== null && priorCpr !== null ? spendText(new Decimal(recentCpr).minus(priorCpr), currency) : null;
        return {
          provider,
          accountCount: p.accounts.length,
          recentSpend: recentSpendText,
          priorSpend: priorSpendText,
          spendDelta,
          resultKind: onlyKind,
          recentResults: onlyKind !== null ? resultsText(p.recentResults) : null,
          priorResults: onlyKind !== null ? resultsText(p.priorResults) : null,
          recentCostPerResult: recentCpr,
          priorCostPerResult: priorCpr,
          cprDelta,
        };
      });

    // Campaign that moved the most in spend across the connected platforms of this currency.
    const campaigns = new Map<
      string,
      {
        adAccountId: string;
        accountName: string;
        provider: string;
        externalObjectId: string;
        campaignName: string;
        latestDay: string;
        recentSpend: Decimal;
        priorSpend: Decimal;
      }
    >();

    for (const row of input.campaignDays) {
      const account = syncedById.get(row.adAccountId);
      if (!account) continue;
      const inRecent = row.day >= recentFrom && row.day <= recentTo;
      const inPrior = row.day >= priorFrom && row.day <= priorTo;
      if (!inRecent && !inPrior) continue;

      const key = `${row.adAccountId}:${row.campaignId}`;
      let c = campaigns.get(key);
      if (!c) {
        c = {
          adAccountId: account.id,
          accountName: account.name,
          provider: account.provider,
          externalObjectId: row.campaignId,
          campaignName: row.campaignName,
          latestDay: row.day,
          recentSpend: new Decimal(0),
          priorSpend: new Decimal(0),
        };
        campaigns.set(key, c);
      } else if (row.day >= c.latestDay) {
        c.latestDay = row.day;
        c.campaignName = row.campaignName;
      }
      if (inRecent) c.recentSpend = c.recentSpend.plus(row.spend);
      else c.priorSpend = c.priorSpend.plus(row.spend);
    }

    let topMover: AdsWeeklyCampaignMove | null = null;
    let bestAbs = new Decimal(0);
    let bestTotal = new Decimal(0);

    for (const c of campaigns.values()) {
      const delta = c.recentSpend.minus(c.priorSpend);
      const abs = delta.abs();
      if (!abs.gt(0)) continue;
      const total = c.recentSpend.plus(c.priorSpend);
      const better =
        topMover === null ||
        abs.gt(bestAbs) ||
        (abs.eq(bestAbs) &&
          (total.gt(bestTotal) ||
            (total.eq(bestTotal) &&
              (c.adAccountId.localeCompare(topMover.adAccountId) < 0 ||
                (c.adAccountId === topMover.adAccountId && c.externalObjectId.localeCompare(topMover.externalObjectId) < 0)))));
      if (better) {
        bestAbs = abs;
        bestTotal = total;
        topMover = {
          adAccountId: c.adAccountId,
          accountName: c.accountName,
          provider: c.provider,
          externalObjectId: c.externalObjectId,
          campaignName: c.campaignName,
          recentSpend: spendText(c.recentSpend, currency),
          priorSpend: spendText(c.priorSpend, currency),
          spendDelta: spendText(delta, currency),
        };
      }
    }

    notes.push({
      currency,
      recentFrom,
      recentTo,
      priorFrom,
      priorTo,
      recentSpend: spendText(totalRecent, currency),
      priorSpend: spendText(totalPrior, currency),
      spendDelta: spendText(totalRecent.minus(totalPrior), currency),
      platforms,
      topMover,
      skippedAccounts: group.skipped,
    });
  }

  return notes;
}

const day = (value: Date | string | null): string | null =>
  value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

export async function loadWeeklyNotes(ctx: Pick<QueryContext, 'trx' | 'orgId'>, now: Date): Promise<AdsWeeklyNote[]> {
  const accounts = await ctx.trx
    .selectFrom('crove_ads.ad_account')
    .select(['id', 'name', 'provider', 'currency', 'time_zone', 'result_kind', 'synced_through'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('name')
    .orderBy('id')
    .limit(200)
    .execute();
  const judgeable = accounts.filter((a) => a.currency !== null && a.time_zone !== null && a.synced_through !== null);
  if (judgeable.length === 0) return [];

  const todays = judgeable.map((a) => todayIn(a.time_zone as string, now));
  const earliestToday = todays.reduce((min, d) => (d < min ? d : min));
  const windowFrom = addDays(earliestToday, -(2 * WEEKLY_WINDOW_DAYS));
  const ids = judgeable.map((a) => a.id);

  const accountDays = (
    await ctx.trx
      .selectFrom('crove_ads.ad_spend_day as d')
      .innerJoin('crove_ads.ad_account as a', (j) =>
        j.onRef('a.org_id', '=', 'd.org_id').onRef('a.id', '=', 'd.ad_account_id').onRef('a.legal_entity_id', '=', 'd.legal_entity_id'),
      )
      .select([
        'd.ad_account_id',
        'd.day',
        sql<string>`d.spend::text`.as('spend'),
        sql<string | null>`CASE WHEN a.result_kind IS NULL THEN NULL ELSE (d.results ->> a.result_kind) END`.as('result'),
      ])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.level', '=', 'account')
      .where('d.ad_account_id', 'in', ids)
      .where('d.day', '>=', windowFrom)
      .execute()
  ).map((r) => ({ adAccountId: r.ad_account_id, day: day(r.day) as string, spend: r.spend, results: r.result }));

  const campaignDays = (
    await ctx.trx
      .selectFrom('crove_ads.ad_spend_day as d')
      .innerJoin('crove_ads.ad_account as a', (j) =>
        j.onRef('a.org_id', '=', 'd.org_id').onRef('a.id', '=', 'd.ad_account_id').onRef('a.legal_entity_id', '=', 'd.legal_entity_id'),
      )
      .select(['d.ad_account_id', 'd.external_object_id', 'd.object_name', 'd.day', sql<string>`d.spend::text`.as('spend')])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.level', '=', 'campaign')
      .where('d.ad_account_id', 'in', ids)
      .where('d.day', '>=', windowFrom)
      .execute()
  ).map((r) => ({
    adAccountId: r.ad_account_id,
    campaignId: r.external_object_id,
    campaignName: r.object_name,
    day: day(r.day) as string,
    spend: r.spend,
  }));

  return evaluateWeeklyNotes(
    {
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        currency: a.currency,
        timeZone: a.time_zone,
        resultKind: a.result_kind,
        syncedThrough: day(a.synced_through),
      })),
      accountDays,
      campaignDays,
    },
    now,
  );
}

export const adsWeeklyNote = defineQuery({
  name: 'ads.weekly_note',
  input: z.object({ now: z.iso.datetime().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<AdsWeeklyNote[]> => loadWeeklyNotes(ctx, input.now ? new Date(input.now) : new Date()),
});

export const weeklyNoteQueries = [adsWeeklyNote];
