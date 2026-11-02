// SPDX-License-Identifier: AGPL-3.0-only
// Which open bank lines may be asked for and approved as one clean group (#2385). Pure and deterministic, like the
// matcher it reads (domain/bank-match.ts): a clean line has exactly one exact candidate and no warning, and every other
// line says the first reason it needs a look. Nothing here is a model's read: "Vy's suggestion" is this rule, a person
// approves every voucher, and the server checks each voucher again when it is approved.
import type { BankLookWhy, BankMatchReason } from '@crove/kernel-contract';

// The reasons strong enough for a clean line: what the description itself names (the party's tax code, or an invoice of
// the line's amount). The name, the open balance and what a person taught by matching such a line by hand (#2402) only point
// at a party: a learned key is a few words of the transfer text, which two payers can share, so it never makes a line clean.
export const CLEAN_REASONS: readonly BankMatchReason[] = ['tax_code', 'invoice'];

export interface LineFacts {
  // The matcher's suggestion (one party stands out by its strongest reason), or null when none does.
  suggested: { reason: BankMatchReason } | null;
  // How many parties the matcher found in all, whatever the reason.
  candidates: number;
  // The line was flagged at import: its bank reference is already held with another date or amount.
  flaggedAtImport: boolean;
  // The open invoices of the suggested party whose total equals the line's amount (the invoice named in the description,
  // or the only one of that amount).
  exactInvoices: ReadonlyArray<{ series: string; number: string }>;
  // Whether the party's open balance on the line's side covers the amount; null while it was not asked.
  balanceCovers: boolean | null;
}

export type Classified = { group: 'clean'; why: null; invoice: { series: string; number: string } } | { group: 'look'; why: BankLookWhy; invoice?: undefined };

export function classifyLine(facts: LineFacts): Classified {
  const look = (why: BankLookWhy): Classified => ({ group: 'look', why });
  if (facts.flaggedAtImport) return look('duplicate');
  if (facts.suggested === null) return look('several');
  if (!CLEAN_REASONS.includes(facts.suggested.reason)) return look('weak');
  if (facts.candidates > 1) return look('several');
  const [invoice, ...rest] = facts.exactInvoices;
  if (!invoice) return look('no_invoice');
  if (rest.length > 0) return look('several');
  if (facts.balanceCovers === false) return look('no_invoice');
  return { group: 'clean', why: null, invoice };
}

// A key per invoice a clean line settles: two lines of one statement that name the same invoice are a double payment
// to look at, so neither stays in the clean group.
export const invoiceKey = (partyId: string, invoice: { series: string; number: string }): string => `${partyId}\u0000${invoice.series}\u0000${invoice.number}`;

// The ids of the lines that share an invoice with another line of the list (lines given as [id, key] pairs).
export function sharedInvoices(clean: ReadonlyArray<readonly [string, string]>): Set<string> {
  const count = new Map<string, number>();
  for (const [, key] of clean) count.set(key, (count.get(key) ?? 0) + 1);
  return new Set(clean.filter(([, key]) => (count.get(key) ?? 0) > 1).map(([id]) => id));
}
