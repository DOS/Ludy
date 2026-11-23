// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's "sender not confirmed" mark travels in the authenticated conversation reads, not in the public /api/config (#3636): a deployment that cannot check
// senders (INBOUND_AUTHSERV_ID unset, the shipped default) sends no mark at all, and one that can sends what the database holds.
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, ConversationListed, ConversationSummary } from '@ludy/kernel-contract';
import { markableDetail, markableListed, markableSummary } from '../src/conversation-sender-mark.ts';

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({ id: 'c1', kind: 'email', senderUnverified: true, subject: 'Hỏi giá', ...over }) as unknown as ConversationSummary;

describe('the sender mark of a conversation (#3636)', () => {
  it('leaves the field out where senders cannot be checked, so no thread is marked and nothing says why', () => {
    const out = markableSummary(summary(), false);
    expect('senderUnverified' in out).toBe(false);
    expect(out).toMatchObject({ id: 'c1', subject: 'Hỏi giá' });
    expect('senderUnverified' in markableSummary(summary({ senderUnverified: false }), false)).toBe(false);
  });

  it('keeps what the database holds where senders can be checked', () => {
    expect(markableSummary(summary(), true).senderUnverified).toBe(true);
    expect(markableSummary(summary({ senderUnverified: false }), true).senderUnverified).toBe(false);
  });

  it('leaves a thread of another kind, which has no mark, as it is', () => {
    const direct = summary({ kind: 'direct' });
    delete (direct as { senderUnverified?: boolean }).senderUnverified;
    expect(markableSummary(direct, false)).toBe(direct);
  });

  it('applies to every row of a list and to the thread of a detail, and to nothing else in them', () => {
    const listed = { conversations: [summary(), summary({ id: 'c2' })], more: true } as unknown as ConversationListed;
    const off = markableListed(listed, false);
    expect(off.conversations.every((c) => !('senderUnverified' in c))).toBe(true);
    expect(off.more).toBe(true);
    expect(markableListed(listed, true)).toBe(listed);
    const detail = { conversation: summary(), messages: [], notes: [] } as unknown as ConversationDetail;
    expect('senderUnverified' in markableDetail(detail, false).conversation).toBe(false);
    expect(markableDetail(detail, false).messages).toEqual([]);
    expect(markableDetail(detail, true)).toBe(detail);
  });
});
