// SPDX-License-Identifier: AGPL-3.0-only
// The Decree 174 VAT cut as the household books show it (#3710 slice 2, plan docs/plan/stock-and-marketplaces.md section 8.5), shared by S2a, S2b and the 01/CNKD so the three cannot disagree.
// - The cut is a dated row of household_tax_reduction (kind `vat`), read on the period's last day like the trade rates: never a constant, and a row of 0 ends it.
// - It is NOT applied to all revenue by default (the PO's decision of 2026-11-18): the household's own answer in its profile decides. yes applies it, no applies none, not answered computes without it
//   and also shows what the VAT would be if the household were eligible (`ifEligible`), so the household sees what the answer is worth.
// - The cut of a line is the cut percentage of that line's VAT (already rounded to a whole dong), rounded to a whole dong; the VAT payable is the VAT less the cut. Nothing is ever negative.
// Amounts are decimal strings through decimal.js, never JS numbers.
import type { HouseholdTrade, HouseholdVatCut, HouseholdVatCutAnswer } from '@crove/kernel-contract';
import type { QueryContext } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { pickInForce } from './domain/household-rules.ts';
import { taxOn } from './domain/household-tax.ts';

type Ctx = Pick<QueryContext, 'trx'>;

export interface VatCutRow {
  percent: string;
  effectiveFrom: string;
  status: string;
}

export interface ReductionRow extends VatCutRow {
  // The yearly revenue up to which the cut holds (the PIT cut of Decree 398: 10 billion VND); null when it has no ceiling.
  ceiling: string | null;
}

// The reduction of a tax in force on `date`, or null when no row covers it (the books then cut nothing).
export async function reductionInForce(ctx: Ctx, kind: 'vat' | 'pit', date: string): Promise<ReductionRow | null> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.household_tax_reduction')
    .select(['kind', 'effective_from', 'cut_percent', 'revenue_ceiling', 'status'])
    .where('kind', '=', kind)
    .where('effective_from', '<=', date)
    .execute();
  const row = pickInForce(rows, (r) => r.kind, date)[0];
  return row ? { percent: toMoney(money(row.cut_percent)), ceiling: row.revenue_ceiling === null ? null : toMoney(money(row.revenue_ceiling)), effectiveFrom: row.effective_from, status: row.status } : null;
}

// The VAT cut in force on `date`, or null when no row covers it (the books then cut nothing).
export async function vatCutInForce(ctx: Ctx, date: string): Promise<VatCutRow | null> {
  return reductionInForce(ctx, 'vat', date);
}

// The block a book carries. `lines` follow the book's lines (trade and VAT); `complete` is whether every part of the revenue has a trade, the same condition as the book's totals.
export function vatCutBlock(args: { answer: HouseholdVatCutAnswer | null; cut: VatCutRow | null; lines: ReadonlyArray<{ trade: HouseholdTrade; vat: string }>; complete: boolean }): HouseholdVatCut {
  const percent = args.cut ? args.cut.percent : toMoney(money(0));
  const inForce = money(percent).gt(0);
  const applied = args.answer === 'yes' && inForce;
  // What the cut would be on a line, used for the applied cut and for the "if eligible" figure alike.
  const cutOf = (vat: string) => (inForce ? taxOn(vat, percent) : '0');
  const lines = args.lines.map((l) => {
    const cut = applied ? cutOf(l.vat) : toMoney(money(0));
    return { trade: l.trade, cut, vatPayable: toMoney(money(l.vat).minus(cut)) };
  });
  const totalOf = (parts: ReadonlyArray<{ cut: string; vatPayable: string }>) => ({ cut: toMoney(sum(parts.map((p) => p.cut))), vatPayable: toMoney(sum(parts.map((p) => p.vatPayable))) });
  const total = args.complete ? totalOf(lines) : null;
  const ifEligible =
    args.answer === null && inForce && args.complete ? totalOf(args.lines.map((l) => ({ cut: cutOf(l.vat), vatPayable: toMoney(money(l.vat).minus(cutOf(l.vat))) }))) : null;
  return { answer: args.answer, percent, applied, lines, total, ifEligible };
}

// The unconfirmed-row entry for the cut: only a cut the book really relies on (applied, or shown as the "if eligible" figure) can make the book provisional. A cut the result does not use
// (the answer is no, no cut is in force, or the parts are not all on a trade yet, so no "if eligible" figure is given) adds nothing.
export function vatCutUnconfirmed(block: HouseholdVatCut, cut: VatCutRow | null): { kind: 'reduction'; key: string; effectiveFrom: string } | null {
  if (!cut || cut.status === 'confirmed') return null;
  if (!block.applied && block.ifEligible === null) return null;
  return { kind: 'reduction', key: 'vat', effectiveFrom: cut.effectiveFrom };
}
