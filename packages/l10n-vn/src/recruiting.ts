// SPDX-License-Identifier: AGPL-3.0-only
// Pure recruiting pipeline, readiness evaluation, and interview slot helpers (#3403 Stage 3 slice 3b-1 / #3413).
// Zero DB or AI dependency. All monetary comparisons use decimal.js via `./money.ts` (`money()`, `toMoney()`),
// never JS floating-point numbers. Calendar dates validate against Gregorian bounds via `isValidCalendarDate`.
import { isValidCalendarDate } from './labor-contracts.ts';
import { money, toMoney, type DecimalValue } from './money.ts';
import { assertValidTimeZone, nextUtcDate, zoneOffsetMs, zonedDateString } from './time-zone.ts';

// ---------------------------------------------------------------------------------------------------------------------
// 1. Recruiting pipeline stages & transition checks
// ---------------------------------------------------------------------------------------------------------------------

export const RECRUITING_STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const;
export type RecruitingStage = (typeof RECRUITING_STAGES)[number];

export function isRecruitingStage(value: string): value is RecruitingStage {
  return (RECRUITING_STAGES as readonly string[]).includes(value);
}

export const CANDIDATE_TRANSITION_ISSUE_CODES = [
  'invalid_stage_transition',
  'missing_interview_before_offer',
  'missing_agreed_wage_for_hire',
  'missing_start_date_for_hire',
  'direct_hire_without_offer',
  'reopened_from_rejected',
] as const;
export type CandidateTransitionIssueCode = (typeof CANDIDATE_TRANSITION_ISSUE_CODES)[number];

export interface CandidateTransitionIssue {
  code: CandidateTransitionIssueCode;
  messageVi: string;
  messageEn: string;
}

export interface CandidateTransitionInput {
  from: RecruitingStage;
  to: RecruitingStage;
  hasScheduledInterview?: boolean | null;
  agreedWage?: string | null;
  startDate?: string | null;
  /** Explicit override allowing direct hire from an active pre-offer stage (never from rejected or hired). */
  allowDirectHire?: boolean | null;
  /** Explicit override allowing a rejected candidate to return to applied or screening. */
  allowReopen?: boolean | null;
}

export interface CandidateTransitionResult {
  allowed: boolean;
  warnings: CandidateTransitionIssue[];
  errors: CandidateTransitionIssue[];
  warningCodes: CandidateTransitionIssueCode[];
  errorCodes: CandidateTransitionIssueCode[];
}

const TRANSITION_MESSAGES: Record<CandidateTransitionIssueCode, { vi: string; en: string }> = {
  invalid_stage_transition: {
    vi: 'Không thể chuyển giai đoạn tuyển dụng theo hướng này.',
    en: 'This candidate stage transition is not allowed.',
  },
  missing_interview_before_offer: {
    vi: 'Ứng viên chưa có lịch phỏng vấn trước khi chuyển sang giai đoạn đề nghị (offer).',
    en: 'Candidate has no scheduled interview before moving to the offer stage.',
  },
  missing_agreed_wage_for_hire: {
    vi: 'Cần nhập mức lương thỏa thuận hợp lệ (lớn hơn 0) trước khi nhận việc.',
    en: 'A valid positive agreed wage is required before hiring.',
  },
  missing_start_date_for_hire: {
    vi: 'Cần nhập ngày bắt đầu làm việc hợp lệ (YYYY-MM-DD) trước khi nhận việc.',
    en: 'A valid start date (YYYY-MM-DD) is required before hiring.',
  },
  direct_hire_without_offer: {
    vi: 'Nhận việc trực tiếp không qua giai đoạn đề nghị (offer) bằng quyền ghi đè.',
    en: 'Hiring directly from a pre-offer stage via explicit override.',
  },
  reopened_from_rejected: {
    vi: 'Mở lại hồ sơ ứng viên từ trạng thái đã từ chối.',
    en: 'Candidate profile reopened from the rejected stage.',
  },
};

function transitionIssue(code: CandidateTransitionIssueCode): CandidateTransitionIssue {
  const msg = TRANSITION_MESSAGES[code];
  return { code, messageVi: msg.vi, messageEn: msg.en };
}

function hasValidPositiveWage(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined || raw.trim() === '') return false;
  try {
    return money(raw).greaterThan(0);
  } catch {
    return false;
  }
}

function hasValidStartDate(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  return isValidCalendarDate(raw.trim());
}

/**
 * Validates a recruiting pipeline stage transition deterministically without DB access.
 * - `'hired'` is terminal (no outgoing transitions).
 * - `'rejected'` cannot transition to `'hired'`, `'offer'`, or `'interview'`; returning to `'applied'` or `'screening'`
 *   requires `allowReopen: true`.
 * - Active pre-hire stages (`'applied'`, `'screening'`, `'interview'`, `'offer'`) may move between one another or to `'rejected'`.
 * - Moving to `'offer'` without `hasScheduledInterview: true` emits a `'missing_interview_before_offer'` warning.
 * - Moving to `'hired'` requires coming from `'offer'` (unless `allowDirectHire: true` from an active stage) plus valid
 *   positive `agreedWage` and valid `YYYY-MM-DD` `startDate`.
 */
export function checkCandidateTransition(input: CandidateTransitionInput): CandidateTransitionResult {
  const errors: CandidateTransitionIssue[] = [];
  const warnings: CandidateTransitionIssue[] = [];
  const { from, to } = input;

  if (!isRecruitingStage(from) || !isRecruitingStage(to) || from === to || from === 'hired') {
    errors.push(transitionIssue('invalid_stage_transition'));
  } else if (from === 'rejected') {
    if ((to === 'applied' || to === 'screening') && input.allowReopen === true) {
      warnings.push(transitionIssue('reopened_from_rejected'));
    } else {
      errors.push(transitionIssue('invalid_stage_transition'));
    }
  } else if (to === 'offer') {
    if (input.hasScheduledInterview !== true) {
      warnings.push(transitionIssue('missing_interview_before_offer'));
    }
  } else if (to === 'hired') {
    if (from !== 'offer') {
      if (input.allowDirectHire === true) {
        warnings.push(transitionIssue('direct_hire_without_offer'));
        if (input.hasScheduledInterview !== true) {
          warnings.push(transitionIssue('missing_interview_before_offer'));
        }
      } else {
        errors.push(transitionIssue('invalid_stage_transition'));
      }
    }
    if (!hasValidPositiveWage(input.agreedWage)) {
      errors.push(transitionIssue('missing_agreed_wage_for_hire'));
    }
    if (!hasValidStartDate(input.startDate)) {
      errors.push(transitionIssue('missing_start_date_for_hire'));
    }
  }

  return {
    allowed: errors.length === 0,
    warnings,
    errors,
    warningCodes: warnings.map((w) => w.code),
    errorCodes: errors.map((e) => e.code),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Candidate readiness & decimal-safe budget comparison
// ---------------------------------------------------------------------------------------------------------------------

export const RECRUITING_READINESS_FLAGS = [
  'above_budget',
  'below_budget',
  'within_budget',
  'missing_expected_wage',
  'missing_interview',
  'missing_offer_terms',
  'skills_gap',
] as const;
export type RecruitingReadinessFlag = (typeof RECRUITING_READINESS_FLAGS)[number];

export type WageComparison = 'within_budget' | 'above_budget' | 'below_budget' | 'missing_expected_wage' | 'no_budget_range';

export const INTERVIEW_FOCUS_CODES = [
  'verify_skills_gap',
  'align_expected_compensation',
  'confirm_expected_compensation',
  'probe_role_experience',
  'clarify_background_notes',
  'confirm_start_availability',
  'clarify_role_expectations',
] as const;
export type InterviewFocusCode = (typeof INTERVIEW_FOCUS_CODES)[number];

export interface InterviewFocusQuestion {
  code: InterviewFocusCode;
  vi: string;
  en: string;
}

export interface CandidateReadinessInput {
  stage: RecruitingStage;
  roleTitle?: string | null;
  yearsExperience?: number | null;
  skillsMatchedCount?: number | null;
  skillsRequiredCount?: number | null;
  hasNotes?: boolean | null;
  hasScheduledInterview?: boolean | null;
  expectedWage?: string | null;
  budgetMinWage?: string | null;
  budgetMaxWage?: string | null;
  agreedWage?: string | null;
  startDate?: string | null;
}

export interface CandidateReadinessResult {
  stage: RecruitingStage;
  flags: RecruitingReadinessFlag[];
  wageComparison: WageComparison;
  /** Positive distance outside `[budgetMinWage, budgetMaxWage]`, `'0'` when within budget, or `null` without a comparison. */
  wageVariance: string | null;
  skillsMatchedCount: number;
  skillsRequiredCount: number;
  missingSkillsCount: number;
  hasNotes: boolean;
  focusQuestions: InterviewFocusQuestion[];
}

function parseOptionalNonNegativeMoney(label: string, raw: string | null | undefined): DecimalValue | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const parsed = money(raw);
  if (parsed.isNegative()) throw new Error(`Amount for ${label} cannot be negative: ${raw}`);
  return parsed;
}

function nonNegativeInt(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function cleanRoleLabel(roleTitle: string | null | undefined, language: 'vi' | 'en'): string {
  const trimmed = (roleTitle ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed !== '') {
    const chars = Array.from(trimmed);
    return chars.length <= 80 ? trimmed : chars.slice(0, 77).join('').trimEnd() + '...';
  }
  return language === 'vi' ? 'vị trí này' : 'this role';
}

function buildFocusQuestions(
  flags: readonly RecruitingReadinessFlag[],
  input: CandidateReadinessInput,
  hasNotes: boolean,
): InterviewFocusQuestion[] {
  const roleVi = cleanRoleLabel(input.roleTitle, 'vi');
  const roleEn = cleanRoleLabel(input.roleTitle, 'en');
  const questions: InterviewFocusQuestion[] = [];
  const seen = new Set<InterviewFocusCode>();
  const add = (code: InterviewFocusCode, vi: string, en: string): void => {
    if (seen.has(code) || questions.length >= 5) return;
    seen.add(code);
    questions.push({ code, vi, en });
  };

  if (flags.includes('skills_gap')) {
    add(
      'verify_skills_gap',
      `Với những kỹ năng còn thiếu cho vị trí ${roleVi}, bạn đã từng tiếp cận công việc tương tự nào và cần bao lâu để bắt nhịp?`,
      `For the missing skills on ${roleEn}, what similar work have you handled and how would you ramp up?`,
    );
  }
  if (flags.includes('above_budget')) {
    add(
      'align_expected_compensation',
      `Mức thu nhập kỳ vọng của bạn đang cao hơn khung dự kiến cho ${roleVi}; bạn kỳ vọng gói đãi ngộ và lộ trình điều chỉnh như thế nào?`,
      `Your expected compensation is above our planned band for ${roleEn}; what total package and review cadence are you looking for?`,
    );
  } else if (flags.includes('missing_expected_wage')) {
    add(
      'confirm_expected_compensation',
      `Mức thu nhập kỳ vọng hiện tại của bạn cho vị trí ${roleVi} là bao nhiêu và bạn ưu tiên lương cứng hay thưởng hiệu suất?`,
      `What is your expected compensation for ${roleEn}, and how do you weigh fixed pay versus performance bonuses?`,
    );
  }
  add(
    'probe_role_experience',
    `Bạn có thể mô tả một kết quả công việc cụ thể gần đây liên quan trực tiếp đến vai trò ${roleVi}?`,
    `Can you walk through a recent concrete outcome from your work that directly applies to ${roleEn}?`,
  );
  if (!hasNotes) {
    add(
      'clarify_background_notes',
      `Điều gì khiến bạn quan tâm đến vị trí ${roleVi} tại thời điểm này và môi trường làm việc bạn mong muốn là gì?`,
      `What draws you to ${roleEn} right now, and what kind of day-to-day team workflow suits you best?`,
    );
  }
  add(
    'confirm_start_availability',
    'Nếu phù hợp, thời gian báo trước tại nơi làm việc hiện tại của bạn là bao lâu và ngày sớm nhất bạn có thể nhận việc?',
    'If we move forward, what is your current notice period and earliest realistic start date?',
  );
  if (questions.length < 3) {
    add(
      'clarify_role_expectations',
      `Trong giai đoạn đầu nhận vị trí ${roleVi}, bạn kỳ vọng được hỗ trợ gì từ quản lý trực tiếp?`,
      `In your initial period in ${roleEn}, what support or clarity do you expect most from your manager?`,
    );
  }

  return questions.slice(0, 5);
}

/**
 * Evaluates deterministic candidate readiness flags, decimal-safe wage band comparison, and 3-5 interview focus questions.
 */
export function evaluateCandidateReadiness(input: CandidateReadinessInput): CandidateReadinessResult {
  if (!isRecruitingStage(input.stage)) {
    throw new Error(`Invalid recruiting stage: ${String(input.stage)}`);
  }

  const expected = parseOptionalNonNegativeMoney('expectedWage', input.expectedWage);
  const budgetMin = parseOptionalNonNegativeMoney('budgetMinWage', input.budgetMinWage);
  const budgetMax = parseOptionalNonNegativeMoney('budgetMaxWage', input.budgetMaxWage);
  if (budgetMin !== null && budgetMax !== null && budgetMin.greaterThan(budgetMax)) {
    throw new Error('budgetMinWage cannot exceed budgetMaxWage');
  }

  const flags: RecruitingReadinessFlag[] = [];
  let wageComparison: WageComparison;
  let wageVariance: string | null = null;

  if (expected === null) {
    wageComparison = 'missing_expected_wage';
    flags.push('missing_expected_wage');
  } else if (budgetMax !== null && expected.greaterThan(budgetMax)) {
    wageComparison = 'above_budget';
    wageVariance = toMoney(expected.minus(budgetMax));
    flags.push('above_budget');
  } else if (budgetMin !== null && expected.lessThan(budgetMin)) {
    wageComparison = 'below_budget';
    wageVariance = toMoney(budgetMin.minus(expected));
    flags.push('below_budget');
  } else if (budgetMin !== null || budgetMax !== null) {
    wageComparison = 'within_budget';
    wageVariance = '0';
    flags.push('within_budget');
  } else {
    wageComparison = 'no_budget_range';
  }

  const skillsMatchedCount = nonNegativeInt(input.skillsMatchedCount);
  const skillsRequiredCount = Math.max(skillsMatchedCount, nonNegativeInt(input.skillsRequiredCount));
  const missingSkillsCount = Math.max(0, skillsRequiredCount - skillsMatchedCount);
  if (skillsRequiredCount > 0 && skillsMatchedCount < skillsRequiredCount) {
    flags.push('skills_gap');
  }

  const activePreHire = input.stage !== 'rejected' && input.stage !== 'hired';
  if (
    activePreHire &&
    (input.hasScheduledInterview === false ||
      ((input.stage === 'interview' || input.stage === 'offer') && input.hasScheduledInterview !== true))
  ) {
    flags.push('missing_interview');
  }

  if (
    (input.stage === 'offer' || input.stage === 'hired') &&
    (!hasValidPositiveWage(input.agreedWage) || !hasValidStartDate(input.startDate))
  ) {
    flags.push('missing_offer_terms');
  }

  const hasNotes = input.hasNotes === true;
  const focusQuestions = buildFocusQuestions(flags, input, hasNotes);

  return {
    stage: input.stage,
    flags,
    wageComparison,
    wageVariance,
    skillsMatchedCount,
    skillsRequiredCount,
    missingSkillsCount,
    hasNotes,
    focusQuestions,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Deterministic interview slot subtraction, slicing, and ranking
// ---------------------------------------------------------------------------------------------------------------------

export const INTERVIEW_DURATION_MIN_MINUTES = 15;
export const INTERVIEW_DURATION_MAX_MINUTES = 240;
export const INTERVIEW_DEFAULT_MAX_SLOTS = 10;
export const DEFAULT_RECRUITING_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export interface InterviewInterval {
  startIso: string;
  endIso: string;
}

export interface InterviewPreferredWindow {
  /** IANA time zone for evaluating the preferred wall-clock window (defaults to `'Asia/Ho_Chi_Minh'`). */
  timeZone?: string;
  /** Inclusive start minute after local midnight (`0..1439`). */
  startMinute: number;
  /** Exclusive end minute after local midnight (`1..1440`). */
  endMinute: number;
}

export interface RankInterviewSlotsInput {
  workingWindows: readonly InterviewInterval[];
  busyIntervals?: readonly InterviewInterval[];
  durationMinutes: number;
  maxSlots?: number;
  minGapMinutes?: number;
  stepMinutes?: number;
  afterIso?: string | null;
  preferredWindow?: InterviewPreferredWindow | null;
}

interface EpochRange {
  startMs: number;
  endMs: number;
}

function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = ISO_DATETIME_RE.exec(trimmed);
  if (!match) return null;
  const datePart = match[1] as string;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] !== undefined ? Number(match[4]) : 0;
  if (!isValidCalendarDate(datePart) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeRanges(intervals: readonly InterviewInterval[] | undefined): EpochRange[] {
  if (!intervals || intervals.length === 0) return [];
  const valid: EpochRange[] = [];
  for (const item of intervals) {
    if (!item || typeof item !== 'object') continue;
    const startMs = parseIsoInstant(item.startIso);
    const endMs = parseIsoInstant(item.endIso);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    valid.push({ startMs, endMs });
  }
  return mergeEpochRanges(valid);
}

function mergeEpochRanges(ranges: readonly EpochRange[]): EpochRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: EpochRange[] = [{ startMs: sorted[0]!.startMs, endMs: sorted[0]!.endMs }];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.startMs <= last.endMs) {
      if (cur.endMs > last.endMs) last.endMs = cur.endMs;
    } else {
      merged.push({ startMs: cur.startMs, endMs: cur.endMs });
    }
  }
  return merged;
}

function subtractEpochRanges(available: readonly EpochRange[], blocked: readonly EpochRange[]): EpochRange[] {
  if (available.length === 0 || blocked.length === 0) return available.map((r) => ({ ...r }));
  const result: EpochRange[] = [];
  let bIdx = 0;
  for (const win of available) {
    let cursor = win.startMs;
    while (bIdx < blocked.length && blocked[bIdx]!.endMs <= cursor) {
      bIdx += 1;
    }
    let j = bIdx;
    while (j < blocked.length && blocked[j]!.startMs < win.endMs) {
      const b = blocked[j]!;
      if (b.startMs > cursor) {
        result.push({ startMs: cursor, endMs: Math.min(b.startMs, win.endMs) });
      }
      if (b.endMs > cursor) {
        cursor = b.endMs;
      }
      if (cursor >= win.endMs) break;
      j += 1;
    }
    if (cursor < win.endMs) {
      result.push({ startMs: cursor, endMs: win.endMs });
    }
  }
  return result;
}

function intersectEpochRanges(left: readonly EpochRange[], right: readonly EpochRange[]): EpochRange[] {
  const out: EpochRange[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i]!;
    const b = right[j]!;
    const startMs = Math.max(a.startMs, b.startMs);
    const endMs = Math.min(a.endMs, b.endMs);
    if (endMs > startMs) {
      out.push({ startMs, endMs });
    }
    if (a.endMs < b.endMs) i += 1;
    else j += 1;
  }
  return out;
}

function findOffsetSubRange(
  timeZone: string,
  startMs: number,
  endMs: number,
  targetOffset: number,
): EpochRange | null {
  if (endMs <= startMs) return null;
  const startMatches = zoneOffsetMs(timeZone, startMs) === targetOffset;
  const endMatches = zoneOffsetMs(timeZone, endMs - 1) === targetOffset;
  if (startMatches && endMatches) {
    return { startMs, endMs };
  }
  if (!startMatches && !endMatches) {
    return null;
  }
  let lo = startMs;
  let hi = endMs - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midMatches = zoneOffsetMs(timeZone, mid) === targetOffset;
    if (startMatches === midMatches) lo = mid;
    else hi = mid;
  }
  return startMatches ? { startMs, endMs: hi } : { startMs: hi, endMs };
}

function preferredEpochWindows(
  ranges: readonly EpochRange[],
  timeZone: string,
  startMinute: number,
  endMinute: number,
): EpochRange[] {
  const windows: EpochRange[] = [];
  const seenDates = new Set<string>();
  for (const r of ranges) {
    let date = zonedDateString(timeZone, r.startMs - DAY_MS);
    const lastDate = zonedDateString(timeZone, r.endMs + DAY_MS);
    for (let guard = 0; date <= lastDate && guard < 4000; guard += 1, date = nextUtcDate(date)) {
      if (seenDates.has(date)) continue;
      seenDates.add(date);
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      const utcWallStart = Date.UTC(y, m - 1, d) + startMinute * MINUTE_MS;
      const utcWallEnd = Date.UTC(y, m - 1, d) + endMinute * MINUTE_MS;
      const offsets = new Set([
        zoneOffsetMs(timeZone, utcWallStart - DAY_MS),
        zoneOffsetMs(timeZone, utcWallStart),
        zoneOffsetMs(timeZone, utcWallEnd),
        zoneOffsetMs(timeZone, utcWallEnd + DAY_MS),
      ]);
      for (const offset of offsets) {
        const sub = findOffsetSubRange(timeZone, utcWallStart - offset, utcWallEnd - offset, offset);
        if (sub) windows.push(sub);
      }
    }
  }
  return mergeEpochRanges(windows);
}

function alignStartMs(ms: number, stepMs: number | null): number {
  if (stepMs === null) return ms;
  return Math.ceil(ms / stepMs) * stepMs;
}

function sliceNonOverlappingSlots(
  ranges: readonly EpochRange[],
  durationMs: number,
  gapMs: number,
  stepMs: number | null,
  maxSlots: number,
): EpochRange[] {
  if (maxSlots <= 0) return [];
  const slots: EpochRange[] = [];
  let minNextStartMs = -Infinity;
  for (const r of ranges) {
    let cursor = alignStartMs(Math.max(r.startMs, minNextStartMs), stepMs);
    while (cursor + durationMs <= r.endMs) {
      const endMs = cursor + durationMs;
      slots.push({ startMs: cursor, endMs });
      minNextStartMs = endMs + gapMs;
      if (slots.length >= maxSlots) return slots;
      cursor = alignStartMs(minNextStartMs, stepMs);
    }
  }
  return slots;
}

/**
 * Deterministically subtracts busy intervals (expanded by `minGapMinutes`) from working windows, slices
 * non-overlapping slots of `durationMinutes` (`15..240`), and ranks preferred time-of-day slots first.
 * Malformed or inverted intervals in `workingWindows` / `busyIntervals` are skipped cleanly; invalid
 * numeric options (`durationMinutes`, `minGapMinutes`, `maxSlots`, `stepMinutes`, `preferredWindow`, `afterIso`)
 * throw `RangeError`.
 */
export function rankInterviewSlots(input: RankInterviewSlotsInput): InterviewInterval[] {
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < INTERVIEW_DURATION_MIN_MINUTES ||
    input.durationMinutes > INTERVIEW_DURATION_MAX_MINUTES
  ) {
    throw new RangeError(
      `durationMinutes must be an integer between ${INTERVIEW_DURATION_MIN_MINUTES} and ${INTERVIEW_DURATION_MAX_MINUTES}`,
    );
  }
  const minGapMinutes = input.minGapMinutes ?? 0;
  if (!Number.isInteger(minGapMinutes) || minGapMinutes < 0 || minGapMinutes > 1440) {
    throw new RangeError('minGapMinutes must be an integer between 0 and 1440');
  }
  const maxSlots = input.maxSlots ?? INTERVIEW_DEFAULT_MAX_SLOTS;
  if (!Number.isInteger(maxSlots) || maxSlots < 0 || maxSlots > 1000) {
    throw new RangeError('maxSlots must be an integer between 0 and 1000');
  }
  let stepMs: number | null = null;
  if (input.stepMinutes !== undefined) {
    if (!Number.isInteger(input.stepMinutes) || input.stepMinutes < 1 || input.stepMinutes > 240) {
      throw new RangeError('stepMinutes must be an integer between 1 and 240');
    }
    stepMs = input.stepMinutes * MINUTE_MS;
  }

  let afterMs: number | null = null;
  if (input.afterIso !== undefined && input.afterIso !== null && input.afterIso.trim() !== '') {
    afterMs = parseIsoInstant(input.afterIso);
    if (afterMs === null) {
      throw new RangeError(`Invalid afterIso timestamp: ${input.afterIso}`);
    }
  }

  const pref = input.preferredWindow ?? null;
  let prefTimeZone = DEFAULT_RECRUITING_TIME_ZONE;
  if (pref !== null) {
    prefTimeZone = pref.timeZone ?? DEFAULT_RECRUITING_TIME_ZONE;
    assertValidTimeZone(prefTimeZone);
    if (
      !Number.isInteger(pref.startMinute) ||
      !Number.isInteger(pref.endMinute) ||
      pref.startMinute < 0 ||
      pref.startMinute >= 1440 ||
      pref.endMinute <= pref.startMinute ||
      pref.endMinute > 1440
    ) {
      throw new RangeError('preferredWindow minutes must satisfy 0 <= startMinute < endMinute <= 1440');
    }
  }

  if (maxSlots === 0) return [];

  let working = normalizeRanges(input.workingWindows);
  if (afterMs !== null) {
    const cutoff = afterMs;
    working = working
      .map((w) => ({ startMs: Math.max(w.startMs, cutoff), endMs: w.endMs }))
      .filter((w) => w.endMs > w.startMs);
  }
  if (working.length === 0) return [];

  const gapMs = minGapMinutes * MINUTE_MS;
  const durationMs = input.durationMinutes * MINUTE_MS;
  const rawBusy = normalizeRanges(input.busyIntervals);
  const expandedBusy = mergeEpochRanges(
    rawBusy.map((b) => ({ startMs: b.startMs - gapMs, endMs: b.endMs + gapMs })),
  );
  const freeRanges = subtractEpochRanges(working, expandedBusy);
  if (freeRanges.length === 0) return [];

  let chosen: EpochRange[];
  if (pref === null) {
    chosen = sliceNonOverlappingSlots(freeRanges, durationMs, gapMs, stepMs, maxSlots);
  } else {
    const prefWindows = preferredEpochWindows(freeRanges, prefTimeZone, pref.startMinute, pref.endMinute);
    const preferredRanges = intersectEpochRanges(freeRanges, prefWindows);
    const preferredSlots = sliceNonOverlappingSlots(preferredRanges, durationMs, gapMs, stepMs, maxSlots);
    const remainingSlotsNeeded = maxSlots - preferredSlots.length;
    if (remainingSlotsNeeded > 0) {
      const takenWithGap = mergeEpochRanges(
        preferredSlots.map((s) => ({ startMs: s.startMs - gapMs, endMs: s.endMs + gapMs })),
      );
      const remainingFree = subtractEpochRanges(freeRanges, takenWithGap);
      const fallbackSlots = sliceNonOverlappingSlots(
        remainingFree,
        durationMs,
        gapMs,
        stepMs,
        remainingSlotsNeeded,
      );
      chosen = [...preferredSlots, ...fallbackSlots];
    } else {
      chosen = preferredSlots;
    }
  }

  return chosen.map((s) => ({
    startIso: new Date(s.startMs).toISOString(),
    endIso: new Date(s.endMs).toISOString(),
  }));
}
