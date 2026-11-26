// SPDX-License-Identifier: AGPL-3.0-only
// Mobile Engage conversations inbox screen: New/Pending/All filters, offline read cache, web hand-off, and thread navigation (issue #4882).

import { isMfaRequired } from '@ludy/client';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
  isLikelyNetworkError,
  mergeConversationPages,
  resolveSalesCoworkerName,
  type ConversationCounts,
  type ConversationFilterTab,
  type ConversationListed,
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
  initialConversationId?: string | null;
  onInitialConversationConsumed?: () => void;
  onUnreadCountChange?: (count: number) => void;
}

const PAGE_LIMIT = 30;
const CLOCK_TICK_MS = 60_000;

export function ConversationsInboxScreen(props: ConversationsInboxScreenProps) {
  const {
    serverUrl,
    orgSlug,
    orgName,
    role,
    userId,
    locale,
    initialConversationId,
    onInitialConversationConsumed,
    onUnreadCountChange,
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
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

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
    setBannerMessage(null);
    setFilter('new');

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
    queryFn: () => fetchDeploymentAiEnabled(serverUrl),
    staleTime: 60_000,
    retry: false,
  });

  const orgQuery = useQuery<OrgDetail>({
    queryKey: ['conversations', 'org', serverUrl, orgSlug],
    queryFn: () => client.org.get(),
    staleTime: 60_000,
  });

  const salesCoworkerQuery = useQuery<string>({
    queryKey: ['conversations', 'sales-coworker', serverUrl, orgSlug],
    queryFn: () => resolveSalesCoworkerName(client, orgQuery.data),
    staleTime: 5 * 60_000,
  });

  const countsQuery = useQuery<ConversationCounts>({
    queryKey: ['conversations', 'counts', serverUrl, orgSlug, userId ?? ''],
    queryFn: () => client.conversations.counts({}),
    enabled: cacheLoaded,
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
            counts: countsQuery.data ?? null,
            salesCoworkerName,
            expectedEpoch: startEpoch,
            signal,
            isSessionStillActive: () => {
              const after = session.state();
              return after.status === 'active' && after.serverUrl === serverUrl && after.orgSlug === orgSlug;
            },
          })
          .then((saved) => {
            if (!saved || signal.aborted) return;
            setCachedSnapshot(saved);
          })
          .catch(() => undefined);
      }

      return listed;
    },
    enabled: cacheLoaded,
  });

  const isNetworkOffline = Boolean(
    (listQuery.isError && isLikelyNetworkError(listQuery.error)) ||
      (countsQuery.isError && isLikelyNetworkError(countsQuery.error)),
  );
  const isNonNetworkError = Boolean(
    (listQuery.isError && !isLikelyNetworkError(listQuery.error)) ||
      (countsQuery.isError && !isLikelyNetworkError(countsQuery.error)) ||
      (orgQuery.isError && !isLikelyNetworkError(orgQuery.error)),
  );

  const liveCounts = isNonNetworkError ? undefined : countsQuery.data;
  const activeCounts = isNonNetworkError ? null : (liveCounts ?? cachedSnapshot?.counts ?? null);

  useEffect(() => {
    if (activeCounts && typeof activeCounts.unread === 'number') {
      onUnreadCountChange?.(activeCounts.unread);
    }
  }, [activeCounts, onUnreadCountChange]);

  const liveItems = useMemo(() => {
    if (isNonNetworkError || !listQuery.data) return null;
    return mergeConversationPages(listQuery.data.pages);
  }, [isNonNetworkError, listQuery.data]);

  const cachedItemsForTab = isNonNetworkError ? null : (cachedSnapshot?.lists[filter] ?? null);
  const activeItems = isNonNetworkError ? null : (liveItems ?? cachedItemsForTab);
  const isShowingOfflineBanner = Boolean(isNetworkOffline && cachedSnapshot !== null);

  const effectiveRole = orgQuery.data?.role ?? role;
  const members = orgQuery.data?.members ?? [];
  const aiEnabled = !isNetworkOffline && aiEnabledQuery.data === true;

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

  if (selectedConversationId && !isNonNetworkError) {
    return (
      <ConversationThreadScreen
        aiEnabled={aiEnabled}
        conversationId={selectedConversationId}
        isListOffline={isNetworkOffline}
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

  const nonNetworkErrorObj = listQuery.error ?? countsQuery.error ?? orgQuery.error;

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              void listQuery.refetch();
              void countsQuery.refetch();
            }}
            refreshing={listQuery.isRefetching || countsQuery.isRefetching}
          />
        }
      >
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
            <PrimaryButton
              label={t('home.retry')}
              onPress={() => {
                void listQuery.refetch();
                void countsQuery.refetch();
                void orgQuery.refetch();
              }}
            />
          </Banner>
        ) : null}

        {isShowingOfflineBanner && cachedSnapshot ? (
          <Banner tone="warn">
            <Body tone="warning">
              {t('conversations.offlineBanner', {
                time: formatDateTimeShort(cachedSnapshot.savedAt, locale),
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

        {isNetworkOffline && !cachedSnapshot ? (
          <Banner tone="danger">
            <Body tone="danger">{t('conversations.offlineNoCache')}</Body>
            <PrimaryButton
              label={t('home.retry')}
              onPress={() => {
                void listQuery.refetch();
                void countsQuery.refetch();
              }}
            />
          </Banner>
        ) : null}

        {!isNonNetworkError && !(isNetworkOffline && !cachedSnapshot) ? (
          <>
            <ScrollView
              accessibilityRole="tablist"
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {filterTabs.map((tab) => {
                const selected = filter === tab.id;
                const labelText =
                  tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label;
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

            {listQuery.isPending && activeItems === null ? (
              <View style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
                <ActivityIndicator accessibilityLabel={t('conversations.loading')} />
                <Body tone="muted">{t('conversations.loading')}</Body>
              </View>
            ) : !activeItems || activeItems.length === 0 ? (
              <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
                <SectionHeading>{t(`conversations.empty.${filter}`)}</SectionHeading>
                <Body tone="muted">{t('conversations.openWebHint')}</Body>
                <PrimaryButton
                  label={t('conversations.refresh')}
                  onPress={() => {
                    void listQuery.refetch();
                    void countsQuery.refetch();
                  }}
                />
              </View>
            ) : (
              <>
                {activeItems.map((conv) => {
                  const customerName = getContactDisplayName(conv.contact, (tail) =>
                    t('conversations.anonymous', { tail }),
                  );
                  const channelLabel = formatChannelProviderLabel(conv.channel.provider, conv.kind);
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
                    relTime,
                    winText,
                    conv.preview || t('conversations.noPreview'),
                  ]
                    .filter(Boolean)
                    .join(', ');

                  return (
                    <Pressable
                      key={conv.id}
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
                        {relTime ? (
                          <Text style={[styles.meta, { color: palette.muted }]}>{relTime}</Text>
                        ) : null}
                      </View>

                      <Text
                        numberOfLines={2}
                        style={[styles.body, { color: conv.preview ? palette.text : palette.muted }]}
                      >
                        {conv.preview || t('conversations.noPreview')}
                      </Text>

                      <View style={styles.actionsRow}>
                        <Badge label={channelLabel} tone="info" />
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
                })}

                {listQuery.hasNextPage && !isNetworkOffline ? (
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
              </>
            )}
          </>
        ) : null}

        <View style={{ marginTop: 12, alignItems: 'center', gap: 4 }}>
          <LinkButton label={t('home.signOut')} onPress={() => void session.signOut()} />
          <Text style={[styles.meta, { color: palette.muted, textAlign: 'center' }]}>
            {t('home.signOutHint')}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
