// SPDX-License-Identifier: AGPL-3.0-only
// Mobile Engage conversations inbox screen: New/Pending/All filters, offline read cache, web hand-off, and thread navigation (issue #4882).

import { isMfaRequired } from '@ludy/client';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { normalizeServerUrl } from '../../config.ts';
import { externalBrowser } from '../../platform/browser.ts';
import { clientFor, conversationsCache, SERVER_POLICY, session, t } from '../../runtime.ts';
import { Badge, Banner, Body, LinkButton, PrimaryButton, SecondaryButton, SectionHeading, Title } from '../../ui/parts.tsx';
import { styles, usePalette } from '../../ui/theme.ts';
import { buildWebUrl, formatDateTimeShort, type Locale } from '../approvals/format.ts';
import type { CachedConversationsSnapshot } from './cache.ts';
import { ConversationThreadScreen } from './ConversationThreadScreen.tsx';
import {
  buildInboxWebPath,
  DEFAULT_SALES_COWORKER,
  fetchDeploymentAiEnabled,
  formatChannelProviderLabel,
  formatRelativeTimestamp,
  formatWindowDuration,
  getContactDisplayName,
  getSummaryWindowBadge,
  isAccessRefusalError,
  isAuthBlockingError,
  isLikelyNetworkError,
  mergeConversationPages,
  resolveSalesCoworkerName,
  type ConversationCounts,
  type ConversationFilterTab,
  type ConversationListed,
  type ConversationSummary,
  type OrgDetail,
  type OrgRole,
} from './model.ts';

interface ConversationsInboxScreenProps {
  serverUrl: string;
  orgSlug: string;
  orgName: string;
  role: OrgRole;
  userId: string | null;
  locale: Locale;
  canSwitchOrg: boolean;
  onSwitchOrg: () => void;
  isActiveTab?: boolean;
  initialConversationId?: string | null;
  onInitialConversationConsumed?: () => void;
}

const PAGE_LIMIT = 30;
const CLOCK_TICK_MS = 60_000;
const INBOX_POLL_MS = 30_000;

function ListRowSeparator() {
  return <View style={{ height: 12 }} />;
}

export function ConversationsInboxScreen(props: ConversationsInboxScreenProps) {
  const {
    serverUrl,
    orgSlug,
    orgName,
    role,
    userId,
    locale,
    isActiveTab = true,
    initialConversationId,
    onInitialConversationConsumed,
  } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [filter, setFilter] = useState<ConversationFilterTab>('new');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() =>
    initialConversationId && !/[\s\p{C}]/u.test(initialConversationId) ? initialConversationId : null,
  );
  const [cachedSnapshot, setCachedSnapshot] = useState<CachedConversationsSnapshot | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [refusalError, setRefusalError] = useState<unknown>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isAppActive, setIsAppActive] = useState(() => AppState.currentState === 'active');
  const prevCountsSigRef = useRef<string | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setIsAppActive(next === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (initialConversationId && !/[\s\p{C}]/u.test(initialConversationId)) {
      setSelectedConversationId(initialConversationId);
      onInitialConversationConsumed?.();
    }
  }, [initialConversationId, onInitialConversationConsumed]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCachedSnapshot(null);
    setCacheLoaded(false);
    setRefusalError(null);
    setBannerMessage(null);
    setFilter('new');
    prevCountsSigRef.current = null;

    if (!userId) {
      setCacheLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    void conversationsCache
      .load(serverUrl, orgSlug, userId)
      .then((snap) => {
        if (!cancelled) {
          setCachedSnapshot(snap);
          setCacheLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCachedSnapshot(null);
          setCacheLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [serverUrl, orgSlug, userId]);

  const aiEnabledQuery = useQuery<boolean>({
    queryKey: ['server-config-ai', serverUrl],
    queryFn: () => fetchDeploymentAiEnabled(serverUrl, { forceRefresh: true }),
    staleTime: 60_000,
    retry: false,
  });

  const orgQuery = useQuery<OrgDetail>({
    queryKey: ['conversations', 'org', serverUrl, orgSlug],
    queryFn: () => client.org.get(),
    enabled: cacheLoaded && refusalError === null,
    staleTime: 60_000,
  });

  const salesCoworkerQuery = useQuery<string>({
    queryKey: ['conversations', 'sales-coworker', serverUrl, orgSlug],
    queryFn: () => resolveSalesCoworkerName(client, orgQuery.data),
    staleTime: 5 * 60_000,
  });

  const countsQuery = useQuery<ConversationCounts>({
    queryKey: ['conversations', 'counts', serverUrl, orgSlug, userId ?? ''],
    queryFn: async () => {
      const startEpoch = conversationsCache.epoch();
      const counts = await client.conversations.counts({});
      const cur = session.state();
      if (
        cur.status !== 'active' ||
        cur.serverUrl !== serverUrl ||
        cur.orgSlug !== orgSlug ||
        conversationsCache.epoch() !== startEpoch
      ) {
        throw new Error('stale-session');
      }
      return counts;
    },
    enabled: cacheLoaded && refusalError === null,
    retry: false,
    staleTime: 30_000,
  });

  const salesCoworkerName =
    salesCoworkerQuery.data ?? cachedSnapshot?.salesCoworkerName ?? DEFAULT_SALES_COWORKER;

  const listQuery = useInfiniteQuery({
    queryKey: ['conversations', 'list', serverUrl, orgSlug, userId ?? '', filter] as const,
    initialPageParam: undefined as { at: string | null; id: string } | undefined,
    getNextPageParam: (lastPage: ConversationListed) => {
      if (!lastPage.more) return undefined;
      const last = lastPage.conversations.at(-1);
      return last ? { at: last.lastMessageAt, id: last.id } : undefined;
    },
    queryFn: async ({ pageParam, signal }) => {
      const startEpoch = conversationsCache.epoch();
      const listed = await client.conversations.list({
        ...(filter === 'all' ? {} : { status: filter }),
        limit: PAGE_LIMIT,
        ...(pageParam ? { before: pageParam } : {}),
      });
      if (signal.aborted) {
        throw new Error('aborted');
      }
      const cur = session.state();
      const sameActiveSession =
        cur.status === 'active' &&
        cur.serverUrl === serverUrl &&
        cur.orgSlug === orgSlug &&
        conversationsCache.epoch() === startEpoch;
      if (!sameActiveSession) {
        throw new Error('stale-session');
      }

      if (userId && pageParam === undefined) {
        void conversationsCache
          .upsertList({
            serverUrl,
            orgSlug,
            userId,
            savedAt: Date.now(),
            filter,
            items: listed.conversations,
            counts: countsQuery.data,
            salesCoworkerName,
            expectedEpoch: startEpoch,
            signal,
            isSessionStillActive: () => {
              const after = session.state();
              return (
                after.status === 'active' &&
                after.serverUrl === serverUrl &&
                after.orgSlug === orgSlug &&
                conversationsCache.epoch() === startEpoch
              );
            },
          })
          .then((saved) => {
            if (!saved || signal.aborted || conversationsCache.epoch() !== startEpoch) return;
            setCachedSnapshot(saved);
          })
          .catch(() => undefined);
      }

      return listed;
    },
    enabled: cacheLoaded && refusalError === null,
    retry: false,
    refetchInterval: (query) => {
      if (!isActiveTab || !isAppActive || selectedConversationId || refusalError !== null) {
        return false;
      }
      if (query.state.error && isAccessRefusalError(query.state.error)) {
        return false;
      }
      return INBOX_POLL_MS;
    },
  });

  const refetchListRef = useRef(listQuery.refetch);
  refetchListRef.current = listQuery.refetch;
  const isListFetchingRef = useRef(listQuery.isFetching);
  isListFetchingRef.current = listQuery.isFetching;

  const countsSignature = countsQuery.data
    ? `${countsQuery.data.new}|${countsQuery.data.pending}|${countsQuery.data.resolved}|${countsQuery.data.unread}`
    : null;

  // Keep the visible inbox list synchronized when periodic unread/status counts detect new conversations.
  useEffect(() => {
    if (countsSignature === null) return;
    const prev = prevCountsSigRef.current;
    prevCountsSigRef.current = countsSignature;
    if (
      prev !== null &&
      prev !== countsSignature &&
      cacheLoaded &&
      isActiveTab &&
      isAppActive &&
      !selectedConversationId &&
      refusalError === null &&
      !isListFetchingRef.current
    ) {
      void refetchListRef.current();
    }
  }, [countsSignature, cacheLoaded, isActiveTab, isAppActive, selectedConversationId, refusalError]);

  const liveAccessRefusalError =
    (listQuery.isError && !isLikelyNetworkError(listQuery.error) && isAccessRefusalError(listQuery.error)
      ? listQuery.error
      : null) ??
    (countsQuery.isError && !isLikelyNetworkError(countsQuery.error) && isAccessRefusalError(countsQuery.error)
      ? countsQuery.error
      : null) ??
    (orgQuery.isError && !isLikelyNetworkError(orgQuery.error) && isAccessRefusalError(orgQuery.error)
      ? orgQuery.error
      : null);

  // Purge both persisted disk cache and React Query caches strictly on access/auth refusals (never on transient 429/5xx).
  useEffect(() => {
    if (!liveAccessRefusalError) return;
    if (isAuthBlockingError(liveAccessRefusalError)) {
      void session.reportKernelError(liveAccessRefusalError);
    }
    setRefusalError(liveAccessRefusalError);
    setCachedSnapshot(null);
    setSelectedConversationId(null);
    void conversationsCache.clearScope({ serverUrl, orgSlug, userId });
    qc.removeQueries({ queryKey: ['conversations', 'list', serverUrl, orgSlug] });
    qc.removeQueries({ queryKey: ['conversations', 'detail', serverUrl, orgSlug] });
    qc.removeQueries({ queryKey: ['conversations', 'counts', serverUrl, orgSlug] });
  }, [liveAccessRefusalError, qc, serverUrl, orgSlug, userId]);

  const listTransientError =
    listQuery.isError && !isLikelyNetworkError(listQuery.error) && !isAccessRefusalError(listQuery.error)
      ? listQuery.error
      : null;

  const accessRefusalObj = refusalError ?? liveAccessRefusalError;
  const nonNetworkErrorObj = accessRefusalObj ?? listTransientError;
  const isAccessDenied = accessRefusalObj !== null;
  const isNonNetworkError = nonNetworkErrorObj !== null;
  const isListNetworkOffline =
    !isNonNetworkError && Boolean(listQuery.isError && isLikelyNetworkError(listQuery.error));
  const isCountsUnavailable = countsQuery.isError;

  const liveCounts = isAccessDenied || isCountsUnavailable ? undefined : countsQuery.data;
  const activeCounts = isAccessDenied ? null : (liveCounts ?? cachedSnapshot?.counts ?? null);

  const liveItems = useMemo(() => {
    if (isNonNetworkError || !listQuery.data) return null;
    return mergeConversationPages(listQuery.data.pages);
  }, [isNonNetworkError, listQuery.data]);

  const cachedItemsForTab = isAccessDenied ? null : (cachedSnapshot?.lists[filter] ?? null);
  const activeItems = isAccessDenied ? null : (liveItems ?? (isNonNetworkError ? null : cachedItemsForTab));
  const isShowingOfflineBanner = Boolean(isListNetworkOffline && (cachedSnapshot !== null || liveItems !== null));

  const effectiveRole = orgQuery.data?.role ?? role;
  const members = orgQuery.data?.members ?? [];

  function refreshAll() {
    void qc.invalidateQueries({ queryKey: ['conversations', 'list', serverUrl, orgSlug] });
    void qc.invalidateQueries({ queryKey: ['conversations', 'counts', serverUrl, orgSlug] });
  }

  async function handleOpenWebInbox() {
    const allowedOrigin = normalizeServerUrl(serverUrl);
    const url = buildWebUrl(serverUrl, orgSlug, buildInboxWebPath(), SERVER_POLICY);
    if (!url || !allowedOrigin) {
      setBannerMessage(t('approvals.outcome.webError'));
      return;
    }
    const opened = await externalBrowser.openWeb(url, allowedOrigin);
    if (!opened) setBannerMessage(t('approvals.outcome.webError'));
  }

  if (selectedConversationId && !isAccessDenied) {
    return (
      <ConversationThreadScreen
        aiEnabled={aiEnabledQuery.data === true}
        conversationId={selectedConversationId}
        locale={locale}
        members={members}
        onBack={() => setSelectedConversationId(null)}
        onRefreshList={refreshAll}
        orgSlug={orgSlug}
        role={effectiveRole}
        salesCoworkerName={salesCoworkerName}
        serverUrl={serverUrl}
        userId={userId}
      />
    );
  }

  const filterTabs: Array<{ id: ConversationFilterTab; label: string; count?: number }> = [
    {
      id: 'new',
      label: t('conversations.tab.new'),
      ...(activeCounts ? { count: activeCounts.new } : {}),
    },
    {
      id: 'pending',
      label: t('conversations.tab.pending'),
      ...(activeCounts ? { count: activeCounts.pending } : {}),
    },
    {
      id: 'all',
      label: t('conversations.tab.all'),
      ...(activeCounts ? { count: activeCounts.new + activeCounts.pending + activeCounts.resolved } : {}),
    },
  ];

  const canShowListContent =
    !isNonNetworkError && (liveItems !== null || !(isListNetworkOffline && !cachedSnapshot));
  const listData: ConversationSummary[] = canShowListContent ? (activeItems ?? []) : [];

  function handlePullRefresh() {
    if (refusalError !== null) {
      setRefusalError(null);
      void qc.invalidateQueries({ queryKey: ['conversations', 'list', serverUrl, orgSlug] });
      void qc.invalidateQueries({ queryKey: ['conversations', 'counts', serverUrl, orgSlug] });
      void qc.invalidateQueries({ queryKey: ['conversations', 'org', serverUrl, orgSlug] });
      void aiEnabledQuery.refetch();
      return;
    }
    void listQuery.refetch();
    void countsQuery.refetch();
    void aiEnabledQuery.refetch();
    void orgQuery.refetch();
  }

  const listHeader = (
    <View style={{ gap: 12, marginBottom: listData.length > 0 ? 12 : 0 }}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Title>{t('conversations.title')}</Title>
          <Text style={[styles.meta, { color: palette.muted }]}>{t('home.org', { org: orgName })}</Text>
        </View>
        <View style={styles.actionsRow}>
          <LinkButton
            label={t('conversations.openWeb')}
            accessibilityHint={t('conversations.openWebHint')}
            onPress={() => void handleOpenWebInbox()}
          />
          {props.canSwitchOrg ? (
            <LinkButton label={t('approvals.orgSwitch')} onPress={props.onSwitchOrg} />
          ) : null}
        </View>
      </View>

      <Body tone="muted">{t('conversations.subtitle')}</Body>

      {bannerMessage ? (
        <Banner tone="info">
          <Body>{bannerMessage}</Body>
        </Banner>
      ) : null}

      {isNonNetworkError ? (
        <Banner tone="danger">
          <Body tone="danger">
            {isMfaRequired(nonNetworkErrorObj) ? t('home.error.mfa') : t('home.error.generic')}
          </Body>
          <PrimaryButton label={t('home.retry')} onPress={handlePullRefresh} />
        </Banner>
      ) : null}

      {isShowingOfflineBanner ? (
        <Banner tone="warn">
          <Body tone="warning">
            {t('conversations.offlineBanner', {
              time: formatDateTimeShort(cachedSnapshot?.savedAt ?? nowMs, locale),
            })}
          </Body>
        </Banner>
      ) : cachedSnapshot && liveItems ? (
        <Text style={[styles.meta, { color: palette.muted }]}>
          {t('conversations.cachedHint', {
            time: formatDateTimeShort(cachedSnapshot.savedAt, locale),
          })}
        </Text>
      ) : null}

      {isListNetworkOffline && liveItems === null && !cachedSnapshot ? (
        <Banner tone="danger">
          <Body tone="danger">{t('conversations.offlineNoCache')}</Body>
          <PrimaryButton label={t('home.retry')} onPress={handlePullRefresh} />
        </Banner>
      ) : null}

      {canShowListContent ? (
        <ScrollView
          accessibilityRole="tablist"
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {filterTabs.map((tab) => {
            const selected = filter === tab.id;
            const labelText = tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label;
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityLabel={labelText}
                accessibilityState={{ selected }}
                onPress={() => setFilter(tab.id)}
                style={{
                  minHeight: 48,
                  paddingHorizontal: 14,
                  borderRadius: 24,
                  borderWidth: 1,
                  borderColor: selected ? palette.primary : palette.border,
                  backgroundColor: selected ? palette.primary : palette.surface,
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: selected ? palette.primaryText : palette.text,
                  }}
                >
                  {labelText}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );

  const listEmpty = !canShowListContent ? null : listQuery.isPending && activeItems === null ? (
    <View style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
      <ActivityIndicator accessibilityLabel={t('conversations.loading')} />
      <Body tone="muted">{t('conversations.loading')}</Body>
    </View>
  ) : (
    <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface, marginTop: 12 }]}>
      <SectionHeading>{t(`conversations.empty.${filter}`)}</SectionHeading>
      <Body tone="muted">{t('conversations.openWebHint')}</Body>
      <PrimaryButton label={t('conversations.refresh')} onPress={handlePullRefresh} />
    </View>
  );

  const listFooter = (
    <View style={{ gap: 12, marginTop: 12 }}>
      {canShowListContent && listQuery.hasNextPage && !isListNetworkOffline ? (
        <SecondaryButton
          label={
            listQuery.isFetchingNextPage
              ? t('conversations.loadingMore')
              : t('conversations.loadMore')
          }
          busy={listQuery.isFetchingNextPage}
          onPress={() => void listQuery.fetchNextPage()}
        />
      ) : null}

      <View style={{ alignItems: 'center', gap: 4 }}>
        <LinkButton label={t('home.signOut')} onPress={() => void session.signOut()} />
        <Text style={[styles.meta, { color: palette.muted, textAlign: 'center' }]}>
          {t('home.signOutHint')}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background }]}>
      <FlatList
        data={listData}
        keyExtractor={(conv) => conv.id}
        initialNumToRender={12}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scrollContent, { gap: 0 }]}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        ItemSeparatorComponent={ListRowSeparator}
        refreshControl={
          <RefreshControl
            onRefresh={handlePullRefresh}
            refreshing={listQuery.isRefetching || countsQuery.isRefetching}
          />
        }
        renderItem={({ item: conv }) => {
          const customerName = getContactDisplayName(conv.contact, (tail) =>
            t('conversations.anonymous', { tail }),
          );
          const channelLabel = formatChannelProviderLabel(conv.channel.provider, conv.kind);
          const kindLabel = t(`conversations.kind.${conv.kind}`);
          const relTime = formatRelativeTimestamp(conv.lastMessageAt, nowMs, locale);
          const winBadge = getSummaryWindowBadge(conv, nowMs);
          const winText = winBadge
            ? winBadge.expired
              ? t('conversations.window.badgeClosed')
              : t('conversations.window.badgeOpen', {
                  remaining: formatWindowDuration(winBadge.remainingMs, locale),
                })
            : null;

          const a11ySummary = [
            customerName,
            conv.unread ? t('conversations.unread') : null,
            channelLabel,
            kindLabel,
            relTime,
            winText,
            conv.preview || t('conversations.noPreview'),
          ]
            .filter(Boolean)
            .join(', ');

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={a11ySummary}
              onPress={() => {
                setBannerMessage(null);
                setSelectedConversationId(conv.id);
              }}
              style={[
                styles.card,
                {
                  borderColor: conv.unread ? palette.primary : palette.border,
                  backgroundColor: palette.surface,
                  minHeight: 72,
                },
              ]}
            >
              <View style={styles.row}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  {conv.unread ? (
                    <View
                      accessibilityLabel={t('conversations.unread')}
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: palette.primary,
                      }}
                    />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.cardTitle,
                      {
                        color: palette.text,
                        fontWeight: conv.unread ? '700' : '600',
                        flex: 1,
                      },
                    ]}
                  >
                    {customerName}
                  </Text>
                </View>
                {relTime ? <Text style={[styles.meta, { color: palette.muted }]}>{relTime}</Text> : null}
              </View>

              <Text
                numberOfLines={2}
                style={[styles.body, { color: conv.preview ? palette.text : palette.muted }]}
              >
                {conv.preview || t('conversations.noPreview')}
              </Text>

              <View style={styles.actionsRow}>
                <Badge label={channelLabel} tone="info" />
                <Badge label={kindLabel} tone="info" />
                {conv.channel.displayName ? (
                  <Badge label={conv.channel.displayName} tone="info" />
                ) : null}
                {filter === 'all' ? (
                  <Badge
                    label={t(`conversations.status.${conv.status}`)}
                    tone={conv.status === 'new' ? 'warn' : 'info'}
                  />
                ) : null}
                {winBadge && winText ? (
                  <Badge
                    label={winText}
                    tone={winBadge.expired ? 'danger' : winBadge.urgent ? 'warn' : 'info'}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
