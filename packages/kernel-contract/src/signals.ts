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

// A calendar date in Vietnam, 'YYYY-MM-DD'.
const zSignalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');

// Accounting's side: `finance.signals.sales`. One row per party with at least one sales invoice the caller can open: the date of the latest one and
// how many there are.
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
  amount: zMoney,
});
export type CrmWonDealSignal = z.infer<typeof zCrmWonDealSignal>;
export const zCrmWonDealSignals = z.array(zCrmWonDealSignal).max(SIGNALS_MAX_CRM);

// The names of the reads, so the composition and the lines agree on them.
export const FINANCE_SALES_SIGNALS_READ = 'finance.signals.sales';
export const CRM_WON_DEALS_SIGNALS_READ = 'crm.signals.won_deals';
