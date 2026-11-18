// SPDX-License-Identifier: AGPL-3.0-only
// The wording of a consumer buyer on a coded sales e-invoice (#3709, research E row 6).
import { describe, expect, it } from 'vitest';
import { CONSUMER_BUYER_LABEL, buyerNameOnInvoice } from '../src/index.ts';

describe('the consumer label', () => {
  it('is "Bán cho người tiêu dùng" and not the cash-register wording', () => {
    expect(CONSUMER_BUYER_LABEL).toBe('Bán cho người tiêu dùng');
    expect(CONSUMER_BUYER_LABEL).not.toContain('không lấy hóa đơn');
  });
  it('replaces the name of a consumer only', () => {
    expect(buyerNameOnInvoice('consumer', null)).toBe('Bán cho người tiêu dùng');
    expect(buyerNameOnInvoice('consumer', 'Left over from the form')).toBe('Bán cho người tiêu dùng');
    expect(buyerNameOnInvoice('individual', 'Nguyễn Văn A')).toBe('Nguyễn Văn A');
    expect(buyerNameOnInvoice('business', null)).toBeNull();
  });
});
