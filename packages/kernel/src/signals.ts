// SPDX-License-Identifier: AGPL-3.0-only
// The first rule that joins two apps (docs/plan/vy.md, capability C4, slice V4): a deal won with no sales invoice after 7 days, shown on Home as a
// flag. The kernel owns the join and the rule; each line owns its own read (the signals contract of @crove/kernel-contract signals.ts):
//   - Engage's CRM answers `crm.signals.won_deals`: the won deals the member can open;
//   - Accounting answers `finance.signals.sales`: the parties with a sales invoice the member can open, and the date of the latest one.
// Both run through ctx.query, in the member's own transaction and role, so each line's own rules decide what the member sees and no table of either
// app is read here. The two sides meet only by the shared party id.
//
// Slice V5 adds two more rules, the same way: an overdue sales receivable whose party still has an open deal (`kernel.signals.receivable_with_open_deal`), and a
// supplier's bank account changed while a payment to that supplier is waiting (`kernel.signals.supplier_bank_changed`, severity `block`, which is never dropped
// silently: see its comment).
//
// Fail closed: with no answer from either side (its read is not registered yet, its module is off, it refuses the member's role, or its answer does
// not match the contract) the rule shows nothing. A member who cannot read the invoices gets no item, never one claiming "no invoice" because it could
// not look. Nothing is written, no model is called, and no text crosses: the item is a message key with a number of days, the deal's amount and a link.
import { z } from 'zod';
import {
  CRM_OPEN_DEALS_SIGNALS_READ,
  CRM_WON_DEALS_SIGNALS_READ,
  FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ,
  FINANCE_SALES_SIGNALS_READ,
  FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ,
  FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ,
  OVERDUE_RECEIVABLE_MIN_DAYS,
  SIGNAL_PARTIAL_VIEW_CODE,
  SUPPLIER_BANK_CHANGE_DAYS,
  WON_DEAL_NO_INVOICE_DAYS,
  vietnamToday,
  zCrmOpenDealSignals,
  zCrmWonDealSignals,
  zFinanceOverdueReceivableSignals,
  zFinanceSalesSignals,
  zFinanceSupplierBankChangeSignals,
  zFinanceSupplierPaymentsWaitingSignals,
  type TodayItem,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DAY_MS = 86_400_000;
// Items one read lists; the rest are one grouped item with their count (a read groups before it lists).
export const SIGNAL_ITEMS_MAX = 20;

export const DEAL_WITHOUT_INVOICE_READ = 'kernel.signals.deal_without_invoice';
export const RECEIVABLE_WITH_OPEN_DEAL_READ = 'kernel.signals.receivable_with_open_deal';
export const SUPPLIER_BANK_CHANGED_READ = 'kernel.signals.supplier_bank_changed';

// The start (Vietnam time) of the day a win turns 7 days old.
const dueAt = (wonOn: string): string => `${new Date(Date.parse(`${wonOn}T00:00:00Z`) + WON_DEAL_NO_INVOICE_DAYS * DAY_MS).toISOString().slice(0, 10)}T00:00:00+07:00`;

// Whole days from one Vietnam calendar day to a later one.
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// What one line's signals read gave: its rows, nothing to join (not registered, module off, or a refusal: no right to see, a view that is only partial), or an
// answer outside the contract (a bug of that line, which is not the same as "nothing").
type Signals<T> = { status: 'ok'; rows: T } | { status: 'unavailable' } | { status: 'partial' } | { status: 'broken' };

async function readSignals<T>(ctx: QueryContext, name: string, schema: z.ZodType<T>, input: unknown = {}): Promise<Signals<T>> {
  let answer;
  try {
    answer = await ctx.query<unknown>(name, input);
  } catch (error) {
    // Thrown before any SQL, so the transaction is still usable. Anything else (a database error) may have left it unusable and fails the answer.
    if (error instanceof DomainError) return error.code === SIGNAL_PARTIAL_VIEW_CODE ? { status: 'partial' } : { status: 'unavailable' };
    throw error;
  }
  if (answer.status !== 'ok') return { status: 'unavailable' };
  const parsed = schema.safeParse(answer.value);
  return parsed.success ? { status: 'ok', rows: parsed.data } : { status: 'broken' };
}

// One line's signals read, or null when there is nothing to join: not registered, module off, refused, or an answer that is not the contract's.
async function signalsOf<T>(ctx: QueryContext, name: string, schema: z.ZodType<T>, input: unknown = {}): Promise<T | null> {
  const got = await readSignals(ctx, name, schema, input);
  return got.status === 'ok' ? got.rows : null;
}

export function dealWithoutInvoiceQuery(options: { now?: () => Date } = {}) {
  return defineQuery({
    name: DEAL_WITHOUT_INVOICE_READ,
    input: z.strictObject({}),
    access: ALL,
    handler: async (ctx): Promise<TodayItem[]> => {
      const deals = await signalsOf(ctx, CRM_WON_DEALS_SIGNALS_READ, zCrmWonDealSignals);
      if (!deals || deals.length === 0) return [];
      // Finance is asked about the parties of these deals only (ids, no text), so a row cap on its side cannot hide an invoiced customer.
      const partyIds = [...new Set(deals.map((d) => d.partyId))];
      const sales = await signalsOf(ctx, FINANCE_SALES_SIGNALS_READ, zFinanceSalesSignals, { partyIds });
      if (!sales) return [];
      const today = vietnamToday(options.now?.() ?? new Date());
      // The latest sale date per party, whatever the number of rows a party comes in.
      const lastSale = new Map<string, string>();
      for (const s of sales) if ((lastSale.get(s.partyId) ?? '') < s.lastSaleOn) lastSale.set(s.partyId, s.lastSaleOn);
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
        // The day it became due: Home sorts a flag by the nearer dueAt, so the most overdue deal comes first and the grouped item (no dueAt) last.
        dueAt: dueAt(deal.wonOn),
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

// Rule 2 (V5): an overdue sales receivable whose party still has an open deal. Engage lists the open deals the member can open; Accounting is asked about those
// parties only and lists the ones with a receivable past its due date. One flag per party (a party with several open deals is one item), the overdue total as
// its amount, `dueAt` the oldest due date so the longest overdue comes first. It is acted on in the deal (the sale is still open), so the item is the CRM's.
export function receivableWithOpenDealQuery(options: { now?: () => Date } = {}) {
  return defineQuery({
    name: RECEIVABLE_WITH_OPEN_DEAL_READ,
    input: z.strictObject({}),
    access: ALL,
    handler: async (ctx): Promise<TodayItem[]> => {
      const deals = await signalsOf(ctx, CRM_OPEN_DEALS_SIGNALS_READ, zCrmOpenDealSignals);
      if (!deals || deals.length === 0) return [];
      const partyIds = [...new Set(deals.map((d) => d.partyId))];
      const receivables = await signalsOf(ctx, FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ, zFinanceOverdueReceivableSignals, { partyIds });
      if (!receivables) return [];
      const today = vietnamToday(options.now?.() ?? new Date());
      // Only the parties of the open deals (a row for another party is ignored); the contract allows one row per party.
      const wanted = new Set(partyIds);
      const byParty = new Map<string, { oldestDueOn: string; amount: string }>();
      for (const r of receivables) if (wanted.has(r.partyId)) byParty.set(r.partyId, { oldestDueOn: r.oldestDueOn, amount: r.amount });
      const due = [...byParty.entries()]
        .map(([partyId, r]) => ({ partyId, ...r, days: daysBetween(r.oldestDueOn, today) }))
        .filter((r) => r.days >= OVERDUE_RECEIVABLE_MIN_DAYS)
        .sort((a, b) => b.days - a.days || (a.partyId < b.partyId ? -1 : 1));
      const items: TodayItem[] = due.slice(0, SIGNAL_ITEMS_MAX).map((r) => ({
        kind: 'flag',
        app: 'crm',
        id: `signal:overdue-receivable-open-deal:${r.partyId}`,
        title: { key: 'signals.overdueReceivableOpenDeal', params: { days: r.days } },
        amount: r.amount,
        currency: 'VND',
        severity: 'warn',
        dueAt: `${r.oldestDueOn}T00:00:00+07:00`,
        href: '/deals',
      }));
      const rest = due.length - items.length;
      if (rest > 0) {
        items.push({ kind: 'flag', app: 'crm', id: 'signal:overdue-receivable-open-deal:more', title: { key: 'signals.overdueReceivableOpenDealMore', params: { count: rest } }, count: rest, severity: 'warn', href: '/deals' });
      }
      return items;
    },
  });
}

// Rule 3 (V5): a supplier's bank account changed (in the last SUPPLIER_BANK_CHANGE_DAYS days) while a payment to that supplier is waiting, for approval or already
// scheduled. This is a payment-fraud signal, so it is `block` and it is never dropped silently:
//   - the bank-change read answers first. A member with no right to it (it refuses, or is not registered) gets nothing: they cannot see the change either;
//   - for the suppliers it lists, Accounting is asked about their waiting payments. A supplier with one gives a `block` item;
//   - a PARTIAL view of the changes themselves (SIGNAL_PARTIAL_VIEW, an entity scope narrower than the org) gives one `warn` item saying the check is incomplete;
//   - if that second read cannot answer (it refuses because the member's view of the supplier's payments is partial, or it is not registered), the member HAS seen
//     a changed account and cannot see its payments, so the answer is one `warn` item saying the payments could not be checked, never an empty list;
//   - an answer outside the contract, from either read, is a bug of that line: it is logged and the read fails (`SIGNAL_CONTRACT_BROKEN`), so Home counts it in
//     `failed` instead of showing a quiet "all clear".
export function supplierBankChangedQuery(options: { now?: () => Date; log?: Pick<Console, 'error'> } = {}) {
  const log = options.log ?? console;
  const broken = (read: string): DomainError => {
    log.error(`[signals] ${read} answered outside the signals contract`);
    return new DomainError('SIGNAL_CONTRACT_BROKEN', 500, 'A signals read answered outside its contract');
  };
  return defineQuery({
    name: SUPPLIER_BANK_CHANGED_READ,
    input: z.strictObject({}),
    access: ALL,
    handler: async (ctx): Promise<TodayItem[]> => {
      const changes = await readSignals(ctx, FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ, zFinanceSupplierBankChangeSignals);
      if (changes.status === 'broken') throw broken(FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ);
      if (changes.status === 'unavailable') return [];
      // A partial view of the changes (an entity scope narrower than the org): the member may be missing a changed account, so they are told, never given nothing.
      if (changes.status === 'partial') return [{ kind: 'flag', app: 'finance', id: 'signal:supplier-bank-changed:partial', title: { key: 'signals.supplierBankChangedPartial' }, severity: 'warn', href: '/inbox' }];
      const today = vietnamToday(options.now?.() ?? new Date());
      // The suppliers that changed an account inside the window. A change dated in the future (a clock a little ahead, an effective date) counts as today: the rule
      // must not fail open on it.
      const changedOn = new Map<string, string>();
      for (const c of changes.rows) {
        const age = Math.max(0, daysBetween(c.changedOn, today));
        if (age <= SUPPLIER_BANK_CHANGE_DAYS) changedOn.set(c.partyId, c.changedOn);
      }
      if (changedOn.size === 0) return [];
      // At most 500 (the contract's cap on the changes read, which is also the payments read's input cap): none is cut.
      const partyIds = [...changedOn.keys()];
      const payments = await readSignals(ctx, FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ, zFinanceSupplierPaymentsWaitingSignals, { partyIds });
      if (payments.status === 'broken') throw broken(FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ);
      if (payments.status === 'unavailable' || payments.status === 'partial') {
        // Not checked: say so, once, with how many suppliers changed their account.
        return [{ kind: 'flag', app: 'finance', id: 'signal:supplier-bank-changed:unchecked', title: { key: 'signals.supplierBankChangedUnchecked', params: { count: partyIds.length } }, count: partyIds.length, severity: 'warn', href: '/inbox' }];
      }
      const wanted = new Set(partyIds);
      const waiting = new Map<string, { count: number; amount: string }>();
      for (const p of payments.rows) if (wanted.has(p.partyId)) waiting.set(p.partyId, { count: p.count, amount: p.amount });
      const hits = [...waiting.entries()]
        .map(([partyId, w]) => ({ partyId, ...w, days: Math.max(0, daysBetween(changedOn.get(partyId) as string, today)) }))
        .sort((a, b) => a.days - b.days || (a.partyId < b.partyId ? -1 : 1));
      const items: TodayItem[] = hits.slice(0, SIGNAL_ITEMS_MAX).map((h) => ({
        kind: 'flag',
        app: 'finance',
        id: `signal:supplier-bank-changed:${h.partyId}`,
        title: { key: 'signals.supplierBankChanged', params: { days: h.days, count: h.count } },
        count: h.count,
        amount: h.amount,
        currency: 'VND',
        severity: 'block',
        href: '/inbox',
      }));
      const rest = hits.length - items.length;
      if (rest > 0) {
        items.push({ kind: 'flag', app: 'finance', id: 'signal:supplier-bank-changed:more', title: { key: 'signals.supplierBankChangedMore', params: { count: rest } }, count: rest, severity: 'block', href: '/inbox' });
      }
      return items;
    },
  });
}
