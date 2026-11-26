// SPDX-License-Identifier: AGPL-3.0-only
// Mobile Engage conversation thread view: Zalo 48h window clock, AI draft proposal, saved replies, and reply composer (issue #4882).

import { isMfaRequired } from '@ludy/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { normalizeServerUrl } from '../../config.ts';
import { externalBrowser } from '../../platform/browser.ts';
import { clientFor, conversationsCache, SERVER_POLICY, session, t } from '../../runtime.ts';
import {
  Badge,
  Banner,
  Body,
  LinkButton,
  PrimaryButton,
  SecondaryButton,
  SectionHeading,
  Title,
} from '../../ui/parts.tsx';
import { styles, usePalette } from '../../ui/theme.ts';
import { buildWebUrl, formatDateTimeShort, type Locale } from '../approvals/format.ts';
import {
  discardConversationDraft,
  markConversationRead,
  requestConversationDraft,
  sendConversationReply,
  type ConversationActionOutcome,
} from './actions.ts';
import type { CachedConversationThread } from './cache.ts';
import {
  buildConversationWebPath,
  evaluateReplyWindow,
  formatChannelProviderLabel,
  formatWindowDuration,
  getContactDisplayName,
  hasNamePlaceholder,
  isConversationForbiddenOrMissing,
  isLikelyNetworkError,
  replyTextFor,
  resolveKnownSendErrorCode,
  resolveReplyMax,
  SAVED_REPLY_NAME_PLACEHOLDER,
  type ConversationDetail,
  type ConversationMessage,
  type OrgMember,
  type OrgRole,
  type ReplyBlockReason,
} from './model.ts';

interface ConversationThreadScreenProps {
  conversationId: string;
  serverUrl: string;
  orgSlug: string;
  userId: string | null;
  role: OrgRole;
  locale: Locale;
  aiEnabled: boolean;
  salesCoworkerName: string;
  members: readonly OrgMember[];
  isListOffline?: boolean;
  onBack: () => void;
  onRefreshList: () => void;
}

const WINDOW_TICK_MS = 30_000;
const DRAFT_POLL_MS = 3_000;

function sendStateLabelKey(
  sendState: NonNullable<ConversationMessage['sendState']>,
):
  | 'conversations.sendState.queued'
  | 'conversations.sendState.sending'
  | 'conversations.sendState.sent'
  | 'conversations.sendState.failed'
  | 'conversations.sendState.unknown' {
  if (sendState === 'queued') return 'conversations.sendState.queued';
  if (sendState === 'sending') return 'conversations.sendState.sending';
  if (sendState === 'sent') return 'conversations.sendState.sent';
  if (sendState === 'failed') return 'conversations.sendState.failed';
  return 'conversations.sendState.unknown';
}

function blockReasonText(provider: string, reason: ReplyBlockReason): string {
  if (reason === 'window_closed') {
    if (provider === 'zalo_oa') return t('conversations.window.closedZalo');
    if (provider === 'whatsapp') return t('conversations.window.closedWhatsapp');
    return t('conversations.window.closedGeneric');
  }
  if (reason === 'channel_inactive') return t('conversations.blocked.channel_inactive');
  if (reason === 'business_stopped') return t('conversations.blocked.business_stopped');
  if (reason === 'business_read_only') return t('conversations.blocked.business_read_only');
  return t('conversations.blocked.not_supported');
}

export function ConversationThreadScreen(props: ConversationThreadScreenProps) {
  const {
    conversationId,
    serverUrl,
    orgSlug,
    userId,
    role,
    locale,
    aiEnabled,
    salesCoworkerName,
    members,
    isListOffline = false,
  } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [cachedThread, setCachedThread] = useState<CachedConversationThread | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [composerText, setComposerText] = useState('');
  const [replySource, setReplySource] = useState<{ draftId?: string; savedReplyId?: string }>({});
  const [busyAction, setBusyAction] = useState<'send' | 'draft_ask' | 'draft_discard' | null>(null);
  const [movedNotice, setMovedNotice] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string; showWeb?: boolean } | null>(null);

  const lastMarkedSeqRef = useRef<number | null>(null);
  const inFlightMarkSeqRef = useRef<number | null>(null);
  const onRefreshListRef = useRef(props.onRefreshList);
  onRefreshListRef.current = props.onRefreshList;

  useEffect(() => {
    let cancelled = false;
    setCachedThread(null);
    setCacheLoaded(false);
    setSeenSeq(null);
    setComposerText('');
    setReplySource({});
    setMovedNotice(false);
    setFeedback(null);
    lastMarkedSeqRef.current = null;
    inFlightMarkSeqRef.current = null;

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
          setCachedThread(snap?.threads[conversationId] ?? null);
          setCacheLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCachedThread(null);
          setCacheLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [serverUrl, orgSlug, userId, conversationId]);

  const detailQuery = useQuery<ConversationDetail>({
    queryKey: ['conversations', 'detail', serverUrl, orgSlug, userId ?? '', conversationId],
    queryFn: async ({ signal }) => {
      const startEpoch = conversationsCache.epoch();
      const live = await client.conversations.get({ conversationId });
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

      if (userId) {
        void conversationsCache
          .upsertThread({
            serverUrl,
            orgSlug,
            userId,
            savedAt: Date.now(),
            detail: live,
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
            setCachedThread(saved.threads[conversationId] ?? null);
          })
          .catch(() => undefined);
      }

      return live;
    },
    enabled: cacheLoaded,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || query.state.status === 'error') return false;
      return data.draft?.state === 'requested' ? DRAFT_POLL_MS : false;
    },
  });

  const isNetworkOffline = Boolean(
    isListOffline || (detailQuery.isError && isLikelyNetworkError(detailQuery.error)),
  );
  const isNonNetworkError = Boolean(detailQuery.isError && !isLikelyNetworkError(detailQuery.error));
  const liveDetail = isNonNetworkError ? undefined : detailQuery.data;
  const activeDetail = isNonNetworkError ? null : (liveDetail ?? cachedThread?.detail ?? null);
  const activeReplyWindowUntil = activeDetail?.conversation.replyWindowUntil ?? null;

  // Live ticking clock for Zalo 48h and platform reply windows; cleaned up cleanly on unmount.
  useEffect(() => {
    if (!activeReplyWindowUntil) return;
    setNowMs(Date.now());
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, WINDOW_TICK_MS);

    const untilMs = Date.parse(activeReplyWindowUntil);
    const msLeft = Number.isFinite(untilMs) ? untilMs - Date.now() : 0;
    const expiryTimer =
      msLeft > 0 && msLeft <= 60_000
        ? setTimeout(() => {
            setNowMs(Date.now());
          }, msLeft + 50)
        : null;

    return () => {
      clearInterval(interval);
      if (expiryTimer !== null) clearTimeout(expiryTimer);
    };
  }, [activeReplyWindowUntil]);

  // Initialize `seenSeq` from the first live thread load.
  useEffect(() => {
    if (liveDetail && seenSeq === null) {
      setSeenSeq(liveDetail.conversation.lastSeq);
    }
  }, [liveDetail, seenSeq]);

  // Best-effort markRead when opened online with unread messages, guarded against stale org/session switches.
  useEffect(() => {
    if (isNonNetworkError || isNetworkOffline || !liveDetail || !liveDetail.conversation.unread) {
      return;
    }
    const targetSeq = seenSeq ?? liveDetail.conversation.lastSeq;
    const highWater = Math.max(lastMarkedSeqRef.current ?? -1, inFlightMarkSeqRef.current ?? -1);
    if (targetSeq <= highWater) return;

    let cancelled = false;
    inFlightMarkSeqRef.current = targetSeq;
    const startedServer = serverUrl;
    const startedOrg = orgSlug;
    const startedConv = conversationId;

    void markConversationRead(
      {
        client,
        isOffline: isNetworkOffline,
        onKernelError: (err) => void session.reportKernelError(err),
      },
      { conversationId: startedConv, seq: targetSeq },
    )
      .then((res) => {
        if (cancelled) return;
        const cur = session.state();
        if (cur.status !== 'active' || cur.serverUrl !== startedServer || cur.orgSlug !== startedOrg) {
          return;
        }
        if (res.ok) {
          lastMarkedSeqRef.current = Math.max(lastMarkedSeqRef.current ?? -1, targetSeq);
          onRefreshListRef.current();
        }
      })
      .finally(() => {
        if (inFlightMarkSeqRef.current !== null && inFlightMarkSeqRef.current <= targetSeq) {
          inFlightMarkSeqRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    isNonNetworkError,
    isNetworkOffline,
    liveDetail,
    seenSeq,
    serverUrl,
    orgSlug,
    conversationId,
    client,
  ]);

  const onKernelError = (err: unknown) => {
    void session.reportKernelError(err);
  };

  async function handleOpenWeb() {
    const path = buildConversationWebPath(conversationId);
    const allowedOrigin = normalizeServerUrl(serverUrl);
    const url = path ? buildWebUrl(serverUrl, orgSlug, path, SERVER_POLICY) : null;
    if (!url || !allowedOrigin) {
      setFeedback({ tone: 'danger', text: t('approvals.outcome.webError') });
      return;
    }
    const opened = await externalBrowser.openWeb(url, allowedOrigin);
    if (!opened) {
      setFeedback({ tone: 'danger', text: t('approvals.outcome.webError') });
    }
  }

  function applyOutcomeFailure(outcome: Extract<ConversationActionOutcome<unknown>, { ok: false }>) {
    if (outcome.reason === 'auth') return;
    if (outcome.reason === 'kernel-step-up') {
      setFeedback({ tone: 'warn', text: t('stepUp.kernel'), showWeb: true });
      return;
    }
    if (outcome.reason === 'offline') {
      setFeedback({ tone: 'warn', text: t('conversations.networkRequired') });
      return;
    }
    if (outcome.reason === 'viewer') {
      setFeedback({ tone: 'warn', text: t('conversations.viewerReadOnly') });
      return;
    }
    if (outcome.reason === 'window-closed' || outcome.reason === 'blocked') {
      const provider = activeDetail?.conversation.channel.provider ?? '';
      setFeedback({
        tone: 'danger',
        text: blockReasonText(provider, outcome.blockReason ?? 'not_supported'),
      });
      return;
    }
    if (outcome.reason === 'placeholder') {
      setFeedback({
        tone: 'warn',
        text: t('conversations.composer.placeholderWarning', { placeholder: SAVED_REPLY_NAME_PLACEHOLDER }),
      });
      return;
    }
    if (outcome.reason === 'too-long') {
      setFeedback({
        tone: 'warn',
        text: t('conversations.composer.tooLong', { max: String(outcome.max ?? 8000) }),
      });
      return;
    }
    if (outcome.reason === 'invalid-char') {
      setFeedback({ tone: 'warn', text: t('conversations.composer.invalidChar') });
      return;
    }
    if (outcome.reason === 'rate-limited') {
      const text = outcome.retryAfterSeconds
        ? t('conversations.draft.rateLimitedWait', { seconds: String(outcome.retryAfterSeconds) })
        : t('conversations.draft.rateLimited');
      setFeedback({ tone: 'warn', text });
      return;
    }
    const detail = outcome.message || outcome.code || t('home.error.generic');
    setFeedback({ tone: 'danger', text: t('conversations.composer.refused', { detail }) });
  }

  async function onSendReply() {
    if (!liveDetail || busyAction !== null) return;
    setFeedback(null);
    setMovedNotice(false);
    setBusyAction('send');
    try {
      const outcome = await sendConversationReply(
        { client, isOffline: isNetworkOffline, now: () => Date.now(), onKernelError },
        {
          detail: liveDetail,
          body: composerText,
          lastSeenSeq: seenSeq ?? liveDetail.conversation.lastSeq,
          ...replySource,
          role,
        },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'moved') {
          // Keep user's composed text and source intact, refetch so the newly arrived message is visible.
          setMovedNotice(true);
          await detailQuery.refetch();
          return;
        }
        applyOutcomeFailure(outcome);
        return;
      }
      setComposerText('');
      setReplySource({});
      setMovedNotice(false);
      setSeenSeq(outcome.value.seq);
      setFeedback({ tone: 'info', text: t('conversations.composer.sent') });
      await qc.invalidateQueries({ queryKey: ['conversations', 'detail', serverUrl, orgSlug] });
      props.onRefreshList();
    } finally {
      setBusyAction(null);
    }
  }

  async function onRequestDraft() {
    if (!liveDetail || busyAction !== null) return;
    setFeedback(null);
    setBusyAction('draft_ask');
    try {
      const outcome = await requestConversationDraft(
        { client, isOffline: isNetworkOffline, onKernelError },
        { conversationId: liveDetail.conversation.id, role, aiEnabled: effectiveAiEnabled },
      );
      if (!outcome.ok) {
        applyOutcomeFailure(outcome);
        return;
      }
      await detailQuery.refetch();
    } finally {
      setBusyAction(null);
    }
  }

  async function onDiscardDraft(draftId: string) {
    if (busyAction !== null) return;
    setFeedback(null);
    setBusyAction('draft_discard');
    try {
      const outcome = await discardConversationDraft(
        { client, isOffline: isNetworkOffline, onKernelError },
        { draftId, role },
      );
      if (!outcome.ok) {
        applyOutcomeFailure(outcome);
        return;
      }
      if (replySource.draftId === draftId) {
        setReplySource({});
      }
      await detailQuery.refetch();
    } finally {
      setBusyAction(null);
    }
  }

  const effectiveAiEnabled = !isNetworkOffline && aiEnabled;
  const canWrite = role !== 'viewer';
  const windowState = activeDetail
    ? evaluateReplyWindow({
        replyWindowUntil: activeDetail.conversation.replyWindowUntil,
        reply: activeDetail.reply,
        nowMs,
      })
    : null;
  const replyMax = activeDetail
    ? resolveReplyMax(activeDetail.conversation.channel.provider, activeDetail.conversation.kind)
    : 8000;
  const trimmedBody = composerText.trim();
  const hasPlaceholderWarning = hasNamePlaceholder(composerText);
  const hasInvalidChar = composerText.includes('\u0000');
  const isTooLong = trimmedBody.length > replyMax;
  const canSendNow = Boolean(
    liveDetail &&
      !isNetworkOffline &&
      canWrite &&
      windowState?.allowed &&
      trimmedBody.length > 0 &&
      !hasPlaceholderWarning &&
      !hasInvalidChar &&
      !isTooLong &&
      busyAction === null,
  );

  const sortedMessages = useMemo(() => {
    if (!activeDetail) return [];
    return [...activeDetail.messages].sort((a, b) => a.seq - b.seq);
  }, [activeDetail]);

  const lastMessage = sortedMessages.at(-1);
  const canRequestAiDraft = Boolean(
    effectiveAiEnabled &&
      liveDetail &&
      !liveDetail.draft &&
      canWrite &&
      windowState?.allowed &&
      lastMessage?.direction === 'in' &&
      !lastMessage.removed,
  );

  const hasNewerUnseen = Boolean(liveDetail && seenSeq !== null && liveDetail.conversation.lastSeq > seenSeq);
  const channelLabel = activeDetail
    ? formatChannelProviderLabel(activeDetail.conversation.channel.provider, activeDetail.conversation.kind)
    : '';
  const contactDisplayName = activeDetail
    ? getContactDisplayName(activeDetail.conversation.contact, (tail) =>
        t('conversations.anonymous', { tail }),
      )
    : '';

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            onRefresh={() => void detailQuery.refetch()}
            refreshing={detailQuery.isRefetching}
          />
        }
      >
        <View style={styles.row}>
          <LinkButton
            label={t('conversations.back')}
            onPress={props.onBack}
            disabled={busyAction !== null}
          />
          <LinkButton
            label={t('conversations.openWeb')}
            accessibilityHint={t('conversations.openWebHint')}
            onPress={() => void handleOpenWeb()}
          />
        </View>

        {isNonNetworkError ? (
          <Banner tone="danger">
            <Body tone="danger">
              {isMfaRequired(detailQuery.error)
                ? t('home.error.mfa')
                : isConversationForbiddenOrMissing(detailQuery.error)
                  ? t('conversations.thread.refused')
                  : t('home.error.generic')}
            </Body>
            <SecondaryButton label={t('home.retry')} onPress={() => void detailQuery.refetch()} />
          </Banner>
        ) : null}

        {isNetworkOffline && activeDetail && cachedThread ? (
          <Banner tone="warn">
            <Body tone="warning">
              {t('conversations.offlineBanner', {
                time: formatDateTimeShort(cachedThread.cachedAt, locale),
              })}
            </Body>
          </Banner>
        ) : isNetworkOffline && !activeDetail ? (
          <Banner tone="warn">
            <Body tone="warning">{t('conversations.thread.offlineError')}</Body>
            <SecondaryButton label={t('home.retry')} onPress={() => void detailQuery.refetch()} />
          </Banner>
        ) : null}

        {detailQuery.isPending && !activeDetail && !isNonNetworkError ? (
          <View style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
            <ActivityIndicator accessibilityLabel={t('conversations.thread.loading')} />
            <Body tone="muted">{t('conversations.thread.loading')}</Body>
          </View>
        ) : null}

        {activeDetail ? (
          <>
            <View style={{ gap: 6 }}>
              <Title>{contactDisplayName}</Title>
              <View style={styles.actionsRow}>
                <Badge label={channelLabel} tone="info" />
                {activeDetail.conversation.channel.displayName ? (
                  <Badge label={activeDetail.conversation.channel.displayName} tone="info" />
                ) : null}
                <Badge
                  label={t(`conversations.status.${activeDetail.conversation.status}`)}
                  tone={activeDetail.conversation.status === 'new' ? 'warn' : 'info'}
                />
              </View>
              {activeDetail.conversation.kind === 'email' && activeDetail.conversation.contact.address ? (
                <Text style={[styles.meta, { color: palette.muted }]}>
                  {activeDetail.conversation.contact.address}
                </Text>
              ) : null}
              {activeDetail.conversation.kind === 'email' && activeDetail.conversation.subject ? (
                <Text style={[styles.cardTitle, { color: palette.text }]}>
                  {activeDetail.conversation.subject}
                </Text>
              ) : null}
              {activeDetail.conversation.kind === 'email' && activeDetail.conversation.senderUnverified ? (
                <Banner tone="warn">
                  <Body tone="warning">{t('conversations.thread.unverifiedEmail')}</Body>
                </Banner>
              ) : null}
            </View>

            {windowState && !windowState.allowed ? (
              <Banner tone="danger">
                <Body tone="danger">
                  {blockReasonText(
                    activeDetail.conversation.channel.provider,
                    windowState.blockReason ?? 'not_supported',
                  )}
                </Body>
              </Banner>
            ) : windowState && windowState.hasWindow && windowState.remainingMs !== null ? (
              <Banner tone={windowState.urgent ? 'warn' : 'info'}>
                <Body tone={windowState.urgent ? 'warning' : 'normal'}>
                  {activeDetail.conversation.channel.provider === 'zalo_oa'
                    ? t('conversations.window.openZalo', {
                        remaining: formatWindowDuration(windowState.remainingMs, locale),
                      })
                    : t('conversations.window.openChannel', {
                        channel: channelLabel,
                        remaining: formatWindowDuration(windowState.remainingMs, locale),
                      })}
                </Body>
              </Banner>
            ) : null}

            {activeDetail.gap ? (
              <Banner tone="info">
                <Body tone="muted">
                  {t('conversations.thread.gap', {
                    from: formatDateTimeShort(activeDetail.gap.from, locale),
                    to: formatDateTimeShort(activeDetail.gap.to, locale),
                  })}
                </Body>
              </Banner>
            ) : null}

            {!canWrite ? (
              <Banner tone="info">
                <Body tone="muted">{t('conversations.viewerReadOnly')}</Body>
              </Banner>
            ) : null}

            {feedback ? (
              <Banner tone={feedback.tone}>
                <Body
                  tone={
                    feedback.tone === 'danger'
                      ? 'danger'
                      : feedback.tone === 'warn'
                        ? 'warning'
                        : 'normal'
                  }
                >
                  {feedback.text}
                </Body>
                {feedback.showWeb ? (
                  <SecondaryButton label={t('conversations.openWeb')} onPress={() => void handleOpenWeb()} />
                ) : null}
              </Banner>
            ) : null}

            <View style={{ gap: 10 }}>
              {sortedMessages.map((msg) => {
                const isOutbound = msg.direction === 'out';
                const member = msg.authorUserId
                  ? members.find((m) => m.userId === msg.authorUserId)
                  : undefined;
                const authorLabel = isOutbound
                  ? msg.authorKind === 'member'
                    ? msg.authorUserId && msg.authorUserId === userId
                      ? t('conversations.message.you')
                      : member?.displayName || member?.email || t('conversations.message.member')
                    : t('conversations.message.platform')
                  : msg.authorName ||
                    (msg.authorTail
                      ? t('conversations.anonymous', { tail: msg.authorTail })
                      : contactDisplayName);

                return (
                  <View
                    key={msg.id}
                    style={[
                      styles.card,
                      {
                        alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                        width: '90%',
                        borderColor: isOutbound ? palette.primary : palette.border,
                        backgroundColor: isOutbound ? palette.badgeBg : palette.surface,
                        opacity: msg.hidden ? 0.72 : 1,
                      },
                    ]}
                  >
                    <View style={styles.row}>
                      <Text
                        style={[
                          styles.meta,
                          { color: isOutbound ? palette.badgeText : palette.muted, fontWeight: '600' },
                        ]}
                      >
                        {authorLabel}
                      </Text>
                      <Text style={[styles.meta, { color: isOutbound ? palette.badgeText : palette.muted }]}>
                        {formatDateTimeShort(msg.sentAt, locale)}
                      </Text>
                    </View>

                    {msg.removed ? (
                      <Text style={[styles.body, { color: palette.muted, fontStyle: 'italic' }]}>
                        {t('conversations.message.removed')}
                      </Text>
                    ) : msg.body ? (
                      <Text style={[styles.body, { color: palette.text }]}>{msg.body}</Text>
                    ) : null}

                    {!msg.removed && msg.attachments.length > 0 ? (
                      <Text style={[styles.meta, { color: palette.muted }]}>
                        {t('conversations.message.attachments', { count: String(msg.attachments.length) })}
                      </Text>
                    ) : null}

                    {(isOutbound && msg.sendState) || msg.hidden ? (
                      <View style={styles.actionsRow}>
                        {isOutbound && msg.sendState ? (
                          <Badge
                            label={t(sendStateLabelKey(msg.sendState))}
                            tone={
                              msg.sendState === 'failed'
                                ? 'danger'
                                : msg.sendState === 'unknown'
                                  ? 'warn'
                                  : msg.sendState === 'sent'
                                    ? 'success'
                                    : 'info'
                            }
                          />
                        ) : null}
                        {msg.hidden ? (
                          <Badge label={t('conversations.message.hidden')} tone="warn" />
                        ) : null}
                      </View>
                    ) : null}

                    {isOutbound && (msg.sendState === 'failed' || msg.sendState === 'unknown') ? (
                      <View style={{ gap: 2 }}>
                        {(() => {
                          const knownCode = resolveKnownSendErrorCode(msg.sendErrorCode);
                          const messageText = knownCode
                            ? t(`conversations.sendError.${knownCode}`)
                            : msg.sendState === 'unknown'
                              ? t('conversations.sendError.unknown')
                              : t('conversations.sendError.generic');
                          return (
                            <Text
                              style={[
                                styles.meta,
                                { color: msg.sendState === 'failed' ? palette.danger : palette.warning },
                              ]}
                            >
                              {messageText}
                            </Text>
                          );
                        })()}
                        {msg.sendErrorCode ? (
                          <Text style={[styles.meta, { color: palette.muted }]}>
                            {t('conversations.sendError.code', { code: msg.sendErrorCode })}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>

            {movedNotice ? (
              <Banner tone="warn">
                <Body tone="warning">{t('conversations.composer.moved')}</Body>
                {hasNewerUnseen && liveDetail ? (
                  <SecondaryButton
                    label={t('conversations.thread.seenIt')}
                    onPress={() => {
                      setSeenSeq(liveDetail.conversation.lastSeq);
                      setMovedNotice(false);
                    }}
                  />
                ) : null}
              </Banner>
            ) : hasNewerUnseen && liveDetail ? (
              <Banner tone="info">
                <Body>{t('conversations.thread.newerBanner')}</Body>
                <SecondaryButton
                  label={t('conversations.thread.seenIt')}
                  onPress={() => setSeenSeq(liveDetail.conversation.lastSeq)}
                />
              </Banner>
            ) : null}

            {canWrite && windowState?.allowed ? (
              <View style={{ gap: 12, marginTop: 4 }}>
                {effectiveAiEnabled && (activeDetail.draft || canRequestAiDraft) ? (
                  <Text style={[styles.meta, { color: palette.muted }]}>
                    {t('conversations.draft.intro', { sales: salesCoworkerName })}
                  </Text>
                ) : null}

                {activeDetail.draft?.state === 'requested' ? (
                  <Banner tone="info">
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <ActivityIndicator accessibilityLabel={t('conversations.draft.writing')} />
                      <Body tone="muted">{t('conversations.draft.writing')}</Body>
                    </View>
                  </Banner>
                ) : null}

                {activeDetail.draft?.state === 'live' && activeDetail.draft.body !== null ? (
                  <View
                    accessibilityRole="summary"
                    style={[
                      styles.card,
                      {
                        borderColor: palette.primary,
                        borderStyle: 'dashed',
                        borderWidth: 1.5,
                        backgroundColor: palette.surface,
                      },
                    ]}
                  >
                    <Badge
                      label={t('conversations.draft.title', { sales: salesCoworkerName })}
                      tone="info"
                    />
                    <Text style={[styles.meta, { color: palette.muted }]}>
                      {t('conversations.draft.taintedNotice')}
                    </Text>
                    <Text style={[styles.body, { color: palette.text }]}>{activeDetail.draft.body}</Text>
                    <View style={styles.actionsRow}>
                      <SecondaryButton
                        label={t('conversations.draft.use')}
                        disabled={busyAction !== null}
                        onPress={() => {
                          const body = activeDetail.draft?.body ?? '';
                          setComposerText(replyTextFor(body, activeDetail));
                          setReplySource(activeDetail.draft ? { draftId: activeDetail.draft.id } : {});
                          setFeedback(null);
                        }}
                      />
                      <LinkButton
                        label={t('conversations.draft.discard')}
                        disabled={busyAction !== null || isNetworkOffline}
                        onPress={() => {
                          if (activeDetail.draft) void onDiscardDraft(activeDetail.draft.id);
                        }}
                      />
                    </View>
                  </View>
                ) : null}

                {canRequestAiDraft ? (
                  <SecondaryButton
                    label={t('conversations.draft.ask')}
                    busy={busyAction === 'draft_ask'}
                    disabled={busyAction !== null || isNetworkOffline}
                    onPress={() => void onRequestDraft()}
                  />
                ) : null}

                {activeDetail.suggestions.length > 0 ? (
                  <View style={{ gap: 8 }}>
                    <Text style={[styles.meta, { color: palette.muted }]}>
                      {t('conversations.draft.suggestions')}
                    </Text>
                    <View style={styles.actionsRow}>
                      {activeDetail.suggestions.map((s) => (
                        <Pressable
                          key={s.id}
                          accessibilityRole="button"
                          accessibilityLabel={s.title}
                          disabled={busyAction !== null}
                          onPress={() => {
                            setComposerText(replyTextFor(s.body, activeDetail));
                            setReplySource({ savedReplyId: s.id });
                            setFeedback(null);
                          }}
                          style={{
                            minHeight: 48,
                            paddingHorizontal: 14,
                            paddingVertical: 10,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: palette.border,
                            backgroundColor: palette.surface,
                            justifyContent: 'center',
                          }}
                        >
                          <Text style={{ fontSize: 14, fontWeight: '600', color: palette.text }}>
                            {s.title}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : null}

                <View style={{ gap: 8 }}>
                  <SectionHeading>{t('conversations.composer.label')}</SectionHeading>
                  <TextInput
                    accessibilityLabel={t('conversations.composer.label')}
                    multiline
                    value={composerText}
                    onChangeText={(next) => {
                      setComposerText(next);
                      if (next === '') setReplySource({});
                    }}
                    placeholder={t('conversations.composer.placeholder')}
                    placeholderTextColor={palette.muted}
                    editable={busyAction !== 'send'}
                    style={[
                      styles.input,
                      {
                        minHeight: 96,
                        textAlignVertical: 'top',
                        borderColor:
                          hasPlaceholderWarning || hasInvalidChar || isTooLong
                            ? palette.danger
                            : palette.border,
                        color: palette.text,
                        backgroundColor: palette.surface,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.meta,
                      { color: isTooLong ? palette.danger : palette.muted },
                    ]}
                  >
                    {t('conversations.composer.count', {
                      left: String(Math.max(0, replyMax - trimmedBody.length)),
                      max: String(replyMax),
                    })}
                  </Text>
                  {hasPlaceholderWarning ? (
                    <Text style={[styles.meta, { color: palette.danger }]}>
                      {t('conversations.composer.placeholderWarning', {
                        placeholder: SAVED_REPLY_NAME_PLACEHOLDER,
                      })}
                    </Text>
                  ) : null}
                  {hasInvalidChar ? (
                    <Text style={[styles.meta, { color: palette.danger }]}>
                      {t('conversations.composer.invalidChar')}
                    </Text>
                  ) : null}
                  {isTooLong ? (
                    <Text style={[styles.meta, { color: palette.danger }]}>
                      {t('conversations.composer.tooLong', { max: String(replyMax) })}
                    </Text>
                  ) : null}

                  <PrimaryButton
                    label={
                      busyAction === 'send'
                        ? t('conversations.composer.sending')
                        : t('conversations.composer.send')
                    }
                    busy={busyAction === 'send'}
                    disabled={!canSendNow}
                    onPress={() => void onSendReply()}
                  />
                </View>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
