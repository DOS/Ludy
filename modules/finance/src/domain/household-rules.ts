// SPDX-License-Identifier: AGPL-3.0-only
// The law of the household books is data with an effective date (household_threshold, household_trade_rate, household_expense_group_map, household_form_version; #2517): for one key (a threshold
// code, a trade, an account prefix, a book) the row in force on a date is the latest whose effective date is on or before it. A new dated row therefore changes the periods that start on or after
// its date and no earlier one, so a closed period keeps the rate it was made under. Pure: dates are 'YYYY-MM-DD' strings, which order the same as the days they name.
export interface DatedRow {
  effective_from: string;
}

export function pickInForce<T extends DatedRow>(rows: readonly T[], keyOf: (row: T) => string, date: string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    if (row.effective_from > date) continue;
    const key = keyOf(row);
    const held = best.get(key);
    if (!held || row.effective_from > held.effective_from) best.set(key, row);
  }
  return [...best.values()];
}
