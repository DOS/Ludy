// SPDX-License-Identifier: AGPL-3.0-only
// Money as it is typed in Vietnam (#3641, Engage audit AD-5): the Vietnamese and the English grouping, either decimal mark, and never a lost digit (strings, no JS numbers).
import { describe, expect, it } from 'vitest';
import { groupMoneyInput, parseMoneyInput, tidyMoneyInput } from '../src/lib/money-input.ts';

describe('parseMoneyInput', () => {
  it('reads plain digits, the Vietnamese grouping, the English grouping and spaces as the same number', () => {
    for (const text of ['5000000', '5.000.000', '5,000,000', '5 000 000', ' 5.000.000 ', '05000000']) expect(parseMoneyInput(text), text).toBe('5000000');
  });

  it('reads one or two decimals after either mark, with or without grouping', () => {
    expect(parseMoneyInput('20,5')).toBe('20.5');
    expect(parseMoneyInput('20.50')).toBe('20.50');
    expect(parseMoneyInput('5.000.000,50')).toBe('5000000.50');
    expect(parseMoneyInput('5,000,000.5')).toBe('5000000.5');
    expect(parseMoneyInput('0,01')).toBe('0.01');
  });

  it('reads a mark followed by three digits as a group mark, since that is how Vietnam writes thousands', () => {
    expect(parseMoneyInput('1.234')).toBe('1234');
    expect(parseMoneyInput('1,234')).toBe('1234');
    expect(parseMoneyInput('12.345')).toBe('12345');
  });

  it('keeps every digit of an amount larger than a JS number holds exactly', () => {
    expect(parseMoneyInput('9.007.199.254.740.993')).toBe('9007199254740993');
    expect(parseMoneyInput('999999999999999')).toBe('999999999999999');
  });

  it('refuses what is not an amount', () => {
    for (const text of ['', ' ', 'abc', '5.00.000', '1.234,567', '1,234.567', '5..000', '1.2345', '1e6', '-5', '12abc', '1.', '.5', ',5', '1,2,3', '5.000,', '1.000.00', '0.500', '0,500', '0.000']) expect(parseMoneyInput(text), text).toBeNull();
  });
});

describe('groupMoneyInput and tidyMoneyInput', () => {
  it('write an amount for reading, the Vietnamese way', () => {
    expect(groupMoneyInput('5000000')).toBe('5.000.000');
    expect(groupMoneyInput('999')).toBe('999');
    expect(groupMoneyInput('1000')).toBe('1.000');
    expect(groupMoneyInput('20.5')).toBe('20,5');
    expect(groupMoneyInput('5000000.50')).toBe('5.000.000,50');
  });

  it('tidy what is valid and leave what is not as the person typed it', () => {
    expect(tidyMoneyInput('5000000')).toBe('5.000.000');
    expect(tidyMoneyInput('5,000,000')).toBe('5.000.000');
    expect(tidyMoneyInput('50abc')).toBe('50abc');
    expect(tidyMoneyInput('')).toBe('');
  });

  it('round-trip: what is written for reading is read back as the same amount', () => {
    for (const canonical of ['1', '1000', '5000000', '20.5', '5000000.50', '123456789012345']) expect(parseMoneyInput(groupMoneyInput(canonical)), canonical).toBe(canonical);
  });
});
