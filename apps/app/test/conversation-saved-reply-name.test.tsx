// SPDX-License-Identifier: AGPL-3.0-only
// The contact-name placeholder of a saved reply in the reply box (#3102): which name `{tên}` is filled with, what a picked saved reply or a draft puts in the
// box, and the hint under the saved replies that tells a person the placeholder exists, in both languages.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetail } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: { conversations: { savedReplies: { queryOptions: () => ({ queryKey: ['saved'], queryFn: () => Promise.resolve({ replies: [] }) }), key: () => ['saved'] }, key: () => ['conversations'] } },
  queryClient: { invalidateQueries: () => undefined },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { replies: [] }, isError: false }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null }),
}));

const { contactNameOf, replyTextFor, SavedRepliesManager } = await import('../src/components/conversation-drafts.tsx');

const detailOf = (contact: { partyName: string | null; displayName: string | null }): ConversationDetail =>
  ({ conversation: { contact: { identityId: null, idTail: 'ab12', partyId: null, ...contact } } }) as unknown as ConversationDetail;

describe('contactNameOf', () => {
  it('takes the linked contact first, then the name the platform gave, and no name when there is neither', () => {
    expect(contactNameOf({ partyName: 'Chị Mai Hương', displayName: 'mai.huong.99' })).toBe('Chị Mai Hương');
    expect(contactNameOf({ partyName: null, displayName: 'Lan Anh' })).toBe('Lan Anh');
    expect(contactNameOf({ partyName: '  ', displayName: ' Lan Anh ' })).toBe('Lan Anh');
    expect(contactNameOf({ partyName: null, displayName: null })).toBeNull();
    expect(contactNameOf({ partyName: '', displayName: '   ' })).toBeNull();
  });
});

describe('replyTextFor', () => {
  it('shows the contact name in the box when a saved reply with the placeholder is picked', () => {
    expect(replyTextFor('Chào {tên}, shop còn hàng ạ.', detailOf({ partyName: 'Chị Mai Hương', displayName: null }))).toBe('Chào Chị Mai Hương, shop còn hàng ạ.');
    expect(replyTextFor('Chào {tên}, shop còn hàng ạ.', detailOf({ partyName: null, displayName: 'Lan' }))).toBe('Chào Lan, shop còn hàng ạ.');
  });

  it('leaves no brace when the thread has no name', () => {
    const out = replyTextFor('Chào {tên}, shop còn hàng ạ.', detailOf({ partyName: null, displayName: null }));
    expect(out).toBe('Chào, shop còn hàng ạ.');
    expect(out).not.toMatch(/[{}]/u);
  });

  it('fills the placeholder a draft kept, and changes nothing in a text that has none', () => {
    expect(replyTextFor('Dạ {tên} ơi, shop có ạ.', detailOf({ partyName: 'Linh', displayName: null }))).toBe('Dạ Linh ơi, shop có ạ.');
    expect(replyTextFor('Dạ shop có ạ.', detailOf({ partyName: 'Linh', displayName: null }))).toBe('Dạ shop có ạ.');
  });
});

describe('the saved replies screen', () => {
  const render = (locale: 'en' | 'vi') =>
    renderToStaticMarkup(
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <SavedRepliesManager canWrite />
      </IntlProvider>,
    );

  it('tells a person that {tên} is filled with the contact name, in both languages', () => {
    expect(render('vi')).toContain('Gõ {tên} trong nội dung để điền tên liên hệ của khách');
    expect(render('en')).toContain('Type {tên} in the text to fill in the customer&#x27;s contact name');
  });
});
