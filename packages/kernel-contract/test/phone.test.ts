// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { phoneKey, phoneKeysIn } from '../src/phone.ts';
import { PHONE_KEY_CASES } from '../src/phone-cases.ts';

describe('phoneKey (CRM plan 4.5, #2228)', () => {
  it.each(PHONE_KEY_CASES)('gives %j the key %j', (phone, key) => {
    expect(phoneKey(phone)).toBe(key);
  });

  it('has no key for nothing', () => {
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey(undefined)).toBeNull();
  });

  it('gives one key to every way of writing one number', () => {
    const forms = ['0912345678', '+84 912 345 678', '84912345678', '0084912345678', '091-234-5678'];
    expect(new Set(forms.map((f) => phoneKey(f)))).toEqual(new Set(['0912345678']));
  });
});

describe('phoneKeysIn (the Inbox contact match, CV3, #2306)', () => {
  it('finds a Vietnamese mobile number written the usual ways, as its key', () => {
    for (const written of ['0912345678', '0912 345 678', '0912.345.678', '091-234-5678', '+84 912 345 678', '84912345678', '0084912345678']) {
      expect(phoneKeysIn(`Số mình là ${written} nhé`), written).toEqual(['0912345678']);
    }
  });

  it('finds the numbers in a sentence, once each and at most three, in the order written', () => {
    expect(phoneKeysIn('0912345678, hoặc 0987 654 321, hoặc +84 912 345 678, hoặc 0901 111 222, 0902 222 333')).toEqual(['0912345678', '0987654321', '0901111222']);
    expect(phoneKeysIn('gọi 0912345678 hay 0987654321', 1)).toEqual(['0912345678']);
  });

  it('is not fooled by a longer number, a date or a number that is not a phone', () => {
    // An account number, an order number, a date, a number with a year, a short number and a number with too many separators.
    for (const text of ['STK 1234567890123', 'mã đơn 20240912345678', 'ngày 2024-0912345678', 'lúc 01 02 2025 12', 'giá 150.000', 'ship 09123', '0 9 1 2 3 4 5 6 7 8', 'không có số']) {
      expect(phoneKeysIn(text), text).toEqual([]);
    }
  });
});
