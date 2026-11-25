// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_CANDIDATE_SOURCES,
  HR_CANDIDATE_STAGES,
  HR_JOB_OPENING_STATUSES,
  HR_RECRUITING_BRIEF_REASONS,
  type HrCandidateView,
  type HrCvExtractDraft,
  type HrDepartmentView,
  type HrInterviewerOption,
  type HrInviteDraftResult,
  type HrOpeningView,
  type HrRecruitingAnalyticsResult,
  type LegalEntity,
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
        if (prop === 'infiniteOptions') {
          return (opts: {
            input: (pageParam: unknown) => unknown;
            initialPageParam: unknown;
            getNextPageParam: (lastPage: unknown, allPages: unknown[]) => unknown;
          }) => ({
            queryKey: [...path, 'infinite', opts.input(opts.initialPageParam)],
            initialPageParam: opts.initialPageParam,
            queryFn: () => Promise.reject(new Error('not fetched')),
            getNextPageParam: opts.getNextPageParam,
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
        recruiting: {
          openings: { add: vi.fn(), edit: vi.fn(), close: vi.fn() },
          candidates: { add: vi.fn(), edit: vi.fn(), moveStage: vi.fn(), scheduleInterview: vi.fn(), cancelInterview: vi.fn(), hire: vi.fn(), erase: vi.fn() },
          brief: vi.fn(),
          inviteDraft: vi.fn(),
        },
      },
    },
    extractRecruitingCv: vi.fn(),
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  CANDIDATE_PAGE_SIZE,
  CandidateDetailPanel,
  CandidateForm,
  CvIntakePanel,
  EngageInvitePanel,
  FunnelAnalyticsSection,
  HireCandidatePanel,
  HrRecruitingPage,
  InterviewSchedulePanel,
  OpeningForm,
  RecruitingBriefPanel,
  buildHireDefaults,
  buildInterviewSlotsInput,
  flattenCandidatePages,
  formatLocalDateTimeInput,
  mergeHireDraft,
  nextCandidateCursor,
  parseSkillsInput,
  resolveDefaultInterviewerId,
} = await import('../src/routes/hr-recruiting.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');
const {
  applyInviteChannelChange,
  applyInviteInterviewerChange,
  buildInviteSelectionKey,
  shouldAcceptInviteDraftResponse,
} = await import('../src/components/hr-recruiting-stage5d.tsx');

const ENTITY_ID = '00000000-0000-7000-8000-000000000001';
const DEPT_ID = '00000000-0000-7000-8000-000000000011';
const OPENING_ID = '00000000-0000-7000-8000-000000000021';
const CANDIDATE_ID = '00000000-0000-7000-8000-000000000031';
const OWNER_USER_ID = '00000000-0000-7000-8000-000000000051';
const MEMBER_USER_ID = '00000000-0000-7000-8000-000000000052';
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
  source: 'direct',
  yearsExperience: 4,
  matchedSkills: ['MISA'],
  expectedWage: '18000000',
  agreedWage: '19000000',
  plannedStartOn: '2026-12-01',
  notes: 'Kinh nghiệm làm báo cáo tài chính SME.',
  interviewEventId: '00000000-0000-7000-8000-000000000041',
  interviewStartsAt: '2026-11-20T02:00:00.000Z',
  interviewEndsAt: '2026-11-20T02:45:00.000Z',
  interviewerUserId: OWNER_USER_ID,
  interviewerName: 'Lê Hoàng Minh',
  hiredEmployeeId: null,
  hiredAt: null,
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
  managerUserId: null,
  managerName: null,
  archivedAt: null,
  activeEmployees: 2,
  activeBaseWageTotal: '30000000',
};

const sampleEntity: LegalEntity = {
  id: ENTITY_ID,
  name: 'Công ty TNHH Ludy',
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
      'HR_INTERVIEWER_INVALID',
    ] as const;
    for (const code of codes) {
      const err = { code, status: 422, message: viMessages.kernelErrors.codes[code] };
      expect(describeError(err, translatorFor('vi'), 'vi')).toBe(viMessages.kernelErrors.codes[code]);
      expect(describeError(err, translatorFor('en'), 'en')).toBe(en.kernelErrors.codes[code]);
    }

    for (const reason of HR_RECRUITING_BRIEF_REASONS) {
      expect(viMessages.hrRecruiting.ly.aiStatus[reason]).toBeTruthy();
      expect(en.hrRecruiting.ly.aiStatus[reason]).toBeTruthy();
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
    expect(hireHtml).toContain('hr-hire-term-months');
    expect(hireHtml).toContain('hr-hire-contract-end');
    expect(hireHtml).toContain('hr-hire-fixed-term-hint');
    expect(hireHtml).toMatch(/disabled=""[^>]*data-testid="hr-candidate-hire"|data-testid="hr-candidate-hire"[^>]*disabled/);
    expect(hireHtml.replaceAll('&amp;', '&')).toContain(en.hrRecruiting.hire.submit);

    const indefiniteOpening: HrOpeningView = { ...sampleOpening, contractType: 'indefinite' };
    const indefiniteHireHtml = wrap(<HireCandidatePanel candidate={sampleCandidate} opening={indefiniteOpening} departments={[sampleDepartment]} />, 'en');
    expect(indefiniteHireHtml).not.toContain('hr-hire-term-months');
    expect(indefiniteHireHtml).not.toContain('hr-hire-fixed-term-hint');

    const lyHtml = wrap(<RecruitingBriefPanel candidateId={CANDIDATE_ID} candidateVersion={NOW_ISO} />, 'vi');
    expect(lyHtml).toContain(viMessages.hrRecruiting.ly.run);
    expect(lyHtml).toContain('hr-recruiting-ly-include-notes');
    expect(lyHtml).toContain(viMessages.hrRecruiting.ly.includeNotes);
    expect(lyHtml).not.toMatch(/checked=""[^>]*data-testid="hr-recruiting-ly-include-notes"|data-testid="hr-recruiting-ly-include-notes"[^>]*checked/);

    const lyHtmlEn = wrap(<RecruitingBriefPanel candidateId={CANDIDATE_ID} candidateVersion={NOW_ISO} />, 'en');
    expect(lyHtmlEn).toContain(en.hrRecruiting.ly.includeNotes);
    expect(lyHtmlEn).not.toMatch(/checked=""[^>]*data-testid="hr-recruiting-ly-include-notes"|data-testid="hr-recruiting-ly-include-notes"[^>]*checked/);
  });

  it('paginates >200 candidates deterministically and renders Load more + overflow indicator in VI and EN (#3447)', () => {
    expect(CANDIDATE_PAGE_SIZE).toBe(200);
    const makeRow = (n: number): HrCandidateView => ({
      ...sampleCandidate,
      id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      displayName: `Ứng viên ${n}`,
    });
    const page1 = Array.from({ length: 200 }, (_, i) => makeRow(i + 1));
    const page2 = Array.from({ length: 5 }, (_, i) => makeRow(201 + i));

    // Full 200-row page always yields the 200th candidate's ID as cursor (even if a separate cached opening count is stale at 200).
    expect(nextCandidateCursor(page1, 200)).toBe(page1[199]?.id);
    // Partial page (< pageSize) stops pagination cleanly.
    expect(nextCandidateCursor(page2, 200)).toBeUndefined();
    expect(nextCandidateCursor([], 200)).toBeUndefined();

    // flattenCandidatePages preserves order and deduplicates overlapping rows across pages.
    const flattened = flattenCandidatePages([page1, [page1[199]!, ...page2]]);
    expect(flattened).toHaveLength(205);
    expect(flattened.map((r) => r.id)).toEqual([...page1, ...page2].map((r) => r.id));

    // Seed TanStack Query cache with 200 loaded candidates (full first page, more available) and verify VI + EN controls.
    cache.current.setQueryData(['hr', 'recruiting', 'openings', 'list', { status: 'all', limit: 200 }], [
      { ...sampleOpening, candidateCount: 205 },
    ]);
    cache.current.setQueryData(['hr', 'recruiting', 'candidates', 'list', 'infinite', { limit: 200 }], {
      pages: [page1],
      pageParams: [undefined],
    });

    const htmlVi = wrap(<HrRecruitingPage />, 'vi');
    expect(htmlVi).toContain('hr-candidate-pagination');
    expect(htmlVi).toContain('hr-candidate-load-more');
    expect(htmlVi).toContain('Tải thêm ứng viên');
    expect(htmlVi).toContain('200');

    const htmlEn = wrap(<HrRecruitingPage />, 'en');
    expect(htmlEn).toContain('hr-candidate-load-more');
    expect(htmlEn).toContain('Load more candidates');
  });

  it('syncs late-arriving opening/department defaults while preserving dirty user edits in HireCandidatePanel', () => {
    const initialFromEmpty = {
      effectiveFrom: '2026-12-01',
      baseWage: '19000000',
      contractType: 'indefinite' as const,
      region: 'I' as const,
      payFunction: 'admin' as const,
      departmentId: '',
      jobTitle: 'Kế toán tổng hợp',
      termMonths: '',
      contractEndOn: '',
      allowDirectHire: false,
    };

    // No dirty fields yet: late-arriving opening + department populate untouched defaults.
    const arrivedDefaults = buildHireDefaults(sampleCandidate, sampleOpening);
    const afterLoad = mergeHireDraft(initialFromEmpty, new Set(), arrivedDefaults);
    expect(afterLoad).toMatchObject({
      contractType: 'fixed_term',
      region: 'II',
      payFunction: 'admin',
      departmentId: DEPT_ID,
      jobTitle: 'Kế toán tổng hợp',
    });

    // User edits baseWage and departmentId manually; opening then switches -> dirty fields stay intact while untouched ones update.
    const dirtyFields = new Set<'baseWage' | 'departmentId'>(['baseWage', 'departmentId']);
    const userEdited = { ...afterLoad, baseWage: '21500000', departmentId: '', termMonths: '12' };
    const newOpening: HrOpeningView = {
      ...sampleOpening,
      title: 'Kế toán trưởng',
      contractType: 'indefinite',
      region: 'III',
      payFunction: 'overhead',
    };
    const nextDefaults = buildHireDefaults(sampleCandidate, newOpening);
    const synced = mergeHireDraft(userEdited, dirtyFields, nextDefaults);
    expect(synced).toMatchObject({
      baseWage: '21500000',
      departmentId: '',
      termMonths: '12',
      contractType: 'indefinite',
      region: 'III',
      payFunction: 'overhead',
      jobTitle: 'Kế toán trưởng',
    });
  });

  it('supports interviewer picker defaults, exceptEventId scoping, assigned interviewer display, and standalone cancel button (#4299)', () => {
    expect(viMessages.commands.hr.recruiting.candidate.cancel_interview).toBeTruthy();
    expect(en.commands.hr.recruiting.candidate.cancel_interview).toBeTruthy();
    expect(viMessages.commands.hr.recruiting.interviewers.list).toBeTruthy();
    expect(en.commands.hr.recruiting.interviewers.list).toBeTruthy();

    const interviewers: HrInterviewerOption[] = [
      { userId: OWNER_USER_ID, displayName: 'Lê Hoàng Minh', role: 'owner' },
      { userId: MEMBER_USER_ID, displayName: 'Trần Thu Trang', role: 'member' },
    ];

    // Defaults to assigned interviewer when rescheduling, else current user, else first eligible interviewer.
    expect(resolveDefaultInterviewerId(sampleCandidate, interviewers, MEMBER_USER_ID)).toBe(OWNER_USER_ID);
    expect(resolveDefaultInterviewerId({ interviewerUserId: null }, interviewers, MEMBER_USER_ID)).toBe(MEMBER_USER_ID);
    expect(resolveDefaultInterviewerId({ interviewerUserId: '00000000-0000-7000-8000-000000000099' }, interviewers, MEMBER_USER_ID)).toBe(MEMBER_USER_ID);
    expect(resolveDefaultInterviewerId({ interviewerUserId: null }, interviewers, null)).toBe(OWNER_USER_ID);

    // Passes exceptEventId only when querying slots for the candidate's current active interviewer.
    expect(
      buildInterviewSlotsInput({
        candidate: sampleCandidate,
        interviewerUserId: OWNER_USER_ID,
        durationMinutes: 45,
      }),
    ).toEqual({
      interviewerUserId: OWNER_USER_ID,
      durationMinutes: 45,
      maxSlots: 8,
      exceptEventId: sampleCandidate.interviewEventId,
    });
    expect(
      buildInterviewSlotsInput({
        candidate: sampleCandidate,
        interviewerUserId: MEMBER_USER_ID,
        durationMinutes: 45,
      }),
    ).toEqual({
      interviewerUserId: MEMBER_USER_ID,
      durationMinutes: 45,
      maxSlots: 8,
    });

    // Shows assigned interviewer name and standalone cancel button (>= 44px min-h-11) with inline confirm box.
    const scheduledVi = wrap(<InterviewSchedulePanel candidate={sampleCandidate} />, 'vi');
    expect(scheduledVi).toContain('Lê Hoàng Minh');
    expect(scheduledVi).toContain('hr-interview-interviewer');
    expect(scheduledVi).toContain('hr-interview-cancel-ask');
    expect(scheduledVi).toContain(viMessages.hrRecruiting.interview.cancelAction);
    expect(scheduledVi).toContain('min-h-11');

    const confirmEn = wrap(<InterviewSchedulePanel candidate={sampleCandidate} initialConfirmCancel={true} />, 'en');
    expect(confirmEn).toContain('hr-interview-cancel-confirm-box');
    expect(confirmEn).toContain('hr-interview-cancel-confirm');
    expect(confirmEn).toContain('hr-interview-cancel-keep');
    expect(confirmEn).toContain(en.hrRecruiting.interview.cancelConfirmButton);

    // Unscheduled candidate does not show cancel button; hired candidate hides both toggle and cancel.
    const unscheduledHtml = wrap(
      <InterviewSchedulePanel
        candidate={{ ...sampleCandidate, interviewEventId: null, interviewStartsAt: null, interviewEndsAt: null, interviewerUserId: null, interviewerName: null }}
      />,
      'vi',
    );
    expect(unscheduledHtml).not.toContain('hr-interview-cancel-ask');
    expect(unscheduledHtml).toContain('hr-interview-toggle');

    const hiredHtml = wrap(<InterviewSchedulePanel candidate={{ ...sampleCandidate, stage: 'hired' }} />, 'vi');
    expect(hiredHtml).not.toContain('hr-interview-toggle');
    expect(hiredHtml).not.toContain('hr-interview-cancel-ask');

    // Open slot picker renders interviewer selector options and slots from cached interviewer list.
    cache.current.setQueryData(['me', 'get', {}], { userId: OWNER_USER_ID, email: 'owner@example.vn', displayName: 'Lê Hoàng Minh', orgs: [] });
    cache.current.setQueryData(['hr', 'recruiting', 'interviewers', 'list', {}], interviewers);
    cache.current.setQueryData(
      ['hr', 'recruiting', 'interviewSlots', buildInterviewSlotsInput({ candidate: sampleCandidate, interviewerUserId: OWNER_USER_ID, durationMinutes: 45 })],
      {
        timeZone: 'Asia/Ho_Chi_Minh',
        hoursSaved: true,
        slots: [{ startIso: '2026-11-22T02:00:00.000Z', endIso: '2026-11-22T02:45:00.000Z' }],
      },
    );
    const pickerVi = wrap(<InterviewSchedulePanel candidate={sampleCandidate} initialOpen={true} />, 'vi');
    expect(pickerVi).toContain('hr-interview-interviewer-select');
    expect(pickerVi).toContain('Lê Hoàng Minh (Chủ sở hữu)');
    expect(pickerVi).toContain('Trần Thu Trang (Thành viên)');
    expect(pickerVi).toContain('hr-interview-slot');

    const pickerEn = wrap(<InterviewSchedulePanel candidate={sampleCandidate} initialOpen={true} />, 'en');
    expect(pickerEn).toContain('Lê Hoàng Minh (Owner)');
    expect(pickerEn).toContain('Trần Thu Trang (Member)');
  });

  it('renders Stage 5D CV intake proposal, funnel BI analytics, candidate source selector, and Engage invite draft in VI and EN (#4446)', () => {
    expect(HR_CANDIDATE_SOURCES).toEqual(['direct', 'zalo_oa', 'facebook', 'referral', 'job_board', 'other']);
    expect(viMessages.commands.hr.recruiting.analytics).toBeTruthy();
    expect(en.commands.hr.recruiting.analytics).toBeTruthy();
    expect(viMessages.commands.hr.recruiting.cv_extract.request).toBeTruthy();
    expect(en.commands.hr.recruiting.cv_extract.request).toBeTruthy();
    expect(viMessages.commands.hr.recruiting.invite_draft.context).toBeTruthy();
    expect(en.commands.hr.recruiting.invite_draft.context).toBeTruthy();
    for (const code of ['HR_CV_EXTRACT_FAILED', 'HR_CV_EMPTY_TEXT', 'HR_CV_JOB_NOT_FOUND', 'HR_CV_INTEGRITY'] as const) {
      expect(viMessages.kernelErrors.codes[code]).toBeTruthy();
      expect(en.kernelErrors.codes[code]).toBeTruthy();
    }

    const cvIntakeVi = wrap(<CvIntakePanel openings={[sampleOpening]} defaultOpeningId={OPENING_ID} onDraftReady={() => undefined} onClose={() => undefined} />, 'vi');
    expect(cvIntakeVi).toContain('hr-cv-intake-panel');
    expect(cvIntakeVi).toContain('hr-cv-file-input');
    expect(cvIntakeVi).toContain('hr-cv-extract-submit');
    expect(cvIntakeVi).toContain('max-md:[&amp;_select]:min-h-11');
    expect(cvIntakeVi).toContain(viMessages.hrRecruiting.cvExtract.proposalBadge);

    const sampleCvDraft: HrCvExtractDraft = {
      openingId: OPENING_ID,
      openingTitle: sampleOpening.title,
      displayName: 'Trần Bảo Ngọc',
      email: 'ngoc@example.vn',
      phone: '0912345678',
      yearsExperience: 5,
      matchedSkills: ['MISA', 'Excel'],
      suggestedSource: 'zalo_oa',
      notes: 'Tóm tắt CV: 5 năm kinh nghiệm',
      aiSummary: null,
      sourceKind: 'pdf_text',
      extractedChars: 340,
      textPreview: 'Trần Bảo Ngọc',
      ai: { ok: false, reason: 'ai_off' },
      tainted: true,
      draftKind: 'proposal',
      autoSaved: false,
      autonomousDecision: 'none',
    };
    const prefilledVi = wrap(<CandidateForm cvDraft={sampleCvDraft} openings={[sampleOpening]} onClose={() => undefined} />, 'vi');
    expect(prefilledVi).toContain('hr-cv-proposal-banner');
    expect(prefilledVi).toContain('Trần Bảo Ngọc');
    expect(prefilledVi).toContain('ngoc@example.vn');
    expect(prefilledVi).toContain('0912345678');
    expect(prefilledVi).toContain('hr-candidate-source');
    expect(prefilledVi).toContain(viMessages.hrRecruiting.cvExtract.status.ai_off);

    const noOpeningDraft: HrCvExtractDraft = { ...sampleCvDraft, openingId: null, openingTitle: null };
    const noOpeningVi = wrap(<CandidateForm cvDraft={noOpeningDraft} defaultOpeningId={OPENING_ID} openings={[sampleOpening]} onClose={() => undefined} />, 'vi');
    expect(noOpeningVi).toMatch(/<option\b[^>]*(?:\bvalue=""[^>]*\bselected\b|\bselected\b[^>]*\bvalue="")/);
    expect(noOpeningVi).not.toMatch(new RegExp(`<option\\b[^>]*\\bvalue="${OPENING_ID}"[^>]*\\bselected\\b`));

    // Unverified AI summary prose renders inside its own explicitly labeled proposal block without replacing deterministic notes.
    const aiSummaryDraft: HrCvExtractDraft = {
      ...sampleCvDraft,
      aiSummary: 'Ly đề xuất: ứng viên từng triển khai MISA.',
    };
    const withAiSummaryVi = wrap(<CandidateForm cvDraft={aiSummaryDraft} openings={[sampleOpening]} onClose={() => undefined} />, 'vi');
    expect(withAiSummaryVi).toContain('hr-cv-ai-summary-proposal');
    expect(withAiSummaryVi).toContain('hr-cv-ai-summary-input');
    expect(withAiSummaryVi).toContain('hr-cv-ai-summary-copy');
    expect(withAiSummaryVi).toContain(viMessages.hrRecruiting.cvExtract.aiSummaryLabel);
    expect(withAiSummaryVi).toContain('Ly đề xuất: ứng viên từng triển khai MISA.');
    expect(withAiSummaryVi).toContain('Tóm tắt CV: 5 năm kinh nghiệm');

    const analyticsSample: HrRecruitingAnalyticsResult = {
      legalEntityId: ENTITY_ID,
      openingId: null,
      from: null,
      to: null,
      llmCost: 0,
      totalCandidates: 12,
      activeCandidates: 7,
      hiredCount: 3,
      rejectedCount: 2,
      erasedExcludedCount: 1,
      timeToHire: { sampleSize: 3, avgDays: '6.5', medianDays: '5.0' },
      stages: HR_CANDIDATE_STAGES.map((stage) => ({ stage, count: 2, sharePct: '16.7' })),
      funnel: [
        { fromStage: 'applied', toStage: 'screening', enteredFromCount: 12, reachedToCount: 8, conversionPct: '66.7', dropOffPct: '33.3' },
      ],
      sources: [
        { source: 'zalo_oa', totalCount: 5, activeCount: 2, hiredCount: 2, rejectedCount: 1, hireRatePct: '40.0', avgTimeToHireDays: '5.0' },
      ],
    };
    const analyticsVi = wrap(<FunnelAnalyticsSection analyticsOverride={analyticsSample} />, 'vi');
    expect(analyticsVi).toContain('hr-recruiting-analytics');
    expect(analyticsVi).toContain('hr-analytics-total');
    expect(analyticsVi).toContain('6.5');
    expect(analyticsVi).toContain('5.0');
    expect(analyticsVi).toContain('hr-analytics-funnel-row');
    expect(analyticsVi).toContain('hr-analytics-source-row');

    const analyticsEn = wrap(<FunnelAnalyticsSection analyticsOverride={analyticsSample} />, 'en');
    expect(analyticsEn).toContain(en.hrRecruiting.analytics.title);
    expect(analyticsEn).toContain(en.hrRecruiting.sources.zalo_oa);

    const inviteDraftSample: HrInviteDraftResult = {
      candidateId: CANDIDATE_ID,
      channel: 'zalo_oa',
      candidateLabel: 'Nguyễn Minh Thư',
      openingTitle: 'Kế toán tổng hợp',
      interviewerUserId: OWNER_USER_ID,
      interviewerName: 'Lê Hoàng Minh',
      slots: [{ startIso: '2026-11-25T02:00:00.000Z', endIso: '2026-11-25T03:00:00.000Z' }],
      message: 'Chào Nguyễn Minh Thư, mời bạn phỏng vấn vị trí Kế toán tổng hợp qua Zalo OA.',
      autoSent: false,
      humanSendRequired: true,
      ai: { ok: false, reason: 'template' },
    };
    const engageVi = wrap(<EngageInvitePanel candidate={sampleCandidate} initialDraft={inviteDraftSample} />, 'vi');
    expect(engageVi).toContain('hr-engage-invite-panel');
    expect(engageVi).toContain('hr-engage-channel');
    expect(engageVi).toContain('hr-engage-interviewer');
    expect(engageVi).toContain('hr-engage-draft-message');
    expect(engageVi).toContain('hr-engage-draft-copy');
    expect(engageVi).toContain(viMessages.hrRecruiting.engageInvite.manualNotice);

    // Changing interviewer clears stale draft/message/copied; keeping same interviewer preserves manual edits.
    const unchanged = applyInviteInterviewerChange(
      { interviewerUserId: OWNER_USER_ID, draft: inviteDraftSample, messageText: 'Manual edit kept', copied: true },
      OWNER_USER_ID,
    );
    expect(unchanged.changed).toBe(false);
    expect(unchanged.draft).toBe(inviteDraftSample);
    expect(unchanged.messageText).toBe('Manual edit kept');
    expect(unchanged.copied).toBe(true);

    const switched = applyInviteInterviewerChange(
      { interviewerUserId: OWNER_USER_ID, draft: inviteDraftSample, messageText: 'Manual edit kept', copied: true },
      MEMBER_USER_ID,
    );
    expect(switched).toEqual({
      changed: true,
      interviewerUserId: MEMBER_USER_ID,
      draft: null,
      messageText: '',
      copied: false,
    });

    // Changing channel also clears stale draft/message/copied while keeping manual edits when unchanged.
    const channelUnchanged = applyInviteChannelChange(
      { channel: 'zalo_oa', draft: inviteDraftSample, messageText: 'Manual edit kept', copied: true },
      'zalo_oa',
    );
    expect(channelUnchanged.changed).toBe(false);
    expect(channelUnchanged.draft).toBe(inviteDraftSample);
    expect(channelUnchanged.messageText).toBe('Manual edit kept');
    expect(channelUnchanged.copied).toBe(true);

    const channelSwitched = applyInviteChannelChange(
      { channel: 'zalo_oa', draft: inviteDraftSample, messageText: 'Manual edit kept', copied: true },
      'facebook',
    );
    expect(channelSwitched).toEqual({
      changed: true,
      channel: 'facebook',
      draft: null,
      messageText: '',
      copied: false,
    });

    const keyA = buildInviteSelectionKey('ctx-1', 'zalo_oa', OWNER_USER_ID, 'vi');
    const keyB = buildInviteSelectionKey('ctx-1', 'zalo_oa', MEMBER_USER_ID, 'vi');
    expect(shouldAcceptInviteDraftResponse({ mounted: true, selectionKey: keyA, requestSeq: 1 }, { selectionKey: keyA, requestSeq: 1 })).toBe(true);
    expect(shouldAcceptInviteDraftResponse({ mounted: true, selectionKey: keyB, requestSeq: 2 }, { selectionKey: keyA, requestSeq: 1 })).toBe(false);
    expect(shouldAcceptInviteDraftResponse({ mounted: true, selectionKey: keyA, requestSeq: 3 }, { selectionKey: keyA, requestSeq: 1 })).toBe(false);
    expect(shouldAcceptInviteDraftResponse({ mounted: false, selectionKey: keyA, requestSeq: 1 }, { selectionKey: keyA, requestSeq: 1 })).toBe(false);
  });
});
