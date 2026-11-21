// SPDX-License-Identifier: AGPL-3.0-only
// How old the fees a platform kept are while no invoice has cleared them (#3711 slice 2, research A3 of docs/plan/accounting-rules-research-2026-11-18.md: "flag a balance older than one cycle").
// The fees wait as a debit balance on the platform's 331 (the payout debits them, the platform's fee invoice credits them). Pure functions over the platform's 331 lines, so the read and the tests
// share one rule. Money is decimal strings and decimal.js.
import { money } from '@ludy/l10n-vn';

// One settlement cycle, in days: a fee balance older than this is flagged. The research gives no number (platforms settle within days to a few weeks and invoice a month after), so this is the
// decision recorded on #3711: 45 days since the entry that left the fees on 331, kept in this one place. A change here is the whole change.
export const MARKETPLACE_FEE_CYCLE_DAYS = 45;

export interface FeeLine {
  // The entry's date, YYYY-MM-DD.
  date: string;
  debit: string;
  credit: string;
}

// The date of the oldest debit still not cleared, or null when none is. A credit clears the oldest open debit first (an invoice settles the oldest fees kept); a credit with nothing open to clear
// is kept and clears the next debit that comes (an invoice that arrived before the payout). Lines of one date count debits first. The amounts left are exactly the debit balance on 331.
export function oldestUnclearedFeeDate(lines: readonly FeeLine[]): string | null {
  // By date, and within a date the lines that debit come before those that only credit.
  const rank = (l: FeeLine) => (money(l.debit).gt(0) ? 0 : 1);
  const ordered = [...lines].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b)));
  const open: Array<{ date: string; left: ReturnType<typeof money> }> = [];
  let prepaid = money('0');
  for (const l of ordered) {
    const debit = money(l.debit);
    const credit = money(l.credit);
    if (debit.gt(0)) {
      const covered = prepaid.lt(debit) ? prepaid : debit;
      prepaid = prepaid.minus(covered);
      const rest = debit.minus(covered);
      if (rest.gt(0)) open.push({ date: l.date, left: rest });
    }
    if (credit.gt(0)) {
      let remaining = credit;
      while (remaining.gt(0) && open.length > 0) {
        const head = open[0]!;
        const take = head.left.lt(remaining) ? head.left : remaining;
        head.left = head.left.minus(take);
        remaining = remaining.minus(take);
        if (head.left.lte(0)) open.shift();
      }
      prepaid = prepaid.plus(remaining);
    }
  }
  return open[0]?.date ?? null;
}

// Whole days from `from` to `to` (both YYYY-MM-DD), never negative.
export function daysBetween(from: string, to: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.max(0, Math.round((ms(to) - ms(from)) / 86_400_000));
}

export interface FeeAge {
  oldestFeeDate: string | null;
  feesAgeDays: number | null;
  feesOverdue: boolean;
}

// The age facts of a platform's fees on `today`.
export function feeAge(lines: readonly FeeLine[], today: string): FeeAge {
  const date = oldestUnclearedFeeDate(lines);
  if (date === null) return { oldestFeeDate: null, feesAgeDays: null, feesOverdue: false };
  const days = daysBetween(date, today);
  return { oldestFeeDate: date, feesAgeDays: days, feesOverdue: days > MARKETPLACE_FEE_CYCLE_DAYS };
}
