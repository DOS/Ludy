// SPDX-License-Identifier: AGPL-3.0-only
// The regime of an entity's books on the Settings card "Chế độ kế toán" (#1403, slice B2): who is offered which action, and which words say why a
// switch to Circular 99 is not offered. The kernel decides every rule again (finance.books.set_regime and cancel_regime); this only shapes the screen.
import type { BooksBlocker, BooksRegimeEntity } from '@ludy/kernel-contract';

// An owner chooses Circular 99, from the date the state offers and while no choice is waiting; an owner or an admin takes a waiting choice back while no entry falls under it yet.
export function booksRegimeActions(role: string | null | undefined, entity: Pick<BooksRegimeEntity, 'nextSwitchDate' | 'scheduled'>): { canChoose: boolean; canTakeBack: boolean } {
  return {
    canChoose: role === 'owner' && entity.nextSwitchDate !== null && entity.scheduled === null,
    canTakeBack: (role === 'owner' || role === 'admin') && entity.scheduled?.cancellable === true,
  };
}

// The message key under `booksRegime.blockers` for each blocker code, and the values its sentence names (dates stay YYYY-MM-DD here; the screen formats them).
export interface BlockerWording {
  key: BooksBlocker['code'];
  date: string | null;
  count: number;
}

export function blockerWording(blocker: BooksBlocker): BlockerWording {
  switch (blocker.code) {
    case 'ALREADY_TT99':
      return { key: blocker.code, date: blocker.effectiveFrom ?? null, count: 0 };
    case 'ENTRIES_ON_OR_AFTER':
      return { key: blocker.code, date: blocker.lastEntryDate ?? null, count: 0 };
    case 'OPENING_ENTRY_BLOCKS':
      return { key: blocker.code, date: blocker.entryDate ?? null, count: 0 };
    case 'PENDING_PROPOSALS':
      return { key: blocker.code, date: null, count: blocker.proposalIds?.length ?? 0 };
    case 'FISCAL_YEAR_UNSUPPORTED':
      return { key: blocker.code, date: null, count: 0 };
  }
}

// The posting proposals that hold a switch, across the blockers of an entity, in the order the state lists them and each once.
export function waitingProposalIds(blockers: readonly BooksBlocker[]): string[] {
  return [...new Set(blockers.flatMap((b) => (b.code === 'PENDING_PROPOSALS' ? (b.proposalIds ?? []) : [])))];
}
