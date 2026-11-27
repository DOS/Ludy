// SPDX-License-Identifier: AGPL-3.0-only
// Kernel-side AI orchestration for HR Stage 7A shift coverage suggestions (#5216):
// reads deterministic conflict snapshot (`hr.shift.coverage.read`), runs `InboxReader.shiftCoverageSuggest`
// outside the DB transaction under `DraftBudget`, records audit (`hr.shift.coverage.audit`), and falls back deterministically.
import { AiBudgetExhaustedError, PayrollPromptLeakError, suggestShiftCoverage, type InboxReader } from '@ludy/agent';
import type {
  HrShiftCoverageAiReason,
  HrShiftCoverageAsk,
  HrShiftCoverageBrief,
  HrShiftCoverageSnapshot,
} from '@ludy/kernel-contract';
import { DomainError } from '@ludy/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';

function isRateLimitError(error: unknown): boolean {
  return (
    (error instanceof DomainError && (error.code === 'RATE_LIMITED' || error.status === 429)) ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { status?: unknown }).status === 429 ||
        (error as { statusCode?: unknown }).statusCode === 429 ||
        (error as { code?: unknown }).code === 'RATE_LIMITED'))
  );
}

export interface ShiftCoverageAi {
  reader: Pick<InboxReader, 'shiftCoverageSuggest'> | null;
  budget: DraftBudget;
}

export interface ShiftCoveragePorts {
  read: (input: HrShiftCoverageAsk) => Promise<HrShiftCoverageSnapshot>;
  record: (legalEntityId: string, weekStart: string, aiReason: HrShiftCoverageAiReason, conflictCount: number) => Promise<void>;
}

export async function generateShiftCoverageBrief(
  ai: ShiftCoverageAi,
  ports: ShiftCoveragePorts,
  orgId: string,
  userId: string,
  input: HrShiftCoverageAsk,
): Promise<HrShiftCoverageBrief> {
  const snapshot = await ports.read(input);

  const baseInput = {
    weekStart: snapshot.weekStart,
    weekEnd: snapshot.weekEnd,
    language: snapshot.lang,
    conflicts: snapshot.conflicts,
    gaps: snapshot.gaps,
    eligibleCandidates: snapshot.eligibleCandidates,
  };

  let result;
  if (snapshot.conflicts.length === 0 && snapshot.gaps.length === 0) {
    result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'off' });
  } else if (!ai.reader) {
    result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'off' });
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) {
      result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'rate_limited' });
    } else {
      try {
        result = await ai.reader.shiftCoverageSuggest(baseInput);
      } catch (error: unknown) {
        if (error instanceof AiBudgetExhaustedError) {
          result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'budget' });
        } else if (isRateLimitError(error)) {
          result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'rate_limited' });
        } else if (error instanceof PayrollPromptLeakError) {
          const baseFallback = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'unavailable' });
          result = { ...baseFallback, ai: { ok: false, reason: 'refused' as const } };
        } else {
          console.error('[hr-shifts-ai] coverage brief failed', error instanceof Error ? error.name : typeof error);
          result = await suggestShiftCoverage(baseInput, { generate: null, aiDisabledReason: 'unavailable' });
        }
      } finally {
        ticket.release();
      }
    }
  }

  await ports.record(snapshot.legalEntityId, snapshot.weekStart, result.ai.reason, snapshot.conflicts.length);

  return {
    legalEntityId: snapshot.legalEntityId,
    weekStart: snapshot.weekStart,
    weekEnd: snapshot.weekEnd,
    conflicts: snapshot.conflicts,
    gaps: snapshot.gaps,
    eligibleCandidates: snapshot.eligibleCandidates,
    summary: result.summary,
    highlights: result.highlights,
    suggestions: result.suggestions,
    ai: result.ai,
  };
}
