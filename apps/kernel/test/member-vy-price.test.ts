// SPDX-License-Identifier: AGPL-3.0-only
// The cost shown before a click is worked out only for a deployment that has a price, and a price is a decimal string compared as one
// (the money rule, AGENTS.md; #3242): a price too small for a JS number is still a price, zero and a string that is no decimal are none.
import { describe, expect, it } from 'vitest';
import { askEstimate, translationEstimate } from '../src/member-vy-ports.ts';

const price = (inputPerMTok: string, outputPerMTok: string) => ({ inputPerMTok, outputPerMTok });

describe('the cost estimate before a click', () => {
  it('has no cost for no price, a zero price, or a price that is no decimal', () => {
    for (const none of [undefined, price('0', '0'), price('0.000', '0'), price('', ''), price('abc', 'n/a'), price(' 5 ', ' ')]) {
      expect(askEstimate(none).cost, JSON.stringify(none)).toBeNull();
      expect(translationEstimate(1000, none).cost, JSON.stringify(none)).toBeNull();
    }
  });

  it('has a cost when either side is priced, however small: below what a JS number holds counts as a price', () => {
    for (const some of [price('0.15', '0.60'), price('0', '0.60'), price('0.15', '0'), price('1e-400', '0'), price('0', '0.0000000001')]) {
      expect(typeof askEstimate(some).cost, JSON.stringify(some)).toBe('string');
      expect(typeof translationEstimate(1000, some).cost, JSON.stringify(some)).toBe('string');
    }
    // The figure itself goes through decimal arithmetic: a price of 0.15 and 0.60 for the fixed question estimate.
    expect(Number.isNaN(Number(askEstimate(price('0.15', '0.60')).cost))).toBe(false);
  });

  it('a tiny price that Number() reads as zero is a price (the JS-number comparison called it none)', () => {
    expect(Number('1e-400')).toBe(0);
    expect(askEstimate(price('1e-400', '0')).cost).not.toBeNull();
  });
});
