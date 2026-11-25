// SPDX-License-Identifier: AGPL-3.0-only
// UI SSR, accessibility, mobile >=44px target, and i18n checks for Stage 6C (#4528):
// contract addendums + Ly check + eSign handoff, career timeline, and asset handover checklist.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HrAddendumCheckResult,
  HrAddendumView,
  HrAssetView,
  HrEmployee,
  HrSelfAssetView,
  HrTimelineResult,
  SignEnvelopeBySourceItem,
} from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr', 'projects', 'sign'] }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
  }) => {
    const href = (to ?? '#').replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  useNavigate: () => vi.fn(),
  useParams: () => ({ slug: 'acme' }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: [...path, opts?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        addendum: {
          create: vi.fn(),
          issue: vi.fn(),
          void: vi.fn(),
          pdf: vi.fn(),
          check: vi.fn(),
        },
        assets: {
          assign: vi.fn(),
          updateStatus: vi.fn(),
        },
        payroll: {
          employees: { add: vi.fn(), edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
          employments: { add: vi.fn() },
          dependents: { add: vi.fn(), end: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    resetStepUp: vi.fn(),
    STEP_UP_REQUIRED_EVENT: 'ludy:stepup',
  };
});

const {
  HrAddendumPanel,
  HrAssetsPanel,
  HrCareerTimelinePanel,
  HrSelfAssetsCard,
  countUnreturnedAssets,
} = await import('../src/components/hr-stage6c-panels.tsx');
const { Detail } = await import('../src/routes/hr-employees.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000901';
const TERM_ID = '00000000-0000-7000-8000-000000000902';
const LE_ID = '00000000-0000-7000-8000-000000000903';
const ADDENDUM_ISSUED_ID = '00000000-0000-7000-8000-000000000904';
const ADDENDUM_DRAFT_ID = '00000000-0000-7000-8000-000000000905';
const ADDENDUM_VOIDED_WITH_ENV_ID = '00000000-0000-7000-8000-000000000906';
const ADDENDUM_VOIDED_NO_ENV_ID = '00000000-0000-7000-8000-000000000907';
const ENV_VOIDED_ADDENDUM_ID = '00000000-0000-7000-8000-000000000908';
const SEALED_FILE_ID = '00000000-0000-7000-8000-000000000909';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

const SAMPLE_EMPLOYEE: HrEmployee = {
  id: EMP_ID,
  legalEntityId: LE_ID,
  departmentId: null,
  departmentName: 'Kỹ thuật',
  displayName: 'Nguyễn Thị Minh Ánh',
  jobTitle: 'Kỹ sư phần mềm',
  status: 'active',
  endedOn: null,
  isForeign: false,
  workPermitExempt: false,
  workPermitNumber: null,
  workPermitExpiresOn: null,
  linkedUserId: '00000000-0000-7000-8000-000000000910',
  linkedMemberName: null,
  erased: false,
  contractAlerts: [],
  hasIdentityNumber: true,
  hasAccountNumber: true,
  hasWorkPermitNumber: false,
  current: null,
  address: '12 Nguyễn Huệ, Quận 1',
  identityNumber: '079096001234',
  accountNumber: '001122334455',
  bankCode: 'VCB',
  birthDate: '1996-08-20',
  taxCode: '8001122334',
  insuranceNumber: '7900112233',
  finalizationAuthorizedYears: [],
  employments: [
    {
      id: TERM_ID,
      effectiveFrom: '2026-01-15',
      contractType: 'indefinite',
      contractForm: 'electronic',
      termMonths: null,
      contractEndOn: null,
      fixedTermSequence: null,
      taxResident: true,
      region: 'I',
      payFunction: 'production',
      payBasis: 'monthly',
      baseWage: '18000000',
      hourlyRate: null,
      pieceRate: null,
      probationRoleTier: null,
      probationEndOn: null,
      probationWage: null,
    },
  ],
  dependents: [],
};

describe('HR Stage 6C UI components (#4528)', () => {
  beforeEach(() => {
    cache.current.clear();
  });

  it('renders contract addendum panel with PDF, eSign handoff for issued row, and >=44px phone targets', () => {
    const addendums: HrAddendumView[] = [
      {
        id: ADDENDUM_ISSUED_ID,
        employeeId: EMP_ID,
        employmentId: TERM_ID,
        legalEntityId: LE_ID,
        addendumNumber: 'PL-2026-01',
        effectiveOn: '2026-12-01',
        changeSummary: 'Điều chỉnh lương cơ bản lên 22.000.000 đ/tháng.',
        previousPayRate: '18000000',
        newPayRate: '22000000',
        previousTitle: 'Kỹ sư phần mềm',
        newTitle: 'Kỹ sư chính',
        status: 'issued',
        issuedAt: '2026-11-20T09:00:00.000Z',
        voidedAt: null,
        voidReason: null,
        createdBy: EMP_ID,
        createdAt: '2026-11-20T09:00:00.000Z',
        updatedAt: '2026-11-20T09:00:00.000Z',
      },
      {
        id: ADDENDUM_DRAFT_ID,
        employeeId: EMP_ID,
        employmentId: TERM_ID,
        legalEntityId: LE_ID,
        addendumNumber: 'PL-2026-02',
        effectiveOn: '2027-01-01',
        changeSummary: 'Phụ lục bổ sung phụ cấp ăn trưa.',
        previousPayRate: null,
        newPayRate: null,
        previousTitle: null,
        newTitle: null,
        status: 'draft',
        issuedAt: null,
        voidedAt: null,
        voidReason: null,
        createdBy: EMP_ID,
        createdAt: '2026-11-22T09:00:00.000Z',
        updatedAt: '2026-11-22T09:00:00.000Z',
      },
    ];
    cache.current.setQueryData(['hr', 'addendum', 'list', { employeeId: EMP_ID }], addendums);
    cache.current.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_ISSUED_ID] }],
      { items: [] },
    );

    const htmlVi = wrap(
      <HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />,
      'vi',
    );
    expect(htmlVi).toContain('data-testid="hr-addendum-panel"');
    expect(htmlVi).toContain('PL-2026-01');
    expect(htmlVi).toContain('PL-2026-02');
    expect(htmlVi).toContain('data-testid="hr-addendum-ly-check"');
    expect(htmlVi).toContain('Kiểm tra với Ly (AI)');
    expect(htmlVi).toContain('data-testid="hr-addendum-pdf-btn"');
    expect(htmlVi).toContain('data-testid="hr-addendum-issue-btn"');
    expect(htmlVi).toContain('data-testid="hr-contract-send-esign"');
    expect(htmlVi).toContain('max-md:min-h-11');
    expect(htmlVi).not.toContain('\u2014');

    const htmlEn = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={false} />, 'en');
    expect(htmlEn).toContain(en.hrEmployees.addendum.title);
    expect(htmlEn).not.toContain('data-testid="hr-contract-send-esign"');
  });

  it('shows a read-only eSign status badge link on voided addendum rows only when an envelope exists (#4654)', () => {
    const voidedWithEnv: HrAddendumView = {
      id: ADDENDUM_VOIDED_WITH_ENV_ID,
      employeeId: EMP_ID,
      employmentId: TERM_ID,
      legalEntityId: LE_ID,
      addendumNumber: 'PL-2026-V1',
      effectiveOn: '2026-12-01',
      changeSummary: 'Phụ lục đã phát hành có hồ sơ ký trước khi hủy.',
      previousPayRate: '18000000',
      newPayRate: '21000000',
      previousTitle: null,
      newTitle: null,
      status: 'voided',
      issuedAt: '2026-11-20T09:00:00.000Z',
      voidedAt: '2026-11-21T09:00:00.000Z',
      voidReason: 'Điều chỉnh lại ngày hiệu lực',
      createdBy: EMP_ID,
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    };
    const voidedNoEnv: HrAddendumView = {
      ...voidedWithEnv,
      id: ADDENDUM_VOIDED_NO_ENV_ID,
      addendumNumber: 'PL-2026-V2',
      changeSummary: 'Phụ lục hủy từ nháp chưa từng gửi eSign.',
      issuedAt: null,
    };
    const makeEnv = (
      status: SignEnvelopeBySourceItem['status'],
      overrides: Partial<SignEnvelopeBySourceItem> = {},
    ): SignEnvelopeBySourceItem => ({
      sourceId: ADDENDUM_VOIDED_WITH_ENV_ID,
      envelopeId: ENV_VOIDED_ADDENDUM_ID,
      title: 'Phụ lục HĐLĐ PL-2026-V1 - Nguyễn Thị Minh Ánh',
      status,
      sealStatus: status === 'completed' ? 'sealed' : null,
      sealedFileId: status === 'completed' ? SEALED_FILE_ID : null,
      certificateCode: status === 'completed' ? 'CS-PL01-ABCD' : null,
      completedAt: status === 'completed' ? '2026-11-20T10:00:00.000Z' : null,
      signerCount: 1,
      signedCount: status === 'completed' ? 1 : 0,
      createdAt: '2026-11-20T09:05:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
      ...overrides,
    });

    // 1. Voided addendum with an active 'sent' envelope -> shows read-only link + badge, >=44px target, no send button.
    cache.current.setQueryData(['hr', 'addendum', 'list', { employeeId: EMP_ID }], [voidedWithEnv, voidedNoEnv]);
    cache.current.setQueryData(
      [
        'sign',
        'envelope',
        'by_source',
        { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_VOIDED_WITH_ENV_ID, ADDENDUM_VOIDED_NO_ENV_ID] },
      ],
      { items: [makeEnv('sent')] },
    );
    const htmlSentVi = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />, 'vi');
    expect(htmlSentVi).toContain(`href="/o/acme/sign/envelopes/${ENV_VOIDED_ADDENDUM_ID}"`);
    expect(htmlSentVi).toContain('data-testid="hr-contract-sign-status"');
    expect(htmlSentVi).toContain('data-status="sent"');
    expect(htmlSentVi).toContain('max-md:min-h-11');
    expect(htmlSentVi).toContain('>Đang chờ ký<');
    expect(htmlSentVi).not.toContain('data-testid="hr-contract-send-esign"');
    expect(htmlSentVi).not.toContain('\u2014');
    // Only the voided row that has an envelope renders a sign status link (not the voided row without one).
    expect(htmlSentVi.match(/data-testid="hr-contract-sign-status"/g)).toHaveLength(1);

    const htmlSentEn = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />, 'en');
    expect(htmlSentEn).toContain('>Awaiting signature<');
    expect(htmlSentEn).toContain('Open signing envelope:');
    expect(htmlSentEn).not.toContain('data-testid="hr-contract-send-esign"');

    // 2. Voided addendum with a retryable envelope ('declined' / 'voided') STILL must NOT offer a new eSign handoff.
    for (const terminalStatus of ['declined', 'voided', 'expired'] as const) {
      cache.current.setQueryData(
        [
          'sign',
          'envelope',
          'by_source',
          { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_VOIDED_WITH_ENV_ID, ADDENDUM_VOIDED_NO_ENV_ID] },
        ],
        { items: [makeEnv(terminalStatus)] },
      );
      const htmlTerminal = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />, 'vi');
      expect(htmlTerminal).toContain(`data-status="${terminalStatus}"`);
      expect(htmlTerminal).toContain(`href="/o/acme/sign/envelopes/${ENV_VOIDED_ADDENDUM_ID}"`);
      expect(htmlTerminal).not.toContain('data-testid="hr-contract-send-esign"');
    }

    // 3. Voided addendum with a completed + sealed envelope -> read-only link + sealed download, no send button.
    cache.current.setQueryData(
      [
        'sign',
        'envelope',
        'by_source',
        { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_VOIDED_WITH_ENV_ID, ADDENDUM_VOIDED_NO_ENV_ID] },
      ],
      { items: [makeEnv('completed')] },
    );
    const htmlCompleted = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />, 'vi');
    expect(htmlCompleted).toContain('data-status="completed"');
    expect(htmlCompleted).toContain('data-testid="hr-contract-download-sealed"');
    expect(htmlCompleted).not.toContain('data-testid="hr-contract-send-esign"');

    // 4. Voided addendum with NO envelope -> renders zero eSign badge/link/hint/send controls.
    cache.current.setQueryData(['hr', 'addendum', 'list', { employeeId: EMP_ID }], [voidedNoEnv]);
    cache.current.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_VOIDED_NO_ENV_ID] }],
      { items: [] },
    );
    const htmlNoEnv = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={true} />, 'vi');
    expect(htmlNoEnv).not.toContain('data-testid="hr-contract-sign-status"');
    expect(htmlNoEnv).not.toContain('data-testid="hr-contract-send-esign"');
    expect(htmlNoEnv).not.toContain('data-testid="hr-contract-nd337-hint"');

    // 5. signEnabled=false suppresses eSign badge/link even on voided addendum with an envelope in cache.
    cache.current.setQueryData(['hr', 'addendum', 'list', { employeeId: EMP_ID }], [voidedWithEnv]);
    cache.current.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [ADDENDUM_VOIDED_WITH_ENV_ID] }],
      { items: [makeEnv('sent')] },
    );
    const htmlSignOff = wrap(<HrAddendumPanel employee={SAMPLE_EMPLOYEE} signEnabled={false} />, 'vi');
    expect(htmlSignOff).not.toContain('data-testid="hr-contract-sign-status"');
    expect(htmlSignOff).not.toContain('data-testid="hr-contract-send-esign"');
  });

  it('renders career timeline, manager assets checklist, self-service /hr/my assets, and unreturned termination warning', () => {
    const timeline: HrTimelineResult = {
      employeeId: EMP_ID,
      events: [
        {
          id: 'employment:1',
          kind: 'employment_started',
          occurredOn: '2026-01-15',
          title: 'indefinite',
          subtitle: '18000000 VND',
          status: 'recorded',
          refId: TERM_ID,
          metadata: { contractType: 'indefinite', baseWage: '18000000' },
        },
        {
          id: 'addendum:1',
          kind: 'addendum_issued',
          occurredOn: '2026-12-01',
          title: 'PL-2026-01',
          subtitle: 'Điều chỉnh lương cơ bản.',
          status: 'issued',
          refId: ADDENDUM_ISSUED_ID,
          metadata: { addendumNumber: 'PL-2026-01', previousPayRate: '18000000', newPayRate: '22000000' },
        },
      ],
    };
    const assets: HrAssetView[] = [
      {
        id: '00000000-0000-7000-8000-000000000920',
        employeeId: EMP_ID,
        legalEntityId: LE_ID,
        assetCode: 'TS-001',
        assetName: 'MacBook Pro 14 M4',
        serialNumber: 'C02XYZ999',
        handedOverOn: '2026-01-16',
        returnedOn: null,
        status: 'assigned',
        notes: 'Giao kèm sạc USB-C',
        clearedBy: null,
        createdBy: EMP_ID,
        createdAt: '2026-01-16T08:00:00.000Z',
        updatedAt: '2026-01-16T08:00:00.000Z',
      },
    ];
    const selfAssets: HrSelfAssetView[] = [
      {
        id: '00000000-0000-7000-8000-000000000920',
        assetCode: 'TS-001',
        assetName: 'MacBook Pro 14 M4',
        serialNumber: 'C02XYZ999',
        handedOverOn: '2026-01-16',
        returnedOn: null,
        status: 'assigned',
      },
    ];

    cache.current.setQueryData(['hr', 'timeline', 'get', { employeeId: EMP_ID }], timeline);
    cache.current.setQueryData(['hr', 'assets', 'list', { employeeId: EMP_ID }], assets);
    cache.current.setQueryData(['hr', 'self', 'assets', 'list', {}], selfAssets);
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], SAMPLE_EMPLOYEE);
    cache.current.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], []);
    cache.current.setQueryData(['org', 'apps'], { apps: [{ id: 'sign', effective: false }] });

    expect(countUnreturnedAssets(assets)).toBe(1);

    const timelineHtml = wrap(<HrCareerTimelinePanel employeeId={EMP_ID} />, 'vi');
    expect(timelineHtml).toContain('data-testid="hr-timeline-panel"');
    expect(timelineHtml).toContain('PL-2026-01');
    expect(timelineHtml).toContain(viMessages.hrEmployees.timeline.kinds.employment_started);

    const assetsHtml = wrap(<HrAssetsPanel employeeId={EMP_ID} active={true} />, 'vi');
    expect(assetsHtml).toContain('data-testid="hr-assets-panel"');
    expect(assetsHtml).toContain('<th scope="col"');
    expect(assetsHtml).toContain('MacBook Pro 14 M4');
    expect(assetsHtml).toContain('data-testid="hr-asset-return-btn"');
    expect(assetsHtml).toContain('data-testid="hr-asset-waive-btn"');
    expect(assetsHtml).toContain('max-md:min-h-11');

    const selfAssetsHtml = wrap(<HrSelfAssetsCard />, 'vi');
    expect(selfAssetsHtml).toContain('data-testid="hr-my-assets"');
    expect(selfAssetsHtml).toContain('<th scope="col"');
    expect(selfAssetsHtml).toContain('MacBook Pro 14 M4');
    expect(selfAssetsHtml).not.toContain('Giao kèm sạc USB-C');

    const detailHtml = wrap(<Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />, 'vi');
    expect(detailHtml).toContain('data-testid="hr-addendum-toggle"');
    expect(detailHtml).toContain('data-testid="hr-timeline-toggle"');
    expect(detailHtml).toContain('data-testid="hr-assets-toggle"');
    expect(detailHtml).toContain('data-testid="hr-end-unreturned-warning"');
    expect(detailHtml).toContain('data-testid="hr-end-asset-override"');
  });

  it('keeps vi.ts and en.ts Stage 6C i18n keys aligned without em dashes', () => {
    const checkParity = (a: Record<string, unknown>, b: Record<string, unknown>, path: string) => {
      expect(Object.keys(a).sort(), `keys at ${path}`).toEqual(Object.keys(b).sort());
      for (const k of Object.keys(a)) {
        const va = a[k];
        const vb = b[k];
        if (va && typeof va === 'object' && vb && typeof vb === 'object') {
          checkParity(va as Record<string, unknown>, vb as Record<string, unknown>, `${path}.${k}`);
        } else {
          expect(String(va)).not.toContain('\u2014');
          expect(String(vb)).not.toContain('\u2014');
        }
      }
    };

    checkParity(viMessages.hrEmployees.addendum, en.hrEmployees.addendum, 'hrEmployees.addendum');
    checkParity(viMessages.hrEmployees.timeline, en.hrEmployees.timeline, 'hrEmployees.timeline');
    checkParity(viMessages.hrEmployees.assets, en.hrEmployees.assets, 'hrEmployees.assets');
    checkParity(viMessages.hrMy.assets, en.hrMy.assets, 'hrMy.assets');

    // Type-level smoke check on check result shape
    const sampleCheck: HrAddendumCheckResult = {
      employeeId: EMP_ID,
      employmentId: TERM_ID,
      readyToIssue: true,
      findings: [],
      lyNote: 'OK',
      ai: { ok: true, reason: 'ok' },
    };
    expect(sampleCheck.readyToIssue).toBe(true);
  });
});
