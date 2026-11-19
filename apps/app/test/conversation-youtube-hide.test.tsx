// SPDX-License-Identifier: AGPL-3.0-only
// Hide and show again of a YouTube comment on the screen (#3808), rendered on the server: the button follows the thread's `hideAllowed` (a connection without the
// comment scope shows none; an older answer without the field keeps the provider's rule), a hidden comment offers "Hiện lại", and Dy's "may be spam" is only a hint
// read from the cache the header's query fills (never asked here), shown for a New thread with no applied label and gone once the comment is hidden or when
// the AI gave no suggestion. The button is the only way to hide.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_PROVIDER_RULES, type ConversationDetail, type ConversationMessage } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ intents: undefined as unknown, asked: 0 }));
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
  // The hint's observer must never run the model call: it is disabled and only reads what the header put in the cache.
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[0] === 'conversation-intents') {
      if (options.enabled !== false) state.asked++;
      return { data: state.intents, isError: false, isLoading: false };
    }
    return { data: undefined, isError: false, isLoading: true };
  },
  useInfiniteQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
}));

const { MessageRow } = await import('../src/components/conversation-inbox.tsx');

const detailOf = (over: { provider?: string; hideAllowed?: boolean | undefined; intent?: string | null } = {}): ConversationDetail =>
  ({
    conversation: {
      id: 'c1',
      kind: 'comment_thread',
      status: 'new',
      lastSeq: 1,
      intent: over.intent ?? null,
      channel: { connectionId: 'k1', provider: over.provider ?? 'youtube', displayName: 'Tiệm Bánh An Nhiên' },
      contact: { displayName: 'Lan Nguyễn', partyName: null, identityId: null, idTail: '0001', partyId: null },
    },
    reply: { allowed: true, reason: null },
    ...('hideAllowed' in over ? { hideAllowed: over.hideAllowed } : {}),
    messages: [],
    notes: [],
    draft: null,
    suggestions: [],
  }) as unknown as ConversationDetail;

const comment = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  seq: 1,
  direction: 'in',
  authorKind: 'contact',
  authorUserId: null,
  authorName: '@lan.nguyen',
  authorTail: null,
  body: 'Mua hàng giá rẻ tại link này nhé',
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

const row = (message: ConversationMessage, detail: ConversationDetail, locale: 'en' | 'vi' = 'vi', canWrite = true) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <MessageRow message={message} detail={detail} members={[]} userId="u1" canWrite={canWrite} contact="Lan Nguyễn" />
    </IntlProvider>,
  );
const spam = { suggestions: [{ conversationId: 'c1', intent: 'spam' }], ai: 'ok' };

describe('Hide on a YouTube comment (#3808)', () => {
  beforeEach(() => {
    state.intents = undefined;
    state.asked = 0;
  });

  it('is a rule of the contract: YouTube hides, a channel that cannot still does not', () => {
    expect(CONVERSATION_PROVIDER_RULES.youtube?.canHide).toBe(true);
    expect(CONVERSATION_PROVIDER_RULES.whatsapp?.canHide).toBe(false);
    expect(CONVERSATION_PROVIDER_RULES.threads?.canHide).toBe(false);
  });

  it('offers Ẩn and, once hidden, Hiện lại, in both languages', () => {
    const detail = detailOf({ hideAllowed: true });
    expect(row(comment(), detail)).toContain('data-testid="conversation-hide"');
    expect(row(comment(), detail)).toContain('>Ẩn<');
    expect(row(comment(), detail, 'en')).toContain('>Hide<');
    const hidden = row(comment({ hidden: true }), detail);
    expect(hidden).toContain('>Hiện lại<');
    expect(hidden).toContain('Đã ẩn');
    expect(row(comment({ hidden: true }), detail, 'en')).toContain('>Show again<');
  });

  it('shows no button when the connection lacks the comment scope, to a viewer, on the channel own message or while a change is pending', () => {
    expect(row(comment(), detailOf({ hideAllowed: false }))).not.toContain('conversation-hide');
    expect(row(comment(), detailOf({ hideAllowed: true }), 'vi', false)).not.toContain('conversation-hide');
    expect(row(comment({ direction: 'out', authorKind: 'member', authorUserId: 'u1' }), detailOf({ hideAllowed: true }))).not.toContain('conversation-hide');
    expect(row(comment({ hideRequest: 'hide' }), detailOf({ hideAllowed: true }))).not.toContain('conversation-hide');
  });

  it('keeps the provider rule for an answer without the field, and refuses a provider that cannot hide', () => {
    expect(row(comment(), detailOf({}))).toContain('conversation-hide');
    expect(row(comment(), detailOf({ provider: 'threads' }))).not.toContain('conversation-hide');
  });

  it('shows the AI suggestion only as a hint beside the button, read from the cache and never asked here', () => {
    state.intents = spam;
    const hint = row(comment(), detailOf({ hideAllowed: true }));
    expect(hint).toContain('data-testid="conversation-hide-suggested"');
    expect(hint).toContain('có thể là spam');
    expect(hint).toContain('data-testid="conversation-hide"');
    expect(row(comment(), detailOf({ hideAllowed: true }), 'en')).toContain('may be spam');
    // No model call from the message row: its observer is disabled.
    expect(state.asked).toBe(0);
    // No hint once hidden, with a label a person applied, or when the connection cannot hide at all.
    expect(row(comment({ hidden: true }), detailOf({ hideAllowed: true }))).not.toContain('conversation-hide-suggested');
    expect(row(comment(), detailOf({ hideAllowed: true, intent: 'question' }))).not.toContain('conversation-hide-suggested');
    expect(row(comment(), detailOf({ hideAllowed: false }))).not.toContain('conversation-hide-suggested');
    // Other suggestions, or none (the AI off, spent or failing), give no hint, and the button works the same.
    state.intents = { suggestions: [{ conversationId: 'c1', intent: 'question' }], ai: 'ok' };
    expect(row(comment(), detailOf({ hideAllowed: true }))).not.toContain('conversation-hide-suggested');
    state.intents = { suggestions: [], ai: 'budget' };
    const off = row(comment(), detailOf({ hideAllowed: true }));
    expect(off).not.toContain('conversation-hide-suggested');
    expect(off).toContain('conversation-hide');
  });
});
