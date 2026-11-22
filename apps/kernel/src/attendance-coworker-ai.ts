// SPDX-License-Identifier: AGPL-3.0-only
// Kernel-side AI orchestration for HR Stage 5C attendance anomaly narration (#4447):
// reads anomaly facts via audited sensitive query (`hr.attendance.anomalies.read`), runs
// `InboxReader.attendanceAnomalies` outside the DB transaction under `DraftBudget`, records
// the audited check (`hr.attendance.anomalies.audit`), and falls back 100% deterministically.
import { AiBudgetExhaustedError, PayrollPromptLeakError, reviewAttendanceAnomalies, type InboxReader } from '@ludy/agent';
import type {
  AttendanceAnomalyAiReason,
  HrAttendanceAnomaliesAsk,
  HrAttendanceAnomaliesBrief,
  HrAttendanceAnomaliesSnapshot,
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

export interface AttendanceAnomaliesAi {
  reader: Pick<InboxReader, 'attendanceAnomalies'> | null;
  budget: DraftBudget;
}

export interface AttendanceAnomaliesPorts {
  read: (input: { month?: string; legalEntityId?: string; lang?: 'vi' | 'en' }) => Promise<HrAttendanceAnomaliesSnapshot>;
  record: (month: string, legalEntityId: string, aiReason: AttendanceAnomalyAiReason) => Promise<void>;
}

export async function generateAttendanceAnomaliesBrief(
  ai: AttendanceAnomaliesAi,
  ports: AttendanceAnomaliesPorts,
  orgId: string,
  userId: string,
  input: HrAttendanceAnomaliesAsk,
): Promise<HrAttendanceAnomaliesBrief> {
  const snapshot = await ports.read({
    ...(input.month !== undefined ? { month: input.month } : {}),
    ...(input.legalEntityId !== undefined ? { legalEntityId: input.legalEntityId } : {}),
    ...(input.lang !== undefined ? { lang: input.lang } : {}),
  });

  const baseInput = {
    month: snapshot.month,
    language: snapshot.lang,
    anomalies: snapshot.anomalies,
  };

  let result;
  if (snapshot.anomalies.length === 0) {
    result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'off' });
  } else if (!ai.reader) {
    result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'off' });
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) {
      result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'rate_limited' });
    } else {
      try {
        result = await ai.reader.attendanceAnomalies(baseInput);
      } catch (error: unknown) {
        if (error instanceof AiBudgetExhaustedError) {
          result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'budget' });
        } else if (isRateLimitError(error)) {
          result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'rate_limited' });
        } else if (error instanceof PayrollPromptLeakError) {
          const baseFallback = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'unavailable' });
          result = { ...baseFallback, ai: { ok: false, reason: 'refused' as const } };
        } else {
          console.error('[hr-attendance-ai] anomalies brief failed', error instanceof Error ? error.name : typeof error);
          result = await reviewAttendanceAnomalies(baseInput, { generate: null, aiDisabledReason: 'unavailable' });
        }
      } finally {
        ticket.release();
      }
    }
  }

  await ports.record(snapshot.month, snapshot.legalEntityId, result.ai.reason);

  return {
    month: snapshot.month,
    legalEntityId: snapshot.legalEntityId,
    anomalies: snapshot.anomalies,
    summary: result.summary,
    highlights: result.highlights,
    ai: result.ai,
  };
}
