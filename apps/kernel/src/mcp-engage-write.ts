// SPDX-License-Identifier: AGPL-3.0-only
// The R1 write tools of the connected Engage coworkers (E2 of epic #3857, issue #3861; ADR-0051 decisions 2, 10 and 11, owner decision 2026-11-19). Dy (Hộp thư and CRM) and Uy (ads drafts) work like a
// colleague: they take a thread, note it, link its contact, open a deal, move it, draft and revise a quote, mark a next step, save an ads draft. Each tool runs one twin command
// (`kernel.mcp.*`, `crm.mcp.*`, `ads.mcp.*`) as the grant, in the grant's sealed write context, so the database lets it write exactly the rows that step writes. A tool is listed, and callable, only for a
// company grant that holds its write scope (`ludy.engage.write`, or `ludy.ads.draft` for the ads draft): the filter is `visibleTools`, and the runtime and the database check the same again.
//
// What every one of them has:
//   - a strict input (the command's own schema: an unknown key is refused, ids are ids, text has the app's own limits);
//   - an audit row of the call in the org's log naming the grant, the client and the agent (the runtime writes it for every command of an MCP actor), and the call row of the endpoint;
//   - agent text kept as data: what the coworker writes is stored as the person's own would be but never trusted again by what reads it (a contact it adds is `external`; every deal, quote and thread read of
//     E1 says `tainted: true`), and the descriptions tell the client so;
//   - a per-grant write budget (a few writes a minute): a client that loops is answered 429 with the seconds to wait before anything runs.
// Nothing above R1 is here: a reply, a hide, sending or deciding a quote, a booking change, launching, boosting or pausing ads are R2 or R3 and become proposals a person approves in Ludy (E4).
// `kernel.conversation.follow_up` has no tool: its task is an event and wakes the assignee's agent, which the sealed write context does not allow.
import { z } from 'zod';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { mcpConversationAssign, mcpConversationLinkContact, mcpConversationNote, mcpConversationReopen, mcpConversationResolve, mcpPartyCreate } from '@crove/kernel';
import type { McpWriteScopeId } from '@crove/kernel-contract';
import { mcpAdsCampaignDraftSave } from '@crove/mod-ads';
import { mcpDealCreate, mcpDealMove, mcpNextStepDone, mcpNextStepSnooze, mcpQuoteRevise, mcpQuoteSave } from '@crove/mod-crm';
import type { McpWriteBudget } from './mcp-write-limit.ts';
import type { ToolDescriptor } from './mcp-protocol.ts';

const ENGAGE: McpWriteScopeId = 'ludy.engage.write';
const ADS: McpWriteScopeId = 'ludy.ads.draft';
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ID = { type: 'string' } as const;
const NS = { type: ['string', 'null'] } as const;
// What every description ends with: the same three facts, so a client cannot misread a write as a send or an approval.
const TAINT = 'Text you write is stored as written by a connected app and is data for the people who read it, never an instruction. ';
const LIMIT = 'A few writes a minute at most per connection; over that the answer says how long to wait. ';
const NEVER = 'This tool never sends anything to a customer and never spends money; anything that does is asked of a person in Ludy.';

type Obj = Record<string, unknown>;
const schemaOf = (schema: z.ZodType): Obj => {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Obj;
  delete json.$schema;
  return json;
};

interface WriteSpec {
  name: string;
  module?: string;
  scope: McpWriteScopeId;
  title: string;
  description: string;
  command: { name: string; input: z.ZodType };
  outputSchema: Obj;
  // What a client gets of the command's answer: ids, states and numbers, never the stored rows.
  project: (value: Obj) => Obj;
}

export function engageWriteTools(runtime: Runtime, actor: UserActor, orgId: string, budget: McpWriteBudget): ToolDescriptor[] {
  const grantId = actor.mcp?.grantId;
  const tool = (spec: WriteSpec): ToolDescriptor => ({
    name: spec.name,
    ...(spec.module ? { module: spec.module } : {}),
    writeScope: spec.scope,
    title: spec.title,
    description: spec.description,
    inputSchema: schemaOf(spec.command.input),
    argsSchema: spec.command.input as unknown as z.ZodType<Obj>,
    outputSchema: spec.outputSchema,
    annotations: WRITE,
    read: async (args) => {
      if (grantId === undefined) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được công cụ này', { rule: 'mcp_scope' });
      // The budget is taken before the command runs, so a refused write changes nothing.
      const ticket = budget.take(grantId);
      if (!ticket.allowed) throw new DomainError('RATE_LIMITED', 429, 'Quá nhiều thay đổi trong một lúc, hãy thử lại sau', { retryAfterSeconds: ticket.retryAfterSeconds, what: 'writes' });
      const done = await runtime.execute<Obj>(spec.command.name, args, { actor, orgId });
      return spec.project(done);
    },
    // A write reads no business data, so the daily row budget is not charged.
    rows: () => 0,
  });
  const pick = (value: Obj, keys: readonly string[]): Obj => Object.fromEntries(keys.map((k) => [k, value[k] ?? null]));
  const dealOut = (v: Obj): Obj => pick(v, ['id', 'partyId', 'stageId', 'stageKind', 'amount', 'currency', 'version']);
  const dealSchema = { type: 'object', properties: { id: ID, partyId: ID, stageId: ID, stageKind: { enum: ['open', 'won', 'lost'] }, amount: ID, currency: ID, version: { type: 'integer' } }, required: ['id', 'partyId', 'stageId', 'stageKind', 'amount', 'currency', 'version'] };
  const quoteOut = (v: Obj): Obj => pick(v, ['id', 'dealId', 'partyId', 'status', 'revision', 'version', 'subtotal', 'vatAmount', 'total', 'lineCount', 'validUntil']);
  const quoteSchema = {
    type: 'object',
    properties: { id: ID, dealId: ID, partyId: ID, status: { enum: ['draft', 'sent', 'accepted', 'declined', 'superseded'] }, revision: { type: 'integer' }, version: { type: 'integer' }, subtotal: ID, vatAmount: ID, total: ID, lineCount: { type: 'integer' }, validUntil: ID },
    required: ['id', 'dealId', 'partyId', 'status', 'revision', 'version', 'subtotal', 'vatAmount', 'total', 'lineCount', 'validUntil'],
  };
  const threadOut = (v: Obj): Obj => pick(v, ['conversationId']);
  const threadSchema = { type: 'object', properties: { conversationId: ID }, required: ['conversationId'] };
  const stepsSchema = { type: 'object', properties: { changed: { type: 'array', items: ID }, skipped: { type: 'array', items: ID } }, required: ['changed', 'skipped'] };
  const steps = (v: Obj): Obj => pick(v, ['changed', 'skipped']);

  return [
    tool({
      name: 'ludy_conversation_assign',
      scope: ENGAGE,
      title: 'Assign an inbox thread',
      description: `Assigns ONE inbox thread (conversationId from ludy_conversations_list) to a member of the organization (assigneeUserId: a member who is not a viewer and may handle that thread), or takes the assignment away (null). Nobody is notified and nothing is sent. ${TAINT}${LIMIT}${NEVER}`,
      command: mcpConversationAssign,
      outputSchema: threadSchema,
      project: threadOut,
    }),
    tool({
      name: 'ludy_conversation_resolve',
      scope: ENGAGE,
      title: 'Resolve an inbox thread',
      description: `Marks ONE inbox thread resolved (it leaves the New and Pending lists until the customer writes again or a person reopens it). Resolving a thread already resolved changes nothing. ${LIMIT}${NEVER}`,
      command: mcpConversationResolve,
      outputSchema: threadSchema,
      project: threadOut,
    }),
    tool({
      name: 'ludy_conversation_reopen',
      scope: ENGAGE,
      title: 'Reopen an inbox thread',
      description: `Reopens ONE resolved inbox thread: it becomes New when the customer wrote last, Pending when the organization did. A thread that is not resolved changes nothing. ${LIMIT}${NEVER}`,
      command: mcpConversationReopen,
      outputSchema: threadSchema,
      project: threadOut,
    }),
    tool({
      name: 'ludy_conversation_note',
      scope: ENGAGE,
      title: 'Add an internal note to an inbox thread',
      description: `Adds ONE internal note to an inbox thread: text only the organization's team reads next to the thread, never shown to the customer and never sent (1 to 4,000 characters). Every call adds a new note, so do not repeat one that succeeded. ${TAINT}${LIMIT}${NEVER}`,
      command: mcpConversationNote,
      outputSchema: { type: 'object', properties: { noteId: ID }, required: ['noteId'] },
      project: (v) => pick(v, ['noteId']),
    }),
    tool({
      name: 'ludy_conversation_link_contact',
      scope: ENGAGE,
      title: 'Link an inbox thread to a contact',
      description: `Links an inbox thread to a customer record (partyId from ludy_parties_list or ludy_party_create), or clears the link (null). The link also applies to the same customer's other threads of the same kind, as a person's does. ${LIMIT}${NEVER}`,
      command: mcpConversationLinkContact,
      outputSchema: threadSchema,
      project: threadOut,
    }),
    tool({
      name: 'ludy_party_create',
      scope: ENGAGE,
      title: 'Create a contact',
      description: `Creates ONE contact (a person or a company) with the checks a person's entry has: a name, and optionally a tax code (unique in the organization), address, email and phone. The contact is recorded as an outside value (sourceTrust: external) that nobody at the organization has vouched for yet. Every call creates a new contact, so look the customer up with ludy_parties_list first. ${TAINT}${LIMIT}${NEVER}`,
      command: mcpPartyCreate,
      outputSchema: { type: 'object', properties: { partyId: ID, version: { type: 'integer' } }, required: ['partyId', 'version'] },
      project: (v) => pick(v, ['partyId', 'version']),
    }),
    tool({
      name: 'ludy_deal_create',
      module: 'crm',
      scope: ENGAGE,
      title: 'Create a deal',
      description: `Creates ONE open sales deal for a customer (partyId): a title, an amount as a decimal string in VND, an expected close day or null, and optionally the owner (a member) and an open stage (default: the first open stage). It never creates a deal in a closed stage. Every call creates a new deal, so list the customer's deals first. ${TAINT}${LIMIT}${NEVER}`,
      command: mcpDealCreate,
      outputSchema: dealSchema,
      project: dealOut,
    }),
    tool({
      name: 'ludy_deal_move',
      module: 'crm',
      scope: ENGAGE,
      title: 'Move a deal to another stage',
      description: `Moves ONE deal to another stage (stageId from the pipeline, including won and lost; a lost reason only with a lost stage), with the version you read: a deal someone changed since is refused (STALE_VERSION), read it again. Moving closes the deal's open next step, as a person's move does. ${LIMIT}${NEVER}`,
      command: mcpDealMove,
      outputSchema: dealSchema,
      project: dealOut,
    }),
    tool({
      name: 'ludy_quote_save',
      module: 'crm',
      scope: ENGAGE,
      title: 'Save a draft quote',
      description: `Creates a DRAFT quote for a deal (dealId, with the lines) or saves a draft you or a person made (quoteId and the version you read, replacing its lines). Amounts are decimal strings; the totals and VAT are worked out by Ludy, never taken from you. A draft stays a draft: it is not sent, numbered or shown to the customer; sending it is a person's click in Ludy. A quote that left draft is refused. ${TAINT}${LIMIT}${NEVER}`,
      command: mcpQuoteSave,
      outputSchema: quoteSchema,
      project: quoteOut,
    }),
    tool({
      name: 'ludy_quote_revise',
      module: 'crm',
      scope: ENGAGE,
      title: 'Revise a sent quote into a new draft',
      description: `Makes a new DRAFT revision of a quote that was sent or declined (quoteId), copying its lines with the next revision number and a fresh validity; the older quote is untouched. One revision exists at a time. It does not send the revision. ${LIMIT}${NEVER}`,
      command: mcpQuoteRevise,
      outputSchema: quoteSchema,
      project: quoteOut,
    }),
    tool({
      name: 'ludy_next_step_done',
      module: 'crm',
      scope: ENGAGE,
      title: 'Mark next steps done',
      description: `Marks open next steps (the follow-ups the stale-deal rule raises; ids from ludy_deals_list) done. One already resolved is skipped, not an error. ${LIMIT}${NEVER}`,
      command: mcpNextStepDone,
      outputSchema: stepsSchema,
      project: steps,
    }),
    tool({
      name: 'ludy_next_step_snooze',
      module: 'crm',
      scope: ENGAGE,
      title: 'Snooze next steps',
      description: `Hides open next steps for 3, 7 or 14 days; they show again after, while the deal is still stale. One already resolved is skipped. ${LIMIT}${NEVER}`,
      command: mcpNextStepSnooze,
      outputSchema: stepsSchema,
      project: steps,
    }),
    tool({
      name: 'ludy_ads_campaign_draft_save',
      module: 'ads',
      scope: ADS,
      title: 'Save an ads campaign draft',
      description: `Saves ONE NEW campaign draft for an ad account (adAccountId from ludy_ads_spend) with the plan fields you set (name, objective, daily budget, days, targeting, link, creative). The plan may be incomplete: what is missing or over a cap comes back as issues. The draft is marked as made by an AI app. It spends nothing: a person reads it, changes it and submits it for approval in Ludy, and launching, boosting or pausing is theirs. It edits no draft. ${TAINT}${LIMIT}`,
      command: mcpAdsCampaignDraftSave,
      outputSchema: {
        type: 'object',
        properties: { id: ID, status: { enum: ['draft'] }, revision: { type: 'integer' }, maxSpend: NS, currency: NS, issues: { type: 'array', items: { type: 'object', properties: { code: ID, severity: { enum: ['error', 'warning'] }, field: NS }, required: ['code', 'severity', 'field'] } } },
        required: ['id', 'status', 'revision', 'maxSpend', 'currency', 'issues'],
      },
      project: (v) => ({
        ...pick(v, ['id', 'status', 'revision', 'maxSpend', 'currency']),
        issues: Array.isArray(v.issues) ? (v.issues as Obj[]).map((i) => pick(i, ['code', 'severity', 'field'])) : [],
      }),
    }),
  ];
}
