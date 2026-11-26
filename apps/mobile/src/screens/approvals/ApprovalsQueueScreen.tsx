// SPDX-License-Identifier: AGPL-3.0-only
// Cross-app mobile approvals queue with offline read cache, AI coworker attribution and web hand-off (issue #4881).

import { isMfaRequired } from '@ludy/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { approvalsCache, clientFor, SERVER_POLICY, session, t } from '../../runtime.ts';
import { Badge, Banner, Body, LinkButton, PrimaryButton, SectionHeading, Title } from '../../ui/parts.tsx';
import { styles, usePalette } from '../../ui/theme.ts';
import { ApprovalDetailScreen } from './ApprovalDetailScreen.tsx';
import type { CachedApprovalsSnapshot, CachedTodayNotice } from './cache.ts';
import {
  buildWebUrl,
  formatDateShort,
  formatDateTimeShort,
  formatMoney,
  type Locale,
} from './format.ts';
import {
  isLikelyNetworkError,
  loadApprovalsSnapshot,
  type LiveApprovalsSnapshot,
  type OrgDetail,
} from './model.ts';
import {
  filterQueueItems,
  formatTodayNoticeTitle,
  type QueueFilter,
} from './view-state.ts';

export interface ApprovalsQueueScreenProps {
  serverUrl: string;
  orgSlug: string;
  orgName: string;
  role: OrgDetail['role'];
  userId: string | null;
  locale: Locale;
  canSwitchOrg: boolean;
  onSwitchOrg: () => void;
}

export function ApprovalsQueueScreen(props: ApprovalsQueueScreenProps) {
  const { serverUrl, orgSlug, orgName, role, userId, locale } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [cachedSnapshot, setCachedSnapshot] = useState<CachedApprovalsSnapshot | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCachedSnapshot(null);
    setSelectedKey(null);
    setBannerMessage(null);
    setFilter('all');
    setCacheLoaded(false);

    if (!userId) {
      setCacheLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    void approvalsCache
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

  const queueQuery = useQuery<LiveApprovalsSnapshot>({
    queryKey: ['approvals', serverUrl, orgSlug, userId ?? ''],
    queryFn: async ({ signal }) => {
      const startEpoch = approvalsCache.epoch();
      const live = await loadApprovalsSnapshot({ client, serverUrl, orgSlug });
      if (signal.aborted) {
        throw new Error('aborted');
      }
      const cur = session.state();
      const stillSameActiveSession =
        cur.status === 'active' &&
        cur.serverUrl === serverUrl &&
        cur.orgSlug === orgSlug &&
        (!userId || live.userId === userId) &&
        approvalsCache.epoch() === startEpoch;

      if (!stillSameActiveSession) {
        throw new Error('stale-session');
      }

      // Persistence errors must never discard live server results; stale epoch saves are ignored by cache.
      void approvalsCache
        .save(
          {
            serverUrl: live.serverUrl,
            orgSlug: live.orgSlug,
            userId: live.userId,
            savedAt: live.savedAt,
            items: live.items,
            todayNotices: live.todayNotices,
            coworkers: live.coworkers,
          },
          { expectedEpoch: startEpoch },
        )
        .then((saved) => {
          if (!saved || signal.aborted) return;
          const after = session.state();
          if (
            after.status === 'active' &&
            after.serverUrl === serverUrl &&
            after.orgSlug === orgSlug &&
            (!userId || live.userId === userId)
          ) {
            setCachedSnapshot({
              v: 1,
              serverUrl: live.serverUrl,
              orgSlug: live.orgSlug,
              userId: live.userId,
              savedAt: live.savedAt,
              items: live.items,
              todayNotices: live.todayNotices,
              coworkers: live.coworkers,
            });
          }
        })
        .catch(() => undefined);
      return live;
    },
    enabled: cacheLoaded,
  });

  const isNetworkOffline = Boolean(queueQuery.isError && isLikelyNetworkError(queueQuery.error));
  const isNonNetworkError = Boolean(queueQuery.isError && !isNetworkOffline);
  const liveData = isNonNetworkError ? undefined : queueQuery.data;
  const activeSnapshot = isNonNetworkError ? null : (liveData ?? cachedSnapshot);
  const isShowingOfflineBanner = Boolean(isNetworkOffline && activeSnapshot !== null);
  const isCachedPreview = !liveData || isNetworkOffline;

  const items = activeSnapshot?.items ?? [];
  const todayNotices = activeSnapshot?.todayNotices ?? [];

  const filteredItems = useMemo(() => filterQueueItems(items, filter), [items, filter]);

  const selectedSummary = useMemo(
    () => (selectedKey ? items.find((i) => i.key === selectedKey) ?? null : null),
    [items, selectedKey],
  );

  async function openWebPath(path: string) {
    const allowedOrigin = normalizeServerUrl(serverUrl);
    const url = buildWebUrl(serverUrl, orgSlug, path, SERVER_POLICY);
    if (!url || !allowedOrigin) {
      setBannerMessage(t('approvals.outcome.webError'));
      return;
    }
    const opened = await externalBrowser.openWeb(url, allowedOrigin);
    if (!opened) setBannerMessage(t('approvals.outcome.webError'));
  }

  if (selectedSummary && !isNonNetworkError) {
    return (
      <ApprovalDetailScreen
        coworkers={activeSnapshot?.coworkers}
        currentUserId={userId}
        isCachedPreview={isCachedPreview}
        isOffline={isNetworkOffline || isShowingOfflineBanner}
        liveExtra={liveData?.liveByKey[selectedSummary.key]}
        locale={locale}
        onBack={() => setSelectedKey(null)}
        onCompleted={(msg) => {
          setSelectedKey(null);
          setBannerMessage(msg);
          void qc.invalidateQueries({ queryKey: ['approvals', serverUrl, orgSlug] });
        }}
        orgSlug={orgSlug}
        role={liveData?.role ?? role}
        serverUrl={serverUrl}
        summary={selectedSummary}
      />
    );
  }

  const filterChips: Array<{ id: QueueFilter; label: string }> = [
    { id: 'all', label: t('approvals.filter.all') },
    { id: 'finance', label: t('approvals.filter.finance') },
    { id: 'hr', label: t('approvals.filter.hr') },
    { id: 'social', label: t('approvals.filter.social') },
    { id: 'engage', label: t('approvals.filter.engage') },
  ];

  function noticeKindLabel(kind: CachedTodayNotice['kind']): string {
    if (kind === 'flag') return t('approvals.today.kind.flag');
    if (kind === 'deadline') return t('approvals.today.kind.deadline');
    if (kind === 'message') return t('approvals.today.kind.message');
    return t('approvals.today.kind.proposal');
  }

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background, paddingTop: 16 }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            onRefresh={() => void queueQuery.refetch()}
            refreshing={queueQuery.isRefetching}
          />
        }
      >
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Title>{t('approvals.title')}</Title>
            <Text style={[styles.meta, { color: palette.muted }]}>{t('home.org', { org: orgName })}</Text>
          </View>
          {props.canSwitchOrg ? (
            <LinkButton label={t('approvals.orgSwitch')} onPress={props.onSwitchOrg} />
          ) : null}
        </View>

        <Body tone="muted">{t('approvals.subtitle')}</Body>

        {bannerMessage ? (
          <Banner tone="info">
            <Body>{bannerMessage}</Body>
          </Banner>
        ) : null}

        {isNonNetworkError ? (
          <Banner tone="danger">
            <Body tone="danger">
              {isMfaRequired(queueQuery.error) ? t('home.error.mfa') : t('home.error.generic')}
            </Body>
            <PrimaryButton label={t('home.retry')} onPress={() => void queueQuery.refetch()} />
          </Banner>
        ) : null}

        {isShowingOfflineBanner && activeSnapshot ? (
          <Banner tone="warn">
            <Body tone="warning">
              {t('approvals.offlineBanner', {
                time: formatDateTimeShort(activeSnapshot.savedAt, locale),
              })}
            </Body>
          </Banner>
        ) : activeSnapshot ? (
          <Text style={[styles.meta, { color: palette.muted }]}>
            {`${t('approvals.count', { count: String(items.length) })} | ${t('approvals.cachedHint', {
              time: formatDateTimeShort(activeSnapshot.savedAt, locale),
            })}`}
          </Text>
        ) : null}

        {liveData && liveData.partialFailureCount > 0 ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.partialWarning')}</Body>
          </Banner>
        ) : null}

        {isNetworkOffline && !activeSnapshot ? (
          <Banner tone="danger">
            <Body tone="danger">{t('home.error.generic')}</Body>
            <PrimaryButton label={t('home.retry')} onPress={() => void queueQuery.refetch()} />
          </Banner>
        ) : null}

        {!isNonNetworkError ? (
          <>
            <ScrollView
              accessibilityRole="tablist"
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {filterChips.map((chip) => {
                const selected = filter === chip.id;
                return (
                  <Pressable
                    key={chip.id}
                    accessibilityRole="tab"
                    accessibilityLabel={chip.label}
                    accessibilityState={{ selected }}
                    onPress={() => setFilter(chip.id)}
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 14,
                      borderRadius: 22,
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
                      {chip.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {queueQuery.isPending && !activeSnapshot ? (
              <View style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
                <ActivityIndicator accessibilityLabel={t('approvals.loading')} />
                <Body tone="muted">{t('approvals.loading')}</Body>
              </View>
            ) : filteredItems.length === 0 ? (
              <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
                <SectionHeading>{t('approvals.emptyTitle')}</SectionHeading>
                <Body tone="muted">{t('approvals.emptyBody')}</Body>
                <PrimaryButton label={t('approvals.refresh')} onPress={() => void queueQuery.refetch()} />
              </View>
            ) : (
              filteredItems.map((item) => {
                const amountText = item.amount
                  ? formatMoney(item.amount, item.currency, locale)
                  : null;
                const dateText = item.dateLabel
                  ? formatDateShort(item.dateLabel, locale)
                  : formatDateTimeShort(item.createdAt, locale);

                const accessibilitySummary = [
                  item.title,
                  item.counterparty,
                  amountText,
                  item.aiCoworker ? t('approvals.ai.preparedBy', { name: item.aiCoworker.label }) : null,
                  item.requiresStepUp ? t('approvals.badge.stepUp') : null,
                  item.failedChecks > 0
                    ? t('approvals.badge.failedChecks', { count: String(item.failedChecks) })
                    : null,
                  item.warnChecks > 0
                    ? t('approvals.badge.warnChecks', { count: String(item.warnChecks) })
                    : null,
                  (item.anomalyChecks ?? 0) > 0
                    ? t('approvals.badge.anomalyChecks', { count: String(item.anomalyChecks ?? 0) })
                    : null,
                  item.unclassifiedLines > 0
                    ? t('approvals.badge.unclassified', { count: String(item.unclassifiedLines) })
                    : null,
                  item.multiDecisionOnly ? t('approvals.badge.webOnlyA11y') : null,
                ]
                  .filter(Boolean)
                  .join(', ');

                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilitySummary}
                    onPress={() => {
                      setBannerMessage(null);
                      setSelectedKey(item.key);
                    }}
                    style={[
                      styles.card,
                      { borderColor: palette.border, backgroundColor: palette.surface, minHeight: 72 },
                    ]}
                  >
                    <View style={styles.row}>
                      <Text style={[styles.cardTitle, { color: palette.text, flex: 1 }]}>{item.title}</Text>
                      {amountText ? (
                        <Text style={[styles.amount, { color: palette.text }]}>{amountText}</Text>
                      ) : null}
                    </View>

                    {item.counterparty ? (
                      <Text style={[styles.meta, { color: palette.text }]}>{item.counterparty}</Text>
                    ) : item.subtitle ? (
                      <Text style={[styles.meta, { color: palette.muted }]}>{item.subtitle}</Text>
                    ) : null}

                    {dateText ? (
                      <Text style={[styles.meta, { color: palette.muted }]}>{dateText}</Text>
                    ) : null}

                    <View style={styles.actionsRow}>
                      {item.aiCoworker ? (
                        <Badge
                          label={t('approvals.ai.preparedBy', { name: item.aiCoworker.label })}
                          tone="info"
                        />
                      ) : null}
                      {item.requiresStepUp ? <Badge label={t('approvals.badge.stepUp')} tone="info" /> : null}
                      {item.failedChecks > 0 ? (
                        <Badge
                          label={t('approvals.badge.failedChecks', { count: String(item.failedChecks) })}
                          tone="danger"
                        />
                      ) : null}
                      {item.warnChecks > 0 ? (
                        <Badge
                          label={t('approvals.badge.warnChecks', { count: String(item.warnChecks) })}
                          tone="warn"
                        />
                      ) : null}
                      {item.anomalyChecks && item.anomalyChecks > 0 ? (
                        <Badge
                          label={t('approvals.badge.anomalyChecks', { count: String(item.anomalyChecks) })}
                          tone="warn"
                        />
                      ) : null}
                      {item.unclassifiedLines > 0 ? (
                        <Badge
                          label={t('approvals.badge.unclassified', { count: String(item.unclassifiedLines) })}
                          tone="warn"
                        />
                      ) : null}
                      {item.multiDecisionOnly ? (
                        <Badge label={t('approvals.badge.webOnly')} tone="warn" />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })
            )}

            {todayNotices.length > 0 ? (
              <View style={{ gap: 10, marginTop: 8 }}>
                <SectionHeading>{t('approvals.today.heading')}</SectionHeading>
                {todayNotices.map((notice) => {
                  const titleText = formatTodayNoticeTitle(notice, locale);
                  return (
                    <View
                      key={notice.key}
                      style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}
                    >
                      <View style={styles.row}>
                        <Badge
                          label={`${noticeKindLabel(notice.kind)} (${notice.app})`}
                          tone={
                            notice.severity === 'block'
                              ? 'danger'
                              : notice.severity === 'warn'
                                ? 'warn'
                                : 'info'
                          }
                        />
                        {notice.amount ? (
                          <Text style={[styles.amount, { color: palette.text }]}>
                            {formatMoney(notice.amount, notice.currency ?? 'VND', locale)}
                          </Text>
                        ) : null}
                      </View>
                      <Body>{titleText}</Body>
                      <View style={styles.actionsRow}>
                        {notice.aiCoworkerLabel ? (
                          <Badge
                            label={t('approvals.ai.preparedBy', { name: notice.aiCoworkerLabel })}
                            tone="info"
                          />
                        ) : null}
                        {notice.count ? (
                          <Badge
                            label={t('approvals.today.countHint', { count: String(notice.count) })}
                            tone="info"
                          />
                        ) : null}
                        {notice.dueAt ? (
                          <Badge
                            label={t('approvals.today.dueAt', { date: formatDateShort(notice.dueAt, locale) })}
                            tone="warn"
                          />
                        ) : null}
                      </View>
                      <LinkButton
                        label={t('approvals.action.openWeb')}
                        accessibilityLabel={`${t('approvals.action.openWeb')}: ${titleText}`}
                        onPress={() => void openWebPath(notice.webPath)}
                      />
                    </View>
                  );
                })}
              </View>
            ) : null}
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
