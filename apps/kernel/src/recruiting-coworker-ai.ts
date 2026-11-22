// SPDX-License-Identifier: AGPL-3.0-only
// Recruiting coworker ("Ly", COWORKER_BY_MODULE['hr'] === 'finance') orchestration on the API side (#3425, #3447).
//
// Reads a pseudonymized snapshot through the audited sensitive query `hr.recruiting.brief.read` (owner/admin only,
// audited before returning) BEFORE checking AI availability so non-admin callers ALWAYS receive 403 FORBIDDEN even
// when AI is disabled. Candidate free-text notes stay excluded by default unless `includeNotes === true`. Runs
// `InboxReader.recruitingBrief` outside the DB transaction under `DraftBudget` with candidate displayName/email/phone
// in `forbidden`, records `{ candidateId, aiReason, include_notes }` (zero PII) via `hr.recruiting.brief.audit`, and
// degrades cleanly to deterministic readiness + baseline interview questions when AI is off, rate-limited, over budget,
// unavailable, or refused.
import {
  AiBudgetExhaustedError,
  PayrollPromptLeakError,
  proposeCvCandidateDraft,
  reviewCandidateProfile,
  type CvExtractProposal,
  type InboxReader,
  type RecruitingBriefAiReason,
  type RecruitingBriefResult,
} from '@ludy/agent';
import type { HrRecruitingBriefAsk, HrRecruitingBriefResult } from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import type { CvDraftProposerInput, CvDraftProposerResult, HrRecruitingBriefSnapshot } from '@ludy/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface RecruitingBriefAi {
  reader: Pick<InboxReader, 'recruitingBrief'> | null;
  budget: DraftBudget;
}

export interface RecruitingCvAi {
  reader: Pick<InboxReader, 'cvExtract'> | null;
  budget: DraftBudget;
  aiEnabled: boolean;
}

export interface RecruitingBriefPorts {
  read(candidateId: string, lang: 'vi' | 'en', includeNotes: boolean): Promise<HrRecruitingBriefSnapshot>;
  record(candidateId: string, aiReason: RecruitingBriefAiReason, includeNotes: boolean): Promise<void>;
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof DomainError && (error.code === 'RATE_LIMITED' || error.status === 429);
}

export async function generateRecruitingBrief(
  ai: RecruitingBriefAi,
  ports: RecruitingBriefPorts,
  orgId: string,
  userId: string,
  input: HrRecruitingBriefAsk,
): Promise<HrRecruitingBriefResult> {
  const lang = input.lang ?? 'vi';
  const includeNotes = input.includeNotes === true;
  // Always run the owner/admin-gated sensitive read FIRST so non-admin callers never slip through with 200 when AI is off.
  const snapshot = await ports.read(input.candidateId, lang, includeNotes);
  const promptInput = includeNotes ? snapshot.input : { ...snapshot.input, notes: [] };

  let result: RecruitingBriefResult;
  if (!ai.reader) {
    result = await reviewCandidateProfile(promptInput, {
      generate: null,
      aiDisabledReason: 'off',
      forbidden: snapshot.forbidden,
    });
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) {
      result = await reviewCandidateProfile(promptInput, {
        generate: null,
        aiDisabledReason: 'rate_limited',
        forbidden: snapshot.forbidden,
      });
    } else {
      try {
        result = await ai.reader.recruitingBrief(promptInput, { forbidden: snapshot.forbidden });
      } catch (error: unknown) {
        if (error instanceof AiBudgetExhaustedError) {
          result = await reviewCandidateProfile(promptInput, {
            generate: null,
            aiDisabledReason: 'budget',
            forbidden: snapshot.forbidden,
          });
        } else if (isRateLimitError(error)) {
          result = await reviewCandidateProfile(promptInput, {
            generate: null,
            aiDisabledReason: 'rate_limited',
            forbidden: snapshot.forbidden,
          });
        } else if (error instanceof PayrollPromptLeakError) {
          result = await reviewCandidateProfile(promptInput, {
            generate: null,
            aiDisabledReason: 'unavailable',
            forbidden: snapshot.forbidden,
          });
          result = { ...result, ai: { ok: false, reason: 'refused' } };
        } else {
          console.error('[hr-recruiting-ai] brief failed', error instanceof Error ? error.name : typeof error);
          result = await reviewCandidateProfile(promptInput, {
            generate: null,
            aiDisabledReason: 'unavailable',
            forbidden: snapshot.forbidden,
          });
        }
      } finally {
        ticket.release();
      }
    }
  }

  await ports.record(input.candidateId, result.ai.reason, includeNotes);
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

/**
 * Runs optional metered Ly CV field extraction with strict deterministic fallback when AI is off, over budget,
 * rate-limited, unavailable, or produces ungrounded output. Never auto-creates candidates or makes screening decisions.
 */
export async function proposeCvDraftWithLy(
  ai: RecruitingCvAi,
  orgId: string,
  userId: string,
  input: CvDraftProposerInput,
  useAi = true,
): Promise<CvDraftProposerResult & CvExtractProposal> {
  if (!useAi || !ai.aiEnabled || !ai.reader) {
    return proposeCvCandidateDraft(input, { aiDisabledReason: 'ai_off' });
  }
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) {
    return proposeCvCandidateDraft(input, { aiDisabledReason: 'rate_limited' });
  }
  try {
    return await ai.reader.cvExtract(input);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) {
      return proposeCvCandidateDraft(input, { aiDisabledReason: 'budget' });
    }
    if (isRateLimitError(error)) {
      return proposeCvCandidateDraft(input, { aiDisabledReason: 'rate_limited' });
    }
    console.error('[hr-cv-extract-ai] proposal failed', error instanceof Error ? error.name : typeof error);
    return proposeCvCandidateDraft(input, { aiDisabledReason: 'unavailable' });
  } finally {
    ticket.release();
  }
}
