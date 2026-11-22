// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the expense variance card on the Kế toán Tổng quan (#4392): the months the picker offers and how a change reads. The server decides every figure and every flag; nothing here recomputes one.
import { EXPENSE_VARIANCE_PICKER_MONTHS, type ExpenseVarianceCompare, type FinanceExpenseVariance } from '@ludy/kernel-contract';
import { toUnits } from './decimal.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** The months the picker offers: the last ones that have ended, the newest first (`today` is 'YYYY-MM-DD', Vietnam). The running month is not offered: only an ended month is compared. */
export function pickerMonths(today: string): string[] {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const here = year * 12 + (month - 1);
  return Array.from({ length: EXPENSE_VARIANCE_PICKER_MONTHS }, (_, i) => {
    const index = here - 1 - i;
    return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
  });
}

/** The month the card opens on: the last one that has ended. */
export const defaultMonth = (today: string): string => pickerMonths(today)[0] as string;

export type ChangeKind = 'none' | 'flat' | 'up' | 'down';

/** How a comparison reads: no comparison could be made, no change, or the direction of the change (read from the exact decimal string, whatever decimals the server sends). */
export function changeKind(compare: Pick<ExpenseVarianceCompare, 'change'>): ChangeKind {
  if (compare.change === null) return 'none';
  const units = toUnits(compare.change);
  return units > 0n ? 'up' : units < 0n ? 'down' : 'flat';
}

/** The size of a change without its sign (the arrow and the words say the direction). */
export const sizeOf = (value: string): string => value.replace(/^-/, '');

/** A month as people write it: 'MM/YYYY'. */
export const monthText = (month: string): string => `${month.slice(5)}/${month.slice(0, 4)}`;

/** Whether the entity's books begin after the first day of the months the card compares with (a basis month that is not there, as against one in another chart). */
export function startsAfterBasis(data: Pick<FinanceExpenseVariance, 'booksStart' | 'averageMonths'>): boolean {
  const first = data.averageMonths[0];
  return data.booksStart !== null && first !== undefined && data.booksStart > `${first}-01`;
}
