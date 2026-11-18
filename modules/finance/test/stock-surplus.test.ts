// SPDX-License-Identifier: AGPL-3.0-only
// The resolution of the surplus of a count (#3712 slice 2a), the pure part: the surplus of a count from its adjustments, the two lines of the voucher, its words, and the check that a stored proposal is
// exactly the voucher the books call for.
import { describe, expect, it } from 'vitest';
import { isSurplusVoucher, surplusAmount, surplusDescription, surplusVoucherLines } from '../src/domain/stock-surplus.ts';

const party = { id: '01a1ee9a-4f9f-7f8f-883c-beff573110cc', name: 'Công ty Cung ứng Mẫu', taxCode: '0101234564' };

describe('surplusAmount', () => {
  it('sums only the adjustments that brought value in, in whole dong', () => {
    expect(surplusAmount([{ amount: '150' }, { amount: '-200' }, { amount: '1000000' }])).toBe('1000150');
    expect(surplusAmount([{ amount: '-200' }])).toBe('0');
    expect(surplusAmount([])).toBe('0');
    expect(surplusAmount([{ amount: '12.4000' }, { amount: '0.4' }])).toBe('13');
  });
});

describe('surplusVoucherLines', () => {
  it('debits 3381 and credits the account chosen, naming the supplier on 331 only', () => {
    expect(surplusVoucherLines('150', '711', null)).toEqual([
      { account: '3381', partyId: null, debit: '150', credit: '0' },
      { account: '711', partyId: null, debit: '0', credit: '150' },
    ]);
    expect(surplusVoucherLines('150', '3388', party.id)[1]).toMatchObject({ account: '3388', partyId: null });
    expect(surplusVoucherLines('150', '331', party.id)[1]).toMatchObject({ account: '331', partyId: party.id });
  });
});

describe('surplusDescription', () => {
  it('names the count date and where the surplus goes', () => {
    expect(surplusDescription('2026-09-30', '711')).toBe('Xử lý hàng thừa kiểm kê ngày 30/09/2026: ghi nhận vào thu nhập khác (711)');
    expect(surplusDescription('2026-09-30', '3388')).toContain('(3388)');
    expect(surplusDescription('2026-09-30', '331')).toContain('(331)');
  });
});

describe('isSurplusVoucher', () => {
  const voucher = (over: Partial<{ total: string; lines: Array<{ account: string; party: typeof party | null; debit: string; credit: string }> }> = {}) => ({
    total: '150',
    lines: [
      { account: '3381', party: null, debit: '150', credit: '0' },
      { account: '711', party: null, debit: '0', credit: '150' },
    ],
    ...over,
  });

  it('accepts Dr 3381 / Cr one of 711, 3388 and 331 for the surplus, with the supplier only on 331', () => {
    expect(isSurplusVoucher(voucher(), '150')).toEqual({ ok: true, account: '711' });
    expect(isSurplusVoucher(voucher({ lines: [voucher().lines[0] as never, { account: '3388', party: null, debit: '0', credit: '150' }] }), '150')).toEqual({ ok: true, account: '3388' });
    expect(isSurplusVoucher(voucher({ lines: [voucher().lines[0] as never, { account: '331', party, debit: '0', credit: '150' }] }), '150')).toEqual({ ok: true, account: '331' });
  });

  it('refuses another amount, another account, a missing or an extra supplier, a third line and a wrong total', () => {
    expect(isSurplusVoucher(voucher(), '151').ok).toBe(false);
    expect(isSurplusVoucher(voucher({ lines: [voucher().lines[0] as never, { account: '511', party: null, debit: '0', credit: '150' }] }), '150').ok).toBe(false);
    expect(isSurplusVoucher(voucher({ lines: [voucher().lines[0] as never, { account: '331', party: null, debit: '0', credit: '150' }] }), '150').ok).toBe(false);
    expect(isSurplusVoucher(voucher({ lines: [voucher().lines[0] as never, { account: '711', party, debit: '0', credit: '150' }] }), '150').ok).toBe(false);
    expect(isSurplusVoucher(voucher({ lines: [...voucher().lines, { account: '711', party: null, debit: '0', credit: '0' }] }), '150').ok).toBe(false);
    expect(isSurplusVoucher(voucher({ total: '149' }), '150').ok).toBe(false);
    // The 3381 line must be the debit side, and the other the credit side.
    expect(isSurplusVoucher(voucher({ lines: [{ account: '3381', party: null, debit: '0', credit: '150' }, { account: '711', party: null, debit: '150', credit: '0' }] }), '150').ok).toBe(false);
  });
});
