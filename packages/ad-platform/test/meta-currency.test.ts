// SPDX-License-Identifier: AGPL-3.0-only
// Meta's minor units read back (ads W4, #3835): `fromMetaMinorUnits` is the inverse of `metaMinorUnits` for the amounts a ledger holds, drops trailing zeros, and never guesses:
// an unknown currency or an answer that is not digits is an error. (`metaMinorUnits` itself is pinned in launch-writers.test.ts.)
import { describe, expect, it } from 'vitest';
import { META_BUDGET_CURRENCIES, fromMetaMinorUnits, metaMinorUnits } from '../src/meta-currency.ts';

describe('fromMetaMinorUnits', () => {
  it('gives the currency\'s own units: dong as they are, dollars divided by a hundred, in text', () => {
    for (const [minor, currency, amount] of [
      ['5000000', 'VND', '5000000'],
      ['1', 'VND', '1'],
      ['12345', 'USD', '123.45'],
      ['1999', 'USD', '19.99'],
      ['1', 'USD', '0.01'],
      ['10', 'USD', '0.1'],
      ['99', 'USD', '0.99'],
      ['100', 'USD', '1'],
      ['500', 'EUR', '5'],
      ['500', 'JPY', '500'],
      ['999999999999999', 'USD', '9999999999999.99'],
    ] as const) {
      expect(fromMetaMinorUnits(minor, currency), `${minor} ${currency}`).toBe(amount);
    }
  });

  it('drops trailing zeros of the fraction and leading zeros of the answer', () => {
    expect(fromMetaMinorUnits('2000', 'USD')).toBe('20');
    expect(fromMetaMinorUnits('2050', 'USD')).toBe('20.5');
    expect(fromMetaMinorUnits('0001999', 'USD')).toBe('19.99');
    expect(fromMetaMinorUnits('0000100000', 'VND')).toBe('100000');
    expect(fromMetaMinorUnits('0005', 'USD')).toBe('0.05');
    expect(fromMetaMinorUnits('0', 'VND')).toBe('0');
    expect(fromMetaMinorUnits('0', 'USD')).toBe('0');
    expect(fromMetaMinorUnits('00', 'USD')).toBe('0');
  });

  it('is the inverse of metaMinorUnits for any amount the ledger holds, in every currency Ludy has an offset for (a property over many amounts)', () => {
    let seed = 20261119;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 1000; i += 1) {
      const whole = String((next() % 1_000_000_000) + 1);
      const cents = String(next() % 100).padStart(2, '0');
      for (const currency of META_BUDGET_CURRENCIES) {
        const zero = ['VND', 'JPY', 'KRW'].includes(currency);
        const amount = zero ? whole : `${whole}.${cents}`;
        const back = fromMetaMinorUnits(metaMinorUnits(amount, currency), currency);
        // The ledger's own text, without a trailing zero of its fraction.
        const expected = zero ? whole : cents === '00' ? whole : `${whole}.${cents.replace(/0$/, '')}`;
        expect(back, `${amount} ${currency}`).toBe(expected);
        expect(metaMinorUnits(back, currency), `${amount} ${currency}`).toBe(metaMinorUnits(amount, currency));
      }
    }
  });

  it('refuses a currency it has no offset for, and a name that only looks like one', () => {
    for (const currency of ['CHF', 'vnd', '', '__proto__', 'toString', 'constructor']) {
      let error: unknown;
      try {
        fromMetaMinorUnits('1000', currency);
      } catch (e) {
        error = e;
      }
      expect(error, currency).toMatchObject({ kind: 'bad_request', code: 'CURRENCY_UNSUPPORTED' });
    }
  });

  it('refuses an answer that is not a plain run of digits, never a guess', () => {
    for (const minor of ['', 'abc', '12.5', '-100', '+100', ' 100', '100 ', '1e3', '1,000', '0x10', '12345678901234567']) {
      for (const currency of ['VND', 'USD']) {
        let error: unknown;
        try {
          fromMetaMinorUnits(minor, currency);
        } catch (e) {
          error = e;
        }
        expect(error, `${JSON.stringify(minor)} ${currency}`).toMatchObject({ kind: 'unknown', code: 'BUDGET_UNREADABLE' });
      }
    }
  });
});
