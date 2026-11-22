// SPDX-License-Identifier: AGPL-3.0-only
// Orgless HTTP edge helpers for public eSign Slice 1b links (#3324, docs/plan/esign.md).
// Reads tokens strictly from JSON POST bodies, checks org_app_on + billing entitlements inside orgless
// SECURITY DEFINER resolution (returning an identical opaque 404 across invalid/expired/waiting/MODULE_OFF),
// and enforces per-IP + per-token-hash rate limits plus bounded PDF read concurrency without CAPTCHA (#203).
import { sql } from 'kysely';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import { DEFAULT_MESSAGE_ID_DOMAIN } from '@ludy/kernel';
import {
  zSignPublicDeclineInput,
  zSignPublicDelegateInput,
  zSignPublicOtpRequestInput,
  zSignPublicOtpVerifyInput,
  zSignPublicPdfInput,
  zSignPublicSubmitInput,
  zSignPublicVerifyInput,
  zSignPublicViewInput,
  zSignToken,
  type SignAttachmentContentType,
  type SignPublicAttachmentUploadResult,
  type SignPublicDeclineResult,
  type SignPublicDelegateResult,
  type SignPublicOtpRequestResult,
  type SignPublicOtpVerifyResult,
  type SignPublicSubmitResult,
  type SignPublicVerifyResult,
  type SignPublicView,
} from '@ludy/kernel-contract';
import { DomainError, entitledTo, fileKey, putFile, readVerified, sha256Hex, type BlobStore, type ErrorStatus, type Runtime } from '@ludy/kernel-runtime';
import {
  normalizeSignPageDimensions,
  parseSharedSummary,
  sanitizeSignUserAgent,
  validateSignaturePngBase64,
} from '@ludy/mod-sign';
import { imageSize } from './media-probe.ts';
import { safeFilename, sniffType } from './sniff.ts';

export const SIGN_VIEWS_PER_MINUTE = 60;
export const SIGN_TOKEN_VIEWS_PER_MINUTE = 30;
export const SIGN_PDFS_PER_MINUTE = 30;
export const SIGN_TOKEN_PDFS_PER_MINUTE = 20;
export const SIGN_PDF_READS_MAX = 8;
export const SIGN_OTP_REQUESTS_PER_MINUTE = 10;
export const SIGN_TOKEN_OTP_REQUESTS_PER_MINUTE = 3;
export const SIGN_OTP_VERIFIES_PER_MINUTE = 20;
export const SIGN_TOKEN_OTP_VERIFIES_PER_MINUTE = 10;
export const SIGN_SUBMITS_PER_MINUTE = 20;
export const SIGN_TOKEN_SUBMITS_PER_MINUTE = 10;
export const SIGN_DELEGATES_PER_MINUTE = 10;
export const SIGN_TOKEN_DELEGATES_PER_MINUTE = 5;
export const SIGN_ATTACHMENTS_PER_MINUTE = 15;
export const SIGN_TOKEN_ATTACHMENTS_PER_MINUTE = 10;
export const SIGN_ATTACHMENT_UPLOADS_MAX = 4;
export const SIGN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SIGN_VERIFY_PER_MINUTE = 30;
export const SIGN_PDF_MAX_BYTES = EXTRACT_LIMITS.maxFileBytes;

const SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SqlErrorPayload {
  status: 'error';
  code?: string;
  httpStatus?: number;
  message?: string;
}

function toErrorStatus(status: number | undefined): ErrorStatus {
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 422 ||
    status === 429 ||
    status === 500 ||
    status === 503
  ) {
    return status;
  }
  return 422;
}

function throwSqlDomainError(row: SqlErrorPayload): never {
  const status = toErrorStatus(row.httpStatus);
  const message = row.message ?? 'Request rejected';
  switch (row.code) {
    case 'FILE_SOURCE_CONFLICT':
      throw new DomainError('FILE_SOURCE_CONFLICT', status, message);
    case 'SIGN_ATTACHMENT_RATE_LIMITED':
      throw new DomainError('SIGN_ATTACHMENT_RATE_LIMITED', status, message);
    case 'SIGN_ATTACHMENT_REQUIRED':
      throw new DomainError('SIGN_ATTACHMENT_REQUIRED', status, message);
    case 'SIGN_CONSENT_REQUIRED':
      throw new DomainError('SIGN_CONSENT_REQUIRED', status, message);
    case 'SIGN_DUPLICATE_FIELD':
      throw new DomainError('SIGN_DUPLICATE_FIELD', status, message);
    case 'SIGN_EMAIL_SUPPRESSED':
      throw new DomainError('SIGN_EMAIL_SUPPRESSED', status, message);
    case 'SIGN_FIELD_REQUIRED':
      throw new DomainError('SIGN_FIELD_REQUIRED', status, message);
    case 'SIGN_INVALID_FIELD':
      throw new DomainError('SIGN_INVALID_FIELD', status, message);
    case 'SIGN_INVALID_FIELD_OPTION':
      throw new DomainError('SIGN_INVALID_FIELD_OPTION', status, message);
    case 'SIGN_INVALID_SIGNATURE_PNG':
      throw new DomainError('SIGN_INVALID_SIGNATURE_PNG', status, message);
    case 'SIGN_OTP_NOT_REQUIRED':
      throw new DomainError('SIGN_OTP_NOT_REQUIRED', status, message);
    case 'SIGN_OTP_RATE_LIMITED':
      throw new DomainError('SIGN_OTP_RATE_LIMITED', status, message);
    case 'SIGN_OTP_REQUIRED':
      throw new DomainError('SIGN_OTP_REQUIRED', status, message);
    case 'SIGN_DELEGATION_DISABLED':
      throw new DomainError('SIGN_DELEGATION_DISABLED', status, message);
    case 'SIGN_DELEGATION_LIMIT_REACHED':
      throw new DomainError('SIGN_DELEGATION_LIMIT_REACHED', status, message);
    case 'SIGN_DELEGATE_SAME_EMAIL':
      throw new DomainError('SIGN_DELEGATE_SAME_EMAIL', status, message);
    default:
      throw new DomainError(row.code ?? 'VALIDATION', status, message);
  }
}

export interface SignBilling {
  entitlements(orgId: string): Promise<readonly string[]>;
}

export interface SignTokenLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type SignTokenLimiterFn = (tokenHash: string) => SignTokenLimitDecision;

export interface SignResolvedToken {
  orgId: string;
  orgName: string;
  tokenId: string;
  envelopeId: string;
  signerId: string;
  tokenUsed: boolean;
  tokenExpiresAt: string;
  inPerson?: boolean;
  inPersonHostUserId?: string | null;
  envelopeStatus: string;
  signerStatus: string;
  signerRole: string;
  routingMode: string;
  routingOrder: number;
  requireEmailOtp: boolean;
  otpVerifiedAt: string | null;
  allowDelegation?: boolean;
  delegationCount?: number;
  delegatedFromName?: string | null;
  title: string;
  message: string | null;
  roleLabel: string;
  signerName: string;
  hasEmail: boolean;
  pageCount: number | null;
  pageDimensions: unknown;
  sourceSha256: string;
}

export interface SignPdfSource {
  storageKey: string;
  generation: string;
  sha256: string;
}

export interface SignRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

// Two-stage IP keying: Node hashes with a domain prefix so raw client IPs never appear in SQL queries or logs, then
// crove_sign.public_keyed_ip_hash(org_id, p_ip_hash) applies HMAC-SHA256 under crove_kernel.mail_hash_key scoped to org_id.
export function signIpHash(ip: string | null): string | null {
  const trimmed = ip?.trim() ?? '';
  if (!trimmed) return null;
  return sha256Hex(`crove:sign:ip:v1:${trimmed}`);
}

function tokenHashOf(rawToken: string): string {
  return sha256Hex(rawToken);
}

async function isEntitled(billing: SignBilling, orgId: string): Promise<boolean> {
  const entitlements = await billing.entitlements(orgId);
  return entitledTo(entitlements, 'sign');
}

export async function resolvePublicToken(
  runtime: Runtime,
  billing: SignBilling,
  tokenHash: string,
  allowUsed = false,
): Promise<SignResolvedToken | null> {
  const resolved = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ resolved: SignResolvedToken | null }>`
      SELECT crove_sign.public_token_resolve(${tokenHash}, ${allowUsed}) AS resolved
    `.execute(db);
    return rows[0]?.resolved ?? null;
  });
  if (!resolved) return null;
  if (!(await isEntitled(billing, resolved.orgId))) return null;
  return resolved;
}

export type SignPdfLookup =
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'otp_required' }
  | { status: 'ok'; source: SignPdfSource };

export async function resolvePublicPdf(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<SignPdfLookup> {
  const parsed = zSignPublicPdfInput.safeParse(body);
  if (!parsed.success) return { status: 'not_found' };
  const tokenHash = tokenHashOf(parsed.data.token);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{
      source: {
        orgId: string;
        otpRequired: boolean;
        storageKey?: string;
        generation?: string;
        sha256?: string;
      } | null;
    }>`
      SELECT crove_sign.public_pdf_source(${tokenHash}) AS source
    `.execute(db);
    return rows[0]?.source ?? null;
  });
  if (!row) return { status: 'not_found' };
  if (!(await isEntitled(billing, row.orgId))) return { status: 'not_found' };
  if (row.otpRequired) return { status: 'otp_required' };
  if (!row.storageKey || !row.generation || !row.sha256) return { status: 'not_found' };
  return {
    status: 'ok',
    source: {
      storageKey: row.storageKey,
      generation: row.generation,
      sha256: row.sha256,
    },
  };
}

export async function readPublicPdfBytes(store: BlobStore, source: SignPdfSource): Promise<Uint8Array> {
  return readVerified(
    store,
    {
      key: source.storageKey,
      generation: source.generation,
      sha256: source.sha256,
    },
    SIGN_PDF_MAX_BYTES,
  );
}

export async function runSignView(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; view: SignPublicView }
> {
  const parsed = zSignPublicViewInput.safeParse(body);
  if (!parsed.success) return { status: 'not_found' };
  const tokenHash = tokenHashOf(parsed.data.token);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, false);
  if (!resolved) return { status: 'not_found' };
  const view = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ view: SignPublicView | null }>`
      SELECT crove_sign.public_record_view(
        ${tokenHash},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS view
    `.execute(db);
    return rows[0]?.view ?? null;
  });
  if (!view) return { status: 'not_found' };
  const inPerson = Boolean(view.inPerson || resolved.inPerson);
  if (view.state === 'ready') {
    const sharedSummary = parseSharedSummary(view.sharedSummary ?? null, view.pageCount);
    return {
      status: 'ok',
      view: {
        ...view,
        signerRole: view.signerRole === 'approver' || resolved.signerRole === 'approver' ? 'approver' : 'signer',
        pageDimensions: normalizeSignPageDimensions(view.pageDimensions),
        sharedSummary,
        ...(inPerson ? { inPerson: true } : {}),
      },
    };
  }
  return {
    status: 'ok',
    view: {
      state: 'otp_required',
      orgName: view.orgName,
      title: view.title,
      maskedEmail: view.maskedEmail,
      ...(inPerson ? { inPerson: true } : {}),
    },
  };
}

export async function runSignOtpRequest(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; result: SignPublicOtpRequestResult }
> {
  const parsed = zSignPublicOtpRequestInput.safeParse(body);
  if (!parsed.success) return { status: 'not_found' };
  const tokenHash = tokenHashOf(parsed.data.token);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, false);
  if (!resolved) return { status: 'not_found' };
  type SqlOtpRequestRow =
    | ({ status: 'ok' } & SignPublicOtpRequestResult)
    | SqlErrorPayload
    | null;
  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpRequestRow }>`
      SELECT crove_sign.public_request_otp(${tokenHash}, ${DEFAULT_MESSAGE_ID_DOMAIN}) AS result
    `.execute(db);
    return rows[0]?.result ?? null;
  });
  if (!res) return { status: 'not_found' };
  if (res.status === 'error') throwSqlDomainError(res);
  return {
    status: 'ok',
    result: {
      sent: res.sent,
      expiresInMinutes: res.expiresInMinutes,
      maskedEmail: res.maskedEmail,
    },
  };
}

export async function runSignOtpVerify(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'result'; result: SignPublicOtpVerifyResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = tokenHashOf(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, false);
  if (!resolved) return { status: 'not_found' };

  const parsed = zSignPublicOtpVerifyInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid verification code' };
  }

  type SqlOtpVerifyRow =
    | SignPublicOtpVerifyResult
    | { status: 'validation_error'; message: string }
    | null;
  const result = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpVerifyRow }>`
      SELECT crove_sign.public_verify_otp(
        ${tokenHash},
        ${parsed.data.code},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? null;
  });
  if (!result) return { status: 'not_found' };
  if ('status' in result && result.status === 'validation_error') {
    return { status: 'validation_error', message: result.message };
  }
  return { status: 'result', result: result as SignPublicOtpVerifyResult };
}

export async function runSignSubmit(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'already_used' }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: SignPublicSubmitResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = tokenHashOf(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, true);
  if (!resolved) return { status: 'not_found' };
  if (resolved.tokenUsed) return { status: 'already_used' };

  const parsed = zSignPublicSubmitInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid submission payload' };
  }
  if (
    parsed.data.signatureTypedText?.includes('\u0000') ||
    parsed.data.fields.some((field) => field.valueText?.includes('\u0000'))
  ) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  const cleanFields = parsed.data.fields.map((field) => {
    if (field.signaturePngBase64 === undefined) return field;
    const validated = validateSignaturePngBase64(field.signaturePngBase64);
    return { ...field, signaturePngBase64: validated.base64 };
  });

  type SqlSubmitRow =
    | { status: 'not_found' }
    | { status: 'already_used' }
    | SqlErrorPayload
    | ({ status: 'ok' } & SignPublicSubmitResult);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlSubmitRow }>`
      SELECT crove_sign.public_submit(
        ${tokenHash},
        ${parsed.data.consentAccepted},
        ${parsed.data.signatureKind ?? null},
        ${parsed.data.signatureTypedText ?? null},
        ${JSON.stringify(cleanFields)}::jsonb,
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)},
        ${DEFAULT_MESSAGE_ID_DOMAIN}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'already_used') return { status: 'already_used' };
  if (res.status === 'error') throwSqlDomainError(res);

  return {
    status: 'ok',
    result: {
      signerId: res.signerId,
      signerStatus: res.signerStatus,
      envelopeStatus: res.envelopeStatus,
      completed: res.completed,
      signedAt: res.signedAt,
      ...(res.inPerson || resolved.inPerson ? { inPerson: true } : {}),
    },
  };
}

export async function runSignDecline(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'already_used' }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: SignPublicDeclineResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = tokenHashOf(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, true);
  if (!resolved) return { status: 'not_found' };
  if (resolved.tokenUsed) return { status: 'already_used' };

  const parsed = zSignPublicDeclineInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid decline payload' };
  }
  if (parsed.data.reason?.includes('\u0000')) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  type SqlDeclineRow =
    | { status: 'not_found' }
    | { status: 'already_used' }
    | SqlErrorPayload
    | ({ status: 'ok' } & SignPublicDeclineResult);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlDeclineRow }>`
      SELECT crove_sign.public_decline(
        ${tokenHash},
        ${parsed.data.reason ?? null},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'already_used') return { status: 'already_used' };
  if (res.status === 'error') throwSqlDomainError(res);

  return {
    status: 'ok',
    result: {
      signerId: res.signerId,
      signerStatus: res.signerStatus,
      envelopeStatus: res.envelopeStatus,
      declinedAt: res.declinedAt,
    },
  };
}

export async function runSignDelegate(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'already_used' }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: SignPublicDelegateResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = tokenHashOf(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, true);
  if (!resolved) return { status: 'not_found' };
  if (resolved.tokenUsed) return { status: 'already_used' };
  if (resolved.inPerson) {
    throw new DomainError(
      'SIGN_DELEGATION_DISABLED',
      403,
      'Signer delegation is disabled for in-person signing sessions',
    );
  }

  const parsed = zSignPublicDelegateInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid delegation payload' };
  }
  if (
    parsed.data.delegateName.includes('\u0000') ||
    parsed.data.delegateEmail.includes('\u0000') ||
    parsed.data.reason.includes('\u0000')
  ) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  type SqlDelegateRow =
    | { status: 'not_found' }
    | { status: 'already_used' }
    | SqlErrorPayload
    | ({ status: 'ok' } & SignPublicDelegateResult);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlDelegateRow }>`
      SELECT crove_sign.public_delegate(
        ${tokenHash},
        ${parsed.data.delegateName},
        ${parsed.data.delegateEmail},
        ${parsed.data.reason},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)},
        ${DEFAULT_MESSAGE_ID_DOMAIN}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'already_used') return { status: 'already_used' };
  if (res.status === 'error') throwSqlDomainError(res);

  return {
    status: 'ok',
    result: {
      signerId: res.signerId,
      delegateName: res.delegateName,
      maskedDelegateEmail: res.maskedDelegateEmail,
      delegationCount: res.delegationCount,
      delegatedAt: res.delegatedAt,
    },
  };
}

export async function runSignVerify(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
): Promise<SignPublicVerifyResult | null> {
  const parsed = zSignPublicVerifyInput.safeParse(body);
  if (!parsed.success) return null;
  const verified = await runtime.orgless(async (db) => {
    const { rows } = await sql<{
      verified: {
        orgId: string;
        matched: true;
        envelopeStatus: 'completed';
        completedAt: string;
        signerCount: number;
        sealedSha256: string;
      } | null;
    }>`
      SELECT crove_sign.public_verify_certificate(${parsed.data.certificateCode}, ${parsed.data.fileSha256}) AS verified
    `.execute(db);
    return rows[0]?.verified ?? null;
  });
  if (!verified) return null;
  if (!(await isEntitled(billing, verified.orgId))) return null;
  return {
    matched: true,
    envelopeStatus: verified.envelopeStatus,
    completedAt: verified.completedAt,
    signerCount: verified.signerCount,
    sealedSha256: verified.sealedSha256,
  };
}

export function verifySignAttachmentBytes(bytes: Uint8Array): SignAttachmentContentType | null {
  if (bytes.byteLength < 1 || bytes.byteLength > SIGN_ATTACHMENT_MAX_BYTES) return null;
  const detected = sniffType(bytes);
  if (detected === 'application/pdf') {
    if (bytes.byteLength < 16) return null;
    if ((bytes[5] !== 0x31 && bytes[5] !== 0x32) || bytes[6] !== 0x2e) return null;
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.byteLength - 2048)));
    if (!tail.includes('%%EOF')) return null;
    return 'application/pdf';
  }
  if (detected === 'image/png') {
    if (bytes.byteLength < 37) return null;
    const size = imageSize(bytes, 'image/png');
    if (!size || size.width > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION || size.height > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION) {
      return null;
    }
    const iendAt = bytes.byteLength - 8;
    if (bytes[iendAt] !== 0x49 || bytes[iendAt + 1] !== 0x45 || bytes[iendAt + 2] !== 0x4e || bytes[iendAt + 3] !== 0x44) {
      return null;
    }
    return 'image/png';
  }
  if (detected === 'image/jpeg') {
    if (bytes.byteLength < 20) return null;
    const size = imageSize(bytes, 'image/jpeg');
    if (!size || size.width > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION || size.height > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION) {
      return null;
    }
    let hasEoi = false;
    for (let i = Math.max(2, bytes.byteLength - 16); i + 1 < bytes.byteLength; i += 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
        hasEoi = true;
        break;
      }
    }
    if (!hasEoi) return null;
    return 'image/jpeg';
  }
  return null;
}

export interface SignAttachmentUploadInput {
  token: unknown;
  fieldId: unknown;
  filename: unknown;
  bytes: Uint8Array | null;
  oversize?: boolean;
  invalidEncoding?: boolean;
}

export async function runSignAttachmentUpload(
  runtime: Runtime,
  store: BlobStore,
  billing: SignBilling,
  input: SignAttachmentUploadInput,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'already_used' }
  | { status: 'ok'; result: SignPublicAttachmentUploadResult }
> {
  const parsedToken = zSignToken.safeParse(input.token);
  if (!parsedToken.success) {
    return { status: 'not_found' };
  }
  const tokenHash = tokenHashOf(parsedToken.data);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }

  const rawFieldId = typeof input.fieldId === 'string' ? input.fieldId.trim() : '';
  const validFieldId = UUID_PATTERN.test(rawFieldId) ? rawFieldId.toLowerCase() : null;

  type SqlPreflightRow =
    | { status: 'already_used'; orgId: string }
    | ({ status: 'error'; orgId: string } & SqlErrorPayload)
    | { status: 'ok'; orgId: string; envelopeId: string; signerId: string; fieldId: string }
    | null;

  const preflight = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlPreflightRow }>`
      SELECT crove_sign.public_attachment_preflight(${tokenHash}, ${validFieldId}::uuid) AS result
    `.execute(db);
    return rows[0]?.result ?? null;
  });

  if (!preflight) return { status: 'not_found' };
  if (!(await isEntitled(billing, preflight.orgId))) return { status: 'not_found' };
  if (preflight.status === 'already_used') return { status: 'already_used' };
  if (preflight.status === 'error') throwSqlDomainError(preflight);

  if (input.oversize) {
    throw new DomainError('TOO_LARGE', 413, 'Supporting attachment exceeds 10 MB');
  }
  if (input.invalidEncoding) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, 'Supporting attachment must be a valid PDF, PNG, or JPEG file');
  }
  if (!input.bytes || input.bytes.byteLength === 0) {
    throw new DomainError('NO_FILE', 400, 'Supporting attachment file is required');
  }
  const verifiedBytes = input.bytes;
  if (verifiedBytes.byteLength > SIGN_ATTACHMENT_MAX_BYTES) {
    throw new DomainError('TOO_LARGE', 413, 'Supporting attachment exceeds 10 MB');
  }
  const contentType = verifySignAttachmentBytes(verifiedBytes);
  if (!contentType) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, 'Supporting attachment must be a valid PDF, PNG, or JPEG file');
  }

  const rawFilename = typeof input.filename === 'string' && input.filename.trim() ? input.filename.trim() : 'attachment';
  if (rawFilename.includes('\u0000')) {
    throw new DomainError('VALIDATION', 422, 'NUL is not allowed');
  }
  const filename = safeFilename(rawFilename, contentType);
  const sha256 = sha256Hex(verifiedBytes);
  const storageKey = fileKey(preflight.orgId, sha256);
  const generation = await putFile(store, storageKey, verifiedBytes, contentType, sha256);

  type SqlRecordAttachmentRow =
    | { status: 'not_found' }
    | { status: 'already_used' }
    | SqlErrorPayload
    | ({ status: 'ok'; orgId: string } & SignPublicAttachmentUploadResult);

  const recorded = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlRecordAttachmentRow }>`
      SELECT crove_sign.public_record_attachment(
        ${tokenHash},
        ${preflight.fieldId}::uuid,
        ${filename},
        ${contentType},
        ${verifiedBytes.byteLength}::integer,
        ${sha256},
        ${storageKey},
        ${generation},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (recorded.status === 'not_found') return { status: 'not_found' };
  if (recorded.status === 'already_used') return { status: 'already_used' };
  if (recorded.status === 'error') throwSqlDomainError(recorded);

  return {
    status: 'ok',
    result: {
      fieldId: recorded.fieldId,
      fileId: recorded.fileId,
      filename: recorded.filename,
      contentType: recorded.contentType,
      sizeBytes: recorded.sizeBytes,
      sha256: recorded.sha256,
      uploadedAt: recorded.uploadedAt,
    },
  };
}
