// SPDX-License-Identifier: AGPL-3.0-only
// When an item is running low and how much to ask for, the fixed words of a reorder message, and which items the model is offered (#2514). Pure: no clock, no database.
import { describe, expect, it } from 'vitest';
import { LOW_MIN_DAYS, LOW_WINDOW_DAYS, lowFigures, observedDays, pickCandidates, reorderTemplate } from '../src/domain/stock-low.ts';

describe('observedDays', () => {
  it('is the days since the first move, within a week and eight weeks', () => {
    expect(observedDays('2026-11-30', null)).toBe(LOW_MIN_DAYS);
    expect(observedDays('2026-11-30', '2026-11-30')).toBe(LOW_MIN_DAYS);
    expect(observedDays('2026-11-30', '2026-11-20')).toBe(11);
    expect(observedDays('2026-11-30', '2024-01-01')).toBe(LOW_WINDOW_DAYS);
  });
});

describe('lowFigures', () => {
  it('is null when nothing sold, or when the stock lasts the lead days', () => {
    expect(lowFigures({ onHand: '5', sold: '0', days: 56, leadDays: 14 })).toBeNull();
    expect(lowFigures({ onHand: '5', sold: '-3', days: 56, leadDays: 14 })).toBeNull();
    // 56 sold in 56 days is one a day: 14 on hand lasts exactly the 14 lead days.
    expect(lowFigures({ onHand: '14', sold: '56', days: 56, leadDays: 14 })).toBeNull();
    expect(lowFigures({ onHand: '100', sold: '56', days: 56, leadDays: 14 })).toBeNull();
  });

  it('gives the pace, the whole days of cover and a quantity for two lead times, to whole units', () => {
    // One a day, 13 on hand: 13 days of cover, which is under 14. Two lead times is 28, less 13 on hand: 15.
    expect(lowFigures({ onHand: '13', sold: '56', days: 56, leadDays: 14 })).toEqual({ dailyOut: '1', coverDays: 13, suggestedQuantity: '15' });
    // 30 sold in 7 days is about 4.286 a day; 10 on hand covers 2 days; 2 x 14 x 4.2857 = 120.0, less 10 is 110.
    expect(lowFigures({ onHand: '10', sold: '30', days: 7, leadDays: 14 })).toEqual({ dailyOut: '4.286', coverDays: 2, suggestedQuantity: '110' });
  });

  it('counts a negative or empty stock as none on hand, and always asks for at least one unit', () => {
    expect(lowFigures({ onHand: '-4', sold: '56', days: 56, leadDays: 14 })).toEqual({ dailyOut: '1', coverDays: 0, suggestedQuantity: '28' });
    expect(lowFigures({ onHand: '0', sold: '56', days: 56, leadDays: 14 })).toEqual({ dailyOut: '1', coverDays: 0, suggestedQuantity: '28' });
    // A slow item: 1 sold in 56 days, nothing on hand: 28 days of sales is half a unit, rounded up to one.
    expect(lowFigures({ onHand: '0', sold: '1', days: 56, leadDays: 14 })).toEqual({ dailyOut: '0.018', coverDays: 0, suggestedQuantity: '1' });
  });

  it('keeps decimals exact (a decimal quantity never goes through a float)', () => {
    // 0.3 + 0.6 style sums would drift as floats: 4.2 sold in 7 days is 0.6 a day exactly; 5 on hand is 8.33 days, floored to 8.
    expect(lowFigures({ onHand: '5', sold: '4.2', days: 7, leadDays: 14 })).toEqual({ dailyOut: '0.6', coverDays: 8, suggestedQuantity: '12' });
  });
});

describe('reorderTemplate', () => {
  const items = [
    { name: 'Áo thun trắng M', quantity: '40.000000', unit: 'cái' },
    { name: 'Nước suối 500ml', quantity: '12.5', unit: 'thùng' },
  ];

  it('is a greeting, a line per item with its quantity and unit, a request to confirm and the business name', () => {
    expect(reorderTemplate({ language: 'vi', orgName: 'Công ty Hoa Mai', supplierName: 'Phương Nam', items })).toBe(
      'Chào Phương Nam,\n\nCông ty Hoa Mai muốn đặt thêm các mặt hàng dưới đây. Xin anh chị xác nhận số lượng có thể giao:\n- Áo thun trắng M: 40 cái\n- Nước suối 500ml: 12.5 thùng\n\nXin cảm ơn.\nCông ty Hoa Mai',
    );
    expect(reorderTemplate({ language: 'en', orgName: 'Hoa Mai Ltd', supplierName: null, items })).toBe(
      'Hello Supplier,\n\nHoa Mai Ltd would like to reorder the items below. Please confirm what you can deliver:\n- Áo thun trắng M: 40 cái\n- Nước suối 500ml: 12.5 thùng\n\nThank you,\nHoa Mai Ltd',
    );
  });

  it('greets a supplier that is not named by a plain word', () => {
    expect(reorderTemplate({ language: 'vi', orgName: 'A', supplierName: null, items: [items[0]!] })).toMatch(/^Chào nhà cung cấp,/);
  });
});

describe('pickCandidates', () => {
  const item = (code: string, name: string) => ({ code, name });

  it('offers every item, in order, when there are no more than the bound', () => {
    const all = [item('B', 'Bút'), item('A', 'Áo')];
    expect(pickCandidates(['ao'], all, 5)).toEqual(all);
  });

  it('offers those that share the most words with the lines when there are more, ignoring diacritics', () => {
    const all = [item('A1', 'Nước suối 500ml'), item('A2', 'Áo thun cổ tròn đen'), item('A3', 'Áo thun cổ tròn trắng'), item('A4', 'Bút bi xanh')];
    expect(pickCandidates(['Ao thun co tron den L'], all, 2).map((i) => i.code)).toEqual(['A2', 'A3']);
    // No shared word at all: the first by code.
    expect(pickCandidates(['xyz'], all, 2).map((i) => i.code)).toEqual(['A1', 'A2']);
  });

  it('reads an uppercase Đ like a lowercase one', () => {
    const all = [item('A1', 'Bút bi xanh'), item('A2', 'Áo Đen'), item('A3', 'Nước suối')];
    expect(pickCandidates(['ao den'], all, 1).map((i) => i.code)).toEqual(['A2']);
    expect(pickCandidates(['ĐEN'], all, 1).map((i) => i.code)).toEqual(['A2']);
  });
});
