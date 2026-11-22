// SPDX-License-Identifier: AGPL-3.0-only
// The proposal-only twins of the Hộp thư commands an AI coworker may ask for (epic #3857, E4 #3863; ADR-0051 decision 10). A grant that holds `ludy.engage.write` calls
// `kernel.conversation.reply_approved` and the like: the call never runs (the runtime runs kernel.mcp.propose in its place), it leaves a pending proposal with the customer-facing text as the
// payload, marked tainted, and a person approves it in Ludy. The approval then runs this command as the approver, which runs the original command in the same transaction: the reply
// window, the platform's limits, the kill switch and the app gate are the original's, judged at the approval on what stands then, and a refusal leaves the proposal pending.
// The payload is the original's own strict input (N6 of the #3858 review): a key it does not declare is refused before a proposal is made, and the card shows exactly what will be sent.
import { zApprovedCall } from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@ludy/kernel-runtime';
import { conversationFollowUp, conversationHide, conversationReply, conversationReplyPrivately } from './conversations.ts';

// Only an approved proposal reaches the handler (the runtime's proposal state gate); the approver is a person, never an agent or a grant.
export function requireApprover(ctx: Pick<CommandContext, 'actor' | 'proposalId'>): void {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp || !ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Chỉ chạy được qua một đề xuất đã duyệt');
}

export const conversationReplyApproved = defineCommand({
  name: 'kernel.conversation.reply_approved',
  input: zApprovedCall(conversationReply.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'kernel.conversation_reply',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'kernel.conversation', id: input.payload.conversationId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const sent = await ctx.run<{ messageId: string; seq: number }>('kernel.conversation.reply', input.payload);
    ctx.audit({ approved_command: 'kernel.conversation.reply' });
    return sent;
  },
});

export const conversationReplyPrivatelyApproved = defineCommand({
  name: 'kernel.conversation.reply_privately_approved',
  input: zApprovedCall(conversationReplyPrivately.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'kernel.conversation_reply_privately',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'kernel.conversation_message', id: input.payload.messageId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const sent = await ctx.run<Record<string, unknown>>('kernel.conversation.reply_privately', input.payload);
    ctx.audit({ approved_command: 'kernel.conversation.reply_privately' });
    return sent;
  },
});

export const conversationHideApproved = defineCommand({
  name: 'kernel.conversation.hide_approved',
  input: zApprovedCall(conversationHide.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'kernel.conversation_hide',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'kernel.conversation_message', id: input.payload.messageId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const hidden = await ctx.run<{ messageId: string }>('kernel.conversation.hide', input.payload);
    ctx.audit({ approved_command: 'kernel.conversation.hide' });
    return hidden;
  },
});

// A team task linked to a thread (#4148). The task is an event (an outbox row) and wakes the assignee's agent, which the sealed write context of a grant does not allow, so there is no R1 tool: the coworker asks,
// and the task is made here, as the approver, outside that context. The original runs under the proposal, which makes the task tainted (the title is an AI's text); the approver reads the title, the seat and the
// due date on the card exactly as stored.
export const conversationFollowUpApproved = defineCommand({
  name: 'kernel.conversation.follow_up_approved',
  input: zApprovedCall(conversationFollowUp.input),
  risk: 'R2',
  sideEffect: 'internal',
  access: 'proposal',
  proposalKind: 'kernel.conversation_follow_up',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'kernel.conversation', id: input.payload.conversationId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const created = await ctx.run<{ taskId: string }>('kernel.conversation.follow_up', input.payload);
    ctx.audit({ approved_command: 'kernel.conversation.follow_up' });
    return created;
  },
});

export const conversationProposalCommands = [conversationReplyApproved, conversationReplyPrivatelyApproved, conversationHideApproved, conversationFollowUpApproved];
