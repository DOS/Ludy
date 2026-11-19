// SPDX-License-Identifier: AGPL-3.0-only
// The tools an AI app uses to ASK for an Engage step that needs a person (epic #3857, E4 #3863; ADR-0051 decision 10, owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt"): a reply to a customer, a
// private reply, hiding a comment, sending a quote, moving or cancelling a booking, sending a post to review, scheduling it, and the ads that only stop or reduce spend. Each tool runs the proposal-only
// twin of its command (`<command>_approved`) as the grant: the runtime never runs it, it runs kernel.mcp.propose in its place, which leaves ONE pending proposal marked tainted and naming the grant, the
// client and its host. A person approves it in Ludy (the Inbox); only then does the original command run, as that person, with every check it has (the reply window, the platform's limits, the caps, the kill
// switch). The tool answers `{ proposalId, status: 'pending' }`: asked, not done. The arguments are the original command's own strict input, checked here before anything runs.
import { z } from 'zod';
import type { Runtime, UserActor } from '@crove/kernel-runtime';
import { conversationProposalCommands } from '@crove/kernel';
import type { McpWriteScopeId } from '@crove/kernel-contract';
import { adsEngageProposalCommands } from '@crove/mod-ads';
import { crmEngageProposalCommands } from '@crove/mod-crm';
import { postSubmitApproved, variantScheduleApproved } from '@crove/mod-social';
import type { ToolDescriptor } from './mcp-protocol.ts';

const PROPOSED = {
  type: 'object',
  properties: { proposalId: { type: 'string' }, status: { enum: ['pending'] } },
  required: ['proposalId', 'status'],
};

const HOW =
  ' It does NOT do this: it leaves ONE proposal that waits in Ludy for a person (an owner or an admin) to approve or reject, marked as an AI\'s and not trusted, and answers { proposalId, status: "pending" }. ' +
  'Only an approval makes it happen, once, and the usual checks run then, so it can still be refused; read the thread or the record again before you ask. A change is a new proposal, not an edit. A person sees what you send exactly as you wrote it. ' +
  'At most 20 proposals of this connection wait at once.';

interface ToolSpec {
  command: string;
  tool: string;
  title: string;
  description: string;
  module?: string;
}

// Eight of the fourteen twins have a tool. The other six need an id an AI app cannot read yet: a quote's `version` (the read of a quote leaves versions out, E1 #3860) and the id of a live ad launch (no read lists
// launches). Their twins are declared and approved like the rest; each gets its tool with the read it needs (follow-up), so no tool is listed that a client cannot use.
const NO_TOOL_YET: readonly string[] = [
  'crm.quote.send_approved',
  'ads.launch.stop_approved',
  'ads.object.pause_approved',
  'ads.object.archive_approved',
  'ads.budget.lower_approved',
  'ads.schedule.shorten_approved',
];
export const ENGAGE_PROPOSAL_COMMANDS_WITHOUT_TOOL = NO_TOOL_YET;

const SPECS: readonly ToolSpec[] = [
  {
    command: 'kernel.conversation.reply_approved',
    tool: 'ludy_conversation_reply',
    title: 'Propose a reply to a customer',
    description:
      'Proposes a reply to a customer in an inbox thread (conversationId from ludy_conversations_list; body: the exact text the customer will read; lastSeenSeq: the number of the last message you read, so a newer message refuses the reply; draftId and savedReplyId are optional). Customer-facing: write it as the organization would, in the customer\'s language, with no placeholders left. The platform\'s reply window and length limits apply when a person approves.' +
      HOW,
  },
  {
    command: 'kernel.conversation.reply_privately_approved',
    tool: 'ludy_conversation_reply_privately',
    title: 'Propose a private reply to a comment',
    description:
      'Proposes a private Messenger reply to a customer\'s comment on a Facebook Page post (messageId: the id of the comment message from ludy_conversation; body: the exact text). Allowed by the platform only within seven days of the comment.' + HOW,
  },
  {
    command: 'kernel.conversation.hide_approved',
    tool: 'ludy_conversation_hide',
    title: 'Propose hiding or showing a comment',
    description: 'Proposes hiding (hidden: true) or showing again (hidden: false) a customer\'s comment on the platform (messageId: the id of the comment message from ludy_conversation).' + HOW,
  },
  {
    command: 'crm.booking.move_approved',
    tool: 'ludy_booking_move',
    title: 'Propose moving a booking',
    description: 'Proposes moving a confirmed booking to a new start time (bookingId from ludy_bookings_list; startsAt: an ISO time with an offset). The guest is mailed the new time when a person approves; a time already taken or outside working hours refuses it.' + HOW,
    module: 'crm',
  },
  {
    command: 'crm.booking.cancel_approved',
    tool: 'ludy_booking_cancel',
    title: 'Propose cancelling a booking',
    description: 'Proposes cancelling a confirmed booking that has not started (bookingId from ludy_bookings_list). The guest is mailed the cancellation when a person approves.' + HOW,
    module: 'crm',
  },
  {
    command: 'social.post.submit_approved',
    tool: 'ludy_post_submit',
    title: 'Propose sending a post to review',
    description:
      'Proposes sending a Social post (postId from ludy_social_posts_list or your own draft) to review, for all its channels that can go or only the variantIds you name. A channel that does not fit its platform, or a blocked word, refuses it when a person approves.' + HOW,
    module: 'social',
  },
  {
    command: 'social.variant.schedule_approved',
    tool: 'ludy_variant_schedule',
    title: 'Propose scheduling a post',
    description:
      'Proposes scheduling the approved channels of a post (postId; optional variantIds) at a time (`at`, an ISO time with an offset), in the next free slot of the channel\'s queue (queue: true), at one slot (slotAt) or at a time per channel (times). Only approved channels can be scheduled; the queue\'s slots are judged when a person approves.' +
      HOW,
    module: 'social',
  },
  {
    command: 'ads.pause_all_approved',
    tool: 'ludy_ads_pause_all',
    title: 'Propose stopping all ads',
    description: 'Proposes the kill switch: blocks new ad launches for the organization, cancels the ones not started and stops the ones running. It only ever reduces spend; a person must open launches again to run ads.' + HOW,
    module: 'ads',
  },
];

const TWINS = new Map<string, { input: unknown }>([...conversationProposalCommands, ...crmEngageProposalCommands, postSubmitApproved, variantScheduleApproved, ...adsEngageProposalCommands].map((c) => [c.name, c]));

// The JSON Schema a tool's arguments are advertised with, from the same zod schema that checks them.
const schemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
};

// The scope of a twin is the one its definition declares (the catalog and the invariants keep the three equal): the tool is listed, and callable, only for a company grant that holds it.
const scopeOf = (command: string): McpWriteScopeId => (command.startsWith('ads.') ? 'ludy.ads.draft' : 'ludy.engage.write');

// The argument schema and its JSON Schema, once per tool: the list is built on every call, the schemas never change.
const SCHEMAS = new Map<string, { payload: z.ZodType<Record<string, unknown>>; inputSchema: Record<string, unknown> }>();
function schemasOf(spec: ToolSpec) {
  const known = SCHEMAS.get(spec.command);
  if (known) return known;
  const twin = TWINS.get(spec.command);
  if (!twin) throw new Error(`engage proposal tool ${spec.tool}: ${spec.command} is not registered`);
  const payload = (twin.input as z.ZodObject<{ payload: z.ZodType<Record<string, unknown>> }>).shape.payload;
  const made = { payload, inputSchema: schemaOf(payload) };
  SCHEMAS.set(spec.command, made);
  return made;
}

export function engageProposalTools(runtime: Runtime, actor: UserActor, orgId: string): ToolDescriptor[] {
  return SPECS.map((spec): ToolDescriptor => {
    const { payload, inputSchema } = schemasOf(spec);
    return {
      name: spec.tool,
      ...(spec.module ? { module: spec.module } : {}),
      writeScope: scopeOf(spec.command),
      title: spec.title,
      description: spec.description,
      inputSchema,
      argsSchema: payload,
      outputSchema: PROPOSED,
      // Not read only; it changes nothing by itself (a proposal waits), so it is not destructive; a second call is a second proposal, so not idempotent.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      read: async (args) => await runtime.execute<Record<string, unknown>>(spec.command, { payload: args }, { actor, orgId }),
      // A proposal reads no business data, so the daily row budget is not charged.
      rows: () => 0,
    };
  });
}
