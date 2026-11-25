// SPDX-License-Identifier: AGPL-3.0-only
// Scoped external REST API edge helpers for /api/v1/sign/* (#4441, eSign Slice 5c).
// Verifies Bearer ludy_sk_... API keys via SHA-256 against ludy_sign.api_key_* SECURITY DEFINER
// functions, enforces org_app_on('sign') + billing entitlements (opaque 404), scope separation
// (sign:read vs sign:draft), per-IP + per-key rate limits, Cache-Control: no-store, strict
// exclusion of hr_contract and meeting_minutes envelopes (404 non-existence parity), and
// draft-only envelope creation (never auto-sends or returns signing tokens).
import { sql } from 'kysely';
import {
  zSignApiKeyScope,
  zSignApiV1FromTemplateInput,
  zSignEnvelopeStatus,
  type SignApiKeyScope,
} from '@ludy/kernel-contract';
import {
  DomainError,
  entitledTo,
  readVerified,
  sha256Hex,
  type BlobStore,
  type ErrorStatus,
  type Runtime,
} from '@ludy/kernel-runtime';
import { sanitizeSignUserAgent } from '@ludy/mod-sign';
import {
  SIGN_PDF_MAX_BYTES,
  signIpHash,
  type SignBilling,
  type SignRequestMeta,
  type SignTokenLimiterFn,
} from './sign-link.ts';

export const SIGN_API_V1_IP_PER_MINUTE = 120;
export const SIGN_API_V1_KEY_READ_PER_MINUTE = 60;
export const SIGN_API_V1_KEY_DRAFT_PER_MINUTE = 20;

const API_KEY_BEARER_RE = /^Bearer\s+(ludy_sk_[A-Za-z0-9_-]{32,64})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RawAuthResult {
  status: 'unauthorized' | 'not_found' | 'ok';
  orgId?: string;
  orgSlug?: string;
  keyId?: string;
  keyPrefix?: string;
  scopes?: string[];
  createdBy?: string | null;
}

interface RawSqlActionResult {
  status: 'unauthorized' | 'not_found' | 'forbidden' | 'envelope_not_found' | 'template_not_found' | 'error' | 'ok';
  code?: string;
  httpStatus?: number;
  message?: string;
  items?: unknown[];
  envelope?: Record<string, unknown>;
  envelopeId?: string;
  certificateCode?: string | null;
  storageKey?: string;
  generation?: string | null;
  sha256?: string;
  id?: string;
  orgSlug?: string;
}

export interface SignApiV1FileSource {
  orgId: string;
  envelopeId: string;
  certificateCode: string | null;
  storageKey: string;
  generation: string | null;
  sha256: string;
}

export type SignApiV1Outcome<T> =
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'forbidden'; requiredScope: SignApiKeyScope }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; data: T };

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

function throwActionError(row: RawSqlActionResult): never {
  const status = toErrorStatus(row.httpStatus);
  const message = row.message ?? 'Request rejected';
  switch (row.code) {
    case 'SIGN_TEMPLATE_ARCHIVED':
      throw new DomainError('SIGN_TEMPLATE_ARCHIVED', status, message);
    case 'SIGN_TEMPLATE_NOT_ACTIVE':
      throw new DomainError('SIGN_TEMPLATE_NOT_ACTIVE', status, message);
    case 'SIGN_TEXT_DEFAULT_TOO_LONG':
      throw new DomainError('SIGN_TEXT_DEFAULT_TOO_LONG', status, message);
    case 'SIGN_INSPECT_FAILED':
      throw new DomainError('SIGN_INSPECT_FAILED', status, message);
    case 'SIGN_DOCUMENT_NOT_INSPECTED':
      throw new DomainError('SIGN_DOCUMENT_NOT_INSPECTED', status, message);
    case 'SIGN_INVALID_EXPIRY':
      throw new DomainError('SIGN_INVALID_EXPIRY', status, message);
    case 'SIGN_UNKNOWN_ROLE_KEY':
      throw new DomainError('SIGN_UNKNOWN_ROLE_KEY', status, message);
    case 'SIGN_DUPLICATE_ROLE_KEY':
      throw new DomainError('SIGN_DUPLICATE_ROLE_KEY', status, message);
    case 'SIGN_RECIPIENT_REQUIRED':
      throw new DomainError('SIGN_RECIPIENT_REQUIRED', status, message);
    case 'SIGN_EMAIL_REQUIRED':
      throw new DomainError('SIGN_EMAIL_REQUIRED', status, message);
    case 'SIGN_ENVELOPE_NOT_SEALED':
      throw new DomainError('SIGN_ENVELOPE_NOT_SEALED', status, message);
    default:
      throw new DomainError('VALIDATION', status, message);
  }
}

export function parseSignApiKeyBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  const match = API_KEY_BEARER_RE.exec(trimmed);
  if (!match) return null;
  const raw = match[1] as string;
  if (!raw.startsWith('ludy_sk_')) return null;
  return sha256Hex(raw);
}

async function authenticateApiKey(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  requiredScope: SignApiKeyScope,
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'forbidden'; requiredScope: SignApiKeyScope }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; keySha256: string; orgId: string; orgSlug: string }
> {
  const keySha256 = parseSignApiKeyBearer(authHeader);
  if (!keySha256) return { status: 'unauthorized' };

  // Short-circuit already-throttled keys before hitting Postgres or billing entitlements;
  // RateLimiter.peek never inserts unknown keys into buckets, preserving unknown-key spray isolation.
  const preDecision = peekLimitKey?.(keySha256);
  if (preDecision && !preDecision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: preDecision.retryAfterSeconds };
  }

  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ auth: RawAuthResult | null }>`
      SELECT ludy_sign.api_key_authenticate(${keySha256}) AS auth
    `.execute(db);
    return rows[0]?.auth ?? null;
  });

  if (!row || row.status === 'unauthorized') return { status: 'unauthorized' };
  if (row.status === 'not_found' || !row.orgId || !row.orgSlug) return { status: 'not_found' };

  const entitlements = await billing.entitlements(row.orgId);
  if (!entitledTo(entitlements, 'sign')) {
    return { status: 'not_found' };
  }

  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((s): s is SignApiKeyScope => zSignApiKeyScope.safeParse(s).success)
    : [];
  if (!scopes.includes(requiredScope)) {
    return { status: 'forbidden', requiredScope };
  }

  // Consume per-key budget only after authenticating and authorizing a real API key so unknown-key spray
  // cannot fill or starve RateLimiter's maxKeys bucket map.
  const decision = limitKey?.(keySha256);
  if (decision && !decision.allowed) {
    return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
  }

  return { status: 'ok', keySha256, orgId: row.orgId, orgSlug: row.orgSlug };
}

function parseLimitParam(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 50;
  if (!/^\d+$/.test(raw.trim())) {
    throw new DomainError('VALIDATION', 422, 'limit must be an integer between 1 and 100');
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new DomainError('VALIDATION', 422, 'limit must be an integer between 1 and 100');
  }
  return n;
}

export async function runSignApiV1EnvelopesList(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  query: { status?: string | undefined; limit?: string | undefined },
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<SignApiV1Outcome<{ items: unknown[] }>> {
  const auth = await authenticateApiKey(runtime, billing, authHeader, 'sign:read', limitKey, peekLimitKey);
  if (auth.status !== 'ok') return auth;

  let statusFilter: string | null = null;
  if (query.status !== undefined && query.status.trim() !== '') {
    const parsedStatus = zSignEnvelopeStatus.safeParse(query.status.trim());
    if (!parsedStatus.success) {
      throw new DomainError('VALIDATION', 422, 'Invalid envelope status filter');
    }
    statusFilter = parsedStatus.data;
  }
  const limit = parseLimitParam(query.limit);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ out: RawSqlActionResult }>`
      SELECT ludy_sign.api_key_envelopes_list(${auth.keySha256}, ${statusFilter}, ${limit}) AS out
    `.execute(db);
    return rows[0]?.out;
  });

  if (!res || res.status === 'unauthorized') return { status: 'unauthorized' };
  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'forbidden') return { status: 'forbidden', requiredScope: 'sign:read' };
  if (res.status === 'error') throwActionError(res);

  return { status: 'ok', data: { items: Array.isArray(res.items) ? res.items : [] } };
}

export async function runSignApiV1EnvelopeGet(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  envelopeId: string,
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<SignApiV1Outcome<{ envelope: Record<string, unknown> }>> {
  const auth = await authenticateApiKey(runtime, billing, authHeader, 'sign:read', limitKey, peekLimitKey);
  if (auth.status !== 'ok') return auth;
  if (!UUID_RE.test(envelopeId)) return { status: 'not_found' };

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ out: RawSqlActionResult }>`
      SELECT ludy_sign.api_key_envelope_get(${auth.keySha256}, ${envelopeId}::uuid) AS out
    `.execute(db);
    return rows[0]?.out;
  });

  if (!res || res.status === 'unauthorized') return { status: 'unauthorized' };
  if (res.status === 'not_found' || res.status === 'envelope_not_found') {
    return { status: 'not_found' };
  }
  if (res.status === 'forbidden') return { status: 'forbidden', requiredScope: 'sign:read' };
  if (res.status === 'error') throwActionError(res);
  if (!res.envelope) return { status: 'not_found' };

  return { status: 'ok', data: { envelope: res.envelope } };
}

export async function resolveSignApiV1FileSource(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  envelopeId: string,
  kind: 'sealed' | 'certificate',
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<SignApiV1Outcome<SignApiV1FileSource>> {
  const auth = await authenticateApiKey(runtime, billing, authHeader, 'sign:read', limitKey, peekLimitKey);
  if (auth.status !== 'ok') return auth;
  if (!UUID_RE.test(envelopeId)) return { status: 'not_found' };

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ out: RawSqlActionResult }>`
      SELECT ludy_sign.api_key_envelope_file_source(${auth.keySha256}, ${envelopeId}::uuid, ${kind}) AS out
    `.execute(db);
    return rows[0]?.out;
  });

  if (!res || res.status === 'unauthorized') return { status: 'unauthorized' };
  if (res.status === 'not_found' || res.status === 'envelope_not_found') return { status: 'not_found' };
  if (res.status === 'forbidden') return { status: 'forbidden', requiredScope: 'sign:read' };
  if (res.status === 'error') throwActionError(res);
  if (!res.storageKey || !res.sha256 || !res.envelopeId) return { status: 'not_found' };

  return {
    status: 'ok',
    data: {
      orgId: auth.orgId,
      envelopeId: res.envelopeId,
      certificateCode: res.certificateCode ?? null,
      storageKey: res.storageKey,
      generation: res.generation ?? null,
      sha256: res.sha256,
    },
  };
}

export async function readSignApiV1ArtifactBytes(
  store: BlobStore,
  source: SignApiV1FileSource,
): Promise<Uint8Array> {
  return readVerified(
    store,
    { key: source.storageKey, generation: source.generation, sha256: source.sha256 },
    SIGN_PDF_MAX_BYTES,
  );
}

export async function runSignApiV1TemplatesList(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  query: { limit?: string | undefined },
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<SignApiV1Outcome<{ items: unknown[] }>> {
  const auth = await authenticateApiKey(runtime, billing, authHeader, 'sign:read', limitKey, peekLimitKey);
  if (auth.status !== 'ok') return auth;
  const limit = parseLimitParam(query.limit);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ out: RawSqlActionResult }>`
      SELECT ludy_sign.api_key_templates_list(${auth.keySha256}, ${limit}) AS out
    `.execute(db);
    return rows[0]?.out;
  });

  if (!res || res.status === 'unauthorized') return { status: 'unauthorized' };
  if (res.status === 'not_found') return { status: 'not_found' };
  if (res.status === 'forbidden') return { status: 'forbidden', requiredScope: 'sign:read' };
  if (res.status === 'error') throwActionError(res);

  return { status: 'ok', data: { items: Array.isArray(res.items) ? res.items : [] } };
}

export async function runSignApiV1FromTemplate(
  runtime: Runtime,
  billing: SignBilling,
  authHeader: string | undefined,
  rawBody: unknown,
  baseAppUrl: string,
  meta: SignRequestMeta,
  limitKey?: SignTokenLimiterFn,
  peekLimitKey?: SignTokenLimiterFn,
): Promise<SignApiV1Outcome<{ id: string; status: 'draft'; reviewUrl: string }>> {
  const auth = await authenticateApiKey(runtime, billing, authHeader, 'sign:draft', limitKey, peekLimitKey);
  if (auth.status !== 'ok') return auth;

  const parsed = zSignApiV1FromTemplateInput.safeParse(rawBody);
  if (!parsed.success) {
    throw new DomainError('VALIDATION', 422, parsed.error.issues[0]?.message ?? 'Invalid request payload');
  }
  const input = parsed.data;
  if (input.textDefaults && Object.keys(input.textDefaults).length > 100) {
    throw new DomainError('VALIDATION', 422, 'textDefaults may contain at most 100 entries');
  }

  const ipHash = signIpHash(meta.ip);
  const userAgent = sanitizeSignUserAgent(meta.userAgent);

  const res = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ out: RawSqlActionResult }>`
      SELECT ludy_sign.api_key_create_draft_from_template(
        ${auth.keySha256}::text,
        ${input.templateId}::uuid,
        ${input.title ?? null}::text,
        ${input.subject ?? null}::text,
        ${input.message ?? null}::text,
        ${input.expiresAt ?? null}::timestamptz,
        ${input.allowDelegation ?? null}::boolean,
        ${JSON.stringify(input.recipients)}::jsonb,
        ${input.textDefaults ? JSON.stringify(input.textDefaults) : null}::jsonb,
        ${ipHash}::text,
        ${userAgent}::text
      ) AS out
    `.execute(db);
    return rows[0]?.out;
  });

  if (!res || res.status === 'unauthorized') return { status: 'unauthorized' };
  if (res.status === 'not_found' || res.status === 'template_not_found') {
    return { status: 'not_found' };
  }
  if (res.status === 'forbidden') return { status: 'forbidden', requiredScope: 'sign:draft' };
  if (res.status === 'error') throwActionError(res);
  if (!res.id) return { status: 'not_found' };

  const slug = res.orgSlug ?? auth.orgSlug;
  const cleanBase = baseAppUrl.replace(/\/+$/, '');
  const reviewUrl = `${cleanBase}/o/${encodeURIComponent(slug)}/sign/envelopes/${encodeURIComponent(res.id)}`;

  return {
    status: 'ok',
    data: {
      id: res.id,
      status: 'draft',
      reviewUrl,
    },
  };
}
