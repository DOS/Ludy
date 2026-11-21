// SPDX-License-Identifier: AGPL-3.0-only
// Orgless HTTP edge helpers for public eSign Slice 2a A1 direct signing links (#3551, docs/plan/esign.md).
// Reads capability tokens strictly from JSON POST bodies, checks org_app_on + billing entitlements inside orgless
// SECURITY DEFINER resolution (returning an identical opaque 404 across invalid/disabled/revoked/expired/max_uses/MODULE_OFF),
// and enforces per-IP + per-token/email rate limits without third-party CAPTCHA (#203).
import { sql } from 'kysely';
import { DEFAULT_MESSAGE_ID_DOMAIN } from '@crove/kernel';
import {
  zSignDirectOtpRequestInput,
  zSignDirectOtpVerifyInput,
  zSignDirectPdfInput,
  zSignDirectStartInput,
  zSignDirectViewInput,
  zSignToken,
  type SignDirectOtpRequestResult,
  type SignDirectOtpVerifyResult,
  type SignDirectStartResult,
  type SignDirectView,
} from '@crove/kernel-contract';
import { DomainError, entitledTo, sha256Hex, type ErrorStatus, type Runtime } from '@crove/kernel-runtime';
import {
  generateRawSigningToken,
  hashSigningToken,
  normalizeSignPageDimensions,
  parseSharedSummary,
  sanitizeSignUserAgent,
} from '@crove/mod-sign';
import {
  signIpHash,
  type SignBilling,
  type SignPdfLookup,
  type SignRequestMeta,
  type SignTokenLimiterFn,
} from './sign-link.ts';

export const SIGN_DIRECT_VIEWS_PER_MINUTE = 60;
export const SIGN_DIRECT_TOKEN_VIEWS_PER_MINUTE = 30;
export const SIGN_DIRECT_PDFS_PER_MINUTE = 30;
export const SIGN_DIRECT_TOKEN_PDFS_PER_MINUTE = 20;
export const SIGN_DIRECT_OTP_REQUESTS_PER_MINUTE = 10;
export const SIGN_DIRECT_TOKEN_OTP_REQUESTS_PER_MINUTE = 10;
export const SIGN_DIRECT_EMAIL_OTP_REQUESTS_PER_MINUTE = 3;
export const SIGN_DIRECT_OTP_VERIFIES_PER_MINUTE = 20;
export const SIGN_DIRECT_TOKEN_OTP_VERIFIES_PER_MINUTE = 10;
export const SIGN_DIRECT_STARTS_PER_MINUTE = 20;
export const SIGN_DIRECT_TOKEN_STARTS_PER_MINUTE = 10;

interface SqlErrorPayload {
  status: 'error';
  code?: string;
  httpStatus?: number;
  message?: string;
}

type SqlDirectResolveRow =
  | {
      orgId: string;
      directLinkId: string;
      templateId: string;
      state: 'otp_required';
      orgName: string;
      title: string;
      description: string | null;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      requireEmailOtp: true;
    }
  | {
      orgId: string;
      directLinkId: string;
      templateId: string;
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
      pageDimensions: unknown;
      fieldCount: number;
      sharedSummary?: unknown;
    };

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
  if (row.code === 'SIGN_OTP_EMAIL_MISMATCH') {
    throw new DomainError('SIGN_OTP_EMAIL_MISMATCH', status, message);
  }
  throw new DomainError(row.code ?? 'VALIDATION', status, message);
}

async function isEntitled(billing: SignBilling, orgId: string): Promise<boolean> {
  const entitlements = await billing.entitlements(orgId);
  return entitledTo(entitlements, 'sign');
}

export async function resolvePublicDirectLink(
  runtime: Runtime,
  billing: SignBilling,
  tokenHash: string,
  claimHash?: string | null,
): Promise<SqlDirectResolveRow | null> {
  const resolved = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ resolved: SqlDirectResolveRow | null }>`
      SELECT crove_sign.public_direct_resolve(${tokenHash}, ${claimHash ?? null}) AS resolved
    `.execute(db);
    return rows[0]?.resolved ?? null;
  });
  if (!resolved) return null;
  if (!(await isEntitled(billing, resolved.orgId))) return null;
  return resolved;
}

export async function resolvePublicDirectPdf(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<SignPdfLookup> {
  const parsed = zSignDirectPdfInput.safeParse(body);
  if (!parsed.success) return { status: 'not_found' };
  const tokenHash = hashSigningToken(parsed.data.token);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const claimHash = parsed.data.otpSessionToken ? hashSigningToken(parsed.data.otpSessionToken) : null;
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
      SELECT crove_sign.public_direct_pdf_source(${tokenHash}, ${claimHash}) AS source
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

export async function runSignDirectView(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; view: SignDirectView }
> {
  const parsed = zSignDirectViewInput.safeParse(body);
  if (!parsed.success) return { status: 'not_found' };
  const tokenHash = hashSigningToken(parsed.data.token);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const claimHash = parsed.data.otpSessionToken ? hashSigningToken(parsed.data.otpSessionToken) : null;
  const resolved = await resolvePublicDirectLink(runtime, billing, tokenHash, claimHash);
  if (!resolved) return { status: 'not_found' };

  if (resolved.state === 'otp_required') {
    return {
      status: 'ok',
      view: {
        state: 'otp_required',
        orgName: resolved.orgName,
        title: resolved.title,
        description: resolved.description,
        roleLabel: resolved.roleLabel,
        signerRole: resolved.signerRole === 'approver' ? 'approver' : 'signer',
        requireEmailOtp: true,
      },
    };
  }

  return {
    status: 'ok',
    view: {
      state: 'ready',
      orgName: resolved.orgName,
      title: resolved.title,
      description: resolved.description,
      message: resolved.message,
      roleLabel: resolved.roleLabel,
      signerRole: resolved.signerRole === 'approver' ? 'approver' : 'signer',
      emailRequired: resolved.emailRequired,
      requireEmailOtp: resolved.requireEmailOtp,
      otpVerified: resolved.otpVerified,
      verifiedEmail: resolved.verifiedEmail,
      pageCount: resolved.pageCount,
      pageDimensions: normalizeSignPageDimensions(resolved.pageDimensions),
      fieldCount: resolved.fieldCount,
      sharedSummary: parseSharedSummary(resolved.sharedSummary ?? null, resolved.pageCount),
    },
  };
}

export async function runSignDirectOtpRequest(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
  limitTokenEmail?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: SignDirectOtpRequestResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = hashSigningToken(rawToken as string);
  const tokenDecision = limitToken?.(tokenHash);
  if (tokenDecision && !tokenDecision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: tokenDecision.retryAfterSeconds };
  }

  const resolved = await resolvePublicDirectLink(runtime, billing, tokenHash, null);
  if (!resolved) return { status: 'not_found' };

  const parsed = zSignDirectOtpRequestInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid email address' };
  }
  if (parsed.data.email.includes('\u0000')) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  const emailBucket = `${tokenHash}:${sha256Hex(parsed.data.email)}`;
  const emailDecision = limitTokenEmail?.(emailBucket);
  if (emailDecision && !emailDecision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: emailDecision.retryAfterSeconds };
  }

  type SqlOtpRequestRow =
    | ({ status: 'ok'; otpId?: string } & SignDirectOtpRequestResult)
    | SqlErrorPayload
    | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpRequestRow }>`
      SELECT crove_sign.public_direct_request_otp(
        ${tokenHash},
        ${parsed.data.email},
        ${DEFAULT_MESSAGE_ID_DOMAIN}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? null;
  });
  if (!res) return { status: 'not_found' };
  if (res.status === 'error') {
    if (res.httpStatus === 429) {
      return { status: 'rate_limited', retryAfterSeconds: 60 };
    }
    throwSqlDomainError(res);
  }

  return {
    status: 'ok',
    result: {
      sent: res.sent,
      expiresInMinutes: res.expiresInMinutes,
      maskedEmail: res.maskedEmail,
    },
  };
}

export async function runSignDirectOtpVerify(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'result'; result: SignDirectOtpVerifyResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = hashSigningToken(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }

  const resolved = await resolvePublicDirectLink(runtime, billing, tokenHash, null);
  if (!resolved) return { status: 'not_found' };

  const parsed = zSignDirectOtpVerifyInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid verification code' };
  }

  const rawClaim = generateRawSigningToken();
  const claimSha256 = hashSigningToken(rawClaim);

  type SqlOtpVerifyRow =
    | { status: 'validation_error'; message: string }
    | SqlErrorPayload
    | {
        ok: boolean;
        locked: boolean;
        attemptsRemaining: number;
        expired?: boolean;
        notReady?: boolean;
        verifiedEmail?: string;
      }
    | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpVerifyRow }>`
      SELECT crove_sign.public_direct_verify_otp(
        ${tokenHash},
        ${parsed.data.email},
        ${parsed.data.code},
        ${claimSha256}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? null;
  });

  if (!res) return { status: 'not_found' };
  if ('status' in res && res.status === 'validation_error') {
    return { status: 'validation_error', message: res.message };
  }
  if ('status' in res && res.status === 'error') {
    throwSqlDomainError(res);
  }

  const verified = res as {
    ok: boolean;
    locked: boolean;
    attemptsRemaining: number;
    expired?: boolean;
    notReady?: boolean;
    verifiedEmail?: string;
  };

  return {
    status: 'result',
    result: {
      ok: Boolean(verified.ok),
      locked: Boolean(verified.locked),
      attemptsRemaining: Number(verified.attemptsRemaining ?? 0),
      ...(verified.expired ? { expired: true } : {}),
      ...(verified.notReady ? { notReady: true } : {}),
      ...(verified.ok ? { otpSessionToken: rawClaim, verifiedEmail: verified.verifiedEmail } : {}),
    },
  };
}

export async function runSignDirectStart(
  runtime: Runtime,
  billing: SignBilling,
  body: unknown,
  meta: SignRequestMeta,
  limitToken?: SignTokenLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: SignDirectStartResult }
> {
  const rawToken = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (!zSignToken.safeParse(rawToken).success) {
    return { status: 'not_found' };
  }
  const tokenHash = hashSigningToken(rawToken as string);
  const decision = limitToken?.(tokenHash);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }

  const resolved = await resolvePublicDirectLink(runtime, billing, tokenHash, null);
  if (!resolved) return { status: 'not_found' };

  const parsed = zSignDirectStartInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid recipient details' };
  }
  if (parsed.data.name.includes('\u0000') || parsed.data.email?.includes('\u0000')) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  const signingToken = generateRawSigningToken();
  const signingTokenSha256 = hashSigningToken(signingToken);
  const claimHash = parsed.data.otpSessionToken ? hashSigningToken(parsed.data.otpSessionToken) : null;

  type SqlDirectStartRow =
    | { status: 'not_found' }
    | SqlErrorPayload
    | {
        status: 'ok';
        orgId: string;
        templateId: string;
        directLinkId: string;
        envelopeId: string;
        signerId: string;
        signingTokenId: string;
        expiresAt: string;
      }
    | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlDirectStartRow }>`
      SELECT crove_sign.public_direct_start(
        ${tokenHash},
        ${parsed.data.name},
        ${parsed.data.email ?? null},
        ${claimHash},
        ${signingTokenSha256},
        ${signIpHash(meta.ip)},
        ${sanitizeSignUserAgent(meta.userAgent)}
      ) AS result
    `.execute(db);
    return rows[0]?.result ?? { status: 'not_found' as const };
  });

  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'error') {
    if (res.httpStatus === 429) {
      return { status: 'rate_limited', retryAfterSeconds: 60 };
    }
    throwSqlDomainError(res);
  }

  return {
    status: 'ok',
    result: {
      envelopeId: res.envelopeId,
      signerId: res.signerId,
      signingToken,
      expiresAt: res.expiresAt,
    },
  };
}
