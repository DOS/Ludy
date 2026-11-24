// SPDX-License-Identifier: AGPL-3.0-only
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CALLBACK_PATH, startLoopback, type LoopbackListener } from '../src/loopback.ts';

const CODE = `crc_${'a'.repeat(43)}`;
let listener: LoopbackListener | null = null;
afterEach(() => listener?.close());

// A raw request, so the Host header can be chosen.
function get(uri: string, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<number> {
  const url = new URL(uri);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopback', () => {
  it('listens on 127.0.0.1 only and answers the right state once with the code and org', async () => {
    listener = await startLoopback({ state: 'state-1' });
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ludy-desktop\/callback$/);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=state-1`)).toBe(200);
    expect(await listener.result).toEqual({ code: CODE, org: 'acme' });
    // Single use: the listener is gone.
    await expect(get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=state-1`)).rejects.toThrow();
  });

  it('refuses a wrong state, a wrong path, a wrong method and a rebound Host without ending the wait', async () => {
    listener = await startLoopback({ state: 'state-2' });
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=other`)).toBe(400);
    expect(await get(listener.redirectUri, `/other?code=${CODE}&org=acme&state=state-2`)).toBe(404);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=state-2`, {}, 'POST')).toBe(404);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=state-2`, { host: 'evil.example:80' })).toBe(400);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=bad&org=acme&state=state-2`)).toBe(400);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=a%20b&state=state-2`)).toBe(400);
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?code=${CODE}&org=acme&state=state-2`)).toBe(200);
    expect(await listener.result).toEqual({ code: CODE, org: 'acme' });
  });

  it('reports a refusal from the sign-in page', async () => {
    listener = await startLoopback({ state: 'state-3' });
    expect(await get(listener.redirectUri, `${CALLBACK_PATH}?error=access_denied&state=state-3`)).toBe(200);
    expect(await listener.result).toEqual({ error: 'access_denied' });
  });

  it('gives up after the timeout and closes when cancelled', async () => {
    let fire: () => void = () => {};
    listener = await startLoopback({ state: 's', setTimer: (cb) => { fire = cb; return 1; }, clearTimer: () => undefined });
    fire();
    expect(await listener.result).toEqual({ error: 'timeout' });
    const other = await startLoopback({ state: 's' });
    other.close();
    expect(await other.result).toEqual({ error: 'closed' });
  });
});
