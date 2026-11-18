// SPDX-License-Identifier: AGPL-3.0-only
// A price is a decimal string and is compared as one (the money rule, AGENTS.md; #3242, #3481): zero in any spelling, a negative number and a string that is no decimal are none;
// a value too small for a JS number is still a price.
import { describe, expect, it } from 'vitest';
import { isPositivePrice } from '../src/price.ts';

describe('isPositivePrice', () => {
  it('is false for zero in any spelling, a negative price and a string that is no decimal', () => {
    for (const none of ['0', '0.0', '0.000000', '-0', '-1', '-0.5', '', ' ', 'abc', 'n/a', 'NaN', 'Infinity-', '1,5', '1.2.3']) expect(isPositivePrice(none), JSON.stringify(none)).toBe(false);
  });

  it('is true for a positive decimal, however small: below what a JS number holds counts as a price', () => {
    for (const some of ['1', '0.15', '15.5', '000123.4500', '0.0000000001', '1e-400']) expect(isPositivePrice(some), some).toBe(true);
    expect(Number('1e-400')).toBe(0);
  });
});
