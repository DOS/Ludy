// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BANK_KEY_MAX_CHARS, bankLineKey } from '../src/domain/bank-rule-key.ts';

// Synthetic lines written the way banks write them: transfer words, references, dates and numbers around the counterparty.
describe('the key of a bank line', () => {
  const cases: Array<[string, string | null]> = [
    ['CK TU NGUYEN VAN A TT TIEN NHA T9 FT26301ABC', 'nguyen van a'],
    ['CHUYEN TIEN NGUYEN VAN A THANG 10', 'nguyen van a'],
    ['NGUYEN VAN A CHUYEN TIEN THUE NHA', 'nguyen van a'],
    ['VIETQR TT HOA DON 4101 CONG TY ABC', 'cong ty abc'],
    ['ND: NHAN TU TRAN THI B MB BANK', 'tran thi b'],
    ['Thanh toán tiền điện tháng 10 EVN HCMC', 'tien dien'],
    ['CÔNG TY TNHH DỊCH VỤ MẪU CK', 'cong ty tnhh dich vu mau'],
    ['Nguyễn Văn Á', 'nguyen van a'],
    ['FT26301123456789 BO', null],
    ['IBFT NAPAS 0011000000000', null],
    ['TT HD 4101 MST 0101234567', null],
    ['AB', null],
    ['   ', null],
    ['', null],
  ];
  for (const [description, key] of cases) {
    it(`reads ${JSON.stringify(description)} as ${JSON.stringify(key)}`, () => {
      expect(bankLineKey(description)).toBe(key);
    });
  }

  it('gives the same payer the same key whatever the month, reference and transfer words', () => {
    const keys = ['CK TU NGUYEN VAN A TT TIEN NHA T9 FT26301ABC', 'IBFT NGUYEN VAN A THANH TOAN TIEN NHA THANG 10 REF 99812', 'nguyễn văn a chuyển khoản'].map(bankLineKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('is cut at the longest key kept', () => {
    const long = `${'abcdefghij '.repeat(20)}`;
    expect(bankLineKey(long)?.length).toBeLessThanOrEqual(BANK_KEY_MAX_CHARS);
  });

  it('breaks a run at a number or a transfer word, so two names are not one', () => {
    expect(bankLineKey('TRAN B 123 LE THI CC')).toBe('le thi cc');
  });
});
