// SPDX-License-Identifier: AGPL-3.0-only
// The request body as MISA reads it (#3854): an amount of Ludy (a decimal string) is written into the JSON text exactly, as an unquoted number, never through a JS number.
import { describe, expect, it } from 'vitest';
import { AmisError, AmisNumber, amisNumber, toJsonText } from '../src/index.ts';

describe('amisNumber', () => {
  it('keeps the digits of an amount above 2^53 and with four decimals exactly as given', () => {
    // 9007199254740993 is 2^53 + 1: a JS number would write 9007199254740992.
    expect(toJsonText({ amount: amisNumber('9007199254740993') })).toBe('{"amount":9007199254740993}');
    expect(toJsonText({ unit_price: amisNumber('12.3456') })).toBe('{"unit_price":12.3456}');
    expect(toJsonText({ a: amisNumber('-0.5'), b: amisNumber('0'), c: amisNumber('12345678901234567890.12345678'), d: amisNumber('1.5000') })).toBe('{"a":-0.5,"b":0,"c":12345678901234567890.12345678,"d":1.5000}');
    // The text is not parsed back to a number anywhere: the digits that go out are the digits that came in.
    expect(String(2 ** 53 + 1)).not.toBe('9007199254740993');
  });

  it('refuses what is not an exact decimal', () => {
    for (const bad of ['', ' 1', '1 ', '1e5', '1,5', '1.', '.5', '01', '+1', '--1', '1.123456789', '123456789012345678901', 'NaN', 'Infinity', '0x10', '１２']) {
      expect(() => amisNumber(bad), JSON.stringify(bad)).toThrow(AmisError);
    }
    expect(() => amisNumber('1e5')).toThrow(expect.objectContaining({ kind: 'invalid_request', reason: 'bad_amount' }));
  });
});

describe('an AmisNumber built by hand', () => {
  it('is checked again when it is written, so the factory is not the only way in', () => {
    for (const bad of ['1,"org_company_code":"other"', '1e400', '0.123456789', '', 'abc', ' 1']) {
      expect(() => toJsonText({ amount: new AmisNumber(bad) }), bad).toThrow(expect.objectContaining({ kind: 'invalid_request', reason: 'bad_amount' }));
    }
    const forged = amisNumber('1');
    (forged as { text: string }).text = '1}';
    expect(() => toJsonText({ amount: forged })).toThrow(expect.objectContaining({ reason: 'bad_amount' }));
    const hollow = Object.create(AmisNumber.prototype) as AmisNumber;
    expect(() => toJsonText([hollow])).toThrow(expect.objectContaining({ reason: 'bad_amount' }));
    expect(toJsonText({ amount: new AmisNumber('12.5') })).toBe('{"amount":12.5}');
  });
});

describe('toJsonText', () => {
  it('refuses what is not a plain object, a sparse list and a value nested too deep, as an AmisError', () => {
    class Money {
      readonly value = '1';
    }
    for (const bad of [new Date(0), new Map(), new Money(), new Number(1), /x/]) expect(() => toJsonText({ amount: bad }), String(bad)).toThrow(expect.objectContaining({ kind: 'invalid_request' }));
    // eslint-disable-next-line no-sparse-arrays
    expect(() => toJsonText([, 1])).toThrow(expect.objectContaining({ kind: 'invalid_request' }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toJsonText(cyclic)).toThrow(AmisError);
    expect(toJsonText(Object.assign(Object.create(null) as object, { a: 1 }))).toBe('{"a":1}');
  });

  it('writes strings, booleans, null, safe integers, lists and objects, leaving out what is undefined', () => {
    expect(toJsonText({ s: 'a"b\n"đ"', t: true, f: false, n: null, i: 17, list: [1, 'x', { k: undefined, j: 2 }], u: undefined })).toBe('{"s":"a\\"b\\n\\"đ\\"","t":true,"f":false,"n":null,"i":17,"list":[1,"x",{"j":2}]}');
    expect(JSON.parse(toJsonText({ x: [amisNumber('1.25')] }))).toEqual({ x: [1.25] });
  });

  it('refuses a JS number that is not a safe integer, and any value JSON has no place for', () => {
    for (const bad of [1.5, 2 ** 53, Number.NaN, Infinity, -0.1]) expect(() => toJsonText({ amount: bad }), String(bad)).toThrow(expect.objectContaining({ kind: 'invalid_request', reason: 'bad_amount' }));
    for (const bad of [undefined as unknown, () => 1, Symbol('x'), 10n]) expect(() => toJsonText([bad]), String(typeof bad)).toThrow(expect.objectContaining({ kind: 'invalid_request' }));
  });
});
