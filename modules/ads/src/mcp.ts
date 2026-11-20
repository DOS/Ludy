// SPDX-License-Identifier: AGPL-3.0-only
// The Ads results an MCP grant may read (epic #3857, E1, issue #3860; ADR-0051 decision 2): `ludy_ads_spend` (ads.mcp.spend), `ludy_ads_today` (ads.mcp.today) and `ludy_ads_flags` (ads.mcp.flags), and, since E4b
// (#4147), `ludy_ads_launches` (ads.mcp.launches): the ad launches that have started, with the ids the stop, pause, archive, lower-budget and shorten-schedule proposals need.
// R0 reads of the figures the Ads screen shows, for a company grant's consenting owner or admin only: the flags show spend, which the screen keeps from members and viewers; the spend summary (`ads.spend.summary`)
// is open to every role on screen, but the MCP read is stricter on purpose (the org's spend and campaign names go to an outside app, so only a company grant gets them), and a member-bound grant is neither offered
// the tools nor allowed the queries. They run the same loaders as the screen, so the answer is what the owner sees there.
//
// Privacy review. What leaves: for `ads.mcp.spend`, the org's ad accounts (id, name, currency, time zone, the result the owner chose and how far the figures are synced) and, for one chosen account,
// the spend, impressions, clicks, results and cost per result for a stretch of days, by month, by campaign (the platform's campaign id and the latest name it gave it, the most spending first) and by day;
// for `ads.mcp.flags` and `ads.mcp.today`, the spend-pace, day-over-share and cost-per-result flags (account and campaign ids and names, caps and figures as decimal strings in the account's own
// currency, never converted). Money is a decimal string, never a number. Campaign and account names come from the ad platform, so they are text from outside Ludy: every name is cut to one plain
// line and reaches the client as data, never as an instruction (the descriptions say so). Never returned: the connection, its token or the platform's account number, the creatives, the audiences,
// the targeting, the landing pages, who in the org runs the campaign, the boosts' and campaign requests' drafts, the caps' history, anything an ad account's connection holds, or a customer's data.
// `ads.mcp.launches` adds: for each launch that has started (launching, live or needing attention; at most MCP_ADS_LAUNCHES, the latest start first) its id, the account's id and name, its state, the account's
// currency, the first day, the daily budget and last day the platform confirmed and the ones it holds against the caps (decimal strings, days as YYYY-MM-DD), whether the controls can act now, and each recorded
// object's slot, level, name and status. Never: the plan and its hash, the creatives and targeting, the platform's account and object ids, the connections and any token, the changes' history, the proposal or who approved it, who created or updated a launch, and the largest amount (only the budget, as a decimal string). The reads are made under the grant's sealed context: each of `ad_launch`, `ad_object`, `ad_account` and `ad_manage_change` has the org policy and, narrowing it, the RESTRICTIVE `le_scope` policy (`ctx_le_scope`) that a person's read meets too. A company grant's scope is the whole org, so the read shows what an owner or an admin sees on the Campaigns screen; the query is for owners and admins only, as every Ads MCP read.
// The reads write nothing, call no model and move no money; Row-level security and the `org_id` filters keep other orgs out.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { plainLine, zId, zLocalDate, type AdsFlag, type AdsSummary, type TodayItem } from '@crove/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { STARTED_STATES } from './launch-ledger.ts';
import { launchSelect } from './launch-run.ts';
import { manageStatesOf } from './manage-state.ts';
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

export const zMcpAdsSpendInput = z.strictObject({
  adAccountId: zId.optional().describe('The ad account to summarize (an id from this tool\'s `accounts`). Leave out to only list the accounts.'),
  from: zLocalDate.optional().describe('First day (YYYY-MM-DD, in the account\'s time zone). Default: 29 days before `to`.'),
  to: zLocalDate.optional().describe('Last day (YYYY-MM-DD). Default: today in UTC.'),
});
export const zMcpAdsFlagsInput = z.strictObject({});
export const zMcpAdsTodayInput = z.strictObject({});
export const zMcpAdsLaunchesInput = z.strictObject({});
// The most launches one read returns: a small org has a handful that run at once; the cap bounds a long history of launches that stay `live` in the list.
export const MCP_ADS_LAUNCHES = 50;

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

// A company grant's alone, as the Meetings reads are: the tool list does not offer these to a member-bound grant, and the query refuses one too, so the two layers say the same thing.
function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp || ctx.actor.mcp.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
}

// A name the platform gave, or the one Ludy made when it gave none ("Meta ad account <id>", "Google Ads account <id>"), as one plain line: the fallback names carry the platform's own account number, which
// never leaves, so they leave as the label alone.
const FALLBACK_NAME = /^(Meta ad account|Google Ads account|TikTok ad account)\s+\S+/i;
const nameLine = (value: string): string => plainLine(value.replace(FALLBACK_NAME, '$1'), NAME_MAX);

// Every string of a value as one plain line (names from the platform), numbers and booleans as they are.
function plainDeep<T>(value: T): T {
  if (typeof value === 'string') return nameLine(value) as T;
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
    const accounts = rows.slice(0, MCP_ADS_ACCOUNTS).map((a): McpAdsAccount => ({ id: a.id, name: nameLine(a.name), currency: a.currency, timeZone: a.time_zone, resultKind: a.result_kind, syncedThrough: day(a.synced_through) }));
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

export interface McpAdsLaunch {
  launchId: string;
  adAccountId: string;
  adAccountName: string;
  state: string;
  currency: string;
  startOn: string;
  endOn: string;
  dailyBudget: string;
  heldDailyBudget: string;
  heldEndOn: string;
  canChange: boolean;
  objects: Array<{ slot: string; level: string; name: string; status: string; pending: string | null }>;
}

// `ludy_ads_launches`: the ad launches that have started, as the Campaigns screen shows them (the same loaders: the held values and the objects' status are the screen's), so an AI coworker can name the launch
// and the object it asks a person to stop, pause, archive, lower or shorten. Read only: nothing here asks for anything.
export const mcpAdsLaunches = defineQuery({
  name: 'ads.mcp.launches',
  input: zMcpAdsLaunchesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<{ launches: McpAdsLaunch[]; truncated: boolean }> => {
    requireGrant(ctx);
    const rows = await launchSelect(ctx)
      .where('state', 'in', [...STARTED_STATES])
      .orderBy('start_on', 'desc')
      .orderBy('id')
      .limit(MCP_ADS_LAUNCHES + 1)
      .execute();
    const launches = rows.slice(0, MCP_ADS_LAUNCHES);
    if (launches.length === 0) return { launches: [], truncated: false };
    const states = await manageStatesOf(ctx, launches);
    const accounts = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [...new Set(launches.map((l) => l.ad_account_id))])
      .execute();
    const accountName = new Map(accounts.map((a) => [a.id, nameLine(a.name)]));
    const out = launches.map((l): McpAdsLaunch => {
      const view = states.get(l.id);
      return {
        launchId: l.id,
        adAccountId: l.ad_account_id,
        adAccountName: accountName.get(l.ad_account_id) ?? '',
        state: l.state,
        currency: l.currency,
        startOn: l.start_text,
        endOn: view?.endOn ?? l.end_text,
        dailyBudget: view?.dailyBudget ?? l.daily_budget,
        heldDailyBudget: view?.heldDailyBudget ?? l.daily_budget,
        heldEndOn: view?.heldEndOn ?? l.end_text,
        canChange: view?.canChange ?? false,
        objects: (view?.objects ?? []).map((o) => ({ slot: o.slot, level: o.level, name: nameLine(o.name), status: o.status, pending: o.pending })),
      };
    });
    return { launches: out, truncated: rows.length > launches.length };
  },
});

export const mcpAdsQueries = [mcpAdsSpend, mcpAdsFlags, mcpAdsToday, mcpAdsLaunches];
