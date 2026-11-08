// SPDX-License-Identifier: AGPL-3.0-only
// The mail template of a sent quote (#2694, #2827): its Reply-To is the org's conversation address, so the customer's answer reaches the Inbox as a conversation. It is
// never the document intake address (a reply there would be read as a document); with no conversation address the mail has no Reply-To.
import { describe, expect, it } from 'vitest';
import { quoteMailTemplate } from '../src/quote-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const TOKEN = 'T'.repeat(43);
const payload = { lang: 'vi', org: 'Công ty ABC', number: 'BG-2026-0007', revision: 1, total: '3300000', validUntil: '2026-12-01', quoteId: '0198f3a2-7b1c-7d2e-8f3a-123456789abc' };

const input = (over: Partial<MailTemplateInput> = {}): MailTemplateInput => ({
  messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789abd',
  subject: 'Báo giá BG-2026-0007 của Công ty ABC',
  payload,
  publicUrl: 'https://app.example.test',
  inboundAddress: null,
  brand: 'Ludy',
  execute: (async () => ({ token: TOKEN })) as MailTemplateInput['execute'],
  ...over,
});

describe('the quote mail template', () => {
  it('replies to the conversation address, not the document intake address', async () => {
    const mail = await quoteMailTemplate.render(input({ inboundAddress: 'intake-token@in.example.test', conversationAddress: 'conversation-token@in.example.test' }));
    expect(mail?.replyTo).toBe('conversation-token@in.example.test');
  });

  it('has no Reply-To when the org has no conversation address, even with a document intake address', async () => {
    for (const conversationAddress of [null, undefined]) {
      const mail = await quoteMailTemplate.render(input({ inboundAddress: 'intake-token@in.example.test', ...(conversationAddress === undefined ? {} : { conversationAddress }) }));
      expect(mail).not.toBeNull();
      expect(mail?.replyTo).toBeUndefined();
    }
  });
});
