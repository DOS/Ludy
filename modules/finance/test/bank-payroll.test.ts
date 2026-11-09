// SPDX-License-Identifier: AGPL-3.0-only
// The words of a bank statement description that name a payroll payment (#2532): they only rank a candidate whose amount already equals the line's.
import { describe, expect, it } from 'vitest';
import { payrollPaymentMention } from '../src/domain/bank-payroll.ts';

describe('payrollPaymentMention', () => {
  it('reads the words a Vietnamese description writes, with or without diacritics and in any case', () => {
    expect(payrollPaymentMention('CK TRẢ LƯƠNG THÁNG 03', 'net_pay')).toBe(true);
    expect(payrollPaymentMention('Nop BHXH T03', 'insurance')).toBe(true);
    expect(payrollPaymentMention('nộp bảo hiểm xã hội', 'insurance')).toBe(true);
    expect(payrollPaymentMention('KPCD quy 1', 'union')).toBe(true);
    expect(payrollPaymentMention('Nộp thuế TNCN tháng 3', 'tax')).toBe(true);
  });
  it('does not read a kind into the words of another, nor part of a longer word', () => {
    expect(payrollPaymentMention('Nop BHXH T03', 'net_pay')).toBe(false);
    expect(payrollPaymentMention('Tra luong', 'tax')).toBe(false);
    expect(payrollPaymentMention('Giao dich', 'net_pay')).toBe(false);
    expect(payrollPaymentMention('luongson shop', 'net_pay')).toBe(false);
  });
});
