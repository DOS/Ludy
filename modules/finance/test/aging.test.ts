// SPDX-License-Identifier: AGPL-3.0-only
// The aging of receivables and payables (#5338): every bucket and every ranking is decided by pure functions, so each rule is a test here (the reads and the database are in apps/kernel/test/finance-aging-ranking.db.test.ts). The
// buckets follow the days past due as of the day asked; the largest overdue parties are the sum of their invoices past due, largest first, ties by name then id.
import { describe, expect, it } from 'vitest';
import { AGING_BUCKETS, AGING_TOP, agingBucketOf, buildAging, type AgingInvoice } from '../src/domain/aging.ts';
import { allocateReceivable } from '../src/domain/payment-reminder.ts';

const invoice = (partyId: string, name: string | null, amountDue: string, daysOverdue: number): AgingInvoice => ({ partyId, partyName: name, amountDue, daysOverdue });

describe('agingBucketOf', () => {
  it.each([
    [-40, 'not_due'],
    [-1, 'not_due'],
    [0, 'not_due'],
    [1, 'overdue_1_30'],
    [30, 'overdue_1_30'],
    [31, 'overdue_31_60'],
    [60, 'overdue_31_60'],
    [61, 'overdue_61_90'],
    [90, 'overdue_61_90'],
    [91, 'overdue_over_90'],
    [4000, 'overdue_over_90'],
  ] as const)('puts %i days past due in %s: an invoice is overdue from the day after its due date', (days, bucket) => {
    expect(agingBucketOf(days)).toBe(bucket);
  });
});

describe('buildAging', () => {
  it('totals each bucket as a decimal string and leaves an empty bucket at 0', () => {
    const aging = buildAging([invoice('a', 'A', '1000000.5', 0), invoice('a', 'A', '2000000', 10), invoice('b', 'B', '500', 45), invoice('b', 'B', '700', 120)]);
    expect(aging.buckets).toEqual({ not_due: '1000000.5', overdue_1_30: '2000000', overdue_31_60: '500', overdue_61_90: '0', overdue_over_90: '700' });
    expect(Object.keys(aging.buckets)).toEqual([...AGING_BUCKETS]);
  });

  it('adds without drift: three tenths are three tenths', () => {
    const aging = buildAging([invoice('a', 'A', '0.1', 5), invoice('a', 'A', '0.2', 6), invoice('b', 'B', '0.3', 7)]);
    expect(aging.buckets.overdue_1_30).toBe('0.6');
    expect(aging.overdue.total).toBe('0.6');
  });

  it('counts a party by what is past due only: an invoice not yet due is in its bucket, never in the overdue list or total', () => {
    const aging = buildAging([invoice('a', 'A', '900', 0), invoice('a', 'A', '100', 3), invoice('b', 'B', '5000', -20)]);
    expect(aging.buckets.not_due).toBe('5900');
    expect(aging.overdue).toEqual({ total: '100', partyCount: 1, parties: [{ name: 'A', amount: '100' }] });
  });

  it('adds the overdue invoices of one party across buckets and ranks the parties largest first', () => {
    const aging = buildAging([
      invoice('a', 'A', '300', 5),
      invoice('a', 'A', '300', 70),
      invoice('b', 'B', '700', 40),
      invoice('c', 'C', '100', 200),
    ]);
    expect(aging.overdue.parties).toEqual([
      { name: 'B', amount: '700' },
      { name: 'A', amount: '600' },
      { name: 'C', amount: '100' },
    ]);
    expect(aging.overdue.total).toBe('1400');
    expect(aging.overdue.partyCount).toBe(3);
  });

  it('breaks a tie by name, then by party id, so the order never changes between two reads', () => {
    const aging = buildAging([invoice('z', 'Beta', '100', 5), invoice('y', 'Alpha', '100', 5), invoice('x', 'Alpha', '100', 5)]);
    expect(aging.overdue.parties.map((p) => p.name)).toEqual(['Alpha', 'Alpha', 'Beta']);
    // The two Alphas differ by id: x before y, and the two reads agree whatever order the invoices come in.
    const again = buildAging([invoice('x', 'Alpha', '100', 5), invoice('z', 'Beta', '100', 5), invoice('y', 'Alpha', '100', 5)]);
    expect(again).toEqual(aging);
  });

  it('lists at most the top parties and counts all of them; a party with no name stays unnamed', () => {
    const many = Array.from({ length: AGING_TOP + 3 }, (_, i) => invoice(`p${i}`, i === 0 ? null : `P${i}`, String(1000 - i), 10));
    const aging = buildAging(many);
    expect(aging.overdue.parties).toHaveLength(AGING_TOP);
    expect(aging.overdue.partyCount).toBe(AGING_TOP + 3);
    expect(aging.overdue.parties[0]).toEqual({ name: null, amount: '1000' });
  });

  it('answers all zero for no invoice', () => {
    expect(buildAging([])).toEqual({
      buckets: { not_due: '0', overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_over_90: '0' },
      overdue: { total: '0', partyCount: 0, parties: [] },
    });
  });

  it('works on what the reminders lay a balance over: the oldest invoices are taken as paid first, so the newest stay open and are the least overdue', () => {
    // Three invoices of 100 on the 1st of three months, terms 30 days, the customer still owes 150: the newest is open in full, the middle one for half, the oldest is paid.
    const receivable = allocateReceivable(
      [
        { id: '1', series: 'A', number: '1', date: '2026-08-01', total: '100', currency: 'VND' },
        { id: '2', series: 'A', number: '2', date: '2026-09-01', total: '100', currency: 'VND' },
        { id: '3', series: 'A', number: '3', date: '2026-10-01', total: '100', currency: 'VND' },
      ],
      '150',
      '2026-11-15',
      30,
    );
    const aging = buildAging(receivable.open.map((i) => invoice('c', 'C', i.amountDue, i.daysOverdue)));
    // Due 31 Oct (15 days overdue on 15 Nov) for the October invoice, 1 Oct (45 days) for the September one.
    expect(aging.buckets.overdue_1_30).toBe('100');
    expect(aging.buckets.overdue_31_60).toBe('50');
    expect(aging.overdue.total).toBe('150');
  });
});
