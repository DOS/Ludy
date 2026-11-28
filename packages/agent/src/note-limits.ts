// SPDX-License-Identifier: AGPL-3.0-only
// The length limits of the one-sentence notes of the finance coworkers, in a module with no import at all (#5257). expense-variance.ts and unusual-entries.ts take them from here, never from each other:
// unusual-entries.ts is reached through src/index.ts while expense-variance.ts is still loading (expense-variance.ts -> conversation.ts -> index.ts -> ... -> unusual-entries.ts), so a constant it read from
// expense-variance.ts at its top level was still in its temporal dead zone and threw when expense-variance.ts was imported first on its own (as #4022 did for the MISA and AMIS notes). A leaf is loaded
// whole before anything that imports it runs, in whichever order the cycle is entered.

/** The most characters one sentence of an expense variance note may have. */
export const EXPENSE_VARIANCE_NOTE_MAX = 220;

/** The most characters one sentence of a note on an unusual posted entry may have: the same limit as the expense variance note, its text checks being the same. */
export const UNUSUAL_ENTRIES_NOTE_MAX = EXPENSE_VARIANCE_NOTE_MAX;
