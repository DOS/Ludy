// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rate of an adjusting or a replacing sales e-invoice across the end of the 8% rate (#3709, plan einvoice-issue.md section 3c, research E row 7): by the nature a person picks, the first three
// keep the original's rate and a change of amount uses the rate in force on the correction date.
import { describe, expect, it } from 'vitest';
import { EINVOICE_RATE_NATURES } from '@crove/kernel-contract';
import {
  CORRECTION_RATE_PRECEDENT_NOTE,
  correctionRateDate,
  correctionRateReason,
  proposeCorrectionRate,
  proposeCorrectionRates,
  rateBasisOf,
  reducedEnd,
} from '../src/domain/einvoice-correction-rate.ts';

const ORIGINAL = '2026-11-20';
const propose = (nature: (typeof EINVOICE_RATE_NATURES)[number], rate: string, correctionDate: string) => proposeCorrectionRate({ nature, rate, originalDate: ORIGINAL, correctionDate });

describe('proposeCorrectionRate', () => {
  it('keeps 8% for a correction that changes no amount, a return and a trade discount, on the original basis, even in 2027', () => {
    for (const nature of ['no_amount_change', 'return', 'trade_discount'] as const) {
      const proposed = propose(nature, '8%', '2027-01-10');
      expect(proposed.rate).toBe('8%');
      expect(proposed.basis).toBe('original');
    }
    expect(propose('no_amount_change', '8%', '2027-01-10').reasonCode).toBe('kept_no_change');
    expect(propose('return', '8%', '2027-01-10').reasonCode).toBe('kept_return');
    expect(propose('trade_discount', '8%', '2027-01-10').reasonCode).toBe('kept_trade_discount');
  });

  it('moves 8% to 10% for a change of amount made after 2026-12-31, on the correction date basis', () => {
    expect(propose('amount_change', '8%', '2027-01-01')).toEqual({ basis: 'correction_date', rate: '10%', reasonCode: 'amount_change_standard' });
    expect(propose('amount_change', '8%', '2027-06-30').rate).toBe('10%');
  });

  it('keeps 8% for a change of amount made up to 2026-12-31, still on the correction date basis', () => {
    expect(propose('amount_change', '8%', '2026-12-31')).toEqual({ basis: 'correction_date', rate: '8%', reasonCode: 'amount_change_still_reduced' });
    expect(propose('amount_change', '8%', '2026-11-25').rate).toBe('8%');
  });

  it('keeps 0, 5, 10, KCT, KKKNT and any other rate whatever the nature and the date', () => {
    for (const rate of ['0%', '5%', '10%', 'KCT', 'KKKNT', 'KHAC:3%']) {
      for (const nature of EINVOICE_RATE_NATURES) expect(propose(nature, rate, '2027-03-01').rate).toBe(rate);
    }
    expect(propose('amount_change', '10%', '2027-03-01').reasonCode).toBe('amount_change_no_reduced');
  });

  it('reads a rate however it is written', () => {
    expect(propose('amount_change', '8', '2027-01-10').rate).toBe('10%');
    expect(propose('amount_change', ' 8 % ', '2027-01-10').rate).toBe('10%');
  });

  it('gives each nature one basis', () => {
    expect(rateBasisOf('no_amount_change')).toBe('original');
    expect(rateBasisOf('return')).toBe('original');
    expect(rateBasisOf('trade_discount')).toBe('original');
    expect(rateBasisOf('amount_change')).toBe('correction_date');
  });
});

describe('proposeCorrectionRates over the rates of a whole original', () => {
  const rates = ['8%', '10%', '8%', 'KCT'];
  it('lists the rates that move and the ones that stay, each once', () => {
    const moved = proposeCorrectionRates({ nature: 'amount_change', rates, originalDate: ORIGINAL, correctionDate: '2027-01-10' });
    expect(moved).toEqual({ nature: 'amount_change', basis: 'correction_date', reasonCode: 'amount_change_standard', changes: [{ from: '8%', to: '10%' }], kept: ['10%', 'KCT'] });
    const kept = proposeCorrectionRates({ nature: 'return', rates, originalDate: ORIGINAL, correctionDate: '2027-01-10' });
    expect(kept.changes).toEqual([]);
    expect(kept.kept).toEqual(['8%', '10%', 'KCT']);
    expect(kept.reasonCode).toBe('kept_return');
  });
  it('says the 8% stays while the correction date is still inside the reduced period, and that nothing moves when no line is at 8%', () => {
    expect(proposeCorrectionRates({ nature: 'amount_change', rates, originalDate: ORIGINAL, correctionDate: '2026-12-01' }).reasonCode).toBe('amount_change_still_reduced');
    expect(proposeCorrectionRates({ nature: 'amount_change', rates: ['10%', '5%'], originalDate: ORIGINAL, correctionDate: '2027-01-10' }).reasonCode).toBe('amount_change_no_reduced');
    expect(proposeCorrectionRates({ nature: 'amount_change', rates: [], originalDate: ORIGINAL, correctionDate: '2027-01-10' }).changes).toEqual([]);
  });
});

describe('the day the rate of a correction is judged on', () => {
  it('is the original\'s unless the person confirmed the correction\'s own, and also for a correction made before the basis existed', () => {
    expect(correctionRateDate('original', ORIGINAL)).toBe(ORIGINAL);
    expect(correctionRateDate(null, ORIGINAL)).toBe(ORIGINAL);
    expect(correctionRateDate('correction_date', ORIGINAL)).toBeNull();
    expect(correctionRateDate(null, null)).toBeNull();
  });
});

describe('the fixed reason and the precedent note', () => {
  it('writes the reason by code in Vietnamese, with the dates', () => {
    const moved = proposeCorrectionRates({ nature: 'amount_change', rates: ['8%'], originalDate: ORIGINAL, correctionDate: '2027-01-10' });
    expect(correctionRateReason(moved, '2027-01-10')).toBe('Sai sót làm thay đổi số tiền nên thuế suất theo ngày lập hóa đơn điều chỉnh (10/01/2027); ngày này sau 31/12/2026 nên dòng 8% chuyển sang 10%.');
    const kept = proposeCorrectionRates({ nature: 'no_amount_change', rates: ['8%'], originalDate: ORIGINAL, correctionDate: '2027-01-10' });
    expect(correctionRateReason(kept, '2027-01-10')).toContain('giữ thuế suất của hóa đơn gốc');
    for (const nature of EINVOICE_RATE_NATURES) {
      for (const date of ['2026-12-01', '2027-01-10']) expect(correctionRateReason(proposeCorrectionRates({ nature, rates: ['8%', '10%'], originalDate: ORIGINAL, correctionDate: date }), date)).not.toBe('');
    }
  });
  it('names Official Letter 2121/TCT-CS and gives no day count', () => {
    expect(reducedEnd()).toBe('2026-12-31');
    expect(CORRECTION_RATE_PRECEDENT_NOTE).toContain('2121/TCT-CS');
    expect(CORRECTION_RATE_PRECEDENT_NOTE).toContain('29/05/2023');
  });
});
