// SPDX-License-Identifier: AGPL-3.0-only
// A made-up Lazada token endpoint for the refresher's tests (#2524, S3a = #4240): an in-process `fetch` that answers `POST /rest/auth/token/refresh` on api.lazada.com in the shape of the
// documentation mirrored on open.alitrip.com (article 108260: the answer holds access_token, refresh_token, expires_in, refresh_expires_in and the seller's country and account at the top
// level). It verifies the signature with its OWN implementation of the algorithm (article 108068), so a signer that drifts fails here, and it rotates like Lazada does: a refresh token works
// once, the answer carries a new access token and a new refresh token, and the refresh life is NOT reset (the answer's refresh_expires_in counts down to one fixed date). No network.
import { createHmac } from 'node:crypto';

export interface FakeTokenCall {
  method: string;
  host: string;
  path: string;
  // The system parameters, from the address.
  query: Record<string, string>;
  // The API's own parameters, from the form body.
  form: Record<string, string>;
  url: string;
}

export interface FakeTokenOptions {
  appKey: string;
  appSecret: string;
  // The refresh token that works now; it is spent by a refresh.
  refreshToken: string;
  // The one date the refresh life ends at, in ms (a refresh does not move it).
  refreshExpiresAtMs: number;
  now?: () => number;
  // Crafts an answer instead of the fake's own (a refusal, a throttle, a hostile or malformed body); returns undefined to let the fake answer.
  intercept?: (call: FakeTokenCall) => Response | undefined;
}

// Independent of the adapter: the rule of the official sample, written once more.
function expectedSign(secret: string, path: string, params: Record<string, string>): string {
  const keys = Object.keys(params).filter((k) => k !== 'sign').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHmac('sha256', secret)
    .update(path + keys.map((k) => `${k}${params[k]}`).join(''), 'utf8')
    .digest('hex')
    .toUpperCase();
}

export function fakeLazadaToken(options: FakeTokenOptions) {
  const calls: FakeTokenCall[] = [];
  const now = options.now ?? (() => Date.now());
  let valid = options.refreshToken;
  let issued = 0;
  const reply = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
  const refused = (code: string, message: string) => reply({ code, type: 'ISV', message, request_id: '0b00000000000000000000000' });

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const query = Object.fromEntries(url.searchParams.entries());
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '').entries());
    const path = url.pathname.replace(/^\/rest/, '');
    const call: FakeTokenCall = { method: init?.method ?? 'GET', host: url.host, path, query, form, url: input };
    calls.push(call);
    if (url.protocol !== 'https:' || url.host !== 'api.lazada.com' || !url.pathname.startsWith('/rest/')) throw new Error(`the fake Lazada does not serve ${url.host}`);
    const hostile = options.intercept?.(call);
    if (hostile) return hostile;
    if (call.method !== 'POST' || path !== '/auth/token/refresh') return refused('ApiNotFound', path);
    if (query.access_token !== undefined || form.access_token !== undefined) return refused('InvalidParameter', 'access_token is not for this call');
    if (query.sign !== expectedSign(options.appSecret, path, { ...query, ...form }) || query.app_key !== options.appKey || query.sign_method !== 'sha256') {
      return refused('IncompleteSignature', 'The request signature does not conform to Lazada standards');
    }
    if (!/^\d{13}$/.test(query.timestamp ?? '')) return refused('MissingParameter', 'timestamp');
    if (form.refresh_token !== valid || now() >= options.refreshExpiresAtMs) return refused('IllegalRefreshToken', 'The specified refresh token is invalid or expired');
    issued += 1;
    valid = `refresh-token-${issued}`;
    return reply({
      access_token: `access-token-${issued}`,
      refresh_token: valid,
      expires_in: 2_592_000,
      refresh_expires_in: Math.max(0, Math.floor((options.refreshExpiresAtMs - now()) / 1000)),
      country: 'vn',
      account: 'seller@example.test',
      code: '0',
      request_id: '0b00000000000000000000000',
    });
  };

  return { fetch: fetchImpl, calls, currentRefreshToken: () => valid };
}
