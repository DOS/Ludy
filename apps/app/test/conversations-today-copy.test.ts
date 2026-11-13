// SPDX-License-Identifier: AGPL-3.0-only
// The words of the Inbox items of Home (CV3, #2306, shape of #2383): each title key `kernel.conversation.today` returns (packages/kernel/src/conversations.ts)
// has its text in both languages, built from the params that read sends. No title names an AI coworker, and none carries a customer's name or text.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';

// The keys and params of the read, as `title` carries them: a count for the one item that sums the waiting threads, and the channel's provider for each thread.
const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'conversations.unanswered', params: { count: 3 } },
  { key: 'conversations.oneUnanswered', params: { provider: 'facebook_page' } },
  { key: 'conversations.oneUnanswered', params: { provider: 'sandbox' } },
];

// The keys come from the read at run time, so the translator is used with plain text keys.
type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

describe('the Inbox items of Home, in words', () => {
  it('has a text in both languages for every title the read returns', () => {
    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        // A key the catalog lacks comes back as the key itself.
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        expect(text.length, `${lang} ${title.key}`).toBeGreaterThan(10);
      }
    }
  });

  it('counts the waiting conversations and names the channel when it is one the app knows', () => {
    const en = sayIn('en');
    const vi = sayIn('vi');
    expect(en('today.items.conversations.unanswered', { count: 3 })).toBe('3 customer messages are waiting for a reply');
    expect(en('today.items.conversations.unanswered', { count: 1 })).toBe('1 customer message is waiting for a reply');
    expect(vi('today.items.conversations.unanswered', { count: 3 })).toBe('3 tin nhắn của khách đang chờ bạn trả lời');
    expect(en('today.items.conversations.oneUnanswered', { provider: 'facebook_page' })).toBe('A customer on Facebook is waiting for a reply');
    expect(vi('today.items.conversations.oneUnanswered', { provider: 'zalo_oa' })).toBe('Một khách trên Zalo đang chờ bạn trả lời');
    expect(vi('today.items.conversations.oneUnanswered', { provider: 'telegram' })).toBe('Một khách trên Telegram đang chờ bạn trả lời');
    // A channel with no name of its own in the copy reads as a customer.
    expect(en('today.items.conversations.oneUnanswered', { provider: 'sandbox' })).toBe('A customer is waiting for a reply');
    expect(vi('today.items.conversations.oneUnanswered', { provider: 'sandbox' })).toBe('Một khách đang chờ bạn trả lời');
  });
});
