// SPDX-License-Identifier: AGPL-3.0-only
// isServerRefusal tells an answer that refused (a 4xx: nothing was done) from a lost or failed one (nothing is known), so a settlement request refetches only when it may have been made (#3700 S3c).
import { describe, expect, it } from 'vitest';
import { ApiError, isServerRefusal } from '../src/lib/errors.ts';

describe('a server refusal', () => {
  it('is a 4xx answer from either path', () => {
    expect(isServerRefusal({ code: 'SUPPLIER_PAYMENT_ACCOUNT_MISMATCH', status: 409 })).toBe(true);
    expect(isServerRefusal(new ApiError('SUPPLIER_PAYMENT_ALREADY_EXPORTED', 409, null))).toBe(true);
  });

  it('is not a lost response, a server fault or something else', () => {
    expect(isServerRefusal(new TypeError('Failed to fetch'))).toBe(false);
    expect(isServerRefusal({ code: 'INTERNAL', status: 500 })).toBe(false);
    expect(isServerRefusal({ status: 'x' })).toBe(false);
    expect(isServerRefusal(null)).toBe(false);
  });
});
