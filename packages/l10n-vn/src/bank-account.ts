// SPDX-License-Identifier: AGPL-3.0-only
// The digit runs of a bank account as it is compared (#2426), one rule for the check that warns when a vendor's account changed (modules/finance) and for the check that a model's reading of an account is in the
// document's own text (packages/agent). Digits joined by ONE space, dot or dash are one run ("0011 2233 4455"); anything else between digits (a " - " note, a line break, a letter) ends it. A run counts from
// BANK_ACCOUNT_RUN_MIN digits, so a bank name in brackets, "N/A", a branch note or a short code is no account. Nothing is guessed: text with no such run has no account to compare.
const BANK_ACCOUNT_RUN_MIN = 6;

export function bankAccountRuns(account: string): string[] {
  const joined = account.replace(/(?<=\d)[ .-](?=\d)/g, '');
  return [...new Set(joined.match(new RegExp(`\\d{${BANK_ACCOUNT_RUN_MIN},}`, 'g')) ?? [])];
}
