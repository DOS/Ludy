// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the Kế toán Tổng quan screen (#2631): how a card's change reads (its direction and whether it is good news), and the sizes of the bars of
// the six-month chart. Amounts are decimal strings; the bars use the exact ledger units (bigint), and only the final ratio is a number, for a CSS height.
import type { FinanceOverview, OverviewFigure } from '@crove/kernel-contract';
import { toUnits } from './decimal.ts';

export type OverviewCard = 'cash' | 'profit' | 'receivables' | 'payables';
export const OVERVIEW_CARDS: readonly OverviewCard[] = ['cash', 'profit', 'receivables', 'payables'];

export type Direction = 'up' | 'down' | 'flat';
export type Tone = 'good' | 'bad' | 'neutral';

export function directionOf(figure: Pick<OverviewFigure, 'change'>): Direction {
  const units = toUnits(figure.change);
  return units > 0n ? 'up' : units < 0n ? 'down' : 'flat';
}

// More cash and more profit are good news and less is bad; what customers owe and what is owed to suppliers can move either way for good reasons, so their
// change is shown without a color.
export function toneOf(card: OverviewCard, direction: Direction): Tone {
  if (direction === 'flat' || (card !== 'cash' && card !== 'profit')) return 'neutral';
  return (card === 'cash' || card === 'profit') === (direction === 'up') ? 'good' : 'bad';
}

// The percent of a figure's change as the card shows it: the size with no sign (the arrow says the direction), "." turned to the locale's separator by the caller.
export function percentSize(figure: Pick<OverviewFigure, 'changePercent'>): string | null {
  return figure.changePercent === null ? null : figure.changePercent.replace(/^-/, '');
}

export interface Bar {
  month: string;
  // Heights in percent of the tallest bar, 0 to 100, for revenue and costs; profit is its own, signed, bar below.
  revenue: number;
  costs: number;
  profit: number;
  profitNegative: boolean;
}

// Each month's revenue, costs and profit as a share of the largest of them over the six months, to one decimal; all zero when there is nothing to show.
export function chartBars(months: FinanceOverview['months']): Bar[] {
  const abs = (value: string) => {
    const units = toUnits(value);
    return units < 0n ? -units : units;
  };
  let max = 0n;
  for (const m of months) for (const v of [m.revenue, m.costs, m.profit]) if (abs(v) > max) max = abs(v);
  const share = (value: string) => (max === 0n ? 0 : Number((abs(value) * 1000n) / max) / 10);
  return months.map((m) => ({ month: m.month, revenue: share(m.revenue), costs: share(m.costs), profit: share(m.profit), profitNegative: toUnits(m.profit) < 0n }));
}

// Whether the six months have anything to draw.
export const chartHasData = (months: FinanceOverview['months']): boolean => months.some((m) => toUnits(m.revenue) !== 0n || toUnits(m.costs) !== 0n || toUnits(m.profit) !== 0n);

// 'YYYY-MM' as the chart's label ("T9" style is the screen's; here the month number without the zero).
export const monthNumber = (month: string): number => Number(month.slice(5));
