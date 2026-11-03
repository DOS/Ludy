// SPDX-License-Identifier: AGPL-3.0-only
// The pure side of stock (#2512): how a name is reduced to its alias key, how a line's quantity becomes a move, and the figures a posting must never fail on.
import { describe, expect, it } from 'vitest';
import { STOCK_GOODS_ACCOUNT, moveQuantity, movableQuantity, normalizeAlias, oppositeQuantity, plainQuantity, sameUnit } from '../src/domain/stock.ts';

describe('alias keys', () => {
  it('reduces two spellings of one name to one key: composed, lower case, one space, trimmed', () => {
    expect(normalizeAlias('  Phí   QUẢNG\tcáo  Facebook ')).toBe('phí quảng cáo facebook');
    // A decomposed accent is the composed one.
    expect(normalizeAlias('É')).toBe('é');
    expect(normalizeAlias('   ')).toBe('');
    expect(normalizeAlias('x'.repeat(400))).toHaveLength(300);
  });
  it('compares units without case or spacing', () => {
    expect(sameUnit('Gói', ' gói ')).toBe(true);
    expect(sameUnit('kg', 'gói')).toBe(false);
    expect(sameUnit(null, '')).toBe(true);
  });
});

describe('what a line moves', () => {
  it('takes a positive decimal quantity and nothing else', () => {
    expect(movableQuantity('2')).toBe('2');
    expect(movableQuantity(' 2.50 ')).toBe('2.5');
    for (const none of [null, undefined, '', '0', '0.000', '-1', '1e3', 'abc', '1,5']) expect(movableQuantity(none), String(none)).toBeNull();
  });
  it('multiplies by the factor in decimals, signs a sale negative and rounds to six places', () => {
    expect(moveQuantity('purchase', '2', '10')).toBe('20');
    expect(moveQuantity('sale', '2', '10')).toBe('-20');
    expect(moveQuantity('purchase', '0.1', '3')).toBe('0.3');
    expect(moveQuantity('purchase', '1', '0.3333333')).toBe('0.333333');
  });
  it('leaves out a figure the stock cannot take, so a posting never fails on it', () => {
    expect(moveQuantity('purchase', '0.0000001', '1')).toBeNull();
    expect(moveQuantity('purchase', '99999999999999', '2')).toBeNull();
    expect(moveQuantity('purchase', '99999999999999', '1')).toBe('99999999999999');
  });
  it('writes a quantity as the API does and reverses one exactly', () => {
    expect(plainQuantity('5.500000')).toBe('5.5');
    expect(plainQuantity('-0.000000')).toBe('0');
    expect(oppositeQuantity('-20.5')).toBe('20.5');
    expect(oppositeQuantity('3')).toBe('-3');
  });
  it('names the goods accounts of each side', () => {
    expect(STOCK_GOODS_ACCOUNT).toEqual({ purchase: '156', sale: '5111' });
  });
});
