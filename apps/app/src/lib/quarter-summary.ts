// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the quarter card on the Kế toán Tổng quan (#5183): the quarters the picker offers and how a label reads. The server decides every figure and every label; nothing here recomputes one.
import { QUARTER_SUMMARY_PICKER_QUARTERS, type QuarterSummaryFigure, type QuarterTrend } from '@ludy/kernel-contract';

/** The quarters the picker offers: the last ones that have ended, the newest first (`today` is 'YYYY-MM-DD', Vietnam). The running quarter is not offered: only an ended quarter is summed. */
export function pickerQuarters(today: string): string[] {
  const year = Number(today.slice(0, 4));
  const here = year * 4 + Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  return Array.from({ length: QUARTER_SUMMARY_PICKER_QUARTERS }, (_, i) => {
    const index = here - 1 - i;
    return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
  });
}

/** The quarter the card opens on: the last one that has ended. */
export const defaultQuarter = (today: string): string => pickerQuarters(today)[0] as string;

/** A quarter as parts for the screen's own words ("Quarter 3 of 2026"). */
export function quarterParts(quarter: string): { year: string; n: string } {
  return { year: quarter.slice(0, 4), n: quarter.slice(6) };
}

export const TREND_ARROW: Record<QuarterTrend, string> = { rose: '▲', fell: '▼', steady: '■', first_time: '●', none: '' };

/** Whether a row has any comparison to show: both labels none means there is nothing to say about it. */
export const hasComparison = (figure: Pick<QuarterSummaryFigure, 'vsPrevious' | 'vsLastYear'>): boolean => figure.vsPrevious !== 'none' || figure.vsLastYear !== 'none';
