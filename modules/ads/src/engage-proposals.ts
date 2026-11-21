// SPDX-License-Identifier: AGPL-3.0-only
// The proposal-only twins of the Ads commands that only stop or reduce spend, for an AI coworker that holds `ludy.ads.draft` (epic #3857, E4 #3863; ADR-0051 decision 10; docs/plan/ads-write.md
// section 3.1): stopping a launch, the kill switch, and pausing, archiving, lowering the budget of or shortening a running ad, and (#4181) cancelling a queued change that would start or raise spend. A grant's call never runs the command: it leaves a pending proposal
// (tainted) that an owner or an admin approves in Ludy, and the approval runs the original as the approver, so every check the original has (the org's lock, the launch's state, the caps and the
// kill switch, the app gate) runs then, on what stands then. The payload is the original's own strict input, so the card shows what will happen. What can START or RAISE spend (a launch, a resume, a raise, an extension) is not here, by decision (Engage PO 2026-11-20): those commands have a preparer that builds the plan and the amount the approver signs, their database guards accept only a proposal of the original command, and a client's raw payload would skip both; a person launches from Ludy (docs/runbooks/mcp-endpoint.md).
// The twins declare no `runsWhenOff` (the app gate's pinned list): with Ads switched off an approval is refused like any Ads command, and a person's own stop still runs.
import { zApprovedCall } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { adsLaunchStop } from './launch-pause.ts';
import { adsBudgetLower, adsManageCancel, adsObjectArchive, adsObjectPause, adsScheduleShorten } from './manage.ts';
import { OPENING_KINDS } from './manage-rules.ts';
import { adsPauseAll } from './write.ts';

// Only an approved proposal reaches the handler (the runtime's proposal state gate); the approver is a person, never an agent or a grant.
function requireApprover(ctx: Pick<CommandContext, 'actor' | 'proposalId'>): void {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp || !ctx.proposalId) throw new DomainError('ADS_ONLY_APPROVED', 403, 'Chỉ chạy được qua một đề xuất đã duyệt');
}

export const adsLaunchStopApproved = defineCommand({
  name: 'ads.launch.stop_approved',
  input: zApprovedCall(adsLaunchStop.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.launch_stop',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const stopped = await ctx.run<Record<string, unknown>>('ads.launch.stop', input.payload);
    ctx.audit({ approved_command: 'ads.launch.stop' });
    return stopped;
  },
});

export const adsPauseAllApproved = defineCommand({
  name: 'ads.pause_all_approved',
  input: zApprovedCall(adsPauseAll.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.pause_all',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const paused = await ctx.run<Record<string, unknown>>('ads.pause_all', input.payload);
    ctx.audit({ approved_command: 'ads.pause_all' });
    return paused;
  },
});

export const adsObjectPauseApproved = defineCommand({
  name: 'ads.object.pause_approved',
  input: zApprovedCall(adsObjectPause.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.object_pause',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const changed = await ctx.run<Record<string, unknown>>('ads.object.pause', input.payload);
    ctx.audit({ approved_command: 'ads.object.pause' });
    return changed;
  },
});

export const adsObjectArchiveApproved = defineCommand({
  name: 'ads.object.archive_approved',
  input: zApprovedCall(adsObjectArchive.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.object_archive',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const changed = await ctx.run<Record<string, unknown>>('ads.object.archive', input.payload);
    ctx.audit({ approved_command: 'ads.object.archive' });
    return changed;
  },
});

export const adsBudgetLowerApproved = defineCommand({
  name: 'ads.budget.lower_approved',
  input: zApprovedCall(adsBudgetLower.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.budget_lower',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const changed = await ctx.run<Record<string, unknown>>('ads.budget.lower', input.payload);
    ctx.audit({ approved_command: 'ads.budget.lower' });
    return changed;
  },
});

export const adsScheduleShortenApproved = defineCommand({
  name: 'ads.schedule.shorten_approved',
  input: zApprovedCall(adsScheduleShorten.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.schedule_shorten',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  target: (input) => ({ type: 'ads.ad_launch', id: input.payload.launchId.toLowerCase() }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const changed = await ctx.run<Record<string, unknown>>('ads.schedule.shorten', input.payload);
    ctx.audit({ approved_command: 'ads.schedule.shorten' });
    return changed;
  },
});

// Cancelling a queued change that would start or raise spend (a resume, a raised budget, a longer schedule) only ever reduces what is pending. Cancelling a queued pause, archive, lower budget or shorter
// schedule would do the opposite (the ad keeps spending what the person wanted stopped), so the twin never cancels one: the check reads the change as it stands at the approval and refuses before the original
// runs; a person cancels those from the Campaigns screen. A change that does not exist is left to the original, which refuses it as it always does. The payload is the original's own strict input (the
// change's id), and the card names the change (its kind, its state, what it would set), read as the approver.
export const adsManageCancelApproved = defineCommand({
  name: 'ads.manage.cancel_approved',
  input: zApprovedCall(adsManageCancel.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'ads.manage_cancel',
  mcp: { scope: 'ludy.ads.draft', mode: 'proposal' },
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const change = await ctx.trx.selectFrom('crove_ads.ad_manage_change').select(['kind']).where('org_id', '=', ctx.orgId).where('id', '=', input.payload.changeId.toLowerCase()).executeTakeFirst();
    if (change && !OPENING_KINDS.includes(change.kind)) throw new DomainError('ADS_CANCEL_NOT_OPENING', 409, 'Chỉ hủy được thay đổi làm tăng chi tiêu; hủy thay đổi giảm chi tiêu thì làm trên màn hình Chiến dịch');
    const cancelled = await ctx.run<Record<string, unknown>>('ads.manage.cancel', input.payload);
    ctx.audit({ approved_command: 'ads.manage.cancel' });
    return cancelled;
  },
});

export const adsEngageProposalCommands = [adsLaunchStopApproved, adsPauseAllApproved, adsObjectPauseApproved, adsObjectArchiveApproved, adsBudgetLowerApproved, adsScheduleShortenApproved, adsManageCancelApproved];
