// SPDX-License-Identifier: AGPL-3.0-only
// Component, PDF builder, and flow tests for Ludy Nhan su labor contract -> Ludy eSign handoff (#3553, A4, ADR-0053):
//   - Zero sign.* queries and zero UI controls when 'sign' is not deployed or disabled for the org
//   - Live eSign status badges (Nhap, Dang cho ky, Da ky ket, Tu choi / Da huy) linking to /o/$slug/sign/envelopes/$id
//   - Direct sealed PDF download button when completed + sealed
//   - Deterministic Labor Contract PDF 1.4 generation, #3548 server contractPdf auto-upgrade, candidate email prefill vs link mode,
//     retry idempotency, and org-switch guard
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrCandidateView, HrEmployee, HrEmploymentView, SignEnvelopeBySourceItem } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { buildHrContractPdfBytes, formatVndAmountForPdf, toPdfAsciiText } from '../src/lib/hr-contract-pdf.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['hr', 'sign'] as string[],
  calls: [] as Array<{ step: string; args: unknown }>,
  uploadedFiles: [] as Array<{ name: string; type: string; size: number; org: string | null | undefined }>,
  uploadedFileId: '01900000-0000-7000-8000-000000000501',
  createdEnvelopeId: '01900000-0000-7000-8000-000000000601',
  createdSignerId: '01900000-0000-7000-8000-000000000701',
  hiredCandidates: [] as HrCandidateView[],
  serverContractPdf: null as {
    filename: string;
    pdfBase64: string;
    title: string;
    employeeName: string;
    employeeEmail: string | null;
  } | null,
  signQueryAsked: [] as unknown[],
  signQueryExecuted: [] as unknown[],
  orgAppsQueryExecuted: 0,
  failSignerOnce: false,
  currentOrg: 'acme' as string | null,
  downloadedFileIds: [] as string[],
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: unknown;
    to: string;
    params?: Record<string, string>;
  }) => {
    const href = to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    return (
      <a href={href} {...(rest as object)}>
        {children as never}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            const joined = path.join('.');
            if (joined === 'sign.envelope.by_source') {
              state.signQueryAsked.push(args?.input);
            }
            return {
              queryKey:
                joined === 'sign.envelope.by_source' && args?.input !== undefined
                  ? [...path, args.input]
                  : args?.input !== undefined
                    ? [...path, args.input]
                    : path,
              queryFn: () => {
                if (joined === 'sign.envelope.by_source') {
                  state.signQueryExecuted.push(args?.input);
                }
                if (joined === 'org.apps') {
                  state.orgAppsQueryExecuted += 1;
                }
                return Promise.reject(new Error(`unexpected query ${joined}`));
              },
            };
          };
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });

  const makeRpcClient = (pinnedOrg: string | null) => ({
    sign: {
      envelope: {
        create: async (input: unknown) => {
          state.calls.push({ step: 'create', args: { input, pinnedOrg } });
          return {
            envelopeId: state.createdEnvelopeId,
            status: 'draft',
            inspectStatus: 'pending',
            version: 1,
          };
        },
      },
      signer: {
        add: async (input: unknown) => {
          state.calls.push({ step: 'addSigner', args: { input, pinnedOrg } });
          if (state.failSignerOnce) {
            state.failSignerOnce = false;
            throw new Error('signer network interrupted');
          }
          return {
            envelopeId: state.createdEnvelopeId,
            signerId: state.createdSignerId,
            routingOrder: 1,
            status: 'waiting',
            version: 2,
          };
        },
      },
    },
    hr: {
      ...(state.serverContractPdf
        ? {
            employee: {
              contractPdf: async (input: unknown) => {
                state.calls.push({ step: 'contractPdf', args: { input, pinnedOrg } });
                return state.serverContractPdf;
              },
            },
          }
        : {}),
      recruiting: {
        candidates: {
          list: async (input: unknown) => {
            state.calls.push({ step: 'listCandidates', args: { input, pinnedOrg } });
            return state.hiredCandidates;
          },
        },
      },
      payroll: {
        employees: { add: vi.fn(), edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
        employments: { add: vi.fn() },
        dependents: { add: vi.fn(), end: vi.fn() },
      },
    },
  });

  return {
    orpc: node([]),
    client: makeRpcClient(null),
    clientForOrg: (slug: string) => makeRpcClient(slug),
    getCurrentOrg: () => state.currentOrg,
    queryClient: state.client,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    isStepUpRequired: () => false,
    uploadFiles: async (files: File[], source: string, orgSlug?: string | null) => {
      for (const f of files) {
        state.uploadedFiles.push({ name: f.name, type: f.type, size: f.size, org: orgSlug });
      }
      state.calls.push({ step: 'uploadFiles', args: { source, orgSlug, count: files.length } });
      return { files: [{ fileId: state.uploadedFileId }] };
    },
    fetchFile: async (fileId: string) => {
      state.downloadedFileIds.push(fileId);
      return new Blob(['%PDF-1.4 sealed'], { type: 'application/pdf' });
    },
  };
});

const {
  HrContractSignHandoff,
  canDownloadSealedHrContract,
  canStartHrContractSignHandoff,
  createHrContractSignHandoffAttempt,
  performHrContractSignHandoff,
} = await import('../src/components/hr-contract-sign-handoff.tsx');
const { Detail } = await import('../src/routes/hr-employees.tsx');

const EMP_ID = '01900000-0000-7000-8000-000000000021';
const TERMS_ID = '01900000-0000-7000-8000-000000000031';
const ENTITY_ID = '01900000-0000-7000-8000-000000000001';
const SEALED_FILE_ID = '01900000-0000-7000-8000-000000000888';

const SAMPLE_EMPLOYMENT: HrEmploymentView = {
  id: TERMS_ID,
  effectiveFrom: '2026-11-01',
  contractType: 'fixed_term',
  region: 'I',
  baseWage: '22500000',
  payFunction: 'admin',
  payBasis: 'monthly',
  hourlyRate: null,
  pieceRate: null,
  scheduledHoursPerDay: null,
  taxResident: true,
  contractForm: 'electronic',
  termMonths: 12,
  contractEndOn: '2027-10-31',
  fixedTermSequence: 1,
  probationRoleTier: 'college_or_above',
  probationEndOn: '2026-12-30',
  probationWage: '19125000',
};

const SAMPLE_EMPLOYEE: HrEmployee = {
  id: EMP_ID,
  legalEntityId: ENTITY_ID,
  displayName: 'Nguyễn Thị Minh Ánh',
  departmentId: null,
  departmentName: 'Kỹ thuật',
  jobTitle: 'Kỹ sư phần mềm',
  linkedUserId: null,
  linkedMemberName: null,
  address: 'Quận 1, TP. Hồ Chí Minh',
  status: 'active',
  endedOn: null,
  isForeign: false,
  workPermitExempt: false,
  workPermitExpiresOn: null,
  hasWorkPermitNumber: false,
  current: SAMPLE_EMPLOYMENT,
  erased: false,
  hasIdentityNumber: true,
  hasAccountNumber: true,
  identityNumber: '079095001234',
  accountNumber: '190345678901',
  workPermitNumber: null,
  bankCode: 'TCB',
  birthDate: '1997-04-15',
  taxCode: '8123456789',
  insuranceNumber: '7912345679',
  finalizationAuthorizedYears: [],
  dependents: [],
  employments: [SAMPLE_EMPLOYMENT],
  contractAlerts: [],
};

function renderWithProviders(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={state.client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function seedSignEnabled(enabled: boolean): void {
  state.client.setQueryData(['org', 'apps'], {
    apps: [{ id: 'sign', effective: enabled }],
  });
}

describe('Ludy Nhan su -> Ludy eSign labor contract handoff (#3553)', () => {
  beforeEach(() => {
    state.client.clear();
    state.modules = ['hr', 'sign'];
    state.calls = [];
    state.uploadedFiles = [];
    state.hiredCandidates = [];
    state.serverContractPdf = null;
    state.signQueryAsked = [];
    state.signQueryExecuted = [];
    state.orgAppsQueryExecuted = 0;
    state.failSignerOnce = false;
    state.currentOrg = 'acme';
    state.downloadedFileIds = [];
  });

  it('builds a valid A4 PDF 1.4 labor contract without floating-point money loss', () => {
    expect(formatVndAmountForPdf('22500000')).toBe('22.500.000 VND');
    expect(formatVndAmountForPdf('22500000.5000')).toBe('22.500.000,5 VND');
    expect(toPdfAsciiText('Đặng Thị Minh Ánh - 22.500.000 ₫')).toBe('Dang Thi Minh Anh - 22.500.000 VND');

    const pdfBytes = buildHrContractPdfBytes({
      employerName: 'Công ty TNHH Công nghệ Ludy',
      employerTaxCode: '0312345678',
      employerAddress: 'TP. Hồ Chí Minh',
      employeeName: SAMPLE_EMPLOYEE.displayName,
      employeeDepartment: SAMPLE_EMPLOYEE.departmentName,
      employeeJobTitle: SAMPLE_EMPLOYEE.jobTitle,
      employeeAddress: SAMPLE_EMPLOYEE.address,
      employeeBirthDate: SAMPLE_EMPLOYEE.birthDate,
      effectiveFrom: SAMPLE_EMPLOYMENT.effectiveFrom,
      contractType: SAMPLE_EMPLOYMENT.contractType,
      contractForm: SAMPLE_EMPLOYMENT.contractForm,
      termMonths: SAMPLE_EMPLOYMENT.termMonths,
      contractEndOn: SAMPLE_EMPLOYMENT.contractEndOn,
      fixedTermSequence: SAMPLE_EMPLOYMENT.fixedTermSequence,
      region: SAMPLE_EMPLOYMENT.region,
      baseWage: SAMPLE_EMPLOYMENT.baseWage,
      probationRoleTier: SAMPLE_EMPLOYMENT.probationRoleTier,
      probationEndOn: SAMPLE_EMPLOYMENT.probationEndOn,
      probationWage: SAMPLE_EMPLOYMENT.probationWage,
    });

    const text = new TextDecoder('latin1').decode(pdfBytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595 842]');
    expect(text).toContain('HOP DONG LAO DONG / LABOR CONTRACT');
    expect(text).toContain('Nguyen Thi Minh Anh');
    expect(text).toContain('22.500.000 VND');
    expect(text).toContain('{{signature, r1}}');

    const hourlyText = new TextDecoder('latin1').decode(
      buildHrContractPdfBytes({
        employerName: 'Công ty TNHH Công nghệ Ludy',
        employeeName: SAMPLE_EMPLOYEE.displayName,
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '0',
        payBasis: 'hourly',
        hourlyRate: '50000',
        probationWage: '42500',
      }),
    );
    expect(hourlyText).toContain('50.000 VND/gio');
    expect(hourlyText).toContain('42.500 VND/gio');

    const pieceText = new TextDecoder('latin1').decode(
      buildHrContractPdfBytes({
        employerName: 'Công ty TNHH Công nghệ Ludy',
        employeeName: SAMPLE_EMPLOYEE.displayName,
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '0',
        payBasis: 'piece_rate',
        pieceRate: '25000',
      }),
    );
    expect(pieceText).toContain('25.000 VND/san pham');

    const startxrefMatch = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(startxrefMatch).not.toBeNull();
    const xrefPos = Number(startxrefMatch![1]);
    expect(text.slice(xrefPos, xrefPos + 5)).toBe('xref\n');

    // Long fields (500-char addresses + 200-char names + probation terms) paginate cleanly onto page 2 instead of overlapping signatures.
    const longPdfBytes = buildHrContractPdfBytes({
      employerName: `${'Cong ty TNHH Tap doan Cong nghe va Thuong mai Dien tu '.repeat(4)}`.slice(0, 200),
      employerTaxCode: '0312345679',
      employerAddress: `${'Tang 18 Toa nha Trung tam Tai chinh Khu Do thi Moi Thu Thiem Thanh pho Thu Duc '.repeat(7)}`.slice(0, 500),
      employeeName: `${'Nguyen Phuoc Hoang Minh Truong Son '.repeat(6)}`.slice(0, 200),
      employeeDepartment: 'Phong Nghien cuu va Phat trien He thong Phan tan Thoi gian thuc',
      employeeJobTitle: 'Chuyen gia Kien truc Bao mat Ha tang Dam may Cao cap',
      employeeAddress: `${'So 123 Duong Nguyen Hue Phuong Ben Nghe Quan 1 Thanh pho Ho Chi Minh '.repeat(8)}`.slice(0, 500),
      employeeBirthDate: '1990-08-20',
      effectiveFrom: '2026-11-01',
      contractType: 'fixed_term',
      contractForm: 'electronic',
      termMonths: 36,
      contractEndOn: '2029-10-31',
      fixedTermSequence: 2,
      region: 'I',
      baseWage: '65000000',
      probationRoleTier: 'enterprise_manager',
      probationEndOn: '2027-04-29',
      probationWage: '55250000',
    });
    const longText = new TextDecoder('latin1').decode(longPdfBytes);
    expect(longText).toContain('/Count 2');
    expect(longText).toContain('{{signature, r1}}');
    const longXrefMatch = /startxref\n(\d+)\n%%EOF/.exec(longText);
    expect(longXrefMatch).not.toBeNull();
    expect(longText.slice(Number(longXrefMatch![1]), Number(longXrefMatch![1]) + 5)).toBe('xref\n');
  });

  it('runs zero sign.* queries and renders zero eSign controls on Detail when sign is MODULE_OFF', () => {
    state.client.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], SAMPLE_EMPLOYEE);
    state.client.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], []);

    // Case 1: 'sign' not in deployed modules
    state.modules = ['hr'];
    const htmlNotDeployed = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(htmlNotDeployed).not.toContain('hr-contract-send-esign');
    expect(htmlNotDeployed).not.toContain('hr-terms-sign-cell');
    expect(state.signQueryAsked).toEqual([]);
    expect(state.orgAppsQueryExecuted).toBe(0);

    // Case 2: 'sign' deployed, disabled for this org
    state.modules = ['hr', 'sign'];
    seedSignEnabled(false);
    const htmlDisabled = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(htmlDisabled).not.toContain('hr-contract-send-esign');
    expect(htmlDisabled).not.toContain('hr-terms-sign-cell');
    expect(state.signQueryAsked).toEqual([]);
  });

  it('renders live Vietnamese status badges, envelope links, retry buttons, and sealed PDF download on HR Detail', () => {
    seedSignEnabled(true);
    state.client.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], SAMPLE_EMPLOYEE);

    const makeEnvelope = (
      status: SignEnvelopeBySourceItem['status'],
      overrides: Partial<SignEnvelopeBySourceItem> = {},
    ): SignEnvelopeBySourceItem => ({
      sourceId: TERMS_ID,
      envelopeId: state.createdEnvelopeId,
      title: 'Hợp đồng lao động - Nguyễn Thị Minh Ánh (2026-11-01)',
      status,
      sealStatus: status === 'completed' ? 'sealed' : null,
      sealedFileId: status === 'completed' ? SEALED_FILE_ID : null,
      certificateCode: status === 'completed' ? 'CS-HR01-ABCD' : null,
      completedAt: status === 'completed' ? '2026-11-17T08:15:00.000Z' : null,
      signerCount: 1,
      signedCount: status === 'completed' ? 1 : 0,
      createdAt: '2026-11-17T08:00:00.000Z',
      updatedAt: '2026-11-17T08:15:00.000Z',
      ...overrides,
    });

    // No envelope yet -> shows "Ký qua eSign"
    state.client.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [TERMS_ID] }],
      { items: [] },
    );
    const emptyHtml = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(emptyHtml).toContain('Ký điện tử');
    expect(emptyHtml).toContain('data-testid="hr-contract-send-esign"');
    expect(emptyHtml).toContain('Ký qua eSign');

    // Draft -> "Nháp" link, send button hidden
    state.client.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [TERMS_ID] }],
      { items: [makeEnvelope('draft')] },
    );
    const draftHtml = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(draftHtml).toContain(`href="/o/acme/sign/envelopes/${state.createdEnvelopeId}"`);
    expect(draftHtml).toContain('>Nháp<');
    expect(draftHtml).not.toContain('data-testid="hr-contract-send-esign"');

    // Sent -> "Đang chờ ký"
    state.client.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [TERMS_ID] }],
      { items: [makeEnvelope('sent')] },
    );
    const sentHtml = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(sentHtml).toContain('>Đang chờ ký<');

    // Completed + sealed -> "Đã ký kết" + "Tải bản đã ký" download button
    state.client.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'hr_contract', sourceIds: [TERMS_ID] }],
      { items: [makeEnvelope('completed')] },
    );
    const completedHtml = renderWithProviders(
      <Detail employeeId={EMP_ID} owner={true} departments={[]} onClose={() => {}} />,
    );
    expect(completedHtml).toContain('>Đã ký kết<');
    expect(completedHtml).toContain('data-testid="hr-contract-download-sealed"');
    expect(completedHtml).toContain('Tải bản đã ký');
    expect(completedHtml).not.toContain('data-testid="hr-contract-send-esign"');

    // Declined / Voided -> "Từ chối / Đã hủy" AND allows re-sending a fresh envelope
    for (const terminalRetryStatus of ['declined', 'voided'] as const) {
      const html = renderWithProviders(
        <HrContractSignHandoff
          source={{ employment: SAMPLE_EMPLOYMENT, employee: { id: EMP_ID, displayName: SAMPLE_EMPLOYEE.displayName } }}
          canEdit={true}
          signEnabled={true}
          envelope={makeEnvelope(terminalRetryStatus)}
        />,
      );
      expect(html).toContain('>Từ chối / Đã hủy<');
      expect(html).toContain('data-testid="hr-contract-send-esign"');
    }

    // Employment with contractType === 'none' does not offer eSign handoff
    expect(canStartHrContractSignHandoff({ contractType: 'none' }, null)).toBe(false);
    expect(canDownloadSealedHrContract(makeEnvelope('completed', { sealStatus: 'pending' }))).toBe(false);
    expect(canDownloadSealedHrContract(makeEnvelope('completed'))).toBe(true);
  });

  it('prefills hired candidate email + phone, falls back to link delivery, recovers unfinished retries, and auto-uses #3548 contractPdf when available', async () => {
    state.hiredCandidates = [
      {
        id: '01900000-0000-7000-8000-000000000911',
        legalEntityId: ENTITY_ID,
        openingId: null,
        openingTitle: 'Software Engineer',
        departmentId: null,
        departmentName: 'Kỹ thuật',
        displayName: SAMPLE_EMPLOYEE.displayName,
        email: 'minh.anh@candidate.test',
        phone: '0901234567',
        stage: 'hired',
        source: 'direct',
        yearsExperience: 4,
        matchedSkills: ['TypeScript'],
        expectedWage: '22500000',
        agreedWage: '22500000',
        plannedStartOn: '2026-11-01',
        notes: null,
        interviewEventId: null,
        interviewStartsAt: null,
        interviewEndsAt: null,
        interviewerUserId: null,
        interviewerName: null,
        hiredEmployeeId: EMP_ID,
        hiredAt: '2026-10-28T04:00:00.000Z',
        erasedAt: null,
        createdAt: '2026-10-20T04:00:00.000Z',
        updatedAt: '2026-10-28T04:00:00.000Z',
      },
    ];

    const navigated: unknown[] = [];
    const attempt = createHrContractSignHandoffAttempt();
    state.failSignerOnce = true;

    // First attempt fails on signer.add after uploading PDF & creating envelope
    await expect(
      performHrContractSignHandoff({
        source: {
          employment: SAMPLE_EMPLOYMENT,
          employee: {
            id: EMP_ID,
            displayName: SAMPLE_EMPLOYEE.displayName,
            departmentName: SAMPLE_EMPLOYEE.departmentName,
            jobTitle: SAMPLE_EMPLOYEE.jobTitle,
          },
          employer: { name: 'Cong ty TNHH Ludy', taxCode: '0312345678' },
        },
        slug: 'acme',
        envelopeTitle: 'Hợp đồng lao động - Nguyễn Thị Minh Ánh (2026-11-01)',
        signerRoleLabel: 'Người lao động',
        navigate: (opts) => navigated.push(opts),
        attempt,
      }),
    ).rejects.toThrow('signer network interrupted');

    expect(attempt.sourceFileId).toBe(state.uploadedFileId);
    expect(attempt.envelopeId).toBe(state.createdEnvelopeId);
    expect(attempt.signerAdded).toBeUndefined();

    // Retry reuses sourceFileId and envelopeId without re-uploading or duplicating the envelope!
    const completedEnvId = await performHrContractSignHandoff({
      source: {
        employment: SAMPLE_EMPLOYMENT,
        employee: {
          id: EMP_ID,
          displayName: SAMPLE_EMPLOYEE.displayName,
        },
      },
      slug: 'acme',
      envelopeTitle: 'Hợp đồng lao động - Nguyễn Thị Minh Ánh (2026-11-01)',
      signerRoleLabel: 'Người lao động',
      navigate: (opts) => navigated.push(opts),
      attempt,
    });

    expect(completedEnvId).toBe(state.createdEnvelopeId);
    expect(state.uploadedFiles).toHaveLength(1);
    expect(state.calls.filter((c) => c.step === 'create')).toHaveLength(1);
    expect(state.calls.find((c) => c.step === 'create')?.args).toMatchObject({
      pinnedOrg: 'acme',
      input: {
        title: 'Hợp đồng lao động - Nguyễn Thị Minh Ánh (2026-11-01)',
        sourceKind: 'hr_contract',
        sourceId: TERMS_ID,
        sourceFileId: state.uploadedFileId,
      },
    });
    const addSignerCalls = state.calls.filter((c) => c.step === 'addSigner');
    expect(addSignerCalls).toHaveLength(2);
    expect(addSignerCalls[1]?.args).toMatchObject({
      pinnedOrg: 'acme',
      input: {
        envelopeId: state.createdEnvelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: 'Người lao động',
        name: 'Nguyễn Thị Minh Ánh',
        email: 'minh.anh@candidate.test',
        phone: '0901234567',
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
    });
    expect(navigated).toEqual([{ to: '/o/$slug/sign/envelopes/$id', params: { slug: 'acme', id: state.createdEnvelopeId } }]);

    // Fallback to deliveryMode: 'link' when no candidate email exists AND auto-upgrade when #3548 contractPdf is present
    state.calls = [];
    state.hiredCandidates = [];
    state.serverContractPdf = {
      filename: 'hdld-server-3548.pdf',
      pdfBase64: btoa('%PDF-1.4 server-generated'),
      title: 'Hợp đồng lao động chuẩn BLLĐ 2019 - Nguyễn Thị Minh Ánh',
      employeeName: SAMPLE_EMPLOYEE.displayName,
      employeeEmail: null,
    };

    await performHrContractSignHandoff({
      source: {
        employment: SAMPLE_EMPLOYMENT,
        employee: { id: EMP_ID, displayName: SAMPLE_EMPLOYEE.displayName },
      },
      slug: 'acme',
      envelopeTitle: 'Fallback Title',
      signerRoleLabel: 'Người lao động',
      navigate: () => {},
    });

    expect(state.calls.map((c) => c.step)).toContain('contractPdf');
    expect(state.calls.find((c) => c.step === 'create')?.args).toMatchObject({
      input: {
        title: 'Hợp đồng lao động chuẩn BLLĐ 2019 - Nguyễn Thị Minh Ánh',
        sourceKind: 'hr_contract',
        sourceId: TERMS_ID,
      },
    });
    expect(state.calls.find((c) => c.step === 'addSigner')?.args).toMatchObject({
      input: {
        name: 'Nguyễn Thị Minh Ánh',
        deliveryMode: 'link',
      },
    });

    // Org-switch guard aborts immediately if active org changed mid-flight
    state.currentOrg = 'other-org';
    await expect(
      performHrContractSignHandoff({
        source: {
          employment: SAMPLE_EMPLOYMENT,
          employee: { id: EMP_ID, displayName: SAMPLE_EMPLOYEE.displayName },
        },
        slug: 'acme',
        envelopeTitle: 'Title',
        signerRoleLabel: 'Người lao động',
        navigate: () => {},
      }),
    ).rejects.toThrow(/Organization changed/);
  });
});
