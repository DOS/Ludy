// SPDX-License-Identifier: AGPL-3.0-only
// The CRM commands an MCP grant that holds `ludy.engage.write` may run (epic #3857, E2, issue #3861; ADR-0051 decisions 2, 10 and 11): open a deal, move it between stages, save or revise a draft quote,
// mark a next step done or snooze it. Each is a twin of the app's own command, with its input, handler and checks, declared for owners and admins alone (what `register()` opens `mcp` to) and for the engage
// scope; it runs in the grant's sealed write context, where the database lets it write exactly the rows its step writes (crove_kernel.mcp_write_row_ok): a deal and its stages, a draft quote and its lines,
// a next step's status. Not here, because they leave Ludy or move money (R2 and R3, proposals in E4): sending a quote, accepting or declining one, a payment, an invoice.
import { defineCommand, type CommandDef } from '@crove/kernel-runtime';
import { dealCreate, dealMove } from './deals.ts';
import { nextStepDone, nextStepSnooze } from './next-steps.ts';
import { quoteRevise, quoteSave } from './quotes.ts';

const ADMINS = ['owner', 'admin'] as const;
const SCOPE = 'ludy.engage.write' as const;

function twin<I, O>(name: string, base: CommandDef<I, O>): CommandDef<I, O> {
  return defineCommand({ name, input: base.input, risk: 'R1', sideEffect: 'internal', access: ADMINS, mcp: { scope: SCOPE }, ...(base.target ? { target: base.target } : {}), handler: base.handler });
}

export const mcpDealCreate = twin('crm.mcp.deal_create', dealCreate);
export const mcpDealMove = twin('crm.mcp.deal_move', dealMove);
export const mcpQuoteSave = twin('crm.mcp.quote_save', quoteSave);
export const mcpQuoteRevise = twin('crm.mcp.quote_revise', quoteRevise);
export const mcpNextStepDone = twin('crm.mcp.next_step_done', nextStepDone);
export const mcpNextStepSnooze = twin('crm.mcp.next_step_snooze', nextStepSnooze);

export const mcpCrmWriteCommands = [mcpDealCreate, mcpDealMove, mcpQuoteSave, mcpQuoteRevise, mcpNextStepDone, mcpNextStepSnooze];
