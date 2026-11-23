// SPDX-License-Identifier: AGPL-3.0-only
// The row of the household law in force on a date (#2517): the latest whose effective date is on or before it, per key.
import { describe, expect, it } from 'vitest';
import { pickInForce } from '../src/domain/household-rules.ts';

const row = (key: string, effective_from: string, value: string) => ({ key, effective_from, value });
const rows = [row('goods', '2026-01-01', 'a'), row('goods', '2027-01-01', 'b'), row('services', '2026-01-01', 'c'), row('catering', '2028-01-01', 'd')];
const at = (date: string) => Object.fromEntries(pickInForce(rows, (r) => r.key, date).map((r) => [r.key, r.value]));

describe('the household rule in force on a date', () => {
  it('takes the latest row that starts on or before the date, per key', () => {
    expect(at('2026-12-31')).toEqual({ goods: 'a', services: 'c' });
    expect(at('2027-01-01')).toEqual({ goods: 'b', services: 'c' });
    expect(at('2030-01-01')).toEqual({ goods: 'b', services: 'c', catering: 'd' });
  });

  it('is empty before the first row, and ignores the order the rows come in', () => {
    expect(at('2025-12-31')).toEqual({});
    expect(Object.fromEntries(pickInForce([...rows].reverse(), (r) => r.key, '2027-06-01').map((r) => [r.key, r.value]))).toEqual({ goods: 'b', services: 'c' });
  });
});
