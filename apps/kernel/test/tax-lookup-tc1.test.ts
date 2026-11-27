// SPDX-License-Identifier: AGPL-3.0-only
// Pluggable party tax-code lookup (issue #4988, TC1): config validation, Casso Open Platform IDKit
// client + single-flight OAuth token refresh, guardedRequest egress guard (httpsOnly, openapi.casso.vn
// hostAllowlist, maxRedirects: 0, 5s combined timeout, 64 KB cap, SSRF IP block), household detection,
// and sliding-window rate limits + 429 backoff + 80% quota warning.
import { describe, expect, it } from 'vitest';
import {
  CASSO_API_HOST,
  CASSO_BUSINESS_URL_PREFIX,
  CASSO_TOKEN_URL,
  TAX_LOOKUP_BACKOFF_MS,
  TAX_LOOKUP_HIT_TTL_SECONDS,
  TAX_LOOKUP_MAX_BYTES,
  TAX_LOOKUP_MEMBER_PER_MINUTE_LIMIT,
  TAX_LOOKUP_MISS_TTL_SECONDS,
  TAX_LOOKUP_ORG_DAILY_LIMIT,
  TAX_LOOKUP_ORG_HOURLY_LIMIT,
  TAX_LOOKUP_QUOTA_WARN_PERCENT,
  TAX_LOOKUP_TIMEOUT_MS,
  TaxLookupLimiter,
  TaxLookupUpstreamError,
  createCassoTaxLookupProvider,
  isHouseholdTaxLookupResult,
  offTaxLookupProvider,
  partyTaxLookup,
  partyTaxLookupPrepare,
} from '@ludy/kernel';
import {
  DomainError,
  EgressError,
  type CommandContext,
  type EgressOptions,
  type EgressResponse,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createGuardedCassoTaxLookupProvider, createGuardedTaxLookupRequest } from '../src/tax-lookup-casso.ts';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/ludy',
  AUTH_JWT_SECRET: 'test-only-jwt-secret-for-tax-lookup-tc1-0123456789',
  AUTH_ISSUER: 'ludy-auth',
};

function jsonResponse(
  url: string,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): EgressResponse & { headers: Record<string, string> } {
  return {
    url,
    status,
    contentType: 'application/json',
    headers: headers ?? {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    truncated: false,
  };
}

describe('TC1 config defaults and Casso credentials (#4988)', () => {
  it('defaults TAX_LOOKUP_PROVIDER to off and preserves TAX_CODE_LOOKUP_URL (#324)', () => {
    const offByDefault = loadConfig(BASE_ENV);
    expect(offByDefault.TAX_LOOKUP_PROVIDER).toBe('off');
    expect(offByDefault.CASSO_CLIENT_ID).toBeUndefined();
    expect(offByDefault.CASSO_CLIENT_SECRET).toBeUndefined();

    const onboardingPreserved = loadConfig({
      ...BASE_ENV,
      TAX_CODE_LOOKUP_URL: 'https://tax.example.vn/lookup/{taxCode}',
    });
    expect(onboardingPreserved.TAX_LOOKUP_PROVIDER).toBe('off');
    expect(onboardingPreserved.TAX_CODE_LOOKUP_URL).toBe('https://tax.example.vn/lookup/{taxCode}');

    const withCasso = loadConfig({
      ...BASE_ENV,
      TAX_LOOKUP_PROVIDER: 'casso',
      CASSO_CLIENT_ID: 'casso-prod-app',
      CASSO_CLIENT_SECRET: 'casso-prod-secret',
    });
    expect(withCasso.TAX_LOOKUP_PROVIDER).toBe('casso');
    expect(withCasso.CASSO_CLIENT_ID).toBe('casso-prod-app');
    expect(withCasso.CASSO_CLIENT_SECRET).toBe('casso-prod-secret');
  });

  it('rejects half-set Casso credentials, Public Starter Key, and casso provider without creds', () => {
    expect(() => loadConfig({ ...BASE_ENV, CASSO_CLIENT_ID: 'only-id' })).toThrow(/CASSO_CLIENT_ID.*CASSO_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE_ENV, CASSO_CLIENT_SECRET: 'only-secret' })).toThrow(/CASSO_CLIENT_ID.*CASSO_CLIENT_SECRET/);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        TAX_LOOKUP_PROVIDER: 'casso',
        CASSO_CLIENT_ID: 'trial-app_public_starter',
        CASSO_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/Public Starter Key/);
    expect(() => loadConfig({ ...BASE_ENV, TAX_LOOKUP_PROVIDER: 'casso' })).toThrow(/TAX_LOOKUP_PROVIDER=casso/);
  });

  it('uses documented constants for timeouts, payload caps, TTLs, and rate limits', () => {
    expect(CASSO_API_HOST).toBe('openapi.casso.vn');
    expect(CASSO_TOKEN_URL).toBe('https://openapi.casso.vn/oauth/token');
    expect(CASSO_BUSINESS_URL_PREFIX).toBe('https://openapi.casso.vn/idkit/v1/business/');
    expect(TAX_LOOKUP_TIMEOUT_MS).toBe(5_000);
    expect(TAX_LOOKUP_MAX_BYTES).toBe(64 * 1024);
    expect(TAX_LOOKUP_HIT_TTL_SECONDS).toBe(24 * 60 * 60);
    expect(TAX_LOOKUP_MISS_TTL_SECONDS).toBe(60 * 60);
    expect(TAX_LOOKUP_ORG_HOURLY_LIMIT).toBe(30);
    expect(TAX_LOOKUP_ORG_DAILY_LIMIT).toBe(200);
    expect(TAX_LOOKUP_MEMBER_PER_MINUTE_LIMIT).toBe(10);
    expect(TAX_LOOKUP_BACKOFF_MS).toBe(60_000);
    expect(TAX_LOOKUP_QUOTA_WARN_PERCENT).toBe(80);
  });
});

describe('TC1 guardedRequest egress enforcement (#4988)', () => {
  it('enforces httpsOnly, maxRedirects=0, hostAllowed(openapi.casso.vn), 5s timeout, and 64 KB overLimit=fail', async () => {
    const seen: EgressOptions[] = [];
    const req = createGuardedTaxLookupRequest({
      requestImpl: async (url, _init, options) => {
        seen.push(options);
        return jsonResponse(url, 200, { ok: true });
      },
    });

    await req(CASSO_TOKEN_URL, { method: 'POST', timeoutMs: 99_999, maxBytes: 999_999 });
    expect(seen).toHaveLength(1);
    const opts = seen[0]!;
    expect(opts.httpsOnly).toBe(true);
    expect(opts.maxRedirects).toBe(0);
    expect(opts.overLimit).toBe('fail');
    expect(opts.timeoutMs).toBe(TAX_LOOKUP_TIMEOUT_MS);
    expect(opts.maxBytes).toBe(TAX_LOOKUP_MAX_BYTES);
    expect(opts.hostAllowed?.('openapi.casso.vn')).toBe(true);
    expect(opts.hostAllowed?.('evil.example')).toBe(false);
    expect(opts.hostAllowed?.('openapi.casso.vn.evil.com')).toBe(false);
  });

  it('blocks private, loopback, metadata IPs, plain http, and disallowed hosts through real guardedRequest', async () => {
    for (const privateIp of ['127.0.0.1', '10.0.0.1', '169.254.169.254']) {
      const req = createGuardedTaxLookupRequest({
        resolve: async () => [{ address: privateIp, family: 4 }],
      });
      await expect(
        req(`${CASSO_BUSINESS_URL_PREFIX}0101234564`, { method: 'GET', timeoutMs: 1000, maxBytes: 4096 }),
        privateIp,
      ).rejects.toMatchObject({ name: 'TaxLookupUpstreamError', kind: 'egress_blocked' });
    }

    let dnsCalls = 0;
    const realGuard = createGuardedTaxLookupRequest({
      resolve: async () => {
        dnsCalls += 1;
        return [{ address: '1.1.1.1', family: 4 }];
      },
    });
    await expect(
      realGuard('http://openapi.casso.vn/idkit/v1/business/0101234564', { method: 'GET', timeoutMs: 1000, maxBytes: 4096 }),
    ).rejects.toMatchObject({ name: 'TaxLookupUpstreamError', kind: 'egress_blocked' });
    await expect(
      realGuard('https://evil.example/idkit/v1/business/0101234564', { method: 'GET', timeoutMs: 1000, maxBytes: 4096 }),
    ).rejects.toMatchObject({ name: 'TaxLookupUpstreamError', kind: 'egress_blocked' });
    expect(dnsCalls).toBe(0);
  });

  it('maps EgressError timeout, too_large, blocked, and 3xx redirects to TaxLookupUpstreamError', async () => {
    const cases: Array<[EgressError, TaxLookupUpstreamError['kind']]> = [
      [new EgressError('timeout', 'deadline hit'), 'timeout'],
      [new EgressError('too_large', 'over 64 KiB'), 'unavailable'],
      [new EgressError('blocked', 'private ip'), 'egress_blocked'],
      [new EgressError('dns', 'ENOTFOUND'), 'unavailable'],
    ];

    for (const [err, expectedKind] of cases) {
      const req = createGuardedTaxLookupRequest({
        requestImpl: async () => {
          throw err;
        },
      });
      await expect(
        req(CASSO_TOKEN_URL, { method: 'POST', timeoutMs: 1000, maxBytes: 4096 }),
        err.code,
      ).rejects.toMatchObject({ name: 'TaxLookupUpstreamError', kind: expectedKind });
    }

    const provider = createGuardedCassoTaxLookupProvider({
      appId: 'app-id',
      appSecret: 'app-secret',
      requestImpl: async (url) => ({
        url,
        status: 302,
        contentType: null,
        headers: { location: 'https://evil.example/' },
        body: Buffer.alloc(0),
        truncated: false,
      }),
    });
    await expect(provider.lookup('0101234564')).rejects.toMatchObject({
      name: 'TaxLookupUpstreamError',
      kind: 'egress_blocked',
    });
  });
});

describe('TC1 Casso provider and household detection (#4988)', () => {
  it('exchanges OAuth token once, coalesces parallel calls, refreshes once on 401, and handles 404/429/timeout', async () => {
    let clock = 1_000_000;
    const calls: Array<{ url: string; method: string; auth?: string; timeoutMs: number }> = [];
    let tokenCounter = 0;
    let force401Once = false;
    let mode: 'ok' | '404' | '429' | 'bad_json' = 'ok';

    const provider = createCassoTaxLookupProvider({
      appId: 'casso-app',
      appSecret: 'casso-secret',
      now: () => clock,
      request: async (url, req) => {
        calls.push({
          url,
          method: req.method,
          ...(req.headers?.authorization !== undefined ? { auth: req.headers.authorization } : {}),
          timeoutMs: req.timeoutMs,
        });
        if (url === CASSO_TOKEN_URL) {
          tokenCounter += 1;
          expect(JSON.parse(req.body ?? '{}')).toEqual({ app_id: 'casso-app', app_secret: 'casso-secret' });
          return jsonResponse(url, 200, { access_token: `jwt-${tokenCounter}`, expires_in: 900 });
        }
        if (force401Once) {
          force401Once = false;
          return jsonResponse(url, 401, { error: 'expired' });
        }
        if (mode === '404') return jsonResponse(url, 404, { message: 'Not found' });
        if (mode === '429') return jsonResponse(url, 429, { message: 'Slow down' }, { 'retry-after': '45' });
        if (mode === 'bad_json') {
          return { url, status: 200, contentType: 'text/plain', headers: {}, body: Buffer.from('{bad', 'utf8'), truncated: false };
        }
        const taxCode = url.slice(CASSO_BUSINESS_URL_PREFIX.length);
        return jsonResponse(
          url,
          200,
          {
            requestId: 'req-1',
            business: {
              taxCode,
              name: 'Công ty TNHH Hoa Sen',
              address: '12 Lê Lợi, Quận 1, TP. Hồ Chí Minh',
              status: 'Đang hoạt động',
              source: 'casso',
            },
            quota: { used: 82, limit: 100 },
          },
          { 'x-ratelimit-used-percent': '82' },
        );
      },
    });

    // Refuses malformed codes and 12-digit citizen ID before issuing any token or lookup request.
    await expect(provider.lookup('12345')).rejects.toMatchObject({ code: 'INVALID_TAX_CODE', status: 422 });
    await expect(provider.lookup('001090123456')).rejects.toMatchObject({ code: 'CITIZEN_ID_NOT_ALLOWED', status: 422 });
    expect(calls).toHaveLength(0);

    // Parallel lookups share a single OAuth token exchange (single-flight).
    const [r1, r2] = await Promise.all([provider.lookup(' 0101.234.564 '), provider.lookup('0101234564002')]);
    expect(r1).toEqual({
      found: true,
      taxCode: '0101234564',
      name: 'Công ty TNHH Hoa Sen',
      address: '12 Lê Lợi, Quận 1, TP. Hồ Chí Minh',
      statusText: 'Đang hoạt động',
      source: 'casso',
      household: false,
      quotaUsedPercent: 82,
    });
    expect(r2).toMatchObject({ found: true, taxCode: '0101234564-002' });
    expect(calls.filter((c) => c.url === CASSO_TOKEN_URL)).toHaveLength(1);

    // Cached token is reused until expiry.
    clock += 60_000;
    await provider.lookup('0101234564');
    expect(calls.filter((c) => c.url === CASSO_TOKEN_URL)).toHaveLength(1);

    // 401 refreshes the token once within the same 5s deadline.
    force401Once = true;
    clock += 100;
    await provider.lookup('0101234564');
    expect(calls.filter((c) => c.url === CASSO_TOKEN_URL)).toHaveLength(2);
    expect(calls.at(-1)?.auth).toBe('Bearer jwt-2');

    // 404 -> found: false, 429 -> rate_limited with Retry-After, invalid JSON -> unavailable.
    mode = '404';
    expect(await provider.lookup('0309876546')).toEqual({
      found: false,
      taxCode: '0309876546',
      name: null,
      address: null,
      statusText: null,
      source: 'casso',
    });

    mode = '429';
    await expect(provider.lookup('0101234564')).rejects.toMatchObject({
      name: 'TaxLookupUpstreamError',
      kind: 'rate_limited',
      retryAfterSeconds: 45,
    });

    mode = 'bad_json';
    await expect(provider.lookup('0101234564')).rejects.toMatchObject({
      name: 'TaxLookupUpstreamError',
      kind: 'unavailable',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(provider.lookup('0101234564', controller.signal)).rejects.toMatchObject({
      name: 'TaxLookupUpstreamError',
      kind: 'timeout',
    });
  });

  it('detects household businesses without false positives on ordinary companies', () => {
    expect(isHouseholdTaxLookupResult({ name: 'Hộ kinh doanh Nguyễn Văn An' })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'HKD Cà Phê Phố Cổ' })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'Cửa hàng tạp hóa Lan', statusText: 'Hộ cá thể đang hoạt động' })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'Cơ sở May', household: true })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'Minh An Shop', businessType: 'household' })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'Nguyen Van An', businessType: 'individual' })).toBe(true);
    expect(isHouseholdTaxLookupResult({ name: 'An Sole Trade', businessType: 'sole_proprietorship' })).toBe(true);

    expect(isHouseholdTaxLookupResult({ name: 'Công ty TNHH Kinh Doanh Thương Mại Á Châu' })).toBe(false);
    expect(isHouseholdTaxLookupResult({ name: 'Công ty Cổ phần Dịch vụ Hộ chiếu Việt' })).toBe(false);
    expect(isHouseholdTaxLookupResult({ name: 'Household Goods Co., Ltd.', businessType: 'limited_liability' })).toBe(false);
  });

  it('strips C0 and C1 control characters and avoids 401 refresh wiping a newer token', async () => {
    let tokenSeq = 0;
    const delayGate: { resolve: (() => void) | null } = { resolve: null };
    const provider = createCassoTaxLookupProvider({
      appId: 'app-id',
      appSecret: 'app-secret',
      request: async (url, req) => {
        if (url === CASSO_TOKEN_URL) {
          tokenSeq += 1;
          if (tokenSeq === 2) {
            await new Promise<void>((resolve) => {
              delayGate.resolve = resolve;
            });
          }
          return jsonResponse(url, 200, { access_token: `tok-${tokenSeq}`, expires_in: 900 });
        }
        if (req.headers?.authorization === 'Bearer tok-1') {
          return jsonResponse(url, 401, { error: 'stale' });
        }
        return jsonResponse(url, 200, {
          business: {
            taxCode: '0101234564',
            name: 'Công\u0085 ty\u0007 TNHH\u009b Sạch',
            address: 'Số\u008d 1\u009f Phố Huế',
            status: 'Đang\u0085 hoạt động',
            type: 'company',
          },
        });
      },
    });

    const p1 = provider.lookup('0101234564');
    // Let p1 enter its 401 token refresh (paused at tokenSeq === 2), then start p2 which also hits 401 on tok-1.
    for (let i = 0; i < 10 && !delayGate.resolve; i += 1) {
      await Promise.resolve();
    }
    const p2 = provider.lookup('0101234564');
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    delayGate.resolve?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.name).toBe('Công ty TNHH Sạch');
    expect(r1.address).toBe('Số 1 Phố Huế');
    expect(r1.statusText).toBe('Đang hoạt động');
    expect(r2.name).toBe('Công ty TNHH Sạch');
    // p1 and p2 shared tok-2; if the second 401 wiped tok-2 unconditionally, tokenSeq would reach 3+.
    expect(tokenSeq).toBe(2);
  });
});

describe('TC1 rate limiter, backoff, off provider, and actor guard (#4988)', () => {
  it('enforces member burst, org hourly, org daily, 429 backoff, and one-shot 80% warning per org/day', () => {
    let nowMs = Date.UTC(2027, 3, 2, 2, 0, 0);
    const limiter = new TaxLookupLimiter({
      orgPerHour: 12,
      orgPerDay: 15,
      memberPerMinute: 3,
      backoffMs: 60_000,
      now: () => nowMs,
    });

    // Member burst limit of 3 does not burn org quota on rejected 4th call.
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.tryAcquire('org-a', 'user-1')).toMatchObject({ ok: true, orgDailyCount: i + 1 });
    }
    expect(limiter.tryAcquire('org-a', 'user-1')).toMatchObject({ ok: false, scope: 'member' });
    // Different member in same org sees orgDailyCount = 4 (denied call did not increment org quota).
    expect(limiter.tryAcquire('org-a', 'user-2')).toMatchObject({ ok: true, orgDailyCount: 4 });

    // 80% warning triggers once per org per VN day (12/15 = 80%).
    nowMs += 65_000;
    for (let i = 4; i < 12; i += 1) {
      expect(limiter.tryAcquire('org-a', `user-${i}`).ok).toBe(true);
    }
    expect(limiter.shouldEmitQuotaWarning('org-a')).toBe(true);
    expect(limiter.shouldEmitQuotaWarning('org-a')).toBe(false);
    expect(limiter.shouldEmitQuotaWarning('org-b')).toBe(true);

    // 13th call within 1 hour hits org_hour limit, while org-b has independent quota.
    expect(limiter.tryAcquire('org-a', 'user-99')).toMatchObject({ ok: false, scope: 'org_hour' });
    expect(limiter.tryAcquire('org-b', 'user-99')).toMatchObject({ ok: true, orgDailyCount: 1 });

    // Advance 61 minutes: hourly window clears, reaching orgPerDay = 15 then hitting org_day.
    nowMs += 61 * 60_000;
    for (let i = 12; i < 15; i += 1) {
      expect(limiter.tryAcquire('org-a', `user-next-${i}`).ok).toBe(true);
    }
    expect(limiter.tryAcquire('org-a', 'user-next-99')).toMatchObject({ ok: false, scope: 'org_day' });

    // Next UTC+7 day clears daily quota & warning latch.
    nowMs += 24 * 60 * 60_000;
    expect(limiter.tryAcquire('org-a', 'user-day2')).toMatchObject({ ok: true, orgDailyCount: 1 });
    expect(limiter.shouldEmitQuotaWarning('org-a')).toBe(true);

    // Deployment-wide 429 backoff stops every org until expired.
    limiter.triggerBackoff(30_000);
    expect(limiter.isBackedOff()).toMatchObject({ backedOff: true });
    expect(limiter.tryAcquire('org-b', 'user-1')).toMatchObject({ ok: false, scope: 'backoff' });
    nowMs += 31_000;
    expect(limiter.isBackedOff()).toEqual({ backedOff: false });
    expect(limiter.tryAcquire('org-b', 'user-1').ok).toBe(true);
  });

  it('refuses off provider lookups and non-user (agent/system) actors', async () => {
    await expect(offTaxLookupProvider.lookup('0101234564')).rejects.toThrow(DomainError);
    await expect(offTaxLookupProvider.lookup('0101234564')).rejects.toMatchObject({
      code: 'TAX_LOOKUP_DISABLED',
      status: 404,
    });

    const agentCtx = {
      actor: { type: 'agent', agentId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002' },
      orgId: '00000000-0000-4000-8000-000000000003',
    };
    await expect(
      partyTaxLookupPrepare.handler(agentCtx as unknown as QueryContext, { taxCode: '0101234564' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      partyTaxLookup.handler(agentCtx as unknown as CommandContext, {
        mode: 'hit',
        taxCode: '0101234564',
        provider: 'casso',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    const systemCtx = {
      actor: { type: 'system', component: 'worker' },
      orgId: '00000000-0000-4000-8000-000000000003',
    };
    await expect(
      partyTaxLookupPrepare.handler(systemCtx as unknown as QueryContext, { taxCode: '0101234564' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      partyTaxLookup.handler(systemCtx as unknown as CommandContext, {
        mode: 'hit',
        taxCode: '0101234564',
        provider: 'casso',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});
