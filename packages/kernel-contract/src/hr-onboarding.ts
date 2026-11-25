// SPDX-License-Identifier: AGPL-3.0-only
// HR employee self-service onboarding checklist contracts (#4448, Stage 5B).
import { z } from 'zod';
import {
  zHrAccountNumber,
  zHrBankCode,
  zHrBirthDate,
  zHrIdentityNumber,
  zHrInsuranceNumber,
  zHrTaxCode,
} from './hr.ts';
import { zId } from './schemas.ts';

export const HR_ONBOARDING_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type HrOnboardingStatus = (typeof HR_ONBOARDING_STATUSES)[number];

const noNul = (value: string): boolean => !value.includes('\0');
const zHrOnboardingAddress = z.string().trim().min(1).max(500).refine(noNul, 'no NUL character');
export const zHrOnboardingNote = z.string().trim().min(1).max(2000).refine(noNul, 'no NUL character');

export const zHrSelfOnboardingSubmit = z
  .strictObject({
    contactConfirmed: z.boolean().default(false),
    idConfirmed: z.boolean().default(false),
    bankConfirmed: z.boolean().default(false),
    handbookConfirmed: z.boolean().default(false),
    address: zHrOnboardingAddress.optional(),
    birthDate: zHrBirthDate.optional(),
    identityNumber: zHrIdentityNumber.optional(),
    bankCode: zHrBankCode.optional(),
    accountNumber: zHrAccountNumber.optional(),
    taxCode: zHrTaxCode.optional(),
    insuranceNumber: zHrInsuranceNumber.optional(),
    note: zHrOnboardingNote.optional(),
  })
  .refine(
    (v) =>
      v.contactConfirmed ||
      v.idConfirmed ||
      v.bankConfirmed ||
      v.handbookConfirmed ||
      v.address !== undefined ||
      v.birthDate !== undefined ||
      v.identityNumber !== undefined ||
      v.bankCode !== undefined ||
      v.accountNumber !== undefined ||
      v.taxCode !== undefined ||
      v.insuranceNumber !== undefined ||
      v.note !== undefined,
    { message: 'confirm at least one checklist item or enter updated information' },
  )
  .refine(
    (v) => (v.bankCode === undefined) === (v.accountNumber === undefined),
    {
      message: 'bankCode and accountNumber must be provided together',
      path: ['accountNumber'],
    },
  );
export type HrSelfOnboardingSubmit = z.input<typeof zHrSelfOnboardingSubmit>;

export const zHrSelfOnboardingSubmitResult = z.object({
  submissionId: zId,
  status: z.literal('pending'),
});
export type HrSelfOnboardingSubmitResult = z.infer<typeof zHrSelfOnboardingSubmitResult>;

export const zHrOnboardingSubmissionRef = z.strictObject({
  submissionId: zId,
});
export type HrOnboardingSubmissionRef = z.input<typeof zHrOnboardingSubmissionRef>;

export const zHrSelfOnboardingGetAsk = z.strictObject({});

export const zHrOnboardingCancelResult = z.object({
  submissionId: zId,
  status: z.literal('cancelled'),
});
export type HrOnboardingCancelResult = z.infer<typeof zHrOnboardingCancelResult>;

export const zHrOnboardingSubmissionView = z.object({
  id: zId,
  employeeId: zId,
  employeeName: z.string(),
  legalEntityId: zId,
  departmentName: z.string().nullable(),
  status: z.enum(HR_ONBOARDING_STATUSES),
  contactConfirmed: z.boolean(),
  idConfirmed: z.boolean(),
  bankConfirmed: z.boolean(),
  handbookConfirmed: z.boolean(),
  address: z.string().nullable(),
  birthDate: z.string().nullable(),
  bankCode: z.string().nullable(),
  bankAccountMasked: z.string().nullable(),
  hasIdentityNumber: z.boolean(),
  hasBankAccount: z.boolean(),
  hasTaxCode: z.boolean(),
  hasInsuranceNumber: z.boolean(),
  note: z.string().nullable(),
  decisionNote: z.string().nullable(),
  reviewedBy: zId.nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type HrOnboardingSubmissionView = z.infer<typeof zHrOnboardingSubmissionView>;

export const zHrSelfOnboardingState = z.object({
  employeeId: zId,
  checklist: z.object({
    hasAddress: z.boolean(),
    hasBirthDate: z.boolean(),
    hasIdentityNumber: z.boolean(),
    hasBankAccount: z.boolean(),
    bankCode: z.string().nullable(),
    hasTaxCode: z.boolean(),
    hasInsuranceNumber: z.boolean(),
    contactConfirmed: z.boolean(),
    idConfirmed: z.boolean(),
    bankConfirmed: z.boolean(),
    handbookConfirmed: z.boolean(),
  }),
  submissions: z.array(zHrOnboardingSubmissionView),
});
export type HrSelfOnboardingState = z.infer<typeof zHrSelfOnboardingState>;

export const zHrOnboardingList = z.strictObject({
  status: z.enum(HR_ONBOARDING_STATUSES).optional(),
  employeeId: zId.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrOnboardingList = z.input<typeof zHrOnboardingList>;

export const zHrOnboardingDecide = z.strictObject({
  submissionId: zId,
  note: zHrOnboardingNote.optional(),
});
export type HrOnboardingDecide = z.input<typeof zHrOnboardingDecide>;

export const zHrOnboardingApproveResult = z.object({
  submissionId: zId,
  employeeId: zId,
  status: z.literal('approved'),
  updatedFields: z.array(z.string()),
});
export type HrOnboardingApproveResult = z.infer<typeof zHrOnboardingApproveResult>;

export const zHrOnboardingRejectResult = z.object({
  submissionId: zId,
  employeeId: zId,
  status: z.literal('rejected'),
});
export type HrOnboardingRejectResult = z.infer<typeof zHrOnboardingRejectResult>;
