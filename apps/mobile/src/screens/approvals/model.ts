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

export function isEngageProposalKind(kind: string): boolean {
  return ENGAGE_PROPOSAL_KINDS.has(kind);
}

export function isAdsProposalKind(kind: string): boolean {
  return (
    kind === 'ads.write_enable' ||
    kind === 'ads.account_enable' ||
    kind === 'ads.cap_set' ||
    kind === 'ads.campaign_launch' ||
    kind === 'ads.launch_enable' ||
    kind.startsWith('ads.')
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
  if (item.total !== null) {
    return { amount: item.total, currency: 'VND' };
  }
  if (item.kind === 'finance.supplier_payment') {
    const hint = parseMoneyHintFromTitle(item.title);
    if (hint) return { amount: hint.amount, currency: hint.currency };
  }
  return { amount: null, currency: null };
}

function inboxCounterparty(item: InboxListItem): string | null {
  if (item.direction === 'sale') return item.buyerName ?? item.sellerName;
  return item.sellerName ?? item.buyerName;
}

function buildInboxSummary(
  item: InboxListItem,
  coworkers: CachedCoworkerDirectory,
): CachedApprovalSummary {
  const { amount, currency } = inboxAmountAndCurrency(item);
  const requiresStepUp = true; // Kernel `inbox.approve` is always R3.
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
    requiresStepUp,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: item.issueDate,
    failedChecks: item.failedChecks,
    warnChecks: item.warnChecks + (item.anomalyChecks ?? 0),
    unclassifiedLines: item.unclassifiedLines,
    aiCoworker: resolveInboxCoworker(item, coworkers),
    webPath: `/inbox/${encodeURIComponent(item.id)}`,
    multiDecisionOnly: false,
    multiDecisionReason: null,
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
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: '/hr/employees',
    multiDecisionOnly: blockedByRole || (!canActAsL1 && !canActFinal),
    multiDecisionReason: blockedByRole ? 'insufficient_role' : null,
    revision: null,
    leaveStatus: item.status,
  };
}

function buildAdvanceSummary(
  item: HrAdvanceRequestItem,
  coworkers: CachedCoworkerDirectory,
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
    // Monetary request (payroll advance): guard with biometric confirmation.
    requiresStepUp: true,
    requiresNetwork: true,
    createdAt: item.createdAt,
    dateLabel: item.month,
    failedChecks: 0,
    warnChecks: 0,
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: coworkers ? '/hr/employees' : '/hr/employees',
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: null,
    leaveStatus: item.status,
  };
}

function buildTripSummary(item: HrTripRequestItem): CachedApprovalSummary | null {
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
    unclassifiedLines: 0,
    aiCoworker: null,
    webPath: '/hr/employees',
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: null,
    leaveStatus: item.status,
  };
}

function compareQueueOrder(a: CachedApprovalSummary, b: CachedApprovalSummary): number {
  // Prioritize failed/flagged items and monetary R3 items, then newest first.
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

interface LoadApprovalsParams {
  client: LudyClient;
  serverUrl: string;
  orgSlug: string;
  now?: () => number;
}

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

  let partialFailureCount = (todayRes.failed ? 1 : 0) + (inboxRes.failed ? 1 : 0);

  const items: CachedApprovalSummary[] = [];
  const liveByKey: Record<string, LiveApprovalExtra> = {};

  for (const inboxItem of inboxRes.value) {
    if (inboxItem.status !== 'pending') continue;
    const summary = buildInboxSummary(inboxItem, coworkers);
    items.push(summary);
    liveByKey[summary.key] = { inbox: inboxItem };
  }

  // Social reviews (owners and admins only, when Social module is effective).
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
        unclassifiedLines: 0,
        // Detailed AI provenance (`origin === 'ai' || tainted`) comes from `social.posts.get`.
        aiCoworker: null,
        webPath: `/social/posts/${encodeURIComponent(reviewItem.postId)}`,
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

  // HR pending leave requests, salary advances and business trips (when HR module is effective).
  if (effectiveApps.has('hr') && role !== 'viewer') {
    if (isAdminOrOwner) {
      const [leavesRes, advancesRes, tripsRes] = await Promise.all([
        safeRead(() => client.hr.leaveRequests.list({ limit: 100 }), [] as HrLeaveRequestItem[]),
        safeRead(() => client.hr.salaryAdvances.list({ limit: 100 }), [] as HrAdvanceRequestItem[]),
        safeRead(() => client.hr.businessTrips.list({ limit: 100 }), [] as HrTripRequestItem[]),
      ]);
      if (leavesRes.failed) partialFailureCount += 1;
      if (advancesRes.failed) partialFailureCount += 1;
      if (tripsRes.failed) partialFailureCount += 1;

      for (const leave of leavesRes.value) {
        if (leave.status !== 'pending_l1' && leave.status !== 'pending_final') continue;
        const summary = buildLeaveSummary(leave, role);
        items.push(summary);
        liveByKey[summary.key] = { leave };
      }
      for (const adv of advancesRes.value) {
        const summary = buildAdvanceSummary(adv, coworkers);
        if (!summary) continue;
        items.push(summary);
        liveByKey[summary.key] = { advance: adv };
      }
      for (const trip of tripsRes.value) {
        const summary = buildTripSummary(trip);
        if (!summary) continue;
        items.push(summary);
        liveByKey[summary.key] = { trip };
      }
    } else if (role === 'member') {
      const profileRes = await safeRead(() => client.hr.self.profile.get({}), null);
      if (profileRes.value && profileRes.value.managedDepartments.length > 0) {
        const managedIds = new Set(profileRes.value.managedDepartments.map((d) => d.id));
        const selfEmpId = profileRes.value.employeeId;
        const [leavesRes, advRes, tripRes] = await Promise.all([
          safeRead(
            () => client.hr.self.leave.requests({ scope: 'all', status: 'pending_l1', limit: 100 }),
            [] as HrLeaveRequestItem[],
          ),
          safeRead(
            () => client.hr.self.salaryAdvance.list({ status: 'pending_l1', limit: 100 }),
            { employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] },
          ),
          safeRead(
            () => client.hr.self.businessTrips.list({ status: 'pending_l1', limit: 100 }),
            { employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] },
          ),
        ]);
        for (const leave of leavesRes.value) {
          if (leave.status !== 'pending_l1') continue;
          if (selfEmpId && leave.employeeId === selfEmpId) continue;
          if (!leave.departmentId || !managedIds.has(leave.departmentId)) continue;
          const summary = buildLeaveSummary(leave, role);
          items.push(summary);
          liveByKey[summary.key] = { leave };
        }
        for (const adv of advRes.value.l1Queue) {
          const summary = buildAdvanceSummary(adv, coworkers);
          if (!summary) continue;
          items.push(summary);
          liveByKey[summary.key] = { advance: adv };
        }
        for (const trip of tripRes.value.l1Queue) {
          const summary = buildTripSummary(trip);
          if (!summary) continue;
          items.push(summary);
          liveByKey[summary.key] = { trip };
        }
      }
    }
  }

  items.sort(compareQueueOrder);

  // Build "Hôm nay cần bạn" notice strip (flags, deadlines, messages, and non-queue proposals for web hand-off).
  const todayNotices: CachedTodayNotice[] = [];
  for (const notice of todayRes.value.items) {
    if (notice.annotates === 'proposal') continue;
    if (notice.kind === 'proposal' && (notice.app === 'finance' || notice.app === 'social' || notice.app === 'hr')) {
      // Individual pending proposals are already represented in `items`.
      continue;
    }
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
