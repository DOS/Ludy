// SPDX-License-Identifier: AGPL-3.0-only
// What needs the member in Ads today, for Home's "Hôm nay cần bạn" (#2378 slice 2, shape agreed on #2383): the spend flags of the Ads screen as
// items. One read, ads.today: no write, no model call. Only owners and admins get items (the flags show spend), so a member or a viewer gets
// an empty list instead of a refusal, and Home does not count a refusal against the line. Every item is a warning that links to the Ads screen
// (a path inside the org: Home puts the org in front); nothing is approved or changed from the list.
//
// Titles are message keys with params (catalogs in apps/app: today.items.ads.*), never rendered text. An item names the org's own accounts and
// campaigns, as the Ads screen does: the shared schema's rule of no free text is about what a customer wrote, and these names are the org's own
// objects, shown to the owners and admins who read them on the Ads screen (the choice is recorded in the PR of #2378). A pace or a day flag carries its money (the projection, the day's spend) in its own currency, never
// converted. At most TODAY_ADS_CAMPAIGNS campaigns are listed one by one, the highest cost-per-result ratios first, and the rest are one item
// with their count, so a read groups before it lists.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import type { AdsFlag, TodayItem } from '@crove/kernel-contract';
import { defineQuery } from '@crove/kernel-runtime';
import { loadFlags } from './spend-flags.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The most campaigns one read lists by name, and the most items it returns (the shared list holds 200).
export const TODAY_ADS_CAMPAIGNS = 20;
const ITEMS_MAX = 200;

const HREF = '/ads';

function flagItem(flag: Exclude<AdsFlag, { kind: 'cpr' }>): TodayItem {
  const where = flag.scope === 'org' ? 'Org' : 'Account';
  const account = flag.adAccountId ?? 'org';
  const params = flag.scope === 'org' ? {} : { account: flag.accountName ?? '' };
  if (flag.kind === 'pace') {
    return { kind: 'flag', app: 'ads', id: `pace:${account}`, title: { key: `ads.pace${where}`, params }, amount: flag.projected, currency: flag.currency, severity: 'warn', href: HREF };
  }
  // The cap's period is in the key: an account over its daily and its monthly share yesterday has two items that differ in it.
  return {
    kind: 'flag',
    app: 'ads',
    id: `day:${account}:${flag.period}`,
    title: { key: `ads.day${where}${flag.period === 'daily' ? 'Daily' : 'Monthly'}`, params: { ...params, ratio: flag.ratio, day: flag.day } },
    amount: flag.spend,
    currency: flag.currency,
    severity: 'warn',
    href: HREF,
  };
}

// The id of a campaign's item: stable within the app and within the shared schema's limit (a platform's object id may be up to 200 characters,
// which with the account would pass the 200 an id may have), so a long one is cut and carries its length.
const MAX_CAMPAIGN_ID = 120;
const campaignKey = (campaignId: string): string => (campaignId.length <= MAX_CAMPAIGN_ID ? campaignId : `${campaignId.slice(0, MAX_CAMPAIGN_ID)}~${campaignId.length}`);

// Code-point order, whatever the server's locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The items of a list of flags, in the order a member should read them: the pace of a cap first, then a day over its share, then the
// campaigns, the biggest jump first (ties by account and campaign, so the same flags always give the same list). The campaigns' room is kept
// when the list is cut at the limit, so a long list of accounts cannot push every campaign out.
export function todayItemsOf(flags: readonly AdsFlag[]): TodayItem[] {
  const spend = flags.filter((f): f is Exclude<AdsFlag, { kind: 'cpr' }> => f.kind !== 'cpr');
  const campaigns = flags
    .filter((f): f is Extract<AdsFlag, { kind: 'cpr' }> => f.kind === 'cpr')
    .sort((a, b) => new Decimal(b.ratio).comparedTo(a.ratio) || byText(a.adAccountId, b.adAccountId) || byText(a.campaignId, b.campaignId));
  const named: TodayItem[] = campaigns.slice(0, TODAY_ADS_CAMPAIGNS).map((f) => ({
    kind: 'flag',
    app: 'ads',
    id: `cpr:${f.adAccountId}:${campaignKey(f.campaignId)}`,
    title: { key: 'ads.cpr', params: { campaign: f.campaignName, account: f.accountName, ratio: f.ratio } },
    severity: 'warn',
    href: HREF,
  }));
  const more = campaigns.length - TODAY_ADS_CAMPAIGNS;
  if (more > 0) named.push({ kind: 'flag', app: 'ads', id: 'cpr:more', title: { key: 'ads.cprMore', params: { count: more } }, count: more, severity: 'warn', href: HREF });
  const head = [...spend.filter((f) => f.kind === 'pace'), ...spend.filter((f) => f.kind === 'day')].map(flagItem);
  return [...head.slice(0, ITEMS_MAX - named.length), ...named];
}

export const adsToday = defineQuery({
  name: 'ads.today',
  // `now` is for the tests that fix the clock: Home never passes it.
  input: z.object({ now: z.iso.datetime().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || !MANAGERS.includes(ctx.role)) return [];
    return todayItemsOf(await loadFlags(ctx, input.now ? new Date(input.now) : new Date()));
  },
});

export const todayQueries = [adsToday];
