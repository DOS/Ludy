// SPDX-License-Identifier: AGPL-3.0-only
// The deal board's pure part (#2226): where a card sits once it is dropped, before the server answers.
import type { Board, Deal } from '@crove/kernel-contract';

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
