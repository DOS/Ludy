// SPDX-License-Identifier: AGPL-3.0-only
// How TikTok Shop signs an Open API request (#2524, T1 = #4256), from the OFFICIAL page "Sign your API request" (partner.tiktokshop.com/docv2/page/sign-your-api-request, read 2026-11-21): HMAC-SHA256 with
// the app secret as the key, over `secret + path + the sorted key+value of every query parameter except sign and access_token + the body + secret`, as lower-case hex. The body is part of the string unless
// the request is multipart/form-data (then none). From API version 202309 the access token travels in the `x-tts-access-token` header and is not signed; `access_token` is excluded here for the legacy
// APIs that still send it in the query. The timestamp is a 10-digit count of SECONDS and is one of the signed query parameters.
//
// A pure function: no clock, no secret kept, nothing logged. The fake server of the tests checks it against its own implementation of the same rule.
import { createHmac } from 'node:crypto';

// `body` is the exact text that is sent (a JSON request body), or null for a request without one or a multipart one: nothing is appended then. The keys sort by code unit, which is byte order for the
// ASCII names the API uses (the official Go sample sorts the strings the same way).
export function signTiktokRequest(appSecret: string, path: string, query: Readonly<Record<string, string>>, body: string | null): string {
  const keys = Object.keys(query)
    .filter((key) => key !== 'sign' && key !== 'access_token')
    .sort();
  const input = `${appSecret}${path}${keys.map((key) => `${key}${query[key]}`).join('')}${body ?? ''}${appSecret}`;
  return createHmac('sha256', appSecret).update(input, 'utf8').digest('hex');
}
