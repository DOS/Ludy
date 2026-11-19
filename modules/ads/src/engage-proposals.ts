// SPDX-License-Identifier: AGPL-3.0-only
// The proposal-only twins of the Ads commands that only stop or reduce spend, for an AI coworker that holds `ludy.ads.draft` (epic #3857, E4 #3863; ADR-0051 decision 10; docs/plan/ads-write.md
// section 3.1): stopping a launch, the kill switch, and pausing, archiving, lowering the budget of or shortening a running ad. A grant's call never runs the command: it leaves a pending proposal
// (tainted) that an owner or an admin approves in Ludy, and the approval runs the original as the approver, so every check the original has (the org's lock, the launch's state, the caps and the
// kill switch, the app gate) runs then, on what stands then. The payload is the original's own strict input, so the card shows what will happen. What can START or RAISE spend (a launch, a resume,
// a raise, an extension) is not here: those commands have a preparer that builds the plan the approver signs, and a client's raw payload would skip it (a later part of E4).
// The twins declare no `runsWhenOff` (the app gate's pinned list): with Ads switched off an approval is refused like any Ads command, and a person's own stop still runs.
import { zApprovedCall } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { adsLaunchStop } from './launch-pause.ts';
import { adsBudgetLower, adsObjectArchive, adsObjectPause, adsScheduleShorten } from './manage.ts';
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

export const adsEngageProposalCommands = [adsLaunchStopApproved, adsPauseAllApproved, adsObjectPauseApproved, adsObjectArchiveApproved, adsBudgetLowerApproved, adsScheduleShortenApproved];
