// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to Slack or Teams (Meetings B4, #3168): an owner or admin sees the channels card (nobody else does), the address is asked for and never shown, and the recorder's dialog shows the
// exact message, says everyone in the channel will read it, and sends only on the click: the button waits for a channel, a repeat waits for the tick. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { buildChatMessage, type ChatPreview, type ChatPreviewChannel } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const { ChatForm, MeetingChatPost, MinutesChannelsCard, PostOutcome } = await import('../src/components/meeting-chat.tsx');

const MEETING = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const channel = (over: Partial<ChatPreviewChannel> = {}): ChatPreviewChannel => ({ id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f0001', kind: 'slack', label: 'Kênh #hop-giao-ban', host: 'hooks.slack.com', last: 'none', lastAt: null, needsTick: false, ...over });
const preview = (over: Partial<ChatPreview> = {}): ChatPreview => ({
  meetingId: MEETING,
  factsKey: 'a'.repeat(64),
  message: buildChatMessage({
    lang: 'vi',
    title: 'Họp giao ban tuần',
    day: '2026-11-13',
    facts: { summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá cho khách', who: 'An', when: 'thứ sáu' }] },
  }),
  tooLong: false,
  link: `https://app.test/o/acme/meetings/${MEETING}`,
  channels: [channel()],
  postsLeft: 6,
  ...over,
});
const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'en') => (
  <QueryClientProvider client={client.current}>
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);
const form = (p: ChatPreview, locale: 'en' | 'vi' = 'en') => renderToStaticMarkup(wrap(<ChatForm preview={p} onDone={() => {}} />, locale));
const sendDisabled = (html: string) => /<button[^>]*\sdisabled=""[^>]*data-testid="chat-send"/.test(html) || /<button[^>]*data-testid="chat-send"[^>]*\sdisabled=""/.test(html);

describe('ChatForm', () => {
  it('shows the exact message, the link back, the warning that everyone in the channel will read it, and the posts left', () => {
    const html = form(preview());
    expect(html).toContain('Họp giao ban tuần');
    expect(html).toContain('13/11/2026');
    expect(html).toContain('Chốt báo giá tuần này.');
    expect(html).toContain('• Giữ giá cũ');
    expect(html).toContain('• Gửi báo giá cho khách (An, thứ sáu)');
    expect(html).toContain(`https://app.test/o/acme/meetings/${MEETING}`);
    expect(html).toContain(en.meetings.chat.warning);
    expect(html).toContain(en.meetings.chat.linkNote);
    expect(html).toContain('6 posts left');
    expect(html).toContain('Kênh #hop-giao-ban');
    expect(html).toContain('hooks.slack.com');
  });

  it('says the same in Vietnamese', () => {
    const html = form(preview(), 'vi');
    expect(html).toContain(viMessages.meetings.chat.warning);
    expect(html).toContain('Tóm tắt');
    expect(html).toContain(viMessages.meetings.chat.messageTitle);
  });

  it('sends nothing until a channel is picked: with two channels none is chosen and the button waits', () => {
    const two = preview({ channels: [channel(), channel({ id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f0002', kind: 'teams', label: 'Nhóm Kinh doanh', host: 'prod-12.southeastasia.logic.azure.com' })] });
    const html = form(two);
    expect(sendDisabled(html)).toBe(true);
    expect(html).toContain('Microsoft Teams');
    expect(sendDisabled(form(preview()))).toBe(false);
  });

  it('says there are no channels, and waits', () => {
    const html = form(preview({ channels: [] }));
    expect(html).toContain(en.meetings.chat.noChannels);
    expect(sendDisabled(html)).toBe(true);
  });

  it('waits for the tick before posting again to a channel that got the minutes, or may have, and not after a failure', () => {
    const sent = form(preview({ channels: [channel({ last: 'sent', lastAt: '2026-11-13T03:00:00.000Z', needsTick: true })] }));
    expect(sent).toContain(en.meetings.chat.last.sent);
    expect(sent).toContain('data-testid="chat-repeat"');
    expect(sendDisabled(sent)).toBe(true);
    const ambiguous = form(preview({ channels: [channel({ last: 'ambiguous', needsTick: true })] }));
    expect(ambiguous).toContain(en.meetings.chat.last.ambiguous);
    expect(ambiguous).toContain('data-testid="chat-repeat"');
    const failed = form(preview({ channels: [channel({ last: 'failed' })] }));
    expect(failed).toContain(en.meetings.chat.last.failed);
    expect(failed).not.toContain('data-testid="chat-repeat"');
    expect(sendDisabled(failed)).toBe(false);
    // An older post that went still needs the tick when the newest one failed (the server counts every earlier post).
    const afterFailed = form(preview({ channels: [channel({ last: 'failed', needsTick: true })] }));
    expect(afterFailed).toContain('data-testid="chat-repeat"');
    expect(sendDisabled(afterFailed)).toBe(true);
    expect(sendDisabled(form(preview({ channels: [channel({ last: 'busy' })] })))).toBe(true);
  });

  it('refuses a message too long to post, and a meeting that used all its posts', () => {
    const long = form(preview({ tooLong: true }));
    expect(long).toContain(en.meetings.chat.tooLong);
    expect(sendDisabled(long)).toBe(true);
    const spent = form(preview({ postsLeft: 0 }));
    expect(spent).toContain(en.meetings.chat.limitReached);
    expect(sendDisabled(spent)).toBe(true);
  });
});

describe('MeetingChatPost', () => {
  it('is one button; nothing is read or sent until it is pressed', () => {
    client.current.clear();
    const html = renderToStaticMarkup(wrap(<MeetingChatPost meetingId={MEETING} />));
    expect(html).toContain(en.meetings.chat.open);
    expect(html).not.toContain('data-testid="chat-form"');
  });
});

describe('PostOutcome', () => {
  const channel = { id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f0001', label: 'Kênh #hop-giao-ban', kind: 'slack' as const };
  const html = (data: unknown) => {
    client.current.clear();
    client.current.setQueryData(['meetings', 'chat', 'status'], data);
    return renderToStaticMarkup(wrap(<PostOutcome meetingId={MEETING} channel={channel} />));
  };

  it('says a queued post is waiting, then how it ended, with the code in words', () => {
    expect(html({ state: 'queued', code: null, httpStatus: null, at: 'x' })).toContain('Queued to post to &quot;Kênh #hop-giao-ban&quot;');
    expect(html({ state: 'sent', code: null, httpStatus: 200, at: 'x' })).toContain('Posted to &quot;Kênh #hop-giao-ban&quot;');
    const teams = renderToStaticMarkup(wrap(<PostOutcome meetingId={MEETING} channel={{ ...channel, kind: 'teams' }} />));
    expect(teams).toContain('Teams accepted the post to');
    const failed = html({ state: 'failed', code: 'CHANNEL_GONE', httpStatus: 404, at: 'x' });
    expect(failed).toContain('nothing reached the channel');
    expect(failed).toContain(en.meetings.chat.result.code.CHANNEL_GONE);
    const ambiguous = html({ state: 'ambiguous', code: 'CHANNEL_TIMEOUT', httpStatus: null, at: 'x' });
    expect(ambiguous).toContain('Not sure whether the minutes reached');
    expect(ambiguous).toContain(en.meetings.chat.result.code.CHANNEL_TIMEOUT);
    expect(html({ state: 'dropped', code: 'CHANNEL_NOT_STANDING', httpStatus: null, at: 'x' })).toContain(en.meetings.chat.result.code.CHANNEL_NOT_STANDING);
    // A code this screen does not know is shown by itself, never the service's words.
    expect(html({ state: 'failed', code: 'SOMETHING_NEW', httpStatus: null, at: 'x' })).toContain('SOMETHING_NEW');
    expect(html({ state: 'none', code: null, httpStatus: null, at: null })).toBe('');
  });
});

describe('MinutesChannelsCard', () => {
  const channels = { channels: [{ id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f0001', kind: 'slack', label: 'Kênh #hop-giao-ban', host: 'hooks.slack.com', createdAt: '2026-11-13T03:00:00.000Z' }] };

  it('is for an owner or admin only', () => {
    client.current.clear();
    client.current.setQueryData(['org', 'get'], { role: 'member' });
    client.current.setQueryData(['meetings', 'chat', 'channels'], channels);
    expect(renderToStaticMarkup(wrap(<MinutesChannelsCard />))).toBe('');
    client.current.setQueryData(['org', 'get'], { role: 'viewer' });
    expect(renderToStaticMarkup(wrap(<MinutesChannelsCard />))).toBe('');
  });

  it('lists the name, kind and host, asks for the address, says it is shown once, and never shows a saved address', () => {
    for (const role of ['owner', 'admin']) {
      client.current.clear();
      client.current.setQueryData(['org', 'get'], { role });
      client.current.setQueryData(['meetings', 'chat', 'channels'], channels);
      const html = renderToStaticMarkup(wrap(<MinutesChannelsCard />));
      expect(html).toContain(en.meetings.chat.cardTitle);
      expect(html).toContain('Kênh #hop-giao-ban');
      expect(html).toContain('hooks.slack.com');
      expect(html).toContain(en.meetings.chat.urlOnce);
      expect(html).toContain(en.meetings.chat.urlHintSlack);
      expect(html).not.toMatch(/\/services\/T|workflows\/[0-9a-f]|abcdefghijklmnopqrstuvwx|SECRETSIG/);
    }
  });
});
