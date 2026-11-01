// SPDX-License-Identifier: AGPL-3.0-only
// The app and the API ship together (#2261): the app asks for a reload only on a clear build mismatch.
import { describe, expect, it } from 'vitest';
import { fetchServerBuild, isStaleBuild } from '../src/lib/build-version.ts';

const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';

describe('isStaleBuild', () => {
  it('is true only when both sides name a build and they differ', () => {
    expect(isStaleBuild(SHA_A, SHA_B)).toBe(true);
    expect(isStaleBuild(SHA_A, SHA_A)).toBe(false);
  });

  it('never asks for a reload from a bundle with no build (the kernel serves it), or an API with none or a local one', () => {
    expect(isStaleBuild('', SHA_B)).toBe(false);
    expect(isStaleBuild(SHA_A, 'dev')).toBe(false);
    expect(isStaleBuild(SHA_A, '')).toBe(false);
    expect(isStaleBuild(SHA_A, null)).toBe(false);
    expect(isStaleBuild(SHA_A, undefined)).toBe(false);
    expect(isStaleBuild(SHA_A, 42)).toBe(false);
  });
});

describe('fetchServerBuild', () => {
  const answer = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });

  it('reads the build from /version, also from a 503 that names it', async () => {
    expect(await fetchServerBuild(answer({ build: SHA_A, migrationsMissing: [] }))).toBe(SHA_A);
    expect(await fetchServerBuild(answer({ build: SHA_A, migrationsMissing: null }, 503))).toBe(SHA_A);
  });

  it('is null when the answer has no build, is not JSON, or the request fails', async () => {
    expect(await fetchServerBuild(answer({}))).toBeNull();
    expect(await fetchServerBuild(async () => new Response('<html>', { status: 502 }))).toBeNull();
    expect(await fetchServerBuild(async () => Promise.reject(new TypeError('fetch failed')))).toBeNull();
  });

  it('asks without cookies and never from the cache', async () => {
    let seen: RequestInit | undefined;
    await fetchServerBuild(async (_input, init) => {
      seen = init;
      return Response.json({ build: SHA_A });
    });
    expect(seen).toMatchObject({ cache: 'no-store', credentials: 'omit' });
  });
});
