// SPDX-License-Identifier: AGPL-3.0-only
// Contract schemas for lightweight recruiting openings, candidate pipeline, calendar interviews, 1-click hire,
// and Ly screening brief (#3425, part of #3403 Stage 3 slice 3b-2).
import { z } from 'zod';
import { zTimeZone } from './calendar.ts';
import {
  HR_CONTRACT_FORMS,
  HR_CONTRACT_TYPES,
  HR_PAY_FUNCTIONS,
  HR_PROBATION_ROLE_TIERS,
  HR_REGIONS,
  zHrWage,
} from './hr.ts';
import { zId, zLocalDate } from './schemas.ts';

const zInstant = z.iso.datetime({ offset: true });
const zEmail = z.string().trim().email().max(320);
const zSkill = z.string().trim().min(1).max(60);
const zSkills = z.array(zSkill).max(30);

export const HR_JOB_OPENING_STATUSES = ['open', 'closed'] as const;
export type HrJobOpeningStatus = (typeof HR_JOB_OPENING_STATUSES)[number];

export const HR_CANDIDATE_STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const;
export type HrCandidateStage = (typeof HR_CANDIDATE_STAGES)[number];

export const HR_CANDIDATE_TRANSITION_STAGES = ['applied', 'screening', 'interview', 'offer', 'rejected'] as const;
export type HrCandidateTransitionStage = (typeof HR_CANDIDATE_TRANSITION_STAGES)[number];

export const HR_RECRUITING_READINESS_FLAGS = [
  'above_budget',
  'below_budget',
  'within_budget',
  'missing_expected_wage',
  'missing_interview',
  'missing_offer_terms',
  'skills_gap',
] as const;
export type HrRecruitingReadinessFlag = (typeof HR_RECRUITING_READINESS_FLAGS)[number];

export const HR_WAGE_COMPARISONS = [
  'within_budget',
  'above_budget',
  'below_budget',
  'missing_expected_wage',
  'no_budget_range',
] as const;
export type HrWageComparison = (typeof HR_WAGE_COMPARISONS)[number];

export const HR_INTERVIEW_FOCUS_CODES = [
  'verify_skills_gap',
  'align_expected_compensation',
  'confirm_expected_compensation',
  'probe_role_experience',
  'clarify_background_notes',
  'confirm_start_availability',
  'clarify_role_expectations',
] as const;
export type HrInterviewFocusCode = (typeof HR_INTERVIEW_FOCUS_CODES)[number];

export const HR_RECRUITING_BRIEF_REASONS = ['ok', 'off', 'budget', 'unavailable', 'refused'] as const;
export type HrRecruitingBriefReason = (typeof HR_RECRUITING_BRIEF_REASONS)[number];

// Compare non-negative decimal wage strings (up to 2 decimal places) cleanly without JS float precision loss.
function wageToCents(raw: string): bigint {
  const [whole, frac = ''] = raw.split('.');
  return BigInt(whole || '0') * 100n + BigInt(frac.padEnd(2, '0'));
}

export const zHrOpeningView = z.strictObject({
  id: zId,
  legalEntityId: zId,
  departmentId: zId.nullable(),
  title: z.string(),
  departmentName: z.string().nullable(),
  contractType: z.enum(HR_CONTRACT_TYPES),
  region: z.enum(HR_REGIONS),
  payFunction: z.enum(HR_PAY_FUNCTIONS),
  budgetMinWage: zHrWage.nullable(),
  budgetMaxWage: zHrWage.nullable(),
  requiredSkills: z.array(z.string()),
  status: z.enum(HR_JOB_OPENING_STATUSES),
  closedAt: zInstant.nullable(),
  candidateCount: z.number().int().nonnegative(),
  createdAt: zInstant,
  updatedAt: zInstant,
});
export type HrOpeningView = z.infer<typeof zHrOpeningView>;

export const zHrOpeningList = z.strictObject({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  legalEntityId: zId.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrOpeningList = z.input<typeof zHrOpeningList>;

export const zHrOpeningAdd = z
  .strictObject({
    legalEntityId: zId.optional(),
    departmentId: zId.nullable().optional(),
    title: z.string().trim().min(1).max(160),
    departmentName: z.string().trim().min(1).max(120).nullable().optional(),
    contractType: z.enum(HR_CONTRACT_TYPES).default('indefinite'),
    region: z.enum(HR_REGIONS).default('I'),
    payFunction: z.enum(HR_PAY_FUNCTIONS).optional(),
    budgetMinWage: zHrWage.nullable().optional(),
    budgetMaxWage: zHrWage.nullable().optional(),
    requiredSkills: zSkills.default([]),
  })
  .refine(
    (v) =>
      !zHrWage.safeParse(v.budgetMinWage).success ||
      !zHrWage.safeParse(v.budgetMaxWage).success ||
      wageToCents(v.budgetMaxWage as string) >= wageToCents(v.budgetMinWage as string),
    { message: 'budgetMaxWage must be greater than or equal to budgetMinWage', path: ['budgetMaxWage'] },
  );
export type HrOpeningAdd = z.input<typeof zHrOpeningAdd>;

export const zHrOpeningEdit = z
  .strictObject({
    openingId: zId,
    departmentId: zId.nullable().optional(),
    title: z.string().trim().min(1).max(160).optional(),
    departmentName: z.string().trim().min(1).max(120).nullable().optional(),
    contractType: z.enum(HR_CONTRACT_TYPES).optional(),
    region: z.enum(HR_REGIONS).optional(),
    payFunction: z.enum(HR_PAY_FUNCTIONS).optional(),
    budgetMinWage: zHrWage.nullable().optional(),
    budgetMaxWage: zHrWage.nullable().optional(),
    requiredSkills: zSkills.optional(),
  })
  .refine(
    (v) =>
      !zHrWage.safeParse(v.budgetMinWage).success ||
      !zHrWage.safeParse(v.budgetMaxWage).success ||
      wageToCents(v.budgetMaxWage as string) >= wageToCents(v.budgetMinWage as string),
    { message: 'budgetMaxWage must be greater than or equal to budgetMinWage', path: ['budgetMaxWage'] },
  );
export type HrOpeningEdit = z.input<typeof zHrOpeningEdit>;

export const zHrOpeningClose = z.strictObject({
  openingId: zId,
  reopen: z.boolean().default(false),
});
export type HrOpeningClose = z.input<typeof zHrOpeningClose>;

export const zHrOpeningWritten = z.strictObject({
  openingId: zId,
  legalEntityId: zId,
  status: z.enum(HR_JOB_OPENING_STATUSES),
});
export type HrOpeningWritten = z.infer<typeof zHrOpeningWritten>;

export const zHrCandidateView = z.strictObject({
  id: zId,
  legalEntityId: zId,
  openingId: zId.nullable(),
  openingTitle: z.string().nullable(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  displayName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  stage: z.enum(HR_CANDIDATE_STAGES),
  yearsExperience: z.number().int().nullable(),
  matchedSkills: z.array(z.string()),
  expectedWage: zHrWage.nullable(),
  agreedWage: zHrWage.nullable(),
  plannedStartOn: zLocalDate.nullable(),
  notes: z.string().nullable(),
  interviewEventId: zId.nullable(),
  interviewStartsAt: zInstant.nullable(),
  interviewEndsAt: zInstant.nullable(),
  hiredEmployeeId: zId.nullable(),
  erasedAt: zInstant.nullable(),
  createdAt: zInstant,
  updatedAt: zInstant,
});
export type HrCandidateView = z.infer<typeof zHrCandidateView>;

export const zHrCandidateList = z.strictObject({
  openingId: zId.optional(),
  stage: z.enum(HR_CANDIDATE_STAGES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrCandidateList = z.input<typeof zHrCandidateList>;

export const zHrCandidateRef = z.strictObject({
  candidateId: zId,
});
export type HrCandidateRef = z.infer<typeof zHrCandidateRef>;

export const zHrCandidateAdd = z.strictObject({
  legalEntityId: zId.optional(),
  openingId: zId.nullable().optional(),
  displayName: z.string().trim().min(1).max(200),
  email: zEmail.nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(80).nullable().optional(),
  matchedSkills: zSkills.default([]),
  expectedWage: zHrWage.nullable().optional(),
  agreedWage: zHrWage.nullable().optional(),
  plannedStartOn: zLocalDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type HrCandidateAdd = z.input<typeof zHrCandidateAdd>;

export const zHrCandidateEdit = z.strictObject({
  candidateId: zId,
  openingId: zId.nullable().optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  email: zEmail.nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(80).nullable().optional(),
  matchedSkills: zSkills.optional(),
  expectedWage: zHrWage.nullable().optional(),
  agreedWage: zHrWage.nullable().optional(),
  plannedStartOn: zLocalDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type HrCandidateEdit = z.input<typeof zHrCandidateEdit>;

export const zHrCandidateMoveStage = z.strictObject({
  candidateId: zId,
  toStage: z.enum(HR_CANDIDATE_TRANSITION_STAGES),
  agreedWage: zHrWage.nullable().optional(),
  plannedStartOn: zLocalDate.nullable().optional(),
  allowReopen: z.boolean().default(false),
});
export type HrCandidateMoveStage = z.input<typeof zHrCandidateMoveStage>;

export const zHrCandidateWritten = z.strictObject({
  candidateId: zId,
  legalEntityId: zId,
  stage: z.enum(HR_CANDIDATE_STAGES),
});
export type HrCandidateWritten = z.infer<typeof zHrCandidateWritten>;

export const zHrInterviewSlotsAsk = z
  .strictObject({
    from: zInstant.optional(),
    to: zInstant.optional(),
    durationMinutes: z.number().int().min(15).max(240).default(45),
    maxSlots: z.number().int().min(1).max(30).default(8),
    minGapMinutes: z.number().int().min(0).max(240).default(15),
    stepMinutes: z.number().int().min(5).max(120).optional(),
    exceptEventId: zId.optional(),
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
    message: 'to must be after from',
    path: ['to'],
  });
export type HrInterviewSlotsAsk = z.input<typeof zHrInterviewSlotsAsk>;

export const zHrInterviewSlot = z.strictObject({
  startIso: zInstant,
  endIso: zInstant,
});
export type HrInterviewSlot = z.infer<typeof zHrInterviewSlot>;

export const zHrInterviewSlotsResult = z.strictObject({
  timeZone: zTimeZone,
  hoursSaved: z.boolean(),
  slots: z.array(zHrInterviewSlot),
});
export type HrInterviewSlotsResult = z.infer<typeof zHrInterviewSlotsResult>;

export const zHrCandidateScheduleInterview = z
  .strictObject({
    candidateId: zId,
    startsAt: zInstant,
    endsAt: zInstant,
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type HrCandidateScheduleInterview = z.infer<typeof zHrCandidateScheduleInterview>;

export const zHrCandidateInterviewScheduled = z.strictObject({
  candidateId: zId,
  eventId: zId,
  startsAt: zInstant,
  endsAt: zInstant,
  stage: z.enum(HR_CANDIDATE_STAGES),
});
export type HrCandidateInterviewScheduled = z.infer<typeof zHrCandidateInterviewScheduled>;

export const zHrCandidateHire = z.strictObject({
  candidateId: zId,
  departmentId: zId.nullable().optional(),
  jobTitle: z.string().trim().min(1).max(160).nullable().optional(),
  effectiveFrom: zLocalDate.optional(),
  contractType: z.enum(HR_CONTRACT_TYPES).optional(),
  region: z.enum(HR_REGIONS).optional(),
  payFunction: z.enum(HR_PAY_FUNCTIONS).optional(),
  baseWage: zHrWage.optional(),
  contractForm: z.enum(HR_CONTRACT_FORMS).nullable().optional(),
  termMonths: z.number().int().min(1).max(36).nullable().optional(),
  contractEndOn: zLocalDate.nullable().optional(),
  fixedTermSequence: z.number().int().min(1).max(2).nullable().optional(),
  probationRoleTier: z.enum(HR_PROBATION_ROLE_TIERS).nullable().optional(),
  probationEndOn: zLocalDate.nullable().optional(),
  probationWage: zHrWage.nullable().optional(),
  allowDirectHire: z.boolean().default(false),
});
export type HrCandidateHire = z.input<typeof zHrCandidateHire>;

export const zHrCandidateHireResult = z.strictObject({
  candidateId: zId,
  employeeId: zId,
  employmentId: zId,
  legalEntityId: zId,
  stage: z.literal('hired'),
});
export type HrCandidateHireResult = z.infer<typeof zHrCandidateHireResult>;

export const zHrCandidateEraseResult = z.strictObject({
  candidateId: zId,
  erasedAt: zInstant,
});
export type HrCandidateEraseResult = z.infer<typeof zHrCandidateEraseResult>;

export const zHrRecruitingBriefAsk = z.strictObject({
  candidateId: zId,
  lang: z.enum(['vi', 'en']).default('vi'),
});
export type HrRecruitingBriefAsk = z.input<typeof zHrRecruitingBriefAsk>;

export const zHrRecruitingBriefAudit = z.strictObject({
  candidateId: zId,
  aiReason: z.enum(HR_RECRUITING_BRIEF_REASONS),
});
export type HrRecruitingBriefAudit = z.infer<typeof zHrRecruitingBriefAudit>;

export const zHrRecruitingFocusQuestion = z.strictObject({
  code: z.enum(HR_INTERVIEW_FOCUS_CODES),
  vi: z.string(),
  en: z.string(),
});

export const zHrRecruitingReadiness = z.strictObject({
  stage: z.enum(HR_CANDIDATE_STAGES),
  flags: z.array(z.enum(HR_RECRUITING_READINESS_FLAGS)),
  wageComparison: z.enum(HR_WAGE_COMPARISONS),
  wageVariance: z.string().nullable(),
  skillsMatchedCount: z.number().int().nonnegative(),
  skillsRequiredCount: z.number().int().nonnegative(),
  missingSkillsCount: z.number().int().nonnegative(),
  hasNotes: z.boolean(),
  focusQuestions: z.array(zHrRecruitingFocusQuestion),
});

export const zHrRecruitingBriefResult = z.strictObject({
  candidateId: zId,
  readiness: zHrRecruitingReadiness,
  summary: z.string(),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  interviewQuestions: z.array(z.string()),
  ai: z.strictObject({
    ok: z.boolean(),
    reason: z.enum(HR_RECRUITING_BRIEF_REASONS),
  }),
});
export type HrRecruitingBriefResult = z.infer<typeof zHrRecruitingBriefResult>;
