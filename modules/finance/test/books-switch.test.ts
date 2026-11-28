// SPDX-License-Identifier: AGPL-3.0-only
// The state of an entity's books switch (issue #1403, slice B1): what is in force, a choice for a year to come, why a switch is not offered, and the first 1 January it can start from.
import { describe, expect, it } from 'vitest';
import { switchState, type SwitchFacts } from '../src/domain/books-switch.ts';

const facts = (over: Partial<SwitchFacts> = {}): SwitchFacts => ({
  today: '2026-11-28',
  fiscalYearEndMonth: 12,
  rows: [],
  lastOrdinaryDate: null,
  openingEntries: [],
  ...over,
});

describe('switchState', () => {
  it('offers 1 January 2026 to an entity with no entries and no row, on TT133', () => {
    expect(switchState(facts())).toEqual({ regime: 'tt133', chartVersion: '2026.1', since: null, scheduled: null, nextSwitchDate: '2026-01-01', blockers: [] });
  });

  it('offers the 1 January after the last entry, and says why earlier years are not offered', () => {
    expect(switchState(facts({ lastOrdinaryDate: '2026-11-20' }))).toMatchObject({
      nextSwitchDate: '2027-01-01',
      blockers: [{ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2026-11-20', nextSwitchDate: '2027-01-01' }],
    });
    // An entry on 1 January itself is on the date the row would start: the year after.
    expect(switchState(facts({ lastOrdinaryDate: '2027-01-01' })).nextSwitchDate).toBe('2028-01-01');
    // An entry before 2026 does not hold back 2026 and offers no blocker.
    expect(switchState(facts({ lastOrdinaryDate: '2025-12-31' }))).toMatchObject({ nextSwitchDate: '2026-01-01', blockers: [] });
  });

  it('names a 31 December opening entry that keeps 1 January from being chosen, reversed or not, and the next free year', () => {
    const opening = { id: '11111111-1111-4111-8111-111111111111', entryDate: '2026-12-31' };
    for (const reversed of [false, true]) {
      const state = switchState(facts({ openingEntries: [{ ...opening, reversed }] }));
      expect(state.nextSwitchDate).toBe('2028-01-01');
      expect(state.blockers).toEqual([
        { code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2027-01-01', nextSwitchDate: '2028-01-01' },
        { code: 'OPENING_ENTRY_BLOCKS', entryId: opening.id, entryDate: '2026-12-31', reversed, nextSwitchDate: '2028-01-01' },
      ]);
    }
  });

  it('does not blame the opening entry when ordinary entries reach the year as well, or when it is not dated 31 December', () => {
    const opening = { id: '11111111-1111-4111-8111-111111111111', entryDate: '2026-12-31', reversed: false };
    expect(switchState(facts({ lastOrdinaryDate: '2027-03-05', openingEntries: [opening] })).blockers.map((b) => b.code)).toEqual(['ENTRIES_ON_OR_AFTER']);
    expect(switchState(facts({ openingEntries: [{ ...opening, entryDate: '2026-06-30' }] })).blockers.map((b) => b.code)).toEqual(['ENTRIES_ON_OR_AFTER']);
  });

  it('offers nothing for an org whose fiscal year does not end in December, or an entity that already has a Circular 99 row', () => {
    expect(switchState(facts({ fiscalYearEndMonth: 6 }))).toMatchObject({ nextSwitchDate: null, blockers: [{ code: 'FISCAL_YEAR_UNSUPPORTED', fiscalYearEndMonth: 6 }] });
    const row = { regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-01-01' };
    expect(switchState(facts({ rows: [row] }))).toMatchObject({ regime: 'tt99', since: '2026-01-01', scheduled: null, nextSwitchDate: null, blockers: [{ code: 'ALREADY_TT99', effectiveFrom: '2026-01-01' }] });
  });

  it('shows a choice for a year to come, and whether it can still be taken back', () => {
    const row = { regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2027-01-01' };
    expect(switchState(facts({ rows: [row], lastOrdinaryDate: '2026-11-20' }))).toMatchObject({
      regime: 'tt133',
      since: null,
      scheduled: { effectiveFrom: '2027-01-01', cancellable: true },
      blockers: [{ code: 'ALREADY_TT99', effectiveFrom: '2027-01-01' }],
    });
    expect(switchState(facts({ today: '2026-12-30', rows: [row], lastOrdinaryDate: '2026-12-31', openingEntries: [] })).scheduled?.cancellable).toBe(true);
    // An opening entry dated 31 December is counted under 1 January: the choice is already used.
    expect(switchState(facts({ rows: [row], openingEntries: [{ id: '11111111-1111-4111-8111-111111111111', entryDate: '2026-12-31', reversed: true }] })).scheduled?.cancellable).toBe(false);
    expect(switchState(facts({ rows: [row], lastOrdinaryDate: '2027-01-02' })).scheduled?.cancellable).toBe(false);
  });
});
