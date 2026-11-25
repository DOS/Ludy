// SPDX-License-Identifier: AGPL-3.0-only
// Real @tanstack/react-query QueryClient verification for unpause re-checks, cancellation/replacement fetches,
// error-state read suppression, multi-page page-1 trim, and shared autoDraft refetches (#3673).
import { InfiniteQueryObserver, infiniteQueryOptions, QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const realQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

vi.mock('../src/lib/api.ts', () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.resolve({}) });
        if (prop === 'infiniteOptions') return () => ({ queryKey: path, queryFn: () => Promise.resolve({ conversations: [], more: false }) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    getCurrentOrg: () => 'acme',
    queryClient: realQueryClient,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    fetchConversationImage: () => Promise.reject(new Error('not called')),
  };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({
    aiEnabled: true,
    modules: ['kernel', 'social'],
    channels: { oauth: [], sandbox: false },
  }),
}));

const {
  hasVerifySettled,
  isThreadContentVisible,
  readVerifyQueryState,
  shouldTrimPausedPages,
  trimInfinitePagesToFirst,
  useConversationPages,
  verifySharedRefetch,
  verifyUpdateTotal,
} = await import('../src/components/conversation-inbox.tsx');

function RealPagesProbe() {
  const res = useConversationPages({ status: 'new', limit: 20 }, { enabled: true, paused: false });
  return <div data-loaded={String(res.loaded)} data-pending={String(res.isPending)} />;
}

describe('Inbox Settings unpause verification with real QueryClient (#3673)', () => {
  beforeEach(() => {
    realQueryClient.clear();
  });

  it('settles verification across consecutive successful refetches using queryClient.getQueryState', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c1' }] as const;
    let calls = 0;
    const observer = new QueryObserver(realQueryClient, {
      queryKey,
      queryFn: async () => {
        calls += 1;
        return { conversation: { id: 'c1', lastSeq: calls, unread: false } };
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const first = await observer.refetch({ cancelRefetch: false });
    expect(first.isSuccess).toBe(true);
    // TanStack QueryObserverResult omits dataUpdateCount; verify we never treat missing counter as stuck 0.
    expect((first as unknown as { dataUpdateCount?: number }).dataUpdateCount).toBeUndefined();

    const beforeUnpause = readVerifyQueryState(queryKey);
    expect(verifyUpdateTotal(beforeUnpause)).toBe(1);
    const minUpdates = (verifyUpdateTotal(beforeUnpause) ?? 0) + 1;

    const second = await observer.refetch({ cancelRefetch: false });
    expect(second.isSuccess).toBe(true);
    const afterUnpause = readVerifyQueryState(queryKey, second.isFetching);
    expect(afterUnpause?.dataUpdateCount).toBe(2);
    expect(hasVerifySettled({ state: afterUnpause, minUpdates, refetchSettled: true })).toBe(true);
    expect(calls).toBe(2);
    unsubscribe();
  });

  it('keeps verifying active while invalidateQueries cancels and replaces an in-flight refetch', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c2' }] as const;
    let calls = 0;
    const replacement: { resolve?: (v: { ok: number }) => void } = {};

    const observer = new QueryObserver<{ ok: number }>(realQueryClient, {
      queryKey,
      queryFn: async () => {
        calls += 1;
        if (calls === 1) return { ok: 1 };
        if (calls === 2) {
          return new Promise<{ ok: number }>((resolve) => {
            setTimeout(() => resolve({ ok: 2 }), 40);
          });
        }
        return new Promise<{ ok: number }>((resolve) => {
          replacement.resolve = resolve;
        });
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch({ cancelRefetch: false });
    const startState = readVerifyQueryState(queryKey);
    const minUpdates = (verifyUpdateTotal(startState) ?? 0) + 1;
    expect(minUpdates).toBe(2);

    const verifyPromise = observer.refetch({ cancelRefetch: false });
    // Simulate savedReplies save finishing and calling reload() -> invalidateQueries while verify is in flight.
    const invalidationPromise = realQueryClient.invalidateQueries({ queryKey });

    const midState = readVerifyQueryState(queryKey);
    expect(midState?.isFetching).toBe(true);
    expect(hasVerifySettled({ state: midState, minUpdates, refetchSettled: false })).toBe(false);

    expect(replacement.resolve).toBeDefined();
    replacement.resolve?.({ ok: 3 });
    const [verifyResult] = await Promise.all([verifyPromise, invalidationPromise]);

    const finalState = readVerifyQueryState(queryKey, verifyResult.isFetching);
    expect(finalState?.isFetching).toBe(false);
    expect(finalState?.dataUpdateCount).toBe(2);
    expect(hasVerifySettled({ state: finalState, minUpdates, refetchSettled: true })).toBe(true);
    unsubscribe();
  });

  it('settles on errorUpdateCount when refetch fails on cached unread thread without allowing markRead', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c3' }] as const;
    let shouldFail = false;
    const observer = new QueryObserver(realQueryClient, {
      queryKey,
      queryFn: async () => {
        if (shouldFail) throw new Error('403 Forbidden');
        return { conversation: { id: 'c3', lastSeq: 5, unread: true } };
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch({ cancelRefetch: false });
    const startState = readVerifyQueryState(queryKey);
    const minUpdates = (verifyUpdateTotal(startState) ?? 0) + 1;

    shouldFail = true;
    const failed = await observer.refetch({ cancelRefetch: false });
    const errorState = readVerifyQueryState(queryKey, failed.isFetching);
    expect(errorState?.errorUpdateCount).toBe(1);
    expect(hasVerifySettled({ state: errorState, minUpdates, refetchSettled: true })).toBe(true);
    expect(failed.data).toBeDefined();
    expect(failed.error).toBeInstanceOf(Error);
    expect(
      isThreadContentVisible({
        paused: false,
        verifyingAccess: false,
        isPending: failed.isPending,
        error: failed.error,
        hasData: failed.data !== undefined,
      }),
    ).toBe(false);
    unsubscribe();
  });

  it('trims multi-page infinite cache to page 1 on unpause so only 1 page refetches before settling', async () => {
    const queryKey = ['conversations', 'list', { status: 'new' }] as const;
    let fetches = 0;
    const observer = new InfiniteQueryObserver(
      realQueryClient,
      infiniteQueryOptions({
        queryKey,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: { conversations: Array<{ id: string }>; more: boolean }) =>
          lastPage.more ? `cursor-${lastPage.conversations[0]?.id}` : undefined,
        queryFn: async ({ pageParam }) => {
          fetches += 1;
          const n = pageParam ? Number(String(pageParam).replace('cursor-p', '')) + 1 : 1;
          return { conversations: [{ id: `p${n}` }], more: n < 5 };
        },
      }),
    );
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);

    const beforeUnpause = readVerifyQueryState(queryKey);
    const startTotal = verifyUpdateTotal(beforeUnpause) ?? 0;
    expect(startTotal).toBe(3);

    let trimmed = false;
    realQueryClient.setQueryData(queryKey, (old: { pages: unknown[]; pageParams: unknown[] } | undefined) => {
      const res = trimInfinitePagesToFirst(old);
      if (res.trimmed) trimmed = true;
      return res.next;
    });
    expect(trimmed).toBe(true);
    const minUpdates = startTotal + 1 + 1;

    fetches = 0;
    const refetched = await observer.refetch();
    expect(fetches).toBe(1);
    expect(refetched.data?.pages).toHaveLength(1);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);

    const finalState = readVerifyQueryState(queryKey, refetched.isFetching);
    expect(hasVerifySettled({ state: finalState, minUpdates, refetchSettled: true })).toBe(true);
    unsubscribe();
  });

  it('cancels an in-flight pre-pause detail fetch and shares one fresh post-unpause verification request across panes', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c-shared' }] as const;
    let calls = 0;
    let releasePrePause: ((v: { version: string }) => void) | null = null;
    let rejectPostUnpause: ((e: Error) => void) | null = null;

    const queryFn = async () => {
      calls += 1;
      if (calls === 1) return { version: 'initial' };
      if (calls === 2) {
        return new Promise<{ version: string }>((resolve) => {
          releasePrePause = resolve;
        });
      }
      return new Promise<{ version: string }>((_, reject) => {
        rejectPostUnpause = reject;
      });
    };

    const threadObserver = new QueryObserver(realQueryClient, { queryKey, queryFn });
    const panelObserver = new QueryObserver(realQueryClient, { queryKey, queryFn });
    const unsubA = threadObserver.subscribe(() => undefined);
    const unsubB = panelObserver.subscribe(() => undefined);

    await threadObserver.refetch();
    // Start a slow pre-pause poll before Settings closes (and before access is revoked).
    const prePausePoll = threadObserver.refetch();
    expect(calls).toBe(2);

    // On Settings close, ConversationThread and ContactPanel share one fresh post-unpause request (cancelling prePausePoll).
    const pThread = verifySharedRefetch(queryKey, () => threadObserver.refetch({ cancelRefetch: false }), true);
    const pPanel = verifySharedRefetch(queryKey, () => panelObserver.refetch({ cancelRefetch: false }), true);
    expect(pThread).toBe(pPanel);

    // Let cancelQueries settle before F_new begins, then complete pre-pause & post-unpause responses.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(3);

    releasePrePause!({ version: 'stale-authorized' });
    rejectPostUnpause!(new Error('CONVERSATION_NOT_FOUND'));
    const [resThread, resPanel] = await Promise.all([pThread, pPanel, prePausePoll]);
    expect((resThread as { isError?: boolean }).isError).toBe(true);
    expect((resPanel as { isError?: boolean }).isError).toBe(true);
    expect(calls).toBe(3);
    unsubA();
    unsubB();
  });

  it('cancels an in-flight initial load (data === undefined) on unpause and requires refetchSettled before clearing verifying', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c-pending' }] as const;
    let calls = 0;
    let releaseInitial: ((v: { secret: string }) => void) | null = null;
    let rejectVerified: ((e: Error) => void) | null = null;

    const queryFn = async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<{ secret: string }>((resolve) => {
          releaseInitial = resolve;
        });
      }
      return new Promise<{ secret: string }>((_, reject) => {
        rejectVerified = reject;
      });
    };

    const threadObserver = new QueryObserver(realQueryClient, { queryKey, queryFn });
    const panelObserver = new QueryObserver(realQueryClient, { queryKey, queryFn });
    const unsubA = threadObserver.subscribe(() => undefined);
    const unsubB = panelObserver.subscribe(() => undefined);

    // First fetch has not answered yet (data === undefined) while Settings opens and closes.
    const initialFetch = threadObserver.refetch();
    expect(threadObserver.getCurrentResult().data).toBeUndefined();
    const minUpdates = (verifyUpdateTotal(readVerifyQueryState(queryKey)) ?? 0) + 1;

    const pThread = verifySharedRefetch(queryKey, () => threadObserver.refetch({ cancelRefetch: false }), true);
    const pPanel = verifySharedRefetch(queryKey, () => panelObserver.refetch({ cancelRefetch: false }), true);
    expect(pThread).toBe(pPanel);

    // Wait for cancelQueries to abort initialFetch (which bumps errorUpdateCount to 1 before F_new even answers!).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    const midState = readVerifyQueryState(queryKey, true);
    // Even if cancelling initialFetch raised errorUpdateCount, hasVerifySettled stays false until F_new resolves!
    expect(hasVerifySettled({ state: midState, minUpdates, refetchSettled: false })).toBe(false);

    releaseInitial!({ secret: 'pre-revocation' });
    rejectVerified!(new Error('CONVERSATION_NOT_FOUND'));
    const [resThread, resPanel] = await Promise.all([pThread, pPanel, initialFetch]);
    expect((resThread as { isError?: boolean }).isError).toBe(true);
    expect((resPanel as { isError?: boolean }).isError).toBe(true);
    expect(threadObserver.getCurrentResult().data).toBeUndefined();
    const settledState = readVerifyQueryState(queryKey, false);
    expect(hasVerifySettled({ state: settledState, minUpdates, refetchSettled: true })).toBe(true);
    unsubA();
    unsubB();
  });

  it('deduplicates concurrent autoDraft refetches with cancelRefetch: false and mounts useConversationPages with QueryClientProvider', async () => {
    const queryKey = ['conversations', 'autoDraft'] as const;
    let calls = 0;
    let releaseSecond: ((v: { autoDraft: boolean }) => void) | null = null;
    const observerA = new QueryObserver(realQueryClient, {
      queryKey,
      queryFn: async () => {
        calls += 1;
        if (calls === 1) return { autoDraft: false };
        return new Promise<{ autoDraft: boolean }>((resolve) => {
          releaseSecond = resolve;
        });
      },
    });
    const observerB = new QueryObserver(realQueryClient, {
      queryKey,
      queryFn: async () => ({ autoDraft: true }),
    });
    const unsubA = observerA.subscribe(() => undefined);
    const unsubB = observerB.subscribe(() => undefined);

    await observerA.refetch({ cancelRefetch: false });
    expect(calls).toBe(1);

    const pA = observerA.refetch({ cancelRefetch: false });
    const pB = observerB.refetch({ cancelRefetch: false });
    expect(calls).toBe(2);
    expect(releaseSecond).not.toBeNull();
    releaseSecond!({ autoDraft: true });
    await Promise.all([pA, pB]);
    expect(calls).toBe(2);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={realQueryClient}>
        <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
          <RealPagesProbe />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('data-pending="true"');

    unsubA();
    unsubB();
  });

  it('re-anchors minUpdates to the switched filter queryKey when changing tabs mid-verification', async () => {
    const newKey = ['conversations', 'list', { status: 'new' }] as const;
    const resolvedKey = ['conversations', 'list', { status: 'resolved' }] as const;

    const newObs = new QueryObserver(realQueryClient, {
      queryKey: newKey,
      queryFn: async () => ({ conversations: [{ id: 'n1' }], more: false }),
    });
    const resolvedObs = new QueryObserver(realQueryClient, {
      queryKey: resolvedKey,
      queryFn: async () => ({ conversations: [{ id: 'r1' }], more: false }),
    });
    const unsubNew = newObs.subscribe(() => undefined);
    const unsubRes = resolvedObs.subscribe(() => undefined);

    // Tab New has multiple updates cached; tab Resolved has fewer updates cached.
    for (let i = 0; i < 5; i += 1) await newObs.refetch();
    const newBaseline = verifyUpdateTotal(readVerifyQueryState(newKey)) ?? 0;
    const resolvedBaseline = verifyUpdateTotal(readVerifyQueryState(resolvedKey)) ?? 0;
    expect(resolvedBaseline).toBeGreaterThanOrEqual(1);
    expect(resolvedBaseline).toBeLessThan(newBaseline);

    // Switching to tab Resolved while verifying keeps verifying active against Resolved's own baseline (not New's higher baseline).
    const resolvedMinUpdates = resolvedBaseline + 1;
    expect(hasVerifySettled({ state: readVerifyQueryState(resolvedKey), minUpdates: resolvedMinUpdates, refetchSettled: false })).toBe(false);

    const verifiedResolved = await verifySharedRefetch(resolvedKey, () => resolvedObs.refetch({ cancelRefetch: false }), false);
    const afterResolved = readVerifyQueryState(resolvedKey, (verifiedResolved as { isFetching?: boolean }).isFetching);
    expect(afterResolved?.dataUpdateCount).toBe(resolvedMinUpdates);
    expect(hasVerifySettled({ state: afterResolved, minUpdates: resolvedMinUpdates, refetchSettled: true })).toBe(true);

    unsubNew();
    unsubRes();
  });

  it('joins freshly started enabled: false -> true fetch without cancelling when cancelExisting is false', async () => {
    const queryKey = ['conversations', 'list', { status: 'new', join: true }] as const;
    let calls = 0;
    let releaseFirst: ((v: { conversations: Array<{ id: string }>; more: boolean }) => void) | null = null;
    const baseOpts = {
      queryKey,
      initialPageParam: undefined as { at: string | null; id: string } | undefined,
      getNextPageParam: () => undefined,
      queryFn: async () => {
        calls += 1;
        return new Promise<{ conversations: Array<{ id: string }>; more: boolean }>((resolve) => {
          releaseFirst = resolve;
        });
      },
    };
    const obs = new InfiniteQueryObserver(realQueryClient, { ...baseOpts, enabled: false });
    const unsub = obs.subscribe(() => undefined);
    expect(calls).toBe(0);

    // Transitioning enabled: false -> true (just like closing ?settings=true) immediately begins F_1 inside QueryObserver.
    obs.setOptions({ ...baseOpts, enabled: true });
    expect(calls).toBe(1);
    expect(readVerifyQueryState(queryKey)?.isFetching).toBe(true);

    // Because cancelExisting is false (idle during render before QueryObserver's commit effect started F_1), verifySharedRefetch joins F_1.
    const pending = verifySharedRefetch(queryKey, () => obs.refetch({ cancelRefetch: false }), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    releaseFirst!({ conversations: [{ id: 'c1' }], more: false });
    const res = await pending;
    expect((res as { isSuccess?: boolean }).isSuccess).toBe(true);
    expect(calls).toBe(1);
    const settled = readVerifyQueryState(queryKey, false);
    expect(settled?.dataUpdateCount).toBe(1);
    expect(hasVerifySettled({ state: settled, minUpdates: 1, refetchSettled: true })).toBe(true);
    unsub();
  });

  it('trims pre-cached multi-page list while enabled is false (?settings=true return) so unpausing fetches only page 1', async () => {
    const queryKey = ['conversations', 'list', { status: 'new', settingsReturn: true }] as const;
    const requestedCursors: Array<string | undefined> = [];
    const baseOpts = {
      queryKey,
      initialPageParam: undefined as { at: string | null; id: string } | undefined,
      getNextPageParam: (last: { conversations: Array<{ id: string }>; nextCursor: { at: string | null; id: string } | null }) => last.nextCursor ?? undefined,
      queryFn: async ({ pageParam }: { pageParam: { at: string | null; id: string } | undefined }) => {
        requestedCursors.push(pageParam?.id);
        return { conversations: [{ id: `page-${pageParam?.id ?? 'first'}` }], nextCursor: null };
      },
    };
    // Seed 3 cached pages (as if the user scrolled older conversations, left, and returned via ?settings=true).
    realQueryClient.setQueryData(queryKey, {
      pages: [
        { conversations: [{ id: 'p1' }], nextCursor: { at: 't1', id: 'p1' } },
        { conversations: [{ id: 'p2' }], nextCursor: { at: 't2', id: 'p2' } },
        { conversations: [{ id: 'p3' }], nextCursor: null },
      ],
      pageParams: [undefined, { at: 't1', id: 'p1' }, { at: 't2', id: 'p2' }],
    });

    const obs = new InfiniteQueryObserver(realQueryClient, { ...baseOpts, enabled: false });
    const unsub = obs.subscribe(() => undefined);
    const cachedLen = obs.getCurrentResult().data?.pages.length ?? 0;
    expect(shouldTrimPausedPages(true, false, cachedLen)).toBe(true);

    // Paused effect trims back to page 1 while enabled is still false (?settings=true open).
    realQueryClient.setQueryData(queryKey, (old: { pages: unknown[]; pageParams: unknown[] } | undefined) => trimInfinitePagesToFirst(old).next);
    expect(obs.getCurrentResult().data?.pages.length).toBe(1);
    const beforeUnpause = verifyUpdateTotal(readVerifyQueryState(queryKey)) ?? 0;

    // Closing Settings turns enabled: true -> only page 1 is requested, never pages 2 or 3.
    obs.setOptions({ ...baseOpts, enabled: true });
    const res = await verifySharedRefetch(queryKey, () => obs.refetch({ cancelRefetch: false }), false);
    expect((res as { isSuccess?: boolean }).isSuccess).toBe(true);
    expect(requestedCursors).toEqual([undefined]);
    const settled = readVerifyQueryState(queryKey, false);
    expect(hasVerifySettled({ state: settled, minUpdates: beforeUnpause + 1, refetchSettled: true })).toBe(true);
    unsub();
  });

  it('cancels an in-flight multi-page list fetch before trimming cached pages on pause', async () => {
    const queryKey = ['conversations', 'list', { status: 'new', cancelMulti: true }] as const;
    let calls = 0;
    let aborted = false;
    const resolvers: Array<(v: { conversations: Array<{ id: string }>; nextCursor: null }) => void> = [];
    const obs = new InfiniteQueryObserver(realQueryClient, {
      queryKey,
      staleTime: 60_000,
      initialPageParam: undefined as { at: string | null; id: string } | undefined,
      getNextPageParam: (last: { conversations: Array<{ id: string }>; nextCursor: { at: string | null; id: string } | null }) => last.nextCursor ?? undefined,
      queryFn: ({ signal }) => {
        calls += 1;
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<{ conversations: Array<{ id: string }>; nextCursor: null }>((resolve) => {
          resolvers.push(resolve);
        });
      },
    });
    // Seed 2 pages in cache while an update fetch across those pages is already in flight.
    realQueryClient.setQueryData(queryKey, {
      pages: [
        { conversations: [{ id: 'p1' }], nextCursor: { at: 't1', id: 'p1' } },
        { conversations: [{ id: 'p2' }], nextCursor: null },
      ],
      pageParams: [undefined, { at: 't1', id: 'p1' }],
    });
    const unsub = obs.subscribe(() => undefined);
    const runningUpdate = obs.refetch();
    expect(calls).toBe(1);
    expect(readVerifyQueryState(queryKey)?.isFetching).toBe(true);

    // Opening Settings cancels the running multi-page refetch before trimming cache back to page 1.
    await realQueryClient.cancelQueries({ queryKey, exact: true });
    realQueryClient.setQueryData(queryKey, (old: { pages: unknown[]; pageParams: unknown[] } | undefined) => trimInfinitePagesToFirst(old).next);
    resolvers[0]?.({ conversations: [{ id: 'stale' }], nextCursor: null });
    await runningUpdate;

    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(obs.getCurrentResult().data?.pages.length).toBe(1);
    unsub();
  });

  it('shares one verification fetch across same-commit siblings while replacing stale earlier-epoch requests on cancelExisting=true', async () => {
    const queryKey = ['conversations', 'get', { conversationId: 'c-epoch' }] as const;
    const cancelSpy = vi.spyOn(realQueryClient, 'cancelQueries');
    let resolveEpoch1!: (v: string) => void;
    let epoch1Calls = 0;
    const p1 = verifySharedRefetch(
      queryKey,
      () => {
        epoch1Calls += 1;
        return new Promise<string>((resolve) => {
          resolveEpoch1 = resolve;
        });
      },
      false,
    );
    let siblingCalls = 0;
    const p1Sibling = verifySharedRefetch(
      queryKey,
      () => {
        siblingCalls += 1;
        return Promise.resolve('should-share-epoch1');
      },
      true,
    );
    expect(p1Sibling).toBe(p1);
    expect(epoch1Calls).toBe(1);
    expect(siblingCalls).toBe(0);

    // Yield one microtask so the next unpause cycle starts in a distinct commit/epoch.
    await Promise.resolve();

    let resolveEpoch2!: (v: string) => void;
    let epoch2Calls = 0;
    const p2 = verifySharedRefetch(
      queryKey,
      () => {
        epoch2Calls += 1;
        return new Promise<string>((resolve) => {
          resolveEpoch2 = resolve;
        });
      },
      true,
    );
    let epoch2SiblingCalls = 0;
    const p2Sibling = verifySharedRefetch(
      queryKey,
      () => {
        epoch2SiblingCalls += 1;
        return Promise.resolve('should-share-epoch2');
      },
      true,
    );
    expect(p2).not.toBe(p1);
    expect(p2Sibling).toBe(p2);
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey, exact: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(epoch2Calls).toBe(1);
    expect(epoch2SiblingCalls).toBe(0);

    resolveEpoch1('stale-epoch1');
    expect(await p1).toBe('stale-epoch1');
    resolveEpoch2('fresh-epoch2');
    expect(await p2).toBe('fresh-epoch2');
    cancelSpy.mockRestore();
  });
});
