// SPDX-License-Identifier: AGPL-3.0-only
// Shift coverage coworker ("Ly", COWORKER_BY_MODULE['hr'] === 'finance') for HR Stage 7A (#5216).
//
// Deterministic code detects all shift conflicts (approved leave, approved business trip,
// VN public holidays, < 12h short-rest gaps) and ranks eligible non-erased replacement candidates.
// The model sees ONLY randomized pseudonymized aliases ("E1", "E2", ...) and shift codes/dates.
// Employee names, IDs, and free-text notes never enter the prompt (verified with PayrollPromptLeakError).
// Any model refusal, budget exhaustion, rate limit, or error degrades cleanly to deterministic output.
import { randomInt } from 'node:crypto';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type {
  HrShiftConflictKind,
  HrShiftCoverageAiReason,
  HrShiftCoverageCandidate,
  HrShiftCoverageConflict,
  HrShiftCoverageGap,
  HrShiftCoverageSuggestion,
} from '@ludy/kernel-contract';
import { classifyAiError } from './errors.ts';
import { chatModel, type AiConfig, type AiUsage } from './index.ts';
import { AiBudgetExhaustedError, metered } from './meter.ts';
import { statedFiguresProblem } from './overview.ts';
import { PayrollPromptLeakError, promptLeaks, restoreAliases } from './payroll-coworker.ts';
import { hasMarkdownNoise } from './project-weekly-status.ts';
import { hasAddress } from './reminder.ts';

export const SHIFT_COVERAGE_SUMMARY_MAX = 360;
export const SHIFT_COVERAGE_HIGHLIGHT_MAX = 200;
export const SHIFT_COVERAGE_HIGHLIGHTS_MAX = 6;
export const SHIFT_COVERAGE_SUGGESTIONS_MAX = 8;
export const SHIFT_COVERAGE_NOTE_MAX = 200;
export const SHIFT_COVERAGE_ALIASES_MAX = 80;

export interface ShiftCoverageSuggestInput {
  weekStart: string;
  weekEnd: string;
  language: 'vi' | 'en';
  conflicts: readonly HrShiftCoverageConflict[];
  gaps: readonly HrShiftCoverageGap[];
  eligibleCandidates: readonly HrShiftCoverageCandidate[];
}

export interface ShiftCoverageSuggestResult {
  summary: string;
  highlights: string[];
  suggestions: HrShiftCoverageSuggestion[];
  ai: {
    ok: boolean;
    reason: HrShiftCoverageAiReason;
  };
}

const zShiftCoverageAiOut = z.object({
  summary: z
    .string()
    .describe(`1 to 2 short plain-text sentences summarizing weekly shift conflicts (<= ${SHIFT_COVERAGE_SUMMARY_MAX} chars, no markdown, no invented numbers)`),
  highlights: z
    .array(z.string())
    .max(SHIFT_COVERAGE_HIGHLIGHTS_MAX)
    .describe(`0 to ${SHIFT_COVERAGE_HIGHLIGHTS_MAX} brief notes using E1..En aliases only`),
  suggestions: z
    .array(
      z.object({
        workDate: z.string(),
        targetAlias: z.string().nullable(),
        candidateAlias: z.string().nullable(),
        note: z.string(),
      }),
    )
    .max(SHIFT_COVERAGE_SUGGESTIONS_MAX)
    .describe('Optional replacement suggestions pairing a conflicted targetAlias on workDate with an eligible candidateAlias from the provided lists'),
});
export type ShiftCoverageAiOutput = z.infer<typeof zShiftCoverageAiOut>;

export type ShiftCoverageGenerator = (args: {
  system: string;
  prompt: string;
}) => Promise<{ output: ShiftCoverageAiOutput | null; usage?: AiUsage }>;

export interface SuggestShiftCoverageOptions {
  generate?: ShiftCoverageGenerator | null;
  aiDisabledReason?: Exclude<HrShiftCoverageAiReason, 'ok' | 'refused'>;
  onUsage?: (usage: AiUsage) => void;
}

function normalizeSentence(s: string, maxLen: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function conflictLabel(kind: HrShiftConflictKind, lang: 'vi' | 'en'): string {
  if (lang === 'vi') {
    return {
      approved_leave: 'Nghỉ phép đã duyệt',
      approved_trip: 'Công tác đã duyệt',
      public_holiday: 'Ngày lễ BLLĐ Điều 112',
      short_rest: 'Nghỉ giữa ca dưới 12 giờ',
    }[kind];
  }
  return {
    approved_leave: 'Approved leave',
    approved_trip: 'Approved business trip',
    public_holiday: 'Vietnam public holiday (Art. 112)',
    short_rest: 'Short rest under 12h',
  }[kind];
}

function deterministicCoverageFallback(input: ShiftCoverageSuggestInput): {
  summary: string;
  highlights: string[];
  suggestions: HrShiftCoverageSuggestion[];
} {
  if (input.conflicts.length === 0 && input.gaps.length === 0) {
    return {
      summary:
        input.language === 'vi'
          ? `Tuần ${input.weekStart} đến ${input.weekEnd} chưa ghi nhận xung đột lịch ca nào.`
          : `No shift scheduling conflicts recorded for ${input.weekStart} to ${input.weekEnd}.`,
      highlights: [],
      suggestions: [],
    };
  }

  const counts: Record<HrShiftConflictKind, number> = {
    approved_leave: 0,
    approved_trip: 0,
    public_holiday: 0,
    short_rest: 0,
  };
  for (const c of input.conflicts) counts[c.kind] += 1;

  const partsVi: string[] = [];
  const partsEn: string[] = [];
  if (counts.approved_leave > 0) {
    partsVi.push(`${counts.approved_leave} ca trùng nghỉ phép`);
    partsEn.push(`${counts.approved_leave} shift(s) on approved leave`);
  }
  if (counts.approved_trip > 0) {
    partsVi.push(`${counts.approved_trip} ca trùng công tác`);
    partsEn.push(`${counts.approved_trip} shift(s) on business trip`);
  }
  if (counts.short_rest > 0) {
    partsVi.push(`${counts.short_rest} ca nghỉ giữa ca dưới 12 giờ`);
    partsEn.push(`${counts.short_rest} short-rest (<12h) gap(s)`);
  }
  if (counts.public_holiday > 0) {
    partsVi.push(`${counts.public_holiday} ca rơi vào ngày lễ`);
    partsEn.push(`${counts.public_holiday} public holiday shift(s)`);
  }

  const summary =
    input.language === 'vi'
      ? `Tuần ${input.weekStart} đến ${input.weekEnd} có ${input.conflicts.length} điểm cần rà soát: ${partsVi.join(', ')}.`
      : `${input.conflicts.length} roster issue(s) from ${input.weekStart} to ${input.weekEnd}: ${partsEn.join(', ')}.`;

  const highlights = input.conflicts
    .slice(0, SHIFT_COVERAGE_HIGHLIGHTS_MAX)
    .map((c) =>
      normalizeSentence(
        `${c.employeeName} (${c.workDate}, ${c.shiftCode}): ${conflictLabel(c.kind, input.language)}`,
        SHIFT_COVERAGE_HIGHLIGHT_MAX,
      ),
    );

  const suggestions: HrShiftCoverageSuggestion[] = [];
  for (const gap of input.gaps.slice(0, SHIFT_COVERAGE_SUGGESTIONS_MAX)) {
    const firstConflict = input.conflicts.find(
      (c) => c.workDate === gap.date && c.shiftCode === gap.shiftCode && c.kind !== 'public_holiday',
    );
    const best = gap.candidates[0] ?? null;
    suggestions.push({
      workDate: gap.date,
      targetEmployeeId: firstConflict?.employeeId ?? null,
      targetEmployeeName: firstConflict?.employeeName ?? null,
      suggestedCandidateId: best?.employeeId ?? null,
      suggestedCandidateName: best?.employeeName ?? null,
      note: normalizeSentence(
        best
          ? input.language === 'vi'
            ? `Đề xuất ${best.employeeName} (${best.weeklyShiftCount} ca/tuần) thay ca ${gap.shiftCode ?? ''} ngày ${gap.date}.`
            : `Suggest ${best.employeeName} (${best.weeklyShiftCount} shift(s)/week) for ${gap.shiftCode ?? ''} on ${gap.date}.`
          : input.language === 'vi'
            ? `Chưa có nhân sự rảnh đủ 12 giờ nghỉ cho ca ${gap.shiftCode ?? ''} ngày ${gap.date}.`
            : `No available staff with >= 12h rest for ${gap.shiftCode ?? ''} on ${gap.date}.`,
        SHIFT_COVERAGE_NOTE_MAX,
      ),
    });
  }

  return {
    summary: normalizeSentence(summary, SHIFT_COVERAGE_SUMMARY_MAX),
    highlights,
    suggestions,
  };
}

function buildAliases(input: ShiftCoverageSuggestInput): {
  aliasByEmployeeId: Map<string, string>;
  realNameByAlias: Map<string, string>;
  empIdByAlias: Map<string, string>;
  forbidden: string[];
} {
  const unique = new Map<string, string>();
  for (const c of input.conflicts) {
    if (!unique.has(c.employeeId)) unique.set(c.employeeId, c.employeeName);
  }
  for (const cand of input.eligibleCandidates) {
    if (!unique.has(cand.employeeId)) unique.set(cand.employeeId, cand.employeeName);
  }
  for (const gap of input.gaps) {
    for (const cand of gap.candidates) {
      if (!unique.has(cand.employeeId)) unique.set(cand.employeeId, cand.employeeName);
    }
  }

  const entries = [...unique.entries()].slice(0, SHIFT_COVERAGE_ALIASES_MAX);
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const tmp = entries[i]!;
    entries[i] = entries[j]!;
    entries[j] = tmp;
  }

  const aliasByEmployeeId = new Map<string, string>();
  const realNameByAlias = new Map<string, string>();
  const empIdByAlias = new Map<string, string>();
  const forbidden: string[] = [];
  entries.forEach(([employeeId, displayName], idx) => {
    const alias = `E${idx + 1}`;
    aliasByEmployeeId.set(employeeId, alias);
    realNameByAlias.set(alias, displayName);
    empIdByAlias.set(alias, employeeId);
    const trimmed = displayName.trim();
    if (trimmed.length >= 3) forbidden.push(trimmed);
  });

  return { aliasByEmployeeId, realNameByAlias, empIdByAlias, forbidden };
}

function containsForbiddenPii(text: string, forbidden: readonly string[]): boolean {
  return promptLeaks(text, forbidden).length > 0;
}

function shiftCoverageInstructions(lang: 'vi' | 'en'): string {
  return lang === 'vi'
    ? 'Bạn là Ly, cộng sự điều phối nhân sự trong Ludy. Chỉ tóm tắt xung đột ca làm và gợi ý người thay thế dựa trên bí danh (E1, E2...) và danh sách ứng viên đã kiểm tra sẵn. Không bịa số liệu, không tự động đổi ca hay duyệt đơn, chỉ trả lời văn bản thuần tiếng Việt.'
    : 'You are Ly, the shift coverage coworker in Ludy. Concisely summarize roster conflicts and replacement suggestions using only the provided aliases (E1, E2...) and vetted candidates. Never invent numbers, never claim to modify the roster or approve swaps, plain text only.';
}

/** Creates the metered OpenAI-compatible generator for shift coverage suggestions (`hr.shift_coverage_suggest`). */
export function createShiftCoverageSuggestGenerator(config: AiConfig): ShiftCoverageGenerator {
  const timeoutMs = config.timeoutMs ?? 60_000;
  const retries = config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries };
  return async ({ system, prompt }) => {
    const { output, usage } = await metered('hr.shift_coverage_suggest', () =>
      generateText({
        model: chatModel(config),
        output: Output.object({ schema: zShiftCoverageAiOut }),
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
 * Generates deterministic shift conflict analysis plus optional pseudonymized Ly replacement advice.
 * Never prompts when there are no conflicts/gaps; refuses cleanly if PII leaks into the prompt.
 */
export async function suggestShiftCoverage(
  input: ShiftCoverageSuggestInput,
  options: SuggestShiftCoverageOptions = {},
): Promise<ShiftCoverageSuggestResult> {
  const fallback = deterministicCoverageFallback(input);
  if (input.conflicts.length === 0 && input.gaps.length === 0) {
    return { ...fallback, ai: { ok: false, reason: options.aiDisabledReason ?? 'off' } };
  }
  if (options.aiDisabledReason) {
    return { ...fallback, ai: { ok: false, reason: options.aiDisabledReason } };
  }
  if (!options.generate) {
    return { ...fallback, ai: { ok: false, reason: 'off' } };
  }

  const { aliasByEmployeeId, realNameByAlias, empIdByAlias, forbidden } = buildAliases(input);
  const promptConflicts = input.conflicts
    .filter((c) => aliasByEmployeeId.has(c.employeeId))
    .slice(0, SHIFT_COVERAGE_ALIASES_MAX)
    .map((c) => ({
      alias: aliasByEmployeeId.get(c.employeeId)!,
      workDate: c.workDate,
      shiftCode: c.shiftCode,
      kind: c.kind,
    }));

  const promptGaps = input.gaps.slice(0, 20).map((g) => ({
    workDate: g.date,
    shiftCode: g.shiftCode,
    candidateAliases: g.candidates
      .filter((cand) => aliasByEmployeeId.has(cand.employeeId))
      .slice(0, 8)
      .map((cand) => ({
        alias: aliasByEmployeeId.get(cand.employeeId)!,
        weeklyShiftCount: cand.weeklyShiftCount,
      })),
  }));

  const prompt = JSON.stringify({
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    totalConflicts: input.conflicts.length,
    conflicts: promptConflicts,
    gaps: promptGaps,
  });

  if (containsForbiddenPii(prompt, forbidden)) {
    throw new PayrollPromptLeakError();
  }

  let generated: { output: ShiftCoverageAiOutput | null; usage?: AiUsage };
  try {
    generated = await options.generate({ system: shiftCoverageInstructions(input.language), prompt });
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

  const summaryRaw = normalizeSentence(out.summary, SHIFT_COVERAGE_SUMMARY_MAX);
  const highlightsRaw = out.highlights
    .map((h) => normalizeSentence(h, SHIFT_COVERAGE_HIGHLIGHT_MAX))
    .filter((h) => h.length > 0)
    .slice(0, SHIFT_COVERAGE_HIGHLIGHTS_MAX);

  const validGapDates = new Set([...input.gaps.map((g) => g.date), ...input.conflicts.map((c) => c.workDate)]);
  const allowedCandidatesByDate = new Map<string, Set<string>>();
  for (const g of input.gaps) {
    const set = allowedCandidatesByDate.get(g.date) ?? new Set<string>();
    for (const c of g.candidates) {
      const al = aliasByEmployeeId.get(c.employeeId);
      if (al) set.add(al);
    }
    allowedCandidatesByDate.set(g.date, set);
  }

  const parsedSuggestions: HrShiftCoverageSuggestion[] = [];
  const suggestionTexts: string[] = [];
  for (const s of out.suggestions.slice(0, SHIFT_COVERAGE_SUGGESTIONS_MAX)) {
    if (!validGapDates.has(s.workDate)) {
      return { ...fallback, ai: { ok: false, reason: 'refused' } };
    }
    const tgtAlias = s.targetAlias?.toUpperCase() ?? null;
    const candAlias = s.candidateAlias?.toUpperCase() ?? null;
    if (tgtAlias && !realNameByAlias.has(tgtAlias)) {
      return { ...fallback, ai: { ok: false, reason: 'refused' } };
    }
    if (candAlias) {
      const allowedOnDate = allowedCandidatesByDate.get(s.workDate);
      if (!realNameByAlias.has(candAlias) || !allowedOnDate?.has(candAlias)) {
        return { ...fallback, ai: { ok: false, reason: 'refused' } };
      }
    }
    const noteRaw = normalizeSentence(s.note, SHIFT_COVERAGE_NOTE_MAX);
    if (noteRaw.length === 0) {
      return { ...fallback, ai: { ok: false, reason: 'refused' } };
    }
    suggestionTexts.push(noteRaw);
    parsedSuggestions.push({
      workDate: s.workDate,
      targetEmployeeId: tgtAlias ? (empIdByAlias.get(tgtAlias) ?? null) : null,
      targetEmployeeName: tgtAlias ? (realNameByAlias.get(tgtAlias) ?? null) : null,
      suggestedCandidateId: candAlias ? (empIdByAlias.get(candAlias) ?? null) : null,
      suggestedCandidateName: candAlias ? (realNameByAlias.get(candAlias) ?? null) : null,
      note: restoreAliases(noteRaw, realNameByAlias),
    });
  }

  const combined = `${summaryRaw}\n${highlightsRaw.join('\n')}\n${suggestionTexts.join('\n')}`;
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
    suggestions: parsedSuggestions.length > 0 ? parsedSuggestions : fallback.suggestions,
    ai: { ok: true, reason: 'ok' },
  };
}
