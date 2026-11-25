// SPDX-License-Identifier: AGPL-3.0-only
// Orgless HTTP edge helpers for public eSign Slice 1b links (#3324, docs/plan/esign.md).
// Reads tokens strictly from JSON POST bodies, checks org_app_on + billing entitlements inside orgless
// SECURITY DEFINER resolution (returning an identical opaque 404 across invalid/expired/waiting/MODULE_OFF),
// and enforces per-IP + per-token-hash rate limits plus bounded PDF read concurrency without CAPTCHA (#203).
import { sql } from 'kysely';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import { DEFAULT_MESSAGE_ID_DOMAIN } from '@ludy/kernel';
import {
  SIGN_DEPOSIT_DUE_DAYS_MAX,
  SIGN_DEPOSIT_MEMO_TOKEN_PATTERN,
  SIGN_DEPOSIT_NOTE_MAX,
  SIGN_DEPOSIT_PROOF_MAX_BYTES,
  SIGN_SIGNATURE_PNG_MAX_BYTES,
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
  type SignDepositProofContentType,
  type SignPublicAttachmentUploadResult,
  type SignPublicDeclineResult,
  type SignPublicDelegateResult,
  type SignPublicDepositNoticeResult,
  type SignPublicDepositSummary,
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
import { hasVideoTrack, imageSize, sniffVideo } from './media-probe.ts';
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
export const SIGN_DEPOSIT_QR_PER_MINUTE = 30;
export const SIGN_TOKEN_DEPOSIT_QR_PER_MINUTE = 20;
export const SIGN_DEPOSIT_NOTICE_PER_MINUTE = 15;
export const SIGN_TOKEN_DEPOSIT_NOTICE_PER_MINUTE = 10;
export const SIGN_DEPOSIT_NOTICE_UPLOADS_MAX = 4;

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
// ludy_sign.public_keyed_ip_hash(org_id, p_ip_hash) applies HMAC-SHA256 under ludy_kernel.mail_hash_key scoped to org_id.
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
      SELECT ludy_sign.public_token_resolve(${tokenHash}, ${allowUsed}) AS resolved
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
      SELECT ludy_sign.public_pdf_source(${tokenHash}, ${parsed.data.documentId ?? null}::uuid) AS source
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
  const resolved = await resolvePublicToken(runtime, billing, tokenHash, true);
  if (!resolved) return { status: 'not_found' };
  const view = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ view: SignPublicView | null }>`
      SELECT ludy_sign.public_record_view(
        ${tokenHash},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS view
    `.execute(db);
    return rows[0]?.view ?? null;
  });
  if (!view) return { status: 'not_found' };
  const inPerson = Boolean(('inPerson' in view && view.inPerson) || resolved.inPerson);
  if (view.state === 'ready') {
    const sharedSummary = parseSharedSummary(view.sharedSummary ?? null, view.pageCount);
    const normalizedDocs = Array.isArray(view.documents)
      ? view.documents.map((doc) => ({
          ...doc,
          pageDimensions: normalizeSignPageDimensions(doc.pageDimensions),
        }))
      : undefined;
    return {
      status: 'ok',
      view: {
        ...view,
        signerRole: view.signerRole === 'approver' || resolved.signerRole === 'approver' ? 'approver' : 'signer',
        pageDimensions: normalizeSignPageDimensions(view.pageDimensions),
        ...(normalizedDocs ? { documents: normalizedDocs } : {}),
        sharedSummary,
        ...(inPerson ? { inPerson: true } : {}),
      },
    };
  }
  if (view.state === 'already_completed') {
    const deposit = parsePublicDepositSummary((view as { deposit?: unknown }).deposit ?? null);
    return {
      status: 'ok',
      view: {
        state: 'already_completed',
        title: view.title,
        status: view.status,
        signerRole: view.signerRole === 'approver' || resolved.signerRole === 'approver' ? 'approver' : 'signer',
        deposit,
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
      SELECT ludy_sign.public_request_otp(${tokenHash}, ${DEFAULT_MESSAGE_ID_DOMAIN}) AS result
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
      SELECT ludy_sign.public_verify_otp(
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
      SELECT ludy_sign.public_submit(
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

  const deposit = parsePublicDepositSummary((res as { deposit?: unknown }).deposit ?? null);

  return {
    status: 'ok',
    result: {
      signerId: res.signerId,
      signerStatus: res.signerStatus,
      envelopeStatus: res.envelopeStatus,
      completed: res.completed,
      signedAt: res.signedAt,
      ...(res.inPerson || resolved.inPerson ? { inPerson: true } : {}),
      ...(deposit ? { deposit } : {}),
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
      SELECT ludy_sign.public_decline(
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
      SELECT ludy_sign.public_delegate(
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
      SELECT ludy_sign.public_verify_certificate(${parsed.data.certificateCode}, ${parsed.data.fileSha256}) AS verified
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

const JPEG_MAX_MARKERS = 10_000;
const JPEG_MAX_ZERO_PADDING = 64;
const JPEG_MAX_MPF_IMAGES = 4;
const JPEG_MAX_IFD_ENTRIES = 64;
const JPEG_MAX_XMP_ITEMS = 16;
const JPEG_MAX_XMP_APP1_SEGMENTS = 4;
const MP4_MAX_TOP_BOXES = 256;
const MOTION_PHOTO_DATA_PREFIX = new TextEncoder().encode('MotionPhoto_Data');
const MPF_APP2_PREFIX = new Uint8Array([0x4d, 0x50, 0x46, 0x00]); // "MPF\0"
const XMP_APP1_PREFIX = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

type XmpItemField = 'Semantic' | 'Mime' | 'Length' | 'Padding';

const XMP_ITEM_FIELD_PATTERNS: Record<XmpItemField, { attr: RegExp; elem: RegExp }> = {
  Semantic: {
    attr: /(?:^|\s)(?:Item|GContainer):Semantic\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    elem: /<(?:Item|GContainer):Semantic>([^<]*)<\/(?:Item|GContainer):Semantic>/,
  },
  Mime: {
    attr: /(?:^|\s)(?:Item|GContainer):Mime\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    elem: /<(?:Item|GContainer):Mime>([^<]*)<\/(?:Item|GContainer):Mime>/,
  },
  Length: {
    attr: /(?:^|\s)(?:Item|GContainer):Length\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    elem: /<(?:Item|GContainer):Length>([^<]*)<\/(?:Item|GContainer):Length>/,
  },
  Padding: {
    attr: /(?:^|\s)(?:Item|GContainer):Padding\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    elem: /<(?:Item|GContainer):Padding>([^<]*)<\/(?:Item|GContainer):Padding>/,
  },
};

interface DeclaredJpegRange {
  start: number;
  end: number;
}

interface XmpGainMapDecl {
  length: number;
  padding: number;
}

interface XmpGContainerInfo {
  primaryPadding: number;
  gainMaps: XmpGainMapDecl[];
}

interface PrimaryJpegInspection {
  eoiEnd: number;
  mpfSecondaryRanges: DeclaredJpegRange[] | null;
  xmpGContainer: XmpGContainerInfo | null;
}

function isAsciiFourcc(bytes: Uint8Array, at: number): boolean {
  for (let i = 0; i < 4; i += 1) {
    const c = bytes[at + i] ?? 0;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function readU16Order(bytes: Uint8Array, at: number, little: boolean): number {
  return little
    ? ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)) >>> 0
    : (((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)) >>> 0;
}

function readU32Be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) >>> 0) +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0)
  );
}

function readU32Order(bytes: Uint8Array, at: number, little: boolean): number {
  if (!little) return readU32Be(bytes, at);
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

function readU64Be(bytes: Uint8Array, at: number): number {
  return readU32Be(bytes, at) * 2 ** 32 + readU32Be(bytes, at + 4);
}

function bytesEqualPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function parseMpfApp2Segment(
  bytes: Uint8Array,
  segStart: number,
  segEnd: number,
): { status: 'none' } | { status: 'invalid' } | { status: 'ok'; secondaryRanges: DeclaredJpegRange[] } {
  if (segEnd - segStart < MPF_APP2_PREFIX.byteLength) return { status: 'none' };
  if (!bytesEqualPrefix(bytes.subarray(segStart, segEnd), MPF_APP2_PREFIX)) return { status: 'none' };

  const tiffStart = segStart + MPF_APP2_PREFIX.byteLength;
  if (tiffStart + 8 > segEnd) return { status: 'invalid' };

  let little: boolean;
  if (
    bytes[tiffStart] === 0x49 &&
    bytes[tiffStart + 1] === 0x49 &&
    bytes[tiffStart + 2] === 0x2a &&
    bytes[tiffStart + 3] === 0x00
  ) {
    little = true;
  } else if (
    bytes[tiffStart] === 0x4d &&
    bytes[tiffStart + 1] === 0x4d &&
    bytes[tiffStart + 2] === 0x00 &&
    bytes[tiffStart + 3] === 0x2a
  ) {
    little = false;
  } else {
    return { status: 'invalid' };
  }

  const firstIfdOffset = readU32Order(bytes, tiffStart + 4, little);
  const ifdAt = tiffStart + firstIfdOffset;
  if (firstIfdOffset < 8 || !Number.isSafeInteger(ifdAt) || ifdAt + 2 > segEnd) {
    return { status: 'invalid' };
  }

  const entryCount = readU16Order(bytes, ifdAt, little);
  if (entryCount < 2 || entryCount > JPEG_MAX_IFD_ENTRIES || ifdAt + 2 + entryCount * 12 > segEnd) {
    return { status: 'invalid' };
  }

  let imageCount: number | null = null;
  let mpEntryByteCount: number | null = null;
  let mpEntryRelOffset: number | null = null;

  for (let i = 0; i < entryCount; i += 1) {
    const entryAt = ifdAt + 2 + i * 12;
    const tag = readU16Order(bytes, entryAt, little);
    const type = readU16Order(bytes, entryAt + 2, little);
    const count = readU32Order(bytes, entryAt + 4, little);

    if (tag === 0xb001) {
      if (imageCount !== null) return { status: 'invalid' };
      if (type !== 4 || count !== 1) return { status: 'invalid' };
      const val = readU32Order(bytes, entryAt + 8, little);
      if (val < 1 || val > JPEG_MAX_MPF_IMAGES) return { status: 'invalid' };
      imageCount = val;
    } else if (tag === 0xb002) {
      if (mpEntryByteCount !== null) return { status: 'invalid' };
      if (type !== 7 || count < 16 || count > JPEG_MAX_MPF_IMAGES * 16) return { status: 'invalid' };
      mpEntryByteCount = count;
      mpEntryRelOffset = readU32Order(bytes, entryAt + 8, little);
    }
  }

  if (
    imageCount === null ||
    mpEntryByteCount === null ||
    mpEntryRelOffset === null ||
    mpEntryByteCount !== imageCount * 16 ||
    mpEntryRelOffset < 8
  ) {
    return { status: 'invalid' };
  }

  const mpStart = tiffStart + mpEntryRelOffset;
  if (!Number.isSafeInteger(mpStart) || mpStart + mpEntryByteCount > segEnd) {
    return { status: 'invalid' };
  }

  const secondaryRanges: DeclaredJpegRange[] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const recAt = mpStart + i * 16;
    const size = readU32Order(bytes, recAt + 4, little);
    const dataOffset = readU32Order(bytes, recAt + 8, little);
    if (dataOffset === 0) {
      if (i !== 0) return { status: 'invalid' };
      continue;
    }
    const start = tiffStart + dataOffset;
    const end = start + size;
    if (size < 20 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { status: 'invalid' };
    }
    secondaryRanges.push({ start, end });
  }

  return { status: 'ok', secondaryRanges };
}

function readXmpItemField(attrs: string, body: string, field: XmpItemField): string | null {
  const { attr, elem } = XMP_ITEM_FIELD_PATTERNS[field];
  const attrMatch = attr.exec(attrs);
  if (attrMatch) return (attrMatch[1] ?? attrMatch[2] ?? '').trim();

  if (!body) return null;
  const elemMatch = elem.exec(body);
  return elemMatch ? (elemMatch[1] ?? '').trim() : null;
}

function parseStrictNonNegativeInt(raw: string, max: number): number | null {
  if (!/^\d{1,9}$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) && num >= 0 && num <= max ? num : null;
}

function parseXmpApp1Segment(
  bytes: Uint8Array,
  segStart: number,
  segEnd: number,
): { status: 'none' } | { status: 'invalid' } | { status: 'ok'; info: XmpGContainerInfo } {
  if (segEnd - segStart < XMP_APP1_PREFIX.byteLength) return { status: 'none' };
  if (!bytesEqualPrefix(bytes.subarray(segStart, segEnd), XMP_APP1_PREFIX)) return { status: 'none' };

  const xml = UTF8_DECODER.decode(bytes.subarray(segStart + XMP_APP1_PREFIX.byteLength, segEnd));
  if (!xml.includes('Container:Item') && !xml.includes('GContainer:Item')) {
    return { status: 'none' };
  }

  let primaryPadding = 0;
  const gainMaps: XmpGainMapDecl[] = [];
  const itemTagRegex = /<(Container|GContainer):Item\b([^<>]*)>/g;
  let itemCount = 0;
  let match: RegExpExecArray | null;

  while ((match = itemTagRegex.exec(xml)) !== null) {
    itemCount += 1;
    if (itemCount > JPEG_MAX_XMP_ITEMS) return { status: 'invalid' };
    const prefix = match[1]!;
    const rawAttrs = match[2] ?? '';
    const isSelfClosing = rawAttrs.endsWith('/');
    const attrs = isSelfClosing ? rawAttrs.slice(0, -1) : rawAttrs;
    let body = '';
    if (!isSelfClosing) {
      const closeTag = `</${prefix}:Item>`;
      const closeIdx = xml.indexOf(closeTag, itemTagRegex.lastIndex);
      if (closeIdx < 0) return { status: 'invalid' };
      body = xml.slice(itemTagRegex.lastIndex, closeIdx);
      itemTagRegex.lastIndex = closeIdx + closeTag.length;
    }

    const semantic = readXmpItemField(attrs, body, 'Semantic');
    const mime = readXmpItemField(attrs, body, 'Mime');
    const lengthRaw = readXmpItemField(attrs, body, 'Length');
    const paddingRaw = readXmpItemField(attrs, body, 'Padding');

    if (semantic === 'Primary') {
      if (mime !== null && mime !== 'image/jpeg') return { status: 'invalid' };
      if (paddingRaw !== null) {
        const pad = parseStrictNonNegativeInt(paddingRaw, JPEG_MAX_ZERO_PADDING);
        if (pad === null) return { status: 'invalid' };
        primaryPadding = pad;
      }
    } else if (semantic === 'GainMap') {
      if (mime !== 'image/jpeg' || lengthRaw === null) return { status: 'invalid' };
      const length = parseStrictNonNegativeInt(lengthRaw, SIGN_ATTACHMENT_MAX_BYTES);
      if (length === null || length < 20) return { status: 'invalid' };
      let padding = 0;
      if (paddingRaw !== null) {
        const pad = parseStrictNonNegativeInt(paddingRaw, JPEG_MAX_ZERO_PADDING);
        if (pad === null) return { status: 'invalid' };
        padding = pad;
      }
      if (gainMaps.length >= JPEG_MAX_MPF_IMAGES - 1) return { status: 'invalid' };
      gainMaps.push({ length, padding });
    }
  }

  if (gainMaps.length === 0) return { status: 'none' };
  return { status: 'ok', info: { primaryPadding, gainMaps } };
}

function inspectJpegStream(bytes: Uint8Array, collectMetadata: boolean): PrimaryJpegInspection | null {
  if (bytes.byteLength < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  let hasSof = false;
  let hasSos = false;
  let xmpApp1Count = 0;
  let mpfSecondaryRanges: DeclaredJpegRange[] | null = null;
  let xmpGContainer: XmpGContainerInfo | null = null;

  for (let seen = 0; seen < JPEG_MAX_MARKERS && at < bytes.byteLength; seen += 1) {
    if (bytes[at] !== 0xff) return null;
    while (at < bytes.byteLength && bytes[at] === 0xff) at += 1;
    if (at >= bytes.byteLength) return null;
    const marker = bytes[at]!;
    at += 1;

    if (marker === 0x00 || marker === 0xd8) return null;
    if (marker === 0xd9) {
      if (!hasSof || !hasSos) return null;
      return { eoiEnd: at, mpfSecondaryRanges, xmpGContainer };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (at + 2 > bytes.byteLength) return null;
    const segLen = ((bytes[at]! << 8) | bytes[at + 1]!) >>> 0;
    if (segLen < 2 || at + segLen > bytes.byteLength) return null;
    const segStart = at + 2;
    const segEnd = at + segLen;
    at = segEnd;

    if (marker === 0xe1 && bytesEqualPrefix(bytes.subarray(segStart, segEnd), XMP_APP1_PREFIX)) {
      xmpApp1Count += 1;
      if (xmpApp1Count > JPEG_MAX_XMP_APP1_SEGMENTS) return null;
    }

    if (collectMetadata) {
      if (marker === 0xe2) {
        const mpf = parseMpfApp2Segment(bytes, segStart, segEnd);
        if (mpf.status === 'invalid') return null;
        if (mpf.status === 'ok') {
          if (mpfSecondaryRanges !== null) return null;
          mpfSecondaryRanges = mpf.secondaryRanges;
        }
      } else if (marker === 0xe1) {
        const xmp = parseXmpApp1Segment(bytes, segStart, segEnd);
        if (xmp.status === 'invalid') return null;
        if (xmp.status === 'ok') {
          if (xmpGContainer !== null) return null;
          xmpGContainer = xmp.info;
        }
      }
    }

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      hasSof = true;
      continue;
    }
    if (marker === 0xda) {
      if (!hasSof) return null;
      hasSos = true;
      let foundNextMarker = false;
      while (at + 1 < bytes.byteLength) {
        if (bytes[at] !== 0xff) {
          at += 1;
          continue;
        }
        const markerPos = at;
        let scanAt = at + 1;
        while (scanAt < bytes.byteLength && bytes[scanAt] === 0xff) scanAt += 1;
        if (scanAt >= bytes.byteLength) return null;
        const nextByte = bytes[scanAt]!;
        // FF 00 is byte-stuffed entropy data; FF D0..D7 are restart markers inside the scan.
        if (nextByte === 0x00 || (nextByte >= 0xd0 && nextByte <= 0xd7)) {
          at = scanAt + 1;
          continue;
        }
        at = markerPos;
        foundNextMarker = true;
        break;
      }
      if (!foundNextMarker) return null;
    }
  }
  return null;
}

function isValidMotionPhotoMp4Trailer(mp4Payload: Uint8Array): boolean {
  const mp4Bytes = bytesEqualPrefix(mp4Payload, MOTION_PHOTO_DATA_PREFIX)
    ? mp4Payload.subarray(MOTION_PHOTO_DATA_PREFIX.byteLength)
    : mp4Payload;
  if (sniffVideo(mp4Bytes) !== 'video/mp4') return false;

  let at = 0;
  let boxIndex = 0;
  let sawMoov = false;
  let sawMdat = false;

  for (; boxIndex < MP4_MAX_TOP_BOXES && at < mp4Bytes.byteLength; boxIndex += 1) {
    if (at + 8 > mp4Bytes.byteLength || !isAsciiFourcc(mp4Bytes, at + 4)) return false;
    let size = readU32Be(mp4Bytes, at);
    const type = String.fromCharCode(mp4Bytes[at + 4]!, mp4Bytes[at + 5]!, mp4Bytes[at + 6]!, mp4Bytes[at + 7]!);
    let header = 8;
    if (size === 1) {
      if (at + 16 > mp4Bytes.byteLength) return false;
      size = readU64Be(mp4Bytes, at + 8);
      header = 16;
    } else if (size === 0) {
      return false;
    }
    if (size < header || at + size > mp4Bytes.byteLength || !Number.isSafeInteger(at + size)) return false;
    if (boxIndex === 0 && type !== 'ftyp') return false;
    if (type === 'moov') sawMoov = true;
    if (type === 'mdat') sawMdat = true;
    at += size;
  }

  return at === mp4Bytes.byteLength && sawMoov && sawMdat && hasVideoTrack(mp4Bytes);
}

function isAllowedJpegTrailer(trailer: Uint8Array): boolean {
  if (trailer.byteLength === 0) return true;
  // Allow up to 64 leading 0x00 padding bytes alone or preceding MotionPhoto_Data / an MP4 ftyp box.
  for (let pad = 0; pad <= JPEG_MAX_ZERO_PADDING && pad <= trailer.byteLength; pad += 1) {
    if (pad === trailer.byteLength) return true;
    const rest = trailer.subarray(pad);
    if (bytesEqualPrefix(rest, MOTION_PHOTO_DATA_PREFIX)) {
      return isValidMotionPhotoMp4Trailer(rest);
    }
    if (rest.byteLength >= 8 && String.fromCharCode(rest[4]!, rest[5]!, rest[6]!, rest[7]!) === 'ftyp') {
      return isValidMotionPhotoMp4Trailer(rest);
    }
    if (trailer[pad] !== 0x00) {
      return false;
    }
  }
  return false;
}

function resolveAndVerifyDeclaredSecondaryJpegs(
  bytes: Uint8Array,
  inspection: PrimaryJpegInspection,
): number | null {
  const mpfRanges = inspection.mpfSecondaryRanges;
  const xmpInfo = inspection.xmpGContainer;
  let ranges: DeclaredJpegRange[] = [];

  if (mpfRanges && mpfRanges.length > 0) {
    ranges = mpfRanges;
    if (xmpInfo && xmpInfo.gainMaps.length > 0) {
      if (mpfRanges.length !== xmpInfo.gainMaps.length) return null;
      for (let i = 0; i < mpfRanges.length; i += 1) {
        if (mpfRanges[i]!.end - mpfRanges[i]!.start !== xmpInfo.gainMaps[i]!.length) return null;
      }
    }
  } else if (xmpInfo && xmpInfo.gainMaps.length > 0) {
    let cursor = inspection.eoiEnd;
    for (let i = 0; i < xmpInfo.gainMaps.length; i += 1) {
      const gm = xmpInfo.gainMaps[i]!;
      let gap = i === 0 ? xmpInfo.primaryPadding : xmpInfo.gainMaps[i - 1]!.padding;
      if (
        i === 0 &&
        gap === 0 &&
        gm.padding > 0 &&
        cursor + gm.padding + 2 <= bytes.byteLength &&
        bytes[cursor] === 0x00 &&
        bytes[cursor + gm.padding] === 0xff &&
        bytes[cursor + gm.padding + 1] === 0xd8
      ) {
        gap = gm.padding;
      }
      const start = cursor + gap;
      const end = start + gm.length;
      if (end > bytes.byteLength) return null;
      ranges.push({ start, end });
      cursor = end;
    }
  }

  let cursor = inspection.eoiEnd;
  for (const range of ranges) {
    const gap = range.start - cursor;
    if (gap < 0 || gap > JPEG_MAX_ZERO_PADDING || range.end > bytes.byteLength) return null;
    for (let z = cursor; z < range.start; z += 1) {
      if (bytes[z] !== 0x00) return null;
    }
    const sec = bytes.subarray(range.start, range.end);
    const secInspection = inspectJpegStream(sec, false);
    if (!secInspection || secInspection.eoiEnd !== sec.byteLength) return null;
    const secSize = imageSize(sec, 'image/jpeg');
    if (
      !secSize ||
      secSize.width > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION ||
      secSize.height > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION
    ) {
      return null;
    }
    cursor = range.end;
  }

  return cursor;
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
    const size = imageSize(bytes, 'image/jpeg');
    if (!size || size.width > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION || size.height > SIGN_ATTACHMENT_MAX_IMAGE_DIMENSION) {
      return null;
    }
    const inspection = inspectJpegStream(bytes, true);
    if (!inspection) return null;
    const trailerStart = resolveAndVerifyDeclaredSecondaryJpegs(bytes, inspection);
    if (trailerStart === null) return null;
    if (!isAllowedJpegTrailer(bytes.subarray(trailerStart))) return null;
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
      SELECT ludy_sign.public_attachment_preflight(${tokenHash}, ${validFieldId}::uuid) AS result
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
      SELECT ludy_sign.public_record_attachment(
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

function parsePublicDepositSummary(raw: unknown): SignPublicDepositSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const amount = typeof obj.amount === 'string' ? obj.amount.trim() : '';
  const memoToken = typeof obj.memoToken === 'string' ? obj.memoToken.trim() : '';
  const bankCode = typeof obj.bankCode === 'string' ? obj.bankCode.trim() : '';
  const bankName = typeof obj.bankName === 'string' ? obj.bankName.trim() : '';
  const accountNumber = typeof obj.accountNumber === 'string' ? obj.accountNumber.trim() : '';
  const accountHolder = typeof obj.accountHolder === 'string' ? obj.accountHolder.trim() : '';
  if (
    !amount ||
    obj.currency !== 'VND' ||
    !SIGN_DEPOSIT_MEMO_TOKEN_PATTERN.test(memoToken) ||
    !bankCode ||
    !bankName ||
    !accountNumber ||
    !accountHolder
  ) {
    return null;
  }
  const dueDays =
    typeof obj.dueDays === 'number' &&
    Number.isInteger(obj.dueDays) &&
    obj.dueDays >= 0 &&
    obj.dueDays <= SIGN_DEPOSIT_DUE_DAYS_MAX
      ? obj.dueDays
      : null;
  return {
    amount,
    currency: 'VND',
    memoToken,
    dueDays,
    note: typeof obj.note === 'string' ? obj.note : null,
    bankCode,
    bankName,
    accountNumber,
    accountHolder,
    hasQrPng: Boolean(obj.hasQrPng),
    emvcoPayload: typeof obj.emvcoPayload === 'string' && obj.emvcoPayload.length > 0 ? obj.emvcoPayload : null,
    signerNoticeAt: typeof obj.signerNoticeAt === 'string' ? obj.signerNoticeAt : null,
    signerNoticeNote: typeof obj.signerNoticeNote === 'string' ? obj.signerNoticeNote : null,
    signerProofFilename: typeof obj.signerProofFilename === 'string' ? obj.signerProofFilename : null,
    signerProofSha256: typeof obj.signerProofSha256 === 'string' ? obj.signerProofSha256 : null,
  };
}

export function verifySignDepositProofBytes(bytes: Uint8Array): SignDepositProofContentType | null {
  if (bytes.byteLength < 1 || bytes.byteLength > SIGN_DEPOSIT_PROOF_MAX_BYTES) {
    return null;
  }
  const detected = verifySignAttachmentBytes(bytes);
  if (detected === 'image/png' || detected === 'image/jpeg') {
    return detected;
  }
  return null;
}

export type SignDepositQrLookup =
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'otp_required' }
  | { status: 'ok'; bytes: Uint8Array };

export async function runSignDepositQr(
  runtime: Runtime,
  store: BlobStore,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<SignDepositQrLookup> {
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
      SELECT ludy_sign.public_deposit_qr_source(${tokenHash}) AS source
    `.execute(db);
    return rows[0]?.source ?? null;
  });

  if (!row) return { status: 'not_found' };
  if (!(await isEntitled(billing, row.orgId))) return { status: 'not_found' };
  if (row.otpRequired) return { status: 'otp_required' };
  if (!row.storageKey || !row.generation || !row.sha256) return { status: 'not_found' };

  const bytes = await readVerified(
    store,
    { key: row.storageKey, generation: row.generation, sha256: row.sha256 },
    SIGN_SIGNATURE_PNG_MAX_BYTES,
  );
  if (
    bytes.byteLength < 45 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return { status: 'not_found' };
  }
  return { status: 'ok', bytes };
}

export interface SignDepositNoticeInput {
  token: unknown;
  note: unknown;
  filename: unknown;
  bytes: Uint8Array | null;
  oversize?: boolean;
  invalidEncoding?: boolean;
  emptyFile?: boolean;
}

export async function runSignDepositNotice(
  runtime: Runtime,
  store: BlobStore,
  billing: SignBilling,
  input: SignDepositNoticeInput,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; result: SignPublicDepositNoticeResult }
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

  type SqlNoticePreflightRow =
    | { status: 'not_found' }
    | { status: 'ok'; orgId: string; otpRequired: boolean };

  const preflight = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlNoticePreflightRow }>`
      SELECT ludy_sign.public_deposit_notice_preflight(${tokenHash}) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (preflight.status === 'not_found') {
    return { status: 'not_found' };
  }
  if (!(await isEntitled(billing, preflight.orgId))) {
    return { status: 'not_found' };
  }
  if (preflight.otpRequired) {
    throw new DomainError('SIGN_OTP_REQUIRED', 403, 'Email OTP verification is required before reporting transfer');
  }

  let cleanNote: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      throw new DomainError('VALIDATION', 422, 'Transfer note must be text');
    }
    if (input.note.includes('\u0000')) {
      throw new DomainError('VALIDATION', 422, 'NUL is not allowed');
    }
    const stripped = input.note.replace(/\p{Cc}+/gu, ' ').trim();
    if (stripped.length > SIGN_DEPOSIT_NOTE_MAX) {
      throw new DomainError('VALIDATION', 422, `Transfer note must not exceed ${SIGN_DEPOSIT_NOTE_MAX} characters`);
    }
    cleanNote = stripped.length > 0 ? stripped : null;
  }

  if (input.oversize) {
    throw new DomainError('TOO_LARGE', 413, 'Deposit transfer proof exceeds 2 MB');
  }
  if (input.invalidEncoding || input.emptyFile) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, 'Deposit transfer proof must be a valid PNG or JPEG image');
  }

  let proofFilename: string | null = null;
  let proofContentType: SignDepositProofContentType | null = null;
  let proofSizeBytes: number | null = null;
  let proofSha256: string | null = null;
  let proofStorageKey: string | null = null;
  let proofGeneration: string | null = null;

  if (input.bytes && input.bytes.byteLength > 0) {
    if (input.bytes.byteLength > SIGN_DEPOSIT_PROOF_MAX_BYTES) {
      throw new DomainError('TOO_LARGE', 413, 'Deposit transfer proof exceeds 2 MB');
    }
    const detected = verifySignDepositProofBytes(input.bytes);
    if (!detected) {
      throw new DomainError('UNSUPPORTED_TYPE', 415, 'Deposit transfer proof must be a valid PNG or JPEG image');
    }
    const rawFilename = typeof input.filename === 'string' && input.filename.trim() ? input.filename.trim() : 'deposit-proof';
    if (rawFilename.includes('\u0000')) {
      throw new DomainError('VALIDATION', 422, 'NUL is not allowed');
    }
    proofFilename = safeFilename(rawFilename, detected);
    proofContentType = detected;
    proofSizeBytes = input.bytes.byteLength;
    proofSha256 = sha256Hex(input.bytes);
    proofStorageKey = fileKey(preflight.orgId, proofSha256);
    proofGeneration = await putFile(store, proofStorageKey, input.bytes, detected, proofSha256);
  }

  type SqlNoticeRow =
    | { status: 'not_found' }
    | SqlErrorPayload
    | { status: 'ok'; orgId: string; deposit: unknown };

  const recorded = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlNoticeRow }>`
      SELECT ludy_sign.public_record_deposit_notice(
        ${tokenHash},
        ${cleanNote},
        ${proofFilename},
        ${proofContentType},
        ${proofSizeBytes},
        ${proofSha256},
        ${proofStorageKey},
        ${proofGeneration},
        ${signIpHash(meta.ip)}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (recorded.status === 'not_found') return { status: 'not_found' };
  if (recorded.status === 'error') throwSqlDomainError(recorded);
  const deposit = parsePublicDepositSummary(recorded.deposit);
  if (!deposit) return { status: 'not_found' };
  return { status: 'ok', result: { deposit } };
}
