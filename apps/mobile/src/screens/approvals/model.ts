// SPDX-License-Identifier: AGPL-3.0-only
// Cross-app approvals queue data model and read aggregator over @ludy/client (issue #4881).

import {
  isMfaRequired,
  isOrgAccessRevoked,
  isStepUpRequired,
  isUnauthenticated,
  type LudyClient,
} from '@ludy/client';
import type {
  AiCoworkerId,
  ApprovalSourceKind,
  CachedApprovalSummary,
  CachedCoworkerDirectory,
  CachedTodayNotice,
} from './cache.ts';
import { isPositiveMoney, parseMoneyHintFromTitle } from './format.ts';

export type InboxListItem = Awaited<ReturnType<LudyClient['inbox']['list']>>[number];
export type InboxDetail = Awaited<ReturnType<LudyClient['inbox']['get']>>;
type TodayResult = Awaited<ReturnType<LudyClient['today']['list']>>;
export type SocialPostDetail = Awaited<ReturnType<LudyClient['social']['posts']['get']>>;
type HrLeaveRequestItem = Awaited<ReturnType<LudyClient['hr']['leaveRequests']['list']>>[number];
type HrAdvanceRequestItem = Awaited<ReturnType<LudyClient['hr']['salaryAdvances']['list']>>[number];
type HrTripRequestItem = Awaited<ReturnType<LudyClient['hr']['businessTrips']['list']>>[number];
export type OrgDetail = Awaited<ReturnType<LudyClient['org']['get']>>;
export type ChartAccount = Awaited<ReturnType<LudyClient['accounts']['list']>>[number];

export const DEFAULT_COWORKERS: Required<CachedCoworkerDirectory> = {
  gm: 'Vy',
  finance: 'Ly',
  sales: 'Dy',
  marketing: 'Uy',
};

const ENGAGE_PROPOSAL_KINDS = new Set([
  'kernel.conversation_reply',
  'kernel.conversation_reply_privately',
  'kernel.conversation_hide',
  'kernel.conversation_follow_up',
  'crm.quote_send',
  'crm.booking_move',
  'crm.booking_cancel',
  'social.post_submit',
  'social.variant_schedule',
  'ads.launch_stop',
  'ads.pause_all',
  'ads.object_pause',
  'ads.object_archive',
  'ads.budget_lower',
  'ads.schedule_shorten',
  'ads.manage_cancel',
]);

const HR_QUEUE_TODAY_IDS = new Set([
  'leave-approvals',
  'salary-advance-approvals',
  'business-trip-approvals',
  'leave-approvals-l1',
  'salary-advance-approvals-l1',
  'business-trip-approvals-l1',
]);

export function isEngageProposalKind(kind: string): boolean {
  return ENGAGE_PROPOSAL_KINDS.has(kind);
}

export function isAdsProposalKind(kind: string): boolean {
  if (isEngageProposalKind(kind)) return false;
  return (
    kind === 'ads.write_enable' ||
    kind === 'ads.account_enable' ||
    kind === 'ads.cap_set' ||
    kind === 'ads.launches_unblock' ||
    kind === 'ads.campaign_launch' ||
    kind === 'ads.object_resume' ||
    kind === 'ads.budget_raise' ||
    kind === 'ads.schedule_extend'
  );
}

export function isSupportedMobileInboxKind(kind: string): boolean {
  return (
    kind === 'finance.purchase' ||
    kind === 'finance.sale' ||
    kind === 'finance.cash_voucher' ||
    kind === 'finance.journal_voucher' ||
    kind === 'finance.journal_reversal' ||
    kind === 'finance.einvoice_issue' ||
    isAdsProposalKind(kind) ||
    isEngageProposalKind(kind)
  );
}

export interface LiveApprovalExtra {
  inbox?: InboxListItem;
  leave?: HrLeaveRequestItem;
  advance?: HrAdvanceRequestItem;
  trip?: HrTripRequestItem;
  socialPostId?: string;
  socialChannels?: Array<{ variantId: string; provider: string; displayName: string }>;
  socialExcerpt?: string;
  socialAt?: string | null;
}

export interface LiveApprovalsSnapshot {
  serverUrl: string;
  orgSlug: string;
  role: OrgDetail['role'];
  savedAt: number;
  items: CachedApprovalSummary[];
  todayNotices: CachedTodayNotice[];
  coworkers: CachedCoworkerDirectory;
  liveByKey: Record<string, LiveApprovalExtra>;
  partialFailureCount: number;
}

export function inferCoworkerKeyFromKind(kind: string): AiCoworkerId {
  if (kind.startsWith('finance.') || kind.startsWith('hr.')) return 'finance';
  if (kind.startsWith('crm.') || kind.startsWith('kernel.conversation_')) return 'sales';
  if (kind.startsWith('social.') || kind.startsWith('ads.')) return 'marketing';
  return 'gm';
}

export function resolveCoworkerName(
  coworkers: CachedCoworkerDirectory,
  key: AiCoworkerId,
): string {
  if (key === 'finance') return coworkers.finance ?? DEFAULT_COWORKERS.finance;
  if (key === 'sales') return coworkers.sales ?? DEFAULT_COWORKERS.sales;
  if (key === 'marketing') return coworkers.marketing ?? DEFAULT_COWORKERS.marketing;
  if (key === 'gm') return coworkers.gm ?? DEFAULT_COWORKERS.gm;
  return DEFAULT_COWORKERS.gm;
}

export function resolveInboxCoworker(
  item: Pick<InboxListItem, 'kind' | 'requestedByAgent' | 'requestedByMcp'>,
  coworkers: CachedCoworkerDirectory,
): { id: AiCoworkerId; label: string } | null {
  const id = inferCoworkerKeyFromKind(item.kind);
  if (item.requestedByAgent) {
    return { id, label: item.requestedByAgent.name || resolveCoworkerName(coworkers, id) };
  }
  if (item.requestedByMcp) {
    return { id, label: item.requestedByMcp.client || resolveCoworkerName(coworkers, id) };
  }
  if (isEngageProposalKind(item.kind)) {
    return { id, label: resolveCoworkerName(coworkers, id) };
  }
  return null;
}

export function todayCoworkerKeyForApp(app: string): AiCoworkerId {
  if (app === 'finance' || app === 'hr') return 'finance';
  if (app === 'crm' || app === 'conversations') return 'sales';
  if (app === 'social' || app === 'ads') return 'marketing';
  return 'gm';
}

export function itemKey(source: ApprovalSourceKind, id: string): string {
  return `${source}:${id}`;
}

export function readErrorCodeAndStatus(error: unknown): { code: string | null; status: number | null; message: string } {
  if (!error || typeof error !== 'object') {
    return { code: null, status: null, message: typeof error === 'string' ? error : '' };
  }
  const obj = error as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code : null;
  const status = typeof obj.status === 'number' ? obj.status : null;
  const message = typeof obj.message === 'string' ? obj.message : '';
  return { code, status, message };
}

export function isAuthBlockingError(error: unknown): boolean {
  return isUnauthenticated(error) || isMfaRequired(error) || isOrgAccessRevoked(error);
}

export function isExpectedSkipError(error: unknown): boolean {
  if (isStepUpRequired(error)) return false;
  const { code, status } = readErrorCodeAndStatus(error);
  if (status === 403 || status === 404) return true;
  return code === 'FORBIDDEN' || code === 'MODULE_OFF' || code === 'NOT_FOUND';
}

export function isLikelyNetworkError(error: unknown): boolean {
  if (isAuthBlockingError(error) || isStepUpRequired(error)) return false;
  const { status, code } = readErrorCodeAndStatus(error);
  if (status !== null && status >= 400 && status < 500) return false;
  if (code !== null && status !== null && status < 500) return false;
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'NetworkError') return true;
    if (/network|fetch|timeout|offline|failed to fetch|connection/i.test(error.message)) return true;
  }
  return status === null || status >= 500;
}

function inboxAmountAndCurrency(item: InboxListItem): { amount: string | null; currency: string | null } {
  if (item.kind === 'finance.cash_voucher' || item.kind === 'finance.journal_voucher') {
    return { amount: item.total, currency: item.total ? 'VND' : null };
  }
  if (item.kind === 'finance.supplier_payment') {
    const hint = parseMoneyHintFromTitle(item.title);
    if (hint) return { amount: hint.amount, currency: hint.currency };
  }
  // `inbox.list` omits currency on invoices/ads/crm proposals; detail fetch provides the exact ISO currency.
  return { amount: item.total, currency: null };
}

function inboxCounterparty(item: InboxListItem): string | null {
  if (item.direction === 'sale') return item.buyerName ?? item.sellerName;
  return item.sellerName ?? item.buyerName;
}

function hrWebPath(role: OrgDetail['role']): string {
  return role === 'owner' || role === 'admin' ? '/hr/employees' : '/hr/my';
}

function buildInboxSummary(
  item: InboxListItem,
  coworkers: CachedCoworkerDirectory,
): CachedApprovalSummary {
  const { amount, currency } = inboxAmountAndCurrency(item);
  const supportedOnMobile = isSupportedMobileInboxKind(item.kind);
  return {
    key: itemKey('inbox', item.id),
    source: 'inbox',
    id: item.id,
    subtype: item.kind,
    title: item.title,
    subtitle: inboxCounterparty(item) ?? item.kind,
    counterparty: inboxCounterparty(item),
    amount,
    currency,
    requiresStepUp: true,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: item.issueDate,
    failedChecks: item.failedChecks,
    warnChecks: item.warnChecks,
    anomalyChecks: item.anomalyChecks ?? 0,
    unclassifiedLines: item.unclassifiedLines,
    aiCoworker: resolveInboxCoworker(item, coworkers),
    webPath: `/inbox/${encodeURIComponent(item.id)}`,
    multiDecisionOnly: !supportedOnMobile,
    multiDecisionReason: supportedOnMobile ? null : 'unsupported_on_mobile',
    revision: item.revision,
  };
}

function buildLeaveSummary(item: HrLeaveRequestItem, role: OrgDetail['role']): CachedApprovalSummary {
  const canActAsL1 = item.status === 'pending_l1';
  const canActFinal = item.status === 'pending_final' && (role === 'owner' || role === 'admin');
  const blockedByRole = item.status === 'pending_final' && role !== 'owner' && role !== 'admin';
  return {
    key: itemKey('hr_leave', item.id),
    source: 'hr_leave',
    id: item.id,
    subtype: item.kind,
    title: item.employeeName,
    subtitle: item.reason ?? item.days,
    counterparty: item.departmentName,
    amount: null,
    currency: null,
    requiresStepUp: false,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: `${item.startOn}..${item.endOn}`,
    failedChecks: 0,
    warnChecks: 0,
    anomalyChecks: 0,
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: hrWebPath(role),
    multiDecisionOnly: blockedByRole || (!canActAsL1 && !canActFinal),
    multiDecisionReason: blockedByRole ? 'insufficient_role' : null,
    revision: null,
    leaveStatus: item.status,
  };
}

function buildAdvanceSummary(
  item: HrAdvanceRequestItem,
  role: OrgDetail['role'],
): CachedApprovalSummary | null {
  if (!item.canApproveL1 && !item.canApproveFinal) return null;
  return {
    key: itemKey('hr_salary_advance', item.id),
    source: 'hr_salary_advance',
    id: item.id,
    subtype: item.status,
    title: item.employeeName,
    subtitle: item.month,
    counterparty: item.departmentName,
    amount: item.amount,
    currency: 'VND',
    requiresStepUp: true,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: item.month,
    failedChecks: 0,
    warnChecks: 0,
    anomalyChecks: 0,
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: hrWebPath(role),
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: null,
    leaveStatus: item.status,
  };
}

function buildTripSummary(
  item: HrTripRequestItem,
  role: OrgDetail['role'],
): CachedApprovalSummary | null {
  if (!item.canApproveL1 && !item.canApproveFinal) return null;
  const hasMoney = isPositiveMoney(item.estimatedAllowance);
  return {
    key: itemKey('hr_business_trip', item.id),
    source: 'hr_business_trip',
    id: item.id,
    subtype: item.status,
    title: item.employeeName,
    subtitle: item.destination ? `${item.destination} (${item.startOn} - ${item.endOn})` : `${item.startOn} - ${item.endOn}`,
    counterparty: item.departmentName,
    amount: hasMoney ? item.estimatedAllowance : null,
    currency: hasMoney ? 'VND' : null,
    requiresStepUp: hasMoney,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: item.startOn,
    failedChecks: 0,
    warnChecks: 0,
    anomalyChecks: 0,
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: hrWebPath(role),
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: null,
    leaveStatus: item.status,
  };
}

function compareQueueOrder(a: CachedApprovalSummary, b: CachedApprovalSummary): number {
  const aRisk = a.failedChecks > 0 ? 0 : 1;
  const bRisk = b.failedChecks > 0 ? 0 : 1;
  if (aRisk !== bRisk) return aRisk - bRisk;

  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
  if (aTime !== bTime) return bTime - aTime;

  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

async function safeRead<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; skipped: boolean; failed: boolean; error: unknown }> {
  try {
    return { value: await fn(), skipped: false, failed: false, error: null };
  } catch (error) {
    if (isAuthBlockingError(error)) throw error;
    if (isExpectedSkipError(error)) return { value: fallback, skipped: true, failed: false, error: null };
    return { value: fallback, skipped: false, failed: true, error };
  }
}

function dedupeById<T extends { id: string }>(lists: readonly T[][]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

interface LoadApprovalsParams {
  client: LudyClient;
  serverUrl: string;
  orgSlug: string;
  now?: () => number;
}

const HR_FETCH_LIMIT = 100;

export async function loadApprovalsSnapshot(params: LoadApprovalsParams): Promise<LiveApprovalsSnapshot> {
  const { client, serverUrl, orgSlug } = params;
  const now = params.now ?? (() => Date.now());

  const [orgDetail, appsResult] = await Promise.all([
    client.org.get(),
    client.org.apps(),
  ]);

  const effectiveApps = new Set(
    appsResult.apps.filter((app) => app.effective).map((app) => app.id),
  );
  const role = orgDetail.role;
  const isAdminOrOwner = role === 'owner' || role === 'admin';

  const [todayRes, inboxRes] = await Promise.all([
    safeRead<TodayResult>(() => client.today.list(), {
      items: [],
      coworkers: { ...DEFAULT_COWORKERS },
      dropped: 0,
      truncated: 0,
      failed: 0,
    }),
    safeRead(() => client.inbox.list({ status: 'pending' }), [] as InboxListItem[]),
  ]);

  if (todayRes.failed && inboxRes.failed) {
    throw inboxRes.error;
  }

  const coworkers: CachedCoworkerDirectory = {
    gm: todayRes.value.coworkers.gm || DEFAULT_COWORKERS.gm,
    finance: todayRes.value.coworkers.finance || DEFAULT_COWORKERS.finance,
    sales: todayRes.value.coworkers.sales || DEFAULT_COWORKERS.sales,
    marketing: todayRes.value.coworkers.marketing || DEFAULT_COWORKERS.marketing,
  };

  let partialFailureCount = (todayRes.failed ? 1 : 0) + (inboxRes.failed ? 1 : 0) + (todayRes.value.failed > 0 ? 1 : 0);

  const items: CachedApprovalSummary[] = [];
  const liveByKey: Record<string, LiveApprovalExtra> = {};

  for (const inboxItem of inboxRes.value) {
    if (inboxItem.status !== 'pending') continue;
    const summary = buildInboxSummary(inboxItem, coworkers);
    items.push(summary);
    liveByKey[summary.key] = { inbox: inboxItem };
  }

  if (isAdminOrOwner && effectiveApps.has('social')) {
    const socialRes = await safeRead(() => client.social.reviewInbox({}), { items: [], total: 0 });
    if (socialRes.failed) partialFailureCount += 1;
    for (const reviewItem of socialRes.value.items) {
      const channelNames = reviewItem.channels.map((ch) => ch.displayName).join(', ');
      const multiChannel = reviewItem.channels.length > 1;
      const summary: CachedApprovalSummary = {
        key: itemKey('social_post', reviewItem.postId),
        source: 'social_post',
        id: reviewItem.postId,
        subtype: 'social.review',
        title: reviewItem.title ?? reviewItem.excerpt,
        subtitle: channelNames || reviewItem.excerpt,
        counterparty: channelNames || null,
        amount: null,
        currency: null,
        requiresStepUp: false,
        requiresNetwork: true,
        createdAt: reviewItem.submittedAt,
        dateLabel: reviewItem.at,
        failedChecks: 0,
        warnChecks: 0,
        anomalyChecks: 0,
        unclassifiedLines: 0,
        aiCoworker: null,
        webPath: `/social/${encodeURIComponent(reviewItem.postId)}`,
        multiDecisionOnly: multiChannel,
        multiDecisionReason: multiChannel ? 'multiple_channels' : null,
        revision: null,
        socialChannelsCount: reviewItem.channels.length,
      };
      items.push(summary);
      liveByKey[summary.key] = {
        socialPostId: reviewItem.postId,
        socialChannels: reviewItem.channels,
        socialExcerpt: reviewItem.excerpt,
        socialAt: reviewItem.at,
      };
    }
  }

  if (effectiveApps.has('hr') && role !== 'viewer') {
    if (isAdminOrOwner) {
      const [leavesL1, leavesFinal, advancesL1, advancesFinal, tripsL1, tripsFinal] = await Promise.all([
        safeRead(() => client.hr.leaveRequests.list({ status: 'pending_l1', limit: HR_FETCH_LIMIT }), [] as HrLeaveRequestItem[]),
        safeRead(() => client.hr.leaveRequests.list({ status: 'pending_final', limit: HR_FETCH_LIMIT }), [] as HrLeaveRequestItem[]),
        safeRead(() => client.hr.salaryAdvances.list({ status: 'pending_l1', limit: HR_FETCH_LIMIT }), [] as HrAdvanceRequestItem[]),
        safeRead(() => client.hr.salaryAdvances.list({ status: 'pending_final', limit: HR_FETCH_LIMIT }), [] as HrAdvanceRequestItem[]),
        safeRead(() => client.hr.businessTrips.list({ status: 'pending_l1', limit: HR_FETCH_LIMIT }), [] as HrTripRequestItem[]),
        safeRead(() => client.hr.businessTrips.list({ status: 'pending_final', limit: HR_FETCH_LIMIT }), [] as HrTripRequestItem[]),
      ]);

      const hrBatch = [leavesL1, leavesFinal, advancesL1, advancesFinal, tripsL1, tripsFinal];
      for (const res of hrBatch) {
        if (res.failed || res.value.length >= HR_FETCH_LIMIT) partialFailureCount += 1;
      }

      for (const leave of dedupeById([leavesL1.value, leavesFinal.value])) {
        if (leave.status !== 'pending_l1' && leave.status !== 'pending_final') continue;
        const summary = buildLeaveSummary(leave, role);
        items.push(summary);
        liveByKey[summary.key] = { leave };
      }
      for (const adv of dedupeById([advancesL1.value, advancesFinal.value])) {
        const summary = buildAdvanceSummary(adv, role);
        if (!summary) continue;
        items.push(summary);
        liveByKey[summary.key] = { advance: adv };
      }
      for (const trip of dedupeById([tripsL1.value, tripsFinal.value])) {
        const summary = buildTripSummary(trip, role);
        if (!summary) continue;
        items.push(summary);
        liveByKey[summary.key] = { trip };
      }
    } else if (role === 'member') {
      const profileRes = await safeRead(() => client.hr.self.profile.get({}), null);
      if (profileRes.failed) partialFailureCount += 1;
      if (profileRes.value && profileRes.value.managedDepartments.length > 0) {
        const managedIds = new Set(profileRes.value.managedDepartments.map((d) => d.id));
        const selfEmpId = profileRes.value.employeeId;
        const [leavesRes, advRes, tripRes] = await Promise.all([
          safeRead(
            () => client.hr.self.leave.requests({ scope: 'all', status: 'pending_l1', limit: HR_FETCH_LIMIT }),
            [] as HrLeaveRequestItem[],
          ),
          safeRead(
            () => client.hr.self.salaryAdvance.list({ status: 'pending_l1', limit: HR_FETCH_LIMIT }),
            { employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] },
          ),
          safeRead(
            () => client.hr.self.businessTrips.list({ status: 'pending_l1', limit: HR_FETCH_LIMIT }),
            { employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] },
          ),
        ]);
        if (leavesRes.failed || leavesRes.value.length >= HR_FETCH_LIMIT) partialFailureCount += 1;
        if (advRes.failed || advRes.value.l1Queue.length >= HR_FETCH_LIMIT) partialFailureCount += 1;
        if (tripRes.failed || tripRes.value.l1Queue.length >= HR_FETCH_LIMIT) partialFailureCount += 1;

        for (const leave of leavesRes.value) {
          if (leave.status !== 'pending_l1') continue;
          if (selfEmpId && leave.employeeId === selfEmpId) continue;
          if (!leave.departmentId || !managedIds.has(leave.departmentId)) continue;
          const summary = buildLeaveSummary(leave, role);
          items.push(summary);
          liveByKey[summary.key] = { leave };
        }
        for (const adv of advRes.value.l1Queue) {
          const summary = buildAdvanceSummary(adv, role);
          if (!summary) continue;
          items.push(summary);
          liveByKey[summary.key] = { advance: adv };
        }
        for (const trip of tripRes.value.l1Queue) {
          const summary = buildTripSummary(trip, role);
          if (!summary) continue;
          items.push(summary);
          liveByKey[summary.key] = { trip };
        }
      }
    }
  }

  items.sort(compareQueueOrder);

  const todayNotices: CachedTodayNotice[] = [];
  for (const notice of todayRes.value.items) {
    if (notice.annotates === 'proposal') continue;
    // Skip only the exact summary notices already replaced by individual items in `items`.
    if (notice.app === 'finance' && notice.kind === 'proposal') continue;
    if (notice.app === 'social' && notice.id === 'review') continue;
    if (notice.app === 'hr' && HR_QUEUE_TODAY_IDS.has(notice.id)) continue;

    const coworkerId = todayCoworkerKeyForApp(notice.app);
    todayNotices.push({
      key: `${notice.app}:${notice.kind}:${notice.id}`,
      kind: notice.kind,
      app: notice.app,
      id: notice.id,
      titleKey: notice.title.key,
      titleParams: notice.title.params,
      amount: notice.amount ?? null,
      currency: notice.amount ? (notice.currency ?? 'VND') : null,
      count: notice.count ?? null,
      dueAt: notice.dueAt ?? null,
      severity: notice.severity ?? null,
      webPath: notice.href,
      aiCoworkerLabel: resolveCoworkerName(coworkers, coworkerId),
    });
  }

  return {
    serverUrl,
    orgSlug,
    role,
    savedAt: now(),
    items,
    todayNotices,
    coworkers,
    liveByKey,
    partialFailureCount,
  };
}
