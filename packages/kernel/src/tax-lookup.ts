// SPDX-License-Identifier: AGPL-3.0-only
// Pluggable enterprise tax-code lookup (CRM plan section 10.1, #4988, TC1).
// Pure module: zero network or Node http imports so worker egress boundaries stay intact; callers inject guarded HTTP transport.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import {
  TAX_LOOKUP_PROVIDERS,
  normalizeTaxCode,
  zPartyTaxLookupSwitchInput,
  type PartyTaxLookupResult,
  type PartyTaxLookupSwitch,
  type TaxLookupProviderId,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

export const TAX_LOOKUP_TIMEOUT_MS = 5_000;
export const TAX_LOOKUP_MAX_BYTES = 64 * 1024;
export const TAX_LOOKUP_HIT_TTL_SECONDS = 24 * 60 * 60;
export const TAX_LOOKUP_MISS_TTL_SECONDS = 60 * 60;
export const TAX_LOOKUP_ORG_HOURLY_LIMIT = 30;
export const TAX_LOOKUP_ORG_DAILY_LIMIT = 200;
export const TAX_LOOKUP_MEMBER_PER_MINUTE_LIMIT = 10;
export const TAX_LOOKUP_BACKOFF_MS = 60_000;
export const TAX_LOOKUP_QUOTA_WARN_PERCENT = 80;

export const CASSO_API_HOST = 'openapi.casso.vn';
export const CASSO_TOKEN_URL = `https://${CASSO_API_HOST}/oauth/token`;
export const CASSO_BUSINESS_URL_PREFIX = `https://${CASSO_API_HOST}/idkit/v1/business/`;

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const DEFAULT_TOKEN_TTL_SECONDS = 900;
const QUOTA_WARN_COOLDOWN_MS = DAY_MS;

export interface TaxLookupResult {
  found: boolean;
  taxCode: string;
  name: string | null;
  address: string | null;
  statusText: string | null;
  source: string | null;
  household?: boolean;
  quotaUsedPercent?: number;
}

export interface TaxLookupProvider {
  readonly id: TaxLookupProviderId;
  lookup(code: string, signal?: AbortSignal): Promise<TaxLookupResult>;
}

export interface TaxLookupHttpRequestInput {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface TaxLookupHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type TaxLookupHttpRequest = (
  url: string,
  request: TaxLookupHttpRequestInput,
  signal?: AbortSignal,
) => Promise<TaxLookupHttpResponse>;

export type TaxLookupUpstreamErrorKind = 'rate_limited' | 'timeout' | 'egress_blocked' | 'unavailable';

export class TaxLookupUpstreamError extends Error {
  readonly kind: TaxLookupUpstreamErrorKind;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: TaxLookupUpstreamErrorKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'TaxLookupUpstreamError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const offTaxLookupProvider: TaxLookupProvider = {
  id: 'off',
  async lookup(): Promise<TaxLookupResult> {
    throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế');
  },
};

function stripDiacriticsLower(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const HOUSEHOLD_PATTERN = /(?:^|[\s,(/-])(?:ho kinh doanh|ho ca the|hkd|ho kd)(?:$|[\s,)/.-])/;
const HOUSEHOLD_TYPE_PATTERN = /(?:^|[\s,(/_-])(?:household|individual|sole[_ ]proprietorship|ho kinh doanh|ho ca the|hkd|ho kd)(?:$|[\s,)/_-])/;

/** Returns true when a lookup response represents an individual or household business (never cached). */
export function isHouseholdTaxLookupResult(result: {
  name?: string | null;
  statusText?: string | null;
  businessType?: string | null;
  household?: boolean;
}): boolean {
  if (result.household === true) return true;
  if (result.businessType && HOUSEHOLD_TYPE_PATTERN.test(stripDiacriticsLower(result.businessType))) return true;
  if (result.name && HOUSEHOLD_PATTERN.test(stripDiacriticsLower(result.name))) return true;
  if (result.statusText && HOUSEHOLD_PATTERN.test(stripDiacriticsLower(result.statusText))) return true;
  return false;
}

export interface TaxLookupRateLimits {
  orgPerHour?: number;
  orgPerDay?: number;
  memberPerMinute?: number;
  backoffMs?: number;
  maxKeys?: number;
  now?: () => number;
}

export type TaxLookupAcquireResult =
  | { ok: true; orgDailyCount: number; orgDailyLimit: number }
  | { ok: false; scope: 'backoff' | 'member' | 'org_hour' | 'org_day'; retryAfterSeconds: number };

/** Sliding-window limiter for org hourly/daily caps, member burst cap, and deployment 429 backoff. */
export class TaxLookupLimiter {
  readonly orgPerHour: number;
  readonly orgPerDay: number;
  readonly memberPerMinute: number;
  readonly backoffMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly orgHits = new Map<string, number[]>();
  private readonly memberHits = new Map<string, number[]>();
  private readonly quotaWarnedAt = new Map<string, number>();
  private backoffUntilMs = 0;

  constructor(options: TaxLookupRateLimits = {}) {
    this.orgPerHour = options.orgPerHour ?? TAX_LOOKUP_ORG_HOURLY_LIMIT;
    this.orgPerDay = options.orgPerDay ?? TAX_LOOKUP_ORG_DAILY_LIMIT;
    this.memberPerMinute = options.memberPerMinute ?? TAX_LOOKUP_MEMBER_PER_MINUTE_LIMIT;
    this.backoffMs = options.backoffMs ?? TAX_LOOKUP_BACKOFF_MS;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  isBackedOff(): { backedOff: true; retryAfterSeconds: number } | { backedOff: false } {
    const now = this.now();
    if (now < this.backoffUntilMs) {
      return { backedOff: true, retryAfterSeconds: Math.max(1, Math.ceil((this.backoffUntilMs - now) / 1000)) };
    }
    return { backedOff: false };
  }

  triggerBackoff(overrideMs?: number): void {
    const now = this.now();
    const duration = Math.min(Math.max(overrideMs ?? this.backoffMs, 1_000), 300_000);
    this.backoffUntilMs = Math.max(this.backoffUntilMs, now + duration);
  }

  tryAcquire(orgId: string, userId: string): TaxLookupAcquireResult {
    const now = this.now();
    if (now < this.backoffUntilMs) {
      return { ok: false, scope: 'backoff', retryAfterSeconds: Math.max(1, Math.ceil((this.backoffUntilMs - now) / 1000)) };
    }

    const memberKey = `${orgId}:${userId}`;
    const memberWindow = this.pruneWindow(this.memberHits, memberKey, now - MINUTE_MS);
    if (memberWindow.length >= this.memberPerMinute) {
      const oldest = memberWindow[0] ?? now;
      return { ok: false, scope: 'member', retryAfterSeconds: Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000)) };
    }

    const orgWindow = this.pruneWindow(this.orgHits, orgId, now - DAY_MS);
    const hourCutoff = now - HOUR_MS;
    const hourStartIdx = orgWindow.findIndex((ts) => ts > hourCutoff);
    const hourCount = hourStartIdx === -1 ? 0 : orgWindow.length - hourStartIdx;
    if (hourCount >= this.orgPerHour) {
      const oldestHour = orgWindow[hourStartIdx] ?? now;
      return { ok: false, scope: 'org_hour', retryAfterSeconds: Math.max(1, Math.ceil((oldestHour + HOUR_MS - now) / 1000)) };
    }

    if (orgWindow.length >= this.orgPerDay) {
      const oldestDay = orgWindow[0] ?? now;
      return { ok: false, scope: 'org_day', retryAfterSeconds: Math.max(1, Math.ceil((oldestDay + DAY_MS - now) / 1000)) };
    }

    this.recordHit(this.memberHits, memberKey, memberWindow, now);
    this.recordHit(this.orgHits, orgId, orgWindow, now);
    return { ok: true, orgDailyCount: orgWindow.length, orgDailyLimit: this.orgPerDay };
  }

  shouldEmitQuotaWarning(orgId: string): boolean {
    const now = this.now();
    const last = this.quotaWarnedAt.get(orgId);
    if (last !== undefined && now - last < QUOTA_WARN_COOLDOWN_MS) return false;
    if (this.quotaWarnedAt.size >= this.maxKeys) this.evictStaleQuotaWarnings(now);
    this.quotaWarnedAt.set(orgId, now);
    return true;
  }

  private pruneWindow(store: Map<string, number[]>, key: string, cutoff: number): number[] {
    const list = store.get(key);
    if (!list) return [];
    let keepFrom = 0;
    while (keepFrom < list.length && (list[keepFrom] ?? 0) <= cutoff) keepFrom++;
    if (keepFrom === 0) return list;
    const trimmed = list.slice(keepFrom);
    if (trimmed.length === 0) store.delete(key);
    else store.set(key, trimmed);
    return trimmed;
  }

  private recordHit(store: Map<string, number[]>, key: string, list: number[], now: number): void {
    if (!store.has(key) && store.size >= this.maxKeys) {
      const firstKey = store.keys().next().value;
      if (firstKey !== undefined) store.delete(firstKey);
    }
    list.push(now);
    store.set(key, list);
  }

  private evictStaleQuotaWarnings(now: number): void {
    for (const [k, ts] of this.quotaWarnedAt) {
      if (now - ts >= QUOTA_WARN_COOLDOWN_MS) this.quotaWarnedAt.delete(k);
    }
    if (this.quotaWarnedAt.size >= this.maxKeys) {
      const firstKey = this.quotaWarnedAt.keys().next().value;
      if (firstKey !== undefined) this.quotaWarnedAt.delete(firstKey);
    }
  }
}

export interface CassoTaxLookupOptions {
  appId: string;
  appSecret: string;
  request: TaxLookupHttpRequest;
  timeoutMs?: number;
  now?: () => number;
}

function cleanText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  let stripped = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    stripped += cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) ? ' ' : ch;
  }
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after') {
      const n = Number.parseInt(v.trim(), 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 300);
    }
  }
  return undefined;
}

function parseQuotaPercent(headers: Record<string, string> | undefined, root: Record<string, unknown> | null): number | undefined {
  const lower = new Map<string, string>();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v);
  }
  for (const percentKey of ['x-ratelimit-used-percent', 'x-quota-used-percent'] as const) {
    const raw = lower.get(percentKey);
    if (raw !== undefined) {
      const pct = Number(raw);
      if (Number.isFinite(pct) && pct >= 0) return Math.min(100, Math.round(pct));
    }
  }
  for (const [limitKey, remainingKey] of [
    ['x-quota-limit', 'x-quota-remaining'],
    ['x-ratelimit-limit', 'x-ratelimit-remaining'],
  ] as const) {
    const limit = Number(lower.get(limitKey));
    const remaining = Number(lower.get(remainingKey));
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0) {
      return Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100)));
    }
  }
  const quotaObj = asRecord(root?.quota);
  if (quotaObj) {
    const used = Number(quotaObj.used);
    const limit = Number(quotaObj.limit);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used >= 0) {
      return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
    }
  }
  return undefined;
}

function ensureNoRedirect(res: TaxLookupHttpResponse): void {
  if (res.status >= 300 && res.status < 400) {
    throw new TaxLookupUpstreamError('egress_blocked', `tax lookup provider returned disallowed redirect (${res.status})`);
  }
}

export function createCassoTaxLookupProvider(options: CassoTaxLookupOptions): TaxLookupProvider {
  const appId = options.appId.trim();
  const appSecret = options.appSecret.trim();
  if (!appId || !appSecret) throw new Error('Casso tax lookup requires appId and appSecret');
  if (appId.startsWith('trial-app_')) {
    throw new Error('Casso Public Starter Key is not permitted; bring deployment-owned Casso credentials');
  }
  const timeoutMs = options.timeoutMs ?? TAX_LOOKUP_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let cachedToken: { token: string; expiresAtMs: number } | null = null;
  let inFlightToken: Promise<string> | null = null;

  async function fetchToken(deadlineAt: number): Promise<string> {
    if (cachedToken && now() < cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
      return cachedToken.token;
    }
    if (!inFlightToken) {
      inFlightToken = (async () => {
        const remaining = Math.max(1, deadlineAt - now());
        const res = await options.request(
          CASSO_TOKEN_URL,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
            timeoutMs: remaining,
            maxBytes: TAX_LOOKUP_MAX_BYTES,
          },
        );
        ensureNoRedirect(res);
        if (res.status === 429) {
          throw new TaxLookupUpstreamError('rate_limited', 'Casso OAuth token rate limited', parseRetryAfter(res.headers));
        }
        if (res.status < 200 || res.status >= 300) {
          throw new TaxLookupUpstreamError('unavailable', `Casso OAuth token failed with HTTP ${res.status}`);
        }
        let json: Record<string, unknown> | null;
        try {
          json = asRecord(parseJsonBytes(res.body));
        } catch {
          throw new TaxLookupUpstreamError('unavailable', 'Casso OAuth token returned invalid JSON');
        }
        const token = typeof json?.access_token === 'string' ? json.access_token.trim() : '';
        if (!token) throw new TaxLookupUpstreamError('unavailable', 'Casso OAuth token response missing access_token');
        const expiresInRaw = Number(json?.expires_in);
        const expiresInSec = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : DEFAULT_TOKEN_TTL_SECONDS;
        cachedToken = { token, expiresAtMs: now() + expiresInSec * 1000 };
        return token;
      })().finally(() => {
        inFlightToken = null;
      });
    }
    return inFlightToken;
  }

  async function fetchBusiness(code: string, token: string, remainingMs: number, signal?: AbortSignal): Promise<TaxLookupHttpResponse> {
    return options.request(
      `${CASSO_BUSINESS_URL_PREFIX}${encodeURIComponent(code)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        timeoutMs: Math.max(1, remainingMs),
        maxBytes: TAX_LOOKUP_MAX_BYTES,
      },
      signal,
    );
  }

  return {
    id: 'casso',
    async lookup(code: string, signal?: AbortSignal): Promise<TaxLookupResult> {
      const normalized = normalizeTaxCode(code);
      if (!normalized) {
        throw new DomainError(
          'INVALID_TAX_CODE',
          422,
          'Mã số thuế không hợp lệ: cần 10 chữ số hoặc 10 chữ số kèm 3 chữ số đơn vị phụ thuộc',
        );
      }
      if (/^\d{12}$/.test(normalized)) {
        throw new DomainError('CITIZEN_ID_NOT_ALLOWED', 422, 'Không tra cứu mã định danh cá nhân 12 chữ số');
      }
      const deadlineAt = now() + timeoutMs;
      let token = await fetchToken(deadlineAt);
      if (signal?.aborted) {
        throw new TaxLookupUpstreamError('timeout', 'Tax lookup aborted before business lookup');
      }
      let res = await fetchBusiness(normalized, token, deadlineAt - now(), signal);
      ensureNoRedirect(res);

      if (res.status === 401 && deadlineAt - now() > 50) {
        if (cachedToken?.token === token) cachedToken = null;
        token = await fetchToken(deadlineAt);
        if (signal?.aborted) {
          throw new TaxLookupUpstreamError('timeout', 'Tax lookup aborted before retry');
        }
        res = await fetchBusiness(normalized, token, deadlineAt - now(), signal);
        ensureNoRedirect(res);
      }

      if (res.status === 429) {
        throw new TaxLookupUpstreamError('rate_limited', 'Casso IDKit rate limited', parseRetryAfter(res.headers));
      }
      if (res.status === 404) {
        const quotaUsedPercent = parseQuotaPercent(res.headers, null);
        return {
          found: false,
          taxCode: normalized,
          name: null,
          address: null,
          statusText: null,
          source: 'casso',
          ...(quotaUsedPercent !== undefined ? { quotaUsedPercent } : {}),
        };
      }
      if (res.status < 200 || res.status >= 300) {
        throw new TaxLookupUpstreamError('unavailable', `Casso IDKit lookup failed with HTTP ${res.status}`);
      }

      let root: Record<string, unknown> | null;
      try {
        root = asRecord(parseJsonBytes(res.body));
      } catch {
        throw new TaxLookupUpstreamError('unavailable', 'Casso IDKit lookup returned invalid JSON');
      }

      const payload = asRecord(root?.business) ?? asRecord(root?.data) ?? root;
      const quotaUsedPercent = parseQuotaPercent(res.headers, root);
      if (!payload) {
        return {
          found: false,
          taxCode: normalized,
          name: null,
          address: null,
          statusText: null,
          source: 'casso',
          ...(quotaUsedPercent !== undefined ? { quotaUsedPercent } : {}),
        };
      }

      const name = cleanText(payload.name ?? payload.companyName ?? payload.tenChinhThuc, 500);
      const address = cleanText(payload.address ?? payload.diaChi, 1000);
      const statusText = cleanText(payload.status ?? payload.statusText ?? payload.trangThai, 200);
      const source = cleanText(payload.source, 40) ?? 'casso';
      const businessType = cleanText(payload.type ?? payload.businessType ?? payload.legalForm, 100);
      const household = isHouseholdTaxLookupResult({ name, statusText, businessType });

      if (!name) {
        return {
          found: false,
          taxCode: normalized,
          name: null,
          address: null,
          statusText: null,
          source,
          ...(quotaUsedPercent !== undefined ? { quotaUsedPercent } : {}),
        };
      }

      return {
        found: true,
        taxCode: normalized,
        name,
        address,
        statusText,
        source,
        household,
        ...(quotaUsedPercent !== undefined ? { quotaUsedPercent } : {}),
      };
    },
  };
}

function userOf(actor: CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tra cứu được mã số thuế');
  return actor.userId;
}

/** Returns true when a normalized tax code is an enterprise 10-digit or 10-3 branch code (never 12-digit citizen ID). */
export function isEnterpriseTaxCode(normalized: string | null): normalized is string {
  return normalized !== null && /^\d{10}(-\d{3})?$/.test(normalized);
}

function normalizeLookupTaxCode(raw: string): string {
  const normalized = normalizeTaxCode(raw);
  if (!normalized) {
    throw new DomainError(
      'INVALID_TAX_CODE',
      422,
      'Mã số thuế không hợp lệ: cần 10 chữ số hoặc 10 chữ số kèm 3 chữ số đơn vị phụ thuộc',
    );
  }
  if (/^\d{12}$/.test(normalized)) {
    throw new DomainError(
      'CITIZEN_ID_NOT_ALLOWED',
      422,
      'Không tra cứu mã định danh cá nhân 12 chữ số qua dịch vụ tra cứu mã số thuế',
    );
  }
  return normalized;
}

export interface CachedTaxLookupEntry {
  found: boolean;
  taxCode: string;
  name: string | null;
  address: string | null;
  statusText: string | null;
  source: string | null;
}

/** Reads non-expired, non-household cache entries for an org's enterprise tax codes inside an existing transaction. */
export async function readTaxLookupCacheBatch(
  trx: QueryContext['trx'],
  orgId: string,
  taxCodes: readonly string[],
): Promise<Map<string, CachedTaxLookupEntry>> {
  const unique = [...new Set(taxCodes.map((c) => normalizeTaxCode(c)).filter(isEnterpriseTaxCode))];
  if (unique.length === 0) return new Map();
  const rows = await trx
    .selectFrom('ludy_kernel.tax_lookup_cache')
    .select(['tax_code', 'found', 'name', 'address', 'status_text', 'source'])
    .where('org_id', '=', orgId)
    .where('tax_code', 'in', unique)
    .where(sql<boolean>`expires_at > pg_catalog.now()`)
    .execute();
  const out = new Map<string, CachedTaxLookupEntry>();
  for (const r of rows) {
    if (isHouseholdTaxLookupResult({ name: r.name, statusText: r.status_text })) continue;
    out.set(r.tax_code, {
      found: r.found,
      taxCode: r.tax_code,
      name: r.found ? r.name : null,
      address: r.found ? r.address : null,
      statusText: r.found ? r.status_text : null,
      source: r.source,
    });
  }
  return out;
}

/** Reads whether the org enabled external tax-code lookup (default false). */
export async function readTaxLookupSwitch(trx: QueryContext['trx'], orgId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('ludy_kernel.tenant')
    .select('tax_lookup_enabled')
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  return row?.tax_lookup_enabled === true;
}

export const taxLookupSwitchGet = defineQuery({
  name: 'kernel.party.tax_lookup_switch.get',
  input: z.strictObject({}),
  access: WRITERS,
  handler: async (ctx): Promise<PartyTaxLookupSwitch> => ({
    enabled: await readTaxLookupSwitch(ctx.trx, ctx.orgId),
  }),
});

export const taxLookupSwitchSet = defineCommand({
  name: 'kernel.party.tax_lookup_switch.set',
  input: zPartyTaxLookupSwitchInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<PartyTaxLookupSwitch> => {
    userOf(ctx.actor);
    const previous = await readTaxLookupSwitch(ctx.trx, ctx.orgId);
    await ctx.trx
      .updateTable('ludy_kernel.tenant')
      .set({ tax_lookup_enabled: input.enabled })
      .where('org_id', '=', ctx.orgId)
      .execute();
    ctx.audit({ enabled: input.enabled, previous });
    return { enabled: input.enabled };
  },
});

export interface PartyTaxLookupOptions {
  provider?: TaxLookupProvider;
  limiter?: TaxLookupLimiter;
  onQuotaWarning?: (info: { orgId: string; provider: TaxLookupProviderId; usedPercent: number }) => void;
}

export type PartyTaxLookupPrepareResult =
  | {
      status: 'hit';
      normalized: string;
      codeKind: 'enterprise_10' | 'branch_13';
      result: {
        found: boolean;
        taxCode: string;
        name: string | null;
        address: string | null;
        statusText: string | null;
        source: string | null;
      };
    }
  | {
      status: 'miss';
      normalized: string;
      codeKind: 'enterprise_10' | 'branch_13';
    };

const zPartyTaxLookupPrepareInput = z.strictObject({
  taxCode: z.string().trim().max(40),
  deploymentEnabled: z.boolean().optional(),
});

/**
 * Step 1 of TC1 (#4988): short read-only transaction (no network I/O) verifying actor/role,
 * tax-code format, 12-digit citizen ID refusal, deployment & org toggles, and fresh org cache.
 */
export const partyTaxLookupPrepare = defineQuery({
  name: 'kernel.party.tax_lookup_prepare',
  input: zPartyTaxLookupPrepareInput,
  access: WRITERS,
  handler: async (ctx, input): Promise<PartyTaxLookupPrepareResult> => {
    userOf(ctx.actor);
    const normalized = normalizeLookupTaxCode(input.taxCode);
    if (input.deploymentEnabled === false) {
      throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế');
    }
    const orgEnabled = await readTaxLookupSwitch(ctx.trx, ctx.orgId);
    if (!orgEnabled) {
      throw new DomainError(
        'TAX_LOOKUP_ORG_DISABLED',
        409,
        'Tổ chức chưa bật tra cứu mã số thuế; bật công tắc đồng nghĩa cho phép gửi mã số thuế tới nhà cung cấp',
      );
    }

    const codeKind = normalized.length === 10 ? 'enterprise_10' : 'branch_13';
    const cachedMap = await readTaxLookupCacheBatch(ctx.trx, ctx.orgId, [normalized]);
    const cachedHit = cachedMap.get(normalized);
    if (cachedHit) {
      return {
        status: 'hit',
        normalized,
        codeKind,
        result: cachedHit,
      };
    }

    return {
      status: 'miss',
      normalized,
      codeKind,
    };
  },
});

const zPartyTaxLookupMissPayload = z.strictObject({
  taxCode: z.string().trim().max(40),
  found: z.boolean(),
  name: z.string().max(4000).nullable(),
  address: z.string().max(4000).nullable(),
  statusText: z.string().max(1000).nullable(),
  source: z.string().max(200).nullable(),
  household: z.boolean(),
});

const zPartyTaxLookupRecordInput = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('hit'),
    taxCode: z.string().trim().max(40),
    provider: z.enum(TAX_LOOKUP_PROVIDERS),
  }),
  z.strictObject({
    mode: z.literal('miss'),
    taxCode: z.string().trim().max(40),
    provider: z.enum(TAX_LOOKUP_PROVIDERS),
    found: z.boolean(),
    name: z.string().max(4000).nullable(),
    address: z.string().max(4000).nullable(),
    statusText: z.string().max(1000).nullable(),
    source: z.string().max(200).nullable(),
    household: z.boolean(),
    quotaWarning: z.boolean().optional(),
  }),
]);

async function writeTaxLookupCacheMiss(
  trx: CommandContext['trx'],
  orgId: string,
  normalized: string,
  provider: TaxLookupProviderId,
  input: z.infer<typeof zPartyTaxLookupMissPayload>,
): Promise<{
  found: boolean;
  name: string | null;
  address: string | null;
  statusText: string | null;
  source: string;
  household: boolean;
}> {
  const companyName = input.found ? cleanText(input.name, 500) : null;
  const companyAddress = input.found ? cleanText(input.address, 1000) : null;
  const statusText = input.found ? cleanText(input.statusText, 200) : null;
  const source = cleanText(input.source ?? provider, 40) ?? provider;
  const household = Boolean(input.household) || isHouseholdTaxLookupResult({ name: companyName, statusText });
  const found = input.found && companyName !== null;

  if (household) {
    await trx
      .deleteFrom('ludy_kernel.tax_lookup_cache')
      .where('org_id', '=', orgId)
      .where('tax_code', '=', normalized)
      .execute();
  } else {
    const ttlSeconds = found ? TAX_LOOKUP_HIT_TTL_SECONDS : TAX_LOOKUP_MISS_TTL_SECONDS;
    const ttlInterval = sql<Date>`pg_catalog.now() + pg_catalog.make_interval(secs => ${ttlSeconds}::int)`;
    await trx
      .insertInto('ludy_kernel.tax_lookup_cache')
      .values({
        org_id: orgId,
        tax_code: normalized,
        found,
        name: found ? companyName : null,
        address: found ? companyAddress : null,
        status_text: found ? statusText : null,
        source,
        fetched_at: sql<Date>`pg_catalog.now()`,
        expires_at: ttlInterval,
        updated_at: sql<Date>`pg_catalog.now()`,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'tax_code']).doUpdateSet({
          found,
          name: found ? companyName : null,
          address: found ? companyAddress : null,
          status_text: found ? statusText : null,
          source,
          fetched_at: sql<Date>`pg_catalog.now()`,
          expires_at: ttlInterval,
          updated_at: sql<Date>`pg_catalog.now()`,
        }),
      )
      .execute();
  }

  return {
    found,
    name: found ? companyName : null,
    address: found ? companyAddress : null,
    statusText: found ? statusText : null,
    source,
    household,
  };
}

/**
 * Step 3 of TC1 (#4988): short write + metadata-only audit transaction after out-of-transaction lookup.
 * Re-verifies actor/role, code format, deployment provider, and org switch; deletes household rows or upserts 24h/1h org cache.
 */
export const partyTaxLookup = defineCommand({
  name: 'kernel.party.tax_lookup',
  input: zPartyTaxLookupRecordInput,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  handler: async (ctx, input): Promise<PartyTaxLookupResult> => {
    userOf(ctx.actor);
    const normalized = normalizeLookupTaxCode(input.taxCode);
    if (input.provider === 'off') {
      throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế');
    }
    const orgEnabled = await readTaxLookupSwitch(ctx.trx, ctx.orgId);
    if (!orgEnabled) {
      throw new DomainError(
        'TAX_LOOKUP_ORG_DISABLED',
        409,
        'Tổ chức chưa bật tra cứu mã số thuế; bật công tắc đồng nghĩa cho phép gửi mã số thuế tới nhà cung cấp',
      );
    }

    const codeKind = normalized.length === 10 ? 'enterprise_10' : 'branch_13';

    if (input.mode === 'hit') {
      const cachedRow = await ctx.trx
        .selectFrom('ludy_kernel.tax_lookup_cache')
        .select(['tax_code', 'found', 'name', 'address', 'status_text', 'source'])
        .where('org_id', '=', ctx.orgId)
        .where('tax_code', '=', normalized)
        .where(sql<boolean>`expires_at > pg_catalog.now() - interval '10 seconds'`)
        .executeTakeFirst();

      if (!cachedRow) {
        throw new DomainError(
          'TAX_LOOKUP_UNAVAILABLE',
          503,
          'Tạm thời không tra được mã số thuế, hãy nhập thủ công hoặc thử lại sau',
        );
      }
      if (isHouseholdTaxLookupResult({ name: cachedRow.name, statusText: cachedRow.status_text })) {
        await ctx.trx
          .deleteFrom('ludy_kernel.tax_lookup_cache')
          .where('org_id', '=', ctx.orgId)
          .where('tax_code', '=', normalized)
          .execute();
        throw new DomainError(
          'TAX_LOOKUP_UNAVAILABLE',
          503,
          'Tạm thời không tra được mã số thuế, hãy nhập thủ công hoặc thử lại sau',
        );
      }

      if (cachedRow.found) {
        ctx.audit({
          provider: input.provider,
          codeKind,
          found: true,
          cached: true,
          household: false,
          quotaWarning: false,
        });
      } else {
        ctx.audit({
          provider: input.provider,
          codeKind,
          found: false,
          cached: true,
          household: false,
          quotaWarning: false,
        });
      }

      return {
        found: cachedRow.found,
        taxCode: cachedRow.tax_code,
        name: cachedRow.found ? cachedRow.name : null,
        address: cachedRow.found ? cachedRow.address : null,
        statusText: cachedRow.found ? cachedRow.status_text : null,
        source: cachedRow.source,
        cached: true,
        household: false,
      };
    }

    const written = await writeTaxLookupCacheMiss(ctx.trx, ctx.orgId, normalized, input.provider, input);

    ctx.audit({
      provider: input.provider,
      codeKind,
      found: written.found,
      cached: false,
      household: written.household,
      quotaWarning: input.quotaWarning ? true : false,
    });

    return {
      found: written.found,
      taxCode: normalized,
      name: written.name,
      address: written.address,
      statusText: written.statusText,
      source: written.source,
      cached: false,
      household: written.household,
      ...(input.quotaWarning ? { quotaWarning: true } : {}),
    };
  },
});

const zPartyTaxLookupBatchInput = z.strictObject({
  provider: z.enum(TAX_LOOKUP_PROVIDERS),
  hits: z.array(z.string().trim().max(40)).max(100),
  misses: z.array(zPartyTaxLookupMissPayload).max(100),
  quotaWarning: z.boolean().optional(),
});

/**
 * Step 3 of TC3 (#4990): short batch write + metadata-only audit transaction after out-of-transaction batch lookups.
 * Stores 24h/1h org cache entries (never household) and audits counts only.
 */
export const partyTaxLookupBatch = defineCommand({
  name: 'kernel.party.tax_lookup_batch',
  input: zPartyTaxLookupBatchInput,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ hitCount: number; missCount: number }> => {
    userOf(ctx.actor);
    if (input.provider === 'off') {
      throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế');
    }
    const orgEnabled = await readTaxLookupSwitch(ctx.trx, ctx.orgId);
    if (!orgEnabled) {
      throw new DomainError(
        'TAX_LOOKUP_ORG_DISABLED',
        409,
        'Tổ chức chưa bật tra cứu mã số thuế; bật công tắc đồng nghĩa cho phép gửi mã số thuế tới nhà cung cấp',
      );
    }

    const hits = input.hits.map(normalizeLookupTaxCode);
    let foundCount = 0;
    let householdCount = 0;
    for (const miss of input.misses) {
      const normalized = normalizeLookupTaxCode(miss.taxCode);
      const written = await writeTaxLookupCacheMiss(ctx.trx, ctx.orgId, normalized, input.provider, miss);
      if (written.found) foundCount += 1;
      if (written.household) householdCount += 1;
    }

    ctx.audit({
      provider: input.provider,
      hitCount: hits.length,
      missCount: input.misses.length,
      foundCount,
      householdCount,
      quotaWarning: input.quotaWarning ? true : false,
    });

    return { hitCount: hits.length, missCount: input.misses.length };
  },
});

export const taxLookupCommands = [taxLookupSwitchSet, partyTaxLookup, partyTaxLookupBatch];
export const taxLookupQueries = [taxLookupSwitchGet, partyTaxLookupPrepare];
