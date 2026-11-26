// SPDX-License-Identifier: AGPL-3.0-only
// Pure queue filtering, Today notice localization and action-guard state selectors for mobile approvals (issue #4881).

import type { HrDecisionStage } from './actions.ts';
import type { CachedApprovalSummary, CachedTodayNotice } from './cache.ts';
import type { Locale } from './format.ts';
import {
  isAdsProposalKind,
  isSupportedMobileInboxKind,
  type ChartAccount,
  type InboxDetail,
  type OrgDetail,
  type SocialPostDetail,
} from './model.ts';

export type QueueFilter = 'all' | 'finance' | 'hr' | 'social' | 'engage';

const BLOCKING_CHECK_ID_SET = new Set(['currency', 'lines_sum', 'total', 'amount_scale']);

const TODAY_KEY_TEMPLATES: Record<string, { vi: string; en: string }> = {
  financeEinvoiceAttention: {
    vi: '{count} hóa đơn bán hàng cần kiểm tra lại (bị từ chối, lỗi gửi hoặc chưa có phản hồi)',
    en: '{count} sales invoice(s) need attention (rejected, failed or unanswered)',
  },
  financeOriginalsNeeded: {
    vi: '{count} hóa đơn cần tải bản gốc từ cổng thuế',
    en: '{count} invoice(s) need the original fetched',
  },
  financeOriginalsFlagged: {
    vi: '{count} bản gốc khác số tiền hóa đơn hoặc chưa xác thực được',
    en: '{count} original(s) differ from posted figures or cannot be verified',
  },
  financeStatementsStaged: {
    vi: '{count} sao kê ngân hàng đang chờ bạn xác nhận',
    en: '{count} bank statement(s) waiting for confirmation',
  },
  financeRemindersDue: {
    vi: '{count} khách hàng quá hạn chưa được nhắc tuần này',
    en: '{count} overdue customer(s) have not been reminded this week',
  },
  financeBankLinesOpen: {
    vi: '{count} dòng sao kê chưa gắn phiếu thu/chi',
    en: '{count} statement line(s) have no voucher',
  },
  financeStockLow: {
    vi: '{count} mặt hàng tồn kho thấp nên xem xét nhập thêm',
    en: '{count} item(s) running low in stock',
  },
  financeVatDue: {
    vi: 'Tờ khai thuế GTGT kỳ {period}: hạn nộp {date}',
    en: 'VAT return for {period}: due on {date}',
  },
  financePeriodClose: {
    vi: 'Khóa sổ kỳ {period} trước ngày {date}',
    en: 'Lock books of {period} before {date}',
  },
  'hr.probationEnding': {
    vi: '{count} nhân sự sắp hết thử việc trong 7 ngày tới',
    en: '{count} employee(s) nearing end of probation in 7 days',
  },
  'hr.contractsExpiring': {
    vi: '{count} hợp đồng sắp hết hạn trong 30 ngày tới',
    en: '{count} contract(s) expiring within 30 days',
  },
  'hr.contractsExpired': {
    vi: '{count} nhân sự đang làm việc có hợp đồng đã quá hạn',
    en: '{count} active employee(s) have expired contracts',
  },
  'hr.workPermitsExpiring': {
    vi: '{count} giấy phép lao động sắp hết hạn trong 60 ngày tới',
    en: '{count} work permit(s) expiring within 60 days',
  },
  'hr.workPermitsExpired': {
    vi: '{count} nhân sự có giấy phép lao động đã quá hạn',
    en: '{count} employee(s) have expired work permits',
  },
  'hr.laborReport01Pli': {
    vi: 'Báo cáo lao động 01/PLI kỳ {period} cần nộp trước {date}',
    en: 'Labor report 01/PLI for {period} due before {date}',
  },
  'hr.payrollAdjustmentsPending': {
    vi: '{count} khoản truy lĩnh hoặc bù trừ lương đang chờ duyệt',
    en: '{count} payroll adjustment(s) waiting for approval',
  },
  'social.channels': {
    vi: '{count} kênh mạng xã hội cần kết nối lại',
    en: '{count} social channel(s) need reconnecting',
  },
  'social.attention': {
    vi: '{count} bài đăng lỗi hoặc đang tạm dừng',
    en: '{count} post(s) failed or paused',
  },
  'social.due': {
    vi: 'Một bài lên lịch trong 24 giờ tới vẫn chưa được duyệt',
    en: 'A post scheduled in the next 24 hours is awaiting approval',
  },
  'social.dueTitled': {
    vi: '"{title}" lên lịch trong 24 giờ tới nhưng chưa được duyệt',
    en: '"{title}" is scheduled in the next 24 hours and awaiting approval',
  },
  'social.dueOverdue': {
    vi: 'Một bài đã đến giờ đăng nhưng chưa được duyệt',
    en: 'A post past its scheduled time is still awaiting approval',
  },
  'social.dueOverdueTitled': {
    vi: '"{title}" đã đến giờ đăng nhưng chưa được duyệt',
    en: '"{title}" was meant to go out and is awaiting approval',
  },
  'social.dueMore': {
    vi: '{count} bài khác sắp tới giờ đăng nhưng chưa được duyệt',
    en: '{count} more scheduled post(s) awaiting approval',
  },
  'ads.paceOrg': {
    vi: 'Với tốc độ hiện tại, tổ chức sẽ vượt hạn mức chi tiêu tháng',
    en: 'At this pace the org passes its monthly spend cap',
  },
  'ads.paceAccount': {
    vi: 'Với tốc độ hiện tại, {account} sẽ vượt hạn mức tháng',
    en: 'At this pace {account} passes its monthly spend cap',
  },
  'ads.cpr': {
    vi: '{campaign} ({account}): chi phí mỗi kết quả gấp {ratio} lần mức thường thấy',
    en: '{campaign} ({account}): cost per result is {ratio}x usual',
  },
  'ads.cprMore': {
    vi: '{count} chiến dịch khác có chi phí mỗi kết quả tăng cao',
    en: '{count} more campaign(s) have elevated cost per result',
  },
  'crm.noActivity': {
    vi: 'Nhắc: deal đã {days} ngày chưa có cập nhật',
    en: 'Reminder: deal has had no update for {days} day(s)',
  },
  'crm.pastClose': {
    vi: 'Nhắc: deal đã quá ngày dự kiến chốt {days} ngày',
    en: 'Reminder: deal is {days} day(s) past expected close',
  },
  'crm.quoteUnanswered': {
    vi: 'Báo giá đã gửi {days} ngày chưa có phản hồi',
    en: 'Quote sent {days} day(s) ago has no answer',
  },
  'crm.quoteExpiring': {
    vi: 'Báo giá sắp hết hiệu lực',
    en: 'Quote is about to expire',
  },
  'crm.nextStepsMore': {
    vi: '{count} deal khác cần được theo dõi',
    en: '{count} more deal(s) need follow-up',
  },
  'crm.dealClosesToday': {
    vi: 'Deal dự kiến chốt hôm nay',
    en: 'Deal expected to close today',
  },
  'crm.booking': {
    vi: 'Lịch hẹn lúc {time}',
    en: 'Appointment at {time}',
  },
  'crm.bookingTomorrow': {
    vi: 'Lịch hẹn ngày mai lúc {time}',
    en: 'Appointment tomorrow at {time}',
  },
  'conversations.unanswered': {
    vi: '{count} tin nhắn khách hàng đang chờ trả lời',
    en: '{count} customer message(s) waiting for reply',
  },
  'conversations.oneUnanswered': {
    vi: 'Một khách hàng đang chờ bạn trả lời',
    en: 'A customer is waiting for your reply',
  },
};

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

export function formatTodayNoticeTitle(notice: CachedTodayNotice, locale: Locale = 'vi'): string {
  const entry = TODAY_KEY_TEMPLATES[notice.titleKey];
  if (entry) {
    const template = entry[locale];
    if (!notice.titleParams) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const val = notice.titleParams?.[name];
      return val !== undefined ? String(val) : match;
    });
  }
  // Readable fallback for unrecognized keys (split camelCase and dots).
  const readable = notice.titleKey
    .replace(/^today\.items\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._]+/g, ' ')
    .trim();
  if (!notice.titleParams) return readable || notice.titleKey;
  const details = Object.values(notice.titleParams).map(String).join(', ');
  return details ? `${readable}: ${details}` : readable;
}

export function isRevenueAccountCode(code: string): boolean {
  return /^(5|711|3387)/.test(code);
}

export function pickableAccountsForMobile(
  accounts: readonly ChartAccount[],
  direction: 'purchase' | 'sale',
  current?: string | null,
): ChartAccount[] {
  const wantRevenue = direction === 'sale';
  return accounts.filter((acct) => {
    if (current && acct.code === current) return true;
    return acct.active && isRevenueAccountCode(acct.code) === wantRevenue;
  });
}

interface InboxActionGuards {
  inFlightExtraction: boolean;
  hasBlockingChecks: boolean;
  hasUnclassifiedLines: boolean;
  missingForeignRate: boolean;
  unsupportedOnMobile: boolean;
  payloadReady: boolean;
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
    einvoiceLoaded?: boolean;
    adsLoaded?: boolean;
  },
): InboxActionGuards {
  if (!detail) {
    return {
      inFlightExtraction: false,
      hasBlockingChecks: false,
      hasUnclassifiedLines: false,
      missingForeignRate: false,
      unsupportedOnMobile: false,
      payloadReady: false,
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
  const unsupportedOnMobile = !isSupportedMobileInboxKind(detail.kind);
  const purchase = detail.payload;

  const hasBlockingChecks =
    purchase?.checks.some((c) => c.status === 'fail' && BLOCKING_CHECK_ID_SET.has(c.id)) ?? false;
  const hasUnclassifiedLines = detail.unclassifiedLines > 0;
  const missingForeignRate = Boolean(
    detail.kind === 'finance.purchase' &&
      purchase &&
      purchase.invoice.currency.toUpperCase() !== 'VND' &&
      !purchase.invoice.foreign,
  );

  let payloadReady = false;
  if (detail.kind === 'finance.purchase' || detail.kind === 'finance.sale') {
    payloadReady = purchase !== null;
  } else if (detail.kind === 'finance.cash_voucher') {
    payloadReady = detail.voucher !== null;
  } else if (detail.kind === 'finance.journal_voucher') {
    payloadReady = detail.journalVoucher !== null;
  } else if (detail.kind === 'finance.journal_reversal') {
    payloadReady = detail.reversal !== null;
  } else if (detail.kind === 'finance.einvoice_issue') {
    payloadReady = options.einvoiceLoaded === true;
  } else if (isAdsProposalKind(detail.kind)) {
    payloadReady = options.adsLoaded === true;
  } else {
    payloadReady = detail.engage !== null;
  }

  const needsFailedAck = !hasBlockingChecks && detail.failedChecks > 0;
  const needsSigAck =
    detail.signatureStatus === 'unverified' || purchase?.signature?.status === 'unverified';
  const needsFourEyes = !detail.canApprove && detail.approveReason === 'four_eyes';
  const cannotActOnMobile =
    unsupportedOnMobile || !payloadReady || (!detail.canApprove && !detail.canEdit && !detail.canReject);

  const canWrite = !options.isOffline && !options.editingAccounts && !inFlightExtraction;
  const checksSatisfied =
    !hasBlockingChecks &&
    !hasUnclassifiedLines &&
    !missingForeignRate &&
    (!needsFailedAck || options.acceptFailedChecks) &&
    (!needsSigAck || options.acceptUnverifiedSig);

  return {
    inFlightExtraction,
    hasBlockingChecks,
    hasUnclassifiedLines,
    missingForeignRate,
    unsupportedOnMobile,
    payloadReady,
    needsFailedAck,
    needsSigAck,
    needsFourEyes,
    cannotActOnMobile,
    canApproveNow: canWrite && !unsupportedOnMobile && payloadReady && detail.canApprove && checksSatisfied,
    canEditNow: !options.isOffline && !inFlightExtraction && detail.canEdit && purchase !== null,
    canRejectNow: canWrite && !unsupportedOnMobile && payloadReady && detail.canReject,
    showWebPrimary:
      unsupportedOnMobile ||
      needsFourEyes ||
      hasBlockingChecks ||
      missingForeignRate ||
      cannotActOnMobile,
  };
}

interface SocialActionGuards {
  pendingVariants: SocialPostDetail['variants'];
  singleVariant: SocialPostDetail['variants'][number] | null;
  isMultiDecision: boolean;
  isFourEyesBlocked: boolean;
  alreadyApprovedByMe: boolean;
  clientWaitingOnly: boolean;
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
    currentUserId: string | null;
    tickedChecklistIds: Record<string, boolean>;
  },
): SocialActionGuards {
  const pendingVariants = (post?.variants ?? []).filter((v) => v.status === 'in_review');
  const isMultiDecision = summary.multiDecisionOnly || pendingVariants.length > 1;
  const singleVariant = !isMultiDecision && pendingVariants.length === 1 ? (pendingVariants[0] ?? null) : null;

  const isOwnPost = Boolean(options.currentUserId && post?.authorUserId === options.currentUserId);
  const isFourEyesBlocked = Boolean(singleVariant?.review.fourEyes && isOwnPost);
  const alreadyApprovedByMe = Boolean(
    options.currentUserId && singleVariant?.review.approvedBy.includes(options.currentUserId),
  );
  const clientWaitingOnly = Boolean(
    singleVariant &&
      singleVariant.review.approvedBy.length >= singleVariant.review.required &&
      singleVariant.review.client,
  );

  const requiredChecks = singleVariant?.checklist ?? [];
  const missingChecklistCount = requiredChecks.filter((c) => options.tickedChecklistIds[c.id] !== true).length;

  const canActSingle = Boolean(post && singleVariant && !isMultiDecision && !options.isOffline);
  return {
    pendingVariants,
    singleVariant,
    isMultiDecision,
    isFourEyesBlocked,
    alreadyApprovedByMe,
    clientWaitingOnly,
    missingChecklistCount,
    canApproveNow:
      canActSingle &&
      !isFourEyesBlocked &&
      !alreadyApprovedByMe &&
      !clientWaitingOnly &&
      missingChecklistCount === 0,
    canRequestChangesNow: canActSingle,
    canRejectNow: canActSingle,
    showWebPrimary: isMultiDecision || isFourEyesBlocked || alreadyApprovedByMe || clientWaitingOnly,
  };
}

interface HrActionGuards {
  isRoleBlocked: boolean;
  hasLiveItem: boolean;
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
    hasLiveItem: boolean;
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
  const actionable = options.hasLiveItem && !options.isOffline && !isRoleBlocked;

  return {
    isRoleBlocked,
    hasLiveItem: options.hasLiveItem,
    approveStage,
    canApproveNow: actionable,
    canRejectNow: actionable,
    showWebPrimary: isRoleBlocked,
  };
}
