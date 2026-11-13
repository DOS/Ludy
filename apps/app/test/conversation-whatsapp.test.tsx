// SPDX-License-Identifier: AGPL-3.0-only
// WhatsApp in the Inbox (#3131), rendered on the server: past the 24 hours the reply box gives the reason and no Send, the reason of a failed or unclear send is worded
// in both languages, an unclear send has no button that sends it again (a person looks on the phone and marks it sent), the box takes 4096 characters, and the
// channel is named WhatsApp. The rule behind the button is the contract's, shared with the server's refusal.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_PROVIDER_RULES, conversationCanResendUnknown, type ConversationDetail, type ConversationMessage } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { providerName } from '../src/lib/social.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: { conversations: { key: () => ['conversations'], get: { queryOptions: () => ({ queryKey: ['get'] }) } } },
  queryClient: { invalidateQueries: () => undefined },
  errorMessage: (e: unknown) => String(e),
  isStepUpRequired: () => false,
  fetchConversationImage: () => Promise.reject(new Error('not called')),
}));
vi.mock('../src/lib/auth.ts', async (original) => ({ ...(await original<typeof import('../src/lib/auth.ts')>()), getConfig: () => ({ aiEnabled: true, channels: { sandbox: false } }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, isLoading: true }),
  useInfiniteQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
}));

const { MessageRow, ReplyBox } = await import('../src/components/conversation-inbox.tsx');

const detailOf = (provider: string, reply: ConversationDetail['reply'], kind: 'direct' | 'comment_thread' = 'direct'): ConversationDetail =>
  ({
    conversation: { id: 'c1', kind, channel: { connectionId: 'k1', provider, displayName: 'Tiệm Bánh An Nhiên' }, contact: { displayName: 'Lan Nguyễn', partyName: null, identityId: null, idTail: '0001', partyId: null } },
    reply,
    messages: [],
    notes: [],
    draft: null,
    suggestions: [],
  }) as unknown as ConversationDetail;

const outbound = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'm1',
  seq: 2,
  direction: 'out',
  authorKind: 'member',
  authorUserId: 'u1',
  authorName: null,
  authorTail: null,
  body: 'Dạ shop gửi bảng giá ạ',
  attachments: [],
  sentAt: new Date().toISOString(),
  sendState: 'sent',
  sendErrorCode: null,
  hidden: false,
  hideRequest: null,
  hideErrorCode: null,
  removed: false,
  ...over,
});

const row = (message: ConversationMessage, provider: string, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <MessageRow message={message} detail={detailOf(provider, { allowed: true, reason: null })} members={[]} userId="u1" canWrite isAdmin={false} contact="Lan Nguyễn" />
    </IntlProvider>,
  );
const box = (detail: ConversationDetail, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <ReplyBox detail={detail} seen={1} onMoved={() => undefined} />
    </IntlProvider>,
  );

describe('the reply box on a WhatsApp thread', () => {
  it('says why there is no Send past 24 hours, and does not offer one', () => {
    const closed = detailOf('whatsapp', { allowed: false, reason: 'window_closed' });
    const vi = box(closed);
    expect(vi).toContain('24 giờ');
    expect(vi).toContain('không gửi tin mẫu');
    expect(vi).not.toContain('<textarea');
    expect(vi).not.toContain('<button');
    expect(box(closed, 'en')).toContain('24 hours');
    // Another channel keeps the generic reason.
    expect(box(detailOf('zalo_oa', { allowed: false, reason: 'window_closed' }))).toContain('Đã quá thời gian nền tảng cho phép');
    expect(box(detailOf('whatsapp', { allowed: false, reason: 'channel_inactive' }))).toContain('hết hạn kết nối');
  });

  it('takes 4096 characters inside the window, as the channel does', () => {
    const open = box(detailOf('whatsapp', { allowed: true, reason: null }));
    expect(open).toContain('<textarea');
    expect(open).toContain('maxLength="4096"');
    expect(CONVERSATION_PROVIDER_RULES.whatsapp).toEqual({ kinds: ['direct'], replyMax: 4096, canHide: false, windowHours: 24 });
  });
});

describe('a message that did not arrive, or may not have', () => {
  it('words the reason of a status failed and of a refusal, in both languages', () => {
    const failed = outbound({ sendState: 'failed', sendErrorCode: 'WA_131047' });
    expect(row(failed, 'whatsapp')).toContain('Đã quá 24 giờ');
    expect(row(failed, 'whatsapp', 'en')).toContain('More than 24 hours');
    expect(row(outbound({ sendState: 'failed', sendErrorCode: 'WA_UNDELIVERABLE' }), 'whatsapp')).toContain('không chuyển được tin');
    expect(row(outbound({ sendState: 'failed', sendErrorCode: 'WA_130429' }), 'whatsapp', 'en')).toContain('limiting how fast');
    // A failed message may be sent again (inside the window): the button is there.
    expect(row(failed, 'whatsapp')).toContain('Gửi lại');
  });

  it('offers only "already sent" for an unclear WhatsApp send, and both buttons for a channel that can read back', () => {
    const unclear = outbound({ sendState: 'unknown', sendErrorCode: 'ADAPTER_ERROR' });
    const whatsapp = row(unclear, 'whatsapp');
    expect(whatsapp).toContain('Đã gửi rồi');
    expect(whatsapp).not.toContain('Chưa thấy trên nền tảng, gửi lại');
    const zalo = row(unclear, 'zalo_oa');
    expect(zalo).toContain('Đã gửi rồi');
    expect(zalo).toContain('Chưa thấy trên nền tảng, gửi lại');
    expect(conversationCanResendUnknown('whatsapp', 'direct')).toBe(false);
    expect(conversationCanResendUnknown('email', 'email')).toBe(false);
    expect(conversationCanResendUnknown('zalo_oa', 'direct')).toBe(true);
    expect(conversationCanResendUnknown('facebook_page', 'direct')).toBe(true);
  });
});

describe('the channel’s name', () => {
  it('is WhatsApp in a list of connections, and the others are unchanged', () => {
    expect(providerName('whatsapp')).toBe('WhatsApp');
    expect(providerName('zalo_oa')).toBe('Zalo OA');
    expect(providerName('email')).toBe('email');
  });

  it('is said in the "a customer is waiting" line of Home, in both languages', () => {
    // The key's place in the catalog is Home's; the select names the channel, and WhatsApp has its own words.
    const find = (node: unknown): string | null => {
      if (typeof node !== 'object' || node === null) return null;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'oneUnanswered' && typeof value === 'string') return value;
        const inner = find(value);
        if (inner !== null) return inner;
      }
      return null;
    };
    expect(find(catalog('vi'))).toContain('whatsapp {Một khách trên WhatsApp}');
    expect(find(catalog('en'))).toContain('whatsapp {A customer on WhatsApp is}');
  });
});
