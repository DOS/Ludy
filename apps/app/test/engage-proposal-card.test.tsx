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
  fields: [
    { key: 'conversationId', value: 'c-1', long: false },
    { key: 'body', value: 'Dạ 100k ạ <script>alert(1)</script>\nCảm ơn bạn', long: true },
    { key: 'unknownKey', value: 'x', long: false },
  ],
};
const render = (locale: 'vi' | 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <EngageProposalCard engage={engage} kind="kernel.conversation_reply" client={{ client: 'Dy', host: 'dy.example.org' }} slug="acme" />
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
});
