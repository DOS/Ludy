// SPDX-License-Identifier: AGPL-3.0-only
// The helpers of the Settings card "Chế độ kế toán" (#1403, slice B2): who is offered which action, the words of each blocker, and the proposals that hold a switch.
import { describe, expect, it } from 'vitest';
import { BOOKS_SWITCH_BLOCKERS, type BooksBlocker } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { blockerWording, booksRegimeActions, statusKey, waitingProposalIds } from '../src/lib/books-regime.ts';

const offered = { nextSwitchDate: '2027-01-01', scheduled: null, blockers: [] as BooksBlocker[] };
const waiting = { nextSwitchDate: null, scheduled: { effectiveFrom: '2027-01-01', cancellable: true }, blockers: [] as BooksBlocker[] };

describe('booksRegimeActions', () => {
  it('offers the choice to an owner alone, while a date is offered and no choice waits', () => {
    expect(booksRegimeActions('owner', offered)).toEqual({ canChoose: true, canTakeBack: false });
    for (const role of ['admin', 'member', 'viewer', null, undefined]) expect(booksRegimeActions(role, offered).canChoose, String(role)).toBe(false);
    expect(booksRegimeActions('owner', { ...offered, nextSwitchDate: null }).canChoose).toBe(false);
    expect(booksRegimeActions('owner', { ...offered, nextSwitchDate: '2028-01-01', scheduled: waiting.scheduled }).canChoose).toBe(false);
  });

  // The kernel refuses a choice while a posting proposal waits (BOOKS_PENDING_PROPOSALS), after the second factor: the screen does not offer what it would refuse.
  it('does not offer the choice while a posting proposal holds the switch, and still offers it past the other blockers that come with a date', () => {
    const held = { ...offered, blockers: [{ code: 'PENDING_PROPOSALS', proposalIds: ['00000000-0000-7000-8000-00000000000a'], nextSwitchDate: '2027-01-01' }] satisfies BooksBlocker[] };
    expect(booksRegimeActions('owner', held)).toEqual({ canChoose: false, canTakeBack: false });
    const later = { ...offered, nextSwitchDate: '2028-01-01', blockers: [{ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2027-03-01' }] satisfies BooksBlocker[] };
    expect(booksRegimeActions('owner', later).canChoose).toBe(true);
  });

  it('offers taking a choice back to an owner or an admin, while no entry falls under it', () => {
    expect(booksRegimeActions('owner', waiting)).toEqual({ canChoose: false, canTakeBack: true });
    expect(booksRegimeActions('admin', waiting)).toEqual({ canChoose: false, canTakeBack: true });
    for (const role of ['member', 'viewer', null, undefined]) expect(booksRegimeActions(role, waiting).canTakeBack, String(role)).toBe(false);
    expect(booksRegimeActions('owner', { ...waiting, scheduled: { effectiveFrom: '2027-01-01', cancellable: false } }).canTakeBack).toBe(false);
    expect(booksRegimeActions('owner', offered).canTakeBack).toBe(false);
  });
});

describe('blockerWording', () => {
  it('names the date each blocker is about, and how many proposals wait', () => {
    expect(blockerWording({ code: 'FISCAL_YEAR_UNSUPPORTED', fiscalYearEndMonth: 3 })).toEqual({ key: 'FISCAL_YEAR_UNSUPPORTED', date: null, count: 0 });
    expect(blockerWording({ code: 'ALREADY_TT99', effectiveFrom: '2027-01-01' })).toEqual({ key: 'ALREADY_TT99', date: '2027-01-01', count: 0 });
    expect(blockerWording({ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2026-11-20' })).toEqual({ key: 'ENTRIES_ON_OR_AFTER', date: '2026-11-20', count: 0 });
    expect(blockerWording({ code: 'OPENING_ENTRY_BLOCKS', entryDate: '2026-12-31', entryId: '00000000-0000-7000-8000-000000000001', reversed: true })).toEqual({
      key: 'OPENING_ENTRY_BLOCKS',
      date: '2026-12-31',
      count: 0,
    });
    expect(blockerWording({ code: 'PENDING_PROPOSALS', proposalIds: ['00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003'] })).toEqual({
      key: 'PENDING_PROPOSALS',
      date: null,
      count: 2,
    });
    expect(blockerWording({ code: 'PENDING_PROPOSALS' }).count).toBe(0);
  });

  // A new blocker code of the kernel fails here until the screen says it in both languages.
  it('has a sentence in Vietnamese and in English for every blocker code the kernel names, and for nothing else', () => {
    for (const [locale, catalog] of [['vi', vi], ['en', en]] as const) {
      expect(Object.keys(catalog.booksRegime.blockers).toSorted(), locale).toEqual([...BOOKS_SWITCH_BLOCKERS].toSorted());
      for (const sentence of Object.values(catalog.booksRegime.blockers)) expect(sentence.trim(), locale).not.toBe('');
    }
  });
});

describe('statusKey', () => {
  it('picks the line of the closed card: Circular 99 in force, a choice waiting, or Circular 133', () => {
    expect(statusKey({ regime: 'tt99', scheduled: null })).toBe('status99');
    expect(statusKey({ regime: 'tt133', scheduled: { effectiveFrom: '2027-01-01', cancellable: true } })).toBe('statusScheduled');
    expect(statusKey({ regime: 'tt133', scheduled: null })).toBe('status133');
  });

  it('has a line in Vietnamese and in English for each of them', () => {
    for (const [locale, catalog] of [['vi', vi], ['en', en]] as const) {
      for (const key of ['status133', 'status99', 'statusScheduled', 'statusMany'] as const) expect(catalog.booksRegime[key].trim(), `${locale} ${key}`).not.toBe('');
    }
  });
});

describe('waitingProposalIds', () => {
  it('lists the proposals of the PENDING_PROPOSALS blocker, each once, and nothing from the other blockers', () => {
    const a = '00000000-0000-7000-8000-00000000000a';
    const b = '00000000-0000-7000-8000-00000000000b';
    const blockers: BooksBlocker[] = [{ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2026-11-20' }, { code: 'PENDING_PROPOSALS', proposalIds: [a, b, a] }, { code: 'PENDING_PROPOSALS', proposalIds: [b] }];
    expect(waitingProposalIds(blockers)).toEqual([a, b]);
    expect(waitingProposalIds([])).toEqual([]);
    expect(waitingProposalIds([{ code: 'PENDING_PROPOSALS' }])).toEqual([]);
  });
});
