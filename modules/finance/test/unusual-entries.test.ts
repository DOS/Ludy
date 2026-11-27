// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the monthly review of unusual entries (#5182): the control accounts, the day a chart began, the windows each rule reads, the holidays of a month and how a figure is written. The rules
// themselves run in SQL and are checked against the books in apps/kernel/test/finance-unusual-entries.db.test.ts (CI only).
import { describe, expect, it } from 'vitest';
import {
  CONTROL_ACCOUNT_PATTERN,
  NOT_GROUPED_PATTERN,
  chartStart,
  controlGroupOf,
  holidaysIn,
  moneyText,
  ratioText,
  reviewWindow,
} from '../src/domain/unusual-entries.ts';
import type { BooksRow } from '../src/domain/expense-variance.ts';

describe('the control accounts', () => {
  it('names the group of an account by its first three digits, and no group for any other account', () => {
    expect(controlGroupOf('131')).toBe('receivable');
    expect(controlGroupOf('1311')).toBe('receivable');
    expect(controlGroupOf('331')).toBe('payable');
    expect(controlGroupOf('3311')).toBe('payable');
    expect(controlGroupOf('133')).toBe('input_vat');
    expect(controlGroupOf('1331')).toBe('input_vat');
    expect(controlGroupOf('333')).toBe('tax');
    expect(controlGroupOf('33311')).toBe('tax');
    expect(controlGroupOf('334')).toBe('employee');
    for (const code of ['111', '112', '156', '511', '642', '6421', '911', '33']) expect(controlGroupOf(code), code).toBeNull();
  });

  it('gives the database the same patterns: control accounts for the manual rule, and the accounts the amount and new-account rules leave out', () => {
    const control = new RegExp(CONTROL_ACCOUNT_PATTERN);
    for (const code of ['131', '1311', '331', '33111', '133', '333', '3331', '334']) expect(control.test(code), code).toBe(true);
    for (const code of ['111', '112', '156', '511', '642', '911', '13', '33']) expect(control.test(code), code).toBe(false);
    const left = new RegExp(NOT_GROUPED_PATTERN);
    for (const code of ['131', '331', '133', '333', '334', '111', '1111', '112', '1121', '911']) expect(left.test(code), code).toBe(true);
    for (const code of ['156', '511', '632', '641', '6421', '811', '2141']) expect(left.test(code), code).toBe(false);
  });
});

describe('the day a chart began', () => {
  const tt99: BooksRow = { regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-01-01' };
  const later: BooksRow = { regime: 'tt99', chartVersion: '2027.1', effectiveFrom: '2027-01-01' };

  it('is the earliest day when the entity has no books row (TT133 from the start)', () => {
    expect(chartStart([], '2026-07-31')).toBe('1900-01-01');
  });

  it('is the start of the newest row on or before the date, and the earliest day before every row', () => {
    expect(chartStart([tt99], '2026-07-31')).toBe('2026-01-01');
    expect(chartStart([tt99], '2026-01-01')).toBe('2026-01-01');
    expect(chartStart([tt99], '2025-12-31')).toBe('1900-01-01');
    expect(chartStart([tt99, later], '2026-12-31')).toBe('2026-01-01');
    expect(chartStart([later, tt99], '2027-03-31')).toBe('2027-01-01');
  });
});

describe('the days each rule reads', () => {
  it('reads 6 months of amounts and 24 months of accounts before the month, and the month itself', () => {
    expect(reviewWindow('2026-07', '1900-01-01')).toEqual({ from: '2026-07-01', to: '2026-07-31', historyFrom: '2026-01-01', newAccountFrom: '2024-07-01' });
    expect(reviewWindow('2026-02', '1900-01-01')).toEqual({ from: '2026-02-01', to: '2026-02-28', historyFrom: '2025-08-01', newAccountFrom: '2024-02-01' });
    expect(reviewWindow('2028-03', '1900-01-01').to).toBe('2028-03-31');
    expect(reviewWindow('2028-02', '1900-01-01').to).toBe('2028-02-29');
  });

  it('never reads before the day the current chart began, because TT133 and TT99 codes do not translate', () => {
    expect(reviewWindow('2026-07', '2026-03-01')).toEqual({ from: '2026-07-01', to: '2026-07-31', historyFrom: '2026-03-01', newAccountFrom: '2026-03-01' });
    expect(reviewWindow('2026-07', '2025-12-01')).toEqual({ from: '2026-07-01', to: '2026-07-31', historyFrom: '2026-01-01', newAccountFrom: '2025-12-01' });
    expect(reviewWindow('2026-07', '2026-07-01').historyFrom).toBe('2026-07-01');
  });
});

describe('the public holidays of a month', () => {
  it('lists the fixed holidays and the lunar ones of the shared calendar for the years it carries', () => {
    expect(holidaysIn('2026-09')).toEqual(['2026-09-02']);
    expect(holidaysIn('2026-04')).toEqual(['2026-04-26', '2026-04-30']);
    expect(holidaysIn('2026-05')).toEqual(['2026-05-01']);
    expect(holidaysIn('2027-02')).toEqual(['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09']);
    expect(holidaysIn('2027-01')).toEqual(['2027-01-01']);
    expect(holidaysIn('2026-03')).toEqual([]);
  });

  it('carries only the fixed holidays beyond the lunar table, so Tết is not in it', () => {
    expect(holidaysIn('2029-02')).toEqual([]);
    expect(holidaysIn('2029-09')).toEqual(['2029-09-02']);
  });
});

describe('how a figure is written', () => {
  it('writes how many times the usual an amount is with one decimal, half up, and nothing without a usual amount', () => {
    expect(ratioText('48000000', '9000000')).toBe('5.3');
    expect(ratioText('9000000', '3000000')).toBe('3.0');
    expect(ratioText('1000000', '4000000')).toBe('0.3');
    expect(ratioText('1000000', '0')).toBeNull();
    expect(ratioText('1000000', '-5')).toBeNull();
  });

  it('writes an amount from the database canonically: no trailing zeros, no exponent, no negative zero', () => {
    expect(moneyText('12345.00')).toBe('12345');
    expect(moneyText('1234567.5')).toBe('1234567.5');
    expect(moneyText('0.00')).toBe('0');
    expect(moneyText('-0')).toBe('0');
    expect(moneyText('-30000000')).toBe('-30000000');
    expect(moneyText('1e3')).toBe('1000');
    expect(moneyText(null)).toBeNull();
  });
});
