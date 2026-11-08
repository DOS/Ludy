// SPDX-License-Identifier: AGPL-3.0-only
// Where a quote link may be put into a reply (#2827): only in a conversation that is one customer's own (a direct message, an email thread), never in a comment thread,
// whose reply is public: the link is the address of a private document.
import { describe, expect, it } from 'vitest';
import { CONVERSATION_KINDS } from '@crove/kernel-contract';
import { canInsertQuoteLink } from '../src/lib/quote-reply.ts';

describe('canInsertQuoteLink', () => {
  it('offers the link in a direct message and an email thread, never in a comment thread', () => {
    expect(canInsertQuoteLink('direct')).toBe(true);
    expect(canInsertQuoteLink('email')).toBe(true);
    expect(canInsertQuoteLink('comment_thread')).toBe(false);
  });

  it('decides every kind of conversation: exactly these are allowed, so a new kind has to be classified here', () => {
    expect(CONVERSATION_KINDS.filter(canInsertQuoteLink).sort()).toEqual(['direct', 'email']);
  });
});
