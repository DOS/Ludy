// SPDX-License-Identifier: AGPL-3.0-only
// Contract addendum, career timeline, and asset handover schemas (#4528 Stage 6C).
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const HR_ADDENDUM_STATUSES = ['draft', 'issued', 'voided'] as const;
export type HrAddendumStatus = (typeof HR_ADDENDUM_STATUSES)[number];

export const HR_ASSET_STATUSES = ['assigned', 'returned', 'lost_waived'] as const;
export type HrAssetStatus = (typeof HR_ASSET_STATUSES)[number];

export const HR_TIMELINE_EVENT_KINDS = [
  'employment_started',
  'probation_reviewed',
  'addendum_issued',
] as const;
export type HrTimelineEventKind = (typeof HR_TIMELINE_EVENT_KINDS)[number];

export const HR_ADDENDUM_CHECK_FINDING_CODES = [
  'missing_addendum_number',
  'missing_effective_date',
  'missing_summary',
  'missing_change_delta',
  'pay_rate_unchanged',
  'title_unchanged',
] as const;
export type HrAddendumCheckFindingCode = (typeof HR_ADDENDUM_CHECK_FINDING_CODES)[number];

export const HR_ADDENDUM_NUMBER_MAX = 80;
export const HR_ADDENDUM_SUMMARY_MAX = 2000;
export const HR_ADDENDUM_TITLE_MAX = 200;
export const HR_ADDENDUM_VOID_REASON_MAX = 500;
export const HR_ADDENDUM_PDF_MAX_BASE64_BYTES = 1_500_000;

export const HR_ASSET_CODE_MAX = 64;
export const HR_ASSET_NAME_MAX = 200;
export const HR_ASSET_SERIAL_MAX = 120;
export const HR_ASSET_NOTES_MAX = 1000;
export const HR_END_ASSET_OVERRIDE_NOTE_MAX = 500;

export const zHrAddendumMoney = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'decimal string');

export const zHrAddendumList = z.strictObject({
  employeeId: zId,
});
export type HrAddendumList = z.infer<typeof zHrAddendumList>;

export const zHrAddendumView = z.object({
  id: zId,
  employeeId: zId,
  employmentId: zId.nullable(),
  legalEntityId: zId,
  addendumNumber: z.string(),
  effectiveOn: zLocalDate,
  changeSummary: z.string(),
  previousPayRate: z.string().nullable(),
  newPayRate: z.string().nullable(),
  previousTitle: z.string().nullable(),
  newTitle: z.string().nullable(),
  status: z.enum(HR_ADDENDUM_STATUSES),
  issuedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrAddendumView = z.infer<typeof zHrAddendumView>;

export const zHrAddendumCreate = z.strictObject({
  employeeId: zId,
  employmentId: zId,
  addendumNumber: z.string().trim().min(1).max(HR_ADDENDUM_NUMBER_MAX),
  effectiveOn: zLocalDate,
  changeSummary: z.string().trim().min(1).max(HR_ADDENDUM_SUMMARY_MAX),
  previousPayRate: zHrAddendumMoney.nullable().optional(),
  newPayRate: zHrAddendumMoney.nullable().optional(),
  previousTitle: z.string().trim().min(1).max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
  newTitle: z.string().trim().min(1).max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
  issueImmediately: z.boolean().optional(),
});
export type HrAddendumCreate = z.infer<typeof zHrAddendumCreate>;

export const zHrAddendumUpdate = z.strictObject({
  addendumId: zId,
  effectiveOn: zLocalDate.optional(),
  changeSummary: z.string().trim().min(1).max(HR_ADDENDUM_SUMMARY_MAX).optional(),
  previousPayRate: zHrAddendumMoney.nullable().optional(),
  newPayRate: zHrAddendumMoney.nullable().optional(),
  previousTitle: z.string().trim().min(1).max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
  newTitle: z.string().trim().min(1).max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
});
export type HrAddendumUpdate = z.infer<typeof zHrAddendumUpdate>;

export const zHrAddendumIssue = z.strictObject({
  addendumId: zId,
});
export type HrAddendumIssue = z.infer<typeof zHrAddendumIssue>;

export const zHrAddendumVoid = z.strictObject({
  addendumId: zId,
  reason: z.string().trim().min(1).max(HR_ADDENDUM_VOID_REASON_MAX),
});
export type HrAddendumVoid = z.infer<typeof zHrAddendumVoid>;

export const zHrAddendumWriteResult = z.object({
  addendumId: zId,
  status: z.enum(HR_ADDENDUM_STATUSES),
});
export type HrAddendumWriteResult = z.infer<typeof zHrAddendumWriteResult>;

export const zHrAddendumPdfAsk = z.strictObject({
  addendumId: zId,
  includeSignTags: z.boolean().optional(),
});
export type HrAddendumPdfAsk = z.infer<typeof zHrAddendumPdfAsk>;

export const zHrAddendumPdfResult = z.object({
  addendumId: zId,
  filename: z.string(),
  contentType: z.literal('application/pdf'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pdfBase64: z.string().max(HR_ADDENDUM_PDF_MAX_BASE64_BYTES),
});
export type HrAddendumPdfResult = z.infer<typeof zHrAddendumPdfResult>;

export const zHrAddendumCheckAsk = z.strictObject({
  employeeId: zId,
  employmentId: zId,
  addendumNumber: z.string().trim().max(HR_ADDENDUM_NUMBER_MAX).optional(),
  effectiveOn: zLocalDate.optional(),
  changeSummary: z.string().trim().max(HR_ADDENDUM_SUMMARY_MAX).optional(),
  previousPayRate: zHrAddendumMoney.nullable().optional(),
  newPayRate: zHrAddendumMoney.nullable().optional(),
  previousTitle: z.string().trim().max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
  newTitle: z.string().trim().max(HR_ADDENDUM_TITLE_MAX).nullable().optional(),
  language: z.enum(['en', 'vi']).optional(),
  withAi: z.boolean().optional(),
});
export type HrAddendumCheckAsk = z.infer<typeof zHrAddendumCheckAsk>;

export const zHrAddendumCheckFinding = z.object({
  code: z.enum(HR_ADDENDUM_CHECK_FINDING_CODES),
  severity: z.enum(['error', 'warning']),
  detail: z.string(),
});
export type HrAddendumCheckFinding = z.infer<typeof zHrAddendumCheckFinding>;

export const zHrAddendumAiState = z.object({
  ok: z.boolean(),
  reason: z.enum(['ok', 'skipped', 'ai_off', 'kill_switch', 'budget_exhausted', 'unavailable', 'leak_refused']),
});
export type HrAddendumAiState = z.infer<typeof zHrAddendumAiState>;

export const zHrAddendumCheckResult = z.object({
  employeeId: zId,
  employmentId: zId,
  readyToIssue: z.boolean(),
  findings: z.array(zHrAddendumCheckFinding),
  lyNote: z.string().nullable(),
  ai: zHrAddendumAiState,
});
export type HrAddendumCheckResult = z.infer<typeof zHrAddendumCheckResult>;

export const zHrAddendumCheckAudit = z.strictObject({
  employeeId: zId,
  employmentId: zId,
  readyToIssue: z.boolean(),
  findingsCount: z.number().int().nonnegative(),
  aiReason: z.enum(['ok', 'skipped', 'ai_off', 'kill_switch', 'budget_exhausted', 'unavailable', 'leak_refused']),
});
export type HrAddendumCheckAudit = z.infer<typeof zHrAddendumCheckAudit>;

export const zHrAddendumAiStatusAsk = z.strictObject({});
export const zHrSelfAssetsAsk = z.strictObject({});

export const zHrTimelineAsk = z.strictObject({
  employeeId: zId,
});
export type HrTimelineAsk = z.infer<typeof zHrTimelineAsk>;

export const zHrTimelineEvent = z.object({
  id: z.string(),
  kind: z.enum(HR_TIMELINE_EVENT_KINDS),
  occurredOn: zLocalDate,
  title: z.string(),
  subtitle: z.string().nullable(),
  status: z.string(),
  refId: zId,
  metadata: z.object({
    contractType: z.string().nullable().optional(),
    baseWage: z.string().nullable().optional(),
    previousPayRate: z.string().nullable().optional(),
    newPayRate: z.string().nullable().optional(),
    previousTitle: z.string().nullable().optional(),
    newTitle: z.string().nullable().optional(),
    addendumNumber: z.string().nullable().optional(),
    decision: z.string().nullable().optional(),
    extendedUntil: z.string().nullable().optional(),
  }),
});
export type HrTimelineEvent = z.infer<typeof zHrTimelineEvent>;

export const zHrTimelineResult = z.object({
  employeeId: zId,
  events: z.array(zHrTimelineEvent),
});
export type HrTimelineResult = z.infer<typeof zHrTimelineResult>;

export const zHrAssetList = z.strictObject({
  employeeId: zId,
});
export type HrAssetList = z.infer<typeof zHrAssetList>;

export const zHrAssetView = z.object({
  id: zId,
  employeeId: zId,
  legalEntityId: zId,
  assetCode: z.string(),
  assetName: z.string(),
  serialNumber: z.string().nullable(),
  handedOverOn: zLocalDate,
  returnedOn: zLocalDate.nullable(),
  status: z.enum(HR_ASSET_STATUSES),
  notes: z.string().nullable(),
  clearedBy: zId.nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrAssetView = z.infer<typeof zHrAssetView>;

export const zHrSelfAssetView = z.object({
  id: zId,
  assetCode: z.string(),
  assetName: z.string(),
  serialNumber: z.string().nullable(),
  handedOverOn: zLocalDate,
  returnedOn: zLocalDate.nullable(),
  status: z.enum(HR_ASSET_STATUSES),
});
export type HrSelfAssetView = z.infer<typeof zHrSelfAssetView>;

export const zHrAssetAssign = z.strictObject({
  employeeId: zId,
  assetCode: z.string().trim().min(1).max(HR_ASSET_CODE_MAX),
  assetName: z.string().trim().min(1).max(HR_ASSET_NAME_MAX),
  serialNumber: z.string().trim().min(1).max(HR_ASSET_SERIAL_MAX).nullable().optional(),
  handedOverOn: zLocalDate,
  notes: z.string().trim().min(1).max(HR_ASSET_NOTES_MAX).nullable().optional(),
});
export type HrAssetAssign = z.infer<typeof zHrAssetAssign>;

export const zHrAssetUpdateStatus = z.strictObject({
  assetId: zId,
  status: z.enum(['returned', 'lost_waived']),
  returnedOn: zLocalDate.nullable().optional(),
  notes: z.string().trim().min(1).max(HR_ASSET_NOTES_MAX).nullable().optional(),
});
export type HrAssetUpdateStatus = z.infer<typeof zHrAssetUpdateStatus>;

export const zHrAssetWriteResult = z.object({
  assetId: zId,
  status: z.enum(HR_ASSET_STATUSES),
});
export type HrAssetWriteResult = z.infer<typeof zHrAssetWriteResult>;
