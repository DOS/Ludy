// SPDX-License-Identifier: AGPL-3.0-only
// The months a stored marketplace settlement is posted in (#2516, the rework to the AI consensus of 2026-11-15, slice C1; plan docs/plan/stock-and-marketplaces.md section 8.4). Revenue belongs to the
// month of successful delivery (working answer A5 of #2520, pending the accountant), and an entry has one date, so a settlement posts as one voucher per month. Pure functions over decimal strings
// (settlementMonthsOf), the reads that give them the delivery day of each settlement line and the vouchers that already exist (settlementMonthsFor, postingsOf), and the question the rest of the
// slice asks (whether the settlement's posting stands). A settlement is posted by ONE proposal that posts the voucher of every month in one transaction. The rules:
// - the sale of a settlement line (sales less the seller's discount) belongs to the month of its order's delivery day (the latest `delivered_at` of the order's lines); a line with no usable day makes
//   the settlement WAIT ("chờ ngày giao"): nothing is dated by a guess, and nothing is posted until every sale has its day;
// - a refund belongs to the month of the settlement's last day (the refund reduces revenue in the period it occurs, PO decision 2026-11-08);
// - a line refunded at least as much as it sold needs no delivery day: it is the refund in the month of the settlement's last day, sale and refund together;
// - the tax the platform withheld on a line goes with the piece that holds the line's sale (the month of its delivery, or the refund month for a line refunded at least as much as it sold);
// - each piece carries `rateDate`, the day whose VAT rate applies (#4303 S3b): the delivery day of a sale and of the refund of that sale, also for a line refunded at least as much as it sold when its delivery
//   day is known (rule 8: a refund takes the rate of the sale it reverses, exactly where the rate changes); a piece with no usable delivery day takes the date of the entry;
// - a month whose net is zero is KEPT while it holds pieces: pieces at different VAT rates, or a refund at the rate of an earlier sale, can net to zero while 33311 is not, so whether a month has an entry is
//   known only with the rates (entryIsEmpty, offeredMonths in marketplace-settlement-vat.ts); a month with a negative net runs the entry the other way (the platform owing less).
import { money, sum, toMoney } from '@crove/l10n-vn';
import type { QueryContext } from '@crove/kernel-runtime';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import type { SettlementPostingLine } from './marketplace-settlement-posting.ts';
import { reversedSource } from './source-entry.ts';

export interface SettlementMonthLine {
  sales: string;
  sellerDiscount: string;
  refund: string;
  // The tax the platform withheld on the line (a household seller; the settlement posting credits it to 3331 and 3335).
  taxWithheld: string;
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
  // Sales less seller discounts less refunds of the month, signed; zero only for a month that carries withheld tax.
  net: string;
}

export interface SettlementMonths {
  months: SettlementMonth[];
  // Settlement lines whose sale has no usable delivery day: while there is one, nothing is posted.
  waiting: number;
}

export const lastDayOf = (month: string): string => {
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
      put(endMonth, { sales: l.sales, sellerDiscount: l.sellerDiscount, refund: l.refund, taxWithheld: l.taxWithheld, rateDate: l.deliveredOn !== null && l.deliveredOn <= periodTo ? l.deliveredOn : null });
      continue;
    }
    // A delivery after the settlement's last day cannot be what the platform paid for: the day is not usable, the line waits.
    if (l.deliveredOn === null || l.deliveredOn.slice(0, 7) > endMonth) {
      waiting += 1;
      continue;
    }
    put(l.deliveredOn.slice(0, 7), { sales: l.sales, sellerDiscount: l.sellerDiscount, refund: '0', taxWithheld: l.taxWithheld, rateDate: l.deliveredOn });
    // The refund of this sale takes the rate of the sale it reverses.
    if (!money(l.refund).isZero()) put(endMonth, { sales: '0', sellerDiscount: '0', refund: l.refund, taxWithheld: '0', rateDate: l.deliveredOn });
  }
  const months: SettlementMonth[] = [];
  for (const month of [...buckets.keys()].sort()) {
    const pieces = buckets.get(month) ?? [];
    const net = money(toMoney(sum(pieces.map((p) => p.sales)))).minus(money(toMoney(sum(pieces.map((p) => p.sellerDiscount))))).minus(money(toMoney(sum(pieces.map((p) => p.refund)))));
    // A month with a zero net is kept: its VAT may not be zero, or the platform may have withheld tax on its lines, and only the entry built with the rates says whether it has anything to post.
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
        'l.tax_withheld',
        eb
          .selectFrom('crove_finance.channel_order_line as ol')
          .select((x) => x.fn.max('ol.delivered_at').as('d'))
          .whereRef('ol.org_id', '=', 'l.org_id')
          .whereRef('ol.legal_entity_id', '=', 'l.legal_entity_id')
          .whereRef('ol.order_id', '=', 'l.order_id')
          .as('delivered_on'),
      ])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.settlement_id', 'in', ids.slice(i, i + 500))
      .execute();
    for (const r of rows) {
      byId.get(r.settlement_id)?.push({ sales: r.sales, sellerDiscount: r.seller_discount, refund: r.refund, taxWithheld: r.tax_withheld, deliveredOn: r.delivered_on === null ? null : String(r.delivered_on).slice(0, 10) });
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

// Whether the settlement's posting stands. All the months of a settlement are posted together by one proposal in one transaction, so a settlement either has all its vouchers or none: it is posted when
// it has vouchers and none is reversed. (One month reversed, with the others standing, is not posted: the payout is refused until the accountant has put the settlement right.)
export const settlementPosted = (postings: readonly SettlementPostings[]): boolean => postings.length > 0 && postings.every((p) => !p.reversed);

// The VAT and the PIT the settlement's vouchers credited to the two tax accounts (slice C2), exactly as posted: the sums of the credits of their entries' lines on the accounts the map names (a
// sub-account counts with its parent). The payout debits these amounts, so the accounts net to zero whatever rounding each month's split did. Zero when the settlement credited none.
export async function postedSettlementTax(ctx: Ctx, settlementId: string, vatCode: string, pitCode: string, outputVatCode?: string): Promise<{ vat: string; pit: string }> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .innerJoin('crove_finance.journal_entry as e', (join) =>
      join.onRef('e.org_id', '=', 'j.org_id').onRef('e.source_id', '=', 'j.id').on('e.source_type', '=', JOURNAL_VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null),
    )
    .innerJoin('crove_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'e.org_id').onRef('l.entry_id', '=', 'e.id'))
    .select(['l.account_code'])
    .select((eb) => eb.fn.sum<string>('l.credit').as('credit'))
    .where('j.org_id', '=', ctx.orgId)
    .where('j.settlement_id', '=', settlementId)
    .where((eb) => eb.or([eb('l.account_code', 'like', `${vatCode}%`), eb('l.account_code', 'like', `${pitCode}%`)]))
    .groupBy('l.account_code')
    .execute();
  let vat = money('0');
  let pit = money('0');
  for (const r of rows) {
    // The output VAT of the sales (33311, #4303 S3b) is a sub-account of the withheld-VAT account but is VAT the seller owes the tax office: the payout never debits it, so it is not counted here.
    if (outputVatCode && r.account_code.startsWith(outputVatCode)) continue;
    if (r.account_code.startsWith(vatCode)) vat = vat.plus(money(r.credit));
    else pit = pit.plus(money(r.credit));
  }
  return { vat: toMoney(vat), pit: toMoney(pit) };
}
