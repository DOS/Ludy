// SPDX-License-Identifier: AGPL-3.0-only
// Recruiting coworker ("Ly", COWORKER_BY_MODULE['hr'] === 'finance') orchestration on the API side (#3425).
//
// Reads a pseudonymized snapshot through the audited sensitive query `hr.recruiting.brief.read` (owner/admin only,
// audited before returning) BEFORE checking AI availability so non-admin callers ALWAYS receive 403 FORBIDDEN even
// when AI is disabled. Runs `InboxReader.recruitingBrief` outside the DB transaction under `DraftBudget` with
// candidate displayName/email/phone in `forbidden`, records `{ candidateId, aiReason }` (zero PII) via
// `hr.recruiting.brief.audit`, and degrades cleanly to deterministic readiness + baseline interview questions.
import {
  AiBudgetExhaustedError,
  PayrollPromptLeakError,
  reviewCandidateProfile,
  type InboxReader,
  type RecruitingBriefAiReason,
  type RecruitingBriefResult,
} from '@crove/agent';
import type { HrRecruitingBriefAsk, HrRecruitingBriefResult } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import type { HrRecruitingBriefSnapshot } from '@crove/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface RecruitingBriefAi {
  reader: Pick<InboxReader, 'recruitingBrief'> | null;
  budget: DraftBudget;
}

export interface RecruitingBriefPorts {
  read(candidateId: string, lang: 'vi' | 'en'): Promise<HrRecruitingBriefSnapshot>;
  record(candidateId: string, aiReason: RecruitingBriefAiReason): Promise<void>;
}

export async function generateRecruitingBrief(
  ai: RecruitingBriefAi,
  ports: RecruitingBriefPorts,
  orgId: string,
  userId: string,
  input: HrRecruitingBriefAsk,
): Promise<HrRecruitingBriefResult> {
  const lang = input.lang ?? 'vi';
  // Always run the owner/admin-gated sensitive read FIRST so non-admin callers never slip through with 200 when AI is off.
  const snapshot = await ports.read(input.candidateId, lang);

  let result: RecruitingBriefResult;
  if (!ai.reader) {
    result = await reviewCandidateProfile(snapshot.input, {
      generate: null,
      aiDisabledReason: 'off',
      forbidden: snapshot.forbidden,
    });
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) {
      throw new DomainError(
        'RATE_LIMITED',
        429,
        ticket.reason === 'busy'
          ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp'
          : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút',
        { retryAfterSeconds: ticket.retryAfterSeconds },
      );
    }
    try {
      result = await ai.reader.recruitingBrief(snapshot.input, { forbidden: snapshot.forbidden });
    } catch (error: unknown) {
      if (error instanceof AiBudgetExhaustedError) {
        result = await reviewCandidateProfile(snapshot.input, {
          generate: null,
          aiDisabledReason: 'budget',
          forbidden: snapshot.forbidden,
        });
      } else if (error instanceof PayrollPromptLeakError) {
        result = await reviewCandidateProfile(snapshot.input, {
          generate: null,
          aiDisabledReason: 'unavailable',
          forbidden: snapshot.forbidden,
        });
        result = { ...result, ai: { ok: false, reason: 'refused' } };
      } else {
        console.error('[hr-recruiting-ai] brief failed', error instanceof Error ? error.name : typeof error);
        result = await reviewCandidateProfile(snapshot.input, {
          generate: null,
          aiDisabledReason: 'unavailable',
          forbidden: snapshot.forbidden,
        });
      }
    } finally {
      ticket.release();
    }
  }

  await ports.record(input.candidateId, result.ai.reason);
  return {
    candidateId: snapshot.candidateId,
    readiness: result.readiness,
    summary: result.summary,
    strengths: result.strengths,
    risks: result.risks,
    interviewQuestions: result.interviewQuestions,
    ai: result.ai,
  };
}
