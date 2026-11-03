// The org's tax code is normalized by the kernel (normalizeTaxCode in @crove/kernel-contract) and compared by finance
// with an invoice seller's code normalized by @crove/l10n-vn parseTaxCode (issue #313). The two must agree on every
// input, or a sale would be read as a purchase. Codes here fail the MST checksum on purpose (synthetic test data).
import { describe, expect, it } from 'vitest';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { parseTaxCode } from '@crove/l10n-vn';
import { journalMemo } from '../src/memo.ts';
import { isOwnTaxCode, readSeller, type OwnTaxCodes } from '../src/own-tax-code.ts';

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

describe('what an invoice is to the books of one legal entity (#2502)', () => {
  // Synthetic codes that fail the checksum on purpose, as in the rest of this file.
  const HEAD = '0101234564';
  const BRANCH = '0101234564-001';
  const OTHER = '0309876546';
  const STRANGER = '0412345675';
  const own: OwnTaxCodes = {
    tenant: HEAD,
    entities: [
      { id: 'head', taxCode: HEAD },
      { id: 'branch', taxCode: BRANCH },
      { id: 'other', taxCode: OTHER },
      { id: 'bare', taxCode: null },
    ],
  };
  const reading = (seller: string | null, buyer: string | null, entityId: string, codes: OwnTaxCodes = own) => readSeller({ seller, buyer, entityId }, codes);

  it('is a sale of the entity the seller is: its code however written, and its branches', () => {
    for (const code of [HEAD, ' 0101.234.564 ', '0101234564-002', BRANCH]) expect(reading(code, STRANGER, 'head'), code).toBe('sale');
    expect(reading(BRANCH, STRANGER, 'branch')).toBe('sale');
    expect(reading(OTHER, STRANGER, 'other')).toBe('sale');
  });

  it('is a purchase when the seller is a stranger, a missing code or a company that is not the org\'s', () => {
    for (const code of [STRANGER, `${STRANGER}-001`, '', null]) expect(reading(code, HEAD, 'head'), String(code)).toBe('purchase');
  });

  it('is a purchase of this entity when another entity of the org sells to it, and another entity\'s sale otherwise', () => {
    // The head office sells to the other entity: a sale in the head's books, a purchase in the other's.
    expect(reading(HEAD, OTHER, 'other')).toBe('purchase');
    expect(reading(HEAD, `${OTHER}-001`, 'other')).toBe('purchase');
    // The other entity sells to a stranger, read in the head's books: not the head's sale, and no purchase either.
    expect(reading(OTHER, STRANGER, 'head')).toBe('sale_other_entity');
    expect(reading(OTHER, null, 'head')).toBe('sale_other_entity');
    // The head office's invoice read in a branch entity's books.
    expect(reading(HEAD, STRANGER, 'branch')).toBe('sale_other_entity');
  });

  it('keeps the org\'s own code another entity\'s even when no entity row shows it to the writer (a member scoped to one entity)', () => {
    const scoped: OwnTaxCodes = { tenant: HEAD, entities: [{ id: 'other', taxCode: OTHER }] };
    expect(reading(HEAD, STRANGER, 'other', scoped)).toBe('sale_other_entity');
    expect(reading(HEAD, OTHER, 'other', scoped)).toBe('purchase');
    expect(reading(OTHER, STRANGER, 'other', scoped)).toBe('sale');
  });

  it('reads as before for an org with one entity or none: its code is its sale, any other a purchase', () => {
    const single: OwnTaxCodes = { tenant: HEAD, entities: [{ id: 'head', taxCode: HEAD }] };
    expect(reading(HEAD, STRANGER, 'head', single)).toBe('sale');
    expect(reading(BRANCH, STRANGER, 'head', single)).toBe('sale');
    expect(reading(STRANGER, HEAD, 'head', single)).toBe('purchase');
    // An entity row the writer cannot see, or an org with no entity row: the org's code decides.
    expect(reading(HEAD, STRANGER, 'gone', { tenant: HEAD, entities: [] })).toBe('sale');
    expect(reading(STRANGER, HEAD, 'gone', { tenant: HEAD, entities: [] })).toBe('purchase');
    expect(reading(HEAD, STRANGER, 'head', { tenant: null, entities: [{ id: 'head', taxCode: null }] })).toBe('purchase');
  });
});
