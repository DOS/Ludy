// SPDX-License-Identifier: AGPL-3.0-only
// The narrowed view of the writer the revoke worker is given (ADR-0043 point 4, #2296, W2-1): one method, `revokeToken`, and a source that names no
// other call of a writer. The worker opens a sealed copy of a closed connection's token for that call alone.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdWriter, adRevokers, revokerOf, sandboxAdWriter, sandboxWriteLogin, type AdWriter } from '../src/index.ts';

const SANDBOX_SECRET = sandboxWriteLogin({ externalAccountId: 'sbxads-0123456789abcdef', currency: 'VND' }).secret;

describe('the revoke view of a writer', () => {
  it('has the one method, and none of the writer is reachable through it', () => {
    const view = revokerOf(sandboxAdWriter);
    expect(Object.getOwnPropertyNames(view)).toEqual(['revokeToken']);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    // Frozen: nothing can be added to it or replaced on it, and the map of a deployment is frozen too.
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(adRevokers({ sandbox: true }))).toBe(true);
    expect(() => {
      (view as unknown as Record<string, unknown>).verify = () => undefined;
    }).toThrow();
    // Not even by name: the writer's other methods are not on the view.
    for (const name of ['verify', 'provider', 'createCampaign', 'createAdSet', 'createCreative', 'createAd', 'setStatus', 'readObjects', 'findByTag', 'resolveTargeting']) {
      expect(name in view).toBe(false);
    }
  });

  it('calls the writer revokeToken with the secret and gives its answer back', async () => {
    const writer: Pick<AdWriter, 'revokeToken'> = { revokeToken: vi.fn(async () => ({ how: 'revoked' as const })) };
    await expect(revokerOf(writer).revokeToken('the-secret')).resolves.toEqual({ how: 'revoked' });
    expect(writer.revokeToken).toHaveBeenCalledTimes(1);
    expect(writer.revokeToken).toHaveBeenCalledWith('the-secret');
  });

  it('names no member of a writer but revokeToken in its source', () => {
    const source = readFileSync(new URL('../src/revokers.ts', import.meta.url), 'utf8');
    // A call or a read of a member of a writer in code (a comment may name them: those lines are dropped first).
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('import '))
      .join('\n');
    const members = [...code.matchAll(/\bwriter\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
    expect(members).toEqual(['revokeToken']);
    // And it reaches no network by itself: it builds the writers it is given secrets for, nothing more.
    expect(code).not.toMatch(/\bfetch\b|\bhttps?:\/\//);
  });
});

describe('the revokers of a deployment', () => {
  it('has the sandbox one only when the sandbox is on, and it removes nothing at a platform', async () => {
    expect(adRevokers({ sandbox: false })).toEqual({});
    const revokers = adRevokers({ sandbox: true });
    expect(Object.keys(revokers)).toEqual(['sandboxwrite_ads']);
    await expect(revokers.sandboxwrite_ads?.revokeToken(SANDBOX_SECRET)).resolves.toEqual({ how: 'sandbox' });
    // A secret that is not the sandbox's is refused, as everywhere.
    await expect(revokers.sandboxwrite_ads?.revokeToken('{}')).rejects.toBeInstanceOf(AdPlatformError);
  });

  it('has one Meta revoker per app: the write app for a write token, the read ads app for a read token that holds a spend permission', () => {
    expect(Object.keys(adRevokers({ sandbox: false, meta: { writeAppSecret: 'w'.repeat(32) } }))).toEqual(['metawrite_ads']);
    expect(Object.keys(adRevokers({ sandbox: false, meta: { readAppSecret: 'r'.repeat(32) } }))).toEqual(['meta_ads']);
    expect(Object.keys(adRevokers({ sandbox: true, meta: { writeAppSecret: 'w'.repeat(32), readAppSecret: 'r'.repeat(32) } })).sort()).toEqual(['meta_ads', 'metawrite_ads', 'sandboxwrite_ads']);
    // Nothing for a deployment with neither app.
    expect(adRevokers({ sandbox: false, meta: {} })).toEqual({});
  });

  it('proves each Meta token with the secret of its own app', async () => {
    const seen: Array<{ secretProofFor: string; url: string; method: string }> = [];
    const fetcher: Fetch = async (input, init) => {
      seen.push({ secretProofFor: new URL(input).searchParams.get('appsecret_proof') ?? '', url: input, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const secret = JSON.stringify({ accessToken: 'EAAB-token' });
    const write = revokerOf(new MetaAdWriter({ appSecret: 'write-app-secret', fetch: fetcher }));
    const read = revokerOf(new MetaAdWriter({ appSecret: 'read-app-secret', fetch: fetcher }));
    await expect(write.revokeToken(secret)).resolves.toEqual({ how: 'revoked' });
    await expect(read.revokeToken(secret)).resolves.toEqual({ how: 'revoked' });
    expect(seen).toHaveLength(2);
    // The same token, two apps: two different proofs, each the app's own.
    expect(seen[0]?.secretProofFor).not.toBe('');
    expect(seen[0]?.secretProofFor).not.toBe(seen[1]?.secretProofFor);
    expect(seen.every((call) => call.method === 'DELETE' && new URL(call.url).pathname.endsWith('/me/permissions'))).toBe(true);
  });
});
