// SPDX-License-Identifier: AGPL-3.0-only
// The number of a bank account as the books keep it (#2183): digits only, 6 to 20, however the bank groups them, and the
// mask shown where the whole number must not be.
import { describe, expect, it } from 'vitest';
import { accountNumberDigits, maskAccountNumber } from '../src/account-number.ts';

describe('accountNumberDigits', () => {
  it('keeps the digits of a number grouped with spaces, dots or dashes', () => {
    expect(accountNumberDigits('0123456789')).toBe('0123456789');
    expect(accountNumberDigits('0123 456 789')).toBe('0123456789');
    expect(accountNumberDigits('0123.456.789')).toBe('0123456789');
    expect(accountNumberDigits(' 0123-456-789 ')).toBe('0123456789');
    expect(accountNumberDigits('00110000000012345678')).toBe('00110000000012345678');
  });

  it('refuses what is not a number of 6 to 20 digits', () => {
    for (const bad of ['', '12345', '123456789012345678901', '0123 abc 789', '0123/456/789', '+84123456789', '12,345,678']) {
      expect(accountNumberDigits(bad), bad).toBeNull();
    }
  });
});

describe('maskAccountNumber', () => {
  it('hides all but the last four digits, and always most of a short number', () => {
    expect(maskAccountNumber('19880001234')).toBe('*******1234');
    expect(maskAccountNumber('0123456789')).toBe('******6789');
    expect(maskAccountNumber('123456')).toBe('**3456');
    expect(maskAccountNumber('00110000000012345678')).toBe('********5678');
    expect(maskAccountNumber('0123456789')).not.toContain('0123');
  });
});
