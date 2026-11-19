// SPDX-License-Identifier: AGPL-3.0-only
// The "it already exists" checks of the add dialogs in Settings (#3608): while a person types, the dialog shows the record that
// the new one would repeat (HubSpot, Attio). The dialog keeps its save button off while one stands (the server refuses the same
// cases); the server still decides, so a repeat that differs in a way these helpers do not see is refused there with its own reason. Each takes the rows the card already read, so no request is made.
import { normalizeAccountCode } from '@crove/kernel-contract';
import { keywordRuleText } from '@crove/l10n-vn';

// What a bank prints between the digit groups is dropped; the module keeps the digits (zBankAccountNumberSet).
export const digitsOf = (input: string): string => input.replace(/\D/g, '');

// The recorded number that the typed one repeats, in any bank account of the org (one number belongs to one bank account).
export function duplicateBankNumber<T extends { accountNumber: string }>(rows: readonly T[], typed: string): T | null {
  const digits = digitsOf(typed);
  if (digits === '') return null;
  return rows.find((row) => digitsOf(row.accountNumber) === digits) ?? null;
}

// The account whose code the typed one repeats (a code is stored trimmed with its tag in upper case).
export function duplicateAccountCode<T extends { code: string }>(accounts: readonly T[], typed: string): T | null {
  const code = normalizeAccountCode(typed);
  if (code === '') return null;
  return accounts.find((account) => account.code === code) ?? null;
}

// A keyword rule's text as the server stores it (accents, case, punctuation and spacing do not count), so "Cước-Internet" repeats "cuoc internet".
export const keywordKey = (input: string): string => keywordRuleText(input) ?? '';

// The keyword rule for every vendor that the typed one repeats: the dialog adds a rule of that scope, and a rule of one vendor's own may stand beside it.
export function duplicateKeywordRule<T extends { matchKind: string; matchText: string; vendor: unknown }>(rules: readonly T[], typed: string): T | null {
  const key = keywordKey(typed);
  if (key === '') return null;
  return rules.find((rule) => rule.matchKind === 'keyword' && rule.vendor == null && rule.matchText === key) ?? null;
}

// An invited address that already belongs to a member, or that already has an invitation waiting.
export function invitedEmailState(email: string, members: readonly { email: string }[], invites: readonly { email: string; status?: string }[]): 'member' | 'invited' | null {
  const key = email.trim().toLowerCase();
  if (key === '') return null;
  if (members.some((m) => m.email.trim().toLowerCase() === key)) return 'member';
  if (invites.some((i) => i.email.trim().toLowerCase() === key && i.status !== 'expired')) return 'invited';
  return null;
}
