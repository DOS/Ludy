// SPDX-License-Identifier: AGPL-3.0-only
// The list of banks (#2897): unique codes of the stored form, every bank named, no BIN written without a source, an honest status, and a search that ignores case and diacritics.
import { describe, expect, it } from 'vitest';
import { VN_BANKS, VN_BANKS_SOURCE, VN_BANK_CODE_PATTERN, bankByCode, isBankCode, searchBanks } from '../src/banks.ts';

describe('the list of banks', () => {
  it('has unique codes of the stored form, each bank named in short and in full', () => {
    const codes = VN_BANKS.map((bank) => bank.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const bank of VN_BANKS) {
      expect(bank.code, bank.code).toMatch(VN_BANK_CODE_PATTERN);
      expect(bank.shortName.trim()).not.toBe('');
      expect(bank.name.trim()).not.toBe('');
      // No NAPAS BIN or any other number: a code is never written from memory.
      expect(Object.keys(bank).sort()).toEqual(['code', 'name', 'shortName']);
    }
    expect(VN_BANKS.length).toBeGreaterThan(30);
  });

  it('says it is commentary until a first-party list is checked, and who checks it', () => {
    expect(VN_BANKS_SOURCE).toMatchObject({ status: 'commentary', firstParty: false });
    expect(VN_BANKS_SOURCE.checkedBy).toContain('accountant');
  });

  it('finds a bank by its code and knows a code that is not in the list', () => {
    expect(bankByCode('VCB')).toMatchObject({ shortName: 'Vietcombank' });
    expect(bankByCode('vcb')).toBeUndefined();
    expect(isBankCode('TCB')).toBe(true);
    expect(isBankCode('NOPE')).toBe(false);
    expect(isBankCode('')).toBe(false);
  });

  it('searches by code, short name or full name, in any case and without diacritics, the exact code or name first', () => {
    expect(searchBanks('').length).toBe(VN_BANKS.length);
    expect(searchBanks('vietcombank').map((b) => b.code)).toEqual(['VCB']);
    expect(searchBanks('ngoai thuong').map((b) => b.code)).toEqual(['VCB']);
    expect(searchBanks('Ngân hàng Ngoại thương')[0]?.code).toBe('VCB');
    expect(searchBanks('đông á').map((b) => b.code)).toContain('DAB');
    expect(searchBanks('mb')[0]?.code).toBe('MBB');
    expect(searchBanks('xyz không có')).toEqual([]);
  });
});
