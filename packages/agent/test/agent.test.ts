import { describe, expect, it } from 'vitest';
import { AmountFormatError, printedBankAccount, toParsed } from '../src/index.ts';

type Extracted = Parameters<typeof toParsed>[0];

const base: Extracted = {
  isInvoice: true,
  series: 'C26TAB',
  number: '00001234',
  issueDate: '2026-09-15',
  currency: 'VND',
  seller: { name: 'Người bán', taxCode: '0101234564', address: null, bankAccount: null },
  buyer: { name: 'Người mua', taxCode: null, address: null },
  lines: [{ description: 'Dịch vụ', unit: null, quantity: '1', unitPrice: '250000', amount: '250000', vatRate: '10%', isDiscount: false }],
  subtotal: '250000',
  vatTotal: '25000',
  total: '275000',
};

describe('AI extraction output', () => {
  it('keeps plain amounts and normalizes the invoice number', () => {
    const parsed = toParsed(base);
    expect(parsed?.total).toBe('275000');
    expect(parsed?.number).toBe('1234');
  });

  it('refuses printed VND amounts instead of reading 250.000 as 250', () => {
    expect(() => toParsed({ ...base, total: '275.000' })).toThrow(AmountFormatError);
    expect(() => toParsed({ ...base, subtotal: '1,250,000' })).toThrow(AmountFormatError);
  });

  it('allows decimals for foreign currencies and treats an empty VAT as zero', () => {
    const parsed = toParsed({ ...base, currency: 'usd', subtotal: '12.5', total: '12.5', vatTotal: '' });
    expect(parsed?.currency).toBe('USD');
    expect(parsed?.vatTotal).toBe('0');
  });

  it('keeps the seller\'s bank account only when it is a plain copy, and checks it against the PDF text when there is one (#2426)', () => {
    const account = (value: string | null, sourceText?: string) => toParsed({ ...base, seller: { ...base.seller, bankAccount: value } }, sourceText)?.seller.bankAccount;
    // A photo has no text to check against: a printed account of 6 or more digits is kept as printed, nothing else of the answer changes.
    expect(account('0011 2233 4455')).toBe('0011 2233 4455');
    expect(account('  STK 001122334455 (VCB)  ')).toBe('STK 001122334455 (VCB)');
    expect(toParsed({ ...base, seller: { ...base.seller, bankAccount: null } })?.seller).not.toHaveProperty('bankAccount');
    // Not an account: empty, a note, a short code, too long.
    expect(account(null)).toBeUndefined();
    expect(account('')).toBeUndefined();
    expect(account('N/A')).toBeUndefined();
    expect(account('12345')).toBeUndefined();
    expect(account(`TK ${'1234567890 '.repeat(8)}`)).toBeUndefined();
    // From a PDF every digit run the model wrote must be in the text (digits split by spaces or dots are one run): an account the text does not hold is dropped, never repaired.
    const text = 'Số tài khoản: 0011.2233.4455 tại Vietcombank\nTổng cộng 275.000';
    expect(account('001122334455', text)).toBe('001122334455');
    expect(account('0011 2233 4455', text)).toBe('0011 2233 4455');
    expect(account('001122334456', text)).toBeUndefined();
    expect(account('0011 2233 4455 / 0987654321', text)).toBeUndefined();
    expect(printedBankAccount('001122334455', '')).toBeNull();
  });
});
