// SPDX-License-Identifier: AGPL-3.0-only
// Orgless HTTP edge helpers for Projects Public Roadmap Slice 1 (#4399, ADR-0057, ADR-0053, #203).
// Every public route enforces org_app_on + billing entitlement + board.enabled = true -> identical opaque 404,
// zero query tokens, zero CAPTCHA (#203), per-IP/board/email rate limits, 2 KB / 16 KB body caps, and strict
// HTTPS-only ?embed=1 CSP frame-ancestors validation.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { DEFAULT_MESSAGE_ID_DOMAIN } from '@ludy/kernel';
import {
  ROADMAP_PAGE_PREFIX,
  ROADMAP_SLUG_PATTERN,
  ROADMAP_VOTER_CLAIM_TTL_MS,
  normalizeRoadmapEmbedOrigin,
  zRoadmapPublicOtpRequestInput,
  zRoadmapPublicOtpVerifyInput,
  zRoadmapPublicSubmitIdeaInput,
  zRoadmapPublicVoteInput,
  type RoadmapPublicOtpRequestResult,
  type RoadmapPublicOtpVerifyResult,
  type RoadmapPublicSubmitIdeaResult,
  type RoadmapPublicViewResult,
  type RoadmapPublicVoteResult,
} from '@ludy/kernel-contract';
import {
  DomainError,
  entitledTo,
  sha256Hex,
  type CredentialBroker,
  type ErrorStatus,
  type Runtime,
} from '@ludy/kernel-runtime';
import type { SignBilling } from './sign-link.ts';
import type { RateLimitDecision } from './rate-limit.ts';

export const ROADMAP_PUBLIC_VIEWS_PER_MINUTE = 60;
export const ROADMAP_PUBLIC_OTP_REQUESTS_PER_MINUTE = 5;
export const ROADMAP_PUBLIC_OTP_EMAIL_REQUESTS_PER_MINUTE = 3;
export const ROADMAP_PUBLIC_OTP_VERIFIES_PER_MINUTE = 10;
export const ROADMAP_PUBLIC_IDEAS_PER_MINUTE = 10;
export const ROADMAP_PUBLIC_VOTES_PER_MINUTE = 60;

export type RoadmapRateLimiterFn = (bucket: string) => RateLimitDecision;

interface SqlErrorPayload {
  orgId?: string;
  status: 'error';
  code?: string;
  httpStatus?: number;
  message?: string;
}

interface SqlBoardResolveRow {
  orgId: string;
  boardId: string;
  origins: unknown;
  voterEmailHash?: string | null;
  hasSubscriber?: boolean;
}

export interface RoadmapVoterClaimPayload {
  orgSlug: string;
  boardSlug: string;
  iat: number;
  exp: number;
}

const CLAIM_SHAPE = /^rm1\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;
const CLAIM_INFO = 'crove.projects.roadmap-voter-claim.v1';

export function deriveRoadmapClaimKey(broker: CredentialBroker | undefined, authJwtSecret: string | undefined): Buffer {
  if (broker && broker.id !== 'none' && broker.derive) {
    return broker.derive(CLAIM_INFO);
  }
  const baseSecret = authJwtSecret && authJwtSecret.length > 0 ? Buffer.from(authJwtSecret, 'utf8') : randomBytes(32);
  return Buffer.from(hkdfSync('sha256', baseSecret, Buffer.alloc(0), Buffer.from(CLAIM_INFO, 'utf8'), 32));
}

export function mintRoadmapVoterClaim(
  key: Buffer,
  orgSlug: string,
  boardSlug: string,
  nowMs = Date.now(),
): { token: string; claimSha256: string; expiresAt: string } {
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + ROADMAP_VOTER_CLAIM_TTL_MS) / 1000);
  const body = Buffer.from(
    JSON.stringify({ orgSlug: orgSlug.toLowerCase(), boardSlug: boardSlug.toLowerCase(), iat, exp }),
    'utf8',
  ).toString('base64url');
  const signed = `rm1.${body}`;
  const sig = createHmac('sha256', key).update(signed, 'utf8').digest().toString('base64url');
  const token = `${signed}.${sig}`;
  return {
    token,
    claimSha256: sha256Hex(token),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyRoadmapVoterClaim(
  rawToken: string | null | undefined,
  key: Buffer,
  orgSlug: string,
  boardSlug: string,
  nowMs = Date.now(),
): { claimSha256: string } | null {
  if (!rawToken || rawToken.length > 700) return null;
  const match = CLAIM_SHAPE.exec(rawToken.trim());
  if (!match) return null;
  const bodyB64 = match[1] as string;
  const sigB64 = match[2] as string;
  if (Buffer.from(bodyB64, 'base64url').toString('base64url') !== bodyB64) return null;
  if (Buffer.from(sigB64, 'base64url').toString('base64url') !== sigB64) return null;

  const expectedSig = createHmac('sha256', key).update(`rm1.${bodyB64}`, 'utf8').digest();
  const providedSig = Buffer.from(sigB64, 'base64url');
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as Partial<RoadmapVoterClaimPayload>;
  const nowSec = Math.floor(nowMs / 1000);
  if (
    payload.orgSlug !== orgSlug.toLowerCase() ||
    payload.boardSlug !== boardSlug.toLowerCase() ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= nowSec
  ) {
    return null;
  }
  return { claimSha256: sha256Hex(rawToken.trim()) };
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
  throw new DomainError(row.code ?? 'VALIDATION', toErrorStatus(row.httpStatus), row.message ?? 'Request rejected');
}

function validSlugs(orgSlug: string, boardSlug: string): { orgSlug: string; boardSlug: string } | null {
  const o = orgSlug.trim().toLowerCase();
  const b = boardSlug.trim().toLowerCase();
  if (!ROADMAP_SLUG_PATTERN.test(o) || !ROADMAP_SLUG_PATTERN.test(b)) return null;
  return { orgSlug: o, boardSlug: b };
}

async function isProjectsEntitled(billing: SignBilling, orgId: string): Promise<boolean> {
  const entitlements = await billing.entitlements(orgId);
  return entitledTo(entitlements, 'projects');
}

export function roadmapIpHash(ip: string | null): string | null {
  const trimmed = ip?.trim();
  return trimmed ? sha256Hex(trimmed) : null;
}

function sealSubscriberEmail(
  broker: CredentialBroker,
  orgId: string,
  boardId: string,
  voterEmailHash: string,
  email: string,
): { emailSealed: string; unsubTokenSha256: string } {
  if (broker.id === 'none') {
    throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin người đăng ký (CREDENTIAL_KEY)');
  }
  const sealed = broker.seal(email, {
    orgId,
    provider: 'projects.roadmap_subscriber',
    externalAccountId: `${boardId}:${voterEmailHash}`,
  });
  const unsubTokenSha256 = sha256Hex(randomBytes(32).toString('base64url'));
  return {
    emailSealed: `crove:cs1:${sealed.keyId}:${sealed.envelope.toString('base64url')}`,
    unsubTokenSha256,
  };
}

export async function resolvePublicRoadmapBoard(
  runtime: Runtime,
  billing: SignBilling,
  rawOrgSlug: string,
  rawBoardSlug: string,
  voterEmail?: string | null,
): Promise<{ orgId: string; boardId: string; origins: string[]; voterEmailHash: string | null; hasSubscriber: boolean } | null> {
  const slugs = validSlugs(rawOrgSlug, rawBoardSlug);
  if (!slugs) return null;
  const cleanEmail = voterEmail ? voterEmail.trim().toLowerCase() : null;
  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ resolved: SqlBoardResolveRow | null }>`
      SELECT crove_projects.public_roadmap_resolve_board(${slugs.orgSlug}, ${slugs.boardSlug}, ${cleanEmail}) AS resolved`.execute(db);
    return rows[0]?.resolved ?? null;
  });
  if (!row) return null;
  if (!(await isProjectsEntitled(billing, row.orgId))) return null;
  const rawOrigins = Array.isArray(row.origins) ? row.origins : [];
  const origins = [
    ...new Set(
      rawOrigins
        .filter((item): item is string => typeof item === 'string')
        .map((item) => normalizeRoadmapEmbedOrigin(item))
        .filter((item): item is string => item !== null),
    ),
  ];
  return {
    orgId: row.orgId,
    boardId: row.boardId,
    origins,
    voterEmailHash: row.voterEmailHash ?? null,
    hasSubscriber: Boolean(row.hasSubscriber),
  };
}

export function matchPublicRoadmapPagePath(path: string): { orgSlug: string; boardSlug: string } | null {
  if (!path.startsWith(`${ROADMAP_PAGE_PREFIX}/`)) return null;
  const rest = path.slice(ROADMAP_PAGE_PREFIX.length + 1).replace(/\/+$/, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  return validSlugs(parts[0] ?? '', parts[1] ?? '');
}

export async function resolveRoadmapEmbedFrameAncestors(
  runtime: Runtime,
  billing: SignBilling,
  orgSlug: string,
  boardSlug: string,
): Promise<string[] | null> {
  if (!runtime.installed('projects')) return null;
  const resolved = await resolvePublicRoadmapBoard(runtime, billing, orgSlug, boardSlug);
  if (!resolved || resolved.origins.length === 0) return null;
  return resolved.origins;
}

export async function runPublicRoadmapView(
  runtime: Runtime,
  billing: SignBilling,
  orgSlug: string,
  boardSlug: string,
  viewer: { claimSha256: string | null; voterEmail: string | null },
): Promise<{ status: 'not_found' } | { status: 'ok'; view: RoadmapPublicViewResult }> {
  const slugs = validSlugs(orgSlug, boardSlug);
  if (!slugs) return { status: 'not_found' };

  type SqlViewRow = RoadmapPublicViewResult & { orgId: string };
  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ view: SqlViewRow | null }>`
      SELECT crove_projects.public_roadmap_view(
        ${slugs.orgSlug},
        ${slugs.boardSlug},
        ${viewer.claimSha256},
        ${viewer.voterEmail}
      ) AS view`.execute(db);
    return rows[0]?.view ?? null;
  });
  if (!res) return { status: 'not_found' };
  if (!(await isProjectsEntitled(billing, res.orgId))) return { status: 'not_found' };

  return {
    status: 'ok',
    view: {
      board: res.board,
      viewer: res.viewer,
      items: res.items,
    },
  };
}

export async function runPublicRoadmapOtpRequest(
  runtime: Runtime,
  billing: SignBilling,
  orgSlug: string,
  boardSlug: string,
  body: unknown,
  ip: string | null,
  limitEmail?: RoadmapRateLimiterFn,
): Promise<
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: RoadmapPublicOtpRequestResult }
> {
  const resolved = await resolvePublicRoadmapBoard(runtime, billing, orgSlug, boardSlug);
  if (!resolved) return { status: 'not_found' };

  const parsed = zRoadmapPublicOtpRequestInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid email address' };
  }
  if (parsed.data.email.includes('\u0000')) {
    return { status: 'validation_error', message: 'NUL is not allowed' };
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const emailBucket = `${resolved.boardId}:${sha256Hex(normalizedEmail)}`;
  const emailDecision = limitEmail?.(emailBucket);
  if (emailDecision && !emailDecision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: emailDecision.retryAfterSeconds };
  }

  const ipHash = roadmapIpHash(ip);
  type SqlOtpRequestRow = ({ orgId: string; status: 'ok' } & RoadmapPublicOtpRequestResult) | SqlErrorPayload | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpRequestRow }>`
      SELECT crove_projects.public_roadmap_otp_request(
        ${orgSlug.trim().toLowerCase()},
        ${boardSlug.trim().toLowerCase()},
        ${normalizedEmail},
        ${ipHash},
        ${DEFAULT_MESSAGE_ID_DOMAIN}
      ) AS result`.execute(db);
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

export async function runPublicRoadmapOtpVerify(
  runtime: Runtime,
  billing: SignBilling,
  claimKey: Buffer,
  orgSlug: string,
  boardSlug: string,
  body: unknown,
): Promise<
  | { status: 'not_found' }
  | { status: 'validation_error'; message: string }
  | { status: 'result'; result: RoadmapPublicOtpVerifyResult }
> {
  const resolved = await resolvePublicRoadmapBoard(runtime, billing, orgSlug, boardSlug);
  if (!resolved) return { status: 'not_found' };

  const parsed = zRoadmapPublicOtpVerifyInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid verification code' };
  }
  const slugs = validSlugs(orgSlug, boardSlug);
  if (!slugs) return { status: 'not_found' };

  const claim = mintRoadmapVoterClaim(claimKey, slugs.orgSlug, slugs.boardSlug);

  type SqlOtpVerifyRow =
    | { status: 'validation_error'; message: string }
    | SqlErrorPayload
    | {
        orgId: string;
        boardId?: string;
        ok: boolean;
        locked: boolean;
        attemptsRemaining: number;
        expired?: boolean;
        notReady?: boolean;
        maskedEmail?: string;
        expiresAt?: string;
      }
    | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlOtpVerifyRow }>`
      SELECT crove_projects.public_roadmap_otp_verify(
        ${slugs.orgSlug},
        ${slugs.boardSlug},
        ${parsed.data.email.trim().toLowerCase()},
        ${parsed.data.code},
        ${claim.claimSha256}
      ) AS result`.execute(db);
    return rows[0]?.result ?? null;
  });

  if (!res) return { status: 'not_found' };
  if ('status' in res) {
    if (res.status === 'validation_error') {
      return { status: 'validation_error', message: res.message };
    }
    throwSqlDomainError(res);
  }

  return {
    status: 'result',
    result: {
      ok: res.ok,
      locked: res.locked,
      attemptsRemaining: res.attemptsRemaining,
      ...(res.expired ? { expired: true } : {}),
      ...(res.notReady ? { notReady: true } : {}),
      ...(res.ok
        ? {
            voterToken: claim.token,
            ...(res.maskedEmail ? { maskedEmail: res.maskedEmail } : {}),
            ...(res.expiresAt ? { expiresAt: res.expiresAt } : { expiresAt: claim.expiresAt }),
          }
        : {}),
    },
  };
}

export async function runPublicRoadmapSubmitIdea(
  runtime: Runtime,
  billing: SignBilling,
  orgSlug: string,
  boardSlug: string,
  body: unknown,
  auth: { claimSha256: string | null; voterEmail: string | null; actorUserId: string | null },
): Promise<
  | { status: 'not_found' }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: RoadmapPublicSubmitIdeaResult }
> {
  const resolved = await resolvePublicRoadmapBoard(runtime, billing, orgSlug, boardSlug);
  if (!resolved) return { status: 'not_found' };

  if (!auth.claimSha256 && !auth.voterEmail) {
    throw new DomainError('ROADMAP_OTP_REQUIRED', 401, 'Vui lòng xác thực email bằng mã OTP trước khi gửi ý tưởng');
  }

  const parsed = zRoadmapPublicSubmitIdeaInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Dữ liệu ý tưởng không hợp lệ' };
  }

  type SqlSubmitRow = ({ orgId: string; status: 'ok' } & RoadmapPublicSubmitIdeaResult) | SqlErrorPayload | null;
  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlSubmitRow }>`
      SELECT crove_projects.public_roadmap_submit_idea(
        ${orgSlug.trim().toLowerCase()},
        ${boardSlug.trim().toLowerCase()},
        ${parsed.data.title},
        ${parsed.data.summary ?? null},
        ${parsed.data.category ?? null},
        ${parsed.data.displayName ?? null},
        ${auth.claimSha256},
        ${auth.voterEmail},
        ${auth.actorUserId}::uuid
      ) AS result`.execute(db);
    return rows[0]?.result ?? null;
  });

  if (!res) return { status: 'not_found' };
  if (res.status === 'error') throwSqlDomainError(res);

  return {
    status: 'ok',
    result: { item: res.item },
  };
}

export async function runPublicRoadmapVote(
  runtime: Runtime,
  billing: SignBilling,
  broker: CredentialBroker,
  orgSlug: string,
  boardSlug: string,
  body: unknown,
  auth: { claimSha256: string | null; voterEmail: string | null },
): Promise<
  | { status: 'not_found' }
  | { status: 'validation_error'; message: string }
  | { status: 'ok'; result: RoadmapPublicVoteResult }
> {
  const resolved = await resolvePublicRoadmapBoard(runtime, billing, orgSlug, boardSlug, auth.voterEmail);
  if (!resolved) return { status: 'not_found' };

  const parsed = zRoadmapPublicVoteInput.safeParse(body);
  if (!parsed.success) {
    return { status: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Yêu cầu bình chọn không hợp lệ' };
  }

  const cleanOrgSlug = orgSlug.trim().toLowerCase();
  const cleanBoardSlug = boardSlug.trim().toLowerCase();

  if (parsed.data.action === 'unsubscribe') {
    const tokenHash = sha256Hex(parsed.data.unsubscribeToken as string);
    type SqlUnsubRow = ({ orgId: string; status: 'ok'; unsubscribed: boolean }) | SqlErrorPayload | null;
    const unsub = await runtime.orgless(async (db) => {
      const { rows } = await sql<{ result: SqlUnsubRow }>`
        SELECT crove_projects.public_roadmap_unsubscribe(
          ${cleanOrgSlug},
          ${cleanBoardSlug},
          ${tokenHash}
        ) AS result`.execute(db);
      return rows[0]?.result ?? null;
    });
    if (!unsub) return { status: 'not_found' };
    if (unsub.status === 'error') throwSqlDomainError(unsub);
    return { status: 'ok', result: { unsubscribed: true } };
  }

  if (!auth.claimSha256 && !auth.voterEmail) {
    throw new DomainError('ROADMAP_OTP_REQUIRED', 401, 'Vui lòng xác thực email bằng mã OTP để bình chọn');
  }

  let effectiveNotify: boolean | null = parsed.data.notifyOnShip ?? null;
  if (effectiveNotify === undefined) effectiveNotify = null;
  let emailSealed: string | null = null;
  let unsubTokenSha256: string | null = null;

  if (effectiveNotify === true) {
    if (auth.claimSha256) {
      const claimRow = await runtime.orgless(async (db) => {
        const { rows } = await sql<{
          claim: { orgId: string; boardId: string; valid: boolean; email?: string; voterEmailHash?: string; hasSubscriber?: boolean } | null;
        }>`
          SELECT crove_projects.public_roadmap_claim_resolve(
            ${cleanOrgSlug},
            ${cleanBoardSlug},
            ${auth.claimSha256}
          ) AS claim`.execute(db);
        return rows[0]?.claim ?? null;
      });
      if (!claimRow) return { status: 'not_found' };
      if (!claimRow.valid || !claimRow.email || !claimRow.voterEmailHash) {
        throw new DomainError('ROADMAP_OTP_REQUIRED', 401, 'Phiên xác thực OTP đã hết hạn, vui lòng xác thực lại');
      }
      if (!claimRow.hasSubscriber) {
        const sealed = sealSubscriberEmail(broker, claimRow.orgId, claimRow.boardId, claimRow.voterEmailHash, claimRow.email);
        emailSealed = sealed.emailSealed;
        unsubTokenSha256 = sealed.unsubTokenSha256;
      }
    } else if (auth.voterEmail) {
      if (!resolved.voterEmailHash) {
        throw new DomainError('VALIDATION', 422, 'Email không hợp lệ');
      }
      if (!resolved.hasSubscriber) {
        const sealed = sealSubscriberEmail(
          broker,
          resolved.orgId,
          resolved.boardId,
          resolved.voterEmailHash,
          auth.voterEmail.trim().toLowerCase(),
        );
        emailSealed = sealed.emailSealed;
        unsubTokenSha256 = sealed.unsubTokenSha256;
      }
    }
  }

  type SqlVoteRow =
    | ({
        orgId: string;
        status: 'ok';
        itemId: string;
        voted: boolean;
        voteCount: number;
        notifyOnShip: boolean;
      })
    | SqlErrorPayload
    | null;

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ result: SqlVoteRow }>`
      SELECT crove_projects.public_roadmap_vote(
        ${cleanOrgSlug},
        ${cleanBoardSlug},
        ${parsed.data.itemId as string}::uuid,
        ${parsed.data.action},
        ${auth.claimSha256},
        ${auth.voterEmail},
        ${effectiveNotify},
        ${emailSealed},
        ${unsubTokenSha256}
      ) AS result`.execute(db);
    return rows[0]?.result ?? null;
  });

  if (!res) return { status: 'not_found' };
  if (res.status === 'error') throwSqlDomainError(res);

  return {
    status: 'ok',
    result: {
      itemId: res.itemId,
      voted: res.voted,
      voteCount: res.voteCount,
      notifyOnShip: res.notifyOnShip,
    },
  };
}
