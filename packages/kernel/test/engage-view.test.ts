// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal reads of the stored payload (E4 #3863): the fields as plain text, bounded, with the characters that reorder or hide text dropped; nothing for a
// proposal that is not an Engage twin's.
import { describe, expect, it } from 'vitest';
import { ENGAGE_PROPOSALS } from '@crove/kernel-contract';
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

  it('drops the characters that make text read in another order or hide, keeps newlines and tabs, bounds a value, and skips odd keys', () => {
    const body = `ok‮gnp.exe⁦x⁩​\u0000\u007F${'a'.repeat(9000)}\tend\n`;
    const view = engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', { body, 'bad key': 'x', '__proto__x': 'y', $set: 'z' });
    const field = view?.fields.find((f) => f.key === 'body');
    expect(field?.value.startsWith('okgnp.exex')).toBe(true);
    expect(field?.value.length).toBe(8000);
    expect(field?.value).not.toMatch(/[‮⁦⁩​\u0000\u007F]/);
    expect(view?.fields.map((f) => f.key)).toEqual(['body']);
  });

  it('is nothing for another kind, or a payload that is not an object', () => {
    expect(engageViewOf('finance.purchase_invoice', 'finance.purchase.record', { body: 'x' })).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', 'text')).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', ['a'])).toBeNull();
    expect(engageViewOf(REPLY?.kind ?? '', REPLY?.command ?? '', null)).toBeNull();
  });
});
