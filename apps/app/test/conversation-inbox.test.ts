// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox screen's address (CV3, #2306): which params it reads, what it drops, and what the list and the counts ask the server for.
import { describe, expect, it } from 'vitest';
import type { ConversationListed, ConversationSummary } from '@crove/kernel-contract';
import { channelsOfPosts, INBOX_PAGE_SIZE, inboxCountsInput, inboxListInput, mergeConversationPages, nextConversationCursor, parseConversationInboxSearch } from '../src/lib/conversation-inbox.ts';
import { notificationTarget } from '../src/lib/notifications.ts';

const ID = '0192c6a0-7b3e-7c1d-8a4f-2b9d3c5e6f70';

describe('the Inbox address', () => {
  it('reads the tab, the filters, the search and the open thread', () => {
    expect(parseConversationInboxSearch({ status: 'pending', kind: 'direct', c: ID, channel: ID, assignee: 'me', q: '  gia ao  ' })).toEqual({
      status: 'pending',
      kind: 'direct',
      c: ID,
      channel: ID,
      assignee: 'me',
      q: 'gia ao',
    });
  });

  it('drops what fails its check, so the screen falls back to its default instead of an error page', () => {
    expect(parseConversationInboxSearch({ status: 'closed', kind: 'dm', c: 'not-an-id', channel: 7, assignee: 'all', q: '   ', extra: 'x' })).toEqual({});
    expect(parseConversationInboxSearch({})).toEqual({});
  });

  it('reads the intent filter and the order by intent, and drops a value that is neither', () => {
    expect(parseConversationInboxSearch({ intent: 'complaint', order: 'intent' })).toEqual({ intent: 'complaint', order: 'intent' });
    expect(parseConversationInboxSearch({ intent: 'none' })).toEqual({ intent: 'none' });
    expect(parseConversationInboxSearch({ intent: 'greeting', order: 'date' })).toEqual({});
  });

  it('reads a phone number typed in the address as text', () => {
    expect(parseConversationInboxSearch({ q: 912345678 })).toEqual({ q: '912345678' });
  });

  it('asks for the New tab unless another is named, with the filters in force and a page of 50', () => {
    expect(inboxListInput({})).toEqual({ status: 'new', limit: 50 });
    expect(inboxListInput({ status: 'resolved', kind: 'comment_thread', channel: ID, assignee: 'none', intent: 'spam', q: 'hoa' })).toEqual({
      status: 'resolved',
      kind: 'comment_thread',
      connectionId: ID,
      assignee: 'none',
      intent: 'spam',
      q: 'hoa',
      limit: 50,
    });
    // The order by intent is the screen's own sort of the page: the server is not asked for it.
    expect(inboxListInput({ order: 'intent' })).toEqual({ status: 'new', limit: 50 });
  });

  it('counts the tabs under the kind and channel filters only', () => {
    expect(inboxCountsInput({ status: 'pending', assignee: 'me', q: 'hoa' })).toEqual({});
    expect(inboxCountsInput({ kind: 'direct', channel: ID })).toEqual({ kind: 'direct', connectionId: ID });
  });
});

describe('the notification of a new conversation', () => {
  it('opens the thread it names, else the Inbox', () => {
    expect(notificationTarget({ kind: 'kernel.conversation_new', subjectId: ID, detail: {} })).toEqual({ to: 'conversation', id: ID });
    expect(notificationTarget({ kind: 'kernel.conversation_new', subjectId: null, detail: {} })).toEqual({ to: 'conversations' });
  });
});

// A thread of the list, with only what paging reads.
const thread = (id: string, lastMessageAt: string | null): ConversationSummary => ({ id, lastMessageAt }) as ConversationSummary;

describe('paging the list past the first 50 (#2339)', () => {
  it('asks for a page of 50, and the next page starts after the last thread of this one', () => {
    expect(INBOX_PAGE_SIZE).toBe(50);
    const page: ConversationListed = { conversations: [thread('a', '2026-11-08T03:00:00Z'), thread('b', '2026-11-08T02:00:00Z')], more: true };
    expect(nextConversationCursor(page)).toEqual({ at: '2026-11-08T02:00:00Z', id: 'b' });
    // A thread with no message yet sorts last; its cursor says so (`at` null).
    expect(nextConversationCursor({ conversations: [thread('c', null)], more: true })).toEqual({ at: null, id: 'c' });
  });

  it('has no next page when the server says there is no more, or the page is empty', () => {
    expect(nextConversationCursor({ conversations: [thread('a', '2026-11-08T03:00:00Z')], more: false })).toBeUndefined();
    expect(nextConversationCursor({ conversations: [], more: true })).toBeUndefined();
  });

  it('shows a thread once when it moved up between two reads and sits on two pages', () => {
    const first: ConversationListed = { conversations: [thread('a', '2026-11-08T04:00:00Z'), thread('b', '2026-11-08T03:00:00Z')], more: true };
    const second: ConversationListed = { conversations: [thread('b', '2026-11-08T03:00:00Z'), thread('c', '2026-11-08T02:00:00Z')], more: false };
    expect(mergeConversationPages([first, second]).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(mergeConversationPages([])).toEqual([]);
  });

  it('offers the channels of the posts, each once, in order', () => {
    expect(channelsOfPosts([{ connectionId: ID }, { connectionId: 'x' }, { connectionId: ID }])).toEqual([ID, 'x']);
    expect(channelsOfPosts([])).toEqual([]);
  });
});
