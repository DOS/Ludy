// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox screen's search params (CV3, #2306): which tab, which kind of thread, which channel and assignee, the search text and the thread open in the
// middle pane. A param that fails its check is left out, so the screen falls back to its default (plan §9, #1513). No React imports, so it is unit tested.
import { z } from 'zod';
import { CONVERSATION_INTENTS, CONVERSATION_KINDS, type ConversationKind } from '@crove/kernel-contract';
import { readSearch, type Defined } from './search.ts';

const zInboxSearch = z.object({
  status: z.enum(['new', 'pending', 'resolved']).optional().catch(undefined),
  kind: z.enum(CONVERSATION_KINDS).optional().catch(undefined),
  c: z.uuid().optional().catch(undefined),
  channel: z.uuid().optional().catch(undefined),
  assignee: z.enum(['me', 'none']).optional().catch(undefined),
  // The label a person applied, or none (CV3, #2306); and the order of the New list by the suggested intent (a read-only sort of the page).
  intent: z.enum([...CONVERSATION_INTENTS, 'none']).optional().catch(undefined),
  order: z.literal('intent').optional().catch(undefined),
  q: z.string().trim().min(1).max(100).optional().catch(undefined),
});
export type InboxSearch = Defined<z.output<typeof zInboxSearch>>;

export function parseConversationInboxSearch(search: Record<string, unknown>): InboxSearch {
  // The router reads a digits-only value as a number: a search for a phone number is still text.
  const q = typeof search.q === 'number' && Number.isSafeInteger(search.q) ? String(search.q) : search.q;
  return readSearch(zInboxSearch, { ...search, q });
}

// What the list asks the server for: the tab and the filters in force (a tab is New unless the address names another).
export function inboxListInput(search: InboxSearch): {
  status: 'new' | 'pending' | 'resolved';
  kind?: ConversationKind;
  connectionId?: string;
  assignee?: 'me' | 'none';
  intent?: InboxSearch['intent'];
  q?: string;
  limit: number;
} {
  return {
    status: search.status ?? 'new',
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.channel ? { connectionId: search.channel } : {}),
    ...(search.assignee ? { assignee: search.assignee } : {}),
    ...(search.intent ? { intent: search.intent } : {}),
    ...(search.q ? { q: search.q } : {}),
    limit: 50,
  };
}

// The counts of the tabs follow the kind and channel filters (the same threads as the list, whatever its tab).
export function inboxCountsInput(search: InboxSearch): { kind?: ConversationKind; connectionId?: string } {
  return { ...(search.kind ? { kind: search.kind } : {}), ...(search.channel ? { connectionId: search.channel } : {}) };
}
