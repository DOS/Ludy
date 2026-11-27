// SPDX-License-Identifier: AGPL-3.0-only
// Fixed-host GitHub API & OAuth token-exchange transport routed strictly through @ludy/kernel-runtime's SSRF egress guard (#5158, ADR-0060).
import { GITHUB_HOSTS, GITHUB_OAUTH_TOKEN_URL, GithubError, type GithubTransport, type GithubTransportRequest, type GithubTransportResponse } from '@ludy/github';
import { EgressError, guardedRequest } from '@ludy/kernel-runtime';

const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_MAX_BYTES = 512 * 1024;
const OAUTH_TOKEN_URL = new URL(GITHUB_OAUTH_TOKEN_URL);

export interface GithubTransportOptions {
  readonly request?: typeof guardedRequest | undefined;
}

export function githubTransport(options: GithubTransportOptions = {}): GithubTransport {
  const request = options.request ?? guardedRequest;
  return async (call: GithubTransportRequest): Promise<GithubTransportResponse> => {
    let url: URL;
    try {
      url = new URL(call.url);
    } catch {
      throw new GithubError('bad_request', 'Invalid GitHub API URL');
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
      throw new GithubError('bad_request', 'Blocked non-standard GitHub URL');
    }

    const isApiCall = (GITHUB_HOSTS as readonly string[]).includes(url.hostname);
    const isOAuthExchange =
      url.hostname === OAUTH_TOKEN_URL.hostname &&
      url.pathname === OAUTH_TOKEN_URL.pathname &&
      url.search === '' &&
      url.hash === '' &&
      call.method === 'POST';

    if (!isApiCall && !isOAuthExchange) {
      throw new GithubError('bad_request', 'Blocked non-GitHub API host');
    }

    const allowedHost = url.hostname;
    const accept = isOAuthExchange ? 'application/json' : 'application/vnd.github+json';

    try {
      const answer = await request(
        url.toString(),
        {
          method: call.method,
          headers: call.headers,
          ...(call.body !== undefined ? { body: Buffer.from(call.body, 'utf8') } : {}),
        },
        {
          httpsOnly: true,
          maxRedirects: 0,
          hostAllowed: (host) => host.toLowerCase() === allowedHost,
          timeoutMs: GITHUB_TIMEOUT_MS,
          maxBytes: GITHUB_MAX_BYTES,
          overLimit: 'fail',
          accept,
        },
      );
      return {
        status: answer.status,
        headers: {
          ...answer.headers,
          ...(answer.contentType ? { 'content-type': answer.contentType } : {}),
        },
        body: answer.body.toString('utf8'),
      };
    } catch (error) {
      if (error instanceof GithubError) throw error;
      if (error instanceof EgressError) {
        if (error.code === 'timeout') throw new GithubError('unreachable', 'Timed out reaching GitHub');
        if (error.code === 'too_large') throw new GithubError('invalid_response', 'GitHub API response exceeded 512 KiB');
        throw new GithubError('unreachable', 'Egress guard refused GitHub API request');
      }
      throw new GithubError('unreachable', 'Failed to reach GitHub');
    }
  };
}
