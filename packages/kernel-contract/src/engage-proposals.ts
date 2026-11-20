// SPDX-License-Identifier: AGPL-3.0-only
// What an AI coworker (Dy, Uy) proposes in the Engage lines and a person approves in Ludy (epic #3857, E4 #3863; ADR-0051 decision 10, owner decision 2026-11-19: "Cho làm, việc lớn chờ duyệt").
//
// A command above R1 never runs for an MCP grant: the call becomes a pending proposal (kernel.mcp.propose). The commands a person runs from a screen run by role, so each action has a thin
// PROPOSAL-ONLY twin named `<command>_approved`: it takes the original command's own strict input as its payload, runs only from an approved proposal, and then runs the original command as the
// approver, so every check the original has (the reply window, caps, the kill switch, the app gate) runs at the approval, on what stands then. The twin and the original never write differently.
//
import { z } from 'zod';

// What every twin takes: the payload the proposal stored (the original command's own strict input), and what the approver chose at the approval, never a client (the runtime refuses an MCP call that sets it).
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An id a client wrote in capitals is the same id (z.uuid() accepts it): the payload is stored with every id in lower case, the form the database compares (the erasure of a thread finds the proposals that name it by it).
function lowerUuids(value: unknown): unknown {
  if (typeof value === 'string') return UUID_TEXT.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(lowerUuids);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, lowerUuids(v)]));
  return value;
}
export const zApprovedCall = <T extends z.ZodType>(payload: T) => z.strictObject({ payload: payload.transform((v) => lowerUuids(v) as z.output<T>), acceptFailedChecks: z.boolean().optional() });

// The rest of this file is names and kinds. The table is read by the kernel (the approval policy, the catalog test), the modules (each declares its twin) and the app (which Inbox card a kind gets).

// The write scopes a grant needs to ask for these (MCP_WRITE_SCOPES in the runtime): the Inbox and the CRM, Social and the Engage ads commands.
export const ENGAGE_PROPOSAL_SCOPES = ['ludy.engage.write', 'ludy.ads.draft'] as const;
export type EngageProposalScope = (typeof ENGAGE_PROPOSAL_SCOPES)[number];

export interface EngageProposalSpec {
  // The proposal-only command (its name, and the `command` column of the proposal).
  command: string;
  // The command it runs as the approver once approved.
  wraps: string;
  // The kind of its proposals: the Inbox card. <module>.<name>, in the command's own module.
  kind: string;
  scope: EngageProposalScope;
}

export const ENGAGE_PROPOSALS: readonly EngageProposalSpec[] = Object.freeze([
  { command: 'kernel.conversation.reply_approved', wraps: 'kernel.conversation.reply', kind: 'kernel.conversation_reply', scope: 'ludy.engage.write' },
  { command: 'kernel.conversation.reply_privately_approved', wraps: 'kernel.conversation.reply_privately', kind: 'kernel.conversation_reply_privately', scope: 'ludy.engage.write' },
  { command: 'kernel.conversation.hide_approved', wraps: 'kernel.conversation.hide', kind: 'kernel.conversation_hide', scope: 'ludy.engage.write' },
  { command: 'crm.quote.send_approved', wraps: 'crm.quote.send', kind: 'crm.quote_send', scope: 'ludy.engage.write' },
  { command: 'crm.booking.move_approved', wraps: 'crm.booking.move', kind: 'crm.booking_move', scope: 'ludy.engage.write' },
  { command: 'crm.booking.cancel_approved', wraps: 'crm.booking.cancel', kind: 'crm.booking_cancel', scope: 'ludy.engage.write' },
  { command: 'social.post.submit_approved', wraps: 'social.post.submit', kind: 'social.post_submit', scope: 'ludy.engage.write' },
  { command: 'social.variant.schedule_approved', wraps: 'social.variant.schedule', kind: 'social.variant_schedule', scope: 'ludy.engage.write' },
  { command: 'ads.launch.stop_approved', wraps: 'ads.launch.stop', kind: 'ads.launch_stop', scope: 'ludy.ads.draft' },
  { command: 'ads.pause_all_approved', wraps: 'ads.pause_all', kind: 'ads.pause_all', scope: 'ludy.ads.draft' },
  { command: 'ads.object.pause_approved', wraps: 'ads.object.pause', kind: 'ads.object_pause', scope: 'ludy.ads.draft' },
  { command: 'ads.object.archive_approved', wraps: 'ads.object.archive', kind: 'ads.object_archive', scope: 'ludy.ads.draft' },
  { command: 'ads.budget.lower_approved', wraps: 'ads.budget.lower', kind: 'ads.budget_lower', scope: 'ludy.ads.draft' },
  { command: 'ads.schedule.shorten_approved', wraps: 'ads.schedule.shorten', kind: 'ads.schedule_shorten', scope: 'ludy.ads.draft' },
]);

const BY_COMMAND = new Map(ENGAGE_PROPOSALS.map((p) => [p.command, p]));
const BY_KIND = new Map(ENGAGE_PROPOSALS.map((p) => [p.kind, p]));

export const engageProposalOf = (command: string): EngageProposalSpec | undefined => BY_COMMAND.get(command);
export const engageProposalOfKind = (kind: string): EngageProposalSpec | undefined => BY_KIND.get(kind);
export const isEngageProposalKind = (kind: string): boolean => BY_KIND.has(kind);
