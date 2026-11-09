// SPDX-License-Identifier: AGPL-3.0-only
// Whether a bank statement line's description names the payroll payment it may be (#2532): the words a person writes when paying wages, insurance, the union fee or personal income tax. It only ranks a
// candidate whose amount already equals the line's; the amount decides, never the words. Pure.
import type { PayrollPaymentKind } from '@crove/kernel-contract';
import { foldVietnamese } from './portal-status.ts';

// Folded (no diacritics, lower case) words, as a Vietnamese description writes them.
const WORDS: Record<PayrollPaymentKind, readonly RegExp[]> = {
  net_pay: [/\bluong\b/, /\btra luong\b/, /\bsalary\b/, /\bpayroll\b/],
  insurance: [/\bbhxh\b/, /\bbhyt\b/, /\bbhtn\b/, /\bbao hiem\b/, /\binsurance\b/],
  union: [/\bcong doan\b/, /\bkpcd\b/, /\bunion\b/],
  tax: [/\bthue\b/, /\btncn\b/, /\bpit\b/, /\bpersonal income tax\b/],
};

export function payrollPaymentMention(description: string, kind: PayrollPaymentKind): boolean {
  const text = foldVietnamese(description);
  return WORDS[kind].some((word) => word.test(text));
}
