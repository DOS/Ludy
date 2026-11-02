// SPDX-License-Identifier: AGPL-3.0-only
// The intent of a conversation in the Inbox (CV3, #2306): what a person applied, what the AI coworker suggests, and the order of the New list by it. A
// suggestion is never the label: it shows beside the thread, and only a person's click turns it into one. No React imports, so it is unit tested.
import type { ConversationIntent } from '@crove/kernel-contract';

// Most urgent first: a complaint, an invoice request, an order or a price, a question; a thread with no intent is after them, and spam is last.
const URGENCY: readonly ConversationIntent[] = ['complaint', 'invoice_request', 'order_or_price', 'question'];
const NONE_RANK = URGENCY.length;
const SPAM_RANK = NONE_RANK + 1;

export interface Intended {
  id: string;
  // What a person applied.
  intent: ConversationIntent | null;
}

// What shows for a thread: the label a person applied, else the suggestion (and which of the two it is), else nothing.
export function shownIntent(item: Intended, suggested: ReadonlyMap<string, ConversationIntent | null>): { intent: ConversationIntent; applied: boolean } | null {
  if (item.intent) return { intent: item.intent, applied: true };
  const suggestion = suggested.get(item.id) ?? null;
  return suggestion ? { intent: suggestion, applied: false } : null;
}

const rank = (intent: ConversationIntent | null): number => (intent === null ? NONE_RANK : intent === 'spam' ? SPAM_RANK : URGENCY.indexOf(intent));

// The page ordered by the intent shown (a person's label before a suggestion for the same thread), most urgent first; threads of one intent keep the order
// they had (the newest first). A read-only sort of what is on screen: nothing is routed, assigned, resolved or hidden by it.
export function sortByIntent<T extends Intended>(items: readonly T[], suggested: ReadonlyMap<string, ConversationIntent | null>): T[] {
  return items
    .map((item, index) => ({ item, index, rank: rank(shownIntent(item, suggested)?.intent ?? null) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}
