// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal reads of the stored payload (E4 #3863): the fields as plain text, bounded, with the characters that reorder or hide text dropped; nothing for a
// proposal that is not an Engage twin's.
import { describe, expect, it } from 'vitest';
import { ENGAGE_PROPOSALS } from '@ludy/kernel-contract';
import { engageViewOf } from '../src/engage-view.ts';

const REPLY = ENGAGE_PROPOSALS.find((p) => p.command === 'kernel.conversation.reply_approved');

describe('engageViewOf', () => {
  it('lists the payload\'s fields in order as text, and marks a long or multi-line one', () => {
    const view = engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { conversationId: 'c1', body: 'Dạ 100k ạ\nCảm ơn bạn', lastSeenSeq: 3, queue: true, times: [{ variantId: 'v', at: '2026-11-20T01:00:00Z' }] });
    expect(view?.command).toBe('kernel.conversation.reply_approved');
    expect(view?.fields.map((f) => [f.key, f.value, f.long])).toEqual([
      ['conversationId', 'c1', false],
      ['body', 'Dạ 100k ạ\nCảm ơn bạn', true],
      ['lastSeenSeq', '3', false],
      ['queue', 'true', false],
      ['times', '[{"variantId":"v","at":"2026-11-20T01:00:00Z"}]', false],
    ]);
  });

  it('writes out the characters that make text read in another order or hide as visible markers (the approval sends them as they are), keeps newlines and tabs, bounds a value, and skips odd keys', () => {
    const body = `ok\u202Egnp.exe\u2066x\u2069\u200B\u0000\u007F${'a'.repeat(9000)}\tend\n`;
    const view = engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { body, 'bad key': 'x', '__proto__x': 'y', $set: 'z' });
    const field = view?.fields.find((f) => f.key === 'body');
    expect(field?.value.startsWith('ok<U+202E>gnp.exe<U+2066>x<U+2069><U+200B><U+0000><U+007F>aaa')).toBe(true);
    expect(field?.value.length).toBe(8000);
    expect([...(field?.value ?? '')].some((ch) => ['\u202E', '\u2066', '\u2069', '\u200B', '\u0000', '\u007F'].includes(ch))).toBe(false);
    expect(view?.fields.map((f) => f.key)).toEqual(['body']);
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { body: 'a\tb\nc' })?.fields[0]?.value).toBe('a\tb\nc');
    // The set the database's title filter refuses: soft hyphen, Arabic letter mark, Mongolian vowel separator, line and paragraph separators, invisible operators, annotation marks, tag characters.
    const odd = 'a\u00ADb\u061Cc\u180Ed\u2028e\u2029f\u206Ag\u206Fh\uFFF9i\uFFFBj\u{E0041}k';
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { body: odd })?.fields[0]?.value).toBe('a<U+00AD>b<U+061C>c<U+180E>d<U+2028>e<U+2029>f<U+206A>g<U+206F>h<U+FFF9>i<U+FFFB>j<U+E0041>k');
    // The Hangul fillers and the braille blank (#4423): a value made of them no longer looks empty on the card.
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { body: 'a\u115Fb\u1160c\u3164d\uFFA0e\u2800f' })?.fields[0]?.value).toBe('a<U+115F>b<U+1160>c<U+3164>d<U+FFA0>e<U+2800>f');
  });

  it('is nothing for another kind, or a payload that is not an object', () => {
    expect(engageViewOf('finance.purchase_invoice', 'finance.purchase.record', { body: 'x' })).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', 'text')).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', ['a'])).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', null)).toBeNull();
  });
});
