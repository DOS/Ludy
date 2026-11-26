// SPDX-License-Identifier: AGPL-3.0-only
// Pure queue filtering and action-guard state selectors for mobile approval screens (issue #4881).

import type { CachedApprovalSummary, CachedTodayNotice } from './cache.ts';
import type { HrDecisionStage } from './actions.ts';
import type { InboxDetail, OrgDetail, SocialPostDetail } from './model.ts';

export type QueueFilter = 'all' | 'finance' | 'hr' | 'social' | 'engage';

export function filterGroupForSummary(item: CachedApprovalSummary): Exclude<QueueFilter, 'all'> {
  if (item.source === 'hr_leave' || item.source === 'hr_salary_advance' || item.source === 'hr_business_trip') {
    return 'hr';
  }
  if (item.source === 'social_post' || item.subtype.startsWith('social.')) return 'social';
  if (item.subtype.startsWith('finance.')) return 'finance';
  return 'engage';
}

export function filterQueueItems(
  items: readonly CachedApprovalSummary[],
  filter: QueueFilter,
): CachedApprovalSummary[] {
  if (filter === 'all') return [...items];
  return items.filter((item) => filterGroupForSummary(item) === filter);
}

export function formatTodayNoticeTitle(notice: CachedTodayNotice): string {
  const leaf = notice.titleKey.split('.').slice(-2).join(' ').replace(/_/g, ' ');
  if (!notice.titleParams) return leaf || notice.titleKey;
  const details = Object.entries(notice.titleParams)
    .map(([, value]) => String(value))
    .join(', ');
  return details ? `${leaf}: ${details}` : leaf;
}

interface InboxActionGuards {
  inFlightExtraction: boolean;
  needsFailedAck: boolean;
  needsSigAck: boolean;
  needsFourEyes: boolean;
  cannotActOnMobile: boolean;
  canApproveNow: boolean;
  canEditNow: boolean;
  canRejectNow: boolean;
  showWebPrimary: boolean;
}

export function resolveInboxActionGuards(
  detail: InboxDetail | null,
  options: {
    isOffline: boolean;
    editingAccounts: boolean;
    acceptFailedChecks: boolean;
    acceptUnverifiedSig: boolean;
  },
): InboxActionGuards {
  if (!detail) {
    return {
      inFlightExtraction: false,
      needsFailedAck: false,
      needsSigAck: false,
      needsFourEyes: false,
      cannotActOnMobile: false,
      canApproveNow: false,
      canEditNow: false,
      canRejectNow: false,
      showWebPrimary: false,
    };
  }
  const inFlightExtraction = detail.extraction?.inFlight === true;
  const needsFailedAck = detail.failedChecks > 0;
  const needsSigAck =
    detail.signatureStatus === 'unverified' || detail.payload?.signature?.status === 'unverified';
  const needsFourEyes = !detail.canApprove && detail.approveReason === 'four_eyes';
  const cannotActOnMobile = !detail.canApprove && !detail.canEdit && !detail.canReject;

  const canWrite = !options.isOffline && !options.editingAccounts && !inFlightExtraction;
  const checksSatisfied =
    (!needsFailedAck || options.acceptFailedChecks) && (!needsSigAck || options.acceptUnverifiedSig);

  return {
    inFlightExtraction,
    needsFailedAck,
    needsSigAck,
    needsFourEyes,
    cannotActOnMobile,
    canApproveNow: canWrite && detail.canApprove && checksSatisfied,
    canEditNow: !options.isOffline && !inFlightExtraction && detail.canEdit && detail.payload !== null,
    canRejectNow: canWrite && detail.canReject,
    showWebPrimary: needsFourEyes || cannotActOnMobile,
  };
}

interface SocialActionGuards {
  pendingVariants: SocialPostDetail['variants'];
  singleVariant: SocialPostDetail['variants'][number] | null;
  isMultiDecision: boolean;
  isFourEyes: boolean;
  missingChecklistCount: number;
  canApproveNow: boolean;
  canRequestChangesNow: boolean;
  canRejectNow: boolean;
  showWebPrimary: boolean;
}

export function resolveSocialActionGuards(
  summary: Pick<CachedApprovalSummary, 'multiDecisionOnly'>,
  post: SocialPostDetail | null,
  options: {
    isOffline: boolean;
    tickedChecklistIds: Record<string, boolean>;
  },
): SocialActionGuards {
  const pendingVariants = (post?.variants ?? []).filter((v) => v.status === 'pending_review');
  const isMultiDecision = summary.multiDecisionOnly || pendingVariants.length > 1;
  const singleVariant = !isMultiDecision && pendingVariants.length === 1 ? (pendingVariants[0] ?? null) : null;
  const isFourEyes = singleVariant?.review.fourEyes === true;
  const requiredChecks = singleVariant?.checklist ?? [];
  const missingChecklistCount = requiredChecks.filter((c) => options.tickedChecklistIds[c.id] !== true).length;

  const canActSingle = Boolean(post && singleVariant && !isMultiDecision && !options.isOffline);
  return {
    pendingVariants,
    singleVariant,
    isMultiDecision,
    isFourEyes,
    missingChecklistCount,
    canApproveNow: canActSingle && !isFourEyes && missingChecklistCount === 0,
    canRequestChangesNow: canActSingle,
    canRejectNow: canActSingle,
    showWebPrimary: isMultiDecision || isFourEyes,
  };
}

interface HrActionGuards {
  isRoleBlocked: boolean;
  approveStage: Exclude<HrDecisionStage, 'reject'>;
  canApproveNow: boolean;
  canRejectNow: boolean;
  showWebPrimary: boolean;
}

export function resolveHrActionGuards(
  summary: Pick<CachedApprovalSummary, 'source' | 'subtype' | 'leaveStatus'>,
  role: OrgDetail['role'],
  options: {
    isOffline: boolean;
    canApproveL1?: boolean;
  },
): HrActionGuards {
  const isAdminOrOwner = role === 'owner' || role === 'admin';
  const isRoleBlocked =
    summary.source === 'hr_leave' && summary.leaveStatus === 'pending_final' && !isAdminOrOwner;
  const isPendingL1 =
    summary.source === 'hr_leave'
      ? summary.leaveStatus === 'pending_l1'
      : options.canApproveL1 === true && summary.subtype === 'pending_l1';

  const approveStage: Exclude<HrDecisionStage, 'reject'> = isPendingL1 ? 'approve_l1' : 'approve_final';

  return {
    isRoleBlocked,
    approveStage,
    canApproveNow: !options.isOffline && !isRoleBlocked,
    canRejectNow: !options.isOffline && !isRoleBlocked,
    showWebPrimary: isRoleBlocked,
  };
}
