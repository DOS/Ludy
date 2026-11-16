// SPDX-License-Identifier: AGPL-3.0-only
// The deal board's pure part (#2226): where a card sits once it is dropped, before the server answers.
import type { Board, Deal } from '@crove/kernel-contract';
import { EMPTY_DEAL_FILTER, type DealFilterState } from './deal-filter.ts';

export interface Drop {
  stageId: string;
  // The card the dragged one lands before; null at the end of the column.
  beforeDealId: string | null;
}

// The board as it will be once `deal` sits where `drop` says: the card leaves its column and enters the other at its
// place. Counts and totals are the server's, so they are left as they are until the answer refreshes them.
export function moveCard(board: Board, deal: Deal, drop: Drop): Board {
  const target = board.columns.find((c) => c.stage.id === drop.stageId);
  if (!target) return board;
  const moved: Deal = { ...deal, stageId: target.stage.id, stageKind: target.stage.kind };
  return {
    columns: board.columns.map((c) => {
      const cards = c.cards.filter((x) => x.id !== deal.id);
      if (c.stage.id !== target.stage.id) return { ...c, cards };
      const at = drop.beforeDealId ? cards.findIndex((x) => x.id === drop.beforeDealId) : -1;
      cards.splice(at < 0 ? cards.length : at, 0, moved);
      return { ...c, cards };
    }),
  };
}

// What "Xem tất cả" in a closed column shows (docs/plan/crm.md section 6, "Won and Lost show the last 30 days, with a link
// to the list for all"): the list of the deals of that status of every date. The rest of the bar is cleared, so no other
// condition (a stage, an owner, a search) leaves a closed deal out of "all".
export function showAllClosed(kind: 'won' | 'lost'): DealFilterState {
  return { ...EMPTY_DEAL_FILTER, rest: [], status: kind };
}
