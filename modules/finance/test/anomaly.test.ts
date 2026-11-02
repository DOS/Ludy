// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly flags of a purchase invoice (#2380): each rule raises on a synthetic case and not on a normal one, a vendor
// with too little history raises nothing, and the sentences carry the figures a person needs and nothing more of an account
// number than its last four characters.
import { describe, expect, it } from 'vitest';
import { AMOUNT_MIN_HISTORY, amountCheck, anomalyChecks, bankAccountCheck, maskBankAccount, normalizeBankAccount, priceCheck } from '../src/domain/anomaly.ts';

describe('bank account', () => {
  it('flags an account the vendor never used before, naming the last one by its last four characters', () => {
    const check = bankAccountCheck('0987654321', ['0011000000000', '0011000000000']);
    expect(check).toMatchObject({ id: 'anomaly_bank', status: 'warn', code: 'anomaly_bank.changed', params: { previous: '********0000', current: '******4321' } });
    // The Vietnamese sentence says so and never spells an account out.
    expect(check?.message).toContain('Ly cảnh báo');
    expect(check?.message).not.toContain('0987654321');
    expect(check?.message).not.toContain('0011000000000');
  });

  it('does not flag the same account written another way, an account used before, the first one seen, or none', () => {
    expect(bankAccountCheck('0011 000 000 000', ['0011000000000'])).toBeNull();
    expect(bankAccountCheck('0987654321', ['0011000000000', '0987654321'])).toBeNull();
    expect(bankAccountCheck('0987654321', [])).toBeNull();
    expect(bankAccountCheck(null, ['0011000000000'])).toBeNull();
    expect(bankAccountCheck('', ['0011000000000'])).toBeNull();
    expect(bankAccountCheck(undefined, ['0011000000000'])).toBeNull();
  });

  it('normalizes and masks account numbers', () => {
    expect(normalizeBankAccount('00-11.000 abc')).toBe('0011000ABC');
    expect(maskBankAccount('1234')).toBe('1234');
    expect(maskBankAccount('0011000000000')).toBe('********0000');
  });
});

describe('amount', () => {
  const usual = ['1000000', '1200000', '900000', '1100000', '1000000', '950000'];

  it('flags an amount three times the usual or a third of it, judged on the median of the last invoices', () => {
    expect(amountCheck('4000000', usual)).toMatchObject({ id: 'anomaly_amount', status: 'warn', code: 'anomaly_amount.unusual', params: { total: '4000000', usual: '1000000', count: '6', direction: 'high', ratio: '4.0', percent: '400' } });
    // The sentence states the rule it applied.
    expect(amountCheck('4000000', usual)?.message).toContain('cao gấp 4.0 lần mức thường');
    expect(amountCheck('4000000', usual)?.message).toContain('cảnh báo từ 3 lần');
    expect(amountCheck('300000', usual)).toMatchObject({ params: { total: '300000', direction: 'low' } });
    expect(amountCheck('3000000', usual)?.params?.direction).toBe('high');
  });

  it('does not flag an amount near the usual, nor judge a vendor with fewer than five earlier invoices', () => {
    expect(amountCheck('1500000', usual)).toBeNull();
    expect(amountCheck('2900000', usual)).toBeNull();
    expect(amountCheck('400000', usual)).toBeNull();
    expect(amountCheck('9000000', usual.slice(0, AMOUNT_MIN_HISTORY - 1))).toBeNull();
    expect(amountCheck('0', usual)).toBeNull();
  });

  it('ignores earlier totals that are not amounts', () => {
    expect(amountCheck('9000000', ['x', 'y', '', '0', '-5'])).toBeNull();
  });
});

describe('unit price', () => {
  const earlier = [
    { description: 'Cước internet tháng 10/2026', unitPrice: '1000000' },
    { description: 'Cước internet tháng 09/2026', unitPrice: '1000000' },
    { description: 'Cước internet tháng 08/2026', unitPrice: '1100000' },
    { description: 'Giấy A4', unitPrice: '60000' },
  ];

  it('flags a price at least a quarter above the usual price of the same item, whatever the month or number in its name', () => {
    const check = priceCheck([{ description: 'Cước internet tháng 11/2026', unitPrice: '1400000' }], earlier);
    expect(check).toMatchObject({ id: 'anomaly_price', status: 'warn', code: 'anomaly_price.jump', params: { usual: '1000000', current: '1400000', percent: '40' } });
    expect(check?.params?.item).toBe('Cước internet tháng 11/2026');
  });

  it('names the largest rise when several lines rose', () => {
    const check = priceCheck(
      [
        { description: 'Giấy A4', unitPrice: '90000' },
        { description: 'Cước internet tháng 11/2026', unitPrice: '1400000' },
      ],
      earlier,
    );
    expect(check?.params).toMatchObject({ item: 'Giấy A4', percent: '50' });
  });

  it('does not flag a price that fell, a small rise, an item with no earlier price, or a line with no price', () => {
    expect(priceCheck([{ description: 'Cước internet tháng 11/2026', unitPrice: '900000' }], earlier)).toBeNull();
    expect(priceCheck([{ description: 'Cước internet tháng 11/2026', unitPrice: '1200000' }], earlier)).toBeNull();
    expect(priceCheck([{ description: 'Mực in', unitPrice: '999999999' }], earlier)).toBeNull();
    expect(priceCheck([{ description: 'Giấy A4', unitPrice: null }], earlier)).toBeNull();
    expect(priceCheck([{ description: '12345', unitPrice: '1' }], earlier)).toBeNull();
  });

  it('cuts a long item name', () => {
    const long = `Dịch vụ ${'tư vấn '.repeat(30)}`;
    const check = priceCheck([{ description: long, unitPrice: '500000' }], [{ description: long, unitPrice: '100000' }]);
    expect(check?.params?.item?.length ?? 0).toBeLessThanOrEqual(60);
  });
});

describe('anomalyChecks', () => {
  const history = { totals: ['1000000', '1000000', '1000000', '1000000', '1000000'], prices: [{ description: 'Giấy A4', unitPrice: '60000' }], bankAccounts: ['0011000000000'] };

  it('raises each flag in a fixed order, and none for a vendor the books do not know', () => {
    const invoice = { sellerBankAccount: '0987654321', total: '5000000', lines: [{ description: 'Giấy A4', unitPrice: '90000' }] };
    expect(anomalyChecks(invoice, history).map((c) => c.id)).toEqual(['anomaly_bank', 'anomaly_amount', 'anomaly_price']);
    expect(anomalyChecks(invoice, null)).toEqual([]);
  });

  it('raises nothing on a normal invoice', () => {
    expect(anomalyChecks({ sellerBankAccount: '0011000000000', total: '1100000', lines: [{ description: 'Giấy A4', unitPrice: '62000' }] }, history)).toEqual([]);
  });
});
