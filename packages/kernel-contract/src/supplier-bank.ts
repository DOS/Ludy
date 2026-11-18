// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts and the history of their changes (#3113 S1). The full number is sealed and never leaves the server through any of these: an account is shown by its bank and its
// last four digits. A change adds, replaces or retires an account, each with a fresh second factor, and writes one history row.
import { z } from 'zod';

export const SUPPLIER_BANK_ACCOUNT_STATUSES = ['active', 'retired'] as const;
export const SUPPLIER_BANK_ACCOUNT_CHANGE_KINDS = ['added', 'replaced', 'retired'] as const;

// What a person types: digits, with the spaces, dots and dashes banks print between groups; the server keeps the digits, 6 to 20 of them.
const zNumberText = z.string().trim().min(6).max(40);
const zBankName = z.string().trim().min(1).max(100);
const zHolder = z.string().trim().min(1).max(200);

export const zSupplierBankAccountAdd = z.strictObject({ partyId: z.uuid(), bankName: zBankName, accountHolder: zHolder, accountNumber: zNumberText });
export const zSupplierBankAccountReplace = z.strictObject({ accountId: z.uuid(), bankName: zBankName, accountHolder: zHolder, accountNumber: zNumberText });
export const zSupplierBankAccountRetire = z.strictObject({ accountId: z.uuid() });
export const zSupplierBankAccountErase = z.strictObject({ partyId: z.uuid() });
export const zSupplierBankAccountListInput = z.strictObject({ partyId: z.uuid() });

export const zSupplierBankAccount = z.strictObject({
  id: z.uuid(),
  partyId: z.uuid(),
  bankName: z.string(),
  last4: z.string().regex(/^[0-9]{4}$/),
  status: z.enum(SUPPLIER_BANK_ACCOUNT_STATUSES),
  createdAt: z.string(),
  retiredAt: z.string().nullable(),
});
export type SupplierBankAccount = z.infer<typeof zSupplierBankAccount>;

export const zSupplierBankAccountChange = z.strictObject({
  id: z.uuid(),
  accountId: z.uuid(),
  kind: z.enum(SUPPLIER_BANK_ACCOUNT_CHANGE_KINDS),
  changedAt: z.string(),
});
export type SupplierBankAccountChangeRow = z.infer<typeof zSupplierBankAccountChange>;

export const zSupplierBankAccountList = z.strictObject({ accounts: z.array(zSupplierBankAccount), changes: z.array(zSupplierBankAccountChange) });
export type SupplierBankAccountList = z.infer<typeof zSupplierBankAccountList>;

// An erasure answers how many keys it deleted and how many accounts it retired, nothing of any number.
export const zSupplierBankAccountErased = z.strictObject({ partyId: z.uuid(), shreddedKeys: z.number().int().nonnegative(), retired: z.number().int().nonnegative() });
export type SupplierBankAccountErased = z.infer<typeof zSupplierBankAccountErased>;
