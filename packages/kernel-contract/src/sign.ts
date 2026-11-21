// SPDX-License-Identifier: AGPL-3.0-only
// Public signing link contracts for Crove eSign Slice 1b (#3324, docs/plan/esign.md).
// Screens belong in screens.ts (owned separately by #3325); keep only public route paths,
// token patterns, PNG/input bounds, and request/response schemas here.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const SIGN_PAGE_PATH = '/-/sign';
export const SIGN_DIRECT_PAGE_PATH = '/-/sign/d';
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
export const SIGN_DECLINE_REASON_MAX = 1000;
export const SIGN_SIGNATURE_TYPED_TEXT_MAX = 200;
export const SIGN_PUBLIC_FIELDS_MAX = 500;

export const zSignToken = z.string().regex(SIGN_TOKEN_PATTERN, 'Invalid signing token');
export const zSignTemplateRoleKey = z.string().regex(SIGN_TEMPLATE_ROLE_KEY_PATTERN, 'Invalid template role key');

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

// Authenticated eSign RPC contracts (Slice 1a/1c: docs/plan/esign.md, #3325).
export const SIGN_MAX_PAGES = 200;
export const SIGN_MAX_SIGNERS = 50;
export const SIGN_MAX_FIELDS = 500;
export const SIGN_MAX_DETECTED_TAGS = 200;
export const SIGN_MAX_TAG_ROLES = 50;
export const SIGN_NORM_SCALE = 1_000_000;

export const SIGN_ENVELOPE_STATUSES = ['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired'] as const;
export const SIGN_ROUTING_MODES = ['parallel', 'sequential'] as const;
export const SIGN_SOURCE_KINDS = ['standalone', 'crm_quote', 'crm_order', 'hr_contract', 'project_acceptance'] as const;
export const SIGN_INSPECT_STATUSES = ['pending', 'passed', 'failed'] as const;
export const SIGN_SEAL_STATUSES = ['pending', 'sealed', 'failed'] as const;
export const SIGN_SIGNER_ROLES = ['signer', 'approver', 'cc'] as const;
export const SIGN_DELIVERY_MODES = ['link', 'email'] as const;
export const SIGN_SIGNER_STATUSES = ['waiting', 'pending', 'viewed', 'signed', 'declined', 'voided', 'expired'] as const;
export const SIGN_SIGNATURE_KINDS = ['draw', 'type'] as const;
export const SIGN_FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'] as const;
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
    xNorm: z.number().finite().min(0).lt(1),
    yNorm: z.number().finite().min(0).lt(1),
    wNorm: z.number().finite().gt(0).lte(1),
    hNorm: z.number().finite().gt(0).lte(1),
  })
  .superRefine((item, ctx) => {
    if (item.roleKey !== `r${item.roleOrder}`) {
      ctx.addIssue({ code: 'custom', path: ['roleKey'], message: 'roleKey must match roleOrder' });
    }
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

export const zSignEnvelopeDetail = z.strictObject({
  envelope: z.strictObject({
    id: zId,
    title: z.string(),
    subject: z.string().nullable(),
    message: z.string().nullable(),
    status: zSignEnvelopeStatus,
    routingMode: zSignRoutingMode,
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
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  fields: z.array(
    z.strictObject({
      id: zId,
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
      valueText: z.string().nullable(),
      valueChecked: z.boolean().nullable(),
      filledAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

export const zSignEnvelopeEventsResult = z.strictObject({
  envelopeId: zId,
  events: z.array(
    z.strictObject({
      id: zId,
      signerId: zId.nullable(),
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
  sourceKind: zSignSourceKind.default('standalone'),
  sourceId: zId.nullable().optional(),
  sourceFileId: zId,
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

export const zSignFieldItemInput = z
  .strictObject({
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
  })
  .superRefine((item, ctx) => {
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
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  usesCount: z.number().int().min(0).optional(),
  expiresAt: z.string().nullable().optional(),
  lastRotatedAt: z.string().nullable(),
});

export const zSignTemplateDirectLinkDetail = z.strictObject({
  id: zId,
  enabled: z.boolean(),
  requireEmailOtp: z.boolean(),
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
    subject: z.string().trim().max(300).nullable().optional(),
    message: z.string().trim().max(5000).nullable().optional(),
    expiresInHours: z.number().int().min(1).max(8760).nullable().optional(),
    sourceFileId: zId.optional(),
    sourceEnvelopeId: zId.optional(),
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

export const zSignTemplateUpdateInput = z.strictObject({
  templateId: zId,
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  routingMode: zSignRoutingMode.optional(),
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
  })
  .superRefine((item, ctx) => {
    if (!item.templateRoleId && !item.roleKey) {
      ctx.addIssue({ code: 'custom', path: ['templateRoleId'], message: 'Either templateRoleId or roleKey is required' });
    }
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
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const zSignTemplateDirectLinkRotateInput = z.strictObject({
  templateId: zId,
  requireEmailOtp: z.boolean().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const zSignTemplateDirectLinkResult = z.strictObject({
  templateId: zId,
  enabled: z.boolean(),
  requireEmailOtp: z.boolean(),
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
