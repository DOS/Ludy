// SPDX-License-Identifier: AGPL-3.0-only
// The Telegram connection's "receive customers' messages" card (#3132) on the Channels page: the four states (off, being turned on, on, being
// turned off), what a failed attempt says in words, and who may press the button, in natural Vietnamese and in English. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { orpc: {}, client: { channels: { setTelegramChats: async () => ({ chatState: 'enabling' }) } }, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { TelegramChats } = await import('../src/components/social-telegram-chats.tsx');

type State = 'off' | 'enabling' | 'on' | 'disabling';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-13T12:00:00Z');
function render(chatState: State, chatError: string | null, canEdit: boolean, locale: 'vi' | 'en' = 'vi', extra: { active?: boolean; changedSecondsAgo?: number } = {}): string {
  const chatChangedAt = new Date(NOW - (extra.changedSecondsAgo ?? 5) * 1000).toISOString();
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={(locale === 'vi' ? viMessages : enMessages) as never} timeZone="Asia/Ho_Chi_Minh">
        <TelegramChats channel={{ id: '00000000-0000-4000-8000-0000000000aa', chatState, chatError, chatChangedAt }} canEdit={canEdit} active={extra.active ?? true} now={NOW} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the Telegram chats card', () => {
  it('offers to turn it on while off, and says who may write and that nothing is sent by itself', () => {
    const html = render('off', null, true);
    expect(text(html)).toContain('Tin nhắn riêng của khách vào Hộp thư');
    expect(text(html)).toContain('Khách chỉ nhắn được sau khi mở bot và bấm Start');
    expect(text(html)).toContain('Ludy không bao giờ tự gửi');
    expect(text(html)).toContain('Bật nhận tin nhắn của khách');
    expect(html).not.toContain('Tắt nhận tin nhắn');
  });

  it('offers to turn it off while on, and says groups and channels are not included', () => {
    const html = render('on', null, true);
    expect(text(html)).toContain('Đang nhận tin nhắn riêng của khách vào Hộp thư');
    expect(text(html)).toContain('Tin trong nhóm và kênh không được đưa vào');
    expect(text(html)).toContain('Tắt nhận tin nhắn');
    expect(html).not.toContain('Bật nhận tin nhắn của khách');
  });

  it('shows no button while the server is switching, and says so', () => {
    for (const [state, words] of [['enabling', 'Đang bật nhận tin nhắn'], ['disabling', 'Đang tắt nhận tin nhắn']] as const) {
      const html = render(state, null, true);
      expect(text(html)).toContain(words);
      expect(html).not.toContain('<button');
    }
  });

  it('words a failed attempt, and shows a code it has no words for as it is', () => {
    expect(text(render('off', 'BOT_IN_USE', true))).toContain('Bot này đang nhận tin nhắn ở một kênh Telegram khác của bạn');
    expect(text(render('off', 'WEBHOOK_NEEDS_HTTPS', true))).toContain('Telegram chỉ gửi tin về địa chỉ https');
    expect(text(render('off', 'TELEGRAM_TOKEN_REFUSED', true))).toContain('hãy kết nối lại kênh');
    expect(text(render('off', 'TELEGRAM_502', true))).toContain('mã lỗi TELEGRAM_502');
    // While a switch is under way no old failure is shown.
    expect(text(render('enabling', 'BOT_IN_USE', true))).not.toContain('Bot này đang nhận tin nhắn ở một kênh');
  });

  it('offers the switch again when it stood too long, and says it may have been interrupted', () => {
    const turningOn = render('enabling', null, true, 'vi', { changedSecondsAgo: 300 });
    expect(text(turningOn)).toContain('có thể đã bị gián đoạn');
    expect(text(turningOn)).toContain('Bật nhận tin nhắn của khách');
    const turningOff = render('disabling', null, true, 'vi', { changedSecondsAgo: 300 });
    expect(text(turningOff)).toContain('có thể đã bị gián đoạn');
    expect(text(turningOff)).toContain('Tắt nhận tin nhắn');
    // Inside the window there is no button and no warning.
    expect(render('disabling', null, true, 'vi', { changedSecondsAgo: 30 })).not.toContain('<button');
    expect(text(render('disabling', null, true, 'vi', { changedSecondsAgo: 30 }))).not.toContain('gián đoạn');
  });

  it('lets a connection that no longer works be turned off but not on, and shows a failed reconnect while on', () => {
    const expiredOn = render('on', null, true, 'vi', { active: false });
    expect(text(expiredOn)).toContain('Tắt nhận tin nhắn');
    expect(render('off', null, true, 'vi', { active: false })).not.toContain('<button');
    // A reconnect that did not take leaves the old webhook on and says why.
    expect(text(render('on', 'TELEGRAM_TOKEN_REFUSED', true))).toContain('hãy kết nối lại kênh');
  });

  it('shows members the state without a button', () => {
    const html = render('on', null, false);
    expect(text(html)).toContain('Đang nhận tin nhắn riêng của khách vào Hộp thư');
    expect(html).not.toContain('<button');
  });

  it('speaks English too', () => {
    const html = render('off', 'WEBHOOK_NEEDS_HTTPS', true, 'en');
    expect(text(html)).toContain("Customers' private messages in the Inbox");
    expect(text(html)).toContain('Telegram only sends to an https address');
    expect(text(html)).toContain("Receive customers' messages");
    expect(text(render('on', null, true, 'en'))).toContain('Stop receiving messages');
  });
});
