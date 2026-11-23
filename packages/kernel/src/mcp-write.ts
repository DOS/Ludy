// SPDX-License-Identifier: AGPL-3.0-only
// The Hộp thư and contact commands an MCP grant that holds `ludy.engage.write` may run (epic #3857, E2, issue #3861; ADR-0051 decisions 2, 10 and 11, owner decision 2026-11-19): the coworker Dy does the
// routine steps a person does, as R1 commands in its own sealed write context (the migration 20270122190000). Each is a twin of the app's own command, not the command itself: `register()` opens `mcp`
// only to a command whose access list is owner and admin alone, and the app's own commands are used by members. A twin keeps the original's input schema (strict: an unknown key is refused), its
// handler and its checks (a thread the grant may not read is not found, an assignee must be a member who may handle it), and runs in a sealed context where the database lets it write exactly the
// rows its step writes (ludy_kernel.mcp_write_row_ok) and nothing else. It reaches the same audit trail as a person's click, which also names the grant, the client and the agent.
// Not here: `kernel.conversation.follow_up` (a task for the team): its task is an event (an outbox row) and wakes the assignee's agent, which the sealed context does not allow, so a coworker asks for it as a
// proposal a person approves (`kernel.conversation.follow_up_approved`, #4148). A reply, a hide and anything that leaves Ludy is R2 or R3 and becomes a proposal (E4).
import { defineCommand, type CommandDef } from '@ludy/kernel-runtime';
import {
  conversationAssign,
  conversationLinkContact,
  conversationNoteAdd,
  conversationReopen,
  conversationResolve,
} from './conversations.ts';
import { createPartyAs } from './parties.ts';
import { zPartyCreate } from '@ludy/kernel-contract';

const ADMINS = ['owner', 'admin'] as const;
const SCOPE = 'ludy.engage.write' as const;

// The twin of a command: the same input, handler and target, for the roles a company grant has, declared for the engage scope.
function twin<I, O>(name: string, base: CommandDef<I, O>): CommandDef<I, O> {
  return defineCommand({ name, input: base.input, risk: 'R1', sideEffect: 'internal', access: ADMINS, mcp: { scope: SCOPE }, ...(base.target ? { target: base.target } : {}), handler: base.handler });
}

export const mcpConversationAssign = twin('kernel.mcp.conversation_assign', conversationAssign);
export const mcpConversationResolve = twin('kernel.mcp.conversation_resolve', conversationResolve);
export const mcpConversationReopen = twin('kernel.mcp.conversation_reopen', conversationReopen);
export const mcpConversationNote = twin('kernel.mcp.conversation_note', conversationNoteAdd);
export const mcpConversationLinkContact = twin('kernel.mcp.conversation_link_contact', conversationLinkContact);

// A contact the agent adds: the same checks as a person's (the tax code is unique, the fields are normalized), stored as `external`, a value nobody at the company vouched for.
export const mcpPartyCreate = defineCommand({
  name: 'kernel.mcp.party_create',
  input: zPartyCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  mcp: { scope: SCOPE },
  handler: (ctx, input) => createPartyAs(ctx, input, 'external'),
});

export const mcpEngageWriteCommands = [mcpConversationAssign, mcpConversationResolve, mcpConversationReopen, mcpConversationNote, mcpConversationLinkContact, mcpPartyCreate];
