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
  isSupportedMobileInboxKind,
  itemKey,
  loadApprovalsSnapshot,
  readErrorCodeAndStatus,
  resolveCoworkerName,
  resolveInboxCoworker,
  todayCoworkerKeyForApp,
  type ChartAccount,
  type InboxDetail,
  type InboxListItem,
  type SocialPostDetail,
} from '../src/screens/approvals/model.ts';
import {
  filterGroupForSummary,
  filterQueueItems,
  formatTodayNoticeTitle,
  isRevenueAccountCode,
  pickableAccountsForMobile,
  resolveHrActionGuards,
  resolveInboxActionGuards,
  resolveSocialActionGuards,
  shouldShowEngageHiddenBanner,
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
    anomalyChecks: 0,
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
    me: {
      get: async () => ({
        userId: 'u-owner',
        email: 'owner@example.com',
        displayName: 'Owner',
        orgs: [],
      }),
    },
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
  it('merges Inbox, Social and HR items cleanly with web routes and non-duplicated checks', async () => {
    const client = makeFakeClient({
      today: {
        list: async () => ({
          items: [
            // Excluded because pending Finance/Social/HR queue items live directly in `items`.
            { kind: 'proposal', app: 'finance', id: 'fin-q', title: { key: 'financeProposalsOther', params: { count: 1 } }, href: '/inbox' },
            { kind: 'proposal', app: 'social', id: 'review', title: { key: 'social.review', params: { count: 1 } }, href: '/social' },
            { kind: 'proposal', app: 'hr', id: 'leave-approvals', title: { key: 'hr.leaveApprovalsPending', params: { count: 1 } }, href: '/hr/employees' },
            // Included: payroll adjustment proposal, ads flag, finance deadline.
            { kind: 'proposal', app: 'hr', id: 'payroll-adjustments-pending', title: { key: 'hr.payrollAdjustmentsPending', params: { count: 2 } }, count: 2, href: '/hr/payroll' },
            {
              kind: 'flag',
              app: 'ads',
              id: 'ads-pace',
              title: { key: 'ads.cpr', params: { campaign: 'Tết 2027', account: 'FB', ratio: '2.4' } },
              amount: '2000000',
              currency: 'VND',
              severity: 'warn',
              href: '/ads',
            },
            {
              kind: 'deadline',
              app: 'finance',
              id: 'vat-due',
              title: { key: 'financeVatDue', params: { period: '11/2026', date: '20/12/2026' } },
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
            warnChecks: 1,
            anomalyChecks: 1,
            requestedByAgent: null,
          }),
          fakeInboxItem({
            id: 'p-3',
            kind: 'finance.purchase',
            title: 'Hóa đơn USD',
            total: '1000',
            requestedByAgent: null,
            requestedByMcp: null,
          }),
          fakeInboxItem({
            id: 'p-4',
            kind: 'finance.cash_voucher',
            title: 'Phiếu chi văn phòng phẩm',
            total: '450000',
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
          list: async ({ status }: { status?: string }) =>
            status === 'pending_final'
              ? [
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
                ]
              : [],
        },
        salaryAdvances: {
          list: async ({ status }: { status?: string }) =>
            status === 'pending_final'
              ? [
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
                ]
              : [],
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
    expect(snap.items).toHaveLength(7);

    // Supplier payment must open web instead of blind mobile approval (missing vendor/bank details).
    const payment = snap.items.find((i) => i.key === itemKey('inbox', 'p-1'));
    expect(payment?.amount).toBe('3200000');
    expect(payment?.currency).toBe('VND');
    expect(payment?.multiDecisionOnly).toBe(true);
    expect(payment?.multiDecisionReason).toBe('unsupported_on_mobile');
    expect(payment?.aiCoworker).toEqual({ id: 'finance', label: 'Ly' });

    // `warnChecks` stays separate from `anomalyChecks` (no double counting).
    const quote = snap.items.find((i) => i.key === itemKey('inbox', 'p-2'));
    expect(quote?.warnChecks).toBe(1);
    expect(quote?.anomalyChecks).toBe(1);
    expect(quote?.aiCoworker).toEqual({ id: 'sales', label: 'Dy' });
    expect(snap.items[0]?.id).toBe('p-2');

    // Foreign invoice list entry leaves currency null until detail load (never forces VND).
    const invoice = snap.items.find((i) => i.key === itemKey('inbox', 'p-3'));
    expect(invoice?.currency).toBeNull();
    expect(invoice?.aiCoworker).toBeNull();

    // Cash voucher IS always VND.
    const voucher = snap.items.find((i) => i.key === itemKey('inbox', 'p-4'));
    expect(voucher?.currency).toBe('VND');

    // Social route uses `/social/<id>`, NOT `/social/posts/<id>`.
    const social = snap.items.find((i) => i.key === itemKey('social_post', 'soc-1'));
    expect(social?.webPath).toBe('/social/soc-1');
    expect(social?.multiDecisionOnly).toBe(true);
    expect(social?.multiDecisionReason).toBe('multiple_channels');

    const adv = snap.items.find((i) => i.key === itemKey('hr_salary_advance', 'adv-1'));
    expect(adv?.webPath).toBe('/hr/employees');
    expect(adv?.requiresStepUp).toBe(true);

    // `todayNotices` preserves `payroll-adjustments-pending` while omitting replaced queue items.
    expect(snap.todayNotices.map((n) => n.id)).toEqual(['payroll-adjustments-pending', 'ads-pace', 'vat-due']);
  });

  it('scopes member HR queue to managed departments L1 with /hr/my path and reports HR failures', async () => {
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
          salaryAdvance: { list: async () => { throw new TypeError('hr sub-call failed'); } },
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
    expect(snap.userId).toBe('u-owner');
    expect(snap.items.map((i) => i.id)).toEqual(['trip-1', 'lv-team']);
    expect(snap.items.every((i) => i.webPath === '/hr/my')).toBe(true);
    expect(snap.partialFailureCount).toBe(1);
  });

  it('retains aggregated Today notices when social list is truncated or HR detail query fails', async () => {
    const client = makeFakeClient({
      today: {
        list: async () => ({
          items: [
            { kind: 'proposal', app: 'social', id: 'review', count: 60, title: { key: 'social.review', params: { count: 60 } }, href: '/social' },
            { kind: 'proposal', app: 'hr', id: 'leave-approvals', count: 3, title: { key: 'hr.leaveApprovalsPending', params: { count: 3 } }, href: '/hr/employees' },
          ],
          coworkers: { ...DEFAULT_COWORKERS },
          dropped: 0,
          truncated: 0,
          failed: 0,
        }),
      },
      social: {
        reviewInbox: async () => ({
          items: [
            {
              postId: 'soc-partial',
              title: 'Bài 1',
              excerpt: 'Excerpt',
              channels: [{ variantId: 'v1', provider: 'facebook_page', displayName: 'Page' }],
              at: null,
              submittedAt: '2026-11-26T09:00:00Z',
            },
          ],
          total: 60,
        }),
      },
      hr: {
        leaveRequests: {
          list: async () => {
            throw Object.assign(new Error('503'), { status: 503 });
          },
        },
        salaryAdvances: { list: async () => [] },
        businessTrips: { list: async () => [] },
      },
    });

    const snap = await loadApprovalsSnapshot({ client, serverUrl: SERVER, orgSlug: 'demo' });
    expect(snap.todayNotices.map((n) => n.id)).toEqual(['review', 'leave-approvals']);
    expect(snap.partialFailureCount).toBeGreaterThanOrEqual(2);
  });

  it('distinguishes Engage Ads proposals from Ads spend proposals and classifies errors cleanly', async () => {
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
    expect(isEngageProposalKind('ads.pause_all')).toBe(true);
    expect(isAdsProposalKind('ads.pause_all')).toBe(false);
    expect(isAdsProposalKind('ads.cap_set')).toBe(true);
    expect(isSupportedMobileInboxKind('finance.supplier_payment')).toBe(false);
    expect(resolveInboxCoworker(fakeInboxItem({ requestedByMcp: { client: 'Claude', host: 'x' } }), DEFAULT_COWORKERS)?.label).toBe('Claude');

    const offlineClient = makeFakeClient({
      today: { list: async () => { throw netErr; } },
      inbox: { list: async () => { throw netErr; } },
    });
    await expect(loadApprovalsSnapshot({ client: offlineClient, serverUrl: SERVER, orgSlug: 'demo' })).rejects.toThrow('Network request failed');
  });
});

describe('queue filtering, localized Today notices, directional accounts and detail guards', () => {
  it('filters cross-app items, translates Today titles, and filters accounts by invoice direction', () => {
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
      anomalyChecks: 0,
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
      formatTodayNoticeTitle(
        {
          key: 'k',
          kind: 'flag',
          app: 'ads',
          id: '1',
          titleKey: 'ads.cpr',
          titleParams: { campaign: 'Tết', account: 'Meta', ratio: '2.2' },
          amount: null,
          currency: null,
          count: null,
          dueAt: null,
          severity: 'warn',
          webPath: '/ads',
          aiCoworkerLabel: 'Uy',
        },
        'vi',
      ),
    ).toBe('Tết (Meta): chi phí mỗi kết quả gấp 2.2 lần mức thường thấy');

    expect(
      formatTodayNoticeTitle(
        {
          key: 'k2',
          kind: 'message',
          app: 'finance',
          id: 's',
          titleKey: 'financeStatementsStaged',
          titleParams: { count: 3 },
          amount: null,
          currency: null,
          count: 3,
          dueAt: null,
          severity: null,
          webPath: '/inbox',
          aiCoworkerLabel: 'Ly',
        },
        'en',
      ),
    ).toBe('3 bank statement(s) waiting for confirmation');

    const chart: ChartAccount[] = [
      { code: '6422', name: 'Chi phí QLDN', parentCode: '642', rootCode: '6', active: true, custom: false },
      { code: '5111', name: 'Doanh thu bán hàng', parentCode: '511', rootCode: '5', active: true, custom: false },
      { code: '711', name: 'Thu nhập khác', parentCode: null, rootCode: '7', active: true, custom: false },
      { code: '152', name: 'Nguyên vật liệu', parentCode: null, rootCode: '1', active: false, custom: false },
    ];
    expect(isRevenueAccountCode('5111')).toBe(true);
    expect(isRevenueAccountCode('6422')).toBe(false);
    expect(pickableAccountsForMobile(chart, 'purchase').map((a) => a.code)).toEqual(['6422']);
    expect(pickableAccountsForMobile(chart, 'sale').map((a) => a.code)).toEqual(['5111', '711']);
    expect(pickableAccountsForMobile(chart, 'purchase', '152').map((a) => a.code)).toEqual(['6422', '152']);
  });

  it('enforces blocking checks, unclassified lines, Social in_review four-eyes, and live HR sync', () => {
    const basePurchasePayload = {
      seller: { name: 'NCC', taxCode: null, address: null, email: null, phone: null },
      buyer: { name: 'Buyer', taxCode: null, address: null, email: null, phone: null },
      invoice: {
        template: null,
        series: '1C26',
        number: '001',
        issueDate: '2026-11-26',
        currency: 'VND',
        paymentMethod: null,
        taxAuthorityCode: null,
        subtotal: '100000',
        vatTotal: '10000',
        total: '110000',
      },
      lines: [
        { lineNo: 1, description: 'Bút bi', unit: null, quantity: '1', unitPrice: '100000', amount: '100000', vatRate: '10', debitAccount: '6422', reason: 'rule' },
      ],
      journal: [],
      checks: [{ id: 'date_gap', status: 'fail' as const, message: 'Ngày hóa đơn cũ' }],
      sourceFileId: 'f1',
      extractionMethod: 'pdf_text_ai' as const,
    };

    const detail = {
      ...fakeInboxItem({ failedChecks: 1, signatureStatus: 'unverified' }),
      payload: basePurchasePayload,
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

    // Non-blocking failed check can be acknowledged.
    expect(
      resolveInboxActionGuards(detail, {
        isOffline: false,
        editingAccounts: false,
        acceptFailedChecks: false,
        acceptUnverifiedSig: true,
      }).canApproveNow,
    ).toBe(false);

    expect(
      resolveInboxActionGuards(detail, {
        isOffline: false,
        editingAccounts: false,
        acceptFailedChecks: true,
        acceptUnverifiedSig: true,
      }).canApproveNow,
    ).toBe(true);

    // Blocking check (`lines_sum`) cannot be overridden even with checkboxes ticked!
    const blockingDetail: InboxDetail = {
      ...detail,
      payload: {
        ...basePurchasePayload,
        checks: [{ id: 'lines_sum', status: 'fail', message: 'Tổng dòng không khớp' }],
      },
    };
    const blockingGuards = resolveInboxActionGuards(blockingDetail, {
      isOffline: false,
      editingAccounts: false,
      acceptFailedChecks: true,
      acceptUnverifiedSig: true,
    });
    expect(blockingGuards.hasBlockingChecks).toBe(true);
    expect(blockingGuards.canApproveNow).toBe(false);
    expect(blockingGuards.canRejectNow).toBe(true);

    // Unclassified lines force edit before approve.
    const unclassifiedGuards = resolveInboxActionGuards(
      { ...detail, unclassifiedLines: 1 },
      { isOffline: false, editingAccounts: false, acceptFailedChecks: true, acceptUnverifiedSig: true },
    );
    expect(unclassifiedGuards.hasUnclassifiedLines).toBe(true);
    expect(unclassifiedGuards.canApproveNow).toBe(false);

    // Supplier payment requires web view rather than blind mobile action.
    const supplierGuards = resolveInboxActionGuards(
      { ...detail, kind: 'finance.supplier_payment', payload: null, failedChecks: 0, signatureStatus: null },
      { isOffline: false, editingAccounts: false, acceptFailedChecks: true, acceptUnverifiedSig: true },
    );
    expect(supplierGuards.unsupportedOnMobile).toBe(true);
    expect(supplierGuards.canApproveNow).toBe(false);
    expect(supplierGuards.showWebPrimary).toBe(true);

    // Journal reversal must wait for original journal entry lines before allowing approve.
    const reversalDetail: InboxDetail = {
      ...detail,
      kind: 'finance.journal_reversal',
      payload: null,
      failedChecks: 0,
      signatureStatus: null,
      reversal: { entryId: '00000000-0000-4000-8000-000000000020', entryDate: '2026-11-26', reason: 'Sai kỳ' },
    };
    const reversalWaitingGuards = resolveInboxActionGuards(reversalDetail, {
      isOffline: false,
      editingAccounts: false,
      acceptFailedChecks: true,
      acceptUnverifiedSig: true,
      journalLoaded: false,
    });
    expect(reversalWaitingGuards.payloadReady).toBe(false);
    expect(reversalWaitingGuards.canApproveNow).toBe(false);
    expect(reversalWaitingGuards.showWebPrimary).toBe(true);

    const reversalReadyGuards = resolveInboxActionGuards(reversalDetail, {
      isOffline: false,
      editingAccounts: false,
      acceptFailedChecks: true,
      acceptUnverifiedSig: true,
      journalLoaded: true,
    });
    expect(reversalReadyGuards.payloadReady).toBe(true);
    expect(reversalReadyGuards.canApproveNow).toBe(true);

    // AI-proposed finance items with `engage: null` must NOT trigger the hidden-Engage banner.
    expect(
      shouldShowEngageHiddenBanner({
        ...detail,
        kind: 'finance.cash_voucher',
        requestedByAgent: { id: 'agent-ly', name: 'Ly' },
        payload: null,
        engage: null,
      }),
    ).toBe(false);
    expect(
      shouldShowEngageHiddenBanner({
        ...detail,
        kind: 'finance.einvoice_issue',
        requestedByAgent: { id: 'agent-ly', name: 'Ly' },
        payload: null,
        engage: null,
      }),
    ).toBe(false);
    expect(
      shouldShowEngageHiddenBanner({
        ...detail,
        kind: 'crm.quote_send',
        payload: null,
        engage: null,
      }),
    ).toBe(true);
    expect(
      shouldShowEngageHiddenBanner({
        ...detail,
        kind: 'crm.quote_send',
        payload: null,
        engage: { kind: 'crm.quote_send' } as unknown as InboxDetail['engage'],
      }),
    ).toBe(false);

    // Social `in_review`: another reviewer CAN approve even when fourEyes policy is enabled; author CANNOT.
    const socialPost = {
      id: 'soc-1',
      authorUserId: 'author-u',
      variants: [
        {
          id: 'v1',
          status: 'in_review',
          checklist: [{ id: 'chk-1', connectionId: 'c1', position: 0, label: 'Kiểm tra CTA' }],
          review: { required: 1, approvedBy: [], fourEyes: true, client: false, clientVerdict: null },
          bannedWords: [],
          bannedWordsStatus: 'checked',
          media: [],
        },
      ],
    } as unknown as SocialPostDetail;

    expect(
      resolveSocialActionGuards({ multiDecisionOnly: false }, socialPost, {
        isOffline: false,
        currentUserId: 'author-u',
        tickedChecklistIds: { 'chk-1': true },
      }).isFourEyesBlocked,
    ).toBe(true);

    expect(
      resolveSocialActionGuards({ multiDecisionOnly: false }, socialPost, {
        isOffline: false,
        currentUserId: 'reviewer-u',
        tickedChecklistIds: { 'chk-1': true },
      }).canApproveNow,
    ).toBe(true);

    expect(
      resolveSocialActionGuards({ multiDecisionOnly: false }, socialPost, {
        isOffline: false,
        currentUserId: 'reviewer-u',
        tickedChecklistIds: {},
      }).canApproveNow,
    ).toBe(false);

    // Social blocking banned word (`level: 'block'` or `bannedWordsStatus: 'too_complex'`) blocks approve
    // while keeping request-changes and reject available.
    const blockedWordPost = {
      ...socialPost,
      variants: [
        {
          ...socialPost.variants[0],
          bannedWords: [{ phrase: 'cam kết 100%', level: 'block' }],
          bannedWordsStatus: 'checked',
        },
      ],
    } as unknown as SocialPostDetail;
    const blockedWordGuards = resolveSocialActionGuards({ multiDecisionOnly: false }, blockedWordPost, {
      isOffline: false,
      currentUserId: 'reviewer-u',
      tickedChecklistIds: { 'chk-1': true },
    });
    expect(blockedWordGuards.hasBlockingBannedWord).toBe(true);
    expect(blockedWordGuards.canApproveNow).toBe(false);
    expect(blockedWordGuards.showWebPrimary).toBe(true);
    expect(blockedWordGuards.canRequestChangesNow).toBe(true);
    expect(blockedWordGuards.canRejectNow).toBe(true);

    const warnWordPost = {
      ...socialPost,
      variants: [
        {
          ...socialPost.variants[0],
          bannedWords: [{ phrase: 'siêu rẻ', level: 'warn' }],
          bannedWordsStatus: 'checked',
        },
      ],
    } as unknown as SocialPostDetail;
    const warnWordGuards = resolveSocialActionGuards({ multiDecisionOnly: false }, warnWordPost, {
      isOffline: false,
      currentUserId: 'reviewer-u',
      tickedChecklistIds: { 'chk-1': true },
    });
    expect(warnWordGuards.hasBlockingBannedWord).toBe(false);
    expect(warnWordGuards.canApproveNow).toBe(true);

    const tooComplexPost = {
      ...socialPost,
      variants: [
        {
          ...socialPost.variants[0],
          bannedWords: [],
          bannedWordsStatus: 'too_complex',
        },
      ],
    } as unknown as SocialPostDetail;
    const tooComplexGuards = resolveSocialActionGuards({ multiDecisionOnly: false }, tooComplexPost, {
      isOffline: false,
      currentUserId: 'reviewer-u',
      tickedChecklistIds: { 'chk-1': true },
    });
    expect(tooComplexGuards.hasBlockingBannedWord).toBe(true);
    expect(tooComplexGuards.canApproveNow).toBe(false);
    expect(tooComplexGuards.showWebPrimary).toBe(true);
    expect(tooComplexGuards.canRequestChangesNow).toBe(true);
    expect(tooComplexGuards.canRejectNow).toBe(true);

    // Media attachments cannot be visually previewed in full on mobile, so Approve requires web
    // while request-changes and reject remain usable.
    const mediaPost = {
      ...socialPost,
      variants: [
        {
          ...socialPost.variants[0],
          media: [
            {
              fileId: '00000000-0000-4000-8000-000000000099',
              altText: 'Product photo',
              mime: 'image/jpeg',
              sizeBytes: 2048,
              durationMs: null,
              width: 800,
              height: 600,
              filename: 'photo.jpg',
            },
          ],
        },
      ],
    } as unknown as SocialPostDetail;
    const mediaGuards = resolveSocialActionGuards({ multiDecisionOnly: false }, mediaPost, {
      isOffline: false,
      currentUserId: 'reviewer-u',
      tickedChecklistIds: { 'chk-1': true },
    });
    expect(mediaGuards.hasUnpreviewableMedia).toBe(true);
    expect(mediaGuards.canApproveNow).toBe(false);
    expect(mediaGuards.showWebPrimary).toBe(true);
    expect(mediaGuards.canRequestChangesNow).toBe(true);
    expect(mediaGuards.canRejectNow).toBe(true);

    // HR cached preview without live data must stay non-actionable.
    expect(
      resolveHrActionGuards(
        { source: 'hr_salary_advance', subtype: 'pending_l1', leaveStatus: 'pending_l1' },
        'owner',
        { isOffline: false, hasLiveItem: false, canApproveL1: undefined },
      ).canApproveNow,
    ).toBe(false);

    expect(
      resolveHrActionGuards(
        { source: 'hr_salary_advance', subtype: 'pending_l1', leaveStatus: 'pending_l1' },
        'owner',
        { isOffline: false, hasLiveItem: true, canApproveL1: true },
      ).approveStage,
    ).toBe('approve_l1');
  });
});
