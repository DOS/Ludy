// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6A self-service request drafting and cited HR policy Q&A contracts (#4526, /hr/my).
import { z } from 'zod';
import { HR_LEAVE_REQUEST_KINDS, zHrLeaveRequestDays } from './hr-leave.ts';
import { HR_OVERTIME_DAY_TYPES, zHrOvertimeHours } from './hr-overtime.ts';
import { zId, zLocalDate } from './schemas.ts';

const noNul = (value: string): boolean => !value.includes('\0');

export const HR_SELF_REQUEST_DRAFT_KINDS = [
  'leave',
  'overtime',
  'business_trip_unsupported',
  'unknown',
] as const;
export type HrSelfRequestDraftKind = (typeof HR_SELF_REQUEST_DRAFT_KINDS)[number];

export const HR_SELF_REQUEST_HALF_DAY_SESSIONS = ['morning', 'afternoon'] as const;
export type HrSelfRequestHalfDaySession = (typeof HR_SELF_REQUEST_HALF_DAY_SESSIONS)[number];

export const HR_SELF_REQUEST_AI_STATUSES = [
  'used',
  'off',
  'busy',
  'budget',
  'failed',
  'refused',
] as const;
export type HrSelfRequestAiStatus = (typeof HR_SELF_REQUEST_AI_STATUSES)[number];

export const HR_SELF_POLICY_QA_STATUSES = [
  'used',
  'off',
  'busy',
  'budget',
  'failed',
  'refused',
  'no_matches',
  'notes_off',
] as const;
export type HrSelfPolicyQaStatus = (typeof HR_SELF_POLICY_QA_STATUSES)[number];

export const zHrSelfRequestDraftAsk = z.strictObject({
  text: z.string().trim().min(1).max(1000).refine(noNul, 'no NUL character'),
  lang: z.enum(['vi', 'en']).optional(),
  referenceDate: zLocalDate.optional(),
});
export type HrSelfRequestDraftAsk = z.input<typeof zHrSelfRequestDraftAsk>;

export const zHrSelfLeaveDraftPayload = z.object({
  kind: z.literal('leave'),
  startOn: zLocalDate,
  endOn: zLocalDate,
  leaveKind: z.enum(HR_LEAVE_REQUEST_KINDS),
  days: zHrLeaveRequestDays,
  reason: z.string().max(300),
  halfDaySession: z.enum(HR_SELF_REQUEST_HALF_DAY_SESSIONS).nullable(),
});
export type HrSelfLeaveDraftPayload = z.infer<typeof zHrSelfLeaveDraftPayload>;

export const zHrSelfOvertimeDraftPayload = z.object({
  kind: z.literal('overtime'),
  workDate: zLocalDate,
  hours: zHrOvertimeHours,
  dayType: z.enum(HR_OVERTIME_DAY_TYPES),
  isNight: z.boolean(),
  reason: z.string().max(300),
});
export type HrSelfOvertimeDraftPayload = z.infer<typeof zHrSelfOvertimeDraftPayload>;

export const zHrSelfBusinessTripDraftPayload = z.object({
  kind: z.literal('business_trip_unsupported'),
  startOn: zLocalDate.nullable(),
  endOn: zLocalDate.nullable(),
  destination: z.string().max(160).nullable(),
  reason: z.string().max(300),
  hint: z.string().min(1).max(400),
});
export type HrSelfBusinessTripDraftPayload = z.infer<typeof zHrSelfBusinessTripDraftPayload>;

export const zHrSelfUnknownDraftPayload = z.object({
  kind: z.literal('unknown'),
  reason: z.string().max(300),
  hint: z.string().min(1).max(400),
});
export type HrSelfUnknownDraftPayload = z.infer<typeof zHrSelfUnknownDraftPayload>;

export const zHrSelfRequestDraftPayload = z.discriminatedUnion('kind', [
  zHrSelfLeaveDraftPayload,
  zHrSelfOvertimeDraftPayload,
  zHrSelfBusinessTripDraftPayload,
  zHrSelfUnknownDraftPayload,
]);
export type HrSelfRequestDraftPayload = z.infer<typeof zHrSelfRequestDraftPayload>;

export const zHrSelfRequestDraftResult = z.object({
  aiStatus: z.enum(HR_SELF_REQUEST_AI_STATUSES),
  source: z.enum(['ai', 'deterministic']),
  tainted: z.literal(true),
  draft: zHrSelfRequestDraftPayload,
});
export type HrSelfRequestDraftResult = z.infer<typeof zHrSelfRequestDraftResult>;

export const zHrSelfPolicyQaAsk = z.strictObject({
  question: z.string().trim().min(1).max(500).refine(noNul, 'no NUL character'),
  lang: z.enum(['vi', 'en']).optional(),
  limit: z.number().int().min(1).max(10).default(5),
});
export type HrSelfPolicyQaAsk = z.input<typeof zHrSelfPolicyQaAsk>;

export const zHrSelfPolicyCitation = z.object({
  noteId: zId,
  title: z.string().min(1).max(300),
  excerpt: z.string().min(1).max(600),
  visibility: z.enum(['org', 'private']),
  updatedAt: z.string(),
});
export type HrSelfPolicyCitation = z.infer<typeof zHrSelfPolicyCitation>;

export const zHrSelfPolicyQaResult = z.object({
  notesAvailable: z.boolean(),
  aiStatus: z.enum(HR_SELF_POLICY_QA_STATUSES),
  tainted: z.boolean(),
  answer: z.string().max(1800).nullable(),
  citations: z.array(zHrSelfPolicyCitation).max(10),
  matches: z.array(zHrSelfPolicyCitation).max(10),
});
export type HrSelfPolicyQaResult = z.infer<typeof zHrSelfPolicyQaResult>;

export const zHrSelfAiStatusAsk = z.strictObject({
  includeNotes: z.boolean().optional(),
});

const HR_POLICY_STOP_WORDS = new Set([
  'la',
  'gi',
  'nhu',
  'the',
  'nao',
  'bao',
  'nhieu',
  'co',
  'duoc',
  'khong',
  'ko',
  'toi',
  'minh',
  'em',
  'anh',
  'chi',
  'ban',
  'cho',
  'hoi',
  've',
  'cua',
  'trong',
  'khi',
  'thi',
  'va',
  'hay',
  'hoac',
  'neu',
  'ma',
  'cac',
  'mot',
  'nhung',
  'quy',
  'dinh',
  'chinh',
  'sach',
  'cong',
  'ty',
  'may',
  'ngay',
  'gio',
  'what',
  'how',
  'many',
  'much',
  'is',
  'are',
  'do',
  'does',
  'can',
  'we',
  'our',
  'the',
  'an',
  'for',
  'of',
  'in',
  'on',
  'about',
  'company',
  'policy',
  'hr',
]);

export function foldVietnameseText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\u2013\u2014]/g, '-')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function extractHrPolicyKeywords(question: string): string[] {
  const folded = foldVietnameseText(question);
  const tokens = folded
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !HR_POLICY_STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, 12);
}

export function foldedTextHasWord(foldedText: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(foldedText);
}
