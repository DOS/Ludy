// SPDX-License-Identifier: AGPL-3.0-only
// The "it already exists" checks of the add dialogs in Settings (#3608): a bank number already recorded, a sub-account code that exists, a keyword
// rule that exists, an invited e-mail that already belongs to a member or has an invitation waiting, and a day off that overlaps one listed.
import { describe, expect, it } from 'vitest';
import { overlappingDayOff } from '../src/lib/calendar.ts';
import { digitsOf, duplicateAccountCode, duplicateBankNumber, duplicateKeywordRule, invitedEmailState, keywordKey } from '../src/lib/duplicates.ts';

describe('duplicateBankNumber', () => {
  const rows = [
    { id: '1', bankAccount: '1121', accountNumber: '0123456789' },
    { id: '2', bankAccount: '1122', accountNumber: '9876543210' },
  ];
  it('finds the number however the bank prints it (spaces, dots, dashes)', () => {
    expect(duplicateBankNumber(rows, '0123 456 789')?.bankAccount).toBe('1121');
    expect(duplicateBankNumber(rows, '9876-543-210')?.bankAccount).toBe('1122');
    expect(duplicateBankNumber(rows, '0123.456.789')?.id).toBe('1');
  });
  it('flags a number recorded on any bank account, since one number belongs to one', () => {
    expect(duplicateBankNumber(rows, '9876543210')).toBe(rows[1]);
  });
  it('is quiet for a new number or an empty field', () => {
    expect(duplicateBankNumber(rows, '111222333')).toBeNull();
    expect(duplicateBankNumber(rows, '')).toBeNull();
    expect(duplicateBankNumber(rows, ' - ')).toBeNull();
    expect(digitsOf('ab 12-3')).toBe('123');
  });
});

describe('duplicateAccountCode', () => {
  const accounts = [
    { code: '1121', name: 'Tiền gửi ngân hàng' },
    { code: '1121.VCB', name: 'Vietcombank' },
  ];
  it('finds a code as it would be stored: trimmed, the tag in upper case', () => {
    expect(duplicateAccountCode(accounts, '1121.vcb')?.name).toBe('Vietcombank');
    expect(duplicateAccountCode(accounts, '  1121.VCB ')?.name).toBe('Vietcombank');
  });
  it('flags a code of a TT133 account too', () => {
    expect(duplicateAccountCode(accounts, '1121')?.name).toBe('Tiền gửi ngân hàng');
  });
  it('is quiet for a new code or an empty field', () => {
    expect(duplicateAccountCode(accounts, '1121.ACB')).toBeNull();
    expect(duplicateAccountCode(accounts, '')).toBeNull();
  });
});

describe('duplicateKeywordRule', () => {
  const rules = [
    { matchKind: 'keyword', matchText: 'cước internet', accountCode: '6427' },
    { matchKind: 'description', matchText: 'Cước internet VNPT', accountCode: '6427' },
  ];
  it('matches without regard to accents, case or spacing, as the rule itself does', () => {
    expect(duplicateKeywordRule(rules, 'Cuoc  Internet')).toBe(rules[0]);
    expect(duplicateKeywordRule(rules, '  CƯỚC INTERNET ')).toBe(rules[0]);
    expect(keywordKey('Đường dây')).toBe('duong day');
  });
  it('compares keyword rules only, not what an approval taught for one item', () => {
    expect(duplicateKeywordRule(rules, 'cước internet vnpt')).toBeNull();
  });
  it('is quiet for a new keyword or an empty field', () => {
    expect(duplicateKeywordRule(rules, 'tiền điện')).toBeNull();
    expect(duplicateKeywordRule(rules, '   ')).toBeNull();
  });
});

describe('invitedEmailState', () => {
  const members = [{ email: 'An@Example.com' }];
  const invites = [{ email: 'binh@example.com', status: 'pending' }, { email: 'cuc@example.com', status: 'expired' }];
  it('says when the address already belongs to a member, whatever its case', () => {
    expect(invitedEmailState(' an@example.COM ', members, invites)).toBe('member');
  });
  it('says when an invitation is already waiting for it', () => {
    expect(invitedEmailState('binh@example.com', members, invites)).toBe('invited');
  });
  it('lets an expired invitation be sent again, and a new address through', () => {
    expect(invitedEmailState('cuc@example.com', members, invites)).toBeNull();
    expect(invitedEmailState('new@example.com', members, invites)).toBeNull();
    expect(invitedEmailState('', members, invites)).toBeNull();
  });
});

describe('overlappingDayOff', () => {
  // 2 and 3 November 2026 in Vietnam.
  const off = [{ timeZone: 'Asia/Ho_Chi_Minh', startsAt: '2026-11-01T17:00:00.000Z', endsAt: '2026-11-03T17:00:00.000Z' }];
  it('returns the listed range that shares a day with the picked one', () => {
    expect(overlappingDayOff(off, '2026-11-03', '2026-11-05')).toEqual({ from: '2026-11-02', to: '2026-11-03' });
    expect(overlappingDayOff(off, '2026-11-02', '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-03' });
  });
  it('is quiet for days next to it, and takes an end before the start as one day', () => {
    expect(overlappingDayOff(off, '2026-11-04', '2026-11-04')).toBeNull();
    expect(overlappingDayOff(off, '2026-10-30', '2026-11-01')).toBeNull();
    expect(overlappingDayOff(off, '2026-11-03', '2026-11-01')).not.toBeNull();
  });
});
