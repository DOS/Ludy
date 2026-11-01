// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { phoneKey } from '../src/phone.ts';
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
