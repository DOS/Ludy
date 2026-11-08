// SPDX-License-Identifier: AGPL-3.0-only
// Where a quote link may be put into a reply (#2827): only in a conversation that is one customer's own (a direct message, an email thread), never in a comment thread,
// whose reply is public: the link is the address of a private document.
import { describe, expect, it } from 'vitest';
import { CONVERSATION_KINDS } from '@crove/kernel-contract';
import { appendQuoteMessage, canInsertQuoteLink } from '../src/lib/quote-reply.ts';

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

describe('appendQuoteMessage (#2827)', () => {
  const message = 'Báo giá BG-2026-0007: https://app.example.test/-/quote#abc';

  it('puts the message in an empty box as it is, and after what is written with a blank line between', () => {
    expect(appendQuoteMessage('', message, 1000)).toEqual({ text: message, fits: true });
    expect(appendQuoteMessage('  \n', message, 1000)).toEqual({ text: message, fits: true });
    expect(appendQuoteMessage('Dạ chào anh  \n', message, 1000)).toEqual({ text: `Dạ chào anh\n\n${message}`, fits: true });
  });

  it('does not add a message that would pass the limit, and keeps the box as it was (cutting it would cut the link)', () => {
    const written = 'a'.repeat(1000 - message.length - 1);
    // One character too many: 2 for the blank line makes the total max + 1.
    expect(appendQuoteMessage(written, message, 1000)).toEqual({ text: written, fits: false });
    expect(appendQuoteMessage('x', message, message.length)).toEqual({ text: 'x', fits: false });
  });

  it('fits exactly at the limit, counted on the trimmed text as the server counts it', () => {
    const written = 'a'.repeat(1000 - message.length - 2);
    const result = appendQuoteMessage(`${written}   `, message, 1000);
    expect(result.fits).toBe(true);
    expect(result.text.length).toBe(1000);
    expect(appendQuoteMessage('', message, message.length).fits).toBe(true);
    expect(appendQuoteMessage('', `${message}  `, message.length).fits).toBe(true);
  });
});
