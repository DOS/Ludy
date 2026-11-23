// SPDX-License-Identifier: AGPL-3.0-only
// Erasing a customer's conversation data (#3635, Engage audit IN-1), rendered on the server: no erase control in a comment bubble or in the working row, one
// control in its own "Dữ liệu cá nhân" section, the people it can erase (the thread's customer, and in a comment thread the others who commented), and the
// words of the confirmation and the result toast in both languages, with the counts the screen holds. The dialog's focus and Esc are ConfirmDialog's (its own
// test and the e2e); the command and its step-up are unchanged (apps/kernel/test/conversations-erase*.test.ts).
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider, useTranslations } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_OTHERS_MAX, type ConversationDetail, type ConversationMessage } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: { conversations: { key: () => ['conversations'], get: { queryOptions: () => ({ queryKey: ['get'] }) } } },
  queryClient: { invalidateQueries: () => undefined },
  errorMessage: (e: unknown) => String(e),
  isStepUpRequired: () => false,
  fetchConversationImage: () => Promise.reject(new Error('not called')),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, isLoading: true }),
  useInfiniteQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
}));

const { MessageRow } = await import('../src/components/conversation-inbox.tsx');
const { PersonalDataSection, eraseTargets } = await import('../src/components/conversation-erase.tsx');

const customer = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'm1',
  seq: 1,
  direction: 'in',
  authorKind: 'contact',
  authorUserId: null,
  authorName: 'Lan Nguyễn',
  authorTail: '0001',
  body: 'Còn hàng không shop?',
  attachments: [],
  sentAt: new Date().toISOString(),
  sendState: null,
  sendErrorCode: null,
  hidden: false,
  hideRequest: null,
  hideErrorCode: null,
  removed: false,
  ...over,
});

const other = (id: string, kind: 'direct' | 'comment_thread' = 'direct') => ({ id, kind, status: 'new', channel: { connectionId: 'k1', provider: 'facebook', displayName: 'Trang Bình Luận' }, lastMessageAt: null });

const detailOf = (over: { kind?: 'direct' | 'comment_thread'; messages?: ConversationMessage[]; others?: ReturnType<typeof other>[]; notes?: number }): ConversationDetail =>
  ({
    conversation: {
      id: 'c1',
      kind: over.kind ?? 'comment_thread',
      channel: { connectionId: 'k1', provider: 'facebook', displayName: 'Trang Bình Luận' },
      contact: { displayName: 'Lan Nguyễn', partyName: null, identityId: 'i1', idTail: '0001', partyId: null, address: null },
    },
    reply: { allowed: true, reason: null },
    messages: over.messages ?? [customer({})],
    notes: Array.from({ length: over.notes ?? 0 }, (_, i) => ({ id: `n${i}`, authorUserId: 'u1', body: 'x', createdAt: new Date().toISOString() })),
    others: over.others ?? [],
    draft: null,
    suggestions: [],
    parentId: null,
    gap: null,
  }) as unknown as ConversationDetail;

const withIntl = (node: React.ReactNode, locale: 'en' | 'vi') => renderToStaticMarkup(<IntlProvider locale={locale} messages={catalog(locale)}>{node}</IntlProvider>);

describe('the bubble and the working row', () => {
  it('a customer comment bubble has no erase control, for an admin or anyone', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = withIntl(<MessageRow message={customer({})} detail={detailOf({})} members={[]} userId="u1" canWrite contact="Lan Nguyễn" />, locale);
      expect(html).not.toContain('conversation-message-erase-open');
      expect(html).not.toContain('conversation-erase-open');
      expect(html).not.toMatch(/Xóa khách|Erase this customer/);
    }
  });
});

describe('the people the section can erase', () => {
  it('counts the thread, its others, its messages and notes, and says when a read was capped', () => {
    const [own] = eraseTargets(detailOf({ kind: 'direct', messages: [customer({}), customer({ id: 'm2', seq: 2 })], others: [other('o1'), other('o2')], notes: 3 }), 'Lan Nguyễn', (t) => `Người dùng ·${t}`);
    expect(own).toMatchObject({ name: 'Lan Nguyễn', threads: 3, threadsMore: false, messages: 2, messagesMore: false, notes: 3, inComments: false });
    const capped = eraseTargets(detailOf({ kind: 'direct', others: Array.from({ length: CONVERSATION_OTHERS_MAX }, (_, i) => other(`o${i}`)) }), 'Lan Nguyễn', (t) => t)[0];
    expect(capped).toMatchObject({ threads: CONVERSATION_OTHERS_MAX + 1, threadsMore: true });
  });

  it('adds the other commenters of a comment thread, once each, and never the thread customer again', () => {
    const detail = detailOf({
      messages: [
        customer({}),
        customer({ id: 'm2', seq: 2, authorName: 'Minh Trần', authorTail: '0002' }),
        customer({ id: 'm3', seq: 3, authorName: 'Minh Trần', authorTail: '0002' }),
        customer({ id: 'm4', seq: 4, authorName: null, authorTail: '0003' }),
        customer({ id: 'm5', seq: 5, direction: 'out', authorKind: 'member', authorUserId: 'u1', authorName: null, authorTail: null }),
      ],
    });
    const targets = eraseTargets(detail, 'Lan Nguyễn', (t) => `Người dùng ·${t}`);
    expect(targets.map((t) => t.name)).toEqual(['Lan Nguyễn', 'Minh Trần', 'Người dùng ·0003']);
    expect(targets[1]).toMatchObject({ messageId: 'm2', messages: 2, threads: null, inComments: false });
    // Two people who share the last four characters of their id are two targets; the name tells them apart.
    const clash = detailOf({ messages: [customer({}), customer({ id: 'm2', seq: 2, authorName: 'Minh Trần', authorTail: '0001' })] });
    expect(eraseTargets(clash, 'Lan Nguyễn', (t) => t).map((t) => t.name)).toEqual(['Lan Nguyễn', 'Minh Trần']);
    // A direct thread has no other commenters.
    expect(eraseTargets(detailOf({ kind: 'direct', messages: [customer({}), customer({ id: 'm2', authorTail: '0002' })] }), 'Lan Nguyễn', (t) => t)).toHaveLength(1);
  });
});

describe('the personal-data section', () => {
  it('is its own section with one control for the customer, named for what it erases', () => {
    const vi = withIntl(<PersonalDataSection detail={detailOf({ kind: 'direct' })} contactName="Lan Nguyễn" onErased={() => undefined} />, 'vi');
    expect(vi).toContain('data-testid="conversation-personal-data"');
    expect(vi).toContain('Dữ liệu cá nhân');
    expect(vi).toContain('Xóa dữ liệu hội thoại của khách này');
    expect(vi.match(/data-testid="conversation-erase-open"/g)).toHaveLength(1);
    expect(vi).not.toContain('Người khác đã bình luận ở đây');
    const en = withIntl(<PersonalDataSection detail={detailOf({ kind: 'direct' })} contactName="Lan Nguyễn" onErased={() => undefined} />, 'en');
    expect(en).toContain('Personal data');
    expect(en).toContain("Erase this customer&#x27;s conversation data");
  });

  it('lists the other commenters of a comment thread, each named, under their own subheading', () => {
    const detail = detailOf({ messages: [customer({}), customer({ id: 'm2', seq: 2, authorName: 'Minh Trần', authorTail: '0002' })] });
    const html = withIntl(<PersonalDataSection detail={detail} contactName="Lan Nguyễn" onErased={() => undefined} />, 'vi');
    expect(html).toContain('Người khác đã bình luận ở đây');
    expect(html).toContain('Xóa dữ liệu của Minh Trần');
    expect(html.match(/data-testid="conversation-message-erase-open"/g)).toHaveLength(1);
  });
});

// The words, formatted with real counts (the dialog is a portal and closed in a static render, so its strings are rendered here).
function Words({ keys, values }: { keys: string[]; values: Record<string, string | number> }) {
  const t = useTranslations('conversations.erase') as unknown as (key: string, values: Record<string, string | number>) => string;
  return <>{keys.map((k) => `[${t(k, values)}]`).join('')}</>;
}
const words = (locale: 'en' | 'vi', keys: string[], values: Record<string, string | number>) => withIntl(<Words keys={keys} values={values} />, locale).replace(/&#x27;/g, "'");

describe('the confirmation and the toast', () => {
  const values = { name: 'Lan Nguyễn', channel: 'Zalo OA', at: ' (lan@example.com)', threads: 3, threadsMore: 'no', messages: 12, messagesMore: 'no', notes: 1 };

  it('names the person, the counts, what stays and that it cannot be undone, in Vietnamese', () => {
    const text = words('vi', ['title', 'warnContact', 'warnComments', 'stays', 'irreversible', 'confirmContact', 'done'], values);
    expect(text).toContain('Xóa dữ liệu hội thoại của Lan Nguyễn?');
    expect(text).toContain('3 hội thoại của Lan Nguyễn (lan@example.com) trên Zalo OA');
    expect(text).toContain('12 tin nhắn và 1 ghi chú nội bộ');
    expect(text).toContain('Liên hệ trong CRM, việc đã giao và báo giá được giữ nguyên.');
    expect(text).toContain('Không khôi phục được. Nếu khách nhắn lại, một hội thoại mới sẽ mở.');
    expect(text).toContain('Xóa vĩnh viễn 3 hội thoại');
    expect(text).toContain('Đã xóa 3 hội thoại, 12 tin nhắn của Lan Nguyễn');
    expect(text).not.toContain('tên khách');
  });

  it('and in English, with singular forms and a floor when the read was capped', () => {
    const text = words('en', ['warnContact', 'confirmContact', 'done'], { ...values, threads: 1, messages: 1, notes: 1 });
    expect(text).toContain('1 conversation of Lan Nguyễn (lan@example.com) on Zalo OA');
    expect(text).toContain('1 message and 1 internal note');
    expect(text).toContain('Erased 1 conversation, 1 message of Lan Nguyễn');
    const capped = words('en', ['warnContact', 'confirmContact'], { ...values, threads: 11, threadsMore: 'yes' });
    expect(capped).toContain('at least 11 conversations');
    expect(capped).toContain('Erase at least 11 conversations for good');
    expect(words('vi', ['confirmContact'], { ...values, threads: 11, threadsMore: 'yes' })).toContain('Xóa vĩnh viễn ít nhất 11 hội thoại');
  });

  it('says what the author variant erases and that others replies in comment threads go too', () => {
    const vi = words('vi', ['warnAuthor', 'confirmAuthor', 'warnComments'], { ...values, name: 'Minh Trần', messages: 2 });
    expect(vi).toContain('mọi hội thoại Minh Trần đã mở trên Zalo OA');
    expect(vi).toContain('Xóa vĩnh viễn dữ liệu của Minh Trần');
    expect(vi).toContain('Bình luận của người khác trong các chuỗi bình luận đó cũng bị xóa theo');
  });
});
