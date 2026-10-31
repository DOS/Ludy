// SPDX-License-Identifier: AGPL-3.0-only
// The number of a bank account as the books keep it (#2183): only its digits, 6 to 20 of them, whatever grouping the bank
// prints (spaces, dots or dashes between groups). Shared by the recording of a number (bank-account-number.ts) and the
// statement path (bank-statement-file.ts), which compare digits alone.

// The digits of a typed number, or null when it holds anything but digits and the usual group separators, or has fewer
// than 6 or more than 20 digits.
export function accountNumberDigits(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  return /^\d{6,20}$/.test(digits) ? digits : null;
}

// The number with all but its last digits hidden: enough to tell which account is meant, never the number itself. The
// last four digits, or fewer for a short number (never more than half of it less one, at least two), so most of it is
// always hidden.
export function maskAccountNumber(digits: string): string {
  const shown = Math.max(2, Math.min(4, Math.floor(digits.length / 2) - 1));
  return `${'*'.repeat(Math.min(digits.length - shown, 8))}${digits.slice(-shown)}`;
}
