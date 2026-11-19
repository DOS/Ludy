// SPDX-License-Identifier: AGPL-3.0-only
// The Ads results an MCP grant may read (epic #3857, E1, issue #3860; ADR-0051 decision 2): `ludy_ads_spend` (ads.mcp.spend), `ludy_ads_today` (ads.mcp.today) and `ludy_ads_flags` (ads.mcp.flags).
// R0 reads of what the Ads screen shows an owner or admin, for a company grant's consenting owner or admin only (the flags and the spend are money the org spends, which the screen itself keeps from
// members and viewers); a member-bound grant is not offered them. They run the same loaders as the screen, so the answer is what the owner sees there.
//
// Privacy review. What leaves: for `ads.mcp.spend`, the org's ad accounts (id, name, currency, time zone, the result the owner chose and how far the figures are synced) and, for one chosen account,
// the spend, impressions, clicks, results and cost per result for a stretch of days, by month, by campaign (the platform's campaign id and the latest name it gave it, the most spending first) and by day;
// for `ads.mcp.flags` and `ads.mcp.today`, the spend-pace, day-over-share and cost-per-result flags (account and campaign ids and names, caps and figures as decimal strings in the account's own
// currency, never converted). Money is a decimal string, never a number. Campaign and account names come from the ad platform, so they are text from outside Ludy: every name is cut to one plain
// line and reaches the client as data, never as an instruction (the descriptions say so). Never returned: the connection, its token or the platform's account number, the creatives, the audiences,
// the targeting, the landing pages, who in the org runs the campaign, the boosts' and campaign requests' drafts, the caps' history, anything an ad account's connection holds, or a customer's data.
// The reads write nothing, call no model and move no money; Row-level security and the `org_id` filters keep other orgs out.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { plainLine, zId, type AdsFlag, type AdsSummary, type TodayItem } from '@crove/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { loadSpendSummary } from './summary.ts';
import { loadFlags } from './spend-flags.ts';
import { todayItemsOf } from './today.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
// A stretch an MCP read answers (the screen allows more): about a quarter, with a list of campaigns of at most MCP_ADS_CAMPAIGNS.
export const MCP_ADS_MAX_DAYS = 93;
export const MCP_ADS_CAMPAIGNS = 50;
export const MCP_ADS_ACCOUNTS = 50;
const NAME_MAX = 200;
// The most flags one read returns (the evaluation yields a handful per account plus the campaigns; the cap bounds a long list of accounts).
export const MCP_ADS_FLAGS_MAX = 200;

const zIsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const zMcpAdsSpendInput = z.strictObject({
  adAccountId: zId.optional().describe('The ad account to summarize (an id from this tool\'s `accounts`). Leave out to only list the accounts.'),
  from: zIsoDay.optional().describe('First day (YYYY-MM-DD, in the account\'s time zone). Default: 29 days before `to`.'),
  to: zIsoDay.optional().describe('Last day (YYYY-MM-DD). Default: today in UTC.'),
});
export const zMcpAdsFlagsInput = z.strictObject({});
export const zMcpAdsTodayInput = z.strictObject({});

export interface McpAdsAccount {
  id: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
  resultKind: string | null;
  syncedThrough: string | null;
}
export interface McpAdsSpend {
  accounts: McpAdsAccount[];
  accountsTruncated: boolean;
  summary: AdsSummary | null;
}

const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
}

// Every string of a value as one plain line (names from the platform), numbers and booleans as they are.
function plainDeep<T>(value: T): T {
  if (typeof value === 'string') return plainLine(value, NAME_MAX) as T;
  if (Array.isArray(value)) return value.map((v) => plainDeep(v)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainDeep(v)])) as T;
  return value;
}

// `ludy_ads_spend`: the org's ad accounts, and for the chosen one its spend over the stretch.
export const mcpAdsSpend = defineQuery({
  name: 'ads.mcp.spend',
  input: zMcpAdsSpendInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpAdsSpend> => {
    requireGrant(ctx);
    const rows = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'name', 'currency', 'time_zone', 'result_kind', 'synced_through'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('name')
      .orderBy('id')
      .limit(MCP_ADS_ACCOUNTS + 1)
      .execute();
    const accounts = rows.slice(0, MCP_ADS_ACCOUNTS).map((a): McpAdsAccount => ({ id: a.id, name: plainLine(a.name, NAME_MAX), currency: a.currency, timeZone: a.time_zone, resultKind: a.result_kind, syncedThrough: day(a.synced_through) }));
    if (!input.adAccountId) return { accounts, accountsTruncated: rows.length > accounts.length, summary: null };
    const to = input.to ?? new Date().toISOString().slice(0, 10);
    const from = input.from ?? addDays(to, -29);
    if (from <= to && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= MCP_ADS_MAX_DAYS) throw new DomainError('ADS_RANGE_INVALID', 422, `Chỉ xem được tối đa ${MCP_ADS_MAX_DAYS} ngày một lần`);
    const summary = await loadSpendSummary(ctx, { adAccountId: input.adAccountId, from, to }, MCP_ADS_CAMPAIGNS);
    return { accounts, accountsTruncated: rows.length > accounts.length, summary: { ...summary, campaigns: summary.campaigns.map((c) => ({ ...c, externalObjectId: plainLine(c.externalObjectId, NAME_MAX), name: plainLine(c.name, NAME_MAX) })) } };
  },
});

// `ludy_ads_flags`: the spend-pace, day and cost-per-result flags as the Ads screen computes them, now.
export const mcpAdsFlags = defineQuery({
  name: 'ads.mcp.flags',
  input: zMcpAdsFlagsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<{ flags: AdsFlag[]; truncated: boolean }> => {
    requireGrant(ctx);
    const flags = await loadFlags(ctx, new Date());
    return { flags: plainDeep(flags.slice(0, MCP_ADS_FLAGS_MAX)), truncated: flags.length > MCP_ADS_FLAGS_MAX };
  },
});

// `ludy_ads_today`: what needs a person in Ads today, the items Home lists (message keys with params).
export const mcpAdsToday = defineQuery({
  name: 'ads.mcp.today',
  input: zMcpAdsTodayInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<{ items: TodayItem[] }> => {
    requireGrant(ctx);
    return { items: plainDeep(todayItemsOf(await loadFlags(ctx, new Date()))) };
  },
});

export const mcpAdsQueries = [mcpAdsSpend, mcpAdsFlags, mcpAdsToday];
