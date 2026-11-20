// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of what an AI coworker asks to do (E4 #3863): the text exactly as sent, as plain text and not as markup, marked as not trusted, who asked, that nothing has happened yet, and the words of the kind
// in both languages.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngageProposalView } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => children }));

const { EngageProposalCard } = await import('../src/components/engage-proposal-card.tsx');

const engage: EngageProposalView = {
  command: 'kernel.conversation.reply_approved',
  about: [
    { label: 'channel', value: 'facebook_page: Tiệm Bánh B' },
    { label: 'contact', value: 'Trần Thị Khách' },
    { label: 'customerMessage', value: 'Giá bao nhiêu vậy shop?' },
  ],
  fields: [
    { key: 'conversationId', value: 'c-1', long: false },
    { key: 'body', value: 'Dạ 100k ạ <script>alert(1)</script>\nCảm ơn bạn', long: true },
    { key: 'unknownKey', value: 'x', long: false },
  ],
};
const render = (locale: 'vi' | 'en', status = 'pending', shown: EngageProposalView = engage, kind = 'kernel.conversation_reply') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <EngageProposalCard engage={shown} kind={kind} status={status} client={{ client: 'Dy', host: 'dy.example.org' }} slug="acme" />
    </IntlProvider>,
  );
const withAbout = (about: EngageProposalView['about']): EngageProposalView => ({ ...engage, about });

// The card shows a time in the reader's own clock: the test reads it as Vietnam does, whatever zone the runner has.
const RUNNER_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Ho_Chi_Minh';
});
afterAll(() => {
  if (RUNNER_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = RUNNER_TZ;
});

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

  it('says what a booking, a quote, a post and a launch are about, in both languages', () => {
    const booking = withAbout([
      { label: 'guest', value: 'Nguyễn Văn Khách' },
      { label: 'guestEmail', value: 'khach@example.test' },
      { label: 'eventType', value: 'Tư vấn thuế' },
      { label: 'bookingTime', value: '2026-12-01T02:00:00Z' },
    ]);
    const quote = withAbout([
      { label: 'quote', value: 'BG-2026-0007' },
      { label: 'quoteStatus', value: 'sent' },
      { label: 'quoteTotal', value: '3300000.0000' },
      { label: 'party', value: 'Công ty Khách' },
      { label: 'partyEmail', value: 'khach@example.test' },
    ]);
    const post = withAbout([
      { label: 'post', value: 'Khuyến mãi tháng 12' },
      { label: 'channels', value: 'Kênh thử, Kênh hai' },
    ]);
    const launch = withAbout([
      { label: 'launch', value: 'Khuyến mãi Tết' },
      { label: 'adAccount', value: 'Tài khoản Tiệm Bánh' },
      { label: 'launchState', value: 'live' },
      { label: 'launchBudget', value: '100000 VND' },
      { label: 'launchEnds', value: '2026-12-10' },
    ]);
    const words = {
      vi: [
        ['Khách đặt lịch', 'Email của khách', 'Loại cuộc hẹn', 'Giờ đang đặt'],
        ['Báo giá', 'Trạng thái báo giá', 'Tổng báo giá', 'Khách hàng', 'Email khách hàng đã lưu', 'Đã gửi'],
        ['Bài đăng', 'Kênh'],
        ['Chiến dịch', 'Tài khoản quảng cáo', 'Trạng thái chiến dịch', 'Ngân sách ngày đang giữ', 'Hiện kết thúc vào', 'Đang chạy'],
      ],
      en: [
        ['Guest', 'Guest email', 'Meeting type', 'Booked time now'],
        ['Quote', 'Quote status', 'Quote total', 'Customer', 'Customer email on file', 'Sent'],
        ['Post', 'Channels'],
        ['Campaign', 'Ad account', 'Campaign state', 'Daily budget held', 'Ends now on', 'Running'],
      ],
    } as const;
    for (const locale of ['vi', 'en'] as const) {
      const shown = [booking, quote, post, launch].map((about, i) => render(locale, 'pending', about, ['crm.booking_move', 'crm.quote_send', 'social.post_submit', 'ads.budget_lower'][i]));
      shown.forEach((html, i) => {
        for (const word of words[locale][i] ?? []) expect(html, `${locale} ${word}`).toContain(word);
        // No message key shows through for a missing translation.
        expect(html, locale).not.toContain('engageAbout');
      });
      // The values, the booking time in the reader's own clock beside the instant, and an unknown state as it is.
      expect(shown[0]).toContain('Nguyễn Văn Khách');
      expect(shown[0]).toContain('2026-12-01T02:00:00Z');
      expect(shown[0]).toMatch(/09:00/);
      expect(shown[1]).toContain('3300000.0000');
      expect(shown[3]).toContain('100000 VND');
    }
    expect(render('en', 'pending', withAbout([{ label: 'launchState', value: 'odd_state' }]))).toContain('odd_state');
  });
});
