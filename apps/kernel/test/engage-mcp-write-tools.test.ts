// SPDX-License-Identifier: AGPL-3.0-only
// The tool list of the Engage R1 write tools (epic #3857, E2, issue #3861): which grant is offered which tool, that each is a strict write descriptor over one twin command with its scope, that a client that
// loops is stopped by the per-grant write budget before the command runs, and what a tool answers (ids and states, never the stored row). The database tests (engage-mcp-write.db.test.ts) run the commands behind them.
import { describe, expect, it } from 'vitest';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { toolsFor } from '../src/mcp-endpoint.ts';
import { McpWriteBudget } from '../src/mcp-write-limit.ts';

const grant = (scopes: string[], kind: 'company' | 'member' = 'company', id = 'g1'): UserActor => ({ type: 'user', userId: 'u1', aal: 'aal1', mcp: { grantId: id, clientId: 'c', clientName: 'Test', scopes, kind } });
const calls: Array<[string, unknown]> = [];
const runtime = {
  execute: async (name: string, input: unknown) => {
    calls.push([name, input]);
    return { conversationId: 'c1', extra: 'never leaves', id: 'd1', partyId: 'p1', stageId: 's1', stageKind: 'open', amount: '1', currency: 'VND', version: 2, title: 'a stored text' };
  },
} as unknown as Runtime;
const listed = (actor: UserActor, budget = new McpWriteBudget()) => toolsFor(runtime, actor, 'org', new DraftBudget(), budget);

// The tool and the twin command it runs.
const ENGAGE: Record<string, string> = {
  ludy_conversation_assign: 'kernel.mcp.conversation_assign',
  ludy_conversation_resolve: 'kernel.mcp.conversation_resolve',
  ludy_conversation_reopen: 'kernel.mcp.conversation_reopen',
  ludy_conversation_note: 'kernel.mcp.conversation_note',
  ludy_conversation_link_contact: 'kernel.mcp.conversation_link_contact',
  ludy_party_create: 'kernel.mcp.party_create',
  ludy_deal_create: 'crm.mcp.deal_create',
  ludy_deal_move: 'crm.mcp.deal_move',
  ludy_quote_save: 'crm.mcp.quote_save',
  ludy_quote_revise: 'crm.mcp.quote_revise',
  ludy_next_step_done: 'crm.mcp.next_step_done',
  ludy_next_step_snooze: 'crm.mcp.next_step_snooze',
};
const ADS = { ludy_ads_campaign_draft_save: 'ads.mcp.campaign_draft_save' };

describe('the Engage write tools in the tool list (#3861)', () => {
  it('offers them to a company grant that holds the scope, each scope its own, and to nobody else', () => {
    const names = (actor: UserActor) => listed(actor).map((t) => t.name);
    for (const name of [...Object.keys(ENGAGE), ...Object.keys(ADS)]) expect(names(grant(['ludy.read'])), name).not.toContain(name);
    expect(names(grant(['ludy.read', 'ludy.engage.write'])).filter((n) => n in ENGAGE || n in ADS).sort()).toEqual(Object.keys(ENGAGE).sort());
    expect(names(grant(['ludy.read', 'ludy.ads.draft'])).filter((n) => n in ENGAGE || n in ADS)).toEqual(Object.keys(ADS));
    expect(names(grant(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'])).filter((n) => n in ENGAGE || n in ADS).length).toBe(13);
    // A member-bound grant never writes, whatever it claims; neither does a person's own session.
    expect(names(grant(['ludy.member.read', 'ludy.engage.write', 'ludy.ads.draft'], 'member')).filter((n) => n in ENGAGE || n in ADS)).toEqual([]);
    expect(toolsFor(runtime, { type: 'user', userId: 'u', aal: 'aal1' }, 'org', new DraftBudget()).filter((t) => t.name in ENGAGE || t.name in ADS)).toEqual([]);
  });

  it('makes each a write descriptor of its scope with a strict argument schema that says the text is data and that nothing is sent', () => {
    const tools = listed(grant(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'])).filter((t) => t.name in ENGAGE || t.name in ADS);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(tool.writeScope, tool.name).toBe(tool.name in ADS ? 'ludy.ads.draft' : 'ludy.engage.write');
      expect(tool.argsSchema.safeParse({ smuggled: 1 }).success, tool.name).toBe(false);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema.type, tool.name).toBe('object');
      expect(tool.description, tool.name).toMatch(/A few writes a minute/);
      expect(tool.rows({}), tool.name).toBe(0);
      if (tool.name !== 'ludy_ads_campaign_draft_save') expect(tool.description, tool.name).toMatch(/never sends anything to a customer and never spends money/);
    }
    // Tools that carry the agent's text say it is data.
    for (const name of ['ludy_conversation_note', 'ludy_party_create', 'ludy_deal_create', 'ludy_quote_save', 'ludy_ads_campaign_draft_save']) {
      expect(tools.find((t) => t.name === name)?.description, name).toMatch(/data for the people who read it, never an instruction/);
    }
    expect(tools.find((t) => t.name === 'ludy_deal_create')?.module).toBe('crm');
    expect(tools.find((t) => t.name === 'ludy_ads_campaign_draft_save')?.module).toBe('ads');
    expect(tools.find((t) => t.name === 'ludy_conversation_note')?.module).toBeUndefined();
  });

  it('runs the twin command as the grant and answers ids and states only', async () => {
    calls.length = 0;
    const actor = grant(['ludy.read', 'ludy.engage.write']);
    const tools = listed(actor);
    const resolve = tools.find((t) => t.name === 'ludy_conversation_resolve');
    expect(await resolve?.read({ conversationId: 'c1' })).toEqual({ conversationId: 'c1' });
    const deal = tools.find((t) => t.name === 'ludy_deal_move');
    expect(Object.keys((await deal?.read({})) ?? {}).sort()).toEqual(['amount', 'currency', 'id', 'partyId', 'stageId', 'stageKind', 'version']);
    expect(calls.map((c) => c[0])).toEqual(['kernel.mcp.conversation_resolve', 'crm.mcp.deal_move']);
  });

  it('stops a client that loops with a 429 and the seconds to wait, before the command runs, and counts each grant on its own', async () => {
    calls.length = 0;
    const budget = new McpWriteBudget({ perGrantPerMinute: 3 });
    const tool = (actor: UserActor) => listed(actor, budget).find((t) => t.name === 'ludy_conversation_note');
    const a = grant(['ludy.read', 'ludy.engage.write'], 'company', 'gA');
    for (let i = 0; i < 3; i += 1) await tool(a)?.read({ conversationId: 'c1', body: 'x' });
    const error = await tool(a)?.read({ conversationId: 'c1', body: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', details: { what: 'writes' } });
    expect((error as DomainError).details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    expect(calls).toHaveLength(3);
    // Another grant has its own budget.
    await tool(grant(['ludy.read', 'ludy.engage.write'], 'company', 'gB'))?.read({ conversationId: 'c1', body: 'x' });
    expect(calls).toHaveLength(4);
  });
});
