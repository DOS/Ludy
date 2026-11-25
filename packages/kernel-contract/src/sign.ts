// SPDX-License-Identifier: AGPL-3.0-only
// Public signing link contracts for Ludy eSign Slice 1b (#3324, docs/plan/esign.md).
// Screens belong in screens.ts (owned separately by #3325); keep only public route paths,
// token patterns, PNG/input bounds, and request/response schemas here.
import { z } from 'zod';
import { normalizeAccountCode } from './accounts.ts';
import { zMcpWakeUrl } from './mcp.ts';
import { zAccountCode, zId } from './schemas.ts';

export const SIGN_PAGE_PATH = '/-/sign';
export const SIGN_DIRECT_PAGE_PATH = '/-/sign/d';
export const SIGN_PUBLIC_HUB_PAGE_PREFIX = '/-/sign/p';
export const SIGN_PUBLIC_HUB_ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SIGN_IN_PERSON_MAX_TTL_MINUTES = 120;
export const SIGN_IN_PERSON_DEFAULT_TTL_MINUTES = 30;
export const SIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SIGN_TEMPLATE_ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SIGN_OTP_CODE_PATTERN = /^\d{6}$/;
export const SIGN_CERTIFICATE_CODE_PATTERN = /^CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const SIGN_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const SIGN_SIGNATURE_PNG_MAX_BYTES = 256 * 1024;
export const SIGN_SIGNATURE_PNG_MAX_WIDTH = 2000;
export const SIGN_SIGNATURE_PNG_MAX_HEIGHT = 1000;
export const SIGN_SIGNATURE_PNG_BASE64_MAX = 360_000;
export const SIGN_FIELD_TEXT_MAX = 2000;
export const SIGN_FIELD_OPTIONS_MAX = 50;
export const SIGN_FIELD_OPTION_CHARS_MAX = 200;
export const SIGN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SIGN_ATTACHMENT_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type SignAttachmentContentType = (typeof SIGN_ATTACHMENT_CONTENT_TYPES)[number];
export const zSignAttachmentContentType = z.enum(SIGN_ATTACHMENT_CONTENT_TYPES);
export const SIGN_DECLINE_REASON_MAX = 1000;
export const SIGN_DELEGATE_REASON_MAX = 500;
export const SIGN_MAX_DELEGATIONS = 2;
export const SIGN_SIGNATURE_TYPED_TEXT_MAX = 200;
export const SIGN_PUBLIC_FIELDS_MAX = 500;
export const SIGN_DEPOSIT_MEMO_TOKEN_PATTERN = /^CK-[A-Z0-9]{6,12}$/;
export const SIGN_DEPOSIT_PROOF_MAX_BYTES = 2 * 1024 * 1024;
export const SIGN_DEPOSIT_PROOF_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
export type SignDepositProofContentType = (typeof SIGN_DEPOSIT_PROOF_CONTENT_TYPES)[number];
export const SIGN_DEPOSIT_DUE_DAYS_MAX = 365;
export const SIGN_DEPOSIT_NOTE_MAX = 300;

export const zSignToken = z.string().regex(SIGN_TOKEN_PATTERN, 'Invalid signing token');
export const zSignTemplateRoleKey = z.string().regex(SIGN_TEMPLATE_ROLE_KEY_PATTERN, 'Invalid template role key');

export const zSignPublicViewInput = z.strictObject({
  token: zSignToken,
});

export const zSignPublicPdfInput = z.strictObject({
  token: zSignToken,
  documentId: zId.optional(),
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

export const zSignPublicDelegateInput = z.strictObject({
  token: zSignToken,
  delegateName: z.string().trim().min(1).max(200),
  delegateEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  reason: z.string().trim().min(1).max(SIGN_DELEGATE_REASON_MAX),
});

export const zSignPublicVerifyInput = z.strictObject({
  certificateCode: z.string().trim().toUpperCase().regex(SIGN_CERTIFICATE_CODE_PATTERN, 'Invalid certificate code'),
  fileSha256: z.string().trim().toLowerCase().regex(SIGN_SHA256_HEX_PATTERN, 'Invalid SHA-256 hex digest'),
});

export interface SignPublicFieldAttachment {
  fileId: string;
  filename: string;
  contentType: SignAttachmentContentType;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string | null;
}

export interface SignPublicAttachmentUploadResult {
  fieldId: string;
  fileId: string;
  filename: string;
  contentType: SignAttachmentContentType;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export interface SignPublicField {
  id: string;
  documentId?: string | null;
  fieldType: (typeof SIGN_FIELD_TYPES)[number];
  pageNumber: number;
  xNorm: string;
  yNorm: string;
  wNorm: string;
  hNorm: string;
  label: string | null;
  required: boolean;
  fontSizePt: number | null;
  valueText?: string | null;
  options?: string[] | null;
  attachment?: SignPublicFieldAttachment | null;
}

export interface SignPageDimension {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}

export const SIGN_SHARED_SUMMARY_MAX_CHARS = 3000;
export const SIGN_SHARED_KEY_TERMS_MAX = 20;

export interface SignSharedKeyTerm {
  label: string;
  value: string;
  pageNumber: number | null;
  quoteExcerpt: string | null;
}

export interface SignSharedSummary {
  summaryText: string | null;
  keyTerms: SignSharedKeyTerm[];
}

export interface SignPublicDocument {
  id: string | null;
  docIndex: number;
  title: string;
  pageCount: number;
  pageDimensions: SignPageDimension[];
  sourceSha256: string;
}

export interface SignPublicDepositSummary {
  amount: string;
  currency: 'VND';
  memoToken: string;
  dueDays: number | null;
  note: string | null;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  hasQrPng: boolean;
  emvcoPayload: string | null;
  signerNoticeAt: string | null;
  signerNoticeNote: string | null;
  signerProofFilename: string | null;
  signerProofSha256: string | null;
}

export type SignPublicView =
  | {
      state: 'otp_required';
      orgName: string;
      title: string;
      maskedEmail: string | null;
      inPerson?: boolean;
    }
  | {
      state: 'already_completed';
      title: string;
      status: 'sent' | 'in_progress' | 'completed';
      signerRole: 'signer' | 'approver';
      deposit: SignPublicDepositSummary | null;
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
      documents?: SignPublicDocument[];
      requireEmailOtp: boolean;
      otpVerified: boolean;
      allowDelegation?: boolean;
      delegationCount?: number;
      delegatedFromName?: string | null;
      inPerson?: boolean;
      fields: SignPublicField[];
      sharedSummary?: SignSharedSummary | null;
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
  inPerson?: boolean;
  signedAt: string;
  deposit?: SignPublicDepositSummary | null;
}

export interface SignPublicDeclineResult {
  signerId: string;
  signerStatus: 'declined';
  envelopeStatus: 'declined';
  declinedAt: string;
}

export interface SignPublicDelegateResult {
  signerId: string;
  delegateName: string;
  maskedDelegateEmail: string | null;
  delegationCount: number;
  delegatedAt: string;
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
export type SignPublicDelegateInput = z.infer<typeof zSignPublicDelegateInput>;
export type SignPublicVerifyInput = z.infer<typeof zSignPublicVerifyInput>;

// Public direct-signing link ceremony contracts (/-/sign/d#<token>, Slice 2a A1, #3551).
const zDirectEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const zSignDirectViewInput = z.strictObject({
  token: zSignToken,
  otpSessionToken: zSignToken.optional(),
});

export const zSignDirectPdfInput = z.strictObject({
  token: zSignToken,
  otpSessionToken: zSignToken.optional(),
});

export const zSignDirectOtpRequestInput = z.strictObject({
  token: zSignToken,
  email: zDirectEmail,
});

export const zSignDirectOtpVerifyInput = z.strictObject({
  token: zSignToken,
  email: zDirectEmail,
  code: z.string().trim().regex(SIGN_OTP_CODE_PATTERN, 'OTP code must be 6 digits'),
});

export const zSignDirectStartInput = z.strictObject({
  token: zSignToken,
  name: z.string().trim().min(1).max(200),
  email: zDirectEmail.nullable().optional(),
  otpSessionToken: zSignToken.optional(),
});

export type SignDirectView =
  | {
      state: 'otp_required';
      orgName: string;
      title: string;
      description: string | null;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      requireEmailOtp: true;
    }
  | {
      state: 'ready';
      orgName: string;
      title: string;
      description: string | null;
      message: string | null;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      emailRequired: boolean;
      requireEmailOtp: boolean;
      otpVerified: boolean;
      verifiedEmail: string | null;
      pageCount: number;
      pageDimensions: SignPageDimension[];
      fieldCount: number;
      sharedSummary?: SignSharedSummary | null;
    };

export interface SignDirectOtpRequestResult {
  sent: boolean;
  expiresInMinutes: number;
  maskedEmail: string | null;
}

export interface SignDirectOtpVerifyResult {
  ok: boolean;
  locked: boolean;
  attemptsRemaining: number;
  expired?: boolean;
  notReady?: boolean;
  otpSessionToken?: string;
  verifiedEmail?: string;
}

export interface SignDirectStartResult {
  envelopeId: string;
  signerId: string;
  signingToken: string;
  expiresAt: string;
}

export type SignDirectViewInput = z.infer<typeof zSignDirectViewInput>;
export type SignDirectPdfInput = z.infer<typeof zSignDirectPdfInput>;
export type SignDirectOtpRequestInput = z.infer<typeof zSignDirectOtpRequestInput>;
export type SignDirectOtpVerifyInput = z.infer<typeof zSignDirectOtpVerifyInput>;
export type SignDirectStartInput = z.infer<typeof zSignDirectStartInput>;

// Public self-service template hub contracts (/-/sign/p/$orgSlug, Slice 4d, #3820).
export const zSignPublicHubOrgSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SIGN_PUBLIC_HUB_ORG_SLUG_PATTERN, 'Invalid organization slug');

export const zSignPublicHubActionInput = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('view'),
    templateId: zId,
    otpSessionToken: zSignToken.optional(),
  }),
  z.strictObject({
    action: z.literal('pdf'),
    templateId: zId,
    otpSessionToken: zSignToken.optional(),
  }),
  z.strictObject({
    action: z.literal('otp_request'),
    templateId: zId,
    email: zDirectEmail,
  }),
  z.strictObject({
    action: z.literal('otp_verify'),
    templateId: zId,
    email: zDirectEmail,
    code: z.string().trim().regex(SIGN_OTP_CODE_PATTERN, 'OTP code must be 6 digits'),
  }),
  z.strictObject({
    action: z.literal('start'),
    templateId: zId,
    name: z.string().trim().min(1).max(200),
    email: zDirectEmail.nullable().optional(),
    otpSessionToken: zSignToken.optional(),
  }),
]);

export interface SignPublicHubItem {
  templateId: string;
  title: string;
  description: string | null;
  roleLabel: string;
  signerRole: 'signer' | 'approver';
  requireEmailOtp: boolean;
  pageCount: number;
}

export interface SignPublicHubListResult {
  orgSlug: string;
  orgName: string;
  items: SignPublicHubItem[];
}

export type SignPublicHubActionInput = z.infer<typeof zSignPublicHubActionInput>;

// Authenticated eSign RPC contracts (Slice 1a/1c: docs/plan/esign.md, #3325).
export const SIGN_EVENT_TYPES = [
  'envelope_created',
  'document_added',
  'document_removed',
  'documents_reordered',
  'document_inspected',
  'document_inspect_failed',
  'envelope_updated',
  'envelope_shared_summary_updated',
  'signer_added',
  'signer_removed',
  'signers_reordered',
  'fields_set',
  'envelope_sent',
  'link_created',
  'in_person_session_started',
  'signer_reminded',
  'signer_pre_expiry_reminded',
  'signer_corrected',
  'signer_delegated',
  'signer_viewed',
  'signer_otp_verified',
  'attachment_uploaded',
  'deposit_notice_recorded',
  'signer_signed',
  'in_person_signed',
  'signer_declined',
  'envelope_decline_acknowledged',
  'envelope_completed',
  'envelope_voided',
  'envelope_expired',
  'envelope_sealed',
  'envelope_seal_failed',
  'ca_requested',
  'ca_completed',
  'ca_failed',
] as const;
export type SignEventType = (typeof SIGN_EVENT_TYPES)[number];
export const SIGN_MAX_PAGES = 200;
export const SIGN_MAX_PACKET_DOCS = 5;
export const SIGN_MAX_SIGNERS = 50;
export const SIGN_MAX_FIELDS = 500;
export const SIGN_MAX_DETECTED_TAGS = 200;
export const SIGN_MAX_TAG_ROLES = 50;
export const SIGN_NORM_SCALE = 1_000_000;

export const SIGN_ENVELOPE_STATUSES = ['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired'] as const;
export const SIGN_ROUTING_MODES = ['parallel', 'sequential'] as const;
export const SIGN_SOURCE_KINDS = [
  'standalone',
  'crm_quote',
  'crm_order',
  'hr_contract',
  'project_acceptance',
  'meeting_minutes',
] as const;
export const SIGN_INSPECT_STATUSES = ['pending', 'passed', 'failed'] as const;
export const SIGN_SEAL_STATUSES = ['pending', 'sealed', 'failed'] as const;
export const SIGN_SIGNER_ROLES = ['signer', 'approver', 'cc'] as const;
export const SIGN_DELIVERY_MODES = ['link', 'email'] as const;
export const SIGN_SIGNER_STATUSES = ['waiting', 'pending', 'viewed', 'signed', 'declined', 'voided', 'expired'] as const;
export const SIGN_SIGNATURE_KINDS = ['draw', 'type'] as const;
export const SIGN_FIELD_TYPES = [
  'signature',
  'initials',
  'stamp',
  'date',
  'text',
  'checkbox',
  'dropdown',
  'radio',
  'attachment',
] as const;
export const SIGN_MEMBER_SIGNATURE_KINDS = ['signature', 'initials'] as const;
export const SIGN_ORG_STAMP_KINDS = ['company', 'title', 'custom'] as const;
export const SIGN_ORG_STAMP_STATUSES = ['active', 'archived'] as const;
export const SIGN_MAX_ORG_STAMPS = 50;
export const SIGN_AI_ANALYSIS_STATUSES = ['pending', 'completed', 'failed'] as const;
export const SIGN_AI_SEVERITIES = ['low', 'medium', 'high'] as const;
export const SIGN_AI_OUTCOME_STATES = ['used', 'off', 'budget', 'busy', 'not_ready', 'not_draft', 'no_text', 'failed'] as const;

export const zSignEnvelopeStatus = z.enum(SIGN_ENVELOPE_STATUSES);
export const zSignRoutingMode = z.enum(SIGN_ROUTING_MODES);
export const zSignSourceKind = z.enum(SIGN_SOURCE_KINDS);
export const zSignInspectStatus = z.enum(SIGN_INSPECT_STATUSES);
export const zSignSealStatus = z.enum(SIGN_SEAL_STATUSES);
export const zSignSignerRole = z.enum(SIGN_SIGNER_ROLES);
export const zSignDeliveryMode = z.enum(SIGN_DELIVERY_MODES);
export const zSignSignerStatus = z.enum(SIGN_SIGNER_STATUSES);
export const zSignSignatureKind = z.enum(SIGN_SIGNATURE_KINDS);
export const zSignFieldType = z.enum(SIGN_FIELD_TYPES);
export const zSignMemberSignatureKind = z.enum(SIGN_MEMBER_SIGNATURE_KINDS);
export const zSignOrgStampKind = z.enum(SIGN_ORG_STAMP_KINDS);
export const zSignOrgStampStatus = z.enum(SIGN_ORG_STAMP_STATUSES);
export const zSignAiAnalysisStatus = z.enum(SIGN_AI_ANALYSIS_STATUSES);
export const zSignAiSeverity = z.enum(SIGN_AI_SEVERITIES);
export const zSignAiOutcomeState = z.enum(SIGN_AI_OUTCOME_STATES);

export const zSignEnvelopePageDimension = z.object({
  page: z.number().int().min(1).max(SIGN_MAX_PAGES),
  widthPt: z.number(),
  heightPt: z.number(),
  rotation: z.number().int(),
});

const toSignMicro = (v: number) => Math.round(v * SIGN_NORM_SCALE);
function validateSignNormBounds(item: { xNorm: number; yNorm: number; wNorm: number; hNorm: number }, ctx: z.RefinementCtx): void {
  const x = toSignMicro(item.xNorm);
  const y = toSignMicro(item.yNorm);
  const w = toSignMicro(item.wNorm);
  const h = toSignMicro(item.hNorm);
  if (x < 0 || x >= SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['xNorm'], message: 'xNorm rounds outside [0, 1)' });
  if (y < 0 || y >= SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['yNorm'], message: 'yNorm rounds outside [0, 1)' });
  if (w < 1 || w > SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['wNorm'], message: 'wNorm rounds outside (0, 1]' });
  if (h < 1 || h > SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['hNorm'], message: 'hNorm rounds outside (0, 1]' });
  if (x + w > SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['wNorm'], message: 'xNorm + wNorm must be <= 1' });
  if (y + h > SIGN_NORM_SCALE) ctx.addIssue({ code: 'custom', path: ['hNorm'], message: 'yNorm + hNorm must be <= 1' });
}

function hasLoneSignSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export const zSignFieldOption = z
  .string()
  .trim()
  .min(1)
  .max(SIGN_FIELD_OPTION_CHARS_MAX)
  .refine(
    (s) => !hasLoneSignSurrogate(s) && !hasControlChars(s),
    'option must be printable well-formed Unicode',
  );

export const zSignFieldOptions = z
  .array(zSignFieldOption)
  .min(1)
  .max(SIGN_FIELD_OPTIONS_MAX)
  .refine((items) => new Set(items).size === items.length, 'field options must be unique');

function validateSignFieldTypeOptions(
  item: { fieldType: (typeof SIGN_FIELD_TYPES)[number]; options?: readonly string[] | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const isChoice = item.fieldType === 'dropdown' || item.fieldType === 'radio';
  if (isChoice) {
    if (!item.options || item.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'dropdown and radio fields require at least one option' });
    }
  } else if (item.options !== undefined && item.options !== null) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'options are only valid on dropdown and radio fields' });
  }
}

export const zSignDetectedTag = z
  .strictObject({
    pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
    fieldType: zSignFieldType,
    roleOrder: z.number().int().min(1).max(SIGN_MAX_TAG_ROLES),
    roleKey: z.string().regex(/^r(?:[1-9]|[1-4]\d|50)$/, 'Invalid tag role key'),
    required: z.boolean(),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((s) => !hasLoneSignSurrogate(s), 'label must be well-formed Unicode without lone surrogates')
      .nullable(),
    options: z.array(zSignFieldOption).min(1).max(SIGN_FIELD_OPTIONS_MAX).optional(),
    xNorm: z.number().finite().min(0).lt(1),
    yNorm: z.number().finite().min(0).lt(1),
    wNorm: z.number().finite().gt(0).lte(1),
    hNorm: z.number().finite().gt(0).lte(1),
  })
  .superRefine((item, ctx) => {
    if (item.roleKey !== `r${item.roleOrder}`) {
      ctx.addIssue({ code: 'custom', path: ['roleKey'], message: 'roleKey must match roleOrder' });
    }
    validateSignFieldTypeOptions(item, ctx);
    validateSignNormBounds(item, ctx);
  });
export type SignDetectedTag = z.infer<typeof zSignDetectedTag>;

export const zSignEnvelopeSignerSummary = z.strictObject({
  total: z.number().int().min(0),
  signed: z.number().int().min(0),
  waitingForMe: z.boolean(),
});

export const zSignEnvelopeSummary = z.strictObject({
  id: zId,
  title: z.string(),
  status: zSignEnvelopeStatus,
  routingMode: zSignRoutingMode,
  sourceKind: zSignSourceKind,
  sourceId: zId.nullable(),
  sourceFileId: zId,
  inspectStatus: zSignInspectStatus,
  sealStatus: zSignSealStatus.nullable(),
  certificateCode: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  autoRemindBeforeExpiry: z.boolean().optional(),
  expiresAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  declineAcknowledgedAt: z.string().nullable().optional(),
  voidedAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
  version: z.number().int(),
  createdBy: zId,
  createdAt: z.string(),
  updatedAt: z.string(),
  signerSummary: zSignEnvelopeSignerSummary,
});

export const SIGN_BY_SOURCE_MAX = 50;

export const zSignEnvelopeListInput = z.strictObject({
  status: zSignEnvelopeStatus.optional(),
  sourceKind: zSignSourceKind.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const zSignEnvelopeListResult = z.strictObject({ items: z.array(zSignEnvelopeSummary) });

export const zSignEnvelopeBySourceInput = z.strictObject({
  sourceKind: zSignSourceKind,
  sourceIds: z.array(zId).min(1).max(SIGN_BY_SOURCE_MAX),
});

export const zSignEnvelopeBySourceItem = z.strictObject({
  sourceId: zId,
  envelopeId: zId,
  title: z.string(),
  status: zSignEnvelopeStatus,
  sealStatus: zSignSealStatus.nullable(),
  sealedFileId: zId.nullable().optional(),
  certificateCode: z.string().nullable(),
  completedAt: z.string().nullable(),
  signerCount: z.number().int().min(0),
  signedCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  // A meeting-minutes envelope made for other minutes than the ones published now (the server compares the revision it stored at creation with the current one, #4532); absent means no.
  stale: z.boolean().optional(),
});
export type SignEnvelopeBySourceItem = z.infer<typeof zSignEnvelopeBySourceItem>;

export const zSignEnvelopeBySourceResult = z.strictObject({
  items: z.array(zSignEnvelopeBySourceItem),
});

export const zSignSharedKeyTerm = z.strictObject({
  label: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(600),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable().default(null),
  quoteExcerpt: z.string().trim().max(1000).nullable().default(null),
});

export const zSignSharedSummary = z
  .strictObject({
    summaryText: z.string().trim().max(SIGN_SHARED_SUMMARY_MAX_CHARS).nullable().default(null),
    keyTerms: z.array(zSignSharedKeyTerm).max(SIGN_SHARED_KEY_TERMS_MAX).default([]),
  })
  .superRefine((val, ctx) => {
    const hasSummary = Boolean(val.summaryText && val.summaryText.trim().length > 0);
    if (!hasSummary && val.keyTerms.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['summaryText'],
        message: 'Provide summaryText or at least one keyTerm',
      });
    }
  });

export const zSignEnvelopeDocumentSummary = z.strictObject({
  id: zId.nullable(),
  docIndex: z.number().int().min(1).max(SIGN_MAX_PACKET_DOCS),
  title: z.string(),
  fileId: zId,
  sourceSha256: z.string(),
  inspectStatus: zSignInspectStatus,
  inspectError: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  pageDimensions: z.array(zSignEnvelopePageDimension).nullable(),
  detectedTags: z.array(zSignDetectedTag),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignEnvelopeDocumentSummary = z.infer<typeof zSignEnvelopeDocumentSummary>;

export const zSignContractDecimal = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Non-negative decimal string (up to 4 decimal places)');

export const zSignDepositProfile = z.strictObject({
  id: zId,
  bankCode: z.string(),
  bankName: z.string(),
  accountNumber: z.string(),
  accountHolder: z.string(),
  financeBankAccount: z.string().nullable(),
  hasQrPng: z.boolean(),
  vietqrFileId: zId.nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignDepositProfileContract = z.infer<typeof zSignDepositProfile>;

export const zSignDepositProfileGetResult = z.strictObject({
  profile: zSignDepositProfile.nullable(),
  canEdit: z.boolean(),
});
export type SignDepositProfileGetResult = z.infer<typeof zSignDepositProfileGetResult>;

export const zSignDepositProfileUpsertInput = z
  .strictObject({
    id: zId.optional(),
    bankCode: z.string().trim().min(1).max(32),
    bankName: z.string().trim().min(1).max(200).optional(),
    accountNumber: z.string().trim().min(4).max(34),
    accountHolder: z.string().trim().min(1).max(200),
    financeBankAccount: z.string().transform(normalizeAccountCode).pipe(zAccountCode).nullable().optional(),
    vietqrFileId: zId.nullable().optional(),
    vietqrPngBase64: z.string().min(1).max(SIGN_SIGNATURE_PNG_BASE64_MAX).optional(),
    clearVietqr: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.accountNumber.includes('\u0000') ||
      v.accountHolder.includes('\u0000') ||
      v.bankCode.includes('\u0000') ||
      Boolean(v.bankName?.includes('\u0000'))
    ) {
      ctx.addIssue({ code: 'custom', path: ['accountNumber'], message: 'NUL characters are not permitted' });
    }
    if (v.vietqrFileId !== undefined && v.vietqrFileId !== null && v.vietqrPngBase64 !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['vietqrPngBase64'], message: 'Provide either vietqrFileId or vietqrPngBase64, not both' });
    }
    if (v.clearVietqr && (v.vietqrFileId !== undefined && v.vietqrFileId !== null || v.vietqrPngBase64 !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['clearVietqr'], message: 'clearVietqr cannot be combined with a new VietQR PNG' });
    }
  });
export type SignDepositProfileUpsertInput = z.infer<typeof zSignDepositProfileUpsertInput>;

export const zSignDepositProfileClearResult = z.strictObject({
  cleared: z.boolean(),
});

export const zSignEnvelopeDepositRecord = z.strictObject({
  id: zId,
  orgId: zId,
  envelopeId: zId,
  amount: zSignContractDecimal,
  currency: z.literal('VND'),
  memoToken: z.string().regex(SIGN_DEPOSIT_MEMO_TOKEN_PATTERN),
  dueDays: z.number().int().min(0).max(SIGN_DEPOSIT_DUE_DAYS_MAX).nullable(),
  depositProfileId: zId.nullable(),
  note: z.string().nullable(),
  snapshotFrozenAt: z.string().nullable(),
  snapshotBankCode: z.string().nullable(),
  snapshotBankName: z.string().nullable(),
  snapshotAccountNumber: z.string().nullable(),
  snapshotAccountHolder: z.string().nullable(),
  snapshotFinanceBankAccount: z.string().nullable(),
  snapshotVietqrFileId: zId.nullable(),
  snapshotEmvcoPayload: z.string().nullable(),
  signerNoticeAt: z.string().nullable(),
  signerNoticeNote: z.string().nullable(),
  signerProofFileId: zId.nullable(),
  signerProofFilename: z.string().nullable(),
  signerProofSha256: z.string().nullable(),
  createdBy: zId.nullable(),
  updatedBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignEnvelopeDepositRecordContract = z.infer<typeof zSignEnvelopeDepositRecord>;

export const zSignEnvelopeDepositSetInput = z.strictObject({
  envelopeId: zId,
  amount: z.string().trim().min(1).max(40),
  dueDays: z.number().int().min(0).max(SIGN_DEPOSIT_DUE_DAYS_MAX).nullable().optional(),
  depositProfileId: zId.optional(),
  memoToken: z.string().trim().toUpperCase().regex(SIGN_DEPOSIT_MEMO_TOKEN_PATTERN).optional(),
  note: z.string().trim().max(SIGN_DEPOSIT_NOTE_MAX).nullable().optional(),
});
export type SignEnvelopeDepositSetInput = z.infer<typeof zSignEnvelopeDepositSetInput>;

export const zSignEnvelopeDepositClearInput = z.strictObject({
  envelopeId: zId,
});
export type SignEnvelopeDepositClearInput = z.infer<typeof zSignEnvelopeDepositClearInput>;

export const zSignEnvelopeDepositClearResult = z.strictObject({
  cleared: z.boolean(),
});

export const zSignPublicDepositSummary = z.strictObject({
  amount: z.string(),
  currency: z.literal('VND'),
  memoToken: z.string(),
  dueDays: z.number().int().min(0).max(SIGN_DEPOSIT_DUE_DAYS_MAX).nullable(),
  note: z.string().nullable(),
  bankCode: z.string(),
  bankName: z.string(),
  accountNumber: z.string(),
  accountHolder: z.string(),
  hasQrPng: z.boolean(),
  emvcoPayload: z.string().nullable(),
  signerNoticeAt: z.string().nullable(),
  signerNoticeNote: z.string().nullable(),
  signerProofFilename: z.string().nullable(),
  signerProofSha256: z.string().nullable(),
});

export const zSignPublicDepositNoticeResult = z.strictObject({
  deposit: zSignPublicDepositSummary,
});
export type SignPublicDepositNoticeResult = z.infer<typeof zSignPublicDepositNoticeResult>;

export const zSignEnvelopeDetail = z.strictObject({
  envelope: z.strictObject({
    id: zId,
    title: z.string(),
    subject: z.string().nullable(),
    message: z.string().nullable(),
    status: zSignEnvelopeStatus,
    routingMode: zSignRoutingMode,
    allowDelegation: z.boolean().optional(),
    sourceKind: zSignSourceKind,
    sourceId: zId.nullable(),
    sourceFileId: zId,
    sourceSha256: z.string(),
    inspectStatus: zSignInspectStatus,
    inspectError: z.string().nullable(),
    pageCount: z.number().int().nullable(),
    pageDimensions: z.array(zSignEnvelopePageDimension).nullable(),
    detectedTags: z.array(zSignDetectedTag).default([]),
    shareSummaryWithSigners: z.boolean().default(false),
    sharedSummary: zSignSharedSummary.nullable().default(null),
    sealedFileId: zId.nullable(),
    sealedSha256: z.string().nullable(),
    sealStatus: zSignSealStatus.nullable(),
    certificateFileId: zId.nullable(),
    certificateSha256: z.string().nullable(),
    certificateCode: z.string().nullable(),
    autoRemindBeforeExpiry: z.boolean().optional(),
    expiresAt: z.string().nullable(),
    sentAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    declinedAt: z.string().nullable(),
    declineAcknowledgedAt: z.string().nullable().optional(),
    voidedAt: z.string().nullable(),
    voidedBy: zId.nullable(),
    voidReason: z.string().nullable(),
    expiredAt: z.string().nullable(),
    version: z.number().int(),
    createdBy: zId,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  signers: z.array(
    z.strictObject({
      id: zId,
      roleKey: zSignTemplateRoleKey.nullable().optional(),
      routingOrder: z.number().int(),
      signerRole: zSignSignerRole,
      roleLabel: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      deliveryMode: zSignDeliveryMode,
      requireEmailOtp: z.boolean(),
      status: zSignSignerStatus,
      tokenLastRemindedAt: z.string().nullable(),
      preExpiryRemindedAt: z.string().nullable().optional(),
      preExpiryRemindStatus: z
        .enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous'])
        .nullable()
        .optional(),
      viewedAt: z.string().nullable(),
      signedAt: z.string().nullable(),
      declinedAt: z.string().nullable(),
      declineReason: z.string().nullable(),
      otpVerifiedAt: z.string().nullable(),
      signatureKind: zSignSignatureKind.nullable(),
      consentAcceptedAt: z.string().nullable(),
      delegatedFromName: z.string().nullable().optional(),
      delegatedFromEmail: z.string().nullable().optional(),
      delegationReason: z.string().nullable().optional(),
      delegationCount: z.number().int().min(0).max(SIGN_MAX_DELEGATIONS).optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  fields: z.array(
    z.strictObject({
      id: zId,
      documentId: zId.nullable().optional(),
      signerId: zId,
      fieldType: zSignFieldType,
      pageNumber: z.number().int(),
      xNorm: z.number(),
      yNorm: z.number(),
      wNorm: z.number(),
      hNorm: z.number(),
      label: z.string().nullable(),
      required: z.boolean(),
      proposedByAi: z.boolean(),
      fontSizePt: z.number().int().nullable(),
      options: z.array(z.string()).nullable().optional(),
      valueText: z.string().nullable(),
      valueChecked: z.boolean().nullable(),
      attachmentFileId: zId.nullable().optional(),
      attachmentFilename: z.string().nullable().optional(),
      attachmentContentType: zSignAttachmentContentType.nullable().optional(),
      attachmentSizeBytes: z.number().int().nullable().optional(),
      attachmentSha256: z.string().nullable().optional(),
      filledAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  documents: z.array(zSignEnvelopeDocumentSummary).optional(),
  deposit: zSignEnvelopeDepositRecord.nullable().optional(),
});

export const zSignEnvelopeEventsResult = z.strictObject({
  envelopeId: zId,
  events: z.array(
    z.strictObject({
      id: zId,
      signerId: zId.nullable(),
      hostUserId: zId.nullable().optional(),
      seq: z.number().int(),
      eventType: z.string(),
      actorType: z.string(),
      actorId: zId.nullable(),
      actorLabel: z.string().nullable(),
      documentSha256: z.string().nullable(),
      prevEventHash: z.string().nullable(),
      eventHash: z.string(),
      payload: z.unknown(),
      occurredAt: z.string(),
    }),
  ),
});

export const zSignEnvelopeVerifyResult = z.strictObject({
  envelopeId: zId,
  status: zSignEnvelopeStatus,
  sealStatus: zSignSealStatus.nullable(),
  valid: z.boolean(),
  eventChain: z.strictObject({
    valid: z.boolean(),
    count: z.number().int(),
    tipHash: z.string().nullable(),
    brokenSeq: z.number().int().nullable(),
    reason: z.string().nullable(),
  }),
  files: z.strictObject({
    sourceSha256: z.string(),
    sealedSha256: z.string().nullable(),
    certificateSha256: z.string().nullable(),
    certificateCode: z.string().nullable(),
    pointersConsistent: z.boolean(),
  }),
});

export const zSignEnvelopeCreateInput = z.strictObject({
  title: z.string().trim().min(1).max(300),
  subject: z.string().trim().min(1).max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  routingMode: zSignRoutingMode.default('parallel'),
  allowDelegation: z.boolean().optional(),
  sourceKind: zSignSourceKind.default('standalone'),
  sourceId: zId.nullable().optional(),
  sourceFileId: zId,
  sourceDocxSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN).optional(),
  autoRemindBeforeExpiry: z.boolean().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  idempotencyKey: zId.optional(),
});
export const zSignEnvelopeCreateResult = z.strictObject({
  envelopeId: zId,
  status: zSignEnvelopeStatus,
  inspectStatus: zSignInspectStatus,
  version: z.number().int(),
});

export const zSignEnvelopeUpdateInput = z.strictObject({
  envelopeId: zId,
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  subject: z.string().trim().min(1).max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  routingMode: zSignRoutingMode.optional(),
  autoRemindBeforeExpiry: z.boolean().optional(),
  allowDelegation: z.boolean().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  idempotencyKey: zId.optional(),
});
export const zSignEnvelopeUpdateResult = z.strictObject({ envelopeId: zId, version: z.number().int() });

// Issued one-time links are never persisted in idempotency replay records (no idempotencyKey).
export const zSignEnvelopeSendInput = z.strictObject({ envelopeId: zId });
export const zSignIssuedLink = z.strictObject({
  signerId: zId,
  tokenId: zId,
  token: z.string(),
  expiresAt: z.string(),
});
export const zSignEnvelopeSendResult = z.strictObject({
  envelopeId: zId,
  status: z.literal('sent'),
  version: z.number().int(),
  links: z.array(zSignIssuedLink),
});

export const zSignEnvelopeRemindInput = z.strictObject({
  envelopeId: zId,
  signerId: zId.optional(),
  idempotencyKey: zId.optional(),
});
export const zSignEnvelopeRemindResult = z.strictObject({
  envelopeId: zId,
  remindedSignerIds: z.array(zId),
});

export const zSignEnvelopeVoidInput = z.strictObject({
  envelopeId: zId,
  reason: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: zId.optional(),
});
export const zSignEnvelopeVoidResult = z.strictObject({
  envelopeId: zId,
  status: z.literal('voided'),
  revokedTokens: z.number().int(),
  version: z.number().int(),
});

export const zSignEnvelopeAcknowledgeDeclineInput = z.strictObject({
  envelopeId: zId,
  idempotencyKey: zId.optional(),
});
export const zSignEnvelopeAcknowledgeDeclineResult = z.strictObject({
  envelopeId: zId,
  declineAcknowledgedAt: z.string(),
  version: z.number().int(),
});

export const zSignSignerAddInput = z.strictObject({
  envelopeId: zId,
  routingOrder: z.number().int().min(1).max(100).optional(),
  signerRole: zSignSignerRole.default('signer'),
  roleLabel: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().min(6).max(32).nullable().optional(),
  deliveryMode: zSignDeliveryMode.default('link'),
  requireEmailOtp: z.boolean().default(false),
  idempotencyKey: zId.optional(),
});
export const zSignSignerAddResult = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  routingOrder: z.number().int(),
  status: zSignSignerStatus,
  version: z.number().int(),
});

export const zSignSignerRemoveInput = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  idempotencyKey: zId.optional(),
});
export const zSignSignerRemoveResult = z.strictObject({
  envelopeId: zId,
  removedSignerId: zId,
  version: z.number().int(),
});

export const zSignSignerReorderInput = z.strictObject({
  envelopeId: zId,
  orders: z
    .array(z.strictObject({ signerId: zId, routingOrder: z.number().int().min(1).max(100) }))
    .min(1)
    .max(SIGN_MAX_SIGNERS),
  idempotencyKey: zId.optional(),
});
export const zSignSignerReorderResult = z.strictObject({ envelopeId: zId, version: z.number().int() });

// Issued one-time links are never persisted in idempotency replay records (no idempotencyKey).
export const zSignSignerCreateLinkInput = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  expiresInHours: z.number().int().min(1).max(720).optional(),
});
export const zSignSignerCreateLinkResult = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  tokenId: zId,
  token: z.string(),
  expiresAt: z.string(),
});

// Issued one-time links are never persisted in idempotency replay records (no idempotencyKey).
export const zSignSignerCorrectRecipientInput = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().min(6).max(32).nullable().optional(),
  deliveryMode: zSignDeliveryMode,
  requireEmailOtp: z.boolean().optional(),
});
export const zSignSignerCorrectRecipientResult = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  status: zSignSignerStatus,
  deliveryMode: zSignDeliveryMode,
  version: z.number().int(),
  revokedTokens: z.number().int(),
  mailStatus: z.enum(['sending', 'queued', 'suppressed']).nullable(),
  link: zSignIssuedLink.nullable(),
});

// Short-lived (<= 2h) single-use in-person host signing session (#3820); never persisted in idempotency replay records.
export const zSignSignerStartInPersonInput = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  expiresInMinutes: z.number().int().min(5).max(SIGN_IN_PERSON_MAX_TTL_MINUTES).optional(),
});
export const zSignSignerStartInPersonResult = z.strictObject({
  envelopeId: zId,
  signerId: zId,
  hostUserId: zId,
  tokenId: zId,
  token: z.string(),
  ceremonyPath: z.string(),
  expiresAt: z.string(),
});

export const zSignFieldItemInput = z
  .strictObject({
    documentId: zId.nullable().optional(),
    signerId: zId,
    fieldType: zSignFieldType,
    pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
    xNorm: z.number().finite().min(0).lt(1),
    yNorm: z.number().finite().min(0).lt(1),
    wNorm: z.number().finite().gt(0).lte(1),
    hNorm: z.number().finite().gt(0).lte(1),
    label: z.string().trim().min(1).max(120).nullable().optional(),
    required: z.boolean().default(true),
    proposedByAi: z.boolean().default(false),
    fontSizePt: z.number().int().min(6).max(36).nullable().optional(),
    options: zSignFieldOptions.nullable().optional(),
  })
  .superRefine((item, ctx) => {
    validateSignFieldTypeOptions(item, ctx);
    validateSignNormBounds(item, ctx);
  });

export const zSignFieldSetInput = z.strictObject({
  envelopeId: zId,
  fields: z.array(zSignFieldItemInput).max(SIGN_MAX_FIELDS),
  idempotencyKey: zId.optional(),
});
export const zSignFieldSetResult = z.strictObject({
  envelopeId: zId,
  fieldIds: z.array(zId),
  version: z.number().int(),
});

export const zSignAiProposedField = z.strictObject({
  signerId: zId,
  signerRoleKey: z.string(),
  fieldType: zSignFieldType,
  pageNumber: z.number().int(),
  xNorm: z.number(),
  yNorm: z.number(),
  wNorm: z.number(),
  hNorm: z.number(),
  label: z.string().nullable(),
  confidence: z.number().nullable(),
  proposedByAi: z.literal(true),
});

export const zSignAiRiskClause = z.strictObject({
  title: z.string(),
  severity: zSignAiSeverity,
  pageNumber: z.number().int().nullable(),
  quote: z.string(),
  explanation: z.string(),
});

export const zSignAiAnalysisRecord = z.strictObject({
  id: zId,
  orgId: zId,
  envelopeId: zId,
  sourceSha256: z.string(),
  status: zSignAiAnalysisStatus,
  proposedFields: z.array(zSignAiProposedField),
  riskClauses: z.array(zSignAiRiskClause),
  summaryText: z.string().nullable(),
  errorMessage: z.string().nullable(),
  promptVersion: z.string(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const zSignAiAnalyzeInput = z.strictObject({
  envelopeId: zId,
  pages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
    .max(SIGN_MAX_PAGES)
    .optional(),
});

export const zSignAiAnalyzeResult = z.strictObject({
  ai: zSignAiOutcomeState,
  status: z.enum(['completed', 'off', 'budget', 'busy', 'not_ready', 'not_draft', 'no_text', 'failed']),
  analysis: zSignAiAnalysisRecord.nullable(),
  proposedFields: z.array(zSignAiProposedField),
  riskClauses: z.array(zSignAiRiskClause),
  summaryText: z.string().nullable(),
});

// eSign Slice 2a (#3526): reusable templates, Approver/CC template roles, and direct signing link management.
export const SIGN_TEMPLATE_STATUSES = ['draft', 'active', 'archived'] as const;
export const zSignTemplateStatus = z.enum(SIGN_TEMPLATE_STATUSES);

export const zSignTemplateDirectLinkSummary = z.strictObject({
  enabled: z.boolean(),
  requireEmailOtp: z.boolean(),
  listedOnPublicHub: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  usesCount: z.number().int().min(0).optional(),
  expiresAt: z.string().nullable().optional(),
  lastRotatedAt: z.string().nullable(),
});

export const zSignTemplateDirectLinkDetail = z.strictObject({
  id: zId,
  enabled: z.boolean(),
  requireEmailOtp: z.boolean(),
  listedOnPublicHub: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  usesCount: z.number().int().min(0).optional(),
  expiresAt: z.string().nullable().optional(),
  lastRotatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const zSignTemplateRoleRecord = z.strictObject({
  id: zId,
  roleKey: zSignTemplateRoleKey,
  signerRole: zSignSignerRole,
  roleLabel: z.string(),
  routingOrder: z.number().int(),
  deliveryMode: zSignDeliveryMode,
  requireEmailOtp: z.boolean(),
});

export const zSignTemplateFieldRecord = z.strictObject({
  id: zId,
  templateRoleId: zId,
  roleKey: zSignTemplateRoleKey,
  fieldType: zSignFieldType,
  pageNumber: z.number().int(),
  xNorm: z.number(),
  yNorm: z.number(),
  wNorm: z.number(),
  hNorm: z.number(),
  label: z.string().nullable(),
  required: z.boolean(),
  fontSizePt: z.number().int().nullable(),
  options: z.array(z.string()).nullable().optional(),
});

export const zSignTemplateSummary = z.strictObject({
  id: zId,
  title: z.string(),
  description: z.string().nullable(),
  routingMode: zSignRoutingMode,
  subject: z.string().nullable(),
  message: z.string().nullable(),
  expiresInHours: z.number().int().nullable(),
  status: zSignTemplateStatus,
  inspectStatus: zSignInspectStatus,
  inspectError: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  roleCount: z.number().int(),
  nonCcRoleCount: z.number().int(),
  fieldCount: z.number().int(),
  directLink: zSignTemplateDirectLinkSummary.nullable(),
  version: z.number().int(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const zSignTemplateListInput = z.strictObject({
  status: zSignTemplateStatus.optional(),
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const zSignTemplateListResult = z.strictObject({
  items: z.array(zSignTemplateSummary),
});

export const zSignTemplateDetail = z.strictObject({
  template: z.strictObject({
    id: zId,
    title: z.string(),
    description: z.string().nullable(),
    routingMode: zSignRoutingMode,
    allowDelegation: z.boolean().optional(),
    subject: z.string().nullable(),
    message: z.string().nullable(),
    expiresInHours: z.number().int().nullable(),
    status: zSignTemplateStatus,
    inspectStatus: zSignInspectStatus,
    inspectError: z.string().nullable(),
    sourceFileId: zId,
    sourceSha256: z.string(),
    pageCount: z.number().int().nullable(),
    pageDimensions: z.array(zSignEnvelopePageDimension).nullable(),
    detectedTags: z.array(zSignDetectedTag).default([]),
    shareSummaryWithSigners: z.boolean().default(false),
    sharedSummary: zSignSharedSummary.nullable().default(null),
    version: z.number().int(),
    archivedAt: z.string().nullable(),
    createdBy: zId,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  roles: z.array(zSignTemplateRoleRecord),
  fields: z.array(zSignTemplateFieldRecord),
  directLink: zSignTemplateDirectLinkDetail.nullable(),
});

export const zSignTemplateCreateInput = z
  .strictObject({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(2000).nullable().optional(),
    routingMode: zSignRoutingMode.optional(),
    allowDelegation: z.boolean().optional(),
    subject: z.string().trim().max(300).nullable().optional(),
    message: z.string().trim().max(5000).nullable().optional(),
    expiresInHours: z.number().int().min(1).max(8760).nullable().optional(),
    sourceFileId: zId.optional(),
    sourceEnvelopeId: zId.optional(),
    sourceDocxSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN).optional(),
    copyRolesAndFields: z.boolean().default(true),
    status: z.enum(['draft', 'active']).optional(),
    idempotencyKey: zId.optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.sourceFileId && !input.sourceEnvelopeId) {
      ctx.addIssue({ code: 'custom', path: ['sourceFileId'], message: 'Either sourceFileId or sourceEnvelopeId is required' });
    }
    if (input.sourceFileId && input.sourceEnvelopeId) {
      ctx.addIssue({ code: 'custom', path: ['sourceEnvelopeId'], message: 'Specify only one of sourceFileId or sourceEnvelopeId' });
    }
  });

export const zSignTemplateCreateResult = z.strictObject({
  templateId: zId,
  status: zSignTemplateStatus,
  inspectStatus: zSignInspectStatus,
  version: z.number().int(),
});

export const SIGN_DOCX_TO_PDF_WARNINGS = [
  'floating_shapes_skipped',
  'ole_objects_skipped',
  'complex_columns_simplified',
  'images_skipped',
  'headers_footers_simplified',
  'footnotes_skipped',
] as const;
export type SignDocxToPdfWarning = (typeof SIGN_DOCX_TO_PDF_WARNINGS)[number];

export interface SignDocxConvertCompletedResult {
  status: 'completed';
  fileId: string;
  filename: string;
  pageCount: number;
  sourceDocxSha256: string;
  warnings: SignDocxToPdfWarning[];
}

export interface SignDocxConvertPendingResult {
  status: 'pending';
  jobId: string;
}

export type SignDocxConvertHttpResponse = SignDocxConvertCompletedResult | SignDocxConvertPendingResult;

export const zSignTemplateUpdateInput = z.strictObject({
  templateId: zId,
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  routingMode: zSignRoutingMode.optional(),
  allowDelegation: z.boolean().optional(),
  subject: z.string().trim().max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  expiresInHours: z.number().int().min(1).max(8760).nullable().optional(),
  status: z.enum(['draft', 'active']).optional(),
  idempotencyKey: zId.optional(),
});

export const zSignTemplateUpdateResult = z.strictObject({
  templateId: zId,
  status: zSignTemplateStatus,
  version: z.number().int(),
});

export const zSignTemplateRoleInput = z.strictObject({
  id: zId.optional(),
  roleKey: zSignTemplateRoleKey,
  signerRole: zSignSignerRole.default('signer'),
  roleLabel: z.string().trim().min(1).max(120),
  routingOrder: z.number().int().min(1).max(100).default(1),
  deliveryMode: zSignDeliveryMode.default('link'),
  requireEmailOtp: z.boolean().default(false),
});

export const zSignTemplateRolesSetInput = z.strictObject({
  templateId: zId,
  roles: z.array(zSignTemplateRoleInput).max(SIGN_MAX_SIGNERS),
  idempotencyKey: zId.optional(),
});

export const zSignTemplateRolesSetResult = z.strictObject({
  templateId: zId,
  version: z.number().int(),
  roles: z.array(zSignTemplateRoleRecord),
});

export const zSignTemplateFieldItemInput = z
  .strictObject({
    templateRoleId: zId.optional(),
    roleKey: zSignTemplateRoleKey.optional(),
    fieldType: zSignFieldType,
    pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
    xNorm: z.number().finite().min(0).lt(1),
    yNorm: z.number().finite().min(0).lt(1),
    wNorm: z.number().finite().gt(0).lte(1),
    hNorm: z.number().finite().gt(0).lte(1),
    label: z.string().trim().min(1).max(200).nullable().optional(),
    required: z.boolean().default(true),
    fontSizePt: z.number().int().min(6).max(36).nullable().optional(),
    options: zSignFieldOptions.nullable().optional(),
  })
  .superRefine((item, ctx) => {
    if (!item.templateRoleId && !item.roleKey) {
      ctx.addIssue({ code: 'custom', path: ['templateRoleId'], message: 'Either templateRoleId or roleKey is required' });
    }
    validateSignFieldTypeOptions(item, ctx);
    validateSignNormBounds(item, ctx);
  });

export const zSignTemplateFieldsSetInput = z.strictObject({
  templateId: zId,
  fields: z.array(zSignTemplateFieldItemInput).max(SIGN_MAX_FIELDS),
  idempotencyKey: zId.optional(),
});

export const zSignTemplateFieldsSetResult = z.strictObject({
  templateId: zId,
  fieldCount: z.number().int(),
  version: z.number().int(),
});

export const zSignTemplateArchiveInput = z.strictObject({
  templateId: zId,
  idempotencyKey: zId.optional(),
});

export const zSignTemplateArchiveResult = z.strictObject({
  templateId: zId,
  status: z.literal('archived'),
  version: z.number().int(),
  revokedLinks: z.number().int(),
});

export const zSignTemplateRecipientInput = z.strictObject({
  roleKey: zSignTemplateRoleKey,
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().min(6).max(32).nullable().optional(),
  deliveryMode: zSignDeliveryMode.optional(),
  requireEmailOtp: z.boolean().optional(),
});

export const zSignTemplateInstantiateInput = z.strictObject({
  templateId: zId,
  title: z.string().trim().min(1).max(300).optional(),
  subject: z.string().trim().max(300).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  allowDelegation: z.boolean().optional(),
  sourceKind: zSignSourceKind.default('standalone'),
  sourceId: zId.nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  autoSend: z.boolean().default(false),
  recipients: z.array(zSignTemplateRecipientInput).max(SIGN_MAX_SIGNERS),
});

export const zSignTemplateInstantiateResult = z.strictObject({
  envelopeId: zId,
  status: z.enum(['draft', 'sent']),
  version: z.number().int(),
  links: z.array(zSignIssuedLink),
});

export const zSignTemplateDirectLinkSetInput = z.strictObject({
  templateId: zId,
  enabled: z.boolean(),
  requireEmailOtp: z.boolean().optional(),
  listedOnPublicHub: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const zSignTemplateDirectLinkRotateInput = z.strictObject({
  templateId: zId,
  requireEmailOtp: z.boolean().optional(),
  listedOnPublicHub: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const zSignTemplateDirectLinkResult = z.strictObject({
  templateId: zId,
  enabled: z.boolean(),
  requireEmailOtp: z.boolean(),
  listedOnPublicHub: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  usesCount: z.number().int().min(0).optional(),
  expiresAt: z.string().nullable().optional(),
  url: z.string().nullable(),
  token: z.string().nullable(),
  lastRotatedAt: z.string().nullable(),
});

// eSign Slice 3b (#3812): Vy deliverable summary draft for Ludy Du an project acceptance minutes.
export const SIGN_ACCEPTANCE_DRAFT_STATUSES = ['used', 'off', 'budget', 'busy', 'no_tasks', 'failed'] as const;
export const zSignAcceptanceDraftStatus = z.enum(SIGN_ACCEPTANCE_DRAFT_STATUSES);
export type SignAcceptanceDraftStatus = z.infer<typeof zSignAcceptanceDraftStatus>;

export const zSignAcceptanceDraftBullet = z.strictObject({
  text: z.string(),
  taskIds: z.array(zId).min(1),
  proposedByAi: z.literal(true),
});
export type SignAcceptanceDraftBullet = z.infer<typeof zSignAcceptanceDraftBullet>;

export const zSignAcceptanceDraftInput = z.strictObject({
  projectId: zId,
  language: z.enum(['vi', 'en']).optional(),
});
export type SignAcceptanceDraftInput = z.infer<typeof zSignAcceptanceDraftInput>;

export const zSignAcceptanceDraftResult = z.strictObject({
  status: zSignAcceptanceDraftStatus,
  bullets: z.array(zSignAcceptanceDraftBullet),
});
export type SignAcceptanceDraftResult = z.infer<typeof zSignAcceptanceDraftResult>;

// eSign Slice 4f (#3822):
// 1) Sender-approved counterparty summary (share_summary_with_signers)
// 2) Deterministic PDF contract version diff + optional metered Vy risk delta
// 3) Vietnamese SME starter contract drafter + optional metered Vy clause customization

export const zSignEnvelopeSharedSummarySetInput = z
  .strictObject({
    envelopeId: zId,
    shareSummaryWithSigners: z.boolean(),
    sharedSummary: zSignSharedSummary.nullable(),
    expectedVersion: z.number().int().positive().optional(),
    idempotencyKey: zId.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.shareSummaryWithSigners && !input.sharedSummary) {
      ctx.addIssue({
        code: 'custom',
        path: ['sharedSummary'],
        message: 'sharedSummary is required when shareSummaryWithSigners is true',
      });
    }
  });

export const zSignEnvelopeSharedSummarySetResult = z.strictObject({
  envelopeId: zId,
  shareSummaryWithSigners: z.boolean(),
  sharedSummary: zSignSharedSummary.nullable(),
  version: z.number().int(),
});

export const zSignTemplateSharedSummarySetInput = z
  .strictObject({
    templateId: zId,
    shareSummaryWithSigners: z.boolean(),
    sharedSummary: zSignSharedSummary.nullable(),
    idempotencyKey: zId.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.shareSummaryWithSigners && !input.sharedSummary) {
      ctx.addIssue({
        code: 'custom',
        path: ['sharedSummary'],
        message: 'sharedSummary is required when shareSummaryWithSigners is true',
      });
    }
  });

export const zSignTemplateSharedSummarySetResult = z.strictObject({
  templateId: zId,
  shareSummaryWithSigners: z.boolean(),
  sharedSummary: zSignSharedSummary.nullable(),
  version: z.number().int(),
});

export const SIGN_DIFF_CHANGE_KINDS = ['unchanged', 'added', 'removed', 'modified'] as const;
export type SignDiffChangeKind = (typeof SIGN_DIFF_CHANGE_KINDS)[number];
export const zSignDiffChangeKind = z.enum(SIGN_DIFF_CHANGE_KINDS);

export const zSignDiffHunk = z.strictObject({
  index: z.number().int().min(0),
  kind: zSignDiffChangeKind,
  pageV1: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  pageV2: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  beforeText: z.string().nullable(),
  afterText: z.string().nullable(),
});
export type SignDiffHunk = z.infer<typeof zSignDiffHunk>;

export const zSignVersionDiffSummary = z.strictObject({
  totalHunks: z.number().int().min(0),
  addedCount: z.number().int().min(0),
  removedCount: z.number().int().min(0),
  modifiedCount: z.number().int().min(0),
  unchangedCount: z.number().int().min(0),
  identical: z.boolean(),
});
export type SignVersionDiffSummary = z.infer<typeof zSignVersionDiffSummary>;

export const zSignVersionDiffResult = z.strictObject({
  pageCountV1: z.number().int().min(0),
  pageCountV2: z.number().int().min(0),
  stats: zSignVersionDiffSummary,
  hunks: z.array(zSignDiffHunk),
});
export type SignVersionDiffResult = z.infer<typeof zSignVersionDiffResult>;

export const zSignAiRiskDeltaItem = z.strictObject({
  title: z.string(),
  severity: zSignAiSeverity,
  pageV1: z.number().int().nullable(),
  pageV2: z.number().int().nullable(),
  beforeQuote: z.string().nullable(),
  afterQuote: z.string().nullable(),
  explanation: z.string(),
  proposedByAi: z.literal(true),
});
export type SignAiRiskDeltaItem = z.infer<typeof zSignAiRiskDeltaItem>;

const zSignDiffPageInput = z.strictObject({
  page: z.number().int().min(1).max(SIGN_MAX_PAGES),
  text: z.string().max(250_000),
});

export const zSignDiffCompareInput = z.strictObject({
  titleV1: z.string().trim().max(300).optional(),
  titleV2: z.string().trim().max(300).optional(),
  fileIdV1: zId.optional(),
  fileIdV2: zId.optional(),
  pagesV1: z.array(zSignDiffPageInput).min(1).max(SIGN_MAX_PAGES),
  pagesV2: z.array(zSignDiffPageInput).min(1).max(SIGN_MAX_PAGES),
  includeAi: z.boolean().default(true),
});
export type SignDiffCompareInput = z.infer<typeof zSignDiffCompareInput>;

export const SIGN_DIFF_AI_STATES = ['used', 'off', 'budget', 'busy', 'no_changes', 'no_text', 'failed'] as const;
export type SignDiffAiState = (typeof SIGN_DIFF_AI_STATES)[number];
export const zSignDiffAiState = z.enum(SIGN_DIFF_AI_STATES);

export const zSignDiffCompareResult = z.strictObject({
  diff: zSignVersionDiffResult,
  ai: zSignDiffAiState,
  summaryText: z.string().nullable(),
  riskDeltas: z.array(zSignAiRiskDeltaItem),
});
export type SignDiffCompareResult = z.infer<typeof zSignDiffCompareResult>;

export const SIGN_STARTER_TEMPLATE_KINDS = [
  'nda_mutual',
  'service_agreement',
  'acceptance_minutes',
  'liquidation_minutes',
  'freelancer_contract',
] as const;
export type SignStarterTemplateKind = (typeof SIGN_STARTER_TEMPLATE_KINDS)[number];
export const zSignStarterTemplateKind = z.enum(SIGN_STARTER_TEMPLATE_KINDS);

export const SIGN_CONTRACT_CURRENCIES = ['VND', 'USD'] as const;
export type SignContractCurrency = (typeof SIGN_CONTRACT_CURRENCIES)[number];
export const zSignContractCurrency = z.enum(SIGN_CONTRACT_CURRENCIES);

export const SIGN_CONTRACT_DECIMAL_VALUE_PATTERN = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/;
export const zSignContractDecimalValue = z
  .string()
  .trim()
  .regex(SIGN_CONTRACT_DECIMAL_VALUE_PATTERN, 'Contract value must be a non-negative decimal string');

export const zSignContractPartyInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  taxCode: z.string().trim().max(32).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  representative: z.string().trim().max(160).nullable().optional(),
  roleTitle: z.string().trim().max(120).nullable().optional(),
});
export type SignContractPartyInput = z.infer<typeof zSignContractPartyInput>;

export const zSignContractClauseItem = z.strictObject({
  heading: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(3000),
  proposedByAi: z.boolean().default(false),
});
export type SignContractClauseItem = z.infer<typeof zSignContractClauseItem>;

export const zSignContractDraftVariables = z.strictObject({
  templateKind: zSignStarterTemplateKind,
  contractNumber: z.string().trim().max(80).nullable().optional(),
  partyA: zSignContractPartyInput,
  partyB: zSignContractPartyInput,
  scopeSummary: z.string().trim().min(1).max(3000),
  contractValue: zSignContractDecimalValue.nullable().optional(),
  currency: zSignContractCurrency.default('VND'),
  effectiveDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'effectiveDate must be YYYY-MM-DD'),
  expiryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiryDate must be YYYY-MM-DD').nullable().optional(),
  customClauses: z.array(zSignContractClauseItem).max(15).default([]),
});
export type SignContractDraftVariables = z.infer<typeof zSignContractDraftVariables>;

export const zSignDrafterProposeInput = z.strictObject({
  variables: zSignContractDraftVariables,
  instructions: z.string().trim().min(1).max(1500),
});
export type SignDrafterProposeInput = z.infer<typeof zSignDrafterProposeInput>;

export const zSignProposedClause = z.strictObject({
  heading: z.string(),
  body: z.string(),
  rationale: z.string().nullable(),
  proposedByAi: z.literal(true),
});
export type SignProposedClause = z.infer<typeof zSignProposedClause>;

export const SIGN_DRAFTER_AI_STATES = ['used', 'off', 'budget', 'busy', 'failed'] as const;
export type SignDrafterAiState = (typeof SIGN_DRAFTER_AI_STATES)[number];
export const zSignDrafterAiState = z.enum(SIGN_DRAFTER_AI_STATES);

export const zSignDrafterProposeResult = z.strictObject({
  ai: zSignDrafterAiState,
  summaryNote: z.string().nullable(),
  proposedClauses: z.array(zSignProposedClause),
});
export type SignDrafterProposeResult = z.infer<typeof zSignDrafterProposeResult>;

export const zSignDrafterRenderPdfInput = zSignContractDraftVariables.extend({});
export type SignDrafterRenderPdfInput = z.infer<typeof zSignDrafterRenderPdfInput>;

export const zSignDrafterRenderPdfResult = z.strictObject({
  title: z.string(),
  filename: z.string(),
  pdfBase64: z.string(),
  sha256: z.string(),
  pageCount: z.number().int().min(1),
});
export type SignDrafterRenderPdfResult = z.infer<typeof zSignDrafterRenderPdfResult>;

// eSign Slice 2c (#3554): Vietnam CA provider connections, #62 legal gate state, and PAdES reconcile_only requests.
export const SIGN_CA_PROVIDERS = ['sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const;
export type SignCaProvider = (typeof SIGN_CA_PROVIDERS)[number];
export const zSignCaProvider = z.enum(SIGN_CA_PROVIDERS);

export const SIGN_CA_CONNECTION_STATUSES = ['active', 'disabled'] as const;
export type SignCaConnectionStatus = (typeof SIGN_CA_CONNECTION_STATUSES)[number];
export const zSignCaConnectionStatus = z.enum(SIGN_CA_CONNECTION_STATUSES);

export const SIGN_CA_TEST_STATES = [
  'works',
  'wrong_credentials',
  'api_not_enabled',
  'ip_not_allowed',
  'unreachable',
  'signing_needs_person',
  'usb_token_unsupported',
] as const;
export type SignCaTestState = (typeof SIGN_CA_TEST_STATES)[number];
export const zSignCaTestState = z.enum(SIGN_CA_TEST_STATES);

export const SIGN_CA_REQUEST_STATUSES = ['pending', 'signed', 'rejected', 'expired', 'failed'] as const;
export type SignCaRequestStatus = (typeof SIGN_CA_REQUEST_STATUSES)[number];
export const zSignCaRequestStatus = z.enum(SIGN_CA_REQUEST_STATUSES);

export const SIGN_CA_SUBFILTERS = ['ETSI.CAdES.detached', 'adbe.pkcs7.detached'] as const;
export type SignCaSubFilter = (typeof SIGN_CA_SUBFILTERS)[number];
export const zSignCaSubFilter = z.enum(SIGN_CA_SUBFILTERS);

export const zSignCaConnectionRecord = z.strictObject({
  id: zId,
  provider: zSignCaProvider,
  label: z.string(),
  certRef: z.string(),
  status: zSignCaConnectionStatus,
  lastTestState: zSignCaTestState.nullable(),
  lastTestedAt: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignCaConnectionRecord = z.infer<typeof zSignCaConnectionRecord>;

export const zSignCaSettingsResult = z.strictObject({
  liveCaEnabled: z.boolean(),
  brokerAvailable: z.boolean(),
  connections: z.array(zSignCaConnectionRecord),
});
export type SignCaSettingsResult = z.infer<typeof zSignCaSettingsResult>;

const zSignCaBaseUrl = z.url({ protocol: /^https$/ }).max(512);

export const zSignCaVnptCredentialsInput = z.strictObject({
  provider: z.literal('vnpt_smartca'),
  spId: z.string().trim().min(1).max(256),
  spPassword: z.string().min(1).max(2048),
  userId: z.string().trim().min(1).max(256),
  serialNumber: z.string().trim().min(1).max(256).optional(),
  baseUrl: zSignCaBaseUrl.optional(),
});

export const zSignCaViettelCredentialsInput = z.strictObject({
  provider: z.literal('viettel_mysign'),
  clientId: z.string().trim().min(1).max(256),
  clientSecret: z.string().min(1).max(2048),
  userId: z.string().trim().min(1).max(256),
  profileId: z.string().trim().min(1).max(256),
  baseUrl: zSignCaBaseUrl.optional(),
});

export const zSignCaMisaCredentialsInput = z.strictObject({
  provider: z.literal('misa_wesign'),
  clientId: z.string().trim().min(1).max(256),
  clientKey: z.string().min(1).max(2048),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(2048),
  taxCode: z.string().trim().min(1).max(64).optional(),
  userId: z.string().trim().min(1).max(256).optional(),
  baseUrl: zSignCaBaseUrl.optional(),
});

export const zSignCaCredentialsInput = z.discriminatedUnion('provider', [
  zSignCaVnptCredentialsInput,
  zSignCaViettelCredentialsInput,
  zSignCaMisaCredentialsInput,
]);
export type SignCaCredentialsInput = z.infer<typeof zSignCaCredentialsInput>;

// Credential-bearing saves never carry an idempotencyKey so secrets and ciphertext never enter idempotency replay rows.
export const zSignCaConnectionSaveInput = z
  .strictObject({
    provider: zSignCaProvider,
    label: z.string().trim().min(1).max(200),
    certRef: z.string().trim().min(1).max(300).optional(),
    status: zSignCaConnectionStatus.default('active'),
    credentials: zSignCaCredentialsInput.optional(),
  })
  .refine((v) => v.credentials === undefined || v.credentials.provider === v.provider, {
    message: 'CA credentials provider must match connection provider',
    path: ['credentials'],
  });
export type SignCaConnectionSaveInput = z.infer<typeof zSignCaConnectionSaveInput>;

export const zSignCaConnectionDisableInput = z.strictObject({
  connectionId: zId,
});

export const zSignCaConnectionTestInput = z.strictObject({
  connectionId: zId,
});

export const zSignCaSigningRequestRecord = z.strictObject({
  id: zId,
  envelopeId: zId,
  signerId: zId.nullable(),
  caConnectionId: zId,
  provider: zSignCaProvider,
  digestSha256: z.string(),
  certRef: z.string(),
  externalTxId: z.string().nullable(),
  status: zSignCaRequestStatus,
  retrySafety: z.literal('reconcile_only'),
  challengeCode: z.string().nullable(),
  errorCode: z.string().nullable(),
  subFilter: zSignCaSubFilter.nullable(),
  padesFileId: zId.nullable(),
  padesSha256: z.string().nullable(),
  pollAttempts: z.number().int(),
  nextPollAt: z.string().nullable(),
  signedAt: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignCaSigningRequestRecord = z.infer<typeof zSignCaSigningRequestRecord>;

export const zSignCaRequestInitiateInput = z.strictObject({
  envelopeId: zId,
  caConnectionId: zId.optional(),
  signerId: zId.optional(),
  idempotencyKey: zId.optional(),
});

export const zSignCaRequestListResult = z.strictObject({
  items: z.array(zSignCaSigningRequestRecord),
});

// eSign Slice 4e (#3821): post-signature structured agreement terms, renewal notice windows, and milestone obligations.
export const SIGN_OBLIGATION_STATUSES = ['proposed', 'confirmed', 'dismissed'] as const;
export const zSignObligationStatus = z.enum(SIGN_OBLIGATION_STATUSES);

export const SIGN_OBLIGATION_ITEM_STATUSES = ['pending', 'completed'] as const;
export const zSignObligationItemStatus = z.enum(SIGN_OBLIGATION_ITEM_STATUSES);

export const SIGN_OBLIGATION_CITATION_FIELDS = [
  'counterpartyName',
  'effectiveDate',
  'expiryDate',
  'renewalNoticeDays',
  'autoRenew',
  'contractValue',
] as const;
export const zSignObligationCitationField = z.enum(SIGN_OBLIGATION_CITATION_FIELDS);

export const SIGN_OBLIGATION_AI_OUTCOMES = [
  'used',
  'off',
  'budget',
  'busy',
  'not_ready',
  'not_completed',
  'no_text',
  'empty',
  'failed',
] as const;
export const zSignObligationAiOutcome = z.enum(SIGN_OBLIGATION_AI_OUTCOMES);
export type SignObligationAiOutcome = z.infer<typeof zSignObligationAiOutcome>;

export const zSignObligationDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO calendar date YYYY-MM-DD');
export const zSignCurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 3-letter currency code');

export const zSignDepositProposal = z.strictObject({
  amount: zSignContractDecimal,
  currency: z.literal('VND'),
  dueDays: z.number().int().min(0).max(365).nullable(),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string().min(1).max(1000),
  proposedByAi: z.literal(true),
});
export type SignDepositProposalContract = z.infer<typeof zSignDepositProposal>;

export const zSignObligationCitation = z.strictObject({
  field: zSignObligationCitationField,
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string().min(1).max(1000),
});
export type SignObligationCitationContract = z.infer<typeof zSignObligationCitation>;

export const zSignObligationItem = z.strictObject({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  dueDate: zSignObligationDate.nullable(),
  status: zSignObligationItemStatus,
  completedAt: z.string().nullable(),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  quoteExcerpt: z.string().max(1000).nullable(),
  proposedByAi: z.boolean(),
});
export type SignObligationItemContract = z.infer<typeof zSignObligationItem>;

export const zSignProposedObligationItem = z.strictObject({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  dueDate: zSignObligationDate.nullable(),
  status: zSignObligationItemStatus,
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string().min(1).max(1000),
  proposedByAi: z.literal(true),
});

export const zSignObligationProposal = z.strictObject({
  counterpartyName: z.string().nullable(),
  effectiveDate: zSignObligationDate.nullable(),
  expiryDate: zSignObligationDate.nullable(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable(),
  autoRenew: z.boolean(),
  contractValue: zSignContractDecimal.nullable(),
  currency: zSignCurrencyCode,
  citations: z.array(zSignObligationCitation),
  obligations: z.array(zSignProposedObligationItem),
  depositProposal: zSignDepositProposal.nullable().optional(),
  proposedByAi: z.literal(true),
});
export type SignObligationProposalContract = z.infer<typeof zSignObligationProposal>;

export const zSignEnvelopeObligationRecord = z.strictObject({
  id: zId,
  orgId: zId,
  envelopeId: zId,
  status: zSignObligationStatus,
  counterpartyName: z.string().nullable(),
  effectiveDate: zSignObligationDate.nullable(),
  expiryDate: zSignObligationDate.nullable(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable(),
  autoRenew: z.boolean(),
  contractValue: zSignContractDecimal.nullable(),
  currency: zSignCurrencyCode,
  obligations: z.array(zSignObligationItem),
  proposal: zSignObligationProposal.nullable(),
  promptVersion: z.string().nullable(),
  confirmedBy: zId.nullable(),
  confirmedAt: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignEnvelopeObligationRecordContract = z.infer<typeof zSignEnvelopeObligationRecord>;

export const zSignObligationGetResult = z.strictObject({
  obligation: zSignEnvelopeObligationRecord.nullable(),
  canEdit: z.boolean(),
});

export const zSignObligationRenewalsListInput = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
});

export const zSignObligationRenewalListItem = z.strictObject({
  envelope: zSignEnvelopeSummary,
  obligation: zSignEnvelopeObligationRecord,
  renewalNoticeDate: zSignObligationDate.nullable(),
  daysUntilNotice: z.number().int().nullable(),
  daysUntilExpiry: z.number().int().nullable(),
  pendingObligationCount: z.number().int().min(0),
  overdueObligationCount: z.number().int().min(0),
  nextObligationDueDate: zSignObligationDate.nullable(),
});
export type SignObligationRenewalListItem = z.infer<typeof zSignObligationRenewalListItem>;

export const zSignObligationRenewalsListResult = z.strictObject({
  items: z.array(zSignObligationRenewalListItem),
});

export const zSignObligationExtractInput = z.strictObject({
  envelopeId: zId,
  pages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
    .max(SIGN_MAX_PAGES)
    .optional(),
});

export const zSignObligationExtractResult = z.strictObject({
  ai: zSignObligationAiOutcome,
  status: z.enum([
    'proposed',
    'confirmed',
    'off',
    'budget',
    'busy',
    'not_ready',
    'not_completed',
    'no_text',
    'empty',
    'failed',
  ]),
  obligation: zSignEnvelopeObligationRecord.nullable(),
});

export const zSignObligationItemInput = z.strictObject({
  id: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(300),
  dueDate: zSignObligationDate.nullable().optional(),
  status: zSignObligationItemStatus.default('pending'),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable().optional(),
  quoteExcerpt: z.string().trim().max(1000).nullable().optional(),
  proposedByAi: z.boolean().optional(),
});

export const zSignObligationUpsertInput = z.strictObject({
  envelopeId: zId,
  counterpartyName: z.string().trim().min(1).max(300).nullable().optional(),
  effectiveDate: zSignObligationDate.nullable().optional(),
  expiryDate: zSignObligationDate.nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
  autoRenew: z.boolean().default(false),
  contractValue: z.string().trim().max(64).nullable().optional(),
  currency: zSignCurrencyCode.default('VND'),
  obligations: z.array(zSignObligationItemInput).max(50).default([]),
  idempotencyKey: zId.optional(),
});

export const zSignObligationDismissInput = z.strictObject({
  envelopeId: zId,
  idempotencyKey: zId.optional(),
});

export const zSignObligationDismissResult = z.strictObject({
  envelopeId: zId,
  dismissed: z.boolean(),
  obligation: zSignEnvelopeObligationRecord.nullable(),
});

export const zSignObligationCompleteItemInput = z.strictObject({
  envelopeId: zId,
  itemId: z.string().trim().min(1).max(80),
  completed: z.boolean().default(true),
  idempotencyKey: zId.optional(),
});

// ---------------------------------------------------------------------------
// Slice 4a (#3817): Saved member signatures/initials and org stamps
// ---------------------------------------------------------------------------

export type SignMemberSignatureKind = z.infer<typeof zSignMemberSignatureKind>;
export type SignOrgStampKind = z.infer<typeof zSignOrgStampKind>;
export type SignOrgStampStatus = z.infer<typeof zSignOrgStampStatus>;

export const zSignMemberSignatureRecord = z.strictObject({
  id: zId,
  kind: zSignMemberSignatureKind,
  signatureKind: zSignSignatureKind,
  signatureTypedText: z.string().nullable(),
  signaturePngBase64: z.string(),
  imageSha256: z.string(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignMemberSignatureRecord = z.infer<typeof zSignMemberSignatureRecord>;

export const zSignMemberSignatureListInput = z.strictObject({});
export const zSignMemberSignatureListResult = z.strictObject({
  items: z.array(zSignMemberSignatureRecord),
});
export type SignMemberSignatureListResult = z.infer<typeof zSignMemberSignatureListResult>;

export const zSignMemberSignatureUpsertInput = z.strictObject({
  kind: zSignMemberSignatureKind,
  signatureKind: zSignSignatureKind,
  signatureTypedText: z.string().trim().min(1).max(200).nullable().optional(),
  signaturePngBase64: z.string().min(60).max(380_000),
  idempotencyKey: zId.optional(),
});
export type SignMemberSignatureUpsertInput = z.infer<typeof zSignMemberSignatureUpsertInput>;

export const zSignMemberSignatureUpsertResult = z.strictObject({
  id: zId,
  kind: zSignMemberSignatureKind,
  signatureKind: zSignSignatureKind,
  imageSha256: z.string(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  updatedAt: z.string(),
});
export type SignMemberSignatureUpsertResult = z.infer<typeof zSignMemberSignatureUpsertResult>;

export const zSignMemberSignatureDeleteInput = z.strictObject({
  kind: zSignMemberSignatureKind,
  idempotencyKey: zId.optional(),
});
export type SignMemberSignatureDeleteInput = z.infer<typeof zSignMemberSignatureDeleteInput>;

export const zSignMemberSignatureDeleteResult = z.strictObject({
  deleted: z.boolean(),
});
export type SignMemberSignatureDeleteResult = z.infer<typeof zSignMemberSignatureDeleteResult>;

export const zSignOrgStampRecord = z.strictObject({
  id: zId,
  name: z.string(),
  stampKind: zSignOrgStampKind,
  fileId: zId.nullable(),
  stampPngBase64: z.string(),
  imageSha256: z.string(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  status: zSignOrgStampStatus,
  archivedAt: z.string().nullable(),
  createdBy: zId,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignOrgStampRecord = z.infer<typeof zSignOrgStampRecord>;

export const zSignOrgStampListInput = z.strictObject({
  status: zSignOrgStampStatus.optional(),
});
export type SignOrgStampListInput = z.infer<typeof zSignOrgStampListInput>;

export const zSignOrgStampListResult = z.strictObject({
  items: z.array(zSignOrgStampRecord),
  canManage: z.boolean(),
});
export type SignOrgStampListResult = z.infer<typeof zSignOrgStampListResult>;

export const zSignOrgStampCreateInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  stampKind: zSignOrgStampKind.default('company'),
  fileId: zId.nullable().optional(),
  stampPngBase64: z.string().min(60).max(380_000),
  idempotencyKey: zId.optional(),
});
export type SignOrgStampCreateInput = z.infer<typeof zSignOrgStampCreateInput>;

export const zSignOrgStampCreateResult = z.strictObject({
  id: zId,
  name: z.string(),
  stampKind: zSignOrgStampKind,
  fileId: zId.nullable(),
  imageSha256: z.string(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  status: zSignOrgStampStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignOrgStampCreateResult = z.infer<typeof zSignOrgStampCreateResult>;

export const zSignOrgStampArchiveInput = z.strictObject({
  stampId: zId,
  idempotencyKey: zId.optional(),
});
export type SignOrgStampArchiveInput = z.infer<typeof zSignOrgStampArchiveInput>;

export const zSignOrgStampArchiveResult = z.strictObject({
  stampId: zId,
  status: z.literal('archived'),
  archivedAt: z.string(),
});
export type SignOrgStampArchiveResult = z.infer<typeof zSignOrgStampArchiveResult>;

// ---------------------------------------------------------------------------
// Slice 5a (#4439): Permission-scoped Contract Vault search & metered Vy Q&A
// ---------------------------------------------------------------------------

export const SIGN_VAULT_CANDIDATES_MAX = 20;
export const SIGN_VAULT_CITATIONS_MAX = 8;
export const SIGN_VAULT_SNIPPET_MAX_CHARS = 1000;

export const SIGN_VAULT_SNIPPET_KINDS = [
  'title',
  'counterparty',
  'obligation',
  'clause',
  'summary',
  'shared_summary',
] as const;
export type SignVaultSnippetKind = (typeof SIGN_VAULT_SNIPPET_KINDS)[number];
export const zSignVaultSnippetKind = z.enum(SIGN_VAULT_SNIPPET_KINDS);

export const SIGN_VAULT_AI_OUTCOMES = [
  'used',
  'off',
  'budget',
  'busy',
  'no_matches',
  'empty',
  'failed',
] as const;
export type SignVaultAiOutcome = (typeof SIGN_VAULT_AI_OUTCOMES)[number];
export const zSignVaultAiOutcome = z.enum(SIGN_VAULT_AI_OUTCOMES);

export const zSignVaultMatchSnippet = z.strictObject({
  kind: zSignVaultSnippetKind,
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  excerpt: z.string().min(1).max(SIGN_VAULT_SNIPPET_MAX_CHARS),
});
export type SignVaultMatchSnippet = z.infer<typeof zSignVaultMatchSnippet>;

export const zSignVaultMatchItem = z.strictObject({
  envelopeId: zId,
  title: z.string(),
  status: zSignEnvelopeStatus,
  sourceKind: zSignSourceKind,
  pageCount: z.number().int().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  counterpartyName: z.string().nullable(),
  effectiveDate: zSignObligationDate.nullable(),
  expiryDate: zSignObligationDate.nullable(),
  renewalNoticeDays: z.number().int().nullable(),
  autoRenew: z.boolean(),
  contractValue: z.string().nullable(),
  currency: z.string().nullable(),
  score: z.number().int().min(0),
  snippets: z.array(zSignVaultMatchSnippet).max(6),
});
export type SignVaultMatchItem = z.infer<typeof zSignVaultMatchItem>;

export const zSignVaultSearchInput = z.strictObject({
  question: z.string().trim().min(1).max(500),
  status: zSignEnvelopeStatus.optional(),
  limit: z.number().int().min(1).max(SIGN_VAULT_CANDIDATES_MAX).default(SIGN_VAULT_CANDIDATES_MAX),
});
export type SignVaultSearchInput = z.infer<typeof zSignVaultSearchInput>;

export const zSignVaultSearchResult = z.strictObject({
  items: z.array(zSignVaultMatchItem).max(SIGN_VAULT_CANDIDATES_MAX),
});
export type SignVaultSearchResult = z.infer<typeof zSignVaultSearchResult>;

export const zSignVaultCitation = z.strictObject({
  envelopeId: zId,
  envelopeTitle: z.string().min(1).max(300),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  quoteExcerpt: z.string().min(1).max(SIGN_VAULT_SNIPPET_MAX_CHARS),
});
export type SignVaultCitation = z.infer<typeof zSignVaultCitation>;

export const zSignVaultAiSummary = z.strictObject({
  answer: z.string().min(1).max(2000),
  proposedByAi: z.literal(true),
  citations: z.array(zSignVaultCitation).min(1).max(SIGN_VAULT_CITATIONS_MAX),
});
export type SignVaultAiSummary = z.infer<typeof zSignVaultAiSummary>;

export const zSignVaultAskInput = z.strictObject({
  question: z.string().trim().min(1).max(500),
  status: zSignEnvelopeStatus.optional(),
  limit: z.number().int().min(1).max(SIGN_VAULT_CANDIDATES_MAX).default(12),
});
export type SignVaultAskInput = z.infer<typeof zSignVaultAskInput>;

export const zSignVaultAskResult = z.strictObject({
  ai: zSignVaultAiOutcome,
  items: z.array(zSignVaultMatchItem).max(SIGN_VAULT_CANDIDATES_MAX),
  summary: zSignVaultAiSummary.nullable(),
});
export type SignVaultAskResult = z.infer<typeof zSignVaultAskResult>;

// ---------------------------------------------------------------------------
// Slice 5b (#4440): Signed HMAC outbound webhooks, dual-secret rotation, and safe-metadata delivery logs
// ---------------------------------------------------------------------------
export const SIGN_MAX_WEBHOOKS = 20;

export const SIGN_WEBHOOK_EVENT_TYPES = [
  'sign.envelope.sent',
  'sign.signer.signed',
  'sign.envelope.completed',
  'sign.envelope.declined',
  'sign.envelope.expired',
] as const;
export type SignWebhookEventType = (typeof SIGN_WEBHOOK_EVENT_TYPES)[number];
export const zSignWebhookEventType = z.enum(SIGN_WEBHOOK_EVENT_TYPES);

export const SIGN_WEBHOOK_DELIVERY_EVENT_TYPES = [...SIGN_WEBHOOK_EVENT_TYPES, 'ping'] as const;
export type SignWebhookDeliveryEventType = (typeof SIGN_WEBHOOK_DELIVERY_EVENT_TYPES)[number];
export const zSignWebhookDeliveryEventType = z.enum(SIGN_WEBHOOK_DELIVERY_EVENT_TYPES);

export const SIGN_WEBHOOK_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'dropped'] as const;
export type SignWebhookDeliveryStatus = (typeof SIGN_WEBHOOK_DELIVERY_STATUSES)[number];
export const zSignWebhookDeliveryStatus = z.enum(SIGN_WEBHOOK_DELIVERY_STATUSES);

export const SIGN_WEBHOOK_LAST_STATUSES = ['sent', 'failed'] as const;
export type SignWebhookLastStatus = (typeof SIGN_WEBHOOK_LAST_STATUSES)[number];
export const zSignWebhookLastStatus = z.enum(SIGN_WEBHOOK_LAST_STATUSES);

export const SIGN_WEBHOOK_PAUSED_REASONS = ['failing'] as const;
export type SignWebhookPausedReason = (typeof SIGN_WEBHOOK_PAUSED_REASONS)[number];
export const zSignWebhookPausedReason = z.enum(SIGN_WEBHOOK_PAUSED_REASONS);

export const SIGN_WEBHOOK_PAYLOAD_ENVELOPE_STATUSES = [
  'sent',
  'in_progress',
  'completed',
  'declined',
  'expired',
] as const;

const zWebhookInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const zWebhookHint = z.string().regex(/^whk_[0-9a-f]{8}$/);
const zWebhookSignerRole = z.enum(['signer', 'approver']);
const zWebhookSha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const zSignWebhookPingPayload = z.strictObject({
  eventId: zId,
  eventType: z.literal('ping'),
  occurredAt: zWebhookInstant,
  orgId: zId,
  status: z.literal('ok'),
});

export const zSignWebhookEnvelopePayload = z.strictObject({
  eventId: zId,
  eventType: zSignWebhookEventType,
  occurredAt: zWebhookInstant,
  orgId: zId,
  envelopeId: zId,
  status: z.enum(SIGN_WEBHOOK_PAYLOAD_ENVELOPE_STATUSES),
  signerId: zId.optional(),
  signerRole: zWebhookSignerRole.optional(),
  signedAt: zWebhookInstant.optional(),
  completedAt: zWebhookInstant.optional(),
  certificateCode: z.string().min(1).max(64).optional(),
  sealedSha256: zWebhookSha256.optional(),
});

export const zSignWebhookPayload = z.union([zSignWebhookPingPayload, zSignWebhookEnvelopePayload]);
export type SignWebhookPayload = z.infer<typeof zSignWebhookPayload>;

// Rebuilds a validated webhook payload in canonical key order so signed bytes never depend on caller object order
// and no PDF, signing token, OTP, document title, email, or phone can ever ride in any field (#4440).
export function signWebhookPayload(input: unknown): SignWebhookPayload {
  const parsed = zSignWebhookPayload.parse(input);
  if (parsed.eventType === 'ping') {
    return {
      eventId: parsed.eventId,
      eventType: 'ping',
      occurredAt: parsed.occurredAt,
      orgId: parsed.orgId,
      status: 'ok',
    };
  }
  return {
    eventId: parsed.eventId,
    eventType: parsed.eventType,
    occurredAt: parsed.occurredAt,
    orgId: parsed.orgId,
    envelopeId: parsed.envelopeId,
    status: parsed.status,
    ...(parsed.signerId !== undefined ? { signerId: parsed.signerId } : {}),
    ...(parsed.signerRole !== undefined ? { signerRole: parsed.signerRole } : {}),
    ...(parsed.signedAt !== undefined ? { signedAt: parsed.signedAt } : {}),
    ...(parsed.completedAt !== undefined ? { completedAt: parsed.completedAt } : {}),
    ...(parsed.certificateCode !== undefined ? { certificateCode: parsed.certificateCode } : {}),
    ...(parsed.sealedSha256 !== undefined ? { sealedSha256: parsed.sealedSha256 } : {}),
  };
}

export function signWebhookBody(input: unknown): string {
  return JSON.stringify(signWebhookPayload(input));
}

export const zSignWebhookSealedCredential = z.strictObject({
  keyId: z.string().min(1).max(128),
  secretEnvelope: z.string().min(16).max(16_384),
  secretHint: zWebhookHint,
});
export type SignWebhookSealedCredential = z.infer<typeof zSignWebhookSealedCredential>;

export const zSignWebhookRecord = z.strictObject({
  id: zId,
  url: z.string(),
  events: z.array(zSignWebhookEventType),
  enabled: z.boolean(),
  secretHint: z.string(),
  previousExpiresAt: z.string().nullable(),
  consecutiveFailures: z.number().int().min(0),
  failingSince: z.string().nullable(),
  pausedReason: zSignWebhookPausedReason.nullable(),
  lastDeliveryAt: z.string().nullable(),
  lastStatus: zSignWebhookLastStatus.nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignWebhookRecord = z.infer<typeof zSignWebhookRecord>;

export const zSignWebhookListInput = z.strictObject({});
export type SignWebhookListInput = z.infer<typeof zSignWebhookListInput>;

export const zSignWebhookListResult = z.strictObject({
  items: z.array(zSignWebhookRecord),
  brokerAvailable: z.boolean(),
});
export type SignWebhookListResult = z.infer<typeof zSignWebhookListResult>;

export const zSignWebhookCreateInput = z.strictObject({
  url: zMcpWakeUrl,
  events: z.array(zSignWebhookEventType).min(1).max(SIGN_WEBHOOK_EVENT_TYPES.length),
  enabled: z.boolean().default(true),
});
export type SignWebhookCreateInput = z.infer<typeof zSignWebhookCreateInput>;

export const zSignWebhookCreateCommandInput = z.strictObject({
  id: zId,
  url: zMcpWakeUrl,
  events: z.array(zSignWebhookEventType).min(1).max(SIGN_WEBHOOK_EVENT_TYPES.length),
  enabled: z.boolean().default(true),
  keyId: z.string().min(1).max(128),
  secretEnvelope: z.string().min(16).max(16_384),
  secretHint: zWebhookHint,
});
export type SignWebhookCreateCommandInput = z.infer<typeof zSignWebhookCreateCommandInput>;

export const zSignWebhookWithSecretResult = z.strictObject({
  webhook: zSignWebhookRecord,
  secret: z.string().nullable(),
});
export type SignWebhookWithSecretResult = z.infer<typeof zSignWebhookWithSecretResult>;

export const zSignWebhookUpdateInput = z.strictObject({
  webhookId: zId,
  url: zMcpWakeUrl,
  events: z.array(zSignWebhookEventType).min(1).max(SIGN_WEBHOOK_EVENT_TYPES.length),
  enabled: z.boolean(),
  idempotencyKey: zId.optional(),
});
export type SignWebhookUpdateInput = z.infer<typeof zSignWebhookUpdateInput>;

export const zSignWebhookRotateSecretInput = z.strictObject({
  webhookId: zId,
});
export type SignWebhookRotateSecretInput = z.infer<typeof zSignWebhookRotateSecretInput>;

export const zSignWebhookRotateSecretCommandInput = z.strictObject({
  webhookId: zId,
  keyId: z.string().min(1).max(128),
  secretEnvelope: z.string().min(16).max(16_384),
  secretHint: zWebhookHint,
});
export type SignWebhookRotateSecretCommandInput = z.infer<typeof zSignWebhookRotateSecretCommandInput>;

export const zSignWebhookDeleteInput = z.strictObject({
  webhookId: zId,
  idempotencyKey: zId.optional(),
});
export type SignWebhookDeleteInput = z.infer<typeof zSignWebhookDeleteInput>;

export const zSignWebhookDeleteResult = z.strictObject({
  webhookId: zId,
  deleted: z.boolean(),
});
export type SignWebhookDeleteResult = z.infer<typeof zSignWebhookDeleteResult>;

export const zSignWebhookPingInput = z.strictObject({
  webhookId: zId,
  idempotencyKey: zId.optional(),
});
export type SignWebhookPingInput = z.infer<typeof zSignWebhookPingInput>;

export const zSignWebhookPingResult = z.strictObject({
  deliveryId: zId,
  webhookId: zId,
  eventType: z.literal('ping'),
  status: z.literal('queued'),
  createdAt: z.string(),
});
export type SignWebhookPingResult = z.infer<typeof zSignWebhookPingResult>;

export const zSignWebhookDeliveriesInput = z.strictObject({
  webhookId: zId.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type SignWebhookDeliveriesInput = z.infer<typeof zSignWebhookDeliveriesInput>;

export const zSignWebhookDeliveryRecord = z.strictObject({
  id: zId,
  webhookId: zId,
  envelopeId: zId.nullable(),
  eventType: zSignWebhookDeliveryEventType,
  status: zSignWebhookDeliveryStatus,
  attempts: z.number().int().min(0),
  lastCode: z.number().int().nullable(),
  handedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  payload: zSignWebhookPayload.nullable(),
});
export type SignWebhookDeliveryRecord = z.infer<typeof zSignWebhookDeliveryRecord>;

export const zSignWebhookDeliveriesResult = z.strictObject({
  items: z.array(zSignWebhookDeliveryRecord),
});
export type SignWebhookDeliveriesResult = z.infer<typeof zSignWebhookDeliveriesResult>;

// System-only worker queries & commands for sign-hook-sweep / sign-hook-deliver
export const zSignHookEventRef = z.strictObject({
  id: zId,
});
export const zSignHookTargetRef = z.strictObject({
  webhookId: zId,
});
export const zSignHookRecordInput = z.strictObject({
  id: zId,
  outcome: z.enum(['sent', 'retry', 'failed', 'dropped', 'expired']),
  code: z.number().int().min(100).max(599).optional(),
});
export interface SignHookDeliveryRow {
  id: string;
  webhookId: string;
  envelopeId: string | null;
  envelopeSourceKind: string | null;
  eventType: SignWebhookDeliveryEventType;
  payload: SignWebhookPayload | null;
  status: SignWebhookDeliveryStatus;
  attempts: number;
}
export interface SignHookTargetRow {
  id: string;
  url: string;
  sealed: { keyId: string; envelope: string };
  previous: { keyId: string; envelope: string } | null;
}

// ---------------------------------------------------------------------------
// Slice 5d (#4442): SME contract playbook checklist and cited redline suggestions
// ---------------------------------------------------------------------------

export const SIGN_PLAYBOOK_SEVERITIES = ['info', 'warn', 'critical'] as const;
export const zSignPlaybookSeverity = z.enum(SIGN_PLAYBOOK_SEVERITIES);
export type SignPlaybookSeverityContract = z.infer<typeof zSignPlaybookSeverity>;

export const SIGN_PLAYBOOK_MODES = ['ai', 'deterministic', 'manual'] as const;
export const zSignPlaybookMode = z.enum(SIGN_PLAYBOOK_MODES);
export type SignPlaybookModeContract = z.infer<typeof zSignPlaybookMode>;

export const SIGN_PLAYBOOK_VERDICTS = ['pass', 'warn', 'fail', 'unknown'] as const;
export const zSignPlaybookVerdict = z.enum(SIGN_PLAYBOOK_VERDICTS);
export type SignPlaybookVerdictContract = z.infer<typeof zSignPlaybookVerdict>;

export const SIGN_PLAYBOOK_MAX_TOTAL_CHARS = 750_000;

export const SIGN_PLAYBOOK_AI_OUTCOMES = [
  'used',
  'off',
  'budget',
  'busy',
  'not_ready',
  'no_text',
  'no_rules',
  'empty',
  'failed',
] as const;
export const zSignPlaybookAiOutcome = z.enum(SIGN_PLAYBOOK_AI_OUTCOMES);
export type SignPlaybookAiOutcome = z.infer<typeof zSignPlaybookAiOutcome>;

export const zSignPlaybookRuleRecord = z.strictObject({
  id: zId,
  title: z.string(),
  guidance: z.string(),
  severity: zSignPlaybookSeverity,
  matchKeywords: z.array(z.string()),
  active: z.boolean(),
  isDefault: z.boolean(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignPlaybookRuleRecord = z.infer<typeof zSignPlaybookRuleRecord>;

export const zSignPlaybookRulesListInput = z.strictObject({
  activeOnly: z.boolean().optional(),
});
export type SignPlaybookRulesListInput = z.infer<typeof zSignPlaybookRulesListInput>;

export const zSignPlaybookRulesListResult = z.strictObject({
  items: z.array(zSignPlaybookRuleRecord),
  canManage: z.boolean(),
  isSeeded: z.boolean(),
});
export type SignPlaybookRulesListResult = z.infer<typeof zSignPlaybookRulesListResult>;

export const zSignPlaybookRuleUpsertInput = z.strictObject({
  ruleId: zId.optional(),
  title: z.string().trim().min(1).max(200),
  guidance: z.string().trim().min(1).max(2000),
  severity: zSignPlaybookSeverity.default('warn'),
  matchKeywords: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
  active: z.boolean().default(true),
  idempotencyKey: zId.optional(),
});
export type SignPlaybookRuleUpsertInput = z.infer<typeof zSignPlaybookRuleUpsertInput>;

export const zSignPlaybookRuleDeleteInput = z.strictObject({
  ruleId: zId,
  idempotencyKey: zId.optional(),
});
export type SignPlaybookRuleDeleteInput = z.infer<typeof zSignPlaybookRuleDeleteInput>;

export const zSignPlaybookRuleDeleteResult = z.strictObject({
  deleted: z.boolean(),
});
export type SignPlaybookRuleDeleteResult = z.infer<typeof zSignPlaybookRuleDeleteResult>;

export const zSignPlaybookSeedDefaultsInput = z.strictObject({
  idempotencyKey: zId.optional(),
});
export type SignPlaybookSeedDefaultsInput = z.infer<typeof zSignPlaybookSeedDefaultsInput>;

export const zSignPlaybookFinding = z.strictObject({
  ruleId: zId,
  ruleTitle: z.string(),
  severity: zSignPlaybookSeverity,
  verdict: zSignPlaybookVerdict,
  rationale: z.string(),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  quoteExcerpt: z.string().nullable(),
  suggestedRedline: z.string().nullable(),
  proposedByAi: z.boolean(),
  manualNote: z.string().nullable(),
  overriddenBy: zId.nullable(),
  overriddenAt: z.string().nullable(),
});
export type SignPlaybookFindingContract = z.infer<typeof zSignPlaybookFinding>;

export const zSignEnvelopePlaybookCheckRecord = z.strictObject({
  id: zId,
  envelopeId: zId,
  sourceSha256: z.string(),
  revision: z.string(),
  isStale: z.boolean(),
  mode: zSignPlaybookMode,
  findings: z.array(zSignPlaybookFinding),
  promptVersion: z.string().nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignEnvelopePlaybookCheckRecord = z.infer<typeof zSignEnvelopePlaybookCheckRecord>;

export const zSignPlaybookGetResult = z.strictObject({
  check: zSignEnvelopePlaybookCheckRecord.nullable(),
  canEdit: z.boolean(),
  activeRulesCount: z.number().int().min(0),
});
export type SignPlaybookGetResult = z.infer<typeof zSignPlaybookGetResult>;

export const zSignPlaybookEvaluateInput = z.strictObject({
  envelopeId: zId,
  useAi: z.boolean().default(true),
  pages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
    .max(SIGN_MAX_PAGES)
    .refine(
      (pages) => pages.reduce((sum, item) => sum + item.text.length, 0) <= SIGN_PLAYBOOK_MAX_TOTAL_CHARS,
      `Total extracted text across all pages must not exceed ${SIGN_PLAYBOOK_MAX_TOTAL_CHARS} characters`,
    )
    .optional(),
  idempotencyKey: zId.optional(),
});
export type SignPlaybookEvaluateInput = z.infer<typeof zSignPlaybookEvaluateInput>;

export const zSignPlaybookEvaluateResult = z.strictObject({
  ai: zSignPlaybookAiOutcome,
  check: zSignEnvelopePlaybookCheckRecord.nullable(),
});
export type SignPlaybookEvaluateResult = z.infer<typeof zSignPlaybookEvaluateResult>;

export const zSignPlaybookOverrideFindingInput = z.strictObject({
  envelopeId: zId,
  ruleId: zId,
  checkRevision: z.string().trim().min(1).max(128),
  verdict: zSignPlaybookVerdict,
  manualNote: z.string().trim().max(500).nullable().optional(),
  idempotencyKey: zId.optional(),
});
export type SignPlaybookOverrideFindingInput = z.infer<typeof zSignPlaybookOverrideFindingInput>;

// ---------------------------------------------------------------------------
// Slice 5e (#4443): Sender-side Signer KYC Attachment Verification Check
// ---------------------------------------------------------------------------

export const SIGN_KYC_CHECK_STATUSES = ['pending', 'matched', 'mismatch', 'needs_review'] as const;
export type SignKycCheckStatusContract = (typeof SIGN_KYC_CHECK_STATUSES)[number];
export const zSignKycCheckStatus = z.enum(SIGN_KYC_CHECK_STATUSES);

export const SIGN_KYC_CHECK_MODES = ['deterministic', 'ai', 'manual'] as const;
export type SignKycCheckModeContract = (typeof SIGN_KYC_CHECK_MODES)[number];
export const zSignKycCheckMode = z.enum(SIGN_KYC_CHECK_MODES);

export const SIGN_KYC_DOC_KINDS = ['cccd', 'dkkd', 'poa', 'other'] as const;
export type SignKycDocKindContract = (typeof SIGN_KYC_DOC_KINDS)[number];
export const zSignKycDocKind = z.enum(SIGN_KYC_DOC_KINDS);

export const SIGN_KYC_ITEM_STATUSES = ['matched', 'mismatch', 'needs_review'] as const;
export type SignKycItemStatusContract = (typeof SIGN_KYC_ITEM_STATUSES)[number];
export const zSignKycItemStatus = z.enum(SIGN_KYC_ITEM_STATUSES);

export const SIGN_KYC_FINDING_CATEGORIES = [
  'file_integrity',
  'tax_code',
  'national_id',
  'entity_name',
  'authorized_signer',
  'authority_scope',
  'validity_date',
] as const;
export type SignKycFindingCategoryContract = (typeof SIGN_KYC_FINDING_CATEGORIES)[number];
export const zSignKycFindingCategory = z.enum(SIGN_KYC_FINDING_CATEGORIES);

export const SIGN_KYC_AI_CATEGORIES = [
  'entity_name',
  'tax_code',
  'national_id',
  'authorized_signer',
  'authority_scope',
  'validity_date',
] as const;
export type SignKycAiCategoryContract = (typeof SIGN_KYC_AI_CATEGORIES)[number];
export const zSignKycAiCategory = z.enum(SIGN_KYC_AI_CATEGORIES);

export const SIGN_KYC_AI_OUTCOMES = [
  'used',
  'off',
  'budget',
  'busy',
  'not_ready',
  'no_text',
  'empty',
  'failed',
] as const;
export type SignKycAiOutcomeContract = (typeof SIGN_KYC_AI_OUTCOMES)[number];
export const zSignKycAiOutcome = z.enum(SIGN_KYC_AI_OUTCOMES);

export const zSignKycDeterministicItem = z.strictObject({
  category: zSignKycFindingCategory,
  status: zSignKycItemStatus,
  extractedValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  detail: z.string(),
});
export type SignKycDeterministicItemContract = z.infer<typeof zSignKycDeterministicItem>;

export const zSignKycAiDiscrepancy = z.strictObject({
  category: zSignKycAiCategory,
  assessment: z.enum(['match', 'mismatch', 'unclear']),
  extractedValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
  quoteExcerpt: z.string(),
  explanation: z.string(),
  proposedByAi: z.literal(true),
});
export type SignKycAiDiscrepancyContract = z.infer<typeof zSignKycAiDiscrepancy>;

export const zSignKycAiProposal = z.strictObject({
  suggestedStatus: z.enum(['matched', 'mismatch', 'needs_review']),
  summaryNote: z.string().nullable(),
  findings: z.array(zSignKycAiDiscrepancy),
  promptVersion: z.string(),
  proposedByAi: z.literal(true),
});
export type SignKycAiProposalContract = z.infer<typeof zSignKycAiProposal>;

export const zSignKycFindings = z.strictObject({
  documentKind: zSignKycDocKind,
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256Verified: z.boolean(),
  pageCount: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  inspectState: z.enum(['pending', 'inspected', 'image_metadata_only', 'failed']),
  inspectError: z.string().nullable(),
  expectedSignerName: z.string().nullable(),
  expectedEntityName: z.string().nullable(),
  expectedTaxCode: z.string().nullable(),
  extractedTaxCodes: z.array(z.string()),
  extractedNationalIds: z.array(z.string()),
  extractedTextPreview: z.string().nullable(),
  deterministicChecks: z.array(zSignKycDeterministicItem),
  aiProposal: zSignKycAiProposal.nullable(),
  manualNote: z.string().nullable(),
});
export type SignKycFindingsContract = z.infer<typeof zSignKycFindings>;

export const zSignKycCheckRecord = z.strictObject({
  id: zId,
  envelopeId: zId,
  fieldId: zId,
  fileId: zId,
  fileSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN),
  status: zSignKycCheckStatus,
  mode: zSignKycCheckMode,
  findings: zSignKycFindings,
  checkedBy: zId.nullable(),
  checkedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignKycCheckRecordContract = z.infer<typeof zSignKycCheckRecord>;

export const zSignKycAttachmentSlot = z.strictObject({
  fieldId: zId,
  signerId: zId,
  signerName: z.string(),
  signerEmail: z.string().nullable(),
  signerRoleLabel: z.string(),
  fieldLabel: z.string().nullable(),
  fileId: zId,
  filename: z.string(),
  contentType: zSignAttachmentContentType,
  sizeBytes: z.number().int().min(0),
  fileSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN),
  filledAt: z.string().nullable(),
  obligationCounterpartyName: z.string().nullable(),
  check: zSignKycCheckRecord.nullable(),
});
export type SignKycAttachmentSlotContract = z.infer<typeof zSignKycAttachmentSlot>;

export const zSignKycListResult = z.strictObject({
  envelopeId: zId,
  canWrite: z.boolean(),
  items: z.array(zSignKycAttachmentSlot),
});
export type SignKycListResultContract = z.infer<typeof zSignKycListResult>;

export const zSignKycPageTextInput = z.strictObject({
  page: z.number().int().min(1).max(SIGN_MAX_PAGES),
  text: z.string().max(250_000),
});

export const zSignKycRunDeterministicInput = z.strictObject({
  envelopeId: zId,
  fieldId: zId,
  expectedEntityName: z.string().trim().max(300).nullable().optional(),
  expectedTaxCode: z.string().trim().max(32).nullable().optional(),
  expectedSignerName: z.string().trim().max(200).nullable().optional(),
  attachmentPages: z.array(zSignKycPageTextInput).max(SIGN_MAX_PAGES).optional(),
  idempotencyKey: zId.optional(),
});
export type SignKycRunDeterministicInput = z.infer<typeof zSignKycRunDeterministicInput>;

export const zSignKycAnalyzeInput = z.strictObject({
  envelopeId: zId,
  fieldId: zId,
  expectedEntityName: z.string().trim().max(300).nullable().optional(),
  expectedTaxCode: z.string().trim().max(32).nullable().optional(),
  expectedSignerName: z.string().trim().max(200).nullable().optional(),
  attachmentPages: z.array(zSignKycPageTextInput).max(SIGN_MAX_PAGES).optional(),
});
export type SignKycAnalyzeInput = z.infer<typeof zSignKycAnalyzeInput>;

export const zSignKycAnalyzeResult = z.strictObject({
  ai: zSignKycAiOutcome,
  status: z.enum([
    'needs_review',
    'matched',
    'mismatch',
    'pending',
    'off',
    'budget',
    'busy',
    'not_ready',
    'no_text',
    'empty',
    'failed',
  ]),
  check: zSignKycCheckRecord.nullable(),
});
export type SignKycAnalyzeResult = z.infer<typeof zSignKycAnalyzeResult>;

export const zSignKycConfirmInput = z.strictObject({
  envelopeId: zId,
  fieldId: zId,
  status: z.enum(['matched', 'mismatch', 'needs_review']),
  manualNote: z.string().trim().max(1000).nullable().optional(),
  expectedEntityName: z.string().trim().max(300).nullable().optional(),
  expectedTaxCode: z.string().trim().max(32).nullable().optional(),
  expectedSignerName: z.string().trim().max(200).nullable().optional(),
  idempotencyKey: zId.optional(),
});
export type SignKycConfirmInput = z.infer<typeof zSignKycConfirmInput>;

// ---------------------------------------------------------------------------
// Slice 5c (#4441): Read-only MCP inputs, scoped org API keys, and /api/v1/sign/*
// ---------------------------------------------------------------------------

export const SIGN_API_KEY_SCOPES = ['sign:read', 'sign:draft'] as const;
export const zSignApiKeyScope = z.enum(SIGN_API_KEY_SCOPES);
export type SignApiKeyScope = z.infer<typeof zSignApiKeyScope>;

export const zSignApiKeyRecord = z.strictObject({
  id: zId,
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(zSignApiKeyScope),
  createdBy: zId.nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SignApiKeyRecord = z.infer<typeof zSignApiKeyRecord>;

export const zSignApiKeyListInput = z.strictObject({});
export type SignApiKeyListInput = z.infer<typeof zSignApiKeyListInput>;

export const zSignApiKeyListResult = z.strictObject({
  items: z.array(zSignApiKeyRecord),
});
export type SignApiKeyListResult = z.infer<typeof zSignApiKeyListResult>;

const hasNoNul = (value: string): boolean => !value.includes('\u0000');

export const zSignApiKeyCreateInput = z.strictObject({
  name: z.string().trim().min(1).max(120).refine(hasNoNul, 'NUL characters are not permitted'),
  scopes: z.array(zSignApiKeyScope).min(1).max(2),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type SignApiKeyCreateInput = z.infer<typeof zSignApiKeyCreateInput>;

export const zSignApiKeyCreateResult = z.strictObject({
  apiKey: zSignApiKeyRecord,
  secret: z.string(),
});
export type SignApiKeyCreateResult = z.infer<typeof zSignApiKeyCreateResult>;

export const zSignApiKeyRevokeInput = z.strictObject({
  apiKeyId: zId,
  idempotencyKey: zId.optional(),
});
export type SignApiKeyRevokeInput = z.infer<typeof zSignApiKeyRevokeInput>;

export const zMcpSignEnvelopesInput = z.strictObject({
  status: zSignEnvelopeStatus.optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export type McpSignEnvelopesInput = z.infer<typeof zMcpSignEnvelopesInput>;

export const zMcpSignEnvelopeGetInput = z.strictObject({
  envelopeId: zId,
});
export type McpSignEnvelopeGetInput = z.infer<typeof zMcpSignEnvelopeGetInput>;

export const zMcpSignRenewalsInput = z.strictObject({
  withinDays: z.number().int().min(1).max(365).default(90),
  limit: z.number().int().min(1).max(50).default(25),
});
export type McpSignRenewalsInput = z.infer<typeof zMcpSignRenewalsInput>;

export const zMcpSignTemplatesInput = z.strictObject({
  limit: z.number().int().min(1).max(50).default(25),
});
export type McpSignTemplatesInput = z.infer<typeof zMcpSignTemplatesInput>;

export const zSignApiV1FromTemplateInput = z
  .strictObject({
    templateId: zId,
    title: z.string().trim().min(1).max(300).refine(hasNoNul, 'NUL characters are not permitted').optional(),
    subject: z
      .string()
      .trim()
      .max(300)
      .refine(hasNoNul, 'NUL characters are not permitted')
      .nullable()
      .optional(),
    message: z
      .string()
      .trim()
      .max(5000)
      .refine(hasNoNul, 'NUL characters are not permitted')
      .nullable()
      .optional(),
    allowDelegation: z.boolean().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    recipients: z
      .array(
        zSignTemplateRecipientInput.refine(
          (r) =>
            hasNoNul(r.roleKey) &&
            hasNoNul(r.name) &&
            (r.email === undefined || r.email === null || hasNoNul(r.email)) &&
            (r.phone === undefined || r.phone === null || hasNoNul(r.phone)),
          'NUL characters are not permitted',
        ),
      )
      .max(SIGN_MAX_SIGNERS),
    textDefaults: z
      .record(
        z.string().min(1).max(160).refine(hasNoNul, 'NUL characters are not permitted'),
        z.string().max(2000).refine(hasNoNul, 'NUL characters are not permitted'),
      )
      .optional(),
  });
export type SignApiV1FromTemplateInput = z.infer<typeof zSignApiV1FromTemplateInput>;

// Slice 6c (#4722): Multi-document packet manipulation and Vy cross-document consistency checks.
export const zSignEnvelopeDocumentAddInput = z.strictObject({
  envelopeId: zId,
  sourceFileId: zId,
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine(hasNoNul, 'NUL characters are not permitted')
    .optional(),
  sourceDocxSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN).optional(),
  idempotencyKey: zId.optional(),
});
export type SignEnvelopeDocumentAddInput = z.infer<typeof zSignEnvelopeDocumentAddInput>;

export const zSignEnvelopeDocumentAddResult = z.strictObject({
  envelopeId: zId,
  documentId: zId,
  docIndex: z.number().int().min(1).max(SIGN_MAX_PACKET_DOCS),
  version: z.number().int(),
});
export type SignEnvelopeDocumentAddResult = z.infer<typeof zSignEnvelopeDocumentAddResult>;

export const zSignEnvelopeDocumentRemoveInput = z.strictObject({
  envelopeId: zId,
  documentId: zId,
  idempotencyKey: zId.optional(),
});
export type SignEnvelopeDocumentRemoveInput = z.infer<typeof zSignEnvelopeDocumentRemoveInput>;

export const zSignEnvelopeDocumentRemoveResult = z.strictObject({
  envelopeId: zId,
  removedDocumentId: zId,
  version: z.number().int(),
});
export type SignEnvelopeDocumentRemoveResult = z.infer<typeof zSignEnvelopeDocumentRemoveResult>;

export const zSignEnvelopeDocumentReorderInput = z.strictObject({
  envelopeId: zId,
  documentIds: z.array(zId).min(1).max(SIGN_MAX_PACKET_DOCS),
  idempotencyKey: zId.optional(),
});
export type SignEnvelopeDocumentReorderInput = z.infer<typeof zSignEnvelopeDocumentReorderInput>;

export const zSignEnvelopeDocumentReorderResult = z.strictObject({
  envelopeId: zId,
  documentIds: z.array(zId).min(1).max(SIGN_MAX_PACKET_DOCS),
  version: z.number().int(),
});
export type SignEnvelopeDocumentReorderResult = z.infer<typeof zSignEnvelopeDocumentReorderResult>;

export const SIGN_PACKET_CONSISTENCY_SEVERITIES = ['info', 'warn', 'critical'] as const;
export const zSignPacketConsistencySeverity = z.enum(SIGN_PACKET_CONSISTENCY_SEVERITIES);
export type SignPacketConsistencySeverity = z.infer<typeof zSignPacketConsistencySeverity>;

export const SIGN_PACKET_CONSISTENCY_KINDS = [
  'mismatched_total',
  'mismatched_date',
  'mismatched_party',
  'missing_signature_field',
  'annex_gap',
  'other',
] as const;
export const zSignPacketConsistencyKind = z.enum(SIGN_PACKET_CONSISTENCY_KINDS);
export type SignPacketConsistencyKind = z.infer<typeof zSignPacketConsistencyKind>;

export const zSignPacketConsistencyFinding = z.strictObject({
  kind: zSignPacketConsistencyKind,
  severity: zSignPacketConsistencySeverity,
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(800),
  documentId: zId.nullable(),
  documentTitle: z.string().min(1).max(300),
  pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES).nullable(),
  quoteExcerpt: z.string().max(1000).nullable(),
  source: z.enum(['deterministic', 'ai']),
  tainted: z.boolean(),
});
export type SignPacketConsistencyFinding = z.infer<typeof zSignPacketConsistencyFinding>;

export const zSignPacketConsistencyDocumentPagesInput = z.strictObject({
  documentId: zId.nullable().optional(),
  pages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(SIGN_MAX_PAGES), text: z.string().max(250_000) }))
    .max(SIGN_MAX_PAGES),
});

export const zSignPacketConsistencyCheckInput = z.strictObject({
  envelopeId: zId,
  documents: z.array(zSignPacketConsistencyDocumentPagesInput).min(1).max(SIGN_MAX_PACKET_DOCS).optional(),
});
export type SignPacketConsistencyCheckInput = z.infer<typeof zSignPacketConsistencyCheckInput>;

export const zSignPacketConsistencyCheckResult = z.strictObject({
  envelopeId: zId,
  ai: z.enum(['used', 'off', 'budget', 'busy', 'not_ready', 'no_text', 'failed']),
  findings: z.array(zSignPacketConsistencyFinding),
  summaryText: z.string().nullable(),
});
export type SignPacketConsistencyCheckResult = z.infer<typeof zSignPacketConsistencyCheckResult>;
