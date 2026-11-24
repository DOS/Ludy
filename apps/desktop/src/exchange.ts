// SPDX-License-Identifier: AGPL-3.0-only
// Trades the one-time code and the PKCE verifier for the desktop token (POST /api/extension/token with `client: "desktop"`). The request
// carries no Origin header (a desktop client has none; the browser extension's is what binds its code to its id), and the code is bound
// on the server to the desktop client, so an extension code cannot be exchanged here and the reverse. Redirects are never followed.
export type FetchLike = typeof fetch;

export interface DesktopToken {
  token: string;
  tokenId: string;
  orgId: string;
  scopes: string[];
  expiresAt: string;
}

export type ExchangeFailure = 'invalid_code' | 'rate_limited' | 'unreachable' | 'unexpected';

export class ExchangeError extends Error {
  readonly failure: ExchangeFailure;
  constructor(failure: ExchangeFailure) {
    super(`token exchange failed: ${failure}`);
    this.name = 'ExchangeError';
    this.failure = failure;
  }
}

const TOKEN_FORMAT = /^crx_[A-Za-z0-9_-]{43}$/;
const REQUEST_TIMEOUT_MS = 15_000;

export async function exchangeCode(fetchImpl: FetchLike, ludyUrl: string, code: string, codeVerifier: string): Promise<DesktopToken> {
  let response: Response;
  try {
    response = await fetchImpl(`${ludyUrl}/api/extension/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, codeVerifier, client: 'desktop' }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ExchangeError('unreachable');
  }
  if (response.status === 429) throw new ExchangeError('rate_limited');
  if (response.status === 400) throw new ExchangeError('invalid_code');
  if (response.status !== 200) throw new ExchangeError(response.status >= 500 ? 'unreachable' : 'unexpected');
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.token;
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token) || typeof body?.tokenId !== 'string' || typeof body.orgId !== 'string' || typeof body.expiresAt !== 'string') {
    throw new ExchangeError('unexpected');
  }
  const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
  return { token, tokenId: body.tokenId, orgId: body.orgId, scopes, expiresAt: body.expiresAt };
}
