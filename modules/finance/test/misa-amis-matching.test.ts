// SPDX-License-Identifier: AGPL-3.0-only
// The matching of a connection's vouchers against the firm's MISA catalogue (#4112, S3a of #4103): a party only by its tax code, an item only by its exact code, active entries only, one entry matched, none
// unknown, several ambiguous, and nothing in the result that is not the matched entry's code and id.
import { describe, expect, it } from 'vitest';
import { sameBatch } from '../src/misa-amis-match.ts';
import { catalogueItems, catalogueParties, matchItems, matchParties, normalizeTaxCode } from '../src/misa-amis-matching.ts';

const ID1 = '0194a1c2-8f3e-7b10-9d4a-1e2f3a4b5c6d';
const ID2 = '0194A1C2-8F3E-7B10-9D4A-1E2F3A4B5C6E';

describe('tax codes', () => {
  it('compares digits only, 10 or 13 of them, and nothing else', () => {
    expect(normalizeTaxCode('0101234564')).toBe('0101234564');
    expect(normalizeTaxCode(' 0101234564-001 ')).toBe('0101234564001');
    expect(normalizeTaxCode('0101.234.564')).toBe('0101234564');
    for (const bad of ['', '12345', '01012345645', 'abc', null, undefined]) expect(normalizeTaxCode(bad), String(bad)).toBeNull();
  });
});

describe('the catalogue rows', () => {
  it('reads the document\'s party fields and drops a row with no code; an entry that does not say it is inactive is active', () => {
    const parties = catalogueParties([
      { account_object_code: 'KH001', account_object_id: ID2, company_tax_code: '0101234564', inactive: false },
      { account_object_code: 'KH002', company_tax_code: 'không có' },
      { account_object_code: '  ', company_tax_code: '0101234564' },
      { account_object_name: 'Công ty không mã', company_tax_code: '0101234564' },
      { account_object_code: 'KH003', inactive: true, company_tax_code: '0312345678' },
    ]);
    expect(parties).toEqual([
      { code: 'KH001', id: ID2.toLowerCase(), taxCode: '0101234564', active: true },
      { code: 'KH002', id: null, taxCode: null, active: true },
      { code: 'KH003', id: null, taxCode: '0312345678', active: false },
    ]);
  });
  it('reads the item fields: a code, an id that is a UUID, and the inactive flag', () => {
    expect(catalogueItems([{ inventory_item_code: 'DV_CHUNG', inventory_item_id: 'not-a-uuid' }, { inventory_item_code: 'HH1', inventory_item_id: ID1, inactive: true }, { inventory_item_name: 'no code' }])).toEqual([
      { code: 'DV_CHUNG', id: null, active: true },
      { code: 'HH1', id: ID1, active: false },
    ]);
  });
});

describe('parties', () => {
  const catalogue = catalogueParties([
    { account_object_code: 'KH001', account_object_id: ID1, company_tax_code: '0101234564' },
    { account_object_code: 'KH002', account_object_id: ID2, company_tax_code: '0312345678' },
    { account_object_code: 'KH003', company_tax_code: '0312345678' },
    { account_object_code: 'KH004', company_tax_code: '0400000000', inactive: true },
    { account_object_code: 'KH005', company_tax_code: '0500000000', inactive: true },
    { account_object_code: 'KH006', company_tax_code: '0500000000' },
  ]);
  it('matches one active entry with the same tax code, leaves one with none unknown and refuses to pick between two', () => {
    const results = matchParties(['0101234564', '0312345678', '0999999999'], catalogue);
    expect(results).toEqual([
      { kind: 'party', ref: '0101234564', state: 'matched', code: 'KH001', entryId: ID1 },
      { kind: 'party', ref: '0312345678', state: 'ambiguous', code: null, entryId: null },
      { kind: 'party', ref: '0999999999', state: 'unknown', code: null, entryId: null },
    ]);
  });
  it('ignores an inactive entry: all inactive is unknown, one active among inactive ones is matched', () => {
    expect(matchParties(['0400000000'], catalogue)).toEqual([{ kind: 'party', ref: '0400000000', state: 'unknown', code: null, entryId: null }]);
    expect(matchParties(['0500000000'], catalogue)).toEqual([{ kind: 'party', ref: '0500000000', state: 'matched', code: 'KH006', entryId: null }]);
  });
  it('never matches by name: the catalogue\'s names are not even read, and a tax code with no entry is unknown', () => {
    const named = catalogueParties([{ account_object_code: 'KH100', account_object_name: 'Công ty TNHH ABC', company_tax_code: '0888888888' }]);
    expect(matchParties(['0101234564'], named)).toEqual([{ kind: 'party', ref: '0101234564', state: 'unknown', code: null, entryId: null }]);
    expect(JSON.stringify(named)).not.toContain('ABC');
  });
  it('compares a branch\'s 13 digits as they are: a 10 digit entry is not the branch, and the other way round', () => {
    expect(matchParties(['0101234564001'], catalogue)[0]?.state).toBe('unknown');
    const branch = catalogueParties([{ account_object_code: 'CN1', company_tax_code: '0101234564-001' }]);
    expect(matchParties(['0101234564'], branch)[0]?.state).toBe('unknown');
    expect(matchParties(['0101234564001'], branch)[0]).toMatchObject({ state: 'matched', code: 'CN1' });
  });
  it('lists each wanted tax code once, sorted, and nothing else', () => {
    expect(matchParties(['0312345678', '0101234564', '0312345678'], []).map((r) => r.ref)).toEqual(['0101234564', '0312345678']);
  });
});

describe('items', () => {
  const catalogue = catalogueItems([
    { inventory_item_code: 'DV_CHUNG', inventory_item_id: ID1 },
    { inventory_item_code: 'HH1', inactive: true },
    { inventory_item_code: 'HH2' },
    { inventory_item_code: 'HH2' },
  ]);
  it('matches the exact code of one active entry; case and spelling are MISA\'s', () => {
    expect(matchItems(['DV_CHUNG', 'dv_chung', 'HH1', 'HH2', 'KHAC'], catalogue)).toEqual([
      { kind: 'item', ref: 'DV_CHUNG', state: 'matched', code: 'DV_CHUNG', entryId: ID1 },
      { kind: 'item', ref: 'HH1', state: 'unknown', code: null, entryId: null },
      { kind: 'item', ref: 'HH2', state: 'ambiguous', code: null, entryId: null },
      { kind: 'item', ref: 'KHAC', state: 'unknown', code: null, entryId: null },
      { kind: 'item', ref: 'dv_chung', state: 'unknown', code: null, entryId: null },
    ]);
  });
});

describe('sameBatch', () => {
  const stored = { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', serviceItemCode: 'DV_CHUNG' };
  it('is true for the same kind, period and item codes and false for any other batch or an unreadable request', () => {
    expect(sameBatch(stored, { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', serviceItemCode: 'DV_CHUNG' })).toBe(true);
    expect(sameBatch(stored, { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', serviceItemCode: 'DV_KHAC' })).toBe(false);
    expect(sameBatch(stored, { kind: 'purchase_services', from: '2026-09-01', to: '2026-10-31', serviceItemCode: 'DV_CHUNG' })).toBe(false);
    expect(sameBatch(stored, { kind: 'sales', from: '2026-10-01', to: '2026-10-31', salesItemCode: 'BH' })).toBe(false);
    expect(sameBatch({ junk: 1 }, { kind: 'sales' })).toBe(false);
  });
});
