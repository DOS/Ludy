// SPDX-License-Identifier: AGPL-3.0-only
// Public signing link contracts for Crove eSign Slice 1b (#3324, docs/plan/esign.md).
// Screens belong in screens.ts (owned separately by #3325); keep only public route paths,
// token patterns, PNG/input bounds, and request/response schemas here.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const SIGN_PAGE_PATH = '/-/sign';
export const SIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SIGN_OTP_CODE_PATTERN = /^\d{6}$/;
export const SIGN_CERTIFICATE_CODE_PATTERN = /^CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const SIGN_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const SIGN_SIGNATURE_PNG_MAX_BYTES = 256 * 1024;
export const SIGN_SIGNATURE_PNG_MAX_WIDTH = 2000;
export const SIGN_SIGNATURE_PNG_MAX_HEIGHT = 1000;
export const SIGN_SIGNATURE_PNG_BASE64_MAX = 360_000;
export const SIGN_FIELD_TEXT_MAX = 2000;
export const SIGN_DECLINE_REASON_MAX = 1000;
export const SIGN_SIGNATURE_TYPED_TEXT_MAX = 200;
export const SIGN_PUBLIC_FIELDS_MAX = 500;

export const zSignToken = z.string().regex(SIGN_TOKEN_PATTERN, 'Invalid signing token');

export const zSignPublicViewInput = z.strictObject({
  token: zSignToken,
});

export const zSignPublicPdfInput = z.strictObject({
  token: zSignToken,
});

export const zSignPublicOtpRequestInput = z.strictObject({
  token: zSignToken,
});

export const zSignPublicOtpVerifyInput = z.strictObject({
  token: zSignToken,
  code: z.string().trim().regex(SIGN_OTP_CODE_PATTERN, 'OTP code must be 6 digits'),
});

export const zSignFieldSubmission = z.strictObject({
  fieldId: zId,
  valueText: z.string().max(SIGN_FIELD_TEXT_MAX).optional(),
  valueChecked: z.boolean().optional(),
  signaturePngBase64: z.string().min(1).max(SIGN_SIGNATURE_PNG_BASE64_MAX).optional(),
});

export const zSignPublicSubmitInput = z.strictObject({
  token: zSignToken,
  consentAccepted: z.boolean(),
  signatureKind: z.enum(['draw', 'type']).optional(),
  signatureTypedText: z.string().trim().min(1).max(SIGN_SIGNATURE_TYPED_TEXT_MAX).optional(),
  fields: z.array(zSignFieldSubmission).max(SIGN_PUBLIC_FIELDS_MAX),
});

export const zSignPublicDeclineInput = z.strictObject({
  token: zSignToken,
  reason: z.string().trim().min(1).max(SIGN_DECLINE_REASON_MAX).optional(),
});

export const zSignPublicVerifyInput = z.strictObject({
  certificateCode: z.string().trim().toUpperCase().regex(SIGN_CERTIFICATE_CODE_PATTERN, 'Invalid certificate code'),
  fileSha256: z.string().trim().toLowerCase().regex(SIGN_SHA256_HEX_PATTERN, 'Invalid SHA-256 hex digest'),
});

export interface SignPublicField {
  id: string;
  fieldType: 'signature' | 'initials' | 'date' | 'text' | 'checkbox';
  pageNumber: number;
  xNorm: string;
  yNorm: string;
  wNorm: string;
  hNorm: string;
  label: string | null;
  required: boolean;
  fontSizePt: number | null;
}

export interface SignPageDimension {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}

export type SignPublicView =
  | {
      state: 'otp_required';
      orgName: string;
      title: string;
      maskedEmail: string | null;
    }
  | {
      state: 'ready';
      orgName: string;
      title: string;
      message: string | null;
      signerName: string;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      expiresAt: string;
      pageCount: number;
      pageDimensions: SignPageDimension[];
      requireEmailOtp: boolean;
      otpVerified: boolean;
      fields: SignPublicField[];
    };

export interface SignPublicOtpRequestResult {
  sent: boolean;
  expiresInMinutes: number;
  maskedEmail: string | null;
}

export interface SignPublicOtpVerifyResult {
  ok: boolean;
  locked: boolean;
  attemptsRemaining: number;
  expired?: boolean;
  notReady?: boolean;
}

export interface SignPublicSubmitResult {
  signerId: string;
  signerStatus: 'signed';
  envelopeStatus: 'sent' | 'in_progress' | 'completed';
  completed: boolean;
  signedAt: string;
}

export interface SignPublicDeclineResult {
  signerId: string;
  signerStatus: 'declined';
  envelopeStatus: 'declined';
  declinedAt: string;
}

export interface SignPublicVerifyResult {
  matched: true;
  envelopeStatus: 'completed';
  completedAt: string;
  signerCount: number;
  sealedSha256: string;
}

export type SignPublicViewInput = z.infer<typeof zSignPublicViewInput>;
export type SignPublicPdfInput = z.infer<typeof zSignPublicPdfInput>;
export type SignPublicOtpRequestInput = z.infer<typeof zSignPublicOtpRequestInput>;
export type SignPublicOtpVerifyInput = z.infer<typeof zSignPublicOtpVerifyInput>;
export type SignFieldSubmission = z.infer<typeof zSignFieldSubmission>;
export type SignPublicSubmitInput = z.infer<typeof zSignPublicSubmitInput>;
export type SignPublicDeclineInput = z.infer<typeof zSignPublicDeclineInput>;
export type SignPublicVerifyInput = z.infer<typeof zSignPublicVerifyInput>;
