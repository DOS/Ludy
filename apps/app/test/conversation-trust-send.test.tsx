// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's honest sender trust, send buttons that name the outcome, and plain send errors (#3636, Engage audit IN-2, IN-3, IN-4, IN-10), rendered on the server:
// the "sender not confirmed" mark shows only where the deployment can check senders, with its explanation as visible text; the email reply names the address it goes to;
// each reply type has a button that says what happens; no failed send shows a raw code or an API name; and a channel whose name is its kind is not printed twice.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, ConversationMessage } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { channelKindLabel } from '../src/lib/conversation-labels.ts';

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

const { MessageRow, ReplyBox, UnverifiedMark } = await import('../src/components/conversation-inbox.tsx');

type Kind = 'email' | 'direct' | 'comment_thread';
const detailOf = (kind: Kind, over: { senderUnverified?: boolean; address?: string | null } = {}): ConversationDetail =>
  ({
    conversation: {
      id: 'c1',
      kind,
      senderUnverified: over.senderUnverified ?? false,
      channel: { connectionId: 'k1', provider: kind === 'email' ? 'email' : 'zalo_oa', displayName: 'Tiệm Bánh An Nhiên' },
      contact: { displayName: 'Lan Nguyễn', partyName: null, identityId: null, idTail: '0001', partyId: null, address: over.address === undefined ? 'lan@example.com' : over.address },
    },
    reply: { allowed: true, reason: null },
    messages: [],
    notes: [],
    draft: null,
    suggestions: [],
  }) as unknown as ConversationDetail;

type Locale = 'en' | 'vi';
const wrap = (node: React.ReactNode, locale: Locale) => renderToStaticMarkup(<IntlProvider locale={locale} messages={catalog(locale)}>{node}</IntlProvider>);
const box = (detail: ConversationDetail, locale: Locale = 'vi') => wrap(<ReplyBox detail={detail} seen={1} onMoved={() => undefined} />, locale);

describe('the "sender not confirmed" mark (IN-2)', () => {
  it('says it in the new words with the explanation as visible text, not a hover title', () => {
    const vi = wrap(<UnverifiedMark explain />, 'vi');
    expect(vi).toContain('Chưa xác nhận người gửi');
    expect(vi).not.toContain('Chưa xác minh');
    expect(vi).toContain('data-testid="unverified-explain"');
    expect(vi).toContain(catalog('vi').conversations.unverifiedHint);
    expect(vi).not.toContain('title=');
    expect(vi).not.toContain('text-[10px]');
    expect(wrap(<UnverifiedMark explain />, 'en')).toContain('Sender not confirmed');
    // In a list row only the short mark is drawn.
    expect(wrap(<UnverifiedMark />, 'vi')).not.toContain('unverified-explain');
  });
});

describe('the reply box (IN-3, IN-4)', () => {
  it('names the address an email goes to, and warns about an unconfirmed sender only when the server marks the thread', () => {
    const marked = box(detailOf('email', { senderUnverified: true }));
    expect(marked).toContain('Thư sẽ gửi tới lan@example.com');
    expect(marked).toContain('data-testid="reply-unverified-note"');
    // A deployment that cannot check senders sends no mark (the server leaves the field out), so the reply carries no warning.
    const plain = box(detailOf('email', { senderUnverified: false }));
    expect(plain).toContain('Thư sẽ gửi tới lan@example.com');
    expect(plain).not.toContain('reply-unverified-note');
    expect(box(detailOf('email'))).not.toContain('reply-unverified-note');
    expect(box(detailOf('email'), 'en')).toContain('The mail will be sent to lan@example.com');
  });

  it('gives each reply type a button that names what happens, in both languages', () => {
    const label = (kind: Kind, locale: Locale) => /data-testid="conversation-send"[^>]*>([^<]*)</.exec(box(detailOf(kind), locale))?.[1];
    expect(label('comment_thread', 'vi')).toBe('Đăng trả lời công khai');
    expect(label('direct', 'vi')).toBe('Gửi tin nhắn riêng');
    expect(label('email', 'vi')).toBe('Gửi email');
    expect(label('comment_thread', 'en')).toBe('Post public reply');
    expect(label('direct', 'en')).toBe('Send private message');
    expect(label('email', 'en')).toBe('Send email');
  });
});

describe('a failed send (IN-10)', () => {
  const failed = (over: Partial<ConversationMessage>): ConversationMessage => ({
    id: 'm1', seq: 2, direction: 'out', authorKind: 'member', authorUserId: 'u1', authorName: null, authorTail: null, body: 'Dạ', attachments: [], sentAt: new Date().toISOString(),
    sendState: 'failed', sendErrorCode: null, hidden: false, hideRequest: null, hideErrorCode: null, removed: false, ...over,
  });
  const row = (m: ConversationMessage, locale: Locale) => wrap(<MessageRow message={m} detail={detailOf('direct')} members={[]} userId="u1" canWrite contact="Lan Nguyễn" />, locale);

  it('says a code it has no words for as a plain sentence, never the code', () => {
    const vi = row(failed({ sendErrorCode: 'ADAPTER_ERROR_77' }), 'vi');
    expect(vi).toContain('Chưa gửi được. Hãy thử lại hoặc liên hệ hỗ trợ.');
    expect(vi).not.toContain('ADAPTER_ERROR_77');
    expect(row(failed({ sendErrorCode: 'ADAPTER_ERROR_77' }), 'en')).toContain('Could not send. Try again or contact support.');
  });

  it('says an unclear send with no known code is unclear, never that it was not sent, so nobody sends it twice', () => {
    const vi = row(failed({ sendState: 'unknown', sendErrorCode: 'ADAPTER_ERROR_77' }), 'vi');
    expect(vi).toContain('Chưa rõ tin đã gửi hay chưa. Hãy xem lại trên nền tảng trước khi gửi lại.');
    expect(vi).not.toContain('Chưa gửi được. Hãy thử lại');
    expect(vi).not.toContain('ADAPTER_ERROR_77');
    expect(row(failed({ sendState: 'unknown', sendErrorCode: 'ADAPTER_ERROR_77' }), 'en')).toContain('Not clear whether the message was sent');
  });

  it('shows no code when hiding a comment failed', () => {
    const html = row(failed({ sendState: 'sent', hideErrorCode: 'FB_190_TOKEN_EXPIRED' }), 'vi');
    expect(html).toContain('Chưa đổi được.');
    expect(html).not.toContain('FB_190');
  });

  // The whole catalog: a sentence for a shop owner, never a provider's scope, product or API, a numeric error code, a field name or "máy chủ".
  const INTERNALS = /whatsapp_business_messaging|Cloud API|Business Suite|\bAPI\b|\btoken\b|\bID\b|\bids?\b|\b\d{5,}\b|[A-Z]{2,}_[A-Z_]{2,}|mã truy cập|mã bot|mã tin nhắn|mã bài|mã người nhận|mã trang|mã số|mã bình luận|mã trả lời|máy chủ|\bserver\b|\bMeta\b|\bGraph\b|OAuth|webhook/i;
  for (const locale of ['vi', 'en'] as const) {
    it(`words every send error of the catalog in ${locale} without provider internals`, () => {
      const c = catalog(locale).conversations as unknown as { sendError: Record<string, string>; replyBlocked: Record<string, string>; hideFailed: string };
      expect(Object.keys(c.sendError).length).toBeGreaterThan(60);
      for (const [code, text] of Object.entries({ ...c.sendError, ...Object.fromEntries(Object.entries(c.replyBlocked).map(([k, v]) => [`replyBlocked.${k}`, v])) })) {
        expect(text, `${locale} ${code}`).not.toMatch(INTERNALS);
      }
      expect(c.hideFailed).not.toContain('{');
    });
  }
});

describe('the channel and kind on one line (IN-4)', () => {
  it('drops the kind when it is the channel’s own name', () => {
    expect(channelKindLabel('Email', 'Email')).toBe('Email');
    expect(channelKindLabel('email', 'Email')).toBe('email');
    expect(channelKindLabel('Zalo OA', 'Tin nhắn riêng')).toBe('Zalo OA · Tin nhắn riêng');
  });
});
