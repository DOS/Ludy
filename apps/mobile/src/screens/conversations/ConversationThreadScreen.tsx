// SPDX-License-Identifier: AGPL-3.0-only
// Mobile Engage conversation thread view: Zalo 48h window clock, AI draft proposal, saved replies, and reply composer (issue #4882).

import { isMfaRequired } from '@ludy/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
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
  fetchDeploymentAiEnabled,
  formatChannelProviderLabel,
  formatWindowDuration,
  getContactDisplayName,
  hasNamePlaceholder,
  isAccessRefusalError,
  isAuthBlockingError,
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
  isVisible?: boolean;
  onBack: () => void;
  onRefreshList: () => void;
}

const WINDOW_TICK_MS = 30_000;
const DRAFT_POLL_MS = 3_000;
const THREAD_POLL_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function MessageRowSeparator() {
  return <View style={{ height: 10 }} />;
}

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
    isVisible = true,
  } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [cachedThread, setCachedThread] = useState<CachedConversationThread | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isAppActive, setIsAppActive] = useState(() => AppState.currentState === 'active');
  const isThreadShown = isVisible && isAppActive;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setIsAppActive(next === 'active');
    });
    return () => subscription.remove();
  }, []);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [composerText, setComposerText] = useState('');
  const [replySource, setReplySource] = useState<{ draftId?: string; savedReplyId?: string }>({});
  const [busyAction, setBusyAction] = useState<'send' | 'draft_ask' | 'draft_discard' | null>(null);
  const [movedNotice, setMovedNotice] = useState(false);
  const [accessDeniedError, setAccessDeniedError] = useState<unknown>(null);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string; showWeb?: boolean } | null>(null);

  const lastMarkedSeqRef = useRef<number | null>(null);
  const inFlightMarkSeqRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const activeScopeKeyRef = useRef(`${serverUrl}:${orgSlug}:${conversationId}`);
  activeScopeKeyRef.current = `${serverUrl}:${orgSlug}:${conversationId}`;
  const onRefreshListRef = useRef(props.onRefreshList);
  onRefreshListRef.current = props.onRefreshList;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCachedThread(null);
    setCacheLoaded(false);
    setSeenSeq(null);
    setComposerText('');
    setReplySource({});
    setMovedNotice(false);
    setAccessDeniedError(null);
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

  const detailQueryKey = useMemo(
    () => ['conversations', 'detail', serverUrl, orgSlug, userId ?? '', conversationId] as const,
    [serverUrl, orgSlug, userId, conversationId],
  );

  const detailQuery = useQuery<ConversationDetail>({
    queryKey: detailQueryKey,
    retry: false,
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
            setCachedThread(saved.threads[conversationId] ?? null);
          })
          .catch(() => undefined);
      }

      return live;
    },
    enabled: cacheLoaded && accessDeniedError === null,
    refetchInterval: (query) => {
      if (!isThreadShown || accessDeniedError !== null) return false;
      if (query.state.status === 'error') {
        return isAccessRefusalError(query.state.error) ? false : THREAD_POLL_MS;
      }
      const data = query.state.data;
      if (!data) return false;
      const hasPendingDraft = data.draft?.state === 'requested';
      const hasPendingSend = data.messages.some(
        (m) => m.direction === 'out' && (m.sendState === 'queued' || m.sendState === 'sending'),
      );
      return hasPendingDraft || hasPendingSend ? DRAFT_POLL_MS : THREAD_POLL_MS;
    },
  });

  const refetchDetailRef = useRef(detailQuery.refetch);
  refetchDetailRef.current = detailQuery.refetch;
  const wasThreadShownRef = useRef(isThreadShown);
  useEffect(() => {
    const wasShown = wasThreadShownRef.current;
    wasThreadShownRef.current = isThreadShown;
    if (!wasShown && isThreadShown && cacheLoaded && accessDeniedError === null) {
      void refetchDetailRef.current();
    }
  }, [isThreadShown, cacheLoaded, accessDeniedError]);

  // Clear latched access denial once a fresh live read succeeds; purge caches cleanly on 403/404 or auth refusal.
  useEffect(() => {
    if (!detailQuery.isError && detailQuery.data) {
      setAccessDeniedError(null);
      return;
    }
    if (!detailQuery.isError || isLikelyNetworkError(detailQuery.error)) return;
    const err = detailQuery.error;
    if (isAuthBlockingError(err)) {
      void session.reportKernelError(err);
      setAccessDeniedError(err);
      setCachedThread(null);
      void conversationsCache.clearScope({ serverUrl, orgSlug, userId });
      qc.removeQueries({ queryKey: ['conversations', 'list', serverUrl, orgSlug] });
      qc.removeQueries({ queryKey: ['conversations', 'detail', serverUrl, orgSlug] });
      qc.removeQueries({ queryKey: ['conversations', 'counts', serverUrl, orgSlug] });
      return;
    }
    if (isConversationForbiddenOrMissing(err)) {
      setAccessDeniedError(err);
      setCachedThread(null);
      void conversationsCache.evictThread({
        serverUrl,
        orgSlug,
        userId,
        conversationId,
        expectedEpoch: conversationsCache.epoch(),
        isSessionStillActive: () => {
          const after = session.state();
          return after.status === 'active' && after.serverUrl === serverUrl && after.orgSlug === orgSlug;
        },
      });
      qc.removeQueries({ queryKey: detailQueryKey, exact: true });
      onRefreshListRef.current();
    }
  }, [detailQuery.isError, detailQuery.data, detailQuery.error, serverUrl, orgSlug, userId, conversationId, qc, detailQueryKey]);

  const aiConfigQuery = useQuery<boolean>({
    queryKey: ['server-config-ai', serverUrl],
    queryFn: () => fetchDeploymentAiEnabled(serverUrl, { forceRefresh: true }),
    staleTime: 60_000,
    retry: false,
  });

  const retriedAiConfigRef = useRef(false);
  useEffect(() => {
    retriedAiConfigRef.current = false;
  }, [serverUrl, orgSlug, conversationId]);

  const isNetworkOffline = Boolean(detailQuery.isError && isLikelyNetworkError(detailQuery.error));
  const rawError = detailQuery.error ?? accessDeniedError;
  const isNonNetworkError = Boolean(
    accessDeniedError !== null || (detailQuery.isError && !isLikelyNetworkError(detailQuery.error)),
  );
  const liveDetail = isNonNetworkError || isNetworkOffline ? undefined : detailQuery.data;
  // Wait for permission verification before revealing cached messages; only fall back to cache once offline error is confirmed.
  const activeDetail = isNonNetworkError
    ? null
    : (liveDetail ?? (isNetworkOffline ? (cachedThread?.detail ?? null) : null));
  const activeReplyWindowUntil = activeDetail?.conversation.replyWindowUntil ?? null;

  useEffect(() => {
    if (liveDetail && aiConfigQuery.data !== true && !aiConfigQuery.isFetching && !retriedAiConfigRef.current) {
      retriedAiConfigRef.current = true;
      void aiConfigQuery.refetch();
    }
  }, [liveDetail, aiConfigQuery]);

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
      msLeft > 0 && msLeft < MAX_TIMEOUT_MS
        ? setTimeout(() => {
            setNowMs(Date.now());
          }, msLeft + 50)
        : null;

    return () => {
      clearInterval(interval);
      if (expiryTimer !== null) clearTimeout(expiryTimer);
    };
  }, [activeReplyWindowUntil]);

  // Initialize `seenSeq` only when the thread is actually visible to the person.
  useEffect(() => {
    if (isThreadShown && liveDetail && seenSeq === null) {
      setSeenSeq(liveDetail.conversation.lastSeq);
    }
  }, [isThreadShown, liveDetail, seenSeq]);

  function handleConversationNotFound(code?: string | null, message?: string) {
    const err = Object.assign(new Error(message || 'Conversation not found'), {
      code: code ?? 'CONVERSATION_NOT_FOUND',
      status: 404,
    });
    setAccessDeniedError(err);
    setCachedThread(null);
    void conversationsCache.evictThread({
      serverUrl,
      orgSlug,
      userId,
      conversationId,
      expectedEpoch: conversationsCache.epoch(),
      isSessionStillActive: () => {
        const after = session.state();
        return after.status === 'active' && after.serverUrl === serverUrl && after.orgSlug === orgSlug;
      },
    });
    qc.removeQueries({ queryKey: detailQueryKey, exact: true });
    onRefreshListRef.current();
  }
  const handleConversationNotFoundRef = useRef(handleConversationNotFound);
  handleConversationNotFoundRef.current = handleConversationNotFound;

  // Best-effort markRead once `seenSeq` is initialized while visible, guarded by active scope ref.
  useEffect(() => {
    if (
      !isThreadShown ||
      isNonNetworkError ||
      isNetworkOffline ||
      !liveDetail ||
      !liveDetail.conversation.unread ||
      seenSeq === null
    ) {
      return;
    }
    const targetSeq = seenSeq;
    const highWater = Math.max(lastMarkedSeqRef.current ?? -1, inFlightMarkSeqRef.current ?? -1);
    if (targetSeq <= highWater) return;

    inFlightMarkSeqRef.current = targetSeq;
    const startedServer = serverUrl;
    const startedOrg = orgSlug;
    const startedScopeKey = `${serverUrl}:${orgSlug}:${conversationId}`;

    void markConversationRead(
      {
        client,
        isOffline: isNetworkOffline,
        onKernelError: (err) => void session.reportKernelError(err),
      },
      { conversationId, seq: targetSeq },
    )
      .then((res) => {
        if (!mountedRef.current || activeScopeKeyRef.current !== startedScopeKey) return;
        const cur = session.state();
        if (cur.status !== 'active' || cur.serverUrl !== startedServer || cur.orgSlug !== startedOrg) {
          return;
        }
        if (res.ok) {
          lastMarkedSeqRef.current = Math.max(lastMarkedSeqRef.current ?? -1, targetSeq);
          onRefreshListRef.current();
        } else if (res.reason === 'not-found') {
          handleConversationNotFoundRef.current(res.code, res.message);
        }
      })
      .finally(() => {
        if (inFlightMarkSeqRef.current !== null && inFlightMarkSeqRef.current <= targetSeq) {
          inFlightMarkSeqRef.current = null;
        }
      });
  }, [
    isThreadShown,
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

  function applyOutcomeFailure(
    outcome: Extract<ConversationActionOutcome<unknown>, { ok: false }>,
    actionKind: 'send' | 'draft' = 'send',
  ) {
    if (outcome.reason === 'auth') return;
    if (outcome.reason === 'not-found') {
      handleConversationNotFound(outcome.code, outcome.message);
      return;
    }
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
    setFeedback({
      tone: 'danger',
      text: t(actionKind === 'draft' ? 'conversations.draft.refused' : 'conversations.composer.refused', {
        detail,
      }),
    });
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
        if (outcome.reason === 'uncertain') {
          // Reply may have been queued before connection dropped; reconcile thread state so the person sees whether it landed.
          setFeedback({ tone: 'warn', text: t('conversations.composer.uncertain') });
          await detailQuery.refetch();
          onRefreshListRef.current();
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
        applyOutcomeFailure(outcome, 'draft');
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
        applyOutcomeFailure(outcome, 'draft');
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

  const effectiveAiEnabled = !isNetworkOffline && (aiConfigQuery.data ?? aiEnabled);
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

  const memberById = useMemo(
    () => new Map(members.map((m) => [m.userId, m])),
    [members],
  );

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

  const feedbackBanner = feedback ? (
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
  ) : null;

  const threadData = activeDetail ? sortedMessages : [];

  const threadHeader = (
    <View style={{ gap: 12, marginBottom: threadData.length > 0 ? 12 : 0 }}>
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
            {isMfaRequired(rawError)
              ? t('home.error.mfa')
              : isConversationForbiddenOrMissing(rawError)
                ? t('conversations.thread.refused')
                : t('home.error.generic')}
          </Body>
          <SecondaryButton
            label={t('home.retry')}
            onPress={() => {
              setAccessDeniedError(null);
              void detailQuery.refetch();
            }}
          />
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

      {!activeDetail ? feedbackBanner : null}

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
        </>
      ) : null}
    </View>
  );

  const threadFooter = activeDetail ? (
    <View style={{ gap: 12, marginTop: threadData.length > 0 ? 12 : 0 }}>
      {feedbackBanner}

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
              {isNetworkOffline ? (
                <Body tone="muted">{t('conversations.draft.pendingOffline')}</Body>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator accessibilityLabel={t('conversations.draft.writing')} />
                  <Body tone="muted">{t('conversations.draft.writing')}</Body>
                </View>
              )}
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
              {!liveDetail || isNetworkOffline ? (
                <Text style={[styles.meta, { color: palette.muted }]}>
                  {t('conversations.draft.liveRequired')}
                </Text>
              ) : null}
              <View style={styles.actionsRow}>
                <SecondaryButton
                  label={t('conversations.draft.use')}
                  disabled={busyAction !== null || !liveDetail || isNetworkOffline}
                  onPress={() => {
                    if (!liveDetail || !liveDetail.draft || liveDetail.draft.body === null) return;
                    setComposerText(replyTextFor(liveDetail.draft.body, liveDetail));
                    setReplySource({ draftId: liveDetail.draft.id });
                    setFeedback(null);
                  }}
                />
                <LinkButton
                  label={t('conversations.draft.discard')}
                  disabled={busyAction !== null || !liveDetail || isNetworkOffline}
                  onPress={() => {
                    if (liveDetail?.draft) void onDiscardDraft(liveDetail.draft.id);
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
                {activeDetail.suggestions.map((s) => {
                  const chipDisabled = busyAction !== null || !liveDetail || isNetworkOffline;
                  return (
                    <Pressable
                      key={s.id}
                      accessibilityRole="button"
                      accessibilityLabel={s.title}
                      accessibilityState={{ disabled: chipDisabled }}
                      disabled={chipDisabled}
                      onPress={() => {
                        const liveSuggestion = liveDetail?.suggestions.find((item) => item.id === s.id);
                        if (!liveDetail || !liveSuggestion) return;
                        setComposerText(replyTextFor(liveSuggestion.body, liveDetail));
                        setReplySource({ savedReplyId: liveSuggestion.id });
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
                        opacity: chipDisabled ? 0.55 : 1,
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '600', color: palette.text }}>
                        {s.title}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={{ gap: 8 }}>
            <SectionHeading>{t('conversations.composer.label')}</SectionHeading>
            <Text style={[styles.meta, { color: palette.muted }]}>
              {activeDetail.conversation.kind === 'email'
                ? activeDetail.conversation.contact.address
                  ? t('conversations.replyContext.email', {
                      address: activeDetail.conversation.contact.address,
                    })
                  : t('conversations.replyContext.emailGeneric')
                : t(
                    activeDetail.conversation.kind === 'direct'
                      ? 'conversations.replyContext.private'
                      : 'conversations.replyContext.public',
                    { channel: channelLabel },
                  )}
            </Text>
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
                  : activeDetail.conversation.kind === 'email'
                    ? t('conversations.composer.sendEmail')
                    : activeDetail.conversation.kind === 'direct'
                      ? t('conversations.composer.sendPrivate')
                      : t('conversations.composer.sendPublic')
              }
              busy={busyAction === 'send'}
              disabled={!canSendNow}
              onPress={() => void onSendReply()}
            />
          </View>
        </View>
      ) : null}
    </View>
  ) : null;

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background }]}>
      <FlatList
        data={threadData}
        keyExtractor={(msg) => msg.id}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scrollContent, { gap: 0 }]}
        ListHeaderComponent={threadHeader}
        ListFooterComponent={threadFooter ?? undefined}
        ItemSeparatorComponent={MessageRowSeparator}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setAccessDeniedError(null);
              void detailQuery.refetch();
              onRefreshListRef.current();
            }}
            refreshing={detailQuery.isRefetching}
          />
        }
        renderItem={({ item: msg }) => {
          const isOutbound = msg.direction === 'out';
          const member = msg.authorUserId ? memberById.get(msg.authorUserId) : undefined;
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
              style={[
                styles.card,
                {
                  alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                  width: '90%',
                  borderColor: isOutbound ? palette.primary : palette.border,
                  borderWidth: isOutbound ? 1.5 : 1,
                  backgroundColor: palette.surface,
                  opacity: msg.hidden ? 0.72 : 1,
                },
              ]}
            >
              <View style={styles.row}>
                <Text
                  style={[
                    styles.meta,
                    { color: isOutbound ? palette.primary : palette.muted, fontWeight: '600' },
                  ]}
                >
                  {authorLabel}
                </Text>
                <Text style={[styles.meta, { color: palette.muted }]}>
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
        }}
      />
    </View>
  );
}
