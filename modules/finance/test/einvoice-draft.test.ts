// SPDX-License-Identifier: AGPL-3.0-only
// The amounts and the checks of a sales e-invoice draft (#2500): decimal arithmetic to the whole dong, the VAT rates a provider accepts, and the issue codes on their
// fields.
import { describe, expect, it } from 'vitest';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { checkDraft, computeDraft, normalizeVatRate, type DraftInput } from '../src/domain/einvoice-draft.ts';

// A synthetic tax code made at run time (the repository holds no checksum-valid one): a nine digit prefix and its check digit, and the same with the check digit off by one.
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const BAD_TAX_CODE = `${PREFIX}${((enterpriseCheckDigit(PREFIX) ?? 0) + 1) % 10}`;

const line = (extra: Partial<DraftInput['lines'][number]> = {}) => ({ description: 'Hàng', unit: 'cái', quantity: '1', unitPrice: '100000', vatRate: '10%', ...extra });
const draft = (extra: Partial<DraftInput> = {}): DraftInput => ({
  date: '2026-11-03',
  currency: 'VND',
  seriesId: '00000000-0000-4000-8000-000000000001',
  buyer: { kind: 'business', taxCode: VALID_TAX_CODE, name: 'Công ty Mua', address: '1 Phố Thử', email: null },
  lines: [line()],
  ...extra,
});
const codes = (input: DraftInput, today = '2026-11-03') => checkDraft(input, computeDraft(input.lines), today).map((i) => `${i.field}:${i.code}`);

describe('normalizeVatRate', () => {
  it('writes the allowed rates one way and refuses the rest', () => {
    expect(normalizeVatRate('10')).toBe('10%');
    expect(normalizeVatRate(' 8 % ')).toBe('8%');
    expect(normalizeVatRate('0')).toBe('0%');
    expect(normalizeVatRate('kct')).toBe('KCT');
    expect(normalizeVatRate('KKKNT')).toBe('KKKNT');
    expect(normalizeVatRate('KHAC:5.26%')).toBe('KHAC:5.26%');
    for (const bad of ['7%', '12', '150', 'abc', '', 'KHAC']) expect(normalizeVatRate(bad), bad).toBeNull();
  });
});

describe('computeDraft', () => {
  it('rounds each line half up to the whole dong and sums the rounded lines', () => {
    const out = computeDraft([line({ quantity: '1.5', unitPrice: '33333', vatRate: '8%' }), line({ quantity: '3', unitPrice: '3333.3', vatRate: '10%' })]);
    // 1.5 x 33333 = 49999.5 -> 50000, VAT 4000; 3 x 3333.3 = 9999.9 -> 10000, VAT 1000.
    expect(out.lines.map((l) => [l.amount, l.vatAmount])).toEqual([
      ['50000', '4000'],
      ['10000', '1000'],
    ]);
    expect([out.subtotal, out.vatAmount, out.total]).toEqual(['60000', '5000', '65000']);
  });

  it('takes no VAT on exempt lines and never goes through a JS number', () => {
    const out = computeDraft([line({ vatRate: 'KCT', quantity: '1', unitPrice: '123456789012' })]);
    expect([out.subtotal, out.vatAmount, out.total]).toEqual(['123456789012', '0', '123456789012']);
    const tenth = computeDraft([line({ quantity: '0.1', unitPrice: '0.2', vatRate: '0%' })]);
    expect(tenth.subtotal).toBe('0');
  });

  it('leaves a line it cannot compute at zero for the checks to report', () => {
    const out = computeDraft([line({ quantity: 'abc' })]);
    expect(out.lines[0]?.amount).toBe('0');
    expect(codes(draft({ lines: [line({ quantity: 'abc' })] }))).toContain('lines.1.quantity:LINE_QUANTITY_INVALID');
  });
});

describe('checkDraft', () => {
  it('passes a complete business draft', () => {
    expect(codes(draft())).toEqual([]);
  });

  it('asks a business buyer for a valid tax code, a name and an address, and an individual for a name', () => {
    expect(codes(draft({ buyer: { kind: 'business', taxCode: null, name: null, address: null, email: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_REQUIRED', 'buyer.name:BUYER_NAME_REQUIRED', 'buyer.address:BUYER_ADDRESS_REQUIRED']);
    expect(codes(draft({ buyer: { kind: 'business', taxCode: '12345', name: 'A', address: 'B', email: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_INVALID']);
    expect(codes(draft({ buyer: { kind: 'business', taxCode: BAD_TAX_CODE, name: 'A', address: 'B', email: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_CHECKSUM']);
    expect(codes(draft({ buyer: { kind: 'individual', taxCode: null, name: null, address: null, email: null } }))).toEqual(['buyer.name:BUYER_NAME_REQUIRED']);
    expect(codes(draft({ buyer: { kind: 'individual', taxCode: '012345678901', name: 'Một Người', address: null, email: null } }))).toEqual([]);
    expect(codes(draft({ buyer: { kind: 'consumer', taxCode: null, name: null, address: null, email: null } }))).toEqual([]);
  });

  it('checks the date, the series, the currency, the email and the lines', () => {
    expect(codes(draft({ date: '' }))).toEqual(['date:DATE_REQUIRED']);
    expect(codes(draft({ date: '2026-02-30' }))).toEqual(['date:DATE_INVALID']);
    expect(codes(draft({ date: '2026-11-04' }))).toEqual(['date:DATE_FUTURE']);
    expect(codes(draft({ seriesId: null }))).toEqual(['series:SERIES_REQUIRED']);
    expect(codes(draft({ currency: 'USD' }))).toEqual(['currency:CURRENCY_UNSUPPORTED']);
    expect(codes(draft({ buyer: { kind: 'consumer', taxCode: null, name: null, address: null, email: 'a@b' } }))).toEqual(['buyer.email:BUYER_EMAIL_INVALID']);
    expect(codes(draft({ lines: [] }))).toEqual(['lines:LINES_REQUIRED']);
    expect(codes(draft({ lines: [line({ description: ' ', quantity: '0', unitPrice: '-1', vatRate: '7%' })] }))).toEqual([
      'lines.1.description:LINE_DESCRIPTION_REQUIRED',
      'lines.1.quantity:LINE_QUANTITY_INVALID',
      'lines.1.unitPrice:LINE_PRICE_INVALID',
      'lines.1.vatRate:LINE_VAT_RATE_INVALID',
    ]);
  });

  it('names the second line by its position from 1', () => {
    expect(codes(draft({ lines: [line(), line({ quantity: 'x' })] }))).toEqual(['lines.2.quantity:LINE_QUANTITY_INVALID']);
  });
});
