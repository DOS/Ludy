// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of what an AI coworker asks to do (E4 #3863): the text exactly as sent, as plain text and not as markup, marked as not trusted, who asked, that nothing has happened yet, and the words of the kind
// in both languages.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => children }));

const { EngageProposalCard } = await import('../src/components/engage-proposal-card.tsx');

const engage = {
  command: 'kernel.conversation.reply_approved',
  about: [
    { label: 'channel' as const, value: 'facebook_page: Tiệm Bánh B' },
    { label: 'contact' as const, value: 'Trần Thị Khách' },
    { label: 'customerMessage' as const, value: 'Giá bao nhiêu vậy shop?' },
  ],
  fields: [
    { key: 'conversationId', value: 'c-1', long: false },
    { key: 'body', value: 'Dạ 100k ạ <script>alert(1)</script>\nCảm ơn bạn', long: true },
    { key: 'unknownKey', value: 'x', long: false },
  ],
};
const render = (locale: 'vi' | 'en', status = 'pending') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <EngageProposalCard engage={engage} kind="kernel.conversation_reply" status={status} client={{ client: 'Dy', host: 'dy.example.org' }} slug="acme" />
    </IntlProvider>,
  );

describe('the card of an AI coworker\'s ask', () => {
  it('shows the text as plain text, never as markup, with who asked and a plain statement that nothing happened yet', () => {
    const html = render('vi');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Gửi câu trả lời này cho khách');
    expect(html).toContain('Nội dung sẽ gửi');
    expect(html).toContain('Do một ứng dụng AI bên ngoài viết');
    expect(html).toContain('Dy');
    expect(html).toContain('dy.example.org');
    expect(html).toContain('Chưa có gì xảy ra');
    // Who and what it is about, read from the thread.
    expect(html).toContain('Trần Thị Khách');
    expect(html).toContain('Khách đã viết');
    expect(html).toContain('Giá bao nhiêu vậy shop?');
    // A key the card has no words for shows as it is.
    expect(html).toContain('unknownKey');
  });

  it('says the same in English', () => {
    const html = render('en');
    expect(html).toContain('Send this reply to the customer');
    expect(html).toContain('Text to send');
    expect(html).toContain('Written by an outside AI app');
    expect(html).toContain('Nothing has happened yet');
  });

  it('says what is true once it is decided: done, rejected or closed, never "nothing has happened yet"', () => {
    expect(render('en', 'executed')).toContain('Approved and done');
    expect(render('en', 'rejected')).toContain('Rejected: nothing was done');
    expect(render('en', 'expired')).toContain('This ask is closed');
    for (const status of ['executed', 'rejected', 'expired']) expect(render('en', status)).not.toContain('Nothing has happened yet');
    expect(render('vi', 'pending')).toContain('Ứng dụng AI bên ngoài: không đáng tin');
  });
});
