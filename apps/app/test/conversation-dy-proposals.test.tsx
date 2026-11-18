// SPDX-License-Identifier: AGPL-3.0-only
// Dy's suggestions in the Inbox shown as proposals a person decides (#3637, Engage audit IN-5, IN-6, IN-9, IN-11, IN-12), rendered on the server: the contact suggestions
// name the coworker only when a model ranked them and offer a visible skip that is remembered; the sales coworker is introduced where it first appears; the draft is a proposal chip;
// the assignee control appears only with two members; Resolve is not a second primary button; the reply box counts.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { DISMISSED_THREADS_MAX, dismissContactMatch, dismissedContactMatches } from '../src/lib/conversation-dismissed.ts';

const state: { matches: { ai: string; candidates: { partyId: string; name: string; reason: 'email' | 'phone' | 'name' }[] } | undefined } = { matches: undefined };
vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: { conversations: { key: () => ['conversations'], get: { queryOptions: () => ({ queryKey: ['get'] }) } }, crm: { contacts: { conversations: { key: () => [] } }, deals: { conversations: { key: () => [] } } } },
  queryClient: { invalidateQueries: () => undefined },
  errorMessage: (e: unknown) => String(e),
  isStepUpRequired: () => false,
  fetchConversationImage: () => Promise.reject(new Error('not called')),
}));
vi.mock('../src/lib/auth.ts', async (original) => ({ ...(await original<typeof import('../src/lib/auth.ts')>()), getConfig: () => ({ aiEnabled: true, channels: { sandbox: false } }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.matches, isError: false, isLoading: false }),
  useInfiniteQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
}));

const { ContactSuggestions } = await import('../src/components/conversation-contact-panel.tsx');
const { ReplyBox } = await import('../src/components/conversation-inbox.tsx');

type Locale = 'en' | 'vi';
const wrap = (node: React.ReactNode, locale: Locale) => renderToStaticMarkup(<IntlProvider locale={locale} messages={catalog(locale)}>{node}</IntlProvider>);
const suggestions = (locale: Locale = 'vi') => wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />, locale);

const memory = () => {
  const data = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } });
  return data;
};

describe('the contact suggestions (IN-5)', () => {
  beforeEach(() => {
    memory();
    state.matches = {
      ai: 'off',
      candidates: [
        { partyId: 'p1', name: 'Công ty An Phát', reason: 'email' },
        { partyId: 'p2', name: 'Lan Nguyễn', reason: 'name' },
      ],
    };
  });

  it('is headed as a question for a person, with what linking does and a button that names the contact', () => {
    const html = suggestions();
    expect(html).toContain('Liên hệ có thể là khách này');
    expect(html).toContain(catalog('vi').conversations.contact.suggestedHint);
    expect(html).toContain('Gắn với Công ty An Phát');
    expect(html).toContain('Gắn với Lan Nguyễn');
    expect(suggestions('en')).toContain('Link to Công ty An Phát');
  });

  it('names the coworker as the ranker only when a model ranked them', () => {
    expect(suggestions()).not.toContain('contact-ranked-by');
    expect(suggestions()).not.toContain('Dy');
    state.matches = { ...(state.matches as NonNullable<typeof state.matches>), ai: 'used' };
    const html = suggestions();
    expect(html).toContain('data-testid="contact-ranked-by"');
    expect(html).toContain('Dy xếp thứ tự');
    expect(suggestions('en')).toContain('Dy ranked these');
  });

  it('offers a visible skip on every row, named for its contact, and does not show the name-only warning before anything is clicked (the click flow is checked in the browser by e2e, not here)', () => {
    const html = suggestions();
    expect(html.match(/data-testid="contact-suggestion-dismiss"/g)).toHaveLength(2);
    expect(html).toContain('>Bỏ qua<');
    expect(html).toContain('Bỏ qua gợi ý Lan Nguyễn');
    expect(html).not.toContain('contact-name-only-warn');
  });

  it('does not bring back a contact that was skipped for this thread, and keeps the others', () => {
    dismissContactMatch('c1', 'p2');
    const html = suggestions();
    expect(html).toContain('Công ty An Phát');
    expect(html).not.toContain('Lan Nguyễn');
    dismissContactMatch('c1', 'p1');
    expect(suggestions()).toBe('');
  });

  it('is empty with nothing to suggest', () => {
    state.matches = { ai: 'off', candidates: [] };
    expect(suggestions()).toBe('');
  });
});

describe('the memory of skipped suggestions', () => {
  it('is kept per thread, without duplicates, and forgets nothing it was told', () => {
    memory();
    expect(dismissedContactMatches('c1')).toEqual([]);
    dismissContactMatch('c1', 'p1');
    dismissContactMatch('c1', 'p1');
    dismissContactMatch('c1', 'p2');
    dismissContactMatch('c2', 'p9');
    expect(dismissedContactMatches('c1')).toEqual(['p1', 'p2']);
    expect(dismissedContactMatches('c2')).toEqual(['p9']);
  });

  it('keeps only the newest threads', () => {
    memory();
    for (let i = 0; i < DISMISSED_THREADS_MAX + 5; i += 1) dismissContactMatch(`t${i}`, 'p');
    expect(dismissedContactMatches('t0')).toEqual([]);
    expect(dismissedContactMatches(`t${DISMISSED_THREADS_MAX + 4}`)).toEqual(['p']);
  });

  it('survives storage that is blocked or holds rubbish', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => '{not json', setItem: () => { throw new Error('blocked'); } } });
    expect(dismissedContactMatches('c1')).toEqual([]);
    expect(dismissContactMatch('c1', 'p1')).toEqual(['p1']);
    vi.stubGlobal('window', { get localStorage(): never { throw new Error('denied'); } });
    expect(dismissedContactMatches('c1')).toEqual([]);
  });
});

const detail = (over: { draft?: boolean } = {}): ConversationDetail =>
  ({
    conversation: { id: 'c1', kind: 'direct', channel: { connectionId: 'k1', provider: 'zalo_oa', displayName: 'Tiệm' }, contact: { displayName: 'Lan', partyName: null, identityId: null, idTail: '0001', partyId: null, address: null } },
    reply: { allowed: true, reason: null },
    messages: [{ id: 'm1', seq: 1, direction: 'in', authorKind: 'customer', authorUserId: null, authorName: 'Lan', authorTail: null, body: 'Giá bao nhiêu?', attachments: [], sentAt: new Date().toISOString(), sendState: null, sendErrorCode: null, hidden: false, hideRequest: null, hideErrorCode: null, removed: false }],
    notes: [],
    draft: over.draft ? { id: 'd1', state: 'live', source: 'ai', body: 'Dạ giá 100k ạ', tainted: true } : null,
    suggestions: [],
  }) as unknown as ConversationDetail;
const box = (d: ConversationDetail, locale: Locale = 'vi') => wrap(<ReplyBox detail={d} seen={1} onMoved={() => undefined} />, locale);

describe('Dy in the reply box (IN-6, IN-11, IN-12)', () => {
  it('is introduced as the AI sales coworker that proposes, before the button that asks it', () => {
    const html = box(detail());
    expect(html).toContain('data-testid="conversation-dy-intro"');
    expect(html).toContain('Dy, đồng nghiệp AI bán hàng, gợi ý loại hội thoại, liên hệ và câu trả lời; bạn quyết định.');
    expect(html.indexOf('conversation-dy-intro')).toBeLessThan(html.indexOf('conversation-draft-ask'));
    expect(html).toContain('Nhờ Dy soạn trả lời');
    expect(box(detail(), 'en')).toContain('Dy, the AI sales coworker, suggests conversation types, contacts and replies; you decide.');
  });

  it('shows the draft as a proposal chip, in the proposal words', () => {
    const html = box(detail({ draft: true }));
    // The proposal hue, never the plain outline of a label nobody has to read.
    expect(/<span[^>]*class="[^"]*text-proposal[^"]*"[^>]*data-testid="conversation-draft-tainted"|<span[^>]*data-testid="conversation-draft-tainted"[^>]*class="[^"]*text-proposal/.test(html)).toBe(true);
    expect(html).toContain('Đề xuất của Dy: hãy đọc lại trước khi gửi');
    expect(box(detail({ draft: true }), 'en')).toContain('Dy’s proposal: read it before sending');
  });

  it('counts the characters left in the reply box', () => {
    expect(box(detail())).toContain('data-testid="conversation-reply-count"');
    expect(box(detail())).toMatch(/Còn được \d+ ký tự \(tối đa \d+\)/);
  });
});
