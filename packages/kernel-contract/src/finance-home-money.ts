// SPDX-License-Identifier: AGPL-3.0-only
// The three money tiles on Home (#4785): what customers still owe the org (Chưa thu), what the org still owes suppliers (Chưa trả) and the money in the
// bank (Tiền ngân hàng), as of one day. The finance module decides every figure from the books (the first two are B01-DNN's lines 131 and 311, the third
// the net of the 112 accounts) and who may see them; the screen shows them. Amounts are decimal strings in the book currency.
import { z } from 'zod';
import { zLocalDate, zMoney } from './schemas.ts';

// The bank accounts Home lists under the bank figure; the figure itself always counts every account.
export const HOME_MONEY_BANK_ACCOUNTS_MAX = 5;

export const zFinanceHomeMoneyInput = z.strictObject({ asOf: zLocalDate.optional() });
export type FinanceHomeMoneyInput = z.infer<typeof zFinanceHomeMoneyInput>;

export const zHomeMoneyBankAccount = z.strictObject({ code: z.string().min(1).max(40), name: z.string().nullable(), balance: zMoney });
export type HomeMoneyBankAccount = z.infer<typeof zHomeMoneyBankAccount>;

// available false: the caller may not see the org's money totals, or the books are not one entity's the caller can read without choosing (several legal
// entities); nothing else is said, so the answer tells a refused member nothing about the books.
export const zFinanceHomeMoney = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({
    available: z.literal(true),
    asOf: zLocalDate,
    // B01 line 131: the debit balances of the customers' accounts, per customer.
    receivables: zMoney,
    // B01 line 311: the credit balances of the suppliers' accounts, per supplier.
    payables: zMoney,
    // The net balance of the 112 accounts (an overdrawn account counts below zero).
    bank: zMoney,
    // The largest bank accounts by size of balance, at most HOME_MONEY_BANK_ACCOUNTS_MAX, and how many accounts have a balance that is not zero.
    bankAccounts: z.array(zHomeMoneyBankAccount).max(HOME_MONEY_BANK_ACCOUNTS_MAX),
    bankAccountCount: z.number().int().nonnegative(),
  }),
]);
export type FinanceHomeMoney = z.infer<typeof zFinanceHomeMoney>;
