// SPDX-License-Identifier: AGPL-3.0-only
// Detail screen for a single cross-app approval item with biometric step-up, inline account edit and web hand-off (issue #4881).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
import { clientFor, SERVER_POLICY, stepUp, t } from '../../runtime.ts';
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
import type { CachedApprovalSummary } from './cache.ts';
import {
  buildWebUrl,
  formatDateShort,
  formatMoney,
  type Locale,
} from './format.ts';
import {
  isAdsProposalKind,
  isLikelyNetworkError,
  type ChartAccount,
  type LiveApprovalExtra,
  type OrgDetail,
} from './model.ts';
import {
  resolveHrActionGuards,
  resolveInboxActionGuards,
  resolveSocialActionGuards,
} from './view-state.ts';

export interface ApprovalDetailScreenProps {
  serverUrl: string;
  orgSlug: string;
  locale: Locale;
  role: OrgDetail['role'];
  summary: CachedApprovalSummary;
  liveExtra?: LiveApprovalExtra;
  isOffline: boolean;
  onBack: () => void;
  onCompleted: (message: string) => void;
}

export function ApprovalDetailScreen(props: ApprovalDetailScreenProps) {
  const { serverUrl, orgSlug, locale, role, summary, liveExtra, isOffline } = props;
  const palette = usePalette();
  const qc = useQueryClient();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);

  const [busyAction, setBusyAction] = useState<'approve' | 'edit' | 'reject' | 'changes' | null>(null);
  const [note, setNote] = useState('');
  const [acceptFailedChecks, setAcceptFailedChecks] = useState(false);
  const [acceptUnverifiedSig, setAcceptUnverifiedSig] = useState(false);
  const [editingAccounts, setEditingAccounts] = useState(false);
  const [lineEdits, setLineEdits] = useState<Record<number, string>>({});
  const [pickingLineNo, setPickingLineNo] = useState<number | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const [tickedChecklistIds, setTickedChecklistIds] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string; showWebButton?: boolean } | null>(null);

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

  const activeAccounts = useMemo<ChartAccount[]>(() => {
    const list = (accountsQuery.data ?? []).filter((a) => a.active);
    const q = accountSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (a) => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    );
  }, [accountsQuery.data, accountSearch]);

  const effectiveOffline =
    isOffline ||
    (inboxDetailQuery.isError && isLikelyNetworkError(inboxDetailQuery.error)) ||
    (socialDetailQuery.isError && isLikelyNetworkError(socialDetailQuery.error));

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

  const inboxDetail = inboxDetailQuery.data ?? null;
  const purchasePayload =
    summary.source === 'inbox' && summary.subtype === 'finance.purchase'
      ? (inboxDetail?.payload ?? null)
      : null;
  const voucherPayload = inboxDetail?.voucher ?? null;
  const journalVoucherPayload = inboxDetail?.journalVoucher ?? null;
  const reversalPayload = inboxDetail?.reversal ?? null;
  const engagePayload = inboxDetail?.engage ?? null;
  const einvoiceDetail = einvoiceQuery.data ?? null;
  const adsChange = adsQuery.data?.change ?? null;
  const socialPost = socialDetailQuery.data ?? null;

  const inboxGuards = resolveInboxActionGuards(inboxDetail, {
    isOffline: effectiveOffline,
    editingAccounts,
    acceptFailedChecks,
    acceptUnverifiedSig,
  });
  const socialGuards = resolveSocialActionGuards(summary, socialPost, {
    isOffline: effectiveOffline,
    tickedChecklistIds,
  });
  const hrGuards = resolveHrActionGuards(summary, role, {
    isOffline: effectiveOffline,
    canApproveL1:
      summary.source === 'hr_salary_advance'
        ? liveExtra?.advance?.canApproveL1
        : summary.source === 'hr_business_trip'
          ? liveExtra?.trip?.canApproveL1
          : undefined,
  });

  const pendingSocialVariants = socialGuards.pendingVariants;
  const singleSocialVariant = socialGuards.singleVariant;

  const displayedAiCoworker = useMemo(() => {
    if (summary.aiCoworker) return summary.aiCoworker.label;
    if (socialPost && (socialPost.origin === 'ai' || socialPost.tainted)) return 'Uy';
    if (adsChange?.change === 'campaign_launch' && adsChange.origin === 'ai') return 'Uy';
    return null;
  }, [summary.aiCoworker, socialPost, adsChange]);

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
    try {
      const outcome = await approveInboxProposal(
        { client, stepUp, crypto: deviceCrypto, isOffline: effectiveOffline },
        {
          id: inboxDetail.id,
          revision: inboxDetail.revision,
          prompt: t('approvals.biometric.prompt', { title: summary.title }),
          note,
          acceptFailedChecks: inboxGuards.needsFailedAck ? acceptFailedChecks : undefined,
          acceptUnverifiedSignature: inboxGuards.needsSigAck ? acceptUnverifiedSig : undefined,
        },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
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
    try {
      const outcome = await editInboxProposal(
        { client, crypto: deviceCrypto, isOffline: effectiveOffline },
        {
          id: inboxDetail.id,
          revision: inboxDetail.revision,
          lineAccounts: changedLines,
        },
      );
      if (!outcome.ok) {
        applyOutcomeError(outcome);
        return;
      }
      setEditingAccounts(false);
      setLineEdits({});
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
        { client, isOffline: effectiveOffline },
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
        { client, isOffline: effectiveOffline },
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
          { client, isOffline: effectiveOffline },
          { requestId: summary.id, stage, note },
        );
        if (!outcome.ok) {
          applyOutcomeError(outcome);
          return;
        }
      } else if (summary.source === 'hr_salary_advance') {
        const outcome = await decideSalaryAdvance(
          { client, stepUp, isOffline: effectiveOffline },
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
          { client, stepUp, isOffline: effectiveOffline },
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

  const formattedSummaryAmount = summary.amount ? formatMoney(summary.amount, summary.currency ?? 'VND', locale) : null;
  const anyBusy = busyAction !== null;

  const isMultiSocial = summary.source === 'social_post' && socialGuards.isMultiDecision;
  const isRoleBlockedHr =
    (summary.source === 'hr_leave' ||
      summary.source === 'hr_salary_advance' ||
      summary.source === 'hr_business_trip') &&
    hrGuards.isRoleBlocked;

  const inboxNeedsFourEyes = inboxGuards.needsFourEyes;
  const inboxCannotAct = inboxGuards.cannotActOnMobile;

  const isDetailLoading =
    !effectiveOffline &&
    ((summary.source === 'inbox' && inboxDetailQuery.isPending) ||
      (summary.source === 'social_post' && socialDetailQuery.isPending));

  const detailLoadFailedOffline =
    (summary.source === 'inbox' && inboxDetailQuery.isError) ||
    (summary.source === 'social_post' && socialDetailQuery.isError);

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
              {`${purchasePayload.seller.name}${purchasePayload.seller.taxCode ? ` (${t('approvals.detail.taxCode')}: ${purchasePayload.seller.taxCode})` : ''}`}
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
            {purchasePayload.lines.slice(0, 25).map((line) => {
              const currentAcct = lineEdits[line.lineNo] ?? line.debitAccount;
              const accountDisplay =
                currentAcct === '000'
                  ? t('approvals.detail.unclassifiedAccount')
                  : t('approvals.detail.lineAccount', { account: currentAcct });
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
                        setPickingLineNo(line.lineNo);
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
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
            {journalVoucherPayload.lines.slice(0, 20).map((line, index) => (
              <Text key={`${line.account}-${index}`} style={[styles.meta, { color: palette.muted }]}>
                {`${line.account}: Nợ ${formatMoney(line.debit, 'VND', locale)} / Có ${formatMoney(line.credit, 'VND', locale)}`}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Journal Reversal */}
        {reversalPayload ? (
          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
            <Body>{`${t('approvals.detail.reason')}: ${reversalPayload.reason}`}</Body>
            <Text style={[styles.meta, { color: palette.muted }]}>
              {formatDateShort(reversalPayload.entryDate, locale)}
            </Text>
            {journalQuery.data ? (
              <Body tone="muted">{journalQuery.data.description}</Body>
            ) : null}
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
            {einvoiceDetail.lines.slice(0, 15).map((line) => (
              <Text key={line.lineNo} style={[styles.meta, { color: palette.muted }]}>
                {`${line.lineNo}. ${line.description}: ${formatMoney(line.amount, einvoiceDetail.currency, locale)}`}
              </Text>
            ))}
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

        {/* Engage AI Coworker Proposal */}
        {inboxDetail && !engagePayload && summary.aiCoworker && !purchasePayload && !isAdsProposalKind(summary.subtype) ? (
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

        {/* Four-eyes / Multi-decision / Role Notices */}
        {inboxNeedsFourEyes ? (
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

        {/* Safety checkboxes for inbox items */}
        {inboxDetail && inboxDetail.canApprove && !editingAccounts ? (
          <View style={{ gap: 4 }}>
            {inboxDetail.failedChecks > 0 ? (
              <CheckboxRow
                label={t('approvals.detail.acceptFailedChecks')}
                checked={acceptFailedChecks}
                disabled={anyBusy}
                onToggle={() => setAcceptFailedChecks((v) => !v)}
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
                  onToggle={() => setAcceptUnverifiedSig((v) => !v)}
                />
              </>
            ) : null}
          </View>
        ) : null}

        {/* Note / Reason input */}
        {!isMultiSocial && !isRoleBlockedHr && !inboxCannotAct && !editingAccounts ? (
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
        {!editingAccounts && summary.source === 'inbox' && inboxDetail ? (
          <View style={{ gap: 10 }}>
            {inboxDetail.canApprove ? (
              <PrimaryButton
                label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
                accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
                busy={busyAction === 'approve'}
                disabled={effectiveOffline || anyBusy || inboxGuards.inFlightExtraction}
                onPress={() => void onApproveInbox()}
              />
            ) : null}
            <View style={styles.actionsRow}>
              {inboxDetail.canEdit && purchasePayload ? (
                <View style={{ flex: 1 }}>
                  <SecondaryButton
                    label={t('approvals.action.edit')}
                    accessibilityLabel={`${t('approvals.action.edit')}: ${summary.title}`}
                    disabled={effectiveOffline || anyBusy || inboxGuards.inFlightExtraction}
                    onPress={() => setEditingAccounts(true)}
                  />
                </View>
              ) : null}
              {inboxDetail.canReject ? (
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
            {!singleSocialVariant.review.fourEyes ? (
              <PrimaryButton
                label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
                accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
                busy={busyAction === 'approve'}
                disabled={effectiveOffline || anyBusy}
                onPress={() => void onDecideSocial('approved')}
              />
            ) : (
              <Banner tone="warn">
                <Body tone="warning">{t('approvals.detail.fourEyes')}</Body>
              </Banner>
            )}
            <View style={styles.actionsRow}>
              <View style={{ flex: 1 }}>
                <SecondaryButton
                  label={busyAction === 'changes' ? t('approvals.action.working') : t('approvals.action.requestChanges')}
                  accessibilityLabel={`${t('approvals.action.requestChanges')}: ${summary.title}`}
                  busy={busyAction === 'changes'}
                  disabled={effectiveOffline || anyBusy}
                  onPress={() => void onDecideSocial('changes_requested')}
                />
              </View>
              <View style={{ flex: 1 }}>
                <DangerButton
                  label={busyAction === 'reject' ? t('approvals.action.working') : t('approvals.action.reject')}
                  accessibilityLabel={`${t('approvals.action.reject')}: ${summary.title}`}
                  busy={busyAction === 'reject'}
                  disabled={effectiveOffline || anyBusy}
                  onPress={() => void onDecideSocial('rejected')}
                />
              </View>
            </View>
          </View>
        ) : null}

        {(summary.source === 'hr_leave' ||
          summary.source === 'hr_salary_advance' ||
          summary.source === 'hr_business_trip') &&
        !isRoleBlockedHr ? (
          <View style={{ gap: 10 }}>
            <PrimaryButton
              label={busyAction === 'approve' ? t('approvals.action.working') : t('approvals.action.approve')}
              accessibilityLabel={`${t('approvals.action.approve')}: ${summary.title}`}
              busy={busyAction === 'approve'}
              disabled={effectiveOffline || anyBusy}
              onPress={() => void onDecideHr('approve')}
            />
            <DangerButton
              label={busyAction === 'reject' ? t('approvals.action.working') : t('approvals.action.reject')}
              accessibilityLabel={`${t('approvals.action.reject')}: ${summary.title}`}
              busy={busyAction === 'reject'}
              disabled={effectiveOffline || anyBusy}
              onPress={() => void onDecideHr('reject')}
            />
          </View>
        ) : null}

        {/* Always-present safe "Mở trên web" hand-off button */}
        {isMultiSocial || isRoleBlockedHr || inboxNeedsFourEyes || inboxCannotAct ? (
          <PrimaryButton label={t('approvals.action.openWeb')} onPress={() => void handleOpenWeb()} />
        ) : (
          <SecondaryButton label={t('approvals.action.openWeb')} onPress={() => void handleOpenWeb()} />
        )}

        <Text style={[styles.meta, { color: palette.muted, textAlign: 'center' }]}>
          {t('approvals.ai.offHint')}
        </Text>
      </ScrollView>

      {/* Account picker modal for editing finance.purchase debit accounts */}
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
              placeholder="6422, 152, 156..."
              placeholderTextColor={palette.muted}
              style={[styles.input, { borderColor: palette.border, color: palette.text }]}
              value={accountSearch}
            />
            {accountsQuery.isPending ? (
              <ActivityIndicator accessibilityLabel={t('home.loading')} />
            ) : (
              <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
                {activeAccounts.slice(0, 80).map((acct) => (
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
