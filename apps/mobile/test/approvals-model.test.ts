// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { LudyClient } from '@ludy/client';
import {
  DEFAULT_COWORKERS,
  inferCoworkerKeyFromKind,
  isAdsProposalKind,
  isAuthBlockingError,
  isEngageProposalKind,
  isExpectedSkipError,
  isLikelyNetworkError,
  itemKey,
  loadApprovalsSnapshot,
  readErrorCodeAndStatus,
  resolveCoworkerName,
  resolveInboxCoworker,
  todayCoworkerKeyForApp,
  type InboxDetail,
  type InboxListItem,
  type SocialPostDetail,
} from '../src/screens/approvals/model.ts';
import {
  filterGroupForSummary,
  filterQueueItems,
  formatTodayNoticeTitle,
  resolveHrActionGuards,
  resolveInboxActionGuards,
  resolveSocialActionGuards,
} from '../src/screens/approvals/view-state.ts';
import { SERVER } from './helpers.ts';

function fakeInboxItem(overrides: Partial<InboxListItem> = {}): InboxListItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'finance.purchase',
    status: 'pending',
    title: 'HD 0001 - NCC Alpha',
    direction: 'purchase',
    revision: 1,
    sellerName: 'Công ty Alpha',
    buyerName: null,
    legalEntityId: '00000000-0000-4000-8000-000000000010',
    total: '1500000',
    issueDate: '2026-11-26',
    failedChecks: 0,
    warnChecks: 0,
    unclassifiedLines: 0,
    learnedRuleIds: [],
    otherRuleLines: 0,
    signatureStatus: 'verified',
    duplicateOf: null,
    createdAt: '2026-11-26T08:00:00Z',
    requestedByAgent: null,
    requestedByMcp: null,
    extracted: true,
    expiredAfterDays: null,
    voided: false,
    ...overrides,
  };
}

function makeFakeClient(overrides: Record<string, unknown> = {}): LudyClient {
  const base = {
    org: {
      get: async () => ({
        orgId: 'o1',
        slug: 'demo',
        name: 'Demo',
        role: 'owner',
        taxCode: null,
        vatFilingPeriod: null,
        address: null,
        contactEmail: null,
        inboundAddress: null,
        conversationAddress: null,
        inboundDroppedCount: null,
      }),
      apps: async () => ({
        apps: [
          { id: 'finance', deployment: true, entitled: true, enabled: true, effective: true },
          { id: 'social', deployment: true, entitled: true, enabled: true, effective: true },
          { id: 'hr', deployment: true, entitled: true, enabled: true, effective: true },
        ],
        version: 1,
        canChange: true,
      }),
    },
    today: {
      list: async () => ({
        items: [],
        coworkers: { ...DEFAULT_COWORKERS },
        dropped: 0,
        truncated: 0,
        failed: 0,
      }),
    },
    inbox: {
      list: async () => [],
    },
    social: {
      reviewInbox: async () => ({ items: [], total: 0 }),
    },
    hr: {
      leaveRequests: { list: async () => [] },
      salaryAdvances: { list: async () => [] },
      businessTrips: { list: async () => [] },
      self: {
        profile: {
          get: async () => ({
            linked: false,
            employeeId: null,
            displayName: null,
            legalEntityId: null,
            legalEntityName: null,
            departmentId: null,
            departmentName: null,
            departmentManagerName: null,
            jobTitle: null,
            status: null,
            hireDate: null,
            endedOn: null,
            managesDepartmentCount: 0,
            managedDepartments: [],
          }),
        },
        leave: { requests: async () => [] },
        salaryAdvance: { list: async () => ({ employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] }) },
        businessTrips: { list: async () => ({ employeeId: null, employeeName: null, departmentId: null, items: [], l1Queue: [] }) },
      },
    },
    ...overrides,
  };
  return base as unknown as LudyClient;
}

describe('cross-app queue aggregation and AI coworker attribution', () => {
  it('merges Inbox, Social and HR items with coworker badges and supplier payment hint', async () => {
    const client = makeFakeClient({
      today: {
        list: async () => ({
          items: [
            // Excluded because pending Finance/Social/HR proposals live in main actionable queue.
            { kind: 'proposal', app: 'finance', id: 'fin-q', title: { key: 'finance.today.inbox' }, href: '/inbox' },
            // Included: flag & deadline & non-queue proposal.
            {
              kind: 'flag',
              app: 'ads',
              id: 'ads-pace',
              title: { key: 'ads.today.spend_pace', params: { campaign: 'Tết 2027' } },
              amount: '2000000',
              currency: 'VND',
              severity: 'warn',
              href: '/ads',
            },
            {
              kind: 'deadline',
              app: 'finance',
              id: 'vat-due',
              title: { key: 'finance.today.vat_due' },
              dueAt: '2026-11-30T17:00:00+07:00',
              href: '/finance/tax',
            },
          ],
          coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' },
          dropped: 0,
          truncated: 0,
          failed: 0,
        }),
      },
      inbox: {
        list: async () => [
          fakeInboxItem({
            id: 'p-1',
            kind: 'finance.supplier_payment',
            title: 'Chi 3200000 VND cho nhà cung cấp',
            total: null,
            requestedByAgent: { id: 'a1', name: 'Ly' },
          }),
          fakeInboxItem({
            id: 'p-2',
            kind: 'crm.quote_send',
            title: 'Gửi báo giá #BG-09',
            sellerName: 'Khách hàng Beta',
            total: '9500000',
            failedChecks: 1,
            requestedByAgent: null,
          }),
          fakeInboxItem({
            id: 'p-3',
            kind: 'finance.purchase',
            title: 'Hóa đơn điện lực',
            requestedByAgent: null,
            requestedByMcp: null,
          }),
        ],
      },
      social: {
        reviewInbox: async () => ({
          items: [
            {
              postId: 'soc-1',
              title: 'Khai trương chi nhánh',
              excerpt: 'Nội dung bài viết...',
              channels: [
                { variantId: 'v1', provider: 'facebook_page', displayName: 'Fanpage Chính' },
                { variantId: 'v2', provider: 'zalo_oa', displayName: 'Zalo OA' },
              ],
              at: '2026-11-27T09:00:00+07:00',
              submittedAt: '2026-11-26T09:30:00Z',
            },
          ],
          total: 1,
        }),
      },
      hr: {
        leaveRequests: {
          list: async () => [
            {
              id: 'lv-1',
              legalEntityId: 'le-1',
              employeeId: 'emp-1',
              employeeName: 'Nguyễn Văn A',
              departmentId: 'd-1',
              departmentName: 'Kinh doanh',
              month: '2026-11',
              startOn: '2026-11-28',
              endOn: '2026-11-28',
              kind: 'annual_leave',
              days: '1',
              status: 'pending_final',
              reason: 'Việc gia đình',
              decisionNote: null,
              l1ApproverUserId: 'u-1',
              l1ApproverName: 'Trưởng nhóm',
              l1ActedAt: null,
              finalActedBy: null,
              finalActedByName: null,
              finalActedAt: null,
              payrollLeaveEntryId: null,
              createdAt: '2026-11-26T07:00:00Z',
              updatedAt: '2026-11-26T07:00:00Z',
            },
          ],
        },
        salaryAdvances: {
          list: async () => [
            {
              id: 'adv-1',
              legalEntityId: 'le-1',
              employeeId: 'emp-2',
              employeeName: 'Trần Thị B',
              departmentId: 'd-1',
              departmentName: 'Vận hành',
              month: '2026-11',
              amount: '3000000',
              reason: 'Ứng lương tháng 11',
              status: 'pending_final',
              l1ApproverUserId: null,
              l1ActedAt: null,
              finalActedBy: null,
              finalActedAt: null,
              decisionNote: null,
              payrollRunId: null,
              createdAt: '2026-11-26T06:00:00Z',
              updatedAt: '2026-11-26T06:00:00Z',
              canApproveL1: false,
              canApproveFinal: true,
              canCancel: false,
            },
          ],
        },
        businessTrips: { list: async () => [] },
        self: {
          profile: { get: async () => ({}) },
          leave: { requests: async () => [] },
          salaryAdvance: { list: async () => ({ items: [], l1Queue: [] }) },
          businessTrips: { list: async () => ({ items: [], l1Queue: [] }) },
        },
      },
    });

    const snap = await loadApprovalsSnapshot({ client, serverUrl: SERVER, orgSlug: 'demo', now: () => 5000 });
    expect(snap.savedAt).toBe(5000);
    expect(snap.items).toHaveLength(5);

    const payment = snap.items.find((i) => i.key === itemKey('inbox', 'p-1'));
    expect(payment?.amount).toBe('3200000');
    expect(payment?.currency).toBe('VND');
    expect(payment?.requiresStepUp).toBe(true);
    expect(payment?.aiCoworker).toEqual({ id: 'finance', label: 'Ly' });

    const quote = snap.items.find((i) => i.key === itemKey('inbox', 'p-2'));
    expect(quote?.aiCoworker).toEqual({ id: 'sales', label: 'Dy' });
    // Failed checks item is sorted first!
    expect(snap.items[0]?.id).toBe('p-2');

    // Human-uploaded purchase has no fake AI attribution.
    const humanBill = snap.items.find((i) => i.key === itemKey('inbox', 'p-3'));
    expect(humanBill?.aiCoworker).toBeNull();

    // Multi-channel Social post marked for web hand-off.
    const social = snap.items.find((i) => i.key === itemKey('social_post', 'soc-1'));
    expect(social?.multiDecisionOnly).toBe(true);
    expect(social?.multiDecisionReason).toBe('multiple_channels');

    const adv = snap.items.find((i) => i.key === itemKey('hr_salary_advance', 'adv-1'));
    expect(adv?.requiresStepUp).toBe(true);
    expect(adv?.amount).toBe('3000000');

    expect(snap.todayNotices).toHaveLength(2);
    expect(snap.todayNotices[0]?.aiCoworkerLabel).toBe('Uy');
    expect(snap.todayNotices[1]?.aiCoworkerLabel).toBe('Ly');
  });

  it('scopes member HR queue to managed departments L1 only', async () => {
    const client = makeFakeClient({
      org: {
        get: async () => ({ orgId: 'o1', slug: 'demo', name: 'Demo', role: 'member' }),
        apps: async () => ({ apps: [{ id: 'hr', effective: true }], version: 1, canChange: false }),
      },
      hr: {
        leaveRequests: { list: async () => [] },
        salaryAdvances: { list: async () => [] },
        businessTrips: { list: async () => [] },
        self: {
          profile: {
            get: async () => ({
              linked: true,
              employeeId: 'emp-mgr',
              managedDepartments: [{ id: 'dept-sales', legalEntityId: 'le-1', name: 'Sales', code: 'SAL' }],
            }),
          },
          leave: {
            requests: async () => [
              {
                id: 'lv-self',
                employeeId: 'emp-mgr',
                employeeName: 'Manager Self',
                departmentId: 'dept-sales',
                departmentName: 'Sales',
                month: '2026-11',
                startOn: '2026-11-28',
                endOn: '2026-11-28',
                kind: 'annual_leave',
                days: '1',
                status: 'pending_l1',
                reason: null,
                createdAt: '2026-11-26T07:00:00Z',
              },
              {
                id: 'lv-other-dept',
                employeeId: 'emp-3',
                employeeName: 'Other Dept',
                departmentId: 'dept-tech',
                departmentName: 'Tech',
                month: '2026-11',
                startOn: '2026-11-28',
                endOn: '2026-11-28',
                kind: 'annual_leave',
                days: '1',
                status: 'pending_l1',
                reason: null,
                createdAt: '2026-11-26T07:00:00Z',
              },
              {
                id: 'lv-team',
                employeeId: 'emp-2',
                employeeName: 'Team Member',
                departmentId: 'dept-sales',
                departmentName: 'Sales',
                month: '2026-11',
                startOn: '2026-11-28',
                endOn: '2026-11-28',
                kind: 'annual_leave',
                days: '1',
                status: 'pending_l1',
                reason: 'Nghỉ phép',
                createdAt: '2026-11-26T07:00:00Z',
              },
            ],
          },
          salaryAdvance: { list: async () => ({ items: [], l1Queue: [] }) },
          businessTrips: {
            list: async () => ({
              items: [],
              l1Queue: [
                {
                  id: 'trip-1',
                  employeeId: 'emp-2',
                  employeeName: 'Team Member',
                  departmentId: 'dept-sales',
                  departmentName: 'Sales',
                  destination: 'Đà Nẵng',
                  purpose: 'Gặp khách',
                  startOn: '2026-12-01',
                  endOn: '2026-12-02',
                  estimatedAllowance: '1200000',
                  status: 'pending_l1',
                  canApproveL1: true,
                  canApproveFinal: false,
                  createdAt: '2026-11-26T08:00:00Z',
                },
              ],
            }),
          },
        },
      },
    });

    const snap = await loadApprovalsSnapshot({ client, serverUrl: SERVER, orgSlug: 'demo' });
    expect(snap.items.map((i) => i.id)).toEqual(['trip-1', 'lv-team']);
    expect(snap.items.find((i) => i.id === 'trip-1')?.requiresStepUp).toBe(true);
    expect(snap.items.find((i) => i.id === 'lv-team')?.requiresStepUp).toBe(false);
  });

  it('tolerates MODULE_OFF skips and classifies network/auth errors properly', async () => {
    const skipErr = Object.assign(new Error('off'), { code: 'MODULE_OFF', status: 404 });
    const netErr = new TypeError('Network request failed');
    const authErr = Object.assign(new Error('unauth'), { status: 401, code: 'UNAUTHENTICATED' });

    expect(isExpectedSkipError(skipErr)).toBe(true);
    expect(isLikelyNetworkError(netErr)).toBe(true);
    expect(isAuthBlockingError(authErr)).toBe(true);
    expect(readErrorCodeAndStatus(skipErr)).toEqual({ code: 'MODULE_OFF', status: 404, message: 'off' });

    expect(inferCoworkerKeyFromKind('hr.leave')).toBe('finance');
    expect(inferCoworkerKeyFromKind('ads.cap_set')).toBe('marketing');
    expect(todayCoworkerKeyForApp('conversations')).toBe('sales');
    expect(resolveCoworkerName({}, 'gm')).toBe('Vy');
    expect(isEngageProposalKind('crm.quote_send')).toBe(true);
    expect(isAdsProposalKind('ads.cap_set')).toBe(true);
    expect(resolveInboxCoworker(fakeInboxItem({ requestedByMcp: { client: 'Claude', host: 'x' } }), DEFAULT_COWORKERS)?.label).toBe('Claude');

    const offlineClient = makeFakeClient({
      today: { list: async () => { throw netErr; } },
      inbox: { list: async () => { throw netErr; } },
    });
    await expect(loadApprovalsSnapshot({ client: offlineClient, serverUrl: SERVER, orgSlug: 'demo' })).rejects.toThrow('Network request failed');
  });
});

describe('queue filtering and detail action guard state', () => {
  it('filters cross-app items cleanly and formats notice labels', () => {
    const items = [
      { key: 'inbox:1', source: 'inbox' as const, id: '1', subtype: 'finance.purchase' },
      { key: 'hr_leave:2', source: 'hr_leave' as const, id: '2', subtype: 'annual_leave' },
      { key: 'social_post:3', source: 'social_post' as const, id: '3', subtype: 'social.review' },
      { key: 'inbox:4', source: 'inbox' as const, id: '4', subtype: 'ads.cap_set' },
    ].map((x) => ({
      ...x,
      title: x.id,
      subtitle: '',
      counterparty: null,
      amount: null,
      currency: null,
      requiresStepUp: false,
      requiresNetwork: true as const,
      createdAt: null,
      dateLabel: null,
      failedChecks: 0,
      warnChecks: 0,
      unclassifiedLines: 0,
      aiCoworker: null,
      webPath: '/',
      multiDecisionOnly: false,
      multiDecisionReason: null,
      revision: 1,
    }));

    expect(filterGroupForSummary(items[0]!)).toBe('finance');
    expect(filterQueueItems(items, 'all')).toHaveLength(4);
    expect(filterQueueItems(items, 'finance').map((i) => i.id)).toEqual(['1']);
    expect(filterQueueItems(items, 'hr').map((i) => i.id)).toEqual(['2']);
    expect(filterQueueItems(items, 'social').map((i) => i.id)).toEqual(['3']);
    expect(filterQueueItems(items, 'engage').map((i) => i.id)).toEqual(['4']);

    expect(
      formatTodayNoticeTitle({
        key: 'k',
        kind: 'flag',
        app: 'ads',
        id: '1',
        titleKey: 'ads.today.spend_pace',
        titleParams: { name: 'Campaign A' },
        amount: null,
        currency: null,
        count: null,
        dueAt: null,
        severity: 'warn',
        webPath: '/ads',
        aiCoworkerLabel: 'Uy',
      }),
    ).toBe('today spend pace: Campaign A');
  });

  it('enforces four-eyes, failed checks, offline lock, and checklist completeness', () => {
    const detail = {
      ...fakeInboxItem({ failedChecks: 1, signatureStatus: 'unverified' }),
      payload: null,
      reversal: null,
      voucher: null,
      journalVoucher: null,
      engage: null,
      error: null,
      file: null,
      decidedAt: null,
      decisionNote: null,
      result: null,
      canApprove: true,
      approveReason: 'ok',
      coAuthor: false,
      canEdit: true,
      canReject: true,
      canResubmit: false,
      resubmittedAs: null,
      resubmittedFrom: null,
      extraction: null,
      canReextract: false,
      originals: [],
    } as InboxDetail;

    const needsAck = resolveInboxActionGuards(detail, {
      isOffline: false,
      editingAccounts: false,
      acceptFailedChecks: false,
      acceptUnverifiedSig: true,
    });
    expect(needsAck.needsFailedAck).toBe(true);
    expect(needsAck.canApproveNow).toBe(false);

    const ready = resolveInboxActionGuards(detail, {
      isOffline: false,
      editingAccounts: false,
      acceptFailedChecks: true,
      acceptUnverifiedSig: true,
    });
    expect(ready.canApproveNow).toBe(true);

    const offline = resolveInboxActionGuards(detail, {
      isOffline: true,
      editingAccounts: false,
      acceptFailedChecks: true,
      acceptUnverifiedSig: true,
    });
    expect(offline.canApproveNow).toBe(false);
    expect(offline.canRejectNow).toBe(false);

    const fourEyes = resolveInboxActionGuards(
      { ...detail, canApprove: false, approveReason: 'four_eyes' },
      { isOffline: false, editingAccounts: false, acceptFailedChecks: true, acceptUnverifiedSig: true },
    );
    expect(fourEyes.needsFourEyes).toBe(true);
    expect(fourEyes.showWebPrimary).toBe(true);

    const socialPost = {
      id: 'soc-1',
      variants: [
        {
          id: 'v1',
          status: 'pending_review',
          checklist: [{ id: 'chk-1', connectionId: 'c1', position: 0, label: 'Kiểm tra CTA' }],
          review: { required: 1, approvedBy: [], fourEyes: false, client: false, clientVerdict: null },
        },
      ],
    } as unknown as SocialPostDetail;

    expect(
      resolveSocialActionGuards({ multiDecisionOnly: false }, socialPost, {
        isOffline: false,
        tickedChecklistIds: {},
      }).canApproveNow,
    ).toBe(false);

    expect(
      resolveSocialActionGuards({ multiDecisionOnly: false }, socialPost, {
        isOffline: false,
        tickedChecklistIds: { 'chk-1': true },
      }).canApproveNow,
    ).toBe(true);

    expect(
      resolveHrActionGuards({ source: 'hr_leave', subtype: 'annual_leave', leaveStatus: 'pending_final' }, 'member', {
        isOffline: false,
      }).isRoleBlocked,
    ).toBe(true);
  });
});
