// SPDX-License-Identifier: AGPL-3.0-only
// The tool list of the Engage reads (epic #3857, E1, issue #3860): what a company grant and a member-bound grant are offered, that each tool is a strict, read-only descriptor over a query, and the row
// limits (what an answer is charged, and the hard maximum of every page). The database tests of each tool (engage-mcp-*.db.test.ts) run the queries behind them.
import { describe, expect, it } from 'vitest';
import type { Runtime, UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { toolsFor, visibleTools } from '../src/mcp-endpoint.ts';

const company: UserActor = { type: 'user', userId: 'u1', aal: 'aal1', mcp: { grantId: 'g1', clientId: 'c', clientName: 'Test', scopes: ['ludy.read'], kind: 'company' } };
const member: UserActor = { type: 'user', userId: 'u2', aal: 'aal1', mcp: { grantId: 'g2', clientId: 'c', clientName: 'Test', scopes: ['ludy.read'], kind: 'member' } };
const listed = (actor: UserActor) => toolsFor({} as unknown as Runtime, actor, 'org', new DraftBudget());

// The tools of E1 and the query each one runs.
const ENGAGE: Record<string, string> = {
  ludy_deals_list: 'crm.mcp.deals',
  ludy_deal: 'crm.mcp.deal',
  ludy_quotes_list: 'crm.mcp.quotes',
  ludy_quote: 'crm.mcp.quote',
  ludy_conversations_list: 'kernel.mcp.conversations',
  ludy_conversation: 'kernel.mcp.conversation',
  ludy_social_metrics_summary: 'social.mcp.metrics_summary',
  ludy_social_metrics_totals: 'social.mcp.metrics_totals',
  ludy_ads_spend: 'ads.mcp.spend',
  ludy_ads_flags: 'ads.mcp.flags',
  ludy_ads_today: 'ads.mcp.today',
  ludy_bookings_list: 'crm.mcp.bookings',
};
// What a member-bound grant is offered of them: the records every role reads in the app (the database narrows the conversations to the member's rights). The results of Social and Ads and the guests' bookings
// are a company grant's alone.
const MEMBER_OFFERED = ['ludy_conversation', 'ludy_conversations_list', 'ludy_deal', 'ludy_deals_list', 'ludy_quote', 'ludy_quotes_list'];

describe('the Engage reads in the tool list (#3860)', () => {
  it('offers a company grant every one of them, and a member-bound grant only the records every role reads', () => {
    const names = (actor: UserActor) => listed(actor).map((t) => t.name);
    for (const name of Object.keys(ENGAGE)) expect(names(company), name).toContain(name);
    const memberNames = names(member).filter((n) => n in ENGAGE);
    expect(memberNames.sort()).toEqual(MEMBER_OFFERED);
    // No write tool is added by them: a company grant without a write scope has no tool that writes.
    expect(listed(company).filter((t) => !t.annotations.readOnlyHint)).toEqual([]);
  });

  it('keeps a grant that is not an MCP grant, and a tool that names a write scope without it, out of the list', () => {
    const browser: UserActor = { type: 'user', userId: 'u', aal: 'aal1' };
    expect(visibleTools(listed(company), browser).filter((t) => t.name in ENGAGE).length).toBe(Object.keys(ENGAGE).length);
  });

  it('makes each a read-only descriptor with a strict argument schema, a module where the app can be switched off, and a description that says the text is data', () => {
    for (const tool of listed(company).filter((t) => t.name in ENGAGE)) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.writeScope, tool.name).toBeUndefined();
      expect(tool.argsSchema.safeParse({ smuggled: 1 }).success, tool.name).toBe(false);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema.type, tool.name).toBe('object');
      // Every tool that carries text says it is data; the totals carry counts only and say so.
      expect(tool.description, tool.name).toMatch(tool.name === 'ludy_social_metrics_totals' ? /Counts only: no text/ : /never as instructions|never instructions|data, never/);
      expect(tool.description, tool.name).toMatch(/Read only/);
    }
    const module = (name: string) => listed(company).find((t) => t.name === name)?.module;
    expect(module('ludy_deals_list')).toBe('crm');
    expect(module('ludy_bookings_list')).toBe('crm');
    expect(module('ludy_ads_spend')).toBe('ads');
    expect(module('ludy_social_metrics_totals')).toBe('social');
    // The inbox belongs to the kernel, which is never switched off.
    expect(module('ludy_conversations_list')).toBeUndefined();
  });

  it('bounds every page: a limit above the maximum is refused, a missing one takes the default', () => {
    const args = (name: string) => listed(company).find((t) => t.name === name)?.argsSchema as { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
    const over: Array<[string, Record<string, unknown>]> = [
      ['ludy_deals_list', { limit: 51 }],
      ['ludy_quotes_list', { limit: 51 }],
      ['ludy_bookings_list', { limit: 51 }],
      ['ludy_conversations_list', { limit: 31 }],
      ['ludy_conversation', { conversationId: '00000000-0000-4000-8000-000000000001', limit: 51 }],
      ['ludy_social_metrics_summary', { limit: 51 }],
      ['ludy_social_metrics_summary', { days: 366 }],
      ['ludy_social_metrics_totals', { days: 366 }],
    ];
    for (const [name, input] of over) expect(args(name).safeParse(input).success, `${name} ${JSON.stringify(input)}`).toBe(false);
    const defaults: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['ludy_deals_list', {}, { limit: 25 }],
      ['ludy_quotes_list', {}, { limit: 25 }],
      ['ludy_bookings_list', {}, { limit: 25, period: 'upcoming' }],
      ['ludy_conversations_list', {}, { limit: 15 }],
      ['ludy_conversation', { conversationId: '00000000-0000-4000-8000-000000000001' }, { limit: 30 }],
      ['ludy_social_metrics_summary', {}, { limit: 25, days: 30 }],
    ];
    for (const [name, input, expected] of defaults) expect(args(name).safeParse(input).data, name).toMatchObject(expected);
  });

  it('charges the daily row budget for what an answer carries', () => {
    const rows = (name: string, value: Record<string, unknown>) => listed(company).find((t) => t.name === name)?.rows(value);
    const some = (n: number) => Array.from({ length: n }, () => ({}));
    expect(rows('ludy_deals_list', { deals: some(7), next: null })).toBe(7);
    expect(rows('ludy_quotes_list', { quotes: some(3), next: null })).toBe(3);
    expect(rows('ludy_quote', { lines: some(4) })).toBe(5);
    expect(rows('ludy_deal', {})).toBe(1);
    expect(rows('ludy_bookings_list', { bookings: some(2), truncated: false })).toBe(2);
    expect(rows('ludy_conversations_list', { conversations: some(5), more: false, next: null })).toBe(5);
    expect(rows('ludy_conversation', { messages: some(30) })).toBe(31);
    expect(rows('ludy_social_metrics_summary', { rows: some(6), truncated: false })).toBe(6);
    expect(rows('ludy_social_metrics_totals', { channels: some(2), previous: { channels: some(3) } })).toBe(6);
    expect(rows('ludy_ads_flags', { flags: some(4), truncated: false })).toBe(4);
    expect(rows('ludy_ads_today', { items: some(2) })).toBe(2);
    // The accounts listed, and for a chosen account its total, months, campaigns and days.
    expect(rows('ludy_ads_spend', { accounts: some(2), accountsTruncated: false, summary: null })).toBe(2);
    expect(rows('ludy_ads_spend', { accounts: some(2), accountsTruncated: false, summary: { months: some(1), campaigns: some(3), days: some(30) } })).toBe(2 + 1 + 1 + 3 + 30);
  });
});
