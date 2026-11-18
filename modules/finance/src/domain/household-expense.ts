// SPDX-License-Identifier: AGPL-3.0-only
// The expense side of the household income-method books (#2517, S2c): which journal lines are expenses and which group of Circular 152's expense detail each belongs to. The map from an account to its group is
// DATA (household_expense_group_map, dated rows with a source and a status), never a constant here: a row names an account prefix, the row in force on the period's last day for a prefix is the latest dated
// one, and the longest prefix that an account code starts with decides, so a row for 6421 can refine a row for 642. An expense account no row covers has no group (null): the book shows it apart and never
// guesses. Pure, dates as 'YYYY-MM-DD' strings.
import { pickInForce } from './household-rules.ts';

export interface ExpenseGroupRow {
  expense_group: string;
  account_prefix: string;
  effective_from: string;
  status: string;
}

// TT133 expense accounts are classes 6 (costs) and 8 (other expenses); revenue is class 5 and 7, so a line on a class 6 or 8 account (or one of its sub-accounts) is an expense line.
export function isExpenseAccount(accountCode: string): boolean {
  return /^[68]/.test(accountCode);
}

// The map row that decides an account's group on a date: among the rows in force on `date` (the latest per prefix), the one with the longest prefix the account code starts with. Null when none does.
export function groupRowFor<T extends ExpenseGroupRow>(accountCode: string, rows: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const row of pickInForce(rows, (r) => r.account_prefix, date)) {
    if (!accountCode.startsWith(row.account_prefix)) continue;
    if (best === null || row.account_prefix.length > best.account_prefix.length) best = row;
  }
  return best;
}
