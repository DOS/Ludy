// SPDX-License-Identifier: AGPL-3.0-only
// The campaign drafts of running ads (W1, issue #2295, plan docs/plan/ads-write.md sections 3 and 10, ADR-0043). A person builds one campaign with its ad
// set and its ad, local validation (campaign-plan.ts) says what is wrong or missing, and an owner or admin submits it for approval: a proposal of
// ads.campaign.launch that names the plan, its hash and the largest amount it can spend, approved in the Inbox by someone who is not an author of it
// (P10, the one-person path aside, with a fresh second factor, P11). In W1 an approved plan is only marked approved: nothing leaves Ludy, and W2 launches it.
//
// Who may do what: owners, admins and members draft (a member limited to some legal entities sees those entities' accounts only, by the row policy of the
// table); an owner or an admin asks for approval; an agent never submits (access lists no agent) and the AI coworker's drafts are written by the system in
// W1b. The database holds the rest (crove_ads.campaign_draft_guard): a request waiting for approval freezes its draft, and a draft becomes `approved` only
// inside the execution of the approved proposal that names it.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import {
  ADS_CAMPAIGN_LAUNCH_COMMAND,
  ADS_CAMPAIGN_LAUNCH_KIND,
  zAdsCampaignDraftSave,
  zAdsCampaignLaunchPayload,
  zId,
  type AdsCampaignDraftView,
  type AdsCampaignPlanDraft,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { canonicalJson, completePlan, flightDays, maxSpendOf, planHash, validatePlan, type PlanContext } from './campaign-plan.ts';
import { todayIn } from './domain.ts';
import { currentSetting, lockedSetting, onlyApproved, refuseOpenRequest } from './write.ts';

const DRAFTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Db = Pick<CommandContext, 'trx' | 'orgId'>;

const accountMissing = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
const draftMissing = () => new DomainError('ADS_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp chiến dịch này');
const draftClosed = () => new DomainError('ADS_DRAFT_CLOSED', 409, 'Bản nháp này đã được duyệt hoặc đã bị bỏ, không sửa được nữa');
const draftSubmitted = () => new DomainError('ADS_DRAFT_SUBMITTED', 409, 'Bản nháp này đang chờ duyệt trong Hộp thư; hãy từ chối đề xuất nếu muốn sửa');

// The columns the builder reads, with the dates, the money and the lists as text the contract knows.
const draftSelect = (db: Db['trx']) =>
  db
    .selectFrom('crove_ads.ad_campaign_draft as d')
    .innerJoin('crove_ads.ad_account as a', (j) => j.onRef('a.org_id', '=', 'd.org_id').onRef('a.id', '=', 'd.ad_account_id'))
    .select([
      'd.id',
      'd.ad_account_id',
      'd.name',
      'd.objective',
      'd.status',
      'd.revision',
      'd.targeting',
      'd.link_url',
      'd.page_connection_id',
      'd.source_post_id',
      'd.media_file_id',
      'd.variants',
      'd.origin',
      'd.ai_fields',
      'd.proposal_id',
      'd.created_at',
      'd.updated_at',
      'a.name as account_name',
      'a.legal_entity_id',
      sql<string | null>`d.daily_budget::text`.as('daily_budget'),
      sql<string | null>`d.start_on::text`.as('start_on'),
      sql<string | null>`d.end_on::text`.as('end_on'),
      sql<string | null>`d.max_spend::text`.as('max_spend'),
    ]);

type DraftRow = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];
// A query for the drafts of the org, optionally one draft or one account's, newest first; `lock` takes the row for the command that changes it.
function rows(ctx: Db, where: { id?: string; adAccountId?: string; notDiscarded?: boolean }, lock = false) {
  let q = draftSelect(ctx.trx).where('d.org_id', '=', ctx.orgId);
  if (where.id) q = q.where('d.id', '=', where.id);
  if (where.adAccountId) q = q.where('d.ad_account_id', '=', where.adAccountId);
  if (where.notDiscarded) q = q.where('d.status', '<>', 'discarded');
  q = q.orderBy('d.updated_at', 'desc').orderBy('d.id');
  return lock ? q.forUpdate('d') : q;
}

// The draft's plan fields as the contract names them.
function planOf(row: DraftRow): AdsCampaignPlanDraft {
  return {
    name: row.name,
    objective: row.objective as AdsCampaignPlanDraft['objective'],
    dailyBudget: row.daily_budget,
    startOn: row.start_on,
    endOn: row.end_on,
    targeting: Object.keys(row.targeting as object).length === 0 ? null : (row.targeting as AdsCampaignPlanDraft['targeting']),
    linkUrl: row.link_url,
    pageConnectionId: row.page_connection_id,
    sourcePostId: row.source_post_id,
    mediaFileId: row.media_file_id,
    variants: row.variants as AdsCampaignPlanDraft['variants'],
  };
}

// What local validation needs about an account and the org that does not depend on a draft: the switches and the caps in force, read now, in the
// caller's transaction (a list of drafts reads them once per account).
export interface ContextBase {
  writeEnabled: boolean;
  launchesBlocked: boolean;
  caps: PlanContext['caps'];
}
export async function contextBase(ctx: Db, accountId: string): Promise<ContextBase> {
  const setting = await currentSetting(ctx);
  const capRows = await ctx.trx
    .selectFrom('crove_ads.ad_spend_cap')
    .select(['id', 'scope', 'ad_account_id', 'period', 'amount', 'currency'])
    .where('org_id', '=', ctx.orgId)
    .where((w) => w.or([w('scope', '=', 'org'), w('ad_account_id', '=', accountId)]))
    .orderBy('id')
    .execute();
  // The latest row of each (scope, account, period) is the cap in force.
  const latest = new Map<string, PlanContext['caps'][number]>();
  for (const c of capRows) latest.set(`${c.scope}:${c.ad_account_id ?? ''}:${c.period}`, { scope: c.scope as 'org' | 'account', adAccountId: c.ad_account_id, period: c.period as 'daily' | 'monthly', amount: String(c.amount), currency: c.currency });
  return { writeEnabled: setting?.write_enabled ?? false, launchesBlocked: setting?.launches_blocked ?? false, caps: [...latest.values()] };
}

async function planContext(ctx: Db, account: { id: string; currency: string | null; timeZone: string | null; writeEnabled: boolean }, pageConnectionId: string | null | undefined, now: Date, known?: ContextBase): Promise<PlanContext> {
  const base = known ?? (await contextBase(ctx, account.id));
  let pageOk: boolean | null = null;
  if (pageConnectionId) {
    const page = await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['provider', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', pageConnectionId).executeTakeFirst();
    pageOk = page !== undefined && page.provider === 'facebook_page' && page.status === 'active';
  }
  return {
    today: todayIn(account.timeZone ?? 'UTC', now),
    currency: account.currency,
    caps: base.caps,
    adAccountId: account.id,
    writeEnabled: base.writeEnabled,
    accountWriteEnabled: account.writeEnabled,
    launchesBlocked: base.launchesBlocked,
    pageOk,
  };
}

export async function accountOf(ctx: Db, adAccountId: string, lock = false) {
  let q = ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'name', 'currency', 'time_zone', 'write_enabled', 'legal_entity_id']).where('org_id', '=', ctx.orgId).where('id', '=', adAccountId);
  if (lock) q = q.forShare();
  const account = await q.executeTakeFirst();
  if (!account) throw accountMissing();
  return { id: account.id, name: account.name, currency: account.currency, timeZone: account.time_zone, writeEnabled: account.write_enabled, legalEntityId: account.legal_entity_id };
}

// The open request for approval of a draft, if one waits in the Inbox.
async function pendingProposal(ctx: Db, draftId: string): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', ADS_CAMPAIGN_LAUNCH_COMMAND)
    .where('status', '=', 'pending')
    .where(sql<boolean>`payload @> ${JSON.stringify({ draftId })}::jsonb`)
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

type ViewCache = Map<string, { account: Awaited<ReturnType<typeof accountOf>>; base: ContextBase }>;
async function viewOf(ctx: Db & Pick<CommandContext, 'role'>, row: DraftRow, now: Date, cache: ViewCache = new Map()): Promise<AdsCampaignDraftView> {
  let known = cache.get(row.ad_account_id);
  if (!known) {
    const account = await accountOf(ctx, row.ad_account_id);
    known = { account, base: await contextBase(ctx, account.id) };
    cache.set(row.ad_account_id, known);
  }
  const { account } = known;
  const plan = planOf(row);
  const checked = validatePlan(plan, await planContext(ctx, account, row.page_connection_id, now, known.base));
  // The caps are the owners' and admins' to read (ads.write.state): a member sees that a cap is exceeded, not its amount.
  const seeCaps = ctx.role === 'owner' || ctx.role === 'admin';
  const issues = seeCaps ? checked.issues : checked.issues.map((i) => ('cap' in i.params ? { ...i, params: Object.fromEntries(Object.entries(i.params).filter(([k]) => k !== 'cap')) } : i));
  return {
    id: row.id,
    adAccountId: row.ad_account_id,
    adAccountName: row.account_name,
    currency: account.currency,
    status: row.status as AdsCampaignDraftView['status'],
    revision: row.revision,
    plan,
    origin: row.origin as AdsCampaignDraftView['origin'],
    aiFields: row.ai_fields,
    maxSpend: checked.maxSpend,
    days: checked.days,
    // A draft that is over (approved or discarded) is judged no more.
    issues: row.status === 'draft' ? issues : [],
    pendingProposalId: row.status === 'draft' ? await pendingProposal(ctx, row.id) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// The columns a plan writes. `undefined` leaves a column as it is, `null` clears it.
export function columnsOf(plan: AdsCampaignPlanDraft) {
  const days = flightDays(plan.startOn, plan.endOn);
  return {
    name: plan.name,
    objective: plan.objective,
    ...(plan.dailyBudget !== undefined ? { daily_budget: plan.dailyBudget } : {}),
    ...(plan.startOn !== undefined ? { start_on: plan.startOn } : {}),
    ...(plan.endOn !== undefined ? { end_on: plan.endOn } : {}),
    ...(plan.targeting !== undefined ? { targeting: JSON.stringify(plan.targeting ?? {}) } : {}),
    ...(plan.linkUrl !== undefined ? { link_url: plan.linkUrl } : {}),
    ...(plan.pageConnectionId !== undefined ? { page_connection_id: plan.pageConnectionId } : {}),
    ...(plan.sourcePostId !== undefined ? { source_post_id: plan.sourcePostId } : {}),
    ...(plan.mediaFileId !== undefined ? { media_file_id: plan.mediaFileId } : {}),
    ...(plan.variants !== undefined ? { variants: JSON.stringify(plan.variants) } : {}),
    days,
  };
}

// The plan fields the AI coworker drafted and a person has since changed are no longer "drafted": compared as the canonical text of what was
// stored and what is stored now.
function stillDrafted(aiFields: readonly string[], before: AdsCampaignPlanDraft, after: AdsCampaignPlanDraft): string[] {
  return aiFields.filter((field) => {
    const key = field as keyof AdsCampaignPlanDraft;
    return canonicalJson(before[key] ?? null) === canonicalJson(after[key] ?? null);
  });
}

// The Page and the file a plan names are of this org: a foreign key would refuse an unknown one with an error nobody can read. (The Social post a plan
// came from is another module's table: its id is kept as it is, and the screen that offers it offers the org's own posts.)
async function refuseUnknownReferences(ctx: Db, plan: AdsCampaignPlanDraft): Promise<void> {
  if (plan.pageConnectionId) {
    const page = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', plan.pageConnectionId).executeTakeFirst();
    if (!page) throw new DomainError('ADS_DRAFT_REFERENCE', 422, 'Kênh hoặc trang đã chọn không thuộc tổ chức này');
  }
  if (plan.mediaFileId) {
    const file = await ctx.trx.selectFrom('crove_kernel.file').select('id').where('org_id', '=', ctx.orgId).where('id', '=', plan.mediaFileId).executeTakeFirst();
    if (!file) throw new DomainError('ADS_DRAFT_REFERENCE', 422, 'Tệp đã chọn không thuộc tổ chức này');
  }
}

// Saves a draft: a new one for an account, or an edit of one that is still a draft with no request waiting. The plan may be incomplete; what is
// missing comes back as issues. The database stamps the revision and who changed it, and the largest amount is worked out here, in decimal.
export const adsCampaignDraftSave = defineCommand({
  name: 'ads.campaign.draft_save',
  input: zAdsCampaignDraftSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: DRAFTERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<AdsCampaignDraftView> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới lưu được bản nháp chiến dịch');
    const userId = ctx.actor.userId;
    const adAccountId = input.adAccountId.toLowerCase();
    const account = await accountOf(ctx, adAccountId);
    const { days, ...columns } = columnsOf(input.plan);
    await refuseUnknownReferences(ctx, input.plan);
    let draftId = input.draftId?.toLowerCase();
    if (draftId) {
      const [current] = await rows(ctx, { id: draftId }, true).execute();
      if (!current) throw draftMissing();
      if (current.ad_account_id !== adAccountId) throw new DomainError('ADS_DRAFT_ACCOUNT', 422, 'Bản nháp thuộc tài khoản quảng cáo khác');
      if (current.status !== 'draft') throw draftClosed();
      if (await pendingProposal(ctx, current.id)) throw draftSubmitted();
      // An editor that sends the revision it read does not overwrite what someone saved meanwhile.
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new DomainError('ADS_DRAFT_STALE', 409, 'Bản nháp đã được người khác sửa từ lúc bạn mở nó; hãy tải lại rồi sửa tiếp');
      }
      const merged: AdsCampaignPlanDraft = { ...planOf(current), ...Object.fromEntries(Object.entries(input.plan).filter(([, v]) => v !== undefined)) } as AdsCampaignPlanDraft;
      const maxSpend = merged.dailyBudget && flightDays(merged.startOn, merged.endOn) ? maxSpendOf(merged.dailyBudget, flightDays(merged.startOn, merged.endOn) as number) : null;
      await ctx.trx
        .updateTable('crove_ads.ad_campaign_draft')
        .set({ ...columns, max_spend: maxSpend, ai_fields: stillDrafted(current.ai_fields, planOf(current), merged) })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', current.id)
        .execute();
    } else {
      const merged = input.plan;
      const maxSpend = merged.dailyBudget && days ? maxSpendOf(merged.dailyBudget, days) : null;
      const inserted = await ctx.trx
        .insertInto('crove_ads.ad_campaign_draft')
        .values({ org_id: ctx.orgId, ad_account_id: adAccountId, legal_entity_id: account.legalEntityId, ...columns, max_spend: maxSpend, created_by: userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      draftId = inserted.id;
    }
    const [saved] = await rows(ctx, { id: draftId }).execute();
    if (!saved) throw draftMissing();
    // The audit row has the ids, the amounts and the state, never the creative text (plan section 3.5).
    ctx.audit({ draftId, adAccountId, objective: saved.objective, revision: saved.revision, maxSpend: saved.max_spend, edited: input.draftId !== undefined });
    return viewOf(ctx, saved, ctx.now);
  },
});

export const adsCampaignDraftDiscard = defineCommand({
  name: 'ads.campaign.draft_discard',
  input: z.strictObject({ draftId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: DRAFTERS,
  handler: async (ctx, input): Promise<{ draftId: string }> => {
    const [current] = await rows(ctx, { id: input.draftId.toLowerCase() }, true).execute();
    if (!current) throw draftMissing();
    if (current.status !== 'draft') throw draftClosed();
    if (await pendingProposal(ctx, current.id)) throw draftSubmitted();
    await ctx.trx.updateTable('crove_ads.ad_campaign_draft').set({ status: 'discarded' }).where('org_id', '=', ctx.orgId).where('id', '=', current.id).execute();
    ctx.audit({ draftId: current.id, adAccountId: current.ad_account_id, discarded: true });
    return { draftId: current.id };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Asking for approval and the command an approval runs
// ---------------------------------------------------------------------------------------------------------------

// What a request for approval of a draft is made of: the plan as it is now, checked, with its hash and the largest amount it can spend. It writes
// nothing (a preparer): kernel.proposal.request stores the proposal. One request of a draft at a time.
export const adsCampaignPrepareLaunch = defineCommand({
  name: 'ads.campaign.prepare_launch',
  input: z.strictObject({ draftId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  // An owner or an admin asks (an agent never submits: it is listed nowhere here); an owner or an admin approves, never the one who asked unless
  // they are the only person who can (P10, the one-person path).
  access: MANAGERS,
  handler: async (ctx, input) => {
    const draftId = input.draftId.toLowerCase();
    // The org's lock first (refuseOpenRequest takes it), so the caps and the switches read next are the ones this request commits to.
    await refuseOpenRequest(ctx, ADS_CAMPAIGN_LAUNCH_COMMAND, { draftId });
    const [row] = await rows(ctx, { id: draftId }, true).execute();
    if (!row) throw draftMissing();
    if (row.status !== 'draft') throw draftClosed();
    // The account row is held while this reads it, so a switch-off of the account at the same moment is seen or waits (it changes the row under its lock).
    const account = await accountOf(ctx, row.ad_account_id, true);
    const draft = planOf(row);
    const checked = validatePlan(draft, await planContext(ctx, account, row.page_connection_id, ctx.now));
    const plan = completePlan(draft);
    if (!plan) throw new DomainError('ADS_DRAFT_INCOMPLETE', 422, 'Bản nháp chưa đủ thông tin để gửi duyệt', { issues: checked.issues.filter((i) => i.severity === 'error') });
    const errors = checked.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0 || checked.maxSpend === null || checked.days === null || account.currency === null) {
      throw new DomainError('ADS_DRAFT_INVALID', 422, `Bản nháp chưa hợp lệ: ${errors.map((e) => e.code).join(', ')}`, { issues: errors });
    }
    return {
      kind: ADS_CAMPAIGN_LAUNCH_KIND,
      command: ADS_CAMPAIGN_LAUNCH_COMMAND,
      title: `Chạy chiến dịch ${plan.name}: tối đa ${checked.maxSpend} ${account.currency}`.slice(0, 300),
      // Parsed here as well as at the approval: a request the card or the approval could not read would sit in the Inbox stuck.
      payload: zAdsCampaignLaunchPayload.parse({
        draftId: row.id,
        revision: row.revision,
        adAccountId: account.id,
        adAccountName: account.name.slice(0, 200),
        amount: checked.maxSpend,
        currency: account.currency,
        days: checked.days,
        planHash: planHash(plan, account.id, account.currency),
        origin: row.origin as 'human' | 'ai',
        aiFields: row.ai_fields,
        plan,
      }),
      // The proposal belongs to the account's legal entity (#1538).
      legalEntityId: account.legalEntityId,
    };
  },
});

// What an approval runs (access 'proposal': only through kernel.proposal.approve, as the approver, in the approving transaction). In W1 it marks the plan
// approved and nothing else: W2 queues the launch. It re-checks everything the request was made under, because the proposal may be old.
export const adsCampaignLaunch = defineCommand({
  name: ADS_CAMPAIGN_LAUNCH_COMMAND,
  input: z.object({ payload: zAdsCampaignLaunchPayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: ADS_CAMPAIGN_LAUNCH_KIND,
  target: (input) => ({ type: 'ads.ad_account', id: input.payload.adAccountId }),
  handler: async (ctx, { payload }): Promise<{ draftId: string; approved: true; maxSpend: string; currency: string }> => {
    if (!ctx.proposalId) throw onlyApproved();
    if (ctx.actor.type !== 'user') throw onlyApproved();
    // The org's lock, as the caps and the switches are changed under it: what is checked below is what stands when the draft is approved.
    await lockedSetting(ctx);
    const [row] = await rows(ctx, { id: payload.draftId.toLowerCase() }, true).execute();
    if (!row) throw draftMissing();
    if (row.status !== 'draft') throw draftClosed();
    const account = await accountOf(ctx, row.ad_account_id, true);
    const draft = planOf(row);
    const plan = completePlan(draft);
    // The proposal belongs to the legal entity the account was in when it was asked for (#1538); an account moved to another entity since is another
    // approval's business: a new request.
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').select('legal_entity_id').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
    // The plan that was asked for is the plan that stands: a change after the request is a new request. What the card showed (the plan, the account,
    // the days) is the plan the hash binds, not only the hash.
    if (
      !plan ||
      account.currency === null ||
      row.revision !== payload.revision ||
      planHash(plan, account.id, account.currency) !== payload.planHash ||
      canonicalJson(plan) !== canonicalJson(payload.plan) ||
      payload.adAccountId.toLowerCase() !== account.id ||
      proposal?.legal_entity_id !== account.legalEntityId ||
      // The taint the card showed (who wrote the plan, which fields the AI coworker drafted) is the draft's now.
      payload.origin !== row.origin ||
      canonicalJson([...payload.aiFields].sort()) !== canonicalJson([...row.ai_fields].sort())
    ) {
      throw new DomainError('ADS_DRAFT_CHANGED', 409, 'Bản nháp đã thay đổi từ lúc đề xuất này được tạo; hãy tạo đề xuất mới');
    }
    const checked = validatePlan(draft, await planContext(ctx, account, row.page_connection_id, ctx.now));
    const errors = checked.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0 || checked.maxSpend === null || checked.maxSpend !== payload.amount || checked.days !== payload.days || account.currency !== payload.currency) {
      throw new DomainError('ADS_DRAFT_INVALID', 409, `Bản nháp không còn hợp lệ: ${errors.map((e) => e.code).join(', ') || 'amount'}`, { issues: errors });
    }
    await ctx.trx.updateTable('crove_ads.ad_campaign_draft').set({ status: 'approved' }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ draftId: row.id, adAccountId: account.id, maxSpend: payload.amount, currency: payload.currency, days: payload.days, planHash: payload.planHash, revision: row.revision });
    return { draftId: row.id, approved: true, maxSpend: payload.amount, currency: payload.currency };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

export const adsCampaignDrafts = defineQuery({
  name: 'ads.campaign.drafts',
  input: z.strictObject({ adAccountId: zId.optional() }),
  access: DRAFTERS,
  handler: async (ctx: QueryContext, input): Promise<AdsCampaignDraftView[]> => {
    const list = await rows(ctx, { ...(input.adAccountId ? { adAccountId: input.adAccountId.toLowerCase() } : {}), notDiscarded: true }).limit(100).execute();
    const cache: ViewCache = new Map();
    const now = new Date();
    const views: AdsCampaignDraftView[] = [];
    for (const row of list) views.push(await viewOf(ctx, row, now, cache));
    return views;
  },
});

export const adsCampaignDraft = defineQuery({
  name: 'ads.campaign.draft',
  input: z.strictObject({ draftId: zId }),
  access: DRAFTERS,
  handler: async (ctx: QueryContext, input): Promise<AdsCampaignDraftView> => {
    const [row] = await rows(ctx, { id: input.draftId.toLowerCase() }).execute();
    if (!row) throw draftMissing();
    return viewOf(ctx, row, new Date());
  },
});

export const campaignCommands = [adsCampaignDraftSave, adsCampaignDraftDiscard, adsCampaignPrepareLaunch, adsCampaignLaunch];
export const campaignQueries = [adsCampaignDrafts, adsCampaignDraft];
