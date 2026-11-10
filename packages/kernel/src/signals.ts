// SPDX-License-Identifier: AGPL-3.0-only
// The first rule that joins two apps (docs/plan/vy.md, capability C4, slice V4): a deal won with no sales invoice after 7 days, shown on Home as a
// flag. The kernel owns the join and the rule; each line owns its own read (the signals contract of @crove/kernel-contract signals.ts):
//   - Engage's CRM answers `crm.signals.won_deals`: the won deals the member can open;
//   - Accounting answers `finance.signals.sales`: the parties with a sales invoice the member can open, and the date of the latest one.
// Both run through ctx.query, in the member's own transaction and role, so each line's own rules decide what the member sees and no table of either
// app is read here. The two sides meet only by the shared party id.
//
// Fail closed: with no answer from either side (its read is not registered yet, its module is off, it refuses the member's role, or its answer does
// not match the contract) the rule shows nothing. A member who cannot read the invoices gets no item, never one claiming "no invoice" because it could
// not look. Nothing is written, no model is called, and no text crosses: the item is a message key with a number of days, the deal's amount and a link.
import { z } from 'zod';
import {
  CRM_WON_DEALS_SIGNALS_READ,
  FINANCE_SALES_SIGNALS_READ,
  WON_DEAL_NO_INVOICE_DAYS,
  vietnamToday,
  zCrmWonDealSignals,
  zFinanceSalesSignals,
  type TodayItem,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DAY_MS = 86_400_000;
// Items one read lists; the rest are one grouped item with their count (a read groups before it lists).
export const SIGNAL_ITEMS_MAX = 20;

export const DEAL_WITHOUT_INVOICE_READ = 'kernel.signals.deal_without_invoice';

// Whole days from one Vietnam calendar day to a later one.
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// One line's signals read, or null when there is nothing to join: not registered, module off, refused, or an answer that is not the contract's.
async function signalsOf<T>(ctx: QueryContext, name: string, schema: z.ZodType<T>): Promise<T | null> {
  let answer;
  try {
    answer = await ctx.query<unknown>(name, {});
  } catch (error) {
    // Thrown before any SQL, so the transaction is still usable. Anything else (a database error) may have left it unusable and fails the answer.
    if (error instanceof DomainError) return null;
    throw error;
  }
  if (answer.status !== 'ok') return null;
  const parsed = schema.safeParse(answer.value);
  return parsed.success ? parsed.data : null;
}

export function dealWithoutInvoiceQuery(options: { now?: () => Date } = {}) {
  return defineQuery({
    name: DEAL_WITHOUT_INVOICE_READ,
    input: z.strictObject({}),
    access: ALL,
    handler: async (ctx): Promise<TodayItem[]> => {
      const deals = await signalsOf(ctx, CRM_WON_DEALS_SIGNALS_READ, zCrmWonDealSignals);
      if (!deals || deals.length === 0) return [];
      const sales = await signalsOf(ctx, FINANCE_SALES_SIGNALS_READ, zFinanceSalesSignals);
      if (!sales) return [];
      const today = vietnamToday(options.now?.() ?? new Date());
      const lastSale = new Map(sales.map((s) => [s.partyId, s.lastSaleOn]));
      const due = deals
        .map((deal) => ({ deal, days: daysBetween(deal.wonOn, today) }))
        // Won long enough ago, and no sales invoice of the party dated on or after the day it was won (an older invoice is another sale).
        .filter(({ deal, days }) => days >= WON_DEAL_NO_INVOICE_DAYS && !((lastSale.get(deal.partyId) ?? '') >= deal.wonOn))
        .sort((a, b) => b.days - a.days || (a.deal.dealId < b.deal.dealId ? -1 : 1));
      const items: TodayItem[] = due.slice(0, SIGNAL_ITEMS_MAX).map(({ deal, days }) => ({
        kind: 'flag',
        app: 'crm',
        id: `signal:won-deal-no-invoice:${deal.dealId}`,
        title: { key: 'signals.wonDealNoInvoice', params: { days } },
        amount: deal.amount,
        currency: 'VND',
        severity: 'warn',
        href: '/deals',
      }));
      const rest = due.length - items.length;
      if (rest > 0) {
        items.push({ kind: 'flag', app: 'crm', id: 'signal:won-deal-no-invoice:more', title: { key: 'signals.wonDealNoInvoiceMore', params: { count: rest } }, count: rest, severity: 'warn', href: '/deals' });
      }
      return items;
    },
  });
}
