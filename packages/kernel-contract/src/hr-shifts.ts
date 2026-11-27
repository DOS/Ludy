// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 7A (#5216): SME shift templates, weekly roster assignments, 1-step shift swaps,
// deterministic coverage conflict detection, and Ly shift coverage suggestion contracts.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const HR_SHIFT_CODE_MAX = 64;
export const HR_SHIFT_NAME_MAX = 200;
export const HR_SHIFT_NOTE_MAX = 500;
export const HR_SHIFT_SWAP_REASON_MAX = 1000;

export const HR_SHIFT_SWAP_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type HrShiftSwapStatus = (typeof HR_SHIFT_SWAP_STATUSES)[number];

export const HR_SHIFT_CONFLICT_KINDS = ['approved_leave', 'approved_trip', 'public_holiday', 'short_rest'] as const;
export type HrShiftConflictKind = (typeof HR_SHIFT_CONFLICT_KINDS)[number];

export const HR_SHIFT_COVERAGE_AI_REASONS = ['ok', 'off', 'budget', 'rate_limited', 'refused', 'unavailable'] as const;
export type HrShiftCoverageAiReason = (typeof HR_SHIFT_COVERAGE_AI_REASONS)[number];

export interface HrDefaultShiftPreset {
  readonly code: string;
  readonly name: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakMinutes: number;
  readonly graceLateMinutes: number;
  readonly graceEarlyMinutes: number;
  readonly crossesMidnight: boolean;
}

export const HR_DEFAULT_SHIFT_TEMPLATES: readonly HrDefaultShiftPreset[] = [
  {
    code: 'CA_HC',
    name: 'Ca hành chính',
    startMinute: 8 * 60,
    endMinute: 17 * 60,
    breakMinutes: 60,
    graceLateMinutes: 15,
    graceEarlyMinutes: 15,
    crossesMidnight: false,
  },
  {
    code: 'CA_SANG',
    name: 'Ca sáng',
    startMinute: 6 * 60,
    endMinute: 14 * 60,
    breakMinutes: 0,
    graceLateMinutes: 15,
    graceEarlyMinutes: 15,
    crossesMidnight: false,
  },
  {
    code: 'CA_CHIEU',
    name: 'Ca chiều',
    startMinute: 14 * 60,
    endMinute: 22 * 60,
    breakMinutes: 0,
    graceLateMinutes: 15,
    graceEarlyMinutes: 15,
    crossesMidnight: false,
  },
  {
    code: 'CA_DEM',
    name: 'Ca đêm',
    startMinute: 22 * 60,
    endMinute: 6 * 60,
    breakMinutes: 0,
    graceLateMinutes: 15,
    graceEarlyMinutes: 15,
    crossesMidnight: true,
  },
] as const;

export function shiftDurationMinutes(startMinute: number, endMinute: number, crossesMidnight: boolean): number {
  return crossesMidnight ? 1440 - startMinute + endMinute : endMinute - startMinute;
}

export function isValidShiftWindow(
  startMinute: number,
  endMinute: number,
  breakMinutes: number,
  crossesMidnight: boolean,
): boolean {
  if (!crossesMidnight && endMinute <= startMinute) return false;
  const dur = shiftDurationMinutes(startMinute, endMinute, crossesMidnight);
  return dur > breakMinutes && dur <= 1440;
}

const zShiftCode = z
  .string()
  .trim()
  .min(1)
  .max(HR_SHIFT_CODE_MAX)
  .regex(/^[A-Za-z0-9_-]+$/, 'code must use ASCII letters, numbers, underscores, or hyphens')
  .transform((v) => v.toUpperCase());
const zShiftName = z.string().trim().min(1).max(HR_SHIFT_NAME_MAX);
const zMinute = z.number().int().min(0).max(1439);
const zBreak = z.number().int().min(0).max(480);
const zGrace = z.number().int().min(0).max(120);

export const zHrShiftTemplateView = z.object({
  id: zId,
  legalEntityId: zId,
  code: z.string(),
  name: z.string(),
  startMinute: zMinute,
  endMinute: zMinute,
  breakMinutes: zBreak,
  graceLateMinutes: zGrace,
  graceEarlyMinutes: zGrace,
  crossesMidnight: z.boolean(),
  durationMinutes: z.number().int().min(1).max(1440),
  archivedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type HrShiftTemplateView = z.infer<typeof zHrShiftTemplateView>;

export const zHrShiftTemplateList = z.strictObject({
  legalEntityId: zId.optional(),
  includeArchived: z.boolean().default(false),
});
export type HrShiftTemplateList = z.input<typeof zHrShiftTemplateList>;

export const zHrShiftTemplateListResult = z.object({
  legalEntityId: zId,
  templates: z.array(zHrShiftTemplateView),
});
export type HrShiftTemplateListResult = z.infer<typeof zHrShiftTemplateListResult>;

export const zHrShiftTemplateCreate = z
  .strictObject({
    legalEntityId: zId.optional(),
    code: zShiftCode,
    name: zShiftName,
    startMinute: zMinute,
    endMinute: zMinute,
    breakMinutes: zBreak.default(60),
    graceLateMinutes: zGrace.default(15),
    graceEarlyMinutes: zGrace.default(15),
    crossesMidnight: z.boolean().default(false),
  })
  .refine(
    (v) => isValidShiftWindow(v.startMinute, v.endMinute, v.breakMinutes, v.crossesMidnight),
    {
      message: 'shift duration must exceed breakMinutes and respect crossesMidnight window (max 24h)',
      path: ['endMinute'],
    },
  );
export type HrShiftTemplateCreate = z.input<typeof zHrShiftTemplateCreate>;

export const zHrShiftTemplateUpdate = z
  .strictObject({
    templateId: zId,
    code: zShiftCode.optional(),
    name: zShiftName.optional(),
    startMinute: zMinute.optional(),
    endMinute: zMinute.optional(),
    breakMinutes: zBreak.optional(),
    graceLateMinutes: zGrace.optional(),
    graceEarlyMinutes: zGrace.optional(),
    crossesMidnight: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.code !== undefined ||
      v.name !== undefined ||
      v.startMinute !== undefined ||
      v.endMinute !== undefined ||
      v.breakMinutes !== undefined ||
      v.graceLateMinutes !== undefined ||
      v.graceEarlyMinutes !== undefined ||
      v.crossesMidnight !== undefined,
    { message: 'at least one template field must be provided' },
  );
export type HrShiftTemplateUpdate = z.input<typeof zHrShiftTemplateUpdate>;

export const zHrShiftTemplateArchive = z.strictObject({
  templateId: zId,
});
export type HrShiftTemplateArchive = z.input<typeof zHrShiftTemplateArchive>;

export const zHrShiftTemplateSeedDefaults = z.strictObject({
  legalEntityId: zId.optional(),
});
export type HrShiftTemplateSeedDefaults = z.input<typeof zHrShiftTemplateSeedDefaults>;

export const zHrShiftTemplateSeedResult = z.object({
  legalEntityId: zId,
  createdCount: z.number().int().min(0),
  templates: z.array(zHrShiftTemplateView),
});
export type HrShiftTemplateSeedResult = z.infer<typeof zHrShiftTemplateSeedResult>;

export const zHrShiftRosterGet = z.strictObject({
  legalEntityId: zId.optional(),
  weekStart: zLocalDate.optional(),
  departmentId: zId.optional(),
});
export type HrShiftRosterGet = z.input<typeof zHrShiftRosterGet>;

export const zHrShiftRosterEmployee = z.object({
  id: zId,
  displayName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
});
export type HrShiftRosterEmployee = z.infer<typeof zHrShiftRosterEmployee>;

export const zHrShiftAssignmentView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  shiftTemplateId: zId,
  shiftCode: z.string(),
  shiftName: z.string(),
  startMinute: zMinute,
  endMinute: zMinute,
  breakMinutes: zBreak,
  graceLateMinutes: zGrace,
  graceEarlyMinutes: zGrace,
  crossesMidnight: z.boolean(),
  workDate: zLocalDate,
  note: z.string().nullable(),
  updatedAt: z.string(),
});
export type HrShiftAssignmentView = z.infer<typeof zHrShiftAssignmentView>;

export const zHrShiftRosterResult = z.object({
  legalEntityId: zId,
  weekStart: zLocalDate,
  weekEnd: zLocalDate,
  canManageOrgRoster: z.boolean(),
  manageableDepartmentIds: z.array(zId),
  templates: z.array(zHrShiftTemplateView),
  employees: z.array(zHrShiftRosterEmployee),
  assignments: z.array(zHrShiftAssignmentView),
  pendingSwapsCount: z.number().int().min(0),
});
export type HrShiftRosterResult = z.infer<typeof zHrShiftRosterResult>;

export const zHrShiftAssignmentUpsert = z.strictObject({
  legalEntityId: zId.optional(),
  employeeId: zId,
  shiftTemplateId: zId,
  workDate: zLocalDate,
  note: z.string().trim().max(HR_SHIFT_NOTE_MAX).nullable().optional(),
});
export type HrShiftAssignmentUpsert = z.input<typeof zHrShiftAssignmentUpsert>;

export const zHrShiftAssignmentDelete = z.strictObject({
  assignmentId: zId,
});
export type HrShiftAssignmentDelete = z.input<typeof zHrShiftAssignmentDelete>;

export const zHrShiftAssignmentDeleteResult = z.object({
  assignmentId: zId,
  deleted: z.literal(true),
});
export type HrShiftAssignmentDeleteResult = z.infer<typeof zHrShiftAssignmentDeleteResult>;

export const zHrShiftSwapView = z.object({
  id: zId,
  legalEntityId: zId,
  requesterEmployeeId: zId,
  requesterName: z.string(),
  targetEmployeeId: zId,
  targetName: z.string(),
  requesterAssignmentId: zId,
  requesterShiftCode: z.string(),
  requesterShiftName: z.string(),
  targetAssignmentId: zId.nullable(),
  targetShiftCode: z.string().nullable(),
  targetShiftName: z.string().nullable(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  workDate: zLocalDate,
  reason: z.string().nullable(),
  status: z.enum(HR_SHIFT_SWAP_STATUSES),
  decidedBy: zId.nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrShiftSwapView = z.infer<typeof zHrShiftSwapView>;

export const zHrShiftSwapPeerOption = z.object({
  id: zId,
  displayName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
});
export type HrShiftSwapPeerOption = z.infer<typeof zHrShiftSwapPeerOption>;

export const zHrSelfShiftsList = z.strictObject({
  weekStart: zLocalDate.optional(),
});
export type HrSelfShiftsList = z.input<typeof zHrSelfShiftsList>;

export const zHrSelfShiftsResult = z.object({
  employeeId: zId,
  legalEntityId: zId,
  departmentId: zId.nullable(),
  weekStart: zLocalDate,
  weekEnd: zLocalDate,
  assignments: z.array(zHrShiftAssignmentView),
  peerCandidates: z.array(zHrShiftSwapPeerOption),
  swaps: z.array(zHrShiftSwapView),
});
export type HrSelfShiftsResult = z.infer<typeof zHrSelfShiftsResult>;

export const zHrSelfShiftSwapSubmit = z.strictObject({
  requesterAssignmentId: zId,
  targetEmployeeId: zId,
  reason: z.string().trim().max(HR_SHIFT_SWAP_REASON_MAX).nullable().optional(),
});
export type HrSelfShiftSwapSubmit = z.input<typeof zHrSelfShiftSwapSubmit>;

export const zHrSelfShiftSwapCancel = z.strictObject({
  swapId: zId,
});
export type HrSelfShiftSwapCancel = z.input<typeof zHrSelfShiftSwapCancel>;

export const zHrShiftSwapList = z.strictObject({
  legalEntityId: zId.optional(),
  status: z.enum(HR_SHIFT_SWAP_STATUSES).optional(),
  weekStart: zLocalDate.optional(),
  departmentId: zId.optional(),
});
export type HrShiftSwapList = z.input<typeof zHrShiftSwapList>;

export const zHrShiftSwapListResult = z.object({
  legalEntityId: zId,
  swaps: z.array(zHrShiftSwapView),
});
export type HrShiftSwapListResult = z.infer<typeof zHrShiftSwapListResult>;

export const zHrShiftSwapDecide = z.strictObject({
  swapId: zId,
  decisionNote: z.string().trim().max(HR_SHIFT_SWAP_REASON_MAX).nullable().optional(),
});
export type HrShiftSwapDecide = z.input<typeof zHrShiftSwapDecide>;

export const zHrShiftCoverageConflict = z.object({
  assignmentId: zId,
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  shiftTemplateId: zId,
  shiftCode: z.string(),
  shiftName: z.string(),
  workDate: zLocalDate,
  kind: z.enum(HR_SHIFT_CONFLICT_KINDS),
  detail: z.string(),
});
export type HrShiftCoverageConflict = z.infer<typeof zHrShiftCoverageConflict>;

export const zHrShiftCoverageCandidate = z.object({
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  weeklyShiftCount: z.number().int().min(0),
  hasAdjacentRestGap: z.boolean(),
});
export type HrShiftCoverageCandidate = z.infer<typeof zHrShiftCoverageCandidate>;

export const zHrShiftCoverageGap = z.object({
  date: zLocalDate,
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  shiftCode: z.string().nullable(),
  shiftName: z.string().nullable(),
  reason: z.string(),
  candidates: z.array(zHrShiftCoverageCandidate),
});
export type HrShiftCoverageGap = z.infer<typeof zHrShiftCoverageGap>;

export const zHrShiftCoverageAsk = z.strictObject({
  legalEntityId: zId.optional(),
  weekStart: zLocalDate.optional(),
  departmentId: zId.optional(),
  lang: z.enum(['vi', 'en']).optional(),
});
export type HrShiftCoverageAsk = z.input<typeof zHrShiftCoverageAsk>;

export const zHrShiftCoverageSnapshot = z.object({
  legalEntityId: zId,
  weekStart: zLocalDate,
  weekEnd: zLocalDate,
  lang: z.enum(['vi', 'en']),
  conflicts: z.array(zHrShiftCoverageConflict),
  gaps: z.array(zHrShiftCoverageGap),
  eligibleCandidates: z.array(zHrShiftCoverageCandidate),
});
export type HrShiftCoverageSnapshot = z.infer<typeof zHrShiftCoverageSnapshot>;

export const zHrShiftCoverageSuggestion = z.object({
  workDate: zLocalDate,
  targetEmployeeId: zId.nullable(),
  targetEmployeeName: z.string().nullable(),
  suggestedCandidateId: zId.nullable(),
  suggestedCandidateName: z.string().nullable(),
  note: z.string(),
});
export type HrShiftCoverageSuggestion = z.infer<typeof zHrShiftCoverageSuggestion>;

export const zHrShiftCoverageAiStatus = z.object({
  ok: z.boolean(),
  reason: z.enum(HR_SHIFT_COVERAGE_AI_REASONS),
});
export type HrShiftCoverageAiStatus = z.infer<typeof zHrShiftCoverageAiStatus>;

export const zHrShiftCoverageBrief = z.object({
  legalEntityId: zId,
  weekStart: zLocalDate,
  weekEnd: zLocalDate,
  conflicts: z.array(zHrShiftCoverageConflict),
  gaps: z.array(zHrShiftCoverageGap),
  eligibleCandidates: z.array(zHrShiftCoverageCandidate),
  summary: z.string(),
  highlights: z.array(z.string()),
  suggestions: z.array(zHrShiftCoverageSuggestion),
  ai: zHrShiftCoverageAiStatus,
});
export type HrShiftCoverageBrief = z.infer<typeof zHrShiftCoverageBrief>;

export const zHrShiftCoverageAudit = z.object({
  legalEntityId: zId,
  weekStart: zLocalDate,
  aiReason: z.enum(HR_SHIFT_COVERAGE_AI_REASONS),
  conflictCount: z.number().int().min(0),
});
export type HrShiftCoverageAudit = z.infer<typeof zHrShiftCoverageAudit>;
