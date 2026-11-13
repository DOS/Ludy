// SPDX-License-Identifier: AGPL-3.0-only
// The signals contract between apps (docs/plan/vy.md, capability C4, slice V4): what an app tells Home's cross-app rules about the records the
// caller can open, so a rule can join two apps by the shared party id without either app reading the other's tables. A line exposes one small
// read per signal, R0, run in the member's own transaction and role (so the line's own rules decide what the caller sees), and Platform's
// composition (packages/kernel signals.ts) joins them. This file is the one shape every signals read imports.
//
// What a signal carries: ids, dates and amounts. Never text: no party name, no deal title, no invoice number. The schemas are strict, so a read that
// adds a field fails its own test instead of leaking it, and nothing here crosses from one app's side to the other except an id and a date.
import { z } from 'zod';
import { zMoney } from './schemas.ts';

// Rule: a deal won with no sales invoice after this many days. A constant, not a setting (plan V4).
export const WON_DEAL_NO_INVOICE_DAYS = 7;

// The most rows a signals read returns, so a read groups or cuts before it lists.
export const SIGNALS_MAX_FINANCE = 1000;
export const SIGNALS_MAX_CRM = 500;

// A real calendar date in Vietnam, 'YYYY-MM-DD' (2026-02-30 is refused, not rolled over to March).
const zSignalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD')
  .refine((v) => {
    // A day such as 2026-13-45 makes toISOString throw, so the check answers false instead of throwing.
    const at = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === v;
  }, 'a real calendar date');

// Accounting's side: `finance.signals.sales`. Its input is the parties to look at, the ones of the won deals the CRM side listed (ids only, so no cut can hide
// an invoiced customer behind a row cap). Its answer is one row per asked party that has at least one sales invoice the caller can open: the date of the
// latest one and how many there are.
//
// An EMPTY answer means "no sales invoice exists for these parties", never "you cannot see them": the composition reads it as no invoice and raises the
// flag. So the read REFUSES (throws a DomainError, as a role its read does not list does) whenever the caller cannot see all of the asked parties' sales
// invoices: no finance role at all, or a legal-entity scope narrower than the org. A read that answers with the rows it can see and leaves the rest out
// turns a hidden invoice into a false flag. The composition treats a refusal, a missing read and an answer outside the contract alike: no item.
export const zFinanceSalesSignalsInput = z.strictObject({ partyIds: z.array(z.uuid()).min(1).max(SIGNALS_MAX_CRM) });
export type FinanceSalesSignalsInput = z.infer<typeof zFinanceSalesSignalsInput>;
export const zFinanceSalesSignal = z.strictObject({
  partyId: z.uuid(),
  lastSaleOn: zSignalDate,
  count: z.number().int().positive(),
});
export type FinanceSalesSignal = z.infer<typeof zFinanceSalesSignal>;
export const zFinanceSalesSignals = z.array(zFinanceSalesSignal).max(SIGNALS_MAX_FINANCE);

// Engage's side (the CRM): `crm.signals.won_deals`. One row per deal in the won stage that the caller can open: the deal, its party, the day it was
// won (Vietnam time) and its amount.
export const zCrmWonDealSignal = z.strictObject({
  dealId: z.uuid(),
  partyId: z.uuid(),
  wonOn: zSignalDate,
  // A deal's amount is never negative.
  amount: zMoney.refine((v) => !v.startsWith('-'), 'not negative'),
});
export type CrmWonDealSignal = z.infer<typeof zCrmWonDealSignal>;
export const zCrmWonDealSignals = z.array(zCrmWonDealSignal).max(SIGNALS_MAX_CRM);

// The names of the reads, so the composition and the lines agree on them.
export const FINANCE_SALES_SIGNALS_READ = 'finance.signals.sales';
export const CRM_WON_DEALS_SIGNALS_READ = 'crm.signals.won_deals';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Slice V5 (Vy plan C4): the second and third rules. Every finance read below follows the same honesty rule as `finance.signals.sales`: it REFUSES
// (throws a DomainError) when the caller cannot see ALL of what the answer would cover (no finance role, a legal-entity scope narrower than the org,
// a supplier's or customer's records only in part). An answer is therefore complete for the asked parties, and a party it does not list has nothing to
// report. A read that answered with the part it can see would make an empty list mean "you cannot see it", which the rules cannot tell from "there is none".
// ---------------------------------------------------------------------------------------------------------------------------------------------

// The code of the DomainError a finance signals read throws when the caller's view is only PARTIAL (a legal-entity scope narrower than the org, records of the
// asked parties in a book the caller cannot open), as opposed to any other refusal (no finance role at all, which gives the caller nothing to see). The
// kernel shows a partial-view refusal of a security rule as a visible "could not check" item instead of nothing.
export const SIGNAL_PARTIAL_VIEW_CODE = 'SIGNAL_PARTIAL_VIEW';

// One row per party: a read that repeats a party answers outside its contract (the kernel logs it and fails the rule, it never guesses which row is right).
const uniqueParties = (rows: ReadonlyArray<{ partyId: string }>): boolean => new Set(rows.map((r) => r.partyId)).size === rows.length;

// Rule 2 (overdue receivable with an open deal): a receivable is overdue from the day after its due date.
export const OVERDUE_RECEIVABLE_MIN_DAYS = 1;
// Rule 3 (supplier bank account changed with a payment waiting): how long a change counts as recent.
export const SUPPLIER_BANK_CHANGE_DAYS = 30;

// Engage's side of rule 2: `crm.signals.open_deals`. One row per open deal (a stage that is neither won nor lost) the caller can open.
export const zCrmOpenDealSignal = z.strictObject({
  dealId: z.uuid(),
  partyId: z.uuid(),
});
export type CrmOpenDealSignal = z.infer<typeof zCrmOpenDealSignal>;
export const zCrmOpenDealSignals = z.array(zCrmOpenDealSignal).max(SIGNALS_MAX_CRM);

// Accounting's side of rule 2: `finance.signals.overdue_receivables`. Input: `{ partyIds }` (`zFinanceSalesSignalsInput`, the same as for the sales read). One row per asked party with at least one
// receivable (a sales invoice not fully paid) past its due date: the oldest due date among them, the overdue total and how many.
export const zFinanceOverdueReceivableSignal = z.strictObject({
  partyId: z.uuid(),
  oldestDueOn: zSignalDate,
  amount: zMoney.refine((v) => !v.startsWith('-'), 'not negative'),
  count: z.number().int().positive(),
});
export type FinanceOverdueReceivableSignal = z.infer<typeof zFinanceOverdueReceivableSignal>;
export const zFinanceOverdueReceivableSignals = z.array(zFinanceOverdueReceivableSignal).max(SIGNALS_MAX_FINANCE).refine(uniqueParties, 'one row per party');

// Accounting's side of rule 3, first read: `finance.signals.supplier_bank_changes`. Input `{}`. One row per supplier whose bank account was changed in the last
// SUPPLIER_BANK_CHANGE_DAYS days: the day of the latest change. Complete or refused (it must not leave out a supplier whose change the caller cannot see: that
// is the one case where a hidden fact makes the rule miss a payment to a changed account). A caller with a PARTIAL view (an entity scope narrower than the org) gets
// a DomainError with code SIGNAL_PARTIAL_VIEW; a caller with no finance right gets any other refusal.
export const zFinanceSupplierBankChangeSignal = z.strictObject({
  partyId: z.uuid(),
  changedOn: zSignalDate,
});
export type FinanceSupplierBankChangeSignal = z.infer<typeof zFinanceSupplierBankChangeSignal>;
// At most 500 suppliers, the most the payments read takes as input: a read with more changed suppliers REFUSES with SIGNAL_PARTIAL_VIEW rather than leave some out.
export const zFinanceSupplierBankChangeSignals = z.array(zFinanceSupplierBankChangeSignal).max(SIGNALS_MAX_CRM).refine(uniqueParties, 'one row per supplier');

// Accounting's side of rule 3, second read: `finance.signals.supplier_payments_waiting`. Input `{ partyIds }` (`zFinanceSalesSignalsInput`; the suppliers of the first read). One row per
// asked supplier with at least one payment waiting, either for approval or already scheduled: how many and their total. It REFUSES when the caller's view of
// that supplier's payments is partial (a legal-entity scope narrower than the org, a payment of the supplier in a book the caller cannot open), with a DomainError
// of code SIGNAL_PARTIAL_VIEW: an empty answer
// means "no payment is waiting", never "you cannot see one".
export const zFinanceSupplierPaymentsWaitingSignal = z.strictObject({
  partyId: z.uuid(),
  count: z.number().int().positive(),
  amount: zMoney.refine((v) => !v.startsWith('-'), 'not negative'),
});
export type FinanceSupplierPaymentsWaitingSignal = z.infer<typeof zFinanceSupplierPaymentsWaitingSignal>;
export const zFinanceSupplierPaymentsWaitingSignals = z.array(zFinanceSupplierPaymentsWaitingSignal).max(SIGNALS_MAX_FINANCE).refine(uniqueParties, 'one row per supplier');

export const CRM_OPEN_DEALS_SIGNALS_READ = 'crm.signals.open_deals';
export const FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ = 'finance.signals.overdue_receivables';
export const FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ = 'finance.signals.supplier_bank_changes';
export const FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ = 'finance.signals.supplier_payments_waiting';
