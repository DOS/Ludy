// SPDX-License-Identifier: AGPL-3.0-only
// The intent of a conversation in the Inbox (CV3, #2306): what shows for a thread (a person's label before a suggestion, never the suggestion as a label)
// and the order of the New list by it, a read-only sort of the page: most urgent first, threads of one intent keeping their order, no intent after them,
// spam last.
import { describe, expect, it } from 'vitest';
import type { ConversationIntent } from '@crove/kernel-contract';
import { shownIntent, sortByIntent } from '../src/lib/conversation-intent.ts';

const item = (id: string, intent: ConversationIntent | null = null) => ({ id, intent });
const suggestions = (entries: Array<[string, ConversationIntent | null]>) => new Map(entries);

describe('shownIntent', () => {
  it('shows a person\'s label as applied, and ignores a suggestion for the same thread', () => {
    expect(shownIntent(item('a', 'spam'), suggestions([['a', 'complaint']]))).toEqual({ intent: 'spam', applied: true });
  });

  it('shows a suggestion as a suggestion, and nothing when there is none', () => {
    expect(shownIntent(item('a'), suggestions([['a', 'question']]))).toEqual({ intent: 'question', applied: false });
    expect(shownIntent(item('a'), suggestions([['a', null]]))).toBeNull();
    expect(shownIntent(item('a'), suggestions([]))).toBeNull();
  });
});

describe('sortByIntent', () => {
  it('puts complaints, invoice requests, orders and questions first in that order, then threads with no intent, then spam, each group in its own order', () => {
    const items = [item('1'), item('2', 'spam'), item('3'), item('4'), item('5'), item('6', 'question'), item('7'), item('8')];
    const suggested = suggestions([
      ['1', 'question'],
      ['3', 'complaint'],
      ['4', 'spam'],
      ['5', 'order_or_price'],
      ['7', 'invoice_request'],
      ['8', 'complaint'],
    ]);
    expect(sortByIntent(items, suggested).map((i) => i.id)).toEqual(['3', '8', '7', '5', '1', '6', '2', '4']);
  });

  it('keeps the order it was given when nothing is suggested or applied, and does not change the page it was given', () => {
    const items = [item('b'), item('a'), item('c')];
    expect(sortByIntent(items, suggestions([])).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    const before = items.map((i) => i.id);
    sortByIntent(items, suggestions([['c', 'complaint']]));
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('puts a person\'s label before a suggestion for the same thread', () => {
    // "a" is suggested as a complaint but a person said spam: it goes last, behind "b" with no intent.
    expect(sortByIntent([item('a', 'spam'), item('b')], suggestions([['a', 'complaint']])).map((i) => i.id)).toEqual(['b', 'a']);
  });
});
