// The org's tax code is normalized by the kernel (normalizeTaxCode in @crove/kernel-contract) and compared by finance
// with an invoice seller's code normalized by @crove/l10n-vn parseTaxCode (issue #313). The two must agree on every
// input, or a sale would be read as a purchase. Codes here fail the MST checksum on purpose (synthetic test data).
import { describe, expect, it } from 'vitest';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { parseTaxCode } from '@crove/l10n-vn';
import { journalMemo } from '../src/memo.ts';
import { isOwnTaxCode, ownSeller, type OwnTaxCodes } from '../src/own-tax-code.ts';

describe('the org tax code and the invoice seller tax code', () => {
  it('normalize every input the same way', () => {
    const inputs = [
      '0101234564',
      ' 0101 234 564 ',
      '0101.234.564',
      '0101234564-001',
      '0101234564001',
      '0101234564 - 001',
      '012345678901',
      '01012345',
      '01012345640',
      '0101234564-01',
      'MST0101234564',
      '',
      '   ',
      null,
    ];
    for (const input of inputs) expect(normalizeTaxCode(input), String(input)).toBe(parseTaxCode(input)?.normalized ?? null);
  });
});

describe('the org\'s own tax code (#686)', () => {
  it('is the org\'s code and the codes of its branches, however they are written', () => {
    for (const code of ['0101234564', ' 0101.234.564 ', '0101234564-001', '0101234564001', '0101234564 - 123']) expect(isOwnTaxCode(code, '0101234564'), code).toBe(true);
  });

  it('is not another company, another company\'s branch, or a missing code', () => {
    for (const code of ['0309876546', '0309876546-001', '01012345640', '010123456', '', null]) expect(isOwnTaxCode(code, '0101234564'), String(code)).toBe(false);
    expect(isOwnTaxCode('0101234564', null)).toBe(false);
    expect(isOwnTaxCode('0101234564-001', '')).toBe(false);
  });

  it('gives an org whose own code is a branch only that code, not its head office or the other branches', () => {
    expect(isOwnTaxCode('0101234564-001', '0101234564-001')).toBe(true);
    expect(isOwnTaxCode('0101234564', '0101234564-001')).toBe(false);
    expect(isOwnTaxCode('0101234564-002', '0101234564-001')).toBe(false);
  });

  it('keeps an individual\'s 12-digit code exact', () => {
    expect(isOwnTaxCode('012345678901', '012345678901')).toBe(true);
    expect(isOwnTaxCode('012345678901', '0123456789')).toBe(false);
  });
});

describe('journal memo', () => {
  const ref = (name: string) => ({ name, taxCode: null, address: null, email: null, phone: null });
  it('names the supplier of a purchase and the customer of a sale', () => {
    const invoice = { series: 'C26TAB', number: '12' };
    expect(journalMemo({ seller: ref('NCC A'), buyer: ref('Org'), invoice })).toBe('HĐ C26TAB-12 NCC A');
    expect(journalMemo({ direction: 'sale', seller: ref('Org'), buyer: ref('Khách B'), invoice })).toBe('HĐ bán C26TAB-12 Khách B');
    expect(journalMemo({ direction: 'sale', seller: ref('Org'), buyer: ref(''), invoice: { series: '', number: '7' } })).toBe('HĐ bán 7');
  });
});

describe('the seller of an invoice among the legal entities of the org (#2502)', () => {
  // Synthetic codes that fail the checksum on purpose, as in the rest of this file.
  const own: OwnTaxCodes = {
    tenant: '0101234564',
    entities: [
      { id: 'head', taxCode: '0101234564', isDefault: true },
      { id: 'branch', taxCode: '0101234564-001', isDefault: false },
      { id: 'other', taxCode: '0309876546', isDefault: false },
      { id: 'bare', taxCode: null, isDefault: false },
    ],
  };
  it('is the entity with exactly the seller code, however it is written, and the head office for a branch no entity holds', () => {
    expect(ownSeller('0101234564', own)).toEqual({ own: true, legalEntityId: 'head', isDefault: true });
    expect(ownSeller(' 0101.234.564 ', own)).toEqual({ own: true, legalEntityId: 'head', isDefault: true });
    expect(ownSeller('0101234564-001', own)).toEqual({ own: true, legalEntityId: 'branch', isDefault: false });
    expect(ownSeller('0101234564001', own)).toEqual({ own: true, legalEntityId: 'branch', isDefault: false });
    expect(ownSeller('0309876546', own)).toEqual({ own: true, legalEntityId: 'other', isDefault: false });
    expect(ownSeller('0101234564-002', own)).toEqual({ own: true, legalEntityId: 'head', isDefault: true });
  });
  it('is the org own code with no entity when only the org code matches, and nobody for a stranger, a missing code or an entity with no code', () => {
    expect(ownSeller('0101234564-007', { tenant: '0101234564', entities: [] })).toEqual({ own: true, legalEntityId: null, isDefault: false });
    for (const code of ['0412345675', '0412345675-001', '', null, undefined]) expect(ownSeller(code, own), String(code)).toEqual({ own: false, legalEntityId: null, isDefault: false });
    expect(ownSeller('0101234564', { tenant: null, entities: [{ id: 'bare', taxCode: null, isDefault: true }] }).own).toBe(false);
  });
});
