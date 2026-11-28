// SPDX-License-Identifier: AGPL-3.0-only
// The aging of receivables and payables (#5338) as pure functions: nothing here reads the database. The read (aging.ts) hands over the open invoices it laid each party's balance over, with their days past due as of the
// day asked; this file puts them in the buckets and finds the largest overdue parties. Money is decimal strings and decimal.js throughout, never JS numbers.
//
// The buckets, by whole days past the due date as of the day asked: not due (0 or fewer), 1 to 30, 31 to 60, 61 to 90 and over 90. An invoice is overdue from the day after its due date (the reminders' own rule).
import { Decimal } from '@ludy/l10n-vn';
import { canonical } from './money.ts';

export const AGING_BUCKETS = ['not_due', 'overdue_1_30', 'overdue_31_60', 'overdue_61_90', 'overdue_over_90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

// The most overdue parties the answer names.
export const AGING_TOP = 5;

export function agingBucketOf(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'not_due';
  if (daysOverdue <= 30) return 'overdue_1_30';
  if (daysOverdue <= 60) return 'overdue_31_60';
  if (daysOverdue <= 90) return 'overdue_61_90';
  return 'overdue_over_90';
}

export interface AgingInvoice {
  // The kept party (a party and the parties marked as its duplicates are one), its name, and what is still owed on the invoice, a decimal string above zero.
  partyId: string;
  partyName: string | null;
  amountDue: string;
  daysOverdue: number;
}

interface Aging {
  buckets: Record<AgingBucket, string>;
  overdue: { total: string; partyCount: number; parties: Array<{ name: string | null; amount: string }> };
}

// The total of each bucket and the largest overdue parties (the sum of their invoices past due, largest first, ties by name then id so the order never changes between two reads); a party with nothing overdue is not
// listed, and `partyCount` counts the parties with something overdue.
export function buildAging(invoices: readonly AgingInvoice[]): Aging {
  const totals = new Map<AgingBucket, InstanceType<typeof Decimal>>(AGING_BUCKETS.map((bucket) => [bucket, new Decimal(0)]));
  const overdue = new Map<string, { name: string | null; amount: InstanceType<typeof Decimal> }>();
  for (const invoice of invoices) {
    const amount = new Decimal(invoice.amountDue);
    const bucket = agingBucketOf(invoice.daysOverdue);
    totals.set(bucket, (totals.get(bucket) ?? new Decimal(0)).plus(amount));
    if (bucket === 'not_due') continue;
    const party = overdue.get(invoice.partyId);
    if (party) party.amount = party.amount.plus(amount);
    else overdue.set(invoice.partyId, { name: invoice.partyName, amount });
  }
  const ranked = [...overdue.entries()].sort(([idA, a], [idB, b]) => b.amount.comparedTo(a.amount) || (a.name ?? '').localeCompare(b.name ?? '') || idA.localeCompare(idB));
  const buckets = Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, canonical(totals.get(bucket) ?? new Decimal(0))])) as Record<AgingBucket, string>;
  return {
    buckets,
    overdue: {
      total: canonical(ranked.reduce((sum, [, party]) => sum.plus(party.amount), new Decimal(0))),
      partyCount: ranked.length,
      parties: ranked.slice(0, AGING_TOP).map(([, party]) => ({ name: party.name === null ? null : party.name.slice(0, 300), amount: canonical(party.amount) })),
    },
  };
}
