// SPDX-License-Identifier: AGPL-3.0-only
// The matching of a connection's vouchers against the firm's MISA catalogue (#4112, S3a of #4103): a party only by its tax code, an item only by its exact code, active entries only, one entry matched, none
// unknown, several ambiguous, and nothing in the result that is not the matched entry's code and id. Plus (#4124, S3b) how young a check must be for a confirmation and when a stored match no longer holds.
import { describe, expect, it } from 'vitest';
import { sameBatch } from '../src/misa-amis-match.ts';
import { catalogueItems, catalogueParties, catalogueStocks, catalogueUnits, matchStocks, matchUnits, normalizeUnitName, checkIsFresh, confirmedStillHold, hasNoTaxCode, matchItems, matchNames, matchParties, MISA_AMIS_CHECK_MAX_AGE_MS, normalizeName, normalizeTaxCode, relied, staleMatches } from '../src/misa-amis-matching.ts';

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
      { account_object_code: 'KH001', account_object_id: ID2, company_tax_code: '0101234564', account_object_name: '  Công ty ABC ', inactive: false },
      { account_object_code: 'KH002', company_tax_code: 'không có' },
      { account_object_code: '  ', company_tax_code: '0101234564' },
      { account_object_name: 'Công ty không mã', company_tax_code: '0101234564' },
      { account_object_code: 'KH003', inactive: true, company_tax_code: '0312345678' },
    ]);
    expect(parties).toEqual([
      { code: 'KH001', id: ID2.toLowerCase(), taxCode: '0101234564', name: 'Công ty ABC', active: true },
      { code: 'KH002', id: null, taxCode: null, name: null, active: true },
      { code: 'KH003', id: null, taxCode: '0312345678', name: null, active: false },
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
  it('never matches a tax code by name (the name is read for the name questions only), a tax code with no entry is unknown, and a result of a tax code holds no name', () => {
    const named = catalogueParties([{ account_object_code: 'KH100', account_object_name: 'Công ty TNHH ABC', company_tax_code: '0888888888' }]);
    expect(matchParties(['0101234564'], named)).toEqual([{ kind: 'party', ref: '0101234564', state: 'unknown', code: null, entryId: null }]);
    expect(matchParties(['0888888888'], named)).toEqual([{ kind: 'party', ref: '0888888888', state: 'matched', code: 'KH100', entryId: null }]);
    expect(JSON.stringify(matchParties(['0101234564', '0888888888'], named))).not.toContain('ABC');
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

describe('the age of a check (#4124)', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it('takes a check of the last 15 minutes, to the millisecond, and nothing older, in the future or missing', () => {
    expect(MISA_AMIS_CHECK_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(checkIsFresh(ago(0), now)).toBe(true);
    expect(checkIsFresh(ago(MISA_AMIS_CHECK_MAX_AGE_MS), now)).toBe(true);
    expect(checkIsFresh(ago(MISA_AMIS_CHECK_MAX_AGE_MS + 1), now)).toBe(false);
    expect(checkIsFresh(ago(-1000), now)).toBe(false);
    expect(checkIsFresh(null, now)).toBe(false);
    expect(checkIsFresh('not a time', now)).toBe(false);
  });
});

describe('the matches a send relies on (#4124)', () => {
  const stored = { partyCodes: new Map([['0101234564', 'KH001']]), itemCodes: new Set(['DV_CHUNG']) };
  const wanted = { taxCodes: ['0101234564', '0309999990'], itemCodes: ['DV_CHUNG', 'HANG_MOI'] };
  const party = (state: 'matched' | 'unknown' | 'ambiguous', code: string | null) => ({ kind: 'party' as const, ref: '0101234564', state, code, entryId: null });
  const item = (state: 'matched' | 'unknown' | 'ambiguous') => ({ kind: 'item' as const, ref: 'DV_CHUNG', state, code: state === 'matched' ? 'DV_CHUNG' : null, entryId: null });

  it('relies only on the references of the batch that a check matched', () => {
    expect(relied(stored, wanted)).toEqual({ taxCodes: ['0101234564'], itemCodes: ['DV_CHUNG'], confirmed: [], unitNames: [], stockCodes: [] });
    expect(relied({ partyCodes: null, itemCodes: null }, wanted)).toEqual({ taxCodes: [], itemCodes: [], confirmed: [], unitNames: [], stockCodes: [] });
    expect(relied(stored, { taxCodes: [], itemCodes: [] })).toEqual({ taxCodes: [], itemCodes: [], confirmed: [], unitNames: [], stockCodes: [] });
  });

  it('holds while the catalogue answers the same, and stops holding when an entry is gone, inactive, ambiguous or has another code', () => {
    expect(staleMatches(stored, [party('matched', 'KH001'), item('matched')])).toBe(false);
    expect(staleMatches(stored, [party('unknown', null), item('matched')])).toBe(true);
    expect(staleMatches(stored, [party('ambiguous', null), item('matched')])).toBe(true);
    expect(staleMatches(stored, [party('matched', 'KH999'), item('matched')])).toBe(true);
    expect(staleMatches(stored, [party('matched', 'KH001'), item('unknown')])).toBe(true);
    expect(staleMatches(stored, [party('matched', 'KH001'), item('ambiguous')])).toBe(true);
  });

  it('ignores what the read did not ask for and what was never matched', () => {
    expect(staleMatches(stored, [])).toBe(false);
    expect(staleMatches({ partyCodes: null, itemCodes: null }, [party('unknown', null)])).toBe(false);
    expect(staleMatches(stored, [{ kind: 'party', ref: '0309999990', state: 'unknown', code: null, entryId: null }])).toBe(false);
  });
});

describe('names (#4124)', () => {
  const P1 = '77777777-7777-4777-8777-777777777777';
  const P2 = '88888888-8888-4888-8888-888888888888';
  const party = (code: string, name: string | null, over: Record<string, unknown> = {}) => ({ account_object_code: code, account_object_id: ID1, account_object_name: name, company_tax_code: '0301234565', ...over });

  it('reads a name the way a person reads it the same: composed, lower case, one space; nothing looser, and nothing under three characters', () => {
    expect(normalizeName('  Công   ty\tHoa Sen ')).toBe('công ty hoa sen');
    // A decomposed "ô" and the composed one are the same name; a name without the diacritic is another.
    expect(normalizeName('Co\u0302ng ty')).toBe(normalizeName('Công ty'));
    expect(normalizeName('Cong ty')).not.toBe(normalizeName('Công ty'));
    for (const bad of ['', '  ', 'Ab', null, undefined]) expect(normalizeName(bad), String(bad)).toBeNull();
  });

  it('calls a party one with no tax code only when it has none or a blank one, not when the one it has cannot be used', () => {
    for (const none of [null, undefined, '', '  ', '\t']) expect(hasNoTaxCode(none), String(none)).toBe(true);
    for (const present of ['0101234564', '12345', 'n/a', '010123456', '0101234564-001']) expect(hasNoTaxCode(present), present).toBe(false);
  });

  it('proposes the one active entry of the name with its code, id and name, says ambiguous for several, and says nothing for none, an inactive entry or an entry without a name', () => {
    const catalogue = catalogueParties([party('A', 'Hoa Sen'), party('B', 'Hoa Mai'), party('B2', 'HOA MAI'), party('C', 'Hoa Lan', { inactive: true }), party('D', null), party('E', '   ')]);
    const out = matchNames([{ partyId: P1, name: ' hoa  sen ' }, { partyId: P2, name: 'Hoa Mai' }, { partyId: 'a', name: 'Hoa Lan' }, { partyId: 'b', name: 'Hoa Cúc' }, { partyId: 'c', name: '' }], catalogue);
    // Only the proposal and the ambiguous one are answers; an inactive entry, no entry and a name with nothing in it say nothing.
    expect(out).toEqual([
      { kind: 'party_name', ref: P1, state: 'name_proposal', code: 'A', entryId: ID1.toLowerCase(), candidateName: 'Hoa Sen' },
      { kind: 'party_name', ref: P2, state: 'ambiguous', code: null, entryId: null },
    ]);
  });

  it('asks about each party once and in a fixed order, and cuts an entry name to the stored length', () => {
    const long = 'x'.repeat(250);
    const catalogue = catalogueParties([party('L', long)]);
    const out = matchNames([{ partyId: P2, name: long }, { partyId: P1, name: 'Khác hẳn' }, { partyId: P2, name: long }], catalogue);
    expect(out.map((r) => r.ref)).toEqual([P2]);
    expect(out[0]?.candidateName).toHaveLength(200);
  });

  it('keeps a confirmed name while its code is in the catalogue and active, and drops it when the entry is gone or inactive, whatever the entry is called now', () => {
    const catalogue = catalogueParties([party('KEEP', 'Tên mới'), party('OFF', 'Hoa Sen', { inactive: true })]);
    expect(confirmedStillHold([{ partyId: P2, code: 'OFF' }, { partyId: P1, code: 'KEEP' }, { partyId: 'z', code: 'GONE' }], catalogue)).toEqual([
      { kind: 'party_name', ref: P1, state: 'confirmed', code: 'KEEP', entryId: null },
      { kind: 'party_name', ref: P2, state: 'unknown', code: null, entryId: null },
      { kind: 'party_name', ref: 'z', state: 'unknown', code: null, entryId: null },
    ]);
  });

  it('relies on the confirmed names of the batch, and a stored confirmation stops holding when the catalogue no longer says it', () => {
    const stored = { partyCodes: new Map<string, string>(), itemCodes: new Set<string>(), partyNameCodes: new Map([[P1, 'KEEP']]) };
    expect(relied(stored, { taxCodes: [], itemCodes: [], names: [{ partyId: P1, name: 'x' }, { partyId: P2, name: 'y' }] }).confirmed).toEqual([{ partyId: P1, code: 'KEEP' }]);
    expect(relied(stored, { taxCodes: [], itemCodes: [] }).confirmed).toEqual([]);
    const still = { kind: 'party_name' as const, ref: P1, state: 'confirmed' as const, code: 'KEEP', entryId: null };
    expect(staleMatches(stored, [still])).toBe(false);
    expect(staleMatches(stored, [{ ...still, state: 'unknown', code: null }])).toBe(true);
    expect(staleMatches(stored, [{ ...still, code: 'OTHER' }])).toBe(true);
    expect(staleMatches(stored, [])).toBe(false);
  });
});

describe('units and stocks (MISA ASP, #4125)', () => {
  const unit = (name: string, id: string | null, extra: Record<string, unknown> = {}) => ({ unit_name: name, unit_id: id, ...extra });

  it('reads a unit name the way a person reads it the same, and nothing looser', () => {
    expect(normalizeUnitName('  CÁI ')).toBe('cái');
    expect(normalizeUnitName('Hộp   lớn')).toBe('hộp lớn');
    // Decomposed (NFD) and composed spellings are one name; a name without its marks is another.
    expect(normalizeUnitName('Ca\u0301i')).toBe(normalizeUnitName('Cái'));
    expect(normalizeUnitName('Cai')).not.toBe(normalizeUnitName('Cái'));
    for (const bad of ['', '   ', null, undefined, 'x'.repeat(65)]) expect(normalizeUnitName(bad), String(bad)).toBeNull();
  });

  it('matches a unit by its name to the one active catalogue unit, with its id; none is unknown and two are ambiguous', () => {
    const catalogue = catalogueUnits([unit('Cái', ID1), unit('Hộp', ID2), unit('hộp ', ID1), unit('Kg', ID2, { inactive: true }), { unit_id: ID1 }]);
    expect(matchUnits(['cái', 'CÁI ', 'Hộp', 'Kg', 'Thùng'], catalogue)).toEqual([
      { kind: 'unit', ref: 'cái', state: 'matched', code: 'Cái', entryId: ID1 },
      { kind: 'unit', ref: 'hộp', state: 'ambiguous', code: null, entryId: null },
      { kind: 'unit', ref: 'kg', state: 'unknown', code: null, entryId: null },
      { kind: 'unit', ref: 'thùng', state: 'unknown', code: null, entryId: null },
    ]);
  });

  it('looks up the name a person typed for a unit instead of its own, exactly, and keeps the result under the unit of Ludy', () => {
    const catalogue = catalogueUnits([unit('Cái', ID1), unit('Hộp', ID2), unit('hộp', ID1)]);
    expect(matchUnits(['chiếc', 'Hộp lớn', 'Cái'], catalogue, { chiếc: ' CÁI ', 'hộp lớn': 'Hộp', cái: 'Thùng' })).toEqual([
      { kind: 'unit', ref: 'chiếc', state: 'matched', code: 'Cái', entryId: ID1 },
      { kind: 'unit', ref: 'cái', state: 'unknown', code: null, entryId: null },
      { kind: 'unit', ref: 'hộp lớn', state: 'ambiguous', code: null, entryId: null },
    ]);
    // A name that is not typed for the unit changes nothing, and an inherited property is no alias.
    expect(matchUnits(['cái', 'constructor'], catalogue, {})).toEqual([
      { kind: 'unit', ref: 'constructor', state: 'unknown', code: null, entryId: null },
      { kind: 'unit', ref: 'cái', state: 'matched', code: 'Cái', entryId: ID1 },
    ]);
  });

  it('a typed name that does not fold to a name is no name: the unit stays unmatched, and a unit named like a prototype property is an ordinary unit', () => {
    const catalogue = catalogueUnits([unit('Cái', ID1)]);
    expect(matchUnits(['cái'], catalogue, { cái: 'İ'.repeat(64) })).toEqual([{ kind: 'unit', ref: 'cái', state: 'unknown', code: null, entryId: null }]);
    expect(matchUnits(['constructor', '__proto__'], catalogue, Object.fromEntries([['constructor', 'Cái'], ['__proto__', 'Cái']]))).toEqual([
      { kind: 'unit', ref: '__proto__', state: 'matched', code: 'Cái', entryId: ID1 },
      { kind: 'unit', ref: 'constructor', state: 'matched', code: 'Cái', entryId: ID1 },
    ]);
  });

  it('never matches a unit or a stock that has no usable id', () => {
    expect(matchUnits(['cái'], catalogueUnits([unit('Cái', null)]))).toEqual([{ kind: 'unit', ref: 'cái', state: 'unknown', code: null, entryId: null }]);
    expect(matchStocks(['KHO1'], catalogueStocks([{ stock_code: 'KHO1', stock_id: 'not-a-guid' }]))).toEqual([{ kind: 'stock', ref: 'KHO1', state: 'unknown', code: null, entryId: null }]);
    // Two active stocks of one code are ambiguous even when one of them has no id.
    expect(matchStocks(['KHO1'], catalogueStocks([{ stock_code: 'KHO1', stock_id: ID1 }, { stock_code: 'KHO1' }]))).toEqual([{ kind: 'stock', ref: 'KHO1', state: 'ambiguous', code: null, entryId: null }]);
  });

  it('matches a stock by its exact code among the active ones, with its id', () => {
    const catalogue = catalogueStocks([
      { stock_code: 'KHO1', stock_id: ID1, stock_name: 'Kho chính' },
      { stock_code: 'KHO2', stock_id: ID2, inactive: true },
      { stock_code: 'KHO3', stock_id: ID1 },
      { stock_code: 'KHO3', stock_id: ID2 },
    ]);
    expect(matchStocks(['KHO3', 'KHO1', 'kho1', 'KHO2'], catalogue)).toEqual([
      { kind: 'stock', ref: 'KHO1', state: 'matched', code: 'KHO1', entryId: ID1 },
      { kind: 'stock', ref: 'KHO2', state: 'unknown', code: null, entryId: null },
      { kind: 'stock', ref: 'KHO3', state: 'ambiguous', code: null, entryId: null },
      { kind: 'stock', ref: 'kho1', state: 'unknown', code: null, entryId: null },
    ]);
  });
});

describe('what an ASP send relies on (#4125)', () => {
  const stored = {
    partyCodes: new Map<string, string>(),
    itemCodes: new Set(['HH1']),
    product: 'asp' as const,
    itemIds: new Map([['HH1', ID1]]),
    unitIds: new Map([['cái', { name: 'Cái', id: ID1 }]]),
    stockIds: new Map([['KHO1', ID2]]),
  };
  const { product: _product, ...amisStored } = stored;
  const wanted = { taxCodes: [], itemCodes: ['HH1'], unitNames: ['CÁI ', 'Hộp'], stockCodes: ['KHO1', 'KHO2'] };
  const unit = (state: 'matched' | 'unknown', entryId: string | null) => ({ kind: 'unit' as const, ref: 'cái', state, code: entryId ? 'Cái' : null, entryId });
  const stock = (state: 'matched' | 'unknown', entryId: string | null) => ({ kind: 'stock' as const, ref: 'KHO1', state, code: entryId ? 'KHO1' : null, entryId });

  it('relies on the units and stocks the check matched, for ASP only', () => {
    expect(relied(stored, wanted)).toMatchObject({ unitNames: ['CÁI '], stockCodes: ['KHO1'] });
    expect(relied(amisStored, wanted)).toMatchObject({ unitNames: [], stockCodes: [] });
  });

  it('stops holding when a unit, a stock or an item has gone, been deactivated or has another id', () => {
    const item = (entryId: string | null) => ({ kind: 'item' as const, ref: 'HH1', state: 'matched' as const, code: 'HH1', entryId });
    expect(staleMatches(stored, [unit('matched', ID1), stock('matched', ID2), item(ID1)])).toBe(false);
    expect(staleMatches(stored, [unit('unknown', null)])).toBe(true);
    expect(staleMatches(stored, [unit('matched', ID2)])).toBe(true);
    expect(staleMatches(stored, [stock('unknown', null)])).toBe(true);
    expect(staleMatches(stored, [stock('matched', ID1)])).toBe(true);
    expect(staleMatches(stored, [item(ID2)])).toBe(true);
    // An AMIS check is never judged by ids it did not store for a line.
    expect(staleMatches(amisStored, [unit('unknown', null), stock('unknown', null), item(ID2)])).toBe(false);
  });
});
