// SPDX-License-Identifier: AGPL-3.0-only
// The sign-out revoke through the real client and the real wiring, against a stubbed network (no fake of the revoke itself).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeCurrentSession } from '../src/auth/revoke.ts';
import { accessToken, jwt } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

const USER_ID = '5d1c4a52-0b0e-4f55-8d3a-6f4e2f5d7a10';
const SESSION_ID = '9a0c2c9e-7b1d-4c55-9a53-1b9d0e8f4c21';
const token = jwt({ sub: 'supabase-subject', session_id: SESSION_ID, client_id: 'c' });

function stubNetwork() {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubGlobal('fetch', async (request: Request) => {
    const body = await request.clone().text();
    calls.push({ url: request.url, headers: request.headers, body });
    const result = request.url.endsWith('/me/get') ? { userId: USER_ID, email: 'a@b.c', displayName: null, orgs: [] } : { revoked: [SESSION_ID] };
    return new Response(JSON.stringify({ json: result, meta: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('revokeCurrentSession', () => {
  it('revokes this session with the kernel\'s user id from me.get, the token\'s session id and no org header', async () => {
    const calls = stubNetwork();
    await revokeCurrentSession('https://api.example.test', token);
    expect(calls.map((c) => c.url)).toEqual(['https://api.example.test/api/rpc/me/get', 'https://api.example.test/api/rpc/sessions/revoke']);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(call.headers.get('x-ludy-org')).toBeNull();
    }
    const sent = JSON.parse(calls[1]?.body ?? '{}') as { json?: Record<string, unknown> };
    expect(sent.json).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
    expect(calls[1]?.body).not.toContain('supabase-subject');
  });

  it('fails (for the caller to swallow) when the token names no session or the kernel refuses', async () => {
    stubNetwork();
    await expect(revokeCurrentSession('https://api.example.test', accessToken({ expSeconds: 1 }))).rejects.toThrow();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'FORBIDDEN', status: 403, message: 'no' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await expect(revokeCurrentSession('https://api.example.test', token)).rejects.toBeTruthy();
  });
});
