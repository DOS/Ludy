// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { feeAccrualDescription, feeAccrualKey, parseFeeAccrualKey } from '../src/marketplace-fee-accrual-guard.ts';
import { lastEndedMonth } from '../src/marketplace-fee-accrual.ts';

describe('the key of a month-end fee accrual', () => {
  it('is in the description and parses back to the platform and the month', () => {
    const description = feeAccrualDescription('TikTok Shop', 'tiktok_shop', '2026-10');
    expect(description).toBe('Trích trước phí sàn tháng 10/2026, ước tính (TikTok Shop) [fee-accrual:tiktok_shop:2026-10]');
    expect(feeAccrualKey('tiktok_shop', '2026-10')).toBe('[fee-accrual:tiktok_shop:2026-10]');
    expect(parseFeeAccrualKey(description)).toEqual({ platform: 'tiktok_shop', month: '2026-10' });
  });
  it('is not found in a description without it, or with a malformed one', () => {
    expect(parseFeeAccrualKey('Trích trước phí sàn tháng 10/2026')).toBeNull();
    expect(parseFeeAccrualKey('[fee-accrual:shopee:2026-1]')).toBeNull();
    expect(parseFeeAccrualKey('[fee-accrual:Shopee:2026-10]')).toBeNull();
  });
});

describe('the last month that has ended', () => {
  it('is this month on its last day and the month before on any other day', () => {
    expect(lastEndedMonth('2026-10-31')).toBe('2026-10');
    expect(lastEndedMonth('2026-11-01')).toBe('2026-10');
    expect(lastEndedMonth('2026-11-03')).toBe('2026-10');
    expect(lastEndedMonth('2026-11-30')).toBe('2026-11');
  });
  it('crosses a year and knows the length of February', () => {
    expect(lastEndedMonth('2026-01-05')).toBe('2025-12');
    expect(lastEndedMonth('2026-02-28')).toBe('2026-02');
    expect(lastEndedMonth('2028-02-28')).toBe('2028-01');
    expect(lastEndedMonth('2028-02-29')).toBe('2028-02');
  });
});
