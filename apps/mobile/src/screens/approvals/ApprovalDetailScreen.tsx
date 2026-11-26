// SPDX-License-Identifier: AGPL-3.0-only
// Detail screen for a single cross-app approval item with biometric step-up, inline account edit and web hand-off (issue #4881).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { normalizeServerUrl } from '../../config.ts';
import { externalBrowser } from '../../platform/browser.ts';
import { deviceCrypto } from '../../platform/crypto.ts';
import { clientFor, SERVER_POLICY, session, stepUp, t } from '../../runtime.ts';
import {
  Badge,
  Banner,
  Body,
  CheckboxRow,
  DangerButton,
  LinkButton,
  PrimaryButton,
  SecondaryButton,
  SectionHeading,
  Title,
} from '../../ui/parts.tsx';
import { styles, usePalette } from '../../ui/theme.ts';
import {
  approveInboxProposal,
  decideBusinessTrip,
  decideLeaveRequest,
  decideSalaryAdvance,
  decideSocialPostVariants,
  editInboxProposal,
  rejectInboxProposal,
} from './actions.ts';
import type { CachedApprovalSummary, CachedCoworkerDirectory } from './cache.ts';
import {
  buildWebUrl,
  createIdempotencyKey,
  formatDateShort,
  formatMoney,
  type Locale,
} from './format.ts';
import {
  DEFAULT_COWORKERS,
  isAdsProposalKind,
  isLikelyNetworkError,
  type ChartAccount,
  type LiveApprovalExtra,
  type OrgDetail,
} from './model.ts';
import {
  pickableAccountsForMobile,
  resolveHrActionGuards,
  resolveInboxActionGuards,
  resolveSocialActionGuards,
} from './view-state.ts';

export interface ApprovalDetailScreenProps {
  serverUrl: string;
  orgSlug: string;
  locale: Locale;
  role: OrgDetail['role'];
  currentUserId: string | null;
  coworkers?: CachedCoworkerDirectory;
  summary: CachedApprovalSummary;
  liveExtra?: LiveApprovalExtra;
  isOffline: boolean;
  isCachedPreview: boolean;
  onBack: () => void;
  onCompleted: (message: string) => void;
}

const INITIAL_LINES_PREVIEW = 25;
const MAX_ACCOUNT_PICKER_ROWS = 80;

export function ApprovalDetailScreen(props: ApprovalDetailScreenProps) {
  const { serverUrl, orgSlug, locale, role, currentUserId, coworkers, summary, liveExtra, isOffline, isCachedPreview } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [busyAction, setBusyAction] = useState<'approve' | 'edit' | 'reject' | 'changes' | null>(null);
  const [note, setNote] = useState('');
  const [failedAckRevision, setFailedAckRevision] = useState<number | null>(null);
  const [sigAckRevision, setSigAckRevision] = useState<number | null>(null);
  const [editingAccounts, setEditingAccounts] = useState(false);
  const [lineEdits, setLineEdits] = useState<Record<number, string>>({});
  const [pickingLineNo, setPickingLineNo] = useState<number | null>(null);
  const [pickingCurrentAcct, setPickingCurrentAcct] = useState<string | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const [showAllLines, setShowAllLines] = useState(false);
  const [tickedChecklistIds, setTickedChecklistIds] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string; showWebButton?: boolean } | null>(null);

  // Reuse one idempotency key per `(action, revision)` across transient retries until resolved or revision advances.
  const retryKeysRef = useRef<Map<string, string>>(new Map());
  function idempotencyKeyFor(slot: string): string {
    const existing = retryKeysRef.current.get(slot);
    if (existing) return existing;
    const created = createIdempotencyKey(deviceCrypto);
    retryKeysRef.current.set(slot, created);
    return created;
  }

  const inboxDetailQuery = useQuery({
    queryKey: ['approvals', 'inbox-detail', serverUrl, orgSlug, summary.id],
    queryFn: () => client.inbox.get({ id: summary.id }),
    enabled: summary.source === 'inbox',
  });

  const socialDetailQuery = useQuery({
    queryKey: ['approvals', 'social-detail', serverUrl, orgSlug, summary.id],
    queryFn: () => client.social.posts.get({ postId: summary.id }),
    enabled: summary.source === 'social_post',
  });

  const einvoiceQuery = useQuery({
    queryKey: ['approvals', 'einvoice', serverUrl, orgSlug, summary.id],
    queryFn: () => client.einvoice.drafts.issueRequest({ proposalId: summary.id }),
    enabled: summary.source === 'inbox' && summary.subtype === 'finance.einvoice_issue',
  });

  const adsQuery = useQuery({
    queryKey: ['approvals', 'ads', serverUrl, orgSlug, summary.id],
    queryFn: () => client.ads.proposal({ id: summary.id }),
    enabled: summary.source === 'inbox' && isAdsProposalKind(summary.subtype),
  });

  const reversalEntryId = inboxDetailQuery.data?.reversal?.entryId ?? null;
  const journalQuery = useQuery({
    queryKey: ['approvals', 'journal', serverUrl, orgSlug, reversalEntryId],
    queryFn: () => client.journal.get({ id: reversalEntryId as string }),
    enabled: Boolean(reversalEntryId),
  });

  const accountsQuery = useQuery({
    queryKey: ['approvals', 'accounts', serverUrl, orgSlug],
    queryFn: () => client.accounts.list(),
    enabled: editingAccounts && summary.source === 'inbox',
  });

  const inboxDetail = inboxDetailQuery.data ?? null;
  const purchasePayload =
    summary.source === 'inbox' &&
    (summary.subtype === 'finance.purchase' || summary.subtype === 'finance.sale')
      ? (inboxDetail?.payload ?? null)
      : null;
  const invoiceDirection: 'purchase' | 'sale' =
    purchasePayload?.direction === 'sale' || inboxDetail?.direction === 'sale' ? 'sale' : 'purchase';

  const { filteredAccounts, totalDirectionalAccounts } = useMemo<{
    filteredAccounts: ChartAccount[];
    totalDirectionalAccounts: number;
  }>(() => {
    const directional = pickableAccountsForMobile(
      accountsQuery.data ?? [],
      invoiceDirection,
      pickingCurrentAcct,
    );
    const q = accountSearch.trim().toLowerCase();
    const matches = q
      ? directional.filter((a) => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : directional;
    return { filteredAccounts: matches, totalDirectionalAccounts: matches.length };
  }, [accountsQuery.data, invoiceDirection, pickingCurrentAcct, accountSearch]);

  const effectiveOffline =
    isOffline ||
    (inboxDetailQuery.isError && isLikelyNetworkError(inboxDetailQuery.error)) ||
    (socialDetailQuery.isError && isLikelyNetworkError(socialDetailQuery.error)) ||
    (einvoiceQuery.isError && isLikelyNetworkError(einvoiceQuery.error)) ||
    (adsQuery.isError && isLikelyNetworkError(adsQuery.error));

  async function handleOpenWeb(pathOverride?: string) {
    const url = buildWebUrl(serverUrl, orgSlug, pathOverride ?? summary.webPath, SERVER_POLICY);
    if (!url) {
      setFeedback({ tone: 'danger', text: t('approvals.outcome.webError') });
      return;
    }
    const allowedOrigin = normalizeServerUrl(serverUrl) ?? undefined;
    const opened = await externalBrowser.openWeb(url, allowedOrigin);
    if (!opened) {
      setFeedback({ tone: 'danger', text: t('approvals.outcome.webError') });
    }
  }

  function applyOutcomeError(outcome: {
    reason: 'biometric' | 'kernel-step-up' | 'offline' | 'auth' | 'refused';
    code?: string | null;
    message?: string;
  }) {
    if (outcome.reason === 'auth') return;
    if (outcome.reason === 'biometric') {
      setFeedback({ tone: 'warn', text: t('approvals.outcome.biometricCancelled') });
      return;
    }
    if (outcome.reason === 'kernel-step-up') {
      setFeedback({ tone: 'warn', text: t('stepUp.kernel'), showWebButton: true });
      return;
    }
    if (outcome.reason === 'offline') {
      setFeedback({ tone: 'warn', text: t('approvals.networkRequired') });
      return;
    }
    const detailText = outcome.message || outcome.code || t('home.error.generic');
    setFeedback({ tone: 'danger', text: t('approvals.outcome.refused', { detail: detailText }) });
  }

  async function refreshAfterWrite(doneMessage: string) {
    await qc.invalidateQueries({ queryKey: ['approvals', serverUrl, orgSlug] });
    props.onCompleted(doneMessage);
  }

  const voucherPayload = inboxDetail?.voucher ?? null;
  const journalVoucherPayload = inboxDetail?.journalVoucher ?? null;
  const reversalPayload = inboxDetail?.reversal ?? null;
  const engagePayload = inboxDetail?.engage ?? null;
  const einvoiceDetail = einvoiceQuery.data ?? null;
  const adsChange = adsQuery.data?.change ?? null;
  const socialPost = socialDetailQuery.data ?? null;

  const acceptFailedChecks = Boolean(inboxDetail && failedAckRevision === inboxDetail.revision);
  const acceptUnverifiedSig = Boolean(inboxDetail && sigAckRevision === inboxDetail.revision);

  const inboxGuards = resolveInboxActionGuards(inboxDetail, {
    isOffline: effectiveOffline,
    editingAccounts,
    acceptFailedChecks,
    acceptUnverifiedSig,
    einvoiceLoaded: einvoiceDetail !== null,
    adsLoaded: adsChange !== null,
  });

  const socialGuards = resolveSocialActionGuards(summary, socialPost, {
    isOffline: effectiveOffline,
    currentUserId,
    tickedChecklistIds,
  });

  const hasLiveHrItem =
    (summary.source === 'hr_leave' && liveExtra?.leave !== undefined) ||
    (summary.source === 'hr_salary_advance' && liveExtra?.advance !== undefined) ||
    (summary.source === 'hr_business_trip' && liveExtra?.trip !== undefined);

  const hrGuards = resolveHrActionGuards(summary, role, {
    isOffline: effectiveOffline,
    hasLiveItem: !isCachedPreview && hasLiveHrItem,
    canApproveL1:
      summary.source === 'hr_salary_advance'
        ? liveExtra?.advance?.canApproveL1
        : summary.source === 'hr_business_trip'
          ? liveExtra?.trip?.canApproveL1
          : undefined,
  });

  const pendingSocialVariants = socialGuards.pendingVariants;
  const singleSocialVariant = socialGuards.singleVariant;
  const marketingCoworkerName = coworkers?.marketing ?? DEFAULT_COWORKERS.marketing;

  const displayedAiCoworker = useMemo(() => {
    if (summary.aiCoworker) return summary.aiCoworker.label;
    if (socialPost && (socialPost.origin === 'ai' || socialPost.tainted)) return marketingCoworkerName;
    if (adsChange?.change === 'campaign_launch' && adsChange.origin === 'ai') return marketingCoworkerName;
    return null;
  }, [summary.aiCoworker, socialPost, adsChange, marketingCoworkerName]);

  const onKernelError = (err: unknown) => {
    void session.reportKernelError(err);
  };

  async function onApproveInbox() {
    if (!inboxDetail) return;
    if (inboxGuards.needsFailedAck && !acceptFailedChecks) {
      setFeedback({ tone: 'warn', text: t('approvals.outcome.checksAckRequired') });
      return;
    }
    if (inboxGuards.needsSigAck && !acceptUnverifiedSig) {
      setFeedback({ tone: 'warn', text: t('approvals.outcome.checksAckRequired') });
      return;
    }
    setFeedback(null);
    setBusyAction('approve');
    const slot = `approve:${inboxDetail.id}:${inboxDetail.revision}`;
    try {
      const outcome = await approveInboxProposal(
        { client, stepUp, crypto: deviceCrypto, isOffline: effectiveOffline, onKernelError },
        {
          id: inboxDetail.id,
          revision: inboxDetail.revision,
          prompt: t('approvals.biometric.prompt', { title: summary.title }),
          note,
          acceptFailedChecks: inboxGuards.needsFailedAck ? acceptFailedChecks : undefined,
          acceptUnverifiedSignature: inboxGuards.needsSigAck ? acceptUnverifiedSig : undefined,
          idempotencyKey: idempotencyKeyFor(slot),
        },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
      retryKeysRef.current.delete(slot);
      await refreshAfterWrite(t('approvals.outcome.approved'));
    } finally {
      setBusyAction(null);
    }
  }

  async function onSaveInboxEdit() {
    if (!inboxDetail || !purchasePayload) return;
    const changedLines = purchasePayload.lines
      .filter((line) => lineEdits[line.lineNo] && lineEdits[line.lineNo] !== line.debitAccount)
      .map((line) => ({
        lineNo: line.lineNo,
        debitAccount: lineEdits[line.lineNo] as string,
      }));
    if (changedLines.length === 0) {
      setEditingAccounts(false);
      return;
    }
    setFeedback(null);
    setBusyAction('edit');
    const slot = `edit:${inboxDetail.id}:${inboxDetail.revision}`;
    try {
      const outcome = await editInboxProposal(
        { client, crypto: deviceCrypto, isOffline: effectiveOffline, onKernelError },
        {
          id: inboxDetail.id,
          revision: inboxDetail.revision,
          lineAccounts: changedLines,
          idempotencyKey: idempotencyKeyFor(slot),
        },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
      retryKeysRef.current.delete(slot);
      setEditingAccounts(false);
      setLineEdits({});
      setFailedAckRevision(null);
      setSigAckRevision(null);
      await qc.invalidateQueries({ queryKey: ['approvals', 'inbox-detail', serverUrl, orgSlug, summary.id] });
      await qc.invalidateQueries({ queryKey: ['approvals', serverUrl, orgSlug] });
      setFeedback({ tone: 'info', text: t('approvals.detail.editSaved') });
    } finally {
      setBusyAction(null);
    }
  }

  async function onRejectInbox() {
    if (!inboxDetail) return;
    setFeedback(null);
    setBusyAction('reject');
    try {
      const outcome = await rejectInboxProposal(
        { client, isOffline: effectiveOffline, onKernelError },
        { id: inboxDetail.id, reason: note },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
      await refreshAfterWrite(t('approvals.outcome.rejected'));
    } finally {
      setBusyAction(null);
    }
  }

  async function onDecideSocial(decision: 'approved' | 'changes_requested' | 'rejected') {
    if (!socialPost || !singleSocialVariant) return;
    const requiredChecks = singleSocialVariant.checklist;
    const checkedIds = requiredChecks.filter((c) => tickedChecklistIds[c.id]).map((c) => c.id);
    if (decision === 'approved' && checkedIds.length < requiredChecks.length) {
      setFeedback({ tone: 'warn', text: t('approvals.outcome.checklistMissing') });
      return;
    }
    setFeedback(null);
    setBusyAction(decision === 'approved' ? 'approve' : decision === 'changes_requested' ? 'changes' : 'reject');
    try {
      const outcome = await decideSocialPostVariants(
        { client, isOffline: effectiveOffline, onKernelError },
        {
          postId: socialPost.id,
          decision,
          comment: note,
          variants: [
            {
              variantId: singleSocialVariant.id,
              revision: singleSocialVariant.revision,
              contentHash: singleSocialVariant.contentHash,
              ...(requiredChecks.length > 0 ? { checks: checkedIds } : {}),
            },
          ],
        },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
      const key =
        decision === 'approved'
          ? 'approvals.outcome.approved'
          : decision === 'changes_requested'
            ? 'approvals.outcome.changesRequested'
            : 'approvals.outcome.rejected';
      await refreshAfterWrite(t(key));
    } finally {
      setBusyAction(null);
    }
  }

  async function onDecideHr(action: 'approve' | 'reject') {
    const stage = action === 'reject' ? 'reject' : hrGuards.approveStage;

    setFeedback(null);
    setBusyAction(action);
    try {
      if (summary.source === 'hr_leave') {
        const outcome = await decideLeaveRequest(
          { client, isOffline: effectiveOffline, onKernelError },
          { requestId: summary.id, stage, note },
        );
        if (!outcome.ok) {
          applyOutcomeError(outcome);
          return;
        }
      } else if (summary.source === 'hr_salary_advance') {
        const outcome = await decideSalaryAdvance(
          { client, stepUp, isOffline: effectiveOffline, onKernelError },
          {
            requestId: summary.id,
            stage,
            note,
            prompt: t('approvals.biometric.prompt', { title: summary.title }),
          },
        );
        if (!outcome.ok) {
          applyOutcomeError(outcome);
          return;
        }
      } else if (summary.source === 'hr_business_trip') {
        const outcome = await decideBusinessTrip(
          { client, stepUp, isOffline: effectiveOffline, onKernelError },
          {
            requestId: summary.id,
            stage,
            estimatedAllowance: summary.amount,
            note,
            prompt: t('approvals.biometric.prompt', { title: summary.title }),
          },
        );
        if (!outcome.ok) {
          applyOutcomeError(outcome);
          return;
        }
      }
      await refreshAfterWrite(action === 'approve' ? t('approvals.outcome.approved') : t('approvals.outcome.rejected'));
    } finally {
      setBusyAction(null);
    }
  }

  const formattedSummaryAmount = summary.amount ? formatMoney(summary.amount, summary.currency, locale) : null;
  const anyBusy = busyAction !== null;

  const isMultiSocial = summary.source === 'social_post' && socialGuards.isMultiDecision;
  const isHrItem =
    summary.source === 'hr_leave' ||
    summary.source === 'hr_salary_advance' ||
    summary.source === 'hr_business_trip';
  const isRoleBlockedHr = isHrItem && hrGuards.isRoleBlocked;
  const isWaitingLiveHr = isHrItem && !hrGuards.hasLiveItem && !effectiveOffline;

  const inboxNeedsFourEyes = inboxGuards.needsFourEyes;
  const inboxCannotAct = inboxGuards.cannotActOnMobile;
  const showWebPrimary =
    (summary.source === 'inbox' && inboxGuards.showWebPrimary) ||
    (summary.source === 'social_post' && socialGuards.showWebPrimary) ||
    (isHrItem && hrGuards.showWebPrimary);

  const isDetailLoading =
    !effectiveOffline &&
    ((summary.source === 'inbox' && inboxDetailQuery.isPending) ||
      (summary.source === 'social_post' && socialDetailQuery.isPending) ||
      (summary.source === 'inbox' && summary.subtype === 'finance.einvoice_issue' && einvoiceQuery.isPending) ||
      (summary.source === 'inbox' && isAdsProposalKind(summary.subtype) && adsQuery.isPending));

  const detailLoadFailedOffline =
    (summary.source === 'inbox' && inboxDetailQuery.isError) ||
    (summary.source === 'social_post' && socialDetailQuery.isError) ||
    (summary.source === 'inbox' && summary.subtype === 'finance.einvoice_issue' && einvoiceQuery.isError) ||
    (summary.source === 'inbox' && isAdsProposalKind(summary.subtype) && adsQuery.isError);

  const hideNoteInput =
    editingAccounts ||
    isMultiSocial ||
    isRoleBlockedHr ||
    isWaitingLiveHr ||
    (summary.source === 'inbox' && inboxCannotAct);

  return (
    <View style={[styles.scrollContainer, { backgroundColor: palette.background, paddingTop: 16 }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.row}>
          <LinkButton label={t('approvals.back')} onPress={props.onBack} disabled={anyBusy} />
          {summary.requiresStepUp ? <Badge label={t('approvals.badge.stepUp')} tone="info" /> : null}
        </View>

        <Title>{summary.title}</Title>

        {displayedAiCoworker ? (
          <Banner tone="info">
            <Badge label={t('approvals.ai.preparedBy', { name: displayedAiCoworker })} tone="info" />
            <Text style={[styles.meta, { color: palette.muted }]}>{t('approvals.ai.disclaimer')}</Text>
          </Banner>
        ) : null}

        {effectiveOffline ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.networkRequired')}</Body>
          </Banner>
        ) : isWaitingLiveHr ? (
          <Banner tone="info">
            <Body tone="muted">{t('approvals.detail.waitingLiveSync')}</Body>
          </Banner>
        ) : null}

        {inboxGuards.inFlightExtraction ? (
          <Banner tone="info">
            <Body tone="muted">{t('approvals.detail.loading')}</Body>
          </Banner>
        ) : null}

        {feedback ? (
          <Banner tone={feedback.tone}>
            <Body tone={feedback.tone === 'danger' ? 'danger' : feedback.tone === 'warn' ? 'warning' : 'normal'}>
              {feedback.text}
            </Body>
            {feedback.showWebButton ? (
              <PrimaryButton label={t('approvals.action.openWeb')} onPress={() => void handleOpenWeb()} />
            ) : null}
          </Banner>
        ) : null}

        <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
          <Text style={[styles.meta, { color: palette.muted }]}>
            {`${t('approvals.detail.type')}: ${summary.subtype}`}
          </Text>
          {summary.counterparty ? (
            <Body>{`${t('approvals.detail.counterparty')}: ${summary.counterparty}`}</Body>
          ) : null}
          {summary.dateLabel ? (
            <Text style={[styles.meta, { color: palette.muted }]}>
              {`${t('approvals.detail.date')}: ${formatDateShort(summary.dateLabel, locale)}`}
            </Text>
          ) : null}
          {formattedSummaryAmount ? (
            <Text style={[styles.amount, { color: palette.text }]}>
              {`${t('approvals.detail.amount')}: ${formattedSummaryAmount}`}
            </Text>
          ) : null}
        </View>

        {isDetailLoading ? (
          <View style={{ paddingVertical: 16, alignItems: 'center', gap: 8 }}>
            <ActivityIndicator accessibilityLabel={t('approvals.detail.loading')} />
            <Body tone="muted">{t('approvals.detail.loading')}</Body>
          </View>
        ) : null}

        {detailLoadFailedOffline ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.detail.offlineError')}</Body>
          </Banner>
        ) : null}

        {/* Finance Purchase / Sale Invoice Details */}
        {purchasePayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>
              {`${invoiceDirection === 'sale' ? purchasePayload.buyer.name : purchasePayload.seller.name}${
                (invoiceDirection === 'sale' ? purchasePayload.buyer.taxCode : purchasePayload.seller.taxCode)
                  ? ` (${t('approvals.detail.taxCode')}: ${
                      invoiceDirection === 'sale'
                        ? purchasePayload.buyer.taxCode
                        : purchasePayload.seller.taxCode
                    })`
                  : ''
              }`}
            </Body>
            <Text style={[styles.meta, { color: palette.muted }]}>
              {`${purchasePayload.invoice.series}-${purchasePayload.invoice.number} | ${formatDateShort(purchasePayload.invoice.issueDate, locale)}`}
            </Text>
            <Text style={[styles.amount, { color: palette.text }]}>
              {formatMoney(purchasePayload.invoice.total, purchasePayload.invoice.currency, locale)}
            </Text>

            {purchasePayload.checks.length > 0 ? (
              <View style={{ gap: 6, marginTop: 4 }}>
                <SectionHeading>{t('approvals.detail.checksWarningTitle')}</SectionHeading>
                {purchasePayload.checks.map((chk) => (
                  <Text
                    key={chk.id}
                    style={[
                      styles.meta,
                      {
                        color:
                          chk.status === 'fail'
                            ? palette.danger
                            : chk.status === 'warn'
                              ? palette.warning
                              : palette.muted,
                      },
                    ]}
                  >
                    {`[${chk.status.toUpperCase()}] ${chk.message}`}
                  </Text>
                ))}
              </View>
            ) : null}

            <SectionHeading>
              {t('approvals.detail.lines', { count: String(purchasePayload.lines.length) })}
            </SectionHeading>
            {(showAllLines
              ? purchasePayload.lines
              : purchasePayload.lines.slice(0, INITIAL_LINES_PREVIEW)
            ).map((line) => {
              const currentAcct = lineEdits[line.lineNo] ?? line.debitAccount;
              const accountKey =
                invoiceDirection === 'sale'
                  ? 'approvals.detail.lineCreditAccount'
                  : 'approvals.detail.lineAccount';
              const accountDisplay =
                currentAcct === '000'
                  ? t('approvals.detail.unclassifiedAccount')
                  : t(accountKey, { account: currentAcct });
              return (
                <View
                  key={line.lineNo}
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: palette.border,
                    paddingTop: 8,
                    gap: 4,
                  }}
                >
                  <Body>{`${line.lineNo}. ${line.description}`}</Body>
                  <View style={styles.row}>
                    <Text style={[styles.meta, { color: currentAcct === '000' ? palette.danger : palette.muted }]}>
                      {accountDisplay}
                    </Text>
                    <Text style={[styles.meta, { color: palette.text }]}>
                      {formatMoney(line.amount, purchasePayload.invoice.currency, locale)}
                    </Text>
                  </View>
                  {editingAccounts ? (
                    <SecondaryButton
                      label={t('approvals.detail.pickAccount')}
                      accessibilityLabel={`${t('approvals.detail.pickAccount')} ${line.lineNo}`}
                      onPress={() => {
                        setAccountSearch('');
                        setPickingCurrentAcct(currentAcct);
                        setPickingLineNo(line.lineNo);
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
            {!showAllLines && purchasePayload.lines.length > INITIAL_LINES_PREVIEW ? (
              <LinkButton
                label={t('approvals.detail.showAllLines', { count: String(purchasePayload.lines.length) })}
                onPress={() => setShowAllLines(true)}
              />
            ) : null}
          </View>
        ) : null}

        {/* Cash / Bank Voucher */}
        {voucherPayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{voucherPayload.description}</Body>
            {voucherPayload.party ? <Body tone="muted">{voucherPayload.party.name}</Body> : null}
            <Text style={[styles.amount, { color: palette.text }]}>
              {formatMoney(voucherPayload.total, 'VND', locale)}
            </Text>
            {voucherPayload.lines.map((line, index) => (
              <Text key={`${line.account}-${index}`} style={[styles.meta, { color: palette.muted }]}>
                {`${line.account}: ${formatMoney(line.amount, 'VND', locale)}${line.memo ? ` (${line.memo})` : ''}`}
              </Text>
            ))}
          </View>
        ) : null}

        {/* General Journal Voucher */}
        {journalVoucherPayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{journalVoucherPayload.description}</Body>
            <Text style={[styles.amount, { color: palette.text }]}>
              {formatMoney(journalVoucherPayload.total, 'VND', locale)}
            </Text>
            {(showAllLines
              ? journalVoucherPayload.lines
              : journalVoucherPayload.lines.slice(0, INITIAL_LINES_PREVIEW)
            ).map((line, index) => (
              <Text key={`${line.account}-${index}`} style={[styles.meta, { color: palette.muted }]}>
                {`${line.account}: Nợ ${formatMoney(line.debit, 'VND', locale)} / Có ${formatMoney(line.credit, 'VND', locale)}`}
              </Text>
            ))}
            {!showAllLines && journalVoucherPayload.lines.length > INITIAL_LINES_PREVIEW ? (
              <LinkButton
                label={t('approvals.detail.showAllLines', { count: String(journalVoucherPayload.lines.length) })}
                onPress={() => setShowAllLines(true)}
              />
            ) : null}
          </View>
        ) : null}

        {/* Journal Reversal */}
        {reversalPayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{`${t('approvals.detail.reason')}: ${reversalPayload.reason}`}</Body>
            <Text style={[styles.meta, { color: palette.muted }]}>
              {formatDateShort(reversalPayload.entryDate, locale)}
            </Text>
            {journalQuery.data ? <Body tone="muted">{journalQuery.data.description}</Body> : null}
          </View>
        ) : null}

        {/* E-Invoice Issue Request */}
        {einvoiceDetail ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            {einvoiceDetail.buyerName ? <Body>{einvoiceDetail.buyerName}</Body> : null}
            {einvoiceDetail.buyerTaxCode ? (
              <Text style={[styles.meta, { color: palette.muted }]}>
                {`${t('approvals.detail.taxCode')}: ${einvoiceDetail.buyerTaxCode}`}
              </Text>
            ) : null}
            <Text style={[styles.amount, { color: palette.text }]}>
              {formatMoney(einvoiceDetail.total, einvoiceDetail.currency, locale)}
            </Text>
            {(showAllLines ? einvoiceDetail.lines : einvoiceDetail.lines.slice(0, INITIAL_LINES_PREVIEW)).map(
              (line) => (
                <Text key={line.lineNo} style={[styles.meta, { color: palette.muted }]}>
                  {`${line.lineNo}. ${line.description}: ${formatMoney(line.amount, einvoiceDetail.currency, locale)}`}
                </Text>
              ),
            )}
            {!showAllLines && einvoiceDetail.lines.length > INITIAL_LINES_PREVIEW ? (
              <LinkButton
                label={t('approvals.detail.showAllLines', { count: String(einvoiceDetail.lines.length) })}
                onPress={() => setShowAllLines(true)}
              />
            ) : null}
          </View>
        ) : null}

        {/* Ads Proposal */}
        {adsChange ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{`Ads: ${adsChange.change}`}</Body>
            {'adAccountName' in adsChange && adsChange.adAccountName ? (
              <Body tone="muted">{adsChange.adAccountName}</Body>
            ) : null}
            {'amount' in adsChange ? (
              <Text style={[styles.amount, { color: palette.text }]}>
                {formatMoney(adsChange.amount, adsChange.currency, locale)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Engage / Unsupported Detail Notices */}
        {inboxDetail && inboxGuards.unsupportedOnMobile ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.detail.unsupportedOnMobile')}</Body>
          </Banner>
        ) : inboxDetail && !engagePayload && summary.aiCoworker && !purchasePayload && !isAdsProposalKind(summary.subtype) ? (
          <Banner tone="info">
            <Body tone="muted">{t('approvals.detail.engageHidden')}</Body>
          </Banner>
        ) : null}

        {engagePayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Text style={[styles.meta, { color: palette.muted }]}>
              {`${t('approvals.detail.engageCommand')}: ${engagePayload.command}`}
            </Text>
            {engagePayload.about.map((item, idx) => (
              <Text key={`${item.label}-${idx}`} style={[styles.meta, { color: palette.text }]}>
                {`${item.label}: ${item.value}`}
              </Text>
            ))}
            {engagePayload.fields.map((field) => (
              <View key={field.key} style={{ marginTop: 4 }}>
                <Text style={[styles.meta, { color: palette.muted }]}>{field.key}</Text>
                <Body>{field.value}</Body>
              </View>
            ))}
          </View>
        ) : null}

        {/* Social Post Review Detail */}
        {summary.source === 'social_post' && socialPost ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            {socialPost.origin === 'ai' || socialPost.tainted ? (
              <Banner tone="warn">
                <Body tone="warning">{t('approvals.detail.socialTainted')}</Body>
              </Banner>
            ) : null}
            {socialPost.title ? <Text style={[styles.cardTitle, { color: palette.text }]}>{socialPost.title}</Text> : null}
            <Body>{singleSocialVariant ? singleSocialVariant.effective.body : socialPost.body}</Body>
            {singleSocialVariant && singleSocialVariant.bannedWords.length > 0 ? (
              <Banner tone="danger">
                <Body tone="danger">
                  {singleSocialVariant.bannedWords.map((w) => `${w.phrase} (${w.level})`).join(', ')}
                </Body>
              </Banner>
            ) : null}
            {singleSocialVariant && singleSocialVariant.checklist.length > 0 ? (
              <View style={{ marginTop: 6, gap: 4 }}>
                <SectionHeading>{t('approvals.detail.socialChecklist')}</SectionHeading>
                {singleSocialVariant.checklist.map((item) => (
                  <CheckboxRow
                    key={item.id}
                    label={item.label}
                    checked={tickedChecklistIds[item.id] === true}
                    disabled={anyBusy}
                    onToggle={() =>
                      setTickedChecklistIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                    }
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* HR Leave / Advance / Business Trip Details */}
        {summary.source === 'hr_leave' && liveExtra?.leave ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>
              {t('approvals.detail.leaveDays', {
                days: liveExtra.leave.days,
                from: formatDateShort(liveExtra.leave.startOn, locale),
                to: formatDateShort(liveExtra.leave.endOn, locale),
              })}
            </Body>
            {liveExtra.leave.reason ? (
              <Body tone="muted">{`${t('approvals.detail.reason')}: ${liveExtra.leave.reason}`}</Body>
            ) : null}
          </View>
        ) : null}

        {summary.source === 'hr_salary_advance' && liveExtra?.advance?.reason ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{`${t('approvals.detail.reason')}: ${liveExtra.advance.reason}`}</Body>
          </View>
        ) : null}

        {summary.source === 'hr_business_trip' && liveExtra?.trip ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            {liveExtra.trip.destination ? (
              <Body>{`${t('approvals.detail.tripDestination')}: ${liveExtra.trip.destination}`}</Body>
            ) : null}
            <Body tone="muted">
              {t('approvals.detail.tripSchedule', {
                from: formatDateShort(liveExtra.trip.startOn, locale),
                to: formatDateShort(liveExtra.trip.endOn, locale),
              })}
            </Body>
            {liveExtra.trip.purpose ? (
              <Body>{`${t('approvals.detail.reason')}: ${liveExtra.trip.purpose}`}</Body>
            ) : null}
          </View>
        ) : null}

        {/* Pre-approval blocking / four-eyes / multi-decision banners */}
        {inboxGuards.hasBlockingChecks ? (
          <Banner tone="danger">
            <Body tone="danger">{t('approvals.detail.blockingCheck')}</Body>
          </Banner>
        ) : null}

        {inboxGuards.hasUnclassifiedLines ? (
          <Banner tone="warn">
            <Body tone="warning">
              {t('approvals.detail.unclassifiedRequired', {
                count: String(inboxDetail?.unclassifiedLines ?? summary.unclassifiedLines),
              })}
            </Body>
          </Banner>
        ) : null}

        {inboxGuards.missingForeignRate ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.detail.foreignRateRequired')}</Body>
          </Banner>
        ) : null}

        {inboxNeedsFourEyes || socialGuards.isFourEyesBlocked ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.detail.fourEyes')}</Body>
          </Banner>
        ) : null}

        {isMultiSocial ? (
          <Banner tone="warn">
            <SectionHeading>{t('approvals.detail.multiDecisionTitle')}</SectionHeading>
            <Body tone="warning">
              {t('approvals.detail.multiDecisionChannels', {
                count: String(pendingSocialVariants.length || summary.socialChannelsCount || 2),
              })}
            </Body>
          </Banner>
        ) : null}

        {isRoleBlockedHr ? (
          <Banner tone="warn">
            <Body tone="warning">{t('approvals.detail.multiDecisionRole')}</Body>
          </Banner>
        ) : null}

        {/* Revision-bound safety acknowledgments */}
        {inboxDetail && !inboxGuards.unsupportedOnMobile && inboxDetail.canApprove && !editingAccounts ? (
          <View style={{ gap: 4 }}>
            {inboxGuards.needsFailedAck ? (
              <CheckboxRow
                label={t('approvals.detail.acceptFailedChecks')}
                checked={acceptFailedChecks}
                disabled={anyBusy}
                onToggle={() =>
                  setFailedAckRevision((prev) =>
                    prev === inboxDetail.revision ? null : inboxDetail.revision,
                  )
                }
              />
            ) : null}
            {inboxGuards.needsSigAck ? (
              <>
                <Text style={[styles.meta, { color: palette.warning }]}>
                  {t('approvals.detail.signatureUnverified', {
                    status: inboxDetail.signatureStatus ?? 'unverified',
                  })}
                </Text>
                <CheckboxRow
                  label={t('approvals.detail.acceptSignature')}
                  checked={acceptUnverifiedSig}
                  disabled={anyBusy}
                  onToggle={() =>
                    setSigAckRevision((prev) =>
                      prev === inboxDetail.revision ? null : inboxDetail.revision,
                    )
                  }
                />
              </>
            ) : null}
          </View>
        ) : null}

        {/* Note / Reason input */}
        {!hideNoteInput ? (
          <View style={{ gap: 6 }}>
            <Text style={[styles.meta, { color: palette.text }]}>{t('approvals.detail.noteLabel')}</Text>
            <TextInput
              accessibilityLabel={t('approvals.detail.noteLabel')}
              editable={!anyBusy && !effectiveOffline}
              multiline
              onChangeText={setNote}
              placeholder={t('approvals.detail.notePlaceholder')}
              placeholderTextColor={palette.muted}
              style={[
                styles.input,
                { borderColor: palette.border, color: palette.text, backgroundColor: palette.background, minHeight: 68 },
              ]}
              value={note}
            />
          </View>
        ) : null}

        {/* Inline Account Editor Actions */}
        {editingAccounts ? (
          <View style={{ gap: 10 }}>
            <SectionHeading>{t('approvals.detail.editAccountsTitle')}</SectionHeading>
            <PrimaryButton
              label={busyAction === 'edit' ? t('approvals.action.working') : t('approvals.detail.saveEdit')}
              busy={busyAction === 'edit'}
              disabled={effectiveOffline || anyBusy}
              onPress={() => void onSaveInboxEdit()}
            />
            <SecondaryButton
              label={t('approvals.detail.cancelEdit')}
              disabled={anyBusy}
              onPress={() => {
                setEditingAccounts(false);
                setLineEdits({});
              }}
            />
          </View>
        ) : null}

        {/* Single-tap Approve / Edit / Reject Action Bar */}
        {!editingAccounts && summary.source === 'inbox' && inboxDetail && !inboxGuards.unsupportedOnMobile ? (
          <View style={{ gap: 10 }}>
            {inboxDetail.canApprove &&
            inboxGuards.payloadReady &&
            !inboxGuards.hasBlockingChecks &&
            !inboxGuards.hasUnclassifiedLines &&
            !inboxGuards.missingForeignRate ? (
              <PrimaryButton
                label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
                accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
                busy={busyAction === 'approve'}
                disabled={effectiveOffline || anyBusy || inboxGuards.inFlightExtraction}
                onPress={() => void onApproveInbox()}
              />
            ) : null}
            <View style={styles.actionsRow}>
              {inboxGuards.canEditNow ? (
                <View style={{ flex: 1 }}>
                  <SecondaryButton
                    label={t('approvals.action.edit')}
                    accessibilityLabel={`${t('approvals.action.edit')}: ${summary.title}`}
                    disabled={effectiveOffline || anyBusy || inboxGuards.inFlightExtraction}
                    onPress={() => setEditingAccounts(true)}
                  />
                </View>
              ) : null}
              {inboxDetail.canReject && inboxGuards.payloadReady ? (
                <View style={{ flex: 1 }}>
                  <DangerButton
                    label={busyAction === 'reject' ? t('approvals.action.working') : t('approvals.action.reject')}
                    accessibilityLabel={`${t('approvals.action.reject')}: ${summary.title}`}
                    busy={busyAction === 'reject'}
                    disabled={effectiveOffline || anyBusy || inboxGuards.inFlightExtraction}
                    onPress={() => void onRejectInbox()}
                  />
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {summary.source === 'social_post' && socialPost && !isMultiSocial && singleSocialVariant ? (
          <View style={{ gap: 10 }}>
            {!socialGuards.isFourEyesBlocked &&
            !socialGuards.alreadyApprovedByMe &&
            !socialGuards.clientWaitingOnly ? (
              <PrimaryButton
                label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
                accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
                busy={busyAction === 'approve'}
                disabled={effectiveOffline || anyBusy}
                onPress={() => void onDecideSocial('approved')}
              />
            ) : null}
            <View style={styles.actionsRow}>
              <View style={{ flex: 1 }}>
                <SecondaryButton
                  label={busyAction === 'changes' ? t('approvals.action.working') : t('approvals.action.requestChanges')}
                  accessibilityLabel={`${t('approvals.action.requestChanges')}: ${summary.title}`}
                  busy={busyAction === 'changes'}
                  disabled={!socialGuards.canRequestChangesNow || anyBusy}
                  onPress={() => void onDecideSocial('changes_requested')}
                />
              </View>
              <View style={{ flex: 1 }}>
                <DangerButton
                  label={busyAction === 'reject' ? t('approvals.action.working') : t('approvals.action.reject')}
                  accessibilityLabel={`${t('approvals.action.reject')}: ${summary.title}`}
                  busy={busyAction === 'reject'}
                  disabled={!socialGuards.canRejectNow || anyBusy}
                  onPress={() => void onDecideSocial('rejected')}
                />
              </View>
            </View>
          </View>
        ) : null}

        {isHrItem && !isRoleBlockedHr ? (
          <View style={{ gap: 10 }}>
            <PrimaryButton
              label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
              accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
              busy={busyAction === 'approve'}
              disabled={!hrGuards.canApproveNow || anyBusy}
              onPress={() => void onDecideHr('approve')}
            />
            <DangerButton
              label={busyAction === 'reject' ? t('approvals.action.working') : t('approvals.action.reject')}
              accessibilityLabel={`${t('approvals.action.reject')}: ${summary.title}`}
              busy={busyAction === 'reject'}
              disabled={!hrGuards.canRejectNow || anyBusy}
              onPress={() => void onDecideHr('reject')}
            />
          </View>
        ) : null}

        {showWebPrimary ? (
          <PrimaryButton label={t('approvals.action.openWeb')} onPress={() => void handleOpenWeb()} />
        ) : (
          <SecondaryButton label={t('approvals.action.openWeb')} onPress={() => void handleOpenWeb()} />
        )}

        <Text style={[styles.meta, { color: palette.muted, textAlign: 'center' }]}>
          {t('approvals.ai.offHint')}
        </Text>
      </ScrollView>

      {/* Directional account picker modal for editing purchase/sale lines */}
      <Modal
        animationType="slide"
        onRequestClose={() => setPickingLineNo(null)}
        visible={pickingLineNo !== null}
      >
        <View style={[styles.scrollContainer, { backgroundColor: palette.background, paddingTop: 20 }]}>
          <View style={[styles.scrollContent, { flex: 1 }]}>
            <View style={styles.row}>
              <Title>{t('approvals.detail.pickAccount')}</Title>
              <LinkButton label={t('approvals.detail.cancelEdit')} onPress={() => setPickingLineNo(null)} />
            </View>
            <TextInput
              accessibilityLabel={t('approvals.detail.pickAccount')}
              onChangeText={setAccountSearch}
              placeholder={invoiceDirection === 'sale' ? '511, 515, 711...' : '6422, 152, 156...'}
              placeholderTextColor={palette.muted}
              style={[styles.input, { borderColor: palette.border, color: palette.text }]}
              value={accountSearch}
            />
            {totalDirectionalAccounts > MAX_ACCOUNT_PICKER_ROWS ? (
              <Text style={[styles.meta, { color: palette.muted }]}>
                {t('approvals.detail.accountsTruncated', {
                  shown: String(MAX_ACCOUNT_PICKER_ROWS),
                  total: String(totalDirectionalAccounts),
                })}
              </Text>
            ) : null}
            {accountsQuery.isPending ? (
              <ActivityIndicator accessibilityLabel={t('home.loading')} />
            ) : (
              <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
                {filteredAccounts.slice(0, MAX_ACCOUNT_PICKER_ROWS).map((acct) => (
                  <Pressable
                    key={acct.code}
                    accessibilityRole="button"
                    accessibilityLabel={`${acct.code} ${acct.name}`}
                    onPress={() => {
                      if (pickingLineNo !== null) {
                        setLineEdits((prev) => ({ ...prev, [pickingLineNo]: acct.code }));
                      }
                      setPickingLineNo(null);
                    }}
                    style={[
                      styles.card,
                      { borderColor: palette.border, backgroundColor: palette.surface, minHeight: 48 },
                    ]}
                  >
                    <Body>{`${acct.code} - ${acct.name}`}</Body>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
