// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for GitHub transport host/URL/method lock, egress hostAllowed & accept guards, and header forwarding (#5158 B1 + N4).
import { EgressError, type guardedRequest } from '@ludy/kernel-runtime';
import { describe, expect, it } from 'vitest';
import { githubTransport } from '../src/github-transport.ts';

type ReqCall = { url: string; options: Parameters<typeof guardedRequest>[2] };

describe('githubTransport', () => {
  it('routes https://api.github.com through guardedRequest with hostAllowed, zero redirects, and forwards rate-limit headers', async () => {
    const seen: ReqCall[] = [];
    const transport = githubTransport({
      request: async (url, _req, options) => {
        seen.push({ url, options });
        return {
          url,
          status: 403,
          contentType: 'application/json',
          headers: {
            'retry-after': '120',
            'x-ratelimit-remaining': '0',
          },
          body: Buffer.from('{"message":"API rate limit exceeded"}'),
          truncated: false,
        };
      },
    });

    const res = await transport({
      method: 'GET',
      url: 'https://api.github.com/user/installations?per_page=100',
      headers: { accept: 'application/vnd.github+json' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.httpsOnly).toBe(true);
    expect(seen[0]!.options.maxRedirects).toBe(0);
    expect(seen[0]!.options.accept).toBe('application/vnd.github+json');
    expect(seen[0]!.options.hostAllowed?.('api.github.com')).toBe(true);
    expect(seen[0]!.options.hostAllowed?.('github.com')).toBe(false);
    expect(seen[0]!.options.hostAllowed?.('evil.example')).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers).toMatchObject({
      'content-type': 'application/json',
      'retry-after': '120',
      'x-ratelimit-remaining': '0',
    });
  });

  it('allows POST https://github.com/login/oauth/access_token with application/json accept and rejects all other URLs', async () => {
    const seen: ReqCall[] = [];
    const transport = githubTransport({
      request: async (url, _req, options) => {
        seen.push({ url, options });
        return {
          url,
          status: 200,
          contentType: 'application/json',
          body: Buffer.from('{"access_token":"ghu_test"}'),
          truncated: false,
        };
      },
    });

    await transport({
      method: 'POST',
      url: 'https://github.com/login/oauth/access_token',
      headers: { accept: 'application/json' },
      body: 'code=abc',
    });
    expect(seen[0]!.options.accept).toBe('application/json');
    expect(seen[0]!.options.hostAllowed?.('github.com')).toBe(true);
    expect(seen[0]!.options.hostAllowed?.('api.github.com')).toBe(false);

    for (const bad of [
      { method: 'GET' as const, url: 'https://github.com/login/oauth/access_token' },
      { method: 'POST' as const, url: 'https://github.com/login/oauth/access_token?foo=1' },
      { method: 'POST' as const, url: 'https://github.com/other/path' },
      { method: 'GET' as const, url: 'http://api.github.com/user' },
      { method: 'GET' as const, url: 'https://api.github.com:8443/user' },
      { method: 'GET' as const, url: 'https://user:pass@api.github.com/user' },
      { method: 'GET' as const, url: 'https://127.0.0.1/user' },
    ]) {
      await expect(
        transport({ method: bad.method, url: bad.url, headers: {} }),
        `${bad.method} ${bad.url}`,
      ).rejects.toMatchObject({ name: 'GithubError', kind: 'bad_request' });
    }
    expect(seen).toHaveLength(1);
  });

  it('maps egress timeout and size limits into GithubError kinds', async () => {
    const timeoutTransport = githubTransport({
      request: async () => {
        throw new EgressError('timeout', 'timed out');
      },
    });
    await expect(
      timeoutTransport({ method: 'GET', url: 'https://api.github.com/user', headers: {} }),
    ).rejects.toMatchObject({ name: 'GithubError', kind: 'unreachable' });

    const bigTransport = githubTransport({
      request: async () => {
        throw new EgressError('too_large', 'too large');
      },
    });
    await expect(
      bigTransport({ method: 'GET', url: 'https://api.github.com/user', headers: {} }),
    ).rejects.toMatchObject({ name: 'GithubError', kind: 'invalid_response' });
  });

  it('forwards PATCH to api.github.com with strict egress options and blocks PATCH to non-api hosts', async () => {
    const seen: Array<{ url: string; method: string; body?: Buffer | undefined; options: Parameters<typeof guardedRequest>[2] }> = [];
    const transport = githubTransport({
      request: async (url, req, options) => {
        seen.push({ url, method: req.method, body: req.body, options });
        return {
          url,
          status: 200,
          contentType: 'application/json',
          body: Buffer.from('{"number":42,"state":"closed"}'),
          truncated: false,
        };
      },
    });

    const res = await transport({
      method: 'PATCH',
      url: 'https://api.github.com/repos/acme/web/issues/42',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ghs_test',
        'content-type': 'application/json',
      },
      body: '{"state":"closed"}',
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/web/issues/42',
      method: 'PATCH',
    });
    expect(seen[0]!.body?.toString('utf8')).toBe('{"state":"closed"}');
    expect(seen[0]!.options.httpsOnly).toBe(true);
    expect(seen[0]!.options.maxRedirects).toBe(0);
    expect(seen[0]!.options.maxBytes).toBe(512 * 1024);
    expect(seen[0]!.options.timeoutMs).toBe(10_000);
    expect(seen[0]!.options.hostAllowed?.('api.github.com')).toBe(true);
    expect(seen[0]!.options.hostAllowed?.('github.com')).toBe(false);

    for (const badUrl of [
      'https://github.com/login/oauth/access_token',
      'https://evil.example/repos/acme/web/issues/42',
      'http://api.github.com/repos/acme/web/issues/42',
    ]) {
      await expect(
        transport({ method: 'PATCH', url: badUrl, headers: {}, body: '{"state":"closed"}' }),
        badUrl,
      ).rejects.toMatchObject({ name: 'GithubError', kind: 'bad_request' });
    }
    expect(seen).toHaveLength(1);
  });
});
