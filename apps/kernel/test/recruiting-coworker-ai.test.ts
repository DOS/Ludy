// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { InboxReader, type RecruitingBriefAiReason, type RecruitingBriefResult } from '@ludy/agent';
import { DomainError, sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { hrCvBlobKey, type HrRecruitingBriefSnapshot } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { handleHrCvExtractPoll, handleHrCvExtractUpload } from '../src/hr-cv-http.ts';
import { generateRecruitingBrief, proposeCvDraftWithLy, type RecruitingBriefPorts } from '../src/recruiting-coworker-ai.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CANDIDATE_ID = '00000000-0000-7000-8000-000000000003';

function makeSnapshot(notes: string[]): HrRecruitingBriefSnapshot {
  return {
    candidateId: CANDIDATE_ID,
    input: {
      language: 'vi',
      openingTitle: 'Kế toán tổng hợp',
      departmentName: 'Phòng Kế toán',
      stage: 'screening',
      yearsExperience: 4,
      matchedSkills: ['MISA', 'Excel'],
      missingSkills: ['Thuế GTGT'],
      skillsRequiredCount: 3,
      expectedWage: '18000000',
      budgetMinWage: '15000000',
      budgetMaxWage: '22000000',
      agreedWage: null,
      startDate: null,
      hasScheduledInterview: false,
      notes,
    },
    forbidden: ['Nguyễn Minh Thư', 'thu@example.com', '0909123456'],
  };
}

describe('generateRecruitingBrief (#3447 Items 6 & 7)', () => {
  it('excludes candidate free-text notes by default and forwards them only when includeNotes === true', async () => {
    const readCalls: Array<{ candidateId: string; lang: 'vi' | 'en'; includeNotes: boolean }> = [];
    const auditCalls: Array<{ candidateId: string; aiReason: RecruitingBriefAiReason; includeNotes: boolean }> = [];
    const seenNotes: string[][] = [];

    const ports: RecruitingBriefPorts = {
      read: async (candidateId, lang, includeNotes) => {
        readCalls.push({ candidateId, lang, includeNotes });
        // Simulate raw notes present in snapshot to verify orchestrator defense-in-depth as well.
        return makeSnapshot(['Đã làm quyết toán thuế cho doanh nghiệp SME.']);
      },
      record: async (candidateId, aiReason, includeNotes) => {
        auditCalls.push({ candidateId, aiReason, includeNotes });
      },
    };

    const recruitingBrief = vi.fn(async (input: { notes?: readonly string[] }): Promise<RecruitingBriefResult> => {
      seenNotes.push([...(input.notes ?? [])]);
      return {
        readiness: {
          stage: 'screening',
          flags: ['within_budget', 'missing_interview', 'skills_gap'],
          wageComparison: 'within_budget',
          wageVariance: '0',
          skillsMatchedCount: 2,
          skillsRequiredCount: 3,
          missingSkillsCount: 1,
          hasNotes: (input.notes ?? []).length > 0,
          focusQuestions: [],
        },
        summary: 'Hồ sơ C1 phù hợp 2/3 kỹ năng.',
        strengths: ['Có 4 năm kinh nghiệm.'],
        risks: ['Thiếu kỹ năng Thuế GTGT.'],
        interviewQuestions: ['Câu hỏi 1?', 'Câu hỏi 2?', 'Câu hỏi 3?'],
        ai: { ok: true, reason: 'ok' },
      };
    });

    const ai = { reader: { recruitingBrief }, budget: new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 }) };

    // 1. Default omitted includeNotes -> excluded.
    const defaultRes = await generateRecruitingBrief(ai, ports, ORG_ID, USER_ID, { candidateId: CANDIDATE_ID, lang: 'vi' });
    expect(defaultRes.ai).toEqual({ ok: true, reason: 'ok' });
    expect(defaultRes.readiness.hasNotes).toBe(false);
    expect(seenNotes[0]).toEqual([]);
    expect(readCalls[0]).toEqual({ candidateId: CANDIDATE_ID, lang: 'vi', includeNotes: false });
    expect(auditCalls[0]).toEqual({ candidateId: CANDIDATE_ID, aiReason: 'ok', includeNotes: false });

    // 2. Explicit includeNotes: true -> included.
    const optInRes = await generateRecruitingBrief(ai, ports, ORG_ID, USER_ID, {
      candidateId: CANDIDATE_ID,
      lang: 'vi',
      includeNotes: true,
    });
    expect(optInRes.ai).toEqual({ ok: true, reason: 'ok' });
    expect(optInRes.readiness.hasNotes).toBe(true);
    expect(seenNotes[1]).toEqual(['Đã làm quyết toán thuế cho doanh nghiệp SME.']);
    expect(readCalls[1]).toEqual({ candidateId: CANDIDATE_ID, lang: 'vi', includeNotes: true });
    expect(auditCalls[1]).toEqual({ candidateId: CANDIDATE_ID, aiReason: 'ok', includeNotes: true });
  });

  it('degrades cleanly to deterministic brief instead of throwing 429 when per-minute DraftBudget or provider rate limit is hit', async () => {
    const auditReasons: RecruitingBriefAiReason[] = [];
    const ports: RecruitingBriefPorts = {
      read: async (_id, _lang, includeNotes) => makeSnapshot(includeNotes ? ['Ghi chú sàng lọc'] : []),
      record: async (_id, aiReason) => {
        auditReasons.push(aiReason);
      },
    };

    const recruitingBrief = vi.fn(async (): Promise<RecruitingBriefResult> => ({
      readiness: {
        stage: 'screening',
        flags: ['within_budget', 'missing_interview', 'skills_gap'],
        wageComparison: 'within_budget',
        wageVariance: '0',
        skillsMatchedCount: 2,
        skillsRequiredCount: 3,
        missingSkillsCount: 1,
        hasNotes: false,
        focusQuestions: [],
      },
      summary: 'AI tóm tắt C1.',
      strengths: [],
      risks: [],
      interviewQuestions: ['Q1?', 'Q2?', 'Q3?'],
      ai: { ok: true, reason: 'ok' },
    }));

    const nowMs = 1_700_000_000_000;
    const budget = new DraftBudget({ perUserPerMinute: 2, perOrgPerMinute: 3, now: () => nowMs });
    const ai = { reader: { recruitingBrief }, budget };

    const first = await generateRecruitingBrief(ai, ports, ORG_ID, USER_ID, { candidateId: CANDIDATE_ID, lang: 'vi' });
    const second = await generateRecruitingBrief(ai, ports, ORG_ID, USER_ID, { candidateId: CANDIDATE_ID, lang: 'vi' });
    expect(first.ai).toEqual({ ok: true, reason: 'ok' });
    expect(second.ai).toEqual({ ok: true, reason: 'ok' });
    expect(recruitingBrief).toHaveBeenCalledTimes(2);

    // 3rd call in the same minute exceeds perUserPerMinute -> returns deterministic fallback (zero model call, no 429 throw).
    const third = await generateRecruitingBrief(ai, ports, ORG_ID, USER_ID, { candidateId: CANDIDATE_ID, lang: 'vi' });
    expect(recruitingBrief).toHaveBeenCalledTimes(2);
    expect(third.ai).toEqual({ ok: false, reason: 'rate_limited' });
    expect(third.readiness.skillsMatchedCount).toBe(2);
    expect(third.interviewQuestions.length).toBeGreaterThanOrEqual(3);
    expect(auditReasons.at(-1)).toBe('rate_limited');

    // Real InboxReader receiving upstream provider HTTP 429 also degrades to rate_limited deterministic brief and records rate_limited.
    const realReader = new InboxReader(
      { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'test', model: 'test', maxRetries: 0 },
      {
        recruitingBrief: async () => {
          throw Object.assign(new Error('Too many requests'), { statusCode: 429 });
        },
      },
    );
    const providerLimited = await generateRecruitingBrief(
      { reader: realReader, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
      ports,
      ORG_ID,
      USER_ID,
      { candidateId: CANDIDATE_ID, lang: 'vi' },
    );
    expect(providerLimited.ai).toEqual({ ok: false, reason: 'rate_limited' });
    expect(auditReasons.at(-1)).toBe('rate_limited');

    // Downstream RATE_LIMITED DomainError also degrades cleanly to rate_limited deterministic brief.
    const rateThrowingAi = {
      reader: {
        recruitingBrief: vi.fn(async () => {
          throw new DomainError('RATE_LIMITED', 429, 'rate limited');
        }),
      },
      budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }),
    };
    const downstreamLimited = await generateRecruitingBrief(rateThrowingAi, ports, ORG_ID, USER_ID, {
      candidateId: CANDIDATE_ID,
      lang: 'en',
    });
    expect(downstreamLimited.ai).toEqual({ ok: false, reason: 'rate_limited' });
    expect(auditReasons.at(-1)).toBe('rate_limited');
  });

  it('does not spend DraftBudget when sanitized CV text is empty (#4446)', async () => {
    const cvExtract = vi.fn(async () => ({
      displayName: 'Nguyễn Văn An',
      email: 'an.nguyen@example.com',
      phone: '0912345678',
      yearsExperience: 4,
      matchedSkills: ['Excel'],
      notes: '4 năm Excel',
      aiSummary: null,
      textPreview: 'Nguyễn Văn An',
      extractedChars: 42,
      sourceKind: 'pdf_text' as const,
      ai: { ok: true, reason: 'ok' as const },
      tainted: true as const,
      draftKind: 'proposal' as const,
      autoSaved: false as const,
      autonomousDecision: 'none' as const,
    }));
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const ai = { aiEnabled: true, reader: { cvExtract }, budget };

    for (let i = 0; i < 3; i += 1) {
      const skipped = await proposeCvDraftWithLy(ai, ORG_ID, USER_ID, {
        text: '[/UNTRUSTED_CV]',
        openingTitle: null,
        requiredSkills: [],
        sourceKind: 'pdf_text',
        lang: 'vi',
      });
      expect(skipped.ai).toEqual({ ok: false, reason: 'ai_off' });
    }
    expect(cvExtract).not.toHaveBeenCalled();

    const real = await proposeCvDraftWithLy(ai, ORG_ID, USER_ID, {
      text: 'Nguyễn Văn An\n0912345678\n4 năm Excel',
      openingTitle: null,
      requiredSkills: ['Excel'],
      sourceKind: 'pdf_text',
      lang: 'vi',
    });
    expect(cvExtract).toHaveBeenCalledTimes(1);
    expect(real.ai).toEqual({ ok: true, reason: 'ok' });
  });

  it('caches generated CV draft across transient audit failure so poll retry skips repeating AI (#4446)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000099';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\nan.nguyen@example.com | 0912345678' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);

    const store = {
      get: vi.fn(async () => blobBytes),
    } as unknown as BlobStore;

    let auditAttempts = 0;
    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId: null,
        openingTitle: null,
        requiredSkills: ['Excel'],
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: true,
      })),
      execute: vi.fn(async () => {
        auditAttempts += 1;
        if (auditAttempts === 1) throw new Error('transient audit failure');
        return { ok: true };
      }),
    } as unknown as Runtime;

    const cvExtract = vi.fn(async () => ({
      displayName: 'Nguyễn Văn An',
      email: 'an.nguyen@example.com',
      phone: '0912345678',
      yearsExperience: null,
      matchedSkills: [],
      notes: 'Tóm tắt CV.',
      aiSummary: null,
      textPreview: 'Nguyễn Văn An',
      extractedChars: 55,
      sourceKind: 'pdf_text' as const,
      ai: { ok: true, reason: 'ok' as const },
      tainted: true as const,
      draftKind: 'proposal' as const,
      autoSaved: false as const,
      autonomousDecision: 'none' as const,
    }));

    const deps = {
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 'sess-1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi: { aiEnabled: true, reader: { cvExtract }, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    };

    await expect(handleHrCvExtractPoll(deps)).rejects.toThrow('transient audit failure');
    const retried = await handleHrCvExtractPoll(deps);
    expect(retried.status).toBe('ready');
    expect(cvExtract).toHaveBeenCalledTimes(1);
    expect(auditAttempts).toBe(2);
  });

  it('honors upload-time useAi=false opt-out even when poll omits useAi (#4446)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000101';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\nan.nguyen@example.com | 0912345678' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);
    const store = { get: vi.fn(async () => blobBytes) } as unknown as BlobStore;
    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId: null,
        openingTitle: null,
        requiredSkills: [],
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: false,
      })),
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as Runtime;
    const cvExtract = vi.fn();

    const res = await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 'sess-1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi: { aiEnabled: true, reader: { cvExtract }, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(res.status).toBe('ready');
    if (res.status === 'ready') {
      expect(res.draft.ai).toEqual({ ok: false, reason: 'ai_off' });
    }
    expect(cvExtract).not.toHaveBeenCalled();
  });

  it('invalidates finalized CV cache when opening title or requiredSkills change and isolates per-user rate_limited (#4446)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000102';
    const openingId = '00000000-0000-7000-8000-000000000202';
    const otherUserId = '00000000-0000-7000-8000-000000000099';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\nan.nguyen@example.com | 0912345678\nExcel Python SQL' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);
    const store = { get: vi.fn(async () => blobBytes) } as unknown as BlobStore;

    let currentTitle = 'Excel Specialist';
    let currentSkills = ['Excel', 'SQL'];
    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId,
        openingTitle: currentTitle,
        requiredSkills: currentSkills,
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: true,
      })),
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as Runtime;

    const cvExtract = vi.fn(async (input: { openingTitle?: string | null; requiredSkills?: readonly string[] }) => ({
      displayName: 'Nguyễn Văn An',
      email: 'an.nguyen@example.com',
      phone: '0912345678',
      yearsExperience: 3,
      matchedSkills: [...(input.requiredSkills ?? [])],
      notes: `Matched ${input.openingTitle ?? ''}`,
      aiSummary: null,
      textPreview: 'Nguyễn Văn An',
      extractedChars: 64,
      sourceKind: 'pdf_text' as const,
      ai: { ok: true, reason: 'ok' as const },
      tainted: true as const,
      draftKind: 'proposal' as const,
      autoSaved: false as const,
      autonomousDecision: 'none' as const,
    }));

    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const cvAi = { aiEnabled: true, reader: { cvExtract }, budget };

    const first = await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(first.status).toBe('ready');
    if (first.status === 'ready') expect(first.draft.matchedSkills).toEqual(['Excel', 'SQL']);

    // Same skills reordered -> hits cache without another AI call.
    currentSkills = ['SQL', 'Excel'];
    const reordered = await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(reordered.status).toBe('ready');
    if (reordered.status === 'ready') {
      expect(reordered.draft.ai).toEqual({ ok: true, reason: 'ok' });
    }
    expect(cvExtract).toHaveBeenCalledTimes(1);

    // Opening changes to Python -> USER_ID hits perUserPerMinute=1 rate_limited, then otherUserId polls same jobId and gets its own AI call.
    currentTitle = 'Python Specialist';
    currentSkills = ['Python'];
    const rateLimited = await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(rateLimited.status).toBe('ready');
    if (rateLimited.status === 'ready') {
      expect(rateLimited.draft.ai).toEqual({ ok: false, reason: 'rate_limited' });
    }

    const otherManager = await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: otherUserId, sessionId: 's2', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(otherManager.status).toBe('ready');
    if (otherManager.status === 'ready') {
      expect(otherManager.draft.ai).toEqual({ ok: true, reason: 'ok' });
      expect(otherManager.draft.openingTitle).toBe('Python Specialist');
      expect(otherManager.draft.matchedSkills).toEqual(['Python']);
    }
    expect(cvExtract).toHaveBeenCalledTimes(2);
  });

  it('returns pending with admitted jobId when inline upload finalization hits transient failure, while rethrowing 4xx DomainError (#4446)', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
    const mkUploadReq = () => {
      const form = new FormData();
      form.append('file', new File([pdfBytes], 'cv.pdf', { type: 'application/pdf' }));
      return new Request('http://localhost/api/hr/recruiting/cv-extract', { method: 'POST', body: form });
    };

    const resultBytes = new TextEncoder().encode(
      JSON.stringify({ jobId: 'unused', ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\nan.nguyen@example.com' }),
    );
    const resultSha256 = sha256Hex(resultBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);

    const makeRuntime = (auditBehavior: 'transient' | 'clientError') =>
      ({
        query: vi.fn(async (name: string, input: { jobId?: string }) => {
          if (name === 'hr.recruiting.cv_extract.authorize') return { legalEntityId: 'e1', openingId: null };
          return {
            jobId: input.jobId ?? '00000000-0000-7000-8000-000000000999',
            legalEntityId: 'e1',
            openingId: null,
            openingTitle: null,
            requiredSkills: [],
            storageKey: resultKey,
            resultKey,
            resultSha256,
            failedCode: null,
            useAi: true,
          };
        }),
        execute: vi.fn(async (name: string) => {
          if (name === 'hr.recruiting.cv_extract.request') {
            return {
              jobId: '00000000-0000-7000-8000-000000000999',
              legalEntityId: 'e1',
              openingId: null,
              openingTitle: null,
              requiredSkills: [],
              storageKey: resultKey,
              resultKey: null,
              resultSha256: null,
              failedCode: null,
              useAi: true,
            };
          }
          if (auditBehavior === 'clientError') {
            throw new DomainError('VALIDATION', 422, 'invalid audit');
          }
          throw new Error('transient DB error');
        }),
      }) as unknown as Runtime;

    const store = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => resultBytes),
    } as unknown as BlobStore;

    const pendingRes = await handleHrCvExtractUpload({
      runtime: makeRuntime('transient'),
      store,
      user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractUpload>[0]['user'],
      orgId: ORG_ID,
      req: mkUploadReq(),
      cvAi: { aiEnabled: false, reader: null, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
      waitMs: 500,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(pendingRes.status).toBe('pending');
    expect(pendingRes.jobId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      handleHrCvExtractUpload({
        runtime: makeRuntime('clientError'),
        store,
        user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractUpload>[0]['user'],
        orgId: ORG_ID,
        req: mkUploadReq(),
        cvAi: { aiEnabled: false, reader: null, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
        waitMs: 500,
        runInAiScope: <T>(fn: () => Promise<T>) => fn(),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION' });
  });

  it('does not let a concurrent user A in-flight rate_limited denial settle user B (#4446)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000103';
    const userB = '00000000-0000-7000-8000-000000000098';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\n0912345678\nExcel' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);

    let releaseBlobRead!: () => void;
    const blobGate = new Promise<void>((resolve) => {
      releaseBlobRead = resolve;
    });
    const store = {
      get: vi.fn(async () => {
        await blobGate;
        return blobBytes;
      }),
    } as unknown as BlobStore;

    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId: null,
        openingTitle: null,
        requiredSkills: ['Excel'],
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: true,
      })),
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as Runtime;

    const cvExtract = vi.fn(async () => ({
      displayName: 'Nguyễn Văn An',
      email: null,
      phone: '0912345678',
      yearsExperience: null,
      matchedSkills: ['Excel'],
      notes: 'Tóm tắt CV.',
      aiSummary: null,
      textPreview: 'Nguyễn Văn An',
      extractedChars: 35,
      sourceKind: 'pdf_text' as const,
      ai: { ok: true, reason: 'ok' as const },
      tainted: true as const,
      draftKind: 'proposal' as const,
      autoSaved: false as const,
      autonomousDecision: 'none' as const,
    }));

    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    // Exhaust USER_ID personal budget first.
    const exhaustedTicket = budget.take(ORG_ID, USER_ID);
    expect(exhaustedTicket.allowed).toBe(true);
    if (exhaustedTicket.allowed) exhaustedTicket.release();
    expect(budget.take(ORG_ID, USER_ID).allowed).toBe(false);

    const cvAi = { aiEnabled: true, reader: { cvExtract }, budget };
    const reqA = handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 'sa', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    const reqB = handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: userB, sessionId: 'sb', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    releaseBlobRead();
    const [resA, resB] = await Promise.all([reqA, reqB]);
    expect(resA.status).toBe('ready');
    expect(resB.status).toBe('ready');
    if (resA.status === 'ready') expect(resA.draft.ai).toEqual({ ok: false, reason: 'rate_limited' });
    if (resB.status === 'ready') expect(resB.draft.ai).toEqual({ ok: true, reason: 'ok' });
    expect(cvExtract).toHaveBeenCalledTimes(1);
  });

  it('audits Manager B on shared-cache hits without repeating AI and rechecks per-user inflight after shared rate_limited (#4487)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000104';
    const userB = '00000000-0000-7000-8000-000000000097';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\n0912345678\nExcel' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);
    const store = { get: vi.fn(async () => blobBytes) } as unknown as BlobStore;

    const auditedActors: string[] = [];
    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId: null,
        openingTitle: null,
        requiredSkills: ['Excel'],
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: true,
      })),
      execute: vi.fn(async (_cmd: string, _in: unknown, opts: { actor?: { userId?: string } }) => {
        auditedActors.push(opts?.actor?.userId ?? 'unknown');
        return { ok: true };
      }),
    } as unknown as Runtime;

    const cvExtract = vi.fn(async () => ({
      displayName: 'Nguyễn Văn An',
      email: null,
      phone: '0912345678',
      yearsExperience: null,
      matchedSkills: ['Excel'],
      notes: '4 năm Excel',
      aiSummary: null,
      textPreview: 'Nguyễn Văn An',
      extractedChars: 35,
      sourceKind: 'pdf_text' as const,
      ai: { ok: true, reason: 'ok' as const },
      tainted: true as const,
      draftKind: 'proposal' as const,
      autoSaved: false as const,
      autonomousDecision: 'none' as const,
    }));

    const cvAi = { aiEnabled: true, reader: { cvExtract }, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) };
    await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 'sa', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    // Manager A repeat poll does not emit a second audit row.
    await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: USER_ID, sessionId: 'sa', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    // Manager B hitting Manager A's cached draft gets Manager B's own audit row with zero new AI calls.
    await handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: userB, sessionId: 'sb', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(cvExtract).toHaveBeenCalledTimes(1);
    expect(auditedActors).toEqual([USER_ID, userB]);

    // Inline upload returns pending when cvExtractContextQuery transiently errors after job admission.
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
    const form = new FormData();
    form.append('file', new File([pdfBytes], 'cv.pdf', { type: 'application/pdf' }));
    const req = new Request('http://localhost/api/hr/recruiting/cv-extract', { method: 'POST', body: form });
    const inlineRuntime = {
      query: vi.fn(async (name: string) => {
        if (name === 'hr.recruiting.cv_extract.authorize') return { legalEntityId: 'e1', openingId: null };
        throw new Error('transient DB error in context poll');
      }),
      execute: vi.fn(async () => ({
        jobId: '00000000-0000-7000-8000-000000000998',
        legalEntityId: 'e1',
        openingId: null,
        openingTitle: null,
        requiredSkills: [],
        storageKey: resultKey,
        resultKey: null,
        resultSha256: null,
        failedCode: null,
        useAi: true,
      })),
    } as unknown as Runtime;
    const inlinePending = await handleHrCvExtractUpload({
      runtime: inlineRuntime,
      store: { put: vi.fn(async () => undefined), get: vi.fn(async () => blobBytes) } as unknown as BlobStore,
      user: { userId: USER_ID, sessionId: 's1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractUpload>[0]['user'],
      orgId: ORG_ID,
      req,
      cvAi: { aiEnabled: false, reader: null, budget: new DraftBudget({ perUserPerMinute: 5, perOrgPerMinute: 10 }) },
      waitMs: 500,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    expect(inlinePending.status).toBe('pending');
  });

  it('deduplicates concurrent userB polls via retryInflight after sharedInflight resolves rate_limited (#4487)', async () => {
    const jobId = '00000000-0000-7000-8000-000000000105';
    const userA = '00000000-0000-7000-8000-000000000091';
    const userB = '00000000-0000-7000-8000-000000000092';
    const blobBytes = new TextEncoder().encode(
      JSON.stringify({ jobId, ok: true, kind: 'pdf_text', text: 'Nguyễn Văn An\n0912345678\nExcel' }),
    );
    const resultSha256 = sha256Hex(blobBytes);
    const resultKey = hrCvBlobKey(ORG_ID, resultSha256);
    const store = { get: vi.fn(async () => blobBytes) } as unknown as BlobStore;
    const fakeRuntime = {
      query: vi.fn(async () => ({
        jobId,
        legalEntityId: '00000000-0000-7000-8000-000000000010',
        openingId: null,
        openingTitle: null,
        requiredSkills: ['Excel'],
        storageKey: resultKey,
        resultKey,
        resultSha256,
        failedCode: null,
        useAi: true,
      })),
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as Runtime;

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let callCount = 0;
    const cvExtract = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await gateA;
        return {
          displayName: 'Nguyễn Văn An',
          email: null,
          phone: '0912345678',
          yearsExperience: null,
          matchedSkills: ['Excel'],
          notes: 'Kỹ năng khớp: Excel',
          aiSummary: null,
          textPreview: 'Nguyễn Văn An',
          extractedChars: 30,
          sourceKind: 'pdf_text' as const,
          ai: { ok: false, reason: 'rate_limited' as const },
          tainted: true as const,
          draftKind: 'proposal' as const,
          autoSaved: false as const,
          autonomousDecision: 'none' as const,
        };
      }
      await gateB;
      return {
        displayName: 'Nguyễn Văn An',
        email: null,
        phone: '0912345678',
        yearsExperience: null,
        matchedSkills: ['Excel'],
        notes: 'Kỹ năng khớp: Excel',
        aiSummary: null,
        textPreview: 'Nguyễn Văn An',
        extractedChars: 30,
        sourceKind: 'pdf_text' as const,
        ai: { ok: true, reason: 'ok' as const },
        tainted: true as const,
        draftKind: 'proposal' as const,
        autoSaved: false as const,
        autonomousDecision: 'none' as const,
      };
    });
    const cvAi = {
      aiEnabled: true,
      reader: { cvExtract } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['cvAi']['reader'],
      budget: new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 20 }),
    };

    const reqA = handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: userA, sessionId: 'sa', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    await vi.waitFor(() => {
      expect(cvExtract).toHaveBeenCalledTimes(1);
    });
    const reqB1 = handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: userB, sessionId: 'sb1', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    const reqB2 = handleHrCvExtractPoll({
      runtime: fakeRuntime,
      store,
      user: { userId: userB, sessionId: 'sb2', mfaAt: 1, extension: false } as unknown as Parameters<typeof handleHrCvExtractPoll>[0]['user'],
      orgId: ORG_ID,
      jobId,
      cvAi,
      runInAiScope: <T>(fn: () => Promise<T>) => fn(),
    });
    releaseA();
    await vi.waitFor(() => {
      expect(cvExtract).toHaveBeenCalledTimes(2);
    });
    releaseB();

    const [resA, resB1, resB2] = await Promise.all([reqA, reqB1, reqB2]);
    expect(resA.status === 'ready' && resA.draft.ai.reason).toBe('rate_limited');
    expect(resB1.status === 'ready' && resB1.draft.ai.reason).toBe('ok');
    expect(resB2.status === 'ready' && resB2.draft.ai.reason).toBe('ok');
    expect(cvExtract).toHaveBeenCalledTimes(2);
  });
});
