// SPDX-License-Identifier: AGPL-3.0-only
// Wave P2-3 Peek Sheet + PhoneActionBar integration coverage across Documents, SignEnvelopes, TodayList, and HR approvals (#4645).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { activeLocale, catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const testState = {
  qc: null as unknown as QueryClient,
  slug: 'acme',
  forcedPeekId: null as string | null,
  forcedTab: null as string | null,
};

function makeOrpcNode(path: string[]): unknown {
  return new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'key') return () => path;
      if (prop === 'queryOptions') {
        return (opts?: { input?: unknown }) => ({
          queryKey: opts?.input === undefined ? path : [...path, opts.input],
          queryFn: () => Promise.reject(new Error(`unseeded:${path.join('.')}`)),
        });
      }
      if (typeof prop === 'string') return makeOrpcNode([...path, prop]);
      return undefined;
    },
  });
}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      [k: string]: unknown;
    }) => {
      let href = to;
      if (params) {
        for (const [k, v] of Object.entries(params)) href = href.replace(`$${k}`, v);
      }
      return createElement('a', { href, ...rest }, children);
    },
    useNavigate: () => vi.fn(),
    useParams: () => ({ slug: testState.slug }),
    useSearch: () => ({}),
    useRouter: () => ({ history: { push: vi.fn() } }),
  };
});

vi.mock('../src/lib/api.ts', () => ({
  client: new Proxy(
    {},
    {
      get() {
        return makeOrpcNode([]);
      },
    },
  ),
  orpc: makeOrpcNode([]),
  queryClient: { invalidateQueries: () => Promise.resolve() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  fetchFile: vi.fn(),
  getCurrentOrg: () => testState.slug,
  isStepUpRequired: () => false,
}));

vi.mock('../src/lib/org-modules.ts', () => ({
  installedModules: () => ['finance', 'hr', 'sign', 'notes'],
  useModulesVersion: () => 1,
}));

vi.mock('../src/components/entity-switcher.tsx', () => ({
  useChosenEntity: () => ({ legalEntityId: 'entity-1', ready: true }),
}));

vi.mock('../src/lib/list-peek-nav.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/list-peek-nav.ts')>();
  return {
    ...actual,
    useListPeekNav: <T,>(opts: { items: readonly T[]; getId: (item: T) => string; enabled?: boolean }) => {
      const ids = opts.items.map(opts.getId);
      const forcedIdx = testState.forcedPeekId ? ids.indexOf(testState.forcedPeekId) : -1;
      if (forcedIdx >= 0 && opts.enabled !== false) {
        const activeItem = opts.items[forcedIdx] ?? null;
        return {
          peekId: 'forced-peek',
          open: activeItem !== null,
          selectedId: testState.forcedPeekId,
          activeItem,
          activeIndex: forcedIdx,
          total: opts.items.length,
          canPrevious: forcedIdx > 0,
          canNext: forcedIdx < opts.items.length - 1,
          openPeek: vi.fn(),
          closePeek: vi.fn(),
          step: vi.fn(),
          onRowClick: vi.fn(),
        };
      }
      return actual.useListPeekNav(opts);
    },
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? h('div', { 'data-slot': 'sheet' }, children) : null,
    SheetContent: ({
      children,
      closeLabel,
      side = 'right',
      ...rest
    }: {
      children?: ReactNode;
      closeLabel: string;
      side?: string;
      [k: string]: unknown;
    }) => h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-side': side, 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('div', { 'data-slot': 'sheet-body', className }, children),
    SheetFooter: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('footer', { 'data-slot': 'sheet-footer', className }, children),
  };
});

const { DocumentsPage } = await import('../src/routes/documents.tsx');
const { SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');
const { TodayList } = await import('../src/components/today-list.tsx');
const { HrOnboardingReviewQueue, HrOvertimeReviewQueue } = await import('../src/components/hr-stage5b-queues.tsx');
const { HrSelfOvertimeCard } = await import('../src/components/hr-onboarding-ot-card.tsx');
const { HrStage6bApprovalQueues, HrPayrollAdjustmentsPanel, HrSelfAdvanceTripCards } = await import('../src/components/hr-stage6b-cards.tsx');
const { LeaveApprovalQueue } = await import('../src/routes/hr-employees.tsx');
const { HrSelfServicePage } = await import('../src/routes/hr-my.tsx');

function renderScreen(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  const prevLocale = activeLocale();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={testState.qc}>
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale) as never}>
          {node}
        </IntlProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale(prevLocale);
  }
}

beforeEach(() => {
  testState.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  testState.slug = 'acme';
  testState.forcedPeekId = null;
  testState.forcedTab = null;
});

afterEach(() => {
  testState.forcedPeekId = null;
  vi.unstubAllGlobals();
});

describe('Wave P2-3 Peek Sheets across Documents, SignEnvelopes, TodayList, and HR queues', () => {
  it('wires DocumentsPage Peek Sheet with file details, provenance, journal/proposal links, and PhoneActionBar', () => {
    const docId = '00000000-0000-4000-8000-000000000101';
    const fileId = '00000000-0000-4000-8000-000000000102';
    const proposalId = '00000000-0000-4000-8000-000000000103';
    const journalEntryId = '00000000-0000-4000-8000-000000000104';

    testState.qc.setQueryData(['documents', 'list', { legalEntityId: 'entity-1' }], [
      {
        id: docId,
        direction: 'purchase',
        partyId: '00000000-0000-4000-8000-000000000109',
        series: '1C26TAA',
        number: '000123',
        partyName: 'Công ty Minh Anh',
        issueDate: '2026-11-20',
        subtotal: '1000000',
        vatAmount: '100000',
        total: '1100000',
        sourceFileId: fileId,
        journalEntryId,
        voided: null,
        replacesDocumentId: null,
        foreign: null,
        corrects: null,
        correctedBy: [],
      },
    ]);
    testState.qc.setQueryData(['files', 'batch', { ids: [fileId] }], [
      {
        id: fileId,
        filename: 'hoa-don-minh-anh.pdf',
        contentType: 'application/pdf',
        createdAt: '2026-11-20T03:00:00.000Z',
        version: 2,
        proposalId,
      },
    ]);
    testState.qc.setQueryData(['inbox', 'get', { id: proposalId }], {
      id: proposalId,
      requestedByAgent: { name: 'Ly' },
      extraction: { version: 2 },
      payload: { lines: [] },
    });
    testState.qc.setQueryData(['journal', 'get', { id: journalEntryId }], {
      id: journalEntryId,
      description: 'Hạch toán hóa đơn đầu vào Minh Anh',
      entryDate: '2026-11-20',
      lines: [
        { lineNo: 1, accountCode: '156', accountName: 'Hàng hóa', debit: '1000000.0000', credit: '0.0000' },
        { lineNo: 2, accountCode: '331', accountName: 'Phải trả người bán', debit: '0.0000', credit: '32832000.0000' },
        { lineNo: 3, accountCode: '133', accountName: 'Thuế GTGT được khấu trừ', debit: '100000.0000', credit: '0.0000' },
        { lineNo: 4, accountCode: '642', accountName: 'Chi phí quản lý', debit: '50000.0000', credit: '0.0000' },
        { lineNo: 5, accountCode: '111', accountName: 'Tiền mặt', debit: '0.0000', credit: '50000.0000' },
      ],
    });
    testState.qc.setQueryData(['documents', 'exports', { documentId: docId }], []);

    const closedHtml = renderScreen(<DocumentsPage />);
    expect(closedHtml).toContain('data-peek-row="00000000-0000-4000-8000-000000000101"');
    expect(closedHtml).toContain('data-testid="document-peek-btn"');
    expect(closedHtml).not.toContain('data-testid="document-peek-sheet"');

    testState.forcedPeekId = docId;
    const mobileOpenHtml = renderScreen(<DocumentsPage />);
    expect(mobileOpenHtml).toContain('data-testid="document-peek-sheet"');
    expect(mobileOpenHtml).toContain('1C26TAA-000123');
    expect(mobileOpenHtml).toContain('hoa-don-minh-anh.pdf');
    expect(mobileOpenHtml).toContain('data-testid="document-peek-provenance"');
    expect(mobileOpenHtml).toContain('Hạch toán hóa đơn đầu vào Minh Anh');
    expect(mobileOpenHtml).toMatch(/32[.,]832[.,]000/);
    expect(mobileOpenHtml).toContain('+1');
    expect(mobileOpenHtml).not.toContain('331</span> Phải trả người bán</span><span class="shrink-0 font-mono text-foreground">0');
    expect(mobileOpenHtml).toContain('data-testid="phone-action-bar"');
    expect(mobileOpenHtml).toContain('data-testid="document-peek-open-file"');
    expect(mobileOpenHtml).toContain('data-testid="document-peek-download-file"');
    expect(mobileOpenHtml).toContain('data-testid="document-peek-proposal-link"');
    expect(mobileOpenHtml).toContain('data-testid="document-peek-journal-link"');
  });

  it('wires SignEnvelopesPage Peek Sheet with signers, obligations, AI-off resilience, and viewer/member role gates', () => {
    const envOwn = '00000000-0000-4000-8000-000000000201';
    const envOther = '00000000-0000-4000-8000-000000000202';
    const envelopeList = [
      {
        id: envOwn,
        title: 'Hợp đồng cung cấp ABC',
        status: 'sent',
        routingMode: 'sequential',
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: 'f-1',
        inspectStatus: 'passed',
        sealStatus: null,
        certificateCode: 'CERT-01',
        pageCount: 3,
        expiresAt: '2026-12-01T00:00:00.000Z',
        sentAt: '2026-11-20T01:00:00.000Z',
        completedAt: null,
        voidedAt: null,
        expiredAt: null,
        createdBy: 'u-creator',
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T01:00:00.000Z',
        signerSummary: { total: 2, signed: 0, waitingForMe: true },
      },
      {
        id: envOther,
        title: 'Hợp đồng thuê mặt bằng',
        status: 'in_progress',
        routingMode: 'parallel',
        sourceKind: 'standalone',
        sourceId: null,
        sourceFileId: 'f-2',
        inspectStatus: 'passed',
        sealStatus: null,
        certificateCode: null,
        pageCount: 2,
        expiresAt: null,
        sentAt: '2026-11-21T01:00:00.000Z',
        completedAt: null,
        voidedAt: null,
        expiredAt: null,
        createdBy: 'u-someone-else',
        createdAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T01:00:00.000Z',
        signerSummary: { total: 1, signed: 0, waitingForMe: false },
      },
    ];

    testState.qc.setQueryData(['sign', 'envelopes', 'acme', 'all'], { items: envelopeList });
    testState.qc.setQueryData(['sign', 'envelope', 'acme', envOwn], {
      envelope: envelopeList[0],
      signers: [
        {
          id: 's-1',
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: 'Bên B',
          name: 'Nguyễn Văn An',
          email: 'an@example.com',
          phone: null,
          deliveryMode: 'link',
          requireEmailOtp: false,
          status: 'pending',
          tokenLastRemindedAt: null,
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      fields: [],
    });
    testState.qc.setQueryData(['sign', 'obligation', 'acme', envOwn], {
      obligation: {
        id: 'ob-1',
        orgId: 'o1',
        envelopeId: envOwn,
        status: 'confirmed',
        counterpartyName: 'Công ty ABC',
        effectiveDate: '2026-11-20',
        expiryDate: '2027-11-20',
        renewalNoticeDays: 30,
        autoRenew: true,
        contractValue: '120000000',
        currency: 'VND',
        obligations: [{ id: 'i1', title: 'Thanh toán đợt 1', dueDate: '2026-12-15', status: 'pending' }],
        proposal: null,
        promptVersion: null,
        confirmedBy: 'u-creator',
        confirmedAt: '2026-11-20T02:00:00.000Z',
        createdBy: 'u-creator',
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T02:00:00.000Z',
      },
      canEdit: true,
    });
    testState.qc.setQueryData(['sign', 'ai', 'acme', envOwn], null);

    // Owner/creator inspecting envOwn sees metadata, signers, obligations, AI-off fallback, and PhoneActionBar actions
    testState.qc.setQueryData(['me', 'get'], {
      userId: 'u-creator',
      orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
    });
    testState.forcedPeekId = envOwn;
    const ownerHtml = renderScreen(<SignEnvelopesPage />);
    expect(ownerHtml).toContain('data-testid="sign-envelope-peek-sheet"');
    expect(ownerHtml).toContain('Nguyễn Văn An');
    expect(ownerHtml).toContain('Công ty ABC');
    expect(ownerHtml).toContain('data-testid="sign-peek-ai"');
    expect(ownerHtml).toContain(viMessages.sign.peek.aiOff);
    expect(ownerHtml).toContain('data-testid="phone-action-bar"');
    expect(ownerHtml).toContain('data-testid="sign-peek-copy-zalo"');
    expect(ownerHtml).toContain('data-testid="sign-peek-remind"');
    expect(ownerHtml).toContain('data-testid="sign-peek-in-person"');
    expect(ownerHtml).toContain('data-testid="sign-peek-open-link"');

    // Non-creator member cannot mint Zalo links on envOther, but can remind and view open link
    testState.qc.setQueryData(['me', 'get'], {
      userId: 'u-member',
      orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'member' }],
    });
    testState.qc.setQueryData(['sign', 'envelope', 'acme', envOther], {
      envelope: envelopeList[1],
      signers: [
        {
          id: 's-2',
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: 'Bên B',
          name: 'Trần Thị Bình',
          email: null,
          phone: null,
          deliveryMode: 'link',
          requireEmailOtp: false,
          status: 'pending',
          tokenLastRemindedAt: null,
          createdAt: '2026-11-21T00:00:00.000Z',
          updatedAt: '2026-11-21T00:00:00.000Z',
        },
      ],
      fields: [],
    });
    testState.forcedPeekId = envOther;
    const memberHtml = renderScreen(<SignEnvelopesPage />);
    expect(memberHtml).not.toContain('data-testid="sign-peek-copy-zalo"');
    expect(memberHtml).toContain('data-testid="sign-peek-remind"');
    expect(memberHtml).toContain('data-testid="sign-peek-in-person"');

    // Non-creator member on a meeting-minutes envelope cannot act on links, remind, or in-person (#4530)
    const envMinutes = '00000000-0000-4000-8000-000000000203';
    const minutesEnvelope = {
      ...envelopeList[1]!,
      id: envMinutes,
      title: 'Biên bản họp HĐTV',
      sourceKind: 'meeting_minutes' as const,
      createdBy: 'u-someone-else',
    };
    testState.qc.setQueryData(['sign', 'envelopes', 'acme', 'all'], { items: [...envelopeList, minutesEnvelope] });
    testState.qc.setQueryData(['sign', 'envelope', 'acme', envMinutes], {
      envelope: minutesEnvelope,
      signers: [
        {
          id: 's-3',
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: 'Thư ký',
          name: 'Lê Minh',
          email: 'minh@example.com',
          phone: null,
          deliveryMode: 'email',
          requireEmailOtp: false,
          status: 'pending',
          tokenLastRemindedAt: null,
          createdAt: '2026-11-21T00:00:00.000Z',
          updatedAt: '2026-11-21T00:00:00.000Z',
        },
      ],
      fields: [],
    });
    testState.forcedPeekId = envMinutes;
    const minutesMemberHtml = renderScreen(<SignEnvelopesPage />);
    expect(minutesMemberHtml).not.toContain('data-testid="sign-peek-copy-zalo"');
    expect(minutesMemberHtml).not.toContain('data-testid="sign-peek-remind"');
    expect(minutesMemberHtml).not.toContain('data-testid="sign-peek-in-person"');
    expect(minutesMemberHtml).toContain('data-testid="sign-peek-open-link"');

    // Viewer cannot see create CTA or any mutating actions inside rows or PeekSheet
    testState.qc.setQueryData(['me', 'get'], {
      userId: 'u-viewer',
      orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'viewer' }],
    });
    testState.forcedPeekId = envOwn;
    const viewerHtml = renderScreen(<SignEnvelopesPage />);
    expect(viewerHtml).not.toContain('data-testid="sign-new-envelope-btn"');
    expect(viewerHtml).not.toContain('data-testid="sign-peek-copy-zalo"');
    expect(viewerHtml).not.toContain('data-testid="sign-peek-remind"');
    expect(viewerHtml).not.toContain('data-testid="sign-peek-in-person"');
    expect(viewerHtml).toContain('data-testid="sign-peek-open-link"');

    // Pending auth (neither me.get nor org.get resolved) must fail closed on write/link/remind/in-person actions
    testState.qc.removeQueries({ queryKey: ['me', 'get'] });
    testState.qc.removeQueries({ queryKey: ['org', 'get'] });
    const pendingAuthHtml = renderScreen(<SignEnvelopesPage />);
    expect(pendingAuthHtml).not.toContain('data-testid="sign-new-envelope-btn"');
    expect(pendingAuthHtml).not.toContain('data-testid="sign-open-drafter-btn"');
    expect(pendingAuthHtml).not.toContain('data-testid="sign-peek-copy-zalo"');
    expect(pendingAuthHtml).not.toContain('data-testid="sign-peek-remind"');
    expect(pendingAuthHtml).not.toContain('data-testid="sign-peek-in-person"');
    expect(pendingAuthHtml).toContain('data-testid="sign-peek-open-link"');
  });

  it('wires TodayList Peek Sheet while preserving Wave P2-2 hero card, bare <li> markup, and row links', () => {
    const todayData = {
      items: [
        {
          id: 'p1',
          app: 'finance',
          kind: 'proposal',
          severity: 'warn',
          title: { key: 'finance.byVendor', params: { vendor: 'Minh Anh' } },
          href: '/inbox/p1',
          amount: '2500000',
          currency: 'VND',
          dueAt: '2026-11-25',
        },
      ],
      coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' },
      dropped: 0,
      truncated: 0,
      failed: 0,
    };
    testState.qc.setQueryData(['today', 'list'], todayData);

    const closedHtml = renderScreen(<TodayList slug="acme" />);
    expect(closedHtml).toContain('data-testid="today-hero-card"');
    expect(closedHtml).toContain('data-testid="today-brief-host"');
    expect(closedHtml.match(/<li>/g)).toHaveLength(1);
    expect(closedHtml).toContain('data-testid="today-peek-btn"');
    expect(closedHtml).not.toMatch(/assistant|trợ lý/i);

    testState.forcedPeekId = 'finance:p1';
    const openHtml = renderScreen(<TodayList slug="acme" />);
    expect(openHtml).toContain('data-testid="today-peek-sheet"');
    expect(openHtml).toContain('data-testid="phone-action-bar"');
    expect(openHtml).toContain('data-testid="today-peek-open-link"');
    expect(openHtml).toContain('/o/acme/inbox/p1');
    expect(openHtml).toContain(viMessages.today.peek.humanHint);
    expect(openHtml).not.toMatch(/assistant|trợ lý/i);
  });

  it('wires HR approval Peek Sheets without breaking existing inline testIds and enforces payroll lock gates', () => {
    const obId = '00000000-0000-4000-8000-000000000301';
    const otId = '00000000-0000-4000-8000-000000000302';
    const teamOtId = '00000000-0000-4000-8000-000000000303';
    const advId = '00000000-0000-4000-8000-000000000304';
    const teamLeaveId = '00000000-0000-4000-8000-000000000305';
    const adjId = '00000000-0000-4000-8000-000000000306';

    testState.qc.setQueryData(['hr', 'onboarding', 'list', { limit: 100 }], [
      {
        id: obId,
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        departmentName: 'Kế toán',
        status: 'pending',
        contactConfirmed: true,
        idConfirmed: true,
        bankConfirmed: false,
        handbookConfirmed: true,
        address: '12 Nguyễn Huệ',
        birthDate: '1996-05-01',
        hasIdentityNumber: true,
        bankCode: 'VCB',
        hasBankAccount: true,
        hasTaxCode: false,
        hasInsuranceNumber: false,
        note: 'Mới nhận việc',
        decisionNote: null,
        createdAt: '2026-11-23T02:00:00.000Z',
      },
    ]);
    testState.qc.setQueryData(['hr', 'overtimeRequests', 'list', { limit: 100 }], [
      {
        id: otId,
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        departmentName: 'Kế toán',
        workDate: '2026-11-22',
        hours: '2.5',
        dayType: 'weekend',
        multiplierPercent: 200,
        status: 'pending_l1',
        reason: 'Khóa sổ tháng',
        decisionNote: null,
      },
    ]);
    testState.qc.setQueryData(['hr', 'self', 'overtime', 'list', { month: '2026-11', limit: 100 }], {
      requests: [],
      teamPending: [
        {
          id: teamOtId,
          employeeId: 'e2',
          employeeName: 'Phạm Gia Huy',
          workDate: '2026-11-21',
          hours: '3',
          dayType: 'weekday',
          status: 'pending_l1',
          reason: 'Kiểm kê kho',
        },
      ],
      monthApprovedHours: '0',
    });

    testState.forcedPeekId = obId;
    const obHtml = renderScreen(<HrOnboardingReviewQueue />);
    expect(obHtml).toContain('data-testid="hr-onboarding-queue-approve"');
    expect(obHtml).toContain('data-testid="hr-onboarding-peek-sheet"');
    expect(obHtml).toContain('data-testid="hr-onboarding-peek-note"');
    expect(obHtml).toContain('data-testid="hr-onboarding-peek-approve"');
    expect(obHtml).toContain('data-testid="hr-onboarding-peek-reject"');
    expect(obHtml).toContain('data-testid="phone-action-bar"');

    testState.forcedPeekId = otId;
    const otHtml = renderScreen(<HrOvertimeReviewQueue />);
    expect(otHtml).toContain('data-testid="hr-overtime-queue-approve-l1"');
    expect(otHtml).toContain('data-testid="hr-overtime-peek-sheet"');
    expect(otHtml).toContain('data-testid="hr-overtime-peek-approve-l1"');
    expect(otHtml).toContain('data-testid="hr-overtime-peek-approve-final"');
    expect(otHtml).toContain('data-testid="hr-overtime-peek-reject"');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
    try {
      testState.qc.setQueryData(['hr', 'self', 'overtime', 'list', { month: '2026-11', limit: 100 }], {
        requests: [],
        teamPending: [
          {
            id: teamOtId,
            employeeId: 'e2',
            employeeName: 'Phạm Gia Huy',
            workDate: '2026-11-21',
            hours: '3',
            dayType: 'weekday',
            status: 'pending_l1',
            reason: 'Kiểm kê kho',
          },
        ],
        monthApprovedHours: '0',
      });
      testState.forcedPeekId = teamOtId;
      const teamOtHtml = renderScreen(<HrSelfOvertimeCard />);
      expect(teamOtHtml).toContain('data-testid="hr-my-ot-approve-l1"');
      expect(teamOtHtml).toContain('data-testid="hr-my-ot-peek-sheet"');
      expect(teamOtHtml).toContain('data-testid="hr-my-ot-peek-approve-l1"');
    } finally {
      vi.useRealTimers();
    }

    // Locked payroll run hides approve-final/approve-l1 inside PeekSheet actions while preserving reject
    testState.qc.setQueryData(['hr', 'salaryAdvances', 'list', { limit: 100 }], [
      {
        id: advId,
        legalEntityId: 'entity-1',
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        departmentName: 'Kế toán',
        month: '2026-10',
        amount: '3000000',
        status: 'pending_final',
        reason: 'Tạm ứng đi công tác',
        canApproveL1: true,
        canApproveFinal: true,
      },
    ]);
    testState.qc.setQueryData(['hr', 'businessTrips', 'list', { limit: 100 }], []);
    testState.qc.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 120 }], [
      { id: 'run-1', legalEntityId: 'entity-1', month: '2026-10', status: 'approved' },
    ]);
    testState.forcedPeekId = advId;
    const advLockedHtml = renderScreen(<HrStage6bApprovalQueues />);
    expect(advLockedHtml).toContain('data-testid="hr-advance-peek-sheet"');
    expect(advLockedHtml).toContain('data-testid="hr-advance-peek-locked"');
    expect(advLockedHtml).toContain('data-testid="hr-advance-peek-reject"');
    expect(advLockedHtml).not.toContain('data-testid="hr-advance-peek-l1"');
    expect(advLockedHtml).not.toContain('data-testid="hr-advance-peek-final"');

    // HrPayrollAdjustmentsPanel PeekSheet respects draft && canApprove
    testState.qc.setQueryData(['hr', 'payroll', 'adjustments', 'list', { legalEntityId: 'entity-1', month: '2026-11', limit: 100 }], [
      {
        id: adjId,
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        kind: 'retro_pay',
        amount: '500000',
        status: 'pending',
        reason: 'Truy lĩnh tháng trước',
        canApprove: true,
        canCancel: false,
      },
    ]);
    testState.forcedPeekId = adjId;
    const adjHtml = renderScreen(
      <HrPayrollAdjustmentsPanel
        legalEntityId="entity-1"
        month="2026-11"
        draft
        employees={[{ id: 'e1', name: 'Lê Minh Tâm' }]}
        onChanged={async () => undefined}
      />,
    );
    expect(adjHtml).toContain('data-testid="hr-adj-approve"');
    expect(adjHtml).toContain('data-testid="hr-adj-peek-sheet"');
    expect(adjHtml).toContain('data-testid="hr-adj-peek-approve"');
    expect(adjHtml).toContain('data-testid="hr-adj-peek-reject"');

    const nonDraftAdjHtml = renderScreen(
      <HrPayrollAdjustmentsPanel
        legalEntityId="entity-1"
        month="2026-11"
        draft={false}
        employees={[{ id: 'e1', name: 'Lê Minh Tâm' }]}
        onChanged={async () => undefined}
      />,
    );
    expect(nonDraftAdjHtml).toContain('data-testid="hr-adj-peek-nondraft"');
    expect(nonDraftAdjHtml).not.toContain('data-testid="hr-adj-peek-approve"');
    expect(nonDraftAdjHtml).toContain('data-testid="hr-adj-peek-reject"');

    // HrSelfServicePage L1 team leave PeekSheet
    testState.qc.setQueryData(['me', 'get'], { userId: 'u-mgr', orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'member' }] });
    testState.qc.setQueryData(['hr', 'self', 'profile', 'get', {}], {
      linked: true,
      employeeId: 'e-mgr',
      displayName: 'Trưởng phòng',
      status: 'active',
      managesDepartmentCount: 1,
      managedDepartments: [{ id: 'd1', name: 'Kinh doanh' }],
      legalEntityName: 'Acme',
      departmentName: 'Kinh doanh',
      managerName: null,
      jobTitleName: 'Lead',
      hireDate: '2024-01-01',
    });
    testState.qc.setQueryData(['hr', 'self', 'leave', 'requests', { scope: 'all' }], [
      {
        id: teamLeaveId,
        employeeId: 'e-sub',
        employeeName: 'Nguyễn Thị Mai',
        departmentId: 'd1',
        departmentName: 'Kinh doanh',
        startOn: '2026-11-26',
        endOn: '2026-11-27',
        days: '2',
        kind: 'annual_leave',
        status: 'pending_l1',
        reason: 'Nghỉ phép gia đình',
      },
    ]);
    testState.forcedPeekId = teamLeaveId;
    const myHtml = renderScreen(<HrSelfServicePage />);
    expect(myHtml).toContain('data-testid="hr-my-team-queue"');
    expect(myHtml).toContain('data-testid="hr-my-l1-approve"');
    expect(myHtml).toContain('data-testid="hr-my-team-peek-sheet"');
    expect(myHtml).toContain('data-testid="hr-my-l1-peek-approve"');
    expect(myHtml).toContain('data-testid="hr-my-l1-peek-reject"');

    // LeaveApprovalQueue (hr-employees.tsx) PeekSheet
    const leaveAdminId = '00000000-0000-4000-8000-000000000307';
    testState.qc.setQueryData(['hr', 'leaveRequests', 'list', { limit: 100 }], [
      {
        id: leaveAdminId,
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        departmentName: 'Kế toán',
        startOn: '2026-11-28',
        endOn: '2026-11-29',
        days: '2',
        kind: 'annual_leave',
        status: 'pending_l1',
        reason: 'Việc riêng',
        l1ApproverName: null,
        finalActedByName: null,
        decisionNote: null,
      },
    ]);
    testState.forcedPeekId = leaveAdminId;
    const leaveHtml = renderScreen(<LeaveApprovalQueue />);
    expect(leaveHtml).toContain('data-testid="hr-leave-queue-approve-final"');
    expect(leaveHtml).toContain('data-testid="hr-leave-peek-sheet"');
    expect(leaveHtml).toContain('data-testid="hr-leave-peek-approve-l1"');
    expect(leaveHtml).toContain('data-testid="hr-leave-peek-approve-final"');
    expect(leaveHtml).toContain('data-testid="hr-leave-peek-reject"');

    // Business trip queue & self L1 queues
    const tripAdminId = '00000000-0000-4000-8000-000000000308';
    const selfAdvId = '00000000-0000-4000-8000-000000000309';
    const selfTripId = '00000000-0000-4000-8000-000000000310';
    testState.qc.setQueryData(['hr', 'businessTrips', 'list', { limit: 100 }], [
      {
        id: tripAdminId,
        employeeId: 'e1',
        employeeName: 'Lê Minh Tâm',
        destination: 'Hà Nội',
        purpose: 'Họp khách hàng',
        startOn: '2026-11-28',
        endOn: '2026-11-30',
        estimatedAllowance: '2500000',
        status: 'pending_l1',
        canApproveL1: true,
        canApproveFinal: true,
      },
    ]);
    testState.forcedPeekId = tripAdminId;
    const tripHtml = renderScreen(<HrStage6bApprovalQueues />);
    expect(tripHtml).toContain('data-testid="hr-trip-peek-sheet"');
    expect(tripHtml).toContain('data-testid="hr-trip-peek-l1"');
    expect(tripHtml).toContain('data-testid="hr-trip-peek-final"');

    testState.qc.setQueryData(['hr', 'self', 'salaryAdvance', 'list', { limit: 100 }], {
      items: [],
      l1Queue: [
        {
          id: selfAdvId,
          employeeId: 'e-sub',
          employeeName: 'Nguyễn Thị Mai',
          departmentName: 'Kinh doanh',
          month: '2026-11',
          amount: '1500000',
          status: 'pending_l1',
          reason: 'Ứng lương',
          canApproveL1: true,
        },
      ],
    });
    testState.qc.setQueryData(['hr', 'self', 'businessTrips', 'list', { limit: 100 }], {
      items: [],
      l1Queue: [
        {
          id: selfTripId,
          employeeId: 'e-sub',
          employeeName: 'Nguyễn Thị Mai',
          destination: 'Đà Nẵng',
          purpose: 'Triển khai',
          startOn: '2026-12-01',
          endOn: '2026-12-03',
          estimatedAllowance: '1800000',
          status: 'pending_l1',
          canApproveL1: true,
        },
      ],
    });
    testState.forcedPeekId = selfAdvId;
    const selfAdvHtml = renderScreen(<HrSelfAdvanceTripCards linked />);
    expect(selfAdvHtml).toContain('data-testid="hr-self-advance-peek-sheet"');
    expect(selfAdvHtml).toContain('data-testid="hr-self-advance-peek-approve-l1"');

    testState.forcedPeekId = selfTripId;
    const selfTripHtml = renderScreen(<HrSelfAdvanceTripCards linked />);
    expect(selfTripHtml).toContain('data-testid="hr-self-trip-peek-sheet"');
    expect(selfTripHtml).toContain('data-testid="hr-self-trip-peek-approve-l1"');
  });
});
