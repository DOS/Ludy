// SPDX-License-Identifier: AGPL-3.0-only
// The board's optimistic move (#2226): where a card sits once it is dropped, before the server answers.
import { describe, expect, it } from 'vitest';
import type { Board, Deal, PipelineStage } from '@crove/kernel-contract';
import { moveCard } from '../src/lib/deal-board.ts';

const stage = (id: string, kind: PipelineStage['kind'], position: number): PipelineStage => ({ id, name: id, kind, position });
const deal = (id: string, stageId: string, stageKind: Deal['stageKind'] = 'open'): Deal => ({
  id,
  partyId: 'p',
  partyName: 'Công ty ABC',
  title: id,
  amount: '1000000.00',
  currency: 'VND',
  stageId,
  stageKind,
  expectedClose: null,
  ownerUserId: null,
  lostReason: null,
  closedAt: null,
  version: 1,
  canDelete: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});
const board = (): Board => ({
  columns: [
    { stage: stage('new', 'open', 1), count: 3, total: '3000000.00', truncated: false, cards: [deal('a', 'new'), deal('b', 'new'), deal('c', 'new')] },
    { stage: stage('quote', 'open', 2), count: 1, total: '1000000.00', truncated: false, cards: [deal('d', 'quote')] },
    { stage: stage('won', 'won', 3), count: 0, total: '0', truncated: false, cards: [] },
  ],
});
const ids = (b: Board, stageId: string) => b.columns.find((c) => c.stage.id === stageId)!.cards.map((c) => c.id);

describe('moveCard', () => {
  it('puts a card before another one of its own column', () => {
    const b = board();
    expect(ids(moveCard(b, b.columns[0]!.cards[2]!, { stageId: 'new', beforeDealId: 'a' }), 'new')).toEqual(['c', 'a', 'b']);
  });

  it('puts a card at the end of its column when no card follows it', () => {
    const b = board();
    expect(ids(moveCard(b, b.columns[0]!.cards[0]!, { stageId: 'new', beforeDealId: null }), 'new')).toEqual(['b', 'c', 'a']);
  });

  it('moves a card to another column, before a card or at the end, and takes it out of the first', () => {
    const b = board();
    const before = moveCard(b, b.columns[0]!.cards[1]!, { stageId: 'quote', beforeDealId: 'd' });
    expect(ids(before, 'new')).toEqual(['a', 'c']);
    expect(ids(before, 'quote')).toEqual(['b', 'd']);
    const end = moveCard(b, b.columns[0]!.cards[1]!, { stageId: 'quote', beforeDealId: null });
    expect(ids(end, 'quote')).toEqual(['d', 'b']);
  });

  it('gives a card the stage and kind of its new column', () => {
    const b = board();
    const moved = moveCard(b, b.columns[0]!.cards[0]!, { stageId: 'won', beforeDealId: null });
    expect(moved.columns[2]!.cards[0]).toMatchObject({ id: 'a', stageId: 'won', stageKind: 'won' });
  });

  it('leaves counts and totals to the server, and the board alone for an unknown stage', () => {
    const b = board();
    const moved = moveCard(b, b.columns[0]!.cards[0]!, { stageId: 'quote', beforeDealId: null });
    expect(moved.columns.map((c) => [c.count, c.total])).toEqual([[3, '3000000.00'], [1, '1000000.00'], [0, '0']]);
    expect(moveCard(b, b.columns[0]!.cards[0]!, { stageId: 'gone', beforeDealId: null })).toBe(b);
  });
});
