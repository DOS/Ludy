// SPDX-License-Identifier: AGPL-3.0-only
// The months a stored marketplace settlement is posted in (#2516, the rework to the AI consensus of 2026-11-15, slice C1; plan docs/plan/stock-and-marketplaces.md section 8.4). Revenue belongs to the
// month of successful delivery (working answer A5 of #2520, pending the accountant), and an entry has one date, so a settlement posts as one voucher per month. Pure functions over decimal strings
// (settlementMonthsOf), the reads that give them the delivery day of each settlement line and the vouchers that already exist (settlementMonthsFor, postingsOf), and the two questions the rest of the
// slice asks (what still waits to be posted, whether the settlement is fully posted). The rules:
// - the sale of a settlement line (sales less the seller's discount) belongs to the month of its order's delivery day (the latest `delivered_at` of the order's lines); a line with no usable day makes
//   the settlement WAIT ("chờ ngày giao"): nothing is dated by a guess, and nothing is posted for any month until every sale has its day, because the payout asks for every month to be posted;
// - a refund belongs to the month of the settlement's last day (the refund reduces revenue in the period it occurs, PO decision 2026-11-08);
// - a line refunded at least as much as it sold needs no delivery day: it is the refund in the month of the settlement's last day, sale and refund together;
// - a month whose net is zero has no entry and is not listed; a month with a negative net runs the entry the other way (the platform owing less).
import { money, sum, toMoney } from '@crove/l10n-vn';
import type { QueryContext } from '@crove/kernel-runtime';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import type { SettlementPostingLine } from './marketplace-settlement-posting.ts';
import { reversedSource } from './source-entry.ts';

export interface SettlementMonthLine {
  sales: string;
  sellerDiscount: string;
  refund: string;
  // The delivery day of the line's order (YYYY-MM-DD), or null while no line of the order has one.
  deliveredOn: string | null;
}

export interface SettlementMonth {
  // YYYY-MM.
  month: string;
  // The date of the entry: the settlement's last day for its own month, else the last day of the month.
  date: string;
  // The pieces the entry is built from (the sums are all that is posted).
  lines: SettlementPostingLine[];
  // Sales less seller discounts less refunds of the month, signed, never zero.
  net: string;
}

export interface SettlementMonths {
  months: SettlementMonth[];
  // Settlement lines whose sale has no usable delivery day: while there is one, nothing is posted.
  waiting: number;
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export const monthEntryDate = (month: string, periodTo: string): string => (month === periodTo.slice(0, 7) ? periodTo : lastDayOf(month));

export function settlementMonthsOf(lines: readonly SettlementMonthLine[], periodTo: string): SettlementMonths {
  const endMonth = periodTo.slice(0, 7);
  const buckets = new Map<string, SettlementPostingLine[]>();
  const put = (month: string, line: SettlementPostingLine) => buckets.set(month, [...(buckets.get(month) ?? []), line]);
  let waiting = 0;
  for (const l of lines) {
    const sale = money(l.sales).minus(money(l.sellerDiscount));
    if (money(l.refund).greaterThanOrEqualTo(sale)) {
      // Refunded at least as much as it sold: no delivery day is needed, the whole line is the refund in the settlement's own month.
      put(endMonth, { sales: l.sales, sellerDiscount: l.sellerDiscount, refund: l.refund });
      continue;
    }
    // A delivery after the settlement's last day cannot be what the platform paid for: the day is not usable, the line waits.
    if (l.deliveredOn === null || l.deliveredOn.slice(0, 7) > endMonth) {
      waiting += 1;
      continue;
    }
    put(l.deliveredOn.slice(0, 7), { sales: l.sales, sellerDiscount: l.sellerDiscount, refund: '0' });
    if (!money(l.refund).isZero()) put(endMonth, { sales: '0', sellerDiscount: '0', refund: l.refund });
  }
  const months: SettlementMonth[] = [];
  for (const month of [...buckets.keys()].sort()) {
    const pieces = buckets.get(month) ?? [];
    const net = money(toMoney(sum(pieces.map((p) => p.sales)))).minus(money(toMoney(sum(pieces.map((p) => p.sellerDiscount))))).minus(money(toMoney(sum(pieces.map((p) => p.refund)))));
    if (net.isZero()) continue;
    months.push({ month, date: monthEntryDate(month, periodTo), lines: pieces, net: toMoney(net) });
  }
  return { months, waiting };
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// The months of each settlement, read in the caller's context: the settlement's lines and the delivery day of each line's order, in as few reads as the settlements allow.
export async function settlementMonthsFor(ctx: Ctx, settlements: ReadonlyArray<{ id: string; periodEnd: string }>): Promise<Map<string, SettlementMonths>> {
  const out = new Map<string, SettlementMonths>();
  const end = new Map(settlements.map((s) => [s.id, s.periodEnd] as const));
  const ids = [...end.keys()];
  const byId = new Map<string, SettlementMonthLine[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.channel_settlement_line as l')
      .select((eb) => [
        'l.settlement_id',
        'l.sales',
        'l.seller_discount',
        'l.refund',
        eb
          .selectFrom('crove_finance.channel_order_line as ol')
          .select((x) => x.fn.max('ol.delivered_at').as('d'))
          .whereRef('ol.org_id', '=', 'l.org_id')
          .whereRef('ol.order_id', '=', 'l.order_id')
          .as('delivered_on'),
      ])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.settlement_id', 'in', ids.slice(i, i + 500))
      .execute();
    for (const r of rows) {
      byId.get(r.settlement_id)?.push({ sales: r.sales, sellerDiscount: r.seller_discount, refund: r.refund, deliveredOn: r.delivered_on === null ? null : String(r.delivered_on).slice(0, 10) });
    }
  }
  for (const [id, lines] of byId) out.set(id, settlementMonthsOf(lines, (end.get(id) ?? '').slice(0, 10)));
  return out;
}

export interface SettlementPostings {
  // The voucher's month as YYYY-MM, or null for a voucher that posted the whole settlement (before the months).
  month: string | null;
  reversed: boolean;
}

// Every posting voucher of the settlements, reversed or not.
export async function postingsOf(ctx: Ctx, settlementIds: readonly string[]): Promise<Map<string, SettlementPostings[]>> {
  const out = new Map<string, SettlementPostings[]>(settlementIds.map((id) => [id, []]));
  for (let i = 0; i < settlementIds.length; i += 500) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.journal_voucher as j')
      .select(['j.settlement_id', 'j.settlement_month', reversedSource('j', JOURNAL_VOUCHER_SOURCE).as('reversed')])
      .where('j.org_id', '=', ctx.orgId)
      .where('j.settlement_id', 'in', settlementIds.slice(i, i + 500))
      .execute();
    for (const r of rows) {
      if (r.settlement_id === null) continue;
      out.get(r.settlement_id)?.push({ month: r.settlement_month === null ? null : String(r.settlement_month).slice(0, 7), reversed: Boolean(r.reversed) });
    }
  }
  return out;
}

// The settlements among `settlementIds` that have a payout voucher (reversed or not: a reversed payout is not posted again, the accountant handles it).
export async function paidSettlementIds(ctx: Ctx, settlementIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < settlementIds.length; i += 500) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.journal_voucher as j')
      .select('j.payout_settlement_id')
      .where('j.org_id', '=', ctx.orgId)
      .where('j.payout_settlement_id', 'in', settlementIds.slice(i, i + 500))
      .execute();
    for (const r of rows) if (r.payout_settlement_id !== null) out.add(r.payout_settlement_id);
  }
  return out;
}

// The months that still have no voucher at all (reversed or not: the database holds one per settlement and month for good, so a reversed month is not offered again). A settlement that a voucher
// of the whole settlement covers has none.
export function monthsToPost(months: SettlementMonths, postings: readonly SettlementPostings[]): SettlementMonth[] {
  if (postings.some((p) => p.month === null)) return [];
  const have = new Set(postings.map((p) => p.month));
  return months.months.filter((m) => !have.has(m.month));
}

// Whether the settlement's posting stands: no sale waits for its day and every month has a voucher that is not reversed (or a whole-settlement voucher that is not). A settlement with no month to
// post (every net zero) has none standing either: nothing was posted, so it is not "posted".
export function fullyPosted(months: SettlementMonths, postings: readonly SettlementPostings[]): boolean {
  if (months.waiting > 0) return false;
  if (postings.some((p) => p.month === null && !p.reversed)) return true;
  if (months.months.length === 0) return false;
  const standing = new Set(postings.filter((p) => !p.reversed).map((p) => p.month));
  return months.months.every((m) => standing.has(m.month));
}
