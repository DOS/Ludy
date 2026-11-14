// SPDX-License-Identifier: AGPL-3.0-only
// `ludy_signals`: what needs attention among the cross-app rules (Vy V4 and V5, #2967 and #2969; ADR-0051 decision 2, #2975, step S4), for an AI app the owner or an admin connected. One small R0 read that
// runs the kernel's three rules in the grant's own sealed context (no user, so nothing bound to a user answers; each line's own refusal logic and its partial-view refusals apply unchanged) and returns what
// they found as the Home items they are: a kind and a severity, a message key with numbers, a link inside the org, an amount and a day. No text a person typed can be in it: the rules return message keys and ids, and
// every item passes the contract's strict item schema before it leaves.
//
// An empty `items` means nothing was found among `checked`, never that everything was looked at. A rule that could not look is named in `unchecked` with why: `partial_view` (a line refused because the caller's
// books are only in part in view, such as a branch-limited accountant) or `not_available` (a line has no read, refuses the caller, or answered outside its contract). Rule 3 (a supplier's account changed while
// a payment waits) is `not_available` until the data it reads exists. A rule whose answer is outside its contract fails the whole call, as on Home, instead of reading as "all clear".
//
// It reads no audit table and writes nothing. Every item counts against the grant's daily row budget (the endpoint charges one row per item), and the endpoint's audit row names the tool.
import { z } from 'zod';
import { zTodayItem, type TodayItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { checkConversationUnanswered, checkDealWithoutInvoice, checkReceivableWithOpenDeal, checkSupplierBankChanged, type RuleCheck } from './signals.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const SIGNAL_RULE_KEYS = ['deal_without_invoice', 'receivable_with_open_deal', 'supplier_bank_changed', 'conversation_unanswered'] as const;
export type SignalRuleKey = (typeof SIGNAL_RULE_KEYS)[number];
export type SignalUncheckedReason = 'partial_view' | 'not_available';

export interface McpSignals {
  items: TodayItem[];
  checked: SignalRuleKey[];
  unchecked: Array<{ rule: SignalRuleKey; reason: SignalUncheckedReason }>;
}

export const mcpSignals = defineQuery({
  name: 'kernel.mcp.signals',
  input: z.strictObject({}),
  // Every role, like the rules: what the caller may not see makes a rule `unchecked`, not an item.
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<McpSignals> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const runs: Array<[SignalRuleKey, () => Promise<RuleCheck>]> = [
      ['deal_without_invoice', () => checkDealWithoutInvoice(ctx)],
      ['receivable_with_open_deal', () => checkReceivableWithOpenDeal(ctx)],
      ['supplier_bank_changed', () => checkSupplierBankChanged(ctx)],
      ['conversation_unanswered', () => checkConversationUnanswered(ctx)],
    ];
    const out: McpSignals = { items: [], checked: [], unchecked: [] };
    for (const [rule, run] of runs) {
      const found = await run();
      for (const raw of found.items) out.items.push(zTodayItem.parse(raw));
      if (found.status === 'ok') out.checked.push(rule);
      else out.unchecked.push({ rule, reason: found.status === 'partial' ? 'partial_view' : 'not_available' });
    }
    return out;
  },
});
