// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_CONTRACT_ALERT_CODES,
  HR_CONTRACT_FORMS,
  HR_PROBATION_ROLE_TIERS,
  type HrEmployee,
  type HrEmployeeSummary,
} from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { describeError } from '../src/lib/errors.ts';
import { translatorFor } from '../src/i18n/runtime.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        employee: { contractPdf: vi.fn() },
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
  };
});

const {
  AddForm,
  Detail,
  HrEmployeesPage,
  TermsFields,
  blankTerms,
  buildEmploymentPayload,
  decodeBase64Bytes,
  previewContractCheck,
  triggerContractPdfDownload,
} = await import('../src/routes/hr-employees.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000021';
const ENTITY_ID = '00000000-0000-7000-8000-000000000001';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('HR labor contract & probation UI (#3384)', () => {
  beforeEach(() => cache.current.clear());

  it('ships contract enums, probation_ends_this_month flag i18n, and HR_CONTRACT_INVALID messages', () => {
    expect(HR_CONTRACT_FORMS).toEqual(['written', 'electronic', 'oral']);
    expect(HR_PROBATION_ROLE_TIERS).toEqual(['enterprise_manager', 'college_or_above', 'intermediate_technical', 'other']);
    expect(HR_CONTRACT_ALERT_CODES).toEqual([
      'contract_expired',
      'contract_expiring_soon',
      'probation_ending_soon',
      'final_fixed_term_renewal',
      'must_convert_to_indefinite',
    ]);
    expect(viMessages.hrPayroll.flag.probation_ends_this_month).toBeTruthy();
    expect(en.hrPayroll.flag.probation_ends_this_month).toBeTruthy();
    expect(viMessages.kernelErrors.codes.HR_CONTRACT_INVALID).toBeTruthy();
    expect(en.kernelErrors.codes.HR_CONTRACT_INVALID).toBeTruthy();
    const invalidContractErr = { code: 'HR_CONTRACT_INVALID', status: 422, message: 'English fallback' };
    expect(describeError(invalidContractErr, translatorFor('vi'), 'vi')).toBe(viMessages.kernelErrors.codes.HR_CONTRACT_INVALID);
    expect(describeError(invalidContractErr, translatorFor('en'), 'en')).toBe(en.kernelErrors.codes.HR_CONTRACT_INVALID);
  });

  it('keeps basic employment payload backwards compatible and evaluates live contract/probation checks', () => {
    const basic = { ...blankTerms(), effectiveFrom: '2026-01-01', contractType: 'fixed_term' as const, baseWage: '15000000' };
    expect(buildEmploymentPayload(basic)).toEqual({
      effectiveFrom: '2026-01-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '15000000',
      payFunction: 'admin',
    });
    expect(previewContractCheck(basic)).toEqual([]);

    const compliantFixed = buildEmploymentPayload({
      ...basic,
      contractForm: 'written',
      termMonths: '12',
      fixedTermSequence: '1',
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-03-01',
      probationWage: '12750000',
    });
    expect(compliantFixed).toMatchObject({
      contractForm: 'written',
      termMonths: 12,
      fixedTermSequence: 1,
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-03-01',
      probationWage: '12750000',
    });
    expect(
      previewContractCheck({
        ...basic,
        contractForm: 'written',
        termMonths: '12',
        fixedTermSequence: '1',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-03-01',
        probationWage: '12750000',
      }),
    ).toEqual([]);

    const badWageAndOral = previewContractCheck({
      ...basic,
      contractForm: 'oral',
      termMonths: '12',
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-03-02',
      probationWage: '10000000',
    });
    expect(badWageAndOral.map((f) => f.code)).toEqual([
      'oral_contract_not_allowed',
      'probation_exceeds_cap',
      'probation_wage_below_85_percent',
    ]);

    const warningOnly = previewContractCheck({
      ...basic,
      termMonths: '12',
      fixedTermSequence: '2',
    });
    expect(warningOnly.map((f) => [f.code, f.severity])).toEqual([['final_fixed_term_renewal', 'warning']]);
  });

  it('renders collapsed toggle in AddForm and expanded contract/probation fields with live validation feedback', () => {
    const addHtml = wrap(<AddForm onClose={() => {}} />, 'vi');
    expect(addHtml).toContain('data-testid="hr-contract-details-toggle"');
    expect(addHtml).toContain('aria-expanded="false"');
    expect(addHtml).toContain('Chi tiết hợp đồng &amp; thử việc');
    expect(addHtml).not.toContain('data-testid="hr-contract-details-panel"');

    const expandedHtml = wrap(
      <TermsFields
        id="hr-test"
        defaultExpanded
        value={{
          ...blankTerms(),
          effectiveFrom: '2026-01-01',
          contractType: 'fixed_term',
          baseWage: '10000001',
          contractForm: 'written',
          termMonths: '12',
          fixedTermSequence: '2',
          probationRoleTier: 'college_or_above',
          probationEndOn: '2026-03-01',
          probationWage: '8500000',
        }}
        onChange={() => {}}
      />,
      'en',
    );
    expect(expandedHtml).toContain('data-testid="hr-contract-details-panel"');
    expect(expandedHtml).toContain('data-testid="hr-contract-auto-end"');
    expect(expandedHtml).toContain('data-testid="hr-contract-validation-errors"');
    expect(expandedHtml).toContain('data-testid="hr-contract-validation-warnings"');
    expect(expandedHtml).toContain(en.hrEmployees.contractCheck.findings.probation_wage_below_85_percent);
    expect(expandedHtml).toContain(en.hrEmployees.contractCheck.findings.final_fixed_term_renewal);
  });

  it('renders contractAlerts badges and contract/probation columns on employee list and detail views', () => {
    const termsRow = {
      id: '00000000-0000-7000-8000-000000000031',
      effectiveFrom: '2026-01-01',
      contractType: 'fixed_term' as const,
      region: 'I' as const,
      baseWage: '15000000.00',
      payFunction: 'admin' as const,
      contractForm: 'written' as const,
      termMonths: 12,
      contractEndOn: '2026-12-31',
      fixedTermSequence: 2,
      probationRoleTier: 'college_or_above' as const,
      probationEndOn: '2026-03-01',
      probationWage: '12750000.00',
    };
    const alerts = [
      {
        code: 'contract_expiring_soon' as const,
        severity: 'warning' as const,
        targetDate: '2026-12-31',
        daysRemaining: 12,
        message: 'Contract expires in 12 day(s) on 2026-12-31.',
        cite: 'Labor Code 2019 Art. 20(2) & Art. 35/36',
      },
      {
        code: 'final_fixed_term_renewal' as const,
        severity: 'warning' as const,
        targetDate: '2026-12-31',
        daysRemaining: 12,
        message: 'Final fixed-term renewal.',
        cite: 'Labor Code 2019 Art. 20(2)',
      },
    ];
    const summary: HrEmployeeSummary = {
      id: EMP_ID,
      legalEntityId: ENTITY_ID,
      displayName: 'Nguyễn Văn An Canary',
      departmentId: null,
      departmentName: null,
      jobTitle: null,
      status: 'active',
      endedOn: null,
      current: termsRow,
      hasIdentityNumber: false,
      hasAccountNumber: false,
      contractAlerts: alerts,
    };
    const detail: HrEmployee = {
      ...summary,
      address: null,
      identityNumber: null,
      accountNumber: null,
      bankCode: null,
      birthDate: null,
      taxCode: null,
      insuranceNumber: null,
      finalizationAuthorizedYears: [],
      erased: false,
      employments: [termsRow],
      dependents: [],
    };

    cache.current.setQueryData(['org', 'get', {}], { role: 'owner' });
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'list', { status: 'active', limit: 200 }], [summary]);
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], detail);

    const listHtml = wrap(<HrEmployeesPage />, 'vi');
    expect(listHtml).toContain('data-testid="hr-contract-alert-contract_expiring_soon"');
    expect(listHtml).toContain('data-testid="hr-contract-alert-final_fixed_term_renewal"');
    expect(listHtml).toContain('12 ngày');

    const detailHtml = wrap(<Detail employeeId={EMP_ID} owner onClose={() => {}} />, 'en');
    expect(detailHtml).toContain('data-testid="hr-employee-alerts"');
    expect(detailHtml).toContain('data-testid="hr-contract-alert-contract_expiring_soon"');
    expect(detailHtml).toContain('12 mo');
    expect(detailHtml).toContain('#2');
    expect(detailHtml).toContain('College+');
    expect(detailHtml).toContain('data-testid="hr-terms-contract-pdf"');
    expect(detailHtml).toContain('Download contract PDF');

    const detailViHtml = wrap(<Detail employeeId={EMP_ID} owner onClose={() => {}} />, 'vi');
    expect(detailViHtml).toContain('data-testid="hr-terms-contract-pdf"');
    expect(detailViHtml).toContain('Tải hợp đồng PDF');

    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], {
      ...detail,
      erased: true,
    });
    const erasedHtml = wrap(<Detail employeeId={EMP_ID} owner onClose={() => {}} />, 'vi');
    expect(erasedHtml).not.toContain('data-testid="hr-terms-contract-pdf"');
  });

  it('decodes base64 PDF payloads and triggers an application/pdf browser download (#3548)', () => {
    const samplePdf = Buffer.from('%PDF-1.7\ntest\n%%EOF\n', 'latin1');
    const decoded = decodeBase64Bytes(samplePdf.toString('base64'));
    expect(Buffer.from(decoded).equals(samplePdf)).toBe(true);

    let capturedBlob: Blob | null = null;
    let clickedDownload = '';
    let appendedRemoved = false;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const origDocument = globalThis.document;
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      capturedBlob = obj as Blob;
      return 'blob:http://localhost/contract-pdf';
    };
    URL.revokeObjectURL = () => {};
    globalThis.document = {
      createElement: () => {
        const anchor = {
          href: '',
          download: '',
          click() {
            clickedDownload = anchor.download;
          },
          remove() {
            appendedRemoved = true;
          },
        };
        return anchor;
      },
      body: { append: () => {} },
    } as unknown as Document;

    try {
      triggerContractPdfDownload({
        filename: 'hop-dong-lao-dong-an-2026-01-01.pdf',
        contentType: 'application/pdf',
        pdfBase64: samplePdf.toString('base64'),
      });
      expect(capturedBlob).not.toBeNull();
      expect((capturedBlob as unknown as Blob).type).toBe('application/pdf');
      expect((capturedBlob as unknown as Blob).size).toBe(samplePdf.byteLength);
      expect(clickedDownload).toBe('hop-dong-lao-dong-an-2026-01-01.pdf');
      expect(appendedRemoved).toBe(true);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      globalThis.document = origDocument;
    }
  });
});
