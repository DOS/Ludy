// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_CANDIDATE_STAGES,
  HR_JOB_OPENING_STATUSES,
  type HrCandidateView,
  type HrDepartmentView,
  type HrOpeningView,
  type LegalEntity,
} from '@crove/kernel-contract';
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
        recruiting: {
          openings: { add: vi.fn(), edit: vi.fn(), close: vi.fn() },
          candidates: { add: vi.fn(), edit: vi.fn(), moveStage: vi.fn(), scheduleInterview: vi.fn(), hire: vi.fn(), erase: vi.fn() },
          brief: vi.fn(),
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  CandidateDetailPanel,
  CandidateForm,
  HireCandidatePanel,
  HrRecruitingPage,
  OpeningForm,
  RecruitingBriefPanel,
  buildHireDefaults,
  formatLocalDateTimeInput,
  parseSkillsInput,
} = await import('../src/routes/hr-recruiting.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const ENTITY_ID = '00000000-0000-7000-8000-000000000001';
const DEPT_ID = '00000000-0000-7000-8000-000000000011';
const OPENING_ID = '00000000-0000-7000-8000-000000000021';
const CANDIDATE_ID = '00000000-0000-7000-8000-000000000031';
const NOW_ISO = '2026-11-16T08:00:00.000Z';

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

const sampleOpening: HrOpeningView = {
  id: OPENING_ID,
  legalEntityId: ENTITY_ID,
  departmentId: DEPT_ID,
  title: 'Kế toán tổng hợp',
  departmentName: 'Phòng Tài chính - Kế toán',
  contractType: 'fixed_term',
  region: 'II',
  payFunction: 'admin',
  budgetMinWage: '15000000',
  budgetMaxWage: '22000000',
  requiredSkills: ['MISA', 'Thuế GTGT'],
  status: 'open',
  closedAt: null,
  candidateCount: 1,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleCandidate: HrCandidateView = {
  id: CANDIDATE_ID,
  legalEntityId: ENTITY_ID,
  openingId: OPENING_ID,
  openingTitle: 'Kế toán tổng hợp',
  departmentId: DEPT_ID,
  departmentName: 'Phòng Tài chính - Kế toán',
  displayName: 'Nguyễn Minh Thư',
  email: 'thu@example.vn',
  phone: '0901234567',
  stage: 'offer',
  yearsExperience: 4,
  matchedSkills: ['MISA'],
  expectedWage: '18000000',
  agreedWage: '19000000',
  plannedStartOn: '2026-12-01',
  notes: 'Kinh nghiệm làm báo cáo tài chính SME.',
  interviewEventId: '00000000-0000-7000-8000-000000000041',
  interviewStartsAt: '2026-11-20T02:00:00.000Z',
  interviewEndsAt: '2026-11-20T02:45:00.000Z',
  hiredEmployeeId: null,
  erasedAt: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleDepartment: HrDepartmentView = {
  id: DEPT_ID,
  legalEntityId: ENTITY_ID,
  name: 'Phòng Tài chính - Kế toán',
  code: 'FIN',
  payFunction: 'admin',
  archivedAt: null,
  activeEmployees: 2,
  activeBaseWageTotal: '30000000',
};

const sampleEntity: LegalEntity = {
  id: ENTITY_ID,
  name: 'Công ty TNHH Crove',
  kind: 'company',
  taxCode: '0312345678',
  parentId: null,
  isDefault: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

describe('HR recruiting UI (#3425)', () => {
  beforeEach(() => cache.current.clear());

  it('keeps skill parsing, hire prefill defaults, and recruiting error i18n keys complete in VI and EN', () => {
    expect(HR_JOB_OPENING_STATUSES).toEqual(['open', 'closed']);
    expect(HR_CANDIDATE_STAGES).toEqual(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']);
    expect(parseSkillsInput(' MISA, Excel , misa,  Thuế GTGT ,, ')).toEqual(['MISA', 'Excel', 'Thuế GTGT']);
    expect(buildHireDefaults(sampleCandidate, sampleOpening)).toEqual({
      effectiveFrom: '2026-12-01',
      baseWage: '19000000',
      contractType: 'fixed_term',
      region: 'II',
      payFunction: 'admin',
      departmentId: DEPT_ID,
      jobTitle: 'Kế toán tổng hợp',
    });
    expect(formatLocalDateTimeInput('not-a-date')).toBe('');

    const codes = [
      'HR_OPENING_NOT_FOUND',
      'HR_OPENING_CLOSED',
      'HR_OPENING_BUDGET_ORDER',
      'HR_CANDIDATE_NOT_FOUND',
      'HR_CANDIDATE_WRONG_ENTITY',
      'HR_CANDIDATE_ERASED',
      'HR_CANDIDATE_HIRED',
      'HR_CANDIDATE_ALREADY_HIRED',
      'HR_CANDIDATE_STAGE_FINAL',
      'HR_CANDIDATE_STILL_IN_PIPELINE',
      'HR_RECRUITING_TRANSITION_REFUSED',
      'HR_INTERVIEW_DURATION_INVALID',
      'HR_INTERVIEW_SLOT_TAKEN',
    ] as const;
    for (const code of codes) {
      const err = { code, status: 422, message: viMessages.kernelErrors.codes[code] };
      expect(describeError(err, translatorFor('vi'), 'vi')).toBe(viMessages.kernelErrors.codes[code]);
      expect(describeError(err, translatorFor('en'), 'en')).toBe(en.kernelErrors.codes[code]);
    }
  });

  it('renders page, forms, candidate detail, 1-click hire, and Ly screening panels cleanly in VI and EN', () => {
    const pageVi = wrap(<HrRecruitingPage />, 'vi');
    expect(pageVi).toContain(viMessages.hrRecruiting.title);
    expect(pageVi).toContain(viMessages.hrRecruiting.newOpening);
    expect(pageVi).toContain(viMessages.hrRecruiting.newCandidate);

    const pageEn = wrap(<HrRecruitingPage />, 'en');
    expect(pageEn).toContain(en.hrRecruiting.title);

    const openingHtml = wrap(<OpeningForm departments={[sampleDepartment]} entities={[sampleEntity]} onClose={() => undefined} />, 'vi');
    expect(openingHtml).toContain('hr-opening-form');
    expect(openingHtml).toContain('hr-opening-save');

    const candidateHtml = wrap(<CandidateForm openings={[sampleOpening]} defaultOpeningId={OPENING_ID} onClose={() => undefined} />, 'vi');
    expect(candidateHtml).toContain('hr-candidate-form');
    expect(candidateHtml).toContain('hr-candidate-save');

    const detailHtml = wrap(
      <CandidateDetailPanel
        candidate={sampleCandidate}
        openings={[sampleOpening]}
        departments={[sampleDepartment]}
        owner={true}
        onClose={() => undefined}
      />,
      'vi',
    );
    expect(detailHtml).toContain('Nguyễn Minh Thư');
    expect(detailHtml).toContain('hr-recruiting-ly-brief');
    expect(detailHtml).toContain('hr-candidate-hire');
    expect(detailHtml).toContain('hr-interview-toggle');

    const hireHtml = wrap(<HireCandidatePanel candidate={sampleCandidate} opening={sampleOpening} departments={[sampleDepartment]} />, 'en');
    expect(hireHtml).toContain('19000000');
    expect(hireHtml).toContain('2026-12-01');
    expect(hireHtml.replaceAll('&amp;', '&')).toContain(en.hrRecruiting.hire.submit);

    const lyHtml = wrap(<RecruitingBriefPanel candidateId={CANDIDATE_ID} />, 'vi');
    expect(lyHtml).toContain(viMessages.hrRecruiting.ly.run);
  });
});
