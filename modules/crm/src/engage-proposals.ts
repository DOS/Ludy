// SPDX-License-Identifier: AGPL-3.0-only
// The proposal-only twins of the CRM commands an AI coworker may ask for (epic #3857, E4 #3863; ADR-0051 decision 10): sending a quote and moving or cancelling a booking. A grant that holds
// `ludy.engage.write` calls `crm.quote.send_approved` and the like; the call never runs, it leaves a pending proposal (tainted) that a person approves in Ludy, and the approval runs the
// original command as the approver, so every check the original has runs then, on what stands then (a quote that was edited since is refused as stale, a booking that already started is not
// changeable). The payload is the original's own strict input.
import { zApprovedCall } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';
import { requireApprover } from '@crove/kernel';
import { bookingCancel, bookingMove } from './bookings.ts';
import { quoteSend } from './quotes.ts';

export const quoteSendApproved = defineCommand({
  name: 'crm.quote.send_approved',
  input: zApprovedCall(quoteSend.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'crm.quote_send',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'crm.quote', id: input.payload.quoteId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const sent = await ctx.run<Record<string, unknown>>('crm.quote.send', input.payload);
    ctx.audit({ approved_command: 'crm.quote.send' });
    return sent;
  },
});

export const bookingMoveApproved = defineCommand({
  name: 'crm.booking.move_approved',
  input: zApprovedCall(bookingMove.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'crm.booking_move',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'crm.booking', id: input.payload.bookingId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const moved = await ctx.run<Record<string, unknown>>('crm.booking.move', input.payload);
    ctx.audit({ approved_command: 'crm.booking.move' });
    return moved;
  },
});

export const bookingCancelApproved = defineCommand({
  name: 'crm.booking.cancel_approved',
  input: zApprovedCall(bookingCancel.input),
  risk: 'R2',
  sideEffect: 'external',
  access: 'proposal',
  proposalKind: 'crm.booking_cancel',
  mcp: { scope: 'ludy.engage.write', mode: 'proposal' },
  target: (input) => ({ type: 'crm.booking', id: input.payload.bookingId }),
  handler: async (ctx, input) => {
    requireApprover(ctx);
    const cancelled = await ctx.run<Record<string, unknown>>('crm.booking.cancel', input.payload);
    ctx.audit({ approved_command: 'crm.booking.cancel' });
    return cancelled;
  },
});

export const crmEngageProposalCommands = [quoteSendApproved, bookingMoveApproved, bookingCancelApproved];
