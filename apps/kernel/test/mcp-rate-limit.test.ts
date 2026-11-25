// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for fail-closed MCP and OAuth rate-limiter error handling (#3978).

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Runtime } from '@ludy/kernel-runtime';
import type { Config } from '../src/config.ts';
import { createDbMcpRateLimiter, mountMcp, mountOauthProvider, type McpRateBucket, type McpRateLimiter } from '../src/mcp-endpoint.ts';
import type { OauthServer } from '../src/oauth-server.ts';

function stubOauth(calls: { callback: number }): OauthServer {
  return {
    issuer: 'https://api.example.test',
    resource: 'https://api.example.test/mcp',
    provider: {
      callback: () => () => {
        calls.callback += 1;
      },
      interactionDetails: async () => null,
      interactionResult: async () => '',
      Client: { find: async () => null },
    },
    verifyAccessToken: async () => ({
      grantId: '11111111-1111-4111-8111-111111111111',
      clientId: 'client-1',
      orgId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      scopes: ['ludy.read'],
    }),
  } as unknown as OauthServer;
}

const compiler = new PostgresQueryCompiler();

function stubRuntime(auditCalls: string[]): Runtime {
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown, queryId: unknown) => compiler.compileQuery(node as never, queryId as never),
    executeQuery: async (compiled: { sql: string }) => {
      if (compiled.sql.includes('mcp_grant_verify')) {
        return { rows: [{ org_id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333', scopes: ['ludy.read'], client_name: 'Mock' }] };
      }
      if (compiled.sql.includes('mcp_grant_kind')) {
        return { rows: [{ kind: 'company' }] };
      }
      if (compiled.sql.includes('mcp_call_audit')) {
        auditCalls.push(compiled.sql);
        return { rows: [] };
      }
      return { rows: [] };
    },
    withPlugins: () => executor,
    withPlugin: () => executor,
    withoutPlugins: () => executor,
  };
  const fakeDb = { getExecutor: () => executor };
  return {
    orgless: async (fn: (db: unknown) => Promise<unknown>) => fn(fakeDb),
    effectiveModules: async () => ['core'],
  } as unknown as Runtime;
}

const minimalConfig = {
  PUBLIC_URL: 'https://api.example.test',
  MCP_ALLOWED_ORIGINS: 'https://allowed.example.test',
  AUTH_ALLOWED_EMAILS: [],
  MCP_GRANT_PER_MINUTE: 60,
  MCP_GRANT_CONCURRENCY: 4,
  MCP_GRANT_DAILY_ROWS: 2000,
  MCP_GRANT_WRITES_PER_MINUTE: 10,
} as unknown as Config;

describe('MCP and OAuth rate limit fail-closed unit behavior (#3978)', () => {
  it('createDbMcpRateLimiter hashes keys with SHA-256 and fails when DB returns no row', async () => {
    const seen: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    let nextRows: unknown[] = [{ allowed: false, retry_after_seconds: 17 }];
    const executor = {
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown, queryId: unknown) => compiler.compileQuery(node as never, queryId as never),
      executeQuery: async (compiled: { sql: string; parameters: readonly unknown[] }) => {
        seen.push({ sql: compiled.sql, parameters: compiled.parameters });
        return { rows: nextRows };
      },
      withPlugins: () => executor,
      withPlugin: () => executor,
      withoutPlugins: () => executor,
    };
    const limiter = createDbMcpRateLimiter({ orgless: async (fn) => fn({ getExecutor: () => executor } as never) });
    const rawKey = '203.0.113.42';
    const decision = await limiter.take('oauth_addr', rawKey, 300, 60);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 17 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain('mcp_rate_limit_take');
    expect(seen[0]!.parameters).toEqual(['oauth_addr', createHash('sha256').update(rawKey, 'utf8').digest('hex'), 300, 60]);
    expect(seen[0]!.parameters).not.toContain(rawKey);

    nextRows = [];
    await expect(limiter.take('oauth_addr', rawKey, 300, 60)).rejects.toThrow('MCP_RATE_LIMIT_EMPTY_RESULT');
  });

  it('fails closed with 503 when /oauth/* limiters error without calling provider', async () => {
    const cases: McpRateBucket[] = ['oauth_addr', 'oauth_register_addr', 'oauth_register_global'];
    for (const failingBucket of cases) {
      const app = new Hono();
      const calls = { callback: 0 };
      const rateLimit: McpRateLimiter = {
        take: async (bucket) => {
          if (bucket === failingBucket) throw new Error('db unavailable');
          return { allowed: true, retryAfterSeconds: 0 };
        },
      };
      mountOauthProvider(app, {
        oauth: stubOauth(calls),
        runtime: stubRuntime([]),
        clientKey: () => '203.0.113.1',
        registerPerMinute: 10,
        registerGlobalPerMinute: 120,
        allowedOrigins: ['https://allowed.example.test'],
        rateLimit,
      });

      const res = await app.request('https://api.example.test/oauth/register', {
        method: 'POST',
        headers: { origin: 'https://allowed.example.test', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, failingBucket).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://allowed.example.test');
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, try again later' });
      expect(calls.callback).toBe(0);
    }
  });

  it('fails closed with 503 when /oauth/pairing/redeem limiter errors', async () => {
    const app = new Hono();
    const rateLimit: McpRateLimiter = {
      take: async (bucket) => {
        if (bucket === 'oauth_pairing_addr') throw new Error('db unavailable');
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
    mountOauthProvider(app, {
      oauth: stubOauth({ callback: 0 }),
      runtime: stubRuntime([]),
      clientKey: () => '203.0.113.1',
      registerPerMinute: 10,
      registerGlobalPerMinute: 120,
      allowedOrigins: [],
      rateLimit,
    });

    const res = await app.request('https://api.example.test/oauth/pairing/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD-EFGH-JKLM' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, try again later' });
  });

  it('fails closed with 503 when mcp_addr or mcp_grant limiter errors', async () => {
    for (const failingBucket of ['mcp_addr', 'mcp_grant'] as const) {
      const app = new Hono();
      const auditCalls: string[] = [];
      const rateLimit: McpRateLimiter = {
        take: async (bucket) => {
          if (bucket === failingBucket) throw new Error('db unavailable');
          return { allowed: true, retryAfterSeconds: 0 };
        },
      };
      mountMcp(app, {
        config: minimalConfig,
        runtime: stubRuntime(auditCalls),
        oauth: stubOauth({ callback: 0 }),
        authenticate: async () => {
          throw new Error('unused');
        },
        clientKey: () => '203.0.113.1',
        serverVersion: 'test',
        rateLimit,
      });

      const res = await app.request('https://api.example.test/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, failingBucket).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, try again later' });
      expect(auditCalls).toEqual([]);
    }
  });

  it('returns 429 and skips refusal audit if mcp_refusal_audit errors after mcp_grant refuses', async () => {
    const app = new Hono();
    const auditCalls: string[] = [];
    const rateLimit: McpRateLimiter = {
      take: async (bucket) => {
        if (bucket === 'mcp_grant') return { allowed: false, retryAfterSeconds: 12 };
        if (bucket === 'mcp_refusal_audit') throw new Error('db unavailable');
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
    mountMcp(app, {
      config: minimalConfig,
      runtime: stubRuntime(auditCalls),
      oauth: stubOauth({ callback: 0 }),
      authenticate: async () => {
        throw new Error('unused');
      },
      clientKey: () => '203.0.113.1',
      serverVersion: 'test',
      rateLimit,
    });

    const res = await app.request('https://api.example.test/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(auditCalls).toEqual([]);
  });
});
