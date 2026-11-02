// SPDX-License-Identifier: AGPL-3.0-only
// Asking the AI coworker for a campaign draft (W1b, issue #2295, plan docs/plan/ads-write.md section 10, ADR-0043). A member writes what to promote and
// the objective; a worker job calls the model (packages/agent, through the AI budget meter) and the system context stores the answer as a draft with
// origin `ai`, which a person reads, edits and submits like one they wrote. Refusals are never silent: a request settled with no draft keeps a code that
// says why (the AI is off, the org's budget or limit is spent, the model failed or its answer did not pass the checks).
//
// The model writes the creative part only (the name, how long, who it is for, the texts). Everything with money or a date is the rules below: the
// flight starts tomorrow in the account's own time zone and the daily budget is never above any cap in force, so the AI coworker never sets spend. The
// same local validation (campaign-plan.ts) judges the draft afterwards, and submitting it for approval is an owner's or an admin's, as for any draft.
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zAdsCampaignDraftRecord, zAdsCampaignRequest, zId, type AdsCampaignDraftSource, type AdsCampaignPlanDraft, type AdsCampaignRequestAsked, type AdsCampaignRequestView } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { accountOf, columnsOf, contextBase } from './campaign-draft.ts';
import { flightDays, maxSpendOf } from './campaign-plan.ts';
import { addDays, currencyDecimals, todayIn } from './domain.ts';

const DRAFTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
type Db = Pick<CommandContext, 'trx' | 'orgId'>;

// The event the draft queue takes (ids only): the outbox relay of the worker turns it into a job.
export const ADS_CAMPAIGN_DRAFT_QUEUED = 'ads.campaign.draft_queued';

const requestMissing = () => new DomainError('ADS_DRAFT_REQUEST_NOT_FOUND', 404, 'Không tìm thấy yêu cầu soạn nháp này');

// ---------------------------------------------------------------------------------------------------------------
// The rules that are not the model's: the dates and the daily budget of a draft the AI coworker wrote
// ---------------------------------------------------------------------------------------------------------------

// The daily budget a draft starts with: below every daily cap in force and below every monthly cap spread over 31 days (a flight never has more days
// in a month than that, so its spend in any month stays inside the monthly cap), in the account's currency, rounded down to the currency's smallest
// unit. Null when no cap is in force (the plan then says so: a launch needs a cap) or when the result would be zero. Decimal arithmetic, never a number.
export function defaultDailyBudget(currency: string | null, dailyCaps: readonly string[], monthlyCaps: readonly string[]): string | null {
  if (currency === null) return null;
  const candidates = [...dailyCaps.map((c) => new Decimal(c)), ...monthlyCaps.map((c) => new Decimal(c).div(31))];
  if (candidates.length === 0) return null;
  const lowest = candidates.reduce((a, b) => (b.lt(a) ? b : a));
  // At most two decimals whatever the currency's own, as a budget is entered (zAdsBudget).
  const rounded = lowest.toDecimalPlaces(Math.min(currencyDecimals(currency), 2), Decimal.ROUND_DOWN);
  return rounded.gt(0) ? rounded.toFixed() : null;
}

// What the draft is made of: the model's creative part and the rules' dates and budget. The fields the AI coworker or the rules filled are named, so the
// builder marks them as drafted.
export interface AiPlan {
  name: string;
  durationDays: number;
  targeting: Omit<NonNullable<AdsCampaignPlanDraft['targeting']>, 'locations'> & { locations: Array<{ country: string; region?: string | null }> };
  linkUrl: string | null;
  variants: NonNullable<AdsCampaignPlanDraft['variants']>;
}
export function assembleDraft(source: Pick<AdsCampaignDraftSource, 'objective' | 'sourcePostId' | 'currency' | 'today' | 'dailyCaps' | 'monthlyCaps'>, ai: AiPlan): { plan: AdsCampaignPlanDraft; aiFields: string[] } {
  const startOn = addDays(source.today, 1);
  const endOn = addDays(startOn, Math.max(1, Math.min(90, ai.durationDays)) - 1);
  const dailyBudget = defaultDailyBudget(source.currency, source.dailyCaps, source.monthlyCaps);
  const plan: AdsCampaignPlanDraft = {
    name: ai.name,
    objective: source.objective,
    ...(dailyBudget !== null ? { dailyBudget } : {}),
    startOn,
    endOn,
    targeting: { ...ai.targeting, locations: ai.targeting.locations.map((l) => (l.region ? { country: l.country, region: l.region } : { country: l.country })) },
    linkUrl: ai.linkUrl,
    sourcePostId: source.sourcePostId,
    variants: ai.variants,
  };
  const aiFields = ['name', 'startOn', 'endOn', 'targeting', 'linkUrl', 'variants', ...(dailyBudget !== null ? ['dailyBudget'] : [])];
  return { plan, aiFields };
}

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------

function requestSelect(db: Db['trx']) {
  return db
    .selectFrom('crove_ads.ad_campaign_request as r')
    .innerJoin('crove_ads.ad_account as a', (j) => j.onRef('a.org_id', '=', 'r.org_id').onRef('a.id', '=', 'r.ad_account_id'))
    .select(['r.id', 'r.ad_account_id', 'r.objective', 'r.brief', 'r.source_post_id', 'r.state', 'r.code', 'r.draft_id', 'r.requested_by', 'r.requested_at', 'r.settled_at', 'a.name as account_name']);
}
type RequestRow = Awaited<ReturnType<ReturnType<typeof requestSelect>['execute']>>[number];

const viewOf = (row: RequestRow): AdsCampaignRequestView => ({
  id: row.id,
  adAccountId: row.ad_account_id,
  adAccountName: row.account_name,
  objective: row.objective as AdsCampaignRequestView['objective'],
  brief: row.brief,
  sourcePostId: row.source_post_id,
  state: row.state as AdsCampaignRequestView['state'],
  code: row.code,
  draftId: row.draft_id,
  requestedAt: row.requested_at.toISOString(),
  settledAt: row.settled_at ? row.settled_at.toISOString() : null,
});

// A member asks for a draft: a row requested (their brief and objective, in their own name) and the event the draft queue takes, with ids only. R2 and
// external like a reply: the job it leads to reaches the AI endpoint. One request waiting per member.
export const adsCampaignDraftRequest = defineCommand({
  name: 'ads.campaign.draft_request',
  input: zAdsCampaignRequest,
  risk: 'R2',
  sideEffect: 'external',
  access: DRAFTERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<AdsCampaignRequestAsked> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhờ soạn nháp chiến dịch được');
    const userId = ctx.actor.userId;
    const adAccountId = input.adAccountId.toLowerCase();
    const account = await accountOf(ctx, adAccountId, true);
    // One request waits per member: two asks of the same member at once wait for each other here, so the second sees the first.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.ads.request:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);
    const waiting = await ctx.trx
      .selectFrom('crove_ads.ad_campaign_request')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('requested_by', '=', userId)
      .where('state', '=', 'requested')
      .executeTakeFirst();
    if (waiting) throw new DomainError('ADS_DRAFT_REQUEST_OPEN', 409, 'Bạn đang có một yêu cầu soạn nháp chờ trả lời; chờ xong rồi nhờ tiếp');
    const inserted = await ctx.trx
      .insertInto('crove_ads.ad_campaign_request')
      .values({
        org_id: ctx.orgId,
        ad_account_id: adAccountId,
        legal_entity_id: account.legalEntityId,
        objective: input.objective,
        brief: input.brief,
        source_post_id: input.sourcePostId ?? null,
        requested_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.emit(ADS_CAMPAIGN_DRAFT_QUEUED, { requestId: inserted.id });
    // The audit row has the ids, the objective and the length of the brief, never the member's text.
    ctx.audit({ requestId: inserted.id, adAccountId, objective: input.objective, briefLength: input.brief.length });
    const [row] = await requestSelect(ctx.trx).where('r.org_id', '=', ctx.orgId).where('r.id', '=', inserted.id).execute();
    if (!row) throw requestMissing();
    const { brief: _brief, sourcePostId: _sourcePostId, ...asked } = viewOf(row);
    return asked;
  },
});

// The requests of the org the member reads, newest first: a request waiting, one with its draft, one with the reason there is none.
export const adsCampaignRequests = defineQuery({
  name: 'ads.campaign.requests',
  input: z.strictObject({ adAccountId: zId.optional() }),
  access: DRAFTERS,
  handler: async (ctx: QueryContext, input): Promise<AdsCampaignRequestView[]> => {
    let q = requestSelect(ctx.trx).where('r.org_id', '=', ctx.orgId);
    if (input.adAccountId) q = q.where('r.ad_account_id', '=', input.adAccountId.toLowerCase());
    const list = await q.orderBy('r.requested_at', 'desc').orderBy('r.id').limit(50).execute();
    return list.map(viewOf);
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What the job reads and what it records (system only)
// ---------------------------------------------------------------------------------------------------------------

const requireSystem = (ctx: Pick<CommandContext, 'actor'>) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới được thực hiện thao tác này');
};

// What the draft job reads for a waiting request: the member's words, the account's facts and the caps in force that apply to it. Null when there is
// nothing to draft (the request was settled, or its account went), so a job that outlived its row stops. System only.
export const adsCampaignDraftSource = defineQuery({
  name: 'ads.campaign.draft_source',
  input: z.strictObject({ requestId: zId }),
  access: 'system',
  handler: async (ctx: QueryContext, input): Promise<AdsCampaignDraftSource | null> => {
    requireSystem(ctx);
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_campaign_request')
      .select(['id', 'ad_account_id', 'objective', 'brief', 'source_post_id', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId.toLowerCase())
      .executeTakeFirst();
    if (!row || row.state !== 'requested') return null;
    const account = await accountOf(ctx, row.ad_account_id).catch(() => null);
    if (!account) return null;
    const base = await contextBase(ctx, account.id);
    // A cap in another currency is never compared with this account's amounts.
    const inCurrency = base.caps.filter((c) => c.currency === account.currency);
    return {
      requestId: row.id,
      adAccountId: row.ad_account_id,
      objective: row.objective as AdsCampaignDraftSource['objective'],
      brief: row.brief,
      sourcePostId: row.source_post_id,
      currency: account.currency,
      timeZone: account.timeZone,
      today: todayIn(account.timeZone ?? 'UTC', new Date()),
      dailyCaps: inCurrency.filter((c) => c.period === 'daily').map((c) => c.amount),
      monthlyCaps: inCurrency.filter((c) => c.period === 'monthly').map((c) => c.amount),
    };
  },
});

// The job's answer: a draft written (the system inserts it with origin `ai`, in the name of the member who asked, and the request names it) or none
// (a code says why, and the request keeps it so the member sees it). A request already settled is left as it is.
export const adsCampaignDraftRecord = defineCommand({
  name: 'ads.campaign.draft_record',
  input: zAdsCampaignDraftRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_campaign_request', id: input.requestId }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    requireSystem(ctx);
    const requestId = input.requestId.toLowerCase();
    const request = await ctx.trx
      .selectFrom('crove_ads.ad_campaign_request')
      .select(['ad_account_id', 'requested_by', 'state', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!request || request.state !== 'requested') return { recorded: false };
    if (input.outcome === 'none') {
      await ctx.trx.updateTable('crove_ads.ad_campaign_request').set({ state: 'none', code: input.code }).where('org_id', '=', ctx.orgId).where('id', '=', requestId).execute();
      ctx.audit({ requestId, outcome: 'none', code: input.code });
      return { recorded: true };
    }
    const { days, ...columns } = columnsOf(input.plan);
    const maxSpend = input.plan.dailyBudget && days ? maxSpendOf(input.plan.dailyBudget, days) : null;
    const draft = await ctx.trx
      .insertInto('crove_ads.ad_campaign_draft')
      .values({
        org_id: ctx.orgId,
        ad_account_id: request.ad_account_id,
        legal_entity_id: request.legal_entity_id,
        ...columns,
        max_spend: maxSpend,
        origin: 'ai',
        ai_fields: input.aiFields,
        created_by: request.requested_by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.trx.updateTable('crove_ads.ad_campaign_request').set({ state: 'written', draft_id: draft.id }).where('org_id', '=', ctx.orgId).where('id', '=', requestId).execute();
    ctx.audit({ requestId, outcome: 'written', draftId: draft.id, adAccountId: request.ad_account_id, days: flightDays(input.plan.startOn, input.plan.endOn), maxSpend });
    return { recorded: true };
  },
});

export const campaignRequestCommands = [adsCampaignDraftRequest, adsCampaignDraftRecord];
export const campaignRequestQueries = [adsCampaignRequests, adsCampaignDraftSource];
