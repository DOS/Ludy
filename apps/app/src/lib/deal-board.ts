// SPDX-License-Identifier: AGPL-3.0-only
// The deal board's pure part (#2226): where a card sits once it is dropped, before the server answers.
import { vietnamToday, type Board, type Deal } from '@ludy/kernel-contract';
import { EMPTY_DEAL_FILTER, type DealFilterState } from './deal-filter.ts';

// The three ways to look at the deals. `?tab=` of the screen keeps the one in use through a reload (#3647), and the Home list links to `?tab=next`.
// It is read and written on the address directly: `tab` is a param of other screens too, with other values, which the router's typed search cannot hold at once.
export const DEAL_VIEWS = ['board', 'list', 'next'] as const;
export type DealView = (typeof DEAL_VIEWS)[number];
export const isDealView = (value: unknown): value is DealView => DEAL_VIEWS.some((v) => v === value);

// The view the address names, if it names one.
export function readDealView(search: string): DealView | undefined {
  const value = new URLSearchParams(search).get('tab');
  return isDealView(value) ? value : undefined;
}

// The address with the view set, everything else of it kept.
export function withDealView(search: string, view: DealView): string {
  const params = new URLSearchParams(search);
  params.set('tab', view);
  return `?${params.toString()}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deep link params (`?deal=` and optional `?quote=`) passed from contact attention cards (#4993).
export function readDealTarget(search: string): { dealId: string; quoteId: string | null } | null {
  const params = new URLSearchParams(search);
  const deal = params.get('deal');
  if (!deal || !UUID_PATTERN.test(deal)) return null;
  const quote = params.get('quote');
  return { dealId: deal.toLowerCase(), quoteId: quote && UUID_PATTERN.test(quote) ? quote.toLowerCase() : null };
}

// An open deal past its expected close, by the calendar day in Vietnam (#3649): between 00:00 and 07:00 there the UTC date is still yesterday's, and a flag a day late is a deal nobody chased.
export const isDealOverdue = (deal: Pick<Deal, 'stageKind' | 'expectedClose'>, today: string = vietnamToday()): boolean => deal.stageKind === 'open' && deal.expectedClose !== null && deal.expectedClose < today;

// No deal on the board and no filter in use: five empty columns, which the screen replaces with the one action (#3647). A deal closed more than 30 days ago is not on the board.
export const isEmptyBoard = (board: Board | undefined): boolean => board !== undefined && board.columns.length > 0 && board.columns.every((c) => c.count === 0 && c.cards.length === 0);

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
