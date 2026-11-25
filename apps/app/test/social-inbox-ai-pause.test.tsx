// SPDX-License-Identifier: AGPL-3.0-only
// Pause AI suggestion queries behind the Inbox settings drawer, clear stale intent suggestions when AI is off,
// invalidate open conversation caches when auto-draft changes, and lock saved-reply row actions while saving (#3673).
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, ConversationMessage, ConversationSummary } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({
  queries: [] as Array<{ queryKey?: unknown; enabled?: unknown; refetchInterval?: unknown; refetchOnWindowFocus?: unknown }>,
  infiniteQueries: [] as Array<{ queryKey?: unknown; enabled?: unknown; refetchInterval?: unknown; refetchOnWindowFocus?: unknown; refetchOnReconnect?: unknown }>,
  accessedProps: new Set<string>(),
  mutations: [] as Array<{ onSuccess?: (data?: unknown, vars?: unknown) => unknown }>,
  events: [] as Array<{ kind: 'cancel' | 'invalidate' | 'remove' | 'set'; key: unknown; value?: unknown }>,
  sheetOnOpenChange: null as ((open: boolean) => void) | null,
  navigate: vi.fn(),
  currentOrg: 'acme',
  role: 'owner' as 'owner' | 'viewer',
  aiEnabled: true,
  modules: ['kernel', 'social'] as string[],
  search: {} as Record<string, unknown>,
  savePending: false,
  autoDraftPending: false,
  autoDraftError: false,
  emailAddressMounts: 0,
  detail: null as unknown as ConversationDetail,
  detailError: null as unknown,
  savedReplies: [] as Array<{ id: string; title: string; body: string; keywords: string[]; useCount: number }>,
  autoDraft: { autoDraft: true } as { autoDraft: boolean } | undefined,
  cachedIntents: undefined as { ai: string; suggestions: Array<{ conversationId: string; intent: 'order_or_price' | 'spam' | null }> } | undefined,
  cachedMatches: undefined as { ai: string; candidates: Array<{ partyId: string; name: string; reason: 'email' | 'phone' | 'name' }> } | undefined,
  countsResult: undefined as { data?: Record<string, number>; isPending: boolean; isError: boolean; error: unknown } | undefined,
  pagesResult: undefined as
    | {
        data?: { pages: Array<{ conversations: ConversationSummary[]; more: boolean }> };
        isPending: boolean;
        error: unknown;
        hasNextPage: boolean;
        isFetchingNextPage: boolean;
        isFetchNextPageError: boolean;
      }
    | undefined,
}));

vi.mock('../src/lib/api.ts', () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.resolve({}) });
        if (prop === 'infiniteOptions') return () => ({ queryKey: path, queryFn: () => Promise.resolve({ items: [], nextCursor: null }) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    getCurrentOrg: () => state.currentOrg,
    queryClient: {
      cancelQueries: (arg: { queryKey: unknown }) => {
        state.events.push({ kind: 'cancel', key: arg.queryKey });
        return Promise.resolve();
      },
      setQueryData: (key: unknown, value: unknown) => {
        state.events.push({ kind: 'set', key, value });
      },
      removeQueries: (arg: { queryKey: unknown }) => {
        state.events.push({ kind: 'remove', key: arg.queryKey });
      },
      invalidateQueries: (arg: { queryKey: unknown }) => {
        state.events.push({ kind: 'invalidate', key: arg.queryKey });
        return Promise.resolve();
      },
    },
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    fetchConversationImage: () => Promise.reject(new Error('not called')),
  };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({
    aiEnabled: state.aiEnabled,
    modules: state.modules,
    channels: { oauth: [], sandbox: false },
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => state.search,
    useNavigate: () => state.navigate,
    Link: ({ children, to, className }: { children?: React.ReactNode; to: string; className?: string }) => createElement('a', { href: to, className }, children),
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children?: React.ReactNode }) => {
      state.sheetOnOpenChange = onOpenChange;
      return open ? h('div', { 'data-slot': 'sheet' }, children) : null;
    },
    SheetContent: ({ children, closeLabel, finalFocus: _finalFocus, ...rest }: { children?: React.ReactNode; closeLabel: string; finalFocus?: unknown; [k: string]: unknown }) =>
      h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: React.ReactNode; className?: string }) => h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: React.ReactNode; className?: string }) => h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: React.ReactNode; className?: string }) => h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: React.ReactNode; className?: string }) => h('div', { 'data-slot': 'sheet-body', className }, children),
  };
});

vi.mock('../src/components/conversation-email-address.tsx', () => ({
  EmailAddressCard: () => {
    state.emailAddressMounts += 1;
    return <div data-testid="inbox-email-address-stub" />;
  },
}));

const trackProps = <T extends object>(obj: T): T =>
  new Proxy(obj, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') state.accessedProps.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey?: unknown; enabled?: unknown; refetchInterval?: unknown; refetchOnWindowFocus?: unknown }) => {
    state.queries.push(opts);
    const key = Array.isArray(opts.queryKey) ? opts.queryKey : [];
    if (key[0] === 'org' && key[1] === 'get') return { data: { role: state.role, members: [], conversationAddress: null }, isPending: false, isError: false, error: null };
    if (key[0] === 'me' && key[1] === 'get') return { data: { userId: 'u1', orgs: [{ slug: 'acme', role: state.role }] }, isPending: false, isError: false, error: null };
    if (key[0] === 'channels' && key[1] === 'list') return { data: [], isPending: false, isError: false, error: null };
    if (key[0] === 'conversations' && key[1] === 'get')
      return trackProps({ data: state.detail, isPending: false, isError: Boolean(state.detailError), error: state.detailError, isFetching: false, dataUpdatedAt: 1, fetchStatus: 'idle', isStale: false, refetch: () => Promise.resolve() });
    if (key[0] === 'conversations' && key[1] === 'savedReplies') return { data: { replies: state.savedReplies }, isPending: false, isError: false, error: null };
    if (key[0] === 'conversations' && key[1] === 'autoDraft') return { data: state.autoDraft, isPending: false, isError: state.autoDraftError, error: state.autoDraftError ? new Error('autoDraft err') : null, refetch: () => Promise.resolve() };
    if (key[0] === 'conversations' && key[1] === 'tasks') return { data: { tasks: [] }, isPending: false, isError: false, error: null };
    if (key[0] === 'conversations' && key[1] === 'counts' && state.countsResult)
      return trackProps({ ...state.countsResult, isFetching: false, dataUpdatedAt: 1, fetchStatus: 'idle', isStale: false, refetch: () => Promise.resolve() });
    if (key[0] === 'conversation-intents') return { data: state.cachedIntents, isPending: false, isError: false, error: null };
    if (key[0] === 'conversation-contact-matches') return { data: state.cachedMatches, isPending: false, isError: false, error: null };
    return { data: undefined, isPending: false, isError: false, error: null, refetch: () => Promise.resolve() };
  },
  useInfiniteQuery: (opts: { queryKey?: unknown; enabled?: unknown; refetchInterval?: unknown; refetchOnWindowFocus?: unknown; refetchOnReconnect?: unknown }) => {
    state.infiniteQueries.push(opts);
    if (state.pagesResult)
      return trackProps({ ...state.pagesResult, isFetching: false, dataUpdatedAt: 1, fetchStatus: 'idle', isStale: false, fetchNextPage: vi.fn(), refetch: vi.fn() });
    return trackProps({
      data: undefined,
      isPending: true,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      isFetching: false,
      dataUpdatedAt: 0,
      fetchStatus: 'idle',
      isStale: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    });
  },
  useMutation: (opts: { mutationFn: (...args: unknown[]) => unknown; onSuccess?: (data?: unknown, vars?: unknown) => unknown }) => {
    state.mutations.push(opts);
    const fnText = String(opts.mutationFn);
    const isSave = fnText.includes('updateSavedReply');
    const isAutoDraft = fnText.includes('setAutoDraft');
    const isPending = isSave ? state.savePending : isAutoDraft ? state.autoDraftPending : false;
    return { mutate: vi.fn(), isPending, error: null, reset: vi.fn(), variables: undefined };
  },
}));

const { applyIntentSuggestionBatch, useCustomerAiState, useIntentSuggestions, IntentBar } = await import('../src/components/conversation-intent.tsx');
const { ContactPanel, ContactSuggestions } = await import('../src/components/conversation-contact-panel.tsx');
const { AutoDraftControl, AutoDraftSetting, IME_ESCAPE_GRACE_MS, resolveSavedReplyEscape, SavedRepliesManager, SavedRepliesPanel } = await import('../src/components/conversation-drafts.tsx');
const {
  ConversationThread,
  hasVerifySettled,
  isConversationAccessDenied,
  isThreadContentVisible,
  isVerifyWaitingOffline,
  MessageRow,
  OfflineVerifyNotice,
  POLL_MS,
  shouldMarkConversationRead,
  shouldTrimPausedPages,
  trimInfinitePagesToFirst,
  useConversationPages,
  useVerifyOnUnpause,
  verifyUpdateTotal,
} = await import('../src/components/conversation-inbox.tsx');
const { AvailabilityControl, InboxScreen, initialDeepLinkRestoreTarget, nextListRestoreStep, shouldCancelRestoreOnUserScroll, shouldCaptureMultiPageRestore, shouldClearDeferredInitialOpen } = await import('../src/components/conversation-inbox-screen.tsx');
const { SocialInboxPage } = await import('../src/routes/social-inbox.tsx');

function IntentListProbe({ enabled, trackAiOff = false }: { enabled: boolean; trackAiOff?: boolean }) {
  const { suggested, ai } = useIntentSuggestions([summary()], enabled, trackAiOff);
  return <div data-size={suggested.size} data-ai={ai ?? ''} />;
}

function PagesProbe({ enabled, paused }: { enabled: boolean; paused: boolean }) {
  const res = useConversationPages({ status: 'new', limit: 20 }, { enabled, paused });
  return <div data-loaded={String(res.loaded)} data-pending={String(res.isPending)} data-verifying={String(res.verifying)} data-count={String(res.items.length)} />;
}

function VerifyProbe({ paused, active, verifyOnMount }: { paused: boolean; active: boolean; verifyOnMount: boolean }) {
  return <div data-verifying={String(useVerifyOnUnpause(paused, () => Promise.resolve(), active, verifyOnMount))} />;
}

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">{node}</IntlProvider>);

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1',
  kind: 'direct',
  status: 'new',
  channel: { connectionId: 'ch1', provider: 'facebook', displayName: 'Shop Demo' },
  postId: null,
  contact: { identityId: 'ct1', displayName: 'Lan', idTail: '1234', partyId: null, partyName: null },
  assigneeUserId: null,
  lastSeq: 3,
  lastMessageAt: '2026-11-25T10:00:00.000Z',
  lastInboundAt: '2026-11-25T10:00:00.000Z',
  replyWindowUntil: null,
  preview: 'Xin chào',
  unread: true,
  composing: [],
  intent: null,
  ...overrides,
});

describe('Inbox AI pause and draft settings sync (#3673)', () => {
  beforeEach(() => {
    state.queries = [];
    state.infiniteQueries = [];
    state.accessedProps.clear();
    state.mutations = [];
    state.events = [];
    state.sheetOnOpenChange = null;
    state.navigate.mockReset();
    state.currentOrg = 'acme';
    state.role = 'owner';
    state.aiEnabled = true;
    state.modules = ['kernel', 'social'];
    state.search = {};
    state.savePending = false;
    state.autoDraftPending = false;
    state.autoDraftError = false;
    state.emailAddressMounts = 0;
    state.savedReplies = [{ id: 'r1', title: 'Chào', body: 'Xin chào', keywords: ['hi'], useCount: 0 }];
    state.autoDraft = { autoDraft: true };
    state.cachedIntents = undefined;
    state.cachedMatches = undefined;
    state.countsResult = undefined;
    state.pagesResult = undefined;
    state.detailError = null;
    state.detail = {
      conversation: summary(),
      messages: [],
      notes: [],
      others: [],
      draft: null,
      suggestions: [],
      parentId: null,
      gap: null,
      reply: { allowed: true, reason: null },
    };
  });

  it('clears cached intent suggestions when AI turns off', () => {
    const initial = applyIntentSuggestionBatch(new Map(), {
      ai: 'used',
      suggestions: [{ conversationId: 'c1', intent: 'order_or_price' }],
    });
    expect(initial.get('c1')).toBe('order_or_price');

    const cleared = applyIntentSuggestionBatch(initial, { ai: 'off', suggestions: [] });
    expect(cleared.size).toBe(0);

    // Keeps reference identity when already empty.
    expect(applyIntentSuggestionBatch(cleared, { ai: 'off', suggestions: [] })).toBe(cleared);
  });

  it('pauses useIntentSuggestions, IntentBar, and ContactSuggestions AI queries when paused/covered', () => {
    wrap(<IntentListProbe enabled={false} />);
    const pausedList = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(pausedList?.enabled).toBe(false);

    state.queries = [];
    wrap(<IntentListProbe enabled />);
    const liveList = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(liveList?.enabled).toBe(true);

    state.queries = [];
    wrap(<IntentBar conversation={summary()} paused />);
    const pausedIntent = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(pausedIntent?.enabled).toBe(false);

    state.queries = [];
    wrap(<IntentBar conversation={summary()} paused={false} />);
    const liveIntent = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(liveIntent?.enabled).toBe(true);

    state.queries = [];
    wrap(<ContactPanel conversationId="c1" paused onOpen={() => undefined} onErased={() => undefined} />);
    const pausedMatch = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(pausedMatch?.enabled).toBe(false);

    state.queries = [];
    wrap(<ContactPanel conversationId="c1" paused={false} onOpen={() => undefined} onErased={() => undefined} />);
    const liveMatch = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(liveMatch?.enabled).toBe(true);
  });

  it('guards AutoDraftSetting cache updates by org, clears stale AI caches on disable, and observes autoDraft once per Inbox/thread without per-message queries', async () => {
    wrap(<AutoDraftSetting isAdmin />);
    const autoDraftMut = state.mutations[0];
    expect(autoDraftMut?.onSuccess).toBeDefined();

    // Cross-org switch before resolution must not pollute the new org's cache.
    state.currentOrg = 'beta';
    await autoDraftMut?.onSuccess?.({ org: 'acme', autoDraft: false }, false);
    expect(state.events).toEqual([]);

    state.currentOrg = 'acme';
    await autoDraftMut?.onSuccess?.({ org: 'acme', autoDraft: false }, false);
    expect(state.events).toEqual([
      { kind: 'cancel', key: ['conversation-intents'] },
      { kind: 'cancel', key: ['conversation-contact-matches'] },
      { kind: 'set', key: ['conversations', 'autoDraft'], value: { autoDraft: false } },
      { kind: 'remove', key: ['conversation-intents'] },
      { kind: 'remove', key: ['conversation-contact-matches'] },
      { kind: 'invalidate', key: ['conversations', 'autoDraft'] },
      { kind: 'invalidate', key: ['conversations', 'get'] },
    ]);

    state.events = [];
    await autoDraftMut?.onSuccess?.({ org: 'acme', autoDraft: true }, true);
    expect(state.events).toEqual([
      { kind: 'cancel', key: ['conversation-intents'] },
      { kind: 'cancel', key: ['conversation-contact-matches'] },
      { kind: 'set', key: ['conversations', 'autoDraft'], value: { autoDraft: true } },
      { kind: 'invalidate', key: ['conversation-intents'] },
      { kind: 'invalidate', key: ['conversation-contact-matches'] },
      { kind: 'invalidate', key: ['conversations', 'autoDraft'] },
      { kind: 'invalidate', key: ['conversations', 'get'] },
    ]);

    // Resolved threads hide IntentBar suggestions when aiOff=true; ContactSuggestions always shows ranking attribution matching its data.
    state.cachedIntents = { ai: 'used', suggestions: [{ conversationId: 'c1', intent: 'spam' }] };
    state.cachedMatches = { ai: 'used', candidates: [{ partyId: 'p1', name: 'Lan', reason: 'email' }] };
    const resolved = summary({ status: 'resolved' });
    expect(wrap(<IntentBar conversation={resolved} aiOff={false} />)).toContain('data-testid="intent-suggested"');
    expect(wrap(<IntentBar conversation={resolved} aiOff />)).not.toContain('data-testid="intent-suggested"');
    expect(wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />)).toContain('data-testid="contact-ranked-by"');

    state.autoDraft = { autoDraft: false };
    expect(wrap(<IntentListProbe enabled trackAiOff />)).toContain('data-ai="off"');

    // InboxScreen tracks autoDraft once with refetchOnWindowFocus='always' when active, and MessageRow creates zero autoDraft observers.
    state.queries = [];
    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    const screenAutoDraft = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft');
    expect(screenAutoDraft).toHaveLength(1);
    expect(screenAutoDraft[0]?.enabled).toBe(true);
    expect(screenAutoDraft[0]?.refetchOnWindowFocus).toBe('always');

    state.queries = [];
    wrap(
      <MessageRow
        message={{
          id: 'm1',
          seq: 1,
          direction: 'in',
          authorKind: 'contact',
          authorUserId: null,
          authorName: '@lan',
          authorTail: null,
          body: 'spam',
          attachments: [],
          sentAt: '2026-11-25T10:00:00.000Z',
          sendState: null,
          sendErrorCode: null,
          hidden: false,
          hideRequest: null,
          hideErrorCode: null,
          removed: false,
        }}
        detail={state.detail}
        members={[]}
        userId="u1"
        canWrite
        contact="Lan"
        aiOff
      />,
    );
    expect(state.queries.some((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft')).toBe(false);
  });

  it('defers initial InboxScreen queries when covered on first render and stops polling while covered', () => {
    wrap(<InboxScreen search={{ settings: true }} covered onSearch={() => undefined} />);
    const listQuery = state.infiniteQueries[0];
    expect(listQuery?.enabled).toBe(false);
    expect(listQuery?.refetchInterval).toBe(false);
    const countsQuery = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'counts');
    expect(countsQuery?.enabled).toBe(false);
    expect(countsQuery?.refetchInterval).toBe(false);
    const channelQueries = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'channels' && q.queryKey[1] === 'list');
    expect(channelQueries).toHaveLength(2);
    for (const cq of channelQueries) expect(cq.enabled).toBe(false);
    // Detail, tasks, and EmailAddressCard stay deferred behind the settings drawer even when ?c=...&settings=true is opened directly.
    state.queries = [];
    state.infiniteQueries = [];
    state.accessedProps.clear();
    wrap(<InboxScreen search={{ c: 'c1', settings: true }} covered onSearch={() => undefined} />);
    expect(state.queries.some((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get')).toBe(false);
    expect(state.queries.some((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'tasks')).toBe(false);
    expect(state.emailAddressMounts).toBe(0);

    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    expect(state.emailAddressMounts).toBe(1);

    state.queries = [];
    wrap(<ConversationThread conversationId="c1" paused onGone={() => undefined} />);
    const pausedDetail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get');
    expect(pausedDetail?.enabled).toBe(false);
    expect(pausedDetail?.refetchInterval).toBe(false);

    state.queries = [];
    wrap(<ConversationThread conversationId="c1" paused={false} onGone={() => undefined} />);
    const liveDetail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get');
    expect(liveDetail?.enabled).toBe(true);
    expect(liveDetail?.refetchInterval).toBe(POLL_MS);

    state.queries = [];
    const pausedPanelHtml = wrap(<ContactPanel conversationId="c1" paused onOpen={() => undefined} onErased={() => undefined} />);
    const pausedPanelDetail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get');
    const pausedTasks = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'tasks');
    expect(pausedPanelDetail?.enabled).toBe(false);
    expect(pausedPanelDetail?.refetchInterval).toBe(false);
    expect(pausedTasks?.enabled).toBe(false);
    expect(pausedTasks?.refetchInterval).toBe(false);
    expect(pausedPanelHtml).toContain('data-testid="conversation-tasks"');
    expect(pausedPanelHtml).not.toContain('data-testid="conversation-send-to-triage-btn"');

    state.queries = [];
    wrap(<ContactPanel conversationId="c1" paused={false} onOpen={() => undefined} onErased={() => undefined} />);
    const livePanelDetail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get');
    const liveTasks = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'tasks');
    expect(livePanelDetail?.enabled).toBe(true);
    expect(livePanelDetail?.refetchInterval).toBe(POLL_MS);
    expect(liveTasks?.enabled).toBe(true);
    expect(liveTasks?.refetchInterval).toBe(POLL_MS);
  });

  it('allows closing the Settings drawer even when saving or toggling auto-draft is pending/offline while preserving draft and errors for reopen', () => {
    state.search = { settings: true };
    state.savePending = true;
    wrap(<SocialInboxPage />);
    state.sheetOnOpenChange?.(false);
    expect(state.navigate).toHaveBeenCalledTimes(1);

    state.savePending = false;
    state.autoDraftPending = true;
    wrap(<SocialInboxPage />);
    state.sheetOnOpenChange?.(false);
    expect(state.navigate).toHaveBeenCalledTimes(2);

    const preservedHtml = wrap(
      <SavedRepliesPanel
        canWrite
        state={{
          editing: { id: 'r1', title: 'Bản nháp giữ lại', body: 'Nội dung còn nguyên', keywords: 'chào' },
          setEditing: vi.fn(),
          editSessionRef: { current: 1 },
          editingKindRef: { current: 'edit' },
          returnReplyIdRef: { current: 'r1' },
          save: { mutate: vi.fn(), isPending: false, error: new Error('Lỗi mạng tạm thời'), reset: vi.fn() } as never,
          remove: { mutate: vi.fn(), isPending: false, error: null, reset: vi.fn(), variables: undefined } as never,
        }}
      />,
    );
    expect(preservedHtml).toContain('value="Bản nháp giữ lại"');
    expect(preservedHtml).toContain('Nội dung còn nguyên');
    expect(preservedHtml).toContain('Lỗi mạng tạm thời');

    const preservedAutoDraftHtml = wrap(
      <AutoDraftControl
        isAdmin
        set={{ mutate: vi.fn(), isPending: false, error: new Error('Tắt tự soạn nháp thất bại'), reset: vi.fn() } as never}
      />,
    );
    expect(preservedAutoDraftHtml).toContain('Tắt tự soạn nháp thất bại');
    const preservedPendingHtml = wrap(
      <SavedRepliesPanel
        canWrite
        state={{
          editing: { id: 'r1', title: 'Đang lưu', body: 'Không bị sửa khi đang gửi', keywords: 'chào' },
          setEditing: vi.fn(),
          editSessionRef: { current: 1 },
          editingKindRef: { current: 'edit' },
          returnReplyIdRef: { current: 'r1' },
          save: { mutate: vi.fn(), isPending: true, error: null, reset: vi.fn() } as never,
          remove: { mutate: vi.fn(), isPending: false, error: null, reset: vi.fn(), variables: undefined } as never,
        }}
      />,
    );
    expect(preservedPendingHtml).toMatch(/id="saved-title"[^>]*readOnly=""/i);
    expect(preservedPendingHtml).toMatch(/id="saved-body"[^>]*readOnly=""/i);
    expect(preservedPendingHtml).toMatch(/id="saved-keywords"[^>]*readOnly=""/i);

    const deletingEditedHtml = wrap(
      <SavedRepliesPanel
        canWrite
        state={{
          editing: { id: 'r1', title: 'Đang xóa', body: 'Không được lưu khi đang xóa', keywords: '' },
          setEditing: vi.fn(),
          editSessionRef: { current: 1 },
          editingKindRef: { current: 'edit' },
          returnReplyIdRef: { current: 'r1' },
          save: { mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() } as never,
          remove: { mutate: vi.fn(), isPending: true, error: null, reset: vi.fn(), variables: 'r1' } as never,
        }}
      />,
    );
    expect(deletingEditedHtml).toMatch(/id="saved-title"[^>]*readOnly=""/i);
    expect(deletingEditedHtml).toMatch(/id="saved-body"[^>]*readOnly=""/i);
    expect(deletingEditedHtml).toMatch(/data-testid="saved-reply-save"[^>]*disabled=""|disabled=""[^>]*data-testid="saved-reply-save"/);
  });

  it('handles IME compositionend timing and saving-state Escape bubbling in saved-reply form', () => {
    expect(resolveSavedReplyEscape({ isComposing: true, nowMs: 1_000, lastCompositionEndMs: -Infinity, savePending: false })).toBe('ignore_ime');
    // Safari fires compositionend just before the Escape keydown that closed the IME popup.
    expect(resolveSavedReplyEscape({ isComposing: false, nowMs: 1_020, lastCompositionEndMs: 1_000, savePending: false })).toBe('ignore_ime');
    expect(resolveSavedReplyEscape({ isComposing: false, nowMs: 1_000 + IME_ESCAPE_GRACE_MS, lastCompositionEndMs: 1_000, savePending: false })).toBe('cancel_form');
    // While save is pending, Escape must bubble to close the outer Sheet instead of being swallowed.
    expect(resolveSavedReplyEscape({ isComposing: false, nowMs: 2_000, lastCompositionEndMs: -Infinity, savePending: true })).toBe('bubble_to_sheet');
    expect(resolveSavedReplyEscape({ isComposing: false, nowMs: 2_000, lastCompositionEndMs: -Infinity, savePending: false })).toBe('cancel_form');
  });

  it('disables saved-reply row Edit, Delete, and Add actions while a save mutation is pending', () => {
    state.savePending = true;
    const html = wrap(<SavedRepliesManager canWrite />);
    expect(html).toMatch(/disabled=""[^>]*>Sửa</);
    expect(html).toMatch(/disabled=""[^>]*>Xóa</);
    expect(html).toMatch(/data-testid="saved-reply-add"[^>]*disabled=""|disabled=""[^>]*data-testid="saved-reply-add"/);
  });

  it('keeps warm cached inbox pages, counts, and open thread hidden while covered on ?settings=true', () => {
    const warm = summary({
      id: 'c-warm',
      contact: { identityId: 'ct-warm', displayName: 'Khách hàng Warm Cache', idTail: '9999', partyId: null, partyName: null },
      preview: 'Tin nhắn cũ cần xác minh',
    });
    state.pagesResult = {
      data: { pages: [{ conversations: [warm], more: true }] },
      isPending: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    };
    state.countsResult = {
      data: { new: 713, in_progress: 0, resolved: 0, spam: 0 },
      isPending: false,
      isError: false,
      error: null,
    };

    const probeHtml = wrap(<PagesProbe enabled={false} paused />);
    expect(probeHtml).toContain('data-loaded="false"');
    expect(probeHtml).toContain('data-pending="true"');

    const screenHtml = wrap(<InboxScreen search={{ settings: true }} covered onSearch={() => undefined} />);
    expect(screenHtml).not.toContain('Khách hàng Warm Cache');
    expect(screenHtml).not.toContain('713');
    expect(screenHtml).not.toContain('data-testid="conversation-more"');
    expect(state.queries.some((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'get')).toBe(false);
  });

  it('preserves loaded rows on fetchNextPage errors while hiding stale rows and counts on refetch errors', () => {
    const warm = summary({
      id: 'c-warm',
      contact: { identityId: 'ct-warm', displayName: 'Khách hàng Warm Cache', idTail: '9999', partyId: null, partyName: null },
      preview: 'Tin nhắn cũ cần xác minh',
    });

    state.pagesResult = {
      data: { pages: [{ conversations: [warm], more: true }] },
      isPending: false,
      error: new Error('Load older failed'),
      hasNextPage: true,
      isFetchingNextPage: false,
      isFetchNextPageError: true,
    };
    state.countsResult = {
      data: { new: 713, in_progress: 0, resolved: 0, spam: 0 },
      isPending: false,
      isError: true,
      error: new Error('Counts refetch failed'),
    };

    const loadOlderErrorHtml = wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    expect(loadOlderErrorHtml).toContain('Khách hàng Warm Cache');
    expect(loadOlderErrorHtml).toContain('data-testid="conversation-more"');
    expect(loadOlderErrorHtml).toContain(catalog('vi').conversations.loadOlderFailed);
    expect(loadOlderErrorHtml).not.toContain('data-testid="inbox-list-error"');
    // Stale counts from a failed refetch stay hidden.
    expect(loadOlderErrorHtml).not.toContain('713');

    state.pagesResult = {
      ...state.pagesResult,
      error: new Error('Refetch failed'),
      isFetchNextPageError: false,
    };
    const refetchErrorHtml = wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    expect(refetchErrorHtml).toContain('data-testid="inbox-list-error"');
    expect(refetchErrorHtml).not.toContain('Khách hàng Warm Cache');
    expect(refetchErrorHtml).not.toContain('data-testid="conversation-more"');
  });

  it('verifies cached thread and contact panel on mount when deferred behind settings', () => {
    expect(wrap(<VerifyProbe paused={false} active verifyOnMount />)).toContain('data-verifying="true"');
    expect(wrap(<VerifyProbe paused={false} active verifyOnMount={false} />)).toContain('data-verifying="false"');
    expect(wrap(<VerifyProbe paused active verifyOnMount />)).toContain('data-verifying="false"');

    const threadHtml = wrap(<ConversationThread conversationId="c1" verifyOnMount onGone={() => undefined} />);
    expect(threadHtml).toMatch(/class="hidden"[^>]*data-testid="conversation-thread"/);
    expect(threadHtml).toContain('data-testid="thread-skeleton"');

    const panelHtml = wrap(<ContactPanel conversationId="c1" verifyOnMount onOpen={() => undefined} onErased={() => undefined} />);
    expect(panelHtml).toMatch(/class="hidden"[^>]*data-testid="contact-panel"/);
    expect(panelHtml).toContain('data-testid="panel-skeleton"');
  });

  it('disables autoDraft queries for read-only viewers and when system AI is off', () => {
    state.role = 'viewer';
    state.aiEnabled = true;
    state.queries = [];
    wrap(<ConversationThread conversationId="c1" onGone={() => undefined} />);
    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    const viewerAutoDraft = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft');
    expect(viewerAutoDraft.length).toBeGreaterThanOrEqual(2);
    for (const q of viewerAutoDraft) {
      expect(q.enabled).toBe(false);
      expect(q.refetchOnWindowFocus).toBe(false);
    }

    state.role = 'owner';
    state.aiEnabled = false;
    state.queries = [];
    wrap(<ConversationThread conversationId="c1" onGone={() => undefined} />);
    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    const systemOffAutoDraft = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft');
    expect(systemOffAutoDraft.length).toBeGreaterThanOrEqual(2);
    for (const q of systemOffAutoDraft) {
      expect(q.enabled).toBe(false);
      expect(q.refetchOnWindowFocus).toBe(false);
    }

    // Opening InboxSettingsDrawer when system AI is off unmounts AutoDraftControl and leaves zero enabled autoDraft queries;
    // direct AutoDraftSetting also keeps its query disabled.
    state.search = { settings: true };
    state.queries = [];
    const drawerHtml = wrap(<SocialInboxPage />);
    expect(drawerHtml).not.toContain('data-testid="auto-draft"');
    const drawerAutoDraft = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft');
    for (const q of drawerAutoDraft) expect(q.enabled).toBe(false);

    state.queries = [];
    expect(wrap(<AutoDraftSetting isAdmin />)).toBe('');
    const directAutoDraft = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'autoDraft');
    expect(directAutoDraft?.enabled).toBe(false);
  });

  it('keeps verifying active across cancelled or in-flight replacement fetches and blocks markRead on thread errors', () => {
    expect(verifyUpdateTotal(undefined)).toBeNull();
    // QueryObserverResult has errorUpdateCount but omits dataUpdateCount: never return 0 without dataUpdateCount.
    expect(verifyUpdateTotal({ errorUpdateCount: 0 })).toBeNull();
    expect(verifyUpdateTotal({ dataUpdateCount: 2, errorUpdateCount: 1 })).toBe(3);

    // Cancelled refetch while replacement invalidateQueries fetch is still running.
    expect(hasVerifySettled({ state: { isFetching: true, dataUpdateCount: 2, errorUpdateCount: 0 }, minUpdates: 2, refetchSettled: true })).toBe(false);
    // Reverted cancellation before any server update or error landed.
    expect(hasVerifySettled({ state: { isFetching: false, dataUpdateCount: 1, errorUpdateCount: 0 }, minUpdates: 2, refetchSettled: true })).toBe(false);
    // Even if cancelling an in-flight pre-pause fetch bumped errorUpdateCount, wait until the new refetch settles.
    expect(hasVerifySettled({ state: { isFetching: false, dataUpdateCount: 0, errorUpdateCount: 1 }, minUpdates: 1, refetchSettled: false })).toBe(false);
    // Settled after the post-unpause refetch completes with fresh data or error.
    expect(hasVerifySettled({ state: { isFetching: false, dataUpdateCount: 2, errorUpdateCount: 0 }, minUpdates: 2, refetchSettled: true })).toBe(true);
    expect(hasVerifySettled({ state: { isFetching: false, dataUpdateCount: 1, errorUpdateCount: 1 }, minUpdates: 2, refetchSettled: true })).toBe(true);

    // Failed refetch with cached detail.data shows PaneError and must never mark the thread read.
    expect(isThreadContentVisible({ paused: false, verifyingAccess: false, isPending: false, error: new Error('500'), hasData: true })).toBe(false);
    expect(isThreadContentVisible({ paused: true, verifyingAccess: false, isPending: false, error: null, hasData: true })).toBe(false);
    expect(isThreadContentVisible({ paused: false, verifyingAccess: true, isPending: false, error: null, hasData: true })).toBe(false);
    expect(isThreadContentVisible({ paused: false, verifyingAccess: false, isPending: false, error: null, hasData: true })).toBe(true);
  });

  it('trims multi-page inbox caches down to page 1 for unpause verification and ?settings=true returns', () => {
    expect(shouldTrimPausedPages(true, false, 3)).toBe(true);
    expect(shouldTrimPausedPages(true, true, 3)).toBe(true);
    expect(shouldTrimPausedPages(false, true, 3)).toBe(false);
    expect(shouldTrimPausedPages(true, false, 1)).toBe(false);

    const multi = trimInfinitePagesToFirst({ pages: ['p1', 'p2', 'p3'], pageParams: [undefined, 'c1', 'c2'] });
    expect(multi.trimmed).toBe(true);
    expect(multi.next).toEqual({ pages: ['p1'], pageParams: [undefined] });

    const single = trimInfinitePagesToFirst({ pages: ['p1'], pageParams: [undefined] });
    expect(single.trimmed).toBe(false);
    expect(single.next).toEqual({ pages: ['p1'], pageParams: [undefined] });
  });

  it('keys ContactSuggestions by AI state and bases ranking attribution on matches.data.ai', () => {
    state.cachedMatches = { ai: 'used', candidates: [{ partyId: 'p1', name: 'Lan', reason: 'name' }] };

    state.autoDraft = { autoDraft: true };
    state.aiEnabled = true;
    state.queries = [];
    const onHtml = wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    const onQuery = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(onQuery?.queryKey).toEqual(['conversation-contact-matches', 'c1', 3, 'on']);
    expect(onHtml).toContain('Lan');
    expect(onHtml).toContain('data-testid="contact-ranked-by"');

    // When the server response carries ai: 'used' (e.g. enabled in another tab), attribution still reflects matches.data.ai.
    state.autoDraft = { autoDraft: false };
    state.queries = [];
    const staleLocalHtml = wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    const orgOffQuery = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(orgOffQuery?.queryKey).toEqual(['conversation-contact-matches', 'c1', 3, 'off']);
    expect(staleLocalHtml).toContain('Lan');
    expect(staleLocalHtml).toContain('data-testid="contact-ranked-by"');

    // Org autoDraft off with deterministic server fallback (`ai: 'off'`): keep candidates and hide AI ranking badge.
    state.cachedMatches = { ai: 'off', candidates: [{ partyId: 'p1', name: 'Lan', reason: 'name' }] };
    state.queries = [];
    const orgOffHtml = wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    expect(orgOffHtml).toContain('Lan');
    expect(orgOffHtml).not.toContain('data-testid="contact-ranked-by"');

    // Deployment AI off: same deterministic fallback without AI ranking badge.
    state.autoDraft = { autoDraft: true };
    state.aiEnabled = false;
    state.queries = [];
    const sysOffHtml = wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    const sysOffQuery = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(sysOffQuery?.queryKey).toEqual(['conversation-contact-matches', 'c1', 3, 'off']);
    expect(sysOffHtml).toContain('Lan');
    expect(sysOffHtml).not.toContain('data-testid="contact-ranked-by"');
  });

  it('does not subscribe to volatile polling fields (isFetching, dataUpdatedAt, fetchStatus) during normal renders', () => {
    state.pagesResult = {
      data: { pages: [{ conversations: [summary()], more: false }] },
      isPending: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    };
    state.countsResult = {
      data: { new: 1, in_progress: 0, resolved: 0, spam: 0 },
      isPending: false,
      isError: false,
      error: null,
    };
    state.accessedProps.clear();

    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    wrap(<ConversationThread conversationId="c1" onGone={() => undefined} />);
    wrap(<ContactPanel conversationId="c1" onOpen={() => undefined} onErased={() => undefined} />);

    for (const volatileProp of ['isFetching', 'isRefetching', 'dataUpdatedAt', 'errorUpdatedAt', 'fetchStatus', 'isStale']) {
      expect(state.accessedProps.has(volatileProp)).toBe(false);
    }
  });

  it('gates InboxScreen useIntentSuggestions on listReady so refetch failures or unactivated lists do not call suggestIntents', () => {
    state.pagesResult = {
      data: { pages: [{ conversations: [summary({ id: 'c-stale' })], more: false }] },
      isPending: false,
      error: new Error('Refetch failed'),
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    };
    state.queries = [];
    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    const failedListIntents = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(failedListIntents?.enabled).toBe(false);

    state.pagesResult = {
      ...state.pagesResult,
      error: null,
    };
    state.queries = [];
    wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    const readyListIntents = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(readyListIntents?.enabled).toBe(true);
  });

  it('disables list automatic refetches (enabled, window focus, reconnect, interval) while covered even after initial load', () => {
    state.pagesResult = {
      data: { pages: [{ conversations: [summary()], more: false }] },
      isPending: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    };
    state.infiniteQueries = [];
    wrap(<PagesProbe enabled paused />);
    expect(state.infiniteQueries[0]?.enabled).toBe(false);
    expect(state.infiniteQueries[0]?.refetchInterval).toBe(false);
    expect(state.infiniteQueries[0]?.refetchOnWindowFocus).toBe(false);
    expect(state.infiniteQueries[0]?.refetchOnReconnect).toBe(false);

    state.infiniteQueries = [];
    wrap(<PagesProbe enabled paused={false} />);
    expect(state.infiniteQueries[0]?.enabled).toBe(true);
    expect(state.infiniteQueries[0]?.refetchInterval).toBe(POLL_MS);
    expect(state.infiniteQueries[0]?.refetchOnWindowFocus).toBe(true);
    expect(state.infiniteQueries[0]?.refetchOnReconnect).toBe(true);
  });

  it('waits while org autoDraft setting is pending before querying suggestIntents or ContactSuggestions', () => {
    function AiStateProbe({ enabled }: { enabled: boolean }) {
      return <div data-ai-state={useCustomerAiState(enabled)} />;
    }

    state.aiEnabled = true;
    state.autoDraft = undefined;
    expect(wrap(<AiStateProbe enabled />)).toContain('data-ai-state="pending"');
    expect(wrap(<AiStateProbe enabled={false} />)).toContain('data-ai-state="on"');

    // While autoDraft has not resolved yet, neither list intents, ContactSuggestions, nor thread IntentBar fire calls.
    state.queries = [];
    wrap(<IntentListProbe enabled trackAiOff />);
    const pendingListIntents = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(pendingListIntents?.enabled).toBe(false);

    state.queries = [];
    wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    const pendingContact = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(pendingContact?.enabled).toBe(false);

    state.queries = [];
    wrap(<ConversationThread conversationId="c1" onGone={() => undefined} />);
    const pendingThreadIntent = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-intents');
    expect(pendingThreadIntent?.enabled).toBe(false);

    // Once autoDraft settles to false, ContactSuggestions runs once with key 'off' (keeping deterministic matches without AI badge).
    state.autoDraft = { autoDraft: false };
    state.cachedMatches = { ai: 'off', candidates: [{ partyId: 'p1', name: 'Lan', reason: 'phone' }] };
    state.queries = [];
    const settledOffHtml = wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />);
    const settledOffQuery = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-contact-matches');
    expect(settledOffQuery?.enabled).toBe(true);
    expect(settledOffQuery?.queryKey).toEqual(['conversation-contact-matches', 'c1', 3, 'off']);
    expect(settledOffHtml).toContain('Lan');
    expect(settledOffHtml).not.toContain('data-testid="contact-ranked-by"');
  });

  it('unmounts private messages and contact PII behind PaneError while preserving ReplyBox on transient error and removing all content on access denial', () => {
    state.modules = ['kernel', 'social', 'projects'];
    state.detail = {
      ...state.detail,
      messages: [
        {
          id: 'm1',
          seq: 1,
          direction: 'in',
          authorKind: 'contact',
          authorUserId: null,
          authorName: 'Lan',
          authorTail: null,
          body: 'Tin nhắn riêng tư cần bảo vệ',
          attachments: [],
          sentAt: '2026-11-25T10:00:00.000Z',
          sendState: null,
          sendErrorCode: null,
          hidden: false,
          hideRequest: null,
          hideErrorCode: null,
          removed: false,
        },
      ],
    };
    const okThreadHtml = wrap(<ConversationThread conversationId="c1" showErase onGone={() => undefined} />);
    const okPanelHtml = wrap(<ContactPanel conversationId="c1" onOpen={() => undefined} onErased={() => undefined} />);
    expect(okThreadHtml).toContain('Tin nhắn riêng tư cần bảo vệ');
    expect(okThreadHtml).toContain('data-testid="conversation-personal-data"');
    expect(okPanelHtml).toContain('data-testid="contact-name"');
    expect(okPanelHtml).toContain('data-testid="conversation-personal-data"');
    expect(okPanelHtml).toContain('data-testid="conversation-send-to-triage-btn"');

    // Transient server error (e.g. 500): unmount messages, contact info, and child dialogs completely from DOM while preserving ReplyBox and Tasks.
    state.detailError = new Error('500');
    const threadHtml = wrap(<ConversationThread conversationId="c1" showErase onGone={() => undefined} />);
    expect(threadHtml).toContain('data-testid="thread-error"');
    expect(threadHtml).toContain('class="hidden" data-testid="conversation-thread"');
    expect(threadHtml).toContain('data-testid="conversation-reply-text"');
    expect(threadHtml).not.toContain('Tin nhắn riêng tư cần bảo vệ');
    expect(threadHtml).not.toContain('Lan');
    expect(threadHtml).not.toContain('data-testid="conversation-personal-data"');

    const panelHtml = wrap(<ContactPanel conversationId="c1" onOpen={() => undefined} onErased={() => undefined} />);
    expect(panelHtml).toContain('data-testid="panel-error"');
    expect(panelHtml).toContain('data-testid="contact-panel"');
    expect(panelHtml).toMatch(/<aside[^>]*class="hidden"[^>]*data-testid="contact-panel"/);
    expect(panelHtml).toContain('data-testid="conversation-tasks"');
    expect(panelHtml).not.toContain('data-testid="contact-name"');
    expect(panelHtml).not.toContain('Lan');
    expect(panelHtml).not.toContain('data-testid="conversation-personal-data"');
    expect(panelHtml).not.toContain('data-testid="conversation-send-to-triage-btn"');

    // Access denied (CONVERSATION_NOT_FOUND / FORBIDDEN / 403 / 404): remove everything including ReplyBox and Tasks, leaving only PaneError.
    state.detailError = Object.assign(new Error('Không có quyền'), { code: 'FORBIDDEN', status: 403 });
    const deniedThreadHtml = wrap(<ConversationThread conversationId="c1" showErase onGone={() => undefined} />);
    expect(deniedThreadHtml).toContain('data-testid="thread-error"');
    expect(deniedThreadHtml).not.toContain('data-testid="conversation-reply-text"');
    expect(deniedThreadHtml).not.toContain('Tin nhắn riêng tư cần bảo vệ');

    const deniedPanelHtml = wrap(<ContactPanel conversationId="c1" onOpen={() => undefined} onErased={() => undefined} />);
    expect(deniedPanelHtml).toContain('data-testid="panel-error"');
    expect(deniedPanelHtml).not.toContain('data-testid="conversation-tasks"');
    expect(deniedPanelHtml).not.toContain('data-testid="contact-name"');
  });

  it('defers AvailabilityControl query behind ?settings=true and skips it for read-only viewers', () => {
    state.search = { settings: true };
    state.role = 'owner';
    state.queries = [];
    wrap(<SocialInboxPage />);
    const coveredAvail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'availability');
    expect(coveredAvail?.enabled).toBe(false);

    state.search = {};
    state.role = 'viewer';
    state.queries = [];
    wrap(<SocialInboxPage />);
    const viewerAvail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'availability');
    expect(viewerAvail?.enabled).toBe(false);

    state.search = {};
    state.role = 'owner';
    state.queries = [];
    wrap(<SocialInboxPage />);
    const liveAvail = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'availability');
    expect(liveAvail?.enabled).toBe(true);
  });

  it('keeps deferred initial verify flag on narrow screens until reading pane mounts and avoids duplicate markRead calls on Settings close', () => {
    // Narrow screen (?settings=true without ?c=): list resolves with openId='c1', but showReading is false until the user taps a thread.
    expect(
      shouldClearDeferredInitialOpen({
        covered: false,
        activated: true,
        deferredInitialOpen: true,
        openId: 'c1',
        listReady: true,
        showReading: false,
      }),
    ).toBe(false);

    // Once the reading pane mounts (tapped on phone, or desktop split view), clear the initial flag.
    expect(
      shouldClearDeferredInitialOpen({
        covered: false,
        activated: true,
        deferredInitialOpen: true,
        openId: 'c1',
        listReady: true,
        showReading: true,
      }),
    ).toBe(true);

    // Empty initial list clears once listReady settles with no thread to verify.
    expect(
      shouldClearDeferredInitialOpen({
        covered: false,
        activated: true,
        deferredInitialOpen: true,
        openId: null,
        listReady: true,
        showReading: false,
      }),
    ).toBe(true);

    // markRead runs once on first read (lastMarkedSeq === null, inFlightSeq === null), skips redundant writes while inFlight or already
    // committed at the same seq, retries after a failure clears inFlightSeq, and runs again once "Đã xem" advances seen.
    expect(shouldMarkConversationRead({ threadVisible: true, unread: true, seen: 3, lastMarkedSeq: null, inFlightSeq: null })).toBe(true);
    expect(shouldMarkConversationRead({ threadVisible: true, unread: true, seen: 3, lastMarkedSeq: null, inFlightSeq: 3 })).toBe(false);
    expect(shouldMarkConversationRead({ threadVisible: true, unread: true, seen: 3, lastMarkedSeq: 3, inFlightSeq: null })).toBe(false);
    expect(shouldMarkConversationRead({ threadVisible: true, unread: true, seen: 4, lastMarkedSeq: null, inFlightSeq: 3 })).toBe(true);
    expect(shouldMarkConversationRead({ threadVisible: true, unread: true, seen: 4, lastMarkedSeq: 3, inFlightSeq: null })).toBe(true);
    expect(shouldMarkConversationRead({ threadVisible: false, unread: true, seen: 4, lastMarkedSeq: 3, inFlightSeq: null })).toBe(false);
  });

  it('masks private content behind skeletons, pauses Quote/Followup CRM queries while retaining pending insert state, and restores scrolled multi-page anchor', () => {
    const pausedThreadHtml = wrap(<ConversationThread conversationId="c1" paused showErase onGone={() => undefined} />);
    expect(pausedThreadHtml).toContain('data-testid="thread-skeleton"');
    expect(pausedThreadHtml).toContain('class="hidden" data-testid="conversation-thread"');
    expect(pausedThreadHtml).toContain('data-testid="conversation-reply-text"');
    expect(pausedThreadHtml).not.toContain('data-testid="conversation-personal-data"');

    // Linked contact with reply allowed: live panel queries crm.quotes.list & crm.nextSteps.list (enabled: true);
    // paused/errored panel keeps QuoteReplyInsert/FollowupReplyInsert mounted (preserving pending insert clicks) with queries paused (enabled: false).
    state.detail = {
      ...state.detail,
      conversation: summary({ contact: { identityId: 'ct1', displayName: 'Lan', idTail: '1234', partyId: 'p1', partyName: 'Lan' } }),
    };
    state.queries = [];
    wrap(<ContactPanel conversationId="c1" paused={false} onOpen={() => undefined} onErased={() => undefined} />);
    const liveQuotes = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'crm' && q.queryKey[1] === 'quotes');
    const liveSteps = state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'crm' && q.queryKey[1] === 'nextSteps');
    expect(liveQuotes?.enabled).toBe(true);
    expect(liveSteps?.enabled).toBe(true);

    state.queries = [];
    const pausedPanelHtml = wrap(<ContactPanel conversationId="c1" paused onOpen={() => undefined} onErased={() => undefined} />);
    expect(pausedPanelHtml).toContain('data-testid="panel-skeleton"');
    expect(pausedPanelHtml).toMatch(/<aside[^>]*class="hidden"[^>]*data-testid="contact-panel"/);
    expect(pausedPanelHtml).toContain('data-testid="conversation-tasks"');
    expect(pausedPanelHtml).not.toContain('data-testid="conversation-personal-data"');
    const pausedCrm = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'crm');
    expect(pausedCrm).toHaveLength(2);
    for (const q of pausedCrm) expect(q.enabled).toBe(false);

    state.detailError = new Error('500');
    state.queries = [];
    wrap(<ContactPanel conversationId="c1" paused={false} onOpen={() => undefined} onErased={() => undefined} />);
    const erroredCrm = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'crm');
    expect(erroredCrm).toHaveLength(2);
    for (const q of erroredCrm) expect(q.enabled).toBe(false);

    // Single-page list restore after Settings closes
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: false,
        loadingMore: false,
        loadFailed: false,
        target: null,
        wasHidden: true,
        savedScrollTop: 420,
      }),
    ).toBe('restore_scroll');

    // Multi-page scrolled anchor ('c55' on page 2, even while 'c1' stays selected on page 1) loads older pages until 'c55' arrives
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: 'c55', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 3100,
      }),
    ).toBe('load_more');
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: true,
        loadingMore: true,
        loadFailed: false,
        target: { anchorId: 'c55', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 3100,
      }),
    ).toBe('none');
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c55'],
        pageCount: 2,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: 'c55', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 3100,
      }),
    ).toBe('restore_scroll');
    // Multi-page list scrolled back to top skips extra-page recovery; scrolled-down narrow (< xl) window reloads minPages
    expect(
      shouldCaptureMultiPageRestore({
        wasHidden: false,
        hideList: true,
        prevPageCount: 3,
        hasTarget: false,
        hasAnchor: false,
        containerScrollTop: 0,
        windowScrollY: 0,
      }),
    ).toBe(false);
    expect(
      shouldCaptureMultiPageRestore({
        wasHidden: false,
        hideList: true,
        prevPageCount: 3,
        hasTarget: false,
        hasAnchor: false,
        containerScrollTop: 0,
        windowScrollY: 640,
      }),
    ).toBe(true);
    expect(
      shouldCaptureMultiPageRestore({
        wasHidden: false,
        hideList: true,
        prevPageCount: 2,
        hasTarget: false,
        hasAnchor: true,
        containerScrollTop: 420,
        windowScrollY: 0,
      }),
    ).toBe(true);
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: null, minPages: 2 },
        wasHidden: true,
        savedScrollTop: 640,
      }),
    ).toBe('load_more');
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 2,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: null, minPages: 2 },
        wasHidden: false,
        savedScrollTop: 640,
      }),
    ).toBe('restore_scroll');
    // If anchor moved/resolved or loadMore fails, still stops paging and restores scroll safely
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: true,
        loadingMore: false,
        loadFailed: true,
        target: { anchorId: 'c55', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 3100,
      }),
    ).toBe('restore_scroll');
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: false,
        loadingMore: false,
        loadFailed: false,
        target: null,
        wasHidden: false,
        savedScrollTop: 420,
      }),
    ).toBe('none');

    // Anchor row ('c18') found near bottom of page 1 without enough viewport room below it still loads page 2 when pageCount < minPages
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c18'],
        pageCount: 1,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: 'c18', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 1800,
        hasRoomBelowAnchor: false,
      }),
    ).toBe('load_more');
    expect(
      nextListRestoreStep({
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c18', 'c25'],
        pageCount: 2,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: 'c18', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 1800,
        hasRoomBelowAnchor: true,
      }),
    ).toBe('restore_scroll');

    // Offline verification: paused fetchStatus or offline browser renders OfflineVerifyNotice cleanly (ignoring SSR navigator.onLine === undefined)
    expect(isVerifyWaitingOffline('paused', true)).toBe(true);
    expect(isVerifyWaitingOffline('fetching', false)).toBe(true);
    expect(isVerifyWaitingOffline('fetching', undefined)).toBe(false);
    expect(isVerifyWaitingOffline('fetching', true)).toBe(false);
    const offlineHtml = wrap(<OfflineVerifyNotice testId="thread-offline" />);
    expect(offlineHtml).toContain('data-testid="thread-offline"');
    expect(offlineHtml).toContain('Đang chờ kết nối mạng');

    // On mobile (< xl) while viewing a conversation (?c=...&settings=true), closing Settings while showList is false holds off loadMore and restore until showList becomes true
    expect(
      nextListRestoreStep({
        showList: false,
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: true,
        loadingMore: false,
        loadFailed: false,
        target: { anchorId: 'c20', minPages: 2 },
        wasHidden: false,
        savedScrollTop: 1800,
      }),
    ).toBe('none');
    expect(
      nextListRestoreStep({
        showList: false,
        hideList: false,
        listRefetchFailed: false,
        loaded: true,
        itemIds: ['c1', 'c2'],
        pageCount: 1,
        hasMore: false,
        loadingMore: false,
        loadFailed: false,
        target: null,
        wasHidden: true,
        savedScrollTop: 640,
      }),
    ).toBe('none');

    // MessageImage query inside MessageRow stays disabled while imageEnabled is false (paused/verifying thread) and enables once verified
    const imageDetail: ConversationDetail = {
      conversation: {
        id: 'conv-img',
        kind: 'direct',
        status: 'new',
        unread: false,
        lastSeq: 1,
        lastMessageAt: '2026-11-25T10:00:00.000Z',
        lastInboundAt: '2026-11-25T10:00:00.000Z',
        replyWindowUntil: null,
        preview: 'Ảnh đính kèm',
        postId: null,
        assigneeUserId: null,
        channel: { connectionId: 'ch-1', provider: 'facebook_page', displayName: 'Page' },
        contact: { identityId: 'ct-1', displayName: 'Lan', idTail: 'ct-1', partyId: null, partyName: null, address: null },
        senderUnverified: false,
        subject: null,
        intent: null,
        composing: [],
      },
      messages: [],
      notes: [],
      parentId: null,
      reply: { allowed: true, reason: null },
      gap: null,
      draft: null,
      suggestions: [],
      others: [],
      hideAllowed: false,
    };
    const imageMsg: ConversationMessage = {
      id: 'm-img',
      seq: 1,
      direction: 'in',
      authorKind: 'contact',
      authorUserId: null,
      authorName: 'Lan',
      authorTail: null,
      body: 'Ảnh đính kèm',
      sentAt: '2026-11-25T10:00:00.000Z',
      sendState: 'sent',
      sendErrorCode: null,
      removed: false,
      hidden: false,
      hideRequest: null,
      hideErrorCode: null,
      privateReplyConversationId: null,
      attachments: [{ id: 'att-img-1', contentType: 'image/png', width: 120, height: 80 }],
    };
    state.queries = [];
    wrap(<MessageRow message={imageMsg} detail={imageDetail} members={[]} userId="u1" canWrite={false} contact="Lan" imageEnabled={false} />);
    expect(state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-image')?.enabled).toBe(false);

    state.queries = [];
    wrap(<MessageRow message={imageMsg} detail={imageDetail} members={[]} userId="u1" canWrite={false} contact="Lan" imageEnabled={true} />);
    expect(state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversation-image')?.enabled).toBe(true);

    // Deep-link restore target skips re-fetching old cached pages when ?c= is absent from that tab's cached items
    expect(initialDeepLinkRestoreTarget(10, 'resolved-99', [{ id: 'c1' }, { id: 'c2' }])).toBeNull();
    expect(initialDeepLinkRestoreTarget(3, 'c2', [{ id: 'c1' }, { id: 'c2' }])).toEqual({
      anchorId: 'c2',
      anchorOffset: 0,
      minPages: 3,
    });

    // Empty cached list + failed verification refetch renders only inbox-list-error (never inbox-list-empty or inbox-no-channels)
    state.pagesResult = {
      data: { pages: [{ conversations: [], more: false }] },
      isPending: false,
      error: new Error('List refetch failed'),
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    };
    const emptyErrorHtml = wrap(<InboxScreen search={{}} covered={false} onSearch={() => undefined} />);
    expect(emptyErrorHtml).toContain('data-testid="inbox-list-error"');
    expect(emptyErrorHtml).not.toContain('data-testid="inbox-list-empty"');
    expect(emptyErrorHtml).not.toContain('data-testid="inbox-no-channels"');

    // MFA_REQUIRED HTTP 401 keeps the query error recoverable for afterMfaRefusal, while genuine 401/403/404 revocations deny
    expect(isConversationAccessDenied({ code: 'MFA_REQUIRED', status: 401 })).toBe(false);
    expect(isConversationAccessDenied({ code: 'UNAUTHORIZED', status: 401 })).toBe(true);
    expect(isConversationAccessDenied({ status: 401 })).toBe(true);
    expect(isConversationAccessDenied({ code: 'FORBIDDEN', status: 403 })).toBe(true);

    // Paused page trimming skips errored list caches so status='error' is never reset to 'success'
    expect(shouldTrimPausedPages(true, true, 3, true)).toBe(false);
    expect(shouldTrimPausedPages(true, true, 3, false)).toBe(true);

    // Active user scroll cancels stale pre-settings restore target while programmatic restore scrolls do not
    expect(shouldCancelRestoreOnUserScroll({ hideList: false, showList: true, loaded: true, programmaticScroll: false })).toBe(true);
    expect(shouldCancelRestoreOnUserScroll({ hideList: false, showList: true, loaded: true, programmaticScroll: true })).toBe(false);
    expect(shouldCancelRestoreOnUserScroll({ hideList: true, showList: true, loaded: true, programmaticScroll: false })).toBe(false);
    expect(shouldCancelRestoreOnUserScroll({ hideList: false, showList: false, loaded: true, programmaticScroll: false })).toBe(false);
  });

  it('pauses AvailabilityControl, Inbox channels queries, failed autoDraft fallbacks, cached pending suggestions, and email/LinkContact error PII', () => {
    function AiStateProbe({ enabled }: { enabled: boolean }) {
      return <div data-ai-state={useCustomerAiState(enabled)} />;
    }

    // AvailabilityControl disables its query when paused=true, and InboxScreen disables both channels.list queries while covered
    state.role = 'owner';
    state.queries = [];
    wrap(<AvailabilityControl paused />);
    expect(state.queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'conversations' && q.queryKey[1] === 'availability')?.enabled).toBe(false);

    state.queries = [];
    wrap(<InboxScreen search={{}} covered onSearch={() => undefined} />);
    const coveredChannels = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'channels' && q.queryKey[1] === 'list');
    expect(coveredChannels).toHaveLength(2);
    expect(coveredChannels.every((q) => q.enabled === false)).toBe(true);

    // Failed autoDraft without cached data stays 'pending' (never treated as 'on'), hiding cached intents/matches while preserving human intent
    state.aiEnabled = true;
    state.autoDraft = undefined;
    state.autoDraftError = true;
    state.cachedMatches = { ai: 'on', candidates: [{ partyId: 'p1', name: 'Lan', reason: 'phone' }] };
    state.cachedIntents = { ai: 'budget', suggestions: [{ conversationId: 'c1', intent: 'spam' }] };
    expect(wrap(<AiStateProbe enabled />)).toContain('data-ai-state="pending"');
    const pendingListProbe = wrap(<IntentListProbe enabled trackAiOff />);
    expect(pendingListProbe).toContain('data-size="0"');
    expect(pendingListProbe).toContain('data-ai=""');
    expect(wrap(<ContactSuggestions conversationId="c1" lastSeq={3} />)).not.toContain('Lan');
    const pausedAppliedHtml = wrap(<IntentBar conversation={summary({ intent: 'order_or_price' })} paused />);
    expect(pausedAppliedHtml).toContain('value="order_or_price" selected=""');
    expect(pausedAppliedHtml).not.toContain('data-testid="intent-suggested"');
    expect(wrap(<IntentBar conversation={summary({ intent: null })} paused />)).not.toContain('data-testid="intent-suggested"');

    // Transient detailError on email conversation hides recipient email and LinkContact customer PII while keeping ReplyBox textarea mounted
    state.detail = {
      ...state.detail,
      conversation: summary({
        kind: 'email',
        senderUnverified: true,
        contact: { identityId: 'ct1', displayName: 'Khách VIP', idTail: '1234', partyId: null, partyName: null, address: 'vip@example.com' },
      }),
    };
    state.detailError = new Error('500');
    const errThreadHtml = wrap(<ConversationThread conversationId="c1" onGone={() => undefined} />);
    expect(errThreadHtml).toContain('data-testid="conversation-reply-text"');
    expect(errThreadHtml).not.toContain('vip@example.com');
    expect(errThreadHtml).not.toContain('data-testid="reply-unverified-note"');
    const errPanelHtml = wrap(<ContactPanel conversationId="c1" onOpen={() => undefined} onErased={() => undefined} />);
    expect(errPanelHtml).not.toContain('data-testid="contact-link"');
    expect(errPanelHtml).not.toContain('Khách VIP');
  });
});
