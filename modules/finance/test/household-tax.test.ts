// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic the percentage-method household papers share (#2517 S2a, #2518 01/CNKD): tax on revenue rounded to a whole dong, and one entry's amount shared between trades so the parts always tie.
import { describe, expect, it } from 'vitest';
import { splitAmount, taxOn } from '../src/domain/household-tax.ts';

describe('taxOn', () => {
  it('rounds to a whole dong and never goes negative', () => {
    expect(taxOn('1000000', '1')).toBe('10000');
    expect(taxOn('123456', '0.5')).toBe('617');
    expect(taxOn('0', '1')).toBe('0');
    expect(taxOn('-500000', '1')).toBe('0');
  });
});

describe('splitAmount', () => {
  const total = (parts: { amount: string }[]) => parts.reduce((acc, p) => acc + Number(p.amount), 0);

  it('gives the whole amount to the only trade that has weight', () => {
    expect(splitAmount('1000', [{ bucket: 'goods', weight: '500' }])).toEqual([{ bucket: 'goods', amount: '1000' }]);
  });

  it('shares by weight and ties exactly, the largest part taking the remainder', () => {
    const parts = splitAmount('100', [
      { bucket: 'goods', weight: '1' },
      { bucket: 'services', weight: '1' },
      { bucket: 'catering', weight: '1' },
    ]);
    expect(parts.map((p) => p.bucket)).toEqual(['goods', 'services', 'catering']);
    // Equal weights: the first trade in the fixed order takes the remainder.
    expect(parts.map((p) => p.amount)).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(total(parts)).toBeCloseTo(100, 6);
  });

  it('keeps the order of the trades, then unassigned, whatever order the weights come in', () => {
    const parts = splitAmount('300', [
      { bucket: 'unassigned', weight: '100' },
      { bucket: 'services', weight: '100' },
      { bucket: 'goods', weight: '100' },
    ]);
    expect(parts.map((p) => p.bucket)).toEqual(['goods', 'services', 'unassigned']);
  });

  it('adds the weights of one trade and drops empty ones', () => {
    const parts = splitAmount('900', [
      { bucket: 'goods', weight: '200' },
      { bucket: 'goods', weight: '400' },
      { bucket: 'other', weight: '0' },
      { bucket: 'unassigned', weight: '300' },
    ]);
    expect(parts).toEqual([
      { bucket: 'goods', amount: '600' },
      { bucket: 'unassigned', amount: '300' },
    ]);
  });

  it('keeps each trade its signed contribution from a mixed-sign document, never dropping a negative line', () => {
    // Goods 200000 and services -100000 (an adjustment line) make a net of 100000.
    expect(
      splitAmount('100000', [
        { bucket: 'goods', weight: '200000' },
        { bucket: 'services', weight: '-100000' },
      ]),
    ).toEqual([
      { bucket: 'goods', amount: '200000' },
      { bucket: 'services', amount: '-100000' },
    ]);
    // A document of negative lines only shares a negative amount the usual way.
    expect(splitAmount('-300', [{ bucket: 'goods', weight: '-100' }, { bucket: 'services', weight: '-200' }])).toEqual([
      { bucket: 'goods', amount: '-100' },
      { bucket: 'services', amount: '-200' },
    ]);
  });

  it('puts the whole amount on unassigned when the lines cancel out', () => {
    expect(splitAmount('50', [{ bucket: 'goods', weight: '100' }, { bucket: 'services', weight: '-100' }])).toEqual([{ bucket: 'unassigned', amount: '50' }]);
  });

  it('puts the whole amount on unassigned when no weight is usable, never a guessed trade', () => {
    expect(splitAmount('250', [])).toEqual([{ bucket: 'unassigned', amount: '250' }]);
    expect(splitAmount('250', [{ bucket: 'goods', weight: '0' }])).toEqual([{ bucket: 'unassigned', amount: '250' }]);
  });

  it('shares a negative amount (a return or a reversal) by the same weights and still ties', () => {
    const parts = splitAmount('-600', [
      { bucket: 'goods', weight: '100' },
      { bucket: 'services', weight: '200' },
    ]);
    expect(parts).toEqual([
      { bucket: 'goods', amount: '-200' },
      { bucket: 'services', amount: '-400' },
    ]);
  });
});
