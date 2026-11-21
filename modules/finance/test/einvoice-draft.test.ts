// SPDX-License-Identifier: AGPL-3.0-only
// The amounts and the checks of a sales e-invoice draft (#2500): decimal arithmetic to the whole dong, the VAT rates a provider accepts, and the issue codes on their
// fields.
import { describe, expect, it } from 'vitest';
import { enterpriseCheckDigit } from '@ludy/l10n-vn';
import { checkDraft, computeDraft, isBuyerIdentity, isLateSale, isNationalityCode, maskBuyerIdentity, nextWorkingDay, normalizeVatRate, type DraftInput } from '../src/domain/einvoice-draft.ts';

// A synthetic tax code made at run time (the repository holds no checksum-valid one): a nine digit prefix and its check digit, and the same with the check digit off by one.
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const BAD_TAX_CODE = `${PREFIX}${((enterpriseCheckDigit(PREFIX) ?? 0) + 1) % 10}`;

const line = (extra: Partial<DraftInput['lines'][number]> = {}) => ({ description: 'Hàng', unit: 'cái', quantity: '1', unitPrice: '100000', vatRate: '10%', ...extra });
const draft = (extra: Partial<DraftInput> = {}): DraftInput => ({
  date: '2026-11-03',
  saleDate: null,
  lateReason: null,
  currency: 'VND',
  seriesId: '00000000-0000-4000-8000-000000000001',
  buyer: { kind: 'business', taxCode: VALID_TAX_CODE, name: 'Công ty Mua', address: '1 Phố Thử', email: null, identity: null },
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
    expect(codes(draft({ buyer: { kind: 'business', taxCode: null, name: null, address: null, email: null, identity: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_REQUIRED', 'buyer.name:BUYER_NAME_REQUIRED', 'buyer.address:BUYER_ADDRESS_REQUIRED']);
    expect(codes(draft({ buyer: { kind: 'business', taxCode: '12345', name: 'A', address: 'B', email: null, identity: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_INVALID']);
    expect(codes(draft({ buyer: { kind: 'business', taxCode: BAD_TAX_CODE, name: 'A', address: 'B', email: null, identity: null } }))).toEqual(['buyer.taxCode:BUYER_TAX_CODE_CHECKSUM']);
    expect(codes(draft({ buyer: { kind: 'individual', taxCode: null, name: null, address: null, email: null, identity: null } }))).toEqual(['buyer.name:BUYER_NAME_REQUIRED']);
    expect(codes(draft({ buyer: { kind: 'individual', taxCode: '012345678901', name: 'Một Người', address: null, email: null, identity: null } }))).toEqual([]);
    expect(codes(draft({ buyer: { kind: 'consumer', taxCode: null, name: null, address: null, email: null, identity: null } }))).toEqual([]);
  });

  it('checks the date, the series, the currency, the email and the lines', () => {
    expect(codes(draft({ date: '' }))).toEqual(['date:DATE_REQUIRED']);
    expect(codes(draft({ date: '2026-02-30' }))).toEqual(['date:DATE_INVALID']);
    expect(codes(draft({ date: '2026-11-04' }))).toEqual(['date:DATE_FUTURE']);
    expect(codes(draft({ seriesId: null }))).toEqual(['series:SERIES_REQUIRED']);
    expect(codes(draft({ currency: 'USD' }))).toEqual(['currency:CURRENCY_UNSUPPORTED']);
    expect(codes(draft({ buyer: { kind: 'consumer', taxCode: null, name: null, address: null, email: 'a@b', identity: null } }))).toEqual(['buyer.email:BUYER_EMAIL_INVALID']);
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

// #3535: a sale invoiced after its next working day is a late invoice: it needs the person's reason, and it stays in the VAT period of its sale.
describe('nextWorkingDay', () => {
  it('is the next day on a weekday, and Monday after a Friday or a weekend', () => {
    expect(nextWorkingDay('2026-11-02')).toBe('2026-11-03'); // Monday
    expect(nextWorkingDay('2026-11-05')).toBe('2026-11-06'); // Thursday
    expect(nextWorkingDay('2026-11-06')).toBe('2026-11-09'); // Friday
    expect(nextWorkingDay('2026-11-07')).toBe('2026-11-09'); // Saturday
    expect(nextWorkingDay('2026-11-08')).toBe('2026-11-09'); // Sunday
    expect(nextWorkingDay('2026-12-31')).toBe('2027-01-01');
  });
});

describe('isLateSale', () => {
  it('is late only when the invoice is dated after the next working day of the sale', () => {
    expect(isLateSale('2026-11-02', '2026-11-03')).toBe(false); // the next working day itself
    expect(isLateSale('2026-11-02', '2026-11-04')).toBe(true);
    expect(isLateSale('2026-11-06', '2026-11-09')).toBe(false); // Friday's sale, invoiced Monday
    expect(isLateSale('2026-11-06', '2026-11-10')).toBe(true);
    expect(isLateSale('2026-10-30', '2026-11-03')).toBe(true); // a sale of the month before, a missed invoice
  });

  it('is not late with no sale date, the same day, a later sale or a date that is not one', () => {
    expect(isLateSale(null, '2026-11-03')).toBe(false);
    expect(isLateSale('2026-11-03', '2026-11-03')).toBe(false);
    expect(isLateSale('2026-11-05', '2026-11-03')).toBe(false);
    expect(isLateSale('2026-02-30', '2026-11-03')).toBe(false);
  });
});

describe('checkDraft: the sale date', () => {
  it('accepts a sale date of the invoice day or of the day before, with no reason', () => {
    expect(codes(draft({ saleDate: '2026-11-02' }))).toEqual([]);
  });

  it('asks for a reason when the sale is older than the next working day, and takes it', () => {
    expect(codes(draft({ saleDate: '2026-10-28' }))).toEqual(['lateReason:LATE_REASON_REQUIRED']);
    expect(codes(draft({ saleDate: '2026-10-28', lateReason: '   ' }))).toEqual(['lateReason:LATE_REASON_REQUIRED']);
    expect(codes(draft({ saleDate: '2026-10-28', lateReason: 'Quên lập hóa đơn, phát hiện khi đối chiếu cuối tháng' }))).toEqual([]);
  });

  it('refuses a sale date that is not a date or is after the invoice', () => {
    expect(codes(draft({ saleDate: '2026-13-01' }))).toEqual(['saleDate:SALE_DATE_INVALID']);
    expect(codes(draft({ saleDate: '2026-11-04' }))).toEqual(['saleDate:SALE_DATE_AFTER_INVOICE']);
  });
});

describe('8% by the date of the sale (#3678)', () => {
  const eight = [line({ vatRate: '8%' })];
  const REFUSED = 'lines.1.vatRate:LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD';
  it('passes on the last day of the period and is refused from the day after', () => {
    expect(codes(draft({ date: '2026-12-31', lines: eight }), '2026-12-31')).not.toContain(REFUSED);
    expect(codes(draft({ date: '2027-01-01', lines: eight }), '2027-01-01')).toContain(REFUSED);
  });
  it('is judged on the sale date when the invoice is later, and on the invoice date when there is none', () => {
    // Sold on 2026-12-31, invoiced in January: the sale is inside the period.
    expect(codes(draft({ date: '2027-01-04', saleDate: '2026-12-31', lateReason: 'Chờ khách xác nhận', lines: eight }), '2027-01-04')).not.toContain(REFUSED);
    // Sold in 2027 but not dated: the invoice date decides, and 2027 is outside.
    expect(codes(draft({ date: '2027-02-02', saleDate: null, lines: eight }), '2027-02-02')).toContain(REFUSED);
  });
  it('is refused in the gap between two periods (2023-01-01 to 2023-06-30 had no 8%)', () => {
    expect(codes(draft({ date: '2023-03-01', lines: eight }), '2026-11-03')).toContain(REFUSED);
    expect(codes(draft({ date: '2023-07-01', lines: eight }), '2026-11-03')).not.toContain(REFUSED);
  });
  it('an adjustment of a 2026 invoice dated in 2027 keeps the original date for the rate', () => {
    expect(codes(draft({ date: '2027-01-10', rateDate: '2026-11-20', lines: eight }), '2027-01-10')).not.toContain(REFUSED);
    // Without the original's date the same draft is refused.
    expect(codes(draft({ date: '2027-01-10', lines: eight }), '2027-01-10')).toContain(REFUSED);
  });
  it('leaves 10%, 5%, 0% and exempt lines alone on any date, and says nothing more about a date that is not one', () => {
    for (const rate of ['10%', '5%', '0%', 'KCT']) expect(codes(draft({ date: '2027-03-01', lines: [line({ vatRate: rate })] }), '2027-03-01')).not.toContain(REFUSED);
    expect(codes(draft({ date: 'not a date', lines: eight }))).not.toContain(REFUSED);
  });
});

describe("an individual buyer's identity (#3678)", () => {
  const individual = (identity: DraftInput['buyer']['identity'], kind: DraftInput['buyer']['kind'] = 'individual') =>
    draft({ buyer: { kind, taxCode: null, name: 'Nguyễn Văn A', address: null, email: null, identity } });
  it('checks the shape of each kind', () => {
    expect(isBuyerIdentity('cccd', '012345678901')).toBe(true);
    expect(isBuyerIdentity('cccd', '01234567890')).toBe(false);
    expect(isBuyerIdentity('cccd', '01234567890a')).toBe(false);
    expect(isBuyerIdentity('passport', 'B1234567')).toBe(true);
    expect(isBuyerIdentity('passport', 'b1234567')).toBe(false);
    expect(isBuyerIdentity('passport', 'B12')).toBe(false);
    expect(isBuyerIdentity('budget_code', '1234567')).toBe(true);
    expect(isBuyerIdentity('budget_code', '123456')).toBe(false);
  });
  it('passes with none or one valid identity, and refuses a malformed one or one on another kind of buyer', () => {
    expect(codes(individual(null))).toEqual([]);
    expect(codes(individual({ kind: 'cccd', value: '012345678901' }))).toEqual([]);
    expect(codes(individual({ kind: 'cccd', value: '12345' }))).toContain('buyer.identity:BUYER_IDENTITY_INVALID');
    expect(codes(individual({ kind: 'cccd', value: '012345678901' }, 'business'))).toContain('buyer.identity:BUYER_IDENTITY_INVALID');
  });
  it('asks a passport for the buyer\'s nationality, two capital letters, and allows it with nothing else (#3709)', () => {
    const passport = (nationality: string | null) => individual({ kind: 'passport', value: 'B1234567', nationality });
    expect(codes(passport('US'))).toEqual([]);
    expect(codes(passport(null))).toContain('buyer.nationality:BUYER_NATIONALITY_REQUIRED');
    expect(codes(passport(''))).toContain('buyer.nationality:BUYER_NATIONALITY_REQUIRED');
    expect(codes(passport('usa'))).toContain('buyer.nationality:BUYER_NATIONALITY_INVALID');
    expect(codes(passport('u1'))).toContain('buyer.nationality:BUYER_NATIONALITY_INVALID');
    // A CCCD or a budget code carries none, and a draft that has not been given the field (an older caller) is judged as one without.
    expect(codes(individual({ kind: 'cccd', value: '012345678901', nationality: 'US' }))).toContain('buyer.nationality:BUYER_NATIONALITY_INVALID');
    expect(codes(individual({ kind: 'cccd', value: '012345678901', nationality: null }))).toEqual([]);
    expect(codes(individual({ kind: 'budget_code', value: '1234567' }))).toEqual([]);
  });
  it('masks all but the last three characters', () => {
    expect(maskBuyerIdentity('012345678901')).toBe('•••••••••901');
    expect(maskBuyerIdentity('AB')).toBe('••');
  });
});

describe('a nationality code (#3709)', () => {
  it('is two capital letters', () => {
    expect(isNationalityCode('VN')).toBe(true);
    expect(isNationalityCode('vn')).toBe(false);
    expect(isNationalityCode('VNM')).toBe(false);
    expect(isNationalityCode('V')).toBe(false);
  });
});

describe('the 8% of a correction follows the confirmed basis (#3709)', () => {
  const REFUSED = 'lines.1.vatRate:LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD';
  const eight = [line({ vatRate: '8%' })];
  it('on the original basis a 2027 correction keeps judging 8% on the original date', () => {
    expect(codes(draft({ date: '2027-01-10', rateDate: '2026-11-20', lines: eight }), '2027-01-10')).not.toContain(REFUSED);
  });
  it('on the correction date basis (no rateDate) a 2027 quantity fix left at 8% is refused, and at 10% it passes', () => {
    expect(codes(draft({ date: '2027-01-10', lines: eight }), '2027-01-10')).toContain(REFUSED);
    expect(codes(draft({ date: '2027-01-10', lines: [line({ vatRate: '10%' })] }), '2027-01-10')).not.toContain(REFUSED);
    // Still inside the reduced period the correction date allows 8%.
    expect(codes(draft({ date: '2026-12-15', lines: eight }), '2026-12-15')).not.toContain(REFUSED);
  });
});
