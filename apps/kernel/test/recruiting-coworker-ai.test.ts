// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { InboxReader, type RecruitingBriefAiReason, type RecruitingBriefResult } from '@ludy/agent';
import { DomainError, sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { hrCvBlobKey, type HrRecruitingBriefSnapshot } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { handleHrCvExtractPoll } from '../src/hr-cv-http.ts';
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
});
