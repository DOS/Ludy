// SPDX-License-Identifier: AGPL-3.0-only
// Orgless HTTP edge helpers for the public self-service eSign template hub (Slice 4d, #3820, docs/plan/esign.md).
// Resolves only templates explicitly opted in via template_direct_link.listed_on_public_hub = true, checks
// ludy_kernel.org_app_on + billing entitlements before returning data (yielding an identical opaque 404 across
// unknown/inactive/disabled/unentitled orgs and orgs with zero public hub forms), never exposes raw or hashed
// direct-link capability tokens outside PostgreSQL, and enforces per-IP + per-template/email rate limits without CAPTCHA (#203).
import { sql } from 'kysely';
import { DEFAULT_MESSAGE_ID_DOMAIN } from '@ludy/kernel';
import {
  zId,
  zSignPublicHubActionInput,
  zSignPublicHubOrgSlug,
  type SignDirectOtpRequestResult,
  type SignDirectOtpVerifyResult,
  type SignDirectStartResult,
  type SignDirectView,
  type SignPublicHubItem,
  type SignPublicHubListResult,
} from '@ludy/kernel-contract';
import { DomainError, entitledTo, sha256Hex, type ErrorStatus, type Runtime } from '@ludy/kernel-runtime';
import {
  generateRawSigningToken,
  hashSigningToken,
  normalizeSignPageDimensions,
  parseSharedSummary,
  sanitizeSignUserAgent,
} from '@ludy/mod-sign';
import {
  signIpHash,
  type SignBilling,
  type SignPdfLookup,
  type SignRequestMeta,
  type SignTokenLimiterFn,
} from './sign-link.ts';

export const SIGN_PUBLIC_HUB_LISTS_PER_MINUTE = 60;
export const SIGN_PUBLIC_HUB_ACTIONS_PER_MINUTE = 60;
export const SIGN_PUBLIC_HUB_TEMPLATE_ACTIONS_PER_MINUTE = 30;
export const SIGN_PUBLIC_HUB_EMAIL_OTP_REQUESTS_PER_MINUTE = 3;

interface SqlErrorPayload {
  status: 'error';
  code?: string;
  httpStatus?: number;
  message?: string;
}

type SqlHubResolveRow =
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

export interface SignPublicHubActionLimiters {
  limitTemplate?: SignTokenLimiterFn;
  limitEmail?: SignTokenLimiterFn;
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
  if (row.code === 'SIGN_OTP_EMAIL_MISMATCH') {
    throw new DomainError('SIGN_OTP_EMAIL_MISMATCH', status, message);
  }
  throw new DomainError(row.code ?? 'VALIDATION', status, message);
}

async function isEntitled(billing: SignBilling, orgId: string): Promise<boolean> {
  const entitlements = await billing.entitlements(orgId);
  return entitledTo(entitlements, 'sign');
}

function templateBucketOf(orgSlug: string, templateId: string): string {
  return `hub:${orgSlug.toLowerCase()}:${templateId.toLowerCase()}`;
}

export async function runSignPublicHubList(
  runtime: Runtime,
  billing: SignBilling,
  rawOrgSlug: string,
): Promise<{ status: 'not_found' } | { status: 'ok'; hub: SignPublicHubListResult }> {
  const slugParsed = zSignPublicHubOrgSlug.safeParse(rawOrgSlug);
  if (!slugParsed.success) return { status: 'not_found' };
  const orgSlug = slugParsed.data;

  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{
      hub: {
        orgId: string;
        orgSlug: string;
        orgName: string;
        items: SignPublicHubItem[];
      } | null;
    }>`
      SELECT ludy_sign.public_hub_list(${orgSlug}) AS hub
    `.execute(db);
    return rows[0]?.hub ?? null;
  });

  if (!row || !Array.isArray(row.items) || row.items.length === 0) {
    return { status: 'not_found' };
  }
  if (!(await isEntitled(billing, row.orgId))) {
    return { status: 'not_found' };
  }

  return {
    status: 'ok',
    hub: {
      orgSlug: row.orgSlug,
      orgName: row.orgName,
      items: row.items.map((item) => ({
        templateId: item.templateId,
        title: item.title,
        description: item.description ?? null,
        roleLabel: item.roleLabel,
        signerRole: item.signerRole === 'approver' ? 'approver' : 'signer',
        requireEmailOtp: Boolean(item.requireEmailOtp),
        pageCount: Number(item.pageCount),
      })),
    },
  };
}

export async function resolvePublicHubTemplate(
  runtime: Runtime,
  billing: SignBilling,
  orgSlug: string,
  templateId: string,
  claimHash: string | null = null,
): Promise<SqlHubResolveRow | null> {
  const resolved = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ resolved: SqlHubResolveRow | null }>`
      SELECT ludy_sign.public_hub_resolve(${orgSlug}, ${templateId}::uuid, ${claimHash}) AS resolved
    `.execute(db);
    return rows[0]?.resolved ?? null;
  });
  if (!resolved) return null;
  if (!(await isEntitled(billing, resolved.orgId))) return null;
  return resolved;
}

export async function resolvePublicHubPdf(
  runtime: Runtime,
  billing: SignBilling,
  rawOrgSlug: string,
  body: unknown,
  limitTemplate?: SignTokenLimiterFn,
): Promise<SignPdfLookup> {
  const slugParsed = zSignPublicHubOrgSlug.safeParse(rawOrgSlug);
  if (!slugParsed.success) return { status: 'not_found' };
  const parsed = zSignPublicHubActionInput.safeParse(body);
  if (!parsed.success || parsed.data.action !== 'pdf') return { status: 'not_found' };

  const orgSlug = slugParsed.data;
  const { templateId } = parsed.data;
  const decision = limitTemplate?.(templateBucketOf(orgSlug, templateId));
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
      SELECT ludy_sign.public_hub_pdf_source(${orgSlug}, ${templateId}::uuid, ${claimHash}) AS source
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

function toPublicDirectView(resolved: SqlHubResolveRow): SignDirectView {
  if (resolved.state === 'otp_required') {
    return {
      state: 'otp_required',
      orgName: resolved.orgName,
      title: resolved.title,
      description: resolved.description,
      roleLabel: resolved.roleLabel,
      signerRole: resolved.signerRole === 'approver' ? 'approver' : 'signer',
      requireEmailOtp: true,
    };
  }
  return {
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
  };
}

export async function runSignPublicHubAction(
  runtime: Runtime,
  billing: SignBilling,
  rawOrgSlug: string,
  body: unknown,
  meta: SignRequestMeta,
  limiters?: SignPublicHubActionLimiters,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'otp_verify_result'; result: SignDirectOtpVerifyResult }
  | { status: 'ok'; data: SignDirectView | SignDirectOtpRequestResult | SignDirectStartResult }
> {
  const slugParsed = zSignPublicHubOrgSlug.safeParse(rawOrgSlug);
  if (!slugParsed.success || typeof body !== 'object' || body === null) {
    return { status: 'not_found' };
  }
  const orgSlug = slugParsed.data;
  const rawRecord = body as Record<string, unknown>;
  const rawAction = rawRecord.action;
  if (
    rawAction !== 'view' &&
    rawAction !== 'otp_request' &&
    rawAction !== 'otp_verify' &&
    rawAction !== 'start'
  ) {
    return { status: 'not_found' };
  }
  const tplParsed = zId.safeParse(rawRecord.templateId);
  if (!tplParsed.success) {
    return { status: 'not_found' };
  }
  const templateId = tplParsed.data;

  const tplDecision = limiters?.limitTemplate?.(templateBucketOf(orgSlug, templateId));
  if (tplDecision && !tplDecision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: tplDecision.retryAfterSeconds };
  }

  if (rawAction === 'view') {
    const parsed = zSignPublicHubActionInput.safeParse(body);
    if (!parsed.success || parsed.data.action !== 'view') {
      return { status: 'not_found' };
    }
    const claimHash = parsed.data.otpSessionToken ? hashSigningToken(parsed.data.otpSessionToken) : null;
    const resolved = await resolvePublicHubTemplate(runtime, billing, orgSlug, templateId, claimHash);
    if (!resolved) return { status: 'not_found' };
    return { status: 'ok', data: toPublicDirectView(resolved) };
  }

  // Resolve (orgSlug, templateId) BEFORE payload validation so malformed fields never reveal whether an org or template exists.
  const baseResolved = await resolvePublicHubTemplate(runtime, billing, orgSlug, templateId, null);
  if (!baseResolved) return { status: 'not_found' };

  const parsed = zSignPublicHubActionInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request payload' };
  }

  if (parsed.data.action === 'otp_request') {
    const { email } = parsed.data;
    if (email.includes('\u0000')) {
      return { status: 'validation_error', message: 'NUL is not allowed' };
    }
    const emailBucket = `${templateBucketOf(orgSlug, templateId)}:${sha256Hex(email.trim().toLowerCase())}`;
    const emailDecision = limiters?.limitEmail?.(emailBucket);
    if (emailDecision && !emailDecision.allowed) {
      return { status: 'rate_limited', retryAfterSeconds: emailDecision.retryAfterSeconds };
    }

    type SqlOtpRequestRow = ({ status: 'ok'; otpId?: string } & SignDirectOtpRequestResult) | SqlErrorPayload | null;
    const res = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ result: SqlOtpRequestRow }>`
        SELECT ludy_sign.public_hub_request_otp(
          ${orgSlug},
          ${templateId}::uuid,
          ${email},
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
      data: {
        sent: res.sent,
        expiresInMinutes: res.expiresInMinutes,
        maskedEmail: res.maskedEmail,
      },
    };
  }

  if (parsed.data.action === 'otp_verify') {
    const { email, code } = parsed.data;
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
        SELECT ludy_sign.public_hub_verify_otp(
          ${orgSlug},
          ${templateId}::uuid,
          ${email},
          ${code},
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
      status: 'otp_verify_result',
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

  if (parsed.data.action === 'start') {
    const { name, email: rawEmail, otpSessionToken } = parsed.data;
    if (name.includes('\u0000') || rawEmail?.includes('\u0000')) {
      return { status: 'validation_error', message: 'NUL is not allowed' };
    }
    const signingToken = generateRawSigningToken();
    const signingTokenSha256 = hashSigningToken(signingToken);
    const claimHash = otpSessionToken ? hashSigningToken(otpSessionToken) : null;

    type SqlHubStartRow =
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
      const { rows } = await sql<{ result: SqlHubStartRow }>`
        SELECT ludy_sign.public_hub_start(
          ${orgSlug},
          ${templateId}::uuid,
          ${name},
          ${rawEmail ?? null},
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
      data: {
        envelopeId: res.envelopeId,
        signerId: res.signerId,
        signingToken,
        expiresAt: res.expiresAt,
      },
    };
  }

  return { status: 'not_found' };
}
