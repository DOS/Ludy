// SPDX-License-Identifier: AGPL-3.0-only
// The number of a bank account as the books keep it (#2183): only its digits, 6 to 20 of them, whatever grouping the bank
// prints (spaces, dots or dashes between groups). Shared by the recording of a number (bank-account-number.ts) and the
// statement path (bank-statement-file.ts), which compare digits alone.
import { sql } from 'kysely';
import type { QueryContext } from '@crove/kernel-runtime';

// The digits of a typed number, or null when it holds anything but digits and the usual group separators, or has fewer
// than 6 or more than 20 digits.
export function accountNumberDigits(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  return /^\d{6,20}$/.test(digits) ? digits : null;
}

// The digits of a bank feed account's external id, as the statement path compares them (bank-statement-file.ts strips every
// non-digit in SQL, so an id such as `SBX-7770001111` is the number 7770001111). Whatever it holds, never null: an id with
// no digit gives ''.
export function feedAccountDigits(externalAccountId: string): string {
  return externalAccountId.replace(/[^0-9]/g, '');
}

// The bank accounts and legal entities the org's own number `digits` is mapped to: by a bank feed mapping (#2099), whose number is the
// digits of its external account id, or by a number an owner or admin recorded on the bank account itself (#2183). One place for what
// counts as the org's own account number, for routing a statement (bank-statement-file.ts) and for learning no rule from it
// (bank-rules.ts). Read under the caller's own row security.
export async function mappedAccounts(ctx: QueryContext, digits: string): Promise<Array<{ bank_account: string; legal_entity_id: string }>> {
  const fed = await ctx.trx
    .selectFrom('crove_finance.bank_feed_account')
    .select(['bank_account', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where(sql<boolean>`pg_catalog.regexp_replace(external_account_id, '[^0-9]', '', 'g') = ${digits}`)
    .execute();
  const recorded = await ctx.trx
    .selectFrom('crove_finance.bank_account_number')
    .select(['bank_account', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('account_number', '=', digits)
    .execute();
  return [...fed, ...recorded];
}

// The number with all but its last digits hidden: enough to tell which account is meant, never the number itself. The
// last four digits, or fewer for a short number (never more than half of it less one, at least two), so most of it is
// always hidden.
export function maskAccountNumber(digits: string): string {
  const shown = Math.max(2, Math.min(4, Math.floor(digits.length / 2) - 1));
  return `${'*'.repeat(Math.min(digits.length - shown, 8))}${digits.slice(-shown)}`;
}
