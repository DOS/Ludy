// SPDX-License-Identifier: AGPL-3.0-only
// The client step that claims the audio a worker copied from a meeting platform (C1, #3173): a JSON request to the media route with the recording's id and no bytes.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/auth.ts', () => ({
  accessToken: async () => 'token-1',
  auth: () => ({}),
  getConfig: () => ({ uploads: 'local', modules: ['meetings'] }),
  afterMfaRefusal: async () => undefined,
  secondFactorStillOwed: async () => false,
}));

// The module builds its API link from the page's origin when it loads.
vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
const { claimImportedMedia, setCurrentOrg } = await import('../src/lib/api.ts');

afterEach(() => {
  vi.stubGlobal('fetch', undefined);
  setCurrentOrg(null);
});

describe('claimImportedMedia', () => {
  it('posts the recording id as importId with kind audio, the session and the org headers, and no file', async () => {
    setCurrentOrg('acme');
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ fileId: 'f1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchFn);
    await expect(claimImportedMedia('m 1', 'r1')).resolves.toEqual({ fileId: 'f1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('/api/meetings/m%201/media');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ importId: 'r1', kind: 'audio' });
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-1');
    expect(headers['x-ludy-org']).toBe('acme');
    expect(headers['content-type']).toBe('application/json');
  });

  it('throws the kernel error of a refusal, with its code and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'MEETING_PLATFORM_STATE', message: 'Not staged' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    await expect(claimImportedMedia('m1', 'r1')).rejects.toMatchObject({ code: 'MEETING_PLATFORM_STATE', status: 409 });
  });

  it('waits and tries again while the server is busy, then gives the answer', async () => {
    vi.useFakeTimers();
    try {
      const answers = [
        new Response(JSON.stringify({ code: 'UPLOAD_BUSY', message: 'busy' }), { status: 429, headers: { 'content-type': 'application/json' } }),
        new Response(JSON.stringify({ fileId: 'f2' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ];
      const fetchFn = vi.fn(async () => answers.shift()!);
      vi.stubGlobal('fetch', fetchFn);
      const pending = claimImportedMedia('m1', 'r1');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ fileId: 'f2' });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
