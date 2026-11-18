// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post (ads W3, issue #3834, plan docs/plan/ads-write.md sections 2 and 10, ADR-0043). A boost is a W1 draft whose creative came from a
// post, so it follows every rule of W1 and W2 and adds none of its own to the money path: the request for approval is `ads.campaign.prepare_launch` and the
// approval `ads.campaign.launch` (the plan, its hash and the largest amount it can spend, the caps under the org's lock, the kill switch, the exactly-once
// launch job). There is NO second launch path: this file only turns "a post, a goal, a budget, some days, an audience" into a draft and tells the post where
// its boost stands.
//
// Who may do what: owners, admins and members draft a boost (as they draft any campaign); owners and admins ask for the approval and an owner or an admin who
// is not its author approves it (the one-person path aside). The AI coworker (Uy) never launches: a person submits and an approver approves. Drafting a
// boost is refused while ad writing is off for the org or the account, or launches are blocked, so with writing off there is no boost at all (the screen
// shows no button); a plain draft stays possible then, as W1 says, because a draft spends nothing. Ads reads no Social table: the post's words and link
// arrive in the command's input, copied by the app, and only the post's id is kept (an opaque reference).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import {
  zAdsBoostDraft,
  zAdsBoostStatesInput,
  type AdsBoostDrafted,
  type AdsBoostOptions,
  type AdsBoostState,
  type AdsBoostStateView,
  type AdsLaunchState,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { boostPlan, type BoostRefusal } from './boost-plan.ts';
import { accountOf, pendingProposal, rows, saveCampaignDraft, type DraftRow } from './campaign-draft.ts';
import { todayIn } from './domain.ts';
import { launchesOfDrafts } from './launch-ledger.ts';
import { currentSetting } from './write.ts';

const DRAFTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// A launch in one of these states is over: its post may be boosted again. Every other state is a boost still going or waiting.
const OVER: readonly AdsBoostState[] = ['stopped', 'failed', 'cancelled', 'ended'];

// What stops a boost before it is a draft, each its own code the screen words (written out as DomainError calls so the screen's table of codes finds each).
function refused(reason: BoostRefusal): DomainError {
  switch (reason) {
    case 'budget_too_small':
      return new DomainError('ADS_BOOST_BUDGET_TOO_SMALL', 422, 'Ngân sách quá nhỏ so với số ngày: mỗi ngày không đủ một đơn vị tiền nhỏ nhất. Hãy tăng ngân sách hoặc giảm số ngày', { reason });
    case 'link_needed':
      return new DomainError('ADS_BOOST_LINK_NEEDED', 422, 'Bài đăng này chưa có đường dẫn https để quảng cáo mở ra; hãy chọn mục tiêu nhắn tin hoặc thêm đường dẫn vào bài', { reason });
    case 'page_needed':
      return new DomainError('ADS_BOOST_PAGE_NEEDED', 422, 'Quảng cáo cần chạy dưới tên một Trang Facebook đã kết nối; hãy chọn một Trang đang hoạt động của tổ chức', { reason });
  }
}

// A boost that is waiting for approval or still going (approved and its launch not over): it holds its post.
const isGoing = (b: { row: DraftRow; state: AdsBoostState }): boolean => b.state === 'waiting_approval' || (b.row.status === 'approved' && !OVER.includes(b.state));

// Where a boost stands, from its draft and its launch: waiting in the Inbox, a draft, or the state of the launch an approved plan left.
// A launch whose last day has passed in the account's own time is over whatever its row says (a flight that runs out is not a stop): 'ended'.
function stateOf(row: DraftRow, waiting: boolean, launch: { state: AdsLaunchState; endOn: string } | null, today: string): AdsBoostState {
  if (row.status === 'approved') {
    if (launch !== null && launch.endOn < today && !OVER.includes(launch.state)) return 'ended';
    return launch?.state ?? 'queued';
  }
  return waiting ? 'waiting_approval' : 'draft';
}

// The drafts of the org that came from these posts and are not discarded, newest change first, with where each stands.
async function boostsOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, postIds: readonly string[]) {
  const list = await rows(ctx, { postIds, notDiscarded: true }).limit(200).execute();
  const launches = await launchesOfDrafts(
    ctx,
    list.filter((r) => r.status === 'approved').map((r) => r.id),
  );
  const out: Array<{ row: DraftRow; state: AdsBoostState; proposalId: string | null; launch: ReturnType<typeof launches.get> }> = [];
  const zones = new Map<string, string>();
  const now = new Date();
  for (const row of list) {
    const proposalId = row.status === 'draft' ? await pendingProposal(ctx, row.id) : null;
    const launch = launches.get(row.id);
    let zone = zones.get(row.ad_account_id);
    if (zone === undefined) {
      zone = (await accountOf(ctx, row.ad_account_id)).timeZone ?? 'UTC';
      zones.set(row.ad_account_id, zone);
    }
    out.push({ row, state: stateOf(row, proposalId !== null, launch ? { state: launch.state, endOn: launch.endOn } : null, todayIn(zone, now)), proposalId, launch });
  }
  return out;
}

// Drafts a boost of a published post: a new draft, or the open one of this post and account edited in place. Refused while writing is off, while launches
// are blocked, while the post's boost is waiting for approval or still going, and when the plan cannot be made from what was given.
export const adsBoostDraft = defineCommand({
  name: 'ads.boost.draft',
  input: zAdsBoostDraft,
  risk: 'R1',
  sideEffect: 'internal',
  access: DRAFTERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<AdsBoostDrafted> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tạo được bản nháp đẩy bài');
    const adAccountId = input.adAccountId.toLowerCase();
    const postId = input.postId.toLowerCase();
    // One boost of a post at a time, whatever the tab or the account asking: the post's own transaction advisory lock (the family the org's switches use), so two drafts of
    // one post made at the same moment queue and the second sees the first. It makes no row and touches no switch.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.ads.boost:${ctx.orgId}:${postId}`}, 0))`.execute(ctx.trx);
    const account = await accountOf(ctx, adAccountId, true);
    // A boost spends money once approved, so the switches are checked now, not only at the approval: with writing off, no boost is drafted.
    const setting = await currentSetting(ctx);
    if (!setting?.write_enabled) throw new DomainError('ADS_BOOST_OFF', 409, 'Việc chạy quảng cáo đang tắt cho tổ chức nên chưa đẩy bài được');
    if (!account.writeEnabled) throw new DomainError('ADS_BOOST_ACCOUNT_OFF', 409, 'Tài khoản quảng cáo này chưa được bật để chạy quảng cáo');
    if (setting.launches_blocked) throw new DomainError('ADS_BOOST_BLOCKED', 409, 'Việc chạy quảng cáo đang bị chặn; chủ sở hữu cần mở lại trước');
    // The currency and the time zone are read together by the account's first update; a launch cannot start without the zone (the flight's days are the account's own).
    if (account.currency === null || account.timeZone === null) throw new DomainError('ADS_BOOST_ACCOUNT_NOT_READY', 409, 'Tài khoản quảng cáo này chưa đọc được đơn vị tiền hoặc múi giờ; hãy làm mới số liệu trước');
    // The post's earlier boosts: one waiting for approval or still going refuses a second; an open draft of this account is the one edited.
    const earlier = await boostsOf(ctx, [postId]);
    const busy = earlier.find(isGoing);
    if (busy) throw new DomainError('ADS_BOOST_EXISTS', 409, 'Bài này đã có một lượt đẩy đang chờ duyệt hoặc đang chạy', { draftId: busy.row.id, state: busy.state });
    const open = earlier.find((b) => b.state === 'draft' && b.row.ad_account_id === adAccountId);
    // A draft of this post left open in another account is dropped when it is boosted from this one, so a post never has two drafts to send (a draft spends nothing).
    for (const stale of earlier.filter((b) => b.state === 'draft' && b.row.ad_account_id !== adAccountId)) {
      await ctx.trx.updateTable('crove_ads.ad_campaign_draft').set({ status: 'discarded' }).where('org_id', '=', ctx.orgId).where('id', '=', stale.row.id).execute();
    }
    // Every ad runs as a Page: it must be an active Facebook Page of this org (the launch stops a plan without one, so say it now, before an approval is asked for).
    const page = await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['provider', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', input.pageConnectionId.toLowerCase()).executeTakeFirst();
    if (!page || page.provider !== 'facebook_page' || page.status !== 'active') throw refused('page_needed');
    const today = todayIn(account.timeZone, ctx.now);
    const made = boostPlan({ ...input, adAccountId, postId }, { today, currency: account.currency });
    if ('refusal' in made) throw refused(made.refusal);
    // The very same save as the builder's, so the draft is checked by the same rules and the database holds it the same way. The audit row names the boost
    // by ids and numbers, never the post's words.
    const draft = await saveCampaignDraft(ctx, { adAccountId, plan: made.plan, ...(open ? { draftId: open.row.id } : {}) }, { boost: true, postId, goal: input.goal, audience: input.audience, days: input.days, budget: input.budget });
    return { draft, edited: open !== undefined };
  },
});

// Whether boosting is possible for the caller, and with which accounts. Members read it (they draft); the caps and the switches stay the owners' and admins'
// to read, so this says only yes or why not, in a code.
export const adsBoostOptions = defineQuery({
  name: 'ads.boost.options',
  input: z.strictObject({}),
  access: DRAFTERS,
  handler: async (ctx: QueryContext): Promise<AdsBoostOptions> => {
    const setting = await currentSetting(ctx);
    if (!setting?.write_enabled) return { enabled: false, reason: 'writing_off', accounts: [], pages: [] };
    if (setting.launches_blocked) return { enabled: false, reason: 'launches_blocked', accounts: [], pages: [] };
    const found = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'name', 'currency', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('write_enabled', '=', true)
      .where('currency', 'is not', null)
      .where('time_zone', 'is not', null)
      .orderBy('name')
      .orderBy('id')
      .execute();
    const accounts = found.map((a) => ({ id: a.id, name: a.name, currency: a.currency as string, provider: a.provider }));
    if (accounts.length === 0) return { enabled: false, reason: 'no_account', accounts, pages: [] };
    const pageRows = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'display_name'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', 'facebook_page')
      .where('status', '=', 'active')
      .orderBy('display_name')
      .orderBy('id')
      .execute();
    return { enabled: true, reason: null, accounts, pages: pageRows.map((p) => ({ id: p.id, name: p.display_name })) };
  },
});

// The newest boost of each of some posts (a post with none is left out): where it stands, and the launch it ended in. A draft built from a post in the
// campaign builder counts too: it is an ad of that post.
export const adsBoostStates = defineQuery({
  name: 'ads.boost.states',
  input: zAdsBoostStatesInput,
  access: DRAFTERS,
  handler: async (ctx: QueryContext, input): Promise<AdsBoostStateView[]> => {
    const wanted = [...new Set(input.postIds.map((id) => id.toLowerCase()))];
    const all = await boostsOf(ctx, wanted);
    const newest = new Map<string, (typeof all)[number]>();
    // The list is newest change first. A boost that is waiting or going is the post's boost whatever was drafted after it (a draft made from the same post in the
    // builder must not hide it); otherwise the newest is.
    for (const b of all) if (b.row.source_post_id !== null && isGoing(b) && !newest.has(b.row.source_post_id)) newest.set(b.row.source_post_id, b);
    for (const b of all) if (b.row.source_post_id !== null && !newest.has(b.row.source_post_id)) newest.set(b.row.source_post_id, b);
    const cache = new Map<string, Awaited<ReturnType<typeof accountOf>>>();
    const views: AdsBoostStateView[] = [];
    for (const [postId, b] of newest) {
      let account = cache.get(b.row.ad_account_id);
      if (!account) {
        account = await accountOf(ctx, b.row.ad_account_id);
        cache.set(b.row.ad_account_id, account);
      }
      views.push({
        postId,
        draftId: b.row.id,
        adAccountId: b.row.ad_account_id,
        adAccountName: b.row.account_name,
        currency: account.currency,
        state: b.state,
        objective: b.row.objective as AdsBoostStateView['objective'],
        proposalId: b.proposalId,
        launchId: b.launch?.id ?? null,
        step: b.launch?.step ?? null,
        stopReason: b.launch?.stopReason ?? null,
        maxSpend: b.row.max_spend,
        days: b.row.start_on !== null && b.row.end_on !== null ? Math.round((Date.parse(`${b.row.end_on}T00:00:00Z`) - Date.parse(`${b.row.start_on}T00:00:00Z`)) / 86_400_000) + 1 : null,
        startOn: b.row.start_on,
        endOn: b.row.end_on,
        updatedAt: b.row.updated_at.toISOString(),
      });
    }
    return views;
  },
});

export const boostCommands = [adsBoostDraft];
export const boostQueries = [adsBoostOptions, adsBoostStates];
