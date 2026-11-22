// SPDX-License-Identifier: AGPL-3.0-only
// Attendance anomaly coworker ("Ly", COWORKER_BY_MODULE['hr'] === 'finance') narrator (#4447 Stage 5C).
//
// Deterministic code computes every attendance anomaly (missing_checkout, short_day < 4h, long_day > 10h,
// weekend_work, holiday_work) and rolls days/hours into draft payroll via decimal.js.
// The model sees ONLY randomized pseudonymized aliases ("E1", "E2", ...) and aggregate/event counts.
// Employee names, IDs, and free-text notes never enter the prompt (verified with PayrollPromptLeakError).
// Any model refusal, budget exhaustion, rate limit, or error degrades cleanly to the deterministic summary.
import { randomInt } from 'node:crypto';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { classifyAiError } from './errors.ts';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { AiBudgetExhaustedError, metered } from './meter.ts';
import { statedFiguresProblem } from './overview.ts';
import { PayrollPromptLeakError, promptLeaks, restoreAliases } from './payroll-coworker.ts';
import { hasMarkdownNoise } from './project-weekly-status.ts';
import { hasAddress } from './reminder.ts';

export type AttendanceAnomalyAiReason = 'ok' | 'off' | 'budget' | 'rate_limited' | 'unavailable' | 'refused';
export type AttendanceAnomalyKind = 'missing_checkout' | 'short_day' | 'long_day' | 'weekend_work' | 'holiday_work';

export interface AttendanceAnomalyItem {
  logId: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  kind: AttendanceAnomalyKind;
  workedMinutes: number | null;
}

export const ATTENDANCE_SUMMARY_MAX = 360;
export const ATTENDANCE_HIGHLIGHT_MAX = 200;
export const ATTENDANCE_HIGHLIGHTS_MAX = 6;
export const ATTENDANCE_ALIASES_MAX = 60;

export interface AttendanceAnomalyNarrateInput {
  month: string;
  language: 'vi' | 'en';
  anomalies: readonly AttendanceAnomalyItem[];
}

export interface AttendanceAnomalyNarrateResult {
  summary: string | null;
  highlights: string[];
  ai: {
    ok: boolean;
    reason: AttendanceAnomalyAiReason;
  };
}

const zAttendanceAnomalyAiOut = z.object({
  summary: z
    .string()
    .describe(`1 to 2 short sentences summarizing the month's attendance anomalies (<= ${ATTENDANCE_SUMMARY_MAX} chars, plain text, no markdown, no invented numbers)`),
  highlights: z
    .array(z.string())
    .max(ATTENDANCE_HIGHLIGHTS_MAX)
    .describe(`0 to ${ATTENDANCE_HIGHLIGHTS_MAX} action notes using E1..En aliases, no payroll edits or invented counts`),
});
export type AttendanceAnomalyAiOutput = z.infer<typeof zAttendanceAnomalyAiOut>;

export type AttendanceAnomalyGenerator = (args: {
  system: string;
  prompt: string;
}) => Promise<{ output: AttendanceAnomalyAiOutput | null; usage?: AiUsage }>;

export interface ReviewAttendanceAnomaliesOptions {
  generate?: AttendanceAnomalyGenerator | null;
  aiDisabledReason?: Exclude<AttendanceAnomalyAiReason, 'ok' | 'refused'>;
  onUsage?: (usage: AiUsage) => void;
}

function normalizeSentence(s: string, maxLen: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function deterministicSummaryAndHighlights(input: AttendanceAnomalyNarrateInput): {
  summary: string | null;
  highlights: string[];
} {
  if (input.anomalies.length === 0) {
    return {
      summary:
        input.language === 'vi'
          ? `Tháng ${input.month} chưa ghi nhận bất thường chấm công nào.`
          : `No attendance anomalies recorded for ${input.month}.`,
      highlights: [],
    };
  }
  const counts: Record<AttendanceAnomalyKind, number> = {
    missing_checkout: 0,
    short_day: 0,
    long_day: 0,
    weekend_work: 0,
    holiday_work: 0,
  };
  for (const a of input.anomalies) counts[a.kind] += 1;

  const partsVi: string[] = [];
  const partsEn: string[] = [];
  if (counts.missing_checkout > 0) {
    partsVi.push(`${counts.missing_checkout} lượt thiếu check-out`);
    partsEn.push(`${counts.missing_checkout} missing check-out(s)`);
  }
  if (counts.short_day > 0) {
    partsVi.push(`${counts.short_day} ca dưới 4 giờ`);
    partsEn.push(`${counts.short_day} shift(s) under 4h`);
  }
  if (counts.long_day > 0) {
    partsVi.push(`${counts.long_day} ca trên 10 giờ`);
    partsEn.push(`${counts.long_day} shift(s) over 10h`);
  }
  if (counts.weekend_work > 0) {
    partsVi.push(`${counts.weekend_work} ngày làm Chủ nhật`);
    partsEn.push(`${counts.weekend_work} Sunday work entry(s)`);
  }
  if (counts.holiday_work > 0) {
    partsVi.push(`${counts.holiday_work} ngày làm dịp lễ`);
    partsEn.push(`${counts.holiday_work} holiday work entry(s)`);
  }

  const summary =
    input.language === 'vi'
      ? `Tháng ${input.month} có ${input.anomalies.length} bất thường cần rà soát trước khi chốt lương: ${partsVi.join(', ')}.`
      : `${input.anomalies.length} attendance anomalie(s) in ${input.month} to review before payroll rollup: ${partsEn.join(', ')}.`;

  const highlights: string[] = [];
  for (const a of input.anomalies.slice(0, ATTENDANCE_HIGHLIGHTS_MAX)) {
    const label =
      input.language === 'vi'
        ? {
            missing_checkout: 'Thiếu check-out',
            short_day: 'Ca ngắn (< 4h)',
            long_day: 'Ca dài (> 10h)',
            weekend_work: 'Làm việc Chủ nhật',
            holiday_work: 'Làm việc ngày lễ',
          }[a.kind]
        : {
            missing_checkout: 'Missing check-out',
            short_day: 'Short shift (< 4h)',
            long_day: 'Long shift (> 10h)',
            weekend_work: 'Sunday work',
            holiday_work: 'Holiday work',
          }[a.kind];
    highlights.push(normalizeSentence(`${a.employeeName} (${a.workDate}): ${label}`, ATTENDANCE_HIGHLIGHT_MAX));
  }
  return { summary: normalizeSentence(summary, ATTENDANCE_SUMMARY_MAX), highlights };
}

function buildAliases(anomalies: readonly AttendanceAnomalyItem[]): {
  aliasByEmployeeId: Map<string, string>;
  realNameByAlias: Map<string, string>;
  forbidden: string[];
} {
  const uniqueEmployees = new Map<string, string>();
  for (const a of anomalies) {
    if (!uniqueEmployees.has(a.employeeId)) uniqueEmployees.set(a.employeeId, a.employeeName);
  }
  const entries = [...uniqueEmployees.entries()].slice(0, ATTENDANCE_ALIASES_MAX);
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const tmp = entries[i]!;
    entries[i] = entries[j]!;
    entries[j] = tmp;
  }
  const aliasByEmployeeId = new Map<string, string>();
  const realNameByAlias = new Map<string, string>();
  const forbidden: string[] = [];
  entries.forEach(([employeeId, displayName], idx) => {
    const alias = `E${idx + 1}`;
    aliasByEmployeeId.set(employeeId, alias);
    realNameByAlias.set(alias, displayName);
    if (displayName.trim().length >= 3) forbidden.push(displayName.trim());
  });
  return { aliasByEmployeeId, realNameByAlias, forbidden };
}

function containsForbiddenPii(text: string, forbidden: readonly string[]): boolean {
  return promptLeaks(text, forbidden).length > 0;
}

function attendanceInstructions(lang: 'vi' | 'en'): string {
  return lang === 'vi'
    ? 'Bạn là Ly, cộng sự chấm công trong Ludy. Chỉ tóm tắt ngắn gọn các bất thường dựa trên dữ liệu đã ẩn danh (E1, E2...). Không bịa số liệu, không tự động chỉnh công hay duyệt lương, trả về văn bản thuần tiếng Việt.'
    : 'You are Ly, the attendance coworker in Ludy. Concisely summarize the anonymized attendance anomalies (E1, E2...). Never invent numbers, never claim to modify attendance or approve payroll, plain text only.';
}

/** Creates the metered OpenAI-compatible generator for attendance anomaly narration (`hr.attendance_anomaly`). */
export function createAttendanceAnomalyGenerator(config: AiConfig): AttendanceAnomalyGenerator {
  const timeoutMs = config.timeoutMs ?? 60_000;
  const retries = config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries };
  return async ({ system, prompt }) => {
    const { output, usage } = await metered('hr.attendance_anomaly', () =>
      generateText({
        model: chatModel(config),
        output: Output.object({ schema: zAttendanceAnomalyAiOut }),
        system,
        prompt,
        abortSignal: AbortSignal.timeout(timeoutMs),
        ...retries,
      }),
    );
    return { output: output ?? null, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
  };
}

/**
 * Generates deterministic anomaly summary plus optional pseudonymized Ly AI highlights.
 * Never prompts when anomalies are empty; refuses cleanly if PII leaks into prompt.
 */
export async function reviewAttendanceAnomalies(
  input: AttendanceAnomalyNarrateInput,
  options: ReviewAttendanceAnomaliesOptions = {},
): Promise<AttendanceAnomalyNarrateResult> {
  const fallback = deterministicSummaryAndHighlights(input);
  if (input.anomalies.length === 0) {
    return { ...fallback, ai: { ok: false, reason: options.aiDisabledReason ?? 'off' } };
  }
  if (options.aiDisabledReason) {
    return { ...fallback, ai: { ok: false, reason: options.aiDisabledReason } };
  }
  if (!options.generate) {
    return { ...fallback, ai: { ok: false, reason: 'off' } };
  }

  const { aliasByEmployeeId, realNameByAlias, forbidden } = buildAliases(input.anomalies);
  const items = input.anomalies
    .filter((a) => aliasByEmployeeId.has(a.employeeId))
    .slice(0, ATTENDANCE_ALIASES_MAX)
    .map((a) => ({
      alias: aliasByEmployeeId.get(a.employeeId)!,
      date: a.workDate,
      kind: a.kind,
      workedMinutes: a.workedMinutes,
    }));

  const prompt = JSON.stringify({ month: input.month, total: input.anomalies.length, items });
  if (containsForbiddenPii(prompt, forbidden)) {
    throw new PayrollPromptLeakError();
  }

  let generated: { output: AttendanceAnomalyAiOutput | null; usage?: AiUsage };
  try {
    generated = await options.generate({ system: attendanceInstructions(input.language), prompt });
  } catch (error: unknown) {
    if (error instanceof PayrollPromptLeakError) throw error;
    if (error instanceof AiBudgetExhaustedError) {
      return { ...fallback, ai: { ok: false, reason: 'budget' } };
    }
    if (
      classifyAiError(error).kind === 'rate_limit' ||
      (typeof error === 'object' &&
        error !== null &&
        ((error as { status?: unknown }).status === 429 ||
          (error as { statusCode?: unknown }).statusCode === 429 ||
          (error as { code?: unknown }).code === 'RATE_LIMITED'))
    ) {
      return { ...fallback, ai: { ok: false, reason: 'rate_limited' } };
    }
    return { ...fallback, ai: { ok: false, reason: 'unavailable' } };
  }
  if (generated.usage) options.onUsage?.(generated.usage);

  const out = generated.output;
  if (!out) return { ...fallback, ai: { ok: false, reason: 'refused' } };

  const summaryRaw = normalizeSentence(out.summary, ATTENDANCE_SUMMARY_MAX);
  const highlightsRaw = out.highlights
    .map((h) => normalizeSentence(h, ATTENDANCE_HIGHLIGHT_MAX))
    .filter((h) => h.length > 0)
    .slice(0, ATTENDANCE_HIGHLIGHTS_MAX);

  const combined = `${summaryRaw}\n${highlightsRaw.join('\n')}`;
  if (
    summaryRaw.length === 0 ||
    hasMarkdownNoise(combined) ||
    hasAddress(combined) ||
    containsForbiddenPii(combined, forbidden) ||
    statedFiguresProblem(combined, [prompt]) !== null
  ) {
    return { ...fallback, ai: { ok: false, reason: 'refused' } };
  }

  return {
    summary: restoreAliases(summaryRaw, realNameByAlias),
    highlights: highlightsRaw.map((h) => restoreAliases(h, realNameByAlias)),
    ai: { ok: true, reason: 'ok' },
  };
}
