// SPDX-License-Identifier: AGPL-3.0-only
// The tools an AI app asks a person with (epic #3857, E4, issue #3863): who is offered which, that each is a strict, not-read-only descriptor over the proposal-only twin of one command, and that a call
// hands the twin `{ payload }` and nothing else. The database and end-to-end tests of the twins (engage-proposals.db.test.ts) run what a call does.
import { describe, expect, it } from 'vitest';
import { ENGAGE_PROPOSALS } from '@crove/kernel-contract';
import type { Runtime, UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { toolsFor } from '../src/mcp-endpoint.ts';

const grant = (scopes: string[], kind: 'company' | 'member' = 'company'): UserActor => ({ type: 'user', userId: 'u1', aal: 'aal1', mcp: { grantId: 'g1', clientId: 'c', clientName: 'Dy', scopes, kind } });
const calls: Array<{ name: string; input: unknown }> = [];
const runtime = {
  execute: async (name: string, input: unknown) => {
    calls.push({ name, input });
    return { proposalId: '00000000-0000-4000-8000-0000000000aa', status: 'pending' };
  },
} as unknown as Runtime;
const listed = (actor: UserActor) => toolsFor(runtime, actor, 'org', new DraftBudget());

const TOOLS: Record<string, string> = {
  ludy_conversation_reply: 'kernel.conversation.reply_approved',
  ludy_conversation_reply_privately: 'kernel.conversation.reply_privately_approved',
  ludy_conversation_hide: 'kernel.conversation.hide_approved',
  ludy_quote_send: 'crm.quote.send_approved',
  ludy_booking_move: 'crm.booking.move_approved',
  ludy_booking_cancel: 'crm.booking.cancel_approved',
  ludy_post_submit: 'social.post.submit_approved',
  ludy_variant_schedule: 'social.variant.schedule_approved',
  ludy_ads_launch_stop: 'ads.launch.stop_approved',
  ludy_ads_pause_all: 'ads.pause_all_approved',
  ludy_ads_object_pause: 'ads.object.pause_approved',
  ludy_ads_object_archive: 'ads.object.archive_approved',
  ludy_ads_budget_lower: 'ads.budget.lower_approved',
  ludy_ads_schedule_shorten: 'ads.schedule.shorten_approved',
};
const ENGAGE_TOOLS = Object.entries(TOOLS).filter(([, c]) => !c.startsWith('ads.')).map(([t]) => t);
const ADS_TOOLS = Object.entries(TOOLS).filter(([, c]) => c.startsWith('ads.')).map(([t]) => t);
const names = (actor: UserActor) => listed(actor).map((t) => t.name).filter((n) => n in TOOLS);

describe('the Engage proposal tools (#3863)', () => {
  it('has one tool for each twin of ENGAGE_PROPOSALS, and none for another command', () => {
    expect(Object.values(TOOLS).sort()).toEqual(ENGAGE_PROPOSALS.map((p) => p.command).sort());
  });

  it('offers them by write scope: the Inbox, CRM and Social tools to ludy.engage.write, the ads tools to ludy.ads.draft, none to a read-only grant, and none to a member-bound grant', () => {
    expect(names(grant(['ludy.read']))).toEqual([]);
    expect(names(grant(['ludy.read', 'ludy.engage.write'])).sort()).toEqual([...ENGAGE_TOOLS].sort());
    expect(names(grant(['ludy.read', 'ludy.ads.draft'])).sort()).toEqual([...ADS_TOOLS].sort());
    expect(names(grant(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'])).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(names(grant(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'], 'member'))).toEqual([]);
    expect(names({ type: 'user', userId: 'u', aal: 'aal1' })).toEqual([]);
  });

  it('makes each a write descriptor under its twin\'s scope, with a strict argument schema, a module where the app can be switched off, and a description that says it only asks', () => {
    const all = listed(grant(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'])).filter((t) => t.name in TOOLS);
    expect(all.length).toBe(14);
    for (const tool of all) {
      const twin = ENGAGE_PROPOSALS.find((p) => p.command === TOOLS[tool.name]);
      expect(tool.writeScope, tool.name).toBe(twin?.scope);
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(tool.argsSchema.safeParse({ smuggled: 1 }).success, tool.name).toBe(false);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description, tool.name).toMatch(/does NOT do this/);
      expect(tool.description, tool.name).toMatch(/waits in Ludy for a person/);
      expect(tool.rows({}), tool.name).toBe(0);
    }
    const module = (name: string) => all.find((t) => t.name === name)?.module;
    expect(module('ludy_quote_send')).toBe('crm');
    expect(module('ludy_post_submit')).toBe('social');
    expect(module('ludy_ads_pause_all')).toBe('ads');
    expect(module('ludy_conversation_reply')).toBeUndefined();
  });

  it('hands the twin the arguments as its payload, and answers the proposal that waits, nothing else', async () => {
    const reply = listed(grant(['ludy.read', 'ludy.engage.write'])).find((t) => t.name === 'ludy_conversation_reply');
    const args = { conversationId: '00000000-0000-4000-8000-000000000001', body: 'Xin chào', lastSeenSeq: 3 };
    expect(reply?.argsSchema.safeParse(args).success).toBe(true);
    expect(reply?.argsSchema.safeParse({ ...args, body: '' }).success).toBe(false);
    calls.length = 0;
    expect(await reply?.read(args)).toEqual({ proposalId: '00000000-0000-4000-8000-0000000000aa', status: 'pending' });
    expect(calls).toEqual([{ name: 'kernel.conversation.reply_approved', input: { payload: args } }]);
  });
});
